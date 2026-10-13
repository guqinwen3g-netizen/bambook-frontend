
/**
 * receiptFobReconciliationService.ts — T7-③ 收汇金额 ↔ 报关 FOB 勾稽
 *
 * 设计真源：docs/design/T7-3-收汇FOB勾稽-设计-2026-09-16.md
 *
 * 为什么必须有（现状核准结论）：
 *   水单核销链（receiptClaimService / allocationService）只到**发票/订单**层，
 *   **完全不碰报关单** → 收汇与报关 FOB 各在各的域，永远碰不上。
 *   外汇核销/退税核查要求二者勾稽：收汇显著低于 FOB 可能是「未收汇即申报退税」；
 *   显著高于 FOB 可能是多收/错汇/混入非本单款项。
 *
 * 口径 D（2026-09-16 业务方拍板）：
 *   - 容差 = max(5% × 报关FOB, 500)；超差**只预警不阻断**（severity 恒 'warning'）。
 *   - **CIF 单必须先减掉运费和保费再比**（收汇对应的只是货值，运保费是代垫的）。
 *
 * 铁律（与口径 A 一致）：**不引入任何汇率换算**——运单运保费币种与报关币种不一致时，
 * 不换算、改为「该票不参与比对」并说明原因（换算需要新汇率口径，业务方明确只认结汇汇率）。
 *
 * 纯只读：不写库、不触发状态重算；Decimal 累加避免 IEEE 754 漂移。
 */
import { Prisma, PrismaClient } from '@prisma/client';

export type ReceiptFobDiscrepancyType = 'receipt_fob_mismatch';

export interface ReceiptFobDiscrepancy {
  type: ReceiptFobDiscrepancyType;
  currency: string;
  field: string;
  /** 期望：收汇金额 */
  expected: string;
  /** 实际：报关 FOB（已剥运保费） */
  actual: string;
  /** 口径 D：超差**只预警不阻断** */
  severity: 'warning';
  message: string;
}

export interface ReceiptFobCurrencyRow {
  currency: string;
  receiptAmount: number;        // Σ 收汇（该币种）
  declaredFob: number;          // Σ 报关 FOB（已剥运保费；不含 unStrippable 的票）
  declaredGross: number;        // Σ 报关原始申报额（未剥，供对照）
  strippedFreight: number;      // 已剥运费合计
  strippedInsurance: number;    // 已剥保费合计
  difference: number;           // receiptAmount − declaredFob
  differencePct: number | null; // difference / declaredFob（FOB=0 时为 null）
  tolerance: number;            // max(5% × declaredFob, 500)
  toleranceBasis: string;       // 阈值来源说明
  withinTolerance: boolean;
  /** 未参与比对的报关单（剥不了：D 组 / 缺运保费 / 币种不一致） */
  unStrippable: Array<{ declarationNumber: string; reason: string }>;
}

export interface ReceiptFobReconciliation {
  orderId: string;
  orderCode: string | null;
  customerName: string | null;
  byCurrency: ReceiptFobCurrencyRow[];
  discrepancies: ReceiptFobDiscrepancy[];
  receiptVoucherCount: number;
  declarationCount: number;
  /**
   * 该订单应收发票中**最早**的到期日（付款期限）。
   * ⚠️ 用**发票 dueDate** 而非 `Order.dueDate` —— 后者是**订单交期**（交货日），不是付款期限。
   */
  paymentDueDate: string | null;
  /**
   * 尚未到收款期（最早应收到期日 ≥ 今天）。
   * ⚠️ 只抑制**「收汇不足」方向**的差异 —— 钱还没到是时间问题。
   * 「收汇**多于** FOB」与到期日无关（钱不该多出来），照报，否则会漏掉
   * 错汇 / 混入他单款项。见下方 `suppressByDueDate`。
   *（预警一旦被无视就失效；口径：只对**已过应收到期日**仍未收汇的单预警。）
   */
  notYetDue: boolean;
}

