const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepare, cli } = require('../scripts/update-workspace.cjs');

const realExec = promisify(execFile);
let temporary;
let root;
let calls;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);

function fixture(repos = ['market-fit', 'API']) {
  // macOS os.tmpdir() is too long for the Unix-domain socket address limit.
  temporary = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'workspace-update-'));
  root = path.join(temporary, 'workspace');
  fs.mkdirSync(root);
  calls = [];
  for (const repo of repos) {
    const seed = path.join(temporary, `${repo}-publisher`);
    fs.mkdirSync(seed);
    git(seed, 'init', '-b', 'main');
    git(seed, 'config', 'user.email', 'test@example.invalid');
    git(seed, 'config', 'user.name', 'Update test');
    write(seed, '.gitignore', '.env\n.env.local\nnode_modules/\n');
    write(seed, '.env.example', 'SAFE_TEMPLATE=\n');
    write(seed, 'package.json', JSON.stringify({ name: repo.toLowerCase(), version: '1.0.0' }));
    write(seed, 'package-lock.json', JSON.stringify({ name: repo.toLowerCase(), version: '1.0.0', lockfileVersion: 3, packages: { '': { name: repo.toLowerCase(), version: '1.0.0' } } }));
    write(seed, 'version.txt', 'old\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'initial');
    const origin = path.join(temporary, `${repo}-origin.git`);
    git(temporary, 'clone', '--bare', seed, origin);
    git(seed, 'remote', 'add', 'origin', origin);
    git(temporary, 'clone', origin, path.join(root, repo));
    git(path.join(root, repo), 'config', 'user.email', 'test@example.invalid');
    git(path.join(root, repo), 'config', 'user.name', 'Update test');
    write(path.join(root, repo), '.env', `PRIVATE=${repo}\n`);
    write(path.join(root, repo), '.env.local', `LOCAL_PRIVATE=${repo}\n`);
  }
}

function publish(repo, edit = seed => write(seed, 'version.txt', 'new\n')) {
  const seed = path.join(temporary, `${repo}-publisher`);
  edit(seed);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'upstream update');
  git(seed, 'push', 'origin', 'main');
  return git(seed, 'rev-parse', 'HEAD');
}

async function exec(command, args, options) {
  calls.push({ command, args, cwd: options.cwd });
  if (command === 'npm') return { stdout: '', stderr: '' };
  return realExec(command, args, options);
}

