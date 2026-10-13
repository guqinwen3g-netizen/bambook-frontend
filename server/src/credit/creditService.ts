import { businessNowDate } from '../shared/businessClock';
/**
 * creditService.ts — 信用控制域统一信用服务（Track F 唯一入口）
 *
 * 设计真源：
 *   - docs/design/03-业务规则/信用控制规则.md §2.2.1（占用/释放闭环 + CreditLimitHistory append-only）
 *     §2.4（规则① 60 天逾期冻结新单）/ §6 触发矩阵 #5/#6 / §13 DR-013 受控例外
 *   - docs/design/04-模块设计/06-资源与支撑/Risks-风险管理/信用风险管理.md §5/§6（信用扫描与状态机）
 *   - server/prisma/schema.prisma CreditLimit（frozenAt/frozenBy/thawedReason/lastAutoScanDate）
 *     / CreditLimitHistory（append-only）
 *
 * 铁律（fail-closed）：
 *   1. 人工冻结/解冻必填理由；scope（credit:freeze:write / credit:thaw:write）由 route 层守卫
 *   2. CreditLimit.usedAmount 的一切写操作必须同步 append CreditLimitHistory（同一事务/同一 tx）
 *   3. 60 天逾期自动冻结幂等：仅 Active → Frozen；已 Frozen 不重复写历史；
 *      lastAutoScanDate 标记最近巡检时间
 *   4. 自动解冻双路径：①主管手动解冻（thawCredit，记录 thawedReason）
 *      ②逾期款全额核销后自动解冻（autoThawIfSettled 供核销域调用 / runAutoThawScan 扫描器兜底）；
 *      自动解冻仅覆盖「系统自动冻结」（frozenBy=system_credit_scan）的额度，
 *      人工冻结必须人工解冻（防止系统自动动作覆盖人工合规判断）
 *   5. 逾期口径与 receivableOverdueDetector / riskService 同源：
 *      effectiveDue = dueDate ?? issueDate + 30 天（Net 30 推定）；
 *      冻结阈值 Net61+ 桶（daysOverdue > 60，同信用控制规则.md §2.3/§2.4 与 riskService 扫描）
 *
 * 门禁标记说明：schema 无 Customer.creditFrozen 字段（schema 属跨轨所有权，本轨不改），
 *   「客户信用冻结门禁标记」以 CreditLimit.status='Frozen' 为唯一真源，
 *   checkCreditAvailable 返回的 creditFrozen/blocked 字段即门禁结论。
 *
 * 事件说明：BusinessEventType 联合类型属事件总线跨域所有权，本轨不新增事件类型；
 *   冻结/解冻的审计真源为 AuditLog + CreditLimitHistory（append-only）。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { writeRouteAuditLog } from '../audit/routeAudit';
// ★ 「未结清应收」判据唯一真源（含金额守卫）—— 别再手写 status 集合：
//   0 元/负额应收票会被误判为逾期 → 虚增 maxOverdueDays → 永久挡单且无自动解冻路径。
//   真库证据：scripts/acceptance-zero-amount-invoice-credit-gate.ts
import { openReceivableWhere, hasOpenAmount } from '../shared/openReceivable';
import { sumAppliedAmountByInvoice } from '../shared/invoiceAppliedSum';

// ───────────────────────────────────────────────────────────────────
// 错误码（全部 fail-closed）
// ───────────────────────────────────────────────────────────────────
export const CREDIT_ERRORS = {
  RELATION_REQUIRED: 'RELATION_REQUIRED',
  CREDIT_REASON_REQUIRED: 'CREDIT_REASON_REQUIRED',
  CREDIT_LIMIT_NOT_FOUND: 'CREDIT_LIMIT_NOT_FOUND',
  CREDIT_ALREADY_FROZEN: 'CREDIT_ALREADY_FROZEN',
  CREDIT_NOT_FROZEN: 'CREDIT_NOT_FROZEN',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  CREDIT_WRITE_FAILED: 'CREDIT_WRITE_FAILED',
} as const;

export type CreditErrorCode = (typeof CREDIT_ERRORS)[keyof typeof CREDIT_ERRORS];

export type CreditResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: CreditErrorCode; message: string; statusCode: number } };

/** 系统自动冻结/解冻身份（CreditLimit.frozenBy / CreditLimitHistory.triggerBy） */
export const SYSTEM_CREDIT_ACTOR = 'system_credit_scan';

/** 60 天逾期冻结阈值：daysOverdue > 60（Net61+ 桶，与信用控制规则 §2.3/§2.4 一致） */
export const OVERDUE_FREEZE_THRESHOLD_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const NET30_DAYS = 30;
// 「未结清应收」状态集合已收归 shared/openReceivable（唯一真源，含金额守卫）

/** shiftUsedAmount CAS 重试上限（超限抛错 → 调用方 CREDIT_WRITE_FAILED，fail-closed） */
const MAX_SHIFT_CAS_ATTEMPTS = 5;

const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const epochNow = () => BigInt(Date.now());

function fail<T>(code: CreditErrorCode, message: string, statusCode: number): CreditResult<T> {
  return { ok: false, error: { code, message, statusCode } };
}

