import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { buildDevelopmentQualitySourceSnapshot } from '../../development/developmentVersionGate';
import { sampleOriginFingerprint, snapshotSampleOrigin } from '../sampleOriginService';
import { createGarmentSampleGateService } from '../garmentSampleGateService';
import { createSampleRouter } from '../sampleRoute';

const { actor } = vi.hoisted(() => ({ actor: { userId: 'BUSINESS-1', roles: ['business'], permissions: ['products:write'] } }));

// This suite isolates the authorized caller/storage boundary. The production
// route, service, QC decision/audit/source helpers and physical stock writer all
// run unchanged. Authorization itself has separate graph/scope suites.
vi.mock('../../auth/moduleGuard', () => ({
  createModuleAuthGuard: () => (req: any, _res: any, next: any) => { req.actor = actor; req.authSource = 'user-session'; next(); },
  requireJwtForWrite: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../auth/permissionGuard', () => ({ requirePermission: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../sampleCustodyAuthorization', async importOriginal => {
  const original = await importOriginal<typeof import('../sampleCustodyAuthorization')>();
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const digest = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  return { ...original, authorizeSampleCustody: async ({ actor: currentActor, subject, mode }: any) => {
    const lockRefs = [{ kind: 'case', id: 'CASE-G1' }, { kind: 'relation', id: 'CUSTOMER-1' },
      { kind: 'batch', id: 'BATCH-G1' }, { kind: 'card', id: subject.id }];
    return { actor: currentActor, visibility: 'full', issues: [], lockRefs,
      guard: { version: 1, subject, mode, allowUnownedCatalog: false, historical: false, visibility: 'full',
        actorId: currentActor.userId, authorizationHash: 'fixture-current-grant', parentHash: 'fixture-current-source', lockRefsHash: digest(lockRefs) } };
  } };
});

const clone = <T>(value: T): T => {
  if (Prisma.Decimal.isDecimal(value)) return value.toString() as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
};
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, value]: any) => {
    if (key === 'OR') return value.some((item: any) => matches(row, item));
    if (key === 'AND') return value.every((item: any) => matches(row, item));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('path' in value) return value.path.reduce((current: any, part: string) => current?.[part], row[key]) === value.equals;
    }
    return row[key] === value;
  });
}
const ordered = (rows: any[], orderBy: any) => [...rows].sort((a, b) => {
  for (const order of Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) {
    const [key, direction] = Object.entries(order)[0];
    if (a[key] === b[key]) continue;
    const comparison = a[key] > b[key] ? 1 : -1;
    return direction === 'desc' ? -comparison : comparison;
  }
  return 0;
});

