/**
 * seed-company-sim.ts — 竹衍服饰（PandaClothing）13 周真实公司数据模拟 seed（主编排）
 *
 * 剧情规模：
 *   - 主数据：海外客户 8（美/欧/日/澳）+ 信用额度/分层、国内供应商 10、货代 2、
 *     面料档案 24（成分行/MOQ/价格历史）、成衣档案 12、辅料 6
 *   - CRM：每客户 2-4 条跟进 + 5 个商机（3 家客户）
 *   - 开发案 12（含三级样衣节点，4 案已转订单）；MOQ 豁免审批 3 条（approved）
 *   - 订单 56 单（W1-W6 28 单 Delivered 全链 / W7-W9 14 单 / W10-W13 14 单，详见 orders.ts）
 *     + 面料外销 13 单（Fabric 业务线：7 Delivered / 2 Shipping / 2 Production / 1 Confirmed / 1 Pending，
 *     详见 fabric-orders.ts——含缸差扣款 3% / 分批出运 2 票 / 逾期催款 2 单剧情）
 *   - 二期跨域联动：报价 19 张（赢单 12 转订单）/ 采购→来料→入库→领料全链（L8 痕迹一致）+
 *     来料退换 1 张 / 报关单 38 张 + 单据归档 114 张 / QC 指派 34 条 + 第三方测试 12 张（2 fail 整改闭环）
 *   - HR 12 员工 + 生命周期事件 + 本月绩效周期；KB 6 篇；Insight 5 条；邮件 8 封（4 线程）
 *   - 关键节点 AuditLog（actor 全部为库内真实账号）
 *
 * 用法（cd server）：
 *   npx tsx scripts/seed-company-sim.ts --reset    # 先清库（reset-dev-business-data --apply）再 seed
 *   npx tsx scripts/seed-company-sim.ts            # 直接 seed（要求库已清或可幂等跳过）
 *
 * ID 约定：全部 SIM- 前缀（确定性 ID + 单据编号，与发号器区间避让）。
 */

