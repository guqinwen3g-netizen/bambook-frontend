import { businessNowDate } from '../shared/businessClock';
/**
 * paymentRequestService.ts — DR-017 付款申请服务（先申请后付款唯一入口）
 *
 * 设计真源：
 *   - docs/design/02-数据模型/财务域模型组.md §2.1（PaymentRequest：审批通过前不得创建 PaymentVoucher）
 *   - docs/design/04-模块设计/05-财务与结算/应付与付款流程.md §8（DR-007 组织归属路由，去阈值化）
 *   - docs/design/04-模块设计/05-财务与结算/付款凭证管理.md §6（付款审批流设计规格）
 *   - docs/design/02-数据模型/Prisma缺口清单与迁移方案.md P1-1（PaymentRequest 模型）
 *
 * 铁律（fail-closed）：
 *   1. 审批单必须经 approvalCreateService.createBusinessApproval 创建
 *      （reviewerId 服务端 DR-007 解析，前端传入一律忽略并审计，绝不手写）
 *   2. 批准仅回写审批结论；实际付款由财务显式登记真实金额、日期和证据
 *   3. 实际付款以原请求键/完整载荷/申请版本幂等，合法部分付款分别保留
 *   4. 当前申请 Pending → Approved → Paid（足额实际付款）；历史 VoucherIssued 保留，
 *      非法迁移一律 409 拒绝
 *   5. paymentCategory 六类枚举（同 PaymentVoucher.voucherCategory，P0-9/DR-022），枚举外拒绝
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
// ★ 「业务日」口径：申请号里的日期段由发号器真源 `periodKeyForDate` 取**本地时区**日期
//   （`SequenceRegister` 的 periodKey / 模板 `{year}{month}{day}` 同源）。
//   旧写法用 `toISOString().slice(0,10)` 取 UTC 日，本地 00:00–08:00 会把日期段记成**昨天**。
//   ⇒ 该口径已随取号一并收口到发号器，本文件不再自行拼日期。
// ★ 口径 B3：付款申请三档数据范围的**共用可见性判据**（与列表 where 同源）
import { canSeePaymentRequest, type PaymentRequestScope } from './paymentRequestScope';
import { writeRouteAuditLog } from '../audit/routeAudit';
import type { ApprovalCreateService } from '../approvals/approvalCreateService';
import { createClaimCashRefundService } from '../claims/claimCashRefundService';
import { createNotificationService } from '../notifications/notificationService';
import { createSequenceService } from '../sequence/sequenceService';
import { statusFromError } from '../shared/bizStatus';
import type { TokenPayload } from '../auth/service';
import { recordSupplierActualPayment, readSupplierPaymentFacts, type SupplierActualPaymentInput } from './supplierPaymentExecutionService';
import { assertPaymentRequestPayableRead, freezePaymentRequestPayables, hasPaymentRequestPayableBasis } from './paymentRequestPayableSource';
import { createFinanceSourceAccess } from '../finance/financeSourceAccess';
import { beginFinanceCommand, type FinanceCommandReceipt } from '../finance/financeCommandReceipt';
import { ciHash } from '../development/developmentCiSource';
import { businessError } from '../shared/errorCodes';
import {
  VALID_VOUCHER_CATEGORIES,
  type VoucherCategory,
} from '../finance/paymentVoucherMutationService';

// ───────────────────────────────────────────────────────────────────
// 错误码（全部 fail-closed）
// ───────────────────────────────────────────────────────────────────
export const PAYMENT_REQUEST_ERRORS = {
  MISSING_PAYEE: 'MISSING_PAYEE',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  MISSING_CURRENCY: 'MISSING_CURRENCY',
  INVALID_PAYMENT_CATEGORY: 'INVALID_PAYMENT_CATEGORY',
  INVALID_DATE: 'INVALID_DATE',
  PAYMENT_REQUEST_NOT_FOUND: 'PAYMENT_REQUEST_NOT_FOUND',
  PAYMENT_REQUEST_NOT_APPROVED: 'PAYMENT_REQUEST_NOT_APPROVED',
  PAYMENT_REQUEST_NOT_CANCELLABLE: 'PAYMENT_REQUEST_NOT_CANCELLABLE',
  CANCEL_NOT_BY_APPLICANT: 'CANCEL_NOT_BY_APPLICANT',
  VOUCHER_ISSUE_FAILED: 'VOUCHER_ISSUE_FAILED',
  CREATE_FAILED: 'CREATE_FAILED',
  NO_REVIEWER_RESOLVED: 'NO_REVIEWER_RESOLVED',
} as const;

export type PaymentRequestErrorCode = (typeof PAYMENT_REQUEST_ERRORS)[keyof typeof PAYMENT_REQUEST_ERRORS];

export type PaymentRequestResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: PaymentRequestErrorCode | string; message: string; statusCode: number } };

// ───────────────────────────────────────────────────────────────────
// 状态机 & 付款性质枚举
// ───────────────────────────────────────────────────────────────────
export const PAYMENT_REQUEST_STATUSES = [
  'Draft',
  'Pending',
  'Approved',
  'Rejected',
  'VoucherIssued',
  'Cancelled',
  'Executing',
  'Paid',
] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

/** 付款性质 = PaymentVoucher.voucherCategory 同一枚举真源（normal/advance/deposit/三类费用） */
export const VALID_PAYMENT_CATEGORIES = VALID_VOUCHER_CATEGORIES;
export type PaymentCategory = VoucherCategory;

