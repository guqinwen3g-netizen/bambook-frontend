import { createHash } from 'node:crypto';
import type { ApprovalRequest } from '@prisma/client';

function canonicalApprovalContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalApprovalContent);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map(key => [key,
      canonicalApprovalContent((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Version of the exact frozen request facts a reviewer must open and acknowledge. */
export function approvalReviewContentVersion(approval: Pick<ApprovalRequest,
  'id' | 'requesterId' | 'reviewerId' | 'actionType' | 'targetType' | 'targetId' | 'payload'>): string {
  const content = canonicalApprovalContent({ id: approval.id, requesterId: approval.requesterId,
    reviewerId: approval.reviewerId, actionType: approval.actionType, targetType: approval.targetType,
    targetId: approval.targetId, payload: approval.payload });
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
