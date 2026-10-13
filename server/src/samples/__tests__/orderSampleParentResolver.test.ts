import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { resolveOrderSampleParents, type OrderSampleParentDb, type OrderSampleParentRequest } from '../orderSampleParentResolver';
import { buildOrderSampleSource, type OrderSampleFamily } from '../orderSampleSourceContract';
import { productionBatchLineFingerprint, productionBatchSourceFingerprint } from '../../production/productionBatchFacts';
import { sampleOriginFingerprint } from '../sampleOriginService';

type Row = Record<string, any>;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => {
    if (key === 'OR') return value.some((item: Row) => matches(row, item));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('path' in value) {
        const actual = value.path.reduce((part: any, field: string) => part?.[field], row[key]);
        return 'equals' in value ? actual === value.equals : false;
      }
    }
    return row[key] === value;
  });
}
function fixture(lane: 'fabric'|'garment' = 'fabric') {
  const order: Row = { id: 'O', type: lane === 'fabric' ? 'Fabric' : 'Garment', businessLine: lane,
    millRelationId: 'F', customerRelationId: 'CUST', sourceCaseId: null, deletedAt: null, updatedAt: BigInt(1) };
  const line: Row = { id: 'L', orderId: 'O', confirmedSourceType: 'Asset', confirmedSourceId: 'A',
    ...(lane === 'garment' ? { fulfillmentMode: 'cmt', cmtIncludedItems: [] } : {}),
    specSnapshot: { article: 'Q1', width: '150' }, quantity: new Prisma.Decimal('100'), unit: lane === 'fabric' ? 'M' : 'PC' };
  const asset: Row = { id: 'A', mainCategory: order.type, source: 'manual', updatedAt: BigInt(1), deletedAt: null,
    fabricProfile: lane === 'fabric' ? { id: 'FP', productAssetId: 'A', millOrganizationId: 'F', updatedAt: BigInt(1), deletedAt: null } : null,
    garmentProfile: lane === 'garment' ? { id: 'GP', productAssetId: 'A', factoryRelationId: 'F', updatedAt: BigInt(1), deletedAt: null } : null };
  const batch: Row = { id: 'B', orderId: 'O', orderLineId: 'L', factoryRelationId: 'F', revision: 1, state: 'active',
    rangeStart: new Prisma.Decimal(0), quantity: new Prisma.Decimal('100'), unit: line.unit,
    confirmedSourceType: line.confirmedSourceType, confirmedSourceId: line.confirmedSourceId, specSnapshot: line.specSnapshot,
    sourceFingerprint: productionBatchSourceFingerprint(order, line, 'F') };
  const tables: Record<string, Row[]> = { order: [order], orderLine: [line], productionBatch: [batch], productAsset: [asset],
    relation: [{ id: 'F', deletedAt: null, isOrganization: true }, { id: 'CUST', deletedAt: null }], sample: [], sampleSource: [], sampleBatch: [],
    developmentCase: [], sealSample: [], sealSampleBatch: [], auditLog: [] };
  const delegates: Row = {};
  for (const [name, rows] of Object.entries(tables)) delegates[name] = {
    findUnique: vi.fn(async ({ where }: Row) => rows.find(row => matches(row, where)) ?? null),
    findFirst: vi.fn(async ({ where }: Row) => rows.find(row => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: Row) => rows.filter(row => matches(row, where))),
    create: vi.fn(() => { throw new Error('WRITE_FORBIDDEN'); }), update: vi.fn(() => { throw new Error('WRITE_FORBIDDEN'); }),
  };
  delegates.$transaction = vi.fn(() => { throw new Error('TRANSACTION_FORBIDDEN'); });
  delegates.$queryRaw = vi.fn(() => { throw new Error('LOCK_FORBIDDEN'); });
  const request = (family: OrderSampleFamily = lane === 'fabric' ? 'fabric_ss' : 'garment_top'): OrderSampleParentRequest => ({ family, orderId: 'O', factoryRelationId: 'F',
    coverage: [{ orderLineId: 'L', expectedLineFingerprint: productionBatchLineFingerprint(order, line),
      productionBatchId: 'B', expectedBatchRevision: 1, rangeStart: '20', quantity: '30', unit: line.unit }] });
  function source(kind: 'Sample'|'SealSample') {
    line.confirmedSourceType = kind; line.confirmedSourceId = kind === 'Sample' ? 'S' : 'Z';
    batch.confirmedSourceType = kind; batch.confirmedSourceId = line.confirmedSourceId;
    batch.sourceFingerprint = productionBatchSourceFingerprint(order, line, 'F');
    const development = { id: 'CASE', type: lane, supplierRelationId: 'F', productAssetId: null, deletedAt: BigInt(8), updatedAt: BigInt(9) };
    const sb = { id: 'SB', developmentCaseId: 'CASE', supplierRelationId: 'F', round: 2,
      sampleType: lane === 'fabric' ? 'yardage' : 'garment-round', convertedProductAssetId: null, deletedAt: BigInt(8), updatedAt: BigInt(9) };
    tables.developmentCase.push(development); tables.sampleBatch.push(sb);
    if (kind === 'SealSample') {
      tables.sealSample.push({ id: 'Z', developmentCaseId: 'CASE', supplierRelationId: 'F', convertedProductAssetId: null, deletedAt: BigInt(8), updatedAt: BigInt(9) });
      tables.sealSampleBatch.push({ id: 'LINK', sealSampleId: 'Z', sampleBatchId: 'SB' });
    } else {
      tables.sample.push({ id: 'S', sourceCaseId: 'CASE', sourceOrderId: null, productAssetId: null, forkedFromSampleId: null,
        supplierRelationId: 'F', projectionKey: 'v1:fabric_output:SB:1', round: 1, status: 'draft', deletedAt: BigInt(8), updatedAt: BigInt(9) });
      const snapshot = { schemaVersion: 1 as const, batch: { id: 'SB', code: 'SB-code', caseId: 'CASE', factoryId: 'F', sampleType: sb.sampleType, sourceRound: 1 },
        content: {}, version: { updatedAt: '1', historyRevision: null, eventId: null } };
      tables.sampleSource.push({ id: 'ORIGIN', sampleId: 'S', sampleBatchId: 'SB', sourceRound: 1, sourceSealId: null,
        sourceSnapshot: snapshot, sourceFingerprint: sampleOriginFingerprint(snapshot), sourceUpdatedAt: BigInt(1), sourceHistoryRevision: null,
        sourceEventId: null, evidenceAuditId: 'EVIDENCE', boundAt: BigInt(1), boundBy: 'USER', provenance: 'current_link_recorded' });
      tables.auditLog.push({ id: 'EVIDENCE', action: 'record_sample_source', targetType: 'Sample', targetId: 'S', detail: {}, actorId: 'USER' });
    }
  }
  return { db: delegates as OrderSampleParentDb, delegates, tables, order, line, batch, asset, request, source };
}
async function rejection(run: Promise<unknown>, code: string) { await expect(run).rejects.toMatchObject({ code }); }

