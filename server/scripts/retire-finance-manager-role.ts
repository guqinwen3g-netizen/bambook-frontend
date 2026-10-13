/**
 * retire-finance-manager-role.ts — GAP-R11 存量数据迁移：退役 role-finance-manager
 *
 * 背景：代码侧已删除 FINANCE_MANAGER（7 角色收编），但既有部署的 DB 中仍存在
 *   Role 行 / UserRole 授权 / RolePermission 矩阵行。本脚本把存量授权平移到
 *   role-finance 并清除角色行，幂等可重复执行。
 *
 * 迁移规则：
 *   1. UserRole(role-finance-manager) → 改挂 role-finance；
 *      若该用户已持有同部门 role-finance 行（唯一键 [userId, roleId, departmentId] 冲突）→ 删除旧行
 *   2. RolePermission(role-finance-manager) → 删除（role-finance 矩阵由 seed-rbac 负责补齐）
 *   3. Role(role-finance-manager) → 删除
 *
 * 用法：
 *   cd server && npx tsx scripts/retire-finance-manager-role.ts
 * 部署：Mac Mini 升级含本变更的版本后执行一次（幂等，重复执行无副作用）。
 */
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const RETIRED = 'role-finance-manager';
const TARGET = 'role-finance';

async function main() {
  const prisma = new PrismaClient();
  try {
    const summary = await prisma.$transaction(async (tx) => {
      const legacyAssignments = await tx.userRole.findMany({ where: { roleId: RETIRED } });
      let remapped = 0;
      let droppedDupe = 0;
      for (const row of legacyAssignments) {
        const conflict = await tx.userRole.findFirst({
          where: { userId: row.userId, roleId: TARGET, departmentId: row.departmentId },
        });
        if (conflict) {
          await tx.userRole.delete({ where: { id: row.id } });
          droppedDupe += 1;
        } else {
          await tx.userRole.update({ where: { id: row.id }, data: { roleId: TARGET } });
          remapped += 1;
        }
      }
      const perms = await tx.rolePermission.deleteMany({ where: { roleId: RETIRED } });
      const roles = await tx.role.deleteMany({ where: { id: RETIRED } });
      return { legacyAssignments: legacyAssignments.length, remapped, droppedDupe, permsDeleted: perms.count, rolesDeleted: roles.count };
    });
    console.log('[retire-finance-manager-role] 完成：', JSON.stringify(summary));
    if (summary.rolesDeleted === 0 && summary.legacyAssignments === 0 && summary.permsDeleted === 0) {
      console.log('[retire-finance-manager-role] 已是目标状态（幂等跳过）');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[retire-finance-manager-role] 失败：', e);
  process.exit(1);
});