// ───────────────────────────────────────────────────────────────────
// usedAmount 实时联动（2026-09-02 信用域空转修复）
//
// 审计证据：reserveCredit/releaseCredit 全库唯一调用方是 orderChangeRequestService；
// 发票开立/作废/核销均不触发 usedAmount 变化 → seed 直写的 usedAmount 与真实应收漂移。
// 修复口径：事件驱动重算——净额口径（Σ open AR = Σ发票 amount − Σ核销 applied），
//   在 invoiceMutationService（创建/更新）、voidDeleteService（作废/软删）、
//   allocationService/allocationMutationService（核销增改删）、proformaInvoiceService（PI 转正式）
//   的成功事务内调用 notifyCustomerCreditRecalc 收口。
//
// 币种口径（与 checkCreditAvailable / reserveCredit 现行语义保持同口径）：
//   不折算、按原币直加。CreditLimit.currency 与该客户应收发票币种一致是既有记账约定
//   （额度 USD 客户的应收亦以 USD 记账），checkCreditAvailable 的额度比较同样不做币种折算，
//   本重算不引入第二套口径。
// ───────────────────────────────────────────────────────────────────

/** 净额口径排除的发票状态（已作废/已冲销不再构成应收；Draft/Paid 自然收敛：Draft 未核销全额计入，Paid 净额为 0） */
const NET_AR_EXCLUDED_STATUSES = ['Cancelled', 'Void'];

/**
 * 客户未结清应收净额（Decimal-safe）：Σ(type=Receivable, deletedAt=null, status∉Cancelled/Void).amount
 *   − Σ(InvoiceAllocation.appliedAmount)。
 * 单一真源：crmService.calculateUsedCredit（改额度初始快照）与 recalculateCustomerCredit
 *   （事件驱动重算）共用本函数，杜绝毛额/净额两套口径漂移。
 */
export async function computeNetOpenReceivables(db: any, relationId: string): Promise<Prisma.Decimal> {
  const invoices: Array<{ id: string; amount: any }> = await db.invoice.findMany({
    where: {
      deletedAt: null,
      type: 'Receivable',
      status: { notIn: NET_AR_EXCLUDED_STATUSES },
      customerRelationId: relationId,
    },
    select: { id: true, amount: true },
  });
  if (invoices.length === 0) return new Prisma.Decimal(0);

  // 已核销真源（收款核销 + 贷项票抵扣）—— 此前只算收款 ⇒ 客户拿了折让后授信净额虚高
  const appliedNumByInvoice = await sumAppliedAmountByInvoice(db, invoices.map((inv: any) => inv.id));
  const appliedByInvoice = new Map<string, Prisma.Decimal>();
  for (const [invoiceId, v] of appliedNumByInvoice) {
    appliedByInvoice.set(invoiceId, new Prisma.Decimal(v));
  }

  let net = new Prisma.Decimal(0);
  for (const inv of invoices) {
    const applied = appliedByInvoice.get(inv.id) ?? new Prisma.Decimal(0);
    net = net.plus(new Prisma.Decimal(inv.amount)).minus(applied);
  }
  // 核销校验保证单张发票不会超核销，理论上每张净额 ≥0；总 floor 0 防御历史脏数据
  return net.lt(0) ? new Prisma.Decimal(0) : net;
}

export interface RecalculateCustomerCreditParams {
  relationId: string;
  /** 历史留痕 triggerType，缺省 credit_recalc */
  triggerType?: string;
  triggerId?: string | null;
  triggerBy?: string | null;
  reason: string;
}

/**
 * 重算并覆写客户 usedAmount（绝对值覆写=幂等；值无变化时 no-op 不写历史防噪声）。
 * 目标额度行：该 relation 最新一条未删 CreditLimit（与 getCreditStatus 同口径，
 * Frozen 额度的占用同样需要保持真实）。
 * 必须在调用方事务内执行（tx client），保证 usedAmount 覆写与 CreditLimitHistory append
 * 同事务落库（铁律 #2）。
 */
