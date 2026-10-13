/** Unit boundary only. Synthetic DB rows do not prove actual PG/JWT/RLS or UAT. */
import { describe, expect, it, vi } from 'vitest';
import { createInternalTransferService } from '../internalTransferService';
import type { TokenPayload } from '../../auth/service';

function fixture(scopes = ['orders:read'], roleId = 'custom-internal-reader') {
  const user: any = { id: 'reader', status: 'active', primaryDeptId: null, roles: [{ departmentId: null, role: { id: roleId, permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
  const orders: any[] = [{ id: 'G1', deletedAt: null, customerRelationId: null, ownerId: 'reader' }, { id: 'F1', deletedAt: null, customerRelationId: null, ownerId: 'reader' }, { id: 'FG', deletedAt: null, customerRelationId: null, ownerId: 'other' }];
  const payload = (id: string, peer: string) => ({ docType: 'DR033_INTERNAL_FABRIC_SUPPLY', role: 'master', masterId: id, mirrorId: `${id}-mirror`, garmentOrderId: 'G1', fabricOrderId: peer, settlementPrice: 30, status: 'Effective', deliveries: [] });
  const rows: any[] = ['F1', 'FG'].flatMap((peer, i) => { const id = `M${i}`, value = payload(id, peer); return [{ id, orderId: 'G1', deletedAt: null, transferDirection: 'incoming', memo: JSON.stringify(value) }, { id: `${id}-mirror`, orderId: peer, deletedAt: null, transferDirection: 'outgoing', memo: JSON.stringify({ ...value, role: 'mirror' }) }]; });
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: any) => {
    if (key === 'AND') return value.every((part: any) => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object') return 'in' in value ? value.in.includes(row[key]) : 'not' in value ? row[key] !== value.not : false;
    return row[key] === value;
  });
  const db: any = { userAccount: { findFirst: vi.fn(async ({ where }: any) => matches(user, { ...where, deletedAt: undefined }) && user.deletedAt == null ? { id: user.id } : null), findUnique: vi.fn(async () => user) }, userPermissionOverrides: { findMany: vi.fn(async () => []) }, teamMember: { findMany: vi.fn(async () => []) }, order: { findMany: vi.fn(async ({ where }: any) => orders.filter(row => matches(row, where))) }, orderInternalTransfer: { findUnique: vi.fn(async ({ where }: any) => rows.find(row => row.id === where.id) ?? null), findMany: vi.fn(async ({ where }: any) => rows.filter(row => matches(row, where))) }, $transaction: vi.fn(async (work: any) => work(db)) };
  db.relation = { findMany: vi.fn(async () => []) };
  const service = createInternalTransferService({ prisma: db, approvalCreateService: {} as any });
  const actor: TokenPayload = { userId: 'reader', roles: [], permissions: ['orders:read'], authorizationLoaded: true };
  return { service, db, user, orders, rows, actor };
}

describe('internal handoff read fresh grants/ceiling/both orders', () => {
  it('orders read sees the approved handoff price without sensitive cost, after BOTH order scopes', async () => {
    const x = fixture();
    expect((await x.service.getInternalTransferById('M0-mirror', x.actor))?.payload?.settlementPrice).toBe(30);
    const list = await x.service.listInternalTransfers({ trustedActor: x.actor, limit: 1 });
    expect(list.total).toBe(1); expect(list.items.map(row => row.record.id)).toEqual(['M0']);
    expect(await x.service.getInternalTransferById('M1', x.actor)).toBeNull();
    expect(x.db.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, AND: [expect.objectContaining({ OR: expect.any(Array) })] }, select: { id: true } }));
  });
  it('explicit internal write grant is the compatible read path; loaded empty scopes cannot borrow old JWT', async () => {
    const x = fixture(['order:internal_trade:write']); expect(await x.service.getInternalTransferById('M0', x.actor)).not.toBeNull();
    x.user.roles[0].role.permissions = [];
    await expect(x.service.getInternalTransferById('M0', x.actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('limited owner ceiling denies handoff reads despite current super-admin identity', async () => {
    const x = fixture(['orders:read'], 'role-super-admin');
    await expect(x.service.listInternalTransfers({ trustedActor: { ...x.actor, roles: ['owner'], permissionCeiling: ['pricing:read'] } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('missing actor, current disabled/soft-deleted account cannot read; DB lookup failures are visible', async () => {
    const x = fixture(); await expect(x.service.getInternalTransferById('M0')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    x.user.status = 'disabled'; await expect(x.service.getInternalTransferById('M0', x.actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    x.user.status = 'active'; x.user.deletedAt = 1n; await expect(x.service.getInternalTransferById('M0', x.actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    x.user.deletedAt = undefined; x.db.orderInternalTransfer.findUnique.mockRejectedValueOnce(new Error('synthetic DB unavailable'));
    await expect(x.service.getInternalTransferById('M0', x.actor)).rejects.toThrow('synthetic DB unavailable');
  });
});
