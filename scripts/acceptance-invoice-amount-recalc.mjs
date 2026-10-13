// 发票金额变更 → 状态重算缺失 —— 真库演练验收（真实 API 写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// ── 病灶（本脚本要证的东西）──
//   `updateInvoice`（PATCH /api/v1/finance/:id）**允许改 `amount`**，但**从不调用
//   `recalcInvoiceStatus`**。而 `Invoice.status` 是**派生字段**（真源 = Σ InvoiceAllocation，
//   见 allocationService.recalcInvoiceStatus）。派生字段不在写入点重算 → 状态与净额脱钩。
//
//   后果（真实业务链条，全部是代码事实）：
//     ① 财务把「客户少收的差额」用「改发票金额」抹平（这是系统里**唯一**能抹平的路径）→
//        open 变成 0，但 status 停在 `PartiallyPaid` → **僵尸票**（状态与净额不一致）。
//     ② creditService.maxOverdueDays 只按 `status ∈ {Issued, PartiallyPaid}` 过滤，
//        **连 open 都不看** → 僵尸票永久计入「最大逾期天数」。
//     ③ 客户 60 天后被 riskWatchdog 自动冻结授信；解冻的唯一自动路径是
//        `thawAutoFrozenIfSettled`，条件是 maxOverdueDays ≤ 60 → **永不满足 → 永不解冻**。
//        → 业务员开不了新单，只能找总领导手工解冻。
//     反向（改大金额）：已 Paid 的票改成 1100（实收 1000）→ status 仍 `Paid` 而净额 open=100
//        → 同样是僵尸票，且这次是「已结清」的票其实还欠钱（对账看不见）。
//
// ── 验的口径不变量 ──
//   S1  ★前置   核销 900/1000 → 票 = PartiallyPaid，净额 open = 100（**先证前置条件成立**，
//               否则后面「改金额后 open=0」是在断言一个不存在的东西 = 空过的验证器）
//   S2  ★承重   改 amount 1000 → 900（open 归零）→ status **必须变 Paid**（修前停在 PartiallyPaid）
//   S3  护栏    改 amount → 1200（改大，open=300）→ status = PartiallyPaid
//   S4  护栏    无核销的票改 amount → status 保持 Issued（不能被重算带跑）
//   S5  ★承重   改 amount → 800（**< 已核销 900**）→ **必须被拒**（否则制造超额核销 open<0）
//   S6  护栏    S5 被拒后：发票金额未被改、净额未变负、核销明细未变（拒绝路径零副作用）
//   S7  ★承重   全额核销的票（Paid, open=0）改 amount 1000 → 1100 → status **必须退回
//               PartiallyPaid**（修前停在 Paid → 「已结清」的票其实还欠 100）
//   S8  护栏    留痕：auditLog 有 update_invoice
//   S9          回滚后独立复核零残留
//
// ── 演练设计坑（下次写同类脚本先看这条）──
//   **建 Receipt 凭证会触发 L5 自动核销联动**（PaymentVoucherCreated → 该客户最早的
//   未结清 Receivable 票）。所以本脚本**先建凭证、后建票**：建凭证时该客户名下还没有
//   任何票 → L5 走 `no matching invoice` 跳过 → 不会和后面的手动核销抢余额。
//   （若反过来先建票再建凭证，L5 会把凭证自动核销掉，手动核销就吃 AMOUNT_EXCEEDS_*。）
//   票 C 用**独立客户档案** REL_C 也是同一原因：否则建第二张凭证 V2 时 L5 会把它
//   自动核销到票 A/B 上。
//
// ★ 承重 vs 护栏（**实测标注，别猜**）：
//   承重 = S1（前置证明）/ S2 / S5 / S7 —— 有区分度的断言
//   护栏 = S3 / S4 / S6 / S8 —— 它们证的是「没误伤 / 没过度放开 / 留痕还在」，
//          **证伪态也全绿**，不具区分度。
//   实测（2026-09-17）：
//     · 证伪 A：摘掉 `updateInvoice` 里的重算块
//       → 真库 **S2 / S7 转红**（status 未变）；S3/S4/S5/S6/S8 全绿
//       → 单测 `invoiceAmountRecalc.test.ts` **4 红**（3 条重算 + 1 条 settlementDate）
//     · 证伪 B：把「低于已核销」守卫降级为 no-op
//       → 真库 **S5 转红**（HTTP 200 + open=−100 超额核销）；其余全绿
//       → 单测 **2 红**（服务层守卫 + 路由 409 映射）
//   别把护栏当承重：看到「证伪只红了那几条」是**正确**结果，不是没钉住。
//
// 证伪方式（launchd 托管后端不继承 shell env → 只能改代码 + kickstart）：
//   A 摘掉 server/src/finance/invoiceMutationService.ts 里 `if (amountChanged)` 的重算块
//   B 把该文件里 `if (nextAmount.lt(applied))` 改成 `if (nextAmount.lt(new Prisma.Decimal(0)))`
//   跑完务必改回 + 再 kickstart -k。
//
// ★★ 证伪手法本身的坑（2026-09-17 踩到）：
//   **不要用 `if (false && cond)` 来关掉代码块** —— TS 会把该块判为**不可达代码**，
//   从而**丢弃之前的类型收窄**（本例里 `normalized.data` 立刻报 TS2339），
//   ts-node 直接启动失败 → 后端 40s 起不来、演练报 `fetch failed`，很容易误判成「代码写坏了」。
//   正确做法：改**条件里的值**让它恒不成立（如上面的 B），保持代码可达。
//
// 演练数据全部带 DRILL-AMT 前缀 / 精确 id；finally 里按精确 ID 硬删 + 独立复核零残留。
// 用法：node scripts/acceptance-invoice-amount-recalc.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 演练常量 ──────────────────────────────────────────────────────────
const TS = Date.now();
const REL = `REL__DRILL_AMT_${TS}`;        // 票 A/B 的客户（少收场景）
const REL_C = `REL__DRILL_AMT_C_${TS}`;    // 票 C 的客户（改大场景，独立档案避开 L5 抢票）
const NAME = `DRILL-AMT-CUST-${TS}`;
const NAME_C = `DRILL-AMT-CUSTC-${TS}`;

