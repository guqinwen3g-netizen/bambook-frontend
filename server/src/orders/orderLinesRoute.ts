import { Router, Request, Response, NextFunction } from 'express';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { createCurrentWriteActor } from '../auth/currentWriteActor';
import { requirePermission } from '../auth/permissionGuard';
import type { TokenPayload } from '../auth/service';
import { authorizeOrderLineWrite, freshOrderLineScope, lockedOrderLine } from './orderLineWriteAccess';
import { createOrderLine, updateOrderLine, deleteOrderLine } from './orderLineMutationService';
import { ORDER_LIFECYCLE_ERROR_HTTP_STATUS } from './orderLifecycleService';
import { actorIdFromRequest } from '../audit/routeAudit';
import { stripLineWritable } from './orderLineWritable';
import { Prisma, PrismaClient } from '@prisma/client';
import { nextItemNo } from './orderLineItems';
import { parseFieldSources, FieldSourceTag } from '../import/persistOrders';
import { syncOrderLineEntityReferences } from '../entities/sync';
import { orderConfirmedSourceBinding } from './orderConfirmedSourceBinding';
import { lockConfirmedFabricSources } from '../development/fabricAssetEligibility';
import { writeRouteAuditLog } from '../audit/routeAudit';
// 未预期存储错误保持通用响应；本路由产生的业务拒绝携带 code+statusCode。
import { safeRouteError } from '../shared/routeError';
import { businessError, httpStatusOfCode, lookupErrorCode } from '../shared/errorCodes';
import { createCurrentOrderLineReadAccess } from './orderLineReadAccess';
import { resolveOrderId } from './orderIdentity';

export interface OrderLinesRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createOrderLinesRouter(opts: OrderLinesRouterOptions): Router {
  const router = Router();
  const { requireAuth, apiKeys } = opts;

  // Shared auth guard: JWT cookie/Bearer OR API-key header.
  // Replaces inline api-key-only guard — write ops require current identity below.
  const guard = createModuleAuthGuard({ requireAuth, apiKeys });
  router.use(guard);

