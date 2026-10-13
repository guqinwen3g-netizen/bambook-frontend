import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { productionBatchSourceFingerprint } from '../production/productionBatchFacts';
import { productionLineDigest } from '../production/productionLineIdentity';
import { resolveQcCoverage } from '../qc/qcPhysicalCoverage';
import { reportContentFingerprint } from '../qc/qcReportReadProjection';

const seams = vi.hoisted(() => ({ actors: new Map<string, any>(), sources: vi.fn(), ci: vi.fn(), pl: vi.fn(), sample: vi.fn() }));
vi.mock('../auth/tokenHelpers', () => ({
  loadUserWithRoles: vi.fn(async (_tx, id) => ({ id, status: 'active', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async (_tx, user) => seams.actors.get(user.id)),
}));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({})) }));
vi.mock('../production/productionCompletionService', () => ({ readOrderLineProductionCompletion: vi.fn(async () => ({
  status: 'not_started', actualQty: null, unit: 'pcs', productionComplete: false, branches: [], blockers: [],
})) }));
vi.mock('../samples/orderSampleConsumerProof', () => ({ resolveOrderSampleConsumerProof: seams.sample }));
vi.mock('./shipmentDocumentSource', async original => ({ ...(await original<any>()), lockShipmentDocumentSourcesInTx: seams.sources }));
vi.mock('./shipmentExportDeclaration', () => ({ assertShipmentExportDeclarationProof: vi.fn(async () => undefined) }));
vi.mock('../customs/businessShipmentCiSnapshot', () => ({ isBusinessShipmentCi: () => true, readBusinessShipmentCiVersionInTx: seams.ci }));
vi.mock('../customs/businessShipmentCi', () => ({ buildBusinessShipmentCiSnapshot: () => ({ sourceFingerprint: 'ci-current' }) }));
vi.mock('../customs/shipmentPackingListCommand', () => ({ readPackingListVersionInTx: seams.pl }));

import { evaluateShipmentHandoffEligibility, transitionShipmentHandoff } from './shipmentHandoffService';

const singleLineDeclaration = { schemaVersion: 1, mode: 'factory_single', factoryRelationId: 'F1',
  productionLineId: null, lineRevision: null, name: null, location: null,
  declaredBy: 'B1', declaredAt: '2026-10-07T05:00:00.000Z' };
const singleLineIdentity = { ...singleLineDeclaration, fingerprint: productionLineDigest(singleLineDeclaration) };

