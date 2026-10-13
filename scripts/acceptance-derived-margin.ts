// ★★ 派生量对撞 · 毛利（② 类第 4 条）—— 驾驶舱「订单毛利表」的口径自洽
//
// 为什么只核「内部自洽」而**不**核「驾驶舱 == 利润表」：
//   实测两者成本来源根本不同（驾驶舱认计划采购价/供应商发票；利润表只认实际采购资金流/发票），
//   同一张订单差 2.7 倍 ⇒ 口径已定案「不同口径、不要求相等、各按各的内部自洽」（台账 §12.05 **D102**）。
//   ⇒ 本尺核的就是驾驶舱那一侧的**内部**恒等：
//     A. 行内：`revenue − costInSalesCurrency == margin`（每一行，绝对值容差 1e-3）
//     B. 汇总：每币种 `totals[].revenue − totals[].cost == totals[].margin`
//     C. 阳性对照（`--control`）：把某一行 `margin` **内存** +1 ⇒ 同一条比较必须报红（不写库）
//
// ⚠️ 数据前提（fail-closed，不许把"空集"读成通过）：
//   毛利只对有成本的订单出数；本地演示数据里带成本的单是我用 `scripts/seed-margin-cost-drill.mjs`
//   临时造出来的（`--apply` 造 / `--revert` 还原）⇒ 若 `有毛利的行 = 0`，本尺**判"无法下判"**并提示先造数。
//   另：`cost`/`margin` 被 `dashboard/sensitiveMask` 按 `sensitive:cost`/`sensitive:profit` 遮罩 ⇒
//   被遮罩时同样是"无法下判"，**不许**当成"全部一致"。
//
// 用法：
//   npx tsx scripts/acceptance-derived-margin.ts
//   npx tsx scripts/acceptance-derived-margin.ts --control
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import { demoLoginPassword } from './lib/demoCredential'; // v3.237 补 40：值只住在 env（缺了就红），源码里不留字面量

loadEnvForScript();

const BASE = process.env.BAMBOOK_API ?? 'http://127.0.0.1:8081';
const CONTROL = process.argv.includes('--control');
const TOL = 1e-3; // ★ 绝对容差（金额一律 4 位小数；相对容差在 38 万级上等于几百块，会瞎）
const N = (x: unknown) => (x == null ? null : Number(x));
const R = (x: unknown) => (x == null ? null : Math.round(Number(x) * 10000) / 10000);

