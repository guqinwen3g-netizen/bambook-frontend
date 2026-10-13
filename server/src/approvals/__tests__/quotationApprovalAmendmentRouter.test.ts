import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(), readResult: vi.fn(), decide: vi.fn(),
}));
vi.mock('../quotationAmendmentService', () => ({
  createQuotationApprovalAmendmentService: () => ({ preview: mocks.preview, readResult: mocks.readResult, applyInTransaction: vi.fn() }),
}));
import { createQuotationApprovalAmendmentRouter } from '../quotationApprovalAmendmentRouter';

function response() {
  return { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(value: any) { this.body = value; return this; } };
}
function routeHandler(router: any, path: string, method: 'get' | 'post') {
  const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`missing ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

describe('quotation approval amendment route factory', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('keeps preview/confirm behind decision auth and does not pass an unreviewed request through', async () => {
    const managerAuth = vi.fn((_req, res) => { res.status(403).json({ error: 'manager required' }); return null; });
    const router = createQuotationApprovalAmendmentRouter({ prisma: {} as any,
      authenticateRead: () => ({ userId: 'applicant', roles: [] }), authenticateDecide: managerAuth, decide: mocks.decide });
    const blocked = response();
    await routeHandler(router, '/:id/quotation-amendment/preview', 'post')({ params: { id: 'APR-1' }, body: {} }, blocked, vi.fn());
    expect(blocked.statusCode).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();

    const actor = { userId: 'reviewer', roles: ['manager'] };
    const authenticated = createQuotationApprovalAmendmentRouter({ prisma: {} as any,
      authenticateRead: () => ({ userId: 'applicant', roles: [] }), authenticateDecide: () => actor, decide: mocks.decide });
    const malformed = response();
    await routeHandler(authenticated, '/:id/quotation-amendment/confirm', 'post')({ params: { id: 'APR-1' }, body: {
      reviewContentVersion: 'a'.repeat(64), reviewPreviewDigest: 'b'.repeat(64), confirmedReviewedContent: false,
      reviewerId: 'applicant', amendment: { reason: 'reason long enough' },
    } }, malformed, vi.fn());
    expect(malformed.statusCode).toBe(400);
    expect(mocks.decide).not.toHaveBeenCalled();

    const invalidDigest = response();
    await routeHandler(authenticated, '/:id/quotation-amendment/confirm', 'post')({ params: { id: 'APR-1' }, body: {
      reviewContentVersion: 'a'.repeat(64), reviewPreviewDigest: 'not-a-digest', confirmedReviewedContent: true,
      amendment: { reason: 'reason long enough', previewVersion: 'b'.repeat(64), finalContentVersion: 'c'.repeat(64) },
    } }, invalidDigest, vi.fn());
    expect(invalidDigest.statusCode).toBe(400);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('passes only the confirmed native amendment to the shared decision kernel', async () => {
    mocks.decide.mockResolvedValue({ updated: { id: 'APR-1', status: 'approved' }, quotationAmendment: { approvalId: 'APR-1', finalVersion: 2 } });
    const actor = { userId: 'reviewer', roles: ['manager'] };
    const router = createQuotationApprovalAmendmentRouter({ prisma: {} as any,
      authenticateRead: () => ({ userId: 'applicant', roles: [] }), authenticateDecide: () => actor, decide: mocks.decide });
    const req = { params: { id: 'APR-1' }, ip: '127.0.0.1', body: { reviewContentVersion: 'a'.repeat(64),
      reviewPreviewDigest: 'd'.repeat(64), confirmedReviewedContent: true,
      amendment: { lineUnitPrices: [{ lineId: 'line-1', unitPrice: '9.00' }], reason: '领导核价意见要求调整单价',
        previewVersion: 'b'.repeat(64), finalContentVersion: 'c'.repeat(64) } } };
    const res = response();
    await routeHandler(router, '/:id/quotation-amendment/confirm', 'post')(req, res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ id: 'APR-1', actor, decision: 'approved', source: 'api:approvals',
      confirmedReviewedContent: true, reviewContentVersion: 'a'.repeat(64), reviewPreviewDigest: 'd'.repeat(64),
      ip: '127.0.0.1', quotationAmendment: req.body.amendment }));
    expect(res.body.amendment.finalVersion).toBe(2);
  });

  it('keeps the original review digest optional for non-signing line approvals', async () => {
    mocks.decide.mockResolvedValue({ updated: { id: 'APR-1', status: 'approved' }, quotationAmendment: { approvalId: 'APR-1' } });
    const router = createQuotationApprovalAmendmentRouter({ prisma: {} as any,
      authenticateRead: () => ({ userId: 'applicant', roles: [] }), authenticateDecide: () => ({ userId: 'reviewer', roles: ['manager'] }),
      decide: mocks.decide });
    const req = { params: { id: 'APR-1' }, body: { reviewContentVersion: 'a'.repeat(64), confirmedReviewedContent: true,
      amendment: { reason: '领导根据成本复核意见调整了本行报价', previewVersion: 'b'.repeat(64), finalContentVersion: 'c'.repeat(64) } } };
    const res = response();
    await routeHandler(router, '/:id/quotation-amendment/confirm', 'post')(req, res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ reviewContentVersion: 'a'.repeat(64),
      confirmedReviewedContent: true, quotationAmendment: req.body.amendment }));
    expect(mocks.decide.mock.calls[0][0]).not.toHaveProperty('reviewPreviewDigest');
  });

  it('uses read auth and exact result identity for applicant readback', async () => {
    mocks.readResult.mockResolvedValue({ approvalId: 'APR-1', amended: false, currentSource: null });
    const readActor = { userId: 'applicant', roles: [] };
    const readAuth = vi.fn(() => readActor);
    const router = createQuotationApprovalAmendmentRouter({ prisma: {} as any,
      authenticateRead: readAuth, authenticateDecide: () => null, decide: mocks.decide });
    const res = response();
    await routeHandler(router, '/:id/quotation-amendment/result', 'get')({ params: { id: 'APR-1' } }, res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect(readAuth).toHaveBeenCalledOnce();
    expect(mocks.readResult).toHaveBeenCalledWith({ approvalId: 'APR-1', actorId: 'applicant', roles: [] });
    expect(res.body.result.approvalId).toBe('APR-1');
  });
});
