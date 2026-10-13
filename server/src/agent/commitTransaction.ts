/**
 * P1-A ProcessDraft 语义校验：防止 shape/hash 正确但语义降级的 draft 通过。
 * order.confirm 必须是 status(Pending->Confirmed) + invoice(Issued) + audit 的固定流程。
 * 缺任何一项 fail closed，不进入 $transaction。
 */
export function validateProcessDraftSemantics(draft: ProcessDraft): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. orders.update_status 必须存在，before.status === Pending，after.status === Confirmed
  const updateStatusOp = draft.subOperations.find(op => op.toolId === 'orders.update_status');
  if (!updateStatusOp) {
    errors.push('MISSING_ORDERS_UPDATE_STATUS');
  } else {
    if (String(updateStatusOp.before.status || '') !== 'Pending') {
      errors.push(`STATUS_BEFORE_NOT_PENDING(actual=${updateStatusOp.before.status})`);
    }
    if (String(updateStatusOp.after.status || '') !== 'Confirmed') {
      errors.push(`STATUS_AFTER_NOT_CONFIRMED(actual=${updateStatusOp.after.status})`);
    }
  }

  // 2. finance.create_invoice 必须存在，字段完整且语义正确
  const invoiceOp = draft.subOperations.find(op => op.toolId === 'finance.create_invoice');
  if (!invoiceOp) {
    errors.push('MISSING_FINANCE_CREATE_INVOICE');
  } else {
    if (String(invoiceOp.after.status || '') !== 'Issued') {
      errors.push(`INVOICE_STATUS_NOT_ISSUED(actual=${invoiceOp.after.status})`);
    }
    if (String(invoiceOp.after.type || '') !== 'Receivable') {
      errors.push(`INVOICE_TYPE_NOT_RECEIVABLE(actual=${invoiceOp.after.type})`);
    }
    if (!(Number(invoiceOp.after.amount) > 0)) {
      errors.push(`INVOICE_AMOUNT_INVALID(actual=${invoiceOp.after.amount})`);
    }
    if (!String(invoiceOp.after.currency || '')) {
      errors.push('INVOICE_CURRENCY_MISSING');
    }
    if (!String(invoiceOp.after.customerRelationId || '')) {
      errors.push('INVOICE_CUSTOMER_RELATION_MISSING');
    }
    if (!String(invoiceOp.after.orderId || '')) {
      errors.push('INVOICE_ORDER_ID_MISSING');
    }
  }

  // 3. impactScope 必须含 orders + invoices，postCommitHooks 必须为空
  if (!draft.impactScope.includes('orders')) errors.push('IMPACT_SCOPE_MISSING_ORDERS');
  if (!draft.impactScope.includes('invoices')) errors.push('IMPACT_SCOPE_MISSING_INVOICES');
  if (draft.postCommitHooks.length > 0) errors.push('POST_COMMIT_HOOKS_NOT_EMPTY');

  return { ok: errors.length === 0, errors };
}

