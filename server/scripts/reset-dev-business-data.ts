/**
 * reset-dev-business-data.ts — 本地 dev 业务数据清库脚本（13 周公司数据重造车道配套）
 *
 * 目标：按 FK 安全顺序 deleteMany 清空全部业务数据，为 seed-company-sim.ts 从零重造铺路。
 *
 * 保留（绝不触碰）：
 *   - RBAC / 组织：UserAccount / Role / Permission / RolePermission / UserRole / Department
 *     / JobPosition / Team / TeamMember / TeamDataGrant / Project / ProjectMember / WorkAssignment
 *   - 平台配置：SequenceRegister / SequenceRevoke / BusinessSequence（发号器）/ SystemConfig（含 DataDict）
 *     / SopTemplate / EmailTemplate / EmailSignature / DocumentTemplate / NotificationTemplate
 *     / NotificationPreference / BusinessLine / WorkflowDefinition / BusinessProfile / QCLocation
 *     / HsCode / TaxRefundRate / ExchangeRate / AgentTool / AgentToolPermission / AgentPolicy
 *     / SystemAsset / PdmlRawFabric / ProductClassification
 *   - Agent 核心记忆：KnowledgeItem 中 id 以 core- / doc- 开头的行（seed-agent-core-memory.ts 真源）
 *
 * 用法（cd server）：
 *   npx tsx scripts/reset-dev-business-data.ts            # dry-run：逐表打印将删除行数，不落库
 *   npx tsx scripts/reset-dev-business-data.ts --dry-run  # 同上（显式）
 *   npx tsx scripts/reset-dev-business-data.ts --apply    # 真删
 */

import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const dryRun = !apply;

