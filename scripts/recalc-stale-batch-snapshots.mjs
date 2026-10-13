/**
 * 批次结算快照收敛 —— 把 OrderShipmentBatch 的派生快照
 * (invoicedAmount / paidAmount / settleStatus / settledAt) 按当前真源重算一遍。
 *
 * 为什么需要它：
 *   快照是**派生数据**，由 shipmentBatchSettlementHook 在「核销变动 / 发票创建 / 发票更新」
 *   时回写。历史上挂点有过缺口（例如 2026-09-17 修的「作废发票走 POST /:id/cancel 不回冲」），
 *   期间产生的**存量**快照会停在错值上。修复只保证今后不再产生，存量要单独收敛一次。
 *
 * 安全性：
 *   - 默认 **dry-run**：只读，打印「快照现值 vs 按真源算出的期望值」的差异，不写任何东西。
 *   - `--apply` 才写：对全部批次调用服务自身 `recalcSettlement`（幂等、纯派生回写），
 *     跑完再独立复核一遍差异是否归零。
 *   - 只碰 OrderShipmentBatch 的派生字段，不动任何业务单据 / 发票 / 核销 / 金额。
 *
 * 用法：
 *   node scripts/recalc-stale-batch-snapshots.mjs            # dry-run
 *   node scripts/recalc-stale-batch-snapshots.mjs --apply    # 收敛
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const APPLY = process.argv.includes('--apply');
// --only=id1,id2 ：只收敛指定批次（默认全部）。用于「只动已确认范围」，避免顺手改掉未确认的数据。
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith('--only='));
  if (!a) return null;
  const ids = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
})();
const serverRoot = '/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server';
const requireFromServer = createRequire(path.join(serverRoot, 'package.json'));
const { PrismaClient } = requireFromServer('@prisma/client');

const envFile = path.join(serverRoot, '.env');
let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && fs.existsSync(envFile)) {
  for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/.exec(l);
    if (m) { databaseUrl = m[1].trim().replace(/^["']|["']$/g, ''); break; }
  }
}
if (!databaseUrl) { console.log('✗ 拿不到 DATABASE_URL'); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const num = (v) => (v == null ? 0 : Number(v));
const line = (s) => console.log(s);
const hr = (t) => { line(''); line('═'.repeat(72)); line(t); line('═'.repeat(72)); };

/**
 * 按真源算出每个批次的期望快照。
 * 口径镜像 server/src/shipping/orderShipmentBatchService.ts 的 recalcSettlement：
 *   invoiced = Σ(该批次 IOA 行.allocatedAmount ?? 发票.amount)，排除已作废发票
 *   paid     = Σ(上述发票的 InvoiceAllocation.appliedAmount)，排除已作废发票
 *   settleStatus 由 paid vs batch.amount 派生
 * ⚠️ 这是「期望值」的只读镜像，仅用于 dry-run 报告；--apply 走服务自身实现，不依赖本函数。
 */
async function computeExpected() {
  const batches = await prisma.orderShipmentBatch.findMany({
    where: { deletedAt: null },
    select: { id: true, batchNo: true, orderId: true, amount: true, invoicedAmount: true, paidAmount: true, settleStatus: true },
  });
  const ioa = await prisma.invoiceOrderAllocation.findMany({
    where: { deletedAt: null, batchId: { not: null } },
    select: { batchId: true, invoiceId: true, allocatedAmount: true },
  });
  const ioaByBatch = new Map();
  for (const r of ioa) {
    if (!ioaByBatch.has(r.batchId)) ioaByBatch.set(r.batchId, []);
    ioaByBatch.get(r.batchId).push(r);
  }
  const allInvoiceIds = [...new Set(ioa.map((r) => r.invoiceId))];
  const invs = allInvoiceIds.length
    ? await prisma.invoice.findMany({ where: { id: { in: allInvoiceIds } }, select: { id: true, amount: true, status: true } })
    : [];
  const invMap = new Map(invs.map((i) => [i.id, i]));
  const allocs = allInvoiceIds.length
    ? await prisma.invoiceAllocation.findMany({ where: { invoiceId: { in: allInvoiceIds } }, select: { invoiceId: true, appliedAmount: true } })
    : [];

  const out = [];
  for (const b of batches) {
    const rows = ioaByBatch.get(b.id) ?? [];
    let invoiced = 0;
    for (const r of rows) {
      const inv = invMap.get(r.invoiceId);
      if (!inv || inv.status === 'Cancelled') continue;
      invoiced += r.allocatedAmount != null ? num(r.allocatedAmount) : num(inv.amount);
    }
    const activeIds = new Set(rows.filter((r) => invMap.get(r.invoiceId)?.status !== 'Cancelled').map((r) => r.invoiceId));
    let paid = 0;
    for (const a of allocs) {
      if (!activeIds.has(a.invoiceId)) continue;
      paid += num(a.appliedAmount);
    }
    const amount = b.amount != null ? num(b.amount) : null;
    let settleStatus = b.settleStatus;
    if (amount != null && amount > 0) {
      const eps = 1e-6;
      settleStatus = paid >= amount - eps ? 'settled' : paid > eps ? 'partially_settled' : 'unsettled';
    }
    out.push({
      id: b.id, batchNo: b.batchNo, orderId: b.orderId,
      // ★ actual 必须读**库里存的值**；曾经误把算出来的 invoiced/paid 塞进 actual，
      //   导致 actual ≡ expected、金额差异永远测不出来，只剩 settleStatus 能比对
      //   —— 一个「空过的验证器」。改这里前先想清楚哪个是「现值」哪个是「期望值」。
      actual: { invoiced: num(b.invoicedAmount), paid: num(b.paidAmount), settleStatus: b.settleStatus },
      expected: { invoiced, paid, settleStatus },
    });
  }
  return out;
}

