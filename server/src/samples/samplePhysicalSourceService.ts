import { Prisma } from '@prisma/client';
import { resolveSampleBusinessContext } from './sampleBusinessContext';

export type PhysicalSampleSourceInput = {
  warehouseId?: string | null; devCaseId?: string | null; orderId?: string | null;
  productAssetId?: string | null; sampleId?: string | null; batchId?: string | null;
};

export class PhysicalSampleSourceError extends Error {
  readonly status: number;
  constructor(readonly code: 'VALIDATION_FAILED' | 'CONFLICT' | 'SOURCE_CHANGED', message: string) {
    super(message);
    this.status = code === 'VALIDATION_FAILED' ? 400 : 409;
  }
}

const reject = (code: PhysicalSampleSourceError['code'], message: string): never => { throw new PhysicalSampleSourceError(code, message); };
const reference = (value: unknown): string | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return reject('VALIDATION_FAILED', '实物来源编号须为字符串');
  return value.trim() || null;
};
const live = (row: any) => row && row.deletedAt == null;
const unique = (values: Array<string | null>) => [...new Set(values.filter((id): id is string => id !== null))].sort();

/** Current ownership, not design approval or a physical receipt. A card's asset
 * describes the material/catalog item; Sample.productAssetId is its separate
 * business subject. Never classify a card from its material or cardType. */
async function readSources(tx: any, input: PhysicalSampleSourceInput, allowBatch: boolean, extraRelationIds: string[] = []) {
  const warehouseId = reference(input.warehouseId), sampleId = reference(input.sampleId);
  const productAssetId = reference(input.productAssetId), batchId = reference(input.batchId);
  if (batchId && !allowBatch) reject('VALIDATION_FAILED', '批次实物须通过开发批次的受控收样登记');
  const sample = sampleId ? await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } }) : null;
  if (sampleId && !live(sample)) reject('VALIDATION_FAILED', '关联样品不存在或已删除');
  const batch = batchId ? await tx.sampleBatch.findUnique({ where: { id: batchId } }) : null;
  if (batchId && !live(batch)) reject('VALIDATION_FAILED', '实物来源批次不存在或已删除');
  const sampleCaseId = reference(sample?.sourceCaseId), sampleOrderId = reference(sample?.sourceOrderId);
  const sampleProductAssetId = reference(sample?.productAssetId);
  const explicitCaseId = reference(input.devCaseId), explicitOrderId = reference(input.orderId);
  if (explicitCaseId && sampleCaseId && explicitCaseId !== sampleCaseId) reject('CONFLICT', '实物开发案与关联样品的真实来源不一致');
  if (explicitOrderId && sampleOrderId && explicitOrderId !== sampleOrderId) reject('CONFLICT', '实物订单与关联样品的真实来源不一致');
  let devCaseId = sampleCaseId ?? explicitCaseId;
  const orderId = sampleOrderId ?? explicitOrderId;
  const batchCaseId = reference(batch?.developmentCaseId);
  if (batchId && !batchCaseId) reject('VALIDATION_FAILED', '实物来源批次缺少开发案归属');
  if (batchCaseId && devCaseId && batchCaseId !== devCaseId) reject('CONFLICT', '实物批次与开发案或样品的真实来源不一致');
  devCaseId ??= batchCaseId;
  const order = orderId ? await tx.order.findUnique({ where: { id: orderId } }) : null;
  if (orderId && !live(order)) reject('VALIDATION_FAILED', '关联大货订单不存在或已删除');
  const orderCaseId = reference(order?.sourceCaseId);
  if (orderCaseId && devCaseId && orderCaseId !== devCaseId) reject('CONFLICT', '实物订单与开发案的真实来源不一致');
  devCaseId ??= orderCaseId;
  const development = devCaseId ? await tx.developmentCase.findUnique({ where: { id: devCaseId } }) : null;
  if (devCaseId && !live(development)) reject('VALIDATION_FAILED', '关联开发案不存在或已删除');
  const assets = new Map<string, any>();
  for (const id of unique([sampleProductAssetId, productAssetId])) {
    const asset = await tx.productAsset.findUnique({ where: { id } });
    if (!live(asset)) reject('VALIDATION_FAILED', '关联数字档案不存在或已删除');
    assets.set(id, asset);
  }
  const warehouse = warehouseId ? await tx.warehouse.findUnique({ where: { id: warehouseId } }) : null;
  if (warehouseId && (!live(warehouse) || warehouse.isActive !== true)) reject('VALIDATION_FAILED', '关联仓库不存在、已删除或已停用');
  // Lock ownership and source factories together before any child. These
  // actual Relation links are identities; suppliers never grant customer access.
  const relationIds = unique([reference(sample?.customerRelationId), reference(sample?.supplierRelationId),
    reference(development?.customerRelationId), reference(development?.supplierRelationId),
    reference(order?.customerRelationId), reference(order?.millRelationId), reference(batch?.supplierRelationId),
    ...extraRelationIds.map(reference)]);
  const relations: any[] = [];
  for (const id of relationIds) {
    const relation = await tx.relation.findUnique({ where: { id } });
    if (!live(relation)) reject('VALIDATION_FAILED', '关联客户或来源工厂不存在或已删除');
    relations.push(relation);
  }
  // Classify only the real business subject. The Card's asset is a material
  // descriptor and must never contribute a business-line vote. Explicit owner
  // links can fill missing Sample parents, but cannot contradict its subject.
  const sampleBusinessContext = sample ? await resolveSampleBusinessContext(tx, {
    sourceCaseId: sampleCaseId, sourceOrderId: sampleOrderId, productAssetId: sampleProductAssetId,
  }) : null;
  if (sampleBusinessContext?.status === 'conflict') reject('CONFLICT', '关联业务样品的开发案、订单或商品档案业务线冲突，请先核对真实来源');
  const ownerBusinessContext = sampleBusinessContext && devCaseId === sampleCaseId && orderId === sampleOrderId
    ? sampleBusinessContext : await resolveSampleBusinessContext(tx, {
      sourceCaseId: devCaseId, sourceOrderId: orderId, productAssetId: sampleProductAssetId,
    });
  if (ownerBusinessContext.status === 'conflict') reject('CONFLICT', '实物关联的开发案、订单或业务样品商品来源业务线冲突');
  // Unresolved live legacy/plain sources remain custody facts, never approvals.
  return { warehouseId, devCaseId, orderId, productAssetId, sampleId, batchId, sampleProductAssetId,
    sample, batch, order, development, assets, warehouse, relations, relationIds, sampleBusinessContext, ownerBusinessContext };
}

