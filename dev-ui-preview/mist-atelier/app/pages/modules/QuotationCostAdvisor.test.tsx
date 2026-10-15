// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { getByRole, getByLabelText } from "@testing-library/dom";
import { MistRoot } from "../../../../../components/mist";
import { QuotationCostAdvisor } from "./QuotationCostAdvisor";
import { calculateQuoteCosting } from "../../../../../server/src/shared/mistQuotationCosting";
vi.mock("../../../../../services/apiService", () => ({
  apiService: { getAuthHeaders: () => ({ "X-Test-Auth": "verified" }) },
}));
let root: Root, host: HTMLDivElement, p: any, fetcher: any;
const response = (b: any, ok = true) => ({ ok, json: async () => b });
function result() {
  const input = { ...p.input, fileIds: [] };
  const advice = {
    summary: "软件测试 AI 审阅",
    risks: ["MOQ 未核实"],
    questions: ["补税费"],
    evidenceIds: ["quote-line:q:l"],
    strategy: { method: "margin", targetPercent: "25", reason: "人工目标参考" },
  };
  return {
    policyVersion: "quote-cost-advisor-v1",
    mode: "read_only",
    revision: p.revision,
    expectedTarget: p.expectedTarget,
    advice,
    cost: calculateQuoteCosting(input).result.cost,
    scenario: calculateQuoteCosting({
      ...input,
      ...advice.strategy,
      strategyBasis: advice.strategy.reason,
    }).result,
    sources: [{ id: "quote-line:q:l", label: "QT 软件验收" }],
  };
}
async function render() {
  await act(async () =>
    root.render(
      <MistRoot>
        <QuotationCostAdvisor {...p} />
      </MistRoot>,
    ),
  );
}
async function click(label: string) {
  await act(async () => getByRole(host, "button", { name: label }).click());
}
async function consent() {
  await act(async () => {
    const c = getByLabelText(
      host,
      "我授权将本次报价依据发送给已配置模型审阅",
    ) as HTMLInputElement;
    c.click();
  });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  p = {
    workspaceId: "w",
    revision: 3,
    sessionKey: "s",
    quotationId: "q",
    lineId: "l",
    expectedTarget: "exact",
    permitted: true,
    disabled: false,
    onAdopt: vi.fn(),
    input: {
      mode: "supplier",
      currency: "USD",
      unit: "件",
      sourceSpecification: "测试件",
      supplierId: "supplier",
      supplierPrice: "10",
      sourceDate: "2026-10-14",
      sourceValidUntil: "",
      sourceTerms: "已含CMT",
      basis: "人工测试依据",
      fileIds: ["private-file"],
      components: [],
      method: "markup",
      targetPercent: "20",
      strategyBasis: "软件验收人工策略",
      proposedPrice: "14",
    },
  };
  fetcher = vi.fn(async (url: string) =>
    response(url.endsWith("/status") ? { configured: true } : result()),
  );
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("requires explicit consent, omits attachments, and adopts only human strategy", async () => {
  await render();
  expect(getByRole(host, "button", { name: "请求 AI 审阅" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  await consent();
  await click("请求 AI 审阅");
  const call = fetcher.mock.calls.find((x: any) => !x[0].endsWith("/status"));
  expect(JSON.parse(call[1].body)).toMatchObject({
    consent: true,
    input: { fileIds: [] },
    expectedRevision: 3,
  });
  expect(call[1].headers["X-Test-Auth"]).toBe("verified");
  expect(host.textContent).toContain("13.33");
  expect(p.onAdopt).not.toHaveBeenCalled();
  await click("采纳至人工策略草稿");
  expect(p.onAdopt).toHaveBeenCalledWith(
    "margin",
    "25",
    expect.stringContaining("人工采纳 AI"),
  );
  expect(p.input.proposedPrice).toBe("14");
  expect(p.input.fileIds).toEqual(["private-file"]);
});
it("keeps manual work available when model is not configured", async () => {
  fetcher.mockResolvedValue(response({ configured: false }));
  await render();
  expect(host.textContent).toContain("服务器尚未配置模型");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(p.onAdopt).not.toHaveBeenCalled();
});
it("does not request any model or expose controls without permission", async () => {
  p.permitted = false;
  await render();
  expect(host.textContent).toContain("没有报价 AI 审阅权限");
  expect(fetcher).not.toHaveBeenCalled();
});
it("shows provider failure without applying or changing manual input", async () => {
  fetcher.mockImplementation(async (url: string) =>
    url.endsWith("/status")
      ? response({ configured: true })
      : response({ error: { message: "模型不可用" } }, false),
  );
  await render();
  await consent();
  await click("请求 AI 审阅");
  expect(host.textContent).toContain("模型不可用");
  expect(p.onAdopt).not.toHaveBeenCalled();
});
it("discards late answers after workspace or input changes", async () => {
  let finish: any;
  fetcher.mockImplementation((url: string) =>
    url.endsWith("/status")
      ? Promise.resolve(response({ configured: true }))
      : new Promise((r) => {
          finish = r;
        }),
  );
  await render();
  await consent();
  await click("请求 AI 审阅");
  const r = result();
  p = { ...p, input: { ...p.input, supplierPrice: "11" } };
  await render();
  await act(async () => finish(response(r)));
  expect(host.textContent).not.toContain("软件测试 AI 审阅");
  expect(p.onAdopt).not.toHaveBeenCalled();
  expect(
    getByLabelText(host, "我授权将本次报价依据发送给已配置模型审阅"),
  ).toHaveProperty("checked", false);
});
it("rejects forged source or price instead of presenting usable strategy", async () => {
  const r = result();
  r.scenario.suggestedQuotePrice = "999";
  fetcher.mockImplementation(async (url: string) =>
    response(url.endsWith("/status") ? { configured: true } : r),
  );
  await render();
  await consent();
  await click("请求 AI 审阅");
  expect(host.textContent).toContain("AI 计算回执不一致");
  expect(p.onAdopt).not.toHaveBeenCalled();
});
it("cancels and ignores the eventual response", async () => {
  let finish: any;
  fetcher.mockImplementation((url: string) =>
    url.endsWith("/status")
      ? Promise.resolve(response({ configured: true }))
      : new Promise((r) => {
          finish = r;
        }),
  );
  await render();
  await consent();
  await click("请求 AI 审阅");
  await click("取消审阅");
  await act(async () => finish(response(result())));
  expect(host.textContent).not.toContain("软件测试 AI 审阅");
  expect(p.onAdopt).not.toHaveBeenCalled();
});
it("does not send incomplete cost sources", async () => {
  p.input.supplierPrice = "";
  await render();
  await consent();
  expect(getByRole(host, "button", { name: "请求 AI 审阅" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(host.textContent).toContain("先补齐成本来源");
});
