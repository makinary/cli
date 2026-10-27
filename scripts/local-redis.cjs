const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const redisKeys = ['REDIS_CACHE_URL', 'REDIS_STREAMS_URL', 'CACHE_UPSTASH_REDIS_REST_URL', 'CACHE_UPSTASH_REDIS_REST_TOKEN'];
function redisMode(config) { return config.redis || 'external'; }
function prepareLocalRedis(config, random = () => crypto.randomBytes(32).toString('hex')) {
  if (redisMode(config) !== 'local') return config;
  const old = config.localRedis || {};
  config.localRedis = { cachePort: old.cachePort || 6379, streamsPort: old.streamsPort || 6380,
    restPort: old.restPort || 8079, cachePassword: old.cachePassword || random(),
    streamsPassword: old.streamsPassword || random(), restToken: old.restToken || random() };
  for (const key of redisKeys) delete config.values[key];
  return config;
}
function redisValues(config) {
  if (redisMode(config) !== 'local') return config.values;
  const r = config.localRedis;
  return { REDIS_CACHE_URL: `redis://default:${encodeURIComponent(r.cachePassword)}@127.0.0.1:${r.cachePort}`,
    REDIS_STREAMS_URL: `redis://default:${encodeURIComponent(r.streamsPassword)}@127.0.0.1:${r.streamsPort}`,
    CACHE_UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${r.restPort}`, CACHE_UPSTASH_REDIS_REST_TOKEN: r.restToken };
}
function composeSpec(config) {
  const r = config.localRedis;
  const redis = (port, password, policy, volume) => ({ image: 'redis:7.4-alpine',
    ports: [`127.0.0.1:${port}:6379`], environment: { REDISCLI_AUTH: password },
    volumes: [`${volume}:/data`, `./${volume}.conf:/usr/local/etc/redis/redis.conf:ro`],
    command: ['redis-server', '/usr/local/etc/redis/redis.conf'],
    healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '2s', retries: 30 },
    labels: { 'makinari.redis.role': policy }, restart: 'unless-stopped' });
  return { services: {
    cache: redis(r.cachePort, r.cachePassword, 'cache', 'cache-data'),
    streams: redis(r.streamsPort, r.streamsPassword, 'streams', 'streams-data'),
    rest: { image: 'hiett/serverless-redis-http:latest', ports: [`127.0.0.1:${r.restPort}:80`],
      environment: { SRH_MODE: 'env', SRH_TOKEN: r.restToken,
        SRH_CONNECTION_STRING: `redis://default:${encodeURIComponent(r.cachePassword)}@cache:6379` },
      depends_on: { cache: { condition: 'service_healthy' } }, restart: 'unless-stopped' },
  }, volumes: { 'cache-data': {}, 'streams-data': {} } };
}
function materialize(root, config) {
  const dir = path.join(root, '.installer', 'redis');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, password, policy, memory] of [
    ['cache-data', config.localRedis.cachePassword, 'allkeys-lru', '256mb'],
    ['streams-data', config.localRedis.streamsPassword, 'noeviction', '512mb'],
  ]) {
    const file = path.join(dir, `${name}.conf`);
    // Official Redis drops to its container user. The containing host directory stays private (0700).
    fs.writeFileSync(file, `bind 0.0.0.0\nprotected-mode yes\nrequirepass ${password}\nappendonly yes\nmaxmemory ${memory}\nmaxmemory-policy ${policy}\n`, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
  }
  const file = path.join(dir, 'compose.json');
  fs.writeFileSync(file, JSON.stringify(composeSpec(config), null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
async function waitForRest(config, fetcher = fetch, attempts = 60) {
  const v = redisValues(config);
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetcher(v.CACHE_UPSTASH_REDIS_REST_URL, { method: 'POST',
        headers: { Authorization: `Bearer ${v.CACHE_UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['PING']), signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).result === 'PONG') return;
    } catch { /* Only a bounded availability check; never log provider payloads or credentials. */ }
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Local Redis REST readiness failed; inspect private container logs.');
}
async function main() {
  const { load } = require('./workspace-config.cjs');
  const { validate } = require('./credential-catalog.cjs');
  const root = path.resolve(__dirname, '..');
  const config = load(root);
  const errors = validate(config);
  if (errors.length) throw new Error(errors.join('\n'));
  if (redisMode(config) !== 'local') { console.log('External Redis selected; no local Redis containers are managed.'); return; }
  const action = process.argv[2] || 'start';
  if (!['start', 'stop'].includes(action)) throw new Error('Usage: local-redis.cjs [start|stop]');
  const project = `makinari-redis-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  const file = materialize(root, config);
  const args = ['compose', '-p', project, '-f', file, ...(action === 'start' ? ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120'] : ['stop'])];
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180000 });
  if (result.status !== 0) throw new Error('Local Redis Docker Compose failed. Check Docker/Compose and port availability; raw output suppressed to protect credentials.');
  if (action === 'start') await waitForRest(config);
  console.log(`Local Redis ${action === 'start' ? 'ready: cache, durable streams and authenticated REST adapter' : 'stopped; volumes preserved'}.`);
}
module.exports = { redisMode, prepareLocalRedis, redisValues, composeSpec, materialize, waitForRest, redisKeys };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });