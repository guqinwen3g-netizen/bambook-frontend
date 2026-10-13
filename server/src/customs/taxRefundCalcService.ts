/**
 * taxRefundCalcService.ts — T7-④ 退税核算「单一算法真源」+ 报缺 + 补齐后重算
 *
 * 设计真源：docs/design/T7-4-退税报缺与重算-设计建议-2026-09-16.md
 *
 * 现状（核准结论）：`customsService.createTaxRefundFromDeclaration` **已经会自动算**
 * （FOB / 汇率 / 按 HS 加权退税额），真实缺口是**算不出来时静默存 null**——
 * 用户拿到一张金额全空的退税单，不知道为什么空。
 *
 * 本文件做三件事，共用同一个核算函数（避免"自动生成的金额"与"重算后的金额"两套算法）：
 *   1. computeTaxRefundFigures —— 核算 + 缺项（gaps）**实时计算**
 *   2. describeTaxRefundGaps  —— 只读报缺（UI 用）
 *   3. recalcTaxRefund        —— 补齐后重算（默认只填 null，不覆盖人工值）
 *
 * 口径 E（2026-09-16 拍板）：**显式报缺 + 补齐后一键重算**，不用市场汇率/默认退税率静默兜底
 * （算错的退税额比没有更危险——报上去就是错报）。
 *
 * ⚠️ 单位锚死（勿再踩）：`HsCode.exportTaxRebateRate` 与 `TaxRefund.refundableRate` 口径均为
 * **百分数**（如 13 表示 13%），故核算时须 `/100`。历史实现漏除导致退税额放大 100 倍。
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });

export type TaxRefundGapCode =
  | 'no_lines'
  | 'fx_rate'
  | 'hs_rebate_rate'
  | 'line_total'
  /** CIF/CFR 需剥运费，但报关单未登记运费 → 算不出 FOB（2026-09-17 加） */
  | 'freight_missing'
  /** CIF/CIP 需剥保费，但报关单未登记保费 → 算不出 FOB */
  | 'insurance_missing'
  /** DDP/DAP/DPU 含关税+送货，剥离需额外数据，本批不猜 */
  | 'trade_terms_unsupported'
  /**
   * 剥离运保费后 FOB ≤ 0 → 数据异常（2026-09-17 加）。
   * 为什么单列而**不复用 freight_missing**：运保费其实都登记了，
   * 复用会让 UI 叫用户「去填运费」—— 填一个已经填了的字段，用户会卡在这里反复试。
   */
  | 'fob_not_positive';

// ════════════════════════════════════════════════════════════════════
// 成交方式 → 是否需要剥离运保费：**归类逻辑不在本文件里**（B225 收口）
//   真源 = `server/src/_shared/incoterm.ts`。此前这里与 `finance/receiptFobReconciliationService`、
//   `components/CustomsManager` 各有一份术语 Set（同一口径三份实现），FAS 就是这么漏登记的。
//   下面只做"转出口 + 按类别分支"，不再持有术语清单。
// ════════════════════════════════════════════════════════════════════
import { incotermStripClass, type IncotermStripClass } from '../_shared/incoterm';

export { incotermStripClass };
export type { IncotermStripClass };

export interface StripToFobInput {
  /** 申报毛额（CIF 口径时含运保费） */
  gross: number | null;
  tradeTerms?: string | null;
  /** 报关单登记的运费（币种同报关单） */
  freightAmount?: number | null;
  /** 报关单登记的保费 */
  insuranceAmount?: number | null;
}

export interface StripToFobResult {
  /** 剥离后的 FOB；算不出时为 null（**不猜、不回退成 CIF**） */
  fob: number | null;
  strippedFreight: number;
  strippedInsurance: number;
  needFreight: boolean;
  needInsurance: boolean;
  /** 算不出的原因（供 UI 提示「去补什么」） */
  gap: 'freight_missing' | 'insurance_missing' | 'trade_terms_unsupported' | 'fob_not_positive' | null;
}

