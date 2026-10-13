/**
 * §9 **B32** · `code → HTTP 状态` 的推导只许发生在 `shared/errorCodes` 一处（棘轮，只减不增）
 *
 * 为什么现在立这条：**撞出来的，不是设想出来的**。S0-A2 第 5 批（运单域）收口时，
 * 我发现 `shipping/route.ts` 有 **9 张** `const statusCodeMap: Record<string, number>`，
 * 而文件级守卫（`routeErrorSourceGuard`）在我把 21 处 `catch` 接上真源之后，
 * 就把这个文件判成「已接真源」了 —— 也就是说**一条守卫变绿的同时，掩盖着 9 份并行真源**。
 * 这与 D35/D37 那三次误判同源：认**语法形状**（有没有 import 真源），不认**用户实际收到什么**。
 *
 * 判据来源（外部，不抄现值）：
 *   · §12 **D33**：状态规则由注册表 / 业务错误自带的 `statusCode` 单点给出，路由不再自己推一遍
 *     （HR 域已经照这条删掉了 `hrErrorStatus`）；
 *   · **G6.3**：本项目头号病是多套并行真源；
 *   · **G6.5 / RFC 9110 §15.6.4**：409 的语义是「与资源当前状态冲突」⇒
 *     同一枚码一会儿答 400、一会儿答 409，前端就没法按码分支（下面 `SAME_CODE_TWO_STATUSES` 钉的就是这个）。
 *
 * **认得率与盲区**（D37 要求写在守卫自己头上，不许只写在脑子里）：
 *   认得两种形状：① 变量名含 `status` 的 `Record<string, number>` 表；② `x.code === 'CODE' ? 4xx` 三元。
 *   看不见：变量名不含 status 的表、`switch (code)`、`if/else` 链、把码传进 helper 再映射的。
 *   ⇒ **同一个形状（只看表）两种判据对扫**（12:35 实测）：窄判据 **364 条**、宽判据 **435 条**
 *     ⇒ 差 **71 条**就是"名字没起对"的那一类。本文件按**窄判据**建基线（宁可少计，不把无关数字算成欠债），
 *     宽判据只作为**下界自检**存在。
 *     ⚠️ 这里曾记成「宽判据 464 条」：那是把**两个口径混成一个数**（表 435 + 三元 29）当成了同一个判据的结果，
 *        且我第一版给的解释（"少了 `(?!\d)` 造成虚高"）**当场量出来是错的**（加不加都是 435）⇒
 *        教训同 D35/D37：**数不对时先怀疑自己的提取方法**，别急着给被测对象编原因。
 *
 * 基线取样：2026-09-20 12:32，`cd server && npx vitest run src/shared/__tests__/codeStatusTruthSourceRatchet.test.ts`
 * ⇒ 本文件就是这些数字的落盘处；每次跑套件都会重算一遍，涨了就红。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import ts from 'typescript';
import { stripComments } from './utils/sourceScan';
import { httpStatusOfCode, lookupErrorCode } from '../errorCodes';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/shared/__tests__
const SERVER = path.resolve(HERE, '..', '..', '..');       // server/

const STATUS_TABLE_RE = /const\s+(\w*[sS]tatus\w*)\s*:\s*Record<string,\s*number>\s*=\s*\{([\s\S]*?)\}/g;
const STATUS_ENTRY_RE = /[A-Z][A-Z0-9_]+:\s*[1-5]\d\d(?!\d)/g;
const STATUS_TERNARY_RE = /(?:\w+\.)?code\s*===\s*'([A-Z][A-Z0-9_]+)'\s*\?\s*([1-5]\d\d)(?!\d)/g;
/** 宽判据：不看变量名，只看"像不像 code→status 表"。只用来证明窄判据没在漏一大片 */
const LOOSE_TABLE_RE = /Record<string,\s*number>\s*=\s*\{([\s\S]*?)\}/g;

function scanFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['__tests__', 'node_modules', 'generated', '.prisma'].includes(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.ts') || ent.name.endsWith('.test.ts')) continue;
      out.push(abs);
    }
  };
  walk(path.join(SERVER, 'src'));
  return out;
}

