
/**
 * orderShipmentService.ts — P0-1 订单分批出运与尾款结算（财务侧主档）
 *
 * 设计真源：docs/design/10-评审与决策/2026-08-25-中度与严重缺失功能开发优先级规划.md P0-1
 * schema 真源：schema.prisma model OrderShipmentBatch（含设计决策注释）
 *
 * 职责边界（与 DR-016 ShipmentOrderAllocation 的分工）：
 *   - 物理侧（票视角：一票运了哪些单多少货）由 ShipmentOrderAllocation 承载，本服务只读它；
 *   - 本服务承载财务侧（订单视角）：批次计划登记 → 排船回填 → 结算进度聚合 → 尾款计算与门禁。
 *
 * 状态机（双正交）：
 *   status:       planned → shipped | cancelled（出运维度）
 *   settleStatus: unsettled → partially_settled → settled（财务维度，由 recalcSettlement 派生）
 *
 * 核心规则（fail-closed）：
 *   ① 同订单至多一批 isFinalBatch=true（末批锚点唯一）
 *   ② 已发运批次不可改计划/取消（只能整批冲销走 cancelled 语义，二期再议）
 *   ③ 末批发运门禁：isFinalBatch && status=shipped 前置校验收款进度
 *      （已收 ≥ 阈值比例 × 订单额，阈值默认 100% 减尾款，可按订单覆盖）
 *   ④ invoicedAmount/paidAmount 为聚合快照：从 InvoiceOrderAllocation(batchId)
 *      与 InvoiceAllocation(经 invoice → allocation) 联聚回写，每次结算动作后刷新。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { orderAmountOf as orderAmountTruth, orderAmountDecimalOrNull } from '../shared/orderAmount';
import { sumAppliedAmountByInvoice, sumCreditNoteAppliedByInvoice } from '../shared/invoiceAppliedSum';
import { todayLocalKey, localDateKey } from '../shared/localDate';


export type OrderShipmentBatchResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number; details?: unknown; gateDetails?: unknown } };

const fail = (code: string, message: string, status = 400): OrderShipmentBatchResult<never> =>
  ({ ok: false, error: { code, message, status } });

/** 末批发运收款门禁：默认已收金额须覆盖「订单额 − 末批计划额」（即尾款前的全部款项） */
const FINAL_GATE_COVER_RATIO_DEFAULT = 1;

