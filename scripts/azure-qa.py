#!/usr/bin/env python3
"""Provision one approved disposable Azure QA VM; never use production groups."""
import argparse
import datetime as dt
import http.client
import json
import pathlib
import subprocess
import time
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]


def az(*args, body=None):
    command = ['az', *args, '--only-show-errors', '-o', 'json']
    if body is not None:
        command += ['--body', json.dumps(body)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=1200)
    if result.returncode:
        # No bearer tokens, provider values or raw command arguments in logs.
        raise RuntimeError('Azure command failed: ' + ' '.join(args[:3]) + '\n' + result.stderr[:1500])
    return json.loads(result.stdout) if result.stdout.strip() else None


def rest(method, url, body=None):
    return az('rest', '--method', method, '--url', url, body=body)


def runbook_request(method, path, token, content=None, read_limit=0):
    # An accepted upload can stall while the client waits for its response body.
    # Only read a bounded body on explicit readbacks. Never follow redirects.
    connection = http.client.HTTPSConnection('management.azure.com', timeout=20)
    headers = {'Authorization': 'Bearer ' + token}
    if content is not None:
        headers['Content-Type'] = 'text/powershell'
    try:
        connection.request(method, path, body=content, headers=headers)
        with connection.getresponse() as response:
            payload = response.read(read_limit) if read_limit and response.status == 200 else None
            return response.status, payload
    finally:
        connection.close()


def publish_cleanup_runbook(path, api, token, content):
    def wait_for_readback(endpoint):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            status, payload = runbook_request('GET', endpoint, token, read_limit=len(content) * 2 + 4)
            if status == 200 and payload.replace(b'\r\n', b'\n').removeprefix(b'\xef\xbb\xbf') == content:
                return
            if status not in (200, 202, 404):
                raise RuntimeError(f'Azure Automation runbook readback failed (HTTP {status})')
            time.sleep(2)
        raise RuntimeError('Azure Automation did not confirm the exact runbook content in time')

    draft = path + '/draft/content' + api
    status, _ = runbook_request('PUT', draft, token, content)
    if status not in (200, 202):
        raise RuntimeError(f'Azure Automation runbook upload failed (HTTP {status})')
    # Verify the actual artifact on a fixed ARM path instead of following an
    # asynchronous Location, which can differ from the documented example.
    wait_for_readback(draft)
    status, _ = runbook_request('POST', path + '/publish' + api, token)
    if status not in (200, 202, 204):
        raise RuntimeError(f'Azure Automation runbook publish failed (HTTP {status})')
    wait_for_readback(path + '/content' + api)


def write_state(file, state):
    file.write_text(json.dumps(state, indent=2) + '\n')
    file.chmod(0o600)


def render_runbook(state):
    text = (ROOT / 'scripts/azure-qa-cleanup.ps1').read_text()
    for key, value in [('SUBSCRIPTION', state['subscription']), ('GROUP', state['group']),
                       ('ENVIRONMENT_ID', state['id']), ('EXPIRES_AT', state['expiresAt'])]:
        text = text.replace('__' + key + '__', value)
    return text


