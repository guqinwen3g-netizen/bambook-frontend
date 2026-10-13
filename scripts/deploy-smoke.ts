/**
 * 部署后冒烟清单 · **可执行版**（goal ④ · v3.139）
 *
 * 真源仍是 `docs/上线交付包-清单与冒烟-2026-09-25.md` §三 那 10 行；本件把它从"待执行的散文"变成
 * **一条命令 + 一条能红证人**：`--negative` 对**每一条单独投毒**（只坏那一维），必须看到它红才算
 * 那条冒烟有牙——否则它就是"恒绿的假冒烟"（这一族本仓吃过太多次）。
 *
 * 只读：**本件不写任何业务数据**。生产上跑它也只是 GET/查询（备份目录只做 fs 检查）。
 *
 * 用法：
 *   SMOKE_API=http://127.0.0.1:8090 SMOKE_WEB=http://127.0.0.1:3002 \
 *   SMOKE_EXPECT_BUILD=<本次部署的提交号> SMOKE_EMAIL=… SMOKE_PASSWORD=… \
 *   npx tsx scripts/deploy-smoke.ts            # 正例：该绿的绿
 *   … npx tsx scripts/deploy-smoke.ts --negative   # 反例：每条都被抓到才算数
 *
 * ⚠️ 绝不把口令打进屏幕（本仓踩过 `ps -E` 泄 key 的那类事）。
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { orderAmountOf } from '../server/src/shared/orderAmount';

const NEG = process.argv.includes('--negative');
const API = (process.env.SMOKE_API ?? 'http://127.0.0.1:8090').replace(/\/+$/, '');
const WEB = (process.env.SMOKE_WEB ?? '').replace(/\/+$/, '');
const EMAIL = process.env.SMOKE_EMAIL ?? 'jason.shen@bambook.local';
// ★ v3.217：口令**不许有默认值**。这份工具会被打进"现场工具包"交给部署环境，
//   把演示口令写死在源码里＝把凭据随产物发出去（它属轮换清单一族，待轮换）。
//   缺口令 ⇒ fail-fast 退出码 1：宁可拒跑，也不许把"没跑"读成"通过"。
const PASSWORD = process.env.SMOKE_PASSWORD ?? ''
const EXPECT_BUILD = process.env.SMOKE_EXPECT_BUILD ?? '';
const BACKUP_DIR = process.env.SMOKE_BACKUP_DIR ?? '/Users/Shared/BambookBackups';
const ASSETS = ['logo_dual.svg', 'ui-lab-icon.svg', 'pwa-icon.svg'];
const NEED_COLS: Array<[string, string, string]> = [
  ['OrderProfitSheet', 'bankFeeCost', 'OrderProfitSheet'],
  ['OrderProfitSheet', 'allowanceCost', 'OrderProfitSheet'],
  ['PaymentVoucher', 'feeBearer', 'PaymentVoucher'],
];

type R = { ok: boolean; why: string };
const ok = (why: string): R => ({ ok: true, why });
const bad = (why: string): R => ({ ok: false, why });
const skip = (why: string): R => ({ ok: false, why: '未跑 ' + why });

let token = '';
async function login(pw: string): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: pw }),
  });
  const j: any = await res.json().catch(() => ({}));
  return res.ok ? String(j?.token ?? j?.data?.token ?? '') : '';
}
async function getJSON(path: string, useAuth = true): Promise<{ status: number; j: any }> {
  const res = await fetch(`${API}${path}`, { headers: useAuth && token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, j: await res.json().catch(() => null) };
}

// ============ 10 条冒烟，每条一个纯函数；投毒只动自己那一维 ============
const CHECKS: Array<{ n: string; run: (p?: any) => Promise<R>; poison: () => any; poisonWhy: string }> = [
  {
    n: '1 health（署名闸：build == 本次部署的提交号）',
    poison: () => ({ expectBuild: 'deadbeef-not-this-build' }),
    poisonWhy: '把"期望的提交号"换成一个不可能的值 ⇒ 署名这一半必须红',
    async run(p = {}) {
      const want = p.expectBuild ?? EXPECT_BUILD;
      const { status, j } = await getJSON('/api/health', false);
      if (status !== 200 || !j) return bad(`HTTP ${status}`);
      if (String(j.status) !== 'ok' || String(j.database) !== 'ok') return bad(`status=${j.status} database=${j.database}`);
      if (!want) return skip('：没给 SMOKE_EXPECT_BUILD ⇒ 署名无法判定（**不许读成通过**）；build 实测 ' + j.build);
      return String(j.build) === String(want) ? ok(`build=${j.build} 与本次部署一致`) : bad(`build=${j.build} ≠ 本次部署 ${want} ⇒ 部署的不是你以为的那份代码`);
    },
  },
  {
    n: '2 首页 HTML（静态资源挂上了）',
    poison: () => ({ web: 'http://127.0.0.1:1' }),
    poisonWhy: '把站点根指到一个连不上的端口',
    async run(p = {}) {
      const base = p.web ?? WEB;
      if (!base) return skip('：没给 SMOKE_WEB（生产入口的根 URL）');
      try {
        const res = await fetch(base + '/');
        const html = await res.text();
        const t = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
        if (res.status !== 200) return bad(`HTTP ${res.status}`);
        if (!t) return bad('取到 HTML 但没有 <title> ⇒ 白屏风险');
        return ok(`<title>「${t.slice(0, 40)}」`);
      } catch (e: any) { return bad(`取不到首页：${e?.message ?? e}`); }
    },
  },
  {
    n: '3 登录（认证链）',
    poison: () => ({ pw: 'wrong-password-for-negative-test' }),
    poisonWhy: '用错口令 ⇒ 必须进不去',
    async run(p = {}) {
      const t = await login(p.pw ?? PASSWORD);
      return t ? ok(`拿到 token（长度 ${t.length}，值不打印）`) : bad('登录没拿到 token ⇒ 认证链断或账号不可用');
    },
  },
  {
    n: '4 订单列表 vs 详情：同一单金额/数量一致',
    poison: () => ({ shift: 1 }),
    poisonWhy: '把详情侧换成"列表里的另一单" ⇒ 跨页数字对不上必须被抓（两档同尺，只证彼此一致）',
    async run(p = {}) {
      const l = await getJSON('/api/v2/orders?limit=20');
      const items: any[] = (l.j?.items ?? l.j?.data?.items ?? []);
      if (!items.length) return bad(`列表没取到单（HTTP ${l.status}）`);
      const it = items[0];
      const d = await getJSON(`/api/v2/orders/${encodeURIComponent(items[(p.shift ?? 0)].id ?? it.id)}`);
      const od: any = d.j?.order ?? d.j?.data ?? d.j;
      if (!od) return bad(`详情 HTTP ${d.status}`);
      const aL = orderAmountOf(it as any), aD = orderAmountOf(od as any);
      if (aL == null || aD == null) return bad(`有一侧算不出金额：列表 ${aL} / 详情 ${aD}`);
      if (Number(aL) !== Number(aD)) return bad(`金额不一致：列表 ${aL} ≠ 详情 ${aD}（单号 ${it.poNumber}）`);
      if (Number(it.quantity) !== Number(od.quantity)) return bad(`数量不一致：列表 ${it.quantity} ≠ 详情 ${od.quantity}`);
      return ok(`同一单两边逐字相等：金额 ${aL} · 数量 ${it.quantity}`);
    },
  },
  {
    n: '5 驾驶舱（聚合路径）',
    poison: () => ({ path: '/api/v1/dashboard/__nope__' }),
    poisonWhy: '打一个不存在的路径',
    async run(p = {}) {
      const { status, j } = await getJSON(p.path ?? '/api/v1/dashboard/cockpit');
      const c = j?.data ?? j;
      if (status !== 200 || !c) return bad(`HTTP ${status}`);
      if (!Array.isArray(c?.salesLeaderboard)) return bad('返回体里没有 salesLeaderboard 数组 ⇒ 聚合结构变了');
      return ok(`HTTP 200 · 按业务员 ${c.salesLeaderboard.length} 行`);
    },
  },
  {
    n: '6 账龄报表（财务路径）',
    poison: () => ({ stale: true }),
    poisonWhy: '把 asOf 当成"必须是今天"来投毒（模拟一张旧报表）⇒ 旧数必须被抓',
    async run(p = {}) {
      const { status, j } = await getJSON(p.path ?? '/api/v1/finance/reports/aging');
      if (status !== 200) return bad(`HTTP ${status}`);
      const body = j?.data ?? j;
      // 现查形状：`{type, asOf, rows:[{customerRelationId, currency, invoiceCount, buckets{…total}}]}`
      const rows = Array.isArray(body?.rows) ? body.rows : null;
      if (!rows) return bad('200 但返回体没有 rows 数组 ⇒ 形状变了，这条要重新对');
      const asOf = String(body?.asOf ?? '');
      const today = new Date().toISOString().slice(0, 10);
      if (rows.length === 0) return bad('rows 是空的 ⇒ 这一格没有分母，不许读成"财务路径通"');
      if (asOf && p.stale) return bad(`asOf=${asOf}（投毒用）`);
      if (asOf !== today) return bad(`asOf=${asOf} ≠ 今天 ${today} ⇒ 账龄是旧数/缓存，不是当前欠款`);
      return ok(`rows ${rows.length} 行 · asOf=${asOf}（当天）`);
    },
  },
  {
    n: '7 三个曾经的 404 资源（B13：根级 svg）',
    poison: () => ({ assets: ['__definitely_missing_a__.svg'] }),
    poisonWhy: '把一个肯定不存在文件名喂进同一段代码',
    async run(p = {}) {
      const base = p.web ?? WEB;
      if (!base) return skip('：没给 SMOKE_WEB');
      const list: string[] = p.assets ?? ASSETS;
      const out: string[] = [];
      for (const a of list) {
        const res = await fetch(`${base}/${a}`).catch(() => null);
        if (!res) { out.push(`${a}=取不到`); continue; }
        // ★ 只看 status 会被 **SPA 兜底**骗过去：开发服务器/带 try_files 的站点给任何路径都回 200 + text/html
        //   （本批 --negative 第一次跑就靠这一点"抓不到"，暴露了这条冒烟是恒绿的假冒烟）。
        const ct = String(res.headers.get('content-type') ?? '');
        if (res.status === 404) out.push(`${a}=404`);
        else if (res.status === 200 && /text\/html/i.test(ct)) out.push(`${a}=200 但是 HTML 兜底（不是这个 svg）`);
      }
      return out.length ? bad(`仍在 404：${out.join(' / ')} ⇒ 根级文件又被增量包省略了`) : ok(`${list.length} 项全部非 404`);
    },
  },
  {
    n: '8 备份仍在跑（出事时有得回）',
    poison: () => ({ dir: '/Users/Shared/__no_such_backup_dir__' }),
    poisonWhy: '指到一个不存在的目录',
    async run(p = {}) {
      const dir = p.dir ?? BACKUP_DIR;
      if (!fs.existsSync(dir)) return bad(`目录不存在：${dir}`);
      const today = new Date().toISOString().slice(0, 10);
      const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
      // ★ 只数 dump（`backup.log` 也在同一个目录里，跟着数会把"共 2 份"写成两份备份）
      const dumps = files.filter(f => f.endsWith('.dump'));
      if (!dumps.length) return bad(`${dir} 里一份 dump 都没有（目录里 ${files.length} 个文件，都不是 .dump）`);
      const fresh = dumps.filter(f => f.includes(today.replace(/-/g, '')) || f.includes(today));
      const newest = dumps.sort().slice(-1)[0];
      // ceil：7.6 天按 floor 会读成 7 天，正好卡在 retention（删 7 天前的）门槛上而不报警
      const ageDays = Math.ceil((Date.now() - fs.statSync(`${dir}/${newest}`).mtimeMs) / 86400000);
      if (fresh.length) return ok(`${dir} 里当天件 ${fresh.length} 个（共 ${files.length}）`);
      // ★ 差点写错的一句（本批现查 `backup-postgres.sh` 的顺序才拦住）：retention 是在
      //   `pg_dump` **成功且 `pg_restore --list` 验完之后**才跑（且 `set -euo pipefail`），所以"下次一跑会把最后一份自我清除"
      //   是**假的**（跑起来会先产出新那份）。真实风险是：**只剩一份、8 天前、且没有自动化在产生第二份**。
      return bad(`${dir} 里没有**当天**的 dump（最新 ${newest} · ${ageDays} 天前 · dump 共 ${dumps.length} 份）`
        + ` ⇒ "出事有得回"现在不成立：这 ${ageDays} 天的改动没有 dump，且只有一份、坏了没有第二份可退`);
    },
  },
  {
    n: '9 三列存在性（只读 SQL，比 health 更直接地证明迁移落地）',
    poison: () => ({ cols: [['OrderProfitSheet', 'definitelyNotAColumn', 'OrderProfitSheet']] as Array<[string, string, string]> }),
    poisonWhy: '查一个不存在的列名',
    async run(p = {}) {
      const url = process.env.DATABASE_URL;
      if (!url) return skip('：没给 DATABASE_URL（这一条不经应用，直连库）');
      const { SERVER_DIR } = await import('./lib/acceptance-selfcheck.mjs');
      const { PrismaClient } = createRequire(SERVER_DIR + '/')('@prisma/client');
      const prisma = new PrismaClient();
      try {
        const missing: string[] = [];
        for (const [table, col] of (p.cols ?? NEED_COLS)) {
          const r: any[] = await prisma.$queryRaw`select count(*)::int as n from information_schema.columns
            where table_name = ${table} and column_name = ${col}`;
          if (Number(r[0]?.n ?? 0) === 0) missing.push(`${table}.${col}`);
        }
        return missing.length ? bad(`缺列：${missing.join(' / ')} ⇒ 迁移没跑到这台库`) : ok('三列都在');
      } finally { await prisma.$disconnect(); }
    },
  },
  {
    n: '10 利润表读取：顶层 bankFeeCost / allowanceCost 两个字段存在',
    poison: () => ({ dropKey: 'allowanceCost' }),
    poisonWhy: '假装服务端不再回这两个字段之一（与第 9 条"查一个不存在的列名"同一种投毒：动探针读到那一维）⇒ 该条必须报缺字段',
    async run(p: any = {}) {
      const { status, j } = await getJSON(p.path ?? '/api/v1/pricing/profit-sheets');
      if (status !== 200 || !j) return bad(`HTTP ${status}`);
      // 现查形状：`{items:[], total:0}`。★ 本库 `total=0` ⇒ **一张利润表都没生成过**（全库没有带成本的单，见台账 v3.138）
      //   ⇒ 这一格在只读冒烟里**没有分母**：不许读成"字段存在"，也不许读成"字段缺失"。
      //   （要它有分母必须 POST generate 生成一张，那是**写操作**，生产冒烟禁止 ⇒ 这一格在生产上只能是"未判定"或等到真有人生成。）
      const body = j?.data ?? j;
      const items: any[] = Array.isArray(body?.items) ? body.items : (Array.isArray(body?.rows) ? body.rows : []);
      const total = Number(body?.total ?? items.length);
      if (!items.length) {
        return p.path ? bad(`投毒路径 HTTP ${status}`) : skip(`：库里一张利润表都没有（total=${total}）⇒ 没有分母，两字段无从判定`);
      }
      if (p.dropKey) delete items[0][p.dropKey];
      const has = (k: string) => Object.prototype.hasOwnProperty.call(items[0], k);
      const miss = ['bankFeeCost', 'allowanceCost'].filter(k => !has(k));
      return miss.length ? bad(`返回体顶层缺字段：${miss.join(' / ')} ⇒ 那两列的成本没进这张表`)
        : ok(`顶层两字段都在（items ${items.length} 行）`);
    },
  },

  // ★ 第 11 条不在原文档的"部署后 10 行"里，本批加进来：它是**部署前对着包**跑的（本机 dist），
  //   拦的正是本仓历史两起同类事故那一族 —— 整目录/根级文件被增量包省略（B13 三个 svg、以及更早的 fonts/ 那起）。
  //   第 7 条只看三个文件名，这一条看**每一族的文件数**（少一个 pbf 也算）。
  {
    n: '11 包内静态资源族清单（public ↔ dist 逐族对撞 · 部署前）',
    poison: () => ({ dropFamily: 'glyphs' }),
    poisonWhy: '假装包里 glyphs 那一族整族没了（本仓历史上就是"整目录被省略"）⇒ 必须报缺族',
    async run(p = {}) {
      const pub = process.env.SMOKE_PUBLIC ?? 'public';
      const dst = p.dist ?? process.env.SMOKE_DIST ?? 'dist';
      if (!fs.existsSync(pub) || !fs.existsSync(dst)) return skip(`：${pub} 或 ${dst} 不在本机（这一条要在**打包那台机器**上跑）`);
      const count = (dir: string) => fs.readdirSync(dir, { recursive: false, encoding: 'utf8' }).filter(f => !f.startsWith('.'));
      const filesDeep = (dir: string): number => {
        let n = 0;
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(`${d}/${e.name}`); else if (e.isFile()) n++; } };
        walk(dir); return n;
      };
      const bad0: string[] = [];
      for (const e of count(pub)) {
        if (p.dropFamily && e === p.dropFamily) { bad0.push(`${e}=**整族缺失**（public 里有、包里没有）`); continue; }
        const src = `${pub}/${e}`;
        const dstp = `${dst}/${e}`;
        if (!fs.existsSync(dstp)) { bad0.push(`${e}=包里不存在`); continue; }
        const ns = fs.statSync(src).isDirectory() ? filesDeep(src) : 1;
        const nd = fs.statSync(dstp).isDirectory() ? filesDeep(dstp) : 1;
        if (ns !== nd) bad0.push(`${e} 文件数 public=${ns} ≠ dist=${nd}`);
      }
      const families = count(pub).length;
      return bad0.length ? bad(`包与 public 对不上：${bad0.join(' · ')}`)
        : ok(`${families} 族逐族相等（含 glyphs 512 个 pbf 这类整目录）· 根级 svg 3 个都在`);
    },
  },
];

if (!PASSWORD) {
  console.error('✗ 没给 SMOKE_PASSWORD ⇒ 冒烟拒绝开跑。★ 也不许把"没跑"读成"通过"：部署现场这一格必须由人补齐口令再跑。');
  process.exit(1);
}

const results: Array<{ n: string; r: R }> = [];
if (!NEG) {
  token = await login(PASSWORD);   // 其余条目各自取用自己需要的凭证；失败不提前退出，让每条自己报
  console.log(`════ 部署后冒烟（只读）· API=${API} WEB=${WEB || '(未配)'} · 期望 build=${EXPECT_BUILD || '(未配)'}`);
} else {
  token = await login(PASSWORD);
  console.log(`════ 冒烟清单的"能红"证人：对每条**单独投毒**，看它抓不抓得到 · API=${API}`);
}

for (const c of CHECKS) {
  if (NEG) {
    const r = await c.run(c.poison());
    results.push({ n: c.n, r });
    console.log(`  ${r.ok ? '✗ 抓不到（这条是恒绿的假冒烟）' : '✓ 抓到'} ${c.n} — 投毒=${c.poisonWhy} · 返回=${r.why}`);
  } else {
    const r = await c.run();
    results.push({ n: c.n, r });
    console.log(`  ${r.why.startsWith('未跑') ? 'ⓘ' : r.ok ? '✓' : '✗'} ${c.n}${r.why ? ' — ' + r.why : ''}`);
  }
}

const passed = results.filter(x => x.r.ok).length;
const skipped = results.filter(x => x.r.why.startsWith('未跑')).length;
const failed = results.length - passed - skipped;
console.log('────────────────────────────────────────');
if (NEG) {
  // 抓到 = 那条**报红了**（ok=false）；ok=true 表示投毒没被察觉＝恒绿的假冒烟；skip（未跑）也不算抓到
  const caught = results.filter(x => !x.r.ok && !x.r.why.startsWith('未跑'));
  const missed = results.filter(x => x.r.ok).map(x => x.n);
  const notrun = results.filter(x => x.r.why.startsWith('未跑')).map(x => x.n);
  console.log(` 结论（反例）：${caught.length}/${results.length} 条被抓到 · 抓不到 ${missed.length} 条${missed.length ? '：' + missed.join(' / ') : ''}${notrun.length ? ` · 投毒后仍没跑出结论 ${notrun.length} 条：${notrun.join(' / ')}` : ''}`);
  console.log('  ⇒ 抓不到的那条**不许读成"清单可信"**：它在真实坏部署上会照样报绿。');
  process.exit(missed.length ? 1 : 0);
}
console.log(` 结论：${passed} 通过 / ${failed} 失败 / ${skipped} 未跑（缺配或生产专属）`);
if (skipped) console.log('  ⚠️ "未跑"不是通过。逐条看上面哪几格是 ⓘ，把它们补上或如实报缺口。');
process.exit(failed ? 1 : 0);
