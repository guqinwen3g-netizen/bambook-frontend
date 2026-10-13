// ★★ 跨视图同值走查（③ 类）—— 同一笔业务数字，在不同**页面**取到的值必须一致
//
// 为什么要单独一个脚本：`acceptance-crossview-amount.ts` 核的是「① 主档 vs 明细行」
// （真源采纳面），它**没有**逐面取值。本脚本补的正是「③ 跨视图同值」。
//
// 本脚本核两条（都只读）：
//   ③-a 应收账龄：账龄页 `/api/v1/finance/reports/aging` ⇄ 驾驶舱应收区
//        `/api/v1/dashboard/cockpit` 的 `arApAlerts.receivable`
//        —— 两处**同一结构**（customerRelationId + currency + invoiceCount + buckets），
//        按客户逐格对撞。驾驶舱是"另一条渲染路径"，不是同一份响应。
//   ③-b 订单金额：列表 `/api/v2/orders` ⇄ 详情 `/api/v2/orders/:id`
//        —— 同一订单在列表与详情取到的金额/数量必须相等。
//
// ★ 每条**自带能红的对照**（本仓规矩：没有阳性对照的"通过"不算通过）：
//   `--control` 会把 B 通道的某个数人为改坏一次，**同一条比较必须报红**；若它照样绿，
//   说明这条尺没有牙（判据坏了，不是数据好了）。对照是**纯内存**的，不写库。
//
// 用法（只读）：
//   npx tsx scripts/acceptance-crossview-views.ts
//   npx tsx scripts/acceptance-crossview-views.ts --control
import { SERVER_DIR, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import { demoLoginPassword } from './lib/demoCredential'; // v3.237 补 40：值只住在 env（缺了就红），源码里不留字面量

loadEnvForScript();

const BASE = process.env.BAMBOOK_API ?? 'http://127.0.0.1:8081';
const CONTROL = process.argv.includes('--control');
const R = (x: unknown) => (x == null ? null : Math.round(Number(x) * 100) / 100);
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

const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'total'] as const;

