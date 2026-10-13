// ① 走查件（**手动件，不住门禁**）：利润表那一屏的「库 → 格式化 → 屏面」三方对撞。
//
// 为什么要在仓里留这一份：〇·补23/24 那两轮的逐格数此前跑在 /tmp 的一次性脚本上，
// 文件一没就被下一批继承成"文档里说对过"——那是 [[文档状态陈述与探针会腐烂]] 那一族。
// ★ 三段各走自己的通道，谁都不是谁的手抄：屏面串来自 browser-use 落盘的 JSON、
//   库值由 prisma 直读、格式化 **import 仓里那份 `lib/moneyFormat.ts` 真身**。
//
// 屏面那一段怎么抓（这一步需要有人在浏览器里，门禁给不了）：
//   `:3002` 登录后 → `定价与利润 → 利润表 Profit Sheets → 左列点某一张单`，
//   再执行本文件顶部注释下方那段 evaluate 脚本，把结果存成 JSON：
//     async () => { const els=[...document.querySelectorAll('button,[role=button],li,tr')]
//         .filter(e=>(e.innerText||'').includes('SIM-ORD-004')); els[0].click();
//         await new Promise(r=>setTimeout(r,1300));
//         const cells=[...document.querySelectorAll('.bds-inset')].map(d=>{
//           const p=[...d.querySelectorAll('p')].map(x=>(x.innerText||'').trim());
//           return p.length>=2 ? p[0]+' = '+p[1] : null; }).filter(Boolean);
//         return JSON.stringify({cells}); }
//
// 用法：
//   npx tsx scripts/attest-profit-sheet-screen.ts SIM-ORD-004 /tmp/shot.json
//   ★ 它连的是**库**，不是 :8090 那个进程 ⇒ env 必须先注入（见 `docs/M3覆盖面-四把尺-取证`）
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { SERVER_DIR, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import { formatMoneyText } from '../lib/moneyFormat.ts';

loadEnvForScript();
const req = createRequire(SERVER_DIR + '/');
const { PrismaClient } = req('@prisma/client');

const ORDER = process.argv[2];
const FILE = process.argv[3];
if (!ORDER || !FILE) {
  console.log('用法：npx tsx scripts/attest-profit-sheet-screen.ts <orderId> <屏面落盘的 json>');
  process.exit(1);
}

const outer = JSON.parse(readFileSync(FILE, 'utf8'));
const screen = typeof outer === 'string' ? JSON.parse(outer) : outer;
const cells: Record<string, string> = {};
for (const c of screen.cells ?? []) {
  const i = c.indexOf(' = ');
  if (i > 0) cells[c.slice(0, i)] = c.slice(i + 3);
}
if (!cells.销售收入) { console.log('✗ 落盘的那份里没抓到「销售收入」⇒ 抓取脚本的落点不对'); process.exit(1); }

// 卡片 label → 取哪一份数（★ 折让/手续费那两格屏面读的是 `details` 里的**标量副本**，不是同名列）
const PAIRS: [string, (r: any) => unknown][] = [
  ['销售收入', (r) => r.salesRevenue],
  ['采购成本', (r) => r.purchaseCost],
  ['运费', (r) => r.freightCost],
  ['杂费', (r) => r.miscCost],
  ['折让', (r) => r.details.allowanceCost],
  ['银行手续费', (r) => r.details.bankFeeCost],
  ['毛利', (r) => r.grossProfit],
];

async function main() {
  const prisma = new PrismaClient();

  const row: any = await prisma.orderProfitSheet.findUnique({ where: { orderId: ORDER } });
  if (!row) { console.log(`✗ 库里没有 ${ORDER} 这张利润表`); await prisma.$disconnect(); process.exit(1); }
  const cur = String(row.baseCurrency);
  console.log(`\n═══ 利润表屏面三方对撞 · 订单 ${ORDER} · baseCurrency=${cur} ═══`);
  console.log(`   屏面抓到 ${Object.keys(cells).length} 格：${Object.keys(cells).join(' / ')}`);

  const bad: string[] = [];
  for (const [label, pick] of PAIRS) {
    const dbv = pick(row);
    const want = formatMoneyText(Number(dbv), cur);
    const got = cells[label];
    if (want !== got) bad.push(`${label}: 库 ${dbv} → 该显示「${want}」｜屏上「${got}」`);
    console.log(`  ${want === got ? '✓' : '✗'} ${label}: 库 ${dbv}｜该显示「${want}」｜屏上「${got ?? '(没抓到)'}」`);
  }
  const rateWant = row.grossMargin == null ? '—' : `${Number(row.grossMargin).toFixed(2)}%`;
  if (rateWant !== cells.毛利率) bad.push(`毛利率: 库 ${row.grossMargin} → ${rateWant}｜屏上 ${cells.毛利率}`);
  console.log(`  ${rateWant === cells.毛利率 ? '✓' : '✗'} 毛利率: 库 ${row.grossMargin}｜该显示「${rateWant}」｜屏上「${cells.毛利率 ?? '(没抓到)'}」`);

  // ★ 用户拿计算器按的那一下：用**屏上**的数做减法，必须等于屏上的"毛利"那一格
  const num = (s: string) => Number(s.replace(/[^\d.\-]/g, ''));
  const costs = ['采购成本', '运费', '杂费', '折让', '银行手续费'];
  if (costs.every((k) => cells[k] != null)) {
    const fromScreen = num(cells.销售收入) - costs.reduce((a, k) => a + num(cells[k]), 0);
    const tie = Math.abs(fromScreen - num(cells.毛利)) < 0.005;
    if (!tie) bad.push(`屏面相加 ${fromScreen.toFixed(2)} ≠ 屏上毛利 ${cells.毛利}`);
    console.log(`  ${tie ? '✓' : '✗'} 屏面相加：收入 −（${costs.join(' + ')}）= ${fromScreen.toFixed(2)}｜屏上毛利「${cells.毛利}」`);
  } else console.log('  ⏷ 屏面相加：有成本格的值被遮罩 ⇒ 这一格跑不了（不许读成通过）');

  await prisma.$disconnect();
  console.log(`\n═══ 结论：${bad.length === 0 ? '逐格对上' : bad.length + ' 处对不上'} ═══`);
  for (const b of bad) console.log('  ✗ ' + b);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.log('✗ 异常：' + (e?.message ?? e)); process.exit(1); });
