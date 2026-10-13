// V1 2026-10-01: remove five routes after actual catch integration; new closure/pending/scene routes also use the adapter, no added debt.
/**
 * 路由错误真源守卫（S0-A Task 1）
 *
 * ── 为什么还要再加一条守卫 ─────────────────────────────
 * 既有棘轮 `routeError.test.ts` 的正则是
 *   /res\.status\([^)]*\)\.json\([^\n]*e\?\.message/g
 * 要求**同一行**出现 `e?.message`（字面量 `e?.`）。但本批次要收敛的 4 个域全都数不到：
 *   · `risk/riskRoute.ts` —— 变量中转，跨了两行
 *       const msg = e?.message || 'operation failed';  ...  res.status(...).json({ ..., message: msg })
 *   · `hr` / `dashboard` / `reporting` —— 行内直写 `err.message`，变量名不等于 `e?.`
 *       res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });
 * 实测这 4 个文件在旧正则下命中数 = **0/0/0/0** ⇒ 照那条棘轮收敛这 4 个域，
 * 基线一动不动 = 假绿。故本守卫不看行内数据流，只看**文件级有没有引用真源**。
 *
 * ── 本守卫的判据（文件级，不做行内数据流）──────────────
 * 「定义了 Express Router 的文件里，若存在 catch 内的状态码响应，
 *   就必须引用错误真源（shared/routeError · shared/errorCodes · lib/asyncHandler）」。
 *   shared/errorCodes 由本批次后续任务新建，此处**先认上**——判据只读源码文本，不看依赖图。
 * 为什么不用「有没有读 err.message」当判据：`logger.error(..., { error: e?.message })`
 * 是**合法且必要**的（明细必须进日志），那条判据会误伤上百处日志。
 *
 * ⚠️ 计数前必须剥注释（解释坏写法的注释会把自己算成违规，实测假红）。
 * ⚠️ 扫描必须排除 `__tests__`（守卫自己的样本字符串会被算进去）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './utils/sourceScan';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/shared/__tests__
const SRC = path.resolve(HERE, '..', '..'); // server/src

/** 这两个文件本身就是真源/组合根，不参与判据 */
const SKIP_FILES = new Set(['index.ts', 'lib/asyncHandler.ts']);


/**
 * 「引用了别的东西」的判据 —— **只此一份**：真用例和下面的阳性对照都调它。
 * 若对照里另抄一份正则，正则被改坏时对照仍绿 = 假对照（本仓 M-1/M-2 反复栽过的坑）。
 */
