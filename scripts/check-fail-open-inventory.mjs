#!/usr/bin/env node
/**
 * G3 fail-open 存量清单扫描器 —— 把 `catch(()=>0)` / `?? 0` / `|| 0` 分离成 **L-A / L-B / 待核实**
 *
 * 依据：`docs/交付目标与验收标准-2026-09-20.md` §2 G3（判定标准 v2.1 拆两级）· R3 覆盖派生 ·
 *      G6.2 覆盖面 ≥ 写法面 · G6.3 守卫自测 · §0.3「误报比漏报更伤信任」· §0.4「禁止凭记忆」。
 *
 * 为什么需要它：G3 现状表里 `server/src` 418 行 / 前端 221 行 是**两级混计**的原始计数，
 * 文档自己写明"含 L-A，尚未分离" ⇒ 不能当判据。本脚本的唯一职责 = 把它拆开（清单由扫描派生，非手写）。
 *
 * ═───────────────────────────────────────────────────────────────────────────
 * ## 分类规则（★ 明示；任何一条都可在评审时被推翻）
 *
 * 核心问句（G3 表原文）：兜底出来的那个 0 **是否流进「计算 / 比较 / 返回值门禁 / 写」**？
 *   是 → **L-A**（零容忍）；只作为**渲染文本 / 分页默认 / 聚合种子** → **L-B**（基线化）；
 *   两者都拿不出**局部证据** → **待核实**（默认归属；§0.4 禁止凭记忆 ⇒ 不猜）。
 *
 * 分析范围是**局部**的：命中所在括号语句（按括号深度定界）+ 绑定名在**同一块作用域**
 * （向下到块尾，硬上限 25 行）内的消费点。**跨函数 / 跨文件数据流不做** —— 最大盲区，
 * 后果登记在报告《分类规则的边界与已知误判》。
 *
 * 求值顺序：**先豁免 → 再定罪 → 落不到证据就待核实**。
 *
 *  E0 语义零豁免 → L-B
 *    E0-a 就地豁免注释：G3 配套机制 `// fallback:display <理由>`
 *    E0-b 分页/偏移默认：绑定名 ∈ {skip,offset,limit,take,page,pageSize,perPage,from,size}
 *         且同句无比较、不在写载荷内（G3 原文把"分页默认值"列为展示兜底）
 *    E0-c 聚合/计数**种子**：`map.get(k) ?? 0` / `obj[key] ?? 0` / reduce 累加器 `acc ?? 0` 紧跟 `+`
 *         ⇒ "空集求和 = 0" 语义上就是真零，不是把未知伪造成 0
 *         ⚠️ 若该 key 缺失其实意味着"金额未知"而非"无条目"，本条会**漏报**（已登记）
 *    E0-c2 计数器/版本号自增种子 `(usageCount ?? 0) + 1`、`(last?.version ?? 0) + 1`
 *         ⇒ "此前无记录 = 0 次/0 版"属业务零值（G3 配套机制里可就地注释豁免的那类）
 *    E0-d 纯渲染（前端）：命中在 JSX 插值 / 被 `toFixed()|toLocaleString()|Intl.NumberFormat|formatX()` 包裹，
 *         或 `.length ?? 0 > 0` 这类**只决定区块是否渲染**的门禁；且同区域无写调用
 *         ⇒ 按 G3"仅用于显示"归 L-B（前端算错只落到文字；若该数被复制进单据/导出则应升 L-A —— 见边界章节）
 *
 *  E1 判定/守卫证据 → L-A
 *    兜底表达式右邻是 `> < >= <= === !== ?`，或命中在 `if (…)` / `while (…)` 的**条件括号内**，
 *    或绑定名在同一块窗口内进入上述判定 / `throw` / `return` 门禁；
 *    或命中的外层调用链里有**校验/门禁调用** `check*|assert*|validate*|verify*|guard*|ensure*|can*(`
 *    （E1-gate：缺失值以 0 参与"能不能过"的判断）
 *
 *  E2 计算证据 → L-A
 *    兜底表达式是 `+ - * /` 或 `+=` 的操作数（含 `.reduce()` 求和项、`Number(x)||0` 参与加总），
 *    或绑定名在窗口内被算术消费，或 catch 兜底函数的返回值在调用点进算式（E2-fn）
 *
 *  E3 写路径证据 → L-A
 *    命中的最内层**或任意外层**调用是 `create*|update*|upsert|delete*|save|submit|patch|put|post(` /
 *    `new Prisma.Decimal(` / 位于 `data: { … }` 载荷内，或前端 `set*()` / `update*()` 表单行写入；
 *    绑定名同理
 *
 *  E5 业务量闸门（**收口 L-A 的关键一条，也是最可争议的一条**）
 *    E1/E2/E3 只证明"值流进了判定/计算/写"，不证明它改变的是**账目口径**。
 *    ⇒ 再要求兜底作用的对象（左操作数 / 绑定名 / 被赋的键）命中业务量词
 *      （amount·qty·total·count·price·cost·balance·rate·percent·invoice·shipment·voucher·limit·
 *       credit·tax·applied·received·version·seq…）。不命中 ⇒ **降待核实**（不判 L-A，也不硬说它是展示兜底）。
 *    理由 = §6 偏差分级：口径级（不报错但算错）最危险，体验级不是。`catch→0` 形状**不受本闸门约束**
 *      （它的来源本身就是"取数失败"）。
 *    ⚠️ 反面：命名不含业务量词但确实是金额 ⇒ **漏报**（已登记在边界章节，靠 --json 全量人工抽查）
 *
 *  E4 其余 → 待核实。其中四类**明确不按 L-A 判**（G3 现状①教训："按 catch 后翻 ready 一律判红会误报"）：
 *    · `.catch(()=>0)` 挂在**写/审计调用本身**上（吞掉写失败）→ 待核实 + 标"吞写失败"：
 *      它属 G4 写失败可见性，不在本判据"值参与判定"的口径内；
 *    · catch 块内已有 `logger.error|console.error|set*Error|toast` → 非静默 ⇒ 待核实；
 *    · 绑定名只被**取属性**（`if (!credit.ok)`）或只出现在**展示文案模板**（`body: \`…${n > 0 ? …}\``）
 *      ⇒ 那是"调用结果信封"/"一句话"，不是这个数在决定分支；
 *    · 值只落在 `sort()` 比较器里 ⇒ 只影响顺序，不影响数额。
 *
 *  ★ 匹配前**先抹除注释与字符串内容**（本仓两次因注释文本被计成违例 ⇒ 假红），但保留模板 `${}` 内代码；
 *    `?? 0.7` / `|| 0.9` 这类"兜底成非零"不算命中；JSX 标签尖括号不参与比较符判定。
 *
 *  退出码：0 = 无 L-A；1 = 存在 L-A（G3 零容忍判据不达标 ⇒ 可直接当门禁挂）；
 *          带 `--baseline` 时 L-B 高于基线也返回 1（只允许下降）。
 *
 * ## 用法
 *   node scripts/check-fail-open-inventory.mjs                  # 全量扫描 + 打印三级清单
 *   node scripts/check-fail-open-inventory.mjs --selfcheck      # G6.3：故意放错的形状撞分类器（11 例）
 *   node scripts/check-fail-open-inventory.mjs --baseline       # 与内置 L-B 基线比对（只允许下降）
 *   node scripts/check-fail-open-inventory.mjs --baseline --lb=170  # 故意把基线压低 ⇒ 验证会咬红（G6.3）
 *   node scripts/check-fail-open-inventory.mjs --print-baseline # 打印可粘回本文件的基线片段
 *   node scripts/check-fail-open-inventory.mjs --json           # 机器可读（逐命中，stdout 纯 JSON）
 *   node scripts/check-fail-open-inventory.mjs --show=la        # 只列某级：la|lb|todo|all（默认 all）
 *   node scripts/check-fail-open-inventory.mjs --debug=server/src/x.ts:76   # 打印该命中的分析中间量（复核用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ═════════════════════ 0. 覆盖面（实扫目录，报告照抄） ═════════════════════ */

const SCAN_GROUPS = [
  { name: 'server', label: 'server/src（后端）', roots: ['server/src'], exts: ['.ts'] },
  {
    name: 'frontend',
    label: '前端主应用：components/ services/ utils/ lib/ + App.tsx index.tsx types.ts appTheme.ts',
    roots: ['components', 'services', 'utils', 'lib'],
    files: ['App.tsx', 'index.tsx', 'types.ts', 'appTheme.ts'],
    exts: ['.ts', '.tsx'],
  },
  {
    name: 'portal',
    label: 'customer-portal/src（独立前端 MVP，G5/B7 范围内）',
    roots: ['customer-portal/src'],
    exts: ['.ts', '.tsx'],
  },
];

/** 排除：测试 / 依赖 / 构建产物 / 非源码目录（`scripts/`、`server/scripts/` 不在 G3 记录口径内） */
const EXCLUDED_DIR = /(^|\/)(node_modules|dist|dist-electron|build|out|coverage|__tests__|\.git|backups|logs|tmp|tmp-screenshots|uploads|storage|private-files|knowledge-base-frontend)(\/|$)/;
const EXCLUDED_FILE = /(\.test\.tsx?|\.spec\.tsx?|\.d\.ts)$/;

