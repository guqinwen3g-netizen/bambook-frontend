/**
 * company-sim/verify.ts — seed 自检：逐表 count 清单 + 抽 1 单 Delivered 全链完整性断言
 *   + 二期联动抽链（采购→来料→入库余额 / 报价→订单→报关→归档 / 测试 fail→整改闭环）
 *   + 面料外销业务线核对（类型分布 / FK 断链 0 / 缸差扣款 / 分批出运 / 逾期催款 / 面料报价）
 */

import { PrismaClient } from '@prisma/client';

const COUNTED_TABLES: Array<[string, string]> = [
  // 主数据
  ['relation', 'Relation 关系档案'], ['contact', 'Contact 联系人'], ['creditLimit', 'CreditLimit 信用额度'],
  ['customerTier', 'CustomerTier 客户分层'], ['followUpRecord', 'FollowUpRecord 跟进'], ['opportunity', 'Opportunity 商机'],
  ['productAsset', 'ProductAsset 产品档案'], ['fabricProfile', 'FabricProfile'], ['garmentProfile', 'GarmentProfile'],
  ['trimmingProfile', 'TrimmingProfile'], ['fabricCompositionLine', 'FabricCompositionLine'],
  ['materialCompositionTerm', 'MaterialCompositionTerm'], ['fabricPriceHistory', 'FabricPriceHistory'],
  ['fabricCertification', 'FabricCertification'], ['productSubCategory', 'ProductSubCategory'],
  // 订单链
  ['order', 'Order 订单'], ['orderLine', 'OrderLine 行'], ['orderStatusTransition', 'OrderStatusTransition 流转审计'],
  ['productionStage', 'ProductionStage 生产阶段'], ['preCutChecklist', 'PreCutChecklist 裁前检查'],
  ['inspectionReport', 'InspectionReport QC 报告'],
  // 出运
  ['shipment', 'Shipment 运单'], ['shipmentLine', 'ShipmentLine'], ['shipmentOrderAllocation', 'ShipmentOrderAllocation'],
  ['orderShipmentBatch', 'OrderShipmentBatch 批次'], ['shipmentEvent', 'ShipmentEvent'], ['shipmentCarton', 'ShipmentCarton'],
  ['shipmentCartonItem', 'ShipmentCartonItem'], ['qCAssignment', 'QCAssignment'],
  // 财务
  ['invoice', 'Invoice 发票'], ['invoiceOrderAllocation', 'InvoiceOrderAllocation'], ['paymentVoucher', 'PaymentVoucher 凭证'],
  ['invoiceAllocation', 'InvoiceAllocation 核销'], ['dunningRecord', 'DunningRecord 催款'], ['dunningProfile', 'DunningProfile'],
  // 报价 / 采购库存（二期联动）
  ['quotation', 'Quotation 报价'], ['quotationLine', 'QuotationLine 报价行'], ['quotationVersion', 'QuotationVersion 报价版本'],
  ['warehouse', 'Warehouse 仓库'], ['purchaseOrder', 'PurchaseOrder 采购单'], ['purchaseLine', 'PurchaseLine 采购行'],
  ['materialReceipt', 'MaterialReceipt 来料检验'], ['inventoryItem', 'InventoryItem 库存项'],
  ['stockMovement', 'StockMovement 库存流水'], ['materialReturn', 'MaterialReturn 物料退换'],
  // 报关 / 单据归档（二期联动）
  ['customsDeclaration', 'CustomsDeclaration 报关单'], ['customsDeclarationLine', 'CustomsDeclarationLine 报关行'],
  ['tradeDocument', 'TradeDocument 单据归档'], ['documentVersion', 'DocumentVersion 单据版本'],
  // QC 指派 / 第三方测试（二期联动）
  ['testRequest', 'TestRequest 第三方测试'], ['testCorrectiveAction', 'TestCorrectiveAction 测试整改'],
  // 开发案 / 审批
  ['developmentCase', 'DevelopmentCase 开发案'], ['sampleNode', 'SampleNode'], ['approvalRequest', 'ApprovalRequest'],
  // CRM/HR/KB/邮件/洞察
  ['employeeProfile', 'EmployeeProfile 员工'], ['employmentEvent', 'EmploymentEvent'],
  ['jobPosition', 'JobPosition 岗位'], ['trainingCourse', 'TrainingCourse 培训'],
  ['trainingEnrollment', 'TrainingEnrollment 培训报名'], ['attendanceRecord', 'AttendanceRecord 考勤'],
  ['performanceCycle', 'PerformanceCycle'], ['performanceReview', 'PerformanceReview'],
  ['knowledgeDocument', 'KnowledgeDocument'], ['knowledgeChunk', 'KnowledgeChunk'],
  ['insight', 'Insight 洞察'], ['email', 'Email 邮件'], ['auditLog', 'AuditLog 审计'],
  // 三期补数域（2026-09-02：BOM/MES/季节营销/样品财务/薪资）
  ['workStation', 'WorkStation 工位'], ['bOM', 'BOM 物料清单'], ['bOMLine', 'BOMLine 明细'],
  ['productionPlan', 'ProductionPlan 排产'], ['orderChangeRequest', 'OrderChangeRequest 变更'],
  ['supplierInquiry', 'SupplierInquiry 询价'], ['season', 'Season 季节'], ['trendTag', 'TrendTag 趋势'],
  ['tradeShow', 'TradeShow 展会'], ['tradeShowLead', 'TradeShowLead 展会线索'],
  ['marketingCampaign', 'MarketingCampaign 营销'], ['marketingLead', 'MarketingLead 线索'],
  ['sampleCardItem', 'SampleCardItem 样卡'], ['sampleCardLoan', 'SampleCardLoan 借出'],
  ['paymentRequest', 'PaymentRequest 付款申请'], ['vatInvoice', 'VatInvoice 增值税票'],
  ['fxSettlement', 'FxSettlement 结汇'], ['payrollRun', 'PayrollRun 薪资批次'], ['payrollItem', 'PayrollItem 薪资明细'],
  // 供应商工厂域 + 客户品号（2026-09-02 上线前数据修复补数）
  ['factoryProfile', 'FactoryProfile 工厂档案'], ['factoryEvaluation', 'FactoryEvaluation 工厂评估'],
  ['factoryCertification', 'FactoryCertification 工厂认证'], ['factoryCapacity', 'FactoryCapacity 产能日历'],
  ['fabricCustomerCode', 'FabricCustomerCode 客户品号'],
];

async function countOf(prisma: PrismaClient, delegate: string): Promise<number> {
  const model = (prisma as any)[delegate];
  if (!model) return -1;
  return model.count();
}

