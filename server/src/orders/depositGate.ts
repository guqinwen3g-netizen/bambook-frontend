/**
 * depositGate.ts — T/T 定金门禁（D3 拍板接线，2026-09-30）
 *
 * 拍板原文（`docs/业务变体矩阵-2026-09-16.md` D3，Kevin 2026-09-16）：
 *   「T/T 定金比例结构化（新增 `depositRatio`）并**未收足定金不得进生产/不得发运**」
 *
 * ── 三条硬纪律（错一条就是误拦或漏拦）──
 *  ① **只管 T/T**：L/C 有自己的全套门禁（`customs/lcGate.ts`），
 *     O/A·D/P·D/A 未见拍板 ⇒ 一律**不适用**（不越权卡别的付款方式）。
 *  ② **未录 ≠ 免检，也 ≠ 违规**：`depositRatio` 为空 ⇒ 返回 `not_applicable`（不拦），
 *     但调用方**必须**把它当成"这条风控没生效"如实展示 —— 不许显示成"已通过"。
 *  ③ **已收额取收款真源**：不落第二份累计（`Order.depositReceivedAmount` 刻意没加），
 *     直接从 `PaymentVoucher` 归集（type=Receipt 且未取消）⇒ 防两套账。
 *
 * ── 例外放行 ──
 *   与短装/信用证同范式：走既有 DR-013 例外机制（`exceptionGate`），不另造一套。
 */
import type { PrismaClient } from '@prisma/client';

export type DepositGateStage = 'production:start' | 'shipment:release';

export interface DepositGateDecision {
  /** 适用 = 付款方式归一为 T/T 且已录定金比例 */
  applicable: boolean;
  satisfied: boolean;
  /** 不适用/不满足的原因码（applicable=true 且 satisfied=false 时才有阻断意义） */
  reasonCode?: 'DEPOSIT_NOT_CONFIGURED' | 'DEPOSIT_RATIO_INVALID' | 'DEPOSIT_INSUFFICIENT';
  requiredAmount?: number | null;
  receivedAmount?: number | null;
  currency?: string | null;
  message?: string;
}

const blank = (v: unknown) => String(v ?? '').trim().length === 0;

/** 付款方式归一：只认 T/T（含 TT / T/T / t/t）；其余返回 null（不适用）。 */
export function normalizePaymentInstrument(raw: string | null | undefined): 'TT' | 'LC' | 'OTHER' | null {
  const s = String(raw ?? '').toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (s === 'T/T' || s === 'TT') return 'TT';
  if (s === 'L/C' || s === 'LC') return 'LC';
  return 'OTHER';
}

/**
 * 纯函数：给定「应收定金 / 已收金额」判是否满足（容差 0.01，规避浮点与分位取整）。
 * 未录比例 ⇒ not_applicable（不拦，但如实标出"这条没生效"）。
 */
export function decideDepositGate(input: {
  paymentInstrument?: string | null;
  depositRatio?: number | string | null;
  orderAmount?: number | null;
  receivedAmount?: number | null;
  currency?: string | null;
}): DepositGateDecision {
  const instrument = normalizePaymentInstrument(input.paymentInstrument);
  // ① 只管 T/T
  if (instrument === null || instrument !== 'TT') {
    return { applicable: false, satisfied: true, reasonCode: 'DEPOSIT_NOT_CONFIGURED' };
  }
  const ratioRaw = input.depositRatio;
  const ratio = typeof ratioRaw === 'string' ? Number(ratioRaw) : ratioRaw;
  // ② 未录比例 ⇒ 不适用（不拦），如实标出
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) {
    return { applicable: false, satisfied: true, reasonCode: 'DEPOSIT_NOT_CONFIGURED', currency: input.currency ?? null };
  }
  const r = Number(ratio);
  // 负数或 >100 是脏值 ⇒ 不拿它算（算出来的"应收"会离谱），按不适用 + 如实标出
  if (r < 0 || r > 100) {
    return {
      applicable: false,
      satisfied: true,
      reasonCode: 'DEPOSIT_RATIO_INVALID',
      currency: input.currency ?? null,
      message: `定金比例 ${r}% 超出 0~100，无法计算应收定金；请修正订单的定金比例`,
    };
  }
  const orderAmount = Number(input.orderAmount ?? 0);
  const required = Math.round(orderAmount * (r / 100) * 100) / 100;
  const received = Math.round(Number(input.receivedAmount ?? 0) * 100) / 100;
  // ③ 归集到的已收额（同币种才比；跨币种不做隐式折算，与 #13 同口径）
  const satisfied = received + 0.01 >= required;
  return {
    applicable: true,
    satisfied,
    reasonCode: satisfied ? undefined : 'DEPOSIT_INSUFFICIENT',
    requiredAmount: required,
    receivedAmount: received,
    currency: input.currency ?? null,
    message: satisfied
      ? undefined
      : `定金未收足：应收 ${required} ${input.currency ?? ''}，已收 ${received} ${input.currency ?? ''}（差 ${Math.round((required - received) * 100) / 100}）`,
  };
}