function walk(absDir, relDir, exts, acc) {
  let entries = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    const rel = `${relDir}/${e.name}`;
    if (EXCLUDED_DIR.test(`${rel}/`)) continue;
    if (e.isDirectory()) walk(abs, rel, exts, acc);
    else if (e.isFile() && exts.includes(path.extname(e.name)) && !EXCLUDED_FILE.test(e.name)) acc.push(rel);
  }
  return acc;
}

function collectFiles() {
  const out = [];
  const missing = [];
  for (const g of SCAN_GROUPS) {
    const set = new Set();
    for (const r of g.roots) {
      if (!fs.existsSync(path.join(ROOT, r))) { missing.push(`${r}/（目录不存在 ⇒ 未覆盖）`); continue; }
      for (const rel of walk(path.join(ROOT, r), r, g.exts, [])) set.add(rel);
    }
    for (const f of g.files || []) {
      if (fs.existsSync(path.join(ROOT, f))) set.add(f);
      else missing.push(f);
    }
    for (const rel of [...set].sort()) out.push({ rel, group: g.name });
  }
  return { files: out, missing };
}

/* ════════════ 1. 注释/字符串抹除 + 括号深度（同一趟字符扫描） ════════════ */

/**
 * 逐字符状态机：`//`、块注释、字符串/模板字面量**内容**换成空格（定界符保留），
 * 但**保留模板 `${}` 里的代码**（JSX 插值要参与分类）；同时给出每行行首括号净深度。
 */
function maskAndDepth(src) {
  const len = src.length;
  const res = new Array(len);
  let mode = 'code';        // code | sq | dq | tpl | linec | blockc | re
  const interp = [];        // `${}` 花括号计数栈
  let depth = 0;
  let line = 0;
  let lineNet = 0;
  let prevSig = '';
  const depthAtStart = [0];
  const netOnLine = [];

  for (let i = 0; i < len; i += 1) {
    const c = src[i];

    if (c === '\n') {
      if (mode === 'linec' || mode === 're') mode = 'code';
      res[i] = '\n';
      netOnLine[line] = lineNet;
      line += 1; lineNet = 0;
      depthAtStart[line] = depth;
      prevSig = '';
      continue;
    }

    if (mode === 'linec') { res[i] = ' '; continue; }
    if (mode === 'blockc') { if (c === '/' && src[i - 1] === '*') mode = 'code'; res[i] = ' '; continue; }

    if (mode === 'sq' || mode === 'dq' || mode === 'tpl' || mode === 're') {
      const q = mode;
      if (q !== 're' && c === '\\') { res[i] = ' '; i += 1; if (i < len) res[i] = src[i] === '\n' ? '\n' : ' '; continue; }
      if (q === 'sq' && c === "'") { mode = 'code'; res[i] = c; prevSig = c; continue; }
      if (q === 'dq' && c === '"') { mode = 'code'; res[i] = c; prevSig = c; continue; }
      if (q === 'tpl' && c === '`') { mode = 'code'; res[i] = c; prevSig = c; continue; }
      if (q === 'tpl' && c === '$' && src[i + 1] === '{') { res[i] = ' '; res[i + 1] = ' '; i += 1; mode = 'code'; interp.push(0); continue; }
      if (q === 're') {
        if (c === '[') { let j = i + 1; while (j < len && src[j] !== ']' && src[j] !== '\n') { if (src[j] === '\\') j += 1; res[j] = ' '; j += 1; } res[i] = ' '; i = j; continue; }
        if (c === '/') { mode = 'code'; res[i] = c; prevSig = c; continue; }
        res[i] = ' '; continue;
      }
      res[i] = ' '; continue;
    }

    // code
    if (c === '/' && src[i + 1] === '/') { mode = 'linec'; res[i] = ' '; i += 1; res[i] = ' '; continue; }
    if (c === '/' && src[i + 1] === '*') { mode = 'blockc'; res[i] = ' '; i += 1; res[i] = ' '; continue; }
    if (c === "'") { mode = 'sq'; res[i] = c; prevSig = c; continue; }
    if (c === '"') { mode = 'dq'; res[i] = c; prevSig = c; continue; }
    if (c === '`') { mode = 'tpl'; res[i] = c; prevSig = c; continue; }
    if (c === '/') {
      if (/[)\]}A-Za-z0-9_$'"`]/.test(prevSig)) { res[i] = c; prevSig = c; continue; } // 除号
      mode = 're'; res[i] = ' '; continue;
    }
    if (c === '{' && interp.length) interp[interp.length - 1] += 1;
    if (c === '}' && interp.length && interp[interp.length - 1] === 0) { interp.pop(); mode = 'tpl'; res[i] = c; prevSig = c; continue; }
    if (c === '}' && interp.length) interp[interp.length - 1] -= 1;
    if (c === '(' || c === '[' || c === '{') { depth += 1; lineNet += 1; }
    if (c === ')' || c === ']' || c === '}') { depth -= 1; lineNet -= 1; }
    res[i] = c;
    if (!/\s/.test(c)) prevSig = c;
  }
  if (netOnLine.length > 0) netOnLine[line - 1] = lineNet;
  for (let k = netOnLine.length; k < line; k += 1) netOnLine[k] = 0;
  return { masked: res.join(''), depthAtStart, netOnLine };
}

/* ═════════════════════════ 2. 形状与上下文工具 ═════════════════════════ */

