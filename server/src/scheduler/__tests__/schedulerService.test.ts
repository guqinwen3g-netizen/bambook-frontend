/**
 * Phase 0 Sprint 2 — 调度器服务单元测试
 *
 * 覆盖：
 *   - 任务注册（去重）
 *   - shouldRun 过滤（只执行满足条件的任务）
 *   - running 标志防止并发执行
 *   - 任务失败不阻断其他任务
 *   - start/stop 生命周期
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SchedulerService } from '../schedulerService';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('SchedulerService', () => {
  let scheduler: SchedulerService;
  let prisma: any;

  beforeEach(() => {
    prisma = {};
    scheduler = new SchedulerService(prisma, 100); // 100ms tick for fast tests
  });

  it('registers and runs a task when shouldRun returns true', async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({
      id: 'test_task',
      shouldRun: () => true,
      run: runFn,
    });

    scheduler.start();
    await new Promise(r => setTimeout(r, 200));
    scheduler.stop();

    expect(runFn).toHaveBeenCalled();
  });

  it('does not run a task when shouldRun returns false', async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({
      id: 'skip_task',
      shouldRun: () => false,
      run: runFn,
    });

    scheduler.start();
    await new Promise(r => setTimeout(r, 200));
    scheduler.stop();

    expect(runFn).not.toHaveBeenCalled();
  });

  it('prevents duplicate task registration', () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({ id: 'dup', shouldRun: () => false, run: runFn });
    scheduler.register({ id: 'dup', shouldRun: () => false, run: runFn });

    // Only one task should be registered
    expect((scheduler as any).tasks).toHaveLength(1);
  });

  it('task failure does not block other tasks', async () => {
    const failFn = vi.fn().mockRejectedValue(new Error('boom'));
    const successFn = vi.fn().mockResolvedValue(undefined);

    scheduler.register({ id: 'failer', shouldRun: () => true, run: failFn });
    scheduler.register({ id: 'succeeder', shouldRun: () => true, run: successFn });

    scheduler.start();
    await new Promise(r => setTimeout(r, 200));
    scheduler.stop();

    expect(failFn).toHaveBeenCalled();
    expect(successFn).toHaveBeenCalled();
  });

  it('does not execute same task concurrently (running flag)', async () => {
    let callCount = 0;
    const slowFn = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 150)); // longer than tick
    });

    scheduler.register({ id: 'slow', shouldRun: () => true, run: slowFn });

    scheduler.start();
    await new Promise(r => setTimeout(r, 350));
    scheduler.stop();

    // With 100ms tick and 150ms execution, should run at most 2-3 times
    // (not on every tick because running flag prevents overlap)
    expect(callCount).toBeLessThanOrEqual(3);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it('start is idempotent', () => {
    scheduler.register({ id: 't', shouldRun: () => false, run: vi.fn() });
    scheduler.start();
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it('stop clears interval', () => {
    scheduler.register({ id: 't', shouldRun: () => true, run: vi.fn() });
    scheduler.start();
    scheduler.stop();

    expect((scheduler as any).intervalHandle).toBeNull();
    expect((scheduler as any).started).toBe(false);
  });

  it('updates lastRunAt after successful execution', async () => {
    const task = {
      id: 'tracked',
      shouldRun: () => true,
      run: vi.fn().mockResolvedValue(undefined),
    };
    scheduler.register(task);

    scheduler.start();
    await new Promise(r => setTimeout(r, 200));
    scheduler.stop();

    expect(task.lastRunAt).toBeInstanceOf(Date);
  });
});