interface Hit {
  file: string;
  /** 表条目 + 三元条目（基线钉的就是这个数） */
  entries: number;
  tableEntries: number;
  ternaryEntries: number;
  codeStatus: Array<[string, string]>;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const abs of scanFiles()) {
    const src = stripComments(fs.readFileSync(abs, 'utf8'));
    const pairs: Array<[string, string]> = [];
    let tableEntries = 0;
    let ternaryEntries = 0;
    for (const m of src.matchAll(STATUS_TABLE_RE)) {
      const hit = m[2].match(STATUS_ENTRY_RE) ?? [];
      for (const e of hit) {
        const [code, status] = e.split(/:\s*/);
        pairs.push([code, status]);
      }
      tableEntries += hit.length;
    }
    for (const m of src.matchAll(STATUS_TERNARY_RE)) {
      pairs.push([m[1], m[2]]);
      ternaryEntries += 1;
    }
    const entries = tableEntries + ternaryEntries;
    if (entries > 0) {
      hits.push({
        file: path.relative(SERVER, abs).split(path.sep).join('/'),
        entries, tableEntries, ternaryEntries, codeStatus: pairs,
      });
    }
  }
  return hits.sort((a, b) => b.entries - a.entries || a.file.localeCompare(b.file));
}

/** 宽判据：**同一个形状**（表）去掉"变量名含 status"这个条件后数到几条 —— 用来量窄判据的盲区 */
function looseTableEntries(): number {
  let n = 0;
  for (const abs of scanFiles()) {
    const src = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const m of src.matchAll(LOOSE_TABLE_RE)) n += (m[1].match(STATUS_ENTRY_RE) ?? []).length;
  }
  return n;
}

/**
 * 冻结基线（2026-09-20 12:32 实测 **20 个文件 / 393 条**；2026-09-22 v2.47 复核处置 I-1 复测 **392 条**；
 * 2026-09-23 v3.12 B129 收口：删掉 3 行本地"码→档"表 ⇒ **17 个文件 / 389 条**，
 * 三个消失的文件是 claims/claimRoute、exceptions/exceptionService、orderChanges/orderChangeRequestService。）。
 * 2026-10-01 1f7daebd：版本回填再去除4个本地映射，现17文件/385条（表360+三元25）。
 * e874134e PI 两出口共用有限服务契约，实际同口径变为17文件/383条（表360+三元23）。
 * 92df64c5 inspection出口改safeRouteError再退休2个三元：现17文件/381条（表360+三元21）。
 * Helper 内的有限 if 分支仍在本尺盲区，不把这两处下降说成全仓判档已统一。
 * **只许减不许增**：把一个文件的映射并进注册表就删掉它那一行；新写一张本地表 = 这里对不上 = 红。
 * v2.47 那一减的来路：`shipping/route.ts` 里 `code === 'SHIPMENT_NOT_FOUND' ? 404 : 500` 这条三元
 * 改问 `documentSetService.documentSetHttpErrorCode()`（返回值是码，档位仍只由 `ERROR_CODES` 给）⇒
 * 本文件按口径把它记成"少了一处本地推导"，**数字变小是真实进展，不是尺瞎了**（与 B73 那类"尺变宽导致的变小"相反）。
 */
const BASELINE: Record<string, number> = {
  'src/finance/route.ts': 149,
  'src/shipping/route.ts': 52,
  'src/orders/routeV2.ts': 37,
  'src/relations/routeV2.ts': 36,
  'src/development/route.ts': 30,
  // 1f7daebd: confirmed-source result uses its typed status; removed four local entries.
  'src/orders/orderLinesRoute.ts': 14,
  'src/relations/route.ts': 18,
  'src/production/route.ts': 14, // native inspection catch retired two local ternaries.
  'src/ai/knowledgeDocumentsRoute.ts': 11,
  'src/orders/route.ts': 6,
  'src/finance/routeV2.ts': 3,
  'src/mes/processChainService.ts': 3,
  'src/production/routeV2.ts': 2,
  'src/qc/testRequestService.ts': 2,
  'src/suppliers/tcCertificateService.ts': 2,
  'src/customer/route.ts': 1,
  'src/finance/sceneInvoiceService.ts': 1,
};

