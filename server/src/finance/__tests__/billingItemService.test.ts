/**
 * billingItemService.test.ts — DR-053 阶段 3：收费事项 + 成本记录（§15）
 *
 * 验收映射：
 *  - 费用四层：费用发生(CostRecord) → 收费决定(BillingItem) → 应收草稿(Draft) → 签发(Issued)
 *  - 来源带出默认客户/金额（Sample.shippingFee / customerRelationId）
 *  - 部分免收/抵货款：waived+offset > amount 拒绝；净应收派生不落库
 *  - 收费决定确认锁定（confirmed 后编辑 409）
 *  - 开票幂等：重复 invoice → recovered，不重复建票；netAmount 正确
 *  - 净应收 ≤ 0 → noReceivable 闭环不开票
 *  - 未确认开票 409 NOT_CONFIRMED；已开票取消 409
 *  - 建票失败回填 → BACKFILL_FAILED 可重试
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createBillingItem, createBillingItemInTx, listBillingItems, getBillingItem, updateBillingItem, confirmBillingItem, invoiceBillingItem, cancelBillingItem, createCostRecord, createCostRecordInTx, listCostCandidateRows } from '../billingItemService';

// mock 财务建票（billingItemService 依赖 createInvoice，测其自身逻辑 + 幂等编排）
vi.mock('../../finance/invoiceMutationService', () => ({
  createInvoice: vi.fn(async ({ input, prisma }: any) => {
    const invoice = { id: `INV__${input.sourceId}`, invoiceNumber: input.invoiceNumber, status: input.status, amount: input.amount, currency: input.currency, sourceType: input.sourceType, sourceId: input.sourceId, customerRelationId: input.customerRelationId, customerName: input.customerName, notes: input.notes };
    prisma.invoice.__testRegisterCanonicalAck(invoice);
    return {ok:true,data:{invoice}};
  }),
}));
import { createInvoice } from '../../finance/invoiceMutationService';

function makePrisma(seed: { samples?: any[]; relations?: any[]; orders?: any[]; invoices?: any[]; costRecords?: any[]; billingItems?: any[]; invoiceLines?: any[]; devCases?: any[]; batches?: any[]; seals?: any[]; orderLines?: any[]; shipments?: any[] } = {}) {
  const state: any = {
    billingItem: [...(seed.billingItems ?? [])],
    costRecord: [...(seed.costRecords ?? [])],
    invoiceLine: [...(seed.invoiceLines ?? [])],
    sample: [...(seed.samples ?? [])],
    relation: [...(seed.relations ?? [])],
    order: [...(seed.orders ?? [])],
    orderLine: [...(seed.orderLines ?? [])],
    invoice: [...(seed.invoices ?? [])],
    developmentCase: [...(seed.devCases ?? [])],
    sampleBatch: [...(seed.batches ?? [])],
    sealSample: [...(seed.seals ?? [])],
    shipment: [...(seed.shipments ?? [])],
  };
  // Explicit synthetic stored authority for these service orchestration fixtures.
  // Production permission and parent access helpers run unchanged.
  const scopes = ['invoices:read','invoices:write','invoices:reconcile','pricing:read','sensitive:cost'];
  state.userAccount = ['u1','u'].map(id => ({id,status:'active',deletedAt:null,primaryDeptId:null,roles:[{departmentId:null,role:{id:'role-super-admin',permissions:scopes.map(scope=>({permission:{scope}}))}}]}));
  state.userPermissionOverrides = [];
  state.orderLine = state.orderLine ?? [];
  state.quotation = [];
  for (const development of state.developmentCase) {
    if (!development.customerRelationId) development.customerRelationId = 'fixture-customer';
    if (!state.relation.some((relation:any)=>relation.id===development.customerRelationId)) state.relation.push({id:development.customerRelationId,deletedAt:null});
  }
  // Mock canonical ACK reads are separate from the native invoice fixture rows;
  // these old tests deliberately assert that canonical itself is mocked.
  const canonicalAcks = new Map<string, any>();
  const model = (name: string) => {
    const rows = state[name];
    return {
      findFirst: async ({ where }: any = {}) => rows.find((r: any) => matchWhere(r, where)) ?? (name === 'invoice' ? [...canonicalAcks.values()].find((r:any)=>matchWhere(r,where)) : null) ?? null,
      findUnique: async ({where}:any={}) => rows.find((r:any)=>matchWhere(r,where)) ?? null,
      findMany: async ({ where }: any = {}) => rows.filter((r: any) => matchWhere(r, where)),
      create: async ({ data }: any) => { rows.push(data); return data; },
      update: async ({ where, data }: any) => {
        const r = rows.find((x: any) => x.id === where.id);
        Object.assign(r, data);
        return r;
      },
      count: async ({ where }: any = {}) => rows.filter((r: any) => matchWhere(r, where)).length,
    };
  };
  const prisma: any = { $transaction: vi.fn(async (fn: any) => {
    const beforeAcks = new Map(canonicalAcks);
    try { return await fn(tx); }
    catch (error) {canonicalAcks.clear();for(const [id,ack] of beforeAcks)canonicalAcks.set(id,ack);throw error;}
  }) };
  const tx: any = {$queryRaw:vi.fn(async()=>[{id:'DEV-1'}])};
  for (const t of ['billingItemCostCoverage', 'billingItem', 'costRecord', 'invoiceLine', 'sample', 'relation', 'order', 'orderLine', 'invoice', 'developmentCase', 'sampleBatch', 'sealSample', 'shipment', 'userAccount', 'userPermissionOverrides', 'quotation']) { state[t] = state[t] ?? []; tx[t] = model(t); prisma[t] = model(t);
    // Preserve distinct before/after-lock reads. Write faults injected through
    // the public client still reach the same transaction storage delegate.
    for (const method of ['update','findMany']) Object.defineProperty(prisma[t],method,{get:()=>tx[t][method],set:value=>{tx[t][method]=value;},configurable:true}); }
  prisma.invoice.__testRegisterCanonicalAck = (invoice:any) => canonicalAcks.set(invoice.id,invoice);
  tx.invoice.__testRegisterCanonicalAck = (invoice:any) => canonicalAcks.set(invoice.id,invoice);
  tx.auditLog = { create: async () => ({ id: 'AUD-1' }) };
  prisma.auditLog = { create: async () => ({ id: 'AUD-1' }) };
  return { prisma, tx, state };
}

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const k of Object.keys(where)) {
    const v = where[k];
    // Real order-source authorization now adds AND:[scope]. An empty scope
    // means unrestricted rows, not a fictional row.AND field.
    if (k === 'AND' && Array.isArray(v)) {
      if (!v.every((cond: any) => matchWhere(row, cond))) return false;
      continue;
    }
    if (k === 'OR' && Array.isArray(v)) {
      if (!v.some((cond: any) => matchWhere(row, cond))) return false;
      continue;
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if ('not' in v && row[k] === v.not) return false;
      if ('in' in v && !v.in.includes(row[k])) return false;
      if ('notIn' in v && v.notIn.includes(row[k])) return false;
      if ('OR' in v && Array.isArray(v.OR)) {
        if (!v.OR.some((w: any) => matchWhere(row, w))) return false;
        continue;
      }
      continue;
    }
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

const SAMPLE = { id: 'SMP-1', code: 'SMP-20260907-001', type: 'seal', status: 'sealed', shippingFee: 120, customerRelationId: 'REL-C1', deletedAt: null };
const REL = { id: 'REL-C1', name: 'Acme Trading' };
const ORDER = { id: 'ORD-1', code: 'SO-2026-001' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CostRecord：费用发生（成本记录）', () => {
  it('登记成本记录成功，返回 recordNo + 审计', async () => {
    const { prisma } = makePrisma({samples:[SAMPLE]});
    const r = await createCostRecord({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', costType: 'shipping', amount: 120, currency: 'USD', incurredAt: '2026-09-07', bearerType: 'customer', bearerRelationId: 'REL-C1' }, actorId: 'u1', ip: '127.0.0.1' });
    expect(r.ok).toBe(true);
    const rec = (r as any).data.costRecord;
    expect(rec.recordNo).toMatch(/^CR-/);
    expect(rec.sourceType).toBe('Sample');
    expect(rec.costType).toBe('shipping');
    expect(Number(rec.amount)).toBe(120);
  });

  it('非法来源/成本类型/金额 → 400', async () => {
    const { prisma } = makePrisma();
    expect((await createCostRecord({ prisma, input: { sourceType: 'Nope', sourceId: 'x', costType: 'shipping', amount: 1 }, actorId: 'u1' })).ok).toBe(false);
    expect((await createCostRecord({ prisma, input: { sourceType: 'Sample', sourceId: 'x', costType: 'nope', amount: 1 }, actorId: 'u1' })).ok).toBe(false);
    expect((await createCostRecord({ prisma, input: { sourceType: 'Sample', sourceId: 'x', costType: 'shipping', amount: -5 }, actorId: 'u1' })).ok).toBe(false);
  });
});

describe('BillingItem：收费决定（收费事项）', () => {
  it('Sample 来源带出默认客户/金额；免收+抵货款正确派生净应收', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE], relations: [REL], orders: [ORDER] });
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 120, waivedAmount: 20, offsetAmount: 50, offsetOrderId: 'ORD-1', registerCost: { costType: 'shipping', amount: 120 } }, actorId: 'u1' });
    expect(r.ok).toBe(true);
    const item = (r as any).data.billingItem;
    expect(item.itemNo).toMatch(/^BI-/);
    expect(item.bearerRelationId).toBe('REL-C1'); // 来源带出
    expect(item.bearerName).toBe('Acme Trading');
    expect(item.netAmount).toBe(50); // 120 - 20 - 50
    expect(item.offsetOrderNumber).toBe('SO-2026-001');
    expect(item.costRecordId).toBeTruthy(); // registerCost 联动登记
    expect(prisma.costRecord.findMany({})).toBeTruthy();
  });

  it('免收+抵货款合计超过总额 → 400 INVALID_WAIVED', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE] });
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100, waivedAmount: 60, offsetAmount: 60 }, actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('INVALID_WAIVED');
  });

  it('非法来源类型 → 400', async () => {
    const { prisma } = makePrisma();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Nope', sourceId: 'x', chargeType: 'sample_fee' }, actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('INVALID_SOURCE_TYPE');
  });

  // ── createBillingItemInTx：事务内版本（D7-① 转售双侧同事务的前置能力）────────
  describe('createBillingItemInTx — 事务内版本（**throw 语义**，供调用方同事务复用）', () => {
    it('成功 → 直接返回 billingItem 本体（**不是** { ok, data } 包装）', async () => {
      const { tx, state } = makePrisma({ samples: [SAMPLE], relations: [REL] });
      const item = await createBillingItemInTx(tx, { input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 120 }, actorId: 'u1' });
      expect(item.id).toBeTruthy();
      expect(item.itemNo).toMatch(/^BI-/);
      expect(item.sourceType).toBe('Sample');
      // 写确实落在传入的 tx 上（state.billingItem 里能看到）
      expect(state.billingItem).toHaveLength(1);
      expect((item as any).ok).toBeUndefined(); // 不是 Result
    });

    it('校验失败 → **throw**（不是返回 ok:false）—— 否则外层事务会照常提交出半成品', async () => {
      const { tx } = makePrisma({ samples: [SAMPLE] });
      await expect(
        createBillingItemInTx(tx, { input: { sourceType: 'Nope', sourceId: 'x', chargeType: 'sample_fee' }, actorId: 'u1' }),
      ).rejects.toMatchObject({ __billingFail: true, code: 'INVALID_SOURCE_TYPE', httpStatus: 400 });
    });

    it('免收+抵货款超总额 → throw INVALID_WAIVED 409 语义（status 400）', async () => {
      const { tx } = makePrisma({ samples: [SAMPLE], relations: [REL] });
      await expect(
        createBillingItemInTx(tx, { input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100, waivedAmount: 60, offsetAmount: 60 }, actorId: 'u1' }),
      ).rejects.toMatchObject({ __billingFail: true, code: 'INVALID_WAIVED' });
    });
  });

  it('T2/CIF-FOB：Shipment 来源带出运费应收上下文（客户=运单开票对象、默认金额=运费）', async () => {
    const { prisma } = makePrisma({
      relations: [REL],
      shipments: [{ id: 'SHP_1', shipmentNumber: 'SHP-001', customerRelationId: 'REL-C1', customerName: 'Acme Trading', freightAmount: 350, deletedAt: null }],
    });
    const r = await createBillingItem({ prisma, input: { sourceType: 'Shipment', sourceId: 'SHP_1', chargeType: 'shipping_fee' }, actorId: 'u1' });
    expect(r.ok).toBe(true);
    const item = (r as any).data.billingItem;
    expect(item.bearerRelationId).toBe('REL-C1'); // 运单开票对象带出
    expect(item.bearerName).toBe('Acme Trading');
    expect(Number(item.amount)).toBe(350); // 默认金额 = freightAmount
    expect(item.chargeType).toBe('shipping_fee');
  });

  it('confirm 锁定：confirmed 后编辑 409 LOCKED', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE] });
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100 }, actorId: 'u1' });
    const id = (created as any).data.billingItem.id;

    const updDraft = await updateBillingItem({ prisma, id, input: { waivedAmount: 10 }, actorId: 'u1' });
    expect(updDraft.ok).toBe(true);

    const conf = await confirmBillingItem({ prisma, id, actorId: 'u1' });
    expect(conf.ok).toBe(true);
    expect((conf as any).data.billingItem.status).toBe('confirmed');

    const upd = await updateBillingItem({ prisma, id, input: { waivedAmount: 30 }, actorId: 'u1' });
    expect(upd.ok).toBe(false);
    expect((upd as any).error.code).toBe('LOCKED');
  });
});

describe('BillingItem：开票 → 应收草稿（四层表达）', () => {
  it('确认后开票 → Invoice Draft（sourceType=BillingItem，amount=净应收）', async () => {
    const { prisma, state } = makePrisma({ samples: [SAMPLE], relations: [REL] });
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 120, waivedAmount: 20 }, actorId: 'u1' });
    const id = (created as any).data.billingItem.id;
    await confirmBillingItem({ prisma, id, actorId: 'u1' });

    const r = await invoiceBillingItem({ prisma, id, actorId: 'u1' });
    expect(r.ok).toBe(true);
    const inv = (r as any).data.invoice;
    expect(inv.status).toBe('Draft');
    expect(inv.sourceType).toBe('BillingItem');
    expect(inv.sourceId).toBe(id);
    expect(Number(inv.amount)).toBe(100); // 120 - 20
    expect(inv.customerRelationId).toBe('REL-C1');
    const item = (r as any).data.billingItem;
    expect(item.status).toBe('invoiced');
    expect(item.invoiceId).toBe(inv.id);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(state.invoice.length).toBe(0); // invoice 由被 mock 的 createInvoice 内部创建（本测试不落 mock 库）
  });

  it('重复开票幂等：recovered=true，不重复建票', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE] });
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100 }, actorId: 'u1' });
    const id = (created as any).data.billingItem.id;
    await confirmBillingItem({ prisma, id, actorId: 'u1' });
    await invoiceBillingItem({ prisma, id, actorId: 'u1' });

    const again = await invoiceBillingItem({ prisma, id, actorId: 'u1' });
    expect(again.ok).toBe(true);
    expect((again as any).data.recovered).toBe(true);
    expect(createInvoice).toHaveBeenCalledTimes(1);
  });

  it('净应收 ≤ 0 → noReceivable 闭环，不开票', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE] });
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100, waivedAmount: 100 }, actorId: 'u1' });
    const id = (created as any).data.billingItem.id;
    await confirmBillingItem({ prisma, id, actorId: 'u1' });

    const r = await invoiceBillingItem({ prisma, id, actorId: 'u1' });
    expect(r.ok).toBe(true);
    expect((r as any).data.noReceivable).toBe(true);
    expect((r as any).data.invoice).toBeUndefined();
    expect(createInvoice).not.toHaveBeenCalled();
    const flow = await getBillingItem({ prisma, id });
    expect((flow as any).data.flow.stage).toBe('no_receivable');
  });

  it('未确认开票 → 409 NOT_CONFIRMED', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE] });
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100 }, actorId: 'u1' });
    const r = await invoiceBillingItem({ prisma, id: (created as any).data.billingItem.id, actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('NOT_CONFIRMED');
  });

  it('建票成功但回填失败 → BACKFILL_FAILED（可重试）', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE] });
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100 }, actorId: 'u1' });
    const id = (created as any).data.billingItem.id;
    await confirmBillingItem({ prisma, id, actorId: 'u1' });

    // 回填失败：mock billingItem.update 抛错一次
    const origUpdate = prisma.billingItem.update;
    prisma.billingItem.update = vi.fn(async () => { throw new Error('db down'); });
    const r = await invoiceBillingItem({ prisma, id, actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('BACKFILL_FAILED');
    prisma.billingItem.update = origUpdate;

    // 重试：createInvoice 再次成功 → 来源幂等恢复 recovered（此时 billingItem 仍是 confirmed）
    const again = await invoiceBillingItem({ prisma, id, actorId: 'u1' });
    expect(again.ok).toBe(true);
  });
});

describe('BillingItem：取消', () => {
  it('draft 可取消；已开票不可取消（需先作废发票）', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE] });
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100 }, actorId: 'u1' });
    const id = (created as any).data.billingItem.id;

    const cancelled = await cancelBillingItem({ prisma, id, reason: '客户不再需要', actorId: 'u1' });
    expect(cancelled.ok).toBe(true);
    expect((cancelled as any).data.billingItem.status).toBe('cancelled');

    // 重新创建并开票后取消 → 409
    const created2 = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100 }, actorId: 'u1' });
    const id2 = (created2 as any).data.billingItem.id;
    await confirmBillingItem({ prisma, id: id2, actorId: 'u1' });
    await invoiceBillingItem({ prisma, id: id2, actorId: 'u1' });
    const r = await cancelBillingItem({ prisma, id: id2, actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('ALREADY_INVOICED');
  });
});

describe('BillingItem：列表与四层 flow', () => {
  it('来源筛选列表 + netAmount 派生 + stage 正确', async () => {
    const { prisma, state } = makePrisma({ samples: [SAMPLE] });
    await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100, waivedAmount: 25 }, actorId: 'u1' });
    const list = await listBillingItems({ prisma, query: { sourceType: 'Sample', sourceId: 'SMP-1' } });
    expect((list as any).data.total).toBe(1);
    const item = (list as any).data.billingItems[0];
    expect(item.netAmount).toBe(75);
    expect(item.status).toBe('draft');

    const flow = await getBillingItem({ prisma, id: item.id });
    expect((flow as any).data.flow.stage).toBe('decision_draft');
    expect(state.costRecord.length).toBe(0); // 未 registerCost
  });
});

describe('DR-054 阶段 E：费用收敛 + 行级开票', () => {
  const COST_ORDER = { id: 'CR-ORD', recordNo: 'CR-20260908-001', sourceType: 'Order', sourceId: 'ORD-1', costType: 'shipping', amount: 200, currency: 'USD', bearerType: 'customer', bearerRelationId: 'REL-C1', incurredAt: '2026-09-08', deletedAt: null };
  const ORDER2 = { id: 'ORD-1', code: 'SO-2026-001', poNumber: 'PO-001', customerRelationId: 'REL-C1', customerName: 'Acme Trading', deletedAt: null };
  const CASE1 = { id: 'DC-1', code: 'DC-2026-001', name: 'TR 面料开发', deletedAt: null };
  const BATCH1 = { id: 'SB-1', batchCode: 'SB-20260908-0001', developmentCaseId: 'DC-1', deletedAt: null };
  const CR_CASE = { id: 'CR-1', recordNo: 'CR-20260908-002', sourceType: 'DevelopmentCase', sourceId: 'DC-1', costType: 'development', amount: 500, currency: 'CNY', bearerType: 'customer', bearerRelationId: 'REL-C1', incurredAt: '2026-09-08', deletedAt: null };
  const CR_BATCH = { id: 'CR-2', recordNo: 'CR-20260908-003', sourceType: 'SampleBatch', sourceId: 'SB-1', costType: 'sample_making', amount: 300, currency: 'CNY', bearerType: 'customer', bearerRelationId: 'REL-C1', incurredAt: '2026-09-08', deletedAt: null };

  it('CostRecord 支持 Order 来源（大货样品费用归属订单）', async () => {
    const { prisma, tx } = makePrisma({ orders: [ORDER2] });
    const currentFinance = { id: 'u1', status: 'active', deletedAt: null, primaryDeptId: 'synthetic-finance-department',
      primaryDepartment: { id: 'synthetic-finance-department', status: 'active', parentId: 'synthetic-company', metadata: { businessAttributes: ['finance'] } },
      roles: [{ departmentId: null, role: { id: 'role-finance', permissions: ['invoices:write', 'invoices:reconcile'].map(scope => ({ permission: { scope } })) } }] };
    tx.userAccount = { findFirst: vi.fn(async()=>({id:'u1'})), findUnique: vi.fn(async()=>currentFinance) };
    tx.userPermissionOverrides = { findMany: vi.fn(async()=>[]) };
    tx.department = { findMany: vi.fn(async()=>[]) };
    const trustedActor = { userId:'u1', roles:[], permissions:[], departmentIds:[] };
    const r = await createCostRecord({ prisma, input: { sourceType: 'Order', sourceId: 'ORD-1', costType: 'shipping', amount: 200, bearerType: 'customer', bearerRelationId: 'REL-C1' }, actorId: 'u1', trustedActor });
    expect(r.ok).toBe(true);
    expect((r as any).data.costRecord.sourceType).toBe('Order');
  });

  it('BillingItem 直连 CostRecord（费用行为收费决定单位，chargeType 自动映射）', async () => {
    const { prisma } = makePrisma({ costRecords: [{ ...COST_ORDER, id: 'CR-1' }], orders: [ORDER2], relations: [REL] });
    const r = await createBillingItem({ prisma, input: { sourceType: 'CostRecord', sourceId: 'CR-1', chargeType: '' }, actorId: 'u1' });
    expect(r.ok).toBe(true);
    const item = (r as any).data.billingItem;
    expect(item.sourceType).toBe('CostRecord');
    expect(item.costRecordId).toBe('CR-1'); // 直连自动取 sourceId
    expect(item.chargeType).toBe('shipping_fee'); // shipping → shipping_fee 映射
    expect(Number(item.amount)).toBe(200); // 默认金额=费用行金额
  });

  it('一 CostRecord 最多被一个未取消 BillingItem 引用 → 409 COST_ALREADY_BILLED', async () => {
    const { prisma } = makePrisma({ costRecords: [{ ...COST_ORDER, id: 'CR-1' }], orders: [ORDER2], relations: [REL] });
    const first = await createBillingItem({ prisma, input: { sourceType: 'CostRecord', sourceId: 'CR-1', chargeType: '' }, actorId: 'u1' });
    expect(first.ok).toBe(true);
    const second = await createBillingItem({ prisma, input: { sourceType: 'CostRecord', sourceId: 'CR-1', chargeType: '' }, actorId: 'u1' });
    expect(second.ok).toBe(false);
    expect((second as any).error.code).toBe('COST_ALREADY_BILLED');
    // 取消后可重新引用
    const cancelled = await cancelBillingItem({ prisma, id: (first as any).data.billingItem.id, actorId: 'u1' });
    expect(cancelled.ok).toBe(true);
    const third = await createBillingItem({ prisma, input: { sourceType: 'CostRecord', sourceId: 'CR-1', chargeType: '' }, actorId: 'u1' });
    expect(third.ok).toBe(true);
  });

  it('invoiceBillingItem 行级开票：createInvoice 携带 invoiceLines（CostRecord 行来源）', async () => {
    const { prisma, state } = makePrisma({ costRecords: [{ ...COST_ORDER, id: 'CR-1' }], orders: [ORDER2], relations: [REL] });
    const created = await createBillingItem({ prisma, input: { sourceType: 'CostRecord', sourceId: 'CR-1', chargeType: '' }, actorId: 'u1' });
    const id = (created as any).data.billingItem.id;
    await confirmBillingItem({ prisma, id, actorId: 'u1' });
    const r = await invoiceBillingItem({ prisma, id, actorId: 'u1' });
    expect(r.ok).toBe(true);
    expect(createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        invoiceLines: expect.arrayContaining([
          expect.objectContaining({ sourceType: 'CostRecord', sourceId: 'CR-1' }),
        ]),
      }),
    }));
  });

  it('listCostCandidateRows 按开发案聚合（直接 + 批次），附 occupied 占用标记', async () => {
    const { prisma } = makePrisma({
      devCases: [CASE1], batches: [BATCH1],
      costRecords: [CR_CASE, CR_BATCH],
      // CR_BATCH 已被未取消收费事项占用
      billingItems: [{ id: 'BI-1', itemNo: 'BI-20260908-001', sourceType: 'SampleBatch', sourceId: 'SB-1', costRecordId: 'CR-2', status: 'confirmed', deletedAt: null }],
    });
    const r = await listCostCandidateRows({ prisma, query: { caseId: 'DC-1' } });
    expect(r.ok).toBe(true);
    const rows = (r as any).data.rows;
    expect(rows.length).toBe(2);
    const byId = Object.fromEntries(rows.map((row: any) => [row.id, row]));
    expect(byId['CR-1'].sourceLabel).toContain('DC-2026-001');
    expect(byId['CR-1'].occupied).toBe(false);
    expect(byId['CR-2'].sourceLabel).toContain('SB-20260908-0001');
    expect(byId['CR-2'].occupied).toBe(true);
  });
});

/**
 * ★ B137（v3.15）· §2 G3 判据 L-A：`createBillingItem` 里那句 `INVALID_AMOUNT` 校验此前**一次都没执行过**
 *
 * 原形状（`:417`）：`const amount = assertNumber(input.amount,'amount') ?? source.defaultAmount ?? 0;`
 *                然后 `if (amount === null) throwFail('INVALID_AMOUNT', '收费金额必须是非负数值', 400);`
 * 而 `assertNumber` 把 **没填 / 非数 / 负数** 三件事压成同一个 `null` ⇒
 *   · 送负数或被 `Number()` 折成 NaN 的垃圾串 ⇒ 静默换成"来源默认金额"（本夹具里是 `SAMPLE.shippingFee = 120`），
 *     没有默认就换成 0 —— 单子照常开，账上多一条谁也没同意的金额；
 *   · 而那句守卫因为 `?? 0` 保证非 null 而**永不可达**（看着有校验，其实没有）。
 * ⇒ 下面 ①②③ 钉"非法必须当场拒且一行都不写"；④⑤ 钉"我没有顺手收紧口径"：
 *   **0 仍然合法**（非负），**没填仍走默认金额**（后者行为未动，它留在 L-A 里等 §12.1 拍板）。
 */
