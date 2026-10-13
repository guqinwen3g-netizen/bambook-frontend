import {factoryRelationIdentitySelect,isUsableFactoryRelation} from '../suppliers/factoryRelationIdentity';
import { loadConfirmedDevelopmentSpec } from './confirmedDevelopmentSpec';
import { buildSpecSnapshot } from './developmentSpecSnapshot';
/**
 * ERP-P1-development-convert-to-order-flow-contract
 *
 * convertDevCaseToOrder service（route + Agent flow 共用契约）。
 * Order create/link + DevCase update + syncDevelopmentCaseReferences + syncOrderEntityReferences + AuditLog
 * 同事务闭环，失败 fail closed。
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { syncDevelopmentCaseReferences, syncOrderEntityReferences } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { assertDevelopmentOperationalWrite } from './developmentOperationalGuard';
import { assertFabricDevelopmentReady } from './readiness';
import { httpStatusOfCode } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { parseOrderQuantity } from '../shared/orderQuantitySummary';
import { logger } from '../lib/logger';
import type { TokenPayload } from '../auth/service';
import { assertFabricCurrentWrite, assertFabricSealEligible } from './fabricBatchHistory';
import { assertFabricAssetEligible } from './fabricAssetEligibility';
import { sampleConsumerOriginProof } from '../samples/sampleConsumerSource';
import { isCreditExceptionConsumptionErrorCode, type CreditExceptionConsumptionErrorCode } from '../credit/creditExceptionGate';
import { prepareOrderConversionCommercial, freezeOrderConversionCommercial, consumeOrderConversionCommercial, orderConversionMoqAdvisory } from '../orders/orderConversionCommercial';
import { authorizeDevelopmentConversion, lockExistingConversionOrder, conversionAuthorityRead } from './developmentConversionAuthority';
import { normalizeRequiredSampleFamilies } from '../orders/orderRequiredSampleFamilies';
import { allocateInternalOrderCode, normalizeExternalPoNumber } from '../orders/orderIdentity';
import { assertManualOrderLineSource } from '../orders/manualOrderLineSource';
import { todayLocalKey } from '../shared/localDate';


export type DevConvertErrorCode = CreditExceptionConsumptionErrorCode
  | 'UNAUTHORIZED'
  | 'AUTHORIZATION_UNAVAILABLE'
  | 'FORBIDDEN'
  | 'SOURCE_CHANGED'
  | 'DEVELOPMENT_SOURCE_CHANGED'
  | 'DEV_CASE_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'CASE_CANCELLED'
  | 'INVALID_STAGE'
  | 'ASSET_REQUIRED'
  | 'DEVELOPMENT_NOT_READY'
  | 'CONFIRMED_SOURCE_NOT_FOUND'
  | 'CONFIRMED_SOURCE_NOT_APPROVED'
  | 'MILL_MISMATCH'
  | 'DEVELOPMENT_PAUSED'
  | 'DEVELOPMENT_CLOSED'
  | 'INVALID_LIFECYCLE_STATE'
  | 'CREDIT_FROZEN_60_DAYS'
  | 'CREDIT_REVOKED'
  | 'OVERDUE_60_DAYS'
  | 'CREDIT_BLOCKED'
  | 'CREDIT_CHECK_FAILED'
  | 'EXCEPTION_CONSUME_FAILED'
  | 'CONVERT_FAILED';

export interface DevConvertError {
  code: DevConvertErrorCode;
  message: string;
  existingOrderId?: string;
  approvalRequestId?: string|null;
  blockCode?: string|null;
}

export interface DevConvertParams {
  prisma: PrismaClient;
  caseId: string;
  mode: 'link' | 'autoCreate';
  // link 模式
  orderId?: string;
  orderPo?: string;
  // autoCreate 模式
  customer?: string;
  millName?: string;
  dueDate?: string;
  productName?: string;
  quantity?: number|string;
  quoteAmount?: number;
  // DR-053 阶段 1：确认成果 + 工厂 + 幂等键（详见 §13）
  confirmedSourceType?: string; // 'SealSample' | 'Sample' | 'Asset'
  confirmedSourceId?: string;
  millRelationId?: string;
  clientRequestId?: string;
  // audit
  actorId?: string;
  trustedActor?: TokenPayload;
  /** Server-only command adapter: caller owns the complete business transaction. */
  commandExecution?: {
    tx: Prisma.TransactionClient;
    commercialPrepared: Awaited<ReturnType<typeof prepareOrderConversionCommercial>>;
    moqSnapshot: Parameters<typeof freezeOrderConversionCommercial>[5];
    unit: string;
  };
}