export async function recalculateCustomerCredit(
  db: any,
  params: RecalculateCustomerCreditParams,
): Promise<{ recalculated: boolean; before: number; after: number } | null> {
  const relationId = (params.relationId ?? '').trim();
  if (!relationId) return null;
  const cl = await db.creditLimit.findFirst({
    where: { relationId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!cl) return null; // 无额度行 → 无可重算（与 reserveCredit/releaseCredit 的跳过语义一致）

  const net = await computeNetOpenReceivables(db, relationId);
  const before = new Prisma.Decimal(cl.usedAmount);
  if (before.eq(net)) return { recalculated: false, before: before.toNumber(), after: net.toNumber() };

  await db.creditLimit.update({
    where: { id: cl.id },
    data: { usedAmount: net, updatedAt: epochNow() },
  });
  await appendCreditLimitHistory(db, {
    creditLimitId: cl.id,
    relationId,
    beforeUsedAmount: before.toNumber(),
    afterUsedAmount: net.toNumber(),
    triggerType: params.triggerType ?? 'credit_recalc',
    triggerId: params.triggerId ?? null,
    triggerBy: params.triggerBy ?? null,
    remark: params.reason,
  });
  return { recalculated: true, before: before.toNumber(), after: net.toNumber() };
}

/**
 * 应收变动后通知信用域重算（finance 域核销/发票路径统一挂接点）。
 * 安全性约定（与 notifyShipmentBatchSettlementRecalc 同模式）：
 *   - 失败不阻断主业务：内部全量 catch + logger.warn，永不 throw；
 *   - 幂等收敛：重算为绝对值覆写，本次失败后任一后续应收变动（开票/核销/作废）自动收敛；
 *   - invoiceId 入参仅解析 type='Receivable' 的发票（Payable/Proforma 不影响客户信用）。
 */
export async function notifyCustomerCreditRecalc(
  db: any,
  opts: {
    invoiceId?: string | null;
    relationId?: string | null;
    source: string;
    triggerId?: string | null;
    triggerBy?: string | null;
    reason?: string;
  },
): Promise<void> {
  try {
    let relationId = opts.relationId ?? null;
    if (!relationId && opts.invoiceId) {
      const inv = await db.invoice.findUnique({
        where: { id: opts.invoiceId },
        select: { type: true, customerRelationId: true },
      });
      if (!inv || inv.type !== 'Receivable' || !inv.customerRelationId) return;
      relationId = inv.customerRelationId;
    }
    if (!relationId) return;
    await recalculateCustomerCredit(db, {
      relationId,
      triggerId: opts.triggerId ?? null,
      triggerBy: opts.triggerBy ?? null,
      reason: opts.reason ?? `应收净额变动自动重算（source=${opts.source}）`,
    });
  } catch (e: any) {
    logger.warn(
      `[Credit] usedAmount 重算失败（不阻断主业务，下次应收变动自动收敛）`
      + ` source=${opts.source} invoiceId=${opts.invoiceId ?? '-'} err=${String(e?.message ?? e)}`,
    );
  }
}

/**
 * append-only 写 CreditLimitHistory（usedAmount 一切写操作的唯一留痕出口）。
 * 模块级导出：creditService 工厂内部（shift/transition）与 crmService.setCreditLimit
 * （新额度行初始 usedAmount 快照）共用，保证铁律 #2 全路径覆盖。
 */
export async function appendCreditLimitHistory(
  db: any,
  params: {
    creditLimitId: string;
    relationId: string;
    beforeUsedAmount: number;
    afterUsedAmount: number;
    triggerType: string;
    triggerId?: string | null;
    triggerBy?: string | null;
    remark?: string | null;
  },
): Promise<void> {
  await db.creditLimitHistory.create({
    data: {
      id: genId('CLHIST'),
      creditLimitId: params.creditLimitId,
      relationId: params.relationId,
      beforeUsedAmount: params.beforeUsedAmount,
      afterUsedAmount: params.afterUsedAmount,
      delta: params.afterUsedAmount - params.beforeUsedAmount,
      triggerType: params.triggerType,
      triggerId: params.triggerId ?? null,
      triggerBy: params.triggerBy ?? null,
      remark: params.remark ?? null,
    },
  });
}

/** 解析 YYYY-MM-DD 为本地零点毫秒；非法返回 null（与 receivableOverdueDetector 同口径） */
function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 有效到期日（本地零点毫秒）：dueDate 优先，缺失按 Net 30 推定；均无法解析返回 null */
function effectiveDueMs(dueDate: string | null, issueDate: string): number | null {
  const due = parseDate(dueDate);
  if (due !== null) return due;
  const issue = parseDate(issueDate);
  if (issue === null) return null;
  return issue + NET30_DAYS * DAY_MS;
}

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// ───────────────────────────────────────────────────────────────────
// 服务工厂
// ───────────────────────────────────────────────────────────────────
export interface CreditServiceOptions {
  prisma: PrismaClient;
}

export interface FreezeCreditInput {
  relationId: string;
  /** 冻结理由（人工冻结必填） */
  reason: string;
  /** 操作人 userId（route 层已鉴权） */
  actorId: string;
  triggerId?: string;
}

export interface ThawCreditInput {
  relationId: string;
  /** 解冻理由（记录到 CreditLimit.thawedReason） */
  reason: string;
  actorId: string;
  triggerId?: string;
}

export interface CreditShiftInput {
  relationId: string;
  amount: number;
  triggerType: string;
  triggerId?: string;
  triggerBy?: string;
  remark?: string;
  /** 外部事务（如 orderChanges apply 事务）；缺省使用服务内 prisma 自开事务 */
  tx?: any;
}

export function createCreditService(opts: CreditServiceOptions) {
  const { prisma } = opts;

  // ── 内部：查询客户未结清应收发票的最大逾期天数 ──
  // ★ 判据走 shared/openReceivable（含 amount>0 守卫）：不欠钱的票不产生逾期。
  async function maxOverdueDays(db: any, relationId: string, todayMs: number): Promise<number> {
    const invoices = await db.invoice.findMany({
      where: openReceivableWhere({ customerRelationId: relationId }),
      select: { id: true, dueDate: true, issueDate: true, amount: true },
    });
    let max = 0;
    for (const inv of invoices) {
      if (!hasOpenAmount(inv.amount)) continue; // 兜底：mock / 内存行也要挡住
      const dueMs = effectiveDueMs(inv.dueDate, inv.issueDate);
      if (dueMs === null) continue;
      const days = Math.floor((todayMs - dueMs) / DAY_MS);
      if (days > max) max = days;
    }
    return max;
  }

  // ── 内部：append-only 写 CreditLimitHistory（usedAmount 写操作的唯一出口；模块级实现见 appendCreditLimitHistory） ──

  // ── 内部：usedAmount 偏移（delta>0 占用 / delta<0 释放；释放 floor 0） ──
  // 并发安全（GAP 收口）：读-改-写会丢更新，改为 CAS 原子自增：
  //   updateMany({ where: { id, status: 'Active', deletedAt: null, usedAmount: 快照 } },
  //               { data: { usedAmount: { increment: 实际delta } } })
  //   count=0 说明快照已被并发事务推进 → 重读重试（上限 MAX_SHIFT_CAS_ATTEMPTS 次，fail-closed）。
  // 历史留痕说明：before/after 取自 CAS 成功时的快照，并发下单行 before/after 可能与其他
  //   事务交错，但每行 delta 均为真实落库增量，Σdelta 与 usedAmount 终值严格一致（append-only 账本语义不变）。
  async function shiftUsedAmount(
    db: any,
    params: {
      relationId: string;
      delta: number;
      triggerType: string;
      triggerId?: string;
      triggerBy?: string;
      remark?: string;
    },
  ): Promise<{ adjusted: boolean; before: number; after: number; creditLimitId: string | null }> {
    for (let attempt = 0; attempt < MAX_SHIFT_CAS_ATTEMPTS; attempt++) {
      const cl = await db.creditLimit.findFirst({
        where: { relationId: params.relationId, status: 'Active', deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (!cl) return { adjusted: false, before: 0, after: 0, creditLimitId: null };
      const before = Number(cl.usedAmount);
      const after = Math.max(0, before + params.delta);
      const appliedDelta = after - before; // 释放超余额时按 floor 0 收敛后的真实增量
      const cas = await db.creditLimit.updateMany({
        where: { id: cl.id, status: 'Active', deletedAt: null, usedAmount: before },
        data: { usedAmount: { increment: appliedDelta }, updatedAt: epochNow() },
      });
      if (cas.count === 0) continue; // 并发推进了 usedAmount/状态 → 重读快照重试
      await appendCreditLimitHistory(db, {
        creditLimitId: cl.id,
        relationId: params.relationId,
        beforeUsedAmount: before,
        afterUsedAmount: after,
        triggerType: params.triggerType,
        triggerId: params.triggerId,
        triggerBy: params.triggerBy,
        remark: params.remark,
      });
      return { adjusted: true, before, after, creditLimitId: cl.id };
    }
    throw new Error(`信用额度 usedAmount 并发冲突，CAS 重试 ${MAX_SHIFT_CAS_ATTEMPTS} 次仍失败（relationId=${params.relationId}）`);
  }

  // ── 内部：对一组额度执行状态迁移 + 历史留痕 + 审计（freeze/thaw 共用） ──
  async function transitionLimits(
    db: any,
    limits: any[],
    targetStatus: 'Frozen' | 'Active',
    meta: {
      actorId: string;
      reason: string;
      triggerType: 'credit_freeze' | 'credit_thaw';
      triggerId?: string | null;
      auditAction: string;
      auditSource: string;
      markAutoScan?: boolean;
    },
  ) {
    const now = epochNow();
    const nowDate = new Date();
    const transitioned: string[] = [];
    for (const cl of limits) {
      const used = Number(cl.usedAmount);
      const data: Record<string, unknown> = { status: targetStatus, updatedAt: now };
      if (targetStatus === 'Frozen') {
        data.frozenAt = nowDate;
        data.frozenBy = meta.actorId;
        data.thawedReason = null; // 重新冻结时清空上次解冻理由，保持字段语义单一
      } else {
        data.thawedReason = meta.reason;
      }
      if (meta.markAutoScan) data.lastAutoScanDate = nowDate;
      await db.creditLimit.update({ where: { id: cl.id }, data });
      await appendCreditLimitHistory(db, {
        creditLimitId: cl.id,
        relationId: cl.relationId,
        beforeUsedAmount: used,
        afterUsedAmount: used, // 冻结/解冻不改变占用，delta=0 仅留状态迁移痕
        triggerType: meta.triggerType,
        triggerId: meta.triggerId ?? null,
        triggerBy: meta.actorId,
        remark: meta.reason,
      });
      await writeRouteAuditLog({
        prisma: db,
        actorId: meta.actorId,
        source: meta.auditSource,
        operation: meta.auditAction,
        targetType: 'CreditLimit',
        targetId: cl.id,
        before: { status: cl.status },
        after: { status: targetStatus, reason: meta.reason },
        operationType: 'transition',
        fieldPath: 'status',
        beforeValue: cl.status,
        afterValue: targetStatus,
        transactionId: meta.triggerId ?? null,
      });
      transitioned.push(cl.id);
    }
    return transitioned;
  }

  // ══════════════════════════════════════════════════════════════════
  // freezeCredit — 人工冻结（scope credit:freeze:write 由 route 守卫；理由必填）
  // ══════════════════════════════════════════════════════════════════
  async function freezeCredit(input: FreezeCreditInput): Promise<CreditResult<{ frozen: string[] }>> {
    const relationId = (input.relationId ?? '').trim();
    if (!relationId) return fail(CREDIT_ERRORS.RELATION_REQUIRED, 'relationId 必填', 400);
    const reason = (input.reason ?? '').trim();
    if (!reason) return fail(CREDIT_ERRORS.CREDIT_REASON_REQUIRED, '人工冻结必须填写冻结理由（审计强制）', 400);

    const activeLimits = await prisma.creditLimit.findMany({
      where: { relationId, status: 'Active', deletedAt: null },
    });
    if (activeLimits.length === 0) {
      const frozen = await prisma.creditLimit.findFirst({
        where: { relationId, status: 'Frozen', deletedAt: null },
      });
      if (frozen) {
        return fail(CREDIT_ERRORS.CREDIT_ALREADY_FROZEN, `客户 ${relationId} 信用额度已冻结（${frozen.id}），防重复冻结`, 409);
      }
      return fail(CREDIT_ERRORS.CREDIT_LIMIT_NOT_FOUND, `客户 ${relationId} 无 Active 信用额度，无法冻结`, 404);
    }

    try {
      const frozen = await prisma.$transaction(async (tx: any) =>
        transitionLimits(tx, activeLimits, 'Frozen', {
          actorId: input.actorId,
          reason,
          triggerType: 'credit_freeze',
          triggerId: input.triggerId ?? null,
          auditAction: 'credit_freeze',
          auditSource: 'service:credit:freeze',
        }),
      );
      logger.info('[Credit] 人工冻结完成', { relationId, frozen, actorId: input.actorId });
      return { ok: true, data: { frozen } };
    } catch (e: any) {
      logger.error('[Credit] 人工冻结事务失败', { relationId, error: e?.message });
      // ★ 收口点错位修复：路由 :132 把 `result.error.message` **原样**转发给客户端 ⇒ 原文拼在这里
      // 就等于直接上屏（且 B22/B30/B33/B36/B37 五条判据一条都认不到：B30 的 WRAP_RE 要求
      // `message|error|reason` 键名在前，位置参数不在判据内 —— 2026-09-20 实测该判据在本文件命中 0）。
      // 原文只进日志（上一行），对外只给中文 + 下一步。
      return fail(CREDIT_ERRORS.CREDIT_WRITE_FAILED, '客户信用额度冻结未能完成，本次改动未生效，请稍后重试；持续失败请联系管理员核对信用额度与冻结记录。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // thawCredit — 解冻路径①：主管手动解冻（scope credit:thaw:write 由 route 守卫；理由必填）
  // ══════════════════════════════════════════════════════════════════
  async function thawCredit(input: ThawCreditInput): Promise<CreditResult<{ thawed: string[] }>> {
    const relationId = (input.relationId ?? '').trim();
    if (!relationId) return fail(CREDIT_ERRORS.RELATION_REQUIRED, 'relationId 必填', 400);
    const reason = (input.reason ?? '').trim();
    if (!reason) return fail(CREDIT_ERRORS.CREDIT_REASON_REQUIRED, '手动解冻必须填写解冻理由（记录 thawedReason，审计强制）', 400);

    const frozenLimits = await prisma.creditLimit.findMany({
      where: { relationId, status: 'Frozen', deletedAt: null },
    });
    if (frozenLimits.length === 0) {
      return fail(CREDIT_ERRORS.CREDIT_NOT_FROZEN, `客户 ${relationId} 无 Frozen 信用额度，无需解冻`, 409);
    }

    try {
      const thawed = await prisma.$transaction(async (tx: any) =>
        transitionLimits(tx, frozenLimits, 'Active', {
          actorId: input.actorId,
          reason,
          triggerType: 'credit_thaw',
          triggerId: input.triggerId ?? null,
          auditAction: 'credit_thaw',
          auditSource: 'service:credit:thaw',
        }),
      );
      logger.info('[Credit] 手动解冻完成', { relationId, thawed, actorId: input.actorId });
      return { ok: true, data: { thawed } };
    } catch (e: any) {
      logger.error('[Credit] 手动解冻事务失败', { relationId, error: e?.message });
      // 同 freezeCredit：路由 :157 原样转发 result.error.message ⇒ 原文只进日志。
      return fail(CREDIT_ERRORS.CREDIT_WRITE_FAILED, '客户信用额度解冻未能完成，本次改动未生效，请稍后重试；持续失败请联系管理员核对信用额度与解冻记录。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 解冻路径②：逾期款全额核销后自动解冻
  //   autoThawIfSettled — 核销域（PaymentVoucher/Allocation）事件接口点，按客户触发
  //   runAutoThawScan   — 扫描器兜底（应收逾期检测任务内调用）
  //   两者共享同一内部实现；仅解冻「系统自动冻结」的额度（frozenBy=system_credit_scan）
  // ══════════════════════════════════════════════════════════════════
  async function thawAutoFrozenIfSettled(
    relationId: string,
    todayMs: number,
    triggerId?: string | null,
  ): Promise<{ thawed: boolean; thawedIds: string[]; stillOverdueDays: number }> {
    const days = await maxOverdueDays(prisma, relationId, todayMs);
    if (days > OVERDUE_FREEZE_THRESHOLD_DAYS) {
      return { thawed: false, thawedIds: [], stillOverdueDays: days };
    }
    const autoFrozen = await prisma.creditLimit.findMany({
      where: { relationId, status: 'Frozen', frozenBy: SYSTEM_CREDIT_ACTOR, deletedAt: null },
    });
    if (autoFrozen.length === 0) {
      return { thawed: false, thawedIds: [], stillOverdueDays: days };
    }
    const reason = `逾期≥${OVERDUE_FREEZE_THRESHOLD_DAYS}天应收已全额核销（当前最大逾期 ${days} 天），系统自动解冻`;
    const thawedIds = await prisma.$transaction(async (tx: any) =>
      transitionLimits(tx, autoFrozen, 'Active', {
        actorId: SYSTEM_CREDIT_ACTOR,
        reason,
        triggerType: 'credit_thaw',
        triggerId: triggerId ?? null,
        auditAction: 'credit_auto_thaw_settled',
        auditSource: 'service:credit:auto-thaw',
        markAutoScan: true,
      }),
    );
    logger.info('[Credit] 逾期款全额核销自动解冻', { relationId, thawedIds });
    return { thawed: true, thawedIds, stillOverdueDays: days };
  }

  /** 核销域接口点：收款核销完成后调用（如 Allocation 写入 hook） */
  async function autoThawIfSettled(params: {
    relationId: string;
    today?: Date;
    triggerId?: string;
  }): Promise<{ thawed: boolean; thawedIds: string[]; stillOverdueDays: number }> {
    const relationId = (params.relationId ?? '').trim();
    if (!relationId) return { thawed: false, thawedIds: [], stillOverdueDays: 0 };
    return thawAutoFrozenIfSettled(relationId, localMidnight(params.today ?? businessNowDate()), params.triggerId ?? null);
  }

  // ══════════════════════════════════════════════════════════════════
  // reserveCredit / releaseCredit — 额度占用/释放统一入口
  //   供 orderChanges（客户变更联动）/订单确认/取消等域接线；
  //   无 Active 额度 → adjusted=false 跳过（不报错，与既有联动语义一致）
  // ══════════════════════════════════════════════════════════════════
  async function reserveCredit(
    input: CreditShiftInput,
  ): Promise<CreditResult<{ adjusted: boolean; before: number; after: number; creditLimitId: string | null }>> {
    const relationId = (input.relationId ?? '').trim();
    if (!relationId) return fail(CREDIT_ERRORS.RELATION_REQUIRED, 'relationId 必填', 400);
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return fail(CREDIT_ERRORS.INVALID_AMOUNT, `占用金额必须为正数（收到 ${input.amount}）`, 400);
    }
    const run = (db: any) =>
      shiftUsedAmount(db, {
        relationId,
        delta: +input.amount,
        triggerType: input.triggerType,
        triggerId: input.triggerId,
        triggerBy: input.triggerBy,
        remark: input.remark,
      });
    try {
      const data = input.tx ? await run(input.tx) : await prisma.$transaction(async (tx: any) => run(tx));
      return { ok: true, data };
    } catch (e: any) {
      logger.error('[Credit] 额度占用失败', { relationId, amount: input.amount, error: e?.message });
      // 同 freezeCredit（同一形状的第三个站点）：原文只进日志。
      // ★ 但这里**不能**写成泛泛的"占用失败"：`shiftUsedAmount` 的 CAS 重试耗尽会抛
      //   `信用额度 usedAmount 并发冲突…`，那条信号是**可重试的瞬态**（≠系统故障），业务员据此决定
      //   "等一下再点"还是"找管理员"。`credit/__tests__/creditService.test.ts:335` 钉着这一点
      //   —— 我第一版把它一起换成泛化文案，当场红（这就是 B34 警告的「机械替换吞掉业务文案」）。
      //   现在保留「并发冲突」语义，同时去掉内部标识（usedAmount / CAS / 重试次数 / relationId）。
      return fail(CREDIT_ERRORS.CREDIT_WRITE_FAILED, '该客户的信用额度占用未成功（并发冲突或系统暂时故障），本次改动未生效；请稍后重试，持续失败请联系管理员核对该客户的在途订单与信用额度记录。', 500);
    }
  }

  async function releaseCredit(
    input: CreditShiftInput,
  ): Promise<CreditResult<{ adjusted: boolean; before: number; after: number; creditLimitId: string | null }>> {
    const relationId = (input.relationId ?? '').trim();
    if (!relationId) return fail(CREDIT_ERRORS.RELATION_REQUIRED, 'relationId 必填', 400);
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return fail(CREDIT_ERRORS.INVALID_AMOUNT, `释放金额必须为正数（收到 ${input.amount}）`, 400);
    }
    const run = (db: any) =>
      shiftUsedAmount(db, {
        relationId,
        delta: -input.amount,
        triggerType: input.triggerType,
        triggerId: input.triggerId,
        triggerBy: input.triggerBy,
        remark: input.remark,
      });
    try {
      const data = input.tx ? await run(input.tx) : await prisma.$transaction(async (tx: any) => run(tx));
      return { ok: true, data };
    } catch (e: any) {
      logger.error('[Credit] 额度释放失败', { relationId, amount: input.amount, error: e?.message });
      // 同 reserveCredit：CAS 冲突也是"可重试的瞬态"，语义必须留在文案里（原文只进日志）。
      return fail(CREDIT_ERRORS.CREDIT_WRITE_FAILED, '该客户的信用额度释放未成功（并发冲突或系统暂时故障），本次改动未生效；请稍后重试，持续失败请联系管理员核对该客户的订单变更记录。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // getCreditStatus — 客户信用状态（含门禁标记 creditFrozen）
  // ══════════════════════════════════════════════════════════════════
  async function getCreditStatus(relationId: string, today: Date = businessNowDate()) {
    const rid = (relationId ?? '').trim();
    if (!rid) return null;
    const cl = await prisma.creditLimit.findFirst({
      where: { relationId: rid, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const overdueDays = await maxOverdueDays(prisma, rid, localMidnight(today));
    if (!cl) {
      return {
        relationId: rid,
        hasCreditLimit: false,
        creditLimitId: null as string | null,
        status: null as string | null,
        creditFrozen: false,
        totalLimit: null as number | null,
        usedAmount: null as number | null,
        remaining: null as number | null,
        currency: null as string | null,
        frozenAt: null as Date | null,
        frozenBy: null as string | null,
        thawedReason: null as string | null,
        lastAutoScanDate: null as Date | null,
        maxOverdueDays: overdueDays,
      };
    }
    const total = Number(cl.totalLimit);
    const used = Number(cl.usedAmount);
    return {
      relationId: rid,
      hasCreditLimit: true,
      creditLimitId: cl.id,
      status: cl.status as string,
      creditFrozen: cl.status === 'Frozen' || cl.status === 'Revoked',
      totalLimit: total,
      usedAmount: used,
      remaining: total - used,
      currency: cl.currency,
      frozenAt: cl.frozenAt ?? null,
      frozenBy: cl.frozenBy ?? null,
      thawedReason: cl.thawedReason ?? null,
      lastAutoScanDate: cl.lastAutoScanDate ?? null,
      maxOverdueDays: overdueDays,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // checkCreditAvailable — 订单创建/变更额度校验门禁（信用控制规则 §6 #6）
  //   命中 Frozen/Revoked 或 Net61+ 未结清逾期 → blocked（fail-closed，
  //   调度遗漏时逾期门禁独立再查一次）
  // ══════════════════════════════════════════════════════════════════
  async function checkCreditAvailable(params: { relationId: string; amount?: number; today?: Date }) {
    const status = await getCreditStatus(params.relationId, params.today);
    if (!status) {
      return fail(CREDIT_ERRORS.RELATION_REQUIRED, 'relationId 必填', 400);
    }
    let blocked = false;
    let blockCode: string | null = null;
    let blockReason: string | null = null;
    if (status.status === 'Frozen') {
      blocked = true;
      blockCode = 'CREDIT_FROZEN_60_DAYS';
      blockReason = '该客户信用额度已冻结（存在 ≥60 天逾期或人工冻结），请财务解冻后再下单';
    } else if (status.status === 'Revoked') {
      blocked = true;
      blockCode = 'CREDIT_REVOKED';
      blockReason = '该客户信用额度已吊销（坏账），禁止新订单';
    } else if (status.maxOverdueDays > OVERDUE_FREEZE_THRESHOLD_DAYS) {
      // 调度遗漏兜底：额度仍 Active 但存在 Net61+ 未结清逾期 → 独立门禁
      blocked = true;
      blockCode = 'OVERDUE_60_DAYS';
      blockReason = `该客户存在 ≥60 天逾期未结清应收（最大逾期 ${status.maxOverdueDays} 天），请财务解冻后再下单`;
    }
    const amount = params.amount;
    const wouldExceedLimit =
      status.hasCreditLimit && Number.isFinite(amount) && (amount ?? 0) > 0
        ? (status.usedAmount ?? 0) + (amount as number) > (status.totalLimit ?? 0)
        : null;
    return {
      ok: true as const,
      data: {
        ...status,
        blocked,
        blockCode,
        blockReason,
        wouldExceedLimit,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // getCreditHistory — 历史时间线（冻结/解冻/额度占用释放全事件，append-only）
  // ══════════════════════════════════════════════════════════════════
  async function getCreditHistory(params: { relationId: string; limit?: number; offset?: number }): Promise<CreditResult<{ items: unknown[]; total: number }>> {
    const relationId = (params.relationId ?? '').trim();
    if (!relationId) return fail(CREDIT_ERRORS.RELATION_REQUIRED, 'relationId 必填', 400);
    const take = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const [items, total] = await Promise.all([
      prisma.creditLimitHistory.findMany({
        where: { relationId },
        orderBy: { createdAt: 'desc' },
        take,
        skip: Math.max(params.offset ?? 0, 0),
      }),
      prisma.creditLimitHistory.count({ where: { relationId } }),
    ]);
    return { ok: true as const, data: { items, total } };
  }

  // ══════════════════════════════════════════════════════════════════
  // runAutoFreezeScan — 规则① 60 天逾期自动冻结（调度接入点）
  //   幂等：仅 Active → Frozen；已 Frozen 不重复写历史；
  //   lastAutoScanDate 标记最近巡检时间（所有评估到的客户）
  // ══════════════════════════════════════════════════════════════════
  async function runAutoFreezeScan(params?: { today?: Date }): Promise<{
    evaluatedRelations: number;
    frozenCount: number;
    frozen: Array<{ relationId: string; creditLimitId: string; maxOverdueDays: number }>;
  }> {
    const todayMs = localMidnight(params?.today ?? businessNowDate());
    const nowDate = new Date();

    const invoices = await prisma.invoice.findMany({
      where: openReceivableWhere(), // ★ 含 amount>0 守卫：0 元/负额票不冻结客户
      select: { id: true, customerRelationId: true, dueDate: true, issueDate: true, amount: true },
    });

    const byRelation = new Map<string, number>();
    for (const inv of invoices) {
      if (!inv.customerRelationId) continue;
      if (!hasOpenAmount(inv.amount)) continue; // 兜底：mock / 内存行也要挡住
      const dueMs = effectiveDueMs(inv.dueDate, inv.issueDate);
      if (dueMs === null) continue;
      const days = Math.floor((todayMs - dueMs) / DAY_MS);
      if (days < 1) continue;
      const cur = byRelation.get(inv.customerRelationId) ?? 0;
      if (days > cur) byRelation.set(inv.customerRelationId, days);
    }

    const frozen: Array<{ relationId: string; creditLimitId: string; maxOverdueDays: number }> = [];
    for (const [relationId, maxDays] of byRelation) {
      if (maxDays <= OVERDUE_FREEZE_THRESHOLD_DAYS) continue;
      const activeLimits = await prisma.creditLimit.findMany({
        where: { relationId, status: 'Active', deletedAt: null },
      });
      for (const cl of activeLimits) {
        const reason = `60 天逾期规则自动冻结：应收发票最大逾期 ${maxDays} 天（阈值 >${OVERDUE_FREEZE_THRESHOLD_DAYS} 天）`;
        const ids = await prisma.$transaction(async (tx: any) =>
          transitionLimits(tx, [cl], 'Frozen', {
            actorId: SYSTEM_CREDIT_ACTOR,
            reason,
            triggerType: 'credit_freeze',
            triggerId: null,
            auditAction: 'credit:60d-overdue-freeze',
            auditSource: 'service:credit:auto-scan',
            markAutoScan: true,
          }),
        );
        frozen.push({ relationId, creditLimitId: ids[0], maxOverdueDays: maxDays });
      }
    }

    // lastAutoScanDate 巡检标记：所有评估到逾期发票的客户额度（含未命中阈值的 Active 与已 Frozen）
    if (byRelation.size > 0) {
      await prisma.creditLimit.updateMany({
        where: { relationId: { in: [...byRelation.keys()] }, deletedAt: null },
        data: { lastAutoScanDate: nowDate },
      });
    }

    if (frozen.length > 0) {
      logger.warn('[Credit] 60 天逾期自动冻结', { frozenCount: frozen.length, relations: frozen.map((f) => f.relationId) });
    }
    return { evaluatedRelations: byRelation.size, frozenCount: frozen.length, frozen };
  }

  // ══════════════════════════════════════════════════════════════════
  // runAutoThawScan — 扫描器兜底：系统自动冻结的客户，逾期款全额核销后自动解冻
  // ══════════════════════════════════════════════════════════════════
  async function runAutoThawScan(params?: { today?: Date }): Promise<{
    evaluatedFrozen: number;
    thawedCount: number;
    thawed: Array<{ relationId: string; creditLimitIds: string[] }>;
  }> {
    const todayMs = localMidnight(params?.today ?? businessNowDate());
    const autoFrozen = await prisma.creditLimit.findMany({
      where: { status: 'Frozen', frozenBy: SYSTEM_CREDIT_ACTOR, deletedAt: null },
      select: { id: true, relationId: true },
    });
    const relationIds = [...new Set(autoFrozen.map((cl: any) => cl.relationId as string))];
    const thawed: Array<{ relationId: string; creditLimitIds: string[] }> = [];
    for (const relationId of relationIds) {
      const result = await thawAutoFrozenIfSettled(relationId, todayMs, null);
      if (result.thawed) thawed.push({ relationId, creditLimitIds: result.thawedIds });
    }
    if (thawed.length > 0) {
      logger.info('[Credit] 自动解冻扫描完成', { thawedCount: thawed.length });
    }
    return { evaluatedFrozen: relationIds.length, thawedCount: thawed.length, thawed };
  }

  return {
    freezeCredit,
    thawCredit,
    autoThawIfSettled,
    reserveCredit,
    releaseCredit,
    checkCreditAvailable,
    getCreditStatus,
    getCreditHistory,
    runAutoFreezeScan,
    runAutoThawScan,
  };
}

export type CreditService = ReturnType<typeof createCreditService>;
