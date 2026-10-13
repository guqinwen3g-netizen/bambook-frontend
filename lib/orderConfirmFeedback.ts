import type {
  OrderConfirmCommitResult,
  OrderConfirmErrorFeedback,
  OrderConfirmErrorCode,
} from '../types';

/** order.confirm 反馈三态（对齐 server feedbackContract.ts OrderConfirmFeedback 联合类型）。 */
export type OrderConfirmFeedbackState = 'committed' | 'approval_required' | 'rejected' | 'failed';

/** 从 CommitResult 判定反馈四态。
 *  契约化优先级：errorFeedback/errorPreview.code 存在时按 code 分流——
 *  APPROVAL_REJECTED 走中性 rejected（用户主动拒绝，非系统错误），其余走 failed。
 *  P1-D §3.3: rejected 必须 reassuring "nothing changed"。 */
export const classifyOrderConfirmFeedback = (
  result: OrderConfirmCommitResult | null,
  hasError: boolean,
  errorFeedback: OrderConfirmErrorFeedback | null = null,
): OrderConfirmFeedbackState => {
  // APPROVAL_REJECTED：用户主动拒绝，中性态（P1-D §3.3）
  if (errorFeedback?.code === 'APPROVAL_REJECTED') return 'rejected';
  // P1-C: 其余稳定失败信号——errorFeedback 存在即 failed，即使 block.error 为空
  if (errorFeedback) return 'failed';
  if (!result) return hasError ? 'failed' : 'approval_required';
  if (result.ok && result.committed) return 'committed';
  if (result.errorFeedback || result.error) return 'failed';
  return hasError ? 'failed' : 'approval_required';
};

/** 从工具注解 block 的 outputPreview 提取 order.confirm commit 结果。 */
export const extractOrderConfirmResult = (
  outputPreview: unknown,
): OrderConfirmCommitResult | null => {
  if (outputPreview == null || typeof outputPreview !== 'object') return null;
  const r = outputPreview as Record<string, unknown>;
  if (typeof r.ok !== 'boolean' || typeof r.committed !== 'boolean') return null;
  return r as unknown as OrderConfirmCommitResult;
};

/** 从工具注解 block 提取 order.confirm 失败的稳定 errorFeedback。
 *  优先消费 metadata.errorPreview（agentLoop P1-C 专用），回退 result.errorFeedback。 */
export const extractOrderConfirmErrorFeedback = (
  blockMetadata: unknown,
  result: OrderConfirmCommitResult | null,
): OrderConfirmErrorFeedback | null => {
  // 1) agentLoop P1-C: metadata.errorPreview 是稳定的 OrderConfirmError
  if (blockMetadata && typeof blockMetadata === 'object') {
    const meta = blockMetadata as Record<string, unknown>;
    const errorPreview = meta.errorPreview;
    if (errorPreview && typeof errorPreview === 'object') {
      const ep = errorPreview as Record<string, unknown>;
      if (typeof ep.code === 'string' && typeof ep.userAction === 'string') {
        return ep as unknown as OrderConfirmErrorFeedback;
      }
    }
  }
  // 2) 回退：commit 结果里的 errorFeedback
  if (result?.errorFeedback && typeof result.errorFeedback.code === 'string') {
    return result.errorFeedback;
  }
  return null;
};

/** 错误码 → 中文友好标签（用于 UI 显示，userAction 已是中文文案这里只做 code 标签）。 */
export const ERROR_CODE_LABEL: Record<OrderConfirmErrorCode, string> = {
  APPROVAL_REJECTED: '审批已拒绝',
  APPROVAL_MODIFIED_UNSUPPORTED: '不支持修改后提交',
  APPROVAL_NOT_FOUND: '审批记录不存在',
  APPROVAL_ID_MISSING: '缺少审批 ID',
  PROCESS_DRAFT_MISSING: '审批草稿缺失',
  PROCESS_DRAFT_HASH_MISMATCH: '审批草稿不一致',
  SEMANTIC_VALIDATION_FAILED: '业务语义校验失败',
  PRECONDITIONS_FAILED: '前置条件不满足',
  ORDER_NOT_FOUND: '订单不存在',
  STATUS_DRIFT: '订单状态已变化',
  INVOICE_AMOUNT_INVALID: '发票金额无效',
  INVOICE_CURRENCY_MISSING: '发票币种缺失',
  COMMIT_TRANSACTION_FAILED: '事务提交失败',
  UNKNOWN_ERROR: '未知错误',
};
