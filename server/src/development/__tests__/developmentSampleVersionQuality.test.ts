import { createHash } from 'node:crypto';
vi.mock('../developmentQcRouting', async () => ({ ...await vi.importActual<any>('../developmentQcRouting'), resolveDevelopmentQcRouting: vi.fn(async()=>({})) }));
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ audit: vi.fn(), guard: vi.fn(async () => undefined), authority: vi.fn(), businessNow: vi.fn(() => Date.parse('2026-10-08T00:18:00.000Z')) }));
vi.mock('../../shared/businessClock', async () => ({ ...await vi.importActual<object>('../../shared/businessClock'), businessNowMs: mocks.businessNow }));
afterEach(() => vi.restoreAllMocks());
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: mocks.audit }));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: mocks.authority }));
vi.mock('../developmentOperationalGuard', async () => ({
  ...await vi.importActual<any>('../developmentOperationalGuard'), assertDevelopmentOperationalWrite: mocks.guard,
}));
import { requestDevelopmentSampleQualityReview, startDevelopmentSampleQualityReview, completeDevelopmentSampleQualityReview, acknowledgeDevelopmentSampleQualityReview, assertReviewSourceCurrent } from '../developmentSampleQualityService';

function fixture() {
  mocks.audit.mockReset();
  mocks.guard.mockReset().mockResolvedValue(undefined);
  mocks.authority.mockResolvedValue({ actor: { userId: 'qc-1', permissions: ['qc:write', 'qc:inspect', 'qc:garment_chain:write', 'qc:fabric_chain:write'] }, development: { type: 'garment' } });
  const batch: any = { id: 'batch-a', developmentCaseId: 'case-1', supplierRelationId: 'factory-a', batchCode: 'SB-A',
    round: 1, sampleType: 'garment-round', sampleVersionId: 'version-a', versionLabel: 'R1-A', returnedAt: 10n, returnedBy: 'sales', deletedAt: null };
  const versions: any[] = [
    { id: 'version-a', developmentCaseId: 'case-1', supplierRelationId: 'factory-a', roundId: 'round-1', versionLabel: 'R1-A', versionKind: 'major', parentVersionId: null, minorVersion: 0, deletedAt: null },
    { id: 'version-a1', developmentCaseId: 'case-1', supplierRelationId: 'factory-a', roundId: 'round-1', versionLabel: 'R1-A.1', versionKind: 'minor', parentVersionId: 'version-a', minorVersion: 1, minorChangeNote: '领宽增加 0.5cm，无新实物', deletedAt: null },
    { id: 'version-b', developmentCaseId: 'case-1', supplierRelationId: 'factory-b', roundId: 'round-1', versionLabel: 'R1-B', versionKind: 'major', deletedAt: null },
  ];
  const reviews: any[] = [];
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]: any) => value && typeof value === 'object'
    ? value.in ? value.in.includes(row[key]) : true : row[key] === value);
  const tx: any = {
    $queryRaw: vi.fn(async (query: { sql: string }) => {
      if (query.sql.includes('pg_advisory_xact_lock') && !query.sql.includes(')::text'))
        throw new Error('Prisma cannot deserialize a PostgreSQL void result');
      return [{ id: batch.id }];
    }),
    notification: { create: vi.fn(async () => ({})) },
    sampleBatch: { findFirst: vi.fn(async ({ where }: any) => matches(batch, where) ? batch : null) },
    developmentCase: { findFirst: vi.fn(async () => ({ id: 'case-1', code: 'DEV-1', name: 'Test', type: 'garment', deletedAt: null })) },
    developmentSampleVersion: { findFirst: vi.fn(async ({ where }: any) => versions.find(row => matches(row, where)) ?? null) },
    sampleCardItem: { findMany: vi.fn(async () => [{ id: 'card-1', code: 'SC-1', cardType: 'garment', receiptSnapshot: { physicalItemIndex: 1, physicalItemCount: 1 } }]), create: vi.fn() },
    developmentSampleQualityReview: {
      findUnique: vi.fn(async ({ where }: any) => reviews.find(row => matches(row, where)) ?? null),
      findFirst: vi.fn(async ({ where }: any) => reviews.filter(row => matches(row, where)).sort((a, b) => (b.reviewSequence ?? 0) - (a.reviewSequence ?? 0))[0] ?? null),
      create: vi.fn(async ({ data }: any) => { reviews.push({ ...data }); return reviews.at(-1); }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(reviews.find(row => row.id === where.id)!, data)),
    },
  };
  const prisma: any = { $transaction: async (run: any) => run(tx) };
  const request = (sampleVersionId: string | undefined, requestKey: string) => requestDevelopmentSampleQualityReview({ prisma, caseId: 'case-1', batchId: batch.id, sampleVersionId, requestKey, actorId: 'sales' });
  return { batch, reviews, versions, tx, prisma, request };
}

