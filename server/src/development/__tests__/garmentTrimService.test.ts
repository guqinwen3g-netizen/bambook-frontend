import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), guard: vi.fn() }));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: mocks.auth }));
vi.mock('../developmentOperationalGuard', async () => ({ ...await vi.importActual<any>('../developmentOperationalGuard'), assertDevelopmentOperationalWrite: mocks.guard }));
import { DevelopmentDomainError } from '../developmentOperationalGuard';
import { readGarmentTrims, saveGarmentTrimTask, confirmGarmentTrimTask, readGarmentTrimNotice, saveGarmentMaterialUse } from '../garmentTrimService';

function fixture() {
  const state: any = { tasks: [], uses: [], audits: [], returned: false, supplier: { id: 'supplier-1', name: 'Actual supplier' }, catalog: {
    id: 'trim-1', sku: 'TR-1', name: 'Button', mainCategory: 'Trimmings', deletedAt: null,
    trimmingProfile: { id: 'profile-1', deletedAt: null, supplier: 'Actual supplier', factory: 'Manufacturer', specification: '18mm', price: '0.15', currency: 'USD', unit: '粒' },
  } };
  const rows = (name: string) => ({
    findMany: vi.fn(async () => state[name]),
    findFirst: vi.fn(async ({ where }) => state[name].find((row: any) => row.id === where.id && row.developmentCaseId === where.developmentCaseId && row.deletedAt == null) ?? null),
    create: vi.fn(async ({ data }) => { const row = { ...data, deletedAt: null, confirmedAt: null }; state[name].push(row); return row; }),
    update: vi.fn(async ({ where, data }) => { const row = state[name].find((row: any) => row.id === where.id); Object.assign(row, data); return row; }),
  });
  const tx: any = { $queryRaw: vi.fn(async () => [{ id: 'case-1' }]), garmentTrimTask: rows('tasks'), garmentMaterialUse: rows('uses'),
    relation: { findFirst: vi.fn(async () => state.supplier) },
    productAsset: { findFirst: vi.fn(async ({ where }) => state.catalog.id === where.id && state.catalog.mainCategory === where.mainCategory ? state.catalog : null) },
    developmentSampleVersion: { findFirst: vi.fn(async ({ where }) => where.id === 'version-1' ? { id: where.id, developmentCaseId: 'case-1', versionKind: 'major' } : null) },
    sampleBatch: { findFirst: vi.fn(async () => state.returned ? { id: 'batch-1' } : null) },
    sampleCardItem: { create: vi.fn() },
    auditLog: { findFirst: vi.fn(async ({ where }) => state.audits.find((row: any) => row.targetId === where.targetId && row.detail.after.requestKey === where.detail.equals) ?? null),
      create: vi.fn(async ({ data }) => { const row = { ...data, id: `audit-${state.audits.length}` }; state.audits.push(row); return row; }) },
  };
  const context: any = { actorId: 'sales-1', trustedActor: { userId: 'sales-1' }, prisma: { $transaction: async run => {
    const before = JSON.parse(JSON.stringify(state, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    try { return await run(tx); } catch (e) { Object.assign(state, before); throw e; }
  } } };
  return { context, tx, state };
}
const taskInput = { requirements: '18mm同色纽扣，具体要求见附件', supplierRelationId: 'supplier-1', quantity: '20', unit: '粒', dueDate: '2026-10-20', attachments: [{ name: '规格原件.pdf', url: 'https://files.example/spec.pdf' }], requestKey: 'create-task' };
const useInput = { productAssetId: 'trim-1', position: '门襟', sampleVersionId: 'version-1', perPiece: '6', unit: '粒', provider: 'factory' as const, colorMode: 'dtm' as const, colorReference: '本版面料', sourceNature: 'existing' as const, requestKey: 'create-use' };
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ development: { id: 'case-1', type: 'garment', code: 'DEV-1', name: 'Shirt' }, actor: { userId: 'sales-1' } }); mocks.guard.mockResolvedValue(undefined); });

