/** Packaging correction of one genuinely dispatched ticket. No line, source,
 * stock, status or financial producer is invoked by this command. */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { freshOrderLineScope, readOrderLineWriteErrorMint } from '../orders/orderLineWriteAccess';
import { readDevelopmentDomainErrorMint } from '../development/developmentOperationalGuard';
import { businessError, readBusinessErrorMint } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { exactJsonValue } from '../lib/exactJsonValue';
import { qcReportSourceFingerprint as hash } from '../qc/qcReportAuthority';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { assertPhysicalShipmentWriteAuthority } from './shipmentPhysicalAllocationService';
import { lockShipmentPhysicalConsumer } from './shipmentPhysicalConsumerService';
import { originalPhysicalShipmentDispatch, validatePhysicalPackingQuantities } from './shipmentPhysicalCommand';
import { shipmentDocumentSourceInTx } from './shipmentDocumentSource';
import { listShipmentLines, listShipmentCartons } from './shipmentPackingService';

const source = 'route:shipping:shipped-carton-metadata', action = 'save_shipped_carton_metadata';
const originalRefusal = (error: unknown) => readBusinessErrorMint(error)
  ?? readOrderLineWriteErrorMint(error) ?? readDevelopmentDomainErrorMint(error);
const unknownOutcome = () => new Error('包装资料结果暂时无法确认，请保留原请求重试。');
const json = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const fields = ['cartonNo', 'description', 'length', 'width', 'height', 'grossWeight', 'netWeight', 'volume', 'items'];
type Carton = { cartonNo: string; description?: string | null; length: string | null; width: string | null; height: string | null;
  grossWeight: string | null; netWeight: string | null; volume: string | null; items: Array<{ shipmentLineId: string; quantity: string }> };
type Input = { requestKey: string; expectedShipmentUpdatedAt: string; expectedPhysicalAllocationFingerprint: string;
  expectedSourceFingerprint: string; expectedDispatchHash: string; reason: string; cartons: Carton[] };
