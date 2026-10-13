/**
 * MoqThresholdConfig 初始 Seed 脚本
 * 设计真源：docs/design/02-数据模型/Prisma缺口清单与迁移方案.md §2 Seed 脚本
 * 关联：docs/design/03-业务规则/MOQ最小起订量.md §2.1 系统配置第5级取数
 *
 * 执行方式（与 seed-rbac 约定一致）：
 *   cd server && npx tsx scripts/seed-moq-thresholds.ts
 *
 * 环境加载：.env.local → .env 顺序（DATABASE_URL 可被显式覆盖）
 * 幂等保证：upsert by id = 'MOQCFG__seed_initial'，重复执行安全
 */

import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// ─── 环境加载（.env.local 高优先级）──────────────────────────────────────────
const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local') });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const prisma = new PrismaClient();

export async function seedMoqThresholds() {
  const created = await prisma.moqThresholdConfig.upsert({
    where: { id: 'MOQCFG__seed_initial' },
    create: {
      id: 'MOQCFG__seed_initial',
      fabricDefaultMoq: 800,      // 面料档默认 MOQ = 800 米
      garmentDefaultMoq: 200,     // 成衣档默认 MOQ = 200 件
      capsuleMoq: 20,             // Capsule 档 MOQ = 20 件（勾选 capsuleExemption 后降级使用）
      isActive: true,             // DB 层唯一索引 moq_threshold_config_only_one_active 保证仅 1 条 active
      effectiveFrom: new Date(),
      changedBy: 'system_seed',
      changeReason: 'seed 初始配置（首次部署，Admin 可在设置后台调整）',
    },
    update: {},
  });

  console.log(`[seed-moq-thresholds] MoqThresholdConfig: ${created.id} active=${created.isActive}`);
  console.log(`  fabric=${created.fabricDefaultMoq}m / garment=${created.garmentDefaultMoq}pcs / capsule=${created.capsuleMoq}pcs`);
  return created;
}

if (require.main === module) {
  seedMoqThresholds()
    .catch((e) => {
      console.error('[seed-moq-thresholds] FAILED:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
