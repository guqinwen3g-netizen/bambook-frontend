import { createOrderLine } from './orderLineMutationService';
import { stripLineWritable } from './orderLineWritable';
import { parseOrderQuantity, normalizeOrderQuantityUnit, OrderQuantityError } from '../shared/orderQuantitySummary';
import { guardOrderHeaderQuantity, orderQuantityDto } from '../shared/orderQuantityWriteGuard';
import { assertOrderHeaderEditable, samePersistedOrderField } from './orderHeaderMutationPolicy';
import { orderTradeTermsError, orderLineDeliveryError, normalizeOrderTradePatch } from '../shared/orderTradeTerms';
import { authorizeOrderLineWrite, currentOrderLineWriteActor, freshOrderLineScope, orderLineWriteFailure } from './orderLineWriteAccess';
import {refreshOrderQuantityHeader} from '../shared/orderQuantityProjection';
import { Router, Request, Response } from 'express';
import { extractActorFromRequest } from '../auth/middleware';
import { requirePermission } from '../auth/permissionGuard';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { writeRouteAuditLog, actorIdFromRequest } from '../audit/routeAudit';
import { deleteOrder, transitionOrderStatus, VALID_ORDER_STATUSES as LIFECYCLE_VALID_STATUSES, ORDER_LIFECYCLE_ERROR_HTTP_STATUS } from './orderLifecycleService';
import { directCancelPendingOrder, DIRECT_CANCEL_ERROR_HTTP_STATUS } from '../orderChanges/orderChangeRequestService';
import { recalcOrderAmountFromLines, type RecalcMode } from '../orderChanges/orderAmountRecalc';
import { Prisma, PrismaClient } from '@prisma/client';
import { persistOrders, PersistResult } from '../import/persistOrders';
import { ParsedOrder } from '../import/types';
import { syncOrderEntityReferences } from '../entities/sync';
import { getOrderContext, queryOrders } from './query';
import { buildOrderListScopeWhere } from './orderService';
import { checkTolerance, getOrderToleranceStatus } from './toleranceService';
import { logger } from '../lib/logger';
import { allocateInternalOrderCode, normalizeExternalPoNumber, resolveOrderId } from './orderIdentity';
import { resolveConfirmedSource } from '../development/convertService';
import { lockConfirmedFabricSources } from '../development/fabricAssetEligibility';
import { mountOrderShipmentDocumentsRoutes } from './orderShipmentDocumentsRoute';
import { mountCustomerPoEvidenceRoutes } from './customerPoEvidenceRoute';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';
import { businessError, lookupErrorCode } from '../shared/errorCodes';
import { createOrderMainApprovalService, OrderMainApprovalError } from './orderMainApprovalService';
import { normalizeRequiredSampleFamilies } from './orderRequiredSampleFamilies';
import { createMoqConfigService } from '../moq/moqConfigService';
import { assertActorBusinessTeam, orderBusinessFamily, isInternalOrderPurpose, normalizeInternalOrderInput } from './internalOrderFacts';
import { localDateKey } from '../shared/localDate';
import { businessNowDate } from '../shared/businessClock';



export interface OrdersRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

/**
 * Express router for the persistent Order resource.
 *
 *   GET    /            → list active orders (with lines, BigInts → numbers)
 *   POST   /import      → controlled legacy data migration only (data:import + users:admin JWT)
 *   POST   /            → create a manually entered order. Marks supplied
 *                         fields as `'manual'`; PO evidence is uploaded separately.
 *   PUT    /:id         → patch a single order from the detail card. Each
 *                         supplied field is tagged `'manual'` (or
 *                         `'imported-then-edited'` if it was previously 'pdf').
 *
 * The frontend's order list reads from `GET /api/v1/orders`, the same persistent
 * source used by manual order entry and controlled migration. Tombstoned rows
 * (`deletedAt != null`) are excluded server-side; the client merges with its
 * localStorage tombstones via the existing `converge()` helper.
 */
