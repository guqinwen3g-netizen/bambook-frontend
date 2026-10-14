/** Explicit human-selected reference. Never transfers a historical price or cost into inputs. */
import React from "react";
import {
  Banner,
  Button,
  Checkbox,
  Field,
  KeyValue,
  Mono,
  Select,
  TextArea,
} from "../../../../../components/mist";
import type { MistState } from "../../../../../server/src/shared/mistWorkspace";
import type {
  MarketQuotation,
  MarketQuoteLine,
} from "../../../../../server/src/shared/mistMarket";
import {
  quotationHistorySource,
  QUOTE_HISTORY_EVIDENCE_VERSION,
  type QuoteHistoryReference,
  type QuoteHistoryEvidence,
} from "../../../../../server/src/shared/mistQuotationHistoryEvidence";
import {
  quotationHistoryRows,
  quotationHistoryFacts,
} from "./QuotationHistory";
import { useNav } from "../../nav";
export function FrozenHistoryEvidence({
  evidence,
  preview = false,
}: {
  evidence: QuoteHistoryEvidence;
  preview?: boolean;
}) {
  const { go } = useNav(),
    s = evidence.source;
  return (
    <div className="mist-col">
      <Banner
        title={
          preview
            ? "待核对来源事实 · 尚未保存"
            : "人工确认的历史依据 · 冻结时事实"
        }
      >
        {evidence.version}
        {preview
          ? "；以下为当前读取的来源事实，需人工核对后才能冻结；不是成交或履约结论。客户名称来自当前档案。"
          : "；历史报价不等于成交或履约，采用理由不构成价格审批。客户名称为冻结时档案名称，不追溯推定原始名称。"}
      </Banner>
      <Mono>
        {s.quoteCode} · V{s.revision} · {s.line.style}
      </Mono>
      <KeyValue
        items={[
          { label: "准确来源", value: s.quotationId + " / " + s.lineId },
          {
            label: "客户 / 当时主线状态",
            value: s.customerNameAtCapture + " / " + s.status,
          },
          {
            label: "历史原价 / 数量",
            value:
              s.line.price +
              " " +
              s.currency +
              "/" +
              s.line.unit +
              " · " +
              s.line.qty +
              " " +
              s.line.unit,
          },
          {
            label: "历史规格 / 来源版本",
            value:
              (s.line.specification || "未记录") +
              " / " +
              (s.line.sourceVersionId || "未记录"),
          },
          {
            label: "历史贸易 / 付款条件",
            value: s.deliveryTerms + " / " + s.paymentTerms,
          },
          {
            label: "历史季节 / 有效期",
            value: s.season + " / " + s.validUntil,
          },
          {
            label: "交付登记 / 客户响应依据",
            value:
              (s.deliveryEvidence || "未记录") +
              " / " +
              (s.responseEvidence || "未记录"),
          },
          {
            label: "当时适用核算",
            value: s.costing
              ? s.costing.id +
                " / " +
                s.costing.modelVersion +
                "；参考成本 " +
                s.costing.cost +
                "；" +
                s.costing.basis
              : "未记录适用专业核算，不推定成本",
          },
          {
            label: "当时反馈及更正后事实",
            value: s.feedback.length
              ? s.feedback
                  .map(
                    (f) =>
                      f.id +
                      " · " +
                      f.input.kind +
                      " · " +
                      f.input.receivedOn +
                      " · " +
                      f.input.evidence +
                      "；" +
                      f.input.reasonOrigin +
                      " / " +
                      f.input.reasons.join("、") +
                      "；客户要求 " +
                      f.input.requestedTerms +
                      "；条目条件 " +
                      JSON.stringify(f.input.lines) +
                      "；更正原记录 " +
                      (f.input.correctionOfId || "无"),
                  )
                  .join("；")
              : "未记录结构化反馈，不推断原因",
          },
          { label: "采用理由与差异处理", value: evidence.reason },
        ]}
      />
      {!preview && (
        <div className="mist-row">
          <Button onClick={() => go("quotations", s.quotationId)}>
            查看历史原报价
          </Button>
          <Button
            onClick={() =>
              go("quotations", s.quotationId, { section: "feedback" })
            }
          >
            查看原反馈历史
          </Button>
        </div>
      )}
      {!preview && (
        <span className="mist-note">
          回看入口显示来源的当前事实；来源后来变化不改写这里的冻结证据。完整原文随本核算导出。
        </span>
      )}
    </div>
  );
}
export function QuotationHistoryEvidencePicker({
  state,
  quote,
  line,
  value,
  onChange,
  disabled,
}: {
  state: MistState;
  quote: MarketQuotation;
  line: MarketQuoteLine;
  value: QuoteHistoryReference | undefined;
  onChange: (value: QuoteHistoryReference | undefined) => void;
  disabled: boolean;
}) {
  const rows = quotationHistoryRows(state, quote, line, {
    source: "all",
    customer: "all",
    base: "same",
    query: "",
  });
  const selected = rows.find(
    (r) => r.quote.id === value?.quotationId && r.line.id === value.lineId,
  );
  const stale =
    !!value &&
    (!selected ||
      value.expectedSource !==
        JSON.stringify(
          quotationHistorySource(state, selected.quote, selected.line),
        ));
  return (
    <div className="mist-col">
      <Banner title="可选：人工选取历史报价依据">
        只列本空间另一份已对客报价的同币种、同单位条目，可包含其他客户或产品；不代表专业可比。先看条件对照，再写明规格、数量、税费、MOQ、交期等差异与处理。不选择不影响原有核算。
      </Banner>
      <Field label="本次历史依据">
        <Select
          aria-label="本次历史依据"
          disabled={disabled}
          value={selected?.key || (value ? "missing" : "")}
          options={[
            { value: "", label: "不采用历史依据" },
            ...(value && !selected
              ? [{ value: "missing", label: "原选条目已不可用，请重新选择" }]
              : []),
            ...rows.map((r) => ({
              value: r.key,
              label:
                r.quote.code +
                " · " +
                (state.customers.find((c) => c.id === r.quote.customerId)
                  ?.name || "未记录客户") +
                " · " +
                r.line.style +
                " · " +
                r.line.price +
                " " +
                r.quote.currency +
                "/" +
                r.line.unit,
            })),
          ]}
          onChange={(e) => {
            const r = rows.find((x) => x.key === e.target.value);
            onChange(
              r
                ? {
                    quotationId: r.quote.id,
                    lineId: r.line.id,
                    expectedSource: JSON.stringify(
                      quotationHistorySource(state, r.quote, r.line),
                    ),
                    reason: "",
                    confirmed: false,
                  }
                : undefined,
            );
          }}
        />
      </Field>
      {stale && (
        <Banner tone="warn" title="原历史依据已变化">
          请重新选择并核对，不能继续沿用旧确认。
        </Banner>
      )}
      {selected && value && (
        <>
          <KeyValue
            items={quotationHistoryFacts(state, quote, line, selected).map(
              (f) => ({
                label: f.label,
                value:
                  "本次：" +
                  f.current +
                  "；历史：" +
                  f.historical +
                  "；核对：" +
                  f.result,
              }),
            )}
          />
          <span className="mist-note">
            主线状态：{selected.quote.status}
            ；历史价格只作原始事实，不自动填入拟报价或成本。
          </span>
          <FrozenHistoryEvidence
            preview
            evidence={{
              version: QUOTE_HISTORY_EVIDENCE_VERSION,
              source: quotationHistorySource(
                state,
                selected.quote,
                selected.line,
              ),
              reason: value.reason || "尚未填写",
            }}
          />
          <Field
            label="采用理由与差异处理"
            required
            hint="说明本次为什么参考、哪些条件不同或未知，以及如何人工处理；不把已发送当成交样本。"
          >
            <TextArea
              aria-label="采用理由与差异处理"
              disabled={disabled}
              value={value.reason}
              onChange={(e) =>
                onChange({ ...value, reason: e.target.value, confirmed: false })
              }
            />
          </Field>
          <Checkbox
            label="我已人工核对历史条件及未知项，确认仅作为本次依据"
            disabled={disabled || stale}
            checked={value.confirmed}
            onChange={(confirmed) => onChange({ ...value, confirmed })}
          />
        </>
      )}
    </div>
  );
}