// ---------------------------------------------------------------------------
// 删除顺序：严格按 FK 依赖自底向上（子孙表 → 父表）。顺序错误会触发 FK 约束失败。
// 每一项 [modelDelegate, label]，label 用于打印。
// ---------------------------------------------------------------------------
const DELETE_PLAN: Array<[string, string]> = [
  // ── A. 出运 / 物流 ──
  ['shipmentCartonItem', 'ShipmentCartonItem 箱内货物分配'],
  ['shipmentCarton', 'ShipmentCarton 逐箱明细'],
  ['shipmentEvent', 'ShipmentEvent 物流节点事件'],
  ['shipmentLine', 'ShipmentLine 运单明细行'],
  ['shipmentOrderAllocation', 'ShipmentOrderAllocation 订单↔出运分配'],
  ['orderShipmentBatch', 'OrderShipmentBatch 出运批次'],
  ['shipment', 'Shipment 运单'],
  // ── B. 财务 / 核销 ──
  ['invoiceAllocation', 'InvoiceAllocation 发票核销明细'],
  ['invoiceOrderAllocation', 'InvoiceOrderAllocation 发票↔订单分配'],
  ['fxSettlement', 'FxSettlement 结汇水单'],
  ['outwardRemittance', 'OutwardRemittance 付汇水单'],
  ['paymentVoucher', 'PaymentVoucher 收付款凭证'],
  ['vatInvoice', 'VatInvoice 增值税发票'],
  ['invoice', 'Invoice 业务发票'],
  ['dunningRecord', 'DunningRecord 催款记录'],
  ['dunningProfile', 'DunningProfile 催款分级主档'],
  // ── C. 质量 / 生产管线 ──
  ['testCorrectiveAction', 'TestCorrectiveAction 测试整改'],
  ['testReportFile', 'TestReportFile 测试报告附件'],
  ['testRequest', 'TestRequest 第三方测试委托'],
  ['inspectionReport', 'InspectionReport QC 验货报告'],
  ['preCutChecklist', 'PreCutChecklist 裁剪前检查'],
  ['productionStage', 'ProductionStage 生产阶段'],
  ['qCAssignment', 'QCAssignment QC 任务分配'],
  // ── D. 开发案 ──
  ['sampleNode', 'SampleNode 三级样衣节点'],
  ['developmentCase', 'DevelopmentCase 开发案'],
  // ── E. 订单链 ──
  ['orderStatusTransition', 'OrderStatusTransition 订单状态流转'],
  ['orderLine', 'OrderLine 订单明细行'],
  ['order', 'Order 订单'],
  // ── F. 报价 / 采购 / 库存 / MES / 外贸 / 运行痕迹 ──
  ['quotationVersion', 'QuotationVersion 报价版本快照'],
  ['quotationLine', 'QuotationLine 报价行'],
  ['quotation', 'Quotation 报价单'],
  ['materialReceipt', 'MaterialReceipt 来料检验'],
  ['purchaseLine', 'PurchaseLine 采购行'],
  ['purchaseOrder', 'PurchaseOrder 采购单'],
  ['materialReturn', 'MaterialReturn 物料退换货'],
  ['supplierInquiry', 'SupplierInquiry 供应商询价'],
  ['stockMovement', 'StockMovement 库存流水'],
  ['inventoryItem', 'InventoryItem 库存项'],
  ['warehouse', 'Warehouse 仓库'],
  ['bOMLine', 'BOMLine BOM 行'],
  ['costEstimate', 'CostEstimate 成本估算'],
  ['bOM', 'BOM 成本核算'],
  ['workHour', 'WorkHour 工时'],
  ['pieceRateRecord', 'PieceRateRecord 计件记录'],
  ['productionPlan', 'ProductionPlan 排产单'],
  ['pieceRateRule', 'PieceRateRule 计件规则'],
  ['workStation', 'WorkStation 工位'],
  ['outsourcingLine', 'OutsourcingLine 外协行'],
  ['outsourcingOrder', 'OutsourcingOrder 外协单'],
  ['orderProcessNode', 'OrderProcessNode 面料工序链节点'],
  ['orderProfitSheet', 'OrderProfitSheet 订单利润表'],
  ['pricingCalculation', 'PricingCalculation 定价记录'],
  ['fxRateLock', 'FxRateLock 汇率锁定'],
  ['tcCertificate', 'TcCertificate GRS 交易证书'],
  ['customsDeclarationLine', 'CustomsDeclarationLine 报关行'],
  ['customsDeclaration', 'CustomsDeclaration 报关单'],
  ['letterOfCredit', 'LetterOfCredit 信用证'],
  ['lcEvent', 'LcEvent 信用证节点事件'],
  ['taxRefund', 'TaxRefund 出口退税'],
  ['documentVersion', 'DocumentVersion 单据版本'],
  ['tradeDocument', 'TradeDocument 单据中心归档'],
  ['importBatch', 'ImportBatch 历史导入批次'],
  ['renderedDoc', 'RenderedDoc 模板渲染产物'],
  ['notification', 'Notification 站内通知'],
  ['agentCheckpoint', 'AgentCheckpoint Agent 断点'],
  ['agentCommitReceipt', 'AgentCommitReceipt Agent 提交回执'],
  ['agentToolRun', 'AgentToolRun Agent 工具运行'],
  ['agentJob', 'AgentJob Agent 任务'],
  ['agentSuggestion', 'AgentSuggestion Agent 建议'],
  ['reportRun', 'ReportRun 报表运行记录'],
  ['orderChangeRequest', 'OrderChangeRequest 订单变更请求'],
  ['fabricShipmentSample', 'FabricShipmentSample 面料船样'],
  ['sampleColorBatch', 'SampleColorBatch 色卡批次'],
  ['colorCard', 'ColorCard 色卡'],
  ['factoryDelayRecord', 'FactoryDelayRecord 工厂延误记录'],
  ['orderInternalTransfer', 'OrderInternalTransfer 订单内部转移'],
  ['earlyProductionSample', 'EarlyProductionSample 产前样'],
  ['dr013ExceptionRequest', 'Dr013ExceptionRequest DR-013 例外申请'],
  ['sampleCardItem', 'SampleCardItem 样品卡明细'],
  ['sampleCardLoan', 'SampleCardLoan 样品卡借出'],
  ['handoverRecord', 'HandoverRecord 交接记录'],
  ['marketingLead', 'MarketingLead 营销线索'],
  ['marketingCampaign', 'MarketingCampaign 营销活动'],
  ['paymentRequest', 'PaymentRequest 付款申请'],
  ['creditLimitHistory', 'CreditLimitHistory 额度变更历史'],
  ['bankruptcyAction', 'BankruptcyAction 破产行为'],
  ['bankruptcyProceeding', 'BankruptcyProceeding 破产程序'],
  // ── G. 产品 / 关系（Relation 域最后删，上方已先清其子孙） ──
  ['creditRating', 'CreditRating 信用评级'],
  ['communicationLog', 'CommunicationLog 沟通日志'],
  ['brandLine', 'BrandLine 客户品牌线'],
  ['commissionRule', 'CommissionRule 佣金规则'],
  ['fabricCompositionLine', 'FabricCompositionLine 面料成分行'],
  ['trendTagFabric', 'TrendTagFabric 趋势↔面料关联'],
  ['fabricProfile', 'FabricProfile 面料档案'],
  ['garmentProfile', 'GarmentProfile 成衣档案'],
  ['trimmingProfile', 'TrimmingProfile 辅料档案'],
  ['fabricPriceHistory', 'FabricPriceHistory 价格历史'],
  ['fabricCertification', 'FabricCertification 面料认证'],
  ['fabricCustomerCode', 'FabricCustomerCode 客户面料编码'],
  ['productImage', 'ProductImage 产品图片'],
  ['productClassificationLink', 'ProductClassificationLink 产品分类关联'],
  ['productAsset', 'ProductAsset 产品档案'],
  ['materialCompositionTerm', 'MaterialCompositionTerm 成分词条'],
  ['productSubCategory', 'ProductSubCategory 产品子类（现有行均为 DEMO 演示创建）'],
  ['factoryCapacity', 'FactoryCapacity 工厂产能日历'],
  ['factoryCertification', 'FactoryCertification 工厂认证'],
  ['factoryEvaluation', 'FactoryEvaluation 工厂评估'],
  ['factoryProfile', 'FactoryProfile 工厂档案'],
  ['contact', 'Contact 联系人'],
  ['creditLimit', 'CreditLimit 信用额度'],
  ['followUpRecord', 'FollowUpRecord 跟进记录'],
  ['opportunity', 'Opportunity 商机'],
  ['customerTier', 'CustomerTier 客户分层'],
  ['tradeShowLead', 'TradeShowLead 展会线索'],
  ['tradeShow', 'TradeShow 展会记录'],
  ['trendTag', 'TrendTag 趋势标签'],
  ['season', 'Season 季度管理'],
  ['relation', 'Relation 关系档案'],
  // ── H. KB / 邮件 ──
  ['knowledgeRelation', 'KnowledgeRelation 知识关联'],
  ['knowledgeChunk', 'KnowledgeChunk 知识切片'],
  ['knowledgeAcl', 'KnowledgeAcl 知识权限'],
  ['knowledgeDocument', 'KnowledgeDocument 知识文档'],
  ['emailAttachment', 'EmailAttachment 邮件附件'],
  ['email', 'Email 邮件'],
  // ── I. HR / 审批 / 工作流实例 / 审计 ──
  ['payrollItem', 'PayrollItem 工资明细'],
  ['payrollRun', 'PayrollRun 工资批次'],
  ['performanceReview', 'PerformanceReview 绩效评定'],
  ['performanceCycle', 'PerformanceCycle 绩效周期'],
  ['trainingEnrollment', 'TrainingEnrollment 培训报名'],
  ['trainingCourse', 'TrainingCourse 培训课程'],
  ['employeeProfile', 'EmployeeProfile 员工档案'],
  ['employmentEvent', 'EmploymentEvent 员工生命周期事件'],
  ['attendanceRecord', 'AttendanceRecord 考勤'],
  ['leaveRequest', 'LeaveRequest 请假'],
  ['salaryStructure', 'SalaryStructure 薪资结构'],
  ['approvalRequest', 'ApprovalRequest 审批单'],
  ['workflowStep', 'WorkflowStep 工作流步骤'],
  ['workflowInstance', 'WorkflowInstance 工作流实例'],
  ['entityLink', 'EntityLink 实体图链接'],
  ['entityReference', 'EntityReference 实体引用'],
  ['entityAlias', 'EntityAlias 实体别名'],
  ['auditLog', 'AuditLog 审计日志'],
  ['projectMemory', 'ProjectMemory 项目记忆'],
  ['insight', 'Insight 洞察'],
];

