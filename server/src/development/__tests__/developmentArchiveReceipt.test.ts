import { describe, expect, it, vi } from 'vitest';
import { readDevelopmentArchiveReceipt, recordDevelopmentArchiveReceipt } from '../developmentVersionGate';

function fixture() {
  const rows: any[] = [];
  const asset = { id: 'asset-a', sourceDevelopmentCaseId: 'case-1', sourceSampleVersionId: 'minor-a1', deletedAt: null };
  const tx: any = { auditLog: {
    create: vi.fn(async ({ data }: any) => { rows.push(data); return data; }),
    findFirst: vi.fn(async ({ where }: any) => rows.find(row => row.action === where.action
      && row.detail.after.caseId === where.AND[0].detail.equals && row.detail.after.requestKey === where.AND[1].detail.equals) ?? null),
  }, productAsset: { findFirst: vi.fn(async () => asset) } };
  const command: any = { caseId: 'case-1', sampleVersionId: 'minor-a1', sampleBatchId: 'batch-a', sourceType: 'node', sourceId: 'confirmation', actorId: 'sales', requestKey: 'archive-stable' };
  return { tx, command, asset, rows };
}

describe('accurate development archive command receipts', () => {
  it('returns the same asset for a repeated request without creating a new command receipt', async () => {
    const f = fixture();
    const receipt = await recordDevelopmentArchiveReceipt(f.tx, f.command, f.asset.id);
    expect(receipt).toMatchObject({ requestKey: 'archive-stable', sampleVersionId: 'minor-a1', sourceSampleBatchId: 'batch-a', productAssetId: 'asset-a' });
    expect(await readDevelopmentArchiveReceipt(f.tx, f.command)).toMatchObject({ asset: f.asset, conversionReceipt: receipt });
    expect(f.rows).toHaveLength(1);
  });
  it('rejects the same request key used for another version or actor', async () => {
    const f = fixture(); await recordDevelopmentArchiveReceipt(f.tx, f.command, f.asset.id);
    for (const patch of [{ sampleVersionId: 'major-a' }, { actorId: 'other-sales' }]) {
      await expect(readDevelopmentArchiveReceipt(f.tx, { ...f.command, ...patch })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    }
  });
  it('does not treat an unavailable original asset as a successful replay', async () => {
    const f = fixture(); await recordDevelopmentArchiveReceipt(f.tx, f.command, f.asset.id);
    f.tx.productAsset.findFirst.mockResolvedValue(null);
    await expect(readDevelopmentArchiveReceipt(f.tx, f.command)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
});
