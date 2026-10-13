/**
 * 阶段 D / D1.1b：主链路实体 EntityLink 存量回填
 *
 * D1.1a 为 Quotation / BOM / PurchaseOrder / CustomsDeclaration / TaxRefund /
 * Opportunity 六类实体补齐了 sync 函数与服务挂载，但仅覆盖新增/变更流量。
 * 本脚本扫描存量记录，逐条调用对应 sync 函数（source: 'backfill-d1'），
 * 一次性补齐 EntityReference + EntityLink 双写。
 *
 * 特性：
 *   - 幂等：sync 函数使用确定性 ID upsert，重复执行不产生重复行
 *   - 仅扫描未软删记录（deletedAt: null）
 *   - 软删记录发出的关联由 deactivateEntityLinks 在各服务内处理，不在本脚本范围
 *
 * 用法：cd server && npx tsx scripts/backfill-entity-links.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  syncQuotationReferences,
  syncBomReferences,
  syncPurchaseOrderReferences,
  syncCustomsDeclarationReferences,
  syncTaxRefundReferences,
  syncOpportunityReferences,
} from '../src/entities/sync';

const SOURCE = 'backfill-d1';

(async () => {
  const prisma = new PrismaClient();

  console.log('=== D1.1b 主链路实体 EntityLink 存量回填 ===\n');

  const stats: Array<{ entity: string; scanned: number; refs: number; links: number }> = [];

  async function backfill(
    entity: string,
    rows: Array<Record<string, any>>,
    syncFn: (prisma: PrismaClient, row: any, options: { source: string }) => Promise<void>,
  ) {
    for (const row of rows) {
      await syncFn(prisma, row, { source: SOURCE });
    }
    const refs = await (prisma as any).entityReference.count({
      where: { ownerType: entity, deletedAt: null, status: 'active' },
    });
    const links = await (prisma as any).entityLink.count({
      where: { fromType: entity, deletedAt: null, status: 'active' },
    });
    stats.push({ entity, scanned: rows.length, refs, links });
    console.log(`  ${entity}: 扫描 ${rows.length} 条 → active refs ${refs} / links ${links}`);
  }

  // 1. Quotation（报价单）
  const quotations = await prisma.quotation.findMany({ where: { deletedAt: null } });
  await backfill('quotation', quotations, syncQuotationReferences);

  // 2. BOM（成本核算）
  const boms = await prisma.bOM.findMany({ where: { deletedAt: null } });
  await backfill('bom', boms, syncBomReferences);

  // 3. PurchaseOrder（采购单）
  const purchaseOrders = await prisma.purchaseOrder.findMany({ where: { deletedAt: null } });
  await backfill('purchaseOrder', purchaseOrders, syncPurchaseOrderReferences);

  // 4. CustomsDeclaration（报关单）
  const declarations = await prisma.customsDeclaration.findMany({ where: { deletedAt: null } });
  await backfill('customsDeclaration', declarations, syncCustomsDeclarationReferences);

  // 5. TaxRefund（出口退税）
  const taxRefunds = await prisma.taxRefund.findMany({ where: { deletedAt: null } });
  await backfill('taxRefund', taxRefunds, syncTaxRefundReferences);

  // 6. Opportunity（商机）
  const opportunities = await prisma.opportunity.findMany({ where: { deletedAt: null } });
  await backfill('opportunity', opportunities, syncOpportunityReferences);

  // 汇总
  const totalRefs = await (prisma as any).entityReference.count({
    where: { deletedAt: null, status: 'active' },
  });
  const totalLinks = await (prisma as any).entityLink.count({
    where: { deletedAt: null, status: 'active' },
  });

  console.log('\n=== Summary ===');
  console.log(`回填实体类型: ${stats.length}（quotation/bom/purchaseOrder/customsDeclaration/taxRefund/opportunity）`);
  console.log(`扫描记录总数: ${stats.reduce((s, r) => s + r.scanned, 0)}`);
  console.log(`全库 active EntityReferences: ${totalRefs}`);
  console.log(`全库 active EntityLinks: ${totalLinks}`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error('backfill failed:', e);
  process.exit(1);
});
