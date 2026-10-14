import React from "react";
import { ArrowLeft, Download } from "lucide-react";
import {
  Banner,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Facts,
  Field,
  FormGrid,
  FormSection,
  KeyValue,
  MistPage,
  Mono,
  PageHeader,
  Select,
  TextArea,
  TextInput,
  VerticalSteps,
} from "../../../../../components/mist";
import {
  QUOTE_FEEDBACK_KINDS,
  QUOTE_FEEDBACK_REASONS,
  quotationFeedbackTarget,
  validateQuoteFeedback,
  type QuoteFeedbackInput,
  type QuoteFeedbackRecord,
  type QuoteFeedbackReason,
} from "../../../../../server/src/shared/mistQuotationFeedback";
import { marketBusinessDate } from "../../../../../server/src/shared/mistMarket";
import { useMistWorkspace } from "../../runtime/workspace";
import { useMistSession } from "../../runtime/auth";
import { useNav } from "../../nav";
import { useRouteDraft, useRouteScope } from "./useRouteDraft";
import { downloadModuleCsv } from "./ModuleWorkbench";
const origins = {
  customer: "客户明确说明",
  business: "业务判断（非客户原话）",
  unknown: "客户未说明 / 原因未知",
};
function Record({
  r,
  corrected,
  canCorrect,
  onCorrect,
}: {
  r: QuoteFeedbackRecord;
  corrected: boolean;
  canCorrect: boolean;
  onCorrect: () => void;
}) {
  return (
    <Card>
      <CardHeader
        title={QUOTE_FEEDBACK_KINDS[r.input.kind]}
        sub={r.input.receivedOn + " · " + r.input.contact}
        tools={
          canCorrect && !corrected ? (
            <Button onClick={onCorrect}>追加更正</Button>
          ) : undefined
        }
      />
      <div className="mist-card-body mist-col">
        <Mono>{r.id}</Mono>
        {corrected && (
          <Banner title="已有后续更正">
            原反馈保留供追溯，不将这条旧表述作为当前结论。
          </Banner>
        )}
        {r.input.correctionOfId && (
          <Banner title="追加更正记录">
            {r.input.correctionOfId} · {r.input.correctionReason}
          </Banner>
        )}
        <Facts
          items={[
            {
              label: "准确报价版本",
              value: r.target.code + " · V" + r.target.revision,
            },
            { label: "冻结客户", value: r.target.customerName },
            { label: "反馈渠道", value: r.input.channel },
            { label: "原因来源", value: origins[r.input.reasonOrigin] },
            {
              label: "原因分类",
              value: r.input.reasons
                .map((x) => QUOTE_FEEDBACK_REASONS[x])
                .join(" / "),
            },
            { label: "下次跟进", value: r.input.followUpOn || "未安排" },
          ]}
        />
        <KeyValue
          items={[
            { label: "反馈事实与来源", value: r.input.evidence },
            { label: "原因说明与已知范围", value: r.input.reasonDetail },
            { label: "下一步动作", value: r.input.nextAction },
            {
              label: "客户提出整体条件",
              value: r.input.requestedTerms || "未提出变更",
            },
            {
              label: "原报价条件",
              value:
                r.target.deliveryTerms +
                " / " +
                r.target.paymentTerms +
                " · 有效期 " +
                r.target.validUntil,
            },
            { label: "登记人 / 时间", value: r.actor + " · " + r.createdAt },
            {
              label: "冻结附件",
              value:
                r.files.map((f) => f.name).join("；") ||
                "未选附件，人工登记依据",
            },
          ]}
        />
        {r.input.lines.map((l) => {
          const old = r.target.lines.find((x) => x.id === l.lineId)!;
          return (
            <FormSection
              key={l.lineId}
              title={"还价条目 · " + old.style}
              description={old.name + " · " + old.specification}
            >
              <Facts
                items={[
                  {
                    label: "原报价单价 / 数量",
                    value:
                      old.price +
                      " " +
                      r.target.currency +
                      "/" +
                      old.unit +
                      " · " +
                      old.qty +
                      " " +
                      old.unit,
                  },
                  {
                    label: "客户提出单价",
                    value: l.price
                      ? l.price + " " + r.target.currency + "/" + old.unit
                      : "未提出价格",
                  },
                  {
                    label: "客户提出数量",
                    value: l.quantity
                      ? l.quantity + " " + old.unit
                      : "未提出数量",
                  },
                  {
                    label: "条目变更条件",
                    value: l.conditions || "未额外说明",
                  },
                ]}
              />
            </FormSection>
          );
        })}
        <p className="mist-note">
          客户表述不等于已成交；主线接受、改价版本、审批、对客交付和转单另行确认，不由反馈自动执行。
        </p>
      </div>
    </Card>
  );
}
export function QuotationFeedbackPage() {
  const w = useMistWorkspace(),
    session = useMistSession(),
    { route, go } = useNav(),
    scope = useRouteScope();
  const q = w.state?.market.quotations.find((x) => x.id === route.id),
    records = q?.feedback || [],
    correctionId = route.section?.startsWith("feedback-correct:")
      ? route.section.slice("feedback-correct:".length)
      : "",
    old = records.find((x) => x.id === correctionId),
    editing = route.section === "feedback-new" || !!correctionId;
  const initial = (): QuoteFeedbackInput =>
    old
      ? {
          ...JSON.parse(JSON.stringify(old.input)),
          correctionOfId: old.id,
          correctionReason: "",
        }
      : {
          kind: "" as QuoteFeedbackInput["kind"],
          receivedOn: "",
          channel: "",
          contact: "",
          evidence: "",
          reasonOrigin: "" as QuoteFeedbackInput["reasonOrigin"],
          reasons: [],
          reasonDetail: "",
          nextAction: "",
          followUpOn: "",
          requestedTerms: "",
          lines: [],
          fileIds: [],
          correctionOfId: "",
          correctionReason: "",
        };
  const [input, setInput] = useRouteDraft(initial),
    [step, setStep] = useRouteDraft(0),
    [target] = useRouteDraft(() => (q ? quotationFeedbackTarget(q) : "")),
    [failure, setFailure] = useRouteDraft(""),
    [busy, setBusy] = useRouteDraft(false);
  const lock = React.useRef(false),
    key = session.user?.id + ":" + w.workspace?.id,
    activeKey = React.useRef(key);
  activeKey.current = key;
  const can = session.hasPermission("quotations:write"),
    frozen = q?.status === "Draft",
    disabled = busy || w.saving || w.loading || !!w.pending || !can || frozen;
  const patch = <K extends keyof QuoteFeedbackInput>(
    field: K,
    value: QuoteFeedbackInput[K],
  ) => {
    setInput((x) => ({ ...x, [field]: value }));
    setFailure("");
  };
  const back = () => go("quotations", route.id),
    history = () => go("quotations", route.id, { section: "feedback" });
  const current = () => scope.isCurrent() && activeKey.current === key;
  const validate = () => {
    if (!q) throw Error("准确报价不存在");
    return validateQuoteFeedback(input, q, marketBusinessDate(new Date()));
  };
  const save = async () => {
    if (disabled || lock.current || !q || !scope.isCurrent()) return;
    try {
      const normalized = validate();
      if (target !== quotationFeedbackTarget(q))
        throw Error("报价或反馈已变化，请重新打开准确版本后核对");
      lock.current = true;
      setBusy(true);
      setFailure("");
      const r = await w.run({
        type: "market.quotation.feedback.add",
        payload: {
          quotationId: q.id,
          expectedTarget: target,
          input: normalized,
        },
      });
      if (r.result.id !== q.id || !r.result.feedbackId)
        throw Error("回执缺少准确反馈记录，请核对原请求");
      if (current()) history();
    } catch (e) {
      if (current()) setFailure(e instanceof Error ? e.message : "反馈未保存");
    } finally {
      if (current()) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const intent = w.pending?.command,
    canRecover =
      intent?.type === "market.quotation.feedback.add" &&
      intent.payload.quotationId === q?.id;
  const recover = async () => {
    if (busy || w.saving || lock.current || !canRecover || !scope.isCurrent())
      return;
    lock.current = true;
    setBusy(true);
    setFailure("");
    try {
      const r = await w.recover();
      if (!r || r.result.id !== q?.id || !r.result.feedbackId)
        throw Error("原请求仍待核对或回执不属于当前报价");
      if (current()) history();
    } catch (e) {
      if (current()) setFailure(e instanceof Error ? e.message : "核对未完成");
    } finally {
      if (current()) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const retry = async () => {
    try {
      await w.refresh();
    } catch (e) {
      if (current()) setFailure(e instanceof Error ? e.message : "读取失败");
    }
  };
  if (!q || (correctionId && !old))
    return (
      <MistPage>
        <PageHeader title="报价客户反馈" />
        {w.error && (
          <Banner
            tone="bad"
            title="读取失败"
            actions={<Button onClick={() => void retry()}>重试读取</Button>}
          >
            {w.error}
          </Banner>
        )}
        <EmptyState
          title={w.loading ? "正在读取准确报价" : "未找到指定报价或被更正反馈"}
          description="不将反馈记到另一份报价或另一条反馈。"
          action={<Button onClick={back}>返回报价</Button>}
        />
      </MistPage>
    );
  const text = (
    field: keyof QuoteFeedbackInput,
    label: string,
    required = true,
    area = false,
    hint?: string,
  ) => (
    <Field label={label} required={required} full={area} hint={hint}>
      {area ? (
        <TextArea
          aria-label={label}
          value={String(input[field])}
          disabled={disabled}
          onChange={(e) => patch(field, e.target.value as never)}
        />
      ) : (
        <TextInput
          aria-label={label}
          value={String(input[field])}
          disabled={disabled}
          onChange={(e) => patch(field, e.target.value as never)}
        />
      )}
    </Field>
  );
  const toggleReason = (id: QuoteFeedbackReason, value: boolean) =>
    patch(
      "reasons",
      value ? [...input.reasons, id] : input.reasons.filter((x) => x !== id),
    );
  const next = () => {
    try {
      if (step === 0) {
        validateQuoteFeedback(
          {
            ...input,
            reasonOrigin: "unknown",
            reasons: ["unknown"],
            reasonDetail: "本步仅核验事实，原因尚未登记",
            nextAction: "下一步明确",
            lines: input.kind === "counteroffer" ? input.lines : [],
            requestedTerms:
              input.kind === "counteroffer"
                ? input.requestedTerms || "本步待录入还价条件"
                : "",
          },
          q,
          marketBusinessDate(new Date()),
        );
      } else validate();
      setFailure("");
      setStep(step + 1);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "请补齐本步事实");
    }
  };
  return (
    <MistPage>
      <Button icon={ArrowLeft} onClick={back}>
        返回报价
      </Button>
      <PageHeader
        eyebrow={<Mono>{q.code + " · V" + (q.revision || 1)}</Mono>}
        title={
          editing
            ? correctionId
              ? "追加反馈更正"
              : "登记客户反馈"
            : "报价客户反馈"
        }
        description="客户原话、业务判断和未知原因分别记录；还价不等于成交，旧反馈不覆盖。"
        actions={
          !editing && can && !frozen ? (
            <Button
              onClick={() =>
                go("quotations", q.id, { section: "feedback-new" })
              }
            >
              登记反馈
            </Button>
          ) : undefined
        }
      />
      {w.error && (
        <Banner
          tone="bad"
          title="读取失败"
          actions={<Button onClick={() => void retry()}>重试读取</Button>}
        >
          {w.error}
        </Banner>
      )}
      {failure && (
        <Banner tone="bad" title="反馈未完成">
          {failure}
        </Banner>
      )}
      {w.pending && !w.saving && (
        <Banner
          tone="warn"
          title="原请求待核对"
          actions={
            canRecover ? (
              <Button disabled={busy} onClick={() => void recover()}>
                核对原请求
              </Button>
            ) : undefined
          }
        >
          {canRecover
            ? "核对同一原请求，不再追加第二条。"
            : "请在原业务核对待处理请求后再登记反馈。"}
        </Banner>
      )}
      {(!can || frozen) && (
        <Banner title={!can ? "只读查看" : "尚未登记报价已发送"}>
          {!can
            ? "没有报价写权限，可查看原反馈。"
            : "先完成报价主线交付登记；不为未发送的草稿补造客户反馈。"}
        </Banner>
      )}
      {editing && can && !frozen ? (
        <div className="mist-wizard">
          <VerticalSteps
            current={String(step)}
            onSelect={(v) => {
              if (Number(v) <= step) setStep(Number(v));
            }}
            steps={[
              { id: "0", label: "反馈事实与来源" },
              { id: "1", label: "原因、还价与跟进" },
              { id: "2", label: "核对并追加" },
            ]}
          />
          <Card>
            {step === 0 ? (
              <FormSection title="准确版本的客户反馈">
                <FormGrid>
                  <Field label="反馈类型" required>
                    <Select
                      aria-label="反馈类型"
                      disabled={disabled}
                      value={input.kind}
                      options={[
                        { value: "", label: "选择本次反馈类型" },
                        ...Object.entries(QUOTE_FEEDBACK_KINDS).map(
                          ([value, label]) => ({ value, label }),
                        ),
                      ]}
                      onChange={(e) =>
                        setInput((x) => ({
                          ...x,
                          kind: e.target.value as QuoteFeedbackInput["kind"],
                          lines: [],
                          requestedTerms: "",
                        }))
                      }
                    />
                  </Field>
                  {text(
                    "receivedOn",
                    "反馈发生日期",
                    true,
                    false,
                    "YYYY-MM-DD；不自动填系统日期或允许未来事实。",
                  )}
                  {text(
                    "channel",
                    "反馈渠道",
                    true,
                    false,
                    "例如邮件 / 会议 / 电话 / 中间方，人工写清来源。",
                  )}
                  {text("contact", "反馈人及身份")}
                  {text(
                    "evidence",
                    "反馈事实与来源",
                    true,
                    true,
                    "记录客户表述及实际凭据位置，不将分析当原话。",
                  )}
                  <Field label="反馈凭据附件">
                    <Select
                      aria-label="反馈凭据附件"
                      disabled={disabled}
                      value={input.fileIds[0] || ""}
                      options={[
                        { value: "", label: "未选附件，人工登记依据" },
                        ...(w.state?.files || []).map((f) => ({
                          value: f.id,
                          label: f.name,
                        })),
                      ]}
                      onChange={(e) =>
                        patch("fileIds", e.target.value ? [e.target.value] : [])
                      }
                    />
                  </Field>
                  {correctionId &&
                    text("correctionReason", "更正原因", true, true)}
                </FormGrid>
              </FormSection>
            ) : step === 1 ? (
              <>
                <FormSection title="原因来源与下一步">
                  <FormGrid>
                    <Field label="原因来源" required>
                      <Select
                        aria-label="原因来源"
                        disabled={disabled}
                        value={input.reasonOrigin}
                        options={[
                          { value: "", label: "明确原因来源" },
                          ...Object.entries(origins).map(([value, label]) => ({
                            value,
                            label,
                          })),
                        ]}
                        onChange={(e) =>
                          setInput((x) => ({
                            ...x,
                            reasonOrigin: e.target
                              .value as QuoteFeedbackInput["reasonOrigin"],
                            reasons:
                              e.target.value === "unknown" ? ["unknown"] : [],
                          }))
                        }
                      />
                    </Field>
                    <Field label="原因分类" full required>
                      {input.reasonOrigin === "unknown" ? (
                        <p className="mist-note">
                          已明确记录未知，不推断为价格问题。
                        </p>
                      ) : (
                        <div className="mist-row" style={{ flexWrap: "wrap" }}>
                          {Object.entries(QUOTE_FEEDBACK_REASONS)
                            .filter(([id]) => id !== "unknown")
                            .map(([id, label]) => (
                              <Checkbox
                                key={id}
                                label={label}
                                disabled={disabled || !input.reasonOrigin}
                                checked={input.reasons.includes(
                                  id as QuoteFeedbackReason,
                                )}
                                onChange={(v) =>
                                  toggleReason(id as QuoteFeedbackReason, v)
                                }
                              />
                            ))}
                        </div>
                      )}
                    </Field>
                    {text("reasonDetail", "原因说明与已知范围", true, true)}
                    {text(
                      "nextAction",
                      "下一步动作",
                      true,
                      true,
                      "记录计划，不代为发送消息、创建任务或执行降价。",
                    )}
                    {text(
                      "followUpOn",
                      "下次跟进日期",
                      false,
                      false,
                      "可留空；不自动创建提醒或任务。",
                    )}
                  </FormGrid>
                </FormSection>
                {input.kind === "counteroffer" && (
                  <FormSection
                    title="客户提出的还价与条件"
                    description="原币与原计价单位保持不变；空价格表示客户未提出价格，不代零。跨币种 / 单位请求写入条件，不能直接比价或换算。"
                  >
                    {q.lines.map((line) => {
                      const r = input.lines.find((x) => x.lineId === line.id);
                      return (
                        <div className="mist-card-body mist-col" key={line.id}>
                          <Checkbox
                            label={
                              "记录还价 · " + line.style + " · " + line.name
                            }
                            disabled={disabled}
                            checked={!!r}
                            onChange={(v) =>
                              patch(
                                "lines",
                                v
                                  ? [
                                      ...input.lines,
                                      {
                                        lineId: line.id,
                                        price: "",
                                        quantity: "",
                                        conditions: "",
                                      },
                                    ]
                                  : input.lines.filter(
                                      (x) => x.lineId !== line.id,
                                    ),
                              )
                            }
                          />
                          <p className="mist-note">
                            原报价：{line.qty} {line.unit} × {line.price}{" "}
                            {q.currency} · {line.specification}
                          </p>
                          {r && (
                            <FormGrid>
                              {(
                                ["price", "quantity", "conditions"] as const
                              ).map((field, i) => (
                                <Field
                                  key={field}
                                  label={
                                    [
                                      "客户提出单价 " +
                                        q.currency +
                                        "/" +
                                        line.unit,
                                      "客户提出数量 " + line.unit,
                                      "条目变更条件",
                                    ][i]
                                  }
                                >
                                  <TextInput
                                    aria-label={
                                      "条目" +
                                      (q.lines.indexOf(line) + 1) +
                                      [
                                        "客户提出单价",
                                        "客户提出数量",
                                        "变更条件",
                                      ][i]
                                    }
                                    value={r[field]}
                                    disabled={disabled}
                                    onChange={(e) =>
                                      patch(
                                        "lines",
                                        input.lines.map((x) =>
                                          x.lineId === line.id
                                            ? { ...x, [field]: e.target.value }
                                            : x,
                                        ),
                                      )
                                    }
                                  />
                                </Field>
                              ))}
                            </FormGrid>
                          )}
                        </div>
                      );
                    })}
                    {text("requestedTerms", "客户提出整体条件", false, true)}
                  </FormSection>
                )}
              </>
            ) : (
              <>
                <CardHeader title="核对本次反馈" />
                <div className="mist-card-body mist-col">
                  <Facts
                    items={[
                      {
                        label: "反馈类型",
                        value: QUOTE_FEEDBACK_KINDS[input.kind],
                      },
                      {
                        label: "发生日期 / 渠道",
                        value: input.receivedOn + " / " + input.channel,
                      },
                      { label: "反馈人", value: input.contact },
                      { label: "原因来源", value: origins[input.reasonOrigin] },
                      {
                        label: "原因分类",
                        value: input.reasons
                          .map((x) => QUOTE_FEEDBACK_REASONS[x])
                          .join(" / "),
                      },
                      {
                        label: "准确报价",
                        value: q.code + " · " + q.currency + " " + q.total,
                      },
                    ]}
                  />
                  <KeyValue
                    items={[
                      { label: "反馈事实", value: input.evidence },
                      { label: "原因说明", value: input.reasonDetail },
                      { label: "下一步动作", value: input.nextAction },
                      {
                        label: "下次跟进",
                        value: input.followUpOn || "未安排",
                      },
                      {
                        label: "整体变更条件",
                        value: input.requestedTerms || "未提出变更",
                      },
                      ...input.lines.map((l) => {
                        const line = q.lines.find((x) => x.id === l.lineId)!;
                        return {
                          label: line.style + " 还价",
                          value:
                            (l.price
                              ? l.price + " " + q.currency + "/" + line.unit
                              : "未提出单价") +
                            " · " +
                            (l.quantity
                              ? l.quantity + " " + line.unit
                              : "未提出数量") +
                            " · " +
                            (l.conditions || "无额外条件"),
                        };
                      }),
                      ...(correctionId
                        ? [
                            {
                              label: "更正原记录",
                              value:
                                correctionId + " · " + input.correctionReason,
                            },
                          ]
                        : []),
                    ]}
                  />
                  <Banner tone="warn" title="仅追加反馈，不改写业务结果">
                    不改售价、报价状态、审批或订单；客户表示接受仍需在报价主线核实确认，跟进计划不自动成为任务。保存后原记录保留，更正另追加。
                  </Banner>
                </div>
              </>
            )}
            <div className="mist-sticky-foot">
              <span className="mist-note">第{step + 1}/3步</span>
              <span className="mist-spacer" />
              {step > 0 && (
                <Button disabled={disabled} onClick={() => setStep(step - 1)}>
                  上一步
                </Button>
              )}
              {step < 2 ? (
                <Button variant="primary" disabled={disabled} onClick={next}>
                  下一步
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={disabled}
                  loading={busy}
                  onClick={() => void save()}
                >
                  确认追加反馈
                </Button>
              )}
            </div>
          </Card>
        </div>
      ) : editing ? (
        <EmptyState
          title="本版本不可追加反馈"
          action={<Button onClick={history}>查看反馈历史</Button>}
        />
      ) : records.length ? (
        <div className="mist-col">
          {[...records].reverse().map((r) => (
            <Record
              key={r.id}
              r={r}
              corrected={records.some((x) => x.input.correctionOfId === r.id)}
              canCorrect={can && !frozen && !w.pending && !w.saving}
              onCorrect={() =>
                go("quotations", q.id, { section: "feedback-correct:" + r.id })
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="尚无结构化客户反馈"
          description="旧客户接受 / 未接受依据继续保留在报价主线，不替历史记录补造原因。"
        />
      )}
      {!editing && records.length > 0 && (
        <Button
          icon={Download}
          onClick={() =>
            downloadModuleCsv(
              q.code + "-客户反馈.csv",
              [
                "记录",
                "报价版本",
                "发生日期",
                "反馈类型",
                "原因来源",
                "原因",
                "原话与来源",
                "原因说明",
                "下一步",
                "跟进日期",
                "被更正记录",
                "是否已被更正",
                "币种",
                "原报价条目",
                "客户提出条目条件",
                "客户提出整体条件",
              ],
              records.map((r) => [
                r.id,
                r.target.code,
                r.input.receivedOn,
                QUOTE_FEEDBACK_KINDS[r.input.kind],
                origins[r.input.reasonOrigin],
                r.input.reasons.map((x) => QUOTE_FEEDBACK_REASONS[x]).join("/"),
                r.input.evidence,
                r.input.reasonDetail,
                r.input.nextAction,
                r.input.followUpOn,
                r.input.correctionOfId,
                records.some((x) => x.input.correctionOfId === r.id)
                  ? "是"
                  : "否",
                r.target.currency,
                r.target.lines
                  .map(
                    (x) =>
                      x.id +
                      " · " +
                      x.style +
                      " · " +
                      x.specification +
                      " · " +
                      x.qty +
                      " " +
                      x.unit +
                      " × " +
                      x.price,
                  )
                  .join("；"),
                r.input.lines
                  .map(
                    (x) =>
                      x.lineId +
                      " · 单价 " +
                      (x.price || "未提出") +
                      " · 数量 " +
                      (x.quantity || "未提出") +
                      " · " +
                      x.conditions,
                  )
                  .join("；"),
                r.input.requestedTerms,
              ]),
            )
          }
        >
          导出本版反馈
        </Button>
      )}
    </MistPage>
  );
}
