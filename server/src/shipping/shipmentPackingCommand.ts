import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { exactJsonValue } from '../lib/exactJsonValue';
import { qcReportSourceFingerprint as hash } from '../qc/qcReportAuthority';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { lockClaimShipmentSource } from '../claims/claimShipmentFact';
import { assertPhysicalShipmentWriteAuthority } from './shipmentPhysicalAllocationService';
import { lockShipmentPhysicalConsumer, physicalShipmentAllocationFingerprint } from './shipmentPhysicalConsumerService';
import { replaceShipmentLinesTx, replaceShipmentCartonsTx, listShipmentLines, listShipmentCartons,
  type ShipmentLineInput, type ShipmentCartonInput } from './shipmentPackingService';

const action = 'replace_shipment_packing', source = 'route:shipping:packing-aggregate';
const json = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
export type PackingLineCommand = Omit<ShipmentLineInput, 'quantity' | 'grossWeight' | 'netWeight' | 'volume'> & { clientLineKey: string; quantity: string | null; grossWeight: string | null; netWeight: string | null; volume: string | null };
export type PackingCartonCommand = Omit<ShipmentCartonInput, 'items' | 'length' | 'width' | 'height' | 'grossWeight' | 'netWeight' | 'volume'> & { length: string | null; width: string | null; height: string | null; grossWeight: string | null; netWeight: string | null; volume: string | null; items: Array<{ lineKey: string; quantity: string }> };
export type PackingCommand = { requestKey: string; expectedShipmentUpdatedAt: string; expectedPhysicalAllocationFingerprint: string;
  lines: PackingLineCommand[]; cartons: PackingCartonCommand[] };
