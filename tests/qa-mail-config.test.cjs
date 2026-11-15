const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('QA normalizes legacy mail for CLI 3.x, preserves modern settings and rejects ambiguous mail before writing', () => {
  const script = `
import pathlib,runpy,sys,tempfile,tomllib
m=runpy.run_path(sys.argv[1])
base='''project_id = "makinari-qa"
[db.seed]
enabled = false
[MAIL] # local test transport
enabled = true
port = 54324
smtp_port = 54325
[auth]
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = []
[auth.email]
enable_confirmations = false
'''
with tempfile.TemporaryDirectory() as temp:
    root=pathlib.Path(temp)
    for section in ['inbucket','local_smtp']:
        folder=root/section; folder.mkdir()
        original=base.replace('MAIL',section)
        source=folder/'original.toml'; source.write_text(original)
        target=folder/'config.toml'; target.write_text(original)
        m['configure'](target)
        assert source.read_text()==original
        cfg=tomllib.loads(target.read_text())
        assert 'inbucket' not in cfg
        assert cfg['local_smtp']=={'enabled':True,'port':54324,'smtp_port':54325}
        assert '[local_smtp] # local test transport' in target.read_text()
        assert cfg['auth']['email']['enable_confirmations'] is True
        assert cfg['auth']['additional_redirect_urls']==m['REDIRECTS']
        assert set(cfg['auth']['email']['template'])=={'confirmation','recovery'}
    legacy=base.replace('MAIL','inbucket')
    invalid=[legacy+'\\n[local_smtp]\\nenabled=true\\nport=54324\\n',
             legacy.replace('[inbucket]','[unknown_mail]'),
             legacy.replace('port = 54324','port = 2525'),
             legacy.replace('[inbucket] # local test transport\\nenabled = true',
                            '[inbucket] # local test transport\\nenabled = false')]
    for i,text in enumerate(invalid):
        folder=root/str(i); folder.mkdir(); target=folder/'config.toml'; target.write_text(text)
        try: m['configure'](target)
        except ValueError: pass
        else: raise AssertionError('Unsafe mail config accepted '+str(i))
        assert target.read_text()==text
        assert not (folder/'templates').exists()
print('QA mail compatibility checks passed')
`;
  const result = spawnSync('python3', ['-c', script, path.join(__dirname, '../scripts/qa-auth-config.py')], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('QA mail compatibility checks passed');
});