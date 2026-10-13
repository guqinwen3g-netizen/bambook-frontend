/**
 * backfill-shipped-qty.ts —— 用**系统自己的真源函数**把 OrderLine.shipmentQuantity 刷成真值。
 *
 * 为什么这么做（不手算、不 SQL 硬写）：
 *   orderLineShippedQty.ts 是「已发量」的唯一真源；历史上这批模拟数据**从未走过出运模块**，
 *   所以快照一直是空（0/99）。调用真源补跑一次 = 既把数据补真，又**验证机制确实工作**。
 *
 * 只读之外的唯一副作用：写 OrderLine.shipmentQuantity（幂等，值未变不写）。
 */
import { PrismaClient } from '@prisma/client';
import { syncOrderLineShipmentQuantity } from '../src/shared/orderLineShippedQty';

const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.order.findMany({
    where: { deletedAt: null },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  console.log(`可见订单 ${orders.length} 张，开始补跑已发量快照…`);

  let touched = 0;
  let updatedLines = 0;
  const incomparable: string[] = [];

  for (const o of orders) {
    const r = await prisma.$transaction(async (tx: any) => syncOrderLineShipmentQuantity(tx, o.id));
    if (r.applied && r.updatedLines > 0) { touched += 1; updatedLines += r.updatedLines; }
    if (r.incomparable?.length) incomparable.push(`${o.id}:${r.incomparable.join(',')}`);
  }

  const nonZero = await prisma.orderLine.count({
    where: { shipmentQuantity: { not: null } },
  });
  const gt0 = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `select count(*)::bigint n from "OrderLine" where "shipmentQuantity" is not null and "shipmentQuantity" <> 0`
  );

  console.log(`\n结果：`);
  console.log(`  有订单被更新：${touched} 张`);
  console.log(`  被更新的订单行：${updatedLines} 行`);
  console.log(`  现在 shipmentQuantity 非空的订单行：${nonZero}`);
  console.log(`  其中 >0 的：${gt0[0]?.n?.toString() ?? '?'}`);
  if (incomparable.length) console.log(`  量纲不可比（需人工看）：${incomparable.slice(0, 10).join(' | ')}`);
}

main()
  .catch((e) => { console.error('失败:', e?.message ?? e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
