#!/usr/bin/env python3
"""Internal QA operations invoked only through the installer entry point."""
import argparse
import datetime as dt
import json
import pathlib
import subprocess
import tarfile
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]


def azure(*args):
    r = subprocess.run(['az', *args, '--only-show-errors', '-o', 'json'], capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise RuntimeError('Azure operation failed; output suppressed to protect configuration')
    return json.loads(r.stdout) if r.stdout.strip() else None


def owned_group(state):
    if not state['group'].startswith('rg-makinari-qa-'):
        raise RuntimeError('Invalid QA group')
    exists = azure('group', 'exists', '-n', state['group'], '--subscription', state['subscription'])
    if not exists:
        return None
    group = azure('group', 'show', '-n', state['group'], '--subscription', state['subscription'])
    tags = group.get('tags', {})
    if tags.get('purpose') != 'disposable-qa' or tags.get('environmentId') != state['id'] or tags.get('expiresAt') != state['expiresAt']:
        raise RuntimeError('QA ownership tags do not match; refusing operation')
    return group


def package(directory, schema):
    source = pathlib.Path(json.loads((directory / 'source.json').read_text())['root'])
    revisions = {}
    with tempfile.TemporaryDirectory() as temp:
        staging = pathlib.Path(temp)
        for repo in ['market-fit', 'API', 'Workflows']:
            checkout = source / repo
            dirty = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True, check=True)
            if dirty.stdout.strip():
                raise RuntimeError(repo + ' checkout is dirty; commit/review changes explicitly before QA packaging')
            revisions[repo] = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
            archive = staging / (repo + '.tar')
            with archive.open('wb') as stream:
                subprocess.run(['git', '-C', str(checkout), 'archive', '--format=tar', '--prefix=' + repo + '/', 'HEAD'], stdout=stream, check=True)
            with tarfile.open(archive) as tar:
                # git archive of an owned checkout, never an external archive.
                tar.extractall(staging)
            archive.unlink()
            for file in (staging / repo).rglob('.env*'):
                if file.is_file() and not file.name.endswith('example'):
                    file.unlink()
        import shutil
        target = staging / 'makinari-db-scheme/supabase'
        target.mkdir(parents=True)
        shutil.copy2(schema / 'supabase/config.toml', target / 'config.toml')
        (target / 'migrations').mkdir()
        # Never transfer seeds, backups, Vault contents, function code or linked-project metadata.
        for migration in (schema / 'supabase/migrations').glob('*.sql'):
            shutil.copy2(migration, target / 'migrations' / migration.name)
        for name in ['install.sh', 'init-workspace.sh', 'start-workspace.sh']:
            shutil.copy2(ROOT / name, staging / name)
        shutil.copytree(ROOT / 'scripts', staging / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
        (staging / '.installer').mkdir(mode=0o700)
        shutil.copy2(directory / '.installer/credentials.json', staging / '.installer/credentials.json')
        output = directory / 'installer-bundle.tar.gz'
        with tarfile.open(output, 'w:gz') as tar:
            for child in staging.iterdir():
                tar.add(child, arcname=child.name)
        output.chmod(0o600)
    (directory / 'revisions.json').write_text(json.dumps(revisions, indent=2) + '\n')
    print('Installer bundle prepared from clean committed service revisions; credentials remain private.')


def bootstrap(directory, state):
    if not owned_group(state) or not state.get('cleanupVerified') or not state.get('privateConfigUploaded'):
        raise RuntimeError('Verified VM identity, expiry and private upload required')
    options = ['-i', state['sshKey'], '-o', 'StrictHostKeyChecking=yes',
               '-o', 'UserKnownHostsFile=' + str(directory / 'known_hosts'), '-o', 'ConnectTimeout=15']
    host = state['sshUser'] + '@' + state['publicIp']
    script = ('set -eu; cd ~/qa; sudo bash scripts/azure-host-bootstrap.sh >host-bootstrap.log 2>&1; '
              'sudo usermod -aG docker "$USER"; '
              'tar -xzf installer-bundle.tar.gz; '
              'sg docker -c "bash install.sh --existing-config" >installer-run.log 2>&1; '
              'nohup sg docker -c "bash install.sh --start" >>installer-run.log 2>&1 </dev/null & '
              'echo $! >installer.pid; sleep 15; kill -0 "$(cat installer.pid)"')
    r = subprocess.run(['ssh', *options, host, script], capture_output=True, text=True, timeout=1200)
    if r.returncode:
        raise RuntimeError('Remote installer bootstrap failed; private logs retained in ~/qa')
    state['state'] = 'installer-startup-observed-not-qa-ready'
    (directory / 'azure-state.json').write_text(json.dumps(state, indent=2) + '\n')
    print('Remote installer started. Inspect status; this is not proof of app, DB or E2E readiness.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['package', 'bootstrap', 'status', 'destroy'])
    parser.add_argument('--qa-id', required=True)
    parser.add_argument('--schema-dir')
    args = parser.parse_args()
    import re
    if not re.fullmatch(r'qa-[a-zA-Z0-9_-]+', args.qa_id):
        raise RuntimeError('Invalid QA ID')
    directory = ROOT / '.installer/qa' / args.qa_id
    if args.action == 'package':
        package(directory, pathlib.Path(args.schema_dir))
        return
    state_file = directory / 'azure-state.json'
    if not state_file.exists():
        print('QA configuration exists; no Azure provisioning state recorded.')
        return
    state = json.loads(state_file.read_text())
    group = owned_group(state)
    if args.action == 'status':
        print(json.dumps({'id': state['id'], 'state': state['state'], 'groupExists': bool(group),
                          'expiresAt': state['expiresAt'], 'cleanupVerified': state.get('cleanupVerified'),
                          'qaReady': state.get('qaReady', False)}, indent=2))
    elif args.action == 'bootstrap':
        bootstrap(directory, state)
    else:
        if group:
            azure('group', 'delete', '-n', state['group'], '--subscription', state['subscription'], '--yes', '--no-wait')
            for _ in range(90):
                if not azure('group', 'exists', '-n', state['group'], '--subscription', state['subscription']):
                    break
                time.sleep(5)
            else:
                raise RuntimeError('Deletion requested but not confirmed; inspect exact QA group')
        state['state'] = 'deleted-confirmed'
        state['deletedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        state['qaReady'] = False
        state_file.write_text(json.dumps(state, indent=2) + '\n')
        print('QA group deletion confirmed; no infrastructure remains for this environment.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error))
        raise SystemExit(1)