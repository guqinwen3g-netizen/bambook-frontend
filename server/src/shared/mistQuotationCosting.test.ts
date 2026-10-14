import { quotationHistorySource } from "./mistQuotationHistoryEvidence";
import { describe, it, expect } from "vitest";
import {
  calculateQuoteCosting,
  quotationCostingTarget,
  activeQuoteCostSnapshots,
  quoteCostModelVersion,
  type QuoteCostInput,
  type QuoteCostComponent,
} from "./mistQuotationCosting";
import {
  createMistState,
  applyMistCommand,
  mistCommandPermission,
  type MistContext,
  type MistCommand,
} from "./mistWorkspace";
const input = (): QuoteCostInput => ({
  mode: "supplier",
  currency: "USD",
  unit: "米",
  sourceSpecification: "150cm 棉布",
  supplierId: "supplier",
  supplierPrice: "100",
  sourceDate: "2026-10-14",
  sourceValidUntil: "2026-11-01",
  sourceTerms: "FOB 上海，含包装，不含运费",
  basis: "软件测试人工报价单，不是真实供应商价格",
  fileIds: [],
  components: [],
  method: "markup",
  targetPercent: "25",
  strategyBasis: "本次测试交易人工目标，不按客户体量固定加成",
  proposedPrice: "130",
});
const component = (
  patch: Partial<QuoteCostComponent> = {},
): QuoteCostComponent => ({
  kind: "freight",
  description: "未含运费",
  quantity: "1",
  unit: "次/米",
  lossPercent: "0",
  unitPrice: "0.02",
  basis: "软件测试运费依据",
  outsideSupplierPrice: true,
  ...patch,
});
function setup() {
  let n = 0;
  const ctx: MistContext = {
    id: () => `cost-${++n}`,
    now: "2026-10-14T08:00:00.000Z",
    actorName: "业务测试",
    actorId: "sales",
    authority: { supplier: {}, businessReviewerId: "reviewer" },
  };
  let s = createMistState(ctx, "empty");
  s.customers.push({
    id: "customer",
    name: "测试客户",
    code: "C",
    country: "CN",
    city: "",
    industry: "",
    owner: "业务",
    grade: "",
    currency: "USD",
    terms: "",
    incoterm: "",
    categories: "",
    creditLimit: 0,
    since: "2026-01-01",
  });
  const run = (c: MistCommand, cx = ctx) => {
    const r = applyMistCommand(s, c, cx);
    s = r.state;
    return r.result;
  };
  const supplier = run({
    type: "market.supplier.save",
    payload: {
      input: {
        code: "S1",
        name: "测试织厂",
        type: "面料",
        country: "CN",
        address: "绍兴",
        capabilities: "织造",
        capacity: 1,
        capacityUnit: "米",
        leadDays: 10,
      },
    },
  }).id!;
  const product = run({
    type: "market.product.save",
    payload: {
      input: {
        sku: "P1",
        name: "棉布",
        category: "fabric",
        season: "AW26",
        supplierId: supplier,
        supplierCode: "S1",
        composition: "棉",
        specification: "150cm",
        color: "蓝",
        unit: "米",
        cost: "10",
        currency: "USD",
        sourceDevId: "",
        sourceVersionId: "",
      },
    },
  }).id!;
  const qi = {
    customerId: "customer",
    currency: "USD",
    season: "AW26",
    validUntil: "2026-11-01",
    deliveryTerms: "FOB",
    paymentTerms: "T/T",
    lines: [10, 3].map((qty) => ({
      productId: product,
      sourceDevId: "",
      sourceVersionId: "",
      name: "棉布",
      style: "P1",
      specification: "150cm",
      qty: String(qty),
      unit: "米",
      price: "20",
      cost: "10",
    })),
  };
  const id = run({ type: "market.quotation.save", payload: { input: qi } }).id!;
  const q = () => s.market.quotations.find((q) => q.id === id)!;
  const command = (patch: any = {}) =>
    ({
      type: "market.quotation.costing.save",
      payload: {
        quotationId: id,
        lineId: q().lines[0].id,
        expectedTarget: quotationCostingTarget(q(), q().lines[0]),
        input: { ...input(), supplierId: supplier },
        applyPrice: false,
        ...patch,
      },
    }) as MistCommand;
  return { ctx, run, q, command, qi, id, supplier, state: () => s };
}
describe("quote-cost-v1 deterministic costing", () => {
  it("distinguishes markup from sales margin without rounding intermediate quantity", () => {
    expect(calculateQuoteCosting(input()).result).toMatchObject({
      cost: "100.0000",
      suggestedPrice: "125.0000",
      suggestedQuotePrice: "125.00",
      marginPercent: "23.0769",
    });
    expect(
      calculateQuoteCosting({ ...input(), method: "margin" }).result
        .suggestedPrice,
    ).toBe("133.3333");
    const r = calculateQuoteCosting({
      ...input(),
      mode: "breakdown",
      components: [
        component({
          quantity: "0.0001",
          lossPercent: "50",
          unitPrice: "10000",
        }),
      ],
    }).result;
    expect(r.cost).toBe("1.5000");
  });
  it("adds only explicitly excluded expenses to supplier base", () => {
    expect(
      calculateQuoteCosting({ ...input(), components: [component()] }).result
        .cost,
    ).toBe("100.0200");
    for (const row of [
      component({ kind: "fabric" }),
      component({ kind: "cmt" }),
      component({ outsideSupplierPrice: false }),
    ])
      expect(() =>
        calculateQuoteCosting({ ...input(), components: [row] }),
      ).toThrow(/不叠加/);
  });
  it("calculates garment component loss and never includes supplier base in breakdown", () => {
    const r = calculateQuoteCosting({
      ...input(),
      mode: "breakdown",
      supplierPrice: "9999",
      components: [
        component({
          kind: "fabric",
          quantity: "2",
          unitPrice: "3",
          lossPercent: "10",
        }),
        component({ kind: "cmt", quantity: "1", unitPrice: "2" }),
      ],
    }).result;
    expect(r.cost).toBe("8.6000");
    expect(r.approvalCost).toBe("8.60");
  });
  it.each(["", "1e3", "-1", "NaN", "0.00001", "10000000000"])(
    "rejects invalid explicit decimal %s",
    (value) => {
      expect(() =>
        calculateQuoteCosting({ ...input(), supplierPrice: value }),
      ).toThrow();
    },
  );
  it.each([
    { supplierPrice: "0" },
    { targetPercent: "100", method: "margin" },
    { sourceDate: "2026-02-30" },
    { sourceDate: "" },
    { basis: "" },
    { strategyBasis: "" },
    { sourceTerms: "" },
    { sourceSpecification: "" },
    { proposedPrice: "1.001" },
    { mode: "breakdown", components: [] },
    { components: [component({ lossPercent: "101" })] },
    { components: [component({ quantity: "0" })] },
  ])("rejects incomplete or unsafe model input %#", (patch) => {
    expect(() =>
      calculateQuoteCosting({ ...input(), ...patch } as QuoteCostInput),
    ).toThrow();
  });
  it("has no fabricated margin at zero proposed selling price", () =>
    expect(
      calculateQuoteCosting({ ...input(), proposedPrice: "0" }).result
        .marginPercent,
    ).toBeNull());
});
describe("exact quote-line snapshots and approval handoff", () => {
  it("saves server recomputed cost without silently applying a selling price", () => {
    const t = setup(),
      before = structuredClone(t.q());
    const receipt = t.run(
      t.command({
        input: { ...input(), supplierId: t.supplier, result: { cost: "1" } },
      }),
    );
    expect(receipt).toMatchObject({
      id: t.id,
      lineId: before.lines[0].id,
      snapshotId: expect.any(String),
    });
    expect(t.q().lines[0]).toMatchObject({
      cost: "100.00",
      costBasis: "unverified",
      price: "20",
      amount: "200.00",
    });
    expect(t.q().total).toBe(before.total);
    expect(t.q().lines[1]).toEqual(before.lines[1]);
    expect(t.q().costingSnapshots![0].result.cost).toBe("100.0000");
    expect(t.state().orders).toHaveLength(0);
    expect(t.q().requiresApproval).toBe(true);
  });
  it("applies only explicit manual selling price to exact line and updates quote total", () => {
    const t = setup();
    t.run(t.command({ applyPrice: true }));
    expect(t.q().lines[0]).toMatchObject({
      price: "130.00",
      amount: "1300.00",
    });
    expect(t.q().lines[1].price).toBe("20");
    expect(t.q().total).toBe("1360.00");
  });
  it.each([
    { currency: "CNY" },
    { unit: "码" },
    { supplierId: "foreign" },
    { fileIds: ["foreign"] },
  ])("rejects unmatched source without mutation %#", (patch) => {
    const t = setup(),
      before = structuredClone(t.state());
    expect(() =>
      t.run(
        t.command({ input: { ...input(), supplierId: t.supplier, ...patch } }),
      ),
    ).toThrow();
    expect(t.state()).toEqual(before);
  });
  it("rejects missing line, stale target, and same-timestamp repeated command", () => {
    const t = setup(),
      c = t.command();
    expect(() => t.run(t.command({ lineId: "foreign" }))).toThrow(/条目/);
    expect(() => t.run(t.command({ expectedTarget: "wrong" }))).toThrow(
      /已变化/,
    );
    t.run(c);
    expect(() => t.run(c)).toThrow(/已变化/);
    expect(t.q().costingSnapshots).toHaveLength(1);
  });
  it("guards commercial terms, attachments, note and other line edits", () => {
    for (const change of [
      (q: any) => (q.paymentTerms = "changed"),
      (q: any) => (q.note = "changed"),
      (q: any) => (q.fileIds = ["changed"]),
      (q: any) => (q.lines[1].price = "21.00"),
    ]) {
      const t = setup(),
        c = t.command();
      change(t.q());
      expect(() => t.run(c)).toThrow(/已变化/);
    }
  });
  it("freezes historical inputs, supplier identity and attachments independently of mutable sources", () => {
    const t = setup();
    t.state().files.push({
      id: "proof",
      name: "旧凭据.pdf",
      createdAt: t.ctx.now,
      size: 10,
      mimeType: "application/pdf",
      storageKey: "test",
    });
    t.run(
      t.command({
        input: { ...input(), supplierId: t.supplier, fileIds: ["proof"] },
      }),
    );
    const first = structuredClone(t.q().costingSnapshots![0]);
    t.state().market.suppliers[0].name = "改名";
    t.state().files[0].name = "改名附件";
    t.run(
      t.command({
        input: { ...input(), supplierId: t.supplier, targetPercent: "10" },
      }),
    );
    expect(t.q().costingSnapshots![0]).toEqual(first);
    expect(first.supplier!.name).toBe("测试织厂");
    expect(first.files[0].name).toBe("旧凭据.pdf");
    expect(activeQuoteCostSnapshots(t.q()).map((x) => x.id)).toEqual([
      t.q().costingSnapshots![1].id,
    ]);
  });
  it("archives old approval and sends only latest applicable snapshot to new approval", () => {
    const t = setup();
    t.run(t.command());
    t.run({ type: "market.quotation.submit", payload: { id: t.id } });
    t.run(
      {
        type: "market.quotation.decide",
        payload: { id: t.id, decision: "approved", note: "测试核实" },
      },
      { ...t.ctx, actorId: "reviewer" },
    );
    const approved = structuredClone(t.q().approval);
    t.run(
      t.command({
        input: { ...input(), supplierId: t.supplier, targetPercent: "10" },
      }),
    );
    expect(t.q().approval).toBeNull();
    expect(t.q().approvalHistory).toContainEqual(approved);
    expect(() =>
      t.run({
        type: "market.quotation.status",
        payload: { id: t.id, status: "Sent", evidence: "测试回执" },
      }),
    ).toThrow(/审批/);
    t.run({ type: "market.quotation.submit", payload: { id: t.id } });
    const details = t
      .q()
      .approval!.details.filter((d) => d.label === "核算快照");
    expect(details).toHaveLength(1);
    expect(details[0].value).toContain(t.q().costingSnapshots![1].id);
    expect(details[0].value).not.toContain(t.q().costingSnapshots![0].id);
  });
  it("includes latest exact file provenance but not replaced historical costing files in approval", () => {
    const t = setup();
    t.state().files.push(
      ...["old", "new"].map((id) => ({
        id,
        name: id,
        createdAt: t.ctx.now,
        size: 10,
        mimeType: "text/plain",
        storageKey: id,
      })),
    );
    for (const id of ["old", "new"])
      t.run(
        t.command({
          input: { ...input(), supplierId: t.supplier, fileIds: [id] },
        }),
      );
    t.run({ type: "market.quotation.submit", payload: { id: t.id } });
    expect(t.q().approval!.fileIds).toEqual(["new"]);
  });
  it("preserves history on quote editing but never reconnects snapshots to recreated line ids", () => {
    const t = setup();
    t.run(t.command());
    const old = structuredClone(t.q().costingSnapshots);
    t.run({
      type: "market.quotation.save",
      payload: {
        id: t.id,
        input: { ...t.qi, costingSnapshots: [{ id: "forged" }] } as any,
      },
    });
    expect(t.q().costingSnapshots).toEqual(old);
    expect(activeQuoteCostSnapshots(t.q())).toEqual([]);
  });
  it("cannot inject snapshots through new quote creation or revision", () => {
    const t = setup();
    const id = t.run({
      type: "market.quotation.save",
      payload: {
        input: { ...t.qi, costingSnapshots: [{ id: "forged" }] } as any,
      },
    }).id!;
    expect(
      t.state().market.quotations.find((q) => q.id === id)!.costingSnapshots,
    ).toEqual([]);
    t.run(t.command({ applyPrice: true }));
    t.run({ type: "market.quotation.submit", payload: { id: t.id } });
    t.run(
      {
        type: "market.quotation.decide",
        payload: { id: t.id, decision: "approved", note: "核实" },
      },
      { ...t.ctx, actorId: "reviewer" },
    );
    t.run({
      type: "market.quotation.status",
      payload: { id: t.id, status: "Sent", evidence: "测试交付" },
    });
    const newId = t.run({
      type: "market.quotation.save",
      payload: { input: { ...t.qi, previousId: t.id } },
    }).id!;
    expect(
      t.state().market.quotations.find((q) => q.id === newId)!.costingSnapshots,
    ).toEqual([]);
    expect(t.q().costingSnapshots).toHaveLength(1);
  });
  it.each(["pending", "Sent", "converted"])(
    "rejects immutable quote state %s",
    (status) => {
      const t = setup();
      if (status === "pending")
        t.run({ type: "market.quotation.submit", payload: { id: t.id } });
      else if (status === "Sent") t.q().status = "Sent";
      else t.q().convertedOrderId = "order";
      expect(() => t.run(t.command())).toThrow(/不可改写/);
    },
  );
  it("requires explicit apply choice, positive applied price and quotation permission", () => {
    const t = setup();
    expect(mistCommandPermission(t.command())).toBe("quotations:write");
    expect(() => t.run(t.command({ applyPrice: undefined }))).toThrow(/明确/);
    expect(() =>
      t.run(
        t.command({
          input: { ...input(), supplierId: t.supplier, proposedPrice: "0" },
          applyPrice: true,
        }),
      ),
    ).toThrow(/大于0/);
    expect(t.q().costingSnapshots).toEqual([]);
  });
});

