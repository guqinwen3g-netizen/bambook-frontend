/**
 * routeV2.ts — Phase 1-03/1-04 财务/成本域 V2 路由
 *
 * 挂载点：/api/v2/finance
 *
 * 路由表：
 *   GET    /summary              — AR/AP 看板聚合
 *   GET    /quotations           — 报价单列表
 *   GET    /quotations/:id       — 报价单详情
 *   POST   /quotations           — 创建报价单
 *   PUT    /quotations/:id       — 更新报价单
 *   DELETE /quotations/:id       — 软删除报价单
 *   POST   /quotations/:id/apply-pricing     — 应用双轨定价（Track A/B）
 *   GET    /quotations/:id/pricing-check     — 获取定价偏差校验
 *   POST   /quotations/:id/generate-pi       — 从报价单生成形式发票（PI）
 *   GET    /invoices             — 发票列表
 *   GET    /invoices/:id         — 发票详情
 *   POST   /invoices             — 创建发票
 *   PUT    /invoices/:id         — 更新发票
 *   DELETE /invoices/:id         — 软删除发票
 *   POST   /invoices/:id/convert-to-receivable — PI 转换为正式应收发票
 *   GET    /payments             — 收付款凭证列表
 *   GET    /payments/:id         — 凭证详情
 *   POST   /payments             — 创建凭证
 *   PUT    /payments/:id         — 更新凭证
 *   DELETE /payments/:id         — 软删除凭证
 *   GET    /vat-invoices         — VAT 发票列表
 *   GET    /vat-invoices/:id     — VAT 发票详情
 *   POST   /vat-invoices         — 创建 VAT 发票
 *   PUT    /vat-invoices/:id     — 更新 VAT 发票
 *   DELETE /vat-invoices/:id     — 软删除 VAT 发票
 *   POST   /vat-invoices/:id/transition — VAT 发票状态流转
 *   GET    /fx-settlements       — 结汇水单列表
 *   POST   /fx-settlements       — 创建结汇水单
 *   DELETE /fx-settlements/:id   — 软删除结汇水单
 *   GET    /fx-settlements/ledger — 外汇台账
 *   GET    /fx-settlements/voucher-summary/:voucherId — 凭证核销摘要
 *   GET    /outward-remittances  — 付汇水单列表
 *   POST   /outward-remittances  — 创建付汇水单
 *   DELETE /outward-remittances/:id — 软删除付汇水单
 *   GET    /outward-remittances/voucher-summary/:voucherId — 凭证付汇摘要
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { createFinanceServiceV2, type FinanceDocType } from './financeServiceV2';
import { getQuotationPricingService } from './quotationPricingService';
import { getProformaInvoiceService } from './proformaInvoiceService';
import { proformaInvoiceHttpError } from './proformaInvoiceHttpError';
import { isProformaAccessCode } from './proformaInvoiceAccess';
import { safeRouteError } from '../shared/routeError';
import { lookupErrorCode } from '../shared/errorCodes';
import {
  createVatInvoice,
  updateVatInvoice,
  deleteVatInvoice,
  transitionVatInvoiceStatus,
  listVatInvoices,
  getVatInvoice,
} from './vatInvoiceService';
import {
  createFxSettlement,
  deleteFxSettlement,
  getVoucherSettlementSummary,
  getFxLedger,
} from './fxSettlementService';
import {
  createOutwardRemittance,
  deleteOutwardRemittance,
  getVoucherRemittanceSummary,
} from './outwardRemittanceService';

export interface FinanceV2RouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createFinanceV2Router(opts: FinanceV2RouterOptions): Router {
  const router = Router();

  const guard = createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  router.use(guard);

  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  const svc = createFinanceServiceV2(opts.prisma);

  function actorOf(req: Request) {
    return extractActorFromRequest(req);
  }

  function parseFilter(req: Request): any {
    return {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      ownerId: typeof req.query.ownerId === 'string' ? req.query.ownerId : undefined,
      departmentId: typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined,
      customerRelationId: typeof req.query.customerRelationId === 'string' ? req.query.customerRelationId : undefined,
      orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
      sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
    };
  }

  const STATUS_MAP: Record<string, number> = {
    UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION_FAILED: 400,
    NOT_FOUND: 404, SEQUENCE_FAILED: 500, INTERNAL_ERROR: 500,
  };

  // ── 通用 CRUD 工厂（减少重复代码）──
  function registerCrudRoutes(docType: FinanceDocType, basePath: string, readScope: string, writeScope: string, deleteScope: string) {
    router.get(`/${basePath}`, requirePermission(readScope as any), async (req, res) => {
      const result = await svc.list(docType, actorOf(req), parseFilter(req));
      if (!result.ok) return res.status(STATUS_MAP[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error!.code, message: result.error!.message });
      return res.json({ ok: true, ...result.data });
    });

    router.get(`/${basePath}/:id`, requirePermission(readScope as any), async (req, res) => {
      const result = await svc.get(docType, actorOf(req), req.params.id);
      if (!result.ok) return res.status(STATUS_MAP[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error!.code, message: result.error!.message, ...(result.error!.details === undefined ? {} : { details: result.error!.details }) });
      return res.json({ ok: true, [docType === 'quotation' ? 'quotation' : docType === 'invoice' ? 'invoice' : 'payment']: result.data });
    });

    router.post(`/${basePath}`, requireWrite, requirePermission(writeScope as any), async (req, res) => {
      const result = await svc.create(docType, actorOf(req), req.body || {}, { ip: req.ip || null });
      if (!result.ok) return res.status(STATUS_MAP[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error!.code, message: result.error!.message, ...(result.error!.details === undefined ? {} : { details: result.error!.details }) });
      return res.json({ ok: true, [docType === 'quotation' ? 'quotation' : docType === 'invoice' ? 'invoice' : 'payment']: result.data });
    });

    router.put(`/${basePath}/:id`, requireWrite, requirePermission(writeScope as any), async (req, res) => {
      const result = await svc.update(docType, actorOf(req), req.params.id, req.body || {}, { ip: req.ip || null });
      if (!result.ok) return res.status(STATUS_MAP[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error!.code, message: result.error!.message, ...(result.error!.details === undefined ? {} : { details: result.error!.details }) });
      return res.json({ ok: true, [docType === 'quotation' ? 'quotation' : docType === 'invoice' ? 'invoice' : 'payment']: result.data });
    });

    router.delete(`/${basePath}/:id`, requireWrite, requirePermission(deleteScope as any), async (req, res) => {
      const result = await svc.softDelete(docType, actorOf(req), req.params.id, { requestKey: req.body?.requestKey, expectedUpdatedAt: req.body?.expectedUpdatedAt });
      if (!result.ok) return res.status(STATUS_MAP[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error!.code, message: result.error!.message, ...(result.error!.details === undefined ? {} : { details: result.error!.details }) });
      return res.json({ ok: true, [docType === 'quotation' ? 'quotation' : docType === 'invoice' ? 'invoice' : 'payment']: result.data });
    });
  }

  // ── AR/AP 看板 ──
  router.get('/summary', requirePermission('finance:read'), async (req, res) => {
    const result = await svc.getArApSummary(actorOf(req));
    if (!result.ok) return res.status(STATUS_MAP[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error!.code, message: result.error!.message });
    return res.json({ ok: true, ...result.data });
  });

  // ── 报价单 CRUD ──
  // 权限矩阵全组合审计 P1-3：delete scope 未定义（PERMISSION_SCOPES 无 :delete 族），
  // 2026-09-03 起 delete 收敛到 write scope（fail-closed 收紧，owner 特判不受影响）
  registerCrudRoutes('quotation', 'quotations', 'quotations:read', 'quotations:write', 'quotations:write');

  // ── 发票 CRUD ──
  registerCrudRoutes('invoice', 'invoices', 'invoices:read', 'invoices:write', 'invoices:write');

  // ── 收付款凭证 CRUD ──
  // P1-3：真源 scope 为 vouchers:*（无 payments:*）；delete 收敛 vouchers:write
  registerCrudRoutes('payment', 'payments', 'vouchers:read', 'vouchers:write', 'vouchers:write');

  // ════════════════════════════════════════════════════════════════
  // Phase 1-04：报价单双轨定价（fn-1）
  // ════════════════════════════════════════════════════════════════

  // POST /quotations/:id/apply-pricing — 应用双轨定价（Track A 估算 + Track B 终价 → 写入快照字段）
  router.post('/quotations/:id/apply-pricing', requireWrite, requirePermission('quotations:write' as any), async (req, res) => {
    const pricingSvc = getQuotationPricingService(opts.prisma);
    const result = await pricingSvc.applyTrackPricing(req.params.id, req.body || {});
    if (!result.ok) {
      const code = result.error!.code;
      const status = code === 'NOT_FOUND' ? 404 : code === 'EXCHANGE_RATE_MISSING' || code === 'PRICING_FAILED' ? 400 : 500;
      return res.status(status).json({ error: code, message: result.error!.message });
    }
    return res.json({ ok: true, pricing: result.data });
  });

  // GET /quotations/:id/pricing-check — 获取定价偏差校验（发送门禁）
  router.get('/quotations/:id/pricing-check', requirePermission('quotations:read' as any), async (req, res) => {
    const pricingSvc = getQuotationPricingService(opts.prisma);
    const result = await pricingSvc.getPricingCheck(req.params.id);
    if (!result.ok) return res.status(result.error!.code === 'NOT_FOUND' ? 404 : 500).json({ error: result.error!.code, message: result.error!.message });
    return res.json({ ok: true, pricing: result.data });
  });

  // ════════════════════════════════════════════════════════════════
  // Phase 1-04：形式发票 PI（fn-2）
  // ════════════════════════════════════════════════════════════════

  // POST /quotations/:id/generate-pi — 从报价单生成形式发票（PI）
  router.post('/quotations/:id/generate-pi', requireWrite, requirePermission('invoices:write' as any), async (req, res) => {
    const piSvc = getProformaInvoiceService(opts.prisma);
    if (req.body?.quotationId != null && req.body.quotationId !== req.params.id) {
      const failure = safeRouteError({ code: 'INVALID_INPUT', statusCode: lookupErrorCode('INVALID_INPUT')?.status, message: '请求中的报价来源与当前报价不一致。' }, { fallbackCode: 'INTERNAL_ERROR' });
      return res.status(failure.status).json({ error: failure.code, message: failure.message });
    }
    const result = await piSvc.generateFromQuotation(
      { quotationId: req.params.id, issueDate: req.body?.issueDate, dueDate: req.body?.dueDate, notes: req.body?.notes },
      actorOf(req)?.userId ?? null,
      req.ip,
      actorOf(req),
    );
    if (!result.ok) {
      const failure = typeof result.error?.statusCode === 'number' && isProformaAccessCode(result.error?.code) ? safeRouteError(result.error, { fallbackCode: 'INTERNAL_ERROR' }) : proformaInvoiceHttpError(result.error);
      return res.status(failure.status).json({ error: failure.code, message: failure.message });
    }
    return res.json({ ok: true, invoice: result.data });
  });

  // POST /invoices/:id/convert-to-receivable — PI 转换为正式应收发票
  router.post('/invoices/:id/convert-to-receivable', requireWrite, requirePermission('invoices:write' as any), async (req, res) => {
    const piSvc = getProformaInvoiceService(opts.prisma);
    const result = await piSvc.convertToReceivable(
      req.params.id,
      { issueDate: req.body?.issueDate, dueDate: req.body?.dueDate, notes: req.body?.notes },
      actorOf(req)?.userId ?? null,
      req.ip,
      actorOf(req),
    );
    if (!result.ok) {
      const failure = typeof result.error?.statusCode === 'number' && isProformaAccessCode(result.error?.code) ? safeRouteError(result.error, { fallbackCode: 'INTERNAL_ERROR' }) : proformaInvoiceHttpError(result.error);
      return res.status(failure.status).json({ error: failure.code, message: failure.message });
    }
    return res.json({ ok: true, invoice: result.data });
  });

  // ════════════════════════════════════════════════════════════════
  // Phase 1-04：VAT 增值税发票（fn-3）
  // ════════════════════════════════════════════════════════════════

  // GET /vat-invoices — VAT 发票列表
  router.get('/vat-invoices', requirePermission('vat:read' as any), async (req, res) => {
    try {
    const { items, total } = await listVatInvoices(opts.prisma, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      direction: typeof req.query.direction === 'string' ? req.query.direction : undefined,
      relationId: typeof req.query.relationId === 'string' ? req.query.relationId : undefined,
      orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined,
      invoiceId: typeof req.query.invoiceId === 'string' ? req.query.invoiceId : undefined,
      taxRefundId: typeof req.query.taxRefundId === 'string' ? req.query.taxRefundId : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
    }, actorOf(req));
    return res.json({ ok: true, items, total });
    } catch (error) { const failure = safeRouteError(error, { fallbackCode: 'LIST_FAILED', fallbackMessage: '原票暂时无法读取。' }); return res.status(failure.status).json({error: failure.code, message: failure.message}); }
  });

  // GET /vat-invoices/:id — VAT 发票详情
  router.get('/vat-invoices/:id', requirePermission('vat:read' as any), async (req, res) => {
    const result = await getVatInvoice(opts.prisma, req.params.id, actorOf(req));
    if (!result.ok) return res.status(lookupErrorCode(result.error.code)?.status ?? 404).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, vatInvoice: result.data.vatInvoice });
  });

  // POST /vat-invoices — 创建 VAT 发票
  router.post('/vat-invoices', requireWrite, requirePermission('vat:write' as any), async (req, res) => {
    const result = await createVatInvoice({
      prisma: opts.prisma, input: req.body || {},
      actorId: actorOf(req)?.userId, actor: actorOf(req), ip: req.ip,
    });
    if (!result.ok) return res.status(lookupErrorCode(result.error.code)?.status ?? 400).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, ...result.data });
  });

  // PUT /vat-invoices/:id — 更新 VAT 发票
  router.put('/vat-invoices/:id', requireWrite, requirePermission('vat:write' as any), async (req, res) => {
    const result = await updateVatInvoice({
      prisma: opts.prisma, vatInvoiceId: req.params.id, patch: req.body || {},
      actorId: actorOf(req)?.userId, actor: actorOf(req), ip: req.ip,
    });
    if (!result.ok) return res.status(lookupErrorCode(result.error.code)?.status ?? 400).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, ...result.data });
  });

  // DELETE /vat-invoices/:id — 软删除 VAT 发票
  router.delete('/vat-invoices/:id', requireWrite, requirePermission('vat:write' as any), async (req, res) => {
    const result = await deleteVatInvoice({
      prisma: opts.prisma, vatInvoiceId: req.params.id,
      requestKey: req.body?.requestKey, expectedUpdatedAt: req.body?.expectedUpdatedAt,
      actorId: actorOf(req)?.userId, actor: actorOf(req), ip: req.ip,
    });
    if (!result.ok) return res.status(lookupErrorCode(result.error.code)?.status ?? 400).json({ error: result.error.code, message: result.error.message });
    return res.json({ok:true,...result.data});
  });

  // POST /vat-invoices/:id/transition — VAT 发票状态流转
  router.post('/vat-invoices/:id/transition', requireWrite, requirePermission('vat:write' as any), async (req, res) => {
    const result = await transitionVatInvoiceStatus({
      prisma: opts.prisma, vatInvoiceId: req.params.id, input: req.body || {},
      actorId: actorOf(req)?.userId, actor: actorOf(req), ip: req.ip,
    });
    if (!result.ok) return res.status(lookupErrorCode(result.error.code)?.status ?? 400).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, ...result.data });
  });

  // ════════════════════════════════════════════════════════════════
  // Phase 1-04：外汇结汇（fn-4）
  // ════════════════════════════════════════════════════════════════

  // GET /fx-settlements — 结汇水单列表
  router.get('/fx-settlements', requirePermission('invoices:read' as any), async (req, res) => {
    const where: Record<string, unknown> = { deletedAt: null };
    if (typeof req.query.voucherId === 'string') where.voucherId = req.query.voucherId;
    if (typeof req.query.orderId === 'string') where.orderId = req.query.orderId;
    if (typeof req.query.customerRelationId === 'string') where.customerRelationId = req.query.customerRelationId;
    if (typeof req.query.currency === 'string') where.currency = req.query.currency;
    const items = await (opts.prisma as any).fxSettlement.findMany({ where, orderBy: { settleDate: 'desc' } });
    return res.json({ ok: true, items, total: items.length });
  });

  // GET /fx-settlements/ledger — 外汇台账（须在 /:id 之前注册）
  router.get('/fx-settlements/ledger', requirePermission('invoices:read' as any), async (req, res) => {
    const ledger = await getFxLedger(opts.prisma, {
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
    });
    return res.json({ ok: true, ledger });
  });

  // GET /fx-settlements/voucher-summary/:voucherId — 凭证核销摘要
  router.get('/fx-settlements/voucher-summary/:voucherId', requirePermission('invoices:read' as any), async (req, res) => {
    const result = await getVoucherSettlementSummary(opts.prisma, req.params.voucherId);
    if (!result.ok) return res.status(404).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, summary: result.data });
  });

  // POST /fx-settlements — 创建结汇水单
  router.post('/fx-settlements', requireWrite, requirePermission('invoices:write' as any), async (req, res) => {
    const result = await createFxSettlement({
      prisma: opts.prisma, input: req.body || {},
      actorId: actorOf(req)?.userId || 'api', ip: req.ip,
    });
    if (!result.ok) return res.status(400).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, settlement: result.data.settlement, auditId: result.data.auditId });
  });

  // DELETE /fx-settlements/:id — 软删除结汇水单
  router.delete('/fx-settlements/:id', requireWrite, requirePermission('invoices:write' as any), async (req, res) => {
    const result = await deleteFxSettlement({
      prisma: opts.prisma, settlementId: req.params.id,
      actorId: actorOf(req)?.userId || 'api', ip: req.ip,
    });
    if (!result.ok) return res.status(400).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true });
  });

  // ════════════════════════════════════════════════════════════════
  // Phase 1-04：外汇付汇（fn-4 镜像）
  // ════════════════════════════════════════════════════════════════

  // GET /outward-remittances — 付汇水单列表
  router.get('/outward-remittances', requirePermission('invoices:read' as any), async (req, res) => {
    const where: Record<string, unknown> = { deletedAt: null };
    if (typeof req.query.voucherId === 'string') where.voucherId = req.query.voucherId;
    if (typeof req.query.orderId === 'string') where.orderId = req.query.orderId;
    if (typeof req.query.customerRelationId === 'string') where.customerRelationId = req.query.customerRelationId;
    if (typeof req.query.currency === 'string') where.currency = req.query.currency;
    const items = await (opts.prisma as any).outwardRemittance.findMany({ where, orderBy: { remitDate: 'desc' } });
    return res.json({ ok: true, items, total: items.length });
  });

  // GET /outward-remittances/voucher-summary/:voucherId — 凭证付汇摘要
  router.get('/outward-remittances/voucher-summary/:voucherId', requirePermission('invoices:read' as any), async (req, res) => {
    const result = await getVoucherRemittanceSummary(opts.prisma, req.params.voucherId);
    if (!result.ok) return res.status(404).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, summary: result.data });
  });

  // POST /outward-remittances — 创建付汇水单
  router.post('/outward-remittances', requireWrite, requirePermission('invoices:write' as any), async (req, res) => {
    const result = await createOutwardRemittance({
      prisma: opts.prisma, input: req.body || {},
      actorId: actorOf(req)?.userId || 'api', ip: req.ip,
    });
    if (!result.ok) return res.status(400).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, remittance: result.data.remittance, auditId: result.data.auditId });
  });

  // DELETE /outward-remittances/:id — 软删除付汇水单
  router.delete('/outward-remittances/:id', requireWrite, requirePermission('invoices:write' as any), async (req, res) => {
    const result = await deleteOutwardRemittance({
      prisma: opts.prisma, remittanceId: req.params.id,
      actorId: actorOf(req)?.userId || 'api', ip: req.ip,
    });
    if (!result.ok) return res.status(400).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true });
  });

  return router;
}