const object = (value: any, allowed: string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('包装资料命令含无法核验的字段。');
};
function decimal(value: any, integers: number, places: number, positive = false) {
  if (value === null && !positive) return;
  if (typeof value !== 'string' || !new RegExp(`^(?:0|[1-9]\\d{0,${integers - 1}})(?:\\.\\d{1,${places}})?$`).test(value)
    || positive && new Prisma.Decimal(value).lte(0)) invalid('包装资料须为精确十进制字符串；未知测量值请保留 null。');
}
function parse(value: unknown): Input {
  const row: any = value;
  object(row, ['requestKey', 'expectedShipmentUpdatedAt', 'expectedPhysicalAllocationFingerprint', 'expectedSourceFingerprint', 'expectedDispatchHash', 'reason', 'cartons']);
  if (typeof row.requestKey !== 'string' || !row.requestKey.trim() || row.requestKey.length > 200
    || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 2000) invalid('须保留原请求键并填写补录或校正说明。');
  if (typeof row.expectedShipmentUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(row.expectedShipmentUpdatedAt)
    || ['expectedPhysicalAllocationFingerprint', 'expectedSourceFingerprint', 'expectedDispatchHash'].some(key => typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/.test(row[key]))) invalid('须先核对原运单、实际来源和出库凭据版本。');
  if (!Array.isArray(row.cartons) || !row.cartons.length || row.cartons.length > 1000) invalid('须逐箱明确登记实际包装资料。');
  const numbers = new Set<string>();
  for (const carton of row.cartons) {
    object(carton, fields);
    if (typeof carton.cartonNo !== 'string' || !carton.cartonNo.trim() || carton.cartonNo.length > 200
      || /^\d+\s*(?:-|~|～|—|–|至)\s*\d+$/.test(carton.cartonNo.trim()) || numbers.has(carton.cartonNo.trim())) invalid('每条记录须对应明确的一箱，箱号不可重复或使用数量范围。');
    numbers.add(carton.cartonNo.trim());
    if (carton.description !== undefined && carton.description !== null && (typeof carton.description !== 'string' || carton.description.length > 2000)) invalid('箱内说明无效。');
    for (const key of ['length', 'width', 'height']) decimal(carton[key], 8, 2);
    for (const key of ['grossWeight', 'netWeight']) decimal(carton[key], 9, 3);
    decimal(carton.volume, 8, 4);
    if (!Array.isArray(carton.items) || !carton.items.length || carton.items.length > 500) invalid('每箱须明确关联原装运行和实际数量。');
    const used = new Set<string>();
    for (const item of carton.items) {
      object(item, ['shipmentLineId', 'quantity']);
      if (typeof item.shipmentLineId !== 'string' || !item.shipmentLineId || used.has(item.shipmentLineId)) invalid('箱内原装运行标识不可为空或重复。');
      used.add(item.shipmentLineId); decimal(item.quantity, 14, 4, true);
    }
  }
  return json(row);
}
async function visible(tx: any, actor: TokenPayload, ids: string[]) {
  const scope = await freshOrderLineScope(tx, actor);
  for (const id of ids) if (!await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] }, select: { id: true } }))
    throw businessError('NOT_FOUND', '运单不存在或不可查看。');
}
async function qualified(tx: any, id: string, prior: TokenPayload | null) {
  const context = await lockShipmentPhysicalConsumer(tx, { shipmentId: id, actor: prior, mode: 'edit' });
  if (context.kind !== 'physical' || context.shipment.status !== 'Shipped') throw businessError('CONFLICT', '仅有真实出库来源的已发运运单可补录或校正包装资料。');
  const actor = await assertPhysicalShipmentWriteAuthority(tx, prior, context.orderIds.length > 0); await visible(tx, actor, context.orderIds);
  const dispatch = await originalPhysicalShipmentDispatch(tx, context);
  const movements = await tx.stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: id }, orderBy: { id: 'asc' } });
  if (movements.length !== dispatch.stockMovements.length || movements.some((row: any) => row.type !== 'Outbound')
    || dispatch.stockMovements.some((row: any) => !row.movement || !movements.some((movement: any) => hash(json(movement)) === hash(row.movement)))) conflict('原出库流水集合与成功发运凭据不一致。');
  // Continue the original native lock order after sources, Order/Line, PB,
  // Shipment, SOA and SPA. This command never replaces those protected rows.
  const before = await shipmentDocumentSourceInTx(tx, id, { trustedActor: prior, extraScopes: ['shipments:write'] });
  for (const table of ['ShipmentLine', 'ShipmentCarton']) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw('"' + table + '"')} WHERE "shipmentId"=${id} ORDER BY "id" FOR UPDATE`);
  const itemIds = before.cartons.flatMap((carton: any) => carton.items.map((item: any) => item.id)).sort();
  if (itemIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentCartonItem" WHERE "id" IN (${Prisma.join(itemIds)}) ORDER BY "id" FOR UPDATE`);
  const facts = await shipmentDocumentSourceInTx(tx, id, { trustedActor: prior, extraScopes: ['shipments:write'] });
  if (before.fingerprint !== facts.fingerprint || facts.allocationFingerprint !== context.allocationFingerprint) conflict('原包装来源在取得锁时变化，请重新读取。');
  const lines = await listShipmentLines(tx, id); validatePhysicalPackingQuantities(context, lines, true);
  return { context, actor, dispatchHash: hash(dispatch), facts, lines };
}
async function finalAuthority(tx: any, prior: TokenPayload | null, q: Awaited<ReturnType<typeof qualified>>) {
  // Verify the immutable dispatch and current original line identity again.
  if (hash(await originalPhysicalShipmentDispatch(tx, q.context)) !== q.dispatchHash
    || hash(json(await listShipmentLines(tx, q.context.shipment.id))) !== hash(json(q.lines))) conflict('原装运行或出库凭据已变化。');
  const actor = await assertPhysicalShipmentWriteAuthority(tx, prior, q.context.orderIds.length > 0); await visible(tx, actor, q.context.orderIds);
}
export async function readShipmentCartonMetadata(prisma: PrismaClient, id: string, prior: TokenPayload | null) {
  return prisma.$transaction(async (tx: any) => {
    const q = await qualified(tx, id, prior), actual = new Map<string, Prisma.Decimal>();
    for (const row of q.context.allocations) if (row.status !== 'Cancelled' && row.orderLineId && row.actualQty != null)
      actual.set(row.orderLineId, (actual.get(row.orderLineId) ?? new Prisma.Decimal(0)).plus(row.actualQty));
    const sources = q.facts.orders.flatMap(order => order.lines.filter((line: any) => actual.get(line.id)?.gt(0)).map((line: any) => ({
      orderLineId: line.id, orderId: order.id, productCode: line.itemNo ?? line.materialCode ?? null,
      productName: line.description ?? line.millQuality ?? null, unit: q.context.allocations.find(row => row.orderLineId === line.id)?.unit,
      actualQty: actual.get(line.id)!.toString(),
    })));
    const cartons = await listShipmentCartons(tx, id);
    await finalAuthority(tx, prior, q);
    return json({ shipment: q.context.shipment, context: { kind: 'physical', updatedAt: String(q.context.shipment.updatedAt), allocationFingerprint: q.context.allocationFingerprint },
      metadata: { sourceFingerprint: q.facts.fingerprint, dispatchHash: q.dispatchHash }, lines: q.lines, cartons, sources });
  });
}
function coverage(input: Input, lines: any[]) {
  if (!lines.length || new Set(lines.map(line => line.id)).size !== lines.length) conflict('原装运行身份无法完整核验。');
  const totals = new Map<string, Prisma.Decimal>();
  for (const carton of input.cartons) for (const item of carton.items) {
    if (!lines.some(line => line.id === item.shipmentLineId)) conflict('箱内关联不属于本票原装运行。');
    totals.set(item.shipmentLineId, (totals.get(item.shipmentLineId) ?? new Prisma.Decimal(0)).plus(item.quantity));
  }
  for (const line of lines) if (line.quantity == null || !new Prisma.Decimal(line.quantity).equals(totals.get(line.id) ?? new Prisma.Decimal(0))) conflict('本次包装资料须完整对应全部原装运行数量。');
}
const cartonValue = (carton: Carton, key: string) => key === 'volume' && carton.volume === null && carton.length !== null && carton.width !== null && carton.height !== null
  ? new Prisma.Decimal(carton.length).mul(carton.width).mul(carton.height).div(1000000).toDecimalPlaces(4).toString() : (carton as any)[key] ?? null;
