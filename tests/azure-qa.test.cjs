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