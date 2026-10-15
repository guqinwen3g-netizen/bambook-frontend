/**
 * seed-empty-owner.ts
 *
 * 给「空白新公司」(panda_hub_empty) 注入一个预设的 bootstrap 管理员账号，
 * 打破「零账号 → 无人审批 → 注册永远 pending → 谁都进不去」的死锁。
 *
 * 设计约定：
 *  - 业务数据仍为 0（订单/客户/运单等不动），只注入 1 个管理员，符合"甲方第一天"语义。
 *  - 密码与现有演示账号一致：Bambook@2026（DEV 专用，生产须停用）。
 *  - 角色绑定 role-super-admin（超级管理员，含 users:admin），登录后可在用户管理里审批后续注册。
 *  - 幂等：已存在 owner 邮箱 / 已有任意 active 账号时自动跳过，避免重复注入或污染非空库。
 *
 * 运行：cd server && npx ts-node scripts/seed-empty-owner.ts
 *       （会读取 .env.local 的 DATABASE_URL；当前开发默认指向 panda_hub_empty）
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const OWNER_EMAIL = 'owner@bambook.local';
const OWNER_PASSWORD = 'Bambook@2026';
const OWNER_DISPLAY = '公司管理员';
const OWNER_ROLE_ID = 'role-super-admin'; // 超级管理员，含 users:admin

function maskUrl(u: string): string {
  return u.replace(/:([^:@/]+)@/, ':***@');
}

async function main() {
  const prisma = new PrismaClient();
  console.log('[seed-empty-owner] target DB:', maskUrl(process.env.DATABASE_URL || '(none)'));

  // 1) 已存在 owner 邮箱 → 跳过
  const existing = await prisma.userAccount.findFirst({ where: { email: OWNER_EMAIL, deletedAt: null } });
  if (existing) {
    console.log(`[seed-empty-owner] owner 已存在 (id=${existing.id})，跳过注入。`);
    await prisma.$disconnect();
    return;
  }

  // 2) 已有任意 active 账号 → 视为非空库，避免误注入重复管理员
  const anyActive = await prisma.userAccount.count({ where: { status: 'active', deletedAt: null } });
  // 开发环境初始化脚本在 seed:base 已建演示账号后调用，可显式放行（仍以 owner 邮箱去重）。
  if (anyActive > 0 && process.env.SEED_OWNER_ALLOW_NONEMPTY !== '1') {
    console.log(`[seed-empty-owner] 该库已有 ${anyActive} 个 active 账号，跳过注入以保持数据纯净。`);
    await prisma.$disconnect();
    return;
  }

  const id = `usr_empty_owner_${Date.now().toString(36)}`;
  const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);

  const user = await prisma.userAccount.create({
    data: {
      id,
      displayName: OWNER_DISPLAY,
      email: OWNER_EMAIL,
      passwordHash,
      status: 'active',
      primaryDeptId: null,
      metadata: {
        emailVerified: true,
        seededFor: 'empty-company-bootstrap',
        registeredAt: new Date().toISOString(),
      },
    },
  });

  const role = await prisma.role.findUnique({ where: { id: OWNER_ROLE_ID } });
  if (role) {
    await prisma.userRole.create({
      data: { id: `ur_${id}_${role.id}`, userId: id, roleId: role.id, departmentId: null },
    });
  } else {
    console.warn(`[seed-empty-owner] ⚠ 角色 ${OWNER_ROLE_ID} 不存在，owner 已建但未绑定角色，请检查种子角色数据。`);
  }

  console.log(`[seed-empty-owner] ✅ 已注入 bootstrap 管理员 id=${id} email=${OWNER_EMAIL} role=${role?.name || '(未绑定)'}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[seed-empty-owner] 失败：', e);
  process.exit(1);
});
