const net = require('node:net');

function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

// Workers still perform the real Temporal handshake. This admission barrier only
// prevents starting them before our local server binds its transport socket.
async function waitForLocalTemporal(target, cancelled = () => false, { port = 7233, timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cancelled() || target.exited) throw new Error('Local Temporal startup interrupted');
    if (await listening(port)) {
      if (cancelled() || target.exited) throw new Error('Local Temporal startup interrupted');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local Temporal did not become available before startup timeout');
}

module.exports = { waitForLocalTemporal };