/**
 * 按成交方式把申报毛额剥离成 FOB（退税基数）。
 *
 * 为什么必须有这一步：退税 = FOB × 退税率。CIF/CFR 报关时 `totalValue` 是**含运保费**的，
 * 直接拿它当 FOB 会让退税额**系统性虚高**，而且**不报错**（此前就是这么错的，
 * 变量还叫 exportAmountFob，实为 CIF）。
 *
 * 口径要点：
 *   - 未填成交方式 → **按不剥处理**（保守：FOB 偏高会让退税偏高，
 *     但方向是「多报」而非「漏报」，且不会静默产生一个看似精确的错误数）
 *   - 需要剥但没登记 → **不给数**（fail-closed），绝不回退成毛额
 *   - 剥离后 ≤ 0 → 视为数据异常，同样不给数
 */
export function stripToFob(input: StripToFobInput): StripToFobResult {
  const gross = input.gross;
  const base = { strippedFreight: 0, strippedInsurance: 0, needFreight: false, needInsurance: false, gap: null } as const;
  if (gross == null || !Number.isFinite(gross)) {
    return { ...base, fob: null };
  }

  const terms = String(input.tradeTerms ?? '').trim().toUpperCase();
  const cls = incotermStripClass(terms);
  if (cls === 'unstrippable') {
    return { ...base, fob: null, gap: 'trade_terms_unsupported' };
  }

  // 归类只问 `incotermStripClass` 一处（四组 Set 不再被两处各读一遍）
  const needFreight = cls === 'freight-only' || cls === 'freight-and-insurance';
  const needInsurance = cls === 'freight-and-insurance';
  // FOB/FCA/EXW、未填成交方式、以及**未归类的条款**（如 FAS，见台账 B225）→ 不剥
  if (!needFreight && !needInsurance) {
    return { ...base, fob: gross };
  }

  let fob = gross;
  let strippedFreight = 0;
  let strippedInsurance = 0;

  if (needFreight) {
    const fr = input.freightAmount;
    if (fr == null || !Number.isFinite(fr)) {
      return { ...base, needFreight, needInsurance, fob: null, gap: 'freight_missing' };
    }
    fob -= fr;
    strippedFreight = fr;
  }
  if (needInsurance) {
    const ins = input.insuranceAmount;
    if (ins == null || !Number.isFinite(ins)) {
      return { ...base, needFreight, needInsurance, strippedFreight, fob: null, gap: 'insurance_missing' };
    }
    fob -= ins;
    strippedInsurance = ins;
  }

  // 剥成 0 或负数 → 数据一定填错了（运保费 ≥ 申报额）。给数就是给个假数，
  // 但**报缺码要指向真问题**：运保费都登记了，说「未登记运费」会让用户去填一个已填的字段。
  if (fob <= 0) return { ...base, needFreight, needInsurance, strippedFreight, strippedInsurance, fob: null, gap: 'fob_not_positive' };

  return { fob, strippedFreight, strippedInsurance, needFreight, needInsurance, gap: null };
}

export interface TaxRefundGap {
  code: TaxRefundGapCode;
  /** 给人看的一句话 */
  label: string;
  /** 去哪儿补 */
  howToFix: string;
  /** HS 编码 / 行号 */
  ref?: string;
}

