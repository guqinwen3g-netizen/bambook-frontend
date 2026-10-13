/**
 * P1-C-backend: order.confirm result feedback contract
 *
 * 定义 order.confirm 工具运行后的统一反馈结构，供 agentLoop tool_call_end/block_patch
 * 携带结构化 outputPreview/errorPreview，前端审批卡 + 结果展示消费。
 *
 * 三态：approval_required / committed / failed
 * scope: 不含 email/postCommitHook（P1-A 基准保持）
 */

import type { ProcessDraft } from './toolRegistry';

/** fail-closed 稳定错误码（业务语义，不随实现变化） */
export type OrderConfirmErrorCode =
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_ID_MISSING'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'PRECONDITIONS_FAILED'
  | 'ORDER_NOT_FOUND'
  | 'STATUS_DRIFT'
  | 'INVOICE_AMOUNT_INVALID'
  | 'INVOICE_CURRENCY_MISSING'
  // ★ B50-1b：确认门禁（信用/MOQ/L-C）在审批提交路径上的阻断。
  //   `CONFIRM_GATE_BLOCKED` 是**契约层**的稳定判别位（前端只需知道"被业务门禁挡了"），
  //   具体是哪道门走 `gateCode`（信用族的 blockCode 是开放集合，全枚举进 union 会变成一份
  //   永远追不齐的清单）；L/C 两枚码本身已在 `shared/errorCodes` 注册表里、且开票侧
  //   （`invoiceMutationService`）就是原样透出这两个码 ⇒ 这里直接进 union，两处同码同义。
  | 'CONFIRM_GATE_BLOCKED'
  | 'LC_GATE_BLOCKED'
  | 'LC_EXCEPTION_CHECK_FAILED'
  | 'COMMIT_TRANSACTION_FAILED'
  | 'UNKNOWN_ERROR';

/** fail-closed 结构化错误（稳定 code + message + userAction） */
export interface OrderConfirmError {
  code: OrderConfirmErrorCode;
  message: string;
  userAction: string;
  details?: string[];
  /** 被哪道门禁挡的（`MOQ_VIOLATION` / `CREDIT_FROZEN_60_DAYS` / `LC_GATE_BLOCKED` …），不许被上层码销毁 */
  gateCode?: string;
  /** DE-6：阻断同时自动发起的豁免审批单 id（有则必带，前端据此跳审批中心） */
  approvalRequestId?: string;
}

/** entity link 写入记录（commit 成功时返回） */
export interface EntityLinkRecord {
  linkKind: 'aboutOrder' | 'billTo';
  fromType: 'invoice';
  fromId: string;
  toType: 'order' | 'relation.organization';
  toId: string;
}

/** commit 成功结构化字段 */
export interface OrderConfirmCommitted {
  status: 'committed';
  orderId: string;
  poNumber: string;
  previousStatus: string;
  newStatus: string;
  transactionId: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  customerRelationId: string;
  customerName: string;
  auditId: string;
  idempotencyKey: string;
  entityLinks: EntityLinkRecord[];
  approvalId: string;
  subOperationsSummary: string[];
  impactScope: string[];
}

/** approval_required 结构化字段 */
export interface OrderConfirmApprovalRequired {
  status: 'approval_required';
  approvalId: string;
  processDraft: ProcessDraft;
  message: string;
  editableFields?: string[];
}

/** 统一 feedback contract（三态联合类型） */
export type OrderConfirmFeedback =
  | OrderConfirmApprovalRequired
  | OrderConfirmCommitted
  | { status: 'failed'; error: OrderConfirmError; approvalId?: string };

/** 把内部错误字符串解析为稳定 OrderConfirmErrorCode */
export function parseErrorCode(errorStr: string): OrderConfirmErrorCode {
  const s = errorStr || '';
  if (s.includes('does not support modified')) return 'APPROVAL_MODIFIED_UNSUPPORTED';
  if (s.includes('not approved') && s.includes('rejected')) return 'APPROVAL_REJECTED';
  if (s.includes('not found or not approved')) return 'APPROVAL_NOT_FOUND';
  if (s.includes('approvalId not provided')) return 'APPROVAL_ID_MISSING';
  if (s.includes('no approved process draft')) return 'PROCESS_DRAFT_MISSING';
  if (s.includes('hash mismatch')) return 'PROCESS_DRAFT_HASH_MISMATCH';
  if (s.includes('semantic validation failed')) return 'SEMANTIC_VALIDATION_FAILED';
  if (s.includes('PRECONDITIONS_FAILED') || s.includes('preconditions')) return 'PRECONDITIONS_FAILED';
  if (s.includes('ORDER_NOT_FOUND')) return 'ORDER_NOT_FOUND';
  if (s.includes('STATUS_DRIFT')) return 'STATUS_DRIFT';
  if (s.includes('INVOICE_AMOUNT_INVALID') || s.includes('INVOICE_AMOUNT')) return 'INVOICE_AMOUNT_INVALID';
  if (s.includes('INVOICE_CURRENCY_MISSING')) return 'INVOICE_CURRENCY_MISSING';
  // ★ 门禁三条必须在 `COMMIT_FAILED` 兜底**之前**判：commit 失败时返回的 error 串形如
  //   `CONFIRM_GATE_BLOCKED: <中文>`，落到下面那行会被吞成 COMMIT_TRANSACTION_FAILED，
  //   用户看到的就成了"数据库错误，请稍后重试"（然后一直重试，门禁一直挡着）。
  if (s.includes('CONFIRM_GATE_BLOCKED')) return 'CONFIRM_GATE_BLOCKED';
  if (s.includes('LC_EXCEPTION_CHECK_FAILED')) return 'LC_EXCEPTION_CHECK_FAILED';
  if (s.includes('LC_GATE_BLOCKED')) return 'LC_GATE_BLOCKED';
  if (s.includes('COMMIT_TRANSACTION_FAILED') || s.includes('COMMIT_FAILED')) return 'COMMIT_TRANSACTION_FAILED';
  return 'UNKNOWN_ERROR';
}

