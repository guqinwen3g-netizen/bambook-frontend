import { Prisma } from '@prisma/client';
import { assertOrderSampleSource, canonicalOrderSampleDecimal, orderSampleDigest, type OrderSampleCoverage, type OrderSampleSource } from './orderSampleSourceContract';
import { reduceOrderSampleEvents, type OrderSampleEvent, type OrderSampleEventFact } from './orderSampleEventReducer';
import { loadOrderSampleQcEvidence } from './orderSampleQcEvidence';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';

/** Storage reader only: the caller must authorize the actual source graph and
 * select a transaction/snapshot. Valid historical records do not grant current
 * production, shipment, write, or customer access. */
export interface OrderSampleRecordDb {
  orderSampleSource: { findUnique(args: any): Promise<any> };
  orderSampleCoverage: { findMany(args: any): Promise<any[]> };
  orderSampleEvent: { findMany(args: any): Promise<any[]> };
  auditLog: { findMany(args: any): Promise<any[]>; findUnique?(args: any): Promise<any> };
  inspectionReport?: { findUnique(args: any): Promise<any> };
  sample: { findUnique(args: any): Promise<any> };
  sampleSource: { findMany(args: any): Promise<any[]> };
}
export class OrderSampleRecordError extends Error {
  readonly code = 'ORDER_SAMPLE_RECORD_CONFLICT';
  readonly status = 409;
  constructor(message: string) { super(message); this.name = 'OrderSampleRecordError'; }
}
const conflict = (message: string): never => { throw new OrderSampleRecordError(message); };
const same = (a: unknown, b: unknown, label: string) => {
  if (orderSampleDigest(a) !== orderSampleDigest(b)) conflict(`${label}与原始记录不一致。`);
};
const identity = (value: any, label: string): string => {
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.trim() !== value || /[\u0000-\u001f]/.test(value)) conflict(`${label}身份不完整。`);
  return value;
};
const decimal = (value: any, zero = false): string => {
  if (typeof value !== 'string' && !Prisma.Decimal.isDecimal(value)) conflict('数据库数量不是精确十进制记录。');
  return canonicalOrderSampleDecimal(value.toString(), zero);
};
const timestamp = (value: any): string => {
  const result = typeof value === 'bigint' ? String(value) : value;
  if (typeof result !== 'string' || !/^[1-9]\d{0,19}$/.test(result)) conflict('原记录时间缺失。');
  return result;
};
const auditTimestamp = (value: any): string => {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() <= 0) conflict('原审计时间不是有效数据库日期。');
  return String(value.getTime());
};
const MAX_FACTS = 4096;
export function orderSampleCoverageKey(c: OrderSampleCoverage): string {
  return orderSampleDigest({ orderLineId: c.orderLineId, scopeKind: c.scopeKind, productionBatchId: c.productionBatchId,
    productionBatchRevision: c.productionBatchRevision, rangeStart: c.rangeStart, quantity: c.quantity, unit: c.unit });
}
function coverageFact(row: any, parent: any): OrderSampleCoverage {
  if (row.sourceId !== parent.id) conflict('代表范围跨来源。');
  const fact: OrderSampleCoverage = {
    orderId: parent.orderId, factoryRelationId: parent.factoryRelationId, orderLineId: row.orderLineId,
    scopeKind: row.scopeKind, productionBatchId: row.productionBatchId, productionBatchRevision: row.productionBatchRevision,
    rangeStart: decimal(row.rangeStart, true), quantity: decimal(row.quantity), unit: row.unit, lineQuantity: decimal(row.lineQuantity),
    batchRangeStart: row.batchRangeStart === null ? null : decimal(row.batchRangeStart, true),
    batchQuantity: row.batchQuantity === null ? null : decimal(row.batchQuantity), specFingerprint: row.specFingerprint,
    sourceFingerprint: row.sourceFingerprint, lineFingerprint: row.lineFingerprint,
    ...(row.materialProof != null ? { materialProof: row.materialProof } : {}),
    ...(row.productionLineIdentity != null ? { productionLineIdentity: row.productionLineIdentity } : {}),
  };
  if (row.scopeKey !== orderSampleCoverageKey(fact)) conflict('代表范围身份摘要不符。');
  return fact;
}
function eventFact(row: any, source: OrderSampleSource): OrderSampleEventFact {
  return { id: row.id, sourceId: row.sourceId, sampleId: source.sampleId, sequence: row.sequence,
    previousEventId: row.previousEventId, actorId: row.actorId, recordedAt: timestamp(row.recordedAt), occurredAt: row.occurredAt,
    eventType: row.eventType, contentFingerprint: row.contentFingerprint, coverageFingerprint: row.coverageFingerprint, payload: row.payload } as OrderSampleEventFact;
}
export function verifyOrderSampleAcknowledgement(row: any, fact: OrderSampleEventFact, source: OrderSampleSource) {
  const command = row.commandSnapshot, ack = row.acknowledgement;
  if (row.protocolVersion !== 1 || !command || command.protocolVersion !== 1 || command.actorId !== fact.actorId
    || command.requestKey !== row.requestKey || !['register', 'append'].includes(command.operation)
    || (fact.eventType === 'registered' ? command.operation !== 'register' : command.operation !== 'append')
    || Object.keys(command).sort().join(',') !== 'actorId,input,operation,protocolVersion,requestKey') conflict('原命令身份不完整。');
  identity(row.requestKey, '原请求');
  same(command.input, fact.eventType === 'registered' ? { source, event: fact } : { event: fact }, '原命令业务内容');
  same(row.commandHash, orderSampleDigest(command), '原命令摘要');
  if (!ack || Object.keys(ack).sort().join(',') !== 'actorId,auditId,commandHash,eventId,eventSequence,originalEvent,protocolVersion,requestKey,sampleId,sourceId'
    || ack.protocolVersion !== 1 || ack.actorId !== fact.actorId || ack.requestKey !== row.requestKey || ack.commandHash !== row.commandHash
    || ack.sourceId !== fact.sourceId || ack.sampleId !== fact.sampleId || ack.eventId !== fact.id || ack.eventSequence !== fact.sequence
    || ack.auditId !== row.auditId) conflict('原成功回执身份不完整。');
  same(ack.originalEvent, fact, '原成功事件');
  same(row.ackHash, orderSampleDigest(ack), '原成功回执摘要');
  return ack;
}

