#!/usr/bin/env node
/**
 * 生产静态资源冒烟 —— 抓页面 HTML，把它引用的**同源资源**逐个撞一遍（**只读**）
 *
 * ## 为什么需要
 * 第 1 批验收发现过一个**阻断级**缺陷：部署时「增量跳过」被误判 ⇒ **静默删掉前端文件**
 * （浏览器 `GET /fonts/Inter-300.woff2 → 404`，且**无任何报警**）。
 * 那个缺陷是「**页面能打开、但资源 404**」——**光看首页 200 是发现不了的**。
 *
 * ⇒ 判据必须是：**页面自己引用的每个同源资源都要能取到**。
 * 本脚本就是这条判据的可执行形式，可用于**每次部署后的冒烟**。
 *
 * ## 覆盖两个前端入口（本仓有两个部署目标）
 *   · `webapp-root` → `https://bambook.jiangsupanda.com/`            （子域名模式，base=/）
 *   · `webapp`      → `https://jiangsupanda.com/bambook/api/app/`    （路径模式）
 * 第 1 批的缺陷正是「**两个入口互相丢文件**」⇒ 必须**两个都验**。
 *
 * ## 用法
 *   node scripts/check-production-assets.mjs                    # 验两个公网入口
 *   node scripts/check-production-assets.mjs <baseUrl> [...]    # 验指定入口（如内网）
 *   ASSET_TIMEOUT_MS=8000 node scripts/check-production-assets.mjs
 *
 * 退出码：0 = 全部资源可取；1 = 有资源取不到（或页面本身打不开）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENTRIES = [
  'https://bambook.jiangsupanda.com/',
  'https://jiangsupanda.com/bambook/api/app/',
];
const TIMEOUT = Number(process.env.ASSET_TIMEOUT_MS || 12000);
/** 本地 public/ 目录（内容比对的基准） */
const LOCAL_PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
/** 只验同源资源；跨域（CDN/字体服务）单独统计但不计入失败 */
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ENTRIES = argv.length ? argv : DEFAULT_ENTRIES;

/**
 * 从 HTML 里抽 src=/href=（只取同源：以 / 开头或同域绝对地址） */
function extractAssets(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('mailto:')) continue;
    let u;
    try { u = new URL(raw, baseUrl); } catch { continue; }
    // 同源（含同域的其它路径）
    if (u.origin === base.origin) out.add(u.pathname + u.search);
    else out.add('__CROSS__' + u.origin);
  }
  return [...out];
}

/**
 * ★★ 本地 `public/` 清单 —— 这是**第 1 批缺陷的判据核心**。
 *
 * 为什么光看 HTML 不够：**字体是从 CSS 里引的，HTML 层看不到**。
 * 第 1 批那次「部署静默删文件」中招的正是 `data/glyphs/geo/fonts` 四个**目录**
 * ⇒ 必须拿**本地清单**去撞生产（而不是只看页面引用了什么）。
 *
 * 大目录（`glyphs/*` 各 258 个图集）**抽样**验，避免把生产打满。
 */
function localPublicInventory(samplePerDir = 6) {
  const root = LOCAL_PUBLIC;
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    let sampled = 0;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      // 顶层文件全验；子目录内抽样
      if (rel && sampled >= samplePerDir) continue;
      out.push(r.split(path.sep).join('/'));
      if (rel) sampled += 1;
    }
  };
  walk(root, '');
  return out;
}

/** URL 路径里对特殊字符做最小编码（空格等） */
const encodePath = (p) => p.split('/').map((s) => encodeURIComponent(s)).join('/');

/**
 * ★★ 内容**新鲜度**比对（2026-09-19 新增）—— 抓「大小相同但内容不同」的**静默陈旧**。
 *
 * ## 为什么需要
 * 客户端增量打包的跳过判据是 **`local_size == remote_size`**（`scripts/ops-upload-webapp.sh`），
 * **没有 mtime、没有 hash**；而服务端 manifest 端点（`/api/admin/webapp-manifest`）也只返回
 * `{ 路径: 字节数 }` ⇒ **无从比对内容**。
 * ⇒ 若某文件**内容变了、字节数没变**（例如 SVG 里 `#fff` → `#000`、JSON 改一个同长字段），
 *   它会被**永久跳过**，生产**静默保持旧内容**、且**不报任何错**。
 *
 * ## 判据
 * 对**非 content-hash 命名**的文件（`assets/` 之外 —— 那些名字里带 hash，同名即同内容，天然安全）
 * 逐个取生产内容与本地比对；**大小相同而内容不同 ⇒ 陈旧**。
 * 大文件跳过（`MAX_COMPARE_BYTES`），避免把 `*.pmtiles` 拉下来。
 */
