import { extractActorFromRequest } from '../auth/middleware';
/**
 * 阶段 P1 — 定价与利润模块路由（PRD 8 / 6.2 P1），挂载于 /api/v1/pricing
 *
 * 端点：
 *   退税率表：
 *   - GET    /tax-refund-rates              — 列表（?includeInactive=true）
 *   - POST   /tax-refund-rates              — 注册 {hsCode, rate, ...}
 *   - GET    /tax-refund-rates/lookup       — 最长前缀命中查询 ?hsCode=
 *   - PATCH  /tax-refund-rates/:id          — 更新（hsCode 不可改）
 *   - DELETE /tax-refund-rates/:id          — 软删
 *   轨道 A 估算：
 *   - POST   /track-a-preview               — 纯试算（不落库；面料/纱线价可按编号命中价格历史）
 *   轨道 B 定价：
 *   - POST   /track-b-preview               — 纯试算（不落库）
 *   - GET    /calculations                  — 列表（?orderId=&quotationId=&status=）
 *   - POST   /calculations                  — 创建（派生值服务端重算）
 *   - PATCH  /calculations/:id              — 更新（重算）
 *   - DELETE /calculations/:id              — 软删
 *   订单利润表：
 *   - GET    /profit-sheets                 — 列表
 *   - POST   /profit-sheets/generate/:orderId — 生成/重生成（幂等覆盖）
 *   - GET    /profit-sheets/order/:orderId  — 按订单查询
 *   - DELETE /profit-sheets/order/:orderId  — 删除（硬删，重生成可恢复）
 *   原材料价格：
 *   - GET    /material-prices               — 列表（?materialType=&materialCode=&from=&to=）
 *   - POST   /material-prices               — 录入
 *   - GET    /material-prices/trend         — 趋势 ?materialType=&materialCode=
 *   - GET    /material-prices/latest        — 最新价 ?materialType=&materialCode=
 *   - PATCH  /material-prices/:id           — 更新
 *   - DELETE /material-prices/:id           — 软删
 *   佣金规则（P2）：
 *   - GET    /commission-rules              — 列表（?includeInactive=true）
 *   - POST   /commission-rules              — 创建（同中间人启用中规则唯一）
 *   - GET    /commission-rules/lookup       — 命中查询 ?intermediaryRelationId=
 *   - PATCH  /commission-rules/:id          — 更新
 *   - DELETE /commission-rules/:id          — 软删
 *   成本三环（2026-09-30 · 三阶段成本模型咬合件）：
 *   - GET    /orders/:orderId/cost-rings    — 报价估算/BOM 目标/利润表实际 三环对比（只读，缺环透明披露）
 *
 * 服务端门禁（W-C 权限收口）：认证门 createModuleAuthGuard 之上叠加 scope 门——
 *   读类端点（GET + track-a/track-b 纯试算）→ requirePermission('pricing:read')；
 *   写端点 → requireJwtForWrite + requirePermission('pricing:write')（JWT-only，API-Key 拒）。
 * 敏感字段遮罩（S3 走查阶段二修复）：pricing:read 仅放行端点；响应序列化后按 actor
 *   的 sensitive:* scope 服务端遮罩（sensitiveMask.ts）——无 sensitive:cost 遮罩成本
 *   字段（purchaseCost/netUsdCost/price 等 → null，成本明细行数组 → []）、无
 *   sensitive:profit 遮罩毛利/毛利率/利润率、无 sensitive:commission 遮罩佣金率/佣金
 *   金额。遮罩在服务端执行，前端遮罩不算数。
 */

