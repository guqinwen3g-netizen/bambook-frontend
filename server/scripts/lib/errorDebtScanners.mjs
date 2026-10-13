/**
 * §9 错误出口家族 · **判据只此一份**（守卫与度量脚本共用）
 *
 * 为什么要有这个文件（2026-09-20 当天连撞两次，代价是**写进权威文档的数要公开更正**）：
 *   · 15:06 我把 B33 的判据在守卫里收紧（命中标识符必须是本文件 catch 到的错误对象），
 *     **度量脚本里那份没同步** ⇒ 同一口径两处给出 53 与 51；
 *   · B34 的正则 `Object.assign(new Error(…), {…})` + `[^}]*` 在守卫和脚本里**是同一份错误的判据**
 *     ⇒ 两边一起数漏：跨行写法、`{…}` 里带嵌套对象的写法整类看不见
 *     （实测 121 → **149 处 / 31 → 33 文件**，最大单文件 `shipping/allocationService.ts` 7 → 21）。
 * 共同土壤还是本仓头号病：**多套并行真源**（R2）。判据活两处，改一处漏一处，
 * 而"两边都对得上"只能证明它们**错得一样**。
 *
 * 用法：
 *   · 守卫：`import { b33Sites, b34Sites, b36Sites, stripComments } from '…/scripts/lib/errorDebtScanners.mjs'`
 *   · 度量：`cd server && node scripts/measure-error-debt.mjs`
 *
 * ⚠️ 本文件**只计量、不评级**，且刻意不 import 任何生产代码（判据必须独立于被测物）。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 剥块注释与行注释。**行号保真**：块注释按它跨了几行换成等量 `\n`，而不是整段删掉。
 *
 * 为什么要保行数：`audit-echo-sites.mjs` 这类"逐站点定位"的工具报的行号**不可信**——旧实现把整段块注释删掉，
 * 块注释之后的每一行都往前挪。实测例子：`finance/forwardFxService.ts` 的两处站点在 **:173 / :369**，
 * 而两份历史清单给出过 **:149** 与 :369（:149 那行是 `contractNumber,`，不是站点 ⇒ 那份清单的行号不能用来改代码）。
 * 行号错的定位工具会驱动改错地方，这一条代价是一整批返工。
 *
 * ★★ B76（2026-09-22 本批）：**旧的两遍 `replace` 会被"行注释里出现的 斜杠+星 序列"劫持。**
 *   旧实现先无条件做块注释 `replace`，所以只要某行 `//` 注释里含有"斜杠+星"（写 Markdown 强调、
 *   写路径通配（relations 星点 ts 这种）、写 URL 通配都会踩），那个假的块注释开头会一路找到文件里
 *   **下一个真的块注释收尾**才闭，中间的真实代码**整段从所有尺子里消失**。反方向也成立
 *   （块注释里写行注释符号会把收尾吃掉，见下一行），所以"把两遍换个顺序"不是修复，只是换了个劫持方向。
 *   现量（`isCode` 口径：原文里是代码、剥完变空行。★ v2.52 复核 I-3：本段原先写的 611 / 545 / 569 / 42
 *   是一次性探针在**另外两个口径**下的读数，与守卫和台账的数互相打脸 ⇒ 换成下面三个**带口径**的读数）：
 *     · 口径 A｜守卫总闸集（`server/src` + `server/scripts` + 前端枚举器，1427 文件）：**1282 行 → 177**，10 个文件有差异
 *     · 口径 B｜`enumerateFrontendSources()` 单独（880 文件，= B74 那把尺的扫描面，台账 B76 行引用的就是它）：**1223 → 177**，7 个文件
 *     · 口径 C｜A 里以 `server/` 开头的 1089 文件：**673 → 0** ⇒ "server 侧已清干净"只在 C 这句里成立
 *   单文件（旧尺吃掉 → 新尺）：`server/src/index.ts` 544→0、`components/Settings.tsx` 364→0、
 *     `server/src/notifications/notificationService.ts` 53→0、`services/apiService.ts` 43→0、`vite.config.ts` 25→0、
 *     `server/scripts/measure-error-debt.mjs` 25→0；**新尺更瞎的文件 0 个**。
 *   ⚠️ 三个口径**禁止互相加减**；且这四个数目前**没有唯一读数出口**（A 由守卫算，B/C 靠一次性 /tmp 探针）⇒ 已立账 B77。
 *   ⇒ 所有建在它之上的口径（B32/B33/B34/B36/B37/B39、RAW_LEAK、B74 前端尺、routeSurface）**在受害区间内是瞎的**。
 *   发现方式不是"读了实现觉得可疑"，而是本批一条普查**反向变红**（写进 V1 注释的 Markdown 强调符号让
 *   自己那把尺看不见自己那行代码）⇒ 见守卫 `stripCommentsRuler.test.ts`（含"全仓 vanish=0"的总闸）。
 *   ⚠️ 本段说明**第一次写出来时就被同一个缺陷咬了**：我在块注释里逐字写了那两个符号，文件当场语法错。
 *      ⇒ 记录这件事是为了说明"缺陷会伤到写说明的人"，不是谦虚。
 *
 * 现在：单遍扫描。**字符串 / 模板串 / 正则字面量优先于注释**，注释只在代码态里成立。
 * ✅ 2026-09-20 15:48 实测：换实现后**九个口径 11 个数一个都没变**
 *   （121/110/11、187、16、393、51、149、10、18、252），因为仓库里不存在"块注释夹在一条语句中间"的写法；
 *   守卫里那条"行数守恒 + 行号反查"断言把这个前提钉住，一旦漂移当场红。
 *   ⚠️ 那句结论只否证了"块注释夹在语句中间"，**没有**否证上面那个劫持 —— 这是它当时没抓到的原因（B75 同族：尺看着绿，其实没覆盖）。
 */
