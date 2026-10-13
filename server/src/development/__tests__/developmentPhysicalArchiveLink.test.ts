import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ origin: vi.fn(), fingerprint: vi.fn() }));
vi.mock('../../samples/sampleOriginService', () => ({ snapshotSampleOrigin: mocks.origin, sampleOriginFingerprint: mocks.fingerprint }));
vi.mock('../../samples/sampleBatchReceipt', () => ({ readBatchReceiptSnapshot: (value: any) => value?.version === 2 ? value : null }));
import { findDevelopmentFabricVersionAsset, linkDevelopmentPhysicalSampleToAsset, linkDevelopmentPhysicalSamplesToAsset } from '../developmentPhysicalArchiveLink';

function fixture() {
  const batch = { id: 'batch-1', round: 1, supplierRelationId: 'factory-1', sampleType: 'yardage', sampleVersionId: null };
  const devCase = { id: 'case-1' };
  const card = { id: 'card-1', code: 'SC-1', devCaseId: 'case-1', batchId: 'batch-1', unit: '米', cardType: 'fabric', quantity: 1, productAssetId: null,
    receiptSnapshot: { version: 2, batchId: 'batch-1', developmentCaseId: 'case-1', sourceRound: 1,
      factoryId: 'factory-1', sampleType: 'yardage', sourceFingerprint: 'f'.repeat(64), cardType: 'fabric', physicalUnit: '米' } };
  const tx = { sampleCardItem: { findMany: vi.fn(async () => [card]), update: vi.fn(async () => undefined) },
    auditLog: { findMany: vi.fn(async () => [{ operationType: 'create', detail: { source: 'development:sample-return', after: {
      batchId: 'batch-1', devCaseId: 'case-1', unit: '米', code: 'SC-1', quantity: 1, receiptSnapshot: card.receiptSnapshot,
    } } }]) } };
  mocks.origin.mockReturnValue({}); mocks.fingerprint.mockReturnValue('f'.repeat(64));
  return { batch, devCase, card, tx };
}