function sourceFingerprint(sources: Awaited<ReturnType<typeof readSources>>): string {
  // Only source identity/liveness is stabilized here. Notes, approvals and stock
  // remain independent; no history is inferred from the current source labels.
  return JSON.stringify({
    ids: [sources.warehouseId, sources.devCaseId, sources.orderId, sources.productAssetId, sources.sampleId, sources.batchId],
    sample: sources.sample ? [sources.sample.sourceCaseId ?? null, sources.sample.sourceOrderId ?? null, sources.sample.productAssetId ?? null, sources.sample.deletedAt == null] : null,
    order: sources.order ? [sources.order.sourceCaseId ?? null, sources.order.type ?? null, sources.order.businessLine ?? null, sources.order.deletedAt == null] : null,
    batch: sources.batch ? [sources.batch.developmentCaseId, sources.batch.batchCode, sources.batch.round ?? null, String(sources.batch.updatedAt), sources.batch.deletedAt == null] : null,
    development: sources.development ? [sources.development.id, sources.development.type ?? null, sources.development.deletedAt == null] : null,
    relations: sources.relations.map(row => [row.id, String(row.createdAt ?? ''), row.deletedAt == null, row.ownerId ?? null, row.departmentId ?? null, unique(row.salesRepIds ?? [])]),
    relationIds: sources.relationIds,
    sampleBusinessContext: sources.sampleBusinessContext, ownerBusinessContext: sources.ownerBusinessContext,
    assets: [...sources.assets.keys()].sort().map(id => [id, sources.assets.get(id).deletedAt == null]),
    warehouse: sources.warehouse ? [sources.warehouse.id, sources.warehouse.isActive, sources.warehouse.deletedAt == null] : null,
  });
}

/** Call within the custody write transaction. Discover before locks, acquire
 * parents before Sample/Card, and never chase changed parent IDs after locking
 * a child. Batch usage is for an existing physical card, not manual intake. */
export async function lockPhysicalSampleSources(tx: any, input: PhysicalSampleSourceInput, options: { allowBatch?: boolean; extraRelationIds?: string[] } = {}) {
  if (options.extraRelationIds !== undefined && (!Array.isArray(options.extraRelationIds) || options.extraRelationIds.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim()))) reject('VALIDATION_FAILED', '额外关联主体须为明确编号');
  const before = await readSources(tx, input, options.allowBatch === true, options.extraRelationIds);
  const fingerprint = sourceFingerprint(before);
  for (const id of unique([before.devCaseId])) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${id} FOR UPDATE`);
  for (const id of before.relationIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Relation" WHERE "id" = ${id} FOR UPDATE`);
  if (before.batchId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id" = ${before.batchId} FOR UPDATE`);
  for (const id of unique([before.orderId])) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`);
  for (const id of unique([before.sampleProductAssetId, before.productAssetId])) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductAsset" WHERE "id" = ${id} FOR UPDATE`);
  if (before.warehouseId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Warehouse" WHERE "id" = ${before.warehouseId} FOR UPDATE`);
  if (before.sampleId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id" = ${before.sampleId} FOR UPDATE`);
  let after: typeof before;
  try { after = await readSources(tx, input, options.allowBatch === true, options.extraRelationIds); }
  catch (error) {
    if (error instanceof PhysicalSampleSourceError) reject('SOURCE_CHANGED', '实物来源在锁定期间已变化，请刷新来源后重试');
    throw error;
  }
  if (sourceFingerprint(after) !== fingerprint) reject('SOURCE_CHANGED', '实物来源归属或版本已变化，请刷新后重试');
  const physicalSource = {
    version: 1, sampleId: after.sampleId, devCaseId: after.devCaseId, orderId: after.orderId,
    descriptorProductAssetId: after.productAssetId, sampleProductAssetId: after.sampleProductAssetId,
    batchId: after.batchId,
  };
  return { ...after, physicalSource };
}