function verifiedResult(id: string, input: Input, result: any) {
  if (result?.shipment?.id !== id || result.shipment.status !== 'Shipped' || typeof result.shipment.updatedAt !== 'string'
    || !/^(?:0|[1-9]\d*)$/.test(result.shipment.updatedAt) || BigInt(result.shipment.updatedAt) <= BigInt(input.expectedShipmentUpdatedAt)
    || !Array.isArray(result.lines) || !Array.isArray(result.cartons) || result.cartons.length !== input.cartons.length
    || new Set(result.cartons.map((row: any) => row.id)).size !== input.cartons.length) conflict('原包装资料回执无法完整核验。');
  coverage(input, result.lines);
  input.cartons.forEach((carton, index) => {
    const stored = result.cartons[index];
    if (!stored?.id || stored.shipmentId !== id || stored.cartonNo !== carton.cartonNo.trim() || !Array.isArray(stored.items) || stored.items.length !== carton.items.length
      || new Set(stored.items.map((item: any) => item.id)).size !== carton.items.length) conflict('原箱或箱内保存凭据不完整。');
    for (const field of fields.filter(key => !['cartonNo', 'items'].includes(key))) {
      const wanted = cartonValue(carton, field), got = stored[field] ?? null;
      if (wanted === null ? got !== null : field === 'description' ? wanted !== got : got === null || !new Prisma.Decimal(wanted).equals(got)) conflict('原箱保存字段与请求不一致。');
    }
    for (const item of carton.items) {
      const storedItem = stored.items.find((row: any) => row.shipmentLineId === item.shipmentLineId);
      if (!storedItem?.id || storedItem.cartonId !== stored.id || !new Prisma.Decimal(storedItem.quantity).equals(item.quantity)) conflict('原箱内分配凭据与请求不一致。');
    }
  });
}
async function evidence(tx: any, id: string, key: string, transactionId: string): Promise<any[]> {
  const anchors = [['after', 'command'], ['after', 'acknowledgement', 'command'], ['after', 'rejection', 'command']];
  return tx.auditLog.findMany({ where: { OR: [{ transactionId: { in: ['', ':cartons', ':items', ':header'].map(suffix => transactionId + suffix) } },
    ...anchors.map(path => ({ AND: [{ detail: { path: [...path, 'shipmentId'], equals: id } }, { detail: { path: [...path, 'requestKey'], equals: key } }] })),
  ] } });
}
export async function saveShipmentCartonMetadata(params: { prisma: PrismaClient; shipmentId: string; actor: TokenPayload | null; input: unknown; ip?: string | null }) {
  const input = parse(params.input);
  const mainOutcome: { phase: 'not_entered' | 'running' | 'rejected' | 'returned'; failure: unknown } = { phase: 'not_entered', failure: undefined };
  try { return await params.prisma.$transaction(async (tx: any) => {
    mainOutcome.phase = 'running';
    try {
      const result = await (async () => {
    const id = params.shipmentId, q = await qualified(tx, id, params.actor);
    const command = { ...input, actorId: q.actor.userId, shipmentId: id }, commandHash = hash({ schemaVersion: 1, command });
    const transactionId = 'shipped_carton_metadata_' + hash({ shipmentId: id, actorId: q.actor.userId, requestKey: input.requestKey });
    const logs = await evidence(tx, id, input.requestKey, transactionId), mains = logs.filter(log => log.transactionId === transactionId);
    if (mains.length === 1 && mains[0].action === 'reject_shipped_carton_metadata') {
      const log = mains[0], rejection = log.detail?.after?.rejection;
      if (logs.length !== 1 || log.actorId !== q.actor.userId || log.targetType !== 'Shipment' || log.targetId !== id || log.detail?.source !== source
        || rejection?.schemaVersion !== 1 || rejection.outcome !== 'not_committed' || rejection.commandHash !== commandHash
        || hash(rejection.command) !== hash(command) || log.detail.after.rejectionHash !== hash(rejection)) conflict('原包装资料请求键已有无法核验的拒绝历史。');
      await finalAuthority(tx, params.actor, q); return { rejection };
    }
    if (logs.length) {
      const log = mains[0], saved = log?.detail?.after, ack = saved?.acknowledgement;
      if (logs.length !== 4 || mains.length !== 1 || log.action !== action || log.actorId !== q.actor.userId || log.targetType !== 'Shipment' || log.targetId !== id
        || log.detail?.source !== source || saved?.commandHash !== commandHash || hash(saved?.command) !== hash(command)
        || ack?.schemaVersion !== 1 || ack.commandHash !== commandHash || hash(ack.command) !== hash(command) || !saved.result || ack.resultHash !== hash(saved.result)) conflict('原包装资料请求已有未核清的保存凭据，请保留原请求。');
      verifiedResult(id, input, saved.result);
      if (hash(saved.result.lines) !== hash(json(q.lines))) conflict('原装运行身份与历史保存凭据不一致。');
      for (const [suffix, operation, value] of [
        ['cartons', 'SHIPPED_CARTON_METADATA_CARTONS', saved.result.cartons.map(({ items, ...carton }: any) => carton)],
        ['items', 'SHIPPED_CARTON_METADATA_ITEMS', saved.result.cartons.flatMap((carton: any) => carton.items)],
        ['header', 'SHIPPED_CARTON_METADATA_HEADER', { shipment: saved.result.shipment, headerSources: saved.result.headerSources }],
      ] as const) {
        const row = logs.filter(log => log.transactionId === transactionId + ':' + suffix);
        if (row.length !== 1 || row[0].actorId !== q.actor.userId || row[0].targetType !== 'Shipment' || row[0].targetId !== id || row[0].action !== operation
          || row[0].detail?.source !== source || row[0].detail?.after?.commandHash !== commandHash || row[0].detail?.after?.factsHash !== hash(value) || hash(row[0].detail?.after?.facts) !== hash(value)) conflict('原包装资料缺少完整的箱、箱内分配或汇总审计。');
      }
      if (String(q.context.shipment.updatedAt) === saved.result.shipment.updatedAt && (hash(json(q.context.shipment)) !== hash(saved.result.shipment)
        || hash(json(await listShipmentCartons(tx, id))) !== hash(saved.result.cartons))) conflict('当前包装资料与原成功凭据不一致。');
      await finalAuthority(tx, params.actor, q);
      return { ...saved.result, acknowledgement: ack, replayed: true };
    }
    if (String(q.context.shipment.updatedAt) !== input.expectedShipmentUpdatedAt || q.context.allocationFingerprint !== input.expectedPhysicalAllocationFingerprint
      || q.facts.fingerprint !== input.expectedSourceFingerprint || q.dispatchHash !== input.expectedDispatchHash) conflict('原票、包装或真实发运来源已变化，请重新核对。');
    coverage(input, q.lines);
    const before = json({ shipment: q.context.shipment, lines: q.lines, cartons: await listShipmentCartons(tx, id) });
    await tx.shipmentCarton.deleteMany({ where: { shipmentId: id } });
    const ts = BigInt(Date.now()), cartons: any[] = [];
    for (const row of input.cartons) {
      const data = Object.fromEntries(fields.filter(key => key !== 'items').map(key => [key, key === 'cartonNo' ? row.cartonNo.trim() : cartonValue(row, key)]));
      const carton = await tx.shipmentCarton.create({ data: { ...data, id: 'SHPC__' + randomUUID(), shipmentId: id, createdAt: ts, updatedAt: ts } });
      const items: any[] = [];
      for (const item of row.items) items.push(await tx.shipmentCartonItem.create({ data: { ...item, id: 'SHPCI__' + randomUUID(), cartonId: carton.id, createdAt: ts, updatedAt: ts } }));
      cartons.push({ ...carton, items });
    }
    const header: any = { totalPackages: cartons.length }, headerSources: any = { totalPackages: 'cartons' };
    for (const key of ['grossWeight', 'netWeight', 'volume']) {
      const known = cartons.every(carton => carton[key] !== null);
      headerSources[key] = known ? 'cartons' : 'existing_shipment';
      header[key] = known ? cartons.reduce((sum, carton) => sum.plus(carton[key]), new Prisma.Decimal(0)) : q.context.shipment[key];
      // Shipment aggregates have three decimal places; an unrepresentable exact
      // box sum cannot silently round into a contradictory document source.
      if (header[key] != null && (new Prisma.Decimal(header[key]).decimalPlaces() > 3 || new Prisma.Decimal(header[key]).gte('1000000000'))) invalid('箱级汇总超出原运单精度，请核对真实测量值。');
    }
    const next = BigInt(q.context.shipment.updatedAt) + BigInt(1);
    const shipment = await tx.shipment.update({ where: { id }, data: { ...header, updatedAt: ts > next ? ts : next } });
    const result = json({ shipment, lines: q.lines, cartons, headerSources }); verifiedResult(id, input, result);
    for (const [suffix, operation, facts] of [
      ['cartons', 'SHIPPED_CARTON_METADATA_CARTONS', result.cartons.map(({ items, ...carton }: any) => carton)],
      ['items', 'SHIPPED_CARTON_METADATA_ITEMS', result.cartons.flatMap((carton: any) => carton.items)],
      ['header', 'SHIPPED_CARTON_METADATA_HEADER', { shipment: result.shipment, headerSources }],
    ] as const) await writeRouteAuditLog({ prisma: tx, actorId: q.actor.userId, source, operation, targetType: 'Shipment', targetId: id,
      transactionId: transactionId + ':' + suffix, before, after: { commandHash, factsHash: hash(facts), facts, reason: input.reason }, ip: params.ip ?? null });
    await finalAuthority(tx, params.actor, q);
    const acknowledgement = { schemaVersion: 1, command, commandHash, resultHash: hash(result) };
    await writeRouteAuditLog({ prisma: tx, actorId: q.actor.userId, source, operation: action, targetType: 'Shipment', targetId: id,
      transactionId, before, after: { command, commandHash, result, acknowledgement }, ip: params.ip ?? null });
    await finalAuthority(tx, params.actor, q);
    return { ...result, acknowledgement, replayed: false };
      })();
      mainOutcome.phase = 'returned'; return result;
    } catch (error) { mainOutcome.phase = 'rejected'; mainOutcome.failure = error; throw error; }
  }); } catch (error) {
    // A factory mint says who made a refusal, not whether the transaction
    // completed. Only the exact error thrown by this callback can be certified.
    if (mainOutcome.phase !== 'rejected' || mainOutcome.failure !== error) throw unknownOutcome();
    const refusal = originalRefusal(error);
    // Certify only a business refusal after rollback while the same native
    // identity/source/key lock is held again. Storage/auth/audit faults stay unknown.
    if (!refusal || !['CONFLICT', 'INVALID_INPUT'].includes(refusal.code)) throw error;
    try {
      const rejection = await params.prisma.$transaction(async (tx: any) => {
        const q = await qualified(tx, params.shipmentId, params.actor);
        const command = { ...input, actorId: q.actor.userId, shipmentId: params.shipmentId }, commandHash = hash({ schemaVersion: 1, command });
        const transactionId = 'shipped_carton_metadata_' + hash({ shipmentId: params.shipmentId, actorId: q.actor.userId, requestKey: input.requestKey });
        if ((await evidence(tx, params.shipmentId, input.requestKey, transactionId)).length) throw error;
        const rejection = { schemaVersion: 1, outcome: 'not_committed', command, commandHash, code: refusal.code, message: refusal.message,
          shipmentVersion: String(q.context.shipment.updatedAt), sourceFingerprint: q.facts.fingerprint };
        await writeRouteAuditLog({ prisma: tx, actorId: q.actor.userId, source, operation: 'reject_shipped_carton_metadata', targetType: 'Shipment', targetId: params.shipmentId,
          transactionId, after: { rejection, rejectionHash: hash(rejection) }, ip: params.ip ?? null });
        await finalAuthority(tx, params.actor, q); return rejection;
      });
      return { rejection };
    } catch (verificationError) {
      if (verificationError === error) throw error;
      if (originalRefusal(verificationError)) throw verificationError;
      throw unknownOutcome();
    }
  }
}
export function shipmentCartonMetadataError(error: unknown) {
  const refusal = originalRefusal(error);
  if (refusal) return { status: refusal.statusCode, code: refusal.code, message: refusal.message };
  return safeRouteError(null, { fallbackCode: 'SAVE_FAILED', fallbackMessage: '包装资料结果暂时无法确认，请保留原请求重试。' });
}