def setup_cleanup(state, directory):
    sub, group, account = state['subscription'], state['group'], state['automationAccount']
    base = f'https://management.azure.com/subscriptions/{sub}/resourceGroups/{group}/providers/Microsoft.Automation/automationAccounts/{account}'
    api = '?api-version=2023-11-01'
    resource = rest('put', base + api, {'location': state['location'],
        'identity': {'type': 'SystemAssigned'}, 'properties': {'sku': {'name': 'Basic'}}})
    principal = resource.get('identity', {}).get('principalId')
    if not principal:
        resource = rest('get', base + api)
        principal = resource['identity']['principalId']
    scope = f'/subscriptions/{sub}/resourceGroups/{group}'
    az('role', 'assignment', 'create', '--assignee-object-id', principal, '--assignee-principal-type',
       'ServicePrincipal', '--role', 'Contributor', '--scope', scope)
    runbook = 'expire-qa'
    run = base + '/runbooks/' + runbook
    rest('put', run + api, {'location': state['location'], 'properties': {
        'runbookType': 'PowerShell', 'logVerbose': False, 'logProgress': False, 'description': 'Delete only the expired run-owned QA group'}})
    source = directory / 'cleanup.ps1'
    source.write_text(render_runbook(state))
    token = az('account', 'get-access-token', '--subscription', sub,
               '--resource', 'https://management.azure.com/', '--query', 'accessToken')
    if not isinstance(token, str) or not token:
        raise RuntimeError('Azure Automation ARM authorization unavailable')
    publish_cleanup_runbook(run.removeprefix('https://management.azure.com'), api, token, source.read_bytes())
    if rest('get', run + api)['properties']['state'] != 'Published':
        raise RuntimeError('Azure Automation cleanup runbook is not published')
    schedule = 'expire-' + state['id']
    # Automation truncates schedule seconds. Round up so expiration guard cannot reject an early job.
    deadline = dt.datetime.fromisoformat(state['expiresAt'])
    schedule_time = (deadline + dt.timedelta(minutes=1)).replace(second=0, microsecond=0).isoformat()
    rest('put', base + '/schedules/' + schedule + api, {'name': schedule, 'properties': {
        'startTime': schedule_time, 'frequency': 'OneTime', 'description': 'Four-hour QA expiration'}})
    rest('put', base + '/jobSchedules/' + str(uuid.uuid4()) + api, {'properties': {
        'runbook': {'name': runbook}, 'schedule': {'name': schedule}}})
    # Verify real managed-identity read permission before provisioning paid compute.
    for attempt in range(3):
        job_id = str(uuid.uuid4())
        job = base + '/jobs/' + job_id + api
        rest('put', job, {'properties': {'runbook': {'name': runbook}, 'parameters': {'DryRun': 'true'}}})
        for _ in range(60):
            status = rest('get', job)['properties']['status']
            if status == 'Completed':
                state['cleanupVerified'] = True
                state['cleanupSchedule'] = schedule
                return
            if status in ['Failed', 'Stopped', 'Suspended']:
                break
            time.sleep(5)
        if attempt < 2:
            time.sleep(30)
    raise RuntimeError('External cleanup dry-run failed; VM not created')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--approve-create', action='store_true')
    parser.add_argument('--qa-id', required=True)
    parser.add_argument('--size', choices=['Standard_D4s_v5', 'Standard_D4as_v5'], default='Standard_D4s_v5')
    parser.add_argument('--location', choices=['eastus', 'centralus', 'westus2'], default='eastus')
    args = parser.parse_args()
    qa = ROOT / '.installer/qa' / args.qa_id
    if not args.qa_id.startswith('qa-') or not qa.is_dir() or qa.parent != ROOT / '.installer/qa':
        raise RuntimeError('Existing staged QA environment ID is required')
    state_file = qa / 'azure-state.json'
    if state_file.exists():
        raise RuntimeError('Azure state already exists; inspect it before another provision attempt')
    if not args.approve_create:
        raise RuntimeError('Explicit --approve-create required after reviewing Azure costs')
    account = az('account', 'show')
    now = dt.datetime.now(dt.timezone.utc)
    suffix = now.strftime('%Y%m%d%H%M%S') + '-' + uuid.uuid4().hex[:5]
    group = 'rg-makinari-qa-' + suffix
    state = {'id': args.qa_id, 'subscription': account['id'], 'group': group, 'location': args.location,
             'vm': 'qa-linux', 'size': args.size, 'automationAccount': 'qa-expiry-' + suffix,
             'createdAt': now.isoformat(), 'expiresAt': (now + dt.timedelta(hours=4)).isoformat(),
             'state': 'provisioning', 'cleanupVerified': False, 'sshUser': 'qaadmin'}
    write_state(state_file, state)
    try:
        provider = az('provider', 'show', '--namespace', 'Microsoft.Automation')
        if provider['registrationState'] != 'Registered':
            az('provider', 'register', '--namespace', 'Microsoft.Automation', '--wait')
        az('group', 'create', '--name', group, '--location', state['location'], '--tags',
           'purpose=disposable-qa', 'environmentId=' + args.qa_id, 'expiresAt=' + state['expiresAt'])
        setup_cleanup(state, qa)
        write_state(state_file, state)
        ssh = qa / 'ssh-key'
        result = subprocess.run(['ssh-keygen', '-t', 'ed25519', '-N', '', '-f', str(ssh)], capture_output=True)
        if result.returncode:
            raise RuntimeError('QA SSH key generation failed')
        ssh.chmod(0o600)
        with urllib.request.urlopen('https://api.ipify.org', timeout=10) as response:
            ip = response.read().decode().strip()
        import ipaddress
        ipaddress.IPv4Address(ip)
        # No default public SSH rule; add a single caller-IP rule after provisioning.
        vm = az('vm', 'create', '--resource-group', group, '--name', state['vm'], '--location', state['location'],
                '--image', 'Canonical:ubuntu-24_04-lts:server:latest', '--size', state['size'],
                '--admin-username', state['sshUser'], '--ssh-key-values', str(ssh) + '.pub',
                '--os-disk-size-gb', '128', '--storage-sku', 'StandardSSD_LRS',
                '--public-ip-sku', 'Standard', '--nsg-rule', 'NONE')
        state['publicIp'] = vm['publicIpAddress']
        state['sshKey'] = str(ssh)
        state['state'] = 'vm-created-network-configuration-pending'
        write_state(state_file, state)
        nics = az('network', 'nic', 'list', '--resource-group', group)
        nsg_id = nics[0]['networkSecurityGroup']['id']
        az('network', 'nsg', 'rule', 'create', '--resource-group', group, '--nsg-name', nsg_id.split('/')[-1],
           '--name', 'qa-ssh-caller-only', '--priority', '100', '--access', 'Allow', '--protocol', 'Tcp',
           '--direction', 'Inbound', '--source-address-prefixes', ip + '/32', '--destination-port-ranges', '22')
        shutdown = dt.datetime.fromisoformat(state['expiresAt']).strftime('%H%M')
        az('vm', 'auto-shutdown', '--resource-group', group, '--name', state['vm'], '--time', shutdown)
        state['state'] = 'vm-created-qa-bootstrap-pending'
        write_state(state_file, state)
        print(json.dumps({k: state[k] for k in ['group', 'vm', 'size', 'expiresAt', 'cleanupVerified', 'state']}, indent=2))
    except Exception:
        state['state'] = 'provisioning-failed-cleanup-requested'
        write_state(state_file, state)
        # All resources are owned by this exact new group; never adopt or delete an existing group.
        try:
            az('group', 'delete', '--name', group, '--yes', '--no-wait')
        except Exception:
            state['state'] = 'provisioning-failed-manual-cleanup-required'
            write_state(state_file, state)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error))
        raise SystemExit(1)