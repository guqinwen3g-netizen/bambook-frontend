/** Auditable manual quote costing. No AI prices, FX assumptions or actual-profit recognition. */
import type { MarketQuotation, MarketQuoteLine } from "./mistMarket";
export const QUOTE_COST_MODEL_VERSION = "quote-cost-v1";
export const QUOTE_COST_KINDS = [
  "yarn",
  "weaving",
  "dyeing",
  "finishing",
  "fabric",
  "trimming",
  "cmt",
  "packaging",
  "freight",
  "insurance",
  "bank",
  "commission",
  "other",
] as const;
export type QuoteCostKind = (typeof QUOTE_COST_KINDS)[number];
export type QuoteCostComponent = {
  kind: QuoteCostKind;
  description: string;
  quantity: string;
  unit: string;
  lossPercent: string;
  unitPrice: string;
  basis: string;
  outsideSupplierPrice: boolean;
};
export type QuoteCostInput = {
  mode: "supplier" | "breakdown";
  currency: string;
  unit: string;
  sourceSpecification: string;
  supplierId: string;
  supplierPrice: string;
  sourceDate: string;
  sourceValidUntil: string;
  sourceTerms: string;
  basis: string;
  fileIds: string[];
  components: QuoteCostComponent[];
  method: "markup" | "margin";
  targetPercent: string;
  strategyBasis: string;
  proposedPrice: string;
};
export type QuoteCostResult = {
  cost: string;
  approvalCost: string;
  suggestedPrice: string;
  suggestedQuotePrice: string;
  proposedPrice: string;
  unitDifference: string;
  marginPercent: string | null;
  components: Array<QuoteCostComponent & { amount: string }>;
};
export type QuoteCostSnapshot = {
  /** Server-resolved immutable manual evidence; absent on older snapshots. */
  historyEvidence?: import("./mistQuotationHistoryEvidence").QuoteHistoryEvidence;
  id: string;
  quotationId: string;
  lineId: string;
  modelVersion: string;
  createdAt: string;
  actorId: string;
  actor: string;
  input: QuoteCostInput;
  result: QuoteCostResult;
  appliedPrice: boolean;
  target: {
    customerId: string;
    quoteCode: string;
    currency: string;
    deliveryTerms: string;
    paymentTerms: string;
    validUntil: string;
    line: MarketQuoteLine;
  };
  supplier: { id: string; name: string; code: string } | null;
  files: Array<{ id: string; name: string; createdAt: string; size: number }>;
};
const required = (v: unknown, label: string, max = 4000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw Error("请填写" + label);
  return v.trim();
};
export function quoteCostDecimal(value: unknown, label: string, places = 4) {
  if (
    typeof value !== "string" ||
    !new RegExp("^\\d{1,10}(?:\\.\\d{1," + places + "})?$").test(value.trim())
  )
    throw Error(
      label + "须明确填写非负数字，最多" + places + "位小数，不使用科学计数法",
    );
  const [whole, fraction = ""] = value.trim().split(".");
  return (
    BigInt(whole) * BigInt(10) ** BigInt(places) +
    BigInt(fraction.padEnd(places, "0"))
  );
}
const round = (n: bigint, d: bigint): bigint =>
  n < BigInt(0) ? -round(-n, d) : (n + d / BigInt(2)) / d;
