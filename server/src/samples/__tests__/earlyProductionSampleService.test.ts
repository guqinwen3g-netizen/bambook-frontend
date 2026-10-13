import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createEarlyProductionSampleService } from '../earlyProductionSampleService';

vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('audit_test_id'),
}));

function makeFabricOrder(overrides: any = {}) {
  return {
    id: 'ORD-F1',
    orderNo: 'SO-F-1',
    type: 'Fabric',
    businessLine: 'fabric',
    status: 'in_production', // DR-028：商业批准后投产
    deletedAt: null,
    ...overrides,
  };
}

function makeSample(overrides: any = {}) {
  return {
    id: 'EPS__1',
    sampleCode: 'EPS-20990101-001',
    orderId: 'ORD-F1',
    fabricProfileId: null,
    millName: null,
    sampleQuantity: 3,
    sampleUnit: 'meter',
    productionStage: null,
    producedMeterage: null,
    cuttingDate: '2099-01-01',
    sentToCustomer: false,
    sentDate: null,
    trackingNumber: null,
    customerStatus: 'pending',
    customerFeedbackDate: null,
    customerFeedbackNote: null,
    qcInspectionReportId: null,
    qcRequestedBy: null,
    qcRequestedAt: null,
    previousSampleId: null,
    notes: null,
    attachments: { rounds: [] },
    createdAt: BigInt(1000),
    updatedAt: BigInt(1000),
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma(opts: { order?: any; samples?: any[] } = {}) {
  const state = {
    order: opts.order === undefined ? makeFabricOrder() : opts.order,
    samples: opts.samples ?? [],
    seq: 0,
  };
  const eps: any = {
    create: vi.fn().mockImplementation(async ({ data }: any) => {
      const row = { ...makeSample(), ...data, id: data.id ?? `EPS__${++state.seq}` };
      state.samples.push(row);
      return row;
    }),
    findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
      return state.samples.find((s: any) => s.id === where.id && !s.deletedAt) ?? null;
    }),
    findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
      let rows = state.samples.filter((s: any) => !s.deletedAt);
      if (where?.orderId) rows = rows.filter((s: any) => s.orderId === where.orderId);
      return rows;
    }),
    count: vi.fn().mockImplementation(async ({ where }: any = {}) => {
      if (!where?.sampleCode?.startsWith) return state.samples.length;
      return state.samples.filter((s: any) => s.sampleCode.startsWith(where.sampleCode.startsWith)).length;
    }),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => {
      const idx = state.samples.findIndex((s: any) => s.id === where.id);
      if (idx >= 0) state.samples[idx] = { ...state.samples[idx], ...data };
      return state.samples[idx];
    }),
  };
  const tx: any = { earlyProductionSample: eps };
  const prisma: any = {
    order: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        if (!state.order) return null;
        if (where?.id && state.order.id !== where.id) return null;
        return state.order;
      }),
    },
    earlyProductionSample: eps,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { prisma, state };
}

const ACTOR = 'u_sales_1';

