// ★★ ③ 跨视图同值 · 利润表面（第 5 面）—— 核"利润表自己内部自洽"
//
// 为什么不是"利润表 vs 驾驶舱相等"：实测（2026-09-25）两者**成本来源根本不同** ——
//   驾驶舱成本 = `supplierInvoiceAmount ?? purchasePrice × quantity`（**计划/合同成本**）
//   利润表 `purchaseCost` 只认**实际采购发票/资金流**
//   ⇒ 同一张单：驾驶舱 margin 20150 USD vs 利润表 grossProfit 371686 CNY（毛利率 95.8%），差 2.7 倍。
// ⇒ 两个"毛利"**不是同一口径**，判据不许逼它们相等（那会逼出一个假结论）。
//   本脚本改核**利润表自己内部**的自洽性（同一出口内的恒等，不需要口径拍板）：
//     ① 合计恒等：grossProfit == salesRevenue − (purchaseCost + freightCost + miscCost + bankFeeCost + allowanceCost)
//     ② 折算恒等：每条明细 cnyAmount == amount × rate（用它自己报的 rate）
//     ③ 毛利率自洽：grossMargin ≈ grossProfit / salesRevenue × 100（★ 收入>0 而毛利率=null 也算不符）
//     ④ 明细→列：每组明细的 ΣcnyAmount == 对应落库列（六组；这一条才看得见"列停在默认 0"那一族）
//     ⑤ 标量副本：details.bankFeeCost / details.allowanceCost == 同名列（同一张表里的两套表示）
//     ⑥ 未折算披露：details.unconverted 必须是数组；非空 ⇒ 红（有钱落在六列之外，要人拍口径）
//
// ★ 生成利润表 = **写库** ⇒ 本脚本把"生成 → 核 → 删掉自己生成的那一张"做成闭环，
//   并断言"删后行数与跑前一致"（清理面不宽于自己的写入）。
// ★★ 但"由构造即自洽的那一张"看不见**存量行** —— D7-1c 那一族的形状正是
//   "新代码写对了，旧行停在默认 0"。⇒ 另有只读模式 `--all-rows`：对库里**每一张**跑同一份判据，
//   再对撞接口返回值（相等/遮罩/不符 三分类，遮罩逐字段点名），`--control` 再注入内存污染证明每条臂真有牙。
// 用法：
//   npx tsx scripts/acceptance-derived-profit-sheet.ts [--order=SIM-FORD-001]        # 生成模式（写库，自清）
//   npx tsx scripts/acceptance-derived-profit-sheet.ts --all-rows [--control]        # 只读模式（不写库）
import { createRequire } from 'node:module';
import { demoLoginPassword } from './lib/demoCredential'; // v3.237 补 40：值只住在 env（缺了就红），源码里不留字面量
import { SERVER_DIR, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';

loadEnvForScript();
const req = createRequire(SERVER_DIR + '/');
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

const BASE = process.env.BAMBOOK_API ?? 'http://127.0.0.1:8081';
const ORDER = (process.argv.find((a) => a.startsWith('--order='))?.slice(8)) || 'SIM-FORD-001';
const ALL_ROWS = process.argv.includes('--all-rows');
const CONTROL = process.argv.includes('--control');
const R = (x: unknown) => (x == null ? null : Math.round(Number(x) * 10000) / 10000);
// ★ 容差必须**绝对**：第一版写成相对容差（`1e-3 × 基`），在 387887 这种量级上等于 388 块钱，
//   阳性对照（明细 +1）当场抓出"看不见" ⇒ 一把看不见 1 块钱的尺等于没有。
//   金额一律 4 位小数 ⇒ 绝对 1e-3 既够宽（容得下 round4）又能看见 1 块钱。
const near = (a: unknown, b: unknown, tol = 1e-3) =>
  a == null || b == null ? false : Math.abs(Number(a) - Number(b)) <= tol;

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

/**
 * 明细组 → 落库列 的映射（★ 全文件只这一份：存量行模式与生成模式共用）
 * 为什么要写死这六对：D7-1c 之前的缺陷正是"两个成本维度有明细行、列却停在默认 0"
 * —— 同一张表里 `分项之和 ≠ 毛利`，而当时的三条恒等**看不见**（它只比明细自己的乘法）。
 */
const DETAIL_TO_COLUMN: ReadonlyArray<readonly [string, string]> = [
  ['sales', 'salesRevenue'],
  ['purchases', 'purchaseCost'],
  ['freight', 'freightCost'],
  ['misc', 'miscCost'],
  ['bankFees', 'bankFeeCost'],
  ['allowances', 'allowanceCost'],
];
/** `details` 里与落库列**重复表示**的两个标量（生成时出自同一个 sum ⇒ 不等就是漂了） */
const SCALAR_MIRRORS: readonly string[] = ['bankFeeCost', 'allowanceCost'];

/**
 * 纯函数版的利润表自洽判据（可注入污染当阳性对照）。返回不符清单。
 *
 * ★ 这一版相对 HEAD 的改动：**明细字段缺失不再 `continue`**。
 *   HEAD 的写法是 `if (amount==null||rate==null||cnyAmount==null) continue;` ——
 *   实测（2026-09-27，把某条明细的 `cnyAmount` 删掉喂给**提交态那份**判据）报 **0 处不符**
 *   ⇒ 一条"算不出折算"的明细会被当成没这回事，而它照样可能已被 Σ 进列。
 *   现在：缺字段 = 一条点名不符（比不了不等于对）。
 */
function checkSheet(item: any) {
  const bad: string[] = [];
  const costSum = ['purchaseCost', 'freightCost', 'miscCost', 'bankFeeCost', 'allowanceCost']
    .reduce((s, k) => s + (Number(item[k]) || 0), 0);
  if (!near(item.grossProfit, Number(item.salesRevenue) - costSum, 1e-4)) {
    bad.push(`合计恒等: grossProfit=${item.grossProfit} ≠ salesRevenue(${item.salesRevenue}) − Σ成本(${R(costSum)})`);
  }
  // ② 明细 → 列（六组逐组点名，缺组=空数组也要比）
  for (const [key, col] of DETAIL_TO_COLUMN) {
    const lines = Array.isArray(item?.details?.[key]) ? item.details[key] : [];
    const missing = lines.filter((l: any) => l?.cnyAmount == null).length;
    const sum = R(lines.reduce((s: number, l: any) => s + (Number(l?.cnyAmount) || 0), 0));
    if (!near(sum, Number(item[col]), 1e-4)) {
      bad.push(`明细→列 ${key}→${col}: Σ明细=${sum} ≠ 列=${item[col]}（${lines.length} 条，其中 ${missing} 条缺 cnyAmount）`);
    }
  }
  // ③ 折算恒等（逐条；缺字段是**不符**而不是跳过）
  for (const [key] of DETAIL_TO_COLUMN) {
    for (const line of Array.isArray(item?.details?.[key]) ? item.details[key] : []) {
      const miss = ['amount', 'rate', 'cnyAmount'].filter((f) => line?.[f] == null);
      if (miss.length) {
        bad.push(`${key} ${line?.id}: 缺字段 ${miss.join('/')} ⇒ 折算恒等比不了（**不许当"没有这回事"**）`);
        continue;
      }
      if (!near(line.cnyAmount, Number(line.amount) * Number(line.rate), 1e-3)) {
        bad.push(`${key} ${line.id}: cnyAmount=${line.cnyAmount} ≠ amount(${line.amount}) × rate(${line.rate})`);
      }
    }
  }
  // ④ 标量副本 vs 列
  for (const k of SCALAR_MIRRORS) {
    if (item?.details?.[k] === undefined) {
      bad.push(`details.${k} 缺失 ⇒ 无法与落库列(${item?.[k]})对撞（两套表示少了一套）`);
      continue;
    }
    if (!near(item.details[k], Number(item[k]), 1e-4)) {
      bad.push(`标量副本 details.${k}=${item.details[k]} ≠ 列 ${k}=${item[k]}`);
    }
  }
  // ⑤ 毛利率自洽（★ 补 HEAD 的另一半：收入>0 而毛利率是 null，HEAD 那版不报）
  if (Number(item.salesRevenue) > 0) {
    if (item.grossMargin == null) bad.push(`毛利率缺失: salesRevenue=${item.salesRevenue}>0 而 grossMargin=null`);
    else {
      const pct = (Number(item.grossProfit) / Number(item.salesRevenue)) * 100;
      if (!near(item.grossMargin, pct, 1e-2)) bad.push(`毛利率自洽: grossMargin=${item.grossMargin} ≠ grossProfit/salesRevenue×100=${R(pct)}`);
    }
  } else if (item.grossMargin != null) {
    bad.push(`毛利率非 null 却无收入: salesRevenue=${item.salesRevenue} grossMargin=${item.grossMargin}`);
  }
  // ⑥ 外币未折算披露：字段本身缺失也要喊（否则"有没有钱被丢在合计外"无从判断）
  if (!Array.isArray(item?.details?.unconverted)) {
    bad.push('details.unconverted 缺失或不是数组 ⇒ 无法判断有无外币行落在合计外');
  }
  return bad;
}


/** 分母 census：把"比了多少"摊开，供"已比 + 点名未比 === 枚举"的自检用 */
function census(item: any) {
  let lines = 0;
  let unconverted = 0;
  for (const [key] of DETAIL_TO_COLUMN) lines += Array.isArray(item?.details?.[key]) ? item.details[key].length : 0;
  if (Array.isArray(item?.details?.unconverted)) unconverted = item.details.unconverted.length;
  return { groups: DETAIL_TO_COLUMN.length, lines, unconverted, mirrors: SCALAR_MIRRORS.length };
}

/** ══════════ `--all-rows`：只读模式 —— 对**库里存量行**逐行逐格对撞（不生成、不写库、不清理） ══════════ */

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** 接口标量 ↔ 库存标量 三分类：相等 / 被遮罩 / 不符（★ 遮罩必须点名，不许静默当"对上了"） */
function clsScalar(dbv: unknown, apiv: unknown): 'equal' | 'masked' | 'diff' {
  const a = num(dbv);
  const b = num(apiv);
  if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) {
    return Math.abs(a - b) <= 1e-4 ? 'equal' : 'diff';
  }
  if (apiv === null && dbv != null && dbv !== undefined) return 'masked';
  if ((dbv === null || dbv === undefined) && (apiv === null || apiv === undefined)) return 'equal';
  return String(dbv) === String(apiv) ? 'equal' : 'diff';
}

