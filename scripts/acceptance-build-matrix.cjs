#!/usr/bin/env node
// Builds a reviewable acceptance-design annex. Never executes application code,
// connects to a database, runs tests, or turns a source match into test coverage.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'artifacts/acceptance-20261001');
const readJson = file => {
  const full = path.join(base, file);
  return JSON.parse(fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : zlib.gunzipSync(fs.readFileSync(full + '.gz')).toString('utf8'));
};
const input = readJson('design-input.json');
input.scenarios = [...input.scenarios, ...(input.additionalScenarios || [])];
const source = readJson('source/metadata.json');
const modules = readJson('source/modules.json');
const roles = readJson('source/roles.json');
const models = readJson('source/models.json');
const tests = readJson('source/test-declarations.json');
const controls = readJson('source/controls.json');
const fixtures = [...input.fixtures, ...(input.additionalFixtures || [])];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const tracked = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const designFiles = tracked.filter(file => file.startsWith('docs/design/') && file.endsWith('.md'));
const requirements = input.requirements;
const ruleById = new Map(input.rules.map(rule => [rule.id, rule]));
const moduleById = new Map(modules.map(module => [module.id, module]));
const roleById = new Map(Object.entries(roles.roles));
const modelById = new Map(models.map(model => [model.model, model]));
const capabilityById = new Map(requirements.map(capability => [capability.id, capability]));
function unique(rows, key, name) {
  if (new Set(rows.map(row => row[key])).size !== rows.length) throw new Error('Duplicate ' + name);
}
function refs(ids, known, name) {
  for (const id of ids) if (!known.has(id)) throw new Error('Unknown ' + name + ': ' + id);
}
for (const [name, rows, key] of [['capability', requirements, 'id'], ['rule', input.rules, 'id'],
  ['handoff', input.handoffs, 'id'], ['scenario', input.scenarios, 'id'], ['fixture', fixtures, 'id'],
  ['dimension', input.dimensions, 'id']]) unique(rows, key, name);
const fixtureIds = new Set(fixtures.map(fixture => fixture.id));
const dimensionIds = new Set(input.dimensions.map(dimension => dimension.id));
for (const capability of requirements) {
  if (!moduleById.has(capability.module) && !['@platform', '@portal'].includes(capability.module)) throw new Error('Unknown surface');
  refs(capability.models, modelById, 'model'); refs(capability.ruleIds, ruleById, 'rule');
  refs(capability.operationOwnerCandidates, roleById, 'role');
  if (!capability.expectedPositive || !capability.expectedNegative) throw new Error('Missing positive/negative expectation');
}
for (const handoff of input.handoffs) {
  refs(handoff.requirementIds, capabilityById, 'handoff capability'); refs(handoff.ruleIds, ruleById, 'handoff rule');
}
for (const scenario of input.scenarios) {
  refs(scenario.requirementIds, capabilityById, 'scenario capability'); refs([scenario.fixtureId], fixtureIds, 'fixture');
  refs(scenario.dimensionIds, dimensionIds, 'dimension');
  if (scenario.execution !== '未执行' || scenario.evidence.length) throw new Error('Unverified scenario cannot claim executed evidence');
}
for (const rule of input.rules) {
  const file = rule.source.split('#')[0];
  if (!fs.existsSync(path.join(root, file))) throw new Error('Missing rule source: ' + file);
}
for (const boundary of input.supportingBoundaries || []) {
  refs(boundary.requirementIds, capabilityById, 'supporting boundary capability');
  for (const file of boundary.sources) if (!fs.existsSync(path.join(root, file))) throw new Error('Missing supporting boundary source: ' + file);
}
for (const module of modules) if (!requirements.some(capability => capability.module === module.id)) throw new Error('Unregistered capability surface ' + module.id);

