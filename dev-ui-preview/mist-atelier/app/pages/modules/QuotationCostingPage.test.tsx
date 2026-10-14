// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { getByLabelText, getByRole, getAllByRole } from "@testing-library/dom";
import {
  createMistState,
  applyMistCommand,
  type MistContext,
} from "../../../../../server/src/shared/mistWorkspace";
import { MistRoot } from "../../../../../components/mist";
import { Nav } from "../../nav";
const bridge = vi.hoisted(() => ({
  w: null as any,
  write: true,
  csv: vi.fn(),
}));
vi.mock("../../runtime/workspace", () => ({
  useMistWorkspace: () => bridge.w,
}));
vi.mock("../../runtime/auth", () => ({
  useMistSession: () => ({
    user: { id: "sales" },
    hasPermission: () => bridge.write,
    hasRole: () => false,
    canAccessView: () => true,
  }),
}));
vi.mock("./ModuleWorkbench", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  downloadModuleCsv: bridge.csv,
}));
import { MARKET_PAGES } from "./MarketPages";
let host: HTMLElement, root: Root, route: any, ctx: MistContext;
const go = vi.fn();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const q = () =>
  bridge.w.state.market.quotations.find((x: any) => x.id === route.id)!;
function render() {
  const Page = MARKET_PAGES.quotations;
  act(() =>
    root.render(
      <MistRoot>
        <Nav.Provider
          value={{
            route,
            go,
            theme: "light",
            toggleTheme: vi.fn(),
            openPalette: vi.fn(),
            openAI: vi.fn(),
          }}
        >
          <Page />
        </Nav.Provider>
      </MistRoot>,
    ),
  );
}
function field(name: string, value: string) {
  const e = getByLabelText(host, name) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      e.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : e.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
      "value",
    )!.set!.call(e, value);
    e.dispatchEvent(
      new Event(e.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
async function click(name: string) {
  await act(async () =>
    getAllByRole(host, "button", { name, exact: true })[0].click(),
  );
}
async function fill() {
  field("适用规格", "软件验收 150cm");
  field("来源日期", "2026-10-14");
  field("来源供应商", bridge.w.state.market.suppliers[0].id);
  field("供应商成品单价", "10");
  field("来源交付与费用包含条件", "软件验收 FOB 包含加工包装，不含运输");
  field("成本来源依据", "软件验收，非真实成本");
  await click("下一步");
  field("目标百分比", "25");
  field("人工拟报价", "14");
  field("本次报价策略依据", "本次软件验收人工策略，不按客户体量固定加成");
}
beforeEach(() => {
  let n = 0;
  ctx = {
    id: () => `quote-cost-ui-${++n}`,
    now: "2026-10-14T08:00:00.000Z",
    actorName: "软件验收",
    actorId: "sales",
    authority: { supplier: {}, businessReviewerId: "reviewer" },
  };
  const state = createMistState(ctx, "demo");
  const quote = state.market.quotations.find((q) => q.code === "QT-2026-0005")!;
  quote.status = "Draft";
  quote.approval = null;
  quote.convertedOrderId = null;
  route = {
    view: "quotations",
    id: quote.id,
    section: "costing:" + quote.lines[0].id,
  };
  bridge.w = {
    state,
    workspace: { id: "space" },
    loading: false,
    saving: false,
    error: "",
    pending: null,
    refresh: vi.fn(),
    recover: vi.fn(),
    run: vi.fn(async (command) => {
      const r = applyMistCommand(bridge.w.state, command, ctx);
      bridge.w.state = r.state;
      render();
      return r;
    }),
  };
  bridge.write = true;
  bridge.csv.mockReset();
  go.mockReset().mockImplementation((view, id, extra) => {
    route = { view, id, ...extra };
    render();
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
it("enters exact line from quote detail and returns to exact quote", async () => {
  const line = q().lines[0];
  route.section = undefined;
  render();
  await click("条目核算");
  expect(go).toHaveBeenLastCalledWith("quotations", q().id, {
    section: "costing:" + line.id,
  });
  expect(host.textContent).toContain("报价条目核算");
  await click("返回报价");
  expect(go).toHaveBeenLastCalledWith("quotations", q().id);
});
it("freezes sources without silently applying selling price, then exports only exact line snapshots", async () => {
  const original = structuredClone(q()),
    otherOrders = structuredClone(bridge.w.state.orders);
  render();
  await fill();
  await click("下一步");
  expect(host.textContent).toContain("12.50");
  expect(
    (
      getByLabelText(
        host,
        "我确认将人工拟报价写入这条报价行",
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
  await click("保存核算快照");
  expect(q().lines[0].price).toBe(original.lines[0].price);
  expect(q().lines[0].cost).toBe("10.00");
  expect(q().costingSnapshots).toHaveLength(1);
  expect(bridge.w.state.orders).toEqual(otherOrders);
  expect(host.textContent).toContain("已冻结条目核算");
  await click("导出本条目核算");
  expect(bridge.csv.mock.calls[0][2]).toHaveLength(1);
});
it("distinguishes target gross margin and applies only manually selected quote price", async () => {
  render();
  await fill();
  field("利润计算方式", "margin");
  await click("下一步");
  expect(host.textContent).toContain("13.33");
  act(() =>
    (
      getByLabelText(
        host,
        "我确认将人工拟报价写入这条报价行",
      ) as HTMLInputElement
    ).click(),
  );
  await click("保存核算快照");
  expect(q().lines[0].price).toBe("14.00");
  expect(q().requiresApproval).toBe(true);
  expect(q().status).toBe("Draft");
});
it("supports manual professional breakdown without a supplier base and explicit quantities", async () => {
  render();
  field("核算路径", "breakdown");
  field("适用规格", "测试成衣/件");
  field("来源日期", "2026-10-14");
  field("来源交付与费用包含条件", "同币种，每件耗用");
  field("成本来源依据", "人工来源");
  await click("增加成本项");
  field("成本1类型", "fabric");
  field("成本1名称", "测试面料");
  field("成本1用量", "2");
  field("成本1单位", "米");
  field("成本1损耗", "10");
  field("成本1单价", "3");
  field("成本1依据", "软件验收");
  await click("下一步");
  field("目标百分比", "20");
  field("本次报价策略依据", "软件验收本次交易");
  await click("下一步");
  expect(host.textContent).toContain("6.6000");
  await click("保存核算快照");
  expect(q().costingSnapshots[0].input.mode).toBe("breakdown");
  expect(q().costingSnapshots[0].supplier).toBeNull();
});
it("rejects missing explicit figures and preserves draft", async () => {
  render();
  await fill();
  field("目标百分比", "");
  await click("下一步");
  expect(host.textContent).toContain("核算未完成");
  expect(bridge.w.run).not.toHaveBeenCalled();
  expect(
    (getByLabelText(host, "本次报价策略依据") as HTMLTextAreaElement).value,
  ).toContain("人工策略");
});
it("server rejects unit mismatch and keeps all inputs for correction", async () => {
  render();
  field("成本计价单位", "公斤");
  await fill();
  await click("下一步");
  await click("保存核算快照");
  expect(host.textContent).toContain("不自动换算");
  await click("上一步");
  await click("上一步");
  expect((getByLabelText(host, "成本计价单位") as HTMLInputElement).value).toBe(
    "公斤",
  );
  expect(q().costingSnapshots || []).toHaveLength(0);
});
it("does not treat incomplete receipt as success", async () => {
  bridge.w.run.mockResolvedValue({ result: { id: route.id } });
  render();
  await fill();
  await click("下一步");
  await click("保存核算快照");
  expect(host.textContent).toContain("回执缺少准确核算快照");
  expect(getByRole(host, "button", { name: "保存核算快照" })).toBeTruthy();
});
it("same-tick duplicate save is locked while the exact request is in flight", async () => {
  let resolve: any;
  bridge.w.run.mockImplementation(() => new Promise((r) => (resolve = r)));
  render();
  await fill();
  await click("下一步");
  const b = getByRole(host, "button", { name: "保存核算快照" });
  act(() => {
    b.click();
    b.click();
  });
  expect(bridge.w.run).toHaveBeenCalledTimes(1);
  await act(async () =>
    resolve({
      result: { id: route.id, lineId: q().lines[0].id, snapshotId: "test" },
    }),
  );
});
it("rejects optimistic stale commercial terms without rerunning or discarding input", async () => {
  render();
  await fill();
  await click("下一步");
  q().paymentTerms = "changed after draft";
  render();
  await click("保存核算快照");
  expect(host.textContent).toContain("已变化");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("does not manufacture snapshots or another line for a missing exact target", () => {
  route.section = "costing:foreign";
  render();
  expect(host.textContent).toContain("未找到指定报价条目");
  expect(host.textContent).not.toContain("供应商成品单价");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("keeps sent quote or unauthorized role read-only", () => {
  q().status = "Sent";
  render();
  expect(host.textContent).toContain("本版本只读");
  expect(host.querySelector("input")).toBeNull();
  q().status = "Draft";
  bridge.write = false;
  render();
  expect(host.textContent).toContain("没有报价写权限");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("recovers original pending request, never repeats a save, and rejects unrelated receipt", async () => {
  bridge.w.pending = { requestId: "original" };
  bridge.w.recover.mockResolvedValue({
    result: { id: "other", snapshotId: "wrong", lineId: "wrong" },
  });
  render();
  expect(
    (getByRole(host, "button", { name: "下一步" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await click("核对原请求");
  expect(bridge.w.recover).toHaveBeenCalledTimes(1);
  expect(bridge.w.run).not.toHaveBeenCalled();
  expect(host.textContent).toContain("不属于当前报价条目");
});
it("late response from another workspace cannot replace current draft", async () => {
  let reject: any;
  bridge.w.run.mockImplementation(() => new Promise((_, r) => (reject = r)));
  render();
  await fill();
  await click("下一步");
  act(() => getByRole(host, "button", { name: "保存核算快照" }).click());
  bridge.w.workspace = { id: "other-space" };
  render();
  expect(
    (getByLabelText(host, "成本来源依据") as HTMLTextAreaElement).value,
  ).toBe("");
  await act(async () => reject(Error("OLD RESPONSE")));
  expect(host.textContent).not.toContain("OLD RESPONSE");
  expect(host.textContent).not.toContain("已冻结条目核算");
});
it("copies immutable latest input into a new draft and never overwrites previous snapshot", async () => {
  render();
  await fill();
  await click("下一步");
  await click("保存核算快照");
  const first = structuredClone(q().costingSnapshots[0]);
  await click("新建核算");
  field("供应商成品单价", "20");
  await click("下一步");
  await click("下一步");
  await click("保存核算快照");
  expect(q().costingSnapshots).toHaveLength(2);
  expect(q().costingSnapshots[0]).toEqual(first);
  expect(q().costingSnapshots[1].result.cost).toBe("20.0000");
});

it("retains a read-only history route after ordinary quote editing recreates line ids", async () => {
  render();
  await fill();
  await click("下一步");
  await click("保存核算快照");
  const old = structuredClone(q().costingSnapshots[0]),
    quote = q();
  const changed = applyMistCommand(
    bridge.w.state,
    {
      type: "market.quotation.save",
      payload: {
        id: quote.id,
        input: {
          customerId: quote.customerId,
          currency: quote.currency,
          season: quote.season,
          validUntil: quote.validUntil,
          deliveryTerms: quote.deliveryTerms,
          paymentTerms: quote.paymentTerms,
          lines: quote.lines,
        },
      },
    },
    ctx,
  );
  bridge.w.state = changed.state;
  route.section = undefined;
  render();
  await click("查看全部核算历史");
  expect(go).toHaveBeenLastCalledWith("quotations", quote.id, {
    section: "cost-history",
  });
  expect(host.textContent).toContain("报价核算历史");
  expect(host.textContent).toContain(old.id);
  expect(host.querySelector("input")).toBeNull();
  expect(q().lines[0].id).not.toBe(old.lineId);
  expect(q().costingSnapshots[0]).toEqual(old);
});

it("manually confirms historical evidence without importing its price, then exports the frozen source", async () => {
  render();
  await fill();
  const select = getByLabelText(host, "本次历史依据") as HTMLSelectElement;
  const option = Array.from(select.options).find(
    (o) => o.value && o.textContent?.includes("QT-2026-0003"),
  )!;
  expect(option).toBeDefined();
  field("本次历史依据", option.value);
  await click("下一步");
  expect(host.textContent).toContain("请确认历史条件");
  field("采用理由与差异处理", "软件验收人工对照：数量规格不同，价格不直接沿用");
  const check = getByRole(host, "checkbox", {
    name: "我已人工核对历史条件及未知项，确认仅作为本次依据",
  });
  act(() => check.click());
  await click("下一步");
  expect(host.textContent).toContain("软件验收人工对照");
  await click("保存核算快照");
  const evidence = q().costingSnapshots?.at(-1)?.historyEvidence;
  expect(evidence?.source.quoteCode).toBe("QT-2026-0003");
  expect(q().lines[0].price).not.toBe("14.00");
  expect(host.textContent).toContain("人工确认的历史依据");
  await click("导出本条目核算");
  expect(JSON.stringify(bridge.csv.mock.calls)).toContain(
    "quote-history-evidence-v1",
  );
  await click("新建核算");
  await click("下一步");
  expect(
    (getByLabelText(host, "本次历史依据") as HTMLSelectElement).value,
  ).toBe("");
});
it("source changes after selection cannot be frozen silently", async () => {
  render();
  await fill();
  const select = getByLabelText(host, "本次历史依据") as HTMLSelectElement;
  const option = Array.from(select.options).find((o) => o.value)!;
  field("本次历史依据", option.value);
  field("采用理由与差异处理", "软件验收核对");
  act(() =>
    getByRole(host, "checkbox", {
      name: "我已人工核对历史条件及未知项，确认仅作为本次依据",
    }).click(),
  );
  const [qid] = JSON.parse(option.value);
  bridge.w.state.market.quotations.find(
    (x: any) => x.id === qid,
  ).responseEvidence = "new";
  render();
  expect(host.textContent).toContain("原历史依据已变化");
  await click("下一步");
  expect(host.textContent).toContain("请重新选择并核对历史依据");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
