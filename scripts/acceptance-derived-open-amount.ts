// ★★ 派生量对撞 · 未收额（② 类第 1 条）—— 同一个"未收额"在两个出口必须相等
//
// 依据（只读复查，行号为 2026-09-24 当时的 HEAD）：同一个"未收额"在服务端有多份实现，两维都不一致：
//   · `finance/route.ts` 发票列表出口：openAmount（缺失时**无声回退**成 amount —— 那是本行最阴的一处）
//   · `reportService.ts` 资金日历出口：注释自称"与账龄/对账单/KPI 同一公式（净额口径 DR-044）"
//   ⇒ 两边都声称是 `amount − Σ InvoiceAllocation`，那就**逐票对撞**，红了点名。
//
// 本脚本核三件（都只读）：
//   A. **出口内恒等**：列表每一项都必须满足 `openAmount == amount − appliedAmount`（同一出口自己的公式）
//      —— 附带数出 `openAmount` 缺失（走到"无声回退"那一支）的票数。
//   B. **出口间对撞**：同一张票在「列表」与「资金日历」两处的 `openAmount` 必须相等（取两处都出现的票）。
//   C. **阳性对照**（`--control`）：把 B 通道某张票的 openAmount **内存** +1 ⇒ 同一条比较必须报红。
//      对照纯内存，不写库。
//
// 用法：
//   npx tsx scripts/acceptance-derived-open-amount.ts
//   npx tsx scripts/acceptance-derived-open-amount.ts --control
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import { demoLoginPassword } from './lib/demoCredential'; // v3.237 补 40：值只住在 env（缺了就红），源码里不留字面量

loadEnvForScript();

const BASE = process.env.BAMBOOK_API ?? 'http://127.0.0.1:8081';
const CONTROL = process.argv.includes('--control');
const R = (x: unknown) => (x == null ? null : Math.round(Number(x) * 10000) / 10000);
const eq = (a: unknown, b: unknown) => R(a) === R(b);

const results: { ok: boolean; n: string; d?: string }[] = [];
const say = (s: string) => console.log(s);
const pass = (n: string, d = '') => { results.push({ ok: true, n, d }); say(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n: string, d = '') => { results.push({ ok: false, n, d }); say(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

async function login(): Promise<string | null> {
  for (const email of ['jason.shen@bambook.local', 'charlie.qian@bambook.local', 'melissa.zhao@bambook.local']) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: demoLoginPassword() }),
    });
    const d: any = await res.json().catch(() => ({}));
    if (res.ok && d?.ok) return d.token ?? d.data?.token ?? null;
  }
  return null;
}

/** 逐票比：返回不符清单（可传入被污染的 B 通道，用于对照）。 */
function collide(list: any[], ccActions: any[]) {
  const byId = new Map<string, any>();
  for (const a of ccActions) if (a?.invoiceId != null) byId.set(String(a.invoiceId), a);
  const bad: string[] = [];
  let compared = 0;
  for (const it of list) {
    const cc = byId.get(String(it.id));
    if (!cc) continue;
    compared += 1;
    if (!eq(it.openAmount, cc.openAmount)) bad.push(`${it.id}: 列表=${R(it.openAmount)} vs 日历=${R(cc.openAmount)}`);
  }
  return { bad, compared, onlyList: list.length - compared, onlyCc: ccActions.length - compared };
}

