/**
 * 厂前样（PP Sample）寄出超 3 天未确认提醒单元测试（PRD 7.1「厂前样超 3 天未确认」）
 *
 * 消双轨 L-2：读源由 SampleNode 迁移至 SampleBatch（garment-round，status='sent' 未确认）。
 * 覆盖：
 *   1. sentDate ≤ 今天-3 天且未确认 → warning（正文含快递单号与开发案标识）
 *   2. sentDate 未达 3 天 → 不通知
 *   3. 关联开发案已取消 / 已软删 / 缺失 → 不通知
 *   4. 查询口径：仅 sampleType=garment-round + status=sent + 未软删 + sentDate 非空
 *   5. 幂等：当天已有通知（stuckKey 匹配）→ 跳过
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

import { scanPpSampleConfirmations } from '../tasks/ppSampleConfirmationWatchdog';

// 固定今天：2026-08-10（本地零点）
const TODAY = new Date(2026, 7, 10);

function makePrisma(batches: any[] = [], cases: any[] = [], existingNotification: any = null) {
  return {
    sampleBatch: {
      findMany: vi.fn().mockResolvedValue(batches),
    },
    developmentCase: {
      findMany: vi.fn().mockResolvedValue(cases),
    },
    notification: {
      findFirst: vi.fn().mockResolvedValue(existingNotification),
    },
  } as any;
}

function makeNode(overrides: Record<string, any> = {}) {
  return {
    id: 'SB__DC_1__round1',
    developmentCaseId: 'DC_1',
    sampleType: 'garment-round',
    status: 'sent',
    sentDate: '2026-08-06', // 4 天前
    courier: 'DHL',
    trackingNumber: '1234567890',
    attachments: { purpose: '产前样' },
    ...overrides,
  };
}

function makeCase(overrides: Record<string, any> = {}) {
  return {
    id: 'DC_1',
    code: 'DC-2026-001',
    name: '夏季衬衫开发',
    stage: 'developing',
    deletedAt: null,
    ...overrides,
  };
}

describe('ppSampleConfirmationWatchdog · scanPpSampleConfirmations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('寄出 4 天未确认 → warning，正文含开发案标识与快递信息', async () => {
    const prisma = makePrisma([makeNode()], [makeCase()]);
    const { notified } = await scanPpSampleConfirmations(prisma, TODAY);
    expect(notified).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.type).toBe('pp_sample_unconfirmed');
    expect(arg.level).toBe('warning');
    expect(arg.title).toContain('DC-2026-001');
    expect(arg.title).toContain('4 天');
    expect(arg.body).toContain('DHL');
    expect(arg.body).toContain('1234567890');
    expect(arg.body).toContain('开裁前置条件');
    expect(arg.link).toBe('/development?id=DC_1');
    expect(arg.metadata.stuckKey).toContain('pp_sample:unconfirmed:SB__DC_1__round1:');
    expect(arg.metadata.daysPending).toBe(4);
  });

  it('寄出 2 天（未达 3 天阈值）→ 不通知', async () => {
    const prisma = makePrisma([makeNode({ sentDate: '2026-08-08' })], [makeCase()]);
    const { notified } = await scanPpSampleConfirmations(prisma, TODAY);
    expect(notified).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('sentDate 非法 → 跳过', async () => {
    const prisma = makePrisma([makeNode({ sentDate: 'not-a-date' })], [makeCase()]);
    const { notified } = await scanPpSampleConfirmations(prisma, TODAY);
    expect(notified).toBe(0);
  });

  it('开发案已取消（stage=cancelled）→ 不通知', async () => {
    const prisma = makePrisma([makeNode()], [makeCase({ stage: 'cancelled' })]);
    const { notified } = await scanPpSampleConfirmations(prisma, TODAY);
    expect(notified).toBe(0);
  });

  it('开发案已软删 → 不通知', async () => {
    const prisma = makePrisma([makeNode()], [makeCase({ deletedAt: BigInt(Date.now()) })]);
    const { notified } = await scanPpSampleConfirmations(prisma, TODAY);
    expect(notified).toBe(0);
  });

  it('开发案缺失（软引用悬空）→ 不通知', async () => {
    const prisma = makePrisma([makeNode()], []);
    const { notified } = await scanPpSampleConfirmations(prisma, TODAY);
    expect(notified).toBe(0);
  });

  it('查询口径：仅 garment-round + sent + 未软删 + sentDate 非空', async () => {
    const prisma = makePrisma([], []);
    await scanPpSampleConfirmations(prisma, TODAY);
    const where = prisma.sampleBatch.findMany.mock.calls[0][0].where;
    expect(where.sampleType).toBe('garment-round');
    expect(where.status).toBe('sent');
    expect(where.deletedAt).toBeNull();
    expect(where.sentDate.not).toBeNull();
  });

  it('幂等：当天已有通知 → 跳过', async () => {
    const prisma = makePrisma([makeNode()], [makeCase()], { id: 'NTF_X' });
    const { notified } = await scanPpSampleConfirmations(prisma, TODAY);
    expect(notified).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('code 缺失时回退 name 作为开发案标识', async () => {
    const prisma = makePrisma([makeNode()], [makeCase({ code: '' })]);
    const { notified } = await scanPpSampleConfirmations(prisma, TODAY);
    expect(notified).toBe(1);
    expect(mockBroadcast.mock.calls[0][0].title).toContain('夏季衬衫开发');
  });
});
