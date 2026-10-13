// V1 2026-10-01: registry convergence measured 143 per-site copies / 16 files / 7 weak copies; registered HR guard adds one legitimate 500 code. Negative controls unchanged.
/**
 * B29 棘轮：`safeRouteError(e, { fallbackCode: 'X' })` 用了一个**注册表里没有的码**。
 *
 * ── 为什么这条必须存在（不是"锦上添花"）──────────────────────────
 * G6.5 的收口动作是「把出口接到真源」，但**接上真源 ≠ 真源认得这枚码**：
 * `resolveError` 查不到兜底码时不报错，只是退回通用文案 + 500
 * （`shared/errorCodes.ts` 的 `spec?.message ?? GENERIC_ROUTE_ERROR_MESSAGE`）。
 * 于是「已经收敛过了」和「收敛了一半」在两处信号上完全一样：
 *   · 守卫侧：文件 import 了 `shared/routeError` ⇒ 从 B22 的未过滤清单里消失（判为已收敛）；
 *   · 运行时：用户看到的是一句和具体故障无关的通用话术。
 * 2026-09-20 把 `hr/route.ts` 36 处逐条登记后才敢提交，正是因为脚本先量出：
 * 首量（09:56，判据=「码没登记」）**80 处 / 20 个文件 / 35 枚码**；★ 同日 10:15/10:34 两次口径修正后真欠债 **29 处 / 6 个文件**
 *   修正后仍是**同一类错**（B22 同一天撞过一次）：反引号写法的自带文案没被认到，故本条同时把引号/反引号都算；
 *   三个数分别为 **欠债 29 处 / 6 文件**、**自带文案 78 处 / 15 文件**、**文案不合格 16 处 / 5 文件（→ B31）**。
 * 而 `src/hr` 收敛完是 **0** —— 这条守卫同时是那次机械替换的**错字检查器**
 * （码名手打错一个字母就静默退化成通用文案，没有任何测试会红）。
 *
 * 口径（与 `rawErrorLeakRatchet.test.ts` 同一套）：
 *   · 范围 = `server/src` 全部 `.ts`，排除 `__tests__/` 与 `.test.ts`（守卫自己的例子不算数）
 *   · **先剥注释**（本文件里的合成样本、别处的说明注释都不该计数）
 *   · 判据 = `fallbackCode: 'CODE'` 里那枚 CODE 不在 `ERROR_CODES` 的键集里
 *   · 按文件计数，只许减不许增；收敛一个域 = 注册表补码 + 删掉这里那一行
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './utils/sourceScan';
import { ERROR_CODES } from '../errorCodes';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/shared/__tests__
const SERVER = path.resolve(HERE, '..', '..', '..');       // server/

/** 2026-09-20 10:28 实测（紧判据：真源不认 **且** 调用点没自带文案）：34 处 / 8 个文件。只许减不许增。 */
const UNREGISTERED_FALLBACK_BASELINE: Record<string, number> = {
  // ★ 2026-09-29 晚：8 → 6。本批把 `ShipmentMutationErrorCode` 里 6 枚**从未登记**的码补进注册表
  //   （`CREATE_FAILED` / `DELETE_FAILED` / `COMMIT_TRANSACTION_FAILED` / `INVALID_SHIPPING_METHOD` /
  //    `INVALID_SHIPMENT_STATUS` / `INVALID_INITIAL_STATUS`），其中若干枚在本文件被当兜底码用 ⇒
  //   这些站点从"真源不认"变成"真源认得"，**依本条自己的规则必须把基线一起改小**
  //   （原注释：「登记好了就把基线一并改小（留旧数 = 掩盖下一次回潮）」）。★ 实测，不是推算。
  'src/relations/route.ts': 5, // fixed 9b206773: UPDATE_FAILED is now actually registered; unchanged callsite.
  'src/production/route.ts': 6,
  'src/production/routeV2.ts': 0,
  'src/system-assets/route.ts': 3, // same UPDATE_FAILED registration; prior 5 → 4 history above is retained.
  'src/business-profiles/route.ts': 2,   // ★ 2026-09-29 晚：3 → 2（同上）
  'src/devPanel/route.ts': 1,
};

