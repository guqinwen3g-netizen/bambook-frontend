/**
 * 签字端点的错误出口契约（S0-A 终评 Important #1 回归钉子）
 *
 * ── 病灶（不是推测，是终评抓到 + 本文件复现）────────────────────
 * S0-A Task 4 给 `StageGateError` 补了 `statusCode`（默认**一律 409**）。副作用是它从此
 * 满足 `isBusinessError` 判据（`code:string` + `statusCode:number`）⇒
 * **逃出 service try/catch 的拒绝**从此走「业务错误原样透传」分支。
 *
 * 对 `POST /:orderId/sign/:stageKey` 而言，净效果是：
 *   收敛前：500 + `SIGN_FAILED` + 注册表通用中文文案
 *   收敛后：409 + `INVALID_STAGE` + **`"Stage pp not found"`（内部英文串直接上屏）**
 * 而同一个码在 block 端点被 `route.ts` 的 statusCodeMap 答成 **400**
 * ⇒ 本批要杀的「内部文本上屏 + 同码不同状态」被本批自己又造出来一次。
 *
 * ── 本文件钉的三件事 ──────────────────────────────────
 * ① 逃出 service 的 `INVALID_STAGE` 经 `resolveError` 后**必须是 4xx 且不是 409**（与 block 端点同码同状态）
 * ② 它给用户的文案**必须是中文业务文案**，且**不得含内部英文串**（`Stage ... not found` 这类）
 * ③ service 里**每一处** `throw new StageGateError(...)` 的文案都必须含中文 ——
 *    把「抛出点文案是产品资产」从口头约定变成可红守卫
 *
 * ⚠️ 不在此文件处理（有意）：`route.ts` 与 `routeV2.ts` **两本互相打架的码→状态映射** ——
 *    那是行为契约选边，已登记为 §9 阻塞项，不在本批拍板。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { lookupErrorCode, resolveError } from '../../shared/errorCodes';
import { stripComments } from '../../shared/__tests__/utils/sourceScan';

vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('audit_test_id'),
}));
vi.mock('../../notifications/notificationService', () => ({
  createNotificationService: () => ({ broadcastNotification: vi.fn().mockResolvedValue({ count: 1 }) }),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVC = path.resolve(HERE, '..', 'stageService.ts');

/** 只喂「stage 查不到」这一条分支：findUnique 返回 null ⇒ signStage 直接 throw */
function prismaWithoutStage() {
  return { productionStage: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
}

describe('签字端点错误出口（终评 Important #1）', () => {
  it('① 逃出的 INVALID_STAGE 经 resolveError 后必须是 400，不是本批引入的一律 409', async () => {
    const { signStage } = await import('../stageService');
    let thrown: unknown;
    try {
      await signStage({
        prisma: prismaWithoutStage(),
        orderId: 'O1',
        stageKey: 'pp',
        signType: 'production',
        signerId: 'U1',
      });
    } catch (e) { thrown = e; }
    expect(thrown, 'stage 不存在时必须抛（否则本契约无从谈起）').toBeInstanceOf(Error);

    // 这就是 route 的 catch 实际做的事：safeRouteError → resolveError
    const r = resolveError(thrown, 'SIGN_FAILED');
    expect(r.code).toBe('INVALID_STAGE');
    expect(r.status, '内部标识查不到是调用方输入问题 ⇒ 4xx；5xx 会把用户引去"稍后重试"').toBe(400);
    expect(r.status, '不得是一律 409 的地板值').not.toBe(409);
  });

  it('② 给用户的文案必须是中文业务文案，且不得把内部英文串甩上屏', async () => {
    const { signStage } = await import('../stageService');
    let thrown: unknown;
    try {
      await signStage({ prisma: prismaWithoutStage(), orderId: 'O1', stageKey: 'pp', signType: 'production', signerId: 'U1' });
    } catch (e) { thrown = e; }
    const r = resolveError(thrown, 'SIGN_FAILED');
    expect(/[一-龥]/.test(r.message), `上屏文案必须是中文：${r.message}`).toBe(true);
    expect(r.message.toLowerCase()).not.toMatch(/not found|not initialized|invalid stage|stage .* not/);
  });

  it('③ 状态来自注册表（一张表），不是类里再写一本映射', async () => {
    const { StageGateError } = await import('../stageService');
    const spec = lookupErrorCode('INVALID_STAGE');
    expect(spec, 'INVALID_STAGE 必须已登记进注册表').toBeDefined();
    const e = new StageGateError('INVALID_STAGE', '工序不存在，请刷新后重试。');
    expect(e.statusCode, '默认状态必须查表得到，不得是硬编码地板值').toBe(spec!.status);
    expect(e.statusCode).toBe(400);
    // 表内没有的码仍走地板值（本批不改这个取舍，见文件头「不在此文件处理」）
    expect(new StageGateError('SOME_FUTURE_GATE_CODE', 'x').statusCode).toBe(409);
  });

  it('★ 守卫：service 里每一处 throw new StageGateError 的文案都必须含中文', async () => {
    const src = stripComments(fs.readFileSync(SVC, 'utf8'));
    const sites = [...src.matchAll(/throw new StageGateError\(\s*(?:'([A-Z0-9_]+)'|[\w.]+)\s*,\s*(`[^`]*`|'[^']*'|"[^"]*")/g)];
    // 精确数（不用松阈值）：2026-09-20 实测 —— 全文件 `throw new StageGateError(` 共 **17** 处，
    // 判据认到 **16** 处；唯一不覆盖的是 `stageService.ts` 里 `throw new StageGateError(first.code, first.message)`
    // 那一处**动态转发**（文案取自上面某个码，已被各自的字面量覆盖）。新增抛出点会把这个数顶歪 ⇒ 逼人来更新判据。
    const total = (src.match(/throw new StageGateError\(/g) ?? []).length;
    // f886194c adds exactly one native blocked-source branch, independently
    // exercised below. 92df64c5 adds three Chinese typed legacy-QC refusals
    // (actual inspector, native decision entry, immutable report); original
    // 17/16 coverage and the single dynamic relay remain unchanged.
    expect(total, '抛出点总数与基线不符（新增抛出点 ⇒ 请确认它的文案是中文，再更新本数）').toBe(21);
    expect(sites.length, '判据认得率与基线不符（正则失效或出现新写法）').toBe(20);
    const englishOnly = sites.filter((m) => {
      const msg = m[2].replace(/^["'`]|["'`]$/g, '');
      return !/[一-龥]/.test(msg);
    }).map((m) => `${m[1] ?? '<动态码>'}: ${m[2]}`);
    expect(englishOnly, `这些业务拒绝的文案是纯英文，会直接上屏：${JSON.stringify(englishOnly)}`).toEqual([]);
  });

  it('新增来源核验失败抛点保留PP_RELEASE_BLOCKED与中文文案，不冒充未知SQL', async () => {
    const source = fs.readFileSync(SVC, 'utf8');
    const ast = ts.createSourceFile(SVC, source, ts.ScriptTarget.Latest, true);
    const hits: ts.IfStatement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && node.expression.getText(ast) === '!summary.ok'
        && ts.isThrowStatement(node.thenStatement)) hits.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(hits).toHaveLength(1);
    const statement = hits[0].thenStatement.getText(ast);
    const compiled = ts.transpileModule(statement, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const { StageGateError } = await import('../stageService');
    let thrown: unknown;
    try { vm.runInNewContext(compiled, { StageGateError }, { timeout: 1000 }); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(StageGateError);
    expect(resolveError(thrown, 'SIGN_FAILED')).toMatchObject({ code: 'PP_RELEASE_BLOCKED', status: 409,
      message: '当前放行范围无法核验，请核对原批准来源' });
    // A storage error never executes this deliberately native branch.
    expect(resolveError(new Error('SQL private_release P2003'), 'SIGN_FAILED'))
      .toMatchObject({ code: 'SIGN_FAILED', status: 500 });
  });

  it('★ 上一条的阳性对照：纯英文文案必须被抓住（防判据退化成恒不匹配）', async () => {
    const sample = [
      "throw new StageGateError('INVALID_STAGE', '工序不存在，请刷新后重试。');",
      "throw new StageGateError('INVALID_STAGE', `Stage ${stageKey} not found`);",
    ].join('\n');
    const hits = [...sample.matchAll(/throw new StageGateError\(\s*(?:'([A-Z0-9_]+)'|[\w.]+)\s*,\s*(`[^`]*`|'[^']*'|"[^"]*")/g)]
      .filter((m) => !/[一-龥]/.test(m[2].replace(/^["'`]|["'`]$/g, '')))
      .map((m) => m[2]);
    expect(hits, '第二条（英文模板串）必须被判据抓出，第一条（中文）不得被抓').toEqual(['`Stage ${stageKey} not found`']);
  });
});
