const fs = require('node:fs');
const path = require('node:path');
const { validate, groups } = require('./credential-catalog.cjs');
const { redisValues } = require('./local-redis.cjs');

const configPath = root => path.join(root, '.installer', 'credentials.json');
function load(root) {
  const file = configPath(root);
  if (!fs.existsSync(file)) throw new Error('Run ./install.sh --configure first (or provide an installer config).');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(root, config) {
  const errors = validate(config);
  if (errors.length) throw new Error(errors.join('\n'));
  fs.mkdirSync(path.dirname(configPath(root)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(root), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configPath(root), 0o600);
}
function writeEnv(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n`$]/.test(String(value))) throw new Error(`Invalid environment entry: ${key}`);
    // Next expands $ even inside quotes. Reject it; URL passwords must be percent-encoded.
    const line = `${key}=\`${value}\``;
    const pattern = new RegExp(`^[ \\t]*(?:export\\s+)?${key}[ \\t]*=.*$`, 'gm');
    text = text.replace(pattern, '').replace(/\n?$/, '\n') + line + '\n';
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function serviceValues(config) {
  const v = { ...config.values, ...redisValues(config) };
  if (config.database === 'local' && v.SUPABASE_URL
      && !['127.0.0.1', 'localhost'].includes(new URL(v.SUPABASE_URL).hostname)) {
    throw new Error('Local configuration must not contain remote Supabase credentials');
  }
  const app = `http://127.0.0.1:${config.ports.frontend}`;
  const api = `http://127.0.0.1:${config.ports.api}`;
  const workflows = `http://127.0.0.1:${config.ports.workflows}`;
  const shared = {
    NEXT_PUBLIC_SUPABASE_URL: v.SUPABASE_URL || '', NEXT_PUBLIC_SUPABASE_ANON_KEY: v.SUPABASE_ANON_KEY || '',
    SUPABASE_SERVICE_ROLE_KEY: v.SUPABASE_SERVICE_ROLE_KEY || '',
    SERVICE_API_KEY: v.SERVICE_API_KEY, ENCRYPTION_KEY: v.ENCRYPTION_KEY,
    NEXT_PUBLIC_APP_URL: app, API_SERVER_URL: api, NEXT_PUBLIC_API_SERVER_URL: api,
    API_BASE_URL: api, WORKFLOWS_API_URL: workflows,
    TEMPORAL_SERVER_URL: config.temporal === 'local' ? '127.0.0.1:7233' : v.TEMPORAL_SERVER_URL,
    TEMPORAL_NAMESPACE: config.temporal === 'local' ? 'default' : v.TEMPORAL_NAMESPACE,
    TEMPORAL_TLS: String(config.temporal === 'cloud'),
  };
  const frontend = { ...shared, PORT: config.ports.frontend, REDIS_REQUIRED: 'true',
    REDIS_URL: `${new URL(v.CACHE_UPSTASH_REDIS_REST_URL).protocol}//default:${encodeURIComponent(v.CACHE_UPSTASH_REDIS_REST_TOKEN)}@${new URL(v.CACHE_UPSTASH_REDIS_REST_URL).host}` };
  const backend = { ...shared, PORT: config.ports.api, CRON_SECRET: v.CRON_SECRET,
    REDIS_URL: v.REDIS_CACHE_URL, REDIS_CACHE_URL: v.REDIS_CACHE_URL, REDIS_STREAMS_URL: v.REDIS_STREAMS_URL,
    CACHE_UPSTASH_REDIS_REST_URL: v.CACHE_UPSTASH_REDIS_REST_URL, CACHE_UPSTASH_REDIS_REST_TOKEN: v.CACHE_UPSTASH_REDIS_REST_TOKEN,
    UPSTASH_REDIS_REST_URL: v.CACHE_UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN: v.CACHE_UPSTASH_REDIS_REST_TOKEN,
    VISITOR_SESSION_TOKEN_SECRET: v.VISITOR_SESSION_TOKEN_SECRET, VISITOR_IDENTITY_SIGNING_SECRET: v.VISITOR_IDENTITY_SIGNING_SECRET,
    PUBLIC_MEDIA_SIGNING_SECRET: v.PUBLIC_MEDIA_SIGNING_SECRET, TEMPORAL_ENV: config.temporal === 'local' ? 'development' : 'production',
    TEMPORAL_CLOUD_API_KEY: config.temporal === 'cloud' ? v.TEMPORAL_API_KEY : '',
  };
  const worker = { ...shared, PORT: config.ports.workflows, SUPABASE_URL: v.SUPABASE_URL || '',
    SUPABASE_KEY: v.SUPABASE_SERVICE_ROLE_KEY || '', API_KEY: v.SERVICE_API_KEY,
    TEMPORAL_API_KEY: config.temporal === 'cloud' ? v.TEMPORAL_API_KEY : '', WORKFLOW_TASK_QUEUE: 'default' };
  for (const group of groups.filter(g => ['openrouter', 'azure', 'speech'].includes(g.id))) {
    for (const [key] of group.fields) backend[key] = config.features.includes(group.id) ? v[key] : '';
  }
  // Dedicated aliases take precedence in the API. Remove stale overrides when selecting the shared pair.
  for (const key of ['AZURE_OPENAI_IMAGE_ENDPOINT', 'AZURE_OPENAI_IMAGE_API_KEY',
    'AZURE_OPENAI_TRANSCRIPTION_ENDPOINT', 'AZURE_OPENAI_TRANSCRIPTION_API_KEY',
    'AZURE_OPENAI_SEARCH_ENDPOINT', 'AZURE_OPENAI_SEARCH_API_KEY', 'AZURE_OPENAI_SEARCH_DEPLOYMENT',
    'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT']) backend[key] = '';
  // API adapters interpret present-but-empty dedicated pairs as invalid; remove these entries on disk instead.
  for (const key of ['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    frontend[key] = config.features.includes('stripe') ? v[key] : '';
  }
  backend.STRIPE_SECRET_KEY = frontend.STRIPE_SECRET_KEY;
  backend.STRIPE_WEBHOOK_SECRET = config.features.includes('stripe') ? v.API_STRIPE_WEBHOOK_SECRET : '';
  for (const key of ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL']) {
    frontend[key] = backend[key] = config.features.includes('email') ? v[key] : '';
  }
  return { 'market-fit': frontend, API: backend, Workflows: worker };
}
function apply(root, config, { requireLocalKeys = false } = {}) {
  const errors = validate(config, { localKeys: requireLocalKeys });
  if (errors.length) throw new Error(errors.join('\n'));
  const entries = serviceValues(config);
  // Next loads .env.local before .env. Refuse conflicting overrides instead of silently using stale secrets.
  for (const [repo, values] of Object.entries(entries)) {
    const override = path.join(root, repo, '.env.local');
    if (fs.existsSync(override)) {
      const text = fs.readFileSync(override, 'utf8');
      if (Object.keys(values).some(k => new RegExp(`^[ \\t]*(?:export\\s+)?${k}[ \\t]*(?:=|:)`, 'm').test(text))) {
        throw new Error(`${repo}/.env.local overrides installer-managed variables; review/remove conflicting entries before configuring.`);
      }
    }
    if (!fs.existsSync(path.join(root, repo))) throw new Error(`Missing service repository: ${repo}`);
  }
  for (const [repo, values] of Object.entries(entries)) {
    const file = path.join(root, repo, '.env');
    const removals = Object.keys(values).filter(k => /^(?:AZURE_|MICROSOFT_AZURE_)/.test(k) && values[k] === '');
    if (fs.existsSync(file)) {
      let text = fs.readFileSync(file, 'utf8');
      for (const key of removals) text = text.replace(new RegExp(`^[ \\t]*(?:export\\s+)?${key}[ \\t]*=.*(?:\\n|$)`, 'gm'), '');
      fs.writeFileSync(file, text, { mode: 0o600 });
    }
    const writable = Object.fromEntries(Object.entries(values).filter(([k]) => !removals.includes(k)));
    writeEnv(file, writable);
  }
}
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const config = load(root);
    if (process.argv.includes('--supabase-status')) {
      const status = JSON.parse(fs.readFileSync(0, 'utf8'));
      config.values.SUPABASE_URL = status.API_URL;
      config.values.SUPABASE_ANON_KEY = status.ANON_KEY || status.PUBLISHABLE_KEY;
      config.values.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY || status.SECRET_KEY;
      if (config.database !== 'local' || !['127.0.0.1', 'localhost'].includes(new URL(status.API_URL).hostname)) {
        throw new Error('Local Supabase discovery requires a loopback instance and local database mode');
      }
      apply(root, config, { requireLocalKeys: true });
      save(root, config);
    } else if (process.argv.includes('--apply')) apply(root, config);
    else {
      const errors = validate(config);
      if (errors.length) throw new Error(errors.join('\n'));
      console.log('Credential configuration valid (format only; provider availability not verified).');
    }
  } catch (error) { console.error(error instanceof SyntaxError ? 'Invalid installer configuration JSON' : error.message); process.exitCode = 1; }
}
module.exports = { load, save, writeEnv, serviceValues, apply, configPath };