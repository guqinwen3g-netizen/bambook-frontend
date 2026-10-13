import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalClaimJson } from '../../claims/claimApprovalFact';
import { approvalReviewContentVersion } from '../../approvals/approvalReviewContent';
import { decideDevelopmentBillingApproval, developmentFeeFinalProposalDigest, previewDevelopmentBillingFinalProposal } from '../developmentBillingApprovalService';
import {parseNotificationLink} from '../../../../services/crossModuleNav';
import {View} from '../../../../types';

const mocks = vi.hoisted(() => ({ currentReview: vi.fn(), bindCoverage: vi.fn(), audit: vi.fn() }));
vi.mock('../developmentClosureService', () => ({ assertDevelopmentExpenseReviewCurrentInTx: mocks.currentReview }));
vi.mock('../developmentBillingCoverageService', () => ({ bindDevelopmentBillingCoverageInTx: mocks.bindCoverage }));
vi.mock('../developmentBillingWorkflowService', () => ({
  developmentBillingReviewTaskId: (id: string, version: number) => `review-${id}-${version}`,
  snapshotDevelopmentBillingItem: (row: any) => JSON.parse(JSON.stringify({
    state: row.developmentWorkflowState, version: row.developmentWorkflowVersion, reviewId: row.developmentExpenseReviewId,
    amount: row.amount.toString(), waivedAmount: row.waivedAmount.toString(), offsetAmount: row.offsetAmount.toString(),
    currency: row.currency, customerId: row.bearerRelationId, note: row.notes,
    assigneeId: row.developmentAssigneeId, submittedBy: row.developmentSubmittedBy,
  })),
}));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: mocks.audit }));

const hash = (value: unknown) => createHash('sha256').update(canonicalClaimJson(value)).digest('hex');
function fixture() {
  const payloadBase = { schemaVersion: 1, kind: 'development_fee', caseId: 'case-1', billingItemId: 'bill-1', itemNo: 'DEV-1',
    expenseReviewId: 'review-1', expenseReviewFingerprint: 'a'.repeat(64), workflowVersion: 4, amount: '100', waivedAmount: '20',
    currency: 'USD', bearerType: 'customer', bearerRelationId: 'customer-1', bearerName: '客户甲',
    financeUserId: 'finance-1', reason: '申请减免开发费用十元' };
  const approval: any = { id: 'approval-1', requesterId: 'requester-1', reviewerId: 'leader-1', actionType: 'development:fee',
    targetType: 'BillingItem', targetId: 'bill-1', status: 'pending', payload: { ...payloadBase, contentFingerprint: hash(payloadBase) } };
  const item: any = { id: 'bill-1', sourceType: 'DevelopmentCase', sourceId: 'case-1', chargeType: 'development_fee',
    itemNo: 'DEV-1', status: 'draft', developmentWorkflowState: 'approval_pending', developmentWorkflowVersion: 4,
    developmentApprovalId: 'approval-1', developmentExpenseReviewId: 'review-1', amount: new Prisma.Decimal(100),
    waivedAmount: new Prisma.Decimal(20), offsetAmount: new Prisma.Decimal(0), currency: 'USD', bearerType: 'customer',
    bearerRelationId: 'customer-1', bearerName: '客户甲', developmentAssigneeId: 'requester-1' };
  item.notes = 'Original customer fee proposal';
  const review: any = { id: 'review-1', fingerprint: 'a'.repeat(64), snapshot: { costs: { records: [{ id: 'cost-1', amount: '50', currency: 'USD' }] } }, lifecycleEventId: 'life-1' };
  const tasks: any[] = [], events: any[] = [], notifications: any[] = [];
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ id: 'case-1' }]),
    approvalRequest: { findUnique: vi.fn(async () => approval) },
    userRole: { findMany: vi.fn(async () => [{ roleId: 'role_manager' }]) },
    billingItem: { findFirst: vi.fn(async () => item), update: vi.fn(async ({ data }: any) => Object.assign(item, data)) },
    billingItemCostCoverage: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    workAssignment: { create: vi.fn(async ({ data }: any) => { tasks.push(data); return data; }) },
    notification: { createMany: vi.fn(async ({ data }: any) => { notifications.push(...data); return { count: data.length }; }) },
    developmentBillingWorkflowEvent: { create: vi.fn(async ({ data }: any) => { events.push(data); return data; }) },
  };
  const prisma: any = { $transaction: vi.fn(async (callback: any) => callback(tx)) };
  const decisionService = { decideInTransaction: vi.fn(async (_tx: any, input: any) => ({ decisionAuditId: 'audit-1', updated: { ...approval, status: input.decision }, existing: approval })) };
  const authorizeBusiness = vi.fn(async () => undefined), authorizeRecipient = vi.fn(async () => undefined);
  return { approval, item, review, tasks, events, notifications, tx, prisma, decisionService, authorizeBusiness, authorizeRecipient,
    reviewContentVersion: approvalReviewContentVersion(approval) };
}

