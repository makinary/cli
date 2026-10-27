const groups = [
  { id: 'supabase', label: 'Supabase (required; local keys are discovered at startup)', fields: [
    ['SUPABASE_URL', 'API origin', false, 'origin'],
    ['SUPABASE_ANON_KEY', 'Publishable / anon key (never service role)', true, 'publicKey'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'Server-only secret / service-role key', true, 'serviceKey'],
  ] },
  { id: 'internal', label: 'Internal authentication and encryption (required; generated for new local workspaces)', fields: [
    ['SERVICE_API_KEY', 'Shared API / worker service key', true, 'secret'],
    ['ENCRYPTION_KEY', 'Persistent encryption secret; do not rotate on reinstall', true, 'secret'],
    ['CRON_SECRET', 'API cron authentication', true, 'secret'],
    ['VISITOR_SESSION_TOKEN_SECRET', 'Visitor session signing secret', true, 'secret'],
    ['VISITOR_IDENTITY_SIGNING_SECRET', 'Independent visitor identity signing secret', true, 'secret'],
    ['PUBLIC_MEDIA_SIGNING_SECRET', 'Independent public media signing secret', true, 'secret'],
  ] },
  { id: 'redis', label: 'External Redis (optional instead of automatically created local Redis; TCP + compatible REST)', fields: [
    ['REDIS_CACHE_URL', 'Cache Redis rediss:// URL including password', true, 'redis'],
    ['CACHE_UPSTASH_REDIS_REST_URL', 'Cache REST endpoint', false, 'upstashOrigin'],
    ['CACHE_UPSTASH_REDIS_REST_TOKEN', 'Cache REST token', true, 'credential'],
    ['REDIS_STREAMS_URL', 'Dedicated no-eviction streams Redis rediss:// URL', true, 'redis'],
  ] },
  { id: 'temporal', label: 'Temporal Cloud (required only when local Temporal is disabled)', fields: [
    ['TEMPORAL_SERVER_URL', 'Temporal host:port', false, 'host'],
    ['TEMPORAL_NAMESPACE', 'Temporal namespace', false, 'credential'],
    ['TEMPORAL_API_KEY', 'Temporal Cloud API key', true, 'credential'],
  ] },
  { id: 'openrouter', label: 'OpenRouter: chat, embeddings and video (required when enabled)', fields: [
    ['OPENROUTER_API_KEY', 'OpenRouter API key', true, 'credential'],
  ] },
  { id: 'azure', label: 'Azure: image generation, transcription and web search (required when enabled)', fields: [
    ['MICROSOFT_AZURE_OPENAI_ENDPOINT', 'Azure resource endpoint', false, 'origin'],
    ['MICROSOFT_AZURE_OPENAI_API_KEY', 'Azure resource key', true, 'credential'],
    ['AZURE_OPENAI_IMAGE_DEPLOYMENT', 'Existing image deployment', false, 'credential'],
    ['AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT', 'Existing transcription deployment', false, 'credential'],
    ['MICROSOFT_AZURE_OPENAI_DEPLOYMENT', 'Existing web-search-capable reasoning deployment', false, 'credential'],
  ] },
  { id: 'speech', label: 'Azure TTS (dedicated resource; required when enabled)', fields: [
    ['AZURE_TTS_ENDPOINT', 'Azure TTS resource endpoint', false, 'origin'],
    ['AZURE_TTS_API_KEY', 'Azure TTS resource key', true, 'credential'],
    ['AZURE_TTS_DEPLOYMENT', 'Existing TTS deployment', false, 'credential'],
  ] },
  { id: 'stripe', label: 'Stripe payments and billing (required when enabled; test credentials only)', fields: [
    ['STRIPE_SECRET_KEY', 'Stripe test secret / restricted key', true, 'stripeSecret'],
    ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'Stripe test publishable key', false, 'stripePublic'],
    ['STRIPE_WEBHOOK_SECRET', 'Frontend webhook signing secret', true, 'webhook'],
    ['API_STRIPE_WEBHOOK_SECRET', 'API webhook signing secret (separate endpoint)', true, 'webhook'],
  ] },
  { id: 'email', label: 'SendGrid transactional email (required when enabled; use a test sender)', fields: [
    ['SENDGRID_API_KEY', 'SendGrid API key', true, 'credential'],
    ['SENDGRID_FROM_EMAIL', 'Verified sender email', false, 'email'],
  ] },
];

