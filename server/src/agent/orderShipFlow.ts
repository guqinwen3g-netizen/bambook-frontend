import type { TokenPayload } from '../auth/service';
/**
 * ERP-P1-order-ship-agent-flow-contract
 *
 * order.ship draft→approval→commit 最小闭环契约。
 * what-you-approve-is-what-you-commit：commit 从 subOperations.after 恢复，不藏额外字段。
 * 复用已 merged 的 linkOrderStatusFromShipment + syncShipmentReferences + validateStatusTransition。
 */

import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { validateStatusTransition } from '../statusTransition';
import { createShipment } from '../shipping/shipmentMutationService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type OrderShipErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_TERMINAL'
  | 'INVALID_CURRENT_ORDER_STATUS'
  | 'INVALID_SHIPMENT_STATUS'
  | 'COMMIT_TRANSACTION_FAILED'
  | 'UNKNOWN_ERROR';

export interface OrderShipError {
  code: OrderShipErrorCode;
  message: string;
  userAction: string;
  details?: string[];
}

export interface OrderShipCommitted {
  status: 'committed';
  shipmentId: string;
  orderId: string;
  shipmentStatus: string;
  orderStatus: string | null;
  transactionId: string;
  auditId: string;
  idempotencyKey: string;
}

export type OrderShipFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | OrderShipCommitted
  | { status: 'failed'; error: OrderShipError; approvalId?: string };

export function buildOrderShipError(code: OrderShipErrorCode, message: string, details?: string[]): OrderShipError {
  const userActionMap: Record<OrderShipErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起发货流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '发货 draft 语义校验失败，请检查 shipment 配置',
    ORDER_NOT_FOUND: '检查订单 ID 是否存在',
    ORDER_TERMINAL: '订单处于终态，不可变更',
    INVALID_CURRENT_ORDER_STATUS: '订单当前状态非法，请修正后重试',
    INVALID_SHIPMENT_STATUS: '运单 status 非法，必须为合法枚举',
    COMMIT_TRANSACTION_FAILED: '事务失败已回滚，请重试',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code], details };
}

// ── Draft 构建（严格六字段 ProcessDraft，不藏额外字段） ──

export interface OrderShipDraftInput {
  orderId: string;
  shipment: {
    shipmentNumber: string;
    type?: string;
    shippingMethod: string;
    status?: string;
    [key: string]: any;
  };
}

/**
 * 构建 order.ship 的 ProcessDraft。
 * shipment 完整字段编码进 subOperations.after（what-you-approve-is-what-you-commit）。
 */
