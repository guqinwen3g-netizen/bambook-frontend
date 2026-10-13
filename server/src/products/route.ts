import { normalizeTrimmingCatalogFields, assertTrimmingRelationReferences } from './trimmingCatalogFields';
import { randomUUID } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { writeRouteAuditLog, actorIdFromRequest } from '../audit/routeAudit';
import { createProductAsset, updateProductAsset, deleteProductAsset, parseProductAssetCost } from './productAssetMutationService';
import { resolveProductAssets, checkExclusivityForAssets, validateExclusiveCodes } from './fabricExclusivityService';
import { syncProductAssetReferences } from '../entities/sync';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { hasScope } from '../auth/permissionService';
import { maskProductCost } from './productCostVisibility';
import { readProductRelatedOrderLines } from './productRelatedOrderAccess';
import { weightToGsm } from '../lib/unitConversion';
import { logger } from '../lib/logger';
// ★ B42 A1（S0-A2 文案线）：products 域 12 处出口接真源。本域 12 处**此前都已有 logger 带原文**
//   （D51 逐处量过：12/12 有日志且带上错误对象 ⇒ 不需要先补日志，只换对外文案，诊断面不降）
import { safeRouteError } from '../shared/routeError';
import { extractActorFromRequest } from '../auth/middleware';
import { currentFabricAuthorizationActor, createFabricUseAuthorizationRequestInTx,
  createFabricUseAuthorizationCustomerConfirmationAdapter, readFabricUseAuthorizationHistory } from './fabricUseAuthorizationService';

// task ERP-P1: Decimal 输入校验（非法 cost/amount fail closed，不进 $transaction）
function isValidDecimal(v: any): boolean {
  if (v === undefined || v === null) return true; // 可选字段，未传视为合法
  // 严格校验：数字 或 合法数字字符串（正则 + isFinite）
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
    try {
      const d = new Prisma.Decimal(v);
      return d.isFinite();
    } catch {
      return false;
    }
  }
  return false;
}
import multer from 'multer';
import path from 'path';
import fs from 'fs';

export interface ProductsRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  uploadDir: string;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createProductsRouter(opts: ProductsRouterOptions): Router {
  const router = Router();

  const fabricProfileWritableKeys = [
    'id', 'articleNo', 'millOrganizationId', 'millName', 'millQuality', 'millColorCode',
    'colorDescription', 'construction', 'yarnCount', 'pattern',
    'weightValue', 'weightUnit', 'widthValue', 'widthUnit', 'widthText',
    'productionLeadDays', 'referenceBatch', 'stockStatus',
    'stockQuantity', 'stockUnit', 'moqValue', 'factoryMoqValue',
    'sampleMoqValue', 'riskNote', 'specialNote',
  ] as const;

  const garmentProfileWritableKeys = [
    'id', 'styleNo', 'productName', 'garmentCategory', 'collection', 'customer',
    'customerRelationId', 'factoryRelationId',
    'brand', 'project', 'gender', 'ageGroup', 'tags', 'silhouette', 'fit',
    'collarType', 'sleeveType', 'closureType', 'pocketDetails', 'hemDetails',
    'waistbandDetails', 'liningStructure', 'interlining', 'shoulderPad',
    'stitchDetails', 'constructionNote', 'mainFabric', 'contrastFabric',
    'liningFabric', 'ribFabric', 'pocketingFabric', 'button', 'zipper',
    'snapsEyelets', 'thread', 'labelTrims', 'packaging', 'materialUsage',
    'substituteMaterials', 'sizeRange', 'baseSize', 'measurementPoints',
    'sizeSpec', 'tolerance', 'gradingRule', 'shrinkageAllowance',
    'garmentWeight', 'colorways', 'customerColorCodes', 'fabricColorCodes',
    'garmentSku', 'barcode', 'availableSizes', 'colorImageNotes', 'moq',
    'sampleVersion', 'patternMaker', 'merchandiser', 'owner',
    'revisionHistory', 'fittingComments', 'customerComments', 'confirmedDate',
    'techPackVersion', 'factory', 'orderQuantity', 'deliveryDate',
    'targetCost', 'fobPrice', 'exwPrice', 'retailPrice', 'inspectionStandard',
    'commonDefects', 'washFinishing', 'careLabel', 'complianceTests',
    'packingMethod', 'cartonSpec', 'countryOfOrigin', 'qualityNote',
  ] as const;

  const trimmingProfileWritableKeys = [
    'id', 'trimmingCode', 'trimmingName', 'trimmingCategory', 'material',
    'specification', 'size', 'color', 'colorCode', 'finish', 'supplier',
    'supplierRelationId',
    'factory', 'brand', 'customer', 'applicableProducts', 'usagePosition',
    'unit', 'unitConsumption', 'moq', 'leadTime', 'stockStatus',
    'stockQuantity', 'stockUnit', 'price', 'currency', 'complianceTests',
    'qualityStandard', 'riskNote', 'packaging', 'careRequirement', 'notes',
    'manufacturerRelationId','images','attachments','quoteDate','quoteConditions','priceUnit','moqUnit','supplierArticleNo','categoryParameters',
  ] as const;

  const sanitizeFabricProfileInput = (input: any = {}) => {
    const out: Record<string, any> = {};
    for (const key of fabricProfileWritableKeys) {
      if (input?.[key] !== undefined) out[key] = input[key];
    }
    return out;
  };

  const sanitizeGarmentProfileInput = (input: any = {}) => {
    const out: Record<string, any> = {};
    for (const key of garmentProfileWritableKeys) {
      if (input?.[key] !== undefined) out[key] = input[key];
    }
    return out;
  };

  const sanitizeTrimmingProfileInput = (input: any = {}, existing: any = {}) => {
    const out: Record<string, any> = {};
    for (const key of trimmingProfileWritableKeys) {
      if (input?.[key] !== undefined) out[key] = input[key];
    }
    Object.assign(out, normalizeTrimmingCatalogFields(input, existing));
    return out;
  };

  // 克重归一化派生字段（服务端单一真源，客户端/导入传入值一律被覆盖）：
  // 按 weightValue+weightUnit 换算为 g/m² 存入 weightValueGsm；单位无法识别时按 gsm 原值兜底
  // （历史全库 gsm 口径；表单已收敛为单位下拉，正常不会产生未知单位）。
  const deriveWeightValueGsm = (profile: Record<string, any>): Record<string, any> => {
    const raw = profile?.weightValue;
    if (raw === undefined || raw === null) return {};
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return {};
    return { weightValueGsm: weightToGsm(value, profile.weightUnit) ?? Math.round(value * 10) / 10 };
  };

