/** AI reviews evidence; adoption edits only the manual strategy draft, never a business command. */
import React from "react";
import {
  Banner,
  Button,
  Checkbox,
  Facts,
  FormSection,
} from "../../../../../components/mist";
import { apiService } from "../../../../../services/apiService";
import {
  calculateQuoteCosting,
  type QuoteCostInput,
} from "../../../../../server/src/shared/mistQuotationCosting";
import {
  parseQuoteCostAdvice,
  QUOTE_COST_ADVISOR_POLICY,
  type QuoteCostAdvisorResponse,
} from "../../../../../server/src/shared/mistQuoteCostAdvisor";
import type { QuoteHistoryReference } from "../../../../../server/src/shared/mistQuotationHistoryEvidence";
export function QuotationCostAdvisor(p: {
  workspaceId: string;
  revision: number;
  sessionKey: string;
  quotationId: string;
  lineId: string;
  expectedTarget: string;
  input: QuoteCostInput;
  historyReference?: QuoteHistoryReference;
  permitted: boolean;
  disabled: boolean;
  onAdopt: (
    method: QuoteCostInput["method"],
    percent: string,
    reason: string,
  ) => void;
}) {
  const [consent, setConsent] = React.useState(false),
    [configured, setConfigured] = React.useState<boolean | null>(null),
    [statusError, setStatusError] = React.useState(""),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false),
    [result, setResult] = React.useState<QuoteCostAdvisorResponse | null>(null),
    [reload, setReload] = React.useState(0);
  const context = JSON.stringify([
    p.workspaceId,
    p.revision,
    p.sessionKey,
    p.quotationId,
    p.lineId,
    p.expectedTarget,
    p.input,
    p.historyReference,
    p.permitted,
    p.disabled,
  ]);
  const current = React.useRef(context);
  current.current = context;
  const controller = React.useRef<AbortController | null>(null),
    locked = React.useRef(false),
    serial = React.useRef(0);
  React.useLayoutEffect(() => {
    serial.current++;
    controller.current?.abort();
    controller.current = null;
    locked.current = false;
    setConsent(false);
    setResult(null);
    setBusy(false);
    setError("");
    return () => {
      serial.current++;
      controller.current?.abort();
    };
  }, [context]);
  React.useEffect(() => {
    let active = true;
    const c = new AbortController();
    setConfigured(null);
    setStatusError("");
    if (p.permitted && p.workspaceId) {
      void request(
        `/api/mist/workspaces/${encodeURIComponent(p.workspaceId)}/assistant/status`,
        { signal: c.signal },
      )
        .then((r) => {
          if (active) {
            if (typeof r.configured !== "boolean")
              throw Error("模型状态无法核对");
            setConfigured(r.configured);
          }
        })
        .catch((e) => {
          if (active && !c.signal.aborted)
            setStatusError(e instanceof Error ? e.message : "模型状态读取失败");
        });
    }
    return () => {
      active = false;
      c.abort();
    };
  }, [p.workspaceId, p.sessionKey, p.permitted, reload]);
  const normalized = () =>
    calculateQuoteCosting({
      ...p.input,
      fileIds: [],
      targetPercent: p.input.targetPercent || "0",
      strategyBasis:
        p.input.strategyBasis ||
        "尚未设置人工目标，仅审阅成本来源，不代表公司政策",
      proposedPrice: p.input.proposedPrice || "0",
    });
  let valid = true;
  try {
    normalized();
  } catch {
    valid = false;
  }
  const ask = async () => {
    if (
      locked.current ||
      p.disabled ||
      !p.permitted ||
      !configured ||
      !consent ||
      !valid
    )
      return;
    const bound = context,
      seq = ++serial.current,
      c = new AbortController();
    controller.current = c;
    locked.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const input = normalized().input;
      const r = await request(
        `/api/mist/workspaces/${encodeURIComponent(p.workspaceId)}/quotation-cost-advisor`,
        {
          method: "POST",
          signal: c.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quotationId: p.quotationId,
            lineId: p.lineId,
            expectedTarget: p.expectedTarget,
            expectedRevision: p.revision,
            consent: true,
            input,
            ...(p.historyReference
              ? { historyReference: p.historyReference }
              : {}),
          }),
        },
      );
      if (bound !== current.current || seq !== serial.current) return;
      if (
        r.mode !== "read_only" ||
        r.policyVersion !== QUOTE_COST_ADVISOR_POLICY ||
        r.revision !== p.revision ||
        r.expectedTarget !== p.expectedTarget ||
        !Array.isArray(r.sources) ||
        r.sources.length < 1 ||
        r.sources.length > 2
      )
        throw Error("AI 来源或版本不一致，请重新审阅");
      const allowed = [
        "quote-line:" + p.quotationId + ":" + p.lineId,
        ...(p.historyReference
          ? [
              "history:" +
                p.historyReference.quotationId +
                ":" +
                p.historyReference.lineId,
            ]
          : []),
      ];
      if (
        r.sources.length !== allowed.length ||
        r.sources.map((s: any) => s.id).join("|") !== allowed.join("|") ||
        r.sources.some(
          (s: any) => !allowed.includes(s.id) || typeof s.label !== "string",
        )
      )
        throw Error("AI 来源不在本次授权范围内");
      const advice = parseQuoteCostAdvice(r.advice, allowed),
        base = calculateQuoteCosting(input).result;
      const scenario = advice.strategy
        ? calculateQuoteCosting({
            ...input,
            ...advice.strategy,
            strategyBasis: advice.strategy.reason,
          }).result
        : null;
      if (
        r.cost !== base.cost ||
        JSON.stringify(r.scenario) !== JSON.stringify(scenario)
      )
        throw Error("AI 计算回执不一致，请重新审阅");
      setResult({ ...r, advice });
    } catch (e) {
      if (
        bound === current.current &&
        seq === serial.current &&
        !c.signal.aborted
      )
        setError(e instanceof Error ? e.message : "AI 审阅未完成");
    } finally {
      if (bound === current.current && seq === serial.current) {
        locked.current = false;
        setBusy(false);
        controller.current = null;
      }
    }
  };
  return (
    <FormSection
      title="AI 成本与报价审阅"
      description="可选：公式算价格，AI 检查依据和本次策略，人工决定。"
    >
      <div className="mist-col">
        {!p.permitted ? (
          <Banner title="没有报价 AI 审阅权限">
            需要助手及报价读取权限；人工核算仍可继续。
          </Banner>
        ) : statusError ? (
          <Banner
            tone="bad"
            title="模型状态未读取"
            actions={
              <Button onClick={() => setReload((x) => x + 1)}>重试状态</Button>
            }
          >
            {statusError}
          </Banner>
        ) : configured === null ? (
          <Banner title="正在读取模型状态">不会自动发送报价资料。</Banner>
        ) : !configured ? (
          <Banner title="服务器尚未配置模型">
            管理员配置 OpenAI
            兼容接口后可使用；不影响人工核算，不用模拟建议代替真实模型。
          </Banner>
        ) : (
          <>
            <Banner tone="ai" title="只审阅本次授权资料">
              将发送本行规格、数量、商业条件、人工成本拆解及明确选取的历史 /
              反馈给服务器配置模型（可能使用备用模型）。不发送联系人、整份客户档案或附件正文；附件名称亦不读取。不要在依据文字中填写不应外发的敏感信息。不是行业行情、客户接受概率或已审批报价。
            </Banner>
            <Checkbox
              label="我授权将本次报价依据发送给已配置模型审阅"
              checked={consent}
              disabled={p.disabled || busy}
              onChange={setConsent}
            />
            {!valid && (
              <Banner title="先补齐成本来源">
                返回第一步补齐人工依据，再请求 AI；无需先填写利润目标。
              </Banner>
            )}
            <div className="mist-row">
              <Button
                variant="ai"
                loading={busy}
                disabled={p.disabled || busy || !consent || !valid}
                onClick={() => void ask()}
              >
                请求 AI 审阅
              </Button>
              {busy && (
                <Button
                  onClick={() => {
                    serial.current++;
                    controller.current?.abort();
                    locked.current = false;
                    setBusy(false);
                    setError("审阅已取消，未修改报价");
                  }}
                >
                  取消审阅
                </Button>
              )}
            </div>
            {error && (
              <Banner tone="bad" title="AI 审阅未完成">
                {error}
              </Banner>
            )}
            {result && (
              <>
                <Banner tone="ai" title="待人工核对的建议">
                  {result.advice.summary}
                </Banner>
                <Facts
                  items={[
                    {
                      label: "公式单位成本",
                      value: result.cost + " " + p.input.currency,
                    },
                    {
                      label: "AI 策略公式建议价",
                      value: result.scenario
                        ? result.scenario.suggestedQuotePrice +
                          " " +
                          p.input.currency
                        : "依据不足，未给策略",
                    },
                  ]}
                />
                <Banner title="风险与待补资料">
                  {result.advice.risks.map((r, i) => (
                    <React.Fragment key={"r" + i}>
                      风险：{r}
                      <br />
                    </React.Fragment>
                  ))}
                  {result.advice.questions.map((r, i) => (
                    <React.Fragment key={"q" + i}>
                      待补：{r}
                      <br />
                    </React.Fragment>
                  ))}
                  {!result.advice.risks.length &&
                    !result.advice.questions.length &&
                    "模型未列出缺口，不等于核实完整。"}
                </Banner>
                <Banner title="本次实际资料范围">
                  {result.sources.map((s) => (
                    <React.Fragment key={s.id}>
                      {s.label} · {s.id}
                      <br />
                    </React.Fragment>
                  ))}
                  政策版本 {result.policyVersion}
                  。这是一份临时审阅，不是服务端持久化 AI
                  审计记录；更改输入或工作区后必须重新请求。
                </Banner>
                {result.advice.strategy && (
                  <Banner
                    title="人工决定是否采纳策略"
                    actions={
                      <Button
                        disabled={p.disabled || busy}
                        onClick={() => {
                          const s = result.advice.strategy!;
                          p.onAdopt(
                            s.method,
                            s.targetPercent,
                            "人工采纳 AI 审阅参考（" +
                              result.policyVersion +
                              "，非已核实模型审计）：" +
                              s.reason +
                              "；参考资料 " +
                              result.advice.evidenceIds.join("、"),
                          );
                        }}
                      >
                        采纳至人工策略草稿
                      </Button>
                    }
                  >
                    {result.advice.strategy.method === "margin"
                      ? "销售毛利目标"
                      : "成本加成率"}{" "}
                    {result.advice.strategy.targetPercent}% ·{" "}
                    {result.advice.strategy.reason}
                    。只改本次草稿策略，不改人工拟报价；最终核对、保存快照和业务审批仍独立执行。
                  </Banner>
                )}
              </>
            )}
          </>
        )}
      </div>
    </FormSection>
  );
}
async function request(url: string, init: RequestInit) {
  const r = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      ...apiService.getAuthHeaders(),
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw Error(b?.error?.message || "AI 请求未完成；未修改报价");
  if (!b) throw Error("AI 未返回可核对回执");
  return b;
}
