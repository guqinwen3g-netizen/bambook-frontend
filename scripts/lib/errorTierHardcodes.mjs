/**
 * B126 普查尺（v3.10 进门禁）——「catch 里有没有把 HTTP 档位写死」从**人肉数**变成**派生 + 棘轮**
 *
 * ★ 为什么要有这把尺（§9 B126 自己要求的）：v3.06 只处理了 B124 那三站，台账写着
 *   "未做全仓普查 ⇒ 数出来再谈收口"。而 B68/B124 一族反复出现的病就是**同一档规则被抄成第 N 份**
 *   （`msg.includes('不存在') ? 404 : …` 就是把真尺 `statusFromError` 的关键词档手写复制一遍）。
 *   不收口可以，但**债有多大必须先有一个可跑读数**，否则下一批又是"凭印象说几处"。
 *
 * ★ 三条反静默失效的设计（照 `writeRouteSurface.mjs` 的既有范式，本仓 B35/B75/B76/B79 各栽过一次）：
 *   ① 单位是**落点**（一条"决定档位"的语句），不是形状命中次数 —— 一枚三元里有 404/409/400 三个字面量，
 *      按字面量数会把一处算成三处（第一版原型就错了 255 vs 124 vs 93 三个数，见 §9 B126）；
 *   ② 分类**必须加得回总数**，加不回去 = 有一桶被悄悄吞了；认不出的形状进 `unknown` 桶**逼表态**；
 *   ③ 扫之前先把**注释整段抹成空格**（保行号）——第一版没做，`// 见路由 :132` 里的行号被当成档位读出来了。
 *
 * ⚠️ 这把尺**不判对错**：catch 里写 `res.status(401)` 可能是完全正确的（认证失败就是 401）。
 *    它只回答"这个档位是谁定的"：写死的人 / 抄了一份关键词判据的人 / 按 `e.code` 自己分支的人 / 走真尺的人。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const HTTP_TIERS = new Set([400, 401, 402, 403, 404, 405, 409, 410, 411, 413, 415, 418, 422, 429, 500, 501, 502, 503, 504, 505, 507, 508, 509, 510]);

/** 档位 → 源码里的字面量（含少数几位写法会误报，所以只认 3 位且落在白名单里） */
const isTier = (t) => /^\d{3}$/.test(t) && HTTP_TIERS.has(Number(t));

function walk(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue; walk(p, out); }
    // ★ 测试文件必须排除：本仓有 60+ 份 `src/<域>/route.test.ts` 是**和源码并排**放的（不在 `__tests__` 目录里），
    //   第一版只排了目录 ⇒ 把测试里的 `expect(404)` 数成了产品落点（口径污染）。
    else if (name.endsWith('.ts') && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** 把字符串/模板**内容**抹成空格（保长度 ⇒ 行号列位不变；`${…}` 里是代码，不抹）。
 *  没有这一步，日志文案里的"（API-Key 调用将被 403）"和 `.slice(0, 500)` 的截断长度都会被当成档位。
 *  ⚠️ v3.10 复核后改成**单层状态机**：旧实现为了处理 `${}` 而 `maskStrings(src.slice(k+2))` 递归，
 *     切片切到**文件末尾** ⇒ 每个模板都重扫一遍尾部，整文件扫下来直接挂死（本批实测卡 >3 分钟被杀）。 */
export function maskStrings(src) {
  const out = src.split('');
  const n = out.length;
  // 栈帧：{ q, exprDepth }。q 是引号种类；exprDepth>0 表示正在模板的 `${…}` 里（那是代码，不抹）。
  const stack = [];
  let i = 0;
  while (i < n) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (!top) {
      if (c === '"' || c === "'" || c === '`') stack.push({ q: c, exprDepth: 0 });
      i++;
      continue;
    }
    if (top.exprDepth > 0) {
      // `${…}` 内部：当普通代码走，但可以再起字符串；`}` 回到模板内容
      if (c === '{') { top.exprDepth++; i++; continue; }
      if (c === '}') { top.exprDepth--; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { stack.push({ q: c, exprDepth: 0 }); i++; continue; }
      i++;
      continue;
    }
    if (c === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i += 2; continue; }
    if (top.q === '`' && c === '$' && src[i + 1] === '{') { top.exprDepth = 1; i += 2; continue; }
    if (c === top.q) { stack.pop(); i++; continue; }
    if (c !== '\n') out[i] = ' ';        // 字符串**内容**抹成空格；换行留着 ⇒ 行号不位移
    i++;
  }
  return out.join('');
}

/** 把 `//` 与 `/* *\/` 注释整段换成空格（长度不变 ⇒ 行号列位不变）。字符串/模板字面量**跳过不抹**。 */
export function blankComments(src) {
  const out = src.split('');
  const n = out.length;
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out[i] = ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2);
      const e = j < 0 ? n : j + 2;
      for (let k = i; k < e; k++) if (src[k] !== '\n') out[k] = ' ';
      i = e; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let k = i + 1;
      while (k < n) { if (src[k] === '\\') { k += 2; continue; } if (src[k] === c) { k++; break; } k++; }
      i = k; continue;
    }
    i++;
  }
  return out.join('');
}