import { Router, Request, Response } from 'express';
// ★ D4：佣金/中间人的订单应付闭环（佣金应付 = 给中间人开一张应付发票）
import { getOrderCommission, createCommissionPayable } from './commissionPayableService';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { createPricingService, PricingCalculationInput, TaxRefundRateInput, TrackAPreviewInput, TrackBInput } from './pricingService';
import { createProfitSheetService } from './profitSheetService';
import { createCostRingsService } from './costRingsService';
import { withCurrentCostEvidence } from './currentCostEvidence';
import { createOrderPricingAccess } from './orderPricingAccess';
import { safeRouteError } from '../shared/routeError';
import { httpStatusOfCode } from '../shared/errorCodes';
import { PricingDomainError } from './pricingError';
import { createMaterialPriceService, MaterialPriceInput } from './materialPriceService';
import { createCommissionService, CommissionRuleInput } from './commissionService';
import {
  pricingSensitiveVisibility,
  maskProfitSheetRow,
  maskCostRings,
  maskFreightImpactResult,
  maskCalculationRow,
  maskTrackAResult,
  maskTrackBResult,
  maskCommissionRuleRow,
  maskCommissionLookupHit,
  maskMaterialPriceRow,
} from './sensitiveMask';

export interface PricingRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  COST_RINGS_VIEW_FAILED: '读取订单成本对比失败，请稍后重试。',
  COMMISSION_VIEW_FAILED: '读取订单佣金失败，请稍后重试。',
  COMMISSION_PAYABLE_FAILED: '佣金应付开票结果暂不可确认，请先核对原开票记录后重试。',
  TRR_LIST_FAILED: '读取退税率表失败，请稍后重试。',
  TRR_CREATE_FAILED: '退税率新增结果暂不可确认，请先刷新列表核对。',
  TRR_LOOKUP_FAILED: '查询退税率失败，请稍后重试。',
  TRR_UPDATE_FAILED: '退税率更新结果暂不可确认，请先刷新记录核对。',
  TRR_DELETE_FAILED: '退税率删除结果暂不可确认，请先刷新列表核对。',
  TRACK_A_PREVIEW_FAILED: '成本估算失败，请稍后重试。',
  TRACK_B_PREVIEW_FAILED: '退税定价试算失败，请稍后重试。',
  CALC_LIST_FAILED: '读取定价记录失败，请稍后重试。',
  CALC_CREATE_FAILED: '定价记录新增结果暂不可确认，请先刷新列表核对。',
  CALC_UPDATE_FAILED: '定价记录更新结果暂不可确认，请先刷新记录核对。',
  CALC_DELETE_FAILED: '定价记录删除结果暂不可确认，请先刷新列表核对。',
  PROFIT_LIST_FAILED: '读取订单利润表失败，请稍后重试。',
  PROFIT_GENERATE_FAILED: '利润表生成结果暂不可确认，请先刷新核对。',
  PROFIT_GET_FAILED: '读取订单利润表失败，请稍后重试。',
  PROFIT_DELETE_FAILED: '利润表删除结果暂不可确认，请先刷新列表核对。',
  FREIGHT_IMPACT_FAILED: '海运费变动重估失败，请稍后重试。',
  MP_LIST_FAILED: '读取原材料价格失败，请稍后重试。',
  MP_CREATE_FAILED: '原材料价格新增结果暂不可确认，请先刷新列表核对。',
  MP_TREND_FAILED: '读取原材料价格趋势失败，请稍后重试。',
  MP_LATEST_FAILED: '读取最新原材料价格失败，请稍后重试。',
  MP_UPDATE_FAILED: '原材料价格更新结果暂不可确认，请先刷新记录核对。',
  MP_DELETE_FAILED: '原材料价格删除结果暂不可确认，请先刷新列表核对。',
  CR_LIST_FAILED: '读取佣金规则失败，请稍后重试。',
  CR_CREATE_FAILED: '佣金规则新增结果暂不可确认，请先刷新列表核对。',
  CR_LOOKUP_FAILED: '查询佣金规则失败，请稍后重试。',
  CR_UPDATE_FAILED: '佣金规则更新结果暂不可确认，请先刷新记录核对。',
  CR_DELETE_FAILED: '佣金规则删除结果暂不可确认，请先刷新列表核对。',
};