/** 拉两个通道，按 customerRelationId 逐格比。返回不符条数（可注入污染用于对照）。 */
function collideAging(agingRows: any[], cockpitRows: any[]) {
  const byId = new Map<string, any>();
  for (const r of cockpitRows) byId.set(String(r.customerRelationId), r);
  const bad: string[] = [];
  let compared = 0;
  for (const a of agingRows) {
    const c = byId.get(String(a.customerRelationId));
    if (!c) continue;                       // 只在两处都出现的客户上对撞（缺席另算，不混进这一格）
    compared += 1;
    if (String(a.currency) !== String(c.currency)) bad.push(`${a.customerRelationId} currency ${a.currency}≠${c.currency}`);
    if (Number(a.invoiceCount) !== Number(c.invoiceCount)) bad.push(`${a.customerRelationId} invoiceCount ${a.invoiceCount}≠${c.invoiceCount}`);
    for (const k of BUCKETS) {
      if (!eq(a.buckets?.[k], c.buckets?.[k])) bad.push(`${a.customerRelationId} ${k} ${a.buckets?.[k]}≠${c.buckets?.[k]}`);
    }
  }
  return { bad, compared, onlyAging: agingRows.length - compared, onlyCockpit: cockpitRows.length - compared };
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
  say(' 跨视图同值走查（③ 类）');
  say(` 端点 ${BASE} · 模式 ${CONTROL ? '只读 + 阳性对照' : '只读'}`);
  say(` 时间 ${new Date().toISOString()}`);
  say('════════════════════════════════════════════════════════');

  // ── ③-a 应收账龄：账龄页 ⇄ 驾驶舱应收区 ────────────────────
  say('\n【③-a 应收账龄：账龄页 ⇄ 驾驶舱应收区】');
  const aging = await getJson('/api/v1/finance/reports/aging');
  const cockpit = await getJson('/api/v1/dashboard/cockpit');
  const agingRows = aging.j?.rows ?? [];
  const cockpitRows = cockpit.j?.arApAlerts?.receivable?.rows ?? [];
  if (!agingRows.length || !cockpitRows.length) {
    fail('取数', `账龄 rows=${agingRows.length} / 驾驶舱应收 rows=${cockpitRows.length}（有一侧为空 ⇒ 本格无法下判）`);
  } else {
    say(`  账龄页 ${agingRows.length} 个客户 · 驾驶舱应收区 ${cockpitRows.length} 个客户`);
    const a = collideAging(agingRows, cockpitRows);
    if (a.compared === 0) fail('两处都出现的客户数', '为 0 ⇒ 这条对撞在空集上跑，等于没跑');
    else if (a.bad.length === 0) pass('逐客户逐格一致', `${a.compared} 个客户 × ${BUCKETS.length} 格全对（仅账龄侧 ${a.onlyAging} / 仅驾驶舱侧 ${a.onlyCockpit}）`);
    else fail('逐客户逐格一致', `${a.bad.length} 处不符：${a.bad.slice(0, 6).join(' · ')}`);

    // ★ 阳性对照：把 B 通道（驾驶舱那份）**内存里**改坏一格，同一条比较必须红
    if (CONTROL) {
      const poisoned = JSON.parse(JSON.stringify(cockpitRows));
      poisoned[0].buckets.total = R(Number(poisoned[0].buckets.total) + 1);
      const a2 = collideAging(agingRows, poisoned);
      if (a2.bad.length > 0) pass('阳性对照（驾驶舱 total +1 ⇒ 必须红）', `报出 ${a2.bad.length} 处 —— 这条尺有牙`);
      else fail('阳性对照（驾驶舱 total +1 ⇒ 必须红）', '改坏了却仍全绿 ⇒ **这条尺瞎了**，上面的"通过"不算数');
    }
  }

  // ── ③-b 订单金额：列表 ⇄ 详情 ─────────────────────────────
  say('\n【③-b 订单金额：列表 ⇄ 详情】');
  const list = await getJson('/api/v2/orders?limit=300');
  const orders = list.j?.items ?? [];
  if (!orders.length) fail('取订单列表', `HTTP ${list.status}`);
  else {
    const N = Math.min(orders.length, 12);
    let bad = 0, compared = 0;
    const dets: any[] = [];
    for (const o of orders.slice(0, N)) {
      const det = await getJson(`/api/v2/orders/${encodeURIComponent(o.id)}`);
      const d = det.j?.order ?? det.j ?? null;
      dets.push(d);
      if (!d) { bad += 1; say(`     ✗ ${o.id}: 详情取不到（HTTP ${det.status}）`); continue; }
      compared += 1;
      for (const k of ['totalNet', 'quantity', 'contractAmount', 'quoteAmount'] as const) {
        if (k in o && k in d && !eq(o[k], d[k])) { bad += 1; say(`     ✗ ${o.id}: ${k} 列表=${R(o[k])} vs 详情=${R(d[k])}`); }
      }
    }
    if (bad === 0) pass('同一订单金额/数量列表 = 详情', `${compared} 单全对`);
    else fail('同一订单金额/数量列表 = 详情', `${bad} 处不符`);

    if (CONTROL) {
      const poisoned = JSON.parse(JSON.stringify(dets[0]));
      poisoned.totalNet = R(Number(poisoned.totalNet) + 1);
      let hit = 0;
      const o0 = orders[0];
      for (const k of ['totalNet', 'quantity', 'contractAmount', 'quoteAmount'] as const) {
        if (k in o0 && k in poisoned && !eq(o0[k], poisoned[k])) hit += 1;
      }
      if (hit > 0) pass('阳性对照（详情 totalNet +1 ⇒ 必须红）', `命中 ${hit} 格 —— 这条尺有牙`);
      else fail('阳性对照（详情 totalNet +1 ⇒ 必须红）', '改坏了却仍判一致 ⇒ **这条尺瞎了**');
    }
  }

  // ── 汇总 ──────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  say('\n════════════════════════════════════════════════════════');
  say(` 通过 ${results.length - failed.length} · 失败 ${failed.length}`);
  say(` ⚠️ 结论须标「输入为模拟数据」；库=本机 panda_hub_local，与常驻后端共享`);
  say('════════════════════════════════════════════════════════');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`✗ 异常：${e?.message || e}`); process.exit(1); });