/** 找出所有 catch 块的字符范围 [bodyStart, bodyEnd)（bodyStart = `{` 之后一位） */
export function catchRanges(src) {
  const ranges = [];
  const re = /\bcatch\b[^\{]{0,80}\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    ranges.push({ start, end: i, head: m.index });
    re.lastIndex = m.index + 1;
  }
  return ranges;
}

/** 只保留"不属于任何内层 catch"的那一段 ⇒ 一枚语句只会被数一次 */
function ownSegments(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  sorted.forEach((b, idx) => {
    let cursor = b.start;
    for (const inner of sorted.slice(idx + 1)) {
      if (inner.start >= b.end) break;
      if (inner.start > cursor) out.push({ from: cursor, to: inner.start, block: b });
      cursor = Math.max(cursor, inner.end);
    }
    if (cursor < b.end) out.push({ from: cursor, to: b.end, block: b });
  });
  return out;
}

/** 跳过一段字符串/模板字面量，返回结束后的位置。模板里的 `${…}` **不跳过**（里面可能藏着真落点），
 *  用括号计数嵌到 `}` 为止，其中的字符串递归处理。 */
function skipString(src, i) {
  const q = src[i];
  const n = src.length;
  let k = i + 1;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (q === '`' && c === '$' && src[k + 1] === '{') {
      let d = 1; k += 2;
      while (k < n && d > 0) {
        const cc = src[k];
        if (cc === '"' || cc === "'" || cc === '`') { k = skipString(src, k); continue; }
        if (cc === '{') d++;
        else if (cc === '}') d--;
        k++;
      }
      continue;
    }
    if (c === q) return k + 1;
    k++;
  }
  return n;
}

/** 语句级切分：**括号/字符串感知**（第一版不感知 ⇒ 把一个 `fail('X', \`多行模板\`, 500)` 从模板中间切开，
 *  同一处债被数成两条、还掉进 unclassified）。切点只有：depth==0 处的 `;`、`{`、`}`。 */
function statements(segText, baseOffset, loose = false) {
  const out = [];
  const n = segText.length;
  let start = 0, depth = 0, i = 0;
  const push = (upto) => {
    const t = segText.slice(start, upto);
    if (t.trim()) out.push({ offset: baseOffset + start, text: t });
    start = upto + 1;
  };
  while (i < n) {
    const c = segText[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(segText, i); continue; }
    if (c === '(' || c === '[') { depth++; i++; continue; }
    if (c === ')' || c === ']') { depth = Math.max(0, depth - 1); i++; continue; }
    if ((loose || depth === 0) && (c === ';' || c === '{' || c === '}')) { push(i); i++; continue; }
    if (c === '/' && segText[i + 1] === '/') { while (i < n && segText[i] !== '\n') i++; continue; }
    i++;
  }
  if (start < n) push(n);
  return out;
}

/** 逐个抽档位字面量，并**看它前面的调用上下文**：`.slice(0, 500)` / `Math.min(x, 300)` 里的三位数
 *  是长度/上限，不是 HTTP 档位（第一版把它们当成落点，`.slice(0,500)` 混进了债清单）。 */
function extractTiers(maskedStmt) {
  const SKIP_BEFORE = /(?:\.(?:slice|substring|substr|splice|padStart|padEnd|repeat|fill)|Math\.(?:min|max|round|floor)|setTimeout|setInterval)\s*\([^)]{0,24}$/;
  const tiers = [];
  for (const m of maskedStmt.matchAll(/\b(\d{3})\b/g)) {
    const before = maskedStmt.slice(Math.max(0, m.index - 40), m.index);
    if (SKIP_BEFORE.test(before)) continue;
    const t = Number(m[1]);
    if (HTTP_TIERS.has(t)) tiers.push(t);
  }
  return tiers;
}

