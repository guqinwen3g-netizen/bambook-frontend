/**
 * §2 **G4.1** 的取数层（**只此一份实现**，R2）：把"哪些写端点存在、各自挂了哪道门"从**源码派生**，
 * 而不是手写清单（R3 禁手写清单；该纪律的出处见 `src/crm/__tests__/crmV1WriteScopeB69.test.ts` 的头注释）。
 *
 * 为什么单独成文件：G4.1 要的是"角色 × 写端点"的**全量**矩阵，而此前每批都是"挑一个域、手写 20 条"。
 * 挑与数两件事一旦散在各测试里就会各漂一份 —— 本仓的计数级假绿几乎全部来自这个模式。
 *
 * ★ 本文件**只解析、不评级**：不给"该不该挂门"的结论，也不 import 任何生产代码（判据必须独立于被测物）。
 *   角色 → scope 的判定用真源 `_shared/rolePermissionMatrix.getDefaultScopeListForRole`，
 *   设计给守卫测试当共用提取器用。**★ v2.47 复核抓到本行原先写着一个"调用方"文件名，而那个文件当时并不存在**
 *   （= 把计划写成了事实）⇒ 现状：**今天零消费者、零测试**，本文件只是 G4.1 矩阵（task 12）的前置工具；
 *   它自己的正确性由 G4.1 那批带上守卫后才算被覆盖，在那之前引用它的读数一律要标「未验证」。
 *
 * ★ 第一版在这里栽过三个坑（都是"把有门误读成没门"或反之，比漏更危险），逐条写了对照：
 *   ① 中间件**就地写成 `requirePermission('x:write')`**（不先起别名）—— 只取首标识符会把它当"未知符号"；
 *   ② 链里夹着**注释**（如 knowledgeDocuments 那条把 multer 错误包一层的注释）会被当成一个参数吃进来；
 *   ③ **文件级 blanket**（`router.use(guard)`）没算进判定 ⇒ admin/hr 两个域整片被误报成"无门"。
 *   ⇒ 现在：先剥注释；链上每一项既认别名也认原语内联；blanket 单独合成 `effective` 判定，
 *     并把"blanket 只在 `requireAuth` 为真时挂上"这一族（`if (requireAuth) router.use(...)`）标成**条件生效**。
 */
import { stripComments } from './errorDebtScanners.mjs';

/** 只到身份、不做授权判定的原语（矩阵里它们**不算**"该端点有 scope 门"）。 */
const IDENTITY_PRIMITIVES = new Set([
  'requireAuth', 'requireJwtForWrite', 'createModuleAuthGuard', 'authenticate', 'sdkAuth', 'optionalAuth',
]);
/** 能做授权判定的原语。 */
const AUTHZ_PRIMITIVES = new Set(['requirePermission', 'requireRole']);

