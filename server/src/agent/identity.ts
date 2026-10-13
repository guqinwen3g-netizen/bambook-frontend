import { ActorContext, ActorContextInput, AgentRole } from './types';
import {
  SYSTEM_ROLE_IDS,
  DEFAULT_ROLE_PERMISSION_MATRIX,
  getDefaultScopeListForRole,
  type SystemRoleId,
} from '../_shared/rolePermissionMatrix';
import { P0B_TOOL_DEFINITIONS } from './toolRegistry';

/**
 * W-C 批三-F 根修：resolveActorContext 的输入扩展新 RBAC 角色 ID。
 * 本地交叉类型（不改 types.ts 租约）：调用方携带 roleIds 时 toolScopes 改由权限矩阵派生；
 * 未携带（legacy-only actor）时保持 ROLE_SCOPES fallback 不变。
 */
export type ResolveActorContextInput = ActorContextInput & {
  /** 新 RBAC 系统角色 ID（SYSTEM_ROLE_IDS 值，如 'role-qc'）；自定义角色 ID 在矩阵无条目时 fail-closed */
  roleIds?: string[];
  permissionCeiling?: string[];
};

const ROLE_SCOPES: Record<AgentRole, { permissions: string[]; knowledge: string[]; tools: string[] }> = {
  owner: {
    permissions: ['admin', 'knowledge:manage', 'tool:approve', 'memory:company:write'],
    knowledge: ['company', 'owner', 'admin', 'products'],
    tools: ['admin', 'finance', 'orders', 'relations', 'products', 'knowledge', 'automation', 'memory'],
  },
  admin: {
    permissions: ['admin', 'knowledge:manage', 'tool:approve'],
    knowledge: ['company', 'admin', 'products'],
    tools: ['admin', 'finance', 'orders', 'relations', 'products', 'knowledge', 'automation', 'memory'],
  },
  manager: {
    permissions: ['team:read', 'tool:approve'],
    knowledge: ['company', 'department', 'products'],
    tools: ['orders', 'relations', 'products', 'knowledge', 'automation', 'memory'],
  },
  merchandiser: {
    permissions: ['orders:read', 'orders:draft'],
    knowledge: ['company', 'orders', 'suppliers', 'products'],
    tools: ['orders', 'relations', 'products', 'memory'],
  },
  finance: {
    permissions: ['finance:read', 'invoice:draft'],
    knowledge: ['company', 'finance', 'products'],
    tools: ['finance', 'orders', 'products', 'memory'],
  },
  sales: {
    permissions: ['sales:read', 'customer:draft'],
    knowledge: ['company', 'sales', 'customers', 'products'],
    tools: ['orders', 'relations', 'products', 'memory'],
  },
  viewer: {
    permissions: ['read'],
    knowledge: ['company', 'products'],
    tools: ['read', 'products', 'memory'],
  },
  agent_operator: {
    permissions: ['automation:run'],
    knowledge: ['company', 'products'],
    tools: ['automation', 'read', 'products', 'memory'],
  },
  logistics: {
    permissions: ['read', 'shipping:read', 'shipping:write'],
    knowledge: ['company', 'products', 'shipping'],
    tools: ['read', 'products', 'shipping', 'memory'],
  },
  production_manager: {
    permissions: ['production:read', 'production:write', 'production:sign'],
    knowledge: ['company', 'products', 'production'],
    tools: ['production', 'orders', 'products', 'memory'],
  },
  factory: {
    permissions: ['production:read', 'production:write'],
    knowledge: ['company', 'products', 'production'],
    tools: ['production', 'products', 'memory'],
  },
};

/**
 * 全部已注册工具域（toolRegistry P0B_TOOL_DEFINITIONS 真源派生）。
 * 注册表扩张自动跟随——禁止手写清单（手写清单即 ROLE_SCOPES 滞后缺口的发源地）。
 */
function allRegisteredToolDomains(): string[] {
  return unique(P0B_TOOL_DEFINITIONS.map(def => def.scope));
}

/**
 * 矩阵 scope 前缀 → 工具域别名（拼写差归一，W-C 批三-F 收尾）。
 * 根源：矩阵域命名（emails/shipments/sample/order）与 toolRegistry 工具域
 * （email/shipping/samples/orders）历史拼写不一致；development 工具域无对应
 * 矩阵 scope——按 VIEW_TO_MAIN_SCOPES 真源 Development 属 products 域映射。
 * 仅做「矩阵域 → 工具域」单向加宽，不收缩任何已派生域。
 */
