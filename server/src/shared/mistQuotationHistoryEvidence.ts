/** Manual historical evidence, not a pricing engine. Source facts are resolved by the server. */
import type { MistState } from "./mistWorkspace";
import type { MarketQuotation, MarketQuoteLine } from "./mistMarket";
import {
  activeQuoteCostSnapshots,
  quoteCostDecimal,
} from "./mistQuotationCosting";
export const QUOTE_HISTORY_EVIDENCE_VERSION = "quote-history-evidence-v1";
export type QuoteHistoryReference = {
  quotationId: string;
  lineId: string;
  expectedSource: string;
  reason: string;
  confirmed: boolean;
};
export function quotationHistorySource(
  state: MistState,
  quote: MarketQuotation,
  line: MarketQuoteLine,
) {
  const replaced = new Set(
    (quote.feedback || []).map((f) => f.input.correctionOfId).filter(Boolean),
  );
  const cost = activeQuoteCostSnapshots(quote).find(
    (c) => c.lineId === line.id,
  );
  return {
    quotationId: quote.id,
    lineId: line.id,
    quoteCode: quote.code,
    revision: quote.revision || 1,
    rootId: quote.rootId || "",
    previousId: quote.previousId || "",
    customerId: quote.customerId,
    customerNameAtCapture:
      state.customers.find((c) => c.id === quote.customerId)?.name || "",
    createdAt: quote.createdAt,
    status: quote.status,
    convertedOrderId: quote.convertedOrderId,
    currency: quote.currency,
    season: quote.season,
    validUntil: quote.validUntil,
    deliveryTerms: quote.deliveryTerms,
    paymentTerms: quote.paymentTerms,
    deliveryEvidence: quote.deliveryEvidence,
    responseEvidence: quote.responseEvidence,
    line: { ...line },
    costing: cost
      ? {
          id: cost.id,
          modelVersion: cost.modelVersion,
          cost: cost.result.cost,
          basis: cost.input.basis,
          strategyBasis: cost.input.strategyBasis,
        }
      : null,
    feedback: (quote.feedback || []).filter(
      (f) =>
        !replaced.has(f.id) &&
        (!f.input.lines.length ||
          f.input.lines.some((l) => l.lineId === line.id)),
    ),
  };
}
export type QuoteHistoryEvidence = {
  version: typeof QUOTE_HISTORY_EVIDENCE_VERSION;
  reason: string;
  source: ReturnType<typeof quotationHistorySource>;
};
export function freezeQuotationHistoryEvidence(
  state: MistState,
  target: MarketQuotation,
  line: MarketQuoteLine,
  raw: QuoteHistoryReference | undefined,
): QuoteHistoryEvidence | undefined {
  if (raw === undefined) return undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.confirmed !== true ||
    typeof raw.reason !== "string" ||
    !raw.reason.trim() ||
    raw.reason.length > 4000
  )
    throw Error("请确认历史条件并填写本次采用理由与差异处理");
  const quote = state.market.quotations.find((q) => q.id === raw.quotationId);
  const historical = quote?.lines.find((l) => l.id === raw.lineId);
  if (
    !quote ||
    !historical ||
    quote.id === target.id ||
    quote.approval?.status === "pending" ||
    !["Sent", "Accepted", "Rejected", "Expired"].includes(quote.status)
  )
    throw Error("历史依据须为本空间另一份已对客报价的准确条目");
  if (
    !target.currency ||
    target.currency !== quote.currency ||
    !line.unit ||
    line.unit !== historical.unit
  )
    throw Error("本轮历史依据仅支持同币种同计价单位，不自动换算");
  if (
    quoteCostDecimal(historical.price, "历史报价单价", 2) <= BigInt(0) ||
    quoteCostDecimal(historical.qty, "历史报价数量") <= BigInt(0)
  )
    throw Error("历史报价单价与数量必须有效且大于0");
  const source = quotationHistorySource(state, quote, historical);
  if (
    typeof raw.expectedSource !== "string" ||
    raw.expectedSource !== JSON.stringify(source)
  )
    throw Error("历史报价条件或反馈已变化，请重新选择并核对历史依据");
  return JSON.parse(
    JSON.stringify({
      version: QUOTE_HISTORY_EVIDENCE_VERSION,
      reason: raw.reason.trim(),
      source,
    }),
  );
}
