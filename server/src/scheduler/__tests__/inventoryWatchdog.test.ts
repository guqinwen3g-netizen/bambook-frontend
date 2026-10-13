/**
 * 库存低储 / 超储预警单元测试（阶段 E / E1）
 *
 * 覆盖：
 *   1. 低储：available ≤ 0 → critical；0 < available < minStock → warning；≥ minStock 不通知
 *   2. 可用量口径：available = quantity - lockedQuantity
 *   3. minStock 未设置 → 低储不评估（按单生产零库存不打扰）
 *   4. 超储：quantity > maxStock → info；maxStock 未设置不评估
 *   5. 查询口径仅扫设了预警线的项；去重 key 含 tier 与日期
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockBroadcast = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('../../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../notifications/notificationService', () => ({
  createNotificationService: vi.fn(() => ({
    broadcastNotification: mockBroadcast,
  })),
}));

import { detectAndNotify } from '../tasks/inventoryWatchdog';

const TODAY = new Date(2026, 7, 10);

function makePrisma(items: any[] = [], existingNotification: any = null) {
  return {
    inventoryItem: {
      findMany: vi.fn().mockResolvedValue(items),
    },
    notification: {
      findFirst: vi.fn().mockResolvedValue(existingNotification),
    },
  } as any;
}

function makeItem(overrides: Record<string, any> = {}) {
  return {
    id: 'ITEM_1',
    description: '全棉府绸 40×40',
    materialCode: 'FAB-001',
    category: 'Fabric',
    warehouseId: 'WH_1',
    locationCode: 'A-01-03',
    unit: 'M',
    quantity: '100',
    lockedQuantity: '0',
    minStock: '50',
    maxStock: null,
    ...overrides,
  };
}

describe('inventoryWatchdog · detectAndNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('可用量耗尽（quantity=30 全锁定）→ critical 断货', async () => {
    const prisma = makePrisma([makeItem({ quantity: '30', lockedQuantity: '30' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.type).toBe('inventory_alert');
    expect(arg.level).toBe('critical');
    expect(arg.title).toContain('可用量耗尽');
    expect(arg.metadata.alertKind).toBe('low_stock');
    expect(arg.metadata.available).toBe(0);
  });

  it('0 < available < minStock → warning 低储', async () => {
    const prisma = makePrisma([makeItem({ quantity: '40', lockedQuantity: '10' })]); // available 30 < min 50
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.level).toBe('warning');
    expect(arg.metadata.available).toBe(30);
    expect(arg.metadata.minStock).toBe(50);
    expect(arg.body).toContain('A-01-03');
  });

  it('available ≥ minStock → 不通知', async () => {
    const prisma = makePrisma([makeItem({ quantity: '100', lockedQuantity: '0' })]); // available 100 ≥ 50
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('minStock 未设置 → 低储不评估（available=0 也不报）', async () => {
    const prisma = makePrisma([makeItem({ minStock: null, maxStock: '10', quantity: '0' })]); // 设 maxStock 仅为通过 OR 查询
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
  });

  it('超储：quantity > maxStock → info', async () => {
    const prisma = makePrisma([makeItem({ minStock: null, maxStock: '80', quantity: '120' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.level).toBe('info');
    expect(arg.title).toContain('超储');
    expect(arg.metadata.alertKind).toBe('over_stock');
    expect(arg.body).toContain('40'); // 超出 40
  });

  it('低储 + 超储可同发（min 未达且超 max 的异常数据分别去重）', async () => {
    const prisma = makePrisma([makeItem({ quantity: '120', lockedQuantity: '100', minStock: '50', maxStock: '100' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(2);
    const kinds = mockBroadcast.mock.calls.map(c => c[0].metadata.alertKind).sort();
    expect(kinds).toEqual(['low_stock', 'over_stock']);
  });

  it('查询口径：仅扫 minStock 或 maxStock 非空且未删除的项', async () => {
    const prisma = makePrisma([]);
    await detectAndNotify(prisma, TODAY);
    const where = prisma.inventoryItem.findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toEqual([{ minStock: { not: null } }, { maxStock: { not: null } }]);
  });

  it('去重：同 tier 当天已有通知 → 跳过', async () => {
    const prisma = makePrisma(
      [makeItem({ quantity: '40' })], // available 40 < 50 → warning
      { id: 'NTF_existing' },
    );
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('dedupKey 含 tier 与日期', async () => {
    const prisma = makePrisma([makeItem({ quantity: '40' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].metadata.dedupKey).toBe('inv:low:ITEM_1:warning:2026-08-10');
  });

  it('Decimal 对象（Prisma 运行时形态）正确转换', async () => {
    const decimal = (v: string) => ({ toString: () => v });
    const prisma = makePrisma([makeItem({ quantity: decimal('45'), lockedQuantity: decimal('5'), minStock: decimal('50') })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    expect(mockBroadcast.mock.calls[0][0].metadata.available).toBe(40);
  });
});
