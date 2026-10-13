/**
 * H3 风险巡检调度任务单元测试
 *
 * 覆盖：
 *   1. credit_risk_watchdog：每日 10:00 后执行一次（日去重 + 时间门槛）
 *   2. quality_repeat_watchdog：每日 10:30 后执行一次（日去重 + 时间门槛）
 *   3. run 调用 RiskService 对应扫描；扫描抛错被 catch 住并记 error 日志
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockCreditScan = vi.fn().mockResolvedValue({ frozenCount: 0, badDebtCount: 0 });
const mockQualityScan = vi.fn().mockResolvedValue({ alerted: 0 });

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../risk/riskService', () => ({
  createRiskService: vi.fn(() => ({
    runCreditRiskScan: mockCreditScan,
    runQualityRepeatScan: mockQualityScan,
  })),
}));

import { logger } from '../../lib/logger';
import { createCreditRiskWatchdogTask, createQualityRepeatWatchdogTask } from '../tasks/riskWatchdog';

describe('riskWatchdog · credit_risk_watchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('每日 10:00 后执行一次：日去重', async () => {
    const task = createCreditRiskWatchdogTask();
    expect(task.id).toBe('credit_risk_watchdog');
    // 2026-08-20 10:00 → 首次触发
    expect(task.shouldRun(new Date(2026, 7, 20, 10, 0))).toBe(true);
    // 同日 11:00 → 不再触发
    expect(task.shouldRun(new Date(2026, 7, 20, 11, 0))).toBe(false);
    // 次日 10:00 → 再次触发
    expect(task.shouldRun(new Date(2026, 7, 21, 10, 0))).toBe(true);
  });

  it('10:00 前不触发', () => {
    const task = createCreditRiskWatchdogTask();
    expect(task.shouldRun(new Date(2026, 7, 22, 9, 59))).toBe(false);
    expect(task.shouldRun(new Date(2026, 7, 22, 10, 0))).toBe(true);
  });

  it('run 调用 runCreditRiskScan；抛错被捕获并记日志', async () => {
    const task = createCreditRiskWatchdogTask();
    await task.run({} as any);
    expect(mockCreditScan).toHaveBeenCalledTimes(1);

    mockCreditScan.mockRejectedValueOnce(new Error('boom'));
    await expect(task.run({} as any)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('[CreditRiskWatchdog] failed', { error: 'boom' });
  });
});

describe('riskWatchdog · quality_repeat_watchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('每日 10:30 后执行一次：时间门槛 + 日去重', () => {
    const task = createQualityRepeatWatchdogTask();
    expect(task.id).toBe('quality_repeat_watchdog');
    // 10:00 / 10:29 → 未到点不触发
    expect(task.shouldRun(new Date(2026, 7, 23, 10, 0))).toBe(false);
    expect(task.shouldRun(new Date(2026, 7, 23, 10, 29))).toBe(false);
    // 10:30 → 首次触发
    expect(task.shouldRun(new Date(2026, 7, 23, 10, 30))).toBe(true);
    // 同日 11:00 → 不再触发
    expect(task.shouldRun(new Date(2026, 7, 23, 11, 0))).toBe(false);
    // 次日 10:31 → 再次触发
    expect(task.shouldRun(new Date(2026, 7, 24, 10, 31))).toBe(true);
  });

  it('run 调用 runQualityRepeatScan；抛错被捕获并记日志', async () => {
    const task = createQualityRepeatWatchdogTask();
    await task.run({} as any);
    expect(mockQualityScan).toHaveBeenCalledTimes(1);

    mockQualityScan.mockRejectedValueOnce(new Error('boom'));
    await expect(task.run({} as any)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('[QualityRepeatWatchdog] failed', { error: 'boom' });
  });
});
