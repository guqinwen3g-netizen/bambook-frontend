// V1 2026-10-01: total -2 (admin -1, dashboard -1); four existing validation results move to truth-side candidates; no increased raw leak budget.
/**
 * B22 棘轮：`message: <变量>.message`（内部异常原文直上响应体）逐文件基线，**只许减不许增**。
 *
 * ── 为什么要一条棘轮而不是一段"以后再说"的文字 ──────────────────
 * §9 B22 长期只是一行「还有 N 处」的文字描述，而 N 从来没人重测：
 * 本次实测口径下是 **368 处 / 67 个文件**，文档写的是「267 处 / 41 个文件」（无出处，已按 §0.3 更正）。
 * ★ 2026-09-20 两处更正（同一天、同一口径重测，不是另立一套数）：
 *   ① 基线随收敛下降：`hr/route.ts` 36 处清零 ⇒ 235 → 199（未接真源那侧）、46 → 45 个文件；
 *      同日第 2 域 `finance/route.ts` 27 处清零 ⇒ 未接真源侧 **199 → 172 处 / 45 → 44 个文件**；
 *   ② **判据本身有洞**：`message: r.message`（r = safeRouteError/resolveError 的结果）本是收敛完成态，
 *      旧正则把它和 `message: err.message` 一起数 ⇒ 368 虚高 111 处 / 21 个文件，
 *      且**棘轮永远不可能因收敛而变绿**。修好后总量 = **257 处 / 53 个文件**（已接真源侧 58 处），再经第 2、3 域收敛降到 **208 处 / 51 个文件**（未接真源侧 235 → 199 → 172 → 150 → **131 → 110 处 / 46 → 41 个文件**）。
 *   两个数都带取样时间：新口径 2026-09-20 09:52 实测（本文件的表就是它的落盘处）。
 * 文字会随时间失真，**基线表不会** —— 它每次跑套件都重算一遍，涨了就红。
 *
 * 口径（写死在这里，避免又变成"三个数字并存"）：
 *   · 范围 = `server/src` 下全部 `.ts`，**排除** `__tests__/` 目录与 `​.test.ts` 文件（守卫自己的例子不算数）
 *   · **先剥块注释与行注释**（不剥会把"解释坏写法"的注释计进来 ⇒ 虚高，本仓老坑）
 *   · 判据 = 正则 `message:\s*<标识符>\??\.message` —— 即"把某个 error 对象的 message 字段直接写进响应体"
 *   · **按文件计数**，不是全仓一个数：这样每收敛一个文件就少一行，进度看得见，也不会被别处的增减抵消成假绿
 *
 * ⚠️ 已知**未覆盖**的同类外泄形态（本判据看不见，别把它当"外泄已清零"的依据）：
 *   `res.json({ error: e })` 整个对象外发、`stack` 外发、模板/导出物里带上原始异常文本。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './utils/sourceScan';
import { finiteMessageOffsets, readNativeProof } from './utils/nativeMessageProof';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/shared/__tests__
const SERVER = path.resolve(HERE, '..', '..', '..');       // server/
const nativeProof = readNativeProof(path.resolve(SERVER, '..'));

// 冻结基线（2026-09-20 08:19 实测，口径见文件头）。**只许减不许增**：
// 收敛一个文件就删掉它那一行；新增站点会让这里对不上 = 红。
const RAW_MESSAGE_LEAK_BASELINE: Record<string, number> = {
  'src/agent/toolRuntime.ts': 10,
  'src/marketing/marketingRouteV2.ts': 10,
  'src/reporting/reportDefinitionService.ts': 8,
  'src/inventory/inventoryRoute.ts': 6,
  'src/agent/agentLoop.ts': 5,
  'src/orders/orderLineMutationService.ts': 2, // Three caught raw messages removed; two original exclusivity-validator results remain.
  'src/reporting/route.ts': 5,
  'src/development/developmentCaseMutationService.ts': 4,
  'src/finance/voidDeleteService.ts': 4,
  'src/moq/moqRoute.ts': 4,
  'src/ai/knowledgeIngestService.ts': 3,
  'src/customs/customsRouteV2.ts': 2, // v3.03：/documents 列表那站也收了（该服务函数段内零 throw ⇒ 无业务文案可吞）
  'src/quotations/quotationRoute.ts': 3,
  'src/admin/route.ts': 1,
  'src/agent/checkpoint.ts': 2,
  'src/agent/orchestrator.ts': 2,
  'src/auth/route.ts': 2,
  'src/crm/crmRouteV2.ts': 2,
  'src/development/route.ts': 2,
  'src/orders/orderLifecycleService.ts': 2,
  'src/production/stageService.ts': 2,
  'src/shipping/shipmentMutationService.ts': 2,
  'src/templates/route.ts': 2,
  'src/tools/fabricCalculatorRoute.ts': 2,
  'src/agent/events.ts': 1,
  'src/ai/knowledgeDocumentsRoute.ts': 1,
  'src/ai/runner.ts': 1,
  'src/audit/createAuditMiddleware.ts': 1,
  'src/audit/route.ts': 1,

  'src/dictionaries/dataDictionaryService.ts': 1,
  'src/events/domainEventBus.ts': 1,
  'src/exceptions/exceptionRoute.ts': 1,
  'src/finance/allocationMutationService.ts': 1,
  'src/finance/invoiceMutationService.ts': 1,
  'src/finance/reconciliationService.ts': 1,
  'src/lib/asyncHandler.ts': 1,
  'src/orderChanges/orderChangeRequestService.ts': 1,
  'src/orders/route.ts': 1,
  'src/orders/routeV2.ts': 1,
  'src/production/route.ts': 1,
  'src/relations/routeV2.ts': 1,
  'src/samples/fabricShipmentSampleService.ts': 1,
  'src/shared/errorCodes.ts': 1,
  'src/traceability/traceabilityRoute.ts': 1,
};


/**
 * ★ 上面那张表是"总量"，这张才是**真正要清零的那一半**。
 *
 * 为什么必须拆开：`message: e.message` 这个数字今天已经是**混合语义**的了 ——
 *   · 文件**已接真源**（import shared/routeError · shared/errorCodes · lib/asyncHandler）：
 *     未预期异常在出口处已被 resolveError 换成注册表文案，能走到 `e.message` 的
 *     **只剩"有意抛给业务员看的业务文案"**（那是设计要透传的，不是泄漏）。
 *   · 文件**未接真源**：异常原文可以**直接上屏** ⇒ 这些才是 B22 的欠债本体
 *     （基线生成时 235 处，2026-09-20 hr 收敛后 199 处 —— 以表的实时合计为准，别引用注释里的数）。
 * 只钉总量的后果：下一批可以挑无害的那些改掉，危险的那些一处不动，棘轮照样"变好了"。
 *
 * 判"接没接真源"用的是和 `routeErrorSourceGuard` 同一套引用识别；两条守卫口径必须一致
 * （见下面那条交叉自检）。
 */
