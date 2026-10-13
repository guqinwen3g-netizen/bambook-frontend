/**
 * backfill-tax-refunds.ts — 存量已放行报关单退税草稿回填（一次性）。
 *
 * 背景：L10 联动（CustomsCleared → createTaxRefundFromDeclaration）只在真实
 * transitionDeclarationStatus → Released 路径上触发；模拟数据 seed 曾直接以
 * status='Released' create 报关单，绕过状态机 → 事件从未发布 → 退税草稿缺失。
 *
 * 本脚本：
 *   1. 找出全部 status='Released' 且无退税单（deletedAt=null）的报关单；
 *   2. 逐张复用 customsService.createTaxRefundFromDeclaration 生成 Draft 草稿
 *      （FOB×汇率×HS 退税率加权核算，与手动「一键退税草稿」/L10 自动路径同一真源；
 *      幂等：已存在退税单的票自动跳过，重复运行无副作用）；
 *   3. 输出回填报告。
 *
 * 用法：
 *   npx tsx scripts/backfill-tax-refunds.ts            # dry-run 仅报告
 *   npx tsx scripts/backfill-tax-refunds.ts --apply    # 实际回填
 */
import { PrismaClient } from '@prisma/client';
import { createCustomsService } from '../src/customs/customsService';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const svc = createCustomsService(prisma as any);

  const released = await prisma.customsDeclaration.findMany({
    where: { status: 'Released', deletedAt: null },
    select: { id: true, declarationNumber: true },
    orderBy: { declarationNumber: 'asc' },
  });
  const existing = await prisma.taxRefund.findMany({
    where: { deletedAt: null },
    select: { declarationId: true },
  });
  const covered = new Set(existing.map((r) => r.declarationId));
  const pending = released.filter((d) => !covered.has(d.id));

  console.log(`[backfill-tax-refunds] 已放行报关单 ${released.length} 张，已有退税单 ${covered.size} 张，待回填 ${pending.length} 张`);
  if (pending.length === 0) {
    console.log('[backfill-tax-refunds] 无需回填');
    return;
  }
  if (!apply) {
    for (const d of pending) console.log(`  [dry-run] ${d.declarationNumber} (${d.id})`);
    console.log('[backfill-tax-refunds] dry-run 结束，加 --apply 执行回填');
    return;
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const d of pending) {
    try {
      const refund = await svc.createTaxRefundFromDeclaration(d.id, 'system');
      ok += 1;
      console.log(`  ✓ ${d.declarationNumber} → ${refund.refundNumber}（refundAmount=${refund.refundAmount?.toString() ?? 'null'}）`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('不可重复生成')) {
        skipped += 1;
      } else {
        failed += 1;
        console.log(`  ✗ ${d.declarationNumber}: ${msg}`);
      }
    }
  }
  console.log(`[backfill-tax-refunds] 回填完成：成功 ${ok}，幂等跳过 ${skipped}，失败 ${failed}`);
}

main()
  .catch((e) => {
    console.error('[backfill-tax-refunds] failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
