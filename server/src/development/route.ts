import { createDevelopmentPhysicalSampleRouter } from './developmentPhysicalSampleRoute';
import { createDevelopmentFactoryNoticeRouter } from './developmentFactoryNoticeRoute';
import { createFabricSearchRouter } from './fabricSearchRoute';
import {createDevelopmentConversionCommandRouter} from '../orders/orderConversionCommandRoute';
import { readDevelopmentOrderAssociations } from './developmentOrderReadProjection';
import { createDevelopmentCostEvidenceRouter } from './developmentCostEvidenceRoute';
import { createGarmentSourceBindingRouter } from './garmentSourceBindingRoute';
/**
 * Development Management API — /api/v1/development
 *
 * CRUD + stage progression + convert-to-order for DevelopmentCase.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { PrismaClient, Prisma } from '@prisma/client';
import { syncOrderEntityReferences } from '../entities/sync';
import { createDevelopmentCase, updateDevelopmentCase, updateDevelopmentStage, deleteDevelopmentCase } from './developmentCaseMutationService';
import {
  listDevelopmentSuppliers, addDevelopmentSupplier, updateDevelopmentSupplier, removeDevelopmentSupplier,
  listSampleBatches, createSampleBatch, updateSampleBatch, deleteSampleBatch, confirmSampleBatch,
  advanceSampleBatchStage, submitBatchCustomerFeedback,
  listSealSamples, createSealSample, updateSealSample, deleteSealSample, sealSampleConfirm,
  convertToFabricAsset,
} from './fabricDevelopmentService';
import { createSampleRoomService } from '../samples/sampleRoomService';
import { convertToGarmentAsset } from './garmentDevelopmentService';
import { writeRouteAuditLog, actorIdFromRequest } from '../audit/routeAudit';
import { convertDevCaseToOrder } from './convertService';
import { logger } from '../lib/logger';
import { extractActorFromRequest, pickRequestToken } from '../auth/middleware';
import { createAuthService } from '../auth/service';
import { lookupErrorCode, readBusinessErrorMint } from '../shared/errorCodes';
import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from './developmentOperationalGuard';
import { safeRouteError } from '../shared/routeError';
import { todayLocalKey } from '../shared/localDate';
const DEVELOPMENT_OPERATION_STATUS: Record<string, number> = { DEVELOPMENT_PAUSED: 409, DEVELOPMENT_CLOSED: 409, LIFECYCLE_HISTORY_EXISTS: 409, INVALID_LIFECYCLE_STATE: 409 };
import { createDevelopmentClosureRouter } from './developmentClosureRoute';
import { updateDevelopmentSampleRoundRequirements, updateDevelopmentSampleVersionTask, recordDevelopmentVersionConfirmation, listDevelopmentVersionConfirmations, createDevelopmentSampleMinorVersionCommand } from './developmentSampleVersionService';
import { createDevelopmentPendingExpenseRouter } from './developmentPendingExpenseRoute';
import { acknowledgeDevelopmentSampleQualityReview, recordDevelopmentSampleReturnResults, requestDevelopmentSampleQualityReview } from './developmentSampleQualityService';

export interface DevelopmentRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

type DevelopmentCaseCreateInput = {
  code: string;
  name: string;
  type: string;
  stage?: string;
  priority?: string;
  owner?: string;
  customerRelationId?: string;
  customerName?: string;
  supplierRelationId?: string;
  supplierName?: string;
  productAssetId?: string;
  productName?: string;
  currentRound?: number;
  nextAction?: string;
  targetDate?: string;
  sampleType?: string;
  sampleCategory?: string;
  sampleQuantity?: number;
  sampleUnit?: string;
  notes?: string;
  tags?: string[];
  styleSpec?: string;
  sizeSpec?: string;
  fabricSpec?: string;
  processSpec?: string;
  // 面料链（DR-050，type=fabric 专用）
  source?: string;
  dyeMethod?: string;
  departmentId?: string;
  departmentName?: string;
  specComposition?: string;
  specWeight?: string;
  specWidth?: string;
  specWeave?: string;
  specFinish?: string;
  targetPrice?: number | string;
  moqEstimate?: number;
  techReviewStatus?: string;
  techReviewNote?: string;
  techReviewAt?: string;
  techReviewBy?: string;
};

type DevelopmentCaseUpdateInput = Partial<DevelopmentCaseCreateInput> & {
  stage?: string;
  sampleSentDate?: string;
  sampleTrackingNumber?: string;
  sampleCourier?: string;
  sampleShippingFee?: number;
  sampleRecipientName?: string;
  sampleRecipientCompany?: string;
  sampleRecipientAddress?: string;
  sampleRecipientPhone?: string;
  sampleFeedback?: string;
  sampleFeedbackDate?: string;
  sampleInvoiceId?: string;
  linkedOrderId?: string;
  linkedOrderPo?: string;
  convertedAt?: number;
  completedDate?: string;
  attachments?: any;
};

// Valid transitions for stage progression
const VALID_STAGES = ['developing', 'shipping', 'feedback', 'revision', 'approved', 'cancelled'] as const;
const VALID_TYPES = ['fabric', 'garment', 'pp', 'trim'] as const;

function isValidStage(s: string): s is typeof VALID_STAGES[number] {
  return (VALID_STAGES as readonly string[]).includes(s);
}
function isValidType(t: string): t is typeof VALID_TYPES[number] {
  return (VALID_TYPES as readonly string[]).includes(t);
}

export function createDevelopmentRouter(options: DevelopmentRouterOptions): Router {
  const { prisma, onDataChange, requireAuth, apiKeys } = options;
  const router = Router();

  // Shared auth guard: JWT or API-key (restored — was silently dropped by scaffold)
  const guard = createModuleAuthGuard({ requireAuth, apiKeys });
  router.use(guard);
  router.use(createFabricSearchRouter({ prisma }));
  router.use(createDevelopmentConversionCommandRouter({prisma,onDataChange}));
  router.use(createDevelopmentPendingExpenseRouter({ prisma }));
  router.use(createDevelopmentClosureRouter({ prisma }));
  router.use(createDevelopmentPhysicalSampleRouter({ prisma, onDataChange }));
  router.use(createDevelopmentCostEvidenceRouter({ prisma }));
  router.use(createDevelopmentFactoryNoticeRouter({ prisma }));
  router.use(createGarmentSourceBindingRouter({ prisma, onDataChange }));

  // W-C 批三-E 族B 收口：Development 属 products 域（VIEW_TO_MAIN_SCOPES 真源）——
  // 原无授权门的写面挂 products:write scope 门（持有 = SALES/SALES_MANAGER＋SuperAdmin 特判），
  // 读面挂 products:read；convert/delete 已随族 C 一并收编 products:write（legacy requireRole 退役）。
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const requireDevWrite = requirePermission('products:write');
  const requireDevRead = requirePermission('products:read');
  // C13 5A 评审权分离（2026-09-04 Kevin 验收反馈）：评审是 QC 职责，不是开发写权——
  // 原来挂 products:write 意味着业务员自己建的单自己就能评审通过，权限链断裂。
  // 评审端点改挂 qc:garment_chain:write（QC 角色 / 超级管理员持有），与开发写权解耦。
  const requireQcReview = requirePermission('qc:garment_chain:write');


  // ─── GET / ─── List development cases ───
  router.get('/', requireDevRead, async (req: Request, res: Response) => {
    try {
      const { type, stage, customer, supplier, owner, search, sampleInvoiceId, productAssetId, limit = '50', offset = '0' } = req.query;

      const where: Prisma.DevelopmentCaseWhereInput = {
        deletedAt: null,
        ...(type ? { type: String(type) } : {}),
        ...(stage ? { stage: String(stage) } : {}),
        ...(customer ? { customerRelationId: String(customer) } : {}),
        ...(supplier ? { supplierRelationId: String(supplier) } : {}),
        ...(owner ? { owner: String(owner) } : {}),
        // DR-057 v2.1 发票↔开发单双向闭环：发票详情反查引用本发票的开发单
        ...(sampleInvoiceId ? { sampleInvoiceId: String(sampleInvoiceId) } : {}),
        // DR-057 v2.1 档案↔开发单反查：产品档案详情反查关联开发单
        ...(productAssetId ? { productAssetId: String(productAssetId) } : {}),
        ...(search ? {
          OR: [
            { name: { contains: String(search), mode: 'insensitive' } },
            { code: { contains: String(search), mode: 'insensitive' } },
            { customerName: { contains: String(search), mode: 'insensitive' } },
            { supplierName: { contains: String(search), mode: 'insensitive' } },
            { productName: { contains: String(search), mode: 'insensitive' } },
          ],
        } : {}),
      };

      const [cases, total] = await Promise.all([
        prisma.developmentCase.findMany({
          where,
          orderBy: [{ targetDate: 'asc' }, { createdAt: 'desc' }],
          take: Math.min(Number(limit), 200),
          skip: Number(offset),
        }),
        prisma.developmentCase.count({ where }),
      ]);

      // DR-050 面料链：按开发案聚合试样工厂数（列表伙伴列面料案显示「工厂 ×N」）
      const supplierCounts = await prisma.developmentSupplier.groupBy({
        by: ['developmentCaseId'],
        where: { deletedAt: null, developmentCaseId: { in: cases.map(c => c.id) } },
        _count: { _all: true },
      }).catch(() => []);
      const supplierCountMap = new Map(supplierCounts.map((s: any) => [s.developmentCaseId, s._count._all]));

      const orderAssociations = await readDevelopmentOrderAssociations(prisma, cases, (req as any).actor);

      // Strip BigInt for JSON serialization
      const serialized = cases.map(c => ({
        ...c,
        createdAt: Number(c.createdAt),
        updatedAt: Number(c.updatedAt),
        deletedAt: c.deletedAt ? Number(c.deletedAt) : null,
        convertedAt: c.convertedAt ? Number(c.convertedAt) : null,
        tags: c.tags || [],
        supplierCount: supplierCountMap.get(c.id) ?? 0,
        orderAssociation: orderAssociations.get(c.id),
      }));

      res.json({ ok: true, cases: serialized, total, limit: Number(limit), offset: Number(offset) });
    } catch (err: any) {
      logger.error('[development] GET / failed', { error: err?.message || String(err) });
      const safe = readBusinessErrorMint(err) ?? { statusCode: 500, code: 'INTERNAL_ERROR', message: '开发案读取失败，请稍后重试。' };
      res.status(safe.statusCode).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  // ─── GET /:id ─── Get single development case ───
  router.get('/:id', requireDevRead, async (req: Request, res: Response) => {
    try {
      const doc = await prisma.developmentCase.findFirst({
        where: { id: req.params.id, deletedAt: null },
      });
      if (!doc) {
        res.status(404).json({ ok: false, error: 'Development case not found' });
        return;
      }
      const orderAssociations = await readDevelopmentOrderAssociations(prisma, [doc], (req as any).actor);
      const serialized = {
        ...doc,
        orderAssociation: orderAssociations.get(doc.id),
        createdAt: Number(doc.createdAt),
        updatedAt: Number(doc.updatedAt),
        deletedAt: doc.deletedAt ? Number(doc.deletedAt) : null,
        convertedAt: doc.convertedAt ? Number(doc.convertedAt) : null,
        tags: doc.tags || [],
      };
      res.json({ ok: true, case: serialized });
    } catch (err: any) {
      logger.error('[development] GET /:id failed', { error: err?.message || String(err) });
      const safe = readBusinessErrorMint(err) ?? { statusCode: 500, code: 'INTERNAL_ERROR', message: '开发案读取失败，请稍后重试。' };
      res.status(safe.statusCode).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  // ─── POST / ─── Create development case ───
  router.post('/', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    // task ERP-P1-development-mutation-route-foundation: route 只调 service（$transaction + sync + audit fail closed）
    if ((req as any).authSource === 'user-session' && ['fabric', 'garment'].includes(req.body?.type) && !req.body?.ownerId) {
      res.status(400).json({ok:false,error:{code:'INVALID_INPUT',message:'请从真实员工账号中选择负责人。'}}); return;
    }
    const result = await createDevelopmentCase({
      prisma,
      input: req.body,
      actorId: actorIdFromRequest(req),
      trustedActor: extractActorFromRequest(req) ?? undefined,
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { ...DEVELOPMENT_OPERATION_STATUS, INVALID_INPUT: 400, INVALID_ASSIGNEE: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, INVALID_TYPE: 400, INVALID_STAGE: 400, DUPLICATE_CODE: 409, CREATE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
      return;
    }
    const doc = result.data!.case;
    onDataChange?.({ entity: 'development', action: 'create', ids: [doc.id] });
    res.status(201).json({
      ok: true,
      case: {
        ...doc,
        createdAt: Number(doc.createdAt),
        updatedAt: Number(doc.updatedAt),
        deletedAt: null,
        convertedAt: null,
        tags: doc.tags || [],
      },
    });
  });

  // ─── PUT /:id ─── Update development case ───
  router.put('/:id', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    // task ERP-P1-development-mutation-route-foundation: route 只调 service
    const result = await updateDevelopmentCase({
      prisma,
      caseId: req.params.id,
      input: req.body,
      actorId: actorIdFromRequest(req),
      trustedActor: extractActorFromRequest(req) ?? undefined,
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { ...DEVELOPMENT_OPERATION_STATUS, INVALID_INPUT: 400, INVALID_ASSIGNEE: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, INVALID_STAGE: 400, INVALID_TYPE: 400, INVALID_TRANSITION: 409, NOT_FOUND: 404, UPDATE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
      return;
    }
    const doc = result.data!.case;
    onDataChange?.({ entity: 'development', action: 'update', ids: [doc.id] });
    res.json({
      ok: true,
      case: {
        ...doc,
        createdAt: Number(doc.createdAt),
        updatedAt: Number(doc.updatedAt),
        deletedAt: doc.deletedAt ? Number(doc.deletedAt) : null,
        convertedAt: doc.convertedAt ? Number(doc.convertedAt) : null,
        tags: doc.tags || [],
      },
    });
  });

  // ─── PATCH /:id/stage ─── Update stage (with validation) ───
  router.patch('/:id/stage', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    // task ERP-P1-development-mutation-route-foundation: route 只调 service
    const { stage, nextAction } = req.body || {};
    const result = await updateDevelopmentStage({
      prisma,
      caseId: req.params.id,
      stage,
      nextAction,
      actorId: actorIdFromRequest(req),
      trustedActor: extractActorFromRequest(req) ?? undefined,
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { ...DEVELOPMENT_OPERATION_STATUS, INVALID_STAGE: 400, INVALID_TRANSITION: 400, REVIEW_REQUIRED: 400, NOT_FOUND: 404, STAGE_UPDATE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
      return;
    }
    const doc = result.data!.case;
    onDataChange?.({ entity: 'development', action: 'stage-change', ids: [doc.id] });
    res.json({
      ok: true,
      case: {
        ...doc,
        createdAt: Number(doc.createdAt),
        updatedAt: Number(doc.updatedAt),
        deletedAt: doc.deletedAt ? Number(doc.deletedAt) : null,
        convertedAt: doc.convertedAt ? Number(doc.convertedAt) : null,
        tags: doc.tags || [],
      },
    });
  });

  // ─── POST /:id/review — 5A 样衣评审 ───
  router.post('/:id/review', requireWrite, requireQcReview, async (req: Request, res: Response) => {
    try {
      const { reviewStatus, reviewNote } = req.body || {};
      if (!['passed', 'failed'].includes(reviewStatus)) {
        return res.status(400).json({ ok: false, error: { code: 'INVALID_REVIEW_STATUS', message: 'reviewStatus must be passed or failed' } });
      }
      const updated = await prisma.$transaction(async tx => {
        await assertDevelopmentOperationalWrite(tx, req.params.id, 'update');
        const existing = await tx.developmentCase.findFirst({ where: { id: req.params.id, deletedAt: null } });
        if (!existing) throw new DevelopmentDomainError('NOT_FOUND', 'Development case not found');
        if (existing.sampleCategory !== '5a') throw new DevelopmentDomainError('NOT_5A', 'Only 5A samples require review');
        const saved = await tx.developmentCase.update({
          where: { id: req.params.id },
          data: { reviewStatus, reviewNote: reviewNote || null, reviewerId: actorIdFromRequest(req) || null,
            reviewDate: todayLocalKey(), updatedAt: BigInt(Date.now()) },
        });
        await writeRouteAuditLog({ prisma: tx, actorId: actorIdFromRequest(req), source: 'development:5a-review',
          operation: 'review_development_case', targetType: 'DevelopmentCase', targetId: req.params.id,
          before: { reviewStatus: existing.reviewStatus }, after: { reviewStatus, reviewNote: reviewNote || null } });
        return saved;
      });
      onDataChange?.({ entity: 'development', action: 'review', ids: [req.params.id] });
      res.json({
        ok: true,
        case: {
          ...updated,
          createdAt: Number(updated.createdAt),
          updatedAt: Number(updated.updatedAt),
          deletedAt: updated.deletedAt ? Number(updated.deletedAt) : null,
          convertedAt: updated.convertedAt ? Number(updated.convertedAt) : null,
          tags: updated.tags || [],
        },
      });
    } catch (e: any) {
      const failure = safeRouteError(e instanceof DevelopmentDomainError ? e : undefined, { fallbackCode: 'REVIEW_FAILED', fallbackMessage: '开发评审保存失败，请重试' });
      res.status(failure.status).json({ ok: false, error: { code: failure.code, message: failure.message } });
    }
  });

  // ─── GET /:id/outputs — DR-053 阶段 1：开发案确认成果列表（封样/样品 → 档案 → 工厂） ───
  // 供转单/直接返单选择版本与工厂（结果=可下单的版本载体）。
  router.get('/:id/outputs', requireDevRead, async (req: Request, res: Response) => {
    try {
      const caseId = req.params.id;
      const [seals, samples] = await Promise.all([
        prisma.sealSample.findMany({ where: { developmentCaseId: caseId, deletedAt: null } }),
        prisma.sample.findMany({ where: { sourceCaseId: caseId, deletedAt: null } }),
      ]);
      // 关联档案摘要（封样 convertedProductAssetId / 样品 productAssetId）
      const assetIds = [...new Set([
        ...seals.map((s: any) => s.convertedProductAssetId).filter(Boolean),
        ...samples.map((s: any) => s.productAssetId).filter(Boolean),
      ])];
      const assets = assetIds.length
        ? await prisma.productAsset.findMany({ where: { id: { in: assetIds }, deletedAt: null }, select: { id: true, sku: true, name: true, mainCategory: true } })
        : [];
      const assetById = new Map(assets.map((a: any) => [a.id, a]));

      const sealOutputs = seals
        .filter((s: any) => ['sealed', 'converted'].includes(s.status) && assetById.has(s.convertedProductAssetId))
        .map((s: any) => ({
          confirmedSourceType: 'SealSample',
          confirmedSourceId: s.id,
          code: s.sealCode,
          name: s.name ?? null,
          status: s.status,
          supplierRelationId: s.supplierRelationId ?? null,
          supplierName: s.supplierName ?? null,
          productAsset: assetById.get(s.convertedProductAssetId) ?? null,
        }));
      const sampleOutputs = samples
        .filter((s: any) => ['sealed', 'approved', 'confirmed'].includes(s.status) && assetById.has(s.productAssetId))
        .map((s: any) => ({
          confirmedSourceType: 'Sample',
          confirmedSourceId: s.id,
          code: s.code,
          name: `${s.type}${s.subType ? ` · ${s.subType}` : ''}`,
          status: s.status,
          supplierRelationId: s.supplierRelationId ?? null,
          supplierName: s.supplierName ?? null,
          productAsset: assetById.get(s.productAssetId) ?? null,
        }));
      res.json({ ok: true, outputs: [...sealOutputs, ...sampleOutputs] });
    } catch (err: any) {
      logger.error('[development] GET /:id/outputs failed', { error: err?.message || String(err) });
      const failure = safeRouteError(err, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '确认成果暂时读取失败，请稍后重试。' });
      res.status(failure.status).json({ ok: false, error: { code: failure.code, message: failure.message } });
    }
  });

  // ─── POST /:id/convert ─── Convert development case to order ───
  // Two modes:
  //   (a) "Link to existing order" — pass { orderId, orderPo } in the body.
  //   (b) "Auto-create order from this case" — pass { autoCreate: true,
  //       orderPo?, customer?, millName?, dueDate?, productName? }. Server
  //       generates a new Order using the dev case as the source of truth
  //       (customerRelationId, supplierRelationId, productAssetId, etc.).
  //
  // In both modes the case is marked approved + completedDate, linked to the
  // resulting order, and the cross-module EntityLink graph is updated.
  // task ERP-P1: route 调用 convertDevCaseToOrder service（route + Agent flow 共用契约）
  // W-C 族 C：convert 从 legacy HIGH_RISK 收编为矩阵 scope 门（SALES/SM 持 products:write；
  // 开发转订单是 S1 主链日常，订单创建本身的信用/状态门禁由 orderService 链各自兜底）
  router.post('/:id/convert', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    try {
      const { orderId, orderPo, autoCreate, customer, millName, dueDate, productName, quantity, quoteAmount, confirmedSourceType, confirmedSourceId, millRelationId, clientRequestId } = req.body || {};
      const wantAutoCreate = Boolean(autoCreate) || (!orderId && !orderPo);
      const result = await convertDevCaseToOrder({
        prisma,
        caseId: req.params.id,
        mode: wantAutoCreate ? 'autoCreate' : 'link',
        orderId, orderPo, customer, millName, dueDate, productName, quantity, quoteAmount,
        // DR-053 阶段 1：确认成果 + 工厂 ID + 幂等键
        confirmedSourceType, confirmedSourceId, millRelationId, clientRequestId,
        actorId: actorIdFromRequest(req),
        trustedActor: (() => {
          const signed = createAuthService().verifyToken(pickRequestToken(req));
          if (!signed?.userId || (signed as any).kind === 'customer' || !Array.isArray(signed.roles) || signed.userId !== extractActorFromRequest(req)?.userId) throw new DevelopmentDomainError('UNAUTHORIZED', '原凭据与当前主体不一致。');
          return signed;
        })(),
      });
      if (!result.ok) {
        const statusCodeMap: Record<string, number> = { ...DEVELOPMENT_OPERATION_STATUS, DEV_CASE_NOT_FOUND: 404, ORDER_NOT_FOUND: 404, INVALID_INPUT: 400, CASE_CANCELLED: 400, INVALID_STAGE: 409, ASSET_REQUIRED: 409, CONFIRMED_SOURCE_NOT_FOUND: 404, CONFIRMED_SOURCE_NOT_APPROVED: 409, MILL_MISMATCH: 409, CONVERT_FAILED: 500 };
        res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
        return;
      }
      const doc = result.data!.case;
      const createdOrder = result.data!.order;
      onDataChange?.({ entity: 'development', action: 'convert', ids: [doc.id] });
      if (createdOrder) onDataChange?.({ entity: 'orders', action: 'create-from-dev', ids: [doc.linkedOrderId] });

      res.json({
        ok: true,
        recovered: result.data!.recovered ?? false,
        moqCheck: result.data!.moqCheck ?? null,
        case: {
          ...doc,
          createdAt: Number(doc.createdAt),
          updatedAt: Number(doc.updatedAt),
          deletedAt: doc.deletedAt ? Number(doc.deletedAt) : null,
          convertedAt: doc.convertedAt ? Number(doc.convertedAt) : null,
          tags: doc.tags || [],
        },
        order: createdOrder
          ? {
              ...createdOrder,
              importedAt: Number(createdOrder.importedAt),
              createdAt: Number(createdOrder.createdAt),
              updatedAt: Number(createdOrder.updatedAt),
            }
          : null,
      });
    } catch (err: any) {
      logger.error('[development] POST /:id/convert failed', { error: err?.message || String(err) });
      const safe = safeRouteError(err, {fallbackCode:'CONVERT_FAILED',fallbackMessage:'开发转单失败，请稍后重试。'});
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  // ─── POST /:id/sample-nodes/ensure — 幂等创建三级节点（Phase B4）───
  // 消双轨 L-2：样衣节点写已随前端卸挂停用；确认锚点统一 SampleBatch.confirmStatus
  router.post('/:id/sample-nodes/ensure', requireWrite, requireDevWrite, async (_req: Request, res: Response) => {
    res.status(410).json({ ok: false, error: { code: 'GONE', message: '样衣节点（SampleNode）写已随消双轨退役，成衣轮次请走样品批次（SampleBatch）统一管理' } });
  });

  // ─── PATCH /:id/sample-nodes/:level — 推进样衣节点状态机（Phase B4）───
  // 消双轨 L-2：写端点停用（410）；既有确认锚点读已切 SampleBatch，前端已卸挂 SampleNodesPanel
  router.patch('/:id/sample-nodes/:level', requireWrite, requireDevWrite, async (_req: Request, res: Response) => {
    res.status(410).json({ ok: false, error: { code: 'GONE', message: '样衣节点（SampleNode）写已随消双轨退役，成衣轮次请走样品批次（SampleBatch）统一管理' } });
  });

  // ─── 面料链（DR-050）开发供应商 ─────────────────────────────────────
  router.get('/:id/suppliers', requireDevRead, async (req: Request, res: Response) => {
    const r = await listDevelopmentSuppliers(prisma, req.params.id);
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, suppliers: r.data.suppliers });
  });
  router.post('/:id/suppliers', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await addDevelopmentSupplier({ prisma, caseId: req.params.id, input: req.body || {}, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'supplier-add', ids: [req.params.id] });
    res.status(201).json({ ok: true, supplier: r.data.supplier });
  });
  router.patch('/suppliers/:sid', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await updateDevelopmentSupplier({ prisma, supplierId: req.params.sid, input: req.body || {}, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, supplier: r.data.supplier });
  });
  router.delete('/suppliers/:sid', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await removeDevelopmentSupplier({ prisma, supplierId: req.params.sid, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, supplier: r.data.supplier });
  });

  // ─── 面料链（DR-050）统一样品批次 ───────────────────────────────────
  router.get('/:id/batches', requireDevRead, async (req: Request, res: Response) => {
    const r = await listSampleBatches(prisma, req.params.id, extractActorFromRequest(req) ?? undefined);
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, batches: r.data.batches });
  });
  router.post('/:id/batches', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await createSampleBatch({ prisma, caseId: req.params.id, input: req.body || {}, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'batch-add', ids: [req.params.id] });
    res.status(201).json({ ok: true, batch: r.data.batch, batches: r.data.batches });
  });
  router.patch('/sample-versions/:versionId/task', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await updateDevelopmentSampleVersionTask({ prisma, versionId: req.params.versionId, actorId: actorIdFromRequest(req) || '', trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip || null, input: req.body || {} });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'sample-version-task-update', ids: [r.data.item.developmentCaseId, req.params.versionId] });
    res.json({ ok: true, item: r.data.item });
  });
  router.patch('/sample-rounds/:roundId/requirements', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await updateDevelopmentSampleRoundRequirements({ prisma, roundId: req.params.roundId, actorId: actorIdFromRequest(req) || '', trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip || null, input: req.body || {} });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'sample-round-requirements-update', ids: [r.data.item.developmentCaseId, req.params.roundId] });
    res.json({ ok: true, item: r.data.item });
  });
  router.post('/:id/sample-versions/:versionId/confirmations', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r=await recordDevelopmentVersionConfirmation({prisma,caseId:req.params.id,versionId:req.params.versionId,
      actorId:actorIdFromRequest(req)||'',trustedActor:extractActorFromRequest(req)??undefined,input:req.body??{},ip:req.ip??null});
    if(!r.ok){res.status(r.error.status).json({ok:false,error:r.error});return;}
    onDataChange?.({entity:'development',action:'version-confirmation',ids:[req.params.id,req.params.versionId,r.data.item.id]});
    res.status(201).json({ok:true,item:r.data.item});
  });
  router.post('/:id/sample-versions/:parentVersionId/minors', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r=await createDevelopmentSampleMinorVersionCommand({prisma,caseId:req.params.id,parentVersionId:req.params.parentVersionId,
      actorId:actorIdFromRequest(req)||'',trustedActor:extractActorFromRequest(req)??undefined,input:req.body??{},ip:req.ip??null});
    if(!r.ok){res.status(r.error.status).json({ok:false,error:r.error});return;}
    onDataChange?.({entity:'development',action:'sample-minor-version',ids:[req.params.id,req.params.parentVersionId,r.data.item.id]});
    res.status(201).json({ok:true,item:r.data.item});
  });
  router.get('/:id/version-confirmations', requireDevRead, async (req: Request, res: Response) => {
    const versionIds=typeof req.query.versionIds==='string'?req.query.versionIds.split(',').filter(Boolean):undefined;
    const r=await listDevelopmentVersionConfirmations({prisma,caseId:req.params.id,versionIds,
      actorId:actorIdFromRequest(req)||'',trustedActor:extractActorFromRequest(req)??undefined});
    if(!r.ok){res.status(r.error.status).json({ok:false,error:r.error});return;}
    res.json({ok:true,...r.data});
  });
  router.post('/:id/batches/:bid/return-results', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await recordDevelopmentSampleReturnResults({ prisma, caseId: req.params.id, batchId: req.params.bid,
      input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip ?? null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'sample-return-results', ids: [req.params.id, req.params.bid] });
    res.json({ ok: true, batch: r.data.batch });
  });
  router.post('/:id/batches/:bid/qc-review', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await requestDevelopmentSampleQualityReview({ prisma, caseId: req.params.id, batchId: req.params.bid,
      requestKey: String(req.body?.requestKey ?? ''), sampleVersionId: req.body?.sampleVersionId, routingTeamId: req.body?.routingTeamId,
      actorId: actorIdFromRequest(req) || '', trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip ?? null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'sample-qc-requested', ids: [req.params.id, req.params.bid, r.data.item.id] });
    res.status(201).json({ ok: true, item: r.data.item });
  });
  router.post('/:id/qc-reviews/:reviewId/acknowledge', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await acknowledgeDevelopmentSampleQualityReview({ prisma, caseId: req.params.id, reviewId: req.params.reviewId,
      requestKey: String(req.body?.requestKey ?? ''), actorId: actorIdFromRequest(req) || '', trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip ?? null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'sample-qc-acknowledged', ids: [req.params.id, req.params.reviewId] });
    res.json({ ok: true, item: r.data.item });
  });
  router.patch('/batches/:bid', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await updateSampleBatch({ prisma, batchId: req.params.bid, input: req.body || {}, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, batch: r.data.batch });
  });
  router.delete('/batches/:bid', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await deleteSampleBatch({ prisma, batchId: req.params.bid, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, batch: r.data.batch });
  });
  router.patch('/batches/:bid/stage', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const { action } = req.body || {};
    const r = await advanceSampleBatchStage({ prisma, batchId: req.params.bid, action, input: req.body || {}, actorId: actorIdFromRequest(req) || '', trustedActor: (req as any).actor, ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'batch-stage', ids: [req.params.bid] });
    res.json({ ok: true, batch: r.data.batch });
  });
  router.post('/batches/:bid/customer-feedback', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await submitBatchCustomerFeedback({ prisma, batchId: req.params.bid, input: req.body || {}, actorId: actorIdFromRequest(req) || '', trustedActor: (req as any).actor, ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'batch-feedback', ids: [req.params.bid] });
    res.json({ ok: true, batch: r.data.batch });
  });
  // DR-054 阶段 B：批次级确认（确认锚点=批次；防重复确认）
  router.post('/batches/:bid/confirm', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await confirmSampleBatch({ prisma, batchId: req.params.bid, actorId: actorIdFromRequest(req) || '', trustedActor: (req as any).actor, input: req.body || {}, ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'batch-confirm', ids: [req.params.bid] });
    res.json({ ok: true, batch: r.data.batch, sampleCount: r.data.sampleCount });
  });
  // Static compatibility proof only. No DB lookup and no business authorization
  // conclusion; the write must still pass its JWT, source and operational gates.
  router.get('/sample-room/receipt-contract', requireDevRead, requirePermission('sample:room:write'), (_req: Request, res: Response) => {
    res.json({ ok: true, receiptVersion: 2, custodyMode: 'independent-exact-receipt', autoSampleProjection: false });
  });
  // 旧批次收样兼容入口。当前返样流程在结果登记事务中已创建台账实物；
  // 此接口对新流程只核验既有记录或拒绝重复建卡，不作为第二个入库步骤。
  router.post('/batches/:bid/register-received', requireWrite, requireDevWrite, requirePermission('sample:room:write'), async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const r = await createSampleRoomService(prisma).registerReceivedBatchCards(req.params.bid, {
      receiptVersion: body.receiptVersion, cardType: body.cardType, expectedSourceRound: body.expectedSourceRound,
      warehouseId:body.warehouseId, location:body.location, locationDetail:body.locationDetail,
      expectedCaseId: body.expectedCaseId, expectedFactoryId: body.expectedFactoryId,
      physicalCardCount: body.physicalCardCount, expectedBatchUpdatedAt: body.expectedBatchUpdatedAt,
    }, actorIdFromRequest(req) || '');
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    if (r.data.created) onDataChange?.({ entity: 'development', action: 'batch-received', ids: [req.params.bid] });
    res.status(r.data.created ? 201 : 200).json({ ok: true, ...r.data });
  });

  // ─── 面料链（DR-050）封样（同厂批次组合）────────────────────────────
  router.get('/:id/seals', requireDevRead, async (req: Request, res: Response) => {
    const r = await listSealSamples(prisma, req.params.id);
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, seals: r.data.seals });
  });
  router.post('/:id/seals', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await createSealSample({ prisma, caseId: req.params.id, input: req.body || {}, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'seal-add', ids: [req.params.id] });
    res.status(201).json({ ok: true, seal: r.data.seal });
  });
  router.patch('/seals/:sealId', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await updateSealSample({ prisma, sealId: req.params.sealId, input: req.body || {}, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, seal: r.data.seal });
  });
  router.delete('/seals/:sealId', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const r = await deleteSealSample({ prisma, sealId: req.params.sealId, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, seal: r.data.seal });
  });
  router.patch('/seals/:sealId/status', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const { status } = req.body || {};
    if (status !== 'sealed') {
      res.status(400).json({ ok: false, error: { code: 'INVALID_TRANSITION', message: '封样仅支持 draft → sealed 动作；sealed → converted 走转档接口' } });
      return;
    }
    const r = await sealSampleConfirm({ prisma, sealId: req.params.sealId, actorId: actorIdFromRequest(req) || '', trustedActor: (req as any).actor, ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'seal-status', ids: [req.params.sealId] });
    res.json({ ok: true, seal: r.data.seal });
  });

  // ─── 强制转档（DR-050 面料：批次/封样 → FabricProfile；DR-051 成衣：确认样节点/封存轮次 → GarmentProfile）───
  // 按开发案类型分派：面料走 fabric 服务，成衣系（garment/pp/trim）走 garment 服务。
  router.post('/:id/convert-to-asset', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    const { sourceType, sourceId } = req.body || {};
    const devCase = await prisma.developmentCase.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!devCase) {
      res.status(404).json({ ok: false, error: { code: 'DEV_CASE_NOT_FOUND', message: `开发单 ${req.params.id} 不存在` } });
      return;
    }
    const isFabric = devCase.type === 'fabric';
    const r = isFabric
      ? await convertToFabricAsset({ prisma, caseId: req.params.id, sourceType, sourceId, sourceVersionId: req.body?.sourceVersionId, input: { requestKey: req.body?.requestKey, expectedRevision: req.body?.expectedRevision, expectedRound: req.body?.expectedRound }, actorId: actorIdFromRequest(req) || '', trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip || null })
      : await convertToGarmentAsset({ prisma, caseId: req.params.id, sourceType, sourceId, sourceRoundId: req.body?.sourceRoundId,
        sourceVersionId: req.body?.sourceVersionId, targetSampleId: req.body?.targetSampleId, requestKey: req.body?.requestKey, trustedActor: extractActorFromRequest(req) ?? undefined, actorId: actorIdFromRequest(req) || '', ip: req.ip || null });
    if (!r.ok) { res.status(r.error.status).json({ ok: false, error: r.error }); return; }
    onDataChange?.({ entity: 'development', action: 'convert-asset', ids: [req.params.id] });
    onDataChange?.({ entity: 'products', action: 'create-from-dev', ids: [r.data.asset.id] });
    res.json({ ok: true, asset: r.data.asset, case: r.data.case, conversionReceipt: r.data.conversionReceipt, ...('batch' in r.data ? { batch: r.data.batch } : {}) });
  });

  // ─── DELETE /:id ─── Soft delete ───
  // W-C 族 C：软删开发单（草稿期业务操作，无财务勾稽牵连）收编矩阵 scope 门；
  // 服务层状态机兜底（已转订单/已结案不可删）
  router.delete('/:id', requireWrite, requireDevWrite, async (req: Request, res: Response) => {
    // task ERP-P1-development-mutation-route-foundation: route 只调 service
    const result = await deleteDevelopmentCase({
      prisma,
      caseId: req.params.id,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { ...DEVELOPMENT_OPERATION_STATUS, NOT_FOUND: 404, ALREADY_DELETED: 409, CONVERTED_TO_ORDER: 409, DELETE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
      return;
    }
    onDataChange?.({ entity: 'development', action: 'delete', ids: [req.params.id] });
    res.json({ ok: true });
  });

  return router;
}
