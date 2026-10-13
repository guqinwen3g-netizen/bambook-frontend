
import { invalidateFinancialShipmentSourceInTx } from './shipmentFinancialAuthority';
/**
 * task ERP-P1-shipping-mutation-shared-service-foundation:
 * Shipment mutation service — route + Agent orderShipFlow 共用契约。
 * 每个 mutation 内部（或复用外部 tx）走 $transaction，业务写入 + syncShipmentReferences +
 * linkOrderStatusFromShipment（有 orderId 时）+ writeRouteAuditLog 在同一事务闭环，
 * 任一失败 fail closed。
 */

import { PrismaClient, Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { lockReleaseSources } from '../production/releaseService';
import { assertPhysicalShipmentWriteAuthority, validatePhysicalAllocationVersion } from './shipmentPhysicalAllocationService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { lockShipmentPhysicalConsumer, validateReservedPhysicalShipment } from './shipmentPhysicalConsumerService';
import { beginPhysicalShipmentCommand, finishPhysicalShipmentCommand, originalPhysicalShipmentDispatch, validatePhysicalPackingQuantities, physicalShipmentJson, type PhysicalShipmentCommandInput } from './shipmentPhysicalCommand';
import { deductPhysicalShipmentStockInTx, reversePhysicalShipmentStockInTx, physicalShipmentFactoryLoadings } from './shipmentPhysicalStockService';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { syncShipmentReferences, deactivateEntityLinks } from '../entities/sync';
import { linkOrderStatusFromShipment } from './orderLinkService';
// ★ C3：出运事实 → 订单行已出运量快照（溢短装条款面板的数据源）
import { syncOrderLineShipmentQuantity } from '../shared/orderLineShippedQty';
import { missingRequiredShipmentFields, normalizeLoadType, normalizeShipMethod } from './shipmentFieldRules';
// MVP 出运方式只允许海运/空运；通用别名归一仍保留给历史读和其他非出运业务。
import { coerceMvpShippingMethodForWrite, coerceShippingMethodForWrite } from '../shared/shippingMethod';
// ★ D5：改期/物流变更留痕（字段级审计真源 + 中文描述）
import { SHIPMENT_TRACKED_FIELD_KEYS, normalizeScheduleSnapshot } from './shipmentScheduleFields';
import { validateStatusTransition } from '../statusTransition';
import { writeRouteAuditLog, writeFieldAuditDiff } from '../audit/routeAudit';
import { sweepNotificationsForDeletedEntities } from '../notifications/notificationService';
import { publishBusinessEvent, persistBusinessEventInTransaction } from '../events/businessEventBus';
import { mapOrderLinesToShipmentLineInputs, replaceShipmentLinesTx } from './shipmentPackingService';
import { evaluateShipmentReleaseGate, type ShipmentReleaseGateBlockedError } from './shipmentEligibilityGate';
import { createOrderShipmentBatchService } from './orderShipmentBatchService';
import {
  SHORT_SHIP_BLOCKED_CODE,
  ACTUAL_QTY_MISSING_CODE,
  NO_ALLOCATION_DETAIL_CODE,
  actualQtyMissingError,
  buildShortShipBlockedMessage,
  evaluateShortShipment,
  markAllocationsShortShipped,
  noAllocationDetailError,
  requestShortShipApproval,
  shortShipBlockedError,
} from './shortShipmentGate';
import { deductShipmentStockInTx, reverseShipmentStockInTx, STOCK_DEDUCTED_STATUSES } from './shipmentStockService';
import { claimRefusal } from '../claims/claimApprovalFact';
import { lockClaimShipmentSource, finalizeClaimShipmentInTx } from '../claims/claimShipmentFact';
import { createExceptionService } from '../exceptions/exceptionService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import type { ExceptionChecker } from '../exceptions/exceptionGate';
import { CreditExceptionConsumptionError, type CreditExceptionConsumptionErrorCode } from '../credit/creditExceptionGate';
import { assertShipmentExportDeclarationProof, normalizeExportDeclarationCompletedAt } from './shipmentExportDeclaration';
import { assertCurrentShipmentDocumentsSentInTx } from '../orders/orderShipmentDocumentsService';

export type ShipmentMutationErrorCode =
  | 'CONFLICT' | 'INVALID_INPUT' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'ACCOUNT_DISABLED' | 'AUTHORIZATION_UNAVAILABLE' | 'SHIPMENT_NOT_FOUND'
  | 'STOCK_INSUFFICIENT'
  | 'SHIPMENT_FIELD_REQUIRED_MISSING'
  | 'INVALID_STATE'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INVALID_STATUS'
  | 'INVALID_INITIAL_STATUS'
  | 'INVALID_TRANSITION'
  | 'INVALID_CURRENT_STATUS'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_TERMINAL'
  | 'INVALID_CURRENT_ORDER_STATUS'
  | 'INVALID_SHIPMENT_STATUS'
  | 'INVALID_SHIPPING_METHOD' // ★ C2：运输方式不在枚举内（含别名归一失败）
  | 'GATE_BLOCKED'
  /** ★ 2026-09-29 晚：短装（少做）拦截 —— 该行已收尾但总量低于合同下限（code 已登记进 shared/errorCodes） */
  | 'ORDER_LINE_SHORT_SHIPPED'
  /** ★ 2026-09-29 晚：出运数量完整性 —— 明细实际量未填 / 一条明细都没有（都不是"客户同意"能解决的） */
  | 'SHIPMENT_ACTUAL_QTY_MISSING'
  | 'SHIPMENT_NO_ALLOCATION_DETAIL'
  | 'INVOICE_LINKED'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'DELETE_FAILED'
  | 'COMMIT_TRANSACTION_FAILED';

export interface ShipmentMutationError {
  code: ShipmentMutationErrorCode | CreditExceptionConsumptionErrorCode;
  message: string;
  statusCode?: number;
  /** GATE_BLOCKED 时的门禁明细（blockingReasons 带订单维度 + 逐订单判定结果 + DR-013 申请入口） */
  gateDetails?: Pick<ShipmentReleaseGateBlockedError, 'blockingReasons' | 'orders' | 'exceptionReason' | 'exceptionEntryHint'>;
  /**
   * 短装/数量完整性拦截时的逐行明细。
   * · `blocked` + `approvalRequestIds/approvalError` ⇒ 缺的是**客户同意**（已代为发起审批单）
   * · `unfilled` / `noAllocationDetail` ⇒ 缺的是**数量本身**（★ 不发审批单，先录数据）
   */
  shortShipDetails?: { blocked?: any[]; unfilled?: any[]; noAllocationDetail?: boolean; approvalRequestIds?: string[]; approvalError?: string };
}

export interface ShipmentMutationResult<T = any> {
  ok: boolean;
  data?: T;
  error?: ShipmentMutationError;
}

// task_mqxxxu3k: Shipment status 合法枚举（fail closed）
export const VALID_SHIPMENT_STATUSES = ['Draft', 'Booked', 'Loading', 'Shipped', 'Arrived', 'Cleared', 'Delivered', 'Cancelled'];
const MVP_SHIPMENT_CREATE_STATUSES = ['Draft', 'Booked', 'Loading', 'Shipped'];
export function isValidShipmentStatus(s: string): boolean {
  return VALID_SHIPMENT_STATUSES.includes(s);
}

// ─── P2 物流日期交叉校验（前后端同口径，YYYY-MM-DD 字符串比较即时间序） ─────
export interface ShipmentScheduleFields {
  bookingDate?: string | null;
  etd?: string | null;
}

/** MVP 不在运单字段里登记保险；相关第三方材料只能作为普通附件归档。 */
export function hasMvpExcludedShipmentInsuranceFields(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['insuranceAmount', 'insuranceCurrency'].some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

const MVP_SHIPMENT_INSURANCE_MESSAGE = '当前 MVP 不登记独立保险字段；如外部出运资料含保险信息，请作为普通附件归档。';

/**
 * MVP 物流日期逻辑校验（跨字段）：
 *   - 订舱日期晚于 ETD → 舱位先订后离，倒挂（fail-closed 400）
 * 空值/半空组合放行（单字段缺失不构成交叉矛盾）；null 视同未填。
 */
export function validateShipmentScheduleCross(fields: ShipmentScheduleFields): string | null {
  const { bookingDate, etd } = fields;
  if (bookingDate && etd && bookingDate > etd) {
    return `订舱日期（${bookingDate}）不能晚于预计离港日（ETD ${etd}）`;
  }
  return null;
}

/** Actual departure is the evidence that an export has shipped; ETD is only a plan. */
export function validateShipmentActualDeparture(value: unknown): string | null {
  return isValidLocalDateKey(value) ? null : '确认已出运前必须填写有效的实际离港/起飞日期（ATD，YYYY-MM-DD）。';
}

// ─── 事务封装 helper：若传入 tx 则复用，否则自开 $transaction ─────
async function withTx<T>(prisma: PrismaClient, tx: any | undefined, fn: (t: any) => Promise<T>): Promise<T> {
  return tx ? await fn(tx) : await (prisma as any).$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 });
}

