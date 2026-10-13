
import { physicalShipmentJson } from './shipmentPhysicalCommand';
import { createBusinessCiRouter } from './businessCiRoute';
import { createShipmentHandoffActualRouter } from './shipmentHandoffActualRoute';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { physicalShipmentAllocationFingerprint } from './shipmentPhysicalConsumerService';
/**
 * 货运管理 API — /api/v1/shipping
 *
 * 契约钩子（来自 docs/MODULE_CONTRACT.md）：
 *   - L2.2 输入校验：字段白名单 + 必填校验
 *   - L3.1 EntityLink 同步：mutation 调用 syncShipmentReferences
 *   - L4 审批：高风险 mutation 默认走 manifest.safety.approval=always
 *
 * Decimal-first：金额字段用 Prisma Decimal @db.Decimal(18,4)，
 * route 层 JSON 序列化自动输出 string，前端按需 parse。
 */
import { Router, Request, Response, NextFunction } from 'express';
// ★ C2：运输方式标签收口到唯一真源（含 Pickup=客户自提 + 历史脏值归一）
import { shippingMethodLabel } from '../shared/shippingMethod';
import { requireRole, extractActorFromRequest } from '../auth/middleware';
import { listCiInvoiceSourcesForShipment } from '../customs/ciInvoiceSource';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import type { AgentRole } from '../agent/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { actorIdFromRequest } from '../audit/routeAudit';
import { safeRouteError } from '../shared/routeError';
import { createShipment, updateShipment, deleteShipment, hasMvpExcludedShipmentInsuranceFields, VALID_SHIPMENT_STATUSES } from './shipmentMutationService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createExceptionService } from '../exceptions/exceptionService';
import type { ExceptionChecker } from '../exceptions/exceptionGate';
import { assembleDocumentSetData, documentSetHttpErrorCode } from './documentSetService';
import { httpStatusOfCode } from '../shared/errorCodes';
// ⓘ short-shipment 的码**不在这里 import**：档位判定已改成"本地表查不到就问注册表"，
//   本文件不再需要知道具体是哪几枚码（那是 `shipping/shortShipmentGate.ts` 的事）。
import { readAuthorizedShipmentStats } from './shipmentStatsReadProjection';
// ★ C1：拼柜（一柜多票）聚合与柜内矛盾检测
import { getContainerConsolidation } from './containerConsolidationService';
// ★ D5：改期/物流变更历史（只读；写侧是字段级审计）
import { readAuthorizedShipmentScheduleHistory } from './shipmentScheduleHistoryRead';
import {
  listShipmentLines, listShipmentCartons,
  replaceShipmentLines, replaceShipmentCartons, pullLinesFromOrder,
} from './shipmentPackingService';
import { readShipmentPacking, saveShipmentPacking, packingCommandError } from './shipmentPackingCommand';
import { readShipmentCartonMetadata, saveShipmentCartonMetadata, shipmentCartonMetadataError } from './shipmentCartonMetadataCommand';
import { createAllocationService } from './allocationService';
import { allocationRequiresPhysicalContract, writePhysicalShipmentAllocation } from './shipmentPhysicalAllocationService';
import { businessError } from '../shared/errorCodes';
import { createBookingLeadTimeService } from './bookingLeadTimeService';
import { createNativeOrderShipmentBatchService } from './orderShipmentBatchNativeService';
import { createShipmentLandTransportService } from './shipmentLandTransportService';
import { serializeValue } from '../lib/serializeValue';
import { buildXlsx, xlsxDownloadHeaders, type XlsxSheet } from '../templates/xlsxExport';
import { logger } from '../lib/logger';

import { resolveVisibleOrderIds, buildShipmentVisibilityWhere, isShipmentVisible } from '../auth/orderVisibility';
import { normalizeExportDeclarationCompletedAt } from './shipmentExportDeclaration';
import { createShipmentHandoff, evaluateShipmentHandoffEligibility, listShipmentHandoffsPage, readShipmentHandoff,
  shipmentHandoffJson, transitionShipmentHandoff, confirmShipmentHandoffDeparture } from './shipmentHandoffService';
/**
 * ★ 2026-09-29：**标签表已抽到 shared**（`shared/shipmentDisplayLabels.ts`）——
 *   原表是本文件的 `const`（**未 export**）⇒ **前端够不到** ⇒ `DocumentCenter`
 *   的下拉项只能印枚举原值。抽出去之后两边共用一份，**不再各存一份**。
 *   ★ 本地保留同名常量名（`SHIPMENT_STATUS_LABEL`）以免动本文件内的既有引用。
 */
import {
  SHIPMENT_STATUS_LABEL,
  SHIPMENT_TYPE_LABEL,
} from '../shared/shipmentDisplayLabels';
import { todayLocalKey } from '../shared/localDate';


export interface ShippingRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
  /**
   * DR-013 例外查询器（出运放行门禁用）：
   *   - undefined（缺省）→ 构建真实例外链（生产路径）
   *   - 显式 null → fail-closed 无例外通道
   *   - 注入函数 → 测试可控（mock 例外查询）
   */
  exceptionChecker?: ExceptionChecker | null;
}

// ── 字段白名单 ──

type ShipmentCreateInput = {
  shipmentNumber: string;
  type: string;
  shippingMethod: string;
  loadType?: string | null;
  status?: string;
  bookingDate?: string;
  etd?: string;
  atd?: string;
  vesselOrFlight?: string;
  voyageNumber?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  containerNumber?: string;
  sealNumber?: string;
  trackingNumber?: string;
  carrierTrackingUrl?: string;
  totalPackages?: number;
  grossWeight?: number;
  netWeight?: number;
  volume?: number;
  freightAmount?: number;
  freightCurrency?: string;
  customsAmount?: number;
  customsCurrency?: string;
  otherCharges?: number;
  otherChargesCurrency?: string;
  orderId?: string;
  customerRelationId?: string;
  customerName?: string;
  carrierRelationId?: string;
  carrierName?: string;
  // DR-016 四方交易方（snapshot FK → Relation；schema Shipment 已有 6 列，报关/单证按此带出）
  // [B4 字段收敛 2026-09-15] 此前缺失 → 前端传入被白名单静默丢弃，现补入
  consigneeRelationId?: string;
  consigneeName?: string;
  docRecipientRelationId?: string;
  docRecipientName?: string;
  payerRelationId?: string;
  payerName?: string;
  // T6-a 订舱段（H12）
  bookingNo?: string;
  soNumber?: string;
  spaceConfirmedAt?: number | null;
  cutOffAt?: string;
  docCutOffAt?: string;
  billOfLadingNo?: string;
  masterBillNo?: string;
  houseBillNo?: string;
  hsCode?: string;
  customsBroker?: string;
  customsDeclarationNumber?: string;
  customsClearanceDate?: string;
  notes?: string;
  attachments?: any;
};

