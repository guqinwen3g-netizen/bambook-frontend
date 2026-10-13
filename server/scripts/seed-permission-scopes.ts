/**
 * Phase 1 权限 scope 增量 Seed 脚本（DR-007 审批组织归属 + Phase 2 全域预分配）
 *
 * 单一权威真源：/lib/rolePermissionMatrix.ts（根目录，与 seed-rbac 同一来源约定；
 * server/src/_shared/rolePermissionMatrix.ts 为运行时快照副本，两者内容必须保持同步）
 *
 * 执行方式（与 seed-rbac 约定一致）：
 *   cd server && npx tsx scripts/seed-permission-scopes.ts
 *
 * 环境加载：.env.local → .env 顺序（DATABASE_URL 可被显式覆盖）
 * 幂等保证：
 *   - Permission 按 scope upsert（id 规则 perm_<scope 中 : → _>，与 seed-rbac 一致）
 *   - RolePermission 按 (roleId, permissionId) upsert，重复执行安全
 *   - Role 不存在（seed-rbac 未跑）时跳过该角色并 console.warn，不报错
 */

import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  SYSTEM_ROLE_IDS,
  PERMISSION_SCOPES,
  getDatabaseSeedScopeListForRole,
  type SystemRoleId,
} from '../src/_shared/rolePermissionMatrix';

// ─── 环境加载（.env.local 高优先级）──────────────────────────────────────────
const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local') });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const prisma = new PrismaClient();

// Phase 1 预分配的 17 个 scope（15 个新增 + hr:salary:read / sensitive:salary 既有敏感 scope 的授权闭环）
const PHASE1_SCOPES = [
  'settings:moq:write',
  'moq:line_override',
  'moq:capsule_exemption:write',
  'order:change_request:create',
  'order:change_request:apply',
  'sample:early_production:write',
  'sample:shipment:write',
  'exception:dr013:create',
  'finance:payment_request:create',
  'finance:payment_request:approve',
  'credit:freeze:write',
  'credit:thaw:write',
  'order:internal_trade:write',
  'qc:fabric_chain:write',
  'qc:garment_chain:write',
  'hr:salary:read',
  'sensitive:salary',
] as const;

// DR-053 阶段 2：产前样放行三 scope（production_sign / business_sign / admin）
// 为何单列：Phase 1 清单未含它们，而 §10.3-4 / §10.7 P-3 定案「放行 = 领导单签」，
// 领导档（销售主管 / Admin）必须持有 business_sign，否则放行面板签字恒 403、放行走不通。
// 与 Phase 1 同走「从矩阵取值 → 幂等 upsert」，保证 seed 与运行时守卫同源。
const DR053_RELEASE_SCOPES = [
  'production:pp_release:production_sign',
  'production:pp_release:business_sign',
  'production:pp_release:admin',
] as const;

/** 本次 seed 覆盖的全部 scope = Phase 1 + DR-053 阶段 2 */
const SEED_SCOPES = [...PHASE1_SCOPES, ...DR053_RELEASE_SCOPES, 'invoices:suggest_match'] as const;

export async function seedPermissionScopes() {
  // 1. Permission upsert
  const scopeToPermId = new Map<string, string>();
  for (const scope of SEED_SCOPES) {
    const description = (PERMISSION_SCOPES as Record<string, string>)[scope] ?? scope;
    const id = `perm_${scope.replace(/[:./]/g, '_')}`;
    await prisma.permission.upsert({
      where: { scope },
      update: { description },
      create: { id, scope, description },
    });
    scopeToPermId.set(scope, id);
  }
  console.log(`[seed-permission-scopes] Permission upsert 完成：${SEED_SCOPES.length} 个 scope`);

  // 2. RolePermission upsert（角色映射取自 fallback 矩阵单一真源，保证 seed 与守卫一致）
  let total = 0;
  for (const roleId of Object.values(SYSTEM_ROLE_IDS)) {
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true } });
    if (!role) {
      console.warn(`[seed-permission-scopes] ⚠ Role ${roleId} 不存在（seed-rbac 未跑？），跳过`);
      continue;
    }
    const roleScopes = getDatabaseSeedScopeListForRole(roleId as SystemRoleId)
      .filter((s) => (SEED_SCOPES as readonly string[]).includes(s));
    for (const scope of roleScopes) {
      const permissionId = scopeToPermId.get(scope)!;
      const rpId = `rp_${roleId.replace(/-/g, '_')}__${permissionId}`;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        update: {},
        create: { id: rpId, roleId, permissionId },
      });
      total++;
    }
    console.log(`  · ${roleId}：${roleScopes.length} 个 seed scope 关联`);
  }
  console.log(`[seed-permission-scopes] RolePermission upsert 完成：共 ${total} 条`);
}

if (require.main === module) {
  seedPermissionScopes()
    .catch((e) => {
      console.error('[seed-permission-scopes] FAILED:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
