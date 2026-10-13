/**
 * dataScopeWhere.ts — 行级数据范围 → Prisma where 片段的**唯一拼装入口**。
 *
 * 为什么独立成纯函数：marketing / finance / traceability 三个域此前各自写
 * `if (rule.kind === 'all') … else if (rule.kind === 'self') … else OR[ownerId,departmentId]`，
 * 于是 §10.4.1 新增的 team 档（小组）虽被引擎正确解析，却在这些域被硬分支当成"非本人"
 * 处理，拼出结构不同的 where。把判定依据从 `rule.kind` 改为**解析后的用户集**，
 * 三档（自己 / 团队 / 全部）自然统一，新增档位也不必再逐个域改。
 *
 * 纯函数（不依赖 Prisma / 服务实例）→ 各域可单测、mock 不受影响。
 */

import type { DataScopeRule } from '../_shared/rolePermissionMatrix';

/** 与 permissionService.getDataScopeResolver 的返回结构同构（结构化子类型，避免循环依赖） */
export interface DataScopeResolverLike {
  rule: DataScopeRule;
  allowedDepartmentIds?: string[];
  allowedUserIds?: string[];
  allowedTeamIds?: string[];
}

/**
 * 规则：
 *  - all → {}（不过滤）
 *  - 有效用户集 = 仅本人 → 扁平 { ownerId }（保持既有 where 结构与索引行为）
 *  - 否则 → OR[ownerId in userIds, departmentId in deptIds]
 *  - 用户集为空（异常）→ { ownerId: '__NOBODY__' }（fail-closed，绝不放全量）
 */
export function buildScopeWhereFromResolver(
  resolver: DataScopeResolverLike,
  actorUserId: string,
): Record<string, unknown> {
  if (resolver.rule.kind === 'all') return {};

  // 只有「自己」「团队」两档才把本人兜底进用户集（团队里没进任何小组时仍要能看自己的数据）；
  // 部门档若一个白名单都没解析出来，属于异常态 → 保持既有 fail-closed（__NOBODY__）。
  const allowSelfFallback = resolver.rule.kind === 'self' || resolver.rule.kind === 'team';
  const userIds = Array.from(
    new Set(
      (resolver.allowedUserIds?.length
        ? resolver.allowedUserIds
        : allowSelfFallback
          ? [actorUserId]
          : []).filter(Boolean),
    ),
  );
  const deptIds = Array.from(new Set((resolver.allowedDepartmentIds ?? []).filter(Boolean)));

  if (deptIds.length === 0 && userIds.length === 1 && userIds[0] === actorUserId) {
    return { ownerId: actorUserId };
  }

  const orParts: any[] = [];
  if (userIds.length > 0) orParts.push({ ownerId: { in: userIds } });
  if (deptIds.length > 0) orParts.push({ departmentId: { in: deptIds } });
  if (orParts.length === 0) return { ownerId: '__NOBODY__' };
  return { OR: orParts };
}
