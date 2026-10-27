const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareConfig, stage } = require('../scripts/prepare-qa.cjs');

function sources() {
  return { 'market-fit': { STRIPE_SECRET_KEY: 'sk_test_synthetic', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic',
    STRIPE_WEBHOOK_SECRET: 'whsec_front', SUPABASE_SERVICE_ROLE_KEY: 'production-db-key', SERVICE_API_KEY: 'production-service',
    SENDGRID_API_KEY: 'production-email' }, API: { OPENROUTER_API_KEY: 'synthetic-openrouter',
    STRIPE_WEBHOOK_SECRET: 'whsec_api', REDIS_URL: 'rediss://production', VISITOR_SESSION_TOKEN_SECRET: 'production-signing' },
  Workflows: { SUPABASE_URL: 'https://production.supabase.co', TEMPORAL_API_KEY: 'production-temporal' } };
}
test('imports only eligible provider credentials and generates isolated infrastructure/secrets', () => {
  const { config } = prepareConfig(sources());
  expect(config.features).toEqual(['openrouter', 'stripe']);
  expect(config.values.API_STRIPE_WEBHOOK_SECRET).toBe('whsec_api');
  expect(config.values.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  expect(config.values.SENDGRID_API_KEY).toBeUndefined();
  expect(config.values.SERVICE_API_KEY).not.toBe('production-service');
  expect(config.values.TEMPORAL_API_KEY).toBeUndefined();
  expect(config.redis).toBe('local');
  expect(config.database).toBe('local');
});
test('never enables live Stripe or incomplete Azure credentials', () => {
  const input = sources(); input['market-fit'].STRIPE_SECRET_KEY = 'sk_live_rejected';
  input.API.MICROSOFT_AZURE_OPENAI_API_KEY = 'incomplete';
  const { config, excluded } = prepareConfig(input);
  expect(config.features).toEqual(['openrouter']);
  expect(config.values.STRIPE_SECRET_KEY).toBeUndefined();
  expect(excluded.map(e => e.feature)).toContain('azure');
});
test('stages private config with honest blocked manifest and no inherited production secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-qa-'));
  try {
    const { dir, manifest } = stage(root, sources(), { id: 'qa-test' });
    expect(manifest.state).toBe('configuration-staged-not-running');
    expect(manifest.safety.mutationsEnabled).toBe(false);
    const env = fs.readFileSync(path.join(dir, 'API', '.env'), 'utf8');
    expect(env).not.toContain('production');
    expect(env).toContain('127.0.0.1');
    expect(fs.statSync(path.join(dir, '.installer', 'credentials.json')).mode & 0o777).toBe(0o600);
    expect(() => stage(root, sources(), { id: 'qa-test' })).toThrow(/already exists/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});