async function main() {
  const token = await login();
  if (!token) { say('✗ 登录失败：三个演示账号均不可用，中止'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}` };
  const getJson = async (p: string) => {
    const r = await fetch(BASE + p, { headers: H });
    const t = await r.text();
    let j: any = null; try { j = JSON.parse(t); } catch { /* 保留原文 */ }
    return { status: r.status, j, raw: t };
  };

  say('════════════════════════════════════════════════════════');
  say(' 派生量对撞 · 未收额（② 类）');
  say(` 端点 ${BASE} · 模式 ${CONTROL ? '只读 + 阳性对照' : '只读'}`);
  say(` 时间 ${new Date().toISOString()}`);
  say('════════════════════════════════════════════════════════');

  const listRes = await getJson('/api/v1/finance?limit=500');
  const items = listRes.j?.items ?? [];
  const ccRes = await getJson('/api/v1/finance/reports/cash-calendar?days=365');
  const ccActions = [...(ccRes.j?.todayActions ?? []), ...(ccRes.j?.upcoming ?? [])];
  say(`\n【取数】发票列表 ${items.length} 张 · 资金日历 ${ccActions.length} 条（todayActions + upcoming）`);

  // ── A. 出口内恒等 + 无声回退计数 ───────────────────────────
  say('\n【A 出口内恒等：openAmount == amount − appliedAmount】');
  if (!items.length) fail('取发票列表', `HTTP ${listRes.status}`);
  else {
    let badA = 0, missing = 0;
    for (const it of items) {
      if (it.openAmount == null) { missing += 1; continue; }   // ← 走到"无声回退成原额"那一支
      const calc = R(Number(it.amount) - Number(it.appliedAmount ?? 0));
      if (!eq(it.openAmount, calc)) { badA += 1; if (badA <= 6) say(`     ✗ ${it.id}: open=${R(it.openAmount)} ≠ amount−applied=${calc}`); }
    }
    if (badA === 0) pass('恒等成立', `${items.length - missing} 张全对`);
    else fail('恒等成立', `${badA} 张不符`);
    if (missing === 0) pass('openAmount 缺失（无声回退）', '0 张');
    else say(`  ⚠️ openAmount 缺失 ${missing} 张 —— 这些会**无声回退成原额**（把"未收"显示成"全额"）`);
  }

  // ── B. 出口间对撞 ──────────────────────────────────────────
  say('\n【B 出口间对撞：列表 openAmount ⇄ 资金日历 openAmount】');
  if (!items.length || !ccActions.length) fail('取数', '有一侧为空 ⇒ 本格无法下判');
  else {
    const c = collide(items, ccActions);
    say(`  两处都出现的票 ${c.compared} 张（仅列表 ${c.onlyList} / 仅日历 ${c.onlyCc}）`);
    if (c.compared === 0) fail('两处都出现的票数', '为 0 ⇒ 这条对撞在空集上跑，等于没跑');
    else if (c.bad.length === 0) pass('逐票未收额一致', `${c.compared} 张全对`);
    else fail('逐票未收额一致', `${c.bad.length} 张不符：${c.bad.slice(0, 5).join(' · ')}`);

    if (CONTROL) {
      const poisoned = JSON.parse(JSON.stringify(ccActions));
      poisoned[0].openAmount = R(Number(poisoned[0].openAmount) + 1);
      const c2 = collide(items, poisoned);
      if (c2.bad.length > 0) pass('阳性对照（日历侧 openAmount +1 ⇒ 必须红）', `报出 ${c2.bad.length} 张 —— 这条尺有牙`);
      else fail('阳性对照（日历侧 openAmount +1 ⇒ 必须红）', '改坏了却仍全绿 ⇒ **这条尺瞎了**，上面的"通过"不算数');
    }
  }

  // ── C. 逾期额：账龄表自己的两条恒等（**不重实现桶逻辑**，故不引入第二套真源）────
  //   ① 行内：每客户的 `buckets.total == current + d1_30 + d31_60 + d61_90 + d90plus`
  //   ② 汇总：`totals[币种]` 各桶 == 该币种下各客户行各桶之和
  //   两条都是"同一份响应内部"的恒等 ⇒ 抓的是"汇总与明细对不上"，不靠我另算一遍账龄。
  say('\n【C 逾期额：账龄表的行内恒等 + 汇总恒等】');
  const aging = await getJson('/api/v1/finance/reports/aging');
  const rows = aging.j?.rows ?? [];
  const totals = aging.j?.totals ?? [];
  const BK = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
  if (!rows.length || !totals.length) fail('取账龄表', `rows=${rows.length} totals=${totals.length}`);
  else {
    let badRow = 0;
    for (const r of rows) {
      const sum = BK.reduce((s, k) => s + (Number(r.buckets?.[k]) || 0), 0);
      if (!eq(r.buckets?.total, sum)) { badRow += 1; if (badRow <= 5) say(`     ✗ ${r.customerRelationId}: total=${R(r.buckets?.total)} ≠ Σ桶=${R(sum)}`); }
    }
    if (badRow === 0) pass('行内恒等 total == Σ五个逾期桶', `${rows.length} 个客户全对`);
    else fail('行内恒等 total == Σ五个逾期桶', `${badRow} 个客户不符`);

    // 汇总恒等：按币种分组比
    const byCcy = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const c = String(r.currency);
      const acc = byCcy.get(c) ?? {};
      for (const k of [...BK, 'total'] as const) acc[k] = R((acc[k] ?? 0) + (Number(r.buckets?.[k]) || 0))!;
      byCcy.set(c, acc);
    }
    let badTot = 0; let compared = 0;
    for (const t of totals) {
      const c = String(t.currency); const acc = byCcy.get(c);
      if (!acc) continue;
      compared += 1;
      for (const k of [...BK, 'total'] as const) {
        if (!eq(t[k], acc[k])) { badTot += 1; if (badTot <= 5) say(`     ✗ ${c} ${k}: totals=${R(t[k])} ≠ Σ行=${R(acc[k])}`); }
      }
    }
    if (compared === 0) fail('汇总恒等', '没有可比的币种 ⇒ 这条对撞在空集上跑');
    else if (badTot === 0) pass('汇总恒等 totals[币种] == Σ该币种各行', `${compared} 个币种 × 6 格全对`);
    else fail('汇总恒等 totals[币种] == Σ该币种各行', `${badTot} 处不符`);

    if (CONTROL) {
      // 阳性对照：把某客户行的一个桶内存 +1 ⇒ 行内恒等必须红；把某币种汇总的一个桶 +1 ⇒ 汇总恒等必须红
      const p1 = JSON.parse(JSON.stringify(rows)); p1[0].buckets.d1_30 = R(Number(p1[0].buckets.d1_30) + 1);
      const bad1 = p1.filter((r: any) => !eq(r.buckets?.total, BK.reduce((s, k) => s + (Number(r.buckets?.[k]) || 0), 0))).length;
      if (bad1 > 0) pass('阳性对照 A（某行 d1_30 +1 ⇒ 行内恒等必须红）', `报出 ${bad1} 行 —— 有牙`);
      else fail('阳性对照 A', '改坏了却仍全绿 ⇒ 行内恒等这条尺瞎了');
      const p2 = JSON.parse(JSON.stringify(totals)); p2[0].total = R(Number(p2[0].total) + 1);
      const c0 = String(p2[0].currency); const acc0 = byCcy.get(c0);
      const bad2 = acc0 && !eq(p2[0].total, acc0.total) ? 1 : 0;
      if (bad2 > 0) pass('阳性对照 B（某币种汇总 total +1 ⇒ 汇总恒等必须红）', '报出 1 处 —— 有牙');
      else fail('阳性对照 B', '改坏了却仍全绿 ⇒ 汇总恒等这条尺瞎了');
    }
  }

  // ── D. 真源直连：账龄页每客户的**张数** ⇄ 用真源 where 数出来的张数 ────────
  //   为什么这条最要紧：`openReceivable` 这个真源就是为了"0 元票被当成未结清应收"那一族而立的
  //   （见其头注释：6 个消费点各自手写 status 集合、不看金额 ⇒ 0 元票虚增逾期且永不清零）。
  //   所以对撞要问的正是：**账龄页算进去的那批票，与真源认的那批票，是不是同一批**。
  //   ★ 这里**只调真源导出的 `openReceivableWhere()`**，不自己写 status 集合（同源纪律）。
  say('\n【D 真源直连：账龄页张数 ⇄ openReceivable 真源 where 的张数】');
  if (!rows.length) fail('真源直连', '没有账龄行可用');
  else {
    const { openReceivableWhere } = await import('../server/src/shared/openReceivable');
    const { createRequire } = await import('node:module');
    const { SERVER_DIR: SD } = await import('./lib/acceptance-selfcheck.mjs');
    const req = createRequire(SD + '/');
    const { PrismaClient } = req('@prisma/client');
    const prisma = new PrismaClient();
    try {
      let bad = 0; let compared = 0; const diffs: string[] = [];
      for (const r of rows) {
        const cid = r.customerRelationId;
        if (!cid) continue;
        const n = await prisma.invoice.count({ where: openReceivableWhere({ customerRelationId: cid }) as any });
        compared += 1;
        if (Number(n) !== Number(r.invoiceCount)) {
          bad += 1;
          if (diffs.length < 6) diffs.push(`${cid}: 账龄报 ${r.invoiceCount} 张 vs 真源数出 ${n} 张`);
        }
      }
      if (compared === 0) fail('真源直连', '没有可比客户 ⇒ 空集上跑');
      else if (bad === 0) pass('张数一致（账龄算进去的票 = 真源认的票）', `${compared} 个客户全对`);
      else fail('张数一致', `${bad} 个客户不符：${diffs.join(' · ')}`);

      if (CONTROL) {
        // 阳性对照（纯内存）：把某客户的账龄张数 +1 ⇒ 必须红
        const poisoned = Number(rows[0].invoiceCount) + 1;
        const n0 = await prisma.invoice.count({ where: openReceivableWhere({ customerRelationId: rows[0].customerRelationId }) as any });
        if (Number(poisoned) !== Number(n0)) pass('阳性对照（账龄张数 +1 ⇒ 必须红）', `报出 1 处 —— 有牙`);
        else fail('阳性对照', '改坏了却仍判一致 ⇒ 这条尺瞎了');
      }
    } finally { await prisma.$disconnect(); }
  }

  const failed = results.filter((r) => !r.ok);
  say('\n════════════════════════════════════════════════════════');
  say(` 通过 ${results.length - failed.length} · 失败 ${failed.length}`);
  say(' ⚠️ 结论须标「输入为模拟数据」；库=本机 panda_hub_local，与常驻后端共享');
  say(' ⚠️ 本脚本只核"两出口一致"；「夹零 vs 允许负」属业务口径（留 §12.1 等拍），本脚本不判');
  say('════════════════════════════════════════════════════════');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`✗ 异常：${e?.message || e}`); process.exit(1); });
