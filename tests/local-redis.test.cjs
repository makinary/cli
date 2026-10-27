const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareLocalRedis, redisValues, composeSpec, materialize, waitForRest } = require('../scripts/local-redis.cjs');
const { validate, groups } = require('../scripts/credential-catalog.cjs');
const { serviceValues } = require('../scripts/workspace-config.cjs');

function config() {
  const values = {};
  for (const [i, [key]] of groups.find(g => g.id === 'internal').fields.entries()) values[key] = `${i}`.repeat(64);
  return prepareLocalRedis({ redis: 'local', database: 'local', temporal: 'local', features: [],
    ports: { frontend: 3000, api: 3001, workflows: 3002 }, values });
}
test('local mode generates independent credentials without external provider keys', () => {
  const c = config();
  expect(validate(c)).toEqual([]);
  expect(new Set([c.localRedis.cachePassword, c.localRedis.streamsPassword, c.localRedis.restToken]).size).toBe(3);
  const original = { ...c.localRedis };
  prepareLocalRedis(c);
  expect(c.localRedis).toEqual(original);
});
test('switching to local discards external Redis configuration', () => {
  const c = config(); c.values.REDIS_CACHE_URL = 'rediss://old.invalid';
  expect(validate(c).join()).toMatch(/retain external/);
  prepareLocalRedis(c);
  expect(c.values.REDIS_CACHE_URL).toBeUndefined();
});
test('loopback TCP and REST credentials map correctly to both consumers', () => {
  const c = config(); const v = redisValues(c); const out = serviceValues(c);
  expect(v.REDIS_CACHE_URL).toContain('@127.0.0.1:6379');
  expect(v.REDIS_STREAMS_URL).toContain('@127.0.0.1:6380');
  expect(out.API.CACHE_UPSTASH_REDIS_REST_URL).toBe('http://127.0.0.1:8079');
  expect(out['market-fit'].REDIS_URL).toBe(`http://default:${c.localRedis.restToken}@127.0.0.1:8079`);
});
test('real Redis containers have persistence, authentication, loopback bindings and REST adapter', () => {
  const c = config(); const spec = composeSpec(c);
  expect(spec.services.cache.image).toBe('redis:7.4-alpine');
  expect(spec.services.streams.ports).toEqual(['127.0.0.1:6380:6379']);
  expect(spec.services.cache.healthcheck.test).toEqual(['CMD', 'redis-cli', 'ping']);
  expect(spec.services.rest.environment.SRH_TOKEN).toBe(c.localRedis.restToken);
  expect(spec.services.rest.environment.SRH_CONNECTION_STRING).toContain('@cache:6379');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-redis-'));
  try {
    const file = materialize(root, c);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(path.dirname(file), 'cache-data.conf')).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(path.dirname(file), 'cache-data.conf'), 'utf8')).toContain('maxmemory-policy allkeys-lru');
    expect(fs.readFileSync(path.join(path.dirname(file), 'streams-data.conf'), 'utf8')).toContain('maxmemory-policy noeviction');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('local ports and credential shape are validated', () => {
  const c = config(); c.localRedis.restPort = 3000;
  expect(validate(c).join()).toMatch(/ports/);
  c.localRedis.restToken = 'short';
  expect(validate(c).join()).toMatch(/restToken/);
});
test('REST readiness checks authenticated real PING responses and fails closed', async () => {
  const c = config();
  const fetcher = jest.fn(async () => ({ ok: true, json: async () => ({ result: 'PONG' }) }));
  await waitForRest(c, fetcher, 1);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${c.localRedis.restToken}`);
  expect(fetcher.mock.calls[0][1].body).toBe('["PING"]');
  await expect(waitForRest(c, async () => ({ ok: false }), 1)).rejects.toThrow(/readiness failed/);
});