const UNFILTERED_LEAK_BASELINE: Record<string, number> = {
  'src/agent/toolRuntime.ts': 10,
  'src/marketing/marketingRouteV2.ts': 10,
  'src/reporting/reportDefinitionService.ts': 8,
  'src/inventory/inventoryRoute.ts': 6,
  'src/agent/agentLoop.ts': 5,
  'src/orders/orderLineMutationService.ts': 0, // Actual safeRouteError import moved two validators to truth-side; no raw-catch budget remains.
  'src/reporting/route.ts': 5,
  'src/development/developmentCaseMutationService.ts': 4,
  'src/finance/voidDeleteService.ts': 4,
  'src/ai/knowledgeIngestService.ts': 3,

  'src/agent/checkpoint.ts': 2,
  'src/agent/orchestrator.ts': 2,
  'src/auth/route.ts': 2,
  'src/crm/crmRouteV2.ts': 2,
  'src/orders/orderLifecycleService.ts': 2,

  'src/templates/route.ts': 2,
  'src/tools/fabricCalculatorRoute.ts': 2,
  'src/agent/events.ts': 1,
  'src/ai/knowledgeDocumentsRoute.ts': 1,
  'src/ai/runner.ts': 1,
  'src/audit/createAuditMiddleware.ts': 1,
  'src/audit/route.ts': 1,

  'src/dictionaries/dataDictionaryService.ts': 1,
  'src/events/domainEventBus.ts': 1,

  // ★ src/finance/invoiceMutationService.ts 于 2026-09-21（G-4 批）从本表移到 TRUTH_FILE_SITE_LEAKS：
  //   它为了拿 code→status 真源而 import 了 shared/errorCodes ⇒ 分类器把它判成"已接真源"。
  //   **欠债一条未增也未减**（总量表 RAW_MESSAGE_LEAK_BASELINE 仍记着它那一处），只是换了记账的侧。
  'src/finance/reconciliationService.ts': 1,
  'src/orderChanges/orderChangeRequestService.ts': 1,
  'src/relations/routeV2.ts': 1,
  'src/samples/fabricShipmentSampleService.ts': 1,
  'src/shared/errorCodes.ts': 1,
  'src/traceability/traceabilityRoute.ts': 1,
};