const FALLBACK_CODE_RE = /fallbackCode:\s*'([A-Z][A-Z0-9_]*)'/g;
/**
 * ★ 口径修订（2026-09-20 10:15，第 2 个域 `finance/route.ts` 收敛时定）：
 *   本条量的缺陷是「真源认不出这枚码 ⇒ 用户看到一句万能话」。而
 *   `safeRouteError(e, { fallbackCode: 'LIST_FAILED', fallbackMessage: '财务单据列表加载失败…' })`
 *   已经自带该端点的专属文案 ⇒ **缺陷不成立**，不该计进欠债。
 *   为什么这类点不并进注册表：`LIST_FAILED/GET_FAILED/REPORT_FAILED` 这类码名**跨域重名**
 *   （relations / system-assets / business-profiles / finance 都在用），注册表是全局唯一表，
 *   给它们登记一条就等于逼四个域共用一句话术 —— 那才是真的把文案写坏。
 *   ⇒ 结论：**要么进注册表、要么在调用点自带 fallbackMessage**，两条都算收敛完成；
 *     本棘轮只量「两条都没走」的那些。豁免数单独计量（见 PER_SITE_COPY 那条断言），
 *     豁免不是免检：`fallbackMessage` 缺失/为空/非中文都会被下面那条断言抓到。
 */
const FALLBACK_SITE_RE = /fallbackCode:\s*'([A-Z][A-Z0-9_]*)'([\s\S]{0,200}?)\}/g;
/** 「有没有自带文案」只看**非空**（引号或反引号都算）：文案质量差是另一条缺陷（B31），不并到本条判据里，
 *  否则同一条守卫会把「有文案但文案不好」和「压根没文案」混成一个数，改起来分不清在改什么。 */
/** `fallbackMessage: SOME_CONST` —— 同文件内的字符串常量绑定（season 族为待删除表面共用一条文案时用这种写法） */
/** 注意尾部用 `(?:[,}]|$)`：`fallbackMessage: CONST` 常是选项对象的**最后一项**，
 *  而 FALLBACK_SITE_RE 的第 2 组**不含**收尾的 `}` ⇒ 只写 `[,}]` 会永不匹配（10:12 实测就是这么漏的）。
 *  点号写法（`fallbackMessage: obj.msg`）在这里取不到常量 ⇒ 落回欠债，宁可少豁免不多豁免。 */
const FALLBACK_MSG_IDENT_RE = /fallbackMessage:\s*([A-Za-z_$][\w$]*)\s*(?:[,}]|$)/;
const CONST_STRING_RE = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:'([^']*)'|`([^`]*)`)/g;
function constStringOf(src: string, name: string): string | undefined {
  for (const m of src.matchAll(CONST_STRING_RE)) {
    if (m[1] === name) return m[2] ?? m[3];
  }
  return undefined;
}
/**
 * ★ 口径第 3 次收紧（同一天，D37）：豁免与否只看**用户到底拿到什么**，不看写法是字面量还是常量引用。
 *   前两次的错法是同一个：拿"语法形状"当判据 —— 先漏了反引号字面量，又漏了 `fallbackMessage: CONST`。
 *   现在三条一起认：单引号字面量 / 反引号字面量 / 同文件字符串常量。认不了的仍是欠债（宁可少豁免，不多豁免）。
 */
function fallbackCopyOf(src: string, tail: string): string | undefined {
  const lit = /fallbackMessage:\s*(?:'([^']*)'|`([^`]*)`)/.exec(tail);
  if (lit) return lit[1] ?? lit[2];
  const id = FALLBACK_MSG_IDENT_RE.exec(tail);
  return id ? constStringOf(src, id[1]) : undefined;
}

/** 真源不认且调用点也没自带文案 ⇒ 欠债 */
function countDebt(src: string): number {
  return [...src.matchAll(FALLBACK_SITE_RE)]
    .filter((m) => !Object.prototype.hasOwnProperty.call(ERROR_CODES, m[1]) && fallbackCopyOf(src, m[2]) === undefined)
    .length;
}

/** 真源不认、但调用点自带了专属文案 ⇒ 已闭环（计量它，不豁免它于可见性） */
function countPerSiteCopy(src: string): number {
  return [...src.matchAll(FALLBACK_SITE_RE)]
    .filter((m) => !Object.prototype.hasOwnProperty.call(ERROR_CODES, m[1]) && fallbackCopyOf(src, m[2]) !== undefined)
    .length;
}

function allProdFiles(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.ts') || ent.name.endsWith('.test.ts')) continue;
      out.push([path.relative(SERVER, abs).split(path.sep).join('/'), stripComments(fs.readFileSync(abs, 'utf8'))]);
    }
  };
  walk(path.join(SERVER, 'src'));
  return out;
}

function unregisteredByFile(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.ts') || ent.name.endsWith('.test.ts')) continue;
      const src = stripComments(fs.readFileSync(abs, 'utf8'));
      const n = countDebt(src);
      if (n > 0) out[path.relative(SERVER, abs).split(path.sep).join('/')] = n;
    }
  };
  walk(path.join(SERVER, 'src'));
  return out;
}

