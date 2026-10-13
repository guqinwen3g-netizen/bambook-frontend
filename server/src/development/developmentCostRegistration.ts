import { parseNonNegativeDecimal } from '../shared/moneyInput';
import { isValidLocalDateKey } from '../shared/localDate';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createCostRecordInTx, type CreateCostRecordInput } from '../finance/billingItemService';
import { DEVELOPMENT_SAMPLE_TYPES } from './developmentSampleScope';
import { assertDevelopmentExpenseAccess } from './developmentExpenseAccess';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { readFabricHistory } from './fabricBatchHistory';
import { readDevelopmentFactoryShippingSource, readDevelopmentFactoryShippingCostOccupancy, readDevelopmentFactoryCostCreationAuditId, type DevelopmentFactoryShippingSourceInput, type DevelopmentFactoryShippingSource } from './developmentFactoryShipmentCost';

type Context = { prisma: any; actorId: string; trustedActor?: TokenPayload; authorize: (tx: any, id: string) => Promise<unknown> };
type BatchShippingSourceInput = { kind: 'fabric-send-event' | 'legacy-send-audit' | 'garment-send-event'; id: string; round: number; fingerprint: string };
export type DevelopmentShippingSourceInput = BatchShippingSourceInput | DevelopmentFactoryShippingSourceInput;
type BatchShippingSource = BatchShippingSourceInput & {
  schemaVersion: 1; caseId: string; batchId: string; batchCode: string; supplierRelationId: string;
  nativeAuditId: string; sourceSnapshot: Record<string, unknown>;
};
export type DevelopmentShippingSource = BatchShippingSource | DevelopmentFactoryShippingSource;
const json = (value: unknown): any => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function fail(code: string, message: string, status = 400): never { throw Object.assign(new Error(message), { code, status, httpStatus: status, statusCode: status }); }
function reject(code: string, message: string): never { throw new DevelopmentDomainError(code, message); }
function required(value: unknown, label: string, max = 200) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('INVALID_INPUT', `${label}无效`); return value.trim(); }

async function currentSourceAccess(tx: any, ctx: Context, caseId: string, mode: 'read' | 'write') {
  if (!ctx.trustedActor?.userId || ctx.trustedActor.userId !== ctx.actorId) return reject('FORBIDDEN', '请使用当前登录身份核对寄样费用来源');
  const user = await tx.userAccount.findFirst({ where: { id: ctx.actorId, status: 'active', deletedAt: null }, select: { id: true } });
  const current = await createPermissionService({ prisma: tx }).getUserPermissionContext(ctx.actorId);
  if (!user || !current) return reject('FORBIDDEN', '当前账号不可处理寄样费用');
  const actor: TokenPayload = { ...ctx.trustedActor, roles: [], roleIds: current.roleIds, permissions: current.scopes,
    departmentIds: current.departmentIds, authorizationLoaded: true };
  if (!hasScope(actor, mode === 'read' ? 'products:read' : 'products:write')) reject('FORBIDDEN', '当前账号没有对应开发费用权限');
  await assertDevelopmentExpenseAccess(tx, actor, caseId, mode);
}

/** Source IDs are server-derived native facts. Old audits prove a send/round,
 * but lack shipping amount/currency: never manufacture those facts. */
