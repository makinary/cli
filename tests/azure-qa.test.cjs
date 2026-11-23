const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Azure provisioner requires explicit approval and cannot adopt an existing environment', () => {
  const text = fs.readFileSync(path.join(__dirname, '../scripts/azure-qa.py'), 'utf8');
  expect(text).toContain("if state_file.exists():");
  expect(text).toContain("if not args.approve_create:");
  expect(text).toContain("group = 'rg-makinari-qa-' + suffix");
  expect(text.indexOf('setup_cleanup(state, qa)')).toBeLessThan(text.indexOf("vm = az('vm', 'create'"));
  expect(text).toContain("'--nsg-rule', 'NONE'");
  expect(text).toContain("ip + '/32'");
  expect(text).toContain("state['state'] = 'provisioning-failed-cleanup-requested'");
  expect(text).toContain("choices=['Standard_D4s_v5', 'Standard_D4as_v5']");
  expect(text).toContain("deadline + dt.timedelta(minutes=1)");
  expect(text).toContain("'startTime': schedule_time");
  expect(text).toContain("choices=['eastus', 'centralus', 'westus2']");
});
test('external expiry rejects wrong tags and unexpired groups, with dry-run authorization', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/azure-qa-cleanup.ps1'), 'utf8');
  expect(script).toContain("^rg-makinari-qa-[a-z0-9-]+$");
  expect(script).toContain("$resource.tags.purpose -ne 'disposable-qa'");
  expect(script).toContain('$resource.tags.environmentId -ne $EnvironmentId');
  expect(script).toContain('$resource.tags.expiresAt -ne $ExpiresAt');
  expect(script).toContain('if ($DryRun)');
  expect(script.indexOf('Environment has not expired')).toBeLessThan(script.indexOf('-Method Delete'));
  expect(script).toContain('$env:IDENTITY_ENDPOINT');
});
test('Azure Python syntax parses without contacting Azure', () => {
  const file = path.join(__dirname, '../scripts/azure-qa.py');
  const result = spawnSync('python3', ['-c', 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())', file]);
  expect(result.status).toBe(0);
});
test('runbook operations use the PowerShell media type and verify exact content on fixed ARM paths', () => {
  const script = `
import runpy,sys
module=runpy.run_path(sys.argv[1]); g=module['publish_cleanup_runbook'].__globals__
path='/subscriptions/example/runbooks/expire-qa'; api='?api-version=2023-11-01'
calls=[]
class Response:
    status=202
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,*args): raise AssertionError('Asynchronous body must not be read')
class Connection:
    def __init__(self,host,timeout): assert host=='management.azure.com' and timeout==20
    def request(self,method,path,body,headers): calls.append((method,path,body,headers))
    def getresponse(self): return Response()
    def close(self): calls.append('closed')
g['http'].client.HTTPSConnection=Connection
assert module['runbook_request']('PUT',path,'synthetic-token',b'runbook')==(202,None)
assert calls==[('PUT',path,b'runbook',{'Authorization':'Bearer synthetic-token','Content-Type':'text/powershell'}),'closed']
calls.clear(); g['time'].sleep=lambda _:None
content=b'runbook'+bytes([10])
responses=iter([(202,None),(404,None),(200,b'wrong'),(200,content),(202,None),(200,b'wrong'),(200,content)])
def request(method,path,token,content=None,read_limit=0):
    calls.append((method,path,token,content,read_limit)); return next(responses)
g['runbook_request']=request
module['publish_cleanup_runbook'](path,api,'synthetic-token',content)
draft=path+'/draft/content'+api; published=path+'/content'+api
assert [(c[0],c[1]) for c in calls]==[('PUT',draft),('GET',draft),('GET',draft),('GET',draft),('POST',path+'/publish'+api),('GET',published),('GET',published)]
assert all(c[4]==len(content)*2+4 for c in calls if c[0]=='GET')
for response in [(302,None),(500,None)]:
    calls.clear(); responses=iter([response]);
    try: module['publish_cleanup_runbook'](path,api,'synthetic-token',content)
    except RuntimeError: pass
    else: raise AssertionError('Failed or redirected operation accepted')
    assert len(calls)==1
calls.clear(); responses=iter([(202,None),(200,b'wrong')]); ticks=iter([0,1,91]); g['time'].monotonic=lambda:next(ticks)
try: module['publish_cleanup_runbook'](path,api,'synthetic-token',content)
except RuntimeError as error: assert 'did not confirm the exact runbook content in time' in str(error)
else: raise AssertionError('Expired operation accepted')
assert [c[0] for c in calls]==['PUT','GET']
`;
  const result = spawnSync('python3', ['-c', script, path.join(__dirname, '../scripts/azure-qa.py')], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
test('private credential transfer verifies SSH host key through Azure and refuses unverified VMs', () => {
  const file = path.join(__dirname, '../scripts/azure-qa-upload.py');
  const text = fs.readFileSync(file, 'utf8');
  expect(text).toContain("state['state'] != 'vm-created-qa-bootstrap-pending'");
  expect(text).toContain("not state['cleanupVerified']");
  expect(text).toContain('cat /etc/ssh/ssh_host_ed25519_key.pub');
  expect(text).toContain('StrictHostKeyChecking=yes');
  expect(text).not.toContain('StrictHostKeyChecking=no');
  const result = spawnSync('python3', ['-c', 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())', file]);
  expect(result.status).toBe(0);
});
test('host pins the reviewed Supabase CLI while devcontainer discovers a versioned asset', () => {
  for (const file of ['scripts/azure-host-bootstrap.sh', '.devcontainer/Dockerfile']) {
    const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    if (file === 'scripts/azure-host-bootstrap.sh') {
      expect(code).toContain('SUPABASE_VERSION=3.1.0');
      expect(code).toContain('releases/tags/v${SUPABASE_VERSION}');
      expect(code).toContain('select(.name == $name)');
      expect(code).toContain('$(supabase --version)');
      expect(code).not.toContain('releases/latest');
    } else {
      expect(code).toContain('https://api.github.com/repos/supabase/cli/releases/latest');
    }
    expect(code).toContain('browser_download_url');
    expect(code).not.toContain('latest/download/supabase_linux_amd64.deb');
    expect(code).toContain('tsx@4.23.15');
  }
});
test('workers use installed tsx instead of racing three npx installs', () => {
  const code = fs.readFileSync(path.join(__dirname, '../start-workspace.sh'), 'utf8');
  expect(code).toContain('command -v tsx');
  expect(code).toContain('exec node scripts/workspace-runtime.cjs');
  const runtime = fs.readFileSync(path.join(__dirname, '../scripts/workspace-runtime.cjs'), 'utf8');
  expect(runtime).toContain("launch('tsx', ['src/scripts/start-worker.ts']");
  expect(runtime).toContain('WORKFLOW_TASK_QUEUE: queue');
  expect(runtime).not.toContain("launch('npx'");
  expect(code).not.toContain('npm run start-worker');
});