const RE_NULLISH = /\?\?\s*0(?![\w.])/g;
const RE_OR = /(?<!\|)\|\|\s*0(?![\w.])/g;
/** `.catch(() => 0)` / `.catch(e => 0)` / `.catch(() => [0, 0, 0])` —— 捕获组 1 = 零值字面量 */
const RE_CATCH_ARROW = /\bcatch\s*\(\s*(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(0(?![\w.])|\[[\s\d,.]*0[\s\d,.]*\])/g;
/** `catch {` / `catch (e) {` / `catch(() => {` —— 块体里 `return 0` */
const RE_CATCH_BLOCK = /\bcatch\s*(?:\((?:[^()]|\([^()]*\))*\))?\s*(?:=>\s*)?\{/g;

const PAGINATION_NAME = /^(skip|offset|limit|take|page|pageSize|perPage|pageNum|from|size)$/i;
/** 写/提交类调用名（含 `createOrderLine` / `updateInvoiceLines` 这类域内命名） */
const WRITE_CALL = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|save|submit|patch|put|post)\w*$/;
/** 校验/门禁类调用：兜底值成为**拒绝判定的输入**（G3 的"参与判定"） */
const GATE_CALL = /^(check|assert|validate|verify|guard|ensure|can)[A-Z]\w*$/;
const STATE_WRITE = /^(set[A-Z]\w*|update\w*|assign\w*)$/;
const NUMERIC_COERCE = /^(Number|parseInt|parseFloat|toNumber|int|num)$/;
/** 展示格式化函数：结果只会落到文字（E0-d 的正向证据） */
const FORMATTER = /toFixed\s*\(|toLocaleString\s*\(|Intl\.NumberFormat|format[A-Z]\w*\s*\(|fmt[A-Z]\w*\s*\(|\bmoney\s*\(|\bqtyStr\s*\(/;
const SWALLOW_WRITEISH = /\b(create|createMany|update|updateMany|upsert|delete|deleteMany|save|submit|write|log|audit|notify|emit|send|push)\w*\s*\(/;
const VISIBLE_ERR = /logger\.(error|warn)|console\.(error|warn)|set\w*Error|setError|bdsToast|toast|message\.\w*\(/;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 抹掉不含 `{}` 的 JSX 标签（`<span>` / `</div>` / `<Foo />`），避免把标签尖括号当比较符 */
function dejsx(s) {
  return s
    .replace(/\/>/g, ' ')
    .replace(/<\/?[A-Za-z][\w.-]*(?:\s[^<>{]*)?\/?>/g, ' ');
}

/** 命中右侧（跳过成对闭合括号后）的消费上下文 */
function rightConsumer(post) {
  let k = 0; let bal = 0;
  while (k < post.length) {
    const c = post[k];
    if (c === ' ' || c === '\t') { k += 1; continue; }
    if (c === ')' || c === ']' || c === '}') { bal += 1; k += 1; continue; }
    if (c === '(' || c === '[' || c === '{') { if (bal === 0) break; bal -= 1; k += 1; continue; }
    break;
  }
  const rest = post.slice(k).replace(/^\s+/, '');
  return {
    arith: /^[+\-*/](?![+\-*/=])/.test(rest),
    assign: /^\+=|^\-=|^\*=|^\//.test(rest),
    guard: /^(===|!==|>=|<=|>|<|\?)/.test(rest),
    rest: rest.slice(0, 90),
  };
}

/** 命中左侧是否算术操作数：`sum + (x ?? 0)` / `granted += x || 0` */
function leftIsArithOperand(pre) {
  let t = pre.replace(/\s+$/, '');
  if (/[+\-*/]=$/.test(t)) return true;                 // `x += …` / `x -= …`
  let guard = 0;
  while (/[([{]$/.test(t) && guard < 10) { t = t.slice(0, -1).replace(/\s+$/, ''); guard += 1; }
  if (!t) return false;
  return /[+\-*/]$/.test(t) && !/[=!<>+\-*/%&|^]{2}$/.test(t);
}

/** 最内层未闭合括号（判断"兜底值是不是某个调用的实参"） */
function innermostBracket(ctx, lineIdx, col) {
  let bal = 0;
  let i = lineIdx;
  let j = col;
  while (i >= Math.max(0, lineIdx - 8)) {
    const s = ctx.maskedLines[i] || '';
    while (j >= 0) {
      const c = s[j];
      if (c === ')' || c === ']' || c === '}') bal += 1;
      else if (c === '(' || c === '[' || c === '{') {
        if (bal === 0) {
          const m = /([A-Za-z_$][\w$]*)\s*$/.exec(s.slice(0, j));
          return { name: m ? m[1] : null, isBrace: c === '{', openChar: c, openIdx: j, lineIdx: i };
        }
        bal -= 1;
      }
      j -= 1;
    }
    i -= 1;
    j = (ctx.maskedLines[i] || '').length - 1;
  }
  return { name: null, isBrace: false, openChar: null, openIdx: -1, lineIdx };
}

/** 数字转换调用 `Number(x || 0)` 整体是否是算术操作数（跨括号看左右邻） */
function coerceCallInArith(lineText, openIdx) {
  if (openIdx < 0) return false;
  let bal = 0; let close = -1;
  for (let k = openIdx; k < lineText.length; k += 1) {
    const c = lineText[k];
    if (c === '(') bal += 1;
    else if (c === ')') { bal -= 1; if (bal === 0) { close = k; break; } }
  }
  const before = lineText.slice(0, openIdx).replace(/\s+$/, '');
  const after = close >= 0 ? lineText.slice(close + 1).replace(/^\s+/, '') : '';
  return /[+\-*/]$/.test(before) || /^[+\-*/](?![+\-*/=])/.test(after);
}

/** 从命中向外最多 maxLevels 层括号，收集途经的调用名（判断"是不是某个写调用的入参"） */
function callChain(ctx, lineIdx, col, maxLevels = 8) {
  const names = [];
  let bal = 0;
  let i = lineIdx;
  let j = col;
  let levels = 0;
  while (i >= Math.max(0, lineIdx - 10) && levels < maxLevels) {
    const s = ctx.maskedLines[i] || '';
    while (j >= 0 && levels < maxLevels) {
      const c = s[j];
      if (c === ')' || c === ']' || c === '}') bal += 1;
      else if (c === '(' || c === '[' || c === '{') {
        if (bal === 0) {
          levels += 1;
          const m = /([A-Za-z_$][\w$]*)\s*$/.exec(s.slice(0, j));
          if (m) names.push(m[1]);
          bal = 0;
        } else bal -= 1;
      }
      j -= 1;
    }
    i -= 1;
    j = (ctx.maskedLines[i] || '').length - 1;
  }
  return names;
}

/** `x.reduce((acc, v) => …, init)` 的形参名（识别"累加器种子"） */
function reduceParams(lineText) {
  const m = /\.reduce\s*(?:<[^>]*>)?\s*\(\s*(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/.exec(lineText);
  if (!m) return [];
  return (m[1] || m[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** 命中左操作数的末 token（`(acc ?? 0) + v` ⇒ `acc`） */
function leftToken(pre) {
  const t = pre.replace(/\s+$/, '');
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(t);
  return m ? m[1] : '';
}

/** 命中是否在 `if (…)` / `while (…)` 的**条件括号内** */
function insideCondition(lineText, col) {
  for (const m of lineText.matchAll(/\b(?:if|while)\s*\(/g)) {
    const start = m.index + m[0].length;
    if (start > col) continue;
    let bal = 1; let k = start;
    while (k < lineText.length && bal > 0) {
      if (lineText[k] === '(') bal += 1;
      else if (lineText[k] === ')') bal -= 1;
      k += 1;
    }
    if (k > col) return true;
  }
  return false;
}

/**
 * 语句起点：向上找到"有括号在它这里打开"的行；
 * 同深度的兄弟语句边界（`;` / `}` 结尾）与空行/纯注释行也截断 —— 否则会把**上一条无关语句**的
 * 绑定名安到本次兜底上（实测：`const r = await applyCreditNote(…, { appliedAmount: x ?? 0 })`
 * 曾被归到 `r`，然后 `if (r.ok)` 被当成判定证据 ⇒ 误报 L-A）。
 */
function stmtStartOf(ctx, lineIdx, maxBack = 12) {
  const base = ctx.depthAtStart[lineIdx] ?? 0;
  for (let k = lineIdx - 1; k >= Math.max(0, lineIdx - maxBack); k -= 1) {
    const t = (ctx.maskedLines[k] || '').replace(/\s+$/, '');
    const d = ctx.depthAtStart[k] ?? 0;
    if (d < base) return k;                          // 有括号在 k 行打开 ⇒ 语句从 k 起
    if (d === base && /[;{}]/.test(t.slice(-1))) return k + 1;   // 同层兄弟语句已结束
    if (!t) return k + 1;                            // 空行 / 被抹平的注释行 ⇒ 语义边界
  }
  return Math.max(0, lineIdx - maxBack);
}

/**
 * 窗口尾：默认"离开命中所在括号块"；
 * 传 baseOverride 时可扩到**整个外层块**（绑定名消费点按外层块找 —— B14 的 `if` 在 Promise.all 之后，
 * 只按数组字面量定界就会漏掉它）。
 */
function blockEndOf(ctx, lineIdx, maxFwd = 25, baseOverride = null) {
  const base = baseOverride != null ? baseOverride : (ctx.depthAtStart[lineIdx] ?? 0);
  const n = ctx.netOnLine.length;
  for (let k = lineIdx; k < Math.min(n, lineIdx + maxFwd); k += 1) {
    if (((ctx.depthAtStart[k] ?? 0) + (ctx.netOnLine[k] ?? 0)) < base) return k;
  }
  return Math.min(n - 1, lineIdx + maxFwd);
}

/**
 * 命中所属的绑定名：就近优先（`const x = …`）；
 * 若语句是 `const [a,b,c] = await Promise.all([...])` —— B14 的形状 —— 按**元素下标**归属到正确的那个名，
 * 否则会把 5 个名字都算到每个命中上（张冠李戴）。
 * ★ 命中若在**对象字面量**里（`{ appliedAmount: x ?? 0 }`），不认外层变量的名 ——
 *   那个变量是"调用结果"，兜底值只是它的一个入参，拿它去找消费点必然张冠李戴。
 */
function boundNames(ctx, lineIdx, col = 0) {
  const start = stmtStartOf(ctx, lineIdx);
  const inner = innermostBracket(ctx, lineIdx, col);
  for (let k = lineIdx; k >= start; k -= 1) {
    const t = ctx.maskedLines[k] || '';
    const crossLine = k < lineIdx;
    let m = /\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/.exec(t);
    if (m) {
      if (crossLine && inner.isBrace) continue;
      const names = m[1].split(',').map((raw) => raw.trim().replace(/^:/, '').split(/[\s:=]/)[0])
        .filter((nm) => /^[A-Za-z_$][\w$]*$/.test(nm) && nm !== '_');
      const idx = arrayElementIndex(ctx, k, lineIdx);
      if (names.length > 1 && idx >= 0 && idx < names.length) return [names[idx]];
      if (names.length) return names;
    }
    m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(t);
    if (m) {
      if (crossLine && inner.isBrace && !new RegExp(`${escapeRe(m[1])}\\s*=\\s*\\{\\s*$`).test(t)) continue;
      return [m[1]];
    }
    m = /^\s*([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(t);
    if (m && !['if', 'for', 'while', 'return', 'else'].includes(m[1])) {
      if (crossLine && inner.isBrace) continue;
      return [m[1]];
    }
  }
  return [];
}

/** 数组字面量里第几个元素（数命中之前、同深度的"元素结束"行；B14 用它对上号） */
function arrayElementIndex(ctx, declLine, hitLine) {
  const baseDepth = (ctx.depthAtStart[declLine] ?? 0) + (ctx.netOnLine[declLine] ?? 0);
  let idx = 0;
  for (let k = declLine + 1; k < hitLine; k += 1) {
    const t = (ctx.maskedLines[k] || '').replace(/\s+$/, '');
    if ((ctx.depthAtStart[k] ?? 0) === baseDepth && /,$/.test(t)) idx += 1;
  }
  if ((ctx.maskedLines[hitLine] || '').replace(/\s+$/, '').length && (ctx.depthAtStart[hitLine] ?? 0) === baseDepth) return idx;
  return -1;
}

function enclosingFunctionName(ctx, lineIdx) {
  for (let k = lineIdx; k >= Math.max(0, lineIdx - 40); k -= 1) {
    const t = ctx.rawLines[k] || '';
    let m = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/.exec(t);
    if (m) return m[1];
    m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/.exec(t);
    if (m) return m[1];
  }
  return null;
}

/** 绑定名在块窗口内的消费点：guard | calc | write | payload | rebound */
/** 展示文案键：出现在这些键的**模板串**里的"比较"，是在拼一句话，不是在分支 */
const DISPLAY_KEY = /\b(body|message|title|label|note|text|description|content|summary|tip|hint|sub|meta|placeholder|confirmText|cancelText|caption|tooltip)\s*:\s*`/;

/**
 * 绑定名在块窗口内的消费点：guard | calc | write | payload | rebound
 * ★ 两处防误报：
 *   ① `credit.ok` / `result.error` 这类**取属性**是在判"调用结果信封"，不是判我们这个数 ⇒ 不算守卫；
 *   ② 名字只出现在展示文案模板（`body: \`…${count > 0 ? …}\``）里 ⇒ 归 payload（文字，不是分支）。
 */
function findConsumer(ctx, lineIdx, name, winEnd) {
  const N = escapeRe(name);
  const NM = new RegExp(`(?<![\\w$.])${N}(?![\\w$])`);
  const NOS = `(?<![\\w$.])${N}(?![\\w$])(?!\\s*(?:\\?\\.)?\\.)`; // 非属性访问 = 值本身被用
  const tests = [
    ['guard', new RegExp(`\\b(?:if|while)\\s*\\([^)]*${NOS}`)],
    ['guard', new RegExp(`${NOS}\\s*(?:===?|!==?|>=|<=|>|<)`)],
    ['guard', new RegExp(`(?:>=|<=|>|<|===?|!==)\\s*${NOS}\\b`)],
    ['guard', new RegExp(`\\breturn\\s*\\(?\\s*!?\\s*${NOS}\\b`)],
    ['guard', new RegExp(`\\bthrow\\b[^;]*${NOS}`)],
    ['guard', new RegExp(`${NOS}\\s*\\?[^:]`) ],
    ['calc', new RegExp(`[+\\-*/]\\s*${NOS}`)],
    ['calc', new RegExp(`${NOS}\\s*[+\\-*/](?!=)`)],
    ['calc', new RegExp(`${NOS}\\s*\\+=`)],
    ['write', new RegExp(`\\b(?:create|createMany|update|updateMany|upsert|delete|deleteMany|save|submit|patch|put|post)\\w*\\s*\\((?:[^()]|\\([^()]*\\))*?${NOS}`)],
    ['write', new RegExp(`data:\\s*\\{[^}]*?${NOS}`)],
    ['write', new RegExp(`\\b(?:set[A-Z]\\w*|update\\w*|assign\\w*)\\s*\\((?:[^()]|\\([^()]*\\))*?${NOS}`)],
  ];
  for (let k = lineIdx + 1; k <= winEnd; k += 1) {
    const raw = ctx.maskedLines[k] || '';
    const t = dejsx(raw);
    if (!NM.test(t)) continue;
    // 名字是否只出现在"展示文案模板"的 ${} 里（`body: \`…${count > 0 ? …}\``）
    const rawLineK = ctx.rawLines[k] || '';
    const disp = DISPLAY_KEY.exec(rawLineK);
    const nameAt = rawLineK.search(NM);
    const inDisplayTemplate = !!(disp && nameAt > disp.index + disp[0].length && rawLineK.slice(disp.index, nameAt).includes('${'));
    if (!inDisplayTemplate) {
      for (const [kind, re] of tests) {
        if (re.test(t)) return { kind, line: k + 1, text: (ctx.rawLines[k] || '').trim().slice(0, 130) };
      }
    }
    if (new RegExp(`(?<![\\w$.])${N}(?![\\w$])\\s*=[^=]`).test(t)) return { kind: 'rebound', line: k + 1, text: t.trim().slice(0, 90) };
    if (inDisplayTemplate
      || new RegExp(`[A-Za-z_$][\\w$]*:\\s*(?<![\\w$.])${N}(?![\\w$])\\s*[,}]`).test(t) || /\bres\.json\s*\(/.test(t)) {
      return { kind: 'payload', line: k + 1, text: (ctx.rawLines[k] || '').trim().slice(0, 130) };
    }
  }
  return null;
}

/**
 * **业务量词**（§6 偏差分级的"口径级 = 不报错但算错，最危险"）：
 * 兜底值只有作用在金额/数量/计数/单据号这类**业务量**上，才可能改变账目或拒绝判定。
 * 纯几何/样式/动画/字符串键的兜底不改变任何数字口径 ⇒ 降待核实（不判 L-A，也不硬说它是展示兜底）。
 */
const BUSINESS_TOKEN = /(amount|amt|qty|quantity|total|sum|count|price|cost|balance|due|paid|fee|rate|percent|refund|invoice|shipment|voucher|line|item|weight|meter|metric|limit|credit|tax|discount|applied|received|allocat|headcount|defect|score|diff|gap|varian|version|seq|number|no\b|money|value|price|net|gross|margin|budget|usage|remain|pending|settled|round|batch|piece)/i;
/** 反例：一看就是视觉/几何/键，不参与业务量口径 */
const PURELY_VISUAL = /(width|height|left|top|right|bottom|zindex|opacity|radius|color|colour|duration|delay|easing|angle|rotation|scale|camera|anchor|pixel|margin-?top|key)$/i;

/** 兜底表达式左操作数（`o.quoteAmount ?? 0` ⇒ `o.quoteAmount`；`a?.b ?? 0` ⇒ `a?.b`） */
function leftOperand(pre) {
  const t = pre.replace(/\s+$/, '');
  if (!t) return '';
  let bal = 0;
  let k = t.length - 1;
  while (k >= 0) {
    const c = t[k];
    if (/[)\]}]/.test(c)) bal += 1;
    else if (/[([{]/.test(c)) { if (bal === 0) break; bal -= 1; }
    else if (bal === 0 && /[;,=<>!&|+\-*/:\n]/.test(c)) break;
    else if (bal === 0 && c === '?' && t[k + 1] !== '.') break;   // `?.` 是成员链的一部分，不是三元
    k -= 1;
  }
  return t.slice(k + 1).trim();
}

/** 命中正在赋的对象键（`criticalDefects: x ?? 0` ⇒ `criticalDefects`） */
function assignedKey(plain, col) {
  const before = plain.slice(0, col);
  const m = /([A-Za-z_$][\w$]*)\s*:\s*[^:{}()]*$/.exec(before);
  if (m) return m[1];
  const m2 = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^=]*$/.exec(before);
  return m2 ? m2[1] : '';
}

const isCatch = (hit) => hit.shape === 'catch';

/* ══════════════════════════ 3. 分类器 ══════════════════════════ */

function classify(hit, ctx) {
  const maskedLine = ctx.maskedLines[hit.lineIdx] || '';
  const rawLine = ctx.rawLines[hit.lineIdx] || '';
  const plain = dejsx(maskedLine);
  const isServer = hit.group === 'server';
  const stmtFrom = stmtStartOf(ctx, hit.lineIdx);
  const winEnd = blockEndOf(ctx, hit.lineIdx, 30, ctx.depthAtStart[stmtFrom] ?? 0);
  const stmtText = ctx.maskedLines.slice(stmtFrom, Math.min(winEnd, stmtFrom + 12) + 1).join(' ');
  const names = hit.names.filter((n) => n && n !== hit.catchFn);

  const pre = maskedLine.slice(0, hit.col);
  const post = maskedLine.slice(hit.col + hit.matchLen);
  const preT = pre.replace(/\s+$/, '');
  const rc = rightConsumer(post);
  const call = innermostBracket(ctx, hit.lineIdx, hit.col);
  const callName = call.name;
  /** 途经的调用链（最多 8 层）：`createOrderLine({ quantity: Number(q || 0) })` 的兜底也是写载荷兜底 */
  const chain = callChain(ctx, hit.lineIdx, hit.col);
  const ancestorWrite = chain.some((n) => WRITE_CALL.test(n) || /Decimal$/.test(n));
  const ancestorGate = chain.some((n) => GATE_CALL.test(n));
  const isWriteCall = !!callName && WRITE_CALL.test(callName);
  const isDecimal = !!callName && /Decimal$/.test(callName);
  const isStateCall = !!callName && STATE_WRITE.test(callName);
  const inDataPayload = call.isBrace && /\bdata\s*:\s*\{/.test(plain);
  const coerced = !!callName && NUMERIC_COERCE.test(callName);
  const fmtWrap = FORMATTER.test(maskedLine);
  const nearJsx = /<\/?[A-Za-z][\w.-]*|\/>/.test(ctx.rawLines.slice(Math.max(0, hit.lineIdx - 3), hit.lineIdx + 2).join('\n'));
  const inJsxInterp = /\{[^{}]*$/.test(pre) && nearJsx;
  const condGate = insideCondition(plain, hit.col) || rc.guard;
  const arith = leftIsArithOperand(pre) || rc.arith || (coerced && coerceCallInArith(maskedLine, call.openIdx))
    || (/\breduce\s*\(/.test(plain) && /[+\-]/.test(plain));
  const writeHere = isWriteCall || ancestorWrite || isDecimal || inDataPayload || (isStateCall && !isServer);
  /** 兜底作用的对象（左操作数 + 绑定名 + 被赋的键）是不是**业务量** */
  const subject = [leftOperand(pre), names.join(' '), assignedKey(plain, hit.col)].filter(Boolean).join(' ');
  const business = BUSINESS_TOKEN.test(subject) && !PURELY_VISUAL.test(subject);
  /** 定罪：既有流向证据、又作用在业务量上，才算 L-A（否则降待核实，不硬说它是展示兜底） */
  const verdict = (rule, why) => (business || isCatch(hit)
    ? { cls: 'L-A', rule, why }
    : { cls: '待核实', rule: 'E5-nonbusiness', why: `有${rule === 'E1' || rule === 'E1-inline' ? '判定' : rule.startsWith('E3') ? '写' : '算术'}流向，但兜底作用对象 \`${subject.slice(0, 40) || '(无名表达式)'}\` 不属业务量（金额/数量/计数/单号）⇒ 不改变账目口径，按 §6 分级不列 L-A；是否纯显示待人工确认` });

  /* ─────────── E0 语义零豁免（先于定罪，防误报） ─────────── */
  if (/fallback:display/.test(rawLine)) {
    return { cls: 'L-B', rule: 'E0-a', why: '就地豁免注释 `// fallback:display`（G3 配套机制要求的形式）' };
  }
  {
    const pag = names.find((n) => PAGINATION_NAME.test(n));
    if (pag && !condGate && !writeHere && !arith) {
      return { cls: 'L-B', rule: 'E0-b', why: `绑定名 ${pag} = 分页/偏移默认值 ⇒ 消费点是 skip/take，不参与金额与判定（G3 原文归展示兜底）` };
    }
  }
  if (!isCatch(hit)) {
    const accParam = reduceParams(plain)[0];
    const isSeedTarget = /\.get\s*\([^)]*\)\s*$/.test(preT) || /\[[^\]]+\]\s*$/.test(preT)
      || (!!accParam && leftToken(pre) === accParam);
    if (isSeedTarget && (rc.arith || rc.assign || /^\s*\+\s*[\w$]/.test(post))) {
      return { cls: 'L-B', rule: 'E0-c', why: '聚合/计数**种子**（分组首键 / 空集求和 = 真零，不是把未知伪造成 0）—— 若该键缺失实为"金额未知"则本条漏报，见边界章节' };
    }
    // 单调计数器：`(usageCount ?? 0) + 1` / `(last?.version ?? 0) + 1` —— "此前无记录"就是 0 次/0 版
    if (/^\+\s*1(?![\d.\w])/.test(rc.rest) && /^[A-Za-z_$][\w$.?[\]]*$/.test(leftOperand(pre))) {
      return { cls: 'L-B', rule: 'E0-c2', why: `计数器/版本号自增种子 \`(${leftOperand(pre).slice(0, 30)} ?? 0) + 1\` ⇒ "此前无记录 = 0" 属业务零值（G3 配套机制里可就地注释豁免的那类）` };
    }
  }
  // 排序比较器里的减法：只影响顺序，不改变任何数额 ⇒ 不判 L-A（需要人看的是"缺数是否该报错"）
  if (!isCatch(hit) && (chain.includes('sort') || chain.includes('toSorted')) && !writeHere) {
    return { cls: '待核实', rule: 'E4-sortkey', why: `兜底值只出现在排序比较器里（影响顺序不影响数额/写）⇒ 不列 L-A；若缺数本身该报错，属 G3.1 待人工定` };
  }
  if (!isServer && !writeHere) {
    const lenGate = !isCatch(hit) && /\.length\s*$/.test(preT) && />|===?\s*0/.test(rc.rest) && nearJsx;
    if ((fmtWrap || inJsxInterp || lenGate) && !insideCondition(plain, hit.col)) {
      return { cls: 'L-B', rule: 'E0-d', why: lenGate
        ? '`.length ?? 0 > 0` 只决定区块是否渲染 ⇒ 按 G3"仅用于显示"归 L-B（未加载会伪装成空态，属 G3.4 显示层缺陷而非数据缺陷 —— 见边界章节）'
        : 'JSX 插值 / 展示格式化内的兜底，同区域无写 ⇒ 按 G3"仅用于显示"归 L-B（若该数被复制进单据/导出则应升 L-A —— 见边界章节）' };
    }
  }

  /* ─────────── catch 专属（两条"明确不判红"的分支） ─────────── */
  if (isCatch(hit)) {
    if (hit.catchSwallowsWrite) {
      return { cls: '待核实', rule: 'E4-swallow-write', why: 'catch 挂在写/审计调用本身 ⇒ **吞掉写失败**，兜底 0 未被消费。属 G4 写失败可见性，不在本判据"值参与判定"口径内 ⇒ 需人工定性' };
    }
    if (hit.catchVisibleError) {
      return { cls: '待核实', rule: 'E4-logged', why: 'catch 块内已有可见错误处理（logger.error / setError / toast）⇒ 非静默；按 G3 现状①的教训不直接判红' };
    }
    if (hit.catchFn) {
      const callRe = new RegExp(`\\b${escapeRe(hit.catchFn)}\\s*\\(`);
      let firstCall = null;
      for (let k = 0; k < ctx.maskedLines.length; k += 1) {
        if (k === hit.lineIdx) continue;
        const t = ctx.maskedLines[k];
        if (!callRe.test(t)) continue;
        // 跳过定义行本身（`function num(` / `const num = (` —— 否则会把"没找到调用点"误判成找到了）
        if (new RegExp(`\\bfunction\\s+${escapeRe(hit.catchFn)}\\s*\\(`).test(t)
          || new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(hit.catchFn)}\\s*=\\s*(?:async\\s*)?(?:\\(|function|[A-Za-z_$][\\w$]*\\s*=>)`).test(t)) continue;
        if (firstCall == null) firstCall = k;
        if (new RegExp(`[+\\-*/]\\s*${escapeRe(hit.catchFn)}\\s*\\(`).test(t)
          || new RegExp(`${escapeRe(hit.catchFn)}\\s*\\([^()]*\\)\\s*[+\\-*/]`).test(t)
          || new RegExp(`\\b(?:if|while)\\s*\\([^)]*${escapeRe(hit.catchFn)}\\s*\\(`).test(t)) {
          return { cls: 'L-A', rule: 'E2-fn', why: `兜底函数 ${hit.catchFn}() 在 ${ctx.rel}:${k + 1} 的返回值直接进入算式/门禁 ⇒ 异常时那个 0 被当真实数值使用：${(ctx.rawLines[k] || '').trim().slice(0, 110)}` };
        }
      }
      if (firstCall != null) {
        return { cls: '待核实', rule: 'E4-fn', why: `兜底函数 ${hit.catchFn}() 有调用点（${ctx.rel}:${firstCall + 1}），但消费方式未证实（不在算式/门禁里直接出现）—— 跨函数数据流本脚本不做` };
      }
      return { cls: '待核实', rule: 'E4-fn-nocall', why: `兜底函数 ${hit.catchFn}() 在本文件内未见调用点` };
    }
  }

  /* ─────────── E1/E2/E3：绑定名在块窗口内的消费点 ─────────── */
  let payloadHint = null;
  for (const n of names) {
    const c = findConsumer(ctx, hit.lineIdx, n, winEnd);
    if (!c) continue;
    if (c.kind === 'payload') { payloadHint = c; continue; }
    if (c.kind === 'rebound') continue;
    if (c.kind === 'guard') return verdict('E1', `${n} 被 ${ctx.rel}:${c.line} 的判定消费 ⇒ 失败方向由该判定决定：${c.text}`);
    if (c.kind === 'write') return verdict('E3', `${n} 被 ${ctx.rel}:${c.line} 的写/提交载荷消费：${c.text}`);
    if (c.kind === 'calc') return verdict('E2', `${n} 被 ${ctx.rel}:${c.line} 的算术消费（兜底 0 参与计算）：${c.text}`);
  }

  /* ─────────── 就地表达式证据 ─────────── */
  if (writeHere) {
    return verdict('E3-inline', `兜底值直接是写/提交实参（最内层 \`${callName || 'data:'}\`）⇒ 缺失即把 0 写进载荷/库：${rawLine.trim().slice(0, 120)}`);
  }
  if (condGate) {
    return verdict('E1-inline', `兜底值在同一条比较/门禁里被消费（${insideCondition(plain, hit.col) ? '位于 if/while 条件内' : `右邻 \`${rc.rest.slice(0, 12)}\``}）⇒ 空值被当成"零个/零元"参与判定：${rawLine.trim().slice(0, 120)}`);
  }
  if (ancestorGate) {
    return verdict('E1-gate', `兜底值是**校验/门禁调用**的入参（\`${chain.find((n) => GATE_CALL.test(n))}\`）⇒ 缺失值以 0 参与"能不能过"的判断：${rawLine.trim().slice(0, 120)}`);
  }
  if (arith) {
    return verdict('E2-inline', `兜底值是 + - * / 或 += 的操作数（reduce 求和项 / 加总）⇒ 缺失项按 0 计入结果：${rawLine.trim().slice(0, 120)}`);
  }
  if (isCatch(hit)) {
    if (!names.length) {
      return { cls: '待核实', rule: 'E4-catch-nobind', why: 'catch→0 吞掉异常，但兜底值未见绑定、同块内未见判定/计算/写 ⇒ 无法就地定罪' };
    }
    if (payloadHint) return { cls: '待核实', rule: 'E4-catch-payload', why: `catch→0 的值仅出现在出参字面量（${ctx.rel}:${payloadHint.line}）⇒ 客户端拿它算不算数未验证` };
    return { cls: '待核实', rule: 'E4-catch', why: 'catch→0 吞掉异常；绑定值在同块内未进入判定/计算/写（消费点在函数外或跨文件）' };
  }
  if (payloadHint) return { cls: '待核实', rule: 'E4-payload', why: `值仅出现在出参/对象字面量（${ctx.rel}:${payloadHint.line}）⇒ 无法证明调用方只拿它显示（跨函数/跨端消费本脚本不追）` };
  if (isServer && !names.length) return { cls: '待核实', rule: 'E4-server-inline', why: `服务端就地表达式，未见判定/计算/写上下文（片段：${(hit.matched || '').slice(0, 40)}）⇒ 不猜` };
  return { cls: '待核实', rule: 'E4', why: `拿不出局部证据（绑定名 ${names.join('/') || '无'} 在同块窗口内未见判定/计算/写）⇒ 按 §0.4 归待核实` };
}

/* ═══════════════════════ 4. 扫描（真实源码 / 内存样本共用） ═══════════════════════ */

function analyze(src, rel, group) {
  const { masked, depthAtStart, netOnLine } = maskAndDepth(src);
  const rawLines = src.split('\n');
  const maskedLines = masked.split('\n');
  const ctx = { rel, group, rawLines, maskedLines, depthAtStart, netOnLine };
  const hits = [];
  const push = (k, col, shape, matchLen, extra = {}) => hits.push({
    rel, group, lineIdx: k, line: k + 1, col, shape, matchLen,
    matched: (rawLines[k] || '').slice(col, col + Math.max(matchLen, 6)).trim(),
    names: boundNames(ctx, k, col),
    ...extra,
  });

  for (let k = 0; k < maskedLines.length; k += 1) {
    const t = maskedLines[k];
    if (!t) continue;

    for (const [re, shape] of [[RE_NULLISH, 'nullish'], [RE_OR, 'or']]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t)) !== null) push(k, m.index, shape, m[0].length);
    }

    RE_CATCH_ARROW.lastIndex = 0;
    let cm;
    while ((cm = RE_CATCH_ARROW.exec(t)) !== null) {
      if (cm[1] && !/^[\s[\],0]*$/.test(cm[1])) continue;
      const b = t.slice(0, cm.index);
      push(k, cm.index, 'catch', cm[0].length, {
        catchSwallowsWrite: SWALLOW_WRITEISH.test(b.slice(-220)),
        catchVisibleError: false, catchFn: null,
      });
    }

    RE_CATCH_BLOCK.lastIndex = 0;
    let bm;
    while ((bm = RE_CATCH_BLOCK.exec(t)) !== null) {
      const end = blockEndOf(ctx, k, 40);
      const body = maskedLines.slice(k, end + 1).join('\n');
      const mRet = /\breturn\s+0(?![\w.])/.exec(body);
      if (!mRet) continue;
      if (/\bthrow\b\s*[([{]/.test(body.slice(0, mRet.index))) continue; // 抛错前不算兜底
      push(k, bm.index, 'catch', bm[0].length, {
        catchSwallowsWrite: false,
        catchVisibleError: VISIBLE_ERR.test(body),
        catchFn: enclosingFunctionName(ctx, k),
      });
    }
  }

  for (const h of hits) { const r = classify(h, ctx); h.cls = r.cls; h.rule = r.rule; h.why = r.why; }
  return hits;
}

function scanFile(entry) {
  const abs = path.join(ROOT, entry.rel);
  let src = '';
  try { src = fs.readFileSync(abs, 'utf8'); } catch { return []; }
  if (!/\?\?\s*0|\|\|\s*0|catch/.test(src)) return [];
  return analyze(src, entry.rel, entry.group);
}

/* ═══════════════ 5. 自测（G6.3：用故意放在盲区的写法撞分类器） ═══════════════ */

const SAMPLES = [
  {
    name: 'S1 守卫路径 catch→0（B14 同形：依赖计数失败 ⇒ 拒删守卫放行）',
    group: 'server', file: 'sample-guard.ts', expectShape: 'catch', want: 'L-A',
    src: `async function deleteOrder(tx, orderId) {
  const [invoiceCount, voucherCount] = await Promise.all([
    tx.invoice.count({ where: { orderId } }).catch(() => 0),
    tx.paymentVoucher.count({ where: { orderId } }).catch(() => 0),
  ]);
  if (invoiceCount > 0 || voucherCount > 0) {
    throw new Error('HAS_DEPENDENTS');
  }
  await tx.order.update({ where: { id: orderId }, data: { deletedAt: 1 } });
}
`,
    note: '期望 L-A/E1 —— 兜底 0 被 if 判定消费 ⇒ 失败方向 = 放行',
  },
  {
    name: 'S2 纯渲染 ?? 0（JSX 文本里的计数/金额展示）',
    group: 'frontend', file: 'SampleView.tsx', expectShape: 'nullish', want: 'L-B',
    src: `export function SampleView({ stat }) {
  return (
    <div className="card">
      <span className="num">{stat.pendingCount ?? 0}</span>
      <p>合计 {Number(stat.amount ?? 0).toLocaleString('zh-CN')} 元</p>
    </div>
  );
}
`,
    note: '期望 L-B/E0-d —— 只在 JSX 插值里出现，同区域无门禁/无写',
  },
  {
    name: 'S3 缺失值回落 0 后喂 if 判定（|| 0 → 门禁失效方向）',
    group: 'server', file: 'sample-if.ts', expectShape: 'or', want: 'L-A',
    src: `function canShip(order) {
  const allocated = Number(order.allocatedQty || 0);
  if (allocated >= order.qty) return true;
  return false;
}
`,
    note: '期望 L-A/E1 —— 未分配量被读成已分配（出运门禁被削弱）',
  },
  {
    name: 'S4 注释与字符串里的 catch(()=>0) / ?? 0 / || 0 不算违例',
    group: 'server', file: 'sample-comment.ts', expectShape: '*', want: 'L-B', zeroExpected: true,
    src: `// 历史教训：不要写 .catch(() => 0) 这种兜底
/* 也别学 ?? 0 和 || 0 */
const tip = '模板文案里提到 ?? 0 只是字符串，不是代码';
function ok(a) {
  return a;
}
`,
    note: '期望 0 命中 —— 注释/字符串内容必须在匹配前抹掉（本仓踩过的假红）',
  },
  {
    name: 'S5 兜底值直接进写载荷（new Prisma.Decimal(x ?? 0)）',
    group: 'server', file: 'sample-write.ts', expectShape: 'nullish', want: 'L-A',
    src: `await prisma.productAsset.create({
  data: { cost: new Prisma.Decimal(body.cost ?? 0), name: body.name },
});
`,
    note: '期望 L-A/E3 —— 缺失金额以 0 落库',
  },
  {
    name: 'S6 catch→0 后事务继续写（G3 明列形状）',
    group: 'server', file: 'sample-continue-write.ts', expectShape: 'catch', want: 'L-A',
    src: `async function main(prisma, orderId) {
  const n = await prisma.invoice.count({ where: { orderId } }).catch(() => 0);
  await prisma.order.update({ where: { id: orderId }, data: { note: 'x' + n } });
}
`,
    note: '期望 L-A —— 吞异常后事务继续写',
  },
  {
    name: 'S7 分页默认值不得判红（反证：分类器不是"什么都判 L-A"）',
    group: 'server', file: 'sample-page.ts', expectShape: 'nullish', want: 'L-B',
    src: `export async function list(params) {
  const skip = params.offset ?? 0;
  const take = params.limit ?? 0;
  return prisma.order.findMany({ skip, take });
}
`,
    note: '期望 L-B/E0-b —— 若这条被判 L-A，说明分类器只会报红（空转的另一半）',
  },
  {
    name: 'S8 catch 内已记录错误 ⇒ 不判红（G3 现状①"一律判红会误报"）',
    group: 'server', file: 'sample-logged.ts', expectShape: 'catch', want: '待核实',
    src: `async function sweep(ids) {
  try {
    return await prisma.notification.deleteMany({ where: { id: { in: ids } } });
  } catch (e) {
    logger.error('[sweep] failed', { ids, error: e?.message });
    return 0;
  }
}
`,
    note: '期望 待核实/E4-logged —— 有可见错误处理，不是静默兜底',
  },
  {
    name: 'S9 reduce 求和里 Number(x || 0) ⇒ 缺失金额按 0 计入总额',
    group: 'frontend', file: 'SampleTotals.tsx', expectShape: 'or', want: 'L-A',
    src: `export function SampleTotals({ recv }) {
  const ar = recv.reduce((s, i) => s + Number(i.amount || 0), 0);
  return <div>{ar}</div>;
}
`,
    note: '期望 L-A/E2 —— 参与加总（即使结果显示，数值已经错了；G1.4 跨页一致同源）',
  },
  {
    name: 'S10 聚合种子 `(m.get(k) ?? 0) + v` 不判红（E0-c）',
    group: 'server', file: 'sample-seed.ts', expectShape: 'nullish', want: 'L-B',
    src: `export function groupTotals(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.k, (m.get(r.k) ?? 0) + r.v);
  return m;
}
`,
    note: '期望 L-B/E0-c —— 分组首键 = 真零，不是伪造（判它 L-A 就是误报）',
  },
  {
    name: 'S11 非业务量（几何）兜底不得判红（E5 业务量闸门）',
    group: 'frontend', file: 'SampleGeom.tsx', expectShape: 'nullish', forbid: 'L-A',
    src: `export function SampleGeom({ panel, next }) {
  const sameSize = Math.abs((panel.width ?? 0) - next.width) < 0.5;
  return <div style={{ left: (panel.left ?? 0) + 8 }}>{sameSize ? 'a' : 'b'}</div>;
}
`,
    note: '期望 待核实/E5 —— 有算术流向，但兜底作用在几何量上 ⇒ 不改账目口径；判它 L-A 就是误报',
  },
];

function runSelfCheck() {
  console.log('═══ G6.3 分类器自测：把故意放的写法撞进去（撞不出来 = 分类器空转）═══\n');
  let fails = 0;
  for (const s of SAMPLES) {
    const hits = analyze(s.src, s.file, s.group);
    if (s.zeroExpected) {
      const ok = hits.length === 0;
      console.log(`  ${ok ? '✓' : '✗'} ${s.name}`);
      console.log(`    ${s.note}`);
      console.log(`    实际命中 ${hits.length}（期望 0）${ok ? '' : ' ← ★ 注释/字符串未抹除 ⇒ 会造假红：' + hits.map((h) => `${h.line}:${h.matched}`).join(', ')}`);
      if (!ok) fails += 1;
      continue;
    }
    const rel = hits.filter((h) => s.expectShape === '*' || h.shape === s.expectShape);
    const ok = rel.length > 0 && (s.forbid ? rel.every((h) => h.cls !== s.forbid) : rel.every((h) => h.cls === s.want));
    console.log(`  ${ok ? '✓' : '✗'} ${s.name}`);
    console.log(`    ${s.note}`);
    if (!rel.length) console.log('    ★ 该形状没产生任何命中 ⇒ 自测无效（分类器没看见样本）');
    for (const h of rel) {
      console.log(`    实际 ${h.cls} / ${h.rule} @${h.line} \`${h.matched}\`${ok ? '' : ` ← 期望 ${s.forbid ? '非 ' + s.forbid : s.want}`} · ${h.why.slice(0, 92)}`);
    }
    if (!ok) fails += 1;
  }
  console.log('');
  console.log(fails
    ? `❌ 自测失败 ${fails}/${SAMPLES.length} —— 分类器结论不可信，本清单不得当判据使用`
    : `✅ 自测 ${SAMPLES.length}/${SAMPLES.length} 通过：守卫/写/算术形状咬得住，渲染/分页/种子不误红，注释不假红 ⇒ 分类器非空转`);
  // ★ 与文件末尾同一处修法（B78）：这里原先也 process.exit ⇒ --selfcheck 的这段报告在管道下会被截断。
  //   改成都把退出码交回 main()，由 process.exitCode 承接。
  return fails ? 1 : 0;
}

/* ══════════════════════════ 6. 基线 / 主流程 ══════════════════════════ */

/**
 * ★ L-B 基线（沿用 scripts/check-design-tokens.sh 的"基线计数 + 只允许下降"口径，不另造一套）
 *
 *   取样 2026-09-20 03:36 · 命令 `node scripts/check-fail-open-inventory.mjs --print-baseline`
 *   当时实测：命中 734 = L-A 196 · **L-B 171** · 待核实 367（L-B 分组 server 91 / 前端 78 / portal 2）
 *   ⚠️ 基线冻结的是 **L-B**；L-A 判据恒为 0（不接受基线）。
 *   ⚠️ 重跑前须先清零 L-A，否则退出码 1 来自 L-A 而不是基线漂移。
 *
 * ★★ v2.53 把这把尺接进仓根门禁时撞到的那对矛盾（自裁口径见台账 **D94**）：
 *   「L-A 必须为 0」是**判据**，可现存 191 处未清 ⇒ 直接把本脚本挂进门禁 = **永久红**，
 *   而"永久红的门禁"等于没有门禁（下一批会顺手把它 skip 掉）。
 *   解法**不是放宽判据**（§0.1 明令禁止"放宽判据使其变绿"），而是把两件事拆开：
 *     · **判据**（G3 表里的"必须为 0"）留在台账上，本脚本仍原样打印"未达标 N 处"；
 *     · **棘轮**（防回退）进门禁：`la` 与 `lb` 都按"只允许下降"判 ⇒ 新增一处 L-A 当场红。
 *   ⇒ 代价如实写明：**现存 191 处不会拦住任何新代码**（它们本来也没被拦），
 *     棘轮换来的是"从今天的读数起不许变多" + 有守卫消费这把尺（此前全仓无人调用 ⇒ 它可以静默瞎掉）。
 *   取样 2026-09-22 23:45 · 同命令实测：命中 730 = L-A **191** · L-B **171** · 待核实 368 · 扫描 792 文件 · 未覆盖分组 []
 *
 * ★★ v2.57：冻结值搬到 `scripts/baselines/g3-fail-open.json`，**不再写在这里**。
 *   原因（独立复核实测，台账 B81）：上面那句"只允许下降"是**注释不是判据** ——
 *   把 `la` 改成 300 之后，退出码仍 0、四条守卫断言仍全绿 ⇒ "棘轮有牙齿"当时是假话。
 *   搬进独立文件才谈得上牙齿：守卫对**这个文件的 git 历史**断言"序列非递增"，
 *   上调 = 历史里留下一条上升的记录 = 当场红（不是靠人自觉）。
 *   ★ fail-closed：文件读不到 / JSON 解析不了 / 数字缺失 ⇒ `la`/`lb` 为 null，
 *     走下面已有的"基线被置空 = 门禁失效"分支红掉，**不退回任何内置默认值**（那又是一份并行真源）。
 */
const BASELINE_FILE = path.join(ROOT, 'scripts', 'baselines', 'g3-fail-open.json');
function loadBaseline() {
  const bad = (why) => {
    console.error(`❌ 棘轮基线不可用 ⇒ 按"门禁失效"处理（不退回到内置默认值）：${why}`);
    return { lb: null, la: null };
  };
  let raw;
  try { raw = fs.readFileSync(BASELINE_FILE, 'utf8'); } catch (e) {
    return bad(`读不到 ${path.relative(ROOT, BASELINE_FILE)}：${e.message}`);
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) { return bad(`${path.relative(ROOT, BASELINE_FILE)} 不是合法 JSON：${e.message}`); }
  if (typeof j.la !== 'number' || typeof j.lb !== 'number') return bad('la/lb 必须都是数字');
  return { lb: j.lb, la: j.la };
}
const BASELINE = loadBaseline();
/** G3 的零容忍判据本身 —— 不参与退出码，只参与打印（不参与 = 明说，不许悄悄降标准） */
const TARGET = { la: 0 };

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck')) return runSelfCheck();
  /** --debug <相对路径>:<行号> —— 打印该命中的分析中间量（评审时用来复核分类器的推理） */
  const dbg = argv.find((a) => a.startsWith('--debug='));
  if (dbg) {
    const [rel, ln] = dbg.split('=')[1].split(':');
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const { masked, depthAtStart, netOnLine } = maskAndDepth(src);
    const rawLines = src.split('\n');
    const maskedLines = masked.split('\n');
    const ctx = { rel, group: rel.startsWith('server/') ? 'server' : 'frontend', rawLines, maskedLines, depthAtStart, netOnLine };
    const k = Number(ln) - 1;
    let found = 0;
    for (const [re, shape] of [[RE_NULLISH, 'nullish'], [RE_OR, 'or'], [RE_CATCH_ARROW, 'catch'], [RE_CATCH_BLOCK, 'catch']]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(maskedLines[k] || '')) !== null) {
        found += 1;
        const hit = { rel, group: ctx.group, lineIdx: k, line: k + 1, col: m.index, shape, matchLen: m[0].length, matched: m[0], names: boundNames(ctx, k, m.index), catchSwallowsWrite: false, catchVisibleError: false, catchFn: null };
        const r = classify(hit, ctx);
        console.log(`\n${rel}:${ln} [${shape}] \`${m[0]}\``);
        console.log(`  masked  : ${maskedLines[k]}`);
        console.log(`  names   : ${JSON.stringify(hit.names)}   stmtStart=${stmtStartOf(ctx, k) + 1} 块尾=${blockEndOf(ctx, k, 30, ctx.depthAtStart[stmtStartOf(ctx, k)] ?? 0) + 1}`);
        console.log(`  inner   : ${JSON.stringify(innermostBracket(ctx, k, m.index))}  chain=${JSON.stringify(callChain(ctx, k, m.index))}`);
        console.log(`  pre/post: ${JSON.stringify(maskedLines[k].slice(0, m.index))} ⏐ ${JSON.stringify(maskedLines[k].slice(m.index + m[0].length))}`);
        console.log(`  flags   : rc=${JSON.stringify(rightConsumer(maskedLines[k].slice(m.index + m[0].length)))} leftOperand=${JSON.stringify(leftOperand(maskedLines[k].slice(0, m.index)))} arith=${leftIsArithOperand(maskedLines[k].slice(0, m.index))} seedTarget=${/\.get\s*\([^)]*\)\s*$/.test(maskedLines[k].slice(0, m.index).replace(/\s+$/, '')) || /\[[^\]]+\]\s*$/.test(maskedLines[k].slice(0, m.index).replace(/\s+$/, ''))}`);
        console.log(`  ⇒ ${r.cls} / ${r.rule}  ${r.why}`);
      }
    }
    if (!found) console.log(`${rel}:${ln} 该行没有形状命中（检查行号 / 是否在注释里）`);
    return 0;
  }
  const asJson = argv.includes('--json');
  const compareToBaseline = argv.includes('--baseline');
  const printBaseline = argv.includes('--print-baseline');
  const showArg = argv.find((a) => a.startsWith('--show='));
  const show = (showArg || '--show=all').split('=')[1];

  const { files, missing } = collectFiles();
  /**
   * `--lb=<n>` / `--la=<n>` 临时覆盖基线（只为验证"改坏会咬红"，不改文件里的冻结值）。
   * ★ 必须校验输入：`Number('abc')` = NaN，而 `171 > NaN` 与 `NaN >= 0` **都是 false** ⇒
   *   打错一个字符就等于**关掉棘轮还照样退出 0**（v2.53 自己埋的洞，本批复核 B81 时自查出来）。
   */
  const applyOverride = (flagName, key) => {
    const arg = argv.find((a) => a.startsWith(`${flagName}=`));
    if (!arg) return;
    const raw = arg.split('=')[1];
    const n = Number(raw);
    if (!/^\d+$/.test(String(raw).trim()) || !Number.isFinite(n)) {
      // ★ 这里**不能**用 diag()：它是本函数 1100+ 行之后才 const 出来的（TDZ）⇒
      //   失败出口一旦被触发就会抛 ReferenceError 而不是"红着退出"。守卫里有断言钉住这条路径。
      console.error(`❌ ${flagName}=<非负整数> 才合法，收到 ${JSON.stringify(raw)} ⇒ 拒绝执行`);
      console.error('   原因：NaN 参与比较恒为 false，"基线写错"会表现成"棘轮通过" —— 那等于把门禁关掉');
      process.exitCode = 2; return 2;
    }
    BASELINE[key] = n;
  };
  if (applyOverride('--lb', 'lb') === 2) return 2;
  if (applyOverride('--la', 'la') === 2) return 2;
  const hits = [];
  const scanned = { server: 0, frontend: 0, portal: 0 };
  for (const e of files) { scanned[e.group] += 1; for (const h of scanFile(e)) hits.push(h); }
  hits.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);

  const by = (cls) => hits.filter((h) => h.cls === cls);
  const la = by('L-A'); const lb = by('L-B'); const todo = by('待核实');
  const bg = (g, arr) => arr.filter((h) => h.group === g).length;
  const fmtG = (arr) => `server ${bg('server', arr)} · 前端 ${bg('frontend', arr)} · portal ${bg('portal', arr)}`;

  if (printBaseline) {
    const d = new Date().toISOString().slice(0, 16).replace('T', ' ');
    console.log(`// 取样 ${d} · node scripts/check-fail-open-inventory.mjs --print-baseline`);
    // 直接打印**基线文件该长什么样**（v2.57）：旧版打印的是 `const BASELINE = {...}` 源码行，
    // 搬家之后照抄那行会写回一个不被读取的地方 ⇒ 现在与 scripts/baselines/g3-fail-open.json 同构。
    console.log(JSON.stringify({
      _sampledAt: d,
      _measured: `命中 ${hits.length} = L-A ${la.length} · L-B ${lb.length} · 待核实 ${todo.length} · 扫描 ${files.length} 文件 · 未覆盖分组 ${JSON.stringify(missing)}`,
      lb: lb.length,
      la: la.length,
    }, null, 2));
    console.log(`// ↑ 存进 scripts/baselines/g3-fail-open.json（数字只许 ≤ 现值，守卫会走 git 历史核对非递增）；G3 判据 TARGET.la = 0 不接受基线`);
    return 0;
  }

  const title = {
    'L-A': 'L-A 零容忍（写路径/守卫路径兜底）—— 判据：必须为 0',
    'L-B': 'L-B 基线化（展示/分页/聚合种子）—— 判据：只允许下降',
    待核实: '待核实（分类器拿不出局部证据，按 §0.4 不猜）',
  };
  const printer = (arr, cls) => {
    const key = { 'L-A': 'la', 'L-B': 'lb', 待核实: 'todo' }[cls];
    if (show !== 'all' && show !== key) return;
    console.log(`\n── ${title[cls]}（${arr.length}）`);
    for (const h of arr) {
      console.log(`  ${h.rel}:${h.line}  [${h.rule} ${h.shape}]  \`${h.matched}\``);
      console.log(`      ↳ ${h.why}`);
    }
    if (!arr.length) console.log('    （无命中）');
  };

  if (!asJson) {
    console.log('═══ G3 fail-open 存量清单（L-A / L-B / 待核实 分离）═══');
    console.log(`覆盖：server/src ${scanned.server} 文件 · 前端主应用 ${scanned.frontend} · customer-portal/src ${scanned.portal}（合计 ${files.length}；测试/node_modules/构建产物/注释/字符串已排除）`);
    if (missing.length) console.log(`未覆盖：${missing.join(' · ')}`);
  }

  if (asJson) {
    console.log(JSON.stringify({
      filesScanned: files.length, scanned, missing,
      totals: { all: hits.length, 'L-A': la.length, 'L-B': lb.length, '待核实': todo.length },
      /** ★ v2.53：棘轮与判据一起进 JSON ⇒ 守卫不必再去解析脚本文本（也不许把基线 null 掉来变绿） */
      baseline: { ...BASELINE }, target: { ...TARGET },
      byGroup: Object.fromEntries(['server', 'frontend', 'portal'].map((g) => [g, {
        'L-A': bg(g, la), 'L-B': bg(g, lb), '待核实': bg(g, todo),
      }])),
      ruleDist: hits.reduce((m, h) => { m[`${h.cls}/${h.rule}`] = (m[`${h.cls}/${h.rule}`] || 0) + 1; return m; }, {}),
      hits: hits.map((h) => ({ file: h.rel, group: h.group, line: h.line, shape: h.shape, matched: h.matched, cls: h.cls, rule: h.rule, why: h.why })),
    }, null, 2));
  } else {
    printer(la, 'L-A'); printer(lb, 'L-B'); printer(todo, '待核实');
    console.log('\n═══ 总计 ═══');
    console.log(`  L-A       ${String(la.length).padStart(4)}   ${fmtG(la)}`);
    console.log(`  L-B       ${String(lb.length).padStart(4)}   ${fmtG(lb)}`);
    console.log(`  待核实    ${String(todo.length).padStart(4)}   ${fmtG(todo)}`);
    console.log(`  命中总数  ${String(hits.length).padStart(4)}`);
    const dist = hits.reduce((m, h) => { m[`${h.cls}/${h.rule}`] = (m[`${h.cls}/${h.rule}`] || 0) + 1; return m; }, {});
    console.log(`  规则分布  ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  }

  /**
   * ★ v2.53（D94）：退出码只表达**棘轮**（不许回退），不表达判据（必须为 0）。
   *   原因写在 BASELINE 的注释里：判据直接进门禁 = 永久红 = 没有门禁；
   *   但判据**不降格**——它照样打印，且守卫断言"未达标这件事必须被说出来"。
   */
  let fail = la.length > BASELINE.la;
  /** 诊断信息一律走 stderr —— 保证 `--json` 的 stdout 是纯 JSON（可管道给下游） */
  const diag = (s) => console[asJson ? 'error' : 'log'](s);
  if (compareToBaseline) {
    if (BASELINE.lb == null) { diag('\n❌ L-B 基线被置空（BASELINE.lb = null）—— 那等于把判据关掉，不接受'); fail = true; }
    else if (lb.length > BASELINE.lb) { diag(`\n❌ L-B 高于基线（${BASELINE.lb} → ${lb.length}）—— 只允许下降`); fail = true; }
    else diag(`\n✅ L-B 棘轮 ${lb.length} ≤ 基线 ${BASELINE.lb}`);
    if (BASELINE.la == null) { diag('\n❌ L-A 棘轮被置空 —— 不接受'); fail = true; }
    else diag(la.length > BASELINE.la
      ? `\n❌ L-A 高于棘轮（${BASELINE.la} → ${la.length}）—— 只允许下降`
      : `\n✅ L-A 棘轮 ${la.length} ≤ ${BASELINE.la}`);
  }
  diag(la.length > TARGET.la
    ? `\n⚠️  G3 判据未达标：L-A 要求 ${TARGET.la}，现存 ${la.length} 处写/守卫路径兜底。**这是账面缺口，不是本脚本的门禁条件**（门禁走棘轮，见 D94）`
    : '\n✅ G3 L-A = 0（写/守卫路径无兜底 ⇒ 判据达标）');
  return fail ? 1 : 0;
}

process.exitCode = main();
/**
 * ★ v2.53 修一处会让"读数本身"说谎的工具缺陷（新立 B78）：
 *   原来这里是 `process.exit(main())`。stdout 是**终端或文件**时写是同步的 ⇒ 输出完整；
 *   一旦被**接成管道**（守卫用 spawnSync 取、或 `| jq`、或 CI 收集）写就是异步的，
 *   `process.exit()` 会在缓冲区刷完之前杀掉进程 ⇒ **JSON 被截断**且**退出码仍是 0**。
 *   实测（同一命令两次）：重定向到文件 = 218296 字节且可 parse；
 *   经管道 = 51855 字节、parse 报 `Expected double-quoted property name`、status 0。
 *   ⇒ "跑通了 / 输出可解析"这类结论在管道下曾经是假的。改成只设 `process.exitCode`，
 *     让 Node 在 stdout 刷完后自然退出。
 */
