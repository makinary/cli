const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { control } = require('../scripts/runtime-control.cjs');
const { proxy, ready, releasePaths, healthPath, normalizeLocation } = require('../scripts/workspace-runtime.cjs');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
const getResponse = (port, options = {}) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port, ...options }, res => {
    let body = ''; res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});
const get = async port => { const { status, body } = await getResponse(port); return { status, body }; };

describe('internal Location normalization', () => {
  const port = 37695;
  test.each(['localhost', '127.0.0.1', '[::1]'])('normalizes HTTP %s only on the target port', hostname => {
    const destination = '/auth?returnTo=%2Fprojects&next=a%2Bb#signed-out';
    expect(normalizeLocation(`http://${hostname}:${port}${destination}`, port)).toBe(destination);
  });
  test.each([
    [`http://localhost:${port}`, '/'],
    [`http://localhost:${port}?returnTo=%2Fprojects#done`, '/?returnTo=%2Fprojects#done'],
    [`HTTP://LOCALHOST:${port}/auth`, '/auth'],
    [`http://localhost:${port}/%2Fexternal.example/auth`, '/%2Fexternal.example/auth'],
    ['http://localhost:80/auth', '/auth'],
  ])('returns pathname, search and hash for %s', (location, expected) => {
    expect(normalizeLocation(location, location.includes(':80/') ? 80 : port)).toBe(expected);
  });
  test.each([
    '/auth?returnTo=%2Fprojects#done', 'auth', '?next=/auth', '#done',
    '//localhost:37695/auth', '//external.example/auth', '', undefined, null,
    ['http://localhost:37695/auth'],
    'https://accounts.example/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A37695%2Fauth',
    'http://accounts.example:37695/oauth/authorize',
    'https://localhost:37695/auth', 'ftp://localhost:37695/auth', 'ws://localhost:37695/auth',
    'javascript:alert(1)', 'data:text/plain,auth',
    'http://localhost:3000/auth', 'http://127.0.0.1:37696/auth', 'http://[::1]:37696/auth',
    'http://localhost/auth', 'http://localhost:037695/auth',
    'http://user:password@localhost:37695/auth', 'http://user@127.0.0.1:37695/auth',
    'http://@localhost:37695/auth', 'http://:@[::1]:37695/auth',
    'http://localhost:37695@external.example/auth', 'http://localhost.external.example:37695/auth',
    'http://localhost.:37695/auth', 'http://127.1:37695/auth', 'http://2130706433:37695/auth',
    'http://0.0.0.0:37695/auth', 'http://[::ffff:127.0.0.1]:37695/auth',
    'http://%6cocalhost:37695/auth', 'http:localhost:37695/auth', 'http:///localhost:37695/auth',
    ' http://localhost:37695/auth', 'http://localhost:invalid/auth',
    'http://localhost:37695//external.example/auth', 'http://localhost:37695///external.example/auth',
    'http://localhost:37695/\\external.example/auth', 'http://localhost:37695/a/..//external.example/auth',
  ])('preserves ineligible or unsafe Location %j', location => {
    expect(normalizeLocation(location, port)).toBe(location);
  });
});

