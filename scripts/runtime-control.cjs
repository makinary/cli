'use strict';

// Local supervisor control only: no PID signals, network targets or socket unlinking.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const MAX_BODY = 4096;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function canonicalRoot(root) {
  if (typeof root !== 'string' || !root || Buffer.byteLength(root) > MAX_BODY / 2 ||
      /[\x00-\x1f\x7f]/.test(root) || !path.isAbsolute(root) || path.resolve(root) !== root) {
    throw new Error('Root must be an exact canonical absolute installer directory');
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw new Error('Root must be canonical; symlink aliases are not allowed');
  }
  return root;
}

function controlPath(root) {
  canonicalRoot(root);
  const directory = path.join(root, '.installer');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
      typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    throw new Error('Installer control directory must be owned by the local user, not writable by others and not a symlink');
  }
  return path.join(directory, 'runtime.sock');
}

function socketStat(root, missing = false) {
  const socketPath = controlPath(root);
  let stat;
  try { stat = fs.lstatSync(socketPath); }
  catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Runtime socket must be a non-symlink Unix socket owned by the local user with mode 0600');
  }
  return stat;
}

function sameSocket(left, right) { return !!left && !!right && left.dev === right.dev && left.ino === right.ino; }

function stopBody(value, root, identity) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['root', 'configHash', 'instanceId'].includes(key))) {
    throw new Error('Stop requires an explicit JSON object containing root');
  }
  if (canonicalRoot(value.root) !== root) throw new Error('Stop root does not match this supervisor');
  for (const key of ['configHash', 'instanceId']) {
    if (Object.hasOwn(value, key) && value[key] !== identity[key]) throw new Error(`Stop ${key} does not match this supervisor`);
  }
}

function verifyIdentity(value, root, expected) {
  if (!value || value.managed !== true || value.root !== root || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.configHash) ||
      typeof value.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(value.instanceId) ||
      typeof value.ready !== 'boolean' || typeof value.busy !== 'boolean' || typeof value.closing !== 'boolean') {
    throw new Error('Invalid supervisor identity or root mismatch');
  }
  if (expected && ['root', 'configHash', 'instanceId', 'pid'].some(key => value[key] !== expected[key])) {
    throw new Error('Supervisor identity changed during control operation');
  }
  return value;
}

function request(root, stat, method, route, body) {
  const socketPath = controlPath(root);
  if (!sameSocket(stat, socketStat(root))) throw new Error('Runtime socket changed during control operation');
  const data = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: route, agent: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { const error = new Error('Supervisor response too large'); reject(error); req.destroy(error); }
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== (method === 'POST' ? 202 : 200)) throw new Error(`Supervisor refused ${route} (${res.statusCode})`);
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Supervisor request timed out')), 3000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(data);
  });
}

function listening(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => socket.destroy(new Error('Socket probe timed out')));
  });
}

async function control(command, root, { timeout = 20000 } = {}) {
  if (!['status', 'stop'].includes(command)) throw new Error('Command must be status or stop');
  canonicalRoot(root);
  const stat = socketStat(root);
  const status = verifyIdentity(await request(root, stat, 'GET', '/status'), root);
  if (command === 'status') {
    if (!sameSocket(stat, socketStat(root))) throw new Error('Runtime socket changed during status');
    return status;
  }
  const accepted = verifyIdentity(await request(root, stat, 'POST', '/stop', {
    root, configHash: status.configHash, instanceId: status.instanceId,
  }), root, status);
  if (accepted.accepted !== true || accepted.closing !== true) throw new Error('Supervisor did not confirm stop acceptance');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = socketStat(root, true);
    if (current && !sameSocket(stat, current)) throw new Error('Runtime socket replaced while waiting for stop');
    if (!await listening(controlPath(root))) {
      const after = socketStat(root, true);
      if (after && !sameSocket(stat, after)) throw new Error('Runtime socket replaced while waiting for stop');
      return { ...accepted, stopped: true };
    }
    await sleep(50);
  }
  throw new Error('Stop accepted but supervisor socket is still listening; no processes were signalled or sockets removed by this helper');
}

async function cli(args = process.argv.slice(2), { output = console.log } = {}) {
  if (args.length !== 3 || !['status', 'stop'].includes(args[0]) || args[1] !== '--root') {
    throw new Error('Usage: node scripts/runtime-control.cjs status|stop --root /canonical/absolute/installer/root');
  }
  const result = await control(args[0], args[2]);
  output(JSON.stringify(result));
  return result;
}

if (require.main === module) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { canonicalRoot, controlPath, socketStat, stopBody, control, cli, MAX_BODY };