function generateId(): string {
  return `OSB__${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** Decimal → number（列表/快照序列化） */
function d2n(v: Prisma.Decimal | null | undefined): number | null {
  return v == null ? null : Number(v);
}

/**
 * 从订单 `paymentTerms` 文本解析**尾款账期**天数（如 `"T/T 30% deposit, 70% against B/L 30 days"` → 30；解析失败返回 null）。
 *
 * ★ **D104（v3.93 自裁 · 收紧"读哪一段"）：只认尾款/余额那一段的天数，前置的生产期/在途期不许参与。**
 *   改前是 `terms.match(/(\d+)\s*days?/i)` —— 取**第一个** `N days`，于是复核实测到两个反例：
 *   · `Production lead time 75 days; balance net 30 days` 读成 **75** ⇒ 到期日晚 45 天、**静默漏催**
 *   · `Transit 30 days; balance 45 days after arrival` 读成 **30** ⇒ 到期日早 15 天、**可能对按时付款的客户发催款函**
 *   现优先级：① 含尾款标记的那一段（`balance`/`closing`/尾款/余款/净额/`against B/L`/`after arrival|shipment`/`net`）
 *              ② 全串**只有一个** `N days` 且没有任何分期标记（deposit/定金/预付款/advance/against B/L）⇒ 它就是本单账期
 *              ③ 其余 ⇒ `null`：**认不出哪一段是尾款时不许挑一个数当账期**，让调用方按"解析不出"留痕
 *   ⚠️ 仍未做（登记在 §12.05 D104）：客户档案 `paymentTermsDays` 兜底那一路要先查库，属**调用侧**改动，本批没做。
 */
const FINAL_PAYMENT_SEGMENT = /(balance|closing|尾款|余款|净额|against\s*b\/?l|after\s+(?:arrival|shipment)|net)/i;
const INSTALLMENT_SEGMENT = /(deposit|定金|预付款|advance|against\s*b\/?l|before\s+shipment)/i;
const creditDaysIn = (segment: string): number | null => {
  const m = segment.match(/(\d+)\s*days?/i);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  return Number.isFinite(d) && d >= 0 && d <= 365 ? d : null;
};

export function parseCreditDaysFromPaymentTerms(terms?: string | null): number | null {
  if (!terms) return null;
  const segments = String(terms).split(/[;；,，.。\n]+/).map((s) => s.trim()).filter(Boolean);
  const finalSegment = segments.find((s) => FINAL_PAYMENT_SEGMENT.test(s));
  if (finalSegment) return creditDaysIn(finalSegment);
  const withDays = segments.filter((s) => /(\d+)\s*days?/i.test(s));
  if (withDays.length === 1 && !segments.some((s) => INSTALLMENT_SEGMENT.test(s))) return creditDaysIn(withDays[0]);
  return null;
}

/** YYYY-MM-DD + N 天 → YYYY-MM-DD */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return localDateKey(d);
}

/**
 * 订单结算金额 —— **委托唯一真源** `shared/orderAmount.ts`。
 *
 * ★ 这里曾是本仓最早的一处「局部真源」（totalNet ?? quoteAmount）。2026-09-18 收编：
 *   口径本身与真源一致，但**留在本地就会再次漂移**（本仓最高产的一类 bug：收口点错位）。
 *   保留同名包装只为不动既有调用点，**实现一律走真源**。
 */
function orderAmountOf(order: { totalNet?: Prisma.Decimal | null; quoteAmount: Prisma.Decimal }): number {
  return orderAmountTruth(order);
}

/** 日期字符串 → 时间戳（ms；无效返回 null） */
function ymdToTs(ymd?: string | null): number | null {
  if (!ymd) return null;
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * 批次「结清分母」判据的**唯一真源**（零依赖纯函数，可单测）。
 *
 * ★ 为什么必须收成一处（2026-09-19 真库实锤）：
 *   `OrderShipmentBatch.amount` 是**计划额**（schema：「本批计划结算金额 = 订单额 × plannedRatio%」）。
 *   而**短装**（实际出运 < 计划）在纺织服装是常规情形（甲方另有 ±5% 溢短装条款）：此时
 *   已开票额本身就是实际出运额，**必然小于计划额** ⇒ 用计划额当分母，`paid >= amount`
 *   **永远不成立** ⇒ 该批次永远停在 partially_settled，并被 `dunningStageService` 的
 *   「到期未结清末批」**反复误催**（客户其实已按实际出运付清）。
 *   实测（真库 67 批）：`SIM-FORD-004 #1` 计划 158,080 / 已开票且已收齐 153,337.60 ——
 *   库内被写成 settled，旧判据重算却翻成 partially_settled（状态与金额自相矛盾）。
 *   同一份判据原本散落在 `recalcSettlement`（状态派生）与 `serialize`（进度/尾款余额）两处 ✗。
 *
 * 判据：**已开票 ⇒ 以「实际已开票额」为分母**（发票才是债权凭证；结清 = 该批已开的票收齐了）；
 *       未开票 ⇒ 仍用计划额（保留出运前的「计划回款进度」语义）。
 * ★ 取 `min(计划额, 已开票额)`：**只在短装时放宽**，溢装与其他场景与旧行为**逐字节一致** ——
 *   不会因合票（`allocatedAmount` 缺省按发票全额计入）使分母虚高而导致批次永不结清。
 */
export function settleBasisOf(plannedAmount: number | null, invoicedAmount: number | null): number | null {
  const planned = plannedAmount != null && Number.isFinite(plannedAmount) ? plannedAmount : null;
  const invoiced = invoicedAmount != null && Number.isFinite(invoicedAmount) ? invoicedAmount : null;
  if (invoiced != null && invoiced > 0) {
    return planned != null && planned > 0 ? Math.min(planned, invoiced) : invoiced;
  }
  return planned;
}

/** 序列化（Decimal → number + 派生字段） */
export function serializeOrderShipmentBatch(b: any, order?: any) {
  const amount = d2n(b.amount);
  const paid = d2n(b.paidAmount) ?? 0;
  const invoiced = d2n(b.invoicedAmount) ?? 0;
  return {
    ...b,
    amount,
    plannedRatio: d2n(b.plannedRatio),
    plannedQty: d2n(b.plannedQty),
    invoicedAmount: invoiced,
    paidAmount: paid,
    // 派生：结算分母（真源 settleBasisOf；短装时以实际开票额为准，见该函数注释）
    settleBasis: settleBasisOf(amount, invoiced),
    // 派生：结算进度（分母缺省 0 → null；进度只做展示不做门禁真源）
    settleProgress: (() => { const x = settleBasisOf(amount, invoiced); return x != null && x > 0 ? Math.min(1, paid / x) : null; })(),
    // 派生：尾款余额（结清分母 − 已收；负值钳 0）—— 与 settleStatus 同口径，避免「已结清却仍显示欠款」
    outstandingAmount: (() => { const x = settleBasisOf(amount, invoiced); return x != null ? Math.max(0, x - paid) : null; })(),
    // 派生：尾款逾期（末批且到期日已过且未结清）
    finalPaymentOverdue: b.isFinalBatch === true
      && b.finalPaymentDueDate != null
      && b.settleStatus !== 'settled'
      && ymdToTs(b.finalPaymentDueDate) != null
      && String(b.finalPaymentDueDate) < todayLocalKey(),
    orderPoNumber: order?.poNumber ?? null,
    orderCustomer: order?.customer ?? null,
  };
}


export function createOrderShipmentBatchService(prisma: PrismaClient) {
  const db = prisma as any;

  const serialize = serializeOrderShipmentBatch;

  /** 校验：同订单末批唯一 + 占比总和 ≤ 100%（登记/更新共用，excludeId 为更新时排除自身） */
  async function validateBatchPlan(params: {
    orderId: string;
    excludeId?: string;
    batchNo?: number;
    plannedRatio?: number | null;
    isFinalBatch?: boolean;
    autoAssignFinal?: boolean; // 登记时自动把最大批次设为末批（仅当订单内尚无末批）
  }): Promise<OrderShipmentBatchResult<{ isFinalBatch: boolean }>> {
    // Cancelled plans remain immutable history, but no longer reserve active ratio or the final-payment anchor.
    const where: any = { orderId: params.orderId, deletedAt: null, status: { not: 'cancelled' } };
    if (params.excludeId) where.id = { not: params.excludeId };
    const siblings: any[] = await db.orderShipmentBatch.findMany({ where, orderBy: { batchNo: 'asc' } });

    // 占比总和校验（含本次输入）
    const ratios = siblings
      .filter((s: any) => s.plannedRatio != null)
      .map((s: any) => Number(s.plannedRatio));
    if (params.plannedRatio != null) ratios.push(Number(params.plannedRatio));
    if (ratios.length > 0) {
      const sum = ratios.reduce((a: number, b: number) => a + b, 0);
      if (sum > 100 + 1e-9) {
        return fail('RATIO_EXCEEDED', `批次计划占比合计 ${sum.toFixed(2)}% 超过 100%`, 400);
      }
    }

    // 末批唯一性：既有（排除自身）已存在末批时，本次不可再标记末批
    const existingFinal = siblings.find(s => s.isFinalBatch === true);
    let isFinalBatch = params.isFinalBatch === true;
    if (isFinalBatch && existingFinal && existingFinal.id !== params.excludeId) {
      return fail('FINAL_BATCH_DUPLICATE', `订单已存在末批（batchNo ${existingFinal.batchNo}）；同订单至多一批可标记为末批`, 409);
    }
    // 自动末批：登记时无末批且未显式标记 → 本批（首个批次）默认为末批（单批整单出运场景）
    if (params.autoAssignFinal && !existingFinal && params.isFinalBatch === undefined) {
      isFinalBatch = true;
    }
    return { ok: true, data: { isFinalBatch } };
  }

  /** 金额推导：amount 缺省时 = 订单额 × plannedRatio%（两者皆缺 → null 由调用方决定是否放行） */
  function deriveAmount(order: any, plannedRatio?: number | null, amount?: number | string | null): Prisma.Decimal | null {
    if (amount != null && Number.isFinite(Number(amount))) return new Prisma.Decimal(String(amount));
    if (plannedRatio != null && Number.isFinite(Number(plannedRatio))) {
      const basis = orderAmountDecimalOrNull(order, Prisma.Decimal);
      return basis === null ? null : basis.mul(String(plannedRatio)).div(100).toDecimalPlaces(4);
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  // 批次登记
  // ════════════════════════════════════════════════════════════════
  async function createBatch(input: {
    orderId: string;
    shipmentId?: string | null;
    plannedRatio?: number | null;
    plannedQty?: number | string | null;
    unit?: string | null;
    amount?: number | string | null;
    currency?: string | null;
    isFinalBatch?: boolean;
    finalPaymentDueDays?: number | null;
    notes?: string | null;
  }, actorId?: string): Promise<OrderShipmentBatchResult<any>> {
    try {
      const order = await db.order.findFirst({ where: { id: input.orderId, deletedAt: null } });
      if (!order) return fail('ORDER_NOT_FOUND', `订单 ${input.orderId} 不存在`, 404);

      // 排船回填时 shipment 必须真实存在且未取消
      let shipmentSnapshot: any = null;
      if (input.shipmentId) {
        shipmentSnapshot = await db.shipment.findFirst({ where: { id: input.shipmentId, deletedAt: null } });
        if (!shipmentSnapshot) return fail('SHIPMENT_NOT_FOUND', `出运单 ${input.shipmentId} 不存在`, 404);
        if (shipmentSnapshot.status === 'Cancelled') return fail('SHIPMENT_CANCELLED', `出运单 ${input.shipmentId} 已取消，不可作为批次运单`, 409);
      }

      // batchNo 自动递增（订单内现有最大 + 1）
      const maxNo = await db.orderShipmentBatch.findFirst({
        where: { orderId: input.orderId, deletedAt: null },
        orderBy: { batchNo: 'desc' },
        select: { batchNo: true },
      });
      const batchNo = (maxNo?.batchNo ?? 0) + 1;

      // 计划校验（占比/末批唯一/自动末批）
      const ratio = input.plannedRatio != null && Number.isFinite(Number(input.plannedRatio))
        ? Math.max(0, Math.min(100, Number(input.plannedRatio))) : null;
      const planCheck = await validateBatchPlan({
        orderId: input.orderId,
        plannedRatio: ratio,
        isFinalBatch: input.isFinalBatch,
        autoAssignFinal: true,
      });
      if (!planCheck.ok) return planCheck;

      // 金额推导 + 币种
      const amount = deriveAmount(order, ratio, input.amount);
      if (amount == null && planCheck.data.isFinalBatch === false && ratio == null && input.plannedQty == null) {
        return fail('VALIDATION_FAILED', 'plannedRatio / plannedQty / amount 至少填一项（否则批次无法量化）');
      }
      const currency = (input.currency || order.salesCurrency || order.purchaseCurrency || 'USD') as string;

      const now = BigInt(Date.now());
      const batch = await db.$transaction(async (tx: any) => {
        const created = await tx.orderShipmentBatch.create({
          data: {
            id: generateId(),
            orderId: input.orderId,
            shipmentId: input.shipmentId ?? null,
            batchNo,
            plannedRatio: ratio != null ? new Prisma.Decimal(ratio.toFixed(2)) : null,
            plannedQty: input.plannedQty != null && Number.isFinite(Number(input.plannedQty))
              ? new Prisma.Decimal(String(input.plannedQty)) : null,
            unit: input.unit ?? null,
            amount: amount != null ? new Prisma.Decimal(amount) : null,
            currency,
            customerRelationId: order.customerRelationId ?? null,
            customerName: order.customer ?? null,
            status: 'planned',
            settleStatus: 'unsettled',
            isFinalBatch: planCheck.data.isFinalBatch,
            finalPaymentDueDays: input.finalPaymentDueDays ?? null,
            finalPaymentDueDate: null,
            notes: input.notes ?? null,
            createdAt: now,
            updatedAt: now,
          },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:order-shipment-batch:create',
          operation: 'create_order_shipment_batch',
          targetType: 'OrderShipmentBatch',
          targetId: created.id,
          after: { id: created.id, orderId: input.orderId, batchNo, isFinalBatch: created.isFinalBatch, amount },
          ip: null,
        });
        return created;
      });
      return { ok: true, data: serialize(batch, order) };
    } catch (e: any) {
      // B39（D51）：本文件原先一处 `logger.error` 都没有（只有 info/warn）⇒ 先补日志，再换文案。
      // D52 覆盖面：try 内**唯一写**就是上面那个 $transaction（:244），之后只有 `return`；
      // 事务前的读与 `validateBatchPlan`（:144，纯读）都不落库 ⇒ 可以承诺"本次未确认任何改动"。
      logger.error('[OrderShipmentBatch] 批次登记失败', { orderId: input.orderId, error: e?.message });
      return fail('CREATE_FAILED', '批次登记未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该订单的批次号与计划数量。', 500);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 批次更新（计划期：未发运才可改计划/取消）
  // ════════════════════════════════════════════════════════════════
  async function updateBatch(batchId: string, input: {
    shipmentId?: string | null;
    plannedRatio?: number | null;
    plannedQty?: number | string | null;
    unit?: string | null;
    amount?: number | string | null;
    isFinalBatch?: boolean;
    finalPaymentDueDays?: number | null;
    notes?: string | null;
    status?: string; // planned → cancelled（软取消）
  }, actorId?: string): Promise<OrderShipmentBatchResult<any>> {
    try {
      const batch = await db.orderShipmentBatch.findFirst({ where: { id: batchId, deletedAt: null } });
      if (!batch) return fail('BATCH_NOT_FOUND', `批次 ${batchId} 不存在`, 404);

      const order = await db.order.findFirst({ where: { id: batch.orderId, deletedAt: null } });

      // 状态迁移校验
      if (input.status === 'cancelled') {
        if (batch.status === 'shipped') return fail('ALREADY_SHIPPED', '已发运批次不可取消', 409);
        if (batch.status === 'cancelled') return fail('ALREADY_CANCELLED', '批次已是取消状态', 409);
      } else if (input.status && input.status !== batch.status) {
        return fail('INVALID_TRANSITION', `status 仅允许 planned → cancelled（发运/结清由专用动作触发，当前 ${batch.status}）`, 400);
      }

      // 计划字段仅计划期可改（cancelled 后也不可改——留痕冻结）
      const planFrozen = batch.status !== 'planned';
      if (planFrozen && (input.plannedRatio !== undefined || input.plannedQty !== undefined
        || input.amount !== undefined || input.isFinalBatch !== undefined)) {
        return fail('PLAN_FROZEN', `批次已${batch.status === 'shipped' ? '发运' : '取消'}，计划字段冻结不可修改`, 409);
      }

      // 排船回填校验
      let shipmentSnapshot: any = null;
      if (input.shipmentId) {
        shipmentSnapshot = await db.shipment.findFirst({ where: { id: input.shipmentId, deletedAt: null } });
        if (!shipmentSnapshot) return fail('SHIPMENT_NOT_FOUND', `出运单 ${input.shipmentId} 不存在`, 404);
        if (shipmentSnapshot.status === 'Cancelled') return fail('SHIPMENT_CANCELLED', `出运单 ${input.shipmentId} 已取消，不可作为批次运单`, 409);
      }

      // 计划校验（占比/末批唯一）
      const ratio = input.plannedRatio !== undefined
        ? (input.plannedRatio != null && Number.isFinite(Number(input.plannedRatio))
          ? Math.max(0, Math.min(100, Number(input.plannedRatio))) : null)
        : (batch.plannedRatio != null ? Number(batch.plannedRatio) : null);
      // Cancellation exits the effective plan. Historical notes must not re-reserve
      // the frozen cancelled ratio or final marker when active successors exist.
      if (batch.status !== 'cancelled' && input.status !== 'cancelled') {
        const planCheck = await validateBatchPlan({
          orderId: batch.orderId,
          excludeId: batch.id,
          plannedRatio: ratio,
          isFinalBatch: input.isFinalBatch !== undefined ? input.isFinalBatch === true : batch.isFinalBatch === true,
        });
        if (!planCheck.ok) return planCheck;
      }

      // 金额：显式传入优先，否则保持原值，再否则按新 ratio 重推
      let amount: Prisma.Decimal | null = batch.amount != null ? new Prisma.Decimal(String(batch.amount)) : null;
      if (input.amount !== undefined) {
        amount = input.amount != null && Number.isFinite(Number(input.amount)) ? new Prisma.Decimal(String(input.amount)) : null;
      } else if (order && input.plannedRatio !== undefined && input.amount === undefined) {
        amount = deriveAmount(order, ratio, input.amount ?? null) ?? amount;
      }

      const now = BigInt(Date.now());
      const updated = await db.$transaction(async (tx: any) => {
        const row = await tx.orderShipmentBatch.update({
          where: { id: batchId },
          data: {
            ...(input.shipmentId !== undefined ? { shipmentId: input.shipmentId ?? null } : {}),
            ...(input.plannedRatio !== undefined ? { plannedRatio: ratio != null ? new Prisma.Decimal(ratio.toFixed(2)) : null } : {}),
            ...(input.plannedQty !== undefined ? { plannedQty: input.plannedQty != null && Number.isFinite(Number(input.plannedQty)) ? new Prisma.Decimal(String(input.plannedQty)) : null } : {}),
            ...(input.unit !== undefined ? { unit: input.unit ?? null } : {}),
            ...(amount !== undefined ? { amount: amount != null ? new Prisma.Decimal(amount) : null } : {}),
            ...(input.isFinalBatch !== undefined ? { isFinalBatch: input.isFinalBatch === true } : {}),
            ...(input.finalPaymentDueDays !== undefined ? { finalPaymentDueDays: input.finalPaymentDueDays ?? null } : {}),
            ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
            ...(input.status ? { status: input.status } : {}),
            updatedAt: now,
          },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:order-shipment-batch:update',
          operation: 'update_order_shipment_batch',
          targetType: 'OrderShipmentBatch',
          targetId: batchId,
          before: { id: batchId, status: batch.status, amount: d2n(batch.amount), isFinalBatch: batch.isFinalBatch },
          after: { id: batchId, status: row.status, amount, isFinalBatch: row.isFinalBatch },
          ip: null,
        });
        return row;
      });
      return { ok: true, data: serialize(updated, order) };
    } catch (e: any) {
      // D52 覆盖面：try 内唯一写 = $transaction（:352），之后只有 return ⇒ 可以承诺"本次未确认任何改动"。
      logger.error('[OrderShipmentBatch] 批次更新失败', { batchId, error: e?.message });
      return fail('UPDATE_FAILED', '批次更新未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该批次的计划数量与结算状态。', 500);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 结算进度聚合（invoiced/paid 快照回写 + settleStatus 派生）
  // ════════════════════════════════════════════════════════════════
  /**
   * 批次已开票金额：InvoiceOrderAllocation.batchId = 批次 且 allocation 未软删 且发票未作废。
   * 同发票同订单的分配行唯一（@@unique），allocatedAmount 缺省视为整单金额（取 invoice.amount）。
   */
  async function recalcSettlement(batchId: string, tx?: any): Promise<OrderShipmentBatchResult<any>> {
    const runner = tx ?? db;
    const batch = await runner.orderShipmentBatch.findFirst({ where: { id: batchId, deletedAt: null } });
    if (!batch) return fail('BATCH_NOT_FOUND', `批次 ${batchId} 不存在`, 404);

    // 已开票：发票分配（batchId 归属）
    const allocations = await runner.invoiceOrderAllocation.findMany({
      where: { batchId, deletedAt: null },
    });
    const invoiceIds = [...new Set(allocations.map((a: any) => a.invoiceId))];
    const invoices = invoiceIds.length > 0
      ? await runner.invoice.findMany({ where: { id: { in: invoiceIds }, deletedAt: null } })
      : [];
    const invoiceMap = new Map<string, any>(invoices.map((inv: any) => [inv.id, inv]));
    let invoiced = 0;
    for (const a of allocations as any[]) {
      const inv = invoiceMap.get(a.invoiceId) as any;
      if (!inv || inv.status === 'Cancelled') continue;
      invoiced += a.allocatedAmount != null ? Number(a.allocatedAmount) : Number(inv.amount);
    }

    // 已收款：上述发票经 InvoiceAllocation 核销（allocation 已核销金额 = 核销时点发票已收全额，取 settledAmount 口径）
    // 注意：InvoiceAllocation 为硬删除模型（@@unique + delete+insert 语义，schema/migrations 均无 deletedAt 列），
    // 过滤 deletedAt 会触发 PrismaClientValidationError —— 此处不做软删过滤。
    let paid = 0;
    if (invoiceIds.length > 0) {
      const invoiceAllocs = await runner.invoiceAllocation.findMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      // InvoiceAllocation 行 = 凭证×发票核销记录；已核销金额按行汇总即该发票累计已收
      // 注意：核销金额字段为 appliedAmount（InvoiceAllocation 模型唯一金额字段，schema 真源）
      for (const ia of invoiceAllocs as any[]) {
        const inv = invoiceMap.get(ia.invoiceId) as any;
        if (!inv || inv.status === 'Cancelled') continue;
        paid += ia.appliedAmount != null ? Number(ia.appliedAmount) : 0;
      }
      // ★ 贷项票抵扣（客户索赔/折让）也必须计入「已收」——否则客户拿了折让把票抵平，
      //   批次却永远停在 partially_settled（与状态判定真源 sumAppliedAmount 同源）。
      //   沿用同一个「排除作废发票」过滤，保持本函数既有语义不变。
      const cnByInvoice = await sumCreditNoteAppliedByInvoice(runner, invoiceIds as string[]);
      for (const [invId, amt] of cnByInvoice) {
        const inv = invoiceMap.get(invId) as any;
        if (!inv || inv.status === 'Cancelled') continue;
        paid += amt;
      }
    }

    // settleStatus 派生（分母缺省 → 无法判定时维持原状态）
    //
    // 结清分母 basis（2026-09-19 修）：
    //   `batch.amount` 是**计划额**（schema：本批计划结算金额 = 订单额 × plannedRatio%）。
    //   原判据 `paid >= amount` 在**短装**（实际出运 < 计划，纺织服装的常规情形，甲方另有
    //   ±5% 溢短装条款）下**永远不成立** —— 已开票额本身就是实际出运额，必然小于计划额，
    //   于是批次永远停在 partially_settled，并被 watchdog 的「到期未结清末批」反复误催。
    //   实测（真库 67 批）：SIM-FORD-004 #1 计划 158080 / 已开票且已收齐 153337.60，
    //   库内被写成 settled，而旧判据重算会翻成 partially_settled = 状态与金额自相矛盾。
    //
    //   ⇒ 已开票时以「实际已开票额」为分母（发票才是债权凭证，结清 = 该批已开的票收齐了）；
    //     未开票时仍用计划额（保留出运前的「计划回款进度」语义）。
    //   ★ 取 `min(计划额, 已开票额)`：**只在短装时放宽**，溢装/其他场景与旧行为逐字节一致，
    //     不会因合票（allocatedAmount 缺省按发票全额）导致分母虚高而使批次永不结清。
    const amount = batch.amount != null ? Number(batch.amount) : null;
    // 真源见 settleBasisOf（已开票 ⇒ min(计划额, 已开票额)；未开票 ⇒ 计划额）
    const basis = settleBasisOf(amount, invoiced);
    let settleStatus = batch.settleStatus as string;
    let settledAt = batch.settledAt;
    if (basis != null && basis > 0) {
      const eps = 1e-6;
      if (paid >= basis - eps) {
        settleStatus = 'settled';
        settledAt = settledAt ?? BigInt(Date.now());
      } else if (paid > eps) {
        settleStatus = 'partially_settled';
        settledAt = null;
      } else {
        settleStatus = 'unsettled';
        settledAt = null;
      }
    }

    const now = BigInt(Date.now());
    const updated = await runner.orderShipmentBatch.update({
      where: { id: batchId },
      data: {
        invoicedAmount: new Prisma.Decimal(invoiced.toFixed(4)),
        paidAmount: new Prisma.Decimal(paid.toFixed(4)),
        settleStatus,
        settledAt,
        updatedAt: now,
      },
    });
    const order = batch.orderId ? await runner.order.findFirst({ where: { id: batch.orderId, deletedAt: null } }) : null;
    return { ok: true, data: serialize(updated, order) };
  }

  /** 触发点：某订单的全部批次重算（发票分配/核销变动后调用） */
  async function recalcOrderSettlement(orderId: string, tx?: any): Promise<OrderShipmentBatchResult<any[]>> {
    const runner = tx ?? db;
    const batches = await runner.orderShipmentBatch.findMany({ where: { orderId, deletedAt: null } });
    const results = [];
    for (const b of batches) {
      const r = await recalcSettlement(b.id, runner);
      if (r.ok) results.push(r.data);
    }
    return { ok: true, data: results };
  }

  // ════════════════════════════════════════════════════════════════
  // 批次发运确认（排船回填 + 尾款到期日计算 + 末批收款门禁）
  // ════════════════════════════════════════════════════════════════
  async function markShipped(batchId: string, input?: {
    shipmentId?: string; // 可在发运确认时才排船
    shippedAt?: number; // 缺省取运单 atd/当日
    gateCoverRatio?: number; // 末批门禁覆盖率覆盖（1 = 全覆盖尾款前款项；<1 放宽）
    skipGate?: boolean; // 管理员豁免（留痕）
    autoLinkage?: boolean; // Shipment→Shipped 自动联动标记（留痕，区别于人工操作/管理员豁免）
  }, actorId?: string): Promise<OrderShipmentBatchResult<any>> {
    try {
      const batch = await db.orderShipmentBatch.findFirst({ where: { id: batchId, deletedAt: null } });
      if (!batch) return fail('BATCH_NOT_FOUND', `批次 ${batchId} 不存在`, 404);
      if (batch.status === 'shipped') return fail('ALREADY_SHIPPED', '批次已发运', 409);
      if (batch.status === 'cancelled') return fail('ALREADY_CANCELLED', '批次已取消，不可发运', 409);

      const order = await db.order.findFirst({ where: { id: batch.orderId, deletedAt: null } });
      if (!order) return fail('ORDER_NOT_FOUND', `订单 ${batch.orderId} 不存在`, 404);

      // 运单：传入优先，其次已回填
      const shipId = input?.shipmentId ?? batch.shipmentId;
      if (!shipId) return fail('SHIPMENT_REQUIRED', '批次尚未关联出运单（shipmentId），不能确认发运');
      const shipment = await db.shipment.findFirst({ where: { id: shipId, deletedAt: null } });
      if (!shipment) return fail('SHIPMENT_NOT_FOUND', `出运单 ${shipId} 不存在`, 404);
      if (shipment.status === 'Cancelled') return fail('SHIPMENT_CANCELLED', `出运单 ${shipId} 已取消`, 409);

      // 先刷新结算快照（门禁用最新已收金额）
      await recalcSettlement(batchId);

      // ── 末批发运收款门禁（fail-closed；skipGate 豁免留痕） ──
      if (batch.isFinalBatch === true && !input?.skipGate) {
        const orderAmt = orderAmountOf(order);
        const batchAmt = batch.amount != null ? Number(batch.amount) : 0;
        // 门禁线 = 覆盖率 × （订单额 − 末批额）：即末批之前款项须已收足
        const coverRatio = input?.gateCoverRatio != null ? Number(input.gateCoverRatio) : FINAL_GATE_COVER_RATIO_DEFAULT;
        const required = Math.max(0, orderAmt - batchAmt) * coverRatio;
        // 单币种口径（业务定案 2026-09-13）：订单收款恒为销售币种；发票币种不一致 → 报错拦截，
        // 绝不跨币种直加（与 P0-2/P0-3「报错优于算错」同取向）。
        const paidRes = await totalPaidOfOrder(batch.orderId, batch.currency ?? null);
        if (!paidRes.ok) {
          return fail('FINAL_PAYMENT_GATE_CURRENCY_MISMATCH',
            `末批发运门禁：该订单收款发票币种不一致（${paidRes.currencies.join(' / ') || '未标注'}），无法与门禁币种 ${batch.currency ?? '未标注'} 直接比较；请核对发票币种，或经管理员豁免（skipGate 留痕）`,
            409);
        }
        const paidAll = paidRes.total;
        if (paidAll + 1e-6 < required) {
          return fail('FINAL_PAYMENT_GATE_BLOCKED',
            `末批发运门禁：订单累计已收 ${paidAll.toFixed(2)} ${batch.currency}，须 ≥ ${required.toFixed(2)} ${batch.currency}（订单额 ${orderAmt.toFixed(2)} − 末批 ${batchAmt.toFixed(2)}）× 覆盖率 ${coverRatio}；可收款后重试或管理员豁免（skipGate 留痕）`,
            409);
        }
      }

      // 尾款到期日：末批 → 发运日 + 账期（本批覆盖值 > 订单 paymentTerms 解析）
      const shippedAt = input?.shippedAt != null ? BigInt(input.shippedAt)
        : (shipment.atd ? BigInt(ymdToTs(shipment.atd) ?? Date.now()) : BigInt(Date.now()));
      let finalPaymentDueDate: string | null = batch.finalPaymentDueDate;
      if (batch.isFinalBatch === true) {
        const creditDays = batch.finalPaymentDueDays != null
          ? Number(batch.finalPaymentDueDays)
          : parseCreditDaysFromPaymentTerms(order.paymentTerms);
        if (creditDays != null) {
          finalPaymentDueDate = addDays(localDateKey(new Date(Number(shippedAt))), creditDays);
        } else {
          // 账期解析不出 → finalPaymentDueDate 保持 null，而 listOverdueFinalBatches 按
          // { lt: today } 过滤，该末批将永远不进逾期看板 = 尾款漏催。静默留空会让这件
          // 事无人知晓（且 updateBatch 无法补写），必须留痕以便人工跟进。
          logger.warn('[shipment-batch] 末批未能解析出尾款账期，finalPaymentDueDate 将为空（该批不会进逾期看板）', {
            batchId: (batch as any).id ?? null,
            orderId: batch.orderId,
            paymentTerms: (order as any).paymentTerms ?? null,
            finalPaymentDueDays: batch.finalPaymentDueDays ?? null,
          });
        }
      }

      const now = BigInt(Date.now());
      const updated = await db.$transaction(async (tx: any) => {
        const row = await tx.orderShipmentBatch.update({
          where: { id: batchId },
          data: {
            shipmentId: shipId,
            status: 'shipped',
            shippedAt,
            finalPaymentDueDate,
            updatedAt: now,
          },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:order-shipment-batch:mark-shipped',
          operation: 'mark_batch_shipped',
          targetType: 'OrderShipmentBatch',
          targetId: batchId,
          before: { id: batchId, status: batch.status },
          after: { id: batchId, status: 'shipped', shipmentId: shipId, finalPaymentDueDate, skipGate: input?.skipGate === true, autoLinkage: input?.autoLinkage === true },
          ip: null,
        });
        return row;
      });
      return { ok: true, data: serialize(updated, order) };
    } catch (e: any) {
      // ★ D52：本处**不许承诺写入状态** —— try 在 $transaction（:577）**之前**还有
      //   `await recalcSettlement(batchId)`（:528，无 tx ⇒ 直写库，刷新结算快照）。
      //   失败时结算快照可能已被刷新 ⇒ 说"未确认任何改动"会是假话。
      logger.error('[OrderShipmentBatch] 批次发运确认失败', { batchId, error: e?.message });
      return fail('SHIP_FAILED', '批次发运确认未能完成，请稍后重试；持续失败请联系管理员核对该批次的发运状态与结算快照。', 500);
    }
  }

  /**
   * 订单累计已收（**单币种口径**，业务定案 2026-09-13）。
   *
   * 订单收款恒为订单销售币种；若该订单的收款发票出现多种币种，或唯一币种与门禁币种
   * （`expectedCurrency`，即末批 `currency`）不一致，一律 `{ok:false}` 由调用方 fail-closed
   * 报错拦截——**绝不跨币种直接相加**（报错优于算错，与 P0-2/P0-3 同取向）。
   * 不做任何隐式汇率折算：`Order` 无锁汇率字段，`Invoice.exchangeRate` 是各票 → 本位币，
   * 折算链口径未定案前不擅自引入。
   */
  async function totalPaidOfOrder(
    orderId: string,
    expectedCurrency: string | null,
  ): Promise<{ ok: true; total: number } | { ok: false; currencies: string[] }> {
    const allocations = await db.invoiceOrderAllocation.findMany({
      where: { orderId, deletedAt: null },
      select: { invoiceId: true },
    });
    const invoiceIds = [...new Set(allocations.map((a: any) => a.invoiceId))];
    if (invoiceIds.length === 0) return { ok: true, total: 0 };

    // 币种一致性：先取发票币种，混合/与门禁币种不符一律拦截
    const invoices = await db.invoice.findMany({
      where: { id: { in: invoiceIds } },
      select: { id: true, currency: true },
    });
    const norm = (c: unknown) => (c == null ? '' : String(c).trim().toUpperCase());
    const currencies = [
      ...new Set(invoices.map((i: any) => norm(i.currency)).filter((c: string) => c.length > 0)),
    ] as string[];
    const expected = norm(expectedCurrency);
    if (currencies.length > 1) return { ok: false, currencies };
    if (expected && currencies.length === 1 && currencies[0] !== expected) {
      return { ok: false, currencies };
    }

    // 已核销真源（收款核销 + 贷项票抵扣）—— 见 allocationService.sumAppliedAmountByInvoice
    //（InvoiceAllocation 为硬删除模型，无 deletedAt 列，不做软删过滤 —— 与 recalcSettlement 同）
    const byInvoice = await sumAppliedAmountByInvoice(db, invoiceIds as string[]);
    let total = 0;
    for (const v of byInvoice.values()) total += v;
    return { ok: true, total };
  }

  // ════════════════════════════════════════════════════════════════
  // 尾款看板（watchdog 扫描源 + 前端列表）
  // ════════════════════════════════════════════════════════════════
  /** 到期未结清末批列表（dueDate < today 且 settleStatus ≠ settled） */
  async function listOverdueFinalBatches(limit = 100): Promise<OrderShipmentBatchResult<any[]>> {
    const today = todayLocalKey();
    const rows = await db.orderShipmentBatch.findMany({
      where: {
        deletedAt: null,
        isFinalBatch: true,
        status: 'shipped',
        settleStatus: { not: 'settled' },
        finalPaymentDueDate: { lt: today },
      },
      orderBy: { finalPaymentDueDate: 'asc' },
      take: Math.min(Math.max(1, limit), 500),
    });
    // 附订单摘要
    const orderIds = [...new Set(rows.map((r: any) => r.orderId))];
    const orders = orderIds.length > 0 ? await db.order.findMany({ where: { id: { in: orderIds } } }) : [];
    const orderMap = new Map(orders.map((o: any) => [o.id, o]));
    return { ok: true, data: rows.map((r: any) => serialize(r, orderMap.get(r.orderId))) };
  }

  /** 订单批次全景（含计划汇总 + 出运/结算进度） */
  async function listByOrder(orderId: string): Promise<OrderShipmentBatchResult<any>> {
    const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
    if (!order) return fail('ORDER_NOT_FOUND', `订单 ${orderId} 不存在`, 404);
    const batches = await db.orderShipmentBatch.findMany({
      where: { orderId, deletedAt: null },
      orderBy: { batchNo: 'asc' },
    });
    const shippedQty = batches.filter((b: any) => b.status === 'shipped').length;
    const serialized = batches.map((b: any) => serialize(b, order));
    return {
      ok: true,
      data: {
        order: { id: order.id, poNumber: order.poNumber, customer: order.customer, currency: order.salesCurrency ?? order.purchaseCurrency },
        orderAmount: orderAmountOf(order),
        batches: serialized,
        summary: {
          totalBatches: batches.length,
          shippedBatches: shippedQty,
          allShipped: batches.length > 0 && shippedQty === batches.length,
          totalPlannedAmount: serialized.reduce((s: number, b: any) => s + (b.amount ?? 0), 0),
          totalInvoiced: serialized.reduce((s: number, b: any) => s + (b.invoicedAmount ?? 0), 0),
          totalPaid: serialized.reduce((s: number, b: any) => s + (b.paidAmount ?? 0), 0),
        },
      },
    };
  }

  // ════════════════════════════════════════════════════════════════
  // W-B 断层④拍板：Shipment→Shipped 自动推进挂接批次（双状态机挂钩）
  //   物理事实优先：运单既已发运，显式挂接（shipmentId=该运单）的 planned 批次
  //   必须同步 shipped——否则催款分级/对账读批次状态永远滞后（货发了款没催）。
  //   - 幂等：仅扫 status='planned'；shipped/cancelled 天然跳过（终态不复活）
  //   - 尾款门禁语义：末批收款门禁的保护点在「发运前」（人工 mark-shipped / 出运放行门禁）；
  //     物理发运既成事实后不再阻断状态同步，缺口以 skipGate+autoLinkage 留痕，
  //     由催款 watchdog（listOverdueFinalBatches）兜底追款
  //   - best-effort：单批失败记录并继续，整体永不 throw（不阻断运单主业务）
  //   - 归属判定：只推进显式挂接批次；未排船批次（shipmentId=null）保持 planned，
  //     走人工 mark-shipped（一票多批次的归属歧义不猜）
  // ════════════════════════════════════════════════════════════════
  async function autoAdvanceOnShipmentShipped(
    shipmentId: string,
    actorId?: string,
  ): Promise<{ advanced: string[]; failed: Array<{ batchId: string; code: string }> }> {
    const advanced: string[] = [];
    const failed: Array<{ batchId: string; code: string }> = [];
    try {
      const candidates = await db.orderShipmentBatch.findMany({
        where: { shipmentId, status: 'planned', deletedAt: null },
        select: { id: true },
      });
      for (const b of candidates) {
        const r = await markShipped(b.id, { shipmentId, skipGate: true, autoLinkage: true }, actorId ?? 'system');
        if (r.ok) advanced.push(b.id);
        else {
          failed.push({ batchId: b.id, code: r.error.code });
          logger.warn('[OrderShipmentBatch] Shipment→Shipped 自动联动单批失败（不阻断）', { shipmentId, batchId: b.id, code: r.error.code, message: r.error.message });
        }
      }
      if (advanced.length > 0) {
        logger.info('[OrderShipmentBatch] Shipment→Shipped 自动联动推进批次', { shipmentId, advanced });
      }
    } catch (e: any) {
      logger.warn('[OrderShipmentBatch] Shipment→Shipped 自动联动异常（不阻断）', { shipmentId, error: e?.message });
    }
    return { advanced, failed };
  }

  return {
    createBatch,
    updateBatch,
    markShipped,
    autoAdvanceOnShipmentShipped,
    recalcSettlement,
    recalcOrderSettlement,
    totalPaidOfOrder,
    listByOrder,
    listOverdueFinalBatches,
  };
}