export function createOrdersRouter(opts: OrdersRouterOptions): Router {
  const router = Router();
  const { requireAuth, apiKeys } = opts;

  // Shared auth guard: JWT cookie/Bearer OR API-key header.
  // Replaces inline api-key-only guard — write ops now require JWT + role below.
  const guard = createModuleAuthGuard({ requireAuth, apiKeys });
  router.use(guard);

  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const orderMainApproval = createOrderMainApprovalService(opts.prisma);

  // Register before generic /:id handlers: business reads logistics-returned
  // CI/PL and records the exact issued/archived version sent offline.
  mountOrderShipmentDocumentsRoutes(router, { prisma: opts.prisma, requireWrite });
  // Customer PO originals are order-scoped evidence only; this endpoint never parses them.
  mountCustomerPoEvidenceRoutes(router, { prisma: opts.prisma, requireWrite, onDataChange: opts.onDataChange });

  router.post('/:id/submit-main-approval', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const actorId = actorIdFromRequest(req);
    if (!actorId) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', message: '需要登录后提交订单审批。' });
    try {
      const item = await orderMainApproval.submit(req.params.id, actorId, extractActorFromRequest(req));
      return res.status(201).json({ ok: true, item });
    } catch (error: any) {
      if (error instanceof OrderMainApprovalError) return res.status(error.statusCode).json({ ok: false, error: error.code, message: error.message });
      const safe = safeRouteError(error, { fallbackCode: 'ORDER_APPROVAL_SUBMIT_FAILED', fallbackMessage: '订单审批提交失败。' });
      return res.status(safe.status).json({ ok: false, error: safe.code, message: safe.message });
    }
  });

  router.get('/', requirePermission('orders:read'), async (req: Request, res: Response) => {
    try {
      // S3-γ：行级数据范围（对齐 v2 口径；无 actor 的 dev/API-Key 读走旧口径放行）
      const scopeWhere = await buildOrderListScopeWhere(opts.prisma, (req as any).actor ?? null);
      const rows = await opts.prisma.order.findMany({
        where: { deletedAt: null, ...scopeWhere },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
        orderBy: [{ importedAt: 'desc' }, { updatedAt: 'desc' }],
      });
      return res.json({ ok: true, orders: rows.map(serializeOrder) });
    } catch (e: any) {
      logger.error('[orders/list] failed', { error: e?.message || String(e) });
      return res.status(500).json({
        ok: false,
        error: { code: 'LIST_FAILED', message: '订单列表查询失败' },
      });
    }
  });

  router.post('/query', requirePermission('orders:read'), async (req: Request, res: Response) => {
    try {
      const result = await queryOrders(opts.prisma, req.body || {}, { actor: (req as any).actor, developmentRead: (req as any).authSource === 'dev' && !(req as any).actor });
      return res.json({ ok: true, ...result });
    } catch (e: any) {
      logger.error('[orders/query] failed', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'QUERY_FAILED', fallbackMessage: '订单查询失败' });
      return res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  // 阶段 D / D3：订单全链路聚合（只读）。注册在 /:id 之前避免歧义。
  router.get('/:id/context', requirePermission('orders:read'), async (req: Request, res: Response) => {
    try {
      const result = await getOrderContext(opts.prisma, req.params.id, { actor: (req as any).actor, developmentRead: (req as any).authSource === 'dev' && !(req as any).actor });
      if (!result.found) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
      return res.json({ ok: true, ...result });
    } catch (e: any) {
      logger.error('[orders/context] failed', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'CONTEXT_FAILED', fallbackMessage: '订单全链路聚合查询失败' });
      return res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  // REQ2-03 溢短装状态：全部行已发量 vs 合同量（±N% 条款校验，只读）
  router.get('/:id/tolerance-status', requirePermission('orders:read'), async (req: Request, res: Response) => {
    try {
      const status = await getOrderToleranceStatus(opts.prisma, req.params.id);
      if (!status) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
      return res.json({ ok: true, ...status });
    } catch (e: any) {
      logger.error('[orders/tolerance-status] failed', { error: e?.message || String(e) });
      return res.status(500).json({ ok: false, error: { code: 'TOLERANCE_FAILED', message: '订单溢短装状态查询失败' } });
    }
  });

  // REQ2-03 纯计算端点：发货/开票量容差预检（供前端与发货域共用，无副作用）
  router.post('/tolerance-check', requirePermission('orders:read'), async (req: Request, res: Response) => {
    try {
      const { contractQty, actualQty, tolerancePercent, unitPrice } = req.body ?? {};
      const result = checkTolerance({ contractQty, actualQty, tolerancePercent, unitPrice });
      return res.json({ ok: true, check: result });
    } catch (e: any) {
      const status = e?.code === 'INVALID_QTY' ? 400 : 500;
      return res.status(status).json({ ok: false, error: { code: e?.code ?? 'TOLERANCE_CHECK_FAILED', message: e?.message ?? '校验失败' } });
    }
  });

  router.get('/:id', requirePermission('orders:read'), async (req: Request, res: Response) => {
    try {
      // S3-γ 行级补缺（对齐列表 :57 buildOrderListScopeWhere 口径）：详情此前不带 actor
      // 不查 dataScope，Sales 可凭 id/PO 直读跨部门订单——现复用同一行级 where，
      // 无 actor 的 dev/API-Key 读仍走旧口径放行；Sales 跨部门订单详情 → 404（同列表不可见）
      const scopeWhere = await buildOrderListScopeWhere(opts.prisma, (req as any).actor ?? null);
      const orderId = await resolveOrderId(opts.prisma, req.params.id, scopeWhere);
      if (!orderId) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
      const where: any = { deletedAt: null, id: orderId };
      if (Object.keys(scopeWhere).length > 0) {
        where.AND = scopeWhere;
      }
      const order = await opts.prisma.order.findFirst({
        where,
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });
      if (!order) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
      return res.json({ ok: true, order: serializeOrder(order) });
    } catch (e: any) {
      logger.error('[orders/detail] failed', { error: e?.message || String(e) });
      if (e?.code === 'AMBIGUOUS_ORDER_REFERENCE') return res.status(409).json({ ok: false, error: { code: e.code, message: e.message } });
      return res.status(500).json({ ok: false, error: { code: 'DETAIL_FAILED', message: '订单详情查询失败' } });
    }
  });

  // This compatibility endpoint accepts pre-parsed order payloads for controlled
  // migration/seed tooling only. It is not a customer-PO upload or business order
  // entry flow. data:import is also granted to sales users, so it is insufficient
  // by itself; require the separate users:admin grant to keep this write path privileged.
  router.post('/import', requireWrite, requirePermission('data:import'), requirePermission('users:admin'), async (req: Request, res: Response) => {
    const body = req.body as { orders?: ParsedOrder[]; overwriteExisting?: boolean; mode?: 'overwrite-pdf-fields-only' | 'force-overwrite' } | undefined;
    const orders = Array.isArray(body?.orders) ? body!.orders : [];
    if (orders.length === 0) {
      return res.status(400).json({
        ok: false,
        error: { code: 'NO_ORDERS', message: 'POST body must be { "orders": ParsedOrder[] } with at least one order' },
      });
    }

    const invalid = orders.filter((o) => !o || typeof o.poNumber !== 'string' || !o.poNumber);
    if (invalid.length > 0) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_ORDER', message: `Every order must have a non-empty poNumber. ${invalid.length} bad row(s).` },
      });
    }

    try {
      const results: PersistResult[] = await persistOrders(opts.prisma, orders, {
        mode: body?.mode ?? 'overwrite-pdf-fields-only',
        overwriteExisting: body?.overwriteExisting ?? true,
      });

      // Hydrate freshly-saved rows so the frontend can drop them straight into
      // its in-memory list without a follow-up GET.
      const ids = results.map((r) => r.orderId);
      const saved = await opts.prisma.order.findMany({
        where: { id: { in: ids } },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });
      for (const order of saved) {
        await syncOrderEntityReferences(opts.prisma, order as any, { source: 'pdf-import' });
      }
      // Convert BigInt fields → numbers so Express's JSON serializer can handle them.
      const savedJson = saved.map(serializeOrder);
      opts.onDataChange?.({ entity: 'orders', action: 'import', ids });

      const created = results.filter((r) => r.action === 'created').length;
      const updated = results.filter((r) => r.action === 'updated').length;
      return res.json({
        ok: true,
        created,
        updated,
        results,
        orders: savedJson,
      });
    } catch (e: any) {
      logger.error('[orders/import] failed', { error: e?.message || String(e) });
      return res.status(500).json({
        ok: false,
        error: { code: 'PERSIST_FAILED', message: '订单导入持久化失败' },
      });
    }
  });

  /** Create a manually entered order; customer PO evidence is stored separately. */
  router.post('/', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown> & { id?: string; poNumber?: string };
    if (isInvalidOrderBusinessLine(body)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: '订单业务线仅接受 fabric（面料）或 garment（成衣）；未明确时可暂不填写。' } });
    }
    const errors: string[] = [];
    if (!['external', 'internal_stock', 'internal_fabric_supply'].includes(String(body.orderPurpose ?? ''))) errors.push('请选择订单来源。');
    if (!body.customer && !isInternalOrderPurpose(body.orderPurpose)) errors.push('customer (客户) is required');
    if (errors.length > 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: errors.join('; ') } });
    }

    const entryLines = body.lines;
    if (entryLines !== undefined && (!Array.isArray(entryLines) || entryLines.length < 1 || entryLines.length > 100 || entryLines.some(line => !line || typeof line !== 'object' || Array.isArray(line)))) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: '请填写 1–100 个完整订单条目。' } });
    }
    const ts = Date.now();
    const id = sanitizeId(body.id) ?? `FAB-${String(ts).slice(-6)}`;
    const writableInput = stripReadonly(body);
    Object.assign(writableInput, normalizeOrderTradePatch(writableInput));
    const tradeError = orderTradeTermsError(writableInput);
    if (tradeError) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: tradeError } });
    Object.assign(writableInput, normalizeOrderTradePatch(writableInput));

    // Required scalar columns. Manual entry rarely supplies these explicitly
    // so we fall back to safe defaults.
    const product = (writableInput.product as string | undefined) ?? '';
    let quantity:string|null=null;let unit=normalizeOrderQuantityUnit(writableInput.unit);
    try {if(writableInput.quantity!=null) quantity=parseOrderQuantity(writableInput.quantity);if(writableInput.unit!=null&&!unit)throw new Error('数量单位未识别');}catch(e:any){return res.status(400).json({ok:false,error:{code:'INVALID_INPUT',message:e.message}});}
    const status = (writableInput.status as string | undefined) ?? 'Pending';
    if (status !== 'Pending') return res.status(409).json({ ok: false, error: { code: 'ORDER_MAIN_APPROVAL_REQUIRED', message: '新订单必须先以草稿状态保存，再由业务负责人审批后确认。' } });
    const dueDate = (writableInput.dueDate as string | undefined) ?? (writableInput.clientDate as string | undefined) ?? '';
    const quoteAmount = Number.isFinite(Number(writableInput.quoteAmount))
      ? Number(writableInput.quoteAmount)
      : Number.isFinite(Number(writableInput.contractAmount)) ? Number(writableInput.contractAmount) : 0;

    const fieldSources: Record<string, 'manual'> = {};
    for (const k of Object.keys(writableInput)) {
      if (k === 'fieldSources' || k === 'lines' || k === 'orderDate') continue;
      fieldSources[k] = 'manual';
    }

    try {
      // $transaction wraps create + auditLog to enforce fail-closed:
      // if AuditLog write fails, the order create rolls back.
      const created = await opts.prisma.$transaction(async (tx) => {
        const currentActor = await currentOrderLineWriteActor(tx, extractActorFromRequest(req), 'create');
        await assertActorBusinessTeam(tx, currentActor, orderBusinessFamily(writableInput));
        Object.assign(writableInput, await normalizeInternalOrderInput(tx, currentActor, writableInput));
        const moqSnapshot = await createMoqConfigService({ prisma: tx as any }).buildSnapshot();
        const code = await allocateInternalOrderCode(tx);
        const poNumber = normalizeExternalPoNumber(writableInput.poNumber);
        const order = await tx.order.create({
          data: {
            ...(writableInput as any),
            id,
            code,
            poNumber,
            customer: writableInput.customer as string,
            ownerId: currentActor.userId,
            product,
            type: (writableInput.type as string | undefined) ?? 'Fabric',
            moqSnapshot: moqSnapshot as unknown as Prisma.InputJsonValue,
            quantity,
            unit,
            status,
            dueDate,
            quoteAmount,
            // 业务规则：下单后7天生产计划截止，交货期前15天延期通知截止
            productionPlanDeadline: (() => {
              const d = businessNowDate();
              d.setDate(d.getDate() + 7);
              return localDateKey(d);
            })(),
            delayNoticeDeadline: dueDate ? (() => {
              const d = new Date(dueDate);
              d.setDate(d.getDate() - 15);
              return localDateKey(d);
            })() : null,
            source: 'manual',
            updatedAt: BigInt(ts),
            importedAt: BigInt(ts),
            salesCurrency: (writableInput.salesCurrency as string | undefined) ?? 'USD',
            purchaseCurrency: (writableInput.purchaseCurrency as string | undefined) ?? 'CNY',
            fieldSources: fieldSources as Prisma.InputJsonValue,
          },
          include: { lines: { orderBy: { lineNumber: 'asc' } } },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorIdFromRequest(req),
          source: 'route:orders:create',
          operation: 'create_order',
          targetType: 'Order',
          targetId: order.id,
          after: {
            id: order.id,
            code: order.code,
            poNumber: order.poNumber,
            customer: order.customer,
            product: order.product,
            type: order.type,
            businessLine: order.businessLine,
            status: order.status,
            quantity: order.quantity,
            quoteAmount: order.quoteAmount,
            dueDate: order.dueDate,
            millName: order.millName,
          },
          ip: req.ip || null,
        });
        if (Array.isArray(entryLines)) {
          for (const [index, input] of entryLines.entries()) {
            const writable = stripLineWritable(input as Record<string, unknown>);
            if (['productionBatch', 'productionSteps', 'shippingDate', 'invoiceNumber', 'actualPaymentDate'].some(key => key in writable)) throw businessError('INVALID_INPUT', '生产、出运与收款结果请在后续履约节点登记。');
            if (!writable.exMillDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(writable.exMillDate)) || Number.isNaN(Date.parse(String(writable.exMillDate)))) throw businessError('INVALID_INPUT', `条目 ${index + 1} 请填写出厂交期。`);
            if (!normalizeOrderQuantityUnit(writable.unit)) throw businessError('INVALID_INPUT', `条目 ${index + 1} 请明确数量单位。`);
            const family = String(order.businessLine || order.type).toLowerCase();
            if (family === 'garment' && (!writable.styleNo || !writable.fulfillmentMode || !Array.isArray(writable.cmtIncludedItems))) throw businessError('INVALID_INPUT', `条目 ${index + 1} 请填写款号、履约模式和 CMT 范围。`);
            if (family === 'fabric' && !writable.fabricSupplyMode) throw businessError('INVALID_INPUT', `条目 ${index + 1} 请选择面料供货模式。`);
            const dateError = orderLineDeliveryError(writableInput, writable, true);
            if (dateError) throw businessError('INVALID_INPUT', `条目 ${index + 1}：${dateError}`);
            const { itemNo, lineNumber: _lineNumber, quantity, unit, unitPrice, materialCode, description, status: _status, ...extra } = writable;
            const result = await createOrderLine({ prisma: opts.prisma, transaction: tx, orderId: order.id,
              itemNo: itemNo ? String(itemNo).trim() : undefined, materialCode: materialCode ? String(materialCode) : undefined,
              description: description ? String(description) : undefined, quantity: quantity as number | string,
              unit: String(unit), unitPrice: unitPrice as number | string | undefined, extra,
              trustedActor: extractActorFromRequest(req) ?? undefined, actorId: currentActor.userId });
            if (!result.ok) throw businessError(lookupErrorCode(result.error!.code) ? result.error!.code as any : 'INVALID_INPUT', `条目 ${index + 1}：${result.error!.message}`);
          }
        }
        await syncOrderEntityReferences(opts.prisma, order as any, { source: 'manual' }, tx);
        return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 });
      opts.onDataChange?.({ entity: 'orders', action: 'create', ids: [created.id] });
      return res.json({ ok: true, order: serializeOrder(created) });
    } catch (e: any) {
      logger.error('[orders/create] failed', { error: e?.message || String(e) });
      const code = (e?.code as string | undefined) ?? '';
      if (code === 'P2002') {
        return res.status(409).json({
          ok: false,
          error: { code: 'CONFLICT', message: '内部订单记录已存在，请刷新后核对原单。' },
        });
      }
      const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '订单创建失败' });
      return res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  // ─── POST /lines — DR-053 阶段 1：直接返单/补单（不经开发案，同一套订单行版本契约） ───
  // 输入：confirmedSourceType(SealSample|Sample|Asset) + confirmedSourceId + millRelationId +
  //       clientRequestId（幂等键）+ quantity/dueDate/quoteAmount/customer/poNumber
  router.post('/lines', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, any>;
    try {
      const { confirmedSourceType, confirmedSourceId, millRelationId, clientRequestId, quantity, dueDate, quoteAmount, customer, poNumber } = body;
      if (!confirmedSourceType || !confirmedSourceId) {
        return res.status(400).json({ ok: false, error: { code: 'CONFIRMED_SOURCE_REQUIRED', message: '直接返单必须指定确认成果（confirmedSourceType/confirmedSourceId）' } });
      }
      const qty = parseOrderQuantity(quantity);
      const qtyUnit=normalizeOrderQuantityUnit(body.unit);
      if(!qtyUnit)throw businessError('INVALID_INPUT','直接返单必须提供明确的实际数量单位');
      const dd = String(dueDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dd) || Number.isNaN(new Date(dd).getTime())) {
        return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: '交期必须为 YYYY-MM-DD' } });
      }
      const qa = typeof quoteAmount === 'number' ? quoteAmount : Number(quoteAmount ?? 0);
      if (!Number.isFinite(qa) || qa < 0) {
        return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: '金额必须为非负数值' } });
      }
      const lineAmount = new Prisma.Decimal(String(qa));
      if (lineAmount.decimalPlaces() > 4) throw businessError('INVALID_INPUT', '订单条目金额最多保留四位小数。');

      // 幂等：同 clientRequestId 已建单 → 返回已有订单（不重复建单）
      if (clientRequestId) {
        const existingByKey = await (opts.prisma as any).order.findFirst({ where: { clientRequestId: String(clientRequestId) } }).catch(() => null);
        if (existingByKey) {
          return res.json({ ok: true, order: serializeOrder(existingByKey), recovered: true });
        }
      }

      // 解析确认成果（存在/已确认/工厂匹配 → 档案 → 名称+规格快照）
      const confirmed = await resolveConfirmedSource({ prisma: opts.prisma, confirmedSourceType, confirmedSourceId, millRelationId });
      if (!confirmed.ok) {
        const statusMap: Record<string, number> = { CONFIRMED_SOURCE_NOT_FOUND: 404, CONFIRMED_SOURCE_NOT_APPROVED: 409, MILL_MISMATCH: 409, ASSET_REQUIRED: 409 };
        return res.status(statusMap[confirmed.error.code] || 400).json({ ok: false, error: confirmed.error });
      }
      const { productAssetId } = confirmed.data;
      if (!productAssetId) {
        return res.status(409).json({ ok: false, error: { code: 'ASSET_REQUIRED', message: '确认成果未关联产品档案，无法下单' } });
      }

      const now = BigInt(Date.now());
      const orderId = `ORD-DIRECT-${Date.now().toString(36).toUpperCase()}`;
      const actorId = actorIdFromRequest(req) || 'api';
      const created = await (opts.prisma as any).$transaction(async (tx: any) => {
        await lockConfirmedFabricSources(tx, [{ type: String(confirmedSourceType), id: String(confirmedSourceId) }]);
        const current = await resolveConfirmedSource({ prisma: tx, confirmedSourceType, confirmedSourceId, millRelationId });
        if (!current.ok) throw businessError(current.error.code, current.error.message);
        const { productName, millName, millRelationId: cMill, sourceCode, specSnapshot } = current.data;
        if (current.data.productAssetId !== productAssetId) throw businessError('DEVELOPMENT_SOURCE_CHANGED', '确认成果的产品档案已变化，请保留原请求并重新核对');
        const orderType = (specSnapshot as any)?.mainCategory === 'garment' ? 'garment' : 'fabric';
        const requiredSampleFamilies = normalizeRequiredSampleFamilies({ type: orderType });
        const order = await tx.order.create({
          data: {
            id: orderId,
            code: await allocateInternalOrderCode(tx),
            poNumber: normalizeExternalPoNumber(poNumber),
            customer: String(customer ?? '').trim() || productName,
            product: productName,
            type: orderType,
            quantity: qty,
            unit: qtyUnit,
            status: 'Pending',
            dueDate: dd,
            clientDate: dd,
            quoteAmount: lineAmount,
            totalNet: lineAmount,
            contractAmount: lineAmount,
            millName: millName ?? null,
            millRelationId: cMill ?? null,
            importedAt: now,
            updatedAt: now,
            source: 'direct-repeat',
            clientRequestId: clientRequestId ? String(clientRequestId) : null,
            fieldSources: {} as Prisma.InputJsonValue,
          },
        });
        await tx.orderLine.create({
          data: {
            id: `OL-${orderId}-1`,
            orderId,
            lineNumber: 1,
            materialCode: (specSnapshot as any)?.sku ?? null,
            description: productName,
            exMillDate: dd || null,
            quantity: qty,
            unit: qtyUnit,
            netValue: lineAmount,
            status: 'Pending',
            requiredSampleFamilies,
            // DR-053 阶段 1：版本引用 + 不可变规格快照
            confirmedSourceType: String(confirmedSourceType),
            confirmedSourceId: String(confirmedSourceId),
            confirmedAt: now,
            confirmedBy: actorId,
            specSnapshot: specSnapshot as Prisma.InputJsonValue,
          },
        });
        await refreshOrderQuantityHeader(tx,orderId);
        await syncOrderEntityReferences(opts.prisma, order, { source: 'direct-repeat' }, tx);
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'route:orders:direct-repeat', operation: 'create_direct_repeat_order',
          targetType: 'Order', targetId: orderId,
          after: { orderId, confirmedSourceType, confirmedSourceId, sourceCode, quantity: qty,
            unit: qtyUnit, millRelationId: cMill },
          ip: (req as any).ip ?? null,
        });
        return tx.order.findUniqueOrThrow({where:{id:orderId},include:{lines:true}});
      });
      opts.onDataChange?.({ entity: 'orders', action: 'create-direct-repeat', ids: [orderId] });
      return res.status(201).json({ ok: true, order: serializeOrder(created), recovered: false });
    } catch (e: any) {
      if(e instanceof OrderQuantityError)return res.status(400).json({ok:false,error:{code:'INVALID_INPUT',message:e.message}});
      logger.error('[orders/lines] direct-repeat failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'DIRECT_REPEAT_FAILED', fallbackMessage: '直接返单失败' });
      return res.status(r.status).json({ ok: false, error: { code: r.code, message: r.message } });
    }
  });

  /** Patch an existing order from the detail-card edit flow. */
  router.put('/:id', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: { code: 'BAD_ID', message: 'order id required' } });

    const body = (req.body || {}) as Record<string, unknown>;
    if (isInvalidOrderBusinessLine(body)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: '订单业务线仅接受 fabric（面料）或 garment（成衣）；未明确时可暂不填写。' } });
    }
    const writableInput = stripReadonly(body);
    if (Object.prototype.hasOwnProperty.call(writableInput, 'status')) {
      return res.status(409).json({ ok: false, error: { code: 'STATUS_TRANSITION_REQUIRED', message: '订单状态不能通过编辑接口修改，请使用受控的状态流转操作。' } });
    }
    if (Object.keys(writableInput).length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'EMPTY_PATCH', message: 'patch body has no editable fields' } });
    }

    try {
      const actor = await currentOrderLineWriteActor(opts.prisma, extractActorFromRequest(req), 'update');
      const scope = await freshOrderLineScope(opts.prisma, actor);
      const existing = await opts.prisma.order.findFirst({
        where: { id, deletedAt:null, AND:[scope] },
        select: {
          id: true,
          fieldSources: true,
          status: true,
          poNumber: true,
          customer: true,
          product: true,
          type: true,
          quantity: true,
          quoteAmount: true,
          dueDate: true,
          clientDate: true, deliveryTerms: true, deliveryPlace: true, contractDeliveryDate: true, expectedArrivalDate: true, agreedArrivalDate: true,
          millName: true,
          // ★ S4 任务5（2026-09-25）：金额收口需与 DB **现值**比对，
          //   才能区分「用户真的改了」与「整对象回传的旧值」（见 detectAmountIntent）。
          totalNet: true,
          contractAmount: true,
          // ★ 第 2 批 B（2026-09-26）：同改「数量 + 单价」时要能判出**单价也改了**
          //   ⇒ 与 quantity 一起交给真源重算；不读它就只能二选一（丢一半）。
          salesPrice: true,
          // ★ 第 2 批 C（2026-09-26）：有金额意图时要知道**本单有没有明细行** ——
          //   无明细行 ⇒ 没有可派生的来源 ⇒ 明确拒绝（见下方 ORDER_HAS_NO_LINES）。
          _count: { select: { lines: true } },
        },
      });
      if (!existing) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `order ${id} not found` } });
      }
      if (['deliveryTerms', 'deliveryPlace', 'contractDeliveryDate', 'expectedArrivalDate', 'agreedArrivalDate', 'clientDate', 'dueDate'].some(field => writableInput[field] !== undefined)) {
        Object.assign(writableInput, normalizeOrderTradePatch(writableInput, existing));
        const tradeError = orderTradeTermsError({ ...existing, ...writableInput });
        if (tradeError) return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: tradeError } });
        Object.assign(writableInput, normalizeOrderTradePatch(writableInput, existing));
      }

      // ★★ S4 任务5（2026-09-25）+ 第 2 批 B/C（2026-09-26）：金额意图的判定。
      //
      // 纯函数、**零 DB** ⇒ 提到事务外：好在开事务**之前**就能拒绝（见下面的 C 项检查）。
      // Quantity intent is never an implicit whole-order proportional edit.
      const amountInput={...writableInput};delete amountInput.quantity;delete amountInput.unit;
      const intent = detectAmountIntent(amountInput, existing);

      // ★★ 第 2 批 C（P2）：**无明细行 + 有金额意图 ⇒ 明确拒绝，不静默分叉**。
      //
      // 病根：真源重算 `recalcOrderAmountFromLines` 对无明细行的订单**显式返回 null**
      //   （orderAmountRecalc.ts 的注释原文：「无明细行：没有可分摊的载体，保持主档单点写入
      //   （既有行为）」）⇒ 本端点 `if (recalc)` 不成立 ⇒ 四个金额键**不被剔除** ⇒
      //   patch 原样落库 ⇒ `contractAmount=10020` 而 `quoteAmount=1001.5`、`totalNet=null`
      //   **三列永久分叉，且返回 200 一声不吭**。
      //
      // 为什么选「拒绝」而不是「至少把降级显式化」：
      //   明细行是金额的**唯一来源**（Kevin 2026-09-18 拍板：订单金额 = Σ明细行 netValue，
      //   主档金额由明细行派生、不手工填）。一张无明细行的订单上写主档金额，写进去的是
      //   **无源之数** —— 它没有任何东西可以与它对账，将来补了明细行只会立刻自相矛盾。
      //   而「显式化」仍然把无源之数落了库，只是让人看见 —— 那是**把错账说清楚**，
      //   不是**不写错账**。故选拒绝，并把下一步（先录明细行）写进文案。
      //
      // ★ 影响面（实测）：测试库活单 69 张**全部有明细行** ⇒ 今天触发面为 0；
      //   拍板件写的「1069 张里 1000 张无明细行」是**含已删行**的读数（那 1000 张全是已删行）。
      if (intent && (existing as any)._count?.lines === 0) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'ORDER_HAS_NO_LINES',
            message: '本订单没有任何明细行，无法确定金额来源（订单金额 = 明细行合计）。请先录入明细行，再修改数量或金额。',
          },
        });
      }

      // $transaction wraps update + auditLog to enforce fail-closed:
      // if AuditLog write fails, the order update rolls back.
      const updated = await opts.prisma.$transaction(async (tx) => {
        const authorized = await authorizeOrderLineWrite(tx, id, extractActorFromRequest(req), 'update');
        const current = authorized.order;
        Object.assign(writableInput, await normalizeInternalOrderInput(tx, authorized.actor, writableInput, current));
        assertOrderHeaderEditable(current as unknown as Record<string, unknown>, writableInput);
        if (['deliveryTerms', 'contractDeliveryDate', 'agreedArrivalDate'].some(key => key in writableInput)) {
          const lines = await tx.orderLine.findMany({ where: { orderId: id } });
          for (const line of lines) {
            const error = orderLineDeliveryError({ ...current, ...writableInput }, line as unknown as Record<string, unknown>);
            if (error) throw businessError('INVALID_INPUT', `条目 ${line.itemNo || line.lineNumber}：${error}`);
          }
        }
        await guardOrderHeaderQuantity(tx,current,writableInput,body.expectedUpdatedAt??body.updatedAt);
        const previousSources = parsePrevSources(current.fieldSources);
        const nextSources: Record<string, 'pdf' | 'manual' | 'imported-then-edited'> = { ...previousSources };
        const changedFields = Object.keys(writableInput).filter(field =>
          field !== 'fieldSources' && field !== 'lines'
          && !samePersistedOrderField((current as any)[field], writableInput[field]));
        for (const field of changedFields) {
          const source = previousSources[field];
          nextSources[field] = source === 'pdf' || source === 'imported-then-edited' ? 'imported-then-edited' : 'manual';
        }
        // ★★ S4 任务5（2026-09-25）：手动编辑路径的**金额收口**。
        //
        // 缺陷：本端点此前把 patch 里的金额列**原样落库** —— `stripReadonly` 只按
        //   ORDER_WRITABLE_FIELDS 白名单过滤，**零口径校验**。而前端「改销售单价 /
        //   改数量」只重算 `contractAmount`（OrderManager.tsx:892 applyAmountLinkage），
        //   不碰 `totalNet`、也不碰明细行 ⇒ 落库后
        //   `contractAmount` 与 `totalNet` / Σ明细行 **永久分叉**（出错账，且不报错）。
        //
        // 收口方式：与**审批路径**（orderChangeRequestService.ts:651）共用同一真源重算
        //   `recalcOrderAmountFromLines` —— 该模块文件头即写明「收口，不逐点补：
        //   所有「改单影响金额」的路径都走本模块」。此处**不再另写一套口径逻辑**。
        //   ★ `intent` 已在事务外算好（纯函数）；无明细行的情形也已在事务外拒绝。
        if (intent) {
          let recalc: Awaited<ReturnType<typeof recalcOrderAmountFromLines>> = null;
          try {
            recalc = await recalcOrderAmountFromLines(
              tx, id, intent.mode, intent.value,
              // ★ 第 2 批 B：同改「数量 + 单价」时把单价一并交给真源（不丢一半）
              intent.unitPrice != null ? { unitPrice: intent.unitPrice } : undefined,
            );
          } catch (e: any) {
            // 联动是**增强**，不能反过来把编辑主流程搞挂：失败降级为「只写主档」并告警
            // （与 orderChangeRequestService.ts:655 的降级策略一致）。
            logger.error('[orders/update] 金额联动重算失败，降级为仅写主档', {
              orderId: id, mode: intent.mode, value: intent.value, error: String(e?.message ?? e),
            });
            throw e;
          }
          if (recalc) {
            // 重算已写入主档派生金额（quantity/totalNet/contractAmount/quoteAmount，
            // 同改单价时**含 salesPrice**）：
            // 剔除单点写入，避免随后 update 用 patch 里的**旧值**把它们覆盖回去。
            // ★ salesPrice **不在剔除清单里** —— 它已被真源按用户输入回写，
            //   而 patch 里的同名值就是用户输入本身（同一个数），落库幂等。
            for (const k of ['quantity', 'quoteAmount', 'contractAmount', 'totalNet']) {
              delete writableInput[k];
            }
            logger.info('[orders/update] 金额联动重算完成', {
              orderId: id, mode: intent.mode, target: intent.value, unitPrice: intent.unitPrice ?? null,
              lines: recalc.linesUpdated, quantity: recalc.quantity, totalNet: recalc.totalNet,
            });
          }
        }

        const order = await tx.order.update({
          where: { id },
          data: {
            ...(writableInput as any),
            updatedAt: BigInt(Date.now()),
            fieldSources: nextSources as Prisma.InputJsonValue,
          },
          include: { lines: { orderBy: { lineNumber: 'asc' } } },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: authorized.actor.userId,
          source: 'route:orders:update',
          operation: 'update_order',
          targetType: 'Order',
          targetId: order.id,
          before: {
            status: existing.status,
            poNumber: existing.poNumber,
            customer: existing.customer,
            product: existing.product,
            type: existing.type,
            quantity: existing.quantity,
            quoteAmount: existing.quoteAmount,
            dueDate: existing.dueDate,
            millName: existing.millName,
            specialInstructions: current.specialInstructions,
            fieldSources: previousSources,
            changedValues: Object.fromEntries(changedFields.map(field => [field, (current as any)[field]])),
          },
          after: {
            status: order.status,
            poNumber: order.poNumber,
            customer: order.customer,
            product: order.product,
            type: order.type,
            quantity: order.quantity,
            quoteAmount: order.quoteAmount,
            dueDate: order.dueDate,
            millName: order.millName,
            specialInstructions: order.specialInstructions,
            fieldSources: nextSources,
            changedFields,
            changedValues: Object.fromEntries(changedFields.map(field => [field, (order as any)[field]])),
          },
          ip: req.ip || null,
        });
        return order;
      });
      await syncOrderEntityReferences(opts.prisma, updated as any, { source: 'manual' });
      opts.onDataChange?.({ entity: 'orders', action: 'update', ids: [updated.id] });
      return res.json({ ok: true, order: serializeOrder(updated) });
    } catch (e: any) {
      if(e instanceof OrderQuantityError)return res.status(400).json({ok:false,error:{code:'INVALID_INPUT',message:e.message}});
      const authority = orderLineWriteFailure(e);
      if (authority) return res.status(businessError(authority.code,authority.message).statusCode).json({ok:false,error:authority});
      if(e?.code==='CONFLICT'||e?.code==='INVALID_INPUT')return res.status(e.code==='CONFLICT'?409:400).json({ok:false,error:{code:e.code,message:e.message}});
      logger.error('[orders/update] failed', { error: e?.message || String(e) });
      return res.status(500).json({ ok: false, error: { code: 'UPDATE_FAILED', message: '订单更新失败' } });
    }
  });

  // task ERP-P1: DELETE /:id 调 lifecycleService（事务+audit+EntityLink inactive）
  router.delete('/:id', requireWrite, requirePermission('business:delete'), async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: { code: 'BAD_ID', message: 'order id required' } });
    try {
      const result = await deleteOrder({
        prisma: opts.prisma, orderId: id,
        actorId: (req as any).actor?.userId || (req as any).actor?.id || 'api',
      });
      if (!result.ok) {
        // 映射真源 = orderLifecycleService.ORDER_LIFECYCLE_ERROR_HTTP_STATUS（编译期强制完整，
        // 与下方 status-transition 同一份）。此处曾自己抄了一份 statusCodeMap ⇒ 新增码必漏
        // （B14 的 DEPENDENCY_CHECK_FAILED 就是第 4 次踩同一坑，见该常量注释）。
        // HAS_DEPENDENTS 由服务层 throw 抛出、至今不在 OrderLifecycleErrorCode 联合类型里
        // （靠 `catch (e: any)` 活着），只能在这里补 —— 遗留项已登记。
        const statusCodeMap: Record<string, number> = {
          ...ORDER_LIFECYCLE_ERROR_HTTP_STATUS,
          HAS_DEPENDENTS: 409,
        };
        return res.status(statusCodeMap[result.error!.code] || 500).json({ ok: false, error: result.error });
      }
      opts.onDataChange?.({ entity: 'orders', action: 'delete', ids: [id] });
      return res.json({ ok: true, order: serializeOrder(result.data!.order) });
    } catch (e: any) {
      logger.error('[orders/delete] failed', { error: e?.message || String(e) });
      return res.status(500).json({ ok: false, error: { code: 'DELETE_FAILED', message: '订单删除失败' } });
    }
  });

  // ---------------------------------------------------------------------------
  // Status Transition (with audit trail)
  // ---------------------------------------------------------------------------
  // NOTE: Below routes use multi-segment paths (e.g. /:id/status-transition,
  // /kanban/summary) or different HTTP methods (PATCH /batch-status), so they
  // do NOT collide with the parameterized GET/:id, PUT/:id, DELETE/:id above.
  // If any future route uses a single-segment path like /summary, MOVE it
  // ABOVE the /:id handlers to avoid being captured.

  // ---------------------------------------------------------------------------
  // B1 直接取消订单（仅 Pending；设计真源 订单变更规则.md §2A.1「业务员可直接取消」）
  // ---------------------------------------------------------------------------
  // 与 DELETE /:id（归档，高危角色门）不同：直接取消是业务员日常动作，
  // 用 orders:write 权限门 + 服务层 fail-closed 状态/依赖守卫 + 全量留痕。
  router.post('/:id/cancel', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const id = req.params.id;
    const reason = String(req.body?.reason ?? '').trim();
    try {
      const result = await directCancelPendingOrder(
        opts.prisma, id, reason,
        (req as any).actor?.userId || (req as any).actor?.id || 'api',
      );
      if (!result.ok) {
        const status = DIRECT_CANCEL_ERROR_HTTP_STATUS[result.error!.code] ?? 500;
        return res.status(status).json({ ok: false, error: { code: result.error!.code, message: result.error!.message } });
      }
      opts.onDataChange?.({ entity: 'orders', action: 'direct-cancel', ids: [id] });
      return res.json({ ok: true, order: serializeOrder(result.data!.order), transitionId: result.data!.transitionId });
    } catch (e: any) {
      logger.error('[orders/direct-cancel] failed', { error: e?.message || String(e) });
      return res.status(500).json({ ok: false, error: { code: 'CANCEL_FAILED', message: '订单取消失败' } });
    }
  });

  /** Validate and record a status transition, then update the order. */
  // task ERP-P1: 调 lifecycleService（事务+OrderStatusTransition+sync+audit）
  router.post('/:id/status-transition', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const id = req.params.id;
    const body = (req.body || {}) as { toStatus?: string; note?: string; operator?: string; lineId?: string };
    const toStatus = String(body.toStatus || '').trim();
    try {
      const result = await transitionOrderStatus({
        prisma: opts.prisma, orderId: id, toStatus,
        note: body.note, operator: body.operator, lineId: body.lineId,
        actorId: (req as any).actor?.userId || (req as any).actor?.id || 'api',
      });
      if (!result.ok) {
        // 映射真源 = orderLifecycleService.ORDER_LIFECYCLE_ERROR_HTTP_STATUS（编译期强制完整）。
        // 此处曾漏掉 DR-010 守卫码 ORDER_LIFECYCLE_GUARDED / ORDER_ALREADY_CLOSED →
        // `|| 500` 兜成「服务器错误」（2026-09-17 真库演练 S11 实测，见该常量注释）。
        const status = ORDER_LIFECYCLE_ERROR_HTTP_STATUS[result.error!.code as keyof typeof ORDER_LIFECYCLE_ERROR_HTTP_STATUS];
        return res.status(status || 500).json({ ok: false, error: result.error });
      }
      opts.onDataChange?.({ entity: 'orders', action: 'status-transition', ids: [id] });
      const d = result.data!;
      return res.json({
        ok: true,
        transition: {
          id: d.transitionId,
          fromStatus: d.fromStatus,
          toStatus: d.toStatus,
          note: d.note,
          operator: d.operator,
          lineId: d.lineId,
          createdAt: d.createdAt,
        },
        order: serializeOrder(d.order),
      });
    } catch (e: any) {
      logger.error('[orders/status-transition] failed', { error: e?.message || String(e) });
      return res.status(500).json({ ok: false, error: { code: 'TRANSITION_FAILED', message: '订单状态流转失败' } });
    }
  });

  /** Get the status transition timeline for an order. */
  router.get('/:id/timeline', requirePermission('orders:read'), async (req: Request, res: Response) => {
    const id = req.params.id;
    try {
      const transitions = await opts.prisma.orderStatusTransition.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
      });
      const serialized = transitions.map((t: any) => {
        const out: any = { ...t };
        for (const k of Object.keys(out)) {
          if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
        }
        return out;
      });
      return res.json({ ok: true, timeline: serialized });
    } catch (e: any) {
      logger.error('[orders/timeline] failed', { error: e?.message || String(e) });
      return res.status(500).json({ ok: false, error: { code: 'TIMELINE_FAILED', message: '订单时间线查询失败' } });
    }
  });

  /** Batch status update for multiple orders. */
  router.patch('/batch-status', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const body = (req.body || {}) as { ids?: string[]; toStatus?: string; note?: string; operator?: string };
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const toStatus = String(body.toStatus || '').trim();

    if (ids.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'NO_IDS', message: 'ids array is required' } });
    }
    if (!toStatus || !LIFECYCLE_VALID_STATUSES.includes(toStatus as any)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_STATUS', message: `toStatus must be one of: ${LIFECYCLE_VALID_STATUSES.join(', ')}` } });
    }

    try {
      const results: Array<{ id: string; fromStatus: string; toStatus: string; skipped?: string; approvalRequestId?: string }> = [];

      for (const id of ids) {
        // 走 transitionOrderStatus service，确保状态机校验 + 审计日志 + 事务完整性
        const result = await transitionOrderStatus({
          prisma: opts.prisma,
          orderId: id,
          toStatus: toStatus as any,
          note: body.note || undefined,
          operator: body.operator || 'batch-api',
          // ★ 原写法 `(req as any).user?.id || 'batch-api'` 有两重问题：
          //   ① `req.user` 在本仓从未赋值（真源 `req.actor`）⇒ 恒走兜底；
          //   ② 兜底哨兵 `'batch-api'` **在 UserAccount 里不存在**，而 AuditLog.actorId
          //      有外键 → 写入即违约（与已收敛的旧哨兵 `'api'` 同一类，这处漏了）。
          actorId: actorIdFromRequest(req),
        });
        if (result.ok && result.data) {
          results.push({ id, fromStatus: result.data.fromStatus, toStatus: result.data.toStatus });
        } else if (result.error) {
          // 跳过失败项（已删除/无转换/非法转换），记录原因；
          // DE-6 统一透传：门禁已自动发起审批单时回传 id（MOQ 豁免/信用例外），供前端提示
          results.push({
            id, fromStatus: '', toStatus, skipped: result.error.code || 'FAILED',
            ...(result.error.approvalRequestId ? { approvalRequestId: result.error.approvalRequestId } : {}),
          });
        }
      }

      opts.onDataChange?.({ entity: 'orders', action: 'batch-status', ids });
      return res.json({ ok: true, updated: results });
    } catch (e: any) {
      logger.error('[orders/batch-status] failed', { error: e?.message || String(e) });
      return res.status(500).json({ ok: false, error: { code: 'BATCH_FAILED', message: '订单批量状态更新失败' } });
    }
  });

  /** Kanban aggregation: count orders per status. */
  router.get('/kanban/summary', requirePermission('orders:read'), async (_req: Request, res: Response) => {
    try {
      const groups = await opts.prisma.order.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { id: true },
        _sum: { quoteAmount: true },
      });
      const kanban = groups.map((g: any) => ({
        status: g.status,
        count: g._count?.id ?? 0,
        totalAmount: Number(g._sum?.quoteAmount ?? 0),
      }));
      return res.json({ ok: true, kanban });
    } catch (e: any) {
      logger.error('[orders/kanban] failed', { error: e?.message || String(e) });
      return res.status(500).json({ ok: false, error: { code: 'KANBAN_FAILED', message: '订单看板查询失败' } });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * 从 PUT patch 里识别「用户**真的**改了什么」——只有与 DB 现值不同的字段才算改动。
 *
 * ## 为什么必须比对现值（不能只看「patch 里有没有这个键」）
 * 前端 `OrderManager.tsx:1165` 的 patch 是
 *   `const { id, lines: _ignoreLines, fieldSources: _ignoreSources, ...patch } = updatedOrder`
 * 而 `updatedOrder = { ...editForm }`（:1091）⇒ **整对象回传**：未改动的字段
 * （含**旧的** `quantity` / `totalNet`）也会出现在 patch 里。
 * 若只看键是否存在，「只改合同额」会被回传的旧 `quantity` 误判成「改数量」。
 *
 * ## 优先级：quantity > contractAmount > quoteAmount > totalNet
 *   · `quantity` 最根本 —— 金额由「数量 × 单价」派生，数量变了金额必须跟着重算；
 *   · `totalNet` 排最后 —— 它是**派生列**（成交净额），本就应由明细行派生，极少被直接改。
 *
 * ## ★ 同改「数量 + 单价」：两个都要，**不许二选一**（第 2 批 B，2026-09-26）
 *
 * 优先级只能定「**按哪个数去重算**」，不能用来**丢信息**：
 * 前端一次保存只发一个 PUT，用户「数量 1800→1500 且单价 13.85→20」时 patch 里
 * **两样都在**（真浏览器捕获的 payload：`.workbuddy-ai/audit/复现脚本-2026-09-26/captured-put-b.json`）。
 * 旧实现命中 `quantity` 就返回、按**原单价**重算 ⇒ 单价被静默丢弃，
 * 而收口段的剔除清单里没有 `salesPrice` ⇒ 用户输入的单价照样落库
 * ⇒ **主档单价 ↔ 明细行单价永久分叉**。
 * ⇒ 现在同改时把 `unitPrice` 一并带回（`{ mode:'quantity', value, unitPrice }`），
 *   由真源重算 `netValue = quantity × unitPrice` 并回写主档 `salesPrice`。
 * ★ 口径依据：设计文档写明 `contractAmount = salesPrice × quantity`
 *   ⇒ 两者同给时，`contractAmount` 是**派生回显**（前端 `applyAmountLinkage:900`
 *   正是 `round2(price × qty)`），由真源重新派生，不另采信客户端那个数。
 *
 * @returns null = patch 未**真正**触及金额/数量 ⇒ 不触发重算（保持既有行为，最小改动面）
 */
/** Source tags record actual persisted edits, never merely keys in a full
 * editor payload. Decimal formatting changes and unchanged null stay factual. */
function detectAmountIntent(
  patch: Record<string, unknown>,
  existing: { quantity: unknown; quoteAmount: unknown; totalNet: unknown; contractAmount: unknown; salesPrice: unknown },
): { mode: RecalcMode; value: number; unitPrice?: number } | null {
  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const d = v as { toNumber?: () => number };
    const n = typeof v === 'number' ? v : typeof d?.toNumber === 'function' ? d.toNumber() : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  /** 返回「新值」当且仅当 patch 里有该键、且与现值不同（容差 0.005，对齐真源 findOrderAmountConflict） */
  const changed = (key: string, current: unknown): number | null => {
    if (!(key in patch)) return null;
    const next = toNum(patch[key]);
    if (next == null) return null;
    const cur = toNum(current);
    if (cur != null && Math.abs(next - cur) <= 0.005) return null; // 未改动（整对象回传）
    return next;
  };

  const q = changed('quantity', existing.quantity);
  if (q != null && q > 0) {
    // ★ 同改单价：把单价一并带回（不丢）；只改数量时 sp=null ⇒ 沿用各行原单价
    const sp = changed('salesPrice', existing.salesPrice);
    return sp != null && sp >= 0
      ? { mode: 'quantity', value: q, unitPrice: sp }
      : { mode: 'quantity', value: q };
  }

  const ca = changed('contractAmount', existing.contractAmount);
  if (ca != null && ca >= 0) return { mode: 'price', value: ca };

  const qa = changed('quoteAmount', existing.quoteAmount);
  if (qa != null && qa >= 0) return { mode: 'price', value: qa };

  const tn = changed('totalNet', existing.totalNet);
  if (tn != null && tn >= 0) return { mode: 'price', value: tn };

  return null;
}

/**
 * Strip fields the client should never set directly. We block server-managed
 * audit columns plus the immutable id (only used on create).
 */
function stripReadonly(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const dbKey = ORDER_WRITE_ALIASES[k] ?? k;
    if (!ORDER_WRITABLE_FIELDS.has(dbKey)) continue;
    if (v === undefined) continue;
    out[dbKey] = v;
  }
  return out;
}

