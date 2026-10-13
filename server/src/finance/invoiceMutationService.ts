import { businessNowDate } from '../shared/businessClock';
import { assertInvoiceFileLedgerInput } from './invoiceAttachmentService';
import { beginBulkFirst, finishBulkFirst, bulkFirstSourceIdentity, type BulkFirstRefusal } from './bulkFirstInvoiceCommand';
import type { TokenPayload } from '../auth/service';
import { currentProformaActor } from './proformaInvoiceAccess';
import { createPermissionService } from '../auth/permissionService';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { lockInvoiceFinancialSources } from '../shipping/shipmentFinancialAuthority';
import { businessError } from '../shared/errorCodes';
import { SUPPLIER_VAT_PAYABLE_SOURCE } from './supplierVatPayableSource';
import { FABRIC_COMMISSION_SOURCE } from './fabricCommissionSource';
import { assertGenericFabricGoodsReceivable, assertBusinessCiGoodsResponsibility } from './fabricCommissionGoodsGuard';
import { lockSupplierClaimInvoice } from './supplierClaimSettlementGuard';
import { releaseSupplierClaimInvoiceInTx } from './supplierClaimInvoiceRelease';
import { assertDevelopmentBillingCoverageCurrentInTx } from '../development/developmentBillingCoverageService';
import { assertDevelopmentFinanceTaskCurrentInTx } from '../development/developmentFinanceTask';
import { Prisma, PrismaClient } from '@prisma/client';
import { syncInvoiceReferences } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { validateStatusTransition } from '../statusTransition';
import { publishBusinessEvent } from '../events/businessEventBus';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { notifyCustomerCreditRecalc } from '../credit/creditService';
import { parseCreditDaysFromPaymentTerms, addDays } from '../shipping/orderShipmentBatchService';
import { notifyShipmentBatchSettlementRecalc } from './shipmentBatchSettlementHook';
// ★ 派生字段一致性（L2 变异 #8 配套，2026-09-17）：Invoice.status 是**派生字段**
//   （真源 = Σ InvoiceAllocation vs amount）。本服务允许改 amount，就必须在写入点重算，
//   否则状态与净额脱钩 —— 详见 updateInvoice 内的注释与真库演练
//   scripts/acceptance-invoice-amount-recalc.mjs。
import { recalcInvoiceStatus, sumAppliedAmount } from './allocationService';
import { settlementBasisOf } from '../shared/invoiceSettlementBasis';
import crypto from 'crypto';
// ★ 同客户校验（L2 高危 2 号，2026-09-17）：判定逻辑抽到 allocationCustomerGuard.ts
//   —— 纯函数零依赖，前端（FinanceManager 预筛）与跨层对撞测试都能安全 import，
//      不会把 @prisma/client / creditService 拖进前端类型检查。此处 re-export 保持单一入口。
import { findAllocationCustomerViolation } from './allocationCustomerGuard';
// ★ G-4：L/C 开票门禁 + DR-013 豁免查询（例外留痕在例外申请/审批侧，本模块不另造机制）
import { decideLcGate, LC_INVOICE_ISSUE_ACTION } from '../customs/lcGate';
// ★ G-4：抛点的 statusCode 查注册表真源 —— 见下方 throw 处的 B32/B34 说明
import { isBusinessError, lookupErrorCode } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { readBusinessShipmentCiVersionInTx } from '../customs/businessShipmentCiSnapshot';
import { documentSourceFingerprint } from '../shipping/shipmentDocumentSource';
import { DEVELOPMENT_CI_SOURCE, DEVELOPMENT_CI_PREFIX, readDevelopmentCiVersionInTx, ciHash } from '../development/developmentCiSource';
import { assertDevelopmentBillingNotClaimedInTx, lockDevelopmentCiDocumentsInTx } from '../development/developmentCommercialBillingService';
import { assertDevelopmentCiInvoiceLineSet, assertDevelopmentBillingInvoiceFacts } from './developmentCiArMembers';
import { todayLocalKey } from '../shared/localDate';

export { findAllocationCustomerViolation };
export type { OrderCustomerRow, InvoiceCustomerRef, AllocationCustomerViolationCode } from './allocationCustomerGuard';

export type InvoiceMutationErrorCode =
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'ACCOUNT_DISABLED'
  | 'AUTHORIZATION_UNAVAILABLE'
  | 'ORDER_NOT_FOUND'
  | 'INVALID_STATUS'
  | 'INVALID_TRANSITION'
  | 'INVALID_CURRENT_STATUS'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'NOT_FOUND'
  | 'STATUS_NOT_MANUAL_SETTABLE'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'LINE_ALREADY_ALLOCATED'
  /** 合并开票：分配的多个订单不属于同一客户（应收/账龄/授信会挂错人） */
  | 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH'
  /** 票头客户与所锚定订单的客户不一致（票开给了另一个客户） */
  | 'INVOICE_CUSTOMER_MISMATCH'
  /** 改金额到低于「已核销合计」→ 会制造超额核销（净额为负）。需先撤销核销再改。 */
  | 'AMOUNT_BELOW_ALLOCATED'
  | 'HAS_ALLOCATIONS'
  | 'SOURCE_CLAIM_CONFLICT'
  | 'REVIEW_STALE'
  | 'REVIEW_REQUIRED'
  | 'COVERAGE_CONFLICT'
  | 'INVALID_BILLING_SOURCE'
  | 'HANDOFF_CONFLICT'
  /** ★ G-4（矩阵 :136 第 3 道）：付款方式为信用证的订单开票前必须已登记且未过期 */
  | 'LC_GATE_BLOCKED'
  /** 条款不满足、但**例外状态查不出来** ⇒ 仍阻断；单列一个码，因为"下一步"完全不同（修服务，不是补证） */
  | 'LC_EXCEPTION_CHECK_FAILED';

export interface InvoiceMutationError { code: InvoiceMutationErrorCode; message: string; details?: unknown; }
export interface InvoiceMutationResult { ok: boolean; bulkFirstRejection?: any; data?: { invoice: any; auditId: string; bulkFirstAcknowledgement?: any; replayed?: boolean }; error?: InvoiceMutationError; }
export type InvoiceMutationInput = Record<string, any>;

export const INVOICE_CREATE_FIELDS = ['id', 'invoiceNumber', 'type', 'status', 'amount', 'currency', 'issueDate', 'dueDate', 'exchangeRate', 'baseCurrency', 'orderId', 'customerRelationId', 'customerName', 'notes', 'attachments', 'sourceType', 'sourceId'] as const;
export const INVOICE_PATCH_FIELDS = ['type', 'status', 'amount', 'currency', 'issueDate', 'dueDate', 'exchangeRate', 'baseCurrency', 'orderId', 'customerRelationId', 'customerName', 'notes', 'attachments'] as const;

const DECIMAL_FIELDS = new Set(['amount', 'exchangeRate']);

// ───────────────────────────────────────────────────────────────────
// 修复2（财务输入服务端防线）：币种白名单 + 金额/汇率符号校验
// 币种是账龄/对账/多币种分组的全部分组键，自由文本输入一旦落库即污染全部下游口径；
// 汇率 ≤0 / 金额 <0 同理（isValidDecimalInput 原仅校验可解析性，接受负数与 0）。
// 白名单来源：ExchangeRate 档案既有币种（USD/EUR/GBP/JPY/HKD）∪ 计价基础币种 CNY
//   ∪ 常用贸易币种（AUD/CAD）；发票/凭证共用同一白名单（单一真源，禁止两处漂移）。
// ───────────────────────────────────────────────────────────────────
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'HKD', 'AUD', 'CAD'] as const;

export function isSupportedCurrency(v: unknown): boolean {
  return typeof v === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(v.trim());
}

/** 字段级符号规则：汇率必须 >0（≤0 拒绝）；金额类（amount 等）必须 ≥0（<0 拒绝） */
const POSITIVE_ONLY_FIELDS = new Set(['exchangeRate']);
const NON_NEGATIVE_FIELDS = new Set(['amount']);

function validateAmountAndCurrencyFields(data: Record<string, any>): InvoiceMutationError | null {
  for (const field of Object.keys(data)) {
    if (POSITIVE_ONLY_FIELDS.has(field) && data[field] !== undefined && data[field] !== null) {
      try {
        if (new Prisma.Decimal(data[field]).lte(0)) {
          return { code: 'INVALID_AMOUNT', message: `${field} 必须为正数（>0），收到 ${data[field]}` };
        }
      } catch { /* normalizeDecimalFields 已保证可解析，此处不重复报错 */ }
    }
    if (NON_NEGATIVE_FIELDS.has(field) && data[field] !== undefined && data[field] !== null) {
      try {
        if (new Prisma.Decimal(data[field]).lt(0)) {
          return { code: 'INVALID_AMOUNT', message: `${field} 不能为负数，收到 ${data[field]}` };
        }
      } catch { /* 同上 */ }
    }
    if ((field === 'currency' || field === 'baseCurrency') && data[field] !== undefined && data[field] !== null) {
      if (!isSupportedCurrency(data[field])) {
        return {
          code: 'INVALID_CURRENCY',
          message: `${field} 必须是以下币种之一：${SUPPORTED_CURRENCIES.join(' / ')}（收到 ${JSON.stringify(data[field])}）`,
        };
      }
      data[field] = String(data[field]).trim();
    }
  }
  return null;
}

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

/** 服务器本地日期 YYYY-MM-DD（invoice.issueDate 为 schema 必填，缺省默认开票当天） */
function localToday(): string {
  const now = businessNowDate();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

function decimalString(v: any): string | null {
  if (v === undefined || v === null) return null;
  return typeof v?.toString === 'function' ? v.toString() : String(v);
}

function isValidDecimalInput(v: unknown): boolean {
  if (v === undefined) return true;
  if (v === null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
    try { return new Prisma.Decimal(v).isFinite(); } catch { return false; }
  }
  return false;
}

function pick(input: any, fields: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const field of fields) if (input?.[field] !== undefined) out[field] = input[field];
  return out;
}

