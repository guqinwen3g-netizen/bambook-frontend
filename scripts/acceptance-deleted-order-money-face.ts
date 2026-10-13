/**
 * 作废单的钱到底去不去 —— **钱类出口的删除面**真库演练（v3.136 · ② 未清四条第 4 条剩余那一半）
 *
 * 为什么非造数据不可（v3.135 现量）：库里那 1000 张软删单名下 **0 条明细行、ΣnetValue=0**
 *   ⇒ 钱类出口"漏不漏 deletedAt"**今天读不出差别**（判据空转）。所以先造一张**带明细行**的单：
 *   phase 1 问"每一格看不看得见它"（这就是这一格的区分力证人），phase 2 作废它、问"钱有没有跟着走"。
 *
 * 四相：T0 基线 → 造 live 单（2 行明细，合计 14,250 USD）→ T1 → **走产品自己的 DELETE 路由**作废 → T2
 *        → 按精确 id 硬删自己写的行 → T3
 *
 * 判据形状（不许发通行证）：
 *   · phase 1 某格没动 ⇒ 那格对"作废单的钱"**没有区分力** ⇒ 报**缺口**（不是通过）
 *   · phase 2 某格没退回 T0 ⇒ 作废单的钱还留在数里 ⇒ 报红
 *   · 阳性对照：把 T2 挪 0.01 再比 ⇒ 必须**恰好**报出那一格（否则"逐格相等"是尺瞎了）
 *   · T3 ≠ T0 ⇒ 我污染了基线，报红
 *
 * 用法（本件必写库 ⇒ DATABASE_URL 必须在环境里）：
 *   CHAIN_BASE=http://127.0.0.1:8090 npx tsx scripts/acceptance-deleted-order-money-face.ts
 */
import { createRequire } from 'node:module';
import { demoLoginPassword } from './lib/demoCredential'; // v3.237 补 40：值只住在 env（缺了就红），源码里不留字面量
import { randomUUID } from 'node:crypto';

const req = createRequire(import.meta.url);
const XLSX = req('xlsx');
const { SERVER_DIR, loadEnvForScript } = await import('./lib/acceptance-selfcheck.mjs');
loadEnvForScript();
const { PrismaClient } = createRequire(SERVER_DIR + '/')('@prisma/client');

const BASE = (process.env.CHAIN_BASE ?? process.env.BAMBOOK_API ?? 'http://127.0.0.1:8090').replace(/\/+$/, '');
const OWNER = 'usr_demo_sales_a';
// 挂到**已存在的演示客户关系**上，这样应收那一格在 T0 就有行 ⇒ 增量看得见（不新增一行也能比）
const RELATION = 'SIM-CUS-06';
const DRILL_PO = `DRILL-DEL-${randomUUID().slice(0, 8)}`;
const LINES = [
  { lineNumber: 1, itemNo: 'DRILL-STY-A', description: '男式针织短袖 T 恤 / 白色 M-XXL', quantity: 1200, unit: 'PCS', unitPrice: 8.75, netValue: 10500 },
  { lineNumber: 2, itemNo: 'DRILL-STY-B', description: '同款领口罗纹 备用件', quantity: 300, unit: 'PCS', unitPrice: 12.5, netValue: 3750 },
];
const TOTAL = LINES.reduce((s, l) => s + l.netValue, 0);

const results = [];
const pass = (n, d = '') => { results.push(true); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push(false); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const gap = (n, d = '') => { results.push(null); console.log(`  ⓘ 缺口 ${n}${d ? ' — ' + d : ''}`); };
const trunc = (s, n = 150) => { const t = String(s); return t.length > n ? t.slice(0, n) + `…(${t.length})` : t; };

let token = null;
for (const email of ['jason.shen@bambook.local', 'charlie.qian@bambook.local']) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: demoLoginPassword() }),
  });
  const j = await r.json().catch(() => ({}));
  const t = j?.token ?? j?.data?.token ?? null;
  if (r.ok && t) { token = t; break; }
}
if (!token) { console.log('  ✗ 登录 — 演示账号不可用 ⇒ 无法取数'); process.exit(1); }
const H = { Authorization: `Bearer ${token}` };

