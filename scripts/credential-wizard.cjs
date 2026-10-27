const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { groups, optional, activeGroups, valid, validate } = require('./credential-catalog.cjs');
const { load, save, configPath } = require('./workspace-config.cjs');
const { prepareLocalRedis } = require('./local-redis.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  if (process.argv.includes('--list')) {
    console.log('Redis: local Docker provisioning by default (cache + streams + REST); no external credentials needed.');
    for (const group of groups) {
      console.log(`\n${group.label}`);
      for (const [key, label] of group.fields) console.log(`  ${key}: ${label}`);
    }
    console.log('\nOther integrations remain feature-specific: marketplace OAuth, AgentMail, browser automation, Finder, and email verification.');
    return;
  }
  if (process.argv.includes('--from-env')) {
    let previous = {};
    if (fs.existsSync(configPath(root))) previous = load(root);
    const values = { ...previous.values };
    if ((process.env.MAKINARI_DATABASE || previous.database || 'local') === 'local') {
      for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete values[key];
    }
    for (const group of groups) for (const [key] of group.fields) if (process.env[key] !== undefined) values[key] = process.env[key];
    save(root, prepareLocalRedis({ database: process.env.MAKINARI_DATABASE || previous.database || 'local',
      redis: process.env.MAKINARI_REDIS || (previous.database ? previous.redis || 'external' : 'local'),
      localRedis: previous.localRedis,
      temporal: process.env.MAKINARI_TEMPORAL || previous.temporal || 'local',
      features: process.env.MAKINARI_FEATURES !== undefined ? process.env.MAKINARI_FEATURES.split(',').filter(Boolean) : previous.features || [],
      ports: previous.ports || { frontend: 3000, api: 3001, workflows: 3002 }, values }));
    console.log('Configuration imported; no credentials printed.');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive credentials require a TTY. Use --from-env for Codespaces secrets.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  output.isTTY = true;
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (label, fallback = '', secret = false) => {
    let answer;
    try {
      if (secret) { process.stdout.write(`${label}${fallback ? ' [Enter keeps existing]' : ''}: `); muted = true; }
      answer = await rl.question(secret ? '' : `${label}${fallback ? ` [${fallback}]` : ''}: `);
    } finally { muted = false; if (secret) process.stdout.write('\n'); }
    return answer || fallback;
  };
  const choice = async (label, choices, fallback) => {
    while (true) {
      const result = await ask(`${label} (${choices.join('/')})`, fallback);
      if (choices.includes(result)) return result;
      console.log('Choose one of the listed values.');
    }
  };
  try {
    const previous = fs.existsSync(configPath(root)) ? load(root) : null;
    console.log('Makinari required credentials\nRedis defaults to local Docker cache, streams and authenticated REST. External Redis is optional.');
    console.log('Local database mode does not imply external integrations are disposable. Never use production credentials for QA.');
    const config = { database: await choice('Database', ['local', 'cloud'], previous?.database || 'local'),
      temporal: await choice('Temporal', ['local', 'cloud'], previous?.temporal || 'local'),
      redis: await choice('Redis', ['local', 'external'], previous ? previous.redis || 'external' : 'local'),
      localRedis: previous?.localRedis,
      ports: {}, features: [], values: { ...previous?.values } };
    if (config.database === 'local') {
      for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete config.values[key];
    }
    prepareLocalRedis(config);
    if (config.redis === 'local') {
      console.log('Local Redis credentials generated/preserved privately. Configure its three loopback ports.');
      for (const key of ['cachePort', 'streamsPort', 'restPort']) {
        while (true) {
          const port = Number(await ask(`Redis ${key}`, String(config.localRedis[key])));
          const occupied = [...Object.values(config.ports), 54320, 54321, 54322, 54323, 7233, 8080,
            ...Object.entries(config.localRedis).filter(([k]) => k.endsWith('Port') && k !== key).map(([, v]) => v)];
          if (Number.isInteger(port) && port >= 1024 && port <= 65535 && !occupied.includes(port)) {
            config.localRedis[key] = port; break;
          }
          console.log('Use a valid port not occupied by another service.');
        }
      }
    }
    for (const [service, port] of Object.entries(previous?.ports || { frontend: 3000, api: 3001, workflows: 3002 })) {
      while (true) {
        const number = Number(await ask(`${service} port`, String(port)));
        const redisPorts = config.redis === 'local' ? [config.localRedis.cachePort, config.localRedis.streamsPort, config.localRedis.restPort] : [];
        if (Number.isInteger(number) && number >= 1024 && number <= 65535
            && ![...Object.values(config.ports), ...redisPorts, 54320, 54321, 54322, 54323, 7233, 8080].includes(number)) {
          config.ports[service] = number; break;
        }
        console.log('Use a distinct port between 1024 and 65535.');
      }
    }
    for (const id of optional) {
      if (await choice(`Enable ${groups.find(g => g.id === id).label}`, ['y', 'n'], previous?.features.includes(id) ? 'y' : 'n') === 'y') config.features.push(id);
    }
    for (const group of activeGroups(config)) {
      console.log(`\n${group.label}`);
      for (const [key, label, secret, type] of group.fields) {
        if (group.id === 'internal' && config.database === 'local' && !config.values[key]) {
          config.values[key] = crypto.randomBytes(32).toString('hex');
          console.log(`${key}: generated independently (not displayed)`);
          continue;
        }
        while (true) {
          const value = await ask(`${key} — ${label}`, config.values[key] || '', secret);
          if (valid(value, type)) { config.values[key] = value; break; }
          console.log(`${key}: required format is ${type}; blank/dummy credentials are not accepted.`);
        }
      }
    }
    const errors = validate(config);
    if (errors.length) throw new Error(errors.join('\n'));
    save(root, config);
    console.log(`\nSaved private configuration. Enabled providers: ${config.features.join(', ') || 'none'}.`);
    console.log('Validation checks presence/format only, not provider permissions, balances or deployment availability.');
  } finally { rl.close(); }
}
if (require.main === module) main().catch(error => { console.error(error instanceof SyntaxError ? 'Invalid installer configuration JSON' : error.message); process.exitCode = 1; });