export interface TaxRefundFigures {
  declarationId: string;
  declarationNumber: string;
  status: string;
  orderId: string | null;
  relationId: string | null;
  exportDate: string | null;
  declarationDate: string | null;
  fxRate: number | null;
  exportAmountFob: number | null;
  exportAmountFobCurrency: string | null;
  exportAmountCny: number | null;
  refundableVat: number | null;
  refundableRate: number | null;
  refundAmount: number | null;
  lineCount: number;
  /** 缺项（实时计算，补齐后自动消失——刻意不存库，避免陈旧） */
  gaps: TaxRefundGap[];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * HS 编码归一化：去掉点与空白后比较。
 *
 * 真库实测的**第二个根因**：`HsCode.code` 与 `CustomsDeclarationLine.hsCode` 的书写格式
 * 不一致——档案里是 `52093900`（无分隔符），报关行用 `6204.43.00`（带点）。
 * 精确字符串匹配必然失配 → 退税率永远查不到 → 退税金额永远算不出（与「没登记」同样致命）。
 * 中国海关 HS 是 10 位（如 5209.39.00.00），实务中带点/不带点两种写法都常见，故归一化匹配。
 */
function normHs(code: unknown): string {
  return String(code ?? '').replace(/[.\s]/g, '').toUpperCase();
}

/**
 * 核算某报关单的退税数据 + 报缺。报关单不存在/已软删 → null（调用方转 404）。
 *
 * 数据装配（单一回退链，与历史实现逐字一致）：
 *   - FOB 金额：行明细 totalAmount 合计 → 回退报关单 totalValue
 *   - 汇率快照：应收发票 exchangeRate（开票当日） → 收款凭证 exchangeRate（实际收汇日）
 *   - 出口日期：关联运单 atd（实际离港） → 回退申报日期
 *   - 退税率：按行 HS 查 HsCode.exportTaxRebateRate 加权汇总 refundableVat
 */
export async function computeTaxRefundFigures(
  prisma: any,
  declarationId: string,
): Promise<TaxRefundFigures | null> {
  const decl = await prisma.customsDeclaration.findFirst({
    where: { id: declarationId, deletedAt: null },
    include: { lines: true },
  });
  if (!decl) return null;

  const [invoice, voucher, shipment] = await Promise.all([
    decl.orderId
      ? prisma.invoice.findFirst({
          where: { orderId: decl.orderId, type: 'Receivable', deletedAt: null, status: { not: 'Cancelled' } },
          orderBy: { createdAt: 'desc' },
          select: { exchangeRate: true },
        })
      : null,
    decl.orderId
      ? prisma.paymentVoucher.findFirst({
          where: { orderId: decl.orderId, type: 'Receipt', deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { exchangeRate: true },
        })
      : null,
    decl.shipmentId
      ? prisma.shipment.findUnique({ where: { id: decl.shipmentId }, select: { atd: true, etd: true } })
      : null,
  ]);

  const fxRate = invoice?.exchangeRate != null ? Number(invoice.exchangeRate)
    : voucher?.exchangeRate != null ? Number(voucher.exchangeRate)
    : null;

  // FOB 金额：行明细合计优先，回退报关总额 —— 但**得到的是申报毛额**，
  // CIF/CFR 时含运保费，必须按成交方式剥离才是退税基数（2026-09-17 修：此前直接当 FOB 用，退税额虚高）
  const lineSum = decl.lines.reduce((sum: number, l: any) => sum + (l.totalAmount != null ? Number(l.totalAmount) : 0), 0);
  const grossAmount = lineSum > 0 ? lineSum
    : decl.totalValue != null ? Number(decl.totalValue)
    : null;
  const stripped = stripToFob({
    gross: grossAmount,
    tradeTerms: decl.tradeTerms,
    freightAmount: decl.freightAmount != null ? Number(decl.freightAmount) : null,
    insuranceAmount: decl.insuranceAmount != null ? Number(decl.insuranceAmount) : null,
  });
  // ⚠️ 剥不出来就是 null —— 绝不回退成毛额（回退 = 静默虚高，退税报给税务局的数）
  const exportAmountFob = stripped.fob != null ? round4(stripped.fob) : null;
  const exportAmountCny = exportAmountFob != null && fxRate != null
    ? round4(exportAmountFob * fxRate)
    : null;

  // 退税率：按行 HS 编码加权核算
  // 查询时同时带上「原值」与「归一化变体」，命中后按归一化 key 建表 —— 兼容带点/不带点两种写法
  const lineHsCodes = [...new Set(decl.lines.map((l: any) => String(l.hsCode ?? '').trim()).filter(Boolean))];
  const hsQueryValues = [...new Set(lineHsCodes.flatMap((c) => [c, normHs(c)]))];
  const hsRows = hsQueryValues.length > 0
    ? await prisma.hsCode.findMany({
        where: { code: { in: hsQueryValues }, isActive: true },
        select: { code: true, exportTaxRebateRate: true },
      })
    : [];
  const rebateMap = new Map<string, number | null>(
    hsRows.map((h: any) => [normHs(h.code), h.exportTaxRebateRate != null ? Number(h.exportTaxRebateRate) : null]),
  );

  // ⚠️ 退税基数必须用**剥离后的 FOB**，所以行金额也要缩到同一口径。
  //
  // 这一步是 2026-09-17 补的**第二刀**（第一刀只改了 exportAmountFob，钱没改）：
  // 报出来的 FOB 已经正确剥离，但 refundableVat 仍在按行 `totalAmount`（申报毛额）累加
  // → 退税额照样虚高，且 refundableRate 会算出 13.47% 这种不存在的「退税率」。
  // 变量名对了、字段对了、**钱没对** —— 正是最容易假绿的地方。
  //
  // 分摊口径：运保费在报关单上是**整单**一栏（没有按行的明细），故按行金额占比分摊，
  // 等价于整体乘 k = FOB / 毛额。单行时就是精确相减；多行不同退税率时也不会把运保费
  // 全砸到某一行。k 取不到（毛额为 0/负）时不给数，与 fail-closed 一致。
  const stripRatio = grossAmount != null && grossAmount > 0 && stripped.fob != null
    ? stripped.fob / grossAmount
    : null;

  let refundableVat: number | null = null;
  if (exportAmountCny != null && fxRate != null && stripRatio != null) {
    let sum = 0;
    let covered = false;
    for (const l of decl.lines) {
      const rate = l.hsCode ? rebateMap.get(normHs(l.hsCode)) : undefined;
      if (rate == null || l.totalAmount == null) continue;
      sum += Number(l.totalAmount) * stripRatio * fxRate * (rate / 100); // rate 为百分数 → /100
      covered = true;
    }
    if (covered) refundableVat = round4(sum);
  }

  const refundableRate = refundableVat != null && exportAmountCny != null && exportAmountCny > 0
    ? round4((refundableVat / exportAmountCny) * 100)
    : null;

  // ── 报缺（实时计算：补齐后自动消失，故刻意不存库）──────────────────────
  const gaps: TaxRefundGap[] = [];
  if (decl.lines.length === 0) {
    gaps.push({ code: 'no_lines', label: '报关单没有商品行', howToFix: '先在报关单补商品行' });
  }
  // 运保费报缺：**说清是哪种成交方式、缺哪一项、去哪补**（退税算不出时这是第一解释）
  if (stripped.gap === 'freight_missing') {
    gaps.push({
      code: 'freight_missing',
      label: `成交方式 ${String(decl.tradeTerms ?? '').toUpperCase() || '未填'} 需剥离运费，但报关单未登记运费 → 算不出 FOB，暂不给退税额`,
      howToFix: '在报关单「运费」栏填入报关时申报的运费（不是实际付给货代的钱）',
    });
  } else if (stripped.gap === 'insurance_missing') {
    gaps.push({
      code: 'insurance_missing',
      label: '成交方式 CIF/CIP 需剥离保险费，但报关单未登记保费 → 算不出 FOB，暂不给退税额',
      howToFix: '在报关单「保费」栏填入报关时申报的保险费',
    });
  } else if (stripped.gap === 'trade_terms_unsupported') {
    gaps.push({
      code: 'trade_terms_unsupported',
      label: `成交方式 ${String(decl.tradeTerms ?? '').toUpperCase()} 含关税/送货等费用，剥离需额外数据 → 本票不自动核算退税`,
      howToFix: '请财务手工核算，或改用 FOB/CIF 等可核算的成交方式申报',
    });
  } else if (stripped.gap === 'fob_not_positive') {
    gaps.push({
      code: 'fob_not_positive',
      // 不要写「FOB 为 X」——这个分支里 FOB 恒为 null，写 0 会误导（真值是负数，但负数本身也不该出现）
      label: `剥离运保费后 FOB ≤ 0（申报毛额 ${grossAmount ?? '—'}，运费 ${stripped.strippedFreight} + 保费 ${stripped.strippedInsurance}）—— 申报总额与运保费不匹配，数据异常`,
      howToFix: '核对报关单的申报总额与运费/保费金额（运保费不该 ≥ 申报总额）',
    });
  }
  if (fxRate == null) {
    gaps.push({
      code: 'fx_rate',
      label: '缺汇率快照（订单既无应收发票汇率、也无收汇凭证汇率）',
      howToFix: '给该订单的应收发票补 exchangeRate，或给收汇凭证补 exchangeRate',
    });
  }
  for (const l of decl.lines) {
    if (l.totalAmount == null) {
      gaps.push({ code: 'line_total', label: `第 ${l.lineNumber} 行缺金额`, howToFix: '补报关行 totalAmount', ref: String(l.lineNumber) });
    }
    const code = String(l.hsCode ?? '').trim();
    if (!code) {
      gaps.push({ code: 'hs_rebate_rate', label: `第 ${l.lineNumber} 行缺 HS 编码`, howToFix: '补报关行 HS 编码', ref: String(l.lineNumber) });
    } else if (rebateMap.get(normHs(code)) == null) {
      gaps.push({ code: 'hs_rebate_rate', label: `HS ${code} 未登记出口退税率`, howToFix: '去 HS 编码档案补 exportTaxRebateRate', ref: code });
    }
  }

  return {
    declarationId: decl.id,
    declarationNumber: decl.declarationNumber,
    status: decl.status,
    orderId: decl.orderId ?? null,
    relationId: decl.relationId ?? null,
    exportDate: shipment?.atd ?? shipment?.etd ?? decl.declarationDate ?? null,
    declarationDate: decl.declarationDate ?? null,
    fxRate,
    exportAmountFob,
    exportAmountFobCurrency: decl.currency ?? null,
    exportAmountCny,
    refundableVat,
    refundableRate,
    refundAmount: refundableVat,
    lineCount: decl.lines.length,
    gaps,
  };
}

/** 只读报缺（UI 用；无退税单也能调——缺什么与有没有退税单无关） */
export async function describeTaxRefundGaps(
  prisma: any,
  declarationId: string,
): Promise<Result<{ declarationId: string; declarationNumber: string; figures: TaxRefundFigures; gaps: TaxRefundGap[] }>> {
  const figures = await computeTaxRefundFigures(prisma, declarationId);
  if (!figures) return fail('DECLARATION_NOT_FOUND', `报关单 ${declarationId} 不存在`, 404);
  return ok({ declarationId: figures.declarationId, declarationNumber: figures.declarationNumber, figures, gaps: figures.gaps });
}

/** 可重算的状态（已提交之后的申报数据不可悄悄修改 —— 审计要求） */
const RECALCULABLE_STATUSES = new Set(['Draft', 'Rejected']);

export interface RecalcDiffEntry {
  field: string;
  before: string | null;
  after: string | null;
}

/**
 * 补齐后重算。
 *
 * - `mode = 'fill_missing'`（默认）：**只填当前为 null 的字段**，已有值一律不动
 *   —— 人工填过的金额不会被系统冲掉。
 * - `mode = 'force'`：**只返回 diff，不落库**（由人确认后再决定，避免一键重算改掉审核过的数）。
 * - 状态约束：仅 `Draft` / `Rejected` 可重算；`Submitted` 之后拒绝（409）。
 * - 重算走 **update 既有退税单**，不新建（`declarationId` 唯一约束不变）。
 */
export async function recalcTaxRefund(
  prisma: any,
  declarationId: string,
  opts: { mode?: 'fill_missing' | 'force'; actorId?: string | null; ip?: string | null } = {},
): Promise<Result<{
  mode: string; applied: boolean; patch?: Record<string, unknown>;
  diff: RecalcDiffEntry[]; figures: TaxRefundFigures; gaps: TaxRefundGap[]; message?: string;
}>> {
  const mode = opts.mode ?? 'fill_missing';
  if (mode !== 'fill_missing' && mode !== 'force') {
    return fail('INVALID_MODE', `mode 必须是 fill_missing | force，收到 ${mode}`, 400);
  }

  const figures = await computeTaxRefundFigures(prisma, declarationId);
  if (!figures) return fail('DECLARATION_NOT_FOUND', `报关单 ${declarationId} 不存在`, 404);

  const existing = await prisma.taxRefund.findFirst({ where: { declarationId, deletedAt: null } });
  if (!existing) {
    return fail('TAX_REFUND_NOT_FOUND', `报关单 ${figures.declarationNumber} 尚无退税申报，请先生成草稿`, 404);
  }
  if (!RECALCULABLE_STATUSES.has(String(existing.status))) {
    return fail(
      'STATUS_NOT_RECALCULABLE',
      `退税单当前状态 ${existing.status} 不允许重算（仅 Draft / Rejected 可重算——已提交的申报数据不可悄悄修改）`,
      409,
    );
  }

  const target: Record<string, unknown> = {
    fxRate: figures.fxRate,
    exportAmountFob: figures.exportAmountFob,
    exportAmountFobCurrency: figures.exportAmountFobCurrency,
    exportAmountCny: figures.exportAmountCny,
    refundableVat: figures.refundableVat,
    refundableRate: figures.refundableRate,
    refundAmount: figures.refundAmount,
    exportDate: figures.exportDate,
  };

  const diff: RecalcDiffEntry[] = [];
  for (const [field, after] of Object.entries(target)) {
    const before = existing[field];
    const beforeStr = before == null ? null : String(before);
    const afterStr = after == null ? null : String(after);
    if (beforeStr !== afterStr) diff.push({ field, before: beforeStr, after: afterStr });
  }

  if (mode === 'force') {
    return ok({ mode, applied: false, diff, figures, gaps: figures.gaps, message: 'force 模式只返回 diff，未落库（确认后再调用 fill_missing 或人工修改）' });
  }

  // fill_missing：只补 null，绝不覆盖已有值
  const patch: Record<string, unknown> = {};
  for (const [field, after] of Object.entries(target)) {
    if (after == null) continue;
    const before = existing[field];
    if (before == null) patch[field] = after;
  }
  if (Object.keys(patch).length === 0) {
    return ok({ mode, applied: false, diff, figures, gaps: figures.gaps, message: '没有可补的空缺字段（已有值一律保留）' });
  }

  const updated = await prisma.taxRefund.update({
    where: { id: existing.id },
    data: { ...patch, updatedAt: BigInt(Date.now()) },
  });

  try {
    const { writeRouteAuditLog } = await import('../audit/routeAudit');
    await writeRouteAuditLog({
      prisma, actorId: opts.actorId || 'api', source: 'route:customs:tax-refund-recalc',
      operation: 'recalc_tax_refund', targetType: 'TaxRefund', targetId: existing.id,
      before: { fxRate: existing.fxRate, refundableVat: existing.refundableVat, refundAmount: existing.refundAmount },
      after: patch,
      ip: opts.ip || null,
    });
  } catch { /* 审计失败不阻断（与既有写法一致） */ }

  return ok({ mode, applied: true, patch, diff, figures: { ...figures, refundAmount: (updated as any)?.refundAmount != null ? Number((updated as any).refundAmount) : figures.refundAmount }, gaps: figures.gaps });
}
