// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  getByLabelText,
  getByRole,
  getAllByRole,
  queryByRole,
} from "@testing-library/dom";
import {
  createMistState,
  type MistState,
} from "../../../../../server/src/shared/mistWorkspace";
import { MistRoot } from "../../../../../components/mist";
import { Nav } from "../../nav";
import {
  quotationHistoryRows,
  quotationHistoryFacts,
  historyBase,
  historyExport,
  currentHistoryFeedback,
  historyCost,
} from "./QuotationHistory";
const bridge = vi.hoisted(() => ({
  w: null as any,
  allowed: true,
  csv: vi.fn(),
}));
vi.mock("../../runtime/workspace", () => ({
  useMistWorkspace: () => bridge.w,
}));
vi.mock("../../runtime/auth", () => ({
  useMistSession: () => ({
    user: { id: "reader" },
    hasPermission: () => false,
    canAccessView: () => bridge.allowed,
  }),
}));
vi.mock("./ModuleWorkbench", async (original) => ({
  ...(await original<any>()),
  downloadModuleCsv: bridge.csv,
}));
import { MARKET_PAGES } from "./MarketPages";
let host: HTMLElement, root: Root, route: any, state: MistState;
const go = vi.fn();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const base = () => state.market.quotations.find((x) => x.id === "current")!;
const other = () => state.market.quotations.find((x) => x.id === "historical")!;
const filter = {
  source: "same",
  customer: "same",
  base: "same",
  query: "",
} as const;
const rows = () => quotationHistoryRows(state, base(), base().lines[0], filter);
beforeEach(() => {
  let n = 0;
  state = createMistState(
    {
      id: () => `history-test-${++n}`,
      actorName: "软件测试",
      now: "2026-10-14T04:00:00Z",
    },
    "demo",
  );
  const template = structuredClone(
    state.market.quotations.find((x) => x.status === "Sent")!,
  );
  template.id = "current";
  template.code = "TEST-CURRENT";
  template.lines = [
    {
      ...template.lines[0],
      id: "current-line",
      price: "12.00",
      qty: "10",
      specification: "软件测试规格",
    },
  ];
  template.status = "Draft";
  template.approval = null;
  template.costingSnapshots = [];
  template.feedback = [];
  template.convertedOrderId = null;
  const historical = structuredClone(template);
  historical.id = "historical";
  historical.code = "TEST-HISTORY";
  historical.lines[0].id = "history-line";
  historical.lines[0].price = "15.00";
  historical.status = "Sent";
  historical.createdAt = "2026-10-01T04:00:00Z";
  state.market.quotations = [template, historical];
  bridge.w = {
    state,
    workspace: { id: "private-test" },
    loading: false,
    error: "",
    saving: false,
    pending: null,
    run: vi.fn(),
    refresh: vi.fn(async () => {}),
  };
  bridge.allowed = true;
  bridge.csv.mockReset();
  go.mockReset();
  route = {
    view: "quotations",
    id: "current",
    section: "compare:current-line",
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
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
async function click(name: string) {
  await act(async () =>
    getAllByRole(host, "button", { name, exact: true })[0].click(),
  );
}
function select(label: string, value: string) {
  const e = getByLabelText(host, label) as HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(e, value);
    e.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function pick() {
  await act(async () =>
    getByRole(host, "row", { name: /TEST-HISTORY/ }).click(),
  );
}
it("excludes entire current quote, drafts, pending and all unsupported states", () => {
  const draft = structuredClone(other());
  draft.id = "draft";
  draft.status = "Draft";
  draft.approval = { status: "pending" } as any;
  state.market.quotations.push(draft);
  expect(rows().map((x) => x.quote.id)).toEqual(["historical"]);
});
it("requires explicit customer/source/currency/unit expansion without inferring style identity", () => {
  other().customerId = "different";
  other().lines[0].productId = "other-product";
  other().currency = "EUR";
  other().lines[0].unit = "码";
  expect(rows()).toEqual([]);
  expect(
    quotationHistoryRows(state, base(), base().lines[0], {
      source: "all",
      customer: "all",
      base: "all",
      query: "",
    }),
  ).toHaveLength(1);
  expect(historyBase(base(), base().lines[0], other(), other().lines[0])).toBe(
    false,
  );
});
it("never matches unrelated sources by same name or style, but does preserve exact development versions", () => {
  base().lines[0].productId = "";
  base().lines[0].sourceDevId = "dev-exact";
  base().lines[0].sourceVersionId = "original-version";
  other().lines[0].productId = "";
  other().lines[0].sourceDevId = "different";
  expect(rows()).toEqual([]);
  other().lines[0].sourceDevId = "dev-exact";
  other().lines[0].sourceVersionId = "other-version";
  expect(rows()).toHaveLength(1);
  expect(
    quotationHistoryFacts(state, base(), base().lines[0], rows()[0]).find(
      (x) => x.label === "准确开发版本",
    )?.result,
  ).toBe("不同");
});
it("missing fields stay unknown and whitespace normalization does not imply semantic term equivalence", () => {
  other().lines[0].specification = "";
  other().paymentTerms = "T/T 30天";
  base().paymentTerms = "Net30";
  const facts = quotationHistoryFacts(
    state,
    base(),
    base().lines[0],
    rows()[0],
  );
  expect(facts.find((x) => x.label === "规格原文")?.result).toBe("待核对");
  expect(facts.find((x) => x.label === "付款条件原文")?.result).toBe("不同");
  other().lines[0].specification = " 软件测试规格 ";
  expect(
    quotationHistoryFacts(state, base(), base().lines[0], rows()[0]).find(
      (x) => x.label === "规格原文",
    )?.result,
  ).toBe("一致");
});
it("rejects invalid price/quantity bases rather than treating unknown as zero or doing conversions", () => {
  for (const value of ["", "0", "1e2", "-1", "2.123", "NaN"]) {
    other().lines[0].price = value;
    expect(rows()).toHaveLength(0);
  }
  other().lines[0].price = "15.00";
  other().lines[0].qty = "1e3";
  expect(rows()).toHaveLength(0);
});
it("keeps Sent/Accepted/Rejected/Expired and each exact historical revision as separate evidence, not transaction samples", () => {
  state.market.quotations = [
    base(),
    ...["Sent", "Accepted", "Rejected", "Expired"].map((status, i) => ({
      ...structuredClone(other()),
      id: "h" + i,
      code: "TEST-V" + i,
      status: status as any,
      revision: i + 1,
      lines: [{ ...other().lines[0], id: "l" + i }],
    })),
  ];
  expect(rows()).toHaveLength(4);
});
it("searches frozen specification/terms and current visible customer labels without mutation", () => {
  const before = JSON.stringify(state);
  expect(
    quotationHistoryRows(state, base(), base().lines[0], {
      ...filter,
      query: "软件测试规格",
    }),
  ).toHaveLength(1);
  expect(
    quotationHistoryRows(state, base(), base().lines[0], {
      ...filter,
      query: "not-found",
    }),
  ).toHaveLength(0);
  expect(JSON.stringify(state)).toBe(before);
});
it("does not attach unmatched old costing snapshots to a reconstructed line", () => {
  other().costingSnapshots = [{ lineId: "old-line" } as any];
  expect(historyCost(other(), other().lines[0])).toBeUndefined();
});
it("uses only leaf corrections and exact line or quote-wide feedback", () => {
  const input = {
    kind: "counteroffer",
    reasonOrigin: "customer",
    reasons: ["price"],
    evidence: "software original",
    receivedOn: "2026-10-01",
    lines: [
      {
        lineId: "history-line",
        price: "14.00",
        quantity: "",
        conditions: "only this line",
      },
    ],
    requestedTerms: "",
    correctionOfId: "",
  };
  other().feedback = [
    { id: "f1", input } as any,
    {
      id: "f2",
      input: {
        ...input,
        evidence: "project cancelled",
        correctionOfId: "f1",
        reasons: ["project"],
      },
    } as any,
    {
      id: "foreign-line",
      input: { ...input, lines: [{ lineId: "foreign" }] },
    } as any,
  ];
  expect(
    currentHistoryFeedback(other(), other().lines[0]).map((x) => x.id),
  ).toEqual(["f2"]);
  const data = historyExport(state, base(), base().lines[0], rows()[0]);
  expect(JSON.stringify(data)).toContain("project cancelled");
  expect(JSON.stringify(data)).not.toContain("software original");
});
it("initial screen does not automatically pick history or a lowest price, and comparison is read only for non-writers", async () => {
  render();
  expect(
    getByRole(host, "button", { name: "导出当前对照" }).hasAttribute(
      "disabled",
    ),
  ).toBe(true);
  expect(host.textContent).toContain("选择一条历史进行对照");
  await pick();
  expect(host.textContent).toContain("条件逐项对照");
  expect(getByRole(host,"table",{name:"报价条件对照"}).textContent).toContain("本次：");
  expect(getByRole(host,"table",{name:"报价条件对照"}).textContent).toContain("历史：");
  expect(getByRole(host,"table",{name:"报价条件对照"}).textContent).toContain("核对：");
  expect(host.textContent).toContain("未记录适用专业核算");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("exports only the explicit exact comparison and never changes state", async () => {
  const before = JSON.stringify(state);
  render();
  await pick();
  await click("导出当前对照");
  expect(bridge.csv).toHaveBeenCalledWith(
    "历史报价条件对照.csv",
    expect.any(Array),
    expect.arrayContaining([
      ["准确报价 ID", "current", "historical", "不同对象"],
    ]),
  );
  expect(JSON.stringify(state)).toBe(before);
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("shows mixed currency/unit evidence only after explicit expansion and warns no numeric comparison", async () => {
  other().currency = "EUR";
  other().lines[0].unit = "码";
  render();
  expect(host.textContent).toContain("没有符合条件");
  select("币种单位范围", "all");
  await pick();
  expect(host.textContent).toContain("不具备直接比较基础");
  expect(host.textContent).toContain("15.00 EUR/码");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("provides exact source returns and accurate current return", async () => {
  render();
  await pick();
  await click("查看准确报价");
  expect(go).toHaveBeenLastCalledWith("quotations", "current");
  await click("查看反馈及更正历史");
  expect(go).toHaveBeenLastCalledWith("quotations", "current", {
    section: "feedback",
  });
  await click("返回本次报价");
  expect(go).toHaveBeenLastCalledWith("quotations", "current");
});
it("reports missing exact target without a fallback or unauthorized disclosure", () => {
  route.section = "compare:missing";
  render();
  expect(host.textContent).toContain("未找到指定报价条目");
  expect(host.textContent).not.toContain("TEST-HISTORY");
  bridge.allowed = false;
  render();
  expect(host.textContent).toContain("没有报价读取权限");
  expect(host.textContent).not.toContain("TEST-HISTORY");
});
it("loading/error/retry preserve read-only behavior and do not claim refreshed success", async () => {
  bridge.w.loading = true;
  render();
  expect(getByRole(host,"table",{name:"历史报价条目"}).querySelectorAll(".mist-skel").length).toBeGreaterThan(0);
  bridge.w.loading = false;
  bridge.w.error = "offline";
  bridge.w.refresh.mockRejectedValueOnce(Error("still offline"));
  render();
  await click("重试读取");
  expect(host.textContent).toContain("still offline");
  expect(bridge.w.run).not.toHaveBeenCalled();
});
it("refresh losing selected history never falls back; changing workspace clears filters and selection", async () => {
  render();
  await pick();
  state.market.quotations = [base()];
  render();
  expect(host.textContent).toContain("所选历史已不在当前读取范围");
  expect(
    getByRole(host, "button", { name: "导出当前对照" }).hasAttribute(
      "disabled",
    ),
  ).toBe(true);
  select("历史客户范围", "all");
  bridge.w.workspace.id = "new-workspace";
  render();
  expect(
    (getByLabelText(host, "历史客户范围") as HTMLSelectElement).value,
  ).toBe("same");
  expect(host.textContent).toContain("选择一条历史进行对照");
});
it("mainline exposes an exact per-line history entry without removing costing or feedback", async () => {
  route = { view: "quotations", id: "current" };
  render();
  await click("历史条件对照");
  expect(go).toHaveBeenCalledWith("quotations", "current", {
    section: "compare:current-line",
  });
  expect(queryByRole(host, "button", { name: "条目核算" })).toBeTruthy();
  expect(queryByRole(host, "button", { name: "查看客户反馈" })).toBeTruthy();
});
