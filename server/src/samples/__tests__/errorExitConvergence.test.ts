/**
 * §9 B22 第 6 域 · `samples/sampleRoute.ts`（47 处）收敛后的**执行**覆盖
 *
 * 为什么这个域和前五域不同：它是**最大单块**（47 处，占收敛前"总量表"的 28%），
 * 而且**曾经被自己的判据算成"无害"** —— 该文件早就 import 了真源（有一个端点先接上了），
 * B22 的"已接真源 / 未接真源"是按**文件**分的 ⇒ 另外 47 处 `message: e?.message ?? 'operation failed'`
 * 被归进"有意透传业务文案"那一侧。⇒ 站点级补刀见 `rawErrorLeakRatchet.test.ts` 的 `TRUTH_FILE_SITE_LEAKS`
 * （B22 第 4 次口径修正）。本文件因此额外钉一条：**旧写法那句英文兜底 `operation failed` 一处都不许剩**。
 *
 * 判据来源（外部，不抄实现现值）：
 *   ① 未预期异常 ⇒ 500，且响应体不得含内部原文（G6.5 / RFC 9110 §15.6.1）；
 *   ② 抛出型业务错误（自带 code + statusCode）⇒ 认它自己的档位与文案（G6.5 透传口径；
 *      本批的有意行为变更：收敛前这些一律被硬编码答成 500）；
 *   ③ 响应形状 nested `{error:{code,message}}` 与 47 枚码名一字不改（前端按 `error.code` 分支，D34）；
 *   ④ 对外文案必须"说清哪个对象 + 改动是否生效 + 下一步"（B31 判据的加强版：本批要求 ≥12 字且含下一步）。
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../shared/__tests__/utils/sourceScan';
import { ownerToken } from '../../__tests__/authTestHelper';
import { createSampleRouter } from '../sampleRoute';

const RAW = 'PrismaClientKnownRequestError: Invalid `prisma.sampleColorCard.findMany()` invocation in '
  + '/srv/app/server/src/samples/sampleRoute.ts:600 — The table `SampleColorCard` does not exist in the current database.';

function appWith(prisma: any) {
  const app = express();
  app.use(express.json());
  // requireAuth:false ⇒ 关掉模块守卫，本文件只看错误出口（守卫矩阵由既有 sampleRoute.test.ts 覆盖）
  app.use('/api/v1/samples', createSampleRouter({
    prisma, requireAuth: false, apiKeys: new Set<string>(), onDataChange: vi.fn(),
  }));
  return app;
}

/** 写端点有独立的 JWT 要求（API key 不可写，fail-closed）⇒ 这几个用例必须带持牌人令牌 */
const jwtHeader = { Authorization: `Bearer ${ownerToken}` };

/**
 * 任何 prisma 调用都抛给定错误（服务层拿不到数据 ⇒ 走到路由的 catch）。
 * 每一层都返回"**既可调用又可取属性**"的 Proxy：`prisma.a.b(...)` 与 `prisma.a(...)` 两种写法都会抛；
 * `then` 返回 undefined，避免这个 Proxy 被 await 当成 thenable 而卡住。
 */
function rejecting(err: Error): any {
  const mk = () => new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : mk()),
    apply: () => { throw err; },
  });
  return mk();
}

const INTERNAL_FRAGMENTS = ['PrismaClient', 'prisma.sampleColorCard', 'sampleRoute.ts:600', 'does not exist', '/srv/app'];

describe('B22 · samples 出口：内部原文不上屏', () => {
  it('GET /colors 服务层炸 → 500 + COLOR_LIST_FAILED + 中文文案 + 零内部细节', async () => {
    const res = await request(appWith(rejecting(new Error(RAW)))).get('/api/v1/samples/colors');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('COLOR_LIST_FAILED');
    const body = JSON.stringify(res.body);
    for (const frag of INTERNAL_FRAGMENTS) expect(body, `响应体不应含内部细节「${frag}」`).not.toContain(frag);
    expect(res.body.error.message).not.toContain('operation failed');
    expect(res.body.error.message).toMatch(/[一-龥]/);
    expect(res.body.error.message).toContain('色卡');
  });

  /**
   * ★ 本批当场撞出来的**第三条通道**（立 B33）：写端点的错误出口在服务层
   * （`fail('INTERNAL_ERROR', e?.message || '中文兜底', 500)`），路由的 catch 永远轮不到，
   * 于是路由侧收口 47 处之后，这条响应**仍然原样回显 Prisma 原文**。
   * 13:12 的现场：`{"error":{"code":"INTERNAL_ERROR","message":"PrismaClientKnownRequestError: … /srv/app/…:600 …"}}`
   * 期望依据是 G6.5（未预期异常不得把内部原文给客户端），不是当前行为 —— 本批把 samples 域 17 处改掉了，
   * 所以这一条现在是绿的；它同时是 B33 判据的**可执行样本**（其余 23 个文件 53 处仍未清，见棘轮基线）。
   */
  it('★ 写端点经服务层出口：不得回显原文，且文案要说清是哪个对象（B33 现场）', async () => {
    const res = await request(appWith(rejecting(new Error(RAW))))
      .post('/api/v1/samples/room/items').set(jwtHeader).send({ name: '样衣 A' });
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    for (const frag of INTERNAL_FRAGMENTS) expect(body, `响应体不应含内部细节「${frag}」`).not.toContain(frag);
    expect(res.body.error.message).toMatch(/[一-龥]/);
    expect(res.body.error.message).toContain('样卡登记');
  });

  it('读端点抛 404 型业务错误 ⇒ 不再一律答 500', async () => {
    const nf = Object.assign(new Error('色号不存在'), { code: 'COLOR_NOT_FOUND', statusCode: 404 });
    const res = await request(appWith(rejecting(nf))).get('/api/v1/samples/colors/NOPE');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COLOR_NOT_FOUND');
  });
});