// Pure storage/composition evidence. The handoff transition and current source,
// per-size content binding and issue lifecycle readers are real. Document and
// authentication boundaries are mocked; PG/HTTP/PDF evidence is a separate suite.
async function fixture() {
  const order: any = { id: 'O1', deletedAt: null, businessLine: 'garment', type: 'garment', customerRelationId: 'C1',
    customer: 'Synthetic customer', consigneeRelationId: 'D1', consigneeName: 'Synthetic consignee', millRelationId: 'F1' };
  const line: any = { id: 'L1', orderId: 'O1', lineNumber: 1, quantity: '100', unit: 'pcs',
    confirmedSourceType: 'Asset', confirmedSourceId: 'AS1', specSnapshot: { color: 'blue' },
    sizeBreakdown: { S: 50, M: 50 }, requiredSampleFamilies: ['garment_pp', 'garment_ship'], partialShipmentAllowed: true };
  const batch: any = { id: 'PB1', batchCode: 'B1', orderId: 'O1', orderLineId: 'L1', state: 'active', revision: 1,
    factoryRelationId: 'F1', productionLineId: null, productionLineSnapshot: singleLineIdentity,
    quantity: '100', rangeStart: '0', unit: 'pcs',
    confirmedSourceType: line.confirmedSourceType, confirmedSourceId: line.confirmedSourceId, specSnapshot: line.specSnapshot,
    sourceFingerprint: productionBatchSourceFingerprint(order, line, 'F1') };
  const handoff: any = { id: 'H1', shipmentId: 'S1', status: 'Processing', businessActorId: 'B1', logisticsActorId: 'LGS',
    updatedAt: BigInt(10), createdAt: BigInt(1) };
  const shipment: any = { id: 'S1', orderId: 'O1', type: 'Export', status: 'Booked', atd: null, deletedAt: null,
    shippingMethod: 'Sea', loadType: 'LCL', vesselOrFlight: 'Synthetic vessel', voyageNumber: 'V1',
    portOfLoading: 'Shanghai', portOfDischarge: 'London' };
  const allocation: any = { id: 'A1', shipmentId: 'S1', orderId: 'O1', orderLineId: 'L1', unit: 'pcs',
    plannedQty: '5', actualQty: '5', status: 'Planned', updatedAt: BigInt(9) };
  const reports: any[] = [], issues: any[] = [], issueEvents: any[] = [], events: any[] = [];
  let sourceLocksAcquired = false;
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
  const branch: any = { id: 'HL1', handoffId: 'H1', allocationId: 'A1', orderId: 'O1', orderLineId: 'L1',
    productionBatchId: 'PB1', productionBatchRevision: 1, factoryRelationId: 'F1', unit: 'pcs', plannedQty: '5',
    requiredSampleFamilies: line.requiredSampleFamilies, eligibilityFingerprint: null, scopeFingerprint: null };
  const physical: any = { id: 'SPA1', allocationId: 'A1', shipmentId: 'S1', orderId: 'O1', orderLineId: 'L1',
    productionBatchId: 'PB1', productionBatchRevision: 1, unit: 'pcs', state: 'reserved', plannedQty: '5', actualQty: '5',
    updatedAt: BigInt(9), scopeSnapshot: {} };
  const ci = { id: 'CI1', shipmentId: 'S1', type: 'CommercialInvoice', domain: 'customs', status: 'Issued',
    sourceInvoiceId: null, deletedAt: null };
  const pl = { ...ci, id: 'PL1', type: 'PackingList' };
  const tx: any = {
    order: { findFirst: vi.fn(async () => order), findUnique: vi.fn(async () => order), findMany: vi.fn(async () => [order]) },
    orderLine: { findUnique: vi.fn(async () => line), findMany: vi.fn(async () => [line]) },
    productAsset: { findUnique: vi.fn(async () => ({ id: 'AS1', mainCategory: 'garment', garmentProfile: { factoryRelationId: 'F1' } })) },
    productionBatch: { findUnique: vi.fn(async () => batch), findMany: vi.fn(async () => [batch]) },
    productionBatchCompletion: { findUnique: vi.fn(async () => null) },
    relation: { findUnique: vi.fn(async () => ({ id: 'F1', name: 'Synthetic factory', deletedAt: null })) },
    shipmentHandoff: { findUnique: vi.fn(async () => handoff), updateMany: vi.fn(async ({ where, data }: any) => {
      if (where.status !== handoff.status || String(where.updatedAt) !== String(handoff.updatedAt)) return { count: 0 };
      Object.assign(handoff, data); return { count: 1 };
    }) },
    shipmentHandoffLine: { findMany: vi.fn(async () => [branch]) },
    shipmentHandoffEvent: { findMany: vi.fn(async () => events), create: vi.fn(async ({ data }: any) => { events.push(data); return data; }) },
    shipment: { findUnique: vi.fn(async () => shipment) },
    shipmentOrderAllocation: { findMany: vi.fn(async () => [allocation]) },
    shipmentProductionAllocation: { findMany: vi.fn(async () => [physical]) },
    tradeDocument: { findMany: vi.fn(async ({ where }: any) => [ci, pl].filter(doc => doc.type === where.type)) },
    letterOfCredit: { findMany: vi.fn(async () => []) },
    inspectionReport: { findMany: vi.fn(async ({ where }: any) => {
      expect(sourceLocksAcquired, 'current QC size observations must be read after document-source locks').toBe(true);
      return reports.filter(row => matches(row, where));
    }), findUnique: vi.fn(async ({ where }: any) => reports.find(row => row.id === where.id) ?? null) },
    inspectionWidthMeasurement: { findMany: vi.fn(async () => []) },
    productionQcIssue: { findMany: vi.fn(async ({ where }: any) => issues.filter(row => matches(row, where))) },
    productionQcIssueEvent: { findMany: vi.fn(async ({ where }: any) => issueEvents.filter(row => row.issueId === where.issueId)) },
    $queryRaw: vi.fn(async () => [{ id: 'synthetic-lock-row' }]),
  };
  const prisma: any = { $transaction: (work: any) => work(tx) };
  const actor: any = { userId: 'LGS', roles: [], roleIds: [SYSTEM_ROLE_IDS.LOGISTICS], authorizationLoaded: true,
    permissions: ['orders:read', 'orders:write', 'shipments:read', 'shipments:write'] };
  seams.actors.set(actor.userId, actor);
  const coverage = await resolveQcCoverage(tx, 'O1', { scopeType: 'production_batch', productionBatchId: 'PB1' });
  branch.scopeFingerprint = coverage.scopeFingerprint; physical.scopeSnapshot = { scopeFingerprint: coverage.scopeFingerprint };
  const preview = await evaluateShipmentHandoffEligibility({ prisma, actor, input: { shippingMethod: 'Sea',
    requestKey: '4dc58690-9475-4af5-8a8b-f671f7021588', allocations: [{ orderId: 'O1', orderLineId: 'L1', productionBatchId: 'PB1',
      productionBatchRevision: 1, factoryRelationId: 'F1', unit: 'pcs', plannedQty: '5' }] } });
  expect(preview.eligible).toBe(true); branch.eligibilityFingerprint = preview.branches[0].eligibilityFingerprint;
  seams.sources.mockImplementation(async () => { sourceLocksAcquired = true; return [{ shipment, kind: 'physical',
    orderIds: ['O1'], fingerprint: 'packing-current', cartonCoverageComplete: true, lines: [{ id: 'SL1' }] }]; });
  seams.ci.mockResolvedValue({ document: ci, version: { version: 1 }, latestVersion: { version: 1 },
    snapshot: { shipmentId: 'S1', issuedAt: '2026-10-07', sourceFingerprint: 'ci-current', lines: [{ shipmentLineId: 'SL1' }] } });
  seams.pl.mockResolvedValue({ document: pl, protocol: 2, provenance: 'native', warnings: [], envelope: {
    packingListSource: { source: { shipmentId: 'S1', kind: 'physical', cartonCoverageComplete: true, fingerprint: 'packing-current' },
      lines: [{ shipmentLineId: 'SL1' }] } } });
  const addReport = async (actualSizes: string[], checkedSizes: string[], options: { result?: 'pass' | 'fail'; failedSize?: string } = {}) => {
    const report: any = { id: `R${reports.length + 1}`, orderId: 'O1', inspectionType: 'inline', scopeType: 'production_batch',
      productionBatchId: 'PB1', productionBatchRevision: 1, scopeFingerprint: coverage.scopeFingerprint,
      result: options.result ?? 'pass', createdAt: String(reports.length + 1), productionSizeChecks: { schemaVersion: 1,
        actualSizes, scopeComplete: true, basis: 'Synthetic actual factory size count from an explicit QC visit',
        checks: checkedSizes.map(size => ({ size, inspectedUnits: 2, result: options.failedSize === size ? 'fail' : 'pass',
          evidence: [`synthetic-size-photo:${reports.length}:${size}`] })) } };
    report.contentFingerprint = await reportContentFingerprint(tx, report); reports.push(report); return report;
  };
  await addReport(['S', 'M'], ['S', 'M']);
  const complete = () => transitionShipmentHandoff({ prisma, handoffId: 'H1', actor, action: 'complete',
    input: { expectedUpdatedAt: String(handoff.updatedAt), note: 'Return current issued packing documents to the original business owner' } });
  return { tx, handoff, branch, reports, issues, issueEvents, events, complete, addReport };
}

