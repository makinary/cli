#!/usr/bin/env node
// Allowlist projection, not redaction: raw reports/messages/titles never leave the VM.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const SUITES = ['smoke', 'buyer', 'roles', 'regression', 'project-lifecycle', 'account-lifecycle', 'procurement', 'subsystems'];
const PROJECTS = ['setup', 'buyer-setup', 'admin', 'public', 'buyer', 'roles', 'mobile-chromium',
  'project-lifecycle', 'account-lifecycle', 'procurement', 'subsystems', 'redacted'];
const OUTCOMES = ['passed', 'flaky', 'failed', 'skipped', 'blocked'];
const STATUSES = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted', 'unknown'];
const CLASSES = ['E2E_BLOCKED', 'ASSERTION_FAILED', 'TIMEOUT', 'LOCATOR_STRICT_MODE',
  'NETWORK_CONNECTION_REFUSED', 'NETWORK_DNS_FAILURE', 'BROWSER_CLOSED', 'SYNTAX_ERROR',
  'TYPE_ERROR', 'READ_DEPENDENCY_FAILURE', 'UNKNOWN_ERROR'];
const CODES = ['IO_ERROR', 'LIMIT_EXCEEDED', 'INVALID_QA_ID', 'INVALID_EXPORT', 'NO_EXACT_RUNS',
  'SUMMARY_MISSING', 'SUMMARY_INVALID', 'SUMMARY_ID_MISMATCH', 'MANIFEST_MISSING',
  'MANIFEST_INVALID', 'MANIFEST_ID_MISMATCH', 'REPORT_MISSING', 'REPORT_INVALID',
  'COUNT_MISMATCH', 'DUPLICATE_CASE_KEYS', 'MISSING_SELECTED_RESULTS', 'UNEXPECTED_RESULTS',
  'SOURCE_UNAVAILABLE', 'REMOTE_EXTRACTION_FAILED', 'LOCAL_VALIDATION_FAILED'];
const MATCHERS = ['toBe', 'toEqual', 'toStrictEqual', 'toBeTruthy', 'toBeFalsy', 'toContain',
  'toMatch', 'toHaveLength', 'toBeVisible', 'toBeHidden', 'toHaveCount', 'toHaveText',
  'toContainText', 'toHaveValue', 'toHaveAttribute', 'toHaveURL', 'toBeEnabled', 'toBeDisabled',
  'toBeChecked', 'toBeEmpty', 'toHaveTitle', 'toHaveCSS', 'toHaveProperty'];
const OPERATIONS = ['goto', 'click', 'fill', 'check', 'uncheck', 'selectOption', 'press',
  'waitForURL', 'waitFor', 'getByRole', 'getByTestId', 'getByLabel', 'locator'];
// Names only, NEVER selector/attribute values (even those appearing in local source).
const PROPERTIES = ['name', 'id', 'role', 'type', 'value', 'lang', 'aria-busy', 'data-testid'];
const ENDPOINTS = ['/', '/auth', '/auth/confirm', '/auth/callback', '/auth/reset-password',
  '/auth/set-password', '/auth/team-invitation', '/projects', '/create-site', '/onboarding',
  '/catalog', '/content', '/leads', '/orders', '/billing', '/settings', '/marketplace',
  '/cart/checkout', '/buyer', '/buyer/orders', '/buyer/quotes', '/buyer/library',
  '/buyer/subscriptions', '/api/status', '/api/leads', '/api/orders', '/api/notifications', '/api/skills',
  '/api/trends/reddit', '/api/trends/google', '/_next/static/[redacted]',
  ...['q', 'so', 'i', 'vb', 'shop', 'book'].map(prefix => `/${prefix}/[redacted]`)];
