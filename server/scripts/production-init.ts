/**
 * production-init.ts — 生产库初始化脚本（B5-3，上线日执行；幂等可重复跑）。
 *
 * 用途：空库/新生产库在首次对外服务前，一次性完成安全初始化：
 *   1. 停用全部演示账号（usr_demo_*、portal.demo、test.local、wp-owner 等非生产主体）；
 *   2. 检查 bootstrap 管理员（owner@）密码非演示默认值（只提醒不代改——密码哈希单向）；
 *   3. 清理测试残留（含 E2E 注册 pending 账号、一次性验证码行）；
 *   4. 输出安全核对报告（JWT_SECRET/邮件通道/演示残留计数）。
 *
 * 用法：
 *   cd server && npx ts-node scripts/production-init.ts            # dry-run：只出报告
 *   npx ts-node scripts/production-init.ts --apply                 # 实际执行停用/清理
 *
 * 安全护栏：
 *   - 默认拒绝在 DATABASE_URL 含 panda_hub_local / panda_hub_empty 的库上 --apply
 *     （演示/彩排库不是生产库；确需演练请用 PROD_INIT_ALLOW_DEMO=1 显式放行）。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const allowDemo = process.env.PROD_INIT_ALLOW_DEMO === '1';

const DEMO_EMAIL_PATTERNS = [
  '%@bambook.local',        // 演示员工 + demo 门户账号（sakurabrandskk@portal.demo 等）
  '%@portal.demo%',
  '%@test.local%',
  '%@example.com%',         // E2E 注册残留
  'wp-owner@%',
];

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  const isDemoDb = /panda_hub_local|panda_hub_empty/.test(url);
  const masked = url.replace(/:[^:@/]+@/, ':***@');
  console.log(`[prod-init] target db: ${masked}`);
  console.log(`[prod-init] mode: ${apply ? 'APPLY' : 'DRY-RUN'}${isDemoDb ? ' (演示库!)' : ''}`);
  if (isDemoDb && apply && !allowDemo) {
    console.error('[prod-init] ✗ 拒绝在演示库上 --apply。确需演练设 PROD_INIT_ALLOW_DEMO=1。');
    process.exit(1);
  }

  // ── 1. 演示账号清点/停用 ──
  const demoWhere = {
    OR: DEMO_EMAIL_PATTERNS.map((p) => ({ email: { contains: p.replace(/%$/, '') } })),
  };
  const demoUsers = await prisma.userAccount.findMany({
    where: { ...demoWhere, status: { not: 'disabled' } },
    select: { id: true, email: true, status: true },
  });
  const portalDemo = await prisma.customerUser.findMany({
    where: { email: { contains: 'portal.demo' }, deletedAt: null },
    select: { id: true, email: true, status: true },
  });
  console.log(`[prod-init] 内部演示账号待停用: ${demoUsers.length}`);
  for (const u of demoUsers) console.log(`  - ${u.email} (${u.status})`);
  console.log(`[prod-init] 门户演示账号待停用: ${portalDemo.length}`);
  for (const u of portalDemo) console.log(`  - ${u.email} (${u.status})`);

  if (apply) {
    const r1 = await prisma.userAccount.updateMany({
      where: { ...demoWhere, status: { not: 'disabled' } },
      data: { status: 'disabled' },
    });
    const r2 = await prisma.customerUser.updateMany({
      where: { email: { contains: 'portal.demo' }, deletedAt: null, status: { not: 'disabled' } },
      data: { status: 'disabled' },
    });
    console.log(`[prod-init] ✓ 已停用 内部 ${r1.count} + 门户 ${r2.count}`);
  }

  // ── 2. bootstrap 管理员密码提醒 ──
  const owner = await prisma.userAccount.findFirst({
    where: { email: { startsWith: 'owner@' } },
    select: { id: true, email: true, passwordHash: true, status: true },
  });
  if (owner) {
    // bcrypt($2b$12$…) 演示默认 Bambook@2026 的哈希前缀无法直接比对——
    // 用 bcrypt.compare 试一次（幂等只读）
    const bcrypt = await import('bcryptjs');
    const isDemoDefault = await bcrypt.compare('Bambook@2026', owner.passwordHash);
    console.log(`[prod-init] bootstrap 管理员 ${owner.email}: 演示默认密码=${isDemoDefault ? '是 ⚠ 必须改' : '否 ✓'}`);
  } else {
    console.log('[prod-init] ⚠ 未找到 owner@ 管理员——生产库需先注入（db-rebuild empty 场景自带）');
  }

  // ── 3. 测试残留清理 ──
  const staleCodes = await prisma.userVerificationCode.count();
  const pendingUsers = await prisma.userAccount.findMany({
    where: { status: 'pending', email: { contains: '@example.com' } },
    select: { id: true, email: true },
  });
  console.log(`[prod-init] 一次性验证码残留: ${staleCodes} 行${staleCodes > 0 && apply ? ' → 已清' : ''}`);
  if (pendingUsers.length) {
    console.log(`[prod-init] example.com pending 注册残留: ${pendingUsers.length}`);
    for (const u of pendingUsers) console.log(`  - ${u.email}`);
  }
  if (apply && staleCodes > 0) {
    const r = await prisma.userVerificationCode.deleteMany({});
    console.log(`[prod-init] ✓ 已清验证码 ${r.count} 行`);
  }

  // ── 4. 安全核对报告 ──
  const jwtOk = !!process.env.JWT_SECRET && process.env.JWT_SECRET !== 'change-me-in-production-at-least-32-chars';
  const emailConfigured = !!(process.env.RESEND_API_KEY?.trim() || (process.env.SMTP_HOST?.trim() && process.env.SMTP_USER?.trim()));
  console.log('───────── 安全核对 ─────────');
  console.log(`JWT_SECRET 强随机: ${jwtOk ? '✓' : '✗ 必须设置'}`);
  console.log(`邮件通道: ${emailConfigured ? '✓ 已配' : '✗ 未配（注册不可用，业务上可接受则放行）'}`);
  console.log(`BAMBOOK_DEV_PANEL: ${process.env.BAMBOOK_DEV_PANEL ? '⚠ 生产必须不设' : '✓ 未设'}`);
  console.log('[prod-init] 完成。');
}

main()
  .catch((e) => { console.error('[prod-init] failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
