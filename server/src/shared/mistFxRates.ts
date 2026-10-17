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
import { MistCommandError, type MistContext, type MistState } from './mistWorkspace';

export type FxPeriodRate = { id: string; code: string; month: string; currency: string; rate: string; source: string; createdAt: string; actor: string; voided?: { at: string; actor: string; reason: string } };
export type FxRateCommand =
  | { type: 'fxrate.period.save'; payload: { month: string; currency: string; rate: string; source: string } }
  | { type: 'fxrate.period.void'; payload: { id: string; reason: string } };
export const FX_RATE_COMMANDS = ['fxrate.period.save', 'fxrate.period.void'] as const;
export type FxBasis = 'actual' | 'period' | 'quote';
export const FX_BASIS_LABEL: Record<FxBasis, string> = { actual: '实际结汇加权', period: '月末暂估', quote: '定价预计' };

type Root = MistState & { fxPeriodRates?: FxPeriodRate[] };
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
  return fail('未知汇率操作');
}
