import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({ actors: new Map<string, any>(), audit: vi.fn(), releaseLocks: vi.fn() }));

vi.mock('../../auth/tokenHelpers', () => ({
  loadUserWithRoles: vi.fn(async (_tx: any, userId: string) => ({ id: userId, status: 'active', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async (_tx: any, user: any) => shared.actors.get(user.id)),
}));
vi.mock('../../orders/orderLineWriteAccess', () => ({
  currentOrderLineWriteActor: vi.fn(async (_tx: any, prior: any) => shared.actors.get(prior.userId)),
  freshOrderLineScope: vi.fn(async () => ({})),
  lockedOrderLine: vi.fn(async () => ({})),
  isOrderLineStorageConflict: vi.fn(() => false),
}));
vi.mock('../releaseService', () => ({ lockOrderReleaseSources: shared.releaseLocks }));
vi.mock('../../orders/orderConfirmedSourceBinding', () => ({ orderConfirmedSourceBinding: vi.fn(async () => undefined) }));
vi.mock('../../development/fabricAssetEligibility', () => ({ assertConfirmedFabricSourceEligible: vi.fn(async () => ({ factoryRelationId: 'SOURCE-FACTORY' })) }));
vi.mock('../../orderChanges/quantityPlanMoqGate', () => ({ currentOrderMoqReasons: vi.fn(async () => []) }));
vi.mock('../productionBatchFacts', async importOriginal => {
  const actual = await importOriginal<typeof import('../productionBatchFacts')>();
  return { ...actual, resolveCurrentProductionBatchFacts: vi.fn(async (tx: any, supplied: any) => {
    const batch = await tx.productionBatch.findUnique({ where: { id: supplied.id } });
    const order = await tx.order.findFirst({ where: { id: batch.orderId, deletedAt: null } });
    const line = await tx.orderLine.findUnique({ where: { id: batch.orderLineId } });
    return { order, line, batch, lineFingerprint: actual.productionBatchLineFingerprint(order, line) };
  }) };
});
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: shared.audit }));

import { SYSTEM_ROLE_IDS } from '../../_shared/rolePermissionMatrix';
import { productionBatchLineFingerprint } from '../productionBatchFacts';
import { completeProductionBatch, readOrderLineCompletion, readOrderLineProductionCompletion } from '../productionCompletionService';
import { createProductionBatch, splitProductionBatch } from '../productionBatchService';

const USER = 'sales-user';
const ORDER = { id: 'ORDER-1', customerRelationId: 'CUSTOMER-1', millRelationId: null, sourceCaseId: null,
  businessLine: 'garment', deletedAt: null, ownerId: USER };
const LINE = { id: 'LINE-1', orderId: ORDER.id, confirmedSourceType: 'Sample', confirmedSourceId: 'SAMPLE-1',
  specSnapshot: { style: 'A' }, quantity: '100', unit: 'pcs', tolerancePercent: null, toleranceSource: null };
const fingerprint = productionBatchLineFingerprint(ORDER, LINE);
const requestKey = '4dc58690-9475-4af5-8a8b-f671f7021588';

function batch(id: string, rangeStart: string, quantity: string, factory = `F-${id}`, revision = 1) {
  return { id, orderId: ORDER.id, orderLineId: LINE.id, parentBatchId: null, factoryRelationId: factory,
    rangeStart, quantity, unit: LINE.unit, revision, state: 'active', confirmedSourceType: LINE.confirmedSourceType,
    confirmedSourceId: LINE.confirmedSourceId, specSnapshot: LINE.specSnapshot, sourceFingerprint: 'source-fingerprint' };
}

