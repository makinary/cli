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


def required_seconds(suite):
    return {'regression': 7500, 'account-lifecycle': 1500,
            'procurement': 1800, 'subsystems': 1800}.get(suite, 900)


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


def ssh(options, host, command, timeout=60, input_text=None):
    result = subprocess.run(['ssh', *options, host, command], capture_output=True, text=True,
                            timeout=timeout, input=input_text)
    if result.returncode:
        raise RuntimeError('QA remote operation failed; inspect private per-environment logs')
    return result.stdout


def private_json(file, value):
    """Create mode 0600 before writing; atomic replacement preserves previous exports."""
    with tempfile.NamedTemporaryFile(mode='w', dir=file.parent, delete=False) as stream:
        temporary = pathlib.Path(stream.name)
        try:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            temporary.chmod(0o600)
            temporary.replace(file)
        finally:
            temporary.unlink(missing_ok=True)


def export_results(directory, qa_id, suite=None):
    helper = ROOT / 'scripts/qa-evidence.cjs'
    failure = 'REMOTE_EXTRACTION_FAILED'
    try:
        _, options, host, _ = connection(directory)
        # Execute the reviewed dependency-free helper via stdin. No raw report is copied.
        command = 'cd ~/qa/market-fit && node - export ' + shlex.quote(qa_id)
        if suite:
            command += ' ' + shlex.quote(suite)
        output = ssh(options, host, command, timeout=120, input_text=helper.read_text())
        failure = 'LOCAL_VALIDATION_FAILED'
        local_source = ROOT.parent / 'market-fit'
        checked = subprocess.run(['node', str(helper), 'validate', qa_id], cwd=local_source,
                                 input=output, capture_output=True, text=True, timeout=120)
        if checked.returncode:
            raise RuntimeError('Unsafe or invalid diagnostic projection')
        evidence = json.loads(checked.stdout)
    except Exception:
        # Never stringify provider/SSH/JSON errors or substitute logs for test evidence.
        evidence = {'schemaVersion': 1, 'qaId': qa_id, 'runs': [],
                    'extraction': {'status': 'failed', 'errors': [{'code': failure}]}}
        if directory.is_dir():
            private_json(directory / 'test-evidence-error.json', evidence)
        raise RuntimeError('QA evidence extraction failed; safe local error recorded; previous exports retained') from None
    private_json(directory / 'test-evidence.json', evidence)
    summaries = [run['summary'] for run in evidence['runs'] if run['summary'] is not None]
    private_json(directory / 'test-summaries.json', summaries)
    (directory / 'test-evidence-error.json').unlink(missing_ok=True)
    for run in evidence['runs']:
        print(json.dumps({'runId': run['runId'], 'suite': run['suite'], 'summary': run['summary'],
                          'detailCount': run['detailCount'], 'extraction': run['extraction']}))
    if not evidence['runs']:
        print('No exact suite reports yet; see test-evidence.json extraction errors.')
    print('Safe local export: test-evidence.json and test-summaries.json. Review extraction status before destruction.')
    if evidence['extraction']['status'] != 'ok':
        raise RuntimeError('QA evidence is incomplete; see safe extraction error codes; do not infer missing results')


