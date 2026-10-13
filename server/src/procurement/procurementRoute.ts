
/**
 * 采购管理 API — /api/v1/procurement
 *
 * 端点：
 *   GET    /                          — 采购单列表（支持 status/supplier/date/search 过滤；format=xlsx 全量台账导出）
 *   GET    /:id                       — 采购单详情（含行明细 + 收料记录）
 *   GET    /:id/preview.html          — PO 服务端模板预览（A4 纸张画布，与生成 PDF 同源排版）
 *   POST   /:id/generate-document     — 登记域单据（domain=procurement）+ 服务端渲染 PDF 落盘归档
 *   POST   /                          — 创建采购单（Draft 状态）
 *   PUT    /:id                       — 更新采购单（仅 Draft）
 *   DELETE /:id                       — 软删除采购单（仅 Draft）
 *   POST   /:id/send                  — 发送采购单（Draft → Sent）
 *   POST   /:id/confirm               — 确认采购单（Sent → Confirmed）
 *   POST   /:id/cancel                — 取消采购单
 *   POST   /:id/close                 — 关闭采购单
 *   POST   /:id/receipts              — 创建来料检验记录
 *   GET    /:id/receipts              — 查询来料记录列表
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { logger } from '../lib/logger';
import { createProcurementService, CreatePurchaseOrderInput, UpdatePurchaseOrderInput, MaterialReceiptInput, CreateSupplierInquiryInput, UpdateSupplierInquiryInput, AddSupplierQuoteInput, SUPPLIER_INQUIRY_CREATE_FIELDS } from './procurementService';
import { createProcurementDemandService, DemandError } from './procurementDemandService';
import { createPurchaseServiceDeliveryService, PurchaseServiceDeliveryError } from './purchaseServiceDeliveryService';
import { createMaterialReturnService } from './materialReturnService';
import { buildXlsx, xlsxDownloadHeaders, type XlsxSheet } from '../templates/xlsxExport';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { loadPurchaseOrderDocData } from '../templates/docTemplates/purchaseOrder';
import { upsertDomainTradeDocument, generateTradeDocumentFile } from '../customs/tradeDocumentLifecycleService';

import { resolveVisibleOrderIds, isOrderLinkedVisible } from '../auth/orderVisibility';
import { ReceiptDomainError } from './receiptWarehouseAccess';
import { PurchaseOrderDomainError } from './purchaseOrderErrors';
import { safeRouteError } from '../shared/routeError';
import { createSupplierContractRouter } from './supplierContractRoute';
import { createSupplierCommitmentService } from './supplierCommitmentService';
import { SupplierContractError } from './supplierContractPolicy';
import { todayLocalKey } from '../shared/localDate';

/** PO 状态 → 台账中文标签（与 ProcurementManager 展示口径一致） */
const PO_STATUS_LABEL: Record<string, string> = {
  Draft: '草稿', Sent: '已发送', Confirmed: '已确认', PartiallyReceived: '部分收料',
  Received: '已收料', Closed: '已关闭', Cancelled: '已取消',
};

