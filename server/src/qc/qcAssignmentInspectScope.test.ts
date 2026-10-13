import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../auth/service';
import { qcAssignmentAccess } from './qcAssignmentAccess';
import { assertQcAssignmentUser, listQcAssignmentUsers, type QcAssignmentUserOption } from './qcAssignmentUsers';
import { qcOrderInspectionScope } from './qcExecutionScope';

const state = vi.hoisted(() => ({ users: new Map<string, any>(), visible: true,
  lock: undefined as (() => void) | undefined }));
vi.mock('../auth/tokenHelpers', () => ({
  loadUserWithRoles: vi.fn(async (_db: unknown, id: string) => state.users.get(id)),
  buildLoadedAuthTokenPayload: vi.fn(async (_db: unknown, user: any) => ({
    userId: user.id, roles: [...user.roles], permissions: [...user.permissions], authorizationLoaded: true,
  })),
}));
vi.mock('../orders/orderLineWriteAccess', () => ({
  freshOrderLineScope: vi.fn(async () => ({ ownerId: 'business' })), isOrderLineStorageConflict: () => false,
}));
const professional = ['qc:read', 'qc:inspect', 'qc:fabric_chain:write'];
const prior = (userId: string, permissionCeiling?: string[]): TokenPayload => ({ userId,
  roles: ['viewer'], permissions: professional, departmentIds: [], ...(permissionCeiling === undefined ? {} : { permissionCeiling }) });
function user(id: string, permissions: string[], roles: string[] = ['viewer']) {
  const row = { id, displayName: id, status: 'active', deletedAt: null, permissions, roles };
  state.users.set(id, row); return row;
}
function fixture() {
  const assignment = { id: 'TASK', orderId: 'ORDER', qcUserId: 'qc', deletedAt: null };
  const db: any = { $queryRaw: vi.fn(async () => { state.lock?.(); return [{ id: 'locked' }]; }),
    order: { findUnique: async () => ({ id: 'ORDER', businessLine: 'fabric', deletedAt: null }),
      findFirst: async () => state.visible ? { id: 'ORDER', businessLine: 'fabric', deletedAt: null } : null },
    qCAssignment: { findUnique: async () => assignment },
    userAccount: { findMany: async () => [...state.users.values()].map(row => ({ id: row.id })) },
    $transaction: async (work: (tx: unknown) => unknown) => work(db) };
  return { db, assignment };
}
beforeEach(() => { state.users.clear(); state.visible = true; state.lock = undefined; vi.clearAllMocks();
  user('qc', professional); user('business', ['qc:read', 'qc:write'], ['sales']); });

describe('professional QC execution grants', () => {
  it('uses explicit business family before legacy order type, matching the professional UI', () => {
    expect(qcOrderInspectionScope({ businessLine: 'fabric', type: 'Garment' })).toBe('qc:fabric_chain:write');
    expect(qcOrderInspectionScope({ businessLine: 'garment', type: 'Fabric' })).toBe('qc:garment_chain:write');
    expect(qcOrderInspectionScope({ type: 'Apparel' })).toBe('qc:garment_chain:write');
    expect(qcOrderInspectionScope({ type: 'Other' })).toBeNull();
  });
  it('allows a real currently assigned professional and preserves business dispatch without inspection rights', async () => {
    const { db } = fixture();
    expect((await qcAssignmentAccess(db, prior('qc'), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect', lock: true })).delegated).toBe(false);
    await expect(qcAssignmentAccess(db, prior('business'), { orderId: 'ORDER', mode: 'manage', lock: true })).resolves.toMatchObject({ actor: { userId: 'business' } });
  });
  it.each(['sales', 'admin', 'owner'])('does not turn a %s identity or stale token into a professional inspection grant', async role => {
    const { db, assignment } = fixture(); user('business', ['qc:read', 'qc:write'], [role]); assignment.qcUserId = 'business';
    await expect(qcAssignmentAccess(db, prior('business'), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('keeps a signed credential ceiling over current professional and wildcard grants', async () => {
    const { db } = fixture();
    await expect(qcAssignmentAccess(db, prior('qc', ['qc:read', 'qc:write']), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    user('qc', ['*']);
    await expect(qcAssignmentAccess(db, prior('qc', ['qc:read', 'qc:write']), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(qcAssignmentAccess(db, prior('qc', ['*']), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).resolves.toMatchObject({ actor: { userId: 'qc' } });
  });
  it('reloads the professional grant after locks and rejects a revocation that won the lock', async () => {
    const { db } = fixture(); state.lock = () => { state.users.get('qc').permissions = ['qc:read', 'qc:write']; };
    await expect(qcAssignmentAccess(db, prior('qc'), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect', lock: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it('preserves current assignee and order L2 checks after the professional grant', async () => {
    const { db, assignment } = fixture(); assignment.qcUserId = 'another';
    await expect(qcAssignmentAccess(db, prior('qc'), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    user('qc', professional, ['admin']); state.visible = false;
    await expect(qcAssignmentAccess(db, prior('qc'), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('does not execute another professional business family with inspect alone', async () => {
    const { db } = fixture(); user('qc', ['qc:read', 'qc:inspect', 'qc:garment_chain:write']);
    await expect(qcAssignmentAccess(db, prior('qc'), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('fails closed if fresh account or professional authorization cannot be loaded', async () => {
    const { db } = fixture(); state.users.get('qc').status = 'disabled';
    await expect(qcAssignmentAccess(db, prior('qc'), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    state.users.get('qc').status = 'active'; state.users.get('qc').permissions = undefined;
    await expect(qcAssignmentAccess(db, prior('qc'), { orderId: 'ORDER', assignmentId: 'TASK', mode: 'inspect' })).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  });
});

describe('professional QC dispatch directory', () => {
  it('rejects business self-assignment and lists only current actual professional grants', async () => {
    const { db } = fixture();
    await expect(assertQcAssignmentUser(db, 'business')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(assertQcAssignmentUser(db, 'qc')).resolves.toBeUndefined();
    const result = await listQcAssignmentUsers(db, prior('business'));
    expect(result.users.map((row: QcAssignmentUserOption) => row.id)).toEqual(['qc']);
    const sql = db.$queryRaw.mock.calls.map(([query]: [{ strings: string[] }]) => query.strings.join(' '));
    for (const table of ['RolePermission', 'Permission', 'UserPermissionOverrides']) {
      expect(sql.find((text: string) => text.includes(`FROM "${table}"`))).toContain("'qc:inspect'");
    }
  });
  it('rechecks fresh recipient status and grants even when a prior picker showed the person', async () => {
    const { db } = fixture(); expect((await listQcAssignmentUsers(db, prior('business'))).users).toHaveLength(1);
    state.users.get('qc').permissions = ['qc:read', 'qc:write'];
    await expect(assertQcAssignmentUser(db, 'qc')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await listQcAssignmentUsers(db, prior('business'))).users).toHaveLength(0);
  });
  it('does not dispatch a professional to another business family or an unclassified order', async () => {
    const { db } = fixture();
    await expect(assertQcAssignmentUser(db, 'qc', 'qc:fabric_chain:write')).resolves.toBeUndefined();
    await expect(assertQcAssignmentUser(db, 'qc', 'qc:garment_chain:write')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(assertQcAssignmentUser(db, 'qc', null)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
