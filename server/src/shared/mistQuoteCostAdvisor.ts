/** Structured advisory only. Model text is untrusted; all prices are calculator outputs. */
import type { QuoteCostInput, QuoteCostResult } from "./mistQuotationCosting";
import type { QuoteHistoryReference } from "./mistQuotationHistoryEvidence";
export const QUOTE_COST_ADVISOR_POLICY = "quote-cost-advisor-v1";
export type QuoteCostAdvisorRequest = {
  quotationId: string;
  lineId: string;
  expectedTarget: string;
  expectedRevision: number;
  consent: true;
  input: QuoteCostInput;
  historyReference?: QuoteHistoryReference;
};
export type QuoteCostAdvice = {
  summary: string;
  risks: string[];
  questions: string[];
  evidenceIds: string[];
  strategy: null | {
    method: "markup" | "margin";
    targetPercent: string;
    reason: string;
  };
};
export type QuoteCostAdvisorResponse = {
  policyVersion: typeof QUOTE_COST_ADVISOR_POLICY;
  mode: "read_only";
  revision: number;
  expectedTarget: string;
  advice: QuoteCostAdvice;
  cost: string;
  scenario: QuoteCostResult | null;
  sources: Array<{ id: string; label: string }>;
};
export function parseQuoteCostAdvice(
  raw: unknown,
  sourceIds: string[],
): QuoteCostAdvice {
  const obj = (x: any) => x && typeof x === "object" && !Array.isArray(x);
  const exact = (x: any, keys: string[]) =>
    obj(x) &&
    Object.keys(x).length === keys.length &&
    Object.keys(x).every((k) => keys.includes(k));
  const text = (x: any, max = 1600): x is string =>
    typeof x === "string" && !!x.trim() && x.length <= max;
  const list = (x: any, max: number) =>
    Array.isArray(x) && x.length <= max && x.every((v) => text(v));
  if (!exact(raw, ["summary", "risks", "questions", "evidenceIds", "strategy"]))
    throw Error("AI 返回结构无效，请重试；未更改报价");
  const x = raw as QuoteCostAdvice;
  if (
    !text(x.summary) ||
    !list(x.risks, 12) ||
    !list(x.questions, 12) ||
    !list(x.evidenceIds, 8) ||
    x.evidenceIds.some((id) => !sourceIds.includes(id))
  )
    throw Error("AI 返回无效内容或未授权来源，请重试；未更改报价");
  if (
    x.strategy !== null &&
    (!exact(x.strategy, ["method", "targetPercent", "reason"]) ||
      !["markup", "margin"].includes(x.strategy.method) ||
      !/^\d{1,3}(?:\.\d{1,4})?$/.test(x.strategy.targetPercent) ||
      !text(x.strategy.reason) ||
      Number(x.strategy.targetPercent) > 100 ||
      (x.strategy.method === "margin" &&
        Number(x.strategy.targetPercent) >= 100))
  )
    throw Error("AI 策略比例无效；未更改报价");
  if (x.strategy && !x.evidenceIds.length)
    throw Error("AI 策略须引用已提供依据；未更改报价");
  return JSON.parse(JSON.stringify(x));
}
