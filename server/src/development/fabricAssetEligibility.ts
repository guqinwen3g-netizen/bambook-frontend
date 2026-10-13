import { Prisma } from '@prisma/client';
import { assertFabricSealEligible } from './fabricBatchHistory';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { sampleOriginLockHints } from '../samples/sampleOriginService';
import { sampleConsumerOriginProof, type SampleConsumerOriginProof } from '../samples/sampleConsumerSource';
import { assertDevelopmentVersionReadyForConsumption, type ExactDevelopmentVersionProof } from './developmentVersionGate';
import { assertManualOrderLineSource } from '../orders/manualOrderLineSource';

type Source = { caseId: string; kind: 'batch' | 'seal'; id: string; auditId: string; sampleVersionId?: string; physicalBatchId?: string };
export type ConfirmedFabricSource = { type: string | null; id: string | null };
export type FailedFabricSource = ConfirmedFabricSource & { reason: string };
const reject = (message: string): never => { throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', message); };
const key = (value: unknown) => JSON.stringify(value);
const unique = (ids: Array<string | null | undefined>) => [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id))].sort();

/** Historical conversion audits anchor old asset IDs even after the batch's
 * current conversion pointer changes. Labels/sourceDetail are not provenance. */
async function provenance(db: any, assetId: string): Promise<{ source: Source | null; batchIds: string[] }> {
  const asset = await db.productAsset.findUnique({ where: { id: assetId } });
  if (asset?.sourceSampleVersionId) {
    if (!asset.sourceDevelopmentCaseId || !asset.sourceSampleBatchId || asset.deletedAt != null
      || !['fabric', 'garment'].includes(String(asset.mainCategory).toLowerCase())) reject('准确开发档案的案、版本或原实物关联不完整');
    const family = String(asset.mainCategory).toLowerCase();
    const audits = await db.auditLog.findMany({ where: { action: `convert_${family}_to_asset`, targetType: 'ProductAsset', targetId: assetId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const matching = audits.filter((row: any) => row.actorId && row.detail?.source === `route:dev:${family}-convert-asset`
      && row.detail?.after?.fromCase === asset.sourceDevelopmentCaseId && row.detail?.after?.sourceSampleVersionId === asset.sourceSampleVersionId);
    if (!matching.length || matching.length !== audits.length) reject('准确开发档案缺少一致的原生版本转档审计');
    const original = matching.find((row: any) => row.detail.after.qualityReviewId === asset.sourceSpecSnapshot?.qualityReviewId);
    if (!original) reject('准确开发档案的原正式 QC 来源未能核验');
    const after = original.detail.after;
    const batchId = family === 'garment' ? after.sourceRoundId : after.sourceType === 'batch' ? after.sourceId : asset.sourceSampleBatchId;
    if (batchId !== asset.sourceSampleBatchId || !after.qualityReviewId
      || !['batch', 'seal', 'node'].includes(after.sourceType)) reject('准确开发档案的原实物批次与转档审计不一致');
    return { source: { caseId: asset.sourceDevelopmentCaseId, kind: 'batch', id: asset.sourceSampleBatchId,
      physicalBatchId: asset.sourceSampleBatchId, sampleVersionId: asset.sourceSampleVersionId, auditId: original.id }, batchIds: [asset.sourceSampleBatchId] };
  }
  if (asset?.sourceDevelopmentCaseId || asset?.sourceSampleBatchId) reject('历史开发档案未记录准确版本，保留原档案与审计，不能按旧认可推算新下单依据');
  if (String(asset?.mainCategory).toLowerCase() === 'garment') {
    const [audits, cases] = await Promise.all([
      db.auditLog.findMany({ where: { action: 'convert_garment_to_asset', targetType: 'ProductAsset', targetId: assetId } }),
      db.developmentCase.findMany({ where: { type: 'garment', productAssetId: assetId } }),
    ]);
    if (audits.length || cases.length) reject('历史成衣档案缺少准确开发版本，不能用旧 QC 或确认日志恢复新消费门禁');
    return { source: null, batchIds: [] };
  }
  const [audits, batches, seals, cases] = await Promise.all([
    db.auditLog.findMany({ where: { action: 'convert_fabric_to_asset', targetType: 'ProductAsset', targetId: assetId } }),
    db.sampleBatch.findMany({ where: { OR: [{ convertedProductAssetId: assetId },
      { attachments: { path: ['fabricHistory', 'events'], array_contains: [{ kind: 'convert', after: { convertedProductAssetId: assetId } }] } }] } }),
    db.sealSample.findMany({ where: { convertedProductAssetId: assetId } }),
    db.developmentCase.findMany({ where: { type: 'fabric', productAssetId: assetId } }),
  ]);
  if (!audits.length) {
    if (batches.length || seals.length || cases.length) reject('开发档案缺少真实转档审计，请核对原成果后续办');
    return { source: null, batchIds: [] }; // Legitimate independent/manual asset.
  }
  if (audits.length !== 1) reject('档案转档来源不唯一，请核对原转档记录');
  const audit = audits[0], after = audit.detail?.after;
  if (audit.detail?.source !== 'route:dev:fabric-convert-asset' || !audit.actorId
    || !after?.fromCase || !after.sourceId || !['batch', 'seal'].includes(after.sourceType)) reject('档案转档审计来源不完整，请核对原成果');
  const source: Source = { caseId: after.fromCase, kind: after.sourceType, id: after.sourceId, auditId: audit.id };
  if (batches.some((row: any) => row.developmentCaseId !== source.caseId || (source.kind === 'batch' && row.id !== source.id))
    || seals.some((row: any) => source.kind !== 'seal' || row.id !== source.id || row.developmentCaseId !== source.caseId)
    || cases.some((row: any) => row.id !== source.caseId)) reject('档案的转档审计与反向来源不一致');
  const links = source.kind === 'seal' ? await db.sealSampleBatch.findMany({ where: { sealSampleId: source.id } }) : [];
  return { source, batchIds: source.kind === 'batch' ? [source.id] : unique(links.map((link: any) => link.sampleBatchId)) };
}

/** Pure current eligibility. Historical approval/conversion facts are retained. */
export async function assertFabricAssetEligible(db: any, assetId: string): Promise<{ source: Source | null; factoryRelationId?: string | null; exactDevelopmentVersionProof?: ExactDevelopmentVersionProof }> {
  const { source } = await provenance(db, assetId);
  const asset = await db.productAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.deletedAt != null) reject('产品档案已不可用，请核对当前来源');
  if (!source) return { source };
  if (source.sampleVersionId) {
    const current = await assertDevelopmentVersionReadyForConsumption(db, source.caseId, source.sampleVersionId);
    if (current.physicalVersion.id !== (current.version.versionKind === 'minor' ? current.version.parentVersionId : current.version.id)
      || String(asset.mainCategory).toLowerCase() !== current.development.type)
      reject('准确档案的业务类别或原实物版本已变化');
    const originalBatch = await db.sampleBatch.findFirst({ where: { id: asset.sourceSampleBatchId,
      developmentCaseId: source.caseId, sampleVersionId: current.physicalVersion.id, deletedAt: null } });
    if (!originalBatch || originalBatch.supplierRelationId !== current.version.supplierRelationId)
      reject('准确档案的原返样批次或工厂来源已变化');
    return { source, factoryRelationId: current.version.supplierRelationId, exactDevelopmentVersionProof: current.exactDevelopmentVersionProof };
  }
  return reject('历史开发转档未记录准确版本，保留原成果与审计；新下单或生产不能以旧标量或旧认可日志代替准确双门禁');
}

async function sourceHints(db: any, inputs: ConfirmedFabricSource[]) {
  const assets: string[] = [], cases: string[] = [], seals: string[] = [], samples: string[] = [], orders: string[] = [];
  const anchors: unknown[] = [];
  for (const input of inputs) {
    if (!input.id || !input.type) continue;
    if (input.type === 'Asset') assets.push(input.id);
    else if (input.type === 'ManualOrderLine') {
      const line = await db.orderLine.findUnique({ where: { id: input.id } });
      if (!line || line.confirmedSourceType !== input.type || line.confirmedSourceId !== input.id) reject('人工订单行的准确来源身份缺失。');
      orders.push(line.orderId);
      anchors.push([input.type, input.id, line.orderId, line.specSnapshot]);
    }
    else if (input.type === 'SealSample') {
      const seal = await db.sealSample.findFirst({ where: { id: input.id, deletedAt: null } });
      anchors.push([input.type, input.id, seal?.developmentCaseId ?? null, seal?.convertedProductAssetId ?? null]);
      if (seal) { cases.push(seal.developmentCaseId); seals.push(seal.id); if (seal.convertedProductAssetId) assets.push(seal.convertedProductAssetId); }
    } else if (input.type === 'Sample') {
      const sample = await db.sample.findFirst({ where: { id: input.id, deletedAt: null } });
      anchors.push([input.type, input.id, sample?.sourceCaseId ?? null, sample?.productAssetId ?? null, sample?.sourceOrderId ?? null]);
      if (sample) { if (sample.sourceCaseId) cases.push(sample.sourceCaseId); samples.push(sample.id); if (sample.productAssetId) assets.push(sample.productAssetId); }
      if (sample?.sourceOrderId) orders.push(sample.sourceOrderId);
    }
  }
  const batches: string[] = [];
  if (samples.length) {
    const originParents = await sampleOriginLockHints(db, unique(samples));
    cases.push(...originParents.caseIds); seals.push(...originParents.sealIds); batches.push(...originParents.batchIds);
    const bindings = await db.sampleSource.findMany({ where: { sampleId: { in: unique(samples) } }, orderBy: { id: 'asc' } });
    // Include the immutable relation proof, not only parent IDs: replacing a
    // round/version/audit on the same parent set must also fail the reread.
    anchors.push(['sample-origins', JSON.parse(JSON.stringify(bindings, (_key, value) => typeof value === 'bigint' ? String(value) : value))]);
  }
  for (const assetId of unique(assets)) {
    const found = await provenance(db, assetId);
    anchors.push([assetId, found.source, found.batchIds]);
    if (found.source) { cases.push(found.source.caseId); if (found.source.kind === 'seal') seals.push(found.source.id); }
    batches.push(...found.batchIds);
  }
  // A seal can be selected before conversion; lock its real component batches too.
  for (const sealId of unique(seals)) {
    const links = await db.sealSampleBatch.findMany({ where: { sealSampleId: sealId } });
    const ids = unique(links.map((link: any) => link.sampleBatchId));
    anchors.push(['seal-batches', sealId, ids]); batches.push(...ids);
  }
  return { cases: unique(cases), seals: unique(seals), samples: unique(samples), batches: unique(batches), orders: unique(orders), assets: unique(assets), anchors };
}

type SourceLockOptions = { orderIds?: string[] };

/** Must precede Order/OrderLine/ReleaseScope locks. Hints are never permission:
 * lock native development parents first, then re-read the exact source set. */
export async function lockConfirmedFabricSources(tx: any, inputs: ConfirmedFabricSource[], options: SourceLockOptions = {}): Promise<void> {
  const before = await sourceHints(tx, inputs);
  for (const id of before.cases) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${id} FOR UPDATE`);
  for (const id of before.seals) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SealSample" WHERE "id"=${id} FOR UPDATE`);
  for (const id of before.batches) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id"=${id} FOR UPDATE`);
  for (const id of unique([...before.orders, ...(options.orderIds ?? [])])) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${id} FOR UPDATE`);
  for (const id of before.assets) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductAsset" WHERE "id"=${id} FOR UPDATE`);
  for (const id of before.samples) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id"=${id} FOR UPDATE`);
  if (key(before) !== key(await sourceHints(tx, inputs))) throw new DevelopmentDomainError('CONFLICT', '档案来源在锁定时发生变化，请保留原请求并刷新重试');
}

