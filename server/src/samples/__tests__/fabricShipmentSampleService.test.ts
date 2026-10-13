import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createFabricShipmentSampleService,
  computeSampleCountdown,
  SS_CONFIRM_DEADLINE_DAYS,
  RC_CONFIRM_DEADLINE_DAYS,
} from '../fabricShipmentSampleService';
import { logger } from '../../lib/logger';

vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('audit_test_id'),
}));

function makeFabricOrder(overrides: any = {}) {
  return {
    id: 'ORD-F1',
    orderNo: 'SO-F-1',
    type: 'Fabric',
    businessLine: 'fabric',
    status: 'confirmed',
    clientDate: '2099-12-31', // Exmill Date（远期，默认不逾期）
    deletedAt: null,
    ...overrides,
  };
}

function makeSample(overrides: any = {}) {
  return {
    id: 'FSS__1',
    sampleCode: 'FSS-20990101-001',
    shipmentId: '',
    orderId: 'ORD-F1',
    fabricProfileId: null,
    sampleQuantity: 2,
    sampleUnit: 'meter',
    batchNo: null,
    rollNos: [],
    cuttingDate: '2099-01-01',
    sentToCustomer: false,
    sentDate: null,
    courier: null,
    trackingNumber: null,
    recipientName: null,
    recipientContact: null,
    customerStatus: 'pending',
    customerFeedbackDate: null,
    customerFeedbackNote: null,
    notes: null,
    attachments: { sampleKind: 'SS' },
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
  const fss: any = {
    create: vi.fn().mockImplementation(async ({ data }: any) => {
      const row = { ...makeSample(), ...data, id: data.id ?? `FSS__${++state.seq}` };
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
  const tx: any = { fabricShipmentSample: fss };
  const prisma: any = {
    order: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        if (!state.order) return null;
        if (where?.id && state.order.id !== where.id) return null;
        return state.order;
      }),
    },
    fabricShipmentSample: fss,
    orderSampleSource: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { prisma, state };
}

const ACTOR = 'u_sales_1';

describe('registerShipmentSample（S/S 船样登记，DR-011）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功登记 S/S：sampleCode 前缀 FSS- + attachments.sampleKind=SS + customerStatus=pending', async () => {
    const { prisma } = makePrisma();
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerShipmentSample({
      orderId: 'ORD-F1',
      input: { sampleQuantity: 2, cuttingDate: '2099-01-01' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sample.sampleCode).toMatch(/^FSS-\d{8}-001$/);
      expect(r.data.sample.attachments.sampleKind).toBe('SS');
      expect(r.data.sample.customerStatus).toBe('pending');
      expect(r.data.sample.shipmentId).toBe('');
    }
  });

  it('缺 sampleQuantity / cuttingDate → INVALID_INPUT', async () => {
    const { prisma } = makePrisma();
    const svc = createFabricShipmentSampleService({ prisma });
    const r1 = await svc.registerShipmentSample({ orderId: 'ORD-F1', input: { cuttingDate: '2099-01-01' } as any, actorId: ACTOR });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('INVALID_INPUT');
    const r2 = await svc.registerShipmentSample({ orderId: 'ORD-F1', input: { sampleQuantity: 2, cuttingDate: '01/01/2099' } as any, actorId: ACTOR });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('INVALID_INPUT');
  });

  it('非面料订单 → NOT_FABRIC_ORDER（DR-011 模型边界）', async () => {
    const { prisma } = makePrisma({ order: makeFabricOrder({ type: 'Garment', businessLine: 'garment' }) });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerShipmentSample({
      orderId: 'ORD-F1',
      input: { sampleQuantity: 2, cuttingDate: '2099-01-01' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FABRIC_ORDER');
  });

  it('订单不存在 → NOT_FOUND 404', async () => {
    const { prisma } = makePrisma({ order: null });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerShipmentSample({
      orderId: 'ORD-X',
      input: { sampleQuantity: 2, cuttingDate: '2099-01-01' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('NOT_FOUND');
      expect(r.error.status).toBe(404);
    }
  });
});

describe('enableHeadSample（RC 匹头样启用，DR-011 留痕）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功启用 RC：enabledReason/operator/time 留痕 + override 覆盖时限留痕', async () => {
    const { prisma } = makePrisma();
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.enableHeadSample({
      orderId: 'ORD-F1',
      input: {
        enabledReason: 'Separates 客户要求匹头确认',
        deadlineOverrideDays: 10,
        deadlineOverrideReason: '合同明确 Exmill 前 10 天完成确认',
      },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sample.sampleCode).toMatch(/^FRC-/);
      const rc = r.data.sample.attachments.rc;
      expect(rc.enabledReason).toContain('Separates');
      expect(rc.enabledBy).toBe(ACTOR);
      expect(rc.deadlineOverrideDays).toBe(10);
      expect(rc.deadlineOverrideReason).toContain('合同');
    }
  });

  it('enabledReason 缺失 → INVALID_INPUT', async () => {
    const { prisma } = makePrisma();
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.enableHeadSample({ orderId: 'ORD-F1', input: {} as any, actorId: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('override 无原因 → OVERRIDE_REASON_REQUIRED（DR-011 覆盖留痕强制）', async () => {
    const { prisma } = makePrisma();
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.enableHeadSample({
      orderId: 'ORD-F1',
      input: { enabledReason: '常年翻单', deadlineOverrideDays: 10 },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OVERRIDE_REASON_REQUIRED');
  });

  it('同订单重复启用 RC → RC_ALREADY_ENABLED 409', async () => {
    const { prisma } = makePrisma();
    const svc = createFabricShipmentSampleService({ prisma });
    const first = await svc.enableHeadSample({ orderId: 'ORD-F1', input: { enabledReason: 'Separates' }, actorId: ACTOR });
    expect(first.ok).toBe(true);
    const second = await svc.enableHeadSample({ orderId: 'ORD-F1', input: { enabledReason: '再次启用' }, actorId: ACTOR });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('RC_ALREADY_ENABLED');
      expect(second.error.status).toBe(409);
    }
  });
});

describe('registerSampleShipment（寄送登记，DR-039 单据链）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功寄送：sentToCustomer=true + lastShipment 记录快递商/单号/收件方/日期', async () => {
    const sample = makeSample();
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerSampleShipment({
      sampleId: sample.id,
      input: {
        courier: 'DHL',
        trackingNumber: 'DHL-123',
        recipientName: 'ABC Textiles QA',
        recipientContact: 'qa@abc.com',
        sentDate: '2099-01-05',
        documents: [{ type: 'sample_invoice', ref: 'INV-1' }],
      },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sample.sentToCustomer).toBe(true);
      expect(r.data.sample.courier).toBe('DHL');
      expect(r.data.sample.trackingNumber).toBe('DHL-123');
      expect(r.data.sample.recipientName).toBe('ABC Textiles QA');
      const last = r.data.sample.attachments.lastShipment;
      expect(last.courier).toBe('DHL');
      expect(last.trackingNumber).toBe('DHL-123');
      expect(last.recipientName).toBe('ABC Textiles QA');
      expect(last.shippedBy).toBe(ACTOR);
      expect(r.data.sample.attachments.shipmentDocuments).toHaveLength(1);
    }
  });

  it('DR-039 必填：缺 courier / trackingNumber / recipientName → INVALID_INPUT', async () => {
    const sample = makeSample();
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma });
    for (const input of [
      { trackingNumber: 'T', recipientName: 'R' },
      { courier: 'DHL', recipientName: 'R' },
      { courier: 'DHL', trackingNumber: 'T' },
    ]) {
      const r = await svc.registerSampleShipment({ sampleId: sample.id, input: input as any, actorId: ACTOR });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
    }
  });

  it('客户已 approved → 不可重复寄送登记（ALREADY_CONFIRMED 409）', async () => {
    const sample = makeSample({ customerStatus: 'approved', sentToCustomer: true });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerSampleShipment({
      sampleId: sample.id,
      input: { courier: 'DHL', trackingNumber: 'T', recipientName: 'R' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ALREADY_CONFIRMED');
  });

  it('needs_revision 后重寄 → customerStatus 回到 pending', async () => {
    const sample = makeSample({ customerStatus: 'needs_revision', sentToCustomer: true });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerSampleShipment({
      sampleId: sample.id,
      input: { courier: 'SF', trackingNumber: 'SF-9', recipientName: 'R' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.sample.customerStatus).toBe('pending');
  });
});

describe('registerCustomerConfirmation（客户确认登记，DR-012 确认链）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未寄送 → SAMPLE_NOT_SENT 409（先寄后确认）', async () => {
    const sample = makeSample({ sentToCustomer: false });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerCustomerConfirmation({
      sampleId: sample.id,
      input: { result: 'approved', confirmationDate: '2099-01-10', channel: 'email' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SAMPLE_NOT_SENT');
  });

  it('channel 必填（客户不登录系统，须登记确认渠道）', async () => {
    const sample = makeSample({ sentToCustomer: true });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerCustomerConfirmation({
      sampleId: sample.id,
      input: { result: 'approved', confirmationDate: '2099-01-10' } as any,
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('成功登记 approved：customerStatus + 确认日期/渠道/证据/确认人全留痕', async () => {
    const sample = makeSample({ sentToCustomer: true, sentDate: '2099-01-05' });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.registerCustomerConfirmation({
      sampleId: sample.id,
      input: {
        result: 'approved',
        confirmationDate: '2099-01-10',
        channel: 'email',
        note: '颜色 OK',
        evidence: [{ type: 'email', ref: 'msg-1' }],
      },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sample.customerStatus).toBe('approved');
      expect(r.data.sample.customerFeedbackDate).toBe('2099-01-10');
      const att = r.data.sample.attachments;
      expect(att.confirmationChannel).toBe('email');
      expect(att.confirmedBy).toBe(ACTOR);
      expect(att.confirmations).toHaveLength(1);
      expect(att.confirmations[0].result).toBe('approved');
      expect(att.confirmations[0].evidence).toHaveLength(1);
    }
  });
});

describe('computeShipmentEligibility（DR-012 样品链发货门禁判定）', () => {
  beforeEach(() => vi.clearAllMocks());

  async function eligibilityWith(samples: any[]) {
    const { prisma } = makePrisma({ samples });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.computeShipmentEligibility({ orderId: 'ORD-F1' });
    expect(r.ok).toBe(true);
    return r.ok ? r.data.eligibility : null;
  }

  it('无 S/S → eligible=false + SS_NOT_REGISTERED', async () => {
    const e = await eligibilityWith([]);
    expect(e!.eligibleForNormalShipment).toBe(false);
    expect(e!.blockingReasons).toContain('SS_NOT_REGISTERED');
  });

  it('S/S 已寄未确认 → SS_NOT_CONFIRMED（DR-012：寄出后未登记确认不得正常发货）', async () => {
    const e = await eligibilityWith([makeSample({ sentToCustomer: true, sentDate: '2099-01-05' })]);
    expect(e!.eligibleForNormalShipment).toBe(false);
    expect(e!.blockingReasons).toContain('SS_NOT_CONFIRMED');
  });

  it('S/S 登记未寄 → SS_NOT_SENT', async () => {
    const e = await eligibilityWith([makeSample()]);
    expect(e!.eligibleForNormalShipment).toBe(false);
    expect(e!.blockingReasons).toContain('SS_NOT_SENT');
  });

  it('S/S 最新被 rejected → SS_REJECTED', async () => {
    const e = await eligibilityWith([makeSample({ sentToCustomer: true, sentDate: '2099-01-05', customerStatus: 'rejected' })]);
    expect(e!.eligibleForNormalShipment).toBe(false);
    expect(e!.blockingReasons).toContain('SS_REJECTED');
  });

  it('S/S approved 且未启用 RC → eligible=true', async () => {
    const e = await eligibilityWith([makeSample({ sentToCustomer: true, customerStatus: 'approved' })]);
    expect(e!.eligibleForNormalShipment).toBe(true);
    expect(e!.blockingReasons).toHaveLength(0);
    expect(e!.gates.ss.satisfied).toBe(true);
  });

  it('启用 RC 未寄 → RC_NOT_SENT；已寄未确认 → RC_NOT_CONFIRMED（DR-014 并行条件）', async () => {
    const ssApproved = makeSample({ id: 'SS1', sentToCustomer: true, customerStatus: 'approved' });
    const rc = makeSample({
      id: 'RC1',
      sampleCode: 'FRC-20990101-001',
      attachments: { sampleKind: 'RC', rc: { enabledReason: 'Separates' } },
    });
    const e1 = await eligibilityWith([ssApproved, rc]);
    expect(e1!.eligibleForNormalShipment).toBe(false);
    expect(e1!.blockingReasons).toContain('RC_NOT_SENT');

    const e2 = await eligibilityWith([ssApproved, { ...rc, sentToCustomer: true, sentDate: '2099-01-06' }]);
    expect(e2!.eligibleForNormalShipment).toBe(false);
    expect(e2!.blockingReasons).toContain('RC_NOT_CONFIRMED');
  });

  it('S/S + RC 双确认 → eligible=true', async () => {
    const ssApproved = makeSample({ id: 'SS1', sentToCustomer: true, customerStatus: 'approved' });
    const rcApproved = makeSample({
      id: 'RC1',
      sampleCode: 'FRC-20990101-001',
      sentToCustomer: true,
      customerStatus: 'approved',
      attachments: { sampleKind: 'RC', rc: { enabledReason: 'Separates' } },
    });
    const e = await eligibilityWith([ssApproved, rcApproved]);
    expect(e!.eligibleForNormalShipment).toBe(true);
    expect(e!.gates.rc.enabled).toBe(true);
    expect(e!.gates.rc.satisfied).toBe(true);
  });

  it('判定声明 DR-013 例外由出运域叠加，本判定不含放行通道', async () => {
    const e = await eligibilityWith([]);
    expect(e!.exceptionHook).toContain('shipping domain');
  });
});

describe('assertFabricShipmentGate（DR-013 例外门禁消费）', () => {
  beforeEach(() => vi.clearAllMocks());

  const EXC = {
    id: 'EXC_1',
    exceptionNumber: 'EXC-20260817-001',
    exceptionCategory: 'shipment_release',
    subCategory: null,
    status: 'ReviewerApproved',
    bossFinalBypass: false,
    validUntil: null,
  };

  it('正常资格（S/S approved）→ passedVia=gate，checker 不被调用（例外不被无意核销）', async () => {
    const { prisma } = makePrisma({
      samples: [makeSample({ sentToCustomer: true, customerStatus: 'approved' })],
    });
    const checker = vi.fn();
    const svc = createFabricShipmentSampleService({ prisma, exceptionChecker: checker });
    const r = await svc.assertFabricShipmentGate({ orderId: 'ORD-F1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.pass).toEqual({ passedVia: 'gate' });
      expect(r.data.eligibility.eligibleForNormalShipment).toBe(true);
    }
    expect(checker).not.toHaveBeenCalled();
  });

  it('不具备资格 + 生效例外精确命中 → passedVia=exception + 例外摘要（徽标数据）', async () => {
    const { prisma } = makePrisma({ samples: [] }); // SS_NOT_REGISTERED
    const checker = vi.fn(async () => ({ active: true, exception: EXC }));
    const svc = createFabricShipmentSampleService({ prisma, exceptionChecker: checker });
    const r = await svc.assertFabricShipmentGate({ orderId: 'ORD-F1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.pass).toEqual({ passedVia: 'exception', exception: EXC });
    }
  });

  it('不具备资格 + 无生效例外 → GATE_BLOCKED 409 + blockingReasons + 申请入口提示 + exceptionReason', async () => {
    const { prisma } = makePrisma({ samples: [] });
    const checker = vi.fn(async () => ({ active: false, reason: 'NO_ACTIVE_EXCEPTION' }));
    const svc = createFabricShipmentSampleService({ prisma, exceptionChecker: checker });
    const r = await svc.assertFabricShipmentGate({ orderId: 'ORD-F1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('GATE_BLOCKED');
      expect(r.error.status).toBe(409);
      expect(r.error.blockingReasons).toContain('SS_NOT_REGISTERED');
      expect(r.error.exceptionReason).toBe('NO_ACTIVE_EXCEPTION');
      expect(r.error.message).toContain('DR-013');
      expect(r.error.exceptionEntryHint).toContain('POST /api/v1/exceptions');
    }
  });

  it('不具备资格 + 例外已过期 → GATE_BLOCKED + EXCEPTION_EXPIRED（消息引导重新申请）', async () => {
    const { prisma } = makePrisma({ samples: [makeSample({ sentToCustomer: true, sentDate: '2099-01-05' })] });
    const checker = vi.fn(async () => ({ active: false, reason: 'EXCEPTION_EXPIRED' }));
    const svc = createFabricShipmentSampleService({ prisma, exceptionChecker: checker });
    const r = await svc.assertFabricShipmentGate({ orderId: 'ORD-F1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('GATE_BLOCKED');
      expect(r.error.exceptionReason).toBe('EXCEPTION_EXPIRED');
      expect(r.error.message).toContain('重新申请');
      expect(r.error.blockingReasons).toContain('SS_NOT_CONFIRMED');
    }
  });

  it('未注入 checker + 不具备资格 → GATE_BLOCKED（fail-closed，无隐藏旁路）', async () => {
    const { prisma } = makePrisma({ samples: [] });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.assertFabricShipmentGate({ orderId: 'ORD-F1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('GATE_BLOCKED');
      expect(r.error.exceptionReason).toBe('NO_ACTIVE_EXCEPTION');
    }
  });

  it('scope 精确绑定：checker 收到 {targetType:Order, targetId:orderId, action:shipment:release}，at 透传', async () => {
    const { prisma } = makePrisma({ samples: [] });
    const checker = vi.fn(async () => ({ active: true, exception: EXC }));
    const svc = createFabricShipmentSampleService({ prisma, exceptionChecker: checker });
    const at = new Date('2026-08-17T10:00:00Z');
    await svc.assertFabricShipmentGate({ orderId: 'ORD-F1', at });
    expect(checker).toHaveBeenCalledWith({
      targetType: 'Order',
      targetId: 'ORD-F1',
      action: 'shipment:release',
      at,
    });
  });

  it('订单不存在 → 透传 NOT_FOUND（不进入例外查询）', async () => {
    const { prisma } = makePrisma({ order: null });
    const checker = vi.fn();
    const svc = createFabricShipmentSampleService({ prisma, exceptionChecker: checker });
    const r = await svc.assertFabricShipmentGate({ orderId: 'ORD-NONE' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    expect(checker).not.toHaveBeenCalled();
  });
});

describe('computeSampleCountdown（DR-011 Exmill 倒计时）', () => {
  const order = makeFabricOrder({ clientDate: '2099-12-31' });

  it('S/S 截止日 = Exmill − 14 天', () => {
    const c = computeSampleCountdown(makeSample(), order);
    expect(c.kind).toBe('SS');
    expect(c.deadlineDays).toBe(SS_CONFIRM_DEADLINE_DAYS);
    expect(c.confirmDeadline).toBe('2099-12-17');
    expect(c.overdue).toBe(false);
  });

  it('RC 默认截止日 = Exmill − 7 天', () => {
    const rc = makeSample({ sampleCode: 'FRC-1', attachments: { sampleKind: 'RC', rc: { enabledReason: 'x' } } });
    const c = computeSampleCountdown(rc, order);
    expect(c.kind).toBe('RC');
    expect(c.deadlineDays).toBe(RC_CONFIRM_DEADLINE_DAYS);
    expect(c.confirmDeadline).toBe('2099-12-24');
    expect(c.deadlineOverridden).toBe(false);
  });

  it('RC 订单明确时限覆盖默认（deadlineOverrideDays 生效 + 标记）', () => {
    const rc = makeSample({
      sampleCode: 'FRC-1',
      attachments: { sampleKind: 'RC', rc: { enabledReason: 'x', deadlineOverrideDays: 10 } },
    });
    const c = computeSampleCountdown(rc, order);
    expect(c.deadlineDays).toBe(10);
    expect(c.confirmDeadline).toBe('2099-12-21');
    expect(c.deadlineOverridden).toBe(true);
  });

  it('已过截止日且未确认 → overdue=true；已确认 → overdue=false', () => {
    const pastOrder = makeFabricOrder({ clientDate: '2020-01-31' });
    const pending = computeSampleCountdown(makeSample(), pastOrder);
    expect(pending.confirmDeadline).toBe('2020-01-17');
    expect(pending.overdue).toBe(true);

    const confirmed = computeSampleCountdown(makeSample({ customerStatus: 'approved' }), pastOrder);
    expect(confirmed.overdue).toBe(false);
  });

  it('Exmill 缺失 → 无截止日且不判逾期', () => {
    const c = computeSampleCountdown(makeSample(), makeFabricOrder({ clientDate: null }));
    expect(c.confirmDeadline).toBeNull();
    expect(c.daysToDeadline).toBeNull();
    expect(c.overdue).toBe(false);
  });
});

describe('listOrderSamples（含倒计时投影）', () => {
  it('返回样品列表 + sampleKind + countdown', async () => {
    const { prisma } = makePrisma({
      samples: [
        makeSample({ id: 'SS1' }),
        makeSample({ id: 'RC1', sampleCode: 'FRC-1', attachments: { sampleKind: 'RC', rc: { enabledReason: 'x' } } }),
      ],
    });
    const svc = createFabricShipmentSampleService({ prisma });
    const r = await svc.listOrderSamples({ orderId: 'ORD-F1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items).toHaveLength(2);
      const kinds = r.data.items.map((i: any) => i.sampleKind);
      expect(kinds).toEqual(['SS', 'RC']);
      expect(r.data.items[0].countdown.confirmDeadline).toBe('2099-12-17');
    }
  });
});

/**
 * §9 **B39** · 位置参数内插原文的**执行覆盖**（R3 / §6 S1）
 *
 * 为什么必须补：B39 的棘轮只数**语法形状**，它变绿只能证明"没有这种写法了"，
 * **不能证明用户收到的是中文**。本批把这 4 处 ``fail(CODE, `固定文案: ${String(e?.message ?? e)}`, 500)``
 * 换成了字面中文，**同时补上了原本一处都没有的 `logger.error`**（实测该文件 `logger.error` 计数原为 0）
 * —— 若只换文案不补日志，等于把唯一的线索删掉。
 *
 * 出口链已核过（不是假设）：`sampleRoute.ts:90` 的 `sendResult` 把 `r.error.message` **原样**转发给客户端
 * ⇒ 这里断言的服务层文案就是用户看到的东西。
 */
const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/samples/fabricShipmentSampleService.ts:280 — '
  + 'Unique constraint failed on the fields: (`sampleCode`)';

const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'fabricShipmentSampleService.ts:280', 'Unique constraint', '/srv/app', 'P2002'];

/** 对外文案硬门槛：含中文、够长、说下一步、零拉丁词（原文上屏最直观的指纹） */
function expectCopy(msg: unknown, mustMention: string) {
  expect(typeof msg).toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `必须说清对象：${s}`).toContain(mustMention);
  expect(s, `必须给下一步：${s}`).toMatch(/(稍后重试|联系管理员)/);
  const latin = s.match(/[A-Za-z]{3,}/g) ?? [];
  expect(latin, `混入拉丁词（疑似原文上屏）：${JSON.stringify(latin)}`).toEqual([]);
}

describe('§9 B39 · 事务失败时用户收到的是中文，不是 Prisma 原文', () => {
  beforeEach(() => vi.clearAllMocks());

  /** 让 `$transaction` 抛错（事务之前的读全部正常 ⇒ 精确落在 B39 那处 catch） */
  function txThrows(prisma: any) {
    prisma.$transaction = vi.fn(async () => { throw new Error(B39_RAW); });
    return prisma;
  }

  it('registerShipmentSample（S/S 船样登记）', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const { prisma } = makePrisma();
    const svc = createFabricShipmentSampleService({ prisma: txThrows(prisma) });
    const r = await svc.registerShipmentSample({ orderId: 'ORD-F1', input: { sampleQuantity: 2, cuttingDate: '2099-01-01' }, actorId: ACTOR });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code, '码名不得随文案一起改（前端按码分支）').toBe('CREATE_FAILED');
    expect(r.error.status).toBe(500);
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectCopy(r.error.message, '船样');
    expect(spy, '原文必须仍进日志（清文案 ≠ 丢证据）').toHaveBeenCalledWith(expect.stringContaining('[Samples]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });

  it('enableHeadSample（RC 匹头样启用）', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const { prisma } = makePrisma();
    const svc = createFabricShipmentSampleService({ prisma: txThrows(prisma) });
    const r = await svc.enableHeadSample({ orderId: 'ORD-F1', input: { enabledReason: '客户要求匹头确认' }, actorId: ACTOR });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CREATE_FAILED');
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectCopy(r.error.message, '匹头样');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[Samples]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });

  it('registerSampleShipment（寄送登记）', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const sample = makeSample();
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma: txThrows(prisma) });
    const r = await svc.registerSampleShipment({
      sampleId: sample.id,
      input: { courier: 'DHL', trackingNumber: 'DHL-123', recipientName: 'ABC QA', sentDate: '2099-01-05' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UPDATE_FAILED');
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectCopy(r.error.message, '寄送登记');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[Samples]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });

  it('registerCustomerConfirmation（客户确认登记）', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const sample = makeSample({ sentToCustomer: true, sentDate: '2099-01-05' });
    const { prisma } = makePrisma({ samples: [sample] });
    const svc = createFabricShipmentSampleService({ prisma: txThrows(prisma) });
    const r = await svc.registerCustomerConfirmation({
      sampleId: sample.id,
      input: { result: 'approved', confirmationDate: '2099-01-10', channel: 'email' },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UPDATE_FAILED');
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectCopy(r.error.message, '客户确认');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[Samples]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });
});

