/**
 * H1c 工厂认证到期预警调度任务单元测试
 *
 * 覆盖：
 *   1. 分级：≤14 天 warning / ≤30 天 info / 已过期 critical / 30 天外不通知
 *   2. validUntil=null（长期有效）不预警
 *   3. 分级去重：同 tier 当天已有通知 → 跳过
 *   4. 通知内容含工厂名/认证类型/有效期/跳转链接
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockBroadcast = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../notifications/notificationService', () => ({
  createNotificationService: vi.fn(() => ({
    broadcastNotification: mockBroadcast,
  })),
}));

import { detectAndNotify } from '../tasks/factoryCertificationWatchdog';

// 固定今天：2026-08-10（本地零点）
const TODAY = new Date(2026, 7, 10);

function makePrisma(certs: any[], opts: { dedupHit?: boolean } = {}) {
  return {
    factoryCertification: {
      findMany: vi.fn().mockResolvedValue(certs),
    },
    notification: {
      findFirst: vi.fn().mockResolvedValue(opts.dedupHit ? { id: 'NTF_1' } : null),
    },
  } as any;
}

function makeCert(overrides: Record<string, any> = {}) {
  return {
    id: 'FACR__1',
    factoryId: 'FACP__1',
    type: 'BSCI',
    validUntil: '2026-08-20',
    deletedAt: null,
    factory: { id: 'FACP__1', deletedAt: null, relation: { name: '某纺织厂' } },
    ...overrides,
  };
}

describe('factoryCertificationWatchdog · detectAndNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('10 天后到期 → info；14 天内 → warning；已过期 → critical', async () => {
    // info: 20 天
    let prisma = makePrisma([makeCert({ validUntil: '2026-08-30' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('info');
    expect(mockBroadcast.mock.calls[0][0].type).toBe('factory_certification_expiring');

    // warning: 10 天
    vi.clearAllMocks();
    prisma = makePrisma([makeCert({ validUntil: '2026-08-20' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('warning');
    expect(mockBroadcast.mock.calls[0][0].title).toContain('某纺织厂');
    expect(mockBroadcast.mock.calls[0][0].title).toContain('BSCI');
    expect(mockBroadcast.mock.calls[0][0].link).toBe('/suppliers?id=FACP__1');

    // critical: 已过期
    vi.clearAllMocks();
    prisma = makePrisma([makeCert({ validUntil: '2026-08-01' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('critical');
    expect(mockBroadcast.mock.calls[0][0].title).toContain('已过期');
  });

  it('30 天外 / 长期有效（validUntil=null）→ 不通知', async () => {
    // 查询窗口本身只取 30 天内，这里模拟 31 天的行被 DB 过滤后为空集
    const prisma = makePrisma([]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();

    // validUntil=null 的行即使返回也被跳过
    const prisma2 = makePrisma([makeCert({ validUntil: null })]);
    const sent2 = await detectAndNotify(prisma2, TODAY);
    expect(sent2).toBe(0);
  });

  it('分级去重：同 tier 当天已有通知 → 跳过', async () => {
    const prisma = makePrisma([makeCert()], { dedupHit: true });
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('metadata 携带 factoryId/certType/daysRemaining/tier 供前端跳转与追溯', async () => {
    const prisma = makePrisma([makeCert({ validUntil: '2026-08-20' })]);
    await detectAndNotify(prisma, TODAY);
    const meta = mockBroadcast.mock.calls[0][0].metadata;
    expect(meta.entityType).toBe('FactoryCertification');
    expect(meta.factoryId).toBe('FACP__1');
    expect(meta.factoryName).toBe('某纺织厂');
    expect(meta.certType).toBe('BSCI');
    expect(meta.daysRemaining).toBe(10);
    expect(meta.tier).toBe('warning');
  });
});