/**
 * ★ **B22 的第 4 次口径修正（2026-09-20 12:58，第 6 域 samples 收敛时撞出来）**
 *
 * 上面两张表按**文件**分"已接真源 / 未接真源"，可**收敛是按站点发生的**：
 * `samples/sampleRoute.ts` 因为有一个端点先接了 `safeRouteError`，整个文件被判成"已过滤"，
 * 于是它另外 **47 处 `message: e?.message ?? 'operation failed'`（真的是原始异常原文）**被归到
 * "有意透传业务文案，不算泄漏"那一侧 ⇒ **欠债本体那个数（110）从一开始就漏计了这 47 处**，
 * 占当时最大单块。根因与 D32/D35/D37 同一条：**拿文件级代理指标代替站点级事实**。
 *
 * 本表就是补上站点级视角：只扫"文件已接真源"的那些，把**变量不是 `safeRouteError`/`resolveError` 绑出来的**
 * 取用逐处列出。**⚠️ 认得率**：文本判据分不清"取的是不是**有意**透传的业务文案"（例如 `error.message`
 * 配合 `error.code` 一起出现的 typed-error），所以本表**不等于**欠债清单，它是**待逐处核准的候选清单**；
 * 每一条要么改接真源（从表里删掉），要么在这里注明"确为业务文案透传"并保留。
 * 取样 2026-09-20 13:01（samples 47 处清零之后）。只许减不许增。
 */