describe('accurate development version QC on shared physical samples', () => {
  it.each(['2026-10-07T08:00:00.000Z', '2026-10-09T08:00:00.000Z'])('uses business time for all QC events while audits/revisions advance on wall time %s', async wallIso => {
    const wallMs = Date.parse(wallIso), businessMs = mocks.businessNow(), wall = vi.spyOn(Date, 'now').mockReturnValue(wallMs), f = fixture();
    const requested = await f.request('version-a', 'clock-request');
    expect(requested).toMatchObject({ ok: true, data: { item: { requestedAt: businessMs, createdAt: wallMs, updatedAt: wallMs } } });
    const id = f.reviews[0].id;
    wall.mockReturnValue(wallMs + 100);
    const started = await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: id, actorId: 'qc-1' });
    expect(started).toMatchObject({ ok: true, data: { item: { startedAt: businessMs, createdAt: wallMs, updatedAt: wallMs + 100 } } });
    wall.mockReturnValue(wallMs + 150);
    expect(await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: id, actorId: 'qc-1' })).toEqual(started);
    wall.mockReturnValue(wallMs + 200);
    const input = { measurements: [{ piece: 'SC-1', size: 'M', position: '胸围', value: '100.00', unit: 'cm' }], requestKey: 'clock-report', result: 'pass', opinion: '按准确版本提交实际检验结果', inspectionDate: '2026-09-30' };
    const completed = await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: id, actorId: 'qc-1', input });
    expect(completed).toMatchObject({ ok: true, data: { item: { reviewedAt: businessMs, inspectionDate: '2026-09-30', createdAt: wallMs, updatedAt: wallMs + 200 } } });
    wall.mockReturnValue(wallMs + 300);
    const acknowledged = await acknowledgeDevelopmentSampleQualityReview({ prisma: f.prisma, caseId: 'case-1', reviewId: id, actorId: 'sales', requestKey: 'clock-ack' });
    expect(acknowledged).toMatchObject({ ok: true, data: { item: { requestedAt: businessMs, startedAt: businessMs, reviewedAt: businessMs, acknowledgedAt: businessMs, createdAt: wallMs, updatedAt: wallMs + 300 } } });
    const writes = f.tx.developmentSampleQualityReview.update.mock.calls.length, audits = mocks.audit.mock.calls.length;
    wall.mockReturnValue(wallMs + 60_000);
    expect(await acknowledgeDevelopmentSampleQualityReview({ prisma: f.prisma, caseId: 'case-1', reviewId: id, actorId: 'sales', requestKey: 'clock-ack' })).toEqual(acknowledged);
    expect(await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: id, actorId: 'qc-1', input })).toEqual(acknowledged);
    expect(await f.request('version-a', 'clock-request')).toEqual(acknowledged);
    expect(f.tx.developmentSampleQualityReview.update).toHaveBeenCalledTimes(writes); expect(mocks.audit).toHaveBeenCalledTimes(audits);
    for (const [value] of mocks.audit.mock.calls.filter(([value]) => value.after?.startedAt || value.after?.reviewedAt || value.after?.acknowledgedAt)) {
      expect(value.after.startedAt ?? value.after.reviewedAt ?? value.after.acknowledgedAt).toBe(String(businessMs));
    }
  });
  it('records conditional pass with issues and rejects an empty issue statement', async () => {
    const f = fixture(); await f.request('version-a', 'conditional-request');
    const reviewId = f.reviews[0].id;
    await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId, actorId: 'qc-1' });
    const base = { prisma: f.prisma, reviewId, actorId: 'qc-1' };
    expect(await completeDevelopmentSampleQualityReview({ ...base, input: { requestKey: 'conditional-empty', result: 'conditional_pass', opinion: ' ' } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.reviews[0].status).toBe('in_progress');
    expect(await completeDevelopmentSampleQualityReview({ ...base, input: { measurements: [{ piece: 'SC-1', size: 'M', position: '袖口', value: '22.0', unit: 'cm' }], requestKey: 'conditional-report', result: 'conditional_pass', opinion: '袖口线迹需客户知悉' } }))
      .toMatchObject({ ok: true, data: { item: { result: 'conditional_pass', opinion: '袖口线迹需客户知悉' } } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'complete_development_sample_qc', after: expect.objectContaining({ result: 'conditional_pass', opinion: '袖口线迹需客户知悉' }) }));
  });

  it('does not let another professional start or complete the actual executor\'s review', async () => {
    const f = fixture(); await f.request('version-a', 'qc-owned-review');
    await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-1' });
    f.tx.developmentSampleQualityReview.update.mockClear();
    mocks.authority.mockResolvedValue({ actor: { userId: 'qc-2', permissions: ['qc:inspect', 'qc:garment_chain:write'] }, development: { type: 'garment' } });
    expect(await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-2' }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-2',
      input: { requestKey: 'wrong-actual-inspector', result: 'pass', opinion: '不能借团队可见性代检' } }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.tx.developmentSampleQualityReview.update).not.toHaveBeenCalled();
    expect(f.reviews[0].startedBy).toBe('qc-1');
  });

  it('keeps an old unassigned in-progress review unknown until an explicit claim', async () => {
    const f = fixture(); await f.request('version-a', 'qc-unknown-inspector');
    Object.assign(f.reviews[0], { status: 'in_progress', startedBy: null, startedAt: null });
    expect(await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-1' }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-1',
      input: { requestKey: 'unknown-inspector-complete', result: 'pass', opinion: '须先明确实际执行人' } }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.reviews[0].startedBy).toBeNull();
  });

  it('rechecks actual professional authority after locking the exact review', async () => {
    const f = fixture(); await f.request('version-a', 'qc-lock-revoke');
    mocks.authority.mockClear();
    mocks.authority.mockResolvedValueOnce({ actor: { userId: 'qc-1', permissions: ['qc:inspect', 'qc:garment_chain:write'] }, development: { type: 'garment' } })
      .mockResolvedValue({ actor: { userId: 'qc-1', permissions: ['qc:write'] }, development: { type: 'garment' } });
    expect(await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-1' }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.tx.developmentSampleQualityReview.update).not.toHaveBeenCalled();
  });

  it('does not accept invented attachment metadata or external URLs as new verified QC evidence', async () => {
    const f = fixture(); await f.request('version-a', 'qc-fake-file');
    await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-1' });
    f.tx.developmentSampleQualityReview.update.mockClear();
    expect(await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-1',
      input: { requestKey: 'fake-file-complete', result: 'pass', opinion: '附件需要真实上传', evidence: [{ id: 'made-up', url: 'https://invalid.example/report.pdf' }] } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.tx.developmentSampleQualityReview.update).not.toHaveBeenCalled();
  });

  it('binds a minor review to its own written version while retaining the exact original physical item', async () => {
    const f = fixture();
    const result = await f.request('version-a1', 'qc-a1');
    expect(result).toMatchObject({ ok: true, data: { item: { sampleVersionId: 'version-a1', versionLabel: 'R1-A.1', reviewSequence: 1,
      physicalItems: [{ id: 'card-1' }], sourceSnapshot: { sampleVersionId: 'version-a1', version: { id: 'version-a1', minorChangeNote: '领宽增加 0.5cm，无新实物' } } } } });
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
    await expect(assertReviewSourceCurrent(f.tx, f.reviews[0])).resolves.toMatchObject({ batch: { id: 'batch-a' } });
  });

  it('appends a re-review after a completed NOK and replays the original request instead of the newest review', async () => {
    const f = fixture();
    const first = await f.request('version-a', 'qc-first');
    expect(first.ok).toBe(true);
    Object.assign(f.reviews[0], { status: 'in_progress', startedBy: 'qc-1' });
    const nok = await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'qc-1', input: { measurements: [{ piece: 'SC-1', size: null, position: '领口', value: '42', unit: 'cm' }], requestKey: 'complete-first', result: 'reject', opinion: '领口超差' } });
    expect(nok.ok).toBe(true);
    const second = await f.request('version-a', 'qc-second');
    expect(second).toMatchObject({ ok: true, data: { item: { sampleVersionId: 'version-a', reviewSequence: 2, status: 'queued' } } });
    expect(f.reviews).toHaveLength(2);
    expect(f.reviews[0].result).toBe('reject');
    const replay = await f.request('version-a', 'qc-first');
    expect(replay).toMatchObject({ ok: true, data: { item: { id: f.reviews[0].id, result: 'reject' } } });
    expect(f.reviews).toHaveLength(2);
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
  });

  it('does not let a factory-B version evaluate the factory-A physical sample', async () => {
    const f = fixture();
    expect(await f.request('version-b', 'qc-wrong-factory')).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED' } });
    expect(f.reviews).toHaveLength(0);
  });

  it('keeps the legacy batch route usable only when the batch has an explicit native version key', async () => {
    const f = fixture();
    expect(await f.request(undefined, 'qc-native-major')).toMatchObject({ ok: true, data: { item: { sampleVersionId: 'version-a' } } });
    f.batch.sampleVersionId = null;
    expect(await f.request(undefined, 'qc-legacy-unknown')).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED' } });
    expect(f.reviews).toHaveLength(1);
  });

  it('rejects reusing one request key for another exact version and preserves the original report', async () => {
    const f = fixture();
    await f.request('version-a', 'qc-stable');
    expect(await f.request('version-a1', 'qc-stable')).toMatchObject({ ok: false, error: { code: 'REQUEST_CONFLICT' } });
    expect(f.reviews).toHaveLength(1);
  });

  it('detects a changed minor adjustment without invalidating its parent physical identity', async () => {
    const f = fixture();
    await f.request('version-a1', 'qc-minor');
    f.versions[1].minorChangeNote = '领宽增加 2cm';
    await expect(assertReviewSourceCurrent(f.tx, f.reviews[0])).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it.each([
    ['qc:write'],
    ['qc:write', 'qc:garment_chain:write', 'qc:fabric_chain:write'],
  ])('does not let a business account without professional qc:inspect complete a formal review: %j', async (...permissions) => {
    const f = fixture(); await f.request('version-a', 'qc-professional');
    f.reviews[0].status = 'in_progress';
    mocks.authority.mockResolvedValue({ actor: { userId: 'sales-2', permissions }, development: { type: 'garment' } });
    expect(await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[0].id, actorId: 'sales-2', input: { requestKey: 'unauthorized-completion', result: 'pass', opinion: '越权' } }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.tx.developmentSampleQualityReview.update).not.toHaveBeenCalled();
  });
  it('keeps both NOK and re-review pass reports, and replays the exact older completion after the newer pass', async () => {
    const f = fixture(); await f.request('version-a', 'qc-first-complete');
    const firstId = f.reviews[0].id;
    await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: firstId, actorId: 'qc-1' });
    const input = { measurements: [{ piece: 'SC-1', size: null, position: '领口', value: '42', unit: 'cm' }], requestKey: 'complete-stable-1', result: 'reject', opinion: '领口超差' };
    const first = await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: firstId, actorId: 'qc-1', input });
    expect(first.ok).toBe(true);
    await f.request('version-a', 'qc-rereview');
    const secondId = f.reviews[1].id;
    await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: secondId, actorId: 'qc-1' });
    expect(await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: secondId, actorId: 'qc-1', input: { measurements: [{ piece: 'SC-1', size: null, position: '领口', value: '40', unit: 'cm' }], requestKey: 'complete-stable-2', result: 'pass', opinion: '复核通过' } })).toMatchObject({ ok: true, data: { item: { result: 'pass', reviewSequence: 2 } } });
    expect(await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: firstId, actorId: 'qc-1', input })).toEqual(first);
    expect(f.reviews.map(row => row.result)).toEqual(['reject', 'pass']);
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
  });
  it('rejects reusing another report completion request key without changing either report', async () => {
    const f = fixture(); await f.request('version-a', 'qc-report-key');
    Object.assign(f.reviews[0], { status: 'reviewed', completionRequestKey: 'same-completion-key', result: 'reject' });
    await f.request('version-a', 'qc-report-key-2');
    f.reviews[1].status = 'in_progress';
    expect(await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: f.reviews[1].id, actorId: 'qc-1', input: { requestKey: 'same-completion-key', result: 'pass', opinion: '复核' } })).toMatchObject({ ok: false, error: { code: 'REQUEST_CONFLICT' } });
    expect(f.tx.developmentSampleQualityReview.update).not.toHaveBeenCalled();
  });
});


