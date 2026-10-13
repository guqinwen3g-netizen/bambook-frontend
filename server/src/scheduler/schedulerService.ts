/**
 * Phase 0 Sprint 2 — 调度器服务（SchedulerService）
 *
 * 设计目标：
 *   1. 崩溃恢复：服务器重启后重放未完成的 AgentJob（bev:* 类型）
 *   2. 定时任务：每日 briefing、卡滞检测、清理过期 AgentJob
 *   3. 非阻塞：所有任务异步执行，不阻塞主线程
 *
 * 不变量：
 *   - 调度器失败不阻断服务器启动
 *   - 每个任务幂等（安全重复执行）
 *   - 单次 tick 内同一任务不并发执行（防重叠）
 *
 * 调度策略：
 *   - 主循环间隔 30 秒
 *   - 崩溃恢复仅在启动时执行一次
 *   - 每日 briefing 在每天 09:00 执行
 *   - 卡滞检测每小时执行
 *   - AgentJob 清理每小时执行
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { businessNowDate } from '../shared/businessClock';

export interface ScheduledTask {
  id: string;
  /** Business reminders use the scenario calendar; operational maintenance
   * such as email polling and retry cleanup keeps advancing with real time. */
  timeDomain?: 'business' | 'wall';
  shouldRun: (now: Date) => boolean;
  run: (prisma: PrismaClient) => Promise<void>;
  lastRunAt?: Date;
  running?: boolean;
}

export class SchedulerService {
  private prisma: PrismaClient;
  private tasks: ScheduledTask[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;
  private started = false;
  private readonly tickIntervalMs: number;

  constructor(prisma: PrismaClient, tickIntervalMs = 30_000) {
    this.prisma = prisma;
    this.tickIntervalMs = tickIntervalMs;
  }

  register(task: ScheduledTask): void {
    if (this.tasks.some(t => t.id === task.id)) {
      logger.warn('[Scheduler] task already registered, skipping', { taskId: task.id });
      return;
    }
    this.tasks.push(task);
    logger.info('[Scheduler] task registered', { taskId: task.id });
  }

  start(): void {
    if (this.started) {
      logger.warn('[Scheduler] already started, skipping');
      return;
    }
    this.started = true;
    logger.info('[Scheduler] started', {
      tickIntervalMs: this.tickIntervalMs,
      taskCount: this.tasks.length,
    });

    // 启动后立即执行一次（用于崩溃恢复等启动时任务）
    this.tick().catch(e => {
      logger.error('[Scheduler] initial tick failed', { error: e?.message });
    });

    this.intervalHandle = setInterval(() => {
      this.tick().catch(e => {
        logger.error('[Scheduler] tick failed', { error: e?.message });
      });
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.started = false;
    logger.info('[Scheduler] stopped');
  }

  private async tick(): Promise<void> {
    const businessNow = businessNowDate(), wallNow = new Date();
    const runnable = this.tasks.filter(t => !t.running && t.shouldRun(t.timeDomain === 'wall' ? wallNow : businessNow));

    for (const task of runnable) {
      task.running = true;
      try {
        await task.run(this.prisma);
        task.lastRunAt = task.timeDomain === 'wall' ? wallNow : businessNow;
      } catch (e: any) {
        logger.error('[Scheduler] task failed', {
          taskId: task.id,
          error: e?.message,
        });
      } finally {
        task.running = false;
      }
    }
  }
}

// ── 单例 ──
let schedulerInstance: SchedulerService | null = null;

export function initializeScheduler(prisma: PrismaClient, tickIntervalMs?: number): SchedulerService {
  if (schedulerInstance) {
    logger.warn('[Scheduler] already initialized, skipping');
    return schedulerInstance;
  }
  schedulerInstance = new SchedulerService(prisma, tickIntervalMs);
  return schedulerInstance;
}

export function getScheduler(): SchedulerService | null {
  return schedulerInstance;
}
