/**
 * 台账 xlsx 出口 · **逐行对撞**（v3.124 · 任务 #15）
 *
 * 这批要修的旧口径：E 批那条脚本只问「导出里**含不含**某个数」——那是**存在性断言**，
 *   拦不住"某一行的金额拿错了列"这种**逐行错**。⇒ 本件把判据升级成：
 *   ① 以 `订单号` 为键，把 xlsx 每一行的「金额」与**另一条出口**（`GET /api/v2/orders/:id` 的明细行）
 *      现算的 Σ`lines.netValue`（同一把真源尺 `orderAmountOf`）**逐行相等**；
 *   ② 分母自证：xlsx 行数 == 台账列表返回的订单数，且键唯一（键不唯一 ⇒ 对撞无意义，直接红）；
 *   ③ **阳性对照**：把同一份导出数据故意改坏一行（+0.01）喂给**同一个比较函数**，必须恰好报 1 处，
 *      喂未改坏的必须报 0 处 —— 没有这两格，①里的"0 处不一致"可能是尺瞎了而不是数对了。
 *
 * 用法（默认打断点 :8090 的走查后端；只读，不改库）：
 *   npx tsx scripts/acceptance-xlsx-row-collision.ts
 *   CHAIN_BASE=http://127.0.0.1:8081 npx tsx scripts/acceptance-xlsx-row-collision.ts
 */
import { createRequire } from 'node:module';
import { demoLoginPassword } from './lib/demoCredential'; // v3.237 补 40：值只住在 env（缺了就红），源码里不留字面量

const req = createRequire(import.meta.url);
// ★ 本件走**两条通道**：导出/列表/详情经 HTTP，逐行真源（负责人人名、状态与类型的覆盖分母、
//   筛选态导出的期望人名）经只读库连接 ⇒ **需要 DATABASE_URL**（见 db()；无 env 的工作树会按政策 ENV_MISSING 拒跑）。
//   v3.131 之前这里写的是"只走 HTTP、刻意不调 loadEnvForScript()"——那句从 86e51a97（负责人列改从库内真源取）起就是假的，现收回。

const XLSX = req('xlsx');
// 判据与生产同一份真源（不许在这里手抄兜底链）
import { orderAmountOf } from '../server/src/shared/orderAmount';
import { ORDER_STATUS_LABEL, ORDER_TYPE_LABEL, orderStatusLabel, orderTypeLabel } from '../server/src/shared/orderDisplayLabels';

const BASE = process.env.CHAIN_BASE ?? process.env.BAMBOOK_API ?? 'http://127.0.0.1:8090';
const MUTATE = process.argv.includes('--mutate');
const DELTA = 3850.5;
const R = (x: any) => (x == null ? null : Math.round(Number(x) * 100) / 100);

/** 只读连接：**默认路径也要连库**（人名 / 覆盖分母 / 筛选态导出的期望人名），`--mutate` 用的是另一个可写连接。
 *  无 `server/.env` 的工作树里 loadEnvForScript() 会按政策 ENV_MISSING 拒跑 ⇒ 要么显式给 DATABASE_URL，要么本件不成立。 */
async function db() {
  const { SERVER_DIR, loadEnvForScript } = await import('./lib/acceptance-selfcheck.mjs');
  loadEnvForScript();                       // 无 env 时按政策拒跑（要显式 DATABASE_URL）
  return createRequire(SERVER_DIR + '/')('@prisma/client');
}

const results: { ok: boolean | null; n: string; d?: string }[] = [];
const say = (s: string) => console.log(s);
const pass = (n: string, d = '') => { results.push({ ok: true, n, d }); say(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n: string, d = '') => { results.push({ ok: false, n, d }); say(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
// 缺口＝那一格**没有分母**（数据形状使然）：既不算通过、也不算缺陷；fail-closed 的意思是它**不绿**
const gap = (n: string, d = '') => { results.push({ ok: null, n, d }); say(`  ⓘ 缺口 ${n}${d ? ' — ' + d : ''}`); };

async function login(): Promise<string | null> {
  for (const email of ['jason.shen@bambook.local', 'charlie.qian@bambook.local', 'melissa.zhao@bambook.local']) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: demoLoginPassword() }),
    });
    const d: any = await res.json().catch(() => ({}));
    const token = d?.token ?? d?.data?.token ?? d?.accessToken ?? null;
    if (res.ok && token) return token;
  }
  return null;
}

/** 对撞本体：把导出侧与真源侧逐行比，返回**不一致清单**。accessor 决定比哪一列。 */
function collide<T>(rows: T[], pick: (r: T) => [unknown, unknown]): T[] {
  return rows.filter(r => {
    const [a, b] = pick(r);
    const na = a == null || a === '' ? null : String(a).trim();
    const nb = b == null || b === '' ? null : String(b).trim();
    if (na === nb) return false;
    // 数字型（数量/金额）：序列化成 "100.0000" 与 "100" 视为同值，但**空 vs 有值**不等
    const xa = Number(na), xb = Number(nb);
    return !(Number.isFinite(xa) && Number.isFinite(xb) && Math.abs(xa - xb) < 0.005);
  });
}

interface Row {
  key: string;
  exported: number | null; truth: number | null;
  ccyE: unknown; ccyT: unknown;
  qE: unknown; qT: unknown;
  uE: unknown; uT: unknown;
  dE: unknown; dT: unknown;
  tyE: unknown; tyT: unknown;
  stE: unknown; stT: unknown;
  owE: unknown; owT: unknown;
}

