/**
 * systemConfigService 单测
 * 覆盖：get/getString/getNumber/getBoolean 类型读 + set 写入（加密/版本/History）
 *      + batchGet/batchSet + listByGroup（敏感掩码）+ invalidate + hasEncryptionKey
 *      + AES-256-GCM 加解密 + 解密失败容错 + 生产环境密钥缺失 fail closed
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createSystemConfigService,
  __resetEncryptionKeyCache_for_tests,
} from '../systemConfigService';

// ── helpers ──
function makeRow(overrides: any = {}) {
  return {
    id: 'global::company_name',
    scope: 'global',
    key: 'company_name',
    group: 'company',
    label: '公司名称',
    valueType: 'string',
    value: 'Bambook Co.',
    encrypted: false,
    version: 1,
    description: null,
    meta: null,
    updatedBy: null,
    auditReason: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: BigInt(0),
    ...overrides,
  };
}

function makePrisma(overrides: {
  findUnique?: any;
  findMany?: any;
  upsert?: any;
  historyCreate?: any;
} = {}) {
  const historyCreate = overrides.historyCreate ?? vi.fn().mockResolvedValue({ id: 'SCH_x' });
  return {
    systemConfig: {
      findUnique: overrides.findUnique ?? vi.fn().mockResolvedValue(makeRow()),
      findMany: overrides.findMany ?? vi.fn().mockResolvedValue([makeRow()]),
      upsert: overrides.upsert ?? vi.fn().mockImplementation(async ({ create, update }: any) => ({ ...makeRow(), ...create, ...update })),
    },
    systemConfigHistory: {
      create: historyCreate,
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetEncryptionKeyCache_for_tests();
  delete process.env.SYSTEM_CONFIG_ENCRYPTION_KEY;
  delete process.env.BAMBOOK_COOKIE_SECRET;
  delete process.env.COOKIE_SECRET;
  delete process.env.NODE_ENV;
});
afterEach(() => {
  __resetEncryptionKeyCache_for_tests();
  delete process.env.SYSTEM_CONFIG_ENCRYPTION_KEY;
  delete process.env.BAMBOOK_COOKIE_SECRET;
  delete process.env.COOKIE_SECRET;
  delete process.env.NODE_ENV;
});

// ═══════════════════════════════════════════════════════════════
// get / getString / getNumber / getBoolean
// ═══════════════════════════════════════════════════════════════
describe('get 取值', () => {
  it('存在 → 返回 {value, row}', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    const r = await svc.get('company_name');
    expect(r).not.toBeNull();
    if (r) {
      expect(r.value).toBe('Bambook Co.');
      expect(r.row.key).toBe('company_name');
    }
  });

  it('不存在 → 返回 null', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    const r = await svc.get('no_such');
    expect(r).toBeNull();
  });

  it('缓存命中时不二次查 DB', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    await svc.get('company_name');
    await svc.get('company_name');
    expect(prisma.systemConfig.findUnique).toHaveBeenCalledTimes(1);
  });

  it('skipCache=true 强制走 DB', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    await svc.get('company_name');
    await svc.get('company_name', { skipCache: true });
    expect(prisma.systemConfig.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('getString', () => {
  it('存在 → 返回字符串值', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    const v = await svc.getString('company_name');
    expect(v).toBe('Bambook Co.');
  });

  it('不存在 → 返回 fallback', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getString('no_such', '默认值');
    expect(v).toBe('默认值');
  });

  it('值为空字符串 → 返回 fallback', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(makeRow({ value: '' })) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getString('company_name', 'FB');
    expect(v).toBe('FB');
  });
});

describe('getNumber', () => {
  it('存在数值 → 返回 number', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(makeRow({ value: 42, valueType: 'number' })) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getNumber('vat_rate', 0);
    expect(v).toBe(42);
  });

  it('不存在 → 返回 fallback', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getNumber('no_such', 13);
    expect(v).toBe(13);
  });

  it('值非有限数 → 返回 fallback', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(makeRow({ value: 'abc', valueType: 'string' })) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getNumber('x', 0);
    expect(v).toBe(0);
  });
});

describe('getBoolean', () => {
  it('布尔 true → true', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(makeRow({ value: true, valueType: 'boolean' })) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getBoolean('flag', false);
    expect(v).toBe(true);
  });

  it('字符串 "true" → true', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(makeRow({ value: 'true', valueType: 'string' })) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getBoolean('flag', false);
    expect(v).toBe(true);
  });

  it('字符串 "1" → true', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(makeRow({ value: '1', valueType: 'string' })) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getBoolean('flag', false);
    expect(v).toBe(true);
  });

  it('不存在 → 返回 fallback', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    const v = await svc.getBoolean('no_such', false);
    expect(v).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// set
// ═══════════════════════════════════════════════════════════════
describe('set 写入', () => {
  it('新建成功 → versionChanged=false', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    const r = await svc.set('new_key', 'hello');
    expect(r.versionChanged).toBe(false);
    const createCall = prisma.systemConfig.upsert.mock.calls[0][0];
    expect(createCall.create.version).toBe(1);
    expect(createCall.create.value).toBe('hello');
  });

  it('更新已存在 → versionChanged=true 且 version+1', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(makeRow({ version: 3 })) });
    const svc = createSystemConfigService(prisma);
    const r = await svc.set('company_name', 'New Name');
    expect(r.versionChanged).toBe(true);
    const updateCall = prisma.systemConfig.upsert.mock.calls[0][0];
    expect(updateCall.update.version).toBe(4);
  });

  it('更新时写 History', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(makeRow({ version: 2, value: 'old' })) });
    const svc = createSystemConfigService(prisma);
    await svc.set('company_name', 'new', { actorId: 'user_1', reason: '改名' });
    expect(prisma.systemConfigHistory.create).toHaveBeenCalled();
    const histCall = prisma.systemConfigHistory.create.mock.calls[0][0];
    expect(histCall.data.versionFrom).toBe(2);
    expect(histCall.data.versionTo).toBe(3);
    expect(histCall.data.actorId).toBe('user_1');
    expect(histCall.data.reason).toBe('改名');
  });

  it('新建时不写 History', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    await svc.set('new_key', 'hello');
    expect(prisma.systemConfigHistory.create).not.toHaveBeenCalled();
  });

  it('History 写入失败不抛错（容错）', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow()),
      historyCreate: vi.fn().mockRejectedValue(new Error('DB down')),
    });
    const svc = createSystemConfigService(prisma);
    const r = await svc.set('company_name', 'new');
    expect(r.row).toBeDefined();
  });

  it('set 后缓存被清除', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    await svc.get('company_name'); // 填充缓存
    expect(svc.__cacheSize()).toBe(1);
    await svc.set('company_name', 'new');
    expect(svc.__cacheSize()).toBe(0);
  });

  it('自动推断 valueType: number → number', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    await svc.set('vat', 13);
    const createCall = prisma.systemConfig.upsert.mock.calls[0][0];
    expect(createCall.create.valueType).toBe('number');
  });

  it('自动推断 valueType: boolean → boolean', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    await svc.set('flag', true);
    const createCall = prisma.systemConfig.upsert.mock.calls[0][0];
    expect(createCall.create.valueType).toBe('boolean');
  });

  it('json 类型值被 JSON.stringify', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    await svc.set('obj', { a: 1 }, { valueType: 'json' });
    const createCall = prisma.systemConfig.upsert.mock.calls[0][0];
    expect(createCall.create.value).toBe('{"a":1}');
  });
});

// ═══════════════════════════════════════════════════════════════
// 加密
// ═══════════════════════════════════════════════════════════════
describe('加密', () => {
  it('encrypted=true 时存入的是密文（非明文）', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    await svc.set('api_key', 'sk-secret-123', { encrypted: true });
    const createCall = prisma.systemConfig.upsert.mock.calls[0][0];
    expect(createCall.create.encrypted).toBe(true);
    expect(createCall.create.value).not.toBe('sk-secret-123');
    expect(createCall.create.value).toMatch(/^[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/);
  });

  it('已加密行读取时自动解密回明文', async () => {
    // 先用 set 加密，再用 get 读
    const storedRows: any[] = [];
    const prisma = {
      systemConfig: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => storedRows.find((r) => r.id === where.id) || null),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockImplementation(async ({ create }: any) => {
          storedRows.push({ ...create });
          return { ...create };
        }),
      },
      systemConfigHistory: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    const svc = createSystemConfigService(prisma);
    await svc.set('api_key', 'sk-secret-123', { encrypted: true });
    const r = await svc.get('api_key');
    expect(r).not.toBeNull();
    if (r) {
      expect(r.value).toBe('sk-secret-123');
      expect(r.row.encrypted).toBe(true);
    }
  });

  it('加密项的 History valueFrom/valueTo 为 ***MASKED***', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({ value: 'old-encrypted-blob', encrypted: true, version: 1 })),
    });
    const svc = createSystemConfigService(prisma);
    await svc.set('api_key', 'new-secret', { encrypted: true });
    const histCall = prisma.systemConfigHistory.create.mock.calls[0][0];
    expect(histCall.data.valueFrom).toBe('***MASKED***');
    expect(histCall.data.valueTo).toBe('***MASKED***');
    expect(histCall.data.sensitiveMasked).toBe(true);
  });

  it('解密失败时返回 null（容错）', async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(makeRow({
        value: 'invalid-blob-not-3-parts',
        encrypted: true,
        valueType: 'string',
      })),
    });
    const svc = createSystemConfigService(prisma);
    const r = await svc.get('api_key');
    expect(r).not.toBeNull();
    if (r) expect(r.value).toBeNull();
  });

  it('生产环境 + 无密钥 + encrypted=true → 抛错', async () => {
    process.env.NODE_ENV = 'production';
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    await expect(svc.set('api_key', 'secret', { encrypted: true }))
      .rejects.toThrow(/SYSTEM_CONFIG_ENCRYPTION_KEY/);
  });

  it('开发环境无密钥 → 用 fallback 衍生密钥', async () => {
    const prisma = makePrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const svc = createSystemConfigService(prisma);
    const r = await svc.set('api_key', 'secret', { encrypted: true });
    expect(r.row.encrypted).toBe(true);
  });

  it('hasEncryptionKey() 反映密钥可用性', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    expect(svc.hasEncryptionKey()).toBe(true); // 开发 fallback
    process.env.NODE_ENV = 'production';
    __resetEncryptionKeyCache_for_tests();
    expect(svc.hasEncryptionKey()).toBe(false);
    process.env.SYSTEM_CONFIG_ENCRYPTION_KEY = '0'.repeat(64);
    __resetEncryptionKeyCache_for_tests();
    expect(svc.hasEncryptionKey()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// batchGet / batchSet
// ═══════════════════════════════════════════════════════════════
describe('batchGet 批量取值', () => {
  it('成功批量返回 Map', async () => {
    const prisma = makePrisma({
      findMany: vi.fn().mockResolvedValue([
        makeRow({ key: 'a', value: 'A' }),
        makeRow({ key: 'b', value: 'B' }),
      ]),
    });
    const svc = createSystemConfigService(prisma);
    const map = await svc.batchGet(['a', 'b']);
    expect(map.size).toBe(2);
    expect(map.get('a')?.value).toBe('A');
    expect(map.get('b')?.value).toBe('B');
  });

  it('部分 key 缺失 → 仅返回存在的', async () => {
    const prisma = makePrisma({
      findMany: vi.fn().mockResolvedValue([makeRow({ key: 'a', value: 'A' })]),
    });
    const svc = createSystemConfigService(prisma);
    const map = await svc.batchGet(['a', 'b', 'c']);
    expect(map.size).toBe(1);
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false);
  });

  it('缓存命中的 key 不走 DB', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    await svc.get('a'); // 填充缓存
    const map = await svc.batchGet(['a', 'b']);
    expect(map.size).toBe(2);
    // findMany 只查 b
    expect(prisma.systemConfig.findMany.mock.calls[0][0].where.key.in).toEqual(['b']);
  });
});

describe('batchSet 批量写入', () => {
  it('串行写入，统计 created/updated', async () => {
    let counter = 0;
    const prisma = makePrisma({
      findUnique: vi.fn().mockImplementation(async () => (counter++ % 2 === 0 ? null : makeRow({ version: 1 }))),
    });
    const svc = createSystemConfigService(prisma);
    const r = await svc.batchSet([
      { key: 'k1', value: 'v1' },
      { key: 'k2', value: 'v2' },
      { key: 'k3', value: 'v3' },
      { key: 'k4', value: 'v4' },
    ]);
    expect(r.created + r.updated).toBe(4);
    expect(prisma.systemConfig.upsert).toHaveBeenCalledTimes(4);
  });
});

// ═══════════════════════════════════════════════════════════════
// listByGroup
// ═══════════════════════════════════════════════════════════════
describe('listByGroup 按分组列出', () => {
  it('返回分组下所有配置', async () => {
    const prisma = makePrisma({
      findMany: vi.fn().mockResolvedValue([makeRow(), makeRow({ key: 'company_addr', value: 'Shanghai' })]),
    });
    const svc = createSystemConfigService(prisma);
    const list = await svc.listByGroup('company');
    expect(list).toHaveLength(2);
    const where = prisma.systemConfig.findMany.mock.calls[0][0].where;
    expect(where.group).toBe('company');
  });

  it('加密项默认返回 ***MASKED***', async () => {
    const prisma = makePrisma({
      findMany: vi.fn().mockResolvedValue([
        makeRow({ key: 'api_key', encrypted: true, value: 'fake-encrypted-blob' }),
      ]),
    });
    const svc = createSystemConfigService(prisma);
    const list = await svc.listByGroup('custom');
    expect(list[0].value).toBe('***MASKED***');
    expect(list[0].encrypted).toBe(true);
  });

  it('includeSensitiveMasked=true 解密返回明文', async () => {
    // 先 set 写入加密值，再 listByGroup 读出
    const stored: any[] = [];
    const prisma = {
      systemConfig: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockImplementation(async ({ where }: any) => stored.filter((r) => !where.group || r.group === where.group)),
        upsert: vi.fn().mockImplementation(async ({ create }: any) => { stored.push({ ...create }); return { ...create }; }),
      },
      systemConfigHistory: { create: vi.fn().mockResolvedValue({}) },
    } as any;
    const svc = createSystemConfigService(prisma);
    await svc.set('api_key', 'sk-secret', { encrypted: true, group: 'custom' });
    const list = await svc.listByGroup('custom', { includeSensitiveMasked: true });
    expect(list[0].value).toBe('sk-secret');
  });

  it('无 group 参数 → 列出全部 scope=global', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    await svc.listByGroup();
    const where = prisma.systemConfig.findMany.mock.calls[0][0].where;
    expect(where.scope).toBe('global');
    expect(where.group).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// invalidate
// ═══════════════════════════════════════════════════════════════
describe('invalidate 缓存失效', () => {
  it('invalidate(key) 清除单 key 缓存', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    await svc.get('a');
    await svc.get('b');
    expect(svc.__cacheSize()).toBe(2);
    svc.invalidate('a');
    expect(svc.__cacheSize()).toBe(1);
  });

  it('invalidate() 无参清除全部', async () => {
    const prisma = makePrisma();
    const svc = createSystemConfigService(prisma);
    await svc.get('a');
    await svc.get('b');
    svc.invalidate();
    expect(svc.__cacheSize()).toBe(0);
  });
});
