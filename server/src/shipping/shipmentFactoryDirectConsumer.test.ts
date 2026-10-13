import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { qcReportSourceFingerprint as hash } from '../qc/qcReportAuthority';
const seams = vi.hoisted(() => ({ native: vi.fn(), direct: vi.fn(), coverage: vi.fn(), quality: vi.fn() }));
vi.mock('./shipmentPhysicalAllocationService', async importOriginal => ({ ...(await importOriginal<any>()),
  validatePhysicalAllocationVersion: vi.fn(async () => 1), verifyOriginalProductionReceipt: seams.native }));
vi.mock('./factoryLoadingReceiptService', () => ({ verifyFactoryLoadingReceiptInTx: seams.direct }));
vi.mock('../production/productionBatchService', () => ({ resolveCurrentProductionBatchFacts: vi.fn(async () => ({})) }));
vi.mock('../qc/qcPhysicalCoverage', () => ({ resolveQcCoverage: seams.coverage }));
vi.mock('../qc/productionQcSizeCoverage', () => ({ readProductionQcReleaseCoverage: seams.quality }));
import { validateReservedPhysicalShipment } from './shipmentPhysicalConsumerService';
import { readPhysicalReceiptAllocations } from './shipmentPhysicalAllocationService';
import { validatePhysicalPackingQuantities } from './shipmentPhysicalCommand';
function fixture() {
  const scopeSnapshot = { batch: 'B1', revision: 2, factory: 'F1' }, scopeFingerprint = hash(scopeSnapshot);
  seams.coverage.mockResolvedValue({ scopeFingerprint, scopeSnapshot });
  seams.quality.mockResolvedValue({ satisfied: true, failureReasons: [] });
  const identity: any = { sourceKind: 'factory_direct', factoryLoadingReceiptId: 'FLR1', handoffId: 'H1', shipmentId: 'S1',
    productionBatchRevision: 2, factoryRelationId: 'F1', loadedQuantity: '4', unit: 'pcs', loadingScopeFingerprint: scopeFingerprint, loadingCommandHash: 'd'.repeat(64) };
  const row: any = { ...identity, stockReceiptId: null, plannedQty: '4', actualQty: '4' };
  const batch: any = { id: 'B1', orderId: 'O1', orderLineId: 'L1', revision: 2, factoryRelationId: 'F1', unit: 'pcs', quantity: '10' };
  const allocation: any = { id: 'A1', orderId: 'O1', orderLineId: 'L1', unit: 'pcs', plannedQty: '5', actualQty: '4', status: 'Planned' };
  const projection: any = { id: 'P1', allocationId: 'A1', shipmentId: 'S1', orderId: 'O1', orderLineId: 'L1', productionBatchId: 'B1',
    productionBatchRevision: 2, unit: 'pcs', state: 'reserved', plannedQty: '5', actualQty: '4',
    scopeSnapshot: { schemaVersion: 1, allocationVersion: 1, scopeType: 'production_batch', scopeKey: 'production_batch:B1', scopeFingerprint, scopeSnapshot,
      receiptAllocations: [row, { stockReceiptId: null, plannedQty: '1', actualQty: '0', unit: 'pcs' }] } };
  const context: any = { kind: 'physical', shipment: { id: 'S1' }, allocations: [allocation], physical: [projection], batches: [batch] };
  seams.direct.mockResolvedValue({ receipt: { quantity: new Prisma.Decimal('4') }, identity });
  return { context, row, projection, allocation, batch, identity };
}
beforeEach(() => vi.resetAllMocks());
describe('factory-direct physical consumers', () => {
  it('reads direct and unbound-zero identities distinctly and supplies exact factory batch proof to packing/dispatch', async () => {
    const f = fixture(), read = readPhysicalReceiptAllocations(f.projection);
    expect(read[0]).toMatchObject({ factoryLoadingReceiptId: 'FLR1', stockReceiptId: null, actualQty: '4' });
    expect(read[1]).not.toHaveProperty('factoryLoadingReceiptId');
    const verified = await validateReservedPhysicalShipment({}, f.context, true);
    expect(verified.rows).toHaveLength(1); expect(verified.rows[0]).toMatchObject({ sourceKind: 'factory_direct', physicalAllocationId: 'P1', factoryRelationId: 'F1', actualQty: '4' });
    expect(verified.physicalBatchIdsByOrder).toEqual({ O1: ['B1'] }); expect(seams.native).not.toHaveBeenCalled();
    expect(seams.quality).toHaveBeenCalledOnce();
    expect(seams.quality).toHaveBeenCalledWith({}, { orderId: 'O1', productionBatchId: 'B1', expectedBatchRevision: 2 });
    expect(() => validatePhysicalPackingQuantities(f.context, [{ orderLineId: 'L1', unit: 'pcs', quantity: '4' }], true)).not.toThrow();
    expect(() => validatePhysicalPackingQuantities(f.context, [{ orderLineId: 'L1', unit: 'pcs', quantity: '5' }], true)).toThrow();
  });
  it.each(['unknown', 'scope', 'factory', 'overrun', 'both-sources'])('refuses %s direct quantity or source without falling back to plan', async kind => {
    const f = fixture();
    if (kind === 'unknown') { f.row.actualQty = null; f.allocation.actualQty = null; }
    if (kind === 'scope') f.projection.scopeSnapshot.scopeFingerprint = 'a'.repeat(64);
    if (kind === 'factory') seams.direct.mockResolvedValue({ receipt: { quantity: '4' }, identity: { ...f.identity, factoryRelationId: 'F2' } });
    if (kind === 'overrun') { f.row.actualQty = '5'; f.allocation.actualQty = '5'; }
    if (kind === 'both-sources') f.row.stockReceiptId = 'R1';
    await expect(validateReservedPhysicalShipment({}, f.context, true)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(seams.native).not.toHaveBeenCalled();
  });
  it.each(['实际生产尺码缺少有效检验：M。', '生产 QC 问题 I1 尚未解除，当前工厂分支暂停。',
    '生产 QC 问题 I1 复验已通过，等待业务明确恢复。', '生产 QC 问题台账暂不可读取。'])
  ('refuses factory-direct goods with current production quality blocker: %s', async reason => {
    const f = fixture(); seams.quality.mockResolvedValue({ satisfied: false, failureReasons: [reason] });
    await expect(validateReservedPhysicalShipment({}, f.context, true)).rejects.toMatchObject({ code: 'GATE_BLOCKED', statusCode: 409 });
    expect(seams.direct).toHaveBeenCalledOnce(); expect(seams.native).not.toHaveBeenCalled();
  });
  it('applies the same branch quality condition to native stock receipts', async () => {
    const f = fixture();
    f.row.stockReceiptId = 'R1'; delete f.row.factoryLoadingReceiptId;
    const identity = { stockReceiptId: 'R1', warehouseId: 'W1', inventoryItemId: 'I1', stockMovementId: 'M1' };
    Object.assign(f.row, identity); seams.native.mockResolvedValue({ receipt: { quantity: '4' }, identity });
    seams.quality.mockResolvedValue({ satisfied: false, failureReasons: ['生产 QC 复验等待业务确认继续。'] });
    await expect(validateReservedPhysicalShipment({}, f.context, true)).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    expect(seams.native).toHaveBeenCalledOnce(); expect(seams.direct).not.toHaveBeenCalled();
    expect(seams.quality).toHaveBeenCalledOnce();
    expect(seams.quality).toHaveBeenCalledWith({}, { orderId: 'O1', productionBatchId: 'B1', expectedBatchRevision: 2 });
  });
});