const domainMap = {
  relations: ['relations', 'credit', 'handover'], crm: ['crm'], suppliers: ['suppliers'], products: ['products', 'pdml'],
  development: ['development'], samples: ['samples'], quotations: ['quotations', 'moq'], orders: ['orders', 'orderChanges', 'internalTrade'],
  bom: ['bom'], procurement: ['procurement'], 'production-board': ['production'], 'qc-workbench': ['qc', 'businessLines'],
  inventory: ['inventory'], shipments: ['shipping'], customs: ['customs'], 'document-center': ['templates', 'seal'],
  invoices: ['finance'], 'payment-vouchers': ['finance', 'paymentRequests'], pricing: ['pricing'], claims: ['claims'],
  risks: ['risk', 'credit'], cockpit: ['briefing', 'dashboard'], dashboard: ['dashboard'], reports: ['reporting'],
  calendar: [], seasons: ['seasons'], marketing: ['marketing', 'market'], emails: ['email'],
  assistant: ['agent', 'ai', 'business-profiles'], 'data-center': ['knowledge', 'entities', 'import'],
  settings: ['config', 'dictionaries', 'notifications'], admin: ['admin', 'auth', 'approvals', 'sequence', 'system-assets'],
  hr: ['hr', 'teams'], 'business-tools': ['tools', 'import'], mes: ['mes'],
  '@platform': ['auth', 'approvals', 'events', 'scheduler', 'notifications', 'handover', 'shared', 'audit', 'workflow'],
  '@portal': ['customer'],
};
const testLinks = [], roleOperations = [], modelLinks = [], obligations = [];
const sourceHash = new Map();
for (const boundary of input.supportingBoundaries || []) for (const file of boundary.sources) {
  sourceHash.set(file, sha(fs.readFileSync(path.join(root, file))));
}
for (const capability of requirements) {
  const module = moduleById.get(capability.module);
  const moduleDesign = designFiles.filter(file => file.includes(capability.designLocator));
  capability.designSourceCandidates = moduleDesign;
  capability.businessSources = [...new Set(capability.ruleIds.map(id => ruleById.get(id).source))];
  capability.entry = module?.entry || (capability.module === '@portal' ? 'customer-portal/src (另有独立入口)' : 'App.tsx 及共享组件');
  capability.handoffIds = input.handoffs.filter(handoff => handoff.requirementIds.includes(capability.id)).map(handoff => handoff.id);
  capability.scenarioIds = input.scenarios.filter(scenario => scenario.requirementIds.includes(capability.id)).map(scenario => scenario.id);
  const prefix = (domainMap[capability.module] || []).map(domain => 'server/src/' + domain + '/');
  capability.implementationCandidates = tracked.filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\./.test(file)
    && (file === module?.entry || prefix.some(value => file.startsWith(value))));
  capability.controlCandidateCount = controls.filter(control => control.module_candidates.split(';').includes(capability.module)).length;
  for (const test of tests) {
    const imports = test.production_imports.split(';');
    const directEntry = module && imports.includes(module.entry);
    const directDomainImport = imports.filter(file => prefix.some(value => file.startsWith(value)));
    const reads = (test.source_read_paths || '').split(';');
    const matchedReads = reads.filter(file => file === module?.entry || prefix.some(value => file.startsWith(value)));
    const domainFile = prefix.some(value => test.file.startsWith(value));
    if (directEntry || directDomainImport.length || domainFile || matchedReads.length) {
      const value = fs.readFileSync(path.join(root, test.file), 'utf8');
      testLinks.push({ capability_id: capability.id, test_file: test.file,
        basis: directEntry ? 'direct registered entry import' : directDomainImport.length ? 'domain production import'
          : matchedReads.length ? 'literal source-file read locator; no runtime coverage inferred' : 'domain directory only',
        matched_imports: directEntry ? module.entry : directDomainImport.join(';'),
        matched_source_reads: matchedReads.join(';'),
        source_read_mentioned: /\breadFileSync\b|\breadFile\b/.test(value), mock_mentioned: /\bvi\.(mock|spyOn)\b/.test(value),
        suite_candidate: test.suite_candidate, coverage_status: '仅定位候选；实际逐断言复核与证据见execution附件', execution: '源码定位不判执行状态' });
    }
  }
  for (const [roleId, role] of roleById) {
    const scope = module?.declaredScopes?.write || '';
    roleOperations.push({ capability_id: capability.id, module_id: capability.module, action_group: capability.title,
      role_id: roleId, role_name: role.name, owner_candidate: capability.operationOwnerCandidates.includes(roleId),
      source_page_write_scope: scope,
      source_default_scope_value: !scope ? '未声明/不适用尚待核对' : roleId === 'role-super-admin' || roles.defaults[roleId]?.[scope] === true ? 'allow' : 'deny',
      expected_allow_deny: '待逐操作固化业务预期；owner候选不等于授权',
      data_scopes_to_test: '本人;团队;其他部门;跨客户;敏感字段;个人覆盖变化', actual_authorization: 'DB及实际内核未核对', result: '未测' });
  }
  for (const model of capability.models) modelLinks.push({ capability_id: capability.id, model,
    association_basis: '人工按业务域关联的候选；逐字段/读写关系尚待核对', rule_ids: capability.ruleIds.join(';'), result: '未测' });
  for (const [kind, expectation] of [['positive', capability.expectedPositive], ['negative', capability.expectedNegative]]) {
    obligations.push({ id: 'OB-' + capability.id + '-' + kind, capability_id: capability.id, kind, expectation,
      scenario_ids: capability.scenarioIds.join(';'), handoff_ids: capability.handoffIds.join(';'),
      required_layers: capability.module === '@platform' && capability.id.endsWith('-04') ? 'T6' : 'T1/T2/T3/T4适用性逐条确认;有交接另需T5',
      case_design: '待固化逐动作输入、岗位、断言及证据点；这是验证义务，不计可执行用例数', execution: '未执行', evidence: '' });
  }
  for (const file of [...capability.designSourceCandidates, ...capability.businessSources.map(ref => ref.split('#')[0])]) {
    sourceHash.set(file, sha(fs.readFileSync(path.join(root, file))));
  }
}
const modelMatrix = models.map(model => {
  const links = modelLinks.filter(link => link.model === model.model);
  return { model: model.model, field_count: model.fields, state_field_candidates: model.state_field_candidates,
    capability_ids: links.map(link => link.capability_id).join(';'),
    rule_ids: [...new Set(links.flatMap(link => link.rule_ids.split(';')))].join(';'),
    business_invariants: '须独立定义允许/禁止创建读改删、关联唯一性、状态及金额数量版本断言',
    structural_constraints: model.declared_indexes_constraints, design_mentions: model.design_mentions,
    individual_model_verification: '未完成；组级关联不代表逐模型已验', result: '未测' };
});
const unmappedModels = modelMatrix.filter(model => !model.capability_ids).map(model => model.model);
const requirementsWithoutScenario = requirements.filter(capability => !capability.scenarioIds.length).map(capability => capability.id);
const testCandidates = new Set(testLinks.map(link => link.test_file));
const testsWithoutCandidate = tests.filter(test => !testCandidates.has(test.file)).map(test => test.file);
const output = path.join(base, 'matrix');
fs.mkdirSync(output, { recursive: true });
const json = (name, value) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n');
const csv = (name, rows) => {
  if (!rows.length) throw new Error('Empty table: ' + name);
  const headers = Object.keys(rows[0]);
  const cell = value => '"' + String(Array.isArray(value) ? value.join(';') : value ?? '').replaceAll('"', '""') + '"';
  fs.writeFileSync(path.join(output, name + '.csv'), [headers, ...rows.map(row => headers.map(header => row[header]))]
    .map(row => row.map(cell).join(',')).join('\n') + '\n');
};
csv('requirements', requirements.map(capability => ({ id: capability.id, module_id: capability.module, title: capability.title,
  scope: capability.scope, positive: capability.expectedPositive, negative: capability.expectedNegative,
  rule_ids: capability.ruleIds, model_candidates: capability.models, owner_candidates: capability.operationOwnerCandidates,
  handoff_ids: capability.handoffIds, scenario_ids: capability.scenarioIds, entry: capability.entry,
  business_sources: capability.businessSources, design_source_candidates: capability.designSourceCandidates,
  implementation_locator_count: capability.implementationCandidates.length, interactive_source_candidates: capability.controlCandidateCount,
  expectation_status: capability.expectationStatus, implementation: capability.implementation, result: capability.validation })));