function normalizeDecimalFields(data: Record<string, any>): { ok: true; data: Record<string, any> } | { ok: false; field: string } {
  for (const field of Object.keys(data)) {
    if (!DECIMAL_FIELDS.has(field)) continue;
    if (!isValidDecimalInput(data[field])) return { ok: false, field };
    if (data[field] !== undefined) data[field] = new Prisma.Decimal(data[field]);
  }
  return { ok: true, data };
}

/**
 * ★ B140：这张票**要不要写这一行**的判据。校验侧与写入侧必须共用同一份 ——
 * 各自写一份会朝两个方向漂：校验少一行 = 洞还开着；校验多一行 = 把本来会被丢掉的行变成拒单（那是行为变更）。
 */
function isIssuableInvoiceLine(l: any): boolean {
  return Boolean(l && l.sourceType && l.sourceId);
}

/**
 * ★ B140：行级开票此前**只有表头过金额门禁**（`normalizeCreateInput` 拒非法 amount），
 * 而行是 `new Prisma.Decimal(l.amount ?? 0)` 直接进库 ⇒ 实测三种坏法：
 * 垃圾串/布尔抛 DecimalError 撞路由 catch = **500**（用户被告知"你的请求有问题"都没说清），
 * `NaN` **一路通过到写调用**（`new Prisma.Decimal(NaN)` 不抛，改前的服务层一次都不拒）。
 * ★★ v3.21 更正（台账 B140 同批）：「通过到写调用」不等于「落库」—— 真库侧探针实测两种 NaN 都被拒、整条事务回滚，
 *   所以这一族的真实危害是**用户错误被答成 500 + 整单失败**，不是"静默写进一张 NaN 的钱"；
 *   而且别把阶段写死（这版 Prisma 先连接后校验，"客户端拒"离线证不了）。可复跑的证人是
 *   `__tests__/moneyArrivalGate.test.ts`（断言"非法金额不到达任何写调用"，不主张库的行为）。
 * 本函数只补"能不能解析"这一半：**不判符号**（负数行是既有口径，冲减/折让走这条路）、
 * **不管"没填"**（⇒ 0 属 §12.1 第 28 条同族，等 Kevin 拍），两件事各有用例钉着。
 */
function validateInvoiceLineAmounts(input: any): InvoiceMutationError | null {
  const raw = input?.invoiceLines;
  if (raw == null) return null;
  if (!Array.isArray(raw)) return { code: 'INVALID_AMOUNT', message: 'invoiceLines 必须是数组' };
  for (let i = 0; i < raw.length; i += 1) {
    const l = raw[i];
    if (!isIssuableInvoiceLine(l)) continue;
    if (l.amount === undefined || l.amount === null) continue;
    if (!isValidDecimalInput(l.amount)) {
      return { code: 'INVALID_AMOUNT', message: `invoiceLines[${i}].amount 不是合法十进制数（须为有限数值或纯数字字符串）` };
    }
  }
  return null;
}

function normalizeCreateInput(input: InvoiceMutationInput): { ok: true; data: Record<string, any> } | { ok: false; error: InvoiceMutationError } {
  const data = pick(input || {}, INVOICE_CREATE_FIELDS as any);
  const status = input?.status ?? 'Draft';
  if (input?.status != null && typeof input.status !== 'string') return { ok: false, error: { code: 'INVALID_STATUS', message: 'status must be a non-null string' } };
  const transition = validateStatusTransition('Invoice', 'Draft', status);
  if (!transition.ok) return { ok: false, error: { code: transition.error as InvoiceMutationErrorCode, message: transition.message! } };
  data.status = status;
  // schema 必填兜底：issueDate 缺省/空串时默认开票当天（前端日期可空，业务语义=创建日）
  if (data.issueDate === undefined || data.issueDate === null || data.issueDate === '') {
    data.issueDate = localToday();
  }
  if (!Object.prototype.hasOwnProperty.call(input || {}, 'amount') || input.amount === undefined || input.amount === null || !isValidDecimalInput(data.amount)) {
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'amount must be a valid decimal' } };
  }
  const normalized = normalizeDecimalFields(data);
  if (!normalized.ok) {
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: `${normalized.field} must be a valid decimal` } };
  }
  const businessError = validateAmountAndCurrencyFields(normalized.data);
  if (businessError) return { ok: false, error: businessError };
  return { ok: true, data: normalized.data };
}

function normalizeUpdateInput(input: InvoiceMutationInput): { ok: true; data: Record<string, any>; hasStatus: boolean } | { ok: false; error: InvoiceMutationError } {
  const data = pick(input || {}, INVOICE_PATCH_FIELDS as any);
  const hasStatus = Object.prototype.hasOwnProperty.call(input || {}, 'status');
  if (hasStatus && typeof input.status !== 'string') return { ok: false, error: { code: 'INVALID_STATUS', message: 'status must be a non-null string' } };
  const normalized = normalizeDecimalFields(data);
  if (!normalized.ok) {
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: `${normalized.field} must be a valid decimal` } };
  }
  const businessError = validateAmountAndCurrencyFields(normalized.data);
  if (businessError) return { ok: false, error: businessError };
  return { ok: true, data: normalized.data, hasStatus };
}

/**
 * 可原样透传给 route 的业务错误码白名单（route 据此映射 HTTP 状态码）。
 *
 * ⚠️ 结构性陷阱（本仓已踩两次）：这是**白名单**式映射 —— 不在名单里的码会被兜成
 * fallback（`CREATE_FAILED` / `UPDATE_FAILED`）→ route 映射 **500**，用户看到
 * 「服务器错误」而实际只是「参数/状态不对」。**每加一个新业务码都要问一句：
 * 「它不在名单里时会变成什么？」** 并同时补 route 的 statusCodeMap。
 * （前一次是 `allocationMutationService.toAllocationError`，2026-09-17 真库演练 T5 抓到；
 *   这一次是 `AMOUNT_BELOW_ALLOCATED`，同日真库演练 S5 抓到。）
 */
const PASSTHROUGH_ERROR_CODES: readonly InvoiceMutationErrorCode[] = [
  'CONFLICT', 'FORBIDDEN', 'UNAUTHORIZED', 'ACCOUNT_DISABLED', 'AUTHORIZATION_UNAVAILABLE', 'ORDER_NOT_FOUND',
  'INVALID_STATUS', 'INVALID_TRANSITION', 'INVALID_CURRENT_STATUS', 'INVALID_AMOUNT',
  'INVALID_CURRENCY', 'NOT_FOUND', 'STATUS_NOT_MANUAL_SETTABLE', 'LINE_ALREADY_ALLOCATED',
  'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH', 'INVOICE_CUSTOMER_MISMATCH', 'AMOUNT_BELOW_ALLOCATED', 'HAS_ALLOCATIONS', 'SOURCE_CLAIM_CONFLICT',
  'REVIEW_STALE', 'REVIEW_REQUIRED', 'COVERAGE_CONFLICT', 'INVALID_BILLING_SOURCE', 'HANDOFF_CONFLICT',
  // G-4：L/C 门禁两码必须透传 —— 否则"被信用证挡住"会塌成 CREATE_FAILED「事务失败请重试」，
  //       而真正的下一步是去登记信用证（或排查例外服务），重试是没用的。
  'LC_GATE_BLOCKED', 'LC_EXCEPTION_CHECK_FAILED',
];

function toError(e: unknown, fallback: 'CREATE_FAILED' | 'UPDATE_FAILED'): InvoiceMutationError {
  if (isBusinessError(e) && (PASSTHROUGH_ERROR_CODES as readonly string[]).includes(e.code)) {
    const safe = safeRouteError(e, { fallbackCode: fallback });
    return { code: e.code as InvoiceMutationErrorCode, message: safe.message,
      ...(safe.details === undefined ? {} : { details: safe.details }) };
  }
  // Unknown database/driver exceptions and incomplete error shapes are not
  // public financial validation. Keep their diagnostic text in server logs only.
  logger.error(`[InvoiceMutationService] ${fallback}`, { error: e instanceof Error ? e.message : String(e) });
  // A typed-but-unsupported error still cannot become public invoice validation.
  const unknown = safeRouteError(undefined, { fallbackCode: fallback,
    fallbackMessage: fallback === 'CREATE_FAILED'
      ? '发票创建结果暂不可确认，请先核对原发票记录后重试。'
      : '发票更新结果暂不可确认，请先刷新核对原发票记录后重试。',
  });
  return { code: fallback, message: unknown.message };
}

/**
 * 解析发票的多订单分配输入（T2/H14 分批开票，方案 A）。
 * 两种入参（可并存）：
 *   - orderIds: string[]                              —— 旧口径，整单分摊（allocatedAmount=null、batchId=null）
 *   - orderAllocations: [{ orderId, batchId?, allocatedAmount?, note? }] —— 新口径
 * 口径硬约束（真源 orderShipmentBatchService.recalcSettlement）：
 *   - IOA.allocatedAmount 为 null 会被读侧视为**整单金额** ⇒ 带 batchId 时 allocatedAmount
 *     禁止为空，否则该批已开票金额被虚增成整单额。
 *   - batchId 必须指向该订单名下未软删的批次（OrderShipmentBatch.orderId 一致），事务内校验。
 */
export interface InvoiceOrderAllocationInput {
  orderId: string;
  batchId?: string | null;
  allocatedAmount?: number | string | null;
  note?: string | null;
}