export function findImportOffenders(strippedCode: string): string[] {
  return [
    ...[...strippedCode.matchAll(/^\s*import[\s({*'"]/gm)].map((m) => m[0].trim()),
    ...[...strippedCode.matchAll(/^\s*export[\s\S]{0,80}?from\s/gm)].map((m) => m[0].trim()),
    ...[...strippedCode.matchAll(/\brequire\s*\(/g)].map((m) => m[0].trim()),
    ...[...strippedCode.matchAll(/\bimport\s*\(/g)].map((m) => m[0].trim()),
  ];
}

/** 纯函数判据：给定相对路径与**已剥注释**的源码，是否违规。 */
export function isNoTruthRoute(rel: string, strippedCode: string): boolean {
  if (SKIP_FILES.has(rel)) return false;
  if (!/Router\(\)/.test(strippedCode)) return false; // 只看定义路由的文件
  const respondsInCatch = /catch[\s\S]{0,600}?res\.status\([^)]*\)\.json\(/.test(strippedCode);
  if (!respondsInCatch) return false;
  // 真源三个模块：routeError（既有）/ errorCodes（S0-A 后续任务新建）/ asyncHandler（组合根）。
  // errorCodes 现在还不存在也照样认——判据只读源码文本，不看依赖图，成本为零。
  const importsTruth =
    /from '[.\w/]*shared\/(routeError|errorCodes)'/.test(strippedCode) ||
    /from '[.\w/]*lib\/asyncHandler'/.test(strippedCode);
  return !importsTruth;
}

function scanNoTruthRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
        const rel = path.relative(SRC, abs).split(path.sep).join('/');
        if (isNoTruthRoute(rel, stripComments(fs.readFileSync(abs, 'utf8')))) out.push(rel);
      }
    }
  };
  walk(SRC);
  return out.sort();
}

/**
 * 冻结基线（2026-09-20 实测 46 个 → 45 个：S0-A Task 5 摘掉第一行 `risk/riskRoute.ts`；
 * → 44 个：第 1 域 `hr/route.ts` → 43 个：第 2 域 `finance/route.ts` → 42 个：第 3 域 `seasons/seasonRouteV2.ts` → 41 个：第 4 域 `suppliers/factoryRouteV2.ts` → **40 个**：第 5 域 `shipping/route.ts` 21 处摘除）。
 * **只许减不许增**：收敛一个域就删掉它那一行；新增路由文件必须引用真源，否则这里对不上 = 红。
 */
const FROZEN_NO_TRUTH_ROUTES: string[] = [
  // ★ v3.03：`customs/customsRouteV2.ts`（收 5 处）与 `quotations/quotationRoute.ts`（收 2 处）已接真源 ⇒ 按本守卫判据不再违规，删行。
  //   ⚠️ 接真源 ≠ 外泄清零：两文件仍各留着刻意不收的落点（customs **2** 处 = `/documents/:id` 详情 + `POST /documents` 创建；
  //     quotation 3 处含 `NOT_FOUND` 早退臂），由 B22 的逐文件表盯着（挪表说明见 `rawErrorLeakRatchet.test.ts`）。


  'ai/route.ts',
  'auth/route.ts',
  'bom/bomRoute.ts',
  // BusinessLine now uses actual safeRouteError for every public failure.

  'config/automationRoute.ts',
  'config/systemConfigRoute.ts',
  'credit/creditRoute.ts',
  'crm/crmRoute.ts',
  'crm/crmRouteV2.ts',
  // Native QC branches now import/use truth; other customs raw sites remain in the separate raw-message inventory.
  'customs/documentTemplateRoute.ts',
  'dashboard/route.ts',

  'email/signatureRoute.ts',
  // email/templateRoute.ts：S0-A2 第 10 批起该文件 import 了 `shared/routeError` ⇒ 按本守卫的判据不再违规。
  //   ★ 判据的真实形状（见上面 `isNoTruthRoute`，别照抄这句注释）：
  //     「定义了 Router」＋「catch 里 600 字符内出现 `res.status(...).json(`」＋「**没有** import 三个真源模块」⇒ 违规。
  //   ⇒ 这是**文件级二值**判据（接没接真源），**不是**"原文直发有几处"的计数判据，所以"降到 0 继续钉"在这里没有对应物；
  //     接了真源却仍把异常原文发给用户（`error: e.message`、字符串拼接、`.send(文本)`）本守卫一概看不见
  //     ——那 11 处兄弟形状正是这个盲区的实例，归 B22 棘轮与 docs/S0-A2 第 10 批 §八 的形状无关普查管（同一批复核抓到）。
  'finance/reconciliationRoute.ts',
  'inventory/inventoryRoute.ts',
  'marketing/marketingRouteV2.ts',
  'mes/mesRoute.ts',

  // Two native PO/receipt branches import/use truth; remaining procurement raw sites are still measured separately.
  'products/lookbookRoute.ts',
  // Native assignment/report branches import/use truth; this file-level retirement is not all-QC error clearance.
  'relations/routeV2.ts',
  'reporting/route.ts',
  'seal/sealRoute.ts',
  'seasons/seasonRoute.ts',
  'suppliers/factoryRoute.ts',
  'templates/route.ts',
  'tools/fabricCalculatorRoute.ts',
  'traceability/traceabilityRoute.ts',
];

const SCAN_TIMEOUT_MS = 30_000;

describe('路由错误真源守卫（文件级，只许减不许增）', () => {
  it('违规清单必须等于冻结基线', () => {
    expect(scanNoTruthRoutes()).toEqual(FROZEN_NO_TRUTH_ROUTES);
  }, SCAN_TIMEOUT_MS);

  it('★ 阳性对照：变量中转的写法必须被抓到（既有棘轮正是漏在这里）', () => {
    const sample = [
      "import { Router } from 'express';",
      "const router = Router();",
      "router.get('/x', async (_req, res) => {",
      "  try { return res.json({ ok: true }); } catch (e: any) {",
      "    const msg = e?.message || 'failed';",
      "    res.status(500).json({ error: { code: 'X_FAILED', message: msg } });",
      "  }",
      "});",
    ].join('\n');
    expect(isNoTruthRoute('demo/xRoute.ts', stripComments(sample))).toBe(true);
  });

  it('★ 阳性对照反向：引用真源后必须消失（否则收敛动作不会被记功）', () => {
    const converged = [
      "import { Router } from 'express';",
      "import { resolveError } from '../shared/errorCodes';",
      "import { logger } from '../lib/logger';",
      "const router = Router();",
      "router.get('/x', async (_req, res) => {",
      "  try { return res.json({ ok: true }); } catch (e: any) {",
      "    logger.error('[x] failed', { error: e?.message || String(e) });",
      "    const r = resolveError(e, 'X_FAILED');",
      "    res.status(r.status).json({ error: { code: r.code, message: r.message } });",
      "  }",
      "});",
    ].join('\n');
    // 判据是「引用真源」，故需同时认 errorCodes 这条新真源 —— 见 importsTruth 正则
    expect(isNoTruthRoute('demo/xRoute.ts', stripComments(converged))).toBe(false);
  });

  it('★ 守卫自检：解释坏写法的注释不得被算成违规', () => {
    const commented = [
      "import { Router } from 'express';",
      "// 旧写法 res.status(500).json({ message: e?.message }) 会外泄，已废弃",
      "/* catch (e) { res.status(500).json({ error: { message: msg } }) } */",
      "const router = Router();",
      "router.get('/x', async (_req, res) => res.json({ ok: true }));",
    ].join('\n');
    expect(isNoTruthRoute('demo/cleanRoute.ts', stripComments(commented))).toBe(false);
  });

  /**
   * ★ Task 6 加固⑤：`shared/errorCodes.ts` 必须**零 import**。
   *
   * 这条规矩此前只写在文件头注释里（`errorCodes.ts:13-14`）—— 注释不是守卫：
   * 谁加一行 `import { prisma } from '../lib/prisma'` 都不会红，而「零引用」正是这个文件
   * 能同时被服务端/前端/脚本安全引前提（跨层 import 会穿透 tsconfig exclude）。
   * 判据只看**剥注释后**的真实代码：`import`、`export ... from`、`require(`、动态 `import(`。
   * （本文件头注释里就出现「import」这个词 —— 不剥注释会把自己算成违规，见上那条自检同一坑。）
   */
  it('★ errorCodes.ts 必须零 import（纯数据 + 纯函数，这是它能被任何层引的前提）', () => {
    const abs = path.join(SRC, 'shared/errorCodes.ts');
    const offenders = findImportOffenders(stripComments(fs.readFileSync(abs, 'utf8')));
    expect(offenders, `errorCodes.ts 引入了依赖，零引用前提已破：${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('★ 上一条的阳性对照：四种引用写法必须都被抓到，注释写法不得被误抓', () => {
    // 四种都试过（照计划书 Task 6 Step 0 的清单），否则「判据只认 import 开头这一种」也算零 import 通过
    for (const bad of [
      "import { x } from '../risk/types';",
      "const m = require('fs');",
      "export { y } from './z';",
      "const p = import('./heavy');",
    ]) {
      expect(findImportOffenders(stripComments(bad)), bad).toHaveLength(1);
    }
    // 反向：注释里出现 import/require 这个词（errorCodes.ts 文件头正是这么写的）不得计入
    expect(
      findImportOffenders(stripComments('// 本文件不得 import 任何东西\n/* require 也不许用 */\nexport const ERROR_CODES = {};')),
    ).toEqual([]);
    // 反向：`export interface` / `export const` 这类合法导出不得计入
    expect(
      findImportOffenders(stripComments("export interface S { a: number }\nexport const E: Record<string, S> = {};")),
    ).toEqual([]);
  });
});