  const saveProductCollections = async (
    prisma: any,
    productAssetId: string,
    body: any,
    now: number,
    replaceExisting: boolean,
    canWriteFactoryPrices: boolean,
  ) => {
    const saveCollection = async (
      model: string,
      items: any[] | undefined,
      mapItem: (item: any, idx: number) => any,
    ) => {
      if (items === undefined) return;
      if (replaceExisting) {
        // Sales-price replacement is not permission to erase hidden purchase
        // history. Only a cost-authorized writer may replace factory rows.
        await prisma[model].deleteMany({ where: { productAssetId,
          ...(model === 'fabricPriceHistory' && !canWriteFactoryPrices ? { priceType: { not: 'factory' } } : {}) } });
      }
      if (items.length > 0) {
        await prisma[model].createMany({
          data: items.map((item, idx) => mapItem(item, idx)),
        });
      }
    };

    // P1-3 专属标记校验：isExclusive 行必须有属主锚（fail-closed 400）
    const exclusiveOwnerError = validateExclusiveCodes(body.fabricCustomerCodes ?? []);
    if (exclusiveOwnerError) {
      throw Object.assign(new Error(exclusiveOwnerError), { code: 'EXCLUSIVE_OWNER_REQUIRED', statusCode: 400 });
    }

    await saveCollection('fabricCustomerCode', body.fabricCustomerCodes, (c: any, i: number) => ({
      id: c.id || `FCC-${productAssetId}-${i}`,
      productAssetId,
      clientCode: c.clientCode ?? '',
      customerOrganizationId: c.customerOrganizationId || null,
      customerNameSnapshot: c.customerNameSnapshot || null,
      isExclusive: c.isExclusive === true,
      note: c.note || null,
      updatedAt: BigInt(now),
      deletedAt: null,
    }));

    await saveCollection('fabricCertification', body.fabricCertifications, (c: any, i: number) => ({
      id: c.id || `FCERT-${productAssetId}-${i}`,
      productAssetId,
      certification: c.certification ?? '',
      certificateNo: c.certificateNo || null,
      validUntil: c.validUntil || null,
      note: c.note || null,
      updatedAt: BigInt(now),
      deletedAt: null,
    }));

    await saveCollection('fabricPriceHistory', body.fabricPrices, (p: any, i: number) => ({
      id: p.id || `FPRICE-${productAssetId}-${i}-${now}`,
      productAssetId,
      priceType: p.priceType ?? 'factory',
      amount: new Prisma.Decimal(p.amount ?? 0),
      currency: p.currency || 'USD',
      unit: p.unit || null,
      customerOrganizationId: p.customerOrganizationId || null,
      sourceType: p.sourceType || null,
      sourceId: p.sourceId || null,
      effectiveDate: p.effectiveDate || null,
      note: p.note || null,
      updatedAt: BigInt(now),
      deletedAt: null,
    }));

    if (body.compositionLines !== undefined) {
      if (replaceExisting) {
        await prisma.fabricCompositionLine.deleteMany({ where: { productAssetId } });
      }
      for (const [i, line] of body.compositionLines.entries()) {
        const term = line.term || {};
        const termId = String(line.termId || term.id || `MCT-${productAssetId}-${i}`);
        await prisma.materialCompositionTerm.upsert({
          where: { id: termId },
          update: {
            abbreviation: term.abbreviation ?? null,
            chineseName: term.chineseName || term.englishName || term.abbreviation || termId,
            englishName: term.englishName ?? null,
            updatedAt: BigInt(now),
            deletedAt: null,
          },
          create: {
            id: termId,
            abbreviation: term.abbreviation ?? null,
            chineseName: term.chineseName || term.englishName || term.abbreviation || termId,
            englishName: term.englishName ?? null,
            updatedAt: BigInt(now),
            deletedAt: null,
          },
        });
        await prisma.fabricCompositionLine.create({
          data: {
            id: line.id || `FCL-${productAssetId}-${i}`,
            productAssetId,
            termId,
            percentage: Number(line.percentage ?? 0),
            sortOrder: i,
            updatedAt: BigInt(now),
            deletedAt: null,
          },
        });
      }
    }
  };

