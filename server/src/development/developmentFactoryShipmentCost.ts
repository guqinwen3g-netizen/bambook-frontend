import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createCostRecordInTx } from '../finance/billingItemService';
import { isValidLocalDateKey } from '../shared/localDate';
import { DevelopmentDomainError } from './developmentOperationalGuard';

export type DevelopmentFactoryShippingSourceInput = { kind: 'factory-physical-command'; id: string; fingerprint: string };
export type DevelopmentFactoryShippingSource = DevelopmentFactoryShippingSourceInput & {
  schemaVersion: 1; caseId: string; nativeAuditId: string; sourceSnapshot: Record<string, any>;
};
export type DevelopmentFactoryShippingCost = {
  status: 'registered' | 'free'; amount: string; currency: string; incurredAt: string;
  sourceFingerprint: string; costRecordId?: string; recordNo?: string;
};
type Context = { actorId: string; trustedActor?: TokenPayload; ip?: string | null };
const PHYSICAL_SOURCE = 'development:physical-sample';
const BINDING_SOURCE = 'development:factory-shipping-cost';
const BINDING_ACTION = 'development_factory_shipping_cost_bind';
const REGISTRATION_ACTION = 'register_development_shipping_cost';
const safe = (v: unknown): any => JSON.parse(JSON.stringify(v, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().filter(key => v[key] !== undefined).map(key => [key, canonical(v[key])])) : v;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(safe(v)))).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function changed(): never { throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '原寄厂物流费用或绑定审计不一致，请核对原记录'); }
export async function readDevelopmentFactoryCostCreationAuditId(tx: any, cost: any, actorId: string, expectedId?: string): Promise<string> {
  const logs = await tx.auditLog.findMany({ where: { targetType: 'CostRecord', targetId: cost.id, action: 'create_cost_record' } });
  const after = { recordNo: cost.recordNo, sourceType: cost.sourceType, sourceId: cost.sourceId,
    costType: cost.costType, amount: new Prisma.Decimal(String(cost.amount)).toString(), currency: cost.currency };
  if (logs.length !== 1 || typeof logs[0].id !== 'string' || !logs[0].id || (expectedId !== undefined && logs[0].id !== expectedId)
    || logs[0].actorId !== actorId || logs[0].detail?.source !== 'route:billing' || !same(logs[0].detail?.after, after)) changed();
  return logs[0].id;
}
function snapshot(caseId: string, result: any, actorId: string, requestKey: string, fingerprint: string) {
  return safe({ caseId, actorId, requestKey, commandFingerprint: fingerprint, itemId: result.itemId,
    itemCode: result.itemCode, task: result.task, physical: result.physical, stock: result.stock, shipping: result.shipping });
}
function sourceFor(caseId: string, result: any, auditId: string): DevelopmentFactoryShippingSource {
  const command = result.command;
  if (command?.kind !== 'factory' || !command.actorId || !command.requestKey || !/^[a-f0-9]{64}$/.test(command.fingerprint ?? '')
    || result.caseId !== caseId || !result.itemId || !result.task?.sampleVersionId || !result.task.factoryId
    || !result.stock?.eventId || !result.shipping || typeof result.shipping.shippingFee !== 'string'
    || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(result.shipping.shippingFee)
    || !/^[A-Z]{3}$/.test(result.shipping.shippingCurrency ?? '') || !isValidLocalDateKey(result.shipping.sentDate)) changed();
  const sourceSnapshot = snapshot(caseId, result, command.actorId, command.requestKey, command.fingerprint);
  return { schemaVersion: 1, kind: 'factory-physical-command', id: auditId, caseId, nativeAuditId: auditId,
    fingerprint: hash(sourceSnapshot), sourceSnapshot };
}

