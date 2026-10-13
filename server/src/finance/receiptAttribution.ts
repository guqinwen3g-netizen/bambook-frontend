/**
 * receiptAttribution.ts — 「收款凭证归属哪个客户」的唯一真源（**纯函数，零依赖**）
 *
 * ── 为什么单独成文件 ──
 * 与 `thirdPartyPaymentGuard.ts` / `allocationCustomerGuard.ts` 同一理由：
 *   ① 服务端报表内核（finance/reportService.getCustomerStatement）
 *   ② 服务端门禁测试
 *   ③ 前端同口径展示 / 跨层对撞测试
 * 需要 import 同一份判定；真源若住在 reportService 里会把 @prisma/client 拖进前端
 * 类型检查（root tsconfig exclude 了 server，import 却能穿透）⇒ 前端门禁被污染。
 * 所以本文件 **不 import 任何东西**，谁都能安全引。
 *
 * ── 业务问题（A2：第三方代付不算账）──
 * 第三方代付 = 实际打款人 ≠ 合同客户（母公司替子公司付、客户指定货代付、境外客户
 * 由香港公司付汇……）。业务口径是**放行 + 留痕**（见 thirdPartyPaymentGuard 头注释）。
 *
 * 但原来的财务面全部按 `PaymentVoucher.customerRelationId`（= 实际打款人）归集收款：
 *   · 合同客户 B 的**对账单**查 `where: { customerRelationId: B, type:'Receipt' }`
 *     → A 替 B 付的钱**根本不出现** ⇒ B 的对账单显示「还没付」，客户拿着水单来对账
 *       → 账实不符，且是最伤信任的一种（客户明明付了）。
 *   · 反过来，代付方 A 的对账单（若 A 也是客户）会**凭空多出一笔收款**，
 *     没有对应发票 ⇒ A 的对账单余额为负（公司欠 A 钱）—— 同样是错账。
 *
 * ⓘ 账龄与授信侧 `Invoice.customerRelationId`（合同客户）+ 净额口径已经是**对的**
 *   （reportService.getAgingReport / creditService.computeNetOpenReceivables /
 *   riskService 都按发票归集，第三方代付核销后同样减少合同客户的 open）。
 *   本真源补的是**收款侧**的归属 —— 缺口在对账单与按客户归集收款的面。
 *
 * ── 归位口径（拍板）──
 *  一笔收款凭证，按「钱实际核销了谁的应收发票」归属：
 *   ① 核销到 X 的应收发票 ⇒ 归 X（X ≠ 付款人时标记 isThirdParty，带代付说明）
 *   ② 未核销余款（amount − Σapplied）⇒ 仍归**付款人**（钱还没落到谁的账上，
 *      属预收/在途，挂付款人名下才追得到）
 *   ③ 同一凭证归同一客户的多条（含①+②）**合并成一行** ⇒
 *      非代付场景的输出与改造前**逐字节一致**（全额一行），不制造回归。
 *
 * ── 刻意不做的两件事（写下来防后人踩）──
 *   · 不把「代付方」也记一笔应收：代付不是代付方的债务，记了就是虚增。
 *   · 不按 `PaymentVoucher.invoiceId`（单值快照字段）判归属：它只记最后一张票，
 *     一票多单 / 分批核销会漏，且可被手工改写 ⇒ 一律走 InvoiceAllocation 明细。
 */

/** 参与归属计算的收款凭证（实际打款人视角） */
export interface AttributionVoucher {
  id: string;
  voucherNumber: string;
  /** 'Receipt' 才参与；缺省照判（对齐 thirdPartyPaymentGuard 的宽松口径） */
  type?: string | null;
  /** 实际打款人 relationId */
  customerRelationId?: string | null;
  /** 打款人名称快照 */
  customerName?: string | null;
  amount: MoneyLike;
  currency?: string | null;
  paymentDate?: string | null;
}

/** 收款核销明细（InvoiceAllocation） */
export interface AttributionAllocation {
  voucherId: string;
  invoiceId: string;
  appliedAmount: MoneyLike;
}

/** 被核销发票（用于取「合同客户」） */
export interface AttributionInvoice {
  id: string;
  /** 合同客户（票开给谁） */
  customerRelationId?: string | null;
  /** 合同客户名称快照 */
  customerName?: string | null;
  /** 'Receivable' 才参与归属；缺省照判 */
  type?: string | null;
}

/** 归属结果：一行 = 「某凭证归某个客户多少钱」 */
export interface AttributedReceiptLine {
  voucherId: string;
  voucherNumber: string;
  /** 归属客户（账挂谁头上） */
  ownerRelationId: string;
  ownerName: string | null;
  /** 归属金额（该客户名下的部分） */
  amount: number;
  currency: string;
  paymentDate: string;
  /** 打款人 ≠ 归属客户 */
  isThirdParty: boolean;
  /** 实际打款人 */
  payerRelationId: string | null;
  payerName: string | null;
  /** 其中：已核销到该客户发票的部分 */
  appliedAmount: number;
  /** 其中：未核销、挂在付款人名下的部分（仅付款人自己那行可能 > 0） */
  unappliedAmount: number;
  /** 面向人的一句说明（第三方代付时非空，可直接进对账单备注 / 审计 detail） */
  note: string | null;
}