/** 根据 code 生成 userAction 指引 */
export function userActionForCode(code: OrderConfirmErrorCode): string {
  const map: Record<OrderConfirmErrorCode, string> = {
    APPROVAL_REJECTED: '审批已被拒绝，无法执行 order.confirm，请确认是否需要重新发起审批。',
    APPROVAL_MODIFIED_UNSUPPORTED: '当前不支持 modified 审批，请重新生成 ProcessDraft 并重新审批。',
    APPROVAL_NOT_FOUND: '找不到对应的审批记录，请确认 approvalId 是否正确，或重新发起审批。',
    APPROVAL_ID_MISSING: '审批通过后重跑必须携带 approvalId，请联系管理员检查 agentLoop 契约。',
    PROCESS_DRAFT_MISSING: '审批 payload 缺少 ProcessDraft，请重新发起 order.confirm 生成 draft。',
    PROCESS_DRAFT_HASH_MISMATCH: 'ProcessDraft 与审批时不一致（可能被篡改），请重新发起审批。',
    SEMANTIC_VALIDATION_FAILED: 'ProcessDraft 业务语义校验失败，请检查订单状态/发票字段是否完整。',
    PRECONDITIONS_FAILED: '订单不满足确认前置条件（需 Pending 状态、客户关系、订单行、有效金额）。',
    ORDER_NOT_FOUND: '订单不存在或已删除，请确认 poNumber 是否正确。',
    STATUS_DRIFT: '订单状态已被并发修改，请刷新订单状态后重新确认。',
    INVOICE_AMOUNT_INVALID: '发票金额无效（必须 > 0），请检查订单 totalActual/totalNet/quoteAmount。',
    INVOICE_CURRENCY_MISSING: '发票币种缺失，请检查订单 salesCurrency/currency 字段。',
    CONFIRM_GATE_BLOCKED: '订单确认被业务门禁（信用/MOQ/信用证）阻断：请按 message 完成对应的豁免审批或信用证登记后重试。审批通过 ≠ 门禁通过，两道都要过。',
    LC_GATE_BLOCKED: '该订单以信用证结算，但 L/C 条款不满足本阶段要求：请先在「信用证」登记/核对有效期与装运期限，确需例外按 DR-013 申请豁免。',
    LC_EXCEPTION_CHECK_FAILED: '信用证条款不满足，且系统查不到是否已有 DR-013 例外 ⇒ 保持阻断。这一步是服务端故障，请排查例外/审批服务后重试。',
    COMMIT_TRANSACTION_FAILED: '事务提交失败（数据库错误），请稍后重试或联系管理员。',
    UNKNOWN_ERROR: '未知错误，请联系管理员查看日志。',
  };
  return map[code];
}

/** 构造 fail-closed OrderConfirmError */
export function buildOrderConfirmError(errorStr: string, details?: string[]): OrderConfirmError {
  const code = parseErrorCode(errorStr);
  return {
    code,
    message: errorStr,
    userAction: userActionForCode(code),
    details,
  };
}

/**
 * B50-1b：确认门禁阻断 → OrderConfirmError。
 *
 * 上层码固定为 `CONFIRM_GATE_BLOCKED`（契约判别位），**精确的门禁码走 `gateCode` 原样带出**：
 * 这里如果只留一个笼统码，就是把 §9 G-4 在 V2 抓到过的同一形状（`?? 'INTERNAL_ERROR'`
 * 销毁机器可读码）在本批重做一遍 —— 前端/agent 就再也没法按"是信用冻结还是 MOQ 不足"分支了。
 */
export function buildOrderConfirmGateError(params: {
  gateCode: string;
  /** 门禁模块组装好的**对外产品文案**（不是某个 Error 的 `.message`；字段名刻意不叫 message，
   *  是因为 `rawErrorLeakRatchet`/`serviceMessageWrapRatchet` 两条判据都按 `xxx.message` 这个转发形状判定，
   *  而它们分不清"拼好的中文提示"与"原始异常文本" ⇒ 本模块不新增那样一跳转发，见
   *  `orders/orderLifecycleService.ts` 的 `OrderConfirmGateOutcome` 注释）。 */
  userMessage: string;
  approvalRequestId?: string;
}): OrderConfirmError {
  const code: OrderConfirmErrorCode = 'CONFIRM_GATE_BLOCKED';
  const error: OrderConfirmError = {
    code,
    message: `${code}: ${params.userMessage}`,
    userAction: userActionForCode(code),
    gateCode: params.gateCode,
    ...(params.approvalRequestId ? { approvalRequestId: params.approvalRequestId } : {}),
  };
  return error;
}
