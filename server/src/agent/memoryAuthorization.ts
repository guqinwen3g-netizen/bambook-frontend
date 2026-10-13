import type { PrismaClient } from '@prisma/client';
import { legacyAgentRoleForId } from '../auth/permissionService';
import type { ActorContext } from './types';
import { createMemoryService } from './memory';

/** Both public runtime paths share this dispatch; callers record their own
 * single AgentToolRun. This helper performs no separate tool-run logging. */
export async function executeActorMemoryTool(prisma: PrismaClient, actor: ActorContext, toolId: string, input: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
  const service = createMemoryService(prisma);
  if (toolId === 'memory.recall') return { ok: true, memories: await service.recall({ actor, scope: input.scope ? String(input.scope) : undefined, query: input.query ? String(input.query) : undefined, limit: input.limit != null ? Number(input.limit) : undefined }) };
  const scope = String(input.scope || `personal:${actor.userId}`);
  const memoryActor = await authorizeMemoryWriteActor(prisma, actor, scope);
  const record = await service.remember({ actor: memoryActor, scope, memoryType: String(input.memoryType || 'fact'), content: String(input.content || ''), summary: input.summary ? String(input.summary) : undefined, sourceType: 'agent_tool', sourceId: sessionId });
  return { ok: true, memory: { id: record.id, scope: record.scope, memoryType: record.memoryType } };
}

/** Existing shared memory contract is authenticated company membership and
 * actual role/department membership, not a newly invented permission matrix.
 * Recheck on each shared write so old token/approval scopes cannot survive a
 * role removal, department move or deactivation. Input never supplies identity. */
export async function authorizeMemoryWriteActor(prisma: PrismaClient, actor: ActorContext, scope: string): Promise<ActorContext> {
  if (scope === `personal:${actor.userId}` && actor.memoryScopes.includes(scope)) return actor;
  if (!actor.memoryScopes.includes(scope) || scope.startsWith('personal:')) throw new Error('MEMORY_SCOPE_NOT_ALLOWED');
  try {
    const account = await prisma.userAccount.findFirst({
      where: { id: actor.userId, status: 'active', deletedAt: null },
      select: {
        id: true, status: true, deletedAt: true,
        primaryDepartment: { select: { id: true, status: true } },
        roles: { select: { roleId: true, department: { select: { id: true, status: true } } } },
      },
    });
    if (!account || account.id !== actor.userId || account.status !== 'active' || account.deletedAt != null) throw new Error('MEMORY_ACTIVE_ACCOUNT_REQUIRED');
    const currentScopes = new Set<string>([`personal:${actor.userId}`, 'company']);
    if (account.primaryDepartment?.status === 'active') currentScopes.add(`department:${account.primaryDepartment.id}`);
    for (const membership of account.roles) {
      const role = legacyAgentRoleForId(membership.roleId);
      if (role) currentScopes.add(`role:${role}`);
      if (membership.department?.status === 'active') currentScopes.add(`department:${membership.department.id}`);
    }
    if (!currentScopes.has(scope)) throw new Error('MEMORY_CURRENT_MEMBERSHIP_REQUIRED');
    return { ...actor, memoryScopes: actor.memoryScopes.filter(value => currentScopes.has(value)) };
  } catch (error: any) {
    if (String(error?.message).startsWith('MEMORY_')) throw error;
    throw new Error('MEMORY_AUTHORIZATION_UNAVAILABLE');
  }
}