/** Omission preserves an unknown draft; an explicit domain must be canonical. */
function isInvalidOrderBusinessLine(input: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(input, 'businessLine')
    && input.businessLine !== 'fabric' && input.businessLine !== 'garment';
}

const ORDER_WRITE_ALIASES: Record<string, string> = {
  contactTelephone: 'contactPhone',
  shippingDate: 'shipmentDate',
};

const ORDER_WRITABLE_FIELDS = new Set([
  'orderPurpose', 'internalPurpose', 'internalDemandTeamId', 'internalReceiverId',
  'customer',
  'product',
  'type',
  'businessLine',
  'quantity',
  'unit',
  'status',
  'dueDate',
  'quoteAmount',
  'poNumber',
  'customerCode',
  'season',
  'poDate',
  'contactPerson',
  'contactPhone',
  'currency',
  'deliveryTerms',
  'deliveryPlace',
  'contractDeliveryDate',
  'expectedArrivalDate',
  'agreedArrivalDate',
  'paymentTerms',
  'shipToName',
  'shipToAddress1',
  'shipToAddress2',
  'shipToCountry',
  'shipToPhone',
  'deliverTo',
  'totalNet',
  'totalActual',
  'source',
  'fieldSources',
  'purchaseCurrency',
  'salesCurrency',
  'customerAddress',
  'customerRelationId',
  'millName',
  'millAddress',
  'millContact',
  'millPhone',
  'millRelationId',
  'consigneeName',
  'consigneeAddress',
  'consigneeContact',
  'consigneeRelationId',
  'billToName',
  'billToAddress',
  'billToContact',
  'billToIsAgent',
  'billToRelationId',
  'salesPerson',
  'salesPersonRelationId',
  'merchandiser',
  'merchandiserRelationId',
  'supervisor',
  'supervisorRelationId',
  'salesContractNumber',
  'finalContractNumber',
  'productionBatch',
  'productColorCode',
  'clientCode',
  'referenceBatch',
  'productionDate',
  'clientDate',
  'fabricCode',
  'fabricContent',
  'width',
  'gsm',
  'asPerson',
  'salesPrice',
  'contractAmount',
  'paymentInstrument',
  // ★ D3 定金（2026-09-30）：同上 —— 白名单外会被静默丢弃 ⇒ 定金门禁形同虚设。
  'depositRatio', 'depositCurrency',
  'expectedPaymentDate',
  'actualPaymentDate',
  'actualPaymentAmount',
  'invoiceNumber',
  'invoiceDate',
  'shipmentDate',
  'shipmentMethod',
  'shipmentQuantity',
  'shipmentAmount',
  'sampleSentDate',
  'sampleConfirmedDate',
  'sampleTrackingNumber',
  'shipmentSampleComments',
  'fabricSampleSentDate',
  'fabricSampleConfirmedDate',
  'fabricSampleTrackingNumber',
  'paidSampleQuantity',
  'factoryVisitDate',
  'purchasePrice',
  'purchasePaymentDate',
  'supplierInvoiceNumber',
  'supplierInvoiceDate',
  'supplierInvoiceAmount',
  'specialInstructions',
  'ocDays',
]);

function sanitizeId(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
}

function parsePrevSources(raw: unknown): Record<string, 'pdf' | 'manual' | 'imported-then-edited'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, 'pdf' | 'manual' | 'imported-then-edited'> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === 'pdf' || v === 'manual' || v === 'imported-then-edited') out[k] = v;
  }
  return out;
}

function serializeOrder(o: any) {
  const out: any = orderQuantityDto(o);
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
  }
  if (Array.isArray(out.lines)) {
    out.lines = out.lines.map((l: any) => {
      const ll: any = { ...l };
      for (const k of Object.keys(ll)) {
        if (typeof ll[k] === 'bigint') ll[k] = Number(ll[k]);
      }
      return ll;
    });
  }
  return out;
}
