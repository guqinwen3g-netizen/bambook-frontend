/** Substitute storage contract only, not actual PG or a conversion/approval
 * proof. Native PG separately verifies actual P2002/savepoint/locks/audit. */
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createDevelopmentAssetWithSku } from '../developmentSkuAllocator';
import { todayLocalKey } from '../../shared/localDate';

const day = () => todayLocalKey().replace(/-/g, '');
const data: any = { id: 'INITIAL-allocator-contract', name: 'Synthetic asset', mainCategory: 'Fabric',
  subCategoryId: 'uncategorized', season: '', cost: null, status: 'Development', updatedAt: 0n };
function storage(rows: Array<{ sku: string }> = []) {
  return { $executeRaw: vi.fn().mockResolvedValue(1), $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    productAsset: { findMany: vi.fn().mockResolvedValue(rows), create: vi.fn().mockImplementation(async ({ data }) => ({ ...data })) } };
}
const duplicate = (target: string[] = ['sku']) => new Prisma.PrismaClientKnownRequestError('Synthetic precise storage failure',
  { code: 'P2002', clientVersion: 'synthetic-test', meta: { modelName: 'ProductAsset', target } });
describe('development SKU allocator exact recovery and capacity contract', () => {
  it('first actual free slot respects every occupied SKU and does not filter deleted/category rows', async () => {
    const namespace = `FB-${day()}-`, tx = storage([{ sku: namespace + '0000' }, { sku: namespace + '0002' }]);
    const created = await createDevelopmentAssetWithSku(tx as any, 'FB', data);
    expect(created.sku).toBe(namespace + '0001'); expect(created.id).toBe(data.id);
    expect(tx.productAsset.findMany).toHaveBeenCalledWith({ where: { sku: { startsWith: namespace } }, select: { sku: true } });
    expect(tx.$executeRaw).toHaveBeenCalledOnce(); expect(tx.$executeRawUnsafe.mock.calls.map(call => call[0])).toEqual([
      expect.stringMatching(/^SAVEPOINT development_sku_[a-f0-9]{32}$/), expect.stringMatching(/^RELEASE SAVEPOINT development_sku_[a-f0-9]{32}$/),
    ]);
  });
  it('only actual single-sku P2002 recovers a savepoint and re-reads occupied slots before retry', async () => {
    const namespace = `GR-${day()}-`, tx = storage();
    tx.productAsset.create.mockRejectedValueOnce(duplicate());
    tx.productAsset.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ sku: namespace + '0000' }]);
    const created = await createDevelopmentAssetWithSku(tx as any, 'GR', data);
    expect(created.sku).toBe(namespace + '0001'); expect(tx.productAsset.create).toHaveBeenCalledTimes(2);
    expect(tx.productAsset.findMany).toHaveBeenCalledTimes(2);
    const statements = tx.$executeRawUnsafe.mock.calls.map(call => call[0]);
    expect(statements).toEqual([expect.stringMatching(/^SAVEPOINT /), expect.stringMatching(/^ROLLBACK TO SAVEPOINT /),
      expect.stringMatching(/^RELEASE SAVEPOINT /), expect.stringMatching(/^SAVEPOINT /), expect.stringMatching(/^RELEASE SAVEPOINT /)]);
    expect(statements[0].slice('SAVEPOINT '.length)).toBe(statements[1].slice('ROLLBACK TO SAVEPOINT '.length));
  });
  it.each(['FB', 'GR'] as const)('%s capacity exhaustion is a deliberate finite CONFLICT, never a fake insert or new format', async prefix => {
    const namespace = `${prefix}-${day()}-`, tx = storage(Array.from({ length: 65536 }, (_, slot) => ({ sku: namespace + slot.toString(16).toUpperCase().padStart(4, '0') })));
    await expect(createDevelopmentAssetWithSku(tx as any, prefix, data)).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(tx.productAsset.create).not.toHaveBeenCalled(); expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it.each([{ target: ['id'] }, { target: ['sku', 'id'] }])('actual unique target $target is not the single SKU recovery boundary', async ({ target }) => {
    const tx = storage(), error = duplicate(target); tx.productAsset.create.mockRejectedValueOnce(error);
    await expect(createDevelopmentAssetWithSku(tx as any, 'FB', data)).rejects.toBe(error);
    expect(tx.productAsset.create).toHaveBeenCalledOnce(); expect(tx.$executeRawUnsafe).toHaveBeenCalledOnce();
  });
  it('a same-name/code/metadata fake error cannot enter the native recovery boundary', async () => {
    class PrismaClientKnownRequestError extends Error { code = 'P2002'; meta = { modelName: 'ProductAsset', target: ['sku'] }; }
    const tx = storage(), error = new PrismaClientKnownRequestError('unknown storage failure'); tx.productAsset.create.mockRejectedValueOnce(error);
    await expect(createDevelopmentAssetWithSku(tx as any, 'FB', data)).rejects.toBe(error);
    expect(tx.productAsset.create).toHaveBeenCalledOnce(); expect(tx.$executeRawUnsafe).toHaveBeenCalledOnce();
  });
  it('occupied-query failure propagates before any insert and never invents an empty namespace', async () => {
    const tx = storage(), error = Error('unknown SQL failure'); tx.productAsset.findMany.mockRejectedValueOnce(error);
    await expect(createDevelopmentAssetWithSku(tx as any, 'FB', data)).rejects.toBe(error);
    expect(tx.productAsset.create).not.toHaveBeenCalled(); expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('failed rollback never retries in an aborted transaction', async () => {
    const tx = storage(), error = Error('unknown recovery failure'); tx.productAsset.create.mockRejectedValueOnce(duplicate());
    tx.$executeRawUnsafe.mockResolvedValueOnce(0).mockRejectedValueOnce(error);
    await expect(createDevelopmentAssetWithSku(tx as any, 'FB', data)).rejects.toBe(error);
    expect(tx.productAsset.create).toHaveBeenCalledOnce(); expect(tx.productAsset.findMany).toHaveBeenCalledOnce();
  });
  it('release-savepoint failure cannot acknowledge an insert as committed', async () => {
    const tx = storage(), error = Error('unknown release failure'); tx.$executeRawUnsafe.mockResolvedValueOnce(0).mockRejectedValueOnce(error);
    await expect(createDevelopmentAssetWithSku(tx as any, 'FB', data)).rejects.toBe(error);
    expect(tx.productAsset.create).toHaveBeenCalledOnce();
  });
});

// Execute the actual allocator across the China business-day boundary.
describe('development SKU business day', () => {
  it('uses January 1 at China midnight even when UTC is still December 31', async () => {
    const priorTZ = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T16:00:00Z'));
    try {
      const tx = storage([{ sku: 'FB-20270101-0000' }]);
      const created = await createDevelopmentAssetWithSku(tx as any, 'FB', data);
      expect(created.sku).toBe('FB-20270101-0001');
      expect(tx.productAsset.findMany).toHaveBeenCalledWith({ where: { sku: { startsWith: 'FB-20270101-' } }, select: { sku: true } });
    } finally {
      vi.useRealTimers();
      if (priorTZ === undefined) delete process.env.TZ; else process.env.TZ = priorTZ;
    }
  });
});
