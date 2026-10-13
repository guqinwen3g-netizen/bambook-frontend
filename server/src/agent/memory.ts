import { PrismaClient } from '@prisma/client';
import { ActorContext } from './types';

/**
 * Agent 记忆服务 — Prisma 持久化实现（AgentMemory 模型）。
 *
 * 2026-08-19 接线收口：此前为纯内存数组实现（进程重启全丢，schema 已预留模型未接线）。
 *
 * 语义：
 *   - scope 必须在 actor.memoryScopes 内（personal:{userId} / role:{role} / department:{id} / company），
 *     读与写同口径防越权（sales 不可写 department:finance 记忆）
 *   - personal:{userId} → 落 userId 列；department:{id} → 落 departmentId 列；其余仅 scope
 *   - 软删（deletedAt）+ status='active' 过滤，recall 只返回活跃记忆
 */

export interface MemoryRecord {
  id: string;
  userId: string | null;
  departmentId: string | null;
  scope: string;
  memoryType: string;
  content: string;
  summary: string | null;
  confidence: number;
  sourceType: string | null;
  sourceId: string | null;
  relatedEntity: string | null;
  relatedEntityId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export type RememberInput = {
  actor: ActorContext;
  scope: string;
  memoryType: string;
  content: string;
  summary?: string;
  sourceType?: string;
  sourceId?: string;
  relatedEntity?: string;
  relatedEntityId?: string;
};

export type RecallInput = {
  actor: ActorContext;
  scope?: string;
  query?: string;
  limit?: number;
};

const PERSONAL_SCOPE_RE = /^personal:(.+)$/;
const DEPARTMENT_SCOPE_RE = /^department:(.+)$/;

export function createMemoryService(prisma: PrismaClient) {
  async function remember(input: RememberInput): Promise<MemoryRecord> {
    const content = String(input.content || '').trim();
    if (!content) throw new Error('MEMORY_CONTENT_REQUIRED: content 不能为空');
    if (!input.actor.memoryScopes.includes(input.scope)) {
      throw new Error(`MEMORY_SCOPE_NOT_ALLOWED: scope ${input.scope} 不在当前角色可写范围内`);
    }
    const userId = PERSONAL_SCOPE_RE.exec(input.scope)?.[1] ?? null;
    const departmentId = DEPARTMENT_SCOPE_RE.exec(input.scope)?.[1] ?? null;
    return prisma.agentMemory.create({
      data: {
        id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        userId,
        departmentId,
        scope: input.scope,
        memoryType: input.memoryType,
        content,
        summary: input.summary ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        relatedEntity: input.relatedEntity ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        status: 'active',
      },
    }) as Promise<MemoryRecord>;
  }

  async function recall(input: RecallInput): Promise<MemoryRecord[]> {
    const allowedScopes = new Set(input.actor.memoryScopes);
    const scopes = input.scope
      ? (allowedScopes.has(input.scope) ? [input.scope] : [])
      : Array.from(allowedScopes);
    if (!scopes.length) return [];
    return prisma.agentMemory.findMany({
      where: {
        scope: { in: scopes },
        status: 'active',
        deletedAt: null,
        ...(input.query ? { content: { contains: input.query } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(input.limit ?? 20, 1), 100),
    }) as Promise<MemoryRecord[]>;
  }

  async function stats(): Promise<{ memories: number; scopes: number }> {
    const [memories, scopeRows] = await Promise.all([
      prisma.agentMemory.count({ where: { status: 'active', deletedAt: null } }),
      prisma.agentMemory.groupBy({ by: ['scope'], where: { status: 'active', deletedAt: null } }),
    ]);
    return { memories, scopes: scopeRows.length };
  }

  return { remember, recall, stats };
}