describe('separate per-piece actual QC measurements', () => {
  it('requires garment measurements and preserves supplied precision, pieces and independent opinion through replay', async () => {
    const f = fixture(); await f.request('version-a', 'measurement-review'); const id = f.reviews[0].id;
    await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: id, actorId: 'qc-1' });
    const base = { prisma: f.prisma, reviewId: id, actorId: 'qc-1' };
    const input = { requestKey: 'measurement-report', result: 'conditional_pass', opinion: '独立袖口线迹问题', measurements: [{ piece: 'SC-1', size: 'M', position: '胸围', value: '100.00', unit: 'cm' }, { piece: 'SC-2', size: null, position: '胸围', value: '100.5', unit: 'cm' }] };
    expect(await completeDevelopmentSampleQualityReview({ ...base, input: { ...input, measurements: [] } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const result = await completeDevelopmentSampleQualityReview({ ...base, input });
    expect(result).toMatchObject({ ok: true, data: { item: { opinion: input.opinion, measurements: input.measurements } } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ after: expect.objectContaining({ measurements: input.measurements }) }));
    expect(await completeDevelopmentSampleQualityReview({ ...base, input })).toEqual(result);
    expect(await completeDevelopmentSampleQualityReview({ ...base, input: { ...input, measurements: [{ ...input.measurements[0], value: '999' }] } })).toMatchObject({ ok: false, error: { code: 'QC_REVIEW_ALREADY_COMPLETED' } });
  });
  it('allows fabric reports with no applicable measurement and rejects invented measurement units or nonfinite values', async () => {
    const f = fixture(); await f.request('version-a', 'fabric-measure-review'); const id = f.reviews[0].id;
    mocks.authority.mockResolvedValue({ actor: { userId: 'qc-1', permissions: ['qc:write','qc:inspect','qc:fabric_chain:write'] }, development: { type: 'fabric' } });
    await startDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: id, actorId: 'qc-1' });
    const base = { prisma: f.prisma, reviewId: id, actorId: 'qc-1' }, input = { requestKey: 'fabric-measure-report', result: 'pass', opinion: '原色样评审，无适用尺寸项目' };
    for (const row of [{ piece: 'SC-1', position: '幅宽', value: 'Infinity', unit: 'cm' }, { piece: 'SC-1', position: '幅宽', value: '145', unit: '' }]) expect(await completeDevelopmentSampleQualityReview({ ...base, input: { ...input, measurements: [row] } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await completeDevelopmentSampleQualityReview({ ...base, input: { ...input, measurements: [] } })).toMatchObject({ ok: true, data: { item: { measurements: [] } } });
  });
});


it('replays the exact legacy adjustment report without inventing measurements or reclassifying it as conditional pass', async () => {
  const f = fixture(); await f.request('version-a', 'legacy-adjustment-review'); const row = f.reviews[0];
  const decision = { result: 'needs_adjustment', opinion: '原报告需调整', inspectionDate: null, inspectorOrg: null, criticalDefects: 0, majorDefects: 0, minorDefects: 0, evidence: [] };
  Object.assign(row, { ...decision, status: 'reviewed', reviewedBy: 'qc-1', completionRequestKey: 'legacy-adjustment-original', completionFingerprint: createHash('sha256').update(JSON.stringify(decision)).digest('hex') });
  const result = await completeDevelopmentSampleQualityReview({ prisma: f.prisma, reviewId: row.id, actorId: 'qc-1', input: { requestKey: 'legacy-adjustment-original', result: 'needs_adjustment', opinion: decision.opinion } });
  expect(result).toMatchObject({ ok: true, data: { item: { result: 'needs_adjustment', opinion: decision.opinion, measurements: null } } });
  expect(f.tx.developmentSampleQualityReview.update).not.toHaveBeenCalled();
});