export function resolveOrderAllocations(input: any): { ok: true; orderIds?: string[]; allocations?: InvoiceOrderAllocationInput[] } | { ok: false; error: InvoiceMutationError } {
  const raw = input?.orderIds;
  let orderIds: string[] | undefined;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw) || raw.some((id: any) => typeof id !== 'string' || !id.trim())) {
      return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'orderIds must be an array of non-empty strings' } };
    }
    orderIds = Array.from(new Set(raw.map((id: string) => id.trim())));
  }

  const rawAllocs = input?.orderAllocations;
  let allocations: InvoiceOrderAllocationInput[] | undefined;
  if (rawAllocs !== undefined && rawAllocs !== null) {
    if (!Array.isArray(rawAllocs)) {
      return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'orderAllocations must be an array of { orderId, batchId?, allocatedAmount? }' } };
    }
    allocations = [];
    for (const a of rawAllocs) {
      const orderId = typeof a?.orderId === 'string' ? a.orderId.trim() : '';
      if (!orderId) {
        return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'orderAllocations[].orderId is required' } };
      }
      const batchId = typeof a?.batchId === 'string' && a.batchId.trim() ? a.batchId.trim() : null;
      let allocatedAmount: string | null = null;
      if (a?.allocatedAmount !== undefined && a?.allocatedAmount !== null) {
        if (typeof a.allocatedAmount === 'number' ? !Number.isFinite(a.allocatedAmount) : !/^\s*-?\d+(\.\d+)?\s*$/.test(String(a.allocatedAmount))) {
          return { ok: false, error: { code: 'INVALID_AMOUNT', message: `orderAllocations[].allocatedAmount 非法：${JSON.stringify(a.allocatedAmount)}` } };
        }
        allocatedAmount = String(a.allocatedAmount).trim();
        try {
          if (new Prisma.Decimal(allocatedAmount).lte(0)) {
            return { ok: false, error: { code: 'INVALID_AMOUNT', message: `orderAllocations[].allocatedAmount 必须 > 0，收到 ${allocatedAmount}` } };
          }
        } catch { /* 上面正则已挡 */ }
      }
      // 方案 A 语义漏洞防线：批次票不显式给分摊金额 = 读侧按整单额虚增该批已开票
      if (batchId && allocatedAmount == null) {
        return { ok: false, error: { code: 'INVALID_AMOUNT', message: '批次开票（batchId）必须显式传 allocatedAmount——缺省会被结算聚合按整单金额计入该批（虚增已开票）' } };
      }
      allocations.push({
        orderId,
        batchId,
        allocatedAmount,
        note: typeof a?.note === 'string' && a.note.trim() ? a.note.trim() : null,
      });
    }
  }

  if (orderIds === undefined && allocations === undefined) return { ok: true };
  // 合并去重：同一 orderId 只保留一条（@@unique([invoiceId, orderId]) 数据库层兜底）
  const merged = new Map<string, InvoiceOrderAllocationInput>();
  for (const id of orderIds ?? []) merged.set(id, { orderId: id });
  for (const a of allocations ?? []) merged.set(a.orderId, { ...(merged.get(a.orderId) ?? { orderId: a.orderId }), ...a });
  const finalAllocations = [...merged.values()];
  return { ok: true, orderIds: finalAllocations.map((a) => a.orderId), allocations: finalAllocations };
}

/**
 * 事务内写入发票↔订单分配（发票 ↔ 订单多对多）。
 * create：直接插入分配行；update：保留同 invoice/order 的 identity 并复用历史行，移除项仅软删。
 * 订单号快照取 Order.code（SO-xxx 业务编号，由 SequenceRegister 分配），PO 取 Order.poNumber。
 * 批次维度（T2/H14 方案 A）：batchId 校验存在 + 归属该订单 + 未软删/未取消后落库。
 */
export async function syncInvoiceOrderAllocations(
  tx: any,
  invoice: { id: string; type?: string | null; customerRelationId?: string | null; customerName?: string | null },
  allocations: InvoiceOrderAllocationInput[] | undefined,
  replacementRows?: any[],
): Promise<void> {
  if (!allocations) return;
  if (allocations.length === 0 && replacementRows === undefined) return;
  const now = BigInt(Date.now());
  const orderIds = allocations.map((a) => a.orderId);
  const rows: Array<{ id: string; code: string | null; poNumber: string | null; customerRelationId: string | null; customer: string | null }> =
    await tx.order.findMany({
      where: { id: { in: orderIds }, deletedAt: null },
      // customerRelationId / customer 是「同客户」校验的依据（2026-09-17 加）
      select: { id: true, code: true, poNumber: true, customerRelationId: true, customer: true },
    }) || [];
  const byId = new Map(rows.map((o) => [o.id, o]));
  // The unique invoice/order pair includes soft-deleted rows. Preserve its
  // original identity rather than trying to create a second historical pair.
  const previousByOrderId = new Map((replacementRows ?? []).map(row => [row.orderId, row]));

  // 批次校验（一次性取齐）：存在 + 未软删 + 未取消 + 归属对应订单
  const batchIds = [...new Set(allocations.map((a) => a.batchId).filter((b): b is string => !!b))];
  const batchRows: Array<{ id: string; orderId: string; deletedAt: BigInt | null; status: string; shipmentId?: string | null }> = batchIds.length > 0
    ? await tx.orderShipmentBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, orderId: true, deletedAt: true, status: true, shipmentId: true } })
    : [];
  const batchById = new Map(batchRows.map((b: any) => [b.id, b]));

  // ★ 同客户校验（2026-09-17 加，L2 高危 2 号）—— 判定逻辑见 findAllocationCustomerViolation
  const allocatedOrders = allocations.map((a) => byId.get(a.orderId)).filter((o): o is NonNullable<typeof o> => !!o);
  const violation = findAllocationCustomerViolation(allocatedOrders, invoice);
  if (violation) throw Object.assign(new Error(violation.message), { code: violation.code, statusCode: 409 });

  for (const a of allocations) {
    const o = byId.get(a.orderId);
    if (!o) {
      throw Object.assign(new Error(`订单 ${a.orderId} 不存在或已删除，无法写入发票分配`), { code: 'INVALID_AMOUNT', statusCode: 400 });
    }
    if (a.batchId) {
      const batch = batchById.get(a.batchId);
      if (!batch || batch.deletedAt != null) {
        throw Object.assign(new Error(`批次 ${a.batchId} 不存在或已删除`), { code: 'INVALID_AMOUNT', statusCode: 400 });
      }
      if (batch.orderId !== a.orderId) {
        throw Object.assign(new Error(`批次 ${a.batchId} 不属于订单 ${a.orderId}（归属 ${batch.orderId}），拒绝锚定`), { code: 'INVALID_AMOUNT', statusCode: 400 });
      }
      if (batch.status === 'cancelled') {
        throw Object.assign(new Error(`批次 ${a.batchId} 已取消，不可开票锚定`), { code: 'INVALID_AMOUNT', statusCode: 400 });
      }
      if (batch.shipmentId) {
        const shipment = await tx.shipment.findUnique({ where: { id: batch.shipmentId } });
        if (!shipment || shipment.deletedAt != null || shipment.status === 'Cancelled')
          throw businessError('CONFLICT', '原出运已取消或不可用，本批不能继续新增或改绑发票。');
      }

    }
    const data = {
      orderNumber: o.code ?? null,
      poNumber: o.poNumber ?? null,
      allocatedAmount: a.allocatedAmount != null ? new Prisma.Decimal(a.allocatedAmount) : null,
      batchId: a.batchId ?? null,
      note: a.note ?? null,
      updatedAt: now,
    };
    const previous = previousByOrderId.get(a.orderId);
    if (previous) {
      await tx.invoiceOrderAllocation.update({
        where: { id: previous.id },
        data: { ...data, deletedAt: null },
      });
    } else {
      await tx.invoiceOrderAllocation.create({
        data: { id: generateId('IOA'), invoiceId: invoice.id, orderId: a.orderId, ...data, createdAt: now },
      });
    }
  }
  if (replacementRows !== undefined) {
    const retainedOrderIds = new Set(allocations.map(row => row.orderId));
    for (const previous of replacementRows) {
      if (previous.deletedAt != null || retainedOrderIds.has(previous.orderId)) continue;
      await tx.invoiceOrderAllocation.update({
        where: { id: previous.id },
        data: { deletedAt: now, updatedAt: now },
      });
    }
  }
}

function invoiceOrderAllocationSnapshot(row: any): Record<string, unknown> {
  return {
    id: row.id, invoiceId: row.invoiceId, orderId: row.orderId,
    orderNumber: row.orderNumber ?? null, poNumber: row.poNumber ?? null,
    allocatedAmount: decimalString(row.allocatedAmount), batchId: row.batchId ?? null,
    note: row.note ?? null, createdAt: decimalString(row.createdAt),
    updatedAt: decimalString(row.updatedAt), deletedAt: decimalString(row.deletedAt),
  };
}

/** Reuse current Finance authority for every trusted entry, including notes-only
 * changes. Caller-supplied actorId cannot replace an in-process credential. */
async function currentInvoiceWriter(tx: any, params: { actor?: TokenPayload | null; actorId?: string }) {
  if (params.actor === undefined) return null; // Explicit internal producer compatibility.
  if (!params.actor || !params.actorId || params.actor.userId !== params.actorId)
    throw businessError('UNAUTHORIZED', '开票主体无法核验。');
  try { return await currentProformaActor(tx, params.actorId, params.actor); }
  catch (error: any) {
    if (error?.code === 'DEPENDENCY_CHECK_FAILED') throw businessError('AUTHORIZATION_UNAVAILABLE', '当前开票权限暂时无法核验。');
    throw error;
  }
}
async function requireInvoiceObject(tx: any, id: string, actor: TokenPayload | null) {
  if (!actor) return;
  const scope = buildScopeWhereFromResolver(await createPermissionService({ prisma: tx }).getDataScopeResolver(actor, 'finance'), actor.userId);
  if (!await tx.invoice.findFirst({ where: { id, deletedAt: null, AND: [scope] }, select: { id: true } }))
    throw businessError('NOT_FOUND', '发票不存在或不可操作。');
}