// ─── F3：物流节点事件 ─────────────────────────────────────────────
// 节点业务日期取值口径：优先对应业务日期字段，兜底当日（YYYY-MM-DD）
function nodeBusinessDate(toNode: string, sh: any): string {
  const today = todayLocalKey();
  switch (toNode) {
    case 'Booked': return sh?.bookingDate || today;
    case 'Shipped': return sh?.atd || today;
    case 'Arrived': return sh?.ata || sh?.eta || today;
    case 'Cleared': return sh?.customsClearanceDate || today;
    default: return today;
  }
}

/**
 * 事务内追加物流节点事件（append-only）。
 * route / agent 两条写路径共用此 helper，保证时间轴完整性单一来源。
 */
export async function appendShipmentEvent(
  t: any,
  params: { shipmentId: string; fromNode: string | null; toNode: string; shipment?: any; note?: string | null; actorId?: string | null },
): Promise<void> {
  await t.shipmentEvent.create({
    data: {
      id: `SHPE__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      shipmentId: params.shipmentId,
      fromNode: params.fromNode,
      toNode: params.toNode,
      eventDate: nodeBusinessDate(params.toNode, params.shipment),
      note: params.note ?? null,
      actorId: params.actorId ?? null,
      createdAt: BigInt(Date.now()),
    },
  });
}

function toMutationError(e: any, fallback: ShipmentMutationErrorCode): ShipmentMutationError {
  if (isBusinessError(e)) {
    const safe = safeRouteError(e, { fallbackCode: fallback });
    const domain = e as typeof e & Pick<ShipmentMutationError, 'gateDetails' | 'shortShipDetails'>;
    return {
      code: safe.code as ShipmentMutationErrorCode, message: safe.message, statusCode: safe.status,
      ...(domain.gateDetails ? { gateDetails: domain.gateDetails } : {}),
      ...(domain.shortShipDetails ? { shortShipDetails: domain.shortShipDetails } : {}),
    };
  }
  // Only the typed, current credit boundary is trusted. Raw SQL errors and an
  // arbitrary object's code do not acquire a business-error HTTP contract.
  if (e instanceof CreditExceptionConsumptionError) {
    const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });
    return { code: e.code, message: safe.message };
  }
  logger.error('[shipment] transaction failed', { error: e?.message ?? String(e), code: e?.code });
  return { code: fallback, message: '出运操作未能完成，请刷新核对当前记录后重试。' };
}

/**
 * DR-012/014 + REL-14-A4 出运放行门禁（目标状态 = Shipped 的统一前置校验）。
 * 门禁失败抛 code=GATE_BLOCKED（statusCode=409）错误，由 toMutationError 透传；
 * 例外查询器缺失时 fail-closed（无例外放行能力，隐藏旁路禁止）。
 */
async function assertShipmentReleaseGateOrThrow(params: {
  tx: any;
  orderIds: Array<string | null | undefined>;
  actorId: string;
  exceptionChecker?: ExceptionChecker | null;
  physicalBatchIdsByOrder?: Record<string, string[]>;
}): Promise<any> {
  const gate = await evaluateShipmentReleaseGate({
    prisma: params.tx,
    orderIds: params.orderIds,
    exceptionChecker: params.exceptionChecker ?? null,
    ...(params.physicalBatchIdsByOrder === undefined ? {} : { physicalBatchIdsByOrder: params.physicalBatchIdsByOrder }),
  });
  if (!gate.ok) {
    // 订单存在性失败（404 语义）与门禁阻断（409 语义）分流
    if (gate.error.code === 'ORDER_NOT_FOUND') {
      throw Object.assign(new Error(gate.error.message), { code: 'ORDER_NOT_FOUND' as const, statusCode: 404 });
    }
    throw Object.assign(new Error(gate.error.message), {
      code: 'GATE_BLOCKED' as const,
      statusCode: 409,
      gateDetails: {
        blockingReasons: gate.error.blockingReasons,
        orders: gate.error.orders,
        exceptionReason: gate.error.exceptionReason,
        exceptionEntryHint: gate.error.exceptionEntryHint,
      },
    });
  }
  // Only an exception actually used by this gate is consumed, in the business
  // transaction. A later transport/stock/audit failure rolls both writes back.
  const viaExceptions = gate.data.orders.filter(order => order.via === 'exception');
  if (viaExceptions.length) {
    const service = createExceptionService({ prisma: params.tx, approvalCreateService: createApprovalCreateService({
      prisma: params.tx, routingService: createApprovalRoutingService({ prisma: params.tx }),
    }) });
    for (const order of viaExceptions) {
      if (!order.exception?.id) throw Object.assign(new Error('出运例外缺少准确批准来源，未放行'), { code: 'GATE_BLOCKED', statusCode: 409 });
      const consumed = await service.consumeException({ exceptionId: order.exception.id, targetType: 'Order', targetId: order.orderId,
        action: 'shipment:release', consumedBy: params.actorId, tx: params.tx });
      if (!consumed.ok) throw Object.assign(new Error('出运例外当前不能核销，请刷新核对批准范围和可用次数'), { code: 'GATE_BLOCKED', statusCode: 409 });
    }
  }
  return gate.data;
}

// ─── CREATE ────────────────────────────────────────────────────────

import { nextBusinessNumber } from '../shared/businessNumberService';

export interface CreateShipmentParams {
  prisma: PrismaClient;
  input: any;
  actorId: string;
  actor?: TokenPayload | null;
  /** Internal handoff service only: business may create a scoped empty export draft. */
  businessHandoffDraft?: boolean;
  ip?: string | null;
  /** 外部事务：route/agent flow 在自己 $transaction 里调 service 时传入，共用同一事务 */
  tx?: any;
  /** audit source 默认 'route:shipping:create'；agent flow 传 'agent:order.ship:commit' */
  auditSource?: string;
  /** audit operation 默认 'create_shipment'；agent 传 'order_ship_committed' */
  auditOperation?: string;
  /** sync source 默认 'route:create'；agent 传 'agent:order.ship' */
  syncSource?: string;
  /** 上游未提供 id 时是否兜底生成（agent flow 需要 true；route 保持 false） */
  generateIdIfMissing?: boolean;
  /** 自定义 audit.after payload 生成器（agent flow 用） */
  auditAfterBuilder?: (sh: any, extras: { orderStatus: string | null; transactionId?: string }) => Record<string, unknown>;
  /** 传给 audit.after 的 transactionId（agent flow 用） */
  transactionId?: string;
  /** DR-013 例外查询器（出运放行门禁用）；缺省 → 无例外放行能力（fail-closed） */
  exceptionChecker?: ExceptionChecker | null;
}

export interface CreateShipmentData {
  shipment: any;
  orderStatus: string | null;
  auditId: string;
}

export async function createShipment(params: CreateShipmentParams): Promise<ShipmentMutationResult<CreateShipmentData>> {
  const {
    prisma, input, actorId, ip, tx,
    auditSource = 'route:shipping:create',
    auditOperation = 'create_shipment',
    syncSource = 'route:create',
    generateIdIfMissing = false,
    auditAfterBuilder,
    transactionId,
    exceptionChecker,
  } = params;

  if (hasMvpExcludedShipmentInsuranceFields(input)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: MVP_SHIPMENT_INSURANCE_MESSAGE } };
  }
  // status 合法枚举（fail closed，事务前）
  if (input?.status != null && !isValidShipmentStatus(String(input.status))) {
    return { ok: false, error: { code: 'INVALID_STATUS', message: `status must be one of: ${VALID_SHIPMENT_STATUSES.join(', ')}` } };
  }
  if (input?.status != null && !MVP_SHIPMENT_CREATE_STATUSES.includes(String(input.status))) {
    return { ok: false, error: { code: 'INVALID_INITIAL_STATUS', message: '当前 MVP 出运流程止于实际离港/起飞的“已出运”，不记录目的地到港、清关或交付状态。' } };
  }
  if (input?.status === 'Shipped') {
    const atdError = validateShipmentActualDeparture(input?.atd);
    if (atdError) return { ok: false, error: { code: 'VALIDATION_ERROR', message: atdError } };
    if (input?.type === 'Export') {
      return { ok: false, error: { code: 'GATE_BLOCKED', message: '出口运单须先建立草稿、登记系统外申报完成时间和凭证，再登记实际开船/起飞。' } };
    }
  }
  if (input?.eta != null || input?.ata != null) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: '当前 MVP 不记录目的地预计/实际到港时间；请只登记计划离港与实际离港信息。' } };
  }
  // DTO 前置校验（S3 走查 ε 车道）：空体/缺必填字段坠入事务撞 Prisma P2012 → 500（空体 POST 实锤），
  // 提前为 VALIDATION_ERROR（route 400）。校验集合 = 全部现存调用方共同契约的交集：
  // route（create 白名单含 shippingMethod）/ L2 事件联动（显式传 shippingMethod）/
  // agent orderShipFlow（toolRuntime 前置强制 shipment.shippingMethod）三方均保证 shippingMethod。
  // type 同为 schema 必填，但 agent draft 契约（OrderShipDraftInput.type 可选 + order.ship
  // inputSchema 未要求）不保证该字段——在服务层强制会收紧跨域契约，超出本车道租约；
  // 待 agent 域前置补齐 type 后，本校验集合可同标准扩入 type。
  const REQUIRED_CREATE_FIELDS = ['shippingMethod'] as const;
  const missingFields = REQUIRED_CREATE_FIELDS.filter((f) => input?.[f] === undefined || input?.[f] === null || input?.[f] === '');
  if (missingFields.length > 0) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `missing required fields: ${missingFields.join(', ')}` } };
  }
  // 当前 MVP 运输方式写入校验 + 归一；历史脏值仍可读，普通备注更新不回溯校验。
  //   ⓘ 只校验**本次写入的新值**，不回溯历史行 —— 否则改一条老票的备注都会被拒。
  //   ⓘ 海运/空运中文或常见别名会归一；陆运、铁路、快递、自提不属于当前 MVP 范围。
  const smCheck = auditSource.startsWith('claim:')
    ? coerceShippingMethodForWrite(input?.shippingMethod)
    : coerceMvpShippingMethodForWrite(input?.shippingMethod);
  if (!smCheck.ok) {
    return { ok: false, error: { code: 'INVALID_SHIPPING_METHOD', message: smCheck.message } };
  }

  // MVP 允许补录实际已出运票，但不允许新建取消态或历史到港/清关/交付态。
  // MVP 日期交叉校验：订舱日期不能晚于预计离港。
  const scheduleError = validateShipmentScheduleCross({
    bookingDate: input?.bookingDate ?? null,
    etd: input?.etd ?? null,
  });
  if (scheduleError) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: scheduleError } };
  }

  try {
    const result = await withTx(prisma, tx, async (t: any) => {
      const now = BigInt(Date.now());
      const shipmentStatus = input.status ?? 'Booked';
      // A standalone shipment has no Order scope, but still requires a live
      // stored account, shipments:write and the original signed ceiling.
      if (params.actor !== undefined) {
        if (params.businessHandoffDraft && (!tx || input.type !== 'Export' || input.status !== 'Draft' || input.orderId))
          throw businessError('FORBIDDEN', '业务交接仅可在来源已校验的事务内创建空白出口草稿。');
        const actor = await assertPhysicalShipmentWriteAuthority(t, params.actor, false,
          params.businessHandoffDraft ? 'orders:write' : 'shipments:write');
        if (actor.userId !== actorId) throw businessError('FORBIDDEN', '当前操作人身份与运单命令不一致。');
      }
      let physicalSource = false;
      if (input.orderId) {
        await lockReleaseSources(t, [String(input.orderId)]);
        physicalSource = await t.productionBatch.count({ where: { orderId: String(input.orderId) } }) > 0;
        if (physicalSource || params.actor !== undefined) {
          const actor = await assertPhysicalShipmentWriteAuthority(t, params.actor ?? null);
          if (actor.userId !== actorId) throw businessError('FORBIDDEN', '当前操作人身份与运单命令不一致。');
          const scope = await freshOrderLineScope(t, actor);
          if (!await t.order.findFirst({ where: { id: String(input.orderId), deletedAt: null, AND: [scope] }, select: { id: true } }))
            throw businessError('ORDER_NOT_FOUND', '来源订单不存在或不可查看。');
        }
        if (physicalSource && !['Draft', 'Booked', 'Loading'].includes(shipmentStatus))
          throw businessError('CONFLICT', '实际批次运单须先登记原分配和装箱，再执行发运；不能直接创建已发运记录。');
      }
      // Shipment.id 无数据库默认值，必须显式生成（route/agent 统一走此生成逻辑）
      const shipmentId = input?.id
        || `SHP__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      // PRD 5.6：服务端自动生成运单号（SH-YYYY-NNNN），传入时优先使用传入值
      // REQ2-20 期间实测发现的第四例序列落后占位（与 REQ2-12 第三例同类根因）：
      // BusinessSequence 缺 SEQ_SH_{year} 行而 Shipment 表已有 SH-YYYY-NNNN 直写行（迁移导入/序列重建）时
      // 生成号即撞唯一键（P2002 事务回滚）→ occupied 回调查目标表（含软删）自动追平到首个未占用号
      const shipmentNumber = input.shipmentNumber || await nextBusinessNumber(t, 'SH', undefined, {
        occupied: async (num) => {
          const dup = await t.shipment.findFirst({ where: { shipmentNumber: num }, select: { id: true } });
          return dup != null;
        },
      });
      const data: any = { ...input, shipmentNumber, status: shipmentStatus, createdAt: now, updatedAt: now };
      if (Object.prototype.hasOwnProperty.call(input, 'loadType')) data.loadType = normalizedLoadTypeForWrite(input.loadType);
      if (smCheck.value) data.shippingMethod = smCheck.value; // ★ C2 归一（别名/中文 → 枚举）
      // D8-Q3 品类下沉：businessLine 由锚定订单派生回填（显式传值优先；散货无订单保持 null）
      if (data.orderId && data.businessLine == null) {
        const anchorOrder = await t.order.findUnique({ where: { id: data.orderId }, select: { businessLine: true } });
        data.businessLine = anchorOrder?.businessLine ?? null;
      }
      if (shipmentId) data.id = shipmentId;

      // DR-012/014 出运放行门禁：直建 Shipped（补录场景）视同出运放行，须过资格判定
      // （create 时合票分配尚未建立，仅校验主订单；合票订单在 update → Shipped 时校验）
      if (shipmentStatus === 'Shipped') {
        await assertShipmentReleaseGateOrThrow({ tx: t, orderIds: [input.orderId], actorId, exceptionChecker });
      }

      const sh = await t.shipment.create({ data });

      // F3：首节点事件（创建即入时间轴，fromNode=null）
      await appendShipmentEvent(t, { shipmentId: sh.id, fromNode: null, toNode: sh.status, shipment: sh, actorId });

      // sync EntityReference / EntityLink
      await syncShipmentReferences(prisma, sh, { source: syncSource }, t);

      // order 状态联动（有 orderId 时）
      let orderStatus: string | null = null;
      if (sh.orderId) {
        const linkResult = await linkOrderStatusFromShipment(t, sh.orderId, sh.status, { operator: actorId, shipmentId: sh.id });
        if (linkResult.ok && !linkResult.skipped) {
          orderStatus = linkResult.toStatus || null;
        }

        // C4：建单首装——关联订单且订单有明细行时自动带出装运行
        // （同事务，映射口径与 pull-from-order 端点共用 mapOrderLinesToShipmentLineInputs）
        // 注意：createShipment 直建 Shipped 状态时，运单尚未持久化完成，需跳过状态检查
        const orderLines = await t.orderLine.findMany({ where: { orderId: sh.orderId }, orderBy: { lineNumber: 'asc' } });
        if (!physicalSource && orderLines.length > 0) {
          await replaceShipmentLinesTx(t, sh.id, mapOrderLinesToShipmentLineInputs(orderLines), actorId, ip, { skipStatusCheck: true, auditPrisma: prisma });
        }
      }

      // H9 出运扣库存：直建 Shipped（补录场景）与 update 流转至 Shipped 同口径；
      // 门禁已在上方同事务通过，扣失败整体回滚（运单不会被创建为已发运未扣账）
      if (shipmentStatus === 'Shipped') {
        await deductShipmentStockInTx(t, prisma, sh.id, shipmentNumber, actorId);
      }

      // Recheck supplied authority after native writes and before their audit.
      // A revocation during the transaction rolls back the whole creation.
      if (params.actor !== undefined) {
        const actor = await assertPhysicalShipmentWriteAuthority(t, params.actor, !!input.orderId,
          params.businessHandoffDraft ? 'orders:write' : 'shipments:write');
        if (actor.userId !== actorId) throw businessError('FORBIDDEN', '当前操作人身份与运单命令不一致。');
        if (input.orderId) {
          const scope = await freshOrderLineScope(t, actor);
          if (!await t.order.findFirst({ where: { id: String(input.orderId), deletedAt: null, AND: [scope] }, select: { id: true } }))
            throw businessError('ORDER_NOT_FOUND', '来源订单不存在或不可查看。');
        }
      }
      // AuditLog 同事务闭环
      const auditAfter = auditAfterBuilder
        ? auditAfterBuilder(sh, { orderStatus, transactionId })
        : { id: sh.id, shipmentNumber: sh.shipmentNumber, type: sh.type, status: sh.status };
      const auditId = await writeRouteAuditLog({
        prisma: t, actorId, source: auditSource,
        operation: auditOperation, targetType: 'Shipment', targetId: sh.id,
        after: auditAfter,
        ip: ip || null,
      });

      return { shipment: sh, orderStatus, auditId };
    });

    // Phase 0 Sprint 1: 发货单创建事件（事务提交后发布）
    // - ShipmentCreated：所有创建都发布
    // - ShipmentCompleted：状态直接为 Delivered 时发布（罕见但合法的补录场景）
    if (!tx || !auditSource.startsWith('claim:')) publishBusinessEvent({
      type: 'ShipmentCreated',
      sourceEntityType: 'Shipment',
      sourceEntityId: result.shipment.id,
      orderId: result.shipment.orderId,
      payload: {
        shipmentId: result.shipment.id,
        shipmentNumber: result.shipment.shipmentNumber,
        status: result.shipment.status,
        orderId: result.shipment.orderId,
      },
      actorId,
      transactionId: result.auditId,
    }).catch(() => { /* event publish failure must not fail business */ });

    if (result.shipment.status === 'Delivered') {
      publishBusinessEvent({
        type: 'ShipmentCompleted',
        sourceEntityType: 'Shipment',
        sourceEntityId: result.shipment.id,
        orderId: result.shipment.orderId,
        payload: {
          shipmentId: result.shipment.id,
          shipmentNumber: result.shipment.shipmentNumber,
          orderId: result.shipment.orderId,
        },
        actorId,
        transactionId: result.auditId,
      }).catch(() => { /* event publish failure must not fail business */ });
    }
    // W-B 断层④：直建 Shipped（补录场景）→ 自动推进挂接批次 planned→shipped（best-effort，不阻断创建结果）
    if (result.shipment.status === 'Shipped') {
      await createOrderShipmentBatchService(prisma).autoAdvanceOnShipmentShipped(result.shipment.id, actorId);
    }
    return { ok: true, data: result };
  } catch (e: any) {
    if (tx) throw e;
    return { ok: false, error: toMutationError(e, 'CREATE_FAILED') };
  }
}