csv('role-operation-matrix', roleOperations); csv('requirement-model-links', modelLinks); csv('model-rule-matrix', modelMatrix);
csv('handoffs', input.handoffs); csv('scenario-matrix', input.scenarios.map(({ evidence, ...scenario }) => ({ ...scenario, evidence: '' })));
csv('verification-obligations', obligations); csv('test-candidates', testLinks); csv('scope-conflicts', input.scopeConflicts);
csv('fixtures', fixtures); csv('dimensions', input.dimensions); csv('rules', input.rules);
if (input.supportingBoundaries?.length) csv('supporting-boundaries', input.supportingBoundaries);
json('requirements', requirements); json('scenarios', input.scenarios);
json('gaps', { requirementsWithoutScenario, unmappedModels, testsWithoutCandidate,
  controlsWithoutRegisteredModule: controls.filter(control => !control.module_candidates).map(control => control.id),
  unresolved: ['全部源码控件待实际渲染核对并逐操作关联；包装组件、动态入口和条件状态可能遗漏',
    '237模型/3860字段只有结构登记及组级需求关联，逐实体不变量、状态合法矩阵、逻辑ID引用、行为用例仍待完成',
    '岗位owner候选与源码默认不是独立允许拒绝预期，实际DB覆盖/数据范围/审批内核仍需核验',
    '场景族待拆分双线/合法变体及逐动作测试；验证义务不计为可执行用例',
    '既有测试仅定位候选，源码守卫/mock/真库/UI/E2E证明能力需逐断言确认',
    '后端全量执行必须先准备隔离DB及文件/队列/外部沙箱，不能加载共享业务DB后清理',
    '范围冲突及真实业务未决需查既有决策；不得按代码现态反写预期'] });