  // Identity/grants must come from the active DB account on every write.
  // Orders action scopes authorize business staff within their current Order
  // range. A signed read-only ceiling cannot be widened by owner privilege.
  const writeActor = [createCurrentWriteActor(opts.prisma)];
  const currentOrderScope = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = await freshOrderLineScope(opts.prisma, (req as Request & { actor: TokenPayload }).actor);
      res.locals.orderWriteScope = scope;
      return next();
    } catch (error) {
      const r = safeRouteError(error, { fallbackCode: 'AUTHORIZATION_UNAVAILABLE', fallbackMessage: '暂时无法核验订单可操作范围，请稍后重试。' });
      return res.status(r.status).json({ ok: false, error: { code: r.code, message: r.message } });
    }
  };

  /**
   * GET / — 订单行列表。
   *
   * orderId is an additional filter over the current actor's parent-Order L2
   * scope. Listing all visible orders and listing one order use the same scope.
   * The JWT or employee-bound key read channel survives development config;
   * anonymous/unbound-key development fallback cannot expose business rows.
   */
  router.get('/', createModuleAuthGuard({ requireAuth: true, apiKeys }), createCurrentOrderLineReadAccess(opts.prisma), async (req, res) => {
    try {
      const orderId = typeof req.query?.orderId === 'string' ? req.query.orderId.trim() : '';
      const scope = res.locals.orderLineReadScope as Record<string, unknown>;
      const where: any = { order: { deletedAt: null, ...(Object.keys(scope).length ? { AND: [scope] } : {}) } };
      if (orderId) where.orderId = orderId;
      const rows = await opts.prisma.orderLine.findMany({
        where,
        include: { order: true },
        orderBy: [{ order: { importedAt: 'desc' } }, { lineNumber: 'asc' }],
      });
      return res.json({ ok: true, lines: rows.map(serializeOrderLine) });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: { code: 'LIST_LINES_FAILED', message: '订单行查询失败' } });
    }
  });

  // task ERP-P1: POST / 调 orderLineMutationService（事务+sync+audit fail closed）
  router.post('/', ...writeActor, requirePermission('orders:write'), currentOrderScope, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown> & { orderId?: string; orderCode?: string; poNumber?: string; businessLine?: string; customerRelationId?: string };
    if (![body.orderId, body.orderCode, body.poNumber].some(value => typeof value === 'string' && value.trim())) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: '请选择准确的内部订单。' } });
    }
    try {
      // 查找 parent order（显式校验，不自动 upsert）
      const orderId = await resolveOrderId(opts.prisma, body, res.locals.orderWriteScope);
      const order = orderId ? await opts.prisma.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [res.locals.orderWriteScope] } }) : null;
      if (!order || order.deletedAt) {
        return res.status(404).json({ ok: false, error: { code: 'ORDER_NOT_FOUND', message: '订单不存在或不在当前可操作范围。' } });
      }
      const writable = stripLineWritable(body);
      const lineSources: Record<string, FieldSourceTag> = {};
      for (const k of Object.keys(writable)) {
        if (k === 'status') continue;
        lineSources[k] = 'manual';
      }
      const { itemNo: _ignoredItemNo, lineNumber: _ignoredLineNumber, quantity, unit, unitPrice, materialCode, description, ...extra } = writable;
      const result = await createOrderLine({
        prisma: opts.prisma,
        orderId: order.id,
        itemNo: writable.itemNo ? String(writable.itemNo) : undefined, // 不传则 service 事务内自动算
        materialCode: materialCode ? String(materialCode) : undefined,
        description: description ? String(description) : undefined,
        quantity: (quantity ?? 0) as number | string,
        unit: unit ? String(unit) : undefined,
        unitPrice: unitPrice === undefined ? undefined : unitPrice as number | string,
        type: order.type,
        fieldSources: lineSources as any,
        actorId: actorIdFromRequest(req),
        trustedActor: (req as Request & { actor: TokenPayload }).actor,
        extra: extra as any,
      });
      if (!result.ok) {
        const statusCodeMap: Record<string, number> = { INVALID_INPUT: 400, ORDER_NOT_FOUND: 404, ORDER_LINE_NOT_FOUND: 404, DUPLICATE_ITEM_NO: 409, CREATE_LINE_FAILED: 500, UPDATE_LINE_FAILED: 500 };
        return res.status(statusCodeMap[result.error!.code] || (lookupErrorCode(result.error!.code) ? httpStatusOfCode(result.error!.code) : 500)).json({ ok: false, error: result.error });
      }
      opts.onDataChange?.({ entity: 'order-lines', action: 'create', ids: [result.data!.line.id] });
      return res.json({ ok: true, line: serializeOrderLine(result.data!.line) });
    } catch (e: any) {
      const code = (e?.code as string | undefined) ?? '';
      if (code === 'AMBIGUOUS_ORDER_REFERENCE') return res.status(409).json({ ok: false, error: { code, message: e.message } });
      if (code === 'P2002') {
        return res.status(409).json({ ok: false, error: { code: 'DUPLICATE_ITEM_NO', message: 'This PO item number already exists.' } });
      }
      return res.status(500).json({ ok: false, error: { code: 'CREATE_LINE_FAILED', message: '订单行创建失败' } });
    }
  });

  router.put('/:id', ...writeActor, requirePermission('orders:write'), currentOrderScope, async (req, res) => {
    const id = req.params.id;
    const writable = stripLineWritable(req.body || {});
    if (Object.keys(writable).length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'EMPTY_PATCH', message: 'patch body has no editable fields' } });
    }

    try {
      // Read current fieldSources so we can tag manually-edited fields.
      const current = await opts.prisma.orderLine.findFirst({ where: { id, order: { deletedAt: null, AND: [res.locals.orderWriteScope] } }, select: { id: true, orderId: true, fieldSources: true } });
      if (!current) {
        return res.status(404).json({ ok: false, error: { code: 'ORDER_LINE_NOT_FOUND', message: `order line ${id} not found` } });
      }
      const prevSources = parseFieldSources(current?.fieldSources);
      const nextSources = { ...prevSources };
      for (const k of Object.keys(writable)) {
        const prev = prevSources[k];
        if (prev === 'manual' || prev === 'imported-then-edited') {
          nextSources[k] = 'imported-then-edited';
        } else {
          nextSources[k] = 'manual';
        }
      }

      // task ERP-P1: 调 updateOrderLine service（事务+sync+audit fail closed）
      const result = await updateOrderLine({
        prisma: opts.prisma, lineId: id,
        patch: { ...(writable as any), fieldSources: nextSources },
        actorId: actorIdFromRequest(req),
        trustedActor: (req as Request & { actor: TokenPayload }).actor,
      });
      if (!result.ok) {
        const statusCodeMap: Record<string, number> = { INVALID_INPUT: 400, ORDER_NOT_FOUND: 404, ORDER_LINE_NOT_FOUND: 404, DUPLICATE_ITEM_NO: 409, CREATE_LINE_FAILED: 500, UPDATE_LINE_FAILED: 500 };
        return res.status(statusCodeMap[result.error!.code] || (lookupErrorCode(result.error!.code) ? httpStatusOfCode(result.error!.code) : 500)).json({ ok: false, error: result.error });
      }
      opts.onDataChange?.({ entity: 'order-lines', action: 'update', ids: [id] });
      return res.json({ ok: true, line: serializeOrderLine(result.data!.line) });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: { code: 'UPDATE_LINE_FAILED', message: '订单行更新失败' } });
    }
  });

  // ─── PATCH /:id/version — DR-053 阶段 1：历史订单行补录版本引用（不伪造版本） ───
  // 输入：confirmedSourceType + confirmedSourceId（可选 millRelationId）；补 confirmed*+specSnapshot，留审计。
  router.patch('/:id/version', ...writeActor, requirePermission('orders:write'), currentOrderScope, async (req, res) => {
    const id = req.params.id;
    const body = (req.body || {}) as Record<string, any>;
    const { confirmedSourceType, confirmedSourceId, millRelationId } = body;
    if (!confirmedSourceType || !confirmedSourceId) {
      return res.status(400).json({ ok: false, error: { code: 'CONFIRMED_SOURCE_REQUIRED', message: '补录必须指定 confirmedSourceType/confirmedSourceId' } });
    }
    try {
      const existing = await opts.prisma.orderLine.findFirst({ where: { id, order: { deletedAt: null, AND: [res.locals.orderWriteScope] } }, select: { id: true, orderId: true, confirmedSourceType: true, confirmedSourceId: true, confirmedAt: true, confirmedBy: true } });
      if (!existing) {
        return res.status(404).json({ ok: false, error: { code: 'ORDER_LINE_NOT_FOUND', message: '订单行不存在或不在当前可见范围' } });
      }
      const prior = (req as Request & { actor: TokenPayload }).actor;
      const updated = await opts.prisma.$transaction(async (tx) => {
        await lockConfirmedFabricSources(tx, [{ type: String(confirmedSourceType), id: String(confirmedSourceId) }], { orderIds: [existing.orderId] });
        // A version selection is one fact: current authorization, real source,
        // compare-and-set and mandatory audit must commit together. There is no
        // fallback to the earlier JWT/grant snapshot if this reload fails.
        const { actor, order, scope } = await authorizeOrderLineWrite(tx, existing.orderId, prior, 'version');
        const line = await lockedOrderLine(tx, id, order.id);
        if (!line.confirmedSourceType && !line.confirmedSourceId
          && (line.specSnapshot != null || line.confirmedAt != null || line.confirmedBy != null)) {
          throw businessError('CONFLICT', '订单行已有规格或确认历史，但来源引用缺失；请核对原依据，不能通过补录覆盖。');
        }
        // A prior complete reference is a readback, not permission to overwrite
        // its specification/time/audit. Stale blank preflight commands still
        // reach the original CAS so two racing commands cannot both succeed.
        const samePrior = ['confirmedSourceType', 'confirmedSourceId', 'confirmedAt', 'confirmedBy']
          .every(key => (line[key] ?? null) === (existing[key as keyof typeof existing] ?? null));
        if (samePrior && (line.confirmedSourceType || line.confirmedSourceId)) {
          if (!line.confirmedSourceType || !line.confirmedSourceId || line.confirmedSourceType !== String(confirmedSourceType) || line.confirmedSourceId !== String(confirmedSourceId))
            throw businessError('CONFLICT', '订单行已有确认来源或引用不完整，请核对原记录；历史补录不能覆盖已有来源。');
          // Replaying the same historical selection still requires a usable
          // current source. Keep the original version/time/audit unchanged.
          await orderConfirmedSourceBinding(tx, order, line,
            { confirmedSourceType: String(confirmedSourceType), confirmedSourceId: String(confirmedSourceId), millRelationId }, actor);
          return { line, changed: false };
        }
        const selectionOnly = order.status !== 'Pending';
        if (selectionOnly && !line.confirmedSourceType && !line.confirmedSourceId) {
          await assertUnusedHistoricalOrderLine(tx, order.id, line);
        }
        const parentScope = { deletedAt: null, AND: [scope] };
        const { sourceCode, specSnapshot } = await orderConfirmedSourceBinding(tx, order, line,
          { confirmedSourceType: String(confirmedSourceType), confirmedSourceId: String(confirmedSourceId), millRelationId }, actor);
        const selectedAt = BigInt(Date.now());
        const changed = await tx.orderLine.updateMany({
          where: { id, orderId: existing.orderId, order: parentScope,
            confirmedSourceType: existing.confirmedSourceType ?? null,
            confirmedSourceId: existing.confirmedSourceId ?? null,
            confirmedAt: existing.confirmedAt ?? null, confirmedBy: existing.confirmedBy ?? null },
          data: { confirmedSourceType: String(confirmedSourceType), confirmedSourceId: String(confirmedSourceId),
            ...(!selectionOnly ? { confirmedAt: selectedAt, confirmedBy: actor.userId } : {}),
            specSnapshot: specSnapshot as Prisma.InputJsonValue },
        });
        if (changed.count !== 1) throw businessError('CONFLICT', '订单行版本已变化，请刷新后重新选择。');
        await writeRouteAuditLog({
          prisma: tx, actorId: actor.userId, source: 'route:order-lines:backfill-version', operation: 'backfill_order_line_version',
          targetType: 'OrderLine', targetId: id,
          before: { orderId: existing.orderId, confirmedSourceType: existing.confirmedSourceType ?? null, confirmedSourceId: existing.confirmedSourceId ?? null },
          after: { orderId: existing.orderId, confirmedSourceType, confirmedSourceId, sourceCode,
            selectedAt: selectedAt.toString(), selectedBy: actor.userId, selectionOnly }, ip: req.ip ?? null,
        });
        return { line: await tx.orderLine.findUniqueOrThrow({ where: { id } }), changed: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (updated.changed) opts.onDataChange?.({ entity: 'order-lines', action: 'backfill-version', ids: [id] });
      return res.json({ ok: true, line: serializeOrderLine(updated.line) });
    } catch (e: any) {
      if (e?.code === 'P2034') e = businessError('CONFLICT', '订单行或确认来源正在变化，请刷新后重新选择。');
      const r = safeRouteError(e, { fallbackCode: 'BACKFILL_VERSION_FAILED', fallbackMessage: '版本补录失败' });
      return res.status(r.status).json({ ok: false, error: { code: r.code, message: r.message } });
    }
  });

  // DELETE /api/v1/order-lines/:id — delete order line
  router.delete('/:id', ...writeActor, requirePermission('orders:delete'), currentOrderScope, async (req, res) => {
    const id = req.params.id;
    try {
      const visible = await opts.prisma.orderLine.findFirst({ where: { id, order: { deletedAt: null, AND: [res.locals.orderWriteScope] } }, select: { id: true } });
      if (!visible) return res.status(404).json({ ok: false, error: { code: 'ORDER_LINE_NOT_FOUND', message: '订单行不存在或不在当前可见范围' } });
      const result = await deleteOrderLine({
        prisma: opts.prisma,
        lineId: id,
        actorId: actorIdFromRequest(req),
        trustedActor: (req as Request & { actor: TokenPayload }).actor,
      });
      if (!result.ok) {
        // 状态真源 = ORDER_LIFECYCLE_ERROR_HTTP_STATUS（B14 的 DEPENDENCY_CHECK_FAILED 由
        // orderLifecycleService.dependencyCheckFailedError() 产出，这里读同一张表 ⇒ 抛出方与
        // 应答方不会各自抄一份数字再漂移）。本域自己的两个码在下面补齐。
        const statusCodeMap: Record<string, number> = {
          ...ORDER_LIFECYCLE_ERROR_HTTP_STATUS,
          ORDER_LINE_NOT_FOUND: 404,
          DELETE_LINE_FAILED: 500,
        };
        const error = result.error;
        return res.status(statusCodeMap[error.code] || (lookupErrorCode(error.code) ? httpStatusOfCode(error.code) : 500)).json({ ok: false, error });
      }
      opts.onDataChange?.({ entity: 'order-lines', action: 'delete', ids: [id] });
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: { code: 'DELETE_LINE_FAILED', message: '订单行删除失败' } });
    }
  });

  return router;
}