describe('trusted order sample parent resolution', () => {
  it('resolves Order-only actual Asset, legal partial Batch and exact frozen builder inputs', async () => {
    const f = fixture(), result = await resolveOrderSampleParents(f.db, f.request());
    expect(result.owner).toEqual({ orderId: 'O', businessLine: 'fabric', factoryRelationId: 'F' });
    expect(result.coverage[0]).toMatchObject({ rangeStart: '20', quantity: '30' });
    expect(result.lines[0].lineFingerprint).toBe(productionBatchLineFingerprint(f.order, f.line));
    const built = buildOrderSampleSource({ domain: 'order', sourceId: 'SOURCE', sampleId: 'OUTPUT', family: 'fabric_ss',
      owner: result.owner, specSnapshot: result.specSnapshot, coverage: result.coverage, lines: result.lines, batches: result.batches,
      chainId: 'CHAIN', round: 1, previousSourceId: null, provenance: 'native_new',
      sampleFacts: { quantity: '2', unit: 'M', cuttingDate: '2026-10-04' } });
    expect(built.coverage[0]).toMatchObject({ quantity: '30', batchQuantity: '100' });
  });
  it.each(['fabric_rc','fabric_eps','garment_top','garment_ship','garment_pp'] as const)('maps explicit %s to real owner and allows real Batch', async family => {
    const f = fixture(family.startsWith('fabric') ? 'fabric' : 'garment');
    expect((await resolveOrderSampleParents(f.db, f.request(family))).owner.businessLine).toBe(f.order.businessLine);
  });
  it('allows only garment PP direct Line, with genuine factory and neutral source token', async () => {
    const f = fixture('garment'), input = f.request('garment_pp');
    delete (input.coverage[0] as any).productionBatchId; delete (input.coverage[0] as any).expectedBatchRevision;
    const result = await resolveOrderSampleParents(f.db, input);
    expect(result.batches).toEqual([]);
    expect(result.lines[0].sourceFingerprint).toBe(productionBatchSourceFingerprint(f.order, f.line, 'F'));
    await rejection(resolveOrderSampleParents(f.db, { ...input, family: 'garment_top' }), 'ORDER_SAMPLE_PARENT_INVALID');
  });
  it('rejects conflicting or unsupported Order owner without default fabric', async () => {
    const f = fixture(); f.order.businessLine = 'garment';
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_CONFLICT');
    f.order.businessLine = null; f.order.type = 'Other';
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
  });
  it('uses actual neutral helper rejection for stale Batch revision and mismatched persisted source', async () => {
    const f = fixture(); f.batch.revision = 2;
    await expect(resolveOrderSampleParents(f.db, f.request())).rejects.toMatchObject({ name: 'ProductionBatchFactsError' });
    f.batch.revision = 1; f.batch.sourceFingerprint = '0'.repeat(64);
    await expect(resolveOrderSampleParents(f.db, f.request())).rejects.toMatchObject({ name: 'ProductionBatchFactsError' });
  });
  it('does not mask storage failures as unresolved source', async () => {
    const f = fixture(), fault = new Error('STORAGE_DISCONNECTED'); f.delegates.productionBatch.findUnique.mockRejectedValue(fault);
    await expect(resolveOrderSampleParents(f.db, f.request())).rejects.toBe(fault);
  });
  it('rejects actual Batch on another requested Line or Order', async () => {
    const f = fixture(), other = { ...f.line, id: 'OTHER' }; f.tables.orderLine.push(other); f.batch.orderLineId = 'OTHER';
    f.batch.sourceFingerprint = productionBatchSourceFingerprint(f.order, other, 'F');
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_CONFLICT');
  });
  it('requires selected factory live, but does not require ancestor approval or current round', async () => {
    const f = fixture(); f.source('Sample');
    const result = await resolveOrderSampleParents(f.db, f.request());
    expect(result.lockRefs.sampleSourceIds).toEqual(['ORIGIN']); expect(result.lockRefs.sampleBatchIds).toEqual(['SB']);
    expect(result.lockRefs.developmentCaseIds).toEqual(['CASE']);
    expect(result).not.toHaveProperty('currentUsable'); expect(result).not.toHaveProperty('approval');
    f.tables.relation[0].deletedAt = BigInt(2);
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
  });
  it('reads every Seal component and permits soft-deleted historical rows', async () => {
    const f = fixture(); f.source('SealSample');
    f.tables.sampleBatch.push({ ...f.tables.sampleBatch[0], id: 'SB2', round: 1 });
    f.tables.sealSampleBatch.push({ id: 'LINK2', sealSampleId: 'Z', sampleBatchId: 'SB2' });
    const result = await resolveOrderSampleParents(f.db, f.request());
    expect(result.lockRefs.sampleBatchIds).toEqual(['SB','SB2']); expect(result.lockRefs.sealSampleBatchIds).toEqual(['LINK','LINK2']);
    f.tables.sampleBatch[1].supplierRelationId = 'OTHER';
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_CONFLICT');
  });
  it('fails closed for Case-native Sample without binding, malformed binding and missing exact evidence', async () => {
    const f = fixture(); f.source('Sample'); const binding = f.tables.sampleSource.pop()!;
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
    f.tables.sampleSource.push(binding); binding.sourceSnapshot.batch.factoryId = 'OTHER';
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_CONFLICT');
    binding.sourceSnapshot.batch.factoryId = 'F'; f.tables.auditLog.length = 0;
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
  });
  it('keeps garment Case fabric descriptor as descriptor, without changing business owner', async () => {
    const f = fixture('garment'); f.source('Sample'); f.tables.developmentCase[0].productAssetId = 'D';
    f.tables.productAsset.push({ id: 'D', mainCategory: 'Fabric', source: 'manual', fabricProfile: { id: 'DF', productAssetId: 'D', millOrganizationId: null }, garmentProfile: null });
    const result = await resolveOrderSampleParents(f.db, f.request('garment_pp'));
    expect(result.owner.businessLine).toBe('garment'); expect(result.lockRefs.productAssetIds).toContain('D');
  });
  it('walks exact fork ancestors and rejects missing/cyclic fork chain', async () => {
    const f = fixture(); f.source('Sample'); f.tables.sample[0].forkedFromSampleId = 'P';
    f.tables.sample.push({ id: 'P', supplierRelationId: 'OLD_FACTORY', sourceCaseId: null, sourceOrderId: 'O', productAssetId: null, forkedFromSampleId: null, deletedAt: BigInt(2) });
    f.tables.relation.push({ id: 'OLD_FACTORY', deletedAt: BigInt(2) });
    const historical = await resolveOrderSampleParents(f.db, f.request());
    expect(historical.lockRefs.sampleIds).toEqual(['P','S']); expect(historical.lockRefs.relationIds).toEqual(['CUST','F','OLD_FACTORY']);
    f.tables.sample[1].forkedFromSampleId = 'S';
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
    f.tables.sample.pop();
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
  });
  it('resolves exact converted fabric Asset ancestors and rejects ambiguous/missing conversion', async () => {
    const f = fixture(); f.asset.source = 'development';
    f.tables.developmentCase.push({ id: 'CASE', type: 'fabric', productAssetId: 'A', supplierRelationId: 'F', deletedAt: BigInt(2) });
    f.tables.sampleBatch.push({ id: 'SB', developmentCaseId: 'CASE', supplierRelationId: 'F', sampleType: 'yardage', round: 2, convertedProductAssetId: 'A' });
    const audit = { id: 'CONVERT', actorId: 'U', targetType: 'ProductAsset', targetId: 'A', action: 'convert_fabric_to_asset',
      detail: { source: 'route:dev:fabric-convert-asset', after: { fromCase: 'CASE', sourceType: 'batch', sourceId: 'SB' } } };
    f.tables.auditLog.push(audit);
    expect((await resolveOrderSampleParents(f.db, f.request())).lockRefs.auditLogIds).toEqual(['CONVERT']);
    f.tables.auditLog.push({ ...audit, id: 'CONVERT2' });
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
    f.tables.auditLog.length = 0;
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
  });
  it('refuses old garment node conversion without explicit native round ID', async () => {
    const f = fixture('garment'); f.asset.source = 'development';
    f.tables.auditLog.push({ id: 'CONVERT', actorId: 'U', targetType: 'ProductAsset', targetId: 'A', action: 'convert_garment_to_asset',
      detail: { source: 'route:dev:garment-convert-asset', after: { fromCase: 'CASE', sourceType: 'node', sourceId: 'confirmation' } } });
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
  });
  it('resolves exact garment conversion round and the normal Asset/Sample mutual reference', async () => {
    const f = fixture('garment'); f.source('Sample');
    f.line.confirmedSourceType = 'Asset'; f.line.confirmedSourceId = 'A'; f.batch.confirmedSourceType = 'Asset'; f.batch.confirmedSourceId = 'A';
    f.batch.sourceFingerprint = productionBatchSourceFingerprint(f.order, f.line, 'F');
    f.asset.source = 'development'; f.tables.sample[0].productAssetId = 'A'; f.tables.developmentCase[0].productAssetId = 'A';
    f.tables.sampleBatch[0].convertedProductAssetId = 'A';
    f.tables.auditLog.push({ id: 'CONVERT', actorId: 'U', targetType: 'ProductAsset', targetId: 'A', action: 'convert_garment_to_asset',
      detail: { source: 'route:dev:garment-convert-asset', after: { fromCase: 'CASE', sourceType: 'node', sourceId: 'confirmation', sourceRoundId: 'SB', sampleId: 'S' } } });
    const result = await resolveOrderSampleParents(f.db, f.request());
    expect(result.lockRefs.sampleIds).toEqual(['S']); expect(result.lockRefs.sampleBatchIds).toEqual(['SB']);
    expect(result.lockRefs.auditLogIds).toEqual(['CONVERT','EVIDENCE']);
  });
  it('requires the Sample original Seal bindings to cover every actual component', async () => {
    const f = fixture(); f.source('Sample'); f.tables.sampleSource[0].sourceSealId = 'Z';
    f.tables.sealSample.push({ id: 'Z', developmentCaseId: 'CASE', supplierRelationId: 'F' });
    f.tables.sampleBatch.push({ ...f.tables.sampleBatch[0], id: 'SB2' });
    f.tables.sealSampleBatch.push({ id: 'LINK', sealSampleId: 'Z', sampleBatchId: 'SB' }, { id: 'LINK2', sealSampleId: 'Z', sampleBatchId: 'SB2' });
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_CONFLICT');
    const snapshot = { ...f.tables.sampleSource[0].sourceSnapshot, batch: { ...f.tables.sampleSource[0].sourceSnapshot.batch, id: 'SB2' } };
    f.tables.sampleSource.push({ ...f.tables.sampleSource[0], id: 'ORIGIN2', sampleBatchId: 'SB2', sourceSnapshot: snapshot, sourceFingerprint: sampleOriginFingerprint(snapshot) });
    expect((await resolveOrderSampleParents(f.db, f.request())).lockRefs.sampleSourceIds).toEqual(['ORIGIN','ORIGIN2']);
  });
  it('accepts disjoint same-Line Batch ranges in coordinate order and rejects overlap', async () => {
    const f = fixture(); f.batch.rangeStart = new Prisma.Decimal('50'); f.batch.quantity = new Prisma.Decimal('50');
    f.tables.productionBatch.push({ ...f.batch, id: 'ZB', rangeStart: new Prisma.Decimal(0), quantity: new Prisma.Decimal('50') });
    const input = f.request(); input.coverage[0].rangeStart = '50'; input.coverage[0].quantity = '50';
    input.coverage.push({ ...input.coverage[0], productionBatchId: 'ZB', rangeStart: '0' });
    const result = await resolveOrderSampleParents(f.db, input);
    expect(result.coverage.map(c => c.rangeStart)).toEqual(['0','50']);
    f.tables.productionBatch[1].quantity = new Prisma.Decimal('70'); input.coverage[1].quantity = '70';
    await rejection(resolveOrderSampleParents(f.db, input), 'ORDER_SAMPLE_PARENT_CONFLICT');
  });
  it('combines compatible real Lines but rejects a second Line with different spec or factory', async () => {
    const f = fixture(), line2: Row = { ...f.line, id: 'L2' }; f.tables.orderLine.push(line2);
    const batch2: Row = { ...f.batch, id: 'B2', orderLineId: 'L2', sourceFingerprint: productionBatchSourceFingerprint(f.order, line2, 'F') }; f.tables.productionBatch.push(batch2);
    const input = f.request(); input.coverage.push({ ...input.coverage[0], orderLineId: 'L2', productionBatchId: 'B2', expectedLineFingerprint: productionBatchLineFingerprint(f.order, line2) });
    expect((await resolveOrderSampleParents(f.db, input)).lines.map(l => l.id)).toEqual(['L','L2']);
    line2.specSnapshot = { article: 'Q2', width: '150' }; batch2.specSnapshot = line2.specSnapshot;
    input.coverage[1].expectedLineFingerprint = productionBatchLineFingerprint(f.order, line2); batch2.sourceFingerprint = productionBatchSourceFingerprint(f.order, line2, 'F');
    await rejection(resolveOrderSampleParents(f.db, input), 'ORDER_SAMPLE_PARENT_CONFLICT');
    line2.specSnapshot = f.line.specSnapshot; batch2.specSnapshot = line2.specSnapshot; batch2.factoryRelationId = 'OTHER';
    input.coverage[1].expectedLineFingerprint = productionBatchLineFingerprint(f.order, line2); batch2.sourceFingerprint = productionBatchSourceFingerprint(f.order, line2, 'OTHER');
    await expect(resolveOrderSampleParents(f.db, input)).rejects.toMatchObject({ name: 'ProductionBatchFactsError' });
  });
  it('cannot invent direct-Line factory when both Order and confirmed Asset omit it', async () => {
    const f = fixture('garment'); f.order.millRelationId = null; f.asset.garmentProfile.factoryRelationId = null;
    const input = f.request('garment_pp'); input.coverage[0].productionBatchId = null; input.coverage[0].expectedBatchRevision = null;
    await rejection(resolveOrderSampleParents(f.db, input), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
    // An actual Batch is independently a real factory-bearing parent.
    f.batch.sourceFingerprint = productionBatchSourceFingerprint(f.order, f.line, 'F');
    expect((await resolveOrderSampleParents(f.db, f.request('garment_pp'))).batches[0].factoryRelationId).toBe('F');
  });
  it('canonicalizes exact Decimal/unit without conversion and rejects invalid ranges or precision', async () => {
    const f = fixture(), input = f.request(); input.coverage[0].quantity = '30.0000'; input.coverage[0].unit = 'meter';
    expect((await resolveOrderSampleParents(f.db, input)).coverage[0]).toMatchObject({ quantity: '30', unit: 'M' });
    input.coverage[0].unit = 'YD';
    await rejection(resolveOrderSampleParents(f.db, input), 'ORDER_SAMPLE_PARENT_CONFLICT');
    input.coverage[0].unit = 'M'; input.coverage[0].quantity = '80';
    expect((await resolveOrderSampleParents(f.db, input)).coverage[0].quantity).toBe('80');
    input.coverage[0].quantity = '81';
    await rejection(resolveOrderSampleParents(f.db, input), 'ORDER_SAMPLE_PARENT_CONFLICT');
    input.coverage[0].quantity = '1.00001';
    await expect(resolveOrderSampleParents(f.db, input)).rejects.toMatchObject({ code: 'ORDER_SAMPLE_CONTRACT_INVALID' });
  });
  it('uses full real Line fingerprint, including quantity, and fingerprints ancestor identity changes', async () => {
    const f = fixture(), before = await resolveOrderSampleParents(f.db, f.request()), old = f.request();
    f.line.quantity = new Prisma.Decimal('101');
    await rejection(resolveOrderSampleParents(f.db, old), 'ORDER_SAMPLE_PARENT_CONFLICT');
    const changed = await resolveOrderSampleParents(f.db, f.request());
    expect(changed.parentFingerprint).not.toBe(before.parentFingerprint);
    f.asset.updatedAt = BigInt(2);
    expect((await resolveOrderSampleParents(f.db, f.request())).parentFingerprint).not.toBe(changed.parentFingerprint);
  });
  it('has stable graph ordering and never runs auth, writes, transaction, or locks', async () => {
    const f = fixture(); f.source('SealSample'); const one = await resolveOrderSampleParents(f.db, f.request());
    f.tables.sealSampleBatch.reverse(); const two = await resolveOrderSampleParents(f.db, f.request());
    expect(two.parentFingerprint).toBe(one.parentFingerprint); expect(two.lockRefs).toEqual(one.lockRefs);
    expect(f.delegates.productionBatch.findUnique).toHaveBeenCalledWith({ where: { id: 'B' } });
    expect(f.delegates.relation.findFirst).toHaveBeenCalledWith({ where: { id: 'F', deletedAt: null } });
    expect(f.delegates.$transaction).not.toHaveBeenCalled(); expect(f.delegates.$queryRaw).not.toHaveBeenCalled();
    for (const delegate of Object.values(f.delegates) as any[]) if (delegate.create) { expect(delegate.create).not.toHaveBeenCalled(); expect(delegate.update).not.toHaveBeenCalled(); }
  });
  it('has a bounded ancestor traversal and never silently truncates lockRefs', async () => {
    const f = fixture(); f.source('Sample'); let parent = f.tables.sample[0];
    for (let i = 0; i < 160; i++) { const row = { id: `P${i}`, sourceCaseId: null, sourceOrderId: 'O', supplierRelationId: 'F', forkedFromSampleId: null }; parent.forkedFromSampleId = row.id; f.tables.sample.push(row); parent = row; }
    await rejection(resolveOrderSampleParents(f.db, f.request()), 'ORDER_SAMPLE_PARENT_UNRESOLVED');
  });
});
