/**
 * approvalRoutingService.ts — DR-007 审批人组织归属解析（单一真源）
 *
 * 设计真源：
 *   - docs/design/02-数据模型/底座域模型组.md §39（BASE-39-A1/A2/B1/B4）
 *   - docs/design/04-模块设计/07-AI助手/审批与human-in-the-loop.md §14（DR7-A1/A3/A4/A5）
 *
 * 铁律（fail-closed）：
 *   1. reviewerId 只能由本服务解析，前端传入值一律不用（见 approvalCreateService）
 *   2. 任何路径解析不到审批人 → 抛 NO_REVIEWER_RESOLVED，绝不允许 reviewerId=null 落库（BASE-39-B4）
 *   3. 所有候选选取跳过申请人本人；唯一例外：全系统仅剩申请人可用时允许返回其本人
 *      （decide 时现有 403 自审守卫兜底）
 *   4. 路由结果确定性：同一时刻同一申请人重复解析结果一致（候选按 createdAt 升序取第一个）
 */

import type { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { logger } from '../lib/logger';
import { CLAIM_LEADER_ROLE_IDS } from '../claims/claimApprovalFact';

// ───────────────────────────────────────────────────────────────────
// 解析路径枚举（ApprovalRequest.reviewerResolverRoute 真源，createOnce 写入）
// ───────────────────────────────────────────────────────────────────
export type ReviewerResolverRoute =
  | 'DEPT_HEAD'                        // 正常：部门主管
  | 'FALLBACK_DEPT_HEAD_VACANT'        // 部门无主管 → 本部门 SALES_MANAGER → ADMIN 兜底
  | 'FALLBACK_SELF_APPLY_SUPERVISOR'   // 申请人本人是部门主管 → 上级部门主管 → ADMIN 兜底
  | 'FALLBACK_ADMIN'                   // 无部门/无任何候选 → ADMIN 兜底
  | 'CLAIM_GENERAL_LEADER';            // 索赔任意金额：真实 ADMIN 总领导

export interface ReviewerResolution {
  reviewerId: string;
  route: ReviewerResolverRoute;
  /** 申请人部门快照（BASE-39-A2：创建后不受后续部门调动影响）；无部门时 'DEPT_NONE' */
  departmentSnapshotId: string;
}

/** fail-closed 错误码：解析不到审批人时抛出，调用方必须原样上抛（不允许降级为 reviewerId=null） */
export const NO_REVIEWER_RESOLVED = 'NO_REVIEWER_RESOLVED';

// 无部门申请人快照兜底值
const DEPT_NONE = 'DEPT_NONE';

// 向上追溯上级部门的最大层数（组织架构正常 <5 层；防脏数据死循环）
const MAX_UPSTREAM_DEPTH = 8;

// ADMIN 兜底候选 roleId 集合：含系统 6 角色中的管理员 + 历史遗留直写值（role_admin/admin/role_owner）
const ADMIN_FALLBACK_ROLE_IDS = [
  SYSTEM_ROLE_IDS.ADMIN,
  SYSTEM_ROLE_IDS.SUPER_ADMIN,
  'role_admin',
  'admin',
  'role_super_admin',
  'role_owner',
];

export interface ApprovalRoutingServiceOptions {
  prisma: PrismaClient;
}

export function createApprovalRoutingService(opts: ApprovalRoutingServiceOptions) {
  const { prisma } = opts;

  // ── 内部：构造 fail-closed 错误 ──
  function noReviewerError(requesterId: string, snapshotId: string, reason: string): Error & { code: string } {
    const err = new Error(
      `${NO_REVIEWER_RESOLVED}: 申请人 ${requesterId}（部门快照=${snapshotId}）解析不到任何审批人 — ${reason}`,
    ) as Error & { code: string };
    err.code = NO_REVIEWER_RESOLVED;
    return err;
  }

  // ── 内部：查 active 用户（软删排除） ──
  async function findActiveUser(userId: string) {
    return prisma.userAccount.findFirst({
      where: { id: userId, status: 'active', deletedAt: null },
      select: { id: true },
    });
  }

  // ── 内部：沿上级部门找 head（自申请阻断路径，最多 8 层，跳过申请人本人） ──
  async function resolveUpstreamHead(startDeptId: string, requesterId: string): Promise<string | null> {
    let cursor: string | null = startDeptId;
    for (let depth = 0; depth < MAX_UPSTREAM_DEPTH && cursor; depth++) {
      const dept: { id: string; status: string; headId: string | null; parentId: string | null } | null =
        await prisma.department.findUnique({
          where: { id: cursor },
          select: { id: true, status: true, headId: true, parentId: true },
        });
      if (!dept) return null;
      if (dept.status === 'active' && dept.headId && dept.headId !== requesterId) {
        const head = await findActiveUser(dept.headId);
        if (head) return head.id;
      }
      cursor = dept.parentId;
    }
    return null;
  }

  // ── 内部：本部门销售主管候选（head 空缺兜底第一档，按 createdAt 升序取第一个） ──
  async function findDeptSalesManager(deptId: string, requesterId: string): Promise<string | null> {
    const candidates = await prisma.userRole.findMany({
      where: {
        departmentId: deptId,
        roleId: SYSTEM_ROLE_IDS.SALES_MANAGER,
        userId: { not: requesterId },
        user: { status: 'active', deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      take: 1,
      select: { userId: true },
    });
    return candidates[0]?.userId ?? null;
  }

  // ── 内部：ADMIN 最终兜底 ──
  // 仅识别明确系统/遗留角色 ID；自定义角色名称不能生成领导权威。
  // 用户 active、跳过申请人本人、按 createdAt 升序取第一个。
  // 极端情况：全系统仅剩申请人本人是管理员时允许返回其本人（decide 403 自审守卫兜底）。
  async function adminFallback(
    requesterId: string,
    route: ReviewerResolverRoute,
    departmentSnapshotId: string,
  ): Promise<ReviewerResolution> {
    const baseWhere: any = {
      user: { status: 'active', deletedAt: null },
      roleId: { in: ADMIN_FALLBACK_ROLE_IDS },
    };
    const pick = async (where: any) => {
      const rows = await prisma.userRole.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { userId: true },
      });
      return rows[0]?.userId ?? null;
    };

    // 首选：排除申请人本人
    const outsider = await pick({ ...baseWhere, userId: { not: requesterId } });
    if (outsider) {
      logger.info('[ApprovalRouting] ADMIN 兜底命中', { requesterId, route, reviewerId: outsider });
      return { reviewerId: outsider, route, departmentSnapshotId };
    }
    // 唯一例外：仅剩申请人自己可用（含本人是管理员的单人系统场景）
    const selfOnly = await pick(baseWhere);
    if (selfOnly) {
      logger.warn('[ApprovalRouting] ADMIN 兜底仅剩申请人本人可用，自审 403 守卫兜底', { requesterId, route });
      return { reviewerId: selfOnly, route, departmentSnapshotId };
    }
    logger.error('[ApprovalRouting] fail-closed：无任何 ADMIN 候选', { requesterId, route, departmentSnapshotId });
    throw noReviewerError(requesterId, departmentSnapshotId, `路由 ${route} 的 ADMIN 兜底无候选用户`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 主入口：resolveReviewerByDepartment(requesterId)
  // ══════════════════════════════════════════════════════════════════
  async function resolveReviewerByDepartment(requesterId: string, client?: any): Promise<ReviewerResolution> {
    if (client && client !== prisma) return createApprovalRoutingService({ prisma: client }).resolveReviewerByDepartment(requesterId);
    // a. 读申请人（active + 未软删）→ 部门快照
    const requester = await prisma.userAccount.findFirst({
      where: { id: requesterId, status: 'active', deletedAt: null },
      select: { id: true, primaryDeptId: true },
    });
    if (!requester) {
      throw noReviewerError(requesterId, DEPT_NONE, '申请人不存在或已停用/已删除');
    }
    const departmentSnapshotId = requester.primaryDeptId ?? DEPT_NONE;

    const dept = requester.primaryDeptId
      ? await prisma.department.findUnique({
          where: { id: requester.primaryDeptId },
          select: { id: true, status: true, headId: true, parentId: true },
        })
      : null;

    if (dept && dept.status === 'active') {
      // b. 部门主管路径：headId 非空且 head 用户 active
      if (dept.headId) {
        const head = await findActiveUser(dept.headId);
        if (head) {
          if (dept.headId === requesterId) {
            // 自申请阻断（DR7-A5）：沿上级部门找 head → 找不到进 ADMIN 兜底
            const upstream = dept.parentId ? await resolveUpstreamHead(dept.parentId, requesterId) : null;
            if (upstream) {
              logger.info('[ApprovalRouting] 自申请阻断→上级部门主管', { requesterId, reviewerId: upstream });
              return { reviewerId: upstream, route: 'FALLBACK_SELF_APPLY_SUPERVISOR', departmentSnapshotId };
            }
            return adminFallback(requesterId, 'FALLBACK_SELF_APPLY_SUPERVISOR', departmentSnapshotId);
          }
          return { reviewerId: dept.headId, route: 'DEPT_HEAD', departmentSnapshotId };
        }
        // head 用户已停用 → 视同空缺，落 c 分支
      }
      // c. head 空缺/停用（DR7-A4）：本部门 SALES_MANAGER → ADMIN 兜底
      const deptManager = await findDeptSalesManager(dept.id, requesterId);
      if (deptManager) {
        logger.info('[ApprovalRouting] 部门 head 空缺→本部门销售主管', { requesterId, deptId: dept.id, reviewerId: deptManager });
        return { reviewerId: deptManager, route: 'FALLBACK_DEPT_HEAD_VACANT', departmentSnapshotId };
      }
      return adminFallback(requesterId, 'FALLBACK_DEPT_HEAD_VACANT', departmentSnapshotId);
    }

    // d. 无部门 / 部门已停用 → 直接 ADMIN 兜底
    return adminFallback(requesterId, 'FALLBACK_ADMIN', departmentSnapshotId);
  }

  /** A7: an ordinary department manager or a delegated reviewer is not the general leader. */
  async function resolveClaimLeader(requesterId: string, client?: any): Promise<ReviewerResolution> {
    if (client && client !== prisma) return createApprovalRoutingService({ prisma: client }).resolveClaimLeader(requesterId);
    const requester = await prisma.userAccount.findFirst({
      where: { id: requesterId, status: 'active', deletedAt: null }, select: { id: true, primaryDeptId: true },
    });
    if (!requester) throw noReviewerError(requesterId, DEPT_NONE, '申请人不存在或已停用/已删除');
    const departmentSnapshotId = requester.primaryDeptId ?? DEPT_NONE;
    const dept = requester.primaryDeptId ? await prisma.department.findUnique({ where: { id: requester.primaryDeptId } }) : null;
    if (dept?.status === 'active' && dept.headId && dept.headId !== requesterId) {
      const head = await prisma.userAccount.findFirst({
        where: { id: dept.headId, status: 'active', deletedAt: null, primaryDeptId: dept.id }, select: { id: true },
      });
      const roles = head ? await prisma.userRole.findMany({ where: { userId: head.id, roleId: { in: CLAIM_LEADER_ROLE_IDS } }, select: { userId: true } }) : [];
      if (roles.length) return { reviewerId: head!.id, route: 'CLAIM_GENERAL_LEADER', departmentSnapshotId };
    }
    const rows = await prisma.userRole.findMany({
      where: { roleId: { in: CLAIM_LEADER_ROLE_IDS }, userId: { not: requesterId }, user: { status: 'active', deletedAt: null } },
      select: { userId: true },
    });
    const ids = [...new Set(rows.map(row => row.userId))];
    if (ids.length === 1) return { reviewerId: ids[0], route: 'CLAIM_GENERAL_LEADER', departmentSnapshotId };
    throw noReviewerError(requesterId, departmentSnapshotId, '索赔须配置有效 ADMIN 总领导；多位候选时请明确部门领导后重新提交');
  }

  return { resolveReviewerByDepartment, resolveClaimLeader };
}

export type ApprovalRoutingService = ReturnType<typeof createApprovalRoutingService>;