const INV_NO = (k) => `DRILL-AMT-INV-${k}-${TS}`;
const VOU_NO = (k) => `DRILL-AMT-PAY-${k}-${TS}`;
/** 所有走 POST 建单的用例 key —— 回滚与复核按这批号**无条件**扫 */
const INV_KEYS = ['A', 'B', 'C'];
const VOU_KEYS = ['V1', 'V2'];

let prisma = null;
const created = { invoices: {}, vouchers: {} };
let notifBefore = new Set();
let agentJobBefore = new Set();

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const { SERVER_DIR } = await import('./lib/acceptance-selfcheck.mjs');
  const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
  const { PrismaClient } = req('@prisma/client');
  prisma = new PrismaClient();
}

async function snapshotSideEffects() {
  const [notifs, jobs] = await Promise.all([
    prisma.notification.findMany({ select: { id: true } }),
    prisma.agentJob.findMany({ select: { id: true } }),
  ]);
  notifBefore = new Set(notifs.map((n) => n.id));
  agentJobBefore = new Set(jobs.map((j) => j.id));
}

/** 直接读库算净额（**不经过被测的 PATCH 路径**，避免自己跟自己比） */
async function netOpen(invoiceId) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { amount: true, status: true } });
  if (!inv) return null;
  const agg = await prisma.invoiceAllocation.aggregate({ where: { invoiceId }, _sum: { appliedAmount: true } });
  const applied = Number(agg._sum.appliedAmount ?? 0);
  return { amount: Number(inv.amount), status: inv.status, applied, open: Math.round((Number(inv.amount) - applied) * 10000) / 10000 };
}

