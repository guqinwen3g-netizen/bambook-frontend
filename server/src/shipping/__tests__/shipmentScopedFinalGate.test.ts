import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { evaluateShipmentReleaseGate, SHIPMENT_RELEASE_ACTION } from '../shipmentEligibilityGate';
import { createQcService } from '../../qc/qcService';
import { resolveQcCoverage } from '../../qc/qcPhysicalCoverage';
import { reportContentFingerprint } from '../../qc/qcReportReadProjection';
import { productionBatchSourceFingerprint } from '../../production/productionBatchService';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// Unit storage seam only. Report/approval rows below are synthetic inputs, not
// native QC decisions or PG evidence. The real coverage/source fingerprint,
// latest-current selectors, release assessment and shipment gate are exercised.
function fixture(chain: 'fabric' | 'garment') {
  const order: any = { id: 'O1', type: chain === 'fabric' ? 'Fabric' : 'Garment', businessLine: chain,
    deletedAt: null, customerRelationId: 'C1', millRelationId: 'F1', sourceCaseId: null,
    paymentInstrument: 'O/A', currency: 'USD', contractAmount: new Prisma.Decimal('1000'),
    fabricSampleSentDate: null, fabricSampleConfirmedDate: null };
  const line: any = { id: 'L1', orderId: order.id, lineNumber: 1, quantity: new Prisma.Decimal('100'), unit: 'PC',
    confirmedSourceType: 'Asset', confirmedSourceId: 'AS1', specSnapshot: { color: 'blue' } };
  const batches: any[] = ['A', 'B'].map((id, index) => ({ id, batchCode: `BATCH-${id}`, orderId: order.id,
    orderLineId: line.id, state: 'active', revision: 1, factoryRelationId: 'F1', rangeStart: new Prisma.Decimal(index * 50),
    quantity: new Prisma.Decimal('50'), unit: line.unit, confirmedSourceType: line.confirmedSourceType,
    confirmedSourceId: line.confirmedSourceId, specSnapshot: line.specSnapshot,
    sourceFingerprint: productionBatchSourceFingerprint(order, line, 'F1') }));
  const reports: any[] = [], issues: any[] = [], issueEvents: any[] = [];
  const samples: any[] = [{ id: 'SS1', type: 'ship', sourceOrderId: order.id, customerStatus: 'approved', deletedAt: null }];
  const db: any = {
    order: { findUnique: vi.fn(async ({ where }: any) => where.id === order.id ? order : null),
      findFirst: vi.fn(async ({ where }: any) => where.id === order.id && order.deletedAt === null ? order : null) },
    orderLine: { findMany: vi.fn(async () => [line]), findUnique: vi.fn(async ({ where }: any) => where.id === line.id ? line : null) },
    productionBatch: { findUnique: vi.fn(async ({ where }: any) => batches.find(batch => batch.id === where.id) ?? null),
      findMany: vi.fn(async () => batches.filter(batch => batch.state === 'active')),
      count: vi.fn(async () => batches.filter(batch => batch.state === 'active').length) },
    productAsset: { findUnique: vi.fn(async () => ({ id: 'AS1', mainCategory: chain,
      fabricProfile: { millOrganizationId: 'F1' }, garmentProfile: { factoryRelationId: 'F1' } })) },
    inspectionReport: { findFirst: vi.fn(async ({ where }: any) => reports.filter(report => report.orderId === where.orderId
      && report.inspectionType === where.inspectionType && report.scopeKey === where.scopeKey)
      .sort((a, b) => b.revision - a.revision)[0] ?? null),
      findUnique: vi.fn(async ({ where }: any) => reports.find(report => report.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => reports.filter(report => Object.entries(where).every(([key, value]) => report[key] === value))) },
    inspectionWidthMeasurement: { findMany: vi.fn(async () => []) },
    productionBatchCompletion: { findUnique: vi.fn(async () => null) },
    productionQcIssue: { findMany: vi.fn(async ({ where }: any) => issues.filter(issue => Object.entries(where).every(([key, value]) => issue[key] === value))) },
    productionQcIssueEvent: { findMany: vi.fn(async ({ where }: any) => issueEvents.filter(event => event.issueId === where.issueId)) },
    sample: { findMany: vi.fn(async () => samples) },
    orderSampleSource: { findFirst: vi.fn(async () => null) },
    paymentVoucher: { findMany: vi.fn(async () => []) },
    letterOfCredit: { findMany: vi.fn(async () => []) },
  };
  async function addReport(batchId: string | null, overrides: Record<string, unknown> = {}) {
    const coverage = await resolveQcCoverage(db, order.id, batchId
      ? { scopeType: 'production_batch', productionBatchId: batchId } : { scopeType: 'whole_order' });
    const report: any = { id: `R-${batchId ?? 'WHOLE'}-${reports.length}`, orderId: order.id, inspectionType: 'final',
      scopeType: coverage.scopeType, productionBatchId: coverage.productionBatchId,
      productionBatchRevision: coverage.productionBatchRevision, createdAt: String(reports.length + 1),
      scopeKey: coverage.scopeKey, scopeFingerprint: coverage.scopeFingerprint, scopeSnapshot: coverage.scopeSnapshot,
      revision: 1, result: 'pass', totalUnits: 100, passedUnits: 98, defectUnits: 2, criticalDefects: 0,
      approvedByBusiness: true, inspectedBy: 'QC1', inspectionDate: '2026-10-02',
      ...(chain === 'garment' && batchId ? { productionSizeChecks: { schemaVersion: 1, actualSizes: ['S', 'M'], scopeComplete: true,
        basis: 'Synthetic unit input: QC explicitly counted the actual factory sizes',
        checks: ['S', 'M'].map(size => ({ size, inspectedUnits: 2, result: 'pass', evidence: [`synthetic-photo:${batchId}:${size}`] })) } } : {}),
      ...overrides };
    report.contentFingerprint = await reportContentFingerprint(db, report);
    reports.push(report);
    return report;
  }
  const rebindReport = async (report: any) => { report.contentFingerprint = await reportContentFingerprint(db, report); };
  async function issueFor(failedReport: any, status: 'open' | 'waiting_business_resume' | 'resumed', retest?: any) {
    const issue = { id: `I-${issues.length}`, orderId: order.id, orderLineId: line.id, productionBatchId: failedReport.productionBatchId,
      productionBatchRevision: failedReport.productionBatchRevision, failedReportId: failedReport.id,
      reason: 'Synthetic current branch QC failure', createdBy: 'QC1', createdAt: '100' };
    issues.push(issue);
    const common = { issueId: issue.id, orderId: issue.orderId, orderLineId: issue.orderLineId,
      productionBatchId: issue.productionBatchId, productionBatchRevision: issue.productionBatchRevision };
    issueEvents.push({ ...common, id: `${issue.id}-opened`, kind: 'opened', fromStatus: null,
      toStatus: 'open', reportId: failedReport.id, createdAt: '100' });
    if (status !== 'open') {
      if (!retest) throw Error('fixture requires an explicit current retest');
      issueEvents.push({ ...common, id: `${issue.id}-resolved`, kind: 'qc_resolved', fromStatus: 'open',
        toStatus: 'resolved', reportId: retest.id, createdAt: '101' });
    }
    if (status === 'resumed') issueEvents.push({ ...common, id: `${issue.id}-resumed`, kind: 'business_resumed',
      fromStatus: 'waiting_business_resume', toStatus: 'resumed', reportId: retest.id, createdAt: '102' });
    return issue;
  }
  const gate = (ids?: string[], extras: Record<string, unknown> = {}) => evaluateShipmentReleaseGate({ prisma: db,
    orderIds: [order.id], ...(ids === undefined ? {} : { physicalBatchIdsByOrder: { [order.id]: ids } }), ...extras });
  return { db, order, line, batches, reports, samples, issues, issueEvents, addReport, rebindReport, issueFor, gate };
}

describe('explicit shipment physical batches consume current scoped Final evidence', () => {
  it.each(['fabric', 'garment'] as const)('%s: A can ship independently of failed B; both together cannot', async chain => {
    const f = fixture(chain);
    const reportA = await f.addReport('A');
    const reportB = await f.addReport('B', { result: 'fail' });
    const a = await f.gate(['A']);
    expect(a).toMatchObject({ ok: true, data: { orders: [{ via: 'gate', productionBatchIds: ['A'],
      physicalBatches: [{ productionBatchId: 'A', reportId: reportA.id, revision: 1,
        scopeFingerprint: reportA.scopeFingerprint, satisfied: true, failureReasons: [] }] }] } });
    const b = await f.gate(['B']);
    expect(b).toMatchObject({ ok: false, error: { code: 'GATE_BLOCKED', orders: [{ eligible: false,
      physicalBatches: [{ productionBatchId: 'B', reportId: reportB.id, satisfied: false }] }] } });
    expect(await f.gate(['B', 'A'])).toMatchObject({ ok: false, error: { orders: [{ productionBatchIds: ['A', 'B'] }] } });
  });

  it.each(['fabric', 'garment'] as const)('%s: newest exact failed revision cannot borrow older pass or Whole', async chain => {
    const f = fixture(chain);
    await f.addReport('A');
    const newest = await f.addReport('A', { revision: 2, result: 'fail' });
    await f.addReport(null);
    const result = await f.gate(['A']);
    expect(result).toMatchObject({ ok: false, error: { orders: [{ physicalBatches: [{ reportId: newest.id,
      revision: 2, satisfied: false }] }] } });
    expect(f.db.inspectionReport.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ scopeKey: 'whole_order' }),
    }));
  });

  it.each(['fabric', 'garment'] as const)('%s: stale exact scope cannot borrow current Whole', async chain => {
    const f = fixture(chain);
    await f.addReport('A', { scopeFingerprint: '0'.repeat(64) });
    await f.addReport(null);
    expect(await f.gate(['A'])).toMatchObject({ ok: false, error: { orders: [{ physicalBatches: [{ productionBatchId: 'A',
      reportId: null, revision: null, scopeFingerprint: null, satisfied: false }] }] } });
    expect(f.db.inspectionReport.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ scopeKey: 'whole_order' }),
    }));
  });

  it('fabric: current Whole can cover a batch only when exact history is absent', async () => {
    const f = fixture('fabric');
    const whole = await f.addReport(null);
    expect(await f.gate(['A'])).toMatchObject({ ok: true, data: { orders: [{ physicalBatches: [{
      productionBatchId: 'A', reportId: whole.id, scopeFingerprint: whole.scopeFingerprint, satisfied: true }] }] } });
    f.line.quantity = new Prisma.Decimal('101');
    expect(await f.gate(['A'])).toMatchObject({ ok: false, error: { orders: [{ physicalBatches: [{ reportId: null, satisfied: false }] }] } });
  });

  it('fabric: omitted physical map preserves legacy Whole and DTO shape', async () => {
    const f = fixture('fabric');
    f.batches.splice(0);
    const whole = await f.addReport(null, { scopeFingerprint: null, scopeSnapshot: null });
    expect(await f.gate()).toEqual({ ok: true, data: { orders: [{ orderId: 'O1', chain: 'fabric', eligible: true,
      blockingReasons: [], via: 'gate' }] } });
    const qc = createQcService(f.db);
    const legacy = await qc.checkShipmentEligibility('O1');
    expect(legacy).not.toHaveProperty('physicalBatches');
    const bulk = 'conditions' in legacy ? legacy.conditions.bulkQc : legacy.bulkQc;
    expect(bulk).toMatchObject({ reportId: whole.id, satisfied: true, result: 'pass' });
  });

  it('garment: a Whole pass cannot replace actual size observations, with or without a physical map', async () => {
    const f = fixture('garment');
    await f.addReport(null);
    expect(await f.gate(['A'])).toMatchObject({ ok: false, error: { orders: [{ physicalBatches: [{
      productionBatchId: 'A', reportId: null, satisfied: false }] }] } });
    expect(f.db.inspectionReport.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ scopeKey: 'whole_order' }),
    }));
    expect(await f.gate()).toMatchObject({ ok: false, error: { orders: [{ chain: 'garment', eligible: false }] } });
  });

  it.each(['unknown', 'missing', 'nok', 'content-changed', 'unavailable'])
  ('garment: current Final pass cannot replace %s size quality facts', async mode => {
    const f = fixture('garment');
    const report = await f.addReport('A');
    if (mode === 'unknown') report.productionSizeChecks = null;
    if (mode === 'missing') report.productionSizeChecks.checks = report.productionSizeChecks.checks.filter((row: any) => row.size !== 'M');
    if (mode === 'nok') report.productionSizeChecks.checks.find((row: any) => row.size === 'M').result = 'fail';
    if (mode === 'content-changed') report.productionSizeChecks.basis = 'Changed evidence without a native content binding';
    else await f.rebindReport(report);
    if (mode === 'unavailable') delete f.db.productionBatchCompletion.findUnique;
    expect(await f.gate(['A'])).toMatchObject({ ok: false, error: { orders: [{ physicalBatches: [{
      productionBatchId: 'A', satisfied: false }] }] } });
  });

  it('garment: independent current visits accumulate explicit size checks before Final release', async () => {
    const f = fixture('garment');
    const first = await f.addReport('A', { inspectionType: 'inline' });
    first.productionSizeChecks.scopeComplete = false;
    first.productionSizeChecks.checks = first.productionSizeChecks.checks.filter((row: any) => row.size === 'S');
    await f.rebindReport(first);
    const final = await f.addReport('A');
    final.productionSizeChecks.checks = final.productionSizeChecks.checks.filter((row: any) => row.size === 'M');
    await f.rebindReport(final);
    expect(await f.gate(['A'])).toMatchObject({ ok: true, data: { orders: [{ physicalBatches: [{
      productionBatchId: 'A', reportId: final.id, satisfied: true }] }] } });
  });

  it.each(['fabric', 'garment'] as const)('%s: a passing retest still waits for explicit branch business resumption', async chain => {
    const f = fixture(chain);
    const failed = await f.addReport('A', { inspectionType: 'inline', result: 'fail' });
    if (chain === 'garment') {
      failed.productionSizeChecks.checks.find((row: any) => row.size === 'M').result = 'fail';
      await f.rebindReport(failed);
    }
    const retest = await f.addReport('A');
    await f.addReport('B');
    const issue = await f.issueFor(failed, 'open');
    expect(await f.gate(['A'])).toMatchObject({ ok: false });
    expect(await f.gate(['B'])).toMatchObject({ ok: true });
    f.issueEvents.push({ ...f.issueEvents[0], id: 'resolved', kind: 'qc_resolved', fromStatus: 'open',
      toStatus: 'resolved', reportId: retest.id, createdAt: '101' });
    expect(await f.gate(['A'])).toMatchObject({ ok: false });
    f.issueEvents.push({ ...f.issueEvents[0], id: 'resumed', kind: 'business_resumed', fromStatus: 'waiting_business_resume',
      toStatus: 'resumed', reportId: retest.id, createdAt: '102' });
    expect(await f.gate(['A'])).toMatchObject({ ok: true });
    expect(issue.productionBatchId).toBe('A');
  });

  it.each([{}, { O1: [] }] as Array<Record<string, string[]>>)('missing or empty modern identity cannot be waived by an Order exception (%j)', async physicalBatchIdsByOrder => {
    const f = fixture('garment');
    const exceptionChecker = vi.fn(async () => ({ active: true, exception: { id: 'EXC' } } as any));
    expect(await evaluateShipmentReleaseGate({ prisma: f.db, orderIds: ['O1'], physicalBatchIdsByOrder,
      exceptionChecker })).toMatchObject({ ok: false, error: { code: 'GATE_BLOCKED',
      blockingReasons: ['O1:PHYSICAL_BATCH_SCOPE_REQUIRED'] } });
    expect(exceptionChecker).not.toHaveBeenCalled();
    expect(f.db.inspectionReport.findFirst).not.toHaveBeenCalled();
  });

  it('the QC eligibility entry point also rejects an explicitly empty batch list', async () => {
    const f = fixture('garment');
    await expect(createQcService(f.db).checkGarmentShipmentEligibility('O1', [])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f.db.inspectionReport.findFirst).not.toHaveBeenCalled();
  });

  it('a passing fabric batch still requires S/S and enabled RC customer confirmation', async () => {
    const f = fixture('fabric');
    await f.addReport('A');
    f.samples.splice(0);
    f.order.fabricSampleSentDate = '2026-10-01';
    expect(await f.gate(['A'])).toMatchObject({ ok: false, error: { orders: [{
      blockingReasons: ['SS_NOT_CONFIRMED', 'RC_NOT_CONFIRMED'], physicalBatches: [{ satisfied: true }] }] } });
  });

  it('passing scoped Final still preserves L/C and deposit blockers', async () => {
    const f = fixture('garment');
    await f.addReport('A');
    f.order.paymentInstrument = 'L/C';
    expect(await f.gate(['A'])).toMatchObject({ ok: false, error: { blockingReasons: ['O1:LC_NOT_REGISTERED'] } });
    f.order.paymentInstrument = 'T/T';
    f.order.depositRatio = 30;
    expect(await f.gate(['A'])).toMatchObject({ ok: false, error: { blockingReasons: ['O1:DEPOSIT_INSUFFICIENT'] } });
  });

  it('the existing exact Order exception can waive failed QC without changing raw batch evidence', async () => {
    const f = fixture('garment');
    const failed = await f.addReport('B', { result: 'fail' });
    const summary = { id: 'EXC-1', exceptionNumber: 'EXC-2026-0001', exceptionCategory: 'shipment_release',
      subCategory: null, status: 'ReviewerApproved', bossFinalBypass: false, validUntil: null };
    const exceptionChecker = vi.fn(async () => ({ active: true as const, exception: summary }));
    expect(await f.gate(['B'], { exceptionChecker })).toMatchObject({ ok: true, data: { orders: [{ eligible: false,
      via: 'exception', exception: summary, physicalBatches: [{ reportId: failed.id, satisfied: false }] }] } });
    expect(exceptionChecker).toHaveBeenCalledWith({ targetType: 'Order', targetId: 'O1', action: SHIPMENT_RELEASE_ACTION, at: undefined });
  });

  it('foreign/missing batch identity errors cannot become an Order exception path', async () => {
    const f = fixture('garment');
    const exceptionChecker = vi.fn();
    await expect(f.gate(['FOREIGN'], { exceptionChecker })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(exceptionChecker).not.toHaveBeenCalled();
  });

  it('failed report reads propagate rather than turning into absent Final or a waivable business gate', async () => {
    const f = fixture('garment');
    await f.addReport('A');
    f.db.inspectionReport.findFirst.mockRejectedValueOnce(new Error('storage read failed'));
    const exceptionChecker = vi.fn();
    await expect(f.gate(['A'], { exceptionChecker })).rejects.toThrow('storage read failed');
    expect(exceptionChecker).not.toHaveBeenCalled();
  });
});
