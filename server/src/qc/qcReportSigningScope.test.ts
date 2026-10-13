import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../auth/service';
import { qcReportAccess } from './qcReportAuthority';
import { createQcService } from './qcService';

type Account = { id: string; status: string; deletedAt: null; roles: string[]; permissions: string[] };
const state = vi.hoisted(() => ({ users: new Map<string, Account>(), visible: true,
  lock: undefined as (() => void) | undefined, audit: vi.fn() }));
vi.mock('../auth/tokenHelpers', () => ({
  loadUserWithRoles: vi.fn(async (_db: unknown, id: string) => state.users.get(id)),
  buildLoadedAuthTokenPayload: vi.fn(async (_db: unknown, user: Account) => ({
    userId: user.id, roles: [...user.roles], permissions: [...user.permissions], authorizationLoaded: true,
  })),
}));
vi.mock('../orders/orderLineWriteAccess', () => ({
  freshOrderLineScope: vi.fn(async () => ({ ownerId: 'business' })), isOrderLineStorageConflict: () => false,
}));
vi.mock('../audit/routeAudit', () => ({ writeRouteAuditLog: (...args: unknown[]) => state.audit(...args) }));

const professional = ['qc:read', 'qc:inspect', 'qc:garment_chain:write'];
const prior = (userId: string, permissionCeiling?: string[]): TokenPayload => ({ userId,
  roles: ['admin'], permissions: ['*'], departmentIds: [],
  ...(permissionCeiling === undefined ? {} : { permissionCeiling }) });
function user(id: string, permissions: string[], roles: string[] = ['viewer']) {
  const row = { id, status: 'active', deletedAt: null, permissions, roles };
  state.users.set(id, row); return row;
}
function fixture() {
  const order = { id: 'ORDER', businessLine: 'garment', type: 'Fabric', deletedAt: null,
    ownerId: 'business', departmentId: 'DEPARTMENT' };
  const report = { id: 'REPORT', orderId: order.id, inspectedBy: 'qc',
    signatures: { chain: { disposition: 'STANDARD' } } as Record<string, unknown>, updatedAt: 1n };
  const update = vi.fn(async ({ data }: { data: { signatures: Record<string, unknown>; updatedAt: bigint } }) => {
    Object.assign(report, data); return report;
  });
  const db: any = { $queryRaw: vi.fn(async () => { state.lock?.(); return [{ id: 'locked' }]; }),
    order: { findUnique: async () => order, findFirst: async () => state.visible ? order : null },
    inspectionReport: { findUnique: async () => ({ ...report }), update },
    department: { findUnique: async () => ({ id: 'DEPARTMENT', status: 'active', headId: 'manager' }) },
    $transaction: async (work: (tx: unknown) => unknown) => work(db) };
  return { db, report, order, update, service: createQcService(db) };
}
beforeEach(() => { vi.clearAllMocks(); state.users.clear(); state.visible = true; state.lock = undefined;
  user('qc', professional); user('business', ['qc:read', 'qc:write'], ['sales']);
  user('manager', ['qc:read', 'qc:write'], ['sales_manager']); });

describe('QC report signing with current professional and business responsibility', () => {
  it('lets the actual inspect-only professional sign QC without business write or order-wide visibility', async () => {
    const { service, report, update } = fixture(); state.visible = false;
    const signed = await service.signReport(report.id, 'qc', 'qc', null, prior('qc'));
    expect(signed.signatures).toMatchObject({ qcSignerId: 'qc', chain: { disposition: 'STANDARD' } });
    expect(signed.signatures.qcSignedAt).toEqual(expect.any(Number));
    expect(signed.signatures.businessSignedAt).toBeUndefined(); expect(update).toHaveBeenCalledOnce();
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'qc',
      after: expect.objectContaining({ inspectedBy: 'qc', delegated: false }) }));
  });
  it.each(['sales', 'admin', 'owner'])('does not let %s business grants turn even a recorded historical inspector into a QC signer', async role => {
    const { service, report, update } = fixture(); report.inspectedBy = 'business';
    user('business', ['qc:read', 'qc:write', 'qc:garment_chain:write'], [role]);
    await expect(service.signReport(report.id, 'qc', 'business', null, prior('business'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled(); expect(state.audit).not.toHaveBeenCalled();
  });
  it('keeps business signatures with the current responsible owner or active department head and business scope', async () => {
    const { service, report } = fixture();
    expect((await service.signReport(report.id, 'business', 'business', null, prior('business'))).signatures.businessSignerId).toBe('business');
    const second = fixture();
    expect((await second.service.signReport(second.report.id, 'business', 'manager', null, prior('manager'))).signatures.businessSignerId).toBe('manager');
    const third = fixture();
    await expect(third.service.signReport(third.report.id, 'business', 'qc', null, prior('qc'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    user('qc', [...professional, 'qc:write']);
    await expect(third.service.signReport(third.report.id, 'business', 'qc', null, prior('qc'))).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'business_role' });
  });
  it('requires the actual source family and preserves the signed credential ceiling', async () => {
    const { db } = fixture();
    user('qc', ['qc:read', 'qc:inspect', 'qc:fabric_chain:write']);
    await expect(qcReportAccess(db, prior('qc'), 'REPORT', { signRole: 'qc', lock: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    user('qc', professional);
    await expect(qcReportAccess(db, prior('qc', ['qc:read', 'qc:write']), 'REPORT', { signRole: 'qc' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(qcReportAccess(db, prior('qc', ['qc:read', 'qc:inspect']), 'REPORT', { signRole: 'qc' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    user('qc', ['*']);
    await expect(qcReportAccess(db, prior('qc', ['*']), 'REPORT', { signRole: 'qc' })).resolves.toMatchObject({ actor: { userId: 'qc' } });
  });
  it('reloads execution grants after locks and refuses revoked or unknown-family signatures before writing', async () => {
    const { service, order, update } = fixture();
    state.lock = () => { state.users.get('qc')!.permissions = ['qc:read', 'qc:write']; };
    await expect(service.signReport('REPORT', 'qc', 'qc', null, prior('qc'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    state.lock = undefined; user('qc', professional); order.businessLine = 'unknown'; order.type = 'Other';
    await expect(service.signReport('REPORT', 'qc', 'qc', null, prior('qc'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
  });
  it('keeps administrative delegation explicit, professional, and within the current source order scope', async () => {
    const { db } = fixture(); user('delegate', professional, ['admin']);
    await expect(qcReportAccess(db, prior('delegate'), 'REPORT', { signRole: 'qc' })).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'qc_inspector' });
    expect((await qcReportAccess(db, prior('delegate'), 'REPORT', { signRole: 'qc', delegationReason: '原检验人授权复核代签' })).delegated).toBe(true);
    state.visible = false;
    await expect(qcReportAccess(db, prior('delegate'), 'REPORT', { signRole: 'qc', delegationReason: '代签' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    state.visible = true; user('delegate', professional);
    await expect(qcReportAccess(db, prior('delegate'), 'REPORT', { signRole: 'qc', delegationReason: '代签' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('cannot weaken a requested signing side with an explicit read scope and never overwrites an existing signature', async () => {
    const { db, service, report, update } = fixture();
    await expect(qcReportAccess(db, prior('business'), report.id, { scope: 'qc:read', signRole: 'qc' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    report.signatures.qcSignedAt = 123; report.signatures.qcSignerId = 'original';
    await expect(service.signReport(report.id, 'qc', 'qc', null, prior('qc'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', reason: 'already_signed' });
    expect(update).not.toHaveBeenCalled(); expect(report.signatures.qcSignerId).toBe('original');
  });
});