const EPS = new Prisma.Decimal('0.0001');
/** 固定阈值：500（按该币种金额单位；业务主币种 USD 时即 500 美元） */
const FIXED_TOLERANCE = new Prisma.Decimal(500);
const PCT_TOLERANCE = new Prisma.Decimal('0.05');
const UNKNOWN_CURRENCY = '(未标币种)';

/**
 * 成交方式 → 是否剥离运保费：**归类清单不在这里**（B225 收口）。
 * 真源 = `../_shared/incoterm.ts`。此前本文件与 `customs/taxRefundCalcService`、
 * `components/CustomsManager` 各持一份术语 Set ⇒ 同一口径三份实现、各自漂（B249/B255 那一族），
 * FAS 就是这样"三份都没登记、各自静默走进不剥"的。
 */
import { incotermStripClass } from '../_shared/incoterm';
import { todayLocalKey } from '../shared/localDate';


function dec(v: unknown): Prisma.Decimal {
  if (v === null || v === undefined) return new Prisma.Decimal(0);
  try { return new Prisma.Decimal(v as any); } catch { return new Prisma.Decimal(0); }
}

function d2n(d: Prisma.Decimal): number {
  return Number(d.toFixed(4));
}

/**
 * 收汇 ↔ 报关 FOB 勾稽（按订单）。订单不存在/已软删 → null（路由层转 404）。
 */