export function buildOrderShipDraft(input: OrderShipDraftInput): ProcessDraft {
  const { orderId, shipment } = input;
  const shipmentStatus = shipment.status ?? 'Booked';

  // after 含 commit 所需全部信息（orderId + shipment 完整字段 + shipmentStatus）
  const afterPayload = { ...shipment, orderId, shipmentStatus };

  const subOperations: SubOperation[] = [{
    toolId: 'shipping.create_shipment',
    entityId: orderId,
    action: 'create_shipment_and_link_order',
    before: { orderId },
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'orders',
    entityId: orderId,
    field: 'shipment',
    before: null,
    after: { shipmentNumber: shipment.shipmentNumber, shipmentStatus },
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['shipping', 'orders'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `order.ship:${orderId}:${hash}`;

  return { ...content, idempotencyKey };
}

/** 从 subOperations.after 恢复 commit payload（what-you-approve-is-what-you-commit） */
export function recoverShipmentPayloadFromDraft(draft: ProcessDraft): { orderId: string; shipment: Record<string, any>; shipmentStatus: string } | null {
  const sub = draft.subOperations?.[0];
  if (!sub?.after) return null;
  const after = sub.after as any;
  const orderId = after.orderId;
  const shipmentStatus = after.shipmentStatus || 'Booked';
  // after 含完整 shipment 字段（draft 构建时编码）
  const { orderId: _o, shipmentStatus: _s, ...shipmentFields } = after;
  return { orderId, shipment: shipmentFields, shipmentStatus };
}

export function validateOrderShipDraftSemantics(draft: any): { ok: boolean; error?: OrderShipError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildOrderShipError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const sub = draft.subOperations[0];
  const after = sub.after as any;
  if (!after?.orderId || !after?.shipmentNumber || !after?.shippingMethod) {
    return { ok: false, error: buildOrderShipError('SEMANTIC_VALIDATION_FAILED', 'draft must contain orderId, shipmentNumber, shippingMethod in subOperations.after') };
  }
  const shipmentStatus = after.shipmentStatus || 'Booked';
  const t = validateStatusTransition('Shipment', shipmentStatus, shipmentStatus);
  if (!t.ok) {
    return { ok: false, error: buildOrderShipError('INVALID_SHIPMENT_STATUS', t.message!) };
  }
  return { ok: true };
}

export function verifyOrderShipDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

// ── Commit（从 subOperations.after 恢复，复用 linkOrderStatusFromShipment + sync） ──

export interface OrderShipCommitParams {
  /** ★ B58：审批请求人，由 `toolDispatchRegistry` 注入；缺省落 'system'（AuditLog.actorId 有外键） */
  actorId?: string;
  trustedActor?: TokenPayload;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
}

export async function commitOrderShip(
  params: OrderShipCommitParams,
): Promise<{ ok: true; feedback: OrderShipCommitted } | { ok: false; feedback: { status: 'failed'; error: OrderShipError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderShipError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyOrderShipDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderShipError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateOrderShipDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  // 从 subOperations.after 恢复（what-you-approve-is-what-you-commit）
  const recovered = recoverShipmentPayloadFromDraft(draft);
  if (!recovered) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderShipError('PROCESS_DRAFT_MISSING', 'cannot recover shipment payload from draft'), approvalId } };
  }

  const transactionId = `os_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 提前校验 shipmentStatus 枚举（旧行为：validateStatusTransition 自转移，等价于枚举合法性）
  const { orderId, shipment, shipmentStatus } = recovered;
  const stCheck = validateStatusTransition('Shipment', shipmentStatus, shipmentStatus);
  if (!stCheck.ok) {
    return {
      ok: false,
      feedback: { status: 'failed', error: buildOrderShipError('INVALID_SHIPMENT_STATUS', stCheck.message!), approvalId },
    };
  }

  // task ERP-P1-shipping-mutation-shared-service-foundation: 复用 createShipment service，
  // Agent path 与 route path 走同一事务契约，不再手写 tx.shipment.create/sync/link/audit 平行事务。
  // what-you-approve-is-what-you-commit：input 从 subOperations.after 恢复，未加额外字段。
  const svcResult = await createShipment({
    prisma,
    input: { ...shipment, orderId, status: shipmentStatus },
    actorId: auditActorFrom(params),
    ...(params.trustedActor ? { actor: params.trustedActor } : {}),
    auditSource: 'agent:order.ship:commit',
    auditOperation: 'order_ship_committed',
    syncSource: 'agent:order.ship',
    generateIdIfMissing: true,
    transactionId,
    auditAfterBuilder: (sh: any, extras) => ({
      shipmentId: sh.id,
      orderId,
      shipmentStatus: sh.status,
      orderStatus: extras.orderStatus,
      transactionId: extras.transactionId,
    }),
  });

  if (!svcResult.ok) {
    const raw = svcResult.error!.code;
    const code: OrderShipErrorCode =
      raw === 'ORDER_NOT_FOUND' ? 'ORDER_NOT_FOUND'
      : raw === 'ORDER_TERMINAL' ? 'ORDER_TERMINAL'
      : raw === 'INVALID_CURRENT_ORDER_STATUS' ? 'INVALID_CURRENT_ORDER_STATUS'
      : raw === 'INVALID_SHIPMENT_STATUS' || raw === 'INVALID_INITIAL_STATUS' ? 'INVALID_SHIPMENT_STATUS'
      : 'COMMIT_TRANSACTION_FAILED';
    return {
      ok: false,
      feedback: { status: 'failed', error: buildOrderShipError(code, svcResult.error!.message), approvalId },
    };
  }

  const { shipment: sh, orderStatus, auditId } = svcResult.data!;
  return {
    ok: true,
    feedback: {
      status: 'committed',
      shipmentId: sh.id,
      orderId,
      shipmentStatus: sh.status,
      orderStatus: orderStatus || null,
      transactionId,
      auditId,
      idempotencyKey: draft.idempotencyKey,
    },
  };
}