async function main() {
  say('════════════════════════════════════════════════════════');
  say(' 台账 xlsx 出口 · 逐行对撞（含阳性对照）');
  say(` 端点 ${BASE} · ${MUTATE ? '变异态演练（造一张真分叉单，跑完回滚）' : '只读'} · ${new Date().toISOString()}`);
  say('════════════════════════════════════════════════════════');

  const token = await login();
  if (!token) { fail('登录', '三个演示账号均不可用 ⇒ 无法取数'); return finish(); }
  const H = { Authorization: `Bearer ${token}` };

  // ① xlsx 出口
  const xres = await fetch(`${BASE}/api/v2/orders?format=xlsx`, { headers: H });
  if (!xres.ok) { fail('取 xlsx', `HTTP ${xres.status}`); return finish(); }
  const book = XLSX.read(await xres.arrayBuffer(), { type: 'array' });
  const sheet = book.Sheets[book.SheetNames[0]];
  const grid: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const header: string[] = (grid[0] ?? []).map(String);
  const iKey = header.indexOf('订单号');
  const iAmt = header.indexOf('金额');
  const iCcy = header.indexOf('币种');
  const iTy = header.indexOf('类型'), iSt = header.indexOf('状态'), iOw = header.indexOf('负责人');
  if (iTy < 0 || iSt < 0 || iOw < 0) { fail('表头列定位（类型/状态/负责人）', `header=${JSON.stringify(header)}`); return finish(); }
  if (iKey < 0 || iAmt < 0) { fail('表头列定位', `header=${JSON.stringify(header)}`); return finish(); }
  const body = grid.slice(1).filter(r => r && r[iKey] != null);
  const exported = new Map<string, number | null>();
  for (const r of body) exported.set(String(r[iKey]), r[iAmt] == null ? null : Number(r[iAmt]));
  pass('取到 xlsx 并有「订单号/金额」两列', `${body.length} 行 · sheet=${book.SheetNames[0]}`);

  // ①·补 可重复性：同一端点连抓两次必须逐字节相同。
  //    为什么盯这个：台账是使用方拿去**互相核对**的文件（业务对账、给工厂），
  //    若导出里掺了构建时间戳之类的不稳定字节，同一批数据两次导出就会"看起来变了"，核对就失去意义。
  {
    const bufA = await (await fetch(`${BASE}/api/v2/orders?format=xlsx`, { headers: H })).arrayBuffer();
    const bufB = await (await fetch(`${BASE}/api/v2/orders?format=xlsx`, { headers: H })).arrayBuffer();
    const hex = async (b: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');
    const sA = await hex(bufA), sB = await hex(bufB);
    if (sA === sB) pass('导出可重复：同端点两次逐字节相同', `${bufA.byteLength}B · sha256 ${sA.slice(0, 12)}…`);
    else fail('导出不可重复', `两次 sha 不同：${sA.slice(0, 12)}… vs ${sB.slice(0, 12)}… ⇒ 同一批数据会得到两张不同的台账`);
    // 反事实（这格自己的对照）：同一段双抓逻辑打在**已知会变**的端点上必须报"不同"，
    // 否则上面那个"逐字节相同"只是尺瞎了（health 响应里有 timestamp，天然每次不同）。
    const hA = await hex(await (await fetch(`${BASE}/api/health`, { headers: H })).arrayBuffer());
    const hB = await hex(await (await fetch(`${BASE}/api/health`, { headers: H })).arrayBuffer());
    if (hA !== hB) pass('可重复性对照：会变的内容确实被这把尺报成"不同"', `health 两次 sha 前缀 ${hA.slice(0, 8)} vs ${hB.slice(0, 8)}`);
    else fail('可重复性对照不成立', 'health 两次 sha 相同 ⇒ 双抓比较没在比真实字节，上面那个"逐字节相同"不算数');
  }

  // 真源侧只读连接：负责人人名、状态/类型覆盖分母、筛选态导出的期望值都从这里取（导出侧给不了）。
  //   ⇒ 本件**不是纯 HTTP**：只读那一趟也连库，所以需要 DATABASE_URL（见 db()）。
  const { PrismaClient } = await db();
  const prismaRo = new PrismaClient();

  // ①·补2 筛选态导出：使用方是"先筛后导"的 ⇒ "屏上筛过、导出来却是全量"是这一格要拦的事。
  //   v3.143 从 3 个参数扩到 **8 个 + 1 个组合**（8＝`routeV2.ts:75-82` 那 8 个筛选参数，本批现读）。
  //   每条形判据：① 行数==同筛选列表条数（且键不重复）② **导出键集合 == 列表键集合**（逐键比，能点名）
  //   ③ 分母有效性：0 < n < 全量（n==全量＝筛选没生效；n==0＝没分母）④ 反事实：掺一个真实存在但不属于该筛选的号 ⇒ 恰好报 1。
  //   有导出列的那三格（状态/类型/负责人）额外做**库侧真源逐行核**（expect 从导出之外取）。
  {
    const allKeys = new Set(exported.keys());
    const FULL = exported.size;
    // 「部门」这一维从 v3.237 补 27 起**有分母了**（演示数据此前绕过了创建路径 ⇒ departmentId 全 null）。
    //   候选值**从库里现取**（不硬编码，否则数据一换这一格就悄悄失效）：取"有单、且单数 < 全量"的部门里最少的那个。
    const deptGroups = (await prismaRo.order.groupBy({
      by: ['departmentId'],
      where: { departmentId: { not: null } },
      _count: { _all: true },
    })).filter((g: any) => g.departmentId && g._count._all > 0 && g._count._all < FULL)
      .sort((a: any, b: any) => a._count._all - b._count._all);
    const realDept = deptGroups[0]?.departmentId ?? null;
    console.log(`  ⓘ 部门维度现量：有部门的部门数 ${deptGroups.length} 个 · 取最少的那个 ${realDept ?? '（没有 ⇒ 这一维仍造不出分母）'}（${deptGroups[0]?._count?._all ?? 0} 张）／全量 ${FULL}`);
    const filters: Array<{ q: string; label: string; col?: string; truth?: 'status' | 'type' | 'owner'; note?: string; expectEmpty?: boolean }> = [
      { q: 'status=Shipping', label: '状态', col: '状态', truth: 'status' },
      { q: 'type=Garment', label: '类型', col: '类型', truth: 'type' },
      { q: 'ownerId=usr_demo_sales_a', label: '负责人', col: '负责人', truth: 'owner' },
      { q: 'customerCode=SIM-CUS-03', label: '客户号', note: '库里现量：该列有值的最大分组 9 张' },
      { q: 'customerRelationId=SIM-CUS-03', label: '结算单位' },
      { q: 'businessLine=garment', label: '业务线（成衣）' },
      { q: 'search=SIM-PO-1002', label: '搜索（按单号）', note: '只比键集合＝**两出口彼此一致**那一档；`search` 的谓词不在这里复刻（那是第二套实现）' },
      // ★ 两条一起才算有牙：正例（真部门，分母被筛小）+ 反例（不存在的部门，必须筛出 0 而不是全量）
      ...(realDept ? [{ q: `departmentId=${realDept}`, label: '部门（真值）', note: 'v3.237 补 27：这一维的回填走的是产品自己的 PUT（值＝该负责人 UserRole 里的部门）' }] : []),
      { q: 'departmentId=dep_not_exists', label: '部门（不存在的值）', expectEmpty: true, note: realDept ? '反例：筛一个不存在的部门 ⇒ 必须 0 行（不许漏成全量）' : '★ 缺口：库里在用单的 departmentId 全为 null ⇒ 这一维只有反例、没有正例，不许读成通过' },
      { q: 'status=Shipping&type=Garment', label: '组合：状态+类型', note: '两个条件同时（v3.133 点名过的未覆盖）' },
    ];
    for (const f of filters) {
      const fres = await fetch(`${BASE}/api/v2/orders?format=xlsx&${f.q}`, { headers: H });
      if (!fres.ok) { fail(`筛选态导出 ${f.q}`, `HTTP ${fres.status}`); continue; }
      const fg = XLSX.utils.sheet_to_json(XLSX.read(await fres.arrayBuffer(), { type: 'array' }).Sheets['订单台账'], { header: 1, defval: null }) as any[][];
      const fh = (fg[0] ?? []).map(String);
      const fKey = fh.indexOf('订单号');
      const fCol = f.col ? fh.indexOf(f.col) : -1;
      if (f.col && fCol < 0) { fail(`筛选态导出 ${f.q}`, `导出里没有「${f.col}」这一列`); continue; }
      const frows = fg.slice(1).filter((r: any[]) => r && r[fKey] != null);
      const fKeys = new Set(frows.map((r: any[]) => String(r[fKey])));
      const lres = await fetch(`${BASE}/api/v2/orders?limit=500&${f.q}`, { headers: H });
      const ljson: any = await lres.json();
      const lItems: any[] = ljson?.items ?? [];
      const lKeys = new Set(lItems.map((o: any) => String(o.poNumber ?? '')));

      // ③ 分母有效性先判（它决定其余几格有没有区分力）
      if (fKeys.size === 0) {
        // 反例格（expectEmpty）本来就该是 0 行 ⇒ 它不是"没分母"，而是"漏筛"的证人：
        //   两侧都 0 才算成立；导出 0 行但列表有货＝两个出口分歧，照旧报缺。
        if (f.expectEmpty) {
          if (lItems.length === 0) pass(`筛选态导出 ${f.q}：反例成立（两侧都 0，没漏成全量）`, `导出 0 行 == 列表 0 条 / 全量 ${FULL}${f.note ? ' · ' + f.note : ''}`);
          else gap(`筛选态导出 ${f.q} 的反例`, `导出 0 行但列表 ${lItems.length} 条 ⇒ 两个出口分歧，不读成通过`);
          continue;
        }
        gap(`筛选态导出 ${f.q} 的分母`, `导出 0 行${f.note ? ' · ' + f.note : ''} ⇒ 这一格没有区分力，不许读成通过`);
        continue;
      }
      if (fKeys.size === FULL) {
        fail(`筛选态导出 ${f.q} 的筛选没生效`, `导出 ${FULL} 行 == 全量 ⇒ "屏上筛过、导出来是全量"这一族缺陷被抓现行`);
        continue;
      }
      pass(`筛选态导出 ${f.q}：分母有效（真的被筛小了）`, `${fKeys.size} / 全量 ${FULL}${f.note ? ' · ' + f.note : ''}`);

      // ① 行数 == 条数 == 去重后的键数
      if (frows.length !== fKeys.size) fail(`筛选态导出 ${f.q} 的键唯一性`, `${frows.length} 行但只有 ${fKeys.size} 个号 ⇒ 有重复行`);
      else if (frows.length !== lItems.length) fail(`筛选态导出 ${f.q} 的分母对撞`, `导出 ${frows.length} 行 ≠ 同筛选列表 ${lItems.length} 条`);
      else pass(`筛选态导出 ${f.q}：行数跟筛选走且不重复`, `${frows.length} 行 == 列表 ${lItems.length} 条`);

      // ② 键集合逐键对撞（多出来的/缺的都点名）
      const keyDiff = (a: Set<string>, b: Set<string>) =>
        [...a].filter(k => !b.has(k)).map(k => `多:${k}`).concat([...b].filter(k => !a.has(k)).map(k => `缺:${k}`));
      const kd = keyDiff(fKeys, lKeys);
      if (fKeys.size !== lKeys.size && lItems.length === 0) {
        gap(`筛选态导出 ${f.q} 的键对撞`, '列表侧取不到 items（可能 limit/字段形状不同）⇒ 无法对撞，不读成通过');
      } else if (kd.length) fail(`筛选态导出 ${f.q}：两个出口的键集合不等`, kd.slice(0, 4).join(' ') + (kd.length > 4 ? ` …共 ${kd.length} 处` : ''));
      else pass(`筛选态导出 ${f.q}：导出的就是屏上筛过的那一批`, `${fKeys.size} 个号逐键相等（列表 ↔ 文件）`);

      // ④ 反事实：掺一个**真实存在但不属于该筛选**的号，同一比较必须恰好报 1
      const foreign = [...allKeys].find(k => !fKeys.has(k));
      if (!foreign) fail(`筛选态导出 ${f.q} 的反事实取不到素材`, '全量里找不到一个"不在该筛选内"的号 ⇒ 上面那格无法自证');
      else {
        const poisoned = new Set([...fKeys, foreign]);
        const cd = keyDiff(poisoned, lKeys);
        if (cd.length === 1) pass(`筛选态导出 ${f.q} 的阳性对照：掺一个外来的号就被抓到`, `报出 ${cd[0]}`);
        else fail(`筛选态导出 ${f.q} 的阳性对照不成立`, `掺 1 个报 ${cd.length} 处（要 1）⇒ 上面那句"逐键相等"不可信`);
      }

      // ⑤ 有导出列的三格：逐行核**库侧/标签侧真源**（比"两出口一致"更强的一档）
      if (f.truth && fCol >= 0) {
        const raw = f.q.split('=');
        const val = decodeURIComponent(raw[1]);
        let expect: string;
        if (f.truth === 'status') expect = ORDER_STATUS_LABEL[val] ?? val;
        else if (f.truth === 'type') expect = ORDER_TYPE_LABEL[val] ?? val;
        else {
          const u = await prismaRo.userAccount.findUnique({ where: { id: val }, select: { displayName: true } });
          if (!u?.displayName) { fail(`筛选态导出 ${f.q} 的真源`, `库里取不到 ${val} 的 displayName ⇒ 这一格没有分母`); continue; }
          expect = String(u.displayName);
        }
        const probe = (rows: any[][]): number => rows.filter((r: any[]) => {
          const cell = String(r[fCol]);
          return cell !== expect || /^usr_|^u\d+$|^admin$/.test(cell);
        }).length;
        const bad = probe(frows);
        if (bad === 0) pass(`筛选态导出 ${f.q}：每一行都真属于该筛选值`, `${frows.length} 行逐行 == 真源「${expect}」`);
        else fail(`筛选态导出 ${f.q}：${bad} 行不属于该筛选值`, `期望「${expect}」⇒ 屏上筛过的条件在导出里漏了`);
        const poisoned = frows.map((r: any[], i: number) => (i === 0 ? [...r.slice(0, fCol), `${String(r[fCol])}×`, ...r.slice(fCol + 1)] : r) as any[]);
        const p1 = probe(poisoned), p0 = probe(frows);
        if (p1 === 1 && p0 === 0) pass(`筛选态导出 ${f.q} 的逐行阳性对照：改一行恰好报 1（原样 0）`);
        else fail(`筛选态导出 ${f.q} 的逐行阳性对照不成立`, `改坏报 ${p1}（要 1）· 原样报 ${p0}（要 0）`);
      }
    }
  }

  // ② 分母自证：xlsx 行数 == 列表条数；键唯一
  const lres = await fetch(`${BASE}/api/v2/orders?limit=300`, { headers: H });
  const ljson: any = await lres.json();
  const items: any[] = ljson?.items ?? [];
  if (!items.length) { fail('台账列表取数', 'items 为空 ⇒ 分母为 0，本件不作数'); await prismaRo.$disconnect(); return finish(); }
  if (exported.size !== new Set(body.map(r => String(r[iKey]))).size) {
    fail('xlsx 键唯一性', '同一订单号出现多行 ⇒ 对撞无意义');
  } else {
    pass('xlsx 键唯一（订单号可做对撞键）');
  }
  if (exported.size !== items.length) {
    fail('分母对撞', `xlsx ${exported.size} 行 ≠ 列表 ${items.length} 张 ⇒ 有一方被截断（limit/分页）`);
  } else {
    pass('分母对撞：导出行数 == 列表条数', `${items.length}`);
  }

  // ③ 逐行对撞：详情出口现算 Σ 明细行 + 数量/单位/交期三列取详情侧同名字段
  const rows: Row[] = [];
  const ownerIdByKey = new Map<string, unknown>();
  const missing: string[] = [];
  const raw = new Map<string, { q: unknown; u: unknown; d: unknown; c: unknown; ty: unknown; st: unknown; ow: unknown }>();
  if (iCcy >= 0) for (const r of body) {
    const iq = header.indexOf('数量'), iu = header.indexOf('单位'), id = header.indexOf('交期');
    raw.set(String(r[iKey]), { q: iq >= 0 ? r[iq] : null, u: iu >= 0 ? r[iu] : null, d: id >= 0 ? r[id] : null, c: r[iCcy], ty: r[iTy], st: r[iSt], ow: r[iOw] });
  }
  let mixedUnitOrders = 0;
  for (const o of items) {
    const key = String(o.poNumber ?? '');
    if (!key) { missing.push(String(o.id)); continue; }
    const dres = await fetch(`${BASE}/api/v2/orders/${encodeURIComponent(o.id)}`, { headers: H });
    const djson: any = await dres.json().catch(() => null);
    const order = djson?.order ?? djson?.data ?? djson;
    const truth = order && order.lines ? (orderAmountOf(order) as number | null) : null;
    if (truth == null) missing.push(key);
    // 币种真源＝销售侧口径（与屏面 resolveCurrency('sales')、驾驶舱 salesCcyOf 同优先序）
    const ccyT = order ? String(order.salesCurrency ?? order.currency ?? 'USD') : null;
    const units: string[] = [...new Set((order?.lines ?? []).map((l: any) => String(l.unit ?? '')).filter(Boolean))];
    if (units.length > 1) mixedUnitOrders++;
    ownerIdByKey.set(key, order?.ownerId ?? null);
    rows.push({
      key,
      exported: exported.has(key) ? exported.get(key)! : null, truth,
      ccyE: raw.get(key)?.c ?? null, ccyT,
      qE: raw.get(key)?.q ?? null, qT: order?.quantity ?? null,
      uE: raw.get(key)?.u ?? null, uT: units[0] ?? null,
      dE: raw.get(key)?.d ?? null, dT: order?.dueDate ?? null,
      tyE: raw.get(key)?.ty ?? null, tyT: orderTypeLabel(order?.type),
      stE: raw.get(key)?.st ?? null, stT: orderStatusLabel(order?.status),
      owE: raw.get(key)?.ow ?? null, owT: null, // 稍后按 UserAccount.displayName 回填（真源直连）
    });
  }
  // 负责人列的真源＝UserAccount.displayName（**独立于导出**，所以这一格有真区分力；
  //  旧写法把 o.ownerId 直接落进文件 ⇒ 下面那一格的"改坏一行"就是拿旧写法当反事实）
  try {
    const ids = [...new Set([...ownerIdByKey.values()].filter((v): v is string => typeof v === 'string' && v.length > 0))];
    const users = ids.length ? await prismaRo.userAccount.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }) : [];
    const nameById = new Map(users.map((u: any) => [u.id, u.displayName]));
    for (const r of rows) r.owT = r.owE === null && !ownerIdByKey.has(r.key) ? null : (nameById.get(String(ownerIdByKey.get(r.key) ?? '')) ?? null);
    const named = rows.filter(r => typeof r.owT === 'string' && r.owT).length;
    if (named !== rows.length) fail('负责人真源不完整', `${rows.length - named} 行取不到 displayName ⇒ 那一格会是空的（分母 ${named}/${rows.length}）`);
    else pass('负责人真源：每个 ownerId 都对得上人名', `${rows.length} 行 / ${ids.length} 个账号`);

    // 覆盖率分母来自库，不来自代码：库里出现的每个状态/类型都必须有中文标签
    const stVals = (await prismaRo.order.findMany({ where: { deletedAt: null }, distinct: ['status'], select: { status: true } })).map((x: any) => String(x.status));
    const tyVals = (await prismaRo.order.findMany({ where: { deletedAt: null }, distinct: ['type'], select: { type: true } })).map((x: any) => String(x.type));
    const stNoLabel = stVals.filter(v => !ORDER_STATUS_LABEL[v]);
    const tyNoLabel = tyVals.filter(v => !ORDER_TYPE_LABEL[v]);
    if (stNoLabel.length) fail('状态标签覆盖不全', `库里有 ${stNoLabel.join(',')} 没有标签 ⇒ 导出那一格会留空（宁空不裸码，但必须补表）`);
    else pass('状态标签覆盖库内全部取值', `${stVals.length} 个取值都有标签`);
    if (tyNoLabel.length) fail('类型标签覆盖不全', `库里有 ${tyNoLabel.join(',')} 没有标签`);
    else pass('类型标签覆盖库内全部取值', `${tyVals.length} 个取值都有标签`);

    // 裸码反事实：把导出格写成"旧写法的产物"（英文枚举 / 内部 id），这一格必须抓到
    // 把导出格全写成旧写法的产物（英文枚举），除了真源本来就是那张码的行，其余必须被抓
    const bareTy = collide(rows.map(r => ({ ...r, tyE: 'Garment' } as Row)), r => [r.tyE, r.tyT]).length;
    const bareOw = collide(rows.map(r => ({ ...r, owE: String(ownerIdByKey.get(r.key) ?? '') } as Row)), r => [r.owE, r.owT]).length;
    const wantTy = rows.filter(r => r.tyT !== 'Garment').length;
    if (bareTy > 0 && bareTy === wantTy) pass('裸码反事实：导出若写英文枚举 ⇒ 逐行都被抓', `${bareTy}/${rows.length} 行`);
    else fail('裸码反事实不成立', `写 'Garment' 只报 ${bareTy}（要 ${wantTy}）⇒ 那一格的 0 不可信`);
    if (bareOw === rows.filter(r => String(r.owT) !== String(ownerIdByKey.get(r.key))).length) pass('裸码反事实：导出若写内部账号 id ⇒ 逐行都被抓（这就是 B230 的旧写法）', `${bareOw}/${rows.length}`);
    else fail('裸 id 反事实不成立', `写 ownerId 只报 ${bareOw} ⇒ 负责人那一格的 0 不可信`);

    // ①·补3 删除面（② 未清四条第 4 条里「台账」那一半）：导出的每一行都必须是"没删的那一侧"的单。
    //   真源＝库（deletedAt 是否 null），与导出/列表两个 HTTP 出口无关 ⇒ 这一格有区分力。
    //   `Order.poNumber` 在 schema 里是 @unique ⇒ 在用侧与软删侧的号不可能撞车，归属判定不歧义。
    const livePo = new Set((await prismaRo.order.findMany({ where: { deletedAt: null }, select: { poNumber: true } }))
      .map((x: any) => String(x.poNumber ?? '')).filter(Boolean));
    const delPo = new Set((await prismaRo.order.findMany({ where: { deletedAt: { not: null } }, select: { poNumber: true } }))
      .map((x: any) => String(x.poNumber ?? '')).filter(Boolean));
    const leakProbe = (keys: string[]) => keys.filter(k => !livePo.has(k)).length;
    if (delPo.size === 0) {
      fail('删除面的分母', '库里一张带号的软删单都没有 ⇒ 这几格没有区分力，不许读成通过');
    } else {
      if (exported.size !== livePo.size) {
        fail('删除面：导出行数 ≠ 库里「未删」的单数',
          `导出 ${exported.size} · 库里在用 ${livePo.size} · 另有软删 ${delPo.size} ⇒ 有一侧被截断，或软删被算进了文件`);
      } else {
        pass('删除面：导出行数 == 库里「未删」的单数', `${exported.size} 行 · 库里在用 ${livePo.size} · 软删 ${delPo.size} 一张没进文件`);
      }
      const leak = leakProbe([...exported.keys()]);
      if (leak === 0) pass('删除面：导出的每个订单号都落在「未删」那一侧', `${exported.size} 个号逐一命中`);
      else fail('删除面：导出里有已软删的单', `${leak} 行的订单号在库里 deletedAt≠null ⇒ 台账把作废的单算进了金额合计`);
      // 阳性对照：喂给同一谓词的**不是合成数据**，是库里真实存在的那批软删号（原样 0 处、掺入后恰好报出全部）
      const ctrl = leakProbe([...livePo, ...delPo]);
      if (ctrl === delPo.size) pass('删除面阳性对照：把软删号掺进同一判据 ⇒ 恰好报出全部软删（原样 0）', `${ctrl}/${delPo.size}`);
      else fail('删除面阳性对照不成立', `喂「在用+软删」报 ${ctrl}（要 ${delPo.size}）⇒ 上面那个 0 可能是尺瞎了`);
    }
  } finally {
    await prismaRo.$disconnect();
  }

  if (missing.length) {
    fail('逐行对撞的前置', `${missing.length} 张取不到可算真源（无 poNumber 或详情不带 lines）⇒ 分母不完整，不许报通过`);
  } else {
    // 金额：导出 vs 详情侧 Σ明细行（生产同一个 orderAmountOf）
    const money = (r: Row): [unknown, unknown] => [r.exported, r.truth];
    report('金额', rows, money, r => ({ ...r, exported: (R(r.exported) ?? 0) + 0.01 }), r => ({ ...r, exported: null }), 'Σ明细行（真源 ①）');

    const qty = (r: Row): [unknown, unknown] => [r.qE, r.qT];
    report('数量', rows, qty, r => ({ ...r, qE: Number(r.qE ?? 0) + 1 }), r => ({ ...r, qE: null }), '详情侧 quantity');

    const unit = (r: Row): [unknown, unknown] => [r.uE, r.uT];
    report('单位', rows, unit, r => ({ ...r, uE: `${String(r.uE ?? '')}×` }), r => ({ ...r, uE: null }), '详情侧首行 unit');

    // 交期：xlsx 可能给 Excel 序列号，也可能给字符串；两边都归一到 YYYY-MM-DD 再比（拦时区把日期挪一天）
    const date = (r: Row): [unknown, unknown] => [normDate(r.dE), normDate(r.dT)];
    report('交期', rows, date, r => ({ ...r, dE: normDate(r.dE) === '1999-01-01' ? '1999-01-02' : '1999-01-01' }),
      r => ({ ...r, dE: null }), '详情侧 dueDate（归一到 YYYY-MM-DD）');

    // ★ 诚实标注：类型/状态两列的真源＝共享标签表，而导出用的就是它 ⇒ 这两格证明的是
    //   "导出确实查了表、没把裸码落进文件"（旧写法由上面的裸码反事实作证），**不证明词选得对**——
    //   词的口径由 §12.1 第 37 条（出运中 vs 发货中）与 ledgerLabelSources 守卫管。
    const ty = (r: Row): [unknown, unknown] => [r.tyE, r.tyT];
    report('类型', rows, ty, r => ({ ...r, tyE: String(r.tyT) === '面料' ? '成衣' : '面料' }), r => ({ ...r, tyE: null }), '共享标签表（＝屏面同一格）');

    const st = (r: Row): [unknown, unknown] => [r.stE, r.stT];
    report('状态', rows, st, r => ({ ...r, stE: String(r.stT) === '已交付' ? '生产中' : '已交付' }), r => ({ ...r, stE: null }), '共享标签表（＝屏面同一格）');

    // 负责人列：真源是 UserAccount.displayName（独立通道）⇒ 这一格有真区分力
    const ow = (r: Row): [unknown, unknown] => [r.owE, r.owT];
    report('负责人', rows, ow, r => ({ ...r, owE: String(ownerIdByKey.get(r.key) ?? 'x') }), r => ({ ...r, owE: null }), 'UserAccount.displayName（真源直连）');

    // 币种列对撞（B227）。★ 诚实标注：两列今天全相等 ⇒ 这一格在只读态**没有区分力**，
    //    它的证人是 --mutate 那一支（把两列故意写成不同值，看导出跟谁）。
    const ccyBad = rows.filter(r => r.ccyT != null && String(r.ccyE) !== String(r.ccyT));
    if (ccyBad.length === 0) {
      pass('币种列逐行 == 销售侧口径（salesCurrency ?? currency）',
        `${rows.filter(r => r.ccyE != null && r.ccyT != null).length}/${rows.length} 行两侧都有值 ⇒ 需 --mutate 才有区分力`);
    } else {
      fail(`币种列 ${ccyBad.length} 行与销售侧口径不同`, ccyBad.slice(0, 5).map(d => `${d.key}: 导出=${d.ccyE} 销售侧=${d.ccyT}`).join(' | '));
    }
    // 单位列的**前提**是否成立：导出只取首行 unit ⇒ 一单多单位时会误导
    if (mixedUnitOrders === 0) pass('单位列的前提：库里没有"一单多单位"的单', `⇒ 导出取首行 unit 今天不失实（B228 记的是这个前提）`);
    else fail('单位列只取首行 unit', `${mixedUnitOrders} 张单内部有多种单位 ⇒ 那一列对这些单是**以偏概全**（见台账 B228）`);
  }

  if (MUTATE) await mutateProof(H, items);
  return finish();
}

