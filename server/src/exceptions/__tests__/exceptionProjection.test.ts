import { describe, expect, it, vi } from 'vitest';
import { createExceptionService } from '../exceptionService';

// Storage substitutes exercise real projection/CAS/error control. Isolated PG
// acceptance is still required to prove actual transaction and contention.
function fixture(approvalOverrides: any = {}, exceptionOverrides: any = {}) {
  let stored: any = { id: 'exception-projection', exceptionNumber: 'EXC-PROBE', status: 'Pending', approvalRequestId: 'approval-projection', deletedAt: null, exceptionCategory: 'shipment_release', attachments: { files: [], scope: { targetType: 'Shipment', targetId: 'shipment-projection', action: 'shipment:release', maxUses: 1, usedCount: 0, validUntil: null, consumptions: [], responsibleOwnerId: 'followup-person' } }, ...exceptionOverrides };
  const approval: any = { id: 'approval-projection', status: 'approved', reviewerId: 'actual-decider', bossFinalBypassBy: null, ...approvalOverrides };
  const prisma: any = {
    dr013ExceptionRequest: {
      findUnique: vi.fn(async () => ({ ...stored })), findMany: vi.fn(async () => [{ ...stored }]),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (stored.id !== where.id || stored.status !== where.status || stored.approvalRequestId !== where.approvalRequestId || stored.deletedAt != null) return { count: 0 };
        stored = { ...stored, ...data }; return { count: 1 };
      }), update: vi.fn(),
    },
    approvalRequest: { findUnique: vi.fn(async () => approval), findMany: vi.fn(async () => [approval]) },
    auditLog: { create: vi.fn(async ({ data }: any) => data) }, $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: any) => {
    const before = stored;
    try { return await fn(prisma); } catch (error) { stored = before; throw error; }
  });
  const service = createExceptionService({ prisma, approvalCreateService: {} as any });
  return { prisma, service, approval, stored: () => stored };
}

describe('Exception committed fact projection (pure read and callback/CAS)', () => {
  it.each([
    ['approved', 'ReviewerApproved'], ['rejected', 'ReviewerRejected'], ['cancelled', 'Cancelled'], ['pending', 'Pending'],
  ])('read maps committed %s to %s without persisting', async (status, expected) => {
    const { prisma, service, stored } = fixture({ status });
    const result = await service.getExceptionReadonly('exception-projection');
    expect(result).toMatchObject({ ok: true, data: { exception: { status: expected, ...(status !== 'pending' ? { approvalProjectionPending: true } : {}) } } });
    expect(stored().status).toBe('Pending'); expect(prisma.$transaction).not.toHaveBeenCalled(); expect(prisma.dr013ExceptionRequest.updateMany).not.toHaveBeenCalled(); expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('boss fact mirrors actual identity/time/reason read-only, not proof of company-specific bypass eligibility', async () => {
    const { prisma, service } = fixture({ bossFinalBypassBy: 'actual-boss', bossFinalBypassAt: new Date('2026-10-01T01:00:00Z'), bossFinalBypassReason: 'Persisted approval reason; policy checked by decision boundary.' });
    const result = await service.getExceptionReadonly('exception-projection');
    expect(result).toMatchObject({ ok: true, data: { exception: { status: 'BossFinalBypass', bossFinalBypassBy: 'actual-boss', approvalProjectionPending: true } } }); expect(prisma.auditLog.create).not.toHaveBeenCalled(); expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('callback persists once, uses actual committed decider, and lazy/manual read cannot duplicate audit', async () => {
    const { prisma, service, stored } = fixture();
    expect(await service.syncFromApprovalDecision({ approvalRequestId: 'approval-projection' })).toEqual({ ok: true, data: { synced: 1 } });
    expect(await service.syncFromApprovalDecision({ approvalRequestId: 'approval-projection' })).toEqual({ ok: true, data: { synced: 0 } });
    expect(await service.getExceptionById('exception-projection')).toMatchObject({ ok: true, data: { exception: { status: 'ReviewerApproved' } } });
    expect(stored().status).toBe('ReviewerApproved'); expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.dr013ExceptionRequest.updateMany).toHaveBeenCalledWith({ where: { id: 'exception-projection', status: 'Pending', approvalRequestId: 'approval-projection', deletedAt: null }, data: { status: 'ReviewerApproved' } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'actual-decider', action: 'dr013_exception_approved', beforeValue: 'Pending', afterValue: 'ReviewerApproved' }) });
  });
  it('two concurrent callback contenders permit only one CAS winner and success audit', async () => {
    const { prisma, service } = fixture();
    const results = await Promise.all([service.syncFromApprovalDecision({ approvalRequestId: 'approval-projection' }), service.syncFromApprovalDecision({ approvalRequestId: 'approval-projection' })]);
    expect(results).toEqual(expect.arrayContaining([{ ok: true, data: { synced: 1 } }, { ok: true, data: { synced: 0 } }])); expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it('audit failure rolls back and returns retryable failure; later callback completes exactly once', async () => {
    const { prisma, service, stored } = fixture(); prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));
    const failed = await service.syncFromApprovalDecision({ approvalRequestId: 'approval-projection' });
    expect(failed).toMatchObject({ ok: false, error: { code: 'EXCEPTION_APPROVAL_SYNC_FAILED', statusCode: 503 } }); expect(stored().status).toBe('Pending');
    expect(await service.syncFromApprovalDecision({ approvalRequestId: 'approval-projection' })).toEqual({ ok: true, data: { synced: 1 } }); expect(stored().status).toBe('ReviewerApproved');
  });
  it('lost CAS cannot emit a success audit', async () => {
    const { prisma, service } = fixture(); prisma.dr013ExceptionRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.syncFromApprovalDecision({ approvalRequestId: 'approval-projection' })).toEqual({ ok: true, data: { synced: 0 } }); expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('approved list selects committed fact before its result limit, with no read-side persistence', async () => {
    const { prisma, service } = fixture();
    const result = await service.listExceptionsReadonly({ status: 'ReviewerApproved', limit: 1 });
    expect(result).toMatchObject({ ok: true, data: { items: [{ status: 'ReviewerApproved', approvalProjectionPending: true }] } });
    expect(prisma.approvalRequest.findMany).toHaveBeenCalledWith({ where: { status: 'approved', bossFinalBypassBy: null }, select: { id: true } });
    expect(prisma.dr013ExceptionRequest.findMany).toHaveBeenCalledWith({ where: { deletedAt: null, OR: [{ status: 'ReviewerApproved' }, { status: 'Pending', approvalRequestId: { in: ['approval-projection'] } }] }, orderBy: { createdAt: 'desc' }, take: 1 }); expect(prisma.$transaction).not.toHaveBeenCalled(); expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
