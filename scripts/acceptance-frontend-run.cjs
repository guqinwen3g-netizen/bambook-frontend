#!/usr/bin/env node
// Frontend regressions from an immutable checkout. No shared environment or DB.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createAcceptanceDependencyLayout, createPrivateFrontendVitestConfig } = require('./acceptance-dependency-layout.cjs');

const ts = require('typescript');
function classifyTestSource(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const modules = [];
  let ambiguous = ast.parseDiagnostics.length > 0;
  let requireShadowed = false;
  const declarations = node => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(ast) === 'require') requireShadowed = true;
    ts.forEachChild(node, declarations);
  };
  declarations(ast);
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) ambiguous = true;
      else if (!node.importClause?.isTypeOnly) modules.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) ambiguous = true;
      else modules.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      if (!node.moduleReference.expression || !ts.isStringLiteral(node.moduleReference.expression)) ambiguous = true;
      else modules.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      if (ts.isIdentifier(node.expression) && requireShadowed) ambiguous = true;
      else if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) ambiguous = true;
      else modules.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const nodeTest = modules.includes('node:test');
  const vitest = modules.some(module => module === 'vitest' || module.startsWith('vitest/') || module.startsWith('@vitest/'));
  return { executor: nodeTest && !vitest && !ambiguous ? 'node' : 'vitest', modules: [...new Set(modules)].sort(),
    reason: nodeTest && !vitest && !ambiguous ? 'actual literal node:test import without a Vitest import'
      : ambiguous ? 'ambiguous framework load; not excluded from Vitest' : vitest && nodeTest ? 'mixed framework imports; not excluded from Vitest' : 'Vitest inventory default' };
}
function relativeTestFile(workspace, file) {
  const root = fs.realpathSync(workspace);
  const absolute = fs.realpathSync(path.isAbsolute(file) ? file : path.join(root, file));
  if (!absolute.startsWith(root + path.sep)) throw Error('Test inventory/report file escaped the immutable workspace');
  return path.relative(root, absolute).split(path.sep).join('/');
}
function splitTestInventory(workspace, listed) {
  if (!Array.isArray(listed) || !listed.length) throw Error('Test inventory is empty or malformed');
  const seen = new Set();
  return listed.map(item => {
    if (!item || typeof item.file !== 'string' || !item.file) throw Error('Malformed test inventory file');
    const file = relativeTestFile(workspace, item.file);
    if (seen.has(file)) throw Error('Duplicate/multi-project test inventory file: ' + file);
    seen.add(file);
    const bytes = fs.readFileSync(path.join(workspace, file));
    return { file, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...classifyTestSource(file, bytes.toString('utf8')) };
  }).sort((a, b) => a.file.localeCompare(b.file));
}
const nodeReporterSource = `module.exports = async function* (source) {
  for await (const event of source) {
    const seen = new WeakSet();
    yield JSON.stringify(event, (key, value) => {
      if (typeof value === 'bigint') return String(value);
      if (value && typeof value === 'object') { if (seen.has(value)) return '[Circular]'; seen.add(value); }
      if (value instanceof Error) return { ...value, name: value.name, message: value.message, stack: value.stack };
      return value;
    }) + '\\n';
  }
};\n`;
function verifyFileCoverage(expected, observed, label) {
  const known = new Set(expected), seen = new Set();
  for (const file of observed) {
    if (seen.has(file)) throw Error(label + ' duplicate file receipt: ' + file);
    if (!known.has(file)) throw Error(label + ' unexpected file receipt: ' + file);
    seen.add(file);
  }
  const missing = expected.filter(file => !seen.has(file));
  if (missing.length) throw Error(label + ' missing file receipts: ' + missing.join(', '));
}
function readNodeReceipt(workspace, expected, jsonl) {
  const events = jsonl.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const summaries = events.filter(event => event.type === 'test:summary');
  const totals = summaries.filter(event => !event.data.file);
  if (totals.length !== 1) throw Error('Node terminal summary is missing or duplicated');
  const fileSummaries = summaries.filter(event => event.data.file).map(event => ({ ...event.data, file: relativeTestFile(workspace, event.data.file) }));
  verifyFileCoverage(expected, fileSummaries.map(item => item.file), 'Node');
  for (const item of fileSummaries) if (!Number.isInteger(item.counts?.tests) || item.counts.tests < 1) throw Error('Node zero-case file: ' + item.file);
  const counts = totals[0].data.counts;
  if (!counts || !Number.isInteger(counts.tests) || counts.tests < 1) throw Error('Node executed zero cases');
  const fileTestCount = fileSummaries.reduce((sum, item) => sum + item.counts.tests, 0);
  if (fileTestCount !== counts.tests) throw Error('Node aggregate/per-file test count mismatch');
  const failures = events.filter(event => event.type === 'test:fail').map(event => ({ file: event.data.file ? relativeTestFile(workspace, event.data.file) : null,
    name: event.data.name, error: event.data.details?.error }));
  return { counts: { ...counts, files: fileSummaries.length }, fileResults: fileSummaries, failures,
    receiptErrors: [], summarySuccess: totals[0].data.success, errors: totals[0].data.success && !counts.failed && !counts.cancelled ? [] : ['Node native report contains failures/cancellation'] };
}
function readVitestReceipt(workspace, expected, report) {
  if (!Array.isArray(report.testResults)) throw Error('Vitest file report is missing');
  const files = report.testResults.map(file => ({ ...file, relativeFile: relativeTestFile(workspace, file.name) }));
  verifyFileCoverage(expected, files.map(file => file.relativeFile), 'Vitest');
  const errors = files.filter(file => file.status !== 'passed' || !file.assertionResults?.length)
    .map(file => 'Vitest suite failed or executed zero assertions: ' + file.relativeFile + (file.message ? ': ' + file.message : ''));
  const tests = files.reduce((sum, file) => sum + (file.assertionResults?.length ?? 0), 0);
  if (tests !== report.numTotalTests || tests < 1) errors.push('Vitest aggregate/assertion count mismatch or zero tests');
  const actualPassed = files.reduce((sum, file) => sum + (file.assertionResults ?? []).filter(test => test.status === 'passed').length, 0);
  const actualFailed = files.reduce((sum, file) => sum + (file.assertionResults ?? []).filter(test => test.status === 'failed').length, 0);
  if (actualPassed !== report.numPassedTests || actualFailed !== report.numFailedTests) errors.push('Vitest passed/failed assertion count mismatch');
  if (!report.success || report.numFailedTests || report.numFailedTestSuites) errors.push('Vitest report contains failed tests/suites');
  return { counts: { tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests, files: files.length },
    errors, suiteErrors: files.filter(file => file.status !== 'passed').map(file => ({ file: file.relativeFile, status: file.status, message: file.message })),
    failures: files.flatMap(file => (file.assertionResults ?? []).filter(test => test.status === 'failed').map(test => ({ file: file.relativeFile, fullName: test.fullName, messages: test.failureMessages }))) };
}
function aggregateExecutorCounts(executors) {
  return Object.values(executors).reduce((sum, result) => {
    for (const key of ['tests', 'passed', 'failed', 'skipped', 'files', 'cancelled', 'todo']) sum[key] += result.counts?.[key] ?? 0;
    return sum;
  }, { tests: 0, passed: 0, failed: 0, skipped: 0, files: 0, cancelled: 0, todo: 0 });
}
function executorPairPassed(executors) {
  return ['node', 'vitest'].every(name => {
    const result = executors[name];
    return result?.exitCode === 0 && !result.errors?.length && (result.status === 'passed' || (result.status === 'not-applicable' && result.expectedFiles.length === 0));
  });
}