/** The stock write, cost truth, command receipt and source binding share the caller's transaction. */
export async function createDevelopmentFactoryShipmentCost(tx: any, ctx: Context, caseId: string, requestKey: string, fingerprint: string, result: any): Promise<DevelopmentFactoryShippingCost> {
  const shipping = result.shipping;
  const fact: DevelopmentFactoryShippingCost = { status: 'free', amount: shipping.shippingFee,
    currency: shipping.shippingCurrency, incurredAt: shipping.sentDate,
    sourceFingerprint: hash(snapshot(caseId, result, ctx.actorId, requestKey, fingerprint)) };
  if (new Prisma.Decimal(fact.amount).isZero()) return fact;
  const cost = await createCostRecordInTx(tx, { actorId: ctx.actorId, trustedActor: ctx.trustedActor, ip: ctx.ip,
    input: { sourceType: 'DevelopmentCase', sourceId: caseId, costType: 'shipping', amount: fact.amount,
      currency: fact.currency, incurredAt: fact.incurredAt, bearerType: 'internal',
      notes: `寄厂实物：${result.itemCode || result.itemId}；${shipping.courier} ${shipping.trackingNumber}` } });
  if (!cost.id || !cost.recordNo || !new Prisma.Decimal(String(cost.amount)).eq(fact.amount)
    || cost.sourceType !== 'DevelopmentCase' || cost.sourceId !== caseId || cost.costType !== 'shipping'
    || cost.currency !== fact.currency || cost.incurredAt !== fact.incurredAt || cost.bearerType !== 'internal') changed();
  return { ...fact, status: 'registered', costRecordId: cost.id, recordNo: cost.recordNo };
}

export async function bindDevelopmentFactoryShipmentCost(tx: any, ctx: Context, caseId: string, receipt: any) {
  const fact: DevelopmentFactoryShippingCost = receipt.shippingCost;
  const source = sourceFor(caseId, receipt, receipt.auditId);
  if (source.fingerprint !== fact.sourceFingerprint) changed();
  if (fact.status === 'free') return;
  const cost = await tx.costRecord.findFirst({ where: { id: fact.costRecordId } });
  if (!cost) changed();
  const creationAuditId = await readDevelopmentFactoryCostCreationAuditId(tx, cost, ctx.actorId);
  const after = { caseId, physicalAuditId: receipt.auditId, costRecordId: fact.costRecordId,
    amount: fact.amount, currency: fact.currency, incurredAt: fact.incurredAt, bearerType: 'internal', shippingSource: source, creationAuditId };
  const bindingAuditId = await writeRouteAuditLog({ prisma: tx, actorId: ctx.actorId, source: BINDING_SOURCE,
    operation: BINDING_ACTION, targetType: 'CostRecord', targetId: fact.costRecordId!, operationType: 'link', ip: ctx.ip, after });
  await tx.costRecord.update({ where: { id: fact.costRecordId }, data: { developmentShippingSource: { schemaVersion: 1, source, bindingAuditId, creationAuditId } } });
}

