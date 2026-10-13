/**
 * M4 新报关单合规检查轮询调度任务单元测试
 *
 * 覆盖：
 *   1. 缺失 hs_code / export_control 检查的报关单自动补跑（actorId=null 系统自动）
 *   2. 幂等：已有同类型检查记录的报关单跳过（ComplianceCheck 存在性闸门，重启自愈）
 *   3. 单张报关单失败不阻断其余报关单
 *   4. 轮询窗口与批量上限传入查询（近 7 天 / take 200 / 软删过滤）
 *   5. shouldRun：15 分钟桶去重
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockHsCheck = vi.fn().mockResolvedValue({ id: 'CPC_HS' });
const mockEcCheck = vi.fn().mockResolvedValue({ id: 'CPC_EC' });

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../risk/riskService', () => ({
  createRiskService: vi.fn(() => ({
    runHsCodeCheck: mockHsCheck,
    runExportControlCheck: mockEcCheck,
  })),
}));

import { scanNewDeclarationsForCompliance, createCustomsComplianceWatchdogTask } from '../tasks/customsComplianceWatchdog';

const NOW = new Date(2026, 7, 10, 12, 0, 0);

/** existingChecks: `${declarationId}:${type}` → true 表示该检查已存在 */
function makePrisma(declarations: Array<{ id: string }>, existingChecks: Record<string, boolean> = {}) {
  return {
    customsDeclaration: {
      findMany: vi.fn().mockResolvedValue(declarations),
    },
    complianceCheck: {
      findFirst: vi.fn(async ({ where }: any) =>
        existingChecks[`${where.targetId}:${where.type}`] ? { id: 'CPC_EXIST' } : null,
      ),
    },
  } as any;
}

describe('customsComplianceWatchdog · scanNewDeclarationsForCompliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHsCheck.mockResolvedValue({ id: 'CPC_HS' });
    mockEcCheck.mockResolvedValue({ id: 'CPC_EC' });
  });

  it('两类检查均缺失 → 各跑一次（系统自动）', async () => {
    const prisma = makePrisma([{ id: 'CD_1' }]);
    const res = await scanNewDeclarationsForCompliance(prisma, NOW);
    expect(res).toEqual({ scanned: 1, hsRun: 1, ecRun: 1, failed: 0 });
    expect(mockHsCheck).toHaveBeenCalledWith('CD_1', null);
    expect(mockEcCheck).toHaveBeenCalledWith('CD_1', null);
  });

  it('幂等：已有检查记录 → 跳过不重复跑', async () => {
    const prisma = makePrisma([{ id: 'CD_1' }, { id: 'CD_2' }], {
      'CD_1:hs_code': true,
      'CD_1:export_control': true,
      'CD_2:export_control': true, // CD_2 仅缺 HS
    });
    const res = await scanNewDeclarationsForCompliance(prisma, NOW);
    expect(res).toEqual({ scanned: 2, hsRun: 1, ecRun: 0, failed: 0 });
    expect(mockHsCheck).toHaveBeenCalledTimes(1);
    expect(mockHsCheck).toHaveBeenCalledWith('CD_2', null);
    expect(mockEcCheck).not.toHaveBeenCalled();
  });

  it('单张报关单失败不阻断其余报关单', async () => {
    mockHsCheck.mockRejectedValueOnce(new Error('报关单不存在'));
    const prisma = makePrisma([{ id: 'CD_GONE' }, { id: 'CD_2' }]);
    const res = await scanNewDeclarationsForCompliance(prisma, NOW);
    expect(res.failed).toBe(1);
    expect(res.hsRun).toBe(1); // CD_2 照常补跑
    expect(res.ecRun).toBe(2); // 出口管制互不影响
  });

  it('轮询窗口/软删/批量上限传入查询条件', async () => {
    const prisma = makePrisma([]);
    await scanNewDeclarationsForCompliance(prisma, NOW);
    const args = prisma.customsDeclaration.findMany.mock.calls[0][0];
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.createdAt.gte).toBe(BigInt(NOW.getTime() - 7 * 24 * 60 * 60 * 1000));
    expect(args.take).toBe(200);
  });
});

describe('customsComplianceWatchdog · shouldRun', () => {
  it('15 分钟桶去重：同桶第二次不跑，跨桶再跑', () => {
    const task = createCustomsComplianceWatchdogTask();
    expect(task.shouldRun(new Date(2026, 7, 20, 10, 1))).toBe(true);
    expect(task.shouldRun(new Date(2026, 7, 20, 10, 10))).toBe(false); // 同 15 分钟桶
    expect(task.shouldRun(new Date(2026, 7, 20, 10, 16))).toBe(true); // 下一桶
  });
});
