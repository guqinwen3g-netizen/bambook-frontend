import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ownerToken } from '../../__tests__/authTestHelper';
import { statusFromError } from '../../shared/bizStatus';
import { createCustomsV2Router } from '../customsRouteV2';

/**
 * B124 ②（v3.06 修）：`GET /documents/:id` 原先把**一切**异常答成 `404 + error:'NOT_FOUND' + 原文`
 * ⇒ 数据库故障被说成「你要找的东西不存在」——比裸文案（B42）更坏一档：**连档位都是假的**。
 *
 * ★ 本文件不给服务层打桩：只往 `createCustomsV2Router({ prisma })` 里塞一个实现了 `tradeDocument.findFirst`
 *   的假 prisma ⇒ 走的是**真的** `getTradeDocument`（含它那句 `贸易单据 X 不存在` 裸抛）。
 *   这样"本站可达错误集"是被**跑出来**的，不是我照注释抄的（注释写"只有 1 条裸抛"，①那一格就是它的现证）。
 *
 * 本站可达出口逐条对应下面的用例（★ 都是**跑出来的**，不是照注释写的）：
 *   ① 查不到 → 真服务裸抛 `贸易单据 … 不存在` ⇒ **404**（状态、`error` 串、原文三样**逐字与改前相同**）
 *   ② 连接层故障 ⇒ **500**（★ 改前是假的 404 —— 这次修的就是它）
 *   ③ prisma 调用失败（消息含 `prisma`）⇒ **500**
 *   ④ 认不出来的异常 ⇒ 兜底 **500**（改前也是假的 404；"认不出来"不等于"不存在"）
 *   ⑤ 超长 id ⇒ Prisma `P2000` ⇒ **500**（★ 本批**新引入**的可见后果，改前答 404；两档都不对，
 *     正解是入口校验 ⇒ 另立 B126，⑤ 只负责把"今天答 500"钉成事实）
 * ⚠️ v3.06 复核 B-7 纠正：我第一版把"③/④"写成 `serialize()` 可达 —— 实际 `serialize` 对普通行不抛，
 *   所以那一格只是"兜底出口"的占位，不是已知的真实来源；同时它还指出我漏了 ⑤ 这条**新增**后果。
 */

function makeApp(findFirst: (args: any) => Promise<any>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!req.headers.authorization) req.headers.authorization = `Bearer ${ownerToken}`;
    next();
  });
  // 全程只碰 tradeDocument 一张表 ⇒ 别的模型不必存在
  app.use('/api/v1/customs/v2', createCustomsV2Router({
    prisma: { tradeDocument: { findFirst } } as any,
    requireAuth: false,
    apiKeys: new Set<string>(),
  }));
  return app;
}

describe('B124② · customs GET /documents/:id：档位不再由"一切皆 404"决定', () => {
  it('① 真服务查不到 ⇒ 404 逐字不变（对外契约：状态 + error 串 + 那句原文）', async () => {
    const res = await request(makeApp(async () => null)).get('/api/v1/customs/v2/documents/TD-1');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.message).toContain('不存在');
  });

  it('②★ 连接层故障 ⇒ 500（改前答 404 = 把故障说成"你要找的东西不存在"）', async () => {
    const res = await request(makeApp(async () => {
      throw new Error("Can't reach database server at 'localhost:5432'");
    })).get('/api/v1/customs/v2/documents/TD-1');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  it('③ prisma 调用失败 ⇒ 500（消息里带 prisma 就是系统故障，不是用户错）', async () => {
    const res = await request(makeApp(async () => {
      throw new Error('Invalid `prisma.tradeDocument.findFirst()` invocation: unknown field');
    })).get('/api/v1/customs/v2/documents/TD-1');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  it('④ 认不出来的内部 bug ⇒ 兜底 500（兜底若写 404，就又把 bug 伪装成"不存在"）', async () => {
    const res = await request(makeApp(async () => {
      throw new TypeError('boom_unrecognizable_internal_bug');
    })).get('/api/v1/customs/v2/documents/TD-1');
    expect(res.status).toBe(500);
  });

  it('承重前提：真尺的三个出口各给一档（404 只能由关键词档给出，兜底必须显式写 500）', () => {
    expect(statusFromError(new Error('贸易单据 TD-1 不存在'), 500)).toBe(404);
    expect(statusFromError(new Error("Can't reach database server at 'localhost:5432'"), 500)).toBe(500);
    expect(statusFromError(new TypeError('boom'), 500)).toBe(500);
    // ★ 反面对照的**沿革**（v3.11 B131 改写了这一格，别当成"有人把断言调绿了"）：
    //   这里原来钉的是 `statusFromError(new TypeError('boom')) === 400` —— 那是"默认兜底会把我们的崩溃
    //   答成用户错"的**病灶读数**。B131 加了 2c（编程错误族 ⇒ 500）之后崩溃已经不再走兜底，
    //   所以这一格现在钉的是**修后的语义**；"改前答 400"这句话归 §9 B131（改前的值不该钉在测试里，修法一落地就自杀）。
    expect(statusFromError(new TypeError('boom'))).toBe(500);
    // 仍然活着的教训：**认不出来的**故障，少写第二个参数就还是会答成 400 ⇒ 兜底档必须显式写的理由没变
    expect(statusFromError(new Error('某条既没入典、也没登记的故障文案')),
      '默认兜底仍是 400 ⇒ 这一族没被 2c/第 3 档接住，"显式写 500"依然是硬要求').toBe(400);
  });

  it('★ 新增可见后果（复核 B-7 抓到，本批不顺手修）：超长 id 走数据层档 ⇒ 500，改前答 404', async () => {
    // `req.params.id` 没有入口长度校验 ⇒ Prisma 对超长值抛 P2000，其 `code` 命中真尺的数据层档 ⇒ 500。
    // 两档都不对（客户端传错应当 400）⇒ 已另立 B126「补入口校验」，这一格只负责把"今天答 500"钉成事实，
    // 免得下一次有人把这条当成"档位修坏了"而回退整个 B124 ②。
    const prismaErr = Object.assign(new Error('Invalid `prisma.tradeDocument.findFirst()` invocation: P2000'),
      { code: 'P2000' });
    const res = await request(makeApp(async () => { throw prismaErr; }))
      .get('/api/v1/customs/v2/documents/TD-1');
    expect(res.status).toBe(500);
  });

  it('未牵连姊妹站：POST /documents 仍按原样答 500（本批范围只有详情那一站）', async () => {
    const res = await request(makeApp(async () => null))
      .post('/api/v1/customs/v2/documents').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });
});
