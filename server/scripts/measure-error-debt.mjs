#!/usr/bin/env node
/**
 * §9 B22/B29/B32/B33/B34/B36/B37/B39 的**唯一度量入口**（只读，不改任何文件）
 * ★ 7j 批起本脚本还额外计量：**五支判据的并集**、以及 **B42/B43 两支"候选"（非判据、非欠债数）**
 *   与它们对五支的**实际偏移重叠** —— 这三类数此前每次靠当场现写脚本（违反 R2），现收进唯一入口。
 *
 * 为什么要有这个文件：2026-09-20 一天内四次因"每次现写一次性测量脚本"出错并烧掉批次 ——
 *   ① 把宽判据的"表 435 + 三元 29"加成 464，当成同一判据的数去和窄判据 393 比（**口径混算**）；
 *   ② B34 基线只抄前 14 大 ⇒ 守卫把另 17 个报成"新长出"（**明细不全**）；
 *   ③ 判"抛点是否被服务自身 catch 吸收"的静态扫描连行号都算错（**结论恒假**）；
 *   ④ 15:06 我在**守卫**里收紧了 B33 判据，这个脚本里那份没跟着改 ⇒ 同一口径两处给出 53 与 51。
 *
 * ④ 的根因不是粗心，是**判据活了两处**（R2 头号病：多套并行真源）。
 * ⇒ B33/B34/B36 三支判据已从本文件上移到 `scripts/lib/errorDebtScanners.mjs`，
 *   守卫（`src/shared/__tests__/*Ratchet.test.ts`）与本脚本**import 同一份**：
 *   两边数字如果还会不一致，那只能是守卫的基线表没同步，而不是判据分叉。
 *   ⚠️ B22/B29/B32 三支**仍在脚本与守卫里各存一份**（尚未上移），已登记为 §9 债。
 *
 * 用法：`node scripts/measure-error-debt.mjs`（在 `server/` 下）；`--json` 输出可机读汇总
 * ⚠️ 每个数口径不同，**禁止互相加减**（§0.3）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  b33Sites, b34Sites, b36Sites, b37Sites, b39Sites, countByFile, scanSources,
  rawLandingSites, rawLeakSites, rawLeakV1Sites, frontendLeakBuckets, frontendExclusionCost,
  FRONTEND_EXCLUDE_ANY, FRONTEND_EXCLUDE_ROOT,
} from './lib/errorDebtScanners.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const table = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([k, v]) => `  '${k}': ${v},`).join('\n');

const entries = scanSources(SERVER);
/**
 * ★ v2.45（复核 IMPORTANT-5 后半段）：**重叠一律按 (文件, 行号) 求交，不按字符偏移**。
 *   原先按偏移，而各支尺锚点不同（B71 从 `json(` 起算、B22/B42 从键名起算、五判据从各自形状起算）
 *   ⇒ 同一处代码的偏移永远不相等 ⇒ "重叠 = 0" 这条断言**结构上不可能红**（= 恒绿的判据，本仓老病）。
 */
const srcByRel = new Map(entries.map((e) => [e.rel, e.src]));
const lineOf = (rel, idx) => (srcByRel.get(rel) ?? '').slice(0, idx).split('\n').length;
const results = {};
function report(name, o, extra = '') {
  results[name] = { files: Object.keys(o).length, sites: total(o), byFile: o };
  console.log(`\n### ${name}\n    ${Object.keys(o).length} 个文件 / ${total(o)} 处 ${extra}`);
  console.log(table(o));
}

const TRUTH = /from '[.\w/]*shared\/(routeError|errorCodes)'|from '[.\w/]*lib\/asyncHandler'/;
const boundVars = (src) => new Set(
  [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:safeRouteError|resolveError)\(/g)].map((m) => m[1]),
);