const TRUTH_FILE_SITE_LEAKS: Record<string, number> = {
  'src/orders/orderLineMutationService.ts': 2, // exclusive.error.message comes from findExclusiveCustomerConflict's deterministic business result, not a caught driver error.
  'src/development/route.ts': 2, // Existing two validators moved sides after the verified error adapter import; no leak removed.
  // V1: existing deterministic validation results moved across classifications
  // after real safe catch integration. None reads a caught SQL/driver message.
  'src/admin/route.ts': 1, // built.message: validated relation/order filter result.
  'src/shipping/shipmentMutationService.ts': 2, // smCheck.message: shipping-method validator.
  'src/finance/allocationMutationService.ts': 1, // v.message: allocation input validator.
  // ★ 2026-09-23 v3.03（S0-A2 文案线）：这两文件为接真源 import 了 shared/routeError ⇒ 从未接真源表挪到这里。
  //   ★ 挪侧**不等于**清零，但本批确实真清掉了一处，两者要分开写（复核 MINOR-1：原注释把 −6 全说成"只是换侧"）：
  //   · customsRouteV2：3 → **2**（**−1 是真收**：`/documents` 列表那站；剩下 2 处是详情/创建）——
  //     这些 catch 里**混着服务层的业务校验错**（`customsService.ts:264` 抛 plain Error('非法单据类型: X')，无 code/statusCode）
  //     ⇒ 换文案会吞掉用户该看的原因，属**行为回退**不是收敛 ⇒ 前置是服务改抛带 code+statusCode 的业务错（B53 同族），另批做。
  //   · quotationRoute：3 → 3（**没变**）。本尺只认 `message: X.message` 这一族，而那两站原本是 `message: String(e?.message ?? e)`
  //     ⇒ 本批收掉的 2 处**从一开始就不在这把尺的分子里**（数不变 ≠ 没做事；也别拿这把尺去量本批战果，见 `routeError.test.ts` 的 V2 尺 17 → 15）。
  //   · quotationRoute 剩下的 3 处是 `if (e?.code === 'NOT_FOUND')` 早退臂透传业务文案（有意保留，`quotationCopyB42.test.ts` ⑤ 钉着）。
  'src/customs/customsRouteV2.ts': 2, // v3.03 再 −1：详情/创建两站是刻意留的（理由见 customsCopyB42.test.ts 文件头）
  'src/quotations/quotationRoute.ts': 3,
  'src/moq/moqRoute.ts': 4,
  'src/production/stageService.ts': 2,
  // ★ 2026-09-21 G-4：本文件为拿 code→status 真源 import 了 shared/errorCodes ⇒ 从"未接真源"表挪到这里。
  //   该处已逐字核过（不是凭印象）：`:153` 的 `message: transition.message!` 出自
  //   `statusTransition.validateStatusTransition`，是状态机自己拼的模板串（"X cannot transition from 'A' to 'B'. Allowed: …"），
  //   **不含堆栈/SQL/驱动原文** ⇒ 不是 B22 那一族的外泄，按本表头注释"有意透传业务文案 ⇒ 注明并保留"处理。
  //   ⚠️ 但它也**不是给业务员看的话**（英文 + 枚举合法态，属 B42 文案质量族）—— 挪表不等于修好，已另记待办。
  //   另：本文件真正的原文直发风险在 `toError()` 的 `String(e?.message ?? e)`（未预期异常原文进响应体），
  //   它不匹配 LEAK_RE 的 `message: X.message` 形状 ⇒ **本表盖不住它**，按 D49 另立 §9 待办而不是改判据把它算成"已收敛"。
  'src/finance/invoiceMutationService.ts': 1,
  'src/exceptions/exceptionRoute.ts': 1,
  'src/lib/asyncHandler.ts': 1,
  'src/orders/route.ts': 1,
  'src/orders/routeV2.ts': 1,
  'src/production/route.ts': 1,
};

const LEAK_RE = /message:\s*([A-Za-z_$][\w$]*)\??\.message/g;

/**
 * ★ 口径修正（2026-09-20，B22 第 1 个域收敛时暴露）：同一文件里
 *   `const r = safeRouteError(...)` / `= resolveError(...)` 之后的 `message: r.message`
 *   是**收敛完成态**（`r.message` 出自注册表或业务错误自带的文案，不是原始异常），
 *   旧判据把它和 `message: err.message` 一起计数 ⇒ 越收敛数字越不降，棘轮**永远不会绿**。
 *   实测差额 111 处 / 21 个文件（368 → 257），已按新口径重生成两张基线表。
 *   排除条件写得很窄：只认「本文件内由那两个真源函数绑出来的标识符」，
 *   换个变量名再接原始 error 仍然照计（见下面的阳性对照）。
 */
const RESOLVED_BIND_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:safeRouteError|resolveError)\s*\(/g;

function countLeaksIn(src: string, relativeFile?: string): number {
  const resolved = new Set([...src.matchAll(RESOLVED_BIND_RE)].map((m) => m[1]));
  const proven = relativeFile ? finiteMessageOffsets(`server/${relativeFile}`, src, nativeProof.sources, nativeProof.receipt) : new Set<number>();
  return [...src.matchAll(LEAK_RE)].filter((m) => !resolved.has(m[1]) && !proven.has(m.index!)).length;
}

function countLeaksByFile(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.ts') || ent.name.endsWith('.test.ts')) continue;
      const n = countLeaksIn(stripComments(fs.readFileSync(abs, 'utf8')), path.relative(SERVER, abs).split(path.sep).join('/'));
      if (n > 0) out[path.relative(SERVER, abs).split(path.sep).join('/')] = n;
    }
  };
  walk(path.join(SERVER, 'src'));
  return out;
}