/** 接口明细组 ↔ 库存明细组：长度先对，再逐条对 cnyAmount（组被整组清空=遮罩，仍要点名） */
function clsArray(dbArr: unknown, apiArr: unknown) {
  const d = Array.isArray(dbArr) ? dbArr.length : null;
  const a = Array.isArray(apiArr) ? apiArr.length : null;
  if (d === null || a === null) return { kind: 'diff' as const, n: 0, why: '有一侧不是数组' };
  if (d === a) {
    let bad = 0;
    for (let i = 0; i < d; i += 1) {
      const x = num(dbArr![i]?.cnyAmount);
      const y = num(apiArr[i]?.cnyAmount);
      if (x === null && y === null) continue;
      if (x === null || y === null || Math.abs(x - y) > 1e-4) bad += 1;
    }
    return bad ? { kind: 'diff' as const, n: bad, why: `${bad} 条 cnyAmount 不等` } : { kind: 'equal' as const, n: d, why: '' };
  }
  if (a === 0 && d > 0) return { kind: 'masked' as const, n: d, why: '整组被清空（保形遮罩）' };
  return { kind: 'diff' as const, n: 0, why: `条数 ${d} vs ${a}` };
}

/** 接口 ↔ 库 对撞：返回三分类清单（名字与数绑在一起，反解会撒谎） */
function collideApiRow(dbRow: any, api: any) {
  const equal: string[] = [];
  const masked: string[] = [];
  const diff: string[] = [];
  for (const f of ['baseCurrency', 'salesRevenue', 'purchaseCost', 'freightCost', 'miscCost', 'bankFeeCost', 'allowanceCost', 'grossProfit', 'grossMargin']) {
    const k = clsScalar(dbRow[f], api?.[f]);
    (k === 'equal' ? equal : k === 'masked' ? masked : diff).push(`${f}${k === 'diff' ? `(${dbRow[f]} vs ${api?.[f]})` : ''}`);
  }
  for (const [key] of DETAIL_TO_COLUMN) {
    const r = clsArray(dbRow.details?.[key], api?.details?.[key]);
    const tag = `details.${key}`;
    if (r.kind === 'equal') equal.push(`${tag}[${r.n}]`);
    else if (r.kind === 'masked') masked.push(`${tag}(${r.why})`);
    else diff.push(`${tag}(${r.why})`);
  }
  for (const k of SCALAR_MIRRORS) {
    const r = clsScalar(dbRow.details?.[k], api?.details?.[k]);
    const tag = `details.${k}`;
    if (r === 'equal') equal.push(tag);
    else if (r === 'masked') masked.push(tag);
    else diff.push(`${tag}(${dbRow.details?.[k]} vs ${api?.details?.[k]})`);
  }
  const u = clsArray(dbRow.details?.unconverted, api?.details?.unconverted);
  if (u.kind === 'equal') equal.push(`details.unconverted[${u.n}]`);
  else if (u.kind === 'masked') masked.push('details.unconverted(成本类金额被置 null)');
  else diff.push(`details.unconverted(${u.why})`);
  return { equal, masked, diff };
}

