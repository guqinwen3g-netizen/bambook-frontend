/** Supplier-to-us fabric commission. The immutable original is deliberately
 * separate from the currently eligible whole-order shipment source. */
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { isValidLocalDateKey } from '../shared/localDate';
import { documentSourceFingerprint as hash, documentSourceJson as json, currentDocumentActor,
  authorizedDocumentOrders, shipmentDocumentSourceInTx, lockShipmentDocumentSourcesInTx } from '../shipping/shipmentDocumentSource';
import { readOrderLineProductionCompletion } from '../production/productionCompletionService';
import { verifyOrderMainFrozenEvidence } from '../orders/orderMainApprovalEvidence';
import { calculateFabricCommission, fabricCommissionFinancialLine,
  type FabricFinancialLine, type FabricCommissionBranch, type FabricCommissionShipment, type FabricCommissionGroup } from '../orders/fabricCommissionPolicy';

export const FABRIC_COMMISSION_SOURCE = 'FabricCommissionCI';
export const FABRIC_COMMISSION_PREFIX = 'fabric-commission:v1:';
export const FABRIC_COMMISSION_SETTLED = 'settle_fabric_order_commission';
export const FABRIC_COMMISSION_REGISTERED = 'register_fabric_commission_receivable';
export const commissionSettlementId = (orderId: string) => `fabric_commission_settlement_${hash({ orderId })}`;
export const commissionObject = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
function conflict(message: string): never { throw businessError('HANDOFF_CONFLICT', message); }
export type FabricCommissionParty = { id: string; name: string; address: string | null; taxId: string | null };
export type FabricCommissionSource = {
  schemaVersion: 1; sourceType: typeof FABRIC_COMMISSION_SOURCE; orderId: string; orderNumber: string; poNumber: string | null;
  customerId: string; currency: string; approvalId: string; approvalAuditId: string; approvalFingerprint: string;
  financialLines: ReturnType<typeof fabricCommissionFinancialLine>[]; branches: FabricCommissionBranch[];
  shipments: FabricCommissionShipment[]; departureEvents: Array<{ id: string; shipmentId: string; atd: string; commandHash: string }>;
  groups: Array<FabricCommissionGroup & { party: FabricCommissionParty }>; sourceFingerprint: string;
};
export type FabricCommissionIssuedSnapshot = { schemaVersion: 1; sourceType: typeof FABRIC_COMMISSION_SOURCE;
  settlementId: string; source: FabricCommissionSource; supplierId: string; issueDate: string; dueDate: string | null;
  issuedAt: string; issuedBy: string; exporterSnapshot: Record<string, unknown> };
export type FabricCommissionDocumentReceipt = { supplierId: string; documentId: string; versionId: string; documentNumber: string;
  amount: string; currency: string };
export type FabricCommissionSettlementReceipt = { settlementId: string; orderId: string; sourceFingerprint: string;
  documents: FabricCommissionDocumentReceipt[]; auditId: string; requestKey: string };

async function shipmentIds(tx: Prisma.TransactionClient, orderId: string) {
  const allocations = await tx.shipmentOrderAllocation.findMany({ where: { orderId, status: { not: 'Cancelled' } }, select: { shipmentId: true } });
  const physical = await tx.shipmentProductionAllocation.findMany({ where: { orderId, state: { in: ['reserved', 'shipped'] } }, select: { shipmentId: true } });
  const direct = await tx.shipment.findMany({ where: { orderId, deletedAt: null, status: { not: 'Cancelled' } }, select: { id: true } });
  return [...new Set([...allocations, ...physical].map(r => r.shipmentId).concat(direct.map(r => r.id)))].sort();
}
export async function lockFabricCommissionSourcesInTx(tx: Prisma.TransactionClient, actor: TokenPayload, orderId: string) {
  const before = await shipmentIds(tx, orderId);
  await lockShipmentDocumentSourcesInTx(tx, before, { trustedActor: actor, extraScopes: ['orders:read'] }, [orderId]);
  if (hash(before) !== hash(await shipmentIds(tx, orderId))) conflict('本订单实际出运集合在取锁时变化，请重新核对。');
}