describe("manual historical evidence freeze", () => {
  function fixture() {
    const t = setup();
    const source = structuredClone(t.q());
    source.id = "historical-quote";
    source.code = "QT-HISTORY";
    source.status = "Sent";
    source.lines[0].id = "historical-line";
    t.state().market.quotations.push(source);
    const reference = () => ({
      quotationId: source.id,
      lineId: source.lines[0].id,
      expectedSource: JSON.stringify(
        quotationHistorySource(t.state(), source, source.lines[0]),
      ),
      reason: "软件测试：规格不同，人工核对，不直接沿用价格",
      confirmed: true,
    });
    return { t, source, reference };
  }
  it("resolves exact server facts, ignores forged fields, preserves pricing and immutable source", () => {
    const { t, source, reference } = fixture();
    const oldPrice = t.q().lines[0].price;
    t.run(
      t.command({
        historyReference: {
          ...reference(),
          source: { line: { price: "0.01" } },
        },
      }),
    );
    const snap = t.q().costingSnapshots![0];
    expect(snap.historyEvidence).toMatchObject({
      version: "quote-history-evidence-v1",
      source: { quoteCode: "QT-HISTORY", line: { price: "20" } },
    });
    expect(t.q().lines[0].price).toBe(oldPrice);
    expect(snap.result.cost).toBe("100.0000");
    const frozen = JSON.stringify(snap.historyEvidence);
    const live = t.state().market.quotations.find((q) => q.id === source.id)!;
    live.lines[0].price = "999";
    live.status = "Rejected";
    t.state().customers[0].name = "改名";
    expect(JSON.stringify(snap.historyEvidence)).toBe(frozen);
    t.run({ type: "market.quotation.submit", payload: { id: t.id } });
    expect(
      t.q().approval!.details.find((d) => d.label === "人工历史依据")?.value,
    ).toContain("QT-HISTORY");
  });
  it.each([
    "missing",
    "self",
    "draft",
    "pending",
    "currency",
    "unit",
    "zero",
    "negative",
    "precision",
    "reason",
    "confirmed",
    "stale",
  ])("rejects %s with no mutation", (kind) => {
    const { t, source, reference } = fixture();
    const r = reference();
    if (kind === "missing") r.lineId = "missing";
    if (kind === "self") {
      r.quotationId = t.id;
      r.lineId = t.q().lines[0].id;
    }
    if (kind === "draft") source.status = "Draft";
    if (kind === "pending") {
      source.status = "Draft";
      source.approval = { id: "a", status: "pending" } as any;
    }
    if (kind === "currency") source.currency = "EUR";
    if (kind === "unit") source.lines[0].unit = "码";
    if (kind === "zero") source.lines[0].price = "0";
    if (kind === "negative") source.lines[0].qty = "-1";
    if (kind === "precision") source.lines[0].price = "2.001";
    if (kind === "reason") r.reason = "  ";
    if (kind === "confirmed") r.confirmed = false;
    if (kind === "stale") source.responseEvidence = "new actual response";
    const before = JSON.stringify(t.state());
    expect(() => t.run(t.command({ historyReference: r }))).toThrow();
    expect(JSON.stringify(t.state())).toBe(before);
  });
  it("freezes only current correction leaves and exact-line feedback; later correction cannot rewrite it", () => {
    const { t, source, reference } = fixture();
    const feedback = (id: string, correctionOfId: string, lineIds: string[]) =>
      ({
        id,
        input: {
          correctionOfId,
          lines: lineIds.map((lineId) => ({ lineId })),
          evidence: id,
        },
      }) as any;
    source.feedback = [
      feedback("old", "", []),
      feedback("corrected", "old", []),
      feedback("other", "", ["unrelated-line"]),
    ];
    const stale = reference();
    source.feedback.push(feedback("latest", "corrected", []));
    expect(() => t.run(t.command({ historyReference: stale }))).toThrow(
      "历史报价条件或反馈已变化",
    );
    t.run(t.command({ historyReference: reference() }));
    const evidence = t.q().costingSnapshots![0].historyEvidence!;
    expect(evidence.source.feedback.map((f) => f.id)).toEqual(["latest"]);
    t
      .state()
      .market.quotations.find(
        (q) => q.id === source.id,
      )!.feedback![3].input.evidence = "new text";
    expect(evidence.source.feedback[0].input.evidence).toBe("latest");
  });
  it("does not silently reuse prior history when making a new costing", () => {
    const { t, reference } = fixture();
    t.run(t.command({ historyReference: reference() }));
    t.run(t.command());
    expect(t.q().costingSnapshots![0].historyEvidence).toBeDefined();
    expect(t.q().costingSnapshots![1].historyEvidence).toBeUndefined();
  });
});

