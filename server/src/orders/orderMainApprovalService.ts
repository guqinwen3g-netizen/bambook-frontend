import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { syncOrderEntityReferences } from '../entities/sync';
import { persistBusinessEventInTransaction, publishBusinessEvent } from '../events/businessEventBus';
import { evaluateOrderConfirmGates } from './orderLifecycleService';
import { consumeCreditException } from '../credit/creditExceptionGate';
import type { TokenPayload } from '../auth/service';
import { authorizeOrderLineWrite, currentOrderLineWriteActor, isOrderLineStorageConflict } from './orderLineWriteAccess';
import { approvalReviewContentVersion } from '../approvals/approvalReviewContent';
import { orderMainSnapshotFingerprint, readOrderMainApprovalAccess, readOrderMainRejection, readOrderMainWithdrawal, verifyOrderMainFrozenEvidence } from './orderMainApprovalEvidence';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from './orderLineWriteAccess';
import { currentInternalDemand, isInternalOrderPurpose } from './internalOrderFacts';
import { normalizeGarmentFulfillment } from './internalFabricPolicy';
import { assertFabricSupplyTermsParty } from './fabricSupplyTermsService';

export const ORDER_MAIN_APPROVAL_ACTION = 'order:main_approval';
const OWNER_ROLE_IDS = new Set([SYSTEM_ROLE_IDS.SUPER_ADMIN]);

export type OrderApprovalBusinessLine = 'fabric' | 'garment';
export class OrderMainApprovalError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) { super(message); }
}
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? item.toString() : item)).digest('hex');
const asIds = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === 'string'))] : [];

export function orderApprovalBusinessLine(order: any): OrderApprovalBusinessLine {
  const key = String(order.businessLine || order.type || '').trim().toLowerCase();
  if (['fabric', '面料'].includes(key)) return 'fabric';
  if (['garment', 'apparel', 'clothing', '成衣', '服装'].includes(key)) return 'garment';
  throw new OrderMainApprovalError('ORDER_APPROVAL_DOMAIN_UNKNOWN', 409, '订单业务域无法明确识别为面料或成衣，暂不能提交主单审批。');
}