export interface DevConvertResult {
  ok: boolean;
  error?: DevConvertError;
  data?: {
    case: any;
    order: any | null;
    auditId: string;
    recovered?: boolean;
    moqCheck?: unknown; // DR-053 阶段 1：同 clientRequestId 幂等恢复返回已有订单
  };
}

/** 确认来源错误（fail 辅助） */
type ConfirmError = { code: DevConvertErrorCode; message: string; status: number };

/** 从确认成果构建不可变规格快照（面料/成衣同构，关键字段子集；档案后续修改不影响历史订单） */
export { buildSpecSnapshot } from './developmentSpecSnapshot';

/**
 * 解析确认成果（DR-053 阶段 1）：SealSample(封样) / Sample(统一样品) / Asset(直接返单)。
 * 校验链：成果存在且已确认（sealed/approved）→ 归属工厂 === millRelationId（若提供）→ 取档案。
 * 返回统一名称快照 + 规格快照 + 档案 ID。
 */
export async function resolveConfirmedSource(params: {
  prisma: PrismaClient;
  caseId?: string;
  confirmedSourceType?: string;
  confirmedSourceId?: string;
  millRelationId?: string;
}): Promise<{ ok: true; data: { productAssetId: string; productName: string | null; millName: string | null; millRelationId: string | null; sourceCode: string; specSnapshot: Record<string, unknown> } } | { ok: false; error: ConfirmError }> {
  const { prisma, confirmedSourceType, confirmedSourceId, millRelationId, caseId } = params;
  if (!confirmedSourceType || !confirmedSourceId) {
    return { ok: true, data: { productAssetId: '', productName: '', millName: '', millRelationId: '', sourceCode: '', specSnapshot: {} } };
  }
  const type = String(confirmedSourceType);
  const id = String(confirmedSourceId);

  if (type === 'ManualOrderLine') {
    if (caseId) return { ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED', message: '人工订单行来源不能替代开发案的准确版本 QC 与需求方确认。', status: 409 } };
    const manual = await assertManualOrderLineSource(prisma, id);
    return { ok: true, data: { productAssetId: '', productName: manual.line.description ?? null, millName: manual.factory.name,
      millRelationId: manual.factoryRelationId, sourceCode: manual.line.id, specSnapshot: manual.specSnapshot } };
  }

  if (type === 'Asset') {
    // Native development orders consume the exact archived version's current
    // QC and actual demander confirmation; a case scalar is not that proof.
    const asset = await (prisma as any).productAsset.findUnique({
      where: { id },
      include: { fabricProfile: true, garmentProfile: true },
    });
    if (!asset || asset.deletedAt != null) return { ok: false, error: { code: 'CONFIRMED_SOURCE_NOT_FOUND', message: `产品档案 ${id} 不存在`, status: 404 } };
    const category = String(asset.mainCategory ?? '').toLowerCase();
    const eligibility = ['fabric', 'garment'].includes(category) ? await assertFabricAssetEligible(prisma, id) : null;
    if (caseId && (asset.sourceDevelopmentCaseId !== caseId || !asset.sourceSampleVersionId || !eligibility?.exactDevelopmentVersionProof))
      return { ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED', message: '请选择当前开发案的准确版本档案；整案默认档案或无版本历史不能代替本版下单依据。', status: 409 } };
    const fp = category === 'fabric' && asset.fabricProfile?.deletedAt == null ? asset.fabricProfile ?? null : null;
    const gp = category === 'garment' && asset.garmentProfile?.deletedAt == null ? asset.garmentProfile ?? null : null;
    if ((!fp && !gp) || !['fabric', 'garment'].includes(category)) return {ok:false,error:{code:'CONFIRMED_SOURCE_NOT_FOUND',message:'档案当前业务类型及有效规格不可用',status:404}};
    const actualFactoryId = gp?.factoryRelationId ?? fp?.millOrganizationId ?? null;
    const millRelId = millRelationId ?? actualFactoryId;
    const actualFactory = millRelId ? await prisma.relation.findFirst({where:{id:millRelId,deletedAt:null},select:factoryRelationIdentitySelect}) : null;
    if(millRelId && !isUsableFactoryRelation(actualFactory)) return {ok:false,error:{code:'CONFIRMED_SOURCE_NOT_FOUND',message:'档案实际工厂已不可用',status:404}};
    // 直接返单的工厂一致性：若档案已挂工厂且调用方指定了不同工厂 → 拒绝
    if (millRelId && actualFactoryId && String(millRelId) !== String(actualFactoryId)) {
      return { ok: false, error: { code: 'MILL_MISMATCH', message: `产品档案 ${asset.sku} 归属工厂与所选工厂不一致`, status: 409 } };
    }
    return {
      ok: true,
      data: {
        productAssetId: asset.id,
        productName: asset.name,
        millName: actualFactory?.name ?? null,
        millRelationId: millRelId,
        sourceCode: asset.sku,
        specSnapshot: buildSpecSnapshot({...asset, fabricProfile:fp, garmentProfile:gp}, eligibility?.exactDevelopmentVersionProof),
      },
    };
  }

  if (type === 'SealSample') {
    const seal = await prisma.sealSample.findFirst({ where: { id, deletedAt: null } });
    if (!seal || (caseId && seal.developmentCaseId !== caseId)) return { ok: false, error: { code: 'CONFIRMED_SOURCE_NOT_FOUND', message: `封样 ${id} 不存在`, status: 404 } };
    if (!['sealed', 'converted'].includes(seal.status)) {
      return { ok: false, error: { code: 'CONFIRMED_SOURCE_NOT_APPROVED', message: `封样 ${seal.sealCode} 未封样（status=${seal.status}），不可下单`, status: 409 } };
    }
    await assertFabricSealEligible(prisma, seal);
    if (millRelationId && String(millRelationId) !== String(seal.supplierRelationId)) {
      return { ok: false, error: { code: 'MILL_MISMATCH', message: `封样 ${seal.sealCode} 归属工厂与所选工厂不一致`, status: 409 } };
    }
    const assetId = seal.convertedProductAssetId;
    if (!assetId) return { ok: false, error: { code: 'ASSET_REQUIRED', message: `封样 ${seal.sealCode} 尚未转档，无法下单`, status: 409 } };
    const asset = await prisma.productAsset.findUnique({ where: { id: assetId }, include: { fabricProfile: true, garmentProfile: true } });
    if (!asset || asset.deletedAt != null) return { ok: false, error: { code: 'CONFIRMED_SOURCE_NOT_FOUND', message: '封样关联档案已不可用，请核对当前成果', status: 404 } };
    const factory = await prisma.relation.findFirst({ where: { id: seal.supplierRelationId, deletedAt: null }, select:factoryRelationIdentitySelect });
    if(!isUsableFactoryRelation(factory))return {ok:false,error:{code:'CONFIRMED_SOURCE_NOT_FOUND',message:'确认工厂身份已不可用，请核对供应商组织',status:404}};
    return {
      ok: true,
      data: {
        productAssetId: assetId,
        productName: asset.name ?? seal.name ?? null,
        millName: factory?.name ?? null,
        millRelationId: seal.supplierRelationId,
        sourceCode: seal.sealCode,
        specSnapshot: (await loadConfirmedDevelopmentSpec(prisma,{sourceType:'SealSample',sourceId:id,caseId:seal.developmentCaseId??undefined,factoryRelationId:seal.supplierRelationId,productAssetId:assetId})).specSnapshot,
      },
    };
  }

  if (type !== 'Sample') return { ok: false, error: { code: 'INVALID_INPUT', message: '请从已有确认成果中选择有效的来源类型', status: 400 } };
  // Sample（统一样品：seal 确认样 / pp 产前样等）
  const sample = await prisma.sample.findFirst({ where: { id, deletedAt: null } });
  if (!sample || (caseId && sample.sourceCaseId !== caseId)) return { ok: false, error: { code: 'CONFIRMED_SOURCE_NOT_FOUND', message: `样品 ${id} 不存在`, status: 404 } };
  if (!['sealed', 'approved', 'confirmed'].includes(sample.status)) {
    return { ok: false, error: { code: 'CONFIRMED_SOURCE_NOT_APPROVED', message: `样品 ${sample.code} 未确认（status=${sample.status}），不可下单`, status: 409 } };
  }
  if (millRelationId && sample.supplierRelationId && String(millRelationId) !== String(sample.supplierRelationId)) {
    return { ok: false, error: { code: 'MILL_MISMATCH', message: `样品 ${sample.code} 归属工厂与所选工厂不一致`, status: 409 } };
  }
  const sampleOriginProof = await sampleConsumerOriginProof(prisma, sample);
  const assetId = sample.productAssetId;
  if (!assetId) return { ok: false, error: { code: 'ASSET_REQUIRED', message: `样品 ${sample.code} 未关联产品档案，无法下单`, status: 409 } };
  const asset = await prisma.productAsset.findUnique({ where: { id: assetId }, include: { fabricProfile: true, garmentProfile: true } });
  if (!asset || asset.deletedAt != null) return { ok: false, error: { code: 'CONFIRMED_SOURCE_NOT_FOUND', message: '确认样关联档案已不可用，请核对当前成果', status: 404 } };
  const sampleFactory=sample.supplierRelationId?await prisma.relation.findFirst({where:{id:sample.supplierRelationId,deletedAt:null},select:factoryRelationIdentitySelect}):null;
  if(!isUsableFactoryRelation(sampleFactory))return {ok:false,error:{code:'CONFIRMED_SOURCE_NOT_FOUND',message:'确认工厂身份已不可用，请核对供应商组织',status:404}};
  return {
    ok: true,
    data: {
      productAssetId: assetId,
      productName: asset.name ?? null,
      millName: sample.supplierName ?? null,
      millRelationId: sample.supplierRelationId ?? millRelationId ?? null,
      sourceCode: sample.code,
      specSnapshot: (await loadConfirmedDevelopmentSpec(prisma,{sourceType:'Sample',sourceId:id,caseId:sample.sourceCaseId??undefined,factoryRelationId:sample.supplierRelationId??undefined,productAssetId:assetId})).specSnapshot,
    },
  };
}

export async function convertDevCaseToOrder(params: DevConvertParams): Promise<DevConvertResult> {
  const { prisma, caseId, mode, orderId, orderPo, customer, millName, dueDate, productName, quantity, quoteAmount, actorId, confirmedSourceType, confirmedSourceId, millRelationId, clientRequestId, trustedActor } = params;
  const sourceDb = params.commandExecution?.tx ?? prisma;
  const wantAutoCreate = mode === 'autoCreate';

  // 2.5 autoCreate 空心订单防线：数量必填正整数、交期必填 YYYY-MM-DD（金额可选默认 0）
  let validatedQuantity: number|string = 0;
  let validatedDueDate = '';
  let validatedQuoteAmount = 0;
  if (wantAutoCreate) {
    // This is an explicit new bulk-order quantity, never a case sample fallback.
    // Boolean/array/object coercion cannot establish a real order quantity.
    const explicitQuantity: unknown = quantity;
    if(params.commandExecution){
      try{validatedQuantity=parseOrderQuantity(explicitQuantity);}
      catch{return {ok:false,error:{code:'INVALID_INPUT',message:'转大货订单数量须为准确的正十进制（最多四位小数）。'}};}
    }else{
      const qty = typeof explicitQuantity === 'number' || typeof explicitQuantity === 'string' && explicitQuantity.trim() !== '' ? Number(explicitQuantity) : NaN;
      if (!Number.isSafeInteger(qty) || qty <= 0) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: '转大货订单必须填写数量（正整数），不可产出 0 数量空心订单' } };
      }
      validatedQuantity = qty;
    }
    const dd = String(dueDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dd) || Number.isNaN(new Date(dd).getTime())) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: '转大货订单必须填写交期（YYYY-MM-DD）' } };
    }
    validatedDueDate = dd;
    const qa = typeof quoteAmount === 'number' ? quoteAmount : Number(quoteAmount);
    if (quoteAmount != null && (!Number.isFinite(qa) || qa < 0)) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: '订单金额必须是有效的非负数值' } };
    }
    validatedQuoteAmount = quoteAmount != null ? qa : 0;
  }

  // 1. 读 DevelopmentCase（fail closed）
  let existing: any;
  try { existing = (await authorizeDevelopmentConversion(sourceDb, actorId, trustedActor, caseId)).development; }
  catch(error:any) {const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR'});return {ok:false,error:{code:error?.code ?? 'CONVERT_FAILED',message:safe.message}};}
  if (!existing) {
    return { ok: false, error: { code: 'DEV_CASE_NOT_FOUND', message: `Development case ${caseId} not found` } };
  }
  if (existing.stage === 'cancelled') {
    return { ok: false, error: { code: 'CASE_CANCELLED', message: `Cannot convert cancelled case (stage=cancelled)` } };
  }
  // Whole-case stage is retained history. The chosen exact source is checked
  // again under the case lock; another factory/version cannot lend its pass.
  // DR-050/DR-051 强制建档后转：面料/成衣开发案必须已转档案（productAssetId 非空）方可转大货。
  // DR-053 阶段 1：若显式指定确认成果（confirmedSourceType/Id），档案判定改由成果解析覆盖（见 §13）。
  const hasConfirmedSource = Boolean(confirmedSourceType && confirmedSourceId);
  if (!hasConfirmedSource) {
    if (existing.type === 'fabric' && !existing.productAssetId) {
      return { ok: false, error: { code: 'ASSET_REQUIRED', message: '面料开发案须先转面料档案（开发管理详情 → 转档），方可转大货订单' } };
    }
    if (['garment', 'pp', 'trim'].includes(existing.type) && !existing.productAssetId) {
      return { ok: false, error: { code: 'ASSET_REQUIRED', message: '成衣开发案须先转成衣档案（开发管理详情 → 转成衣档案），方可转大货订单' } };
    }
  }

  // 2. link 模式：校验 order 存在
  if (!wantAutoCreate) {
    const finalOrderIdCheck = String(orderId || '').trim();
    if (!finalOrderIdCheck) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'orderId is required for link mode' } };
    }
    let orderExists: {id:string}|null;
    try {orderExists=await conversionAuthorityRead(sourceDb,strict=>strict.order.findUnique({where:{id:finalOrderIdCheck},select:{id:true}}));}
    catch(error) {const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR'});return {ok:false,error:{code:'AUTHORIZATION_UNAVAILABLE',message:safe.message}};}
    if (!orderExists) {
      return { ok: false, error: { code: 'ORDER_NOT_FOUND', message: `Order ${finalOrderIdCheck} not found` } };
    }
  }

  let commercialPrepared: Awaited<ReturnType<typeof prepareOrderConversionCommercial>> | null = null;
  if(wantAutoCreate){try{commercialPrepared=params.commandExecution?.commercialPrepared??await prepareOrderConversionCommercial(prisma,actorId!,existing.customerRelationId??null,validatedQuoteAmount);}catch(error:any){const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR'});return{ok:false,error:{code:error?.code??'CONVERT_FAILED',message:safe.message,...(error?.approvalRequestId?{approvalRequestId:error.approvalRequestId}:{}),...(error?.blockCode?{blockCode:error.blockCode}:{})}};}}

  const now = BigInt(Date.now());
  let finalOrderId = String(orderId || '').trim();
  const finalOrderPo = normalizeExternalPoNumber(orderPo);
  if (wantAutoCreate) {
    const baseTs = Date.now();
    finalOrderId = finalOrderId || `ORD-FROMDEV-${existing.code}-${baseTs}`;
  }

  // 3. 事务闭环
  let createdOrder: any = null;
  let doc: any = null;
  let auditId = '';
  let moqCheck: unknown = null;
  try {
    const transactionBody = async (tx: any) => {
      await assertDevelopmentOperationalWrite(tx, caseId, 'convert');
      const existing = await tx.developmentCase.findFirst({where:{id:caseId,deletedAt:null}});
      const reject = (code:DevConvertErrorCode,message:string,statusCode=httpStatusOfCode(code)):never=>{throw Object.assign(new Error(message),{code,statusCode});};
      if (!existing) reject('DEV_CASE_NOT_FOUND','开发案不存在');
      const conversion = await authorizeDevelopmentConversion(tx, actorId, trustedActor, caseId);
      const sourceFamily = existing.type === 'fabric' ? 'fabric' : ['garment','pp'].includes(existing.type) ? 'garment' : null;
      if (!sourceFamily) reject('DEVELOPMENT_SOURCE_CHANGED','当前开发类型缺少明确转单业务模型，请先核定来源',409);
      if (conversion.development.type !== existing.type) reject('DEVELOPMENT_SOURCE_CHANGED','开发来源已变化');
      if (!wantAutoCreate) {
        const target = await lockExistingConversionOrder(tx, conversion.actor, finalOrderId);
        if ((target.customerRelationId ?? null) !== (existing.customerRelationId ?? null) || String(target.type).toLowerCase() !== sourceFamily) reject('DEVELOPMENT_SOURCE_CHANGED','关联订单与开发案的客户或业务类型不一致',409);
      }
      if (existing.type === 'fabric') await assertFabricCurrentWrite(tx, caseId, actorId || '', trustedActor);
      // Recheck after the case lock: a concurrent request may have committed while we waited.
      if (wantAutoCreate && clientRequestId && !params.commandExecution) {
        const previous = await tx.order.findFirst({ where: { clientRequestId: String(clientRequestId), sourceCaseId: caseId } });
        if (previous) return { doc: existing, createdOrder: previous, recovered: true };
      }
      if (existing.stage==='cancelled') reject('CASE_CANCELLED','已取消开发案不能转单');
      if (!hasConfirmedSource && !existing.productAssetId) reject('ASSET_REQUIRED','请先完成开发成果转档');
      const confirmed = await resolveConfirmedSource({prisma:tx,caseId,confirmedSourceType:hasConfirmedSource?confirmedSourceType:'Asset',confirmedSourceId:hasConfirmedSource?confirmedSourceId:existing.productAssetId,millRelationId});
      if (!confirmed.ok) reject(confirmed.error.code,confirmed.error.message);
      const confirmedData = confirmed.ok ? confirmed.data : null!;
      const exactProof = confirmedData.specSnapshot?.exactDevelopmentVersionProof;
      if (!exactProof || typeof exactProof !== 'object' || Array.isArray(exactProof))
        reject('DEVELOPMENT_NOT_READY', '所选成果缺少可核验的准确版本正式 QC 与实际需求方确认，历史认可不能推算为本版下单依据。', 409);
      const actualSourceType = hasConfirmedSource ? confirmedSourceType! : 'Asset';
      const actualSourceId = hasConfirmedSource ? confirmedSourceId! : existing.productAssetId;
      const effectiveProductAssetId=confirmedData.productAssetId || existing.productAssetId || '';
      const effectiveProductName=confirmedData.productName || existing.productName || productName || '';
      const effectiveMillName=confirmedData.millName ?? null;
      const effectiveMillRelationId=confirmedData.millRelationId ?? null;
      const actualCustomer = existing.customerRelationId ? await tx.relation.findFirst({where:{id:existing.customerRelationId,deletedAt:null},select:{id:true,name:true}}) : null;
      const asset=effectiveProductAssetId ? await tx.productAsset.findUnique({where:{id:effectiveProductAssetId},select:{sku:true}}) : null;
      const productAssetSku=asset?.sku ?? null;
      if (confirmedData.specSnapshot?.mainCategory && String(confirmedData.specSnapshot.mainCategory).toLowerCase() !== sourceFamily) reject('DEVELOPMENT_SOURCE_CHANGED','确认档案与开发案的业务类型不一致',409);
      await assertFabricDevelopmentReady(tx, existing, effectiveProductAssetId);
      let commercial: Awaited<ReturnType<typeof freezeOrderConversionCommercial>>|null=null;
      if (wantAutoCreate) {
        commercial=await freezeOrderConversionCommercial(tx,actorId!,existing.customerRelationId??null,validatedQuoteAmount,commercialPrepared!,params.commandExecution?.moqSnapshot);
        createdOrder = await tx.order.create({
          data: {
            id: finalOrderId,
            code: await allocateInternalOrderCode(tx),
            poNumber: finalOrderPo,
            customer: actualCustomer?.name ?? existing.customerName ?? '',
            product: effectiveProductName,
            type: sourceFamily!,
            quantity: validatedQuantity,
            unit: params.commandExecution?.unit ?? null,
            status: 'Pending',
            dueDate: validatedDueDate,
            quoteAmount: validatedQuoteAmount,
            customerRelationId: existing.customerRelationId ?? null,
            ownerId: actorId || null,
            salesCurrency: 'USD',
            moqSnapshot: {...commercial.moqSnapshot} as Prisma.InputJsonValue,
            purchaseCurrency: 'CNY',
            // DR-053 阶段 1：工厂取成果归属（统一名称快照），修"显示 B 厂实际关联 A 厂"
            millName: effectiveMillName,
            millRelationId: effectiveMillRelationId,
            importedAt: now,
            updatedAt: now,
            source: 'dev-case-convert',
            // DR-053 阶段 1：来源开发案快照（多订单关系反查）+ 请求幂等键
            sourceCaseId: existing.id,
            clientRequestId: clientRequestId ? String(clientRequestId) : null,
            fieldSources: {} as Prisma.InputJsonValue,
          },
        });
        if (effectiveProductAssetId || effectiveProductName) {
          await tx.orderLine.create({
            data: {
              id: `OL-${finalOrderId}-1`,
              orderId: finalOrderId,
              lineNumber: 1,
              materialCode: productAssetSku,
              description: effectiveProductName,
              quantity: validatedQuantity,
              unit: params.commandExecution?.unit ?? (sourceFamily === 'garment' ? 'Pcs' : 'Meter'),
              status: 'Pending',
              requiredSampleFamilies: normalizeRequiredSampleFamilies({ type: sourceFamily }),
              // DR-053 阶段 1：版本引用（确认成果 → 订单行）+ 不可变规格快照
              confirmedSourceType: actualSourceType,
              confirmedSourceId: actualSourceId,
              confirmedAt: now,
              confirmedBy: actorId || 'api',
              specSnapshot: confirmedData.sourceCode ? (confirmedData.specSnapshot as Prisma.InputJsonValue) : undefined,
            },
          });
        }
      }

      if(commercial){await consumeOrderConversionCommercial(tx,commercial,createdOrder.id);moqCheck=await orderConversionMoqAdvisory(tx,actorId!,existing.customerRelationId??null,sourceFamily!,validatedQuantity,params.commandExecution?.unit??(sourceFamily==='garment'?'PC':'M'),commercial.moqSnapshot,effectiveProductAssetId||undefined);}

      doc = await tx.developmentCase.update({
        where: { id: caseId },
        data: {
          linkedOrderId: finalOrderId,
          linkedOrderPo: finalOrderPo,
          convertedAt: now,
          stage: 'approved',
          completedDate: todayLocalKey(),
          updatedAt: now,
        },
      });

      // sync（同事务，fail closed）
      if (wantAutoCreate) {
        await syncOrderEntityReferences(prisma, createdOrder, { source: 'dev-case-convert' }, tx);
      } else {
        const linkedOrder = await tx.order.findUnique({ where: { id: finalOrderId } });
        if (!linkedOrder) {
          throw new Error(`Order ${finalOrderId} not found in transaction (link mode)`);
        }
        await syncOrderEntityReferences(prisma, linkedOrder, { source: 'dev-case-convert' }, tx);
      }
      await syncDevelopmentCaseReferences(prisma, doc, { source: 'dev-case-convert' }, tx);

      // audit（同事务，用 writeRouteAuditLog 返回真实 id）
      auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: actorId || 'api',
        source: 'dev:convert',
        operation: 'convert_dev_case',
        targetType: 'DevelopmentCase',
        targetId: doc.id,
        before: { stage: existing.stage, linkedOrderId: null },
        after: { stage: 'approved', linkedOrderId: finalOrderId, orderId: finalOrderId, autoCreated: wantAutoCreate },
      });

      return { doc, createdOrder };
    };
    const result = params.commandExecution ? await transactionBody(params.commandExecution.tx) : await prisma.$transaction(transactionBody);
    if ('recovered' in result && result.recovered) {
      return { ok: true, data: { case: result.doc, order: result.createdOrder, auditId: '', recovered: true } };
    }
    doc = result.doc;
    createdOrder = result.createdOrder;

  } catch (txErr: any) {
    if (txErr?.code === 'NOT_FOUND') return {ok:false,error:{code:'DEV_CASE_NOT_FOUND',message:'开发案不存在或已删除'}};
    if (isCreditExceptionConsumptionErrorCode(txErr?.code) || ['CREDIT_FROZEN_60_DAYS','CREDIT_REVOKED','OVERDUE_60_DAYS','CREDIT_BLOCKED','CREDIT_CHECK_FAILED','EXCEPTION_CONSUME_FAILED','UNAUTHORIZED','AUTHORIZATION_UNAVAILABLE','ORDER_NOT_FOUND','FORBIDDEN','SOURCE_CHANGED','DEVELOPMENT_SOURCE_CHANGED','DEVELOPMENT_NOT_READY','DEVELOPMENT_PAUSED','DEVELOPMENT_CLOSED','INVALID_LIFECYCLE_STATE','NOT_FOUND','DEV_CASE_NOT_FOUND','CASE_CANCELLED','INVALID_STAGE','ASSET_REQUIRED','CONFIRMED_SOURCE_NOT_FOUND','CONFIRMED_SOURCE_NOT_APPROVED','MILL_MISMATCH'].includes(txErr?.code)) { const safe = safeRouteError(txErr, {fallbackCode:'INTERNAL_ERROR'}); return { ok: false, error: { code: txErr.code, message: safe.message,...(txErr?.blockCode?{blockCode:txErr.blockCode}:{}) } }; }
    logger.error('[development] conversion transaction failed', {error: txErr?.message ?? String(txErr)});
    return { ok: false, error: { code: 'CONVERT_FAILED', message: '开发转单未能完成，请刷新核对开发案和目标订单后重试。' } };
  }

  return { ok: true, data: { case: doc, order: createdOrder, auditId, moqCheck } };
}
