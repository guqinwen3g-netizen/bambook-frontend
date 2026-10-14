import { describe, it, expect } from "vitest";
import {
  applyMistCommand,
  createMistState,
  mistCommandPermission,
  type MistCommand,
  type MistContext,
} from "./mistWorkspace";
import {
  quotationFeedbackTarget,
  validateQuoteFeedback,
  type QuoteFeedbackInput,
} from "./mistQuotationFeedback";
const input = (): QuoteFeedbackInput => ({
  kind: "considering",
  receivedOn: "2026-10-14",
  channel: "会议纪要",
  contact: "测试客户采购，经人工核实",
  evidence: "软件测试：客户表示仍在考虑，非真实反馈",
  reasonOrigin: "unknown",
  reasons: ["unknown"],
  reasonDetail: "客户未明确说明原因，不推定为价格",
  nextAction: "人工继续确认项目和交期，不自动发消息",
  followUpOn: "",
  requestedTerms: "",
  lines: [],
  fileIds: [],
  correctionOfId: "",
  correctionReason: "",
});
function setup() {
  let n = 0;
  const ctx: MistContext = {
    id: () => `feedback-${++n}`,
    now: "2026-10-14T08:00:00.000Z",
    actorId: "sales",
    actorName: "软件测试",
    authority: { supplier: {}, businessReviewerId: "reviewer" },
  };
  let s = createMistState(ctx, "demo");
  const q = () => s.market.quotations.find((x) => x.code === "QT-2026-0005")!;
  const run = (command: MistCommand) => {
    const r = applyMistCommand(s, command, ctx);
    s = r.state;
    return r.result;
  };
  const command = (patch: any = {}) =>
    ({
      type: "market.quotation.feedback.add",
      payload: {
        quotationId: q().id,
        expectedTarget: quotationFeedbackTarget(q()),
        input: input(),
        ...patch,
      },
    }) as MistCommand;
  return { ctx, q, run, command, state: () => s };
}
describe("structured quote feedback boundaries", () => {
  it("appends unknown reasons without inventing price or changing quote, approval, orders or money", () => {
    const t = setup(),
      before = structuredClone(t.q()),
      state = structuredClone(t.state());
    const r = t.run(t.command());
    expect(r).toMatchObject({ id: before.id, feedbackId: expect.any(String) });
    expect(t.q().feedback![0].input.reasons).toEqual(["unknown"]);
    const { feedback, updatedAt, ...rest } = t.q(),
      { updatedAt: oldAt, feedback: oldFeedback, ...old } = before;
    expect(rest).toEqual(old);
    for (const key of ["orders", "orderLines", "invoices", "payments"] as const)
      expect(t.state()[key]).toEqual(state[key]);
    expect(mistCommandPermission(t.command())).toBe("quotations:write");
  });
  it("records exact counteroffer price/quantity/conditions separately from unchanged selling price", () => {
    const t = setup(),
      line = t.q().lines[0],
      original = structuredClone(line);
    t.run(
      t.command({
        input: {
          ...input(),
          kind: "counteroffer",
          reasonOrigin: "customer",
          reasons: ["price", "payment"],
          reasonDetail: "客户明确提出两个条件",
          requestedTerms: "客户提出改变定金比例，尚未承诺",
          lines: [
            {
              lineId: line.id,
              price: "28.50",
              quantity: "2000.1250",
              conditions: "价格仅在本次数量且缩短交期时成立",
            },
          ],
        },
      }),
    );
    expect(t.q().lines[0]).toEqual(original);
    expect(t.q().feedback![0].input.lines[0]).toMatchObject({
      price: "28.50",
      quantity: "2000.1250",
    });
    expect(t.q().feedback![0].target.lines[0]).toEqual(original);
    expect(t.q().status).toBe("Sent");
  });
  it.each(["accepted", "declined"] as const)(
    "records reported %s without status transition or order conversion",
    (kind) => {
      const t = setup();
      t.run(t.command({ input: { ...input(), kind } }));
      expect(t.q().status).toBe("Sent");
      expect(t.q().responseEvidence).toBe("");
      expect(t.q().convertedOrderId).toBeNull();
    },
  );
  it("allows terms-only counteroffer without inventing a price or quantity", () => {
    const t = setup();
    t.run(
      t.command({
        input: {
          ...input(),
          kind: "counteroffer",
          requestedTerms: "仅提出延长账期，未报价格",
        },
      }),
    );
    expect(t.q().feedback![0].input.lines).toEqual([]);
  });
  it("separates explicit business interpretation from customer statements", () => {
    const t = setup();
    t.run(
      t.command({
        input: {
          ...input(),
          reasonOrigin: "business",
          reasons: ["project"],
          reasonDetail: "业务推测项目延期，客户尚未确认",
        },
      }),
    );
    expect(t.q().feedback![0].input.reasonOrigin).toBe("business");
  });
  it.each([
    { receivedOn: "2026-10-15" },
    { receivedOn: "2026-02-30" },
    { receivedOn: "" },
    { contact: "" },
    { evidence: "" },
    { nextAction: "" },
    { reasonOrigin: "" },
    { reasonDetail: "" },
    { reasons: [] },
    { reasonOrigin: "customer", reasons: ["unknown"] },
    { reasons: ["price"] },
    { reasons: ["unknown", "price"] },
    { reasons: ["fake"] },
    { kind: "constructor" },
    { followUpOn: "tomorrow" },
  ])(
    "rejects incomplete, future or mismatched reason information %#",
    (patch) => {
      const t = setup(),
        before = structuredClone(t.state());
      expect(() =>
        t.run(t.command({ input: { ...input(), ...patch } })),
      ).toThrow();
      expect(t.state()).toEqual(before);
    },
  );
  it.each(["1e2", "-1", "0", "1.001"])(
    "rejects invalid proposed customer price %s",
    (price) => {
      const t = setup();
      expect(() =>
        t.run(
          t.command({
            input: {
              ...input(),
              kind: "counteroffer",
              lines: [
                {
                  lineId: t.q().lines[0].id,
                  price,
                  quantity: "",
                  conditions: "",
                },
              ],
            },
          }),
        ),
      ).toThrow();
    },
  );
  it.each(["1e2", "-1", "0", "1.00001"])(
    "rejects invalid proposed customer quantity %s",
    (quantity) => {
      const t = setup();
      expect(() =>
        t.run(
          t.command({
            input: {
              ...input(),
              kind: "counteroffer",
              lines: [
                {
                  lineId: t.q().lines[0].id,
                  price: "",
                  quantity,
                  conditions: "",
                },
              ],
            },
          }),
        ),
      ).toThrow();
    },
  );
  it("rejects missing, foreign, duplicate or empty counteroffer lines", () => {
    for (const kind of ["foreign", "duplicate", "empty", "absent"]) {
      const t = setup(),
        line = {
          lineId: kind === "foreign" ? "foreign" : t.q().lines[0].id,
          price: kind === "empty" ? "" : "10",
          quantity: "",
          conditions: "",
        };
      const lines =
        kind === "absent" ? [] : kind === "duplicate" ? [line, line] : [line];
      expect(() =>
        t.run(
          t.command({ input: { ...input(), kind: "counteroffer", lines } }),
        ),
      ).toThrow();
    }
  });
  it("does not allow hidden counteroffer values under a non-counteroffer kind", () => {
    const t = setup();
    expect(() =>
      t.run(t.command({ input: { ...input(), requestedTerms: "hidden" } })),
    ).toThrow();
    expect(() =>
      t.run(
        t.command({
          input: {
            ...input(),
            lines: [
              {
                lineId: t.q().lines[0].id,
                price: "10",
                quantity: "",
                conditions: "",
              },
            ],
          },
        }),
      ),
    ).toThrow();
  });
  it("rejects unknown attachment and freezes exact attachment metadata and customer identity", () => {
    const t = setup();
    expect(() =>
      t.run(t.command({ input: { ...input(), fileIds: ["foreign"] } })),
    ).toThrow();
    t.state().files.push({
      id: "proof",
      name: "原反馈.txt",
      createdAt: t.ctx.now,
      mimeType: "text/plain",
      size: 10,
      storageKey: "test",
    });
    t.run(t.command({ input: { ...input(), fileIds: ["proof"] } }));
    const r = structuredClone(t.q().feedback![0]);
    t.state().files.find((x) => x.id === "proof")!.name = "后来改名";
    t.state().customers.find((x) => x.id === t.q().customerId)!.name =
      "后来客户名";
    t.run(t.command());
    expect(t.q().feedback![0]).toEqual(r);
    expect(r.files[0].name).toBe("原反馈.txt");
    expect(t.q().feedback![1].target.customerName).toBe("后来客户名");
  });
  it("corrects by appending a new record without rewriting old evidence and rejects correction branches", () => {
    const t = setup();
    t.run(t.command());
    const old = structuredClone(t.q().feedback![0]);
    const correction = {
      ...input(),
      correctionOfId: old.id,
      correctionReason: "测试更正，客户补充说明",
      reasonOrigin: "customer" as const,
      reasons: ["delivery" as const],
      reasonDetail: "客户补充交期原因",
    };
    expect(() =>
      t.run(t.command({ input: { ...correction, correctionReason: "" } })),
    ).toThrow();
    t.run(t.command({ input: correction }));
    expect(t.q().feedback![0]).toEqual(old);
    expect(t.q().feedback).toHaveLength(2);
    expect(() => t.run(t.command({ input: correction }))).toThrow(/仅可更正/);
    expect(() =>
      t.run(t.command({ input: { ...correction, correctionOfId: "foreign" } })),
    ).toThrow(/仅可更正/);
  });
  it("rejects stale status, commercial conditions and repeated same-timestamp request", () => {
    const t = setup(),
      c = t.command();
    t.run(c);
    expect(() => t.run(c)).toThrow(/已变化/);
    for (const change of [
      (q: any) => (q.status = "Accepted"),
      (q: any) => (q.lines[0].price = "1"),
      (q: any) => (q.paymentTerms = "changed"),
    ]) {
      const t = setup(),
        c = t.command();
      change(t.q());
      expect(() => t.run(c)).toThrow(/已变化/);
    }
  });
  it("blocks unsent drafts but permits later clarification on closed or converted versions without reopening them", () => {
    const t = setup();
    t.q().status = "Draft";
    expect(() => t.run(t.command())).toThrow(/未登记已发送/);
    for (const status of ["Rejected", "Expired", "Accepted"] as const) {
      t.q().status = status;
      t.run(t.command());
      expect(t.q().status).toBe(status);
    }
    t.q().convertedOrderId = t.state().orders[0].id;
    t.run(t.command());
    expect(t.q().convertedOrderId).toBe(t.state().orders[0].id);
  });
  it("does not accept forged histories through ordinary quote creation or inherit feedback into a new version", () => {
    const t = setup();
    t.run(t.command());
    const held = t
      .state()
      .market.relations.find(
        (x) => x.customerId === t.q().customerId && x.hold,
      );
    if (held)
      t.run({
        type: "market.relation.hold",
        payload: {
          id: held.id,
          frozen: false,
          reason: "软件测试：解除既有冻结后单独验证版本输入，不弱化主线门禁",
        },
      });
    const source = t.q(),
      qi = { ...source, previousId: source.id, feedback: [{ id: "forged" }] };
    const id = t.run({
      type: "market.quotation.save",
      payload: { input: qi as any },
    }).id!;
    expect(
      t.state().market.quotations.find((x) => x.id === id)!.feedback,
    ).toEqual([]);
    expect(t.q().feedback).toHaveLength(1);
  });
  it("pure validation preserves no client-generated totals or status fields", () => {
    const t = setup();
    expect(
      validateQuoteFeedback(
        { ...input(), total: "0", status: "Accepted" } as any,
        t.q(),
        "2026-10-14",
      ),
    ).not.toHaveProperty("status");
  });
});
