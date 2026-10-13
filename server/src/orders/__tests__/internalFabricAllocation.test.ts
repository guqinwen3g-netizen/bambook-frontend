import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const authority = vi.hoisted(() => ({ write: true, demandMember: true, currentLoads: 0, owner: false }));
vi.mock('../../auth/tokenHelpers', () => ({
  loadUserWithRoles: vi.fn(async () => ({ id: 'sales', status: 'active', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async () => ({ userId: 'sales', roles: authority.owner ? ['owner'] : [], roleIds: authority.owner ? ['role-super-admin'] : [], permissions: ['orders:read', ...(authority.write ? ['orders:write'] : [])], authorizationLoaded: true })),
}));
vi.mock('../orderLineWriteAccess', async () => {
  const actual = await vi.importActual<typeof import('../orderLineWriteAccess')>('../orderLineWriteAccess');
  return { ...actual, freshOrderLineScope: vi.fn(async () => ({})),
    currentOrderLineWriteActor: vi.fn(async (_db, prior) => { authority.currentLoads++; if (!authority.write || prior.permissionCeiling?.length === 0) throw new Error('fresh grant revoked'); return { userId: 'sales', roles: authority.owner ? ['owner'] : [], roleIds: authority.owner ? ['role-super-admin'] : [], authorizationLoaded: true, permissions: ['orders:read', 'orders:write'] }; }),
    authorizeOrderLineWrite: vi.fn(async (db, id, prior) => { if (!authority.write || prior.permissionCeiling?.length === 0) throw new Error('fresh grant revoked'); return { actor: { userId: 'sales', roles: authority.owner ? ['owner'] : [], roleIds: authority.owner ? ['role-super-admin'] : [], authorizationLoaded: true, permissions: ['orders:write'] }, order: await db.order.findFirst({ where: { id } }) }; }),
  };
});
import { createInternalFabricAllocationService } from '../internalFabricAllocationService';

const actor = { userId: 'sales', roles: [], permissions: ['orders:read', 'orders:write'], departmentIds: [] } as any;
function fixture() {
  const orders = [ { id: 'G', type: 'Garment', status: 'Confirmed' }, { id: 'F', type: 'Fabric', status: 'Confirmed', orderPurpose: 'internal_fabric_supply', internalPurpose: '准确供料', internalDemandTeamId: 'GT', internalReceiverId: 'receiver' } ];
  const lines = [ { id: 'GL', orderId: 'G', fulfillmentMode: 'full_package', cmtIncludedItems: [] }, { id: 'FL', orderId: 'F', quantity: new Prisma.Decimal('1.0001'), unit: 'M' } ];
  const allocations: any[] = [], audits: any[] = [];
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
    order: { findFirst: vi.fn(async ({ where }: any) => orders.find(o => o.id === where.id) ?? null) },
    orderLine: { findUnique: vi.fn(async ({ where }: any) => lines.find(l => l.id === where.id) ?? null) },
    team: { findFirst: vi.fn(async () => ({ id: 'GT', name: '实际成衣组', department: { parentId: 'company', status: 'active', metadata: { businessAttributes: ['garment_business'] } }, status: 'active' })) },
    teamMember: { findFirst: vi.fn(async ({ where }: any) => where.userId === 'receiver' || authority.demandMember ? { userId: where.userId, leftAt: null } : null) },
    userAccount: { findFirst: vi.fn(async () => ({ id: 'receiver', status: 'active' })) },
    approvalRequest: { findFirst: vi.fn(async () => ({ id: 'approved' })) },
    fabricLineAllocation: {
      findUnique: vi.fn(async ({ where }: any) => allocations.find(a => where.id ? a.id === where.id : a.garmentOrderLineId === where.garmentOrderLineId) ?? null),
      findMany: vi.fn(async ({ where }: any) => allocations.filter(a => a.fabricOrderLineId === where.fabricOrderLineId && a.status === where.status)),
      upsert: vi.fn(async ({ where, create, update }: any) => { const old = allocations.find(a => a.garmentOrderLineId === where.garmentOrderLineId); if (old) Object.assign(old, update); else allocations.push(create); return old ?? create; }),
    },
    auditLog: { findUnique: vi.fn(async ({ where }: any) => audits.find(a => a.id === where.id) ?? null), create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }) },
  };
  const service = createInternalFabricAllocationService({ prisma: { $transaction: async (work: any) => work(tx) }, clock: () => 2000000000000 });
  return { service, tx, allocations, audits };
}
const command = { requestKey: 'original-key', fabricOrderLineId: 'FL', metres: '0.5001', expectedRevision: 0 };
beforeEach(() => { authority.write = true; authority.demandMember = true; authority.currentLoads = 0; authority.owner = false; });
describe('durable exact internal metre commands', () => {
  it('returns both creation domains for a current owner without trusting caller role claims', async () => {
    const teams = [
      { id: 'fabric', name: '面料一组', status: 'active', department: { parentId: 'company', status: 'active', metadata: { businessAttributes: ['fabric_business'] } }, members: [] },
      { id: 'garment', name: '成衣一组', status: 'active', department: { parentId: 'company', status: 'active', metadata: { businessAttributes: ['garment_business'] } }, members: [] },
      { id: 'qc', name: '成衣QC', metadata: { businessFamily: 'garment', scenarioGroupKind: 'qc' }, members: [] },
      { id: 'logistics', name: '后勤单证', metadata: { scenarioGroupKind: 'logistics' }, members: [] },
    ];
    const prisma = { team: { findMany: vi.fn(async () => teams) }, userAccount: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => ({ primaryDeptId: 'dept' })) }, teamMember: { findMany: vi.fn(async () => []) } };
    const service = createInternalFabricAllocationService({ prisma });
    expect((await service.personnel({ ...actor, roles: ['owner'], roleIds: ['role-super-admin'] })).creatorFamilies).toEqual([]);
    authority.owner = true;
    const directory = await service.personnel(actor);
    expect(directory.creatorFamilies).toEqual(['fabric', 'garment']);
    expect(directory.teams.map((team: any) => team.id)).toEqual(['fabric', 'garment']);
    expect((await service.personnel({ ...actor, permissionCeiling: ['orders:read'] })).canWrite).toBe(false);
  });
  it('lets the current owner allocate across teams but still requires a valid receiving member', async () => {
    authority.owner = true; authority.demandMember = false;
    const f = fixture();
    expect((await f.service.allocate(actor, 'G', 'GL', command)).allocation.metres).toBe('0.5001');
    const stale = fixture(); stale.tx.teamMember.findFirst.mockResolvedValue(null);
    await expect(stale.service.allocate(actor, 'G', 'GL', command)).rejects.toThrow('已失效');
  });
  it('locks shared source and target before storing exact decimal plus a stable audited receipt', async () => {
    const f = fixture();
    f.allocations.push({ id: 'other', fabricOrderLineId: 'FL', garmentOrderLineId: 'other-line', status: 'active', metres: new Prisma.Decimal('0.5') });
    const result = await f.service.allocate(actor, 'G', 'GL', command);
    expect(result.commandAck).toMatchObject({ requestKey: command.requestKey, metres: '0.5001', revision: 1 });
    expect(result.allocation.metres).toBe('0.5001');
    expect(f.tx.$queryRaw.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(f.audits).toHaveLength(1); expect(f.allocations.find(a => a.garmentOrderLineId === 'GL').metres.toString()).toBe('0.5001');
  });
  it('rejects over-allocation before an audit or allocation is stored', async () => {
    const f = fixture(); f.allocations.push({ id: 'other', fabricOrderLineId: 'FL', garmentOrderLineId: 'other-line', status: 'active', metres: new Prisma.Decimal('0.5001') });
    await expect(f.service.allocate(actor, 'G', 'GL', command)).rejects.toThrow('超过');
    expect(f.tx.fabricLineAllocation.upsert).not.toHaveBeenCalled(); expect(f.audits).toHaveLength(0);
  });
  it('recovers the original success after later cancellation and refuses key parameter drift', async () => {
    const f = fixture(), original = await f.service.allocate(actor, 'G', 'GL', command);
    const cancelled = await f.service.cancel(actor, original.allocation.id, { requestKey: 'cancel-key', expectedRevision: 1 });
    expect(cancelled.allocation.status).toBe('cancelled'); expect(cancelled.allocation.revision).toBe(2);
    expect(await f.service.allocate(actor, 'G', 'GL', command)).toEqual(original);
    await expect(f.service.allocate(actor, 'G', 'GL', { ...command, metres: '0.4' })).rejects.toThrow('请求键');
    expect(f.audits).toHaveLength(2); expect(f.allocations[0].status).toBe('cancelled');
  });
  it('rechecks grants, ceiling and actual receiving-team membership even for an old request', async () => {
    const f = fixture(); await f.service.allocate(actor, 'G', 'GL', command);
    authority.write = false; await expect(f.service.allocate(actor, 'G', 'GL', command)).rejects.toThrow('revoked');
    authority.write = true; await expect(f.service.allocate({ ...actor, permissionCeiling: [] }, 'G', 'GL', command)).rejects.toThrow('revoked');
    authority.demandMember = false; await expect(f.service.allocate(actor, 'G', 'GL', command)).rejects.toThrow('实际需求团队');
    expect(f.audits).toHaveLength(1);
  });
});