/** 从 `(` 之后做括号/引号配对扫描，返回配对 `)` 之后的下标（找不到给 -1，绝不"猜一个终点"）。 */
function closeParen(src, openIdx) {
  let depth = 0, i = openIdx, q = null;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (q) {
      if (c === '\\') { i += 1; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** 顶层逗号切分（括号/方括号/引号内的逗号不算分隔符）。 */
function splitTopLevelArgs(inner) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (q) {
      if (c === '\\') { cur += c + (inner[i + 1] ?? ''); i += 1; continue; }
      if (c === q) q = null;
      cur += c; continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth -= 1; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const stripStrings = (s) => s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** 一个"门文本"（`requirePermission('a:write')` / `requireRole('owner','admin')` / 别名 / 数组展开）解析出的要求。 */
function emptyReq() { return { scopes: [], roles: [], identity: false, conditional: false, inlineFn: false, fromFnBody: false, unresolved: [] }; }
function mergeReq(a, b) {
  a.scopes.push(...b.scopes); a.roles.push(...b.roles);
  a.identity = a.identity || b.identity;
  a.conditional = a.conditional || b.conditional;
  a.inlineFn = a.inlineFn || b.inlineFn;
  a.fromFnBody = a.fromFnBody || b.fromFnBody;
  a.unresolved.push(...b.unresolved);
  return a;
}

/** 原语内联文本 → 要求（`requirePermission(['a','b'])` 是 OR 语义，一并收进 scopes）。 */
function parsePrimitive(text) {
  const r = emptyReq();
  const head = /^([A-Za-z_$][\w$]*)/.exec(text)?.[1];
  if (!head) return r;
  const argText = (fnName) => {
    const i = text.indexOf(`${fnName}(`);
    if (i < 0) return '';
    const end = closeParen(text, i + fnName.length);
    return end < 0 ? text.slice(i + fnName.length + 1) : text.slice(i + fnName.length + 1, end - 1);
  };
  if (/^requirePermission\b/.test(text)) r.scopes.push(...quoted(argText('requirePermission')));
  else if (/^requireRole\b/.test(text)) r.roles.push(...quoted(argText('requireRole')));
  else if (IDENTITY_PRIMITIVES.has(head) || /^require[A-Za-z]*Auth\b/.test(head)) r.identity = true;
  else return r;                                    // 不是原语 ⇒ 交回上层按别名解析
  if (/\brequireAuthEnabled\b|\.test\(|\?\s*\[/.test(text)) r.conditional = true;
  return r;
}

/**
 * 一个文件里的**门符号解析表**（局部别名 → 真实要求），支持现网出现过的全部形状：
 *   const requireWrite = requireJwtForWrite({ ... })
 *   const requireBomWrite = requirePermission('bom:write')
 *   const requireInvoicesRead = requirePermission(['invoices:read','vouchers:read'])
 *   const requireBillingWrite = [requireWrite, requirePermission('invoices:write')]
 *   const writeMw = requireAuthEnabled ? [requireAuth, requireRole('owner','admin')] : []   ⇒ conditional
 */
export function fileGuardSymbols(rawSrc) {
  const src = stripComments(rawSrc);
  const map = new Map();
  // ① `const/let 别名 = 一行 RHS`，② `const 别名 = [ ...跨行数组 ]`（samples 那一族全用跨行数组）
  const decl = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(\[[\s\S]*?\]|`[^`]*`|[^\n;]+);/g;
  for (const m of src.matchAll(decl)) {
    const name = m[1];
    const rhs = m[2].replace(/\s+/g, ' ').trim();
    const req = emptyReq();
    req.conditional = /\brequireAuthEnabled\b|\?\s*\[/.test(rhs);
    for (const t of rhs.matchAll(/\b(require[A-Za-z0-9_]*|guard|authMw|middleware[A-Za-z0-9_]*|writeMw)\b/g)) {
      if (t[1] === name) continue;
      const p = parsePrimitive(t[1]);
      if (p.scopes.length || p.roles.length || p.identity) req.unresolved.push(t[1]);
    }
    mergeReq(req, parsePrimitive(rhs));
    if (req.scopes.length || req.roles.length || req.identity || req.unresolved.length) map.set(name, req);
  }
  /**
   * ③ **函数声明式**的门（`function requireCrmWrite(req,res,next){…}`）—— 第一版把这类整族当成"未知符号"，
   *    于是 CRM V1 那 20 条明明挂了 scope 却被报成"解析不出" ⇒ 矩阵会**低估**已有守卫。
   *    现在按其**函数体内出现的原语**解析（体内既有 `requirePermission('x')` 也有 `requireJwtForWrite` 时，
   *    如实合并）。⚠️ 这是"从函数体里读它调了哪道原语"，不是"读懂它的分支逻辑"：
   *    条件分支（`if (读) return next()`）会被读成"这道门既要求 scope 也接受读"，
   *    所以带函数体来源的条目一律打 `fromFnBody`，由调用方在矩阵里**单列一栏等人读**，不许混进"已确认"。
   */
  for (const m of src.matchAll(/function\s+(require[A-Za-z0-9_]*)\s*\(/g)) {
    const name = m[1];
    const openIdx = src.indexOf('(', m.index);
    const closeIdx = src.indexOf(')', openIdx);
    const braceIdx = src.indexOf('{', closeIdx);
    if (braceIdx < 0) continue;
    const end = closeBrace(src, braceIdx);
    if (end < 0) continue;
    const body = src.slice(braceIdx, end);
    const req = emptyReq();
    req.fromFnBody = true;
    for (const p of body.matchAll(/requirePermission\s*\(\s*(\[[^\]]*\]|'[^']*')/g)) req.scopes.push(...quoted(p[1]));
    for (const p of body.matchAll(/requireRole\s*\(([^)]*)\)/g)) req.roles.push(...quoted(p[1]));
    if (/requireJwtForWrite|createModuleAuthGuard|extractActorFromRequest|authenticate\s*\(/.test(body)) req.identity = true;
    // 体内的 `return res.status(401|403)` 形状本身不是授权声明 ⇒ 只记不改判定
    if (req.scopes.length || req.roles.length || req.identity) map.set(name, req);
  }
  return map;
}

/** `{` 处的花括号配对（引号感知）；返回配对 `}` 之后的下标。 */
function closeBrace(src, openIdx) {
  let depth = 0, i = openIdx, q = null;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (q) { if (c === '\\') { i += 1; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; if (depth < 0) return -1; }
  }
  return -1;
}

/**
 * 文件里的**全部写注册**：`router.post(...)` / `app.put(...)`（`router` 与 `app` 分开标，挂载语义不同）。
 * 返回 `{ receiver, method, path, pathIsLiteral, line, chain:[中间件原文], inlineFns:n }`
 *   · `chain` 已剥注释、去掉路径字面量与末尾 handler；就地写的 `(req,res)=>…` 记进 `inlineFns`（**不算门**，但会被点名）
 */
export function writeRegistrationsOf(rawSrc) {
  const src = stripComments(rawSrc);
  const out = [];
  for (const m of src.matchAll(/\b(router|app|sub)\.(post|put|patch|delete)\s*\(/g)) {
    const openIdx = m.index + m[0].length - 1;
    const end = closeParen(src, openIdx);
    if (end < 0) continue;
    const args = splitTopLevelArgs(src.slice(openIdx + 1, end - 1));
    if (args.length < 2) continue;
    const pm = /^['"`]([^'"`]*)['"`]$/.exec(args[0]);
    const mid = args.slice(1, -1).map((a) => a.trim()).filter(Boolean);
    let inlineFns = 0;
    const chain = [];
    for (const x of mid) {
      if (/^(async\s+)?(\(|function)/.test(x) || /^\w+\s*:\s*/.test(x)) { inlineFns += 1; continue; }
      if (/^(async|function)/.test(stripStrings(x).replace(/^[A-Za-z_$][\w$]*\s*=>/, '=>'))) { inlineFns += 1; continue; }
      chain.push(x);
    }
    out.push({
      receiver: m[1], method: m[2].toUpperCase(),
      path: pm ? pm[1] : args[0], pathIsLiteral: Boolean(pm),
      line: lineOf(src, m.index), chain, inlineFns,
    });
  }
  return out;
}

/** `app.all('<路径>', ...)` —— 遗留 broad-sync 面（B72 那一族）单独取，不与写动词混算。 */
export function appAllOf(rawSrc) {
  const src = stripComments(rawSrc);
  const out = [];
  for (const m of src.matchAll(/\bapp\.all\s*\(/g)) {
    const openIdx = m.index + m[0].length - 1;
    const end = closeParen(src, openIdx);
    if (end < 0) continue;
    const args = splitTopLevelArgs(src.slice(openIdx + 1, end - 1));
    if (args.length < 2) continue;
    const pm = /^['"`]([^'"`]*)['"`]$/.exec(args[0]);
    out.push({ path: pm ? pm[1] : args[0], line: lineOf(src, m.index), chain: args.slice(1, -1) });
  }
  return out;
}

/** 文件级 blanket：`router.use(...)` / `app.use('<前缀>', ...)` 的中间件名与行号 + 是否包在 `if (requireAuth)` 里。 */
export function blanketGuardsOf(rawSrc) {
  const src = stripComments(rawSrc);
  const out = [];
  const condLines = new Set(
    [...src.matchAll(/if\s*\(\s*(?:options\.)?requireAuth[^)]*\)\s*\{/g)].map((m) => lineOf(src, m.index)),
  );
  for (const m of src.matchAll(/\b(router|app)\.use\s*\(/g)) {
    const line = lineOf(src, m.index);
    const openIdx = m.index + m[0].length - 1;
    const end = closeParen(src, openIdx);
    if (end < 0) continue;
    const inner = src.slice(openIdx + 1, end - 1);
    out.push({
      on: m[1], line,
      // ★ 不能 stripStrings —— 那会把 requireRole('owner','admin') 里的字面量抹成 ('','') ⇒ 判定被毁
      names: splitTopLevelArgs(inner.replace(/^\s*'[^']*'\s*,/, '')).map((a) => a.trim()).filter(Boolean),
      // blanket 是否在 `if (requireAuth) { router.use(...) }` 里 ⇒ 只在生产态生效（dev 整片无门）
      conditional: [...condLines].some((l) => l <= line && line - l <= 6),
    });
  }
  return out;
}

/**
 * 文件级 blanket 的**要求集合**（把 `router.use([guard, requireRole('owner','admin')])` 这类原文解析成要求）。
 * ★ 放在 lib 里而不是各调用方各写一遍：矩阵的"链上有没有门"与"blanket 有没有门"必须是同一把尺。
 * 返回 `[{ scopes, roles, identity, conditional, unresolved }]`，`conditional=true` = 只在 `requireAuth` 为真时生效。
 */
export function blanketRequirementsOf(rawSrc) {
  const guards = fileGuardSymbols(rawSrc);
  return blanketGuardsOf(rawSrc)
    .filter((b) => b.on === 'router')
    .map((b) => {
      const acc = emptyReq();
      acc.conditional = b.conditional;
      for (const n of b.names) acc.conditional = acc.conditional || /\?\s*\[|requireAuthEnabled/.test(n);
      for (const n of b.names) mergeReq(acc, parseChainItem(n, guards, 0));
      return acc;
    });
}

/** 处理器体里自查的门（`if (!authenticate(req,res)) return;` / `if (!requireScope(req,res,'x')) return;`）。 */
export function inHandlerChecksOf(rawSrc) {
  const src = stripComments(rawSrc);
  return new Set([...src.matchAll(/if\s*\(\s*!?\s*([A-Za-z_$][\w$]*)\s*\(\s*req\b/g)].map((m) => m[1]));
}

/** 解析一个链项（可能是别名、原语内联、`...数组名` 展开、或就地函数）。 */
function parseChainItem(text, guards, depth) {
  const bare = text.replace(/^\.\.\./, '').trim();
  const p = parsePrimitive(bare);
  if (p.scopes.length || p.roles.length || p.identity) return p;
  const head = /^([A-Za-z_$][\w$]*)/.exec(stripStrings(bare).replace(/\(.*$/, '').trim());
  if (!head) { const r = emptyReq(); r.unresolved.push(bare.slice(0, 40)); return r; }
  const g = guards.get(head[1]);
  if (!g) { const r = emptyReq(); r.unresolved.push(head[1]); return r; }
  const out = emptyReq();
  mergeReq(out, { ...g, unresolved: [] });
  out.conditional = out.conditional || g.conditional;
  if (depth < 3) for (const ref of g.unresolved) mergeReq(out, parseChainItem(ref, guards, depth + 1));
  return out;
}

/**
 * 一条注册的判定。**链 + 文件级 blanket 合成 `effective`**，同时单独交出 `chain`/`blanket` 两半
 * —— 因为 blanket 常常只在生产态生效（`if (requireAuth)`），把两半合成一个结论就会**掩盖这一层**。
 * kind 取值：`scope` / `role` / `identity`（只到身份）/ `identity?`（门是条件挂的，dev 态没有）/ `inline-only`（就地函数自称门）/ `none` / `unknown`（有解析不出的符号 ⇒ 不许当"有门"）。
 */
export function classifyRegistration(reg, guards, blanketReqs, opts = {}) {
  const acc = emptyReq();
  for (const c of reg.chain) mergeReq(acc, parseChainItem(c, guards, 0));
  const blanket = emptyReq();
  for (const b of blanketReqs) mergeReq(blanket, b);
  const fold = (a) => {
    if (a.scopes.length) return 'scope';
    if (a.roles.length) return 'role';
    if (a.unresolved.length) return 'unknown';
    if (a.conditional) return 'identity?';
    if (a.identity) return 'identity';
    return 'none';
  };
  const both = mergeReq(emptyReq(), acc); mergeReq(both, blanket);
  const kind = fold(both);
  return {
    kind,
    scopes: [...new Set(both.scopes)], roles: [...new Set(both.roles)],
    chainKind: fold(acc), blanketKind: fold(blanket), blanketConditional: blanketReqs.some((b) => b.conditional),
    unresolved: [...new Set(both.unresolved)], inlineFns: reg.inlineFns,
    inHandler: Boolean(opts.inHandlerChecks?.size),
  };
}

/**
 * **函数声明式**的门（`function requireCrmWrite(req, res, next) { … }`）：这里只登记"它存在于本文件 + 首现行号"，
 * **不去读它的体**。第一版试过读体（扫里面的 `requirePermission` 字面量），结果体里带 `{` 的正则字面量
 * （如 `/^\d{4}$/`）把花括号配对一路带到后面的代码，**吞掉了后面真正的 const 门定义并覆盖同名条目** ——
 * 读数当场 scope 356→333、unknown 84→107（更糟的是它"看起来更准了"）。
 * ⇒ 结论：**一个会读错的解析器比"标成未解析"更危险**。这类符号一律进 `custom-fn` 桶，
 *   由"该域自己的活路径测试是否覆盖它"来结清，而不是由静态猜测结清。
 */
export function functionDeclaredGuards(rawSrc) {
  const src = stripComments(rawSrc);
  const out = new Map();
  for (const m of src.matchAll(/function\s+(require[A-Za-z0-9_]*)\s*\(/g)) {
    if (!out.has(m[1])) out.set(m[1], lineOf(src, m.index));
  }
  return out;
}