function diffOf(rows) {
  return rows.filter(
    (r) =>
      Math.abs(r.actual.invoiced - r.expected.invoiced) > 0.005 ||
      Math.abs(r.actual.paid - r.expected.paid) > 0.005 ||
      r.actual.settleStatus !== r.expected.settleStatus,
  );
}

let exitCode = 0;
try {
  hr(`批次结算快照收敛 —— ${APPLY ? '★ APPLY（会写库）' : 'dry-run（只读）'}`);
  const before = await computeExpected();
  const stale = diffOf(before);
  line(`   批次总数：${before.length}`);
  line(`   快照与真源不符：${stale.length}`);
  for (const r of stale) {
    line(`     ⚠ ${r.id} (批次#${r.batchNo})`);
    line(`        现值 invoiced=${r.actual.invoiced} paid=${r.actual.paid} status=${r.actual.settleStatus}`);
    line(`        期望 invoiced=${r.expected.invoiced} paid=${r.expected.paid} status=${r.expected.settleStatus}`);
  }

  if (!APPLY) {
    hr('dry-run 结束（未写任何数据）。加 --apply 执行收敛。');
  } else {
    hr('执行收敛（调用**服务自身** recalcSettlement，幂等）');
    // 用 ts-node 直接加载服务端实现 —— 刻意**不复刻**业务逻辑到本脚本，
    // 否则脚本的"期望值"与服务的真实算法会各自漂移，收敛就成了自证。
    const tsNode = requireFromServer('ts-node');
    tsNode.register({
      transpileOnly: true,
      dir: serverRoot,
      project: path.join(serverRoot, 'tsconfig.json'),
    });
    const { createOrderShipmentBatchService } = requireFromServer(
      path.join(serverRoot, 'src', 'shipping', 'orderShipmentBatchService.ts'),
    );
    const batchSvc = createOrderShipmentBatchService(prisma);
    const scope = ONLY ? before.filter((r) => ONLY.has(r.id)) : before;
    if (ONLY) line(`   --only 限定：${scope.length}/${before.length} 个批次（其余不动）`);
    let changed = 0;
    for (const r of scope) {
      const res = await batchSvc.recalcSettlement(r.id);
      if (res?.ok) changed++;
      else line(`     ✗ ${r.id} recalc 失败：${JSON.stringify(res?.error)}`);
    }
    line(`   已对 ${changed}/${scope.length} 个批次执行 recalcSettlement`);

    hr('独立复核（重新按真源比对）');
    const after = await computeExpected();
    const still = diffOf(after);
    const stillInScope = ONLY ? still.filter((r) => ONLY.has(r.id)) : still;
    line(`   仍不符（全库）：${still.length}；其中本次 scope 内：${stillInScope.length}`);
    for (const r of still) {
      const mark = ONLY && !ONLY.has(r.id) ? '（不在本次 scope，未处理）' : '✗';
      line(`     ${mark} ${r.id} 现值 invoiced=${r.actual.invoiced} paid=${r.actual.paid} status=${r.actual.settleStatus} / 期望 invoiced=${r.expected.invoiced} paid=${r.expected.paid} status=${r.expected.settleStatus}`);
    }
    if (stillInScope.length === 0) line('   ✅ 本次 scope 内全部收敛');
    else exitCode = 1;
  }
} catch (e) {
  console.log('✗ 失败：', e?.message ?? e);
  exitCode = 1;
} finally {
  await prisma.$disconnect();
  process.exit(exitCode);
}
