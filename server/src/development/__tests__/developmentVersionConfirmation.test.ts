import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authority: vi.fn(), audit: vi.fn(), guard: vi.fn(async () => undefined) }));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: mocks.authority }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: mocks.audit }));
vi.mock('../developmentOperationalGuard', async () => ({ ...await vi.importActual<any>('../developmentOperationalGuard'), assertDevelopmentOperationalWrite: mocks.guard }));
import { recordDevelopmentVersionConfirmation, listDevelopmentVersionConfirmations } from '../developmentSampleVersionService';
import { DevelopmentDomainError } from '../developmentOperationalGuard';

function fixture() {
  const development = { id: 'case-1', type: 'garment', ownerId: 'sales', customerRelationId: null };
  mocks.authority.mockResolvedValue({ actor: { userId: 'sales' }, development });
  const versions = [
    { id: 'major-a', developmentCaseId: development.id, versionLabel: 'R1-A', versionKind: 'major', roundId: 'round-1', supplierRelationId: 'factory-a', deletedAt: null },
    { id: 'minor-a1', developmentCaseId: development.id, versionLabel: 'R1-A.1', versionKind: 'minor', parentVersionId: 'major-a', roundId: 'round-1', supplierRelationId: 'factory-a', minorChangeNote: '领宽调整', deletedAt: null },
  ];
  const batch = { id: 'batch-1', developmentCaseId: development.id, sampleVersionId: 'major-a', supplierRelationId: 'factory-a', returnedAt: 100n, deletedAt: null };
  const confirmations: any[] = [];
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ id: 'case-1' }]),
    developmentSampleVersion: { findFirst: vi.fn(async ({ where }: any) => versions.find(row => row.id === where.id && row.developmentCaseId === where.developmentCaseId) ?? null) },
    sampleBatch: { findMany: vi.fn(async () => [batch]) },
    sampleCardItem: { findMany: vi.fn(async () => [{ id: 'card-1', batchId: batch.id, code: 'SC-1', cardType: 'garment' }]), create: vi.fn(), update: vi.fn() },
    userAccount: { findFirst: vi.fn(async () => ({ id: 'requester-1', deletedAt: null })) },
    developmentVersionConfirmation: {
      findUnique: vi.fn(async ({ where }: any) => confirmations.find(row => row.requestKey === where.requestKey) ?? null),
      findMany: vi.fn(async ({ where }: any) => confirmations.filter(row => row.developmentCaseId === where.developmentCaseId && (!where.sampleVersionId || where.sampleVersionId.in.includes(row.sampleVersionId)))),
      create: vi.fn(async ({ data }: any) => { confirmations.push(data); return data; }),
    },
  };
  const prisma: any = { ...tx, $transaction: async (run: any) => run(tx) };
  const input = { requestKey: 'confirmation-a1', confirmerType: 'internal', confirmerName: '设计需求方 李女士', confirmerUserId: 'requester-1',
    confirmerOrganization: '设计部', confirmedAt: '1000', result: 'approved', basis: '需求方在评审会议中认可领宽修改', evidence: ['https://evidence.local/meeting'] };
  const record = (patch: any = {}) => recordDevelopmentVersionConfirmation({ prisma, caseId: development.id, versionId: 'minor-a1', actorId: 'sales', trustedActor: { userId: 'sales' } as any, input: { ...input, ...patch } });
  return { tx, prisma, development, confirmations, input, record };
}

describe('exact development requester confirmation facts', () => {
  it.each(['closed', 'paused'])('reads an exact successful receipt after %s while rejecting new facts', async state => {
    const f = fixture(); const first = await f.record();
    mocks.guard.mockRejectedValue(new DevelopmentDomainError(state === 'closed' ? 'DEVELOPMENT_CLOSED' : 'DEVELOPMENT_PAUSED', '新开发工作被拦截'));
    expect(await f.record()).toEqual(first);
    expect(await f.record({requestKey:'new-confirmation'})).toMatchObject({ok:false,error:{code:state==='closed'?'DEVELOPMENT_CLOSED':'DEVELOPMENT_PAUSED'}});
    expect(f.confirmations).toHaveLength(1);
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
    expect(f.tx.sampleCardItem.update).not.toHaveBeenCalled();
  });

  beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockReset().mockResolvedValue(undefined); });
  it('records the actual internal requester separately from the business staff member who enters the fact', async () => {
    const f = fixture();
    expect(await f.record()).toMatchObject({ ok: true, data: { item: { sampleVersionId: 'minor-a1', confirmerType: 'internal', confirmerName: '设计需求方 李女士', confirmerUserId: 'requester-1', confirmedAt: '1000',
      recordedBy: 'sales', basis: f.input.basis, sourceSnapshot: { version: { id: 'minor-a1' }, physicalItems: [{ id: 'card-1' }] } } } });
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
    expect(f.tx.sampleCardItem.update).not.toHaveBeenCalled();
  });
  it('returns the original unknown-receipt retry and rejects changed facts under that same request key', async () => {
    const f = fixture(); const first = await f.record();
    expect(await f.record()).toEqual(first);
    expect(await f.record({ result: 'rejected' })).toMatchObject({ ok: false, error: { code: 'REQUEST_CONFLICT' } });
    expect(f.confirmations).toHaveLength(1);
  });
  it('does not turn a parent confirmation into a minor confirmation', async () => {
    const f = fixture(); await f.record();
    const result = await listDevelopmentVersionConfirmations({ prisma: f.prisma, caseId: 'case-1', versionIds: ['major-a'], trustedActor: { userId: 'sales' } as any });
    expect(result).toMatchObject({ ok: true, data: { items: [] } });
  });
  it('rejects customer confirmation when this internal case has no recorded customer source', async () => {
    const f = fixture();
    expect(await f.record({ confirmerType: 'customer', confirmerUserId: null })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.confirmations).toHaveLength(0);
  });
  it('requires real confirmation identity, actual time and basis instead of substituting recording metadata', async () => {
    const f = fixture();
    for (const patch of [{ confirmerName: '' }, { confirmedAt: null }, { basis: '' }]) {
      expect(await f.record(patch)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(f.confirmations).toHaveLength(0);
  });
  it('rechecks current source rights even for an old successful request', async () => {
    const f = fixture(); await f.record();
    mocks.authority.mockRejectedValue(new DevelopmentDomainError('FORBIDDEN', '权限已撤销'));
    expect(await f.record()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.confirmations).toHaveLength(1);
  });
});
