const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { groups, validate } = require('./credential-catalog.cjs');
const { prepareLocalRedis, materialize } = require('./local-redis.cjs');
const { save, apply } = require('./workspace-config.cjs');

function prepareConfig(sources, random = () => crypto.randomBytes(32).toString('hex')) {
  const values = {};
  const excluded = [];
  for (const [key] of groups.find(g => g.id === 'internal').fields) values[key] = random();
  const features = [];
  for (const id of ['openrouter', 'azure', 'speech', 'stripe']) {
    const group = groups.find(g => g.id === id);
    const source = id === 'stripe' ? sources['market-fit'] : sources.API;
    const candidate = Object.fromEntries(group.fields.map(([key]) => [key,
      key === 'API_STRIPE_WEBHOOK_SECRET' ? sources.API.STRIPE_WEBHOOK_SECRET : source[key]]));
    const trial = prepareLocalRedis({ database: 'local', temporal: 'local', redis: 'local',
      ports: { frontend: 3000, api: 3001, workflows: 3002 }, features: [id], values: { ...values, ...candidate } }, random);
    const errors = validate(trial);
    if (errors.length) excluded.push({ feature: id, reason: 'Incomplete or invalid credentials; feature not enabled' });
    else { features.push(id); Object.assign(values, candidate); }
  }
  // These suites must never send real mail. Provider credentials are not inherited.
  excluded.push({ feature: 'email', reason: 'External delivery excluded from QA; disposable mail transport still required' });
  const config = prepareLocalRedis({ database: 'local', temporal: 'local', redis: 'local',
    ports: { frontend: 3000, api: 3001, workflows: 3002 }, features, values }, random);
  const errors = validate(config);
  if (errors.length) throw new Error(errors.join('\n'));
  return { config, excluded };
}
function stage(root, sources, { id = `qa-${Date.now()}-${crypto.randomBytes(4).toString('hex')}` } = {}) {
  if (!/^qa-[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid QA environment ID');
  const dir = path.join(root, '.installer', 'qa', id);
  if (fs.existsSync(dir)) throw new Error('QA environment already exists; refusing to overwrite');
  const { config, excluded } = prepareConfig(sources);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const repo of ['market-fit', 'API', 'Workflows']) fs.mkdirSync(path.join(dir, repo), { mode: 0o700 });
  save(dir, config);
  apply(dir, config);
  materialize(dir, config);
  const manifest = { id, createdAt: new Date().toISOString(), state: 'configuration-staged-not-running',
    enabledFeatures: config.features, excluded,
    blockers: ['Docker runtime unavailable/unverified', 'Schema baseline and local-only webhook routing need verified bootstrap',
      'Application checkout/dependency installation and local Supabase key discovery pending',
      'QA identities, memberships and persisted fixtures not provisioned'],
    safety: { database: 'local', redis: 'local', temporal: 'local', inheritedInfrastructureCredentials: false,
      inheritedTestIdentities: false, mutationsEnabled: false, externalEmailEnabled: false,
      providerCallsExecuted: false } };
  fs.writeFileSync(path.join(dir, 'qa-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return { dir, manifest };
}
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const sourceRoot = process.argv[2];
    if (!sourceRoot || !path.isAbsolute(sourceRoot)) throw new Error('Usage: node scripts/prepare-qa.cjs /absolute/source/repos');
    // Reuse the actual application dotenv implementation without adding an installer dependency.
    const dotenv = require(path.join(sourceRoot, 'market-fit', 'node_modules', 'dotenv'));
    const sources = {};
    for (const repo of ['market-fit', 'API', 'Workflows']) {
      const file = path.join(sourceRoot, repo, '.env.local');
      if (!fs.existsSync(file)) throw new Error(`${repo}/.env.local is required`);
      sources[repo] = dotenv.parse(fs.readFileSync(file));
    }
    const { dir, manifest } = stage(root, sources);
    console.log(`Private QA configuration staged: ${dir}`);
    console.log(`Imported enabled providers: ${manifest.enabledFeatures.join(', ') || 'none'}`);
    console.log('No source env files changed. No production infrastructure keys or identities copied. Environment is NOT running.');
  } catch (error) { console.error(error instanceof SyntaxError ? 'Invalid source/config syntax' : error.message); process.exitCode = 1; }
}
function readSources(sourceRoot) {
  if (!path.isAbsolute(sourceRoot)) throw new Error('Source repository directory must be absolute');
  const dotenv = require(path.join(sourceRoot, 'market-fit', 'node_modules', 'dotenv'));
  return Object.fromEntries(['market-fit', 'API', 'Workflows'].map(repo => {
    const file = path.join(sourceRoot, repo, '.env.local');
    if (!fs.existsSync(file)) throw new Error(`${repo}/.env.local is required`);
    return [repo, dotenv.parse(fs.readFileSync(file))];
  }));
}
module.exports = { prepareConfig, stage, readSources };