  // 统一认证守卫：JWT（cookie/Bearer，走 jwt.verify 验签）优先，API-Key 次之
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));

  // 写操作必须 JWT（API-Key 不可写）—— 修复原 requireWrite 仅检查 token 是否存在、不验签的漏洞
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });

  // W-C 权限收口：scope 门叠加——读类端点 products:read（含 POST 语义的只读查询/预检），
  // 写端点 requireWrite + products:write（JWT-only）。
  router.get('/assets', requirePermission('products:read'), async (req, res) => {
    try {
      const mainCategory = typeof req.query.mainCategory === 'string' ? req.query.mainCategory : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const rawLimit = Number(req.query.limit);
      const rawOffset = Number(req.query.offset);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 500;
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

      const where = {
        deletedAt: null,
        ...(mainCategory ? { mainCategory } : {}),
        ...(search
          ? {
              OR: [
                { sku: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
                { fabricProfile: { is: { millQuality: { contains: search, mode: 'insensitive' } } } },
                { fabricProfile: { is: { articleNo: { contains: search, mode: 'insensitive' } } } },
                { garmentProfile: { is: { styleNo: { contains: search, mode: 'insensitive' } } } },
                { garmentProfile: { is: { garmentCategory: { contains: search, mode: 'insensitive' } } } },
                { garmentProfile: { is: { customer: { contains: search, mode: 'insensitive' } } } },
                { trimmingProfile: { is: { trimmingCode: { contains: search, mode: 'insensitive' } } } },
                { trimmingProfile: { is: { trimmingName: { contains: search, mode: 'insensitive' } } } },
                { trimmingProfile: { is: { trimmingCategory: { contains: search, mode: 'insensitive' } } } },
                { trimmingProfile: { is: { supplier: { contains: search, mode: 'insensitive' } } } },
                { fabricCustomerCodes: { some: { clientCode: { contains: search, mode: 'insensitive' }, deletedAt: null } } },
              ],
            }
          : {}),
      };

      const [assets, total] = await Promise.all([
        (opts.prisma as any).productAsset.findMany({
          where,
          include: productAssetInclude(),
          orderBy: { updatedAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        (opts.prisma as any).productAsset.count({ where }),
      ]);

      return res.json({
        ok: true,
        assets: serializeProductAssets(assets, req),
        total,
        limit,
        offset,
        hasMore: offset + assets.length < total,
      });
    } catch (e: any) {
      logger.error('[products/list] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_LIST_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── P1-3 客户专属面料预检（只读；前端行级警示用，写路径校验走 fabricExclusivityService） ──
  router.post('/fabric-exclusivity/check', requirePermission('products:read'), async (req, res) => {
    try {
      const body = req.body || {};
      const fabricCode = String(body.fabricCode ?? '').trim();
      const keys: any = {
        productAssetId: body.productAssetId ?? null,
        sku: fabricCode || (body.sku ?? null),
        articleNo: fabricCode || (body.articleNo ?? null),
        millQuality: body.millQuality ?? null,
        clientCode: body.clientCode ?? (fabricCode || null),
        clientCodeCustomerHint: body.customerRelationId ?? null,
        clientCodeGlobalFallback: false, // 预检宽语义：不做全局客供品号兜底，防异义碰撞误报
      };
      const assets = await resolveProductAssets(opts.prisma, keys);
      const violations = await checkExclusivityForAssets(
        opts.prisma,
        assets.map((a: any) => a.id),
        { customerRelationId: body.customerRelationId ?? null, customerName: body.customerName ?? null },
      );
      return res.json({ ok: true, allowed: violations.length === 0, violations, matchedAssets: serializeProductAssets(assets, req) });
    } catch (e: any) {
      logger.error('[products/fabric-exclusivity/check] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_EXCLUSIVITY_CHECK_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // Customer-authorized use is a separate immutable evidence flow. Product write
  // grants only employee permission to prepare a request; the customer proof is
  // still required before a use version can become active.
  const fabricAuthorizationAdapter = createFabricUseAuthorizationCustomerConfirmationAdapter({ prisma: opts.prisma });
  router.get('/assets/:id/fabric-use-authorizations', requirePermission('products:read'), async (req, res) => {
    try {
      const actor = await opts.prisma.$transaction((tx: any) => currentFabricAuthorizationActor(tx, extractActorFromRequest(req), 'products:read'));
      const result = await readFabricUseAuthorizationHistory(opts.prisma, { productAssetId: req.params.id, actor });
      return res.json({ ok: true, ...result });
    } catch (error: any) {
      const r = safeRouteError(error, { fallbackCode: 'FABRIC_AUTHORIZATION_READ_FAILED', fallbackMessage: '读取面料客户授权失败' });
      return res.status(r.status).json({ error: { code: r.code, message: r.message } });
    }
  });

  router.post('/assets/:id/fabric-use-authorizations', requireWrite, requirePermission('products:write'), async (req, res) => {
    try {
      const result = await (opts.prisma as any).$transaction(async (tx: any) => {
        const actor = await currentFabricAuthorizationActor(tx, extractActorFromRequest(req), 'products:write');
        const requestResult = await createFabricUseAuthorizationRequestInTx(tx, {
          productAssetId: req.params.id,
          granteeRelationId: req.body?.granteeRelationId,
          operation: req.body?.operation,
          allowedActions: req.body?.allowedActions,
          effectiveFrom: req.body?.effectiveFrom,
          effectiveUntil: req.body?.effectiveUntil,
          expectedVersionId: req.body?.expectedVersionId ?? null,
          requestKey: req.body?.requestKey,
          actor,
          ip: req.ip,
        });
        const target = await fabricAuthorizationAdapter.inspect(tx, requestResult.request.id, actor, 'read');
        return { ...requestResult, confirmationTarget: { targetType: fabricAuthorizationAdapter.targetType,
          targetId: requestResult.request.id, ...target } };
      });
      return res.status(result.replayed ? 200 : 201).json({ ok: true, request: {
        operation: result.request.operation, recordedAt: String(result.request.recordedAt), granteeName: result.granteeName,
      }, replayed: result.replayed, confirmationTarget: result.confirmationTarget });
    } catch (error: any) {
      const r = safeRouteError(error, { fallbackCode: 'FABRIC_AUTHORIZATION_REQUEST_FAILED', fallbackMessage: '创建面料客户授权申请失败' });
      return res.status(r.status).json({ error: { code: r.code, message: r.message } });
    }
  });

  router.post('/assets/query', requirePermission('products:read'), async (req, res) => {
    try {
      const normalized = normalizeProductAssetQuery(req.body || {});
      const where = buildProductAssetQueryWhere(normalized);
      const orderBy = productAssetQueryOrderBy(normalized.sort);
      const aggregate = normalized.aggregate;

      if (aggregate === 'count') {
        const total = await (opts.prisma as any).productAsset.count({ where });
        return res.json({
          ok: true,
          dataSource: 'bambook-data-center',
          entity: 'ProductAsset',
          aggregate,
          count: total,
          filters: normalized.filters,
          sort: normalized.sort,
        });
      }

      const [assets, total] = await Promise.all([
        (opts.prisma as any).productAsset.findMany({
          where,
          include: productAssetInclude(),
          orderBy,
          take: normalized.limit,
          skip: normalized.offset,
        }),
        (opts.prisma as any).productAsset.count({ where }),
      ]);

      return res.json({
        ok: true,
        dataSource: 'bambook-data-center',
        entity: 'ProductAsset',
        aggregate,
        assets: serializeProductAssets(assets, req),
        total,
        count: assets.length,
        limit: normalized.limit,
        offset: normalized.offset,
        hasMore: normalized.offset + assets.length < total,
        filters: normalized.filters,
        sort: normalized.sort,
      });
    } catch (e: any) {
      logger.error('[products/query] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_QUERY_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.get('/assets/:id', requirePermission('products:read'), async (req, res) => {
    try {
      const asset = await (opts.prisma as any).productAsset.findFirst({
        where: { id: req.params.id, deletedAt: null },
        include: {
          ...productAssetInclude(),
          classificationLinks: {
            where: { deletedAt: null },
            include: { classification: true },
          },
        },
      });

      if (!asset) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Product asset not found' });
      }

      const relatedOrderLines = await readProductRelatedOrderLines(
        opts.prisma, (req as any).actor ?? extractActorFromRequest(req), asset,
      );

      return res.json({ ok: true, asset: serializeProductAssets(asset, req), relatedOrderLines: serializeBigInts(relatedOrderLines) });
    } catch (e: any) {
      logger.error('[products/detail] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_DETAIL_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.post('/assets', requireWrite, requirePermission('products:write'), async (req, res) => {
    try {
      const now = Date.now();
      const body = req.body || {};
      const canWriteFactoryPrices = hasScope((req as any).actor, 'sensitive:cost');
      if (!canWriteFactoryPrices && Array.isArray(body.fabricPrices) && body.fabricPrices.some((price: any) => (price?.priceType ?? 'factory') === 'factory')) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '工厂采购价写入须有 sensitive:cost 权限；其他档案字段可分别编辑。' });
      }
      const sku = String(body.sku || '').trim() || (body.mainCategory === 'Trimmings' ? `TRIM-${randomUUID().toUpperCase()}` : '');
      if (sku) body.sku = sku;
      const name = String(body.name || '').trim();
      const mainCategory = String(body.mainCategory || '').trim();

      if (!sku || !name || !mainCategory) {
        return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'sku, name and mainCategory are required' });
      }
      // task ERP-P1: cost Decimal 校验（事务前 fail closed）
      if (!parseProductAssetCost(body.cost).ok) {
        return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'cost must be a valid decimal' });
      }
      // task ERP-P1: fabricPrices amount 校验（事务前 fail closed）
      if (Array.isArray(body.fabricPrices)) {
        for (const p of body.fabricPrices) {
          if (!isValidDecimal(p?.amount) || ((p?.priceType ?? 'factory') === 'factory' && p?.amount == null)) {
            return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'fabricPrices[].amount must be a valid decimal' });
          }
        }
      }

      const fabricProfileInput = sanitizeFabricProfileInput(body.fabricProfile);
      // 克重归一化派生（服务端单一真源）
      if (body.fabricProfile) Object.assign(fabricProfileInput, deriveWeightValueGsm(body.fabricProfile));
      const garmentProfileInput = sanitizeGarmentProfileInput(body.garmentProfile);
      const trimmingProfileInput = sanitizeTrimmingProfileInput(body.trimmingProfile);
      const asset = await (opts.prisma as any).$transaction(async (tx: any) => {
        // task Agent-P1: 复用 createProductAsset service（route + Agent 共用，不手写 DB mutation）
        const svcResult = await createProductAsset({ prisma: opts.prisma, body, actorId: actorIdFromRequest(req), ip: req.ip, tx });
        if (!svcResult.ok) throw new Error(svcResult.error!.message);
        const created = svcResult.data!.asset;
        // route-specific: 嵌套 profile create（Agent flow 不涉及，route 专属扩展）
        if (body.fabricProfile) {
          await tx.fabricProfile.create({ data: { id: String(fabricProfileInput.id || `FAB-${now}`), productAssetId: created.id, ...fabricProfileInput, updatedAt: BigInt(now), deletedAt: null } });
        }
        if (body.garmentProfile) {
          await tx.garmentProfile.create({ data: { id: String(garmentProfileInput.id || `GAR-${now}`), productAssetId: created.id, ...garmentProfileInput, updatedAt: BigInt(now), deletedAt: null } });
        }
        if (body.trimmingProfile) {
          await assertTrimmingRelationReferences(tx, trimmingProfileInput);
          await tx.trimmingProfile.create({ data: { id: String(trimmingProfileInput.id || `TRIM-${now}`), productAssetId: created.id, ...trimmingProfileInput, updatedAt: BigInt(now), deletedAt: null } });
        }
        await saveProductCollections(tx, created.id, body, now, false, canWriteFactoryPrices);
        const createdAsset = await tx.productAsset.findFirst({
          where: { id: created.id, deletedAt: null },
          include: productAssetInclude(),
        });
        // 阶段 D / D2：产品↔Relation FK 入图（EntityLink），与档案写入同事务
        await syncProductAssetReferences(opts.prisma, createdAsset, { source: 'api:products' }, tx);
        return createdAsset;
      });

      opts.onDataChange?.({ entity: 'products', action: 'create', ids: [asset.id] });
      return res.status(201).json({ ok: true, asset: serializeProductAssets(asset, req) });
    } catch (e: any) {
      logger.error('[products/create] failed', { error: e?.message || String(e) });
      // P1-3 专属属主缺失等业务校验 → 透传 statusCode（默认 500）
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_CREATE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── PATCH /assets/:id — 部分更新产品及其面料档案 ──────────────
  router.patch('/assets/:id', requireWrite, requirePermission('products:write'), async (req, res) => {
    try {
      const now = Date.now();
      let existing = await (opts.prisma as any).productAsset.findFirst({
        where: { id: req.params.id, deletedAt: null },
        include: productAssetInclude(),
      });
      if (!existing) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Product asset not found' });
      }

      const body = req.body || {};
      const canWriteFactoryPrices = hasScope((req as any).actor, 'sensitive:cost');
      const existingFactoryIds = new Set((existing.fabricPrices || []).filter((price: any) => price.priceType === 'factory').map((price: any) => price.id));
      if (!canWriteFactoryPrices && Array.isArray(body.fabricPrices) && body.fabricPrices.some((price: any) =>
        (price?.priceType ?? 'factory') === 'factory' || existingFactoryIds.has(price?.id))) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '工厂采购价写入须有 sensitive:cost 权限；其他档案字段可分别编辑。' });
      }
      // task ERP-P1: cost Decimal 校验（事务前 fail closed）
      if (!parseProductAssetCost(body.cost).ok) {
        return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'cost must be a valid decimal' });
      }
      // task ERP-P1: fabricPrices amount 校验（事务前 fail closed）
      if (Array.isArray(body.fabricPrices)) {
        for (const p of body.fabricPrices) {
          if (!isValidDecimal(p?.amount) || ((p?.priceType ?? 'factory') === 'factory' && p?.amount == null)) {
            return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'fabricPrices[].amount must be a valid decimal' });
          }
        }
      }

      // task ERP-P1: PATCH 全部包 $transaction（业务写入 + 嵌套集合 + AuditLog 同事务，fail closed）
      const refreshed = await (opts.prisma as any).$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "ProductAsset" WHERE "id"=$1 FOR UPDATE', req.params.id);
        existing = await tx.productAsset.findFirst({ where: { id: req.params.id, deletedAt: null }, include: productAssetInclude() });
        if (!existing) throw Object.assign(new Error('Product asset not found'), { code: 'NOT_FOUND', statusCode: 404 });
        // ── FabricProfile ─────────────────────────────────────────
        if (body.fabricProfile && existing.fabricProfile) {
          const fp: Record<string, any> = { updatedAt: BigInt(now) };
          const fpKeys = [
            'articleNo', 'millOrganizationId', 'millName', 'millQuality', 'millColorCode',
            'colorDescription', 'construction', 'yarnCount', 'pattern',
            'weightValue', 'weightUnit', 'widthValue', 'widthUnit', 'widthText',
            'productionLeadDays', 'referenceBatch', 'stockStatus',
            'stockQuantity', 'stockUnit', 'moqValue', 'factoryMoqValue',
            'sampleMoqValue', 'riskNote', 'specialNote',
          ] as const;
          for (const key of fpKeys) {
            if (body.fabricProfile[key] !== undefined) fp[key] = body.fabricProfile[key];
          }
          // 克重归一化派生（服务端单一真源）：仅按本次提交或既有值合并计算
          if (body.fabricProfile.weightValue !== undefined || body.fabricProfile.weightUnit !== undefined) {
            Object.assign(fp, deriveWeightValueGsm({
              weightValue: fp.weightValue !== undefined ? fp.weightValue : existing.fabricProfile.weightValue,
              weightUnit: fp.weightUnit !== undefined ? fp.weightUnit : existing.fabricProfile.weightUnit,
            }));
          }
          await tx.fabricProfile.update({
            where: { productAssetId: existing.id },
            data: fp,
          });
        } else if (body.fabricProfile && !existing.fabricProfile) {
          const fabricProfileInput = sanitizeFabricProfileInput(body.fabricProfile);
          Object.assign(fabricProfileInput, deriveWeightValueGsm(body.fabricProfile));
          await tx.fabricProfile.create({
            data: {
              id: fabricProfileInput.id || `FAB-${now}`,
              productAssetId: existing.id,
              ...fabricProfileInput,
              updatedAt: BigInt(now),
              deletedAt: null,
            },
          });
        }

        // ── GarmentProfile ────────────────────────────────────────
        if (body.garmentProfile && existing.garmentProfile) {
          const gp: Record<string, any> = { updatedAt: BigInt(now) };
          const garmentProfileInput = sanitizeGarmentProfileInput(body.garmentProfile);
          for (const key of garmentProfileWritableKeys) {
            if (key !== 'id' && garmentProfileInput[key] !== undefined) gp[key] = garmentProfileInput[key];
          }
          await tx.garmentProfile.update({
            where: { productAssetId: existing.id },
            data: gp,
          });
        } else if (body.garmentProfile && !existing.garmentProfile) {
          const garmentProfileInput = sanitizeGarmentProfileInput(body.garmentProfile);
          await tx.garmentProfile.create({
            data: {
              id: garmentProfileInput.id || `GAR-${now}`,
              productAssetId: existing.id,
              ...garmentProfileInput,
              updatedAt: BigInt(now),
              deletedAt: null,
            },
          });
        }

        // ── TrimmingProfile ───────────────────────────────────────
        if (body.trimmingProfile && existing.trimmingProfile) {
          const tp: Record<string, any> = { updatedAt: BigInt(now) };
          const trimmingProfileInput = sanitizeTrimmingProfileInput(body.trimmingProfile, existing.trimmingProfile);
          await assertTrimmingRelationReferences(tx, trimmingProfileInput);
          for (const key of trimmingProfileWritableKeys) {
            if (key !== 'id' && trimmingProfileInput[key] !== undefined) tp[key] = trimmingProfileInput[key];
          }
          await tx.trimmingProfile.update({
            where: { productAssetId: existing.id },
            data: tp,
          });
        } else if (body.trimmingProfile && !existing.trimmingProfile) {
          const trimmingProfileInput = sanitizeTrimmingProfileInput(body.trimmingProfile);
          await assertTrimmingRelationReferences(tx, trimmingProfileInput);
          await tx.trimmingProfile.create({
            data: {
              id: trimmingProfileInput.id || `TRIM-${now}`,
              productAssetId: existing.id,
              ...trimmingProfileInput,
              updatedAt: BigInt(now),
              deletedAt: null,
            },
          });
        }

        // ── 嵌套集合：先删旧的，再插新的（全量替换策略）─────────
        await saveProductCollections(tx, existing.id, body, now, true, canWriteFactoryPrices);

        // ── 主表最后更新 ──────────────────────────────────────────
        // task Agent-P1: 复用 updateProductAsset service（route + Agent 共用）
        const patchFields: Record<string, unknown> = {};
        for (const key of ['sku', 'name', 'mainCategory', 'subCategoryId', 'season', 'techPackUrl', 'imageUrl', 'status'] as const) {
          if (body[key] !== undefined) patchFields[key] = body[key];
        }
        if (body.cost !== undefined) patchFields.cost = body.cost;
        const svcResult = await updateProductAsset({ prisma: opts.prisma, assetId: existing.id, patch: patchFields, actorId: actorIdFromRequest(req), ip: req.ip, tx });
        if (!svcResult.ok) throw new Error(svcResult.error!.message);

        // 回传更新后的完整记录
        const refreshedAsset = await tx.productAsset.findFirst({
          where: { id: existing.id, deletedAt: null },
          include: productAssetInclude(),
        });
        // 阶段 D / D2：产品↔Relation FK 入图（EntityLink），与档案写入同事务
        await syncProductAssetReferences(opts.prisma, refreshedAsset, { source: 'api:products' }, tx);
        return refreshedAsset;
      });

      opts.onDataChange?.({ entity: 'products', action: 'update', ids: [existing.id] });
      return res.json({ ok: true, asset: serializeProductAssets(refreshed, req) });
    } catch (e: any) {
      logger.error('[products/update] failed', { error: e?.message || String(e) });
      // P1-3 专属属主缺失等业务校验 → 透传 statusCode（默认 500）
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_UPDATE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── DELETE /assets/:id — 软删除产品 ─────────────────────────
  router.delete('/assets/:id', requireWrite, requirePermission('products:write'), async (req, res) => {
    try {
      const now = BigInt(Date.now());
      const existing = await (opts.prisma as any).productAsset.findFirst({
        where: { id: req.params.id, deletedAt: null },
      });
      if (!existing) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Product asset not found' });
      }

      // task ERP-P1: DELETE 包 $transaction（软删主表 + Profile + 嵌套集合 + AuditLog 同事务，fail closed）
      await (opts.prisma as any).$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "ProductAsset" WHERE "id"=$1 FOR UPDATE', req.params.id);
        const locked = await tx.productAsset.findFirst({ where: { id: req.params.id, deletedAt: null } });
        if (!locked) throw Object.assign(new Error('Product asset not found'), { code: 'NOT_FOUND', statusCode: 404 });
        // task Agent-P1: 复用 deleteProductAsset service（route + Agent 共用主表软删 + AuditLog）
        const svcResult = await deleteProductAsset({ prisma: opts.prisma, assetId: existing.id, actorId: actorIdFromRequest(req), ip: req.ip, tx });
        if (!svcResult.ok) throw new Error(svcResult.error!.message);

        // 读 existing 的 include（findFirst 没带 include，需单独查 fabricProfile 是否存在）
        const withProfile = await tx.productAsset.findFirst({ where: { id: existing.id }, include: { fabricProfile: true } });
        if (withProfile?.fabricProfile) {
          await tx.fabricProfile.updateMany({
            where: { productAssetId: existing.id },
            data: { deletedAt: now, updatedAt: now },
          });
        }
        await tx.garmentProfile.updateMany({
          where: { productAssetId: existing.id },
          data: { deletedAt: now, updatedAt: now },
        });
        await tx.trimmingProfile.updateMany({
          where: { productAssetId: existing.id },
          data: { deletedAt: now, updatedAt: now },
        });

        for (const model of ['fabricCustomerCode', 'fabricPriceHistory', 'fabricCertification', 'fabricCompositionLine']) {
          await tx[model].updateMany({
            where: { productAssetId: existing.id },
            data: { deletedAt: now, updatedAt: now },
          });
        }
      });

      opts.onDataChange?.({ entity: 'products', action: 'delete', ids: [existing.id] });
      return res.json({ ok: true, deleted: existing.id });
    } catch (e: any) {
      logger.error('[products/delete] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_DELETE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── Image upload/delete/reorder/primary ────────────────────────

  const imageUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, file, cb) => {
        const dir = path.join(opts.uploadDir, 'products', _req.params.id);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
      else cb(new Error('Only image files (jpeg, png, webp, gif) are allowed'));
    },
  });

  // POST /assets/:id/images — upload one or more images
  router.post('/assets/:id/images', requireWrite, requirePermission('products:write'), imageUpload.array('files', 10), async (req, res) => {
    try {
      const productId = req.params.id;
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'NO_FILES', message: 'No image files provided' });
      }

      const existing = await (opts.prisma as any).productAsset.findFirst({
        where: { id: productId, deletedAt: null },
      });
      if (!existing) {
        // Clean up uploaded files
        for (const f of files) { try { fs.unlinkSync(f.path); } catch { /* best-effort cleanup */ } }
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Product asset not found' });
      }

      const now = Date.now();
      let created: any[] = [];
      try {
        created = await (opts.prisma as any).$transaction(async (tx: any) => {
          // Count existing images for sortOrder
          const existingCount = await tx.productImage.count({
            where: { productAssetId: productId, deletedAt: null },
          });

          const imgs: any[] = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const filePath = path.join('products', productId, f.filename);
            const isPrimary = existingCount === 0 && i === 0;
            const img = await tx.productImage.create({
              data: {
                id: `IMG-${productId}-${now}-${i}`,
                productAssetId: productId,
                filePath,
                fileName: f.originalname,
                mimeType: f.mimetype,
                fileSize: f.size,
                sortOrder: existingCount + i,
                isPrimary,
                uploadedAt: BigInt(now),
              },
            });
            imgs.push(img);
          }

          // Update imageUrl on ProductAsset to the primary image
          const primary = imgs.find((img: any) => img.isPrimary);
          if (primary) {
            await tx.productAsset.update({
              where: { id: productId },
              data: { imageUrl: `/api/uploads/${primary.filePath}` },
            });
          }

          // task ERP-P1: AuditLog 同事务闭环（fail closed）
          await writeRouteAuditLog({
            prisma: tx, actorId: actorIdFromRequest(req), source: 'route:product-image:upload',
            operation: 'upload_product_images', targetType: 'ProductImage', targetId: productId,
            after: { productAssetId: productId, uploadedCount: imgs.length, imageIds: imgs.map((im: any) => im.id) },
            ip: req.ip,
          });

          return imgs;
        });
      } catch (txErr: any) {
        // task ERP-P1: DB/audit 失败 → best-effort 清理本次上传文件，不留下 ProductImage DB 行
        for (const f of files) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } }
        logger.error('[products/upload-image] tx failed', { error: txErr?.message || String(txErr) });
        const r = safeRouteError(txErr, { fallbackCode: 'PRODUCT_IMAGE_UPLOAD_FAILED' });
        return res.status(r.status).json({ error: r.code, message: r.message });
      }

      opts.onDataChange?.({ entity: 'products', action: 'update', ids: [productId] });
      return res.status(201).json({ ok: true, images: serializeBigInts(created) });
    } catch (e: any) {
      // 外层 catch：multer 已落盘但 productId 校验等失败，清理文件
      const files = (req.files as Express.Multer.File[] | undefined) || [];
      for (const f of files) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } }
      logger.error('[products/upload-image] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_IMAGE_UPLOAD_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // DELETE /assets/:id/images/:imageId — soft-delete an image
  router.delete('/assets/:id/images/:imageId', requireWrite, requirePermission('products:write'), async (req, res) => {
    try {
      const { id: productId, imageId } = req.params;
      const img = await (opts.prisma as any).productImage.findFirst({
        where: { id: imageId, productAssetId: productId, deletedAt: null },
      });
      if (!img) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Image not found' });
      }

      const now = BigInt(Date.now());
      // task ERP-P1: 包 $transaction（soft-delete + primary promotion + imageUrl + AuditLog 同事务，fail closed）
      await (opts.prisma as any).$transaction(async (tx: any) => {
        await tx.productImage.update({
          where: { id: imageId },
          data: { deletedAt: now },
        });

        // If deleted image was primary, promote the next one
        if (img.isPrimary) {
          const nextPrimary = await tx.productImage.findFirst({
            where: { productAssetId: productId, deletedAt: null },
            orderBy: { sortOrder: 'asc' },
          });
          if (nextPrimary) {
            await tx.productImage.update({
              where: { id: nextPrimary.id },
              data: { isPrimary: true },
            });
            await tx.productAsset.update({
              where: { id: productId },
              data: { imageUrl: `/api/uploads/${nextPrimary.filePath}` },
            });
          } else {
            await tx.productAsset.update({
              where: { id: productId },
              data: { imageUrl: null },
            });
          }
        }

        // AuditLog 同事务闭环（fail closed）
        await writeRouteAuditLog({
          prisma: tx, actorId: actorIdFromRequest(req), source: 'route:product-image:delete',
          operation: 'delete_product_image', targetType: 'ProductImage', targetId: imageId,
          before: { id: imageId, productAssetId: productId, isPrimary: img.isPrimary },
          after: { id: imageId, deletedAt: Number(now) },
          ip: req.ip,
        });
      });

      // task ERP-P1: 文件删除保持 DB 事务成功后 best-effort（不把文件系统失败伪装成 DB 回滚）
      const fullPath = path.join(opts.uploadDir, img.filePath);
      if (fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch { /* ignore - best effort */ }
      }

      opts.onDataChange?.({ entity: 'products', action: 'update', ids: [productId] });
      return res.json({ ok: true, deleted: imageId });
    } catch (e: any) {
      logger.error('[products/delete-image] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_DELETE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // PATCH /assets/:id/images/:imageId/primary — set as primary image
  router.patch('/assets/:id/images/:imageId/primary', requireWrite, requirePermission('products:write'), async (req, res) => {
    try {
      const { id: productId, imageId } = req.params;
      const img = await (opts.prisma as any).productImage.findFirst({
        where: { id: imageId, productAssetId: productId, deletedAt: null },
      });
      if (!img) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Image not found' });
      }

      // task ERP-P1: 包 $transaction（unset old primary + set new + imageUrl + AuditLog 同事务）
      await (opts.prisma as any).$transaction(async (tx: any) => {
        // Unset all other primary images for this product
        await tx.productImage.updateMany({
          where: { productAssetId: productId, deletedAt: null, isPrimary: true },
          data: { isPrimary: false },
        });

        // Set this one as primary
        await tx.productImage.update({
          where: { id: imageId },
          data: { isPrimary: true },
        });

        // Update imageUrl on ProductAsset
        await tx.productAsset.update({
          where: { id: productId },
          data: { imageUrl: `/api/uploads/${img.filePath}` },
        });

        // AuditLog 同事务闭环（fail closed）
        await writeRouteAuditLog({
          prisma: tx, actorId: actorIdFromRequest(req), source: 'route:product-image:set-primary',
          operation: 'set_primary_product_image', targetType: 'ProductImage', targetId: imageId,
          before: { id: imageId, isPrimary: img.isPrimary },
          after: { id: imageId, isPrimary: true, productAssetId: productId },
          ip: req.ip,
        });
      });

      opts.onDataChange?.({ entity: 'products', action: 'update', ids: [productId] });
      return res.json({ ok: true });
    } catch (e: any) {
      logger.error('[products/set-primary] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_UPDATE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // PATCH /assets/:id/images/reorder — batch update sortOrder
  router.patch('/assets/:id/images/reorder', requireWrite, requirePermission('products:write'), async (req, res) => {
    try {
      const productId = req.params.id;
      const { orders }: { orders: Array<{ id: string; sortOrder: number }> } = req.body;
      if (!Array.isArray(orders)) {
        return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'orders array required' });
      }

      // task ERP-P1: 包 $transaction（批量 reorder + AuditLog 同事务）
      await (opts.prisma as any).$transaction(async (tx: any) => {
        for (const item of orders) {
          await tx.productImage.update({
            where: { id: item.id },
            data: { sortOrder: item.sortOrder },
          });
        }

        // AuditLog 同事务闭环（fail closed）
        await writeRouteAuditLog({
          prisma: tx, actorId: actorIdFromRequest(req), source: 'route:product-image:reorder',
          operation: 'reorder_product_images', targetType: 'ProductImage', targetId: productId,
          after: { productAssetId: productId, orders },
          ip: req.ip,
        });
      });

      opts.onDataChange?.({ entity: 'products', action: 'update', ids: [productId] });
      return res.json({ ok: true });
    } catch (e: any) {
      logger.error('[products/reorder-images] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'PRODUCT_UPDATE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}

function productAssetInclude() {
  return {
    fabricProfile: true,
    garmentProfile: true,
    trimmingProfile: true,
    fabricCustomerCodes: { where: { deletedAt: null } },
    fabricPrices: { where: { deletedAt: null }, orderBy: { updatedAt: 'desc' } },
    fabricCertifications: { where: { deletedAt: null } },
    compositionLines: {
      where: { deletedAt: null },
      include: { term: true },
      orderBy: { sortOrder: 'asc' },
    },
    images: {
      where: { deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    },
  };
}

/** All asset response paths share the real loaded-scope/credential-ceiling check. */
function serializeProductAssets<T>(value: T, req: Request): T {
  return serializeBigInts(maskProductCost(value, (req as any).actor));
}

function serializeBigInts<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  // Prisma Decimal 是带 s/e/d 的 object，直接 JSON 化会变成 {s,e,d} 结构——
  // 前端 String(percentage) 会得到 "[object Object]"（成分合计 NaN → 保存按钮禁用）。
  // 统一转 number（与 finance 序列化口径一致）。
  if (value instanceof Prisma.Decimal) return Number(value) as T;
  if (Array.isArray(value)) return value.map(serializeBigInts) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = serializeBigInts(item);
    }
    return out as T;
  }
  return value;
}

function normalizeProductAssetQuery(input: any) {
  const filters = input && typeof input.filters === 'object' ? input.filters : {};
  const sort = input && typeof input.sort === 'object' ? input.sort : {};
  return {
    entity: cleanText(input.entity) || 'ProductAsset',
    aggregate: cleanText(input.aggregate) === 'count' ? 'count' : 'list',
    query: cleanText(input.query),
    mainCategory: cleanText(input.mainCategory),
    filters: {
      certifications: arrayOfText(filters.certifications),
      stockStatus: cleanText(filters.stockStatus),
      supplier: cleanText(filters.supplier),
      color: cleanText(filters.color),
      compositionTerms: arrayOfText(filters.compositionTerms),
      weightMin: finiteNumber(filters.weightMin),
      weightMax: finiteNumber(filters.weightMax),
      fieldFilters: normalizeProductFieldFilters(filters.fieldFilters),
    },
    sort: {
      field: cleanText(sort.field) || 'updatedAt',
      direction: cleanText(sort.direction).toLowerCase() === 'asc' ? 'asc' : 'desc',
    },
    limit: numberInput(input.limit, 20, 1, 500),
    offset: numberInput(input.offset, 0, 0, 1_000_000),
  };
}

function buildProductAssetQueryWhere(input: ReturnType<typeof normalizeProductAssetQuery>) {
  if (input.entity !== 'ProductAsset') {
    return { AND: [{ deletedAt: null }, { id: '__unsupported_entity__' }] };
  }
  const and: any[] = [{ deletedAt: null }];
  if (input.mainCategory) {
    and.push({ mainCategory: { contains: input.mainCategory, mode: 'insensitive' } });
  }
  if (input.query) {
    const textContains = { contains: input.query, mode: 'insensitive' };
    and.push({
      OR: [
        { id: input.query },
        { sku: textContains },
        { name: textContains },
        { mainCategory: textContains },
        { subCategoryId: textContains },
        { fabricProfile: { is: { articleNo: textContains } } },
        { fabricProfile: { is: { millQuality: textContains } } },
        { fabricProfile: { is: { millColorCode: textContains } } },
        { fabricProfile: { is: { colorDescription: textContains } } },
        { garmentProfile: { is: { styleNo: textContains } } },
        { garmentProfile: { is: { productName: textContains } } },
        { trimmingProfile: { is: { trimmingCode: textContains } } },
        { trimmingProfile: { is: { trimmingName: textContains } } },
        { fabricCustomerCodes: { some: { deletedAt: null, clientCode: textContains } } },
        { fabricCertifications: { some: { deletedAt: null, certification: textContains } } },
      ],
    });
  }
  for (const certification of input.filters.certifications) {
    and.push({ fabricCertifications: { some: { deletedAt: null, certification: { contains: certification, mode: 'insensitive' } } } });
  }
  if (input.filters.stockStatus) {
    and.push({
      OR: [
        { status: { contains: input.filters.stockStatus, mode: 'insensitive' } },
        { fabricProfile: { is: { stockStatus: { contains: input.filters.stockStatus, mode: 'insensitive' } } } },
        { trimmingProfile: { is: { stockStatus: { contains: input.filters.stockStatus, mode: 'insensitive' } } } },
      ],
    });
  }
  if (input.filters.supplier) {
    and.push({
      OR: [
        { fabricProfile: { is: { millOrganizationId: { contains: input.filters.supplier, mode: 'insensitive' } } } },
        { trimmingProfile: { is: { supplier: { contains: input.filters.supplier, mode: 'insensitive' } } } },
        { trimmingProfile: { is: { factory: { contains: input.filters.supplier, mode: 'insensitive' } } } },
      ],
    });
  }
  if (input.filters.color) {
    and.push({
      OR: [
        { fabricProfile: { is: { millColorCode: { contains: input.filters.color, mode: 'insensitive' } } } },
        { fabricProfile: { is: { colorDescription: { contains: input.filters.color, mode: 'insensitive' } } } },
        { trimmingProfile: { is: { color: { contains: input.filters.color, mode: 'insensitive' } } } },
        { trimmingProfile: { is: { colorCode: { contains: input.filters.color, mode: 'insensitive' } } } },
      ],
    });
  }
  for (const term of input.filters.compositionTerms) {
    and.push({
      compositionLines: {
        some: {
          deletedAt: null,
          term: {
            is: {
              OR: [
                { abbreviation: { contains: term, mode: 'insensitive' } },
                { chineseName: { contains: term, mode: 'insensitive' } },
                { englishName: { contains: term, mode: 'insensitive' } },
              ],
            },
          },
        },
      },
    });
  }
  const weightWhere: any = {};
  if (input.filters.weightMin != null) weightWhere.gte = input.filters.weightMin;
  if (input.filters.weightMax != null) weightWhere.lte = input.filters.weightMax;
  if (Object.keys(weightWhere).length) {
    // 克重区间统一按归一化 g/m² 过滤（weightValueGsm）
    and.push({ fabricProfile: { is: { weightValueGsm: weightWhere } } });
  }
  for (const filter of input.filters.fieldFilters) {
    const where = productAssetFieldFilterWhere(filter);
    if (where) and.push(where);
  }
  return and.length === 1 ? and[0] : { AND: and };
}

function productAssetQueryOrderBy(sort: { field: string; direction: string }) {
  const direction = sort.direction === 'asc' ? 'asc' : 'desc';
  if (sort.field === 'sku') return { sku: direction };
  if (sort.field === 'name') return { name: direction };
  if (sort.field === 'status') return { status: direction };
  return { updatedAt: direction };
}

function productAssetFieldFilterWhere(filter: { path: string; operator: string; value: unknown }) {
  const textValue = cleanText(filter.value);
  const numericValue = finiteNumber(filter.value);
  const textScalar = filter.operator === 'equals'
    ? { equals: textValue, mode: 'insensitive' }
    : { contains: textValue, mode: 'insensitive' };
  const numberScalar = filter.operator === 'gte'
    ? { gte: numericValue }
    : filter.operator === 'lte'
      ? { lte: numericValue }
      : numericValue;

  switch (filter.path) {
    case 'sku':
    case 'name':
    case 'mainCategory':
    case 'subCategoryId':
    case 'season':
    case 'status':
      return textValue ? { [filter.path]: textScalar } : null;
    case 'updatedAt':
      return numericValue == null ? null : { updatedAt: numberScalar };
    case 'fabric.articleNo':
      return textValue ? { fabricProfile: { is: { articleNo: textScalar } } } : null;
    case 'fabric.millQuality':
      return textValue ? { fabricProfile: { is: { millQuality: textScalar } } } : null;
    case 'fabric.millOrganizationId':
      return textValue ? { fabricProfile: { is: { millOrganizationId: textScalar } } } : null;
    case 'fabric.millColorCode':
      return textValue ? { fabricProfile: { is: { millColorCode: textScalar } } } : null;
    case 'fabric.colorDescription':
      return textValue ? { fabricProfile: { is: { colorDescription: textScalar } } } : null;
    case 'fabric.weightValue':
      // 数值比较一律按归一化 g/m²（weightValueGsm）口径
      return numericValue == null ? null : { fabricProfile: { is: { weightValueGsm: numberScalar } } };
    case 'fabric.stockStatus':
      return textValue ? { fabricProfile: { is: { stockStatus: textScalar } } } : null;
    case 'fabric.certification':
      return textValue ? { fabricCertifications: { some: { deletedAt: null, certification: textScalar } } } : null;
    case 'fabric.customerCode':
      return textValue ? { fabricCustomerCodes: { some: { deletedAt: null, OR: [{ clientCode: textScalar }, { customerNameSnapshot: textScalar }] } } } : null;
    case 'fabric.compositionTerm':
      return textValue ? { compositionLines: { some: { deletedAt: null, term: { is: { OR: [{ abbreviation: textScalar }, { chineseName: textScalar }, { englishName: textScalar }] } } } } } : null;
    case 'fabric.compositionPercentage':
      return numericValue == null ? null : { compositionLines: { some: { deletedAt: null, percentage: numberScalar } } };
    case 'garment.styleNo':
      return textValue ? { garmentProfile: { is: { styleNo: textScalar } } } : null;
    case 'garment.customer':
      return textValue ? { garmentProfile: { is: { customer: textScalar } } } : null;
    case 'trimming.trimmingCode':
      return textValue ? { trimmingProfile: { is: { trimmingCode: textScalar } } } : null;
    case 'trimming.supplier':
      return textValue ? { trimmingProfile: { is: { supplier: textScalar } } } : null;
    default:
      return null;
  }
}

function normalizeProductFieldFilters(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item: any) => ({
    path: cleanText(item?.path),
    operator: normalizeProductOperator(item?.operator),
    value: item?.value,
  })).filter(item => item.path && item.value !== undefined && item.value !== null && item.value !== '').slice(0, 16);
}

function normalizeProductOperator(value: unknown) {
  const operator = cleanText(value).toLowerCase();
  if (operator === 'equals' || operator === 'gte' || operator === 'lte') return operator;
  return 'contains';
}

function arrayOfText(value: unknown) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean).slice(0, 20) : [];
}

function cleanText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function finiteNumber(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
}

function numberInput(value: unknown, fallback: number, min: number, max: number) {
  const next = Math.floor(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.min(Math.max(next, min), max);
}
