import { ActorContext, KnowledgeAccessTarget, PolicyDecision, ToolAccessTarget } from './types';
import { authorizeToolAction, isTechnicalSuperAdmin } from './toolAuthorization';

const HIGH_RISK_APPROVERS = new Set(['owner', 'admin', 'manager']);

export function createPolicyService() {
  function canAccessKnowledge(actor: ActorContext, target: KnowledgeAccessTarget): boolean {
    const scopes = target.scopes?.length ? target.scopes : ['company'];
    return scopes.some(scope => actor.knowledgeScopes.includes(scope) || actor.departmentIds.includes(scope));
  }

  function canUseTool(actor: ActorContext, target: ToolAccessTarget): PolicyDecision {
    if (actor.permissionsAuthoritative === true) {
      // A trusted snapshot is an action-level grant, including an empty/revoked
      // snapshot. Domain membership or approval cannot restore a missing write.
      const action = authorizeToolAction(actor, target);
      if (!action.allowed) return { allowed: false, requiresApproval: false, reason: action.reason };
    } else if (!isTechnicalSuperAdmin(actor) && !actor.toolScopes.includes(target.scope)) {
      // Old actors without a trusted snapshot retain the pre-existing domain
      // contract. Do not reinterpret derived default permissionScopes as loaded.
      return { allowed: false, requiresApproval: false, reason: 'ROLE_NOT_ALLOWED' };
    }

    if (target.risk === 'high' && !actor.roles.some(role => HIGH_RISK_APPROVERS.has(role))) {
      return { allowed: true, requiresApproval: true, reason: 'APPROVAL_REQUIRED' };
    }

    return { allowed: true, requiresApproval: false };
  }

  return { canAccessKnowledge, canUseTool };
}