beforeEach(() => { vi.clearAllMocks(); mocks.currentReview.mockResolvedValue(null); mocks.bindCoverage.mockResolvedValue(undefined); mocks.audit.mockResolvedValue(undefined); });

describe('development fee leadership approval adapter', () => {
  it('previews a final manager proposal without writing BillingItem or task state', async () => {
    const f = fixture(); mocks.currentReview.mockResolvedValue(f.review);
    const finalInput = { amount: '90.00', waivedAmount: '10.00', reason: '领导调整为九十美元并保留十美元减免' };
    const preview = await previewDevelopmentBillingFinalProposal(f.prisma, { approvalId: f.approval.id, actorId: 'leader-1',
      reviewContentVersion: f.reviewContentVersion, finalInput, authorizeBusiness: f.authorizeBusiness });
    expect(preview).toMatchObject({ approvalId: f.approval.id, reviewContentVersion: f.reviewContentVersion,
      sourceBillingItemVersion: 4, finalInput: { amount: '90', waivedAmount: '10', reason: finalInput.reason },
      diff: [{ field: 'amount', before: '100', after: '90' }, { field: 'waivedAmount', before: '20', after: '10' }] });
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.authorizeBusiness).toHaveBeenCalledWith(f.tx, 'case-1');
    expect(f.tx.billingItem.update).not.toHaveBeenCalled(); expect(f.tasks).toHaveLength(0); expect(f.events).toHaveLength(0);
  });

  it('atomically approves the previewed final amount and starts finance review with an immutable cost round', async () => {
    const f = fixture(); mocks.currentReview.mockResolvedValue(f.review);
    const modifiedInput = { amount: '90', waivedAmount: '10', reason: '领导调整为九十美元并保留十美元减免' };
    const previewDigest = developmentFeeFinalProposalDigest({ approval: f.approval, billingItem: f.item,
      expenseReview: f.review, reviewContentVersion: f.reviewContentVersion, finalInput: modifiedInput });
    const result = await decideDevelopmentBillingApproval({ prisma: f.prisma, decisionService: f.decisionService,
      approvalId: f.approval.id, actor: { userId: 'leader-1', roles: ['manager'] }, status: 'approved',
      reviewContentVersion: f.reviewContentVersion, confirmedReviewedContent: true, modifiedInput, reviewPreviewDigest: previewDigest,
      authorizeBusiness: f.authorizeBusiness, authorizeRecipient: f.authorizeRecipient });
    expect(f.decisionService.decideInTransaction).toHaveBeenCalledWith(f.tx, expect.objectContaining({ source: 'api:approvals',
      reviewContentVersion: f.reviewContentVersion, confirmedReviewedContent: true, modifiedInput, reviewPreviewDigest: previewDigest }));
    expect(f.item).toMatchObject({ developmentWorkflowState: 'submitted', developmentWorkflowVersion: 5,
      developmentAssigneeId: 'finance-1' });
    expect(f.item.amount.toString()).toBe('90'); expect(f.item.waivedAmount.toString()).toBe('10');
    expect(mocks.bindCoverage).toHaveBeenCalledWith(f.tx, expect.anything(), { caseId: 'case-1', billingItemId: 'bill-1', reviewId: 'review-1', submissionVersion: 5 });
    expect(f.tasks).toHaveLength(1); expect(f.tasks[0]).toMatchObject({ id: 'review-bill-1-5', userId: 'finance-1',
      metadata: { kind: 'finance_review', approvalId: 'approval-1', version: 5,
        decision: { state: 'submitted', version: 5, reviewId: 'review-1', amount: '90', waivedAmount: '10', offsetAmount: '0',
          currency: 'USD', customerId: 'customer-1', note: modifiedInput.reason, assigneeId: 'finance-1', submittedBy: 'requester-1' } } });
    expect(f.item.notes).toBe(modifiedInput.reason);
    expect(f.notifications).toHaveLength(1); expect(f.events[0]).toMatchObject({ action: 'approval_approved', version: 5,
      snapshot: { finalInput: modifiedInput, previewDigest, taskId: 'review-bill-1-5' } });
    expect(f.notifications[0].link).toBe('/development?id=case-1&tab=fees');
    expect(parseNotificationLink(f.notifications[0].link)).toEqual({view:View.Development,id:'case-1',tab:'fees',params:{}});
    expect(result.notificationId).toBe('ntf_dev_fee_review_audit-1');
  });

  it('approves the frozen original proposal without fabricating an amendment preview', async () => {
    const f = fixture(); mocks.currentReview.mockResolvedValue(f.review);
    await decideDevelopmentBillingApproval({ prisma: f.prisma, decisionService: f.decisionService,
      approvalId: f.approval.id, actor: { userId: 'leader-1', roles: ['manager'] }, status: 'approved',
      reviewContentVersion: f.reviewContentVersion, confirmedReviewedContent: true, reviewPreviewDigest: 'c'.repeat(64),
      authorizeBusiness: f.authorizeBusiness, authorizeRecipient: f.authorizeRecipient });
    const call = f.decisionService.decideInTransaction.mock.calls[0][1];
    expect(call).toMatchObject({ source: 'api:approvals', reviewContentVersion: f.reviewContentVersion, confirmedReviewedContent: true });
    expect(call.modifiedInput).toBeUndefined(); expect(call.reviewPreviewDigest).toBeUndefined();
    expect(f.item.amount.toString()).toBe('100'); expect(f.item.waivedAmount.toString()).toBe('20');
    expect(f.item.developmentWorkflowState).toBe('submitted'); expect(f.tasks).toHaveLength(1); expect(f.notifications).toHaveLength(1);
    expect(f.tasks[0].metadata.decision).toEqual({ state: 'submitted', version: 5, reviewId: 'review-1', amount: '100',
      waivedAmount: '20', offsetAmount: '0', currency: 'USD', customerId: 'customer-1', note: f.approval.payload.reason,
      assigneeId: 'finance-1', submittedBy: 'requester-1' });
    expect(mocks.bindCoverage).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale preview before any decision, fee, coverage or task write', async () => {
    const f = fixture(); mocks.currentReview.mockResolvedValue(f.review);
    const modifiedInput = { amount: '90', waivedAmount: '10', reason: '领导调整为九十美元并保留十美元减免' };
    await expect(decideDevelopmentBillingApproval({ prisma: f.prisma, decisionService: f.decisionService,
      approvalId: f.approval.id, actor: { userId: 'leader-1', roles: ['manager'] }, status: 'approved',
      reviewContentVersion: f.reviewContentVersion, confirmedReviewedContent: true, modifiedInput, reviewPreviewDigest: 'b'.repeat(64),
      authorizeBusiness: f.authorizeBusiness, authorizeRecipient: f.authorizeRecipient })).rejects.toMatchObject({ code: 'DEVELOPMENT_FEE_PREVIEW_STALE' });
    expect(f.decisionService.decideInTransaction).not.toHaveBeenCalled(); expect(f.tx.billingItem.update).not.toHaveBeenCalled();
    expect(mocks.bindCoverage).not.toHaveBeenCalled(); expect(f.tasks).toHaveLength(0); expect(f.events).toHaveLength(0);
  });

  it('rejects to the requester without applying a changed fee or starting finance', async () => {
    const f = fixture(); mocks.currentReview.mockResolvedValue(f.review);
    const result = await decideDevelopmentBillingApproval({ prisma: f.prisma, decisionService: f.decisionService,
      approvalId: f.approval.id, actor: { userId: 'leader-1', roles: ['manager'] }, status: 'rejected',
      reviewContentVersion: f.reviewContentVersion, confirmedReviewedContent: false, decisionNote: '需要重新说明客户减免依据',
      authorizeBusiness: f.authorizeBusiness, authorizeRecipient: f.authorizeRecipient });
    expect(f.item).toMatchObject({ developmentWorkflowState: 'returned', developmentWorkflowVersion: 5, developmentAssigneeId: 'requester-1' });
    expect(f.item.amount.toString()).toBe('100'); expect(f.item.waivedAmount.toString()).toBe('20');
    expect(mocks.bindCoverage).not.toHaveBeenCalled(); expect(f.tasks).toHaveLength(0); expect(f.notifications).toHaveLength(0);
    expect(result.event.action).toBe('approval_rejected');
  });
});
