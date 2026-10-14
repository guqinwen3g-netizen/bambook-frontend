/** Customer statements and business interpretation are separate facts, not inferred willingness-to-pay. */
import type { MarketQuotation, MarketQuoteLine } from "./mistMarket";
import { quoteCostDecimal } from "./mistQuotationCosting";
export const QUOTE_FEEDBACK_KINDS = {
  counteroffer: "客户还价 / 条件调整",
  considering: "仍在考虑",
  accepted: "客户表示接受（主线另确认）",
  declined: "客户未接受",
  other: "其他反馈",
} as const;
export const QUOTE_FEEDBACK_REASONS = {
  price: "价格",
  quality: "品质",
  specification: "规格",
  quantity: "数量 / MOQ",
  delivery: "交期",
  payment: "付款条件",
  service: "服务 / 配合",
  project: "项目变化",
  competitor: "其他供应方案",
  other: "其他",
  unknown: "未说明 / 未知",
} as const;
export type QuoteFeedbackKind = keyof typeof QUOTE_FEEDBACK_KINDS;
export type QuoteFeedbackReason = keyof typeof QUOTE_FEEDBACK_REASONS;
export type QuoteFeedbackInput = {
  kind: QuoteFeedbackKind;
  receivedOn: string;
  channel: string;
  contact: string;
  evidence: string;
  reasonOrigin: "customer" | "business" | "unknown";
  reasons: QuoteFeedbackReason[];
  reasonDetail: string;
  nextAction: string;
  followUpOn: string;
  requestedTerms: string;
  lines: Array<{
    lineId: string;
    price: string;
    quantity: string;
    conditions: string;
  }>;
  fileIds: string[];
  correctionOfId: string;
  correctionReason: string;
};
export type QuoteFeedbackRecord = {
  id: string;
  quotationId: string;
  createdAt: string;
  actorId: string;
  actor: string;
  input: QuoteFeedbackInput;
  target: {
    code: string;
    revision: number;
    customerId: string;
    customerName: string;
    status: MarketQuotation["status"];
    convertedOrderId: string | null;
    currency: string;
    total: string;
    validUntil: string;
    deliveryTerms: string;
    paymentTerms: string;
    lines: MarketQuoteLine[];
    costingSnapshotIds: string[];
  };
  files: Array<{ id: string; name: string; size: number; createdAt: string }>;
};
const text = (v: unknown, label: string, optional = false, max = 4000) => {
  if (typeof v !== "string" || v.length > max || (!optional && !v.trim()))
    throw Error("请填写" + label);
  return v.trim();
};
const date = (v: unknown, label: string, optional = false) => {
  const value = text(v, label, optional, 10);
  if (optional && !value) return "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw Error(label + "须为有效日历日期");
  return value;
};
export function quotationFeedbackTarget(q: MarketQuotation) {
  return JSON.stringify([
    q.id,
    q.customerId,
    q.status,
    q.convertedOrderId,
    q.currency,
    q.total,
    q.validUntil,
    q.deliveryTerms,
    q.paymentTerms,
    q.feedback?.length || 0,
    q.lines,
    q.fileIds,
    q.responseEvidence,
  ]);
}
export function validateQuoteFeedback(
  raw: QuoteFeedbackInput,
  q: MarketQuotation,
  today: string,
): QuoteFeedbackInput {
  if (
    !raw ||
    !Object.prototype.hasOwnProperty.call(QUOTE_FEEDBACK_KINDS, raw.kind)
  )
    throw Error("请选择反馈类型");
  const receivedOn = date(raw.receivedOn, "反馈发生日期");
  if (receivedOn > today)
    throw Error("反馈发生日期不能在未来；计划跟进请填写下次跟进日期");
  if (!["customer", "business", "unknown"].includes(raw.reasonOrigin))
    throw Error("请选择原因来源，不将业务判断当作客户原话");
  if (
    !Array.isArray(raw.reasons) ||
    !raw.reasons.length ||
    raw.reasons.some(
      (x) => !Object.prototype.hasOwnProperty.call(QUOTE_FEEDBACK_REASONS, x),
    )
  )
    throw Error("请明确选择原因，未说明时选择未知");
  const reasons = [...new Set(raw.reasons)];
  if (
    (raw.reasonOrigin === "unknown" &&
      (reasons.length !== 1 || reasons[0] !== "unknown")) ||
    (raw.reasonOrigin !== "unknown" && reasons.includes("unknown"))
  )
    throw Error("原因来源与未知标记不一致，不猜测客户原因");
  if (!Array.isArray(raw.lines) || raw.lines.length > q.lines.length)
    throw Error("还价条目格式无效");
  if (raw.kind !== "counteroffer" && (raw.lines.length || raw.requestedTerms))
    throw Error("只有还价 / 条件调整反馈记录拟变更条件");
  const ids = new Set<string>();
  const lines = raw.lines.map((x) => {
    if (!x || !q.lines.some((l) => l.id === x.lineId) || ids.has(x.lineId))
      throw Error("请选择不重复的准确报价条目");
    ids.add(x.lineId);
    const price = text(x.price, "客户提出单价", true, 20),
      quantity = text(x.quantity, "客户提出数量", true, 20);
    if (price && quoteCostDecimal(price, "客户提出单价", 2) <= BigInt(0))
      throw Error("客户提出单价必须大于0");
    if (quantity && quoteCostDecimal(quantity, "客户提出数量", 4) <= BigInt(0))
      throw Error("客户提出数量必须大于0");
    const conditions = text(x.conditions, "条目变更条件", true);
    if (!price && !quantity && !conditions)
      throw Error("还价条目至少填写单价、数量或变更条件之一");
    return { lineId: x.lineId, price, quantity, conditions };
  });
  const requestedTerms = text(raw.requestedTerms, "客户提出整体条件", true);
  if (raw.kind === "counteroffer" && !lines.length && !requestedTerms)
    throw Error("请记录客户提出的准确条目或整体条件，不猜还价");
  if (
    !Array.isArray(raw.fileIds) ||
    raw.fileIds.length > 20 ||
    raw.fileIds.some((x) => typeof x !== "string" || !x)
  )
    throw Error("凭据附件格式无效");
  const correctionOfId = text(raw.correctionOfId, "被更正反馈", true, 100),
    correctionReason = text(raw.correctionReason, "更正原因", !correctionOfId);
  if (
    correctionOfId &&
    (!(q.feedback || []).some((x) => x.id === correctionOfId) ||
      (q.feedback || []).some((x) => x.input.correctionOfId === correctionOfId))
  )
    throw Error("仅可更正本报价尚未被更正的反馈");
  return {
    kind: raw.kind,
    receivedOn,
    channel: text(raw.channel, "反馈渠道"),
    contact: text(raw.contact, "反馈人及身份"),
    evidence: text(raw.evidence, "反馈事实与来源"),
    reasonOrigin: raw.reasonOrigin,
    reasons,
    reasonDetail: text(raw.reasonDetail, "原因说明与已知范围"),
    nextAction: text(raw.nextAction, "下一步动作"),
    followUpOn: date(raw.followUpOn, "下次跟进日期", true),
    requestedTerms,
    lines,
    fileIds: [...new Set(raw.fileIds)],
    correctionOfId,
    correctionReason,
  };
}
