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
test('host and devcontainer discover the versioned Supabase Debian release asset', () => {
  for (const file of ['scripts/azure-host-bootstrap.sh', '.devcontainer/Dockerfile']) {
    const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    expect(code).toContain('https://api.github.com/repos/supabase/cli/releases/latest');
    expect(code).toContain('browser_download_url');
    expect(code).not.toContain('latest/download/supabase_linux_amd64.deb');
    expect(code).toContain('tsx@4.23.15');
  }
});
test('workers use installed tsx instead of racing three npx installs', () => {
  const code = fs.readFileSync(path.join(__dirname, '../start-workspace.sh'), 'utf8');
  expect(code).toContain('command -v tsx');
  expect(code).toContain('WORKFLOW_TASK_QUEUE=$queue tsx src/scripts/start-worker.ts');
  expect(code).not.toContain('npm run start-worker');
});