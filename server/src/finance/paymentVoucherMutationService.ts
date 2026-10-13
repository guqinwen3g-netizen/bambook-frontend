import { businessNowDate } from '../shared/businessClock';
/**
 * ERP-P1-payment-voucher-mutation-shared-service-foundation
 * PaymentVoucher mutation service: route/Agent 共用事务契约。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { syncPaymentVoucherReferences } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { publishBusinessEvent } from '../events/businessEventBus';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { SUPPORTED_CURRENCIES, isSupportedCurrency } from './invoiceMutationService';
import crypto from 'crypto';
import { assertNotCashRefundVoucher, CashRefundError } from '../claims/claimCashRefundFact';
import type { TokenPayload } from '../auth/service';
import { createFinanceSourceAccess } from './financeSourceAccess';
import { beginFinanceCommand, assertFinanceRevision, type FinanceCommandReceipt } from './financeCommandReceipt';
import { postVoucherCashEntry, cashDate, assertVoucherCashUse } from './companyCashAccountService';
import { businessError } from '../shared/errorCodes';
import { ciHash } from '../development/developmentCiSource';

export const VALID_PAYMENT_VOUCHER_STATUS = ['unreconciled', 'partially_reconciled', 'reconciled'] as const;
export type PaymentVoucherStatus = typeof VALID_PAYMENT_VOUCHER_STATUS[number];

// P0-9 / DR-022 凭证分类：三类费用（sample_express / customer_reimburse / business_cost）
// + normal / advance / deposit。枚举外一律拒绝（fail-closed）。
// 设计真源：财务域模型组.md §2.2 / Prisma缺口清单与迁移方案.md P0-9
export const VALID_VOUCHER_CATEGORIES = [
  'normal',
  'advance',
  'deposit',
  'sample_express',
  'customer_reimburse',
  'business_cost',
] as const;
export type VoucherCategory = typeof VALID_VOUCHER_CATEGORIES[number];

// ★ M1·D7-③ / KB-1.7：银行手续费承担方（SWIFT MT103 71A 口径，三个字面量即行业原义）。
//   OUR = **汇款方**（remitter）承担全部手续费；BEN = **收款方**（beneficiary）承担全部
//   （银行从到账金额里扣）；SHA = 各自承担己方银行费用。
//   ⚠️ **「我方」是哪一个取决于凭证类型，不能写死**：
//     · type=Receipt（收款水单）→ 我方是**收款方**：BEN 才是我方承担，OUR 由客户承担；
//     · type=Disbursement（付款凭证）→ 我方是**汇款方**：OUR 是我方承担，BEN 由供应商承担。
//   ⇒ 本字段只**登记**不承担推导；「谁的成本」必须由消费方结合 type 判定（见下方 D7-③ 消费口径说明）。
//   null = **未标注**（历史单据缺省）。口径：未标注时**不猜**承担方，P&L 侧按「已发生即计成本」处理
//   （见 profitSheetService 的 D7-① 注释）——不改核销额、不改到账金额。
//   真源：docs/交付目标与验收标准-2026-09-20.md §12 D7-③ / KB-1.7（迁移 20260920010000）
export const VALID_FEE_BEARERS = ['OUR', 'BEN', 'SHA'] as const;
export type FeeBearer = typeof VALID_FEE_BEARERS[number];

export type PaymentVoucherMutationErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_FEE_BEARER'
  | 'INVALID_STATUS'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_VOUCHER_CATEGORY'
  | 'NOT_FOUND'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'INVALID_STATE'
  | 'STATUS_NOT_MANUAL_SETTABLE'
  | 'PAYMENT_REQUEST_REQUIRED'
  | 'PAYMENT_REQUEST_ALREADY_LINKED';

export interface PaymentVoucherMutationError {
  code: string;
  message: string;
}

export type PaymentVoucherMutationResult =
  | { ok: true; data: { voucher: any; auditId: string; replayed?: boolean; financeCommand?: FinanceCommandReceipt } }
  | { ok: false; error: PaymentVoucherMutationError };

export type PaymentVoucherMutationInput = Record<string, any>;

export const PAYMENT_VOUCHER_CREATE_FIELDS = [
  'id', 'voucherNumber', 'type', 'voucherCategory', 'amount', 'currency', 'paymentDate', 'paymentMethod', 'status', 'bankFee',
  'exchangeRate', 'baseCurrency', 'invoiceId', 'appliedAmount', 'orderId', 'customerRelationId',
  'customerName', 'notes', 'attachments', 'feeBearer',
] as const;

export const PAYMENT_VOUCHER_PATCH_FIELDS = [
  'type', 'voucherCategory', 'amount', 'currency', 'paymentDate', 'paymentMethod', 'bankFee',
  'exchangeRate', 'baseCurrency', 'invoiceId', 'appliedAmount', 'orderId', 'customerRelationId',
  'customerName', 'notes', 'attachments', 'feeBearer',
] as const;

const DECIMAL_FIELDS = new Set(['amount', 'bankFee', 'exchangeRate', 'appliedAmount']);

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

/** 服务器本地日期 YYYY-MM-DD（voucher.paymentDate 为 schema 必填，缺省默认收/付款当天） */
function localToday(): string {
  const now = businessNowDate();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

function isValidPaymentVoucherStatus(status: string): status is PaymentVoucherStatus {
  return (VALID_PAYMENT_VOUCHER_STATUS as readonly string[]).includes(status);
}

// ───────────────────────────────────────────────────────────────────
// DR-017 先申请后付款门禁（W-A 走查 DE-3 修复，fail-closed）
//   Disbursement（付款）凭证必须关联审批通过的 PaymentRequest；
//   Receipt（收款）无需申请，不受此限。
//   关联落点：attachments JSON 扩展字段（schema 冻结期设计许可，与 DR-013
//   attachments={files,scope} 扩展模式同构），并在事务内 CAS 回写
//   PaymentRequest.status=VoucherIssued + paymentVoucherId（关闭申请单）。
// ───────────────────────────────────────────────────────────────────

/** 已审批通过、可作为付款依据的申请状态 */
const PAYABLE_REQUEST_STATUSES = new Set(['Approved', 'VoucherIssued']);

function extractPaymentRequestId(input: PaymentVoucherMutationInput): string | null {
  const raw = input?.paymentRequestId;
  if (typeof raw !== 'string') return null;
  return raw.trim() || null;
}

/** 关联写入 attachments JSON 扩展字段：保留既有附件内容（对象合并 / 数组收编为 files） */
function mergePaymentRequestLink(attachments: unknown, paymentRequestId: string): Record<string, unknown> {
  if (attachments && typeof attachments === 'object' && !Array.isArray(attachments)) {
    return { ...(attachments as Record<string, unknown>), paymentRequestId };
  }
  return { files: attachments == null ? [] : Array.isArray(attachments) ? attachments : [attachments], paymentRequestId };
}

/** Disbursement 门禁：无申请 / 申请不存在 / 申请未获批 → PAYMENT_REQUEST_REQUIRED（route 映射 403） */
async function assertDisbursementPaymentRequest(
  prisma: PrismaClient,
  input: PaymentVoucherMutationInput,
  cashRefundExecution?: { refundId: string; paymentRequestId: string },
  supplierPaymentExecution?: { paymentRequestId: string },
): Promise<PaymentVoucherMutationError | null> {
  if (input?.type !== 'Disbursement') return null; // Receipt（收款）无需申请；type 缺失由 schema 必填约束兜底
  const paymentRequestId = extractPaymentRequestId(input);
  if (!paymentRequestId) {
    return {
      code: 'PAYMENT_REQUEST_REQUIRED',
      message: '付款（Disbursement）凭证必须关联审批通过的付款申请（DR-017 先申请后付款）：'
        + '请先经 POST /api/v1/payment-requests 提交申请并获批，再携带 paymentRequestId 创建凭证',
    };
  }
  const pr = await (prisma as any).paymentRequest?.findUnique?.({ where: { id: paymentRequestId } }).catch(() => null);
  if (!pr || pr.deletedAt) {
    return {
      code: 'PAYMENT_REQUEST_REQUIRED',
      message: `付款申请 ${paymentRequestId} 不存在或已删除，不得作为付款依据（DR-017 fail-closed）`,
    };
  }
  const refund = await (prisma as any).creditNoteRefund.findUnique({ where: { paymentRequestId: pr.id } });
  if (refund || pr.payeeType === 'Customer') {
    if (!refund || !cashRefundExecution || cashRefundExecution.refundId !== refund.id || cashRefundExecution.paymentRequestId !== pr.id
        || refund.status !== 'Executing' || pr.status !== 'Executing' || pr.paymentVoucherId
        || input.customerRelationId !== refund.customerRelationId || input.currency !== refund.currency
        || !new Prisma.Decimal(input.amount).equals(refund.amount) || input.paymentMethod !== refund.payeeSnapshot?.method) {
      return { code: 'PAYMENT_REQUEST_REQUIRED', message: '客户退款须由专用实付确认事务生成准确凭证，不可从普通凭证或 Agent 入口旁路' };
    }
    return null;
  }
  if (cashRefundExecution) return { code: 'PAYMENT_REQUEST_REQUIRED', message: '现金退款执行缺少真实 CN 付款来源' };
  if (!supplierPaymentExecution || supplierPaymentExecution.paymentRequestId !== pr.id
    || input.customerRelationId !== pr.supplierId || input.currency !== pr.currency) {
    return { code: 'PAYMENT_REQUEST_REQUIRED', message: '请从原付款申请登记本次实际付款；普通凭证不能自报审批来源或代填实际付款事实。' };
  }
  if (!PAYABLE_REQUEST_STATUSES.has(pr.status)) {
    return {
      code: 'PAYMENT_REQUEST_REQUIRED',
      message: `付款申请 ${paymentRequestId} 当前状态 ${pr.status}，仅审批通过（Approved）后方可创建付款凭证（DR-017 先申请后付款）`,
    };
  }
  return null;
}

function isValidVoucherCategory(category: string): category is VoucherCategory {
  return (VALID_VOUCHER_CATEGORIES as readonly string[]).includes(category);
}

/** voucherCategory 校验：传入了就必须是枚举内值（fail-closed），未传入由 schema default('normal') 兜底 */
function validateVoucherCategoryInput(input: PaymentVoucherMutationInput): PaymentVoucherMutationError | null {
  if (input?.voucherCategory === undefined || input?.voucherCategory === null) return null;
  if (typeof input.voucherCategory !== 'string' || !isValidVoucherCategory(input.voucherCategory)) {
    return { code: 'INVALID_VOUCHER_CATEGORY', message: `voucherCategory must be one of: ${VALID_VOUCHER_CATEGORIES.join(', ')}` };
  }
  return null;
}

/**
 * ★ D7-③ feeBearer 校验：传了就必须是 OUR / BEN / SHA（大小写不敏感，归一为大写）。
 *   未传 / 显式 null / 空串 → 一律归一为 **null（未标注）**，**不猜默认值**
 *   （缺省取 SHA 会给 325 条历史收款水单静默贴标签，与 D30「不得静默改数」相悖 ⇒ 这里宁可留 null）。
 *   空串必须显式转 null 而不是原样放过：前端清空下拉框提交的正是 `''`，
 *   若原样落库，库里会同时存在 `''` 与 `null` 两种「未标注」写法 ⇒ 分组键漂移（与大小写漂移同族）。
 *   枚举外一律拒绝（报错优于算错，与 voucherCategory 同取向）。
 */
function validateFeeBearerInput(input: PaymentVoucherMutationInput): PaymentVoucherMutationError | null {
  const raw = input?.feeBearer;
  if (raw === undefined || raw === null) return null;
  if (raw === '') {
    // 清空语义：显式写 null（CREATE 落 null；PATCH 把已有标注清回未标注）
    input.feeBearer = null;
    return null;
  }
  if (typeof raw !== 'string') {
    return { code: 'INVALID_FEE_BEARER', message: `feeBearer must be one of: ${VALID_FEE_BEARERS.join(', ')}` };
  }
  const upper = raw.trim().toUpperCase();
  if (!(VALID_FEE_BEARERS as readonly string[]).includes(upper)) {
    return { code: 'INVALID_FEE_BEARER', message: `feeBearer must be one of: ${VALID_FEE_BEARERS.join(', ')}（收到 ${raw}）` };
  }
  // 归一为大写，避免库里同时存在 'sha' / 'SHA' 两种写法导致后续分组键漂移
  input.feeBearer = upper;
  return null;
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

function decimalString(v: any): string | null {
  if (v === undefined || v === null) return null;
  return typeof v?.toString === 'function' ? v.toString() : String(v);
}

function pickVoucherFields(input: PaymentVoucherMutationInput, fields: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const field of fields) {
    if (input[field] === undefined) continue;
    out[field] = input[field];
  }
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

// ───────────────────────────────────────────────────────────────────
// 修复2（财务输入服务端防线，与 invoiceMutationService 同款规则/同一白名单）：
//   exchangeRate 必须 >0；amount/bankFee/appliedAmount 必须 ≥0；
//   currency/baseCurrency 白名单校验（币种是账龄/对账分组键，拒绝自由文本）
// ───────────────────────────────────────────────────────────────────
const VOUCHER_POSITIVE_ONLY_FIELDS = new Set(['exchangeRate']);
const VOUCHER_NON_NEGATIVE_FIELDS = new Set(['amount', 'bankFee', 'appliedAmount']);

function validateAmountAndCurrencyFields(data: Record<string, any>): PaymentVoucherMutationError | null {
  for (const field of Object.keys(data)) {
    if (data[field] === undefined || data[field] === null) continue;
    if (VOUCHER_POSITIVE_ONLY_FIELDS.has(field) || VOUCHER_NON_NEGATIVE_FIELDS.has(field)) {
      try {
        const d = new Prisma.Decimal(data[field]);
        if (VOUCHER_POSITIVE_ONLY_FIELDS.has(field) && d.lte(0)) {
          return { code: 'INVALID_AMOUNT', message: `${field} 必须为正数（>0），收到 ${data[field]}` };
        }
        if (VOUCHER_NON_NEGATIVE_FIELDS.has(field) && d.lt(0)) {
          return { code: 'INVALID_AMOUNT', message: `${field} 不能为负数，收到 ${data[field]}` };
        }
      } catch { /* normalizeDecimalFields 已保证可解析，此处不重复报错 */ }
    }
    if (field === 'currency' || field === 'baseCurrency') {
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

function normalizeCreateInput(input: PaymentVoucherMutationInput): { ok: true; data: Record<string, any> } | { ok: false; error: PaymentVoucherMutationError } {
  // DTO 前置校验（S3 走查 ε 车道）：schema 必填且无服务默认的字段缺失 → VALIDATION_ERROR（route 400），
  // 不再坠入事务撞 Prisma P2012 变 500（空体 POST 实锤）。voucherNumber 服务端自动生成、
  // paymentDate 下方默认当天，均不在必填列。全部现存调用方（route / paymentRequestService /
  // agent paymentVoucherMutationFlow draft 语义校验）已保证此四字段，校验为纯收紧零误伤。
  const REQUIRED_CREATE_FIELDS = ['type', 'amount', 'currency', 'paymentMethod'] as const;
  const missing = REQUIRED_CREATE_FIELDS.filter((f) => input?.[f] === undefined || input?.[f] === null || input?.[f] === '');
  if (missing.length > 0) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `missing required fields: ${missing.join(', ')}` } };
  }
  // feeBearer 校验必须在 pick 之前：它会把 'sha' 归一成 'SHA'，pick 之后再校验会落库小写（分组键漂移）
  const feeBearerError = validateFeeBearerInput(input);
  if (feeBearerError) return { ok: false, error: feeBearerError };
  const data = pickVoucherFields(input || {}, PAYMENT_VOUCHER_CREATE_FIELDS as any);
  let voucherStatus = 'unreconciled';
  if (input?.status != null) {
    if (typeof input.status !== 'string' || !isValidPaymentVoucherStatus(input.status)) {
      return { ok: false, error: { code: 'INVALID_STATUS', message: `status must be one of: ${VALID_PAYMENT_VOUCHER_STATUS.join(', ')}` } };
    }
    voucherStatus = input.status;
  }
  data.status = voucherStatus;
  const categoryError = validateVoucherCategoryInput(input);
  if (categoryError) return { ok: false, error: categoryError };
  // schema 必填兜底：paymentDate 缺省/空串时默认收/付款当天（前端日期可空，业务语义=创建日）
  if (data.paymentDate === undefined || data.paymentDate === null || data.paymentDate === '') {
    data.paymentDate = localToday();
  }
  if (!isValidDecimalInput(data.amount)) {
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'amount must be a valid decimal' } };
  }
  const normalized = normalizeDecimalFields(data);
  if (!normalized.ok) {
    const failedField = 'field' in normalized ? normalized.field : 'amount';
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: `${failedField} must be a valid decimal` } };
  }
  const businessError = validateAmountAndCurrencyFields(normalized.data);
  if (businessError) return { ok: false, error: businessError };
  return { ok: true, data: normalized.data };
}

