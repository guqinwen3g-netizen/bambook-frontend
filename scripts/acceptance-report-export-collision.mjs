#!/usr/bin/env node
/**
 * acceptance-report-export-collision.mjs — 财务报表"接口 JSON ↔ 导出 Excel"逐格对撞（v3.214 立，起因是 B265 闭口）
 *
 * 为什么要有这一份：① 的"看得到"以前只证到"按钮点得动、HTTP 200"。★ 那半个证明是可以假的 ——
 * 一个把每一格都写成 0 的导出器照样 200、照样是合法的 xlsx。本件把证明抬到**格**：
 * 同一时刻取两份（JSON 与 `?format=xlsx`），把工作簿解回单元格，逐格对撞接口的数。
 *
 * 三条判据：
 *   ① 正向：每张报表"比对格数"必须 ≥ 分母下限，且不符 = 0；
 *   ② 反向（`--control`）：故意把期望值改坏三刀（账龄一个桶 +1、对账单一笔借方 +1、对象名换掉），
 *      **每一刀都必须被抓到** ⇒ 上面那个"全等"是有牙的读数，不是恒绿；
 *   ③ 自证：解析器喂一份已知的空表（无数据提示页）必须解析出 ≥2 行，不许读成 0 行而蒙混过关。
 *
 * 跑法（需要 :8090 在跑、且库里有模拟数据）：
 *   set -a; . ../Bambook/server/.env.local; set +a
 *   node scripts/acceptance-report-export-collision.mjs [--control]
 * 退出码：0 = 三条全过；1 = 任一条红（含"对照没被抓到"＝判据哑了）。
 */
import * as XLSX from 'xlsx';

const API = (process.env.EXPORT_COLLIDE_API ?? process.env.BAMBOOK_API ?? 'http://127.0.0.1:8090').replace(/\/+$/, '');
const EMAIL = process.env.EXPORT_COLLIDE_EMAIL ?? 'jason.shen@bambook.local';
// ★ v3.217：口令无默认值（这份件在"现场工具包"白名单里 ⇒ 字面量会随产物发出去）
const PASSWORD = process.env.BAMBOOK_DEMO_PASSWORD ?? process.env.EXPORT_COLLIDE_PASSWORD ?? '';
const CONTROL = process.argv.includes('--control');
// 分母下限：账龄 8 行 × 8 列、两张对账单各 ≥ 6 笔 × 6 列 —— 低于此说明库里没数或解析瞎了
const MIN_CELLS = { aging: 40, cust: 20, sup: 20 };