function testDb(options: { order?: any; line?: any; batches?: any[]; records?: any[]; customerStandard?: any; internalStandard?: any; role?: string } = {}) {
  const order = { ...ORDER, ...options.order }, line = { ...LINE, ...options.line };
  const batches = options.batches ?? [batch('PB-1', '0', '100')];
  const records = options.records ?? [];
  const actor = { userId: USER, roleIds: [options.role ?? SYSTEM_ROLE_IDS.SALES], roles: [], permissions: ['orders:read', 'orders:write'], authorizationLoaded: true };
  shared.actors.set(USER, actor);
  const tx: any = {
    order: { findFirst: vi.fn(async () => order) },
    orderLine: { findUnique: vi.fn(async () => line) },
    productionBatch: {
      findUnique: vi.fn(async ({ where }: any) => batches.find(row => row.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => batches.filter(row => row.orderId === where.orderId && row.orderLineId === where.orderLineId && row.state === where.state)),
      create: vi.fn(async ({ data }: any) => ({ ...data })),
    },
    productionBatchCompletion: {
      findMany: vi.fn(async ({ where }: any) => records.filter(row => where.productionBatchId.in.includes(row.productionBatchId))),
      findFirst: vi.fn(async ({ where }: any) => where.productionBatchId
        ? records.find(row => row.productionBatchId === where.productionBatchId) ?? null
        : records.find(row => row.recordedBy === where.recordedBy && row.requestKey === where.requestKey) ?? null),
      findUnique: vi.fn(async ({ where }: any) => records.find(row => row.productionBatchId === where.productionBatchId_productionBatchRevision.productionBatchId
        && row.productionBatchRevision === where.productionBatchId_productionBatchRevision.productionBatchRevision) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data }; records.push(row); return row; }),
    },
    relation: { findUnique: vi.fn(async ({ where }: any) => where.id === order.customerRelationId
      ? { customerAgreementTolerance: options.customerStandard ?? null } : null) },
    systemConfig: { findUnique: vi.fn(async () => options.internalStandard === undefined
      ? null : { value: options.internalStandard }) },
    $queryRaw: vi.fn(async () => []),
  };
  const prisma: any = { $transaction: vi.fn(async (work: (storage: any) => Promise<any>) => work(tx)) };
  return { order, line, batches, records, actor, tx, prisma };
}

const command = (batchRow: any, actualQty: string, key = requestKey) => ({ expectedRevision: batchRow.revision,
  expectedLineFingerprint: fingerprint, actualQty, requestKey: key });

beforeEach(() => { shared.actors.clear(); shared.audit.mockReset().mockResolvedValue(undefined); shared.releaseLocks.mockReset().mockResolvedValue({ failedSources: [] }); });

