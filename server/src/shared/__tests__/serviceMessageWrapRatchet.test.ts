// V1 2026-10-01: three actual raw-error wraps replaced with safe operation messages; no increased budgets.
/**
 * B30 棘轮：**服务层把内部异常原文拼进业务错误的文案里** ⇒ 路由再怎么收敛也照样上屏。
 *
 * ── 这条是怎么被发现的（不是设想出来的）─────────────────────
 * §9 B22 第 2 个域（`finance/route.ts` 27 处）收敛完，我补了一条**执行**用例：
 * 「POST /finance/:id/cancel 服务层炸了 ⇒ 响应里不得出现 Prisma 原文」。
 * 路由已经是 `safeRouteError` 了，本应绿 —— 结果它红了，收到的是
 * `Cancel transaction failed: PrismaClientKnownRequestError: Invalid prisma.$transaction…`。
 * 原因在 `finance/voidDeleteService.ts`：服务层自己把原文**拼进了 message**，
 * 于是这条错误在形状上是"业务错误"（带 code/statusCode），`resolveError` 按 G6.5 **必须**原样透传。
 * ⇒ B22 的「逐文件数 `message: err.message`」这条口径**结构性地看不见它**：
 *   泄露点从路由挪进了服务层，路由侧的数字变成 0 而用户看到的还是原文。
 *   这正是 §9 B22 头部自己声明的"该判据看不见的同类外泄"里最要命的一种。
 *
 * 判据（写死，避免又变成一句文字描述）：
 *   · 范围 = `server/src` 全部 `.ts`，排除 `__tests__/` 与 `.test.ts`；**先剥注释**
 *   · 命中 = 响应文案字段（`message` / `error` / `reason`）被写成
 *     「一段固定文字 + 内插的原始异常」——模板块里内插 `.message` / `String(err…)` / `?? e` / `|| e`，
 *     或字符串 `'…failed: ' + err.message` 这种拼接形态
 *   · 按文件计数，**只许减不许增**
 *
 * ⚠️ 认得率说明（诚实标注，别把它当"外泄已清零"的依据）：
 *   ① 这是**文本启发式**，不是数据流分析：把原文塞进变量再拼、或经 DTO/序列化带出去的，本条看不见；
 *   ② 少数命中是「把用户自己填的值回显进文案」（如 `invalid toStatus: ${toStatus}`），
 *      那不是内部信息泄露，但仍是**英文文案**问题 ⇒ 收敛该文件时逐处核准，别机械改成中文；
 *   ③ `src/finance` 由本条**单独钉为零**（见下），其余 18 个文件是欠债清单。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './utils/sourceScan';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/shared/__tests__
const SERVER = path.resolve(HERE, '..', '..', '..');       // server/

/** 2026-09-20 10:28 实测：36 处 / 19 个文件（其中 finance 已在本批清零，故不在此表内）。只许减不许增。 */
const WRAP_BASELINE: Record<string, number> = {
  'src/orders/orderLifecycleService.ts': 5,
  'src/development/developmentCaseMutationService.ts': 4,
  'src/ai/knowledgeIngestService.ts': 3,
  'src/orders/orderLineMutationService.ts': 0, // All three unknown caught storage-error wrappers now use safeRouteError.
  'src/orders/orderServiceV2.ts': 3,
  'src/agent/commitTransaction.ts': 1,
  'src/email/route.ts': 0, // 2 → 0：S0-A2 第 10 批复核批补的 11 处里，属本棘轮口径（原文拼进对外文案）的 2 处已接真源；留 0 而不是删行 = 回潮当场红
  'src/index.ts': 2,
  'src/market/autoQuoteSources.ts': 2,
  'src/agent/agentLoop.ts': 1,
  'src/agent/llmPlanner.ts': 1,
  'src/ai/route.ts': 1,
  'src/claims/claimRoute.ts': 0,
  'src/development/convertService.ts': 0,
  'src/market/marketQuoteService.ts': 1,
  'src/orderChanges/orderChangeRequestService.ts': 1,
  'src/reporting/reportDefinitionService.ts': 1,
  'src/scheduler/tasks/marketQuoteSync.ts': 1,
  'src/shipping/shipmentEligibilityGate.ts': 1,
};

