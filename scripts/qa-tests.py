#!/usr/bin/env python3
"""Installer-owned test provision/run operations for the exact disposable VM."""
import argparse
import datetime as dt
import importlib.util
import json
import pathlib
import shlex
import subprocess
import tarfile
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]


def connection(directory):
    state = json.loads((directory / 'azure-state.json').read_text())
    spec = importlib.util.spec_from_file_location('lifecycle', ROOT / 'scripts/qa-lifecycle.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not module.owned_group(state) or not state.get('cleanupVerified'):
        raise RuntimeError('Verified disposable QA group and expiry are required')
    remaining = (dt.datetime.fromisoformat(state['expiresAt']) - dt.datetime.now(dt.timezone.utc)).total_seconds()
    options = ['-i', state['sshKey'], '-o', 'StrictHostKeyChecking=yes',
               '-o', 'UserKnownHostsFile=' + str(directory / 'known_hosts'), '-o', 'ConnectTimeout=15']
    return state, options, state['sshUser'] + '@' + state['publicIp'], remaining


def ssh(options, host, command, timeout=60):
    result = subprocess.run(['ssh', *options, host, command], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('QA remote operation failed; inspect private per-environment logs')
    return result.stdout


def upload(directory, options, host):
    source = pathlib.Path(json.loads((directory / 'source.json').read_text())['root']) / 'market-fit'
    # Explicit testing-only overlay: no unrelated working-tree application changes.
    paths = [source / 'scripts/e2e', source / 'tests', source / 'auth.setup.ts', source / 'playwright.config.ts']
    local = ROOT.parent / 'market-fit'
    for file in (local / 'scripts/e2e').glob('provision-qa*.cjs'):
        paths.append(file)
    with tempfile.TemporaryDirectory() as temp:
        bundle = pathlib.Path(temp) / 'qa-tests.tar.gz'
        with tarfile.open(bundle, 'w:gz') as archive:
            for item in paths:
                if not item.exists():
                    raise RuntimeError('Missing authored QA input: ' + item.name)
                base = local if item.is_relative_to(local) else source
                def safe(info):
                    if any(part in ['node_modules', '.runtime', '.auth'] for part in pathlib.PurePosixPath(info.name).parts):
                        return None
                    if info.name.endswith('.yaml.spec.ts'):
                        return None
                    return info
                archive.add(item, arcname=str(item.relative_to(base)), filter=safe)
        result = subprocess.run(['scp', *options, str(bundle), host + ':~/qa/qa-tests.tar.gz'], capture_output=True, timeout=180)
        if result.returncode:
            raise RuntimeError('Private testing overlay transfer failed')
    ssh(options, host, 'cd ~/qa/market-fit && tar -xzf ../qa-tests.tar.gz')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['provision', 'run', 'results'])
    parser.add_argument('--qa-id', required=True)
    parser.add_argument('--suite', choices=['smoke', 'buyer', 'roles', 'regression'])
    args = parser.parse_args()
    import re
    if not re.fullmatch(r'qa-[a-zA-Z0-9_-]+', args.qa_id):
        raise RuntimeError('Invalid QA environment ID')
    directory = ROOT / '.installer/qa' / args.qa_id
    state, options, host, remaining = connection(directory)
    if args.action == 'results':
        # Never print engine logs, tokens, fixtures env or raw Playwright/vendor JSON.
        output = ssh(options, host, "cd ~/qa/market-fit; node -e 'const fs=require(\"fs\");const p=\"shiplight-report\";if(fs.existsSync(p))for(const n of fs.readdirSync(p)){const f=p+\"/\"+n+\"/run-summary.json\";if(fs.existsSync(f)){const s=JSON.parse(fs.readFileSync(f));console.log(JSON.stringify({runId:s.runId,suite:s.suite,state:s.state,counts:s.counts,complete:s.complete,healthGreen:s.healthGreen}));}}'")
        print(output.strip() or 'No completed suite reports yet.')
        return
    required = 7500 if args.action == 'run' and args.suite == 'regression' else 900
    if remaining < required:
        raise RuntimeError('Insufficient time before automatic expiry; do not extend or start mutations silently')
    if args.action == 'provision':
        upload(directory, options, host)
        # Root installer configuration is local-only; provider secrets never enter the test logs.
        cmd = ('cd ~/qa/market-fit; QA_ENVIRONMENT_ID=' + shlex.quote(args.qa_id)
               + ' QA_EXPIRES_AT=' + shlex.quote(state['expiresAt'])
               + ' TEST_TARGET=local TEST_ALLOW_MUTATIONS=1 TEST_DISPOSABLE_ENVIRONMENT=1 '
               + 'node scripts/e2e/provision-qa.cjs >../qa-provision.log 2>&1')
        ssh(options, host, cmd, timeout=300)
        print('Initial QA fixture battery completed; private credentials/journal retained on the VM.')
    else:
        run_id = args.qa_id + '-' + args.suite + '-' + uuid.uuid4().hex[:8]
        # Fixture env is parsed in-memory, not sourced into a shell or printed.
        runner = """const fs=require('fs'),cp=require('child_process');
const id=process.env.QA_ENVIRONMENT_ID;
const env=JSON.parse(fs.readFileSync('.auth/qa-fixtures/'+id+'/env.json'));
const r=cp.spawnSync(process.execPath,['scripts/e2e/run.cjs','--suite',process.env.QA_SUITE,'--target','local'],
{env:{...process.env,...env,SHIPLIGHT_RUN_ID:process.env.QA_RUN_ID},stdio:'inherit'});
process.exit(r.status??1);
"""
        quoted = shlex.quote(runner)
        cmd = ('cd ~/qa/market-fit; QA_ENVIRONMENT_ID=' + shlex.quote(args.qa_id)
               + ' QA_SUITE=' + args.suite + ' QA_RUN_ID=' + run_id
               + ' nohup node -e ' + quoted + ' >../' + run_id + '.log 2>&1 </dev/null & echo test-run-started')
        ssh(options, host, cmd)
        print('Suite launched: ' + run_id + '. Use ./install.sh qa results --id ' + args.qa_id)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error))
        raise SystemExit(1)