describe('createSample（DR-028 投产后早期生产样登记）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功登记：EPS- 业务号 + attachments.rounds 初始空', async () => {
    const { prisma } = makePrisma();
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.createSample({
      orderId: 'ORD-F1',
      input: { sampleQuantity: 3, cuttingDate: '2099-01-01', productionStage: 'after_dyeing', millName: 'Mill A' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sample.sampleCode).toMatch(/^EPS-\d{8}-001$/);
      expect(r.data.sample.customerStatus).toBe('pending');
      expect(r.data.sample.attachments.rounds).toEqual([]);
    }
  });

  it('订单未投产（pending/draft/cancelled）→ ORDER_NOT_IN_PRODUCTION 409（DR-028 投产后节点）', async () => {
    for (const status of ['pending', 'draft', 'cancelled']) {
      const { prisma } = makePrisma({ order: makeFabricOrder({ status }) });
      const svc = createEarlyProductionSampleService({ prisma });
      const r = await svc.createSample({
        orderId: 'ORD-F1',
        input: { sampleQuantity: 3, cuttingDate: '2099-01-01' },
        actorId: ACTOR,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('ORDER_NOT_IN_PRODUCTION');
        expect(r.error.status).toBe(409);
      }
    }
  });

  it('非面料订单 → NOT_FABRIC_ORDER', async () => {
    const { prisma } = makePrisma({ order: makeFabricOrder({ type: 'Garment', businessLine: 'garment' }) });
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.createSample({
      orderId: 'ORD-F1',
      input: { sampleQuantity: 3, cuttingDate: '2099-01-01' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FABRIC_ORDER');
  });

  it('previousSampleId 闭环链：跨订单 → ORDER_MISMATCH；不存在 → 404', async () => {
    const other = makeSample({ id: 'EPS__other', orderId: 'ORD-F2' });
    const { prisma } = makePrisma({ samples: [other] });
    const svc = createEarlyProductionSampleService({ prisma });

    const r1 = await svc.createSample({
      orderId: 'ORD-F1',
      input: { sampleQuantity: 3, cuttingDate: '2099-01-01', previousSampleId: 'EPS__other' },
      actorId: ACTOR,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('ORDER_MISMATCH');

    const r2 = await svc.createSample({
      orderId: 'ORD-F1',
      input: { sampleQuantity: 3, cuttingDate: '2099-01-01', previousSampleId: 'EPS__missing' },
      actorId: ACTOR,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('PREVIOUS_SAMPLE_NOT_FOUND');
  });

  it('previousSampleId 同订单 → 成功链入下一轮', async () => {
    const prev = makeSample({ id: 'EPS__prev', customerStatus: 'adjust_and_resend' });
    const { prisma } = makePrisma({ samples: [prev] });
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.createSample({
      orderId: 'ORD-F1',
      input: { sampleQuantity: 3, cuttingDate: '2099-01-02', previousSampleId: 'EPS__prev' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.sample.previousSampleId).toBe('EPS__prev');
  });
});

describe('sendSample（寄送登记，不限轮次）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功寄送：sentToCustomer=true + attachments.rounds 追加一条寄送记录', async () => {
    const sample = makeSample();
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.sendSample({
      sampleId: sample.id,
      input: { courier: 'DHL', trackingNumber: 'T-1', recipientName: 'QA', sentDate: '2099-01-05' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sample.sentToCustomer).toBe(true);
      expect(r.data.sample.sentDate).toBe('2099-01-05');
      expect(r.data.sample.attachments.rounds).toHaveLength(1);
      expect(r.data.sample.attachments.rounds[0].courier).toBe('DHL');
      expect(r.data.sample.attachments.rounds[0].shippedBy).toBe(ACTOR);
    }
  });

  it('已 approved → 不可再寄（ALREADY_APPROVED 409，闭环后须开新样品）', async () => {
    const sample = makeSample({ customerStatus: 'approved', sentToCustomer: true });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.sendSample({ sampleId: sample.id, input: { trackingNumber: 'T-2' }, actorId: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ALREADY_APPROVED');
  });
});

describe('confirmSample（客户确认，DR-028 闭环 / DR-029 QC 迭代）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未寄送 → NOT_SENT 409', async () => {
    const sample = makeSample({ sentToCustomer: false });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.confirmSample({
      sampleId: sample.id,
      input: { result: 'approved', confirmationDate: '2099-01-10', channel: 'email' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_SENT');
  });

  it('approved → 闭环：customerStatus=approved + 确认留痕', async () => {
    const sample = makeSample({ sentToCustomer: true, sentDate: '2099-01-05' });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createEarlyProductionSampleService({ prisma });
    await svc.sendSample({ sampleId: sample.id, input: { trackingNumber: 'T-1' }, actorId: ACTOR });
    const r = await svc.confirmSample({
      sampleId: sample.id,
      input: { result: 'approved', confirmationDate: '2099-01-10', channel: 'wechat', note: 'OK' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sample.customerStatus).toBe('approved');
      expect(r.data.sample.customerFeedbackDate).toBe('2099-01-10');
      expect(r.data.sample.attachments.lastConfirmation.channel).toBe('wechat');
    }
  });

  it('adjust_and_resend → 触发 QC 迭代（qcRequestedBy/At 写入，DR-029），订单状态不被本服务改动', async () => {
    const order = makeFabricOrder({ status: 'in_production' });
    const sample = makeSample({ sentToCustomer: true, sentDate: '2099-01-05' });
    const { prisma, state } = makePrisma({ order, samples: [sample] });
    const svc = createEarlyProductionSampleService({ prisma });
    await svc.sendSample({ sampleId: sample.id, input: { trackingNumber: 'T-1' }, actorId: ACTOR });
    const r = await svc.confirmSample({
      sampleId: sample.id,
      input: {
        result: 'adjust_and_resend',
        confirmationDate: '2099-01-10',
        channel: 'email',
        note: '手感偏硬',
        qcAdjustmentNote: '后整理加软',
        qcInspectionReportId: 'IR-1',
      },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sample.customerStatus).toBe('adjust_and_resend');
      expect(r.data.sample.qcRequestedBy).toBe(ACTOR);
      expect(r.data.sample.qcInspectionReportId).toBe('IR-1');
      expect(r.data.sample.attachments.qcAdjustmentNote).toBe('后整理加软');
    }
    // DR-028：正常反馈与 QC 调整不暂停大货生产（本服务不写 Order.status）
    expect(state.order.status).toBe('in_production');
  });

  it('重复确认 approved → ALREADY_APPROVED 409', async () => {
    const sample = makeSample({ sentToCustomer: true, customerStatus: 'approved' });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.confirmSample({
      sampleId: sample.id,
      input: { result: 'approved', confirmationDate: '2099-01-10', channel: 'email' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ALREADY_APPROVED');
  });
});

describe('listByOrder（previousSampleId 闭环链投影）', () => {
  it('构建 root → chain 层级', async () => {
    const s1 = makeSample({ id: 'EPS__1' });
    const s2 = makeSample({ id: 'EPS__2', previousSampleId: 'EPS__1', customerStatus: 'adjust_and_resend' });
    const s3 = makeSample({ id: 'EPS__3', previousSampleId: 'EPS__2', customerStatus: 'approved' });
    const { prisma } = makePrisma({ samples: [s1, s2, s3] });
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.listByOrder({ orderId: 'ORD-F1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items).toHaveLength(1);
      const root = r.data.items[0];
      expect(root.id).toBe('EPS__1');
      expect(root.chain).toHaveLength(1);
      expect(root.chain[0].id).toBe('EPS__2');
      expect(root.chain[0].chain[0].id).toBe('EPS__3');
    }
  });

  it('订单不存在 → NOT_FOUND', async () => {
    const { prisma } = makePrisma({ order: null });
    const svc = createEarlyProductionSampleService({ prisma });
    const r = await svc.listByOrder({ orderId: 'ORD-X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});