const REGEX_OK_PREV = new Set(['(', ',', '=', ':', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n']);
const NON_CODE_PREV = new Set([')', ']', '_']); // 这些字符之后出现 '/' ⇒ 更像是除法，不是正则

/**
 * 块注释**开头**允许出现在哪些字符之后。
 * ★ B76 的第二扇门：JSX 的**正文文本**不是代码，但在这把尺眼里和代码无法区分（要真正的 JSX lexer 才行）。
 *   `components/Settings.tsx` 的 `<code>/api/v1/*</code>` 就是这样的正文 —— 那个"斜杠+星"不是注释，
 *   却会一路找到下一个真的块注释收尾，把中间 364 行 JSX 变成尺子的盲区。
 *   规则：**只有跟在标点后面才算块注释开头**（字母/数字/汉字后面跟的 `/*` 按文本处理）。
 *   代价是"漏剥一条注释"⇒ 那段文字仍然被尺看见 ⇒ 只会**误报**，不会再**瞎**（本尺的失效方向只有"误报"可以接受）。
 */
const BLOCK_OK_PREV = new Set(['{', '}', '(', ')', '[', ']', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', '<', '>', '/', '\n', '']);

export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  /** 上一个"有意义的代码字符"（跳过空格），用来判 `/` 是正则开头还是除法 */
  let lastSig = '';
  const emit = (text) => { out += text; for (const ch of text) if (ch !== ' ' && ch !== '\t') lastSig = ch; };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // ① 行注释：只在代码态成立，吃到行尾但**不吃换行**（行数守恒）
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }

    // ② 块注释：整体换成等量 `\n`（行号保真）。**只有跟在标点后面才认**（见 BLOCK_OK_PREV 的 B76 说明）
    if (c === '/' && d === '*' && BLOCK_OK_PREV.has(lastSig)) {
      i += 2;
      let nl = 0;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') nl++; i++; }
      i += 2; // 吃掉收尾的 `*/`；未闭合时 i 越过末尾 ⇒ 剩下的按注释处理（与旧实现同向）
      out += '\n'.repeat(nl);
      continue;
    }

    // ③ 单/双引号字符串：原样保留（尺要能看见字符串里的文本），遇到未闭合换行即止
    if (c === '"' || c === "'") {
      const q = c;
      let s = q;
      i++;
      while (i < n) {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '\n') { break; }           // 未闭合：不把整文件当字符串吃掉
        s += src[i];
        const done = src[i] === q;
        i++;
        if (done) break;
      }
      emit(s);
      continue;
    }

    // ④ 模板串：**整段视作字面量**原样保留（含 `${}` 里的代码）。
    //   宁可让 `${}` 内部的一条注释"看起来像代码"（顶多误报一处），也不能让模板里的 `//`（URL、
    //   路径通配）把后半行连同 `${err.message}` 一起吃掉 —— 那正是 B76 的失效方向：尺瞎掉的那半边。
    if (c === '`') {
      let s = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '`') { s += src[i]; i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          s += '${';
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            s += src[i];
            i++;
          }
          continue;
        }
        s += src[i]; i++;
      }
      emit(s);
      continue;
    }

    // ⑤ 正则字面量：前一个有效字符像"这里该有值"才当正则，否则当除法
    if (c === '/' && (lastSig === '' || (REGEX_OK_PREV.has(lastSig) && !NON_CODE_PREV.has(lastSig)))) {
      let s = c;
      i++;
      let cls = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) { i++; break; }
        s += src[i]; i++;
      }
      while (i < n && /[a-z]/.test(src[i])) { s += src[i]; i++; } // .flags
      emit(s);
      continue;
    }

    emit(c);
    i++;
  }
  return out;
}

