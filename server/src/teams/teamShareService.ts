/**
 * teamShareService.ts — DR-042 小组数据共享服务
 *
 * 设计真源：docs/design/03-业务规则/小组与业务数据共享.md（v2）
 *
 * 职责：
 *   1. 用户所在组解析（每请求直查 + 60s 进程内缓存，§5.2——禁止进 JWT claims）
 *   2. 小组维授权引擎（幂等授权 / 软撤销 / 复活 / 改档，§4 §7）
 *   3. 解散组事务（先批量 revoke 再软删组，§9.2）
 *   4. 访问档位解析（department / team-followup / team-read / none，§6.2）
 *
 * 铁律：
 *   - 数据本体组织归属不变（部门链路），本服务仅表达「共享视图」
 *   - 档案本体永远只归属部门可写：共享只有 read / read+followup 两档，无 write 档
 *   - 授权双重门禁（§6.1）：canManageTeam（组长/销售主管/admin）∧ 对实体有行级写权限
 *   - 物理删组被禁止：解散走事务化软删
 */
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { logger } from '../lib/logger';

// ────────────────────────────────────────────────────────────────────
// 类型与常量
// ────────────────────────────────────────────────────────────────────

export const GRANT_ENTITY_TYPES = ['relation'] as const;
export type GrantEntityType = (typeof GRANT_ENTITY_TYPES)[number];
export const GRANT_PERMISSIONS = ['read', 'read+followup'] as const;
export type GrantPermission = (typeof GRANT_PERMISSIONS)[number];

/** 访问档位（v2.1）：owner=归属人/全权 > team-followup > team-read > none */
export type RelationAccessMode = 'owner' | 'team-followup' | 'team-read' | 'none';

export type TeamShareErrorCode =
  | 'UNAUTHORIZED'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_DISSOLVED'
  | 'ENTITY_NOT_FOUND'
  | 'INVALID_GRANT'
  | 'GRANT_SCOPE_BLOCKED'   // 无该实体行级写权限（T-24）
  | 'SENSITIVE_ENTITY_NOT_SHAREABLE' // v2.2（DR-042 §4.4）：confidential 档案禁止组共享（T-41）
  | 'FORBIDDEN';            // 非组长/主管/admin（T-22/T-23）

export interface TeamShareResult<T = any> {
  ok: boolean;
  data?: T;
  error?: { code: TeamShareErrorCode | 'INTERNAL_ERROR'; message: string };
}

export interface GrantInput {
  entityType: GrantEntityType;
  entityId: string;
  permission: GrantPermission;
}

export interface TeamShareChip {
  grantId: string;
  teamId: string;
  teamName: string;
  permission: GrantPermission;
  grantedBy: string;
  grantedAt: Date;
}