import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const args = new Set(process.argv.slice(2));
const doReset = args.has('--reset');

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const url = (process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@');
    console.log('=== 竹衍服饰 13 周公司数据模拟 seed ===');
    console.log(`库: ${url}`);
    console.log(`模式: ${doReset ? 'RESET + SEED' : 'SEED ONLY'}\n`);

    if (doReset) {
      console.log('── 阶段 0：清库（reset-dev-business-data） ──');
      const { resetBusinessData } = await import('./reset-dev-business-data');
      const results = await resetBusinessData(prisma, { dryRun: false });
      const total = results.reduce((s, r) => s + Math.max(0, r.count), 0);
      console.log(`清库完成，删除 ${total} 行。\n`);
    }

    console.log('── 阶段 1：主数据 ──');
    const { seedMasterData } = await import('./company-sim/master-data');
    const md = await seedMasterData(prisma);

    console.log('── 阶段 2：订单 56 单全链 ──');
    const { seedOrders } = await import('./company-sim/orders');
    const { plans } = await seedOrders(prisma, md);

    console.log('── 阶段 2.1：面料外销订单 13 单（Fabric 业务线全链） ──');
    const { seedFabricOrders } = await import('./company-sim/fabric-orders');
    const { fabricPlans } = await seedFabricOrders(prisma, md);
    // 下游统一消费：成衣 plans 在前（既有 ID 顺序不变），面料 plans 追加在后
    const allPlans = [...plans, ...fabricPlans];

    console.log('── 阶段 2.5：报价单（赢单 12 转订单 + 未赢单 7 + 面料报价 4） ──');
    const { seedQuotations } = await import('./company-sim/quotations');
    await seedQuotations(prisma, allPlans, md);

    console.log('── 阶段 2.6：采购→来料→入库→生产领料（L8 痕迹一致 + 来料退换） ──');
    const { seedProcurementInventory } = await import('./company-sim/procurement-inventory');
    await seedProcurementInventory(prisma, allPlans, md);

    console.log('── 阶段 2.7：报关单 + 单据中心归档（成衣 38 票 + 面料 10 票） ──');
    const { seedTradeDocs } = await import('./company-sim/trade-docs');
    await seedTradeDocs(prisma, allPlans);

    console.log('── 阶段 2.8：QC 指派 + 第三方测试（fail→整改闭环） ──');
    const { seedQcAndTests } = await import('./company-sim/qc-tr');
    await seedQcAndTests(prisma, allPlans);

    console.log('── 阶段 2.85：供应商工厂域（FactoryProfile/评估/认证/产能日历，评估锚点实查订单链） ──');
    const { seedSuppliersFactory } = await import('./company-sim/suppliers-factory');
    await seedSuppliersFactory(prisma);

    console.log('── 阶段 3：CRM + 开发案 + 审批 ──');
    const { seedCrmAndDev } = await import('./company-sim/crm-dev');
    await seedCrmAndDev(prisma, allPlans);

    console.log('── 阶段 4：HR + KB + Insight + 邮件 ──');
    const { seedHrKbEmailInsight } = await import('./company-sim/hr-kb');
    await seedHrKbEmailInsight(prisma, allPlans);

    console.log('── 阶段 4.1：生产域补数（BOM / MES 排产 / 订单变更 / 询价） ──');
    const { seedProductionExtras } = await import('./company-sim/production-extras');
    await seedProductionExtras(prisma);

    console.log('── 阶段 4.2：季节 + 趋势 + 展会 + 营销（线索→订单闭环） ──');
    const { seedSeasonMarketing } = await import('./company-sim/season-marketing');
    await seedSeasonMarketing(prisma);

    console.log('── 阶段 4.3：样品间（样卡/借出含逾期）+ 财务补数（付款申请/VAT/结汇） ──');
    const { seedSampleFinance } = await import('./company-sim/sample-finance');
    await seedSampleFinance(prisma);

    console.log('── 阶段 4.4：HR 薪资批次 + 孤儿阶段清理 ──');
    const { seedHrExtras, cleanupOrphanStages } = await import('./company-sim/hr-extras');
    await seedHrExtras(prisma);
    const removedStages = await cleanupOrphanStages(prisma);
    if (removedStages > 0) console.log(`  清理孤儿阶段记录 ${removedStages} 行`);

    console.log('── 阶段 4.5：HR 组织域（跟单角色挂接 + 岗位/培训/考勤补数） ──');
    const { seedHrOrg } = await import('./company-sim/hr-org');
    await seedHrOrg(prisma);

    console.log('── 阶段 5：AuditLog 审计留痕 ──');
    const { seedAuditLogs } = await import('./company-sim/audit');
    await seedAuditLogs(prisma, allPlans);

    console.log('── 阶段 5.5：产品档案 EntityLink 入图（42 档案） ──');
    // seed 直写了产品档案的 Relation FK，backfill-product-relation-fks 会幂等跳过；
    // 此处主动触发 syncProductAssetReferences 完成产品域 EntityLink/EntityReference 双写入图。
    const { syncProductAssetReferences } = await import('../src/entities/sync');
    const assets = await prisma.productAsset.findMany({
      where: { deletedAt: null },
      include: { fabricProfile: true, garmentProfile: true, trimmingProfile: true },
    });
    for (const a of assets) {
      await syncProductAssetReferences(prisma, a as any, { source: 'seed-company-sim' });
    }
    console.log(`  产品入图完成: ${assets.length} 档案`);

    console.log('── 阶段 6：自检（逐表 count + 抽单全链） ──');
    const { verifySeed } = await import('./company-sim/verify');
    await verifySeed(prisma);

    console.log('\n✅ seed-company-sim 完成。后续请执行：');
    console.log('   npx tsx scripts/backfill-entity-links.ts');
    console.log('   npx tsx scripts/backfill-references.ts');
    console.log('   npx tsx scripts/backfill-product-relation-fks.ts');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n❌ seed 失败:', err);
  process.exit(1);
});
