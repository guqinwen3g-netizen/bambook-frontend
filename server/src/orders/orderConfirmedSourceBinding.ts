import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { resolveConfirmedSource } from '../development/convertService';
import { assertFabricAssetEligible } from '../development/fabricAssetEligibility';
import { checkExclusivityForAssets, resolveProductAssets } from '../products/fabricExclusivityService';
import { businessError } from '../shared/errorCodes';
import { assertFrozenSampleConsumerOrigin } from '../samples/sampleConsumerSource';
import { assertManualOrderLineSource } from './manualOrderLineSource';

/** DR-053 §13: this is an explicit historical source selection, not a change
 * to the product, quantity, commercial terms or a production approval. The
 * caller owns source→Order→Line locks and current authority in the same tx. */
export async function orderConfirmedSourceBinding(
  tx: any, order: any, line: any,
  input: { confirmedSourceType: string; confirmedSourceId: string; millRelationId?: string },
  actor: TokenPayload,
) {
  if (!actor?.userId) throw businessError('UNAUTHORIZED', '订单行来源补录需要有效的用户主体。');
  if (line.orderId !== order.id) throw businessError('CONFLICT', '订单行归属已变化，请刷新后重新核对。');
  if (input.confirmedSourceType === 'ManualOrderLine') {
    if (input.confirmedSourceId !== line.id) throw businessError('CONFLICT', '人工规格只能消费本订单的同一真实行，不能借其他行。');
    const source = await assertManualOrderLineSource(tx, line.id, order.id);
    if (input.millRelationId && source.factoryRelationId !== input.millRelationId) throw businessError('MILL_MISMATCH', '人工规格实际工厂与所选工厂不一致。');
    return { productAssetId: '', productName: line.description ?? null, millName: source.factory.name,
      millRelationId: source.factoryRelationId, sourceCode: line.id, specSnapshot: source.specSnapshot };
  }
  if (order.millRelationId && input.millRelationId && order.millRelationId !== input.millRelationId)
    throw businessError('MILL_MISMATCH', '所选工厂与订单的真实归属工厂不一致。');
  const confirmed = await resolveConfirmedSource({
    prisma: tx as PrismaClient, caseId: order.sourceCaseId ?? undefined,
    confirmedSourceType: input.confirmedSourceType, confirmedSourceId: input.confirmedSourceId,
    millRelationId: order.millRelationId ?? input.millRelationId,
  });
  if (!confirmed.ok) throw businessError(confirmed.error.code, confirmed.error.message);
  const result = confirmed.data;
  if (input.confirmedSourceType === 'Sample' && line.confirmedSourceType === 'Sample'
    && line.confirmedSourceId === input.confirmedSourceId) {
    assertFrozenSampleConsumerOrigin((result.specSnapshot.sampleOriginProof as any) ?? null,
      line.specSnapshot?.sampleOriginProof);
  }
  const category = String(result.specSnapshot.mainCategory ?? '').toLowerCase();
  const orderType = String(order.type ?? '').toLowerCase();
  if (['fabric', 'garment'].includes(orderType) && category !== orderType)
    throw businessError('CONFLICT', '确认成果的真实商品类型与订单不一致。');
  if (order.millRelationId && result.millRelationId && order.millRelationId !== result.millRelationId)
    throw businessError('MILL_MISMATCH', '确认成果与订单的真实归属工厂不一致。');

  let sourceCaseId: string | null = null;
  let sourceCustomerId: string | null = null;
  if (input.confirmedSourceType === 'SealSample') {
    const seal = await tx.sealSample.findFirst({ where: { id: input.confirmedSourceId, deletedAt: null } });
    sourceCaseId = seal?.developmentCaseId ?? null; sourceCustomerId = seal?.customerRelationId ?? null;
  } else if (input.confirmedSourceType === 'Sample') {
    const sample = await tx.sample.findFirst({ where: { id: input.confirmedSourceId, deletedAt: null } });
    if (sample?.sourceOrderId && sample.sourceOrderId !== order.id)
      throw businessError('CONFLICT', '确认样品属于另一订单，不能补录到本订单行。');
    sourceCaseId = sample?.sourceCaseId ?? null; sourceCustomerId = sample?.customerRelationId ?? null;
  } else if (['fabric', 'garment'].includes(category)) {
    const eligibility = await assertFabricAssetEligible(tx, result.productAssetId);
    sourceCaseId = eligibility.source?.caseId ?? null;
  }
  if (order.sourceCaseId && sourceCaseId && order.sourceCaseId !== sourceCaseId)
    throw businessError('CONFIRMED_SOURCE_NOT_FOUND', '确认成果不属于订单的真实来源开发案。');
  if (sourceCaseId) {
    const sourceCase = await tx.developmentCase.findFirst({ where: { id: sourceCaseId, deletedAt: null }, select: { customerRelationId: true } });
    if (!sourceCase) throw businessError('CONFIRMED_SOURCE_NOT_FOUND', '确认成果的开发案来源已不存在或不可用。');
    if (order.customerRelationId && sourceCase.customerRelationId && order.customerRelationId !== sourceCase.customerRelationId)
      throw businessError('CONFLICT', '确认成果开发案的真实客户与订单不一致。');
  }
  if (order.customerRelationId && sourceCustomerId && order.customerRelationId !== sourceCustomerId)
    throw businessError('CONFLICT', '确认成果的真实客户与订单不一致。');

  // Entity references may contain old text because the legacy sync used the
  // materialCode as targetId. Only live, actually resolved ProductAsset IDs
  // establish an anchor; an unmapped description never establishes one.
  const references = await tx.entityReference.findMany({ where: {
    ownerType: 'orderLine', ownerId: line.id, fieldKey: 'materialCode', targetType: 'product', status: 'active', deletedAt: null,
  }, select: { targetId: true } });
  if (references.length) {
    const anchors = await tx.productAsset.findMany({ where: { id: { in: references.map((reference: any) => reference.targetId) }, deletedAt: null }, select: { id: true } });
    if (anchors.some((asset: any) => asset.id !== result.productAssetId))
      throw businessError('CONFLICT', '订单行已有另一真实商品关联，不能改绑无关的确认成果。');
  }
  if (line.materialCode || line.millQuality) {
    const mapped = await resolveProductAssets(tx, {
      productAssetId: line.materialCode, sku: line.materialCode, clientCode: line.materialCode,
      millQuality: line.millQuality, clientCodeCustomerHint: order.customerRelationId,
      clientCodeGlobalFallback: false,
    });
    if (mapped.some(asset => asset.id !== result.productAssetId))
      throw businessError('CONFLICT', '订单行的真实客户品号或商品映射与所选成果不一致。');
  }
  if (category === 'fabric') {
    const violations = await checkExclusivityForAssets(tx, [result.productAssetId], { customerRelationId: order.customerRelationId ?? null });
    if (violations.length) throw businessError('EXCLUSIVE_FABRIC_BLOCKED', '所选面料为其他客户的专属档案，不能用于本订单。');
  }
  return result;
}
