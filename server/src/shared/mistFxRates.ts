/**
 * 月末汇率（报表暂估用）与报表折算汇率（2026-10-17 按行业通行做法确定首版）。
 *
 * 外贸公司收入为外币、成本与退税为人民币，管理口径的毛利按人民币看。折算汇率分三种口径，报表上始终写明口径并标识暂估：
 * - 实际结汇：按已登记、未冲回的结汇记录（原币 → 人民币）加权平均，汇率 = Σ 入账本币 ÷ Σ 卖出原币；只有实际发生的结汇。
 * - 月末暂估：财务每月登记一次各币种月末汇率（通常取中国人民银行月末中间价或开户行月末牌价），依据必填；
 *   报表取不晚于所选月份的最新一期。登错的在作废后重登，不改写原记录。
 * - 定价预计：订单最新一次定价试算快照中的汇率（CNY / USD，仅美元订单）。
 * 缺少所选口径的汇率时不猜、不换口径，报表标“缺汇率”。
 */
import { MIST_FINANCE_SCOPES } from './mistFinancePermissions';
import { MistCommandError, isRecognizedMistInvoice, type MistContext, type MistInvoice, type MistState } from './mistWorkspace';
import { platformBusinessDate, platformCreditAppliedMinor } from './mistPlatform';

export type FxPeriodRate = { id: string; code: string; month: string; currency: string; rate: string; source: string; createdAt: string; actor: string; voided?: { at: string; actor: string; reason: string } };
export type FxRateCommand =
  | { type: 'fxrate.period.save'; payload: { month: string; currency: string; rate: string; source: string } }
  | { type: 'fxrate.period.void'; payload: { id: string; reason: string } }
  | { type: 'fxrate.reval.post'; payload: { month: string; note?: string } }
  | { type: 'fxrate.reval.void'; payload: { id: string; reason: string } };
export const FX_RATE_COMMANDS = ['fxrate.period.save', 'fxrate.period.void', 'fxrate.reval.post', 'fxrate.reval.void'] as const;
/**
 * 期末调汇（汇兑损益，2026-10-18 按《企业会计准则第 19 号——外币折算》与国内中小外贸企业通行做法确定首版）：
 * - 记账汇率：当月外币业务按“月初汇率”（= 上月末登记的月末汇率）折算入账；
 * - 月末调汇：外币货币性项目（外币银行存款、外币应收、待核销到账）按本月末汇率重估，
 *   因上月已调到上月末汇率、当月发生额也按该汇率入账，调汇额 = 月末外币余额 × (本月末汇率 − 上月末汇率)；
 * - 结汇损益（已实现）：当月结汇实际入账人民币 − 卖出外币 × 记账汇率。
 * 余额一律按月末截止：银行按流水日期；应收按开票日期，核销按到账日期计入；作废、待财务确认、已驳回的应收不计。
 * 外币应付（境外供应商）暂不纳入：本系统供应商结算为人民币。
 * 调汇须按月连续登记（首次除外），作废只能从最近一期倒着作废；登记后冻结明细，作为外部账务的期末调汇凭证依据。
 */
export type FxRevalLineKind = 'bank' | 'receivable' | 'unapplied' | 'settlement';
export const FX_REVAL_KIND_LABEL: Record<FxRevalLineKind, string> = { bank: '外币银行存款', receivable: '外币应收', unapplied: '待核销到账', settlement: '当月结汇' };
export type FxRevalLine = { kind: FxRevalLineKind; refId: string; ref: string; currency: string; amount: number; bookRate: string; closingRate: string; bookCny: number; closingCny: number; diff: number };
export type FxRevalCurrency = { currency: string; bookRate: string; closingRate: string; unrealized: number; realized: number; total: number };
export type FxRevaluation = { id: string; code: string; month: string; monthEnd: string; lines: FxRevalLine[]; currencies: FxRevalCurrency[]; unrealized: number; realized: number; total: number; note: string; createdAt: string; actor: string; voided?: { at: string; actor: string; reason: string } };
export type FxRevalPreview = { month: string; monthEnd: string; lines: FxRevalLine[]; currencies: FxRevalCurrency[]; unrealized: number; realized: number; total: number; missing: string[]; blockers: string[] };
export type FxBasis = 'actual' | 'period' | 'quote';
export const FX_BASIS_LABEL: Record<FxBasis, string> = { actual: '实际结汇加权', period: '月末暂估', quote: '定价预计' };

