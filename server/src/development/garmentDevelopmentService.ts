import { sampleProjectionKey, sampleOriginLockHints, lockSampleOriginParents } from '../samples/sampleOriginService';
import { assertDevelopmentOperationalWrite } from './developmentOperationalGuard';
import { assertReviewSourceCurrent } from './developmentSampleQualityService';
import { assertDevelopmentVersionQualityPass, readDevelopmentArchiveReceipt, recordDevelopmentArchiveReceipt, resolveDevelopmentVersionForBatch } from './developmentVersionGate';
import { linkDevelopmentPhysicalSamplesToAsset } from './developmentPhysicalArchiveLink';
/**
 * garmentDevelopmentService.ts — 成衣开发链（DR-051，type=garment/pp/trim 专用）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/成衣开发流程.md
 *
 * 覆盖：强制转成衣档案（convert-to-asset）——确认样节点 / 封存轮次 → ProductAsset(Garment)
 *      + GarmentProfile，字段透传 + 回填开发案 productAssetId。
 *
 * 关键业务规则：
 *  - 开发管理收线到「确认样/封样」（设计确认）：确认样节点（level=confirmation 且 status=approved）
 *    或封存轮次（attachments.garmentSampleGate 中 status=sealed）方可转档；
 *  - 成衣开发案转大货前必须先转档（ASSET_REQUIRED，见 convertService）；
 *  - 多工厂试样（DevelopmentSupplier）为通用实体（DR-050 已建），成衣案同样挂载；
 *  - 所有 mutation 写审计（writeRouteAuditLog 同事务，fail closed）。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { syncDevelopmentCaseReferences } from '../entities/sync';
// ★ G-5：开发来源 → 产品档案来源的映射与面料侧共用一份真源（此处曾硬编码 'development' 销毁已录来源）
import { assetSourceFromDevCase } from './devSource';
import { logger } from '../lib/logger';
import { createDevelopmentAssetWithSku } from '../products/developmentSkuAllocator';
import type { TokenPayload } from '../auth/service';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { assertGarmentSourceAccess, assertNativeGarmentRound, assertGarmentSampleSource, garmentRoundContent, garmentCaseContent } from './garmentSourceBindingService';

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });

/** 从 attachments.garmentSampleGate 读取轮次数组（DR-008/DR-029 存储契约） */
function roundVersion(round: any): string {
  return round?.version ? String(round.version) : round?.id ? String(round.id) : '';
}

/**
 * 转成衣档案：创建 ProductAsset(Garment) + GarmentProfile，字段从开发案规格要求透传；
 * 回填开发案 productAssetId（首个档案锚点）。强制建档后转：convertService 在成衣案转大货前校验。
 */
