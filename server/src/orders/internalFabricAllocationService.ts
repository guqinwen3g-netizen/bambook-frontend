import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { normalizeOrderQuantityUnit } from '../shared/orderQuantitySummary';
import { orderSampleDigest } from '../samples/orderSampleSourceContract';
import { serializeValue } from '../lib/serializeValue';
import { authorizeOrderLineWrite, freshOrderLineScope, currentOrderLineWriteActor, isOrderLineStorageConflict } from './orderLineWriteAccess';
import { assertAllocationCapacity, internalMetres, normalizeGarmentFulfillment } from './internalFabricPolicy';
import { currentInternalDemand, orderBusinessFamily, hasAllInternalBusinessTeams, internalBusinessTeamFamily, teamBusinessFamilies } from './internalOrderFacts';

const fail = (code: string, message: string): never => { throw businessError(code, message); };
const allocationFact = (row: any) => row == null ? null : serializeValue({ ...row, metres: row.metres.toString() });
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.trim() !== value) fail('INVALID_INPUT', `${label}须为明确身份。`);
  return value as string;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT', '请提供准确读取修订；首次分配为 0。');
  return value as number;
}
function input(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) fail('INVALID_INPUT', '分配命令含未定义字段。');
  return raw as Record<string, unknown>;
}
export async function currentInternalOrderReader(db: any, prior?: TokenPayload | null) {
  if (!prior?.userId) fail('UNAUTHORIZED', '请使用当前登录账号。');
  const user = await loadUserWithRoles(db, prior!.userId);
  if (!user || user.status !== 'active' || user.deletedAt != null) fail('ACCOUNT_DISABLED', '账号已失效。');
  const actor = await buildLoadedAuthTokenPayload(db, user);
  if (prior!.permissionCeiling !== undefined) actor.permissionCeiling = [...prior!.permissionCeiling];
  if (!hasScope(actor, 'orders:read')) fail('FORBIDDEN', '当前账号没有订单读取权限。');
  return actor;
}
async function demandMember(db: any, actor: TokenPayload, sourceOrder: any) {
  const demand = await currentInternalDemand(db, sourceOrder);
  if (hasAllInternalBusinessTeams(actor)) return demand;
  const member = await db.teamMember.findFirst({ where: { teamId: demand.team.id, userId: actor.userId, leftAt: null } });
  if (!member) fail('NOT_FOUND', '内部面料行不存在或不属于当前实际需求团队。');
  return demand;
}
async function target(db: any, actor: TokenPayload, orderId: string, lineId: string, write: boolean) {
  const current = write ? await currentOrderLineWriteActor(db, actor, 'update') : await currentInternalOrderReader(db, actor);
  const scope = await freshOrderLineScope(db, current);
  const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } });
  const line = order ? await db.orderLine.findUnique({ where: { id: lineId } }) : null;
  if (!order || !line || line.orderId !== orderId) fail('NOT_FOUND', '成衣订单行不存在或不在当前可操作范围。');
  if (orderBusinessFamily(order) !== 'garment') fail('INVALID_INPUT', '内部面料分配只适用于成衣订单行。');
  return { actor: current, order, line };
}
async function source(db: any, actor: TokenPayload, lineId: string, requireCurrent: boolean) {
  const line = await db.orderLine.findUnique({ where: { id: lineId } });
  const order = line ? await db.order.findFirst({ where: { id: line.orderId, deletedAt: null } }) : null;
  if (!line || !order || order.orderPurpose !== 'internal_fabric_supply' || orderBusinessFamily(order) !== 'fabric') fail('NOT_FOUND', '内部面料行不存在或不属于当前需求团队。');
  await demandMember(db, actor, order);
  if (requireCurrent) {
    if (['Pending', 'Cancelled', 'Archived'].includes(order.status)) fail('CONFLICT', '内部面料供给单尚未正式批准或已失效。');
    const approved = await db.approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: order.id, status: 'approved' }, orderBy: { decidedAt: 'desc' } });
    if (!approved) fail('CONFLICT', '内部面料供给单尚无真实主单审批通过依据。');
    if (normalizeOrderQuantityUnit(line.unit) !== 'M') fail('INVALID_INPUT', '内部面料行须使用明确米数单位，不能自动换算。');
  }
  return { order, line };
}