describe('garment-only extreme-simple trim tasks', () => {
  it('keeps one unconfirmed task with real supplier, requirements, quantities and notice attachments; same request replays once', async () => {
    const f = fixture(); const created = await saveGarmentTrimTask(f.context, 'case-1', taskInput);
    expect(created.task).toMatchObject({ supplierName: 'Actual supplier', confirmedAt: null, revision: 1 });
    expect(await saveGarmentTrimTask(f.context, 'case-1', taskInput)).toEqual(created);
    expect(f.state.tasks).toHaveLength(1);
    const notice = await readGarmentTrimNotice(f.context, 'case-1', created.task.id);
    expect(notice.notice).toMatchObject({ requirements: taskInput.requirements, quantity: '20', attachments: taskInput.attachments, caseCode: 'DEV-1' });
    expect(created.task).not.toHaveProperty('qcStatus'); expect(created.task).not.toHaveProperty('round'); expect(created.task).not.toHaveProperty('status');
    await expect(saveGarmentTrimTask(f.context, 'case-1', { ...taskInput, requirements: 'changed' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it('CAS protects requirements, confirmation records final facts without QC and does not create stock', async () => {
    const f = fixture(); const { task } = await saveGarmentTrimTask(f.context, 'case-1', taskInput);
    await expect(saveGarmentTrimTask(f.context, 'case-1', { ...taskInput, requestKey: 'stale', expectedRevision: 2 }, task.id)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    const input = { requestKey: 'confirm-task', expectedRevision: 1, finalDetails: { name: 'Temporary button', specification: '18mm' }, productAssetId: 'trim-1' };
    const confirmed = await confirmGarmentTrimTask(f.context, 'case-1', task.id, input);
    expect(confirmed.task).toMatchObject({ confirmedBy: 'sales-1', revision: 2, finalDetails: { catalogSnapshot: { sku: 'TR-1' } } });
    expect(await confirmGarmentTrimTask(f.context, 'case-1', task.id, input)).toEqual(confirmed);
    await expect(saveGarmentTrimTask(f.context, 'case-1', { ...taskInput, requestKey: 'overwrite', expectedRevision: 2 }, task.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
  });
  it('rejects nongarment, lost permission and closed writes; audit failure rolls back task creation', async () => {
    const f = fixture(); mocks.auth.mockResolvedValueOnce({ development: { type: 'fabric' } }).mockResolvedValueOnce({ development: { type: 'fabric' } });
    await expect(readGarmentTrims(f.context, 'case-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    mocks.auth.mockRejectedValueOnce(new DevelopmentDomainError('FORBIDDEN', 'denied'));
    await expect(saveGarmentTrimTask(f.context, 'case-1', taskInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.guard.mockRejectedValueOnce(new DevelopmentDomainError('DEVELOPMENT_CLOSED', 'closed'));
    await expect(saveGarmentTrimTask(f.context, 'case-1', taskInput)).rejects.toMatchObject({ code: 'DEVELOPMENT_CLOSED' });
    f.tx.auditLog.create.mockRejectedValueOnce(Error('storage failed'));
    await expect(saveGarmentTrimTask(f.context, 'case-1', taskInput)).rejects.toThrow('storage failed');
    expect(f.state.tasks).toHaveLength(0);
  });
});
describe('actual garment material use snapshots', () => {
  it('uses one catalog in multiple positions and keeps catalog quote facts when master changes', async () => {
    const f = fixture(); const first = await saveGarmentMaterialUse(f.context, 'case-1', useInput);
    f.state.catalog.trimmingProfile.price = '0.30';
    await saveGarmentMaterialUse(f.context, 'case-1', { ...useInput, position: '袖口', requestKey: 'second-position' });
    expect(f.state.uses.map((row: any) => row.productAssetId)).toEqual(['trim-1', 'trim-1']);
    expect(first.materialUse.snapshot.catalog.trimmingProfile.price).toBe('0.15');
    const edited = await saveGarmentMaterialUse(f.context, 'case-1', { ...useInput, perPiece: '7', expectedRevision: 1, requestKey: 'edit-use' }, first.materialUse.id);
    expect(edited.materialUse.snapshot.catalog.trimmingProfile.price).toBe('0.15');
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
  });
  it('preserves returned-version actual snapshots and treats source nature independently of provider', async () => {
    const f = fixture(); f.state.returned = true;
    const created = await saveGarmentMaterialUse(f.context, 'case-1', { ...useInput, sourceNature: 'substitute', provider: 'company' });
    expect(created.materialUse).toMatchObject({ sourceNature: 'substitute', provider: 'company' });
    await expect(saveGarmentMaterialUse(f.context, 'case-1', { ...useInput, expectedRevision: 1, requestKey: 'overwrite-actual' }, created.materialUse.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.state.uses[0].provider).toBe('company');
  });
  it('does not infer unknown quantities, colors or a different-case version', async () => {
    const f = fixture();
    for (const changed of [{ colorMode: 'specified', color: '' }, { perPiece: null, unit: '粒' }, { sampleVersionId: 'other-case-version' }]) {
      await expect(saveGarmentMaterialUse(f.context, 'case-1', { ...useInput, ...changed } as any)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(f.state.uses).toHaveLength(0);
    await saveGarmentMaterialUse(f.context, 'case-1', { ...useInput, perPiece: null, unit: null });
    expect(f.state.uses[0].perPiece).toBeNull();
  });
});