const results: { ok: boolean | null; n: string; d?: string }[] = [];
const say = (s: string) => console.log(s);
const pass = (n: string, d = '') => { results.push({ ok: true, n, d }); say(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n: string, d = '') => { results.push({ ok: false, n, d }); say(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
/**
 * ★ 2026-09-29 新增：**"无法下判"记缺口、不记失败** —— 与本仓约定一致
 *   （runner 的退出码"只看 fail/timeout，gap 不算失败"；`credit-note-settlement-gap` 那条
 *    2026-09-17 的改判用的是同一条理由：**用 fail 会让脚本永远红 ⇒ 失去复跑价值**）。
 *   本脚本典型的"无法下判"＝库里没有成本数据（`purchasePrice` 全空）⇒ 有毛利的行 = 0，
 *   此时**既不该报通过、也不该报失败**，只该说"先造数"。
 */
const gap = (n: string, d = '') => { results.push({ ok: null, n, d }); say(`  ⚠️  [gap] ${n}${d ? ' — ' + d : ''}`); };

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

/** A 通道：逐行核 `revenue − costInSalesCurrency == margin`，返回不符清单。 */
function collideRows(rows: any[]) {
  const bad: string[] = [];
  let compared = 0;
  for (const r of rows) {
    const rev = N(r?.revenue), cost = N(r?.costInSalesCurrency), m = N(r?.margin);
    if (rev == null || cost == null || m == null) continue;
    compared += 1;
    if (Math.abs(rev - cost - m) > TOL) {
      bad.push(`${r.orderId ?? r.poNumber}: ${R(rev)} − ${R(cost)} = ${R(rev - cost)} ≠ margin ${R(m)}`);
    }
  }
  return { bad, compared };
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
  say(' 派生量对撞 · 毛利（② 类 · 驾驶舱「订单毛利表」内部自洽）');
  say(` 端点 ${BASE} · 模式 ${CONTROL ? '只读 + 阳性对照' : '只读'}`);
  say(` 时间 ${new Date().toISOString()}`);
  say('★ 口径：驾驶舱=计划/合同毛利、利润表=实际毛利，两者**不要求相等**（D102）；本尺只核驾驶舱内部');
  say('════════════════════════════════════════════════════════');

  const ck = await getJson('/api/v1/dashboard/cockpit');
  const om = ck.j?.orderMargins;
  if (!om || !Array.isArray(om.rows)) { fail('取驾驶舱 orderMargins', `HTTP ${ck.status} ${String(ck.raw).slice(0, 160)}`); }
  else {
    const rows: any[] = om.rows;
    const totals: any[] = Array.isArray(om.totals) ? om.totals : [];
    const withMargin = rows.filter((r) => N(r?.margin) != null && N(r?.costInSalesCurrency) != null && N(r?.revenue) != null);
    say(`\n【取数】${rows.length} 行（其中**有毛利** ${withMargin.length} 行）· totals ${totals.length} 条 · excludedCount=${om.excludedCount ?? '?'}`);

    // ── A. 行内恒等 ───────────────────────────────────────────
    say('\n【A 行内恒等：revenue − costInSalesCurrency == margin】');
    if (withMargin.length === 0) {
      gap('A 本格无法下判（有毛利的行 = 0）',
        '要么这批单没有成本数据（先跑 scripts/seed-margin-cost-drill.mjs --apply）、要么 cost/margin 被遮罩（账号缺 sensitive:cost / sensitive:profit）——**不许读成通过**');
    } else {
      const a = collideRows(withMargin);
      if (a.bad.length === 0) pass('A 恒等成立', `${a.compared} 行全对（绝对值容差 ${TOL}）`);
      else fail('A 恒等成立', `${a.bad.length}/${a.compared} 行不符：${a.bad.slice(0, 5).join(' · ')}`);
    }

    // ── B. 汇总恒等（每币种一行）───────────────────────────────
    say('\n【B 汇总恒等：totals[].revenue − totals[].cost == totals[].margin】');
    const tOk = totals.filter((t) => N(t?.revenue) != null && N(t?.cost) != null && N(t?.margin) != null);
    if (tOk.length === 0) {
      say('  ⚠️ 汇总行一条都取不到（可能被遮罩或本就没有可计毛利的币种）⇒ 本格跳过，不判通过');
    } else {
      const bad = tOk.filter((t) => Math.abs(Number(t.revenue) - Number(t.cost) - Number(t.margin)) > TOL)
        .map((t) => `${t.currency}: ${R(t.revenue)} − ${R(t.cost)} = ${R(Number(t.revenue) - Number(t.cost))} ≠ ${R(t.margin)}`);
      if (bad.length === 0) pass('B 汇总恒等成立', `${tOk.length} 个币种全对`);
      else fail('B 汇总恒等成立', bad.join(' · '));
    }

    // ── C. 阳性对照：**两个操作数各投一次毒** ─────────────────
    //   恒等式 `revenue − costInSalesCurrency == margin` 有三个操作数；
    //   只毒 margin 只证"右边会红"，**毒 revenue** 才把左边那个加数也纳入证据面
    //   —— ②-5（收入）此前正是"被间接覆盖、无对照"的那一格。
    if (CONTROL) {
      say('\n【C 阳性对照（内存 +1，不写库；两个操作数各一格）】');
      const usable = rows.filter((r) => N(r?.margin) != null && N(r?.costInSalesCurrency) != null && N(r?.revenue) != null);
      if (usable.length === 0) fail('C 阳性对照无法构造', '没有可用行 ⇒ 对照跑不起来（这是"空集"，不是"有牙"）');
      else {
        const arms: { key: 'margin' | 'revenue'; label: string }[] = [
          { key: 'margin', label: 'C1 阳性对照（某行 margin +1 ⇒ 必须红）' },
          { key: 'revenue', label: 'C2 阳性对照（某行 revenue +1 ⇒ 必须红；这一格覆盖 ②-5 收入那侧）' },
        ];
        for (const arm of arms) {
          const poisoned = rows.map((r) => ({ ...r }));
          const idx = poisoned.findIndex((r) => N(r?.margin) != null && N(r?.costInSalesCurrency) != null && N(r?.revenue) != null);
          poisoned[idx][arm.key] = Number(poisoned[idx][arm.key]) + 1;
          const a2 = collideRows(poisoned.filter((r) => N(r?.margin) != null && N(r?.costInSalesCurrency) != null && N(r?.revenue) != null));
          if (a2.bad.length > 0) pass(arm.label, `报出 ${a2.bad.length} 行 —— 这条尺有牙`);
          else fail(arm.label, '改坏了却仍全绿 ⇒ **这条尺瞎了**，上面的"通过"不算数');
        }
      }
    }
  }

  const bad = results.filter((r) => r.ok === false).length;
  const gaps = results.filter((r) => r.ok === null).length;
  say(`\n══ 结果：${results.length - bad - gaps} 通过 / ${bad} 失败${gaps ? ` / ${gaps} 缺口` : ''} ══`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
