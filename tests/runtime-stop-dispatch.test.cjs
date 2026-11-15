const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('installer stop dispatches only to the canonical local root without configuring or signalling PIDs', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'makinari-stop-dispatch-')));
  try {
    fs.copyFileSync(path.join(__dirname, '../install.sh'), path.join(root, 'install.sh'));
    fs.mkdirSync(path.join(root, 'scripts'));
    // Test the CLI boundary only; no managed service is started or stopped.
    fs.writeFileSync(path.join(root, 'scripts/runtime-control.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const result = spawnSync('bash', [path.join(root, 'install.sh'), '--stop'], {
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['stop', '--root', root]);
    expect(fs.existsSync(path.join(root, '.installer'))).toBe(false);
    const extra = spawnSync('bash', [path.join(root, 'install.sh'), '--stop', '--unexpected'], {
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(JSON.parse(extra.stdout)).toEqual(['stop', '--root', root, '--unexpected']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});