/** Old receipts have no shippingCost. They retain that limitation and never trigger a repair write. */
export async function verifyDevelopmentFactoryShipmentCost(tx: any, caseId: string, result: any, auditId: string): Promise<DevelopmentFactoryShippingSource> {
  const source = sourceFor(caseId, result, auditId);
  if (result.shippingCost === undefined) return source;
  const fact = result.shippingCost, shipping = source.sourceSnapshot.shipping;
  if (!fact || !['registered', 'free'].includes(fact.status) || fact.sourceFingerprint !== source.fingerprint
    || fact.amount !== shipping.shippingFee || fact.currency !== shipping.shippingCurrency || fact.incurredAt !== shipping.sentDate) changed();
  if (fact.status === 'free') {
    if (!new Prisma.Decimal(fact.amount).isZero() || fact.costRecordId !== undefined || fact.recordNo !== undefined) changed();
    const costs = await tx.costRecord.findMany({ where: { sourceType: 'DevelopmentCase', sourceId: caseId, costType: 'shipping' } });
    if (costs.some((row: any) => row.developmentShippingSource?.source?.kind === source.kind && row.developmentShippingSource.source.id === auditId)) changed();
    return source;
  }
  if (!new Prisma.Decimal(fact.amount).gt(0) || typeof fact.costRecordId !== 'string' || !fact.costRecordId || typeof fact.recordNo !== 'string' || !fact.recordNo) changed();
  const cost = await tx.costRecord.findFirst({ where: { id: fact.costRecordId, deletedAt: null } });
  try {
    if (!cost || cost.deletedAt != null || cost.recordNo !== fact.recordNo || cost.sourceType !== 'DevelopmentCase' || cost.sourceId !== caseId
      || cost.costType !== 'shipping' || cost.bearerType !== 'internal' || cost.bearerRelationId != null
      || !new Prisma.Decimal(String(cost.amount)).eq(fact.amount) || cost.currency !== fact.currency || cost.incurredAt !== fact.incurredAt
      || cost.developmentShippingSource?.schemaVersion !== 1 || !same(cost.developmentShippingSource.source, source)
      || typeof cost.developmentShippingSource.bindingAuditId !== 'string' || typeof cost.developmentShippingSource.creationAuditId !== 'string') changed();
  } catch { changed(); }
  await readDevelopmentFactoryCostCreationAuditId(tx, cost, result.command.actorId, cost.developmentShippingSource.creationAuditId);
  const logs = await tx.auditLog.findMany({ where: { id: cost.developmentShippingSource.bindingAuditId,
    targetType: 'CostRecord', targetId: cost.id, actorId: result.command.actorId, action: BINDING_ACTION } });
  const after = { caseId, physicalAuditId: auditId, costRecordId: cost.id, amount: fact.amount,
    currency: fact.currency, incurredAt: fact.incurredAt, bearerType: 'internal', shippingSource: source, creationAuditId: cost.developmentShippingSource.creationAuditId };
  if (logs.length !== 1 || logs[0].detail?.source !== BINDING_SOURCE || !same(logs[0].detail?.after, after)) changed();
  const costs = await tx.costRecord.findMany({ where: { sourceType: 'DevelopmentCase', sourceId: caseId, costType: 'shipping' } });
  if (costs.filter((row: any) => row.developmentShippingSource?.source?.kind === source.kind && row.developmentShippingSource.source.id === auditId).length !== 1) changed();
  return source;
}

/** Audit identity survives mutable cost source metadata, soft deletion and source moves.
 * Read the original audits first, then the exact target IDs without an active/source filter. */
