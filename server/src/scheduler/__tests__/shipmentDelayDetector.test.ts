/**
 * Phase B3 — 出运延误预警调度任务单元测试
 *
 * 覆盖：
 *   1. 离港延误：ETD 已过 + 无 ATD + Booked/Loading → 通知（1-3 天 warning / >3 天 critical）
 *   2. 到港延误：ETA 已过 + 无 ATA + Shipped → 通知
 *   3. 未逾期（ETD/ETA 在未来）不通知
 *   4. 分级去重：同 tier 当天已有通知 → 跳过
 *   5. shouldRun 小时闸门：同一小时只放行一次
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

import { createShipmentDelayDetectorTask } from '../tasks/shipmentDelayDetector';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ★★ 2026-09-18 修：这里原用 `toISOString().slice(0,10)`（**UTC** 日期 ✗）
 *   —— 而任务内用的是**本地**日期（`new Date(y,m,d)` 本地零点，见
 *      `tasks/quotationFollowUpWatchdog.ts` 与 `tasks/ppSampleConfirmationWatchdog.ts` 的
 *      `todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()` ✓）
 *
 *   ⇒ **两者基准不一致** ✗ ⇒ 在本地 **00:00–08:00（GMT+8）** 跑时，
 *     UTC 还是"前一天" ⇒ 算出的日期比预期**早一天** ⇒ `daysOverdue` 差 1 ✗
 *     （实测：01:25 跑必挂 3 例，报 `expected '离港延误 3 天' to contain '离港延误 2 天'` ✗）
 *   ⇒ 修法：**改用本地日期**，与任务同基准 ✓
 */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
/** n 天前的**本地**日期串（与任务内 today 口径一致：YYYY-MM-DD 字典序 ✓） */
function daysAgo(n: number): string {
  return localDateStr(new Date(Date.now() - n * DAY_MS));
}
function daysAhead(n: number): string {
  return localDateStr(new Date(Date.now() + n * DAY_MS));
}

function makeShip(overrides: Record<string, any> = {}) {
  return {
    id: 'SHIP_1',
    shipmentNumber: 'SH-2026-001',
    orderId: 'ORD_1',
    customerName: 'ACME',
    etd: null,
    eta: null,
    ...overrides,
  };
}

function makePrisma({ dep = [] as any[], arr = [] as any[], dedupHit = false } = {}) {
  return {
    shipment: {
      findMany: vi.fn(async ({ where }: any) => (where?.status === 'Shipped' ? arr : dep)),
    },
    notification: {
      findFirst: vi.fn().mockResolvedValue(dedupHit ? { id: 'N_1' } : null),
    },
  } as any;
}

describe('shipmentDelayDetector · 离港延误', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ETD 逾期 2 天未离港 → warning 通知', async () => {
    const task = createShipmentDelayDetectorTask();
    const prisma = makePrisma({ dep: [makeShip({ etd: daysAgo(2) })] });
    await task.run(prisma);

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.type).toBe('shipment_delay');
    expect(arg.level).toBe('warning');
    expect(arg.title).toContain('离港延误 2 天');
    expect(arg.metadata).toMatchObject({ delayKind: 'dep', tier: 'warning', daysOverdue: 2, entityId: 'SHIP_1' });
  });

  it('ETD 逾期 5 天未离港 → 升级为 critical', async () => {
    const task = createShipmentDelayDetectorTask();
    const prisma = makePrisma({ dep: [makeShip({ etd: daysAgo(5) })] });
    await task.run(prisma);

    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.level).toBe('critical');
    expect(arg.metadata.tier).toBe('critical');
    expect(arg.metadata.daysOverdue).toBe(5);
  });

  it('ETD 在未来 → 不通知', async () => {
    const task = createShipmentDelayDetectorTask();
    const prisma = makePrisma({ dep: [makeShip({ etd: daysAhead(3) })] });
    await task.run(prisma);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('shipmentDelayDetector · 到港延误', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ETA 逾期 1 天未到港（Shipped）→ warning 通知', async () => {
    const task = createShipmentDelayDetectorTask();
    const prisma = makePrisma({ arr: [makeShip({ eta: daysAgo(1) })] });
    await task.run(prisma);

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.title).toContain('到港延误 1 天');
    expect(arg.metadata.delayKind).toBe('arr');
    expect(arg.level).toBe('warning');
  });
});

describe('shipmentDelayDetector · 去重与闸门', () => {
  beforeEach(() => vi.clearAllMocks());

  it('同 tier 当天已有通知（dedupKey 命中）→ 跳过', async () => {
    const task = createShipmentDelayDetectorTask();
    const prisma = makePrisma({ dep: [makeShip({ etd: daysAgo(2) })], dedupHit: true });
    await task.run(prisma);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('dedupKey 含 kind/tier/date 三段语义', async () => {
    const task = createShipmentDelayDetectorTask();
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      shipment: { findMany: vi.fn(async ({ where }: any) => (where?.status === 'Shipped' ? [] : [makeShip({ etd: daysAgo(2) })])) },
      notification: { findFirst },
    } as any;
    await task.run(prisma);

    const dedupQuery = findFirst.mock.calls[0][0];
    const key = dedupQuery.where.metadata.equals as string;
    expect(key).toMatch(/^delay:dep:SHIP_1:warning:\d{4}-\d{2}-\d{2}$/);
  });

  it('shouldRun：同一小时只放行一次，跨小时再次放行', () => {
    const task = createShipmentDelayDetectorTask();
    const h10 = new Date(2026, 7, 10, 10, 30);
    const h10later = new Date(2026, 7, 10, 10, 55);
    const h11 = new Date(2026, 7, 10, 11, 5);
    expect(task.shouldRun(h10)).toBe(true);
    expect(task.shouldRun(h10later)).toBe(false);
    expect(task.shouldRun(h11)).toBe(true);
  });
});