/** "这个三位数是在**定档**吗？"—— 不定的（只出现在比较/文案里）不进清单，除非所在的 catch 已经接过真尺 */
const ASSIGN_SHAPES = [
  /\.status\(\s*[^)]{0,40}?\b\d{3}\b/,          // res.status(500) / res.status(x ? 409 : 500)
  /\b(?:status|httpStatus|statusCode)\s*[:=]\s*\d{3}\b/,   // status: 404
  /\?\s*\d{3}\s*:/,                             // x ? 404 : 500
  /(?:\?\?|\|\|)\s*\d{3}\b/,                    // e?.statusCode ?? 500
  /[,(]\s*\d{3}\s*[,)]/,                        // fail(res, 500, …) / fail(code, msg, 500)
];
const isAssigning = (s) => ASSIGN_SHAPES.some((re) => re.test(s));

/** 给一条语句定档：谁决定了这个档位？（优先级从高到低）
 *  ★ v3.10 复核 B-1 之后重写的分类：真尺的调用点**不再要求同一句里带字面量**才算落点。
 *    旧版把 `res.status(statusFromError(e))`（不带兜底字面量）判成"不是落点"⇒ 全仓 84 处接尺调用里
 *    只有 7 处被记到，我据此写出"只有 7 处问真尺"—— 那句话把"接尺且写死兜底"当成了"接尺"，**错了 12 倍**。
 *  十类各有独立含义：
 *   rulerFallback      问真尺 + **显式**写兜底档 ⇒ 正确姿势（兜底值仍要逐站核：写 400 会把服务端故障答成用户错）
 *   rulerNoFallback    问真尺但**从未声明自己的兜底档**（吃默认值）。★ v3.11 之后它的含义变了：崩溃与"连不上库"
 *                      已被 2c／第 3 档接住，剩下的债是"这一站没写清自己认不出来时该答几档" ⇒ 仍按债记账（只许降），
 *                      但**引用时不要再说成"崩溃被答成 400"**（那句归 B131 的历史）。
 *   rulerConsumer      读/比真尺算出来的档位（`if (status >= 500)`）⇒ 不是第二处定档实现
 *   keywordCopy        抄了一份"按中文关键词判档" ⇒ 真尺第 5 档的第二处实现（B68/B124 病灶）
 *   codeKey            `e.code === 'X' ? 409 : 500` ⇒ 注册表第 2 档的第二处实现（B129）
 *   passthroughStatusCode  信被捕获对象自带的 `statusCode` ⇒ 服务随手设一个数就上屏，无人校验
 *   otherTernary       别的条件表达式定档（`status: notFound ? 404 : 500`）
 *   tierViaVariable    档位藏在同块早先的 `const tier = 500` 里、这行只用变量 ⇒ 复核 M-2 补的（旧版整条看不见 ⇒ "把新增堵死"是空话）
 *   tierArg            档位当**实参**传给助手（`fail(res, 500, …)`）
 *   literalStatus      `res.status(500)` / `status: 404` 纯写死
 *   unclassified       认不出来 ⇒ 门禁红（注意：只覆盖"带档位字面量的调用实参"这一窄族，不是万能逼表态，见 m-1）
 */