/** 允许申请人作废的状态（仅 Pending 及之前） */
const CANCELLABLE_STATUSES = new Set<PaymentRequestStatus>(['Draft', 'Pending']);

/** 来源单据类型（关联采购单/订单/费用；schema 无专用列，持久化于 attachments.sourceDocument） */
export const PAYMENT_REQUEST_SOURCE_TYPES = ['supplier_payable', 'purchase_order', 'order', 'expense', 'warehouse', 'other'] as const;
export type PaymentRequestSourceType = (typeof PAYMENT_REQUEST_SOURCE_TYPES)[number];

const genId = (prefix: string) =>
  `${prefix}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

function localToday(): string {
  const now = businessNowDate();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

function isValidDateString(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isValidDecimal(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    try { return new Prisma.Decimal(v).isFinite(); } catch { return false; }
  }
  return false;
}

function fail<T>(code: string, message: string, statusCode: number): PaymentRequestResult<T> {
  return { ok: false, error: { code, message, statusCode } };
}

// ───────────────────────────────────────────────────────────────────
// 服务工厂
// ───────────────────────────────────────────────────────────────────
export interface PaymentRequestServiceOptions {
  prisma: PrismaClient;
  approvalCreateService: ApprovalCreateService;
}

export interface CreatePaymentRequestInput {
  /** Stable original key for the explicit supplier_payable command. Legacy
   * non-AP or no-key callers retain their existing contract. */
  requestKey?: string;
  /** 付款对象：供应商 Relation ID 与名称至少其一必填 */
  supplierId?: string;
  supplierName?: string;
  totalAmount: number | string;
  currency: string;
  /** 付款性质（voucherCategory 六类），缺省 normal */
  paymentCategory?: string;
  requestDate?: string;
  expectedPaymentDate?: string;
  /** 关联来源单据（采购单/订单/费用） */
  sourceType?: PaymentRequestSourceType;
  sourceId?: string;
  /** Accurate supplier AP entries. Even another source label cannot bypass
   * their validation when explicitly selected. Never accepted via attachments. */
  payableSelections?: unknown;
  actor?: TokenPayload | null;
  remark?: string;
  attachments?: unknown;
  applicantId: string;
  /** 前端越权传入的 reviewerId（将被忽略，仅透传给审批服务做审计标记） */
  clientSuppliedReviewerId?: string | null;
}

/** The exact HTTP command body, before business trim/default processing.
 * Identity and routing fields are always supplied by the trusted server. */
export const PAYMENT_REQUEST_CREATE_COMMAND_FIELDS = ['requestKey', 'supplierId', 'supplierName', 'totalAmount', 'currency',
  'paymentCategory', 'requestDate', 'expectedPaymentDate', 'sourceType', 'sourceId', 'remark', 'attachments', 'payableSelections'] as const;
export function paymentRequestCreateCommandInput(input: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(PAYMENT_REQUEST_CREATE_COMMAND_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(input, field))
    .map(field => [field, input[field]]));
}
export interface CreatedPaymentRequest {
  paymentRequest: any; approvalRequestId: string; auditId?: string; financeCommand?: FinanceCommandReceipt; replayed?: boolean;
}

export function createPaymentRequestService(opts: PaymentRequestServiceOptions) {
  const { prisma, approvalCreateService } = opts;
  // ★ 发号真源（SequenceRegister + 数据库级原子 increment）—— 与 relationServiceV2 同接线方式
  const sequenceService = createSequenceService(prisma);

  // ── 内部：生成业务申请号 PAYR-YYYYMMDD-NNN ──
  //
  // ★ 2026-09-19 修复（原为登记的已知缺陷）：原实现是 `count({ startsWith: prefix }) + 1`，
  //   **先读后写** ⇒ 并发读到同一 count → 同号 → 撞 `requestNumber` 唯一键 → P2002。
  //   曾经试过「撞号换新号整体重试」，真库 **5 路并发实测仍失败 2 笔**
  //   （重试者又读到同一 count ⇒ 3 次重试耗尽）—— **有界重试治标不治本**。
  //
  //   正解 = **改用发号真源**（`SequenceRegister` 行 + 数据库级原子 `increment`），
  //   配置见 `SEQUENCE_TYPE_CONFIGS.paymentRequest`（period='day'、padding=3）：
  //   格式仍是 `PAYR-YYYYMMDD-NNN`，**用户看到的号一个字符都不变**，但不再有竞态。
  //   （本仓口径：取号一律走发号器真源，禁止业务代码自己 `count+1`。）
  //
  //   ⚠️ 必须在事务内用 `tx` 调用：取号与落库同事务 ⇒ 回滚时号一并回退，不留"号已消费、单不存在"的空洞。
  async function nextRequestNumber(tx: any): Promise<string> {
    return sequenceService.nextNumber(tx, 'paymentRequest', {
      // 占用追平：序列落后于业务表（迁移直写单号 / 序列表重建）时自动递增到首个未占用号，
      // 杜绝"生成即撞唯一键"（与 nextBusinessNumber 的 occupied 同口径）。
      occupied: async (num: string) => {
        const dup = await tx.paymentRequest.findFirst({ where: { requestNumber: num }, select: { id: true } });
        return dup != null;
      },
    });
  }

  /**
   * 撞号重试上限（P2002）。
   *
   * ⚠️ 这是**兜底**，不是主机制 —— 主机制是上面的原子发号（并发下号必然不同）。
   * 保留它只为 unforeseen 的唯一键竞争（例如历史脏数据与发号器不同步的极端场景）；
   * 超限即 fail loud，不静默产出可疑结果。
   */
  const MAX_NUMBER_COLLISION_RETRY = 3;

  // ══════════════════════════════════════════════════════════════════
  // createPaymentRequest — 创建并提交申请（scope 由 route 层守卫）
  //   创建即进入 Pending 并生成 ApprovalRequest（DR-007 组织归属路由）
  // ══════════════════════════════════════════════════════════════════
  async function createPaymentRequest(
    input: CreatePaymentRequestInput,
  ): Promise<PaymentRequestResult<CreatedPaymentRequest>> {
    if ((input as any).payeeType === 'Customer' || (input as any).customerRelationId || (input as any).cashRefundId) {
      return fail(PAYMENT_REQUEST_ERRORS.MISSING_PAYEE, '客户现金退款须从真实 CN 退款申请入口提交，不可由普通供应商付款接口拼接来源', 400);
    }
    const supplierId = String(input.supplierId ?? '').trim() || null;
    const supplierName = String(input.supplierName ?? '').trim() || null;
    // 1. 付款对象必填（供应商 ID 或名称至少其一）
    if (!supplierId && !supplierName) {
      return fail(PAYMENT_REQUEST_ERRORS.MISSING_PAYEE, '付款对象必填：supplierId 或 supplierName 至少提供其一', 400);
    }
    // 2. 金额必填且 > 0
    if (!isValidDecimal(input.totalAmount)) {
      return fail(PAYMENT_REQUEST_ERRORS.INVALID_AMOUNT, 'totalAmount 必须为合法十进制数', 400);
    }
    const amount = new Prisma.Decimal(input.totalAmount as any);
    if (amount.lte(0)) {
      return fail(PAYMENT_REQUEST_ERRORS.INVALID_AMOUNT, 'totalAmount 必须 > 0', 400);
    }
    // 3. 币种必填
    const currency = String(input.currency ?? '').trim();
    if (!currency) {
      return fail(PAYMENT_REQUEST_ERRORS.MISSING_CURRENCY, 'currency 必填', 400);
    }
    // 4. 付款性质枚举校验（fail-closed，缺省 normal）
    const paymentCategory = String(input.paymentCategory ?? 'normal').trim() || 'normal';
    if (!(VALID_PAYMENT_CATEGORIES as readonly string[]).includes(paymentCategory)) {
      return fail(
        PAYMENT_REQUEST_ERRORS.INVALID_PAYMENT_CATEGORY,
        `paymentCategory 必须是以下之一: ${VALID_PAYMENT_CATEGORIES.join(', ')}`,
        400,
      );
    }
    // 5. 日期格式校验
    const requestDate = String(input.requestDate ?? '').trim() || localToday();
    if (!isValidDateString(requestDate)) {
      return fail(PAYMENT_REQUEST_ERRORS.INVALID_DATE, 'requestDate 必须为 YYYY-MM-DD', 400);
    }
    const expectedPaymentDate = String(input.expectedPaymentDate ?? '').trim() || null;
    if (expectedPaymentDate && !isValidDateString(expectedPaymentDate)) {
      return fail(PAYMENT_REQUEST_ERRORS.INVALID_DATE, 'expectedPaymentDate 必须为 YYYY-MM-DD', 400);
    }
    // 6. 来源单据（可选）
    const sourceTypeRaw = typeof input.sourceType === 'string' ? input.sourceType.trim() : input.sourceType;
    const sourceType = sourceTypeRaw && (PAYMENT_REQUEST_SOURCE_TYPES as readonly string[]).includes(sourceTypeRaw)
      ? sourceTypeRaw
      : null;
    const sourceId = String(input.sourceId ?? '').trim() || null;
    if (sourceType === 'supplier_payable' && (!Array.isArray(input.payableSelections) || input.payableSelections.length === 0))
      return fail('PAYMENT_REQUEST_AP_REQUIRED', '请选择本次付款的准确供应商应付原票。', 409);
    if(sourceType==='warehouse'){const payee=supplierId?await prisma.relation.findFirst({where:{id:supplierId,isOrganization:true,deletedAt:null}}):null;if(!payee)return fail('INVALID_SOURCE','仓库费用须选择真实保管组织作为收款方',400);const warehouse=sourceId?await prisma.warehouse.findFirst({where:{id:sourceId,deletedAt:null}}):null;if(!warehouse)return fail('INVALID_SOURCE','仓库费用须关联真实仓库',400);const provider=(warehouse.profile as any)?.custodianRelationId;if(provider&&supplierId!==provider)return fail('INVALID_SOURCE','仓库费用收款方须与保管组织一致，请先核对仓库档案',400);}
    const sourceDocument = sourceType && sourceId ? { type: sourceType, id: sourceId } : null;

    const rawAttachments = input.attachments && typeof input.attachments === 'object' && !Array.isArray(input.attachments)
      ? input.attachments as Record<string, unknown> : {};
    if (rawAttachments.sourceSnapshot != null || rawAttachments.payableSelections != null
      || (rawAttachments.sourceDocument as any)?.type === 'supplier_payable')
      return fail('INVALID_INPUT', '准确应付冻结来源须由所选原票生成，不能由附件自报。', 400);
    const payablePath = sourceType === 'supplier_payable' || input.payableSelections !== undefined;
    const stablePayableCommand = sourceType === 'supplier_payable' && input.requestKey !== undefined;

    // 7+8. 取号 → 建审批单 → 落库：**同一事务**（原子性理由见 nextRequestNumber 注释）
    const attachments = {
      ...((input.attachments && typeof input.attachments === 'object' ? input.attachments : {}) as Record<string, unknown>),
      ...(sourceDocument ? { sourceDocument } : {}),
    };

    let lastCollision: any = null;
    for (let attempt = 1; attempt <= MAX_NUMBER_COLLISION_RETRY; attempt += 1) {
      // 每次尝试都换新 id：撞号回滚后旧 id 已不存在，复用会让审批 targetId 指向不存在的主单
      const requestId = genId('PAYR');
      try {
        const out = await prisma.$transaction(async (tx: any) => {
          const access = stablePayableCommand ? await createFinanceSourceAccess(tx, input.actor,
            ['finance:payment_request:create', 'invoices:read']) : null;
          if (access && access.actor.userId !== input.applicantId)
            throw businessError('UNAUTHORIZED', '付款申请须由当前真实登录操作人提交。');
          const command = access ? await beginFinanceCommand(tx, access.actor, 'payment_request.create', paymentRequestCreateCommandInput(input)) : null;
          if (command?.replayed) {
            const original = command.receipt.paymentRequest;
            if (!original?.id || original.applicantId !== access!.actor.userId
              || original.approvalRequestId !== command.receipt.approvalRequestId)
              throw businessError('CONFLICT', '原付款申请回执的身份或审批来源不一致。');
            await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PaymentRequest" WHERE "id"=${original.id} FOR SHARE`);
            const current = await tx.paymentRequest.findUnique({ where: { id: original.id } });
            if (!current || current.deletedAt) throw businessError('NOT_FOUND', '原付款申请不存在，或已不可访问。');
            const immutableFields = ['id', 'requestNumber', 'payeeType', 'supplierId', 'totalAmount', 'currency', 'paymentCategory',
              'applicantId', 'reviewerId', 'approvalRequestId'];
            if (immutableFields.some(field => ciHash(current[field] ?? null) !== ciHash(original[field] ?? null))
              || ciHash(current.attachments?.sourceSnapshot ?? null) !== ciHash(original.attachments?.sourceSnapshot ?? null)
              || ciHash(current.attachments?.sourceDocument ?? null) !== ciHash(original.attachments?.sourceDocument ?? null))
              throw businessError('CONFLICT', '原付款申请的准确应付或审批来源已变化。');
            // Read access proves every original AP and its immutable source,
            // while deliberately ignoring capacity consumed by later payments.
            await assertPaymentRequestPayableRead(tx, current, access!.actor);
            await access!.finish();
            return { data: { ...command.receipt, replayed: true } as CreatedPaymentRequest, replayed: true,
              approval: null, requestNumber: original.requestNumber };
          }
          const sourceSnapshot = payablePath ? await freezePaymentRequestPayables(tx, { actor: input.actor,
            applicantId: input.applicantId, supplierId, currency, totalAmount: amount.toFixed(4), selections: input.payableSelections }) : null;
          const exactSource = sourceSnapshot ? { type: 'supplier_payable', id: sourceSnapshot.sourceFingerprint } : sourceDocument;
          const exactAttachments = { ...attachments, ...(exactSource ? { sourceDocument: exactSource } : {}),
            ...(sourceSnapshot ? { sourceSnapshot } : {}) };
          // ★ 取号在事务内（用 tx，不用外层 prisma）—— 否则退回「先读后写」竞态
          const requestNumber = await nextRequestNumber(tx);
          // ★ 审批单同事务（client: tx）—— 落库回滚时审批单一起回滚，不留孤儿审批单
          const approval = await approvalCreateService.createBusinessApproval({
            requesterId: input.applicantId,
            actionType: 'finance:payment_request',
            targetType: 'PaymentRequest',
            targetId: requestId,
            payload: {
              requestNumber,
              supplierId,
              supplierName,
              totalAmount: amount.toString(),
              currency,
              paymentCategory,
              expectedPaymentDate,
              sourceDocument: exactSource,
              ...(sourceSnapshot ? { sourceSnapshot } : {}),
            },
            risk: 'high',
            clientSuppliedReviewerId: input.clientSuppliedReviewerId ?? null,
            client: tx,
          });
          const pr = await tx.paymentRequest.create({
            data: {
              id: requestId,
              requestNumber,
              supplierId,
              supplierName,
              requestDate,
              expectedPaymentDate,
              totalAmount: amount,
              currency,
              applicantId: input.applicantId,
              reviewerId: approval.reviewerId as string,
              status: 'Pending',
              approvalRequestId: approval.id,
              paymentCategory,
              ownerId: input.applicantId,
              remark: String(input.remark ?? '').trim() || null,
              attachments: (Object.keys(exactAttachments).length > 0 ? exactAttachments : undefined) as any,
            },
          });
          const auditId = await writeRouteAuditLog({
            prisma: tx, actorId: input.applicantId, source: 'service:payment-request:create',
            operation: 'payment_request_create', targetType: 'PaymentRequest', targetId: requestId,
            after: { requestNumber, status: 'Pending', paymentCategory, totalAmount: amount.toString(), currency, approvalRequestId: approval.id },
          });
          if (access) await access.finish();
          const data: CreatedPaymentRequest = command
            ? await command.commit({ paymentRequest: pr, approvalRequestId: approval.id, auditId })
            : { paymentRequest: pr, approvalRequestId: approval.id };
          return { data, approval, requestNumber, replayed: false };
        });

        // §10.3-11 通知中心：付款申请已提交 → 通知审批人。
        // 单播（sendToUser）而非广播：跨账号协作通知只应到达当事人，避免全员噪声。
        // ⚠️ 必须在**事务提交之后**发：回滚掉的事务不该产生通知。
        if (!out.replayed && out.approval?.reviewerId) {
          await createNotificationService(prisma).sendToUser({
            userId: String(out.approval.reviewerId),
            type: 'payment_request_submitted',
            title: '待你审批：付款申请',
            body: `${out.requestNumber} · ${supplierName ?? ''} · ${amount} ${currency}`.trim(),
            level: 'info',
            link: '/finance?tab=paymentRequests',
            metadata: { paymentRequestId: requestId, approvalRequestId: out.approval.id },
          }).catch(() => null);
        }
        if (!out.replayed) logger.info('[PaymentRequest] 付款申请已创建', {
          id: requestId, requestNumber: out.requestNumber, paymentCategory, applicantId: input.applicantId, approvalRequestId: out.approval!.id,
        });
        return { ok: true, data: out.data };
      } catch (e: any) {
        // ① 未解析到审批人：fail-closed，409 原样透传，**不重试**（重试不会变好，只会掩盖组织配置问题）
        if (e?.code === PAYMENT_REQUEST_ERRORS.NO_REVIEWER_RESOLVED || e?.code === 'NO_REVIEWER_RESOLVED') {
          // B129 收口（v3.12）：**只把硬编码的 409 改成真尺给**；fail-closed 不重试这个分支语义一行未动
          return fail(PAYMENT_REQUEST_ERRORS.NO_REVIEWER_RESOLVED, e?.message ?? '未解析到审批人', statusFromError(e, 500));
        }
        // ② 申请号撞车（唯一键）：换新号**整体重试** —— 审批 payload 的号随之重算 ⇒ 与落库号恒一致
        if (e?.code === 'P2002') {
          lastCollision = e;
          logger.warn('[PaymentRequest] 申请号撞车，换新号重试', { attempt, error: e?.message });
          continue;
        }
        // ③ 其余失败（含审批单创建失败 APPROVAL_CREATE_FAILED）：**不重试**，原样透传
        logger.error('[PaymentRequest] 付款申请创建失败', { error: e?.message });
        return fail(e?.code ?? PAYMENT_REQUEST_ERRORS.CREATE_FAILED, e?.message ?? `付款申请创建事务失败: ${String(e?.message ?? e)}`, statusFromError(e, 500));
      }
    }
    logger.error('[PaymentRequest] 申请号并发冲突重试耗尽', { attempts: MAX_NUMBER_COLLISION_RETRY, error: lastCollision?.message });
    return fail(
      PAYMENT_REQUEST_ERRORS.CREATE_FAILED,
      `付款申请号并发冲突，重试 ${MAX_NUMBER_COLLISION_RETRY} 次仍失败：${String(lastCollision?.message ?? '')}`,
      500,
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // Approval and actual bank execution are separate; the compatibility alias
  // requires the same explicit facts and trusted actor as recordActualPayment.
  //   未批准一律 409；已关联凭证时重复调用直接返回既有凭证（防重复生成）
  // ══════════════════════════════════════════════════════════════════
  async function recordActualPayment(params: {
    paymentRequestId: string; actorId?: string; actor?: TokenPayload | null; input: SupplierActualPaymentInput;
  }) {
    return recordSupplierActualPayment({ prisma, ...params });
  }

  /** Compatibility name: an explicit real payment command, never approval
   * automation. Missing actual fields/identity fail closed. */
  async function issueVoucherForApprovedRequest(params: {
    paymentRequestId: string; actorId?: string; actor?: TokenPayload | null;
    requestKey?: string; expectedRequestUpdatedAt?: string; amount?: string | number; currency?: string;
    paymentMethod?: string; paymentDate?: string; bankReference?: string; evidenceNote?: string;
  }) {
    const { paymentRequestId, actorId, actor, ...input } = params;
    return recordActualPayment({ paymentRequestId, actorId, actor, input: input as SupplierActualPaymentInput });
  }

  // ══════════════════════════════════════════════════════════════════
  // syncApprovalDecision — 审批决定回写（由审批侧回调/轮询驱动）
  //   approved → Approved；rejected → Rejected；pending → 无操作。
  //   只同步真实审批结论，绝不据此推算实际付款。
  // ══════════════════════════════════════════════════════════════════
  async function syncApprovalDecision(params: {
    paymentRequestId: string;
    actorId: string;
  }): Promise<PaymentRequestResult<{ paymentRequest: any; synced: boolean; voucher?: any }>> {
    const { paymentRequestId, actorId } = params;
    const pr = await prisma.paymentRequest.findUnique({ where: { id: paymentRequestId } });
    if (!pr || pr.deletedAt) {
      return fail(PAYMENT_REQUEST_ERRORS.PAYMENT_REQUEST_NOT_FOUND, `付款申请 ${paymentRequestId} 不存在或已删除`, 404);
    }
    const cashRefund = await (prisma as any).creditNoteRefund.findUnique({ where: { paymentRequestId: pr.id } });
    if (cashRefund || (pr as any).payeeType === 'Customer') {
      if (!cashRefund) return fail(PAYMENT_REQUEST_ERRORS.PAYMENT_REQUEST_NOT_APPROVED, '客户付款申请缺少真实 CN 退款来源，请人工续办', 409);
      const synced = await createClaimCashRefundService({ prisma }).syncDecision(pr.id);
      return { ok: true, data: { paymentRequest: synced!.paymentRequest, synced: synced!.synced } };
    }
    if (pr.status !== 'Pending' || !pr.approvalRequestId) {
      return { ok: true, data: { paymentRequest: pr, synced: false } };
    }
    const projection = await prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PaymentRequest" WHERE "id"=${pr.id} FOR UPDATE`);
      const current = await tx.paymentRequest.findUnique({ where: { id: pr.id } });
      if (!current || current.deletedAt) throw Object.assign(new Error('原付款申请不存在。'), {code:'NOT_FOUND'});
      if (current.status !== 'Pending' || !current.approvalRequestId) return {paymentRequest:current,synced:false};
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ApprovalRequest" WHERE "id"=${current.approvalRequestId} FOR SHARE`);
      const approval = await tx.approvalRequest.findUnique({ where: { id: current.approvalRequestId } });
      if (!approval || approval.status === 'pending') return {paymentRequest:current,synced:false};
      if (!['approved','rejected'].includes(approval.status) || approval.targetType !== 'PaymentRequest' || approval.targetId !== current.id
        || approval.actionType !== 'finance:payment_request' || approval.requesterId !== current.applicantId || !approval.reviewerId)
        throw Object.assign(new Error('审批来源或实际决议与原付款申请不一致。'), {code:'CONFLICT'});
      const nextStatus = approval.status === 'approved' ? 'Approved' : 'Rejected';
      const changed = await tx.paymentRequest.updateMany({ where: {id:current.id,status:'Pending',approvalRequestId:current.approvalRequestId},
        data: {status:nextStatus,updatedAt:new Date(Math.max(Date.now(),new Date(current.updatedAt).getTime()+1))} });
      if (changed.count !== 1) throw Object.assign(new Error('付款申请在审批回写中变化，请重新核对。'), {code:'CONFLICT'});
      await writeRouteAuditLog({ prisma:tx,actorId:approval.reviewerId,source:'service:payment-request:sync-decision',
        operation:'payment_request_decision',targetType:'PaymentRequest',targetId:current.id,
        before:{status:'Pending'},after:{status:nextStatus,approvalStatus:approval.status},transactionId:current.approvalRequestId });
      return {paymentRequest:await tx.paymentRequest.findUnique({where:{id:current.id}}),synced:true};
    });
    // Approval alone is not a bank payment, including after a delayed hook.
    return {ok:true,data:projection};
  }

  // ══════════════════════════════════════════════════════════════════
  // cancelPaymentRequest — 申请人作废（仅 Draft/Pending，仅本人）
  // ══════════════════════════════════════════════════════════════════
  async function cancelPaymentRequest(params: {
    paymentRequestId: string;
    actorId: string;
  }): Promise<PaymentRequestResult<{ paymentRequest: any }>> {
    const { paymentRequestId, actorId } = params;
    const pr = await prisma.paymentRequest.findUnique({ where: { id: paymentRequestId } });
    if (!pr || pr.deletedAt) {
      return fail(PAYMENT_REQUEST_ERRORS.PAYMENT_REQUEST_NOT_FOUND, `付款申请 ${paymentRequestId} 不存在或已删除`, 404);
    }
    const cashRefund = await (prisma as any).creditNoteRefund.findUnique({ where: { paymentRequestId: pr.id } });
    if (cashRefund || (pr as any).payeeType === 'Customer') {
      return fail(PAYMENT_REQUEST_ERRORS.PAYMENT_REQUEST_NOT_CANCELLABLE, '客户退款须使用专用撤回入口同步释放预留并保留审批/执行历史；已实付不可假作废', 409);
    }
    if (!CANCELLABLE_STATUSES.has(pr.status as PaymentRequestStatus)) {
      return fail(
        PAYMENT_REQUEST_ERRORS.PAYMENT_REQUEST_NOT_CANCELLABLE,
        `付款申请当前状态 ${pr.status}，仅 Draft/Pending 可作废`,
        409,
      );
    }
    if (pr.applicantId !== actorId) {
      return fail(PAYMENT_REQUEST_ERRORS.CANCEL_NOT_BY_APPLICANT, '仅申请人本人可作废付款申请', 403);
    }
    try {
      const updated = await prisma.$transaction(async (tx: any) => {
        const next = await tx.paymentRequest.update({ where: { id: pr.id }, data: { status: 'Cancelled' } });
        // 关联审批单仍在 pending → 一并撤回，防止审批人继续处理已作废申请
        if (pr.approvalRequestId) {
          await tx.approvalRequest.updateMany({
            where: { id: pr.approvalRequestId, status: 'pending' },
            data: { status: 'cancelled', decidedAt: businessNowDate(), decisionNote: `付款申请 ${pr.requestNumber} 已被申请人作废` },
          });
        }
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'service:payment-request:cancel',
          operation: 'payment_request_cancel', targetType: 'PaymentRequest', targetId: pr.id,
          before: { status: pr.status },
          after: { status: 'Cancelled' },
        });
        return next;
      });
      logger.info('[PaymentRequest] 付款申请已作废', { paymentRequestId, actorId });
      return { ok: true, data: { paymentRequest: updated } };
    } catch (e: any) {
      logger.error('[PaymentRequest] 作废失败', { paymentRequestId, error: e?.message });
      // D52 覆盖面：try 内唯一写 = $transaction（:493），之后只有 logger + return ⇒ 可以承诺零改动。
      return fail(PAYMENT_REQUEST_ERRORS.CREATE_FAILED, '付款申请作废未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该申请单的审批单与状态。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // listPaymentRequests / getPaymentRequest — 只读查询（与 paymentRequestRoute GET 同一合约真源）
  //   Agent 只读工具与路由共用本入口；纯查询，不触发审批链、不写库
  // ══════════════════════════════════════════════════════════════════
  async function listPaymentRequests(filter: {
    status?: string;
    paymentCategory?: string;
    applicantId?: string;
    limit?: number;
    /**
     * ★ 口径 B3（2026-09-17 业务方拍板）：**三档数据范围 where 片段**（由 route 层解析后传入）。
     * 不传 = 不过滤（内部调用/系统任务）。构造见 `paymentRequestScope.ts`。
     */
    scopeWhere?: Record<string, unknown>;
    actor?: TokenPayload | null;
  }): Promise<{ items: any[] }> {
    const where: any = { deletedAt: null };
    if (filter.status) where.status = filter.status;
    if (filter.paymentCategory) where.paymentCategory = filter.paymentCategory;
    if (filter.applicantId) where.applicantId = filter.applicantId;
    // ★ 口径 B3：叠加数据范围（**AND** 语义 —— 与上面的业务筛选并存，不是覆盖）
    if (filter.scopeWhere && Object.keys(filter.scopeWhere).length > 0) {
      where.AND = [filter.scopeWhere];
    }
    const candidates = await prisma.paymentRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    const items = [];
    for (const item of candidates) {
      if (hasPaymentRequestPayableBasis(item)) {
        try { await prisma.$transaction(tx => assertPaymentRequestPayableRead(tx, item, filter.actor)); }
        catch (error) {
          if ([403, 404].includes(statusFromError(error, 500))) continue;
          throw error;
        }
      }
      items.push(item);
    }
    return { items: items.slice(0, Math.min(filter.limit ?? 100, 500)) };
  }

  async function getPaymentRequest(
    id: string,
    /**
     * ★ 口径 B3：**详情同样受三档范围约束** —— 否则「列表看不见、改个 id 就能看见」，
     * 范围过滤形同虚设。不传 = 不过滤（内部调用）。
     */
    scope?: PaymentRequestScope,
    actor?: TokenPayload | null,
  ): Promise<{ item: any | null }> {
    const item = await prisma.paymentRequest.findUnique({ where: { id } });
    if (!item || item.deletedAt) return { item: null };
    // ★ 口径 B3：越权时返回 **null（与"不存在"同响应）**，不泄露「这条存在但你看不到」
    //   判据走**共用内核** `canSeePaymentRequest`（与列表 where 同源，防两处漂移）
    if (scope && !canSeePaymentRequest(item, scope)) return { item: null };
    if (hasPaymentRequestPayableBasis(item))
      await prisma.$transaction(tx => assertPaymentRequestPayableRead(tx, item, actor));
    // 关联数据单独查询（PaymentRequest 模型无 @relation，禁用 include）
    const [approvalRequest, paymentVoucher] = await Promise.all([
      item.approvalRequestId
        ? prisma.approvalRequest.findUnique({
            where: { id: item.approvalRequestId },
            select: { id: true, status: true, reviewerId: true, decidedAt: true, decisionNote: true },
          }).catch(() => null)
        : Promise.resolve(null),
      item.paymentVoucherId
        ? prisma.paymentVoucher.findUnique({
            where: { id: item.paymentVoucherId },
            select: { id: true, voucherNumber: true, type: true, voucherCategory: true, amount: true, currency: true, status: true },
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const actualPayments = item.payeeType === 'Customer' ? null : await readSupplierPaymentFacts(prisma, item);
    return { item: { ...item, approvalRequest, paymentVoucher, actualPayments } };
  }

  return {
    createPaymentRequest,
    issueVoucherForApprovedRequest,
    recordActualPayment,
    syncApprovalDecision,
    cancelPaymentRequest,
    listPaymentRequests,
    getPaymentRequest,
  };
}

export type PaymentRequestService = ReturnType<typeof createPaymentRequestService>;
