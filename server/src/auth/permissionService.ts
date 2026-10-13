import { departmentAuthorization } from './departmentAuthorization';
/**
 * permissionService.ts — Phase 0-02 权限服务层（不含 Express 中间件，纯函数+Prisma 查询）
 *
 * ═══════════════════════════════════════════════════════════════════
 * 消费方：
 *   1. auth/route.ts 登录 — getUserPermissionContext → 写入 JWT（scopes 放进 permissions[]，
 *      legacyRoleCodes 放进 roles[] 保证旧 requireRole('owner','admin') 68 处调用持续可用）
 *   2. auth/route.ts GET /permissions — 前端拉取完整上下文
 *   3. permissionGuard.ts (requirePermission 中间件) — hasScope() 实时判断
 *   4. 各业务路由 handler — getDataScopeResolver() 拼 Prisma where 实现 PL-2B 行级过滤
 *   5. 各业务路由 handler — stripSensitive() 输出前遮罩成本/利润/佣金等敏感字段
 * ═══════════════════════════════════════════════════════════════════
 *
 * 向后兼容说明：
 *   - 旧系统用 AgentRole = 'owner'|'admin'|'manager'|'finance'|'sales'|... 字符串
 *   - 新系统用 SYSTEM_ROLE_IDS = 'role-super-admin'|...（8 角色，DR-041 起含 QC/后勤）
 *   - ROLE_ID_TO_LEGACY_AGENT_ROLE 表把新 8 ID 映射到旧字符串，
 *     JWT roles[] 中依旧写旧字符串，不破坏 68 处 requireRole()/roles.some() 调用。
 *   - 以后可逐步把旧 HIGH_RISK_ROLES: AgentRole[] = ['owner','admin','manager']
 *     迁移到 requirePermission('xxx:write') 基于 scope 的更精确校验。
 */
import type { PrismaClient } from '@prisma/client';
import type { AgentRole } from '../agent/types';
import type { TokenPayload } from './service';
import { businessError } from '../shared/errorCodes';

// 单一权威真源从 server/src/_shared/rolePermissionMatrix.ts 引用（与 seed 脚本 & 前端共用同一文件内容，
// 通过快照副本绕过 tsconfig rootDir 限制；权威源仍为根 lib/rolePermissionMatrix.ts）
import {
  SYSTEM_ROLE_IDS,
  type PermissionScope,
  type DataScopeRule,
  type SensitiveFieldScope,
  hasPermission as fallbackHasPermission,
  getDataScopeRule,
} from '../_shared/rolePermissionMatrix';

// v2.1（DR-042 §5.1）：department 行级规则保留原部门维解析的模块白名单。
// 人事编制域的部门维视野有独立业务意义（主管看本部门员工档案/考勤/编制），
// 不随业务数据域「组为主、部门退出」的口径切换收敛。
const DEPT_SCOPE_EXEMPT_MODULES = new Set(['hr']);

// ───────────────────────────────────────────────────────────────────
// 新 7 角色 ID → 旧 AgentRole 字符串（向后兼容映射，保持旧 HIGH_RISK_ROLES 判断有效）
//   旧语义：owner=最高权限  admin=系统管理员  manager=业务审批/经理级  finance=财务
//   新→旧映射原则：保持 68 处调用的语义不变（HIGH_RISK 路由不能被 sales 直接写）
//   DR-041：QC → viewer（质检写权限走新 scope qc:write，legacy 层不给任何写路由通过）
//           LOGISTICS → logistics（legacy logistics 不在任何 HIGH_RISK 组，写权限走新 scope）
//   GAP-R11：FINANCE_MANAGER 已删除（原映射 finance 与 FINANCE 相同，无行为变化）
// ───────────────────────────────────────────────────────────────────
export const ROLE_ID_TO_LEGACY_AGENT_ROLE: Record<string, AgentRole> = {
  [SYSTEM_ROLE_IDS.SUPER_ADMIN]: 'owner',       // 最高 → owner（所有 HIGH_RISK 组都包含 owner ✓）
  [SYSTEM_ROLE_IDS.ADMIN]: 'admin',             // 系统管理员 → admin（owner/admin 类路由通过 ✓）
  [SYSTEM_ROLE_IDS.SALES_MANAGER]: 'manager',   // 销售主管 → manager（业务写审批路由用 ['owner','admin','manager'] ✓）
  [SYSTEM_ROLE_IDS.FINANCE]: 'finance',         // 财务 → finance（finance 模块 HIGH_RISK 含 finance ✓）
  [SYSTEM_ROLE_IDS.SALES]: 'sales',             // 业务员 → sales（写路由 HIGH_RISK 不含 sales → 保持被拒 ✓）
  [SYSTEM_ROLE_IDS.QC]: 'viewer',               // QC → viewer（legacy 层只读；qc:write 走新 scope 链 ✓）
  [SYSTEM_ROLE_IDS.LOGISTICS]: 'logistics',     // 后勤 → logistics（legacy 层非 HIGH_RISK；shipments:write 走新 scope 链 ✓）
};