describe('B22 内部异常原文直上响应体 · 逐文件棘轮（只许减不许增）', () => {
  it('★ seven finite native results remain in the original bare grammar denominator, separately proven', () => {
    let proven = 0;
    for (const [file, count] of Object.entries(nativeProof.receipt.provenSites)) {
      const src = stripComments(nativeProof.sources[file]);
      const bare = countLeaksIn(src);
      expect(bare, file).toBe(count);
      expect(countLeaksIn(src, file.replace(/^server\//, '')), file).toBe(0);
      proven += bare;
    }
    expect(proven).toBe(7);
    expect(Object.values(countLeaksByFile()).reduce((a, b) => a + b, 0) + proven).toBe(114);
  });
  it('实际站点数不得高于基线，且每个文件都要对得上', () => {
    const actual = countLeaksByFile();
    const grew = Object.entries(actual).filter(([f, n]) => (RAW_MESSAGE_LEAK_BASELINE[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${RAW_MESSAGE_LEAK_BASELINE[f] ?? 0} → 实际 ${n}`);
    expect(grew, `新增/恶化的外泄站点（收敛别的文件不算数，这里必须为 0）：${JSON.stringify(grew)}`).toEqual([]);
    const shrunk = Object.entries(RAW_MESSAGE_LEAK_BASELINE).filter(([f, n]) => (actual[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${n} → 实际 ${actual[f] ?? 0}`);
    expect(shrunk, `已经改好了就把基线一并改小（棘轮只减不增，留旧数 = 掩盖下一次回潮）：${JSON.stringify(shrunk)}`).toEqual([]);
  });

  it('★ 阳性对照：判据认得真站点、不被注释假红、认得可选链', () => {
    const sample = [
      "res.status(500).json({ error: { message: e?.message } });",
      "return res.json({ message: err.message });",
      "const label = 'x'; return { message: name.message };",
      "// 旧写法 res.json({ message: e.message }) 会外泄，已废弃",
      "/* const o = { message: ex.message }; */",
      "res.json({ message: '装载失败，请重试' });",
    ].join('\n');
    // 三行真站点 + 两行注释里的例子 = 不剥注释会数到 5；剥完剩 3（口径与基线生成时完全一致）
    expect((sample.match(LEAK_RE) ?? []).length).toBe(5);
    expect(countLeaksIn(stripComments(sample))).toBe(3);
  });

  it('★ 阳性对照 2（口径修正）：真源解析结果的透传不算外泄，换个变量名接原文仍要算', () => {
    const converged = [
      "const r = safeRouteError(err, { fallbackCode: 'X_FAILED' });",
      "res.status(r.status).json({ ok: false, message: r.message });",
    ].join('\n');
    expect(countLeaksIn(converged), '收敛完成态被算成外泄 ⇒ 棘轮永远不会绿（这就是 2026-09-20 修掉的洞）').toBe(0);
    // 反向 1：解析结果赋给别的变量、再把**原始** error 写进响应 ⇒ 必须照计
    const relapse = [
      "const r = safeRouteError(err, { fallbackCode: 'X_FAILED' });",
      "res.status(r.status).json({ ok: false, message: err.message });",
    ].join('\n');
    expect(countLeaksIn(relapse)).toBe(1);
    // 反向 2：只是同名变量、来源不是那两个真源函数 ⇒ 不许免计（防"起个名叫 r"绕过守卫）
    const fakeName = [
      "const r = { message: db.lastError };",
      "res.json({ message: r.message });",
    ].join('\n');
    expect(countLeaksIn(fakeName)).toBe(1);
    // resolveError 直调那一支同样认（risk 试点的形状就是它）
    expect(countLeaksIn([
      "const r = resolveError(e, 'Y_FAILED');",
      "res.json({ message: r.message });",
    ].join('\n'))).toBe(0);
  });

it('★ 未接真源的那一半（B22 欠债本体）只许减不许增，且总数必须等于两表之和的口径', () => {
    const actual = countLeaksByFile();
    const truthRe = /from '[.\w/]*shared\/(routeError|errorCodes)'|from '[.\w/]*lib\/asyncHandler'/;
    const unfiltered: Record<string, number> = {};
    for (const [f, n] of Object.entries(actual)) {
      const src = stripComments(fs.readFileSync(path.join(SERVER, f), 'utf8'));
      if (!truthRe.test(src)) unfiltered[f] = n;
    }
    const grew = Object.entries(unfiltered).filter(([f, n]) => (UNFILTERED_LEAK_BASELINE[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${UNFILTERED_LEAK_BASELINE[f] ?? 0} → 实际 ${n}`);
    expect(grew, `未接真源的文件里外泄站点变多：${JSON.stringify(grew)}`).toEqual([]);
    const stale = Object.entries(UNFILTERED_LEAK_BASELINE).filter(([f, n]) => (unfiltered[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${n} → 实际 ${unfiltered[f] ?? 0}`);
    expect(stale, `已经收敛了就同步改小基线（留旧数会掩盖下一次回潮）：${JSON.stringify(stale)}`).toEqual([]);
    // 两表相加 = 总量表（口径自洽：一个站点必落在一侧，不重不漏）
    const sumU = Object.values(unfiltered).reduce((a, b) => a + b, 0);
    const sumAll = Object.values(actual).reduce((a, b) => a + b, 0);
    // ★ v2.93（复核 IMPORTANT-5 成立）：这里原先钉字面量 12 —— 与 TRUTH_FILE_SITE_LEAKS 的和、
    //   与本文件 :294 的"候选清单总数"共三处真源（同一个数抄三遍 = 本仓头号病）。
    //   改成从那张表**派生**：本条于是回到它本来的作用——比"扫描得到的两侧之差"与"真源表之和"是否一致。
    //   :294 仍留一个字面量当总账钉（只减不增），所以"数"的冻结点从三处降到一处。
    expect(sumAll - sumU, '已接真源侧仍直取原始异常的站点数（应与 TRUTH_FILE_SITE_LEAKS 之和一致）')
      .toBe(Object.values(TRUTH_FILE_SITE_LEAKS).reduce((a, b) => a + b, 0));
  });

  it('★ 站点级补刀：已接真源的文件里仍在直取原始异常的站点 = 候选清单（只减不增）', () => {
    const truthRe = /from '[.\w/]*shared\/(routeError|errorCodes)'|from '[.\w/]*lib\/asyncHandler'/;
    const actual: Record<string, number> = {};
    for (const [f, n] of Object.entries(countLeaksByFile())) {
      const src = stripComments(fs.readFileSync(path.join(SERVER, f), 'utf8'));
      if (truthRe.test(src)) actual[f] = n;
    }
    const grew = Object.entries(actual).filter(([f, n]) => (TRUTH_FILE_SITE_LEAKS[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${TRUTH_FILE_SITE_LEAKS[f] ?? 0} → 实际 ${n}`);
    expect(grew, `真源文件里新长出/回潮的原始取用：${JSON.stringify(grew)}`).toEqual([]);
    const stale = Object.entries(TRUTH_FILE_SITE_LEAKS).filter(([f, n]) => (actual[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${n} → 实际 ${actual[f] ?? 0}`);
    expect(stale, `已经核准/改接了就同步删掉那一行（留着会把下一次回潮算成正常）：${JSON.stringify(stale)}`).toEqual([]);
    expect(Object.values(actual).reduce((a, b) => a + b, 0), '候选清单总数').toBe(25); // V1: two existing exclusivity validators moved sides, three caught raw messages were removed. Historical 12 → 17（v3.03）：两文件接真源后挪进本侧（customs 2 + quotation 3 = +5）；★ 其中 **0 处新增**，且对面少了 6 ⇒ 差的那 1 处是**真清掉的**（`/documents` 列表），不是换侧
    // ★ 本批的正面证据：samples 那 47 处正是藏在这一侧（文件早已 import 真源 ⇒ 被文件级分类判成"已过滤"）
    expect(truthRe.test(stripComments(fs.readFileSync(path.join(SERVER, 'src/samples/sampleRoute.ts'), 'utf8'))),
      'samples 早已接真源 ⇒ 旧口径会把它整文件算成无害').toBe(true);
    expect(actual['src/samples/sampleRoute.ts'] ?? 0,
      'samples 站点级必须已清零（第 6 域收口）').toBe(0);
    expect('src/samples/sampleRoute.ts' in TRUTH_FILE_SITE_LEAKS).toBe(false);
    // 阳性对照：**同一个文件里**既有收敛完成态又有原始取用时，本判据必须只放过前者、仍数到后者
    expect(countLeaksIn([
      "import { safeRouteError } from '../shared/routeError';",
      "const r = safeRouteError(err, { fallbackCode: 'A_FAILED', fallbackMessage: 'A 失败' });",
      "res.status(r.status).json({ error: { code: r.code, message: r.message } });",
      "res.status(500).json({ error: { code: 'B_FAILED', message: err.message } });",
    ].join('\n')), '已收敛文件里那处未收敛的必须被数到（否则文件级分类会继续掩盖）').toBe(1);
  });

  it('★ 交叉自检：真源识别必须认得「已收敛」与「未收敛」两类真文件（防分类器反向失灵）', () => {
    const read = (rel: string) => stripComments(fs.readFileSync(path.join(SERVER, 'src', rel), 'utf8'));
    const truthRe = /from '[.\w/]*shared\/(routeError|errorCodes)'|from '[.\w/]*lib\/asyncHandler'/;
    expect(truthRe.test(read('risk/riskRoute.ts')), 'risk 已接真源 ⇒ 必须判为「已过滤」').toBe(true);
    // 未收敛侧的样本改用 `inventory/inventoryRoute.ts`（shipping 已于 2026-09-20 第 5 域收敛 ⇒ 它现在是
    // "已接真源"的例子，再拿它当反例会把这条自检变成恒假）。两例都必须是**真文件**，不拿合成串糊。
    expect(truthRe.test(read('inventory/inventoryRoute.ts')), 'inventory 尚未接 ⇒ 必须判为「未过滤」').toBe(false);
    expect(UNFILTERED_LEAK_BASELINE['src/inventory/inventoryRoute.ts'], 'inventory 在未过滤清单里必须有数').toBeGreaterThan(0);
    // 反向：shipping 现在必须落在"已接真源"那一侧（收敛一处 ⇒ 分类跟着变，这条盯的就是分类本身）
    expect(truthRe.test(read('shipping/route.ts')), 'shipping 已接真源 ⇒ 必须判为「已过滤」').toBe(true);
    expect('src/risk/riskRoute.ts' in UNFILTERED_LEAK_BASELINE).toBe(false);
  });

  it('★ 基线自身不是空表（空表 = 恒绿 = 没守卫）', () => {
    const total = Object.values(RAW_MESSAGE_LEAK_BASELINE).reduce((a, b) => a + b, 0);
    const unfiltered = Object.values(UNFILTERED_LEAK_BASELINE).reduce((a, b) => a + b, 0);
    expect(total).toBe(107); // Fixed-source PDML one-site retirement: prior 108/45 remains in source receipt; no raw debt increase.
    expect(Object.keys(RAW_MESSAGE_LEAK_BASELINE).length).toBe(44);
    // 114 / 38：2026-09-22 v2.73 清掉 `systemConfigRoute` 的 3 处后同步（那批只同步了根侧那把尺，server 侧这三份基线漏改 ⇒ server 全量当场红）。
// 105 / 39：2026-09-21 G-4 起 原口径 ↓ `invoiceMutationService` 因 import 真源而被分类到另一侧
    //   ⇒ **未接真源侧少 1 处、已接真源侧多 1 处，总量表 117 一处未动**。
    //   这两个数一起看才不是"假装收敛"：只看 105 会以为少了一处欠债，其实只是换了记账的侧。
    expect(unfiltered, 'B22 欠债本体（未接真源、原文可直上屏）').toBe(82); // PDML's one real retirement lowers prior 83/31; truth-file debt is unchanged.
    expect(Object.keys(UNFILTERED_LEAK_BASELINE).length).toBe(30);
    // 两表相加必须仍等于总量表：挪侧（一份欠债从一侧记到另一侧）不许让任何一处掉出分母
    const truthSum = Object.values(TRUTH_FILE_SITE_LEAKS).reduce((a, b) => a + b, 0);
    expect(unfiltered + truthSum, `两表之和（${unfiltered}+${truthSum}）必须等于总量 ${total}，否则有一处被两侧同时漏计`).toBe(total);
    expect(total).toBeGreaterThan(0);
  });
});
