#!/usr/bin/env python3
"""Transfer private staged config over SSH to the verified run-owned QA VM."""
import argparse
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--qa-id', required=True)
    args = parser.parse_args()
    if not args.qa_id.startswith('qa-') or '/' in args.qa_id:
        raise RuntimeError('Invalid QA ID')
    directory = ROOT / '.installer/qa' / args.qa_id
    state = json.loads((directory / 'azure-state.json').read_text())
    if state['state'] != 'vm-created-qa-bootstrap-pending' or not state['cleanupVerified']:
        raise RuntimeError('VM creation and external cleanup verification are required')
    group = state['group']
    if not group.startswith('rg-makinari-qa-'):
        raise RuntimeError('Invalid QA resource group')
    # Authenticate SSH host key via Azure control plane, not trust-on-first-use over the network.
    command = ['az', 'vm', 'run-command', 'invoke', '-g', group, '-n', state['vm'],
               '--command-id', 'RunShellScript', '--scripts', 'cat /etc/ssh/ssh_host_ed25519_key.pub', '-o', 'json']
    result = subprocess.run(command, capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError('Host key verification through Azure failed')
    messages = '\n'.join(v['message'] for v in json.loads(result.stdout)['value'])
    line = next((l for l in messages.splitlines() if l.startswith('ssh-ed25519 ')), None)
    if not line:
        raise RuntimeError('SSH host key not returned by Azure')
    known = directory / 'known_hosts'
    known.write_text(state['publicIp'] + ' ' + ' '.join(line.split()[:2]) + '\n')
    known.chmod(0o600)
    options = ['-i', state['sshKey'], '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known), '-o', 'ConnectTimeout=15']
    host = state['sshUser'] + '@' + state['publicIp']
    result = subprocess.run(['ssh', *options, host, 'umask 077; mkdir -p ~/qa/.installer ~/qa/scripts ~/qa/market-fit ~/qa/API ~/qa/Workflows'], timeout=60)
    if result.returncode:
        raise RuntimeError('QA SSH directory setup failed')
    transfers = [(directory / '.installer/credentials.json', '~/qa/.installer/credentials.json'),
                 (ROOT / 'scripts/azure-host-bootstrap.sh', '~/qa/scripts/azure-host-bootstrap.sh')]
    for repo in ['market-fit', 'API', 'Workflows']:
        transfers.append((directory / repo / '.env', '~/qa/' + repo + '/.env'))
    bundle = directory / 'installer-bundle.tar.gz'
    if bundle.exists():
        transfers.append((bundle, '~/qa/installer-bundle.tar.gz'))
    for source, target in transfers:
        result = subprocess.run(['scp', *options, str(source), host + ':' + target], capture_output=True, timeout=120)
        if result.returncode:
            raise RuntimeError('Private QA file transfer failed; no values printed')
    state['privateConfigUploaded'] = True
    (directory / 'azure-state.json').write_text(json.dumps(state, indent=2) + '\n')
    print('Private QA config transferred over host-key-verified SSH. No application services started.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error))
        raise SystemExit(1)