describe('authoritative production completion facts', () => {
  it('returns the route result envelope for a scoped current completion read without creating a completion', async () => {
    const db = testDb();
    const result = await readOrderLineCompletion({ prisma: db.prisma, actor: db.actor, orderId: db.order.id, lineId: db.line.id });
    expect(result).toMatchObject({ ok: true, data: { productionCompletion: { status: 'incomplete', productionComplete: false } } });
    expect(db.tx.productionBatchCompletion.create).not.toHaveBeenCalled();
    expect(shared.audit).not.toHaveBeenCalled();
  });
  it('binds production and completion facts to the garment size matrix', () => {
    const original = { ...LINE, sizeBreakdown: { S: 20, M: 30, L: 50 } };
    const same = { ...LINE, sizeBreakdown: { L: 50, S: 20, M: 30 } };
    const changed = { ...LINE, sizeBreakdown: { S: 20, M: 31, L: 50 } };
    expect(productionBatchLineFingerprint(ORDER, original)).toBe(productionBatchLineFingerprint(ORDER, same));
    expect(productionBatchLineFingerprint(ORDER, original)).not.toBe(productionBatchLineFingerprint(ORDER, changed));
  });

  it('exposes an explicit customer per-size tolerance basis before the completion form opens', async () => {
    const sizeLine = { ...LINE, quantity: '5', sizeBreakdown: { S: 2, M: 3 } };
    const sizeBatch = { ...batch('PB-SIZES', '0', '5'), sizeBreakdown: { S: 2, M: 3 } };
    const db = testDb({ line: sizeLine, batches: [sizeBatch], customerStandard: {
      qtyTolerance: [{ minQty: 0, maxQty: null, pct: 5 }], qtyToleranceBasis: 'per_size',
    } });
    const summary = await readOrderLineProductionCompletion(db.tx, db.order, sizeLine);
    expect(summary).toMatchObject({ status: 'incomplete', requiresPerSizeActuals: true, coverageComplete: true,
      branches: [{ plannedSizeBreakdown: { S: 2, M: 3 }, completionCurrent: false }] });
  });

  it('lets the SALES business role record exact actual quantity and leaves an unfinished garment line incomplete', async () => {
    const b1 = batch('PB-1', '0', '60'), b2 = batch('PB-2', '60', '40');
    const db = testDb({ batches: [b1, b2], customerStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 1 }] } });
    const result = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: b1.id, input: command(b1, '61.25') });
    expect(result).toMatchObject({ ok: true, data: { replayed: false, completion: { actualQuantity: '61.25', unit: 'pcs', productionBatchRevision: 1 },
      orderLineCompletion: { status: 'incomplete', productionComplete: false, actualQty: null, completedBranchCount: 1, expectedBranchCount: 2 } } });
    expect(db.tx.productionBatchCompletion.create).toHaveBeenCalledTimes(1);
    expect(shared.audit).toHaveBeenCalledTimes(1);
    const after = await readOrderLineProductionCompletion(db.tx, db.order, db.line);
    expect(after).toMatchObject({ status: 'incomplete', actualQty: null });
    expect(db.tx).not.toHaveProperty('shipment');
  });

  it('aggregates actual completion by active garment factory branches, never planned or shipped quantities', async () => {
    const b1 = batch('PB-1', '0', '60'), b2 = batch('PB-2', '60', '40');
    const records = [
      { id: 'C1', productionBatchId: b1.id, productionBatchRevision: 1, orderId: ORDER.id, orderLineId: LINE.id,
        actualQuantity: '62', unit: 'pcs', lineFingerprint: fingerprint, recordedAt: 1n },
      { id: 'C2', productionBatchId: b2.id, productionBatchRevision: 1, orderId: ORDER.id, orderLineId: LINE.id,
        actualQuantity: '38', unit: 'pcs', lineFingerprint: fingerprint, recordedAt: 2n },
    ];
    const db = testDb({ batches: [b1, b2], records, customerStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 2 }] },
      internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 9 }] } });
    const summary = await readOrderLineProductionCompletion(db.tx, db.order, db.line);
    expect(summary).toMatchObject({ status: 'complete', actualQty: '100', productionComplete: true,
      tolerance: { status: 'within_tolerance', comparisonBasis: 'line_total', source: 'customer_standard', percent: 2 },
      expectedBranchCount: 2, completedBranchCount: 2 });
    expect(summary.branches.map((row: any) => row.actualQty)).toEqual(['62', '38']);
  });

  it('keeps no-split branch shape distinct from shipment splits and blocks a malformed fabric multi-factory line', async () => {
    const b1 = batch('PB-1', '0', '50'), b2 = batch('PB-2', '50', '50');
    const records = [b1, b2].map((row, index) => ({ id: `C${index}`, productionBatchId: row.id, productionBatchRevision: 1,
      orderId: ORDER.id, orderLineId: LINE.id, actualQuantity: row.quantity, unit: 'pcs', lineFingerprint: fingerprint, recordedAt: BigInt(index) }));
    const db = testDb({ order: { businessLine: 'fabric' }, batches: [b1, b2], records });
    const summary = await readOrderLineProductionCompletion(db.tx, db.order, db.line);
    expect(summary).toMatchObject({ status: 'unresolved', productionComplete: false, actualQty: null, coverageComplete: false });
    expect(summary.blockers).toContainEqual(expect.objectContaining({ code: 'PRODUCTION_BRANCH_COVERAGE_INCOMPLETE' }));
  });

  it('fails closed when a customer standard explicitly scopes quantity tolerance by size', async () => {
    const b1 = batch('PB-1', '0', '100');
    const records = [{ id: 'C1', productionBatchId: b1.id, productionBatchRevision: 1, orderId: ORDER.id, orderLineId: LINE.id,
      actualQuantity: '100', unit: 'pcs', lineFingerprint: fingerprint, recordedAt: 1n }];
    const db = testDb({ batches: [b1], records, customerStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }], qtyToleranceBasis: 'per_size' } });
    const summary = await readOrderLineProductionCompletion(db.tx, db.order, db.line);
    expect(summary).toMatchObject({ status: 'unresolved', tolerance: { status: 'unresolved', comparisonBasis: 'per_size', source: 'customer_standard' } });
    expect(summary.tolerance.reason).toContain('逐尺码实际数量');
  });

  it('uses internal standard only when the customer has no standard and blocks when no usable standard is available', async () => {
    const b1 = batch('PB-1', '0', '100');
    const records = [{ id: 'C1', productionBatchId: b1.id, productionBatchRevision: 1, orderId: ORDER.id, orderLineId: LINE.id,
      actualQuantity: '104', unit: 'pcs', lineFingerprint: fingerprint, recordedAt: 1n }];
    const db = testDb({ batches: [b1], records, internalStandard: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 3 }] } });
    const summary = await readOrderLineProductionCompletion(db.tx, db.order, db.line);
    expect(summary).toMatchObject({ status: 'out_of_tolerance', tolerance: { source: 'internal_standard', percent: 3, comparisonBasis: 'line_total' } });
    const broken = testDb({ batches: [b1], records, internalStandard: { qtyTolerance: [] } });
    const unresolved = await readOrderLineProductionCompletion(broken.tx, broken.order, broken.line);
    expect(unresolved).toMatchObject({ status: 'unresolved', tolerance: { status: 'unresolved', source: 'none' } });
  });

  it('replays the same request key idempotently, rejects reuse for different actual quantity, and rejects a stale batch revision', async () => {
    const b1 = batch('PB-1', '0', '100');
    const db = testDb({ batches: [b1] });
    const first = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: b1.id, input: command(b1, '100') });
    const replay = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: b1.id, input: command(b1, '100') });
    expect(first).toMatchObject({ ok: true, data: { replayed: false } });
    expect(replay).toMatchObject({ ok: true, data: { replayed: true } });
    expect(db.tx.productionBatchCompletion.create).toHaveBeenCalledTimes(1);
    const conflict = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: b1.id, input: command(b1, '99') });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const stale = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: b1.id,
      input: { ...command(b1, '100', '7ec58690-9475-4af5-8a8b-f671f7021588'), expectedRevision: 2 } });
    expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('does not allow a non-business account or a total-only command to claim a size-specific check', async () => {
    const b1 = batch('PB-1', '0', '100');
    const deniedDb = testDb({ batches: [b1], role: SYSTEM_ROLE_IDS.LOGISTICS });
    const denied = await completeProductionBatch({ prisma: deniedDb.prisma, actor: deniedDb.actor, batchId: b1.id, input: command(b1, '100') });
    expect(denied).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const db = testDb({ batches: [b1] });
    const sizeInput = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: b1.id,
      input: { ...command(b1, '100'), actualQtyBySize: { M: '50', L: '50' } } });
    expect(sizeInput).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(db.tx.productionBatchCompletion.create).not.toHaveBeenCalled();
  });

  it('does not persist an irreversible total-only completion when the customer standard is per-size', async () => {
    const b1 = batch('PB-1', '0', '100');
    const db = testDb({ batches: [b1], customerStandard: {
      qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }], qtyToleranceBasis: 'per_size',
    } });
    const result = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: b1.id, input: command(b1, '100') });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringContaining('按尺码') } });
    expect(db.tx.productionBatchCompletion.create).not.toHaveBeenCalled();
    expect(shared.audit).not.toHaveBeenCalled();
  });

  it('records immutable garment actuals by size and evaluates an explicitly per-size customer rule', async () => {
    const sizeLine = { ...LINE, quantity: '5', sizeBreakdown: { S: 2, M: 3 } };
    const sizeBatch = { ...batch('PB-SIZES', '0', '5'), sizeBreakdown: { S: 2, M: 3 } };
    const sizeFingerprint = productionBatchLineFingerprint(ORDER, sizeLine);
    const db = testDb({ line: sizeLine, batches: [sizeBatch], customerStandard: {
      qtyTolerance: [{ minQty: 0, maxQty: null, pct: 0 }], qtyToleranceBasis: 'per_size',
    } });
    const result = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: sizeBatch.id, input: {
      expectedRevision: 1, expectedLineFingerprint: sizeFingerprint, actualQty: '5', actualQtyBySize: { S: 2, M: 3 }, requestKey,
    } });
    expect(result).toMatchObject({ ok: true, data: { completion: { actualQuantity: '5', actualSizeBreakdown: { S: 2, M: 3 } },
      orderLineCompletion: { status: 'complete', actualQty: '5', tolerance: { status: 'within_tolerance', comparisonBasis: 'per_size',
        perSize: [{ size: 'M', contractQty: 3, actualQty: 3 }, { size: 'S', contractQty: 2, actualQty: 2 }] } } } });
    expect(db.tx.productionBatchCompletion.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actualSizeBreakdown: { S: 2, M: 3 } }) }));
  });

  it('requires every contract size and exact total when completing a matrix-backed factory branch', async () => {
    const sizeLine = { ...LINE, quantity: '5', sizeBreakdown: { S: 2, M: 3 } };
    const sizeBatch = { ...batch('PB-SIZES', '0', '5'), sizeBreakdown: { S: 2, M: 3 } };
    const db = testDb({ line: sizeLine, batches: [sizeBatch], customerStandard: {
      qtyTolerance: [{ minQty: 0, maxQty: null, pct: 0 }], qtyToleranceBasis: 'per_size',
    } });
    const missing = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: sizeBatch.id, input: {
      expectedRevision: 1, expectedLineFingerprint: productionBatchLineFingerprint(ORDER, sizeLine), actualQty: '5', requestKey,
    } });
    expect(missing).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringContaining('客户标准明确要求按尺码') } });
    expect(db.tx.productionBatchCompletion.create).not.toHaveBeenCalled();
    const mismatch = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: sizeBatch.id, input: {
      expectedRevision: 1, expectedLineFingerprint: productionBatchLineFingerprint(ORDER, sizeLine), actualQty: '5',
      actualQtyBySize: { S: 2, L: 3 }, requestKey: '8fc58690-9475-4af5-8a8b-f671f7021588',
    } });
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('与订单行尺码完全一致') } });
    expect(db.tx.productionBatchCompletion.create).not.toHaveBeenCalled();
  });

  it('allows a total-only actual when a size matrix exists but the customer uses line-total tolerance', async () => {
    const sizeLine = { ...LINE, quantity: '5', sizeBreakdown: { S: 2, M: 3 } };
    const sizeBatch = { ...batch('PB-SIZES', '0', '5'), sizeBreakdown: { S: 2, M: 3 } };
    const db = testDb({ line: sizeLine, batches: [sizeBatch], customerStandard: { qtyTolerance: [{ minQty: 0, maxQty: null, pct: 0 }] } });
    const result = await completeProductionBatch({ prisma: db.prisma, actor: db.actor, batchId: sizeBatch.id, input: {
      expectedRevision: 1, expectedLineFingerprint: productionBatchLineFingerprint(ORDER, sizeLine), actualQty: '5', requestKey,
    } });
    expect(result).toMatchObject({ ok: true, data: { completion: { actualQuantity: '5', actualSizeBreakdown: null },
      orderLineCompletion: { status: 'complete', actualQty: '5', requiresPerSizeActuals: false, tolerance: { comparisonBasis: 'line_total' } } } });
  });

  it('refuses to split a branch after its immutable final production fact has been recorded', async () => {
    const b1 = batch('PB-1', '0', '100');
    const completion = { id: 'C1', productionBatchId: b1.id, productionBatchRevision: 1, orderId: ORDER.id,
      orderLineId: LINE.id, actualQuantity: '100', unit: 'pcs', lineFingerprint: fingerprint, recordedBy: USER, requestKey: 'complete-key' };
    const db = testDb({ batches: [b1], records: [completion] });
    db.tx.auditLog = { findMany: vi.fn(async () => []) };
    db.tx.shipmentProductionAllocation = { findFirst: vi.fn(async () => null) };
    db.tx.productionStockReceipt = { findFirst: vi.fn(async () => null) };
    const result = await splitProductionBatch({ prisma: db.prisma, batchId: b1.id, actor: db.actor, input: {
      expectedRevision: 1, expectedLineFingerprint: fingerprint, requestKey: 'split-request',
      children: [{ batchCode: 'CHILD-A', quantity: '50' }, { batchCode: 'CHILD-B', quantity: '50' }],
    } });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringContaining('不可变的最终完工事实') } });
    expect(db.tx.productionBatchCompletion.findFirst).toHaveBeenCalledWith({ where: { productionBatchId: b1.id } });
    expect(db.tx.productionBatch.create).not.toHaveBeenCalled();
    expect((db.tx.productionBatch as any).updateMany).toBeUndefined();
  });

  it('requires a supplier organization and an active FactoryProfile before creating a garment factory branch', async () => {
    const b1 = batch('PB-NEW', '0', '100', 'FACTORY-1');
    const db = testDb({ batches: [] });
    db.tx.order.findFirst = vi.fn(async () => db.order);
    db.tx.orderLine.findUnique = vi.fn(async () => LINE);
    db.tx.auditLog = { findMany: vi.fn(async () => []) };
    db.tx.factoryProfile = { findUnique: vi.fn(async () => ({ relationId: 'FACTORY-1', deletedAt: null, blacklistedAt: null })) };
    db.tx.relation = { findUnique: vi.fn(async () => ({ id: 'FACTORY-1', name: 'Factory', category: 'Supplier',
      isOrganization: false, deletedAt: null })) };
    const input = { batchCode: b1.id, quantity: '100', unit: 'pcs', expectedLineFingerprint: fingerprint,
      requestKey: '1fc58690-9475-4af5-8a8b-f671f7021588', factoryRelationId: 'FACTORY-1' };
    const notOrganization = await createProductionBatch({ prisma: db.prisma, orderId: ORDER.id, lineId: LINE.id,
      actor: db.actor, input });
    expect(notOrganization).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringContaining('有效的供应商组织') } });
    expect(db.tx.productionBatch.create).not.toHaveBeenCalled();

    db.tx.relation.findUnique.mockResolvedValue({ id: 'FACTORY-1', name: 'Factory', category: 'Supplier',
      isOrganization: true, deletedAt: null });
    db.tx.factoryProfile.findUnique.mockResolvedValue(null);
    const missingFactoryProfile = await createProductionBatch({ prisma: db.prisma, orderId: ORDER.id, lineId: LINE.id,
      actor: db.actor, input: { ...input, requestKey: '2fc58690-9475-4af5-8a8b-f671f7021588' } });
    expect(missingFactoryProfile).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringContaining('有效的供应商组织') } });
    expect(db.tx.productionBatch.create).not.toHaveBeenCalled();

    db.tx.factoryProfile.findUnique.mockResolvedValue({ relationId: 'FACTORY-1', deletedAt: null, blacklistedAt: null });
    const created = await createProductionBatch({ prisma: db.prisma, orderId: ORDER.id, lineId: LINE.id,
      actor: db.actor, input: { ...input, requestKey: '3fc58690-9475-4af5-8a8b-f671f7021588' } });
    expect(created).toMatchObject({ ok: true, data: { batch: { factoryRelationId: 'FACTORY-1' } } });
    expect(db.tx.productionBatch.create).toHaveBeenCalledTimes(1);
  });

  it('requires a garment factory branch to carry its exact allocation from the order-line size matrix', async () => {
    const sizeLine = { ...LINE, sizeBreakdown: { S: 40, M: 60 } };
    const db = testDb({ line: sizeLine, batches: [] });
    db.tx.order.findFirst = vi.fn(async () => db.order);
    db.tx.orderLine.findUnique = vi.fn(async () => sizeLine);
    db.tx.auditLog = { findMany: vi.fn(async () => []) };
    db.tx.factoryProfile = { findUnique: vi.fn(async () => ({ relationId: 'FACTORY-1', deletedAt: null, blacklistedAt: null })) };
    db.tx.relation = { findUnique: vi.fn(async () => ({ id: 'FACTORY-1', name: 'Factory', category: 'Supplier', isOrganization: true, deletedAt: null })) };
    const base = { batchCode: 'SIZE-BRANCH', quantity: '50', unit: 'pcs', expectedLineFingerprint: productionBatchLineFingerprint(db.order, sizeLine),
      factoryRelationId: 'FACTORY-1' };
    const missing = await createProductionBatch({ prisma: db.prisma, orderId: ORDER.id, lineId: LINE.id, actor: db.actor,
      input: { ...base, requestKey: '5fc58690-9475-4af5-8a8b-f671f7021588' } });
    expect(missing).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringContaining('逐码登记计划数量') } });
    expect(db.tx.productionBatch.create).not.toHaveBeenCalled();

    const created = await createProductionBatch({ prisma: db.prisma, orderId: ORDER.id, lineId: LINE.id, actor: db.actor,
      input: { ...base, sizeBreakdown: { S: 20, M: 30 }, requestKey: '6fc58690-9475-4af5-8a8b-f671f7021588' } });
    expect(created).toMatchObject({ ok: true, data: { batch: { quantity: '50', sizeBreakdown: { S: 20, M: 30 } } } });
  });

  it('keeps every child on the exact parent factory when a garment production branch is split', async () => {
    const parent = batch('PB-PARENT', '0', '100', 'FACTORY-LOCKED');
    const db = testDb({ batches: [parent] });
    db.tx.order.findFirst = vi.fn(async () => db.order);
    db.tx.orderLine.findUnique = vi.fn(async () => LINE);
    db.tx.relation = { findUnique: vi.fn(async () => ({ id: 'FACTORY-LOCKED', name: 'Factory', category: 'Supplier',
      isOrganization: true, deletedAt: null })) };
    db.tx.factoryProfile = { findUnique: vi.fn(async () => ({ relationId: 'FACTORY-LOCKED', deletedAt: null, blacklistedAt: null })) };
    db.tx.auditLog = { findMany: vi.fn(async () => []) };
    db.tx.productionBatch.updateMany = vi.fn(async () => ({ count: 1 }));
    db.tx.shipmentProductionAllocation = { findFirst: vi.fn(async () => null) };
    db.tx.productionStockReceipt = { findFirst: vi.fn(async () => null) };
    const split = await splitProductionBatch({ prisma: db.prisma, batchId: parent.id, actor: db.actor, input: {
      expectedRevision: 1, expectedLineFingerprint: fingerprint, requestKey: '4fc58690-9475-4af5-8a8b-f671f7021588',
      children: [{ batchCode: 'CHILD-A', quantity: '40' }, { batchCode: 'CHILD-B', quantity: '60' }],
    } });
    expect(split).toMatchObject({ ok: true, data: { children: [
      { factoryRelationId: 'FACTORY-LOCKED', parentBatchId: parent.id },
      { factoryRelationId: 'FACTORY-LOCKED', parentBatchId: parent.id },
    ] } });
    expect(db.tx.productionBatch.create).toHaveBeenCalledTimes(2);
    expect(db.tx.productionBatch.create.mock.calls.map(([call]: any[]) => call.data.factoryRelationId)).toEqual(['FACTORY-LOCKED', 'FACTORY-LOCKED']);
  });

  it('preserves the parent garment size allocation exactly when splitting a branch', async () => {
    const sizeLine = { ...LINE, sizeBreakdown: { S: 40, M: 60 } };
    const parent = { ...batch('PB-SIZE-PARENT', '0', '100', 'FACTORY-LOCKED'), sizeBreakdown: { S: 40, M: 60 } };
    const db = testDb({ line: sizeLine, batches: [parent] });
    db.tx.order.findFirst = vi.fn(async () => db.order);
    db.tx.orderLine.findUnique = vi.fn(async () => sizeLine);
    db.tx.relation = { findUnique: vi.fn(async () => ({ id: 'FACTORY-LOCKED', name: 'Factory', category: 'Supplier', isOrganization: true, deletedAt: null })) };
    db.tx.factoryProfile = { findUnique: vi.fn(async () => ({ relationId: 'FACTORY-LOCKED', deletedAt: null, blacklistedAt: null })) };
    db.tx.auditLog = { findMany: vi.fn(async () => []) };
    db.tx.productionBatch.updateMany = vi.fn(async () => ({ count: 1 }));
    db.tx.shipmentProductionAllocation = { findFirst: vi.fn(async () => null) };
    db.tx.productionStockReceipt = { findFirst: vi.fn(async () => null) };
    const lineFingerprint = productionBatchLineFingerprint(db.order, sizeLine);
    const split = await splitProductionBatch({ prisma: db.prisma, batchId: parent.id, actor: db.actor, input: {
      expectedRevision: 1, expectedLineFingerprint: lineFingerprint, requestKey: '7fc58690-9475-4af5-8a8b-f671f7021588',
      children: [
        { batchCode: 'SIZE-CHILD-A', quantity: '50', sizeBreakdown: { S: 20, M: 30 } },
        { batchCode: 'SIZE-CHILD-B', quantity: '50', sizeBreakdown: { S: 20, M: 30 } },
      ],
    } });
    expect(split).toMatchObject({ ok: true, data: { children: [
      { sizeBreakdown: { S: 20, M: 30 } }, { sizeBreakdown: { S: 20, M: 30 } },
    ] } });
  });
});
