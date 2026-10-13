// ★★ 跨页数字一致走查 —— 订单金额口径对撞（真库 · 自回滚）
//
// Kevin 原话：「跳来跳去，数字要一致」——同一笔业务数字，在不同页面/模块显示的值对不上。
//
// ★★ 本脚本**不自带口径**：前端概览页取什么值，直接调用**生产同一份真源**
//    `shared/orderAmount.ts`。若脚本自己再写一套 `contractAmount ?? quoteAmount`，
//    就会与真源漂移，产生假红/假绿 —— 那正是本次要消灭的问题本身。
//
// 覆盖的出口（2026-09-18 盘点）：
//   A 组 contractAmount ?? quoteAmount → dashboardService / seasonService   【已收编】
//   B 组 totalNet ?? quoteAmount       → reconciliationService / orderShipmentBatchService 【已收编】
//   C 组 quoteAmount 裸用              → components/Dashboard.tsx            【已收编】
//
// 用法：
//   npx tsx scripts/acceptance-crossview-amount.ts           # 只读
//   npx tsx scripts/acceptance-crossview-amount.ts --mutate  # 变异态演练（改价后自回滚）
import { createRequire } from 'node:module';
import { demoLoginPassword } from './lib/demoCredential'; // v3.237 补 40：值只住在 env（缺了就红），源码里不留字面量
import { SERVER_DIR, REPO_ROOT, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import fs from 'node:fs';
import path from 'node:path';

const req = createRequire(SERVER_DIR + '/');
loadEnvForScript();

// ★ 判据与生产同一份真源
import { orderAmountOf } from '../server/src/shared/orderAmount';

const ROOT = REPO_ROOT;
const BASE = process.env.BAMBOOK_API ?? 'http://127.0.0.1:8081';
const MUTATE = process.argv.includes('--mutate');

const R = (x: any) => (x == null ? null : Math.round(Number(x) * 100) / 100);
const eq = (a: any, b: any) => R(a) === R(b);

const results: { ok: boolean; n: string; d?: string }[] = [];
const say = (s: string) => console.log(s);
const pass = (n: string, d = '') => { results.push({ ok: true, n, d }); say(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n: string, d = '') => { results.push({ ok: false, n, d }); say(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const info = (n: string, d = '') => { results.push({ ok: true, n, d }); say(`  ⓘ ${n}${d ? ' — ' + d : ''}`); };

async function login(email: string): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: demoLoginPassword() }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.ok) return null;
  return d.token ?? d.data?.token ?? d.accessToken ?? null;
}

async function main() {
  const token = await login('jason.shen@bambook.local')
    ?? await login('charlie.qian@bambook.local')
    ?? await login('melissa.zhao@bambook.local');
  if (!token) { say('✗ 登录失败：三个账号均不可用，中止'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}` };
  const getJson = async (p: string) => {
    const r = await fetch(BASE + p, { headers: H });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch { /* HTML fallback 保留原文 */ }
    return { status: r.status, j, raw: t };
  };

  say('════════════════════════════════════════════════════════');
  say(' 跨页数字一致走查 —— 订单金额口径对撞');
  say(` 端点 ${BASE} · 模式 ${MUTATE ? '变异态演练（自回滚）' : '只读'}`);
  say(` 时间 ${new Date().toISOString()}`);
  say('════════════════════════════════════════════════════════');

  // ── ① 全量取数 ────────────────────────────────────────────
  const list = await getJson('/api/v2/orders?limit=300');
  if (!list.j?.items) { say(`✗ 取订单列表失败 HTTP ${list.status}：${list.raw.slice(0, 300)}`); process.exit(1); }
  const orders = list.j.items;
  say(`\n【① 全量订单】${orders.length} 单`);

  // ── ② 各视图是否都指向真源 ────────────────────────────────
  say('\n【② 真源对撞：同一订单在各视图取到的值】');
  let splitCount = 0;
  for (const o of orders) {
    // 前端概览页的取值（**调用生产同一份真源**）
    const viaTruth = orderAmountOf(o);
    const viaTotalNet = o.totalNet;
    if (!eq(viaTruth, viaTotalNet)) {
      splitCount += 1;
      if (splitCount <= 10) say(`     ✗ ${o.code ?? o.id}: 真源=${R(viaTruth)} vs totalNet=${R(viaTotalNet)}`);
    }
  }
  if (splitCount === 0) pass('真源取值与 totalNet 一致', `${orders.length} 单全对（演示数据四字段本就相等）`);
  else fail('真源取值与 totalNet 一致', `${splitCount} 单不符`);

  // 硬恒等
  let hardBad = 0;
  for (const o of orders) {
    const ls = o.lines ?? [];
    if (ls.length === 0) continue;
    const sumNet = ls.reduce((s: number, l: any) => s + (Number(l.netValue) || 0), 0);
    const sumCalc = ls.reduce((s: number, l: any) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);
    if (!eq(sumNet, sumCalc)) { hardBad += 1; if (hardBad <= 8) say(`     ✗ ${o.code ?? o.id}: ΣnetValue=${R(sumNet)} ≠ Σ(qty×price)=${R(sumCalc)}`); }
  }
  if (hardBad === 0) pass('硬恒等 ΣnetValue = Σ(qty × unitPrice)', `${orders.length} 单全对`);
  else fail('硬恒等 ΣnetValue = Σ(qty × unitPrice)', `${hardBad} 单不符`);

  let qtyBad = 0;
  for (const o of orders) {
    const ls = o.lines ?? [];
    if (ls.length === 0) continue;
    const sumQty = ls.reduce((s: number, l: any) => s + (Number(l.quantity) || 0), 0);
    if (!eq(o.quantity, sumQty)) { qtyBad += 1; if (qtyBad <= 8) say(`     ✗ ${o.code ?? o.id}: quantity=${o.quantity} ≠ Σ行=${sumQty}`); }
  }
  if (qtyBad === 0) pass('数量恒等 quantity = Σ行 quantity', `${orders.length} 单全对`);
  else fail('数量恒等 quantity = Σ行 quantity', `${qtyBad} 单不符`);

  // ── ③ 变异态：手工改 quoteAmount，各视图还一致吗 ──────────
  if (!MUTATE) {
    say('\n【③ 变异态对撞】跳过（只读模式）。加 --mutate 演练「改价后各视图是否仍一致」。');
  } else {
    say('\n【③ 变异态对撞：手工改 quoteAmount 后（模拟不一致的脏数据）】');
    const target = orders.find((o: any) => (o.lines ?? []).length > 0 && o.quoteAmount > 0);
    if (!target) {
      say('  ⓘ 无可用靶子订单，跳过');
    } else {
      const OID = target.id;
      const orig = { quoteAmount: target.quoteAmount, totalNet: target.totalNet };
      say(`  靶子 ${target.code ?? OID}`);
      try {
        const newQuote = R(Number(orig.quoteAmount) * 0.85);
        const put = await fetch(`${BASE}/api/v2/orders/${OID}`, {
          method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ quoteAmount: newQuote }),
        });
        if (!put.ok) { say(`  ✗ 变异失败 HTTP ${put.status}`); throw new Error('mutate-failed'); }
        say(`  已把 quoteAmount 改成 ${newQuote}（制造脏数据）`);

        const det = await getJson(`/api/v2/orders/${OID}`);
        const d0 = det.j?.order ?? det.j ?? {};
        const rec = await getJson(`/api/v1/reconciliation/orders/${OID}`);

        // ★ 各视图都按**真源**取值
        const frontPage = orderAmountOf(d0);          // 前端概览页（收编后走真源）
        const reconcile = rec.j?.orderAmount;          // 四单勾稽（B 组，已收编）
        const detailNet = d0.totalNet;                 // 订单详情

        say(`     前端概览页（真源）   = ${R(frontPage)}`);
        say(`     四单勾稽 orderAmount = ${R(reconcile)}`);
        say(`     订单详情 totalNet    = ${R(detailNet)}`);
        say(`     订单详情 quoteAmount = ${R(d0.quoteAmount)}  ← 脏值（已无视图取它）`);

        if (eq(frontPage, reconcile) && eq(frontPage, detailNet)) {
          pass('★ 脏数据下各视图仍一致', `均=${R(frontPage)}（口径收编生效：脏的 quoteAmount 已无视图消费）`);
        } else {
          fail('脏数据下各视图仍一致', `概览=${R(frontPage)} 勾稽=${R(reconcile)} 详情=${R(detailNet)}`);
        }

        // ★ 阳性对照：证明「脏值确实脏」——若 quoteAmount 被消费过就会分裂
        if (!eq(d0.quoteAmount, detailNet)) {
          pass('阳性对照：脏值确实与真源不同', `quoteAmount=${R(d0.quoteAmount)} ≠ 真源=${R(frontPage)}（说明上面的“一致”不是因为没改到）`);
        } else {
          fail('阳性对照：脏值确实与真源不同', '没改成功 ⇒ 上面的“一致”可能是空过');
        }
      } catch (e: any) {
        say(`  ⓘ 对撞中断：${e?.message ?? e}`);
      } finally {
        const rb = await fetch(`${BASE}/api/v2/orders/${OID}`, {
          method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ quoteAmount: orig.quoteAmount }),
        });
        const back = await getJson(`/api/v2/orders/${OID}`);
        const after = back.j?.order ?? back.j ?? {};
        if (eq(after.quoteAmount, orig.quoteAmount)) say(`  ✓ 已回滚 quoteAmount → ${R(after.quoteAmount)}`);
        else say(`  ✗ 回滚失败！当前=${R(after.quoteAmount)} 应为 ${R(orig.quoteAmount)} —— 请手工修复`);
      }
    }
  }

  const bad = results.filter((r) => !r.ok);
  say('\n════════════════════════════════════════════════════════');
  say(` 通过 ${results.length - bad.length} · 失败 ${bad.length}`);
  if (bad.length) say(' 失败项：\n   - ' + bad.map((b) => `${b.n}${b.d ? ' :: ' + b.d : ''}`).join('\n   - '));
  say('════════════════════════════════════════════════════════');
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常：', e); process.exit(2); });