// Fixed reviewed harness names: even a real file with a token-bearing name must not
// become an output string. New authored harness files require explicit review here.
const YAML_STEMS = ['admin-route-boundary', 'browser-quality-mobile', 'buyer-navigation',
  'check-in-validation', 'context-tabs', 'dashboard-reports', 'finance-navigation',
  'finance-read-flows', 'formal-navigation-gaps', 'marketing-navigation', 'operations-navigation',
  'public-commerce-navigation', 'read-edit-agent', 'read-person', 'sales-navigation',
  'security-tabs', 'settings-navigation', 'skills-read', 'uncovered-admin-navigation',
  ...['asset', 'bill', 'campaign', 'catalog', 'content', 'control-center', 'deal', 'inventory-item',
    'lead', 'modifier-group', 'order', 'price-list', 'promotion', 'quotation', 'record',
    'requirement', 'reservation', 'robot', 'sale', 'segment', 'shipment', 'transaction',
    ...['calendar', 'channels', 'company', 'general', 'marketplace', 'printers', 'secrets',
      'social', 'team', 'visits'].map(name => `settings-${name}`)].map(name => `crud-${name}`)];
const SUPPORT_STEMS = ['preflight', 'read-buyer', 'safe-shiplight-reporter', 'authenticate',
  'account-ui', 'workspace', 'account-mailbox', 'report-redaction', 'environment',
  'read-navigation', 'project-lifecycle-policy', 'account-lifecycle-policy', 'mutation-safety',
  'read-people', 'mutation-settings', 'project-lifecycle-client', 'run-report',
  'read-observation', 'read-assertions', 'mutation-collections', 'mutation-fixtures',
  'qa-module-policy', 'procurement-policy', 'procurement-fixtures', 'procurement-ui',
  'procurement-expansion', 'subsystem-crossflows'];
const SCRIPT_STEMS = ['run', 'options', 'common', 'report', 'ci-policy', 'smoke-fixtures',
  'provision-smoke', 'provision-qa', ...['schema', 'adjust', 'store', 'verify', 'seed', 'policy',
    'plan'].map(name => `provision-qa-${name}`)];
const SOURCE_PATHS = ['auth.setup.ts', 'playwright.config.ts', 'tests/auth/buyer.setup.ts',
  'tests/smoke/public.spec.ts', 'tests/smoke/workspace.spec.ts',
  'tests/projects/lifecycle.spec.ts', 'tests/accounts/lifecycle.spec.ts',
  'tests/procurement/tender-ui.spec.ts', 'tests/procurement/participation.spec.ts',
  'tests/procurement/sealed.spec.ts', 'tests/procurement/boundaries.spec.ts',
  'tests/procurement/mapped-order.spec.ts',
  'tests/procurement/certification-sharing.spec.ts', 'tests/procurement/invitations-amendment.spec.ts',
  'tests/procurement/rejection.spec.ts',
  'tests/subsystems/pos-customer.spec.ts', 'tests/subsystems/lead-quotation.spec.ts',
  'tests/boundaries/tenant-permissions.spec.ts', ...SUPPORT_STEMS.map(name => `tests/support/${name}.ts`),
  ...SCRIPT_STEMS.map(name => `scripts/e2e/${name}.cjs`),
  ...YAML_STEMS.flatMap(name => [`tests/${name}.test.yaml`, `tests/${name}.yaml.spec.ts`])];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const number = value => integer(value) ? value : null;
const choice = (values, value, fallback = null) => values.includes(value) ? value : fallback;
const fail = code => { throw new Error(code); };
const errorCode = error => CODES.includes(error.message) ? error.message : 'IO_ERROR';
const extraction = errors => ({ status: errors.length ? 'partial' : 'ok', errors: [...new Set(errors)].map(code => ({ code })) });