/** 缓存条目：60s TTL（DR-042 §5.2；失效上界即验收线 T-03 的 60s） */
interface UserTeamsCacheEntry {
  teamIds: string[];
  grantedRelationIds: string[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const userTeamsCache = new Map<string, UserTeamsCacheEntry>();

/** Invalidate team data scopes after membership or organization changes. */
export function invalidateTeamMembershipCache(): void {
  userTeamsCache.clear();
}

export const __clearTeamShareCacheForTests = invalidateTeamMembershipCache;

// 可管理小组的角色（§6.1：销售主管/admin/超管；legacy roles 与新 roleIds 双口径）
const MANAGER_LEGACY_ROLES = new Set(['manager', 'owner', 'admin']);
const MANAGER_ROLE_IDS = new Set(['role-sales-manager', 'role-admin', 'role-super-admin']);

function ok<T>(data: T): TeamShareResult<T> { return { ok: true, data }; }
function fail(code: TeamShareErrorCode, message: string): TeamShareResult<never> {
  return { ok: false, error: { code, message } };
}

// ────────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────────
export function createTeamShareService(prisma: PrismaClient) {
  const permSvc = createPermissionService({ prisma });

  // ══════════════════════════════════════════════════════════════
  // 1. 用户所在组 + 授权实体解析（每请求直查 + 60s 缓存，§5.2）
  // ══════════════════════════════════════════════════════════════

  async function loadUserTeamsUncached(userId: string): Promise<{ teamIds: string[]; grantedRelationIds: string[] }> {
    // 用户所在组：未退组（leftAt null）且组未解散（§5.4 失效优先级）
    const memberships = await prisma.teamMember.findMany({
      where: { userId, leftAt: null },
      select: { teamId: true },
    });
    const teamIds = memberships.map(m => m.teamId);
    if (teamIds.length === 0) return { teamIds: [], grantedRelationIds: [] };

    // 生效中的 relation 授权（未撤销 + 组未解散）
    const grants = await prisma.teamDataGrant.findMany({
      where: {
        teamId: { in: teamIds },
        entityType: 'relation',
        revokedAt: null,
        team: { deletedAt: null },
      },
      select: { entityId: true },
    });
    return { teamIds, grantedRelationIds: Array.from(new Set(grants.map(g => g.entityId))) };
  }

  async function getUserTeams(userId: string, options: { fresh?: boolean } = {}): Promise<{ teamIds: string[]; grantedRelationIds: string[] }> {
    // Mutating consumers must not authorize from the optional read cache.
    // A fresh lookup neither consumes nor refreshes that existing cache contract.
    if (options.fresh) return loadUserTeamsUncached(userId);
    const cached = userTeamsCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return { teamIds: cached.teamIds, grantedRelationIds: cached.grantedRelationIds };
    }
    const fresh = await loadUserTeamsUncached(userId);
    userTeamsCache.set(userId, { ...fresh, expiresAt: Date.now() + CACHE_TTL_MS });
    return fresh;
  }

  /** 用户经小组维可见的 relation id 列表（进 buildScopeWhere 的 IN 子句，§5.1） */
  async function getActiveGrantedRelationIds(userId: string, options: { fresh?: boolean } = {}): Promise<string[]> {
    if (!userId) return [];
    return (await getUserTeams(userId, options)).grantedRelationIds;
  }

  // ══════════════════════════════════════════════════════════════
  // 2. 行级写权限判定（v2.2 DR-042 §4.4 读写分离）
  //    写侧解析 rule.write ?? kind：真全权角色（财务/QC/后勤/admin）= all 放行；
  //    sales（all + write:self）= 跟进人（ownerId ∨ salesRepIds）。
  //    §6.1 不变量：有写权限才可共享；也是 L2 业务层「跟进人」锚的实现。
  // ══════════════════════════════════════════════════════════════

  async function hasRelationWriteAccess(actor: TokenPayload, relationId: string): Promise<boolean> {
    const resolver = await permSvc.getDataScopeResolver(actor, 'relations');
    const writeKind = resolveWriteKind(resolver.rule);
    if (writeKind === 'all') return true;
    const rel = await prisma.relation.findFirst({
      where: { id: relationId, deletedAt: null },
      select: { ownerId: true, departmentId: true, salesRepIds: true },
    });
    if (!rel) return false;
    if (writeKind === 'self') {
      // v2.2 跟进人锚（DR-042 §5.1 followedBy）：负责人 ∨ 协作跟进人
      return rel.ownerId === actor.userId
        || (Array.isArray(rel.salesRepIds) && rel.salesRepIds.includes(actor.userId));
    }
    const deptIds = resolver.allowedDepartmentIds || [];
    const userIds = resolver.allowedUserIds || [];
    if (userIds.length > 0 && rel.ownerId && userIds.includes(rel.ownerId)) return true;
    if (userIds.length > 0 && Array.isArray(rel.salesRepIds) && rel.salesRepIds.some((u: string) => userIds.includes(u))) return true;
    if (deptIds.length > 0 && rel.departmentId && deptIds.includes(rel.departmentId)) return true;
    return false;
  }

  /**
   * v2.2 L2 业务读锚（DR-042 §5.1 visibleBiz）：跟进人 ∨ 组共享 ∨ 真全权角色。
   * 消费点：crmRouteV2 子实体读门禁、orderServiceV2 L2 换锚、traceability 全景。
   */
  async function hasBizReadAccess(actor: TokenPayload | null | undefined, relationId: string, options: { fresh?: boolean } = {}): Promise<boolean> {
    if (!actor) return false;
    if (await hasRelationWriteAccess(actor, relationId)) return true; // 跟进人 ∨ all-scope
    const { grantedRelationIds } = await getUserTeams(actor.userId, options);
    return grantedRelationIds.includes(relationId);                   // 组共享（read / read+followup 均可读）
  }

  /**
   * v2.2 L2 可见客户 ID 集（DR-042 §5.1）：followedBy ∪ teamGranted。
   * 消费点：orderServiceV2 列表/详情的 customerRelationId IN 子句。
   */
  async function resolveVisibleRelationIds(actor: TokenPayload | null | undefined, options: { fresh?: boolean } = {}): Promise<string[]> {
    if (!actor) return [];
    const ids = new Set<string>();
    const rels = await prisma.relation.findMany({
      where: {
        deletedAt: null,
        OR: [{ ownerId: actor.userId }, { salesRepIds: { has: actor.userId } }],
      },
      select: { id: true },
    });
    for (const r of rels) ids.add(r.id);
    for (const id of await getActiveGrantedRelationIds(actor.userId, options)) ids.add(id);
    return Array.from(ids);
  }

  // ══════════════════════════════════════════════════════════════
  // 3. 组管理资格判定（§6.1：组长 / 销售主管 / admin / 超管）
  // ══════════════════════════════════════════════════════════════

  function hasManagerRole(actor: TokenPayload): boolean {
    const legacy = (actor.roles || []).some(r => MANAGER_LEGACY_ROLES.has(r as string));
    const rbac = (actor.roleIds || []).some(rid => MANAGER_ROLE_IDS.has(rid));
    return legacy || rbac;
  }

  async function isTeamLeader(actor: TokenPayload, teamId: string): Promise<boolean> {
    // TeamMember.role='leader' 为准（headId 类权威字段是 leaderId）
    const leaderMembership = await prisma.teamMember.findFirst({
      where: { teamId, userId: actor.userId, role: 'leader', leftAt: null },
      select: { id: true },
    });
    if (leaderMembership) return true;
    const team = await prisma.team.findFirst({
      where: { id: teamId, leaderId: actor.userId, deletedAt: null },
      select: { id: true },
    });
    return Boolean(team);
  }

  /** §6.1 组管理资格：组长（本组）/ 销售主管 / admin / 超管 */
  async function canManageTeam(actor: TokenPayload, teamId: string): Promise<boolean> {
    if (!actor) return false;
    if (hasManagerRole(actor)) return true;
    return isTeamLeader(actor, teamId);
  }

  // ══════════════════════════════════════════════════════════════
  // 4. 授权 / 改档 / 撤销（幂等 + 审计，§7 契约细则）
  // ══════════════════════════════════════════════════════════════

  async function audit(action: string, detail: Record<string, unknown>, ip?: string | null): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: String(detail.operatorId || 'system'),
          action,
          targetType: String(detail.targetType || 'TeamDataGrant'),
          targetId: detail.targetId ? String(detail.targetId) : null,
          detail: detail as any,
          ip: ip || null,
        },
      });
    } catch (e: any) {
      logger.error('[TeamShare] auditLog write failed', { action, error: e?.message });
    }
  }

  /**
   * 批量授权（幂等）：重复授权 = 更新 permission；撤销后再授权 = 复活原行。
   * 双重门禁：canManageTeam ∧ 对实体有行级写权限。
   * 事务性：部分失败整批回滚（§7）。
   */
  async function grantEntitiesToTeam(
    actor: TokenPayload | null | undefined,
    teamId: string,
    items: GrantInput[],
    ip?: string | null,
  ): Promise<TeamShareResult<{ granted: number }>> {
    try {
      if (!actor) return fail('UNAUTHORIZED', '共享数据需登录');
      if (!Array.isArray(items) || items.length === 0) return fail('INVALID_GRANT', 'items 不能为空');

      // 校验 items
      for (const item of items) {
        if (!GRANT_ENTITY_TYPES.includes(item?.entityType)) {
          return fail('INVALID_GRANT', `entityType 仅支持: ${GRANT_ENTITY_TYPES.join(', ')}`);
        }
        if (!item?.entityId?.trim()) return fail('INVALID_GRANT', 'entityId 必填');
        if (!GRANT_PERMISSIONS.includes(item?.permission)) {
          return fail('INVALID_GRANT', `permission 仅支持: ${GRANT_PERMISSIONS.join(' / ')}`);
        }
      }

      // 门禁 1：组管理资格（T-22/T-23）
      if (!(await canManageTeam(actor, teamId))) {
        return fail('FORBIDDEN', '仅组长、销售主管或管理员可管理该组的共享授权');
      }

      // 组状态校验（防向已解散组建授权，T-25）
      const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, deletedAt: true } });
      if (!team) return fail('TEAM_NOT_FOUND', '小组不存在');
      if (team.deletedAt !== null && team.deletedAt !== undefined) return fail('TEAM_DISSOLVED', '小组已解散，无法授权');

      // 门禁 2 + 实体存在性（T-24 / T-14：实体须存在且未软删）
      const uniqueItems: GrantInput[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const key = `${item.entityType}:${item.entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueItems.push(item);
      }
      for (const item of uniqueItems) {
        const entity = await prisma.relation.findFirst({
          where: { id: item.entityId, deletedAt: null },
          select: { id: true, sensitivity: true },
        });
        if (!entity) return fail('ENTITY_NOT_FOUND', `实体不存在或已删除：${item.entityId}`);
        // v2.2（DR-042 §4.4 T-41）：confidential 档案禁止组共享——防绕过敏感标记；
        // 确需协作走 salesRepIds 加跟进人（写侧身份，审计更强）
        if (entity.sensitivity === 'confidential') {
          return fail('SENSITIVE_ENTITY_NOT_SHAREABLE', `实体 ${item.entityId} 为机密档案（confidential），禁止组共享（DR-042 §4.4）`);
        }
        if (!(await hasRelationWriteAccess(actor, item.entityId))) {
          return fail('GRANT_SCOPE_BLOCKED', `无实体 ${item.entityId} 的行级写权限，不可共享（DR-042 §6.1）`);
        }
      }

      // 事务：整批 upsert（幂等锚点 @@unique([teamId, entityType, entityId])）
      const granted = await prisma.$transaction(async (tx) => {
        let count = 0;
        for (const item of uniqueItems) {
          await tx.teamDataGrant.upsert({
            where: {
              teamId_entityType_entityId: {
                teamId,
                entityType: item.entityType,
                entityId: item.entityId,
              },
            },
            update: {
              permission: item.permission,
              revokedAt: null, // 复活语义（T-13）：撤销后再授权 = 复活原行
              revokedBy: null,
              revokeReason: null,
              grantedBy: actor.userId,
              grantedAt: new Date(),
            },
            create: {
              teamId,
              entityType: item.entityType,
              entityId: item.entityId,
              permission: item.permission,
              grantedBy: actor.userId,
            },
          });
          count += 1;
        }
        return count;
      });

      // 审计（事务外，失败不阻断主流程）
      for (const item of uniqueItems) {
        await audit('team_grant_create', {
          operatorId: actor.userId, teamId, entityType: item.entityType,
          entityId: item.entityId, permission: item.permission,
        }, ip);
      }
      // 失效缓存（本进程；跨进程 ≤60s 上界可接受，§5.2）
      userTeamsCache.delete(actor.userId);

      logger.info('[TeamShare] granted', { teamId, count: granted, by: actor.userId });
      return ok({ granted });
    } catch (e: any) {
      logger.error('[TeamShare] grant failed', { teamId, error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(e?.message ?? e) } };
    }
  }

  /** 撤销授权（软撤销 + 审计，T-08/T-10） */
  async function revokeGrant(
    actor: TokenPayload | null | undefined,
    teamId: string,
    entityType: GrantEntityType,
    entityId: string,
    reason: string,
    ip?: string | null,
  ): Promise<TeamShareResult<{ revoked: boolean }>> {
    try {
      if (!actor) return fail('UNAUTHORIZED', '撤销共享需登录');
      if (!reason?.trim()) return fail('INVALID_GRANT', 'reason 必填（审计留痕）');

      if (!(await canManageTeam(actor, teamId))) {
        return fail('FORBIDDEN', '仅组长、销售主管或管理员可撤销该组的共享授权');
      }

      const existing = await prisma.teamDataGrant.findUnique({
        where: { teamId_entityType_entityId: { teamId, entityType, entityId } },
      });
      if (!existing) return fail('ENTITY_NOT_FOUND', '授权记录不存在');
      if (existing.revokedAt) return ok({ revoked: false }); // 幂等：已撤销直接成功

      await prisma.teamDataGrant.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), revokedBy: actor.userId, revokeReason: reason.trim() },
      });
      await audit('team_grant_revoke', {
        operatorId: actor.userId, teamId, entityType, entityId, reason: reason.trim(),
      }, ip);
      userTeamsCache.delete(actor.userId);

      logger.info('[TeamShare] revoked', { teamId, entityId, by: actor.userId });
      return ok({ revoked: true });
    } catch (e: any) {
      logger.error('[TeamShare] revoke failed', { teamId, entityId, error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(e?.message ?? e) } };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 5. 解散组事务（§9.2：批量 revoke → 软删组 → 审计，一事务）
  // ══════════════════════════════════════════════════════════════

  async function dissolveTeam(
    actor: TokenPayload | null | undefined,
    teamId: string,
    ip?: string | null,
  ): Promise<TeamShareResult<{ dissolved: boolean; revokedGrants: number }>> {
    try {
      if (!actor) return fail('UNAUTHORIZED', '解散小组需登录');
      if (!hasManagerRole(actor)) return fail('FORBIDDEN', '仅销售主管或管理员可解散小组（DR-042 §6.1）');

      const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, deletedAt: true } });
      if (!team) return fail('TEAM_NOT_FOUND', '小组不存在');
      if (team.deletedAt !== null && team.deletedAt !== undefined) {
        return fail('TEAM_DISSOLVED', '小组已解散（幂等保护，T-05）');
      }

      const { revokedGrants } = await prisma.$transaction(async (tx) => {
        // 1. 批量撤销生效中的授权（reason 固定 team dissolved，审计可追溯）
        const revoked = await tx.teamDataGrant.updateMany({
          where: { teamId, revokedAt: null },
          data: { revokedAt: new Date(), revokedBy: actor.userId, revokeReason: 'team dissolved' },
        });
        // 2. 软删组
        await tx.team.update({ where: { id: teamId }, data: { deletedAt: BigInt(Date.now()) } });
        return { revokedGrants: revoked.count };
      });

      await audit('team_dissolve', { operatorId: actor.userId, teamId, revokedGrants }, ip);
      userTeamsCache.clear(); // 组解散影响全体组员缓存

      logger.info('[TeamShare] team dissolved', { teamId, revokedGrants, by: actor.userId });
      return ok({ dissolved: true, revokedGrants });
    } catch (e: any) {
      logger.error('[TeamShare] dissolve failed', { teamId, error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(e?.message ?? e) } };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 6. 查询：组授权列表（审计视图）/ 实体共享 chips / 访问档位
  // ══════════════════════════════════════════════════════════════

  /** 组内授权列表（含已撤销，审计视图，§7） */
  async function listTeamGrants(teamId: string, activeOnly = false) {
    return prisma.teamDataGrant.findMany({
      where: { teamId, ...(activeOnly ? { revokedAt: null } : {}) },
      orderBy: { grantedAt: 'desc' },
    });
  }

  /** 实体被共享给的组（详情页 chips，§8.3；权限=该数据可见者） */
  async function getEntityTeamShares(entityType: GrantEntityType, entityId: string): Promise<TeamShareChip[]> {
    const grants = await prisma.teamDataGrant.findMany({
      where: { entityType, entityId, revokedAt: null, team: { deletedAt: null } },
      include: { team: { select: { id: true, name: true } } },
      orderBy: { grantedAt: 'desc' },
    });
    return grants.map(g => ({
      grantId: g.id,
      teamId: g.teamId,
      teamName: (g as any).team?.name || g.teamId,
      permission: g.permission as GrantPermission,
      grantedBy: g.grantedBy,
      grantedAt: g.grantedAt,
    }));
  }

  /**
   * 列表徽章批量查询（§8.2）：entityIds × 用户所在组的生效授权。
   * 返回 Map<entityId, TeamShareChip[]>——空数组=非组共享来源（部门维/本人）。
   */
  async function getMyTeamSharesForEntities(
    userId: string,
    entityType: GrantEntityType,
    entityIds: string[],
  ): Promise<Map<string, TeamShareChip[]>> {
    const result = new Map<string, TeamShareChip[]>();
    if (!userId || entityIds.length === 0) return result;
    const { teamIds } = await getUserTeams(userId);
    if (teamIds.length === 0) return result;
    const grants = await prisma.teamDataGrant.findMany({
      where: {
        entityType,
        entityId: { in: entityIds },
        teamId: { in: teamIds },
        revokedAt: null,
        team: { deletedAt: null },
      },
      include: { team: { select: { id: true, name: true } } },
      orderBy: { grantedAt: 'desc' },
    });
    for (const g of grants) {
      const list = result.get(g.entityId) || [];
      list.push({
        grantId: g.id,
        teamId: g.teamId,
        teamName: (g as any).team?.name || g.teamId,
        permission: g.permission as GrantPermission,
        grantedBy: g.grantedBy,
        grantedAt: g.grantedAt,
      });
      result.set(g.entityId, list);
    }
    return result;
  }

  /**
   * 访问档位解析（§6.2，供跟进门禁与前端渲染）：
   *   department（归属部门/写范围可见，全权）> team-followup > team-read > none
   */
  async function resolveRelationAccess(
    actor: TokenPayload | null | undefined,
    relationId: string,
    options: { fresh?: boolean } = {},
  ): Promise<RelationAccessMode> {
    if (!actor) return 'none';
    if (await hasRelationWriteAccess(actor, relationId)) return 'owner';
    const { grantedRelationIds } = await getUserTeams(actor.userId, options);
    if (!grantedRelationIds.includes(relationId)) return 'none';
    const grant = await prisma.teamDataGrant.findFirst({
      where: {
        entityId: relationId,
        entityType: 'relation',
        revokedAt: null,
        team: { deletedAt: null },
        teamId: { in: (await getUserTeams(actor.userId, options)).teamIds },
      },
      orderBy: { grantedAt: 'desc' },
      select: { permission: true },
    });
    if (!grant) return 'none';
    return grant.permission === 'read+followup' ? 'team-followup' : 'team-read';
  }

  return {
    getActiveGrantedRelationIds,
    hasRelationWriteAccess,
    hasBizReadAccess,        // v2.2 L2 业务读锚（visibleBiz）
    resolveVisibleRelationIds, // v2.2 L2 可见客户 ID 集（followedBy ∪ teamGranted）
    canManageTeam,
    grantEntitiesToTeam,
    revokeGrant,
    dissolveTeam,
    listTeamGrants,
    getEntityTeamShares,
    getMyTeamSharesForEntities,
    resolveRelationAccess,
  };
}

// ────────────────────────────────────────────────────────────────────
// 单例
// ────────────────────────────────────────────────────────────────────
let _defaultService: ReturnType<typeof createTeamShareService> | null = null;
export function getTeamShareService(prisma: PrismaClient): ReturnType<typeof createTeamShareService> {
  if (!_defaultService) _defaultService = createTeamShareService(prisma);
  return _defaultService;
}
