const net = require('node:net');
const { waitForLocalTemporal } = require('../scripts/temporal-readiness.cjs');

test('waits for a delayed local listener before admitting workers', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  let settled = false;
  const waiting = waitForLocalTemporal({ exited: false }, () => false, { port, timeout: 2000 })
    .then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(settled).toBe(false);
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  try { await waiting; expect(settled).toBe(true); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('fails closed when the local child exits or shutdown is requested', async () => {
  await expect(waitForLocalTemporal({ exited: true })).rejects.toThrow('startup interrupted');
  await expect(waitForLocalTemporal({ exited: false }, () => true)).rejects.toThrow('startup interrupted');
});

test('bounds an unavailable transport instead of launching workers', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await expect(waitForLocalTemporal({ exited: false }, () => false, { port, timeout: 200 }))
    .rejects.toThrow('startup timeout');
});