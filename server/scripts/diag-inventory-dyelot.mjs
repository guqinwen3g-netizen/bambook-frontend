/**
 * diag-inventory-dyelot.mjs — 只读诊断：库存层「缸号/色差」现状（D1 定口径用）
 *
 * 为什么先跑它（本仓纪律：**判据 = 真库实测 + 代码事实**，不是清单/记忆）：
 *   D1 说「缺库存层 lot」。要判断修法是「复用 `InventoryItem.batchNumber` 存缸号」（零 migration）
 *   还是「新增 `dyeLotNo` 等显式字段」（需 migration），必须先看真库实际怎么填的：
 *     · `InventoryItem.batchNumber` 的取值分布（是缸号？是批次号？是空的？）
 *     · `SampleColorBatch.dyeLotNo` 的取值（已登记的缸号）
 *     · 两者是否已有交集（若业务员已经在把缸号填进 batchNumber，那零 migration 就够）
 *
 * 跑法：cd server && node scripts/diag-inventory-dyelot.mjs
 * 只读：不写任何数据。
 */
import { createRequire } from 'node:module';

const req = createRequire('/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/');
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

const topN = (rows, keyFn, n = 12) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
};

const main = async () => {
  const items = await prisma.inventoryItem.findMany({
    where: { deletedAt: null },
    select: { batchNumber: true, category: true, unit: true, quantity: true, materialCode: true },
  });
  console.log(`\nInventoryItem（未删）共 ${items.length} 行`);
  const withBatch = items.filter(i => (i.batchNumber ?? '').trim() !== '');
  console.log(`  有 batchNumber：${withBatch.length} 行（${((withBatch.length / Math.max(items.length, 1)) * 100).toFixed(1)}%）`);
  console.log('  batchNumber 取值 Top：');
  for (const [k, c] of topN(withBatch, i => i.batchNumber)) console.log(`    ${JSON.stringify(k)} × ${c}`);

  console.log('  按 category 分布（有 batchNumber 的）：');
  for (const [k, c] of topN(withBatch, i => i.category ?? 'null')) console.log(`    ${JSON.stringify(k)} × ${c}`);

  const batches = await prisma.sampleColorBatch.findMany({
    where: { deletedAt: null },
    select: { dyeLotNo: true, batchNo: true, stage: true, colorRating: true, orderId: true },
  });
  console.log(`\nSampleColorBatch（未删）共 ${batches.length} 行`);
  console.log(`  有 dyeLotNo（缸号）：${batches.filter(b => (b.dyeLotNo ?? '').trim() !== '').length} 行`);
  console.log('  dyeLotNo 取值 Top：');
  for (const [k, c] of topN(batches.filter(b => (b.dyeLotNo ?? '').trim() !== ''), b => b.dyeLotNo)) console.log(`    ${JSON.stringify(k)} × ${c}`);

  // 交集：业务员是否已在把缸号填进库存 batchNumber
  const dyeLots = new Set(batches.map(b => (b.dyeLotNo ?? '').trim()).filter(Boolean));
  const inter = withBatch.filter(i => dyeLots.has((i.batchNumber ?? '').trim()));
  console.log(`\n★ 交集（库存 batchNumber ∈ 已登记缸号）：${inter.length} 行`);
  if (inter.length > 0) {
    console.log('  样本：', inter.slice(0, 5).map(i => i.batchNumber).join(' / '));
  }
  console.log(
    inter.length > 0
      ? '\n⇒ 业务员**已经在**把缸号填进 batchNumber ⇒ 可先走「零 migration」路线（聚合 + 对撞核对）'
      : '\n⇒ 两者无交集 ⇒ 库存层目前没有缸号信息（零 migration 只能做"能对上的才核对"，其余需业务补填）',
  );
};

main()
  .catch(e => { console.error('诊断失败：', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
