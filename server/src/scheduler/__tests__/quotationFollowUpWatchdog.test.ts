/**
 * 报价发出超期未回复跟进提醒单元测试（PRD 7.1「报价超 7 天未回复」）
 *
 * 覆盖：
 *   1. 分级：7-13 天 warning；≥14 天 critical
 *   2. sentAt < 7 天 → 不通知（循环内二次校验）
 *   3. 查询口径：仅 status=Sent + 未软删 + sentAt 非空
 *   4. 幂等：同 tier 当天已有通知（stuckKey 匹配）→ 跳过
 *   5. 正文含客户名 / 金额 / 发出日期 / 天数；link 指向报价页
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

import { scanQuotationFollowUps } from '../tasks/quotationFollowUpWatchdog';

// 固定今天：2026-08-10（本地零点）
const TODAY = new Date(2026, 7, 10);
const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY_MS = new Date(2026, 7, 10).getTime();

function makePrisma(quotations: any[] = [], existingNotification: any = null) {
  return {
    quotation: {
      findMany: vi.fn().mockResolvedValue(quotations),
    },
    notification: {
      findFirst: vi.fn().mockResolvedValue(existingNotification),
    },
  } as any;
}

function makeQuotation(daysAgo: number, overrides: Record<string, any> = {}) {
  return {
    id: 'QT_1',
    quotationNumber: 'QT-2026-001',
    customerName: 'Client A',
    totalAmount: '35800',
    currency: 'USD',
    sentAt: BigInt(TODAY_MS - daysAgo * DAY_MS),
    ...overrides,
  };
}

describe('quotationFollowUpWatchdog · scanQuotationFollowUps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('发送 8 天未回复 → warning，正文含客户/金额/天数', async () => {
    const prisma = makePrisma([makeQuotation(8)]);
    const { notified } = await scanQuotationFollowUps(prisma, TODAY);
    expect(notified).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.type).toBe('quotation_no_reply');
    expect(arg.level).toBe('warning');
    expect(arg.title).toContain('QT-2026-001');
    expect(arg.title).toContain('8 天');
    expect(arg.body).toContain('Client A');
    expect(arg.body).toContain('USD');
    expect(arg.link).toBe('/quotations?id=QT_1');
    expect(arg.metadata.stuckKey).toContain('quotation:no_reply:QT_1:warning:');
    expect(arg.metadata.daysPending).toBe(8);
  });

  it('发送 13 天 → warning；14 天 → critical', async () => {
    let prisma = makePrisma([makeQuotation(13)]);
    await scanQuotationFollowUps(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('warning');

    vi.clearAllMocks();
    prisma = makePrisma([makeQuotation(14)]);
    await scanQuotationFollowUps(prisma, TODAY);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.level).toBe('critical');
    expect(arg.metadata.stuckKey).toContain(':critical:');
  });

  it('发送 6 天（未达 7 天阈值）→ 不通知', async () => {
    const prisma = makePrisma([makeQuotation(6)]);
    const { notified } = await scanQuotationFollowUps(prisma, TODAY);
    expect(notified).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('sentAt 非法（0 / 负值）→ 跳过', async () => {
    const prisma = makePrisma([makeQuotation(0, { sentAt: BigInt(0) })]);
    const { notified } = await scanQuotationFollowUps(prisma, TODAY);
    expect(notified).toBe(0);
  });

  it('查询口径：仅 Sent + 未软删 + sentAt 非空且 ≤ 今天-7 天', async () => {
    const prisma = makePrisma([]);
    await scanQuotationFollowUps(prisma, TODAY);
    const where = prisma.quotation.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('Sent');
    expect(where.deletedAt).toBeNull();
    expect(where.sentAt.not).toBeNull();
    // lte 阈值 = 今天零点 - 7 天（BigInt）
    expect(where.sentAt.lte).toBe(BigInt(TODAY_MS - 7 * DAY_MS));
  });

  it('幂等：同 tier 当天已有通知 → 跳过', async () => {
    const prisma = makePrisma([makeQuotation(9)], { id: 'NTF_X' });
    const { notified } = await scanQuotationFollowUps(prisma, TODAY);
    expect(notified).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('多条超期报价各自产生独立通知', async () => {
    const prisma = makePrisma([
      makeQuotation(8, { id: 'QT_1', quotationNumber: 'QT-2026-001' }),
      makeQuotation(20, { id: 'QT_2', quotationNumber: 'QT-2026-002' }),
    ]);
    const { notified } = await scanQuotationFollowUps(prisma, TODAY);
    expect(notified).toBe(2);
    const levels = mockBroadcast.mock.calls.map(c => c[0].level).sort();
    expect(levels).toEqual(['critical', 'warning']);
  });
});