function stages() {
  const dir = path.join(root, '.installer', 'releases');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

afterEach(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

test('archives upstream commits, installs only default repos, keeps sources unchanged and stages secrets privately', async () => {
  fixture(['market-fit', 'API', 'Workflows']);
  const heads = Object.fromEntries(['market-fit', 'API', 'Workflows'].map(repo => [repo, git(path.join(root, repo), 'rev-parse', 'HEAD')]));
  const revision = publish('market-fit');
  const release = await prepare(root, undefined, { exec });
  expect(release.id).toMatch(/^[a-f0-9]{32}$/);
  expect(release.directory).toBe(path.join(root, '.installer', 'releases', release.id));
  expect(Object.keys(release.paths)).toEqual(['market-fit', 'API']);
  expect(release.revisions['market-fit']).toBe(revision);
  expect(fs.readFileSync(path.join(release.paths['market-fit'], 'version.txt'), 'utf8')).toBe('new\n');
  for (const repo of ['market-fit', 'API']) {
    expect(path.isAbsolute(release.paths[repo])).toBe(true);
    expect(fs.existsSync(path.join(release.paths[repo], '.git'))).toBe(false);
    expect(fs.statSync(release.paths[repo]).mode & 0o777).toBe(0o700);
    for (const name of ['.env', '.env.local']) {
      expect(fs.readFileSync(path.join(release.paths[repo], name), 'utf8')).toBe(fs.readFileSync(path.join(root, repo, name), 'utf8'));
      expect(fs.statSync(path.join(release.paths[repo], name)).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(release.paths[repo], '.env.example'))).toBe(true);
  }
  for (const repo of Object.keys(heads)) {
    expect(git(path.join(root, repo), 'rev-parse', 'HEAD')).toBe(heads[repo]);
    expect(git(path.join(root, repo), 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(root, repo, 'version.txt'), 'utf8')).toBe('old\n');
  }
  expect(fs.statSync(release.directory).mode & 0o777).toBe(0o700);
  expect(calls.filter(call => call.command === 'npm').map(call => [call.args, call.cwd])).toEqual([
    [['ci'], release.paths['market-fit']], [['ci'], release.paths.API]
  ]);
});

test.each(['untracked', 'modified'])('checks all repositories before fetching or installing: %s', async kind => {
  fixture();
  write(path.join(root, 'API'), kind === 'untracked' ? 'untracked.txt' : 'version.txt', 'dirty');
  await expect(prepare(root, undefined, { exec })).rejects.toThrow(/API.*not clean/);
  expect(calls.some(call => call.args[0] === 'fetch' || call.command === 'npm')).toBe(false);
  expect(stages()).toEqual([]);
});

test.each(['ahead', 'diverged'])('rejects locally %s without resetting source HEAD', async kind => {
  fixture();
  const source = path.join(root, 'API');
  write(source, 'local.txt', 'local commit');
  git(source, 'add', 'local.txt');
  git(source, 'commit', '-m', 'local');
  const head = git(source, 'rev-parse', 'HEAD');
  if (kind === 'diverged') publish('API');
  await expect(prepare(root, undefined, { exec })).rejects.toThrow(/ahead.*diverged/);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
  expect(stages()).toEqual([]);
  expect(calls.some(call => call.command === 'npm')).toBe(false);
});

test.each(['detached', 'no-upstream'])('rejects %s checkouts before fetch', async kind => {
  fixture();
  const source = path.join(root, 'API');
  if (kind === 'detached') git(source, 'checkout', '--detach');
  else git(source, 'branch', '--unset-upstream');
  await expect(prepare(root, undefined, { exec })).rejects.toThrow(/upstream/);
  expect(calls.some(call => call.args[0] === 'fetch')).toBe(false);
});

test.each(['local', 'upstream'])('rejects tracked secret env files in %s revisions', async where => {
  fixture();
  if (where === 'local') {
    const source = path.join(root, 'API');
    git(source, 'add', '-f', '.env');
    git(source, 'commit', '-m', 'unsafe secret');
  } else publish('API', seed => write(seed, '.env.production', 'SECRET=never archive\n'));
  await expect(prepare(root, undefined, { exec })).rejects.toThrow(/tracked .env secrets/);
  expect(stages()).toEqual([]);
});

test('rejects nested tracked .env and accepts only .example templates', async () => {
  fixture();
  publish('API', seed => { fs.mkdirSync(path.join(seed, 'nested')); write(path.join(seed, 'nested'), '.env.local', 'SECRET=x'); git(seed, 'add', '-f', 'nested/.env.local'); });
  await expect(prepare(root, undefined, { exec })).rejects.toThrow(/tracked .env secrets/);
});

test('requires lockfiles and cleans the entire release before any npm ci', async () => {
  fixture();
  publish('API', seed => fs.unlinkSync(path.join(seed, 'package-lock.json')));
  await expect(prepare(root, undefined, { exec })).rejects.toThrow(/package-lock.json/);
  expect(stages()).toEqual([]);
  expect(calls.some(call => call.command === 'npm')).toBe(false);
});

test('npm installation failure removes all staging and preserves source envs', async () => {
  fixture();
  await expect(prepare(root, undefined, { exec: async (command, args, options) => {
    if (command === 'npm' && path.basename(options.cwd) === 'API') throw new Error('npm ci failed');
    return exec(command, args, options);
  } })).rejects.toThrow(/npm operation failed.*suppressed/);
  expect(stages()).toEqual([]);
  expect(fs.readFileSync(path.join(root, 'API', '.env'), 'utf8')).toBe('PRIVATE=API\n');
});

test('snapshots managed credentials hash and rejects configuration changes during installation', async () => {
  fixture();
  fs.mkdirSync(path.join(root, '.installer'));
  write(path.join(root, '.installer'), 'credentials.json', '{"version":1}\n');
  const release = await prepare(root, undefined, { exec });
  expect(release.configHash).toBe(require('node:crypto').createHash('sha256').update('{"version":1}\n').digest('hex'));
  await expect(prepare(root, undefined, { exec: async (command, args, options) => {
    if (command === 'npm') write(path.join(root, '.installer'), 'credentials.json', '{"version":2}\n');
    return exec(command, args, options);
  } })).rejects.toThrow(/Configuration changed/);
  expect(stages()).toEqual([release.id]);
});

test('refuses symlink private env files instead of copying arbitrary external secrets', async () => {
  fixture();
  fs.unlinkSync(path.join(root, 'API', '.env'));
  fs.symlinkSync(path.join(root, 'market-fit', '.env'), path.join(root, 'API', '.env'));
  await expect(prepare(root, undefined, { exec })).rejects.toThrow(/regular private file/);
  expect(stages()).toEqual([]);
});

test('validates repository names rather than permitting path traversal or installer updates', async () => {
  fixture();
  for (const repos of [[], ['../installer'], ['database'], ['API', 'API']]) {
    await expect(prepare(root, repos, { exec })).rejects.toThrow(/repositories/);
  }
  expect(calls).toEqual([]);
});

test('CLI verifies managed status before any git work and posts the exact release', async () => {
  fixture();
  const requests = [];
  const release = await cli(['--update'], { root, exec, output: () => {}, request: async (receivedRoot, method, url, body) => {
    requests.push({ receivedRoot, method, url, body });
    if (method === 'GET') { expect(calls).toEqual([]); return { managed: true }; }
    return { ok: true };
  } });
  expect(requests).toEqual([
    { receivedRoot: root, method: 'GET', url: '/status', body: undefined },
    { receivedRoot: root, method: 'POST', url: '/update', body: { release } }
  ]);
});

test('CLI missing socket fails with restart guidance before touching git or installing', async () => {
  fixture();
  await expect(cli(['--update'], { root, exec, output: () => {} })).rejects.toThrow(/restart once with managed start/);
  expect(calls).toEqual([]);
  expect(stages()).toEqual([]);
});

test('CLI rejects unmanaged status before git changes', async () => {
  fixture();
  await expect(cli(['--update'], { root, exec, request: async () => ({ managed: false }) })).rejects.toThrow(/restart once/);
  expect(calls).toEqual([]);
});

test.each([{ managed: true, ready: false }, { managed: true, ready: true, busy: true }])('CLI rejects not-ready or busy status %j before git', async status => {
  fixture();
  await expect(cli(['--update'], { root, exec, request: async () => status })).rejects.toThrow(/not ready or is busy/);
  expect(calls).toEqual([]);
});

test('prepare-only stages workers too without contacting supervisor or activation', async () => {
  fixture(['market-fit', 'API', 'Workflows']);
  const output = [];
  const release = await cli(['--update', '--prepare-only'], { root, exec,
    request: async () => { throw new Error('must not request'); }, output: text => output.push(text) });
  expect(Object.keys(release.paths)).toEqual(['market-fit', 'API', 'Workflows']);
  expect(calls.filter(call => call.command === 'npm')).toHaveLength(3);
  expect(output.join('')).toMatch(/not activated/);
});

test.each([[], ['--prepare-only'], ['--update', '--health-path', '/health'], ['--update', '--update'], ['--help', '--update']].map(args => [args]))('rejects invalid CLI args %j', async args => {
  await expect(cli(args)).rejects.toThrow(/invalid arguments/);
});

test('help explains excluded scopes, manual workers, private staging and no automatic self-update', async () => {
  const output = [];
  await cli(['--help'], { output: text => output.push(text) });
  expect(output.join('')).toMatch(/Workers and database are excluded/);
  expect(output.join('')).toMatch(/manual controlled update/);
  expect(output.join('')).toMatch(/automatic installer self-update/);
  expect(output.join('')).toMatch(/only 2xx/);
  await cli(['--update', '--help'], { output: text => output.push(text) });
  expect(output).toHaveLength(2);
});

test('records private release manifest and requires a configured source env', async () => {
  fixture();
  const release = await prepare(root, undefined, { exec });
  const manifest = path.join(release.directory, 'release.json');
  expect(JSON.parse(fs.readFileSync(manifest, 'utf8'))).toEqual(release);
  expect(fs.statSync(manifest).mode & 0o777).toBe(0o600);
  fs.unlinkSync(path.join(root, 'API', '.env'));
  await expect(prepare(root, undefined, { exec })).rejects.toThrow(/.env is missing/);
  expect(stages()).toEqual([release.id]);
});

test('real Unix socket HTTP protocol checks status then sends JSON release', async () => {
  fixture();
  fs.mkdirSync(path.join(root, '.installer'));
  const messages = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      messages.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/status' ? { managed: true } : { ok: true }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(root, '.installer', 'runtime.sock'), resolve); });
  try {
    const release = await cli(['--update'], { root, exec, output: () => {} });
    expect(messages).toEqual([
      { method: 'GET', url: '/status', body: undefined },
      { method: 'POST', url: '/update', body: { release } }
    ]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});