async function shippingSources(tx: any, batch: any): Promise<BatchShippingSource[]> {
  const audits = await tx.auditLog.findMany({ where: { targetType: 'SampleBatch', targetId: batch.id,
    action: 'advance_sample_batch' }, orderBy: { id: 'asc' } });
  const result: BatchShippingSource[] = [];
  const base = { schemaVersion: 1 as const, caseId: batch.developmentCaseId, batchId: batch.id,
    batchCode: batch.batchCode, supplierRelationId: batch.supplierRelationId };
  const events = readFabricHistory(batch).events;
  const add = (kind: BatchShippingSourceInput['kind'], id: string, round: number, audit: any, sourceSnapshot: Record<string, unknown>) => {
    const fact = json({ ...base, kind, id, round, nativeAuditId: audit.id, sourceSnapshot });
    result.push({ ...fact, fingerprint: hash(fact) });
  };
  for (const event of events.filter(event => event.kind === 'send')) {
    const audit = audits.find((row: any) => row.id === event.auditId && row.actorId === event.actorId);
    const detail = audit?.detail;
    if (!audit || detail?.source !== 'route:dev:fabric-batch' || detail.after?.action !== 'send'
      || detail.after?.round !== event.round || detail.after?.batchCode !== batch.batchCode
      || event.before.status !== 'making' || event.after.status !== 'sent' || event.after.round !== event.round
      || detail.after?.roundFact?.kind !== 'send' || !same(detail.after.roundFact.before, event.before)
      || !same(detail.after.roundFact.after, event.after)) reject('DEVELOPMENT_SOURCE_CHANGED', '寄样轮次与原审计不一致，请核对原记录');
    add('fabric-send-event', event.id, event.round, audit, { actorId: event.actorId, at: event.at,
      before: event.before, after: event.after });
  }
  for (const audit of audits) {
    const detail = audit.detail as any;
    if (events.some(event => event.auditId === audit.id)) continue;
    if (detail?.source !== 'route:dev:fabric-batch' || detail.after?.action !== 'send'
      || detail.before?.status !== 'making' || detail.after?.status !== 'sent'
      || detail.before?.batchCode !== batch.batchCode || detail.after?.batchCode !== batch.batchCode
      || !Number.isSafeInteger(detail.after.round) || detail.after.round < 1 || detail.before.round !== detail.after.round) continue;
    // A modern roundFact without its append-only event is damaged history,
    // not a legacy source that may bypass the native event check.
    if (detail.after.roundFact) reject('DEVELOPMENT_SOURCE_CHANGED', '本轮寄样历史缺失，请核对原记录');
    add('legacy-send-audit', audit.id, detail.after.round, audit, { actorId: audit.actorId,
      before: detail.before, after: detail.after, historicalAmountCurrencyUnknown: true });
  }
  if (batch.sampleType === 'garment-round') {
    const garmentAudits = await tx.auditLog.findMany({ where: { targetType: 'DevelopmentCase', targetId: batch.developmentCaseId,
      action: 'submit_garment_sample_to_customer' }, orderBy: { id: 'asc' } });
    const shipmentHistory = Array.isArray(batch.attachments?.shipmentHistory) ? batch.attachments.shipmentHistory : [];
    for (const entry of shipmentHistory) {
      if (typeof entry?.requestKey !== 'string' || !entry.requestKey || typeof entry?.requestFingerprint !== 'string') continue;
      const audit = garmentAudits.find((row: any) => row.actorId === entry.shippedBy
        && row.detail?.after?.roundId === batch.id && row.detail?.after?.requestKey === entry.requestKey
        && row.detail?.after?.requestFingerprint === entry.requestFingerprint);
      if (!audit) reject('DEVELOPMENT_SOURCE_CHANGED', '成衣寄样费用缺少对应寄样审计依据，请核对原记录');
      add('garment-send-event', entry.requestKey, batch.round, audit, { shippedAt: entry.shippedAt, sentDate: entry.sentDate,
        courier: entry.courier, trackingNumber: entry.trackingNumber, shippingFee: entry.shippingFee ?? null,
        physicalShipment: entry.physicalShipment ?? null, actorId: entry.shippedBy, requestFingerprint: entry.requestFingerprint });
    }
  }
  return result;
}