const LEGACY_AGENT_ROLE_IDS = new Set<AgentRole>([
  'owner', 'admin', 'manager', 'finance', 'sales', 'merchandiser', 'logistics',
  'production_manager', 'factory', 'agent_operator', 'viewer',
]);

/** Role identity is canonical; an arbitrary custom Role.name cannot create leadership authority. */
export function legacyAgentRoleForId(roleId: string): AgentRole | undefined {
  const mapped = Object.prototype.hasOwnProperty.call(ROLE_ID_TO_LEGACY_AGENT_ROLE, roleId)
    ? ROLE_ID_TO_LEGACY_AGENT_ROLE[roleId] : undefined;
  return mapped
    ?? (LEGACY_AGENT_ROLE_IDS.has(roleId as AgentRole) ? roleId as AgentRole : undefined);
}

// ───────────────────────────────────────────────────────────────────
// 类型定义
// ───────────────────────────────────────────────────────────────────
export interface UserPermissionContext {
  userId: string;
  /** 新系统角色 ID（SYSTEM_ROLE_IDS 值，8 枚举之一或更多） */
  roleIds: string[];
  /** 旧 AgentRole 字符串（用于写入 JWT roles[] 向后兼容 requireRole('owner', ...)） */
  legacyRoleCodes: AgentRole[];
  /** 所有权限 scope（DB 聚合）— 直接给 JWT/前端，hasScope 优先走这个集合 */
  scopes: string[];
  businessAttributes: string[];
  globalBusinessScope: boolean;
  /** Set only after the current DB role and personal-grant queries succeed. */
  authorizationLoaded: true;
  /** 用户分配的部门 ID（来自 UserRole.departmentId） */
  departmentIds: string[];
  /** 主部门 */
  primaryDeptId?: string | null;
  /** 扁平化：部门 + 所有子部门后代 ID（SalesManager 含 includeDescendantDepartments=true 时需要） */
  departmentSubtreeIds: string[];
}

type ScopeArg = PermissionScope | PermissionScope[];

export interface PermissionServiceOptions {
  prisma: PrismaClient;
}

// ───────────────────────────────────────────────────────────────────
// 敏感字段遮罩常量（根据字段类型决定遮罩策略）
// ───────────────────────────────────────────────────────────────────
const SENSITIVE_MASK_STRING = '****';
const SENSITIVE_MASK_NUMBER = null as unknown as number; // 数字用 null，前端再决定是否渲染为 "****"

/**
 * Common current-DB scope projection. Callers supply scopes from a successful
 * role-permission query (including custom roles). Personal grants are additive;
 * inactive, deleted and expired rows cannot authorize login, refresh or Agents.
 * Query failures propagate: an unknown grant set is never an empty loaded set.
 */
