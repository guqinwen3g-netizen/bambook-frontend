import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../auth/service';
import { createQcChainService } from './qcChainService';

const state = vi.hoisted(() => ({ permissions: ['qc:read', 'qc:inspect', 'qc:garment_chain:write', 'qc:fabric_chain:write'],
  visible: true, failLoad: false, lock: undefined as (() => void) | undefined }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async () => {
  if (state.failLoad) throw new Error('PRIVATE authorization storage');
  return { id: 'PROFESSIONAL', status: 'active', deletedAt: null };
}), buildLoadedAuthTokenPayload: vi.fn(async () => ({ userId: 'PROFESSIONAL', roles: [], permissions: [...state.permissions],
  authorizationLoaded: true, departmentIds: [] })) }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({ customerRelationId: 'CUSTOMER' })),
  isOrderLineStorageConflict: () => false }));
vi.mock('../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => 'AUDIT') }));
vi.mock('../notifications/notificationService', () => ({ createNotificationService: () => ({ sendToUser: vi.fn(async () => undefined) }) }));
vi.mock('../samples/orderSampleManagedGuard', () => ({ assertGenericSampleMutationAllowed: vi.fn(async () => undefined) }));
vi.mock('../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const prior = (permissionCeiling?: string[]): TokenPayload => ({ userId: 'PROFESSIONAL', roles: ['viewer'], permissions: [],
  departmentIds: [], ...(permissionCeiling === undefined ? {} : { permissionCeiling }) });
function fixture(chain: 'garment' | 'fabric') {
  const order = { id: 'ORDER', businessLine: chain, type: chain, deletedAt: null, customerRelationId: 'CUSTOMER' };
  const reports: any[] = [], sample = { id: 'SAMPLE', sourceOrderId: 'ORDER', type: 'ship', deletedAt: null };
  const tx: any = { order: { findUnique: async () => order, findFirst: async () => state.visible ? order : null },
    inspectionReport: { findUnique: async ({ where }: any) => reports.find(row => row.id === where.id) ?? null,
      findMany: async () => reports, create: vi.fn(async ({ data }: any) => { reports.push(data); return data; }) },
    sample: { findFirst: async () => sample, update: vi.fn(async ({ data }: any) => ({ ...sample, ...data })) },
    $queryRaw: vi.fn(async () => { state.lock?.(); return [{ id: 'ORDER' }]; }),
    $transaction: async (work: (db: unknown) => unknown) => work(tx) };
  return { tx, reports, service: createQcChainService(tx) };
}
function execute(kind: 'garment' | 'fabric' | 'reject', service: ReturnType<typeof createQcChainService>, trustedActor = prior()) {
  const base = { orderId: 'ORDER', actorId: 'PROFESSIONAL', trustedActor };
  return kind === 'fabric' ? service.reviewFabricSample({ ...base,
    input: { sampleKind: 'SS', sampleId: 'SAMPLE', conclusion: 'pass', opinion: '真实检验依据', criticalDefects: 0, majorDefects: 0, minorDefects: 0 } })
    : kind === 'reject' ? service.directlyRejectGarmentSample({ ...base,
      input: { sampleLevel: 'pp', round: 1, conclusion: 'fail', opinion: '实际问题', rejectReason: '实际返工依据', criticalDefects: 0, majorDefects: 1, minorDefects: 0 } })
      : service.reviewGarmentSample({ ...base,
        input: { sampleLevel: 'pp', round: 1, conclusion: 'pass', opinion: '真实检验依据', criticalDefects: 0, majorDefects: 0, minorDefects: 0 } });
}
beforeEach(() => { vi.clearAllMocks(); state.permissions = ['qc:read', 'qc:inspect', 'qc:garment_chain:write', 'qc:fabric_chain:write'];
  state.visible = true; state.failLoad = false; state.lock = undefined; });

describe('order sample QC professional execution boundary', () => {
  it.each(['garment', 'fabric', 'reject'] as const)('allows actual %s inspection without qc:write', async kind => {
    const f = fixture(kind === 'fabric' ? 'fabric' : 'garment');
    expect((await execute(kind, f.service)).ok).toBe(true); expect(f.reports).toHaveLength(1);
    expect(f.reports[0].inspectedBy).toBe('PROFESSIONAL');
  });
  it.each(['garment', 'fabric', 'reject'] as const)('denies business %s writing even when it has the family chain scope', async kind => {
    const f = fixture(kind === 'fabric' ? 'fabric' : 'garment');
    state.permissions = ['qc:read', 'qc:write', 'qc:garment_chain:write', 'qc:fabric_chain:write'];
    expect(await execute(kind, f.service)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.reports).toHaveLength(0); expect(f.tx.sample.update).not.toHaveBeenCalled();
  });
  it('denies a narrower credential, withdrawn professional grant and exact source outside L2', async () => {
    const f = fixture('fabric');
    expect(await execute('fabric', f.service, prior(['qc:read', 'qc:fabric_chain:write']))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    state.lock = () => { state.permissions = ['qc:read', 'qc:fabric_chain:write']; };
    expect(await execute('fabric', f.service)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    state.lock = undefined; state.permissions.push('qc:inspect'); state.visible = false;
    expect(await execute('fabric', f.service)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(f.reports).toHaveLength(0); expect(f.tx.sample.update).not.toHaveBeenCalled();
  });
  it('fails closed without a trusted actor or when fresh account grants are unavailable', async () => {
    const f = fixture('garment');
    const input = { sampleLevel: 'pp', round: 1, conclusion: 'pass', opinion: '实际检验' };
    expect(await f.service.reviewGarmentSample({ orderId: 'ORDER', actorId: 'PROFESSIONAL', input })).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    state.failLoad = true;
    const result = await execute('garment', f.service);
    expect(result).toMatchObject({ ok: false, error: { code: 'AUTHORIZATION_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(f.reports).toHaveLength(0);
  });
});
