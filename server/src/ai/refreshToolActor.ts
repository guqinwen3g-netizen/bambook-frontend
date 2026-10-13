import type { PrismaClient } from '@prisma/client';
import type { ActorContext } from '../agent/types';
import { createIdentityService } from '../agent/identity';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';

/** Long-running conversations and approval waits are not an authorization cache. */
export async function refreshToolActor(prisma: PrismaClient, prior: ActorContext, options: {
  userId: string; requestSource?: 'user-session' | 'api-key' | 'dev'; permissionCeiling?: string[];
}): Promise<ActorContext> {
  if (!options.userId || prior.userId !== options.userId) throw new Error('AGENT_ACTOR_SUBJECT_MISMATCH');
  const user = await loadUserWithRoles(prisma, options.userId);
  if (!user || user.status !== 'active' || user.deletedAt != null) throw new Error('AGENT_ACCOUNT_INACTIVE');
  const current = await buildLoadedAuthTokenPayload(prisma, user);
  let permissions = current.permissions ?? [];
  if (options.requestSource === 'api-key') {
    // The trusted initiating key snapshot is an upper bound for this run. A
    // later personnel grant must not expand an already-running key session.
    const ceiling = options.permissionCeiling ?? [];
    permissions = ceiling.includes('*') ? permissions : permissions.filter(scope => ceiling.includes(scope));
  }
  const actor = await createIdentityService().resolveActorContext({
    userId: current.userId, displayName: current.displayName, roles: current.roles,
    roleIds: current.roleIds, departmentIds: current.departmentIds,
    permissions, authorizationLoaded: true,
  });
  return options.requestSource === 'api-key' ? { ...actor, permissionCeiling: [...(options.permissionCeiling ?? [])] } : actor;
}