function classify(maskedStmt, maskedBlock, constructorTier = false) {
  const stmt = maskedStmt, block = maskedBlock || '';
  const tiers = extractTiers(stmt);
  const hasRuler = /statusFromError\s*\(/.test(stmt);
  if (hasRuler) return { kind: tiers.length ? 'rulerFallback' : 'rulerNoFallback', tiers };
  if (!tiers.length) return null;
  // ★ 所在 catch 已经问过真尺，而本语句只是**读/比**那个结果 ⇒ 不算第二处定档实现
  if (/statusFromError\s*\(/.test(block) && !isAssigning(stmt)) return { kind: 'rulerConsumer', tiers };
  if (!isAssigning(stmt)) return null;                        // 只有文案/比较里的三位数 ⇒ 不算落点
  if (/includes\s*\(\s*['"`]/.test(stmt) && /[?:]\s*\d{3}/.test(stmt)) return { kind: 'keywordCopy', tiers };
  if (/\bswitch\s*\(/.test(stmt)) return { kind: 'otherTernary', tiers };
  if (/\?\s*\d{3}\s*:/.test(stmt) || /\?\?\s*\d{3}\b/.test(stmt)) {
    if (/\bstatusCode\b/.test(stmt)) return { kind: 'passthroughStatusCode', tiers };
    if (/\bcode\b/.test(stmt)) return { kind: 'codeKey', tiers };
    return { kind: 'otherTernary', tiers };
  }
  if (/\|\|\s*\d{3}\b/.test(stmt)) {
    if (/\bstatusCode\b/.test(stmt)) return { kind: 'passthroughStatusCode', tiers };
    return { kind: 'codeKey', tiers };
  }
  if (/[,(]\s*\d{3}\s*[,)]/.test(stmt) && /\b(?:fail|respond|reply|send|render|errorResult)\s*\(/i.test(stmt)) return { kind: 'tierArg', tiers };
  // A native Error's public status parameter, directly or via a proved bound
  // forwarder. A familiar class/helper name or argument position is insufficient.
  if (constructorTier) return { kind: 'tierArg', tiers };
  if (/\.status\(\s*\d{3}\s*\)/.test(stmt) || /\b(?:status|httpStatus|statusCode)\s*[:=]\s*\d{3}\b/.test(stmt)) return { kind: 'literalStatus', tiers };
  return { kind: 'unclassified', tiers };
}

function constructorTierOffsets(rawSrc, parsedSource) {
  const source = parsedSource ?? ts.createSourceFile('tier-source.ts', rawSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constructors = new Map();
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name ||
      !statement.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some(type => ts.isIdentifier(type.expression) && type.expression.text === 'Error'))) continue;
    const constructor = statement.members.find(ts.isConstructorDeclaration);
    if (!constructor) continue;
    const index = constructor.parameters.findIndex(parameter => ts.isIdentifier(parameter.name) &&
      ['status', 'httpStatus', 'statusCode'].includes(parameter.name.text) &&
      parameter.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PublicKeyword) &&
      (parameter.type?.kind === ts.SyntaxKind.NumberKeyword || (parameter.initializer && ts.isNumericLiteral(parameter.initializer) && isTier(parameter.initializer.text))));
    if (index >= 0) constructors.set(statement.name.text, index);
  }
  // Without a proved local constructor, neither its shadowing nor its uses
  // can supply a local tier offset. Cross-file proofs are scanned separately.
  if (constructors.size === 0) return [];
  // Local shadowing makes a text-name association ambiguous. Under-counting an
  // ambiguous class leaves it unclassified instead of inventing status evidence.
  const shadowed = new Set();
  const findShadows = node => {
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name) && constructors.has(node.name.text)) shadowed.add(node.name.text);
    ts.forEachChild(node, findShadows);
  };
  findShadows(source);
  const offsets = [];
  const walk = node => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && constructors.has(node.expression.text) && !shadowed.has(node.expression.text)) {
      const argument = node.arguments?.[constructors.get(node.expression.text)];
      if (argument && ts.isNumericLiteral(argument) && isTier(argument.text)) offsets.push(argument.getStart(source));
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return offsets;
}

/** Binding evidence for a literal forwarded to an Error's public HTTP status.
 * This is a source classification, not runtime authorization/status correctness.
 * A callback parameter is accepted only when every in-tree use/caller is known:
 * no type/name whitelist, dynamic callback, escaping parameter or mutable alias.
 * External callers and status values hidden behind constants remain blind spots.
 */
function forwardedTierProofs(entries) {
  const normalize = file => file.replaceAll('\\', '/');
  const sources = new Map(entries.map(entry => [normalize(resolve('/tier-source', entry.file)), entry]));
  const parsed = new Map();
  const directories = new Set();
  for (const file of sources.keys()) {
    for (let end = file.lastIndexOf('/'); end > 0; end = file.lastIndexOf('/', end - 1)) directories.add(file.slice(0, end));
  }
  const options = { noLib: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10, jsx: ts.JsxEmit.Preserve };
  const host = {
    getSourceFile(file) {
      const entry = sources.get(normalize(file));
      if (!entry) return undefined;
      if (!parsed.has(file)) parsed.set(file, ts.createSourceFile(file, entry.src, options.target, true));
      return parsed.get(file);
    },
    fileExists: file => sources.has(normalize(file)), readFile: file => sources.get(normalize(file))?.src,
    directoryExists: dir => directories.has(normalize(dir).replace(/\/$/, '')),
    getDirectories: () => [], getCurrentDirectory: () => '/tier-source', getCanonicalFileName: file => file,
    getDefaultLibFileName: () => '/tier-source/no-library.d.ts', useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n', writeFile() {},
  };
  const program = ts.createProgram([...sources.keys()], options, host), checker = program.getTypeChecker();
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  const symbol = node => {
    const bound = node && checker.getSymbolAtLocation(node);
    return bound?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(bound) : bound;
  };
  const declaration = node => symbol(node)?.declarations?.[0];
  const identifiers = new Map(), aliases = new Map(), cachedRefs = new Map(), calls = [];
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, child => visit(child, fn)); };
  for (const source of program.getSourceFiles()) visit(source, node => {
    if (ts.isIdentifier(node)) {
      if (!identifiers.has(node.text)) identifiers.set(node.text, []);
      identifiers.get(node.text).push(node);
    }
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) && node.name) {
      const bound = symbol(node.name);
      if (bound) { if (!aliases.has(bound)) aliases.set(bound, new Set()); aliases.get(bound).add(node.name.text); }
    }
    if (ts.isCallExpression(node) && node.arguments.some(argument => {
      const value = unwrap(argument);
      return value && ts.isNumericLiteral(value) && isTier(value.text);
    })) calls.push(node);
  });
  const references = bound => {
    if (!bound) return [];
    if (!cachedRefs.has(bound)) {
      const names = new Set([bound.name, ...aliases.get(bound) ?? []]);
      cachedRefs.set(bound, [...names].flatMap(name => identifiers.get(name) ?? []).filter(node => symbol(node) === bound));
    }
    return cachedRefs.get(bound);
  };
  const position = (node, kind, extra = {}) => {
    const source = node.getSourceFile();
    return { file: sources.get(normalize(source.fileName)).file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind, ...extra };
  };
  const constructor = expression => {
    const klass = declaration(expression);
    if (!klass || !ts.isClassDeclaration(klass) || reassigned(symbol(expression))) return null;
    const base = klass.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types;
    if (base?.length !== 1 || !ts.isIdentifier(base[0].expression) || base[0].expression.text !== 'Error' || symbol(base[0].expression)) return null;
    const ctor = klass.members.find(ts.isConstructorDeclaration);
    if (!ctor?.body || ctor.body.statements.length !== 1 || !ts.isExpressionStatement(ctor.body.statements[0])
      || !ts.isCallExpression(ctor.body.statements[0].expression) || ctor.body.statements[0].expression.expression.kind !== ts.SyntaxKind.SuperKeyword) return null;
    const index = ctor.parameters.findIndex(parameter => ts.isIdentifier(parameter.name)
      && ['status', 'httpStatus', 'statusCode'].includes(parameter.name.text)
      && parameter.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PublicKeyword)
      && (parameter.type?.kind === ts.SyntaxKind.NumberKeyword || parameter.initializer && ts.isNumericLiteral(parameter.initializer) && isTier(parameter.initializer.text)));
    if (index < 0) return null;
    return { index, chain: [position(ctor.parameters[index], 'public-error-status', { field: ctor.parameters[index].name.text, parameterIndex: index })] };
  };
  const cachedSinks = new Map(), evaluating = new Set();
  const reassigned = bound => references(bound).some(ref => {
    const parent = ref.parent;
    return ts.isBinaryExpression(parent) && parent.left === ref && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      || (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator);
  });
  const functionOf = node => {
    const decl = declaration(node);
    if (decl && ts.isFunctionDeclaration(decl) && decl.body) return decl;
    if (decl && ts.isVariableDeclaration(decl) && decl.parent.flags & ts.NodeFlags.Const) {
      const value = unwrap(decl.initializer);
      if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return value;
    }
    return null;
  };
  const declarationReference = ref => {
    const parent = ref.parent;
    return (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === ref
      || ts.isImportSpecifier(parent) || ts.isImportClause(parent);
  };
  const directCall = ref => {
    let target = ref;
    if (ts.isPropertyAccessExpression(ref.parent) && ref.parent.name === ref) target = ref.parent;
    return ts.isCallExpression(target.parent) && target.parent.expression === target ? target.parent : null;
  };
  const propertyFromObject = (node, name) => {
    const object = unwrap(node);
    if (!object || !ts.isObjectLiteralExpression(object) || object.properties.some(property => !ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) return null;
    const properties = object.properties.filter(property => property.name.text === name);
    return properties.length === 1 ? unwrap(properties[0].initializer) : null;
  };
  const callbackSink = expression => {
    if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken || !ts.isIdentifier(expression.expression)) return null;
    const object = expression.expression, parameter = declaration(object), objectSymbol = symbol(object);
    if (!parameter || !ts.isParameter(parameter) || !objectSymbol || parameter.dotDotDotToken) return null;
    const fn = parameter.parent;
    if (!ts.isFunctionDeclaration(fn) || !fn.name) return null;
    // The parameter must not escape or be reassigned, including its callback.
    if (references(objectSymbol).some(ref => ref !== parameter.name && (!ts.isPropertyAccessExpression(ref.parent)
      || ref.parent.expression !== ref || !ts.isCallExpression(ref.parent.parent) || ref.parent.parent.expression !== ref.parent))) return null;
    const fnRefs = references(symbol(fn.name));
    if (fnRefs.some(ref => !declarationReference(ref) && !directCall(ref))) return null;
    const callers = [...new Set(fnRefs.map(directCall).filter(Boolean))];
    if (!callers.length) return null; // A signature alone does not supply a callback.
    const index = fn.parameters.indexOf(parameter), proofs = [];
    for (const call of callers) {
      if (call.arguments.some(ts.isSpreadElement)) return null;
      const callback = propertyFromObject(call.arguments[index], expression.name.text);
      const proof = callback && sink(callback);
      if (!proof) return null;
      proofs.push(...proof.chain, position(call, 'callback-supplied', { parameterIndex: index, property: expression.name.text }));
    }
    const first = sink(propertyFromObject(callers[0].arguments[index], expression.name.text));
    if (callers.some(call => sink(propertyFromObject(call.arguments[index], expression.name.text))?.index !== first.index)) return null;
    return { index: first.index, chain: [...proofs, position(parameter, 'callback-parameter', { property: expression.name.text })] };
  };
  function sink(rawExpression) {
    const expression = unwrap(rawExpression);
    if (!expression) return null;
    if (ts.isPropertyAccessExpression(expression)) return callbackSink(expression);
    if (!ts.isIdentifier(expression)) return null;
    const bound = symbol(expression);
    if (!bound || evaluating.has(bound)) return null;
    if (cachedSinks.has(bound)) return cachedSinks.get(bound);
    evaluating.add(bound);
    let proof = null;
    const fn = !reassigned(bound) && functionOf(expression);
    if (fn && ts.isBlock(fn.body) && fn.body.statements.length === 1) {
      const statement = fn.body.statements[0];
      const created = ts.isThrowStatement(statement) || ts.isReturnStatement(statement) ? unwrap(statement.expression) : null;
      if (created && ts.isNewExpression(created) && !created.arguments?.some(ts.isSpreadElement)) {
        const target = constructor(created.expression), forwarded = target && unwrap(created.arguments?.[target.index]);
        const param = forwarded && declaration(forwarded), index = fn.parameters.indexOf(param);
        if (forwarded && ts.isIdentifier(forwarded) && index >= 0 && !param.dotDotDotToken) {
          proof = { index, chain: [...target.chain, position(fn, 'status-forwarder', { parameterIndex: index })] };
        }
      }
    }
    evaluating.delete(bound);
    cachedSinks.set(bound, proof);
    return proof;
  }
  const out = new Map(entries.map(entry => [entry.file, []]));
  for (const call of calls) {
    if (call.arguments.some(ts.isSpreadElement)) continue;
    const proof = sink(call.expression), argument = proof && unwrap(call.arguments[proof.index]);
    if (!argument || !ts.isNumericLiteral(argument) || !isTier(argument.text)) continue;
    const source = call.getSourceFile(), file = sources.get(normalize(source.fileName)).file;
    out.get(file).push({ offset: argument.getStart(source), chain: proof.chain });
  }
  // Local direct constructors retain the original meter. Imported constructors
  // are not newly promoted here: their classification is a separate inventory.
  return { proofs: out, sourceFiles: new Map(entries.map(entry => [entry.file,
    program.getSourceFile(normalize(resolve('/tier-source', entry.file)))])) };
}

