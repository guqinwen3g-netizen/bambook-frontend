/**
 * Agent Checkpoint/Resume — 断点续传
 *
 * 在 agentLoop 每步执行后保存状态，进程崩溃后可从最后一个 checkpoint 恢复。
 *
 * 设计原则:
 *   1. 轻量——checkpoint 只保存恢复必需的最小状态（step/scratchpad/iterations）
 *   2. 可选——不传入 checkpointManager 时，agentLoop 行为不变（向后兼容）
 *   3. 幂等——resume 时从 checkpoint 的 step+1 开始，scratchpad 已包含历史
 */

import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ActorContext } from './types';

/**
 * Produces the only key allowed to address a durable Agent checkpoint.
 *
 * The browser session token is a routing hint, not an authorization boundary.
 * Bind it to the resolved actor and department scope before it reaches the
 * checkpoint store so identical client-provided session ids cannot resume
 * another actor's scratchpad or tool outputs.
 */
export function createCheckpointConversationId(input: {
  sessionId: string;
  actor: Pick<ActorContext, 'userId' | 'departmentIds'>;
}): string {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error('CHECKPOINT_SESSION_ID_REQUIRED');
  const scope = {
    version: 1,
    userId: input.actor.userId,
    departmentIds: [...input.actor.departmentIds].sort(),
    sessionId,
  };
  return `ckpt_v1_${createHash('sha256').update(JSON.stringify(scope)).digest('base64url')}`;
}

/**
 * 批次 2b：挂起审批持久化记录。
 * 挂起等待审批时随 checkpoint 落库；进程重启后 resume 据此查
 * ApprovalRequest 决议状态（真源）补执行或重新等待。
 */
export interface PendingApprovalRecord {
  approvalId: string;
  step: number;
  toolId: string;
  toolInput: Record<string, unknown>;
  why?: string;
  suspendedAt: string;
}

export interface AgentCheckpoint {
  id: string;
  conversationId: string;
  step: number;
  message: string;
  scratchpad: {
    thoughts: Array<{ step: number; content: string }>;
    toolCalls: Array<Record<string, unknown>>;
  };
  iterations: Array<Record<string, unknown>>;
  /** 挂起中（未决议）的审批；决议处理后随步末 checkpoint 覆盖清除 */
  pendingApproval?: PendingApprovalRecord | null;
  createdAt: string;
}

export interface CheckpointManager {
  save(checkpoint: AgentCheckpoint): Promise<void>;
  load(conversationId: string): Promise<AgentCheckpoint | null>;
  clear(conversationId: string): Promise<void>;
}

/**
 * 内存版 CheckpointManager（单进程，开发/测试用）
 */
export class InMemoryCheckpointManager implements CheckpointManager {
  private store = new Map<string, AgentCheckpoint>();

  async save(checkpoint: AgentCheckpoint): Promise<void> {
    this.store.set(checkpoint.conversationId, checkpoint);
  }

  async load(conversationId: string): Promise<AgentCheckpoint | null> {
    return this.store.get(conversationId) || null;
  }

  async clear(conversationId: string): Promise<void> {
    this.store.delete(conversationId);
  }
}

/**
 * Prisma 版 CheckpointManager（生产用，持久化到数据库）
 * 需要 AgentCheckpoint model（待 migration）
 */
export class PrismaCheckpointManager implements CheckpointManager {
  constructor(private prisma: PrismaClient) {}

  async save(checkpoint: AgentCheckpoint): Promise<void> {
    const model = (this.prisma as any).agentCheckpoint;
    if (!model) throw new Error('CHECKPOINT_STORAGE_UNAVAILABLE');
    await model.upsert({
      where: { conversationId: checkpoint.conversationId },
      create: {
        id: checkpoint.id,
        conversationId: checkpoint.conversationId,
        step: checkpoint.step,
        message: checkpoint.message,
        scratchpad: checkpoint.scratchpad,
        iterations: checkpoint.iterations,
        pendingApproval: (checkpoint.pendingApproval ?? null) as any,
        createdAt: checkpoint.createdAt,
      },
      update: {
        step: checkpoint.step,
        scratchpad: checkpoint.scratchpad,
        iterations: checkpoint.iterations,
        pendingApproval: (checkpoint.pendingApproval ?? null) as any,
      },
    });
  }

  async load(conversationId: string): Promise<AgentCheckpoint | null> {
    const model = (this.prisma as any).agentCheckpoint;
    if (!model) throw new Error('CHECKPOINT_STORAGE_UNAVAILABLE');
    const row = await model.findUnique({ where: { conversationId } });
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversationId,
      step: row.step,
      message: row.message,
      scratchpad: row.scratchpad,
      iterations: row.iterations,
      pendingApproval: (row.pendingApproval as PendingApprovalRecord | null) ?? null,
      createdAt: row.createdAt,
    };
  }

  async clear(conversationId: string): Promise<void> {
    const model = (this.prisma as any).agentCheckpoint;
    if (!model) throw new Error('CHECKPOINT_STORAGE_UNAVAILABLE');
    await model.deleteMany({ where: { conversationId } });
  }
}

/**
 * 生成 checkpoint ID
 */
export function generateCheckpointId(): string {
  return `ckp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
