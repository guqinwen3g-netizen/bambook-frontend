/**
 * REQ2-20 旺季舱位提醒回归测试（设计文档 §5，DR-061）
 *
 * 覆盖：
 *   ① 规则解析：默认（旺季 8/9/10 月 21 天/平时 14 天）+ 配置覆写 + 非法值 fail-open
 *   ② 扫描：已安排出运跳过；旺季/平时天数区分；overdue/urgent/warning 分级；未到窗口不预警
 *   ③ 排序按剩余天数升序；无候选订单空清单
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
const configGet = vi.fn();
vi.mock('../../config/systemConfigService', () => ({
  getSystemConfigService: () => ({ get: configGet }),
}));

import { createBookingLeadTimeService, DEFAULT_BOOKING_RULE } from '../bookingLeadTimeService';

function makePrisma(seed: { orders?: any[]; allocations?: any[] } = {}) {
  const state = { orders: [...(seed.orders ?? [])], allocations: [...(seed.allocations ?? [])] };
  return {
    prisma: {
      order: {
        findMany: async () => state.orders,
      },
      shipmentOrderAllocation: {
        findMany: async () => state.allocations,
      },
    } as any,
    state,
  };
}

beforeEach(() => { vi.clearAllMocks(); configGet.mockResolvedValue(null); });

describe('规则解析（DR-061-① fail-open）', () => {
  it('默认规则：旺季 8/9/10 月 21 天 / 平时 14 天', async () => {
    const { prisma } = makePrisma();
    const rule = await createBookingLeadTimeService(prisma).loadRule();
    expect(rule).toEqual(DEFAULT_BOOKING_RULE);
    expect(rule.peakMonths).toEqual([8, 9, 10]);
  });

  it('配置覆写生效；非法值回退默认', async () => {
    const { prisma } = makePrisma();
    configGet.mockResolvedValue({ value: { peakMonths: [11, 12, 1], peakDays: 30, normalDays: 10 } });
    const rule = await createBookingLeadTimeService(prisma).loadRule();
    expect(rule).toEqual({ peakMonths: [11, 12, 1], peakDays: 30, normalDays: 10 });

    configGet.mockResolvedValue({ value: { peakDays: -5, normalDays: 'x' } });
    const rule2 = await createBookingLeadTimeService(prisma).loadRule();
    expect(rule2.peakDays).toBe(21);
    expect(rule2.normalDays).toBe(14);

    configGet.mockRejectedValue(new Error('db down'));
    const rule3 = await createBookingLeadTimeService(prisma).loadRule();
    expect(rule3).toEqual(DEFAULT_BOOKING_RULE);
  });
});

describe('扫描（DR-061-②③）', () => {
  const NOW = new Date('2026-09-15T00:00:00Z'); // 9 月（旺季）

  it('旺季订单：21 天窗口已到 → 预警 + 分级 + 建议文案', async () => {
    const { prisma } = makePrisma({
      orders: [
        { id: 'O-1', poNumber: 'PO-1', customer: '客户A', dueDate: '2026-10-05' }, // 旺月交期，剩 20 天，需 9-14 前订舱 → 已到
        { id: 'O-2', poNumber: 'PO-2', customer: '客户B', dueDate: '2026-10-25' }, // 需 10-04 前订舱 → 未到窗口，不预警
        { id: 'O-3', poNumber: 'PO-3', customer: '客户C', dueDate: '2026-09-16' }, // 剩 1 天 → urgent
        { id: 'O-4', poNumber: 'PO-4', customer: '客户D', dueDate: '2026-09-10' }, // 过交期 → overdue
      ],
      allocations: [],
    });
    const { rule, items } = await createBookingLeadTimeService(prisma).listBookingReminders(NOW);
    expect(rule.peakDays).toBe(21);
    expect(items.map(i => i.orderId)).toEqual(['O-4', 'O-3', 'O-1']); // 剩余天数升序
    const o1 = items.find(i => i.orderId === 'O-1')!;
    expect(o1.isPeak).toBe(true);
    expect(o1.leadDays).toBe(21);
    expect(o1.requiredByDate).toBe('2026-09-14');
    expect(o1.remainingDays).toBe(20);
    expect(o1.level).toBe('warning');
    expect(o1.suggestion).toContain('旺季');
    const o3 = items.find(i => i.orderId === 'O-3')!;
    expect(o3.level).toBe('urgent');
    const o4 = items.find(i => i.orderId === 'O-4')!;
    expect(o4.level).toBe('overdue');
    expect(o4.suggestion).toContain('已过交期');
  });

  it('平时订单走 14 天窗口；已安排出运的订单跳过', async () => {
    const { prisma } = makePrisma({
      orders: [
        { id: 'O-5', poNumber: 'PO-5', customer: '客户E', dueDate: '2026-11-30' }, // 平月：需 11-16 前订舱，now 9-15 未到 → 不预警
        { id: 'O-6', poNumber: 'PO-6', customer: '客户F', dueDate: '2026-09-20' }, // 已安排 → 跳过
        { id: 'O-7', poNumber: 'PO-7', customer: '客户G', dueDate: '2026-09-25' }, // 旺月：需 09-04，剩 10 天 → warning
      ],
      allocations: [{ orderId: 'O-6' }, { orderId: 'O-99' }],
    });
    const { items } = await createBookingLeadTimeService(prisma).listBookingReminders(NOW);
    expect(items.map(i => i.orderId)).toEqual(['O-7']);
    expect(items[0].isPeak).toBe(true);
  });

  it('无候选订单 → 空清单', async () => {
    const { prisma } = makePrisma({ orders: [] });
    const { items } = await createBookingLeadTimeService(prisma).listBookingReminders(NOW);
    expect(items).toEqual([]);
  });

  it('dueDate 格式非法的订单跳过（不炸）', async () => {
    const { prisma } = makePrisma({
      orders: [{ id: 'O-BAD', poNumber: null, customer: 'X', dueDate: 'not-a-date' }],
    });
    const { items } = await createBookingLeadTimeService(prisma).listBookingReminders(NOW);
    expect(items).toEqual([]);
  });

  it('机器为 UTC 时，上海凌晨按当天进入订舱窗口，并拒绝不存在的日期', async () => {
    vi.stubEnv('TZ', 'UTC');
    try {
      const { prisma } = makePrisma({ orders: [
        { id: 'O-window', poNumber: 'PO-window', customer: '客户', dueDate: '2026-10-06' },
        { id: 'O-invalid', poNumber: 'PO-invalid', customer: '客户', dueDate: '2026-02-30' },
      ] });
      const { items } = await createBookingLeadTimeService(prisma).listBookingReminders(new Date('2026-09-14T17:00:00Z'));
      expect(items).toEqual([expect.objectContaining({ orderId: 'O-window', requiredByDate: '2026-09-15', remainingDays: 21 })]);
    } finally { vi.unstubAllEnvs(); }
  });
});