function fixture({ exact = true } = {}) {
  const devCase: any = { id: 'CASE-G1', code: 'DEV-G1', name: '客户成衣开发', type: 'garment', customerRelationId: 'CUSTOMER-1',
    supplierRelationId: 'FACTORY-1', customerName: '客户', ownerId: actor.userId, deletedAt: null, createdAt: 1000n, updatedAt: 1000n };
  const batch: any = { id: 'BATCH-G1', batchCode: 'SB-G1', developmentCaseId: devCase.id, supplierRelationId: 'FACTORY-1', supplierName: '工厂一',
    sampleType: 'garment-round', round: 1, sampleVersionId: exact ? 'VERSION-G1' : null, versionLabel: exact ? 'A1' : null,
    status: 'pending', qcStatus: null, customerStatus: 'pending', returnedAt: exact ? 1000n : null, returnedBy: exact ? 'WAREHOUSE-1' : null,
    actualQuantity: exact ? '1' : null, actualUnit: exact ? '件' : null, planQuantity: '1', planUnit: '件', attachments: {},
    notes: null, deletedAt: null, createdAt: 1000n, updatedAt: 1000n };
  const version: any = { id: 'VERSION-G1', developmentCaseId: devCase.id, roundId: 'ROUND-G1', supplierRelationId: batch.supplierRelationId,
    supplierName: batch.supplierName, versionLabel: 'A1', versionKind: 'major', parentVersionId: null, minorVersion: 0,
    factoryRequirements: '领口平整', deletedAt: null, createdAt: 1000n, updatedAt: 1000n };
  const origin = snapshotSampleOrigin(batch, devCase);
  const card: any = { id: 'CARD-G1', code: 'CARD-G1', devCaseId: devCase.id, batchId: batch.id, cardType: 'garment', unit: '件',
    quantity: 1, availableQty: 1, status: 'in_stock', sealedStatus: 'unsealed', deletedAt: null, createdAt: 1000n,
    receiptSnapshot: { version: 2, nativeFamily: 'garment-round', batchId: batch.id, batchCode: batch.batchCode,
      developmentCaseId: devCase.id, factoryId: batch.supplierRelationId, sourceRound: 1, sampleType: 'garment-round',
      sourceSnapshot: origin, sourceFingerprint: sampleOriginFingerprint(origin), cardType: 'garment', actualQuantity: '1', actualUnit: '件',
      colorRating: null, batchUpdatedAt: '1000', physicalItemIndex: 1, physicalItemCount: 1, initialPhysicalCardCount: 1,
      physicalUnit: '件', receivedAt: '1000', receivedBy: 'WAREHOUSE-1' } };
  const state: any = { developmentCase: [devCase], sampleBatch: [batch], developmentSampleVersion: exact ? [version] : [],
    developmentSampleRound: exact ? [{ id: 'ROUND-G1', developmentCaseId: devCase.id, deletedAt: null, updatedAt: 1000n }] : [],
    sampleCardItem: exact ? [card] : [], developmentSampleQualityReview: [], developmentVersionConfirmation: [],
    productAsset: [], developmentLifecycleEvent: [], sampleCardLoan: [], auditLog: [], events: [], auditFailure: false };
  const delegates: any = {};
  for (const model of Object.keys(state).filter(key => Array.isArray(state[key]) && key !== 'events')) {
    const rows = (args: any = {}) => ordered(state[model].filter((row: any) => matches(row, args.where)), args.orderBy);
    delegates[model] = {
      findFirst: vi.fn(async (args: any) => { state.events.push(`read:${model}`); return clone(rows(args)[0] ?? null); }),
      findUnique: vi.fn(async (args: any) => clone(rows(args)[0] ?? null)),
      findMany: vi.fn(async (args: any) => clone(rows(args))),
      update: vi.fn(async ({ where, data }: any) => { state.events.push(`write:${model}`); const row = state[model].find((item: any) => matches(item, where));
        if (!row) throw new Error(`fixture missing ${model}`); Object.assign(row, clone(data)); return clone(row); }),
      create: vi.fn(async ({ data }: any) => { state.events.push(`write:${model}`);
        if (model === 'auditLog' && state.auditFailure && data.action === 'submit_garment_sample_to_customer') throw new Error('fixture audit unavailable');
        const row = { createdAt: Date.now(), ...clone(data) }; state[model].push(row); return clone(row); }),
    };
  }
  const tx: any = { ...delegates, $queryRaw: vi.fn(async (query: any) => {
    state.events.push(`lock:${query.sql}`); return [{ id: query.values[0] }];
  }) };
  const prisma: any = { ...tx, $transaction: vi.fn(async (run: any) => {
    const before = clone(state);
    try { return await run(tx); } catch (error: any) { const events = state.events; Object.assign(state, before, { events, lastTransactionError: error.message }); throw error; }
  }) };
  function review(overrides: any = {}) {
    const sourceSnapshot = buildDevelopmentQualitySourceSnapshot(state.sampleBatch[0], state.developmentCase[0], state.sampleCardItem,
      { version: state.developmentSampleVersion[0], physicalVersion: state.developmentSampleVersion[0] });
    const row: any = { id: `REVIEW-${state.developmentSampleQualityReview.length + 1}`, developmentCaseId: devCase.id, sampleBatchId: batch.id,
      sampleVersionId: version.id, reviewSequence: state.developmentSampleQualityReview.length + 1, status: 'reviewed', result: 'pass',
      opinion: '实测通过', evidence: [{ id: 'QC-FILE-1', name: '领口照片.jpg' }], measurements: [{ itemIndex: 1, point: '胸围', actual: '98' }],
      reviewedBy: 'QC-1', reviewedAt: 2000n, requestedBy: actor.userId, requestedAt: 1500n, createdAt: 1500n, updatedAt: 2000n,
      sourceSnapshot, sourceFingerprint: createHash('sha256').update(JSON.stringify(sourceSnapshot)).digest('hex'), ...overrides };
    state.developmentSampleQualityReview.push(row);
    if (['reviewed', 'acknowledged'].includes(row.status)) state.auditLog.push({ id: `AUDIT-${row.id}`, action: 'complete_development_sample_qc',
      targetType: 'DevelopmentSampleQualityReview', targetId: row.id, actorId: row.reviewedBy, createdAt: row.reviewedAt,
      detail: { source: 'route:qc:development-sample', after: { reportId: row.id, result: row.result, opinion: row.opinion,
        reviewedBy: row.reviewedBy, reviewedAt: String(row.reviewedAt), sampleVersionId: row.sampleVersionId,
        sourceFingerprint: row.sourceFingerprint, evidence: row.evidence, measurements: row.measurements } } });
    return row;
  }
  const app = express(); app.use(express.json());
  const onDataChange = vi.fn(); app.use('/samples', createSampleRouter({ prisma, requireAuth: false, onDataChange }));
  const input = { requestKey: 'SHIP-1', courier: 'DHL', trackingNumber: 'TRACK-1', recipientName: '客户', sentDate: '2026-10-12',
    ...(exact ? { physicalShipment: { itemId: card.id, quantity: 1, recipientName: '客户', relationId: 'CUSTOMER-1' } } : {}) };
  const ship = (body: any = input) => request(app).post(`/samples/garment/${batch.id}/submit-customer`).send(body);
  const history = () => request(app).get(`/samples/shipment-history/garment/${batch.id}`);
  return { state, prisma, tx, review, ship, history, input, onDataChange };
}