/**
 * 同一枚码在全仓被映射到两个不同档位（跨文件比对，12:32 实测 **6 枚**）。
 * 这 6 枚**现在是已知缺陷**，但改它 = 对外契约变更（要逐处核对前端分支），不属 B22/B32 的清理动作 ⇒
 * 本表**冻结现状**：把某一枚修好了就从这里删一行（删一行就少一处不一致），新长出一枚立刻红。
 */
const SAME_CODE_TWO_STATUSES: Record<string, string> = {
  HAS_ALLOCATIONS: '400/409',
  INVALID_CURRENT_STATUS: '400/409',
  INVALID_STAGE: '400/409',
  INVALID_STATUS: '400/409',
  INVALID_TRANSITION: '400/409',
  STAGE_NOT_SEQUENTIAL: '400/409',
};

describe('B32 · code→status 只能有一份真源（棘轮）', () => {
  const hits = scan();

  it('生产新增CONFLICT查真源，原V1/V2状态与未知边界保留，复合条件不得丢旧双档', () => {
    const inspect = (file: string, code: string) => {
      const source = fs.readFileSync(path.join(SERVER, 'src/production', file), 'utf8');
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const registryBindings = file === 'route.ts' ? ['lookupErrorCode', 'httpStatusOfCode'] : ['httpStatusOfCode'];
      for (const registryBinding of registryBindings) {
        expect(ast.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
          && node.moduleSpecifier.text === '../shared/errorCodes' && node.importClause?.namedBindings
          && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements
            .some(binding => binding.name.text === registryBinding && !binding.propertyName))).toBe(true);
      }
      let expression = ''; let table = '';
      const visit = (node: ts.Node) => {
        if (file === 'routeV2.ts' && ts.isVariableDeclaration(node) && node.name.getText(ast) === 'code'
          && node.initializer?.getText(ast).includes("result.error.code === 'ORDER_NOT_FOUND'")) {
          expect(expression).toBe(''); expression = node.initializer.getText(ast);
        }
        if (file === 'route.ts' && ts.isVariableStatement(node) && node.getText(ast).includes('PP_SAMPLE_NOT_SIGNED: 400')) {
          expect(table).toBe(''); table = node.getText(ast);
        }
        if (file === 'route.ts' && ts.isCallExpression(node) && node.expression.getText(ast) === 'res.status'
          && node.arguments[0]?.getText(ast).includes('statusCodeMap[errResult.error.code] || (lookupErrorCode')) {
          expect(expression).toBe(''); expression = node.arguments[0].getText(ast);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast); expect(expression).not.toBe('');
      const program = `${table}\n(${expression});`;
      const compiled = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      return vm.runInNewContext(compiled, { result: { error: { code } }, errResult: { error: { code } },
        httpStatusOfCode, lookupErrorCode }, { timeout: 1000 });
    };
    for (const [code, v1, v2] of [['ORDER_NOT_FOUND', 404, 404], ['STAGE_NOT_SEQUENTIAL', 400, 409],
      ['CONFLICT', 409, 409], ['UNKNOWN_STORAGE_CODE', 500, 422]] as const) {
      expect(inspect('route.ts', code)).toBe(v1);
      expect(inspect('routeV2.ts', code)).toBe(v2);
    }
    // The original meter must still see STAGE_NOT_SEQUENTIAL; its 400/409
    // inconsistency remains debt, rather than a false retirement through ||.
    expect(hits.find(hit => hit.file === 'src/production/routeV2.ts')?.codeStatus)
      .toContainEqual(['STAGE_NOT_SEQUENTIAL', '409']);
  });

  it('★ 逐文件基线只减不增：本地映射表一处未动 ⇒ 条数与文件数都必须等于基线', () => {
    const actual: Record<string, number> = {};
    for (const h of hits) actual[h.file] = h.entries;
    for (const [file, n] of Object.entries(actual)) {
      expect(BASELINE[file], `${file} 出现了基线外的本地 code→status 映射（或数字变了）`).toBe(n);
    }
    for (const file of Object.keys(BASELINE)) {
      expect(file in actual, `${file} 已经不在基线里了 = 又并进真源了一批，删掉这一行`).toBe(true);
    }
    const total = Object.values(actual).reduce((a, b) => a + b, 0);
    expect(total, '全仓本地 code→status 条数与基线不符').toBe(381);
    expect(Object.keys(actual).length, '含本地映射的文件数与基线不符').toBe(17);
  });

  it('★ 同码两档必须等于冻结清单（改好一枚就删一行，新长一枚当场红）', () => {
    const byCode = new Map<string, Set<string>>();
    for (const h of hits) {
      for (const [code, status] of h.codeStatus) {
        (byCode.get(code) ?? byCode.set(code, new Set()).get(code)!).add(status);
      }
    }
    const dual = Object.fromEntries(
      [...byCode.entries()].filter(([, s]) => s.size > 1).map(([c, s]) => [c, [...s].sort().join('/')]),
    );
    expect(dual).toEqual(SAME_CODE_TWO_STATUSES);
    expect(Object.keys(dual).length, '清单为空 = 判据退化成恒不匹配（没有守卫）').toBeGreaterThan(0);
  });

  it('窄判据没有把一大片漏在外面：同形状下界自检（表 vs 表）', () => {
    const narrowTables = hits.reduce((a, h) => a + h.tableEntries, 0);
    const narrowTerns = hits.reduce((a, h) => a + h.ternaryEntries, 0);
    const loose = looseTableEntries();
    // ★ 每次跑都把实测值打出来（v3.12 加的）：此前重冻结只能"改一个数跑一遍"猜，
    //   而基线里的数字一旦要动，**看得见实测值**才谈得上"有意识地认账"（否则就是盲调阈值）。
    console.log(`[B32 实测] 表=${narrowTables} 三元=${narrowTerns} 和=${narrowTables + narrowTerns} 宽=${loose} 盲区=${loose - narrowTables} 文件=${hits.filter((h) => h.tableEntries + h.ternaryEntries > 0).length}`);
    expect(narrowTables + narrowTerns, '两种形状之和必须等于基线总数（口径不许各说各话）').toBe(381);
    // 2026-09-22 v2.47：三元 29 → 28（`shipping/route.ts` 那条三元改问单一映射函数），表形状 364 条未动
    expect(narrowTerns, '原25处，PI两处及inspection两处退休后21；if/helper盲区仍保留').toBe(21);
    expect(narrowTables, '版本回填改读业务错误真源后，表形状364降为360').toBe(360);
    expect(loose, '宽判据应当 ≥ 窄判据（否则窄判据把已知的表漏掉了）').toBeGreaterThanOrEqual(narrowTables);
    expect(loose, '宽判据条数变了（12:35 实测 435）').toBe(435);
    // 反向自检：盲区确实是"变量名没起对"的那一类，而不是恒为 0（恒 0 = 两个判据其实是一个）
    expect(loose - narrowTables, '宽扫描含其他对象形状，表与宽扫描差值75').toBe(75);
  });

  it('双向对照：名字里带 status 的表算、百分比表不算、注释里的一行不算', () => {
    const sample = [
      "const statusCodeMap: Record<string, number> = { NOT_FOUND: 404, GATE_BLOCKED: 409 };",
      "const weights: Record<string, number> = { ALPHA: 100, BETA: 200 };",  // 不是状态码，是权重
      "// const statusCodeMap: Record<string, number> = { COMMENTED: 500 };",
      "if (e.code === 'ORDER_TERMINAL') return res.status(400).json({});",
      "const s = err.code === 'NOT_FOUND' ? 404 : 500;",
    ].join('\n');
    const stripped = stripComments(sample);
    expect((stripped.match(STATUS_TABLE_RE) ?? []).length, '注释里那张不该被数到').toBe(1);
    expect((stripped.match(STATUS_ENTRY_RE) ?? []).length).toBe(4);   // 404 + 409 + 100 + 200（宽口径形状）
    expect((stripped.match(STATUS_TERNARY_RE) ?? []).length).toBe(1);
    // 恒不匹配自检：把判据拿去扫一句真没有的话 ⇒ 必须 0，否则上面的数字没有意义
    expect('nothing here'.match(STATUS_TERNARY_RE) ?? []).toHaveLength(0);
  });
});