describe("exact quote-line fixed fee allocation", () => {
  const fee = (patch: Partial<QuoteCostComponent> = {}) =>
    component({
      scope: "per_line",
      lineOnlyConfirmed: true,
      description: "本行独享开版费",
      quantity: "1",
      unit: "笔",
      unitPrice: "100",
      ...patch,
    });
  it("adds fixed fees once, keeps variable expenses per unit, and versions only the new calculation", () => {
    const r = calculateQuoteCosting({
      ...input(),
      supplierPrice: "10",
      allocationQuantity: "10",
      components: [component({ unitPrice: "2" }), fee()],
    });
    expect(r.result).toMatchObject({
      cost: "22.0000",
      suggestedQuotePrice: "27.50",
      allocation: {
        quantity: "10.0000",
        total: "100.0000",
        unitCost: "10.0000",
      },
    });
    expect(r.result.components[1]).toMatchObject({
      amount: "10.0000",
      lineAmount: "100.0000",
      scope: "per_line",
      lineOnlyConfirmed: true,
    });
    expect(quoteCostModelVersion(r.input)).toBe(
      "quote-cost-line-allocation-v2",
    );
    expect(quoteCostModelVersion(calculateQuoteCosting(input()).input)).toBe(
      "quote-cost-v1",
    );
    expect(calculateQuoteCosting(input()).result.allocation).toBeUndefined();
  });
  it("sums four-decimal line fees before division, instead of summing rounded per-item thirds", () => {
    const r = calculateQuoteCosting({
      ...input(),
      supplierPrice: "10",
      allocationQuantity: "3",
      components: [
        fee({ unitPrice: "1" }),
        fee({ unitPrice: "1" }),
        fee({ unitPrice: "1" }),
      ],
    }).result;
    expect(r.components.map((x) => x.amount)).toEqual([
      "0.3333",
      "0.3333",
      "0.3333",
    ]);
    expect(r.allocation).toEqual({
      quantity: "3.0000",
      total: "3.0000",
      unitCost: "1.0000",
    });
    expect(r.cost).toBe("11.0000");
  });
  it("calculates fractional fabric quantities without numeric conversion or intermediate denominator rounding", () => {
    const r = calculateQuoteCosting({
      ...input(),
      mode: "breakdown",
      allocationQuantity: "0.0001",
      components: [fee({ unitPrice: "0.0001" })],
    }).result;
    expect(r.cost).toBe("1.0000");
    expect(
      calculateQuoteCosting({
        ...input(),
        allocationQuantity: "12.5",
        components: [fee()],
      }).result.cost,
    ).toBe("108.0000");
  });
  it.each(["", "0", "-1", "1e2", "1.00001", "Infinity"])(
    "rejects invalid allocation quantity %s",
    (allocationQuantity) => {
      expect(() =>
        calculateQuoteCosting({
          ...input(),
          allocationQuantity,
          components: [fee()],
        }),
      ).toThrow();
    },
  );
  it.each([
    { scope: "invented" },
    { lineOnlyConfirmed: false },
    { lossPercent: "1" },
  ])("rejects unclear scope, ownership or loss %j", (patch) => {
    expect(() =>
      calculateQuoteCosting({
        ...input(),
        allocationQuantity: "10",
        components: [fee(patch as any)],
      }),
    ).toThrow();
  });
  it("retains supplier exclusions and prevents allocating already-included fabric or CMT again", () => {
    for (const patch of [
      { outsideSupplierPrice: false },
      { kind: "fabric" },
      { kind: "cmt" },
    ])
      expect(() =>
        calculateQuoteCosting({
          ...input(),
          allocationQuantity: "10",
          components: [fee(patch as any)],
        }),
      ).toThrow(/不叠加/);
  });
  it("server rejects a forged denominator atomically even when supplied results look valid", () => {
    const t = setup(),
      before = JSON.stringify(t.state());
    expect(() =>
      t.run(
        t.command({
          input: {
            ...input(),
            supplierId: t.supplier,
            allocationQuantity: "100",
            components: [fee()],
          },
          result: { cost: "1" },
        }),
      ),
    ).toThrow("费用分摊数量须等于当前准确报价行数量");
    expect(JSON.stringify(t.state())).toBe(before);
  });
  it("freezes the exact denominator, preserves other lines, includes approval provenance and invalidates after quantity changes", () => {
    const t = setup(),
      other = structuredClone(t.q().lines[1]);
    t.run(
      t.command({
        input: {
          ...input(),
          supplierId: t.supplier,
          allocationQuantity: "10",
          components: [fee()],
        },
      }),
    );
    const snap = t.q().costingSnapshots![0];
    expect(snap.modelVersion).toBe("quote-cost-line-allocation-v2");
    expect(snap.result.cost).toBe("110.0000");
    expect(t.q().lines[1]).toEqual(other);
    expect(t.q().lines[0].price).toBe("20");
    expect(activeQuoteCostSnapshots(t.q())).toHaveLength(1);
    t.run({ type: "market.quotation.submit", payload: { id: t.id } });
    expect(
      t.q().approval!.details.find((d) => d.label === "本行整笔费用分摊")
        ?.value,
    ).toContain("100.0000 USD / 10.0000 米");
    t.q().lines[0].qty = "20";
    expect(activeQuoteCostSnapshots(t.q())).toHaveLength(0);
    expect(snap.result.allocation?.quantity).toBe("10.0000");
  });
});
