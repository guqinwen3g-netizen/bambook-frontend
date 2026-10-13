import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApprovalRouter } from '../approvalRoute';

const mocks = vi.hoisted(() => ({
  actor: { userId: 'leader-1', roles: ['manager'], permissions: ['products:read'], permissionCeiling: ['*'] } as any,
  genericDecide: vi.fn(), decideInTx: vi.fn(), publish: vi.fn(), readDetail: vi.fn(), sourceRead: vi.fn(), attachments: vi.fn(),
  preview: vi.fn(), decideDevelopment: vi.fn(), recipient: vi.fn(), notification: vi.fn(),
}));
vi.mock('../../auth/middleware', () => ({ extractActorFromRequest: () => mocks.actor }));
vi.mock('../approvalDecisionService', () => ({
  approvalReviewContentVersion: () => 'a'.repeat(64),
  createApprovalDecisionService: () => ({ decide: mocks.genericDecide, decideInTransaction: mocks.decideInTx, publishCommittedDecision: mocks.publish }),
}));
vi.mock('../approvalReviewDetailService', () => ({ readApprovalReviewDetail: mocks.readDetail }));
vi.mock('../approvalReviewSourceAccess', () => ({ assertApprovalReviewSourceRead: mocks.sourceRead, canReadApprovalReviewAttachments: mocks.attachments }));
vi.mock('../../development/developmentExpenseAccess', () => ({ assertDevelopmentExpenseAccess: vi.fn(), assertDevelopmentFinanceRecipient: mocks.recipient }));
vi.mock('../../development/developmentBillingApprovalService', () => ({
  previewDevelopmentBillingFinalProposal: mocks.preview, decideDevelopmentBillingApproval: mocks.decideDevelopment,
}));
vi.mock('../../realtime', () => ({ publishNotificationEvent: mocks.notification }));

const pending: any = { id: 'approval-1', requesterId: 'requester-1', reviewerId: 'leader-1', actionType: 'development:fee',
  targetType: 'BillingItem', targetId: 'bill-1', status: 'pending', payload: { caseId: 'case-1' } };
function fixture() {
  const prisma: any = {
    approvalRequest: { findFirst: vi.fn(async () => ({ ...pending, requester: { id: 'requester-1' }, reviewer: { id: 'leader-1' } })),
      findUnique: vi.fn(async () => pending), findMany: vi.fn(async () => []) },
    auditLog: { findMany: vi.fn(async () => []) }, notification: { createMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (callback: any) => callback(prisma)),
  };
  const app = express(); app.use(express.json()); app.use('/v1/approvals', createApprovalRouter({ prisma, requireAuth: true }));
  return { app, prisma };
}
beforeEach(() => {
  vi.clearAllMocks(); pending.actionType = 'development:fee'; mocks.actor = { userId: 'leader-1', roles: ['manager'], permissions: ['products:read'], permissionCeiling: ['*'] };
  mocks.sourceRead.mockResolvedValue(undefined); mocks.attachments.mockResolvedValue(false);
  mocks.readDetail.mockResolvedValue({ approvalId: pending.id, reviewContentVersion: 'a'.repeat(64) });
  mocks.preview.mockResolvedValue({ approvalId: pending.id, previewDigest: 'b'.repeat(64) });
  mocks.decideDevelopment.mockResolvedValue({ decisionAuditId: 'audit-1', updated: { ...pending, status: 'approved' },
    event: { snapshot: { finalInput: { amount: '90', waivedAmount: '10', reason: '领导核准修改并说明理由' } } },
    billingItem: { id: 'bill-1' }, taskId: null, notificationId: null, notificationUserId: null });
  mocks.publish.mockResolvedValue({ updated: { ...pending, status: 'approved' } });
});
afterEach(() => vi.restoreAllMocks());

