'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const LIVE_REPOS = ['market-fit', 'API'];
const MANUAL_REPOS = [...LIVE_REPOS, 'Workflows'];

function hasSecret(files) {
  return files.split('\0').some(file => {
    const name = path.posix.basename(file);
    return name.startsWith('.env') && !name.endsWith('.example');
  });
}

// exec is an optional test seam; it has the same contract as promisified execFile.
async function prepare(root, repos = LIVE_REPOS, { exec = execute } = {}) {
  root = path.resolve(root);
  if (!Array.isArray(repos) || !repos.length || new Set(repos).size !== repos.length ||
      repos.some(repo => !MANUAL_REPOS.includes(repo))) {
    throw new Error('Select unique application repositories: market-fit, API, Workflows');
  }
  const configurationFile = path.join(root, '.installer', 'credentials.json');
  const fingerprint = async () => {
    try { return crypto.createHash('sha256').update(await fs.readFile(configurationFile)).digest('hex'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const configHash = await fingerprint();
  const run = async (command, args, options) => {
    try { return await exec(command, args, { ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
    catch { throw new Error(`${command} operation failed; output suppressed to protect private configuration`); }
  };
  const git = async (cwd, args) => {
    const result = await run('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return String(result.stdout);
  };
  const checkouts = {};
  // Check EVERY checkout before even fetching any of them. Untracked files count;
  // ignored private env files do not appear in porcelain status.
  for (const repo of repos) {
    const source = path.join(root, repo);
    const actual = await fs.realpath(source);
    const top = (await git(source, ['rev-parse', '--show-toplevel'])).trim();
    if (actual !== await fs.realpath(top)) throw new Error(`${repo} is not an independent git checkout`);
    if ((await git(source, ['status', '--porcelain', '--untracked-files=all'])).trim()) {
      throw new Error(`${repo} is not clean (including untracked files); commit or remove changes first`);
    }
    if (!(await git(source, ['branch', '--show-current'])).trim()) throw new Error(`${repo} must be on a branch with an upstream`);
    let upstream;
    try { upstream = (await git(source, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).trim(); }
    catch { throw new Error(`${repo} must have a configured upstream`); }
    if (hasSecret(await git(source, ['ls-files', '-z']))) throw new Error(`${repo} has tracked .env secrets; only *.example templates are allowed`);
    checkouts[repo] = { source, upstream };
  }
  const revisions = {};
  for (const repo of repos) {
    const { source, upstream } = checkouts[repo];
    await git(source, ['fetch', '--prune']);
    const head = (await git(source, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const revision = (await git(source, ['rev-parse', '--verify', `${upstream}^{commit}`])).trim();
    try { await git(source, ['merge-base', '--is-ancestor', head, revision]); }
    catch { throw new Error(`${repo} is locally ahead of or diverged from its upstream; refusing update`); }
    if (hasSecret(await git(source, ['ls-tree', '-r', '--name-only', '-z', revision]))) {
      throw new Error(`${repo} upstream has tracked .env secrets; only *.example templates are allowed`);
    }
    revisions[repo] = revision;
  }

  const id = crypto.randomBytes(16).toString('hex');
  const installer = path.join(root, '.installer');
  const releases = path.join(installer, 'releases');
  await fs.mkdir(releases, { recursive: true, mode: 0o700 });
  await fs.chmod(installer, 0o700);
  await fs.chmod(releases, 0o700);
  const directory = path.join(releases, id);
  await fs.mkdir(directory, { mode: 0o700 });
  const paths = {};
  try {
    for (const repo of repos) {
      const destination = path.join(directory, repo);
      paths[repo] = destination;
      await fs.mkdir(destination, { mode: 0o700 });
      const archive = path.join(directory, `${repo}.tar`);
      await git(checkouts[repo].source, ['archive', '--format=tar', `--output=${archive}`, revisions[repo]]);
      await fs.chmod(archive, 0o600);
      await run('tar', ['-xf', archive, '-C', destination], { encoding: 'utf8' });
      await fs.unlink(archive);
      await fs.chmod(destination, 0o700);
      for (const file of ['package.json', 'package-lock.json']) {
        let stat;
        try { stat = await fs.lstat(path.join(destination, file)); } catch { /* report below */ }
        if (!stat || !stat.isFile()) throw new Error(`${repo} requires a regular ${file} for npm ci`);
      }
      for (const name of ['.env', '.env.local']) {
        const source = path.join(checkouts[repo].source, name);
        let stat;
        try { stat = await fs.lstat(source); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!stat) {
          if (name === '.env') throw new Error(`${repo}/.env is missing; configure source environments before preparing an update`);
          continue;
        }
        if (!stat.isFile()) throw new Error(`${repo}/${name} must be a regular private file, not a symlink`);
        await fs.writeFile(path.join(destination, name), await fs.readFile(source), { mode: 0o600, flag: 'wx' });
        await fs.chmod(path.join(destination, name), 0o600);
      }
    }
    // All stages have been validated before running any package installation.
    for (const repo of repos) {
      await run('npm', ['ci'], { cwd: paths[repo], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      await fs.chmod(paths[repo], 0o700);
      for (const name of ['.env', '.env.local']) {
        try { await fs.chmod(path.join(paths[repo], name), 0o600); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (await fingerprint() !== configHash) throw new Error('Configuration changed while preparing; retry after restarting the managed workspace');
    const release = { id, directory, revisions, paths, ...(configHash ? { configHash } : {}) };
    await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify(release, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return release;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function request(root, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath: path.join(root, '.installer', 'runtime.sock'),
      method, path: pathname, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('Supervisor response too large')); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Supervisor ${method} ${pathname} failed (${res.statusCode}): ${text}`));
        try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('Supervisor returned invalid JSON')); }
      });
    });
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('Supervisor request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

const HELP = `Usage: node scripts/update-workspace.cjs --update [--prepare-only]

--update                 Stage frontend (market-fit) and API, then request a managed
                         supervisor update. Workers and database are excluded.
--update --prepare-only  Stage market-fit, API and Workflows without activation;
                         workers require a manual controlled update.
--help                   Show this help.

Requires clean branches with upstreams and package-lock.json; installs with npm ci.
Source checkouts are never switched, reset or merged. Private .env/.env.local are
copied with private permissions; tracked .env* (except *.example) are rejected.
No schema migrations, database updates or automatic installer self-update.
Live updates require the managed supervisor: restart once with managed start.
Health paths are fixed at supervisor start by MAKINARI_FRONTEND_HEALTH_PATH and
MAKINARI_API_HEALTH_PATH (both default '/'); only 2xx is ready. No CLI health switches.
`;

async function cli(args = process.argv.slice(2), options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const output = options.output || console.log;
  const send = options.request || request;
  if ((args.length === 1 && args[0] === '--help') ||
      (args.length === 2 && args[0] === '--update' && args[1] === '--help')) { output(HELP); return; }
  if (!args.includes('--update') || args.some(arg => !['--update', '--prepare-only'].includes(arg)) ||
      new Set(args).size !== args.length) throw new Error('Unknown or invalid arguments. Use --help.');
  const manual = args.includes('--prepare-only');
  if (!manual) {
    try {
      const status = await send(root, 'GET', '/status');
      if (status.managed !== true) throw new Error('Not a managed supervisor');
      if (status.ready === false || status.busy === true) throw new Error('Managed supervisor is not ready or is busy');
    } catch (error) {
      throw new Error(`Managed supervisor unavailable; restart once with managed start before --update. (${error.message})`);
    }
  }
  const release = await prepare(root, manual ? MANUAL_REPOS : LIVE_REPOS, options);
  if (manual) {
    output(`Prepared only (not activated): ${release.directory}\nWorkers require a manual controlled update. No database/schema or installer self-update.`);
  } else {
    await send(root, 'POST', '/update', { release });
    output(`Supervisor accepted update: ${release.id}. Workers, database/schema and installer checkout were not updated.`);
  }
  return release;
}

if (require.main === module) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { prepare, cli, request };