#!/usr/bin/env python3
"""Configure only the temporary Supabase copy used for fresh disposable QA."""
import json
import pathlib
import re
import tomllib


SITE_URL = 'http://127.0.0.1:3000'
REDIRECTS = [SITE_URL + path for path in
             ['/auth/callback', '/auth/confirm', '/auth/reset-password']]


def replace_setting(text, section, key, value):
    """Retain unrelated settings/comments; parsed TOML is validated first."""
    header = re.compile(r'^\[' + re.escape(section) + r'\]\s*(?:#.*)?$', re.M)
    match = header.search(text)
    if not match:
        raise ValueError('Required QA configuration section missing: ' + section)
    following = re.search(r'^\[', text[match.end():], re.M)
    end = match.end() + following.start() if following else len(text)
    body = text[match.end():end]
    # Support multiline redirect arrays without rewriting the rest of [auth].
    pattern = (r'^\s*' + re.escape(key) + r'\s*=\s*'
               + (r'\[[\s\S]*?\]' if key == 'additional_redirect_urls' else r'(?:true|false)')
               + r'[^\S\n]*(?:#.*)?$')
    body, count = re.subn(pattern, '\n' + key + ' = ' + value, body, flags=re.M)
    if not count:
        body = body.rstrip() + '\n' + key + ' = ' + value + '\n\n'
    return text[:match.end()] + body + text[end:]


def configure(config_path):
    """Call only on staging/config.toml, never on an original schema checkout."""
    config_path = pathlib.Path(config_path)
    original = config_path.read_text()
    config = tomllib.loads(original)
    auth = config.get('auth', {})
    if config.get('project_id') != 'makinari-qa' or auth.get('site_url') != SITE_URL:
        raise ValueError('Fresh QA requires project makinari-qa and exact loopback site URL')
    if config.get('db', {}).get('seed', {}).get('enabled') is not False:
        raise ValueError('Fresh QA requires explicitly disabled seeds')
    email = auth.get('email', {})
    templates = email.get('template', {})
    if 'confirmation' in templates or 'recovery' in templates:
        raise ValueError('Existing confirmation/recovery templates cannot be overridden')
    redirects = auth.get('additional_redirect_urls', [])
    if not isinstance(redirects, list) or any(url not in REDIRECTS for url in redirects):
        raise ValueError('Fresh QA redirects must be exact loopback Auth URLs')
    mail_sections = [name for name in ['inbucket', 'local_smtp'] if name in config]
    if len(mail_sections) != 1:
        raise ValueError('Fresh QA requires exactly one local mail configuration section')
    mail_section = mail_sections[0]
    local_mail = config[mail_section]
    if local_mail.get('enabled') is not True or local_mail.get('port') != 54324:
        raise ValueError('Fresh QA requires enabled local mail on port 54324')
    files = {kind: config_path.parent / 'templates' / ('qa-' + kind + '.html')
             for kind in ['confirmation', 'recovery']}
    if any(file.exists() for file in files.values()):
        raise ValueError('Fresh QA template files already exist; refusing overwrite')
    # CLI 3.x rejects [inbucket]. Normalize only this staging copy, preserving
    # the actual mail transport settings and the established mailbox endpoint.
    updated = original
    if mail_section == 'inbucket':
        updated, count = re.subn(r'^\[inbucket\](\s*(?:#.*)?)$',
                                 r'[local_smtp]\1', updated, flags=re.M)
        if count != 1:
            raise ValueError('Fresh QA local mail section normalization failed')
    updated = replace_setting(updated, 'auth', 'additional_redirect_urls', json.dumps(REDIRECTS))
    updated = replace_setting(updated, 'auth.email', 'enable_confirmations', 'true')
    for kind in files:
        updated += ('\n[auth.email.template.' + kind + ']\n'
                    + 'subject = "QA ' + kind + '"\n'
                    + 'content_path = "./supabase/templates/qa-' + kind + '.html"\n')
    parsed = tomllib.loads(updated)
    if 'inbucket' in parsed or parsed.get('local_smtp') != local_mail:
        raise ValueError('Fresh QA local mail configuration was not preserved')
    if parsed['auth']['email']['enable_confirmations'] is not True:
        raise ValueError('Fresh QA email confirmation override failed')
    for kind, file in files.items():
        file.parent.mkdir(exist_ok=True)
        email_type = 'email' if kind == 'confirmation' else 'recovery'
        link = ('{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}'
                + '&amp;type=' + email_type + '&amp;returnTo=%2Fprojects')
        file.write_text('<!doctype html><html><body><a href="' + link
                        + '">Continue ' + kind + '</a></body></html>\n')
        # Kong serves these static templates from a read-only bind mount under
        # a different UID. They contain template expressions, never credentials.
        file.chmod(0o644)
    config_path.write_text(updated)