/**
 * P1-A commitTransaction 引擎：order.confirm 从 ProcessDraft 到审批后事务提交闭环。
 *
 * 职责：
 * 1. 从 ApprovalRequest.payload 恢复已审批的 ProcessDraft（what-you-approve-is-what-you-commit）
 * 2. hash 校验：恢复的 draft idempotencyKey 必须与重新计算的 hash 一致（防篡改）
 * 3. Prisma $transaction 原子提交：订单状态 Confirmed + Invoice(Issued) + AuditLog
 * 4. fail-closed：draft 缺失/hash 不匹配/preconditions 失败/事务失败均抛错，不留部分主数据
 *
 * P1-A scope：
 * - entity reference sync（syncInvoiceReferences）在 $transaction 内执行，失败全回滚
 * - email/EmailQueue 明确排除（postCommitHooks 为空）
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { buildInvoiceReferenceOps } from '../entities/sync';
import {
  evaluateOrderConfirmGates,
  type CreditExceptionPass,
} from '../orders/orderLifecycleService';
import { consumeCreditException, CreditExceptionConsumptionError } from '../credit/creditExceptionGate';
import { decideLcGate, LC_INVOICE_ISSUE_ACTION } from '../customs/lcGate';
import { auditActorFrom } from '../audit/routeAudit';
import { lookupErrorCode } from '../shared/errorCodes';
import { resolveOrderId } from '../orders/orderIdentity';
import {
  type ProcessDraft,
  computeProcessDraftHash,
  validateProcessDraft,
} from './toolRegistry';
import { buildOrderConfirmError, buildOrderConfirmGateError, type EntityLinkRecord, type OrderConfirmError } from './feedbackContract';
import { todayLocalKey } from '../shared/localDate';


// A private discriminant marks only refusals produced by this transaction.
// Unknown storage errors, even with similar text, cannot supply public copy.
const COMMIT_REFUSAL = Symbol('order-confirm-business-refusal');
const COMMIT_REFUSAL_COPY = {
  ORDER_NOT_FOUND: '订单不存在或已删除，请核对订单后重新办理。',
  STATUS_DRIFT: '订单状态已变化，请刷新后重新确认。',
  ORDER_MAIN_APPROVAL_REQUIRED: '请先在订单主单提交业务审批；代理流程审批不能代替订单主单审批，也不能自动开票。',
  INVOICE_AMOUNT_INVALID: '发票金额必须为正数，请先核对订单金额。',
  INVOICE_CURRENCY_MISSING: '发票币种未填写，请先完善订单币种。',
} as const;
function rejectOrderConfirm(code: keyof typeof COMMIT_REFUSAL_COPY): never {
  throw Object.assign(new Error(COMMIT_REFUSAL_COPY[code]), { [COMMIT_REFUSAL]: code });
}

/** commitTransaction 结果（P1-C 结构化 feedback contract） */
export interface CommitResult {
  ok: boolean;
  committed: boolean;
  orderId?: string;
  poNumber?: string;
  previousStatus?: string;
  newStatus?: string;
  transactionId?: string;
  // P1-C: commit 成功结构化字段
  invoiceId?: string;
  invoiceNumber?: string;
  amount?: number;
  currency?: string;
  customerRelationId?: string;
  customerName?: string;
  auditId?: string;
  idempotencyKey?: string;
  entityLinks?: EntityLinkRecord[];
  postCommitQueue?: Array<{
    type: 'email' | 'sms' | 'webhook' | 'notification';
    status: 'queued';
    payload: Record<string, unknown>;
  }>;
  error?: string;
  // P1-C: 统一 errorFeedback envelope（与 buildOrderConfirmError 字段一致）
  //   B50-1b 起直接复用契约类型（而不是重抄一份字段表）：门禁阻断要带 gateCode/approvalRequestId，
  //   两处各写一份字段清单 = 第二套真源，加字段时必然只改一处。
  errorFeedback?: OrderConfirmError & { retryable: boolean };
  audit?: {
    approvalId: string;
    idempotencyKey: string;
    subOperationsSummary: string[];
    impactScope: string[];
  };
}

/**
 * 从 ApprovalRequest.payload 恢复 ProcessDraft。
 * payload.processDraft 是审批时写入的 draft 快照。
 */
export function recoverProcessDraftFromPayload(
  payload: Record<string, unknown> | null,
): ProcessDraft | null {
  if (!payload) return null;
  const draft = (payload as any).processDraft;
  if (!draft || typeof draft !== 'object') return null;
  const validation = validateProcessDraft(draft as ProcessDraft);
  if (!validation.ok) return null;
  return draft as ProcessDraft;
}

/**
 * 校验恢复的 ProcessDraft 的 idempotencyKey 与重新计算的 hash 一致。
 * 防篡改：任何字段被修改都会导致 hash 不匹配，fail-closed。
 */
export function verifyProcessDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  // 重算 draft 内容（去掉 idempotencyKey）的 canonical hash，比对 idempotencyKey 里的 hash 部分
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content); // 格式 pd:xxxx
  // 提取原 idempotencyKey 里的 hash 部分（支持 "order.confirm:PO-001:pd:xxxx" 或 "pd:xxxx"）
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return {
    ok: recomputedHash === actualHashPart,
    expected: recomputedHash,
    actual: actualHashPart,
  };
}