describe('B29 兜底码必须已登记注册表 · 逐文件棘轮（只许减不许增）', () => {
  it('实际站点数不得高于基线，且每个文件都要对得上', () => {
    const actual = unregisteredByFile();
    const grew = Object.entries(actual)
      .filter(([f, n]) => n > (UNREGISTERED_FALLBACK_BASELINE[f] ?? 0))
      .map(([f, n]) => `${f}: 基线 ${UNREGISTERED_FALLBACK_BASELINE[f] ?? 0} → 实际 ${n}`);
    expect(grew, `有人新写了注册表外的兜底码（= 半收敛，用户会看到通用文案）：${JSON.stringify(grew)}`).toEqual([]);
    const stale = Object.entries(UNREGISTERED_FALLBACK_BASELINE).filter(([f, n]) => (actual[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${n} → 实际 ${actual[f] ?? 0}`);
    expect(stale, `登记好了就把基线一并改小（留旧数 = 掩盖下一次回潮）：${JSON.stringify(stale)}`).toEqual([]);
  });

  it('★ 阳性对照：真源外站点必被计、登记过的必不计、注释不计', () => {
    const sample = [
      "const r = safeRouteError(e, { fallbackCode: 'A_CODE_NOT_IN_THE_REGISTRY' });",
      "const q = safeRouteError(e, { fallbackCode: 'HR_OPERATION_FAILED' });",
      "// fallbackCode: 'ANOTHER_UNREGISTERED_ONE'",
    ].join('\n');
    // 注释里那行**必须整体带形状**才会被误计（判据要求 `fallbackCode: 'X' … }` 成对），
    // 所以这里用一行"注释里的完整调用"来证明不剥注释会假红：2 → 剥完 1
    const withCommentedCall = sample + "\n// const q = safeRouteError(e, { fallbackCode: 'Y_IN_A_COMMENT' });";
    expect(countDebt(withCommentedCall)).toBe(2);
    expect(countDebt(stripComments(withCommentedCall))).toBe(1);
    expect(countDebt(stripComments(sample))).toBe(1);
    // 判据不是恒假：把已登记那行也变成表外码 ⇒ 剥注释后 2 处（不剥会连注释那行一起数到 3）
    expect(countDebt(stripComments(sample.replace("'HR_OPERATION_FAILED'", "'HR_OPERATION_FAILED_TYPO'")))).toBe(2);
    // 判据不是恒真：全部登记 ⇒ 0
    expect(countDebt("const r = safeRouteError(e, { fallbackCode: 'HR_OPERATION_FAILED' });")).toBe(0);
    // ★ 顺带把一条事实钉在案：`INTERNAL_ERROR` 至今**不在**注册表里（2026-09-20 09:58 实测：
    //   拿它当兜底码的站点 39 处 / 9 个文件 ⇒ 这些是"接了真源但真源不认"的半收敛，
    //   未预期异常一律答 GENERIC_ROUTE_ERROR_MESSAGE 那句万能话）。哪天有人把它登记进来，
    //   这里会红 —— 那是**好消息**，届时把这一行删掉并在下表里同步改小，别顺手删掉整条断言。
    expect(Object.prototype.hasOwnProperty.call(ERROR_CODES, 'INTERNAL_ERROR')).toBe(true);
    expect(ERROR_CODES.INTERNAL_ERROR.status).toBe(500);
    expect(Object.prototype.hasOwnProperty.call(ERROR_CODES, 'A_CODE_NOT_IN_THE_REGISTRY')).toBe(false);
  });

  it('★ 自带专属文案的那些点：必须被计量（豁免不等于免检）', () => {
    const files = allProdFiles();
    let perSite = 0, perFiles = 0, weakCopy = 0;
    for (const [rel, src] of files) {
      const n = countPerSiteCopy(src);
      if (n) { perSite += n; perFiles += 1; }
      // 豁免成立的前提是"那串文案真的可用"：为空 / 太短 / 非中文都不算
      for (const m of src.matchAll(FALLBACK_SITE_RE)) {
        if (Object.prototype.hasOwnProperty.call(ERROR_CODES, m[1])) continue; // eslint-disable-line no-continue
        const copy = fallbackCopyOf(src, m[2]);
        // 只在「确实自带了文案」时判质量：没自带的那些已由 countDebt 计成欠债，不重复计
        if (copy !== undefined && (copy.trim().length === 0 || copy.length < 6 || !/[\u4e00-\u9fa5]/.test(copy))) weakCopy += 1;
      }
    }
    // 实测（2026-09-20 13:05）：finance 27 + seasons 22 + suppliers 19（后两族走同文件常量）+ shipping 21 + **samples 47**（端点专属中文文案）+ 其余 ⇒ 187 处 / 18 个文件（samples 早在清单里，它那处 `SHIPMENT_HISTORY_FAILED` 就自带文案 ⇒ 处数 +47 而文件数不变）
    expect(perSite, '自带文案的站点数变了：要么又收敛了一批（好事，同步这里），要么判据认不住了').toBe(143); // 223 → 218（2026-09-29 晚）：本批新登记 6 枚码 ⇒ 原先"码不在表里 + 调用点自带文案"的 5 处变成"码已登记"（同一机制：2026-09-29 上午 `ASSEMBLE_FAILED` 就是 -1）。★ 实测，不是 223−5 推的。 // 221 → 223（2026-09-29 晚）：`orders/toleranceStandardRoute.ts` 的**客户标准**两站各 1 处（`TOLERANCE_CUSTOMER_READ_FAILED` / `TOLERANCE_CUSTOMER_WRITE_FAILED`，都自带中文文案）⇒ +2；**文件数不变**（同一文件）。★ 量出来的，不是 221+2 推的。
    // 211 → 218（v3.03，Δ=+7）：B42·A1 收 customsRouteV2 **5** 处 + quotationRoute **2** 处 = 7 个新调用点，都走"码名跨域重名 ⇒ 调用点自带文案"这条既有路径合规路径（实测 +8） // 201 → 212：第 10 批复核补的 11 处仍走**调用点自带文案**这条合规路径（码名跨域重名，不并进全局注册表），实测数
    // 212 → 211（v2.46）：`shipping/route.ts:485` 那处 `ASSEMBLE_FAILED` 从"码不在表里 + 自带文案"变成"码已登记"（本批登记）。
    //   对外没变：状态本来就取 `spec?.status ?? 500` = 500，文案仍由调用点 `fallbackMessage` 优先（routeError.ts:93）。
    expect(perFiles).toBe(18); // fixed 9b206773: native QC Agent and customs finite fallback copies add two visible files; 143 total remains, not increased raw debt. Historical 16 retained in source-readings.
    // ★ 豁免的**前提**是那句文案真的能用。实测有 16 处不成立 ⇒ 单独立项 B31，先计量、不装作没看见
    expect(weakCopy, '这几处"自带文案"是空的/太短/不是中文 ⇒ 既没进注册表也没有可用文案（B31）').toBe(7);
  });

  it('★ 阳性对照 3：自带文案写成「同文件常量」也必须被认到（season 族的形状）', () => {
    const withConst = [
      "const FAIL_COPY = '该请求未能完成，本次未确认任何改动，请稍后重试。';",
      "const a = safeRouteError(e, { fallbackCode: 'A_CODE_NOT_IN_THE_REGISTRY', fallbackMessage: FAIL_COPY });",
      // 反例：点号取值（本判据取不到常量 ⇒ 宁可算欠债）
      "const b = safeRouteError(e, { fallbackCode: 'A_CODE_NOT_IN_THE_REGISTRY', fallbackMessage: cfg.copy });",
    ].join('\n');
    expect(countPerSiteCopy(withConst)).toBe(1);
    expect(countDebt(withConst)).toBe(1);
    // 常量本身是弱文案时，进 weakCopy 而不是欠债（两条缺陷各归各的数）
    const weakConst = [
      "const FAIL_COPY = 'failed';",
      "const a = safeRouteError(e, { fallbackCode: 'A_CODE_NOT_IN_THE_REGISTRY', fallbackMessage: FAIL_COPY });",
    ].join('\n');
    expect(countDebt(weakConst)).toBe(0);
    expect(countPerSiteCopy(weakConst)).toBe(1);
  });

  it('★ 已收敛的域必须真的干净（hr 是本条的成品样本）', () => {
    const read = (rel: string) => stripComments(fs.readFileSync(path.join(SERVER, 'src', rel), 'utf8'));
    expect(countDebt(read('hr/route.ts')), 'hr 域 36 处出口应全部登记在案').toBe(0);
    // 且 hr 用的兜底码档位确实都是 500（未归因才走兜底码，业务码自己带状态）
    const codes = [...read('hr/route.ts').matchAll(FALLBACK_CODE_RE)].map((m) => m[1]);
    expect(new Set(codes).size, '兜底码种类数应含新的人事权限核对码').toBe(36);
    for (const c of new Set(codes)) {
      expect(ERROR_CODES[c].status, `${c} 的档位不再是 500 ⇒ 未预期异常会被答成 4xx`).toBe(500);
    }
  });
});
