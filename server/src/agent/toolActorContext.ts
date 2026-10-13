import type { TokenPayload } from '../auth/service';
import type { ActorContext } from './types';

export function toolActorToken(actor: ActorContext): TokenPayload {
  return {
    userId: actor.userId,
    roles: actor.roles,
    permissionCeiling: actor.permissionCeiling,
    departmentIds: actor.departmentIds,
    // Derived legacy defaults are not a loaded permission snapshot.
    permissions: actor.permissionsAuthoritative ? actor.permissionScopes : [],
    ...(actor.permissionsAuthoritative ? { authorizationLoaded: true as const } : {}),
  };
}
