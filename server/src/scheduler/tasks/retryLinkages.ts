/**
 * Phase 0 Sprint 2 — 调度任务：崩溃恢复 + AgentJob 清理
 *
 * 任务 1（崩溃恢复，启动时执行一次）：
 *   - 服务器重启后，processedKeys 内存已清空
 *   - 扫描所有 status='queued' 的 bev:* AgentJob
 *   - 通过 businessEventBus 重放事件（idempotencyKey 去重 + 业务层幂等保证安全）
 *   - 标记为 'completed'
 *
 * 任务 2（清理，每小时执行）：
 *   - 重试 5 分钟前仍在 queued 的事件，仅消费者全部成功才 completed
 *   - 暂时失败保持 queued；无效 payload 标 failed，供人工修复
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { businessEventBus } from '../../events/businessEventBus';
import { logger } from '../../lib/logger';

const RETRY_BATCH_SIZE = 50;
const CLEANUP_AGE_MS = 5 * 60 * 1000; // 5 分钟

/** Invalid payloads need operator repair; consumer errors remain retryable and visible. */
async function replayJobs(prisma: PrismaClient, jobs: any[]): Promise<void> {
  for (const job of jobs) {
    const event = job.payload;
    if (!event || typeof event.type !== 'string' || !event.type ||
        typeof event.sourceEntityId !== 'string' || !event.sourceEntityId ||
        job.jobType !== `bev:${event.type}`) {
      await prisma.agentJob.update({ where: { id: job.id }, data: {
        status: 'failed', error: 'invalid event payload', completedAt: new Date(),
      } });
      continue;
    }
    try {
      // Use the durable job identity even for older payloads missing an id.
      const result = await businessEventBus.dispatch({ ...event, id: job.id });
      if (!result.ok) throw new Error(result.errors.join('; '));
      await prisma.agentJob.update({ where: { id: job.id }, data: {
        status: 'completed', error: null, completedAt: new Date(),
      } });
    } catch (error: any) {
      logger.error('[EventRecovery] consumer failed; retaining queued job', { jobId: job.id, error: String(error?.message ?? error) });
      // Move failures behind other work so one broken batch cannot starve the queue.
      await prisma.agentJob.update({ where: { id: job.id }, data: {
        status: 'queued', error: String(error?.message ?? error).slice(0, 4000),
        completedAt: null, scheduledAt: new Date(),
      } });
    }
  }
}

export function createCrashRecoveryTask(): ScheduledTask {
  let done = false;
  return {
    id: 'crash_recovery',
    timeDomain: 'wall',
    shouldRun: () => !done,
    run: async (prisma: PrismaClient) => {
      const jobs = await prisma.agentJob.findMany({
        where: { status: 'queued', jobType: { startsWith: 'bev:' } },
        orderBy: { scheduledAt: 'asc' }, take: RETRY_BATCH_SIZE,
      });
      await replayJobs(prisma, jobs);
      // Full batches continue next scheduler tick; failures were moved to the back.
      done = jobs.length < RETRY_BATCH_SIZE;
    },
  };
}

export function createCleanupTask(): ScheduledTask {
  let lastRunHour = -1;
  return {
    id: 'cleanup_queued_jobs',
    timeDomain: 'wall',
    shouldRun: (now: Date) => {
      const hour = Math.floor(now.getTime() / (60 * 60 * 1000));
      if (hour === lastRunHour) return false;
      lastRunHour = hour;
      return true;
    },
    run: async (prisma: PrismaClient) => {
      const jobs = await prisma.agentJob.findMany({
        where: { status: 'queued', jobType: { startsWith: 'bev:' },
          scheduledAt: { lt: new Date(Date.now() - CLEANUP_AGE_MS) } },
        orderBy: { scheduledAt: 'asc' }, take: RETRY_BATCH_SIZE,
      });
      await replayJobs(prisma, jobs);
    },
  };
}
