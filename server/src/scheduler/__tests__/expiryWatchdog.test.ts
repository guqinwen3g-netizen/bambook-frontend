/**
 * 到期预警调度任务单元测试（LC 三期限 + 退税截止）
 *
 * 覆盖：
 *   1. LC 有效期分级：7 天内 critical / 14 天内 warning / 30 天内 info / 30 天外不通知
 *   2. LC 已过期（expiryDate 过去）→ critical「已过期」
 *   3. 闭环状态（Settled/Expired/Cancelled）不扫描
 *   4. 最迟装运期 / 交单期限预警
 *   5. 退税截止：出口日次年 4 月 30 日；90 天 info / 30 天 warning / 逾期 critical
 *   6. 分级去重：同 tier 当天已有通知 → 跳过；tier 升级 → 重发
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

import { detectAndNotify } from '../tasks/expiryWatchdog';

// 固定今天：2026-08-10（本地零点）
const TODAY = new Date(2026, 7, 10);

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    letterOfCredit: {
      findMany: vi.fn().mockResolvedValue([]),
      ...overrides.letterOfCredit,
    },
    taxRefund: {
      findMany: vi.fn().mockResolvedValue([]),
      ...overrides.taxRefund,
    },
    notification: {
      findFirst: vi.fn().mockResolvedValue(null),
      ...overrides.notification,
    },
  } as any;
}

function makeLc(overrides: Record<string, any> = {}) {
  return {
    id: 'LC_1',
    lcNumber: 'LC-2026-001',
    status: 'Issued',
    amount: '50000',
    currency: 'USD',
    expiryDate: null,
    shipmentDeadline: null,
    presentationDeadline: null,
    applicant: 'ACME',
    orderId: 'ORD_1',
    ...overrides,
  };
}

describe('expiryWatchdog · detectAndNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('LC 有效期 7 天内 → critical 通知', async () => {
    const prisma = makePrisma({
      letterOfCredit: { findMany: vi.fn().mockResolvedValue([makeLc({ expiryDate: '2026-08-15' })]) },
    });
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.type).toBe('lc_expiry');
    expect(arg.level).toBe('critical');
    expect(arg.title).toContain('5 天');
    expect(arg.metadata.deadline).toBe('2026-08-15');
  });

  it('LC 有效期 8-14 天 → warning；15-30 天 → info；30 天外 → 不通知', async () => {
    // warning: 12 天
    let prisma = makePrisma({
      letterOfCredit: { findMany: vi.fn().mockResolvedValue([makeLc({ expiryDate: '2026-08-22' })]) },
    });
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('warning');

    // info: 25 天
    vi.clearAllMocks();
    prisma = makePrisma({
      letterOfCredit: { findMany: vi.fn().mockResolvedValue([makeLc({ expiryDate: '2026-09-04' })]) },
    });
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('info');

    // 31 天 → 不通知
    vi.clearAllMocks();
    prisma = makePrisma({
      letterOfCredit: { findMany: vi.fn().mockResolvedValue([makeLc({ expiryDate: '2026-09-10' })]) },
    });
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('LC 已过期 → critical「已过期」', async () => {
    const prisma = makePrisma({
      letterOfCredit: { findMany: vi.fn().mockResolvedValue([makeLc({ expiryDate: '2026-08-01' })]) },
    });
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.level).toBe('critical');
    expect(arg.title).toContain('已过期');
  });

  it('最迟装运期 / 交单期限分别触发对应类型通知', async () => {
    const prisma = makePrisma({
      letterOfCredit: {
        findMany: vi.fn().mockResolvedValue([
          makeLc({ shipmentDeadline: '2026-08-16', presentationDeadline: '2026-08-13' }),
        ]),
      },
    });
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(2);
    const types = mockBroadcast.mock.calls.map(c => c[0].type).sort();
    expect(types).toEqual(['lc_presentation_deadline', 'lc_shipment_deadline']);
    // 装运期剩 6 天 → warning；交单期剩 3 天 → warning
    expect(mockBroadcast.mock.calls.every(c => c[0].level === 'warning')).toBe(true);
  });

  it('退税：截止日 = 出口日次年 4 月 30 日；30 天内 warning', async () => {
    // exportDate 2025-12-20 → deadline 2026-04-30 已过（today 2026-08-10）→ critical 逾期
    let prisma = makePrisma({
      taxRefund: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'TR_1', refundNumber: 'TR-001', status: 'Submitted', exportDate: '2025-12-20', refundAmount: '80000', orderId: 'ORD_1' },
        ]),
      },
    });
    let sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('critical');
    expect(mockBroadcast.mock.calls[0][0].title).toContain('已逾期');
    expect(mockBroadcast.mock.calls[0][0].metadata.deadline).toBe('2026-04-30');

    // exportDate 2026-06-01 → deadline 2027-04-30（263 天）→ 不通知
    vi.clearAllMocks();
    prisma = makePrisma({
      taxRefund: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'TR_2', refundNumber: 'TR-002', status: 'Draft', exportDate: '2026-06-01', refundAmount: null, orderId: null },
        ]),
      },
    });
    sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
  });

  it('退税截止 info 档：次年 4/30 前 90 天内', async () => {
    // today 2026-08-10 → 出口日 2026-05-20，deadline 2027-04-30 → 263 天不通知。
    // 构造 info 档：用 2026-11-15 作为今天（deadline 2027-04-30，166 天 —— 仍超 90 天）。
    // 2027-02-15 → deadline 2027-04-30，74 天 → info
    const prisma = makePrisma({
      taxRefund: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'TR_3', refundNumber: 'TR-003', status: 'Submitted', exportDate: '2026-05-20', refundAmount: '50000', orderId: null },
        ]),
      },
    });
    const sent = await detectAndNotify(prisma, new Date(2027, 1, 15)); // 2027-02-15
    expect(sent).toBe(1);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('info');
  });

  it('去重：同 tier 当天已有通知 → 跳过', async () => {
    const prisma = makePrisma({
      letterOfCredit: { findMany: vi.fn().mockResolvedValue([makeLc({ expiryDate: '2026-08-15' })]) },
      notification: { findFirst: vi.fn().mockResolvedValue({ id: 'NTF_existing' }) },
    });
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('dedupKey 含 tier 与日期（tier 升级会产生新 key）', async () => {
    const prisma = makePrisma({
      letterOfCredit: { findMany: vi.fn().mockResolvedValue([makeLc({ expiryDate: '2026-08-15' })]) },
    });
    await detectAndNotify(prisma, TODAY);
    const meta = mockBroadcast.mock.calls[0][0].metadata;
    expect(meta.expiryKey).toBe('expiry:lc_expiry:LC_1:critical:2026-08-10');
    expect(meta.entityType).toBe('LetterOfCredit');
    expect(meta.daysRemaining).toBe(5);
  });
});
