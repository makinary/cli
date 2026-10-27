const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { stage, readSources } = require('./prepare-qa.cjs');
const { load } = require('./workspace-config.cjs');

const root = path.resolve(__dirname, '..');
function parse(args) {
  const [action, ...rest] = args;
  if (!['prepare', 'create', 'status', 'destroy'].includes(action)) {
    throw new Error('Usage: ./install.sh qa <prepare|create|status|destroy> [--source-root PATH] [--id ID] [--schema-dir PATH] [--ack-reviewed-schema] [--approve-create|--yes]');
  }
  const out = { action };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (['--approve-create', '--yes', '--ack-reviewed-schema'].includes(key)) out[key.slice(2)] = true;
    else if (['--source-root', '--id', '--schema-dir'].includes(key) && rest[i + 1] && !rest[i + 1].startsWith('--')) out[key.slice(2)] = rest[++i];
    else throw new Error('Unknown or incomplete QA option: ' + key);
  }
  if (action !== 'prepare' && !/^qa-[a-zA-Z0-9_-]+$/.test(out.id || '')) throw new Error('An explicit valid --id is required; latest is never inferred');
  return out;
}
function preflight(options) {
  if (!options['approve-create']) throw new Error('Cost approval required: --approve-create (four-hour D4as_v5, West US 2; recheck current pricing)');
  if (!options['ack-reviewed-schema']) throw new Error('A reviewed complete local-only schema is required: --ack-reviewed-schema');
  if (fs.existsSync(path.join(root, '.installer/qa', options.id, 'azure-state.json'))) {
    throw new Error('Azure state already exists for this ID; refusing create before any cleanup or provisioning');
  }
  let schema = options['schema-dir'];
  if (!schema) {
    const sourceFile = path.join(root, '.installer/qa', options.id, 'source.json');
    if (fs.existsSync(sourceFile)) schema = path.join(JSON.parse(fs.readFileSync(sourceFile)).root, 'makinari-db-scheme/bootstrap');
  }
  if (!schema || !path.isAbsolute(schema)) throw new Error('--schema-dir must be an absolute reviewed Supabase project directory');
  if (!fs.existsSync(path.join(schema, 'supabase/config.toml'))) throw new Error('Reviewed schema requires supabase/config.toml');
  const configText = fs.readFileSync(path.join(schema, 'supabase/config.toml'), 'utf8');
  if (/https:\/\//i.test(configText.replace(/^\s*#.*$/gm, ''))
      || /^\s*(?:secret|password|api_key|pass|access_token)\s*=\s*"(?!env\(|")[^"]+/im.test(configText)) {
    throw new Error('Supabase configuration contains remote endpoints or literal credentials');
  }
  const seedSection = configText.match(/\[db\.seed\]([\s\S]*?)(?=\n\[|$)/)?.[1] || '';
  if (/enabled\s*=\s*true/i.test(seedSection)) throw new Error('QA schema seeds must be disabled; identities/fixtures are provisioned separately');
  const dir = path.join(schema, 'supabase/migrations');
  if (!fs.existsSync(dir)) throw new Error('Reviewed schema migrations missing');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
  if (!files.length) throw new Error('Reviewed schema migrations empty');
  const versions = files.map(f => f.split('_')[0]);
  if (versions.some(v => !/^\d{14}$/.test(v)) || new Set(versions).size !== versions.length) throw new Error('Schema needs unique timestamped migration versions');
  const sql = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const manifestFile = path.join(schema, 'manifest.json');
  let capturedBaseline = false;
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    if (manifest.purpose === 'fresh-local-qa-bootstrap' && manifest.schemaOnly && manifest.rowsExported === false) {
      const entries = manifest.files || [];
      if (entries.length !== files.length || entries.some(e => !files.includes(e.file)
        || crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, e.file))).digest('hex') !== e.sha256)) {
        throw new Error('Captured bootstrap file manifest/hash mismatch');
      }
      capturedBaseline = true;
    }
  }
  if (!capturedBaseline && /\b(?:INSERT\s+INTO|COPY\s+)["\s]*(?:auth\.)?users\b|(?:x-api-key|authorization)["\s]*:/i.test(sql)) {
    throw new Error('Schema must not contain user data or embedded authorization headers');
  }
  const outboundScan = capturedBaseline ? sql
    .replace("^http://(127[.]0[.]0[.]1|localhost|host[.]docker[.]internal):[0-9]+/", '')
    .replace(/https:\/\/\(\[a-z0-9\][^'\n]+/g, '') : sql;
  if (/https?:\/\/(?!127\.0\.0\.1(?::|\/)|localhost(?::|\/)|host\.docker\.internal(?::|\/))[^\s'";]+/i.test(outboundScan)) {
    throw new Error('Schema contains external URLs; review outbound hooks before provisioning paid resources');
  }
  if (/supabase_functions\s*\.\s*["']?http_request/i.test(sql)
      || (/vault\.decrypted_secrets/i.test(sql) && !(capturedBaseline && sql.includes('QA workflow webhook rejected: non-local destination')))) {
    throw new Error('Unreviewed outbound webhook/Vault dispatch detected; provide a local-only schema');
  }
  // Presence is a preflight check, not proof that SQL executes successfully.
  for (const table of ['sites', 'profiles', 'site_members', 'settings', 'sale_order_items']) {
    if (!new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"?public"?\\.)?"?${table}"?\\s*\\(`, 'i').test(sql)) {
      throw new Error('Incomplete baseline: CREATE TABLE ' + table + ' missing');
    }
  }
  load(path.join(root, '.installer/qa', options.id));
  return schema;
}
function run(command, args) {
  const r = spawnSync(command, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${command} failed; inspect this explicit QA attempt before retrying`);
}
function main(args = process.argv.slice(2)) {
  const options = parse(args);
  if (options.action === 'prepare') {
    if (!options['source-root']) throw new Error('--source-root is required');
    const { dir, manifest } = stage(root, readSources(options['source-root']));
    const source = path.resolve(options['source-root']);
    fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ root: source }) + '\n', { mode: 0o600 });
    console.log(`QA ID: ${manifest.id}\nPrivate configuration prepared; no Azure resources created.`);
    return;
  }
  if (options.action === 'create') {
    const schema = preflight(options);
    run('python3', [path.join(root, 'scripts/qa-lifecycle.py'), 'package', '--qa-id', options.id, '--schema-dir', schema]);
    try {
      run('python3', [path.join(root, 'scripts/azure-qa.py'), '--qa-id', options.id, '--size', 'Standard_D4as_v5', '--location', 'westus2', '--approve-create']);
      run('python3', [path.join(root, 'scripts/azure-qa-upload.py'), '--qa-id', options.id]);
      run('python3', [path.join(root, 'scripts/qa-lifecycle.py'), 'bootstrap', '--qa-id', options.id]);
    } catch (error) {
      console.error('QA creation/bootstrap failed; requesting verified cleanup of this exact attempt.');
      try { run('python3', [path.join(root, 'scripts/qa-lifecycle.py'), 'destroy', '--qa-id', options.id]); }
      catch { console.error(`Cleanup not confirmed. Run ./install.sh qa status --id ${options.id} and inspect the expiry schedule.`); }
      throw error;
    }
    return;
  }
  if (options.action === 'destroy' && !options.yes) throw new Error('Destruction requires --yes after selecting the exact QA ID');
  run('python3', [path.join(root, 'scripts/qa-lifecycle.py'), options.action, '--qa-id', options.id]);
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parse, preflight, main };