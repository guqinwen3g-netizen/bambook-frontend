/**
 * 开发费用与财务交接、最终结案（BB-DEV-9）。
 * - 制作费：每条实物登记行（样品仓库来源为本案版本）记一笔总额，不拆单价；寄样费：每次寄样一笔（BB-DEV-8 寄样记录）。
 * - 费用汇总 = 全部制作费 + 全部寄样费，按原币种分别合计，不折算；归属需求方（客户或内部需求方）。
 * - 收费案：费用补齐后业务员一次性发起开票 → 财务开票（每个币种一张应收票据，回链本案）→ 收款核销销账后“已最终结案”。
 * - 不收费案：认可即结案，没有开票入口。
 */
import type { MistDev, MistInvoice, MistState } from './mistWorkspace';
import { developmentCharged, developmentInitiator } from './mistDevelopmentDomain';

export type MistMakingFee = { sampleId: string; versionId: string; sampleCode: string; form: string; amount: number; currency: string; recordedAt: string; recordedBy: string };
export type MistBillingLine = { kind: 'making' | 'dispatch'; refId: string; versionId: string; versionLabel: string; label: string; amount: number; currency: string };
export type MistBillingTotal = { currency: string; amount: number };
export type MistBillingRequest = {
  id: string; requestedAt: string; requestedBy: string; billTo: string; lines: MistBillingLine[]; totals: MistBillingTotal[];
  state: 'pending' | 'invoiced'; invoiceIds: string[]; invoicedAt?: string; invoicedBy?: string; taskId?: string;
};
export type MistDevBilling = { makingFees: MistMakingFee[]; request?: MistBillingRequest; settledAt?: string };

const cents = (amount: number) => Math.round(amount * 100);
/** 本案全部入库实物（各版本来源），按登记顺序。 */
export function developmentSamplesOf(state: MistState, dev: MistDev) {
  return (state.fulfillment?.samples || []).filter(sample => sample.source.kind === 'version' && sample.source.devId === dev.id && dev.versionIds.includes(sample.source.versionId));
}
export function developmentBillTo(dev: MistDev): string {
  return developmentInitiator(dev.values) === 'internal' ? (dev.values.requester || '').trim() : (dev.customer || '').trim();
}
export function billingTotals(lines: ReadonlyArray<{ amount: number; currency: string }>): MistBillingTotal[] {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.currency, (totals.get(line.currency) || 0) + cents(line.amount));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, amount: value / 100 }));
}
/** 当前费用明细、按币种合计与未补齐项。 */
export function developmentFeeSummary(state: MistState, dev: MistDev) {
  const lines: MistBillingLine[] = [], missing: string[] = [];
  const label = (versionId: string) => state.versions.find(version => version.id === versionId)?.label || '版本';
  for (const sample of developmentSamplesOf(state, dev)) {
    const versionId = sample.source.kind === 'version' ? sample.source.versionId : '';
    const fee = dev.billing?.makingFees.find(row => row.sampleId === sample.id);
    if (fee) lines.push({ kind: 'making', refId: sample.id, versionId, versionLabel: label(versionId), label: `制作费 · ${sample.form} ${sample.code}`, amount: fee.amount, currency: fee.currency });
    else missing.push(`${label(versionId)} ${sample.form} ${sample.code} 未登记制作费`);
  }
  for (const versionId of dev.versionIds) {
    const version = state.versions.find(row => row.id === versionId);
    for (const dispatch of version?.dispatches || []) {
      if (dispatch.fee) lines.push({ kind: 'dispatch', refId: dispatch.id, versionId, versionLabel: version!.label, label: `寄样费 · ${dispatch.form} ${dispatch.sampleCode} → ${dispatch.recipient}`, amount: dispatch.fee.amount, currency: dispatch.fee.currency });
      else missing.push(`${version!.label} 寄样 ${dispatch.sampleCode} → ${dispatch.recipient} 未登记寄样费`);
    }
  }
  return { lines, totals: billingTotals(lines), missing };
}
export function developmentBillingInvoices(state: MistState, dev: MistDev): MistInvoice[] {
  const ids = dev.billing?.request?.invoiceIds || [];
  return (state.invoices || []).filter(invoice => ids.includes(invoice.id) && invoice.devId === dev.id);
}
/** 收费案：已开票且本案全部有效票据销账为零。 */
export function developmentBillingSettled(state: MistState, dev: MistDev): boolean {
  const request = dev.billing?.request;
  if (!developmentCharged(dev.values) || request?.state !== 'invoiced') return false;
  const invoices = developmentBillingInvoices(state, dev);
  return invoices.length === request.invoiceIds.length && invoices.length > 0 && invoices.every(invoice => !invoice.voidedAt && invoice.open <= 0);
}
export function makingFeeBlocker(state: MistState, dev: MistDev, sampleId: string): string | null {
  if (!developmentCharged(dev.values)) return '不收费开发不登记制作费';
  if (dev.closure?.kind === 'cancelled') return '开发案已取消';
  if (dev.billing?.request) return '已发起开票，费用已锁定';
  if (!developmentSamplesOf(state, dev).some(sample => sample.id === sampleId)) return '请选择本案的准确实物';
  if (dev.billing?.makingFees.some(row => row.sampleId === sampleId)) return '本实物制作费已登记，不能覆盖';
  return null;
}
export function billingRequestBlocker(state: MistState, dev: MistDev): string | null {
  if (!developmentCharged(dev.values)) return '不收费开发认可即结案，不开票';
  if (dev.closure?.kind === 'cancelled') return '开发案已取消';
  if (dev.billing?.request) return '已发起开票';
  if (!developmentBillTo(dev)) return '缺少费用归属的需求方';
  const summary = developmentFeeSummary(state, dev);
  if (summary.missing.length) return `费用尚未补齐：${summary.missing.join('；')}`;
  if (!summary.lines.length) return '尚无可开票费用';
  return null;
}
/** 开发案费用与开票阶段（展示用）。 */
export function developmentBillingStage(state: MistState, dev: MistDev): { label: string; tone: 'neutral' | 'warn' | 'accent' | 'ok' } | null {
  if (!developmentCharged(dev.values)) return null;
  const request = dev.billing?.request;
  if (!request) return { label: '费用登记中', tone: 'neutral' };
  if (request.state === 'pending') return { label: '待财务开票', tone: 'warn' };
  return developmentBillingSettled(state, dev) ? { label: '已最终结案', tone: 'ok' } : { label: '已开票 · 待收款', tone: 'accent' };
}