test('real proxy normalizes internal 302 redirects without changing status, cookies or body', async () => {
  const cookies = ['session=; Path=/; HttpOnly; Max-Age=0', 'site=; Path=/; SameSite=Lax; Max-Age=0'];
  const destination = '/auth?returnTo=%2Fprojects#signed-out';
  let hostname = 'localhost';
  const app = http.createServer((req, res) => {
    expect(req.url).toBe('/api/auth/logout');
    res.writeHead(302, { Location: `http://${hostname}:${app.address().port}${destination}`,
      'Set-Cookie': cookies, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' });
    res.end('signed out');
  });
  await listen(app);
  const target = { port: app.address().port, connections: 0 };
  const gateway = proxy(() => target); await listen(gateway);
  try {
    const browserOrigin = `http://127.0.0.1:${gateway.address().port}`;
    for (hostname of ['localhost', '127.0.0.1', '[::1]']) {
      const response = await getResponse(gateway.address().port, { path: '/api/auth/logout' });
      expect(response).toMatchObject({ status: 302, body: 'signed out', headers: {
        location: destination, 'set-cookie': cookies, 'cache-control': 'no-store', 'content-type': 'text/plain',
      } });
      expect(new URL(response.headers.location, browserOrigin).href).toBe(browserOrigin + destination);
      expect(target.connections).toBe(0);
    }
  } finally { await Promise.all([gateway, app].map(close)); }
});

test('real proxy ignores spoofed origin headers and preserves OAuth and other-service redirects', async () => {
  let location;
  let observedHeaders;
  const app = http.createServer((req, res) => {
    observedHeaders = req.headers;
    res.writeHead(302, { Location: location, 'Set-Cookie': ['session=unchanged; Path=/; HttpOnly'] });
    res.end();
  });
  const backend = http.createServer((req, res) => res.end('backend'));
  await listen(app); await listen(backend);
  const target = { port: app.address().port, connections: 0 };
  const gateway = proxy(() => target); await listen(gateway);
  try {
    const spoofedHeaders = {
      host: `accounts.example:${target.port}`, origin: 'https://accounts.example',
      'x-forwarded-host': `accounts.example:${target.port}`, 'x-forwarded-proto': 'https',
      'x-forwarded-port': String(target.port), forwarded: `host="accounts.example:${target.port}";proto=https`,
    };
    const cases = [
      [`http://localhost:${target.port}/auth`, '/auth'],
      [`https://accounts.example/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A${target.port}%2Fauth`, null],
      [`http://accounts.example:${target.port}/oauth/authorize`, null],
      [`http://localhost:${backend.address().port}/auth`, null],
      [`http://127.0.0.1:${backend.address().port}/auth`, null],
      [`http://localhost:${gateway.address().port}/auth`, null],
      [`https://localhost:${target.port}/auth`, null],
      [`http://user:password@localhost:${target.port}/auth`, null],
      [`http://localhost:${target.port}//external.example/auth`, null],
      ['/auth?next=%2Fprojects#done', null], ['//external.example/auth', null],
    ];
    for (const [original, normalized] of cases) {
      location = original;
      const response = await getResponse(gateway.address().port, { path: '/api/auth/logout', headers: spoofedHeaders });
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(normalized ?? original);
      expect(response.headers['set-cookie']).toEqual(['session=unchanged; Path=/; HttpOnly']);
      expect(observedHeaders).toMatchObject(spoofedHeaders);
      expect(target.connections).toBe(0);
    }
  } finally { await Promise.all([gateway, app, backend].map(close)); }
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
  fs.copyFileSync(path.join(__dirname, '../install.sh'), path.join(root, 'install.sh'));
  // Exercise installer dispatch without infrastructure, credentials writes or provider calls.
  fs.writeFileSync(path.join(root, 'start-workspace.sh'), '#!/bin/bash\nexec node scripts/workspace-runtime.cjs\n');
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
  fs.writeFileSync(path.join(bin, 'tsx'), executable(`const fs=require('node:fs');
    fs.appendFileSync(${JSON.stringify(path.join(root, 'workers'))},'worker\\n');
    process.on('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(path.join(root, 'stopped-workers'))},'stopped\\n');process.exit(0)});
    setInterval(()=>{},1000);`), { mode: 0o755 });
  const socketPath = path.join(root, '.installer/runtime.sock');
  const request = (method, url, body, headers = { 'Content-Type': 'application/json' }) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: url, headers, agent: false }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined);
  });
  let runtime;
  const start = async () => {
    runtime = spawn('bash', [path.join(root, 'install.sh'), '--start'], {
      env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}` }, stdio: 'ignore' });
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
    const identity = await control('status', root);
    expect(identity).toMatchObject({ root, pid: runtime.pid, managed: true, ready: true, closing: false });
    expect(identity.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(socketPath).uid).toBe(process.getuid());
    const alias = `${root}-alias`; fs.symlinkSync(root, alias);
    try {
      for (const body of [undefined, '{', 'null', [], {}, { root: 'relative' }, { root: root + '/' },
        { root: path.dirname(root) }, { root: alias }, { root, pid: runtime.pid },
        { root, configHash: '0'.repeat(64) }, { root, instanceId: '0'.repeat(32) },
        JSON.stringify({ root, padding: 'x'.repeat(5000) })]) {
        expect((await request('POST', '/stop', body)).status).toBe(400);
        expect((await control('status', root)).instanceId).toBe(identity.instanceId);
      }
      expect((await request('POST', '/stop', { root }, {})).status).toBe(400);
      const forged = { host: 'remote.example', 'x-forwarded-host': root, 'x-forwarded-for': '127.0.0.1',
        'Content-Type': 'application/json' };
      expect((await request('POST', '/stop', { root: alias }, forged)).status).toBe(400);
      await expect(control('stop', alias)).rejects.toThrow(/canonical|symlink/);
    } finally { fs.unlinkSync(alias); }
    const socketBefore = fs.statSync(socketPath);
    const duplicate = spawn(process.execPath, [path.join(root, 'scripts/workspace-runtime.cjs')], { stdio: 'ignore' });
    expect(await new Promise(resolve => duplicate.once('exit', resolve))).toBe(1);
    expect(fs.statSync(socketPath).ino).toBe(socketBefore.ino);
    expect((await control('status', root)).pid).toBe(runtime.pid);
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
    // Stopping uses the running identity and preserves even dirty configuration bytes.
    const dirtyConfig = fs.readFileSync(configFile);
    const stopped = await control('stop', root);
    expect(stopped).toMatchObject({ accepted: true, stopped: true, closing: true, root, pid: runtime.pid });
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.readFileSync(configFile)).toEqual(dirtyConfig);
    await expect(get(frontend)).rejects.toHaveProperty('code', 'ECONNREFUSED');
    await expect(get(api)).rejects.toHaveProperty('code', 'ECONNREFUSED');
    expect(fs.readFileSync(path.join(root, 'stopped-workers'), 'utf8').trim().split('\n')).toHaveLength(3);
    await terminate();
    fs.writeFileSync(configFile, originalConfig);
    await start();
    expect((await control('status', root)).instanceId).not.toBe(identity.instanceId);
    expect((await get(frontend)).body).toContain('/releases/good/market-fit');
    // Root-only JSON is supported for direct same-user control too.
    expect((await request('POST', '/stop', { root })).body).toMatchObject({ accepted: true, root, pid: runtime.pid });
    if (runtime.exitCode === null) await new Promise(resolve => runtime.once('exit', resolve));
    expect(fs.existsSync(socketPath)).toBe(false);
  } finally { await terminate(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);