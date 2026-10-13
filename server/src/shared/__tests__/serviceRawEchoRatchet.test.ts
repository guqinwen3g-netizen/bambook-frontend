/**
 * §9 **B33** · 服务层把「原始异常 || 中文兜底」当成对外文案（棘轮，只减不增）
 *
 * 这是 B22 家族里**两条既有判据都看不见**的第三条通道，13:12 由执行用例当场撞出来：
 * 收完 `samples/sampleRoute.ts` 的 47 处之后，我给写端点补 HTTP 用例，结果拿到
 * `{"error":{"code":"INTERNAL_ERROR","message":"PrismaClientKnownRequestError: Invalid prisma.sampleColorCard.findMany() … /srv/app/…"}}`
 * —— 内部原文照样上屏，只是出口从路由的 `catch` 换成了服务层的 `fail()`。
 *
 * 为什么两条既有判据都漏（**这就是 B22 第 5 次口径缺口**，根因还是"认语法形状、不认用户收到什么"）：
 *   · **B22** 数的是 `message: <标识符>.message`（对象字面量里的属性）⇒ 本型是**位置参数** `fail('CODE', e?.message || '…', 500)`，形状不同；
 *   · **B30** 数的是"固定文案 + **内插**原始异常"（`` `Cancel failed: ${e.message}` ``）⇒ 本型是原文**顶替**文案，不是拼进去。
 *
 * **判据（本文件）**：任何"对外文案参数 = `<某>.message` **且带 `||`/`??` 中文兜底**"的写法。
 * 带兜底是关键特征：说明作者本来就想给一句中文，只是顺手把 `e?.message` 放在了前面。
 * 认不到的形状（**盲区，不许装作没有**）：
 *   · `fail(e.code, e.message)`（透传 typed error，**有意**如此，不算 B33）；
 *   · 先把 `e.message` 存进变量再传出去；经 DTO/序列化字段带出去；
 *   · `throw new Error(e.message)` 这种"抛出去给上层"的（由上层出口负责，另有 B22/B30 覆盖）。
 *
 * 基线取样 2026-09-20 15:06（收紧判据后）：**21 个文件 / 51 处**。
 * 历史：本批前 26 个文件 / 70 处（13:15 实测）→ 清掉 samples 域 17 处后 23 / 53 → 剔 2 处误判后 21 / 51。
 * ★ 7a 批（17:5x）清 `procurement/materialReturnService.ts` 5 处 → **20 / 46**；再清 `credit/creditRoute.ts` 4 处
 *   → **19 / 42**（基线表随之删行；本文件只留基线与对照，判据仍在 `scripts/lib/errorDebtScanners.mjs`）。
 *   7a 同时发现并修掉一处**收口点错位**：`creditRoute.ts` 的 freeze/thaw 有**两个出口**，
 *   路由 catch 之外 `result.error.message` 也原样转发，而服务层 `creditService.ts` 把原文拼进了文案
 *   （`fail(CREDIT_WRITE_FAILED, \`冻结事务失败: ${String(e?.message ?? e)}\`, 500)`，4 处）。
 *   ⚠️ 这 4 处**不在本表内也不在 B30 表内**（B30 的 WRAP_RE 要求 `message|error|reason` 键名在前，
 *   位置参数不在判据内，实测命中 0）⇒ 属**新盲区**，已在 `credit/__tests__/errorExitConvergence.test.ts`
 *   用执行用例钉住（红色证据见该文件头部）。
 *
 * ★ **判据的第 1 次误判（15:06 收紧，代价 = 一批虚假进度）**：命中的标识符必须真是"本文件 catch 到的错误对象"。
 *   原来两支会把**不是欠债**的写法算进来 —— `src/shared/errorCodes.ts` 的 `message: spec?.message ?? GENERIC_ROUTE_ERROR_MESSAGE`
 *   （那是**注册表自己的文案**，正是真源应有的形状）、`src/agent/agentLoop.ts` 的 `outputObj.message`
 *   （AI 输出的**数据字段**，与被捕获的异常无关）。后果与 D32 一样：**数字虚高会让"清了一批"看起来成功，
 *   而真正该清的那处混在噪声里**。收紧前基线里那两行是误判，不是欠债，已删。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  B33_ARG_RE, B33_PROP_RE, B36_RE, b33Sites, b36Sites, b37Sites, b39Sites, countByFile, scanSources,
} from '../../../scripts/lib/errorDebtScanners.mjs';
import { stripComments } from './utils/sourceScan';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', '..', '..');

/**
 * ★ 判据**不在本文件里**（2026-09-20 第 7 批上移到 `scripts/lib/errorDebtScanners.mjs`）。
 * 原来守卫与 `measure-error-debt.mjs` 各存一份正则，15:06 我只收紧了守卫那份 ⇒ 同一口径两处给出 53/51。
 * 「两边都对得上」只能证明它们错得一样 ⇒ 判据合一，本文件只留**基线与对照**。
 */