const optional = ['openrouter', 'azure', 'speech', 'stripe', 'email'];
function activeGroups(config) {
  return groups.filter(g => g.id === 'internal'
    || (g.id === 'redis' && (config.redis || 'external') === 'external')
    || (g.id === 'supabase' && config.database === 'cloud')
    || (g.id === 'temporal' && config.temporal === 'cloud')
    || (config.features || []).includes(g.id));
}
function valid(value, type) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n`$]/.test(value)
      || /^(?:dummy|sk-dummy|your[_-]|placeholder)/i.test(value)) return false;
  if (type === 'secret') return Buffer.byteLength(value) >= 32;
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (type === 'stripeSecret') return /^(sk|rk)_test_\S+$/.test(value);
  if (type === 'stripePublic') return /^pk_test_\S+$/.test(value);
  if (type === 'webhook') return /^whsec_\S+$/.test(value);
  if (type === 'host') return /^[a-zA-Z0-9.-]+:\d+$/.test(value);
  if (['origin', 'upstashOrigin', 'redis'].includes(type)) {
    try {
      const u = new URL(value);
      if (u.search || u.hash || !['', '/'].includes(u.pathname)) return false;
      if (type === 'redis') return u.protocol === 'rediss:' && Boolean(u.password);
      if (u.username || u.password) return false;
      if (type === 'upstashOrigin') return u.protocol === 'https:';
      return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));
    } catch { return false; }
  }
  if (['publicKey', 'serviceKey'].includes(type)) {
    if (value.startsWith(type === 'publicKey' ? 'sb_publishable_' : 'sb_secret_')) return true;
    try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url')).role === (type === 'publicKey' ? 'anon' : 'service_role'); }
    catch { return false; }
  }
  return true;
}
function validate(config, { localKeys = false } = {}) {
  const errors = [];
  if (!['local', 'cloud'].includes(config.database)) errors.push('database must be local or cloud');
  if (!['local', 'cloud'].includes(config.temporal)) errors.push('temporal must be local or cloud');
  if (!['local', 'external'].includes(config.redis || 'external')) errors.push('redis must be local or external');
  if (config.redis === 'local') {
    const r = config.localRedis || {};
    const ports = [r.cachePort, r.streamsPort, r.restPort, ...Object.values(config.ports || {}), 54320, 54321, 54322, 54323, 7233, 8080];
    if ([r.cachePort, r.streamsPort, r.restPort].some(p => !Number.isInteger(p) || p < 1024 || p > 65535)
        || new Set(ports).size !== ports.length) errors.push('Local Redis ports must be valid, distinct and not conflict with service ports');
    for (const key of ['cachePassword', 'streamsPassword', 'restToken']) {
      if (!/^[a-f0-9]{64}$/.test(r[key] || '')) errors.push(`localRedis.${key}: requires 32 random bytes encoded as hex`);
    }
    if (new Set([r.cachePassword, r.streamsPassword, r.restToken]).size !== 3) errors.push('Local Redis credentials must be independent');
    if (groups.find(g => g.id === 'redis').fields.some(([k]) => config.values?.[k])) errors.push('Local Redis must not retain external credentials');
  }
  if (!Array.isArray(config.features) || config.features.some(f => !optional.includes(f))) errors.push('Invalid enabled features');
  if (!config.ports || Object.keys(config.ports).sort().join(',') !== 'api,frontend,workflows'
      || Object.values(config.ports).some(p => !Number.isInteger(p) || p < 1024 || p > 65535)
      || new Set(Object.values(config.ports || {})).size !== 3) errors.push('Three distinct service ports (1024-65535) are required');
  const selected = activeGroups(config);
  if (localKeys && config.database === 'local') selected.push(groups[0]);
  for (const group of selected) for (const [key, , , type] of group.fields) {
    if (!valid(config.values?.[key], type)) errors.push(`${key}: missing or invalid (${type})`);
  }
  const secrets = groups.find(g => g.id === 'internal').fields.map(([k]) => config.values?.[k]).filter(Boolean);
  if (new Set(secrets).size !== secrets.length) errors.push('Internal signing/encryption secrets must be independent');
  const v = config.values || {};
  if (config.database === 'local' && v.SUPABASE_URL) {
    try {
      if (!['127.0.0.1', 'localhost'].includes(new URL(v.SUPABASE_URL).hostname)) errors.push('Local Supabase must use a loopback origin');
    } catch { errors.push('Invalid local Supabase origin'); }
  }
  if ((config.redis || 'external') === 'external' && v.REDIS_CACHE_URL && v.REDIS_STREAMS_URL) {
    try {
      if (new URL(v.REDIS_CACHE_URL).host === new URL(v.REDIS_STREAMS_URL).host) errors.push('Cache and streams require separate Redis endpoints');
      if (new URL(v.REDIS_CACHE_URL).hostname.endsWith('.upstash.io')
          && new URL(v.REDIS_CACHE_URL).hostname !== new URL(v.CACHE_UPSTASH_REDIS_REST_URL).hostname) errors.push('Cache TCP and REST hosts must match');
    } catch { /* Field validation reports malformed URLs without printing secrets. */ }
  }
  return errors;
}
module.exports = { groups, optional, activeGroups, valid, validate };