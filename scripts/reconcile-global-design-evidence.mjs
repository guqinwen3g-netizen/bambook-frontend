import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildCoverage, ledgerPath, renderCoverage } from './build-global-design-coverage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = 'artifacts/acceptance-20261007/global-goal';
const runDirectory = process.argv[2];
if (!runDirectory || path.isAbsolute(runDirectory) || runDirectory.split('/').includes('..')) throw Error('Provide a repository-relative native evidence directory');
const resultFile = `${runDirectory}/result.json`;
const result = JSON.parse(fs.readFileSync(path.join(root, resultFile), 'utf8'));
if (!result.workingSource?.sha256 || result.database?.identityVerified !== true || result.postgresStopped !== true
  || !Array.isArray(result.assertions) || result.schemaUpgrade?.schemaDiffZero !== true
  || result.schemaUpgrade?.syntheticLegacyData?.originalRowsUnchanged !== true) throw Error('Native isolated upgrade evidence is incomplete');
const manifest = JSON.parse(fs.readFileSync(path.join(root, runDirectory, 'source-files.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, ledgerPath), 'utf8');
if (manifest[ledgerPath] !== crypto.createHash('sha256').update(source).digest('hex')) throw Error('The current ledger differs from the captured business basis');
const matrixFile = path.join(root, output, 'decision-coverage.json');
const matrix = buildCoverage(source, JSON.parse(fs.readFileSync(matrixFile, 'utf8')));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// One explicit statement mapping at a time. A scenario's passing status is
// evidence for the named observed facts, never approval of an entire chapter.
const rows = new Map(matrix.requirements.map(row => [row.id, row]));
const cases = {
  exactOrder: ['developmentExactVersionAcceptance', 'requires own actual requester selection'],
  exactFabric: ['developmentExactVersionAcceptance', 'keeps fabric physical receipt'],
  exactGarment: ['developmentExactVersionAcceptance', 'keeps each returned garment distinct'],
  internalDev: ['developmentExactVersionAcceptance', 'authorizes an internal development'],
  identity: ['orderIdentityAcceptance', 'creates separate fabric/garment contracts'],
  noPo: ['orderIdentityAcceptance', 'leaves the external PO absent'],
  orderAuth: ['orderIdentityAcceptance', 'denies other business accounts'],
  workspace: ['businessWorkspaceAcceptance', 'reads without writing'],
  workspaceReplay: ['businessWorkspaceAcceptance', 'recovers a committed lost ACK'],
  manualRelease: ['businessWorkspaceAcceptance', 'freezes a real manually entered row'],
  workspaceUnknown: ['businessWorkspaceAcceptance', 'does not infer unknown manual facts'],
  fabricCapacity: ['internalFabricAllocationAcceptance', 'uses actual domain/team identities'],
  fabricPp: ['internalFabricAllocationAcceptance', 'recovers a committed allocation ACK'],
  fabricAuth: ['internalFabricAllocationAcceptance', 'rechecks membership'],
  qcSizes: ['productionSizeQcAcceptance', 'never infers checked sizes'],
  qcResume: ['productionSizeQcAcceptance', 'pauses only the NOK branch'],
  qcZero: ['productionSizeQcAcceptance', 'keeps zero-actual planned sizes'],
  productionRead: ['productionReadAcceptance', 'keeps fresh drafts'],
  productionScope: ['productionReadAcceptance', 'scopes dashboard'],
  productionWriters: ['productionReadAcceptance', 'projects actual source uncertainty'],
  productionAuth: ['productionReadAcceptance', 'rejects a disabled account'],
  supplierApproval: ['supplierCommitmentAcceptance', 'requires an independent authority'],
  supplierDelivery: ['supplierCommitmentAcceptance', 'commits supplier direct delivery'],
  ciBalances: ['developmentCiFinanceAcceptance', 'recovers exact original business'],
  ciAuth: ['developmentCiFinanceAcceptance', 'refuses overwritten original'],
  ciLater: ['developmentCiFinanceAcceptance', 'selects true later costs'],
  ciLegacy: ['developmentCiFinanceAcceptance', 'retires native old finance'],
  financeCurrent: ['financeSourceIntegrityAcceptance', 'real cost'],
  shipment: ['shipmentFactoryDirectAcceptance', 'C01 source'],
  shipmentNok: ['shipmentFactoryDirectAcceptance', 'C02 a new native'],
  shipmentReceived: ['shipmentFactoryDirectAcceptance', 'C03 unknown native'],
};
function scenario(alias) {
  const [file, title] = cases[alias];
  const matches = result.assertions.filter(test => test.file.endsWith(`/${file}.test.ts`) && test.title.includes(title));
  if (matches.length !== 1) throw Error(`Evidence must identify exactly one case: ${alias}`);
  if (!result.files[matches[0].file] || manifest[matches[0].file] !== result.files[matches[0].file]) throw Error(`Native test hash differs from captured source: ${alias}`);
  return matches[0];
}
const groups = [
  ['D-4.1-005 D-4.2-001 D-4.2-002 D-4.2-003 D-4.2-005 D-4.2-006 D-4.2-007 D-4.2-008',
    ['exactFabric', 'exactOrder', 'internalDev'], ['server/src/development/developmentVersionGate.ts', 'server/src/development/developmentSampleVersionService.ts'],
    '准确大小版本各有正式QC、实际需求方及独立产品档案；父版通过不继承；转档不要求客户选用。', '逐页浏览器确认人、报告回程和版本选择仍待当前源码验收。'],
  ['D-4.1-006 D-4.4-001 D-4.4-002 D-4.4-003 D-4.4-004 D-4.4-006 D-4.4-010 D-7.1-002 D-7.2-002 D-7.2-008 D-7.3-002',
    ['exactFabric', 'exactGarment'], ['server/src/development/developmentSampleQualityService.ts', 'server/src/samples/sampleRoomService.ts'],
    '返样同步同一实物；两件成衣独立身份；面料10.5米未取整；小版本转档不复制实物或库存。', '各形态聚合、手工来源、寄样扣减和部分归还需独立库房连续验收。'],
  ['D-4.5-003 D-4.5-005 D-4.5-006 D-4.5-007 D-8.4-001 D-8.4-002 D-8.4-007',
    ['ciBalances', 'ciAuth', 'ciLater', 'ciLegacy', 'financeCurrent'], ['server/src/development/developmentCiDocument.ts', 'server/src/finance/developmentCiReceivableService.ts', 'server/src/finance/allocationService.ts'],
    '业务开CI原件→财务登记→多票多款分配→开发余额读回；后续费用另票；撤销核销不改原件或开发生命周期。', '当前前端、货物CI同能力及公司实际账户须继续验收；费用原始登记控件不由本组情景代替。'],
  ['D-5.1-001 D-5.1-002 D-5.1-003 D-5.1-005 D-5.3-009 D-5.2-007',
    ['identity'], ['server/src/orders/orderIdentity.ts', 'server/src/orders/orderMainApprovalService.ts'],
    '相同外部PO保存面料与成衣两个内部编号、准确产品行、尺码矩阵和独立主单审批。', '全部六种录入来源、文件留证和当前条目界面仍须逐项覆盖。'],
  ['D-5.2-001 D-5.2-002 D-5.2-008',
    ['identity', 'supplierApproval', 'manualRelease'], ['server/src/orders/orderMainApprovalService.ts', 'server/src/orders/orderHeaderMutationPolicy.ts'],
    '待审冻结、退回原因/要求和草稿恢复；完整手工主单批准到分支放行由独立连续情景检查。', '失败情景必须修复并重跑；多审批人抢先决议、自审和退回再提交仍需专门原生与浏览器场景。'],
  ['D-5.1-013 D-5.2-009 D-5.4-001 D-5.4-002 D-5.4-003 D-5.4-004 D-5.4-008',
    ['noPo', 'fabricCapacity', 'fabricPp', 'fabricAuth'], ['server/src/orders/internalFabricAllocationService.ts', 'server/src/orders/internalFabricAllocationRoute.ts'],
    '真实面料业务组内部供给；准确面料行与米数并发守恒；PP和放行冻结同一供料依据；撤销和撤权阻断旧依据。', '无PO客户草稿并不单独证明全部内部订单字段；当前界面、CMT成本与真实生产线仍待专项联调。'],
  ['D-3.2-002 D-3.2-003 D-3.2-004 D-6.2-004 D-6.2-006 D-6.4-008',
    ['workspace', 'workspaceReplay', 'workspaceUnknown', 'manualRelease'], ['server/src/orders/orderBusinessWorkspaceService.ts', 'components/order/OrderDetailWorkspace.tsx'],
    '开发明确继续、原请求丢回执恢复及当前失败门禁；未知手工依据和跨行/旧修订拒绝。', '手工订单到放行仍须失败修复；所有未来内容不挂载、历史只读和准确分支定位须浏览器确认。'],
  ['D-5.4.1-001 D-5.4.1-002 D-5.4.1-003 D-5.4.1-006 D-5.4.1-007 D-5.4.1-008',
    ['supplierApproval', 'supplierDelivery'], ['server/src/procurement/supplierCommitmentService.ts', 'server/src/customs/supplierContractDocumentArchive.ts'],
    '采购/加工独立承诺；四条件兼容合单；独立审批名单、冻结原件、交期变更重审；已批PDF原件下载和丢回执恢复。', '采购需求双类型分配前端/后端在继续收尾；当前浏览器与真实名单运维需验证。'],
  ['D-5.4.1-004 D-5.4.1-005',
    ['supplierDelivery'], ['server/src/procurement/supplierFulfillmentService.ts'],
    '直送加工方与输入交接一次原子提交、零我方库存；两次真实回交追加、准确来源行累计且不自动认定质检。', '经我方仓库再转加工的连续链和差异处理另需验收。'],
  ['D-5.5-009 D-5.5-010 D-6.3-007 D-6.3-008 D-6.3-011',
    ['qcSizes', 'qcResume', 'qcZero'], ['server/src/qc/productionQcSizeCoverage.ts', 'server/src/qc/productionQcIssueService.ts'],
    '实际生产各尺码检查累计；零实际量区别未知；NOK只停准确分支，指定复验通过后仍等待业务明确恢复。', '真实产线PP与专业工作台图片/报告/认领/通知在当前前端需继续验证。'],
  ['D-5.3-003 D-5.3-004 D-8.1-013 D-8.1-015',
    ['productionRead', 'productionScope', 'productionWriters', 'productionAuth'], ['server/src/production/productionProgressService.ts', 'server/src/production/legacyProductionWriteBoundary.ts', 'components/ProductionBoard.tsx'],
    '按真实完工事实投影准确条目/分支；GET零造阶段；旧整单阶段写入口退役；当前数据范围和停用旧会话复核。', '当前五组只读投影与准确工作区跳转须浏览器验收；客户数量差异接受与补产不由读模型代替。'],
  ['D-8.1-001 D-8.1-003 D-8.1-004 D-8.1-005 D-8.1-007 D-8.1-008 D-8.1-009 D-8.1-010',
    ['shipment', 'shipmentReceived'], ['server/src/shipping/shipmentHandoffService.ts', 'server/src/orders/orderShipmentDocumentsService.ts'],
    '工厂直出和真实收货来源；物流实际核量、差异业务决定、装箱、原件回交、客户发送和ATD由连续情景逐步检查。', 'C01未通过时整条出运交接不得标完成；生产线条件、跨合同/LC单据包及浏览器仍待完整验收。'],
  ['D-8.1-011', ['shipmentNok', 'shipment'], ['server/src/shipping/shipmentHandoffService.ts'],
    '新原生样品轮次NOK使旧装运凭据失效；准确当前样品与生产QC证据仍须核实。', '正向完整链C01及真实产线PP未全部通过前，仅有负向阻断证明。'],
  ['D-14-001 D-14-002 D-14-003 D-14-004',
    ['internalDev', 'fabricAuth', 'supplierDelivery', 'financeCurrent'], ['server/src/_shared/rolePermissionMatrix.ts', 'server/src/samples/sampleCustodyAuthorization.ts'],
    '原生数据库业务组/专业角色按同一来源办理开发、供料、供应商和财务；他组及撤权拒绝，不靠新增仓库角色。', '现存公司账号不在隔离测试中修改；全模块旧旁路和实际授权同步仍须独立核对。'],
];
let updated = 0;
for (const [ids, aliases, implementationFiles, observedFacts, remaining] of groups) {
  const assertions = aliases.map(scenario);
  const files = implementationFiles.filter(file => fs.existsSync(path.join(root, file)));
  const missingFiles = implementationFiles.filter(file => !files.includes(file) || !manifest[file]);
  if (missingFiles.length) throw Error(`Implementation pointer is missing: ${missingFiles.join(', ')}`);
  for (const id of ids.split(' ')) {
    const row = rows.get(id);
    if (!row || row.decisionStatus !== 'confirmed') throw Error(`Not an exact confirmed statement: ${id}`);
    row.implementation = { status: 'implemented_facts_full_statement_pending', files,
      snapshotFiles: Object.fromEntries(files.map(file => [file, manifest[file]])),
      gaps: [remaining, '证据绑定下述隔离源码快照；之后的工作树修改须重新捕获验证。'] };
    row.verification = { status: assertions.some(test => test.status !== 'passed') ? 'native_partial_with_failed_scenario' : 'native_facts_passed_full_statement_pending',
      evidence: [`${resultFile}；workingSource.sha256=${result.workingSource.sha256}`, observedFacts],
      sourceTextSha256: row.sourceTextSha256, workingSourceSha256: result.workingSource.sha256,
      cases: assertions.map(test => ({ file: test.file, title: test.title, status: test.status,
        fileSha256: result.files[test.file], failureMessages: test.failureMessages })),
      browserVerified: false, wholeStatementAccepted: false };
    updated++;
  }
}
fs.writeFileSync(matrixFile, JSON.stringify(matrix, null, 2) + '\n');
fs.writeFileSync(path.join(root, output, 'decision-coverage.md'), renderCoverage(matrix));
fs.writeFileSync(path.join(root, output, 'native-decision-evidence.json'), JSON.stringify({ ledgerSha256: hash(source), resultFile,
  workingSourceSha256: result.workingSource.sha256, updatedStatements: updated,
  claims: { wholeProductPassed: false, browserPassed: false, fullStatementsAccepted: 0 },
  cases: Object.fromEntries(Object.keys(cases).map(alias => [alias, scenario(alias)])) }, null, 2) + '\n');
console.log(JSON.stringify({ updatedStatements: updated, wholeStatementsAccepted: 0, source: result.workingSource.sha256 }));