/** No read side writes. No order status, planned departure or manual monetary
 * projection is accepted as evidence of physical shipment completion. */
export async function currentFabricCommissionSource(tx: Prisma.TransactionClient, prior: TokenPayload, orderId: string): Promise<FabricCommissionSource> {
  const actor = await currentDocumentActor(tx, prior, ['orders:read', 'shipments:read']);
  const [order] = await authorizedDocumentOrders(tx, actor, [orderId]);
  if (String(order.businessLine ?? order.type).toLowerCase() !== 'fabric' || !order.customerRelationId)
    conflict('只有有真实客户的面料订单可以办理供应商向我方支付的佣金。');
  const approvals = await tx.approvalRequest.findMany({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: orderId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (approvals[0]?.status === 'pending' || ['Pending', 'Cancelled', 'Archived'].includes(order.status)) conflict('本订单没有当前有效的实际主单批准。');
  const approval = approvals.find(row => row.status === 'approved' && row.reviewerId && row.decidedAt != null);
  if (!approval || verifyOrderMainFrozenEvidence(approval, order) !== 'verified') conflict('佣金结算需要准确可核验的原生主单批准，历史未知不能推断。');
  const payload = commissionObject(approval.payload), frozen = commissionObject(commissionObject(payload.snapshot).order);
  const frozenLines = Array.isArray(frozen.lines) ? frozen.lines : [];
  const financialLines = (order.lines as FabricFinancialLine[]).map(fabricCommissionFinancialLine).sort((a, b) => a.id.localeCompare(b.id));
  if (frozen.currency !== order.currency || frozen.customerRelationId !== order.customerRelationId
    || hash(frozenLines.map(row => fabricCommissionFinancialLine(row as FabricFinancialLine)).sort((a, b) => a.id.localeCompare(b.id))) !== hash(financialLines))
    conflict('当前货物价格、佣金率、付款供应商或准确行来源已偏离批准原件，不能消费旧结算依据。');
  const audit = await tx.auditLog.findFirst({ where: { action: 'approve_order_main_approval', targetType: 'ApprovalRequest', targetId: approval.id,
    actorId: approval.reviewerId!, detail: { path: ['source'], equals: 'api:order-main-approval' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const approved = commissionObject(commissionObject(audit?.detail).after);
  if (!audit || approved.orderId !== orderId || approved.decision !== 'approved') conflict('缺少实际主单批准完成审计。');
  if (!/^[A-Z]{3}$/.test(order.currency ?? '')) conflict('原批准订单币种未知。');
  const branches: FabricCommissionBranch[] = [];
  for (const line of order.lines) {
    const completion = await readOrderLineProductionCompletion(tx, order, line);
    if (!completion.productionComplete || completion.status !== 'complete') conflict('全单仍有未完工、未核验或数量待处理的实际分支，不能结算。');
    for (const branch of completion.branches) branches.push({ id: branch.productionBatchId, orderLineId: line.id,
      revision: branch.productionBatchRevision, actualQuantity: branch.actualQty, shippedQuantity: '0', unit: branch.unit });
  }
  const rows: FabricCommissionShipment[] = [], departureEvents: FabricCommissionSource['departureEvents'] = [];
  const byBatch = new Map<string, Prisma.Decimal>();
  for (const id of await shipmentIds(tx, orderId)) {
    const source = await shipmentDocumentSourceInTx(tx, id, { trustedActor: actor, extraScopes: ['orders:read'] });
    if (source.kind !== 'physical' || !source.cartonCoverageComplete || source.shipment.status !== 'Shipped'
      || !isValidLocalDateKey(source.shipment.atd)) conflict('全单尚有未实际离港、未装箱核对或历史未知来源，不能提前结算佣金。');
    const events = await tx.shipmentHandoffEvent.findMany({ where: { decision: 'actual_departure', payload: { path: ['shipmentId'], equals: id } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const event = events.find(row => { const p = commissionObject(row.payload); return p.action === 'confirm-departure' && p.shipmentStatus === 'Shipped'
      && p.atd === source.shipment.atd && p.commandHash === row.commandHash && typeof row.commandHash === 'string' && row.requestKey === p.requestKey; });
    if (!event?.commandHash) conflict('实际离港缺少原生业务确认回执，不能借手填运单状态生成佣金。');
    departureEvents.push({ id: event.id, shipmentId: id, atd: source.shipment.atd, commandHash: event.commandHash });
    for (const p of source.physical.filter(p => p.orderId === orderId && !['released', 'reversed'].includes(p.state))) {
      const branch = branches.find(b => b.id === p.productionBatchId);
      if (!branch || p.productionBatchRevision !== branch.revision || p.state !== 'shipped' || p.actualQty == null || p.unit !== branch.unit)
        conflict('实际物理出运与当前准确完工修订不一致。');
      byBatch.set(branch.id, (byBatch.get(branch.id) ?? new Prisma.Decimal(0)).plus(p.actualQty));
    }
    for (const line of source.lines.filter(line => line.orderId === orderId)) {
      if (!line.orderLineId || line.quantity == null || !line.unit) conflict('本票准确装运行数量或归属未知。');
      const physicalQty = source.physical.filter(p => p.orderId === orderId && p.orderLineId === line.orderLineId && p.state === 'shipped')
        .reduce((sum, p) => sum.plus(p.actualQty ?? 0), new Prisma.Decimal(0));
      const packedQty = source.lines.filter(row => row.orderLineId === line.orderLineId).reduce((sum, row) => sum.plus(row.quantity ?? 0), new Prisma.Decimal(0));
      if (!physicalQty.eq(packedQty)) conflict('本票实际物理出运量与完整装运行不一致，不能结算。');
      rows.push({ shipmentId: id, shipmentLineId: line.id, orderLineId: line.orderLineId, quantity: line.quantity, unit: line.unit,
        atd: source.shipment.atd, state: 'shipped' });
    }
  }
  for (const branch of branches) branch.shippedQuantity = (byBatch.get(branch.id) ?? new Prisma.Decimal(0)).toString();
  const calculated = calculateFabricCommission(order.lines, branches, rows), groups: FabricCommissionSource['groups'] = [];
  for (const group of calculated.groups) {
    const party = await tx.relation.findFirst({ where: { id: group.supplierId, deletedAt: null, isOrganization: true, category: 'Supplier' } });
    if (!party) conflict('准确批准的实际佣金付款供应商已不可核验。');
    groups.push({ ...group, party: { id: party.id, name: party.englishName || party.chineseName || party.name, address: party.billingAddress || party.officialAddress || null, taxId: party.taxId ?? null } });
  }
  const facts: Omit<FabricCommissionSource, 'sourceFingerprint'> = { schemaVersion: 1, sourceType: FABRIC_COMMISSION_SOURCE, orderId,
    orderNumber: order.code, poNumber: order.poNumber, customerId: order.customerRelationId, currency: order.currency,
    approvalId: approval.id, approvalAuditId: audit.id, approvalFingerprint: String(payload.contentFingerprint), financialLines,
    branches, shipments: rows.sort((a, b) => a.shipmentLineId.localeCompare(b.shipmentLineId)), departureEvents, groups };
  await authorizedDocumentOrders(tx, await currentDocumentActor(tx, prior, ['orders:read', 'shipments:read']), [orderId]);
  return { ...facts, sourceFingerprint: hash(facts) };
}

export async function readFabricCommissionOriginal(tx: Prisma.TransactionClient, documentId: string) {
  const document = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  const version = document && await tx.documentVersion.findFirst({ where: { documentId }, orderBy: [{ version: 'desc' }, { id: 'desc' }] });
  const raw = commissionObject(commissionObject(version?.content).fabricCommissionSnapshot);
  const snapshot = raw as unknown as FabricCommissionIssuedSnapshot;
  const source = commissionObject(raw.source), orderId = source.orderId;
  if (!document || !version || raw.schemaVersion !== 1 || raw.sourceType !== FABRIC_COMMISSION_SOURCE || typeof orderId !== 'string'
    || typeof raw.supplierId !== 'string' || !isValidLocalDateKey(raw.issueDate) || !/^\d+$/.test(String(raw.issuedAt))
    || typeof source.sourceFingerprint !== 'string' || !Array.isArray(source.groups) || !Array.isArray(source.financialLines)
    || !Array.isArray(source.shipments) || !Array.isArray(source.branches)) conflict('佣金原票缺少准确原生结算来源。');
  const { sourceFingerprint, ...facts } = source;
  if (source.sourceType !== FABRIC_COMMISSION_SOURCE || source.schemaVersion !== 1 || hash(facts) !== sourceFingerprint) conflict('佣金原始来源指纹不一致。');
  const approvedOriginal = await tx.approvalRequest.findUnique({ where: { id: snapshot.source.approvalId } });
  const approvedPayload = commissionObject(approvedOriginal?.payload), approvedOrder = commissionObject(commissionObject(approvedPayload.snapshot).order);
  if (!approvedOriginal || approvedOriginal.actionType !== 'order:main_approval' || approvedOriginal.targetType !== 'Order'
    || approvedOriginal.targetId !== orderId || approvedOriginal.status !== 'approved' || !approvedOriginal.reviewerId || !approvedOriginal.decidedAt
    || verifyOrderMainFrozenEvidence(approvedOriginal, approvedOrder) !== 'verified'
    || approvedPayload.contentFingerprint !== snapshot.source.approvalFingerprint || !Array.isArray(approvedOrder.lines)
    || hash(approvedOrder.lines.map(row => fabricCommissionFinancialLine(row as FabricFinancialLine)).sort((a, b) => a.id.localeCompare(b.id))) !== hash(snapshot.source.financialLines))
    conflict('佣金原票缺少一致的实际批准条目原件。');
  const approvedAudit = await tx.auditLog.findUnique({ where: { id: snapshot.source.approvalAuditId } });
  const approvedAfter = commissionObject(commissionObject(approvedAudit?.detail).after);
  if (!approvedAudit || approvedAudit.action !== 'approve_order_main_approval' || approvedAudit.targetId !== approvedOriginal.id
    || approvedAudit.targetType !== 'ApprovalRequest' || approvedAudit.actorId !== approvedOriginal.reviewerId
    || approvedAfter.orderId !== orderId || approvedAfter.decision !== 'approved') conflict('佣金原票的实际批准审计不一致。');
  if (!Array.isArray(snapshot.source.departureEvents) || !snapshot.source.departureEvents.length) conflict('佣金原票缺少原始实际离港回执。');
  for (const original of snapshot.source.departureEvents) {
    const event = await tx.shipmentHandoffEvent.findUnique({ where: { id: original.id } }), p = commissionObject(event?.payload);
    if (!event || event.decision !== 'actual_departure' || event.commandHash !== original.commandHash
      || p.commandHash !== original.commandHash || p.shipmentId !== original.shipmentId || p.atd !== original.atd || p.shipmentStatus !== 'Shipped'
      || p.action !== 'confirm-departure' || !snapshot.source.shipments.some(row => row.shipmentId === original.shipmentId && row.atd === original.atd))
      conflict('佣金原票的实际离港原始依据不一致。');
  }
  const calculated = calculateFabricCommission(snapshot.source.financialLines, snapshot.source.branches, snapshot.source.shipments);
  if (hash(calculated.groups) !== hash(snapshot.source.groups.map(({ party: _party, ...group }) => group))
    || snapshot.source.groups.some(group => group.party.id !== group.supplierId || !group.party.name)
    || snapshot.source.shipments.some(row => !snapshot.source.departureEvents.some(event => event.shipmentId === row.shipmentId && event.atd === row.atd)))
    conflict('佣金原票的实际金额、率或付款方不一致。');
  const group = snapshot.source.groups.find(g => g.supplierId === raw.supplierId);
  const audit = await tx.auditLog.findUnique({ where: { id: commissionSettlementId(orderId) } });
  const detail = commissionObject(audit?.detail), receipt = commissionObject(detail.receipt);
  const docs = Array.isArray(receipt.documents) ? receipt.documents.map(commissionObject) : [];
  const matching = docs.find(d => d.documentId === documentId && d.versionId === version.id && d.supplierId === raw.supplierId);
  if (!group || !audit || audit.action !== FABRIC_COMMISSION_SETTLED || audit.targetType !== 'Order' || audit.targetId !== orderId
    || audit.actorId !== raw.issuedBy || raw.settlementId !== audit.id || hash(detail.source) !== hash(source)
    || receipt.sourceFingerprint !== source.sourceFingerprint || receipt.orderId !== orderId || receipt.settlementId !== audit.id
    || docs.length !== snapshot.source.groups.length || new Set(docs.map(d => d.supplierId)).size !== docs.length
    || new Set(docs.map(d => d.documentId)).size !== docs.length || new Set(docs.map(d => d.versionId)).size !== docs.length
    || snapshot.source.groups.some(g => !docs.some(d => d.supplierId === g.supplierId)) || !matching || matching.documentNumber !== document.documentNumber
    || matching.amount !== group.commissionAmount || matching.currency !== source.currency
    || document.domain !== 'finance' || document.type !== 'CommercialInvoice' || document.status !== 'Issued' || version.version !== 1
    || document.orderId !== orderId || document.sourceRef !== `${FABRIC_COMMISSION_PREFIX}${orderId}:${raw.supplierId}`
    || document.sourceInvoiceId != null || document.relationId !== raw.supplierId || document.currency !== source.currency
    || document.issueDate !== raw.issueDate || !document.totalAmount?.eq(group.commissionAmount))
    conflict('佣金原票、原始版本与唯一结算回执不一致；请核对原件，不得补造。');
  return { document, version, snapshot, group, receipt: receipt as unknown as FabricCommissionSettlementReceipt };
}

export async function readFabricCommissionInvoiceSource(tx: Prisma.TransactionClient, versionId: string) {
  const version = await tx.documentVersion.findUnique({ where: { id: versionId } });
  if (!version) conflict('佣金应收原版本不存在。');
  const original = await readFabricCommissionOriginal(tx, version.documentId);
  if (original.version.id !== versionId) conflict('佣金应收不能借其他版本。');
  const invoice = await tx.invoice.findFirst({ where: { sourceType: FABRIC_COMMISSION_SOURCE, sourceId: versionId, deletedAt: null } });
  const audit = invoice && await tx.auditLog.findFirst({ where: { action: FABRIC_COMMISSION_REGISTERED, targetType: 'Invoice', targetId: invoice.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const detail = commissionObject(audit?.detail);
  const links = invoice && await tx.invoiceOrderAllocation.findMany({ where: { invoiceId: invoice.id, deletedAt: null } });
  if (!invoice || !audit || detail.documentId !== original.document.id || detail.versionId !== versionId
    || detail.sourceFingerprint !== original.snapshot.source.sourceFingerprint || invoice.type !== 'Receivable'
    || invoice.invoiceNumber !== original.document.documentNumber || invoice.customerRelationId !== original.group.supplierId
    || invoice.customerName !== original.group.party.name || invoice.currency !== original.snapshot.source.currency
    || !invoice.amount.eq(original.group.commissionAmount) || invoice.orderId !== original.snapshot.source.orderId
    || invoice.issueDate !== original.snapshot.issueDate || invoice.dueDate !== original.snapshot.dueDate
    || links?.length !== 1 || links[0].orderId !== invoice.orderId || !links[0].allocatedAmount?.eq(invoice.amount))
    conflict('佣金应收与准确原票、付款供应商或财务登记回执不一致。');
  return { ...original, invoice, auditId: audit.id };
}