// R6：shippingMethod 入白名单（拍板：运输方式订舱前后均合理可改；shipmentNumber/type 为身份字段仍禁止
// PATCH，前端编辑态对应禁用/不下发，杜绝「可编辑但静默丢弃」）
const SHIPMENT_PATCH_FIELDS: (keyof ShipmentCreateInput)[] = [
  'status', 'shippingMethod', 'loadType', 'bookingDate', 'etd', 'atd',
  'vesselOrFlight', 'voyageNumber',
  'portOfLoading', 'portOfDischarge',
  'containerNumber', 'sealNumber', 'trackingNumber', 'carrierTrackingUrl', 'totalPackages',
  'grossWeight', 'netWeight', 'volume',
  'freightAmount', 'freightCurrency',
  'customsAmount', 'customsCurrency',
  'otherCharges', 'otherChargesCurrency',
  'orderId', 'customerRelationId', 'customerName',
  'carrierRelationId', 'carrierName',
  // DR-016 四方交易方（B4 字段收敛：补入白名单，杜绝"可编辑但静默丢弃"）
  'consigneeRelationId', 'consigneeName',
  'docRecipientRelationId', 'docRecipientName',
  'payerRelationId', 'payerName',
  'hsCode', 'customsBroker', 'customsDeclarationNumber', 'customsClearanceDate',
  // T6-a 订舱段（H12）
  'bookingNo', 'soNumber', 'spaceConfirmedAt', 'cutOffAt', 'docCutOffAt',
  'billOfLadingNo', 'masterBillNo', 'houseBillNo',
  'notes', 'attachments',
];