describe('B137 · 收费金额：非法必须拒（此前那条守卫是死的），但口径不顺手收紧', () => {
  const mk = () => makePrisma({ samples: [SAMPLE], relations: [REL] });

  it('① amount 为负 ⇒ INVALID_AMOUNT，且**没有**被静默换成默认金额 120、库里零行', async () => {
    const { prisma, state } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: -5 }, actorId: 'u1' });
    expect(r.ok, '负数金额被收下（或换成默认金额）⇒ 死守卫又活了').toBe(false);
    expect((r as any).error.code).toBe('INVALID_AMOUNT');
    // ★ 复核 I-4 的同族：读数口的 message 自带字段名，调用方再叠一次就成了「收费金额收费金额不能为负」。
    expect((r as any).error.message, '文案不许把字段名叠两次').not.toMatch(/(收费金额|免收金额|抵货款金额)\1/);
    expect((r as any).error.message).toContain('收费金额');
    expect(state.billingItem.length, '拒了就不该有行').toBe(0);
  });

  it('② amount 是垃圾串 ⇒ 同样当场拒（改前：`Number()` 折成 NaN ⇒ 静默用默认金额开单）', async () => {
    const { prisma, state } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: '12abc' as any }, actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('INVALID_AMOUNT');
    expect(state.billingItem.length).toBe(0);
  });

  it('③ 免收金额为负 ⇒ 拒（改前 `assertNumber(...) ?? 0` 会把它静默变成"免收 0"并**成功开单**）', async () => {
    const { prisma, state } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100, waivedAmount: -1 }, actorId: 'u1' });
    expect(r.ok, '免收 -1 被当成 0 收下来 ⇒ 净应收凭空多 1').toBe(false);
    expect((r as any).error.code).toBe('INVALID_AMOUNT');
    expect((r as any).error.message, '免收那一栏的文案同样不许叠字').not.toMatch(/(收费金额|免收金额|抵货款金额)\1/);
    expect((r as any).error.message).toContain('免收金额');
    expect(state.billingItem.length).toBe(0);
  });

  it('④ 反面对照（钉我没收紧档位）：amount=100、免收 0 仍然合法，净应收 100', async () => {
    const { prisma } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100, waivedAmount: 0 }, actorId: 'u1' });
    expect(r.ok, JSON.stringify((r as any).error)).toBe(true);
    expect((r as any).data.billingItem.netAmount).toBe(100);
  });

  it('⑤ 行为未动的那一半：不填 amount 仍带出来源默认金额 120（此条仍是 L-A，等 §12.1 拍"缺失可否=0/默认"）', async () => {
    const { prisma } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee' }, actorId: 'u1' });
    expect(r.ok, '本条只钉"我没改这条行为"，不是宣布它正确').toBe(true);
    expect(Number((r as any).data.billingItem.amount)).toBe(120);
  });

  /**
   * ★ 复核 I-1 补的一格：④ 用的是**免收**为 0，所以"把金额档偷偷收紧成正数"（`parseNonNegative` → `parsePositive`）
   *   在 ④⑤ 之下不红 ⇒ 我那句"④⑤ 钉住我没收紧"当时是半真半假。这一格才真正钉住**金额本身 0 合法**。
   */
  it('⑥ 反"顺手收紧"：amount 直接填 0 仍然合法（净应收 0 ⇒ 走不开票闭环），不许变成 400', async () => {
    const { prisma } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 0 }, actorId: 'u1' });
    expect(r.ok, '金额 0 被拒 ⇒ 档位被收紧了（本批声明不动口径）：' + JSON.stringify((r as any).error)).toBe(true);
    expect(Number((r as any).data.billingItem.amount)).toBe(0);
  });

  // ★ 复核 B-1：编辑路径上还有三处同族 `assertNumber(...) ?? Number(row.旧值)`，
  //   危害是"送负数不报错、静默保留旧值还返回 200 改好了" ⇒ 单子一分没动，用户以为改了。
  it('⑦ 编辑路径：amount 为负 ⇒ 400，且**库里旧值一分不许改**（改前是"200 成功 + 金额纹丝不动"）', async () => {
    const { prisma, state } = mk();
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100 }, actorId: 'u1' });
    expect(created.ok).toBe(true);
    const id = (created as any).data.billingItem.id;
    const r = await updateBillingItem({ prisma, id, input: { amount: -5 }, actorId: 'u1' });
    expect(r.ok, '负数被静默换成旧值并返回成功 ⇒ 用户以为改好了').toBe(false);
    expect((r as any).error.code).toBe('INVALID_AMOUNT');
    expect(Number(state.billingItem.find((x: any) => x.id === id).amount)).toBe(100);
  });

  it('⑧ 编辑路径的 PATCH 语义未动：不传 amount ⇒ 保留旧值并成功（只有 null/undefined 走这条路）', async () => {
    const { prisma, state } = mk();
    const created = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100 }, actorId: 'u1' });
    const id = (created as any).data.billingItem.id;
    const r = await updateBillingItem({ prisma, id, input: { waivedAmount: 20 }, actorId: 'u1' });
    expect(r.ok, JSON.stringify((r as any).error)).toBe(true);
    expect(Number(state.billingItem.find((x: any) => x.id === id).amount)).toBe(100);
  });
});