async function allocCount(invoiceId) {
  return prisma.invoiceAllocation.count({ where: { invoiceId } });
}

/** 核销 POST 在真库上会偶发 409 CONFLICT（Serializable 隔离中止，P2034）→ 幂等重试 */
async function allocWithRetry(token, body, tries = 4) {
  let r = null;
  for (let i = 0; i < tries; i++) {
    r = await api(token, 'POST', '/api/v1/finance/allocations', body);
    if (r.status === 201) return r;
    if (r.status === 409 && String(r.data?.error ?? '').includes('CONFLICT')) { await sleep(600); continue; }
    return r;
  }
  return r;
}

// ── 回滚 ──────────────────────────────────────────────────────────────
async function rollback() {
  try {
    await sleep(2000); // fire-and-forget 事件/通知落定
    const gone = [];
    const invIds = Object.values(created.invoices);
    const vouIds = Object.values(created.vouchers);
    const allIds = [...invIds, ...vouIds];

    const alloc = await prisma.invoiceAllocation.deleteMany({
      where: { OR: [{ invoiceId: { in: invIds } }, { voucherId: { in: vouIds } }] },
    });
    if (alloc.count) gone.push(`InvoiceAllocation(${alloc.count})`);

    const refs = await prisma.entityReference.deleteMany({
      where: { OR: [{ ownerId: { in: allIds } }, { targetId: { in: allIds } }] },
    });
    if (refs.count) gone.push(`EntityReference(${refs.count})`);
    const links = await prisma.entityLink.deleteMany({
      where: { OR: [{ fromId: { in: allIds } }, { toId: { in: allIds } }] },
    });
    if (links.count) gone.push(`EntityLink(${links.count})`);

    const audit = await prisma.auditLog.deleteMany({ where: { targetId: { in: allIds } } });
    if (audit.count) gone.push(`AuditLog(${audit.count})`);

    const cl = await prisma.creditLimit.deleteMany({ where: { relationId: { in: [REL, REL_C] } } });
    if (cl.count) gone.push(`CreditLimit(${cl.count})`);
    const clh = await prisma.creditLimitHistory.deleteMany({ where: { relationId: { in: [REL, REL_C] } } });
    if (clh.count) gone.push(`CreditLimitHistory(${clh.count})`);

    const [notifsNow, jobsNow] = await Promise.all([
      prisma.notification.findMany({ select: { id: true } }),
      prisma.agentJob.findMany({ select: { id: true } }),
    ]);
    const newNotifs = notifsNow.map((n) => n.id).filter((id) => !notifBefore.has(id));
    const newJobs = jobsNow.map((j) => j.id).filter((id) => !agentJobBefore.has(id));
    if (newNotifs.length) gone.push(`Notification(${(await prisma.notification.deleteMany({ where: { id: { in: newNotifs } } })).count})`);
    if (newJobs.length) gone.push(`AgentJob(${(await prisma.agentJob.deleteMany({ where: { id: { in: newJobs } } })).count})`);

    const invs = await prisma.invoice.findMany({ where: { invoiceNumber: { in: INV_KEYS.map(INV_NO) } }, select: { id: true } });
    if (invs.length) gone.push(`Invoice(${(await prisma.invoice.deleteMany({ where: { id: { in: invs.map((i) => i.id) } } })).count})`);
    const vous = await prisma.paymentVoucher.findMany({ where: { voucherNumber: { in: VOU_KEYS.map(VOU_NO) } }, select: { id: true } });
    if (vous.length) gone.push(`PaymentVoucher(${(await prisma.paymentVoucher.deleteMany({ where: { id: { in: vous.map((v) => v.id) } } })).count})`);

    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 invoices=${JSON.stringify(created.invoices)} vouchers=${JSON.stringify(created.vouchers)}`);
  }
}

/** 独立复核零残留（不信回滚自述，按精确标识回查） */
async function verifyNoResidue() {
  const checks = [];
  const invs = await prisma.invoice.findMany({ where: { invoiceNumber: { in: INV_KEYS.map(INV_NO) } }, select: { id: true } });
  const vous = await prisma.paymentVoucher.findMany({ where: { voucherNumber: { in: VOU_KEYS.map(VOU_NO) } }, select: { id: true } });
  checks.push(['invoice', invs.length]);
  checks.push(['paymentVoucher', vous.length]);
  const ids = [...invs.map((i) => i.id), ...vous.map((v) => v.id)];
  checks.push(['invoiceAllocation', await prisma.invoiceAllocation.count({ where: { OR: [{ invoiceId: { in: ids } }, { voucherId: { in: ids } }] } })]);
  checks.push(['entityReference', await prisma.entityReference.count({ where: { OR: [{ ownerId: { in: ids } }, { targetId: { in: ids } }] } })]);
  checks.push(['entityLink', await prisma.entityLink.count({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } })]);
  checks.push(['auditLog', await prisma.auditLog.count({ where: { targetId: { in: ids } } })]);
  checks.push(['creditLimit', await prisma.creditLimit.count({ where: { relationId: { in: [REL, REL_C] } } })]);
  checks.push(['creditLimitHistory', await prisma.creditLimitHistory.count({ where: { relationId: { in: [REL, REL_C] } } })]);
  // 全库前缀兜底（不信单个脚本的复核）
  checks.push(['DRILL-AMT invoice 前缀', await prisma.invoice.count({ where: { invoiceNumber: { startsWith: 'DRILL-AMT-' } } })]);
  checks.push(['DRILL-AMT voucher 前缀', await prisma.paymentVoucher.count({ where: { voucherNumber: { startsWith: 'DRILL-AMT-' } } })]);
  const dirty = checks.filter(([, n]) => n > 0);
  if (dirty.length === 0) pass('回滚复核：零残留', `${checks.length} 项全为 0`);
  else fail('回滚复核：仍有残留', dirty.map(([k, n]) => `${k}=${n}`).join(' '));
}

async function main() {
  const token = await login('charlie.qian@bambook.local')
    ?? await login('melissa.zhao@bambook.local')
    ?? await login('jason.shen@bambook.local');
  if (!token) { fail('登录', 'charlie.qian / melissa.zhao / jason.shen 均失败'); return; }

  console.log('══ 发票金额变更 → 状态重算缺失 · 真库演练验收（真实 API 写路径 + 自回滚）══\n');
  console.log('  被测：PATCH /api/v1/finance/:id { amount }  →  Invoice.status 是派生字段');
  console.log('  真源：allocationService.recalcInvoiceStatus（status = Σ InvoiceAllocation vs amount）\n');

  await connectPrisma();
  await snapshotSideEffects();

  // ── 建凭证（**必须先于建票**：否则 L5 自动核销会抢走凭证余额）──
  const vouBase = (over) => ({
    type: 'Receipt', currency: 'USD', paymentDate: '2026-09-17', paymentMethod: 'TT', ...over,
  });
  const vouSpecs = [
    ['V1', vouBase({ voucherNumber: VOU_NO('V1'), amount: '900', customerRelationId: REL, customerName: NAME })],
    ['V2', vouBase({ voucherNumber: VOU_NO('V2'), amount: '1000', customerRelationId: REL_C, customerName: NAME_C })],
  ];
  for (const [k, body] of vouSpecs) {
    const r = await api(token, 'POST', '/api/v1/finance/vouchers', body);
    if (r.status === 201 && r.data?.id) created.vouchers[k] = r.data.id;
    else fail(`底账：建凭证 ${k}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  if (Object.keys(created.vouchers).length === 2) pass('底账：建凭证（先于建票，避开 L5 抢余额）', 'V1=900 USD / V2=1000 USD');

  // ── 建票 ──
  const invBase = (over) => ({
    type: 'Receivable', status: 'Issued', currency: 'USD',
    issueDate: '2026-09-17', dueDate: '2026-12-31', ...over,
  });
  const invSpecs = [
    ['A', invBase({ invoiceNumber: INV_NO('A'), amount: '1000', customerRelationId: REL, customerName: NAME })],
    ['B', invBase({ invoiceNumber: INV_NO('B'), amount: '500', customerRelationId: REL, customerName: NAME })],
    ['C', invBase({ invoiceNumber: INV_NO('C'), amount: '1000', customerRelationId: REL_C, customerName: NAME_C })],
  ];
  for (const [k, body] of invSpecs) {
    const r = await api(token, 'POST', '/api/v1/finance', body);
    if (r.status === 201 && r.data?.id) created.invoices[k] = r.data.id;
    else fail(`底账：建票 ${k}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  if (Object.keys(created.invoices).length === 3) pass('底账：建票', 'A=1000（少收场景）/ B=500（无核销护栏）/ C=1000（改大场景）');

  // ── S1 ★前置：核销 A ← V1 900 ──
  const r1 = await allocWithRetry(token, {
    invoiceId: created.invoices.A, voucherId: created.vouchers.V1, appliedAmount: '900', appliedDate: '2026-09-17',
  });
  const netA0 = await netOpen(created.invoices.A);
  if (r1.status === 201 && netA0?.status === 'PartiallyPaid' && netA0?.open === 100) {
    pass('S1 ★前置 核销 900/1000 → PartiallyPaid 且净额 open=100', `applied=${netA0.applied} open=${netA0.open}`);
  } else {
    fail('S1 ★前置 核销 900/1000', `HTTP ${r1.status} ${JSON.stringify(r1.data).slice(0, 160)}；净额=${JSON.stringify(netA0)} —— **前置不成立，后续断言全部不可信**`);
  }

  // ── S2 ★承重：改 amount 1000 → 900（open 归零）→ status 必须变 Paid ──
  const r2 = await api(token, 'PATCH', `/api/v1/finance/${created.invoices.A}`, { amount: '900' });
  const netA1 = await netOpen(created.invoices.A);
  if (r2.status === 200 && netA1?.open === 0 && netA1?.status === 'Paid') {
    pass('S2 ★承重 改 amount→900（open 归零）→ status 重算为 Paid', `净额 open=${netA1.open} status=${netA1.status}`);
  } else {
    fail('S2 ★承重 改 amount→900 后 status 未重算', `HTTP ${r2.status}；净额 open=${netA1?.open} status=${netA1?.status}（期望 Paid）—— **派生字段与净额脱钩**`);
  }

  // ── S3 护栏：改 amount → 1200（open=300）→ PartiallyPaid ──
  const r3 = await api(token, 'PATCH', `/api/v1/finance/${created.invoices.A}`, { amount: '1200' });
  const netA2 = await netOpen(created.invoices.A);
  if (r3.status === 200 && netA2?.open === 300 && netA2?.status === 'PartiallyPaid') {
    pass('S3 护栏 改 amount→1200（open=300）→ PartiallyPaid', `open=${netA2.open}`);
  } else {
    fail('S3 护栏 改 amount→1200', `HTTP ${r3.status}；净额=${JSON.stringify(netA2)}`);
  }

  // ── S4 护栏：无核销的票 B 改 amount → 保持 Issued ──
  const r4 = await api(token, 'PATCH', `/api/v1/finance/${created.invoices.B}`, { amount: '600' });
  const netB = await netOpen(created.invoices.B);
  if (r4.status === 200 && netB?.status === 'Issued' && netB?.open === 600) {
    pass('S4 护栏 无核销的票改 amount→600 → 保持 Issued', `open=${netB.open}`);
  } else {
    fail('S4 护栏 无核销的票改 amount', `HTTP ${r4.status}；净额=${JSON.stringify(netB)}`);
  }

  // ── S5 ★承重：改 amount → 800（< 已核销 900）→ 必须被拒 ──
  const allocBeforeS5 = await allocCount(created.invoices.A);
  const r5 = await api(token, 'PATCH', `/api/v1/finance/${created.invoices.A}`, { amount: '800' });
  const netA3 = await netOpen(created.invoices.A);
  const rejected = r5.status === 400 || r5.status === 409;
  if (rejected && netA3?.amount === 1200 && netA3?.open === 300) {
    pass('S5 ★承重 改 amount→800（< 已核销 900）→ 被拒且金额未变', `HTTP ${r5.status} ${r5.data?.error?.code ?? ''}；amount=${netA3.amount} open=${netA3.open}`);
  } else if (!rejected && netA3?.open < 0) {
    fail('S5 ★承重 改 amount→800 未被拒 → 制造超额核销', `HTTP ${r5.status}；amount=${netA3?.amount} open=${netA3?.open}（负数=超额核销，违反 applyAllocation 已强制的 Σapplied ≤ amount 不变量）`);
  } else {
    fail('S5 ★承重 改 amount→800', `HTTP ${r5.status}；净额=${JSON.stringify(netA3)}`);
  }

  // ── S6 护栏：S5 被拒后核销明细未变（拒绝路径零副作用）──
  const allocAfterS5 = await allocCount(created.invoices.A);
  if (allocAfterS5 === allocBeforeS5 && allocAfterS5 === 1) {
    pass('S6 护栏 被拒后核销明细未变', `${allocBeforeS5} → ${allocAfterS5} 条`);
  } else {
    fail('S6 护栏 被拒后核销明细变化', `${allocBeforeS5} → ${allocAfterS5} 条`);
  }

  // ── S7 ★承重：全额核销的票（Paid）改大 → 必须退回 PartiallyPaid ──
  const rc = await allocWithRetry(token, {
    invoiceId: created.invoices.C, voucherId: created.vouchers.V2, appliedAmount: '1000', appliedDate: '2026-09-17',
  });
  const netC0 = await netOpen(created.invoices.C);
  if (rc.status === 201 && netC0?.status === 'Paid' && netC0?.open === 0) {
    pass('S7 ★前置 全额核销 1000/1000 → Paid', `open=${netC0.open}`);
  } else {
    fail('S7 ★前置 全额核销 1000/1000', `HTTP ${rc.status}；净额=${JSON.stringify(netC0)}`);
  }
  const r7 = await api(token, 'PATCH', `/api/v1/finance/${created.invoices.C}`, { amount: '1100' });
  const netC1 = await netOpen(created.invoices.C);
  if (r7.status === 200 && netC1?.open === 100 && netC1?.status === 'PartiallyPaid') {
    pass('S7 ★承重 已 Paid 的票改 amount→1100 → 退回 PartiallyPaid', `open=${netC1.open} status=${netC1.status}`);
  } else {
    fail('S7 ★承重 已 Paid 的票改 amount→1100 后 status 未重算', `HTTP ${r7.status}；净额 open=${netC1?.open} status=${netC1?.status}（期望 PartiallyPaid）—— 「已结清」的票其实还欠 100，对账看不见`);
  }

  // ── S8 护栏：留痕 ──
  const auditRows = await prisma.auditLog.count({ where: { targetId: { in: Object.values(created.invoices) }, action: 'update_invoice' } });
  if (auditRows > 0) pass('S8 护栏 留痕 auditLog=update_invoice', `${auditRows} 条`);
  else fail('S8 护栏 留痕', '0 条 update_invoice 审计行');
}

main()
  .catch((e) => fail('演练异常', String(e?.stack || e)))
  .finally(async () => {
    if (prisma) {
      await rollback();
      await verifyNoResidue();
      await prisma.$disconnect();
    }
    const failed = results.filter((r) => r.ok === false).length;
    const passed = results.filter((r) => r.ok === true).length;
    console.log(`\n──────────────\n结果：${passed} 通过 / ${failed} 失败`);
    process.exit(failed ? 1 : 0);
  });