def upload(directory, options, host):
    source = pathlib.Path(json.loads((directory / 'source.json').read_text())['root']) / 'market-fit'
    # Explicit testing-only overlay: no unrelated working-tree application changes.
    paths = [source / 'scripts/e2e', source / 'tests', source / 'auth.setup.ts', source / 'playwright.config.ts']
    local = ROOT.parent / 'market-fit'
    for file in (local / 'scripts/e2e').glob('provision-qa*.cjs'):
        paths.append(file)
    # Shiplight fixture requires model configuration even for cached deterministic steps.
    # Explicit allowlist only; no application/DB/Stripe credentials are imported here.
    env_module = local / 'node_modules/dotenv'
    result = subprocess.run(['node', '-e',
        "const fs=require('fs'),d=require(process.argv[1]);const e=d.parse(fs.readFileSync(process.argv[2]));"
        "const keys=['SHIPLIGHT_API_TOKEN','GOOGLE_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','WEB_AGENT_MODEL'];"
        "process.stdout.write(JSON.stringify(Object.fromEntries(keys.filter(k=>e[k]).map(k=>[k,e[k]]))));",
        str(env_module), str(local / '.env.local')], capture_output=True, text=True, check=True)
    model_values = json.loads(result.stdout)
    if model_values:
        file = directory / 'shiplight-model.json'
        file.write_text(json.dumps(model_values))
        file.chmod(0o600)
        result = subprocess.run(['scp', *options, str(file), host + ':~/qa/shiplight-model.json'], capture_output=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Private Shiplight model configuration transfer failed')
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
    parser.add_argument('--suite', choices=['smoke', 'buyer', 'roles', 'regression', 'project-lifecycle', 'account-lifecycle', 'procurement', 'subsystems'])
    args = parser.parse_args()
    import re
    if not re.fullmatch(r'qa-[a-zA-Z0-9_-]+', args.qa_id):
        raise RuntimeError('Invalid QA environment ID')
    directory = ROOT / '.installer/qa' / args.qa_id
    if args.action == 'results':
        export_results(directory, args.qa_id, args.suite)
        return
    state, options, host, remaining = connection(directory)
    required = required_seconds(args.suite) if args.action == 'run' else 1500
    if remaining < required:
        raise RuntimeError('Insufficient time before automatic expiry; do not extend or start mutations silently')
    if args.action == 'provision':
        upload(directory, options, host)
        # Use the lockfile-installed CLI/browser revision; never fetch another npm package.
        ssh(options, host,
            'cd ~/qa/market-fit && npx --no-install playwright install --with-deps chromium >../qa-browser-install.log 2>&1',
            timeout=600)
        # Root installer configuration is local-only; provider secrets never enter the test logs.
        cmd = ('cd ~/qa/market-fit; QA_ENVIRONMENT_ID=' + shlex.quote(args.qa_id)
               + ' QA_EXPIRES_AT=' + shlex.quote(dt.datetime.fromisoformat(state['expiresAt']).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
               + ' QA_DB_CONTAINER=supabase_db_makinari-qa TEST_BASE_URL=http://127.0.0.1:3000 TEST_COMMERCE_BASE_URL=http://127.0.0.1:3000 '
               + 'QA_ALLOW_SMOKE_ADJUSTMENTS=1 '
               + 'TEST_TARGET=local TEST_ALLOW_MUTATIONS=1 TEST_DISPOSABLE_ENVIRONMENT=1 '
               + 'sg docker -c "node scripts/e2e/provision-qa.cjs --apply" >../qa-provision.log 2>&1')
        ssh(options, host, cmd, timeout=300)
        print('Initial QA fixture battery completed; private credentials/journal retained on the VM.')
    else:
        run_id = args.qa_id + '-' + args.suite + '-' + uuid.uuid4().hex[:8]
        # Fixture env is parsed in-memory, not sourced into a shell or printed.
        runner = """const fs=require('fs'),cp=require('child_process');
const id=process.env.QA_ENVIRONMENT_ID;
const fixtures=JSON.parse(fs.readFileSync('.auth/qa-fixtures/'+id+'/env.json'));
const suite=process.env.QA_SUITE;
const nativeModule=['procurement','subsystems'].includes(suite);
const model=!nativeModule&&fs.existsSync('../shiplight-model.json')?JSON.parse(fs.readFileSync('../shiplight-model.json')):{};
if(fixtures.QA_STATUS!=='VERIFIED'||fixtures.QA_ENVIRONMENT_ID!==id)throw Error('Verified fixture battery required');
const env={...process.env,...fixtures,...model};
const mutating=['roles','regression','project-lifecycle','account-lifecycle','procurement','subsystems'].includes(suite);
env.TEST_ALLOW_MUTATIONS=mutating?'1':'0';
env.TEST_DISPOSABLE_ENVIRONMENT=mutating?'1':'0';
env.TEST_ALLOW_PROJECT_LIFECYCLE=suite==='project-lifecycle'?'1':'0';
env.TEST_ALLOW_ACCOUNT_LIFECYCLE=suite==='account-lifecycle'?'1':'0';
env.QA_EXPIRES_AT=process.env.QA_EXPIRES_AT;
delete env.TEST_INBUCKET_URL;
if(suite==='account-lifecycle')env.TEST_INBUCKET_URL='http://127.0.0.1:54324';
const r=cp.spawnSync(process.execPath,['scripts/e2e/run.cjs','--suite',process.env.QA_SUITE,'--target','local'],
{env:{...env,SHIPLIGHT_RUN_ID:process.env.QA_RUN_ID},stdio:'inherit'});
process.exit(r.status??1);
"""
        suite = args.suite
        if not suite:
            raise RuntimeError('Explicit suite required')
        active = ssh(options, host, "pgrep -af 'scripts/e2e/run.cjs' | grep -v pgrep || true")
        if active.strip():
            raise RuntimeError('Another suite is active; shared fixtures require sequential execution')
        quoted = shlex.quote(runner)
        cmd = ('cd ~/qa/market-fit; QA_ENVIRONMENT_ID=' + shlex.quote(args.qa_id)
               + ' QA_EXPIRES_AT=' + shlex.quote(dt.datetime.fromisoformat(state['expiresAt']).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
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