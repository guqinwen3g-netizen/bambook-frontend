import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
const auth = vi.hoisted(() => ({ actor: { userId: 'lead', roles: ['sales_manager'], permissions: ['orders:read', 'orders:write'] }, visible: true }));
vi.mock('../orderLineWriteAccess', async original => ({ ...await original<typeof import('../orderLineWriteAccess')>(),
  currentOrderLineWriteActor: vi.fn(async () => auth.actor), freshOrderLineScope: vi.fn(async () => ({})) }));
vi.mock('../orderLifecycleService', () => ({ evaluateOrderConfirmGates: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../../entities/sync', () => ({ syncOrderEntityReferences: vi.fn(async () => undefined) }));
vi.mock('../../events/businessEventBus', () => ({ persistBusinessEventInTransaction: vi.fn(async () => undefined), publishBusinessEvent: vi.fn(async () => undefined) }));
import { createOrderMainApprovalService } from '../orderMainApprovalService';
import { orderMainSnapshotFingerprint } from '../orderMainApprovalEvidence';
import { approvalReviewContentVersion } from '../../approvals/approvalReviewContent';
function fixture() {
  const order = { id: 'order', ownerId: 'lead', status: 'Pending', type: 'fabric', businessLine: 'fabric', deletedAt: null,
    lines: [{ id: 'line', orderId: 'order', quantity: '100', unit: 'M' }] };
  const snapshot = structuredClone({ order, businessLine: 'fabric' });
  const approval: any = { id: 'approval', targetId: 'order', targetType: 'Order', actionType: 'order:main_approval', requesterId: 'lead',
    eligibleReviewerIds: ['lead'], status: 'pending', reviewerId: null, createdAt: new Date(),
    payload: { schemaVersion: 1, round: 1, businessLine: 'fabric', snapshot, contentFingerprintAlgorithm: 'canonical_v1', contentFingerprint: orderMainSnapshotFingerprint(snapshot) } };
  const audits: any[] = [];
  const tx: any = { $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
    orderApprovalAuthority: { findMany: vi.fn(async () => [{ userId: 'lead' }]) }, userAccount: { findMany: vi.fn(async () => []) },
    order: { findUnique: vi.fn(async () => order), findFirst: vi.fn(async () => auth.visible ? order : null), findUniqueOrThrow: vi.fn(async () => order),
      updateMany: vi.fn(async ({ data }) => { Object.assign(order, data); return { count: 1 }; }) },
    approvalRequest: { findUnique: vi.fn(async () => approval),
      updateMany: vi.fn(async ({ where, data }) => { if (approval.status !== where.status) return { count: 0 }; Object.assign(approval, data); return { count: 1 }; }),
      findMany: vi.fn(async () => [approval]) },
    orderStatusTransition: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async ({ data }) => { audits.push(data); return data; }),
      findFirst: vi.fn(async ({ where }) => audits.find(row => row.actorId === where.actorId && row.action === where.action
        && (!where.targetId || row.targetId === where.targetId) && (!where.detail || row.detail.after.requestKey === where.detail.equals)) ?? null) } };
  const db: any = { ...tx, $transaction: vi.fn(async run => run(tx)) };
  const command = { approvalId: 'approval', actorId: 'lead', decision: 'rejected' as const, trustedActor: auth.actor as any,
    rejectionReason: '合同交期不一致', requestedChanges: '逐条核对交期并重新提交', reviewContentVersion: approvalReviewContentVersion(approval) };
  return { db, tx, order, approval, audits, command };
}
beforeEach(() => { auth.actor = { userId: 'lead', roles: ['sales_manager'], permissions: ['orders:read', 'orders:write'] }; auth.visible = true; });
describe('main approval first decision and explicit correction facts', () => {
  it('records separate reason and requested changes without allowing a note to substitute either field', async () => {
    const f = fixture(), service = createOrderMainApprovalService(f.db);
    await expect(service.decide({ ...f.command, rejectionReason: '', note: 'a combined note is not two facts' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f.tx.approvalRequest.updateMany).not.toHaveBeenCalled();
    const frozen = JSON.stringify(f.approval.payload);
    const result = await service.decide(f.command);
    expect(result).toMatchObject({ status: 'rejected', reviewerId: 'lead', rejectionReason: f.command.rejectionReason, requestedChanges: f.command.requestedChanges });
    expect(f.order.status).toBe('Pending'); expect(JSON.stringify(f.approval.payload)).toBe(frozen);
    expect(f.audits.at(-1).detail.after).toMatchObject({ rejectionReason: f.command.rejectionReason, requestedChanges: f.command.requestedChanges });
  });
  it('allows a qualified business leader to approve their own order once', async () => {
    const f = fixture();
    const result = await createOrderMainApprovalService(f.db).decide({ ...f.command, decision: 'approved' });
    expect(result).toMatchObject({ requesterId: 'lead', reviewerId: 'lead', status: 'approved' });
    expect(f.order.status).toBe('Confirmed'); expect(f.tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
    await expect(createOrderMainApprovalService(f.db).decide({ ...f.command, decision: 'approved' })).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
    expect(f.tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
  });
  it('fails a stale reviewed version, current source withdrawal and role-only grants before any decision write', async () => {
    const f = fixture(), service = createOrderMainApprovalService(f.db);
    await expect(service.decide({ ...f.command, reviewContentVersion: '0'.repeat(64) })).rejects.toMatchObject({ code: 'ORDER_APPROVAL_CONTENT_CHANGED' });
    auth.visible = false;
    await expect(service.decide(f.command)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    auth.visible = true; auth.actor.permissions = ['orders:read'];
    await expect(service.decide(f.command)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.tx.approvalRequest.updateMany).not.toHaveBeenCalled();
  });
  it('maps a real serialization conflict to a readback without running a second decision', async () => {
    const f = fixture();
    f.db.$transaction.mockImplementationOnce(async () => { f.approval.status = 'approved'; f.approval.reviewerId = 'another-lead';
      throw new Prisma.PrismaClientKnownRequestError('serialization conflict', { code: 'P2034', clientVersion: 'unit' }); });
    await expect(createOrderMainApprovalService(f.db).decide(f.command)).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED', statusCode: 409 });
    expect(f.db.$transaction).toHaveBeenCalledTimes(1); expect(f.tx.approvalRequest.updateMany).not.toHaveBeenCalled();
  });
  it('withdraws with immutable original receipt and cannot replay a changed reason or revoke a completed decision', async () => {
    const f = fixture(), service = createOrderMainApprovalService(f.db);
    const input = { approvalId: 'approval', actor: auth.actor as any, requestKey: 'withdraw-original', reviewContentVersion: f.command.reviewContentVersion, reason: '补充准确销售合同附件' };
    const before = JSON.stringify(f.approval.payload);
    const first = await service.withdraw(input), replay = await service.withdraw(input);
    expect(first.item.status).toBe('cancelled'); expect(replay.replayed).toBe(true); expect(replay.commandAck).toEqual(first.commandAck);
    expect(JSON.stringify(f.approval.payload)).toBe(before); expect(f.tx.approvalRequest.updateMany).toHaveBeenCalledTimes(1);
    await expect(service.withdraw({ ...input, reason: '另一撤回原因' })).rejects.toMatchObject({ code: 'ORDER_APPROVAL_CONFLICT' });
    await expect(service.withdraw({ ...input, requestKey: 'different-new-key' })).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
  });
});