/** Immutable in-memory source set; used by the repository meter and mutations. */
export function scanSourceEntries(entries, opts = {}) {
  const { proofs, sourceFiles } = forwardedTierProofs(entries);
  return entries.flatMap(entry => scanSourceWithProof(entry.file, entry.src, opts,
    proofs.get(entry.file) ?? [], sourceFiles.get(entry.file)));
}

/** 语句里"档位被起名存进变量"的定义（`const tier = 500` / `const s = x ? 404 : 500`）——给 tierViaVariable 用 */
const TIER_VAR_DEF = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*[^;{}]{0,80}?\b(\d{3})\b/g;

/** 落点行号取**档位字面量/真尺调用所在那一行**，不取语句片段起始行。
 *  （复核 M-3：起始行会落在上一条语句上 —— 463 条里只有 54 条行号正好，插一行就会让基线大批位移 ⇒
 *    逼人"整批重冻结"，而那正是棘轮死掉的方式。） */
function anchorOf(maskedStmt) {
  const r = maskedStmt.search(/statusFromError\s*\(/);
  if (r >= 0) return r;
  const t = /\b\d{3}\b/.exec(maskedStmt);
  return t ? t.index : 0;
}

/** 单文件内核：给一份源码文本，派生它"catch 里定档"的落点（主尺与突变自检共用同一把尺，不另写一份）
 *  ★ 复核 m-2：结构扫描（找 catch、切语句）**全程在抹过注释又抹过字符串内容的副本上跑**，
 *    否则 `logger.warn('please catch {this}')` 会凭空造出一个 catch 范围、把后面的括号配对带偏。
 *    两处抹法都**保长度** ⇒ 行号与给人看的 snippet 仍从原文取。 */
export function scanSourceText(rel, rawSrc, opts = {}) {
  // The supplied source is authoritative even when callers retain a stale
  // surrounding source set (a removal must not inherit the old body's proof).
  const entries = [...(opts.sourceEntries ?? []).filter(entry => entry.file !== rel), { file: rel, src: rawSrc }];
  const { proofs, sourceFiles } = forwardedTierProofs(entries);
  return scanSourceWithProof(rel, rawSrc, opts, proofs.get(rel) ?? [], sourceFiles.get(rel));
}

function scanSourceWithProof(rel, rawSrc, opts, forwardedProofs, parsedSource) {
  // This AST was built from this invocation's exact source set. Reuse it for
  // local constructors; never cache it across scans or source mutations.
  const constructorOffsets = constructorTierOffsets(rawSrc, parsedSource);
  const proofFor = st => forwardedProofs.find(proof => proof.offset >= st.offset && proof.offset < st.offset + st.text.length);
  const hasConstructorTier = st => constructorOffsets.some(offset => offset >= st.offset && offset < st.offset + st.text.length) || Boolean(proofFor(st));
  const withComments = blankComments(rawSrc);
  const src = maskStrings(withComments);          // 结构判据用这份（字符串内容已抹）
  const lineStarts = [0];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) lineStarts.push(lineStarts[i] + lines[i].length + 1);
  const lineAt = (off) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
  const points = [];
  const mk = (st, kind, tiers) => ({
    file: rel, line: lineAt(st.offset + anchorOf(st.text)), kind, tiers,
    snippet: withComments.slice(st.offset, st.offset + st.text.length).replace(/\s+/g, ' ').trim().slice(0, 140),
    ...(proofFor(st) ? { statusEvidence: proofFor(st).chain } : {}),
  });
  // wide 模式：**只**报 catch 之外的片段（与主尺分开口径，两个数不许互相加减）
  if (opts.wide) {
    const blocks = catchRanges(src).map((b) => ({ start: b.head, end: b.end }));
    let cursor = 0;
    const regions = [];
    for (const b of blocks) { if (b.start > cursor) regions.push({ from: cursor, to: b.start }); cursor = Math.max(cursor, b.end); }
    if (cursor < src.length) regions.push({ from: cursor, to: src.length });
    const wide = [];
    for (const rg of regions) {
      for (const st of statements(src.slice(rg.from, rg.to), rg.from, true)) {
        const c = classify(st.text, '', hasConstructorTier(st));
        if (!c) continue;
        wide.push(mk(st, c.kind, c.tiers));
      }
    }
    return wide;
  }
  for (const seg of ownSegments(catchRanges(src))) {
    const blockText = src.slice(seg.block.start, seg.block.end);
    const sts = statements(src.slice(seg.from, seg.to), seg.from);
    // 一遍：常规分类；同时记下"本块里把档位存进变量"的定义句是否已经被计入
    const vars = new Map();
    const rows = [];
    for (const st of sts) {
      for (const m of st.text.matchAll(TIER_VAR_DEF)) {
        if (HTTP_TIERS.has(Number(m[2]))) vars.set(m[1], { reported: false, tier: Number(m[2]) });
      }
      const c = classify(st.text, blockText, hasConstructorTier(st));
      if (!c) continue;
      rows.push(mk(st, c.kind, c.tiers));
      for (const m of st.text.matchAll(TIER_VAR_DEF)) if (vars.has(m[1])) vars.get(m[1]).reported = true;
    }
    // 二遍：只**用**变量定档、而定义句没被记过的（`const tier = 500; res.status(tier)`）⇒ 补成 tierViaVariable
    for (const st of sts) {
      if (classify(st.text, blockText)) continue;
      let hit = null;
      for (const [name, meta] of vars) {
        if (meta.reported) continue;
        const use = new RegExp(`\\.status\\(\\s*${name}\\s*\\)|\\b(?:status|httpStatus|statusCode)\\s*[:=]\\s*${name}\\b`).test(st.text);
        if (use) { hit = meta; break; }
      }
      if (hit) { rows.push(mk(st, 'tierViaVariable', [hit.tier])); hit.reported = true; }
    }
    points.push(...rows);
  }
  return points;
}