function unchangedStock(f: ReturnType<typeof fixture>) {
  expect(f.state.sampleCardLoan).toHaveLength(0);
  expect(f.state.sampleBatch[0].attachments.shipmentHistory).toBeUndefined();
  expect(f.state.auditLog.filter((row: any) => row.action === 'submit_garment_sample_to_customer')).toHaveLength(0);
  if (f.state.sampleCardItem.length) expect(f.state.sampleCardItem[0].availableQty).toBe(1);
  expect(f.onDataChange).not.toHaveBeenCalled();
}

describe('garment customer shipment: current exact-version QC in the real transaction', () => {
  it('a new nonce without QC is rejected at HTTP/service boundary before any stock write', async () => {
    const f = fixture(); const response = await f.ship();
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('QC_GATE_NOT_PASSED'); unchangedStock(f);
  });

  it('an exact version without a recorded factory return is rejected before QC lookup or physical shipment', async () => {
    const f = fixture(); f.state.sampleBatch[0].returnedAt = null; f.state.sampleCardItem = [];
    const { physicalShipment: _physical, ...input } = f.input;
    const response = await f.ship(input); expect(response.status).toBe(409); expect(response.body.error.code).toBe('QC_GATE_NOT_PASSED');
    expect(response.body.error.message).toContain('实际返样'); unchangedStock(f);
    expect(f.tx.developmentSampleQualityReview.findFirst).not.toHaveBeenCalled();
  });

  it('an exact version cannot substitute a passed legacy scalar for its missing formal report', async () => {
    const f = fixture(); Object.assign(f.state.sampleBatch[0], { qcStatus: 'passed', status: 'making' });
    const response = await f.ship(); expect(response.status).toBe(409); expect(response.body.error.code).toBe('QC_GATE_NOT_PASSED'); unchangedStock(f);
  });

  it.each(['queued', 'in_progress', 'reject', 'needs_adjustment'])('an older pass cannot bypass a newer %s report', async latest => {
    const f = fixture(); f.review();
    f.review(['queued', 'in_progress'].includes(latest) ? { status: latest, result: null, reviewedBy: null, reviewedAt: null } : { result: latest });
    const response = await f.ship(); expect(response.status).toBe(409); expect(response.body.error.code).toBe('QC_GATE_NOT_PASSED'); unchangedStock(f);
  });

  it.each(['', '   ', null])('conditional pass with missing concrete opinion (%s) is rejected', async opinion => {
    const f = fixture(); f.review({ result: 'conditional_pass', opinion });
    const response = await f.ship(); expect(response.status).toBe(409); expect(response.body.error.code).toBe('QC_GATE_NOT_PASSED'); unchangedStock(f);
  });

  it.each([{ reviewedBy: null }, { reviewedBy: ' ' }, { reviewedAt: null }, { reviewedAt: 0 }])('requires the actual recorded QC actor and completion time: %j', async invalid => {
    const f = fixture(); f.review(invalid); const response = await f.ship();
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('QC_GATE_NOT_PASSED'); unchangedStock(f);
  });

  it.each(['missing', 'wrong-result', 'wrong-version', 'wrong-source', 'wrong-actor', 'wrong-time', 'conditional-opinion'])('rejects an inconsistent completion audit (%s)', async kind => {
    const f = fixture(); f.review({ result: 'conditional_pass', opinion: '领口需轻整烫' });
    const audit = f.state.auditLog[0];
    if (kind === 'missing') f.state.auditLog = [];
    else if (kind === 'wrong-actor') audit.actorId = 'QC-OTHER';
    else if (kind === 'wrong-time') audit.detail.after.reviewedAt = '1999';
    else if (kind === 'wrong-result') audit.detail.after.result = 'pass';
    else if (kind === 'wrong-version') audit.detail.after.sampleVersionId = 'VERSION-OTHER';
    else if (kind === 'wrong-source') audit.detail.after.sourceFingerprint = 'f'.repeat(64);
    else audit.detail.after.opinion = '已抹掉原问题';
    const response = await f.ship(); expect(response.status).toBe(409); expect(response.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED'); unchangedStock(f);
  });

  it.each(['return-results', 'version-requirements', 'physical-receipt', 'batch-association', 'factory-association', 'case-association'])('rejects changed or mismatched exact source (%s)', async kind => {
    const f = fixture(); const review = f.review();
    if (kind === 'return-results') f.state.sampleBatch[0].notes = '返样成果已改';
    else if (kind === 'version-requirements') f.state.developmentSampleVersion[0].factoryRequirements = '新领口尺寸';
    else if (kind === 'physical-receipt') f.state.sampleCardItem[0].receiptSnapshot.physicalItemIndex = 2;
    else if (kind === 'batch-association') review.sampleBatchId = 'BATCH-OTHER';
    else if (kind === 'factory-association') f.state.developmentSampleVersion[0].supplierRelationId = 'FACTORY-OTHER';
    else f.state.developmentSampleVersion[0].developmentCaseId = 'CASE-OTHER';
    const response = await f.ship(); expect(response.status).toBe(409); expect(response.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED'); unchangedStock(f);
  });

  it('a current formal pass permits shipment without relying on the old scalar or requester confirmation', async () => {
    const f = fixture(); f.review(); const response = await f.ship();
    expect(response.status, f.state.lastTransactionError).toBe(200);
    expect(response.body.round.shipment.qualityProof.qualityResult).toBe('pass');
    expect(f.state.sampleBatch[0].qcStatus).toBeNull(); expect(f.state.developmentVersionConfirmation).toHaveLength(0);
    expect(f.state.sampleCardLoan).toHaveLength(1); expect(f.state.sampleCardItem[0].availableQty).toBe(0);
  });

  it.each(['reviewed', 'acknowledged'])('allows valid %s conditional QC without prior customer confirmation and freezes the issues in receipt/history/audit', async status => {
    const f = fixture(); const review = f.review({ status, result: 'conditional_pass', opinion: '领口需轻整烫，客户应知悉' });
    const response = await f.ship(); expect(response.status, f.state.lastTransactionError).toBe(200);
    const proof = response.body.round.shipment.qualityProof;
    expect(proof).toMatchObject({ schemaVersion: 1, caseId: 'CASE-G1', sampleBatchId: 'BATCH-G1', sampleVersionId: 'VERSION-G1',
      physicalSampleVersionId: 'VERSION-G1', qualityReviewId: review.id, qualityReviewSequence: 1, qualityResult: 'conditional_pass',
      qualityOpinion: review.opinion, qualityEvidence: review.evidence, qualityMeasurements: review.measurements,
      reviewedBy: 'QC-1', reviewedAt: '2000', qualityCompletionAuditId: `AUDIT-${review.id}`, sourceFingerprint: review.sourceFingerprint });
    expect(proof.sourceSnapshot.version.id).toBe('VERSION-G1');
    expect(f.state.sampleBatch[0].attachments.shipmentHistory[0].qualityProof).toEqual(proof);
    expect(f.state.auditLog.find((row: any) => row.action === 'submit_garment_sample_to_customer').detail.after.qualityProof).toEqual(proof);
    expect(f.state.auditLog.find((row: any) => row.action === 'submit_garment_sample_to_customer').detail.after.shipmentEntry).toEqual(response.body.round.shipment);
    const history = await f.history(); expect(history.status).toBe(200);
    expect(history.body.history[0].qualityProof).toEqual(proof); expect(history.body.latest.qualityProof).toEqual(proof);
    expect(f.state.sampleCardLoan).toHaveLength(1); expect(f.state.sampleCardItem[0].quantity).toBe(0);
    expect(f.state.sampleCardItem[0].availableQty).toBe(0); expect(f.onDataChange).toHaveBeenCalledTimes(1);
    const lockEvents = f.state.events.filter((item: string) => item.startsWith('lock:'));
    const batchLock = lockEvents.findIndex((item: string) => item.includes('SampleBatch'));
    const versionLock = lockEvents.findIndex((item: string) => item.includes('DevelopmentSampleVersion'));
    const reviewLock = lockEvents.findIndex((item: string) => item.includes('DevelopmentSampleQualityReview'));
    expect(batchLock).toBeLessThan(versionLock); expect(versionLock).toBeLessThan(reviewLock);
    expect(f.state.events.findIndex((item: string) => item.includes('DevelopmentSampleQualityReview') && item.startsWith('lock:')))
      .toBeLessThan(f.state.events.indexOf('write:sampleCardLoan'));
  });

  it('a successful same-nonce replay returns the frozen original receipt despite later QC, without another deduction', async () => {
    const f = fixture(); f.review({ result: 'conditional_pass', opinion: '轻整烫' });
    const first = await f.ship(); expect(first.status, f.state.lastTransactionError).toBe(200);
    f.review({ status: 'queued', result: null, reviewedBy: null, reviewedAt: null });
    f.tx.developmentSampleQualityReview.findFirst.mockClear();
    const auditCount = f.state.auditLog.length; const replay = await f.ship();
    expect(replay.status).toBe(200); expect(replay.body.round.shipmentReplay).toBe(true);
    expect(replay.body.round.shipment).toEqual(first.body.round.shipment);
    expect(f.tx.developmentSampleQualityReview.findFirst).not.toHaveBeenCalled();
    expect(f.state.sampleCardLoan).toHaveLength(1); expect(f.state.sampleCardItem[0].availableQty).toBe(0);
    expect(f.state.sampleBatch[0].attachments.shipmentHistory).toHaveLength(1); expect(f.state.auditLog).toHaveLength(auditCount);
    expect(f.state.events.some((item: string) => item.startsWith('lock:') && item.includes('AuditLog'))).toBe(true);
    const conflict = await f.ship({ ...f.input, trackingNumber: 'DIFFERENT' });
    expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe('REQUEST_CONFLICT'); expect(f.state.sampleCardLoan).toHaveLength(1);
  });

  it.each(['opinion-changed', 'opinion-deleted', 'evidence-erased', 'result-replaced', 'proof-erased', 'proof-schema-changed',
    'shipment-recipient-changed', 'physical-receipt-changed', 'audit-missing', 'audit-proof-changed', 'audit-receipt-changed',
    'audit-actor-changed', 'audit-key-changed', 'audit-fingerprint-changed', 'audit-success-changed', 'audit-receipt-missing'])
  ('refuses tampered frozen successful replay (%s), without applying current QC or another stock write', async kind => {
    const f = fixture(); f.review({ result: 'conditional_pass', opinion: '领口需轻整烫' });
    const first = await f.ship(); expect(first.status).toBe(200);
    const entry = f.state.sampleBatch[0].attachments.shipmentHistory[0];
    const audit = f.state.auditLog.find((row: any) => row.action === 'submit_garment_sample_to_customer');
    if (kind === 'opinion-changed') entry.qualityProof.qualityOpinion = '已换成无问题';
    else if (kind === 'opinion-deleted') delete entry.qualityProof.qualityOpinion;
    else if (kind === 'evidence-erased') entry.qualityProof.qualityEvidence = [];
    else if (kind === 'result-replaced') entry.qualityProof.qualityResult = 'pass';
    else if (kind === 'proof-erased') delete entry.qualityProof;
    else if (kind === 'proof-schema-changed') entry.qualityProof.schemaVersion = 0;
    else if (kind === 'shipment-recipient-changed') entry.recipientName = '另一客户';
    else if (kind === 'physical-receipt-changed') entry.physicalShipment.quantity = 100;
    else if (kind === 'audit-missing') f.state.auditLog = f.state.auditLog.filter((row: any) => row.id !== audit.id);
    else if (kind === 'audit-proof-changed') audit.detail.after.qualityProof.qualityOpinion = '已清除原问题';
    else if (kind === 'audit-receipt-changed') audit.detail.after.shipmentEntry.trackingNumber = 'REPLACED';
    else if (kind === 'audit-actor-changed') audit.actorId = 'BUSINESS-OTHER';
    else if (kind === 'audit-key-changed') audit.detail.after.requestKey = 'SHIP-OTHER';
    else if (kind === 'audit-fingerprint-changed') audit.detail.after.requestFingerprint = 'f'.repeat(64);
    else if (kind === 'audit-success-changed') audit.detail.after.status = 'pending';
    else delete audit.detail.after.shipmentEntry;
    f.review({ status: 'queued', result: null, reviewedBy: null, reviewedAt: null });
    f.tx.developmentSampleQualityReview.findFirst.mockClear();
    const auditCount = f.state.auditLog.length; const notifications = f.onDataChange.mock.calls.length;
    const response = await f.ship(); expect(response.status).toBe(409); expect(response.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED');
    expect(f.tx.developmentSampleQualityReview.findFirst).not.toHaveBeenCalled();
    expect(f.state.sampleCardLoan).toHaveLength(1); expect(f.state.sampleCardItem[0].availableQty).toBe(0);
    expect(f.state.sampleBatch[0].attachments.shipmentHistory).toHaveLength(1); expect(f.state.auditLog).toHaveLength(auditCount);
    expect(f.onDataChange).toHaveBeenCalledTimes(notifications);
  });

  it('an old no-quality-proof receipt still replays without a submit audit, a new QC judgment or invented quality facts', async () => {
    const f = fixture({ exact: false }); Object.assign(f.state.sampleBatch[0], { qcStatus: 'passed', status: 'making' });
    const first = await f.ship(); expect(first.status).toBe(200);
    const entry = f.state.sampleBatch[0].attachments.shipmentHistory[0]; delete entry.qualityProof;
    delete f.state.sampleBatch[0].attachments.shipment.qualityProof;
    f.state.auditLog = []; f.state.sampleBatch[0].qcStatus = 'failed';
    const replay = await f.ship(); expect(replay.status).toBe(200); expect(replay.body.round.shipmentReplay).toBe(true);
    expect(replay.body.round.shipment.qualityProof).toBeUndefined();
    expect(f.tx.developmentSampleQualityReview.findFirst).not.toHaveBeenCalled();
    expect(f.state.sampleCardLoan).toHaveLength(0); expect(f.state.auditLog).toHaveLength(0);
    expect(f.state.sampleBatch[0].attachments.shipmentHistory).toHaveLength(1);
  });

  it('failed shipment audit rolls back the real physical deduction, batch status and shipment history', async () => {
    const f = fixture(); f.review(); f.state.auditFailure = true;
    const result = await createGarmentSampleGateService({ prisma: f.prisma }).submitToCustomer({
      roundId: 'BATCH-G1', actorId: actor.userId, trustedActor: actor as any, input: f.input,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'UPDATE_FAILED', status: 500 } }); unchangedStock(f);
    expect(f.state.sampleBatch[0].status).toBe('pending');
    expect(f.state.events).toContain('write:sampleCardLoan'); expect(f.state.events).toContain('write:sampleBatch');
  });

  it.each([{ qcStatus: null, status: 'pending' }, { qcStatus: 'failed', status: 'making' }, { qcStatus: 'passed', status: 'sent' }])('legacy nonce still needs its actual old QC/status gate: %j', async old => {
    const f = fixture({ exact: false }); Object.assign(f.state.sampleBatch[0], old);
    const response = await f.ship(); expect(response.status).toBe(409); expect(response.body.error.code).toBe('QC_GATE_NOT_PASSED'); unchangedStock(f);
    expect(f.tx.developmentSampleQualityReview.findFirst).not.toHaveBeenCalled();
  });

  it('a legacy batch with its recorded valid QC gate remains usable without inventing an exact version', async () => {
    const f = fixture({ exact: false }); Object.assign(f.state.sampleBatch[0], { qcStatus: 'passed', status: 'making' });
    const response = await f.ship(); expect(response.status, f.state.lastTransactionError).toBe(200);
    expect(response.body.round.sampleVersionId).toBeNull(); expect(response.body.round.shipment.qualityProof).toBeNull();
    expect(f.state.sampleCardLoan).toHaveLength(0); expect(f.tx.developmentSampleQualityReview.findFirst).not.toHaveBeenCalled();
  });
});
