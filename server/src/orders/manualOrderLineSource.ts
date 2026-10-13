import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { exactJsonValue } from '../lib/exactJsonValue';
import { factoryRelationIdentitySelect, isUsableFactoryRelation } from '../suppliers/factoryRelationIdentity';

const SOURCE = 'route:order-line:manual-specification';
const reject = (message: string): never => { throw new DevelopmentDomainError('CONFLICT', message); };
const invalid = (message: string): never => { throw new DevelopmentDomainError('INVALID_INPUT', message); };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const manualSourceDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(exactJsonValue(value ?? null)))).digest('hex');
const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return invalid(`请据实填写${label}。`);
  return value.trim();
};
export type ManualSpecificationInput = { factoryRelationId: string; specification: string; agreementBasis: string; evidence: string[] };
export function parseManualSpecification(value: unknown): ManualSpecificationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('请填写本行人工规格、实际约定依据和真实工厂。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['factoryRelationId', 'specification', 'agreementBasis', 'evidence'].includes(key))) return invalid('人工规格含不可提交的批准、身份或来源字段。');
  if (!Array.isArray(input.evidence) || input.evidence.length > 30 || input.evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 2048)) return invalid('规格凭据须为最多 30 项的实际依据。');
  return { factoryRelationId: text(input.factoryRelationId, '真实工厂', 160), specification: text(input.specification, '人工规格', 16000),
    agreementBasis: text(input.agreementBasis, '实际约定依据', 8000), evidence: input.evidence.map(item => String(item).trim()) };
}
function lineBasis(order: any, line: any) {
  return exactJsonValue({ orderId: order.id, orderLineId: line.id, businessLine: String(order.businessLine ?? order.type).toLowerCase(),
    customerRelationId: order.customerRelationId ?? null, description: line.description ?? null, materialCode: line.materialCode ?? null,
    quantity: new Prisma.Decimal(line.quantity).toString(), unit: line.unit ?? null, sizeBreakdown: line.sizeBreakdown ?? null,
    fulfillmentMode: line.fulfillmentMode ?? null, cmtIncludedItems: line.cmtIncludedItems ?? null });
}
async function liveFactory(db: any, factoryId: string) {
  const [factory, profile] = await Promise.all([
    db.relation.findUnique({ where: { id: factoryId }, select: factoryRelationIdentitySelect }),
    db.factoryProfile.findUnique({ where: { relationId: factoryId }, select: { relationId: true, deletedAt: true, blacklistedAt: true } }),
  ]);
  if (!isUsableFactoryRelation(factory) || !profile || profile.deletedAt != null || profile.blacklistedAt != null) return reject('人工规格的实际工厂须为有效供应商组织及有效工厂档案。');
  return factory;
}
/** Called only within the existing fresh-authorized draft Order/Line lock.
 * It records specification, never an approval, customer choice or QC pass. */
export async function produceManualOrderLineSource(db: any, order: any, line: any, value: unknown, actorId: string) {
  if (order.status !== 'Pending' || order.sourceCaseId || !['fabric', 'garment'].includes(String(order.businessLine ?? order.type).toLowerCase()))
    return reject('人工规格仅能在无开发来源的面料/成衣草稿行明确录入；正式规格须走变更审批。');
  if (line.confirmedSourceType && line.confirmedSourceType !== 'ManualOrderLine') return reject('本行已有其他准确来源，不能用人工规格覆盖原来源。');
  const input = parseManualSpecification(value), factory = await liveFactory(db, input.factoryRelationId), basis = lineBasis(order, line);
  if (!line.description?.trim() || !line.unit?.trim() || !new Prisma.Decimal(line.quantity).gt(0)) return invalid('请先填写本行实际产品描述、正数量和单位。');
  if (order.millRelationId && order.millRelationId !== input.factoryRelationId) return reject('人工规格工厂与主单真实工厂不一致。');
  const prior = line.specSnapshot?.manualOrderLine, fingerprint = manualSourceDigest({ basis, ...input });
  if (prior?.fingerprint === fingerprint) return { confirmedSourceType: 'ManualOrderLine', confirmedSourceId: line.id, specSnapshot: line.specSnapshot };
  const snapshot = { schemaVersion: 1, ...input, basis, fingerprint, revision: (Number.isSafeInteger(prior?.revision) ? prior.revision : 0) + 1,
    recordedBy: actorId, recordedAt: String(Date.now()), auditId: `MLA_${randomUUID()}` };
  await db.auditLog.create({ data: { id: snapshot.auditId, actorId, action: 'record_manual_order_line_specification', targetType: 'OrderLine', targetId: line.id,
    detail: exactJsonValue({ source: SOURCE, after: { manualOrderLine: snapshot } }) } });
  return { confirmedSourceType: 'ManualOrderLine', confirmedSourceId: line.id,
    specSnapshot: exactJsonValue({ mainCategory: String(order.businessLine ?? order.type).toLowerCase(), name: line.description, factoryName: factory.name, manualOrderLine: snapshot }) };
}
/** Single current consumer for batch, PP, release and shipment. Exact approval
 * snapshots and native audits are mandatory; old status never supplies them. */
