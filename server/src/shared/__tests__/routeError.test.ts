// V1 2026-10-01: development route now uses typed error adapter; raw response debt decreased by one.
/**
 * 「原始错误不外泄」守卫（2026-09-17）
 *
 * ── 病灶 ─────────────────────────────────────────────────
 * 全仓曾 **277 处**形如 `res.status(500).json({ ..., message: String(e?.message ?? e) })`，
 * 把**原始错误**（Prisma 原文 / SQL 片段 / 表名列名 / 内部路径）**直接返回给前端**。
 * 用户看到的是「服务器错误」，屏幕上却出现 `PrismaClientKnownRequestError: Invalid …`。
 *
 * ── 本文件钉三件事 ───────────────────────────────────────
 *   1. **真源语义**：`safeRouteError` 必须
 *      · 业务错误（`code` 是 string **且** `statusCode` 是 number）→ **原样透传**
 *        （这是有意给用户看的文案；且要用它自己的 statusCode，避免「业务码兜成 500」）
 *      · 其余（未预期异常）→ **通用文案**，原始错误只进日志
 *   2. **棘轮**：`res.status(N).json(...e?.message...)` 的**逐文件计数必须等于冻结基线**
 *      —— 新增即红；**修好一处也必须回来改基线**（防「修完了没人知道」）
 *   3. **试点文件已归零**：`entities/route.ts` 必须为 0 处且引用了真源
 *
 * ⚠️ 计数前**必须剥注释**（否则解释这个写法的注释会把自己算成违规，实测假红）。
 * ⚠️ 扫源码**必须排除 `__tests__`**（守卫自己的样本字符串会被算进去）。
 * ⚠️ **不要**对剩余 272 处做脚本机械替换：很多站点写的是 `e?.message || 'failed to X'`，
 *    其中 `e.message` **可能本身就是业务文案**（如「币种必填」），机械替换会**吞掉业务文案**。
 *    逐处核准后收敛。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRouteError, GENERIC_ROUTE_ERROR_MESSAGE } from '../routeError';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/shared/__tests__
const SRC = path.resolve(HERE, '..', '..'); // server/src

/**
 * 目标违规写法：`res.status(<任意>).json(... e?.message ...)`（单行）。
 *
 * ★★ 2026-09-17 **加宽**：原正则写作 `res\.status\([0-9]+\)` —— 只认**字面数字**状态码，
 *    于是 `res.status(code)` / `res.status(status)` 这类**变量状态码**站点**从未被计数**。
 *    实测：窄口径 21 文件 / 203 处，宽口径 **25 文件 / 252 处** ——
 *    **49 处不可见**，其中含 **2 个从未进入基线的整文件**（`workflow/workflowRoute.ts` 4 ·
 *    `traceability/traceabilityRoute.ts` 1）。
 *    ⇒ **又一次「守卫的覆盖面 < 问题的写法面」**（同批次 9 的结构守卫教训）。
 *    加宽后仍不误伤已收敛代码：收敛后写的是 `message: r.message`，不含 `e?.message`。
 *
 * ★★★ 2026-09-22（v2.46）**同一个尺第三次被形状变化打瞎**：`[^)]*` 要求 `res.status(` 与 `)` 之间
 *    **不含右括号**，于是 B68-1 把状态档换成函数调用之后——
 *      `res.status(statusFromError(e, 500)).json({ error: 'X', message: String(e?.message || e) })`
 *    ——**外泄照旧，计数却少了 2**（`customs/customsRoute.ts` 基线 12 → 实测 10）。
 *    这就是"账面变好其实是尺认不住了"的形状：**允许 `status(...)` 里嵌一层括号**才是这条落点的正确判据。
 *    ⇒ 尺改为从 `scripts/lib/errorDebtScanners.mjs` **import**（本文件原先自带一份正则 + 一份 walk，
 *    这就是 R2 那个老病：判据活两处，改一处漏一处）。允许一层嵌套；仍不认两层以上
 *    （`res.status(Math.min(a, f(b)))`）、也不认捕获变量不叫 `e` 的写法（`err?.message`）
 *    ⇒ 两类残余盲区连同"落点口径"读数一起登记为 **B73**。
 *    ⚠️ 加宽前后两个数**不可互相加减**（台账里 277 / 272 / 252 都是旧尺读数）。
 */