const metadata = { generatedAt: new Date().toISOString(), purpose: input.purpose, applicationBaseline: input.applicationBaseline,
  sourceSnapshotCommit: source.sourceCommit, sourceSnapshotSha256: sha(fs.readFileSync(path.join(base, 'source/metadata.json'))),
  snapshotBasis: '源码工作树指纹；sourceSnapshotCommit是生成时HEAD，实际字节以来源SHA256为准',
  curatedInputSha256: sha(fs.readFileSync(path.join(base, 'design-input.json'))), generatorSha256: sha(fs.readFileSync(__filename)),
  counts: { registeredEntries: modules.length, capabilityGroups: requirements.length, ruleAnchors: input.rules.length,
    handoffs: input.handoffs.length, scenarioFamilies: input.scenarios.length, fixturePlans: fixtures.length,
    roleOperationCandidates: roleOperations.length, registeredModels: models.length, requirementModelCandidates: modelLinks.length,
    positiveNegativeObligations: obligations.length, testLocatorLinks: testLinks.length, locatedTestFiles: testCandidates.size,
    requirementsWithoutScenario: requirementsWithoutScenario.length, unmappedModels: unmappedModels.length,
    testsOutsideLocator: testsWithoutCandidate.length, supportingBoundaries: (input.supportingBoundaries || []).length },
  verification: { allRegisteredEntriesRepresented: true, referenceIntegrity: true,
    registeredModelsHaveGroupAssociation: !unmappedModels.length, allCapabilityGroupsHaveScenario: !requirementsWithoutScenario.length },
  businessResults: '设计附件不推导执行状态；局部执行/失败/复验见execution/results.md，完整验收未通过',
  businessSourceSha256: Object.fromEntries([...sourceHash].sort(([a], [b]) => a.localeCompare(b))),
};
json('metadata', metadata);
const escape = value => String(value).replaceAll('|', '／').replaceAll('\n', ' ');
const overview = modules.map(module => ({ module, capabilities: requirements.filter(capability => capability.module === module.id) }));
const lines = ['# 全局验收矩阵附件（2026-10-01 初稿）', '',
  '> 主方案：docs/测试推进策略-v2-2026-09-29.md §12。业务与范围依据：最新用户纠正、已确认决策及原设计。',
  '> 本件是可重建的设计附件；不推导测试执行状态，运行证据见../execution/results.md。入口、模型关联、场景数量及脚本检查均不是验收通过率。', '',
  `35入口；${requirements.length}组能力；${models.length}模型组级关联；${input.handoffs.length}交接；${input.scenarios.length}场景族；${obligations.length}项正反验证义务。`, '',
  '## 入口与能力范围', '', '| 入口 | 能力组 | 状态 |', '| --- | --- | --- |',
  ...overview.map(({ module, capabilities }) => `| ${module.label} (${module.id}) | ${capabilities.map(capability => capability.id).join('、')} | 完整能力未验收${module.id === 'dashboard' ? '；仅UI/UX豁免' : module.id === 'mes' ? '；历史兼容，MES主体排除' : ''} |`),
  '| 跨页与客户门户 | CAP-platform-01~04；CAP-portal-01~02 | 完整能力未验收；另有独立入口与共享操作 |', '',
  '## 能力与独立预期', '', '| ID / 能力 | 应有结果 | 必须拒绝或处理 | 交接 / 场景族 |', '| --- | --- | --- | --- |',
  ...requirements.map(capability => `| ${capability.id} ${escape(capability.title)} | ${escape(capability.expectedPositive)} | ${escape(capability.expectedNegative)} | ${capability.handoffIds.join(', ')} / ${capability.scenarioIds.join(', ') || '缺场景骨架'} |`), '',
  '## 已发现的口径冲突和缺口', '',
  ...input.scopeConflicts.map(gap => `- **${gap.id} ${gap.title}**：${gap.finding} 处理：${gap.disposition} 状态：${gap.status}。`), '',
  `- 仍无明确场景骨架的能力组：${requirementsWithoutScenario.join('、') || '无；但每个场景仍待拆成逐动作可执行用例'}。`,
  `- 未匹配现有测试定位的源码文件：${testsWithoutCandidate.length}个，名单见gaps.json；不能据此判没有覆盖或无须验证。`, '',
  '## 使用和证据界限', '',
  '- requirements.csv：能力与正反预期；role-operation-matrix.csv：逐能力组×7角色的候选，不能把owner当授权。',
  '- model-rule-matrix.csv / requirement-model-links.csv：237模型的组级业务关联，逐字段规则和行为尚未验收；字段结构另见../source/model-fields.csv。',
  '- handoffs.csv / scenario-matrix.csv / fixtures.csv：连续场景、交接及计划数据；所有案例只在隔离环境创建。',
  '- verification-obligations.csv：正反验证义务，具体数据步骤及测试层待细化，不计可执行用例数。',
  '- test-candidates.csv：按直接入口导入、域导入或目录定位既有测试；只给找文件线索，必须复核断言和实际执行。',
  '- ../source/interactive-controls.csv.gz：源码交互声明和静态可达入口；与实际页核对后才能形成完整操作分母。',
  '- ../source/visual-elements.csv.gz：容器/文字/样式声明，待实际渲染与BDS核对；supporting-boundaries.csv登记独立服务入口及非Prisma存储。',
  '- 大型源码明细以gzip保存，避免把完整声明重复铺进阅读及diff界面；可用gzip -dc读取，重建脚本自动解压JSON。',
  '- metadata.json记录源码、输入及生成器指纹；gaps.json明示未完成项。所有表均可重建，不改变应用或业务数据。', '',
  '当前没有功能通过率。首次执行、修复和回归另登记候选版本、环境、角色、输入、实际和证据。', ''];
fs.writeFileSync(path.join(output, 'matrix.md'), lines.join('\n'));
console.log(JSON.stringify({ output: path.relative(root, output), counts: metadata.counts, verification: metadata.verification,
  requirementsWithoutScenario }, null, 2));