/** 每格都取成"可比较的原语"（数字 / 字符串），不许偷偷夹零 */
async function snapshot() {
  const out = {};
  const xres = await fetch(`${BASE}/api/v2/orders?format=xlsx`, { headers: H });
  const g = XLSX.utils.sheet_to_json(XLSX.read(await xres.arrayBuffer(), { type: 'array' }).Sheets['订单台账'], { header: 1, defval: null });
  const head = (g[0] ?? []).map(String);
  const iKey = head.indexOf('订单号'), iAmt = head.indexOf('金额');
  const rows = g.slice(1).filter(r => r && r[iKey] != null);
  out.xlsxRows = rows.length;
  out.xlsxSum = Math.round(rows.reduce((s, r) => s + Number(r[iAmt] ?? 0), 0) * 100) / 100;

  const lres = await fetch(`${BASE}/api/v2/orders?limit=500`, { headers: H });
  out.listItems = (((await lres.json())?.items) ?? []).length;

  const cres = await fetch(`${BASE}/api/v1/dashboard/cockpit`, { headers: H });
  const cj = await cres.json();
  const c = cj?.data ?? cj;
  out.leaderboard = (c?.salesLeaderboard ?? [])
    .map(x => `${x.salesPerson ?? x.name}|${x.currency}|${x.orderCount}|${Math.round(Number(x.salesAmount ?? 0) * 100) / 100}`)
    .sort().join(' ; ');
  const mRows = c?.orderMargins?.rows ?? [];
  out.marginRows = mRows.length;
  out.marginExcluded = c?.orderMargins?.excludedCount ?? null;
  // ★ 毛利那一族的**钱**：totals[] 每币种一条 revenue/cost/margin（v3.138 前这套格只有"行数"，
  //   作废单要是留在毛利里我读不出来 ⇒ 现在读得出来）
  out.marginTotals = (c?.orderMargins?.totals ?? [])
    .map(x => `${x.currency}|r=${Math.round(Number(x.revenue) * 100) / 100}|c=${Math.round(Number(x.cost) * 100) / 100}|m=${Math.round(Number(x.margin) * 100) / 100}`)
    .sort().join(' ; ');
  out.marginWithCost = mRows.filter(x => x?.margin != null).length;
  // ★ 应收这几格在 v3.136 第一版跑错过一次：我以为行上有 `openAmount`/`amount`，现查 cockpit ⇒
  //   行形状是 `{customerRelationId, customerName, currency, invoiceCount, buckets{current,d1_30,…,total}}`，
  //   钱在 **buckets.total**、本币种合计在 **totals[]**。读错字段 ⇒ receivableSum 恒 0（自造判据没喂已知样本）。
  const recv = c?.arApAlerts?.receivable ?? {};
  const rRows = recv.rows ?? [];
  out.receivableInvoices = rRows.reduce((s, r) => s + Number(r.invoiceCount ?? 0), 0);
  out.receivableBuckets = Math.round(rRows.reduce((s, r) => s + Number(r.buckets?.total ?? 0), 0) * 100) / 100;
  out.receivableTotals = (recv.totals ?? []).map(t => `${t.currency}:${Math.round(Number(t.total) * 100) / 100}`).sort().join(' ; ');
  out.statusDist = (c?.orderStatusDistribution ?? []).map(x => `${x.status}:${x.count}`).sort().join(' ; ');
  return out;
}

// ★ `receivableRows`（应收的**客户行数**）刻意**不**当判据：一张新票落在已有客户行上 ⇒ 这一维本来就不该动，
//   拿它判"看不看得见钱"是尺自己的错（v3.136 第一版就是这么误报了一次"缺口"）。承担判据的是下面两组。
const ORDER_SIDE = ['xlsxRows', 'xlsxSum', 'listItems', 'leaderboard', 'marginRows', 'marginExcluded', 'marginTotals', 'marginWithCost', 'statusDist'];
const INVOICE_SIDE = ['receivableInvoices', 'receivableBuckets', 'receivableTotals'];
const KEYS = [...ORDER_SIDE, ...INVOICE_SIDE];
const diffKeys = (a, b) => KEYS.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
/** 从 `marginTotals` 那格里取某一币种的三个数（用来对**增量**，不满足于"变了"） */
const marginOf = (s, ccy) => {
  const m = new RegExp(String(ccy) + '\\|r=(-?[\\d.]+)\\|c=(-?[\\d.]+)\\|m=(-?[\\d.]+)').exec(s || '');
  return m ? { r: Number(m[1]), c: Number(m[2]), m: Number(m[3]) } : null;
};
const COST = 1500 * 5;          // purchasePrice(5) × quantity(1500) —— 与 dashboardService 的口径同一支
const EXPECT_MARGIN = TOTAL - COST;

