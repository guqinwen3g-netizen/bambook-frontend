/** Read-only exact quotation evidence. Matching identifiers is not semantic similarity or a market price. */
import type { MistState } from "../../../../../server/src/shared/mistWorkspace";
import type {
  MarketQuotation,
  MarketQuoteLine,
} from "../../../../../server/src/shared/mistMarket";
import { activeQuoteCostSnapshots } from "../../../../../server/src/shared/mistQuotationCosting";
import { developmentDomain } from "../../../../../server/src/shared/mistDevelopmentDomain";
export type HistoryRow = {
  key: string;
  quote: MarketQuotation;
  line: MarketQuoteLine;
};
export type HistoryFilter = {
  source: "same" | "all";
  customer: "same" | "all";
  base: "same" | "all";
  query: string;
};
export type HistoryFact = {
  label: string;
  current: string;
  historical: string;
  result: "一致" | "不同" | "待核对";
};
const text = (v: string | undefined) => v?.trim() || "";
const number = (v: string, places: number) =>
  new RegExp("^\\d{1,10}(?:\\.\\d{1," + places + "})?$").test(v) &&
  Number(v) > 0;
export function historyDomain(state: MistState, line: MarketQuoteLine): string {
  const product = state.market.products.find((x) => x.id === line.productId);
  if (product) return product.category;
  const dev = state.devs.find((x) => x.id === line.sourceDevId);
  return dev ? developmentDomain(dev.values) : "";
}
export function sameHistorySource(
  a: MarketQuoteLine,
  b: MarketQuoteLine,
): boolean {
  if (a.productId || b.productId)
    return !!a.productId && a.productId === b.productId;
  return !!a.sourceDevId && a.sourceDevId === b.sourceDevId;
}
export function historyBase(
  a: MarketQuotation,
  al: MarketQuoteLine,
  b: MarketQuotation,
  bl: MarketQuoteLine,
) {
  return (
    !!text(a.currency) &&
    a.currency === b.currency &&
    !!text(al.unit) &&
    al.unit === bl.unit &&
    number(al.price, 2) &&
    number(bl.price, 2) &&
    number(al.qty, 4) &&
    number(bl.qty, 4)
  );
}
export function quotationHistoryRows(
  state: MistState,
  q: MarketQuotation,
  line: MarketQuoteLine,
  filter: HistoryFilter,
): HistoryRow[] {
  const needle = filter.query.trim().toLowerCase();
  return state.market.quotations
    .filter(
      (x) =>
        x.id !== q.id &&
        ["Sent", "Accepted", "Rejected", "Expired"].includes(x.status),
    )
    .flatMap((quote) =>
      quote.lines.map((l) => ({
        key: JSON.stringify([quote.id, l.id]),
        quote,
        line: l,
      })),
    )
    .filter(
      (r) =>
        (filter.source === "all" || sameHistorySource(line, r.line)) &&
        (filter.customer === "all" || r.quote.customerId === q.customerId) &&
        (filter.base === "all" || historyBase(q, line, r.quote, r.line)) &&
        (!needle ||
          [
            r.quote.code,
            state.customers.find((x) => x.id === r.quote.customerId)?.name ||
              "",
            r.line.name,
            r.line.style,
            r.line.specification,
            r.quote.deliveryTerms,
            r.quote.paymentTerms,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle)),
    )
    .sort((a, b) => {
      const at = Date.parse(a.quote.createdAt) || 0,
        bt = Date.parse(b.quote.createdAt) || 0;
      return (
        bt - at ||
        a.quote.code.localeCompare(b.quote.code) ||
        a.line.id.localeCompare(b.line.id)
      );
    });
}
export function quotationHistoryFacts(
  state: MistState,
  q: MarketQuotation,
  line: MarketQuoteLine,
  r: HistoryRow,
): HistoryFact[] {
  const other = r.quote,
    l = r.line;
  const fact = (
    label: string,
    a: string,
    b: string,
    result?: HistoryFact["result"],
  ): HistoryFact => ({
    label,
    current: a || "未记录",
    historical: b || "未记录",
    result:
      result ||
      (!text(a) || !text(b) ? "待核对" : text(a) === text(b) ? "一致" : "不同"),
  });
  const numeric = (label: string, a: string, b: string, places: number) =>
    fact(
      label,
      a,
      b,
      !number(a, places) || !number(b, places)
        ? "待核对"
        : Number(a) === Number(b)
          ? "一致"
          : "不同",
    );
  return [
    fact("客户身份", q.customerId, other.customerId),
    fact(
      "来源标识",
      line.productId || line.sourceDevId,
      l.productId || l.sourceDevId,
      (!line.productId && !line.sourceDevId) || (!l.productId && !l.sourceDevId)
        ? "待核对"
        : sameHistorySource(line, l)
          ? "一致"
          : "不同",
    ),
    fact("业务类别", historyDomain(state, line), historyDomain(state, l)),
    fact("准确开发版本", line.sourceVersionId, l.sourceVersionId),
    fact("款号 / 编码", line.style, l.style),
    fact("规格原文", line.specification, l.specification),
    fact("币种", q.currency, other.currency),
    fact("计价单位", line.unit, l.unit),
    numeric("数量", line.qty, l.qty, 4),
    fact("贸易条件原文", q.deliveryTerms, other.deliveryTerms),
    fact("付款条件原文", q.paymentTerms, other.paymentTerms),
    fact("季节", q.season, other.season),
    fact("有效期", q.validUntil, other.validUntil),
  ];
}
export function historyCost(q: MarketQuotation, line: MarketQuoteLine) {
  return activeQuoteCostSnapshots(q).find((x) => x.lineId === line.id);
}
export function currentHistoryFeedback(
  q: MarketQuotation,
  line: MarketQuoteLine,
) {
  const replaced = new Set(
    (q.feedback || []).map((x) => x.input.correctionOfId).filter(Boolean),
  );
  return (q.feedback || []).filter(
    (x) =>
      !replaced.has(x.id) &&
      (!x.input.lines.length ||
        x.input.lines.some((l) => l.lineId === line.id)),
  );
}
export function historyExport(
  state: MistState,
  q: MarketQuotation,
  line: MarketQuoteLine,
  r: HistoryRow,
) {
  const rows: unknown[][] = [
    ["准确报价 ID", q.id, r.quote.id, "不同对象"],
    ["准确条目 ID", line.id, r.line.id, "不同对象"],
    ["报价版本", q.code, r.quote.code, "人工对照"],
    ["主线状态", q.status, r.quote.status, "不推定成交"],
    [
      "已转订单 ID",
      q.convertedOrderId || "",
      r.quote.convertedOrderId || "",
      "转单不等于履约或利润",
    ],
    [
      "原报价单价",
      line.price + " " + q.currency + "/" + line.unit,
      r.line.price + " " + r.quote.currency + "/" + r.line.unit,
      "不换算、不取均价",
    ],
    ...quotationHistoryFacts(state, q, line, r).map((f) => [
      f.label,
      f.current,
      f.historical,
      f.result,
    ]),
  ];
  for (const [name, quote, l] of [
    ["本次", q, line],
    ["历史", r.quote, r.line],
  ] as const) {
    const c = historyCost(quote, l);
    rows.push([
      name + "适用核算快照",
      c?.id || "未记录",
      c?.modelVersion || "",
      c ? c.input.basis : "条目成本不是实际成本确认",
    ]);
    for (const f of currentHistoryFeedback(quote, l))
      rows.push([
        name + "当前反馈",
        f.id,
        f.input.kind,
        JSON.stringify({
          reasonOrigin: f.input.reasonOrigin,
          reasons: f.input.reasons,
          evidence: f.input.evidence,
          receivedOn: f.input.receivedOn,
          lines: f.input.lines,
          requestedTerms: f.input.requestedTerms,
          correctionOfId: f.input.correctionOfId,
        }),
      ]);
  }
  return rows;
}