function pickFields<T extends Record<string, any>>(obj: T, keys: string[]): Partial<T> {
  const out: any = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export function createShippingRouter(options: ShippingRouterOptions): Router {
  const { prisma, onDataChange, requireAuth, apiKeys } = options;
  const router = Router();
  const allocationService = createAllocationService(prisma);
  const readAllocationScope = async (tx: any, req: Request): Promise<Record<string, unknown>> => {
    const prior = (req as any).actor;
    if (!prior?.userId) {
      if (!requireAuth && (req as any).authSource === 'dev') return {};
      throw businessError('UNAUTHORIZED', '请登录后查看出运分配。');
    }
    const user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    const actor = await buildLoadedAuthTokenPayload(tx, user);
    if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
    if (!hasScope({ ...actor, roles: [] }, 'orders:read') || !hasScope({ ...actor, roles: [] }, 'shipments:read'))
      throw businessError('FORBIDDEN', '当前账号没有订单和出运分配读取权限。');
    return freshOrderLineScope(tx, actor);
  };
  // Preserve exact decimal and concurrency timestamps; the generic legacy
  // serializer converts them to Number and is unsuitable for these commands.
  const allocationJson = physicalShipmentJson;

  // The modern contract preserves existing endpoint and immutable source facts.
  // Missing modern fields cannot silently fall through to the legacy SKU path.
  const physicalAllocationWrite = async (req: Request, allocationId?: string): Promise<{ status: number; body: any } | null> => {
    try {
      const body = req.body ?? {}, actor = (req as any).actor ?? null;
      const explicit = Object.prototype.hasOwnProperty.call(body, 'productionBatchAllocations') || Object.prototype.hasOwnProperty.call(body, 'requestKey');
      const physical = explicit || await allocationRequiresPhysicalContract({ prisma, shipmentId: req.params.id, allocationId, orderId: body.orderId, orderLineId: body.orderLineId, actor });
      if (!physical) return null;
      if (!Object.prototype.hasOwnProperty.call(body, 'requestKey')) throw businessError('CONFLICT', '本单已有真实生产批次，请核对原范围及分配请求，不能退回旧分配路径。');
      const result = await writePhysicalShipmentAllocation({ prisma, shipmentId: req.params.id, allocationId, actor, input: body, ip: req.ip || null });
      if (!result.ok) return { status: result.error.status, body: { error: result.error } };
      const allocation = result.data.allocation;
      if (!allocation.replayed) {
        try { onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] }); }
        catch (error) { logger.warn('[Shipping] 已提交批次分配的通知发送失败', { error }); }
      }
      return { status: allocationId || allocation.replayed ? 200 : 201, body: { ...allocationJson(allocation),
        acknowledgement: { schemaVersion: 1, allocationHash: qcReportSourceFingerprint({ ...allocation, replayed: false }) } } };
    } catch (error) {
      logger.error('[Shipping] 批次分配未确认', { error });
      const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' });
      return { status: safe.status, body: { error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } } };
    }
  };


  // DR-013 例外查询链（出运放行门禁消费真源，与 samples 域同一装配范式）：
  // hasActiveException 注入 mutationService，→Shipped 放行时不具备资格订单可经生效例外放行；
  // 测试可经 options.exceptionChecker 注入 mock（显式 null = fail-closed 无例外通道）
  const shipmentReleaseChecker: ExceptionChecker | null = options.exceptionChecker !== undefined
    ? options.exceptionChecker
    : (() => {
        const exceptionRoutingService = createApprovalRoutingService({ prisma });
        const exceptionService = createExceptionService({
          prisma,
          approvalCreateService: createApprovalCreateService({ prisma, routingService: exceptionRoutingService }),
        });
        return exceptionService.hasActiveException;
      })();

  // Shared auth guard: JWT or API-key (restored — was silently dropped by scaffold)
  const guard = createModuleAuthGuard({ requireAuth, apiKeys });
  router.use(guard);

  // REQ2-20：旺季舱位提醒（订舱提前期规则扫描）
  const bookingLeadTimeService = createBookingLeadTimeService(prisma);

  // P0-1：订单分批出运与尾款结算（财务侧批次主档）
  const nativeBatchService = createNativeOrderShipmentBatchService(prisma);

  // 业务通过 orders:write 发起/修订出运交接；后勤以 shipments:write
  // 接收、装箱及登记实际离港。部门业务属性约束角色动作上限，
  // 不因业务人员能发起交接就授予专业出运权限。
  // 删除仍保留高风险角色限制；状态放行、QC及数量门禁在事务内复核。
  const HIGH_RISK_ROLES: AgentRole[] = ['owner', 'admin', 'manager'];
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  router.use(createBusinessCiRouter(prisma, requireWrite));
  router.use(createShipmentHandoffActualRouter(prisma, requireWrite, onDataChange));

  // Business → logistics durable handoff. Its status is orthogonal to the
  // physical Shipment lifecycle; /complete only returns prepared material.
  const handoffError = (res: Response, error: unknown, fallbackMessage: string) => {
    const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage });
    res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message,
      ...(safe.details === undefined ? {} : { details: safe.details }) } });
  };
  router.post('/handoffs/eligibility', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    try {
      const data = await evaluateShipmentHandoffEligibility({ prisma, actor: (req as any).actor ?? null, input: req.body });
      res.json({ ok: true, data: shipmentHandoffJson(data) });
    } catch (error) { handoffError(res, error, '出运资格暂不可确认，请刷新来源并核对后重试。'); }
  });
  router.get('/handoffs', requirePermission('shipments:read'), requirePermission('orders:read'), async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const data = await listShipmentHandoffsPage({ prisma, actor: (req as any).actor ?? null, status, orderId, cursor,
        ...(limitRaw === undefined ? {} : { limit: limitRaw }) });
      res.json({ ok: true, data: shipmentHandoffJson(data) });
    } catch (error) { handoffError(res, error, '出运交接列表加载失败，请稍后重试。'); }
  });

  router.get('/handoffs/:handoffId', requirePermission('shipments:read'), requirePermission('orders:read'), async (req: Request, res: Response) => {
    try { res.json({ ok: true, data: shipmentHandoffJson(await readShipmentHandoff({ prisma, handoffId: req.params.handoffId, actor: (req as any).actor ?? null })) }); }
    catch (error) { handoffError(res, error, '出运交接详情加载失败，请刷新后重试。'); }
  });

  router.post('/handoffs', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    try {
      const data = await createShipmentHandoff({ prisma, actor: (req as any).actor ?? null, input: req.body, ip: req.ip || null });
      onDataChange?.({ entity: 'shipping', action: 'handoff_created', ids: [data.handoff.id, data.handoff.shipmentId] });
      res.status(201).json({ ok: true, data: shipmentHandoffJson(data) });
    } catch (error) { handoffError(res, error, '出运交接未能保存，请刷新来源并核对后重试。'); }
  });

  const handoffActionRoute = (path: string, action: 'start' | 'return-to-business' | 'return-to-logistics' | 'complete' | 'cancel', business = false) => {
    router.post(`/handoffs/:handoffId/${path}`, requireWrite,
      ...(business ? [requirePermission('orders:write')] : [requirePermission('shipments:write')]),
      async (req: Request, res: Response) => {
        try {
          const data = await transitionShipmentHandoff({ prisma, handoffId: req.params.handoffId, actor: (req as any).actor ?? null,
            action, input: req.body, ip: req.ip || null });
          onDataChange?.({ entity: 'shipping', action: `handoff_${action.replace(/-/g, '_')}`, ids: [data.handoff.id, data.handoff.shipmentId] });
          res.json({ ok: true, data: shipmentHandoffJson(data) });
        } catch (error) { handoffError(res, error, '出运交接处理结果暂不可确认，请刷新后核对。'); }
      });
  };
  handoffActionRoute('start', 'start');
  handoffActionRoute('return-to-business', 'return-to-business');
  handoffActionRoute('return-to-logistics', 'return-to-logistics', true);
  handoffActionRoute('complete', 'complete');
  handoffActionRoute('cancel', 'cancel', true);
  router.post('/handoffs/:handoffId/confirm-departure', requireWrite, requirePermission('shipments:write'), async (req: Request, res: Response) => {
    try {
      const data = await confirmShipmentHandoffDeparture({ prisma, handoffId: req.params.handoffId,
        actor: (req as any).actor ?? null, input: req.body, ip: req.ip || null });
      onDataChange?.({ entity: 'shipping', action: 'handoff_confirm_departure', ids: [data.handoff.id, data.handoff.shipmentId] });
      res.json({ ok: true, data: shipmentHandoffJson(data) });
    } catch (error) { handoffError(res, error, '实际出运确认未能完成，请刷新后核对当前单据和 ATD。'); }
  });


  // ═══ P0-1：订单出运批次（字面路由，须在参数路由 /:id 之前注册） ═══
  const batchRespond = (res: Response, result: any) => {
    if (!result.ok) {
      res.status(result.error.status).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, ...(result.data instanceof Array ? { batches: serializeValue(result.data) } : { ...serializeValue(result.data) }) });
  };

  // GET /order-batches?orderId=… — 订单批次全景（批次列表 + 计划/出运/结算汇总）
  router.get('/order-batches', async (req: Request, res: Response) => {
    try {
      const orderId = String(req.query.orderId || '');
      if (!orderId) {
        res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'orderId 必填' } });
        return;
      }
      batchRespond(res, await nativeBatchService.listByOrder(orderId, (req as any).actor ?? null));
    } catch (err: any) {
      logger.error('[ShippingRoute] list order batches failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '可合票批次列表加载失败，请稍后重试；持续失败请联系管理员核对运单与批次数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // GET /order-batches/overdue-final — 尾款到期未结清末批清单（watchdog/看板扫描源）
  router.get('/order-batches/overdue-final', async (req: Request, res: Response) => {
    try {
      const result = await nativeBatchService.listOverdueFinal(Number(req.query.limit) || 100, (req as any).actor ?? null);
      batchRespond(res, result);
    } catch (err: any) {
      logger.error('[ShippingRoute] overdue final batches failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '到期未出运批次加载失败，请稍后重试；持续失败请联系管理员核对批次与出运日期。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // POST /order-batches — 批次登记（计划期；batchNo 自动递增；单批自动末批）
  router.post('/order-batches', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    try {
      const { orderId, shipmentId, plannedRatio, plannedQty, unit, amount, currency, isFinalBatch, finalPaymentDueDays, notes } = req.body || {};
      if (!orderId) {
        res.status(400).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'orderId 必填' } });
        return;
      }
      const result = await nativeBatchService.createBatch({
        orderId, shipmentId, plannedRatio, plannedQty, unit, amount, currency, isFinalBatch, finalPaymentDueDays, notes,
      }, (req as any).actor ?? null);
      if (!result.ok) {
        res.status(result.error.status).json({ ok: false, error: result.error });
        return;
      }
      onDataChange?.({ entity: 'order-shipment-batch', action: 'create', ids: [result.data.id] });
      res.status(201).json({ ok: true, batch: serializeValue(result.data) });
    } catch (err: any) {
      logger.error('[ShippingRoute] create order batch failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'CREATE_FAILED', fallbackMessage: '批次未能创建，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // PUT /order-batches/:batchId — 批次更新（计划字段仅计划期可改；status 仅允许 planned→cancelled）
  router.put('/order-batches/:batchId', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    try {
      const result = await nativeBatchService.updateBatch(req.params.batchId, req.body || {}, (req as any).actor ?? null);
      if (!result.ok) {
        res.status(result.error.status).json({ ok: false, error: result.error });
        return;
      }
      onDataChange?.({ entity: 'order-shipment-batch', action: 'update', ids: [req.params.batchId] });
      res.json({ ok: true, batch: serializeValue(result.data) });
    } catch (err: any) {
      logger.error('[ShippingRoute] update order batch failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'UPDATE_FAILED', fallbackMessage: '批次未能保存，本次改动未生效，请稍后重试；持续失败请联系管理员。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // Fresh exact source context for a recoverable manual financial confirmation.
  router.get('/order-batches/:batchId/physical-context', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    const shipmentId = typeof req.query.shipmentId === 'string' ? req.query.shipmentId : undefined;
    batchRespond(res, await nativeBatchService.readMarkContext(req.params.batchId, shipmentId, (req as any).actor ?? null));
  });

  // POST /order-batches/:batchId/mark-shipped — 批次发运确认（排船回填 + 尾款到期日计算 + 末批收款门禁）
  router.post('/order-batches/:batchId/mark-shipped', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    try {
      const result = await nativeBatchService.markShipped(req.params.batchId, req.body || {}, (req as any).actor ?? null);
      if (!result.ok) {
        res.status(result.error.status).json({ ok: false, error: result.error });
        return;
      }
      onDataChange?.({ entity: 'order-shipment-batch', action: 'update', ids: [req.params.batchId] });
      res.json({ ok: true, batch: serializeValue(result.data) });
    } catch (err: any) {
      logger.error('[ShippingRoute] mark batch shipped failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'SHIP_FAILED', fallbackMessage: '批次未能标记为已出运，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对运单状态。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // POST /order-batches/:batchId/recalc — 结算进度重算（发票分配/核销变动后手动触发；自动触发点二期接入）
  router.post('/order-batches/:batchId/recalc', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    try {
      const result = await nativeBatchService.recalc(req.params.batchId, (req as any).actor ?? null);
      if (!result.ok) {
        res.status(result.error.status).json({ ok: false, error: result.error });
        return;
      }
      res.json({ ok: true, batch: serializeValue(result.data) });
    } catch (err: any) {
      logger.error('[ShippingRoute] recalc batch settlement failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'RECALC_FAILED', fallbackMessage: '批次金额重算未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对分摊与运费。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // ── REQ2-20（DR-061）：GET /booking-reminders — 旺季舱位预警清单（订舱提前期规则扫描，只读零写） ──
  // 字面路由：须在参数路由 /:id 之前注册
  router.get('/booking-reminders', async (req: Request, res: Response) => {
    try {
      const result = await bookingLeadTimeService.listBookingReminders();
      res.json(serializeValue(result));
    } catch (err: any) {
      logger.error('[ShippingRoute] booking reminders failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'BOOKING_REMINDERS_FAILED', fallbackMessage: '订舱提醒列表加载失败，请稍后重试；持续失败请联系管理员核对订舱日期与运单数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // GET /api/v1/shipping — list / search（format=xlsx → 全量台账 Excel 导出）
  router.get('/', async (req: Request, res: Response) => {
    try {
      const exportAll = req.query.format === 'xlsx';
      const limit = exportAll ? undefined : Math.min(Number(req.query.limit) || 50, 200);
      const offset = exportAll ? 0 : (Number(req.query.offset) || 0);

      const where: any = { deletedAt: null };
      if (req.query.type) where.type = String(req.query.type);
      if (req.query.status) where.status = String(req.query.status);
      if (req.query.orderId) {
        const sourceOrderId = String(req.query.orderId);
        const selectedScope = await readAllocationScope(prisma, req);
        if (!await (prisma as any).order.findFirst({ where: { id: sourceOrderId, deletedAt: null, AND: [selectedScope] }, select: { id: true } }))
          throw businessError('SHIPMENT_NOT_FOUND', '本订单出运来源不存在或不可查看。');
        where.AND = [...(where.AND ?? []), { OR: [{ orderId: sourceOrderId },
          { id: { in: (await (prisma as any).shipmentOrderAllocation.findMany({ where: { orderId: sourceOrderId, status: { not: 'Cancelled' } }, select: { shipmentId: true } })).map((row: any) => row.shipmentId) } }] }];
      }
      if (req.query.customerRelationId) where.customerRelationId = String(req.query.customerRelationId);
      if (req.query.carrierRelationId) where.carrierRelationId = String(req.query.carrierRelationId);
      if (req.query.carrierName) where.carrierName = { contains: String(req.query.carrierName), mode: 'insensitive' };
      if (req.query.shipmentNumber) where.shipmentNumber = { contains: String(req.query.shipmentNumber), mode: 'insensitive' };
      if (req.query.search) {
        const q = String(req.query.search);
        const qInsensitive = { contains: q, mode: 'insensitive' };
        where.OR = [{ shipmentNumber: qInsensitive }, { customerName: qInsensitive }, { carrierName: qInsensitive }];
      }

      // §10.4.2：出运单随关联订单可见（DR-016：orderId 只是投影，真源是分配表 →
      // 多单拼柜时只看投影字段会漏判，故用 buildShipmentVisibilityWhere 覆盖两者）
      const visibleOrderIds = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      const shipmentScope = await buildShipmentVisibilityWhere(prisma, visibleOrderIds);
      if (Object.keys(shipmentScope).length > 0) {
        where.AND = [...(where.AND ?? []), shipmentScope];
      }

      const [items, total] = await Promise.all([
        (prisma as any).shipment.findMany({ where, ...(limit != null ? { take: limit, skip: offset } : {}), orderBy: { createdAt: 'desc' } }),
        (prisma as any).shipment.count({ where }),
      ]);
      if (exportAll) {
        const sheet: XlsxSheet = {
          name: '运单台账',
          columnLabels: ['运单号', '类型', '状态', '运输方式', '客户', '承运方', '船名/航班', '航次', '起运港', '目的港', '计划离港', '实际离港', '件数', '毛重(kg)', '净重(kg)', '体积(CBM)', '运费', '运费币种', '备注'],
          columns: ['shipmentNumber', 'type', 'status', 'shippingMethod', 'customerName', 'carrierName', 'vesselOrFlight', 'voyageNumber', 'portOfLoading', 'portOfDischarge', 'etd', 'atd', 'totalPackages', 'grossWeight', 'netWeight', 'volume', 'freightAmount', 'freightCurrency', 'notes'],
          rows: items.map((s: any) => ({
            shipmentNumber: s.shipmentNumber,
            type: SHIPMENT_TYPE_LABEL[s.type] ?? s.type,
            status: SHIPMENT_STATUS_LABEL[s.status] ?? s.status,
            shippingMethod: shippingMethodLabel(s.shippingMethod) ?? s.shippingMethod,
            customerName: s.customerName,
            carrierName: s.carrierName,
            vesselOrFlight: s.vesselOrFlight,
            voyageNumber: s.voyageNumber,
            portOfLoading: s.portOfLoading,
            portOfDischarge: s.portOfDischarge,
            etd: s.etd,
            atd: s.atd,
            totalPackages: s.totalPackages,
            grossWeight: s.grossWeight != null ? Number(s.grossWeight) : null,
            netWeight: s.netWeight != null ? Number(s.netWeight) : null,
            volume: s.volume != null ? Number(s.volume) : null,
            freightAmount: s.freightAmount != null ? Number(s.freightAmount) : null,
            freightCurrency: s.freightCurrency,
            notes: s.notes,
          })),
        };
        const today = todayLocalKey();
        return res.set(xlsxDownloadHeaders(`运单台账_${today}.xlsx`)).send(buildXlsx([sheet]));
      }
      res.json({ items, total });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '运单列表加载失败，请稍后重试；持续失败请联系管理员核对运单数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // GET /api/v1/shipping/stats/on-time — 准交率统计（只读；两段式路径不与 /:id 冲突）
  router.get('/stats/on-time', async (req: Request, res: Response) => {
    try {
      const stats = await readAuthorizedShipmentStats(prisma, (req as any).actor ?? null, 'on-time', {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(stats);
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'STATS_FAILED', fallbackMessage: '准班率统计加载失败，请稍后重试；持续失败请联系管理员核对出运与到港日期。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  /**
   * ★ C1（2026-09-18）GET /api/v1/shipping/stats/containers — 按柜号聚合（只读）
   *
   * 为什么是两段式路径：`/containers` 单段会被下面的 `/:id` 抢匹配（本仓已有踩坑记录：
   * 404 文案像业务错误而非「无此路由」）。与 `/stats/on-time` 同范式。
   *
   * 返回：每柜的票/客户/件重体 + 关联报关单 + 关联退税 + **柜内矛盾**（ETD/目的港/船名/航次不一致）
   *      + 未填柜号的票（单独列出，不硬塞进某个柜）。
   */
  router.get('/stats/containers', async (req: Request, res: Response) => {
    try {
      const result = await getContainerConsolidation(prisma, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(result);
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'CONTAINER_STATS_FAILED', fallbackMessage: '集装箱统计加载失败，请稍后重试；持续失败请联系管理员核对柜号与运单数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // GET /api/v1/shipping/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const item = await (prisma as any).shipment.findUnique({ where: { id: req.params.id } });
      if (!item || item.deletedAt) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '运单不存在' } });
      // §10.4.2：详情同样按关联订单把关（防猜 id 直读越权票）
      const visForDetail = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      if (!(await isShipmentVisible(prisma, visForDetail, item))) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: '运单不存在' } });
      }
      res.json(item);
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'GET_FAILED', fallbackMessage: '该运单详情加载失败，请稍后重试；若反复出现请核对运单编号是否正确。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  /**
   * ★ D5（2026-09-18）GET /api/v1/shipping/:id/schedule-history — 改期/物流变更历史（只读）
   *
   * 为什么需要：甩柜/改船期是面料外贸最高频的异常，而改期此前**没有任何留痕**
   * （`update_shipment` 审计只记 status+shipmentNumber）⇒「这票改过几次期、谁改的」查不到。
   * `?datesOnly=1` 只返回日期类字段（ETD/ETA/ATD/ATA/订舱日）—— 回答「被甩了几次柜」。
   */
  router.get('/:id/schedule-history', async (req: Request, res: Response) => {
    try {
      const datesOnly = String(req.query.datesOnly ?? '') === '1';
      const limit = Number(req.query.limit ?? 100);
      const result = await readAuthorizedShipmentScheduleHistory(prisma, (req as any).actor ?? null,
        req.params.id, { datesOnly, limit });
      res.json(result);
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'SCHEDULE_HISTORY_FAILED', fallbackMessage: '船期变更历史加载失败，请稍后重试；持续失败请联系管理员核对船期记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // GET /api/v1/shipping/:id/document-set — 制单数据装配（只读，供 CI / PL 使用）
  router.get('/:id/document-set', async (req: Request, res: Response) => {
    try {
      const expectedSourceFingerprint = req.query.expectedSourceFingerprint;
      if (expectedSourceFingerprint !== undefined && (typeof expectedSourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSourceFingerprint))) throw businessError('VALIDATION_FAILED', '运单来源凭据无效。');
      const result = await assembleDocumentSetData(prisma, req.params.id, { trustedActor: (req as any).actor ?? extractActorFromRequest(req), ...(expectedSourceFingerprint !== undefined ? { expectedSourceFingerprint } : {}) }) as Awaited<ReturnType<typeof assembleDocumentSetData>>;
      if (!result.ok) {
        // ★ v2.47 复核 I-1：这一档过去是本文件自己写的 `code === 'SHIPMENT_NOT_FOUND' ? 404 : 500`，
        //   与报关组合文档那处是**同一句判断写两遍**。现在只问"域内声明的是哪枚码"，档位查注册表。
        // ★ v2.47 复核 I-3：原先这里写 `lookupErrorCode(code)?.status ?? 500` ⇒ **注册表外多了一个状态码数字**，
        //   且同一枚未登记的码在两条路径上失败方式不一致（抛错侧当场炸、这里静默 500）。
        //   改 `httpStatusOfCode` 后：档位数字只存在于注册表，缺码两侧同规则（都抛）。
        const code = documentSetHttpErrorCode(result.error!.code);
        res.status(httpStatusOfCode(code)).json({ error: result.error });
        return;
      }
      res.json(result.data);
    } catch (err: any) {
      // ★ v2.47 复核 minor-5：这句兜底文案与注册表里 `ASSEMBLE_FAILED` 的文案**逐字重复**了一遍
      //   ⇒ 去掉调用点那份，让注册表成为唯一出处（行为不变：`fallbackMessage` 本就与注册表同文）。
      const se = safeRouteError(err, { fallbackCode: 'ASSEMBLE_FAILED' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  router.get('/:id/ci-sources', async (req: Request, res: Response) => {
    try {
      const result = await listCiInvoiceSourcesForShipment(prisma, req.params.id, (req as any).actor ?? extractActorFromRequest(req));
      res.json(result);
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'ASSEMBLE_FAILED' });
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } });
    }
  });

  // GET /api/v1/shipping/stats/by-method — C4 运输方式维度统计（只读；须在 /:id 之前注册）
  router.get('/stats/by-method', async (req: Request, res: Response) => {
    try {
      const stats = await readAuthorizedShipmentStats(prisma, (req as any).actor ?? null, 'by-method', {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(stats);
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'STATS_FAILED', fallbackMessage: '出运方式统计加载失败，请稍后重试；持续失败请联系管理员核对运输方式数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // GET /api/v1/shipping/:id/lines — C4 装运行（只读）
  router.get('/:id/lines', async (req: Request, res: Response) => {
    try {
      const sh = await (prisma as any).shipment.findUnique({ where: { id: req.params.id }, select: { id: true, deletedAt: true } });
      if (!sh || sh.deletedAt) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '运单不存在' } });
      const items = await listShipmentLines(prisma, req.params.id);
      res.json({ items, total: items.length });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '该运单的明细行加载失败，请稍后重试；持续失败请联系管理员核对订单行数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // A dispatched ticket may correct packaging metadata only; original packing remains locked.
  router.get('/:id/carton-metadata', requirePermission('shipments:read'), async (req: Request, res: Response) => {
    try { res.json(await readShipmentCartonMetadata(prisma, req.params.id, (req as any).actor ?? null)); }
    catch (error) { const safe = shipmentCartonMetadataError(error); res.status(safe.status).json({ error: { code: safe.code, message: safe.message } }); }
  });
  router.put('/:id/carton-metadata', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    try {
      const result = await saveShipmentCartonMetadata({ prisma, shipmentId: req.params.id, actor: (req as any).actor ?? null, input: req.body, ip: req.ip });
      if ('rejection' in result) { res.status(httpStatusOfCode(result.rejection.code)).json({ error: { code: result.rejection.code, message: result.rejection.message }, rejection: result.rejection }); return; }
      onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] }); res.json(result);
    } catch (error) { const safe = shipmentCartonMetadataError(error); res.status(safe.status).json({ error: { code: safe.code, message: safe.message } }); }
  });

  // Atomic editor snapshot/command. The old line/carton endpoints retain their contracts.
  router.get('/:id/packing', requirePermission('shipments:read'), async (req: Request, res: Response) => {
    try { res.json(await readShipmentPacking(prisma, req.params.id, (req as any).actor ?? null)); }
    catch (error) { const safe = packingCommandError(error); res.status(safe.status).json({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } }); }
  });
  router.put('/:id/packing', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    try {
      const result = await saveShipmentPacking({ prisma, shipmentId: req.params.id, actor: (req as any).actor ?? null, input: req.body, ip: req.ip });
      if (result.rejection) { res.status(httpStatusOfCode(result.rejection.code)).json({ error: { code: result.rejection.code, message: result.rejection.message }, rejection: result.rejection }); return; }
      onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] }); res.json(result);
    } catch (error) { const safe = packingCommandError(error); res.status(safe.status).json({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } }); }
  });

  // PUT /api/v1/shipping/:id/lines — C4 装运行整组替换（幂等）
  router.put('/:id/lines', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;
    if (!lines) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'body.lines must be an array' } });
    const result = await replaceShipmentLines(prisma, req.params.id, lines, actorIdFromRequest(req), req.ip || null, { actor: (req as any).actor });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { NOT_FOUND: 404, INVALID_CURRENT_STATUS: 409, VALIDATION_FAILED: 400, EXCLUSIVE_FABRIC_BLOCKED: 409 };
      res.status(result.error!.statusCode ?? statusCodeMap[result.error!.code] ?? httpStatusOfCode(result.error!.code)).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] });
    res.json(result.data);
  });

  // ─── T6-b 陆运段（H12/D4 拍板 3）：一票一段 upsert + 费用采集（不进毛利，口径未切） ───
  const landTransportService = createShipmentLandTransportService(prisma);

  // GET /api/v1/shipping/:id/land-transport — 查该票陆运段（无则 null）
  router.get('/:id/land-transport', requirePermission('shipments:read'), async (req: Request, res: Response) => {
    try {
      const r = await landTransportService.getLandTransport(req.params.id);
      res.json(serializeValue({ ok: true, landTransport: (r as any).data.landTransport }));
    } catch (err: any) {
      logger.error('[ShippingRoute] get land transport failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'GET_FAILED', fallbackMessage: '该运单的陆运段信息加载失败，请稍后重试；持续失败请联系管理员核对陆运数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // PUT /api/v1/shipping/:id/land-transport — upsert 陆运段（约定/实达/车牌司机/费用）
  router.put('/:id/land-transport', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    try {
      const r = await landTransportService.upsertLandTransport({
        shipmentId: req.params.id,
        input: req.body || {},
        actorId: actorIdFromRequest(req),
        ip: req.ip || null,
      });
      if (!r.ok) {
        res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } });
        return;
      }
      onDataChange?.({ entity: 'shipping', action: 'land-transport', ids: [req.params.id] });
      res.json(serializeValue({ ok: true, landTransport: (r as any).data.landTransport }));
    } catch (err: any) {
      logger.error('[ShippingRoute] upsert land transport failed', { error: err?.message });
      const se = safeRouteError(err, { fallbackCode: 'UPSERT_FAILED', fallbackMessage: '陆运段未能保存，本次改动未生效，请稍后重试；持续失败请联系管理员核对陆运与柜号数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // POST /api/v1/shipping/:id/lines/pull-from-order — C4 从订单重新带出装运行
  router.post('/:id/lines/pull-from-order', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    const result = await pullLinesFromOrder(prisma, req.params.id, actorIdFromRequest(req), req.ip || null, { actor: (req as any).actor });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { NOT_FOUND: 404, ORDER_NOT_FOUND: 404, INVALID_CURRENT_STATUS: 409, VALIDATION_FAILED: 400, EXCLUSIVE_FABRIC_BLOCKED: 409 };
      res.status(result.error!.statusCode ?? statusCodeMap[result.error!.code] ?? httpStatusOfCode(result.error!.code)).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] });
    res.json(result.data);
  });

  // GET /api/v1/shipping/:id/cartons — C4 逐箱装箱（只读，含箱内分配）
  router.get('/:id/cartons', async (req: Request, res: Response) => {
    try {
      const sh = await (prisma as any).shipment.findUnique({ where: { id: req.params.id }, select: { id: true, deletedAt: true } });
      if (!sh || sh.deletedAt) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '运单不存在' } });
      const items = await listShipmentCartons(prisma, req.params.id);
      res.json({ items, total: items.length });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '该运单的装箱清单加载失败，请稍后重试；持续失败请联系管理员核对装箱数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // PUT /api/v1/shipping/:id/cartons — C4 逐箱整组替换（幂等，箱内分配随行校验）
  router.put('/:id/cartons', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    const cartons = Array.isArray(req.body?.cartons) ? req.body.cartons : null;
    if (!cartons) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'body.cartons must be an array' } });
    const result = await replaceShipmentCartons(prisma, req.params.id, cartons, actorIdFromRequest(req), req.ip || null, { actor: (req as any).actor });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { NOT_FOUND: 404, INVALID_CURRENT_STATUS: 409, VALIDATION_FAILED: 400 };
      res.status(result.error!.statusCode ?? statusCodeMap[result.error!.code] ?? httpStatusOfCode(result.error!.code)).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] });
    res.json(result.data);
  });

  // GET /api/v1/shipping/:id/events — F3 物流节点时间轴（ShipmentEvent 升序全量）
  router.get('/:id/events', async (req: Request, res: Response) => {
    try {
      const sh = await (prisma as any).shipment.findUnique({ where: { id: req.params.id }, select: { id: true, deletedAt: true } });
      if (!sh || sh.deletedAt) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '运单不存在' } });
      const items = await (prisma as any).shipmentEvent.findMany({
        where: { shipmentId: req.params.id },
        orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
      });
      res.json({ items, total: items.length });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '该运单的操作记录加载失败，请稍后重试；持续失败请联系管理员核对审计记录。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message, ...(se.details === undefined ? {} : { details: se.details }) } });
    }
  });

  // POST /api/v1/shipping — create (high risk, approval upstream)
  // task ERP-P1-shipping-mutation-shared-service-foundation: route 只调 service
  router.post('/', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    if (hasMvpExcludedShipmentInsuranceFields(req.body)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '当前 MVP 不登记独立保险字段；如外部出运资料含保险信息，请作为普通附件归档。' } });
      return;
    }
    if (req.body?.eta != null || req.body?.ata != null) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '当前 MVP 不记录目的地预计/实际到港时间；请只登记计划离港与实际离港信息。' } });
      return;
    }
    const input = pickFields(req.body as ShipmentCreateInput, [
      'type', 'shippingMethod', 'loadType', 'status', 'bookingDate',
      'etd', 'atd',
      'vesselOrFlight', 'voyageNumber',
      'portOfLoading', 'portOfDischarge',
      'containerNumber', 'sealNumber', 'trackingNumber', 'carrierTrackingUrl', 'totalPackages',
      'grossWeight', 'netWeight', 'volume',
      'freightAmount', 'freightCurrency',
      'customsAmount', 'customsCurrency',
      'otherCharges', 'otherChargesCurrency',
      'orderId', 'customerRelationId', 'customerName',
      'carrierRelationId', 'carrierName',
      // DR-016 四方交易方（B4 字段收敛：补入白名单，杜绝"建运单时被静默丢弃"）
      'consigneeRelationId', 'consigneeName',
      'docRecipientRelationId', 'docRecipientName',
      'payerRelationId', 'payerName',
      'hsCode', 'customsBroker', 'customsDeclarationNumber', 'customsClearanceDate',
      'notes', 'attachments',
    ]);
    const result = await createShipment({
      prisma, input, actorId: actorIdFromRequest(req), actor: (req as any).actor, ip: req.ip || null,
      exceptionChecker: shipmentReleaseChecker,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        VALIDATION_ERROR: 400,
        INVALID_STATUS: 400,
        INVALID_INITIAL_STATUS: 400,
        INVALID_SHIPPING_METHOD: 400, // ★ C2 运输方式不在枚举内
        ORDER_NOT_FOUND: 404,
        ORDER_TERMINAL: 400,
        INVALID_CURRENT_ORDER_STATUS: 400,
        GATE_BLOCKED: 409,
        CREATE_FAILED: 500,
      };
      const code = result.error!.code;
      res.status(result.error!.statusCode || statusCodeMap[code] || 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'create', ids: [result.data!.shipment.id] });
    res.status(201).json(serializeValue(result.data!.shipment));
  });

  router.get('/:id/physical-context', requirePermission('shipments:read'), async (req: Request, res: Response) => {
    try {
      const data = await prisma.$transaction(async (tx: any) => {
        const scope = await readAllocationScope(tx, req);
        const shipment = await tx.shipment.findUnique({ where: { id: req.params.id } });
        if (!shipment || shipment.deletedAt != null) throw businessError('SHIPMENT_NOT_FOUND', '运单不存在或不可查看。');
        const allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId: shipment.id }, orderBy: { id: 'asc' } });
        const selectedOrderId = typeof req.query.orderId === 'string' ? req.query.orderId.trim() : '';
        const orderIds = [...new Set<string>([shipment.orderId, ...allocations.map((row: any) => row.orderId), selectedOrderId].filter(Boolean))].sort();
        for (const id of orderIds) if (!await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] }, select: { id: true } }))
          throw businessError('SHIPMENT_NOT_FOUND', '运单不存在或不可查看。');
        if (!orderIds.length && Object.keys(scope).length) throw businessError('SHIPMENT_NOT_FOUND', '运单不存在或不可查看。');
        const physical = await tx.shipmentProductionAllocation.findMany({ where: { shipmentId: shipment.id }, orderBy: { id: 'asc' } });
        const modern = physical.length > 0 || await tx.productionBatch.count({ where: { orderId: { in: orderIds } } }) > 0;
        const claims = await tx.claimDisposition.count({ where: { replacementShipmentId: shipment.id } })
          + await tx.repairWorkOrder.count({ where: { reshipmentId: shipment.id } });
        return { kind: claims ? 'claim' : modern ? 'physical' : 'legacy', updatedAt: String(shipment.updatedAt),
          allocationFingerprint: physicalShipmentAllocationFingerprint({ shipment, allocations, physical, orderIds }) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      res.json(data);
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'LIST_FAILED', fallbackMessage: '运单当前范围暂时无法读取，请刷新后重试。' });
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } });
    }
  });

  // Export customs is performed outside Bambook; logistics records the external
  // completion fact only after the linked, protected proof file has been archived.
  router.post('/:id/export-declaration-completion', requirePermission('shipments:write'), requirePermission('customs:write'), async (req: Request, res: Response) => {
    const completedAt = normalizeExportDeclarationCompletedAt(req.body?.completedAt);
    const evidenceDocumentId = typeof req.body?.evidenceDocumentId === 'string' ? req.body.evidenceDocumentId.trim() : '';
    const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
    if (!completedAt || !evidenceDocumentId || evidenceDocumentId.length > 120 || reference.length > 120) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '请填写有效的申报完成时间和凭证；外部申报编号最多 120 个字符。' } });
      return;
    }
    const result = await updateShipment({
      prisma, shipmentId: req.params.id,
      patch: {
        exportDeclarationCompletedAt: completedAt,
        exportDeclarationEvidenceDocumentId: evidenceDocumentId,
        exportDeclarationReference: reference || null,
      },
      hasStatus: false,
      actorId: actorIdFromRequest(req), actor: (req as any).actor, ip: req.ip || null,
      auditSource: 'route:shipping:export-declaration-completion',
      physicalCommand: { requestKey: req.body?.requestKey, expectedShipmentUpdatedAt: req.body?.expectedShipmentUpdatedAt,
        expectedPhysicalAllocationFingerprint: req.body?.expectedPhysicalAllocationFingerprint },
    });
    if (!result.ok) {
      const code = result.error!.code;
      const status = code === 'VALIDATION_ERROR' ? 400 : code === 'GATE_BLOCKED' ? 409 : httpStatusOfCode(code);
      res.status(status).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'export_declaration_completed', ids: [result.data!.shipment.id] });
    const acknowledgement = (result.data as any).acknowledgement;
    res.json(serializeValue(acknowledgement ? { ...result.data!.shipment, acknowledgement } : result.data!.shipment));
  });

  // PATCH /api/v1/shipping/:id
  // task ERP-P1-shipping-mutation-shared-service-foundation: route 只调 service
  router.patch('/:id', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    if (hasMvpExcludedShipmentInsuranceFields(req.body)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '当前 MVP 不登记独立保险字段；如外部出运资料含保险信息，请作为普通附件归档。' } });
      return;
    }
    if (req.body?.eta != null || req.body?.ata != null) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '当前 MVP 不记录目的地预计/实际到港时间；请只登记计划离港与实际离港信息。' } });
      return;
    }
    const hasStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'status');
    const patch = pickFields(req.body, SHIPMENT_PATCH_FIELDS);
    const result = await updateShipment({
      prisma, shipmentId: req.params.id, patch, hasStatus,
      physicalCommand: { requestKey: req.body?.requestKey, expectedShipmentUpdatedAt: req.body?.expectedShipmentUpdatedAt, expectedPhysicalAllocationFingerprint: req.body?.expectedPhysicalAllocationFingerprint },
      actorId: actorIdFromRequest(req), actor: (req as any).actor, ip: req.ip || null,
      exceptionChecker: shipmentReleaseChecker,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        NOT_FOUND: 404,
        VALIDATION_ERROR: 400,
        INVALID_STATUS: 400,
        INVALID_TRANSITION: 400,
        INVALID_CURRENT_STATUS: 400,
        ORDER_NOT_FOUND: 404,
        ORDER_TERMINAL: 400,
        INVALID_CURRENT_ORDER_STATUS: 400,
        GATE_BLOCKED: 409,
        UPDATE_FAILED: 500,
      };
      const code = result.error!.code;
      /**
       * ★★ 2026-09-29 晚：**本地表查不到 ≠ 500** —— 先问档位真源（`shared/errorCodes`）。
       *
       *   起因（实测，不是设想）：短装拦截返回 `ORDER_LINE_SHORT_SHIPPED`（注册表登记 409），
       *   而本地表里没有它 ⇒ 兜底档位会把「业务规则挡住」渲染成「服务器内部错误」，
       *   业务员看到 500 只会反复重试，**永远不会**去走"客户同意少发"的审批。
       *   同族的 `SHIPMENT_ACTUAL_QTY_MISSING` / `SHIPMENT_NO_ALLOCATION_DETAIL` 同理。
       *
       *   ⚠️ 刻意**不**把这三枚码抄进本地表：那会给 B32 棘轮凭空多登记三处本地 code→status 映射
       *     （本仓明令禁止"登记欠债"）；"查不到就问真源"才是根治。
       *   ★★ 也**不许**在这里写兜底数字（`?.status ?? 500` 这一族形状被 B68 守卫判死）：
       *     本地表里没有的码，档位**只许从注册表拿**（`httpStatusOfCode`，缺码即抛 = 编程错误）。
       *     为此 `ShipmentMutationErrorCode` 里那 6 枚此前没登记的码已一并登记进注册表 ——
       *     否则今天就会从 500 变成"抛错直接回不到响应"。
       *   ⓘ 顺序 = 本地表（存量码的既有档位）→ 注册表（新增码的真源）。
       */
      const status = statusCodeMap[code] ?? httpStatusOfCode(code);
      if (code === 'SHIPMENT_NOT_FOUND') result.error = { ...result.error!, code: 'NOT_FOUND' };
      res.status(status).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'update', ids: [result.data!.shipment.id] });
    const acknowledgement = (result.data as any).acknowledgement;
    res.json(acknowledgement ? { ...result.data!.shipment, acknowledgement } : serializeValue(result.data!.shipment));
  });

  // DELETE /api/v1/shipping/:id — soft delete
  // task ERP-P1-shipping-mutation-shared-service-foundation: route 只调 service
  router.delete('/:id', requireRole(...HIGH_RISK_ROLES), async (req: Request, res: Response) => {
    const result = await deleteShipment({
      prisma, shipmentId: req.params.id,
      actorId: actorIdFromRequest(req), actor: (req as any).actor, ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { NOT_FOUND: 404, INVALID_STATUS: 400, INVOICE_LINKED: 409, DELETE_FAILED: 500 };
      const code = result.error!.code;
      res.status(result.error!.statusCode || statusCodeMap[code] || 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'delete', ids: [result.data!.shipment.id] });
    res.json({ ok: true, id: result.data!.shipment.id });
  });

  // ════════════════════════════════════════════════════════════════
  // DR-016 合票建模 — ShipmentOrderAllocation 分配记录路由
  // ════════════════════════════════════════════════════════════════

  // GET /api/v1/shipping/:id/allocations — 票内分配列表
  router.get('/:id/allocations', requirePermission('shipments:read'), async (req: Request, res: Response) => {
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const scope = await readAllocationScope(tx, req);
        const shipment = await tx.shipment.findUnique({ where: { id: req.params.id } });
        if (!shipment || shipment.deletedAt != null) throw businessError('SHIPMENT_NOT_FOUND', '运单不存在或不可查看。');
        const allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId: shipment.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        const sourceIds = [...new Set<string>([shipment.orderId, ...allocations.map((row: any) => row.orderId)].filter(Boolean))];
        const visible = await tx.order.findMany({ where: { id: { in: sourceIds }, deletedAt: null, AND: [scope] }, select: { id: true } });
        const allowed = new Set(visible.map((row: any) => row.id));
        if (Object.keys(scope).length > 0 && !allowed.size) throw businessError('SHIPMENT_NOT_FOUND', '运单不存在或不可查看。');
        const items = allocations.filter((row: any) => allowed.has(row.orderId));
        const physical = await tx.shipmentProductionAllocation.findMany({ where: { allocationId: { in: items.map((row: any) => row.id) } }, orderBy: { id: 'asc' } });
        return { items: items.map((row: any) => ({ ...row, productionBatchAllocations: physical.filter((item: any) => item.allocationId === row.id) })) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      res.json(allocationJson(result));
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'LIST_FAILED', fallbackMessage: '本票分配暂时无法加载，请稍后重试。' });
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } });
    }
  });

  // POST /api/v1/shipping/:id/allocations — 新增分配（合票/拆票）
  router.post('/:id/allocations', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    const physical = await physicalAllocationWrite(req);
    if (physical !== null) { res.status(physical.status).json(physical.body); return; }
    const { orderId, orderLineId, plannedQty, actualQty, unit, status, batchOrCartonNote, exception } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'body.orderId 必填' } });
    }
    const result = await allocationService.createAllocation(req.params.id, {
      orderId, orderLineId, plannedQty, actualQty, unit, status, batchOrCartonNote, exception,
    }, actorIdFromRequest(req), req.ip || null, { actor: (req as any).actor ?? null });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        SHIPMENT_NOT_FOUND: 404,
        ORDER_NOT_FOUND: 404,
        CONSOLIDATION_CUSTOMER_MISMATCH: 409,
        CONSOLIDATION_BUSINESS_LINE_MISMATCH: 409,
        ORDER_LINE_OVER_ALLOCATED: 409,
        ALLOCATION_DUPLICATE: 409, // ★ A4 同票同订单（行）重复分配
        VALIDATION_FAILED: 400,
        CREATE_FAILED: 500,
      };
      res.status(result.error!.status ?? statusCodeMap[result.error!.code] ?? 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] });
    res.status(201).json(result.data!.allocation);
  });

  // PATCH /api/v1/shipping/:id/allocations/:allocId — 更新分配
  router.patch('/:id/allocations/:allocId', requirePermission('shipments:write'), async (req: Request, res: Response) => {
    const physical = await physicalAllocationWrite(req, req.params.allocId);
    if (physical !== null) { res.status(physical.status).json(physical.body); return; }
    const result = await allocationService.updateAllocation(req.params.id, req.params.allocId, req.body || {},
      actorIdFromRequest(req), req.ip || null, { actor: (req as any).actor ?? null });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        SHIPMENT_NOT_FOUND: 404,
        ALLOCATION_NOT_FOUND: 404,
        ORDER_LINE_OVER_ALLOCATED: 409,
        VALIDATION_FAILED: 400,
        UPDATE_FAILED: 500,
      };
      res.status(result.error!.status ?? statusCodeMap[result.error!.code] ?? 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] });
    res.json(result.data!.allocation);
  });

  // DELETE /api/v1/shipping/:id/allocations/:allocId — 删除分配
  router.delete('/:id/allocations/:allocId', requireRole(...HIGH_RISK_ROLES), async (req: Request, res: Response) => {
    try {
      if (await allocationRequiresPhysicalContract({ prisma, shipmentId: req.params.id, allocationId: req.params.allocId, actor: (req as any).actor ?? null })) {
        throw businessError('CONFLICT', '实际批次分配保留原历史，请取消未发运预留或通过原运单处理，不能直接删除。');
      }
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' });
      return res.status(safe.status).json({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } });
    }

    const result = await allocationService.deleteAllocation(req.params.id, req.params.allocId,
      actorIdFromRequest(req), req.ip || null, { actor: (req as any).actor ?? null });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        SHIPMENT_NOT_FOUND: 404,
        ALLOCATION_NOT_FOUND: 404,
        SHIPMENT_ALREADY_SHIPPED: 409, // ★ A1-b 已发运后禁删带实际出运量的分配
        DELETE_FAILED: 500,
      };
      res.status(result.error!.status ?? statusCodeMap[result.error!.code] ?? 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'shipping', action: 'update', ids: [req.params.id] });
    res.json({ ok: true, id: result.data!.allocation.id });
  });

  // GET /api/v1/shipping/allocations/by-order/:orderId — 按订单查询跨票分配
  router.get('/allocations/by-order/:orderId', requirePermission('shipments:read'), async (req: Request, res: Response) => {
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const scope = await readAllocationScope(tx, req);
        const order = await tx.order.findFirst({ where: { id: req.params.orderId, deletedAt: null, AND: [scope] }, select: { id: true } });
        if (!order) throw businessError('ORDER_NOT_FOUND', '订单不存在或不可查看。');
        const rows = await tx.shipmentOrderAllocation.findMany({ where: { orderId: order.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        const shipments = await tx.shipment.findMany({ where: { id: { in: rows.map((row: any) => row.shipmentId) }, deletedAt: null }, select: { id: true, shipmentNumber: true, status: true } });
        const physical = await tx.shipmentProductionAllocation.findMany({ where: { allocationId: { in: rows.map((row: any) => row.id) } }, orderBy: { id: 'asc' } });
        return { items: rows.filter((row: any) => shipments.some((shipment: any) => shipment.id === row.shipmentId)).map((row: any) => ({ ...row, shipmentStatus: shipments.find((shipment: any) => shipment.id === row.shipmentId)?.status ?? null, shipmentNumber: shipments.find((shipment: any) => shipment.id === row.shipmentId)?.shipmentNumber ?? null, productionBatchAllocations: physical.filter((item: any) => item.allocationId === row.id) })) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      res.json(allocationJson(result));
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'LIST_FAILED', fallbackMessage: '订单出运分配暂时无法加载，请稍后重试。' });
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } });
    }
  });

  return router;
}