/** B22 ①：总量表 —— `message: X.message` 且 X 不是真源解析结果（剥注释、排除测试） */
/** B22 ②：未过滤侧 —— ①里再限定"文件未 import 真源"，即历批报的"欠债本体" */
/** B22 ③：站点级补刀 —— ①里限定"文件已 import 真源"（D40 补的那张表） */
const b22 = { all: {}, unfiltered: {}, truthSite: {} };
for (const { rel, src } of entries) {
  const bound = boundVars(src);
  const n = [...src.matchAll(/message:\s*([A-Za-z_$][\w$]*)\??\.message/g)].filter((m) => !bound.has(m[1])).length;
  if (!n) continue;
  b22.all[rel] = n;
  (TRUTH.test(src) ? b22.truthSite : b22.unfiltered)[rel] = n;
}

/** B29：自带文案的兜底码站点（豁免但必须计量）+ 文案不合格（B31） */
const b29 = {};
let weak = 0;
for (const { rel, src } of entries) {
  let n = 0;
  for (const m of src.matchAll(/fallbackCode:\s*'([A-Z][A-Z0-9_]+)'([\s\S]{0,220}?)\}/g)) {
    const lit = /fallbackMessage:\s*(?:'[^']+'|`[^`]+`)/.test(m[2]);
    const konst = /fallbackMessage:\s*[A-Z][A-Z0-9_]*/.test(m[2]);
    if (!lit && !konst) continue;
    n += 1;
    const c = (m[2].match(/fallbackMessage:\s*'([^']*)'/) ?? [])[1];
    if (c !== undefined && (c.trim().length < 6 || !/[一-龥]/.test(c))) weak += 1;
  }
  if (n) b29[rel] = n;
}
/** 兜底码普查三支的合计（与 domainErrorShapes 的 F 组同口径） */
const fbAll = [];
for (const { src } of entries) for (const m of src.matchAll(/fallbackCode:\s*'([A-Z][A-Z0-9_]+)'/g)) fbAll.push(m[1]);
const fbSites = entries.reduce((s, e) => s
  + (e.src.match(/safeRouteError\([A-Za-z_$][\w$]*, \{ fallbackCode: '/g) ?? []).length, 0);

/** B32：路由/服务自己写的 code→status 映射（窄判据认变量名；宽判据只作下界自检） */
const b32 = {};
const b32meta = { looseTotal: 0, tablesOnly: 0 };
const statusMap = new Map();
for (const { rel, src } of entries) {
  let n = 0;
  let tables = 0;
  for (const m of src.matchAll(/const\s+\w*[sS]tatus\w*\s*:\s*Record<string,\s*number>\s*=\s*\{([\s\S]*?)\}/g)) {
    const es = m[1].match(/[A-Z][A-Z0-9_]+:\s*[1-5]\d\d(?!\d)/g) ?? [];
    n += es.length;
    tables += es.length;
    for (const e of es) {
      const [c, s] = e.split(/:\s*/);
      if (!statusMap.has(c)) statusMap.set(c, new Set());
      statusMap.get(c).add(s);
    }
  }
  for (const m of src.matchAll(/(?:\w+\.)?code\s*===\s*'([A-Z][A-Z0-9_]+)'\s*\?\s*([1-5]\d\d)(?!\d)/g)) {
    n += 1;
    if (!statusMap.has(m[1])) statusMap.set(m[1], new Set());
    statusMap.get(m[1]).add(m[2]);
  }
  if (n) b32[rel] = n;
  b32meta.tablesOnly += tables;
  for (const m of src.matchAll(/Record<string,\s*number>\s*=\s*\{([\s\S]*?)\}/g)) {
    b32meta.looseTotal += (m[1].match(/[A-Z][A-Z0-9_]+:\s*[1-5]\d\d(?!\d)/g) ?? []).length;
  }
}
const dual = [...statusMap.entries()].filter(([, s]) => s.size > 1)
  .map(([c, s]) => [c, [...s].sort().join('/')]).sort();

console.log(`# 错误出口家族 · 各口径（含 B42/B43 两支候选；每个数口径不同，禁止互相加减）  取样 ${new Date().toISOString()}`);
report('B22① 总量表：message: X.message（X 非真源结果）', b22.all);
report('B22② 未过滤侧（= 历批报的"欠债本体"）：①里文件未 import 真源', b22.unfiltered);
report('B22③ 站点级补刀（D40）：①里文件已 import 真源 ⇒ 待逐处核准的候选清单', b22.truthSite);
report('B29 自带文案的兜底码站点（豁免但计量；文案不合格 = B31）', b29, `· 其中文案不合格 ${weak} 处（B31）`);
console.log(`\n### 兜底码普查（与 domainErrorShapes F 组同口径）\n    fallbackCode 字面量 ${fbAll.length} 处 / ${new Set(fbAll).size} 枚 distinct`
  + `\n    注：\`safeRouteError(x, { fallbackCode: 'X' })\` 单行形态只数到 ${fbSites}，比上一行少 ${fbAll.length - fbSites} —— 差额是跨行写法的调用点，**别拿这个数当普查数**`);
report('B33 服务层「原文 || 中文」当对外文案（判据 = lib.b33Sites，认"本文件 catch 到的错误对象"）', countByFile(entries, b33Sites));
report(`B32 路由/服务内本地 code→status（窄判据；盲区 = 宽 ${b32meta.looseTotal} 表 − 窄 ${b32meta.tablesOnly} 表 = ${b32meta.looseTotal - b32meta.tablesOnly}）`, b32);
console.log(`    同码两档 ${dual.length} 枚: ` + dual.map(([c, s]) => `${c}:${s}`).join(' '));
report('B34 抛点缺 statusCode（判据 = lib.b34Sites 括号配对扫描；正则版整类漏"尾逗号/嵌套对象"）', countByFile(entries, b34Sites));
report('B36① 文案位 = String(原文)（无兜底符号，与 B33 等价但换了写法）', countByFile(entries, (src) => b36Sites(src, 'stringCopy')));
report('B36② `if (e?.code) return fail(e.code, e.message)`（Prisma 自带 code ⇒ 原文上屏 + 降 400）', countByFile(entries, (src) => b36Sites(src, 'codePassthrough')));
report('B37 `fail(<非字面量 code>, e?.message ?? 中文)`（B33/B36 都认不到的第四形）', countByFile(entries, b37Sites));
report('B39 `fail(CODE, `固定文案: ${原文}`, …)` 位置参数内插（B22/B30/B33/B36/B37 五条全瞎）', countByFile(entries, b39Sites));

/**
 * ★ **两支新候选**（7i/7j 批立账）：**都是候选清单，不是判据、不是欠债数**
 *   （**D49**：先立账 + 量清 + 公开数字，**不顺手加棘轮**）。两支均由独立复核先提出、
 *   本批**自己复量一遍**才落笔（**D47**：复核的数也要自己搜过）。
 *
 * **B42 · 对象字面量里 `message|error|reason: String(原文)`**
 *   形状 = `res.status(500).json({ error:'X', message: String(e?.message ?? e) })` ——
 *   **六条既有判据一条都不认**（B22 要 `message: X.message`、B30 要键名后接模板/拼接、
 *   B33 要「原文 `||`/`??` + 引号中文兜底」、B36① 要**位置参数**整段 `String(...)`、B37 要非字面量 code、B39 要位置参数内插）
 *   ⇒ 同一根因**第 9 次现形**（D32/D36/D40/D41/D43/D46/D49/D52 ⇒ 本次 **D58**）。
 *   ⚠️ 同一形状两种后果差别极大：路由级 `res.json(...)` = 用户真看到；`.catch(...)` 造的内部对象 = 只有被转发才上屏
 *   ⇒ **"是否直达响应体"要人读控制流**，本脚本**故意不判**（拿正则判"直达"= 再造一套并行真源，本仓头号病）
 *   ⇒ 两分清单见 `docs/B42-*.md`；**这个数不得写进任何"已清/欠债"叙述**。
 *
 * **B43 · 窄透传 `fail('<字面量码>', e.message, N)`**
 *   看着像"有意透传业务文案"（码是字面量、只认自己那几枚）⇒ **六条判据全瞎**
 *   （B33 要 `||`/`??` 兜底、B37 要**非**字面量码、B36② 要 `fail(e.code, …)`、B39 要模板内插）。
 *   危害比 B36② 窄：只有**同名码被别处以原文抛出**时才泄漏 —— 而这不是设想：
 *   `finance/invoiceMutationService.ts:194` 的 `toError` 对非白名单码正返回 `String(e?.message ?? e)`（Prisma 英文原文）。
 *   ⇒ 本支的"安全"目前**全靠一条无守卫的不变量**（该码只由本文件以中文抛出）。定性需读调用链，本脚本同样不判。
 */
const caughtNames = (src) => new Set(
  [...src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
    .concat([...src.matchAll(/\.catch\(\s*(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])),
);
/**
 * ★ B68（v2.35 立账）：**HTTP 档位由异常文本里的中文关键词现编**。
 *   判据形状与 v2.35 立账时**一字不改**（`includes('不存在')` / `includes('已存在')` / `notFound ?` / `function errStatus`），
 *   否则"从 89 降到 X"这句话不成立。计数口径：**逐行**、**注释行不计**（与立账时同一把尺）。
 *   ⚠️ 这把尺量的是"猜档的实现点"，与下面 B71、以及 B42 那三支"原文上屏"尺**互不换算**。
 */
const B68_RULER = /includes\('不存在'\)|includes\('已存在'\)|notFound \?|function errStatus/g;
const b68ByFile = {};
for (const { rel, src } of entries) {
  let n = 0;
  for (const raw of src.split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    n += (raw.match(B68_RULER) ?? []).length;
  }
  if (n) b68ByFile[rel] = n;
}
report('B68 文本判档点（v2.35 原尺，逐行/注释不计）', b68ByFile);

const CANDIDATES = {
  'B42 候选（对象字面量 message|error|reason: String(原文)）': /(?:message|error|reason)\s*:\s*String\(\s*([A-Za-z_$][\w$]*)\??\.message/g,
  'B43 候选（窄透传 fail(字面量码, e.message, N)）': /(?:fail|err|error)\s*\(\s*'[A-Z0-9_]+'\s*,\s*([A-Za-z_$][\w$]*)\.message\s*[,)]/g,
  // ★ B71（v2.42 立账）：**响应体里直接放被 catch 到的异常原文**，键名只认 `error`（`reason` 一并认，写法同源）。
  //   ⚠️ **故意不含 `message:` 那个键** —— 它已被 B22① 计到（实测同处重叠 29 处，见下方"B71 与 B22①"那行），
  //   把它并进来就是**重复计量**（本仓头号病：同一根因立两笔账）。
  //   与 B42 的差别 = 写法（B42 经 `String(...)` 包一层，本支裸取 `.message`）。
  //   ⚠️ 本尺的真实限制是 **json 体内不含嵌套花括号**（`[^{}]*`），**不是**"只认单行"（v2.45 复核更正：
  //   `[^{}]*` 是能跨行的，第一版这句口径写错了）⇒ 漏的是 `json({ error: { message: e.message } })` 这类**嵌套**写法。
  'B71 候选（json({ error|reason: <catch 到的异常>.message })）': /json\(\s*\{[^{}]*\b(?:error|reason)\s*:\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:as\s+[A-Za-z_$][\w$]*)?\s*\)?\??\.message/g,
};
const candidateSites = new Map();
for (const [name, re] of Object.entries(CANDIDATES)) {
  const byFile = {};
  const sites = [];
  for (const { rel, src } of entries) {
    const caught = caughtNames(src);
    if (!caught.size) continue;
    const hits = [...src.matchAll(re)].filter((m) => caught.has(m[1]));
    if (!hits.length) continue;
    byFile[rel] = hits.length;
    for (const h of hits) sites.push([rel, lineOf(rel, h.index)]);
  }
  candidateSites.set(name, sites);
  report(`${name} —— ⚠️ 候选 ≠ 欠债；两分/定性需人读控制流`, byFile);
}

/**
 * ★ **B73**（v2.46 立账）：`res.status(...).json(... <异常原文> ...)` 这条落点的**三个口径并列**。
 *   起因：守卫里那份正则的 `res\.status\([^)]*\)` 跨不过嵌套括号 ⇒ 本批把状态档换成
 *   `statusFromError(e, 500)` 之后**外泄一处没少、计数却从 12 掉到 10**。判据三份都在
 *   `lib/errorDebtScanners.mjs`（守卫 import 同一份，本处只报数），不再有两处实现。
 *   V3 是**落点视角**（catch 绑定的变量叫什么、status 里嵌套几层都认）⇒ 它是"还有多少没被守卫看见"的**上限口径**。
 */
{
  const per = { V1: { all: {}, n: 0 }, V2: { all: {}, n: 0 }, V3: { all: {}, n: 0 } };
  for (const { rel, src } of entries) {
    for (const [k, fn] of [['V1', rawLeakV1Sites], ['V2', rawLeakSites], ['V3', rawLandingSites]]) {
      const n = fn(src).length;
      if (n) { per[k].all[rel] = n; per[k].n += n; }
    }
  }
  console.log(`\n### B73 原始错误外泄 · 一把尺的三个口径（禁止互相加减，也禁止与 V2 基线以外的数换算）`);
  console.log(`    V1 旧形状   ${Object.keys(per.V1.all).length} 文件 / ${per.V1.n} 处  ← 守卫 2026-09-17 用的那把`);
  console.log(`    V2 现形状   ${Object.keys(per.V2.all).length} 文件 / ${per.V2.n} 处  ← 守卫现在冻结的基线`);
  console.log(`    V3 落点口径 ${Object.keys(per.V3.all).length} 文件 / ${per.V3.n} 处  ← 连"变量不叫 e""嵌套两层"都认，上限口径`);
  console.log(table(per.V3.all));
  console.log('    ⚠️ V3 仍有取不到的形状：`.json(` 换行写的对象字面量（跨行）三个口径都漏。');
}

/**
 * ★ **并集**（7i 批补进本脚本）：五支"原文上屏"判据按 `(文件, 字符偏移)` 去重后的并集。
 *   以前这个数每次都是**当场现写脚本**算的（⇒ 违反 R2，且 7i 之后没人敢再报）⇒ 收进唯一度量入口。
 *   ⚠️ 只是"工作量"口径，**不代表一个动作**（互斥断言保证两两不重复扣数，见 `serviceRawEchoRatchet.test.ts`）。
 */
const famSets = { B33: b33Sites, B36a: (s) => b36Sites(s, 'stringCopy'), B36b: (s) => b36Sites(s, 'codePassthrough'), B37: b37Sites, B39: b39Sites };
const famIndexSets = new Map(); // rel -> { k -> Set<line> }，供重叠比较复用（避免每文件重复跑判据）
const union = new Set();
const perFam = {};
for (const { rel, src } of entries) {
  const per = {};
  for (const [k, fn] of Object.entries(famSets)) {
    const hits = fn(src);
    perFam[k] = (perFam[k] ?? 0) + hits.length;
    per[k] = new Set(hits.map((h) => lineOf(rel, h.index)));
    for (const h of hits) union.add(`${rel}#${lineOf(rel, h.index)}`);
  }
  famIndexSets.set(rel, per);
}
const unionFiles = new Set([...union].map((u) => u.split('#')[0])).size;
console.log(`\n### 五支判据并集（B33+B36①+B36②+B37+B39，按 文件+行号 去重）\n    ${union.size} 处 / ${unionFiles} 文件`
  + `\n    分项（未去重）：` + Object.entries(perFam).map(([k, v]) => `${k}=${v}`).join(' '));

/** 候选与五支判据的**实际重叠**：>0 即重复计量，必须公开更正（B39 立判据时正靠这条发现与 B37 重叠 1 处） */
for (const [name, sites] of candidateSites) {
  const ov = {};
  for (const [rel, line] of sites) {
    const per = famIndexSets.get(rel) ?? {};
    for (const [k, set] of Object.entries(per)) if (set.has(line)) ov[k] = (ov[k] ?? 0) + 1;
  }
  console.log(`\n### ${name.split(' ')[0]} 与上述五支的重叠（按 文件+行号；0 = 真盲区，>0 = 重复计量要更正）\n    `
    + (Object.keys(ov).length ? Object.entries(ov).map(([k, v]) => `${k}=${v}`).join(' ') : '0 处'));
}
/**
 * ★ 候选**两两之间**的重叠（v2.42 补 · v2.45 改成按行号）：新增一支候选时必须先回答"它是不是已立账那支的另一种写法"
 *   ⇒ 按 (文件, 行号) 求交。同一行里两处不同字段（`json({ message: String(e.message), error: e.message })`）
 *   会被算成重叠 —— 这正是我们要看的"同一处被记了两笔"。
 */
const candKeys = [...candidateSites.keys()];
for (let i = 0; i < candKeys.length; i += 1) {
  for (let j = i + 1; j < candKeys.length; j += 1) {
    const a = new Set(candidateSites.get(candKeys[i]).map(([rel, line]) => `${rel}#${line}`));
    const b = candidateSites.get(candKeys[j]).map(([rel, line]) => `${rel}#${line}`);
    const inter = b.filter((k) => a.has(k)).length;
    console.log(`\n### 候选重叠 ${candKeys[i].split(' ')[0]} ∩ ${candKeys[j].split(' ')[0]} = ${inter} 处（按 文件+行号）`);
  }
}

/**
 * ★ B71 与 **B22①** 的重叠（v2.42 补 · v2.45 改成按行号，与上面各体重叠同尺）：
 *   B71 立账前必须先回答"这是新形状还是 B22 换了下标名"。
 *   实测：把 `message:` 键并进来时会有 29 处与 B22① 落在**同一行的同一个字段** ⇒ 真重复计量，故本尺只认 `error|reason`。
 *   ★ v2.45：改成按行号之后，本尺读数与 B22① 仍有 **9 行同处**（`marketingRouteV2` 8 行 + `traceabilityRoute:61`）——
 *   那是"同一行两个字段各外发一次"（`error:` 与 `message:`），**不是同一处记两遍** ⇒ 预期值 = 9，不是 0。
 *   ⇒ 这行若跳到 29 以上，说明有人把 `message:` 加回了本尺（那才是重复计量）。
 */
{
  const b71 = CANDIDATES['B71 候选（json({ error|reason: <catch 到的异常>.message })）'];
  let dup = 0, net = 0;
  for (const { src } of entries) {
    const caught = caughtNames(src); if (!caught.size) continue;
    const bound = boundVars(src);
    const ln = (idx) => src.slice(0, idx).split('\n').length;
    const b22Lines = new Set([...src.matchAll(/message:\s*([A-Za-z_$][\w$]*)\??\.message/g)]
      .filter((m) => caught.has(m[1]) && !bound.has(m[1])).map((m) => ln(m.index)));
    for (const m of src.matchAll(new RegExp(b71.source, 'g'))) {
      if (!caught.has(m[1]) || bound.has(m[1])) continue;
      net += 1;
      if (b22Lines.has(ln(m.index))) dup += 1;
    }
  }
  console.log(`\n### B71 与 B22① 的重叠（按行号；预期 9 = 同一行 error: 与 message: 两字段各一次；跳到 29+ 才说明本尺误含了 message: 键）\n    净新增 ${net} 处 / 与 B22① 重叠 ${dup} 处`);
}

// ── B74（前端面，v2.48 复核处置上移成一份尺）────────────────────────────────
// 为什么在这里：v2.47 台账那版 232/82 与 202+11+1 是当场敲的三条独立 rg（标识符集合窄、桶之间还重叠）
// ⇒ 复核复现不出、且加不回去。自本行起这条面的数**只能来自 frontendLeakBuckets()**。
{
  const fe = frontendLeakBuckets(path.resolve(SERVER, '..'));
  console.log('\n### B74 前端"异常原文进可见文案"（唯一尺 = lib/errorDebtScanners.mjs:frontendLeakBuckets）');
  // ★ v2.47 复核 B1：范围必须跟着数一起打印。旧版写的是"前端"，实际只走了 components/
  //   （白名单里三项 src/hooks/screens 在仓里不存在，根级 App.tsx、lib/、customer-portal/、electron/ 一个没进）
  // ★ 复核 M-1：光列排除项的名字不算交代范围 ⇒ 把每个被排除目录**丢掉的命中数**一起打出来
  const cost = frontendExclusionCost(path.resolve(SERVER, '..'));
  console.log(`    范围 = 仓根黑名单遍历；任意深度剪：${FRONTEND_EXCLUDE_ANY.join(' ')}；仓根一层剪：${FRONTEND_EXCLUDE_ROOT.join(' ')}`);
  console.log(`    ★ 排除项的代价（这些目录里还有多少命中）：${Object.keys(cost).length ? Object.entries(cost).map(([k, v]) => `${k}=${v}`).join(' · ') : '无命中'}`);
  // ★ v2.52 复核 I-4：上一版台账把这里写成"实测 0"，而现量是 server=134 · scripts=11 ⇒ 那句话不实。
  //   server/ 那一份由 server 侧那把尺覆盖（同一 lib 的 b33/b34/b36/b37/b39 走 server/src），
  //   所以"净·两把尺都不看"的才是排除项的真实代价 ⇒ 台账引用时必须连这一句一起引。
  const netOutsideExclusion = Object.entries(cost).filter(([k]) => k !== 'server').reduce((s, [, v]) => s + v, 0);
  console.log(`      其中 server=${cost.server ?? 0} 由 server 侧尺覆盖 ⇒ **净"两把尺都不看"= ${netOutsideExclusion} 行**（不是 0）`);
  console.log(`    总行 ${fe.totalLines} / 文件 ${fe.files}`);
  console.log(`    落点（按优先级取一，非语义互斥）：具名错误态 ${fe.buckets.setError} · toast ${fe.buckets.toast}`
    + ` · 其余可见 ${fe.buckets.otherVisible} · 仅日志 ${fe.buckets.console}`);
  console.log(`    ★ 其中同时像两类落点的行：${fe.overlapLines}（分桶按 console>toast>setter>其余 的优先级取一，`
    + '所以四个桶是"归类结果"不是四种事实，不许拿桶差去推"丢了多少"）');
  console.log(`    形状（可重叠，仅诊断用）：插值 ${fe.shapes.interp} · 拼接 ${fe.shapes.concat} · set*Error ${fe.shapes.setter}`);
  console.log('    ⚠️ 总行是**上界**：它不证明该文案真被渲染，也看不见改名后再喂别的状态的写法；'
    + '可排除项只有"仅日志"那一桶。与 B22/B42/B71 各口径**禁止互相加减**（§0.3）。');
}

console.log('\n⚠️ 以上每个口径互不换算（§0.3）：并集只可用于工作量、禁止当判据；B42/B43/B71 是候选清单，禁止当欠债数。');
if (process.argv.includes('--json')) {
  // 打到 stdout（不落文件 ⇒ 不会有"上一次取样的 json 被当成现状"这种二次污染）
  console.log('\n@@JSON@@' + JSON.stringify({ sampledAt: new Date().toISOString(), results }));
}