export function createInternalFabricAllocationService(options: { prisma: any; clock?: () => number }) {
  const { prisma } = options, clock = options.clock ?? Date.now;
  async function recover(tx: any, actor: TokenPayload, command: Record<string, unknown>) {
    const auditId = `FLAA__${orderSampleDigest({ actorId: actor.userId, requestKey: command.requestKey })}`;
    const audit = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (!audit) return { auditId, original: null };
    const receipt = audit.detail?.commandReceipt;
    if (audit.actorId !== actor.userId || audit.targetType !== 'FabricLineAllocation' || receipt?.requestFingerprint !== orderSampleDigest(command)
      || orderSampleDigest(receipt.command) !== orderSampleDigest(command) || !receipt.result?.commandAck
      || receipt.result.commandAck.auditId !== audit.id) fail('CONFLICT', '请求键已用于其他分配参数，请保留原请求核对。');
    return { auditId, original: receipt.result };
  }
  async function lock(tx: any, actor: TokenPayload, key: string, orderIds: string[], lineIds: string[]) {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`internal-fabric-v1:${actor.userId}:${key}`},0))::text`);
    for (const id of [...new Set(orderIds)].sort()) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${id} FOR UPDATE`);
    for (const id of [...new Set(lineIds)].sort()) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${id} FOR UPDATE`);
  }
  async function save(tx: any, actor: TokenPayload, command: Record<string, unknown>, auditId: string, next: any, before: any) {
    const now = clock();
    if (!Number.isSafeInteger(now) || now <= 0) fail('CONFLICT', '服务器事实时间无效。');
    const after = allocationFact({ ...next, auditId, updatedBy: actor.userId, updatedAt: String(now) });
    const ack = { protocolVersion: 1, operation: command.operation, actorId: actor.userId, requestKey: command.requestKey,
      requestFingerprint: orderSampleDigest(command), allocationId: next.id, revision: next.revision, auditId,
      fabricOrderLineId: next.fabricOrderLineId, garmentOrderLineId: next.garmentOrderLineId, metres: next.metres.toString(), status: next.status };
    const result = { allocation: after, commandAck: ack };
    await tx.auditLog.create({ data: { id: auditId, actorId: actor.userId, action: next.status === 'active' ? 'allocate_internal_fabric' : 'cancel_internal_fabric_allocation',
      targetType: 'FabricLineAllocation', targetId: next.id, createdAt: new Date(now), detail: { source: 'route:orders:internal-fabric', before: allocationFact(before),
        after, commandReceipt: { command, requestFingerprint: orderSampleDigest(command), result } } } });
    const data = { ...next, metres: internalMetres(next.metres.toString()), auditId, updatedBy: actor.userId, updatedAt: BigInt(now),
      lastRequestKey: String(command.requestKey), lastRequestFingerprint: orderSampleDigest(command) };
    await tx.fabricLineAllocation.upsert({ where: { garmentOrderLineId: next.garmentOrderLineId },
      create: { ...data, createdBy: actor.userId, createdAt: BigInt(now) }, update: data });
    return result;
  }
  async function transaction<T>(work: (tx: any) => Promise<T>) {
    try { return await prisma.$transaction(work, { isolationLevel: 'ReadCommitted', timeout: 30000 }); }
    catch (error) { if (isOrderLineStorageConflict(error)) fail('CONFLICT', '分配正在变化，请保留原请求并重试核对。'); throw error; }
  }
  return {
    async personnel(prior: TokenPayload) {
      const actor = await currentInternalOrderReader(prisma, prior);
      const teams = (await prisma.team.findMany({ where: { status: 'active', deletedAt: null }, include: { department: true, members: { where: { leftAt: null } } }, orderBy: { name: 'asc' } })).filter((team: any) => internalBusinessTeamFamily(team));
      const users = await prisma.userAccount.findMany({ where: { id: { in: teams.flatMap((team: any) => team.members.map((m: any) => m.userId)) }, status: 'active', deletedAt: null }, select: { id: true, displayName: true, primaryDeptId: true } });
      const byId = new Map<string, {id: string; displayName: string; primaryDeptId?: string | null}>(users.map((user: {id: string; displayName: string; primaryDeptId?: string | null}) => [user.id, user]));
      const creator = await prisma.userAccount.findFirst({ where: { id: actor.userId, status: 'active', deletedAt: null } });
      const memberships = await prisma.teamMember.findMany({ where: { userId: actor.userId, leftAt: null }, include: { team: { include: { department: true } } } });
      return { canWrite: hasScope(actor, 'orders:write'), creatorFamilies: hasAllInternalBusinessTeams(actor) ? ['fabric', 'garment'] : [...new Set(memberships.filter((m: any) => creator?.primaryDeptId && m.team?.departmentId === creator.primaryDeptId && m.team?.status === 'active' && m.team.deletedAt == null).flatMap((m: any) => teamBusinessFamilies(m.team)).filter(Boolean))],
        teams: teams.map((team: any) => ({ id: team.id, name: team.name, businessFamily: internalBusinessTeamFamily(team), businessFamilies: teamBusinessFamilies(team), members: team.members.filter((m: any) => byId.has(m.userId) && byId.get(m.userId)!.primaryDeptId === team.departmentId).map((m: any) => ({ id: m.userId, name: byId.get(m.userId)!.displayName })) })) };
    },
    async context(prior: TokenPayload, orderId: string, lineId: string) {
      const reader = await currentInternalOrderReader(prisma, prior), scope = await freshOrderLineScope(prisma, reader);
      const owner = await prisma.order.findFirst({ where: { id: text(orderId, '订单'), deletedAt: null, AND: [scope] } });
      const sourceLine = owner ? await prisma.orderLine.findUnique({ where: { id: text(lineId, '订单行') } }) : null;
      if (!owner || !sourceLine || sourceLine.orderId !== orderId) fail('NOT_FOUND', '订单行不存在或不在当前可见范围。');
      if (owner.orderPurpose === 'internal_fabric_supply' && orderBusinessFamily(owner) === 'fabric') {
        const outgoing = await prisma.fabricLineAllocation.findMany({ where: { fabricOrderLineId: lineId, status: 'active' }, orderBy: { id: 'asc' } });
        const remaining = assertAllocationCapacity(sourceLine.quantity.toString(), outgoing.map((row: any) => row.metres.toString()));
        return { orderId, lineId, fulfillmentMode: null, cmtIncludedItems: null, canWrite: false, allocation: null, candidates: [],
          outgoingAllocations: outgoing.map(allocationFact), sourceQuantity: sourceLine.quantity.toString(), remaining: remaining.toString() };
      }
      const current = await target(prisma, prior, text(orderId, '订单'), text(lineId, '订单行'), false);
      const allocation = await prisma.fabricLineAllocation.findUnique({ where: { garmentOrderLineId: lineId } });
      const membership = await prisma.teamMember.findMany({ where: { userId: current.actor.userId, leftAt: null }, include: { team: { include: { department: true } } } });
      const teamIds = membership.filter((m: any) => m.team?.status === 'active' && m.team.deletedAt == null && teamBusinessFamilies(m.team).includes('garment')).map((m: any) => m.teamId);
      const allTeams = hasAllInternalBusinessTeams(current.actor);
      const orders = allTeams || teamIds.length ? await prisma.order.findMany({ where: { deletedAt: null, orderPurpose: 'internal_fabric_supply', ...(allTeams ? {} : { internalDemandTeamId: { in: teamIds } }), status: { notIn: ['Pending', 'Cancelled', 'Archived'] } }, include: { lines: true }, orderBy: { id: 'asc' } }) : [];
      const candidates = [];
      for (const order of orders) for (const line of order.lines) {
        try { await source(prisma, current.actor, line.id, true); } catch (error) { if (isBusinessError(error)) continue; throw error; }
        const active = await prisma.fabricLineAllocation.findMany({ where: { fabricOrderLineId: line.id, status: 'active' } });
        const remaining = assertAllocationCapacity(line.quantity.toString(), active.map((a: any) => a.metres.toString()));
        candidates.push({ orderId: order.id, code: order.code, lineId: line.id, itemNo: line.itemNo, description: line.description, quantity: line.quantity.toString(), unit: 'M',
          allocated: internalMetres(line.quantity.toString()).minus(remaining).toString(), remaining: remaining.toString(), internalPurpose: order.internalPurpose, internalDemandTeamId: order.internalDemandTeamId, internalReceiverId: order.internalReceiverId });
      }
      return { orderId, lineId, fulfillmentMode: current.line.fulfillmentMode ?? null, cmtIncludedItems: current.line.cmtIncludedItems ?? null,
        canWrite: hasScope(current.actor, 'orders:write') && (allTeams || teamIds.length > 0), allocation: allocationFact(allocation), candidates };
    },
    async allocate(prior: TokenPayload, orderId: string, lineId: string, raw: unknown) {
      const body = input(raw, ['requestKey', 'fabricOrderLineId', 'metres', 'expectedRevision']);
      const command = { operation: 'allocate', orderId: text(orderId, '订单'), lineId: text(lineId, '订单行'), requestKey: text(body.requestKey, '请求键'),
        fabricOrderLineId: text(body.fabricOrderLineId, '面料行'), metres: internalMetres(body.metres).toString(), expectedRevision: revision(body.expectedRevision) };
      return transaction(async tx => {
        let current = await target(tx, prior, orderId, lineId, true);
        const hinted = await source(tx, current.actor, command.fabricOrderLineId, false);
        const old = await tx.fabricLineAllocation.findUnique({ where: { garmentOrderLineId: lineId } });
        await lock(tx, current.actor, command.requestKey, [orderId, hinted.order.id, ...(old ? [old.fabricOrderId] : [])], [lineId, command.fabricOrderLineId, ...(old ? [old.fabricOrderLineId] : [])]);
        const authorized = await authorizeOrderLineWrite(tx, orderId, prior, 'update');
        current = { ...current, ...authorized, line: await tx.orderLine.findUnique({ where: { id: lineId } }) };
        await source(tx, current.actor, command.fabricOrderLineId, false);
        const recovered = await recover(tx, current.actor, command); if (recovered.original) return recovered.original;
        if (normalizeGarmentFulfillment(current.line).fulfillmentMode !== 'full_package') fail('CONFLICT', '只有全包条目分配内部面料。');
        const supply = await source(tx, current.actor, command.fabricOrderLineId, true);
        const before = await tx.fabricLineAllocation.findUnique({ where: { garmentOrderLineId: lineId } });
        if ((before?.revision ?? 0) !== command.expectedRevision) fail('CONFLICT', '分配版本已变化，请刷新后核对。');
        const active = await tx.fabricLineAllocation.findMany({ where: { fabricOrderLineId: supply.line.id, status: 'active' } });
        assertAllocationCapacity(supply.line.quantity.toString(), [...active.filter((a: any) => a.garmentOrderLineId !== lineId).map((a: any) => a.metres.toString()), command.metres]);
        return save(tx, current.actor, command, recovered.auditId, { id: before?.id ?? `FLA__${orderSampleDigest({ lineId })}`, fabricOrderId: supply.order.id,
          fabricOrderLineId: supply.line.id, garmentOrderId: orderId, garmentOrderLineId: lineId, metres: command.metres, status: 'active', revision: (before?.revision ?? 0) + 1 }, before);
      });
    },
    async cancel(prior: TokenPayload, allocationId: string, raw: unknown) {
      const body = input(raw, ['requestKey', 'expectedRevision']);
      const command = { operation: 'cancel', allocationId: text(allocationId, '分配'), requestKey: text(body.requestKey, '请求键'), expectedRevision: revision(body.expectedRevision) };
      return transaction(async tx => {
        const hint = await tx.fabricLineAllocation.findUnique({ where: { id: allocationId } });
        if (!hint) fail('NOT_FOUND', '分配记录不存在。');
        const current = await target(tx, prior, hint.garmentOrderId, hint.garmentOrderLineId, true);
        await source(tx, current.actor, hint.fabricOrderLineId, false);
        await lock(tx, current.actor, command.requestKey, [hint.garmentOrderId, hint.fabricOrderId], [hint.garmentOrderLineId, hint.fabricOrderLineId]);
        const authorized = await authorizeOrderLineWrite(tx, hint.garmentOrderId, prior, 'update');
        await source(tx, authorized.actor, hint.fabricOrderLineId, false);
        const recovered = await recover(tx, authorized.actor, command); if (recovered.original) return recovered.original;
        const before = await tx.fabricLineAllocation.findUnique({ where: { id: allocationId } });
        if (!before || before.revision !== command.expectedRevision || before.status !== 'active') fail('CONFLICT', '分配版本已变化或已取消，请刷新。');
        const next = { ...before, status: 'cancelled', revision: before.revision + 1 };
        return save(tx, authorized.actor, command, recovered.auditId, next, before);
      });
    },
  };
}