/** Internal composition only: the outer owner must drain effects after its real commit. */
export interface InvoiceCreateTransaction {
  tx: Prisma.TransactionClient;
  deferAfterCommit: (work: () => Promise<void>) => void;
}
function rejectedBulkResult(ack: any): InvoiceMutationResult {
  return { ok: false, error: { code: ack.reasonCode === 'SOURCE_REVIEW' ? 'CONFLICT' : ack.reasonCode, message: ack.message }, bulkFirstRejection: ack };
}
/** Known pure validation still needs a committed fence; no outer catch mints a receipt. */
async function rejectBulkValidation(params: Parameters<typeof createInvoice>[0], error: InvoiceMutationError, site: BulkFirstRefusal['site']): Promise<InvoiceMutationResult> {
  if (params.input.bulkFirstIntent === undefined || params.transaction) return { ok: false, error };
  try {
    const identity = bulkFirstSourceIdentity(params.input, params.actor);
    const result = await params.prisma.$transaction(async tx => {
      await currentInvoiceWriter(tx, params);
      if (!params.actor || params.actor.userId !== params.actorId) throw businessError('UNAUTHORIZED', '开票主体无法核验。');
      await lockInvoiceFinancialSources(tx, [{ orderId: identity.orderId, batchId: identity.batchId }, { orderId: identity.orderId }], params.actor);
      const lease = await beginBulkFirst(tx, params.input, params.actor, { site, code: error.code, message: error.message });
      return lease?.replay;
    });
    if (result?.bulkFirstRejection) return rejectedBulkResult(result.bulkFirstRejection);
    if (result?.invoice) return { ok: true, data: result };
    return { ok: false, error };
  } catch (e) { return { ok: false, error: toError(e, 'CREATE_FAILED') }; }
}

