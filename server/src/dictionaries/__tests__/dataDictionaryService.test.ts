/**
 * dataDictionaryService 单测
 * 覆盖：getByCode/getEntries/getLabel/listDictionaries 查询 + upsert 写入（含系统字典保护、版本自增、History）
 *      + 缓存 TTL/invalidate + 21 类 DICT_CODES 常量 + toEntries 排序过滤
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createDataDictionaryService,
  DICT_CODES,
  ALL_SYSTEM_DICT_CODES,
} from '../dataDictionaryService';

// ── helpers ──
function makeRow(overrides: any = {}) {
  return {
    id: 'DICT_global_order_status',
    code: 'order_status',
    name: '订单状态',
    category: 'order',
    scope: 'global',
    isSystem: true,
    version: 1,
    entries: [
      { key: 'pending', label: '待确认', order: 1 },
      { key: 'confirmed', label: '已确认', order: 2 },
      { key: 'archived', label: '已归档', order: 3, disabled: true },
    ],
    labels: null,
    description: null,
    updatedAt: BigInt(0),
    ...overrides,
  };
}

function makePrisma(overrides: {
  findUnique?: any;
  findFirst?: any;
  findMany?: any;
  upsert?: any;
  historyCreate?: any;
} = {}) {
  const historyCreate = overrides.historyCreate ?? vi.fn().mockResolvedValue({ id: 'DDH_x' });
  return {
    dataDictionary: {
      findUnique: overrides.findUnique ?? vi.fn().mockResolvedValue(makeRow()),
      findFirst: overrides.findFirst ?? vi.fn().mockResolvedValue(null),
      findMany: overrides.findMany ?? vi.fn().mockResolvedValue([makeRow()]),
      upsert: overrides.upsert ?? vi.fn().mockImplementation(async ({ create, update }: any) => ({ ...makeRow(), ...create, ...update })),
    },
    dataDictionaryHistory: {
      create: historyCreate,
    },
  } as any;
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// 常量 & 类型导出
// ═══════════════════════════════════════════════════════════════
describe('常量与类型', () => {
  it('DICT_CODES 包含 21 类系统字典', () => {
    expect(Object.keys(DICT_CODES)).toHaveLength(21);
    expect(DICT_CODES.ORDER_STATUS).toBe('order_status');
    expect(DICT_CODES.VAT_INVOICE_TYPE).toBe('vat_invoice_type');
    expect(DICT_CODES.BOM_MATERIAL_TYPE).toBe('bom_material_type');
  });

  it('ALL_SYSTEM_DICT_CODES 与 DICT_CODES 值一致', () => {
    expect(ALL_SYSTEM_DICT_CODES).toHaveLength(21);
    expect(ALL_SYSTEM_DICT_CODES).toContain('order_status');
    expect(ALL_SYSTEM_DICT_CODES).toContain('relation_tier');
  });

  it('DICT_CODES 被冻结（不可变）', () => {
    expect(Object.isFrozen(DICT_CODES)).toBe(true);
    expect(() => { (DICT_CODES as any).NEW_KEY = 'x'; }).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// getByCode
// ═══════════════════════════════════════════════════════════════
describe('getByCode 获取字典快照', () => {
  it('存在 → 返回快照（entries 按 order 升序）', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    const r = await svc.getByCode('order_status');
    expect(r).not.toBeNull();
    if (r) {
      expect(r.code).toBe('order_status');
      expect(r.isSystem).toBe(true);
      expect(r.entries).toHaveLength(3);
      expect(r.entries[0].key).toBe('pending');
      expect(r.entries[1].key).toBe('confirmed');
      expect(r.entries[2].key).toBe('archived');
    }
  });

  it('不存在 → 返回 null', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createDataDictionaryService(prisma);
    const r = await svc.getByCode('no_such_code');
    expect(r).toBeNull();
  });

  it('缓存命中时不二次查询 DB', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await svc.getByCode('order_status');
    await svc.getByCode('order_status');
    expect(prisma.dataDictionary.findUnique).toHaveBeenCalledTimes(1);
  });

  it('skipCache=true 强制走 DB', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await svc.getByCode('order_status');
    await svc.getByCode('order_status', undefined, { skipCache: true });
    expect(prisma.dataDictionary.findUnique).toHaveBeenCalledTimes(2);
  });

  it('非 global scope 走 findMany 兜底', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([makeRow({ scope: 'tenant_1' })]),
    });
    const svc = createDataDictionaryService(prisma);
    const r = await svc.getByCode('order_status', undefined, { scope: 'tenant_1' });
    expect(r).not.toBeNull();
    expect(prisma.dataDictionary.findMany).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// getEntries
// ═══════════════════════════════════════════════════════════════
describe('getEntries 获取条目', () => {
  it('默认剔除 disabled=true 条目', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    const entries = await svc.getEntries('order_status');
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.key === 'archived')).toBeUndefined();
  });

  it('enabledOnly=false 返回全部（含 disabled）', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    const entries = await svc.getEntries('order_status', { enabledOnly: false });
    expect(entries).toHaveLength(3);
    expect(entries.find((e) => e.key === 'archived')).toBeDefined();
    expect(entries.find((e) => e.key === 'archived')?.disabled).toBe(true);
  });

  it('字典不存在 → 返回空数组', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createDataDictionaryService(prisma);
    const entries = await svc.getEntries('no_such');
    expect(entries).toEqual([]);
  });

  it('条目自动按 order 排序', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({
        entries: [
          { key: 'c', label: 'C', order: 3 },
          { key: 'a', label: 'A', order: 1 },
          { key: 'b', label: 'B', order: 2 },
        ],
      })),
    });
    const svc = createDataDictionaryService(prisma);
    const entries = await svc.getEntries('x');
    expect(entries.map((e) => e.key)).toEqual(['a', 'b', 'c']);
  });

  it('缺失 key 或 label 的条目被过滤（label 缺失时回退到 key）', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({
        entries: [
          { key: '', label: 'Empty', order: 1 },          // key='' → 过滤
          { key: 'no_label', order: 2 },                   // label 回退到 key='no_label' → 保留
          { key: 'valid', label: 'Valid', order: 3 },      // 都存在 → 保留
        ],
      })),
    });
    const svc = createDataDictionaryService(prisma);
    const entries = await svc.getEntries('x');
    expect(entries).toHaveLength(2);
    expect(entries[0].key).toBe('no_label');
    expect(entries[0].label).toBe('no_label'); // label 回退到 key
    expect(entries[1].key).toBe('valid');
  });
});

// ═══════════════════════════════════════════════════════════════
// getLabel
// ═══════════════════════════════════════════════════════════════
describe('getLabel 取单 key 标签', () => {
  it('存在 → 返回 label', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    const label = await svc.getLabel('order_status', 'pending');
    expect(label).toBe('待确认');
  });

  it('不存在 → 返回 fallback', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    const label = await svc.getLabel('order_status', 'no_such_key', 'Fallback');
    expect(label).toBe('Fallback');
  });

  it('不存在且无 fallback → 返回 key 本身', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    const label = await svc.getLabel('order_status', 'no_such_key');
    expect(label).toBe('no_such_key');
  });
});

// ═══════════════════════════════════════════════════════════════
// listDictionaries
// ═══════════════════════════════════════════════════════════════
describe('listDictionaries 列出全部字典', () => {
  it('成功返回快照数组', async () => {
    const prisma = makePrisma({
      findMany: vi.fn().mockResolvedValue([makeRow(), makeRow({ code: 'order_type', id: 'DICT_global_order_type' })]),
    });
    const svc = createDataDictionaryService(prisma);
    const list = await svc.listDictionaries();
    expect(list).toHaveLength(2);
    expect(list[0].code).toBe('order_status');
  });

  it('按 category 过滤', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await svc.listDictionaries({ category: 'order' });
    const where = prisma.dataDictionary.findMany.mock.calls[0][0].where;
    expect(where.category).toBe('order');
  });

  it('按 scope 过滤', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await svc.listDictionaries({ scope: 'tenant_1' });
    const where = prisma.dataDictionary.findMany.mock.calls[0][0].where;
    expect(where.scope).toBe('tenant_1');
  });

  it('按 isSystem 过滤', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await svc.listDictionaries({ isSystem: true });
    const where = prisma.dataDictionary.findMany.mock.calls[0][0].where;
    expect(where.isSystem).toBe(true);
  });

  it('空结果 → 返回空数组', async () => {
    const prisma = makePrisma({ findMany: vi.fn().mockResolvedValue([]) });
    const svc = createDataDictionaryService(prisma);
    const list = await svc.listDictionaries();
    expect(list).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// upsert
// ═══════════════════════════════════════════════════════════════
describe('upsert 写入字典', () => {
  it('缺 code → 抛错', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await expect(svc.upsert({ code: '', name: 'X', category: 'order', entries: [] } as any))
      .rejects.toThrow(/code 必填/);
  });

  it('缺 name → 抛错', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await expect(svc.upsert({ code: 'x', name: '', category: 'order', entries: [] } as any))
      .rejects.toThrow(/name 必填/);
  });

  it('entries 非数组 → 抛错', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await expect(svc.upsert({ code: 'x', name: 'X', category: 'order', entries: 'not array' } as any))
      .rejects.toThrow(/entries 必须是数组/);
  });

  it('新建成功 → versionChanged=false', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    });
    const svc = createDataDictionaryService(prisma);
    const r = await svc.upsert({
      code: 'new_dict', name: '新字典', category: 'custom',
      entries: [{ key: 'a', label: 'A', order: 1 }],
    });
    expect(r.dict.code).toBe('new_dict');
    expect(r.versionChanged).toBe(false);
    expect(prisma.dataDictionary.upsert).toHaveBeenCalled();
    const createCall = prisma.dataDictionary.upsert.mock.calls[0][0];
    expect(createCall.create.version).toBe(1);
  });

  it('更新已存在 → versionChanged=true 且 version+1', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({ version: 3, isSystem: false, entries: [{ key: 'pending', label: '待确认', order: 1 }] })),
    });
    const svc = createDataDictionaryService(prisma);
    const r = await svc.upsert({
      code: 'order_status', name: '订单状态 V2', category: 'order',
      entries: [{ key: 'pending', label: '待确认', order: 1 }],
    });
    expect(r.versionChanged).toBe(true);
    const updateCall = prisma.dataDictionary.upsert.mock.calls[0][0];
    expect(updateCall.update.version).toBe(4);
  });

  it('系统字典删除 key → 抛错（无 allowSystemKeyMutation）', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({
        entries: [
          { key: 'pending', label: '待确认', order: 1 },
          { key: 'confirmed', label: '已确认', order: 2 },
        ],
      })),
    });
    const svc = createDataDictionaryService(prisma);
    await expect(svc.upsert({
      code: 'order_status', name: '订单状态', category: 'order',
      entries: [{ key: 'pending', label: '待确认', order: 1 }], // 删了 confirmed
    })).rejects.toThrow(/系统字典/);
  });

  it('系统字典删除 key + allowSystemKeyMutation=true → 允许', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({
        entries: [
          { key: 'pending', label: '待确认', order: 1 },
          { key: 'confirmed', label: '已确认', order: 2 },
        ],
      })),
    });
    const svc = createDataDictionaryService(prisma);
    const r = await svc.upsert({
      code: 'order_status', name: '订单状态', category: 'order',
      entries: [{ key: 'pending', label: '待确认', order: 1 }],
      allowSystemKeyMutation: true,
    } as any);
    expect(r.dict).toBeDefined();
  });

  it('非系统字典删除 key → 允许', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({ isSystem: false, entries: [
        { key: 'a', label: 'A', order: 1 },
        { key: 'b', label: 'B', order: 2 },
      ] })),
    });
    const svc = createDataDictionaryService(prisma);
    const r = await svc.upsert({
      code: 'custom_dict', name: '自定义', category: 'custom',
      entries: [{ key: 'a', label: 'A', order: 1 }],
    });
    expect(r.dict).toBeDefined();
  });

  it('更新时写 History', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({ version: 2, isSystem: false, entries: [{ key: 'pending', label: '待确认', order: 1 }] })),
    });
    const svc = createDataDictionaryService(prisma);
    await svc.upsert({
      code: 'order_status', name: '订单状态', category: 'order',
      entries: [{ key: 'pending', label: '待确认', order: 1 }],
      actorId: 'user_1', reason: '修改标签',
    });
    expect(prisma.dataDictionaryHistory.create).toHaveBeenCalled();
    const histCall = prisma.dataDictionaryHistory.create.mock.calls[0][0];
    expect(histCall.data.versionFrom).toBe(2);
    expect(histCall.data.versionTo).toBe(3);
    expect(histCall.data.actorId).toBe('user_1');
    expect(histCall.data.reason).toBe('修改标签');
  });

  it('新建时不写 History', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    });
    const svc = createDataDictionaryService(prisma);
    await svc.upsert({
      code: 'new_dict', name: 'X', category: 'custom',
      entries: [{ key: 'a', label: 'A', order: 1 }],
    });
    expect(prisma.dataDictionaryHistory.create).not.toHaveBeenCalled();
  });

  it('History 写入失败不抛错（容错）', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({ isSystem: false, entries: [{ key: 'pending', label: '待确认', order: 1 }] })),
      historyCreate: vi.fn().mockRejectedValue(new Error('DB down')),
    });
    const svc = createDataDictionaryService(prisma);
    const r = await svc.upsert({
      code: 'order_status', name: 'X', category: 'order',
      entries: [{ key: 'pending', label: '待确认', order: 1 }],
    });
    expect(r.dict).toBeDefined();
  });

  it('upsert 后相关缓存被清空', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({ isSystem: false, entries: [{ key: 'pending', label: '待确认', order: 1 }] })),
    });
    const svc = createDataDictionaryService(prisma);
    await svc.getByCode('order_status'); // 填充缓存
    expect(svc.__cacheSize()).toBeGreaterThan(0);
    await svc.upsert({
      code: 'order_status', name: 'X', category: 'order',
      entries: [{ key: 'pending', label: '待确认', order: 1 }],
    });
    expect(svc.__cacheSize()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 缓存管理
// ═══════════════════════════════════════════════════════════════
describe('缓存管理', () => {
  it('invalidateCache(code) 清除单字典缓存', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await svc.getByCode('order_status');
    await svc.getByCode('order_type');
    expect(svc.__cacheSize()).toBe(2);
    svc.invalidateCache('order_status');
    expect(svc.__cacheSize()).toBe(1);
  });

  it('invalidateCache() 无参清除全部缓存', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await svc.getByCode('order_status');
    await svc.getByCode('order_type');
    svc.invalidateCache();
    expect(svc.__cacheSize()).toBe(0);
  });

  it('invalidateCache(code, scope) 按指定 scope 清', async () => {
    const prisma = makePrisma();
    const svc = createDataDictionaryService(prisma);
    await svc.getByCode('order_status');
    await svc.getByCode('order_status', undefined, { scope: 'tenant_1' });
    svc.invalidateCache('order_status', 'tenant_1');
    // global 还在
    expect(svc.__cacheSize()).toBeGreaterThanOrEqual(1);
  });
});