describe('Development physical sample archive link', () => {
  beforeEach(() => vi.clearAllMocks());
  it('links the exact registered physical row to the archive and preserves its source identity', async () => {
    const f = fixture();
    await expect(linkDevelopmentPhysicalSampleToAsset(f.tx, f.batch, f.devCase, 'asset-1', 55n)).resolves.toBe('card-1');
    expect(f.tx.sampleCardItem.update).toHaveBeenCalledWith({ where: { id: 'card-1' }, data: { productAssetId: 'asset-1', updatedAt: 55n } });
  });
  it('rejects missing or ambiguous physical records instead of archiving an inferred sample', async () => {
    const f = fixture(); f.tx.sampleCardItem.findMany.mockResolvedValue([]);
    await expect(linkDevelopmentPhysicalSampleToAsset(f.tx, f.batch, f.devCase, 'asset-1', 55n)).rejects.toThrow('尚无开发登记的实物样');
    expect(f.tx.sampleCardItem.update).not.toHaveBeenCalled();
  });
  it('rejects a receipt that no longer points to the exact source version', async () => {
    const f = fixture(); (f.card.receiptSnapshot as any).sourceRound = 2;
    await expect(linkDevelopmentPhysicalSampleToAsset(f.tx, f.batch, f.devCase, 'asset-1', 55n)).rejects.toThrow('来源快照与当前版本不一致');
    expect(f.tx.sampleCardItem.update).not.toHaveBeenCalled();
  });
  it('references a dotted version without overwriting the existing physical product identity or inventory', async () => {
    const f = fixture(); f.card.productAssetId = 'parent-product';
    await expect(linkDevelopmentPhysicalSamplesToAsset(f.tx, f.batch, f.devCase, 'minor-product', 55n, { referenceOnly: true }))
      .resolves.toEqual({ physicalCardId: 'card-1', physicalCardIds: ['card-1'] });
    expect(f.card.productAssetId).toBe('parent-product');
    expect(f.tx.sampleCardItem.update).not.toHaveBeenCalled();
  });
  it('still requires original physical receipt evidence when only referencing an existing piece', async () => {
    const f = fixture(); (f.card.receiptSnapshot as any).factoryId = 'another-factory';
    await expect(linkDevelopmentPhysicalSampleToAsset(f.tx, f.batch, f.devCase, 'minor-product', 55n, { referenceOnly: true }))
      .rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    expect(f.tx.sampleCardItem.update).not.toHaveBeenCalled();
  });

  it('links every physical garment item for one exact version to the same product identity', async () => {
    const f = fixture();
    f.batch.sampleType = 'garment-round';
    f.batch.sampleVersionId = 'version-garment';
    const cards = [1, 2].map(index => {
      const receiptSnapshot = { ...f.card.receiptSnapshot, sampleType: 'garment-round', cardType: 'garment', physicalUnit: 'PC', initialPhysicalCardCount: 1,
        physicalItemIndex: index, physicalItemCount: 2 };
      return { ...f.card, id: `garment-${index}`, code: `SC-G-${index}`, cardType: 'garment', unit: 'PC', quantity: 1,
        receiptSnapshot };
    });
    (f.tx.sampleBatch as any) = { findMany: vi.fn(async () => [f.batch]) };
    f.tx.sampleCardItem.findMany.mockResolvedValue(cards as any);
    (f.tx.auditLog.findMany as any).mockImplementation(async ({ where }: any) => {
      const card = cards.find(row => row.id === where.targetId)!;
      return [{ operationType: 'create', detail: { source: 'development:sample-return', after: {
        batchId: f.batch.id, devCaseId: f.devCase.id, unit: card.unit, code: card.code, quantity: 1, receiptSnapshot: card.receiptSnapshot,
      } } }];
    });

    await expect(linkDevelopmentPhysicalSampleToAsset(f.tx, f.batch, f.devCase, 'asset-shared', 55n)).resolves.toBe('garment-1');
    expect(f.tx.sampleCardItem.update).toHaveBeenCalledTimes(2);
    expect(f.tx.sampleCardItem.update).toHaveBeenCalledWith({ where: { id: 'garment-1' }, data: { productAssetId: 'asset-shared', updatedAt: 55n } });
    expect(f.tx.sampleCardItem.update).toHaveBeenCalledWith({ where: { id: 'garment-2' }, data: { productAssetId: 'asset-shared', updatedAt: 55n } });
  });

  it('links all shape batches within one exact fabric version without creating or moving inventory rows', async () => {
    const f = fixture();
    f.batch.sampleVersionId = 'version-fabric';
    const secondBatch = { ...f.batch, id: 'batch-yardage', sampleType: 'yardage', round: 1 };
    const cards = [
      { ...f.card, id: 'color-card', code: 'SC-COLOR', batchId: f.batch.id },
      { ...f.card, id: 'yardage-card', code: 'SC-YARDAGE', batchId: secondBatch.id,
        unit: '米', receiptSnapshot: { ...f.card.receiptSnapshot, batchId: secondBatch.id, sampleType: 'yardage', physicalUnit: '米' } },
    ];
    (f.tx.sampleBatch as any) = { findMany: vi.fn(async () => [f.batch, secondBatch]) };
    f.tx.sampleCardItem.findMany.mockResolvedValue(cards as any);
    (f.tx.auditLog.findMany as any).mockImplementation(async ({ where }: any) => {
      const card = cards.find(row => row.id === where.targetId)!;
      return [{ operationType: 'create', detail: { source: 'development:sample-return', after: {
        batchId: card.batchId, devCaseId: f.devCase.id, unit: card.unit, code: card.code, quantity: card.quantity, receiptSnapshot: card.receiptSnapshot,
      } } }];
    });

    await expect(linkDevelopmentPhysicalSampleToAsset(f.tx, f.batch, f.devCase, 'asset-shared', 55n)).resolves.toBe('color-card');
    expect(f.tx.sampleBatch.findMany).toHaveBeenCalledWith({ where: { developmentCaseId: f.devCase.id, sampleVersionId: 'version-fabric', deletedAt: null }, orderBy: { id: 'asc' } });
    expect(f.tx.sampleCardItem.update).toHaveBeenCalledTimes(2);
    expect(f.tx.sampleCardItem.create).toBeUndefined();
    expect(f.tx.sampleCardItem.update).toHaveBeenCalledWith({ where: { id: 'yardage-card' }, data: { productAssetId: 'asset-shared', updatedAt: 55n } });
  });

  it('reuses one existing product identity for every shape batch in a fabric version', async () => {
    const f = fixture();
    f.batch.sampleVersionId = 'version-fabric';
    const second = { ...f.batch, id: 'batch-yards', sampleType: 'yardage' };
    const existing = { id: 'asset-shared', mainCategory: 'Fabric', sourceDevelopmentCaseId: f.devCase.id, sourceSampleVersionId: 'version-fabric' };
    (f.tx as any).sampleBatch = { findMany: vi.fn(async () => [f.batch, second]) };
    (f.tx as any).productAsset = { findMany: vi.fn(async () => [existing]) };
    await expect(findDevelopmentFabricVersionAsset(f.tx, f.batch, f.devCase)).resolves.toEqual(existing);
    expect((f.tx as any).productAsset.findMany).toHaveBeenCalledWith({ where: {
      sourceDevelopmentCaseId: f.devCase.id, sourceSampleVersionId: 'version-fabric', deletedAt: null,
    }, orderBy: { id: 'asc' } });
  });

  it('fails closed when a version already points to split product archives', async () => {
    const f = fixture();
    f.batch.sampleVersionId = 'version-fabric';
    (f.tx as any).sampleBatch = { findMany: vi.fn(async () => [f.batch]) };
    (f.tx as any).productAsset = { findMany: vi.fn(async () => [
      { id: 'asset-a', mainCategory: 'Fabric' }, { id: 'asset-b', mainCategory: 'Fabric' },
    ]) };
    await expect(findDevelopmentFabricVersionAsset(f.tx, f.batch, f.devCase)).rejects.toThrow('同一开发版本已关联多个面料产品档案');
  });
});
