import { businessNowDate } from '../shared/businessClock';
/**
 * internalTransferService.ts — DR-033 内部供料单 + DR-005 内部面料交易核算服务（Track G 唯一入口）
 *
 * 设计真源：
 *   - docs/design/10-评审与决策/2026-08-16-设计评审决策记录.md DR-005 / DR-033 / DR-006 / DR-007
 *   - docs/design/02-数据模型/实体关系总览.md §6.4（L-15~L-19 跨组联动）
 *   - docs/design/04-模块设计/05-财务与结算/订单利润表生成.md §2.3（DR-005 利润口径）
 *
 * 铁律（fail-closed）：
 *   1. 由服装部基于服装订单发起；必填申请部门/供料部门/关联服装订单与面料订单/物料/数量/内部结算价/交期
 *   2. 面料订单必须 isInternalFabricTrade=true（DR-005 标记纪律），否则拒绝关联
 *   3. 内部结算价必须经 approvalCreateService.createBusinessApproval 审批链（DR-006/DR-007），
 *      审批单 status !== 'approved' 时内部供料单不得生效（SETTLEMENT_PRICE_NOT_APPROVED）
 *   4. 生效门槛：面料部确认数量+交期+已批准内部结算价 → Effective；
 *      生效后回写双方 OrderLine.internalTransferPrice（服装部成本依据 / 面料部收入依据），双向关联、各自独立核算
 *   5. 实际交付进入面料订单既有出运状态机：registerDelivery 仅关联面料订单名下非 Cancelled 运单，
 *      不另造平行出库流程；每笔出运关联内部供料分配 → 回写服装订单行面料到货数量/日期/状态；
 *      支持分批出运/分批到货/差异追溯；只产生内部交付单+装箱明细数据，不生成对外商业发票
 *   6. 状态机 Draft → PendingConfirm → Effective → Delivering → Closed（+Cancelled），守卫 fail-closed
 *
 * schema 冻结权衡（显式标记）：
 *   OrderInternalTransfer 为 Phase 0 最小模型（无 status/quantity/dueDate 等列），本任务禁止改 schema.prisma。
 *   DR-033 扩展单据内容以类型化 JSON 存于 memo 字符串列（docType='DR033_INTERNAL_FABRIC_SUPPLY' 标记），
 *   由 encode/decodeInternalTransferPayload 唯一编解码。
 *   TODO(schema)：schema 解冻后应将 payload 字段提升为正式列/独立模型（InternalSupplyOrder），
 *   届时列表的状态过滤可下推至 SQL（当前在内存过滤，见 listInternalTransfers 注释）。
 *
 * 双向记录拓扑（@@unique([orderId, transferDirection])）：
 *   - master：orderId=服装订单, direction=incoming（我方买入）——单据真源，payload 权威
 *   - mirror：orderId=面料订单, direction=outgoing（我方卖出）——镜像指针，status/金额随 master 同步
 *   合并抵销仅取单边（incoming=内部采购=outgoing=内部销售），禁止双边重复计入（见 reportService）。
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { logger } from '../lib/logger';
import { writeRouteAuditLog } from '../audit/routeAudit';
import type { ApprovalCreateService } from '../approvals/approvalCreateService';
import { statusFromError } from '../shared/bizStatus';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope, legacyAgentRoleForId } from '../auth/permissionService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { todayLocalKey } from '../shared/localDate';


// ───────────────────────────────────────────────────────────────────
// 错误码（全部 fail-closed）
// ───────────────────────────────────────────────────────────────────
export const INTERNAL_TRANSFER_ERRORS = {
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  GARMENT_ORDER_NOT_FOUND: 'GARMENT_ORDER_NOT_FOUND',
  FABRIC_ORDER_NOT_FOUND: 'FABRIC_ORDER_NOT_FOUND',
  FABRIC_ORDER_NOT_INTERNAL_TRADE: 'FABRIC_ORDER_NOT_INTERNAL_TRADE',
  GARMENT_ORDER_INTERNAL_CONFLICT: 'GARMENT_ORDER_INTERNAL_CONFLICT',
  SAME_ORDER_CONFLICT: 'SAME_ORDER_CONFLICT',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  INVALID_SETTLEMENT_PRICE: 'INVALID_SETTLEMENT_PRICE',
  INVALID_DUE_DATE: 'INVALID_DUE_DATE',
  TRANSFER_ALREADY_EXISTS: 'TRANSFER_ALREADY_EXISTS',
  TRANSFER_NOT_FOUND: 'TRANSFER_NOT_FOUND',
  INVALID_TRANSFER_STATE: 'INVALID_TRANSFER_STATE',
  SETTLEMENT_PRICE_NOT_APPROVED: 'SETTLEMENT_PRICE_NOT_APPROVED',
  SHIPMENT_NOT_FOUND: 'SHIPMENT_NOT_FOUND',
  SHIPMENT_NOT_OF_FABRIC_ORDER: 'SHIPMENT_NOT_OF_FABRIC_ORDER',
  INVALID_DELIVERY_QUANTITY: 'INVALID_DELIVERY_QUANTITY',
  OVER_DELIVERY: 'OVER_DELIVERY',
  NO_REVIEWER_RESOLVED: 'NO_REVIEWER_RESOLVED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type InternalTransferErrorCode =
  (typeof INTERNAL_TRANSFER_ERRORS)[keyof typeof INTERNAL_TRANSFER_ERRORS];

export type InternalTransferResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: InternalTransferErrorCode | string; message: string; statusCode: number } };

// ───────────────────────────────────────────────────────────────────
// 状态机（fail-closed 守卫）
// ───────────────────────────────────────────────────────────────────
export const INTERNAL_TRANSFER_STATUSES = [
  'Draft',
  'PendingConfirm',
  'Effective',
  'Delivering',
  'Closed',
  'Cancelled',
] as const;
export type InternalTransferStatus = (typeof INTERNAL_TRANSFER_STATUSES)[number];

/** 允许的状态迁移矩阵（不在矩阵内一律拒绝） */
const ALLOWED_TRANSITIONS: Record<InternalTransferStatus, readonly InternalTransferStatus[]> = {
  Draft: ['PendingConfirm', 'Cancelled'],
  PendingConfirm: ['Effective', 'Cancelled'],
  Effective: ['Delivering', 'Closed'],
  Delivering: ['Closed'],
  Closed: [],
  Cancelled: [],
};

/** 计入核算（服装部成本 / 面料部收入 / 合并抵销）的生效状态集合 */
export const INTERNAL_TRANSFER_ACCOUNTING_STATUSES: readonly InternalTransferStatus[] = [
  'Effective',
  'Delivering',
  'Closed',
];

// ───────────────────────────────────────────────────────────────────
// DR-033 扩展载荷（memo JSON，schema 冻结期载体）
// ───────────────────────────────────────────────────────────────────
export interface InternalTransferPackingLine {
  cartonNo: string;
  quantity: number;
  grossWeight?: number;
  netWeight?: number;
}

export interface InternalTransferDelivery {
  id: string;
  shipmentId: string;
  shipmentNumber: string | null;
  quantity: number;
  deliveryDate: string; // YYYY-MM-DD
  receivedQuantity: number | null;
  receivedDate: string | null;
  /** 差异 = 到货 − 出运（null = 尚未登记到货） */
  variance: number | null;
  packingLines: InternalTransferPackingLine[];
  registeredBy: string;
  registeredAt: string; // ISO
  allocationId?: string;
  unit?: string;
  auditId?: string;
  requestKey?: string;
  requestFingerprint?: string;
}

export interface InternalTransferReceipt {
  id: string; deliveryId: string; quantity: number; receivedDate: string;
  actorId: string; auditId: string; requestKey: string; requestFingerprint: string;
}

export interface InternalTransferHistoryEntry {
  from: InternalTransferStatus | null;
  to: InternalTransferStatus;
  actorId: string;
  at: string; // ISO
  note?: string;
}

export interface InternalTransferPayload {
  docType: 'DR033_INTERNAL_FABRIC_SUPPLY';
  /** master=服装订单侧 incoming（权威）；mirror=面料订单侧 outgoing（镜像） */
  role: 'master' | 'mirror';
  masterId: string;
  mirrorId: string | null;
  requestDepartmentId: string; // 申请部门（服装部）
  supplyDepartmentId: string; // 供料部门（面料部）
  garmentOrderId: string;
  fabricOrderId: string;
  materialCode: string;
  quantity: number;
  unit: string;
  settlementPrice: number; // 内部结算价（单价，CNY）
  settlementApprovalId: string; // DR-006 结算价审批单 ID
  dueDate: string; // 交期 YYYY-MM-DD
  status: InternalTransferStatus;
  confirmedQuantity: number | null;
  confirmedDueDate: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  deliveries: InternalTransferDelivery[];
  history: InternalTransferHistoryEntry[];
  memo?: string;
  schemaVersion?: 2;
  garmentOrderLineId?: string;
  fabricOrderLineId?: string;
  priceContent?: Record<string, unknown>;
  contentFingerprint?: string;
  confirmationAuditId?: string;
  receipts?: InternalTransferReceipt[];
  priceRevision?: number;
  priceRevisions?: InternalTransferPriceRevision[];
}

