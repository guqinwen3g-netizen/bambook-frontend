import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({ authorize: vi.fn(), coverage: vi.fn() }));
vi.mock('../orders/orderLineWriteAccess', () => ({ authorizeOrderLineWrite: shared.authorize }));
vi.mock('./qcPhysicalCoverage', () => ({
  resolveQcCoverage: shared.coverage,
  requireQcCoverageMatch: vi.fn(),
}));

import { appendProductionQcReportFacts, resumeProductionQcIssues } from './productionQcIssueService';
import { reportContentFingerprint } from './qcReportReadProjection';

const batch = { id: 'PB1', orderId: 'O1', orderLineId: 'OL1', revision: 3, state: 'active' };
const assignment = { id: 'A1', orderId: 'O1', scopeType: 'production_batch', productionBatchId: 'PB1', productionBatchRevision: 3 };
const actor = { userId: 'B1' } as any;

function store() {
  const issues: any[] = [];
  const events: any[] = [];
  const notifications: any[] = [];
  const reports = new Map<string, any>();
  const tx: any = {
    productionBatch: { findUnique: vi.fn(async () => batch) },
    productionQcIssue: {
      create: vi.fn(async ({ data }: any) => { issues.push(data); return data; }),
      findMany: vi.fn(async ({ where }: any = {}) => issues.filter(row => (!where?.orderId || row.orderId === where.orderId)
        && (!where?.orderLineId || row.orderLineId === where.orderLineId)
        && (!where?.productionBatchId || row.productionBatchId === where.productionBatchId)
        && (!where?.productionBatchRevision || row.productionBatchRevision === where.productionBatchRevision)
        && (!where?.id?.in || where.id.in.includes(row.id)))),
    },
    productionQcIssueEvent: {
      create: vi.fn(async ({ data }: any) => { events.push(data); return data; }),
      findMany: vi.fn(async ({ where }: any) => events.filter(row => row.issueId === where.issueId)
        .sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || a.id.localeCompare(b.id))),
      findFirst: vi.fn(async ({ where }: any) => events.find(row => row.actorId === where.actorId
        && row.requestKey === where.requestKey && row.kind === where.kind) ?? null),
    },
    inspectionReport: { findUnique: vi.fn(async ({ where }: any) => reports.get(where.id) ?? null) },
    inspectionWidthMeasurement: { findMany: vi.fn(async () => []) },
    order: { findUnique: vi.fn(async () => ({ ownerId: 'BUSINESS-OWNER', departmentId: 'DEPT1' })) },
    userAccount: { findUnique: vi.fn(async ({ where }: any) => where.id === 'BUSINESS-OWNER'
      ? { id: where.id, status: 'active', deletedAt: null } : null) },
    department: { findUnique: vi.fn(async () => ({ headId: null })) },
    notification: { createMany: vi.fn(async ({ data }: any) => { notifications.push(...data); return { count: data.length }; }) },
    $queryRaw: vi.fn(async () => [{ id: 'PB1' }]),
  };
  const prisma: any = { $transaction: (fn: any) => fn(tx) };
  return { tx, prisma, issues, events, notifications, reports };
}

const failedReport = { id: 'R-FAIL', orderId: 'O1', scopeType: 'production_batch', productionBatchId: 'PB1',
  productionBatchRevision: 3, scopeFingerprint: 'scope-current', result: 'fail', defectSummary: '缝线开裂' };

beforeEach(() => {
  shared.authorize.mockReset().mockResolvedValue({ actor, order: { id: 'O1' } });
  shared.coverage.mockReset().mockResolvedValue({ scopeFingerprint: 'scope-current', scopeSnapshot: { lines: [] } });
});

