const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { groups, validate, valid } = require('../scripts/credential-catalog.cjs');
const { serviceValues, apply, writeEnv, save } = require('../scripts/workspace-config.cjs');

function fixture() {
  const values = {};
  for (const [i, [key]] of groups.find(g => g.id === 'internal').fields.entries()) values[key] = `secret-${i}-` + 'a'.repeat(40);
  Object.assign(values, { REDIS_CACHE_URL: 'rediss://default:tcp-password@cache-test.upstash.io:6379',
    CACHE_UPSTASH_REDIS_REST_URL: 'https://cache-test.upstash.io', CACHE_UPSTASH_REDIS_REST_TOKEN: 'rest-token',
    REDIS_STREAMS_URL: 'rediss://default:other-password@streams-test.upstash.io:6379' });
  return { database: 'local', temporal: 'local', ports: { frontend: 3000, api: 3001, workflows: 3002 }, features: [], values };
}
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'makinari-installer-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('core config requires Redis, independent secrets and named distinct ports', () => {
  const c = fixture();
  expect(validate(c)).toEqual([]);
  c.ports = { x: 3000, y: 3001, z: 3002 };
  expect(validate(c).join()).toMatch(/ports/);
  c.ports = { frontend: 3000, api: 3000, workflows: 3002 };
  expect(validate(c).join()).toMatch(/ports/);
  delete c.values.REDIS_STREAMS_URL;
  expect(validate(c).join()).toMatch(/REDIS_STREAMS_URL/);
});
test('cache and streams are isolated and cache TCP/REST hosts match', () => {
  const c = fixture();
  c.values.REDIS_STREAMS_URL = c.values.REDIS_CACHE_URL;
  c.values.CACHE_UPSTASH_REDIS_REST_URL = 'https://wrong.upstash.io';
  expect(validate(c).join()).toMatch(/separate Redis/);
  expect(validate(c).join()).toMatch(/hosts must match/);
});
test.each(['openrouter', 'azure', 'speech', 'stripe', 'email'])('%s fields are mandatory only when enabled', feature => {
  const c = fixture();
  expect(validate(c)).toEqual([]);
  c.features = [feature];
  for (const [key] of groups.find(g => g.id === feature).fields) expect(validate(c).join()).toContain(key);
});
test('rejects live Stripe, dummy, interpolation and public service-role keys', () => {
  expect(valid('sk_live_no', 'stripeSecret')).toBe(false);
  expect(valid('pk_live_no', 'stripePublic')).toBe(false);
  expect(valid('sk_test_synthetic', 'stripeSecret')).toBe(true);
  expect(valid('dummy-value', 'credential')).toBe(false);
  expect(valid('abc$UNSET', 'credential')).toBe(false);
  expect(valid('sb_secret_synthetic', 'publicKey')).toBe(false);
  expect(valid('sb_publishable_synthetic', 'publicKey')).toBe(true);
});
test('cloud requires database and Temporal credentials', () => {
  const c = fixture(); c.database = c.temporal = 'cloud';
  expect(validate(c).join()).toMatch(/SUPABASE_ANON_KEY/);
  expect(validate(c).join()).toMatch(/TEMPORAL_API_KEY/);
});
test('routes credentials to the actual service variables without browser secrets', () => {
  const c = fixture(); Object.assign(c.values, { SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'sb_publishable_synthetic', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_synthetic' });
  const out = serviceValues(c);
  expect(out.Workflows.API_KEY).toBe(c.values.SERVICE_API_KEY);
  expect(out.Workflows.SUPABASE_KEY).toBe(c.values.SUPABASE_SERVICE_ROLE_KEY);
  expect(out.API.REDIS_STREAMS_URL).toBe(c.values.REDIS_STREAMS_URL);
  expect(out['market-fit'].REDIS_URL).toContain('https://default:rest-token@cache-test.upstash.io');
  expect(out.API.CACHE_UPSTASH_REDIS_REST_TOKEN).toBe('rest-token');
  for (const values of Object.values(out)) {
    expect(Object.keys(values).filter(k => k.startsWith('NEXT_PUBLIC_'))).not.toContain('NEXT_PUBLIC_API_KEY');
    expect(Object.keys(values).filter(k => k.startsWith('NEXT_PUBLIC_'))).not.toContain('NEXT_PUBLIC_SERVICE_API_KEY');
  }
});
test('local credentials cannot silently retain cloud database access', () => {
  const c = fixture(); c.values.SUPABASE_URL = 'https://example.supabase.co';
  expect(() => serviceValues(c)).toThrow(/remote Supabase/);
});
test('writes absent env keys, removes duplicate entries, retains unrelated settings and secures files', () => {
  const file = path.join(root, '.env');
  fs.writeFileSync(file, 'UNRELATED=keep\n  SERVICE_API_KEY = old\nSERVICE_API_KEY=old\n');
  writeEnv(file, { SERVICE_API_KEY: 'new#token"\\value' });
  const text = fs.readFileSync(file, 'utf8');
  expect(text).toContain('UNRELATED=keep');
  expect(text).not.toContain('old');
  expect(text.match(/SERVICE_API_KEY=/g)).toHaveLength(1);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(() => writeEnv(file, { SECRET: 'abc$ENV' })).toThrow(/Invalid environment/);
});
test('refuses valid whitespace .env.local overrides before writing any service', () => {
  for (const repo of ['market-fit', 'API', 'Workflows']) fs.mkdirSync(path.join(root, repo));
  fs.writeFileSync(path.join(root, 'API', '.env.local'), '  ENCRYPTION_KEY = stale\n');
  expect(() => apply(root, fixture())).toThrow(/overrides/);
  expect(fs.existsSync(path.join(root, 'market-fit', '.env'))).toBe(false);
});
test('removes stale Azure aliases rather than leaving present-but-empty overrides', () => {
  for (const repo of ['market-fit', 'API', 'Workflows']) fs.mkdirSync(path.join(root, repo));
  const file = path.join(root, 'API', '.env');
  fs.writeFileSync(file, 'AZURE_OPENAI_IMAGE_ENDPOINT=https://stale.invalid\nAZURE_OPENAI_API_KEY=old\nOTHER=keep\n');
  apply(root, fixture());
  expect(fs.readFileSync(file, 'utf8')).not.toMatch(/AZURE_OPENAI_/);
  expect(fs.readFileSync(file, 'utf8')).toContain('OTHER=keep');
});
test('private configuration preserves generated secrets across saves', () => {
  const c = fixture(); save(root, c); save(root, c);
  const file = path.join(root, '.installer', 'credentials.json');
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).values).toEqual(c.values);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
test('env values round-trip in both plain dotenv and the actual Next loader', () => {
  const deps = path.resolve(__dirname, '../../market-fit/node_modules');
  const file = path.join(root, '.env');
  const secret = 'synthetic#"single\'quote\\slash';
  writeEnv(file, { INSTALLER_TEST_SECRET: secret });
  const parsed = require(path.join(deps, 'dotenv')).parse(fs.readFileSync(file));
  expect(parsed.INSTALLER_TEST_SECRET).toBe(secret);
  const next = spawnSync(process.execPath, ['-e', `const {loadEnvConfig}=require(${JSON.stringify(path.join(deps, '@next/env'))}); loadEnvConfig(${JSON.stringify(root)}); process.stdout.write(process.env.INSTALLER_TEST_SECRET);`],
    { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  expect(next.status).toBe(0);
  expect(next.stdout).toBe(secret);
});
test('unattended import fails closed, then writes valid config without leaking secrets', () => {
  fs.cpSync(path.join(__dirname, '../scripts'), path.join(root, 'scripts'), { recursive: true });
  const wizard = path.join(root, 'scripts', 'credential-wizard.cjs');
  const absent = spawnSync(process.execPath, [wizard, '--from-env'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  expect(absent.status).toBe(1);
  expect(absent.stderr).toContain('SERVICE_API_KEY');
  expect(fs.existsSync(path.join(root, '.installer', 'credentials.json'))).toBe(false);
  const c = fixture();
  const complete = spawnSync(process.execPath, [wizard, '--from-env'], {
    env: { PATH: process.env.PATH, MAKINARI_REDIS: 'external', ...c.values }, encoding: 'utf8' });
  expect(complete.status).toBe(0);
  expect(complete.stdout + complete.stderr).not.toContain(c.values.ENCRYPTION_KEY);
  expect(complete.stdout + complete.stderr).not.toContain(c.values.REDIS_STREAMS_URL);
  expect(JSON.parse(fs.readFileSync(path.join(root, '.installer', 'credentials.json'))).values).toEqual(c.values);
});
test('new unattended configuration defaults to generated local Redis without external credentials', () => {
  fs.cpSync(path.join(__dirname, '../scripts'), path.join(root, 'scripts'), { recursive: true });
  const c = fixture();
  const secrets = Object.fromEntries(groups.find(g => g.id === 'internal').fields.map(([k]) => [k, c.values[k]]));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'credential-wizard.cjs'), '--from-env'], {
    env: { PATH: process.env.PATH, ...secrets }, encoding: 'utf8' });
  expect(result.status).toBe(0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.installer', 'credentials.json')));
  expect(saved.redis).toBe('local');
  expect(saved.localRedis.restToken).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.values.REDIS_CACHE_URL).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(saved.localRedis.restToken);
});
test('startup refuses missing config before invoking infrastructure', () => {
  fs.cpSync(path.join(__dirname, '../scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../start-workspace.sh'), path.join(root, 'start-workspace.sh'));
  const result = spawnSync('bash', [path.join(root, 'start-workspace.sh')], {
    env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--configure first');
});