export function createPricingRouter(options: PricingRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const pricing = createPricingService(prisma);
  const profitSheets = createProfitSheetService(prisma);
  const materialPrices = createMaterialPriceService(prisma);
  const commissions = createCommissionService(prisma);
  const costRings = createCostRingsService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'pricing', action, ids });
  const orderAccess = (req: Request) => createOrderPricingAccess(prisma, (req as any).actor,
    !requireAuth && (req as any).authSource === 'dev');

  const handleError = (res: Response, e: unknown, code: string) => {
    logger.error(`[PricingRoute] ${code}`, { error: e instanceof Error ? e.message : String(e) });
    const safe = safeRouteError(e, {
      fallbackCode: code,
      fallbackMessage: ERROR_MESSAGES[code] ?? '定价操作失败，请稍后重试。',
      status: httpStatusOfCode('INTERNAL_ERROR'),
    });
    // Only this domain's explicit validation uses its historical route code.
    // Auth, source conflicts and other typed refusals keep their own contract.
    res.status(safe.status).json({ error: {
      code: e instanceof PricingDomainError ? code : safe.code,
      message: safe.message,
      ...(safe.details === undefined ? {} : { details: safe.details }),
    } });
  };

  // ══════════════════════════════════════════════════════════════
  // 退税率表
  // ══════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════
  // 成本三环（2026-09-30 · 三阶段成本模型咬合件，只读）
  //   GET /orders/:orderId/cost-rings — 报价估算 / BOM 目标 / 利润表实际，三环对比。
  //   缺环如实置 null 并列入 missing[]；不自动生成利润表（生成走 POST /profit-sheets/generate/:orderId）。
  //   遮罩：与 maskProfitSheetRow 同一套 scope 口径（maskCostRings）。
  // ══════════════════════════════════════════════════════════════
  router.get('/orders/:orderId/cost-rings', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      await orderAccess(req).requireOrder(req.params.orderId, 'read');
      const item = await costRings.getOrderCostRings(req.params.orderId, extractActorFromRequest(req) ?? undefined);
      res.json(serializeValue({ ok: true, item: maskCostRings(serializeValue(item), pricingSensitiveVisibility(req)) }));
    } catch (e: any) {
      handleError(res, e, 'COST_RINGS_VIEW_FAILED');
    }
  });

  /**
   * ★ D4（2026-09-18）GET /orders/:orderId/commission — 某订单的佣金应付视图（只读）
   *
   * 为什么需要：佣金在定价侧算得很细（`PricingCalculation.commissionRate/commissionAmount` +
   * `CommissionRule`），但**只算不收** —— 没有任何地方能回答「这张单欠中间人多少佣金、开了没、付了没」。
   *
   * 返回：佣金总额（只算**已确认**的定价行）+ 中间人 + 已开应付 + 未开票余额 + 无法归集的原因。
   */
  router.get('/orders/:orderId/commission', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      await orderAccess(req).requireOrder(req.params.orderId, 'read');
      const r = await getOrderCommission(prisma, req.params.orderId);
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      res.json(serializeValue(r.data));
    } catch (e: any) {
      handleError(res, e, 'COMMISSION_VIEW_FAILED');
    }
  });

  /**
   * ★ D4（2026-09-18）POST /orders/:orderId/commission/payable — 开佣金应付发票（给中间人）
   *
   * 佣金应付的**落地动作**：复用既有应付链路（AP 账龄 / 付款凭证 / 供应商对账单）⇒ 真正闭环。
   * 幂等：同订单已有未作废的佣金应付发票 → 409（防重复开票）。
   * 前置：佣金总额 > 0 且中间人可解析（多行归属不同中间人时**不猜**，要求人工确认）。
   */
  router.post('/orders/:orderId/commission/payable', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      await orderAccess(req).requireOrder(req.params.orderId, 'write');
      const trustedActor = (req as any).actor;
      const actorId = trustedActor?.userId || '';
      const r = await createCommissionPayable(prisma, {
        orderId: req.params.orderId,
        dueDate: req.body?.dueDate ?? null,
        notes: req.body?.notes ?? null,
      }, actorId, trustedActor ?? null);
      if (!r.ok) return res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
      notify('commission_payable', [req.params.orderId]);
      res.status(201).json(serializeValue(r.data));
    } catch (e: any) {
      handleError(res, e, 'COMMISSION_PAYABLE_FAILED');
    }
  });

  router.get('/tax-refund-rates', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const result = await pricing.listTaxRefundRates({ includeInactive: req.query.includeInactive === 'true' });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'TRR_LIST_FAILED');
    }
  });

  router.post('/tax-refund-rates', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      const row = await pricing.createTaxRefundRate(req.body as TaxRefundRateInput, actorIdFromRequest(req));
      notify('create_tax_refund_rate', [row.id]);
      res.status(201).json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'TRR_CREATE_FAILED');
    }
  });

  // 字面路由 lookup 须在 /:id 前
  router.get('/tax-refund-rates/lookup', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const hsCode = String(req.query.hsCode ?? '');
      if (!hsCode.trim()) {
        res.status(400).json({ error: { code: 'TRR_LOOKUP_FAILED', message: 'hsCode 必填' } });
        return;
      }
      const hit = await pricing.lookupRefundRate(hsCode);
      res.json(serializeValue({ hit }));
    } catch (e: any) {
      handleError(res, e, 'TRR_LOOKUP_FAILED');
    }
  });

  router.patch('/tax-refund-rates/:id', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      const row = await pricing.updateTaxRefundRate(req.params.id, req.body ?? {}, actorIdFromRequest(req));
      notify('update_tax_refund_rate', [row.id]);
      res.json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'TRR_UPDATE_FAILED');
    }
  });

  router.delete('/tax-refund-rates/:id', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      await pricing.deleteTaxRefundRate(req.params.id, actorIdFromRequest(req));
      notify('delete_tax_refund_rate', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'TRR_DELETE_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 轨道 A 估算（纯试算，不落库；守卫口径同 track-b-preview）
  // ══════════════════════════════════════════════════════════════

  router.post('/track-a-preview', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const result = await pricing.estimateTrackA(req.body as TrackAPreviewInput);
      res.json(maskTrackAResult(serializeValue(result), pricingSensitiveVisibility(req)));
    } catch (e: any) {
      handleError(res, e, 'TRACK_A_PREVIEW_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 轨道 B 定价
  // ══════════════════════════════════════════════════════════════

  router.post('/track-b-preview', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const result = pricing.calculateTrackB(req.body as TrackBInput);
      res.json(maskTrackBResult(serializeValue(result), pricingSensitiveVisibility(req)));
    } catch (e: any) {
      handleError(res, e, 'TRACK_B_PREVIEW_FAILED');
    }
  });

  router.get('/calculations', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const result = await pricing.listCalculations({
        orderId: req.query.orderId as string | undefined,
        quotationId: req.query.quotationId as string | undefined,
        status: req.query.status as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      const vis = pricingSensitiveVisibility(req);
      const serialized = serializeValue(result);
      res.json({ ...serialized, items: serialized.items.map((c: any) => maskCalculationRow(c, vis)) });
    } catch (e: any) {
      handleError(res, e, 'CALC_LIST_FAILED');
    }
  });

  router.post('/calculations', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      const row = await pricing.createCalculation(req.body as PricingCalculationInput, actorIdFromRequest(req));
      notify('create_pricing_calculation', [row.id]);
      res.status(201).json({ ok: true, item: maskCalculationRow(serializeValue(row), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'CALC_CREATE_FAILED');
    }
  });

  router.patch('/calculations/:id', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      const row = await pricing.updateCalculation(req.params.id, req.body ?? {}, actorIdFromRequest(req));
      notify('update_pricing_calculation', [req.params.id]);
      res.json({ ok: true, item: maskCalculationRow(serializeValue(row), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'CALC_UPDATE_FAILED');
    }
  });

  router.delete('/calculations/:id', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      await pricing.deleteCalculation(req.params.id, actorIdFromRequest(req));
      notify('delete_pricing_calculation', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'CALC_DELETE_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 订单利润表
  // ══════════════════════════════════════════════════════════════

  router.get('/profit-sheets', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const orderScope = await orderAccess(req).scope('read');
      const result = await profitSheets.listProfitSheets({
        orderScope,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      const vis = pricingSensitiveVisibility(req);
      const items = await Promise.all(result.items.map((item: { orderId: string; [key: string]: any }) => withCurrentCostEvidence(prisma, item, extractActorFromRequest(req) ?? undefined)));
      const serialized = serializeValue({ ...result, items });
      res.json({ ...serialized, items: serialized.items.map((s: any) => maskProfitSheetRow(s, vis)) });
    } catch (e: any) {
      handleError(res, e, 'PROFIT_LIST_FAILED');
    }
  });

  router.post('/profit-sheets/generate/:orderId', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      await orderAccess(req).requireOrder(req.params.orderId, 'write');
      const sheet = await profitSheets.generateOrderProfitSheet(req.params.orderId, actorIdFromRequest(req), extractActorFromRequest(req) ?? undefined);
      notify('generate_profit_sheet', [req.params.orderId]);
      res.json({ ok: true, item: maskProfitSheetRow(serializeValue(await withCurrentCostEvidence(prisma, sheet, extractActorFromRequest(req) ?? undefined)), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'PROFIT_GENERATE_FAILED');
    }
  });

  router.get('/profit-sheets/order/:orderId', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      await orderAccess(req).requireOrder(req.params.orderId, 'read');
      const sheet = await profitSheets.getProfitSheetByOrder(req.params.orderId);
      if (!sheet) {
        res.status(404).json({ error: { code: 'PROFIT_GET_FAILED', message: '利润表不存在' } });
        return;
      }
      res.json({ item: maskProfitSheetRow(serializeValue(await withCurrentCostEvidence(prisma, sheet, extractActorFromRequest(req) ?? undefined)), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'PROFIT_GET_FAILED');
    }
  });

  router.delete('/profit-sheets/order/:orderId', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      await orderAccess(req).requireOrder(req.params.orderId, 'write');
      await profitSheets.deleteProfitSheet(req.params.orderId, actorIdFromRequest(req));
      notify('delete_profit_sheet', [req.params.orderId]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'PROFIT_DELETE_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // REQ2-14 海运费变动利润重估（DR-054：只读预览不落库，X-04 一屏可见）
  // ══════════════════════════════════════════════════════════════

  router.get('/freight-impact', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const result = await profitSheets.reestimateFreightImpact({
        multiplier: req.query.multiplier,
        orderId: req.query.orderId,
      });
      res.json(maskFreightImpactResult(serializeValue(result), pricingSensitiveVisibility(req)));
    } catch (e: any) {
      handleError(res, e, 'FREIGHT_IMPACT_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 原材料价格
  // ══════════════════════════════════════════════════════════════

  router.get('/material-prices', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const result = await materialPrices.listMaterialPrices({
        materialType: req.query.materialType as string | undefined,
        materialCode: req.query.materialCode as string | undefined,
        source: req.query.source as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      const vis = pricingSensitiveVisibility(req);
      const serialized = serializeValue(result);
      res.json({ ...serialized, items: serialized.items.map((p: any) => maskMaterialPriceRow(p, vis)) });
    } catch (e: any) {
      handleError(res, e, 'MP_LIST_FAILED');
    }
  });

  router.post('/material-prices', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      const row = await materialPrices.createMaterialPrice(req.body as MaterialPriceInput, actorIdFromRequest(req));
      notify('create_material_price', [row.id]);
      res.status(201).json({ ok: true, item: maskMaterialPriceRow(serializeValue(row), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'MP_CREATE_FAILED');
    }
  });

  // 字面路由 trend / latest 须在 /:id 前
  router.get('/material-prices/trend', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const items = await materialPrices.getPriceTrend({
        materialType: String(req.query.materialType ?? ''),
        materialCode: req.query.materialCode as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
      });
      const vis = pricingSensitiveVisibility(req);
      res.json({ items: serializeValue(items).map((p: any) => maskMaterialPriceRow(p, vis)) });
    } catch (e: any) {
      handleError(res, e, 'MP_TREND_FAILED');
    }
  });

  router.get('/material-prices/latest', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const materialType = String(req.query.materialType ?? '');
      const materialCode = String(req.query.materialCode ?? '');
      if (!materialCode.trim()) {
        res.status(400).json({ error: { code: 'MP_LATEST_FAILED', message: 'materialCode 必填' } });
        return;
      }
      const item = await materialPrices.getLatestPrice({ materialType, materialCode });
      res.json({ item: item ? maskMaterialPriceRow(serializeValue(item), pricingSensitiveVisibility(req)) : item });
    } catch (e: any) {
      handleError(res, e, 'MP_LATEST_FAILED');
    }
  });

  router.patch('/material-prices/:id', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      const row = await materialPrices.updateMaterialPrice(req.params.id, req.body ?? {}, actorIdFromRequest(req));
      notify('update_material_price', [req.params.id]);
      res.json({ ok: true, item: maskMaterialPriceRow(serializeValue(row), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'MP_UPDATE_FAILED');
    }
  });

  router.delete('/material-prices/:id', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      await materialPrices.deleteMaterialPrice(req.params.id, actorIdFromRequest(req));
      notify('delete_material_price', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'MP_DELETE_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 佣金规则（P2：任意百分比费率，中间人精确命中优先，默认规则兜底）
  // ══════════════════════════════════════════════════════════════

  router.get('/commission-rules', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const result = await commissions.listCommissionRules({ includeInactive: req.query.includeInactive === 'true' });
      const vis = pricingSensitiveVisibility(req);
      const serialized = serializeValue(result);
      res.json({ ...serialized, items: serialized.items.map((c: any) => maskCommissionRuleRow(c, vis)) });
    } catch (e: any) {
      handleError(res, e, 'CR_LIST_FAILED');
    }
  });

  router.post('/commission-rules', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      const row = await commissions.createCommissionRule(req.body as CommissionRuleInput, actorIdFromRequest(req));
      notify('create_commission_rule', [row.id]);
      res.status(201).json({ ok: true, item: maskCommissionRuleRow(serializeValue(row), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'CR_CREATE_FAILED');
    }
  });

  // 字面路由 lookup 须在 /:id 前；无命中返回 { hit: null }（= 无佣金）
  router.get('/commission-rules/lookup', requirePermission('pricing:read'), async (req: Request, res: Response) => {
    try {
      const hit = await commissions.lookupCommissionRate(req.query.intermediaryRelationId as string | undefined);
      res.json({ hit: maskCommissionLookupHit(serializeValue(hit), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'CR_LOOKUP_FAILED');
    }
  });

  router.patch('/commission-rules/:id', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      const row = await commissions.updateCommissionRule(req.params.id, req.body ?? {}, actorIdFromRequest(req));
      notify('update_commission_rule', [req.params.id]);
      res.json({ ok: true, item: maskCommissionRuleRow(serializeValue(row), pricingSensitiveVisibility(req)) });
    } catch (e: any) {
      handleError(res, e, 'CR_UPDATE_FAILED');
    }
  });

  router.delete('/commission-rules/:id', requireWrite, requirePermission('pricing:write'), async (req: Request, res: Response) => {
    try {
      await commissions.deleteCommissionRule(req.params.id, actorIdFromRequest(req));
      notify('delete_commission_rule', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'CR_DELETE_FAILED');
    }
  });

  return router;
}