describe('production QC issue append-only lifecycle', () => {
  it('records an exact batch/revision NOK as an open issue without changing the batch', async () => {
    const db = store();
    await appendProductionQcReportFacts(db.tx, { assignment, report: failedReport, actorId: 'QC1', requestKey: 'qc-fail-1', commandHash: 'hash-1' });

    expect(db.issues).toHaveLength(1);
    expect(db.issues[0]).toMatchObject({ orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1',
      productionBatchRevision: 3, failedReportId: 'R-FAIL', reason: '缝线开裂', createdBy: 'QC1' });
    expect(db.events[0]).toMatchObject({ issueId: db.issues[0].id, kind: 'opened', fromStatus: null, toStatus: 'open',
      reportId: 'R-FAIL', productionBatchRevision: 3, requestKey: 'qc-open:qc-fail-1' });
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0]).toMatchObject({ userId: 'BUSINESS-OWNER', type: 'production_qc_issue', level: 'critical',
      link: '/orders?id=O1&tab=production', metadata: expect.objectContaining({ productionQcIssueId: db.issues[0].id, reportId: 'R-FAIL' }) });
    expect(db.tx.productionBatch.update).toBeUndefined();
  });

  it('rejects a NOK report whose stored batch identity or revision is stale', async () => {
    const db = store();
    await expect(appendProductionQcReportFacts(db.tx, { assignment, report: { ...failedReport, productionBatchRevision: 2 },
      actorId: 'QC1', requestKey: 'qc-fail-stale', commandHash: 'hash-stale' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.issues).toHaveLength(0);
    expect(db.events).toHaveLength(0);
  });

  it('requires a current pass retest to resolve an open issue, then a separate explicit business resume', async () => {
    const db = store();
    db.reports.set('R-FAIL', failedReport);
    await appendProductionQcReportFacts(db.tx, { assignment, report: failedReport, actorId: 'QC1', requestKey: 'qc-fail-2', commandHash: 'hash-2' });
    const issue = db.issues[0];
    const passReport = { id: 'R-PASS', orderId: 'O1', scopeType: 'production_batch', productionBatchId: 'PB1',
      productionBatchRevision: 3, scopeFingerprint: 'scope-current', result: 'pass' };
    db.reports.set('R-PASS', passReport);

    await expect(appendProductionQcReportFacts(db.tx, { assignment, report: { ...passReport, result: 'fail' }, actorId: 'QC1',
      requestKey: 'qc-fail-retest', commandHash: 'hash-3', resolvesIssueIds: [issue.id] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.events.filter(row => row.kind === 'qc_resolved')).toHaveLength(0);

    await appendProductionQcReportFacts(db.tx, { assignment, report: passReport, actorId: 'QC1', requestKey: 'qc-pass-1',
      commandHash: 'hash-4', resolvesIssueIds: [issue.id] });
    expect(db.events.at(-1)).toMatchObject({ issueId: issue.id, kind: 'qc_resolved', fromStatus: 'open', toStatus: 'resolved', reportId: 'R-PASS' });
    expect(db.notifications.at(-1)).toMatchObject({ userId: 'BUSINESS-OWNER', type: 'production_qc_resume_needed', level: 'warning' });

    const input = { orderLineId: 'OL1', expectedRevision: 3, requestKey: 'business-resume-1' };
    const resumed = await resumeProductionQcIssues({ prisma: db.prisma, productionBatchId: 'PB1', actor, input });
    expect(resumed).toMatchObject({ orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', productionBatchRevision: 3,
      issueIds: [issue.id], replayed: false });
    expect(db.events.at(-1)).toMatchObject({ issueId: issue.id, kind: 'business_resumed', fromStatus: 'waiting_business_resume',
      toStatus: 'resumed', actorId: 'B1', reportId: 'R-PASS', requestKey: 'business-resume-1' });
    expect(db.tx.productionBatch.update).toBeUndefined();

    const replay = await resumeProductionQcIssues({ prisma: db.prisma, productionBatchId: 'PB1', actor, input });
    expect(replay.replayed).toBe(true);
    expect(db.events.filter(row => row.kind === 'business_resumed')).toHaveLength(1);

    const failedAgain = { ...failedReport, id: 'R-FAIL-AGAIN', defectSummary: '返修后又发现跳针' };
    db.reports.set(failedAgain.id, failedAgain);
    await appendProductionQcReportFacts(db.tx, { assignment, report: failedAgain, actorId: 'QC1', requestKey: 'qc-fail-again', commandHash: 'hash-5' });
    const secondIssue = db.issues[1];
    const passAgain = { ...passReport, id: 'R-PASS-AGAIN' };
    db.reports.set(passAgain.id, passAgain);
    await appendProductionQcReportFacts(db.tx, { assignment, report: passAgain, actorId: 'QC1', requestKey: 'qc-pass-again',
      commandHash: 'hash-6', resolvesIssueIds: [secondIssue.id] });
    const secondResume = await resumeProductionQcIssues({ prisma: db.prisma, productionBatchId: 'PB1', actor,
      input: { orderLineId: 'OL1', expectedRevision: 3, requestKey: 'business-resume-again' } });
    expect(secondResume.issueIds).toEqual([secondIssue.id]);
    const projection = await import('./productionQcIssueService').then(({ readProductionQcIssueProjection }) =>
      readProductionQcIssueProjection(db.tx, { orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', productionBatchRevision: 3 }));
    expect(projection.available).toBe(true);
    expect(projection.issues.map(row => row.status)).toEqual(['resumed', 'resumed']);
  });

  it('cannot business-resume without a logged-in business actor or against a stale batch revision', async () => {
    const db = store();
    await expect(resumeProductionQcIssues({ prisma: db.prisma, productionBatchId: 'PB1', actor: null,
      input: { orderLineId: 'OL1', expectedRevision: 3, requestKey: 'resume-no-actor' } })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(resumeProductionQcIssues({ prisma: db.prisma, productionBatchId: 'PB1', actor,
      input: { orderLineId: 'OL1', expectedRevision: 2, requestKey: 'resume-stale' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.events).toHaveLength(0);
  });

  it('only resolves the exact failed garment size and revalidates evidence before business recovery', async () => {
    const db = store();
    db.tx.order.findUnique.mockResolvedValue({ businessLine: 'garment', ownerId: 'BUSINESS-OWNER' });
    shared.authorize.mockResolvedValue({ actor, order: { id: 'O1', businessLine: 'garment' } });
    const productionSizeChecks = (size: string, result: 'pass' | 'fail') => ({ schemaVersion: 1, actualSizes: [size], scopeComplete: false,
      basis: '实际巡检核对', checks: [{ size, inspectedUnits: 1, result, evidence: [`photo:${size}:${result}`] }] });
    const failed: any = { ...failedReport, productionSizeChecks: productionSizeChecks('M', 'fail') };
    failed.contentFingerprint = await reportContentFingerprint(db.tx, failed); db.reports.set(failed.id, failed);
    await appendProductionQcReportFacts(db.tx, { assignment, report: failed, actorId: 'QC1', requestKey: 'garment-fail', commandHash: 'hash' });
    const issue = db.issues[0];
    const wrong: any = { ...failed, id: 'PASS-S', result: 'pass', productionSizeChecks: productionSizeChecks('S', 'pass') };
    wrong.contentFingerprint = await reportContentFingerprint(db.tx, wrong); db.reports.set(wrong.id, wrong);
    await expect(appendProductionQcReportFacts(db.tx, { assignment, report: wrong, actorId: 'QC1', requestKey: 'wrong-size',
      commandHash: 'hash2', resolvesIssueIds: [issue.id] })).rejects.toThrow(/M/);
    expect(db.events.filter(row => row.kind === 'qc_resolved')).toHaveLength(0);
    const pass: any = { ...wrong, id: 'PASS-M', productionSizeChecks: productionSizeChecks('M', 'pass') };
    pass.contentFingerprint = await reportContentFingerprint(db.tx, pass); db.reports.set(pass.id, pass);
    await appendProductionQcReportFacts(db.tx, { assignment, report: pass, actorId: 'QC1', requestKey: 'right-size',
      commandHash: 'hash3', resolvesIssueIds: [issue.id] });
    expect(db.events.at(-1).kind).toBe('qc_resolved');
    expect(db.events.some(row => row.kind === 'business_resumed')).toBe(false);
    pass.productionSizeChecks.checks[0].evidence = ['file:changed.pdf'];
    await expect(resumeProductionQcIssues({ prisma: db.prisma, productionBatchId: 'PB1', actor,
      input: { orderLineId: 'OL1', expectedRevision: 3, requestKey: 'resume-changed-evidence' } })).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    expect(db.events.some(row => row.kind === 'business_resumed')).toBe(false);
  });
});
