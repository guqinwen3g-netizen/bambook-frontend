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
function field(label: string, value: string) {
  const e = getByLabelText(host, label) as HTMLInputElement;
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
async function click(label: string) {
  await act(async () =>
    getAllByRole(host, "button", { name: label, exact: true })[0].click(),
  );
}
async function facts(kind = "considering") {
  field("反馈类型", kind);
  field("反馈发生日期", "2026-10-14");
  field("反馈渠道", "软件验收会议纪要");
  field("反馈人及身份", "软件验收采购，非真实客户反馈");
  field("反馈事实与来源", "软件验收：客户尚在核对项目，未说明原因");
  await click("下一步");
}
function reasons() {
  field("原因来源", "unknown");
  field("原因说明与已知范围", "客户未明确说明原因，不猜为价格");
  field("下一步动作", "软件验收人工继续核对，不自动创建任务");
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T08:00:00Z"));
  let n = 0;
  ctx = {
    id: () => `f-ui-${++n}`,
    now: "2026-10-14T08:00:00.000Z",
    actorId: "sales",
    actorName: "软件测试",
  };
  const state = createMistState(ctx, "demo"),
    quote = state.market.quotations.find((q) => q.code === "QT-2026-0005")!;
  route = { view: "quotations", id: quote.id, section: "feedback-new" };
  bridge.w = {
    state,
    workspace: { id: "space" },
    loading: false,
    saving: false,
    error: "",
    pending: null,
    recover: vi.fn(),
    refresh: vi.fn(),
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
  vi.useRealTimers();
});
it("opens feedback from exact quote and never backfills legacy response evidence", async () => {
  route.section = undefined;
  render();
  await click("查看客户反馈");
  expect(go).toHaveBeenLastCalledWith("quotations", q().id, {
    section: "feedback",
  });
  expect(host.textContent).toContain("尚无结构化客户反馈");
  await click("登记反馈");
  expect((getByLabelText(host, "反馈类型") as HTMLSelectElement).value).toBe(
    "",
  );
  expect((getByLabelText(host, "反馈发生日期") as HTMLInputElement).value).toBe(
    "",
  );
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("saves unknown causes without changing prices, quote status, approvals, order or money", async () => {
  const original = structuredClone(q()),
    orders = structuredClone(bridge.w.state.orders),
    payments = structuredClone(bridge.w.state.payments);
  render();
  await facts();
  reasons();
  await click("下一步");
  await click("确认追加反馈");
  expect(route.section).toBe("feedback");
  expect(q().feedback).toHaveLength(1);
  expect(q().lines).toEqual(original.lines);
  expect(q().status).toBe(original.status);
  expect(q().approval).toEqual(original.approval);
  expect(bridge.w.state.orders).toEqual(orders);
  expect(bridge.w.state.payments).toEqual(payments);
  expect(host.textContent).toContain("客户未说明 / 原因未知");
  await click("导出本版反馈");
  expect(bridge.csv.mock.calls[0][2]).toHaveLength(1);
});
it("records explicit counteroffer conditions and keeps missing quantity distinct from zero", async () => {
  render();
  await facts("counteroffer");
  field("原因来源", "customer");
  act(() => (getByLabelText(host, "价格") as HTMLInputElement).click());
  field("原因说明与已知范围", "客户明确提出价格，不代表其他条件已接受");
  field("下一步动作", "人工复核后另出新版本");
  act(() =>
    (
      getByLabelText(
        host,
        "记录还价 · " + q().lines[0].style + " · " + q().lines[0].name,
      ) as HTMLInputElement
    ).click(),
  );
  field("条目1客户提出单价", "28.50");
  field("条目1变更条件", "须维持付款与数量条件");
  await click("下一步");
  expect(host.textContent).toContain("未提出数量");
  await click("确认追加反馈");
  expect(q().feedback[0].input.lines[0]).toMatchObject({
    price: "28.50",
    quantity: "",
  });
  expect(q().lines[0].price).toBe("29.80");
});
it("records business inference distinctly and requires a deliberate known cause", async () => {
  render();
  await facts("declined");
  field("原因来源", "business");
  field("原因说明与已知范围", "业务判断可能项目延期，非客户原话");
  field("下一步动作", "人工确认");
  await click("下一步");
  expect(host.textContent).toContain("请明确选择原因");
  act(() => (getByLabelText(host, "项目变化") as HTMLInputElement).click());
  await click("下一步");
  await click("确认追加反馈");
  expect(q().feedback[0].input.reasonOrigin).toBe("business");
  expect(host.textContent).toContain("业务判断（非客户原话）");
});
it("requires actual feedback type/date rather than defaults or future facts", async () => {
  render();
  await click("下一步");
  expect(host.textContent).toContain("请选择反馈类型");
  field("反馈类型", "considering");
  field("反馈发生日期", "2026-10-15");
  await click("下一步");
  expect(host.textContent).toContain("不能在未来");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("adds correction instead of rewriting old evidence", async () => {
  render();
  await facts();
  reasons();
  await click("下一步");
  await click("确认追加反馈");
  const first = structuredClone(q().feedback[0]);
  await click("追加更正");
  field("反馈事实与来源", "客户补充软件测试原因");
  await click("下一步");
  expect(host.textContent).toContain("请填写更正原因");
  field("更正原因", "补录客户明确说明");
  await click("下一步");
  reasons();
  await click("下一步");
  await click("确认追加反馈");
  expect(q().feedback).toHaveLength(2);
  expect(q().feedback[0]).toEqual(first);
  expect(q().feedback[1].input.correctionOfId).toBe(first.id);
  expect(host.textContent).toContain("已有后续更正");
  expect(getAllByRole(host, "button", { name: "追加更正" })).toHaveLength(1);
});
it("blocks unsent or unauthorized writes but keeps feedback history readable", () => {
  q().status = "Draft";
  render();
  expect(host.textContent).toContain("尚未登记报价已发送");
  expect(host.querySelector("input")).toBeNull();
  q().status = "Sent";
  bridge.write = false;
  render();
  expect(host.textContent).toContain("只读查看");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("does not fallback to another quote or correction record", () => {
  route.section = "feedback-correct:foreign";
  render();
  expect(host.textContent).toContain("未找到指定报价或被更正反馈");
  expect(host.querySelector("input")).toBeNull();
  route.id = "foreign-quote";
  route.section = "feedback-new";
  render();
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("retains complete draft on failure or incomplete receipt", async () => {
  bridge.w.run.mockResolvedValue({ result: { id: route.id } });
  render();
  await facts();
  reasons();
  await click("下一步");
  await click("确认追加反馈");
  expect(host.textContent).toContain("回执缺少准确反馈记录");
  await click("上一步");
  expect(
    (getByLabelText(host, "下一步动作") as HTMLTextAreaElement).value,
  ).toContain("人工继续核对");
});
it("locks same-tick double click and rejects stale quote target", async () => {
  let resolve: any;
  bridge.w.run.mockImplementation(() => new Promise((r) => (resolve = r)));
  render();
  await facts();
  reasons();
  await click("下一步");
  const b = getByRole(host, "button", { name: "确认追加反馈" });
  act(() => {
    b.click();
    b.click();
  });
  expect(bridge.w.run).toHaveBeenCalledTimes(1);
  await act(async () =>
    resolve({ result: { id: route.id, feedbackId: "saved" } }),
  );
});
it("refuses changed version conditions without sending a stale draft", async () => {
  render();
  await facts();
  reasons();
  await click("下一步");
  q().paymentTerms = "changed";
  render();
  await click("确认追加反馈");
  expect(host.textContent).toContain("已变化");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("recovers only matching pending feedback requests and never sends a second command", async () => {
  bridge.w.pending = {
    command: {
      type: "market.quotation.feedback.add",
      payload: { quotationId: route.id },
    },
  };
  bridge.w.recover.mockResolvedValue({
    result: { id: route.id, feedbackId: "original" },
  });
  render();
  await click("核对原请求");
  expect(bridge.w.recover).toHaveBeenCalledTimes(1);
  expect(bridge.w.run).not.toHaveBeenCalled();
  expect(route.section).toBe("feedback");
});
it("does not recover an unrelated business request and reports null recovery without success", async () => {
  bridge.w.pending = {
    command: { type: "market.quotation.status", payload: { id: route.id } },
  };
  render();
  expect(host.textContent).toContain("请在原业务核对");
  expect(bridge.w.recover).not.toHaveBeenCalled();
  bridge.w.pending = {
    command: {
      type: "market.quotation.feedback.add",
      payload: { quotationId: route.id },
    },
  };
  bridge.w.recover.mockResolvedValue(undefined);
  render();
  await click("核对原请求");
  expect(host.textContent).toContain("原请求仍待核对");
  expect(route.section).toBe("feedback-new");
});
it("ignores late response after switching workspaces and resets draft", async () => {
  let reject: any;
  bridge.w.run.mockImplementation(() => new Promise((_, r) => (reject = r)));
  render();
  await facts();
  reasons();
  await click("下一步");
  act(() => getByRole(host, "button", { name: "确认追加反馈" }).click());
  bridge.w.workspace = { id: "other" };
  render();
  expect(
    (getByLabelText(host, "反馈事实与来源") as HTMLTextAreaElement).value,
  ).toBe("");
  await act(async () => reject(Error("OLD WORKSPACE")));
  expect(host.textContent).not.toContain("OLD WORKSPACE");
  expect(route.section).toBe("feedback-new");
});
it("retries a real read error rather than hiding it as empty data", async () => {
  bridge.w.error = "read failed";
  bridge.w.refresh.mockRejectedValue(Error("retry failed"));
  render();
  await click("重试读取");
  expect(host.textContent).toContain("retry failed");
});
