/**
 * orderService.ts — 订单域共享 service 辅助（S3-γ：v1 列表行级数据范围）
 *
 * GET /api/v1/orders 行级过滤，对齐 v2（orderServiceV2.buildScopeWhere）口径：
 *   - 全权角色（finance/admin/qc/logistics/super-admin）→ {} 不过滤（全公司可见）
 *   - sales / 销售主管 → 宿主客户跟进人 ∪ 团队共享客户（DR-042 §5.1 L2 换锚）可见；
 *     无客户锚的遗留订单（customerRelationId=null）回退创建者（ownerId=me）可见
 *   - 内部面料供给没有客户锚：按当前业务小组/部门的实际经办人范围读取。
 *
 * 策略真源单一：permissionService.getDataScopeResolver(actor, 'orders') +
 * teamShareService.resolveVisibleRelationIds(actor)——与 v2 完全同一对底层服务，
 * 不引入第二套角色→范围映射逻辑。
 *
 * 与 v2 唯一偏差：无 actor（dev 模式 / API-Key 读）时 v1 走旧口径放行（{}），
 * v2 为 fail-closed（ownerId='__NOBODY__'）——v1 必须保持既有 API-Key 读契约
 * （moduleGuard 已把认证关），且历史测试以 requireAuth:false 无 JWT 消费列表。
 */
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';

export async function buildOrderListScopeWhere(
  prisma: PrismaClient,
  actor: TokenPayload | null | undefined,
  options: { fresh?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (!actor) return {}; // v1 旧口径：dev / API-Key 读放行
  const resolver = await createPermissionService({ prisma }).getDataScopeResolver(actor, 'orders');
  if (resolver.rule.kind === 'all') return {};
  const visibleRelationIds = await createTeamShareService(prisma).resolveVisibleRelationIds(actor, options);
  return {
    OR: [
      { customerRelationId: { in: visibleRelationIds } },
      { AND: [{ customerRelationId: null }, { ownerId: actor.userId }] },
      { AND: [{ customerRelationId: null }, { orderPurpose: 'internal_fabric_supply' }, buildScopeWhereFromResolver(resolver, actor.userId)] },
    ],
  };
}
