import type { ApprovalRequest, Prisma } from '@prisma/client';

type ReceiptTransaction = Pick<Prisma.TransactionClient, 'notification'>;

export type ApprovalResultReceipt = {
  id: string;
  userId: string;
  type: 'approval_decided';
  title: string;
  body: string;
  level: 'info' | 'warning';
  metadata: Record<string, string | null>;
  created: boolean;
};

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
function publicReference(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 48 && /^[\p{L}\p{N}._/-]+$/u.test(normalized)
    ? normalized : null;
}
function approvalSubject(approval: Pick<ApprovalRequest, 'actionType' | 'targetType' | 'payload'>): string {
  const payload = record(approval.payload);
  const document = record(record(payload.documentSnapshot).data);
  const quotationSnapshot = record(payload.quotationSnapshot);
  const references = approval.actionType === 'order:confirmation_sign'
    ? [document.poNumber, payload.poNumber]
    : approval.actionType.startsWith('quotation:')
      ? [document.quotationNumber, quotationSnapshot.quotationNumber, payload.quotationNumber]
      : approval.actionType === 'development:fee'
        ? [payload.caseNumber, payload.requestNumber]
        : [payload.requestNumber];
  const reference = references.map(publicReference).find(Boolean);
  const label = ({
    'quotation:line_approve': '报价条目审批',
    'quotation:total_approve': '报价总价审批',
    'quotation:price-deviation': '报价偏差审批',
    'finance:payment_request': '付款申请',
    'order:change': '订单变更申请',
    'order:dr013-exception': '信用例外申请',
    'development:fee': '开发费审批',
    'order:confirmation_sign': '订单确认书签署',
    'contract:sign': '合同签署',
    'order:moq-exemption': '起订量例外申请',
    'order:short-ship-exemption': '短装例外申请',
  } as Record<string, string>)[approval.actionType]
    ?? ({ OrderChangeRequest: '订单变更申请', Dr013ExceptionRequest: '信用例外申请',
      PaymentRequest: '付款申请', QuotationLine: '报价条目审批', Quotation: '报价审批申请' } as Record<string, string>)[approval.targetType]
    ?? '审批申请';
  return reference ? `${label} ${reference}` : label;
}

/**
 * Persist the applicant's decision receipt in the same transaction as the
 * approval fact. Preferences only control optional reminders; they cannot
 * suppress this required handoff record. The deterministic ID also makes a
 * repeated write of the same decision audit idempotent without schema changes.
 */
export async function persistApprovalResultReceipt(
  tx: ReceiptTransaction,
  approval: Pick<ApprovalRequest, 'id' | 'requesterId' | 'actionType' | 'targetType' | 'targetId' | 'status' | 'payload'>,
  decisionAuditId: string,
): Promise<ApprovalResultReceipt | null> {
  if (!approval.requesterId || approval.actionType.startsWith('tool:')) return null;

  const status = approval.status;
  const approved = status === 'approved';
  const rejected = status === 'rejected';
  const id = `ntf_approval_decision_${decisionAuditId}`;
  const subject = approvalSubject(approval);
  const title = approved ? `${subject} 已通过`
    : rejected ? `${subject} 被驳回` : `${subject} 已处理`;
  const body = rejected
    ? '驳回意见与待改内容见审批详情。'
    : '业务当前生效状态以详情读取结果为准。';
  const level = rejected ? 'warning' : 'info';
  const metadata = {
    approvalId: approval.id,
    decisionAuditId,
    decisionStatus: String(status),
  };

  const result = await tx.notification.createMany({
    data: [{ id, userId: approval.requesterId, type: 'approval_decided', title, body, level,
      link: null, metadata: metadata as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
  return { id, userId: approval.requesterId, type: 'approval_decided', title, body, level, metadata,
    created: result.count > 0 };
}
