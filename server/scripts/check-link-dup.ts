/**
 * check-link-dup.ts —— EntityLink **只读**核查工具（本仓既有件，F2 扩了一个模式）
 *
 * 用法（cd server）：
 *   npx tsx scripts/check-link-dup.ts              # ① 既有行为：打印某个 DEMO 订单的 active link
 *   npx tsx scripts/check-link-dup.ts --orphans    # ② F2 新增：orderLine 图谱孤儿存量清点（Task 7 复审 F2）
 *
 * ★ 两种模式都**只跑 SELECT**：全程 `SET TRANSACTION READ ONLY`，任何写入都会被 Postgres 直接拒。
 *   不做 backfill、不删行、不 UPDATE —— 回填是 `backfill-entity-links.ts` 的职责，本文件刻意不碰。
 *
 * ② 的由来（为什么要有这个数）：
 *   B14 修复（`35076222`）顺带发现 `deleteOrderLine` 的依赖守卫查 `EntityLink` 用的是
 *   `sourceType`/`sourceId` —— 这两个字段**不存在**（`prisma/schema.prisma:1781-1800` 只有
 *   `fromType`/`fromId`）⇒ 该查询每次调用恒抛 `PrismaClientValidationError`、被 `.catch(() => 0)` 吞掉
 *   ⇒ 守卫恒 0 ⇒ 恒跳过 `deactivateEntityLinks` ⇒ 紧接着**硬删** orderLine（`orderLineMutationService.ts:276`）。
 *   修完之后"以后不再产孤儿"，但**已经产了多少**没人数过 ⇒ 本模式给那个数。
 */
import { PrismaClient, Prisma } from '@prisma/client';

