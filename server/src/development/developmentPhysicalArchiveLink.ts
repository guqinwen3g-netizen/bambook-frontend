import { sampleOriginFingerprint, snapshotSampleOrigin } from '../samples/sampleOriginService';
import { readBatchReceiptSnapshot } from '../samples/sampleBatchReceipt';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { createHash } from 'node:crypto';

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** Resolve the one product identity already assigned to an exact fabric
 * development version. Physical form batches remain separate inventory rows,
 * but they must share this identity after productization. */
export async function findDevelopmentFabricVersionAsset(tx: any, batch: any, devCase: any, sampleVersionId = batch?.sampleVersionId) {
  if (!sampleVersionId) return null;
  const assets = await tx.productAsset.findMany({
    where: {
      sourceDevelopmentCaseId: devCase.id, sourceSampleVersionId: sampleVersionId, deletedAt: null,
    },
    orderBy: { id: 'asc' },
  });
  if (assets.length > 1) throw new DevelopmentDomainError('CONFLICT', '同一开发版本已关联多个面料产品档案，需先人工核对历史档案');
  const asset = assets[0] ?? null;
  if (asset && asset.mainCategory !== 'Fabric') throw new DevelopmentDomainError('CONFLICT', '该开发版本已关联非面料产品档案，不能复用');
  return asset;
}

/** Link the one Development-created physical record to the archive produced
 * from that exact returned version. This runs inside the archive transaction. */
export async function linkDevelopmentPhysicalSampleToAsset(tx: any, batch: any, devCase: any, assetId: string, now: bigint, options?: { referenceOnly?: boolean }) {
  return (await linkDevelopmentPhysicalSamplesToAsset(tx, batch, devCase, assetId, now, options)).physicalCardId;
}

/** Dotted design versions retain the original piece's product identity. Their
 * product archive records these references, never new stock or a replacement. */
export async function linkDevelopmentPhysicalSamplesToAsset(tx: any, batch: any, devCase: any, assetId: string, now: bigint, options: { referenceOnly?: boolean } = {}) {
  const versionBatches = batch.sampleVersionId
    ? await tx.sampleBatch.findMany({ where: { developmentCaseId: devCase.id, sampleVersionId: batch.sampleVersionId, deletedAt: null }, orderBy: { id: 'asc' } })
    : [batch];
  const batches = [...new Map([...versionBatches, batch].map((row: any) => [String(row.id), row])).values()];
  const batchById = new Map(batches.map((row: any) => [String(row.id), row]));
  const cards = await tx.sampleCardItem.findMany({ where: { batchId: { in: batches.map((row: any) => row.id) }, devCaseId: devCase.id, deletedAt: null }, orderBy: { id: 'asc' } });
  if (!cards.length) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '该版本尚无开发登记的实物样，不能转档');

  const cardsByBatch = new Map<string, any[]>();
  for (const card of cards) {
    const sourceBatch = batchById.get(String(card.batchId));
    if (!sourceBatch) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '版本关联实物指向未知批次，不能转档');
    const receipt = readBatchReceiptSnapshot(card.receiptSnapshot);
    const expectedFingerprint = sampleOriginFingerprint(snapshotSampleOrigin(sourceBatch, devCase));
    if (!receipt || receipt.batchId !== sourceBatch.id || receipt.developmentCaseId !== devCase.id
      || receipt.sourceRound !== sourceBatch.round || receipt.factoryId !== sourceBatch.supplierRelationId
      || receipt.sampleType !== sourceBatch.sampleType || receipt.sourceFingerprint !== expectedFingerprint
      || receipt.cardType !== card.cardType || receipt.physicalUnit !== card.unit) {
      throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '版本关联实物的来源快照与当前版本不一致，不能转档');
    }
    const batchCards = cardsByBatch.get(sourceBatch.id) ?? [];
    batchCards.push(card);
    cardsByBatch.set(sourceBatch.id, batchCards);

    const audits = await tx.auditLog.findMany({ where: { action: 'sample_card_create', targetType: 'SampleCardItem', targetId: card.id } });
    const audit = audits.length === 1 ? audits[0] : null;
    const after = audit?.detail?.after;
    if (!audit || audit.operationType !== 'create' || audit.detail?.source !== 'development:sample-return'
      || after?.batchId !== sourceBatch.id || after?.devCaseId !== devCase.id || after?.unit !== card.unit
      || after?.code !== card.code || after?.quantity !== card.quantity
      || createHash('sha256').update(JSON.stringify(canonical(after.receiptSnapshot))).digest('hex')
        !== createHash('sha256').update(JSON.stringify(canonical(card.receiptSnapshot))).digest('hex')) {
      throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '版本关联实物缺少一致的创建审计，不能转档');
    }
    if (!options.referenceOnly && card.productAssetId && card.productAssetId !== assetId) {
      throw new DevelopmentDomainError('CONFLICT', '该实物已关联其他产品档案，不能覆盖原关联');
    }
  }

  // A garment major version can contain several individually coded physical
  // pieces. Require the whole returned set before sharing one product identity.
  for (const [batchId, batchCards] of cardsByBatch) {
    const sourceBatch = batchById.get(batchId)!;
    if (sourceBatch.sampleType !== 'garment-round') continue;
    const snapshots = batchCards.map((card: any) => readBatchReceiptSnapshot(card.receiptSnapshot));
    const count = snapshots[0]?.physicalItemCount;
    const indices = snapshots.map((snapshot: any) => snapshot?.physicalItemIndex);
    if (!Number.isSafeInteger(count) || count !== batchCards.length || snapshots.some((snapshot: any) => snapshot?.physicalItemCount !== count)
      || new Set(indices).size !== count || indices.some((index: any) => !Number.isSafeInteger(index) || index < 1 || index > count)) {
      throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '该成衣版本缺少完整逐件实物登记，不能转档');
    }
  }

  for (const card of cards) {
    if (options.referenceOnly) continue;
    if (card.productAssetId === assetId) continue;
    await tx.sampleCardItem.update({ where: { id: card.id }, data: { productAssetId: assetId, updatedAt: now } });
  }
  return { physicalCardId: cards[0].id as string, physicalCardIds: cards.map((card: any) => String(card.id)) };
}