export function createOrderMainApprovalService(prisma: PrismaClient) {
  async function resolveEligibleReviewerIds(tx: any, businessLine: OrderApprovalBusinessLine) {
    const assignments = await tx.orderApprovalAuthority.findMany({
      where: { businessLine, active: true, user: { status: 'active', deletedAt: null } },
      select: { userId: true },
    });
    const owners = await tx.userAccount.findMany({
      where: { status: 'active', deletedAt: null, roles: { some: { roleId: { in: [...OWNER_ROLE_IDS] } } } },
      select: { id: true },
    });
    if (!assignments.length) throw new OrderMainApprovalError('ORDER_APPROVAL_AUTHORITY_MISSING', 409,
      `尚未配置${businessLine === 'fabric' ? '面料' : '成衣'}订单审批负责人。请先在订单审批资格配置中授权后再提交。`);
    const ids = [...new Set([...assignments.map((x: any) => x.userId), ...owners.map((x: any) => x.id)])].sort();
    return ids;
  }

  async function submit(orderId: string, requesterId: string, trustedActor?: TokenPayload | null) {
    if (trustedActor && trustedActor.userId !== requesterId) throw new OrderMainApprovalError('FORBIDDEN', 403, '提交主体与当前账号不一致。');
    return prisma.$transaction(async (tx: any) => {
      const { actor: submitActor } = await authorizeOrderLineWrite(tx, orderId, trustedActor ?? { userId: requesterId } as TokenPayload, 'update');
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
      if (!order || order.deletedAt) throw new OrderMainApprovalError('ORDER_NOT_FOUND', 404, '订单不存在。');
      if (order.status !== 'Pending') throw new OrderMainApprovalError('ORDER_NOT_DRAFT', 409, '只有草稿订单可以提交主单审批。');
      if (!order.lines?.length) throw new OrderMainApprovalError('ORDER_LINES_REQUIRED', 409, '订单至少需要一条条目后才能提交主单审批。');
      const existing = await tx.approvalRequest.findFirst({ where: { actionType: ORDER_MAIN_APPROVAL_ACTION, targetType: 'Order', targetId: orderId, status: 'pending' } });
      if (existing) throw new OrderMainApprovalError('ORDER_APPROVAL_PENDING', 409, '该订单已有待处理的主单审批。');
      const businessLine = orderApprovalBusinessLine(order);
      if (isInternalOrderPurpose(order.orderPurpose)) await currentInternalDemand(tx, order);
      if (businessLine === 'garment') for (const line of order.lines) normalizeGarmentFulfillment(line);
      for (const line of order.lines) await assertFabricSupplyTermsParty(tx, submitActor, line, businessLine, true);
      const eligibleReviewerIds = await resolveEligibleReviewerIds(tx, businessLine);
      const rawSnapshot = { order: { ...order, lines: order.lines }, businessLine };
      const snapshot = JSON.parse(JSON.stringify(rawSnapshot, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
      const contentFingerprint = orderMainSnapshotFingerprint(rawSnapshot);
      const previous = await tx.approvalRequest.findMany({ where: { actionType: ORDER_MAIN_APPROVAL_ACTION, targetType: 'Order', targetId: orderId }, select: { payload: true } });
      const round = previous.reduce((max: number, row: any) => Math.max(max, Number(row.payload?.round || 0)), 0) + 1;
      const approval = await tx.approvalRequest.create({ data: {
        id: `OAP_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`, requesterId, reviewerId: null,
        actionType: ORDER_MAIN_APPROVAL_ACTION, targetType: 'Order', targetId: orderId, status: 'pending', risk: 'high',
        eligibleReviewerIds,
        payload: { schemaVersion: 1, round, businessLine, contentFingerprint, contentFingerprintAlgorithm: 'canonical_v1', snapshot },
        reviewerResolverRoute: 'ORDER_BUSINESS_DOMAIN_PARALLEL', departmentSnapshotId: null,
      } });
      return approval;
    }, { isolationLevel: 'Serializable' });
  }

  async function listAuthorityConfig() {
    const [assignments, users] = await Promise.all([
      prisma.orderApprovalAuthority.findMany({ where: { active: true }, include: { user: { select: { id: true, displayName: true, email: true, status: true } } }, orderBy: [{ businessLine: 'asc' }, { userId: 'asc' }] }),
      prisma.userAccount.findMany({ where: { status: 'active', deletedAt: null }, select: { id: true, displayName: true, email: true,
        roles: { select: { roleId: true } } }, orderBy: { displayName: 'asc' } }),
    ]);
    return { assignments, users: users.map((user: any) => ({ ...user, isOwner: user.roles.some((role: any) => OWNER_ROLE_IDS.has(role.roleId)) })) };
  }

  async function listHistory(orderId: string) {
    const items = await prisma.approvalRequest.findMany({ where: { actionType: ORDER_MAIN_APPROVAL_ACTION, targetType: 'Order', targetId: orderId },
      include: { requester: { select: { id: true, displayName: true } }, reviewer: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' } });
    return Promise.all(items.map(async row => ({ ...row, ...await readOrderMainRejection(prisma, row), ...await readOrderMainWithdrawal(prisma, row) })));
  }

  async function replaceAuthorityConfig(input: { businessLine: OrderApprovalBusinessLine; userIds: string[]; actorId: string }) {
    const userIds = [...new Set(input.userIds)];
    return prisma.$transaction(async (tx: any) => {
      const users = await tx.userAccount.findMany({ where: { id: { in: userIds }, status: 'active', deletedAt: null }, select: { id: true } });
      if (users.length !== userIds.length) throw new OrderMainApprovalError('ORDER_APPROVAL_AUTHORITY_INVALID_USER', 400, '授权列表包含停用、删除或不存在的账号。');
      await tx.orderApprovalAuthority.updateMany({ where: { businessLine: input.businessLine }, data: { active: false } });
      for (const userId of userIds) await tx.orderApprovalAuthority.upsert({
        where: { userId_businessLine: { userId, businessLine: input.businessLine } },
        create: { userId, businessLine: input.businessLine, active: true, createdBy: input.actorId },
        update: { active: true, createdBy: input.actorId },
      });
      const assignments = await tx.orderApprovalAuthority.findMany({ where: { businessLine: input.businessLine, active: true }, include: { user: { select: { id: true, displayName: true, email: true } } }, orderBy: { userId: 'asc' } });
      await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'admin:order-approval-authorities',
        operation: 'replace_order_approval_authorities', targetType: 'OrderApprovalAuthority', targetId: input.businessLine,
        after: { businessLine: input.businessLine, userIds } });
      return assignments;
    }, { isolationLevel: 'Serializable' });
  }

  async function decide(input: { approvalId: string; actorId: string; decision: 'approved' | 'rejected'; note?: string;
    rejectionReason?: string; requestedChanges?: string; reviewContentVersion?: string; trustedActor?: TokenPayload | null }) {
    if (input.trustedActor && input.trustedActor.userId !== input.actorId) throw new OrderMainApprovalError('FORBIDDEN', 403, '审批主体与当前账号不一致。');
    const prior = input.trustedActor ?? { userId: input.actorId } as TokenPayload;
    await currentOrderLineWriteActor(prisma, prior, 'update');
    const rejectionReason = typeof input.rejectionReason === 'string' ? input.rejectionReason.trim() : '';
    const requestedChanges = typeof input.requestedChanges === 'string' ? input.requestedChanges.trim() : '';
    if (input.decision === 'rejected' && (!rejectionReason || !requestedChanges))
      throw new OrderMainApprovalError('VALIDATION_FAILED', 400, '退回原因和具体修改要求必须分别填写。');
    let creditExceptionPass: any = null;
    if (input.decision === 'approved') {
      const preflight = await prisma.approvalRequest.findUnique({ where: { id: input.approvalId } });
      if (!preflight || preflight.actionType !== ORDER_MAIN_APPROVAL_ACTION || preflight.targetType !== 'Order')
        throw new OrderMainApprovalError('APPROVAL_NOT_FOUND', 404, '主单审批不存在。');
      if (preflight.status !== 'pending') throw new OrderMainApprovalError('APPROVAL_ALREADY_DECIDED', 409, '该主单审批已处理，请重新读取实际审批人和结果。');
      if (!asIds(preflight.eligibleReviewerIds).includes(input.actorId)) throw new OrderMainApprovalError('APPROVAL_NOT_ASSIGNED', 403, '你不在该订单提交时冻结的审批授权名单中。');
      const gates = await evaluateOrderConfirmGates({ prisma, orderId: preflight.targetId || '', actorId: input.actorId, logScope: 'order:main-approval' });
      if (!gates.allowed) throw new OrderMainApprovalError(gates.error.code, gates.error.code === 'CREDIT_CHECK_FAILED' ? 503 : 409,
        `主单审批不能确认订单：${gates.error.message}`);
      creditExceptionPass = gates.creditExceptionPass;
    }
    let committedEvent: Parameters<typeof persistBusinessEventInTransaction>[1] | undefined;
    let result;
    try { result = await prisma.$transaction(async (tx: any) => {
      await currentOrderLineWriteActor(tx, prior, 'update');
      const target = await tx.approvalRequest.findUnique({ where: { id: input.approvalId }, select: { targetId: true, targetType: true, actionType: true } });
      if (!target?.targetId || target.targetType !== 'Order' || target.actionType !== ORDER_MAIN_APPROVAL_ACTION)
        throw new OrderMainApprovalError('APPROVAL_NOT_FOUND', 404, '主单审批不存在。');
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${target.targetId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${input.approvalId} FOR UPDATE`;
      const approval = await tx.approvalRequest.findUnique({ where: { id: input.approvalId } });
      if (!approval || approval.actionType !== ORDER_MAIN_APPROVAL_ACTION || approval.targetType !== 'Order' || !approval.targetId)
        throw new OrderMainApprovalError('APPROVAL_NOT_FOUND', 404, '主单审批不存在。');
      if (approval.status !== 'pending') throw new OrderMainApprovalError('APPROVAL_ALREADY_DECIDED', 409, '该主单审批已由其他审批人处理。');
      if (input.reviewContentVersion && input.reviewContentVersion !== approvalReviewContentVersion(approval))
        throw new OrderMainApprovalError('ORDER_APPROVAL_CONTENT_CHANGED', 409, '审批内容已变化，请重新审阅本次原件。');
      if (!asIds(approval.eligibleReviewerIds).includes(input.actorId)) throw new OrderMainApprovalError('APPROVAL_NOT_ASSIGNED', 403, '你不在该订单提交时冻结的审批授权名单中。');
      const payload: any = approval.payload || {};
      if (approval.targetId !== target.targetId) throw new OrderMainApprovalError('ORDER_APPROVAL_CONTENT_CHANGED', 409, '审批来源已变化，请重新加载。');
      const order = await tx.order.findUnique({ where: { id: approval.targetId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
      if (!order || order.deletedAt) throw new OrderMainApprovalError('ORDER_NOT_FOUND', 404, '关联订单不存在。');
      const currentActor = await currentOrderLineWriteActor(tx, prior, 'update');
      if (!hasScope({ ...currentActor, roles: [] }, 'orders:write')) throw new OrderMainApprovalError('FORBIDDEN', 403, '当前账号没有订单审批写权限。');
      const visible = await tx.order.findFirst({ where: { id: order.id, deletedAt: null, AND: [await freshOrderLineScope(tx, currentActor)] } });
      if (!visible) throw new OrderMainApprovalError('ORDER_NOT_FOUND', 404, '关联订单不在当前可操作范围。');
      const currentReviewers = await resolveEligibleReviewerIds(tx, orderApprovalBusinessLine(order));
      if (!currentReviewers.includes(input.actorId)) throw new OrderMainApprovalError('APPROVAL_NOT_ASSIGNED', 403, '当前账号已不具备该业务域的主单审批资格。');
      const frozenEvidence = verifyOrderMainFrozenEvidence(approval, order);
      if (frozenEvidence === 'legacy_unverifiable') throw new OrderMainApprovalError('ORDER_APPROVAL_EVIDENCE_UNKNOWN', 409, '历史冻结依据无法核验，请撤回后重新提交准确快照。');
      const liveFingerprint = payload.contentFingerprintAlgorithm === 'canonical_v1'
        ? orderMainSnapshotFingerprint({ order: { ...order, lines: order.lines }, businessLine: payload.businessLine })
        : hash({ order: { ...order, lines: order.lines }, businessLine: payload.businessLine });
      if (liveFingerprint !== payload.contentFingerprint) throw new OrderMainApprovalError('ORDER_APPROVAL_CONTENT_CHANGED', 409, '审批期间订单内容发生变化，已阻止决议；请重新提交审批。');
      if (input.decision === 'approved' && order.status !== 'Pending') throw new OrderMainApprovalError('ORDER_NOT_DRAFT', 409, '订单已不处于待确认状态。');
      if (input.decision === 'approved' && isInternalOrderPurpose(order.orderPurpose)) await currentInternalDemand(tx, order);
      const now = new Date();
      const note = input.decision === 'rejected' ? `驳回原因：${rejectionReason}\n需要修改的内容：${requestedChanges}` : input.note?.trim() || null;
      const changed = await tx.approvalRequest.updateMany({ where: { id: approval.id, status: 'pending' }, data: {
        status: input.decision, reviewerId: input.actorId, decidedAt: now, decisionNote: note,
      } });
      if (changed.count !== 1) throw new OrderMainApprovalError('APPROVAL_ALREADY_DECIDED', 409, '该主单审批已由其他审批人处理。');
      if (input.decision === 'approved') {
        const updated = await tx.order.updateMany({ where: { id: order.id, status: 'Pending' }, data: { status: 'Confirmed', updatedAt: BigInt(Date.now()) } });
        if (updated.count !== 1) throw new OrderMainApprovalError('ORDER_NOT_DRAFT', 409, '订单状态已变化，批准未能生效。');
        const transitionId = `OST_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        await tx.orderStatusTransition.create({ data: { id: transitionId, orderId: order.id, fromStatus: 'Pending', toStatus: 'Confirmed',
          note: `主单审批通过：${approval.id}`, operator: input.actorId, lineId: null, createdAt: BigInt(Date.now()) } });
        const committedOrder = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
        await syncOrderEntityReferences(prisma, committedOrder, { source: 'order:main-approval' }, tx);
        await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'api:order-main-approval',
          operation: 'transition_order_status', targetType: 'Order', targetId: order.id,
          before: { status: 'Pending' }, after: { status: 'Confirmed', transitionId } });
        const event = { id: `bev_OrderConfirmed_${transitionId}`, type: 'OrderConfirmed', sourceEntityType: 'Order',
          sourceEntityId: order.id, orderId: order.id, payload: { poNumber: order.poNumber, fromStatus: 'Pending',
            customer: order.customer, transitionId }, actorId: input.actorId, transactionId: transitionId, occurredAt: Date.now() };
        await persistBusinessEventInTransaction(tx, event as any);
        if (creditExceptionPass) await consumeCreditException({
          exceptionService: creditExceptionPass.service, exceptionId: creditExceptionPass.exception.id,
          scope: creditExceptionPass.scope, actorId: input.actorId, tx,
          note: `订单 ${order.id} 确认（Confirmed）经信用例外 ${creditExceptionPass.exception.exceptionNumber} 放行`,
        });
        committedEvent = event as Parameters<typeof persistBusinessEventInTransaction>[1];
      }
      await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'api:order-main-approval',
        operation: input.decision === 'approved' ? 'approve_order_main_approval' : 'reject_order_main_approval',
        targetType: 'ApprovalRequest', targetId: approval.id,
        after: { orderId: order.id, round: payload.round, businessLine: payload.businessLine, decision: input.decision, note,
          rejectionReason: input.decision === 'rejected' ? rejectionReason : null, requestedChanges: input.decision === 'rejected' ? requestedChanges : null } });
      return tx.approvalRequest.findUnique({ where: { id: approval.id }, include: { requester: { select: { id: true, displayName: true } }, reviewer: { select: { id: true, displayName: true } } } });
    }, { isolationLevel: 'Serializable' }); }
    catch (error) {
      if (!isOrderLineStorageConflict(error)) throw error;
      await currentOrderLineWriteActor(prisma, prior, 'update');
      const current = await prisma.approvalRequest.findUnique({ where: { id: input.approvalId } });
      // Re-read only. Never rerun a losing decision transaction.
      if (current?.actionType === ORDER_MAIN_APPROVAL_ACTION && current.status !== 'pending')
        throw new OrderMainApprovalError('APPROVAL_ALREADY_DECIDED', 409, '该主单审批已处理，请重新读取实际审批人和结果。');
      throw new OrderMainApprovalError('ORDER_APPROVAL_CONFLICT', 409, '主单审批正在被处理，请刷新后重试。');
    }
    if (committedEvent) publishBusinessEvent({ ...committedEvent, eventId: committedEvent.id }).catch(() => { /* durable event remains recoverable */ });
    return result ? { ...result, ...(await readOrderMainRejection(prisma, result)) } : result;
  }

  async function withdraw(input: { approvalId: string; actor: TokenPayload; requestKey: string; reviewContentVersion: string; reason: string }) {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 4000 || typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 128
      || !/^[a-f0-9]{64}$/.test(input.reviewContentVersion)) throw new OrderMainApprovalError('VALIDATION_FAILED', 400, '撤回须填写原因、稳定请求键和准确审批版本。');
    const commandHash = orderMainSnapshotFingerprint({ operation: 'withdraw_order_main_approval', approvalId: input.approvalId,
      actorId: input.actor.userId, requestKey: input.requestKey, reviewContentVersion: input.reviewContentVersion, reason });
    try { return await prisma.$transaction(async (tx: any) => {
      let actor = await currentOrderLineWriteActor(tx, input.actor, 'update');
      const candidate = await tx.approvalRequest.findUnique({ where: { id: input.approvalId } });
      if (!candidate?.targetId || candidate.actionType !== ORDER_MAIN_APPROVAL_ACTION || candidate.targetType !== 'Order')
        throw new OrderMainApprovalError('APPROVAL_NOT_FOUND', 404, '主单审批不存在。');
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${candidate.targetId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${input.approvalId} FOR UPDATE`;
      actor = await currentOrderLineWriteActor(tx, input.actor, 'update');
      if (!hasScope({ ...actor, roles: [] }, 'orders:write')) throw new OrderMainApprovalError('FORBIDDEN', 403, '当前账号没有订单写权限。');
      const approval = await tx.approvalRequest.findUnique({ where: { id: input.approvalId } });
      const order = await tx.order.findFirst({ where: { id: candidate.targetId, deletedAt: null, AND: [await freshOrderLineScope(tx, actor)] } });
      if (!order || !approval || approval.targetId !== order.id) throw new OrderMainApprovalError('ORDER_NOT_FOUND', 404, '关联订单不在当前可操作范围。');
      if (approval.requesterId !== actor.userId && !(await resolveEligibleReviewerIds(tx, orderApprovalBusinessLine(order))).includes(actor.userId))
        throw new OrderMainApprovalError('APPROVAL_NOT_ASSIGNED', 403, '只有原提交人或当前同域审批负责人可撤回。');
      const original = await tx.auditLog.findFirst({ where: { actorId: actor.userId, action: 'withdraw_order_main_approval',
        detail: { path: ['after', 'requestKey'], equals: input.requestKey } } });
      if (original) {
        if (original.targetId !== approval.id || original.detail?.after?.commandHash !== commandHash)
          throw new OrderMainApprovalError('ORDER_APPROVAL_CONFLICT', 409, '该请求键已经用于不同的撤回内容。');
        if (approval.status !== 'cancelled' || !original.detail?.after?.commandAck)
          throw new OrderMainApprovalError('ORDER_APPROVAL_CONFLICT', 409, '原撤回回执与审批事实不一致。');
        return { ok: true, item: approval, commandAck: original.detail.after.commandAck, replayed: true };
      }
      if (approval.status !== 'pending') throw new OrderMainApprovalError('APPROVAL_ALREADY_DECIDED', 409, '该主单审批已处理，不能撤回。');
      if (approvalReviewContentVersion(approval) !== input.reviewContentVersion)
        throw new OrderMainApprovalError('ORDER_APPROVAL_CONTENT_CHANGED', 409, '审批内容已变化，请重新加载后再撤回。');
      if (order.status !== 'Pending') throw new OrderMainApprovalError('ORDER_NOT_DRAFT', 409, '订单已非草稿，不能撤回。');
      const changed = await tx.approvalRequest.updateMany({ where: { id: approval.id, status: 'pending' }, data: {
        status: 'cancelled', decidedAt: new Date(), decisionNote: `撤回原因：${reason}` } });
      if (changed.count !== 1) throw new OrderMainApprovalError('APPROVAL_ALREADY_DECIDED', 409, '该主单审批已处理，不能撤回。');
      const commandAck = { schemaVersion: 1, operation: 'withdraw_order_main_approval', requestKey: input.requestKey,
        approvalId: approval.id, orderId: order.id, status: 'cancelled', actorId: actor.userId, reason, commandHash,
        reviewContentVersion: input.reviewContentVersion };
      await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'api:order-main-approval', operation: 'withdraw_order_main_approval',
        targetType: 'ApprovalRequest', targetId: approval.id, before: { status: 'pending' },
        after: { status: 'cancelled', orderId: order.id, requestKey: input.requestKey, commandHash, reason, withdrawnBy: actor.userId, commandAck } });
      return { ok: true, item: await tx.approvalRequest.findUnique({ where: { id: approval.id } }), commandAck, replayed: false };
    }, { isolationLevel: 'Serializable' }); }
    catch (error) { if (isOrderLineStorageConflict(error)) throw new OrderMainApprovalError('ORDER_APPROVAL_CONFLICT', 409, '审批正在被处理，请使用原请求重试撤回或读回实际结果。'); throw error; }
  }

  const readAccess = (tx: any, approval: any, actor: TokenPayload) => readOrderMainApprovalAccess(tx, approval, actor, resolveEligibleReviewerIds);
  return { submit, decide, withdraw, readAccess, resolveEligibleReviewerIds, listAuthorityConfig, replaceAuthorityConfig, listHistory };
}