function normalizeUpdateInput(input: PaymentVoucherMutationInput): { ok: true; data: Record<string, any> } | { ok: false; error: PaymentVoucherMutationError } {
  // status 由 allocation 操作自动重算，禁止手动 PATCH 篡改（显式拒绝，不静默删除）
  // 与 invoiceMutationService STATUS_NOT_MANUAL_SETTABLE 模式对齐
  if (input?.status !== undefined) {
    return { ok: false, error: { code: 'STATUS_NOT_MANUAL_SETTABLE', message: 'status can only be set by allocation operations, not manual PATCH' } };
  }
  const categoryError = validateVoucherCategoryInput(input);
  if (categoryError) return { ok: false, error: categoryError };
  const feeBearerError = validateFeeBearerInput(input);
  if (feeBearerError) return { ok: false, error: feeBearerError };
  const data = pickVoucherFields(input || {}, PAYMENT_VOUCHER_PATCH_FIELDS as any);
  const normalized = normalizeDecimalFields(data);
  if (!normalized.ok) {
    const failedField = 'field' in normalized ? normalized.field : 'amount';
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: `${failedField} must be a valid decimal` } };
  }
  const businessError = validateAmountAndCurrencyFields(normalized.data);
  if (businessError) return { ok: false, error: businessError };
  return { ok: true, data: normalized.data };
}

