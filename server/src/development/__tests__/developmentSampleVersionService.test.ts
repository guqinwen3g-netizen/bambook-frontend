import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ audit: vi.fn(async () => 'audit'), guard: vi.fn(async () => undefined) }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: mocks.audit }));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: vi.fn(async () => undefined) }));
vi.mock('../developmentOperationalGuard', async () => {
  const actual: any = await vi.importActual('../developmentOperationalGuard');
  return { ...actual, assertDevelopmentOperationalWrite: mocks.guard };
});
import { createDevelopmentSampleMinorVersion, createDevelopmentSampleMinorVersionCommand, ensureDevelopmentSampleMajorVersion, updateDevelopmentSampleVersionTask } from '../developmentSampleVersionService';

describe('createDevelopmentSampleMinorVersion', () => {
  it('uses the agreed dot notation for a minor revision label', async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const tx = {
      developmentSampleVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
    };

    const created = await createDevelopmentSampleMinorVersion(tx, {
      parent: {
        id: 'version-1',
        roundId: 'round-1',
        developmentCaseId: 'case-1',
        supplierRelationId: 'factory-1',
        supplierName: 'Factory A',
        versionLabel: 'R1-A',
      },
      note: '袖口宽度微调',
    });

    expect(created.versionLabel).toBe('R1-A.1');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ versionLabel: 'R1-A.1', minorVersion: 1 }),
    }));
  });
});

describe('minor version creation command on the original physical major version', () => {
  it('replays the exact request and rejects a changed adjustment instead of duplicating versions or inventory', async () => {
    const parent: any = { id: 'major-a', developmentCaseId: 'case-1', roundId: 'round-1', versionKind: 'major', versionLabel: 'R1-A', supplierRelationId: 'factory-a', deletedAt: null };
    const rows: any[] = [parent];
    const tx: any = { $queryRaw: vi.fn(async () => [{ id: parent.id }]), developmentSampleVersion: {
      findFirst: vi.fn(async ({ where }: any) => rows.filter(row => Object.entries(where).every(([key, value]) => row[key] === value)).sort((a, b) => (b.minorVersion ?? 0) - (a.minorVersion ?? 0))[0] ?? null),
      create: vi.fn(async ({ data }: any) => { rows.push({ ...data, deletedAt: null }); return rows.at(-1); }),
    }, sampleCardItem: { create: vi.fn() }, sampleBatch: { create: vi.fn() } };
    const prisma: any = { $transaction: async (run: any) => run(tx) };
    const run = (note = '领宽微调') => createDevelopmentSampleMinorVersionCommand({ prisma, caseId: 'case-1', parentVersionId: parent.id, actorId: 'sales', trustedActor: { userId: 'sales' } as any,
      input: { requestKey: 'minor-request', note } });
    const first = await run();
    expect(first).toMatchObject({ ok: true, data: { item: { versionLabel: 'R1-A.1', parentVersionId: parent.id, minorChangeNote: '领宽微调' } } });
    expect(await run()).toEqual(first);
    expect(await run('另一项调整')).toMatchObject({ ok: false, error: { code: 'REQUEST_CONFLICT' } });
    expect(rows).toHaveLength(2);
    expect(tx.sampleCardItem.create).not.toHaveBeenCalled(); expect(tx.sampleBatch.create).not.toHaveBeenCalled();
  });
});

