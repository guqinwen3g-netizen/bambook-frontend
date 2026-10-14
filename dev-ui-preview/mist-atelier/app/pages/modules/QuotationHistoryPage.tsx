import {View} from '../../../../../types';
/** T3 -> read-only condition comparison. Never writes quotes, prices, feedback or orders. */
import React from "react";
import { ArrowLeft, Download } from "lucide-react";
import {
  Banner,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  Facts,
  MistPage,
  Mono,
  ObjectCell,
  PageHeader,
  Pill,
  SearchField,
  Select,
  Toolbar,
  type Column,
} from "../../../../../components/mist";
import { useMistWorkspace } from "../../runtime/workspace";
import { useMistSession } from "../../runtime/auth";
import { useNav } from "../../nav";
import { useRouteScope } from "./useRouteDraft";
import { downloadModuleCsv } from "./ModuleWorkbench";
import { quotationStageLabel } from "./QuotationsPage";
import {
  QUOTE_FEEDBACK_KINDS,
  QUOTE_FEEDBACK_REASONS,
} from "../../../../../server/src/shared/mistQuotationFeedback";
import type {
  MarketQuotation,
  MarketQuoteLine,
} from "../../../../../server/src/shared/mistMarket";
import {
  quotationHistoryRows,
  quotationHistoryFacts,
  historyBase,
  historyCost,
  historyExport,
  currentHistoryFeedback,
  type HistoryRow,
  type HistoryFact,
  type HistoryFilter,
} from "./QuotationHistory";
const initial = (): HistoryFilter => ({
  source: "same",
  customer: "same",
  base: "same",
  query: "",
});
export function QuotationHistoryPage() {
  const w = useMistWorkspace(),
    session = useMistSession(),
    { route, go } = useNav(),
    scope = useRouteScope();
  const [filter, setFilter] = React.useState(initial),
    [picked, setPicked] = React.useState(""),
    [failure, setFailure] = React.useState("");
  const q = w.state?.market.quotations.find((x) => x.id === route.id),
    line = q?.lines.find(
      (x) => x.id === route.section?.slice("compare:".length),
    );
  const allowed = session.canAccessView(View.Quotations);
  const rows =
      allowed && w.state && q && line
        ? quotationHistoryRows(w.state, q, line, filter)
        : [],
    current = rows.find((x) => x.key === picked);
  const name = (id: string) =>
    w.state?.customers.find((x) => x.id === id)?.name || "客户身份不可见";
  const back = () => {
    if (scope.isCurrent()) go("quotations", q?.id || route.id);
  };
  const select = (key: keyof HistoryFilter, value: string) => {
    setPicked("");
    setFilter((f) => ({ ...f, [key]: value }));
  };
  const retry = async () => {
    setFailure("");
    try {
      await w.refresh();
    } catch (e) {
      if (scope.isCurrent())
        setFailure(e instanceof Error ? e.message : "读取失败");
    }
  };
  if (!allowed)
    return (
      <MistPage>
        <PageHeader title="历史报价条件对照" />
        <Banner title="没有报价读取权限">
          不展示本空间历史，不扩大授权范围。
        </Banner>
      </MistPage>
    );
  if (w.loading && !q)
    return (
      <MistPage>
        <PageHeader title="历史报价条件对照" />
        <EmptyState title="正在读取准确报价" />
      </MistPage>
    );
  if (!q || !line)
    return (
      <MistPage>
        <PageHeader title="历史报价条件对照" />
        {w.error && (
          <Banner
            tone="bad"
            title="读取未完成"
            actions={<Button onClick={() => void retry()}>重试读取</Button>}
          >
            {w.error}
          </Banner>
        )}
        <EmptyState
          title="未找到指定报价条目"
          description="不自动匹配首条产品，也不打开其他报价。"
          action={<Button onClick={back}>返回报价</Button>}
        />
        {failure && (
          <Banner tone="bad" title="读取失败">
            {failure}
          </Banner>
        )}
      </MistPage>
    );
  const facts =
    current && w.state ? quotationHistoryFacts(w.state, q, line, current) : [];
  const columns: Column<HistoryRow>[] = [
    {
      key: "quote",
      header: "报价版本 / 客户",
      width: "minmax(180px,1fr)",
      render: (r) => (
        <ObjectCell
          name={<Mono>{r.quote.code}</Mono>}
          meta={name(r.quote.customerId)}
        />
      ),
    },
    {
      key: "item",
      header: "准确条目",
      hideOnMobile: true,
      render: (r) => (
        <ObjectCell
          name={r.line.name}
          meta={r.line.style + " · " + r.line.specification}
        />
      ),
    },
    {
      key: "price",
      header: "原报价单价",
      align: "right",
      width: "145px",
      render: (r) => (
        <span className="mist-col">
          <span>
            {r.line.price} {r.quote.currency}
          </span>
          <small className="mist-note">
            /{r.line.unit || "单位未记录"} · {r.line.qty} {r.line.unit}
          </small>
        </span>
      ),
    },
    {
      key: "status",
      header: "主线状态",
      width: "115px",
      render: (r) => <Pill>{quotationStageLabel(r.quote)}</Pill>,
    },
  ];
  const comparisonColumns: Column<HistoryFact>[] = [
    { key: "label", header: "条件", width: "120px", render: (r) => r.label },
    { key: "current", header: "本次", render: (r) => <span>本次：{r.current}</span> },
    { key: "historical", header: "历史", render: (r) => <span className="mist-col"><span>历史：{r.historical}</span><small className="mist-note">核对：{r.result}</small></span> },
    {
      key: "result",
      header: "核对",
      width: "90px",
      hideOnMobile: true,
      render: (r) => (
        <Pill tone={r.result === "一致" ? "neutral" : "warn"}>{r.result}</Pill>
      ),
    },
  ];
  const evidence = (
    quote: MarketQuotation,
    l: MarketQuoteLine,
    title: string,
  ) => {
    const c = historyCost(quote, l),
      feedback = currentHistoryFeedback(quote, l),
      order = w.state?.orders.find((x) => x.id === quote.convertedOrderId);
    return (
      <Card>
        <CardHeader title={title} sub={quote.code + " · " + l.name} />
        <div className="mist-card-body mist-col">
          <Facts
            items={[
              { label: "创建时间（非交付时间）", value: quote.createdAt },
              {
                label: "原报价单价",
                value: l.price + " " + quote.currency + "/" + l.unit,
              },
              { label: "客户", value: name(quote.customerId) },
              { label: "主线状态", value: quotationStageLabel(quote) },
            ]}
          />
          {quote.deliveryEvidence && (
            <p className="mist-note">交付登记：{quote.deliveryEvidence}</p>
          )}
          {quote.responseEvidence && (
            <p className="mist-note">主线答复依据：{quote.responseEvidence}</p>
          )}
          <Banner title={c ? "适用专业核算依据" : "未记录适用专业核算"}>
            {c ? (
              <>
                <Mono>{c.id}</Mono>
                <p>
                  {c.modelVersion} · 参考成本 {c.result.cost} {c.input.currency}
                  /{c.input.unit}
                </p>
                <p>{c.input.basis}</p>
                <p>
                  来源日期 {c.input.sourceDate} · 来源有效期{" "}
                  {c.input.sourceValidUntil || "未记录"} · {c.input.sourceTerms}
                </p>
                <p>策略：{c.input.strategyBasis}</p>
              </>
            ) : (
              "仅保留报价条目原成本字段，不将其当作已核实实际成本，也不把失效旧快照接到新行。"
            )}
          </Banner>
          <div className="mist-row mist-module-actions">
            <Button onClick={() => go("quotations", quote.id)}>
              查看准确报价
            </Button>
            <Button
              onClick={() =>
                go("quotations", quote.id, { section: "costing:" + l.id })
              }
            >
              查看条目核算
            </Button>
            <Button
              onClick={() =>
                go("quotations", quote.id, { section: "feedback" })
              }
            >
              查看反馈及更正历史
            </Button>
            {quote.convertedOrderId && (
              <Button
                disabled={!order}
                onClick={() => go("orders/detail", quote.convertedOrderId!)}
              >
                查看来源订单
              </Button>
            )}
          </div>
          {quote.convertedOrderId && !order && (
            <Banner tone="warn" title="来源订单不可见">
              保留转单 ID，不猜其他订单；转单本身不证明已履约或实际利润。
            </Banner>
          )}
          <span className="mist-note">
            当前有效反馈 {feedback.length}{" "}
            条；被更正原文仍在完整历史中，不重复作为现行结论。
          </span>
          {feedback.map((f) => (
            <div className="mist-col" key={f.id}>
              <Mono>{f.id}</Mono>
              <span>
                {QUOTE_FEEDBACK_KINDS[f.input.kind]} · {f.input.receivedOn}
              </span>
              <span>
                {f.input.reasonOrigin === "customer"
                  ? "客户明确说明"
                  : f.input.reasonOrigin === "business"
                    ? "业务判断"
                    : "未说明 / 未知"}
                ：
                {f.input.reasons
                  .map((x) => QUOTE_FEEDBACK_REASONS[x])
                  .join("、")}
              </span>
              <p>{f.input.evidence}</p>
              <p className="mist-note">{f.input.reasonDetail}</p>
              {f.input.lines
                .filter((x) => x.lineId === l.id)
                .map((x) => (
                  <p key={x.lineId}>
                    客户提出：
                    {x.price
                      ? x.price + " " + quote.currency + "/" + l.unit
                      : "未提出单价"}
                    ；{x.quantity ? x.quantity + " " + l.unit : "未提出数量"}；
                    {x.conditions || "条目条件未说明"}
                  </p>
                ))}
              {f.input.requestedTerms && (
                <p>整体条件：{f.input.requestedTerms}</p>
              )}
            </div>
          ))}
        </div>
      </Card>
    );
  };
  return (
    <MistPage>
      <Button icon={ArrowLeft} onClick={back}>
        返回本次报价
      </Button>
      <PageHeader
        eyebrow={q.code + " · " + line.style}
        title="历史报价条件对照"
        description="先检索准确历史，再逐项核对条件；报价、还价和主线接受不是同一事实。"
        actions={
          <Button
            icon={Download}
            disabled={!current || w.loading || !!w.error}
            onClick={() => {
              if (current && w.state && scope.isCurrent())
                downloadModuleCsv(
                  "历史报价条件对照.csv",
                  ["字段", "本次", "历史", "核对结果 / 边界"],
                  historyExport(w.state, q, line, current),
                );
            }}
          >
            导出当前对照
          </Button>
        }
      />
      <Banner title="人工证据对照，不是推荐报价">
        只读取当前授权工作空间；列表客户名称沿当前档案显示，不冒充历史冻结名称。默认同客户、同来源标识、同币种同单位；标识相同不代表规格与商业条件相同。草稿及审批中记录不作为已对客历史，本次整份报价不列入候选。不自动取均价、换算、复制价格或推算客户承受区间；税费、MOQ、品质、交期及其他费用仍需从原始依据人工核对。
      </Banner>
      {w.error && (
        <Banner
          tone="bad"
          title="历史读取未完成"
          actions={<Button onClick={() => void retry()}>重试读取</Button>}
        >
          {w.error}
        </Banner>
      )}
      {failure && (
        <Banner tone="bad" title="读取失败">
          {failure}
        </Banner>
      )}
      <Card>
        <CardHeader title="本次准确条目" sub={name(q.customerId)} />
        <div className="mist-card-body">
          <Facts
            items={[
              { label: "条目", value: line.name + " · " + line.style },
              { label: "规格", value: line.specification || "未记录" },
              { label: "数量 / 单位", value: line.qty + " " + line.unit },
              {
                label: "原报价单价",
                value: line.price + " " + q.currency + "/" + line.unit,
              },
            ]}
          />
        </div>
      </Card>
      <Toolbar>
        <SearchField
          value={filter.query}
          onChange={(value) => select("query", value)}
          placeholder="搜索报价、客户、款号、规格或条件"
        />
        <Select
          aria-label="历史来源范围"
          value={filter.source}
          onChange={(e) => select("source", e.target.value)}
          options={[
            { value: "same", label: "同来源标识" },
            { value: "all", label: "全部来源（人工核对）" },
          ]}
        />
        <Select
          aria-label="历史客户范围"
          value={filter.customer}
          onChange={(e) => select("customer", e.target.value)}
          options={[
            { value: "same", label: "同客户" },
            { value: "all", label: "本空间全部客户" },
          ]}
        />
        <Select
          aria-label="币种单位范围"
          value={filter.base}
          onChange={(e) => select("base", e.target.value)}
          options={[
            { value: "same", label: "同币种同单位" },
            { value: "all", label: "全部币种单位（不换算）" },
          ]}
        />
      </Toolbar>
      <Card>
        <DataTable
          ariaLabel="历史报价条目"
          rows={rows}
          columns={columns}
          rowKey={(r) => r.key}
          selectedKey={current?.key}
          onRowClick={(r) => setPicked(r.key)}
          loading={w.loading}
          empty={
            <EmptyState
              title="没有符合条件的已对客历史"
              description="可明确扩大检索范围；空记录不代表零价格或客户不接受。"
              action={
                <Button
                  onClick={() => {
                    setPicked("");
                    setFilter(initial());
                  }}
                >
                  重置筛选
                </Button>
              }
            />
          }
          footer={
            <span>
              {rows.length} 条 ·
              保留各准确版本，不合并为独立成交样本；按创建时间排列，不是相似度排名。
            </span>
          }
        />
      </Card>
      {picked && !current && (
        <Banner tone="warn" title="所选历史已不在当前读取范围">
          未自动选择其他报价，请重新核对准确记录。
        </Banner>
      )}
      {current ? (
        <>
          <Card>
            <CardHeader
              title="条件逐项对照"
              sub={q.code + " ↔ " + current.quote.code}
            />
            <div className="mist-card-body">
              <Banner
                tone="warn"
                title={
                  historyBase(q, line, current.quote, current.line)
                    ? "同币种同单位只是比较基础"
                    : "币种、单位或数字依据不具备直接比较基础"
                }
              >
                原文一致不等于完整专业可比；缺字段标为待核对，不猜语义等价。不同币种
                / 单位只展示原数值，不计算价差。
              </Banner>
            </div>
            <DataTable
              ariaLabel="报价条件对照"
              rows={facts}
              columns={comparisonColumns}
              rowKey={(r) => r.label}
            />
          </Card>
          <section className="mist-grid">
            <div className="mist-col-6">{evidence(q, line, "本次依据")}</div>
            <div className="mist-col-6">
              {evidence(current.quote, current.line, "历史依据")}
            </div>
          </section>
        </>
      ) : (
        <EmptyState
          title="选择一条历史进行对照"
          description="不会自动选最低价，也不把历史接受或客户还价当作本次可成交价格。"
        />
      )}
    </MistPage>
  );
}
