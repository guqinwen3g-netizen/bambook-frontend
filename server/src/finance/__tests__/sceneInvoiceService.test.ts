/**
 * sceneInvoiceService.test.ts — DR-054 阶段 F：场景化开票（财务域统一入口）
 *
 * 验收映射：
 *  - preview：四场景候选费用行 + 汇总金额/币种 + 客户/标题（只读）
 *  - create：选费用行子集 → createInvoice 携带 InvoiceLine（CostRecord 行级唯一）
 *  - 已占用行（BillingItem/InvoiceLine）→ 409 LINES_OCCUPIED（硬拦截+占用来源；作废票释放可重开）
 *  - 不同币种行未指定币种 → 400 MULTI_CURRENCY
 *  - 空选择 → 400 NO_LINES_SELECTED；非法场景 → 400 INVALID_SCENE
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { previewSceneInvoice, createSceneInvoice } from '../sceneInvoiceService';
import { listCostCandidateRows } from '../billingItemService';

vi.mock('../../finance/invoiceMutationService', () => ({
  createInvoice: vi.fn(async ({ input }: any) => ({
    ok: true,
    data: { invoice: { id: `INV__${input.sourceId}`, invoiceNumber: input.invoiceNumber || `SINV-${Date.now()}`, status: input.status, amount: input.amount, currency: input.currency, type: input.type, customerRelationId: input.customerRelationId, customerName: input.customerName, notes: input.notes, sourceType: input.sourceType, sourceId: input.sourceId } },
  })),
}));
import { createInvoice } from '../../finance/invoiceMutationService';

function makePrisma(seed: { costRecords?: any[]; billingItems?: any[]; invoiceLines?: any[]; invoices?: any[]; devCases?: any[]; batches?: any[]; samples?: any[]; seals?: any[]; orders?: any[]; relations?: any[] } = {}) {
  const state: any = {
    billingItemCostCoverage: [],
    costRecord: [...(seed.costRecords ?? [])],
    billingItem: [...(seed.billingItems ?? [])],
    invoiceLine: [...(seed.invoiceLines ?? [])],
    invoice: [...(seed.invoices ?? [])],
    developmentCase: [...(seed.devCases ?? [])],
    sampleBatch: [...(seed.batches ?? [])],
    sample: [...(seed.samples ?? [])],
    sealSample: [...(seed.seals ?? [])],
    order: [...(seed.orders ?? [])],
    relation: [...(seed.relations ?? [])],
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
      update: async ({where,data}:any) => {const row=rows.find((r:any)=>r.id===where.id);Object.assign(row,data);return row;},
      count: async ({ where }: any = {}) => rows.filter((r: any) => matchWhere(r, where)).length,
    };
  };
  const prisma: any = { $transaction: vi.fn(async (fn: any) => fn(tx)) };
  const tx: any = {$queryRaw:vi.fn(async()=>[{id:'fixture-source-lock'}])};
  for (const t of Object.keys(state)) { state[t] = state[t] ?? []; tx[t] = model(t); prisma[t] = tx[t]; }
  tx.invoice.__testRegisterCanonicalAck = (invoice:any) => canonicalAcks.set(invoice.id,invoice);
  tx.auditLog = { create: async () => ({ id: 'AUD-1' }) };
  prisma.auditLog = { create: async () => ({ id: 'AUD-1' }) };
  return { prisma, tx, state };
}

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const k of Object.keys(where)) {
    const v = where[k];
    if (k === 'AND' && Array.isArray(v)) {if (!v.every((condition:any)=>matchWhere(row,condition))) return false;continue;}
    if (k === 'OR' && Array.isArray(v)) {
      if (!v.some((cond: any) => matchWhere(row, cond))) return false;
      continue;
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if ('not' in v && row[k] === v.not) return false;
      if ('in' in v && !v.in.includes(row[k])) return false;
      if ('notIn' in v && v.notIn.includes(row[k])) return false;
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

const CASE1 = { id: 'DC-1', code: 'DC-2026-001', name: 'TR 面料开发', customerRelationId: 'REL-C1', customerName: 'Acme', deletedAt: null };
const CR1 = { id: 'CR-1', recordNo: 'CR-20260908-001', sourceType: 'DevelopmentCase', sourceId: 'DC-1', costType: 'development', amount: 500, currency: 'CNY', bearerType: 'customer', deletedAt: null };
const CR2 = { id: 'CR-2', recordNo: 'CR-20260908-002', sourceType: 'DevelopmentCase', sourceId: 'DC-1', costType: 'shipping', amount: 120, currency: 'CNY', bearerType: 'customer', deletedAt: null };
const SAMPLE1 = { id: 'SMP-1', code: 'SMP-20260908-001', deletedAt: null };
const CR3 = { id: 'CR-3', recordNo: 'CR-20260908-003', sourceType: 'Sample', sourceId: 'SMP-1', costType: 'sample_making', amount: 300, currency: 'USD', bearerType: 'customer', deletedAt: null };
const ORDER1 = { id: 'ORD-1', code: 'SO-2026-001', poNumber: 'PO-1', customerRelationId: 'REL-C1', customerName: 'Acme', deletedAt: null };
const CR4_USD = { id: 'CR-4', recordNo: 'CR-20260908-004', sourceType: 'DevelopmentCase', sourceId: 'DC-1', costType: 'sample_making', amount: 200, currency: 'USD', bearerType: 'customer', deletedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('previewSceneInvoice：候选费用行 + 汇总', () => {
  it('dev_cost 场景：开发案下费用行聚合 + 汇总金额/币种 + 客户', async () => {
    const { prisma } = makePrisma({ devCases: [CASE1], costRecords: [CR1, CR2] });
    const r = await previewSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1' });
    expect(r.ok).toBe(true);
    const d = (r as any).data;
    expect(d.sceneLabel).toBe('开发费');
    expect(d.title).toContain('DC-2026-001');
    expect(d.customerName).toBe('Acme');
    expect(d.rows.length).toBe(2);
    expect(d.summaryAmount).toBe(620);
    expect(d.summaryCurrency).toBe('CNY');
    // T7-② 回归：单币种行为不变，且分币种明细与标量一致
    expect(d.multiCurrency).toBe(false);
    expect(d.summaryByCurrency).toEqual([{ currency: 'CNY', amount: 620 }]);
  });

  it('T7-② 多币种候选行 → 按币种分组汇总（旧实现多币种时「合计」显示 0）', async () => {
    const { prisma } = makePrisma({ devCases: [CASE1], costRecords: [CR1, CR2, CR4_USD] });
    const r = await previewSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1' });
    expect(r.ok).toBe(true);
    const d = (r as any).data;
    // 旧实现：currencies.length === 2 → summaryCurrency='' 且 summaryAmount=0，
    // 用户看到「合计 0」以为没有费用可选，点下去才被 create 的 MULTI_CURRENCY 拦住。
    expect(d.multiCurrency).toBe(true);
    expect(d.summaryByCurrency).toEqual([
      { currency: 'CNY', amount: 620 },
      { currency: 'USD', amount: 200 },
    ]);
    // 兼容字段在多币种下无意义（前端已改读 summaryByCurrency）
    expect(d.summaryAmount).toBe(0);
    expect(d.summaryCurrency).toBe('');
  });

  it('sample 场景：样品费用行', async () => {
    const { prisma } = makePrisma({ samples: [SAMPLE1], costRecords: [CR3] });
    const r = await previewSceneInvoice({ prisma, scene: 'sample', sourceId: 'SMP-1' });
    expect(r.ok).toBe(true);
    expect((r as any).data.rows.length).toBe(1);
    expect((r as any).data.summaryCurrency).toBe('USD');
  });

  it('order 场景：订单费用行', async () => {
    const { prisma } = makePrisma({ orders: [ORDER1], costRecords: [{ ...CR3, id: 'CR-9', sourceType: 'Order', sourceId: 'ORD-1' }] });
    const r = await previewSceneInvoice({ prisma, scene: 'order', sourceId: 'ORD-1' });
    expect(r.ok).toBe(true);
    expect((r as any).data.title).toContain('SO-2026-001');
    expect((r as any).data.rows.length).toBe(1);
  });

  it('非法场景 → 400 INVALID_SCENE', async () => {
    const { prisma } = makePrisma();
    const r = await previewSceneInvoice({ prisma, scene: 'nope', sourceId: 'x' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('INVALID_SCENE');
  });
});

describe('createSceneInvoice：选费用行子集 → 发票（行级）', () => {
  it('选中两条同币种费用行 → createInvoice 携带 invoiceLines（CostRecord 行级）', async () => {
    const { prisma } = makePrisma({ devCases: [CASE1], costRecords: [CR1, CR2] });
    const r = await createSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1', lineIds: ['CR-1', 'CR-2'], actorId: 'u1' });
    expect(r.ok).toBe(true);
    const inv = (r as any).data.invoice;
    expect(Number(inv.amount)).toBe(620);
    expect(inv.customerName).toBe('Acme');
    expect(createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        sourceType: 'Scene',
        sourceId: 'dev_cost:DC-1',
        invoiceLines: expect.arrayContaining([
          expect.objectContaining({ sourceType: 'CostRecord', sourceId: 'CR-1' }),
          expect.objectContaining({ sourceType: 'CostRecord', sourceId: 'CR-2' }),
        ]),
      }),
    }));
  });

  it('§10.7 开票互斥：占用行硬拦截 → 409 LINES_OCCUPIED 并报占用来源（收费事项号）', async () => {
    const { prisma } = makePrisma({
      devCases: [CASE1], costRecords: [CR1, CR2],
      billingItems: [{ id: 'BI-1', itemNo: 'BI-20260912-001', sourceType: 'DevelopmentCase', sourceId: 'DC-1', costRecordId: 'CR-1', status: 'confirmed', deletedAt: null }],
    });
    const r = await createSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1', lineIds: ['CR-1'], actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('LINES_OCCUPIED');
    expect((r as any).error.message).toContain('BI-20260912-001');
    expect((r as any).error.message).toContain('作废');
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('§10.7 开票互斥：占用行硬拦截报发票号（InvoiceLine 引用）', async () => {
    const { prisma } = makePrisma({
      devCases: [CASE1], costRecords: [CR1, CR2],
      invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR-1', invoiceId: 'INV__live' }],
      invoices: [{ id: 'INV__live', invoiceNumber: 'INV-001', status: 'Issued', deletedAt: null }],
    });
    const r = await createSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1', lineIds: ['CR-1'], actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('LINES_OCCUPIED');
    expect((r as any).error.message).toContain('INV-001');
  });

  it('§10.7 作废即释放：已作废发票占用的费用行可重开票', async () => {
    const { prisma } = makePrisma({
      devCases: [CASE1], costRecords: [CR1, CR2],
      invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR-1', invoiceId: 'INV__dead' }],
      invoices: [{ id: 'INV__dead', invoiceNumber: 'INV-000', status: 'Cancelled', deletedAt: null }],
    });
    // 预览：CR-1 不再占用（票已作废）
    const pv = await previewSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1' });
    expect(pv.ok).toBe(true);
    const row1 = (pv as any).data.rows.find((x: any) => x.id === 'CR-1');
    expect(row1.occupied).toBe(false);
    // 重开成功
    const r = await createSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1', lineIds: ['CR-1'], actorId: 'u1' });
    expect(r.ok).toBe(true);
  });

  it('§10.7 预览占用标注：有效票占用行 occupiedBy 报发票号', async () => {
    const { prisma } = makePrisma({
      devCases: [CASE1], costRecords: [CR1, CR2],
      invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR-1', invoiceId: 'INV__live' }],
      invoices: [{ id: 'INV__live', invoiceNumber: 'INV-001', status: 'Issued', deletedAt: null }],
    });
    const pv = await previewSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1' });
    expect(pv.ok).toBe(true);
    const row1 = (pv as any).data.rows.find((x: any) => x.id === 'CR-1');
    const row2 = (pv as any).data.rows.find((x: any) => x.id === 'CR-2');
    expect(row1.occupied).toBe(true);
    expect(row1.occupiedBy).toBe('发票 INV-001');
    expect(row2.occupied).toBe(false);
  });

  it('不同币种行未指定币种 → 400 MULTI_CURRENCY', async () => {
    const { prisma } = makePrisma({
      devCases: [CASE1],
      costRecords: [CR1, { ...CR2, id: 'CR-4', currency: 'USD', amount: 100 }],
    });
    const r = await createSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1', lineIds: ['CR-1', 'CR-4'], actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('MULTI_CURRENCY');
  });

  it('空选择 → 400 NO_LINES_SELECTED', async () => {
    const { prisma } = makePrisma({ devCases: [CASE1], costRecords: [CR1] });
    const r = await createSceneInvoice({ prisma, scene: 'dev_cost', sourceId: 'DC-1', lineIds: [], actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('NO_LINES_SELECTED');
  });
});

it('显式币种不能掩盖混币，也不能给单币费用改币种',async()=>{
 const {prisma}=makePrisma({devCases:[CASE1],costRecords:[CR1,{...CR2,id:'USD-COST',currency:'USD',amount:100}]});
 const mixed=await createSceneInvoice({prisma,scene:'dev_cost',sourceId:'DC-1',lineIds:['CR-1','USD-COST'],input:{currency:'CNY'},actorId:'u1'});
 expect((mixed as any).error.code).toBe('MULTI_CURRENCY');
 const changed=await createSceneInvoice({prisma,scene:'dev_cost',sourceId:'DC-1',lineIds:['CR-1'],input:{currency:'USD'},actorId:'u1'});
 expect((changed as any).error.code).toBe('CURRENCY_MISMATCH');expect(createInvoice).not.toHaveBeenCalled();
});
it.each(['sampleBatch','sample','sealSample','invoiceLine','billingItem','invoice','billingItemCostCoverage'])('来源或占用查询%s失败时预览/开票明确失败且不写票',async(model)=>{
 const {prisma}=makePrisma({devCases:[CASE1],costRecords:[CR1],invoiceLines:[{id:'IL',sourceType:'CostRecord',sourceId:'CR-1',invoiceId:'INV1'}]});
 prisma[model].findMany=vi.fn(async()=>{throw new Error('database unavailable')});
 const preview=await previewSceneInvoice({prisma,scene:'dev_cost',sourceId:'DC-1'});
 expect((preview as any).error).toMatchObject({code:'COST_CANDIDATES_LOAD_FAILED',status:500});
 const result=await createSceneInvoice({prisma,scene:'dev_cost',sourceId:'DC-1',lineIds:['CR-1'],actorId:'u1'});
 expect((result as any).error.code).toBe('COST_CANDIDATES_LOAD_FAILED');expect(createInvoice).not.toHaveBeenCalled();
});

it('整案覆盖费用在候选列表显式占用并阻止场景开票',async()=>{
 const f=makePrisma({devCases:[{id:'D',deletedAt:null}],costRecords:[{id:'C',sourceType:'DevelopmentCase',sourceId:'D',amount:10,currency:'CNY',deletedAt:null,createdAt:1n}]});
 f.state.billingItemCostCoverage.push({id:'coverage',costRecordId:'C',billingItemId:'WHOLE',releasedAt:null});
 const candidates=await listCostCandidateRows({prisma:f.prisma,query:{caseId:'D'}});
 expect(candidates).toMatchObject({ok:true,data:{rows:[{id:'C',occupied:true,occupiedBy:'整案收费 WHOLE'}]}});
 const result=await createSceneInvoice({prisma:f.prisma,scene:'dev_cost',sourceId:'D',lineIds:['C'],actorId:'u'});
 expect(result).toMatchObject({ok:false,error:{code:'LINES_OCCUPIED'}});expect(createInvoice).not.toHaveBeenCalled();
});