export async function convertToGarmentAsset(params: {
  prisma: PrismaClient;
  caseId: string;
  sourceType: 'node' | 'seal';
  sourceId: string;
  actorId: string;
  trustedActor?: TokenPayload;
  sourceRoundId?: string;
  sourceVersionId?: string;
  requestKey?: string;
  targetSampleId?: string;
  ip?: string | null;
}): Promise<Result<{ asset: any; case: any; node?: any; round?: any; conversionReceipt?: any }>> {
  const { prisma, caseId, sourceType, sourceId, actorId, ip, trustedActor, sourceRoundId, sourceVersionId, targetSampleId, requestKey } = params;
  try {
    if (!trustedActor?.userId || trustedActor.userId !== actorId) throw new DevelopmentDomainError('UNAUTHORIZED', '请使用当前登录身份转成衣档案');
    const devCase = await prisma.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
    if (!devCase) return fail('DEV_CASE_NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
    if (!['garment', 'pp', 'trim'].includes(String(devCase.type))) {
      return fail('NOT_GARMENT_CASE', `转成衣档案仅适用于成衣开发案（当前类型 ${devCase.type}）`);
    }

    // 事务外读源（先校验 gate）
    let sourceNode: any = null;
    let sourceRound: any = null;
    if (sourceType === 'node') {
      const level = String(sourceId || '');
      if (level !== 'confirmation') {
        return fail('INVALID_NODE_LEVEL', `转成衣档案仅支持确认样节点（level=confirmation），当前 ${level || '空'}`);
      }
      // sourceType='node' is a legacy route name. Archive eligibility follows
      // the exact version's formal QC report, independently of customer choice.
      const confirmBatch: any = await (prisma as any).sampleBatch.findFirst({
        where: { ...(sourceRoundId ? { id: sourceRoundId } : {}), developmentCaseId: caseId, sampleType: 'garment-round', deletedAt: null },
      });
      if (!confirmBatch) {
        return fail('NODE_NOT_FOUND', '开发版本不存在或不属于本开发案', 404);
      }
      {
        const att = confirmBatch.attachments && typeof confirmBatch.attachments === 'object' ? confirmBatch.attachments : {};
        sourceNode = confirmBatch;
        sourceRound = {
          id: confirmBatch.id,
          round: confirmBatch.round,
          version: att.version ?? '',
          purpose: att.purpose ?? null,
          status: 'confirmed',
        };
      }
    } else if (sourceType === 'seal') {
      const roundId = String(sourceId || '');
      if (!roundId) return fail('INVALID_INPUT', 'sourceId（封存轮次 id）必填');
      // DR-054 阶段 G-Ⅱ + 消双轨 L-4：轮次唯一真源 SampleBatch(sampleType='garment-round')，旧 JSON 载体已退役
      const batchRound = await (prisma as any).sampleBatch.findFirst({ where: { id: roundId, developmentCaseId: caseId, sampleType: 'garment-round', deletedAt: null } });
      if (batchRound && batchRound.developmentCaseId === caseId) {
        const att = batchRound.attachments && typeof batchRound.attachments === 'object' ? batchRound.attachments : {};
        sourceRound = {
          id: batchRound.id,
          round: batchRound.round,
          version: att.version ?? '',
          purpose: att.purpose ?? null,
          status: att.sealedRoundStatus ?? (batchRound.status === 'approved' ? 'confirmed' : batchRound.status),
        };
      }
      if (!sourceRound) return fail('ROUND_NOT_FOUND', `封存轮次 ${roundId} 不存在`, 404);
    } else {
      return fail('INVALID_SOURCE_TYPE', 'sourceType 必须是 node（确认样节点）| seal（封存轮次）');
    }


    const result = await (prisma as any).$transaction(async (tx: any) => {
      await assertDevelopmentOperationalWrite(tx,caseId,'convert');
      await assertGarmentSourceAccess(tx, trustedActor, caseId);
      const freshCase=await tx.developmentCase.findFirst({where:{id:caseId,deletedAt:null}});
      const conflict=(code:string,message:string):never=>{throw Object.assign(new Error(message),{code,status:409,statusCode:409});};
      if(!freshCase || !['garment','pp','trim'].includes(String(freshCase.type))) conflict('DEVELOPMENT_SOURCE_CHANGED','开发案来源已变化，请刷新');
      const devCase = freshCase;
      const selectedId=sourceNode?.id ?? sourceRound?.id;
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id"=${selectedId} FOR UPDATE`);
      const fresh=await tx.sampleBatch.findFirst({where:{id:selectedId,developmentCaseId:caseId,sampleType:'garment-round',deletedAt:null}});
      if(!fresh || fresh.developmentCaseId!==caseId || fresh.deletedAt) conflict('DEVELOPMENT_SOURCE_CHANGED','转档来源已删除或不属于本案');
      const att=fresh.attachments && typeof fresh.attachments==='object'?fresh.attachments:{};
      const { version: selectedVersion } = await resolveDevelopmentVersionForBatch(tx, { caseId, batch: fresh, sampleVersionId: sourceVersionId, lock: true });
      const archiveCommand = { caseId, sampleVersionId: selectedVersion.id, sampleBatchId: fresh.id, sourceType, sourceId, actorId, requestKey };
      const receipt = await readDevelopmentArchiveReceipt(tx, archiveCommand);
      if (receipt) return { ...receipt, case: devCase };
      const review = await assertDevelopmentVersionQualityPass(tx, caseId, selectedVersion.id);
      await assertReviewSourceCurrent(tx, review);
      const roundStatus=att.sealedRoundStatus??(fresh.status==='approved'?'confirmed':fresh.status);
      if(sourceType==='seal' && roundStatus!=='sealed') conflict('ROUND_NOT_SEALED','封存轮次状态已变化');
      sourceNode=sourceType==='node'?fresh:null;
      sourceRound={id:fresh.id,round:fresh.round,version:selectedVersion.versionLabel,purpose:att.purpose??null,status:sourceType==='node'?'confirmed':roundStatus};
      const priorAssets = await tx.productAsset.findMany({ where: { sourceDevelopmentCaseId: caseId, sourceSampleVersionId: selectedVersion.id, deletedAt: null }, orderBy: { id: 'asc' } });
      if (priorAssets.length > 1) conflict('CONFLICT', '同一准确成衣版本已关联多个产品档案，请核对历史记录');
      if (priorAssets.length === 1) {
        if (priorAssets[0].mainCategory !== 'Garment' || priorAssets[0].sourceSampleBatchId !== fresh.id) conflict('DEVELOPMENT_SOURCE_CHANGED', '已有档案与当前准确成衣版本来源不一致');
        const conversionReceipt = await recordDevelopmentArchiveReceipt(tx, archiveCommand, priorAssets[0].id);
        return { asset: priorAssets[0], case: devCase, conversionReceipt };
      }
      // Only an actual sealed Sample with matching native seal/sync facts may inherit this asset.
      // A confirmed node alone never manufactures a PP approval or a Sample.
      let projectedSample: any = null;
      if (sourceType === 'seal') {
        if (att.sealedVersionId !== selectedVersion.id) conflict('DEVELOPMENT_SOURCE_CHANGED', '原封样未明确封存所选准确版本，不能以同一原实物推算');
        const samples = await tx.sample.findMany({ where: { projectionKey: sampleProjectionKey('garment_pp', fresh.id, fresh.round, selectedVersion.id), sourceCaseId: caseId, type: 'pp', deletedAt: null }, orderBy: { id: 'asc' } });
        if (samples.length > 1) throw new DevelopmentDomainError('CONFLICT', '原生轮次对应多个投影目标，请核对不可变来源');
        projectedSample = targetSampleId ? samples.find((row: any) => row.id === targetSampleId) : samples[0] ?? null;
        if (targetSampleId && !projectedSample) throw new DevelopmentDomainError('NOT_FOUND', '所选样品不属于本案');
        if (projectedSample) {
          const originHints = await sampleOriginLockHints(tx, [projectedSample.id]);
          if (originHints.caseIds.some(id => id !== caseId) || originHints.sealIds.length || originHints.batchIds.some(id => id !== fresh.id)) throw new DevelopmentDomainError('CONFLICT', '原生封样投影包含其他来源，不能转档替换');
          await lockSampleOriginParents(tx, originHints);
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id"=${projectedSample.id} FOR UPDATE`);
          projectedSample = await tx.sample.findFirst({ where: { id: projectedSample.id, sourceCaseId: caseId, deletedAt: null } });
          await assertGarmentSampleSource(tx, devCase, fresh, projectedSample);
          if (projectedSample.productAssetId) throw new DevelopmentDomainError('CONFLICT', '原样品已有关联档案，请使用原资产来源关联入口');
        }
      }
      const now = BigInt(Date.now());
      const physicalReferences = await linkDevelopmentPhysicalSamplesToAsset(tx, fresh, devCase, selectedVersion.id, now, { referenceOnly: true });
      const name = (devCase.productName || devCase.name || '成衣').trim();
      const targetPrice = Number.parseFloat(String(devCase.targetPrice ?? ''));
      const moqValue = devCase.moqEstimate != null && Number.isFinite(Number(devCase.moqEstimate)) ? Math.round(Number(devCase.moqEstimate)) : null;
      // The selected physical round owns its factory; a multi-factory case may have no header supplier.
      const factoryRelationId = fresh.supplierRelationId || devCase.supplierRelationId || null;
      const factoryName = fresh.supplierRelationId ? fresh.supplierName || null : devCase.supplierName || null;

      // ★ G-5：这一行此前硬编码 'development'，注释断言「成衣案无 DR-050 面料立项 source」——**该前提是错的**：
      //   开发类型下拉在「关联信息」区块（`dev-partner`，不按 type 隐藏）、提交载荷无条件带 `source`
      //   （`components/DevelopmentManager.tsx:781`）、服务层字段表对任何 type 都持久化（`developmentCaseMutationService.ts:184`）
      //   ⇒ 成衣案**本来就能**录来源，只是**转档时这份硬编码把已录的值销毁**。
      //   现与面料侧共用 `devSource.ts` 那张唯一映射表；`source` 为空/认识不了 ⇒ 仍默认 'development'（存量行为不变）。
      const assetSource = assetSourceFromDevCase(devCase.source);
      const assetSourceDetail = `${devCase.code}（${devCase.name || ''}）`;

      const created = await createDevelopmentAssetWithSku(tx, 'GR', {
          id: `PROD-${Date.now()}`,
          name,
          mainCategory: 'Garment',
          subCategoryId: 'uncategorized',
          season: '',
          // targetCost below remains a target; it cannot establish actual unit cost.
          cost: null,
          status: 'Development',
          source: assetSource,
          sourceDetail: assetSourceDetail,
          sourceDevelopmentCaseId: caseId,
          sourceSampleBatchId: fresh.id,
          sourceSampleVersionId: selectedVersion?.id ?? null,
          sourceVersionLabel: selectedVersion?.versionLabel ?? fresh.versionLabel ?? null,
          sourceSpecSnapshot: {
            sampleVersionId: selectedVersion?.id ?? null,
            versionLabel: selectedVersion?.versionLabel ?? fresh.versionLabel ?? null,
            versionKind: selectedVersion?.versionKind ?? 'legacy',
            minorChangeNote: selectedVersion?.minorChangeNote ?? null,
            physicalSampleBatchId: fresh.id,
            physicalCardIds: physicalReferences.physicalCardIds,
            qualityReviewId: review.id,
            round: fresh.round,
            garmentRound: garmentRoundContent(fresh),
          },
          techPackUrl: null,
          imageUrl: null,
          updatedAt: now,
          deletedAt: null,
      });
      await tx.garmentProfile.create({
        data: {
          id: `GAR-${Date.now()}`,
          productAssetId: created.id,
          styleNo: devCase.styleSpec || null,
          productName: name,
          garmentCategory: devCase.sampleCategory && devCase.sampleCategory !== 'normal' ? devCase.sampleCategory : null,
          collection: null,
          customer: devCase.customerName || null,
          customerRelationId: devCase.customerRelationId || null,
          factoryRelationId,
          factory: factoryName,
          brand: null,
          project: null,
          gender: null,
          ageGroup: null,
          tags: Array.isArray(devCase.tags) && devCase.tags.length > 0 ? devCase.tags.join(',') : null,
          silhouette: null,
          fit: null,
          moqValue,
          mainFabric: devCase.fabricSpec || null,
          sizeSpec: devCase.sizeSpec || null,
          constructionNote: devCase.processSpec || null,
          garmentSku: created.sku,
          targetCost: Number.isFinite(targetPrice) ? String(targetPrice) : null,
          sampleVersion: sourceRound ? roundVersion(sourceRound) : null,
          updatedAt: now,
          deletedAt: null,
        },
      });
      if (selectedVersion.versionKind !== 'minor') await linkDevelopmentPhysicalSamplesToAsset(tx, fresh, devCase, created.id, now);
      const physicalCardId = physicalReferences.physicalCardId;
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:garment-convert-asset',
        operation: 'convert_garment_to_asset',
        targetType: 'ProductAsset',
        targetId: created.id,
        after: { sku: created.sku, name, mainCategory: 'Garment', fromCase: caseId, sourceType, sourceId,
          sourceRoundId: fresh.id, sourceSampleVersionId: selectedVersion?.id ?? null, sourceVersionLabel: selectedVersion?.versionLabel ?? fresh.versionLabel ?? null,
          sampleId: projectedSample?.id ?? null, physicalCardId, physicalCardIds: physicalReferences.physicalCardIds,
          qualityReviewId: review.id, roundContent: garmentRoundContent(fresh), caseContent: garmentCaseContent(devCase) },
        ip: ip || null,
      });

      if (projectedSample) {
        const linked = await tx.sample.updateMany({ where: { id: projectedSample.id, productAssetId: null, updatedAt: projectedSample.updatedAt, deletedAt: null },
          data: { productAssetId: created.id, updatedAt: now } });
        if (linked.count !== 1) throw new DevelopmentDomainError('CONFLICT', '样品来源已变化，请刷新核对');
      }

      // 开发案 productAssetId 为空时回填首个档案（对齐转大货/完备度引擎的档案锚点）
      const caseData: any = { updatedAt: now };
      if (!devCase.productAssetId) {
        caseData.productAssetId = created.id;
        caseData.productName = name;
      }
      const updatedCase = await tx.developmentCase.update({ where: { id: caseId }, data: caseData });
      await syncDevelopmentCaseReferences(prisma, { ...updatedCase, productAssetId: updatedCase.productAssetId }, { source: 'dev:garment-convert-asset' }, tx);
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:garment-convert-asset',
        operation: 'convert_garment_asset_link_case',
        targetType: 'DevelopmentCase',
        targetId: caseId,
        before: { productAssetId: devCase.productAssetId ?? null },
        after: { productAssetId: updatedCase.productAssetId ?? null },
        ip: ip || null,
      });

      const conversionReceipt = await recordDevelopmentArchiveReceipt(tx, archiveCommand, created.id);
      return { asset: created, case: updatedCase, conversionReceipt };
    });

    const { asset, case: updatedCase, conversionReceipt } = result as any;
    return {
      ok: true,
      data: {
        asset: {
          ...asset,
          updatedAt: Number(asset.updatedAt),
          deletedAt: asset.deletedAt ? Number(asset.deletedAt) : null,
        },
        case: {
          ...updatedCase,
          createdAt: Number(updatedCase.createdAt),
          updatedAt: Number(updatedCase.updatedAt),
          deletedAt: updatedCase.deletedAt ? Number(updatedCase.deletedAt) : null,
          convertedAt: updatedCase.convertedAt ? Number(updatedCase.convertedAt) : null,
        },
        ...(sourceNode ? { node: sourceNode } : {}),
        ...(sourceRound ? { round: sourceRound } : {}),
        ...(conversionReceipt ? { conversionReceipt } : {}),
      },
    };
  } catch (e: any) {
    if (e?.code === 'NOT_FOUND') return fail('DEV_CASE_NOT_FOUND', '开发案不存在或已删除', 404);
    if (e instanceof DevelopmentDomainError) return fail(e.code, e.message, e.statusCode);
    if (['DEVELOPMENT_PAUSED','DEVELOPMENT_CLOSED','INVALID_LIFECYCLE_STATE','LIFECYCLE_HISTORY_EXISTS','DEVELOPMENT_SOURCE_CHANGED','NODE_NOT_APPROVED','ROUND_NOT_SEALED'].includes(e?.code)) return fail(e.code,e.message,409);
    // B39：本文件原先**一处 `logger.error` 都没有**（D51）⇒ 先补日志，再换文案。
    // 原文只进日志；对外只给中文 + 下一步。写路径唯一 = 上面那个 $transaction（抛错即回滚），
    // 之后到 catch 之间只是拼返回对象 ⇒ 可以承诺"本次未确认任何改动"。
    logger.error('[GarmentDev] 转成衣档案失败', { caseId, error: e?.message });
    return fail('CONVERT_ASSET_FAILED', '转成衣档案未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该开发案的确认样/封样轮次与档案编号。', 500);
  }
}