/** Release aggregation may isolate a known malformed source, but must still
 * lock every other actual source in one globally sorted parent set. A failed
 * input remains denied for this command even if a later read looks repaired.
 * SQL/dependency errors are never converted into an absent or isolated source. */
export async function lockConfirmedFabricSourcesIsolated(tx: any, inputs: ConfirmedFabricSource[], options: SourceLockOptions = {}): Promise<FailedFabricSource[]> {
  const successful: Array<{ input: ConfirmedFabricSource; hints: Awaited<ReturnType<typeof sourceHints>> }> = [];
  const failed: FailedFabricSource[] = [];
  const distinct = [...new Map(inputs.map(input => [key([input.type, input.id]), input])).values()];
  for (const input of distinct) {
    try { successful.push({ input, hints: await sourceHints(tx, [input]) }); }
    catch (error) {
      if (!(error instanceof DevelopmentDomainError) || error.code === 'CONFLICT') throw error;
      failed.push({ ...input, reason: error.message });
    }
  }
  const hints = successful.map(value => value.hints);
  for (const id of unique(hints.flatMap(value => value.cases))) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${id} FOR UPDATE`);
  for (const id of unique(hints.flatMap(value => value.seals))) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SealSample" WHERE "id"=${id} FOR UPDATE`);
  for (const id of unique(hints.flatMap(value => value.batches))) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id"=${id} FOR UPDATE`);
  for (const id of unique([...hints.flatMap(value => value.orders), ...(options.orderIds ?? [])])) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${id} FOR UPDATE`);
  for (const id of unique(hints.flatMap(value => value.assets))) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductAsset" WHERE "id"=${id} FOR UPDATE`);
  for (const id of unique(hints.flatMap(value => value.samples))) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id"=${id} FOR UPDATE`);
  for (const { input, hints: before } of successful) {
    let after;
    try { after = await sourceHints(tx, [input]); }
    catch (error) {
      if (!(error instanceof DevelopmentDomainError)) throw error;
      throw new DevelopmentDomainError('CONFLICT', '档案来源在锁定时发生变化，请保留原请求并刷新重试');
    }
    if (key(before) !== key(after)) throw new DevelopmentDomainError('CONFLICT', '档案来源在锁定时发生变化，请保留原请求并刷新重试');
  }
  return failed;
}