describe('B22 · samples 源码棘轮与文案质量', () => {
  const src = () => stripComments(fs.readFileSync(path.join(__dirname, '..', 'sampleRoute.ts'), 'utf8'));

  it('47 处出口已改接真源；残留的 `message: X.message` 只允许来自真源结果', () => {
    const s = src();
    // 48 = 本批 47 + 该文件收敛前就有的 1 处（寄样历史查询）
    expect((s.match(/safeRouteError\((?:err|e), \{ fallbackCode: '/g) ?? []).length, '该文件接真源的出口总数').toBe(48);
    // 站点级：取原始异常的写法必须为 0（允许 message: r.message / message: se.message 这种真源结果透传）
    const bound = new Set([...s.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:safeRouteError|resolveError)\(/g)].map((m) => m[1]));
    const raw = [...s.matchAll(/message:\s*([A-Za-z_$][\w$]*)\??\.message/g)].filter((m) => !bound.has(m[1]));
    expect(raw.map((m) => m[0]), `仍有站点直接取原始异常：${JSON.stringify(raw.map((m) => m[0]))}`).toEqual([]);
    // 阳性对照：旧写法必须被抓到（防正则退化成恒不匹配）
    expect([...`res.status(500).json({ error: { code: 'X', message: e?.message ?? 'operation failed' } });`
      .matchAll(/message:\s*([A-Za-z_$][\w$]*)\??\.message/g)].filter((m) => !bound.has(m[1])).length).toBe(1);
  });

  it('★ 47 条兜底文案全部合格：含中文、≥12 字、给下一步，且没有一处留英文兜底话', () => {
    const copies = [...src().matchAll(/fallbackCode: '([A-Z][A-Z0-9_]*)', fallbackMessage: '([^']*)'/g)]
      .map((m) => ({ code: m[1], copy: m[2] }));
    expect(copies.length, '带文案的站点数（含本批之前那一处寄样历史）').toBe(48);
    const bad = copies.filter(({ copy }) => !/[\u4e00-\u9fa5]/.test(copy) || copy.length < 12);
    expect(bad, `不合格文案（非中文或过短）：${JSON.stringify(bad)}`).toEqual([]);
    // 下一步指引：要么"稍后重试"，要么"联系管理员"，要么明确不可逆提示
    const noNext = copies.filter(({ copy }) => !/(稍后重试|联系管理员|请确认|请勿据此)/.test(copy));
    expect(noNext, `文案没给下一步：${JSON.stringify(noNext)}`).toEqual([]);
    expect(src()).not.toMatch(/operation failed/);
    // T1 反向：期望值不是抄现值 —— 举两条真实文案，说明它们各自说清了对象
    const find = (code: string) => copies.find((c) => c.code === code)!.copy;
    expect(find('SHIPMENT_GATE_FAILED'), '门禁这条必须承认"看不到缺哪几条"（否则用户会误判可出运）').toContain('请勿据此');
    expect(find('ROOM_LOW_STOCK_FAILED'), '低库存这条不得把失败伪装成"没有货"（B6 同型）').toContain('不显示结论');
  });

  it('★ B33 本域清零钉子：samples 三个服务里不再出现「原文 || 中文兜底」', () => {
    const re = /[A-Za-z_$][\w$]*\??\.message\s*(?:\|\||\?\?)\s*'/;
    for (const f of ['sampleRoomService.ts', 'colorBatchService.ts', 'colorCardService.ts']) {
      const src = stripComments(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
      expect(re.test(src), `${f} 仍在用原始异常当对外文案`).toBe(false);
    }
    // 阳性对照：旧写法必须被抓到（防判据恒假）
    expect(re.test("return fail('X_FAILED', e?.message || '登记失败');")).toBe(true);
    // 反向：有意透传业务错误自带的文案（不带 || 兜底）不算 B33
    expect(re.test("return fail(e.code, e.message);")).toBe(false);
  });

  it('47 枚码名互不重复，且码名与收敛前一字未改（前端按 error.code 分支）', () => {
    const codes = [...src().matchAll(/fallbackCode: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBe(48);
    expect(new Set(codes).size, '同一文件内兜底码重名 = 文案与端点对不上号').toBe(48);
    for (const legacy of ['SS_CREATE_FAILED', 'COLOR_BATCH_DELETE_FAILED', 'ROOM_LOAN_RETURN_FAILED', 'CONVERT_TO_RESALE_FAILED']) {
      expect(codes, `收敛后码名必须保留「${legacy}」`).toContain(legacy);
    }
  });
});

/**
 * §9 **B39** · 位置参数内插原文（``fail(CODE, `固定文案: ${原文}`, 500)``）的**HTTP 级**执行覆盖。
 *
 * 这一条存在的理由就是第 7a 批的教训：**服务层文案改对了，也可能到不了用户** ——
 * 必须真打一次端点，断言响应体里没有内部原文。本域出口链已核：`sampleRoute.ts:90` 的 `sendResult`
 * 把 `r.error.message` **原样**转发（`res.status(r.error.status).json({ error: { code, message } })`）。
 *
 * ⚠️ 桩必须是**定向**的：`rejecting()` 会在事务之前的读就抛，落进路由 catch（`EPS_*_FAILED`），
 * 打不到服务层那处 B39 出口。这里让"事务前的读全部正常、只有 `$transaction` 抛"。
 */
const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/samples/earlyProductionSampleService.ts:143 — '
  + 'Unique constraint failed on the fields: (`sampleCode`)';
const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'earlyProductionSampleService.ts:143', 'Unique constraint', '/srv/app', 'P2002'];

const EPS_ORDER = { id: 'ORD-F1', orderNo: 'SO-F-1', type: 'Fabric', businessLine: 'fabric', status: 'in_production', clientDate: '2099-12-31', deletedAt: null };
function epsRow(over: any = {}) {
  return { id: 'EPS-1', orderId: 'ORD-F1', sampleCode: 'EPS-20990101-001', sampleQuantity: 10, sentToCustomer: false, customerStatus: 'pending', deletedAt: null, ...over };
}

/** 事务前读全部正常、`$transaction` 抛错 ⇒ 精确落在服务层那处 B39 catch */
function epsPrismaWithFailingTx(row: any = epsRow()) {
  return {
    order: { findFirst: async () => EPS_ORDER, findUnique: async () => EPS_ORDER },
    earlyProductionSample: {
      findFirst: async () => row,
      findMany: async () => [row],
      count: async () => 1,
    },
    $transaction: async () => { throw new Error(B39_RAW); },
  };
}

describe('§9 B39 · 早产样三端点：事务失败时用户收到的是中文（整链，非只服务层）', () => {
  const CASES: Array<{ path: string; body: any; code: string; mention: string }> = [
    { path: '/api/v1/samples/early-production/ORD-F1/rounds', body: { sampleQuantity: 10, cuttingDate: '2099-01-01' }, code: 'CREATE_FAILED', mention: '早期生产样' },
    { path: '/api/v1/samples/early-production/rounds/EPS-1/ship', body: {}, code: 'UPDATE_FAILED', mention: '寄送登记' },
    { path: '/api/v1/samples/early-production/rounds/EPS-1/feedback', body: { result: 'approved', confirmationDate: '2099-01-10', channel: 'email' }, code: 'UPDATE_FAILED', mention: '客户确认' },
  ];

  it('★ 三个端点都必须给出中文文案 + 500 + 码名不变，且响应体零内部细节', async () => {
    for (const { path: p, body, code, mention } of CASES) {
      // feedback 需要"已寄送"才走得到事务
      const row = p.endsWith('/feedback') ? epsRow({ sentToCustomer: true, sentDate: '2099-01-05' }) : epsRow();
      const res = await request(appWith(epsPrismaWithFailingTx(row)))
        .post(p).set(jwtHeader).send(body);
      expect(res.status, `${p} 服务层返回的 500 必须原样答出`).toBe(500);
      expect(res.body?.error?.code, `${p} 码名不得随文案一起改`).toBe(code);
      const raw = JSON.stringify(res.body);
      for (const frag of B39_FRAGMENTS) expect(raw, `${p} 响应体泄漏了「${frag}」`).not.toContain(frag);
      expect(res.body.error.message, `${p} 文案必须含中文`).toMatch(/[\u4e00-\u9fa5]/);
      expect(res.body.error.message, `${p} 文案必须说清对象`).toContain(mention);
      expect(res.body.error.message, `${p} 文案必须给下一步`).toMatch(/(稍后重试|联系管理员)/);
      const latin = res.body.error.message.match(/[A-Za-z]{3,}/g) ?? [];
      expect(latin, `${p} 混入拉丁词（疑似原文上屏）：${JSON.stringify(latin)}`).toEqual([]);
    }
  });
});