const SKIP_DIRS = ['__tests__', 'node_modules', 'generated', '.prisma'];

/** 遍历 `server/src` 下的生产源码（排除测试与生成物），返回 { rel, abs, src }（src 已剥注释）。 */
export function scanSources(serverDir) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.includes(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.ts') || ent.name.endsWith('.test.ts')) continue;
      out.push({
        abs,
        rel: path.relative(serverDir, abs).split(path.sep).join('/'),
        src: stripComments(fs.readFileSync(abs, 'utf8')),
      });
    }
  };
  walk(path.join(serverDir, 'src'));
  return out;
}

/** 按文件计数（只保留 >0 的文件），返回 { relPath: count }。 */
export function countByFile(entries, judge) {
  const out = {};
  for (const { rel, src } of entries) {
    const n = judge(src).length;
    if (n > 0) out[rel] = n;
  }
  return out;
}

/* ───────────────────────────── B33 ───────────────────────────── */

/** 位置参数型：`fail('CODE', e?.message || '中文兜底'…` */
export const B33_ARG_RE = /(?:fail|err|error)\s*\(\s*'[A-Z0-9_]+'\s*,\s*([A-Za-z_$][\w$]*)\??\.message\s*(?:\|\||\?\?)/g;
/** 属性型：`message: e?.message ?? '中文兜底'` */
export const B33_PROP_RE = /message:\s*([A-Za-z_$][\w$]*)\??\.message\s*(?:\|\||\?\?)/g;
const CATCH_PARAM_RE = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
/** `.catch(err =>` 与 `.catch((e) =>` 两种都要认（早先只认前者 ⇒ 带括号形参漏收，属"少计"） */
const CATCH_CB_RE = /\.catch\(\s*(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)/g;

/** 本文件里被 catch 到的错误对象名（`catch (e)` / `.catch(err =>` / `.catch((e) =>`）。 */
function caughtErrorNames(src) {
  return new Set([
    ...[...src.matchAll(CATCH_PARAM_RE)].map((m) => m[1]),
    ...[...src.matchAll(CATCH_CB_RE)].map((m) => m[1]),
  ]);
}

/**
 * **判据绑来源，不绑名字**：命中的标识符必须真是本文件 catch 到的错误对象。
 * 收紧前会误判两处（`shared/errorCodes.ts` 的注册表 `spec?.message`、`agent/agentLoop.ts` 的
 * AI 输出字段 `outputObj.message`）⇒ 数字虚高会让"清了一批"看起来成功，而该清的那处混在噪声里。
 * ⚠️ 盲区（认不到 ⇒ **只少计不多计**）：先 `const x = e` 再传 `x.message`、经 DTO 带出去。
 */
export function b33Sites(src) {
  const caught = caughtErrorNames(src);
  return [...src.matchAll(B33_ARG_RE), ...src.matchAll(B33_PROP_RE)].filter((m) => caught.has(m[1]));
}

/* ───────────────────────────── B37 ───────────────────────────── */

/**
 * `fail(<**非字面量** code>, e?.message ?? 中文…)` —— B33/B36 两支都认不到的第四种写法。
 *
 * 为什么既有判据看不见：B33 的 `ARG_RE` 要求第一参数是 `'CODE'` 字面量；本型第一参数是
 * `e?.code ?? 'X'` 或一个常量标识符 ⇒ 整支失配。15:54 在 `finance/forwardFxService.ts:291` 撞见。
 * 用户侧后果与 B33 完全相同（原文上屏），所以它**必须另立一支**计量，不能"算 B33 的一部分"混过去
 * —— 这正是"认语法形状、不认用户收到什么"的第 6 次现形（见权威文档 §12 D32/D36/D41/D43）。
 *
 * 与 B33 同源的过滤器：命中标识符必须是本文件 catch 到的错误对象。
 */
export const B37_RE = /(?:fail|err|error)\s*\(\s*(?!')[^(),]*?,\s*([A-Za-z_$][\w$]*)\??\.message\s*(?:\|\||\?\?)/g;

export function b37Sites(src) {
  const caught = caughtErrorNames(src);
  return [...src.matchAll(B37_RE)].filter((m) => caught.has(m[1]));
}

/* ───────────────────────────── B34 ───────────────────────────── */

/**
 * `Object.assign(new Error(…), { … })` 且**最后一个实参里没有 `statusCode`** ⇒ 会被兜底文案顶掉。
 *
 * 为什么不能用正则：属性对象里出现任何 `}`（嵌套对象、`...(cond ? { a: 1 } : {})`）
 * 或实参列表带**尾逗号**（`{…},\n)`），`[^}]*` / `\s*\)` 就整类失配。
 * 这里做**括号配对扫描**：跳过字符串（含模板串与转义）、按顶层逗号切实参、忽略空实参。
 * 判据仍可被满足（这是它成立的前提）：补上 `statusCode: 400` 即从计数里消失。
 * ⚠️ 盲区：`httpStatus` 等别名**照样计入** —— 这是对的，`isBusinessError` 只认 `statusCode`；
 *    自定义 Error 子类（非 `Object.assign` 形状）认不到。
 */
export function b34Sites(src) {
  const hits = [];
  let i = 0;
  while (true) {
    const j = src.indexOf('Object.assign(', i);
    if (j < 0) break;
    const args = splitTopLevel(src, j + 'Object.assign('.length);
    const real = (args ?? []).filter((a) => a.trim().length > 0);
    if (real.length >= 2 && /new\s+Error\s*\(/.test(real[0])) {
      const props = real[real.length - 1];
      if (!/\bstatusCode\b/.test(props)) hits.push({ match: props, index: j });
    }
    i = j + 1;
  }
  return hits;
}

/** 从 `openIdx`（左括号之后）扫到配对的右括号，返回按顶层逗号切开的实参数组。 */
function splitTopLevel(src, openIdx) {
  let depth = 1;
  let cur = '';
  const args = [];
  let quote = null;
  for (let k = openIdx; k < src.length; k++) {
    const c = src[k];
    if (quote) {
      if (c === '\\') { cur += c + (src[k + 1] ?? ''); k++; continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(cur); return args; }
      cur += c;
      continue;
    }
    if (c === ',' && depth === 1) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  return null; // 不配对（多半是上面的扫描被奇异字面量打断）⇒ 宁可不算，也不给假数
}

/* ───────────────────────────── B36 ───────────────────────────── */

export const B36_RE = {
  /** ① 文案位 = `String(e?.message ?? e)`：与"原文 || 中文"等价，只是没写兜底符号 */
  stringCopy: /(?:fail|error|err)\s*\(\s*'[^']+'\s*,\s*String\(\s*[A-Za-z_$][\w$]*\??\.message/g,
  /** ② `if (e?.code) return fail(e.code, e.message)`：Prisma 错误自带 code ⇒ 原文上屏 + 降 400 */
  codePassthrough: /if\s*\(\s*[A-Za-z_$][\w$]*\??\.code\s*\)\s*return\s+fail\(\s*[A-Za-z_$][\w$]*\??\.code\s*,/g,
};

/** ⚠️ 一律用 `.matchAll()`：全局正则的 `.test()` 会推进 lastIndex，反面对照会因错误的原因通过。 */
export function b36Sites(src, which) {
  return [...src.matchAll(B36_RE[which])];
}

/* ───────────────────────────── B39 ───────────────────────────── */

/**
 * `fail(<CODE 字面量>, `固定文案: ${原文}`, …)` —— **位置参数里内插原始异常**（B39）。
 *
 * 为什么必须另立一支：五条既有判据**一条都不认**（2026-09-20 18:0x 第 7a 批实测，不是推理）
 *   · **B22** 只数对象字面量里的 `message: X.message`；
 *   · **B30** 的 `WRAP_RE` 要求 `message|error|reason` **键名在前** ⇒ 位置参数结构性看不见
 *     （`node -e` 直接跑该正则，`credit/creditService.ts` **命中 0**）；
 *   · **B33** 要「原文 `||`/`??` + 引号中文兜底」；**B37** 要第一参数是**非字面量** code；
 *   · **B36①** 要文案位**整个**是 `String(...)`（本型是"模板里插了一段 String(...)"）。
 * 而用户收到的东西与 B33/B37 完全一样：**原文上屏**。同一根因第 7 次现形（D32/D36/D40/D41/D43/D46/D49）。
 *
 * 现场（第 7a 批）：`creditRoute.ts:132/:157` 把 `result.error.message` **原样**转发给客户端，
 * 而那句话由 `creditService.ts:483/:518` 的 `` `冻结事务失败: ${String(e?.message ?? e)}` `` 拼出 ——
 * 只清路由 catch 时，用户看到的仍是 `PrismaClientKnownRequestError: … /srv/app/…`。
 *
 * 判据：第 2 个实参是**模板字面量或字符串拼接**，且其中**引用了本文件 catch 到的错误对象**的原文
 * （`X?.message` / `String(X…` / `?? X` / `|| X` / 模板里裸 `${X}`）。
 * 与 B33/B36①/B37 **互斥**（它们的位置参数都不是"模板/拼接"），与 B30 互斥（B30 只在键名后）。
 * ⚠️ 盲区（**只少计不多计**）：方法调用形态 `obj.fail(...)` 不计；先把原文存进变量再内插不计；
 *    经 DTO/序列化带出去不计；`${e.stack}` 也不计（另一类，属 B22 头部声明的未覆盖形态）。
 */
export const B39_CALL_RE = /(?<![\w$.])(?:fail|err|error)\s*\(/g;

/** 在给定文本里找"被捕获异常的原文引用"，返回命中的标识符名或 null。 */
function rawExceptionRef(text, caught) {
  for (const n of caught) {
    const esc = n.replace(/[$]/g, '\\$');
    if (new RegExp(`\\b${esc}\\s*\\??\\.message\\b`).test(text)) return n;          // e?.message / err.message
    if (new RegExp(`String\\(\\s*${esc}\\b`).test(text)) return n;                  // String(e?.message ?? e)
    if (new RegExp(`(?:\\?\\?|\\|\\|)\\s*${esc}\\b`).test(text)) return n;         // e?.message ?? e
    if (new RegExp(`\\$\\{\\s*${esc}\\s*\\}`).test(text)) return n;                 // `${e}`
  }
  return null;
}

export function b39Sites(src) {
  const caught = caughtErrorNames(src);
  if (caught.size === 0) return [];
  const hits = [];
  B39_CALL_RE.lastIndex = 0;
  let m;
  while ((m = B39_CALL_RE.exec(src))) {
    const args = splitTopLevel(src, m.index + m[0].length);
    if (!args || args.length < 2) continue;
    const msgArg = args[1] ?? '';
    // 必须是模板字面量或字符串拼接 —— 裸 `X.message`（B33/B37）与整段 `String(X…)`（B36①）留给各自判据
    const isTemplate = msgArg.includes('`');
    const isConcat = /'[^']*'\s*\+|\+\s*'/.test(msgArg);
    if (!isTemplate && !isConcat) continue;
    // ★ 与 B37 互斥：文案位**以原文开头 + `??`/`||`** 的，是 B37 的"原文顶替文案"，
    //   本型是"原文**内插进**文案"。实测重叠 1 处（`paymentRequestService.ts:322`：
    //   `fail(e?.code ?? X, e?.message ?? \`…${String(e?.message ?? e)}\`)`）—— 不排掉就会重复扣数。
    if (leadingRawOperand(msgArg, caught)) continue;
    const who = rawExceptionRef(msgArg, caught);
    if (!who) continue;
    hits.push({ index: m.index, 0: msgArg.trim(), 1: who });
  }
  return hits;
}

/** 文案位是否**以**「被捕获异常的原文 + `??`/`||`」开头（= B37 的形状，本判据须让位）。 */
function leadingRawOperand(text, caught) {
  const t = text.trim();
  for (const n of caught) {
    const esc = n.replace(/[$]/g, '\\$');
    if (new RegExp(`^${esc}\\s*\\??\\.message\\s*(?:\\?\\?|\\|\\|)`).test(t)) return true;
  }
  return false;
}

/* ───────────────────── B42 棘轮尺自身（B73） ───────────────────── */
/**
 * ★ 台账 **B73**（v2.46 立账）：`res.status(…).json(… <异常原文> …)` 这条**落点**的计量口径。
 *
 * 起因不是又找到一处外泄，而是**棘轮尺自己被骗了一次**：v2.46 把三处状态档改成
 * `res.status(statusFromError(e, 500))`，守卫里的 `res\.status\([^)]*\)` 因为
 * `[^)]*` 跨不过那对嵌套括号 ⇒ 基线从 12 "降"到 10 —— **外泄一处没少，计数掉了 2**。
 * 同一把尺量改动前的源码给出 45 ⇒ 那 33 处的差额**早在 B68 之前就一直看不见**
 * （`errStatus(e)` 这种老写法同样是嵌套调用）。
 *
 * 因此这里放**三个口径并列**，而不是"修一个正则"了事：
 *   V1 `rawLeakV1Sites`    = 2026-09-17 那把尺的原形状（只认字面/简单状态档，且字面量写死 `e?.message`）
 *   V2 `rawLeakSites`      = 现守卫用的形状（允许一层嵌套，仍写死 `e?.message`）
 *   V3 `rawLandingSites`   = **落点口径**：catch 绑定的哪个变量名都认、`status(...)` 嵌套多深都认
 * 守卫继续用 V2 冻结基线（收紧形状不影响对外契约），V3 只在度量入口报数 ⇒ 两口径**禁止互相加减**（§0.3）。
 * V3 也不是天花板：`.json(` 换行的写法（跨行对象字面量）三个口径都取不到，已在 B73 行内注明。
 */
const LEAK_V1 = /res\.status\([^)]*\)\.json\([^\n]*e\?\.message/g;
const LEAK_V2 = /res\.status\((?:[^()]|\([^()]*\))*\)\s*\.json\([^\n]*e\?\.message/g;
/** 同一把尺的两个形状，作为正则导出（守卫里那些 `.match(RE)` 写法直接 import 这一份） */
export const RAW_LEAK_V1_RE = LEAK_V1;
export const RAW_LEAK_V2_RE = LEAK_V2;

function matchAll(re, src) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push({ index: m.index, text: m[0] });
  return out;
}

export function rawLeakV1Sites(src) { return matchAll(LEAK_V1, src); }
export function rawLeakSites(src) { return matchAll(LEAK_V2, src); }

/** 落点口径：同一行内 `res.status(` … `.json(` … 引用了本文件 catch 到的异常原文。 */
export function rawLandingSites(src) {
  const caught = caughtErrorNames(src);
  if (!caught.size) return [];
  const hits = [];
  let offset = 0;
  for (const line of src.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const at = line.indexOf('res.status(');
    const jsonAt = line.indexOf('.json(');
    if (at < 0 || jsonAt < at) continue;
    const ref = rawExceptionRef(line.slice(jsonAt), caught);
    if (ref) hits.push({ index: start + jsonAt, text: line.trim() });
  }
  return hits;
}

export { caughtErrorNames };

/* ────────────────────────────────────────────────────────────────────────────
 * ★ B74（§9 立账 v2.47 · 尺上移 v2.48）：前端"把 catch 到的异常原文拼进可见文案"
 *
 * 为什么也要上移成一份实现：v2.47 那版台账里的 232 / 82 与落点分解 202+11+1 是**当场敲的三条
 * 互相独立、口径也不一致的 `rg`**（标识符集合只写了 `err|error`，漏掉裸 `e?.message` 与 `res/respons`；
 * 三条各自命中同一行时又被重复计入）⇒ 独立复核复现不出，且 202+11+1=214 加不回 232。
 * ⇒ 本函数是这条面的**唯一尺**：一次遍历、落点分桶互斥、桶和必等于总行（脚本里带自检断言）。
 *
 * ⚠️ 口径限制（写台账时必须一起写，不许只报数）：
 *   · 它认的是"这行引用了异常对象的 message 字段"，**不证明那行文案真被渲染**；
 *   · 看不见改名的写法（先 `const msg = …` 再喂给别的状态），也看不见 `String(error)` 这类不带 `.message` 的整对象外抛；
 *   · 因此 **总行数只能当上界**，而"落在 console 那一桶"才是可排除项。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ★ v2.47 复核 B1（本批）：**旧版是"逐目录白名单"，而它号称量的是"前端"。**
 *   `FRONTEND_DIRS = [components, services, src, utils, hooks, screens]` 里有三项（src/hooks/screens）
 *   **在仓里根本不存在**（`existsSync` 假 ⇒ `continue`，一声不吭），而真实存在的
 *   根级 `App.tsx`/`index.tsx`、`lib/`、`pwa/`、`customer-portal/`、`electron/` 一个都不在里面
 *   ⇒ 542 行**全部来自 `components/`**，而台账里那条的**起源例子 `App.tsx:944` 恰好不在尺的视野里**。
 *   这跟 B35 的"按场景手写精确前缀"是同一形状：**枚举清单不会自己长大 ⇒ 静默漏**。
 * ⇒ 改成**黑名单遍历仓根**：新增目录默认被覆盖，只有明确排除的才不看，且排除项**必须随读数打印出来**。
 */
export const FRONTEND_EXCLUDE_ANY = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'generated', '.prisma'];
/** ★ 只在**仓根一层**生效的排除项。踩过一次：把 `tools` 放进"任意深度"的黑名单，
 *    于是 `components/tools/` 整个子目录被顺带剪掉（5 处真落点从尺里消失）⇒ 修尺修出新的瞎区。 */
export const FRONTEND_EXCLUDE_ROOT = ['public', 'data', 'docs', 'deploy', 'server', 'scripts', 'tools'];
export const FRONTEND_EXCLUDE = [...FRONTEND_EXCLUDE_ANY, ...FRONTEND_EXCLUDE_ROOT];
/** 异常对象的常见名字：上一版只写了 err|error，实测漏掉裸 `e` 与 `res`/`response`。 */
const FE_IDENT = '(?:err|error|e|res|response)';
export const FRONTEND_LEAK_SHAPES = {
  /** 模板串里插值：`` `…${err?.message}…` `` */
  interp: new RegExp(`\\$\\{[^}]*\\b${FE_IDENT}\\??\\.message`),
  /**
   * 字符串拼接。★ v2.47 复核 I-2：旧版只有 `+ err.message`（左侧拼），
   * 实测 `err.message + " 请重试"` 与 `msg += err.message` 都不命中 ⇒ "留着能抓到"这句话
   * 只对三个方向里的一个成立。现在三个方向都认（`X.message + …`、`… + X.message`、`+= X.message`）。
   */
  concat: new RegExp(`(?:\\+\\s*\\b${FE_IDENT}\\b\\??\\.message|\\b${FE_IDENT}\\b\\??\\.message\\s*\\+(?!=)|\\+=\\s*\\b${FE_IDENT}\\b\\??\\.message)`),
  /** 具名错误态：`setError(err.message)` */
  setter: new RegExp(`\\bset[A-Za-z]*Error\\([^)]*\\b${FE_IDENT}\\??\\.message`),
};
const FE_LOG_ONLY = /\bconsole\.[a-z]+\(/;
const FE_TOAST = /toast/i;
const FE_TEST_HINT = /(\.test\.|\.spec\.|__tests__)/;

/**
 * 枚举仓根的**全部**前端源文件（不做形状匹配），每个带 `excluded` 标记。
 * ★ v2.47 复核 I-1/M-1：`scanFrontendSources` 只返回"有命中"的文件 ⇒ 它没法回答"我扫了多少、跳了什么"。
 *   这条是那个问题的唯一实现：守卫的行数守恒总闸与"排除项代价"打印都走这里，
 *   不再各写一份遍历（两份枚举必然漂）。
 */
export function enumerateFrontendSources(repoRoot) {
  const out = [];
  const walk = (d, atRoot, insideExcluded) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      // 产物目录：硬跳过（不进去，也不计代价 —— 它们不是"另一份源码"）
      if (FRONTEND_EXCLUDE_ANY.includes(ent.name) || SKIP_DIRS.includes(ent.name)) continue;
      const rootBlocked = atRoot && FRONTEND_EXCLUDE_ROOT.includes(ent.name);
      if (ent.isDirectory()) { walk(abs, false, insideExcluded || rootBlocked); continue; }
      if (!ent.name.endsWith('.ts') && !ent.name.endsWith('.tsx')) continue;
      if (FE_TEST_HINT.test(ent.name) || ent.name.endsWith('.d.ts')) continue;
      const excluded = insideExcluded || rootBlocked;
      out.push({ abs, rel: path.relative(repoRoot, abs).split(path.sep).join('/'), excluded });
    }
  };
  walk(repoRoot, true, false);
  return out;
}

/** 被排除目录**各自**丢掉多少命中（复核 M-1：光打印排除项的名字不给代价，等于没说）。 */
export function frontendExclusionCost(repoRoot) {
  const cost = {};
  for (const f of enumerateFrontendSources(repoRoot)) {
    if (!f.excluded) continue;
    const top = f.rel.split('/')[0];
    const lines = stripComments(fs.readFileSync(f.abs, 'utf8')).split('\n')
      .filter((l) => { const t = l.trim(); return t && !t.startsWith('//') && !t.startsWith('*')
        && Object.values(FRONTEND_LEAK_SHAPES).some((rx) => rx.test(l)); }).length;
    if (lines) cost[top] = (cost[top] || 0) + lines;
  }
  return cost;
}

/**
 * 扫前端源码（含 `.tsx`），返回 `[{ rel, lines: [{ line, hits: [shape…] } }]`。
 * 扫描根 = **仓根本身**（黑名单剪枝），不再依赖一份会漏的目录白名单。
 */
export function scanFrontendSources(repoRoot) {
  const out = [];
  for (const f of enumerateFrontendSources(repoRoot)) {
    if (f.excluded) continue;
    const abs = f.abs;
    const src = stripComments(fs.readFileSync(abs, 'utf8'));
    const lines = [];
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      const hits = Object.entries(FRONTEND_LEAK_SHAPES).filter(([, rx]) => rx.test(line)).map(([k]) => k);
      if (hits.length) lines.push({ line: i + 1, text: t, hits });
    });
    if (lines.length) out.push({ rel: f.rel, lines });
  }
  return out;
}

/**
 * 一次遍历同时给出总数、形状计数与**优先级互斥**的落点分桶。优先级：console > toast > 具名错误态 > 其余可见。
 * 返回 `{ totalLines, files, buckets, shapes, overlapLines }`。
 *
 * ★ v2.47 复核 I-1：旧版末尾那条"`sum(buckets) === totalLines` 否则抛错"看着像自检，其实**永远为真**
 *   （同一行 `totalLines += 1` 与某个 `buckets += 1` 挂在同一条 if/else 链上 ⇒ 是恒等式，抓不到任何真失效）。
 *   它当初想防的是"桶重叠导致加不回来"（202+11+1≠232 那一次），而重叠恰恰被 `else if` **静默消解**了
 *   —— 一行既是 `set*Error(` 又是 toast 时只进 toast 一个桶，谁也不知道丢了什么。
 *   现在：恒等式保留但**改名为它真正防的东西**（分桶分支漏写 else），重叠另算一个 `overlapLines` **如实报数**。
 */
export function frontendLeakBuckets(repoRoot) {
  const buckets = { console: 0, toast: 0, setError: 0, otherVisible: 0 };
  const shapes = { interp: 0, concat: 0, setter: 0 };
  let totalLines = 0;
  let overlapLines = 0;
  let files = 0;
  for (const f of scanFrontendSources(repoRoot)) {
    files += 1;
    for (const h of f.lines) {
      totalLines += 1;
      for (const k of h.hits) shapes[k] += 1;
      // 「到底有几行同时像两类落点」—— 这就是上一版加不回去的那个差额，现在直接报出来
      const alt = [FE_LOG_ONLY.test(h.text), FE_TOAST.test(h.text), h.hits.includes('setter')].filter(Boolean).length;
      if (alt > 1) overlapLines += 1;
      if (FE_LOG_ONLY.test(h.text)) buckets.console += 1;
      else if (FE_TOAST.test(h.text)) buckets.toast += 1;
      else if (h.hits.includes('setter')) buckets.setError += 1;
      else buckets.otherVisible += 1;
    }
  }
  const bucketSum = Object.values(buckets).reduce((a, b) => a + b, 0);
  if (bucketSum !== totalLines) {
    // ⚠️ 恒等式：只要分桶链有 `else` 兜底就成立。它防的是"以后有人加分支时漏了兜底"，**不防重叠**。
    throw new Error(`B74 尺自检失败：落点分桶 ${bucketSum} 加不回总行 ${totalLines} ⇒ 分桶分支漏了兜底`);
  }
  return { totalLines, files, buckets, shapes, overlapLines };
}

