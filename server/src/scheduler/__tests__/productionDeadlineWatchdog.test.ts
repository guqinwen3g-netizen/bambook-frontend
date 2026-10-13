/**
 * 生产计划超期 + 延期通知窗口主动推送单元测试（阶段 E / E1）
 *
 * 覆盖：
 *   1. 生产计划超期：1-3 天 warning；>3 天 critical；未超期不通知
 *   2. 延期通知窗口：delayNoticeDeadline 已到 → critical；未到不通知
 *   3. 扫描口径与 alerts/scan 一致（status ∉ Delivered/Alert，deletedAt null）
 *   4. 去重 key 含 tier 与日期；两场景可同时触发
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

import { detectAndNotify } from '../tasks/productionDeadlineWatchdog';

const TODAY = new Date(2026, 7, 10);

function makePrisma(orders: any[] = [], existingNotification: any = null) {
  return {
    order: {
      findMany: vi.fn().mockResolvedValue(orders),
    },
    notification: {
      findFirst: vi.fn().mockResolvedValue(existingNotification),
    },
  } as any;
}

function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: 'ORD_1',
    poNumber: 'PO-2026-001',
    customer: 'ACME',
    status: 'Confirmed',
    dueDate: '2026-08-25',
    productionPlanDeadline: null,
    delayNoticeDeadline: null,
    ...overrides,
  };
}

describe('productionDeadlineWatchdog · detectAndNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('生产计划超期 1 天 → warning；3 天 → warning；4 天 → critical', async () => {
    let prisma = makePrisma([makeOrder({ productionPlanDeadline: '2026-08-09' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('warning');
    expect(mockBroadcast.mock.calls[0][0].metadata.daysOverdue).toBe(1);

    vi.clearAllMocks();
    prisma = makePrisma([makeOrder({ productionPlanDeadline: '2026-08-07' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('warning');

    vi.clearAllMocks();
    prisma = makePrisma([makeOrder({ productionPlanDeadline: '2026-08-06' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('critical');
    expect(mockBroadcast.mock.calls[0][0].metadata.daysOverdue).toBe(4);
  });

  it('生产计划截止日 = 今天 → 不通知（当天仍未超期）', async () => {
    const prisma = makePrisma([makeOrder({ productionPlanDeadline: '2026-08-10' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('延期通知窗口已到 → critical', async () => {
    const prisma = makePrisma([makeOrder({ delayNoticeDeadline: '2026-08-10', dueDate: '2026-08-25' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.type).toBe('production_deadline');
    expect(arg.level).toBe('critical');
    expect(arg.title).toContain('延期通知窗口');
    expect(arg.metadata.alertKind).toBe('delay_notice_window');
    expect(arg.body).toContain('2026-08-25');
  });

  it('延期通知窗口未到 → 不通知', async () => {
    const prisma = makePrisma([makeOrder({ delayNoticeDeadline: '2026-08-15' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
  });

  it('两场景同时触发（计划超期 + 窗口开启）→ 两条通知分别去重', async () => {
    const prisma = makePrisma([makeOrder({ productionPlanDeadline: '2026-08-08', delayNoticeDeadline: '2026-08-05' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(2);
    const kinds = mockBroadcast.mock.calls.map(c => c[0].metadata.alertKind).sort();
    expect(kinds).toEqual(['delay_notice_window', 'production_plan_overdue']);
  });

  it('扫描口径与 alerts/scan 一致：status notIn Delivered/Alert + deletedAt null', async () => {
    const prisma = makePrisma([]);
    await detectAndNotify(prisma, TODAY);
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.status.notIn).toEqual(['Delivered', 'Alert']);
  });

  it('去重：同 tier 当天已有通知 → 跳过', async () => {
    const prisma = makePrisma(
      [makeOrder({ productionPlanDeadline: '2026-08-08' })],
      { id: 'NTF_existing' },
    );
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('dedupKey 含 tier 与日期（超期升 critical 会重发）', async () => {
    const prisma = makePrisma([makeOrder({ productionPlanDeadline: '2026-08-01' })]); // 9 天 → critical
    await detectAndNotify(prisma, TODAY);
    const meta = mockBroadcast.mock.calls[0][0].metadata;
    expect(meta.dedupKey).toBe('prod:plan:ORD_1:critical:2026-08-10');
    expect(meta.entityType).toBe('Order');
  });

  it('截止日期字段非法 → 跳过该场景', async () => {
    const prisma = makePrisma([makeOrder({ productionPlanDeadline: 'bad-date', delayNoticeDeadline: 'also-bad' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
  });
});