export async function reconcileReceiptFob(
  prisma: PrismaClient,
  orderId: string,
  today = todayLocalKey(),
): Promise<ReceiptFobReconciliation | null> {
  const db = prisma as any;

  const order = await db.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: { id: true, code: true, customer: true },
  });
  if (!order) return null;

  const [vouchers, declarations] = await Promise.all([
    db.paymentVoucher.findMany({
      where: { orderId, type: 'Receipt', deletedAt: null },
      select: { id: true, amount: true, currency: true },
    }),
    db.customsDeclaration.findMany({
      where: { orderId, deletedAt: null },
      select: {
        id: true, declarationNumber: true, status: true, totalValue: true,
        currency: true, tradeTerms: true, shipmentId: true,
      },
    }),
  ]);

  // ── 应收到期日（未收款是否到期）：取该订单**应收发票**中最早的 dueDate ──
  // 用 try/catch 而非 .catch()：mock/老库缺 invoice 模型时是**同步抛 TypeError**，.catch 接不住
  let dueInvoiceRows: any[] = [];
  try {
    dueInvoiceRows = await db.invoice.findMany({
      where: { orderId, type: 'Receivable', status: { not: 'Cancelled' }, deletedAt: null },
      select: { dueDate: true },
    }) ?? [];
  } catch {
    dueInvoiceRows = [];
  }
  const dueDates = dueInvoiceRows
    .map((i: any) => String(i.dueDate ?? '').trim())
    .filter((d: string) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .map((d: string) => d.slice(0, 10))
    .sort();
  const paymentDueDate = dueDates.length ? dueDates[0] : null;
  const notYetDue = !!paymentDueDate && paymentDueDate >= today;

  // ── 收汇按币种分组 ──────────────────────────────────────────────────────
  const receiptByCurrency = new Map<string, Prisma.Decimal>();
  for (const v of vouchers) {
    const cur = String(v.currency ?? '').trim() || UNKNOWN_CURRENCY;
    receiptByCurrency.set(cur, (receiptByCurrency.get(cur) ?? new Prisma.Decimal(0)).plus(dec(v.amount)));
  }

  // ── 报关单逐张折算 FOB ──────────────────────────────────────────────────
  interface Bucket {
    fob: Prisma.Decimal; gross: Prisma.Decimal;
    freight: Prisma.Decimal; insurance: Prisma.Decimal;
    unStrippable: Array<{ declarationNumber: string; reason: string }>;
  }
  const buckets = new Map<string, Bucket>();
  const bucketOf = (cur: string): Bucket => {
    let b = buckets.get(cur);
    if (!b) {
      b = { fob: new Prisma.Decimal(0), gross: new Prisma.Decimal(0), freight: new Prisma.Decimal(0), insurance: new Prisma.Decimal(0), unStrippable: [] };
      buckets.set(cur, b);
    }
    return b;
  };

  for (const d of declarations) {
    if (d.status === 'Cancelled') continue; // 作废报关单不计
    const cur = String(d.currency ?? '').trim() || UNKNOWN_CURRENCY;
    const gross = dec(d.totalValue);
    const b = bucketOf(cur);
    b.gross = b.gross.plus(gross);

    const terms = String(d.tradeTerms ?? '').trim().toUpperCase();
    const declNo = String(d.declarationNumber ?? d.id);

    const cls = incotermStripClass(terms);
    if (cls === 'unstrippable') {
      b.unStrippable.push({ declarationNumber: declNo, reason: `成交方式 ${terms}（含运保费+关税+送货），本批不剥离 → 该票不参与比对` });
      continue;
    }

    let needFreight = cls === 'freight-only' || cls === 'freight-and-insurance';
    let needInsurance = cls === 'freight-and-insurance';

    if (!needFreight && !needInsurance) {
      // FOB/FCA/EXW 或**未填成交方式**（按离岸价处理：不剥是保守方向——FOB 偏高会让
      // 收汇显得不足，报「收汇不足」而非「多收」，方向安全）
      b.fob = b.fob.plus(gross);
      continue;
    }

    const ship = d.shipmentId
      ? await db.shipment.findUnique({
          where: { id: d.shipmentId },
          select: { freightAmount: true, freightCurrency: true, insuranceAmount: true, insuranceCurrency: true },
        })
      : null;

    let fob = gross;
    let blocked = false;

    if (needFreight) {
      if (!ship || ship.freightAmount == null) {
        b.unStrippable.push({ declarationNumber: declNo, reason: `${terms} 需剥运费，但关联运单未登记运费 → 该票不参与比对` });
        blocked = true;
      } else if (ship.freightCurrency && cur !== UNKNOWN_CURRENCY
        && String(ship.freightCurrency).trim().toUpperCase() !== cur.toUpperCase()) {
        b.unStrippable.push({ declarationNumber: declNo, reason: `运费币种 ${ship.freightCurrency} ≠ 报关币种 ${cur}，**不做汇率换算**（口径 A）→ 该票不参与比对` });
        blocked = true;
      } else {

        fob = fob.minus(dec(ship.freightAmount));
        b.freight = b.freight.plus(dec(ship.freightAmount));
      }
    }
    if (!blocked && needInsurance) {
      if (!ship || ship.insuranceAmount == null) {
        b.unStrippable.push({ declarationNumber: declNo, reason: `${terms} 需剥保费，但关联运单未登记保险费 → 该票不参与比对` });
        blocked = true;
      } else if (ship.insuranceCurrency && cur !== UNKNOWN_CURRENCY
        && String(ship.insuranceCurrency).trim().toUpperCase() !== cur.toUpperCase()) {
        b.unStrippable.push({ declarationNumber: declNo, reason: `保费币种 ${ship.insuranceCurrency} ≠ 报关币种 ${cur}，**不做汇率换算**（口径 A）→ 该票不参与比对` });
        blocked = true;
      } else {
        fob = fob.minus(dec(ship.insuranceAmount));
        b.insurance = b.insurance.plus(dec(ship.insuranceAmount));
      }
    }

    if (blocked) continue;
    b.fob = b.fob.plus(fob);
  }

  // ── 逐币种比对（容差 = max(5% × FOB, 500)）────────────────────────────
  const currencies = [...new Set([...receiptByCurrency.keys(), ...buckets.keys()])].sort((a, b) => a.localeCompare(b));
  const byCurrency: ReceiptFobCurrencyRow[] = [];
  const discrepancies: ReceiptFobDiscrepancy[] = [];

  for (const cur of currencies) {
    const receipt = receiptByCurrency.get(cur) ?? new Prisma.Decimal(0);
    const b = buckets.get(cur) ?? {
      fob: new Prisma.Decimal(0), gross: new Prisma.Decimal(0),
      freight: new Prisma.Decimal(0), insurance: new Prisma.Decimal(0), unStrippable: [],
    };
    const fob = b.fob;
    const pctTol = fob.mul(PCT_TOLERANCE);
    const tolerance = pctTol.gt(FIXED_TOLERANCE) ? pctTol : FIXED_TOLERANCE;
    const toleranceBasis = pctTol.gt(FIXED_TOLERANCE)
      ? `5% × ${d2n(fob)} = ${d2n(pctTol)}（大于固定阈值 500）`
      : `固定阈值 500（5% × ${d2n(fob)} = ${d2n(pctTol)} 未超过）`;
    const difference = receipt.minus(fob);
    const withinTolerance = difference.abs().lte(tolerance);

    byCurrency.push({
      currency: cur,
      receiptAmount: d2n(receipt),
      declaredFob: d2n(fob),
      declaredGross: d2n(b.gross),
      strippedFreight: d2n(b.freight),
      strippedInsurance: d2n(b.insurance),
      difference: d2n(difference),
      differencePct: fob.gt(0) ? d2n(difference.div(fob).mul(100)) : null,
      tolerance: d2n(tolerance),
      toleranceBasis,
      withinTolerance,
      unStrippable: b.unStrippable,
    });

    // 未到收款期 → **只压「收汇不足」**（钱还没到是时间问题），不压「多收」
    // （多收与到期日无关，是错汇/混入他单款项的信号，压掉即漏报）
    const suppressByDueDate = notYetDue && difference.lt(0);
    if (!withinTolerance && !suppressByDueDate) {
      // 「完全没收汇」与「少收汇」业务含义不同：前者可能只是还没到收款期，
      // 后者更可能是佣金/折让/报关偏高。分开表述，避免财务被同一句话误导。
      const zeroReceipt = receipt.isZero();
      const direction = zeroReceipt
        ? '本单尚无收汇记录'
        : difference.lt(0) ? '收汇少于报关 FOB' : '收汇多于报关 FOB';
      const tail = zeroReceipt
        ? '（若尚未到收款期属正常；若已申报退税则需核实「未收汇即退税」）'
        : difference.lt(0)
          ? '可能是佣金/折让/未收汇，或报关金额偏高'
          : '可能是多收/错汇/混入非本单款项';
      // 带上到期日：财务看到「已逾期」才知道该催哪一单；无到期日也说明口径
      const dueHint = paymentDueDate
        ? `应收到期日 ${paymentDueDate}（${paymentDueDate < today ? '已逾期' : '未到期'}）`
        : '该订单无应收发票到期日（不设门槛，按最保守口径报）';
      discrepancies.push({
        type: 'receipt_fob_mismatch',
        currency: cur,
        field: 'receiptAmount',
        expected: d2n(receipt).toString(),
        actual: d2n(fob).toString(),
        severity: 'warning',
        message: `${cur} ${direction}：收汇 ${d2n(receipt)}，报关 FOB ${d2n(fob)}（差 ${d2n(difference)}，`
          + `${fob.gt(0) ? `差异率 ${d2n(difference.div(fob).mul(100))}%` : 'FOB 为 0'}，`
          + `容差 ${d2n(tolerance)}：${toleranceBasis}）——${dueHint}；${tail}`,
      });
    }
  }

  return {
    orderId: order.id,
    orderCode: order.code ?? null,
    customerName: order.customer ?? null,
    byCurrency,
    discrepancies,
    receiptVoucherCount: vouchers.length,
    declarationCount: declarations.filter((d: any) => d.status !== 'Cancelled').length,
    paymentDueDate,
    notYetDue,
  };
}