/** 主入口：扫 server/src（排除 __tests__ 与并排的 *.test.ts），派生全部"catch 里定档"的落点 */
export function enumerateTierLandingPoints(repoRoot, sub = join('server', 'src')) {
  const root = join(repoRoot, sub);
  const files = walk(root);
  const entries = files.map(file => ({ file: relative(repoRoot, file).split(sep).join('/'), src: readFileSync(file, 'utf8') }));
  const points = scanSourceEntries(entries);
  points.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { files, points };
}

export function summarize(points) {
  const byKind = {};
  for (const p of points) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  return { total: points.length, byKind, files: new Set(points.map((p) => p.file)).size };
}

/** ★ 反"换个地方躲尺"的加宽读数（盲区探针）：把**catch 之外**的定档语句也扫出来。
 *   没有这一条，"把写死的 500 挪出 catch"就能让主尺的数下降而我看不见。
 *   口径：只保留与主尺同样的形状判定（`literalStatus`/`keywordCopy`/…），常量间接引用扫不到 ⇒ 记为已知盲区。 */
/** 越界探针入口：**同一把尺**（scanSourceText）加 wide 开关，绝不另写一份分类逻辑
 *  （两处实现 = 第二处真源，本仓头号病）。单位是"片段"，与主尺的"落点"不同口径，**两个数不许互相加减**。 */
