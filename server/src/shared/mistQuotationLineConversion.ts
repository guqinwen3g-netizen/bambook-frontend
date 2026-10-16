/** BB-QUO-5 报价按条目转订单：每个条目记录去向（已转订单 / 不再转），历史整单转单只读兼容为“全部已转”。 */
import type { MarketQuotation, MarketQuoteLine } from './mistMarket';

/** 条目转单去向；只在转单命令中写入，保存报价时不接受客户端传入。 */
export type QuoteLineConversion = { orderId: string; orderCode: string; at: string; by: string; byId: string };
/** 条目标记“不再转”及原因。 */
export type QuoteLineSkip = { reason: string; at: string; by: string; byId: string };

export type QuoteLineConversionStatus =
  | { state: 'pending' }
  | { state: 'converted'; orderId: string; orderCode: string; legacy: boolean }
  | { state: 'skipped'; reason: string; at: string; by: string };

type QuoteLike = Pick<MarketQuotation, 'lines' | 'convertedOrderId'>;
type OrderRef = { id: string; code: string };

/** 历史报价：整单转单指针存在、但没有任何条目级去向，按“全部已转”只读显示。 */
export function quotationLegacyConverted(q: QuoteLike): boolean {
  return !!q.convertedOrderId && !q.lines.some(l => l.conversion || l.skipped);
}

export function quoteLineConversionStatus(q: QuoteLike, line: MarketQuoteLine, orders: OrderRef[] = []): QuoteLineConversionStatus {
  if (line.conversion) return { state: 'converted', orderId: line.conversion.orderId, orderCode: line.conversion.orderCode, legacy: false };
  if (line.skipped) return { state: 'skipped', reason: line.skipped.reason, at: line.skipped.at, by: line.skipped.by };
  if (quotationLegacyConverted(q)) {
    const orderId = q.convertedOrderId!;
    return { state: 'converted', orderId, orderCode: orders.find(o => o.id === orderId)?.code || '', legacy: true };
  }
  return { state: 'pending' };
}

/** 尚未转单、也未标记不再转的条目。 */
export function quotationPendingLines(q: QuoteLike): MarketQuoteLine[] {
  return quotationLegacyConverted(q) ? [] : q.lines.filter(l => !l.conversion && !l.skipped);
}

/** 全部条目已处理（已转或不再转）时报价显示“已转单”。 */
export function quotationConversionComplete(q: QuoteLike): boolean {
  return q.lines.length > 0 && quotationPendingLines(q).length === 0;
}

/** 已有条目转出（含历史整单转单）。 */
export function quotationConversionStarted(q: QuoteLike): boolean {
  return !!q.convertedOrderId || q.lines.some(l => l.conversion);
}

/** 本报价转出的订单（按首次出现顺序去重）。 */
export function quotationConvertedOrders(q: QuoteLike, orders: OrderRef[] = []): OrderRef[] {
  const out: OrderRef[] = [];
  for (const line of q.lines) {
    const s = quoteLineConversionStatus(q, line, orders);
    if (s.state === 'converted' && !out.some(o => o.id === s.orderId)) out.push({ id: s.orderId, code: s.orderCode || orders.find(o => o.id === s.orderId)?.code || '' });
  }
  if (!out.length && q.convertedOrderId) out.push({ id: q.convertedOrderId, code: orders.find(o => o.id === q.convertedOrderId)?.code || '' });
  return out;
}

export function quoteLineConversionText(s: QuoteLineConversionStatus): string {
  if (s.state === 'pending') return '未转';
  if (s.state === 'converted') return `已转（${s.orderCode || '订单不可用'}）`;
  return `不再转：${s.reason}`;
}

/** 条目处理进度，如“已转 2 · 不再转 0 · 未转 1”。 */
export function quotationConversionProgress(q: QuoteLike) {
  let converted = 0, skipped = 0, pending = 0;
  for (const line of q.lines) { const s = quoteLineConversionStatus(q, line); if (s.state === 'converted') converted++; else if (s.state === 'skipped') skipped++; else pending++; }
  return { converted, skipped, pending, text: `已转 ${converted} · 不再转 ${skipped} · 未转 ${pending}` };
}