function countByFileHere() {
  return countByFile(scanSources(SERVER), b33Sites);
}

/** 冻结基线（2026-09-20 15:06 收紧判据后实测 21 个文件 / 51 处）。只许减不许增。 */
const BASELINE: Record<string, number> = {
  'src/reporting/reportDefinitionService.ts': 7,
  'src/credit/bankruptcyService.ts': 3,
  'src/handover/handoverService.ts': 3,
  'src/mes/processChainService.ts': 3,
  'src/qc/testRequestService.ts': 3,
  'src/finance/dunningService.ts': 2,
  'src/finance/dunningStageService.ts': 2,
  'src/finance/forwardFxService.ts': 2,
  'src/inventory/stockOwnershipService.ts': 2,
  'src/reporting/monthlyCloseService.ts': 2,
  'src/suppliers/delayImpactService.ts': 2,
  'src/suppliers/tcCertificateService.ts': 2,
  'src/claims/claimCaseService.ts': 1,
  'src/claims/creditNoteService.ts': 1,
  'src/orders/route.ts': 1,
  'src/relations/routeV2.ts': 1,
  'src/tools/fabricCalculatorRoute.ts': 1,
};

describe('B33 · 服务层「原文 || 文案」当对外文案（只减不增）', () => {
  const actual = countByFileHere();

  it('★ 逐文件基线：涨了就红，偷偷变少也红（逼着同步）', () => {
    const grew = Object.entries(actual).filter(([f, n]) => (BASELINE[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${BASELINE[f] ?? 0} → 实际 ${n}`);
    expect(grew, `新长出/回潮的原文当文案站点：${JSON.stringify(grew)}`).toEqual([]);
    const stale = Object.entries(BASELINE).filter(([f, n]) => (actual[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${n} → 实际 ${actual[f] ?? 0}`);
    expect(stale, `已经改好了就同步删掉那一行（留旧数会掩盖下一次回潮）：${JSON.stringify(stale)}`).toEqual([]);
    expect(Object.values(actual).reduce((a, b) => a + b, 0), '全仓 B33 站点总数').toBe(38); // source-proven commission unknown failure now discards the error.
    expect(Object.keys(actual).length, '含 B33 站点的文件数').toBe(17);
  });

  it('★ 行号保真：每个命中点报的行，原文那一行真的就是这处写法（否则逐站点清单不能驱动改代码）', () => {
    // 这一条是被真实代价逼出来的：`audit-echo-sites.mjs` 曾报 `finance/forwardFxService.ts:369`，
    // 而那处实际在 :149 —— 因为旧 `stripComments` 把整段块注释**删掉**，之后每行都往前挪。
    // 行号错的定位工具不能拿来改代码 ⇒ 判据改成"块注释换成等量换行"，并在这里钉住行号守恒。
    let checked = 0;
    for (const { rel, abs, src } of scanSources(SERVER)) {
      const rawLines = fs.readFileSync(abs, 'utf8').split('\n');
      const strippedLines = src.split('\n');
      expect(strippedLines.length, `${rel} 剥注释后行数变了 ⇒ 之后所有行号都会漂移`).toBe(rawLines.length);
      for (const h of b33Sites(src)) {
        const line = src.slice(0, h.index).split('\n').length;
        const frag = h[0].split('\n')[0].trim();
        expect(rawLines[line - 1], `${rel}:${line} 报的行号对不上命中点`).toContain(frag.slice(0, 14));
        checked += 1;
      }
    }
    expect(checked, '检查到的命中点数与基线不符 = 这条守卫没真的走站点').toBe(
      Object.values(BASELINE).reduce((a, b) => a + b, 0));
  });

  it('★ 本批清掉的 samples 域必须是 0（不是"少了"，是一处不剩）', () => {
    for (const f of ['src/samples/sampleRoomService.ts', 'src/samples/colorBatchService.ts', 'src/samples/colorCardService.ts']) {
      expect(f in actual, `${f} 仍在用原始异常当对外文案`).toBe(false);
    }
  });

  it('双向对照：对照用例必须跑**计数的同一条判据**（b33Sites），不再跑裸正则', () => {
    // ⚠️ 这里曾经直接对 ARG_RE/PROP_RE 数命中 —— 而计数走的是收紧后的判据。
    // 判据与对照各用一套 = 对照永远绿，实际计数规则已经变了也看不出来（D43 同型）。
    const yes = [
      "try { x() } catch (e) { return fail('CREATE_FAILED', e?.message || '登记失败'); }",
      "promise.catch((err) => fail('INTERNAL_ERROR', err.message ?? '查询失败', 500))",
      "try { x() } catch (e) { return { error: { message: e?.message || '更新失败' } }; }",
    ];
    for (const line of yes) expect(b33Sites(line), line).toHaveLength(1);
    const no = [
      // 纯中文文案（正确写法）
      "try { x() } catch (e) { return fail('UPDATE_FAILED', '批色记录未能保存，本次改动未生效，请稍后重试。'); }",
      // 收紧掉的两个误判形状：命中的标识符不是 catch 到的错误对象
      "return { code: 'X', message: spec?.message ?? GENERIC_ROUTE_ERROR_MESSAGE };",
      "return { ok: true, message: outputObj.message || 'done' };",
    ];
    for (const line of no) expect(b33Sites(line), line).toHaveLength(0);
    // 同形状但标识符确实是 catch 参数 ⇒ 必须重新算（证明收紧是"认来源"而不是"认名字"）
    expect(b33Sites("try { x() } catch (outputObj) { return { message: outputObj.message || '兜底' }; }")).toHaveLength(1);
    // ★ 收紧剔掉的那两处，**形状层**确实是被认到的 ⇒ 说明起作用的是"认来源"这一层，不是正则本身变松了
    expect("return { message: spec?.message ?? GENERIC_ROUTE_ERROR_MESSAGE };".match(B33_PROP_RE)).toHaveLength(1);
    expect("return { ok: true, message: outputObj.message || 'done' };".match(B33_PROP_RE)).toHaveLength(1);
    // 位置参数型也被同一支 catch 变量过滤器管着
    expect("return fail('X', err.message || '兜底');".match(B33_ARG_RE)).toHaveLength(1);
    // 注释里的旧写法不算（口径与 B22 一致）
    expect(b33Sites(stripComments("// return fail('X', e?.message || '旧写法');"))).toHaveLength(0);
    expect(b33Sites(stripComments('try { x() } catch (e) {\n  // return fail(\'X\', e?.message || \'旧写法\');\n}'))).toHaveLength(0);
    expect(b33Sites("try { x() } catch (e) { return fail('X', e?.message || '真站点'); }")).toHaveLength(1);
  });
});

/**
 * §9 **B36** · 同一条通道的另外两种形状（B33 判据认不到，单独立账计量）
 *
 * 由**独立复核**（14:46）抓到，不是我自查出来的：
 *   ① 文案位 = `String(e?.message ?? e)` —— 与"原文 || 中文兜底"等价，只是没写兜底符号；
 *   ② `if (e?.code) return fail(e.code, e.message)` —— 看着像"有意透传业务错误"，实际不是：
 *      **Prisma 错误自带 `code`（P2002 等）且 message 是原文** ⇒ 原文上屏，且档位被 `fail` 默认降成 400。
 *      本文件初版还把 ② 当作"合格"写进反面对照 ⇒ **判据替缺陷背书**（比没有判据更糟，见 D43）。
 * 基线 2026-09-20 14:48 实测：① **10 处 / 5 文件**、② **18 处 / 8 文件**，合计 **28 处 / 13 文件**。只减不增。
 */
const B36_STRING_COPY_BASELINE: Record<string, number> = {
  'src/samples/sampleLengthService.ts': 5,
  'src/inventory/inventoryOwnershipService.ts': 2,
  'src/customer/reconciliationAckService.ts': 1,
  'src/finance/billingItemService.ts': 1,
  'src/shipping/shipmentLandTransportService.ts': 1,
};
const B36_CODE_PASSTHROUGH_BASELINE: Record<string, number> = {
  'src/credit/bankruptcyService.ts': 3,
  'src/mes/processChainService.ts': 3,
  'src/qc/testRequestService.ts': 3,
  'src/samples/colorBatchService.ts': 3,
  'src/samples/colorCardService.ts': 2,
  'src/suppliers/tcCertificateService.ts': 2,
  'src/finance/dunningService.ts': 1,
  'src/suppliers/delayImpactService.ts': 1,
};
function countByFileB36(which: 'stringCopy' | 'codePassthrough'): Record<string, number> {
  return countByFile(scanSources(SERVER), (src: string) => b36Sites(src, which));
}

describe('B36 · 同一条通道的另外两种形状（只减不增）', () => {
  it('① 文案位 = String(原文)：10 处 / 5 文件', () => {
    const actual = countByFileB36('stringCopy');
    expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(10);
    expect(actual).toEqual(B36_STRING_COPY_BASELINE);
  });

  it('② `if (e?.code) return fail(e.code, e.message)`：18 处 / 8 文件（Prisma 自带 code ⇒ 原文上屏 + 降 400）', () => {
    const actual = countByFileB36('codePassthrough');
    expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(18);
    expect(actual).toEqual(B36_CODE_PASSTHROUGH_BASELINE);
  });

  it('双向对照：两种形状都要被数到，改对的写法不许数（防恒真/恒假）', () => {
    // ★ 这里原先用 `B36_RE.xxx.test(line)` 做对照，而这两支正则带 /g ⇒ `.test()` 会推进 **lastIndex**：
    //   上一条命中后，下一条从偏移处开搜 ⇒ 反面对照**因为错误的原因**通过（假绿）。
    //   改用 `.match()`（全局正则下会先把 lastIndex 归零）⇒ 对照与计数走同一语义。
    const hit = (re: RegExp, s: string) => (s.match(re) ?? []).length;
    expect(hit(B36_RE.stringCopy, "return fail('X', String(e?.message ?? e));")).toBe(1);
    expect(hit(B36_RE.codePassthrough, 'if (e?.code) return fail(e.code, e.message);')).toBe(1);
    // 正确写法：只留中文文案 / typed error 判据用 isBusinessError（要 code + statusCode 两件套）
    expect(hit(B36_RE.stringCopy, "return fail('X', '登记失败，请稍后重试；持续失败请联系管理员。');")).toBe(0);
    expect(hit(B36_RE.codePassthrough, 'if (e?.code && e?.statusCode) return fail(e.code, e.message, e.statusCode);')).toBe(0);
    // 反面对照必须"因为形状而 0"：同一支正则连用两次，第二次仍要能命中（证明没有 lastIndex 残留）
    expect(hit(B36_RE.codePassthrough, 'if (e?.code) return fail(e.code, e.message);')).toBe(1);
    expect(B36_RE.codePassthrough.lastIndex, '.match() 后必须归零，否则下一次扫别的文件会漏').toBe(0);
    // 阳性对照（同一条判据的"错着也绿"防线）：把 /g 换成带 lastIndex 的用法，能复现刚才那个假绿
    const stateful = new RegExp(B36_RE.codePassthrough.source, 'g');
    expect(stateful.test('if (e?.code) return fail(e.code, e.message);')).toBe(true);
    expect(stateful.test('if (e?.code) return fail(e.code, e.message);'), '旧写法：第二次因 lastIndex 而漏').toBe(false);
  });
});

/* ───────────────────────── §9 B37 ───────────────────────── */

/**
 * §9 **B37** · 第四种写法：`fail(<非字面量 code>, e?.message ?? 中文, …)`（只减不增）
 *
 * 15:54 读 `finance/forwardFxService.ts:291` 时撞出来的：这一处**四条既有判据一条都不认**
 * （B33 要第一参数是 `'CODE'` 字面量 / B36① 要 `String(...)` / B36② 要 `if (e?.code) return` /
 *  B22 只看对象字面量里的 `message:`），但用户收到的东西一模一样 —— **原始异常原文上屏**。
 * 这是"认语法形状、不认用户收到什么"的第 6 次现形（前五次：D32 / D36 / D40 / D41 / D43）。
 *
 * 基线 2026-09-20 15:54 实测：**7 个文件 / 8 处**。
 */
const B37_BASELINE: Record<string, number> = {
  'src/paymentRequests/paymentRequestService.ts': 2,
  'src/exceptions/exceptionService.ts': 1,
  'src/finance/forwardFxService.ts': 1,
  'src/finance/writeOffService.ts': 1,
  'src/inventory/stockOwnershipService.ts': 1,
  'src/orderChanges/orderChangeRequestService.ts': 1,
};

describe('B37 · B33/B36 都认不到的第四种写法（只减不增）', () => {
  const actual = countByFile(scanSources(SERVER), b37Sites);

  it('逐文件基线：7 处 / 6 文件，涨了红、偷偷少了也红', () => {
    expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(7);
    expect(actual).toEqual(B37_BASELINE);
  });

  it('★ 与 B33 互斥（同一处不能被判两遍，否则清一批时总数会被重复扣）', () => {
    let files = 0;
    for (const { src } of scanSources(SERVER)) {
      const a = new Set(b33Sites(src).map((h) => h.index));
      const b = new Set(b37Sites(src).map((h) => h.index));
      const both = [...a].filter((i) => b.has(i));
      expect(both, '同一位置被两支判据同时命中 ⇒ 两支不再互斥').toEqual([]);
      files += 1;
    }
    expect(files, '一个文件都没比对 = 这条守卫恒真').toBeGreaterThan(400);
  });

  it('双向对照：B33 必须**看不见**这一形（证明是盲区而不是重复计量），改对了才算 0', () => {
    const site = "try { x() } catch (e) { return fail(e?.code ?? 'SETTLE_FAILED', e?.message ?? '交割失败', e?.statusCode ?? 400); }";
    expect(b33Sites(site), 'B33 认不到这一形 = 它就是盲区').toHaveLength(0);
    expect(b37Sites(site)).toHaveLength(1);
    // 正确写法：原文只进日志，对外只给中文 + 下一步
    const fixed = "try { x() } catch (e) {\n  logger.error('[fx] settle failed', { error: e?.message });\n  return fail('SETTLE_FAILED', '这笔远期交割未能保存，本次未确认任何改动，请稍后重试。', 400);\n}";
    expect(b37Sites(fixed)).toHaveLength(0);
    expect(b33Sites(fixed)).toHaveLength(0);
    // 不是 catch 到的错误对象 ⇒ 不算（与 B33 共用同一个"认来源"过滤器）
    expect(b37Sites("return fail(spec?.code ?? 'X', spec?.message ?? '兜底');")).toHaveLength(0);
  });
});

/* ───────────────────────── §9 B39 ───────────────────────── */

/**
 * §9 **B39** · 第五种写法：``fail(<CODE>, `固定文案: ${原文}`, …)`` —— 位置参数里**内插**原始异常。
 *
 * **怎么撞出来的（不是设想）**：第 7a 批清完 `credit/creditRoute.ts` 的 4 处路由 catch 后，
 * 按 R3 补执行用例，用例**红了** —— `POST /:customerId/freeze` 仍返回
 * `{"error":"CREDIT_WRITE_FAILED","message":"冻结事务失败: PrismaClientKnownRequestError: … /srv/app/…"}`。
 * 根因：该动作有**两个出口**，第二个（`creditRoute.ts:132/:157` 原样转发 `result.error.message`）
 * 的文案由服务层 `creditService.ts:483/:518` 拼出 —— 而本型**五条判据一条都不认**
 * （B22 只看对象字面量；**B30 的 `WRAP_RE` 要求 `message|error|reason` 键名在前**，实测本文件命中 0；
 * B33 要「原文 `||`/`??` + 引号兜底」；B36① 要文案位**整个**是 `String(...)`；B37 要第一参数是**非字面量** code）。
 * ⇒ 同一根因**第 7 次现形**（D32/D36/D40/D41/D43/D46 ⇒ 本次 **D49**）。
 *
 * **基线 2026-09-20 18:3x 实测（判据 = `lib.b39Sites`，473 个生产 `.ts` 全扫、非抽样）：15 个文件 / 65 处**。
 * 最大单文件 `development/fabricDevelopmentService.ts` 14 处。
 * ⚠️ 首次量出 **66** 处，其中 `paymentRequests/paymentRequestService.ts:322` 与 **B37 重叠**
 *   （文案位以 `e?.message ??` 开头 ⇒ 那是 B37 的"原文顶替"，不是本型的"原文内插"）
 *   ⇒ 判据加 `leadingRawOperand` 让位后为 **65**，并留下下面那条**五支两两互斥**断言把这件事钉住。
 * ★ **18:4x 清掉 2 个文件 ⇒ 65 → 58 处 / 15 → 13 文件**（`samples/earlyProductionSampleService.ts` 3 处、
 *   `samples/fabricShipmentSampleService.ts` 4 处）。这两份**原本一处 `logger.error` 都没有**
 *   （实测 `logger.error` 计数 = 0）⇒ 属"**先补日志再换文案**"，不是单纯换文案。
 * ★ **19:0x（7c 批）再清 3 个文件 4 处 ⇒ 54 处 / 10 文件**（`development/garmentDevelopmentService.ts` 1、
 *   `migration/dataMigrationService.ts` 1、`qc/qcChainService.ts` 2）—— 三份同样 `logger.error` 计数为 0，
 *   其中 `garmentDevelopmentService.ts` **连 `logger` 都没 import**（本批补上）。
 * ★ **21:3x（7d 批）再清 2 个文件 5 处 ⇒ 49 处 / 8 文件**（`shipping/orderShipmentBatchService.ts` 3、
 *   `paymentRequests/paymentRequestService.ts` 2）。shipping 那份同样 `logger.error` 计数为 0（本批补 3 条）；
 *   paymentRequests 那份**本来就有 logger.error**（只换文案）。
 *   ⚠️ 其中 `shipping:603` 与 `paymentRequests:417` 按 **D52** **不许承诺写入状态**
 *   （前者事务前有 `recalcSettlement` 直写库；后者的事务已提交、catch 只兜住回读+审计）。
 * ★ **22:2x（7e 批）再清 2 个文件 8 处 ⇒ 41 处 / 6 文件**（`exceptions/exceptionService.ts` 4、
 *   `internalTrade/internalTransferService.ts` 4）。这两份**本来就有 `logger.error`**（各 6 / 4 处）⇒ **一条不用补**；
 *   8 处的 `try` 内唯一写都是 `$transaction` ⇒ 全部可承诺「本次未确认任何改动」。
 * ★ **23:3x（7f 批）再清 2 个文件 10 处 ⇒ 31 处 / 4 文件**（`samples/garmentSampleGateService.ts` 5、
 *   `production/releaseService.ts` 5）。两份**同样 `logger.error` 计数为 0** ⇒ **各补 5 条**。
 *   ⚠️ `releaseService` 里 **2 处按 D52 不许承诺写入状态**（`:116` 的审计写在事务**外**；`:201` 的
 *   `releaseRequest.create` 直写、不在事务内），另 3 处可承诺。
 * ⚠️ **存量里多数 B39 文件 `logger.error` 计数为 0** ⇒ 清它们必须先补日志（D51）。
 *   **剩余（当时口径，现值见 §9.1 族级账）26 处 / 3 文件**：`development/fabricDevelopmentService.ts` **14（最大单块，0 日志，单独排批）** ·
 *   `finance/billingItemService.ts` **6（40 个 catch、0 日志）** · `samples/sampleManageService.ts` 6。
 * ★ **00:1x（7g 批）清 `orderChanges/orderChangeRequestService.ts` 5 处 ⇒ 26 处 / 3 文件**。
 *   该文件 5 个站点里**只有 1 处缺 `logger.error`**（结案完成那处）⇒ **只补了 1 条**（D51：按文件实测）。
 *   ⚠️ 该文件里还有 **1 处 B37 站点**（`:481` 的 `fail(e?.code ?? …, e?.message ?? '审批单创建失败', …)`）
 *   —— **本批未动**（属 B37 的账，B37 基线仍 8/7）。
 * ★ **00:2x（7i 批）清 `samples/sampleManageService.ts` 6 处 ⇒ 20 处 / 2 文件**。
 *   该文件 `logger.error` 计数原为 **1**（且不在本站点上一行）⇒ **6 条全补**（D51 按文件实测）。
 *   ⚠️ **D52 三组口径**（同型不同覆盖面，文案因此不共用一句）：create/update/delete/fork 四处 try 内唯一写
 *   是 `$transaction` ⇒ 可承诺「本次未确认任何改动」；`advanceSampleStage` 本批**也**判成"不许承诺"，
 *   但**该判语被独立复核证伪**（联动的拒绝被调用点 `.catch` + `invalidateScopesBySample` 自带 catch 双重吸收
 *   ⇒ 外层 catch 在事务提交后不可触发 ⇒ 更强的承诺其实成立）⇒ 保守口径**保留**，理由改为
 *   **「依赖一条无守卫的跨文件不变量」**，且用例**不禁止**将来换成更强的承诺（否则"谁改对谁红"）；
 *   `invoiceSample` 那处
 *   无事务、发票已独立提交 ⇒ 原文案「发票已创建」是**真结论**，保留并只删原文（业务单号 `SMP-INV-*` 属
 *   D52 的拉丁词 allowlist，不为过断言删业务信息）。
 *   ★ 本批同时产出 **B41 出口清单**：`invoiceSample` 的 `BACKFILL_FAILED` 经 Grep 实测**无 HTTP 消费者**
 *   （`POST /:id/invoice` 现为 410 GONE、该函数只在 `sampleRoute.ts:52` 被 import 未被调用）
 *   ⇒ 是本站点里第一处「导出但无消费者」的出口，**不声称它是活的上屏路径**（另 5 处由端到端用例钉住）。
 */
const B39_BASELINE: Record<string, number> = {
  'src/development/fabricDevelopmentService.ts': 3, // 11 exact native catches now use failFabricOperation; remaining seal create/update/delete stay measured.
  'src/finance/billingItemService.ts': 6,
};

describe('B39 · 位置参数内插原文（只减不增）', () => {
  const actual = countByFile(scanSources(SERVER), b39Sites);

  it('逐文件基线：9 处 / 2 文件，涨了红、偷偷少了也红', () => {
    expect(Object.values(actual).reduce((a, b) => a + b, 0), '全仓 B39 站点总数').toBe(9);
    expect(Object.keys(actual).length, '含 B39 站点的文件数').toBe(2);
    expect(actual).toEqual(B39_BASELINE);
  });

  /**
   * ★ 五支判据**两两互斥**：同一处被判两遍 ⇒ 清一批时总数会被重复扣（B37 立这条规矩的原因）。
   * 这不是纸上推演：本判据首次量出 66 处，就是靠这条断言（当时的实测脚本）发现与 B37 重叠 1 处的。
   */
  it('★ 与 B33 / B36① / B36② / B37 两两互斥（全量文件逐对比较，不是抽样）', () => {
    let files = 0;
    const overlaps: string[] = [];
    for (const { rel, src } of scanSources(SERVER)) {
      const sets = [
        ['B33', new Set(b33Sites(src).map((h) => h.index))],
        ['B36①', new Set(b36Sites(src, 'stringCopy').map((h) => h.index))],
        ['B36②', new Set(b36Sites(src, 'codePassthrough').map((h) => h.index))],
        ['B37', new Set(b37Sites(src).map((h) => h.index))],
        ['B39', new Set(b39Sites(src).map((h) => h.index))],
      ];
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          for (const idx of sets[i][1]) {
            if (sets[j][1].has(idx)) overlaps.push(`${rel} ${sets[i][0]}∩${sets[j][0]}`);
          }
        }
      }
      files += 1;
    }
    expect(overlaps, '同一处被两支判据同时命中 ⇒ 清一批时总数会被重复扣').toEqual([]);
    expect(files, '一个文件都没比对 = 这条守卫恒真').toBeGreaterThan(400);
  });

  it('双向对照：本型必须被数到，相邻四型必须不被数（防判据互相吞并）', () => {
    const hit = (s: string) => b39Sites(s).length;
    // 正：模板内插 String(e?.message ?? e)（全仓 65 处里的主流写法）
    expect(hit("try { x() } catch (e) { return fail('X_FAILED', `登记失败：${String(e?.message ?? e)}`, 500); }")).toBe(1);
    // 正：模板内插裸 e?.message
    expect(hit("try { x() } catch (e) { return fail('X_FAILED', `登记失败：${e?.message}`, 500); }")).toBe(1);
    // 正：字符串拼接
    expect(hit("try { x() } catch (e) { return fail('X_FAILED', '登记失败: ' + e.message, 500); }")).toBe(1);
    // 正：`${e}` 裸插
    expect(hit("try { x() } catch (e) { return fail('X_FAILED', `登记失败：${e}`, 500); }")).toBe(1);
    // 反：改对之后（纯中文 + 下一步）不许数
    expect(hit("try { x() } catch (e) { return fail('X_FAILED', '登记失败，本次未写入任何数据，请稍后重试。', 500); }")).toBe(0);
    // 反：B33 的形状（原文 || 引号兜底）不是本型
    expect(hit("try { x() } catch (e) { return fail('X_FAILED', e?.message || '登记失败', 500); }")).toBe(0);
    // 反：B36① 的形状（文案位整个是 String(...)）不是本型
    expect(hit("try { x() } catch (e) { return fail('X_FAILED', String(e?.message ?? e), 500); }")).toBe(0);
    // 反：B37 的形状（文案位以原文开头 + ??）不是本型 —— 实测重叠那一处的形状
    expect(hit("try { x() } catch (e) { return fail(e?.code ?? 'X', e?.message ?? `失败: ${String(e?.message ?? e)}`); }")).toBe(0);
    expect(b37Sites("try { x() } catch (e) { return fail(e?.code ?? 'X', e?.message ?? `失败: ${String(e?.message ?? e)}`); }")).toHaveLength(1);
    // 反：不是本文件 catch 到的错误对象 ⇒ 不算（与 B33/B37 共用同一把"认来源"过滤器）
    expect(hit("return fail('X_FAILED', `登记失败：${spec?.message}`);")).toBe(0);
    // 反：注释里的旧写法不算
    expect(hit(stripComments("// return fail('X_FAILED', `登记失败：${e?.message}`);"))).toBe(0);
  });
});