/** Excel 序列号 / ISO 串 / Date ⇒ 统一成 YYYY-MM-DD（比日期，不比时间戳） */
function normDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const ms = (Number(v) - 25569) * 86400 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

/** 一列的三段式：现值对撞 + 改坏一行的阳性对照 + 整列缺值的反向对照 */
function report(name: string, rows: Row[], pick: (r: Row) => [unknown, unknown],
  breakOne: (r: Row) => Row, nullAll: (r: Row) => Row, truthLabel: string) {
  const diffs = collide(rows, pick);
  if (diffs.length === 0) pass(`${name}列逐行对撞：${rows.length} 行 == ${truthLabel}`);
  else fail(`${name}列 ${diffs.length}/${rows.length} 行不一致`,
    diffs.slice(0, 5).map(d => `${d.key}: 导出=${String(pick(d)[0])} 真源=${String(pick(d)[1])}`).join(' | '));

  const broken = rows.map((r, i) => (i === 0 ? breakOne(r) : r));
  const d1 = collide(broken, pick).length, d0 = collide(rows, pick).length;
  if (d1 === 1 && d0 === 0) pass(`${name}列阳性对照：改坏一行恰好报 1 处（原样 0 处）`);
  else fail(`${name}列阳性对照不成立`, `改坏报 ${d1}（要 1）· 原样报 ${d0}（要 0）⇒ 那个 0 不可信`);

  const dn = collide(rows.map(nullAll), pick).length, want = rows.filter(r => pick(r)[1] != null).length;
  if (dn === want) pass(`${name}列缺值对照：整列导出为空 ⇒ ${want} 行全报`);
  else fail(`${name}列缺值对照`, `整列 null 只报 ${dn}/${want} ⇒ 尺会放过缺值`);
}