function finish(mode: string) {
  const failed = results.filter((r) => !r.ok);
  say('\n════════════════════════════════════════════════════════');
  say(` 通过 ${results.length - failed.length} · 失败 ${failed.length}`);
  say(` (${mode})`);
  say('════════════════════════════════════════════════════════');
  process.exit(failed.length === 0 ? 0 : 1);
}

/**
 * 只读全量模式的存在理由：`--order` 那一支核的是**刚生成的那一张**（由构造即自洽），
 * 库里**存量**行却没人碰过 —— 而 D7-1c 修的正 is"新代码写对了、旧行留在默认 0"这一族。
 * 本模式对每一行跑同一份判据，再对撞接口返回值，最后用内存污染证明每条臂真有牙。
 */
async function runAllRows(control: boolean) {
  say('════════════════════════════════════════════════════════');
  say(` 利润表存量行逐格对撞（只读，不生成不写库）· 端点 ${BASE}`);
  say('════════════════════════════════════════════════════════');

  const rows = await prisma.orderProfitSheet.findMany({ orderBy: { orderId: 'asc' } });
  say(`\n【分母】OrderProfitSheet 存量 ${rows.length} 行：${rows.map((r) => r.orderId).join(', ') || '（空）'}`);
  if (rows.length === 0) {
    fail('分母', '库里 0 张利润表 ⇒ 本模式跑不出任何证据（"没数据"不许读成"通过"）');
    await prisma.$disconnect();
    return finish('all-rows');
  }

  // ── 臂 1：逐行判据（六组明细→列 + 逐条折算 + 标量副本 + 毛利率 + unconverted 形状）
  const badRows: string[] = [];
  let lines = 0;
  let groups = 0;
  let mirrors = 0;
  let unconvTotal = 0;
  for (const s of rows) {
    const c = census(s);
    lines += c.lines;
    groups += c.groups;
    mirrors += c.mirrors;
    unconvTotal += c.unconverted;
    const bad = checkSheet(s);
    if (bad.length) badRows.push(`${s.orderId}: ${bad.slice(0, 3).join(' ;; ')}${bad.length > 3 ? ` ;; +${bad.length - 3}` : ''}`);
  }
  if (badRows.length === 0) pass(`存量行逐格自洽（${rows.length} 行 · 明细→列 ${groups} 组 · 折算恒等 ${lines} 条 · 标量副本 ${mirrors} 处）`, '合计恒等 + 毛利率 + unconverted 形状全部对上');
  else fail('存量行逐格自洽', `${badRows.length} 行不符：${badRows.slice(0, 3).join(' | ').slice(0, 400)}`);

  // ── 臂 2：分母自检（已点名 === 枚举；漏一行就等于"这行没人看过"）
  const named = rows.length;
  if (named === rows.length && groups === DETAIL_TO_COLUMN.length * rows.length && mirrors === SCALAR_MIRRORS.length * rows.length) {
    pass('分母自检', `行 ${named}/${rows.length} · 组 ${groups}/${DETAIL_TO_COLUMN.length * rows.length} · 副本 ${mirrors}/${SCALAR_MIRRORS.length * rows.length}`);
  } else fail('分母自检', `行 ${named} vs ${rows.length} · 组 ${groups} · 副本 ${mirrors}`);

  // ── 臂 3：外币未折算（钱落在所有列之外 ⇒ 有就必须红，由人拍"披露够不够"）
  if (unconvTotal === 0) pass('未折算外币行 = 0', '没有任何金额被留在六列之外');
  else {
    const detail = rows.flatMap((s) => (Array.isArray(s.details?.unconverted) ? s.details.unconverted : [])
      .map((u: any) => `${s.orderId}/${u.kind}/${u.id}:${u.amount} ${u.currency}(${u.reason})`));
    fail('未折算外币行', `${unconvTotal} 条落在所有列之外 ⇒ 需拍：披露够不够：${detail.slice(0, 4).join(' | ').slice(0, 300)}`);
  }

  // ── 臂 4：接口 ↔ 库（存量行是"落的那一份"，接口是"用户看的那一份"）
  const token = await login();
  if (!token) fail('接口↔库', '登录失败：三个演示账号均不可用 ⇒ 这一臂跑不起来（不算通过）');
  else {
    const H = { Authorization: `Bearer ${token}` };
    let eq = 0;
    let mk = 0;
    const diffs: string[] = [];
    const maskedNames: string[] = [];
    for (const s of rows) {
      const res = await fetch(`${BASE}/api/v1/pricing/profit-sheets/order/${encodeURIComponent(s.orderId)}`, { headers: H });
      const j: any = await res.json().catch(() => ({}));
      const api = j?.item;
      if (!res.ok || !api) { diffs.push(`${s.orderId}:HTTP ${res.status}`); continue; }
      const k = collideApiRow(s, api);
      eq += k.equal.length;
      mk += k.masked.length;
      maskedNames.push(...k.masked);
      diffs.push(...k.diff.map((d) => `${s.orderId}/${d}`));
    }
    const perRow = 9 + DETAIL_TO_COLUMN.length + SCALAR_MIRRORS.length + 1;
    if (diffs.length === 0 && eq + mk === perRow * rows.length) {
      pass('接口↔库逐字段对撞', `相等 ${eq} · 遮罩 ${mk}${mk ? `（点名：${maskedNames.slice(0, 6).join(', ')}）` : ''} · 合计 ${eq + mk}/${perRow * rows.length}`);
    } else if (diffs.length === 0) {
      fail('接口↔库逐字段对撞', `无不符，但分类合计 ${eq + mk} ≠ 枚举 ${perRow * rows.length} ⇒ 有字段没被分类`);
    } else fail('接口↔库逐字段对撞', `${diffs.length} 处不符：${diffs.slice(0, 5).join(' | ').slice(0, 320)}`);
  }

  // ── 阳性对照：每刀只打一条臂，且要求**点名到那一条**（两端一起红不算对上）
  if (control) {
    say('\n【阳性对照】（纯内存污染，不写库）');
    const clone = (x: any) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
    const base = rows.find((r) => Array.isArray(r.details?.sales) && r.details.sales.length
      && Array.isArray(r.details.purchases) && r.details.purchases.length) ?? rows[0];
    if (!base) fail('阳性对照前提', '找不到同时有 sales 与 purchases 明细的行 ⇒ 对照跑不起来（该格的"通过"不算数）');
    else {
      const red = (label: string, needle: string, mut: (b: any) => void) => {
        const b = clone(base);
        mut(b);
        const bad = checkSheet(b);
        const hit = bad.filter((x) => x.includes(needle));
        if (hit.length) pass(`阳性对照 ${label}`, `报出 ${bad.length} 处，其中点名 "${needle}" 的 ${hit.length} 处`);
        else fail(`阳性对照 ${label}`, `注入后没点名叫 "${needle}"（实际：${bad.slice(0, 2).join(' ;; ').slice(0, 200) || '全绿 ⇒ 这条臂瞎'}`);
      };
      red('明细→列 漂（成本列 +1 而明细不动）', '明细→列 purchases→purchaseCost', (b) => { b.purchaseCost = R(Number(b.purchaseCost) + 1); });
      red('合计恒等 漂（毛利 +1）', '合计恒等', (b) => { b.grossProfit = R(Number(b.grossProfit) + 1); });
      red('折算恒等 漂（明细 cnyAmount +1）', 'cnyAmount=', (b) => { b.details.sales[0].cnyAmount = R(Number(b.details.sales[0].cnyAmount) + 1); });
      red('★ 缺字段（HEAD 那版静默跳过＝实测 0 处）', '缺字段 cnyAmount', (b) => { delete b.details.sales[0].cnyAmount; });
      red('★ 毛利率 null（HEAD 那版不报＝实测 0 处）', '毛利率缺失', (b) => { b.grossMargin = null; });
      red('★ 标量副本漂（HEAD 那版不报＝实测 0 处）', '标量副本 details.bankFeeCost', (b) => { b.details.bankFeeCost = R(Number(b.details.bankFeeCost) + 1); });
      red('★ unconverted 形状缺失（HEAD 那版不报＝实测 0 处）', 'details.unconverted 缺失', (b) => { delete b.details.unconverted; });
      // 接口↔库那条臂自己的对照：改接口返回值一个字段 ⇒ collideApiRow 必须点名该字段
      const api = clone(base);
      api.salesRevenue = R(Number(api.salesRevenue) + 1);
      const k = collideApiRow(base, api);
      if (k.diff.some((d) => d.startsWith('salesRevenue'))) pass('阳性对照 接口↔库（改 salesRevenue）', `diff=${k.diff.length} · masked=${k.masked.length} · equal=${k.equal.length}`);
      else fail('阳性对照 接口↔库（改 salesRevenue）', `没点名 salesRevenue（diff：${k.diff.slice(0, 3).join(', ')}）`);
      // 反向对照：接口整体被遮罩时不许读成"不符"，也不许读成"全等"
      const maskedApi = clone(base);
      for (const f of ['purchaseCost', 'freightCost', 'miscCost', 'grossProfit', 'grossMargin']) maskedApi[f] = null;
      for (const g of ['purchases', 'freight', 'misc', 'bankFees', 'allowances']) if (Array.isArray(maskedApi.details?.[g])) maskedApi.details[g] = [];
      maskedApi.details.bankFeeCost = null;
      maskedApi.details.allowanceCost = null;
      const k2 = collideApiRow(base, maskedApi);
      if (k2.diff.length === 0 && k2.masked.length > 0) pass('阳性对照·反向（整字段遮罩⇒判遮罩不判不符）', `masked=${k2.masked.length} · diff=0`);
      else fail('阳性对照·反向（整字段遮罩⇒判遮罩不判不符）', `diff=${k2.diff.length}（${k2.diff.slice(0, 4).join(', ')}）masked=${k2.masked.length}`);
    }
  }

  await prisma.$disconnect();
  return finish(control ? 'all-rows + 阳性对照' : 'all-rows');
}