/** Source IDs in a scope must be resolved from actual records, not notes/SKU. */
export async function assertConfirmedFabricSourceEligible(db: any, input: ConfirmedFabricSource): Promise<{ factoryRelationId?: string | null; sampleOriginProof?: SampleConsumerOriginProof | null; exactDevelopmentVersionProof?: ExactDevelopmentVersionProof }> {
  if (!input.type && !input.id) return {};
  if (!input.type || !input.id) return reject('确认成果来源不完整，请核对原订单行');
  if (input.type === 'ManualOrderLine') return { factoryRelationId: (await assertManualOrderLineSource(db, input.id)).factoryRelationId };
  if (input.type === 'Asset') return assertFabricAssetEligible(db, input.id);
  if (input.type === 'SealSample') {
    const seal = await db.sealSample.findFirst({ where: { id: input.id, deletedAt: null } });
    if (!seal || !['sealed', 'converted'].includes(seal.status)) reject('确认封样已不可用');
    const devCase = await db.developmentCase.findFirst({ where: { id: seal.developmentCaseId, deletedAt: null } });
    if (!devCase) reject('确认封样的开发来源已不可用');
    if (devCase.type === 'fabric') await assertFabricSealEligible(db, seal);
    const asset = seal.convertedProductAssetId ? await assertFabricAssetEligible(db, seal.convertedProductAssetId) : {};
    return { ...asset, factoryRelationId: seal.supplierRelationId ?? null };
  }
  if (input.type === 'Sample') {
    const sample = await db.sample.findFirst({ where: { id: input.id, deletedAt: null } });
    if (!sample || ['revising', 'rejected'].includes(sample.status)) reject('确认样品已失效，请核对当前样品');
    const sampleOriginProof = await sampleConsumerOriginProof(db, sample);
    const asset = sample.productAssetId ? await assertFabricAssetEligible(db, sample.productAssetId) : null;
    if (sample.sourceCaseId) {
      const bindings = await db.sampleSource.findMany({ where: { sampleId: sample.id } });
      if (!asset?.exactDevelopmentVersionProof || !bindings.length || bindings.some((binding: any) =>
        (binding.sourceSnapshot?.batch?.selectedSampleVersionId ?? binding.sourceSnapshot?.batch?.sampleVersionId) !== asset.exactDevelopmentVersionProof?.sampleVersionId))
        reject('确认样品与准确产品版本的原生来源不一致，不能借同案档案用于新生产');
    }
    return { ...(asset ?? {}), factoryRelationId: sample.supplierRelationId ?? null, sampleOriginProof };
  }
  return reject('确认成果类型无法核验，请核对原订单行');
}