type Root = MistState & { fxPeriodRates?: FxPeriodRate[]; fxRevaluations?: FxRevaluation[] };
function fail(message: string, code = 'VALIDATION'): never { throw new MistCommandError(code, message); }
const text = (value: unknown, label: string, max = 500) => {
  if (typeof value !== 'string' || !value.trim()) fail(label + '未填写');
  if (value.length > max) fail(label + '过长');
  return value.trim();
};

export const fxCommandPermission = (command: FxRateCommand) => (FX_RATE_COMMANDS as readonly string[]).includes(command.type) ? MIST_FINANCE_SCOPES.voucher : fail('未知汇率操作');
export const readFxPeriodRates = (root: Pick<Root, 'fxPeriodRates'>) => root.fxPeriodRates || [];

/** 不晚于 month（YYYY-MM）的最新一期有效月末汇率。 */
export function fxPeriodRateFor(root: Pick<Root, 'fxPeriodRates'>, currency: string, month: string): FxPeriodRate | undefined {
  return readFxPeriodRates(root).filter(r => !r.voided && r.currency === currency && r.month <= month).sort((a, b) => b.month.localeCompare(a.month))[0];
}
/** 实际结汇加权平均：未冲回的结汇（原币 → CNY）；可限定截止日期。 */
export function fxSettledAverage(root: Pick<MistState, 'fxRecords'>, currency: string, upTo = '') {
  const rows = (root.fxRecords || []).filter(r => r.kind === 'settlement' && !r.reversed && r.currency === currency && r.localCurrency === 'CNY' && (!upTo || r.date <= upTo));
  const amount = rows.reduce((n, r) => n + Math.round(r.amount * 100), 0), local = rows.reduce((n, r) => n + Math.round(r.localAmount * 100), 0);
  return amount > 0 ? { rate: local / amount, count: rows.length, amount: amount / 100 } : undefined;
}
export type FxResolved = { rate: number; label: string; estimated: boolean };
/** 按口径取折算到人民币的汇率；人民币恒为 1。 */
export function fxRateFor(root: Root, currency: string, basis: FxBasis, opts: { month: string; asOf: string; orderId?: string }): FxResolved | undefined {
  if (currency === 'CNY') return { rate: 1, label: '人民币', estimated: false };
  if (basis === 'actual') { const a = fxSettledAverage(root, currency, opts.asOf); return a && { rate: a.rate, label: `${a.count} 笔结汇加权 ${a.rate.toFixed(4)}`, estimated: false }; }
  if (basis === 'period') { const p = fxPeriodRateFor(root, currency, opts.month); return p && { rate: Number(p.rate), label: `${p.month} 月末 ${p.rate}`, estimated: true }; }
  if (currency !== 'USD' || !opts.orderId) return undefined;
  const snap = (root.platform?.pricing || []).filter(r => r.orderId === opts.orderId && r.exchangeRate > 0).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return snap && { rate: snap.exchangeRate, label: `定价试算 ${snap.exchangeRate}`, estimated: true };
}