function sourceCatalog(root) {
  const files = new Map();
  for (const relative of SOURCE_PATHS) {
    try {
      const absolute = path.join(root, relative);
      // Reject symlinks in every path component, including parent directories.
      if (relative.split('/').some((_, index, parts) => fs.lstatSync(path.join(root, ...parts.slice(0, index + 1))).isSymbolicLink())) continue;
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.size >= 1024 * 1024) continue;
      files.set(relative, absolute);
      // Strictly transpiled filenames derive from trusted YAML sources, not report titles.
      if (relative.endsWith('.test.yaml')) files.set(relative.replace(/\.test\.yaml$/, '.yaml.spec.ts'), null);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}

function location(value, context) {
  if (!value || typeof value.file !== 'string' || !integer(value.line) || value.line < 1) return null;
  let file = value.file;
  if (file.startsWith('file://')) {
    try {
      const url = new URL(file);
      if (url.search || url.hash || url.hostname) return null;
      file = fileURLToPath(url);
    } catch { return null; }
  }
  file = file.replace(/\\/g, '/');
  const root = context.sourceRoot.replace(/\\/g, '/');
  if (file.startsWith(root + '/')) file = file.slice(root.length + 1);
  // Exact membership, not basename matching or a permissive source-path regex.
  if (!context.sources.has(file)) return null;
  return { file, line: value.line, column: integer(value.column) && value.column > 0 ? value.column : null };
}

function safeEndpoint(value) {
  if (typeof value !== 'string') return null;
  let pathname;
  try { pathname = new URL(value, 'http://localhost').pathname; } catch { return null; }
  // Mask the entire dynamic tail, including nested slugs/tokens. No hosts or query strings.
  const publicRoute = pathname.match(/^\/(q|so|i|vb|shop|book)\/[^/]+/);
  if (publicRoute) return `/${publicRoute[1]}/[redacted]`;
  if (pathname.startsWith('/_next/static/')) return '/_next/static/[redacted]';
  return choice(ENDPOINTS, pathname);
}

function hints(locations, context) {
  const result = { matcher: null, operation: null, locatorProperty: null, endpointPath: null };
  for (const loc of locations) {
    const file = context.sources.get(loc.file);
    if (!file) continue;
    if (!context.lines.has(file)) context.lines.set(file, fs.readFileSync(file, 'utf8').split(/\r?\n/));
    const line = context.lines.get(file)[loc.line - 1] || '';
    result.matcher ||= MATCHERS.find(name => line.includes(`.${name}(`)) || null;
    result.operation ||= OPERATIONS.find(name => line.includes(`.${name}(`)) || null;
    result.locatorProperty ||= PROPERTIES.find(name => new RegExp(`(?:\\[|['\"])${name}(?:=|['\"])`).test(line)) || null;
    const literal = line.match(/\.goto\(\s*['"]([^'"]+)['"]/);
    if (literal) result.endpointPath ||= safeEndpoint(literal[1]);
  }
  return result;
}

function diagnostic(error, context) {
  const text = typeof error?.message === 'string' ? error.message.replace(/\u001b\[[0-9;]*m/g, '') : '';
  const first = text.trim().split('\n')[0].replace(/^Error:\s*/, '');
  let classification = 'UNKNOWN_ERROR';
  if (first.startsWith('[E2E_BLOCKED]')) classification = 'E2E_BLOCKED';
  else if (first === 'Unexpected application/dependency failures; a rendered page is not a healthy read') classification = 'READ_DEPENDENCY_FAILURE';
  else if (/^expect\(/.test(first)) classification = 'ASSERTION_FAILED';
  else if (error?.name === 'TimeoutError' || /^(?:Test timeout of \d+ms exceeded|(?:[\w]+\.)?[\w]+: Timeout \d+ms exceeded)/.test(first)) classification = 'TIMEOUT';
  else if (/^(?:[\w]+\.)?[\w]+: (?:Error: )?strict mode violation:/.test(first)) classification = 'LOCATOR_STRICT_MODE';
  else if (error?.code === 'ECONNREFUSED') classification = 'NETWORK_CONNECTION_REFUSED';
  else if (error?.code === 'ENOTFOUND') classification = 'NETWORK_DNS_FAILURE';
  else if (/^(?:[\w]+\.)?[\w]+: Target (?:page, context or browser|closed)/.test(first)) classification = 'BROWSER_CLOSED';
  else if (error?.name === 'SyntaxError' || /^SyntaxError:/.test(first)) classification = 'SYNTAX_ERROR';
  else if (error?.name === 'TypeError' || /^TypeError:/.test(first)) classification = 'TYPE_ERROR';
  const locations = [];
  function add(loc) {
    const safe = location(loc, context);
    if (safe && !locations.some(item => JSON.stringify(item) === JSON.stringify(safe))) locations.push(safe);
  }
  add(error?.location);
  // JSON errors[].message may contain formatted stack frames without an error.stack.
  for (const line of [error?.stack, text].filter(value => typeof value === 'string').join('\n').split('\n')) {
    const frame = line.match(/^\s*at (?:[^()\n]* \()?([^()\s]+):(\d+):(\d+)\)?\s*$/);
    if (frame) add({ file: frame[1], line: Number(frame[2]), column: Number(frame[3]) });
  }
  const codeHints = hints(locations, context);
  return { classification, locations, ...codeHints,
    // Only explicit structured metadata. Never search provider/log text for URLs.
    endpointPath: safeEndpoint(error?.endpointPath || error?.url) || codeHints.endpointPath };
}

function diagnostics(value, context) {
  if (value.errors !== undefined && !Array.isArray(value.errors)) fail('REPORT_INVALID');
  const errors = [value.error, ...(value.errors || [])].filter(item => item != null);
  if (errors.some(item => typeof item !== 'object' || Array.isArray(item))) fail('REPORT_INVALID');
  return errors.map(error => diagnostic(error, context));
}

function steps(items, context, parents = [], depth = 0) {
  if (depth > 64) fail('LIMIT_EXCEEDED');
  if (items !== undefined && !Array.isArray(items)) fail('REPORT_INVALID');
  return (items || []).map((step, index) => {
    const indexPath = [...parents, index];
    const loc = location(step.location, context);
    return { indexPath, durationMs: number(step.duration), location: loc,
      ...hints(loc ? [loc] : [], context), errors: diagnostics(step, context),
      steps: steps(step.steps, context, indexPath, depth + 1) };
  });
}

function cases(report) {
  if (!report || !Array.isArray(report.suites) || (report.errors !== undefined && !Array.isArray(report.errors))) fail('REPORT_INVALID');
  const found = [];
  function visit(suite, parents, depth = 0) {
    if (depth > 64 || found.length > 10000) fail('LIMIT_EXCEEDED');
    const titles = [...parents, suite.title || ''];
    if ((suite.specs !== undefined && !Array.isArray(suite.specs)) || (suite.suites !== undefined && !Array.isArray(suite.suites))) fail('REPORT_INVALID');
    for (const spec of suite.specs || []) {
      if (typeof spec.file !== 'string' || typeof spec.title !== 'string' || !Array.isArray(spec.tests)) fail('REPORT_INVALID');
      for (const test of spec.tests) {
        if (!test || (test.results !== undefined && !Array.isArray(test.results))) fail('REPORT_INVALID');
        for (const result of test.results || []) {
          if (!result || !STATUSES.includes(result.status) || result.status === 'unknown'
            || (result.errors !== undefined && !Array.isArray(result.errors))) fail('REPORT_INVALID');
        }
        found.push({ key: JSON.stringify([test.projectName, spec.file.replace(/\\/g, '/'), spec.line, spec.column, ...titles, spec.title]), test });
      }
    }
    for (const child of suite.suites || []) visit(child, titles, depth + 1);
  }
  for (const suite of report.suites) visit(suite, []);
  return found;
}

function keyParts(key) {
  let parts;
  try { parts = JSON.parse(key); } catch { fail('MANIFEST_INVALID'); }
  if (!Array.isArray(parts) || parts.length < 5 || typeof parts[1] !== 'string' || !integer(parts[2]) || !integer(parts[3]) || parts.slice(4).some(title => typeof title !== 'string')) fail('MANIFEST_INVALID');
  return parts;
}

function outcome(test, setupFailed) {
  const results = test.results || [];
  if (results.some(result => [result.error, ...(result.errors || [])].some(error => error?.message?.includes('[E2E_BLOCKED]')))) return 'blocked';
  if (!results.length || results.some(result => result.status === 'interrupted')) return 'blocked';
  const last = results[results.length - 1];
  if (last.status === 'skipped') return setupFailed || last.workerIndex === -1 ? 'blocked' : 'skipped';
  if (last.status !== 'passed') return 'failed';
  if (test.status === 'flaky' || results.length > 1 || results.some(result => (result.retry || 0) > 0)) return 'flaky';
  return test.status === 'unexpected' ? 'failed' : 'passed';
}

function detail(key, test, selection, index, setupFailed, context) {
  const parts = keyParts(key);
  if (test?.results !== undefined && !Array.isArray(test.results)) fail('REPORT_INVALID');
  const attempts = (test?.results || []).map((result, attemptIndex) => ({ index: attemptIndex,
    status: choice(STATUSES, result.status, 'unknown'), retry: number(result.retry), durationMs: number(result.duration),
    errorLocation: location(result.errorLocation, context), errors: diagnostics(result, context), steps: steps(result.steps, context) }));
  return { caseId: `${selection}-${index + 1}`, selection, project: choice(PROJECTS, parts[0], 'redacted'),
    source: location({ file: parts[1], line: parts[2], column: parts[3] }, context),
    present: !!test, outcome: test ? outcome(test, setupFailed) : 'unavailable', attempts };
}

function readJson(directory, filename, label) {
  const file = path.join(directory, filename);
  if (!fs.existsSync(file)) fail(`${label}_MISSING`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label}_INVALID`);
  if (stat.size > 32 * 1024 * 1024) fail('LIMIT_EXCEEDED');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`${label}_INVALID`); }
}

function runEvidence(runId, suite, directory, context) {
  const errors = [];
  let summary = null;
  try {
    const raw = readJson(directory, 'run-summary.json', 'SUMMARY');
    if (raw.runId !== runId || raw.suite !== suite || raw.target !== 'local') fail('SUMMARY_ID_MISMATCH');
    summary = { runId, suite, state: choice(['in-progress', 'blocked', 'discovery', 'finished'], raw.state),
      counts: Object.fromEntries(OUTCOMES.map(name => [name, number(raw.counts?.[name])])),
      expectedCount: number(raw.expectedCount), selectedCount: number(raw.selectedCount), missing: number(raw.missing),
      unexpected: number(raw.unexpected), scope: choice(['full', 'partial'], raw.scope),
      complete: typeof raw.complete === 'boolean' ? raw.complete : null,
      healthGreen: typeof raw.healthGreen === 'boolean' ? raw.healthGreen : null };
  } catch (error) { errors.push(errorCode(error)); }
  let tests = [], reportErrors = [], selectedMissingCount = null, unexpectedCount = null;
  try {
    const manifest = readJson(directory, 'run-manifest.json', 'MANIFEST');
    if (manifest.runId !== runId || manifest.suite !== suite || manifest.target !== 'local' || manifest.mode !== 'run') fail('MANIFEST_ID_MISMATCH');
    for (const name of ['expected', 'selected', 'selectedSetup']) {
      if (!Array.isArray(manifest[name]) || manifest[name].some(key => typeof key !== 'string')) fail('MANIFEST_INVALID');
      manifest[name].forEach(keyParts);
      if (new Set(manifest[name]).size !== manifest[name].length) fail('DUPLICATE_CASE_KEYS');
    }
    const report = readJson(directory, 'playwright.json', 'REPORT');
    const all = cases(report);
    if (new Set(all.map(item => item.key)).size !== all.length) fail('DUPLICATE_CASE_KEYS');
    const actual = new Map(all.map(item => [item.key, item.test]));
    const setupFailed = manifest.selectedSetup.some(key => !actual.has(key) || outcome(actual.get(key), false) !== 'passed');
    tests = manifest.selected.map((key, index) => detail(key, actual.get(key), 'selected', index, setupFailed, context));
    tests.push(...manifest.selectedSetup.map((key, index) => detail(key, actual.get(key), 'setup', index, false, context)));
    const unexpected = all.filter(item => !manifest.selected.includes(item.key) && !manifest.selectedSetup.includes(item.key));
    tests.push(...unexpected.map((item, index) => detail(item.key, item.test, 'unexpected', index, setupFailed, context)));
    selectedMissingCount = manifest.selected.filter(key => !actual.has(key)).length;
    unexpectedCount = unexpected.length;
    if (selectedMissingCount) errors.push('MISSING_SELECTED_RESULTS');
    if (unexpectedCount) errors.push('UNEXPECTED_RESULTS');
    const computed = Object.fromEntries(OUTCOMES.map(name => [name, tests.filter(test => test.selection === 'selected' && test.outcome === name).length]));
    computed.blocked += selectedMissingCount;
    if (summary && (summary.expectedCount !== manifest.expected.length || summary.selectedCount !== manifest.selected.length
      || summary.missing !== selectedMissingCount || summary.unexpected !== unexpectedCount
      || OUTCOMES.some(name => summary.counts[name] !== computed[name]))) errors.push('COUNT_MISMATCH');
    reportErrors = (report.errors || []).map(error => diagnostic(error, context));
    if (tests.some(test => !test.source)) errors.push('SOURCE_UNAVAILABLE');
  } catch (error) {
    errors.push(errorCode(error));
    tests = []; reportErrors = []; selectedMissingCount = null; unexpectedCount = null;
  }
  return { runId, suite, summary, extraction: extraction(errors), detailCount: tests.filter(test => test.selection === 'selected' && test.present).length,
    selectedMissingCount, unexpectedCount, tests, reportErrors };
}

function exportEnvironment(qaId, options = {}) {
  if (!/^qa-[a-zA-Z0-9_-]+$/.test(qaId || '')) fail('INVALID_QA_ID');
  const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
  const context = { sourceRoot, sources: sourceCatalog(sourceRoot), lines: new Map() };
  const reportRoot = path.resolve(options.reportRoot || path.join(sourceRoot, 'shiplight-report'));
  const runs = [];
  if (fs.existsSync(reportRoot)) {
    if (!fs.lstatSync(reportRoot).isDirectory() || fs.lstatSync(reportRoot).isSymbolicLink()) fail('IO_ERROR');
    for (const suite of SUITES.filter(value => !options.suite || value === options.suite)) {
      const prefix = `${qaId}-${suite}-`;
      for (const name of fs.readdirSync(reportRoot).sort()) {
        if (!name.startsWith(prefix) || !/^[a-f0-9]{8}$/.test(name.slice(prefix.length))) continue;
        const directory = path.join(reportRoot, name);
        if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) continue;
        runs.push(runEvidence(name, suite, directory, context));
      }
    }
  }
  return { schemaVersion: 1, qaId, extraction: extraction(runs.length ? (runs.some(run => run.extraction.status !== 'ok') ? ['REMOTE_EXTRACTION_FAILED'] : []) : ['NO_EXACT_RUNS']), runs };
}

// Revalidate the remote projection locally. Reject unknown fields, strings and paths;
// SSH/provider output can never become a diagnostic JSON artifact by accident.
function validateExport(value, qaId, sources) {
  const nullable = schema => item => item === null || check(item, schema);
  const enumeration = values => item => values.includes(item);
  const loc = { file: item => SOURCE_PATHS.includes(item) && sources.has(item), line: item => integer(item) && item > 0, column: nullable(item => integer(item) && item > 0) };
  const hint = { matcher: nullable(enumeration(MATCHERS)), operation: nullable(enumeration(OPERATIONS)),
    locatorProperty: nullable(enumeration(PROPERTIES)), endpointPath: nullable(enumeration(ENDPOINTS)) };
  const diagnosticSchema = { classification: enumeration(CLASSES), locations: [loc], ...hint };
  const step = { indexPath: [integer], durationMs: nullable(integer), location: nullable(loc), ...hint, errors: [diagnosticSchema] };
  step.steps = [step];
  const ext = { status: enumeration(['ok', 'partial', 'failed']), errors: [{ code: enumeration(CODES) }] };
  const suiteSchema = enumeration(SUITES);
  const runIdSchema = item => typeof item === 'string' && SUITES.some(suite => item.startsWith(`${qaId}-${suite}-`) && /^[a-f0-9]{8}$/.test(item.slice(`${qaId}-${suite}-`.length)));
  const summary = { runId: runIdSchema, suite: suiteSchema, state: nullable(enumeration(['in-progress', 'blocked', 'discovery', 'finished'])),
    counts: Object.fromEntries(OUTCOMES.map(name => [name, nullable(integer)])), expectedCount: nullable(integer), selectedCount: nullable(integer),
    missing: nullable(integer), unexpected: nullable(integer), scope: nullable(enumeration(['full', 'partial'])),
    complete: nullable(item => typeof item === 'boolean'), healthGreen: nullable(item => typeof item === 'boolean') };
  const schema = { schemaVersion: item => item === 1, qaId: item => item === qaId, extraction: ext, runs: [{
    runId: runIdSchema, suite: suiteSchema, summary: nullable(summary), extraction: ext, detailCount: integer,
    selectedMissingCount: nullable(integer), unexpectedCount: nullable(integer), reportErrors: [diagnosticSchema], tests: [{
      caseId: item => /^(selected|setup|unexpected)-[1-9][0-9]*$/.test(item), selection: enumeration(['selected', 'setup', 'unexpected']),
      project: enumeration(PROJECTS), source: nullable(loc), present: item => typeof item === 'boolean', outcome: enumeration([...OUTCOMES, 'unavailable']),
      attempts: [{ index: integer, status: enumeration(STATUSES), retry: nullable(integer), durationMs: nullable(integer),
        errorLocation: nullable(loc), errors: [diagnosticSchema], steps: [step] }] }] }] };
  function check(item, spec, depth = 0) {
    if (depth > 200) return false;
    if (typeof spec === 'function') return spec(item);
    if (Array.isArray(spec)) return Array.isArray(item) && item.every(child => check(child, spec[0], depth + 1));
    return item !== null && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === Object.keys(spec).length
      && Object.entries(spec).every(([key, child]) => Object.hasOwn(item, key) && check(item[key], child, depth + 1));
  }
  if (!check(value, schema)) fail('INVALID_EXPORT');
  if (new Set(value.runs.map(run => run.runId)).size !== value.runs.length) fail('INVALID_EXPORT');
  for (const run of value.runs) {
    if (!run.runId.startsWith(`${qaId}-${run.suite}-`)
      || (run.summary && (run.summary.runId !== run.runId || run.summary.suite !== run.suite))
      || new Set(run.tests.map(test => test.caseId)).size !== run.tests.length
      || run.detailCount !== run.tests.filter(test => test.selection === 'selected' && test.present).length) fail('INVALID_EXPORT');
  }
  return value;
}

function main(args = process.argv.slice(2)) {
  const [mode, qaId, suite] = args;
  try {
    if (!/^qa-[a-zA-Z0-9_-]+$/.test(qaId || '') || !['export', 'validate'].includes(mode) || (suite && !SUITES.includes(suite))) fail('INVALID_QA_ID');
    const value = mode === 'export' ? exportEnvironment(qaId, { suite }) : JSON.parse(fs.readFileSync(0, 'utf8'));
    validateExport(value, qaId, sourceCatalog(process.cwd()));
    process.stdout.write(JSON.stringify(value) + '\n');
  } catch (error) {
    // Exception messages can contain raw JSON/provider text. Only our enums are emitted.
    process.stdout.write(JSON.stringify({ schemaVersion: 1, qaId: /^qa-[a-zA-Z0-9_-]+$/.test(qaId || '') ? qaId : null,
      extraction: { status: 'failed', errors: [{ code: errorCode(error) }] }, runs: [] }) + '\n');
    process.exitCode = 1;
  }
}
if (require.main === module || process.argv[1] === '-') main();
module.exports = { exportEnvironment, validateExport, sourceCatalog, safeEndpoint, diagnostic, main };