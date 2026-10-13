/**
 * audit-order-amount.ts — 真库「订单金额」稽核（上线验收工具）
 *
 * 为什么存在：`shared/orderAmount.ts` 是真源，但真源只能保证**取值口径**一致，
 * 保证不了**库里存量数据**自洽。上线前必须拿真库扫一遍：
 * 主档金额（totalNet / contractAmount / quoteAmount）与 Σ明细行是否互相矛盾。
 * 矛盾 = 同一张单在不同页面会显示不同数字 = 错账风险（口径级缺陷）。
 *
 * 用法：cd server && npx tsx scripts/audit-order-amount.ts
 * 退出码：0 = 自洽；1 = 发现矛盾（可作门禁用）
 */
import { PrismaClient } from '@prisma/client';
import { orderAmountOf, findOrderAmountConflict } from '../src/shared/orderAmount';

const prisma = new PrismaClient();

interface Row {
  id: string;
  poNumber: string | null;
  customer: string;
  currency: string | null;
  salesCurrency: string | null;
  quoteAmount: unknown;
  totalNet: unknown;
  totalActual: unknown;
  contractAmount: unknown;
  /** ★ 2026-09-26（第 2 批 A）：自检已纳入单价族 ⇒ 稽核也必须取这两列，否则静默退化 */
  salesPrice: unknown;
  quantity: unknown;
  lines: Array<{ netValue: unknown; quantity: unknown; unitPrice: unknown; lineNumber: number }>;
}

async function main() {
  const orders = (await prisma.order.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      poNumber: true,
      customer: true,
      currency: true,
      salesCurrency: true,
      quoteAmount: true,
      totalNet: true,
      totalActual: true,
      contractAmount: true,
      salesPrice: true,
      quantity: true,
      lines: {
        select: { netValue: true, quantity: true, unitPrice: true, lineNumber: true },
        orderBy: { lineNumber: 'asc' },
      },
    },
  })) as unknown as Row[];

  const stats = {
    total: orders.length,
    withLines: 0,
    headerOnly: 0,
    conflicts: 0,
    zeroAmount: 0,
    noAmountAtAll: 0,
  };
  const conflictSamples: Array<Record<string, unknown>> = [];
  const zeroSamples: string[] = [];
  const noAmountSamples: string[] = [];

  for (const o of orders) {
    const hasLines = Array.isArray(o.lines) && o.lines.length > 0;
    if (hasLines) stats.withLines += 1;
    else stats.headerOnly += 1;

    const conflict = findOrderAmountConflict(o as never);
    if (conflict) {
      stats.conflicts += 1;
      if (conflictSamples.length < 15) {
        conflictSamples.push({
          po: o.poNumber ?? o.id,
          customer: o.customer,
          amount: orderAmountOf(o as never),
          ...conflict,
        });
      }
    }

    const amt = orderAmountOf(o as never);
    if (amt === 0) {
      // 0 有两种含义：真的报价 0，或三个来源全空。必须区分（0 会把「没取到」伪装成「金额是 0」）
      const allNull =
        o.totalNet == null && o.quoteAmount == null && o.contractAmount == null && !hasLines;
      if (allNull) {
        stats.noAmountAtAll += 1;
        if (noAmountSamples.length < 10) noAmountSamples.push(o.poNumber ?? o.id);
      } else {
        stats.zeroAmount += 1;
        if (zeroSamples.length < 10) zeroSamples.push(o.poNumber ?? o.id);
      }
    }
  }

  console.log('════════ 订单金额真库稽核 ════════');
  console.log(`订单总数（未删）        ${stats.total}`);
  console.log(`  有明细行              ${stats.withLines}`);
  console.log(`  仅表头（无明细行）     ${stats.headerOnly}`);
  console.log(`★ 主档/明细矛盾          ${stats.conflicts}`);
  console.log(`  金额恒为 0（有来源）   ${stats.zeroAmount}  样本: ${zeroSamples.join(', ') || '-'}`);
  console.log(`★ 三个金额来源全空       ${stats.noAmountAtAll}  样本: ${noAmountSamples.join(', ') || '-'}`);
  if (conflictSamples.length) {
    console.log('\n── 矛盾样本（口径级，同一单在不同页会显示不同值）──');
    for (const c of conflictSamples) console.log('  ', JSON.stringify(c));
  }
  console.log('\nJSON=' + JSON.stringify(stats));

  await prisma.$disconnect();
  process.exit(stats.conflicts > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('稽核失败:', e);
  await prisma.$disconnect();
  process.exit(2);
});