export async function listDevelopmentShippingCostSources(ctx: Context, caseId: string, batchId: string) {
  required(caseId, '开发案'); required(batchId, '样品批次');
  return ctx.prisma.$transaction(async (tx: any) => {
    await currentSourceAccess(tx, ctx, caseId, 'read');
    const batch = await tx.sampleBatch.findFirst({ where: { id: batchId, developmentCaseId: caseId, deletedAt: null } });
    if (!batch) reject('NOT_FOUND', '样品批次不存在或不属于当前开发案');
    const sources = await shippingSources(tx, batch);
    const costs = await tx.costRecord.findMany({ where: { sourceType: 'SampleBatch', sourceId: batchId, costType: 'shipping', deletedAt: null }, select: { id: true, developmentShippingSource: true } });
    return sources.map(source => ({ ...source, costRecordIds: costs.filter((row: any) => row.developmentShippingSource?.source?.kind === source.kind
      && row.developmentShippingSource?.source?.id === source.id && row.developmentShippingSource?.source?.fingerprint === source.fingerprint).map((row: any) => row.id) }));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

async function receipt(tx: any, row: any, caseId: string, actorId: string, requestKey: string, requestFingerprint: string, inputSnapshot: Record<string, unknown>) {
  const action = row.developmentShippingSource ? 'register_development_shipping_cost' : 'register_development_cost';
  const logs = await tx.auditLog.findMany({ where: { targetType: 'CostRecord', targetId: row.id, actorId, action } });
  const exact = logs.filter((audit: any) => same(audit.detail?.after?.command, { actorId, requestKey, requestFingerprint, inputSnapshot })
    && audit.detail?.after?.caseId === caseId
    && audit.detail?.after?.amount === new Prisma.Decimal(String(row.amount)).toFixed(4)
    && audit.detail?.after?.currency === row.currency
    && same(audit.detail?.after?.shippingSource ?? null, row.developmentShippingSource?.source ?? null));
  if (exact.length !== 1) {
    if (!row.developmentShippingSource && logs.length === 0) return { ...row, commandAck: null }; // Older generic registrations remain readable; no invented historical ack.
    reject('DEVELOPMENT_SOURCE_CHANGED', '费用登记回执缺失或不一致，请核对原费用');
  }
  if (row.developmentShippingSource && row.developmentShippingSource.registrationAuditId !== exact[0].id) reject('DEVELOPMENT_SOURCE_CHANGED', '寄样费用审计引用不一致');
  return { ...row, commandAck: { caseId, actorId, requestKey, requestFingerprint, inputSnapshot, costRecordId: row.id, auditId: exact[0].id } };
}

/** Development expense facts use product access, never grant finance write access. */
export async function registerDevelopmentCost(context: Context, caseId: string, input: CreateCostRecordInput & { requestKey: string; shippingSource?: DevelopmentShippingSourceInput }) {
  required(caseId, '开发案'); required(context.actorId, '操作人');
  const requestKey = required(input.requestKey, '请求标识');
  const sourceType = required(input.sourceType, '来源类型'), sourceId = required(input.sourceId, '来源');
  const currency = required(input.currency, '币种');
  if (input.shippingSource?.kind === 'factory-physical-command') {
    if (!/^[A-Z]{3}$/.test(currency)) fail('INVALID_CURRENCY', '原寄厂费用币种无效');
  } else if (!['CNY', 'USD'].includes(currency)) fail('INVALID_CURRENCY', '仅支持人民币和美元');
  const incurredAt = required(input.incurredAt, '发生日期', 10);
  if (!isValidLocalDateKey(incurredAt)) fail('INVALID_DATE', '发生日期无效');
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 8000)) fail('INVALID_INPUT', '费用说明过长或无效');
  // Customer charging is decided separately, on the development billing draft.
  const data: CreateCostRecordInput = { sourceType, sourceId, costType: required(input.costType, '费用类型'), amount: input.amount,
    currency, incurredAt, bearerType: 'internal', notes: input.notes?.trim() || undefined };
  let selected: DevelopmentShippingSourceInput | undefined;
  if (input.shippingSource !== undefined) {
    const source = input.shippingSource;
    if (!source || typeof source.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(source.fingerprint) || data.costType !== 'shipping') reject('DEVELOPMENT_SHIPPING_SOURCE_INVALID', '请选择真实寄样事实作为邮寄费用来源');
    if (source.kind === 'factory-physical-command') {
      if (sourceType !== 'DevelopmentCase' || sourceId !== caseId || Object.keys(source).some(key => !['kind', 'id', 'fingerprint'].includes(key))) reject('DEVELOPMENT_SHIPPING_SOURCE_INVALID', '寄厂实物来源须为当前开发案的准确原回执');
      selected = { kind: source.kind, id: required(source.id, '寄厂原回执'), fingerprint: source.fingerprint };
    } else {
      if (!['fabric-send-event', 'legacy-send-audit', 'garment-send-event'].includes(source.kind) || !Number.isSafeInteger(source.round) || source.round < 1
        || sourceType !== 'SampleBatch') reject('DEVELOPMENT_SHIPPING_SOURCE_INVALID', '请选择真实寄样轮次作为邮寄费用来源');
      selected = { kind: source.kind, id: required(source.id, '寄样事实'), round: source.round, fingerprint: source.fingerprint };
    }
  }
  const amountRead = parseNonNegativeDecimal(input.amount, '费用金额');
  if (!amountRead.ok) fail('INVALID_AMOUNT', amountRead.message);
  const amount = new Prisma.Decimal(amountRead.value);
  if (amount.decimalPlaces() > 4 || amount.gte('100000000000000')) fail('INVALID_AMOUNT', '费用金额精度或范围无效');
  const registrationKey = createHash('sha256').update(JSON.stringify([caseId, context.actorId, requestKey])).digest('hex');
  // Preserve the original generic API's fingerprint; syntactic absence does not add a null field.
  const registrationFingerprint = selected ? hash({ data, shippingSource: selected }) : createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const { bearerType: _internal, ...accepted } = data;
  const inputSnapshot = json({ ...accepted, ...(selected ? { shippingSource: selected } : {}) });
  return context.prisma.$transaction(async (tx: any) => {
    await context.authorize(tx, caseId);
    const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!rows.length) fail('NOT_FOUND', '开发案不存在', 404);
    await context.authorize(tx, caseId);
    if (selected) await currentSourceAccess(tx, context, caseId, 'write');
    let source: DevelopmentShippingSource | null = null;
    let factoryOccupancy: string[] = [];
    if (selected?.kind === 'factory-physical-command') {
      source = await readDevelopmentFactoryShippingSource(tx, caseId, selected);
      const shipping = source.sourceSnapshot.shipping;
      if (!new Prisma.Decimal(shipping.shippingFee).gt(0) || !amount.eq(shipping.shippingFee)
        || currency !== shipping.shippingCurrency || incurredAt !== shipping.sentDate) reject('DEVELOPMENT_SHIPPING_SOURCE_INVALID', '费用金额、币种和发生日期须与原寄厂物流一致；额外实际费用请另行登记');
      factoryOccupancy = await readDevelopmentFactoryShippingCostOccupancy(tx, source);
    } else if (selected) {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id"=${sourceId} FOR UPDATE`);
      const batch = await tx.sampleBatch.findFirst({ where: { id: sourceId, developmentCaseId: caseId, deletedAt: null } });
      if (!batch) reject('DEVELOPMENT_SHIPPING_SOURCE_INVALID', '样品来源已变化，请核对原开发案');
      source = (await shippingSources(tx, batch)).find(item => same({ kind: item.kind, id: item.id, round: item.round, fingerprint: item.fingerprint }, selected)) ?? null;
      if (!source) reject('DEVELOPMENT_SOURCE_CHANGED', '寄样轮次或原审计已变化，请重新核对');
    }
    const previous = await tx.costRecord.findUnique({ where: { registrationKey } });
    if (previous) {
      if (previous.registrationFingerprint !== registrationFingerprint) fail('REQUEST_CONFLICT', '此请求已用于另一笔费用，请核对原登记结果', 409);
      return receipt(tx, previous, caseId, context.actorId, requestKey, registrationFingerprint, inputSnapshot);
    }
    // Historical successful commands remain reconcilable; these rules apply to new expense facts.
    if (amount.lte(0)) fail('INVALID_AMOUNT', '免费事项不登记支出；费用金额须大于零');
    if (data.costType === 'other' && !data.notes) fail('INVALID_INPUT', '额外费用须填写说明');
    if (source) {
      // The case/batch locks above serialize all actors, not only one request key.
      const factorySource = source.kind === 'factory-physical-command';
      const recorded = factorySource ? [] : await tx.costRecord.findMany({ where: { sourceType: 'SampleBatch', sourceId, costType: 'shipping', deletedAt: null } });
      const occupied = factoryOccupancy.length > 0 || recorded.some((row: any) => {
        const prior = row.developmentShippingSource?.source;
        return prior?.caseId === caseId && prior.kind === source.kind && prior.id === source.id
          && (source.kind === 'factory-physical-command' || (row.deletedAt == null && prior.batchId === sourceId && prior.round === source.round));
      });
      if (occupied) fail('COST_ALREADY_REGISTERED', '本次寄样邮寄费用已有登记，请核对原费用，不能重复登记', 409);
    }
    const valid = sourceType === 'DevelopmentCase' ? sourceId === caseId
      : sourceType === 'SampleBatch' ? await tx.sampleBatch.findFirst({ where: { id: sourceId, developmentCaseId: caseId, deletedAt: null } })
      : sourceType === 'Sample' ? await tx.sample.findFirst({ where: { id: sourceId, sourceCaseId: caseId, type: { in: DEVELOPMENT_SAMPLE_TYPES }, deletedAt: null } }) : null;
    if (!valid) fail('INVALID_SOURCE', '费用来源不属于当前开发案');
    const created = await createCostRecordInTx(tx, { actorId: context.actorId, input: data });
    const creationAuditId = source?.kind === 'factory-physical-command' ? await readDevelopmentFactoryCostCreationAuditId(tx, created, context.actorId) : undefined;
    const command = { actorId: context.actorId, requestKey, requestFingerprint: registrationFingerprint, inputSnapshot };
    const auditId = await writeRouteAuditLog({ prisma: tx, actorId: context.actorId, source: 'development-cost-registration',
      operation: selected ? 'register_development_shipping_cost' : 'register_development_cost', targetType: 'CostRecord', targetId: created.id,
      after: { caseId, costRecordId: created.id, amount: new Prisma.Decimal(String(created.amount)).toFixed(4), currency, shippingSource: source, command, ...(creationAuditId ? { creationAuditId } : {}) } });
    const registered = await tx.costRecord.update({ where: { id: created.id }, data: { registrationKey, registrationFingerprint,
      ...(source ? { developmentShippingSource: { schemaVersion: 1, source, registrationAuditId: auditId, command, ...(creationAuditId ? { creationAuditId } : {}) } } : {}) } });
    return receipt(tx, registered, caseId, context.actorId, requestKey, registrationFingerprint, inputSnapshot);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
