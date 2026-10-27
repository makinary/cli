// Stable public ports; only the two HTTP services participate in live updates.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { load } = require('./workspace-config.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const services = ['market-fit', 'API'];
function healthPath(value) {
  if (!value.startsWith('/') || /[\r\n]/.test(value)) throw new Error('Health paths must start with /');
  return value;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function proxy(getTarget) {
  const server = http.createServer((req, res) => {
    const target = getTarget();
    if (!target) { res.writeHead(503); res.end('Service starting'); return; }
    target.connections++;
    let done = false;
    const finish = () => { if (!done) { done = true; target.connections--; } };
    const upstream = http.request({ host: '127.0.0.1', port: target.port, method: req.method,
      path: req.url, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => { upstream.destroy(); finish(); });
    res.on('finish', finish);
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const target = getTarget();
    if (!target) { socket.destroy(); return; }
    target.connections++;
    const upstream = net.connect(target.port, '127.0.0.1');
    socket.once('close', () => { target.connections--; upstream.destroy(); });
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.once('close', () => socket.destroy());
    upstream.once('connect', () => {
      const headers = req.rawHeaders.reduce((all, value, i) => all + (i % 2 ? `${value}\r\n` : `${value}: `), '');
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  return server;
}
async function ready(target, urlPath, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (target.exited) throw new Error('Candidate service exited before readiness');
    const ok = await new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port: target.port, path: urlPath, timeout: 2000 }, res => {
        res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(250);
  }
  throw new Error(`HTTP readiness failed at ${urlPath}; old release retained`);
}
function child(command, args, cwd, env = {}) {
  const process = spawn(command, args, { cwd, env: { ...global.process.env, ...env }, stdio: 'inherit', detached: true });
  const target = { process, connections: 0, exited: false };
  process.on('exit', () => { target.exited = true; });
  process.on('error', () => { target.exited = true; });
  return target;
}
async function stop(target) {
  if (!target?.process.pid) return;
  const signal = value => {
    try { process.kill(-target.process.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 10000;
  while (!target.exited && Date.now() < deadline) await sleep(100);
  // Also remove descendants when the npm wrapper has already exited.
  signal('SIGKILL');
}
function releasePaths(root, release) {
  const base = fs.realpathSync(path.join(root, '.installer', 'releases'));
  if (!release || !/^[a-zA-Z0-9_-]+$/.test(release.id)) throw new Error('Invalid release ID');
  const directory = fs.realpathSync(path.join(base, release.id));
  if (path.dirname(directory) !== base) throw new Error('Release outside staging directory');
  return Object.fromEntries(services.map(repo => {
    const dir = fs.realpathSync(path.join(directory, repo));
    if (path.dirname(dir) !== directory || !fs.existsSync(path.join(dir, 'package-lock.json'))) throw new Error('Invalid staged service');
    return [repo, dir];
  }));
}
async function main(root) {
  const config = load(root);
  const fingerprint = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, '.installer', 'credentials.json'))).digest('hex');
  const configHash = fingerprint();
  const activeFile = path.join(root, '.installer', 'active-web.json');
  const socketPath = path.join(root, '.installer', 'runtime.sock');
  const paths = {
    'market-fit': healthPath(process.env.MAKINARI_FRONTEND_HEALTH_PATH || '/'),
    API: healthPath(process.env.MAKINARI_API_HEALTH_PATH || '/'),
  };
  let active = null;
  let busy = false;
  let closing = false;
  const children = new Set();
  const servers = [];
  function launch(command, args, cwd, env) {
    if (closing) throw new Error('Runtime shutting down');
    const target = child(command, args, cwd, env);
    children.add(target);
    return target;
  }
  async function startWeb(directories) {
    const result = {};
    try {
      for (const repo of services) {
        const port = await freePort();
        result[repo] = launch('npm', ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(port)], directories[repo], { PORT: String(port) });
        result[repo].port = port;
      }
      await Promise.all(services.map(repo => ready(result[repo], paths[repo])));
      if (closing || services.some(repo => result[repo].exited)) throw new Error('Startup interrupted');
      return result;
    } catch (error) {
      await Promise.all(Object.values(result).map(stop));
      for (const target of Object.values(result)) children.delete(target);
      throw error;
    }
  }
  async function drain(previous) {
    const deadline = Date.now() + 30000;
    while (!closing && services.some(repo => previous[repo].connections) && Date.now() < deadline) await sleep(100);
    await Promise.all(services.map(repo => stop(previous[repo])));
    for (const repo of services) children.delete(previous[repo]);
  }
  async function shutdown() {
    if (closing) return;
    closing = true;
    for (const server of servers) { server.close(); server.closeAllConnections?.(); }
    await Promise.all([...children].map(stop));
    process.exit(0);
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const control = http.createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/status') { reply(200, { managed: true, ready: !!active, busy }); return; }
    if (req.method !== 'POST' || req.url !== '/update') { reply(404, { error: 'Not found' }); return; }
    if (!active || busy || closing) { reply(409, { error: 'Runtime not ready or update in progress' }); return; }
    busy = true;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Request too large'); }
      const release = JSON.parse(body).release;
      if (fingerprint() !== configHash) throw new Error('Configuration changed; restart the managed workspace before updating');
      if (release.configHash && release.configHash !== configHash) throw new Error('Release configuration does not match the running workspace');
      const candidates = await startWeb(releasePaths(root, release));
      try {
        fs.writeFileSync(`${activeFile}.tmp`, JSON.stringify({ id: release.id, configHash }), { mode: 0o600 });
        fs.renameSync(`${activeFile}.tmp`, activeFile);
      } catch (error) { await Promise.all(Object.values(candidates).map(stop)); throw error; }
      const previous = active;
      active = candidates; // One synchronous pointer switch covers both public ports.
      console.log(`Activated web release ${release.id}; draining previous connections for up to 30s.`);
      await drain(previous);
      reply(200, { activated: release.id });
    } catch (error) { reply(400, { error: error.message }); }
    finally { busy = false; }
  });
  try {
    // Never unlink an existing socket: a second start must not hijack a live supervisor.
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(socketPath, resolve); });
    servers.push(control);
    fs.chmodSync(socketPath, 0o600);
    for (const [repo, port] of [['market-fit', config.ports.frontend], ['API', config.ports.api]]) {
      const server = proxy(() => active?.[repo]);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
      servers.push(server);
    }
    if (config.temporal === 'local') launch('temporal', ['server', 'start-dev', '--ui-port', '8080', '--db-filename', 'temporal.db'], root);
    for (const queue of ['critical', 'mail', 'default']) {
      launch('tsx', ['src/scripts/start-worker.ts'], path.join(root, 'Workflows'), { WORKFLOW_TASK_QUEUE: queue });
    }
    let directories = Object.fromEntries(services.map(repo => [repo, path.join(root, repo)]));
    if (fs.existsSync(activeFile)) {
      const previous = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      if (previous.configHash !== configHash) throw new Error('Configuration changed since activation. Review/remove .installer/active-web.json to restart from source checkouts.');
      directories = releasePaths(root, previous);
    }
    active = await startWeb(directories);
    console.log(`Managed services ready on public ports ${config.ports.frontend}/${config.ports.api}. Use ./install.sh --update.`);
    setInterval(() => {
      if ([...children].some(target => target.exited && (Object.values(active || {}).includes(target)
          || !target.port))) { console.error('Active service exited; stopping managed workspace.'); shutdown(); }
    }, 1000);
  } catch (error) {
    console.error(error.message);
    for (const server of servers) { server.close(); server.closeAllConnections?.(); }
    await Promise.all([...children].map(stop));
    process.exit(1);
  }
}
if (require.main === module) main(path.resolve(__dirname, '..')).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { proxy, ready, releasePaths, healthPath };