import {
  RAW_LEAK_V1_RE as RAW_ERROR_LEAK_V1_RE, RAW_LEAK_V2_RE as RAW_ERROR_LEAK_RE,
  scanSources, stripComments,
} from '../../../scripts/lib/errorDebtScanners.mjs';

/** scanSources 要的是 **server 目录**（它自己再拼 `src`），不是 `server/src`；
 *  它给的 rel 带 `src/` 前缀，而本表基线的键名是**去掉 `src/`** 的历史形状 ⇒ 统一在这里换算，别在基线里改键名 */
const SERVER_ROOT = path.resolve(HERE, '..', '..', '..');
const ENTRIES = scanSources(SERVER_ROOT).map((e) => ({ ...e, rel: e.rel.replace(/^src\//, '') }));

function scanLeaks(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { rel, src } of ENTRIES) {          // scanSources 返回的 src 已剥注释
    const n = (src.match(RAW_ERROR_LEAK_RE) ?? []).length;
    if (n > 0) out[rel] = n;
  }
  return out;
}

/**
 * ★ 冻结基线（2026-09-17，`entities/route.ts` 5 处已收敛 → 277 → 272）。
 * **只许减不许增**；修好一处必须回来把这里减 1（否则红）。
 *
 * ★★ 2026-09-22（v2.46）随尺加宽一起**重新冻结**：17 文件 / 139 处 → 17 文件 / **223** 处（+84）。
 *   这 84 处**不是新增欠债**，是旧尺一直看不见的落点（同一把新尺量改动前的源码 = 222 处，
 *   本批净增 1 处只是把 `msg` 变量换回一行内的 `String(e?.message || e)`，外泄本身改造前就有）：
 *     customs/customsRoute.ts 12→46 · customs/customsRouteV2.ts 11→33 · mes/mesRoute.ts 11→33 · crm/crmRoute.ts 27→33
 *   归因方式：对 `85a66cd2` 与工作树各跑一次同一条正则（前四个数即该次归因读数）。
 *   ⚠️ 台账里 277 / 272 / 139 都是**旧尺**口径，与本表不可互相加减（§0.3 两口径禁换算）。
 *   ⇒ 已按 D49 新立 **B73** 记这条落点的剩余盲区（两层嵌套、`err?.message` 命名变体、跨行 json）。
 *
 * ⚠️ **v3.84 就地更正（原文保留在上，不删）**：上面那句 "17 文件 / **223** 处" 是 **v2.46 冻结当时**的读数，
 *   不是现值 —— 它一直被后来者读成"当前基线"。现值 = **下面这张表逐行相加** = **16 文件 / 213 处**
 *   （静态副本；`server/scripts/measure-error-debt.mjs` 的 V2 口径**现算**也是 213 ⇒ 相等只证"副本没发霉"）。
 *   223 → 213 已逐笔归因到两个 commit（机械取法：`git log -- 本文件` 逐个版本对表求和，v3.84 现量）：
 *     v2.92 `c5337824`：17 文件 / 223 → 16 文件 / 220 · v3.03 `93ef1aef`：16 文件 / 220 → 16 文件 / 213。
 */
const FROZEN_RAW_ERROR_LEAKS: Record<string, number> = {
  'bom/bomRoute.ts': 2,
  'crm/crmRoute.ts': 33,
  'crm/crmRouteV2.ts': 1,
  'customs/customsRoute.ts': 46,
  'customs/customsRouteV2.ts': 26, // V1: declaration list/detail now use safe typed errors; original 9 actual-PG read/SQL controls passed. Other raw outlets retained.
  // email/route.ts 与 email/templateRoute.ts 曾各 7 处：S0-A2 第 10 批（B42 A1）首版 14 处接真源后归零，故从基线删除
  'inventory/inventoryRoute.ts': 11,
  'marketing/marketingRouteV2.ts': 10,
  'mes/mesRoute.ts': 33,
  'orders/route.ts': 1,
  'procurement/procurementRoute.ts': 21, // actual native PO/receipt instance branch plus safe unknown fallback; other 21 unchanged.
  // 92df64c5 native inspection catch uses safeRouteError; actual raw site retired.
  'quotations/quotationRoute.ts': 15, // v3.03：两审批站**刻意不收**（复核 B-1，收了会吞掉 NO_REVIEWER_RESOLVED 的业务文案）
  'traceability/traceabilityRoute.ts': 1,
};

const SCAN_TIMEOUT_MS = 30_000;
let _scanned: Record<string, number> | null = null;
function scanned(): Record<string, number> {
  if (!_scanned) _scanned = scanLeaks();
  return _scanned;
}

describe('★ routeError 真源语义', () => {
  it('★ 业务错误（code + statusCode）原样透传，且用自己的 statusCode', () => {
    const e = Object.assign(new Error('币种不一致'), { code: 'CURRENCY_MISMATCH', statusCode: 400 });
    const r = safeRouteError(e, { fallbackCode: 'CREATE_FAILED' });
    expect(r).toEqual({
      status: 400,
      code: 'CURRENCY_MISMATCH',
      message: '币种不一致',
      passthrough: true,
    });
  });

  it('★ 未预期异常 → 通用文案，绝不回显原始信息', () => {
    const e = new Error('PrismaClientKnownRequestError: Invalid `prisma.order.findMany()` invocation in /Users/panda1/bambook-main-api/src/orders/route.ts:42');
    const r = safeRouteError(e, { fallbackCode: 'ENTITY_SEARCH_FAILED' });
    expect(r.status).toBe(500);
    expect(r.code).toBe('ENTITY_SEARCH_FAILED');
    expect(r.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    expect(r.passthrough).toBe(false);
    // 原始信息一个字都不能出现在响应里
    expect(r.message).not.toContain('Prisma');
    expect(r.message).not.toContain('bambook-main-api');
    expect(JSON.stringify(r)).not.toContain('prisma.');
  });

  it('★ 只有 code 没有 statusCode → 不视为业务错误（否则又会外泄）', () => {
    const e = Object.assign(new Error('内部细节'), { code: 'P2025' });
    const r = safeRouteError(e, { fallbackCode: 'X_FAILED' });
    expect(r.passthrough).toBe(false);
    expect(r.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    expect(r.message).not.toContain('内部细节');
  });

  it('code 不是 string / statusCode 不是 number → 一律按未预期处理', () => {
    for (const e of [
      Object.assign(new Error('a'), { code: 123, statusCode: 400 }),
      Object.assign(new Error('b'), { code: 'X', statusCode: '400' }),
      Object.assign(new Error('c'), { code: 'X' }),
      Object.assign(new Error('d'), { statusCode: 400 }),
    ]) {
      const r = safeRouteError(e, { fallbackCode: 'X_FAILED' });
      expect(r.passthrough).toBe(false);
      expect(r.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    }
  });

  it('非 Error 值（null / undefined / string / 对象）不炸且一律通用文案', () => {
    for (const e of [null, undefined, 'boom', 42, {}, []]) {
      const r = safeRouteError(e, { fallbackCode: 'X_FAILED' });
      expect(r.status).toBe(500);
      expect(r.passthrough).toBe(false);
      expect(r.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    }
  });

  it('fallbackMessage / status 可覆盖', () => {
    const r = safeRouteError(new Error('x'), {
      fallbackCode: 'Y_FAILED',
      fallbackMessage: '查询失败，请稍后重试',
      status: 503,
    });
    expect(r).toMatchObject({ status: 503, code: 'Y_FAILED', message: '查询失败，请稍后重试' });
  });
});

describe('★ 棘轮守卫：原始错误不外泄（只许减不许增）', () => {
  it('逐文件计数必须等于冻结基线（新增即红；修好一处必须回来改基线）', () => {
    expect(scanned()).toEqual(FROZEN_RAW_ERROR_LEAKS);
  }, SCAN_TIMEOUT_MS);

  it('★ 试点文件已归零：entities/route.ts 无残留且引用真源', () => {
    expect(scanned()['entities/route.ts']).toBeUndefined();
    const src = fs.readFileSync(path.join(SRC, 'entities', 'route.ts'), 'utf8');
    expect(src).toMatch(/from '\.\.\/shared\/routeError'/);
    expect(stripComments(src)).not.toMatch(RAW_ERROR_LEAK_RE);
  });

  it('★ 守卫自检：剥注释后计数不把「解释该写法的注释」算进去', () => {
    const sample = [
      "// 旧写法 res.status(500).json({ message: e?.message }) 是错的",
      "/* 也别写 res.status(500).json({ message: e?.message }) */",
      "res.status(500).json({ error: 'X_FAILED', message: '通用文案' });",
      "res.status(500).json({ error: 'Y_FAILED', message: String(e?.message ?? e) });",
    ].join('\n');
    expect((stripComments(sample).match(RAW_ERROR_LEAK_RE) ?? []).length).toBe(1); // 只有第 4 行
  });

  it('★ 守卫自检：真实违规行必须被算到（防止正则退化成恒不匹配）', () => {
    for (const s of [
      "res.status(500).json({ error: 'X_FAILED', message: String(e?.message ?? e) });",
      "res.status(400).json({ error: e?.message || 'failed' });",
    ]) {
      expect((stripComments(s).match(RAW_ERROR_LEAK_RE) ?? []).length).toBe(1);
    }
    // 反向：已收敛的写法不该被误伤
    expect((stripComments("res.status(r.status).json({ error: r.code, message: r.message });").match(RAW_ERROR_LEAK_RE) ?? []).length).toBe(0);
  }, SCAN_TIMEOUT_MS);

  /**
   * ★ v2.46 补：尺的**第三种被绕形状**必须由这条钉住。把 `status(...)` 里的函数调用去掉，
   *   或把 `[^)]*` 改回去 ⇒ 第二条立刻红（这就是"把缺陷放回去哪条会红"）。
   */
  it('★ 守卫自检：状态档是**函数调用**（内含括号）时外泄仍必须被数到', () => {
    const nested = "res.status(statusFromError(e, 500)).json({ error: 'X_FAILED', message: String(e?.message || e) });";
    expect((stripComments(nested).match(RAW_ERROR_LEAK_RE) ?? []).length).toBe(1);
    const two = nested + "\n" + "res.status(statusFromError(e, 400)).json({ error: e?.message });";
    expect((stripComments(two).match(RAW_ERROR_LEAK_RE) ?? []).length).toBe(2);
    // 两层嵌套是本尺的**已知残余盲区**，写在这里是登记而不是隐藏（实测存量见 measure-error-debt.mjs 的 B73 口径）
    const deep = "res.status(Math.min(500, f(e, 500))).json({ message: e?.message });";
    expect((stripComments(deep).match(RAW_ERROR_LEAK_RE) ?? []).length).toBe(0);
    // 第二处盲区：捕获变量不叫 `e`（本尺的字面量写死 `e?.message`）⇒ 同一件事换个变量名就漏
    const otherName = "res.status(statusFromError(err, 500)).json({ message: err?.message });";
    expect((stripComments(otherName).match(RAW_ERROR_LEAK_RE) ?? []).length).toBe(0);
  });

  /**
   * ★ B73 的**存量证据**（在同一把尺的家里量，不再靠当场现写脚本）：
   *   旧形状 V1 与现形状 V2 跑同一份源码 ⇒ 差额就是"尺瞎了多少处"。
   *   这条断言不锁死差额（差额会随收敛变小是好事），只锁死**差额必须存在**且**四个已知文件都在**：
   *   哪天有人把 V2 换回 V1，第二条会当场红（因为它要求 V2 严格多于 V1）。
   */
  it('★ B73：V1（旧形状）与 V2（现形状）在同一份源码上的差额 = 尺的盲区，必须被看见', () => {
    let v1 = 0, v2 = 0;
    const blind: Record<string, [number, number]> = {};
    for (const { rel, src } of ENTRIES) {
      const a = (src.match(RAW_ERROR_LEAK_V1_RE) ?? []).length;
      const b = (src.match(RAW_ERROR_LEAK_RE) ?? []).length;
      v1 += a; v2 += b;
      if (a !== b) blind[rel] = [a, b];
    }
    expect(v2, 'V2 不多于 V1 ⇒ 尺被换窄了（或者已经全部收敛，那要连基线一起删）').toBeGreaterThan(v1);
    console.log(`\n[B73] 同一份源码：旧尺 V1 ${v1} 处 / 现尺 V2 ${v2} 处 ⇒ 盲区 ${v2 - v1} 处，涉及 ${Object.keys(blind).length} 个文件`);
    console.log(`[B73] 明细 ${JSON.stringify(blind)}`);
    for (const f of ['customs/customsRoute.ts', 'customs/customsRouteV2.ts', 'mes/mesRoute.ts', 'crm/crmRoute.ts']) {
      expect(blind[f], `${f} 是本次发现盲区的现场，必须仍在差额清单里`).toBeTruthy();
    }
  });
});