export async function assertManualOrderLineSource(db: any, lineId: string, expectedOrderId?: string) {
  const line = await db.orderLine.findUnique({ where: { id: lineId } });
  const order = line ? await db.order.findFirst({ where: { id: line.orderId, deletedAt: null } }) : null;
  const snapshot = line?.specSnapshot?.manualOrderLine;
  if (!line || !order || expectedOrderId && order.id !== expectedOrderId || order.sourceCaseId
    || line.confirmedSourceType !== 'ManualOrderLine' || line.confirmedSourceId !== line.id || snapshot?.schemaVersion !== 1
    || snapshot.basis?.orderId !== order.id || snapshot.basis?.orderLineId !== line.id || snapshot.basis?.businessLine !== String(order.businessLine ?? order.type).toLowerCase())
    return reject('人工规格准确父订单/行或原生基准缺失，不能猜测来源。');
  const input = parseManualSpecification({ factoryRelationId: snapshot.factoryRelationId, specification: snapshot.specification, agreementBasis: snapshot.agreementBasis, evidence: snapshot.evidence });
  if (snapshot.fingerprint !== manualSourceDigest({ basis: lineBasis(order, line), ...input }) || !snapshot.auditId || !snapshot.recordedBy
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || !/^\d+$/.test(snapshot.recordedAt ?? '')) return reject('人工规格与当前本行约定已变化，请走准确变更依据核验。');
  const producer = await db.auditLog.findUnique({ where: { id: snapshot.auditId } });
  if (producer?.action !== 'record_manual_order_line_specification' || producer.targetType !== 'OrderLine' || producer.targetId !== line.id || producer.actorId !== snapshot.recordedBy
    || producer.detail?.source !== SOURCE || manualSourceDigest(producer.detail?.after?.manualOrderLine) !== manualSourceDigest(snapshot)) return reject('人工规格缺少一致的原生录入审计。');
  const approvals = await db.approvalRequest.findMany({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: order.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (approvals[0]?.status === 'pending' || ['Pending', 'Cancelled', 'Archived'].includes(order.status)) return reject('人工规格尚无当前真实主单批准。');
  const approval = approvals.find((row: any) => row.status === 'approved' && row.reviewerId && row.decidedAt != null
    && row.payload?.snapshot?.order?.id === order.id && row.payload.snapshot.order.lines?.some((item: any) => item.id === line.id
      && item.confirmedSourceType === 'ManualOrderLine' && item.confirmedSourceId === line.id && manualSourceDigest(item.specSnapshot) === manualSourceDigest(line.specSnapshot)));
  if (!approval) return reject('主单批准未冻结本行准确人工规格，不能借其他订单或旧状态。');
  const audit = await db.auditLog.findFirst({ where: { action: 'approve_order_main_approval', targetType: 'ApprovalRequest', targetId: approval.id, actorId: approval.reviewerId,
    detail: { path: ['source'], equals: 'api:order-main-approval' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (audit?.detail?.after?.orderId !== order.id || audit.detail.after.decision !== 'approved') return reject('人工规格缺少真实主单批准完成审计。');
  const factory = await liveFactory(db, input.factoryRelationId);
  if (order.millRelationId && order.millRelationId !== factory.id) return reject('人工规格的当前真实工厂与主单不一致。');
  return { order, line, snapshot, factory, approval, approvalAudit: audit, producerAudit: producer,
    factoryRelationId: input.factoryRelationId, specSnapshot: line.specSnapshot };
}
