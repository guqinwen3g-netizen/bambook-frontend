import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQcScopedService } from '../qcScopedService';

const state = vi.hoisted(() => ({ audits: [] as any[], assignment: null as any, businessLine: 'fabric',
  permissions: ['qc:read', 'qc:inspect'] }));

vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn(async (input: any) => {
    const id = `AUDIT-${state.audits.length + 1}`;
    state.audits.push({ id, actorId: input.actorId, action: input.operation, targetId: input.targetId,
      detail: { source: input.source, after: input.after }, createdAt: BigInt(state.audits.length + 1) });
    return id;
  }),
}));
vi.mock('../qcAssignmentAccess', () => ({
  qcAssignmentAccess: vi.fn(async (_tx: any, prior: any) => ({ assignment: state.assignment,
    actor: { userId: prior.userId, permissions: [...state.permissions] }, delegated: false })),
}));
vi.mock('../qcAssignmentUsers', () => ({ assertQcAssignmentUser: vi.fn(async () => undefined) }));
vi.mock('../qcPhysicalCoverage', () => ({
  lockQcCoverage: vi.fn(async () => undefined),
  resolveQcCoverage: vi.fn(async () => ({ scopeType: 'production_batch', scopeKey: 'production_batch:PB1',
    productionBatchId: 'PB1', productionBatchRevision: 3, scopeSnapshot: { lines: [] },
    scopeFingerprint: 'a'.repeat(64), factoryRelationId: 'F1' })),
  requireQcCoverageMatch: vi.fn((scope: any, expected: string) => {
    if (scope.scopeFingerprint !== expected) throw new Error('coverage mismatch');
  }),
}));
vi.mock('../qcReportAuthority', () => ({
  qcReportSourceFingerprint: (value: unknown) => JSON.stringify(value),
  qcReportAccess: vi.fn(), qcReportOrderAccess: vi.fn(),
  QcReportError: class QcReportError extends Error {
    constructor(readonly code: string, message: string, readonly reason?: string) { super(message); }
  },
}));
vi.mock('../qcReportReadProjection', () => ({
  QC_REPORT_CONTENT_FIELDS: ['result', 'inspectionDate', 'totalUnits', 'passedUnits', 'criticalDefects', 'majorDefects', 'minorDefects', 'productionSizeChecks'],
  reportContentFingerprint: vi.fn(async () => 'content-fingerprint'),
}));
vi.mock('../qcService', () => ({ normalizeWidthInputs: vi.fn(() => []) }));
vi.mock('../productionQcIssueService', () => ({ appendProductionQcReportFacts: vi.fn(async () => []) }));
vi.mock('../../shared/localDate', () => ({ isValidLocalDateKey: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value), todayLocalKey: () => '2026-10-07' }));

const actor = { userId: 'QC-1' } as any;
const fingerprint = 'a'.repeat(64);
function report(requestKey: string, result: 'pass' | 'fail', notes: string) {
  return { requestKey, expectedScopeFingerprint: fingerprint,
    report: { result, inspectionDate: '2026-10-07', totalUnits: 10, passedUnits: result === 'pass' ? 10 : 8,
      criticalDefects: 0, majorDefects: 0, minorDefects: result === 'pass' ? 0 : 2, notes } };
}

function fixture() {
  state.audits.splice(0);
  state.businessLine = 'fabric';
  state.permissions = ['qc:read', 'qc:inspect'];
  state.assignment = { id: 'QCA-1', orderId: 'O1', inspectionType: 'final', scopeType: 'production_batch',
    scopeKey: 'production_batch:PB1', productionBatchId: 'PB1', productionBatchRevision: 3,
    scopeFingerprint: fingerprint, status: 'Assigned', reportId: null, completedAt: null, deletedAt: null };
  const reports: any[] = [];
  const db: any = {
    order: { findUnique: async () => ({ id: 'O1', ownerId: 'SALES-1', code: 'ORD-1', businessLine: state.businessLine, type: state.businessLine }) },
    userAccount: { findUnique: async () => ({ id: 'SALES-1', status: 'active', deletedAt: null }) },
    notification: { createMany: vi.fn(async () => ({ count: 1 })) },
    qCAssignment: {
      findUnique: async ({ where }: any) => where.id === state.assignment.id ? { ...state.assignment } : null,
      update: async ({ where, data }: any) => { expect(where.id).toBe(state.assignment.id); Object.assign(state.assignment, data); return { ...state.assignment }; },
    },
    inspectionReport: {
      findUnique: async ({ where }: any) => {
        const request = where.inspectedBy_requestKey;
        return request ? reports.find(row => row.inspectedBy === request.inspectedBy && row.requestKey === request.requestKey) ?? null
          : reports.find(row => row.id === where.id) ?? null;
      },
      findFirst: async ({ where }: any) => reports.filter(row => row.orderId === where.orderId
        && row.inspectionType === where.inspectionType && row.scopeKey === where.scopeKey)
        .sort((a, b) => b.revision - a.revision)[0] ?? null,
      create: async ({ data }: any) => { reports.push({ ...data }); return { ...data }; },
      update: async ({ where, data }: any) => { const row = reports.find(item => item.id === where.id); Object.assign(row, data); return { ...row }; },
    },
    inspectionWidthMeasurement: { findMany: async () => [] },
    auditLog: { findMany: async ({ where }: any) => state.audits.filter(row => row.actorId === where.actorId
      && row.action === where.action && row.targetId === where.targetId) },
    $transaction: async (run: any) => run(db),
    _reports: reports,
  };
  return { db, reports };
}

