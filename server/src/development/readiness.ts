import { DevelopmentDomainError } from './developmentOperationalGuard';
import { assertFabricAssetEligible } from './fabricAssetEligibility';

/** Current sample permission is separate from retained asset/seal history. */
export async function assertFabricDevelopmentReady(db: any, devCase: any, assetId?: string): Promise<void> {
  if (devCase.type !== 'fabric') return;
  if (assetId) {
    const asset = await db.productAsset.findUnique({ where: { id: assetId } });
    if (asset?.sourceSampleVersionId) {
      const current = await assertFabricAssetEligible(db, assetId);
      if (current.source?.caseId !== devCase.id) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '准确档案不属于当前开发案');
      return;
    }
  } else {
    const exactAssets = await db.productAsset.findMany({ where: { sourceDevelopmentCaseId: devCase.id,
      sourceSampleVersionId: { not: null }, deletedAt: null }, orderBy: { id: 'asc' } });
    for (const asset of exactAssets) {
      try { await assertFabricAssetEligible(db, asset.id); return; }
      catch (error) { if (!(error instanceof DevelopmentDomainError) || !['DEVELOPMENT_NOT_READY', 'QC_PASS_REQUIRED'].includes(error.code)) throw error; }
    }
  }
  throw new DevelopmentDomainError('DEVELOPMENT_NOT_READY', '开发尚无准确版本正式 QC 与实际需求方确认均有效的产品档案；旧认可及版本不明的历史记录只读保留');
}