const MATRIX_TO_TOOL_DOMAIN_ALIASES: Record<string, string[]> = {
  emails: ['email'],
  shipments: ['shipping'],
  sample: ['samples'],
  exception: ['exceptions'],
  order: ['orders'],
  products: ['development'],
};

/**
 * W-C 批三-F 根修：toolScopes 不再手写——从新 roleId 经权限矩阵默认 scope 表派生
 * （'qc:write' → 'qc' 前缀域集合）+ 'read' + 'memory'，与视图层 VIEW_TO_MAIN_SCOPES 派生同哲学。
 *   - SUPER_ADMIN → 全部已注册工具域（与 hasPermission 的 SUPER_ADMIN 特判同哲学，
 *     覆盖 emails/sample(s)/exception(s)/shipping/development/automation 等矩阵 scope 前缀
 *     与工具域拼写不一致的域）；
 *   - 自定义角色（矩阵无条目）fail-closed：仅 read/memory；
 *   - 域门是粗粒度门禁：读工具按域放行，写工具由 policy.canUseTool 的 HIGH_RISK_APPROVERS
 *     审批闸 + toolRuntime 的 approvalPolicy='always' 兜底，不在域门重复读/写细分。
 */
function deriveToolScopesFromRoleIds(roleIds: string[]): string[] {
  const domains = new Set<string>(['read', 'memory']);
  for (const roleId of roleIds) {
    if (roleId === SYSTEM_ROLE_IDS.SUPER_ADMIN) {
      for (const domain of allRegisteredToolDomains()) domains.add(domain);
      continue;
    }
    if (!(roleId in DEFAULT_ROLE_PERMISSION_MATRIX)) continue;
    for (const scope of getDefaultScopeListForRole(roleId as SystemRoleId)) {
      const prefix = scope.split(':')[0];
      domains.add(prefix);
      for (const alias of MATRIX_TO_TOOL_DOMAIN_ALIASES[prefix] ?? []) domains.add(alias);
    }
  }
  return Array.from(domains);
}

function deriveToolScopesFromPermissions(permissions: string[]): string[] {
  const domains = new Set<string>();
  for (const scope of permissions) {
    const prefix = scope.split(':')[0];
    domains.add(prefix);
    for (const alias of MATRIX_TO_TOOL_DOMAIN_ALIASES[prefix] ?? []) domains.add(alias);
  }
  return Array.from(domains);
}

export function createIdentityService() {
  async function resolveActorContext(input: ResolveActorContextInput): Promise<ActorContext> {
    const roles: AgentRole[] = input.roles?.length ? input.roles : [];
    const roleIds = input.roleIds?.filter(Boolean) ?? [];
    const permissionsAuthoritative = input.authorizationLoaded === true || Boolean(input.permissions?.length);
    if (!roles.length && !(roleIds.length && permissionsAuthoritative)) {
      throw new Error('ACTOR_ROLES_REQUIRED: Agent execution requires a trusted actor with explicit roles.');
    }
    const departmentIds = input.departmentIds?.length ? input.departmentIds : ['company'];
    const roleScopes = roles.map(role => ROLE_SCOPES[role]).filter(Boolean);

    // W-C 批三-F：actor 已带新 roleIds 时 toolScopes 走矩阵派生（新链路真源）；
    // legacy-only actor（无新 roleIds）保留 ROLE_SCOPES 作 fallback，不得删除。
    const toolScopes = permissionsAuthoritative
      ? deriveToolScopesFromPermissions(input.permissions ?? [])
      : roleIds.length
      ? deriveToolScopesFromRoleIds(roleIds)
      : unique(roleScopes.flatMap(scope => scope.tools));

    return {
      userId: input.userId,
      displayName: input.displayName,
      roles,
      departmentIds,
      permissionScopes: permissionsAuthoritative ? [...(input.permissions ?? [])] : unique(roleScopes.flatMap(scope => scope.permissions)),
      permissionsAuthoritative,
      ...(input.permissionCeiling !== undefined ? { permissionCeiling: [...input.permissionCeiling] } : {}),
      memoryScopes: unique([
        `personal:${input.userId}`,
        ...roles.map(role => `role:${role}`),
        ...departmentIds.map(departmentId => `department:${departmentId}`),
        'company',
      ]),
      knowledgeScopes: unique([
        ...departmentIds,
        ...roleScopes.flatMap(scope => scope.knowledge),
      ]),
      toolScopes,
    };
  }

  return { resolveActorContext };
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