/** 本地库白名单：非 localhost 一律拒绝（生产禁连，与 `scripts/db-use.sh` 同护栏） */
function assertLocalDevDb(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL 未配置 —— 本脚本只连本地 dev 库，不做远程只读探测');
  const u = new URL(url);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
    throw new Error(`拒绝连接非本地库：host=${u.hostname}（F2 要求「Connect production is forbidden」）`);
  }
  return decodeURIComponent(u.pathname.replace(/^\//, ''));
}

async function orphanInventory(prisma: PrismaClient) {
  const db = assertLocalDevDb(process.env.DATABASE_URL);
  // 单一只读事务：事务内第一条语句即 `SET LOCAL transaction_read_only = ON`，
  // 之后任何写入都会被 Postgres 拒（本文件本身也只发 SELECT —— 双保险）。
  const rows = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe('SET LOCAL transaction_read_only = ON');
    return tx.$queryRaw<
      Array<{
        db: string; sample_time: Date;
        lines_total: number; links_all: number; links_active: number; links_orphan: number; lines_with_links: number;
        refs_all: number; refs_active: number; refs_orphan: number;
        ctrl_voucher_active: number; ctrl_voucher_orphan: number;
      }>
    >(Prisma.sql`
    SELECT
      current_database()                                                    AS db,
      now()                                                                 AS sample_time,
      (SELECT count(*)::int FROM "OrderLine")                              AS lines_total,
      -- EntityLink：fromType='orderLine' 指向已不存在的 OrderLine.id
      (SELECT count(*)::int FROM "EntityLink"
        WHERE "fromType"='orderLine')                                      AS links_all,
      (SELECT count(*)::int FROM "EntityLink"
        WHERE "fromType"='orderLine' AND status='active'
          AND "deletedAt" IS NULL)                                         AS links_active,
      (SELECT count(*)::int FROM "EntityLink" l
        WHERE l."fromType"='orderLine' AND l.status='active'
          AND l."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "OrderLine" o WHERE o.id = l."fromId")) AS links_orphan,
      (SELECT count(DISTINCT l."fromId")::int FROM "EntityLink" l
        WHERE l."fromType"='orderLine' AND l.status='active'
          AND NOT EXISTS (SELECT 1 FROM "OrderLine" o WHERE o.id = l."fromId")) AS lines_with_links,
      -- EntityReference：ownerType='orderLine' 同一口径（Minor 6 的关联窗口）
      (SELECT count(*)::int FROM "EntityReference"
        WHERE "ownerType"='orderLine')                                     AS refs_all,
      (SELECT count(*)::int FROM "EntityReference"
        WHERE "ownerType"='orderLine' AND status='active'
          AND "deletedAt" IS NULL)                                         AS refs_active,
      (SELECT count(*)::int FROM "EntityReference" r
        WHERE r."ownerType"='orderLine' AND r.status='active'
          AND r."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "OrderLine" o WHERE o.id = r."ownerId")) AS refs_orphan,
      -- ★ 对照组（G6.4：证明上面那个反连接**能**返回非零 ⇒ orderLine 的 0 不是查询写错造成的假零）：
      --   同一形状套在 paymentVoucher 上。本仓另有若干 ownerType 的同族存量，属**另册**、与 F2 无关。
      (SELECT count(*)::int FROM "EntityLink"
        WHERE "fromType"='paymentVoucher' AND status='active' AND "deletedAt" IS NULL) AS ctrl_voucher_active,
      (SELECT count(*)::int FROM "EntityLink" l
        WHERE l."fromType"='paymentVoucher' AND l.status='active'
          AND l."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "PaymentVoucher" v WHERE v.id = l."fromId")) AS ctrl_voucher_orphan
    `);
  });
  const r = rows[0];
  console.log('=== F2：orderLine 图谱孤儿存量清点（只读）===');
  console.log(`库=${r.db}（配置指向 ${db}）· 取样时间=${r.sample_time.toISOString()}`);
  console.log(`判据口径：active = status='active' AND deletedAt IS NULL；孤儿 = 指向的 OrderLine 行已不存在`);
  console.log(`OrderLine 现存行数            : ${r.lines_total}`);
  console.log(`EntityLink   fromType=orderLine: 全部 ${r.links_all} · active ${r.links_active} · `
    + `孤儿(指向已删行) ${r.links_orphan} · 涉及行数 ${r.lines_with_links}`);
  console.log(`EntityReference ownerType=orderLine: 全部 ${r.refs_all} · active ${r.refs_active} · `
    + `孤儿 ${r.refs_orphan}`);
  console.log(`对照组（同形状 · fromType=paymentVoucher）: active ${r.ctrl_voucher_active} · 孤儿 ${r.ctrl_voucher_orphan}`
    + (r.ctrl_voucher_orphan > 0 ? ' ⇒ 本反连接**能**出非零，上面的 0 是真 0' : ' ⇒ ⚠️ 对照组也 0，本次无法排除假零'));
  if (r.links_all === 0 && r.refs_all === 0) {
    console.log('⚠️ 本库根本没有 orderLine 归属的 link/ref ⇒ 孤儿 0 的含义是"无存量可伤"，**不等于**"缺陷无后果"。'
      + '\n   写侧要两个条件同时成立才产行：① `syncOrderLineEntityReferences` 要求 `materialCode` 非空'
      + '（`sync.ts:239-240` 早退）；② 该行必须是经 `createOrderLine`/`updateOrderLine` 服务路径写的'
      + '（`orderLineMutationService.ts:119/:198` 才调 sync）。本库 `EntityLink.source` 里没有任何 `route:order-line:*`'
      + ' ⇒ 现存 orderLine 全是 seed 直灌，从没走过服务路径。');
    console.log('   ⇒ 换库（含生产）必须重跑本模式，且**只能由持连接的人跑**；生产禁连（P1），本报告不声称生产为 0。');
  }
  return r;
}

(async () => {
  const prisma = new PrismaClient();
  const orphans = process.argv.includes('--orphans');

  if (orphans) {
    await orphanInventory(prisma);
    await prisma.$disconnect();
    return;
  }

  // Look at one order: DEMO-PO-2601001
  const links = await (prisma as any).entityLink.findMany({
    where: { fromType: 'order', fromId: 'DEMO-PO-2601001', deletedAt: null },
    select: { id: true, linkKind: true, toType: true, toId: true, source: true },
  });
  console.log('Links for DEMO-PO-2601001:');
  for (const l of links) console.log('  ' + l.id + ' [' + l.linkKind + '→' + l.toType + ':' + l.toId + '] src=' + l.source);
  await prisma.$disconnect();
})();
