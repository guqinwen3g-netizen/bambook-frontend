// 演练造数 · 给"毛利口径"造成本（可回滚）
//
// 为什么需要它：驾驶舱的毛利 = 收入 − 成本，而
//   收入 = shipmentAmount ?? orderAmountOf(o)
//   成本 = supplierInvoiceAmount ?? (purchasePrice × quantity)     ← dashboardService.ts:425-461
// 实测（2026-09-25）：1069 张订单 **一张都没有** 成本 ⇒ 毛利全 null ⇒ 驾驶舱 69 行整片被排除。
// 这不是代码问题、是数据问题 ⇒ 按 M3 的本职（构造模拟单）在这里补上。
//
// ★ 本脚本只动 `Order.purchasePrice` 一个字段，**原值记档、`--revert` 逐张还原**。
//   ⚠️ `Order` 上没有可放 `DRILL-` 标识的列 ⇒ 标识落在状态文件（`/tmp/margin-cost-drill-state.json`），
//      这是本脚本的已知弱点：**状态文件丢了就还原不了**（所以它每次 apply 先拒绝覆盖已有状态文件）。
//
// 用法：
//   node scripts/seed-margin-cost-drill.mjs --apply [--n=3]
//   node scripts/seed-margin-cost-drill.mjs --revert
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
// ★ S4 任务3：收入口径 ⇒ 走唯一真源（原写法 `contractAmount ?? quoteAmount` 不在真源次序里）。
//   注意：**显式带 .ts** —— node ≥22.18 默认类型剥离，`.mjs` 可直接 import TS 真源。
import { orderAmountOf } from '../server/src/shared/orderAmount.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.resolve(HERE, '..', 'server') + '/');
loadEnvForScript();
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

const STATE = '/tmp/margin-cost-drill-state.json';
const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const N = Number((process.argv.find((a) => a.startsWith('--n='))?.slice(4)) || 3);

/** 名义汇率：只用来把成本定在"收入的 ~65%"这个像样的量级上，不参与任何判据。 */
const NOMINAL = { USD: 7.1, EUR: 7.7, CNY: 1 };

async function apply() {
  if (fs.existsSync(STATE)) { console.log(`✗ 状态文件已存在（${STATE}）⇒ 先 --revert 再 apply（拒绝覆盖）`); process.exit(2); }
  // ★ v3.91：窗口内 69 张**全是跨币种**（采购 CNY / 销售 USD·EUR）⇒ `crossCurrency=false` 那条分支无数据可验。
  //   `--same-currency` 挑一张订单把 `purchaseCurrency` 设成与销售币种相同，专门覆盖那条分支。
  const SAME = process.argv.includes('--same-currency');
  const rows = await prisma.order.findMany({
    where: { purchaseCurrency: { not: null }, purchasePrice: null, status: { not: 'Cancelled' } },
    select: { id: true, currency: true, purchaseCurrency: true, quantity: true, contractAmount: true, quoteAmount: true },
    orderBy: { id: 'asc' },
    take: SAME ? 1 : N,
  });
  if (!rows.length) { console.log('✗ 没有可用的靶子订单（都已有 purchasePrice？）'); process.exit(1); }
  const rec = [];
  for (const o of rows) {
    const revenue = orderAmountOf(o);
    const qty = Number(o.quantity) || 1;
    // ★ 目标：采购成本 ≈ 收入的 65%（**业务形态**：正毛利、不要造出 −361% 那种不像话的数）。
    //   跨币种时成本以采购币种计、再由应用折算 ⇒ 用名义汇率估每单位价；
    //   **同币种时成本与收入同币** ⇒ 不能再乘汇率（第一版这里错了，造出 cost≈4.6×收入、毛利 −208050）。
    const rate = SAME ? 1 : (NOMINAL[String(o.currency).toUpperCase()] ?? 7.1);
    // 目标：采购成本 ≈ 收入的 65%（折 CNY 前用名义汇率估），换算成"每单位采购价"
    const purchaseTotalCny = revenue * rate * 0.65;
    const purchasePrice = Math.round((purchaseTotalCny / qty) * 100) / 100;
    if (!(purchasePrice > 0)) { console.log(`✗ ${o.id} 算出的 purchasePrice 不是正数，跳过`); continue; }
    const beforePurchaseCurrency = o.purchaseCurrency;
    const patch = { purchasePrice: String(purchasePrice) };
    if (SAME) patch.purchaseCurrency = String(o.currency);
    await prisma.order.update({ where: { id: o.id }, data: patch });
    rec.push({ id: o.id, before: null, after: purchasePrice, beforePurchaseCurrency, afterPurchaseCurrency: SAME ? String(o.currency) : o.purchaseCurrency });
    console.log(`  ✓ ${o.id}  ${o.currency}->${SAME ? o.currency + '（同币种）' : o.purchaseCurrency}  qty=${qty}  purchasePrice := ${purchasePrice}`);
  }
  fs.writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), sameCurrency: SAME, rows: rec }, null, 2));
  console.log(`\n共改 ${rec.length} 张；原值记档 ${STATE}`);
  const after = await prisma.order.count({ where: { NOT: { purchasePrice: null } } });
  console.log(`全库带 purchasePrice 的订单数 = ${after}`);
}

async function revert() {
  if (!fs.existsSync(STATE)) { console.log(`✗ 找不到状态文件 ${STATE} ⇒ 无法还原（这正是本脚本的已知弱点）`); process.exit(2); }
  const { rows } = JSON.parse(fs.readFileSync(STATE, 'utf-8'));
  for (const r of rows) {
    const patch = { purchasePrice: r.before };
    if (r.beforePurchaseCurrency !== undefined) patch.purchaseCurrency = r.beforePurchaseCurrency;
    await prisma.order.update({ where: { id: r.id }, data: patch });
    console.log(`  ↩ ${r.id} purchasePrice := ${r.before}${r.beforePurchaseCurrency !== undefined ? ` · purchaseCurrency := ${r.beforePurchaseCurrency}` : ''}`);
  }
  fs.unlinkSync(STATE);
  const after = await prisma.order.count({ where: { NOT: { purchasePrice: null } } });
  console.log(`\n已还原 ${rows.length} 张并删除状态文件；全库带 purchasePrice 的订单数 = ${after}`);
}

(async () => {
  if (APPLY === REVERT) { console.log('用法：--apply [--n=3] 或 --revert'); process.exit(2); }
  try { await (APPLY ? apply() : revert()); } finally { await prisma.$disconnect(); }
})().catch((e) => { console.log(`✗ 异常：${e?.message || e}`); process.exit(1); });
