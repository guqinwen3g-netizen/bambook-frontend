/**
 * §9 B33 第 7a 批 · `credit/creditRoute.ts`（4 处）收敛后的**执行**覆盖 + 一处**收口点错位**的证据
 *
 * 一、4 个路由级 catch（:137 /:162 /:180 /:202）：本批把 `e?.message || '半截话'` 换成字面中文。
 *     棘轮只数形状，变绿不能证明"用户收到中文" ⇒ 这里补执行证据（R3 / §6 S1）。
 *
 * 二、★ 本文件更重要的一半：**信用冻结/解冻这条链有两个出口，只清一个等于没清**。
 *     · 出口 A（catch，:137/:162）—— 本批已清；
 *     · 出口 B（`result.error.message` 原样转发，:132/:157）—— 服务层 `creditService.ts:483/:518`
 *       自己把原文拼进了文案：`fail(CREDIT_WRITE_FAILED, `冻结事务失败: ${String(e?.message ?? e)}`, 500)`。
 *       ⇒ 事务失败时用户收到的是 `冻结事务失败: PrismaClientKnownRequestError: … /srv/app/…`。
 *     ⚠️ 出口 B **四条既有判据一条都不认**：
 *        B22 看对象字面量里的 `message:`；B30 的 `WRAP_RE` 要求 `message|error|reason` **键名**在前
 *        （位置参数 `fail(CODE, \`…\`, 500)` 不在判据内）；B33 要求"原文 **||** 中文引号兜底"；
 *        B36/B37 各要自己的形状。⇒ 与 B33/B36/B37 同一根因（认语法形状，不认用户收到什么）。
 *     本文件用**执行**把出口 B 钉住：它的期望值来自 G6.5（未预期异常不得把内部原文给客户端），
 *     不是抄实现现值。
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { authHeader, ownerToken } from '../../__tests__/authTestHelper';
import { createCreditRouter } from '../creditRoute';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/credit/creditService.ts:469 — '
  + 'Unique constraint failed on the fields: (`id`)';

/** 任何 prisma 调用都抛给定错误（与 samples/procurement 两份同一实现，不新造第三套） */
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
  app.use('/api/v1/credit', createCreditRouter({ prisma, requireAuth: false }));
  return app;
}

/** 事务之前能拿到 Active/Frozen 额度行，但 `$transaction` 整体失败 ⇒ 走"出口 B" */
function prismaWithFailingTx(limitStatus: 'Active' | 'Frozen'): any {
  return {
    creditLimit: {
      findMany: async () => [{ id: 'CL-1', relationId: 'C1', status: limitStatus, deletedAt: null, limitAmount: 100000, usedAmount: 0, frozenBy: null }],
      findFirst: async () => ({ id: 'CL-1', relationId: 'C1', status: limitStatus, deletedAt: null }),
    },
    creditLimitHistory: { findMany: async () => [], count: async () => 0 },
    $transaction: async () => { throw new Error(RAW); },
  };
}

const INTERNAL_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'creditService.ts:469', 'Unique constraint', '/srv/app'];
const JWT = authHeader(ownerToken);

/** 对外文案硬门槛：含中文、够长、说下一步、零拉丁词（原文上屏最直观的指纹） */
function expectBusinessCopy(msg: unknown, mustMention: string) {
  expect(typeof msg, '对外文案必须是字符串').toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '对外文案必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `对外文案必须说清对象：${s}`).toContain(mustMention);
  expect(s, `对外文案没有下一步：${s}`).toMatch(/(稍后重试|联系管理员|请确认|请勿)/);
  const latin = s.match(/[A-Za-z]{3,}/g) ?? [];
  expect(latin, `对外文案混入拉丁词（疑似原文上屏）：${JSON.stringify(latin)}`).toEqual([]);
}

describe('B33 7a · creditRoute 路由级 catch：内部原文不上屏（出口 A）', () => {
  const EXITS: Array<{ method: 'post' | 'get'; path: string; body?: any; mention: string }> = [
    { method: 'post', path: '/api/v1/credit/C1/freeze', body: { reason: '额度超限，人工冻结' }, mention: '冻结' },
    { method: 'post', path: '/api/v1/credit/C1/thaw', body: { reason: '已结清，主管解冻' }, mention: '解冻' },
    { method: 'get', path: '/api/v1/credit/C1/status', mention: '信用状态' },
    { method: 'get', path: '/api/v1/credit/C1/history', mention: '信用历史' },
  ];

  it('★ 4 个端点数据库层整体炸 ⇒ 500 + 中文文案 + 响应体零内部细节', async () => {
    const app = appWith(rejecting(new Error(RAW)));
    for (const { method, path: p, body, mention } of EXITS) {
      const req = method === 'post' ? request(app).post(p).set(JWT).send(body ?? {}) : request(app).get(p).set(JWT);
      const res = await req;
      expect(res.status, `${method.toUpperCase()} ${p} 未预期异常必须是 500`).toBe(500);
      expect(res.body?.error, `${p} 码名不得随文案一起改`).toBe('INTERNAL_ERROR');
      const raw = JSON.stringify(res.body);
      for (const frag of INTERNAL_FRAGMENTS) {
        expect(raw, `${p} 响应体泄漏了内部细节「${frag}」`).not.toContain(frag);
      }
      expectBusinessCopy(res.body.message, mention);
    }
  });

  it('原文必须仍在日志里（清文案 ≠ 丢证据）', async () => {
    const { logger } = await import('../../lib/logger');
    (logger.error as any).mockClear();
    await request(appWith(rejecting(new Error(RAW)))).get('/api/v1/credit/C1/status').set(JWT);
    const calls = (logger.error as any).mock.calls;
    expect(calls.find((c: any[]) => c[1] && c[1].error === RAW), `catch 必须把原文写进日志：${JSON.stringify(calls)}`).toBeTruthy();
  });
});

describe('★ 出口 B · 服务层结果通道（`result.error.message` 原样转发）：同一处缺陷的第二个出口', () => {
  /**
   * 为什么必须单独钉：`creditRoute.ts:132/:157` 把 `result.error.message` **原样**给客户端。
   * 于是"事务失败"这条路径**根本走不到路由的 catch** —— 本批清掉的 :137/:162 是**死代码级**的安慰，
   * 用户看到的原文来自 `creditService.ts:483/:518`。清文案不覆盖它 = 没清。
   */
  it('冻结：事务失败 ⇒ 不得把 Prisma 原文给客户端（G6.5）', async () => {
    const res = await request(appWith(prismaWithFailingTx('Active')))
      .post('/api/v1/credit/C1/freeze').set(JWT).send({ reason: '额度超限，人工冻结' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('CREDIT_WRITE_FAILED');
    const raw = JSON.stringify(res.body);
    for (const frag of INTERNAL_FRAGMENTS) {
      expect(raw, `冻结事务失败响应泄漏了「${frag}」`).not.toContain(frag);
    }
    expectBusinessCopy(res.body.message, '冻结');
  });

  it('解冻：事务失败 ⇒ 不得把 Prisma 原文给客户端（G6.5）', async () => {
    const res = await request(appWith(prismaWithFailingTx('Frozen')))
      .post('/api/v1/credit/C1/thaw').set(JWT).send({ reason: '已结清，主管解冻' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('CREDIT_WRITE_FAILED');
    const raw = JSON.stringify(res.body);
    for (const frag of INTERNAL_FRAGMENTS) {
      expect(raw, `解冻事务失败响应泄漏了「${frag}」`).not.toContain(frag);
    }
    expectBusinessCopy(res.body.message, '解冻');
  });
});