function normalizedLoadTypeForWrite(value: unknown): string | null {
  if (value === null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'string' || !normalizeLoadType(value)) {
    throw businessError('VALIDATION_ERROR', '装载方式须为 FCL、LCL 或明确未录。');
  }
  return normalizeLoadType(value);
}

// ─── UPDATE ────────────────────────────────────────────────────────

export interface UpdateShipmentParams {
  prisma: PrismaClient;
  shipmentId: string;
  actor?: TokenPayload | null;
  physicalCommand?: PhysicalShipmentCommandInput;
  /** Internal-only handoff command capabilities. Public PATCH/Agent DTOs cannot set these. */
  handoffDepartureConfirmationId?: string;
  handoffCancellationId?: string;
  patch: any;
  hasStatus: boolean; // route 用 hasOwnProperty 判定
  actorId: string;
  ip?: string | null;
  tx?: any;
  auditSource?: string;
  syncSource?: string;
  /** DR-013 例外查询器（出运放行门禁用）；缺省 → 无例外放行能力（fail-closed） */
  exceptionChecker?: ExceptionChecker | null;
}

export async function updateShipment(params: UpdateShipmentParams): Promise<ShipmentMutationResult<{ shipment: any; orderStatus: string | null; auditId: string }>> {
  const { prisma, shipmentId, hasStatus, actorId, ip, tx, auditSource = 'route:shipping:update', syncSource = 'route:update', exceptionChecker } = params;
  if (hasMvpExcludedShipmentInsuranceFields(params.patch)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: MVP_SHIPMENT_INSURANCE_MESSAGE } };
  }
  // MVP 不跟踪目的地预计/实际到港；禁止内部调用方绕过 HTTP 字段白名单写入。
  const submittedPatch = physicalShipmentJson(params.patch);
  const patch: typeof params.patch = { ...params.patch };
  if ((patch as any).eta != null || (patch as any).ata != null) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: '当前 MVP 不记录目的地预计/实际到港时间；请只登记计划离港与实际离港信息。' } };
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'atd') && patch.atd != null) {
    const atdError = validateShipmentActualDeparture(patch.atd);
    if (atdError) return { ok: false, error: { code: 'VALIDATION_ERROR', message: atdError } };
  }
  // MVP 出运方式只允许海运/空运；售后处置专用来源保留其既有兼容规则。
  if (patch.shippingMethod !== undefined) {
    const smCheck = auditSource.startsWith('claim:')
      ? coerceShippingMethodForWrite(patch.shippingMethod)
      : coerceMvpShippingMethodForWrite(patch.shippingMethod);
    if (!smCheck.ok) {
      return { ok: false, error: { code: 'INVALID_SHIPPING_METHOD', message: smCheck.message } };
    }
    if (smCheck.value) patch.shippingMethod = smCheck.value;
  }
  try {
    if (Object.prototype.hasOwnProperty.call(patch, 'loadType')) patch.loadType = normalizedLoadTypeForWrite(patch.loadType);
    const result = await withTx(prisma, tx, async (t: any) => {
      const physicalContext = await lockShipmentPhysicalConsumer(t, { shipmentId, actor: params.actor,
        missingShipmentCode: 'SHIPMENT_NOT_FOUND',
        mode: patch.status === 'Cancelled' ? 'cancel' : patch.status === 'Shipped' ? 'ship' : 'edit' });
      const claim = physicalContext.kind === 'claim' ? await lockClaimShipmentSource(t, shipmentId) : null;
      let existing = claim?.shipment ?? physicalContext.shipment;
      const modern = physicalContext.kind === 'physical';
      if (modern && physicalContext.actor?.userId !== actorId) throw businessError('FORBIDDEN', '当前操作人身份与运单命令不一致。');
      const commandLease = modern ? await beginPhysicalShipmentCommand(t, physicalContext, submittedPatch, params.physicalCommand) : null;
      if (commandLease?.replay) return { ...commandLease.replay, fromStatus: existing.status, claimShipment: false, physicalShipment: true, replayed: true };
      const isHandoffDeparture = hasStatus && patch.status === 'Shipped' && existing.type === 'Export';
      const linkedHandoff = isHandoffDeparture || patch.status === 'Cancelled'
        ? await t.shipmentHandoff?.findUnique?.({ where: { shipmentId } }) ?? null : null;
      if (isHandoffDeparture) {
        if (!params.handoffDepartureConfirmationId || linkedHandoff?.id !== params.handoffDepartureConfirmationId
          || linkedHandoff.status !== 'ReturnedToBusiness')
          throw businessError('GATE_BLOCKED', '出口运单不能通过通用状态更新直接标记已出运；须完成后勤交接、业务登记当前 CI/PL 已发送，并从交接操作确认实际离港。');
        if (existing.status !== 'Booked' || patch.atd == null)
          throw businessError('GATE_BLOCKED', '确认实际出运须处于已订舱状态，并填写真实 ATD；ETD 或 Draft BL 不能代替实际离港事实。');
        await assertCurrentShipmentDocumentsSentInTx(t, shipmentId);
      }
      if (linkedHandoff && linkedHandoff.status !== 'Cancelled' && patch.status === 'Cancelled') {
        if (!params.handoffCancellationId || linkedHandoff.id !== params.handoffCancellationId
          || !['PendingLogistics', 'NeedsBusinessDecision'].includes(linkedHandoff.status))
          throw businessError('CONFLICT', '该运单受出运交接控制，不能通过通用取消接口取消；请在待处理的交接中执行取消。');
        if (existing.status !== 'Draft' || existing.atd != null)
          throw businessError('INVALID_STATE', '只有未订舱、未实际出运的出口草稿票可取消。');
        const externalFields = ['bookingDate', 'bookingNo', 'soNumber', 'spaceConfirmedAt', 'cutOffAt', 'docCutOffAt', 'etd',
          'vesselOrFlight', 'voyageNumber', 'portOfLoading', 'portOfDischarge', 'customsDeclarationNumber',
          'exportDeclarationCompletedAt', 'exportDeclarationReference', 'exportDeclarationEvidenceDocumentId'];
        if (externalFields.some(key => existing[key] !== null && existing[key] !== undefined && existing[key] !== ''))
          throw businessError('INVALID_STATE', '本票已有订舱、运输或出口申报事实，不能直接取消。');
        const issuedOrActiveDocs = await t.tradeDocument.findMany({ where: { shipmentId, domain: 'customs',
          type: { in: ['CommercialInvoice', 'PackingList'] }, status: { not: 'Cancelled' }, deletedAt: null }, select: { id: true } });
        if (issuedOrActiveDocs.length) throw businessError('INVALID_STATE', '本票已有 CI 或 Packing List 单据记录，不能直接取消。');
        const proof = await t.tradeDocument.findFirst({ where: { shipmentId, domain: 'customs', type: 'ExportDeclarationProof', deletedAt: null } });
        if (proof) throw businessError('INVALID_STATE', '本票已有出口申报凭证，不能直接取消。');
      }
      if (hasStatus && patch.status === 'Shipped' && existing.status !== 'Shipped') {
        const atdError = validateShipmentActualDeparture(patch.atd !== undefined ? patch.atd : existing.atd);
        if (atdError) throw Object.assign(new Error(atdError), { statusCode: 400, code: 'VALIDATION_ERROR' });
      }
      if (existing.status === 'Shipped' && Object.prototype.hasOwnProperty.call(patch, 'atd')) {
        const atdError = validateShipmentActualDeparture(patch.atd);
        if (atdError) throw Object.assign(new Error(atdError), { statusCode: 400, code: 'VALIDATION_ERROR' });
      }
      if (modern) for (const key of ['orderId', 'customerRelationId', 'customerName', 'type', 'businessLine']) {
        if (patch[key] !== undefined && patch[key] !== existing[key])
          throw businessError('CONFLICT', '实际批次运单的原订单和客户身份不能通过物流编辑改写。');
      }
      let releaseGate: any = null, stockMovements: any[] = [], factoryLoadings: any[] = [];
      let verifiedPhysical: Awaited<ReturnType<typeof validateReservedPhysicalShipment>> | null = null;
      if (claim) {
        existing = claim.shipment;
        for (const key of ['orderId', 'customerRelationId', 'customerName', 'type', 'businessLine']) {
          if (patch[key] !== undefined && patch[key] !== (existing as any)[key]) claimRefusal('售后运单的客户、来源与业务身份由真实处置绑定，不能通过物流编辑改写');
        }
        if (patch.status === 'Cancelled') claimRefusal('该售后运单由已执行处置产生，不能在货运页直接取消。请保留物流与库存记录，在原售后案件跟进后续处理。');
      }
      // P2 物流日期交叉校验：PATCH 只携带部分字段，与库中现存值合并后判定
      // （显式 null/undefined = 未改或清空，均视同缺省不参与交叉矛盾判定）
      const scheduleError = validateShipmentScheduleCross({
        bookingDate: patch.bookingDate !== undefined ? patch.bookingDate : existing.bookingDate,
        etd: patch.etd !== undefined ? patch.etd : existing.etd,
      });
      if (scheduleError) {
        throw Object.assign(new Error(scheduleError), { statusCode: 400, code: 'VALIDATION_ERROR' });
      }
      if (hasStatus) {
        const newStatus = patch.status;
        if (typeof newStatus !== 'string') {
          throw Object.assign(new Error('status must be a non-null string'), { statusCode: 400, code: 'INVALID_STATUS' });
        }
        const tCheck = validateStatusTransition('Shipment', existing.status, newStatus);
        if (!tCheck.ok) throw Object.assign(new Error(tCheck.message!), { statusCode: 400, code: tCheck.error! });
        // DR-012/014 出运放行门禁：流转至 Shipped（出运放行语义）时校验全部关联订单
        // （DR-016 合票：主订单 + ShipmentOrderAllocation 分配订单逐单校验；同状态幂等 patch 不重复校验）
        if (newStatus === 'Shipped' && existing.status !== 'Shipped') {
          await assertShipmentExportDeclarationProof(t, { ...existing, ...patch, id: shipmentId });
          const allocations = await t.shipmentOrderAllocation.findMany({ where: { shipmentId }, select: { orderId: true } });
          if (modern) {
            verifiedPhysical = await validateReservedPhysicalShipment(t, physicalContext, true);
            const lines = await t.shipmentLine.findMany({ where: { shipmentId }, orderBy: { lineNumber: 'asc' } });
            validatePhysicalPackingQuantities(physicalContext, lines, true);
          }
          // Handoff departure already revalidates the exact source branches via
          // the canonical per-family gate. Do not layer the legacy whole-order
          // Final-QC gate on top of it.
          if (!params.handoffDepartureConfirmationId) {
            releaseGate = await assertShipmentReleaseGateOrThrow({
              tx: t,
              orderIds: verifiedPhysical ? Object.keys(verifiedPhysical.physicalBatchIdsByOrder) : [existing.orderId, ...allocations.map((a: any) => a.orderId)],
              actorId, exceptionChecker,
              ...(verifiedPhysical ? { physicalBatchIdsByOrder: verifiedPhysical.physicalBatchIdsByOrder } : {}),
            });
          }
          /**
           * ★★ 2026-09-29 晚：**短装（少做）门禁 + 出运数量完整性门禁** —— 与上面的放行门禁同一处、同一事务。
           *   口径：只在该行**出运收尾**时判（该行没有其它"未取消且未发运"的票），
           *   分批出运时第一票必然少于合同量 ⇒ 这里**不判**，避免误拦（使用方 2026-09-29 拍）。
           *
           *   三个出口**必须分开**（顺序也是刻意的：先问"数据齐不齐"，再问"少不少"）：
           *     ① 本票一条明细都没有 / 明细里实际数量为空 ⇒ **事实还不清楚** ⇒ 拦，
           *        ★ **不发起审批单**：审批单解决不了"数量没填"，用它绕过等于把"不知道发了多少"
           *        洗成"客户同意少发"（使用方原话：「不存在不知道数量又要发起出运的情况」）。
           *     ② 少发且**没有**批准过的短装放行单 ⇒ 抛错拦住（带逐行明细）⇒ 由 catch 分支发起审批
           *     ③ 少发但**已有**批准 ⇒ 放行，并把该分配写 `ShortShipped` + `exception`（接上那个死状态）
           */
          // ★ D1（2026-09-30 补齐，矩阵 D1 拍板 2「运输方式驱动必填字段」）：发运前按
          //   shippingMethod（+loadType）校验必填 —— Sea 要船名航次、FCL 另要箱号封条、
          //   Air 要航班号且**不**要箱号、Courier 要跟踪号且**不**要港口、Land/Rail 要承运方与车号。
          //   ★ 时机刻意放在**发运**而非建单：草稿阶段允许先建后补，否则一条票都建不出来。
          //   ★ 方式无法识别 ⇒ 不校验（规则不自造），由 missingRequiredShipmentFields 返回空。
          const transport = { ...existing, ...patch };
          const transportMethod = normalizeShipMethod(transport.shippingMethod);
          const landTransport = transportMethod === 'Land' || transportMethod === 'Rail'
            ? await t.shipmentLandTransport.findUnique({ where: { shipmentId } }) : null;
          const fieldMiss = missingRequiredShipmentFields({
            shippingMethod: transport.shippingMethod,
            loadType: (transport as any).loadType ?? null,
            vesselOrFlight: transport.vesselOrFlight,
            voyageNumber: transport.voyageNumber,
            containerNumber: transport.containerNumber,
            sealNumber: transport.sealNumber,
            trackingNumber: transport.trackingNumber,
            carrierName: landTransport?.carrierName ?? transport.carrierName,
            portOfLoading: transport.portOfLoading,
            portOfDischarge: transport.portOfDischarge,
            vehicleNo: landTransport?.plateNo ?? null,
          });
          if (fieldMiss.length > 0) {
            throw Object.assign(
              new Error(
                `按运输方式（${transport.shippingMethod ?? '未录'}${normalizeLoadType((transport as any).loadType) ? ' / ' + normalizeLoadType((transport as any).loadType) : ''}）缺少必填字段：${fieldMiss.join('、')}。请补全后再确认出运。`,
              ),
              { code: 'SHIPMENT_FIELD_REQUIRED_MISSING', statusCode: 400, missingFields: fieldMiss },
            );
          }

          if (!claim) {
          const shortShip = await evaluateShortShipment(t, { shipmentId, physicalSource: modern,
            ...(modern && isHandoffDeparture ? { quantityBasis: 'native_production_facts' as const } : {}) });
          if (shortShip.noAllocationDetail) {
            throw noAllocationDetailError();
          }
          if (shortShip.unfilled.length) {
            throw actualQtyMissingError(shortShip.unfilled);
          }
          if (shortShip.blocked.length) {
            throw shortShipBlockedError(shortShip.blocked, buildShortShipBlockedMessage(shortShip.blocked));
          }
          if (shortShip.approved.length && !modern) {
            await markAllocationsShortShipped(t, { shipmentId, cases: shortShip.approved, actorId });
          }
          }
          // H9 出运扣库存：与门禁同事务（门禁过了才扣，扣失败整体回滚）
          if (modern && verifiedPhysical) {
            stockMovements = await deductPhysicalShipmentStockInTx(t, prisma, verifiedPhysical, actorId);
            factoryLoadings = physicalShipmentFactoryLoadings(verifiedPhysical);
            const shortShip = await evaluateShortShipment(t, { shipmentId, physicalSource: modern,
              ...(isHandoffDeparture ? { quantityBasis: 'native_production_facts' as const } : {}) });
            if (shortShip.approved.length) await markAllocationsShortShipped(t, { shipmentId, cases: shortShip.approved, actorId });
            for (const row of physicalContext.physical) {
              if (row.state !== 'reserved') throw businessError('CONFLICT', '本票物理预留状态已变化，请核对原记录。');
              await t.shipmentProductionAllocation.update({ where: { id: row.id }, data: {
                state: row.actualQty != null && new Prisma.Decimal(row.actualQty).gt(0) ? 'shipped' : 'released', updatedAt: BigInt(Date.now()) } });
            }
          } else await deductShipmentStockInTx(t, prisma, shipmentId, existing.shipmentNumber, actorId);
        }
        // H9 取消回冲：已扣账状态（Shipped 及之后）流转至 Cancelled → 按原流水反向入库
        if (newStatus === 'Cancelled' && STOCK_DEDUCTED_STATUSES.has(existing.status)) {
          if (modern) {
            const original = await originalPhysicalShipmentDispatch(t, physicalContext);
            stockMovements = await reversePhysicalShipmentStockInTx(t, prisma, physicalContext, original, actorId);
            factoryLoadings = original.factoryLoadings ?? [];
          } else await reverseShipmentStockInTx(t, prisma, shipmentId, existing.shipmentNumber, actorId);
        }
      }
      if (modern && patch.status === 'Cancelled' && existing.status !== 'Cancelled') {
        await invalidateFinancialShipmentSourceInTx(t, shipmentId, actorId, commandLease!.commandHash);
        if (!STOCK_DEDUCTED_STATUSES.has(existing.status)) {
          for (const allocation of physicalContext.allocations) {
            const projections = physicalContext.physical.filter(row => row.allocationId === allocation.id);
            if (projections.length) await validatePhysicalAllocationVersion(t, allocation, projections);
          }
          if (await t.stockMovement.count({ where: { referenceType: 'Shipment', referenceId: shipmentId, type: { in: ['Outbound', 'Inbound'] } } }))
            throw businessError('CONFLICT', '未发运运单已有未解释的库存流水，不能推测取消。');
        }
        for (const row of physicalContext.physical) {
          if (!['reserved', 'shipped', 'released'].includes(row.state)) throw businessError('CONFLICT', '原物理分配已有其他处理，请核对原执行。');
          await t.shipmentProductionAllocation.update({ where: { id: row.id }, data: {
            state: row.state === 'shipped' ? 'reversed' : 'released', updatedAt: BigInt(Date.now()) } });
        }
      }
      if (modern && hasStatus && patch.status === existing.status && ['Shipped', 'Cancelled'].includes(existing.status))
        throw businessError('CONFLICT', '该发运或取消已有执行事实，请重试原请求键。');
      const declarationPatchKeys = ['exportDeclarationCompletedAt', 'exportDeclarationReference', 'exportDeclarationEvidenceDocumentId'];
      if (declarationPatchKeys.some(key => Object.prototype.hasOwnProperty.call(patch, key))) {
        if (existing.type !== 'Export') throw businessError('VALIDATION_ERROR', '只有出口运单可以登记出口申报完成信息。');
        if (existing.status === 'Shipped') throw businessError('CONFLICT', '实际开船/起飞后不可改写出口申报完成事实；如需更正，请追加外部单据归档版本并保留审计记录。');
        const completedAt = normalizeExportDeclarationCompletedAt(patch.exportDeclarationCompletedAt ?? existing.exportDeclarationCompletedAt);
        const evidenceDocumentId = patch.exportDeclarationEvidenceDocumentId ?? existing.exportDeclarationEvidenceDocumentId;
        if (!completedAt || typeof evidenceDocumentId !== 'string' || !evidenceDocumentId.trim()) {
          throw businessError('VALIDATION_ERROR', '登记出口申报完成时，完成时间和已归档的本运单申报凭证均为必填。');
        }
        patch.exportDeclarationCompletedAt = completedAt;
        patch.exportDeclarationEvidenceDocumentId = evidenceDocumentId.trim();
        await assertShipmentExportDeclarationProof(t, { ...existing, ...patch, id: shipmentId });
      }
      const now = modern && BigInt(Date.now()) <= existing.updatedAt ? existing.updatedAt + BigInt(1) : BigInt(Date.now());
      const upd = await t.shipment.update({ where: { id: shipmentId }, data: { ...patch, updatedAt: now } });
      if (claim && hasStatus && upd.status === 'Shipped' && existing.status !== 'Shipped') await finalizeClaimShipmentInTx(t, claim, actorId);
      // F3：状态实际变更时落节点事件（同事务；同状态幂等 patch 不落事件）
      if (hasStatus && existing.status !== upd.status) {
        await appendShipmentEvent(t, { shipmentId: upd.id, fromNode: existing.status, toNode: upd.status, shipment: upd, note: upd.notes ?? null, actorId });
      }
      await syncShipmentReferences(prisma, upd, { source: syncSource }, t);
      let orderStatus: string | null = null;
      // ★ A5：取消时要把**合票的其它订单**一起回退 —— 否则整票取消、货全回库，
      //   只有主订单退回，合票订单仍卡在「出运中」（同一类「改一处、其余不动」）。
      //   ⓘ 正向联动仍只联动主订单（既有行为，不在 A5 范围内），此处回退按全量订单做，
      //     对未被正向联动过的订单是 no-op（status 不是 Shipping 会被跳过）。
      const rollbackOrderIds: string[] = upd.status === 'Cancelled'
        ? [...new Set([
            upd.orderId,
            ...(await t.shipmentOrderAllocation.findMany({ where: { shipmentId }, select: { orderId: true } }))
              .map((a: any) => a.orderId),
          ])].filter(Boolean) as string[]
        : [upd.orderId].filter(Boolean) as string[];
      for (const oid of rollbackOrderIds) {
        const linkResult = await linkOrderStatusFromShipment(t, oid, upd.status, { operator: actorId, shipmentId: upd.id });
        if (linkResult.ok && !linkResult.skipped) orderStatus = linkResult.toStatus || null;
      }
      // ★ C3：票状态变化会影响「哪些票算数」⇒ 关联订单的行已出运量快照必须重算。
      //   只有 **→ Cancelled** 会改变累计（Booked→Shipped 两侧都算数，重算等于空跑）。
      //   ⓘ 只对**有出运分配**的订单刷新：票的 `orderId` 投影可能是建单时带的，
      //     该订单若从未走过分配，它的手工台账值不该被票状态清零（语义边界，见真源头注释）。
      if (upd.status === 'Cancelled') {
        const allocatedOrderIds = [...new Set(
          (await t.shipmentOrderAllocation.findMany({ where: { shipmentId }, select: { orderId: true } }))
            .map((a: any) => a.orderId),
        )].filter(Boolean) as string[];
        for (const oid of allocatedOrderIds) {
          await syncOrderLineShipmentQuantity(t, oid);
        }
      }
      const auditId = await writeRouteAuditLog({
        prisma: t, actorId, source: auditSource,
        operation: 'update_shipment', targetType: 'Shipment', targetId: upd.id,
        before: { status: existing.status, shipmentNumber: existing.shipmentNumber },
        after: { status: upd.status, shipmentNumber: upd.shipmentNumber },
        ip: ip || null,
      });

      // ★★ D5（2026-09-18）：**逐字段**留痕 —— 原审计只记 status+shipmentNumber，
      //   ⇒ 改 ETD/ETA（甩柜/改船期）、改船名航次、改装卸港、改柜号封条**全都查不到改了什么**。
      //   复用字段级审计真源（AuditLog.fieldPath/beforeValue/afterValue），**零 migration**：
      //   改期历史 = 查这些字段级记录（见 getShipmentScheduleHistory）。
      //   ⓘ 不塞 ShipmentEvent：该表语义是**节点事件**（toNode = 运单状态），改期不是节点。
      await writeFieldAuditDiff({
        prisma: t, actorId, source: auditSource,
        operation: 'update_shipment_field', targetType: 'Shipment', targetId: upd.id,
        // 空串 → null 归一（否则「清空某字段」会留下 `— → —` 的噪音留痕）
        before: normalizeScheduleSnapshot(existing as unknown as Record<string, unknown>),
        after: normalizeScheduleSnapshot(upd as unknown as Record<string, unknown>),
        trackedFields: SHIPMENT_TRACKED_FIELD_KEYS,
        operationType: 'update',
        transactionId: auditId,
        ip: ip || null,
      }).catch(() => { /* 字段级留痕失败不阻断主流程（汇总审计已在上面落库） */ });

      if (!claim && upd.status === 'Delivered' && existing.status !== 'Delivered') {
        await persistBusinessEventInTransaction(t, {
          id: `bev_ShipmentCompleted_${auditId}`, type: 'ShipmentCompleted', sourceEntityType: 'Shipment',
          sourceEntityId: upd.id, orderId: upd.orderId || undefined,
          payload: { shipmentId: upd.id, shipmentNumber: upd.shipmentNumber, orderId: upd.orderId, fromStatus: existing.status },
          actorId, transactionId: auditId, occurredAt: Number(upd.updatedAt),
        });
      }
      const result = { shipment: upd, orderStatus, auditId, fromStatus: existing.status, claimShipment: Boolean(claim), physicalShipment: modern, replayed: false };
      if (commandLease) {
        const physicalAllocations = await t.shipmentProductionAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } });
        const allocations = await t.shipmentOrderAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } });
        const acknowledgement = await finishPhysicalShipmentCommand(t, commandLease, result, { stockMovements, factoryLoadings, physicalAllocations, allocations,
          shipmentBefore: existing, shipmentAfter: upd, releaseGate }, ip);
        return physicalShipmentJson({ ...result, acknowledgement });
      }
      return result;
    });

    // Phase 0 Sprint 1: 发货单状态变更事件（事务提交后发布）
    // - ShipmentStatusChanged：所有状态变更都发布
    // - ShipmentCompleted：状态变为 Delivered 时发布（用于 Phase 1 Sprint 3 触发开票联动）
    if (!result.replayed && !tx && hasStatus && result.fromStatus !== result.shipment.status) {
      publishBusinessEvent({
        type: 'ShipmentStatusChanged',
        sourceEntityType: 'Shipment',
        sourceEntityId: result.shipment.id,
        orderId: result.shipment.orderId,
        payload: {
          shipmentId: result.shipment.id,
          shipmentNumber: result.shipment.shipmentNumber,
          fromStatus: result.fromStatus,
          toStatus: result.shipment.status,
          orderId: result.shipment.orderId,
        },
        actorId,
        transactionId: result.auditId,
      }).catch(() => { /* event publish failure must not fail business */ });

      if (!result.claimShipment && result.shipment.status === 'Delivered' && result.fromStatus !== 'Delivered') {
        publishBusinessEvent({
          type: 'ShipmentCompleted',
          eventId: `bev_ShipmentCompleted_${result.auditId}`,
          occurredAt: Number(result.shipment.updatedAt),
          sourceEntityType: 'Shipment',
          sourceEntityId: result.shipment.id,
          orderId: result.shipment.orderId,
          payload: {
            shipmentId: result.shipment.id,
            shipmentNumber: result.shipment.shipmentNumber,
            orderId: result.shipment.orderId,
            fromStatus: result.fromStatus,
          },
          actorId,
          transactionId: result.auditId,
        }).catch(() => { /* event publish failure must not fail business */ });
      }
    }
    // W-B 断层④：流转至 Shipped → 自动推进挂接批次 planned→shipped（同状态幂等 patch 不重复触发；best-effort 不阻断更新结果）
    if (!result.replayed && !result.claimShipment && !result.physicalShipment && hasStatus && result.shipment.status === 'Shipped' && result.fromStatus !== 'Shipped') {
      await createOrderShipmentBatchService(prisma).autoAdvanceOnShipmentShipped(result.shipment.id, actorId);
    }
    return { ok: true, data: result };
  } catch (e: any) {
    /**
     * ★★ 短装拦截的收尾（D83）：**审批单必须在事务之外创建**。
     *   事务里的写会被这次抛错一起回滚带走 ⇒ 屏幕上那句"已为你发起短装确认单"就成了假话
     *   （B50-1b 已栽过一次：阻断时写的审批单放进事务 = 屏幕上说发起了、库里没有）。
     *   ★ 发起失败**不等于放行**：仍然返回被挡，只把失败原因一并告诉业务员。
     */
    if (tx) throw e;
    const shortShipDetails = (e as Partial<ShipmentMutationError> | null)?.shortShipDetails;
    if (e?.code === SHORT_SHIP_BLOCKED_CODE && isBusinessError(e) && Array.isArray(shortShipDetails?.blocked) && shortShipDetails.blocked.length) {
      const approval = await requestShortShipApproval(prisma, {
        actorId,
        shipmentId,
        blocked: shortShipDetails.blocked,
      });
      /**
       * ★★ 对外文案**不许拼内部异常原文**（本仓 `serviceMessageWrapRatchet` 会当场咬 —— 本批真被咬了一次）。
       *   审批发起失败的原始原因已经在 `requestShortShipApproval` 里 `logger.error` 落服务端日志 ⇒
       *   上屏只说"失败了 + 下一步找谁"，不说内部细节（何况它可能带码/字段名）。
       */
      const hint = approval.approvalRequestIds.length
        ? `已为你发起短装确认单（${approval.approvalRequestIds.join('、')}）：把客户同意少发的凭据附上，审批通过后再确认出运`
        : '短装确认单**发起失败**（原因已记入服务端日志）：多半是组织归属里还没配审批人，请联系管理员核对后再确认出运';
      const err = toMutationError(e, 'UPDATE_FAILED');
      /**
       * ⓘ 这里拼的是**领域文案**（短装事实 + 下一步），不是内部异常原文；
       *   但仍然**不把 `.message` 内插进对外字段** —— 本仓 `serviceMessageWrapRatchet` 是文本启发式，
       *   分不清"领域文案"与"Prisma 原文"，写了就会把本文件记成"拼原文"（本批真被咬了一次）。
       */
      const composedMessage = `${err.message}。${hint}`;
      return {
        ok: false,
        error: {
          ...err,
          message: composedMessage,
          shortShipDetails: {
            ...shortShipDetails,
            approvalRequestIds: approval.approvalRequestIds,
            ...(approval.approvalError === undefined ? {} : {
              approvalError: '短装确认单发起失败，原因已记入服务端日志；请联系管理员核对后重试。',
            }),
          },
        },
      };
    }
    return { ok: false, error: toMutationError(e, tx ? 'COMMIT_TRANSACTION_FAILED' : 'UPDATE_FAILED') };
  }
}

