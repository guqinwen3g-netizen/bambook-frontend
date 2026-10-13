import { describe, expect, it, vi } from 'vitest';
import { buildActualMoqLines, hashMoqBasis } from '../moqApprovalBasis';
describe('MOQ exact source fingerprint', () => {
  it('preserves canonical equality but binds actual quantity and source identity', () => {
    const before = { lines: [{ quantity: '100', unit: 'M', productAssetId: 'asset-a' }], customerRelationId: null };
    expect(hashMoqBasis(before)).toBe(hashMoqBasis({ customerRelationId: null, lines: [{ productAssetId: 'asset-a', unit: 'M', quantity: '100' }] }));
    expect(hashMoqBasis(before)).not.toBe(hashMoqBasis({ ...before, lines: [{ ...before.lines[0], quantity: '99' }] }));
    expect(hashMoqBasis(before)).not.toBe(hashMoqBasis({ ...before, lines: [{ ...before.lines[0], productAssetId: 'asset-b' }] }));
  });
  it('wraps asynchronous SKU-source read failure instead of leaking storage details', async () => {
    const db = { productAsset: { findMany: vi.fn().mockRejectedValue(new Error('PRIVATE_SQL_BYTES')) } };
    await expect(buildActualMoqLines(db, [{ quantity: '100', unit: 'M', fabricCode: 'real-sku' }])).rejects.toMatchObject({ code: 'MOQ_SOURCE_UNAVAILABLE', message: 'MOQ 实际商品来源暂时无法核验' });
  });
});
