/**
 * diag-shipping-method-values.mjs — 只读诊断：真库 shippingMethod 实际取值分布
 *
 * 为什么要先跑它（C2 客户自提）：
 *   `Shipment.shippingMethod` / `OrderLine.shippingMethod` 是**自由文本**（前端是 text 输入框），
 *   若直接「收成封闭枚举」会把历史脏值（'海运' / 'Ocean' / 'sea' …）顶红 ⇒ 必须先看真实分布。
 *   判据只能是「真库实测 + 代码事实」，不能靠「应该没人这么填」。
 *
 * 跑法：cd server && node scripts/diag-shipping-method-values.mjs
 * 只读：不写任何数据。
 */
import { createRequire } from 'node:module';

const req = createRequire('/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/');
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

const show = async (label, rows, total) => {
  console.log(`\n${label}（共 ${total} 行）`);
  if (rows.length === 0) {
    console.log('  （空）');
    return;
  }
  for (const r of rows) {
    const v = r.shippingMethod;
    console.log(`  ${JSON.stringify(v)} × ${r._count._all}`);
  }
};

const main = async () => {
  const shipments = await prisma.shipment.groupBy({ by: ['shippingMethod'], _count: { _all: true } });
  const shipmentTotal = await prisma.shipment.count();
  await show('Shipment.shippingMethod 分布', [...shipments].sort((a, b) => b._count._all - a._count._all), shipmentTotal);

  const lines = await prisma.orderLine.groupBy({ by: ['shippingMethod'], _count: { _all: true } });
  const lineTotal = await prisma.orderLine.count();
  await show('OrderLine.shippingMethod 分布', [...lines].sort((a, b) => b._count._all - a._count._all), lineTotal);

  const KNOWN = new Set(['Sea', 'Air', 'Land', 'Rail', 'Courier']);
  const unknown = [...shipments, ...lines]
    .map(r => r.shippingMethod)
    .filter(v => v != null && !KNOWN.has(v));
  console.log(`\n非封闭枚举取值（需人工定性）：${unknown.length === 0 ? '无' : JSON.stringify([...new Set(unknown)])}`);
};

main()
  .catch(e => { console.error('诊断失败：', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