async function main() {
  // ★ 两个参数不许"看着传了其实没生效"：生成模式没有对照注入，也不该被 --all-rows 的参数静默吞掉
  if (CONTROL && !ALL_ROWS) {
    say('✗ `--control` 只对只读模式有意义 ⇒ 请写 `--all-rows --control`（单用会跑成生成模式，那支不注入污染）');
    process.exit(1);
  }
  if (ALL_ROWS && process.argv.some((a) => a.startsWith('--order='))) {
    say('✗ `--all-rows` 跑的是库里**全部**存量行，`--order` 会被忽略 ⇒ 二选一（要单张就用生成模式）');
    process.exit(1);
  }
  if (ALL_ROWS) { await runAllRows(CONTROL); return; }
  const token = await login();
  if (!token) { say('✗ 登录失败：三个演示账号均不可用，中止'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}` };
  say('════════════════════════════════════════════════════════');
  say(' 跨视图同值 · 利润表面（核"自己内部自洽"）');
  say(` 端点 ${BASE} · 订单 ${ORDER}`);
  say('════════════════════════════════════════════════════════');

  const before = await prisma.orderProfitSheet.count();
  say(`\n【跑前】OrderProfitSheet 全表 ${before} 行`);

  let genId: string | null = null;
  try {
    const gen = await fetch(`${BASE}/api/v1/pricing/profit-sheets/generate/${encodeURIComponent(ORDER)}`, { method: 'POST', headers: H });
    const gj: any = await gen.json().catch(() => ({}));
    genId = gj?.item?.id ?? null;
    if (!gen.ok || !genId) { fail('生成利润表', `HTTP ${gen.status}`); }
    else {
      pass('生成利润表', `id=${genId}`);
      const get = await fetch(`${BASE}/api/v1/pricing/profit-sheets/order/${encodeURIComponent(ORDER)}`, { headers: H });
      const item: any = (await get.json().catch(() => ({})))?.item;
      if (!item) fail('取回利润表', `HTTP ${get.status}`);
      else {
        say(`  baseCurrency=${item.baseCurrency} salesRevenue=${item.salesRevenue} purchaseCost=${item.purchaseCost} grossProfit=${item.grossProfit} grossMargin=${item.grossMargin}`);
        const bad = checkSheet(item);
        if (bad.length === 0) pass('利润表内部三条恒等', '合计恒等 · 折算恒等 · 毛利率自洽');
        else fail('利润表内部三条恒等', `${bad.length} 处不符：${bad.slice(0, 4).join(' · ')}`);

        // ★ 阳性对照（纯内存）：把某条明细的 cnyAmount 改坏 ⇒ 折算恒等必须报
        const poisoned = JSON.parse(JSON.stringify(item));
        const fk = ['sales', 'freight', 'misc', 'purchases', 'purchase'].find((k) => (poisoned?.details?.[k] ?? []).length);
        if (fk) {
          poisoned.details[fk][0].cnyAmount = R(Number(poisoned.details[fk][0].cnyAmount) + 1);
          const b2 = checkSheet(poisoned);
          if (b2.length > 0) pass('阳性对照（明细 cnyAmount +1 ⇒ 必须红）', `报出 ${b2.length} 处 —— 这条尺有牙`);
          else fail('阳性对照（明细 cnyAmount +1 ⇒ 必须红）', '改坏了却仍全绿 ⇒ **这条尺瞎了**');
        } else fail('阳性对照', '这条利润表没有任何可比的明细行 ⇒ 对照跑不起来（该格的"通过"不算数）');
      }
    }
  } finally {
    if (genId) {
      // ★ 按**主键**删掉自己刚生成的那一行 —— 为什么不用 `deleteMany`：
      //   ① 语义更准（我造的只有这一行，`id` 是主键）；② `deleteMany` 是本仓"删除面"那把尺的计数单位
      //   （`drill-actor-refs.test.ts`：凡手写 `deleteMany` 的文件必须逐个冻结、总数只许降）——
      //   这里本来就不该往那本账上添一条（那等于声称我多了一个"批量删除面"）。
      let removed = 0;
      try { await prisma.orderProfitSheet.delete({ where: { id: genId } }); removed = 1; }
      catch (e: any) { say(`\n【清理】按主键删除失败（未清掉自己那一行）：${e?.message ?? e}`); }
      const after = await prisma.orderProfitSheet.count();
      say(`\n【清理】删除自己生成的那一张 = ${removed} 行；跑后全表 ${after} 行`);
      if (after === before) pass('清理面不宽于自己的写入', `${before} → ${after}`);
      else fail('清理面不宽于自己的写入', `${before} → ${after}（不等 ⇒ 有别的写入或被误删）`);
    }
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  say('\n════════════════════════════════════════════════════════');
  say(` 通过 ${results.length - failed.length} · 失败 ${failed.length}`);
  say(' ⚠️ 本脚本**不判**"利润表 vs 驾驶舱相等"（两者成本来源不同，实测差 2.7 倍；口径待拍）');
  say('════════════════════════════════════════════════════════');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`✗ 异常：${e?.message || e}`); process.exit(1); });
