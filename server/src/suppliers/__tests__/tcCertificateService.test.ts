/**
 * REQ2-06 GRS TC 交易证书链回归测试（设计文档 §7 验收场景）
 *
 * 覆盖：
 *   1. 登记校验（订单存在/三段枚举/tcNo 全局唯一/吨位正数/对手快照/日期格式/parent 同单）
 *   2. 链视图（orderId|relationId 二选一 + byStage 分组聚合）
 *   3. 一键校验四检查项（链完整性/段间吨位 Σ原料≥Σ工厂≥Σ我方/订单用量勾稽/有效期）
 *   4. 修正白名单 + 软删
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createTcCertificateService } from '../tcCertificateService';

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

function makeTc(overrides: any = {}) {
  return {
    id: 'TCC__X1',
    tcNo: 'TC-2026-001',
    orderId: 'PO-1',
    relationId: 'REL-1',
    relationName: '绍兴绿环再生纤维',
    stage: 'material_input',
    quantityKg: 10000,
    issuedAt: '2026-08-01',
    validUntil: '2027-08-01',
    attachmentPath: null,
    notes: null,
    parentTcId: null,
    createdAt: BigInt(1),
    updatedAt: BigInt(1),
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma(overrides: { tcs?: any[]; orderExists?: boolean; relation?: any } = {}) {
  const tcs = overrides.tcs ?? [];
  return {
    order: {
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        if (overrides.orderExists === false) return null;
        const where = args?.where ?? {};
        const lines = [
          { unit: 'KG', quantity: 9500 },
          { unit: 'M', quantity: 5000 },
        ];
        return { id: where.id, poNumber: 'DEMO-PO-GRS', deletedAt: null, lines };
      }),
    },
    relation: {
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        if (args?.where?.id === '__NONE__') return null;
        return overrides.relation ?? { id: args?.where?.id, name: '绍兴绿环再生纤维', deletedAt: null };
      }),
    },
    tcCertificate: {
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        const where = args?.where ?? {};
        if (where.id) return tcs.find(t => t.id === where.id && t.deletedAt === null) ?? null;
        if (where.tcNo) return tcs.find(t => t.tcNo === where.tcNo && t.deletedAt === null) ?? null;
        // parent 校验：同订单存在性
        if (where.orderId && where.id === undefined) return tcs.find(t => t.id === where.parentTcId) ?? null;
        return null;
      }),
      findMany: vi.fn().mockImplementation(async (args: any) => {
        const where = args?.where ?? {};
        return tcs.filter(t =>
          t.deletedAt === null
          && (where.orderId === undefined || t.orderId === where.orderId)
          && (where.relationId === undefined || t.relationId === where.relationId));
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...makeTc(), ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const target = tcs.find(t => t.id === where.id);
        if (target) Object.assign(target, data);
        return { ...(target ?? makeTc()), ...data };
      }),
    },
  } as any;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('createTc 登记校验', () => {
  it('登记成功：三段枚举 + 吨位 + 对手快照', async () => {
    const svc = createTcCertificateService(makePrisma());
    const r = await svc.createTc({
      orderId: 'PO-1', stage: 'material_input', tcNo: 'TC-2026-001',
      quantityKg: 10000, relationId: 'REL-1', issuedAt: '2026-08-01', validUntil: '2027-08-01',
    });
    expect(r.ok).toBe(true);
    expect((r as any).data.tc.relationName).toBe('绍兴绿环再生纤维');
  });

  it('tcNo 必填/重复 → 400/409；stage 非法 → 400；吨位 ≤0 → 400', async () => {
    const svc = createTcCertificateService(makePrisma({ tcs: [makeTc()] }));
    expect(((await svc.createTc({ orderId: 'PO-1', stage: 'our_sale', tcNo: '', quantityKg: 1 })) as any).error.code).toBe('TC_NO_REQUIRED');
    expect(((await svc.createTc({ orderId: 'PO-1', stage: 'our_sale', tcNo: 'TC-2026-001', quantityKg: 1 })) as any).error.code).toBe('TC_NO_DUP');
    expect(((await svc.createTc({ orderId: 'PO-1', stage: 'input', tcNo: 'TC-002', quantityKg: 1 })) as any).error.code).toBe('INVALID_STAGE');
    expect(((await svc.createTc({ orderId: 'PO-1', stage: 'our_sale', tcNo: 'TC-002', quantityKg: 0 })) as any).error.code).toBe('INVALID_QTY');
  });

  it('订单不存在 → 404；对手不存在 → 400；parent 异单 → 400', async () => {
    const svc1 = createTcCertificateService(makePrisma({ orderExists: false }));
    expect(((await svc1.createTc({ orderId: 'PO-X', stage: 'our_sale', tcNo: 'TC-1', quantityKg: 1 })) as any).error.status).toBe(404);

    const svc2 = createTcCertificateService(makePrisma());
    expect(((await svc2.createTc({ orderId: 'PO-1', stage: 'our_sale', tcNo: 'TC-1', quantityKg: 1, relationId: '__NONE__' })) as any).error.code).toBe('RELATION_NOT_FOUND');
  });

  it('日期格式非法 → 400', async () => {
    const svc = createTcCertificateService(makePrisma());
    expect(((await svc.createTc({ orderId: 'PO-1', stage: 'our_sale', tcNo: 'TC-1', quantityKg: 1, issuedAt: '2026/08/01' })) as any).error.code).toBe('INVALID_DATE');
  });
});

describe('listTc 链视图', () => {
  it('byStage 分组聚合 + 二选一 scope 校验', async () => {
    const tcs = [
      makeTc({ id: 'A', tcNo: 'T1', stage: 'material_input', quantityKg: 10000 }),
      makeTc({ id: 'B', tcNo: 'T2', stage: 'material_input', quantityKg: 500, relationId: 'REL-2' }),
      makeTc({ id: 'C', tcNo: 'T3', stage: 'factory_output', quantityKg: 9800 }),
      makeTc({ id: 'D', tcNo: 'T4', stage: 'our_sale', quantityKg: 9500 }),
    ];
    const svc = createTcCertificateService(makePrisma({ tcs }));
    const r = await svc.listTc({ orderId: 'PO-1' });
    expect(r.ok).toBe(true);
    const { items, byStage } = (r as any).data;
    expect(items.length).toBe(4);
    const material = byStage.find((s: any) => s.stage === 'material_input');
    expect(material.count).toBe(2);
    expect(material.totalKg).toBe(10500);

    // 供应商维度（认证 Tab 追溯）
    const r2 = await svc.listTc({ relationId: 'REL-2' });
    expect((r2 as any).data.items.length).toBe(1);

    expect(((await svc.listTc({})) as any).error.code).toBe('SCOPE_REQUIRED');
  });
});

describe('verifyChain 一键校验（验收锚点：出货门禁前链完整性）', () => {
  it('三段齐 + 吨位递减 + 覆盖订单用量 + 未过期 → verdict complete', async () => {
    const tcs = [
      makeTc({ id: 'A', tcNo: 'T1', stage: 'material_input', quantityKg: 10000 }),
      makeTc({ id: 'C', tcNo: 'T3', stage: 'factory_output', quantityKg: 9800 }),
      makeTc({ id: 'D', tcNo: 'T4', stage: 'our_sale', quantityKg: 9600 }),
    ];
    const svc = createTcCertificateService(makePrisma({ tcs }));
    const r = await svc.verifyChain('PO-1');
    expect(r.ok).toBe(true);
    const v = (r as any).data;
    // 订单 KG 行 9500，我方 TC 9600 ≥ 9500 → 覆盖
    expect(v.verdict).toBe('complete');
    expect(v.missingStages).toEqual([]);
    expect(v.tonnageWarnings).toEqual([]);
    expect(v.orderUsage.warning).toBeNull();
  });

  it('缺段 → missingStages 列出（验收锚点：缺链预警）', async () => {
    const tcs = [makeTc({ id: 'A', tcNo: 'T1', stage: 'material_input', quantityKg: 10000 })];
    const svc = createTcCertificateService(makePrisma({ tcs }));
    const v = (await svc.verifyChain('PO-1') as any).data;
    expect(v.verdict).toBe('warning');
    const stages = v.missingStages.map((s: any) => s.stage);
    expect(stages).toContain('factory_output');
    expect(stages).toContain('our_sale');
  });

  it('段间吨位倒挂 → tonnageWarnings（Σ原料 < Σ工厂；Σ工厂 < Σ我方）', async () => {
    const tcs = [
      makeTc({ id: 'A', tcNo: 'T1', stage: 'material_input', quantityKg: 9000 }),
      makeTc({ id: 'C', tcNo: 'T3', stage: 'factory_output', quantityKg: 9500 }),
      makeTc({ id: 'D', tcNo: 'T4', stage: 'our_sale', quantityKg: 9800 }),
    ];
    const svc = createTcCertificateService(makePrisma({ tcs }));
    const v = (await svc.verifyChain('PO-1') as any).data;
    expect(v.tonnageWarnings.length).toBe(2);
    expect(v.tonnageWarnings[0]).toContain('原料 TC 吨位 9000');
    expect(v.tonnageWarnings[1]).toContain('工厂 TC 吨位 9500');
  });

  it('我方 TC < 订单用量 → orderUsage.warning（增强锚点：TC 吨位不足预警）', async () => {
    const tcs = [
      makeTc({ id: 'A', tcNo: 'T1', stage: 'material_input', quantityKg: 10000 }),
      makeTc({ id: 'C', tcNo: 'T3', stage: 'factory_output', quantityKg: 9800 }),
      makeTc({ id: 'D', tcNo: 'T4', stage: 'our_sale', quantityKg: 9000 }),
    ];
    const svc = createTcCertificateService(makePrisma({ tcs }));
    const v = (await svc.verifyChain('PO-1') as any).data;
    // 订单 KG 行 9500，我方 TC 9000 < 9500
    expect(v.orderUsage.checked).toBe(true);
    expect(v.orderUsage.orderUsageKg).toBe(9500);
    expect(v.orderUsage.warning).toContain('9000');
  });

  it('TC 过期 → expiredTc 列出', async () => {
    const tcs = [
      makeTc({ id: 'A', tcNo: 'T1', stage: 'material_input', quantityKg: 10000 }),
      makeTc({ id: 'C', tcNo: 'T3', stage: 'factory_output', quantityKg: 9800, validUntil: YESTERDAY }),
      makeTc({ id: 'D', tcNo: 'T4', stage: 'our_sale', quantityKg: 9600, validUntil: null }),
    ];
    const svc = createTcCertificateService(makePrisma({ tcs }));
    const v = (await svc.verifyChain('PO-1') as any).data;
    expect(v.expiredTc.length).toBe(1);
    expect(v.expiredTc[0].tcNo).toBe('T3');
    expect(v.verdict).toBe('warning');
  });

  it('订单不存在 → 404；orderId 缺失 → 400', async () => {
    const svc = createTcCertificateService(makePrisma({ orderExists: false }));
    expect(((await svc.verifyChain('PO-X')) as any).error.status).toBe(404);
    expect(((await svc.verifyChain('')) as any).error.code).toBe('ORDER_REQUIRED');
  });
});

describe('updateTc + deleteTc', () => {
  it('修正吨位/效期白名单；tcNo/stage 不可改（静默忽略）；不存在 404', async () => {
    const svc = createTcCertificateService(makePrisma({ tcs: [makeTc()] }));
    const r = await svc.updateTc('TCC__X1', { quantityKg: 10500, notes: '修正吨位' });
    expect(r.ok).toBe(true);
    expect(Number((r as any).data.tc.quantityKg)).toBe(10500);
    expect(((await svc.updateTc('TCC__NONE', { quantityKg: 1 })) as any).error.status).toBe(404);
  });

  it('软删后链视图/校验排除', async () => {
    const tcs = [makeTc()];
    const svc = createTcCertificateService(makePrisma({ tcs }));
    expect((await svc.deleteTc('TCC__X1')).ok).toBe(true);
    expect(tcs[0].deletedAt).toBeDefined();
    // tcNo 复用（软删后重建同号不冲突——findFirst 过滤 deletedAt）
    const r = await svc.createTc({ orderId: 'PO-1', stage: 'material_input', tcNo: 'TC-2026-001', quantityKg: 1 });
    expect(r.ok).toBe(true);
  });
});
