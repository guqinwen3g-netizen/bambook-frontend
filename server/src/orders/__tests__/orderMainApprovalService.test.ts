import { beforeEach, describe, expect, it, vi } from 'vitest';
const writeAccess = vi.hoisted(() => ({ authorize: vi.fn(), currentActor: vi.fn() }));
vi.mock('../orderLineWriteAccess', () => ({ authorizeOrderLineWrite: writeAccess.authorize, currentOrderLineWriteActor: writeAccess.currentActor }));
import { createOrderMainApprovalService, orderApprovalBusinessLine, OrderMainApprovalError } from '../orderMainApprovalService';
import { SYSTEM_ROLE_IDS } from '../../_shared/rolePermissionMatrix';

function makeOrder(businessLine: string) {
  return { id: 'ORD-1', status: 'Pending', businessLine, type: businessLine, deletedAt: null,
    lines: [{ id: 'LINE-1', itemNo: '1', quantity: 10, ...(businessLine === 'garment' ? { fulfillmentMode: 'cmt', cmtIncludedItems: [] } : {}) }] };
}
function submitPrisma(opts: { businessLine: string; domains?: string[]; owners?: string[]; approvals?: any[] }) {
  const order = makeOrder(opts.businessLine);
  const tx: any = {
    $queryRaw: vi.fn(),
    order: { findUnique: vi.fn().mockResolvedValue(order) },
    approvalRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue(opts.approvals || []),
      create: vi.fn().mockImplementation(async ({ data }) => data),
    },
    orderApprovalAuthority: { findMany: vi.fn().mockImplementation(async ({ where }) => (opts.domains || []).includes(where.businessLine) ? [{ userId: 'lead-1' }] : []) },
    userAccount: { findMany: vi.fn().mockResolvedValue((opts.owners || []).map(id => ({ id }))) },
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) };
  return { prisma, tx };
}
beforeEach(() => { writeAccess.authorize.mockReset().mockResolvedValue({}); writeAccess.currentActor.mockReset().mockResolvedValue({ userId: 'lead-1' }); });

describe('order main approval explicit authority', () => {
  it('checks the actual current account and signed credential ceiling before a main decision', async () => {
    const { prisma } = submitPrisma({ businessLine: 'fabric', domains: ['fabric'] });
    const actor = { userId: 'lead-1', permissionCeiling: ['orders:read'] } as any;
    const denial = Object.assign(Error('Current main approval write authority denied'), { code: 'FORBIDDEN', statusCode: 403 });
    writeAccess.currentActor.mockRejectedValueOnce(denial);
    await expect(createOrderMainApprovalService(prisma).decide({ approvalId: 'OAP-1', actorId: actor.userId, decision: 'rejected', trustedActor: actor }))
      .rejects.toBe(denial);
    expect(writeAccess.currentActor).toHaveBeenCalledWith(prisma, actor, 'update');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('passes the signed credential ceiling through the shared fresh write gate before creating an approval', async () => {
    const { prisma, tx } = submitPrisma({ businessLine: 'fabric', domains: ['fabric'] });
    const actor = { userId: 'submitter', permissionCeiling: ['orders:read'] } as any;
    const denial = Object.assign(Error('Current write grant revoked'), { code: 'FORBIDDEN', statusCode: 403 });
    writeAccess.authorize.mockRejectedValueOnce(denial);
    await expect(createOrderMainApprovalService(prisma).submit('ORD-1', 'submitter', actor)).rejects.toBe(denial);
    expect(writeAccess.authorize).toHaveBeenCalledWith(tx, 'ORD-1', actor, 'update');
    expect(tx.approvalRequest.create).not.toHaveBeenCalled();
  });
  it('requires a configured approver in the matching business domain even when the boss is globally eligible', async () => {
    const { prisma } = submitPrisma({ businessLine: 'fabric', domains: [], owners: ['owner-1'] });
    await expect(createOrderMainApprovalService(prisma).submit('ORD-1', 'submitter'))
      .rejects.toMatchObject({ code: 'ORDER_APPROVAL_AUTHORITY_MISSING', statusCode: 409 });
  });

  it('freezes only same-domain configured accounts plus the global boss as recipients', async () => {
    const { prisma, tx } = submitPrisma({ businessLine: 'fabric', domains: ['fabric'], owners: ['boss-1'] });
    const request = await createOrderMainApprovalService(prisma).submit('ORD-1', 'submitter');
    expect(request.actionType).toBe('order:main_approval');
    expect(request.eligibleReviewerIds).toEqual(['boss-1', 'lead-1']);
    expect((request.payload as any).businessLine).toBe('fabric');
    expect((request.payload as any).snapshot.order.lines).toHaveLength(1);
    expect(tx.approvalRequest.create).toHaveBeenCalledOnce();
  });

  it('does not treat fabric authority as garment authority', async () => {
    const { prisma } = submitPrisma({ businessLine: 'garment', domains: ['fabric'], owners: ['boss-1'] });
    await expect(createOrderMainApprovalService(prisma).submit('ORD-1', 'submitter'))
      .rejects.toMatchObject({ code: 'ORDER_APPROVAL_AUTHORITY_MISSING' });
  });

  it('fails closed on unknown business-line values', () => {
    expect(() => orderApprovalBusinessLine({ businessLine: 'capsule', type: 'other' }))
      .toThrowError(OrderMainApprovalError);
    expect(SYSTEM_ROLE_IDS.SUPER_ADMIN).toBeTruthy();
  });
});