const show = (n: bigint, places = 4) => {
  const sign = n < BigInt(0) ? "-" : "";
  n = n < BigInt(0) ? -n : n;
  return (
    sign +
    (n / BigInt(10) ** BigInt(places)).toString() +
    "." +
    (n % BigInt(10) ** BigInt(places)).toString().padStart(places, "0")
  );
};
const calendar = (v: string, label: string, optional = false) => {
  if (optional && !v) return "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v + "T00:00:00Z")) ||
    new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v
  )
    throw Error(label + "须为有效日历日期");
  return v;
};
export function calculateQuoteCosting(raw: QuoteCostInput): {
  input: QuoteCostInput;
  result: QuoteCostResult;
} {
  if (
    !raw ||
    !["supplier", "breakdown"].includes(raw.mode) ||
    !["markup", "margin"].includes(raw.method)
  )
    throw Error("核算路径或利润方式无效");
  const currency = required(raw.currency, "成本币种", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw Error("币种须为三个英文字母");
  const input: QuoteCostInput = {
    mode: raw.mode,
    method: raw.method,
    currency,
    unit: required(raw.unit, "成本计价单位", 40),
    sourceSpecification: required(raw.sourceSpecification, "适用规格"),
    supplierId:
      raw.mode === "supplier"
        ? required(raw.supplierId, "来源供应商", 100)
        : "",
    supplierPrice:
      raw.mode === "supplier"
        ? show(quoteCostDecimal(raw.supplierPrice, "供应商成品单价"))
        : "0.0000",
    sourceDate: calendar(raw.sourceDate, "来源日期"),
    sourceValidUntil: calendar(raw.sourceValidUntil || "", "来源有效期", true),
    sourceTerms: required(raw.sourceTerms, "来源交付与费用包含条件"),
    basis: required(raw.basis, "成本来源依据"),
    fileIds:
      Array.isArray(raw.fileIds) &&
      raw.fileIds.every((id) => typeof id === "string" && id)
        ? [...new Set(raw.fileIds)]
        : (() => {
            throw Error("凭据附件格式无效");
          })(),
    components: [],
    targetPercent: show(quoteCostDecimal(raw.targetPercent, "目标百分比")),
    strategyBasis: required(raw.strategyBasis, "本次报价策略依据"),
    proposedPrice: show(
      quoteCostDecimal(raw.proposedPrice, "人工拟报价", 2),
      2,
    ),
  };
  if (input.fileIds.length > 20) throw Error("凭据附件不得超过20个");
  if (
    input.mode === "supplier" &&
    quoteCostDecimal(input.supplierPrice, "供应商成品单价") <= BigInt(0)
  )
    throw Error("供应商成品单价必须大于0");
  if (
    !Array.isArray(raw.components) ||
    raw.components.length > 100 ||
    (input.mode === "breakdown" && !raw.components.length)
  )
    throw Error("拆解须有1至100项；供应商路径可不加额外费用");
  let total =
    input.mode === "supplier"
      ? quoteCostDecimal(input.supplierPrice, "供应商成品单价")
      : BigInt(0);
  const components = raw.components.map((r, index) => {
    const prefix = "第" + (index + 1) + "项";
    if (!r || !QUOTE_COST_KINDS.includes(r.kind))
      throw Error(prefix + "费用类型无效");
    if (
      input.mode === "supplier" &&
      (![
        "packaging",
        "freight",
        "insurance",
        "bank",
        "commission",
        "other",
      ].includes(r.kind) ||
        r.outsideSupplierPrice !== true)
    )
      throw Error(
        "供应商路径只可追加明确未包含的费用，不叠加原料 / 面料 / CMT等已包含成本",
      );
    const quantity = quoteCostDecimal(r.quantity, prefix + "用量"),
      loss = quoteCostDecimal(r.lossPercent, prefix + "损耗"),
      price = quoteCostDecimal(r.unitPrice, prefix + "单价");
    if (quantity <= BigInt(0)) throw Error(prefix + "用量必须大于0");
    if (loss > BigInt(1000000)) throw Error("损耗率不得超过100%");
    const amount = round(
      quantity * (BigInt(1000000) + loss) * price,
      BigInt(10000000000),
    );
    total += amount;
    return {
      kind: r.kind,
      description: required(r.description, prefix + "名称"),
      quantity: show(quantity),
      unit: required(r.unit, prefix + "耗用单位", 40),
      lossPercent: show(loss),
      unitPrice: show(price),
      basis: required(r.basis, prefix + "依据"),
      outsideSupplierPrice: input.mode === "supplier",
      amount: show(amount),
    };
  });
  if (total <= BigInt(0)) throw Error("单位参考成本必须大于0");
  input.components = components.map(({ amount, ...r }) => r);
  const rate = quoteCostDecimal(input.targetPercent, "目标百分比");
  if (input.method === "margin" && rate >= BigInt(1000000))
    throw Error("目标销售毛利率须小于100%");
  const suggested =
    input.method === "markup"
      ? round(total * (BigInt(1000000) + rate), BigInt(1000000))
      : round(total * BigInt(1000000), BigInt(1000000) - rate);
  const proposed =
    quoteCostDecimal(input.proposedPrice, "人工拟报价", 2) * BigInt(100);
  const result: QuoteCostResult = {
    cost: show(total),
    approvalCost: show(round(total, BigInt(100)), 2),
    suggestedPrice: show(suggested),
    suggestedQuotePrice: show(round(suggested, BigInt(100)), 2),
    proposedPrice: input.proposedPrice,
    unitDifference: show(proposed - total),
    marginPercent:
      proposed > BigInt(0)
        ? show(round((proposed - total) * BigInt(1000000), proposed))
        : null,
    components,
  };
  if (
    quoteCostDecimal(result.approvalCost, "单位成本", 2) > BigInt(999999999999)
  )
    throw Error("单位成本超出当前报价金额范围");
  if (
    quoteCostDecimal(result.suggestedQuotePrice, "建议报价", 2) >
    BigInt(999999999999)
  )
    throw Error("建议报价超出当前报价金额范围");
  return { input, result };
}
/** Optimistic target guards include all commercial lines, even for same-timestamp edits. */
export function quotationCostingTarget(
  q: MarketQuotation,
  line: MarketQuoteLine,
) {
  return JSON.stringify([
    q.id,
    line.id,
    q.customerId,
    q.currency,
    q.deliveryTerms,
    q.paymentTerms,
    q.validUntil,
    q.status,
    q.approval?.id,
    q.approval?.status,
    q.total,
    q.note,
    q.fileIds,
    q.costingSnapshots?.length || 0,
    q.lines.map((l) => [
      l.id,
      l.productId,
      l.sourceDevId,
      l.sourceVersionId,
      l.name,
      l.style,
      l.specification,
      l.qty,
      l.unit,
      l.price,
      l.cost,
      l.costBasis,
    ]),
  ]);
}

/** Historical snapshots remain immutable; only the last applicable snapshot per live line enters approval. */
export function activeQuoteCostSnapshots(
  q: MarketQuotation,
): QuoteCostSnapshot[] {
  return q.lines.flatMap((line) => {
    const snapshot = (q.costingSnapshots || [])
      .filter((x) => x.lineId === line.id)
      .slice(-1)[0];
    if (!snapshot) return [];
    const t = snapshot.target,
      old = t.line;
    return t.customerId === q.customerId &&
      t.currency === q.currency &&
      t.deliveryTerms === q.deliveryTerms &&
      t.paymentTerms === q.paymentTerms &&
      t.validUntil === q.validUntil &&
      snapshot.input.unit === line.unit &&
      snapshot.input.currency === q.currency &&
      line.cost === snapshot.result.approvalCost &&
      line.price ===
        (snapshot.appliedPrice ? snapshot.result.proposedPrice : old.price) &&
      [
        "productId",
        "sourceDevId",
        "sourceVersionId",
        "name",
        "style",
        "specification",
        "qty",
        "unit",
      ].every(
        (key) =>
          old[key as keyof MarketQuoteLine] ===
          line[key as keyof MarketQuoteLine],
      )
      ? [snapshot]
      : [];
  });
}