/** Reads every event and its actual native audit by explicit identity; missing
 * delegates/tables/SQL failures propagate, never fall back to generic status. */
export async function loadOrderSampleRecord(db: OrderSampleRecordDb, sourceId: string) {
  return loadRecord(db, sourceId, new Set<string>());
}
async function loadRecord(db: OrderSampleRecordDb, sourceId: string, visited: Set<string>): Promise<{source: OrderSampleSource; events: OrderSampleEvent[]; view: ReturnType<typeof reduceOrderSampleEvents>; acknowledgements: any[]}> {
  if (visited.size >= 128 || visited.has(sourceId)) conflict('前轮来源循环或超出完整链读取预算。');
  visited.add(sourceId);
  identity(sourceId, '来源');
  const row = await db.orderSampleSource.findUnique({ where: { id: sourceId } });
  if (!row || row.id !== sourceId) conflict('原订单样品来源不存在。');
  const sample = await db.sample.findUnique({ where: { id: row.sampleId } });
  if (!sample || sample.id !== row.sampleId || sample.projectionKey != null || sample.sourceOrderId !== row.orderId
    || row.provenance === 'native_new' && sample.sourceCaseId != null) conflict('原样品对象与订单来源身份不符。');
  if (row.provenance === 'native_new') {
    const types: Record<string, string[]> = { fabric_ss: ['ship'], fabric_rc: ['head'], fabric_eps: ['head', 'pioneer'], garment_pp: ['pp'], garment_top: ['top'], garment_ship: ['ship'] };
    if (!types[row.family]?.includes(sample.type) || (await db.sampleSource.findMany({ where: { sampleId: row.sampleId }, select: { id: true }, take: 1 })).length)
      conflict('原生订单样品类型或开发来源归属不符。');
  }
  const rows = await db.orderSampleCoverage.findMany({ where: { sourceId }, orderBy: [{ orderLineId: 'asc' }, { rangeStart: 'asc' }, { id: 'asc' }], take: MAX_FACTS + 1 });
  if (!rows.length || rows.length > MAX_FACTS || new Set(rows.map(c => c.id)).size !== rows.length) conflict('完整代表范围缺失、重复或超出读取预算。');
  const coverage = rows.map(c => coverageFact(c, row));
  const source: OrderSampleSource = { domain: 'order', sourceId: row.id, sampleId: row.sampleId, family: row.family,
    owner: { orderId: row.orderId, businessLine: row.businessLine, factoryRelationId: row.factoryRelationId },
    chainId: row.chainId, round: row.round, previousSourceId: row.previousSourceId, provenance: row.provenance,
    specSnapshot: row.specSnapshot, sampleFacts: { quantity: decimal(row.sampleQuantity), unit: row.sampleUnit, cuttingDate: row.cuttingDate },
    coverage, contentFingerprint: row.contentFingerprint, coverageFingerprint: row.coverageFingerprint };
  assertOrderSampleSource(source);
  if (source.previousSourceId) {
    const previous = await db.orderSampleSource.findUnique({ where: { id: source.previousSourceId } });
    if (!previous || previous.chainId !== row.chainId || previous.round + 1 !== row.round || previous.orderId !== row.orderId
      || previous.businessLine !== row.businessLine || previous.family !== row.family || previous.factoryRelationId !== row.factoryRelationId
      || previous.id === row.id || previous.sampleId === row.sampleId) conflict('前轮来源不属于原链。');
    await loadRecord(db, source.previousSourceId, visited);
  }
  const eventRows = await db.orderSampleEvent.findMany({ where: { sourceId }, orderBy: { sequence: 'asc' }, take: MAX_FACTS + 1 });
  if (!eventRows.length || eventRows.length > MAX_FACTS) conflict('完整事件链缺失或超出读取预算。');
  // Embedded QC JSON is checked against the actual InspectionReport and its
  // original audit before it can participate in the reducer or replay receipt.
  for (const event of eventRows) {
    if (event.eventType !== 'qc_reviewed') {
      if (event.qcReportId != null || event.qcReportRevision != null || event.qcReportAuditId != null) conflict('非检验结果事件不能携带报告身份。');
      continue;
    }
    if (!db.inspectionReport || !db.auditLog.findUnique) conflict('实际检验报告读取能力缺失。');
    try {
      await loadOrderSampleQcEvidence({ inspectionReport: db.inspectionReport!, auditLog: { findUnique: args => db.auditLog.findUnique!(args) } }, source, event);
    } catch (error) {
      if (error instanceof DevelopmentDomainError) conflict(error.message);
      throw error;
    }
  }
  const auditIds = [identity(row.creationAuditId, '原来源审计'), ...eventRows.map(e => identity(e.auditId, '原事件审计'))];
  if (new Set(auditIds).size !== auditIds.length) conflict('原生审计身份重复。');
  const auditRows: any[] = [];
  for (let offset = 0; offset < auditIds.length; offset += 200) auditRows.push(...await db.auditLog.findMany({ where: { id: { in: auditIds.slice(offset, offset + 200) } } }));
  const audits = new Map(auditRows.map(a => [a.id, a]));
  if (audits.size !== auditIds.length || auditRows.length !== auditIds.length) conflict('必需原生审计缺失或重复。');
  const creation = audits.get(row.creationAuditId);
  if (!creation || creation.actorId !== row.createdBy || creation.action !== 'create_order_sample_source'
    || creation.targetType !== 'OrderSampleSource' || creation.targetId !== row.id || creation.transactionId !== eventRows[0].id
    || creation.detail?.protocol !== 'order_sample_native_v1' || creation.detail?.source !== 'route:samples:order-source:create'
    || auditTimestamp(creation.createdAt) !== timestamp(row.createdAt) || eventRows[0].actorId !== row.createdBy || timestamp(eventRows[0].recordedAt) !== timestamp(row.createdAt)) conflict('原来源创建审计身份不符。');
  same(creation.detail.after, { source, coverage }, '原来源创建审计');
  const acknowledgements: any[] = [];
  const events: OrderSampleEvent[] = eventRows.map(e => {
    const fact = eventFact(e, source), audit = audits.get(e.auditId);
    if (!audit || audit.actorId !== fact.actorId || audit.targetType !== 'OrderSampleEvent' || audit.targetId !== fact.id
      || audit.action !== `order_sample_${fact.eventType}` || audit.transactionId !== fact.id
      || audit.detail?.protocol !== 'order_sample_native_v1' || audit.detail?.source !== 'route:samples:order-source:event'
      || auditTimestamp(audit.createdAt) !== fact.recordedAt) conflict('原事件审计身份不符。');
    same(audit.detail.commandReceipt, { protocolVersion: e.protocolVersion, requestKey: e.requestKey, commandHash: e.commandHash,
      commandSnapshot: e.commandSnapshot, ackHash: e.ackHash, acknowledgement: e.acknowledgement }, '原审计命令回执');
    acknowledgements.push(verifyOrderSampleAcknowledgement(e, fact, source));
    return { ...fact, audit: { auditId: audit.id, protocol: audit.detail.protocol, source: audit.detail.source,
      operation: audit.action, actorId: audit.actorId, targetType: audit.targetType, targetId: audit.targetId, after: audit.detail.after } } as OrderSampleEvent;
  });
  const view = reduceOrderSampleEvents(source, events, { eventId: row.headEventId, sequence: row.headSequence });
  return { source, events, view, acknowledgements };
}