export interface ProcurementRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createProcurementRouter(options: ProcurementRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const service = createProcurementService(prisma);

  // W-C 批三-E 族B 收口：inline authenticate 闭包退役，统一 createModuleAuthGuard（JWT 或 API-Key）。
  // 读面保持认证门（API-Key 兼容契约，auth/__tests__/moduleApiKeyHeader.test.ts 锁定）；
  // 写面 requireJwtForWrite（JWT-only，API-Key 裸写旧契约关闭）＋ procurement:write scope 门
  // （持有 = SALES/SALES_MANAGER/LOGISTICS＋SuperAdmin 特判，_shared/rolePermissionMatrix 真源）。
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const requireProcurementWrite = requirePermission('procurement:write');
  // B-5（§10.7 权限矩阵批）：读面此前零 scope，登录即可看全部采购数据
  const requireProcurementRead = requirePermission('procurement:read');
  router.use('/contracts', createSupplierContractRouter(options));

  // Historic contracts remain readable. Every commercial/physical legacy write
  // must use the native revision command, including agent/MES callers at service
  // level; a Draft→Sent transition is no longer an approval substitute.
  router.use((req, res, next) => {
    const legacyWrite = req.method !== 'GET' && req.method !== 'HEAD' && (req.path === '/'
      || /^\/[^/]+$/.test(req.path) && !['/demands', '/inquiries', '/material-returns'].includes(req.path)
      || /^\/[^/]+\/(send|confirm|cancel|close|receipts|generate-document|service-deliveries)$/.test(req.path) && !req.path.startsWith('/inquiries/'));
    if (legacyWrite) { res.status(409).json({ ok: false, code: 'NATIVE_SUPPLIER_COMMAND_REQUIRED', error: '采购与加工须使用独立合同工作区的准确版本审批和实际交接命令；历史单据保留只读。' }); return; }
    next();
  });

  const scopeNotFound = (res: Response) => res.status(404).json({ error: '单据不存在或不在当前可见范围' });
  const visibleFor = (req: Request) => resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
  async function validSources(input: { orderId?: string | null; bomId?: string | null }, visible: string[] | null): Promise<boolean> {
    if (!isOrderLinkedVisible(visible, input.orderId)) return false;
    if (input.bomId) {
      const bom = await prisma.bOM.findUnique({ where: { id: input.bomId }, select: { orderId: true, deletedAt: true } });
      if (!bom || bom.deletedAt || !isOrderLinkedVisible(visible, bom.orderId)) return false;
      if (bom.orderId && bom.orderId !== input.orderId) return false;
    }
    return true;
  }
  const guardPO = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const visible = await visibleFor(req);
      const po = req.params.id ? await service.getPurchaseOrder(req.params.id) : null;
      if (po?.businessOwnerId || po?.approvedCommitmentRevisionId) {
        const actor = extractActorFromRequest(req);
        if (!actor) return res.status(401).json({ error: '请使用真实账号读取准确合同。' });
        await createSupplierCommitmentService(prisma).get('purchase', po.id, actor);
      }
      if (req.params.id && (!po || !isOrderLinkedVisible(visible, po.orderId))) { scopeNotFound(res); return; }
      if (req.method === 'PUT' || (req.method === 'POST' && !req.params.id)) {
        const source = { orderId: req.body?.orderId !== undefined ? req.body.orderId : po?.orderId, bomId: req.body?.bomId !== undefined ? req.body.bomId : po?.bomId };
        if (!(await validSources(source, visible))) { scopeNotFound(res); return; }
      }
      res.locals.authorizedOrderId = po?.orderId ?? null;
      next();
    } catch (error) {
      if (error instanceof SupplierContractError) { res.status(error.statusCode).json({ error: error.message, code: error.code }); return; }
      res.status(500).json({ error: '采购单权限范围暂不可确认，请稍后重试' });
    }
  };
  const guardInquiry = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const visible = await visibleFor(req);
      const inquiry = req.params.id ? await service.getSupplierInquiry(req.params.id) : null;
      if (req.params.id && (!inquiry || !isOrderLinkedVisible(visible, inquiry.orderId))) { scopeNotFound(res); return; }
      if ((req.method === 'PUT' && !req.params.quoteId) || (req.method === 'POST' && !req.params.id)) {
        const source = { orderId: req.body?.orderId !== undefined ? req.body.orderId : inquiry?.orderId, bomId: req.body?.bomId !== undefined ? req.body.bomId : inquiry?.bomId };
        if (!(await validSources(source, visible))) { scopeNotFound(res); return; }
      }
      res.locals.authorizedInquiryOrderId = inquiry?.orderId ?? null;
      next();
    } catch { res.status(500).json({ error: '询价单权限范围暂不可确认，请稍后重试' }); }
  };
  const guardReturn = async (req: Request, res: Response, next: NextFunction) => {
    try {
      let purchaseOrderId: string | undefined;
      if (req.params.id) {
        const item = await prisma.materialReturn.findUnique({ where: { id: req.params.id } });
        if (!item || item.deletedAt) { scopeNotFound(res); return; }
        purchaseOrderId = item.purchaseOrderId;
      } else {
        const receipt = req.body?.receiptId ? await prisma.materialReceipt.findUnique({ where: { id: String(req.body.receiptId) } }) : null;
        purchaseOrderId = receipt?.purchaseOrderId;
      }
      const po = purchaseOrderId ? await service.getPurchaseOrder(purchaseOrderId) : null;
      if (!po || !isOrderLinkedVisible(await visibleFor(req), po.orderId)) { scopeNotFound(res); return; }
      next();
    } catch (e: any) {
      logger.error('[MaterialReturn] scope verification failed', { error: e?.message });
      const action = req.path.split('/').pop();
      const failure = action === 'mark-shipped' ? ['SHIP_FAILED', '发运确认'] : action === 'confirm' ? ['CONFIRM_FAILED', '供应商确认'] : action === 'settle' ? ['SETTLE_FAILED', '结算'] : action === 'cancel' ? ['CANCEL_FAILED', '取消'] : ['CREATE_FAILED', '退换货登记'];
      res.status(500).json({ error: { code: failure[0], message: `${failure[1]}暂无法核实单据权限，本次未执行操作，请稍后重试或联系管理员。` } });
    }
  };

  const demandService = createProcurementDemandService(prisma);
  const demandFailure = (res: Response, e: any) => {
    if (!(e instanceof DemandError)) logger.error('[ProcurementDemand] request failed', { error: e?.message });
    return res.status(e instanceof DemandError ? e.status : 500).json({ error: { code: e instanceof DemandError ? e.code : 'DEMAND_FAILED', message: e instanceof DemandError ? e.message : '采购需求操作失败，请稍后重试' } });
  };
  router.get('/demands', requireProcurementRead, async (req, res) => {
    try {
      const actor = extractActorFromRequest(req);
      const visible = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      res.json(await demandService.list(visible, actor?.userId || '', { orderId: req.query.orderId as string | undefined, mine: req.query.mine === 'true', offset: Number(req.query.offset ?? 0), limit: Number(req.query.limit ?? 50) }, actor));
    } catch (e) { demandFailure(res, e); }
  });
  router.post('/demands', requireWrite, requireProcurementWrite, async (req, res) => {
    try {
      const actor = extractActorFromRequest(req);
      const visible = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      const result = await demandService.create(req.body, actor?.userId || '', visible, actor);
      onDataChange?.({ entity: 'ProcurementDemand', action: 'create', ids: [result.demand.id] });
      res.status(201).json(result);
    } catch (e) { demandFailure(res, e); }
  });
  for (const action of ['claim', 'release', 'confirm', 'allocate'] as const) {
    router.post(`/demands/:id/${action}`, requireWrite, requireProcurementWrite, async (req, res) => {
      try {
        const actor = extractActorFromRequest(req);
        const visible = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
        const result = action === 'claim'
          ? await demandService.claim(req.params.id, req.body.revision, actor?.userId || '', visible, actor)
          : await demandService[action](req.params.id, req.body, actor?.userId || '', visible, actor);
        onDataChange?.({ entity: 'ProcurementDemand', action: 'update', ids: [req.params.id] });
        if (action === 'allocate' && 'purchaseOrder' in result && result.purchaseOrder) onDataChange?.({ entity: 'PurchaseOrder', action: 'create', ids: [(result.purchaseOrder as { id: string }).id] });
        res.json(result);
      } catch (e) { demandFailure(res, e); }
    });
  }

  // ── GET / — 列表（format=xlsx → 全量台账 Excel 导出） ──
  router.get('/', requireProcurementRead, async (req: Request, res: Response) => {
    try {
      const { status, supplierRelationId, dateFrom, dateTo, search, limit, offset } = req.query;
      // §10.4.2：采购单随关联订单可见（业务方 2026-09-12 定案）
      const visibleOrderIds = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      const result = await service.listPurchaseOrders({
        visibleOrderIds,
        status: status as string | undefined,
        supplierRelationId: supplierRelationId as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        search: search as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
        ...(req.query.format === 'xlsx' ? { exportAll: true } : {}),
      });
      if (req.query.format === 'xlsx') {
        const sheet: XlsxSheet = {
          name: '采购台账',
          columnLabels: ['采购单号', '供应商', '状态', '币种', '金额', '下单日期', '预计交期', '实际交期', '经办业务员', '交货条款', '付款条款', '备注'],
          columns: ['poNumber', 'supplierName', 'status', 'currency', 'totalAmount', 'orderDate', 'expectedDeliveryDate', 'actualDeliveryDate', 'buyer', 'deliveryTerms', 'paymentTerms', 'notes'],
          rows: result.items.map(po => ({
            poNumber: po.poNumber,
            supplierName: po.supplierName,
            status: PO_STATUS_LABEL[po.status] ?? po.status,
            currency: po.currency,
            totalAmount: po.totalAmount != null ? Number(po.totalAmount) : null,
            orderDate: po.orderDate,
            expectedDeliveryDate: po.expectedDeliveryDate,
            actualDeliveryDate: po.actualDeliveryDate,
            buyer: po.buyer,
            deliveryTerms: po.deliveryTerms,
            paymentTerms: po.paymentTerms,
            notes: po.notes,
          })),
        };
        const today = todayLocalKey();
        res.set(xlsxDownloadHeaders(`采购台账_${today}.xlsx`)).send(buildXlsx([sheet]));
        return;
      }
      res.json(result);
    } catch (e: any) {
      logger.error('[ProcurementRoute] GET list failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list purchase orders' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 卡点 3：供应商询价比价 /inquiries（剧本 2.10 验收点）
  // 端点：
  //   GET    /inquiries               — 询价单列表
  //   POST   /inquiries                — 创建询价单（Open）
  //   GET    /inquiries/:id            — 询价单详情
  //   PUT    /inquiries/:id            — 更新询价单（仅 Open）
  //   DELETE /inquiries/:id            — 软删除询价单（仅 Open）
  //   POST   /inquiries/:id/quotes     — 添加供应商报价
  //   PUT    /inquiries/:id/quotes/:quoteId  — 更新供应商报价
  //   DELETE /inquiries/:id/quotes/:quoteId — 删除供应商报价
  //   POST   /inquiries/:id/select     — 比价决策（选定中选供应商，Open → Compared）
  //   POST   /inquiries/:id/close      — 关闭询价单（Compared → Closed）
  // ══════════════════════════════════════════════════════════════

  // ── GET /inquiries — 询价单列表 ──
  router.get('/inquiries', requireProcurementRead, async (req: Request, res: Response) => {
    try {
      const { status, dateFrom, dateTo, search, limit, offset } = req.query;
      const result = await service.listSupplierInquiries({
        visibleOrderIds: await visibleFor(req),
        status: status as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        search: search as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.json(result);
    } catch (e: any) {
      logger.error('[ProcurementRoute] GET inquiries list failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list supplier inquiries' });
    }
  });

  // ── POST /inquiries — 创建询价单 ──
  router.post('/inquiries', requireWrite, requireProcurementWrite, guardInquiry, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const raw = req.body as CreateSupplierInquiryInput;
      if (!raw.description || !raw.currency) {
        return res.status(400).json({ error: '缺少必填字段：description / currency' });
      }
      // 白名单过滤（防止客户端写入非法字段）
      const input: CreateSupplierInquiryInput = {
        description: raw.description,
        materialCode: raw.materialCode,
        quantity: raw.quantity,
        unit: raw.unit,
        currency: raw.currency,
        expectedDeliveryDate: raw.expectedDeliveryDate,
        orderId: raw.orderId,
        bomId: raw.bomId,
        buyer: raw.buyer,
        notes: raw.notes,
      };
      const inquiry = await service.createSupplierInquiry(input, actor?.userId || 'system');
      onDataChange?.({ entity: 'SupplierInquiry', action: 'create', ids: [inquiry.id] });
      res.status(201).json({ inquiry });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST inquiry create failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to create supplier inquiry' });
    }
  });

  // ── GET /inquiries/:id — 询价单详情 ──
  router.get('/inquiries/:id', requireProcurementRead, guardInquiry, async (req: Request, res: Response) => {
    try {
      const inquiry = await service.getSupplierInquiry(req.params.id);
      if (!inquiry) return res.status(404).json({ error: '询价单不存在' });
      res.json({ inquiry });
    } catch (e: any) {
      logger.error('[ProcurementRoute] GET inquiry detail failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get supplier inquiry' });
    }
  });

  // ── PUT /inquiries/:id — 更新询价单（仅 Open） ──
  router.put('/inquiries/:id', requireWrite, requireProcurementWrite, guardInquiry, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as UpdateSupplierInquiryInput;
      const inquiry = await service.updateSupplierInquiry(req.params.id, input, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedInquiryOrderId });
      onDataChange?.({ entity: 'SupplierInquiry', action: 'update', ids: [inquiry.id] });
      res.json({ inquiry });
    } catch (e: any) {
      logger.error('[ProcurementRoute] PUT inquiry update failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('状态') ? 409 : 500);
      res.status(status).json({ error: e?.message || 'failed to update supplier inquiry' });
    }
  });

  // ── DELETE /inquiries/:id — 软删除询价单（仅 Open） ──
  router.delete('/inquiries/:id', requireWrite, requireProcurementWrite, guardInquiry, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      await service.deleteSupplierInquiry(req.params.id, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedInquiryOrderId });
      onDataChange?.({ entity: 'SupplierInquiry', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[ProcurementRoute] DELETE inquiry failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('状态') ? 409 : 500);
      res.status(status).json({ error: e?.message || 'failed to delete supplier inquiry' });
    }
  });

  // ── POST /inquiries/:id/quotes — 添加供应商报价（验收点②） ──
  router.post('/inquiries/:id/quotes', requireWrite, requireProcurementWrite, guardInquiry, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as AddSupplierQuoteInput;
      if (!input.supplierName || input.quoteAmount == null || !input.currency || !input.quoteDate) {
        return res.status(400).json({ error: '缺少必填字段：supplierName / quoteAmount / currency / quoteDate' });
      }
      const inquiry = await service.addSupplierQuote(req.params.id, input, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedInquiryOrderId });
      onDataChange?.({ entity: 'SupplierInquiry', action: 'update', ids: [inquiry.id] });
      res.status(201).json({ inquiry });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST quote add failed', { error: e?.message });
      // B2：黑名单供应商报价 → 403（文案「该供应商已被拉黑，禁止报价」）；档案外供应商 → 404；缺 supplierId → 400
      const status = e?.status ?? (e?.message?.includes('已被拉黑') ? 403 : e?.message?.includes('不存在') ? 404 : e?.message?.includes('必填') ? 400 : e?.message?.includes('状态') ? 409 : 500);
      res.status(status).json({ error: e?.message || 'failed to add supplier quote' });
    }
  });

  // ── PUT /inquiries/:id/quotes/:quoteId — 更新供应商报价 ──
  router.put('/inquiries/:id/quotes/:quoteId', requireWrite, requireProcurementWrite, guardInquiry, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as Partial<AddSupplierQuoteInput>;
      const inquiry = await service.updateSupplierQuote(req.params.id, req.params.quoteId, input, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedInquiryOrderId });
      onDataChange?.({ entity: 'SupplierInquiry', action: 'update', ids: [inquiry.id] });
      res.json({ inquiry });
    } catch (e: any) {
      logger.error('[ProcurementRoute] PUT quote update failed', { error: e?.message });
      // B2：编辑报价改动供应商身份为黑名单供应商 → 403（与 POST 同一门禁口径）
      const status = e?.status ?? (e?.message?.includes('已被拉黑') ? 403 : e?.message?.includes('不存在') ? 404 : e?.message?.includes('必填') ? 400 : e?.message?.includes('状态') ? 409 : 500);
      res.status(status).json({ error: e?.message || 'failed to update supplier quote' });
    }
  });

  // ── DELETE /inquiries/:id/quotes/:quoteId — 删除供应商报价 ──
  router.delete('/inquiries/:id/quotes/:quoteId', requireWrite, requireProcurementWrite, guardInquiry, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const inquiry = await service.removeSupplierQuote(req.params.id, req.params.quoteId, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedInquiryOrderId });
      onDataChange?.({ entity: 'SupplierInquiry', action: 'update', ids: [inquiry.id] });
      res.json({ inquiry });
    } catch (e: any) {
      logger.error('[ProcurementRoute] DELETE quote failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('状态') ? 409 : 500);
      res.status(status).json({ error: e?.message || 'failed to remove supplier quote' });
    }
  });

  // ── POST /inquiries/:id/select — 比价决策（验收点③） ──
  router.post('/inquiries/:id/select', requireWrite, requireProcurementWrite, guardInquiry, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const { quoteId, decisionNote } = req.body as { quoteId: string; decisionNote: string };
      if (!quoteId) {
        return res.status(400).json({ error: '缺少必填字段：quoteId' });
      }
      const inquiry = await service.selectSupplier(req.params.id, quoteId, decisionNote || '', actor?.userId || 'system', { expectedOrderId: res.locals.authorizedInquiryOrderId });
      onDataChange?.({ entity: 'SupplierInquiry', action: 'update', ids: [inquiry.id] });
      res.json({ inquiry });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST select supplier failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('状态') ? 409 : 500);
      res.status(status).json({ error: e?.message || 'failed to select supplier' });
    }
  });

  // ── POST /inquiries/:id/close — 关闭询价单 ──
  router.post('/inquiries/:id/close', requireWrite, requireProcurementWrite, guardInquiry, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const inquiry = await service.closeSupplierInquiry(req.params.id, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedInquiryOrderId });
      onDataChange?.({ entity: 'SupplierInquiry', action: 'update', ids: [inquiry.id] });
      res.json({ inquiry });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST inquiry close failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('状态') ? 409 : 500);
      res.status(status).json({ error: e?.message || 'failed to close supplier inquiry' });
    }
  });

  // ════════════════════════════════════════════════════════════════
  // P1-4 物料退换货 — /api/v1/procurement/material-returns
  // 字面路由：须在参数路由 /:id 之前注册（同 /inquiries 家族）。
  // ════════════════════════════════════════════════════════════════
  const materialReturnService = createMaterialReturnService(prisma);
  const mrRespond = (res: Response, result: any) => {
    if (!result.ok) {
      res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
      return;
    }
    res.json({ ok: true, ...serializeMr(result.data) });
  };
  const serializeMr = (data: any) => {
    if (data == null || typeof data !== 'object') return { data };
    if (Array.isArray(data.items)) return { items: data.items };
    return { ...data };
  };

  // GET /material-returns — 退换货列表（采购单/检验单/供应商/状态过滤）
  router.get('/material-returns', requireProcurementRead, async (req: Request, res: Response) => {
    try {
    const result = await materialReturnService.listReturns({
      visibleOrderIds: await visibleFor(req),
      purchaseOrderId: req.query.purchaseOrderId ? String(req.query.purchaseOrderId) : undefined,
      receiptId: req.query.receiptId ? String(req.query.receiptId) : undefined,
      supplierRelationId: req.query.supplierRelationId ? String(req.query.supplierRelationId) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    mrRespond(res, result);
    } catch (e: any) {
      logger.error('[MaterialReturn] list scope verification failed', { error: e?.message });
      res.status(500).json({ error: { code: 'LIST_FAILED', message: '退换货列表权限暂无法核实，请稍后重试或联系管理员。' } });
    }
  });

  // POST /material-returns — 登记退换货/索赔（pending）
  router.post('/material-returns', requireWrite, requireProcurementWrite, guardReturn, async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    const result = await materialReturnService.createReturn((req.body ?? {}) as any, actor?.userId);
    if (result.ok) onDataChange?.({ entity: 'MaterialReturn', action: 'create', ids: [result.data.materialReturn.id] });
    mrRespond(res, result);
  });

  // POST /material-returns/:id/mark-shipped — 发运确认（库存 Outbound 冲减）
  router.post('/material-returns/:id/mark-shipped', requireWrite, requireProcurementWrite, guardReturn, async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    const result = await materialReturnService.markShipped(req.params.id, actor?.userId);
    if (result.ok) onDataChange?.({ entity: 'MaterialReturn', action: 'update', ids: [req.params.id] });
    mrRespond(res, result);
  });

  // POST /material-returns/:id/confirm — 供应商确认（exchange 回冲 / claim 负向应付发票 / 绩效评分）
  router.post('/material-returns/:id/confirm', requireWrite, requireProcurementWrite, guardReturn, async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    const result = await materialReturnService.confirmReturn(req.params.id, actor?.userId);
    if (result.ok) {
      onDataChange?.({ entity: 'MaterialReturn', action: 'update', ids: [req.params.id] });
      if (result.data.claimInvoiceId) onDataChange?.({ entity: 'Invoice', action: 'create', ids: [result.data.claimInvoiceId] });
    }
    mrRespond(res, result);
  });

  // POST /material-returns/:id/settle — 结算完成（confirmed → settled）
  router.post('/material-returns/:id/settle', requireWrite, requireProcurementWrite, guardReturn, async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    const result = await materialReturnService.settleReturn(req.params.id, actor?.userId);
    if (result.ok) onDataChange?.({ entity: 'MaterialReturn', action: 'update', ids: [req.params.id] });
    mrRespond(res, result);
  });

  // POST /material-returns/:id/cancel — 取消（仅 pending）
  router.post('/material-returns/:id/cancel', requireWrite, requireProcurementWrite, guardReturn, async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    const result = await materialReturnService.cancelReturn(req.params.id, actor?.userId);
    if (result.ok) onDataChange?.({ entity: 'MaterialReturn', action: 'update', ids: [req.params.id] });
    mrRespond(res, result);
  });

  // ── GET /:id — 详情 ──
  router.get('/:id', requireProcurementRead, guardPO, async (req: Request, res: Response) => {
    try {
      const purchaseOrder = await service.getPurchaseOrder(req.params.id);
      if (!purchaseOrder) {
        return res.status(404).json({ error: '采购单不存在' });
      }
      // §10.4.2：详情按「关联订单可见」把关（防猜 id 直读越权单）
      const visibleOrderIds = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      if (!isOrderLinkedVisible(visibleOrderIds, (purchaseOrder as any).orderId)) {
        return res.status(404).json({ error: '采购单不存在' });
      }
      res.json({ purchaseOrder });
    } catch (e: any) {
      logger.error('[ProcurementRoute] GET detail failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get purchase order' });
    }
  });

  // ── GET /:id/preview.html — PO 服务端模板预览（B2 运营域单据：实时装配渲染，
  //    与生成 PDF 同源排版——所见即所得，无需先登记文档） ──
  router.get('/:id/preview.html', requireProcurementRead, guardPO, async (req: Request, res: Response) => {
    try {
      const data = await loadPurchaseOrderDocData(prisma, req.params.id);
      if (!data) return res.status(404).json({ error: '采购单不存在' });
      // guardPO validates the actual purchase order before loading print-only view data.
      const html = await renderServerDocument(prisma, 'PO', data, { screen: true });
      if (!html) return res.status(500).json({ error: 'PO 模板渲染失败' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e: any) {
      logger.error('[ProcurementRoute] GET preview.html failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to preview purchase order' });
    }
  });

  // ── POST /:id/generate-document — 登记域单据 + 服务端渲染 PDF 落盘归档
  //    幂等：domain+type+sourceRef 唯一定位；重复生成刷新头字段并覆盖 PDF（真源实时渲染） ──
  router.post('/:id/generate-document', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!po) return res.status(404).json({ error: '采购单不存在' });

      const actorId = actor?.userId || 'system';
      const reg = await upsertDomainTradeDocument(prisma, {
        domain: 'procurement',
        type: 'PurchaseOrder',
        sourceRef: po.id,
        documentNumber: po.poNumber, // 文档号=业务单号裁决（与 CI 财务回链同号语义一致）
        orderId: po.orderId,
        relationId: po.supplierRelationId,
        totalAmount: po.totalAmount != null ? Number(po.totalAmount) : null,
        currency: po.currency,
        issueDate: po.orderDate,
        actorId,
      });
      const file = await generateTradeDocumentFile(prisma, { id: reg.documentId, actorId });
      res.json({ document: reg, file });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST generate-document failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : 500);
      res.status(status).json({ error: e?.message || 'failed to generate purchase order document' });
    }
  });

  // ── POST / — 创建 ──
  router.post('/', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as CreatePurchaseOrderInput;

      if (!input.poNumber || !input.currency || !input.orderDate) {
        return res.status(400).json({ error: '缺少必填字段：poNumber / currency / orderDate' });
      }
      if (!input.lines || input.lines.length === 0) {
        return res.status(400).json({ error: '至少需要一行采购明细' });
      }
      for (const line of input.lines) {
        if (!line.description || !line.unit || line.quantity == null || line.unitPrice == null) {
          return res.status(400).json({ error: '采购行缺少必填字段：description / unit / quantity / unitPrice' });
        }
      }

      const existing = await prisma.purchaseOrder.findUnique({ where: { poNumber: input.poNumber } });
      if (existing) {
        return res.status(409).json({ error: `采购单号 ${input.poNumber} 已存在` });
      }

      const purchaseOrder = await service.createPurchaseOrder(input, actor?.userId || 'system');
      onDataChange?.({ entity: 'PurchaseOrder', action: 'create', ids: [purchaseOrder.id] });
      res.status(201).json({ purchaseOrder });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST create failed', { error: e?.message });
      if (e instanceof PurchaseOrderDomainError) return res.status(e.status).json({ error: e.message, code: e.code });
      const failure = safeRouteError(undefined, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '采购单创建结果暂不可确认，请刷新核对原单后重试；持续失败请联系管理员。' });
      return res.status(failure.status).json({ error: failure.message, code: failure.code });
    }
  });

  // ── PUT /:id — 更新（仅 Draft） ──
  router.put('/:id', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as UpdatePurchaseOrderInput;
      const purchaseOrder = await service.updatePurchaseOrder(req.params.id, input, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedOrderId });
      onDataChange?.({ entity: 'PurchaseOrder', action: 'update', ids: [purchaseOrder.id] });
      res.json({ purchaseOrder });
    } catch (e: any) {
      logger.error('[ProcurementRoute] PUT update failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('仅 Draft') ? 409 : 400);
      res.status(status).json({ error: e?.message || 'failed to update purchase order' });
    }
  });

  // ── DELETE /:id — 软删除（仅 Draft） ──
  router.delete('/:id', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      await service.deletePurchaseOrder(req.params.id, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedOrderId });
      onDataChange?.({ entity: 'PurchaseOrder', action: 'delete', ids: [req.params.id] });
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[ProcurementRoute] DELETE failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('仅 Draft') ? 409 : 400);
      res.status(status).json({ error: e?.message || 'failed to delete purchase order' });
    }
  });

  // ── POST /:id/send — 发送采购单 ──
  router.post('/:id/send', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const purchaseOrder = await service.sendPurchaseOrder(req.params.id, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedOrderId });
      onDataChange?.({ entity: 'PurchaseOrder', action: 'send', ids: [purchaseOrder.id] });
      res.json({ purchaseOrder });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST send failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('非法') ? 409 : 400);
      res.status(status).json({ error: e?.message || 'failed to send purchase order' });
    }
  });

  // ── POST /:id/confirm — 确认采购单 ──
  router.post('/:id/confirm', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const purchaseOrder = await service.confirmPurchaseOrder(req.params.id, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedOrderId });
      onDataChange?.({ entity: 'PurchaseOrder', action: 'confirm', ids: [purchaseOrder.id] });
      res.json({ purchaseOrder });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST confirm failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('非法') ? 409 : 400);
      res.status(status).json({ error: e?.message || 'failed to confirm purchase order' });
    }
  });

  // ── POST /:id/cancel — 取消采购单 ──
  router.post('/:id/cancel', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const { reason } = req.body || {};
      const purchaseOrder = await service.cancelPurchaseOrder(req.params.id, actor?.userId || 'system', reason, { expectedOrderId: res.locals.authorizedOrderId });
      onDataChange?.({ entity: 'PurchaseOrder', action: 'cancel', ids: [purchaseOrder.id] });
      res.json({ purchaseOrder });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST cancel failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('非法') ? 409 : 400);
      res.status(status).json({ error: e?.message || 'failed to cancel purchase order' });
    }
  });

  // ── POST /:id/close — 关闭采购单 ──
  router.post('/:id/close', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const purchaseOrder = await service.closePurchaseOrder(req.params.id, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedOrderId });
      onDataChange?.({ entity: 'PurchaseOrder', action: 'close', ids: [purchaseOrder.id] });
      res.json({ purchaseOrder });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST close failed', { error: e?.message });
      const status = e?.status ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('非法') ? 409 : 400);
      res.status(status).json({ error: e?.message || 'failed to close purchase order' });
    }
  });

  // ── GET /:id/receipts — 来料记录列表 ──
  router.get('/:id/receipts', requireProcurementRead, guardPO, async (req: Request, res: Response) => {
    try {
      // §10.4.2：来料记录随其采购单的关联订单可见
      const po = await service.getPurchaseOrder(req.params.id);
      const visForReceipts = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      if (!po || !isOrderLinkedVisible(visForReceipts, (po as any).orderId)) {
        return res.status(404).json({ error: '采购单不存在' });
      }
      const receipts = await prisma.materialReceipt.findMany({
        where: { purchaseOrderId: req.params.id },
        orderBy: { receivedDate: 'desc' },
      });
      res.json({ receipts });
    } catch (e: any) {
      logger.error('[ProcurementRoute] GET receipts failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list receipts' });
    }
  });

  // ── POST /:id/receipts — 创建来料检验记录 ──
  router.post('/:id/receipts', requireWrite, requireProcurementWrite, guardPO, async (req: Request, res: Response) => {
    try {
      const actor = extractActorFromRequest(req);
      const input = req.body as MaterialReceiptInput;

      if (!input.receiptNumber || !input.receivedDate || input.totalReceived == null || input.totalAccepted == null || input.totalRejected == null) {
        return res.status(400).json({ error: '缺少必填字段：receiptNumber / receivedDate / totalReceived / totalAccepted / totalRejected' });
      }

      const receipt = await service.createMaterialReceipt(req.params.id, input, actor?.userId || 'system', { expectedOrderId: res.locals.authorizedOrderId });
      onDataChange?.({ entity: 'MaterialReceipt', action: 'create', ids: [receipt.id] });
      onDataChange?.({ entity: 'PurchaseOrder', action: 'receipt', ids: [req.params.id] });
      res.status(201).json({ receipt });
    } catch (e: any) {
      logger.error('[ProcurementRoute] POST receipts failed', { error: e?.message });
      if (e instanceof ReceiptDomainError) return res.status(e.status).json({ error: e.message, code: e.code });
      const failure = safeRouteError(undefined, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '收料结果暂不可确认，请刷新核对原收料记录后重试；持续失败请联系管理员。' });
      return res.status(failure.status).json({ error: failure.message, code: failure.code });
    }
  });

  // 加工服务沿用采购域，不产生物料入库；应付仅由财务权限创建草稿。
  const serviceDeliveries = createPurchaseServiceDeliveryService(prisma);
  const deliveryJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
  const deliveryError = (res: Response, error: unknown) => {
    if (error instanceof PurchaseServiceDeliveryError) return res.status(error.status).json({ error: error.message, code: error.code });
    logger.error('[ProcurementRoute] service delivery failed', { error: error instanceof Error ? error.message : 'unknown' });
    return res.status(500).json({ error: '服务交付处理失败，请核对记录后重试' });
  };
  router.get('/:id/service-deliveries', requireProcurementRead, async (req, res) => {
    try { res.json(deliveryJson(await serviceDeliveries.list(req.params.id, await visibleFor(req)))); }
    catch (error) { deliveryError(res, error); }
  });
  router.post('/:id/service-deliveries', requireWrite, requireProcurementWrite, async (req, res) => {
    try {
      const result = await serviceDeliveries.create(req.params.id, req.body ?? {}, extractActorFromRequest(req)?.userId || 'system', await visibleFor(req));
      if (!result.replayed) onDataChange?.({ entity: 'PurchaseOrder', action: 'service-delivery', ids: [req.params.id] });
      res.status(result.replayed ? 200 : 201).json(deliveryJson(result));
    } catch (error) { deliveryError(res, error); }
  });
  router.post('/service-deliveries/:deliveryId/payable-draft', requireWrite, requirePermission('invoices:write'), async (req, res) => {
    try {
      const result = await serviceDeliveries.createPayableDraft(req.params.deliveryId, extractActorFromRequest(req)?.userId || 'system', await visibleFor(req));
      if (!result.replayed) onDataChange?.({ entity: 'Invoice', action: 'create', ids: [result.invoice.id] });
      res.status(result.replayed ? 200 : 201).json(deliveryJson(result));
    } catch (error) { deliveryError(res, error); }
  });

  return router;
}