export const readFxRevaluations = (root: Pick<Root, 'fxRevaluations'>) => root.fxRevaluations || [];
const monthEndOf = (month: string) => { const [y, m] = month.split('-').map(Number); return month + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0'); };
export const fxPrevMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const nextMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
/** 外币（分）× 汇率字符串 → 人民币（分），按绝对值四舍五入，保留符号。 */
export function fxCnyMinor(amountMinor: number, rate: string): number {
  const [w, f = ''] = rate.split('.'), scaled = BigInt(w) * BigInt(1000000) + BigInt(f.padEnd(6, '0').slice(0, 6)), abs = BigInt(Math.abs(amountMinor));
  const out = Number((abs * scaled + BigInt(500000)) / BigInt(1000000));
  return amountMinor < 0 ? -out : out;
}
/** 应收的开票日期（业务日，YYYY-MM-DD）：票据自带开票日，否则取来源 CI 的签发时间；都没有视为早于任何月份。 */
export function mistInvoiceDate(root: MistState, invoice: Pick<MistInvoice, 'issuedAt' | 'sourceDocumentId'>): string {
  if (invoice.issuedAt) return invoice.issuedAt.slice(0, 10);
  const doc = invoice.sourceDocumentId ? (root as any).fulfillment?.documents?.find((d: { id: string }) => d.id === invoice.sourceDocumentId) : undefined;
  return typeof doc?.issuedAt === 'string' ? doc.issuedAt.slice(0, 10) : '';
}
/** 截至月末的外币货币性项目与当月结汇，按“月初汇率记账、月末调汇”计算汇兑损益（不改动任何数据）。 */
export function fxRevaluationPreview(root: Root, month: string, today: string): FxRevalPreview {
  const monthEnd = monthEndOf(month), monthStart = month + '-01', prev = fxPrevMonth(month), blockers: string[] = [], missing: string[] = [];
  const minor = (v: number) => Math.round(Number(v) * 100), cur = (c: string) => (c || '').toUpperCase();
  const raw: Array<Omit<FxRevalLine, 'bookRate' | 'closingRate' | 'bookCny' | 'closingCny' | 'diff'> & { localMinor?: number; dealRate?: string }> = [];
  const receipts = root.receipts || [], receiptDate = new Map(receipts.map(r => [r.id, r.date]));
  const settlements = (root.fxRecords || []).filter(r => r.kind === 'settlement' && !r.reversed);
  for (const a of root.bankAccounts || []) {
    if (cur(a.currency) === 'CNY' || a.openingDate > monthEnd) continue;
    const inRange = (d: string) => d >= a.openingDate && d <= monthEnd;
    const bal = minor(a.openingBalance) + receipts.filter(r => r.accountId === a.id && inRange(r.date)).reduce((n, r) => n + minor(r.amount), 0)
      - (root.payments || []).filter(x => x.accountId === a.id && inRange(x.date)).reduce((n, x) => n + minor(x.amount), 0)
      + settlements.filter(r => r.toAccountId === a.id && inRange(r.date)).reduce((n, r) => n + minor(r.localAmount), 0)
      - settlements.filter(r => r.fromAccountId === a.id && inRange(r.date)).reduce((n, r) => n + minor(r.amount), 0);
    if (bal) raw.push({ kind: 'bank', refId: a.id, ref: `${a.code} · ${a.name}`, currency: cur(a.currency), amount: bal / 100 });
  }
  const invoiceIssued = new Map<string, boolean>();
  for (const inv of root.invoices || []) {
    const issued = isRecognizedMistInvoice(inv) && mistInvoiceDate(root, inv) <= monthEnd; invoiceIssued.set(inv.id, issued);
    if (!issued || cur(inv.currency) === 'CNY') continue;
    const paid = (root.allocations || []).filter(x => x.invoiceId === inv.id && (receiptDate.get(x.receiptId) || '') <= monthEnd).reduce((n, x) => n + minor(x.amount), 0);
    const open = Math.max(0, minor(inv.amount) - paid - platformCreditAppliedMinor(root as any, inv.id));
    if (open) raw.push({ kind: 'receivable', refId: inv.id, ref: `${inv.code} · ${inv.customer}`, currency: cur(inv.currency), amount: open / 100 });
  }
  for (const r of receipts) {
    if (cur(r.currency) === 'CNY' || r.date > monthEnd) continue;
    const applied = (root.allocations || []).filter(x => x.receiptId === r.id && invoiceIssued.get(x.invoiceId)).reduce((n, x) => n + minor(x.amount), 0);
    const left = minor(r.amount) - applied;
    if (left > 0) raw.push({ kind: 'unapplied', refId: r.id, ref: `${r.code} · ${r.payer}`, currency: cur(r.currency), amount: -left / 100 });
  }
  for (const r of settlements) if (cur(r.currency) !== 'CNY' && cur(r.localCurrency) === 'CNY' && r.date >= monthStart && r.date <= monthEnd)
    raw.push({ kind: 'settlement', refId: r.id, ref: `${r.code} · ${r.date}`, currency: cur(r.currency), amount: r.amount, localMinor: minor(r.localAmount), dealRate: r.rate });
  const currencies = [...new Set(raw.map(l => l.currency))].sort();
  const rates = new Map<string, { book?: FxPeriodRate; closing?: FxPeriodRate }>();
  for (const c of currencies) {
    const book = readFxPeriodRates(root).find(r => !r.voided && r.currency === c && r.month === prev), closing = readFxPeriodRates(root).find(r => !r.voided && r.currency === c && r.month === month);
    if (!book) missing.push(`${prev} ${c} 月末汇率（本月记账汇率）`);
    if (!closing && raw.some(l => l.currency === c && l.kind !== 'settlement')) missing.push(`${month} ${c} 月末汇率`);
    rates.set(c, { book, closing });
  }
  const lines: FxRevalLine[] = [];
  for (const l of raw) {
    const r = rates.get(l.currency)!; if (!r.book || (l.kind !== 'settlement' && !r.closing)) continue;
    const am = minor(l.amount), bookCny = fxCnyMinor(am, r.book.rate);
    const closingCny = l.kind === 'settlement' ? l.localMinor! : fxCnyMinor(am, r.closing!.rate);
    // 结汇：卖出外币按记账汇率转出，实际入账人民币与之差为已实现损益。
    lines.push({ kind: l.kind, refId: l.refId, ref: l.ref, currency: l.currency, amount: l.amount, bookRate: r.book.rate, closingRate: l.kind === 'settlement' ? l.dealRate! : r.closing!.rate, bookCny: bookCny / 100, closingCny: closingCny / 100, diff: (closingCny - bookCny) / 100 });
  }
  const sum = (xs: FxRevalLine[]) => xs.reduce((n, l) => n + minor(l.diff), 0) / 100;
  const byCur: FxRevalCurrency[] = currencies.filter(c => rates.get(c)?.book).map(c => { const ls = lines.filter(l => l.currency === c), unrealized = sum(ls.filter(l => l.kind !== 'settlement')), realized = sum(ls.filter(l => l.kind === 'settlement')); return { currency: c, bookRate: rates.get(c)!.book!.rate, closingRate: rates.get(c)!.closing?.rate || '', unrealized, realized, total: (minor(unrealized) + minor(realized)) / 100 }; });
  if (month > today.slice(0, 7) || (month === today.slice(0, 7) && today.slice(0, 10) < monthEnd)) blockers.push(`${month} 尚未到月末，月末调汇须在月末最后一天或之后登记`);
  const live = readFxRevaluations(root).filter(r => !r.voided).sort((a, b) => b.month.localeCompare(a.month));
  if (live.some(r => r.month === month)) blockers.push(`${month} 已登记期末调汇；如需重算请先作废原记录`);
  else if (live[0] && live[0].month > month) blockers.push(`已登记 ${live[0].month} 期末调汇，不能回头登记更早月份；请先倒序作废后续月份`);
  else if (live[0] && nextMonth(live[0].month) !== month) blockers.push(`期末调汇须按月连续登记：上一期为 ${live[0].month}，本次应登记 ${nextMonth(live[0].month)}`);
  if (missing.length) blockers.push('缺少汇率：' + missing.join('、'));
  if (!raw.length) blockers.push(`${month} 没有外币余额或结汇，无需调汇`);
  const unrealized = sum(lines.filter(l => l.kind !== 'settlement')), realized = sum(lines.filter(l => l.kind === 'settlement'));
  return { month, monthEnd, lines, currencies: byCur, unrealized, realized, total: (minor(unrealized) + minor(realized)) / 100, missing, blockers };
}

export function applyFxRateCommand(root: Root, command: FxRateCommand, c: MistContext): { id: string } {
  const list = root.fxPeriodRates ||= [];
  const p = command.payload as Record<string, unknown>;
  if (command.type === 'fxrate.period.save') {
    const month = text(p.month, '月份', 7); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('月份格式应为 YYYY-MM');
    if (month > c.now.slice(0, 7)) fail('不能登记未来月份的月末汇率');
    const currency = text(p.currency, '币种', 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) fail('币种无效'); if (currency === 'CNY') fail('人民币不需要登记汇率');
    const rate = text(p.rate, '汇率', 20); if (!/^\d{1,6}(\.\d{1,6})?$/.test(rate) || !(Number(rate) > 0)) fail('汇率须为正数，最多 6 位小数（1 单位外币兑人民币）');
    const source = text(p.source, '汇率依据');
    if (list.some(r => !r.voided && r.month === month && r.currency === currency)) fail(`${month} ${currency} 已登记月末汇率；如有误请先作废原记录`, 'CONFLICT');
    const head = 'FXM-' + c.now.slice(0, 4) + '-'; let n = list.filter(r => r.code.startsWith(head)).length + 1; while (list.some(r => r.code === head + String(n).padStart(4, '0'))) n++;
    const id = c.id();
    list.push({ id, code: head + String(n).padStart(4, '0'), month, currency, rate, source, createdAt: c.now, actor: c.actorName });
    root.events.unshift({ id: c.id(), entityType: 'finance', entityId: id, actor: c.actorName, at: c.now, text: `登记 ${month} ${currency} 月末汇率 ${rate}（${source}）`, fileIds: [] });
    return { id };
  }
  if (command.type === 'fxrate.period.void') {
    const r = list.find(x => x.id === p.id) || fail('月末汇率记录不存在', 'NOT_FOUND');
    if (r.voided) fail('该记录已作废', 'PRECONDITION');
    r.voided = { at: c.now, actor: c.actorName, reason: text(p.reason, '作废原因') };
    root.events.unshift({ id: c.id(), entityType: 'finance', entityId: r.id, actor: c.actorName, at: c.now, text: `作废 ${r.month} ${r.currency} 月末汇率 ${r.rate}`, fileIds: [] });
    return { id: r.id };
  }
  if (command.type === 'fxrate.reval.post') {
    const month = text(p.month, '月份', 7); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('月份格式应为 YYYY-MM');
    const note = typeof p.note === 'string' ? p.note.trim().slice(0, 500) : '';
    const today = platformBusinessDate(c.now), view = fxRevaluationPreview(root, month, today);
    if (view.blockers.length) fail(view.blockers[0], view.blockers[0].includes('已登记') ? 'CONFLICT' : 'PRECONDITION');
    const all = root.fxRevaluations ||= [], head = 'FXR-' + month.slice(0, 4) + '-';
    let n = all.filter(r => r.code.startsWith(head)).length + 1; while (all.some(r => r.code === head + String(n).padStart(4, '0'))) n++;
    const id = c.id();
    all.push({ id, code: head + String(n).padStart(4, '0'), month, monthEnd: view.monthEnd, lines: view.lines, currencies: view.currencies, unrealized: view.unrealized, realized: view.realized, total: view.total, note, createdAt: c.now, actor: c.actorName });
    const sign = (v: number) => (v >= 0 ? '收益 ' : '损失 ') + Math.abs(v).toFixed(2);
    root.events.unshift({ id: c.id(), entityType: 'finance', entityId: id, actor: c.actorName, at: c.now, text: `登记 ${month} 期末调汇：未实现${sign(view.unrealized)}、结汇${sign(view.realized)}（人民币）`, fileIds: [] });
    return { id };
  }
  if (command.type === 'fxrate.reval.void') {
    const all = readFxRevaluations(root), r = all.find(x => x.id === p.id) || fail('期末调汇记录不存在', 'NOT_FOUND');
    if (r.voided) fail('该记录已作废', 'PRECONDITION');
    const later = all.find(x => !x.voided && x.month > r.month); if (later) fail(`请先作废后续月份 ${later.month} 的期末调汇`, 'PRECONDITION');
    r.voided = { at: c.now, actor: c.actorName, reason: text(p.reason, '作废原因') };
    root.events.unshift({ id: c.id(), entityType: 'finance', entityId: r.id, actor: c.actorName, at: c.now, text: `作废 ${r.month} 期末调汇 ${r.code}`, fileIds: [] });
    return { id: r.id };
  }
  return fail('未知汇率操作');
}
