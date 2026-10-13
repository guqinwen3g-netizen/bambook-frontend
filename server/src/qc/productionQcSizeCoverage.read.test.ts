import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ facts: vi.fn(), scope: vi.fn() }));
vi.mock('../production/productionBatchFacts', () => ({ resolveCurrentProductionBatchFacts: m.facts }));
vi.mock('./qcPhysicalCoverage', () => ({ resolveQcCoverage: m.scope }));
import { readProductionQcReleaseCoverage, readProductionQcSizeCoverage } from './productionQcSizeCoverage';
import { reportContentFingerprint } from './qcReportReadProjection';

const fp = 'a'.repeat(64), batch = { id: 'PB1', orderId: 'O1', orderLineId: 'OL1', revision: 2 };
const check = (size: string, result: 'pass' | 'fail' = 'pass') => ({ size, result, inspectedUnits: 1, evidence: [`photo:${size}`] });
const facts = (sizes: string[], complete = true, checks = sizes.map(size => check(size))) => ({ schemaVersion: 1,
  actualSizes: sizes, scopeComplete: complete, basis: '现场实际生产记录', checks });
function store() {
  const rows: any[] = [], issues: any[] = [], events: any[] = [];
  let completion: any = null;
  const tx: any = { productionBatch: { findUnique: async () => batch },
    order: { findUnique: async () => ({ businessLine: 'garment' }) },
    productionBatchCompletion: { findUnique: async () => completion },
    inspectionReport: { findMany: vi.fn(async () => rows), findUnique: async ({ where }: any) => rows.find(row => row.id === where.id) ?? null },
    inspectionWidthMeasurement: { findMany: async () => [] },
    productionQcIssue: { findMany: async () => issues }, productionQcIssueEvent: { findMany: async ({ where }: any) => events.filter(row => row.issueId === where.issueId) } };
  const add = async (id: string, sizeFacts = facts(['S', 'M']), overrides: Record<string, unknown> = {}) => {
    const row: any = { id, orderId: 'O1', scopeType: 'production_batch', scopeKey: 'production_batch:PB1', productionBatchId: 'PB1',
      productionBatchRevision: 2, scopeFingerprint: fp, result: 'pass', createdAt: String(rows.length + 1), productionSizeChecks: sizeFacts, ...overrides };
    row.contentFingerprint = await reportContentFingerprint(tx, row); rows.push(row); return row;
  };
  return { tx, rows, issues, events, add, setCompletion: (value: any) => { completion = value; } };
}
beforeEach(() => { m.scope.mockReset().mockResolvedValue({ scopeFingerprint: fp });
  m.facts.mockReset().mockResolvedValue({ order: { businessLine: 'garment' }, line: { id: 'OL1', unit: 'PC', sizeBreakdown: { S: 5, M: 5 } }, batch, lineFingerprint: 'line-current' }); });
const params = { orderId: 'O1', productionBatchId: 'PB1', expectedBatchRevision: 2 };

describe('native exact factory/version size coverage reads and release gate', () => {
  it('only counts current exact content and never another factory, revision, source or whole-order report', async () => {
    const db = store();
    for (const overrides of [{ productionBatchId: 'PB2' }, { productionBatchRevision: 1 }, { scopeFingerprint: 'b'.repeat(64) }, { scopeType: 'whole_order' }]) await db.add(`FOREIGN-${db.rows.length}`, facts(['S', 'M']), overrides);
    expect(await readProductionQcSizeCoverage(db.tx, params)).toMatchObject({ applicable: true, satisfied: false, actualSizes: [] });
    await db.add('EXACT');
    expect(await readProductionQcReleaseCoverage(db.tx, params)).toMatchObject({ satisfied: true, sizeCoverage: { actualSizes: ['M', 'S'] } });
    db.rows.at(-1).productionSizeChecks.checks[0].evidence = ['tampered'];
    expect(await readProductionQcReleaseCoverage(db.tx, params)).toMatchObject({ satisfied: false, sizeCoverage: { available: false } });
  });
  it('compares explicit actual completion sizes while preserving the quality/quantity separation', async () => {
    const db = store(); await db.add('S', facts(['S']));
    db.setCompletion({ orderId: 'O1', orderLineId: 'OL1', unit: 'PC', lineFingerprint: 'line-current', actualQuantity: '10', actualSizeBreakdown: { S: 10, M: 0 } });
    expect(await readProductionQcSizeCoverage(db.tx, params)).toMatchObject({ satisfied: true });
    db.setCompletion({ orderId: 'O1', orderLineId: 'OL1', unit: 'PC', lineFingerprint: 'line-current', actualQuantity: '10', actualSizeBreakdown: { S: 9, M: 1 } });
    expect(await readProductionQcSizeCoverage(db.tx, params)).toMatchObject({ satisfied: false, missingSizes: ['M'] });
    db.setCompletion({ orderId: 'O1', orderLineId: 'OL1', unit: 'PC', lineFingerprint: 'line-current', actualQuantity: '10', actualSizeBreakdown: {} });
    expect(await readProductionQcSizeCoverage(db.tx, params)).toMatchObject({ available: false, satisfied: false });
    db.setCompletion({ orderId: 'O1', orderLineId: 'OL1', unit: 'PC', lineFingerprint: 'old-version', actualQuantity: '10' });
    expect(await readProductionQcSizeCoverage(db.tx, params)).toMatchObject({ available: false, satisfied: false });
  });
  it('keeps the branch blocked after a valid named retest until a separate business-resumed event', async () => {
    const db = store(); const fail = await db.add('NOK', facts(['S', 'M'], true, [check('M', 'fail')]), { result: 'fail' });
    await db.add('PASS', facts(['S', 'M']));
    db.issues.push({ id: 'I1', orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', productionBatchRevision: 2,
      failedReportId: fail.id, createdBy: 'QC1', createdAt: '1' });
    const event = { issueId: 'I1', orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', productionBatchRevision: 2 };
    db.events.push({ ...event, id: 'E1', kind: 'opened', fromStatus: null, toStatus: 'open', reportId: 'NOK', createdAt: '1' });
    expect((await readProductionQcReleaseCoverage(db.tx, params)).satisfied).toBe(false);
    db.events.push({ ...event, id: 'E2', kind: 'qc_resolved', fromStatus: 'open', toStatus: 'resolved', reportId: 'PASS', createdAt: '2' });
    expect(await readProductionQcReleaseCoverage(db.tx, params)).toMatchObject({ satisfied: false,
      productionQcIssues: { issues: [{ status: 'waiting_business_resume', failedSizes: ['M'] }] } });
    db.events.push({ ...event, id: 'E3', kind: 'business_resumed', fromStatus: 'waiting_business_resume', toStatus: 'resumed', reportId: 'PASS', createdAt: '3' });
    expect((await readProductionQcReleaseCoverage(db.tx, params)).satisfied).toBe(true);
  });
  it('does not impose garment size records on fabric and blocks unreadable issue authority', async () => {
    const db = store(); m.facts.mockResolvedValue({ order: { businessLine: 'fabric' }, line: { id: 'OL1', unit: 'M' }, batch });
    expect(await readProductionQcReleaseCoverage(db.tx, params)).toMatchObject({ satisfied: true, sizeCoverage: { applicable: false } });
    delete db.tx.productionQcIssue.findMany;
    expect(await readProductionQcReleaseCoverage(db.tx, params)).toMatchObject({ satisfied: false, productionQcIssues: { available: false } });
  });
});
