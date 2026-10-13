/**
 * §9 B33 第 7a 批 · `procurement/materialReturnService.ts`（5 处）收敛后的**执行**覆盖
 *
 * 为什么本批必须补这一份（R3 覆盖派生 / §6 S1）：
 *   7a 批把这 5 处 `fail('X', e?.message || '半截话', 500)` 改成了**字面中文**。
 *   棘轮（`serviceRawEchoRatchet.test.ts`）只数**语法形状**，它变绿只能证明"没有这种写法了"，
 *   **不能证明用户收到的是中文** —— 文案改动若无人执行，按 S1 不得写「已清」。
 *   所以本文件把"用户到底收到什么"钉成可执行断言。
 *
 * 判据来源（外部，不抄实现现值）：
 *   ① 未预期异常 ⇒ 500，且响应体不得含内部原文（G6.5 / RFC 9110 §15.6.1）；
 *   ② 对外文案必须含中文、说清对象与下一步（B31）；
 *   ③ 码名一字不改（前端按 `error.code` 分支，D34）—— 本批只换文案，不换码；
 *   ④ 原文**必须**仍在日志里（否则等于把线索删了：清文案 ≠ 丢证据）。
 *
 * ★ 出口链路已核对（不是假设）：`procurementRoute.ts` 的 `mrRespond` 把
 *   `result.error.message` **原样**转发给客户端 ⇒ 服务层文案就是用户看到的东西，
 *   不存在"改了服务层但被路由覆盖掉"的收口点错位。
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../shared/__tests__/utils/sourceScan';
import { authHeader, ownerToken } from '../../__tests__/authTestHelper';
import { createProcurementRouter } from '../procurementRoute';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const RAW = 'PrismaClientKnownRequestError: Invalid `prisma.materialReturn.findUnique()` invocation in '
  + '/srv/app/server/src/procurement/materialReturnService.ts:212 — '
  + 'Unique constraint failed on the fields: (`returnNumber`)';

/**
 * 任何 prisma 调用都抛给定错误 ⇒ 服务层拿不到数据，走到自己的 catch。
 * 每一层都返回"**既可调用又可取属性**"的 Proxy：`prisma.a.b(...)` 与 `prisma.a(...)` 都会抛；
 * `then` 返回 undefined，避免这个 Proxy 被 await 当成 thenable 而卡住。
 * （与 `samples/__tests__/errorExitConvergence.test.ts` 同一实现，本批不新造第二套。）
 */
function rejecting(err: Error): any {
  const mk = () => new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : mk()),
    apply: () => { throw err; },
  });
  return mk();
}

function appWith(prisma: any) {
  const app = express();
  app.use(express.json());
  // requireAuth:false ⇒ 关掉模块守卫；写端点仍要 JWT（requireJwtForWrite 不感知该开关）
  app.use('/api/v1/procurement', createProcurementRouter({
    prisma, requireAuth: false, apiKeys: new Set<string>(), onDataChange: vi.fn(),
  }));
  return app;
}

const INTERNAL_FRAGMENTS = ['PrismaClient', 'prisma.materialReturn', 'materialReturnService.ts:212', 'Unique constraint', '/srv/app', 'P2002'];

/** 对外文案的硬门槛：含中文、够长、说下一步、零拉丁词（原文泄漏最直观的特征） */
function expectBusinessCopy(msg: unknown, mustMention: string) {
  expect(typeof msg, '对外文案必须是字符串').toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）⇒ 用户不知道发生了什么：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '对外文案必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `对外文案必须说清对象：${s}`).toContain(mustMention);
  expect(s, `对外文案没有下一步（稍后重试 / 联系管理员）：${s}`).toMatch(/(稍后重试|联系管理员|请确认|请勿)/);
  // ★ 拉丁词是"原文上屏"最直接的指纹：这 5 条文案是纯中文，出现任何 ≥3 字母的拉丁串都是回归
  const latin = s.match(/[A-Za-z]{3,}/g) ?? [];
  expect(latin, `对外文案混入拉丁词（疑似原文上屏）：${JSON.stringify(latin)}`).toEqual([]);
}

const JWT = authHeader(ownerToken);

/** 5 个写端点：路径 → 期望码 + 文案必须点名的业务对象 */
const WRITE_EXITS: Array<{ path: string; code: string; mention: string }> = [
  { path: '/api/v1/procurement/material-returns', code: 'CREATE_FAILED', mention: '退换货登记' },
  { path: '/api/v1/procurement/material-returns/MR-1/mark-shipped', code: 'SHIP_FAILED', mention: '发运确认' },
  { path: '/api/v1/procurement/material-returns/MR-1/confirm', code: 'CONFIRM_FAILED', mention: '供应商确认' },
  { path: '/api/v1/procurement/material-returns/MR-1/settle', code: 'SETTLE_FAILED', mention: '结算' },
  { path: '/api/v1/procurement/material-returns/MR-1/cancel', code: 'CANCEL_FAILED', mention: '取消' },
];