export async function createPaymentVoucher(params: {
  prisma: PrismaClient;
  input: PaymentVoucherMutationInput;
  actorId?: string;
  actor?: TokenPayload | null;
  ip?: string | null;
  /** Internal domain seam, never taken from input/body/tool parameters. */
  tx?: any;
  cashRefundExecution?: { refundId: string; paymentRequestId: string };
  /** Private supplier execution seam; never forwarded from an HTTP/tool body. */
  supplierPaymentExecution?: { paymentRequestId: string };
  /** Exact bank original, supplied only by a canonical domain producer. */
  cashCorrectionSource?: {entryId:string};
}): Promise<PaymentVoucherMutationResult> {
  const { prisma, input, actorId, ip } = params;
  const normalized = normalizeCreateInput({ ...input });
  if (!normalized.ok) return { ok: false, error: 'error' in normalized ? normalized.error : { code: 'CREATE_FAILED', message: 'validation failed' } };
  // DR-017 门禁（DE-3）：Disbursement 必须关联审批通过的 PaymentRequest（直付旁路 fail-closed 阻断）
  const paymentRequestId = extractPaymentRequestId(input);
  if (paymentRequestId) {
    normalized.data.attachments = mergePaymentRequestLink(normalized.data.attachments, paymentRequestId);
  }
  try {
    const run = params.tx ? async (fn: any) => fn(params.tx) : (fn: any) => (prisma as any).$transaction(fn);
    const result = await run(async (tx: any) => {
      const access = await createFinanceSourceAccess(tx, params.actor, ['vouchers:write']);
      if (actorId !== access.actor.userId) throw businessError('UNAUTHORIZED', '财务命令缺少可信操作人。');
      const command = params.tx ? null : await beginFinanceCommand(tx, access.actor, 'voucher.create', input);
      if (command?.replayed) {
        const row = await tx.paymentVoucher.findFirst({ where: { id: command.receipt.voucher.id } });
        if (!row || !await access.voucher({ ...row, deletedAt: null })) throw businessError('NOT_FOUND', '原收付款事实不可访问。');
        await assertVoucherCashUse(tx,access.actor,row);
        await access.finish({ deletedVoucherIds: [row.id] });
        return { ...command.receipt, replayed: true };
      }
      if (!params.cashRefundExecution && !params.supplierPaymentExecution
        && (input.paymentRequestId || input.attachments?.paymentRequestId || input.attachments?.actualPayment))
        throw businessError('CONFLICT', '付款申请及实际付款来源只能由原申请的专用登记动作生成，不能手工借用或覆盖。');
      if (!['Receipt', 'Disbursement'].includes(input.type) || !new Prisma.Decimal(input.amount).gt(0)
        || typeof input.paymentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)
        || !Number.isFinite(Date.parse(`${input.paymentDate}T00:00:00.000Z`)))
        throw businessError('INVALID_INPUT', '请登记真实收付方向、正数金额和实际发生日期。');
      cashDate(input.paymentDate);
      if (input.cashEntryId != null) throw businessError('INVALID_INPUT','资金流水身份只能由原生收付登记生成。');
      if (input.status != null && input.status !== 'unreconciled' || input.appliedAmount != null && !new Prisma.Decimal(input.appliedAmount).isZero())
        throw businessError('CONFLICT', '核销状态和已核销金额只能由真实分配产生。');
      if (input.orderId && !await access.order(input.orderId)) throw businessError('NOT_FOUND', '收付款原订单不可访问。');
      const linkedInvoice = input.invoiceId && await tx.invoice.findFirst({ where: { id: input.invoiceId, deletedAt: null } });
      if (input.invoiceId && !await access.invoice(linkedInvoice)) throw businessError('NOT_FOUND', '收付款原票不可访问。');
      if (!access.all && !input.invoiceId && input.customerRelationId && !await access.customer(input.customerRelationId))
        throw businessError('NOT_FOUND', '收付款对象不在当前业务范围。');
      const gateError = await assertDisbursementPaymentRequest(tx, input, params.cashRefundExecution, params.supplierPaymentExecution);
      if (gateError) throw Object.assign(new Error(gateError.message), { code: gateError.code });
      const now = BigInt(Date.now());
      const id = generateId('PAY');
      // PRD 5.6：服务端自动生成凭证号（PV-YYYY-NNNN），传入时优先使用传入值
      // 走查 2026-09-28：此处曾不带 occupied 占用校验 → 序列落后于业务表时恒发已占用号
      // → P2002 → 整笔回滚（连序号行一起回滚）→ 收款凭证 100% 建不出来（真库当场 500 踩过）。
      // 与 customsService.ts:441 / quotationService.ts:419 同一规则：必须含软删行。
      const voucherNumber = input.voucherNumber || await nextBusinessNumber(tx, 'PV', undefined, {
        occupied: async (num) => {
          const dup = await tx.paymentVoucher.findFirst({ where: { voucherNumber: num }, select: { id: true } });
          return dup != null;
        },
      });
      const data = { ...normalized.data, id, ownerId: access.actor.userId, voucherNumber, status: 'unreconciled', appliedAmount: new Prisma.Decimal(0), createdAt: now, updatedAt: now };
      const createdVoucher = await tx.paymentVoucher.create({ data });
      const {voucher} = await postVoucherCashEntry(tx,access.actor,createdVoucher,input,params.cashCorrectionSource);
      // DR-017 闭环：凭证落库同事务 CAS 回写申请单（Approved 且未关联凭证 → VoucherIssued + paymentVoucherId）。
      // CAS 失败必须抛错回滚刚创建的凭证；只保留既有链接会留下未关联的重复付款凭证。
      if (paymentRequestId && !params.supplierPaymentExecution) {
        const linked = await tx.paymentRequest.updateMany({
          where: { id: paymentRequestId, status: params.cashRefundExecution ? 'Executing' : 'Approved', paymentVoucherId: null },
          data: { paymentVoucherId: voucher.id, status: params.cashRefundExecution ? 'Paid' : 'VoucherIssued' },
        });
        if (linked.count !== 1) {
          if (params.cashRefundExecution) throw new CashRefundError('INVALID_STATE', '退款付款申请已被另一笔执行占用，本次已回滚');
          throw Object.assign(new Error('付款申请已关联其他凭证，本次凭证创建已回滚；请刷新申请后重试。'), {
            code: 'PAYMENT_REQUEST_ALREADY_LINKED', statusCode: 409,
          });
        }
      }
      await syncPaymentVoucherReferences(prisma, voucher, { source: 'route:voucher:create' }, tx);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:voucher:create',
        operation: 'create_voucher', targetType: 'PaymentVoucher', targetId: voucher.id,
        after: { id: voucher.id, voucherNumber: voucher.voucherNumber, type: voucher.type, amount: decimalString(voucher.amount), status: voucher.status, ...(paymentRequestId ? { paymentRequestId } : {}) },
        ip: ip || null,
      });
      await access.recheckAuthority();
      if (input.orderId && !await access.order(input.orderId) || linkedInvoice && !await access.invoice(linkedInvoice)) throw businessError('CONFLICT', '收付款业务来源在保存中变化，请核对原请求。');
      await access.finish();
      const receipt = command ? await command.commit({ voucher, auditId }) : {voucher, auditId};
      return { ...receipt, replayed: false };
    });
    // Publish domain event after commit (best-effort, never fails business)
    if (!params.tx && !result.replayed) publishBusinessEvent({
      type: 'PaymentVoucherCreated',
      sourceEntityType: 'PaymentVoucher',
      sourceEntityId: result.voucher.id,
      orderId: result.voucher.orderId || undefined,
      payload: {
        voucherId: result.voucher.id,
        voucherNumber: result.voucher.voucherNumber,
        type: result.voucher.type,
        amount: decimalString(result.voucher.amount),
        currency: result.voucher.currency,
        paymentDate: result.voucher.paymentDate,
        paymentMethod: result.voucher.paymentMethod,
        status: result.voucher.status,
        customerName: result.voucher.customerName,
        customerRelationId: result.voucher.customerRelationId,
        invoiceId: result.voucher.invoiceId,
      },
      actorId: actorId || 'api',
      transactionId: result.auditId,
    }).catch(() => { /* event publish failure must not fail business */ });
    return { ok: true, data: result };
  } catch (e: any) {
    if (params.tx) throw e; // an external caller must roll back every prior write
    if (e?.code && typeof e.code === 'string' && !/^P\d{4}$/.test(e.code)) {
      return { ok: false, error: { code: e.code, message: String(e.message ?? e) } };
    }
    logger.error('[finance/voucher:create] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'CREATE_FAILED', message: '收付款凭证未能创建，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' } };
  }
}