/**
 * P1-A commitTransaction：Prisma $transaction 原子提交 order.confirm。
 *
 * 步骤：
 * 1. 从 approval payload 恢复 draft（必须存在）
 * 2. hash 校验（防篡改）
 * 3. 找到 update_status subOperation，事务化更新订单状态
 * 4. postCommitHooks 转 queue intent（不外发）
 * 5. 返回审计摘要
 *
 * 失败语义：任何步骤失败抛错，Prisma $transaction 自动回滚，不留部分主数据。
 */
export async function commitOrderConfirm(params: {
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: Record<string, unknown> | null;
  /** ★ B58：由 `registerCommitTool` 注入的审批请求人（真实账号）；直接调用本函数而未传 ⇒ 落 'system' */
  actorId?: string;
}): Promise<CommitResult> {
  const { prisma, approvalId, approvalPayload } = params;

  // 1. 恢复 draft
  const draft = recoverProcessDraftFromPayload(approvalPayload);
  if (!draft) {
    return {
      ok: false,
      committed: false,
      error: 'COMMIT_FAILED: process draft missing or invalid in approval payload',
      errorFeedback: { ...buildOrderConfirmError('no approved process draft'), retryable: false },
    };
  }

  // 2. ProcessDraft 语义校验（业务规则，优先于 hash 防篡改）
  // 防止 shape 正确但语义降级的 draft（如缺 invoice、状态非 Pending->Confirmed）通过
  const semanticValidation = validateProcessDraftSemantics(draft);
  if (!semanticValidation.ok) {
    return {
      ok: false,
      committed: false,
      error: `COMMIT_FAILED: ProcessDraft semantic validation failed: ${semanticValidation.errors.join(', ')}`,
      errorFeedback: { ...buildOrderConfirmError('semantic validation failed', semanticValidation.errors), retryable: false },
      audit: {
        approvalId,
        idempotencyKey: draft.idempotencyKey,
        subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`),
        impactScope: draft.impactScope,
      },
    };
  }

  // 3. hash 校验（防篡改，第二道防线）
  const hashCheck = verifyProcessDraftHash(draft);
  if (!hashCheck.ok) {
    return {
      ok: false,
      committed: false,
      error: `COMMIT_FAILED: process draft hash mismatch (expected ${hashCheck.expected}, got ${hashCheck.actual})`,
      errorFeedback: { ...buildOrderConfirmError('hash mismatch'), retryable: false },
      audit: {
        approvalId,
        idempotencyKey: draft.idempotencyKey,
        subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`),
        impactScope: draft.impactScope,
      },
    };
  }

  // 4. 找到 update_status subOperation（semantic validation 已保证存在）
  const updateStatusOp = draft.subOperations.find(op => op.toolId === 'orders.update_status')!;

  const poNumber = String(updateStatusOp.before.poNumber ?? updateStatusOp.entityId);
  const exactOrderId = typeof updateStatusOp.before.orderId === 'string' ? updateStatusOp.before.orderId : undefined;
  const newStatus = String(updateStatusOp.after.status || '');
  const previousStatus = String(updateStatusOp.before.status || '');

  // ★ B58：身份的唯一来源 = registry 注入的 `ctx.actorId`（= `ApprovalRequest.requesterId`，该列 NOT NULL 且有 UserAccount 外键）。
  //   原来这里自己再查一遍 approval 拿 requesterId ⇒ 同一个取值两处实现（本仓头号病），且 registry 已经查过。
  //   取不到（不经 registry 直接调本函数）才落 SYSTEM_AUDIT_ACTOR：`AuditLog.actorId` 有外键 → `UserAccount(id)`
  //   （真库 pg_constraint 实测），而 'unknown' / 'agent' 在库里**没有账号行** ⇒ 写进去就是 P2003 整笔回滚，
  //   表现成"数据库错误"、真相是身份写错（§9 B50-1a 复核 / B58 这一族）。
  const auditActorId = auditActorFrom(params);

  // 4. Prisma $transaction 原子提交
  let creditExceptionPass: CreditExceptionPass | null = null;
  try {
    const transactionId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ts = Date.now();

    // P1-A 真实口径：status + invoice(Issued) + AuditLog 全部在 $transaction 内收口
    const invoiceOp = draft.subOperations.find(op => op.toolId === 'finance.create_invoice');

    // ★ B50-1b：进入 Confirmed 的业务门禁（信用 + MOQ + L/C），与 `transitionOrderStatus` **同一份实现**。
    //
    // 为什么这里是整条链上最后一个漏口：`order.confirm` 是"审批 → 提交"两段式，提交段在自己的
    //   `$transaction` 里直接 `order.update`（本文件下一段），既不走引擎也不走门禁 ⇒ 审批一过，
    //   Frozen 客户 / 低于 MOQ / 无信用证的订单都会被确认，而 §9 记的这些控制全部只写在引擎里。
    //   接不回引擎（Prisma 不许嵌套交互事务）⇒ 把**判定**抽成共用函数，本路径在写之前调它。
    //
    // 为什么必须在事务**之前**（而不是塞进 tx 里"更严格"）：信用与 MOQ 两道门禁在阻断时会
    //   **自动发起豁免审批单**（DR-013 / DR-007）。放进事务里 = 阻断即回滚 = 审批单也跟着没了，
    //   而返回给用户的消息写着"豁免审批单 X 已自动发起，审批通过后重试"——那就是一句假话，
    //   且用户照做会找不到那张单。L/C 门禁纯读，所以下面开票腿那一道放在事务内（判完即写不留竞态）。
    //
    // 订单查不到 / 已软删时**不在这里造第二个"不存在"错误**：让下面的事务按既有语义抛
    //   ORDER_NOT_FOUND 并回滚（同一句判据只留一份出口）。
    const resolvedOrderId = await resolveOrderId(prisma, exactOrderId ? { orderId: exactOrderId } : updateStatusOp.entityId);
    const gateAnchor = resolvedOrderId ? await prisma.order.findFirst({
      where: { id: resolvedOrderId, deletedAt: null },
      select: { id: true, deletedAt: true },
    }) : null;
    if (gateAnchor && !gateAnchor.deletedAt) {
      if (!await prisma.approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: gateAnchor.id, status: 'approved' }, select: { id: true } })) {
        rejectOrderConfirm('ORDER_MAIN_APPROVAL_REQUIRED');
      }
      const gates = await evaluateOrderConfirmGates({
        prisma,
        orderId: gateAnchor.id,
        actorId: auditActorId,
        operator: 'agent',
        logScope: 'agent:order.confirm:commit',
      });
      if (!gates.allowed) {
        const feedback = buildOrderConfirmGateError({
          gateCode: gates.error.code,
          userMessage: gates.error.message,
          approvalRequestId: gates.error.approvalRequestId,
        });
        return {
          ok: false,
          committed: false,
          poNumber,
          previousStatus,
          newStatus,
          error: feedback.message,
          errorFeedback: { ...feedback, retryable: false },
          audit: {
            approvalId,
            idempotencyKey: draft.idempotencyKey,
            subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`),
            impactScope: draft.impactScope,
          },
        };
      }
      creditExceptionPass = gates.creditExceptionPass;
    }

    let invoiceId = '';
    let invoiceNumber = '';
    let invAmount = 0;
    let invCurrency = '';
    const committedResult = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // The receipt is written in the same transaction as domain changes. A concurrent
      // replay can therefore never create a second order transition or invoice.
      await (tx as any).agentCommitReceipt.create({
        data: {
          id: `acr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          idempotencyKey: draft.idempotencyKey,
          toolId: 'order.confirm',
          approvalId,
          status: 'committing',
        },
      });
      const order = resolvedOrderId ? await tx.order.findFirst({
        where: { id: resolvedOrderId, deletedAt: null },
        select: { id: true, poNumber: true, status: true, deletedAt: true },
      }) : null;
      if (!order || order.deletedAt) {
        rejectOrderConfirm('ORDER_NOT_FOUND');
      }
      if (order.status !== previousStatus) {
        rejectOrderConfirm('STATUS_DRIFT');
      }
      if (!await tx.approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: order.id, status: 'approved' }, select: { id: true } })) rejectOrderConfirm('ORDER_MAIN_APPROVAL_REQUIRED');
      const realOrderId = order.id;

      // ★ B50-1b 开票腿：L/C 门禁（stage=invoice:issue）。与 `invoiceMutationService` 调的是
      //   **同一个函数、同一个 action 常量、同一份文案形状** ⇒ 两条开票路径的条款判定不许各说各话。
      //   位置在**主数据那几笔写之前**（状态、流转记录、票都还没动；只有幂等回执在本函数一进来就落了，
      //   它是"这笔请求进来过"的凭证，不参与业务主数据）：抛出即整笔回滚 ⇒ 票没建、状态没改、流转记录没落。
      //   放在主数据写之后虽然 DB 语义等价（同一事务），但 mock 里就证不了"零主数据写入"。
      //   只卡应收方向（付供应商的款与客户信用证无关），与开票主路径同一条件。
      //   ⚠️ `order` 这个参数这里必须**不传**（由门禁自己按 orderId 查）：传 `null` 在它的契约里
      //   表示"调用方已确认订单不存在 ⇒ 本门禁不适用"，那会变成放行 —— 一个字母的 fail-open。
      const invoiceType = String(invoiceOp?.after.type || 'Receivable');
      if (invoiceOp && invoiceType === 'Receivable') {
        const lcInvoice = await decideLcGate({
          prisma: tx,
          orderId: realOrderId,
          stage: 'invoice:issue',
          exceptionAction: LC_INVOICE_ISSUE_ACTION,
        });
        if (!lcInvoice.allowed) {
          throw Object.assign(
            new Error(
              lcInvoice.code === 'LC_EXCEPTION_CHECK_FAILED'
                ? `信用证门禁未通过（${lcInvoice.reasons.join(', ')}${lcInvoice.lcLabel ? `；信用证 ${lcInvoice.lcLabel}` : ''}），且无法确认是否已有 DR-013 例外 ⇒ 保持阻断，请先排查例外/审批服务`
                : `该订单以信用证结算，但${lcInvoice.lcLabel ? `信用证 ${lcInvoice.lcLabel} 不满足条款` : '尚未登记信用证'}（${lcInvoice.reasons.join(', ')}）；请先登记/核对 L/C，确需例外按 DR-013 申请（action='${LC_INVOICE_ISSUE_ACTION}'）`,
            ),
            // ★ `statusCode` 只能**查注册表真源**（同 `finance/invoiceMutationService.ts:408`）：
            //   抛点缺 statusCode 会被 `businessThrowShapeRatchet`（B34）计成新的欠债站点，
            //   而"这里不写档位、让路由去猜"正是同一枚码在不同出口拿到不同档的成因。
            { code: lcInvoice.code, statusCode: lookupErrorCode(lcInvoice.code)?.status ?? 500, lcGateBlock: true, gateCode: lcInvoice.code },
          );
        }
      }

      // 1. 创建状态流转记录
      await tx.orderStatusTransition.create({
        data: {
          id: `ST-${realOrderId}-${ts}`,
          orderId: realOrderId,
          fromStatus: previousStatus,
          toStatus: newStatus,
          note: `order.confirm commitTransaction (approvalId=${approvalId}, idempotencyKey=${draft.idempotencyKey})`,
          operator: 'agent',
          createdAt: BigInt(ts),
        },
      });

      // 2. 更新订单状态
      await tx.order.update({
        where: { id: realOrderId },
        data: { status: newStatus, updatedAt: BigInt(ts) },
      });

      // 3. P1-A：事务内创建 Invoice(status=Issued)，用已审批 ProcessDraft 的 snapshot 字段
      // amount/currency/customer 来自 draftPhase 读取的订单快照（不硬编码）
      if (invoiceOp) {
        invoiceId = `INV__${poNumber.replace(/[^a-zA-Z0-9]/g, '_')}_${ts}`;
        invoiceNumber = `INV-${todayLocalKey().replace(/-/g, '')}-${String(ts).slice(-6)}`;
        const issueDate = todayLocalKey();
        invAmount = Number(invoiceOp.after.amount);
        invCurrency = String(invoiceOp.after.currency || '');
        if (!(invAmount > 0)) {
          rejectOrderConfirm('INVOICE_AMOUNT_INVALID');
        }
        if (!invCurrency) {
          // P1-A: currency 缺失 fail closed（ProcessDraft 应完整，不引入 CNY fallback）
          rejectOrderConfirm('INVOICE_CURRENCY_MISSING');
        }
        await tx.invoice.create({
          data: {
            id: invoiceId,
            invoiceNumber,
            type: String(invoiceOp.after.type || 'Receivable'),
            status: 'Issued',
            amount: invAmount,
            currency: invCurrency,
            issueDate,
            orderId: realOrderId,
            customerRelationId: String(invoiceOp.after.customerRelationId || '') || null,
            customerName: String(invoiceOp.after.customerName || '') || null,
            notes: `order.confirm commitTransaction (transactionId=${transactionId}, lineCount=${invoiceOp.after.lineCount || 0})`,
            createdAt: BigInt(ts),
            updatedAt: BigInt(ts),
          },
        });
        // P1-A: 事务内同步 entity reference/link（aboutOrder + billTo 两维度），失败全回滚
        // 复用 sync.ts 的 buildInvoiceReferenceOps（与 syncInvoiceReferences 等价，但不嵌套 $transaction）
        const createdInvoice = {
          id: invoiceId, invoiceNumber,
          orderId: realOrderId,
          customerRelationId: String(invoiceOp.after.customerRelationId || '') || null,
          customerName: String(invoiceOp.after.customerName || '') || null,
        };
        const syncOps = buildInvoiceReferenceOps(tx as any, createdInvoice as any, {
          source: 'agent:order_confirm_commit',
          now: () => ts,
        });
        // 逐个 await（已在同一 tx 内，失败会让事务回滚）
        for (const op of syncOps) {
          await op;
        }
      }

      // 4. AuditLog：审计是事务闭环的一部分，失败必须让事务回滚（不再 catch non-fatal）
      await tx.auditLog.create({
        data: {
          id: `audit_commit_${transactionId}`,
          actorId: auditActorId,
          action: 'order_confirm_committed',
          targetType: 'orders',
          targetId: realOrderId,
          detail: {
            transactionId,
            approvalId,
            idempotencyKey: draft.idempotencyKey,
            poNumber,
            previousStatus,
            newStatus,
            invoiceCreated: !!invoiceOp,
            subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`),
            impactScope: draft.impactScope,
            irreversible: draft.irreversible,
          } as any,
        },
      });

      if (creditExceptionPass) {
        await consumeCreditException({
          exceptionService: creditExceptionPass.service, exceptionId: creditExceptionPass.exception.id,
          scope: creditExceptionPass.scope, actorId: auditActorId, tx,
          note: `订单 ${poNumber} 经 agent 审批提交确认（Confirmed），由信用例外 ${creditExceptionPass.exception.exceptionNumber} 放行`,
        });
      }

      const auditId = `audit_commit_${transactionId}`;
      const entityLinks: EntityLinkRecord[] = [
        { linkKind: 'aboutOrder', fromType: 'invoice', fromId: invoiceId, toType: 'order', toId: realOrderId },
      ];
      if (invoiceOp && String(invoiceOp.after.customerRelationId || '')) {
        entityLinks.push({
          linkKind: 'billTo', fromType: 'invoice', fromId: invoiceId,
          toType: 'relation.organization', toId: String(invoiceOp.after.customerRelationId),
        });
      }
      const result: CommitResult = {
        ok: true,
        committed: true,
        orderId: realOrderId,
        poNumber,
        previousStatus,
        newStatus,
        transactionId,
        invoiceId,
        invoiceNumber,
        amount: invAmount,
        currency: invCurrency,
        customerRelationId: String(invoiceOp?.after.customerRelationId || ''),
        customerName: String(invoiceOp?.after.customerName || ''),
        auditId,
        idempotencyKey: draft.idempotencyKey,
        entityLinks,
        postCommitQueue: [],
        audit: {
          approvalId,
          idempotencyKey: draft.idempotencyKey,
          subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`),
          impactScope: draft.impactScope,
        },
      };
      await (tx as any).agentCommitReceipt.update({
        where: { idempotencyKey: draft.idempotencyKey },
        data: { status: 'committed', result: result as any, completedAt: new Date() },
      });
      return result;
    }, {
      // Phase 2 · 2.2 并发根因修复：STATUS_DRIFT check-then-act 在 READ COMMITTED 下
      // 存在并发双确认窗口（两审批并发确认同一订单可双双看到 previousStatus → 双发票）。
      // Serializable 让 SSI 中止其中一方（P2034），下方映射为可重试冲突。
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    return committedResult;
  } catch (error: any) {
    if (error instanceof CreditExceptionConsumptionError) {
      return {
        ok: false, committed: false, poNumber,
        error: `${error.code}: ${error.message}`,
        errorFeedback: { ...buildOrderConfirmGateError({ gateCode: error.code,
          userMessage: '信用例外核销未完成，订单确认事务已回滚。请核对例外范围、有效期和可用次数。' }), retryable: error.statusCode >= 500 },
        audit: { approvalId, idempotencyKey: draft.idempotencyKey,
          subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`), impactScope: draft.impactScope },
      };
    }
    // ★ 开票腿被 L/C 门禁挡住：这是一次**业务拒绝**，不是"数据库错误"。不许塌进下面那条
    //   COMMIT_TRANSACTION_FAILED（那句 userAction 是"请稍后重试或联系管理员"⇒ 业务员会反复
    //   重试一张永远开不出的票）。整笔事务已回滚：票没建、状态没改。
    if (error?.lcGateBlock) {
      const message = `LC_GATE_BLOCKED: ${String(error?.message ?? '')}`;
      const feedback = buildOrderConfirmError(
        error?.gateCode === 'LC_EXCEPTION_CHECK_FAILED' ? `LC_EXCEPTION_CHECK_FAILED: ${String(error?.message ?? '')}` : message,
      );
      return {
        ok: false,
        committed: false,
        poNumber,
        error: feedback.message,
        errorFeedback: { ...feedback, retryable: false, gateCode: String(error?.gateCode ?? '') },
        audit: {
          approvalId,
          idempotencyKey: draft.idempotencyKey,
          subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`),
          impactScope: draft.impactScope,
        },
      };
    }
    const refusal: keyof typeof COMMIT_REFUSAL_COPY | undefined = error?.[COMMIT_REFUSAL];
    if (refusal && Object.prototype.hasOwnProperty.call(COMMIT_REFUSAL_COPY, refusal)) {
      const publicCopy = `${refusal}: ${COMMIT_REFUSAL_COPY[refusal]}`;
      const feedback = buildOrderConfirmError(publicCopy);
      return { ok: false, committed: false, poNumber, error: publicCopy,
        errorFeedback: { ...feedback, retryable: false }, audit: { approvalId, idempotencyKey: draft.idempotencyKey,
          subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`), impactScope: draft.impactScope } };
    }
    if (error?.code === 'P2002') {
      const receipt = await (prisma as any).agentCommitReceipt?.findUnique?.({
        where: { idempotencyKey: draft.idempotencyKey },
      }).catch(() => null);
      if (receipt?.status === 'committed' && receipt.result && typeof receipt.result === 'object') {
        return receipt.result as CommitResult;
      }
    }
    logger.error('[order-confirm] transaction did not commit', {
      approvalId, errorCode: error?.code, errorName: error?.name,
    });
    // P2034 序列化冲突/死锁中止：瞬态并发冲突，已安全回滚，调用方可重试
    if (error?.code === 'P2034') {
      return {
        ok: false,
        committed: false,
        poNumber,
        error: 'COMMIT_CONFLICT: 并发提交发生冲突，操作已回滚，请使用原请求重试。',
        errorFeedback: { ...buildOrderConfirmError(`COMMIT_CONFLICT: concurrent commit conflict, safely rolled back — retry`), retryable: true },
        audit: {
          approvalId,
          idempotencyKey: draft.idempotencyKey,
          subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`),
          impactScope: draft.impactScope,
        },
      };
    }
    // fail-closed：事务失败已自动回滚，不留部分主数据
    return {
      ok: false,
      committed: false,
      poNumber,
      error: 'COMMIT_TRANSACTION_FAILED: 订单确认未完成，本次操作已回滚，请核对原请求后重试。',
      errorFeedback: { ...buildOrderConfirmError('COMMIT_TRANSACTION_FAILED: 订单确认事务失败。'), retryable: false },
      audit: {
        approvalId,
        idempotencyKey: draft.idempotencyKey,
        subOperationsSummary: draft.subOperations.map(s => `${s.toolId}:${s.action}`),
        impactScope: draft.impactScope,
      },
    };
  }
}
