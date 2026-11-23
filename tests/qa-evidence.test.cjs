const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { exportEnvironment, validateExport, sourceCatalog, safeEndpoint, diagnostic } = require('../scripts/qa-evidence.cjs');

const qaId = 'qa-123456-deadbeef';
const runId = `${qaId}-regression-1234abcd`;
const PRIVATE = ['private-token-XYZ', 'private.password!XYZ', 'private-user@example.invalid',
  'private-query-value', 'PRIVATE_PROVIDER_BODY', 'PRIVATE_HEADER', 'PRIVATE_LOCATOR_VALUE'];
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-evidence-'));
  write('tests/support/read-assertions.ts', [
    'export async function check(page) {',
    `await expect(page.locator('input[name="PRIVATE_LOCATOR_VALUE"]')).toBeVisible();`,
    `await page.goto('http://user:private.password!XYZ@localhost:3000/auth/confirm?token=private-token-XYZ');`,
    '}',
  ].join('\n'));
  write('tests/crud-lead.test.yaml', 'title: reviewed source\n');
  write('auth.setup.ts', '// setup\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function write(file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}
function key(spec, projectName = 'admin') {
  return JSON.stringify([projectName, spec.file.replace(/\\/g, '/'), spec.line, spec.column, 'suite secret ' + PRIVATE[0], spec.title]);
}
function fixture(options = {}) {
  const id = options.id || runId;
  const suite = options.suite || 'regression';
  const project = options.project || 'admin';
  const spec = { file: options.file || 'tests/crud-lead.yaml.spec.ts', line: 4, column: 2, title: PRIVATE.join(' '), tests: [] };
  const message = `Error: expect(locator).toBeVisible() failed\n${PRIVATE.join(' ')}\n` +
    `https://external.invalid/secret/private-token-XYZ?token=private-query-value\n` +
    `    at secretFunction (file://${root}/tests/support/read-assertions.ts:2:7)\n` +
    `    at ${root}/node_modules/private-token-XYZ.ts:8:9\n`;
  const result = { status: 'failed', duration: 25, retry: 0, workerIndex: 0,
    error: { message, stack: message, location: { file: path.join(root, 'tests/support/read-assertions.ts'), line: 2, column: 7 },
      url: 'https://user:private.password!XYZ@external.invalid/auth/confirm?token=private-token-XYZ', body: PRIVATE[4] },
    errors: [{ message: `TypeError: ${PRIVATE.join(' ')}\n    at ${root}/tests/support/read-assertions.ts:3:5` }],
    stdout: [{ text: PRIVATE.join(' ') }], stderr: [{ text: PRIVATE.join(' ') }],
    attachments: [{ name: PRIVATE[0], body: PRIVATE[4], path: PRIVATE[2] }],
    steps: [{ title: `Fill ${PRIVATE.join(' ')}`, duration: 10,
      location: { file: 'tests/support/read-assertions.ts', line: 2, column: 7 },
      error: { name: 'TimeoutError', message: PRIVATE.join(' ') }, steps: [{ title: PRIVATE[1], duration: 1,
        error: { message: `Error: locator.click: Error: strict mode violation: ${PRIVATE.join(' ')}\n    at ${root}/tests/support/read-assertions.ts:2:7` } }] }],
  };
  spec.tests = [{ projectName: project, expectedStatus: 'passed', status: 'unexpected', results: [result] }];
  const manifest = { runId: id, suite, target: 'local', mode: 'run',
    expected: [key(spec, project)], selected: [key(spec, project)], selectedSetup: [], baseURL: PRIVATE[0], failure: PRIVATE[4] };
  const summary = { runId: id, suite, target: 'local', state: 'finished',
    counts: { passed: 0, flaky: 0, failed: 1, skipped: 0, blocked: 0 }, expectedCount: 1, selectedCount: 1,
    missing: 0, unexpected: 0, scope: 'full', complete: true, healthGreen: false, failure: PRIVATE.join(' '),
    cloud: { error: PRIVATE[4], url: PRIVATE[0] } };
  const report = { suites: [{ title: 'suite secret ' + PRIVATE[0], specs: [spec] }], errors: [] };
  const save = () => {
    write(`shiplight-report/${id}/run-manifest.json`, manifest);
    write(`shiplight-report/${id}/run-summary.json`, summary);
    write(`shiplight-report/${id}/playwright.json`, report);
  };
  save();
  return { spec, result, manifest, summary, report, save };
}
function exported(options = {}) { return exportEnvironment(qaId, { sourceRoot: root, ...options }); }
function noLeak(value) {
  const text = JSON.stringify(value);
  for (const secret of PRIVATE) expect(text).not.toContain(secret);
  expect(text).not.toContain(root);
  for (const forbidden of ['https://', 'http://', 'file://', 'stdout', 'stderr', 'attachments', 'message', 'stack', 'title', 'body', 'headers']) {
    expect(text).not.toContain(forbidden);
  }
}

const modulePaths = ['tests/procurement/tender-ui.spec.ts', 'tests/procurement/participation.spec.ts',
  'tests/procurement/sealed.spec.ts', 'tests/procurement/boundaries.spec.ts',
  'tests/subsystems/pos-customer.spec.ts', 'tests/subsystems/lead-quotation.spec.ts',
  'tests/support/qa-module-policy.ts', 'tests/support/procurement-policy.ts',
  'tests/support/procurement-fixtures.ts', 'tests/support/procurement-ui.ts', 'tests/support/subsystem-crossflows.ts',
  'tests/procurement/mapped-order.spec.ts', 'tests/procurement/certification-sharing.spec.ts',
  'tests/procurement/invitations-amendment.spec.ts', 'tests/procurement/rejection.spec.ts',
  'tests/support/procurement-expansion.ts', 'tests/subsystems/pos-customer-cancel.spec.ts',
  'tests/smoke/account-reads.spec.ts', 'tests/smoke/module-reads.spec.ts', 'tests/smoke/visits.spec.ts'];

test('source discovery accepts exact reviewed module files only, not directory patterns or symlinks', () => {
  for (const file of modulePaths) write(file, '// reviewed native harness\n');
  const unknown = ['tests/procurement/private-token-XYZ.spec.ts', 'tests/subsystems/unknown.spec.ts',
    'tests/support/procurement-secret.ts', 'tests/support/subsystem-secret.ts'];
  for (const file of unknown) write(file, '// not reviewed\n');
  const catalog = sourceCatalog(root);
  for (const file of modulePaths) expect(catalog.has(file)).toBe(true);
  for (const file of unknown) expect(catalog.has(file)).toBe(false);
  const reviewed = modulePaths[0];
  fs.unlinkSync(path.join(root, reviewed));
  fs.symlinkSync(path.join(root, unknown[0]), path.join(root, reviewed));
  expect(sourceCatalog(root).has(reviewed)).toBe(false);
  fs.rmSync(path.join(root, 'tests/subsystems'), { recursive: true });
  fs.symlinkSync(path.join(root, 'tests/procurement'), path.join(root, 'tests/subsystems'));
  expect([...sourceCatalog(root).keys()].some(file => file.startsWith('tests/subsystems/'))).toBe(false);
});

test('shared profile image diagnostics allow only the fixed endpoint, without query data', () => {
  expect(safeEndpoint('http://127.0.0.1:3000/api/images/modules/profile?secret=value')).toBe('/api/images/modules/profile');
  expect(safeEndpoint('http://127.0.0.1:3000/api/images/modules/private-token-XYZ')).toBeNull();
});

test.each(['procurement', 'subsystems'])('%s exact native runs preserve safe project/source enums and reject unknown paths', suite => {
  const file = suite === 'procurement' ? modulePaths[0] : modulePaths[4];
  write(file, '// reviewed native harness\n');
  const id = `${qaId}-${suite}-1234abcd`;
  fixture({ id, suite, project: suite, file });
  const value = exported({ suite });
  noLeak(value);
  expect(value.extraction.status).toBe('ok');
  expect(value.runs).toHaveLength(1);
  expect(value.runs[0]).toMatchObject({ runId: id, suite,
    tests: [{ project: suite, source: { file, line: 4, column: 2 } }] });
  expect(validateExport(value, qaId, sourceCatalog(root))).toBe(value);
  const invalid = structuredClone(value);
  invalid.runs[0].tests[0].source.file = `tests/${suite}/unreviewed.spec.ts`;
  expect(() => validateExport(invalid, qaId, sourceCatalog(root))).toThrow('INVALID_EXPORT');
  invalid.runs[0].tests[0].source.file = file;
  invalid.runs[0].tests[0].project = 'unreviewed';
  expect(() => validateExport(invalid, qaId, sourceCatalog(root))).toThrow('INVALID_EXPORT');
});

test.each(['certification-sharing', 'invitations-amendment', 'rejection'])(
  'procurement expansion %s exports only reviewed spec and support locations', name => {
    const file = `tests/procurement/${name}.spec.ts`;
    const support = 'tests/support/procurement-expansion.ts';
    write(file, '// reviewed native spec\n');
    write(support, '// reviewed native helper\n');
    const f = fixture({ id: `${qaId}-procurement-1234abcd`, suite: 'procurement', project: 'procurement', file });
    f.result.error.location = { file: support, line: 1, column: 1 };
    f.result.errorLocation = { file: support, line: 1, column: 1 };
    f.save();
    const value = exported({ suite: 'procurement' });
    noLeak(value);
    expect(value.extraction.status).toBe('ok');
    expect(value.runs[0].tests[0]).toMatchObject({ source: { file, line: 4, column: 2 },
      attempts: [{ errorLocation: { file: support, line: 1, column: 1 } }] });
    expect(validateExport(value, qaId, sourceCatalog(root))).toBe(value);
    const invalid = structuredClone(value);
    invalid.runs[0].tests[0].attempts[0].errorLocation.file = 'tests/support/procurement-expansion-private.ts';
    expect(() => validateExport(invalid, qaId, sourceCatalog(root))).toThrow('INVALID_EXPORT');
    fs.unlinkSync(path.join(root, file));
    fs.unlinkSync(path.join(root, support));
    expect(sourceCatalog(root).has(file)).toBe(false);
    expect(sourceCatalog(root).has(support)).toBe(false);
  });

test('exact-run projection omits all raw data and retains precise code/step locations and enums', () => {
  fixture();
  const value = exported();
  noLeak(value);
  expect(value.extraction.status).toBe('ok');
  expect(value.runs).toHaveLength(1);
  const run = value.runs[0];
  expect(run.summary).toMatchObject({ expectedCount: 1, selectedCount: 1, missing: 0, counts: { failed: 1 } });
  const test = run.tests[0];
  expect(test).toMatchObject({ caseId: 'selected-1', project: 'admin', outcome: 'failed',
    source: { file: 'tests/crud-lead.yaml.spec.ts', line: 4, column: 2 } });
  const attempt = test.attempts[0];
  expect(attempt.errors[0]).toMatchObject({ classification: 'ASSERTION_FAILED', matcher: 'toBeVisible',
    locatorProperty: 'name', endpointPath: '/auth/confirm', locations: [{ file: 'tests/support/read-assertions.ts', line: 2, column: 7 }] });
  expect(attempt.errors[1]).toMatchObject({ classification: 'TYPE_ERROR', endpointPath: '/auth/confirm',
    locations: [{ file: 'tests/support/read-assertions.ts', line: 3, column: 5 }] });
  expect(attempt.steps[0]).toMatchObject({ indexPath: [0], location: { file: 'tests/support/read-assertions.ts', line: 2 },
    errors: [{ classification: 'TIMEOUT' }] });
  expect(attempt.steps[0].steps[0]).toMatchObject({ indexPath: [0, 0], errors: [{ classification: 'LOCATOR_STRICT_MODE' }] });
  expect(validateExport(value, qaId, sourceCatalog(root))).toBe(value);
});

test('summary counts are preserved; missing results explicitly have no invented attempts', () => {
  const f = fixture();
  const missingKey = JSON.stringify(['admin', f.spec.file, 80, 3, 'suite secret ' + PRIVATE[0], 'missing ' + PRIVATE[1]]);
  f.manifest.expected.push(missingKey, JSON.stringify(['admin', f.spec.file, 90, 3, '', 'not selected']));
  f.manifest.selected.push(missingKey);
  Object.assign(f.summary, { expectedCount: 3, selectedCount: 2, missing: 1, scope: 'partial', complete: false });
  f.summary.counts.blocked = 1;
  f.save();
  const value = exported();
  noLeak(value);
  expect(value.runs[0].summary).toMatchObject({ expectedCount: 3, selectedCount: 2, missing: 1 });
  expect(value.runs[0]).toMatchObject({ detailCount: 1, selectedMissingCount: 1,
    extraction: { status: 'partial', errors: [{ code: 'MISSING_SELECTED_RESULTS' }] } });
  expect(value.runs[0].tests[1]).toMatchObject({ outcome: 'unavailable', present: false, attempts: [] });
});
test('classifies the exact observer contract and masks missing chunk identity without extracting provider text', () => {
  const f = fixture();
  f.result.errors = [{ message: 'Error: Unexpected application/dependency failures; a rendered page is not a healthy read\n' + PRIVATE.join(' '),
    endpointPath: '/_next/static/chunks/' + PRIVATE[0] + '.js' }];
  f.save();
  const value = exported();
  noLeak(value);
  expect(value.runs[0].tests[0].attempts[0].errors[1]).toMatchObject({ classification: 'READ_DEPENDENCY_FAILURE', endpointPath: '/_next/static/[redacted]' });
});

test('retries, blocked markers, failed setup, skipped and interrupted follow the existing report model', () => {
  const f = fixture();
  f.result.error = undefined; f.result.errors = []; f.result.steps = [];
  Object.assign(f.result, { status: 'passed' });
  f.spec.tests[0].results.push({ status: 'passed', retry: 1 });
  f.summary.counts.failed = 0; f.summary.counts.flaky = 1;
  f.save();
  expect(exported().runs[0].tests[0].outcome).toBe('flaky');
  const setup = { file: 'auth.setup.ts', line: 1, column: 1, title: PRIVATE[1],
    tests: [{ projectName: 'setup', status: 'unexpected', results: [{ status: 'failed', error: { message: '[E2E_BLOCKED] ' + PRIVATE[0] } }] }] };
  f.report.suites[0].specs.push(setup);
  f.manifest.selectedSetup = [key(setup, 'setup')];
  f.spec.tests[0].results = [{ status: 'skipped', workerIndex: 0 }];
  f.save();
  const value = exported();
  noLeak(value);
  expect(value.runs[0].tests.map(test => test.outcome)).toEqual(['blocked', 'blocked']);
  expect(value.runs[0].tests[1].attempts[0].errors[0].classification).toBe('E2E_BLOCKED');
  f.manifest.selectedSetup = []; f.report.suites[0].specs.pop();
  for (const [result, outcome] of [[{ status: 'skipped', workerIndex: 0 }, 'skipped'],
    [{ status: 'skipped', workerIndex: -1 }, 'blocked'], [{ status: 'interrupted' }, 'blocked'],
    [{ status: 'timedOut' }, 'failed']]) {
    f.spec.tests[0].results = [result]; f.save();
    expect(exported().runs[0].tests[0].outcome).toBe(outcome);
  }
});

test.each(['run-summary.json', 'run-manifest.json', 'playwright.json'])(
  'malformed %s exports an enum, not JSON/parser fragments or log evidence', file => {
    fixture();
    write(`shiplight-report/${runId}/${file}`, `{invalid ${PRIVATE.join(' ')} }`);
    write(`${runId}.log`, PRIVATE.join(' '));
    const value = exported();
    noLeak(value);
    expect(value.runs[0].extraction.status).toBe('partial');
    expect(value.runs[0].extraction.errors.map(error => error.code)).toContain(
      ({ 'run-summary.json': 'SUMMARY_INVALID', 'run-manifest.json': 'MANIFEST_INVALID', 'playwright.json': 'REPORT_INVALID' })[file]);
    if (file !== 'run-summary.json') expect(value.runs[0].tests).toEqual([]);
  });

test('missing report retains original summary counts and unknown extraction counts without log fallback', () => {
  fixture();
  fs.unlinkSync(path.join(root, `shiplight-report/${runId}/playwright.json`));
  write(`${runId}.log`, 'failed test: ' + PRIVATE.join(' '));
  const value = exported();
  expect(value.runs[0]).toMatchObject({ summary: { missing: 0, selectedCount: 1 }, detailCount: 0,
    selectedMissingCount: null, tests: [], extraction: { errors: [{ code: 'REPORT_MISSING' }] } });
  noLeak(value);
});

test('only exact environment run names are exported separately; no health/latest or cross-run fallback', () => {
  fixture();
  fixture({ id: `${qaId}-regression-8765dcba` });
  fixture({ id: `${qaId}-other-regression-aaaaaaaa` });
  fixture({ id: `${qaId}-regression-1234abcd-extra` });
  fixture({ id: 'qa-other-regression-aaaaaaaa' });
  write('shiplight-report/health-local-regression.json', PRIVATE.join(' '));
  const value = exported();
  expect(value.runs.map(run => run.runId)).toEqual([runId, `${qaId}-regression-8765dcba`]);
  noLeak(value);
  expect(exported({ suite: 'smoke' })).toMatchObject({ runs: [], extraction: { errors: [{ code: 'NO_EXACT_RUNS' }] } });
});

test.each(['summary', 'manifest'])('mismatched %s IDs cannot attribute details from another run', kind => {
  const f = fixture();
  f[kind].runId = 'qa-other-regression-aaaaaaaa'; f.save();
  const value = exported();
  expect(value.runs[0].extraction.errors).toContainEqual({ code: `${kind.toUpperCase()}_ID_MISMATCH` });
  if (kind === 'manifest') expect(value.runs[0].tests).toEqual([]);
  noLeak(value);
});

test('count mismatches and duplicate/unexpected reports remain explicit without rewriting summary', () => {
  const f = fixture();
  f.summary.expectedCount = 50; f.summary.selectedCount = 50; f.summary.missing = 2;
  f.save();
  expect(exported().runs[0]).toMatchObject({ summary: { expectedCount: 50, selectedCount: 50, missing: 2 },
    extraction: { errors: [{ code: 'COUNT_MISMATCH' }] } });
  f.report.suites[0].specs.push(f.spec); f.save();
  expect(exported().runs[0]).toMatchObject({ tests: [], extraction: { errors: [{ code: 'DUPLICATE_CASE_KEYS' }] } });
  f.report.suites[0].specs[1] = { ...f.spec, line: 9 }; f.save();
  expect(exported().runs[0]).toMatchObject({ unexpectedCount: 1, extraction: { errors: expect.arrayContaining([{ code: 'UNEXPECTED_RESULTS' }]) } });
});

test('untrusted source/title/function paths are omitted; traversal, sibling and symlink sources are rejected', () => {
  const f = fixture();
  fs.symlinkSync(path.join(root, 'tests/support/read-assertions.ts'), path.join(root, 'tests/support/link.ts'));
  write('tests/' + PRIVATE[0] + '.yaml.spec.ts', '// existing but not reviewed\n');
  f.spec.file = 'tests/' + PRIVATE[0] + '.yaml.spec.ts';
  f.manifest.expected = f.manifest.selected = [key(f.spec)];
  f.result.error.location.file = 'tests/' + PRIVATE[0] + '.ts';
  f.result.error.stack = [
    `    at ${root}/../tests/support/read-assertions.ts:1:1`,
    `    at ${root}-sibling/tests/support/read-assertions.ts:2:2`,
    `    at ${root}/tests/support/link.ts:3:3`,
    `    at file://${root}/tests/support/read-assertions.ts?token=${PRIVATE[0]}:4:4`,
    `    at ${root}/tests/support/read-assertions.ts/../read-assertions.ts:5:5`,
  ].join('\n');
  f.result.error.message = PRIVATE.join(' '); f.result.errors = []; f.result.steps = []; f.save();
  const value = exported();
  noLeak(value);
  expect(value.runs[0].tests[0].source).toBeNull();
  expect(value.runs[0].tests[0].attempts[0].errors[0].locations).toEqual([]);
  expect(value.runs[0].extraction.errors).toContainEqual({ code: 'SOURCE_UNAVAILABLE' });
});

test('provider/log fragments never create endpoints, assertions or stack attribution', () => {
  const context = { sourceRoot: root, sources: sourceCatalog(root), lines: new Map() };
  const value = diagnostic({ message: `${PRIVATE.join(' ')} HTTP 401 timeout toBeVisible https://localhost/api/status?token=foo`,
    stack: `Raw log: ${root}/tests/support/read-assertions.ts:2:7` }, context);
  expect(value).toEqual({ classification: 'UNKNOWN_ERROR', locations: [], matcher: null,
    operation: null, locatorProperty: null, endpointPath: null });
  noLeak(value);
});

test.each([
  ['https://user:pass@private.invalid/auth/confirm?token=secret#password', '/auth/confirm'],
  ['/q/private-token-XYZ/nested/secret?mail=private-user@example.invalid', '/q/[redacted]'],
  ['/shop/private-token-XYZ/item/private.password!XYZ', '/shop/[redacted]'],
  ['/api/private-token-XYZ?secret=foo', null], ['/auth/confirm/private-token-XYZ', null],
  ['/api/status', '/api/status'],
])('endpoint projection masks arbitrary dynamic tails and whitelists only fixed routes: %s', (url, expected) => {
  expect(safeEndpoint(url)).toBe(expected);
});

test('local revalidation rejects any added fields, unknown enum or token-bearing source/endpoint', () => {
  fixture();
  const value = exported();
  const mutations = [v => { v.runs[0].summary.body = PRIVATE[4]; },
    v => { v.runs[0].tests[0].source.file = PRIVATE[0]; },
    v => { v.runs[0].tests[0].attempts[0].errors[0].classification = PRIVATE[0]; },
    v => { v.runs[0].tests[0].attempts[0].errors[0].endpointPath = '/auth?token=' + PRIVATE[0]; }];
  for (const mutate of mutations) {
    const copy = structuredClone(value); mutate(copy);
    expect(() => validateExport(copy, qaId, sourceCatalog(root))).toThrow('INVALID_EXPORT');
  }
});

test('CLI is dependency-free, sanitized on invalid input, and exports no raw report to stderr', () => {
  const helper = path.join(__dirname, '../scripts/qa-evidence.cjs');
  fixture();
  const result = spawnSync(process.execPath, [helper, 'export', qaId], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0); expect(result.stderr).toBe(''); noLeak(JSON.parse(result.stdout));
  const stdin = spawnSync(process.execPath, ['-', 'export', qaId], { cwd: root,
    input: fs.readFileSync(helper, 'utf8'), encoding: 'utf8' });
  expect(stdin.status).toBe(0); expect(stdin.stderr).toBe('');
  expect(JSON.parse(stdin.stdout)).toEqual(JSON.parse(result.stdout));
  const checked = spawnSync(process.execPath, [helper, 'validate', qaId], { cwd: root,
    input: stdin.stdout, encoding: 'utf8' });
  expect(checked.status).toBe(0); expect(checked.stderr).toBe('');
  expect(JSON.parse(checked.stdout)).toEqual(JSON.parse(result.stdout));
  const invalid = spawnSync(process.execPath, [helper, 'validate', qaId], { cwd: root,
    input: `{invalid ${PRIVATE.join(' ')} }`, encoding: 'utf8' });
  expect(invalid.status).toBe(1); expect(invalid.stderr).toBe(''); noLeak(JSON.parse(invalid.stdout));
  const code = fs.readFileSync(helper, 'utf8');
  expect([...code.matchAll(/require\(['"]([^'"]+)/g)].map(match => match[1]).every(name => name.startsWith('node:'))).toBe(true);
});

test.each([{ results: {} }, { results: [null] }, { results: [{ status: PRIVATE[0] }] },
  { results: [{ status: 'passed', errors: {} }] }])('invalid result shape is explicit, never a fabricated failed/passed test: %j', test => {
  const f = fixture(); f.spec.tests[0] = { ...f.spec.tests[0], ...test }; f.save();
  const value = exported();
  noLeak(value);
  expect(value.runs[0]).toMatchObject({ tests: [], detailCount: 0, selectedMissingCount: null,
    extraction: { errors: [{ code: 'REPORT_INVALID' }] } });
});

test('summary-only incomplete metadata stays null; report-level errors expose only classifications and locations', () => {
  const f = fixture();
  delete f.summary.expectedCount; delete f.summary.selectedCount; delete f.summary.missing;
  f.report.errors = [{ name: 'SyntaxError', message: PRIVATE.join(' '),
    location: { file: 'tests/support/read-assertions.ts', line: 1, column: 1 } }];
  f.save();
  const value = exported(); noLeak(value);
  expect(value.runs[0].summary).toMatchObject({ expectedCount: null, selectedCount: null, missing: null });
  expect(value.runs[0].reportErrors[0]).toMatchObject({ classification: 'SYNTAX_ERROR',
    locations: [{ file: 'tests/support/read-assertions.ts', line: 1, column: 1 }] });
  expect(value.runs[0].extraction.errors).toContainEqual({ code: 'COUNT_MISMATCH' });
});