const prisma = new PrismaClient();
let orderId = null;
let lineIds = [];
let invoiceId = null;
try {
  console.log(`════ 钱类删除面演练 · ${BASE} · 造一张 ${TOTAL} USD 的带明细行单再作废它 ════`);
  const t0 = await snapshot();
  console.log('  T0：' + trunc(JSON.stringify(t0), 420));

  const order = await prisma.order.create({
    data: {
      id: randomUUID(), customer: 'Drill Customer (temporary)', product: 'DRILL 男式针织短袖 T 恤',
      type: 'Garment', quantity: 1500, status: 'Confirmed', dueDate: '2026-12-31',
      quoteAmount: TOTAL, totalNet: TOTAL, currency: 'USD', ownerId: OWNER,
      // ★ 刻意带上成本：驾驶舱的毛利口径是 `成本 = supplierInvoiceAmount ?? purchasePrice × quantity`（dashboardService.ts:425-461）。
      //   不带成本的单只进"被排除"那一档 ⇒ 毛利 aggregate 对它**没有钱**，删除面判据在毛利那一族就仍是空转。
      //   同币种（USD/USD）⇒ 不掺 FX，毛利是纯减法：14,250 − 1,500×5 = 6,750。
      poNumber: DRILL_PO, source: 'drill-deleted-money-face', customerRelationId: RELATION,
      purchaseCurrency: 'USD', purchasePrice: 5,
      // OrderLine.id 是 `String @id` 且**无默认值**（现查 schema）⇒ 必须自己给，否则 Prisma 客户端校验就拒（零写入）
      lines: { create: LINES.map(l => ({ id: randomUUID(), ...l })) },
    },
    include: { lines: true },
  });
  orderId = order.id;
  lineIds = order.lines.map(l => l.id);

  // ★ 光有一张带明细行的单，**应收那一格**还是测不到（那一格按发票行算）。所以再挂一张发票：
  //   这一格才是"作废客户的欠款到底去不去"的业务问题所在。发票是**库侧造的**（没走 POST /invoices）
  //   ⇒ 本件证的是**聚合侧**的过滤，不证开票写路径；写路径那侧由 acceptance-cancel-settle-recalc 那一族管。
  const now = BigInt(Date.now());
  const inv = await prisma.invoice.create({
    data: {
      id: `INV__drill_${randomUUID().slice(0, 8)}`, invoiceNumber: `DRILL-INV-${randomUUID().slice(0, 8)}`,
      type: 'Receivable', status: 'Issued', amount: TOTAL, currency: 'USD',
      issueDate: '2026-09-20', dueDate: '2026-10-31', exchangeRate: 1, baseCurrency: 'USD',
      orderId, customerRelationId: RELATION, customerName: 'Drill Customer (temporary)',
      createdAt: now, updatedAt: now, ownerId: OWNER,
    },
  });
  invoiceId = inv.id;

  // ---------- phase 1：这一格必须看得见这张新单 ----------
  const t1 = await snapshot();
  const moved = diffKeys(t0, t1);
  console.log('  T1 变化格：' + (moved.join(', ') || '（无）'));
  // ★ `marginExcluded`（"算不出毛利所以被排除"的行数）**刻意不在这一轮里判**：我这张单是**带成本**的，
  //   它本来就**不该**进"排除"那一档 ⇒ "没变"是**正确行为**，把它报成"这格空转"是我第二次犯同一个错
  //   （上一版我刚把 `receivableRows` 因为同样的理由摘出去）。它由下面那格成对地判。
  const MUST_MOVE = [...ORDER_SIDE.filter(k => k !== 'marginExcluded'), ...INVOICE_SIDE];
  for (const k of MUST_MOVE) {
    if (moved.includes(k)) pass(`phase1 ${k}：新单被算进去了`, `${trunc(t0[k], 60)} → ${trunc(t1[k], 60)}`);
    else gap(`phase1 ${k}：新单在这格里看不见`, 'T1 == T0 ⇒ 这一格对"作废单的钱"没有区分力，删除面判据在它是空转');
  }
  if (t1.marginWithCost !== t0.marginWithCost && t1.marginExcluded === t0.marginExcluded) {
    pass('phase1 毛利分档（成对判）：带成本的单进"算得出毛利"档、没进"排除"档',
      `withCost ${t0.marginWithCost}→${t1.marginWithCost} · excluded 保持 ${t0.marginExcluded}`);
  } else {
    fail('phase1 毛利分档不对', `withCost ${t0.marginWithCost}→${t1.marginWithCost} · excluded ${t0.marginExcluded}→${t1.marginExcluded} ⇒ 带成本的单不该被排除（口径读法要回查 dashboardService）`);
  }
  // ★ 现量到一条以前不知道的事实：**基线上 USD 那一档根本不存在**（今天全库没有一张带成本的单 ⇒
  //   `totals[]` 是空的，`marginWithCost` 一直是 0）。所以"档不在"要按 0 算，不是按"读不到"算——
  //   这反而是最强的证人：我这张单是整个毛利 aggregate 里**唯一**带成本的钱。
  const m0 = marginOf(t0.marginTotals, 'USD') ?? { r: 0, c: 0, m: 0 };
  const m1 = marginOf(t1.marginTotals, 'USD');
  if (!m1) {
    fail('phase1 毛利 aggregate 里没有这张带成本的单', `T1 的 totals=${trunc(t1.marginTotals, 120) || '(空)'} ⇒ 它没进毛利，后面"退回基线"那格就变成恒真`);
  } else if (m1.r - m0.r !== TOTAL || m1.c - m0.c !== COST || m1.m - m0.m !== EXPECT_MARGIN) {
    fail('phase1 毛利那一族的增量对不上', `Δrevenue=${m1.r - m0.r}（要 ${TOTAL}）· Δcost=${m1.c - m0.c}（要 ${COST}）· Δmargin=${m1.m - m0.m}（要 ${EXPECT_MARGIN}）`);
  } else {
    pass('phase1 毛利那一族：带成本的新单把钱进来了', `USD 收入 +${TOTAL} · 成本 +${COST} · 毛利 +${EXPECT_MARGIN}`);
  }
  if (t1.xlsxSum !== Math.round((t0.xlsxSum + TOTAL) * 100) / 100) {
    fail('phase1 台账金额合计的增量对不上', `${t0.xlsxSum} → ${t1.xlsxSum}（要 ${t0.xlsxSum + TOTAL}）`);
  } else pass('phase1 台账金额合计：新单的钱正好进了文件', `+${TOTAL}`);

  // ---------- phase 2a：产品自己的 DELETE 路由 —— 挂着发票时**应当**被拒（写侧门禁） ----------
  const dres = await fetch(`${BASE}/api/v2/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE', headers: H });
  const dj = await dres.json().catch(() => ({}));
  if (dres.status === 409 && dj?.error === 'HAS_DEPENDENTS') {
    pass('写侧门禁：带发票的单不许删（409 HAS_DEPENDENTS）', trunc(dj?.message, 120));
  } else if (dres.ok && dj?.ok) {
    fail('写侧门禁没拦住：带发票的单被删掉了', 'DELETE 200 ⇒ 产品自己就能造出"发票挂着、单没了"，而读侧无护栏 ⇒ 活缺陷');
  } else {
    fail('作废这一刀返回预期外的东西', `HTTP ${dres.status} ${trunc(JSON.stringify(dj), 120)}`);
  }
  // ★ 基准是 **T1（删之前的 live 态）**，不是 T0——演练自己造的单和票还在库里，跟 T0 当然处处不同。
  //   第一版拿 T0 当基准，量出"拒绝路径有副作用"十条，那是**尺的错**（v3.136 现场）。
  const t2a = await snapshot();
  const side2a = diffKeys(t1, t2a);
  if (side2a.length === 0) pass('拒绝路径零副作用：被拒之后读数与"删之前的 live 态"逐格相等', `${KEYS.length} 格`);
  else fail('拒绝路径有副作用（被拒了却已经动了数）', side2a.map(k => `${k}: ${trunc(t1[k], 28)} → ${trunc(t2a[k], 28)}`).join(' · '));

  // ---------- phase 2b：模拟**第二条删除路径**（迁移批量软删不过门禁：dataMigrationService.ts:386） ----------
  await prisma.order.update({ where: { id: orderId }, data: { deletedAt: BigInt(Date.now()) } });
  pass('造出产品路由禁止的状态：单被软删、发票还活着', '库侧直写 deletedAt —— 这正是迁移那条路做的事');
  const t2 = await snapshot();
  const d2 = diffKeys(t0, t2);
  const stuckOrder = d2.filter(k => ORDER_SIDE.includes(k));
  const stuckInv = d2.filter(k => INVOICE_SIDE.includes(k));
  if (stuckOrder.length === 0) pass('读侧·订单类每一格都退回 T0（作废单的钱不在台账/销售额/毛利里）', ORDER_SIDE.join(', '));
  else fail('读侧·订单类：作废单还留在数里', stuckOrder.map(k => `${k}: ${trunc(t0[k], 28)} → ${trunc(t2[k], 28)}`).join(' · '));
  // 发票侧这一格**自己现量它的前提**：除本件自造的那张之外，库里"挂在软删单上的未删应收发票"必须还是 0 张。
  //   · 0 张 ⇒ 今天的驾驶舱没被污染 ⇒ 记"登记不判红"（写侧 409 是唯一护栏）
  //   · >0 张 ⇒ 这条状态已被别的路径真实造出来 ⇒ 立刻转红（不许拿"路由拦住"当挡箭牌）
  const hang = await prisma.$queryRaw`select count(*)::int as n
      from "Invoice" i join "Order" o on o.id = i."orderId"
     where o."deletedAt" is not null and i."deletedAt" is null
       and i.type = 'Receivable' and i.status <> 'Cancelled' and i.id <> ${invoiceId}`;
  const hangN = Number(hang[0]?.n ?? 0);
  if (stuckInv.length === 0) pass('读侧·发票侧也退回 T0（读侧其实有护栏）', INVOICE_SIDE.join(','));
  else if (hangN === 0) gap('读侧·发票侧：作废单的发票**仍全额计入应收**（这就是没有读侧护栏）',
    `实测没退回的格：${stuckInv.join(', ')} · 本件发票额 ${TOTAL} · 除本件外库里这种行=${hangN} 张 ⇒ 今天的数没被污染，写侧 409 是唯一护栏；一旦这张数不再为 0，本格自动转红`);
  else fail('读侧·发票侧：库里已经有真实存在的"挂在软删单上的应收发票"', `除本件外 ${hangN} 张 ⇒ 驾驶舱的应收/逾期今天就是虚的，不再是"够不着的隐患"`);
  // 阳性对照：比较函数必须抓得住"钱没退回去"（拿 t2 自己当基准，这样 phase2 结论与对照互不遮蔽）
  const poison = { ...t2, xlsxSum: Math.round((t2.xlsxSum + 0.01) * 100) / 100 };
  const caught = diffKeys(t2, poison);
  if (caught.length === 1 && caught[0] === 'xlsxSum') pass('阳性对照：合计挪一分钱就被抓、且只报那一格', `报出 ${caught.join(',')}`);
  else fail('阳性对照不成立', `挪 0.01 后报 ${JSON.stringify(caught)}（要 ["xlsxSum"]）⇒ 上面"逐格相等"不可信`);

  // ---------- cleanup：只删我自己写的行 ----------
  if (invoiceId) await prisma.invoice.delete({ where: { id: invoiceId } }).catch(() => {});
  // OrderLine→Order 是 ON DELETE CASCADE（pg_constraint confdeltype='c' 实测）⇒ 删单就带走行，不手写批量删
  await prisma.order.delete({ where: { id: orderId } });
  const leftLine = await prisma.orderLine.count({ where: { id: { in: lineIds } } });
  const leftOrder = await prisma.order.count({ where: { poNumber: DRILL_PO } });
  const leftInv = invoiceId ? await prisma.invoice.count({ where: { id: invoiceId } }) : 0;
  const leftAudit = await prisma.auditLog.count({ where: { targetId: orderId } });
  if (leftLine === 0 && leftOrder === 0 && leftInv === 0) pass('清场：按自己写入的精确 id 删干净', `行=0 单=0 票=0 · AuditLog 留痕 ${leftAudit} 条（删除动作的痕，本件不冒充"零写入"）`);
  else fail('清场不干净', `行 ${leftLine} · 单 ${leftOrder} · 票 ${leftInv}`);
  orderId = null; invoiceId = null;

  const t3 = await snapshot();
  const d3 = diffKeys(t0, t3);
  if (d3.length === 0) pass('T3 零残留：删干净之后读数与 T0 逐格相等', `${KEYS.length} 格`);
  else fail('T3 有残留（我污染了基线）', d3.map(k => `${k}: ${trunc(t0[k], 40)} → ${trunc(t3[k], 40)}`).join(' · '));
} finally {
  if (invoiceId) { try { await prisma.invoice.delete({ where: { id: invoiceId } }); } catch { /* 已删 */ } }
  if (orderId) {
    try {
      await prisma.order.delete({ where: { id: orderId } }).catch(() => {}); // 行由 CASCADE 带走
    } catch { /* 兜底 */ }
  }
  await prisma.$disconnect();
}

const okN = results.filter(x => x === true).length;
const badN = results.filter(x => x === false).length;
const gapN = results.filter(x => x === null).length;
console.log('────────────────────────────────────────');
console.log(` 结论：${okN} 通过 / ${badN} 失败 / ${gapN} 缺口（空转的格子已点名，不许读成通过）`);
process.exit(badN > 0 ? 1 : 0);