// ─── DELETE (soft) ─────────────────────────────────────────────────

export interface DeleteShipmentParams {
  prisma: PrismaClient;
  shipmentId: string;
  actorId: string;
  actor?: TokenPayload | null;
  ip?: string | null;
  tx?: any;
  auditSource?: string;
}

export async function deleteShipment(params: DeleteShipmentParams): Promise<ShipmentMutationResult<{ shipment: any; auditId: string }>> {
  const { prisma, shipmentId, actorId, ip, tx, auditSource = 'route:shipping:delete' } = params;
  try {
    const result = await withTx(prisma, tx, async (t: any) => {
      const context = await lockShipmentPhysicalConsumer(t, { shipmentId, actor: params.actor, mode: 'edit' });
      const existing = context.shipment;
      if (typeof t.shipmentHandoff?.findUnique === 'function'
        && await t.shipmentHandoff.findUnique({ where: { shipmentId } }))
        throw businessError('CONFLICT', '关联出运交接及其审计不可删除；请按交接取消流程处理。');
      if (context.kind === 'claim') claimRefusal('售后运单须保留原处置和物流历史，不能从货运页删除。');
      if (context.kind === 'physical' && existing.status !== 'Cancelled' && context.physical.length)
        throw businessError('CONFLICT', '本票已有物理预留，请先通过取消释放原分配后再删除。');
      if (!existing) throw Object.assign(new Error('shipment not found'), { statusCode: 404, code: 'NOT_FOUND' });
      // 仅 Draft/Booked/Cancelled 状态可删除（Draft/Booked 未发货可直接删，Cancelled 已走取消流程）
      // Loading 及之后状态（在途/已交付）应走取消流程而非物理删除
      const DELETABLE_STATUSES = new Set(['Draft', 'Booked', 'Cancelled']);
      if (!DELETABLE_STATUSES.has(existing.status)) {
        throw Object.assign(new Error(`cannot delete shipment with status=${existing.status}; cancel it first`), { code: 'INVALID_STATUS', statusCode: 400 });
      }
      // ★ B4（2026-09-18 零基础障碍清单）：已开票运单禁止删除。
      //   开票锚点链：InvoiceOrderAllocation.batchId → OrderShipmentBatch.shipmentId
      //   （P0-1 分批开票把发票金额锚在批次上）。旧删除只查状态 ⇒ 能删掉已开票的运单，
      //   发票的数量/批次依据随之悬空（与订单侧 deleteOrder HAS_DEPENDENTS 不对称）。
      //   有真实财务事实 ⇒ 必须先处置发票（作废/调整），不能静默删单。
      const batches = await t.orderShipmentBatch.findMany({ where: { shipmentId }, select: { id: true } });
      if (batches.length) {
        const invoicedCount = await t.invoiceOrderAllocation.count({
          where: { batchId: { in: batches.map((b: any) => b.id) }, deletedAt: null },
        });
        if (invoicedCount > 0) {
          throw Object.assign(
            new Error(`运单关联的出运批次已有 ${invoicedCount} 条开票分摊，禁止删除 —— 请先作废或调整对应发票`),
            { code: 'INVOICE_LINKED', statusCode: 409 },
          );
        }
      }
      // ★ C3：软删前先取**有出运分配**的订单（删后该票不再计入累计 ⇒ 行已出运量快照要降）。
      //   只取分配来源，不用 Shipment.orderId 投影（理由同上：不误清手工台账）。
      const allocOrderIds: Array<{ orderId: string }> =
        await t.shipmentOrderAllocation.findMany({ where: { shipmentId }, select: { orderId: true } });
      const linkedOrderIds = [...new Set(allocOrderIds.map(a => a.orderId))].filter(Boolean) as string[];

      const now = BigInt(Date.now());
      const del = await t.shipment.update({ where: { id: shipmentId }, data: { deletedAt: now, updatedAt: now } });
      await deactivateEntityLinks(t, 'shipment', shipmentId, now);
      for (const oid of linkedOrderIds) {
        await syncOrderLineShipmentQuantity(t, oid);
      }
      const auditId = await writeRouteAuditLog({
        prisma: t, actorId, source: auditSource,
        operation: 'delete_shipment', targetType: 'Shipment', targetId: del.id,
        before: { id: del.id, shipmentNumber: existing.shipmentNumber, status: existing.status },
        ip: ip || null,
      });
      return { shipment: del, auditId };
    });
    // R6 通知治理：删除运单后回收指向它的通知（best-effort，不影响删除结果）
    sweepNotificationsForDeletedEntities(prisma, [shipmentId]).catch(() => {});
    return { ok: true, data: result };
  } catch (e: any) {
    if (tx) throw e;
    return { ok: false, error: toMutationError(e, 'DELETE_FAILED') };
  }
}