function sampleProof(family: string, parentFingerprint = 'parent-before', feedbackEventId = 'customer-approved') {
  return { mode: 'native', qualified: true, proof: { schemaVersion: 1, family,
    proofFingerprint: `${family}:${parentFingerprint}:${feedbackEventId}`, parentFingerprint,
    source: { sourceId: `source-${family}`, specSnapshot: { color: 'blue' } }, head: { eventId: feedbackEventId, sequence: 4 },
    scope: { orderLineId: 'L1', productionBatchId: 'PB1', productionBatchRevision: 1,
      productionLineMode: 'factory_single', productionLineId: null, productionLineRevision: null,
      productionLineFingerprint: singleLineIdentity.fingerprint },
    feedbackEvent: { id: feedbackEventId, payload: { result: 'approved' } }, qcReport: { result: 'passed' } } };
}

beforeEach(() => {
  seams.actors.clear(); seams.sources.mockReset(); seams.ci.mockReset(); seams.pl.mockReset();
  seams.sample.mockReset().mockImplementation(async (_db, _target, family) => sampleProof(family));
});

describe('handoff document return consumes current exact branch quality', () => {
  it('does not accept a qualified-looking PP proof whose declared actual production organization changed', async () => {
    const f = await fixture();
    seams.sample.mockImplementation(async (_db, _target, family) => {
      const result = sampleProof(family);
      if (family === 'garment_pp') result.proof.scope.productionLineFingerprint = 'f'.repeat(64);
      return result;
    });
    await expect(f.complete()).rejects.toMatchObject({ code: 'GATE_BLOCKED', statusCode: 409 });
    expect(f.handoff.status).toBe('Processing'); expect(f.events).toEqual([]); expect(seams.ci).not.toHaveBeenCalled();
  });
  it('keeps current qualified sample facts valid after an unrelated parent concurrency timestamp changes', async () => {
    const f = await fixture(), frozenEligibility = f.branch.eligibilityFingerprint;
    // A second shipment draft cancellation changes Order.updatedAt, which is
    // included in the sample resolver parent concurrency fingerprint. Its
    // accurate scope, original QC, customer event and all audit facts remain.
    seams.sample.mockImplementation(async (_db, _target, family) => sampleProof(family, 'parent-after-other-shipment'));
    const returned = await f.complete();
    expect(returned.handoff.status).toBe('ReturnedToBusiness');
    expect(f.branch.eligibilityFingerprint).toBe(frozenEligibility); expect(f.events).toHaveLength(1);
  });

  it('still rejects changed original sample or actual requester evidence after packing', async () => {
    const f = await fixture();
    seams.sample.mockImplementation(async (_db, _target, family) => sampleProof(family, 'parent-after', 'different-customer-event'));
    await expect(f.complete()).rejects.toMatchObject({ code: 'GATE_BLOCKED', statusCode: 409 });
    expect(f.handoff.status).toBe('Processing'); expect(f.events).toEqual([]); expect(seams.ci).not.toHaveBeenCalled();
  });

  it('after packing, a newly observed actual size blocks return until its own QC pass without rebuilding the handoff', async () => {
    const f = await fixture(), originalFingerprint = f.branch.eligibilityFingerprint;
    await f.addReport(['S', 'M', 'L'], ['S']);
    await expect(f.complete()).rejects.toMatchObject({ code: 'GATE_BLOCKED', statusCode: 409, message: expect.stringContaining('L') });
    expect(f.handoff.status).toBe('Processing'); expect(f.events).toEqual([]); expect(seams.ci).not.toHaveBeenCalled();
    await f.addReport(['S', 'M', 'L'], ['L']);
    const returned = await f.complete();
    expect(returned.handoff.status).toBe('ReturnedToBusiness'); expect(returned.shipment.status).toBe('Booked');
    expect(returned.shipment.atd).toBeNull(); expect(f.branch.eligibilityFingerprint).toBe(originalFingerprint);
    expect(f.events).toHaveLength(1); expect(seams.ci).toHaveBeenCalledOnce();
  });

  it('a complete passing matrix never clears a QC issue that still waits for business resumption', async () => {
    const f = await fixture();
    const failed = await f.addReport(['S', 'M'], ['M'], { result: 'fail', failedSize: 'M' });
    const retest = await f.addReport(['S', 'M'], ['M']);
    f.issues.push({ id: 'I1', orderId: 'O1', orderLineId: 'L1', productionBatchId: 'PB1', productionBatchRevision: 1,
      failedReportId: failed.id, reason: 'Synthetic M quality issue', createdBy: 'QC1', createdAt: '100' });
    const identity = { issueId: 'I1', orderId: 'O1', orderLineId: 'L1', productionBatchId: 'PB1', productionBatchRevision: 1 };
    f.issueEvents.push({ ...identity, id: 'opened', kind: 'opened', fromStatus: null, toStatus: 'open', reportId: failed.id, createdAt: '100' },
      { ...identity, id: 'resolved', kind: 'qc_resolved', fromStatus: 'open', toStatus: 'resolved', reportId: retest.id, createdAt: '101' });
    await expect(f.complete()).rejects.toMatchObject({ code: 'GATE_BLOCKED', statusCode: 409 });
    expect(f.handoff.status).toBe('Processing'); expect(f.events).toEqual([]); expect(seams.ci).not.toHaveBeenCalled();
  });

  it('keeps return blocked when current production size facts cannot be read', async () => {
    const f = await fixture(); delete f.tx.productionBatchCompletion.findUnique;
    await expect(f.complete()).rejects.toMatchObject({ code: 'GATE_BLOCKED', statusCode: 409 });
    expect(f.handoff.status).toBe('Processing'); expect(f.events).toEqual([]);
  });
});