async function runFrontendAcceptance(selected, argumentCount) {
  const repo = path.resolve(__dirname, '..');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  if (!selected || !/^[0-9a-f]{40}$/.test(selected) || argumentCount !== 3) throw Error('Supply an exact immutable source commit');
  const committed = file => cp.execFileSync('git', ['show', `${selected}:${file}`], { cwd: repo, maxBuffer: 20 * 1024 * 1024 });
  if (hash(committed('scripts/acceptance-frontend-run.cjs')) !== hash(fs.readFileSync(__filename))) throw Error('The runner must match the selected commit');
  if (hash(committed('scripts/acceptance-dependency-layout.cjs')) !== hash(fs.readFileSync(path.join(repo, 'scripts/acceptance-dependency-layout.cjs')))) throw Error('The dependency layout helper must match the selected commit');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceRoot = path.join(repo, 'artifacts/acceptance-20261001/execution/frontend-runs');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, stamp + '-'));
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-frontend-')));
  fs.chmodSync(sandbox, 0o700);
  const workspace = path.join(sandbox, 'workspace');
  const log = path.join(evidence, 'run.log');
  const summary = { batch: 'V1-FRONTEND-REGRESSION', sourceHead: selected, startedAt: new Date().toISOString(), sandbox, evidenceDir: evidence, status: 'preparing',
    runnerSha256: hash(fs.readFileSync(__filename)), boundary: 'Node network guard, no PostgreSQL provision or shared environment copied; native engines outside guard', claims: { wholeProductPassed: false, uiPassed: false } };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'en_US.UTF-8', TMPDIR: sandbox, CHECKPOINT_DISABLE: '1', NODE_ENV: 'test' };
  let child;
  async function run(command, args, cwd = repo, runtimeEnv = env) {
    fs.appendFileSync(log, `$ ${path.basename(command)} ${args.join(' ')}\n`);
    return new Promise((resolve, reject) => {
      child = cp.spawn(command, args, { cwd, env: runtimeEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', bytes => fs.appendFileSync(log, bytes));
      child.stderr.on('data', bytes => fs.appendFileSync(log, bytes));
      child.on('error', reject);
      child.on('close', (code, signal) => { child = undefined; code === 0 ? resolve({ exitCode: code, signal }) : reject(Object.assign(new Error(`${path.basename(command)} exited ${code}${signal ? ' (' + signal + ')' : ''}`), { exitCode: code, signal })); });
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } summary.status = 'interrupted'; summary.finishedAt = new Date().toISOString(); save(); process.exit(130); });
  async function main() {
    await run('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, workspace]);
    await run('git', ['checkout', '--quiet', '--detach', selected], workspace);
    const dependencyLayout = createAcceptanceDependencyLayout({ sandbox, workspace,
      sharedRootModules: path.join(repo, 'node_modules'), sharedServerModules: path.join(repo, 'server/node_modules') });
    summary.dependencyLayout = dependencyLayout;
    const sharedModules = dependencyLayout.server.sharedInputRoot;
    const privateModules = dependencyLayout.server.path;
    // Remove tracked environment presets; never consult the user's .env files.
    for (const relative of ['.env', '.env.local', '.env.test', '.env.test.local', 'server/.env', 'server/.env.local']) fs.writeFileSync(path.join(workspace, relative), '', { mode: 0o600 });
    const generatedFiles = ['.prisma/client/schema.prisma', '.prisma/client/index.js'];
    const before = generatedFiles.map(file => hash(fs.readFileSync(path.join(sharedModules, file))));
    await run(process.execPath, [path.join(privateModules, 'prisma/build/index.js'), 'generate', '--schema', 'prisma/schema.prisma'], path.join(workspace, 'server'), {
      ...env, DATABASE_URL: 'postgresql://unconnected@127.0.0.1:1/frontend_no_database', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
    });
    if (generatedFiles.some((file, index) => hash(fs.readFileSync(path.join(sharedModules, file))) !== before[index])) throw Error('Shared generated client changed');
    const privateClient = fs.realpathSync(path.join(privateModules, '.prisma/client'));
    if (!privateClient.startsWith(sandbox + path.sep)) throw Error('Frontend generated client escaped the sandbox');
    summary.privateGeneratedClient = { path: privateClient, sharedClientUnchanged: true,
      sourceSchemaSha256: hash(fs.readFileSync(path.join(workspace, 'server/prisma/schema.prisma'))) };
    summary.configurationSha256 = hash(fs.readFileSync(path.join(workspace, 'vite.config.ts')));
    summary.acceptanceConfiguration = { ...createPrivateFrontendVitestConfig({ sandbox, workspace }),
      dependencyLayoutSha256: hash(fs.readFileSync(path.join(workspace, 'scripts/acceptance-dependency-layout.cjs'))) };
    const acceptanceConfig = summary.acceptanceConfiguration.path;
    summary.packageLockSha256 = hash(fs.readFileSync(path.join(workspace, 'package-lock.json')));
    summary.versions = { node: process.version, vitest: JSON.parse(fs.readFileSync(path.join(workspace, 'node_modules/vitest/package.json'))).version };
    const guardEnv = { ...env, NODE_OPTIONS: '--require=' + path.join(workspace, 'scripts/acceptance-network-guard.cjs'), BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_NO_DATABASE: '1' };
    // Discover through the exact original Vitest configuration, without collecting
    // or executing test bodies. AST classification only diverts real native imports.
    const inventoryPath = path.join(evidence, 'test-inventory.json');
    const listedPath = path.join(evidence, 'vitest-file-inventory.json');
    await run(process.execPath, [path.join(workspace, 'node_modules/vitest/vitest.mjs'), 'list', '--config', acceptanceConfig, '--filesOnly', '--json=' + listedPath], workspace, guardEnv);
    const inventory = splitTestInventory(workspace, JSON.parse(fs.readFileSync(listedPath, 'utf8')));
    fs.writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + '\n');
    summary.testInventory = { file: path.basename(inventoryPath), sha256: hash(fs.readFileSync(inventoryPath)), totalFiles: inventory.length,
      nodeFiles: inventory.filter(item => item.executor === 'node').length, vitestFiles: inventory.filter(item => item.executor === 'vitest').length,
      boundary: 'Literal source imports only; computed/ambiguous framework loads remain in Vitest. No test body executes during classification.' };
    const nativeFiles = inventory.filter(item => item.executor === 'node').map(item => item.file);
    const vitestFiles = inventory.filter(item => item.executor === 'vitest').map(item => item.file);
    summary.executors = { node: { expectedFiles: nativeFiles, status: 'pending', counts: null, errors: [] }, vitest: { expectedFiles: vitestFiles, status: 'pending', counts: null, errors: [] } };
    summary.status = 'executing'; save();
    // Both executors run even if the first fails, so a failed suite cannot conceal
    // that the other framework's original cases were never actually executed.
    if (nativeFiles.length) {
      const reporterPath = path.join(sandbox, 'native-test-reporter.cjs');
      const eventPath = path.join(evidence, 'node-test-events.jsonl');
      fs.writeFileSync(reporterPath, nodeReporterSource, { mode: 0o600 });
      summary.executors.node.reporterSha256 = hash(fs.readFileSync(reporterPath));
      try {
        const result = await run(process.execPath, ['--test', '--test-reporter=' + reporterPath, '--test-reporter-destination=' + eventPath,
          ...nativeFiles.map(file => path.join(workspace, file))], workspace, guardEnv);
        summary.executors.node.exitCode = result.exitCode;
      } catch (error) {
        summary.executors.node.exitCode = error.exitCode ?? null;
        summary.executors.node.signal = error.signal ?? null;
        summary.executors.node.errors.push(error.message);
      }
      try {
        const bytes = fs.readFileSync(eventPath);
        summary.executors.node.reportSha256 = hash(bytes);
        summary.executors.node.reportFile = path.basename(eventPath);
        const { errors, ...receipt } = readNodeReceipt(workspace, nativeFiles, bytes.toString('utf8'));
        Object.assign(summary.executors.node, receipt);
        summary.executors.node.errors.push(...errors);
      } catch (error) { summary.executors.node.errors.push(error.message); }
      summary.executors.node.status = summary.executors.node.exitCode === 0 && !summary.executors.node.errors.length ? 'passed' : 'failed';
    } else Object.assign(summary.executors.node, { status: 'not-applicable', exitCode: 0, counts: { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, files: 0 } });
    save();
    const reportPath = path.join(evidence, 'vitest.json');
    if (vitestFiles.length) {
      try {
        const result = await run(process.execPath, [path.join(workspace, 'node_modules/vitest/vitest.mjs'), 'run', '--config', acceptanceConfig, '--maxWorkers=2',
          ...nativeFiles.map(file => '--exclude=' + file), '--reporter=default', '--reporter=json', '--outputFile=' + reportPath], workspace, guardEnv);
        summary.executors.vitest.exitCode = result.exitCode;
      } catch (error) {
        summary.executors.vitest.exitCode = error.exitCode ?? null;
        summary.executors.vitest.signal = error.signal ?? null;
        summary.executors.vitest.errors.push(error.message);
      }
      try {
        const bytes = fs.readFileSync(reportPath);
        summary.executors.vitest.reportSha256 = hash(bytes);
        summary.vitestSha256 = hash(bytes);
        const { errors, ...receipt } = readVitestReceipt(workspace, vitestFiles, JSON.parse(bytes.toString('utf8')));
        Object.assign(summary.executors.vitest, receipt);
        summary.executors.vitest.errors.push(...errors);
      } catch (error) { summary.executors.vitest.errors.push(error.message); }
      summary.executors.vitest.status = summary.executors.vitest.exitCode === 0 && !summary.executors.vitest.errors.length ? 'passed' : 'failed';
    } else Object.assign(summary.executors.vitest, { status: 'not-applicable', exitCode: 0, counts: { tests: 0, passed: 0, failed: 0, skipped: 0, files: 0 } });
    summary.counts = aggregateExecutorCounts(summary.executors);
    summary.failures = Object.entries(summary.executors).flatMap(([executor, result]) => (result.failures ?? []).map(failure => ({ executor, ...failure })));
    summary.executionErrors = Object.entries(summary.executors).flatMap(([executor, result]) => result.errors.map(message => ({ executor, message })));
    summary.status = executorPairPassed(summary.executors) ? 'executed' : 'failed';
    const denials = path.join(sandbox, 'network-denials.jsonl');
    summary.networkDenials = fs.existsSync(denials) ? fs.readFileSync(denials, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  }
  return main().catch(error => { summary.status = 'runner-error'; summary.executionError = error.message; }).finally(() => { summary.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ evidenceDir: evidence, sourceHead: selected, status: summary.status, counts: summary.counts, networkDenials: summary.networkDenials?.length })); process.exitCode = summary.status === 'executed' ? 0 : 1; });
}

module.exports = { classifyTestSource, splitTestInventory, nodeReporterSource, readNodeReceipt, readVitestReceipt, aggregateExecutorCounts, executorPairPassed };
if (require.main === module) runFrontendAcceptance(process.argv[2], process.argv.length).catch(error => { console.error(error.message); process.exitCode = 1; });