/** Formal historical backfill may identify a truly unused row, but must never
 * rewrite the basis of production, sample, QC, shipment or financial facts.
 * Reads run under the caller's serializable transaction and Order/Line locks;
 * an unavailable delegate is a failed verification, never an empty history. */
async function assertUnusedHistoricalOrderLine(tx: Prisma.TransactionClient, orderId: string, line: Record<string, unknown>) {
  const scalarFacts = ['productionBatch', 'shippingDate', 'shippingMethod', 'invoiceNumber', 'invoiceDate',
    'shipmentQuantity', 'shipmentAmount', 'actualPaymentDate', 'actualPaymentAmount'];
  const hasJsonFact = (value: unknown) => value != null && (Array.isArray(value)
    ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : value !== '');
  if ((line.status != null && line.status !== 'Pending')
    || scalarFacts.some(field => line[field] != null && line[field] !== '')
    || hasJsonFact(line.productionSteps) || hasJsonFact(line.garmentSampleStages)) {
    throw businessError('CONFLICT', '历史订单行已有履约事实，不能通过来源补录更换业务依据。');
  }
  const orderLineId = String(line.id);
  const facts = await Promise.all([
    tx.productionBatch.findFirst({ where: { orderId, orderLineId }, select: { id: true } }),
    tx.releaseScope.findFirst({ where: { orderId, orderLineId }, select: { id: true } }),
    tx.orderSampleCoverage.findFirst({ where: { orderLineId }, select: { id: true } }),
    tx.shipmentLine.findFirst({ where: { orderLineId }, select: { id: true } }),
    tx.shipmentOrderAllocation.findFirst({ where: { orderId, OR: [{ orderLineId }, { orderLineId: null }] }, select: { id: true } }),
    tx.invoiceOrderAllocation.findFirst({ where: { orderId }, select: { id: true } }),
    tx.purchaseLine.findFirst({ where: { orderLineId }, select: { id: true } }),
    tx.procurementDemand.findFirst({ where: { orderId, OR: [{ orderLineId }, { orderLineId: null }] }, select: { id: true } }),
    // Legacy whole-order reports do not identify an accurate line. Such history
    // remains evidence to reconcile rather than permission to invent a basis.
    tx.inspectionReport.findFirst({ where: { orderId }, select: { id: true } }),
  ]);
  if (facts.some(Boolean)) throw businessError('CONFLICT', '历史订单行已有样品、生产、质检、出运或财务依据，不能通过来源补录覆盖。');
}


function serializeOrderLine(line: any) {
  const out: any = { ...line };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
  }
  if (out.order) {
    out.poNumber = out.order.poNumber;
    out.customer = out.order.customer;
    for (const k of Object.keys(out.order)) {
      if (typeof out.order[k] === 'bigint') out.order[k] = Number(out.order[k]);
    }
  }
  return out;
}

function makeOrderId(poNumber: string): string {
  return `PO-${poNumber.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}