const WRAP_RE = /(?:message|error|reason)\s*:\s*(?:`[^`]*\$\{[^`]*?(?:\.message|String\([^)]*[Ee]rr|\?\?\s*e\b|\|\|\s*e\b)[^`]*`|'[^']*'\s*\+\s*[A-Za-z_]\w*\??\.message)/g;

function countWraps(src: string): number {
  return (stripComments(src).match(WRAP_RE) ?? []).length;
}

function wrapsByFile(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.ts') || ent.name.endsWith('.test.ts')) continue;
      const n = countWraps(fs.readFileSync(abs, 'utf8'));
      if (n > 0) out[path.relative(SERVER, abs).split(path.sep).join('/')] = n;
    }
  };
  walk(path.join(SERVER, 'src'));
  return out;
}

describe('B30 服务层把原文拼进业务文案 · 逐文件棘轮（只许减不许增）', () => {
  it('实际站点数不得高于基线，且每个文件都要对得上', () => {
    const actual = wrapsByFile();
    const grew = Object.entries(actual)
      .filter(([f, n]) => n > (WRAP_BASELINE[f] ?? 0))
      .map(([f, n]) => `${f}: 基线 ${WRAP_BASELINE[f] ?? 0} → 实际 ${n}`);
    expect(grew, `有人把内部异常原文又拼进了对外文案：${JSON.stringify(grew)}`).toEqual([]);
    const stale = Object.entries(WRAP_BASELINE).filter(([f, n]) => n > 0 && (actual[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${n} → 实际 ${actual[f] ?? 0}`);
    expect(stale, `改好了就同步改小基线（留旧数 = 掩盖下一次回潮）：${JSON.stringify(stale)}`).toEqual([]);
  });

  it('★ finance 整目录必须为 0（本批清完的域，回潮当场红）', () => {
    const hits: string[] = [];
    const dir = path.join(SERVER, 'src', 'finance');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const n = countWraps(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (n > 0) hits.push(`${f}:${n}`);
    }
    expect(hits, `finance 又长出把原文拼进文案的站点：${JSON.stringify(hits)}`).toEqual([]);
  });

  it('★ 阳性对照：收敛前的真实写法必须被抓得住（防恒真守卫）', () => {
    // 本批修掉的那一型（voidDeleteService 收敛前的原文）
    expect(countWraps("    return { ok: false, error: { code: 'CANCEL_FAILED', message: `Cancel transaction failed: ${String(e?.message ?? e)}` } };"))
      .toBe(1);
    // 拼接形态（email/route.ts **收敛前**的写法，第 10 批复核批 M-B 变异复测用的就是它）
    expect(countWraps("      res.json({ error: '邮件发送失败: ' + err.message });")).toBe(1);
    // 反引号 + `?? e` 兜底形态
    expect(countWraps("      return { error: { message: `直接取消事务失败：${String(e?.message ?? e)}` } };")).toBe(1);
    // 反面对照（不该误判）：① 中文文案不内插原文 ② 只写日志不进响应字段
    expect(countWraps("      return { ok: false, error: { code: 'CANCEL_FAILED', message: '这张发票未能作废，本次未确认任何改动，请稍后重试。' } };")).toBe(0);
    expect(countWraps("      logger.error('Cancel transaction failed: ' + err.message);")).toBe(0);
    // ③ 业务错误自带文案透传（G6.5 要求的行为，不是泄露）
    expect(countWraps("    if (e?.code) return { code: e.code, message: e.message };")).toBe(0);
  });

  it('★ 基线自身不是空表（空表 = 恒绿 = 没守卫）', () => {
    const sum = Object.values(WRAP_BASELINE).reduce((a, b) => a + b, 0);
    expect(sum).toBe(28); // 31 → 28: three actual order-line storage-error wrappers removed in bbc6d3a3.
    expect(Object.values(WRAP_BASELINE).filter((n) => n > 0).length).toBe(15); // Order-line entry remains at zero to prevent recurrence.
  });
});