describe('B33 7a · materialReturn 出口：内部原文不上屏（执行证据）', () => {
  /**
   * ★ 载荷必须**先过参数校验**，否则拿到的是 400（RECEIPT_REQUIRED / MATERIAL_CODE_REQUIRED …）
   *   而不是我们要钉的 500 出口 —— 我第一版就是漏了 `materialCode`，红在 400 上，
   *   那是**我的用例错**，不是产品缺陷。登记单这一支只有合法载荷才会走到 DB 层。
   */
  const VALID_BODY = { receiptId: 'MR-1', type: 'return', materialCode: 'FAB-X', quantity: 1, unit: 'm' };

  it('★ 5 个写端点在"数据库层整体炸"时都必须给出中文文案 + 500，且响应体零内部细节', async () => {
    const app = appWith(rejecting(new Error(RAW)));
    for (const { path: p, code, mention } of WRITE_EXITS) {
      const res = await request(app).post(p).set(JWT).send(VALID_BODY);
      expect(res.status, `${p} 未预期异常必须是 500（拿到 4xx 说明载荷没过校验，不是本用例要钉的出口）`).toBe(500);
      expect(res.body?.error?.code, `${p} 码名不得随文案一起改（前端按码分支）`).toBe(code);
      const body = JSON.stringify(res.body);
      for (const frag of INTERNAL_FRAGMENTS) {
        expect(body, `${p} 响应体泄漏了内部细节「${frag}」`).not.toContain(frag);
      }
      expectBusinessCopy(res.body.error.message, mention);
    }
  });

  it('★ 原文必须仍在日志里（清文案 ≠ 丢证据：没有日志就等于把线索删了）', async () => {
    const { logger } = await import('../../lib/logger');
    (logger.error as any).mockClear();
    const app = appWith(rejecting(new Error(RAW)));
    await request(app).post('/api/v1/procurement/material-returns/MR-1/settle').set(JWT).send({});
    const calls = (logger.error as any).mock.calls;
    const hit = calls.find((c: any[]) => c[1] && c[1].error === RAW);
    expect(hit, `catch 里必须把原文写进日志，实际调用：${JSON.stringify(calls)}`).toBeTruthy();
    expect(String(hit![0])).toContain('[MaterialReturn]');
  });
});

describe('B33 7a · 源码棘轮与文案质量（防"数字清了、文案还是半截话"）', () => {
  const src = () => stripComments(fs.readFileSync(path.join(__dirname, '..', 'materialReturnService.ts'), 'utf8'));

  it('★ 该文件「原文 || 中文兜底」必须为 0（阳性对照保证判据不是恒假）', () => {
    const re = /[A-Za-z_$][\w$]*\??\.message\s*(?:\|\||\?\?)\s*'/;
    expect(re.test(src()), 'materialReturnService.ts 仍在用原始异常当对外文案').toBe(false);
    // 阳性对照：旧写法必须被抓到
    expect(re.test("return fail('SETTLE_FAILED', e?.message || '结算完成失败', 500);")).toBe(true);
    // 反向：有意透传业务错误自带的文案（不带 || 兜底）不算 B33
    expect(re.test("return fail(e.code, e.message);")).toBe(false);
  });

  it('★ 5 条对外文案逐条合格：含中文、≥20 字、说清对象与下一步，且互不共用同一句', () => {
    const copies = [...src().matchAll(/fail\('(CREATE_FAILED|SHIP_FAILED|CONFIRM_FAILED|SETTLE_FAILED|CANCEL_FAILED)', '([^']*)'/g)]
      .map((m) => ({ code: m[1], copy: m[2] }));
    expect(copies.map((c) => c.code).sort()).toEqual(
      ['CANCEL_FAILED', 'CONFIRM_FAILED', 'CREATE_FAILED', 'SETTLE_FAILED', 'SHIP_FAILED']);
    for (const { code, copy } of copies) {
      expect(copy, `${code} 文案不合格`).toMatch(/[\u4e00-\u9fa5]/);
      expect(copy.length, `${code} 文案过短`).toBeGreaterThanOrEqual(20);
      expect(copy, `${code} 文案没给下一步`).toMatch(/(稍后重试|联系管理员)/);
    }
    expect(new Set(copies.map((c) => c.copy)).size, '5 条文案不得共用一句（共用=用户分不清哪步失败了）').toBe(5);
    // 旧的半截话一处都不许剩
    for (const legacy of ['退换货登记失败', '发运确认失败', '供应商确认失败', '结算完成失败', '取消失败']) {
      expect(src(), `残留旧半截话「${legacy}」`).not.toContain(`'${legacy}'`);
    }
  });

  /**
   * ★ 本批唯一一处**不敢套模板**的文案：`markShipped` 的出库流水在事务**之前**已落库
   *   （幂等防重会兜住重试），所以失败时"没有写入任何数据"是**假话**。
   *   这条断言把"文案不得给业务员假结论"变成可执行的 —— 谁把它改成统一模板，这里就红。
   */
  it('★ 文案不得给假结论：有事务前副作用的出口不许说"没有写入任何数据"', () => {
    const s = src();
    const copyOf = (code: string) =>
      s.match(new RegExp(`fail\\('${code}', '([^']*)'`))?.[1] ?? '';
    // markShipped（事务前有 Outbound 出库）与 confirmReturn（事务前有 exchange Inbound 回冲）：
    // 文案只承诺"状态未变更"
    expect(copyOf('SHIP_FAILED'), 'markShipped 事务前已写出库流水 ⇒ 不得声称零写入').not.toContain('没有写入任何数据');
    expect(copyOf('SHIP_FAILED')).toContain('仍停在待退回状态');
    expect(copyOf('CONFIRM_FAILED'), 'confirmReturn 事务前已写回冲流水 ⇒ 不得声称零写入').not.toContain('没有写入任何数据');
    expect(copyOf('CONFIRM_FAILED')).toContain('仍停在已退回状态');
    // 纯状态流转的三处（登记/结算/取消）：全在事务内 ⇒ "零写入"是可证成立的
    for (const code of ['CREATE_FAILED', 'SETTLE_FAILED', 'CANCEL_FAILED']) {
      expect(copyOf(code), `${code} 全在事务内，应明确告知未写入`).toContain('没有写入任何数据');
    }
  });
});