/**
 * ★ D107（v3.91 自裁 · 收紧）：收费金额**没填且来源没有默认金额** ⇒ 拒（不再静默开成 0 元单）。
 *   B137 留下的那半条（"没填 ⇒ 走默认，再没有就是 0"）当时写的是"等 §12.1 拍板"；
 *   §12.1 第 28 条已按行业标准判成 **(b) 拒**（与理赔域 A6「0 元处置无意义」同族）：未定价的行不许静默变成 0。
 *   ★ 三面都要钉住：没填+无默认 ⇒ 拒 · 没填+**有**默认 ⇒ 仍用默认（不许把 B137 ⑤ 推翻）· **显式填 0 ⇒ 仍合法**。
 */
describe('D107 · 金额没填且来源无默认 ⇒ 拒（"有默认"与"显式 0"两条路都不许被误伤）', () => {
  const mk = () => makePrisma({
    samples: [SAMPLE],
    relations: [REL],
    shipments: [{
      id: 'SHP-1', shipmentNumber: 'SHP2601', freightAmount: null,
      customerRelationId: 'REL-1', customerName: '客户甲', deletedAt: null,
    }],
  });

  it('★ 没填 + 运单运费为空（来源无默认）⇒ INVALID_AMOUNT，且库里零行', async () => {
    const { prisma, state } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Shipment', sourceId: 'SHP-1', chargeType: 'shipping_fee' }, actorId: 'u1' });
    expect(r.ok, '没填又没默认仍开成 0 元单 ⇒ D107 没落地').toBe(false);
    expect((r as any).error.code).toBe('INVALID_AMOUNT');
    expect((r as any).error.message, '拒的时候要告诉人怎么走（显式填 0 是合法出路）').toContain('0');
    expect(state.billingItem.length).toBe(0);
  });

  it('反面对照一：没填 + 来源**有**默认（样衣运费 120）⇒ 仍按默认开单（B137 ⑤ 钉的现状不许被本批推翻）', async () => {
    const { prisma } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee' }, actorId: 'u1' });
    expect(r.ok, JSON.stringify((r as any).error)).toBe(true);
    expect(Number((r as any).data.billingItem.amount)).toBe(120);
  });

  it('反面对照二：同一条运单上**显式填 0** ⇒ 仍合法（免费行要人写出 0；"拒没填"与"拒 0"是两件事）', async () => {
    const { prisma } = mk();
    const r = await createBillingItem({ prisma, input: { sourceType: 'Shipment', sourceId: 'SHP-1', chargeType: 'shipping_fee', amount: 0 }, actorId: 'u1' });
    expect(r.ok, '显式 0 被拒 ⇒ 这条新规则误伤了"免费行"那一档：' + JSON.stringify((r as any).error)).toBe(true);
    expect(Number((r as any).data.billingItem.amount)).toBe(0);
  });
});