export async function updatePaymentVoucher(params: {
  prisma: PrismaClient;
  voucherId: string;
  input: PaymentVoucherMutationInput;
  actorId?: string;
  actor?: TokenPayload | null;
  ip?: string | null;
}): Promise<PaymentVoucherMutationResult> {
  const { prisma, voucherId, input, actorId, ip } = params;
  const normalized = normalizeUpdateInput({ ...input });
  if (!normalized.ok) return { ok: false, error: 'error' in normalized ? normalized.error : { code: 'UPDATE_FAILED', message: 'validation failed' } };
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const access = await createFinanceSourceAccess(tx, params.actor, ['vouchers:write']);
      if (actorId !== access.actor.userId) throw businessError('UNAUTHORIZED', '财务命令缺少可信操作人。');
      const command = await beginFinanceCommand(tx, access.actor, 'voucher.update', { ...input, voucherId });
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PaymentVoucher" WHERE "id"=${voucherId} FOR UPDATE`);
      await assertNotCashRefundVoucher(tx, voucherId);
      const existing = await tx.paymentVoucher.findUnique({ where: { id: voucherId } });
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error('voucher not found'), { statusCode: 404, code: 'NOT_FOUND' });
      }
      if (!await access.voucher(existing)) throw businessError('NOT_FOUND', '凭证不在当前业务数据范围。');
      await assertVoucherCashUse(tx,access.actor,existing);
      if (command.replayed) { await access.finish(); return { ...command.receipt, replayed: true }; }
      assertFinanceRevision(existing, input.expectedUpdatedAt);
      if (existing.cashEntryId && ['type','amount','currency','paymentDate','paymentMethod','bankFee','feeBearer','customerRelationId','orderId','invoiceId'].some(field=>
        normalized.data[field]!==undefined && String(normalized.data[field]??'')!==String(existing[field]??''))
        || input.cashEntryId!=null && input.cashEntryId!==existing.cashEntryId
        || input.companyAccountId!=null && input.companyAccountId!==existing.companyAccountId)
        throw businessError('CONFLICT','已登记银行事实的方向、金额、日期、账户和来源不可覆盖；真实差异请追加准确纠正。');
      if (input.paymentRequestId != null || normalized.data.attachments !== undefined
        && (ciHash(normalized.data.attachments?.paymentRequestId ?? null) !== ciHash(existing.attachments?.paymentRequestId ?? null)
          || ciHash(normalized.data.attachments?.actualPayment ?? null) !== ciHash(existing.attachments?.actualPayment ?? null)))
        throw businessError('CONFLICT', '原付款申请及实际付款证据不可从通用凭证改写。');
      if (normalized.data.type !== undefined && normalized.data.type !== existing.type)
        throw businessError('CONFLICT', '收付款方向不能通过编辑转换，请核对真实银行交易并登记准确事实。');
      if (existing.attachments?.actualPayment && ['amount', 'currency', 'paymentDate', 'paymentMethod', 'customerRelationId', 'orderId', 'invoiceId'].some(field =>
        normalized.data[field] !== undefined && String(normalized.data[field] ?? '') !== String(existing[field] ?? '')))
        throw businessError('CONFLICT', '已登记的实际付款金额、日期、方式和准确来源不可覆盖；实际返款须另行登记。');
      const proposed = { ...existing, ...normalized.data };
      if (proposed.orderId && !await access.order(proposed.orderId)
        || proposed.invoiceId && !await access.invoice(await tx.invoice.findFirst({ where: { id: proposed.invoiceId, deletedAt: null } })))
        throw businessError('NOT_FOUND', '凭证新关联来源不可访问。');
      if (!access.all && proposed.customerRelationId !== existing.customerRelationId && !await access.customer(proposed.customerRelationId))
        throw businessError('NOT_FOUND', '凭证新交易对象不可访问。');
      const allocations = await tx.invoiceAllocation.findMany({ where: { voucherId } });
      const protectedFields = ['type', 'amount', 'currency', 'customerRelationId', 'customerName', 'orderId', 'invoiceId'];
      const differs = (field: string) => field === 'amount'
        ? !new Prisma.Decimal(normalized.data[field]).equals(existing[field])
        : (normalized.data[field] ?? null) !== (existing[field] ?? null);
      if (allocations.length && protectedFields.some(field => normalized.data[field] !== undefined && differs(field))) {
        throw Object.assign(new Error('已核销凭证的金额、币种、收付款方向及关联方不能直接改变；请先撤销核销，更正凭证后重新核销。'), { code: 'INVALID_STATE', statusCode: 409 });
      }
      if (normalized.data.appliedAmount !== undefined) {
        const total = allocations.reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.appliedAmount), new Prisma.Decimal(0));
        if (!new Prisma.Decimal(normalized.data.appliedAmount).equals(total)) throw Object.assign(new Error('已核销金额由实际核销明细计算，不能手工覆盖。'), { code: 'INVALID_STATE', statusCode: 409 });
      }
      const data = { ...normalized.data, updatedAt: BigInt(Date.now()) };
      const voucher = await tx.paymentVoucher.update({ where: { id: voucherId }, data });
      await syncPaymentVoucherReferences(prisma, voucher, { source: 'route:voucher:update' }, tx);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:voucher:update',
        operation: 'update_voucher', targetType: 'PaymentVoucher', targetId: voucher.id,
        before: { status: existing.status, amount: decimalString(existing.amount), appliedAmount: decimalString(existing.appliedAmount) },
        after: { status: voucher.status, amount: decimalString(voucher.amount), appliedAmount: decimalString(voucher.appliedAmount) },
        ip: ip || null,
      });
      await access.finish();
      const receipt = await command.commit({ voucher, auditId });
      return { ...receipt, replayed: false };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code === 'NOT_FOUND') return { ok: false, error: { code: 'NOT_FOUND', message: String(e.message ?? e) } };
    if (e?.code && typeof e.code === 'string' && !/^P\d{4}$/.test(e.code)) {
      return { ok: false, error: { code: e.code, message: String(e.message ?? e) } };
    }
    logger.error('[finance/voucher:update] transaction failed', { error: e?.message ?? String(e) });
    return { ok: false, error: { code: 'UPDATE_FAILED', message: '收付款凭证未能更新，本次改动未生效，请稍后重试；持续失败请联系管理员。' } };
  }
}