/**
 * ★ 出口级反事实：造一张**真分叉**的单（表头三列抬到 Σ明细行 + DELTA，明细不动），
 * 然后要求 xlsx 那一格 **跟着明细走**：等于 Σ明细行、且**不等于**被抬高的表头。
 * ⇒ 一个"抄表头"的实现会在这一格被抓红；而"库里 0 张分叉"时上一节的 0 差异是**空转**，
 *   这一节才是让那个 0 有资格的证人。跑完按抓取时点原值回滚并回读相等。
 */
async function mutateProof(H: Record<string, string>, items: any[]) {
  const { PrismaClient } = await db();
  const prisma = new PrismaClient();
  try {
    const cand = items.find((o: any) => o.poNumber);
    if (!cand) { fail('挑靶子', '列表里没有带 poNumber 的单'); return; }
    const dres = await fetch(`${BASE}/api/v2/orders/${encodeURIComponent(cand.id)}`, { headers: H });
    const dj: any = await dres.json();
    const order = dj?.order ?? dj?.data ?? dj;
    const lines: any[] = order?.lines ?? [];
    if (!lines.length) { fail('挑靶子', `靶子 ${cand.poNumber} 不带明细行 ⇒ 造不出"表头≠明细"的分叉`); return; }
    const lineSum = R(lines.reduce((s: number, l: any) => s + Number(l.netValue ?? 0), 0)) as number;
    const key = String(cand.poNumber);

    const before: any = await prisma.order.findUnique({
      where: { id: cand.id }, select: { quoteAmount: true, totalNet: true, contractAmount: true, currency: true, salesCurrency: true },
    });
    const orig = {
      quoteAmount: R(before.quoteAmount), totalNet: R(before.totalNet), contractAmount: R(before.contractAmount),
      currency: before.currency, salesCurrency: before.salesCurrency,
    };
    const diverged = R(lineSum + DELTA) as number;
    // ★ 币种也要造分叉：两列今天全相等 ⇒ 不写开就证不了"导出跟销售侧口径"（B227）
    const salesCcy = String(before.salesCurrency ?? 'USD');
    const otherCcy = salesCcy === 'EUR' ? 'GBP' : 'EUR';
    say(`  ⓘ 靶子 ${key}：Σ明细行=${lineSum} · 抓取时点三列=${JSON.stringify(orig)} · 币种对照 sales=${salesCcy} / currency→${otherCcy}`);

    try {
      await prisma.order.update({
        where: { id: cand.id },
        data: { quoteAmount: diverged, totalNet: diverged, contractAmount: diverged, currency: otherCcy },
      });
      const chk: any = await prisma.order.findUnique({ where: { id: cand.id }, select: { totalNet: true, currency: true } });
      if (R(chk.totalNet) !== diverged || String(chk.currency) !== otherCcy) {
        fail('造分叉落库', `回读 total=${R(chk.totalNet)} currency=${chk.currency} ⇒ 后面的读数都不算`); return;
      }
      pass('已造出一张真分叉的单', `表头三列=${diverged} · 币种两列写成 ${otherCcy} vs 销售侧 ${salesCcy} · Σ明细行仍=${lineSum}`);

      const xres = await fetch(`${BASE}/api/v2/orders?format=xlsx`, { headers: H });
      const grid: any[][] = XLSX.utils.sheet_to_json(XLSX.read(await xres.arrayBuffer(), { type: 'array' }).Sheets['订单台账'], { header: 1, defval: null });
      const hd: string[] = (grid[0] ?? []).map(String);
      const iC = hd.indexOf('币种');
      const row = (grid.slice(1) as any[]).find(r => String(r[hd.indexOf('订单号')]) === key);
      const got = row ? R(Number(row[hd.indexOf('金额')])) : null;
      const gotCcy = row && iC >= 0 ? (row[iC] == null ? null : String(row[iC])) : null;
      if (got === null) { fail('取靶子那一格', '导出里找不到这一单'); return; }
      if (got === diverged) fail('★ 出口在抄表头', `那一格=${diverged}（=抬高后的表头）⇒ 台账金额不是真源`);
      else if (got === lineSum) pass('★ 出口跟着明细行走', `那一格=${lineSum}，而抬高后的表头是 ${diverged}`);
      else fail('那一格两个都不是', `got=${got} · 明细=${lineSum} · 表头=${diverged}`);

      // 币种列：新口径应给销售侧；旧口径（currency 优先）会给出 otherCcy ⇒ 这一格就是 B227 的红
      if (gotCcy === null) fail('币种列对撞无读数', '导出里找不到「币种」列');
      else if (gotCcy === salesCcy) pass('★ 币种列跟销售侧口径走（B227 修好）', `导出=${gotCcy}，而 legacy currency 被写成 ${otherCcy}`);
      else fail('★ 币种列仍在读 legacy currency（B227 未修）', `导出=${gotCcy} · 应为销售侧 ${salesCcy}`);
    } finally {
      await prisma.order.update({
        where: { id: cand.id },
        data: {
          quoteAmount: orig.quoteAmount, totalNet: orig.totalNet, contractAmount: orig.contractAmount,
          currency: orig.currency,
        },
      });
      const back: any = await prisma.order.findUnique({
        where: { id: cand.id }, select: { quoteAmount: true, totalNet: true, contractAmount: true, currency: true, salesCurrency: true },
      });
      const same = R(back.quoteAmount) === orig.quoteAmount && R(back.totalNet) === orig.totalNet
        && R(back.contractAmount) === orig.contractAmount && back.currency === orig.currency && back.salesCurrency === orig.salesCurrency;
      if (same) pass('三列 + 币种两列已回滚到抓取时点原值', JSON.stringify(orig));
      else fail('回滚未回到原值', `回读 ${JSON.stringify({ q: R(back.quoteAmount), t: R(back.totalNet), c: R(back.contractAmount), cur: back.currency })} ≠ ${JSON.stringify(orig)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

function finish() {
  const bad = results.filter(r => r.ok === false);
  const gaps = results.filter(r => r.ok === null);
  say('────────────────────────────────────────────────────────');
  say(` 结论：${results.length - bad.length - gaps.length} 通过 / ${bad.length} 失败 / ${gaps.length} 缺口`);
  bad.forEach(b => say(`   ✗ ${b.n}${b.d ? ' — ' + b.d : ''}`));
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => { fail('异常', String(e?.message ?? e)); finish(); });