/**
 * B143 · 复核 I-2 的落点：**同一个端点对"没填"和"填了个不是数的东西"给出相反的答案**。
 * 成本记录侧走的是 `assertNumber`，它先做 `Number(v)` ⇒ `''` / `'  '` / `false` / `[]` 全被折成 **0 收进库**，
 * 而"根本没传"是 400。v3.15 只把**收费金额**那一栏接了新读数口，这两条姊妹路径漏了。
 * ⚠️ 本批改的是"空白/布尔/数组不再当 0 收"；`0` 本身、以及"没传 ⇒ 400"两档**都没动**（④⑤ 钉着）。
 */
describe('B143 · 成本记录 / registerCost 接同一个读数口', () => {
  const cost = (amount: unknown) => ({ sourceType: 'Sample', sourceId: 'SMP-1', costType: 'shipping', amount, actorId: 'u1' });

  it('① amount 空串 ⇒ 400（改前：Number("") === 0 被静默收成 0 元成本，库里出现一行）', async () => {
    const { prisma, state } = makePrisma();
    const r = await createCostRecord({ prisma, input: cost('') as any });
    expect(r.ok, '空串又被折成 0 收下了').toBe(false);
    expect((r as any).error.code).toBe('INVALID_AMOUNT');
    expect((r as any).error.message).toContain('成本金额');
    expect(state.costRecord.length, '拒了就不该有行').toBe(0);
  });

  it('② amount 是布尔 / 空数组 ⇒ 同样拒（这两者在 JS 里都折得成 0）', async () => {
    const { prisma, state } = makePrisma();
    expect((await createCostRecord({ prisma, input: cost(false) as any })).ok).toBe(false);
    expect((await createCostRecord({ prisma, input: cost([]) as any })).ok).toBe(false);
    expect(state.costRecord.length).toBe(0);
  });

  it('③ 反面对照（钉档位没动）：0 / ' + '"120.5"' + ' / 120 都仍然合法', async () => {
    const { prisma, state } = makePrisma({samples:[SAMPLE]});
    for (const v of [0, '120.5', 120]) {
      const r = await createCostRecord({ prisma, input: cost(v) as any });
      expect(r.ok, JSON.stringify((r as any).error)).toBe(true);
    }
    expect(state.costRecord.length).toBe(3);
  });

  it('④ "根本没传"仍是 400（改前后同一档，本批只换了文案来源）', async () => {
    const { prisma, state } = makePrisma();
    const input = { sourceType: 'Sample', sourceId: 'SMP-1', costType: 'shipping', actorId: 'u1' } as any;
    delete input.amount;
    const r = await createCostRecord({ prisma, input });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('INVALID_AMOUNT');
    expect(state.costRecord.length).toBe(0);
  });

  it('⑤ registerCost 同一条路：空串 ⇒ 拒，且收费事项与成本记录都不落行', async () => {
    const { prisma, state } = makePrisma({ samples: [SAMPLE], relations: [REL] });
    const r = await createBillingItem({
      prisma,
      input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100, registerCost: { costType: 'shipping', amount: '' } } as any,
      actorId: 'u1',
    });
    expect(r.ok, 'registerCost.amount 空串被折成 0 收下了').toBe(false);
    expect((r as any).error?.code ?? (r as any).code).toBe('INVALID_AMOUNT');
    expect(state.billingItem.length).toBe(0);
    expect(state.costRecord.length).toBe(0);
  });

  it('⑥ 反面对照：registerCost 传合法金额仍然联动登记一条成本记录', async () => {
    const { prisma, state } = makePrisma({ samples: [SAMPLE], relations: [REL] });
    const r = await createBillingItem({
      prisma,
      input: { sourceType: 'Sample', sourceId: 'SMP-1', chargeType: 'sample_fee', amount: 100, registerCost: { costType: 'shipping', amount: 30 } } as any,
      actorId: 'u1',
    });
    expect(r.ok, JSON.stringify((r as any).error)).toBe(true);
    expect(state.costRecord.length).toBe(1);
    expect(Number(state.costRecord[0].amount)).toBe(30);
  });
});