const lineFields = ['clientLineKey', 'orderLineId', 'productCode', 'productName', 'colorCode', 'quantity', 'unit', 'cartons', 'grossWeight', 'netWeight', 'volume', 'hsCode', 'countryOfOrigin'];
const cartonFields = ['cartonNo', 'description', 'length', 'width', 'height', 'grossWeight', 'netWeight', 'volume', 'items'];
function object(value: unknown, fields: string[]): any {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
    return invalid('装箱命令含无法核验的字段。');
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return invalid(`${label}须明确填写。`);
  return value;
}
function decimal(value: unknown, label: string, integers = 14, places = 4, positive = false): void {
  if (value === null && !positive) return;
  if (typeof value !== 'string' || !new RegExp(`^(?:0|[1-9]\\d{0,${integers - 1}})(?:\\.\\d{1,${places}})?$`).test(value)
    || positive && new Prisma.Decimal(value).lte(0)) invalid(`${label}须为精确的${positive ? '正' : '非负'}十进制字符串；未知请提交 null。`);
}
export function parsePackingCommand(value: unknown): PackingCommand {
  const row = object(value, ['requestKey', 'expectedShipmentUpdatedAt', 'expectedPhysicalAllocationFingerprint', 'lines', 'cartons']);
  text(row.requestKey, '原请求键');
  if (typeof row.expectedShipmentUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(row.expectedShipmentUpdatedAt)
    || typeof row.expectedPhysicalAllocationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedPhysicalAllocationFingerprint))
    invalid('须读取原运单与实际分配版本后保存装箱。');
  if (!Array.isArray(row.lines) || !Array.isArray(row.cartons) || row.lines.length > 500 || row.cartons.length > 1000) invalid('装箱行或箱集合无效。');
  const keys = new Set<string>();
  for (const line of row.lines) {
    object(line, lineFields); text(line.clientLineKey, '命令内行关联');
    if (keys.has(line.clientLineKey)) invalid('命令内行关联不能重复。'); keys.add(line.clientLineKey);
    for (const key of lineFields.filter(key => !['quantity', 'cartons', 'grossWeight', 'netWeight', 'volume', 'clientLineKey'].includes(key)))
      if (line[key] !== undefined && line[key] !== null && (typeof line[key] !== 'string' || line[key].length > 2000)) invalid('装箱行文字或来源无效。');
    if (!line.productCode?.trim() && !line.productName?.trim()) invalid('每条装箱行须填写货号或品名。');
    decimal(line.quantity, '行数量'); decimal(line.grossWeight, '行毛重', 9, 3); decimal(line.netWeight, '行净重', 9, 3); decimal(line.volume, '行体积', 9, 3);
    if (line.cartons !== null && (!Number.isSafeInteger(line.cartons) || line.cartons < 0)) invalid('行箱数须为非负整数或 null。');
  }
  const totals = new Map<string, Prisma.Decimal>();
  for (const carton of row.cartons) {
    object(carton, cartonFields); text(carton.cartonNo, '箱号');
    if (carton.description !== null && carton.description !== undefined && (typeof carton.description !== 'string' || carton.description.length > 2000)) invalid('箱说明无效。');
    for (const key of ['length', 'width', 'height']) decimal(carton[key], '箱尺寸', 8, 2);
    for (const key of ['grossWeight', 'netWeight']) decimal(carton[key], '箱重量', 9, 3);
    decimal(carton.volume, '箱体积', 8, 4);
    if (!Array.isArray(carton.items) || carton.items.length > 500) invalid('箱内关联集合无效。');
    const used = new Set<string>();
    for (const item of carton.items) {
      object(item, ['lineKey', 'quantity']);
      if (!keys.has(item.lineKey) || used.has(item.lineKey)) invalid('箱内须明确关联本次装箱行，同箱不能重复关联同一行。');
      used.add(item.lineKey); decimal(item.quantity, '箱内数量', 14, 4, true);
      totals.set(item.lineKey, (totals.get(item.lineKey) ?? new Prisma.Decimal(0)).plus(item.quantity));
    }
  }
  for (const line of row.lines) if (line.quantity !== null && totals.get(line.clientLineKey)?.gt(line.quantity)) invalid('箱内累计数量超过该行数量。');
  return json(row);
}
async function currentReader(tx: any, prior: TokenPayload | null, requireOrderRead = true): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请使用当前账号读取装箱明细。');
  let actor: TokenPayload;
  try {
    const user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    actor = await buildLoadedAuthTokenPayload(tx, user);
  } catch (error) { if (isBusinessError(error)) throw error; throw businessError('AUTHORIZATION_UNAVAILABLE', '当前装箱读取权限暂时无法核验。'); }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (!hasScope({ ...actor, roles: [] }, 'shipments:read') || (requireOrderRead && !hasScope({ ...actor, roles: [] }, 'orders:read'))) throw businessError('FORBIDDEN', '当前账号没有装箱来源读取权限。');
  return actor;
}
async function visibleOrders(tx: any, ids: string[], actor: TokenPayload) {
  if (!ids.length) return;
  const scope = await freshOrderLineScope(tx, actor);
  for (const id of ids) if (!await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] }, select: { id: true } }))
    throw businessError('SHIPMENT_NOT_FOUND', '运单不存在或不可查看。');
}
export async function readShipmentPacking(prisma: PrismaClient, shipmentId: string, prior: TokenPayload | null): Promise<any> {
  return prisma.$transaction(async (tx: any) => {
    let actor = await currentReader(tx, prior, false); const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment || shipment.deletedAt != null) throw businessError('SHIPMENT_NOT_FOUND', '运单不存在或不可查看。');
    const allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } });
    const orderIds = [...new Set<string>([shipment.orderId, ...allocations.map((row: any) => row.orderId)].filter(Boolean))].sort();
    if (orderIds.length) actor = await currentReader(tx, prior, true);
    await visibleOrders(tx, orderIds, actor);
    const physical = await tx.shipmentProductionAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } });
    const modern = physical.length > 0 || await tx.productionBatch.count({ where: { orderId: { in: orderIds } } }) > 0;
    const claims = await tx.claimDisposition.count({ where: { replacementShipmentId: shipmentId } }) + await tx.repairWorkOrder.count({ where: { reshipmentId: shipmentId } });
    const context = { kind: claims ? 'claim' : modern ? 'physical' : 'legacy', updatedAt: String(shipment.updatedAt),
      allocationFingerprint: physicalShipmentAllocationFingerprint({ shipment, allocations, physical, orderIds }) };
    const actual = new Map<string, { orderId: string; quantity: Prisma.Decimal; unit: string }>();
    for (const row of allocations) if (row.status !== 'Cancelled' && row.orderLineId && row.actualQty != null && new Prisma.Decimal(row.actualQty).gt(0)) {
      const previous = actual.get(row.orderLineId);
      if (previous && (previous.orderId !== row.orderId || previous.unit !== row.unit)) conflict('原订单行分配身份或单位不一致。');
      actual.set(row.orderLineId, { orderId: row.orderId, quantity: (previous?.quantity ?? new Prisma.Decimal(0)).plus(row.actualQty), unit: row.unit });
    }
    const orderLines = await tx.orderLine.findMany({ where: { id: { in: [...actual.keys()] }, orderId: { in: orderIds } } });
    const sources = orderLines.map((line: any) => {
      const original = actual.get(line.id)!;
      if (original.orderId !== line.orderId || typeof original.unit !== 'string' || !original.unit.trim()) conflict('原实际分配的订单行归属或单位尚未核清。');
      return { orderLineId: line.id, orderId: line.orderId, productCode: line.itemNo ?? line.materialCode ?? null,
        productName: line.description ?? line.millQuality ?? null, unit: original.unit, actualQty: original.quantity.toString() };
    });
    return json({ shipment, context, lines: await listShipmentLines(tx, shipmentId), cartons: await listShipmentCartons(tx, shipmentId), sources });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
