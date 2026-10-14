/** Quote-entry professional costing; internal, manual and auditable, not AI prediction. */
import React from "react";
import { ArrowLeft, Download } from "lucide-react";
import {
  Banner,
  Button,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
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
  calculateQuoteCosting,
  quotationCostingTarget,
  QUOTE_COST_KINDS,
  type QuoteCostComponent,
  type QuoteCostInput,
  type QuoteCostSnapshot,
} from "../../../../../server/src/shared/mistQuotationCosting";
import { useMistWorkspace } from "../../runtime/workspace";
import { useMistSession } from "../../runtime/auth";
import { useNav } from "../../nav";
import { useRouteDraft, useRouteScope } from "./useRouteDraft";
import { downloadModuleCsv } from "./ModuleWorkbench";
const kinds: Record<QuoteCostComponent["kind"], string> = {
  yarn: "纱线 / 原料",
  weaving: "织造",
  dyeing: "染整",
  finishing: "后整理",
  fabric: "面料",
  trimming: "辅料",
  cmt: "CMT 加工",
  packaging: "包装",
  freight: "运费",
  insurance: "保险",
  bank: "银行费用",
  commission: "佣金",
  other: "其他",
};
const blankComponent = (): QuoteCostComponent => ({
  kind: "other",
  description: "",
  quantity: "1",
  unit: "",
  lossPercent: "0",
  unitPrice: "",
  basis: "",
  outsideSupplierPrice: false,
});
function Snapshot({ r }: { r: QuoteCostSnapshot }) {
  const { go } = useNav();
  return (
    <Card>
      <CardHeader title="已冻结条目核算" sub={r.createdAt + " · " + r.actor} />
      <div className="mist-card-body mist-col">
        <Mono>{r.id}</Mono>
        <Facts
          items={[
            { label: "模型版本", value: r.modelVersion },
            {
              label: "原报价条目",
              value: r.target.line.style + " · " + r.target.line.name,
            },
            {
              label: "来源路径",
              value:
                r.input.mode === "supplier" ? "供应商成品报价" : "专业逐项拆解",
            },
            { label: "本次适用规格", value: r.input.sourceSpecification },
            {
              label: "币种 / 单位",
              value: r.input.currency + " / " + r.input.unit,
            },
            {
              label: "单位参考成本",
              value: r.result.cost + " " + r.input.currency,
            },
            {
              label: "建议报价（两位精度）",
              value: r.result.suggestedQuotePrice + " " + r.input.currency,
            },
            {
              label: "人工拟报价",
              value: r.input.proposedPrice + " " + r.input.currency,
            },
            {
              label: "是否写入报价",
              value: r.appliedPrice
                ? "已人工选择写入"
                : "仅保存依据，不改拟报价",
            },
          ]}
        />
        <KeyValue
          items={[
            { label: "来源条件", value: r.input.sourceTerms },
            {
              label: "本次适用数量",
              value: r.target.line.qty + " " + r.target.line.unit,
            },
            {
              label: "供应商成品基价",
              value:
                r.input.mode === "supplier"
                  ? r.input.supplierPrice +
                    " " +
                    r.input.currency +
                    "/" +
                    r.input.unit
                  : "逐项拆解，不加成品基价",
            },
            {
              label: "来源日期 / 有效期",
              value:
                r.input.sourceDate +
                " / " +
                (r.input.sourceValidUntil || "未记录"),
            },
            { label: "成本依据", value: r.input.basis },
            {
              label: "定价策略",
              value:
                (r.input.method === "markup"
                  ? "成本加成率"
                  : "目标销售毛利率") +
                " " +
                r.input.targetPercent +
                "% · " +
                r.input.strategyBasis,
            },
            {
              label: "供应商冻结身份",
              value: r.supplier
                ? r.supplier.code + " · " + r.supplier.name
                : "拆解路径，无成品报价基数",
            },
            {
              label: "报价条款快照",
              value: r.target.deliveryTerms + " / " + r.target.paymentTerms,
            },
            {
              label: "凭据附件快照",
              value:
                r.files.map((f) => f.name).join("；") ||
                "没有选取附件，依据为人工登记",
            },
          ]}
        />
        {r.supplier && (
          <Button onClick={() => go("suppliers", r.supplier!.id)}>
            来源供应商
          </Button>
        )}
        {r.result.components.length > 0 && (
          <DataTable
            ariaLabel="冻结成本拆解"
            rows={r.result.components.map((x, i) => ({ ...x, id: String(i) }))}
            rowKey={(x) => x.id}
            columns={[
              {
                key: "name",
                header: "项目 / 依据",
                width: "minmax(170px,1fr)",
                render: (x) => (
                  <span className="mist-col">
                    <span>
                      {kinds[x.kind]} · {x.description}
                    </span>
                    <small className="mist-note">
                      {x.quantity} {x.unit} / 每{r.input.unit} · 单价{" "}
                      {x.unitPrice} {r.input.currency} · 损耗 {x.lossPercent}% ·{" "}
                      {x.basis}
                    </small>
                  </span>
                ),
              },
              {
                key: "amount",
                header: "金额",
                align: "right",
                width: "130px",
                render: (x) => x.amount + " " + r.input.currency,
              },
            ]}
          />
        )}
        <Banner title="内部参考，不是实际利润或已对客报价">
          四位成本结果与两位报价门禁口径分别保留；不能将建议价当客户接受价。历史来源后来改名或改价，不会改写这份快照。
        </Banner>
      </div>
    </Card>
  );
}
export function QuotationCostingPage() {
  const w = useMistWorkspace(),
    session = useMistSession(),
    { route, go } = useNav(),
    scope = useRouteScope();
  const q = w.state?.market.quotations.find((x) => x.id === route.id),
    line = q?.lines.find(
      (l) => l.id === route.section?.slice("costing:".length),
    );
  const snapshots = q?.costingSnapshots || [],
    lineSnapshots = snapshots.filter((s) => s.lineId === line?.id),
    latest = lineSnapshots.at(-1);
  const initial = (): QuoteCostInput => ({
    mode: "supplier",
    currency: q?.currency || "",
    unit: line?.unit || "",
    sourceSpecification: line?.specification || "",
    supplierId: "",
    supplierPrice: "",
    sourceDate: "",
    sourceValidUntil: "",
    sourceTerms: "",
    basis: "",
    fileIds: [],
    components: [],
    method: "markup",
    targetPercent: "",
    strategyBasis: "",
    proposedPrice: line?.price || "",
  });
  const [input, setInput] = useRouteDraft(initial),
    [step, setStep] = useRouteDraft(0),
    [editing, setEditing] = useRouteDraft(!latest),
    [origin, setOrigin] = useRouteDraft(() =>
      q && line ? quotationCostingTarget(q, line) : "",
    ),
    [applyPrice, setApplyPrice] = useRouteDraft(false),
    [failure, setFailure] = useRouteDraft(""),
    [busy, setBusy] = useRouteDraft(false);
  const lock = React.useRef(false);
  const key = session.user?.id + ":" + w.workspace?.id,
    activeKey = React.useRef(key);
  activeKey.current = key;
  const can = session.hasPermission("quotations:write"),
    frozen =
      q?.status !== "Draft" ||
      q?.approval?.status === "pending" ||
      !!q?.convertedOrderId,
    disabled = busy || w.saving || w.loading || !!w.pending || !can || frozen;
  const patch = (field: keyof QuoteCostInput, value: any) => {
    setInput((x) => ({ ...x, [field]: value }));
    setFailure("");
  };
  const patchRow = (index: number, patch: Partial<QuoteCostComponent>) =>
    setInput((x) => ({
      ...x,
      components: x.components.map((r, i) =>
        i === index ? { ...r, ...patch } : r,
      ),
    }));
  let calculation: ReturnType<typeof calculateQuoteCosting> | null = null,
    problem = "";
  try {
    calculation = calculateQuoteCosting(input);
  } catch (e) {
    problem = e instanceof Error ? e.message : "待补齐核算输入";
  }
  const back = () => go("quotations", q?.id || route.id);
  const begin = () => {
    if (!q || !line || disabled) return;
    setInput(latest ? JSON.parse(JSON.stringify(latest.input)) : initial());
    setOrigin(quotationCostingTarget(q, line));
    setStep(0);
    setApplyPrice(false);
    setFailure("");
    setEditing(true);
  };
  const save = async () => {
    if (disabled || lock.current || !q || !line || !scope.isCurrent()) return;
    if (!calculation) {
      setFailure(problem);
      return;
    }
    if (origin !== quotationCostingTarget(q, line)) {
      setFailure("报价条目或商业条件已变化，请重新载入后核算");
      return;
    }
    const startedKey = key;
    lock.current = true;
    setBusy(true);
    setFailure("");
    try {
      const r = await w.run({
        type: "market.quotation.costing.save",
        payload: {
          quotationId: q.id,
          lineId: line.id,
          expectedTarget: origin,
          input: calculation.input,
          applyPrice,
        },
      });
      if (
        !r.result.snapshotId ||
        r.result.id !== q.id ||
        r.result.lineId !== line.id
      )
        throw Error("回执缺少准确核算快照，请核对原请求");
      if (scope.isCurrent() && activeKey.current === startedKey)
        setEditing(false);
    } catch (e) {
      if (scope.isCurrent() && activeKey.current === startedKey)
        setFailure(e instanceof Error ? e.message : "核算未保存");
    } finally {
      if (scope.isCurrent() && activeKey.current === startedKey) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const recover = async () => {
    if (busy || w.saving || lock.current || !scope.isCurrent()) return;
    const startedKey = key;
    lock.current = true;
    setBusy(true);
    setFailure("");
    try {
      const r = await w.recover();
      if (!r) throw Error("原请求仍待核对，请稍后重试");
      if (
        !r.result.snapshotId ||
        r.result.id !== q?.id ||
        r.result.lineId !== line?.id
      )
        throw Error("原请求回执不属于当前报价条目，请返回原业务核对");
      if (scope.isCurrent() && activeKey.current === startedKey)
        setEditing(false);
    } catch (e) {
      if (scope.isCurrent() && activeKey.current === startedKey)
        setFailure(e instanceof Error ? e.message : "核对未完成");
    } finally {
      if (scope.isCurrent() && activeKey.current === startedKey) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  if (q && route.section === "cost-history")
    return (
      <MistPage>
        <Button icon={ArrowLeft} onClick={back}>
          返回报价
        </Button>
        <PageHeader
          title="报价核算历史"
          eyebrow={<Mono>{q.code}</Mono>}
          description="保留本报价所有原条目的冻结依据；历史不自动适用新条目，也不作为当前审批依据。"
        />
        <Banner title="历史只读">
          新条目与新版本需重新核算，不能把旧单价、规格或策略自动沿用。
        </Banner>
        {snapshots.length ? (
          <div className="mist-col">
            {[...snapshots].reverse().map((r) => (
              <Snapshot key={r.id} r={r} />
            ))}
          </div>
        ) : (
          <EmptyState title="本报价尚无核算历史" />
        )}
      </MistPage>
    );
  if (!q || !line)
    return (
      <MistPage>
        <PageHeader title="报价条目核算" />
        {w.error && (
          <Banner
            tone="bad"
            title="读取失败"
            actions={
              <Button
                onClick={() =>
                  void w.refresh().catch((e) => {
                    if (scope.isCurrent()) setFailure(e.message);
                  })
                }
              >
                重试读取
              </Button>
            }
          >
            {w.error}
          </Banner>
        )}
        {failure && (
          <Banner tone="bad" title="重试未完成">
            {failure}
          </Banner>
        )}
        <EmptyState
          title={w.loading ? "正在读取准确条目" : "未找到指定报价条目"}
          description={w.error || "不猜配其他产品或报价行。"}
          action={<Button onClick={back}>返回报价</Button>}
        />
      </MistPage>
    );
  const inputField = (
    field: keyof QuoteCostInput,
    label: string,
    required = true,
    hint?: string,
  ) => (
    <Field label={label} required={required} hint={hint}>
      <TextInput
        aria-label={label}
        value={String(input[field])}
        disabled={disabled}
        onChange={(e) => patch(field, e.target.value)}
      />
    </Field>
  );
  return (
    <MistPage>
      <Button icon={ArrowLeft} onClick={back}>
        返回报价
      </Button>
      <PageHeader
        title="报价条目核算"
        eyebrow={<Mono>{q.code + " · " + line.style}</Mono>}
        description={`${line.name} · ${line.qty} ${line.unit} · ${q.currency}；成本、建议价与人工拟报价分开。`}
        actions={
          !editing && can && !frozen ? (
            <Button onClick={begin}>新建核算</Button>
          ) : undefined
        }
      />
      {w.error && (
        <Banner
          tone="bad"
          title="读取失败"
          actions={
            <Button
              onClick={() =>
                void w.refresh().catch((e) => {
                  if (scope.isCurrent()) setFailure(e.message);
                })
              }
            >
              重试读取
            </Button>
          }
        >
          {w.error}
        </Banner>
      )}
      {failure && (
        <Banner tone="bad" title="核算未完成">
          {failure}
        </Banner>
      )}
      {w.pending && !w.saving && (
        <Banner
          tone="warn"
          title="上次提交结果待核对"
          actions={
            <Button disabled={busy} onClick={() => void recover()}>
              核对原请求
            </Button>
          }
        >
          核对原请求，不重新保存或写入报价。
        </Banner>
      )}
      {(!can || frozen) && (
        <Banner title={can ? "本版本只读" : "没有报价写权限"}>
          审批中、已发送或已转单的报价不能改核算；需要改价时从报价主线建立适用新版本。
        </Banner>
      )}
      <Banner title="专业计算首轮 · 人工依据">
        当前只支持与报价行相同币种、相同计价单位；不自动取市场原料价或换算米 /
        码 /
        公斤。供应商成品价与专业拆解二选一，附加费用必须确认未包含。AI、行业基准、历史成交匹配与自动客户策略尚未接入。
      </Banner>
      {editing && can && !frozen ? (
        <div className="mist-wizard">
          <VerticalSteps
            current={String(step)}
            onSelect={(v) => {
              if (Number(v) <= step) setStep(Number(v));
            }}
            steps={[
              { id: "0", label: "成本来源与拆解" },
              { id: "1", label: "本次报价策略" },
              { id: "2", label: "核对并冻结" },
            ]}
          />
          <Card>
            {step === 0 ? (
              <>
                <FormSection title="成本来源">
                  <FormGrid>
                    <Field label="核算路径">
                      <Select
                        aria-label="核算路径"
                        disabled={disabled}
                        value={input.mode}
                        onChange={(e) =>
                          setInput((x) => ({
                            ...x,
                            mode: e.target.value as QuoteCostInput["mode"],
                            supplierId: "",
                            supplierPrice: "",
                            components: [],
                          }))
                        }
                        options={[
                          {
                            value: "supplier",
                            label: "供应商成品报价＋未包含费用",
                          },
                          {
                            value: "breakdown",
                            label: "专业逐项拆解（无成品报价基数）",
                          },
                        ]}
                      />
                    </Field>
                    {inputField("currency", "成本币种")}
                    {inputField("unit", "成本计价单位")}
                    {inputField("sourceSpecification", "适用规格")}
                    {inputField(
                      "sourceDate",
                      "来源日期",
                      true,
                      "YYYY-MM-DD，记录这次依据日期，不自动填市场日期。",
                    )}
                    {inputField(
                      "sourceValidUntil",
                      "来源有效期",
                      false,
                      "可留空；不等同客户报价有效期。",
                    )}
                    {input.mode === "supplier" && (
                      <>
                        <Field label="来源供应商" required>
                          <Select
                            aria-label="来源供应商"
                            disabled={disabled}
                            value={input.supplierId}
                            onChange={(e) =>
                              patch("supplierId", e.target.value)
                            }
                            options={[
                              { value: "", label: "选择准确供应商" },
                              ...(w.state?.market.suppliers || []).map((s) => ({
                                value: s.id,
                                label: s.code + " · " + s.name,
                              })),
                            ]}
                          />
                        </Field>
                        {inputField("supplierPrice", "供应商成品单价")}
                      </>
                    )}
                    <Field label="来源交付与费用包含条件" full required>
                      <TextArea
                        aria-label="来源交付与费用包含条件"
                        value={input.sourceTerms}
                        disabled={disabled}
                        onChange={(e) => patch("sourceTerms", e.target.value)}
                      />
                    </Field>
                    <Field label="成本来源依据" full required>
                      <TextArea
                        aria-label="成本来源依据"
                        disabled={disabled}
                        value={input.basis}
                        onChange={(e) => patch("basis", e.target.value)}
                      />
                    </Field>
                    <Field
                      label="来源凭据附件"
                      hint="选择本空间已上传凭据；不选时仅保存人工登记依据。"
                    >
                      <Select
                        aria-label="来源凭据附件"
                        disabled={disabled}
                        value={input.fileIds[0] || ""}
                        options={[
                          { value: "", label: "未选择附件" },
                          ...(w.state?.files || []).map((f) => ({
                            value: f.id,
                            label: f.name,
                          })),
                        ]}
                        onChange={(e) =>
                          patch(
                            "fileIds",
                            e.target.value ? [e.target.value] : [],
                          )
                        }
                      />
                    </Field>
                  </FormGrid>
                </FormSection>
                <CardHeader
                  title={
                    input.mode === "supplier"
                      ? "未包含的额外费用"
                      : "每个报价计价单位的成本拆解"
                  }
                  sub="每项写清耗用量、耗用单位、损耗、单价及依据，不猜标准用量。"
                  tools={
                    <Button
                      disabled={disabled || input.components.length >= 100}
                      onClick={() =>
                        patch("components", [
                          ...input.components,
                          blankComponent(),
                        ])
                      }
                    >
                      增加成本项
                    </Button>
                  }
                />
                {input.components.map((r, i) => (
                  <FormSection key={i} title={`第${i + 1}项成本`}>
                    <FormGrid>
                      <Field label="类型">
                        <Select
                          aria-label={`成本${i + 1}类型`}
                          disabled={disabled}
                          value={r.kind}
                          options={QUOTE_COST_KINDS.filter(
                            (k) =>
                              input.mode === "breakdown" ||
                              [
                                "packaging",
                                "freight",
                                "insurance",
                                "bank",
                                "commission",
                                "other",
                              ].includes(k),
                          ).map((value) => ({ value, label: kinds[value] }))}
                          onChange={(e) =>
                            patchRow(i, {
                              kind: e.target
                                .value as QuoteCostComponent["kind"],
                            })
                          }
                        />
                      </Field>
                      {(
                        [
                          "description",
                          "quantity",
                          "unit",
                          "lossPercent",
                          "unitPrice",
                          "basis",
                        ] as const
                      ).map((field, j) => (
                        <Field
                          key={field}
                          label={
                            [
                              "项目名称",
                              "每单位耗用量",
                              "耗用单位",
                              "损耗率 %",
                              "原币单价",
                              "项目依据",
                            ][j]
                          }
                          required
                        >
                          <TextInput
                            aria-label={`成本${i + 1}${["名称", "用量", "单位", "损耗", "单价", "依据"][j]}`}
                            value={r[field]}
                            disabled={disabled}
                            onChange={(e) =>
                              patchRow(i, { [field]: e.target.value })
                            }
                          />
                        </Field>
                      ))}
                      {input.mode === "supplier" && (
                        <Checkbox
                          label={`已确认第${i + 1}项不包含在供应商成品价中`}
                          disabled={disabled}
                          checked={r.outsideSupplierPrice}
                          onChange={(value) =>
                            patchRow(i, { outsideSupplierPrice: value })
                          }
                        />
                      )}
                    </FormGrid>
                    <div className="mist-card-body">
                      <Button
                        disabled={disabled}
                        onClick={() =>
                          patch(
                            "components",
                            input.components.filter((_, n) => n !== i),
                          )
                        }
                      >
                        移除此成本项
                      </Button>
                    </div>
                  </FormSection>
                ))}
              </>
            ) : step === 1 ? (
              <FormSection
                title="本次交易的人工报价策略"
                description="客户与交易因人因次而异，不预设大小客户利润率。"
              >
                <FormGrid>
                  <Field label="利润计算方式">
                    <Select
                      aria-label="利润计算方式"
                      value={input.method}
                      disabled={disabled}
                      options={[
                        {
                          value: "markup",
                          label: "成本加成率：成本 × (1＋比例)",
                        },
                        {
                          value: "margin",
                          label: "销售毛利目标：成本 ÷ (1－比例)",
                        },
                      ]}
                      onChange={(e) => patch("method", e.target.value)}
                    />
                  </Field>
                  {inputField(
                    "targetPercent",
                    "目标百分比",
                    true,
                    "明确填写，不自动设置公司底线或客户分类加成。",
                  )}
                  {inputField(
                    "proposedPrice",
                    "人工拟报价",
                    true,
                    "报价单价两位小数；可与建议报价不同，须人工核对。",
                  )}
                  <Field
                    label="本次报价策略依据"
                    full
                    required
                    hint="本次数量、客户反馈、付款 / 服务风险、业务目标及可比依据；不得把客户体量当固定定价规则。"
                  >
                    <TextArea
                      aria-label="本次报价策略依据"
                      disabled={disabled}
                      value={input.strategyBasis}
                      onChange={(e) => patch("strategyBasis", e.target.value)}
                    />
                  </Field>
                </FormGrid>
              </FormSection>
            ) : (
              <>
                <CardHeader title="核对本次核算与写入范围" />
                <div className="mist-card-body mist-col">
                  <Facts
                    items={[
                      {
                        label: "单位参考成本（四位）",
                        value: calculation?.result.cost + " " + input.currency,
                      },
                      {
                        label: "建议报价（四位）",
                        value:
                          calculation?.result.suggestedPrice +
                          " " +
                          input.currency,
                      },
                      {
                        label: "建议报价（报价精度）",
                        value:
                          calculation?.result.suggestedQuotePrice +
                          " " +
                          input.currency,
                      },
                      {
                        label: "人工拟报价",
                        value: input.proposedPrice + " " + input.currency,
                      },
                      {
                        label: "预计单位价差",
                        value:
                          calculation?.result.unitDifference +
                          " " +
                          input.currency,
                      },
                      {
                        label: "拟报价毛利参考",
                        value:
                          calculation?.result.marginPercent === null
                            ? "无有效售价"
                            : calculation?.result.marginPercent + "%",
                      },
                    ]}
                  />
                  <KeyValue
                    items={[
                      {
                        label: "来源路径 / 基价",
                        value:
                          input.mode === "supplier"
                            ? "供应商成品报价 " +
                              input.supplierPrice +
                              " " +
                              input.currency
                            : "逐项专业拆解，无成品基价",
                      },
                      { label: "来源条件", value: input.sourceTerms },
                      {
                        label: "来源日期 / 有效期",
                        value:
                          input.sourceDate +
                          " / " +
                          (input.sourceValidUntil || "未记录"),
                      },
                      {
                        label: "成本项复核",
                        value:
                          calculation?.result.components
                            .map(
                              (x) =>
                                x.description +
                                "：" +
                                x.quantity +
                                " " +
                                x.unit +
                                " × " +
                                x.unitPrice +
                                " " +
                                input.currency +
                                "；损耗 " +
                                x.lossPercent +
                                "% → " +
                                x.amount +
                                " " +
                                input.currency,
                            )
                            .join("；") || "没有额外成本项",
                      },
                      { label: "成本依据", value: input.basis },
                      { label: "本次策略", value: input.strategyBasis },
                      {
                        label: "适用规格 / 单位",
                        value: input.sourceSpecification + " / " + input.unit,
                      },
                    ]}
                  />
                  <Checkbox
                    label="我确认将人工拟报价写入这条报价行"
                    checked={applyPrice}
                    disabled={disabled}
                    onChange={setApplyPrice}
                  />
                  <Banner tone="warn" title="保存核算后成本仍待负责人审批">
                    保存会追加不可覆盖快照、更新本行成本待核口径，并使既有审批失效保留历史。只有勾选才改本行售价及报价总额，不改其他行或订单，不发送给客户。
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
                <Button
                  variant="primary"
                  disabled={disabled}
                  onClick={() => {
                    if (step === 0) {
                      try {
                        calculateQuoteCosting({
                          ...input,
                          targetPercent: "0",
                          strategyBasis: "仅校验成本来源，未记录策略",
                        });
                      } catch (e) {
                        setFailure(
                          e instanceof Error ? e.message : "请补齐本步来源",
                        );
                        return;
                      }
                    }
                    if (step === 1 && !calculation) {
                      setFailure(problem);
                      return;
                    }
                    setFailure("");
                    setStep(step + 1);
                  }}
                >
                  下一步
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={disabled || !calculation}
                  loading={busy}
                  onClick={() => void save()}
                >
                  保存核算快照
                </Button>
              )}
            </div>
          </Card>
        </div>
      ) : lineSnapshots.length ? (
        <div className="mist-col">
          {[...lineSnapshots].reverse().map((r) => (
            <Snapshot key={r.id} r={r} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="本条目尚无专业核算快照"
          description="旧报价成本仍按原门禁处理；不替旧记录补造供应商依据。"
        />
      )}
      {lineSnapshots.length > 0 && (
        <Button
          icon={Download}
          onClick={() =>
            downloadModuleCsv(
              "报价条目核算.csv",
              [
                "快照",
                "模型",
                "日期",
                "成本",
                "币种",
                "单位",
                "建议报价",
                "人工拟报价",
                "写入售价",
                "成本依据",
                "策略依据",
              ],
              lineSnapshots.map((r) => [
                r.id,
                r.modelVersion,
                r.createdAt,
                r.result.cost,
                r.input.currency,
                r.input.unit,
                r.result.suggestedQuotePrice,
                r.input.proposedPrice,
                r.appliedPrice ? "是" : "否",
                r.input.basis,
                r.input.strategyBasis,
              ]),
            )
          }
        >
          导出本条目核算
        </Button>
      )}
    </MistPage>
  );
}