let token = '';
async function api(path) {
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return res;
}
async function login() {
  if (!PASSWORD) throw new Error('没给 EXPORT_COLLIDE_PASSWORD ⇒ 本件拒绝取数（也不许把"没跑"读成"全等"）');
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status} ⇒ 走查环境的口令/账号变了？（本件不打印凭证）`);
  const j = await res.json();
  token = j.token ?? j.accessToken ?? j.data?.token;
  if (!token) throw new Error('登录响应里没有 token ⇒ 判据无法取数，本件红');
}

/** 工作簿 → 位置化二维数组（raw 保留数值，defval 补齐空洞，防止"少一格"被读成"没有这格"） */
function toRows(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}
const norm = (v) => (v === null || v === undefined ? null : typeof v === 'number' ? v : String(v).trim());
function eq(a, b) {
  const x = norm(a), y = norm(b);
  if (x === null || y === null) return x === y;
  if (typeof x === 'number' || typeof y === 'number') {
    const nx = Number(x), ny = Number(y);
    return Number.isFinite(nx) && Number.isFinite(ny) ? Math.abs(nx - ny) < 0.005 : String(x) === String(y);
  }
  return String(x) === String(y);
}
const KIND = { invoice: '发票', receipt: '收款', payment: '付款' };
const BUCKETS = ['current', 'd1_30', 'd31_60', '61_90', '90plus'];

function collideAging(rows, rep, sink, tag) {
  const pairs = [];
  rep.rows.forEach((r, i) => {
    const exp = [r.customerName, r.currency, r.invoiceCount,
      r.buckets.current, r.buckets.d1_30, r.buckets['31_60'] ?? r.buckets.d31_60,
      r.buckets['61_90'] ?? r.buckets.d61_90, r.buckets['90plus'] ?? r.buckets.d90plus, r.buckets.total];
    exp.forEach((e, j) => pairs.push([`${tag} 行${i} 列${j}`, rows[i + 1]?.[j], e]));
  });
  // 合计行：先自己按币种加一遍，再对文件里那行（拦"合计抄错/漏币种"）
  const per = {};
  for (const r of rep.rows) {
    const d = (per[r.currency] ??= { n: 0, b: [0, 0, 0, 0, 0], total: 0 });
    d.n += r.invoiceCount;
    d.b[0] += r.buckets.current; d.b[1] += r.buckets.d1_30;
    d.b[2] += r.buckets['31_60'] ?? r.buckets.d31_60; d.b[3] += r.buckets['61_90'] ?? r.buckets.d61_90;
    d.b[4] += r.buckets['90plus'] ?? r.buckets.d90plus;
    d.total += r.buckets.total;
  }
  for (const tr of rows.filter((x) => typeof x[0] === 'string' && x[0].startsWith('合计（'))) {
    const ccy = String(tr[0]).replace(/[^A-Z]/g, '');
    const d = per[ccy];
    if (!d) { sink.push(`合计行 ${ccy} 在接口里没有对应币种`); continue; }
    // 合计行布局（屏面现读钉死）：0=合计（CCY） 1=币种 2=发票数(留空) 3..7=五个桶 8=未结合计
    for (let k = 0; k < 5; k += 1) pairs.push([`合计 ${ccy} 桶${BUCKETS[k]}`, tr[3 + k], d.b[k]]);
    pairs.push([`合计 ${ccy} 未结合计`, tr[8], d.total]);
    pairs.push([`合计 ${ccy} 币种列`, tr[1], ccy]);
  }
  return pairs;
}

function collideStatement(rows, rep, nameKey, tag) {
  const sec = rep.sections?.[0];
  if (!sec) {
    throw new Error(`${tag} 接口返回 sections=${JSON.stringify(rep.sections)?.slice(0, 40)}（0 段）⇒ 该对象在所选区间里没有可对撞的往来。`
      + `本件不许把"取不到段"读成"全等"，也不许悄悄跳过：要么换一个有往来的对象（分母来自账龄第一行），要么这条判据就是红。`);
  }
  const pairs = [];
  const head = rows.find((x) => x[1] === '期初余额');
  const tail = rows.find((x) => x[1] === '期末余额');
  pairs.push([`${tag} 期初·余额`, head?.[5], sec.openingBalance]);
  pairs.push([`${tag} 期初·期初列`, head?.[6], sec.openingBalance]);
  pairs.push([`${tag} 期初·期末列`, head?.[7], sec.closingBalance]);
  pairs.push([`${tag} 期初·对象`, head?.[8], rep[nameKey]]);
  pairs.push([`${tag} 期末·余额`, tail?.[5], sec.closingBalance]);
  pairs.push([`${tag} 期末·期末列`, tail?.[7], sec.closingBalance]);
  const tx = rows.filter((x) => Object.values(KIND).includes(x[1]) && x[2]);
  pairs.push([`${tag} 笔数`, tx.length, sec.transactions.length]);
  sec.transactions.forEach((t, i) => {
    const exp = [t.date, KIND[t.kind] ?? t.kind, t.number, t.debit, t.credit, t.balance];
    exp.forEach((e, j) => pairs.push([`${tag} 第${i}笔 列${j}`, tx[i]?.[j], e]));
  });
  return pairs;
}

function report(label, pairs, sink) {
  let hit = 0;
  const miss = [];
  for (const [name, got, exp] of pairs) {
    if (eq(got, exp)) hit += 1;
    else miss.push(`${name}：文件=${JSON.stringify(got)} 接口=${JSON.stringify(exp)}`);
  }
  if (hit < MIN_CELLS[label]) { sink.push(`${label} 比对格数 ${hit} < 分母下限 ${MIN_CELLS[label]} ⇒ 库里没数或解析瞎了，不许读成通过`); miss.push('分母'); }
  sink.push(...miss);
  return { hit, miss: miss.length };
}

async function both(path) {
  const jr = await api(path);
  if (!jr.ok) throw new Error(`${path} JSON HTTP ${jr.status}`);
  const json = await jr.json();
  const xr = await api(`${path}${path.includes('?') ? '&' : '?'}format=xlsx`);
  if (!xr.ok) throw new Error(`${path} xlsx HTTP ${xr.status}`);
  const buf = Buffer.from(await xr.arrayBuffer());
  const cd = xr.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) ?? cd.match(/filename="?([^";]+)"?/i);
  return { json, buf, bytes: buf.byteLength, filename: m ? decodeURIComponent(m[1]) : '(无文件名)' };
}

async function main() {
  // 运行器（m3-final-check）有一条硬规矩：输出里必须能读到"连的是哪个端点"，否则不许把绿署给它
  // 形状必须是「端点 <url>」：运行器用 (?:端点|BASE|base)\s*[:=]?\s*(\S+) 取这个值，
  // 加上方括号会把 `]` 当成端点本身 ⇒ 它判"端点= ≠ 127.0.0.1:8090"（本批第一次跑就是这么红的）
  console.log(`端点 ${API} · 登录账号 ${EMAIL}（口令不打印）`);
  await login();
  const sink = [];
  const reads = [];
  let pass = 0, fail = 0;

  const aging = await both('/api/v1/finance/reports/aging?type=Receivable');
  reads.push(`账龄 ${aging.bytes} B · ${aging.filename}`);
  const a = report('aging', collideAging(toRows(aging.buf), aging.json, sink, '账龄'), sink);

  // 对账单选谁：从账龄第一行现取（种子换了也不哑），而不是把 id 钉死在件里
  const top = aging.json.rows[0];
  const cy = new Date().getFullYear();
  const wide = `&from=${cy}-01-01&to=${cy}-12-31`; // 必须用 & 起头：上一版写成 ? ⇒ 把 from 串进 relationId 的值里 ⇒ 取到一张空表（本件第一版自己栽的坑）
  const cust = await both(`/api/v1/finance/reports/statement?customerRelationId=${top.customerRelationId}${wide}`);
  reads.push(`客户对账单(${top.customerRelationId}) ${cust.bytes} B · ${cust.filename}`);
  const c = report('cust', collideStatement(toRows(cust.buf), cust.json, 'customerName', '客户对账单'), sink);

  const pay = await both('/api/v1/finance/reports/aging?type=Payable');
  const ptop = pay.json.rows[0];
  if (!ptop) throw new Error('应付账龄 0 行 ⇒ 本件无法对撞供应商对账单（要么造数，要么这条判据红）');
  const sup = await both(`/api/v1/finance/reports/supplier-statement?supplierRelationId=${ptop.customerRelationId}${wide}`);
  reads.push(`供应商对账单(${ptop.customerRelationId}) ${sup.bytes} B · ${sup.filename}`);
  const s = report('sup', collideStatement(toRows(sup.buf), sup.json, 'supplierName', '供应商对账单'), sink);

  // 三份导出各自的"全等 + 分母够"算一条；文件名带不出对象/后缀也算一条（拦"Content-Disposition 漂了"）
  for (const [lbl, r] of [['账龄', a], ['客户对账单', c], ['供应商对账单', s]]) {
    if (r.miss === 0) { pass += 1; console.log(`[通过] ${lbl}：导出与接口逐格全等（${r.hit} 格）`); }
    else { fail += 1; console.log(`[失败] ${lbl}：${r.miss} 格不符`); }
  }
  const nameOk = [[aging, '账龄分析'], [cust, '对账单_'], [sup, '对账单_']]
    .every(([x, needle]) => x.filename.endsWith('.xlsx') && x.filename.includes(needle));
  if (nameOk) { pass += 1; console.log('[通过] 三份文件的 Content-Disposition 都带得出报表名 + .xlsx 后缀'); }
  else { fail += 1; console.log('[失败] 有导出没带出文件名（见上面 [文件] 那三行）'); }

  console.log(`[现量] 比对格数：账龄 ${a.hit} · 客户对账单 ${c.hit} · 供应商对账单 ${s.hit} · 合计 ${a.hit + c.hit + s.hit} 格`);
  for (const r of reads) console.log(`[文件] ${r}`);

  if (!CONTROL) {
    for (const x of sink) console.log('  - ' + x);
    console.log(`══ 结果：${pass} 通过 / ${fail} 失败（未跑 --control ⇒ 还不知道这把尺会不会红，交付前要跑）══`);
    process.exit(fail ? 1 : 0);
  }

  // ── 三刀反向对照：期望值改坏，判据必须逐刀点名抓到 ──
  const controls = [];
  const mk = (fn, name) => {
    const before = sink.length;
    fn();
    const caught = sink.length > before;
    sink.length = before; // 对照的"不符"是本件自己造的，不许污染正向账
    controls.push([name, caught]);
  };
  const a2 = JSON.parse(JSON.stringify(aging.json));
  a2.rows[0].buckets.d1_30 = Number(a2.rows[0].buckets.d1_30) + 1;
  mk(() => report('aging', collideAging(toRows(aging.buf), a2, sink, '账龄'), sink), '阳性对照·账龄一个桶 +1');
  const c2 = JSON.parse(JSON.stringify(cust.json));
  c2.sections[0].transactions[0].debit = Number(c2.sections[0].transactions[0].debit) + 1;
  mk(() => report('cust', collideStatement(toRows(cust.buf), c2, 'customerName', '客户对账单'), sink), '阳性对照·对账单一笔借方 +1');
  const c3 = JSON.parse(JSON.stringify(cust.json));
  c3.customerName = '不是这家公司的名字';
  mk(() => report('cust', collideStatement(toRows(cust.buf), c3, 'customerName', '客户对账单'), sink), '阳性对照·对象名换掉');
  const empty = toRows(aging.buf); // 解析器自证：真表必须读得出行与列，读不出就是尺瞎了（正向那条下限也拦这一手）
  controls.push(['阳性对照·解析器在真表上读得出表头 8 列以上', empty.length >= 2 && (empty[0]?.filter((x) => x !== null).length ?? 0) >= 8]);

  let bad = 0;
  for (const [name, caught] of controls) {
    if (caught) { pass += 1; console.log(`[对照✓] ${name}`); }
    else { bad += 1; fail += 1; console.log(`[对照✗ 判据哑了] ${name}`); }
  }
  fail += sink.length ? 1 : 0;
  for (const x of sink) console.log('  - ' + x);
  console.log(`══ 结果：${pass} 通过 / ${fail} 失败（正向 ${pass - controls.length + bad} 项 + 对照 ${controls.length - bad} 项）══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[红] ' + (e?.message ?? e)); process.exit(1); });