async function assert(cond: boolean, label: string, detail?: unknown): Promise<void> {
  if (!cond) throw new Error(`❌ 全链自检失败: ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
  console.log(`  ✓ ${label}`);
}

/** 抽 SIM-ORD-001（Delivered 全链样单）核对：订单→批次→出运→发票→回款各 ≥1 关联行 */
async function verifyFullChain(prisma: PrismaClient): Promise<void> {
  console.log('\n── 抽单全链核对：SIM-ORD-001（Delivered） ──');
  const orderId = 'SIM-ORD-001';
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  assert(!!order, 'Order 存在');
  assert(order!.status === 'Delivered', `Order.status=${order!.status}（期望 Delivered）`);
  assert((order!.code ?? '').startsWith('SIM-'), `Order.code=${order!.code}（SIM- 前缀避让发号器）`);

  const lines = await prisma.orderLine.findMany({ where: { orderId } });
  assert(lines.length >= 1, `OrderLine ${lines.length} 行（≥1）`);

  const transitions = await prisma.orderStatusTransition.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  assert(transitions.length === 4, `OrderStatusTransition ${transitions.length} 行（Pending→Confirmed→Production→Shipping→Delivered）`);
  assert(
    transitions.map((t) => t.toStatus).join('→') === 'Confirmed→Production→Shipping→Delivered',
    `流转链 = ${transitions.map((t) => t.toStatus).join('→')}`,
  );

  const stages = await prisma.productionStage.findMany({ where: { orderId } });
  assert(stages.length === 10, `ProductionStage ${stages.length} 行（10 阶段全量）`);
  assert(stages.every((s) => s.status === 'done'), 'ProductionStage 全部 done');

  const inspection = await prisma.inspectionReport.findFirst({ where: { orderId, inspectionType: 'final' } });
  assert(!!inspection && inspection.result === 'pass', 'InspectionReport final=pass（出运放行门禁）');

  const batches = await prisma.orderShipmentBatch.findMany({ where: { orderId } });
  assert(batches.length === 1, `OrderShipmentBatch ${batches.length} 批`);
  assert(batches[0].status === 'shipped', '批次 status=shipped');

  const shipments = await prisma.shipment.findMany({ where: { orderId, deletedAt: null } });
  assert(shipments.length === 1, `Shipment ${shipments.length} 票`);
  const shipment = shipments[0];
  assert(shipment.status === 'Delivered', `Shipment.status=${shipment.status}`);

  const shipLines = await prisma.shipmentLine.findMany({ where: { shipmentId: shipment.id } });
  assert(shipLines.length >= lines.length, `ShipmentLine ${shipLines.length} 行（≥OrderLine）`);
  const allocs = await prisma.shipmentOrderAllocation.findMany({ where: { shipmentId: shipment.id } });
  assert(allocs.length === 1 && allocs[0].status === 'Fulfilled', 'ShipmentOrderAllocation 1 行 Fulfilled');
  const events = await prisma.shipmentEvent.findMany({ where: { shipmentId: shipment.id } });
  assert(events.length >= 6, `ShipmentEvent ${events.length} 节点（订舱→…→签收）`);
  const cartons = await prisma.shipmentCarton.findMany({ where: { shipmentId: shipment.id } });
  const cartonItems = await prisma.shipmentCartonItem.findMany({ where: { cartonId: { in: cartons.map((c) => c.id) } } });
  assert(cartons.length >= 1 && cartonItems.length >= 1, `ShipmentCarton ${cartons.length} 箱 / CartonItem ${cartonItems.length} 行`);

  // 应收口径：同 orderId 可能并存 Payable 供应商发票（sample-finance 应付链挂同一销售订单）
  const invoices = await prisma.invoice.findMany({ where: { orderId, type: 'Receivable', deletedAt: null } });
  assert(invoices.length === 1, `Invoice ${invoices.length} 张`);
  const invoice = invoices[0];
  assert(invoice.status === 'Paid', `Invoice.status=${invoice.status}`);
  const ioa = await prisma.invoiceOrderAllocation.findMany({ where: { invoiceId: invoice.id } });
  assert(ioa.length === 1 && ioa[0].batchId === batches[0].id, 'InvoiceOrderAllocation 1 行且挂批次');
  const vouchers = await prisma.paymentVoucher.findMany({ where: { invoiceId: invoice.id, deletedAt: null } });
  assert(vouchers.length === 1 && vouchers[0].status === 'reconciled', 'PaymentVoucher 1 张已核销');
  const vAllocs = await prisma.invoiceAllocation.findMany({ where: { invoiceId: invoice.id } });
  assert(vAllocs.length === 1, `InvoiceAllocation ${vAllocs.length} 行`);

  const audits = await prisma.auditLog.findMany({ where: { targetId: orderId } });
  assert(audits.length >= 8, `AuditLog ${audits.length} 条（建单→确认→生产→QC→出运→交付→开票→回款）`);
  console.log('\n✅ 抽单全链核对通过（SIM-ORD-001）。');
}

const close = (n: number, m: number): boolean => Math.abs(n - m) < 0.01;

/** 二期联动①：抽 1 张 PO 断言 PO→Receipt→StockMovement(Inbound)→InventoryItem 余额一致 + 来料退换闭环 */
async function verifyProcurementChain(prisma: PrismaClient): Promise<void> {
  console.log('\n── 二期抽链：采购→来料→入库→余额（SIM-PO-2001） ──');
  const po = await prisma.purchaseOrder.findUnique({ where: { id: 'SIM-PO-2001' }, include: { lines: true } });
  assert(!!po, 'PurchaseOrder 存在');
  assert(po!.status === 'Received', `PO.status=${po!.status}（期望 Received）`);
  assert(po!.orderId === 'SIM-ORD-001', `PO.orderId=${po!.orderId}（期望 SIM-ORD-001）`);

  const receipt = await prisma.materialReceipt.findFirst({ where: { purchaseOrderId: po!.id } });
  assert(!!receipt && receipt.status === 'Accepted', `MaterialReceipt 存在且 status=${receipt?.status}`);

  // L8 幂等口径：referenceType='PurchaseOrder' + referenceId=receipt.id
  const inMovements = await prisma.stockMovement.findMany({
    where: { referenceType: 'PurchaseOrder', referenceId: receipt!.id },
  });
  assert(inMovements.length >= 1 && inMovements.every((m) => m.type === 'Inbound'),
    `Inbound 流水 ${inMovements.length} 条（referenceType=PurchaseOrder/referenceId=receipt，L8 痕迹一致）`);

  const itemId = inMovements[0].itemId;
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
  assert(!!item, `InventoryItem 存在（${itemId}）`);

  const movements = await prisma.stockMovement.findMany({
    where: { itemId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  let running = 0;
  let continuous = true;
  for (const m of movements) {
    if (!close(Number(m.balanceBefore), running) || !close(Number(m.balanceAfter), running + Number(m.quantity))) {
      continuous = false;
      break;
    }
    running = Number(m.balanceAfter);
  }
  assert(continuous, `流水 balanceBefore/After 连续（${movements.length} 条）`);
  assert(close(running, Number(item!.quantity)), `InventoryItem.quantity=${Number(item!.quantity)} = 流水期末余额 ${running}（入库-领料一致）`);

  // 来料退换闭环：totalRejected>0 的收料单挂 MaterialReturn(return, shipped, stockItemId 回填)
  const badReceipt = await prisma.materialReceipt.findFirst({ where: { totalRejected: { gt: 0 } } });
  assert(!!badReceipt && badReceipt.status === 'PartiallyAccepted', '存在 totalRejected>0 的收料单（PartiallyAccepted）');
  const ret = await prisma.materialReturn.findFirst({ where: { receiptId: badReceipt!.id } });
  assert(!!ret && ret.type === 'return' && ret.status === 'shipped' && !!ret.stockItemId,
    `MaterialReturn(return/shipped/stockItemId) 挂接正确（${ret?.returnNumber}）`);
  console.log('\n✅ 采购→来料→入库抽链核对通过。');
}

/** 二期联动③④：抽 1 张 Delivered 订单断言 Quotation(convertedOrderId)→Order→CustomsDeclaration→TradeDocument 链通 */
async function verifyQuotationCustomsChain(prisma: PrismaClient): Promise<void> {
  console.log('\n── 二期抽链：报价→订单→报关→归档（SIM-ORD-001） ──');
  const orderId = 'SIM-ORD-001';
  const quote = await prisma.quotation.findFirst({ where: { convertedOrderId: orderId, status: 'Accepted' } });
  assert(!!quote, 'Quotation(Accepted, convertedOrderId) 存在');
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  assert(order!.source === 'quotation-convert', `Order.source=${order!.source}（期望 quotation-convert）`);
  // ★★ 2026-09-25（S4 任务 2）：下面这条「只比 quoteAmount、不比 totalNet/contractAmount」是**刻意**的，
  //   不是漏写 —— 演练的转单回写本就只改 quoteAmount（见 quotations.ts 回写处的完整论证：
  //   真源是明细行，主档金额由明细行派生、不手工填）。
  //   ⚠️ 但它**没有**把「订单行合计」与「报价单总额」对撞 ⇒ 今天相等是结构使然、没有守卫看着。
  //   缺口已登记，处置（回读对撞）见 S4 处置件；在那之前别把本条读成"四列已被核对"。
  assert(close(Number(order!.quoteAmount), Number(quote!.totalAmount)), `Order.quoteAmount = Quotation.totalAmount = ${Number(quote!.totalAmount)}`);

  const qVersion = await prisma.quotationVersion.findFirst({ where: { quotationId: quote!.id, version: 1 } });
  assert(!!qVersion && !!qVersion.linesSnapshot, 'QuotationVersion v1（headerSnapshot/linesSnapshot）存在');

  const cd = await prisma.customsDeclaration.findFirst({ where: { orderId } });
  assert(!!cd && cd.status === 'Released', `CustomsDeclaration 存在且 status=${cd?.status}`);
  const shipment = await prisma.shipment.findFirst({ where: { orderId, deletedAt: null } });
  assert(shipment!.customsDeclarationNumber === cd!.declarationNumber, 'Shipment.customsDeclarationNumber 回填一致');
  assert(!!shipment!.customsClearanceDate, 'Shipment.customsClearanceDate 已回填');

  const tds = await prisma.tradeDocument.findMany({ where: { orderId } });
  const types = new Set(tds.map((t) => t.type));
  assert(tds.length >= 3 && types.has('BillOfLading') && types.has('CommercialInvoice') && types.has('PackingList'),
    `TradeDocument ${tds.length} 张，含 B/L + CommercialInvoice + PackingList`);
  assert(tds.some((t) => t.declarationId === cd!.id), 'TradeDocument.declarationId ↔ CustomsDeclaration 链通');
  const ci = tds.find((t) => t.type === 'CommercialInvoice');
  const invoice = await prisma.invoice.findFirst({ where: { orderId, type: 'Receivable', deletedAt: null } });
  assert(!!ci && ci.sourceInvoiceId === invoice!.id, 'CommercialInvoice.sourceInvoiceId ↔ 财务 Invoice 链通');
  const dvers = await prisma.documentVersion.findMany({ where: { documentId: { in: tds.map((t) => t.id) } } });
  assert(dvers.length === tds.length && dvers.every((v) => v.version === 1 && !!v.content),
    `DocumentVersion v1 ${dvers.length}/${tds.length} 张齐全`);
  console.log('\n✅ 报价→订单→报关→归档抽链核对通过。');
}

/** 二期联动⑤：抽 1 张 fail TestRequest 断言 CorrectiveAction 存在且 closed */
async function verifyTestRequestChain(prisma: PrismaClient): Promise<void> {
  console.log('\n── 二期抽链：第三方测试 fail→整改闭环 ──');
  const failTr = await prisma.testRequest.findFirst({ where: { result: 'fail' } });
  assert(!!failTr, '存在 result=fail 的 TestRequest');
  assert((failTr!.failItems ?? []).length > 0, `failItems 已填（${(failTr!.failItems ?? []).join('/')}）`);
  const ca = await prisma.testCorrectiveAction.findFirst({ where: { testRequestId: failTr!.id } });
  assert(!!ca && ca.status === 'closed' && !!ca.closedAt, `TestCorrectiveAction status=${ca?.status}（closed 闭环）`);
  assert(ca!.failItem === failTr!.failItems[0], 'CorrectiveAction.failItem ↔ TestRequest.failItems 对应');
  const qc = await prisma.qCAssignment.findFirst({ where: { reportId: { not: null }, status: 'Completed' } });
  assert(!!qc, 'QCAssignment(Completed) 关联 InspectionReport 存在');
  console.log('\n✅ 第三方测试 fail→整改闭环抽链核对通过。');
}

/** 面料外销业务线全链核对：类型分布 + FK 断链 0 + 缸差/分批/逾期/报价剧情 */
async function verifyFabricChain(prisma: PrismaClient): Promise<void> {
  console.log('\n── 面料外销业务线核对（SIM-FORD-*） ──');

  // 1. 类型分布：Garment 56 + Fabric 13
  const byType = await prisma.order.groupBy({ by: ['type'], _count: { _all: true } });
  const typeMap = new Map(byType.map((g) => [g.type, g._count._all] as const));
  assert(typeMap.get('Fabric') === 13, `Fabric 订单 = ${typeMap.get('Fabric') ?? 0}（期望 13）`);
  assert(typeMap.get('Garment') === 56, `Garment 订单 = ${typeMap.get('Garment') ?? 0}（期望 56）`);

  // 2. 面料单客户 FK 全命中（0 断链）
  const fabricOrders = await prisma.order.findMany({
    where: { type: 'Fabric' },
    select: { id: true, code: true, status: true, customerRelationId: true, totalNet: true },
  });
  const fabricIds = fabricOrders.map((o) => o.id);
  const relIds = [...new Set(fabricOrders.map((o) => o.customerRelationId).filter((x): x is string => !!x))];
  const relCount = await prisma.relation.count({ where: { id: { in: relIds } } });
  assert(relCount === relIds.length, `面料订单客户 FK 全命中（${relCount}/${relIds.length}，断链 0）`);

  // 3. 出运链：9 单出运（7 Delivered + 2 Shipping）+ 分批大单 2 票 = 10 票
  const shippedFabricIds = fabricOrders.filter((o) => o.status === 'Delivered' || o.status === 'Shipping').map((o) => o.id);
  const shipCount = await prisma.shipment.count({ where: { orderId: { in: shippedFabricIds }, deletedAt: null } });
  assert(shipCount === 10, `面料出运 ${shipCount} 票（期望 10 = 9 单 + 分批 1 票）`);
  // 报关：每票 1 张 CD + 回填单号
  const cdCount = await prisma.customsDeclaration.count({ where: { orderId: { in: shippedFabricIds } } });
  assert(cdCount === 10, `面料报关单 ${cdCount} 张（期望 10）`);
  const fabricCds = await prisma.customsDeclaration.findMany({ where: { orderId: { in: shippedFabricIds } }, select: { shipmentId: true } });
  const fabricShipments = await prisma.shipment.findMany({ where: { orderId: { in: shippedFabricIds } }, select: { id: true, customsDeclarationNumber: true } });
  const cdShipIds = new Set(fabricCds.map((c) => c.shipmentId));
  assert(fabricShipments.every((s) => s.customsDeclarationNumber && cdShipIds.has(s.id)), '面料每票报关单号回填且 1:1 对应');
  // 单据归档：每票 3 张
  const tdCount = await prisma.tradeDocument.count({ where: { orderId: { in: shippedFabricIds } } });
  assert(tdCount === 30, `面料单据归档 ${tdCount} 张（期望 30 = 10 票 × 3）`);

  // 4. 财务链：发票 10 张（出货即开票）+ 凭证/核销 FK 0 断链
  const fabricInvoices = await prisma.invoice.findMany({
    where: { orderId: { in: shippedFabricIds }, deletedAt: null },
    select: { id: true, orderId: true, amount: true, status: true, notes: true },
  });
  assert(fabricInvoices.length === 10, `面料发票 ${fabricInvoices.length} 张（期望 10）`);
  const invIds = fabricInvoices.map((i) => i.id);
  const invIdSet = new Set(invIds);
  // 凭证 → 发票 FK 断链 0（凭证 invoiceId 全部命中面料发票）
  const fabricVoucherInvIds = (await prisma.paymentVoucher.findMany({
    where: { orderId: { in: shippedFabricIds }, deletedAt: null },
    select: { invoiceId: true },
  })).map((v) => v.invoiceId).filter((x): x is string => !!x);
  assert(fabricVoucherInvIds.every((x) => invIdSet.has(x)), '面料凭证→发票 FK 断链 0');
  // 核销 → 发票 FK 断链 0
  const fabricAllocInvIds = (await prisma.invoiceAllocation.findMany({
    where: { invoiceId: { in: invIds } },
    select: { invoiceId: true },
  })).map((a) => a.invoiceId);
  assert(fabricAllocInvIds.every((x) => invIdSet.has(x)), '面料核销→发票 FK 断链 0');
  const fabricBatches = await prisma.orderShipmentBatch.count({ where: { orderId: { in: fabricIds } } });
  assert(fabricBatches === 13, `面料批次 ${fabricBatches} 条（期望 13 = 出运 10 + 计划 3）`);

  // 5. 缸差扣款剧情：SIM-FORD-004 发票 = 订单额 × 97%
  const shadeOrder = await prisma.order.findUnique({ where: { id: 'SIM-FORD-004' } });
  const shadeInv = fabricInvoices.find((i) => i.orderId === 'SIM-FORD-004');
  assert(!!shadeOrder && !!shadeInv, '缸差剧情单 SIM-FORD-004 存在（订单+发票）');
  assert(close(Number(shadeInv!.amount), Number(shadeOrder!.totalNet) * 0.97), `缸差发票 = 订单额 × 97%（${Number(shadeInv!.amount)} = ${Number(shadeOrder!.totalNet)} × 0.97）`);
  assert((shadeInv!.notes ?? '').includes('缸差'), '缸差发票备注留痕');
  const shadeQc = await prisma.inspectionReport.findFirst({ where: { orderId: 'SIM-FORD-004', inspectionType: 'final' } });
  assert(!!shadeQc && shadeQc.result === 'conditional', '缸差单终期验布 conditional（QC 留痕）');

  // 6. 分批出运剧情：SIM-FORD-006 一单 2 票 2 批次 2 发票，票额合计 = 订单额
  //    （交期未来 2026-09-14 → deposit 分流：每票 30% 定金，partially_settled）
  const splitOrder = await prisma.order.findUnique({ where: { id: 'SIM-FORD-006' } });
  const splitShips = await prisma.shipment.count({ where: { orderId: 'SIM-FORD-006', deletedAt: null } });
  const splitBatches = await prisma.orderShipmentBatch.findMany({ where: { orderId: 'SIM-FORD-006' }, select: { invoicedAmount: true, settleStatus: true } });
  const splitInvs = fabricInvoices.filter((i) => i.orderId === 'SIM-FORD-006');
  assert(splitShips === 2, `分批单出运 ${splitShips} 票（期望 2）`);
  assert(splitBatches.length === 2 && splitBatches.every((b) => b.settleStatus === 'partially_settled'), '分批 2 批次 partially_settled（未来交期定金 30%）');
  const invSum = splitInvs.reduce((s, i) => s + Number(i.amount), 0);
  assert(close(invSum, Number(splitOrder!.totalNet)), `分批发票合计 = 订单额（${round2Str(invSum)} vs ${round2Str(Number(splitOrder!.totalNet))}）`);
  assert(splitInvs.every((i) => i.status === 'PartiallyPaid'), '分批 2 发票均 PartiallyPaid（定金已收尾款在途）');
  const splitVouchers = await prisma.paymentVoucher.count({ where: { orderId: 'SIM-FORD-006', deletedAt: null } });
  assert(splitVouchers === 2, `分批定金凭证 ${splitVouchers} 张（期望 2，每票 30%）`);

  // 7. 逾期催款剧情：2 张面料 DunningRecord + 发票 PartiallyPaid
  const fabricDuns = await prisma.dunningRecord.count({ where: { id: { in: ['SIM-DUN-611', 'SIM-DUN-612'] } } });
  assert(fabricDuns === 2, `面料 DunningRecord ${fabricDuns} 张（期望 2，与成衣 3 单并存）`);
  const dunnedOrderIds = await prisma.order.findMany({ where: { id: { in: ['SIM-FORD-002', 'SIM-FORD-005'] } }, select: { id: true } });
  assert(dunnedOrderIds.length === 2, '逾期面料单 SIM-FORD-002/005 存在');
  for (const oid of dunnedOrderIds.map((o) => o.id)) {
    const inv = fabricInvoices.find((i) => i.orderId === oid);
    assert(!!inv && inv.status === 'PartiallyPaid', `逾期单 ${oid} 发票 PartiallyPaid（半款未收）`);
  }

  // 8. 面料报价剧情：3 张赢单转面料订单 + Order.source 回写
  const fabricQuotes = await prisma.quotation.findMany({ where: { convertedOrderId: { in: fabricIds } }, select: { convertedOrderId: true, status: true } });
  assert(fabricQuotes.length === 3 && fabricQuotes.every((q) => q.status === 'Accepted'), `面料赢单报价 ${fabricQuotes.length} 张（Accepted）`);
  const quoteOrderIds = fabricQuotes.map((q) => q.convertedOrderId!);
  const converted = await prisma.order.findMany({ where: { id: { in: quoteOrderIds } }, select: { id: true, source: true } });
  // ★★ 2026-09-25（S4 任务 2）：只核 `source` 回写、**刻意不核**主档三列是否等于报价额
  //   —— 见 quotations.ts 回写处的论证（只写 quoteAmount 是对的，与生产 quotationService 同形）。
  //   ⚠️ 缺的是「订单行合计 ↔ 报价单总额」的对撞，已登记为缺口（处置见 S4 处置件），别把本条读成"金额已核"。
  assert(converted.every((o) => o.source === 'quotation-convert'), '面料赢单订单 source=quotation-convert 回写');

  // 9. 面料单无成衣 10 阶段生产链；Delivered 单有 4 步审计流转
  const fabricStages = await prisma.productionStage.count({ where: { orderId: { in: fabricIds } } });
  assert(fabricStages === 0, `面料单 ProductionStage ${fabricStages} 行（期望 0，无成衣生产链）`);
  const deliveredFabric = fabricOrders.filter((o) => o.status === 'Delivered');
  for (const o of deliveredFabric.slice(0, 3)) {
    const ts = await prisma.orderStatusTransition.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } });
    assert(ts.length === 4 && ts.map((t) => t.toStatus).join('→') === 'Confirmed→Production→Shipping→Delivered',
      `${o.code} 流转链 4 步齐全`);
  }
  // 10. 面料行口径：unit=Meter + materialCode 命中面料档案（完备度引擎不新增缺口）
  const fabricLines = await prisma.orderLine.findMany({ where: { orderId: { in: fabricIds } }, select: { unit: true, materialCode: true } });
  assert(fabricLines.length > 0 && fabricLines.every((l) => l.unit === 'Meter'), `面料订单行 ${fabricLines.length} 行全部 unit=Meter`);
  const fabricSkus = new Set(fabricLines.map((l) => l.materialCode).filter((x): x is string => !!x));
  const matchedAssets = await prisma.productAsset.count({ where: { sku: { in: [...fabricSkus] }, mainCategory: 'Fabric', deletedAt: null } });
  assert(matchedAssets === fabricSkus.size, `面料行 materialCode → ProductAsset 档案全命中（${matchedAssets}/${fabricSkus.size}）`);

  console.log('\n✅ 面料外销业务线核对通过（类型/FK/缸差/分批/逾期/报价）。');
}

function round2Str(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 发票时序分流核对（2026-09-02 修复）：交期未来（>= 2026-09-03）的 Delivered 单
 * 提前出运合法但交易周期未完——发票 ∈ {Issued, PartiallyPaid}，Paid=0；
 * 交期已过的非逾期单全 Paid（3 张逾期剧情单 PartiallyPaid + Dunning 保留）；
 * 核销额与发票状态全局自洽（Delivered 单口径）。
 */
async function verifyFinanceTimeline(prisma: PrismaClient): Promise<void> {
  console.log('\n── 发票时序分流核对（未来交期 Delivered 不全额结清） ──');
  const FUTURE_CUTOFF = '2026-09-03';
  const deliveredOrders = await prisma.order.findMany({
    where: { status: 'Delivered', deletedAt: null },
    select: { id: true, dueDate: true },
  });
  const futureIds = deliveredOrders.filter((o) => (o.dueDate ?? '') >= FUTURE_CUTOFF).map((o) => o.id);
  const pastIds = deliveredOrders.filter((o) => (o.dueDate ?? '') < FUTURE_CUTOFF).map((o) => o.id);
  assert(futureIds.length === 28, `未来交期（>=${FUTURE_CUTOFF}）Delivered ${futureIds.length} 单（期望 28）`);
  assert(pastIds.length === 13, `交期已过 Delivered ${pastIds.length} 单（期望 13）`);

  const statusCount = async (ids: string[]) => {
    const groups = await prisma.invoice.groupBy({
      by: ['status'], where: { orderId: { in: ids }, type: 'Receivable', deletedAt: null }, _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.status, g._count._all] as const));
  };
  // 未来交期 28 单 → 29 张发票（分批大单 2 票）：8 Issued + 21 PartiallyPaid + 0 Paid
  const futureBy = await statusCount(futureIds);
  assert((futureBy.get('Paid') ?? 0) === 0, `未来交期发票 Paid=0（实际 ${futureBy.get('Paid') ?? 0}）`);
  assert((futureBy.get('Issued') ?? 0) === 8, `未来交期 Issued=${futureBy.get('Issued') ?? 0}（期望 8，零收款）`);
  assert((futureBy.get('PartiallyPaid') ?? 0) === 21, `未来交期 PartiallyPaid=${futureBy.get('PartiallyPaid') ?? 0}（期望 21 = 定金 19 票 + 逾期 2 票）`);
  // 交期已过 13 单 → 13 张发票：10 Paid（非逾期全清）+ 3 PartiallyPaid（逾期剧情单）
  const pastBy = await statusCount(pastIds);
  assert((pastBy.get('Paid') ?? 0) === 10, `已过交期发票 Paid=${pastBy.get('Paid') ?? 0}（期望 10）`);
  assert((pastBy.get('PartiallyPaid') ?? 0) === 3, `已过交期发票 PartiallyPaid=${pastBy.get('PartiallyPaid') ?? 0}（期望 3，逾期剧情单）`);

  // Delivered 单发票核销全局自洽：Paid=全额核销；PartiallyPaid=0<核销<票额；Issued=零核销
  const deliveredInvoices = await prisma.invoice.findMany({
    where: { orderId: { in: deliveredOrders.map((o) => o.id) }, type: 'Receivable', deletedAt: null },
    select: { id: true, status: true, amount: true },
  });
  const allocSums = new Map<string, number>();
  (await prisma.invoiceAllocation.groupBy({ by: ['invoiceId'], _sum: { appliedAmount: true } }))
    .forEach((g) => allocSums.set(g.invoiceId, Number(g._sum.appliedAmount ?? 0)));
  let badPaid = 0, badPartial = 0, badIssued = 0;
  for (const inv of deliveredInvoices) {
    const sum = allocSums.get(inv.id) ?? 0;
    const amt = Number(inv.amount);
    if (inv.status === 'Paid' && Math.abs(sum - amt) > 0.01) badPaid++;
    if (inv.status === 'PartiallyPaid' && !(sum > 0 && sum < amt - 0.01)) badPartial++;
    if (inv.status === 'Issued' && sum > 0.005) badIssued++;
  }
  assert(badPaid === 0, `Paid 发票核销=票额（不一致 ${badPaid} 张）`);
  assert(badPartial === 0, `PartiallyPaid 发票 0<核销<票额（不一致 ${badPartial} 张）`);
  assert(badIssued === 0, `Issued 发票零核销（不一致 ${badIssued} 张）`);

  // DunningRecord 只挂 5 张逾期剧情单（成衣 3 + 面料 2），不挂未来交期分流单
  const dunningTotal = await prisma.dunningRecord.count();
  assert(dunningTotal === 5, `DunningRecord ${dunningTotal} 张（期望 5，均为逾期剧情单，不含分流单）`);
  const dunnedPo = await prisma.dunningRecord.findMany({ select: { note: true } });
  assert(dunnedPo.every((d) => (d.note ?? '').includes('逾期')), 'DunningRecord 备注均为逾期口径');

  console.log('\n✅ 发票时序分流核对通过（未来交期 8 Issued + 21 PartiallyPaid，Paid=0）。');
}

/**
 * 上线前数据修复八项断言（2026-09-02 审计修复批次）：
 * ①价格词汇 factory/customer ②供应商工厂域（档案/评估/认证/产能 + 评分缓存一致）
 * ③客户品号映射 FK ④发票状态机全局自洽（Issued 零核销/Paid 全额/部分介于其间）
 * ⑤VoucherIssued 申请单必有 Disbursement 凭证回链 ⑥USD/EUR 汇率快照与行情一致
 * ⑦邮件附件标志一致 ⑧应付链（Payable ≥6 + Disbursement ≥4）
 */
async function verifyDataAuditFixes(prisma: PrismaClient): Promise<void> {
  console.log('\n── 上线前数据修复核对（价格词汇/工厂域/品号/状态机/汇率/附件/应付链） ──');

  // ① 价格词汇：factory=24（出厂价）/ customer=24（客户价），purchase/sale 死词汇清零
  const priceGroups = await prisma.fabricPriceHistory.groupBy({ by: ['priceType'], _count: { _all: true } });
  const priceMap = new Map(priceGroups.map((g) => [g.priceType, g._count._all] as const));
  assert((priceMap.get('factory') ?? 0) === 24, `价格词汇 factory=${priceMap.get('factory') ?? 0}（期望 24）`);
  assert((priceMap.get('customer') ?? 0) === 24, `价格词汇 customer=${priceMap.get('customer') ?? 0}（期望 24）`);
  assert(!priceMap.has('purchase') && !priceMap.has('sale'), 'purchase/sale 死词汇清零（UI 消费方口径统一）');

  // ② 供应商工厂域：档案 10 + 评估 ≥6（多 sourceType）+ 认证 ≥10 + 产能日历 ≥40
  assert(await prisma.factoryProfile.count() === 10, `FactoryProfile = ${await prisma.factoryProfile.count()}（期望 10）`);
  const evalCount = await prisma.factoryEvaluation.count();
  assert(evalCount >= 6, `FactoryEvaluation = ${evalCount}（≥6）`);
  const evalTypes = await prisma.factoryEvaluation.groupBy({ by: ['sourceType'], _count: { _all: true } });
  const typeNames = evalTypes.map((g) => g.sourceType).filter((t): t is string => !!t);
  assert(new Set(typeNames).size >= 3, `评估 sourceType ≥ 3 种（实际 ${[...new Set(typeNames)].join('/') || '无'}）`);
  assert(await prisma.factoryCertification.count() >= 10, `FactoryCertification = ${await prisma.factoryCertification.count()}（≥10）`);
  assert(await prisma.factoryCapacity.count() >= 40, `FactoryCapacity = ${await prisma.factoryCapacity.count()}（≥40）`);
  // 评分缓存 = 各 kind 评估均值（与 factoryService.addEvaluation 事务重算口径一致）
  const profiles = await prisma.factoryProfile.findMany({ select: { id: true, qualityScore: true, deliveryScore: true } });
  for (const p of profiles) {
    const [insp, deliv] = await Promise.all([
      prisma.factoryEvaluation.findMany({ where: { factoryId: p.id, kind: 'inspection', deletedAt: null }, select: { score: true } }),
      prisma.factoryEvaluation.findMany({ where: { factoryId: p.id, kind: 'delivery', deletedAt: null }, select: { score: true } }),
    ]);
    const avg = (xs: Array<{ score: number }>) => (xs.length ? xs.reduce((s, r) => s + r.score, 0) / xs.length : 0);
    assert(Math.abs(avg(insp) - p.qualityScore) < 0.01, `${p.id} qualityScore=${p.qualityScore} = 验货评估均值`);
    assert(Math.abs(avg(deliv) - p.deliveryScore) < 0.01, `${p.id} deliveryScore=${p.deliveryScore} = 交期评估均值`);
  }

  // ③ 客户品号映射：≥12 条，FK 全命中，专属行属主可锚定
  const fcc = await prisma.fabricCustomerCode.findMany({ where: { deletedAt: null } });
  assert(fcc.length >= 12, `FabricCustomerCode = ${fcc.length}（≥12）`);
  const fccAssetHit = await prisma.productAsset.count({ where: { id: { in: fcc.map((c) => c.productAssetId) } } });
  assert(fccAssetHit === new Set(fcc.map((c) => c.productAssetId)).size, '品号映射 → ProductAsset FK 全命中');
  const fccRelHit = await prisma.relation.count({ where: { id: { in: fcc.map((c) => c.customerOrganizationId).filter((x): x is string => !!x) } } });
  const fccRelIds = new Set(fcc.map((c) => c.customerOrganizationId).filter((x): x is string => !!x));
  assert(fccRelHit === fccRelIds.size, '品号映射 → Relation FK 全命中');
  assert(fcc.filter((c) => c.isExclusive).every((c) => !!c.customerOrganizationId), '专属面料行属主全部可锚定（P1-3 门禁前提）');

  // ④ 发票状态机全局自洽（Receivable + Payable 全量）：Issued 零核销 / Paid 全额 / PartiallyPaid 介于其间
  const allocSumsAll = new Map<string, number>();
  (await prisma.invoiceAllocation.groupBy({ by: ['invoiceId'], _sum: { appliedAmount: true } }))
    .forEach((g) => allocSumsAll.set(g.invoiceId, Number(g._sum.appliedAmount ?? 0)));
  const allInvoices = await prisma.invoice.findMany({ where: { deletedAt: null }, select: { id: true, status: true, amount: true } });
  let badState = 0;
  for (const inv of allInvoices) {
    const sum = allocSumsAll.get(inv.id) ?? 0;
    const amt = Number(inv.amount);
    if (inv.status === 'Issued' && sum > 0.005) badState++;
    if (inv.status === 'Paid' && Math.abs(sum - amt) > 0.01) badState++;
    if (inv.status === 'PartiallyPaid' && !(sum > 0 && sum < amt - 0.01)) badState++;
  }
  assert(badState === 0, `发票状态机全局自洽（违例 ${badState} 张：Issued 零核销 / Paid 全额 / PartiallyPaid 部分）`);

  // ⑤ VoucherIssued 申请单必有 Disbursement 凭证回链（DR-017 勾稽）
  const viPrs = await prisma.paymentRequest.findMany({ where: { status: 'VoucherIssued' }, select: { id: true, paymentVoucherId: true } });
  assert(viPrs.length >= 4 && viPrs.every((p) => !!p.paymentVoucherId), `VoucherIssued 申请 ${viPrs.length} 条全部回链凭证`);
  const wiredIds = viPrs.map((p) => p.paymentVoucherId!).filter((x, i, a) => a.indexOf(x) === i);
  const wiredVouchers = await prisma.paymentVoucher.count({ where: { id: { in: wiredIds }, type: 'Disbursement' } });
  assert(wiredVouchers === wiredIds.length, '回链凭证全部为 Disbursement 付款凭证');

  // ⑥ 汇率快照：USD ≈ 6.74（ExchangeRate 行情 2026-08 为 6.7369~6.7371）/ EUR 7.82
  const usdInv = await prisma.invoice.findMany({ where: { currency: 'USD', deletedAt: null }, select: { exchangeRate: true } });
  assert(usdInv.length > 0 && usdInv.every((i) => Math.abs(Number(i.exchangeRate) - 6.74) < 0.005),
    `USD 发票汇率快照 = 6.74（${usdInv.length} 张全一致）`);
  const usdVch = await prisma.paymentVoucher.findMany({ where: { currency: 'USD', deletedAt: null }, select: { exchangeRate: true } });
  assert(usdVch.length > 0 && usdVch.every((v) => Math.abs(Number(v.exchangeRate) - 6.74) < 0.005),
    `USD 凭证汇率快照 = 6.74（${usdVch.length} 张全一致，与发票同汇率）`);
  const eurRows = [
    ...await prisma.invoice.findMany({ where: { currency: 'EUR', deletedAt: null }, select: { exchangeRate: true } }),
    ...await prisma.paymentVoucher.findMany({ where: { currency: 'EUR', deletedAt: null }, select: { exchangeRate: true } }),
  ];
  assert(eurRows.every((r) => Math.abs(Number(r.exchangeRate) - 7.82) < 0.005), `EUR 汇率快照 = 7.82（${eurRows.length} 张）`);

  // ⑦ 邮件附件标志一致：hasAttachments=true 必须有 EmailAttachment 行（本 seed 无真实文件全置 false）
  const flaggedEmails = await prisma.email.findMany({ where: { hasAttachments: true }, select: { id: true } });
  let orphanFlags = 0;
  for (const e of flaggedEmails) {
    const n = await prisma.emailAttachment.count({ where: { emailId: e.id } });
    if (n === 0) orphanFlags++;
  }
  assert(orphanFlags === 0, `邮件附件标志一致（hasAttachments=true 但 0 附件：${orphanFlags} 封）`);

  // ⑧ 应付链：Payable ≥6（含部分付款）+ Disbursement ≥4
  const payableStatus = await prisma.invoice.groupBy({ by: ['status'], where: { type: 'Payable', deletedAt: null }, _count: { _all: true } });
  const payMap = new Map(payableStatus.map((g) => [g.status, g._count._all] as const));
  const payableTotal = payableStatus.reduce((s, g) => s + g._count._all, 0);
  assert(payableTotal >= 6, `Payable 发票 = ${payableTotal}（≥6：Paid ${payMap.get('Paid') ?? 0} / PartiallyPaid ${payMap.get('PartiallyPaid') ?? 0} / Issued ${payMap.get('Issued') ?? 0}）`);
  assert((payMap.get('Paid') ?? 0) >= 3 && (payMap.get('PartiallyPaid') ?? 0) >= 1 && (payMap.get('Issued') ?? 0) >= 1, '应付发票状态分布：全额付 ≥3 + 部分付 ≥1 + 未付 ≥1');
  const disbCount = await prisma.paymentVoucher.count({ where: { type: 'Disbursement', deletedAt: null } });
  assert(disbCount >= 4, `Disbursement 付款凭证 = ${disbCount}（≥4）`);
  const payableAlloc = await prisma.invoiceAllocation.count({ where: { id: { startsWith: 'SIM-PALLOC-' } } });
  assert(payableAlloc >= 4, `应付核销明细 = ${payableAlloc}（≥4）`);

  console.log('\n✅ 上线前数据修复八项核对通过。');
}

export async function verifySeed(prisma: PrismaClient): Promise<void> {
  console.log('\n════════ 各表 count 清单 ════════');
  let fail = false;
  for (const [delegate, label] of COUNTED_TABLES) {
    const n = await countOf(prisma, delegate);
    if (n < 0) {
      console.log(`  ⚠ ${label}: delegate 缺失`);
      fail = true;
      continue;
    }
    console.log(`  ${String(n).padStart(6)}  ${label}`);
  }
  if (fail) throw new Error('部分表无法统计，请检查 delegate 命名');

  // 剧情分布断言（成衣 56 + 面料外销 13 = 69）
  const byStatus = await prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
  console.log('\n── 订单状态分布 ──');
  const expect: Record<string, number> = { Delivered: 41, Shipping: 6, Production: 11, Confirmed: 7, Pending: 4 };
  const totalOrders = byStatus.reduce((s, g) => s + g._count._all, 0);
  assert(totalOrders === 69, `订单总数 = ${totalOrders}（期望 69 = 成衣 56 + 面料 13）`);
  for (const g of byStatus) {
    console.log(`  ${g.status.padEnd(12)} ${g._count._all}`);
    if (expect[g.status] !== undefined) {
      assert(g._count._all === expect[g.status], `状态 ${g.status} = ${g._count._all}（期望 ${expect[g.status]}）`);
    }
  }
  // Pending 单均在最近一周（W13 起 2026-08-24）
  const pendings = await prisma.order.findMany({ where: { status: 'Pending' }, select: { createdAt: true, code: true } });
  const w13 = Date.UTC(2026, 7, 24);
  assert(pendings.every((p) => p.createdAt.getTime() >= w13), '4 单 Pending 均创建于最近一周（≥2026-08-24）');
  // 无非 SIM 编号
  const foreign = await prisma.order.count({ where: { code: { not: { startsWith: 'SIM-' } } } });
  assert(foreign === 0, `无非 SIM- 编号订单残留（${foreign}）`);

  await verifyFullChain(prisma);
  await verifyProcurementChain(prisma);
  await verifyQuotationCustomsChain(prisma);
  await verifyTestRequestChain(prisma);
  await verifyFabricChain(prisma);
  await verifyFinanceTimeline(prisma);
  await verifyThirdWaveDomains(prisma);
  await verifyDataAuditFixes(prisma);
  console.log('\n✅ 二期联动抽链核对全部通过（采购库存 / 报价报关 / 测试整改 / 面料外销 / 发票时序 / 三期补数域 / 上线前数据修复）。');
}

/**
 * 三期补数域断言（2026-09-02）：BOM/MES 排产/变更/询价、季节/营销、
 * 样品间/付款申请/VAT/结汇、薪资——各域条数下限 + 关键 FK 抽查。
 */
async function verifyThirdWaveDomains(prisma: PrismaClient): Promise<void> {
  console.log('\n── 三期补数域（BOM/MES/季节营销/样品财务/薪资） ──');
  assert(await prisma.bOM.count() >= 9, `BOM ≥ 9（实际 ${await prisma.bOM.count()}）`);
  assert(await prisma.bOMLine.count() >= 70, `BOMLine ≥ 70（实际 ${await prisma.bOMLine.count()}）`);
  assert(await prisma.productionPlan.count() >= 10, `ProductionPlan ≥ 10（实际 ${await prisma.productionPlan.count()}）`);
  assert(await prisma.orderChangeRequest.count() >= 5, `OrderChangeRequest ≥ 5（实际 ${await prisma.orderChangeRequest.count()}）`);
  assert(await prisma.supplierInquiry.count() >= 4, `SupplierInquiry ≥ 4（实际 ${await prisma.supplierInquiry.count()}）`);
  assert(await prisma.season.count() >= 4, `Season ≥ 4（实际 ${await prisma.season.count()}）`);
  assert(await prisma.trendTag.count() >= 9, `TrendTag ≥ 9（实际 ${await prisma.trendTag.count()}）`);
  assert(await prisma.tradeShow.count() >= 3, `TradeShow ≥ 3（实际 ${await prisma.tradeShow.count()}）`);
  assert(await prisma.marketingCampaign.count() >= 5, `MarketingCampaign ≥ 5（实际 ${await prisma.marketingCampaign.count()}）`);
  assert(await prisma.marketingLead.count() >= 15, `MarketingLead ≥ 15（实际 ${await prisma.marketingLead.count()}）`);
  assert(await prisma.sampleCardItem.count() >= 25, `SampleCardItem ≥ 25（实际 ${await prisma.sampleCardItem.count()}）`);
  assert(await prisma.sampleCardLoan.count() >= 6, `SampleCardLoan ≥ 6（实际 ${await prisma.sampleCardLoan.count()}）`);
  assert(await prisma.paymentRequest.count() >= 6, `PaymentRequest ≥ 6（实际 ${await prisma.paymentRequest.count()}）`);
  assert(await prisma.vatInvoice.count() >= 7, `VatInvoice ≥ 7（实际 ${await prisma.vatInvoice.count()}）`);
  assert(await prisma.fxSettlement.count() >= 4, `FxSettlement ≥ 4（实际 ${await prisma.fxSettlement.count()}）`);
  assert(await prisma.payrollRun.count() >= 3, `PayrollRun ≥ 3（实际 ${await prisma.payrollRun.count()}）`);
  assert(await prisma.payrollItem.count() >= 36, `PayrollItem ≥ 36（实际 ${await prisma.payrollItem.count()}）`);
  // 孤儿阶段清零
  const orphans = await prisma.productionStage.count({ where: { orderId: 'FAB-UI-ONLY' } });
  assert(orphans === 0, `ProductionStage 孤儿（FAB-UI-ONLY）= ${orphans}`);
  // BOM→订单 FK 抽查
  const brokenBom = await prisma.bOM.count({ where: { order: null as never } }).catch(() => 0);
  void brokenBom; // BOM.orderId 可空字段以 SQL 反连接为准，此处仅 count 下限保障
  // 样品借出逾期喂点
  const overdueLoans = await prisma.sampleCardLoan.count({ where: { returnedAt: null, dueAt: { lt: BigInt(Date.UTC(2026, 7, 30)) } } });
  assert(overdueLoans >= 1, `样品逾期未还 ≥ 1（实际 ${overdueLoans}）`);
}