export interface InternalTransferPriceRevision {
  revision: number; approvalRequestId: string; contentFingerprint: string;
  previousApprovalId: string; previousContentFingerprint: string;
  previousContent: Record<string, unknown>; previousApproval: Record<string, unknown>; previousApprovalAuditIds: string[];
  actorId: string; at: string; auditId: string;
  requestId: string; requestKey: string; requestFingerprint: string;
  command: { expectedContentFingerprint: string; quantity: number; settlementPrice: number; dueDate: string; reason: string };
}
export interface ReviseInternalTransferPriceInput {
  id: string; actorId: string; trustedActor?: TokenPayload; requestId: string;
  expectedContentFingerprint: string; quantity: number; settlementPrice: number; dueDate: string; reason: string;
}
const priceRevisionFact = ({ auditId: _auditId, ...fact }: InternalTransferPriceRevision) => fact;
const priceRevisionAck = (revision: InternalTransferPriceRevision, replayed: boolean) => ({ revision: revision.revision,
  approvalRequestId: revision.approvalRequestId, contentFingerprint: revision.contentFingerprint,
  previousApprovalId: revision.previousApprovalId, previousContentFingerprint: revision.previousContentFingerprint,
  requestId: revision.requestId, requestKey: revision.requestKey, requestFingerprint: revision.requestFingerprint, auditId: revision.auditId, replayed });

/** Native facts use persisted content and exact IDs, never a display role name. */
export function internalTransferFingerprint(value: unknown): string {
  const canonical = (item: any): any => item == null ? null : typeof item === 'bigint' ? item.toString()
    : item instanceof Date ? item.toISOString() : Prisma.Decimal.isDecimal(item) ? item.toString()
    : Array.isArray(item) ? item.map(canonical) : typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const lineFact = (line: any) => ({ id: line.id, orderId: line.orderId, materialCode: line.materialCode, unit: line.unit ?? null, quantity: String(line.quantity) });
const confirmationFact = (payload: InternalTransferPayload, amount: unknown) => ({ status: 'Effective', masterId: payload.masterId, mirrorId: payload.mirrorId,
  garmentOrderLineId: payload.garmentOrderLineId, fabricOrderLineId: payload.fabricOrderLineId,
  confirmedQuantity: payload.confirmedQuantity, confirmedDueDate: payload.confirmedDueDate,
  transferAmount: String(amount), contentFingerprint: payload.contentFingerprint, settlementApprovalId: payload.settlementApprovalId });
const deliveryFact = (delivery: InternalTransferDelivery) => ({ deliveryId: delivery.id, shipmentId: delivery.shipmentId, allocationId: delivery.allocationId,
  quantity: delivery.quantity, unit: delivery.unit, deliveryDate: delivery.deliveryDate, requestKey: delivery.requestKey, requestFingerprint: delivery.requestFingerprint });
const receiptFact = (receipt: InternalTransferReceipt) => ({ receiptId: receipt.id, deliveryId: receipt.deliveryId, quantity: receipt.quantity,
  receivedDate: receipt.receivedDate, actorId: receipt.actorId, requestKey: receipt.requestKey, requestFingerprint: receipt.requestFingerprint });
async function assertNativeAudit(db: any, id: string | undefined, actorId: string | null | undefined, action: string, targetId: string, after: unknown) {
  const audit = id && await db.auditLog.findUnique({ where: { id } });
  if (!audit || audit.actorId !== actorId || audit.action !== action || audit.targetType !== 'OrderInternalTransfer' || audit.targetId !== targetId
      || internalTransferFingerprint(audit.detail?.after) !== internalTransferFingerprint(after)) throw businessError('INVALID_COST_SOURCE', '内部供料事实缺少完整匹配的必需审计');
  return audit;
}
async function assertNativePriceApproval(db: any, payload: InternalTransferPayload) {
  if (payload.schemaVersion !== 2 || !payload.garmentOrderLineId || !payload.fabricOrderLineId || !payload.priceContent || !payload.contentFingerprint)
    throw businessError('INVALID_COST_SOURCE', '内部供料单缺少冻结的双方订单行与价格版本，请重新提交');
  const lines = await db.orderLine.findMany({ where: { id: { in: [payload.garmentOrderLineId, payload.fabricOrderLineId] } } });
  const garmentLine = lines.find((line: any) => line.id === payload.garmentOrderLineId && line.orderId === payload.garmentOrderId);
  const fabricLine = lines.find((line: any) => line.id === payload.fabricOrderLineId && line.orderId === payload.fabricOrderId);
  const content: any = payload.priceContent;
  if (!garmentLine || !fabricLine || internalTransferFingerprint(content.garmentLine) !== internalTransferFingerprint(lineFact(garmentLine))
      || internalTransferFingerprint(content.fabricLine) !== internalTransferFingerprint(lineFact(fabricLine))
      || internalTransferFingerprint(content) !== payload.contentFingerprint
      || content.priceRevision != null && content.priceRevision !== (payload.priceRevision ?? 1)
      || ['masterId','mirrorId','garmentOrderId','fabricOrderId','garmentOrderLineId','fabricOrderLineId','materialCode','unit','quantity','settlementPrice','requestDepartmentId','supplyDepartmentId','dueDate'].some(key => internalTransferFingerprint(content[key]) !== internalTransferFingerprint((payload as any)[key])))
    throw businessError('INVALID_COST_SOURCE', '双方订单行、单位、数量或价格已变化，原批准不能覆盖新内容');
  const approval = await db.approvalRequest.findUnique({ where: { id: payload.settlementApprovalId } });
  if (!approval || approval.status !== 'approved' || approval.actionType !== 'order:internal_trade_price' || approval.targetType !== 'OrderInternalTransfer'
      || approval.targetId !== payload.masterId || approval.payload?.schemaVersion !== 2 || approval.payload?.contentFingerprint !== payload.contentFingerprint
      || internalTransferFingerprint(approval.payload?.content) !== payload.contentFingerprint) throw businessError('INVALID_COST_SOURCE', '内部结算价缺少准确目标及完整内容的真实批准事实');
  const actorId = approval.bossFinalBypassBy ?? approval.reviewerId;
  const decidedAt = approval.decidedAt instanceof Date ? approval.decidedAt.toISOString() : null;
  if (!actorId || !decidedAt || actorId === approval.requesterId) throw businessError('INVALID_COST_SOURCE', '内部结算价不得自批或缺少真实决定主体');
  const audits = await db.auditLog.findMany({ where: { actorId, OR: [{ targetType: 'ApprovalRequest', targetId: approval.id }, { detail: { path: ['approvalId'], equals: approval.id } }] } });
  const matches = audits.filter((audit: any) => {
    const authority = audit.detail?.decisionActorAuthority, fact = audit.detail?.approvalDecisionFact;
    if (!Array.isArray(authority?.roles) || !Array.isArray(authority?.roleIds)) return false;
    const bossAt = approval.bossFinalBypassAt instanceof Date ? approval.bossFinalBypassAt.toISOString() : null;
    const boss = audit.action === 'boss_final_bypass' && approval.bossFinalBypassBy === actorId && bossAt === decidedAt
      && typeof approval.bossFinalBypassReason === 'string' && approval.bossFinalBypassReason.trim().length >= 30
      && audit.detail?.bossFinalBypassReason === approval.bossFinalBypassReason.trim()
      && authority?.roles?.includes('owner') && authority?.roleIds?.some((id: string) => legacyAgentRoleForId(id) === 'owner');
    const ordinary = ['approve_business_request', 'approve', 'agent_approval_approved'].includes(audit.action)
      && !approval.bossFinalBypassBy && !approval.bossFinalBypassAt && !approval.bossFinalBypassReason && approval.reviewerId === actorId
      && authority?.roles?.some((role: string) => role === 'admin' || role === 'manager')
      && authority?.roleIds?.some((id: string) => ['admin','manager'].includes(legacyAgentRoleForId(id) ?? ''));
    return authority?.authorizationLoaded === true && authority.userId === actorId && Array.isArray(authority.roles)
      && Array.isArray(authority.roleIds) && (boss || ordinary)
      && fact?.schemaVersion === 1 && fact.status === 'approved' && fact.actionType === approval.actionType && fact.targetType === approval.targetType
      && fact.targetId === payload.masterId && fact.contentFingerprint === payload.contentFingerprint && fact.decisionActorId === actorId && fact.decidedAt === decidedAt;
  });
  if (matches.length !== 1) throw businessError('INVALID_COST_SOURCE', '内部价格缺少唯一的主管或总领导决定审计，角色名称与approved状态不能替代');
  return { approval, decisionAudit: matches[0], garmentLine, fabricLine };
}

/** Used by cost sources in their existing snapshot; source mutation invalidates the review. */
export async function readInternalTransferAccountingFacts(db: any, record: any) {
  const hint = decodeInternalTransferPayload(record?.memo);
  if (!hint?.masterId) throw businessError('INVALID_COST_SOURCE', '历史内部交易缺少双向单据依据');
  const master = await db.orderInternalTransfer.findUnique({ where: { id: hint.masterId } });
  const payload = decodeInternalTransferPayload(master?.memo);
  const mirror = payload?.mirrorId && await db.orderInternalTransfer.findUnique({ where: { id: payload.mirrorId } });
  if (!master || master.deletedAt || !payload || payload.role !== 'master' || master.orderId !== payload.garmentOrderId || master.transferDirection !== 'incoming'
      || !mirror || mirror.deletedAt || mirror.orderId !== payload.fabricOrderId || mirror.transferDirection !== 'outgoing'
      || internalTransferFingerprint(decodeInternalTransferPayload(mirror.memo)) !== internalTransferFingerprint({ ...payload, role: 'mirror' })
      || String(master.transferAmount) !== String(mirror.transferAmount) || master.transferCurrency !== 'CNY' || mirror.transferCurrency !== 'CNY') throw businessError('INVALID_COST_SOURCE', '内部供料主单与镜像不一致');
  const orders = await db.order.findMany({ where: { id: { in: [payload.garmentOrderId, payload.fabricOrderId] }, deletedAt: null } });
  if (orders.length !== 2 || orders.some((order: any) => order.status === 'Cancelled') || !orders.some((order: any) => order.id === payload.fabricOrderId && order.isInternalFabricTrade === true)
      || orders.some((order: any) => order.id === payload.garmentOrderId && order.isInternalFabricTrade === true)) throw businessError('INVALID_COST_SOURCE', '双方真实订单范围已失效');
  const price = await assertNativePriceApproval(db, payload);
  if (!payload.confirmedBy || !payload.confirmedQuantity || !INTERNAL_TRANSFER_ACCOUNTING_STATUSES.includes(payload.status)
      || master.recognizedBy !== payload.confirmedBy || mirror.recognizedBy !== payload.confirmedBy
      || payload.confirmedQuantity !== payload.quantity || String(master.transferAmount) !== new Prisma.Decimal(payload.settlementPrice).mul(payload.confirmedQuantity).toDecimalPlaces(4).toString()) throw businessError('INVALID_COST_SOURCE', '内部供料金额与真实确认数量、批准价格不一致');
  const confirmationAudit = await assertNativeAudit(db, payload.confirmationAuditId, payload.confirmedBy, 'internal_transfer_confirm', master.id, confirmationFact(payload, master.transferAmount));
  const deliveries = [];
  if (new Set(payload.deliveries.map(row => row.id)).size !== payload.deliveries.length
      || new Set(payload.deliveries.map(row => row.requestKey)).size !== payload.deliveries.length) throw businessError('DUPLICATE_COST_SOURCE', '同一内部交付不可重复计量');
  for (const delivery of payload.deliveries) {
    const shipment = await db.shipment.findUnique({ where: { id: delivery.shipmentId } });
    const allocation = delivery.allocationId && await db.shipmentOrderAllocation.findUnique({ where: { id: delivery.allocationId } });
    const audit = await assertNativeAudit(db, delivery.auditId, delivery.registeredBy, 'internal_transfer_delivery', master.id, deliveryFact(delivery));
    if (!Number.isFinite(delivery.quantity) || delivery.quantity <= 0 || !DATE_RE.test(delivery.deliveryDate)
        || !shipment || shipment.deletedAt || !['Shipped','Arrived','Cleared','Delivered'].includes(shipment.status) || !allocation || allocation.shipmentId !== shipment.id
        || allocation.orderId !== payload.fabricOrderId || allocation.orderLineId !== payload.fabricOrderLineId || !['Fulfilled','ShortShipped'].includes(allocation.status)
        || String(allocation.unit).toUpperCase() !== String(payload.unit).toUpperCase() || delivery.unit !== payload.unit) throw businessError('INVALID_COST_SOURCE', '内部交付未与真实已出运订单行分配匹配');
    const sameAllocation = payload.deliveries.filter(item => item.allocationId === allocation.id).reduce((sum, item) => sum.add(item.quantity), new Prisma.Decimal(0));
    if (allocation.actualQty == null || !sameAllocation.lte(allocation.actualQty)) throw businessError('INVALID_COST_SOURCE', '内部交付数量超过真实出运分配');
    deliveries.push({ delivery, shipment, allocation, audit });
  }
  const receipts = [];
  if (new Set((payload.receipts ?? []).map(row => row.id)).size !== (payload.receipts ?? []).length
      || new Set((payload.receipts ?? []).map(row => row.requestKey)).size !== (payload.receipts ?? []).length) throw businessError('DUPLICATE_COST_SOURCE', '同一内部收货不可重复计量');
  for (const receipt of payload.receipts ?? []) {
    if (!Number.isFinite(receipt.quantity) || receipt.quantity < 0 || !DATE_RE.test(receipt.receivedDate) || !payload.deliveries.some(item => item.id === receipt.deliveryId)) throw businessError('INVALID_COST_SOURCE', '内部收货缺少真实交付、数量或日期');
    const audit = await assertNativeAudit(db, receipt.auditId, receipt.actorId, 'internal_transfer_receipt', master.id, receiptFact(receipt));
    receipts.push({ receipt, audit });
  }
  for (const delivery of payload.deliveries) {
    const ownReceipts = (payload.receipts ?? []).filter(row => row.deliveryId === delivery.id);
    const received = ownReceipts.reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0));
    if (received.gt(delivery.quantity) || (ownReceipts.length ? delivery.receivedQuantity == null || !received.eq(delivery.receivedQuantity) || delivery.variance !== received.sub(delivery.quantity).toDecimalPlaces(4).toNumber()
      : delivery.receivedQuantity !== null || delivery.variance !== null)) throw businessError('INVALID_COST_SOURCE', '收货投影与不可覆盖的真实收货记录不一致');
  }
  if (payload.deliveries.reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0)).gt(payload.confirmedQuantity)) throw businessError('INVALID_COST_SOURCE', '实际交付超出批准范围');
  return { master, mirror, payload, orders, ...price, confirmationAudit, deliveries, receipts };
}

