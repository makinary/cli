const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
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
test('provision installs the matching browser with a bounded checked CLI before fixtures, never during run', () => {
  const python = `
import contextlib,io,runpy,sys
m=runpy.run_path(sys.argv[1]); g=m['main'].__globals__; calls=[]
g['connection']=lambda directory: ({'expiresAt':'2030-01-01T00:00:00+00:00'}, [], 'offline-host', 2000)
g['upload']=lambda *args: calls.append(('upload',))
browser='cd ~/qa/market-fit && npx --no-install playwright install --with-deps chromium >../qa-browser-install.log 2>&1'
def remote(options,host,command,timeout=60,**kwargs):
    calls.append((command,timeout))
    return ''
g['ssh']=remote
sys.argv=['qa-tests.py','provision','--qa-id','qa-test']
with contextlib.redirect_stdout(io.StringIO()): m['main']()
assert calls[0]==('upload',) and calls[1]==(browser,600)
assert 'provision-qa.cjs --apply' in calls[2][0] and calls[2][1]==300
calls.clear()
def failed(options,host,command,timeout=60,**kwargs):
    calls.append((command,timeout))
    raise RuntimeError('Browser install failed')
g['ssh']=failed
try: m['main']()
except RuntimeError: pass
else: raise AssertionError('Failed browser install accepted')
assert calls==[('upload',),(browser,600)]
calls.clear()
g['connection']=lambda directory: ({}, [], 'offline-host', 1499)
try: m['main']()
except RuntimeError as error: assert 'Insufficient time' in str(error)
else: raise AssertionError('Insufficient provision budget accepted')
assert calls==[]
g['connection']=lambda directory: ({'expiresAt':'2030-01-01T00:00:00+00:00'}, [], 'offline-host', 2000)
g['ssh']=remote
sys.argv=['qa-tests.py','run','--qa-id','qa-test','--suite','subsystems']
with contextlib.redirect_stdout(io.StringIO()): m['main']()
assert len(calls)==2 and all(browser not in call[0] for call in calls)
assert 'nohup node -e' in calls[1][0] and 'scripts/e2e/run.cjs' in calls[1][0]
print('checked browser provisioning verified offline')
`;
  const result = spawnSync('python3', ['-c', python, path.join(__dirname, '../scripts/qa-tests.py')], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('checked browser provisioning verified offline\n');
});
test('installer and Python runner explicitly support the isolated lifecycle suites', () => {
  const installer = fs.readFileSync(path.join(__dirname, '../scripts/qa-installer.cjs'), 'utf8');
  const python = fs.readFileSync(path.join(__dirname, '../scripts/qa-tests.py'), 'utf8');
  for (const suite of ['account-lifecycle', 'project-lifecycle']) {
    expect(parse(['run', '--id', 'qa-test', '--suite', suite, '--yes']).suite).toBe(suite);
    expect(installer).toContain(`'${suite}'`);
    expect(python).toContain(`'${suite}'`);
    const help = spawnSync('python3', [path.join(__dirname, '../scripts/qa-tests.py'), 'run', '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(suite);
  }
  expect(python).toContain("'account-lifecycle': 1500");
  expect(python).toContain("'regression': 7500");
  expect(python).toContain('remaining < required');
  expect(python).toContain(".get(suite, 900)");
  const budgets = spawnSync('python3', ['-c',
    "import runpy,sys,json; m=runpy.run_path(sys.argv[1]); print(json.dumps([m['required_seconds'](s) for s in ['account-lifecycle','project-lifecycle','regression',None]]))",
    path.join(__dirname, '../scripts/qa-tests.py')], { encoding: 'utf8' });
  expect(budgets.status).toBe(0);
  expect(JSON.parse(budgets.stdout)).toEqual([1500, 900, 7500, 900]);
});
test.each(['procurement', 'subsystems'])('%s is explicitly selectable in installer and Python with overhead budget', suite => {
  const file = path.join(__dirname, '../scripts/qa-installer.cjs');
  const calls = [];
  const context = { __dirname: path.dirname(file), module: { exports: {} }, require: name => name === 'node:child_process'
    ? { spawnSync: (command, args) => { calls.push({ command, args }); return { status: 0 }; } }
    : require(name.startsWith('./') ? path.join(path.dirname(file), name) : name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  expect(() => context.module.exports.main(['run', '--id', 'qa-test', '--suite', suite])).toThrow(/require --yes/);
  expect(calls).toHaveLength(0);
  context.module.exports.main(['run', '--id', 'qa-test', '--suite', suite, '--yes']);
  expect(calls[0]).toEqual({ command: 'python3', args: [path.join(__dirname, '../scripts/qa-tests.py'), 'run', '--qa-id', 'qa-test', '--suite', suite] });
  expect(() => context.module.exports.main(['run', '--id', 'qa-test', '--suite', 'unreviewed', '--yes'])).toThrow(/Select --suite/);
  expect(calls).toHaveLength(1);
  const help = spawnSync('python3', [path.join(__dirname, '../scripts/qa-tests.py'), 'run', '--help'], { encoding: 'utf8' });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain(suite);
  const budget = spawnSync('python3', ['-c', "import runpy,sys; print(runpy.run_path(sys.argv[1])['required_seconds'](sys.argv[2]))",
    path.join(__dirname, '../scripts/qa-tests.py'), suite], { encoding: 'utf8' });
  expect(budget.status).toBe(0);
  expect(Number(budget.stdout)).toBe(1800);
});
test.each(['smoke', 'buyer', 'roles', 'regression', 'project-lifecycle', 'account-lifecycle', 'procurement', 'subsystems'])(
  '%s runner grants only the requested lifecycle capability, overriding inherited flags', suite => {
    const python = fs.readFileSync(path.join(__dirname, '../scripts/qa-tests.py'), 'utf8');
    const runner = python.match(/runner = """([\s\S]*?)"""/)[1];
    let spawned;
    const fixture = { QA_STATUS: 'VERIFIED', QA_ENVIRONMENT_ID: 'qa-test', TEST_ALLOW_ACCOUNT_LIFECYCLE: '1',
      TEST_ALLOW_PROJECT_LIFECYCLE: '1', TEST_ALLOW_MUTATIONS: '1', TEST_DISPOSABLE_ENVIRONMENT: '1',
      TEST_INBUCKET_URL: 'https://unsafe.invalid', QA_EXPIRES_AT: 'stale' };
    const processMock = { env: { QA_ENVIRONMENT_ID: 'qa-test', QA_SUITE: suite, QA_RUN_ID: 'qa-run',
      QA_EXPIRES_AT: '2030-01-01T00:00:00.000Z', TEST_ALLOW_ACCOUNT_LIFECYCLE: '1' }, execPath: process.execPath, exit: jest.fn() };
    vm.runInNewContext(runner, { process: processMock, require: name => name === 'fs'
      ? { readFileSync: () => JSON.stringify(fixture), existsSync: () => false }
      : { spawnSync: (command, args, options) => { spawned = { command, args, ...options }; return { status: 0 }; } } });
    const mutating = ['roles', 'regression', 'project-lifecycle', 'account-lifecycle', 'procurement', 'subsystems'].includes(suite);
    expect(spawned.env.TEST_ALLOW_MUTATIONS).toBe(mutating ? '1' : '0');
    expect(spawned.env.TEST_DISPOSABLE_ENVIRONMENT).toBe(mutating ? '1' : '0');
    expect(spawned.env.TEST_ALLOW_ACCOUNT_LIFECYCLE).toBe(suite === 'account-lifecycle' ? '1' : '0');
    expect(spawned.env.TEST_ALLOW_PROJECT_LIFECYCLE).toBe(suite === 'project-lifecycle' ? '1' : '0');
    expect(spawned.env.TEST_INBUCKET_URL).toBe(suite === 'account-lifecycle' ? 'http://127.0.0.1:54324' : undefined);
    expect(spawned.env.QA_STATUS).toBe('VERIFIED');
    expect(spawned.env.QA_EXPIRES_AT).toBe(processMock.env.QA_EXPIRES_AT);
    expect(spawned.args).toEqual(['scripts/e2e/run.cjs', '--suite', suite, '--target', 'local']);
  });
test.each(['procurement', 'subsystems'])('%s does not read an AI provider model file', suite => {
  const python = fs.readFileSync(path.join(__dirname, '../scripts/qa-tests.py'), 'utf8');
  const runner = python.match(/runner = """([\s\S]*?)"""/)[1];
  const readFileSync = jest.fn(file => {
    if (file.includes('shiplight-model')) throw new Error('AI provider file must not be read');
    return JSON.stringify({ QA_STATUS: 'VERIFIED', QA_ENVIRONMENT_ID: 'qa-test' });
  });
  const spawn = jest.fn(() => ({ status: 0 }));
  vm.runInNewContext(runner, { process: { env: { QA_ENVIRONMENT_ID: 'qa-test', QA_SUITE: suite }, execPath: process.execPath, exit: jest.fn() },
    require: name => name === 'fs' ? { readFileSync, existsSync: () => true } : { spawnSync: spawn } });
  expect(readFileSync).toHaveBeenCalledTimes(1);
  expect(spawn).toHaveBeenCalledTimes(1);
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
  expect(lifecycle).toContain('MAKINARI_FRONTEND_HEALTH_PATH=/auth');
  expect(lifecycle).toContain('MAKINARI_API_HEALTH_PATH=/api/status');
  expect(lifecycle).toContain('kill -0');
  expect(lifecycle).not.toContain("shutil.copytree(schema / 'supabase'");
  expect(lifecycle).toContain("'status', '--porcelain'");
  expect(lifecycle).toContain("tags.get('environmentId') != state['id']");
  expect(lifecycle).toContain("tags.get('expiresAt') != state['expiresAt']");
});
test('fresh package Auth override stays offline and leaves original config unchanged', () => {
  const script = `
import pathlib,runpy,shutil,sys,tempfile,tomllib
m=runpy.run_path(sys.argv[1])
base='''project_id = "makinari-qa"
[db.seed]
enabled = false
[inbucket]
enabled = true
port = 54324
[auth]
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = [
  "http://127.0.0.1:3000/auth/callback"
]
enable_signup = true
[auth.email]
enable_signup = true
enable_confirmations = false
'''
with tempfile.TemporaryDirectory() as temp:
    root=pathlib.Path(temp)
    source=root/'source.toml'; source.write_text(base)
    target=root/'supabase'; target.mkdir()
    copied=target/'config.toml'; shutil.copy2(source,copied)
    m['configure'](copied)
    assert source.read_text()==base
    cfg=tomllib.loads(copied.read_text())
    assert cfg['auth']['email']['enable_confirmations'] is True
    assert cfg['auth']['additional_redirect_urls']==m['REDIRECTS']
    assert cfg['auth']['enable_signup'] is True
    for kind,typ in [('confirmation','email'),('recovery','recovery')]:
        relative=cfg['auth']['email']['template'][kind]['content_path']
        html=(root/relative).read_text()
        assert '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type='+typ+'&amp;returnTo=%2Fprojects' in html
        assert 'ConfirmationURL' not in html
    try: m['configure'](copied)
    except ValueError: pass
    else: raise AssertionError('Duplicate templates accepted')
    invalid=[base.replace('http://127.0.0.1:3000','https://external.invalid'),
             base.replace('[db.seed]\\nenabled = false','[db.seed]\\nenabled = true'),
             base.replace('makinari-qa','production'),
             base.replace('/auth/callback','/untrusted'),
             base.replace('port = 54324','port = 2525'),
             base+'\\n[auth.email.template.confirmation]\\ncontent_path="existing.html"\\n',
             base+'\\n[auth.email.template.recovery]\\ncontent_path="existing.html"\\n',
             base+'\\n[auth.email.template.confirmation]\\n[auth.email.template.confirmation]\\n']
    for i,text in enumerate(invalid):
        folder=root/str(i); folder.mkdir(); f=folder/'config.toml'; f.write_text(text)
        try: m['configure'](f)
        except ValueError: pass
        else: raise AssertionError('Unsafe config accepted '+str(i))
        assert f.read_text()==text
        assert not (folder/'templates').exists()
print('Fresh QA Auth config checks passed')
`;
  const result = spawnSync('python3', ['-c', script, path.join(__dirname, '../scripts/qa-auth-config.py')], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('checks passed');
  const lifecycle = fs.readFileSync(path.join(__dirname, '../scripts/qa-lifecycle.py'), 'utf8');
  expect(lifecycle.indexOf("auth_config.configure(target / 'config.toml')")).toBeGreaterThan(
    lifecycle.indexOf("shutil.copy2(schema / 'supabase/config.toml'"));
  expect(lifecycle).toContain("ROOT / 'scripts/qa-auth-config.py'");
});

test('results exports exact-run safe evidence locally without raw reports or provider/log errors', () => {
  const python = `
import contextlib,io,json,pathlib,runpy,sys,tempfile
m=runpy.run_path(sys.argv[1]); g=m['export_results'].__globals__
qa='qa-test'; run=qa+'-smoke-1234abcd'
summary={'runId':run,'suite':'smoke','state':'finished','counts':{'passed':1},'expectedCount':1,'selectedCount':1,'missing':0}
evidence={'schemaVersion':1,'qaId':qa,'extraction':{'status':'ok','errors':[]},'runs':[
    {'runId':run,'suite':'smoke','summary':summary,'detailCount':1,'extraction':{'status':'ok','errors':[]}}]}
class Checked:
    returncode=0
    stdout=json.dumps(evidence)
    stderr='PRIVATE_PROVIDER_SECRET'
calls=[]
def connect(directory):
    return {}, [], 'private-host', 100
def remote(options,host,command,timeout=60,input_text=None):
    assert command=='cd ~/qa/market-fit && node - export qa-test smoke'
    assert input_text.startswith('#!/usr/bin/env node')
    assert 'run-summary.json' in input_text
    return json.dumps(evidence)
def validate(args,**kwargs):
    assert args[0]=='node' and args[2:]==['validate',qa]
    assert kwargs['capture_output'] and kwargs['cwd'].name=='market-fit'
    assert json.loads(kwargs['input'])==evidence
    calls.append(args)
    return Checked()
g['connection']=connect; g['ssh']=remote; g['subprocess'].run=validate
with tempfile.TemporaryDirectory() as temp:
    directory=pathlib.Path(temp)
    out=io.StringIO()
    with contextlib.redirect_stdout(out): m['export_results'](directory,qa,'smoke')
    assert calls and 'PRIVATE_PROVIDER_SECRET' not in out.getvalue()
    for name,value in [('test-evidence.json',evidence),('test-summaries.json',[summary])]:
        f=directory/name
        assert json.loads(f.read_text())==value
        assert f.stat().st_mode & 0o777==0o600
    previous=(directory/'test-evidence.json').read_text()
    def failed(*args,**kwargs): raise RuntimeError('PRIVATE_PROVIDER_SECRET raw log password')
    g['ssh']=failed
    try: m['export_results'](directory,qa)
    except RuntimeError as error: assert 'PRIVATE_PROVIDER_SECRET' not in str(error)
    else: raise AssertionError('Remote failure accepted')
    assert (directory/'test-evidence.json').read_text()==previous
    failure=json.loads((directory/'test-evidence-error.json').read_text())
    assert failure['runs']==[]
    assert failure['extraction']['errors']==[{'code':'REMOTE_EXTRACTION_FAILED'}]
    g['ssh']=remote
    def unsafe(*args,**kwargs):
        result=Checked(); result.returncode=1
        result.stdout='PRIVATE_PROVIDER_SECRET'
        return result
    g['subprocess'].run=unsafe
    try: m['export_results'](directory,qa,'smoke')
    except RuntimeError as error: assert 'PRIVATE_PROVIDER_SECRET' not in str(error)
    else: raise AssertionError('Unsafe local validation accepted')
    assert (directory/'test-evidence.json').read_text()==previous
    failure=json.loads((directory/'test-evidence-error.json').read_text())
    assert failure['extraction']['errors']==[{'code':'LOCAL_VALIDATION_FAILED'}]
    assert failure['runs']==[]
print('safe exact export verified offline')
`;
  const result = spawnSync('python3', ['-c', python, path.join(__dirname, '../scripts/qa-tests.py')], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('safe exact export verified offline\n');
});