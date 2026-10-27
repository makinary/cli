const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { proxy, ready, releasePaths, healthPath } = require('../scripts/workspace-runtime.cjs');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
const get = port => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}`, res => {
    let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

test('stable public port switches new requests and drains in-flight old responses', async () => {
  let finishOld;
  let started;
  const observed = new Promise(resolve => { started = resolve; });
  const old = http.createServer((req, res) => { finishOld = () => res.end('old'); started(); });
  const fresh = http.createServer((req, res) => res.end('new'));
  await listen(old); await listen(fresh);
  const oldTarget = { port: old.address().port, connections: 0 };
  let target = oldTarget;
  const gateway = proxy(() => target);
  await listen(gateway);
  try {
    const pending = get(gateway.address().port);
    await observed;
    expect(oldTarget.connections).toBe(1);
    target = { port: fresh.address().port, connections: 0 };
    expect(await get(gateway.address().port)).toEqual({ status: 200, body: 'new' });
    finishOld();
    expect((await pending).body).toBe('old');
    expect(oldTarget.connections).toBe(0);
  } finally { await Promise.all([gateway, old, fresh].map(close)); }
});
test('proxy returns 503 before initial readiness', async () => {
  const server = proxy(() => null); await listen(server);
  try { expect((await get(server.address().port)).status).toBe(503); } finally { await close(server); }
});
test('readiness accepts 2xx and rejects redirects, server errors and dead processes', async () => {
  let status = 204;
  const server = http.createServer((req, res) => { res.writeHead(status); res.end(); }); await listen(server);
  const target = { port: server.address().port, exited: false };
  try {
    await ready(target, '/', 500);
    for (status of [302, 500]) await expect(ready(target, '/', 50)).rejects.toThrow(/readiness failed/);
    target.exited = true;
    await expect(ready(target, '/', 50)).rejects.toThrow(/exited/);
  } finally { await close(server); }
});
test('release validation rejects traversal and symlink escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'makinari-release-'));
  const base = path.join(root, '.installer/releases'); fs.mkdirSync(base, { recursive: true });
  try {
    expect(() => releasePaths(root, { id: '../escape' })).toThrow(/Invalid/);
    fs.symlinkSync(root, path.join(base, 'escape'));
    expect(() => releasePaths(root, { id: 'escape' })).toThrow(/outside/);
    for (const repo of ['market-fit', 'API']) {
      const dir = path.join(base, 'valid', repo); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    }
    expect(releasePaths(root, { id: 'valid' }).API).toBe(fs.realpathSync(path.join(base, 'valid/API')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('health path validation rejects header injection and absolute URLs', () => {
  expect(healthPath('/health')).toBe('/health');
  expect(() => healthPath('https://remote/')).toThrow();
  expect(() => healthPath('/\r\nHost: remote')).toThrow();
});

test('managed supervisor activates isolated candidates, retains old release on failure and resumes on restart', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'makinari-runtime-')));
  fs.cpSync(path.join(__dirname, '../scripts'), path.join(root, 'scripts'), { recursive: true });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  for (const repo of ['market-fit', 'API', 'Workflows']) fs.mkdirSync(path.join(root, repo));
  const reserve = http.createServer(); await listen(reserve); const frontend = reserve.address().port; await close(reserve);
  const reserveApi = http.createServer(); await listen(reserveApi); const api = reserveApi.address().port; await close(reserveApi);
  fs.mkdirSync(path.join(root, '.installer'));
  fs.writeFileSync(path.join(root, '.installer/credentials.json'), JSON.stringify({ ports: { frontend, api }, temporal: 'cloud' }));
  const executable = text => `#!${process.execPath}\n${text}`;
  fs.writeFileSync(path.join(bin, 'npm'), executable(`const http=require('node:http'); const fs=require('node:fs');
    const port=Number(process.argv[process.argv.indexOf('--port')+1]);
    if(fs.existsSync('failed')) process.exit(1);
    http.createServer((req,res)=>res.end(process.cwd())).listen(port,'127.0.0.1');`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tsx'), executable(`require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'workers'))},'worker\\n'); setInterval(()=>{},1000);`), { mode: 0o755 });
  const socketPath = path.join(root, '.installer/runtime.sock');
  const request = (method, url, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: url }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  let runtime;
  const start = async () => {
    runtime = spawn(process.execPath, [path.join(root, 'scripts/workspace-runtime.cjs')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      const status = await request('GET', '/status').catch(() => null);
      if (status?.body.ready) return;
      if (runtime.exitCode !== null) throw new Error('Runtime fixture exited');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Runtime fixture did not become ready');
  };
  const terminate = async () => {
    if (!runtime || runtime.exitCode !== null) return;
    const exited = new Promise(resolve => runtime.once('exit', resolve)); runtime.kill('SIGTERM'); await exited;
  };
  try {
    await start();
    expect((await get(frontend)).body).toBe(path.join(root, 'market-fit'));
    for (const id of ['bad', 'good']) for (const repo of ['market-fit', 'API']) {
      const dir = path.join(root, '.installer/releases', id, repo); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      if (id === 'bad') fs.writeFileSync(path.join(dir, 'failed'), '');
    }
    expect((await request('POST', '/update', { release: { id: 'bad' } })).status).toBe(400);
    expect((await get(frontend)).body).toBe(path.join(root, 'market-fit'));
    expect((await request('POST', '/update', { release: { id: 'good' } })).status).toBe(200);
    expect((await get(frontend)).body).toBe(path.join(root, '.installer/releases/good/market-fit'));
    expect((await get(api)).body).toBe(path.join(root, '.installer/releases/good/API'));
    expect(fs.readFileSync(path.join(root, 'workers'), 'utf8').trim().split('\n')).toHaveLength(3);
    const configFile = path.join(root, '.installer/credentials.json');
    const originalConfig = fs.readFileSync(configFile);
    fs.appendFileSync(configFile, '\n');
    expect((await request('POST', '/update', { release: { id: 'good' } })).body.error).toMatch(/Configuration changed/);
    expect((await get(frontend)).body).toContain('/releases/good/market-fit');
    fs.writeFileSync(configFile, originalConfig);
    await terminate();
    await start();
    expect((await get(frontend)).body).toContain('/releases/good/market-fit');
  } finally { await terminate(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);