export function encodeInternalTransferPayload(payload: InternalTransferPayload): string {
  return JSON.stringify(payload);
}

/** 解码 memo 载荷；非 DR-033 载荷/非法 JSON 返回 null（fail-safe，不抛错） */
export function decodeInternalTransferPayload(memo: string | null | undefined): InternalTransferPayload | null {
  if (!memo) return null;
  try {
    const parsed = JSON.parse(memo);
    if (parsed && parsed.docType === 'DR033_INTERNAL_FABRIC_SUPPLY') {
      return parsed as InternalTransferPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 内部交易记录是否计入核算（利润表/合并报表共用口径）：
 *   - DR-033 载荷：status ∈ Effective/Delivering/Closed（Draft/PendingConfirm/Cancelled 不计）
 *   - 无载荷的历史记录：recognizedAt 非空（已认账）才计入
 */
export function isInternalTransferEffective(record: { memo?: string | null; recognizedAt?: unknown }): boolean {
  const payload = decodeInternalTransferPayload(record.memo ?? null);
  if (payload) return INTERNAL_TRANSFER_ACCOUNTING_STATUSES.includes(payload.status);
  return record.recognizedAt != null;
}

// ───────────────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────────────
const genId = (prefix: string) => `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
const today = () => todayLocalKey();
const isoNow = () => businessNowDate().toISOString();

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function fail<T>(code: InternalTransferErrorCode | string, message: string, statusCode: number): InternalTransferResult<T> {
  return { ok: false, error: { code, message, statusCode } };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ───────────────────────────────────────────────────────────────────
// 服务工厂
// ───────────────────────────────────────────────────────────────────
export interface InternalTransferServiceOptions {
  prisma: PrismaClient;
  approvalCreateService: ApprovalCreateService;
}

export interface CreateInternalTransferInput {
  requestDepartmentId: string; // 申请部门（服装部）
  supplyDepartmentId: string; // 供料部门（面料部）
  garmentOrderId: string; // 关联服装订单
  fabricOrderId: string; // 关联内部面料订单（isInternalFabricTrade=true）
  materialCode: string;
  quantity: number;
  unit?: string;
  settlementPrice: number; // 内部结算价（单价）——须走 DR-006 审批
  dueDate: string; // 交期 YYYY-MM-DD
  memo?: string;
  requesterId: string;
  garmentOrderLineId?: string;
  fabricOrderLineId?: string;
  trustedActor?: TokenPayload;
}

export interface ConfirmInternalTransferInput {
  id: string;
  actorId: string;
  confirmedQuantity?: number;
  confirmedDueDate?: string;
  trustedActor?: TokenPayload;
}

export interface RegisterDeliveryInput {
  id: string;
  actorId: string;
  shipmentId: string;
  quantity: number;
  deliveryDate?: string;
  receivedQuantity?: number;
  receivedDate?: string;
  packingLines?: InternalTransferPackingLine[];
  allocationId?: string;
  requestId?: string;
  trustedActor?: TokenPayload;
}
export interface RegisterReceiptInput { id: string; deliveryId: string; actorId: string; quantity: number; receivedDate: string; requestId: string; trustedActor?: TokenPayload }

export function createInternalTransferService(opts: InternalTransferServiceOptions) {
  const { prisma, approvalCreateService } = opts;
  const TX = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 };
  // Business writes serialize on both parent Orders and the native rows below.
  // ReadCommitted lets a post-lock authority check see committed withdrawals;
  // a Serializable snapshot established before waiting would retain old grants.
  // Read/list keep their existing consistent snapshot contract.
  const WRITE_TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 };
  async function authorize(db: any, actorId: string, prior?: TokenPayload, orderIds: string[] = [], missingCodes: Record<string, string> = {}) {
    if (prior && prior.userId !== actorId) throw businessError('FORBIDDEN', '真实操作者与凭证不一致');
    if (!await db.userAccount.findFirst({ where: { id: actorId, status: 'active', deletedAt: null }, select: { id: true } })) throw businessError('FORBIDDEN', '当前账号已失效');
    const context = await createPermissionService({ prisma: db }).getUserPermissionContext(actorId);
    if (!context) throw businessError('FORBIDDEN', '当前账号权限不可核对');
    const actor: TokenPayload = { userId: actorId, roles: context.legacyRoleCodes, roleIds: context.roleIds, permissions: context.scopes, departmentIds: context.departmentIds, authorizationLoaded: true, ...(prior?.permissionCeiling ? { permissionCeiling: [...prior.permissionCeiling] } : {}) };
    if (!context.scopes.includes('order:internal_trade:write') || !hasScope(actor, 'order:internal_trade:write')) throw businessError('FORBIDDEN', '当前账号缺少内部供料操作授权');
    // Writes must not consume the optional 60s read/share cache, including replays.
    const scope = await buildOrderListScopeWhere(db, actor, { fresh: true });
    for (const orderId of orderIds) if (!await db.order.findFirst({ where: { id: orderId, deletedAt: null, status: { not: 'Cancelled' }, AND: [scope] }, select: { id: true } })) throw businessError(missingCodes[orderId] || 'NOT_FOUND', '关联订单不存在或不可见');
  }
  async function lockNative(db: any, id: string) {
    const candidate = await resolveMaster(id, db), hint = decodeInternalTransferPayload(candidate?.memo);
    if (!candidate || !hint) throw businessError('TRANSFER_NOT_FOUND', '内部供料单不存在或缺少双向内容');
    for (const orderId of [hint.garmentOrderId, hint.fabricOrderId].sort()) await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} FOR UPDATE`);
    for (const rowId of [hint.masterId, hint.mirrorId].filter(Boolean).sort()) await db.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderInternalTransfer" WHERE "id"=${rowId} FOR UPDATE`);
    const master = await resolveMaster(id, db), payload = decodeInternalTransferPayload(master?.memo);
    if (!master || !payload || payload.masterId !== hint.masterId || payload.mirrorId !== hint.mirrorId || payload.garmentOrderId !== hint.garmentOrderId || payload.fabricOrderId !== hint.fabricOrderId) throw businessError('SOURCE_CHANGED', '内部供料来源已变化，请重新加载');
    for (const lineId of [payload.garmentOrderLineId, payload.fabricOrderLineId].filter(Boolean).sort()) await db.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${lineId} FOR UPDATE`);
    return { master, payload };
  }
  async function write<T>(work: (db: any) => Promise<T>, operationLabel: string): Promise<InternalTransferResult<T>> {
    try { return { ok: true, data: await prisma.$transaction(work, WRITE_TX) }; }
    catch (error: any) {
      if (error?.code === 'NO_REVIEWER_RESOLVED') { const safe = businessError('NO_REVIEWER_RESOLVED', '当前组织归属未能解析审批人，请先配置可用审批人'); return { ok: false, error: { code: safe.code, message: safe.message, statusCode: safe.statusCode } }; }
      if (error?.code === 'P2034' || error?.code === 'P2002' || error?.code === 'P2010' && error?.meta?.code === '40001') {
        const conflict = businessError('SOURCE_CHANGED', '内部供料来源并发变化，请保留原请求并重新加载');
        return { ok: false, error: { code: conflict.code, message: conflict.message, statusCode: conflict.statusCode } };
      }
      if (!isBusinessError(error)) logger.error('[InternalTransfer] native transaction failed', { error: error?.message, code: error?.code });
      const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: `${operationLabel}未能完成，本次未确认任何改动，请稍后重试` });
      return { ok: false, error: { code: safe.code, message: safe.message, statusCode: safe.status } };
    }
  }

  // ── 内部：状态迁移守卫（fail-closed） ──
  function assertTransition(from: InternalTransferStatus, to: InternalTransferStatus): void {
    if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
      throw Object.assign(
        new Error(`内部供料单状态机非法迁移: ${from} → ${to}（允许: ${ALLOWED_TRANSITIONS[from].join(', ') || '无'}）`),
        { code: INTERNAL_TRANSFER_ERRORS.INVALID_TRANSFER_STATE },
      );
    }
  }

  // ── 内部：按 id 解析 master 记录（mirror id 自动跳转到 master） ──
  async function resolveMaster(id: string, db: any = prisma) {
    const rec = await db.orderInternalTransfer.findUnique({ where: { id } });
    if (!rec || rec.deletedAt) return null;
    const payload = decodeInternalTransferPayload(rec.memo);
    if (payload?.role === 'mirror' && payload.masterId !== rec.id) {
      const master = await db.orderInternalTransfer.findUnique({ where: { id: payload.masterId } });
      if (master && !master.deletedAt) return master;
    }
    return rec;
  }

  // ── 内部：同步镜像记录（status/金额/载荷随 master） ──
  async function syncMirror(tx: any, masterPayload: InternalTransferPayload, transferAmount: number) {
    if (!masterPayload.mirrorId) return;
    const mirrorPayload: InternalTransferPayload = { ...masterPayload, role: 'mirror' };
    await tx.orderInternalTransfer.update({
      where: { id: masterPayload.mirrorId },
      data: {
        transferAmount,
        memo: encodeInternalTransferPayload(mirrorPayload),
        ...(masterPayload.confirmedBy ? { recognizedBy: masterPayload.confirmedBy, recognizedAt: new Date(masterPayload.confirmedAt!) } : {}),
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // createInternalTransfer — 服装部发起内部供料申请（scope 由 route 层守卫）
  //   创建即提交面料部确认（Draft → PendingConfirm），同时创建结算价审批单
  // ══════════════════════════════════════════════════════════════════
  async function createInternalTransfer(input: CreateInternalTransferInput): Promise<InternalTransferResult<{ transfer: any; mirror: any; approvalRequestId: string; payload: InternalTransferPayload }>> {
    const { requestDepartmentId, supplyDepartmentId, garmentOrderId, fabricOrderId, materialCode, quantity, settlementPrice, dueDate, requesterId } = input;
    const missing = ['requestDepartmentId','supplyDepartmentId','garmentOrderId','fabricOrderId','materialCode','dueDate'].filter(key => !String((input as any)[key] ?? '').trim());
    if (quantity == null) missing.push('quantity'); if (settlementPrice == null) missing.push('settlementPrice');
    if (missing.length) return fail(INTERNAL_TRANSFER_ERRORS.MISSING_REQUIRED_FIELD, `必填字段缺失: ${missing.join(', ')}`, 400);
    if (!Number.isFinite(quantity) || quantity <= 0) return fail(INTERNAL_TRANSFER_ERRORS.INVALID_QUANTITY, '数量必须为正有限数', 400);
    if (!Number.isFinite(settlementPrice) || settlementPrice <= 0) return fail(INTERNAL_TRANSFER_ERRORS.INVALID_SETTLEMENT_PRICE, '内部结算价必须为正有限数', 400);
    if (!DATE_RE.test(dueDate)) return fail(INTERNAL_TRANSFER_ERRORS.INVALID_DUE_DATE, '交期必须为 YYYY-MM-DD', 400);
    if (garmentOrderId === fabricOrderId) return fail(INTERNAL_TRANSFER_ERRORS.SAME_ORDER_CONFLICT, '双方订单不得相同', 400);
    return write(async tx => {
      await authorize(tx, requesterId, input.trustedActor, [garmentOrderId, fabricOrderId], { [garmentOrderId]: 'GARMENT_ORDER_NOT_FOUND', [fabricOrderId]: 'FABRIC_ORDER_NOT_FOUND' });
      for (const orderId of [garmentOrderId, fabricOrderId].sort()) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} FOR UPDATE`);
      await authorize(tx, requesterId, input.trustedActor, [garmentOrderId, fabricOrderId], { [garmentOrderId]: 'GARMENT_ORDER_NOT_FOUND', [fabricOrderId]: 'FABRIC_ORDER_NOT_FOUND' });
      const garment = await tx.order.findUnique({ where: { id: garmentOrderId } }), fabric = await tx.order.findUnique({ where: { id: fabricOrderId } });
      if (garment.isInternalFabricTrade) throw businessError('GARMENT_ORDER_INTERNAL_CONFLICT', '申请服装订单不可标记为内部面料交易');
      if (!fabric.isInternalFabricTrade) throw businessError('FABRIC_ORDER_NOT_INTERNAL_TRADE', '面料供料订单须明确标记为内部交易');
      const selectLine = async (orderId: string, requested?: string) => {
        const lines = await tx.orderLine.findMany({ where: { orderId, ...(requested ? { id: requested } : { materialCode: materialCode.trim() }) } });
        if (lines.length !== 1 || lines[0].materialCode !== materialCode.trim() || !lines[0].unit) throw businessError('INVALID_COST_SOURCE', '双方订单行必须真实且唯一；重码物料请明确选择订单行，未知单位不可推定');
        return lines[0];
      };
      const garmentCandidate = await selectLine(garmentOrderId, input.garmentOrderLineId), fabricCandidate = await selectLine(fabricOrderId, input.fabricOrderLineId);
      for (const lineId of [garmentCandidate.id, fabricCandidate.id].sort()) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${lineId} FOR UPDATE`);
      const garmentLine = await selectLine(garmentOrderId, garmentCandidate.id), fabricLine = await selectLine(fabricOrderId, fabricCandidate.id);
      const unit = String(input.unit || fabricLine.unit).trim().toUpperCase();
      if (!unit || unit !== String(fabricLine.unit).trim().toUpperCase() || new Prisma.Decimal(quantity).gt(fabricLine.quantity)) throw businessError('INVALID_COST_SOURCE', '内部数量或单位不在真实面料订单行范围内');
      const duplicates = await tx.orderInternalTransfer.findMany({ where: { deletedAt: null, OR: [{ orderId: garmentOrderId, transferDirection: 'incoming' }, { orderId: fabricOrderId, transferDirection: 'outgoing' }] } });
      if (duplicates.length) throw businessError('TRANSFER_ALREADY_EXISTS', '双方订单已有内部供料单，请处理原单后重试');
      const masterId = genId('OIT'), mirrorId = genId('OIT'), now = isoNow();
      const transferAmount = new Prisma.Decimal(settlementPrice).mul(quantity).toDecimalPlaces(4).toNumber();
      const content = { masterId, mirrorId, garmentOrderId, fabricOrderId, garmentOrderLineId: garmentLine.id, fabricOrderLineId: fabricLine.id,
        garmentLine: lineFact(garmentLine), fabricLine: lineFact(fabricLine), requestDepartmentId: requestDepartmentId.trim(), supplyDepartmentId: supplyDepartmentId.trim(),
        materialCode: materialCode.trim(), unit, quantity, settlementPrice, transferAmount, transferCurrency: 'CNY', dueDate: dueDate.trim(), priceRevision: 1 };
      const contentFingerprint = internalTransferFingerprint(content);
      const approval = await approvalCreateService.createBusinessApproval({ client: tx, requesterId, actionType: 'order:internal_trade_price', targetType: 'OrderInternalTransfer', targetId: masterId,
        payload: { schemaVersion: 2, content, contentFingerprint }, risk: 'medium' });
      const payload: InternalTransferPayload = { docType: 'DR033_INTERNAL_FABRIC_SUPPLY', role: 'master', schemaVersion: 2,
        ...content, priceRevision: 1, priceRevisions: [], priceContent: content, contentFingerprint, settlementApprovalId: approval.id,
        status: 'PendingConfirm', confirmedQuantity: null, confirmedDueDate: null, confirmedBy: null, confirmedAt: null, deliveries: [], receipts: [],
        history: [{ from: 'Draft', to: 'PendingConfirm', actorId: requesterId, at: now, note: '服装部发起内部供料申请' }], ...(input.memo?.trim() ? { memo: input.memo.trim() } : {}) };
      const master = await tx.orderInternalTransfer.create({ data: { id: masterId, orderId: garmentOrderId, transferDirection: 'incoming', counterpartyId: supplyDepartmentId.trim(), ourDepartmentId: requestDepartmentId.trim(), transferAmount, transferCurrency: 'CNY', transferDate: today(), memo: encodeInternalTransferPayload(payload) } });
      const mirror = await tx.orderInternalTransfer.create({ data: { id: mirrorId, orderId: fabricOrderId, transferDirection: 'outgoing', counterpartyId: requestDepartmentId.trim(), ourDepartmentId: supplyDepartmentId.trim(), transferAmount, transferCurrency: 'CNY', transferDate: today(), memo: encodeInternalTransferPayload({ ...payload, role: 'mirror' }) } });
      await writeRouteAuditLog({ prisma: tx, actorId: requesterId, source: 'service:internal-trade:create', operation: 'internal_transfer_create', targetType: 'OrderInternalTransfer', targetId: masterId, before: null,
        after: { garmentOrderId, fabricOrderId, garmentOrderLineId: garmentLine.id, fabricOrderLineId: fabricLine.id, materialCode, quantity, settlementPrice, transferAmount, dueDate, mirrorId, settlementApprovalId: approval.id, contentFingerprint, status: 'PendingConfirm' } });
      return { transfer: master, mirror, approvalRequestId: approval.id, payload };
    }, '内部供料单创建');
  }

  async function reviseInternalTransferPrice(input: ReviseInternalTransferPriceInput): Promise<InternalTransferResult<ReturnType<typeof priceRevisionAck>>> {
    const requestId = input.requestId?.trim(), reason = input.reason?.trim();
    if (!requestId || !reason || !/^[a-f0-9]{64}$/.test(input.expectedContentFingerprint || '')
        || !Number.isFinite(input.quantity) || input.quantity <= 0 || !Number.isFinite(input.settlementPrice) || input.settlementPrice <= 0 || !DATE_RE.test(input.dueDate))
      return fail('INVALID_INPUT', '重送审须明确原价格版本、正数数量/价格、交期、原因与稳定请求标识', statusFromError(businessError('INVALID_INPUT', '价格修订参数无效')));
    return write(async tx => {
      const { master, payload } = await lockNative(tx, input.id);
      await authorize(tx, input.actorId, input.trustedActor, [payload.garmentOrderId, payload.fabricOrderId]);
      const command = { expectedContentFingerprint: input.expectedContentFingerprint, quantity: input.quantity, settlementPrice: input.settlementPrice, dueDate: input.dueDate, reason };
      const requestKey = internalTransferFingerprint({ actorId: input.actorId, masterId: master.id, action: 'price-revision', requestId });
      const requestFingerprint = internalTransferFingerprint(command);
      const previousCommand = payload.priceRevisions?.find(revision => revision.requestKey === requestKey);
      if (previousCommand) {
        if (previousCommand.requestFingerprint !== requestFingerprint) throw businessError('REQUEST_CONFLICT', '原价格修订命令不可改变参数');
        await assertNativeAudit(tx, previousCommand.auditId, input.actorId, 'internal_transfer_price_revision', master.id, priceRevisionFact(previousCommand));
        return priceRevisionAck(previousCommand, true);
      }
      const mirror = payload.mirrorId && await tx.orderInternalTransfer.findUnique({ where: { id: payload.mirrorId } });
      const mirrorPayload = decodeInternalTransferPayload(mirror?.memo);
      if (!mirror || mirror.deletedAt || mirror.orderId !== payload.fabricOrderId || !mirrorPayload
          || internalTransferFingerprint({ ...mirrorPayload, role: 'master' }) !== internalTransferFingerprint(payload)) throw businessError('SOURCE_CHANGED', '双方内部供料内容不一致，请先核对原单');
      if (!['Draft', 'PendingConfirm'].includes(payload.status) || master.recognizedAt || master.recognizedBy || mirror.recognizedAt || mirror.recognizedBy
          || payload.confirmedBy || payload.confirmedAt || payload.confirmedQuantity != null || payload.deliveries.length || payload.receipts?.length)
        throw businessError('INVALID_STATE', '仅未认账且未交付收货的待确认供料可改价格；生效后须走正式业务变更');
      if (payload.schemaVersion !== 2 || !payload.priceContent || !payload.contentFingerprint || !payload.garmentOrderLineId || !payload.fabricOrderLineId
          || payload.contentFingerprint !== input.expectedContentFingerprint || internalTransferFingerprint(payload.priceContent) !== payload.contentFingerprint)
        throw businessError('SOURCE_CHANGED', '原价格版本已变化或缺少稳定行依据，请重新加载');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ApprovalRequest" WHERE "id"=${payload.settlementApprovalId} FOR UPDATE`);
      const oldApproval = await tx.approvalRequest.findUnique({ where: { id: payload.settlementApprovalId } });
      if (!oldApproval || oldApproval.targetType !== 'OrderInternalTransfer' || oldApproval.targetId !== master.id || oldApproval.actionType !== 'order:internal_trade_price'
          || oldApproval.payload?.contentFingerprint !== payload.contentFingerprint || internalTransferFingerprint(oldApproval.payload?.content) !== payload.contentFingerprint
          || !['pending', 'approved', 'rejected'].includes(oldApproval.status)) throw businessError('SOURCE_CHANGED', '原审批不属于当前准确供料价格版本');
      const lines = await tx.orderLine.findMany({ where: { id: { in: [payload.garmentOrderLineId, payload.fabricOrderLineId] } } });
      const garmentLine = lines.find((line: any) => line.id === payload.garmentOrderLineId && line.orderId === payload.garmentOrderId);
      const fabricLine = lines.find((line: any) => line.id === payload.fabricOrderLineId && line.orderId === payload.fabricOrderId);
      if (!garmentLine || !fabricLine || garmentLine.materialCode !== payload.materialCode || fabricLine.materialCode !== payload.materialCode
          || !garmentLine.unit || !fabricLine.unit || String(fabricLine.unit).toUpperCase() !== payload.unit.toUpperCase() || new Prisma.Decimal(input.quantity).gt(fabricLine.quantity))
        throw businessError('INVALID_COST_SOURCE', '价格修订必须仍属于准确双方订单行、单位及数量范围');
      const revisionNumber = (payload.priceRevision ?? 1) + 1;
      if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 2) throw businessError('INVALID_COST_SOURCE', '原价格版本序号无效');
      const amount = new Prisma.Decimal(input.settlementPrice).mul(input.quantity).toDecimalPlaces(4).toNumber();
      const content = { masterId: master.id, mirrorId: payload.mirrorId, garmentOrderId: payload.garmentOrderId, fabricOrderId: payload.fabricOrderId,
        garmentOrderLineId: garmentLine.id, fabricOrderLineId: fabricLine.id, garmentLine: lineFact(garmentLine), fabricLine: lineFact(fabricLine),
        requestDepartmentId: payload.requestDepartmentId, supplyDepartmentId: payload.supplyDepartmentId, materialCode: payload.materialCode, unit: payload.unit,
        quantity: input.quantity, settlementPrice: input.settlementPrice, transferAmount: amount, transferCurrency: 'CNY', dueDate: input.dueDate, priceRevision: revisionNumber };
      const fingerprint = internalTransferFingerprint(content), now = isoNow();
      // Snapshot before cancellation. Approved/rejected decisions are never overwritten.
      const approvalSnapshot = JSON.parse(JSON.stringify(oldApproval));
      const previousApprovalAudits = await tx.auditLog.findMany({ where: { OR: [{ targetType: 'ApprovalRequest', targetId: oldApproval.id }, { detail: { path: ['approvalId'], equals: oldApproval.id } }] }, orderBy: { id: 'asc' } });
      if (oldApproval.status === 'pending') {
        const cancelled = await tx.approvalRequest.updateMany({ where: { id: oldApproval.id, status: 'pending', requesterId: oldApproval.requesterId,
          reviewerId: oldApproval.reviewerId, actionType: oldApproval.actionType, targetType: oldApproval.targetType, targetId: oldApproval.targetId,
          payload: { equals: oldApproval.payload } }, data: { status: 'cancelled', decisionNote: '内部供料价格版本已重送审；此记录不是批准决议', decidedAt: new Date(now) } });
        if (cancelled.count !== 1) throw businessError('SOURCE_CHANGED', '原审批已被同时处理，请重新加载');
        await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'service:internal-trade:price-revision', operation: 'internal_transfer_price_supersede', targetType: 'ApprovalRequest', targetId: oldApproval.id,
          before: { status: 'pending', contentFingerprint: payload.contentFingerprint }, after: { status: 'cancelled', masterId: master.id, revision: revisionNumber, reason } });
      }
      const approval = await approvalCreateService.createBusinessApproval({ client: tx, requesterId: input.actorId, actionType: 'order:internal_trade_price', targetType: 'OrderInternalTransfer', targetId: master.id,
        payload: { schemaVersion: 2, content, contentFingerprint: fingerprint }, risk: 'medium' });
      const revision: InternalTransferPriceRevision = { revision: revisionNumber, approvalRequestId: approval.id, contentFingerprint: fingerprint,
        previousApprovalId: oldApproval.id, previousContentFingerprint: payload.contentFingerprint, previousContent: payload.priceContent, previousApproval: approvalSnapshot, previousApprovalAuditIds: previousApprovalAudits.map((audit: any) => audit.id),
        actorId: input.actorId, at: now, auditId: '', requestId, requestKey, requestFingerprint, command };
      revision.auditId = await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'service:internal-trade:price-revision', operation: 'internal_transfer_price_revision', targetType: 'OrderInternalTransfer', targetId: master.id,
        before: { approvalRequestId: oldApproval.id, contentFingerprint: payload.contentFingerprint }, after: priceRevisionFact(revision) });
      const next: InternalTransferPayload = { ...payload, ...content, quantity: input.quantity, settlementPrice: input.settlementPrice, dueDate: input.dueDate,
        priceContent: content, contentFingerprint: fingerprint, settlementApprovalId: approval.id, priceRevision: revisionNumber, priceRevisions: [...(payload.priceRevisions ?? []), revision],
        status: 'PendingConfirm', history: [...payload.history, { from: payload.status, to: 'PendingConfirm', actorId: input.actorId, at: now, note: reason }] };
      const save = async (row: any, role: 'master' | 'mirror') => {
        const changed = await tx.orderInternalTransfer.updateMany({ where: { id: row.id, memo: row.memo, recognizedAt: null, recognizedBy: null, deletedAt: null },
          data: { transferAmount: amount, memo: encodeInternalTransferPayload({ ...next, role }) } });
        if (changed.count !== 1) throw businessError('SOURCE_CHANGED', '双方供料版本并发变化，请保留原命令重试');
      };
      await save(master, 'master'); await save(mirror, 'mirror');
      return priceRevisionAck(revision, false);
    }, '内部供料单价格重送审');
  }

  // ══════════════════════════════════════════════════════════════════
  // confirmInternalTransfer — 面料部确认数量+交期+已批准结算价 → 生效
  //   生效后：双方 OrderLine.internalTransferPrice 回写（成本/收入依据），双向关联独立核算
  // ══════════════════════════════════════════════════════════════════
  async function confirmInternalTransfer(input: ConfirmInternalTransferInput): Promise<InternalTransferResult<{ transfer: any; payload: InternalTransferPayload }>> {
    return write(async tx => {
      const { master, payload } = await lockNative(tx, input.id);
      await authorize(tx, input.actorId, input.trustedActor, [payload.garmentOrderId, payload.fabricOrderId]);
      if (payload.status !== 'PendingConfirm') throw businessError('INVALID_TRANSFER_STATE', '仅待确认内部供料单可生效');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ApprovalRequest" WHERE "id"=${payload.settlementApprovalId} FOR UPDATE`);
      const priceApproval = await tx.approvalRequest.findUnique({ where: { id: payload.settlementApprovalId } });
      if (!priceApproval || priceApproval.status !== 'approved') throw businessError('SETTLEMENT_PRICE_NOT_APPROVED', '当前价格版本尚未获得真实批准');
      await assertNativePriceApproval(tx, payload);
      const quantity = input.confirmedQuantity ?? payload.quantity, dueDate = input.confirmedDueDate ?? payload.dueDate;
      if (!Number.isFinite(quantity) || quantity <= 0 || !DATE_RE.test(dueDate)) throw businessError('INVALID_INPUT', '确认数量及交期无效');
      if (quantity !== payload.quantity || dueDate !== payload.dueDate) throw businessError('SOURCE_CHANGED', '确认内容超出已批准冻结版本，请重新提交价格审批');
      const amount = new Prisma.Decimal(payload.settlementPrice).mul(quantity).toDecimalPlaces(4).toNumber(), now = isoNow();
      const next: InternalTransferPayload = { ...payload, status: 'Effective', confirmedQuantity: quantity, confirmedDueDate: dueDate, confirmedBy: input.actorId, confirmedAt: now,
        history: [...payload.history, { from: 'PendingConfirm', to: 'Effective', actorId: input.actorId, at: now, note: '确认冻结数量、交期与真实批准价格' }] };
      next.confirmationAuditId = await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'service:internal-trade:confirm', operation: 'internal_transfer_confirm', targetType: 'OrderInternalTransfer', targetId: master.id,
        before: { status: payload.status, transferAmount: String(master.transferAmount) }, after: confirmationFact(next, amount) });
      const transfer = await tx.orderInternalTransfer.update({ where: { id: master.id }, data: { transferAmount: amount, recognizedBy: input.actorId, recognizedAt: new Date(now), memo: encodeInternalTransferPayload(next) } });
      await syncMirror(tx, next, amount);
      await tx.orderLine.update({ where: { id: payload.garmentOrderLineId! }, data: { internalTransferPrice: payload.settlementPrice } });
      await tx.orderLine.update({ where: { id: payload.fabricOrderLineId! }, data: { internalTransferPrice: payload.settlementPrice } });
      return { transfer, payload: next };
    }, '内部供料单确认生效');
  }

  // ══════════════════════════════════════════════════════════════════
  // registerDelivery — 交付登记（关联面料订单既有出运，不另造平行出库流程）
  //   每笔出运关联内部供料分配 → 回写服装订单行面料到货数量/日期/状态；
  //   支持分批出运/分批到货/差异追溯；仅内部交付单+装箱明细，无对外商业发票
  // ══════════════════════════════════════════════════════════════════
  function transportTotals(payload: InternalTransferPayload) {
    return { shipped: payload.deliveries.reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0)), received: (payload.receipts ?? []).reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0)) };
  }
  async function appendReceipt(tx: any, payload: InternalTransferPayload, input: RegisterReceiptInput) {
    if (!Number.isFinite(input.quantity) || input.quantity < 0 || !DATE_RE.test(input.receivedDate) || !input.requestId?.trim()) throw businessError('INVALID_INPUT', '收货数量、日期及稳定请求标识必须明确');
    const delivery = payload.deliveries.find(row => row.id === input.deliveryId);
    if (!delivery) throw businessError('NOT_FOUND', '收货所对应的实际交付不存在');
    const requestKey = internalTransferFingerprint({ actorId: input.actorId, masterId: payload.masterId, action: 'receipt', requestId: input.requestId });
    const requestFingerprint = internalTransferFingerprint({ deliveryId: input.deliveryId, quantity: input.quantity, receivedDate: input.receivedDate });
    const previous = payload.receipts?.find(row => row.requestKey === requestKey);
    if (previous) { if (previous.requestFingerprint !== requestFingerprint) throw businessError('REQUEST_CONFLICT', '原收货命令不可改变参数'); return previous; }
    const before = (payload.receipts ?? []).filter(row => row.deliveryId === delivery.id).reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0));
    if (before.add(input.quantity).gt(delivery.quantity)) throw businessError('INVALID_INPUT', '累计收货数量超过这笔实际交付，不能覆盖原收货记录');
    const receipt: InternalTransferReceipt = { id: genId('ITR'), deliveryId: delivery.id, quantity: input.quantity, receivedDate: input.receivedDate, actorId: input.actorId, requestKey, requestFingerprint, auditId: '' };
    receipt.auditId = await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'service:internal-trade:receipt', operation: 'internal_transfer_receipt', targetType: 'OrderInternalTransfer', targetId: payload.masterId, before: null, after: receiptFact(receipt) });
    payload.receipts = [...(payload.receipts ?? []), receipt];
    delivery.receivedQuantity = before.add(input.quantity).toNumber(); delivery.receivedDate = input.receivedDate; delivery.variance = new Prisma.Decimal(delivery.receivedQuantity).sub(delivery.quantity).toDecimalPlaces(4).toNumber();
    return receipt;
  }
  async function saveTransport(tx: any, master: any, next: InternalTransferPayload, actorId: string) {
    const totals = transportTotals(next), oldStatus = next.status;
    next.status = totals.shipped.eq(next.confirmedQuantity!) && totals.received.eq(next.confirmedQuantity!) && next.deliveries.every(delivery => delivery.variance === 0) ? 'Closed' : 'Delivering';
    next.history = [...next.history, { from: oldStatus, to: next.status, actorId, at: isoNow(), note: '关联真实出运及不可覆盖的收货记录；短收保留差异' }];
    const changed = await tx.orderInternalTransfer.updateMany({ where: { id: master.id, memo: master.memo }, data: { memo: encodeInternalTransferPayload(next) } });
    if (changed.count !== 1) throw businessError('SOURCE_CHANGED', '内部供料单并发变化，请保留原请求重试');
    await syncMirror(tx, next, Number(master.transferAmount));
    await tx.orderLine.update({ where: { id: next.garmentOrderLineId! }, data: { shipmentQuantity: totals.shipped.toNumber(), shippingDate: next.deliveries[next.deliveries.length - 1]?.deliveryDate,
      status: totals.received.eq(next.confirmedQuantity!) ? 'Arrived' : 'PartiallyArrived' } });
    return tx.orderInternalTransfer.findUnique({ where: { id: master.id } });
  }
  async function registerDelivery(input: RegisterDeliveryInput): Promise<InternalTransferResult<{ transfer: any; delivery: InternalTransferDelivery; cumulativeDelivered: number; status: InternalTransferStatus; payload: InternalTransferPayload }>> {
    return write(async tx => {
      const { master, payload } = await lockNative(tx, input.id);
      await authorize(tx, input.actorId, input.trustedActor, [payload.garmentOrderId, payload.fabricOrderId]);
      if (!INTERNAL_TRANSFER_ACCOUNTING_STATUSES.includes(payload.status)) throw businessError('INVALID_TRANSFER_STATE', '仅生效或交付中的内部供料单可新增交付');
      await readInternalTransferAccountingFacts(tx, master);
      if (!Number.isFinite(input.quantity) || input.quantity <= 0 || input.deliveryDate !== undefined && !DATE_RE.test(input.deliveryDate)) throw businessError('INVALID_DELIVERY_QUANTITY', '交付数量及日期无效');
      const fingerprint = internalTransferFingerprint({ shipmentId: input.shipmentId, allocationId: input.allocationId ?? null, quantity: input.quantity, deliveryDate: input.deliveryDate ?? null, receivedQuantity: input.receivedQuantity ?? null, receivedDate: input.receivedDate ?? null, packingLines: input.packingLines ?? [] });
      const requestKey = internalTransferFingerprint({ actorId: input.actorId, masterId: master.id, action: 'delivery', requestId: input.requestId ?? fingerprint });
      const previous = payload.deliveries.find(row => row.requestKey === requestKey);
      if (previous) { if (previous.requestFingerprint !== fingerprint) throw businessError('REQUEST_CONFLICT', '原交付命令不可改变参数'); return { transfer: master, delivery: previous, cumulativeDelivered: transportTotals(payload).shipped.toNumber(), status: payload.status, payload }; }
      if (payload.status !== 'Effective' && payload.status !== 'Delivering') throw businessError('INVALID_TRANSFER_STATE', '仅生效或交付中的内部供料单可新增交付');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Shipment" WHERE "id"=${input.shipmentId} FOR UPDATE`);
      const shipment = await tx.shipment.findUnique({ where: { id: input.shipmentId } });
      if (!shipment || shipment.deletedAt || shipment.status === 'Cancelled') throw businessError('SHIPMENT_NOT_FOUND', '关联运单不存在或已取消');
      if (!['Shipped','Arrived','Cleared','Delivered'].includes(shipment.status)) throw businessError('INVALID_STATE', '内部交付只能引用真实已出运的运单，草稿运输不能成为交付事实');
      const allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId: shipment.id, orderId: payload.fabricOrderId, orderLineId: payload.fabricOrderLineId, ...(input.allocationId ? { id: input.allocationId } : {}) } });
      if (!allocations.length && shipment.orderId !== payload.fabricOrderId) throw businessError('SHIPMENT_NOT_OF_FABRIC_ORDER', '运单没有关联面料订单的真实行分配');
      if (allocations.length !== 1) throw businessError('INVALID_COST_SOURCE', '交付须明确唯一的真实面料订单行出运分配');
      const candidateAllocation = allocations[0];
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentOrderAllocation" WHERE "id"=${candidateAllocation.id} FOR UPDATE`);
      const allocation = await tx.shipmentOrderAllocation.findUnique({ where: { id: candidateAllocation.id } });
      if (!allocation || allocation.shipmentId !== shipment.id || allocation.orderId !== payload.fabricOrderId || allocation.orderLineId !== payload.fabricOrderLineId) throw businessError('SOURCE_CHANGED', '实际出运分配来源已变化，请重新加载');
      if (!['Fulfilled','ShortShipped'].includes(allocation.status) || allocation.actualQty == null || String(allocation.unit).toUpperCase() !== payload.unit.toUpperCase()) throw businessError('INVALID_COST_SOURCE', '实际出运分配数量或单位尚未确认');
      const allocated = payload.deliveries.filter(row => row.allocationId === allocation.id).reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0));
      if (allocated.add(input.quantity).gt(allocation.actualQty) || transportTotals(payload).shipped.add(input.quantity).gt(payload.confirmedQuantity!)) throw businessError('OVER_DELIVERY', '累计内部交付超过真实出运或批准数量');
      if (input.packingLines?.length && (input.packingLines.some(row => !row.cartonNo?.trim() || !Number.isFinite(row.quantity) || row.quantity <= 0) || !input.packingLines.reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0)).eq(input.quantity))) throw businessError('INVALID_INPUT', '装箱明细数量须与本次交付匹配');
      const delivery: InternalTransferDelivery = { id: genId('ITD'), shipmentId: shipment.id, shipmentNumber: shipment.shipmentNumber, allocationId: allocation.id, quantity: input.quantity, unit: payload.unit,
        deliveryDate: input.deliveryDate ?? today(), receivedQuantity: null, receivedDate: null, variance: null, packingLines: input.packingLines ?? [], registeredBy: input.actorId, registeredAt: isoNow(), requestKey, requestFingerprint: fingerprint };
      delivery.auditId = await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'service:internal-trade:delivery', operation: 'internal_transfer_delivery', targetType: 'OrderInternalTransfer', targetId: master.id, before: null, after: deliveryFact(delivery) });
      const next = { ...payload, deliveries: [...payload.deliveries, delivery], receipts: [...(payload.receipts ?? [])] };
      if (input.receivedQuantity !== undefined) await appendReceipt(tx, next, { id: master.id, actorId: input.actorId, deliveryId: delivery.id, quantity: input.receivedQuantity, receivedDate: input.receivedDate ?? delivery.deliveryDate, requestId: `${requestKey}:inline` });
      const transfer = await saveTransport(tx, master, next, input.actorId);
      return { transfer, delivery: next.deliveries[next.deliveries.length - 1], cumulativeDelivered: transportTotals(next).shipped.toNumber(), status: next.status, payload: next };
    }, '内部供料单交付登记');
  }
  async function registerReceipt(input: RegisterReceiptInput): Promise<InternalTransferResult<{ transfer: any; receipt: InternalTransferReceipt; payload: InternalTransferPayload }>> {
    return write(async tx => {
      const { master, payload } = await lockNative(tx, input.id);
      await authorize(tx, input.actorId, input.trustedActor, [payload.garmentOrderId, payload.fabricOrderId]);
      await readInternalTransferAccountingFacts(tx, master);
      const next = JSON.parse(JSON.stringify(payload)) as InternalTransferPayload;
      const receipt = await appendReceipt(tx, next, input);
      if (next.receipts?.length === payload.receipts?.length) return { transfer: master, receipt, payload };
      if (payload.status !== 'Effective' && payload.status !== 'Delivering') throw businessError('INVALID_STATE', '已结案内部供料不能新增收货');
      const transfer = await saveTransport(tx, master, next, input.actorId);
      return { transfer, receipt, payload: next };
    }, '内部供料单收货登记');
  }

  // ══════════════════════════════════════════════════════════════════
  // cancelInternalTransfer — 仅 Draft/PendingConfirm 可取消（生效后须走订单变更/例外链，不在本域）
  // ══════════════════════════════════════════════════════════════════
  async function cancelInternalTransfer(input: { id: string; actorId: string; reason?: string; trustedActor?: TokenPayload }): Promise<InternalTransferResult<{ transfer: any; payload: InternalTransferPayload }>> {
    return write(async tx => {
      const { master, payload } = await lockNative(tx, input.id);
      await authorize(tx, input.actorId, input.trustedActor, [payload.garmentOrderId, payload.fabricOrderId]);
      if (payload.status !== 'Draft' && payload.status !== 'PendingConfirm') throw businessError('INVALID_TRANSFER_STATE', '仅未生效内部供料可取消，已生效须走正式变更流程');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ApprovalRequest" WHERE "id"=${payload.settlementApprovalId} FOR UPDATE`);
      const next: InternalTransferPayload = { ...payload, status: 'Cancelled', history: [...payload.history, { from: payload.status, to: 'Cancelled', actorId: input.actorId, at: isoNow(), note: input.reason?.trim() || '取消内部供料单' }] };
      const transfer = await tx.orderInternalTransfer.update({ where: { id: master.id }, data: { memo: encodeInternalTransferPayload(next) } });
      await syncMirror(tx, next, Number(master.transferAmount));
      await tx.approvalRequest.updateMany({ where: { id: payload.settlementApprovalId, status: 'pending' }, data: { status: 'cancelled', decidedAt: businessNowDate(), decisionNote: `内部供料单 ${master.id} 已取消` } });
      await writeRouteAuditLog({ prisma: tx, actorId: input.actorId, source: 'service:internal-trade:cancel', operation: 'internal_transfer_cancel', targetType: 'OrderInternalTransfer', targetId: master.id, before: { status: payload.status }, after: { status: 'Cancelled', reason: input.reason?.trim() ?? null } });
      return { transfer, payload: next };
    }, '内部供料单取消');
  }

  // ══════════════════════════════════════════════════════════════════
  // 查询
  // ══════════════════════════════════════════════════════════════════
  async function readScope(db: any, prior?: TokenPayload) {
    if (!prior?.userId || !await db.userAccount.findFirst({ where: { id: prior.userId, status: 'active', deletedAt: null }, select: { id: true } })) throw businessError('FORBIDDEN', '当前账号已失效');
    const context = await createPermissionService({ prisma: db }).getUserPermissionContext(prior.userId);
    if (!context) throw businessError('FORBIDDEN', '当前账号权限不可核对');
    const actor: TokenPayload = { userId: prior.userId, roles: context.legacyRoleCodes, roleIds: context.roleIds, permissions: context.scopes, departmentIds: context.departmentIds, authorizationLoaded: true, ...(prior.permissionCeiling ? { permissionCeiling: [...prior.permissionCeiling] } : {}) };
    if (!hasScope(actor, 'orders:read') && !(context.scopes.includes('order:internal_trade:write') && hasScope(actor, 'order:internal_trade:write'))) throw businessError('FORBIDDEN', '当前账号缺少内部供料查看授权');
    const scope = await buildOrderListScopeWhere(db, actor);
    const orders = await db.order.findMany({ where: { deletedAt: null, AND: [scope] }, select: { id: true } });
    return new Set<string>(orders.map((order: any) => order.id));
  }
  const visiblePair = (master: any, payload: InternalTransferPayload | null, visible: Set<string>) => !!payload
    && payload.masterId === master.id && payload.role === 'master' && master.orderId === payload.garmentOrderId
    && visible.has(payload.garmentOrderId) && visible.has(payload.fabricOrderId);
  async function getInternalTransferById(id: string, trustedActor?: TokenPayload) {
    return prisma.$transaction(async (db: any) => {
      const visible = await readScope(db, trustedActor);
      const master = await resolveMaster(id, db);
      if (!master) return null;
      const payload = decodeInternalTransferPayload(master.memo);
      if (!visiblePair(master, payload, visible)) return null;
      const mirror = payload?.mirrorId ? await db.orderInternalTransfer.findUnique({ where: { id: payload.mirrorId } }) : null;
      if (!mirror || mirror.deletedAt || mirror.orderId !== payload?.fabricOrderId) return null;
      return { master, mirror, payload };
    }, TX);
  }

  /**
   * 列表（按部门/状态/订单过滤）。
   * 注意（schema 冻结权衡）：状态在 memo JSON 内，无法下推 SQL，本函数在内存过滤后分页；
   * 数据量受 limit≤500 保护，schema 解冻后应改为列查询。
   */
  async function listInternalTransfers(query: {
    departmentId?: string;
    status?: InternalTransferStatus;
    garmentOrderId?: string;
    fabricOrderId?: string;
    limit?: number;
    offset?: number;
    trustedActor?: TokenPayload;
  }) {
    return prisma.$transaction(async (db: any) => {
    const visible = await readScope(db, query.trustedActor);
    const take = Math.min(query.limit || 100, 500);
    const skip = query.offset || 0;

    const where: any = { deletedAt: null, transferDirection: 'incoming' };
    if (query.garmentOrderId) where.orderId = query.garmentOrderId;
    if (query.departmentId) where.ourDepartmentId = query.departmentId;

    let rows: any[] = await db.orderInternalTransfer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    // 面料订单维度过滤（经 mirror 反查 master）
    if (query.fabricOrderId) {
      const mirrors: any[] = await db.orderInternalTransfer.findMany({
        where: { deletedAt: null, transferDirection: 'outgoing', orderId: query.fabricOrderId },
      });
      const masterIds = new Set(
        mirrors.map((m) => decodeInternalTransferPayload(m.memo)?.masterId).filter(Boolean) as string[],
      );
      rows = rows.filter((r) => masterIds.has(r.id));
    }

    let items = rows.map((record) => ({ record, payload: decodeInternalTransferPayload(record.memo) })).filter(item => visiblePair(item.record, item.payload, visible));
    if (query.status) {
      items = items.filter((it) => it.payload?.status === query.status);
    }
    const total = items.length;
    items = items.slice(skip, skip + take);
    return { items, total };
    }, TX);
  }

  return {
    createInternalTransfer,
    confirmInternalTransfer,
    reviseInternalTransferPrice,
    registerDelivery,
    registerReceipt,
    cancelInternalTransfer,
    getInternalTransferById,
    listInternalTransfers,
  };
}

export type InternalTransferService = ReturnType<typeof createInternalTransferService>;
