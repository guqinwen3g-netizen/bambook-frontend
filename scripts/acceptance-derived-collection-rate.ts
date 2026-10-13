// ★★ 派生量对撞 · 回款率（② 类第 6 条）—— 驾驶舱「业务员榜」那一行的三个数必须自洽
//
// 为什么此前判"接不上"：驾驶舱的**订单行**只暴露 `collectionRate`（率），不暴露分子 ⇒ 同一响应内做不了恒等。
// ★ v3.87 找到出口：**按业务员的汇总行**（`salesLeaderboard[]`）同时给出三个数 ——
//   `salesAmount`（分母）· `collectedAmount`（**分子，且不在敏感矩阵内**）· `collectionRate`（率，sensitive:profit）。
//   ⇒ 就能核「率 == 分子 ÷ 分母」这条**行内恒等**（与账龄那条"行内恒等"同一形状：抓的是同一份响应里自相矛盾）。
//
// 本脚本核三件（只读）：
//   A. 行内恒等：`collectionRate == round4(collectedAmount / salesAmount)`（逐行）
//   B. 阳性对照（`--control`，两个操作数各一格）：毒 `collectedAmount` +1 / 毒 `collectionRate` +0.01 ⇒ 都必须红
//   C. fail-closed：没有可用行（要么榜单为空、要么率被遮罩）⇒ 判「无法下判」，**不许读成通过**
//
// 用法：
//   npx tsx scripts/acceptance-derived-collection-rate.ts
//   npx tsx scripts/acceptance-derived-collection-rate.ts --control
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import { demoLoginPassword } from './lib/demoCredential'; // v3.237 补 40：值只住在 env（缺了就红），源码里不留字面量

loadEnvForScript();

const BASE = process.env.BAMBOOK_API ?? 'http://127.0.0.1:8081';
const CONTROL = process.argv.includes('--control');
const N = (x: unknown) => (x == null ? null : Number(x));
const R4 = (x: number) => Math.round(x * 10000) / 10000;

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

/** 逐行核 `率 == 分子 ÷ 分母`，返回不符清单（可传入被污染的行，用于对照）。 */
function collide(rows: any[]) {
  const bad: string[] = [];
  let compared = 0;
  for (const r of rows) {
    const den = N(r?.salesAmount), num = N(r?.collectedAmount), rate = N(r?.collectionRate);
    if (den == null || num == null || rate == null) continue;
    if (!(den > 0)) continue;
    compared += 1;
    const want = R4(num / den);
    // ★ 容差收到 round4 的**最小可表示步长**（两侧都已被服务端 round4 ⇒ 精确相等才放行）：
    //   5e-5 那种松容差会让"分子动了一点、率没跟上"溜过去（对照 B1 第一版就是这么瞎的）。
    if (Math.abs(rate - want) > 1e-9) bad.push(`${r.salesPerson ?? '?'}/${r.currency ?? '?'}: 率=${rate} vs ${num}÷${den}=${want}`);
  }
  return { bad, compared };
}

async function main() {
  const token = await login();
  if (!token) { say('✗ 登录失败：三个演示账号均不可用，中止'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}` };
  const r = await fetch(`${BASE}/api/v1/dashboard/cockpit`, { headers: H });
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch { /* 保留原文 */ }

  say('════════════════════════════════════════════════════════');
  say(' 派生量对撞 · 回款率（② 类 · 驾驶舱业务员榜的行内恒等）');
  say(` 端点 ${BASE} · 模式 ${CONTROL ? '只读 + 阳性对照' : '只读'}`);
  say(` 时间 ${new Date().toISOString()}`);
  say('★ 口径：率 = collectedAmount ÷ salesAmount（round4）；分子分母都不在敏感矩阵内，率本身是 sensitive:profit');
  say('════════════════════════════════════════════════════════');

  const lb: any[] = Array.isArray(j?.salesLeaderboard) ? j.salesLeaderboard : [];
  if (!lb.length) {
    fail('取 salesLeaderboard', `HTTP ${r.status} · 榜单 ${lb.length} 行 ⇒ 本格无法下判（不许读成通过）—— 若是空库/无单，属"空集"，不是"一致"`);
  } else {
    const usable = lb.filter((x) => N(x?.salesAmount) > 0 && N(x?.collectedAmount) != null && N(x?.collectionRate) != null);
    const masked = lb.filter((x) => N(x?.salesAmount) > 0 && N(x?.collectedAmount) != null && N(x?.collectionRate) == null);
    say(`\n【取数】榜单 ${lb.length} 行 · 可用 ${usable.length} 行${masked.length ? ` · 率被遮罩 ${masked.length} 行` : ''}`);

    say('\n【A 行内恒等：collectionRate == collectedAmount ÷ salesAmount】');
    if (usable.length === 0) {
      fail('A 本格无法下判（可用行 = 0）',
        '要么榜单为空、要么 `collectionRate` 被 sensitive:profit 遮罩（换一个有该权限的账号）—— **不许读成通过**');
    } else {
      const a = collide(usable);
      if (a.bad.length === 0) pass('A 恒等成立', `${a.compared} 行全对`);
      else fail('A 恒等成立', `${a.bad.length}/${a.compared} 行不符：${a.bad.slice(0, 5).join(' · ')}`);
    }

    if (CONTROL) {
      say('\n【B 阳性对照（内存 +1 / +0.01，不写库；两个操作数各一格）】');
      if (usable.length === 0) fail('B 阳性对照无法构造', '没有可用行 ⇒ 对照跑不起来（这是"空集"，不是"有牙"）');
      else {
        const arms: { key: 'collectedAmount' | 'collectionRate'; label: string; bump: (row: any) => number }[] = [
          // ★ 对照第一版用 `+1` ⇒ **看不见**（率被 round4 到小数第 4 位，1/大分母 的变化低于分辨率）。
          //   这正是 B208 那条教训的同族（"没有分辨率的对照等于没有对照"）⇒ 改成 1% 的可见位移，并把分辨率打进输出。
          { key: 'collectedAmount', label: 'B1 阳性对照（某行 collectedAmount +1% ÷ 分母 ⇒ 必须红）', bump: (row) => Math.max(1, Number(row.salesAmount) * 0.01) },
          { key: 'collectionRate', label: 'B2 阳性对照（某行 collectionRate +0.01 ⇒ 必须红）', bump: () => 0.01 },
        ];
        say('  本尺分辨率：率是 round4（小数第 4 位）⇒ 分子变化小于「分母 × 1e-4」时**不可见**（服务端语义，不是我放宽的）');
        for (const arm of arms) {
          const poisoned = lb.map((x) => ({ ...x }));
          const idx = poisoned.findIndex((x) => N(x?.salesAmount) > 0 && N(x?.collectedAmount) != null && N(x?.collectionRate) != null);
          poisoned[idx][arm.key] = Number(poisoned[idx][arm.key]) + arm.bump(poisoned[idx]);
          const a2 = collide(poisoned.filter((x) => N(x?.salesAmount) > 0 && N(x?.collectedAmount) != null && N(x?.collectionRate) != null));
          if (a2.bad.length > 0) pass(arm.label, `报出 ${a2.bad.length} 行 —— 这条尺有牙`);
          else fail(arm.label, '改坏了却仍全绿 ⇒ **这条尺瞎了**，上面的"通过"不算数');
        }
      }
    }
  }

  const bad = results.filter((x) => !x.ok).length;
  say(`\n══ 结果：${results.length - bad} 通过 / ${bad} 失败 ══`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