describe('CostRecord Decimal(18,4) write boundary', () => {
  it.each([1.00001, '0.00001', '100000000000000', '99999999999999.99999'])('rejects overflow/rounding before writing: %s', async amount => {
    const { prisma, state } = makePrisma();
    const result = await createCostRecord({ prisma, actorId: 'u1', input: {
      sourceType: 'DevelopmentCase', sourceId: 'DEV-1', costType: 'development', amount: amount as any,
    } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_AMOUNT', status: 400 } });
    expect(state.costRecord).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preserves exact decimal text without a Number roundtrip', async () => {
    const { prisma, state } = makePrisma({devCases:[{id:'DEV-1',deletedAt:null}]});
    const result = await createCostRecord({ prisma, actorId: 'u1', input: {
      sourceType: 'DevelopmentCase', sourceId: 'DEV-1', costType: 'development', amount: '99999999999999.9999' as any,
    } });
    expect(result.ok).toBe(true);
    expect(state.costRecord[0].amount.toFixed(4)).toBe('99999999999999.9999');
  });

  it('embedded cost registration cannot bypass precision validation', async () => {
    const { prisma, tx, state } = makePrisma({ samples: [SAMPLE], relations: [REL] });
    await expect(createBillingItemInTx(tx, { actorId: 'u1', input: {
      sourceType: 'Sample', sourceId: SAMPLE.id, chargeType: 'sample_fee', amount: 10,
      registerCost: { amount: 0.00001 },
    } } as any)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(state.costRecord).toHaveLength(0);
    expect(state.billingItem).toHaveLength(0);
  });
});


describe('createCostRecordInTx 原子组合',()=>{
 it('使用外部事务且保留decimal字符串精度，后续步骤失败一起回滚',async()=>{
  const committed:any[]=[];const audits:any[]=[];
  const run=async(failAfter:boolean)=>{
   const staged:any[]=[];const stagedAudits:any[]=[];
   const tx={$queryRaw:vi.fn(async()=>[{id:'DC-1'}]),developmentCase:{findFirst:async()=>({id:'DC-1'})},costRecord:{create:async({data}:any)=>{staged.push(data);return data;}},auditLog:{create:async({data}:any)=>{stagedAudits.push(data);return data;}}};
   const cost=await createCostRecordInTx(tx,{input:{sourceType:'DevelopmentCase',sourceId:'DC-1',costType:'shipping',amount:'99999999999999.9999'},actorId:'u1'});
   expect(cost.amount.toFixed(4)).toBe('99999999999999.9999');
   if(failAfter)throw new Error('resolve failed');
   committed.push(...staged);audits.push(...stagedAudits);
  };
  await expect(run(true)).rejects.toThrow('resolve failed');expect(committed).toHaveLength(0);expect(audits).toHaveLength(0);
  await run(false);expect(committed).toHaveLength(1);expect(audits).toHaveLength(1);
 });
 it('非法金额抛结构化400且不写成本或审计',async()=>{
  const tx={costRecord:{create:vi.fn()},auditLog:{create:vi.fn()}};
  await expect(createCostRecordInTx(tx,{input:{sourceType:'DevelopmentCase',sourceId:'DC-1',costType:'shipping',amount:'0.00001'},actorId:'u'})).rejects.toMatchObject({__billingFail:true,code:'INVALID_AMOUNT',status:400,httpStatus:400});
  expect(tx.costRecord.create).not.toHaveBeenCalled();expect(tx.auditLog.create).not.toHaveBeenCalled();
 });
});


describe('开发成本来源锁',()=>{
 it('直接案成本锁案，样品无开发案合法不锁，未知来源拒绝',async()=>{
  const {prisma,tx,state}=makePrisma({devCases:[{id:'D',deletedAt:null}],samples:[SAMPLE]});
  expect((await createCostRecord({prisma,input:{sourceType:'DevelopmentCase',sourceId:'D',costType:'shipping',amount:1},actorId:'u'})).ok).toBe(true);
  expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  expect((await createCostRecord({prisma,input:{sourceType:'Sample',sourceId:SAMPLE.id,costType:'shipping',amount:1},actorId:'u'})).ok).toBe(true);
  expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  expect((await createCostRecord({prisma,input:{sourceType:'Sample',sourceId:'missing',costType:'shipping',amount:1},actorId:'u'}) as any).error.code).toBe('INVALID_COST_SOURCE');
  expect(state.costRecord).toHaveLength(2);
 });
 it('锁后样品移案拒绝写成本，来源查询异常不降级',async()=>{
  const {tx,state}=makePrisma({samples:[{...SAMPLE,sourceCaseId:'D'}]});
  tx.$queryRaw=vi.fn(async()=>{state.sample[0].sourceCaseId='OTHER';return [{id:'D'}]});
  await expect(createCostRecordInTx(tx,{actorId:'u',input:{sourceType:'Sample',sourceId:SAMPLE.id,costType:'shipping',amount:1}})).rejects.toMatchObject({code:'COST_SOURCE_CHANGED'});
  expect(state.costRecord).toHaveLength(0);
  tx.sample.findFirst=async()=>{throw new Error('lookup unavailable')};
  await expect(createCostRecordInTx(tx,{actorId:'u',input:{sourceType:'Sample',sourceId:SAMPLE.id,costType:'shipping',amount:1}})).rejects.toThrow('lookup unavailable');
 });
});

describe('免收完结必须原子留痕',()=>{
 async function prepared(){
  const f=makePrisma({samples:[SAMPLE]});
  const created=await createBillingItem({prisma:f.prisma,input:{sourceType:'Sample',sourceId:'SMP-1',chargeType:'sample_fee',amount:100,waivedAmount:100},actorId:'u1'});
  const id=(created as any).data.billingItem.id;
  await confirmBillingItem({prisma:f.prisma,id,actorId:'u1'});
  return {...f,id};
 }
 it('审计失败返回失败，并由同一事务回滚完结状态',async()=>{
  const f=await prepared();
  f.tx.auditLog.create=vi.fn().mockRejectedValue(new Error('audit unavailable'));
  f.prisma.$transaction=vi.fn(async(fn:any)=>{
   const before=f.state.billingItem.map((r:any)=>({...r}));
   try{return await fn(f.tx);}catch(error){f.state.billingItem.forEach((r:any,i:number)=>Object.assign(r,before[i]));throw error;}
  });
  const result=await invoiceBillingItem({prisma:f.prisma,id:f.id,actorId:'u1'});
  expect(result).toMatchObject({ok:false,error:{code:'NO_RECEIVABLE_FAILED'}});
  expect(f.state.billingItem[0].status).toBe('confirmed');expect(createInvoice).not.toHaveBeenCalled();
 });
 it('锁后收费变成正金额，不能按旧免收决定完结',async()=>{
  const f=await prepared();f.tx.$queryRaw.mockImplementation(async()=>{f.state.billingItem[0].waivedAmount=0;return [{id:f.id}];});
  const result=await invoiceBillingItem({prisma:f.prisma,id:f.id,actorId:'u1'});
  expect(result).toMatchObject({ok:false,error:{code:'BILLING_CHANGED'}});expect(f.state.billingItem[0].status).toBe('confirmed');
 });
});

it('单笔收费不能绕过整案费用覆盖',async()=>{
 const f=makePrisma({samples:[SAMPLE],costRecords:[{id:'CR-COVERED',sourceType:'Sample',sourceId:SAMPLE.id,amount:10,currency:'CNY',deletedAt:null}]});
 f.state.billingItemCostCoverage.push({id:'coverage',costRecordId:'CR-COVERED',billingItemId:'WHOLE-CASE',releasedAt:null});
 const result=await createBillingItem({prisma:f.prisma,input:{sourceType:'Sample',sourceId:SAMPLE.id,chargeType:'sample_fee',costRecordId:'CR-COVERED',amount:10},actorId:'u'});
 expect(result).toMatchObject({ok:false,error:{code:'COST_ALREADY_BILLED'}});expect(f.state.billingItem).toHaveLength(0);
});

describe('收费草稿并发编辑',()=>{
 it('等待锁时已被确认，旧编辑不得覆盖已确认金额',async()=>{
  const f=makePrisma({billingItems:[{id:'b',itemNo:'BI',status:'draft',amount:80,waivedAmount:0,offsetAmount:0,currency:'USD',updatedAt:1n}]});
  f.tx.$queryRaw.mockImplementation(async()=>{f.state.billingItem[0].status='confirmed';return [{id:'b'}];});
  const result=await updateBillingItem({prisma:f.prisma,id:'b',input:{amount:20},actorId:'u'});
  expect(result).toMatchObject({ok:false,error:{code:'BILLING_CHANGED',status:409}});expect(f.state.billingItem[0].amount).toBe(80);
 });
 it('锁后读到另一笔编辑，拒绝沿用旧字段覆盖',async()=>{
  const initial={id:'b',itemNo:'BI',status:'draft',amount:80,waivedAmount:0,offsetAmount:0,currency:'USD',updatedAt:1n};
  const f=makePrisma({billingItems:[initial]});f.prisma.billingItem.findFirst=async()=>({...initial});
  f.tx.$queryRaw.mockImplementation(async()=>{f.state.billingItem[0]={...initial,amount:90,updatedAt:2n};return [{id:'b'}];});
  const result=await updateBillingItem({prisma:f.prisma,id:'b',input:{notes:'旧页面'},actorId:'u'});
  expect(result).toMatchObject({ok:false,error:{code:'BILLING_CHANGED'}});expect(f.state.billingItem[0].amount).toBe(90);expect(f.state.billingItem[0].notes).toBeUndefined();
 });
});

describe('开发收费流转不能被通用操作绕过',()=>{
  it('有流转状态的草稿拒绝通用修改及取消，避免丢失任务与版本记录',async()=>{
    const prisma:any={billingItem:{findFirst:async()=>({id:'managed',itemNo:'M1',status:'draft',developmentWorkflowState:'submitted'})}};
    const edited=await updateBillingItem({prisma,id:'managed',input:{amount:20},actorId:'actor'});
    const cancelled=await cancelBillingItem({prisma,id:'managed',reason:'取消',actorId:'actor'});
    expect(edited).toMatchObject({ok:false,error:{code:'WORKFLOW_REQUIRED',status:409}});
    expect(cancelled).toMatchObject({ok:false,error:{code:'WORKFLOW_REQUIRED',status:409}});
  });
});

describe('收费和成本编号使用事务序列', () => {
  it.each(['BI', 'CR'] as const)('%s 跳过已占用的软删除编号，保留历史编号', async prefix => {
    const year = new Date().getFullYear();
    const oldNumber = `${prefix}-${year}-0001`;
    const { tx } = makePrisma({
      samples: [SAMPLE], relations: [REL],
      billingItems: [{ id: 'old-bi', itemNo: oldNumber, deletedAt: 1n }],
      costRecords: [{ id: 'old-cr', recordNo: oldNumber, deletedAt: 1n }],
    });
    let seq = 0;
    tx.businessSequence = {
      upsert: vi.fn(async () => ({ seq })),
      update: vi.fn(async () => ({ seq: ++seq })),
    };
    const row = prefix === 'BI'
      ? await createBillingItemInTx(tx, { actorId: 'u1', input: { sourceType: 'Sample', sourceId: SAMPLE.id, chargeType: 'sample_fee', amount: 30 } })
      : await createCostRecordInTx(tx, { actorId: 'u1', input: { sourceType: 'Sample', sourceId: SAMPLE.id, costType: 'shipping', amount: 30 } });
    expect(prefix === 'BI' ? row.itemNo : row.recordNo).toBe(`${prefix}-${year}-0002`);
    expect(seq).toBe(2);
  });
});

it('收费读取提供精确四位净额，不经浮点数传给分币种汇总',async()=>{
 const {prisma}=makePrisma({billingItems:[{id:'exact',amount:'99999999999999.9999',waivedAmount:'0.0001',offsetAmount:'0',currency:'USD',status:'draft',deletedAt:null}]});
 const result=await getBillingItem({prisma,id:'exact'});
 expect(result.ok).toBe(true);
 if(result.ok)expect(result.data.billingItem.netAmountExact).toBe('99999999999999.9998');
});