describe('approval route native development fee closure', () => {
  it('uses original business read authorization before returning the unified detail projection', async () => {
    const { app } = fixture();
    const response = await request(app).get('/v1/approvals/approval-1/detail');
    expect(response.status).toBe(200); expect(response.body.detail).toMatchObject({ approvalId: pending.id });
    expect(mocks.sourceRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: pending.id }), mocks.actor);
    expect(mocks.readDetail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: pending.id }),
      { canReadCurrentSource: true, canReadAttachments: false });
  });

  it('keeps frozen detail readable but fails closed for current source and attachments when native authorization fails', async () => {
    mocks.sourceRead.mockRejectedValue(new Error('customer scope denied')); mocks.attachments.mockResolvedValue(false);
    const { app } = fixture();
    expect((await request(app).get('/v1/approvals/approval-1/detail')).status).toBe(200);
    expect(mocks.readDetail).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      { canReadCurrentSource: false, canReadAttachments: false });
  });

  it('offers a zero-write final proposal preview bound to the reviewed frozen version', async () => {
    const { app } = fixture();
    const body = { reviewContentVersion: 'a'.repeat(64), finalInput: { amount: '90', waivedAmount: '10', reason: '领导核准修改并说明理由' } };
    const response = await request(app).post('/v1/approvals/approval-1/development-fee-preview').send(body);
    expect(response.status).toBe(200); expect(response.body.preview.previewDigest).toBe('b'.repeat(64));
    expect(mocks.preview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ approvalId: pending.id,
      actorId: 'leader-1', ...body, authorizeBusiness: expect.any(Function) }));
  });

  it('dispatches changed-fee approval through the atomic domain adapter and publishes only after commit', async () => {
    const { app } = fixture();
    const body = { status: 'approved', reviewContentVersion: 'a'.repeat(64), confirmedReviewedContent: true,
      modifiedInput: { amount: '90', waivedAmount: '10', reason: '领导核准修改并说明理由' }, reviewPreviewDigest: 'b'.repeat(64) };
    const response = await request(app).post('/v1/approvals/approval-1/decide').send(body);
    expect(response.status).toBe(200); expect(response.body.development.billingItem.id).toBe('bill-1');
    expect(mocks.decideDevelopment).toHaveBeenCalledWith(expect.objectContaining({ approvalId: pending.id, status: 'approved',
      modifiedInput: body.modifiedInput, reviewPreviewDigest: body.reviewPreviewDigest, confirmedReviewedContent: true }));
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ decisionAuditId: 'audit-1' }), expect.objectContaining({
      source: 'api:approvals', reviewContentVersion: body.reviewContentVersion, modifiedInput: body.modifiedInput,
      reviewPreviewDigest: body.reviewPreviewDigest }));
    expect(mocks.genericDecide).not.toHaveBeenCalled();
  });

  it('approves the frozen proposal without inventing a modifiedInput or binding the frozen detail digest', async () => {
    const { app } = fixture();
    const body = { status: 'approved', reviewContentVersion: 'a'.repeat(64), confirmedReviewedContent: true,
      reviewPreviewDigest: 'c'.repeat(64) };
    const response = await request(app).post('/v1/approvals/approval-1/decide').send(body);
    expect(response.status).toBe(200);
    expect(mocks.decideDevelopment).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved', reviewContentVersion: body.reviewContentVersion, confirmedReviewedContent: true,
      modifiedInput: undefined, reviewPreviewDigest: body.reviewPreviewDigest,
    }));
    const publishedInput = mocks.publish.mock.calls[0][1];
    expect(publishedInput).not.toHaveProperty('modifiedInput');
    expect(publishedInput).not.toHaveProperty('reviewPreviewDigest');
    expect(mocks.genericDecide).not.toHaveBeenCalled();
  });

  it('forwards signed preview digests to non-development approvals without weakening the kernel check', async () => {
    pending.actionType = 'quotation:line_approve';
    mocks.genericDecide.mockResolvedValue({ updated: { ...pending, status: 'approved' }, existing: pending });
    const { app } = fixture();
    const body = { status: 'approved', reviewContentVersion: 'a'.repeat(64), reviewPreviewDigest: 'd'.repeat(64),
      confirmedReviewedContent: true };
    const response = await request(app).post('/v1/approvals/approval-1/decide').send(body);
    expect(response.status).toBe(200);
    expect(mocks.genericDecide).toHaveBeenCalledWith(expect.objectContaining({ reviewPreviewDigest: body.reviewPreviewDigest,
      reviewContentVersion: body.reviewContentVersion, confirmedReviewedContent: true }));
  });
});