export async function loadEffectivePermissionScopes(
  prisma: Pick<PrismaClient, 'userPermissionOverrides'>,
  userId: string,
  roleScopes: Iterable<string>,
): Promise<string[]> {
  const scopes = new Set(Array.from(roleScopes).filter(Boolean));
  const overrides = await prisma.userPermissionOverrides.findMany({
    where: {
      userId, isActive: true, deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { scope: true },
  });
  for (const grant of overrides) if (grant.scope) scopes.add(grant.scope);
  return Array.from(scopes).sort();
}

function isSuperAdminActor(actor: TokenPayload): boolean {
  return !!actor.roles?.some(role => role === 'owner'
    || role === (SYSTEM_ROLE_IDS.SUPER_ADMIN as unknown as AgentRole));
}

/** Pure shared scope decision: no Prisma construction or DB access. */
export function hasScope(actor: TokenPayload | null | undefined, scope: PermissionScope): boolean {
  if (!actor) return false;
  if (actor.permissionCeiling && !actor.permissionCeiling.includes('*') && !actor.permissionCeiling.includes(scope)) return false;
  // Existing technical SuperAdmin shortcut, not a business approval policy.
  if (isSuperAdminActor(actor)) return true;
  if (actor.authorizationLoaded === true || (actor.permissions?.length ?? 0) > 0) {
    return actor.permissions?.includes(scope) ?? false;
  }
  // Old tokens with no marker and empty/missing scopes retain compatibility.
  const roleIdsFromLegacy = (actor.roles || []).flatMap(role => LEGACY_TO_ROLE_ID[role] || []);
  return fallbackHasPermission(roleIdsFromLegacy, scope);
}

// ───────────────────────────────────────────────────────────────────
// 服务工厂（依赖注入 PrismaClient，与业务路由一致风格）
// ───────────────────────────────────────────────────────────────────
export function createPermissionService(opts: PermissionServiceOptions) {
  const { prisma } = opts;

  // ══════════════════════════════════════════════════════════════════
  // 0. 内部辅助：递归取 dept 子树（BFS 迭代，避免 PG 递归 CTE 复杂度）
  // ══════════════════════════════════════════════════════════════════
  async function collectSubtreeDeptIds(rootIds: string[]): Promise<string[]> {
    if (rootIds.length === 0) return [];
    const seen = new Set<string>(rootIds);
    let frontier = Array.from(rootIds);
    // 最大深度 8（组织架构树正常 <5 层；避免脏数据死循环）
    for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
      const children = await prisma.department.findMany({
        where: { parentId: { in: frontier }, status: 'active' },
        select: { id: true },
      });
      frontier = [];
      for (const c of children) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          frontier.push(c.id);
        }
      }
    }
    return Array.from(seen);
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. 从 DB 加载用户完整权限上下文
  //    调用时机：登录、刷新权限、GET /api/auth/permissions
  // ══════════════════════════════════════════════════════════════════
  async function getUserPermissionContext(userId: string): Promise<UserPermissionContext | null> {
    const user = await prisma.userAccount.findUnique({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        primaryDeptId: true,
        primaryDepartment: true,
        status: true,
        roles: {
          select: {
            departmentId: true,
            role: {
              select: {
                id: true,
                permissions: { select: { permission: { select: { scope: true } } } },
              },
            },
          },
        },
      },
    });
    if (!user || user.status !== 'active') return null;

    const roleIds: string[] = [];
    const roleScopes = new Set<string>();
    const directDeptIds = new Set<string>([user.primaryDeptId].filter(Boolean) as string[]);

    for (const ur of user.roles) {
      roleIds.push(ur.role.id);
      if (ur.departmentId) directDeptIds.add(ur.departmentId);
      for (const rp of ur.role.permissions) {
        const scope = rp.permission.scope;
        if (scope) roleScopes.add(scope);
      }
    }

    const granted = await loadEffectivePermissionScopes(prisma, user.id, roleScopes);
    const { permissions: scopes, businessAttributes, globalBusinessScope } = departmentAuthorization(user, roleIds, granted);

    // SuperAdmin 安全网：即使 DB 中 scope 缺失，也补齐全部 scope（避免 seed 未完整跑导致全权限用户被意外拦截）
    if (roleIds.includes(SYSTEM_ROLE_IDS.SUPER_ADMIN)) {
      // fallbackHasPermission 对 SuperAdmin 直接放行，所以这里不用手动枚举 scopes，保持 DB 结果即可
      // （不影响守卫判断）
    }

    const legacyRoleCodes = dedupe(
      roleIds.map(legacyAgentRoleForId).filter(Boolean) as AgentRole[],
    );

    const departmentIds = Array.from(directDeptIds);
    const departmentSubtreeIds = await collectSubtreeDeptIds(departmentIds);

    return {
      userId: user.id,
      roleIds,
      legacyRoleCodes,
      scopes, businessAttributes, globalBusinessScope,
      authorizationLoaded: true,
      departmentIds,
      primaryDeptId: user.primaryDeptId,
      departmentSubtreeIds,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. Scope 判断（运行时；JWT 中已有 permissions，避免每次查DB）
  // ══════════════════════════════════════════════════════════════════
  function hasAnyScope(actor: TokenPayload | null | undefined, scopes: PermissionScope[]): boolean {
    if (!scopes || scopes.length === 0) return true;
    return scopes.some((s) => hasScope(actor, s));
  }

  function ensureScope(actor: TokenPayload | null | undefined, scopeArg: ScopeArg): void {
    const scopes = (Array.isArray(scopeArg) ? scopeArg : [scopeArg]) as PermissionScope[];
    if (!hasAnyScope(actor, scopes)) {
      const err = new Error(`FORBIDDEN: 缺少权限 ${scopes.join('|')}`);
      (err as any).code = 'INSUFFICIENT_PERMISSION';
      (err as any).status = 403;
      throw err;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. 行级数据范围解析器（返回给调用方拼 Prisma where）
  //    PL-2B：同部门可见/跨部门隔离
  // ══════════════════════════════════════════════════════════════════
  interface DataScopeResolver {
    rule: DataScopeRule;
    /** 允许的部门 ID（含子部门）— 用于有 direct departmentId FK 的实体过滤 */
    allowedDepartmentIds?: string[];
    /** 允许的用户 ID（部门内所有员工 id）— 用于 createdBy/salesPersonId/ownerId 等 creator 字段过滤 */
    allowedUserIds?: string[];
    /**
     * 允许的小组 ID（§10.4.1「团队 = 系统里配的小组」）— 用于按组维度过滤
     * （如 TeamDataGrant 共享、teamId FK）；team 规则下恒有值。
     */
    allowedTeamIds?: string[];
  }

  /** 本人在册的小组 id（小组本身未软删）。模型缺失/查询失败一律视为无组，绝不放大视野。 */
  async function resolveActiveTeamIds(userId: string): Promise<string[]> {
    try {
      const rows = await (prisma as any).teamMember.findMany({
        where: { userId, leftAt: null, team: { deletedAt: null } },
        select: { teamId: true },
      });
      return Array.from(new Set((rows ?? []).map((r: any) => r.teamId).filter(Boolean)));
    } catch {
      return [];
    }
  }

  /** 小组在册成员 id ∪ 本人（去重、去空） */
  async function resolveTeamMemberIds(teamIds: string[], selfUserId: string): Promise<string[]> {
    try {
      const rows = await (prisma as any).teamMember.findMany({
        where: { teamId: { in: teamIds }, leftAt: null },
        select: { userId: true },
      });
      return Array.from(new Set([...(rows ?? []).map((r: any) => r.userId), selfUserId].filter(Boolean)));
    } catch {
      return [selfUserId]; // 查询失败也不能把人挡在自己数据之外
    }
  }


  async function getDataScopeResolver(
    actor: TokenPayload | null | undefined,
    moduleName: string,
  ): Promise<DataScopeResolver> {
    if (!actor) {
      return { rule: { kind: 'self' }, allowedDepartmentIds: [], allowedUserIds: [] };
    }
    if (!actor.userId) throw businessError('UNAUTHORIZED', '数据范围查询需要有效的用户主体。');
    if (actor.permissionCeiling?.length === 0) throw businessError('FORBIDDEN', '当前凭据没有数据读取或操作权限。');
    // JWT/API-key authenticate the subject; only current stored role identities
    // select L2 rules. Legacy token fields/names/loaded markers cannot restore a
    // withdrawn role, and viewer must never reverse-map to the QC identity.
    let current: UserPermissionContext | null;
    try { current = await getUserPermissionContext(actor.userId); }
    catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前数据范围，请稍后重试。'); }
    if (!current) throw businessError('ACCOUNT_DISABLED', '当前账号不可用，请重新登录。');
    // Real stored legacy role IDs keep their existing explicit mapping. Custom
    // IDs retain the matrix's self default; arbitrary Role.name is not authority.
    const roleIdsFromLegacy = current.roleIds.flatMap(roleId => LEGACY_TO_ROLE_ID[roleId] || [roleId]);
    // 以最高权限角色的 rule 为准（SuperAdmin=all 优先）— 取第一个非 self 的角色
    let rule: DataScopeRule = { kind: 'self' };
    if (roleIdsFromLegacy.includes(SYSTEM_ROLE_IDS.SUPER_ADMIN)) {
      rule = { kind: 'all' };
    } else {
      for (const rid of roleIdsFromLegacy) {
        const r = getDataScopeRule(rid, moduleName);
        if (r.kind === 'all') { rule = r; break; }
        if (r.kind !== 'self') rule = r; // 取第一个非 self 的更宽规则
      }
    }

    if (rule.kind === 'all') {
      return { rule }; // 无过滤 = 全可见
    }

    // v2.1（DR-042 §5.1 组为主）：业务数据模块的 department 规则统一按本人维解析——
    // 协作维度由小组（TeamDataGrant ∪ 本人）承载，部门退出数据权限计算
    // （保留目录展示 + DR-007 审批链用途）。人事编制域（hr）的部门维视野有独立
    // 业务意义（主管看本部门员工档案/考勤），保留原 department 解析。
    if (rule.kind === 'department' && !DEPT_SCOPE_EXEMPT_MODULES.has(moduleName)) {
      return { rule: { kind: 'self' }, allowedUserIds: [actor.userId] };
    }

    if (rule.kind === 'self') {
      return { rule, allowedUserIds: [actor.userId] };
    }

    // §10.4.1（2026-09-12 定案）：团队档 = 系统里配的小组（Team/TeamMember），
    // 不是「同部门」。此前 team 只在类型里声明、从未解析，业务员实际被 department
    // 降级成 self，于是同组同事互相看不见——这是三档数据范围里缺失的那一档。
    // 解析口径：本人在册（leftAt=null）的小组 → 组内全体在册成员 ∪ 本人。
    // 「按单分配」是**实体级**授权（TeamDataGrant: entityType+entityId），无法归入
    // 通用 userId 集合，由各域在实体维度 union（relations 域已有 resolveVisibleRelationIds）。
    if (rule.kind === 'team') {
      const teamIds = await resolveActiveTeamIds(actor.userId);
      if (teamIds.length === 0) return { rule, allowedTeamIds: [], allowedUserIds: [actor.userId] };
      const memberIds = await resolveTeamMemberIds(teamIds, actor.userId);
      return { rule, allowedTeamIds: teamIds, allowedUserIds: memberIds };
    }

    // department（可能含子部门）
    let deptIds = current.departmentIds;
    if (rule.kind === 'department' && rule.includeDescendantDepartments && deptIds.length > 0) {
      deptIds = await collectSubtreeDeptIds(Array.from(new Set(deptIds)));
    }
    // 然后查这些部门的 userId（active 状态）
    const usersInDept = deptIds.length > 0
      ? await prisma.userAccount.findMany({
          where: { deletedAt: null, status: 'active', primaryDeptId: { in: deptIds } },
          select: { id: true },
        })
      : [];
    const allowedUserIds = usersInDept.map((u) => u.id);
    if (rule.kind === 'department' && rule.own && !allowedUserIds.includes(actor.userId)) {
      allowedUserIds.push(actor.userId);
    }
    return {
      rule,
      allowedDepartmentIds: deptIds,
      allowedUserIds,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. 敏感字段遮罩（读接口返回前调用）
  //    - 字符串字段：显示 "****"
  //    - 数字字段：null（前端可根据 null 渲染 "****" 或隐藏数字）
  //    - 对象/数组字段：null
  // ══════════════════════════════════════════════════════════════════
  function stripSensitive<T extends Record<string, any>>(
    entity: T,
    sensitiveMap: Partial<Record<keyof T, SensitiveFieldScope>>,
    actor: TokenPayload | null | undefined,
  ): T {
    if (!entity) return entity;
    // Every field uses hasScope, including the initiating credential ceiling.
    const copy: Record<string, any> = { ...entity };
    const keys = Object.keys(sensitiveMap) as (keyof T & string)[];
    for (const k of keys) {
      const scopeName = sensitiveMap[k];
      if (!scopeName) continue;
      const visible = canViewSensitiveField(actor, scopeName);
      if (!visible && copy[k] !== undefined && copy[k] !== null) {
        const v = copy[k];
        if (typeof v === 'string') copy[k] = SENSITIVE_MASK_STRING;
        else if (typeof v === 'number') copy[k] = SENSITIVE_MASK_NUMBER;
        else copy[k] = null; // object/array/bigint → null
      }
    }
    return copy as T;
  }

  function stripSensitiveMany<T extends Record<string, any>>(
    list: T[],
    sensitiveMap: Partial<Record<keyof T, SensitiveFieldScope>>,
    actor: TokenPayload | null | undefined,
  ): T[] {
    return list.map((x) => stripSensitive(x, sensitiveMap, actor));
  }

  function canViewSensitiveField(
    actor: TokenPayload | null | undefined,
    field: SensitiveFieldScope,
  ): boolean {
    if (!actor) return false;
    const scopeName = `sensitive:${field}` as PermissionScope;
    return hasScope(actor, scopeName);
  }

  return {
    getUserPermissionContext,
    hasScope,
    hasAnyScope,
    ensureScope,
    getDataScopeResolver,
    stripSensitive,
    stripSensitiveMany,
    canViewSensitiveField,
    // Internal (exposed for testing)
    _internal_collectSubtreeDeptIds: collectSubtreeDeptIds,
    /**
     * B86 探针用：legacy 角色 → 新角色 id 的映射。
     * 导出它不是为了"让测试能改实现"，而是为了让探针**从真源反查**一个 (legacy 角色, 默认矩阵为 true 的 scope)
     * 配对 —— 把名字写死在测试里 = 下次映射一改，探针就变成一条谁都不会红的死断言。
     */
    _internal_legacyToRoleId: LEGACY_TO_ROLE_ID,
  };
}

// ───────────────────────────────────────────────────────────────────
// 反向映射：legacy AgentRole string → 新 SYSTEM_ROLE_IDS（用于 hasScope fallback）
// 最小权限原则（W-C 安全修复）：fallback 默认矩阵只授予与该 legacy 角色语义相符的
// 新角色默认权限；无对应新角色的 legacy 角色（viewer/factory/production_manager）
// 不再降级为 SALES——此前 viewer/factory 老 JWT 会在 fallback 路径获得业务员完整
// 默认矩阵（含 orders:write 等写 scope），属越权放大。映射为空 = 仅消费 JWT/DB
// 已聚合的 permissions（login 链路对新角色用户照常生效，不受本表影响）。
// GAP-R11：finance 不再映射已删除的 FINANCE_MANAGER。
// ───────────────────────────────────────────────────────────────────
const LEGACY_TO_ROLE_ID: Record<string, string[]> = {
  owner: [SYSTEM_ROLE_IDS.SUPER_ADMIN],
  admin: [SYSTEM_ROLE_IDS.ADMIN],
  manager: [SYSTEM_ROLE_IDS.SALES_MANAGER],
  finance: [SYSTEM_ROLE_IDS.FINANCE],
  sales: [SYSTEM_ROLE_IDS.SALES],
  merchandiser: [SYSTEM_ROLE_IDS.SALES],   // 跟单员语义≈业务员（保留）
  logistics: [SYSTEM_ROLE_IDS.LOGISTICS],  // 对齐新后勤角色
  // 无新角色容器 → 空映射（最小权限）：viewer 只读语义 / factory 工厂 / production_manager 生产
  viewer: [],
  factory: [],
  production_manager: [],
};

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