describe('scoped production QC assignment persistence', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not write a report or replay a receipt without an actual professional grant at the completion entry', async () => {
    const { db, reports } = fixture(); state.permissions = ['qc:read', 'qc:write'];
    await expect(createQcScopedService(db).complete('QCA-1', report('business-cannot-inspect', 'pass', '不能由业务填写'), actor))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(reports).toHaveLength(0); expect(state.audits).toHaveLength(0);
  });

  it('keeps one production inspection assignment open for appended reports and replays the exact earlier receipt', async () => {
    const { db, reports } = fixture();
    const service = createQcScopedService(db);

    const firstCommand = report('qc-report-1', 'fail', '第一次巡检发现问题');
    const first = await service.complete('QCA-1', firstCommand, actor);
    expect(first.replayed).toBe(false);
    expect(first.item).toMatchObject({ status: 'InProgress', completedAt: null, reportId: first.report.id });

    const secondCommand = report('qc-report-2', 'pass', '复验通过后继续巡检');
    const second = await service.complete('QCA-1', secondCommand, actor);
    expect(second.replayed).toBe(false);
    expect(second.item).toMatchObject({ status: 'InProgress', completedAt: null, reportId: second.report.id });
    expect(reports).toHaveLength(2);

    const replay = await service.complete('QCA-1', firstCommand, actor);
    expect(db.notification.createMany).toHaveBeenCalledTimes(2);
    expect(db.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ userId: 'SALES-1', type: 'production_qc_report_returned',
      metadata: { orderId: 'O1', productionBatchId: 'PB1', reportId: first.report.id, actualInspectorId: 'QC-1' } });
    expect(replay.replayed).toBe(true);
    expect(replay.item.reportId).toBe(first.report.id);
    expect(replay.report.id).toBe(first.report.id);
    expect(reports).toHaveLength(2);
    expect(state.audits).toHaveLength(2);

    await expect(service.complete('QCA-1', report('qc-report-1', 'pass', '篡改同一请求键'), actor)).rejects.toThrow();
    expect(reports).toHaveLength(2);
  });

  it('requires explicit actual garment checks and persists their immutable evidence in the exact receipt', async () => {
    const { db, reports } = fixture(); state.businessLine = 'garment';
    const service = createQcScopedService(db);
    await expect(service.complete('QCA-1', report('missing-size', 'pass', '无逐码事实'), actor)).rejects.toThrow(/逐尺码/);
    expect(reports).toHaveLength(0);
    const productionSizeChecks = { schemaVersion: 1 as const, actualSizes: ['M'], scopeComplete: true,
      basis: '现场核对本批次实际只生产 M', checks: [{ size: 'M', inspectedUnits: 2, result: 'pass' as const, evidence: ['file:M-actual.pdf'] }] };
    const command = { ...report('garment-size', 'pass', '已检 M'), report: { ...report('garment-size', 'pass', '已检 M').report, productionSizeChecks } };
    const response = await service.complete('QCA-1', command, actor);
    expect(response.report.productionSizeChecks).toEqual(productionSizeChecks);
    expect(response.receipt.commandSnapshot.report.productionSizeChecks).toEqual(productionSizeChecks);
    await expect(service.complete('QCA-1', { ...command, report: { ...command.report,
      productionSizeChecks: { ...productionSizeChecks, checks: [{ ...productionSizeChecks.checks[0], evidence: ['file:changed.pdf'] }] } } }, actor)).rejects.toThrow();
    expect(reports).toHaveLength(1);
  });

  it('rejects a pass containing a failed size and rejects garment facts on fabric reports', async () => {
    const { db, reports } = fixture();
    const productionSizeChecks = { schemaVersion: 1 as const, actualSizes: ['S'], scopeComplete: false, basis: '实际巡检',
      checks: [{ size: 'S', inspectedUnits: 1, result: 'fail' as const, evidence: ['photo:S'] }] };
    const command = { ...report('bad-check', 'pass', ''), report: { ...report('bad-check', 'pass', '').report, productionSizeChecks } };
    await expect(createQcScopedService(db).complete('QCA-1', command, actor)).rejects.toThrow(/不能填写/);
    await expect(createQcScopedService(db).complete('QCA-1', { ...command, report: { ...command.report, result: 'fail' } }, actor)).rejects.toThrow(/面料/);
    expect(reports).toHaveLength(0);
  });
});