/** 从收款真源归集某订单已收金额（type=Receipt 且未取消；币种需与订单一致，跨币种不计入） */
export async function collectReceivedAmount(
  prisma: PrismaClient,
  params: { orderId: string; currency: string | null },
): Promise<number> {
  // ★ 容错：收款归集是**增强风控**的取数，不是出运判据本身 ⇒ 查询不可用（含测试替身缺表）
  //   时按 0 记（= 未收足）会误拦，按"不适用"放行又会漏 ⇒ 折中：抛给上层由 evaluate 兜底为不适用，
  //   绝不让出运接口因这条风控取数失败而 500。
  const pv: any = (prisma as any)?.paymentVoucher;
  if (!pv?.findMany) return 0;
  const rows = await pv.findMany({
    where: { orderId: params.orderId, type: 'Receipt', deletedAt: null },
    select: { amount: true, currency: true, bankFee: true },
  });
  let sum = 0;
  for (const v of rows ?? []) {
    // 跨币种不计入（不隐式折算）；与利润表/核销同口径
    if (params.currency && String((v as any).currency ?? '') !== params.currency) continue;
    sum += Number((v as any).amount ?? 0);
  }
  return Math.round(sum * 100) / 100;
}

/**
 * 订单级定金判定（取数 + 纯函数判定）：读订单的付款方式/定金比例/金额，
 * 已收额从收款真源（PaymentVoucher）归集 ⇒ 不落第二份累计。
 */
export async function evaluateDepositGateForOrder(
  prisma: PrismaClient,
  params: { orderId: string; order?: { paymentInstrument?: string | null; depositRatio?: any; depositCurrency?: string | null; currency?: string | null; contractAmount?: any; totalNet?: any; quoteAmount?: any } | null },
): Promise<DepositGateDecision> {
  let order = params.order;
  if (!order) {
    order = await prisma.order.findUnique({
      where: { id: params.orderId },
      select: {
        paymentInstrument: true, depositRatio: true, depositCurrency: true,
        currency: true, contractAmount: true, totalNet: true, quoteAmount: true,
      },
    } as any);
  }
  if (!order) return { applicable: false, satisfied: true, reasonCode: 'DEPOSIT_NOT_CONFIGURED' };

  // 订单额取数链：合同额 → 净额 → 报价额（三者任一，取第一个有效正数；都不行 ⇒ 0 ⇒ 判定为收足但如实不适用）
  const amount = [order.contractAmount, order.totalNet, order.quoteAmount]
    .map((v) => Number(v ?? 0))
    .find((v) => Number.isFinite(v) && v > 0) ?? 0;
  const currency = order.depositCurrency ?? order.currency ?? null;
  let received = 0;
  try {
    received = await collectReceivedAmount(prisma, { orderId: params.orderId, currency });
  } catch {
    // 归集失败 ⇒ 这条风控**没生效** ⇒ 如实返回不适用（不拦），绝不 500，也绝不假装通过
    return { applicable: false, satisfied: true, reasonCode: 'DEPOSIT_NOT_CONFIGURED', currency };
  }
  return decideDepositGate({
    paymentInstrument: order.paymentInstrument,
    depositRatio: order.depositRatio === null || order.depositRatio === undefined ? null : Number(order.depositRatio),
    orderAmount: amount,
    receivedAmount: received,
    currency,
  });
}