describe('development factory task snapshots', () => {
  it('copies the round request when each factory version is first created', async () => {
    const tx = { $queryRaw: vi.fn(async () => [{ id: 'case-1' }]), developmentSampleVersion: {
      findMany: vi.fn(async () => []), create: vi.fn(async ({ data }: any) => data),
    } };
    const round = { id: 'round-1', round: 1, developmentCaseId: 'case-1', notes: '统一面料克重要求' };
    const a = await ensureDevelopmentSampleMajorVersion(tx, { round, supplierRelationId: 'factory-a', versionLabel: 'R1-A' });
    const b = await ensureDevelopmentSampleMajorVersion(tx, { round, supplierRelationId: 'factory-b', versionLabel: 'R1-B' });
    expect(a.roundRequirementsSnapshot).toBe('统一面料克重要求');
    expect(a.factoryRequirements).toBe('统一面料克重要求');
    expect(b.roundRequirementsSnapshot).toBe('统一面料克重要求');
    expect(tx.developmentSampleVersion.create).toHaveBeenCalledTimes(2);
  });

  it('edits only the selected factory task and never cascades into the round or sibling task', async () => {
    const task = { id: 'task-a', developmentCaseId: 'case-1', updatedAt: 10n, roundRequirementsSnapshot: '共同要求',
      factoryRequirements: 'A厂要求', targetCompletionDate: null, referenceAttachments: [] };
    const tx = { developmentSampleVersion: {
      findFirst: vi.fn(async () => task), update: vi.fn(async ({ data }: any) => ({ ...task, ...data })),
    }, sampleBatch: { findMany: vi.fn(async () => []) }, $queryRawUnsafe: vi.fn(async () => []) };
    const prisma: any = { $transaction: async (run: any) => run(tx) };
    const result = await updateDevelopmentSampleVersionTask({ prisma, versionId: 'task-a', actorId: 'sales', input: {
      factoryRequirements: '仅 A 厂调整', expectedUpdatedAt: '10',
    } });
    expect(result.ok).toBe(true);
    expect(tx.developmentSampleVersion.update).toHaveBeenCalledWith({ where: { id: 'task-a' }, data: expect.objectContaining({ factoryRequirements: '仅 A 厂调整' }) });
    expect((tx as any).developmentSampleRound).toBeUndefined();
  });
});


describe('physical version numbering independently of scheduling rounds', () => {
  function versionStore(initial: any[] = []) {
    const rows = [...initial];
    const tx: any = { $queryRaw: vi.fn(async () => [{ id: 'case-1' }]), developmentSampleVersion: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async ({ where }: any) => rows.filter(row => Object.entries(where).every(([key, value]) => row[key] === value)).sort((a, b) => (b.minorVersion ?? 0) - (a.minorVersion ?? 0))[0] ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, deletedAt: null }; rows.push(row); return row; }),
    } };
    const create = (round: number, supplierRelationId = 'factory-a', sourceVersionId?: string) => ensureDevelopmentSampleMajorVersion(tx, {
      round: { id: `round-${round}`, round, developmentCaseId: 'case-1' }, supplierRelationId, sourceVersionId,
    });
    return { rows, tx, create };
  }
  it('uses stable factory codes and counts physical samples, including two samples in one round', async () => {
    const f = versionStore();
    const a1 = await f.create(1);
    const a2 = await f.create(1, 'factory-a', a1.id);
    const b1 = await f.create(2, 'factory-b');
    const a3 = await f.create(2, 'factory-a', a1.id);
    expect([a1.versionLabel, a2.versionLabel, b1.versionLabel, a3.versionLabel]).toEqual(['R1-A-1', 'R1-A-2', 'R2-B-1', 'R2-A-3']);
    expect(a3.sourceVersionId).toBe(a1.id);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(4);
    const minor = await createDevelopmentSampleMinorVersion(f.tx, { parent: a1, note: '无新实物调整' });
    expect(minor).toMatchObject({ versionLabel: 'R1-A-1.1', physicalSequence: 1, factoryCode: 'A', parentVersionId: a1.id });
    const fromMinor = await f.create(3, 'factory-a', minor.id);
    expect(fromMinor).toMatchObject({ versionLabel: 'R3-A-4', sourceVersionId: minor.id });
  });
  it('retains legacy labels, resolves historical code collisions and never reuses an archived physical sequence', async () => {
    const legacy = [
      { id: 'old-a', developmentCaseId: 'case-1', supplierRelationId: 'factory-a', versionKind: 'major', versionLabel: 'R1-A', deletedAt: null },
      { id: 'old-b', developmentCaseId: 'case-1', supplierRelationId: 'factory-b', versionKind: 'major', versionLabel: 'R2-A', deletedAt: null },
      { id: 'archived-a', developmentCaseId: 'case-1', supplierRelationId: 'factory-a', versionKind: 'major', versionLabel: 'R2-A', deletedAt: 1n },
    ];
    const f = versionStore(legacy);
    expect((await f.create(3, 'factory-b', 'old-b')).versionLabel).toBe('R3-B-2');
    expect((await f.create(3, 'factory-a', 'old-a')).versionLabel).toBe('R3-A-3');
    expect(legacy.map(row => row.versionLabel)).toEqual(['R1-A', 'R2-A', 'R2-A']);
    await expect(f.create(4, 'factory-b', 'old-a')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.create(4, 'factory-a', 'missing')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
