/**
 * sequenceService 单测
 * 覆盖：纯函数 periodKeyForDate/renderFormatTemplate/isSequenceType
 *      + nextNumber（DB 模式 + fallback 模式 + format 模板 + padding + voided 碰撞重试）
 *      + peekNextNumber + getSequenceStatus/listSequenceStatuses
 *      + markVoided/isVoided/listVoided 作废追踪
 *      + 12 类 SequenceType 配置
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  createSequenceService,
  periodKeyForDate,
  renderFormatTemplate,
  isSequenceType,
  SEQUENCE_TYPE_CONFIGS,
  ALL_SEQUENCE_TYPES,
  type SequenceType,
} from '../sequenceService';

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// 纯函数：periodKeyForDate
// ═══════════════════════════════════════════════════════════════
describe('periodKeyForDate 周期键计算', () => {
  const date = new Date(2026, 7, 15); // 2026-08-15 (month 0-indexed)

  it('year → 4 位年', () => {
    expect(periodKeyForDate('year', date)).toBe('2026');
  });

  it('month → YYYY-MM', () => {
    expect(periodKeyForDate('month', date)).toBe('2026-08');
  });

  it('day → YYYY-MM-DD', () => {
    expect(periodKeyForDate('day', date)).toBe('2026-08-15');
  });

  it('none → __global__', () => {
    expect(periodKeyForDate('none', date)).toBe('__global__');
  });

  it('1 位数月/日补零', () => {
    const d = new Date(2026, 0, 5); // 2026-01-05
    expect(periodKeyForDate('month', d)).toBe('2026-01');
    expect(periodKeyForDate('day', d)).toBe('2026-01-05');
  });
});

// ═══════════════════════════════════════════════════════════════
// 纯函数：renderFormatTemplate
// ═══════════════════════════════════════════════════════════════
describe('renderFormatTemplate 格式模板渲染', () => {
  const date = new Date(2026, 7, 15);

  it('{prefix}-{year}-{seq:04} 标准 4 位流水', () => {
    const r = renderFormatTemplate('{prefix}-{year}-{seq:04}', { prefix: 'QT', seq: 42, date });
    expect(r).toBe('QT-2026-0042');
  });

  it('{prefix}-{year}{month}-{seq:03} 按月 3 位', () => {
    const r = renderFormatTemplate('{prefix}-{year}{month}-{seq:03}', { prefix: 'SO', seq: 7, date });
    expect(r).toBe('SO-202608-007');
  });

  it('{prefix}-{seq:05} 永久序列 5 位', () => {
    const r = renderFormatTemplate('{prefix}-{seq:05}', { prefix: 'CUS', seq: 123 });
    expect(r).toBe('CUS-00123');
  });

  it('{prefix}-{year}-{seq:pad=4} pad= 语法等价 :04', () => {
    const r = renderFormatTemplate('{prefix}-{year}-{seq:pad=4}', { prefix: 'INV', seq: 5, date });
    expect(r).toBe('INV-2026-0005');
  });

  it('{seq} 无显式补零 → 用 defaultPadding', () => {
    const r = renderFormatTemplate('{prefix}-{seq}', { prefix: 'X', seq: 9, defaultPadding: 4 });
    expect(r).toBe('X-0009');
  });

  it('{day} 变量替换', () => {
    const r = renderFormatTemplate('{prefix}-{year}{month}{day}-{seq:03}', { prefix: 'D', seq: 1, date });
    expect(r).toBe('D-20260815-001');
  });

  it('seq=0 正确补零', () => {
    const r = renderFormatTemplate('{prefix}-{seq:04}', { prefix: 'X', seq: 0 });
    expect(r).toBe('X-0000');
  });

  it('大序号不截断', () => {
    const r = renderFormatTemplate('{prefix}-{seq:04}', { prefix: 'X', seq: 12345 });
    expect(r).toBe('X-12345');
  });
});

// ═══════════════════════════════════════════════════════════════
// 纯函数：isSequenceType + 配置常量
// ═══════════════════════════════════════════════════════════════
describe('isSequenceType 类型校验', () => {
  it('合法 SequenceType → true', () => {
    expect(isSequenceType('order')).toBe(true);
    expect(isSequenceType('pi')).toBe(true);
    expect(isSequenceType('quotation')).toBe(true);
    expect(isSequenceType('customer')).toBe(true);
    expect(isSequenceType('marketing')).toBe(true);
  });

  it('非法值 → false', () => {
    expect(isSequenceType('unknown')).toBe(false);
    expect(isSequenceType('')).toBe(false);
    expect(isSequenceType(null)).toBe(false);
    expect(isSequenceType(123)).toBe(false);
  });
});

describe('SEQUENCE_TYPE_CONFIGS 配置', () => {
  it('包含 15 类 seqType', () => {
    // 计数守卫：新增一类序列时**必须**同步改这里（2026-09-19 新增 paymentRequest：
    // 付款申请取号由 `count+1` 改为走本发号真源，见 paymentRequestNumberAtomicity.test.ts；
    // 2026-09-28 B274 再新增 exceptionRequest / orderChangeRequest 两类：EXC-/OCR- 两处同族收口）
    expect(ALL_SEQUENCE_TYPES).toHaveLength(15);
    expect(ALL_SEQUENCE_TYPES).toContain('order');
    expect(ALL_SEQUENCE_TYPES).toContain('marketing');
    expect(ALL_SEQUENCE_TYPES).toContain('paymentRequest');
    expect(ALL_SEQUENCE_TYPES).toContain('exceptionRequest');
    expect(ALL_SEQUENCE_TYPES).toContain('orderChangeRequest');
  });

  it('paymentRequest 按**日**重置 prefix=PAYR 3 位（格式 PAYR-YYYYMMDD-NNN，与 schema 注释同源）', () => {
    expect(SEQUENCE_TYPE_CONFIGS.paymentRequest.period).toBe('day');
    expect(SEQUENCE_TYPE_CONFIGS.paymentRequest.prefix).toBe('PAYR');
    expect(SEQUENCE_TYPE_CONFIGS.paymentRequest.defaultPadding).toBe(3);
    // 格式模板必须产出 `PAYR-20260919-001`（日期段连写、3 位补零）—— 用户看到的号不能变
    expect(SEQUENCE_TYPE_CONFIGS.paymentRequest.defaultFormatTemplate).toBe('{prefix}-{year}{month}{day}-{seq:03}');
  });

  it('order 按月重置 prefix=SO', () => {
    expect(SEQUENCE_TYPE_CONFIGS.order.period).toBe('month');
    expect(SEQUENCE_TYPE_CONFIGS.order.prefix).toBe('SO');
    expect(SEQUENCE_TYPE_CONFIGS.order.defaultPadding).toBe(3);
  });

  it('quotation 按年重置 prefix=QT 兼容旧 QT', () => {
    expect(SEQUENCE_TYPE_CONFIGS.quotation.period).toBe('year');
    expect(SEQUENCE_TYPE_CONFIGS.quotation.prefix).toBe('QT');
    expect(SEQUENCE_TYPE_CONFIGS.quotation.legacyBusinessPrefix).toBe('QT');
  });

  it('customer/supplier/material 永不重置 5 位', () => {
    for (const t of ['customer', 'supplier', 'material'] as SequenceType[]) {
      expect(SEQUENCE_TYPE_CONFIGS[t].period).toBe('none');
      expect(SEQUENCE_TYPE_CONFIGS[t].defaultPadding).toBe(5);
    }
  });

  it('voucher prefix=PAY（旧 PV 改为 PAY）', () => {
    expect(SEQUENCE_TYPE_CONFIGS.voucher.prefix).toBe('PAY');
    expect(SEQUENCE_TYPE_CONFIGS.voucher.legacyBusinessPrefix).toBe('PV');
  });
});

// ── mock DB helpers ──
function makeSeqDb(overrides: {
  seqRegisterUpsert?: any;
  seqRegisterUpdate?: any;
  seqRegisterFindUnique?: any;
  voidedUpsert?: any;
  voidedFindUnique?: any;
  voidedFindMany?: any;
} = {}) {
  return {
    sequenceRegister: {
      upsert: overrides.seqRegisterUpsert ?? vi.fn().mockResolvedValue({}),
      update: overrides.seqRegisterUpdate ?? vi.fn().mockResolvedValue({
        currentSeq: 1, formatTemplate: null, padding: 4, prefix: 'QT',
      }),
      findUnique: overrides.seqRegisterFindUnique ?? vi.fn().mockResolvedValue(null),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    voidedNumber: {
      upsert: overrides.voidedUpsert ?? vi.fn().mockResolvedValue({ id: 'VOID_x', number: 'QT-2026-0001', seqType: 'quotation' }),
      findUnique: overrides.voidedFindUnique ?? vi.fn().mockResolvedValue(null),
      findFirst: vi.fn(),
      findMany: overrides.voidedFindMany ?? vi.fn().mockResolvedValue([]),
    },
  } as any;
}

// ═══════════════════════════════════════════════════════════════
// nextNumber
// ═══════════════════════════════════════════════════════════════
describe('nextNumber 分配编号', () => {
  it('DB 模式：upsert 确保行存在 → 原子 increment → 渲染', async () => {
    const db = makeSeqDb({
      seqRegisterUpdate: vi.fn().mockResolvedValue({ currentSeq: 5, formatTemplate: null, padding: 4, prefix: 'QT' }),
    });
    const svc = createSequenceService({} as any);
    const num = await svc.nextNumber(db, 'quotation');
    expect(num).toBe('QT-2026-0005');
    expect(db.sequenceRegister.upsert).toHaveBeenCalled();
    expect(db.sequenceRegister.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ currentSeq: { increment: 1 } }),
    }));
  });

  it('DB 模式：使用 DB 行的 formatTemplate 覆盖默认', async () => {
    const db = makeSeqDb({
      seqRegisterUpdate: vi.fn().mockResolvedValue({ currentSeq: 3, formatTemplate: '{prefix}-CUSTOM-{seq:04}', padding: 4, prefix: 'INV' }),
    });
    const svc = createSequenceService({} as any);
    const num = await svc.nextNumber(db, 'invoice');
    expect(num).toBe('INV-CUSTOM-0003');
  });

  it('DB 模式：overrideFormatTemplate 优先于 DB 行', async () => {
    const db = makeSeqDb({
      seqRegisterUpdate: vi.fn().mockResolvedValue({ currentSeq: 1, formatTemplate: 'DB-TEMPLATE', padding: 4, prefix: 'SO' }),
    });
    const svc = createSequenceService({} as any);
    const num = await svc.nextNumber(db, 'order', { overrideFormatTemplate: '{prefix}-OVR-{year}{month}-{seq:03}' });
    expect(num).toMatch(/^SO-OVR-\d{6}-\d{3}$/);
  });

  it('DB 模式：overridePadding 覆盖默认补零位数', async () => {
    const db = makeSeqDb({
      seqRegisterUpdate: vi.fn().mockResolvedValue({ currentSeq: 9, formatTemplate: '{prefix}-{seq:05}', padding: 4, prefix: 'CUS' }),
    });
    const svc = createSequenceService({} as any);
    const num = await svc.nextNumber(db, 'customer', { overridePadding: 8 });
    // overridePadding 仅影响 {seq} 无显式位数的情况；这里模板是 :05 不受影响
    expect(num).toBe('CUS-00009');
  });

  it('DB 模式：order 按月重置（periodKey=YYYY-MM）', async () => {
    const db = makeSeqDb({
      seqRegisterUpdate: vi.fn().mockResolvedValue({ currentSeq: 12, formatTemplate: null, padding: 3, prefix: 'SO' }),
    });
    const svc = createSequenceService({} as any);
    const num = await svc.nextNumber(db, 'order', { date: new Date(2026, 7, 15) });
    expect(num).toBe('SO-202608-012');
  });

  it('fallback 模式（无 sequenceRegister）→ 时间戳+随机生成', async () => {
    const db = {} as any; // 无 sequenceRegister 模型
    const svc = createSequenceService({} as any);
    const num = await svc.nextNumber(db, 'quotation');
    expect(num).toMatch(/^QT-\d{4}-\d+$/);
  });

  it('未知 seqType → 抛错', async () => {
    const db = makeSeqDb();
    const svc = createSequenceService({} as any);
    await expect(svc.nextNumber(db, 'unknown' as any)).rejects.toThrow(/未知 seqType/);
  });

  it('voided 碰撞 → 重试一次（递归调用）', async () => {
    let updateCount = 0;
    const db = makeSeqDb({
      seqRegisterUpdate: vi.fn().mockImplementation(async () => ({ currentSeq: ++updateCount, formatTemplate: null, padding: 4, prefix: 'QT' })),
      voidedFindUnique: vi.fn().mockImplementation(async () => updateCount === 1 ? { id: 'VOID_x' } : null),
    });
    const svc = createSequenceService({} as any);
    const num = await svc.nextNumber(db, 'quotation');
    expect(num).toBe('QT-2026-0002'); // 第二次 increment currentSeq=2
    expect(db.sequenceRegister.update).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// peekNextNumber
// ═══════════════════════════════════════════════════════════════
describe('peekNextNumber 预览下一编号', () => {
  it('DB 有行 → currentSeq+1', async () => {
    const db = makeSeqDb({
      seqRegisterFindUnique: vi.fn().mockResolvedValue({ currentSeq: 5, formatTemplate: null, padding: 4, prefix: 'QT' }),
    });
    const svc = createSequenceService({} as any);
    const num = await svc.peekNextNumber(db, 'quotation');
    expect(num).toBe('QT-2026-0006');
  });

  it('DB 无行 → seq=1', async () => {
    const db = makeSeqDb({ seqRegisterFindUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSequenceService({} as any);
    const num = await svc.peekNextNumber(db, 'quotation');
    expect(num).toBe('QT-2026-0001');
  });

  it('fallback 模式 → seq=1', async () => {
    const db = {} as any;
    const svc = createSequenceService({} as any);
    const num = await svc.peekNextNumber(db, 'customer');
    expect(num).toMatch(/^CUS-\d+$/);
  });

  it('不消费序号（不调用 update）', async () => {
    const db = makeSeqDb({
      seqRegisterFindUnique: vi.fn().mockResolvedValue({ currentSeq: 5, formatTemplate: null, padding: 4, prefix: 'QT' }),
    });
    const svc = createSequenceService({} as any);
    await svc.peekNextNumber(db, 'quotation');
    expect(db.sequenceRegister.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// getSequenceStatus / listSequenceStatuses
// ═══════════════════════════════════════════════════════════════
describe('getSequenceStatus 当前序列状态', () => {
  it('返回完整状态含 nextSeqPreview', async () => {
    const db = makeSeqDb({
      seqRegisterFindUnique: vi.fn().mockResolvedValue({ currentSeq: 10, formatTemplate: null, padding: 4, prefix: 'INV', period: 'year', description: '业务发票' }),
    });
    const svc = createSequenceService({} as any);
    const status = await svc.getSequenceStatus(db, 'invoice');
    expect(status.seqType).toBe('invoice');
    expect(status.period).toBe('year');
    expect(status.prefix).toBe('INV');
    expect(status.currentSeq).toBe(10);
    expect(status.nextSeqPreview).toBe('INV-2026-0011');
    expect(status.description).toBe('业务发票');
  });

  it('DB 无行 → currentSeq=0 + 用默认配置', async () => {
    const db = makeSeqDb({ seqRegisterFindUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSequenceService({} as any);
    const status = await svc.getSequenceStatus(db, 'order');
    expect(status.currentSeq).toBe(0);
    expect(status.period).toBe('month');
    expect(status.prefix).toBe('SO');
  });

  it('periodKey 与 period 一致', async () => {
    const db = makeSeqDb({ seqRegisterFindUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSequenceService({} as any);
    const status = await svc.getSequenceStatus(db, 'order', { date: new Date(2026, 7, 15) });
    expect(status.periodKey).toBe('2026-08');
  });
});

describe('listSequenceStatuses 列出全部序列状态', () => {
  it('返回 15 类序列状态', async () => {
    const db = makeSeqDb({ seqRegisterFindUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSequenceService({} as any);
    const list = await svc.listSequenceStatuses(db);
    // 计数守卫：与 ALL_SEQUENCE_TYPES 同步（2026-09-19 新增 paymentRequest；2026-09-28 B274 新增 EXC/OCR 两类）
    expect(list).toHaveLength(15);
    const seqTypes = list.map((s: any) => s.seqType);
    expect(seqTypes).toContain('order');
    expect(seqTypes).toContain('quotation');
    expect(seqTypes).toContain('customer');
    expect(seqTypes).toContain('marketing');
    expect(seqTypes).toContain('paymentRequest');
  });

  it('每项包含 description 和 latestStatus', async () => {
    const db = makeSeqDb({ seqRegisterFindUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSequenceService({} as any);
    const list = await svc.listSequenceStatuses(db);
    expect(list[0].description).toBeDefined();
    expect(list[0].latestStatus).toBeDefined();
    expect(list[0].latestStatus.nextSeqPreview).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// markVoided / isVoided / listVoided
// ═══════════════════════════════════════════════════════════════
describe('markVoided 作废追踪', () => {
  it('成功作废 → upsert 写入', async () => {
    const db = makeSeqDb();
    const svc = createSequenceService({} as any);
    const r = await svc.markVoided(db, {
      seqType: 'quotation',
      number: 'QT-2026-0001',
      reason: '客户取消',
      voidedBy: 'user_1',
    });
    expect(r.seqType).toBe('quotation');
    expect(r.number).toBe('QT-2026-0001');
    expect(db.voidedNumber.upsert).toHaveBeenCalled();
    const call = db.voidedNumber.upsert.mock.calls[0][0];
    expect(call.create.reason).toBe('客户取消');
    expect(call.create.voidedBy).toBe('user_1');
  });

  it('未知 seqType → 抛错', async () => {
    const db = makeSeqDb();
    const svc = createSequenceService({} as any);
    await expect(svc.markVoided(db, { seqType: 'unknown' as any, number: 'X-1' }))
      .rejects.toThrow(/未知 seqType/);
  });

  it('空 number → 抛错', async () => {
    const db = makeSeqDb();
    const svc = createSequenceService({} as any);
    await expect(svc.markVoided(db, { seqType: 'order', number: ' ' }))
      .rejects.toThrow(/不能为空/);
  });

  it('fallback 模式（无 voidedNumber）→ 仅返回结果', async () => {
    const db = { sequenceRegister: {} } as any;
    const svc = createSequenceService({} as any);
    const r = await svc.markVoided(db, { seqType: 'order', number: 'SO-1' });
    expect(r.number).toBe('SO-1');
  });

  it('重复作废 → upsert 更新', async () => {
    const db = makeSeqDb();
    const svc = createSequenceService({} as any);
    await svc.markVoided(db, { seqType: 'order', number: 'SO-1', reason: 'A' });
    await svc.markVoided(db, { seqType: 'order', number: 'SO-1', reason: 'B' });
    expect(db.voidedNumber.upsert).toHaveBeenCalledTimes(2);
    const secondCall = db.voidedNumber.upsert.mock.calls[1][0];
    expect(secondCall.update.reason).toBe('B');
  });
});

describe('isVoided 检查作废', () => {
  it('已作废 → true', async () => {
    const db = makeSeqDb({ voidedFindUnique: vi.fn().mockResolvedValue({ id: 'VOID_x' }) });
    const svc = createSequenceService({} as any);
    const r = await svc.isVoided(db, 'quotation', 'QT-2026-0001');
    expect(r).toBe(true);
  });

  it('未作废 → false', async () => {
    const db = makeSeqDb({ voidedFindUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSequenceService({} as any);
    const r = await svc.isVoided(db, 'quotation', 'QT-2026-0001');
    expect(r).toBe(false);
  });

  it('fallback 模式 → false', async () => {
    const db = { sequenceRegister: {} } as any;
    const svc = createSequenceService({} as any);
    const r = await svc.isVoided(db, 'quotation', 'QT-1');
    expect(r).toBe(false);
  });
});

describe('listVoided 列出作废编号', () => {
  it('成功返回 { total, items }', async () => {
    const items = [
      { id: 'VOID_1', seqType: 'order', number: 'SO-1', periodKey: '2026-08', reason: 'X', voidedAt: new Date(), voidedBy: 'u1', sourceDocType: null, sourceDocId: null },
      { id: 'VOID_2', seqType: 'quotation', number: 'QT-1', periodKey: '2026', reason: null, voidedAt: new Date(), voidedBy: null, sourceDocType: null, sourceDocId: null },
    ];
    const db = makeSeqDb({ voidedFindMany: vi.fn().mockResolvedValue(items) });
    const svc = createSequenceService({} as any);
    const r = await svc.listVoided(db);
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(2);
  });

  it('按 seqType 过滤', async () => {
    const db = makeSeqDb({ voidedFindMany: vi.fn().mockResolvedValue([]) });
    const svc = createSequenceService({} as any);
    await svc.listVoided(db, { seqType: 'order' });
    const where = db.voidedNumber.findMany.mock.calls[0][0].where;
    expect(where.seqType).toBe('order');
  });

  it('按日期范围过滤', async () => {
    const db = makeSeqDb({ voidedFindMany: vi.fn().mockResolvedValue([]) });
    const svc = createSequenceService({} as any);
    await svc.listVoided(db, { fromDate: '2026-08-01', toDate: '2026-08-31' });
    const where = db.voidedNumber.findMany.mock.calls[0][0].where;
    expect(where.voidedAt.gte).toBeDefined();
    expect(where.voidedAt.lte).toBeDefined();
  });

  it('分页 take/skip 透传', async () => {
    const db = makeSeqDb({ voidedFindMany: vi.fn().mockResolvedValue([]) });
    const svc = createSequenceService({} as any);
    await svc.listVoided(db, { limit: 20, offset: 40 });
    const secondCall = db.voidedNumber.findMany.mock.calls[1][0];
    expect(secondCall.take).toBe(20);
    expect(secondCall.skip).toBe(40);
  });

  it('fallback 模式 → 空', async () => {
    const db = { sequenceRegister: {} } as any;
    const svc = createSequenceService({} as any);
    const r = await svc.listVoided(db);
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });
});
