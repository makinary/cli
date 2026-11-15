const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { canonicalRoot, controlPath, socketStat, control, cli } = require('../scripts/runtime-control.cjs');
const execute = promisify(execFile);
let root;
let servers;
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'runtime-control-')));
  fs.mkdirSync(path.join(root, '.installer'), { mode: 0o700 });
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.filter(server => server.listening).map(close));
  fs.rmSync(root, { recursive: true, force: true });
});

const identity = () => ({ managed: true, root, pid: process.pid, configHash: 'a'.repeat(64),
  instanceId: 'b'.repeat(32), ready: true, busy: false, closing: false });
async function serve(handler, socketPath = controlPath(root)) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  return server;
}
function reply(res, body, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

test('canonical root rejects relative paths, normalization, control characters and symlink aliases', () => {
  expect(canonicalRoot(root)).toBe(root);
  for (const value of [null, '', '.', root + '/', root + '/.', root + '/child/..', root + '\n', root + '\0']) {
    expect(() => canonicalRoot(value)).toThrow();
  }
  const alias = path.join(root, 'alias'); fs.symlinkSync(root, alias);
  expect(() => canonicalRoot(alias)).toThrow(/canonical|symlink/);
});

test('installer directory symlinks and unsafe permissions are refused without changing them', () => {
  const directory = path.join(root, '.installer'); fs.rmSync(directory, { recursive: true });
  fs.mkdirSync(path.join(root, 'other')); fs.symlinkSync(path.join(root, 'other'), directory);
  expect(() => controlPath(root)).toThrow(/symlink/);
  fs.unlinkSync(directory); fs.mkdirSync(directory, { mode: 0o777 }); fs.chmodSync(directory, 0o777);
  expect(() => controlPath(root)).toThrow(/not writable/);
  expect(fs.statSync(directory).mode & 0o777).toBe(0o777);
});

test('regular file, symlink, unsafe socket mode and wrong owner are refused before requests', async () => {
  const socketPath = controlPath(root);
  fs.writeFileSync(socketPath, 'unrelated', { mode: 0o600 });
  await expect(control('stop', root)).rejects.toThrow(/Unix socket/);
  expect(fs.readFileSync(socketPath, 'utf8')).toBe('unrelated'); fs.unlinkSync(socketPath);
  let requests = 0;
  const actual = path.join(root, '.installer/other.sock');
  await serve((req, res) => { requests++; reply(res, identity()); }, actual);
  fs.symlinkSync(actual, socketPath);
  await expect(control('stop', root)).rejects.toThrow(/non-symlink/);
  expect(requests).toBe(0); fs.unlinkSync(socketPath);
  await serve((req, res) => { requests++; reply(res, identity()); });
  fs.chmodSync(socketPath, 0o660);
  await expect(control('stop', root)).rejects.toThrow(/0600/);
  fs.chmodSync(socketPath, 0o600);
  const original = fs.lstatSync.bind(fs);
  const spy = jest.spyOn(fs, 'lstatSync').mockImplementation(file => {
    const stat = original(file);
    if (file === socketPath) stat.uid = process.getuid() + 1;
    return stat;
  });
  try { expect(() => socketStat(root)).toThrow(/owned/); } finally { spy.mockRestore(); }
  expect(requests).toBe(0);
});

test('CLI has only status|stop with an explicit canonical root and prints socket-authoritative JSON', async () => {
  await serve((req, res) => { expect(req.method).toBe('GET'); expect(req.url).toBe('/status'); reply(res, identity()); });
  const output = [];
  expect(await cli(['status', '--root', root], { output: line => output.push(line) })).toEqual(identity());
  expect(JSON.parse(output[0])).toEqual(identity());
  const result = await execute(process.execPath, [path.join(__dirname, '../scripts/runtime-control.cjs'), 'status', '--root', root]);
  expect(JSON.parse(result.stdout)).toEqual(identity());
  for (const args of [[], ['stop'], ['stop', '--root', '.'], ['stop', '--pid', String(process.pid)],
    ['stop', '--root', root, '--host', 'localhost'], ['status', '--root', root, '--port', '3000']]) {
    await expect(cli(args)).rejects.toThrow();
  }
});

test.each([
  { root: '/wrong-workspace' }, { managed: false }, { pid: -1 }, { pid: '123' },
  { configHash: 'invalid' }, { configHash: ['a'.repeat(64)] }, { instanceId: undefined }, { ready: undefined },
])('wrong or malformed status %j never sends a stop request', async changes => {
  const methods = [];
  await serve((req, res) => { methods.push(req.method); reply(res, { ...identity(), ...changes }); });
  await expect(control('stop', root)).rejects.toThrow(/identity|root/);
  expect(methods).toEqual(['GET']);
});

test('stop sends only root and server fingerprint/instance, confirms ack, then waits for cleanup', async () => {
  const messages = [];
  let closed = false;
  const server = await serve((req, res) => {
    if (req.method === 'GET') { reply(res, identity()); return; }
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      messages.push(JSON.parse(body)); reply(res, { ...identity(), closing: true, accepted: true }, 202);
      setTimeout(async () => { await close(server); closed = true; }, 150);
    });
  });
  const started = Date.now();
  expect(await control('stop', root)).toMatchObject({ stopped: true, pid: process.pid, root });
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  expect(closed).toBe(true);
  expect(messages).toEqual([{ root, configHash: identity().configHash, instanceId: identity().instanceId }]);
  expect(fs.existsSync(controlPath(root))).toBe(false);
});

test.each([{ accepted: false }, { pid: process.pid + 1 }, { configHash: 'c'.repeat(64) }, { closing: false }])(
  'unconfirmed or changed stop acknowledgement %j is not reported as stopped', async changes => {
    await serve((req, res) => reply(res, req.method === 'GET' ? identity() :
      { ...identity(), accepted: true, closing: true, ...changes }, req.method === 'GET' ? 200 : 202));
    await expect(control('stop', root)).rejects.toThrow(/identity changed|confirm/);
  });

test('accepted but live supervisor times out without unlinking or signalling anything', async () => {
  await serve((req, res) => reply(res, req.method === 'GET' ? identity() :
    { ...identity(), accepted: true, closing: true }, req.method === 'GET' ? 200 : 202));
  const stat = socketStat(root);
  await expect(control('stop', root, { timeout: 100 })).rejects.toThrow(/still listening/);
  expect(socketStat(root).ino).toBe(stat.ino);
});

test('missing and stale sockets are never removed or treated as confirmed stop', async () => {
  await expect(control('stop', root)).rejects.toHaveProperty('code', 'ENOENT');
  const socketPath = controlPath(root);
  const server = await serve((req, res) => reply(res, identity()));
  // Move a server-owned socket before close to retain an unlistening test socket.
  const stale = path.join(root, '.installer/stale.sock'); fs.renameSync(socketPath, stale);
  await close(server); fs.renameSync(stale, socketPath);
  await expect(control('stop', root)).rejects.toHaveProperty('code', 'ECONNREFUSED');
  expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
});

test('oversized or non-JSON supervisor responses are refused', async () => {
  let text = 'not json';
  await serve((req, res) => res.end(text));
  await expect(control('status', root)).rejects.toThrow();
  text = 'x'.repeat(5000);
  await expect(control('status', root)).rejects.toThrow(/too large/);
});