const MAX_COMPARE_BYTES = 1024 * 1024; // 只比对 ≤1MB 的文件
async function compareContent(entry, relPaths) {
  const stale = [];
  const skipped = [];
  for (const rel of relPaths) {
    // `assets/` 是 content-hash 命名 ⇒ 同名即同内容，无需比对
    if (rel.startsWith('assets/')) continue;
    let local;
    try { local = fs.readFileSync(path.join(LOCAL_PUBLIC, rel)); } catch { continue; }
    if (local.length > MAX_COMPARE_BYTES) { skipped.push(rel); continue; }
    let remote;
    try {
      const r = await fetch(new URL(encodePath(rel), entry).toString(), { signal: AbortSignal.timeout(TIMEOUT) });
      if (r.status !== 200) continue; // 取不到 ⇒ 由「存在性」检查负责报，这里不重复
      remote = Buffer.from(await r.arrayBuffer());
    } catch { continue; }
    // 大小不同 ⇒ 增量判据会判「已变」⇒ 会被上传，不是陈旧（存在性检查也覆盖不到这种情况，但这里只报陈旧）
    if (remote.length === local.length && !remote.equals(local)) {
      stale.push(`${rel}（大小同为 ${local.length}B，内容不同）`);
    }
  }
  return { stale, skipped };
}

/**
 * 探测一个 URL 是否可取。
 * ⚠️ 不能一律用 GET：`public/data/*.pmtiles` 是**大文件**，GET 会把生产带宽吃满。
 * ⇒ 先 HEAD；若服务端不支持 HEAD（405/501）再退到 **`Range: bytes=0-0`**（只取 1 字节）。
 */
async function probe(url) {
  const opts = { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) };
  try {
    const r = await fetch(url, { ...opts, method: 'HEAD' });
    if (r.status !== 405 && r.status !== 501) return r.status;
  } catch { /* 退到 ranged GET */ }
  try {
    const r = await fetch(url, { ...opts, headers: { Range: 'bytes=0-0' } });
    // 206 = 支持 Range（正常）；200 = 服务端忽略 Range（也算可取，但会多下一点）
    return r.status;
  } catch (e) {
    return `ERR:${String(e?.name ?? e).slice(0, 24)}`;
  }
}

let anyFail = false;
for (const entry of ENTRIES) {
  console.log(`\n══ ${entry} ══`);
  let html = '';
  let pageStatus = 0;
  try {
    const res = await fetch(entry, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    pageStatus = res.status;
    html = await res.text();
  } catch (e) {
    console.log(`  ✗ 页面取不到：${String(e?.message ?? e).slice(0, 120)}`);
    anyFail = true;
    continue;
  }
  if (pageStatus !== 200) { console.log(`  ✗ 页面 HTTP ${pageStatus}`); anyFail = true; continue; }
  console.log(`  ✓ 页面 200（${html.length} 字节）`);

  const assets = extractAssets(html, entry);
  const sameOrigin = assets.filter((a) => !a.startsWith('__CROSS__'));
  const cross = assets.filter((a) => a.startsWith('__CROSS__')).map((a) => a.slice(9));
  if (cross.length) console.log(`  ⓘ 跨域资源 ${cross.length} 个（不计入失败）：${[...new Set(cross)].slice(0, 3).join(' · ')}`);

  let bad = [];
  // 并发验（限 6 路，避免把生产打满）
  const queue = [...sameOrigin];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const st = await probe(new URL(p, entry).toString());
      if (st !== 200) bad.push(`${p} → ${st}`);
    }
  });
  await Promise.all(workers);

  console.log(`  同源资源 ${sameOrigin.length} 个 → 失败 ${bad.length}`);
  for (const b of bad.slice(0, 12)) console.log(`    ✗ ${b}`);
  if (bad.length) anyFail = true;
  else console.log('  ✓ 页面引用的同源资源全部可取');

  // ★★ 本地 public/ 清单 vs 生产 —— 第 1 批缺陷的**核心判据**
  //    （字体是 CSS 引的，HTML 层看不到；必须拿本地清单去撞）
  const localFiles = localPublicInventory();
  const localBad = [];
  const lq = [...localFiles];
  const lworkers = Array.from({ length: 6 }, async () => {
    while (lq.length) {
      const p = lq.shift();
      const st = await probe(new URL(encodePath(p), entry).toString());
      // 目录补斜杠的重定向（301）也算可取（curl -L 后为 200，见下）
      if (st !== 200 && st !== 301 && st !== 206) localBad.push(`${p} → ${st}`);
    }
  });
  await Promise.all(lworkers);
  console.log(`  本地 public/ 清单 ${localFiles.length} 个（顶层全验 + 子目录抽样）→ 生产异常 ${localBad.length}`);
  for (const b of localBad.slice(0, 12)) console.log(`    ✗ ${b}`);
  if (localBad.length) anyFail = true;
  else console.log('  ✓ 本地清单在生产上全部可取');

  // ★★ 内容新鲜度：抓「大小相同但内容不同」的**静默陈旧**（见 compareContent 头注释）
  const { stale, skipped } = await compareContent(entry, localFiles);
  console.log(`  内容比对（≤${(MAX_COMPARE_BYTES / 1024 / 1024).toFixed(0)}MB，跳过 ${skipped.length} 个大文件）→ 陈旧 ${stale.length}`);
  for (const s of stale.slice(0, 12)) console.log(`    ✗ 陈旧：${s}`);
  if (stale.length) { anyFail = true; console.log('    ⚠️ 陈旧 = 增量跳过判据（只比 size）漏掉了「同大小但内容已变」⇒ 需手工重传该文件'); }
  else console.log('  ✓ 无静默陈旧（抽样范围内）');
}

console.log(anyFail ? '\n❌ 有资源取不到（疑似部署丢文件）' : '\n✅ 全部入口的同源资源均可取');
process.exit(anyFail ? 1 : 0);