/** Agent 核心记忆保留前缀（seed-agent-core-memory.ts 真源） */
const KNOWLEDGE_ITEM_KEEP_PREFIXES = ['core-', 'doc-'];

async function tableCount(prisma: PrismaClient, delegate: string): Promise<number> {
  const model = (prisma as any)[delegate];
  if (!model || typeof model.count !== 'function') return -1;
  return model.count();
}

export async function resetBusinessData(
  prisma: PrismaClient,
  opts: { dryRun: boolean },
): Promise<{ label: string; count: number }[]> {
  const results: { label: string; count: number }[] = [];

  for (const [delegate, label] of DELETE_PLAN) {
    const model = (prisma as any)[delegate];
    if (!model || typeof model.deleteMany !== 'function') {
      console.warn(`  ⚠ 跳过（Prisma 无 ${delegate} delegate）: ${label}`);
      results.push({ label, count: -1 });
      continue;
    }
    const count = await model.count();
    results.push({ label, count });
    if (opts.dryRun) continue;
    // KnowledgeItem 特殊：仅删非 core-/doc- 行
    const info = await model.deleteMany(
      delegate === 'knowledgeItem'
        ? { where: { OR: KNOWLEDGE_ITEM_KEEP_PREFIXES.map((p) => ({ id: { not: { startsWith: p } } })) } }
        : undefined,
    );
    void info;
  }

  // KnowledgeItem 单独统计（部分保留）
  const keepWhere = { OR: KNOWLEDGE_ITEM_KEEP_PREFIXES.map((p) => ({ id: { not: { startsWith: p } } })) };
  const kiModel = (prisma as any).knowledgeItem;
  if (kiModel) {
    const toDelete = await kiModel.count({ where: keepWhere });
    const kept = await kiModel.count({ where: { NOT: keepWhere } });
    const idx = results.findIndex((r) => r.label.startsWith('KnowledgeItem'));
    if (idx >= 0) results[idx].count = toDelete;
    console.log(`  ℹ KnowledgeItem：将删 ${toDelete} 行，保留 Agent 核心记忆 ${kept} 行（core-/doc- 前缀）`);
    if (!opts.dryRun) await kiModel.deleteMany({ where: keepWhere });
  }

  return results;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('=== 本地 dev 业务数据清库 ===');
    console.log(`模式: ${dryRun ? 'DRY-RUN（仅统计，不落库）' : 'APPLY（真删）'}`);
    const url = process.env.DATABASE_URL || '';
    const safeUrl = url.replace(/:[^:@/]+@/, ':***@');
    console.log(`库: ${safeUrl}\n`);

    const results = await resetBusinessData(prisma, { dryRun });

    console.log('\n─── 逐表统计 ───');
    let total = 0;
    for (const r of results) {
      const n = r.count >= 0 ? `${r.count}` : 'N/A';
      console.log(`  ${n.padStart(7)}  ${r.label}`);
      if (r.count > 0) total += r.count;
    }
    console.log(`\n合计将删除 ${total} 行业务数据。`);

    if (!dryRun) {
      console.log('\n─── 删后关键保留表自检 ───');
      const keepChecks: Array<[string, string]> = [
        ['userAccount', 'UserAccount'],
        ['role', 'Role'],
        ['permission', 'Permission'],
        ['department', 'Department'],
        ['sequenceRegister', 'SequenceRegister'],
        ['businessSequence', 'BusinessSequence'],
        ['systemConfig', 'SystemConfig'],
        ['emailTemplate', 'EmailTemplate'],
        ['businessLine', 'BusinessLine'],
        ['workflowDefinition', 'WorkflowDefinition'],
        ['businessProfile', 'BusinessProfile'],
        ['qcLocation', 'QCLocation'],
      ];
      for (const [delegate, label] of keepChecks) {
        const model = (prisma as any)[delegate];
        const n = model ? await model.count() : -1;
        console.log(`  ${label}: ${n}`);
      }
      console.log('\n✅ 清库完成。');
    } else {
      console.log('\n（dry-run 结束，未删除任何数据。加 --apply 执行真删。）');
    }
  } finally {
    await prisma.$disconnect();
  }
}

// 仅直接运行时执行（被 seed-company-sim.ts import 时不自动跑）
// ★ v3.79（复核 #20 MAJOR-3）：原先这里是"取 argv[1] 整条路径再做子串包含判断"（includes 那一族谓词），
//   失效方向与"该跑没跑"相反：**任何路径里含这个词**（包装脚本、改名的副本、临时目录里同名）都会在
//   被 import 时执行这个会清业务数据的脚本。普查尺 `findRawCliEntryGuards` 的"形状 B"就是为它加的。
//   改成"入口文件的**文件名**（去扩展名）等于本脚本"：不匹配整条路径；也不依赖 require.main/__filename
//   （本仓 server 侧 ts-node 与 tsx 两种跑法并存，用那两个会在其中一种下 ReferenceError —— 那是新造一个"守卫自己崩"）。
const entryPath = process.argv[1] || '';
const entryBase = entryPath.slice(entryPath.lastIndexOf('/') + 1).replace(/\.[cm]?[jt]s$/, '');
if (entryBase === 'reset-dev-business-data') {
  (async () => {
    await main();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