export async function readDevelopmentFactoryShippingCostOccupancy(tx: any, source: DevelopmentFactoryShippingSource): Promise<string[]> {
  const audits = await tx.auditLog.findMany({ where: { targetType: 'CostRecord', action: { in: [REGISTRATION_ACTION, BINDING_ACTION] },
    detail: { path: ['after', 'caseId'], equals: source.caseId } } });
  const selected = audits.filter((row: any) => {
    const after = row.detail?.after, prior = after?.shippingSource;
    return after?.physicalAuditId === source.id || (prior?.kind === source.kind && prior.id === source.id)
      || prior?.nativeAuditId === source.id || prior?.fingerprint === source.fingerprint;
  });
  const occupied = new Set<string>();
  for (const audit of selected) {
    const after = audit.detail?.after;
    if (typeof audit.id !== 'string' || !audit.id || typeof audit.actorId !== 'string' || !audit.actorId
      || typeof audit.targetId !== 'string' || !audit.targetId || after?.caseId !== source.caseId || after.costRecordId !== audit.targetId
      || !same(after.shippingSource, source) || occupied.has(audit.targetId)) changed();
    const cost = await tx.costRecord.findFirst({ where: { id: audit.targetId } });
    try {
      const shipping = source.sourceSnapshot.shipping;
      if (!cost || cost.id !== audit.targetId || cost.deletedAt != null || cost.sourceType !== 'DevelopmentCase' || cost.sourceId !== source.caseId || cost.costType !== 'shipping'
        || cost.bearerType !== 'internal' || cost.bearerRelationId != null || !new Prisma.Decimal(String(cost.amount)).eq(shipping.shippingFee)
        || cost.currency !== shipping.shippingCurrency || cost.incurredAt !== shipping.sentDate || !cost.recordNo
        || cost.developmentShippingSource?.schemaVersion !== 1 || !same(cost.developmentShippingSource.source, source)
        || typeof cost.developmentShippingSource.creationAuditId !== 'string' || after.creationAuditId !== cost.developmentShippingSource.creationAuditId) changed();
      if (audit.action === BINDING_ACTION) {
        const expected = { caseId: source.caseId, physicalAuditId: source.id, costRecordId: cost.id,
          amount: shipping.shippingFee, currency: shipping.shippingCurrency, incurredAt: shipping.sentDate, bearerType: 'internal', shippingSource: source, creationAuditId: after.creationAuditId };
        if (audit.detail?.source !== BINDING_SOURCE || cost.developmentShippingSource.bindingAuditId !== audit.id || !same(after, expected)) changed();
      } else {
        const command = after.command, input = command?.inputSnapshot;
        const selection = { kind: source.kind, id: source.id, fingerprint: source.fingerprint };
        if (audit.action !== REGISTRATION_ACTION || audit.detail?.source !== 'development-cost-registration'
          || cost.developmentShippingSource.registrationAuditId !== audit.id || !same(cost.developmentShippingSource.command, command)
          || command?.actorId !== audit.actorId || typeof command.requestKey !== 'string' || !command.requestKey
          || !/^[a-f0-9]{64}$/.test(command.requestFingerprint ?? '') || !same(input?.shippingSource, selection)
          || input.sourceType !== 'DevelopmentCase' || input.sourceId !== source.caseId || input.costType !== 'shipping'
          || !new Prisma.Decimal(String(input.amount)).eq(shipping.shippingFee) || input.currency !== shipping.shippingCurrency || input.incurredAt !== shipping.sentDate
          || after.amount !== new Prisma.Decimal(String(cost.amount)).toFixed(4) || after.currency !== cost.currency
          || cost.registrationKey !== hash([source.caseId, audit.actorId, command.requestKey]) || cost.registrationFingerprint !== command.requestFingerprint) changed();
        const { shippingSource: _selection, ...data } = input;
        if (command.requestFingerprint !== hash({ data: { ...data, bearerType: 'internal' }, shippingSource: selection })) changed();
      }
    } catch { changed(); }
    await readDevelopmentFactoryCostCreationAuditId(tx, cost, audit.actorId, after.creationAuditId);
    occupied.add(cost.id);
  }
  // An unmatched mutable pointer is damaged evidence, never proof that the original audit is absent.
  const costs = await tx.costRecord.findMany({ where: { sourceType: 'DevelopmentCase', sourceId: source.caseId } });
  for (const cost of costs) {
    const prior = cost.developmentShippingSource?.source;
    if (((prior?.kind === source.kind && prior.id === source.id) || prior?.nativeAuditId === source.id || prior?.fingerprint === source.fingerprint) && !occupied.has(cost.id)) changed();
  }
  if (occupied.size > 1) changed();
  return [...occupied];
}

/** Called under the current case lock and expense authority; source identity is the native audit, never the tracking number. */
export async function readDevelopmentFactoryShippingSource(tx: any, caseId: string, selected: DevelopmentFactoryShippingSourceInput) {
  const logs = await tx.auditLog.findMany({ where: { id: selected.id, targetType: 'DevelopmentCase', targetId: caseId,
    action: 'development_reference_sample_ship' } });
  if (logs.length !== 1) changed();
  const row = logs[0], fact = row.detail?.after;
  if (row.detail?.source !== PHYSICAL_SOURCE || fact?.kind !== 'factory' || fact.caseId !== caseId || fact.actorId !== row.actorId
    || fact.result?.command?.actorId !== row.actorId || fact.result?.command?.requestKey !== fact.requestKey
    || fact.result?.command?.fingerprint !== fact.fingerprint || fact.resultHash !== hash(fact.result)) changed();
  const source = await verifyDevelopmentFactoryShipmentCost(tx, caseId, fact.result, row.id);
  if (source.fingerprint !== selected.fingerprint) changed();
  return source;
}
