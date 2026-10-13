// Validates artifact integrity only. Does not run tests or decide business pass.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'artifacts/acceptance-20261001');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(base, file), 'utf8'));
function csv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if (char === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
let tables = 0;
const rowCounts = {};
for (const directory of ['', 'source', 'matrix', 'execution']) for (const file of fs.readdirSync(path.join(base, directory))) {
  if (!/\.csv(\.gz)?$/.test(file)) continue;
  const bytes = fs.readFileSync(path.join(base, directory, file));
  const rows = csv((file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8'));
  if (!rows.length || new Set(rows[0]).size !== rows[0].length || rows.some(row => row.length !== rows[0].length)) throw Error('Malformed CSV: ' + file);
  rowCounts[path.posix.join(directory, file)] = rows.length - 1; tables++;
}
const source = read('source/metadata.json'), matrix = read('matrix/metadata.json');
for (const [file, hash] of Object.entries(source.inputSha256)) if (sha(fs.readFileSync(path.join(root, file))) !== hash) throw Error('Source fingerprint changed: ' + file);
for (const [file, hash] of Object.entries(matrix.businessSourceSha256)) if (sha(fs.readFileSync(path.join(root, file))) !== hash) throw Error('Business source changed: ' + file);
if (source.generatorSha256 !== sha(fs.readFileSync(path.join(root, 'scripts/acceptance-source-inventory.cjs')))) throw Error('Inventory generator changed');
if (matrix.generatorSha256 !== sha(fs.readFileSync(path.join(root, 'scripts/acceptance-build-matrix.cjs')))) throw Error('Matrix generator changed');
if (matrix.sourceSnapshotSha256 !== sha(fs.readFileSync(path.join(base, 'source/metadata.json')))) throw Error('Matrix/source snapshot mismatch');
if (matrix.curatedInputSha256 !== sha(fs.readFileSync(path.join(base, 'design-input.json')))) throw Error('Design/matrix mismatch');
const input = read('design-input.json');
const expectedRows = {
  'baseline-failure-triage.csv': 27,
  'source/api-mounts.csv': source.counts.mountDeclarations,
  'source/api-routes.csv': source.counts.routeDeclarations,
  'source/interactive-controls.csv.gz': source.counts.interactiveControlDeclarations,
  'source/model-fields.csv': source.counts.fields,
  'source/model-relations.csv': source.counts.declaredRelationFields,
  'source/models.csv': source.counts.models,
  'source/module-role-defaults.csv': source.counts.moduleRoleCandidates,
  'source/role-scope-defaults.csv': source.counts.roleScopeCandidates,
  'source/test-inventory.csv': source.counts.testSourceFiles,
  'source/visual-elements.csv.gz': source.counts.jsxVisualDeclarations,
  'matrix/dimensions.csv': input.dimensions.length,
  'matrix/fixtures.csv': matrix.counts.fixturePlans,
  'matrix/handoffs.csv': matrix.counts.handoffs,
  'matrix/model-rule-matrix.csv': matrix.counts.registeredModels,
  'matrix/requirement-model-links.csv': matrix.counts.requirementModelCandidates,
  'matrix/requirements.csv': matrix.counts.capabilityGroups,
  'matrix/role-operation-matrix.csv': matrix.counts.roleOperationCandidates,
  'matrix/rules.csv': matrix.counts.ruleAnchors,
  'matrix/scenario-matrix.csv': matrix.counts.scenarioFamilies,
  'matrix/scope-conflicts.csv': input.scopeConflicts.length,
  'matrix/supporting-boundaries.csv': matrix.counts.supportingBoundaries,
  'matrix/test-candidates.csv': matrix.counts.testLocatorLinks,
  'matrix/verification-obligations.csv': matrix.counts.positiveNegativeObligations,
  'execution/backend-failure-triage.csv': 59,
};
for (const [file, count] of Object.entries(expectedRows)) if (rowCounts[file] !== count) throw Error('CSV/metadata row mismatch: ' + file);
const rules = new Set(input.rules.map(row => row.id));
const scenarios = new Set([...input.scenarios, ...(input.additionalScenarios || [])].map(row => row.id));
const { Prisma } = require(path.join(root, 'server/node_modules/@prisma/client'));
const models = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, model]));
const schemaBytes = fs.readFileSync(path.join(root, 'server/prisma/schema.prisma'));
const generatedSchemaBytes = fs.readFileSync(path.join(root, 'server/node_modules/.prisma/client/schema.prisma'));
const schemaHash = sha(schemaBytes);
// Prisma formatting changes alignment. Compare exact meaningful tokens while
// preserving quoted strings/defaults/relations/indexes; ignore only whitespace
// and comments. Record both byte hashes rather than claiming byte identity.
const schemaTokens = bytes => (bytes.toString('utf8').match(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s+|[^\s]/g) || []).filter(token => !/^\s+$/.test(token) && !token.startsWith('//') && !token.startsWith('/*'));
if (JSON.stringify(schemaTokens(schemaBytes)) !== JSON.stringify(schemaTokens(generatedSchemaBytes))) throw Error('Generated client/schema meaningful tokens mismatch');
const business = read('execution/business-cases.json'), roles = read('execution/role-cases.json'), invariants = read('execution/model-invariants.json'), defects = read('execution/defects.json');
let refs = 0, fields = 0, evidenceRefs = 0;
function fileRef(file, start, end) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) throw Error('Missing reference: ' + file);
  const lines = fs.readFileSync(full, 'utf8').split('\n').length;
  if (start != null && (start < 1 || (end ?? start) > lines || (end ?? start) < start)) throw Error('Invalid reference line: ' + file);
  refs++;
}
function walk(value) {
  if (!value || typeof value !== 'object') return;
  const file = value.path ?? value.source;
  if (typeof file === 'string' && /^(docs|server|components|services|lib)\//.test(file) && !file.includes('#')) fileRef(file, value.lineStart ?? value.line, value.lineEnd);
  const evidence = value.run ?? value.evidence;
  if (typeof evidence === 'string' && /^(artifacts\/acceptance-20261001\/execution\/)?runs\//.test(evidence)) {
    const full = evidence.startsWith('artifacts/') ? path.join(root, evidence) : path.join(base, 'execution', evidence);
    if (!fs.existsSync(full)) throw Error('Missing evidence: ' + evidence);
    evidenceRefs++;
  }
  for (const item of Object.values(value)) if (typeof item === 'object') walk(item);
}
for (const rows of [business.cases, roles.cases, invariants.invariants]) {
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('Duplicate case/invariant');
  for (const row of rows) {
    for (const id of row.ruleIds ?? []) if (!rules.has(id)) throw Error('Unknown rule: ' + id);
    for (const id of row.scenarioIds ?? []) if (!scenarios.has(id)) throw Error('Unknown scenario: ' + id);
    walk(row);
  }
}
walk(roles.confirmedAuthorizationRules);
walk(roles.pendingPolicies);
for (const row of business.cases) for (const file of row.existingTestCandidates) fileRef(file);
for (const row of invariants.invariants) {
  for (const [model, names] of Object.entries(row.schemaConditions.mappedFields)) for (const name of names) {
    if (!models.get(model)?.fields.some(field => field.name === name)) throw Error('Unknown model field: ' + model + '.' + name);
    fields++;
  }
  for (const test of row.testCandidate) fileRef(test.file);
}
if (schemaHash !== invariants.sourceSnapshot.schemaSha256) throw Error('Invariant schema changed');
for (const row of defects.defects) {
  for (const file of row.testFiles) fileRef(file);
  for (const ref of row.implementationRefs) { const match = ref.match(/^(.*):(\d+)$/); if (!match) throw Error(ref); fileRef(match[1], Number(match[2])); }
  walk(row);
}
const guardReview = read('execution/source-guard-review.json');
for (const item of [...Object.values(guardReview.rules), ...guardReview.items]) for (const raw of item.refs ?? [item.source]) for (const ref of raw.split(';')) {
  const match = ref.match(/^(.*):([\d,\-]+)$/);
  if (!match) throw Error('Malformed guard review reference: ' + ref);
  for (const line of match[2].match(/\d+/g).map(Number)) fileRef(match[1], line);
}
const runs = [];
const reports = new Map();
const unqualifiedTrials = {
  '2026-10-01T05-56-00-883Z': '护栏干扰、路径别名误判；runner指纹未对应记录HEAD，仅保留诊断证据',
  '2026-10-01T05-57-13-434Z': '护栏干扰；runner指纹未对应记录HEAD，仅保留诊断证据',
  '2026-10-01T05-58-25-104Z': '索赔探针BigInt序列化前提缺失；只作局部诊断，不计完整业务验收',
  '2026-10-01T07-17-38-735Z': '定价正例混用四位原值和两位展示精度；只保留诊断，修正后的同版探针另行执行',
  '2026-10-01T07-51-22-311Z': '售后领导夹具缺本部门主归属；保留诊断，补齐负责人合法前提后另行执行，不计完整批准路由证据',
};
const batchFiles = { 'EXEC-01': 'first-batch.json', 'EXEC-02-BACKEND-BASELINE': 'backend-baseline-batch.json', 'EXEC-03-TECHNICAL-BASELINE': 'technical-baseline-batch.json', 'EXEC-04-ROLLBACK-CONTROLS': 'rollback-baseline-batch.json', 'EXEC-05-DEPENDENCY-RETEST': 'dependency-retest-batch.json', 'EXEC-06-AUTHORIZATION-PROBES': 'authorization-probes-batch.json', 'EXEC-07-APPROVAL-PROBES': 'approval-probes-batch.json', 'EXEC-08-V1-AUTH-REPAIR': 'v1-auth-repair-batch.json', 'EXEC-09-V1-ERROR-REPAIR': 'v1-error-repair-batch.json' };
for (const name of fs.readdirSync(path.join(base, 'execution/runs')).sort()) {
  const dir = path.join(base, 'execution/runs', name);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json')));
  if (!result.finishedAt || result.postgresStopped !== true) throw Error('Run database not closed: ' + name);
  for (const file of result.evidenceArchive?.files ?? []) {
    const bytes = fs.readFileSync(path.join(dir, file.archive));
    if (sha(bytes) !== file.archiveSha256 || sha(zlib.gunzipSync(bytes)) !== file.originalSha256) throw Error('Evidence archive changed: ' + name);
  }
  const originalArchive = result.evidenceArchive?.files.find(file => file.source === 'result.json');
  if (originalArchive) {
    const original = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, originalArchive.archive))).toString('utf8'));
    for (const key of ['sourceHead', 'counts', 'files', 'batchSha256', 'runnerSha256', 'networkDenials', 'missingFiles', 'postgresStopped']) if (JSON.stringify(result[key]) !== JSON.stringify(original[key])) throw Error('Readable summary differs from original: ' + name + '/' + key);
  }
  const runnerBytes = cp.execFileSync('git', ['show', result.sourceHead + ':scripts/acceptance-isolated-run.cjs'], { cwd: root });
  const runnerSourceCommitVerified = sha(runnerBytes) === result.runnerSha256;
  if (!runnerSourceCommitVerified && !unqualifiedTrials[name]) throw Error('Runner/commit mismatch: ' + name);
  const batchBytes = cp.execFileSync('git', ['show', result.sourceHead + ':artifacts/acceptance-20261001/execution/' + batchFiles[result.batch]], { cwd: root });
  if (sha(batchBytes) !== result.batchSha256) throw Error('Manifest/commit mismatch: ' + name);
  for (const [file, hash] of Object.entries(result.files)) {
    const bytes = cp.execFileSync('git', ['show', result.sourceHead + ':' + file], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    if (sha(bytes) !== hash) throw Error('Executed source/commit mismatch: ' + name + '/' + file);
  }
  const reportPath = path.join(dir, 'vitest.json');
  const report = JSON.parse(fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : zlib.gunzipSync(fs.readFileSync(reportPath + '.gz')).toString('utf8'));
  reports.set(name, { result, report });
  for (const [key, count] of Object.entries(result.counts)) if (report[key] !== count) throw Error('Report count mismatch: ' + name);
  const statuses = { passed: 0, failed: 0, skipped: 0, pending: 0, todo: 0 };
  for (const file of report.testResults) for (const test of file.assertionResults) statuses[test.status] = (statuses[test.status] || 0) + 1;
  if (statuses.passed !== result.counts.numPassedTests || statuses.failed !== result.counts.numFailedTests) throw Error('Assertion count mismatch: ' + name);
  runs.push({ run: name, sourceHead: result.sourceHead, counts: result.counts, files: report.testResults.length, missing: result.missingFiles.length, networkDenials: result.networkDenials.length, postgresStopped: result.postgresStopped, manifestSourceCommitVerified: true, executedFilesSourceCommitVerified: true, runnerSourceCommitVerified, qualifiedForRecordedBusinessSegments: !unqualifiedTrials[name], qualificationLimit: unqualifiedTrials[name] || '仅本轮命名断言的层级，不是完整用例/模型/产品通过' });
}
const authorization = read('execution/authorization-probe-results.json');
walk(authorization);
const authorizationSnapshot = reports.get(authorization.run.split('/')[1]);
if (!authorizationSnapshot || authorizationSnapshot.result.sourceHead !== authorization.sourceHead || authorization.applicationChanges !== false || authorization.wholeProductPassed !== false) throw Error('Invalid authorization probe snapshot');
const authorizationAssertions = authorizationSnapshot.report.testResults.flatMap(file => file.assertionResults.map(test => ({ file: file.name, test })));
const authorizationFailures = authorizationAssertions.filter(row => row.test.status === 'failed');
const authorizationKeys = new Set(), defectIds = new Set(defects.defects.map(row => row.id));
if (defectIds.size !== defects.defects.length) throw Error('Duplicate defect category');
for (const row of authorization.failedAssertions) {
  const key = row.file + '\n' + row.fullName;
  if (authorizationKeys.has(key) || !defectIds.has(row.defectId) || row.status !== 'failed') throw Error('Invalid authorization failure mapping: ' + key);
  authorizationKeys.add(key);
  fileRef(row.file);
  const actual = authorizationFailures.find(item => item.file.endsWith('/' + row.file) && item.test.fullName === row.fullName);
  if (!actual || JSON.stringify(actual.test.failureMessages.map(message => message.split('\n    at')[0])) !== JSON.stringify(row.failureSummary)) throw Error('Authorization report mapping changed: ' + key);
}
const authorizationCounts = { files: authorizationSnapshot.report.testResults.length, tests: authorizationAssertions.length, passed: authorizationAssertions.filter(row => row.test.status === 'passed').length, failed: authorizationFailures.length, skipped: authorizationAssertions.filter(row => !['passed', 'failed'].includes(row.test.status)).length, missingFiles: authorizationSnapshot.result.missingFiles.length, networkDenials: authorizationSnapshot.result.networkDenials.length, postgresStopped: authorizationSnapshot.result.postgresStopped };
if (authorizationKeys.size !== authorizationFailures.length || JSON.stringify(authorizationCounts) !== JSON.stringify(authorization.counts)) throw Error('Authorization probe counts changed');
const approval = read('execution/approval-probe-results.json');
walk(approval);
const approvalSnapshot = reports.get(approval.run.split('/')[1]);
if (!approvalSnapshot || approvalSnapshot.result.sourceHead !== approval.sourceHead || approval.applicationChanges !== false || approval.wholeProductPassed !== false) throw Error('Invalid approval probe snapshot');
const approvalAssertions = approvalSnapshot.report.testResults.flatMap(file => file.assertionResults.map(test => ({ file: file.name, test })));
const approvalFailures = approvalAssertions.filter(row => row.test.status === 'failed');
const approvalKeys = new Set(), approvalGroups = {};
for (const row of approval.failedAssertions) {
  const key = row.file + '\n' + row.fullName;
  if (approvalKeys.has(key) || !defectIds.has(row.defectId) || row.status !== 'failed') throw Error('Invalid approval failure mapping: ' + key);
  approvalKeys.add(key);
  approvalGroups[row.defectId] = (approvalGroups[row.defectId] || 0) + 1;
  fileRef(row.file);
  const actual = approvalFailures.find(item => item.file.endsWith('/' + row.file) && item.test.fullName === row.fullName);
  if (!actual || JSON.stringify(actual.test.failureMessages.map(message => message.split('\n    at')[0])) !== JSON.stringify(row.failureSummary)) throw Error('Approval report mapping changed: ' + key);
}
const approvalPassedKeys = new Set();
for (const row of approval.passedAssertions) {
  const key = row.file + '\n' + row.fullName;
  if (approvalPassedKeys.has(key) || row.status !== 'passed' || !approvalAssertions.some(item => item.file.endsWith('/' + row.file) && item.test.fullName === row.fullName && item.test.status === 'passed')) throw Error('Invalid approval positive mapping: ' + key);
  approvalPassedKeys.add(key);
  fileRef(row.file);
}
const approvalCounts = { files: approvalSnapshot.report.testResults.length, tests: approvalAssertions.length, passed: approvalAssertions.filter(row => row.test.status === 'passed').length, failed: approvalFailures.length, skipped: approvalAssertions.filter(row => !['passed', 'failed'].includes(row.test.status)).length, missingFiles: approvalSnapshot.result.missingFiles.length, networkDenials: approvalSnapshot.result.networkDenials.length, postgresStopped: approvalSnapshot.result.postgresStopped };
if (approvalKeys.size !== approvalFailures.length || approvalPassedKeys.size !== approvalCounts.passed || JSON.stringify(approvalCounts) !== JSON.stringify(approval.counts) || JSON.stringify(Object.fromEntries(Object.entries(approvalGroups).sort())) !== JSON.stringify(approval.defectAssertionCounts)) throw Error('Approval probe counts changed');
const v1Repair = read('execution/v1-repair-results.json');
walk(v1Repair);
for (const item of v1Repair.runs) {
  const snapshot = reports.get(item.evidence.split('/')[1]);
  if (!snapshot || snapshot.result.sourceHead !== v1Repair.sourceHead
    || JSON.stringify(snapshot.result.counts) !== JSON.stringify(item.counts)
    || snapshot.result.missingFiles.length || snapshot.result.networkDenials.length
    || snapshot.result.postgresStopped !== true || snapshot.result.status !== 'executed') throw Error('Invalid V1 repair run');
}
const v1Matches = new Set();
for (const row of v1Repair.originalFailureMatches) {
  const key = row.file + '\n' + row.fullName;
  if (v1Matches.has(key)) throw Error('Duplicate V1 repair mapping');
  v1Matches.add(key);
  const current = v1Repair.runs.map(item => reports.get(item.evidence.split('/')[1])).flatMap(item => item.report.testResults)
    .find(file => file.name.endsWith('/' + row.file))?.assertionResults.find(test => test.fullName === row.fullName);
  const prior = reports.get(row.previousEvidence.split('/')[1]);
  const original = prior?.report.testResults.find(file => file.name.endsWith('/' + row.file))
    ?.assertionResults.some(test => test.fullName === row.fullName && test.status === 'failed');
  if (!original || current?.status !== 'passed' || row.previousStatus !== 'failed' || row.currentStatus !== 'passed') throw Error('V1 repair mapping differs from reports: ' + key);
}
if (v1Matches.size !== 22) throw Error('Missing original V1 repair failures');
if (v1Repair.wholeProductPassed !== false || v1Repair.uiPassed !== false) throw Error('Unsupported V1 completion claim');
const currentAuth = read('execution/current-auth-configuration.json');
const observationScript = cp.execFileSync('git', ['show', currentAuth.sourceHead + ':scripts/acceptance-auth-config-readonly.cjs'], { cwd: root });
if (sha(observationScript) !== currentAuth.scriptSha256 || currentAuth.readOnly !== true || !['panda_hub_local', 'panda_hub_empty'].includes(currentAuth.database.name)) throw Error('Invalid current test authorization observation');
for (const point of [currentAuth.liveApiBefore, currentAuth.liveApiAfter]) if (point.currentDb !== currentAuth.database.name || point.accountCount !== currentAuth.accounts.undeleted) throw Error('Observation/live dev identity mismatch');
if (new Set(currentAuth.roles.map(role => role.id)).size !== currentAuth.roles.length || JSON.stringify(currentAuth.roles.filter(role => !role.permissionRows).map(role => role.id)) !== JSON.stringify(currentAuth.zeroPermissionRoleIds)) throw Error('Invalid configuration role counts');
for (const role of currentAuth.roles) if (role.activeLinkedUsers > role.linkedUsers || role.activeAccountAliases.length !== role.activeLinkedUsers || role.permissionRows !== role.scopes.length) throw Error('Invalid role/grant observation: ' + role.id);
const retest = read('execution/dependency-retest-mapping.json');
walk(retest);
const followup = reports.get(retest.run.split('/')[1]);
const original = reports.get('2026-10-01T06-02-35-499Z');
if (!followup || followup.result.sourceHead !== retest.sourceHead || retest.matches.length !== 19 || retest.completeBusinessCasePassed !== false) throw Error('Invalid dependency retest snapshot');
const uniqueMatches = new Set();
for (const row of retest.matches) {
  const key = row.file + '\n' + row.title;
  if (uniqueMatches.has(key)) throw Error('Duplicate retest match');
  uniqueMatches.add(key);
  for (const [snapshot, expected] of [[original, 'failed'], [followup, 'passed']]) {
    const file = snapshot.report.testResults.find(file => file.name.endsWith('/' + row.file));
    if (file?.assertionResults.find(test => test.fullName === row.title)?.status !== expected) throw Error('Retest report mapping changed: ' + key);
  }
}
function matcherCalls(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const checks = [], titles = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (['it', 'test'].includes(node.expression.text) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) titles.push(node.arguments[0].text);
      if (node.expression.text === 'expect') {
        let full = node;
        while (full.parent && ((ts.isPropertyAccessExpression(full.parent) && full.parent.expression === full) || (ts.isCallExpression(full.parent) && full.parent.expression === full))) full = full.parent;
        checks.push(full.getText(sf).replace(node.getText(sf), 'expect(' + node.arguments[0].getText(sf) + ')').replace(/\s+/g, ' '));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { checks, titles };
}
let preservedExpectCalls = 0;
if (retest.assertionPreservation.files.length !== 5) throw Error('Missing assertion preservation files');
for (const item of retest.assertionPreservation.files) {
  const oldText = cp.execFileSync('git', ['show', retest.assertionPreservation.againstHead + ':' + item.file], { cwd: root, encoding: 'utf8' });
  const executedText = cp.execFileSync('git', ['show', retest.sourceHead + ':' + item.file], { cwd: root, encoding: 'utf8' });
  const old = matcherCalls(item.file, oldText), current = matcherCalls(item.file, executedText), counts = new Map();
  for (const value of current.checks) counts.set(value, (counts.get(value) || 0) + 1);
  for (const value of old.checks) {
    if (!counts.get(value)) throw Error('Old business assertion missing: ' + item.file);
    counts.set(value, counts.get(value) - 1);
  }
  if (old.titles.some(title => !current.titles.includes(title)) || old.checks.length !== item.oldExpectCalls || current.checks.length !== item.currentExpectCalls || old.titles.length !== item.oldLiteralTitles || current.titles.length !== item.currentLiteralTitles) throw Error('Assertion preservation report mismatch');
  preservedExpectCalls += old.checks.length;
}
const validation = { scope: '附件CSV、定位引用、字段与来源指纹、历史执行版本/报告及无损归档完整性；不等于业务通过', validationTime: new Date().toISOString(), checkedCsvTables: tables, csvRows: rowCounts, csvShapeValid: true, csvRowsMatch: true, sourceFingerprintsMatch: true, schemaClientComparison: { sourceSchemaSha256: schemaHash, generatedSchemaSha256: sha(generatedSchemaBytes), meaningfulTokensEqual: true, stringLiteralsPreserved: true, whitespaceAndCommentsExcluded: true }, referenceIntegrity: true, applicationBaseline: 'e126110d', businessExecution: '已有局部执行；完整跨岗位用例仍未通过', executableAnnex: { businessCases: business.cases.length, roleCases: roles.cases.length, modelInvariants: invariants.invariants.length, selectedModels: new Set(invariants.invariants.flatMap(row => row.modelNames)).size, mappedFieldReferences: fields, fileLineReferences: refs, evidenceReferences: evidenceRefs, verifiedDefectCategories: defects.defects.length, completeCrossRoleCasesPassed: 0, completeModelInvariantsPassed: 0, acceptanceNotComplete: true }, dependencyRetest: { originalFailuresMatched: uniqueMatches.size, preservedExpectCalls, oldTitlesAndMatchersVerifiedAgainstGit: true }, runs };
validation.authorizationProbes = { sourceHead: authorization.sourceHead, ...authorizationCounts, exactFailureMappings: authorizationKeys.size, wholeProductPassed: false };
validation.approvalProbes = { sourceHead: approval.sourceHead, ...approvalCounts, exactFailureMappings: approvalKeys.size, exactPassedMappings: approvalPassedKeys.size, defectAssertionCounts: approval.defectAssertionCounts, wholeProductPassed: false };
validation.v1Repairs = { sourceHead: v1Repair.sourceHead, repairedCategories: v1Repair.repairedCategories.length, partiallyRepairedCategories: v1Repair.partiallyRepairedCategories.length, unrepairedCategories: v1Repair.unrepairedCategories.length, exactFormerFailureMatches: v1Matches.size, wholeProductPassed: false };
validation.currentTestAuthorizationObservation = { sourceHead: currentAuth.sourceHead, scriptSourceCommitVerified: true, readOnly: true, roles: currentAuth.roles.length, activeAccounts: currentAuth.accounts.active, zeroPermissionRoles: currentAuth.zeroPermissionRoleIds.length, scope: 'Current local test configuration, not company/production identity or business acceptance.' };
fs.writeFileSync(path.join(base, 'validation.json'), JSON.stringify(validation, null, 2) + '\n');
console.log(JSON.stringify({ csvTables: tables, refs, fields, evidenceRefs, runs: runs.length, defects: defects.defects.length, wholeProductPassed: false }));
