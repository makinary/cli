const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parse, preflight } = require('../scripts/qa-installer.cjs');

test('installer provides QA lifecycle commands with explicit IDs and no latest inference', () => {
  expect(parse(['status', '--id', 'qa-test'])).toEqual({ action: 'status', id: 'qa-test' });
  expect(() => parse(['destroy'])).toThrow(/explicit valid/);
  expect(() => parse(['create', '--id', '../production'])).toThrow(/explicit valid/);
  expect(() => parse(['status', '--id', 'qa-test', '--unknown'])).toThrow(/Unknown/);
  expect(parse(['destroy', '--id', 'qa-test', '--yes']).yes).toBe(true);
  expect(parse(['run', '--id', 'qa-test', '--suite', 'roles', '--yes'])).toEqual({ action: 'run', id: 'qa-test', suite: 'roles', yes: true });
  expect(parse(['provision', '--id', 'qa-test', '--yes']).action).toBe('provision');
});
test('QA run/provision refuse mutations without explicit acknowledgement', () => {
  for (const action of ['run', 'provision']) {
    const result = spawnSync('bash', [path.join(__dirname, '../install.sh'), 'qa', action, '--id', 'qa-test'], {
      env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('QA mutations require --yes');
  }
});
test('remote QA runner validates expiry and never sources credentials into a shell', () => {
  const code = fs.readFileSync(path.join(__dirname, '../scripts/qa-tests.py'), 'utf8');
  expect(code).toContain('remaining < required');
  expect(code).toContain('module.owned_group(state)');
  expect(code).toContain("'scripts/e2e/run.cjs','--suite'");
  expect(code).toContain("'.auth/qa-fixtures/'+id+'/env.json'");
  expect(code).not.toContain('source .env');
});
test('creation fails before cloud resources when approval or reviewed schema is missing', () => {
  expect(() => preflight({ id: 'qa-test' })).toThrow(/Cost approval/);
  expect(() => preflight({ id: 'qa-test', 'approve-create': true })).toThrow(/reviewed complete/);
});
test('create refuses existing Azure state before any retry cleanup', () => {
  const actual = fs.existsSync;
  const spy = jest.spyOn(fs, 'existsSync').mockImplementation(file => String(file).endsWith('/qa-existing/azure-state.json') || actual(file));
  try {
    expect(() => preflight({ id: 'qa-existing', 'approve-create': true, 'ack-reviewed-schema': true })).toThrow(/Azure state already exists/);
  } finally { spy.mockRestore(); }
});
test('schema preflight rejects external webhook destinations and missing foundation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-schema-'));
  try {
    fs.mkdirSync(path.join(root, 'supabase/migrations'), { recursive: true });
    fs.writeFileSync(path.join(root, 'supabase/config.toml'), 'project_id="qa"');
    const file = path.join(root, 'supabase/migrations/20260101000000_base.sql');
    const options = { id: 'qa-test', 'approve-create': true, 'ack-reviewed-schema': true, 'schema-dir': root };
    fs.writeFileSync(file, "select 'https://production.invalid/api/webhook';");
    expect(() => preflight(options)).toThrow(/external URLs/);
    fs.writeFileSync(file, 'CREATE TABLE public.sites(id uuid);');
    expect(() => preflight(options)).toThrow(/Incomplete baseline/);
    fs.writeFileSync(file, "select supabase_functions.http_request('http://localhost:3001');");
    expect(() => preflight(options)).toThrow(/webhook/);
    fs.writeFileSync(path.join(root, 'supabase/config.toml'), '[db.seed]\nenabled=true\n');
    expect(() => preflight(options)).toThrow(/seeds must be disabled/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('install.sh dispatches QA preflight without provisioning or touching credentials', () => {
  const file = path.join(__dirname, '../install.sh');
  const result = spawnSync('bash', [file, 'qa', 'create', '--id', 'qa-test'], {
    env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Cost approval required');
});
test('integrated create packages before compute and calls remote install.sh rather than manual services', () => {
  const code = fs.readFileSync(path.join(__dirname, '../scripts/qa-installer.cjs'), 'utf8');
  expect(code.indexOf("'package', '--qa-id'")).toBeLessThan(code.indexOf("'scripts/azure-qa.py'"));
  expect(code).toContain("'destroy', '--qa-id', options.id");
  const lifecycle = fs.readFileSync(path.join(__dirname, '../scripts/qa-lifecycle.py'), 'utf8');
  expect(lifecycle).toContain('bash install.sh --existing-config');
  expect(lifecycle).toContain('bash install.sh --start');
  expect(lifecycle).toContain('kill -0');
  expect(lifecycle).not.toContain("shutil.copytree(schema / 'supabase'");
  expect(lifecycle).toContain("'status', '--porcelain'");
  expect(lifecycle).toContain("tags.get('environmentId') != state['id']");
  expect(lifecycle).toContain("tags.get('expiresAt') != state['expiresAt']");
});