/**
 * fix-migration-ledger.ts — 迁移账本补账脚本（运维冲刺任务 1）。
 *
 * 背景：本地/生产库曾以 `prisma db push` 领先账本运行（六表 FabricProfile/DevelopmentCase/
 * Invoice/PaymentVoucher/Shipment/MaterialReturn 及部分列由 db push 创建，账本未记账）。
 * 此时 `migrate deploy` 会对"已生效但未记账"的迁移报错（duplicate column / relation exists）。
 *
 * 本脚本：
 *   1. 列出 migrations 目录中全部迁移；
 *   2. 对照 _prisma_migrations 账本，找出"未记账"的迁移；
 *   3. 默认 dry-run 仅出报告；`--apply` 时对每个未记账迁移执行
 *      `npx prisma migrate resolve --applied <目录名>` 记账；
 *   4. 输出补账报告（已记账/新补账/仍缺失）。
 *
 * 用法：
 *   npx ts-node scripts/fix-migration-ledger.ts            # dry-run 报告
 *   npx ts-node scripts/fix-migration-ledger.ts --apply    # 实际补账
 *
 * 注意：补账前请确认库结构确实已包含这些迁移的效果（db push 领先场景）。
 * 若是全新库，应直接 `migrate deploy` 而非补账。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const migrationsDir = path.resolve(__dirname, '../prisma/migrations');
  const allMigrations = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const recorded = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
  );
  const recordedSet = new Set(recorded.map((row) => row.migration_name));

  const missing = allMigrations.filter((name) => !recordedSet.has(name));

  console.log(`[fix-migration-ledger] 迁移目录共 ${allMigrations.length} 个，账本已记账 ${recordedSet.size} 个，未记账 ${missing.length} 个`);
  if (missing.length > 0) {
    console.log('[fix-migration-ledger] 未记账迁移清单：');
    for (const name of missing) console.log(`  - ${name}`);
  }

  if (!apply) {
    console.log('[fix-migration-ledger] dry-run 模式（--apply 实际补账）');
    return;
  }

  const resolved: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const name of missing) {
    try {
      execFileSync('npx', ['prisma', 'migrate', 'resolve', '--applied', name], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'pipe',
      });
      resolved.push(name);
      console.log(`[fix-migration-ledger] 已补账 ${name}`);
    } catch (error) {
      const message = error instanceof Error ? String(error.message).slice(0, 300) : String(error);
      failed.push({ name, error: message });
      console.error(`[fix-migration-ledger] 补账失败 ${name}: ${message}`);
    }
  }

  console.log('——— 补账报告 ———');
  console.log(`已记账（原）: ${recordedSet.size}`);
  console.log(`新补账: ${resolved.length}`);
  console.log(`失败: ${failed.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('[fix-migration-ledger] 执行失败:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