export async function createInvoice(params: { prisma: PrismaClient; input: InvoiceMutationInput; actorId?: string; actor?: TokenPayload | null; ip?: string | null;
  transaction?: InvoiceCreateTransaction; businessCiRegistration?: { documentId: string; versionId: string; snapshotFingerprint: string };
  developmentCiRegistration?: { documentId: string; versionId: string; snapshotFingerprint: string } }): Promise<InvoiceMutationResult> {
  const { prisma, input, actorId, ip } = params;
  if (input?.sourceType === SUPPLIER_VAT_PAYABLE_SOURCE || input?.sourceType === FABRIC_COMMISSION_SOURCE) {
    return { ok: false, error: { code: 'HANDOFF_CONFLICT', message: '供应商原票应付或面料佣金应收须从准确原票原生入口登记，不能手填来源或状态。' } };
  }
  const nativeCiInput = input?.sourceType === 'BusinessShipmentCI';
  if ((input?.sourceType === DEVELOPMENT_CI_SOURCE) !== Boolean(params.developmentCiRegistration)
    || params.developmentCiRegistration && (!params.transaction || input?.sourceId !== params.developmentCiRegistration.versionId || input?.type !== 'Receivable' || input?.status !== 'Issued')) {
    return { ok: false, error: { code: 'HANDOFF_CONFLICT', message: '开发 CI 应收只能登记已由业务签发的准确原票，不能手工指定或改写来源。' } };
  }
  if (nativeCiInput !== Boolean(params.businessCiRegistration)
    || params.businessCiRegistration && (input?.sourceId !== params.businessCiRegistration.versionId || input?.type !== 'Receivable' || input?.status !== 'Issued')) {
    return { ok: false, error: { code: 'HANDOFF_CONFLICT', message: '出运 CI 应收只能从已签发的业务商业发票登记，不能手工创建或改写来源。' } };
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, 'attachments')) {
    try { assertInvoiceFileLedgerInput(input.attachments); }
    catch { return { ok: false, error: { code: 'CONFLICT', message: '发票文件请通过原生附件归档入口处理，不可直接改写文件引用。' } }; }
  }
  if (params.transaction && input.bulkFirstIntent !== undefined) return { ok: false, error: { code: 'CONFLICT', message: '首次按批请求须由独立开票事务核验。' } };
  const normalized = normalizeCreateInput(input);
  if (!normalized.ok) {
    return rejectBulkValidation(params, normalized.error, 'normalize');
  }
  // Commission liabilities must be derived by the verified pricing composer.
  // JSON inputs cannot provide an in-process transaction/effect callback.
  if (normalized.data.sourceType === 'CommissionPayable' && !params.transaction) {
    return { ok: false, error: { code: 'CONFLICT', message: '佣金应付请从订单的佣金核算入口生成，不能手工指定该来源。' } };
  }
  // ★ B140：行的金额门禁放在**开事务之前**。原因不是"事务内会留半张票"（抛错会回滚，票不会留下），
  //   而是那半张票里装的是什么、以及用户拿到什么档：`new Prisma.Decimal('12abc')` 抛**裸 Error**，落到路由 catch
  //   就成了 500「服务端自己没结论」。
  //   ★★ v3.21 更正（此前这句写错过，与台账 B140 的 v3.20 更正同源）：NaN 也不是在构造处抛的，
  //   但**别读成"事务会正常提交、钱会脏进库"** —— 真库侧探针实测两种 NaN 都**到不了库**（客户端/驱动层报错 + 整条事务回滚），
  //   所以真实危害是"用户错误被答成 500 + 整单失败"，不是静默脏数据（阶段归属也别写死：这版 Prisma 先连接后校验，离线证不了"客户端拒"）。
  //   放到事务外的理由与档位无关而与**可诊断性**有关：只有在那里才拿得到 400 + 点名是哪一行 ⇒ 证人见
  //   `__tests__/moneyArrivalGate.test.ts`（断言的是"非法值不到达任何写调用"，不主张库的行为）。
  const lineError = validateInvoiceLineAmounts(input);
  if (lineError) {
    return rejectBulkValidation(params, lineError, 'line-amounts');
  }
  const alloc = resolveOrderAllocations(input);
  if (!alloc.ok) {
    return rejectBulkValidation(params, alloc.error, 'allocations');
  }
  try {
    const run = params.transaction
      ? (work: (tx: any) => Promise<any>) => work(params.transaction!.tx)
      : (work: (tx: any) => Promise<any>) => (prisma as any).$transaction(work);
    const result = await run(async (tx: any) => {
      await currentInvoiceWriter(tx, params);
      if (params.actor !== undefined && (alloc.allocations?.length || normalized.data.orderId)) {
        if (!params.actor || params.actor.userId !== actorId) throw businessError('UNAUTHORIZED', '开票主体无法核验。');
        await lockInvoiceFinancialSources(tx, [...(alloc.allocations ?? []),
          ...(normalized.data.orderId ? [{ orderId: normalized.data.orderId }] : [])], params.actor);
      }
      await assertGenericFabricGoodsReceivable(tx, { ...input, ...normalized.data });

      const bulkFirst = await beginBulkFirst(tx, input, params.actor);
      if (bulkFirst?.replay) return bulkFirst.replay;

      // Every BillingItem source, including lines on a manual invoice, follows the same CI reservation protocol.
      const billingIds = [...new Set<string>([
        ...(input.sourceType === 'BillingItem' && input.sourceId ? [String(input.sourceId)] : []),
        ...(Array.isArray(input.invoiceLines) ? input.invoiceLines.filter((line: any) => line?.sourceType === 'BillingItem' && line.sourceId).map((line: any) => String(line.sourceId)) : []),
      ])].sort();
      const billingSources: any[] = [];
      for (const id of billingIds) {
        const row = await tx.billingItem.findFirst({ where: { id, deletedAt: null } });
        if (!row) throw businessError('HANDOFF_CONFLICT', '发票收费来源不存在，请核对准确成员。');
        billingSources.push(row);
      }
      const developmentCases = [...new Set<string>(billingSources.filter(row => row.sourceType === 'DevelopmentCase').map(row => row.sourceId))].sort();
      for (const caseId of developmentCases) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
      for (const id of billingIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${id} FOR UPDATE`);
      for (let index = 0; index < billingSources.length; index++) {
        const current = await tx.billingItem.findFirst({ where: { id: billingSources[index].id, deletedAt: null } });
        if (!current || ciHash(current) !== ciHash(billingSources[index])) throw businessError('HANDOFF_CONFLICT', '收费来源在取得锁时变化，请重新核对准确成员。');
        billingSources[index] = current;
      }
      const sourceCoverage = billingIds.length ? await tx.billingItemCostCoverage.findMany({ where: { billingItemId: { in: billingIds }, releasedAt: null } }) : [];
      const directCostIds = Array.isArray(input.invoiceLines) ? input.invoiceLines.filter((line: any) => line.sourceType === 'CostRecord' && line.sourceId).map((line: any) => String(line.sourceId)) : [];
      const billingCostIds = [...new Set<string>([...directCostIds, ...sourceCoverage.map((line: any) => line.costRecordId), ...billingSources.flatMap(row => [row.costRecordId,
        ...(row.developmentCommercialCostSelection?.costs?.map((cost: any) => cost.id) ?? [])]).filter(Boolean)])].sort();
      for (const id of billingCostIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${id} FOR UPDATE`);
      for (const id of billingIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCiBillingClaim" WHERE "billingItemId"=${id} ORDER BY "id" FOR UPDATE`);
      for (const caseId of developmentCases) await lockDevelopmentCiDocumentsInTx(tx, caseId);
      for (const caseId of developmentCases) await assertDevelopmentBillingNotClaimedInTx(tx, caseId,
        billingSources.filter(row => row.sourceId === caseId && row.sourceType === 'DevelopmentCase').map(row => row.id), params.developmentCiRegistration?.documentId);
      if (!params.developmentCiRegistration) for (const billing of billingSources.filter(row => row.sourceType === 'DevelopmentCase')) {
        if (billing.status !== 'confirmed' || billing.bearerType !== 'customer' || billing.invoiceId || normalized.data.type !== 'Receivable'
          || normalized.data.customerRelationId !== billing.bearerRelationId)
          throw businessError('HANDOFF_CONFLICT', '开发收费须经真实确认且归属原客户，不能从手工明细绕过收费处理。');
        const net = new Prisma.Decimal(billing.amount).minus(billing.waivedAmount).minus(billing.offsetAmount);
        const memberLines = Array.isArray(input.invoiceLines) ? input.invoiceLines.filter((line: any) => line.sourceType === 'BillingItem' && line.sourceId === billing.id) : [];
        if (!net.gt(0) || billing.currency !== normalized.data.currency || memberLines.length && (memberLines.length !== 1
          || memberLines[0].currency !== billing.currency || !net.eq(memberLines[0].amount))
          || input.sourceType === 'BillingItem' && input.sourceId === billing.id && !net.eq(normalized.data.amount))
          throw businessError('HANDOFF_CONFLICT', '开发收费原净额或币种与发票成员不一致。');
        if (billing.developmentExpenseReviewId) {
          await assertDevelopmentBillingCoverageCurrentInTx(tx, billing);
          await assertDevelopmentFinanceTaskCurrentInTx(tx, billing);
        }
      }
      if (!params.developmentCiRegistration) assertDevelopmentBillingInvoiceFacts(normalized.data, billingSources,
        Array.isArray(input.invoiceLines) ? input.invoiceLines.filter(isIssuableInvoiceLine) : []);

      if (params.businessCiRegistration) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${params.businessCiRegistration.documentId} FOR UPDATE`);
        const source = await readBusinessShipmentCiVersionInTx(tx, params.businessCiRegistration.documentId, params.actor,
          { requiredScopes: ['customs:read'] });
        const snapshot = source.snapshot;
        await assertBusinessCiGoodsResponsibility(tx, snapshot.lines);
        if (source.document.status !== 'Issued' || source.version.id !== params.businessCiRegistration.versionId
          || source.version.id !== source.latestVersion.id || !snapshot.issuedAt
          || documentSourceFingerprint(snapshot) !== params.businessCiRegistration.snapshotFingerprint
          || input.sourceType !== 'BusinessShipmentCI' || input.sourceId !== source.version.id
          || input.invoiceNumber !== source.document.documentNumber || normalized.data.type !== 'Receivable' || normalized.data.status !== 'Issued'
          || !new Prisma.Decimal(normalized.data.amount).equals(snapshot.totalAmount) || normalized.data.currency !== snapshot.currency
          || normalized.data.issueDate !== source.document.issueDate || normalized.data.customerRelationId !== snapshot.customerRelationId
          || (normalized.data.customerName ?? null) !== (snapshot.parties?.billTo?.name ?? null)) {
          throw businessError('HANDOFF_CONFLICT', '出运 CI 已变化或财务登记字段与原商业发票不一致，请刷新待登记清单。');
        }
        const expectedAmounts = new Map<string, Prisma.Decimal>();
        for (const line of snapshot.lines) expectedAmounts.set(line.orderId,
          (expectedAmounts.get(line.orderId) ?? new Prisma.Decimal(0)).plus(line.amount));
        const requestedAmounts = new Map<string, Prisma.Decimal>();
        for (const row of alloc.allocations ?? []) requestedAmounts.set(row.orderId, new Prisma.Decimal(String(row.allocatedAmount)));
        const soleOrderId = snapshot.orderIds.length === 1 ? snapshot.orderIds[0] : null;
        if (!soleOrderId && normalized.data.orderId != null || normalized.data.orderId !== soleOrderId
          || expectedAmounts.size !== requestedAmounts.size
          || [...expectedAmounts.entries()].some(([id, amount]) => !requestedAmounts.get(id)?.equals(amount))) {
          throw businessError('HANDOFF_CONFLICT', '财务订单分配必须逐订单等于该 CI 的实际出运金额。');
        }
        const alreadyRegistered = await tx.invoice.findFirst({ where: { sourceType: 'BusinessShipmentCI', sourceId: source.version.id } });
        if (alreadyRegistered) {
          if (alreadyRegistered.deletedAt != null || alreadyRegistered.invoiceNumber !== source.document.documentNumber || !new Prisma.Decimal(alreadyRegistered.amount).equals(snapshot.totalAmount)
            || alreadyRegistered.currency !== snapshot.currency || alreadyRegistered.customerRelationId !== snapshot.customerRelationId)
            throw businessError('HANDOFF_CONFLICT', '该商业发票已有财务记录，但记录与原票不一致，请先核对财务台账。');
          return { invoice: alreadyRegistered, auditId: `BUSINESS_CI_REPLAY_${alreadyRegistered.id}`, replayed: true };
        }
      }

      if (params.developmentCiRegistration) {
        const native = params.developmentCiRegistration;
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${native.documentId} FOR UPDATE`);
        const source = await readDevelopmentCiVersionInTx(tx, native.documentId, params.actor, { finance: true, writing: true });
        const snapshot = source.snapshot;
        if (source.document.status !== 'Issued' || source.version.id !== native.versionId || source.version.id !== source.latestVersion.id
          || !snapshot.issuedAt || snapshot.snapshotFingerprint !== native.snapshotFingerprint
          || normalized.data.invoiceNumber !== source.document.documentNumber || normalized.data.type !== 'Receivable' || normalized.data.status !== 'Issued'
          || !new Prisma.Decimal(normalized.data.amount).eq(snapshot.totalAmount) || normalized.data.currency !== snapshot.currency
          || normalized.data.customerRelationId !== snapshot.customerRelationId || normalized.data.customerName !== snapshot.parties.billTo.name
          || normalized.data.issueDate !== snapshot.issueDate || (normalized.data.dueDate ?? null) !== (snapshot.dueDate ?? null)
          || normalized.data.orderId != null || alloc.allocations?.length) throw businessError('HANDOFF_CONFLICT', '登记字段与已签发开发 CI 不一致。');
        assertDevelopmentCiInvoiceLineSet(snapshot, input.invoiceLines);
      }

      if (input.sourceType === 'BillingItem' && input.sourceId) {
        const initial = await tx.billingItem.findFirst({ where: { id: input.sourceId, deletedAt: null } });
        if (initial?.developmentExpenseReviewId) {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${initial.sourceId} FOR UPDATE`);
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${initial.id} FOR UPDATE`);
          const current = await tx.billingItem.findFirst({ where: { id: initial.id, deletedAt: null } });
          if (!current || current.status !== 'confirmed' || current.sourceId !== initial.sourceId) {
            throw Object.assign(new Error('收费决定已变化，请刷新'), { code: 'INVALID_TRANSITION', statusCode: 400 });
          }
          await assertDevelopmentBillingCoverageCurrentInTx(tx, current);
          await assertDevelopmentFinanceTaskCurrentInTx(tx, current);
          const net = new Prisma.Decimal(current.amount).minus(current.waivedAmount).minus(current.offsetAmount);
          if (!net.gt(0) || !net.eq(normalized.data.amount) || current.currency !== normalized.data.currency) {
            throw Object.assign(new Error('应收金额或币种与已确认收费不一致'), { code: 'INVALID_AMOUNT', statusCode: 400 });
          }
          if (current.bearerType !== 'customer' || !current.bearerRelationId || normalized.data.customerRelationId !== current.bearerRelationId) {
            throw Object.assign(new Error('应收客户与收费决定不一致，或收费决定缺少明确客户'), { code: 'INVALID_TRANSITION', statusCode: 400 });
          }
          if (normalized.data.type !== 'Receivable' || normalized.data.status !== 'Draft') {
            throw Object.assign(new Error('整案收费先生成应收草稿，再执行财务签发'), { code: 'INVALID_TRANSITION', statusCode: 400 });
          }
        }
      }
      const costIds: string[] = [...new Set<string>((Array.isArray(input?.invoiceLines) ? input.invoiceLines : [])
        .filter((line: any) => line.sourceType === 'CostRecord' && line.sourceId)
        .map((line: any) => String(line.sourceId)))].sort();
      for (const costId of costIds) {
        const locked = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${costId} AND "deletedAt" IS NULL FOR UPDATE`);
        if (!locked.length) throw Object.assign(new Error('费用记录不存在或已删除'), { code: 'LINE_ALREADY_ALLOCATED', statusCode: 409 });
        const coverage = await tx.billingItemCostCoverage.findFirst({ where: { costRecordId: costId, releasedAt: null } });
        const billing = await tx.billingItem.findFirst({ where: { costRecordId: costId, deletedAt: null, status: { not: 'cancelled' } } });
        const fromConfirmedBilling = billing && input.sourceType === 'BillingItem' && input.sourceId === billing.id && billing.status === 'confirmed';
        if (coverage || (billing && !fromConfirmedBilling)) {
          throw Object.assign(new Error('费用已被收费事项占用，请从已确认的收费事项办理'), { code: 'LINE_ALREADY_ALLOCATED', statusCode: 409 });
        }
      }
      const now = BigInt(Date.now());
      const id = generateId('INV');
      // PRD 5.6：服务端自动生成发票号（INV-YYYY-NNNN），传入时优先使用传入值
      // QA-SEC-5：必须以 occupied 占用校验追平（含软删行），避免与历史/种子发票号冲突（Unique 约束 500）
      const invoiceNumber = input.invoiceNumber || await nextBusinessNumber(tx, 'INV', undefined, {
        occupied: async (num) => {
          const dup = await tx.invoice.findFirst({ where: { invoiceNumber: num }, select: { id: true } });
          return dup != null;
        },
      });
      const data: Record<string, any> = { id, ...normalized.data, ownerId: actorId?.trim() || null, invoiceNumber, createdAt: now, updatedAt: now };
      // T2 顺带修：Receivable 未显式给 dueDate 时按订单 paymentTerms 账期推导
      //（issueDate + 账期天数；批次票由 L3 直接传 finalPaymentDueDate/推导值）。
      // 此前 dueDate 从不自动推导，两个下游（账龄/催款）对空值口径相反（虚增逾期 vs 漏催）。
      if (data.type === 'Receivable' && (data.dueDate == null || data.dueDate === '')) {
        const anchorOrderId = (data.orderId as string | undefined) ?? alloc.allocations?.[0]?.orderId ?? undefined;
        const anchor = anchorOrderId ? await tx.order.findUnique({ where: { id: anchorOrderId }, select: { paymentTerms: true } }) : null;
        const creditDays = parseCreditDaysFromPaymentTerms(anchor?.paymentTerms);
        if (creditDays != null) {
          data.dueDate = addDays(typeof data.issueDate === 'string' && data.issueDate ? data.issueDate : localToday(), creditDays);
        }
      }
      // ★ G-4（矩阵 :136 第 3 道门禁）：信用证结算的订单，开票前必须已登记且未过有效期。
      //   放在**事务内、写票之前**：① 与上面的 dueDate 推导读同一份 tx 快照 ⇒ 不存在"判完证被改"的竞态；
      //   ② 抛出即回滚 ⇒ 被阻断的请求不会留下半张票。只卡应收方向（付供应商的款与客户信用证无关）；
      //   非信用证订单在门禁内部直接放行 ⇒ 真库存量（实测 69/69 为 T/T）行为零变化。
      const lcAnchorOrderId = (data.orderId as string | undefined) ?? alloc.allocations?.[0]?.orderId ?? null;
      if (lcAnchorOrderId && data.type === 'Receivable' && !params.businessCiRegistration) {
        const lcDecision = await decideLcGate({
          prisma: tx,
          orderId: lcAnchorOrderId,
          order: await tx.order.findUnique({ where: { id: lcAnchorOrderId }, select: { paymentInstrument: true } }),
          stage: 'invoice:issue',
          exceptionAction: LC_INVOICE_ISSUE_ACTION,
        });
        if (!lcDecision.allowed) {
          // ★ statusCode 只能**查注册表真源**（shared/errorCodes），不许在这里写
          //   `code === 'LC_…' ? 500 : 403`：那会是第二份 code→status 映射（B32 判红），
          //   而 B34 又要求抛点必须带 statusCode（否则被路由的兜底分支换掉文案）。
          //   两难的正解就是把码登记进真源、这里只查表 —— 同 production/stageService.ts:95。
          throw Object.assign(
            new Error(
              lcDecision.code === 'LC_EXCEPTION_CHECK_FAILED'
                ? `信用证门禁未通过（${lcDecision.reasons.join(', ')}${lcDecision.lcLabel ? `；信用证 ${lcDecision.lcLabel}` : ''}），且无法确认是否已有 DR-013 例外 ⇒ 保持阻断，请先排查例外/审批服务`
                : `该订单以信用证结算，但${lcDecision.lcLabel ? `信用证 ${lcDecision.lcLabel} 不满足条款` : '尚未登记信用证'}（${lcDecision.reasons.join(', ')}）；请先登记/核对 L/C，确需例外按 DR-013 申请（action='${LC_INVOICE_ISSUE_ACTION}'）`,
            ),
            { code: lcDecision.code, statusCode: lookupErrorCode(lcDecision.code)?.status ?? 500 },
          );
        }
      }
      const invoice = await tx.invoice.create({ data });
      await syncInvoiceReferences(prisma, invoice, { source: 'route:invoice:create' }, tx);
      // DR-054 阶段 E：行级开票（费用行为开票唯一来源；一费用行最多一张票的一行）。
      // invoiceLines 在 createInvoice 时写入 InvoiceLine；@@unique([sourceType, sourceId]) 数据库层
      // 兜底并发，P2002 → LINE_ALREADY_ALLOCATED（重复开票被行级唯一拦截）。
      const lines = Array.isArray(input?.invoiceLines) ? input.invoiceLines.filter(isIssuableInvoiceLine) : [];
      if (lines.length > 0) {
        const lineRows = lines.map((l: any) => ({
          id: `INVLINE__${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
          invoiceId: invoice.id,
          sourceType: String(l.sourceType),
          sourceId: String(l.sourceId),
          amount: new Prisma.Decimal(l.amount ?? 0),
          currency: String(l.currency || 'CNY'),
          description: l.description != null ? String(l.description) : null,
          createdAt: now,
        }));
        try {
          await tx.invoiceLine.createMany({ data: lineRows });
        } catch (e: any) {
          if (e?.code === 'P2002') {
            throw Object.assign(new Error('费用行已被其他发票占用（一费用行最多一张票），请先作废原发票或改用未占用费用行'), { code: 'LINE_ALREADY_ALLOCATED', statusCode: 409 });
          }
          throw e;
        }
      }
      // 发票 ↔ 订单 多对多分配（orderIds/orderAllocations 提供的订单写入分配表；含批次维度）
      // 传整个 invoice（而非 id）：同客户校验要读票头的 type/customerRelationId/customerName
      await syncInvoiceOrderAllocations(tx, invoice, alloc.ok ? alloc.allocations : undefined);
      // 修复1：应收发票创建 → 同事务重算客户 usedAmount + append CreditLimitHistory
      // （非 Receivable 或未挂客户档案的发票不影响信用，hook 内部自行跳过/幂等收敛）
      if (invoice.type === 'Receivable' && invoice.customerRelationId) {
        await notifyCustomerCreditRecalc(tx, {
          relationId: invoice.customerRelationId,
          source: 'route:invoice:create',
          triggerId: invoice.id,
          triggerBy: actorId || 'api',
        });
      }
      await currentInvoiceWriter(tx, params);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:invoice:create',
        operation: 'create_invoice', targetType: 'Invoice', targetId: invoice.id,
        after: { id: invoice.id, invoiceNumber: invoice.invoiceNumber, type: invoice.type, amount: decimalString(invoice.amount), status: invoice.status },
        ip: ip || null,
      });
      const bulkFirstAcknowledgement = await finishBulkFirst(tx, bulkFirst, invoice, auditId);
      return { invoice, auditId, ...(bulkFirstAcknowledgement ? { bulkFirstAcknowledgement, replayed: false } : {}) };
    });
    if (result.bulkFirstRejection) return rejectedBulkResult(result.bulkFirstRejection);
    const afterCommit = async () => {
      // Publish domain events after commit (best-effort, never fails business)
      if (result.invoice.status === 'Issued') {
        publishBusinessEvent({
          type: 'InvoiceIssued',
          sourceEntityType: 'Invoice',
          sourceEntityId: result.invoice.id,
          orderId: result.invoice.orderId || undefined,
          payload: {
            invoiceId: result.invoice.id,
            invoiceNumber: result.invoice.invoiceNumber,
            type: result.invoice.type,
            amount: decimalString(result.invoice.amount),
            currency: result.invoice.currency,
            customerName: result.invoice.customerName,
            customerRelationId: result.invoice.customerRelationId,
          },
          actorId: actorId || 'api',
          transactionId: result.auditId,
        }).catch(() => { /* event publish failure must not fail business */ });
      }
      // T2/H14：发票带批次锚定（batchId）时，提交后刷新批次结算快照（invoicedAmount）
      // best-effort：失败不阻断建票，快照可由下一次核销/读侧重算收敛
      // Finish this command's derived refresh before acknowledging the committed
      // invoice, so an immediate next workflow does not race our detached write.
      // The hook still catches failures; a committed invoice remains successful.
      await notifyShipmentBatchSettlementRecalc(prisma, { invoiceId: result.invoice.id, source: 'route:invoice:create' })
        .catch(() => { /* best-effort */ });
    };
    if (!result.replayed) {
      if (params.transaction) params.transaction.deferAfterCommit(afterCommit);
      else await afterCommit();
    }
    return { ok: true, data: result };
  } catch (e: any) {
    return { ok: false, error: toError(e, 'CREATE_FAILED') };
  }
}

