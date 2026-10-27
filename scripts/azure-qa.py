#!/usr/bin/env python3
"""Provision one approved disposable Azure QA VM; never use production groups."""
import argparse
import datetime as dt
import hashlib
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
    az('rest', '--method', 'put', '--url', run + '/draft/content' + api,
       '--headers', 'Content-Type=text/plain', '--body', '@' + str(source))
    rest('post', run + '/publish' + api)
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