/** 金额入参容差：number / 数字字符串 / Prisma.Decimal（不 import 类型也能收） */
export type MoneyLike = number | string | { toString(): string } | null | undefined;

const num = (v: MoneyLike): number => {
  if (v == null) return 0;
  const n = typeof v === 'object' ? Number(String(v)) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * 把收款凭证按「核销了谁的应收发票」归属到客户。
 *
 * 纯函数：无 IO、无 Date/随机数、无环境依赖，可直接做跨层对撞。
 * 输出已按 (凭证 × 归属客户) 合并；顺序 = 输入凭证顺序（稳定）。
 */
export function attributeReceiptsToCustomers(input: {
  vouchers: AttributionVoucher[];
  allocations: AttributionAllocation[];
  invoices: AttributionInvoice[];
}): AttributedReceiptLine[] {
  const { vouchers = [], allocations = [], invoices = [] } = input;

  // 发票 → 合同客户（非应收票不参与归属；type 缺省照判）
  const ownerByInvoice = new Map<string, { relationId: string; name: string | null }>();
  for (const inv of invoices) {
    if (inv.type && inv.type !== 'Receivable') continue;
    const rid = (inv.customerRelationId || '').trim();
    if (!rid) continue;
    ownerByInvoice.set(inv.id, { relationId: rid, name: inv.customerName ?? null });
  }

  // 凭证 → 「合同客户 → 已核销额」
  const appliedByVoucher = new Map<string, Map<string, number>>();
  for (const a of allocations) {
    const owner = ownerByInvoice.get(a.invoiceId);
    if (!owner) continue; // 非应收票 / 无合同客户 ⇒ 不参与归属（钱留在付款人）
    let m = appliedByVoucher.get(a.voucherId);
    if (!m) { m = new Map(); appliedByVoucher.set(a.voucherId, m); }
    m.set(owner.relationId, (m.get(owner.relationId) ?? 0) + num(a.appliedAmount));
  }

  const lines: AttributedReceiptLine[] = [];
  for (const v of vouchers) {
    if (v.type && v.type !== 'Receipt') continue;
    const total = num(v.amount);
    const payerRelationId = (v.customerRelationId || '').trim() || null;
    const payerName = v.customerName ?? null;
    const currency = v.currency ?? '';
    const paymentDate = v.paymentDate ?? '';

    const byOwner = appliedByVoucher.get(v.id) ?? new Map<string, number>();
    let allocated = 0;
    for (const amt of byOwner.values()) allocated += amt;
    // 超核销（历史脏数据）不该造出负的未核销额
    const unapplied = Math.max(0, round4(total - allocated));

    const names = new Map<string, string | null>();
    for (const inv of invoices) {
      const rid = (inv.customerRelationId || '').trim();
      if (rid && !names.has(rid) && inv.customerName) names.set(rid, inv.customerName);
    }

    // ① 核销到各合同客户的部分
    for (const [ownerRelationId, applied] of byOwner) {
      // ⓘ 变量名刻意避开圆角类名的那个英文词：design-token 守卫按裸词匹配（**不剥注释**），
      //   一个普通变量名就会把前端门禁顶红（实测踩到）⇒ 换名，别去改守卫基线。
      const appliedR4 = round4(applied);
      if (appliedR4 <= 0) continue;
      const isThirdParty = ownerRelationId !== payerRelationId;
      lines.push({
        voucherId: v.id,
        voucherNumber: v.voucherNumber,
        ownerRelationId,
        ownerName: ownerRelationId === payerRelationId ? payerName : (names.get(ownerRelationId) ?? null),
        // ③ 合并：付款人自己那行要把未核销余款一并带上 ⇒ 非代付场景金额 = 全额
        amount: round4(appliedR4 + (ownerRelationId === payerRelationId ? unapplied : 0)),
        currency,
        paymentDate,
        isThirdParty,
        payerRelationId,
        payerName,
        appliedAmount: appliedR4,
        unappliedAmount: ownerRelationId === payerRelationId ? unapplied : 0,
        note: isThirdParty
          ? `第三方代付：本笔由「${payerName || payerRelationId || '未知付款方'}」代为支付，已计入本客户往来`
          : null,
      });
    }

    // ② 未核销余款：凭证没有任何核销，或核销后还有剩 —— 一律留在付款人名下
    const hasPayerLine = byOwner.has(payerRelationId ?? '');
    if (unapplied > 0 && !hasPayerLine) {
      if (!payerRelationId) continue; // 连付款人都不知道 ⇒ 无处可挂，丢弃（不凭空造行）
      lines.push({
        voucherId: v.id,
        voucherNumber: v.voucherNumber,
        ownerRelationId: payerRelationId,
        ownerName: payerName,
        amount: unapplied,
        currency,
        paymentDate,
        isThirdParty: false,
        payerRelationId,
        payerName,
        appliedAmount: 0,
        unappliedAmount: unapplied,
        note: null,
      });
    }
  }

  return lines;
}

/** 只取「归属某客户」的行（报表/对账单用；顺带按币种分组已在调用方） */
export function linesForRelation(
  lines: AttributedReceiptLine[],
  relationId: string,
): AttributedReceiptLine[] {
  const rid = (relationId || '').trim();
  if (!rid) return [];
  return lines.filter(l => l.ownerRelationId === rid);
}