export function enumerateWide(repoRoot, sub = join('server', 'src')) {
  const entries = walk(join(repoRoot, sub)).map(file => ({ file: relative(repoRoot, file).split(sep).join('/'), src: readFileSync(file, 'utf8') }));
  const out = scanSourceEntries(entries, { wide: true });
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return out;
}

/**
 * ★ v3.12（复核 B-1 后半）：台账里那句分桶数**没有唯一读数出口** —— 尺改了桶（v3.12 收了 6 处 ⇒
 *   codeKey 24→20、rulerFallback 7→13），文档还留着旧数，而守卫 ⑧ 只与**总数**对撞（538 未变 ⇒ 一路绿）。
 *   渲染只此一份：写手与守卫都调这里，改口径只需改一处，且 `[B126-BUCKETS]` 锚会让"文档 vs 尺"每次门禁对撞。
 */
export const DOC_BUCKET_ORDER = ['literalStatus', 'tierArg', 'keywordCopy', 'codeKey', 'rulerNoFallback',
  'rulerFallback', 'passthroughStatusCode', 'otherTernary', 'rulerConsumer', 'unclassified'];

/** 台账用的一行渲染：`literalStatus 194 / tierArg 172 / …`（缺项按 0 计，不许"看不见就不写"） */
export function renderBucketsForDoc(byKind) {
  return DOC_BUCKET_ORDER.map((k) => `${k} ${byKind[k] || 0}`).join(' / ');
}

/**
 * ★ v3.14（B134）：基线条目的键**只此一份** —— 原先守卫（`error-tier-hardcodes.test.ts:32`）与写手
 *   （`freeze-error-tier-baseline.mjs:25`）各抄了一遍同一串字面量。G4.1 那份在 B132 已经收过同一个病。
 * 键里含行号是**有意**的：定位快，且同一文件同一桶的多处不会被并成一条。
 */
export function tierSiteKey(p) {
  return `${p.file}:${p.line}#${p.kind}`;
}

/**
 * 去掉行号后的"这条债在不在"签名（给 `reconcileSiteLists` 用）。
 * ⚠️ 与 G4.1 的 `siteSignature` **不是同一个形状**（那边的键是 `file:123 METHOD 'path'`，行号后面跟空格；
 *   这边是 `file:123#bucket`）⇒ 并的是**对撞算法**（`reconcileSiteLists` 一份），不硬并这两个归一化器。
 */
export function tierSiteSignature(key) {
  return String(key).replace(/:\d+#/, '#');
}
