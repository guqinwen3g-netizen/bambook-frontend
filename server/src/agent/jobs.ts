import { PrismaClient } from '@prisma/client';

/**
 * Agent 后台任务队列 — Prisma 持久化实现（AgentJob 模型）+ 消费者执行器。
 *
 * 2026-08-19 接线收口：此前为纯内存 stub（仅 enqueue/stats，无消费者执行器，
 * schema 已预留模型未接线）。任务入队后进程重启不丢，claimNext 原子领取，
 * runPendingJobs 按 handler 注册表消费。
 *
 * 生命周期：queued → running → completed | failed
 *   - claimNext：updateMany 原子抢占（where id + status='queued'，count=1 才算领到）
 *   - unknown jobType / handler 抛错 → fail 落库（error 语义化）
 */

export interface AgentJobRecord {
  id: string;
  jobType: string;
  status: string;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  scheduledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobHandler = (job: AgentJobRecord) => Promise<Record<string, unknown> | void>;

export function createJobService(prisma: PrismaClient) {
  async function enqueue(input: {
    jobType: string;
    payload: Record<string, unknown>;
    priority?: number;
  }): Promise<AgentJobRecord> {
    if (!input.jobType?.trim()) throw new Error('JOB_TYPE_REQUIRED: jobType 不能为空');
    return prisma.agentJob.create({
      data: {
        id: `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        jobType: input.jobType,
        status: 'queued',
        priority: input.priority ?? 5,
        payload: input.payload as any,
      },
    }) as Promise<AgentJobRecord>;
  }

  async function stats(): Promise<{ queued: number; running: number; completed: number; failed: number }> {
    const rows = await prisma.agentJob.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus = new Map(rows.map(row => [row.status, row._count._all]));
    return {
      queued: byStatus.get('queued') ?? 0,
      running: byStatus.get('running') ?? 0,
      completed: byStatus.get('completed') ?? 0,
      failed: byStatus.get('failed') ?? 0,
    };
  }

  /** 原子领取下一个 queued 任务（priority 小者先，同级先入队先执行）。竞争失败返回 null。 */
  async function claimNext(): Promise<AgentJobRecord | null> {
    const candidates = await prisma.agentJob.findMany({
      where: { status: 'queued' },
      orderBy: [{ priority: 'asc' }, { scheduledAt: 'asc' }],
      take: 5,
    });
    for (const candidate of candidates) {
      const claimed = await prisma.agentJob.updateMany({
        where: { id: candidate.id, status: 'queued' },
        data: { status: 'running', startedAt: new Date() },
      });
      if (claimed.count === 1) {
        return prisma.agentJob.findUnique({ where: { id: candidate.id } }) as Promise<AgentJobRecord>;
      }
    }
    return null;
  }

  async function complete(jobId: string, result?: Record<string, unknown>): Promise<void> {
    await prisma.agentJob.update({
      where: { id: jobId },
      data: { status: 'completed', completedAt: new Date(), result: (result ?? {}) as any },
    });
  }

  async function fail(jobId: string, error: string): Promise<void> {
    await prisma.agentJob.update({
      where: { id: jobId },
      data: { status: 'failed', completedAt: new Date(), error },
    });
  }

  /**
   * 消费者执行器：按 handler 注册表批量处理 queued 任务。
   * 返回本轮处理结果摘要；未注册 jobType 的任务 fail 落库（不静默丢弃）。
   */
  async function runPendingJobs(
    handlers: Record<string, JobHandler>,
    options: { maxJobs?: number } = {},
  ): Promise<{ processed: number; completed: number; failed: number }> {
    const maxJobs = Math.min(Math.max(options.maxJobs ?? 5, 1), 50);
    let processed = 0;
    let completed = 0;
    let failed = 0;
    while (processed < maxJobs) {
      const job = await claimNext();
      if (!job) break;
      processed += 1;
      const handler = handlers[job.jobType];
      if (!handler) {
        await fail(job.id, `UNKNOWN_JOB_TYPE: no handler registered for ${job.jobType}`);
        failed += 1;
        continue;
      }
      try {
        const result = await handler(job);
        await complete(job.id, (result as Record<string, unknown>) ?? undefined);
        completed += 1;
      } catch (error: any) {
        await fail(job.id, String(error?.message || error));
        failed += 1;
      }
    }
    return { processed, completed, failed };
  }

  return { enqueue, stats, claimNext, complete, fail, runPendingJobs };
}