async function packingContext(tx: any, shipmentId: string, actor: TokenPayload | null) {
  const context = await lockShipmentPhysicalConsumer(tx, { shipmentId, actor, mode: 'packing' });
  if (context.kind === 'claim') {
    // Preserve the original claim parent-lock order and read the Shipment only
    // after that real source lock. No ordinary Order/SPA is invented for claims.
    const claim = await lockClaimShipmentSource(tx, shipmentId);
    if (!claim) conflict('售后运单的原来源已变化。');
    context.shipment = claim.shipment;
    context.allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } });
    context.physical = await tx.shipmentProductionAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } });
    context.orderIds = [...new Set<string>([context.shipment.orderId, ...context.allocations.map((row: any) => row.orderId)].filter(Boolean))].sort();
    context.allocationFingerprint = physicalShipmentAllocationFingerprint(context);
  }
  return context;
}
async function originalPackingEvidence(tx: any, shipmentId: string, requestKey: string, transactionId: string): Promise<any[]> {
  // Do not filter by mutable actor/action/target metadata: damaged ownership or
  // an orphan original primitive is evidence of an unknown committed outcome.
  const anchors = [['after', 'command'], ['after', 'acknowledgement', 'command'], ['after', 'rejection', 'command']];
  return tx.auditLog.findMany({ where: { OR: [
    { transactionId: { in: [transactionId, transactionId + ':lines', transactionId + ':cartons'] } },
    ...anchors.map(path => ({ AND: [
      { detail: { path: [...path, 'shipmentId'], equals: shipmentId } },
      { detail: { path: [...path, 'requestKey'], equals: requestKey } },
    ] })),
  ] } });
}
export async function saveShipmentPacking(params: { prisma: PrismaClient; shipmentId: string; actor: TokenPayload | null; input: unknown; ip?: string | null }): Promise<any> {
  const input = parsePackingCommand(params.input);
  try { return await params.prisma.$transaction(async (tx: any) => {
    // Handoff commands acquire this first too. Serialize quantity decisions
    // with packing before taking the shared source/Shipment locks.
    await assertPhysicalShipmentWriteAuthority(tx, params.actor, false);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentHandoff" WHERE "shipmentId"=${params.shipmentId} FOR UPDATE`);
    const context = await packingContext(tx, params.shipmentId, params.actor);
    const actor = await assertPhysicalShipmentWriteAuthority(tx, params.actor, context.orderIds.length > 0);
    await visibleOrders(tx, context.orderIds, actor);
    const command = { ...input, actorId: actor.userId, shipmentId: params.shipmentId }, commandHash = hash({ schemaVersion: 1, command });
    const transactionId = 'packing_' + hash({ shipmentId: params.shipmentId, actorId: actor.userId, requestKey: input.requestKey });
    const evidence = await originalPackingEvidence(tx, params.shipmentId, input.requestKey, transactionId);
    const prior = evidence.filter(log => log.transactionId === transactionId);
    if (evidence.length && !prior.length) conflict('原装箱请求仍有未核清的保存凭据，请保留原请求。');
    if (prior.length === 1 && prior[0].action === 'reject_shipment_packing') {
      const log = prior[0], rejection = log.detail?.after?.rejection;
      if (evidence.length !== 1 || log.actorId !== actor.userId || log.targetType !== 'Shipment' || log.targetId !== params.shipmentId || log.detail?.source !== source
        || rejection?.schemaVersion !== 1 || rejection.outcome !== 'not_committed' || rejection.commandHash !== commandHash
        || !rejection.command || hash(rejection.command) !== hash(command) || log.detail.after.rejectionHash !== hash(rejection))
        conflict('原请求键已有无法核验的拒绝历史。');
      const finalActor = await assertPhysicalShipmentWriteAuthority(tx, params.actor, context.orderIds.length > 0); await visibleOrders(tx, context.orderIds, finalActor);
      return { rejection };
    }
    if (prior.length) {
      const log = prior[0], saved = log?.detail?.after, ack = saved?.acknowledgement;
      if (evidence.length !== 3 || prior.length !== 1 || !saved?.command || !saved?.result || log.action !== action || log.actorId !== actor.userId || log.targetType !== 'Shipment' || log.targetId !== params.shipmentId
        || log.detail?.source !== source || saved.commandHash !== commandHash || hash(saved.command) !== hash(command)
        || !ack?.command || ack.schemaVersion !== 1 || ack.commandHash !== commandHash || hash(ack.command) !== hash(command)
        || ack.resultHash !== hash(saved.result) || saved.result?.shipment?.id !== params.shipmentId || typeof saved.result.shipment.updatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(saved.result.shipment.updatedAt) || BigInt(saved.result.shipment.updatedAt) <= BigInt(input.expectedShipmentUpdatedAt)
        || !Array.isArray(saved.result?.lines) || !Array.isArray(saved.result?.cartons)) conflict('原装箱请求或持久回执无法完整核验。');
      for (const [suffix, operation, countField, count] of [
        ['lines', 'PACKING_LINES_REPLACE', 'lineCount', saved.result.lines.length],
        ['cartons', 'PACKING_CARTONS_REPLACE', 'cartonCount', saved.result.cartons.length],
      ] as const) {
        const facts = evidence.filter(log => log.transactionId === transactionId + ':' + suffix);
        if (facts.length !== 1 || facts[0].action !== operation || facts[0].actorId !== actor.userId || facts[0].targetType !== 'Shipment'
          || facts[0].targetId !== params.shipmentId || facts[0].detail?.source !== 'route:shipping:packing' || facts[0].detail?.after?.[countField] !== count)
          conflict('原装箱请求缺少真实完整的行或箱保存凭据。');
      }
      if (saved.result.lines.length !== input.lines.length || saved.result.cartons.length !== input.cartons.length) conflict('原装箱回执集合与原请求不一致。');
      if (new Set(saved.result.lines.map((row: any) => row.id)).size !== input.lines.length || new Set(saved.result.cartons.map((row: any) => row.id)).size !== input.cartons.length) conflict('原装箱回执身份重复。');
      const originalIds = new Map(input.lines.map((line, index) => [line.clientLineKey, saved.result.lines[index]?.id]));
      for (let index = 0; index < input.lines.length; index++) {
        const requested = input.lines[index], actual = saved.result.lines[index];
        if (!actual?.id || actual.shipmentId !== params.shipmentId || actual.lineNumber !== index + 1) conflict('原装箱行事实缺失。');
        for (const key of lineFields.filter(key => key !== 'clientLineKey')) {
          const wanted = (requested as any)[key] ?? null, got = actual[key] ?? null;
          const equal = ['quantity', 'grossWeight', 'netWeight', 'volume'].includes(key) && wanted !== null && got !== null
            ? new Prisma.Decimal(wanted).equals(got) : wanted === got;
          if (!equal) conflict('原装箱行事实与原请求不一致。');
        }
      }
      for (let index = 0; index < input.cartons.length; index++) {
        const requested = input.cartons[index], actual = saved.result.cartons[index];
        if (!actual?.id || actual.shipmentId !== params.shipmentId || actual.cartonNo !== requested.cartonNo.trim() || !Array.isArray(actual.items)
          || actual.items.length !== requested.items.length) conflict('原箱保存事实与原请求不一致。');
        for (const key of cartonFields.filter(key => !['items', 'cartonNo'].includes(key))) {
          let wanted = (requested as any)[key] ?? null;
          const got = actual[key] ?? null;
          if (key === 'volume' && wanted === null && requested.length != null && requested.width != null && requested.height != null)
            wanted = new Prisma.Decimal(requested.length).mul(requested.width).mul(requested.height).div(1000000).toDecimalPlaces(4).toString();
          const equal = key !== 'description' && wanted !== null && got !== null ? new Prisma.Decimal(wanted).equals(got) : wanted === got;
          if (!equal) conflict('原箱字段与原请求不一致。');
        }
        if (new Set(actual.items.map((row: any) => row.id)).size !== requested.items.length) conflict('原箱内事实身份重复。');
        for (const item of requested.items) {
          const row = actual.items.find((value: any) => value.shipmentLineId === originalIds.get(item.lineKey));
          if (!row?.id || row.cartonId !== actual.id || !new Prisma.Decimal(row.quantity).equals(item.quantity)) conflict('原箱内分配事实与原请求不一致。');
        }
      }
      if (String(context.shipment.updatedAt) === String(saved.result.shipment.updatedAt)) {
        const now = json({ shipment: context.shipment, lines: await listShipmentLines(tx, params.shipmentId), cartons: await listShipmentCartons(tx, params.shipmentId) });
        // Compare snapshots by stable IDs; list order is not a source identity.
        const byId = (rows: any[]) => rows.map(row => ({ ...row, ...(row.items ? { items: [...row.items].sort((a, b) => a.id.localeCompare(b.id)) } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
        if (hash(byId(now.lines)) !== hash(byId(saved.result.lines)) || hash(byId(now.cartons)) !== hash(byId(saved.result.cartons))) conflict('当前装箱事实与原保存凭据不一致。');
      }
      const replayActor = await assertPhysicalShipmentWriteAuthority(tx, params.actor, context.orderIds.length > 0); await visibleOrders(tx, context.orderIds, replayActor);
      return { ...saved.result, acknowledgement: ack, replayed: true };
    }
    const handoff = await tx.shipmentHandoff.findUnique({ where: { shipmentId: params.shipmentId } });
    if (handoff && handoff.status !== 'Cancelled') {
      if (handoff.status !== 'Processing') throw businessError('INVALID_STATE', '本票正在等待业务确认差异或已交回业务，后勤须在处理中阶段继续装箱。');
      if (!actor.roleIds?.some(roleId => [SYSTEM_ROLE_IDS.LOGISTICS, SYSTEM_ROLE_IDS.ADMIN, SYSTEM_ROLE_IDS.SUPER_ADMIN].includes(roleId as any)))
        throw businessError('FORBIDDEN', '当前账号没有后勤出运专业操作职责。');
      if (context.allocations.some(row => row.status !== 'Cancelled' && row.actualQty == null))
        throw businessError('INVALID_STATE', '请先在原出运交接逐工厂分支核实实际量，未录不能作为零装箱。');
    }
    if (!['Draft', 'Booked', 'Loading'].includes(context.shipment.status)) throw businessError('INVALID_STATE', '仅未发运运单可修改装箱明细。');
    if (String(context.shipment.updatedAt) !== input.expectedShipmentUpdatedAt || context.allocationFingerprint !== input.expectedPhysicalAllocationFingerprint)
      conflict('运单或实际分配已变化，请重新核对原装箱范围。');
    for (const table of ['ShipmentLine', 'ShipmentCarton']) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw('"' + table + '"')} WHERE "shipmentId"=${params.shipmentId} ORDER BY "id" FOR UPDATE`);
    for (const line of input.lines) if (line.orderLineId && !await tx.orderLine.findFirst({ where: { id: line.orderLineId, orderId: { in: context.orderIds } } }))
      conflict('装箱行的原订单行不属于本票真实来源。');
    const before = json({ lines: await listShipmentLines(tx, params.shipmentId), cartons: await listShipmentCartons(tx, params.shipmentId) });
    const lines = await replaceShipmentLinesTx(tx, params.shipmentId, input.lines.map(({ clientLineKey, ...line }) => line), actor.userId, params.ip,
      { skipStatusCheck: true, physicalContext: context, actor, auditPrisma: params.prisma, auditTransactionId: transactionId + ':lines' });
    const ids = new Map(input.lines.map((line, index) => [line.clientLineKey, lines[index].id]));
    const cartons = await replaceShipmentCartonsTx(tx, params.shipmentId, input.cartons.map(carton => ({ ...carton,
      items: carton.items.map(item => ({ shipmentLineId: ids.get(item.lineKey)!, quantity: item.quantity })) })), actor.userId, params.ip, { physicalContext: context, actor, auditTransactionId: transactionId + ':cartons' });
    // Recheck current stored authority and L2 after every producer/lock await.
    const finalActor = await assertPhysicalShipmentWriteAuthority(tx, params.actor, context.orderIds.length > 0); await visibleOrders(tx, context.orderIds, finalActor);
    // Both original packing producers have advanced this same stored header.
    // Reread it in the locked transaction; the original command version is stale.
    const current = await tx.shipment.findUnique({ where: { id: params.shipmentId }, select: { updatedAt: true } });
    if (!current) throw businessError('CONFLICT', '运单来源已变化，请重新读取。');
    const nextVersion = BigInt(current.updatedAt) + BigInt(1), now = BigInt(Date.now());
    const shipment = await tx.shipment.update({ where: { id: params.shipmentId }, data: { updatedAt: now > nextVersion ? now : nextVersion } });
    const result = json({ shipment, lines, cartons });
    const acknowledgement = { schemaVersion: 1, command, commandHash, resultHash: hash(result) };
    await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source, operation: action, targetType: 'Shipment', targetId: params.shipmentId,
      transactionId, before, after: { command, commandHash, result, acknowledgement }, ip: params.ip ?? null });
    const committedActor = await assertPhysicalShipmentWriteAuthority(tx, params.actor, context.orderIds.length > 0); await visibleOrders(tx, context.orderIds, committedActor);
    return { ...result, acknowledgement, replayed: false };
  }); } catch (error: any) {
    // Only a verified business refusal after the original TX has rolled back
    // can retire this exact intent. No permission/dependency/audit/unknown error
    // certifies absence of historical writes.
    if (!isBusinessError(error) || !['CONFLICT', 'INVALID_INPUT', 'INVALID_STATE', 'VALIDATION_FAILED'].includes(error.code)) throw error;
    try {
      const rejection = await params.prisma.$transaction(async (tx: any) => {
        await assertPhysicalShipmentWriteAuthority(tx, params.actor, false);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentHandoff" WHERE "shipmentId"=${params.shipmentId} FOR UPDATE`);
        const context = await packingContext(tx, params.shipmentId, params.actor);
        const actor = await assertPhysicalShipmentWriteAuthority(tx, params.actor, context.orderIds.length > 0); await visibleOrders(tx, context.orderIds, actor);
            const command = { ...input, actorId: actor.userId, shipmentId: params.shipmentId }, commandHash = hash({ schemaVersion: 1, command });
        const transactionId = 'packing_' + hash({ shipmentId: params.shipmentId, actorId: actor.userId, requestKey: input.requestKey });
        // The same Shipment/key serialization is held again after rollback.
        // A racing ACK, a damaged row or another parameter set stays unknown.
        if ((await originalPackingEvidence(tx, params.shipmentId, input.requestKey, transactionId)).length) throw error;
        const rejection = { schemaVersion: 1, outcome: 'not_committed', command, commandHash, code: error.code,
          message: String(error.message), sourceFingerprint: context.allocationFingerprint, shipmentVersion: String(context.shipment.updatedAt) };
        await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source, operation: 'reject_shipment_packing', targetType: 'Shipment', targetId: params.shipmentId,
          transactionId, after: { rejection, rejectionHash: hash(rejection) }, ip: params.ip ?? null });
        const finalActor = await assertPhysicalShipmentWriteAuthority(tx, params.actor, context.orderIds.length > 0); await visibleOrders(tx, context.orderIds, finalActor);
        return rejection;
      });
      return { rejection };
    } catch { throw error; }
  }
}
export function packingCommandError(error: unknown) {
  return safeRouteError(error, { fallbackCode: 'SAVE_FAILED', fallbackMessage: '装箱结果暂时无法确认，请保留原请求重试。' });
}