export async function updateInvoice(params: { prisma: PrismaClient; invoiceId: string; input: InvoiceMutationInput; actorId?: string; actor?: TokenPayload | null; ip?: string | null }): Promise<InvoiceMutationResult> {
  const { prisma, invoiceId, input, actorId, ip } = params;
  const normalized = normalizeUpdateInput(input);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  const alloc = resolveOrderAllocations(input);
  if (!alloc.ok) {
    return { ok: false, error: alloc.error };
  }
  let affectedOrderIds: string[] = [];
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const invoiceActor = await currentInvoiceWriter(tx, params);
      const consumesFinancialSource = Array.isArray(input.orderIds) || Array.isArray(input.orderAllocations)
        || normalized.hasStatus && normalized.data.status === 'Issued'
        || ['orderId', 'customerRelationId', 'customerName', 'type', 'currency', 'amount'].some(key => Object.prototype.hasOwnProperty.call(normalized.data, key));
      let financialInvoiceHint: any = null;
      if (params.actor !== undefined && consumesFinancialSource) {
        if (!params.actor || params.actor.userId !== actorId) throw businessError('UNAUTHORIZED', '开票主体无法核验。');
        financialInvoiceHint = await tx.invoice.findUnique({ where: { id: invoiceId } });
        if (['BusinessShipmentCI', DEVELOPMENT_CI_SOURCE].includes(financialInvoiceHint?.sourceType)
          && Object.keys(input || {}).some(key => key !== 'notes')) {
          await requireInvoiceObject(tx, invoiceId, invoiceActor);
          throw businessError('HANDOFF_CONFLICT', '已签发商业发票的应收事实不能在财务模块改写，请核对准确原票。');
        }
        const oldSources = await tx.invoiceOrderAllocation.findMany({ where: { invoiceId, deletedAt: null }, orderBy: { id: 'asc' } });
        const financialSources = [...oldSources, ...(alloc.allocations ?? []),
          ...(financialInvoiceHint?.orderId ? [{ orderId: financialInvoiceHint.orderId }] : []),
          ...(normalized.data.orderId ? [{ orderId: normalized.data.orderId }] : [])];
        // Standalone case/sample invoices retain current Invoice/source authority.
        // Order/shipment capabilities are needed only when actual old or new
        // native Order sources are consumed; an empty source set borrows none.
        if (financialSources.length) await lockInvoiceFinancialSources(tx, financialSources, params.actor);
      }

      const initialInvoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      const initialBilling = initialInvoice?.sourceType === 'BillingItem' && initialInvoice.sourceId
        ? await tx.billingItem.findFirst({ where: { id: initialInvoice.sourceId, deletedAt: null } }) : null;
      const initialInvoiceFingerprint = ciHash(initialInvoice);
      let developmentUpdateLines: any[] = [];
      let developmentUpdateLineFingerprint: string | null = null;
      const developmentUpdateMembers: Array<{ row: any; fingerprint: string }> = [];
      if (consumesFinancialSource && initialInvoice) {
        await requireInvoiceObject(tx, invoiceId, invoiceActor);
        developmentUpdateLines = await tx.invoiceLine.findMany({ where: { invoiceId }, orderBy: { id: 'asc' } });
        developmentUpdateLineFingerprint = ciHash(developmentUpdateLines);
        const ids = [...new Set<string>([...(initialBilling ? [initialBilling.id] : []),
          ...developmentUpdateLines.filter(line => line.sourceType === 'BillingItem').map(line => line.sourceId)])].sort();
        for (const id of ids) {
          const row = await tx.billingItem.findFirst({ where: { id } });
          if (row?.sourceType === 'DevelopmentCase') developmentUpdateMembers.push({ row, fingerprint: ciHash(row) });
        }
        const cases = [...new Set<string>(developmentUpdateMembers.map(({ row }) => row.sourceId))].sort();
        for (const caseId of cases) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} FOR UPDATE`);
        for (const { row } of developmentUpdateMembers) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${row.id} FOR UPDATE`);
        if (developmentUpdateMembers.length) {
          const coverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: { in: developmentUpdateMembers.map(({ row }) => row.id) }, releasedAt: null } });
          const costs = [...new Set<string>([...coverage.map((line: any) => line.costRecordId), ...developmentUpdateMembers.flatMap(({ row }) =>
            [row.costRecordId, ...(row.developmentCommercialCostSelection?.costs?.map((cost: any) => cost.id) ?? [])]).filter(Boolean)])].sort();
          for (const id of costs) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${id} FOR UPDATE`);
          for (const { row } of developmentUpdateMembers) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCiBillingClaim" WHERE "billingItemId"=${row.id} ORDER BY "id" FOR UPDATE`);
          for (const caseId of cases) await lockDevelopmentCiDocumentsInTx(tx, caseId);
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${invoiceId} FOR UPDATE`);
        }
      }
      if (initialBilling?.developmentExpenseReviewId) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${initialBilling.sourceId} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${initialBilling.id} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${invoiceId} FOR UPDATE`);
      }
      const supplierClaim = initialBilling?.developmentExpenseReviewId || developmentUpdateMembers.length ? null : await lockSupplierClaimInvoice(tx, invoiceId);
      const existing = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!existing || existing.deletedAt) throw Object.assign(new Error('invoice not found'), { code: 'NOT_FOUND', statusCode: 404 });
      await requireInvoiceObject(tx, invoiceId, invoiceActor);
      if (existing.sourceType === FABRIC_COMMISSION_SOURCE && Object.keys(input || {}).some(key => !['notes', 'requestKey', 'expectedUpdatedAt'].includes(key)))
        throw businessError('HANDOFF_CONFLICT', '供应商向我方支付的面料佣金须保持准确原票；金额、付款方、状态和来源不能普通覆写。');
      if (['BusinessShipmentCI', DEVELOPMENT_CI_SOURCE].includes(existing.sourceType)
        && Object.keys(input || {}).some(key => key !== 'notes')) {
        throw businessError('HANDOFF_CONFLICT', '这笔应收来自已签发的商业发票，只能登记为财务账务事实；金额、客户、订单、状态和原票文件不能在财务模块改写。');
      }
      if (consumesFinancialSource && existing.sourceType !== FABRIC_COMMISSION_SOURCE) {
        const oldLinks = await tx.invoiceOrderAllocation.findMany({ where: { invoiceId, deletedAt: null } });
        await assertGenericFabricGoodsReceivable(tx, { ...existing, ...normalized.data,
          orderAllocations: input.orderAllocations ?? oldLinks, orderIds: input.orderIds,
          invoiceLines: input.invoiceLines ?? await tx.invoiceLine.findMany({ where: { invoiceId } }) });
      }
      if (existing.sourceType === SUPPLIER_VAT_PAYABLE_SOURCE && Object.keys(input || {}).some(key => !['notes', 'requestKey', 'expectedUpdatedAt'].includes(key)))
        throw businessError('HANDOFF_CONFLICT', '供应商原票应付的金额、供应商、订单、状态和来源不可覆写；请核对原票并按独立冲销依据处理。');
      if (Object.prototype.hasOwnProperty.call(input || {}, 'attachments')) assertInvoiceFileLedgerInput(normalized.data.attachments, existing.attachments);
      if (financialInvoiceHint && String(existing.updatedAt) !== String(financialInvoiceHint.updatedAt))
        throw businessError('CONFLICT', '发票或原分配在取得来源锁时变化，请重新读取后保存。');

      if (developmentUpdateMembers.length) {
        const lines = await tx.invoiceLine.findMany({ where: { invoiceId }, orderBy: { id: 'asc' } });
        if (ciHash(existing) !== initialInvoiceFingerprint || ciHash(lines) !== developmentUpdateLineFingerprint)
          throw businessError('CONFLICT', '开发收费原票或成员在取得锁时变化，请重新读取后核对。');
        const members: any[] = [];
        for (const hint of developmentUpdateMembers) {
          const billing = await tx.billingItem.findFirst({ where: { id: hint.row.id } });
          if (!billing || ciHash(billing) !== hint.fingerprint) throw businessError('CONFLICT', '开发收费成员在取得锁时变化，请重新读取。');
          members.push(billing);
          if (existing.status === 'Draft' && normalized.data.status === 'Issued' && billing.developmentExpenseReviewId)
            await assertDevelopmentBillingCoverageCurrentInTx(tx, billing);
        }
        assertDevelopmentBillingInvoiceFacts({ ...existing, ...normalized.data }, members, lines);
      }

      if (supplierClaim) {
        const protectedFields = ['type', 'amount', 'currency', 'customerRelationId', 'customerName', 'orderId', 'sourceType', 'sourceId'];
        const changed = protectedFields.some(field => normalized.data[field] !== undefined && (field === 'amount'
          ? !new Prisma.Decimal(normalized.data[field]).equals(existing[field])
          : (normalized.data[field] ?? null) !== (existing[field] ?? null)));
        if (changed || input.orderAllocations !== undefined) throw Object.assign(new Error('供应商索赔贷项须保持原生退料确认的金额、币种及来源；请先撤销核销并作废原贷项，再由退料确认重新开具。'), { code: 'SOURCE_CLAIM_CONFLICT', statusCode: 409 });
      }
      if (initialBilling?.developmentExpenseReviewId) {
        const billing = await tx.billingItem.findFirst({ where: { id: initialBilling.id, deletedAt: null } });
        if (!billing || billing.sourceId !== initialBilling.sourceId || billing.developmentExpenseReviewId !== initialBilling.developmentExpenseReviewId
          || existing.sourceType !== 'BillingItem' || existing.sourceId !== billing.id || !['confirmed','invoiced'].includes(billing.status)
          || (billing.invoiceId && billing.invoiceId !== invoiceId)) {
          throw Object.assign(new Error('收费依据或应收关联已变化，请刷新'), { code: 'INVALID_TRANSITION', statusCode: 400 });
        }
        const next = { ...existing, ...normalized.data };
        const net = new Prisma.Decimal(billing.amount).minus(billing.waivedAmount).minus(billing.offsetAmount);
        if (!net.gt(0) || !net.eq(next.amount) || next.currency !== billing.currency || next.type !== 'Receivable'
          || billing.bearerType !== 'customer' || !billing.bearerRelationId || next.customerRelationId !== billing.bearerRelationId) {
          throw Object.assign(new Error('应收金额、币种和客户必须与整案收费决定一致，请从收费调整流程处理'), { code: 'INVALID_TRANSITION', statusCode: 400 });
        }
        if (existing.status === 'Draft' && next.status === 'Issued') {
          await assertDevelopmentBillingCoverageCurrentInTx(tx, billing);
        }
      }
      if (normalized.hasStatus) {
        // PartiallyPaid/Paid 只能由 allocation 操作自动重算，禁止手动 PATCH
        if (input.status === 'PartiallyPaid' || input.status === 'Paid') {
          throw Object.assign(new Error(`status ${input.status} can only be set by allocation operations, not manual PATCH`), { code: 'STATUS_NOT_MANUAL_SETTABLE', statusCode: 400 });
        }
        const transition = validateStatusTransition('Invoice', existing.status, input.status);
        if (!transition.ok) throw Object.assign(new Error(transition.message!), { code: transition.error, statusCode: 400 });
      }
      // ── 派生字段一致性（L2 变异 #8 配套，2026-09-17）─────────────────────
      // Invoice.status 是**派生字段**，真源 = Σ InvoiceAllocation vs amount
      // （allocationService.recalcInvoiceStatus）。本函数允许改 `amount`，此前却**从不重算**
      // → 状态与净额脱钩。真库演练（scripts/acceptance-invoice-amount-recalc.mjs）实测复现：
      //   · 改小到 = 已核销（客户少收，财务用「改金额」抹平）→ open=0 但 status 停在
      //     PartiallyPaid = **僵尸票**；
      //   · 已 Paid 的票改大 → open>0 但 status 停在 Paid =「已结清」的票其实还欠钱。
      // 僵尸票的连锁（全是代码事实）：creditService.maxOverdueDays 只按
      //   `status ∈ {Issued, PartiallyPaid}` 过滤，**连 open 都不看** → 僵尸票永久计入
      //   最大逾期天数 → 客户 60 天后被 riskWatchdog 自动冻结授信，而唯一的自动解冻路径
      //   （thawAutoFrozenIfSettled）要求 maxOverdueDays ≤ 60 → **永不满足 → 永不解冻**。
      const amountChanged = normalized.data.amount !== undefined
        && !new Prisma.Decimal(normalized.data.amount).equals(new Prisma.Decimal(existing.amount));
      if (amountChanged) {
        // Σ 已核销用 allocationService.sumAppliedAmount —— 与状态真源 recalcInvoiceStatus
        // **共用同一份汇总定义**（两处口径漂移会直接产出僵尸票）。
        const applied = await sumAppliedAmount(tx, invoiceId);
        const nextAmount = new Prisma.Decimal(normalized.data.amount);
        // 维持 applyAllocation 已强制的 Σapplied ≤ amount 不变量：
        // 允许改到低于已核销额 = 制造超额核销（净额为负），下游账龄/授信全部失真。
        // 要改小到该值以下，先撤销核销（deleteAllocation）再改。
        // ★ 面额 = |amount|（真源 `shared/invoiceSettlementBasis`）：负额票（供应商索赔贷项）的
        //   额度是 |amount| ⇒ 拿负数比会把「索赔金额协商调小（-500 → -300，已核销 300）」判成超额而拒。
        if (settlementBasisOf(nextAmount).lt(applied)) {
          throw Object.assign(
            new Error(`amount ${nextAmount.toString()} is below already-allocated ${applied.toString()}；请先撤销核销再改金额`),
            { code: 'AMOUNT_BELOW_ALLOCATED', statusCode: 409 },
          );
        }
      }
      if (normalized.data.status === 'Cancelled') {
        if (await tx.invoiceAllocation.count({ where: { invoiceId } })) throw Object.assign(new Error('已有核销，须先有留痕地撤销核销后再作废'), { code: 'HAS_ALLOCATIONS', statusCode: 409 });
        await releaseSupplierClaimInvoiceInTx(tx, existing, actorId || 'api', BigInt(Date.now()), input.notes);
      }
      const data = { ...normalized.data, updatedAt: BigInt(Date.now()) };
      let invoice = await tx.invoice.update({ where: { id: invoiceId }, data });
      if (amountChanged && invoice.status !== 'Cancelled') {
        // 重算必须在 amount 落库**之后**（recalcInvoiceStatus 自己读 invoice.amount）
        const recalcStatus = await recalcInvoiceStatus(tx, invoiceId);
        const patch: any = { updatedAt: BigInt(Date.now()) };
        if (recalcStatus !== invoice.status) patch.status = recalcStatus;
        // riskService 的「按期回款率」以 `status==='Paid' && settlementDate != null` 为口径
        // （riskService.ts:422）→ 维持「Paid ⟹ 有结算日」不变量，否则该票被静默漏统计。
        // 取值真源 = 最后一笔核销的 appliedDate（不是「今天」，改金额不等于今天结算）。
        if (recalcStatus === 'Paid' && !invoice.settlementDate) {
          const lastAlloc = await tx.invoiceAllocation.findFirst({
            where: { invoiceId },
            orderBy: { appliedDate: 'desc' },
            select: { appliedDate: true },
          });
          patch.settlementDate = lastAlloc?.appliedDate
            ? String(lastAlloc.appliedDate)
            : todayLocalKey();
        }
        invoice = await tx.invoice.update({ where: { id: invoiceId }, data: patch });
      }
      await syncInvoiceReferences(prisma, invoice, { source: 'route:invoice:update' }, tx);
      // Replacement preserves each invoice/order identity, including historical
      // tombstones. A notes-only PATCH does not touch or revalidate IOA rows.
      let allocationBefore: Record<string, unknown>[] | undefined;
      let allocationAfter: Record<string, unknown>[] | undefined;
      if (Array.isArray(input?.orderIds) || Array.isArray(input?.orderAllocations)) {
        const previousAllocations = await tx.invoiceOrderAllocation.findMany({
          where: { invoiceId }, orderBy: { id: 'asc' },
        });
        allocationBefore = previousAllocations.map(invoiceOrderAllocationSnapshot);
        affectedOrderIds = [...new Set<string>([existing.orderId, invoice.orderId,
          ...previousAllocations.filter((row: any) => row.deletedAt == null).map((row: any) => row.orderId),
          ...(alloc.allocations ?? []).map(row => row.orderId)].filter(Boolean))];
        // 传更新后的 invoice（客户可能同一次 PATCH 里被改）—— 校验必须按**最终态**判
        await syncInvoiceOrderAllocations(tx, invoice, alloc.allocations, previousAllocations);
        const nextAllocations = await tx.invoiceOrderAllocation.findMany({
          where: { invoiceId }, orderBy: { id: 'asc' },
        });
        allocationAfter = nextAllocations.map(invoiceOrderAllocationSnapshot);
      } else if (invoice.type === 'Receivable' && invoice.customerRelationId && invoice.customerRelationId !== existing.customerRelationId) {
        // ★ 客户迁移联动（L2 高危 2 号配套）：只改票头客户、不动订单分配时，
        //   已有分配仍挂在旧客户名下 → 一样是挂错人（应收/账龄/授信全错）。
        //   只在此字段真的变化时才查，避免把历史脏数据变成「PATCH 任意字段都 409」。
        const kept = await tx.invoiceOrderAllocation.findMany({
          where: { invoiceId, deletedAt: null },
          select: { orderId: true },
        }) || [];
        if (kept.length > 0) {
          const keptRows = await tx.order.findMany({
            where: { id: { in: [...new Set(kept.map((k: any) => k.orderId))] }, deletedAt: null },
            select: { id: true, code: true, customerRelationId: true, customer: true },
          }) || [];
          const keptViolation = findAllocationCustomerViolation(keptRows, invoice);
          if (keptViolation) throw Object.assign(new Error(keptViolation.message), { code: keptViolation.code, statusCode: 409 });
        }
      }
      // 修复1：发票更新（金额/状态→Cancelled/客户档案迁移/类型切换）→ 同事务重算受影响客户
      // usedAmount。旧/新 customerRelationId 都要覆盖：迁移档案或 Payable↔Receivable 切换时
      // 双方净额均变化；无关客户的重算为幂等 no-op（值相等不写库）。
      const affectedRelations = new Set<string>();
      if (existing.type === 'Receivable' && existing.customerRelationId) affectedRelations.add(existing.customerRelationId);
      if (invoice.type === 'Receivable' && invoice.customerRelationId) affectedRelations.add(invoice.customerRelationId);
      for (const rid of affectedRelations) {
        await notifyCustomerCreditRecalc(tx, {
          relationId: rid,
          source: 'route:invoice:update',
          triggerId: invoice.id,
          triggerBy: actorId || 'api',
        });
      }
      await currentInvoiceWriter(tx, params);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:invoice:update',
        operation: 'update_invoice', targetType: 'Invoice', targetId: invoice.id,
        before: { status: existing.status, amount: decimalString(existing.amount),
          ...(allocationBefore === undefined ? {} : { type: existing.type, orderId: existing.orderId ?? null,
            customerRelationId: existing.customerRelationId ?? null, customerName: existing.customerName ?? null,
            orderAllocations: allocationBefore }),
        },
        after: { status: invoice.status, amount: decimalString(invoice.amount),
          ...(allocationAfter === undefined ? {} : { type: invoice.type, orderId: invoice.orderId ?? null,
            customerRelationId: invoice.customerRelationId ?? null, customerName: invoice.customerName ?? null,
            orderAllocations: allocationAfter }),
        },
        ip: ip || null,
      });
      return { invoice, auditId, fromStatus: existing.status };
    });
    // Publish domain events after commit (best-effort, never fails business)
    if (normalized.hasStatus && result.fromStatus !== result.invoice.status) {
      if (result.invoice.status === 'Issued' && result.fromStatus !== 'Issued') {
        publishBusinessEvent({
          type: 'InvoiceIssued',
          sourceEntityType: 'Invoice',
          sourceEntityId: result.invoice.id,
          orderId: result.invoice.orderId || undefined,
          payload: {
            invoiceId: result.invoice.id,
            invoiceNumber: result.invoice.invoiceNumber,
            type: result.invoice.type,
            amount: decimalString(result.invoice.amount),
            currency: result.invoice.currency,
            customerName: result.invoice.customerName,
            fromStatus: result.fromStatus,
          },
          actorId: actorId || 'api',
          transactionId: result.auditId,
        }).catch(() => { /* event publish failure must not fail business */ });
      }
      if (result.invoice.status === 'Cancelled' && result.fromStatus !== 'Cancelled') {
        publishBusinessEvent({
          type: 'InvoiceCancelled',
          sourceEntityType: 'Invoice',
          sourceEntityId: result.invoice.id,
          orderId: result.invoice.orderId || undefined,
          payload: {
            invoiceId: result.invoice.id,
            invoiceNumber: result.invoice.invoiceNumber,
            type: result.invoice.type,
            amount: decimalString(result.invoice.amount),
            currency: result.invoice.currency,
            customerName: result.invoice.customerName,
            fromStatus: result.fromStatus,
          },
          actorId: actorId || 'api',
          transactionId: result.auditId,
        }).catch(() => { /* event publish failure must not fail business */ });
      }
    }
    // T2/H14：发票分配（orderAllocations）变更/作废影响批次归属 → 提交后刷新批次结算快照（best-effort）
    if (Array.isArray(input?.orderIds) || Array.isArray(input?.orderAllocations) || input?.status === 'Cancelled') {
      await notifyShipmentBatchSettlementRecalc(prisma, { invoiceId: result.invoice.id, affectedOrderIds, source: 'route:invoice:update' })
        .catch(() => { /* best-effort */ });
    }
    return { ok: true, data: result };
  } catch (e: any) {
    return { ok: false, error: toError(e, 'UPDATE_FAILED') };
  }
}
