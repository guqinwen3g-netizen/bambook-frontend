import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ownerToken } from '../../__tests__/authTestHelper';
import { fabricAuthorizationFixture } from '../../development/__tests__/fabricAuthorizationFixture';
import { logger } from '../../lib/logger';
import { NO_REVIEWER_RESOLVED, createApprovalRoutingService } from '../../approvals/approvalRoutingService';
import { lookupErrorCode, isBusinessError } from '../../shared/errorCodes';
import { statusFromError } from '../../shared/bizStatus';

/**
 * B124 ①（v3.06 修）：报价两条审批站的**档位** defect —— 「组织里没配审批人」原先答 **500**。
 *
 * 业务后果（★ 第一版把这句写大了，v3.06 复核 BLOCKER-1 纠正）：**这次变的只有状态码**。
 * 屏上那句话改前改后逐字相同（都是裸原文，且它本来就含"解析不到任何审批人"），
 * 注册表里那句更友好的文案**仍不可达**（＝B123，未修）。收益是：调用方终于能按 409 分支
 * （"部门没配审批人"是用户可自助修的事，不是我们的故障，不该按 5xx 处理）。
 *
 * ## 为什么期望值不是手抄的
 * 错误对象来自**真的** `approvalRoutingService`（喂一个查不到人的 stub prisma），
 * 关键档位期望来自**真的**注册表（`lookupErrorCode`）⇒ 这两处都不是我在测试里重抄的第二个真源。
 * ⚠️ 本文件里还有 409/500/404 三处字面值（下面各格）—— 它们是**故意钉的对外行为值**
 * （注册表或真尺被人改动时这些格必须红），与"钉实现字面"不同；v3.06 复核 MINOR-8 指出我第一版
 * 声称"唯一一处字面档位"是不成立的，故改成这一句。
 *
 * ## 文案这一半**刻意没收**（B123 未修），本文件把"为什么不能收"钉成判据
 * `noReviewerError()` 只挂 `code`、不挂 `statusCode` ⇒ `isBusinessError` 判它不是业务错
 * ⇒ 接 `safeRouteError` 会把可操作文案换成通用话，而前端把 `error.message` 原样上 toast。
 * 所以这里反过来断言：**真实错误对象上屏的仍然是那句可操作的话**。
 */

const auditMock = vi.hoisted(() => ({ writeRouteAuditLog: vi.fn() }));
vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: auditMock.writeRouteAuditLog,
  actorIdFromRequest: () => 'u_sales',
}));

const approvalMock = vi.hoisted(() => ({
  requestLineApproval: vi.fn(),
  requestTotalApproval: vi.fn(),
  getApprovalStatus: vi.fn(),
}));
vi.mock('../quotationApproval', () => ({
  createQuotationApprovalService: vi.fn(() => approvalMock),
}));

import { createQuotationRouter } from '../quotationRoute';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!req.headers.authorization) req.headers.authorization = `Bearer ${ownerToken}`;
    next();
  });
  app.use('/api/v1/quotations', createQuotationRouter({
    prisma: { ...fabricAuthorizationFixture('u_owner'), quotation: { findFirst: async () => ({ id: 'QT-1', ownerId: 'u_owner', customerRelationId: null, deletedAt: null }) } } as any,
    requireAuth: false,
    apiKeys: new Set<string>(),
    onDataChange: vi.fn(),
  }));
  return app;
}

/** 真·错误对象：让真的路由服务去解析一个不存在的申请人 ⇒ 它抛的就是线上那一颗 */
async function realNoReviewerError(): Promise<Error & { code?: string; statusCode?: number }> {
  const routing = createApprovalRoutingService({
    prisma: { userAccount: { findFirst: async () => null } } as any,
  });
  let thrown: any;
  try {
    await routing.resolveReviewerByDepartment('u_no_such_person');
  } catch (e) {
    thrown = e;
  }
  if (!thrown) throw new Error('承重前提失败：真路由服务没抛错 ⇒ 下面所有档位断言都是空的');
  return thrown;
}

describe('B124① · 报价审批两站：解析不到审批人答 409（走真尺），故障仍答 500', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    auditMock.writeRouteAuditLog.mockResolvedValue('alog_1');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('承重前提：真错误对象带 code、**不带 statusCode** ⇒ 这就是"文案不能收"的原因', async () => {
    const e = await realNoReviewerError();
    expect(e.code).toBe(NO_REVIEWER_RESOLVED);
    expect(e.statusCode).toBeUndefined();
    expect(isBusinessError(e)).toBe(false);          // ← 真源判它"不是业务错"
    expect(e.message).toContain('解析不到任何审批人'); // ← 这句必须留在屏上
  });

  it('对外契约（本文件唯一一处字面档位）：注册表把 NO_REVIEWER_RESOLVED 判 409', () => {
    expect(lookupErrorCode(NO_REVIEWER_RESOLVED)?.status).toBe(409);
  });

  it('映射层：真错误对象 ⇒ 409；认不出来的故障 ⇒ 显式兜底 500（默认 400 会把故障答成用户错）', async () => {
    const e = await realNoReviewerError();
    // ★ 这里钉**行为值 409**，不钉 `lookupErrorCode(...).status`：后者就是第 2 档的实现本身
    //   （`bizStatus.ts:72-74` 拿 code 查表），拿它当期望值等于自己对自己 ⇒ 复核 MINOR-4 判这条近乎无覆盖。
    expect(statusFromError(e, 500)).toBe(409);
    expect(statusFromError(new Error("Can't reach database server at localhost:5432"), 500)).toBe(500);
    // ★ 这一格被 **v3.11 B131** 改写过（不是"把红调绿"）：
    //   原来钉的是 `statusFromError(Can't reach database server...) === 400`，用作"默认兜底会把故障
    //   答成用户错"的病灶读数。B131 把这句原话补进了第 3 档 ⇒ 连不上库现在**不需要**显式兜底也是 500。
    expect(statusFromError(new Error("Can't reach database server at localhost:5432"))).toBe(500);
    // 仍然活着的教训（这才是本格要继续钉的东西）：**没入典、码也没登记**的故障，不写第二个参数就答 400
    expect(statusFromError(new Error('某条既没入典、也没登记的故障文案')),
      '默认兜底仍是 400 ⇒ "必须显式写 500"这一族的要求没被 B131 取消').toBe(400);
  });

  it('换道的一般后果（复核 IMPORTANT-2 要求显式钉住，不许只说"只动一枚码"）：带业务关键词的裸抛也从 500 改档', async () => {
    // 被 wrapCreateError 包过的错误：code=APPROVAL_CREATE_FAILED（未登记 ⇒ 第 2 档拿不到它），
    // 但消息里留着内层原文 ⇒ 关键词档生效。今天这条路抛不抛这种话由服务层决定，
    // 本批把档位交给真尺 ⇒ 这类原文一律按业务档答，不再一律 500。这一格钉的就是"从此按尺答"。
    approvalMock.requestLineApproval.mockRejectedValue(
      Object.assign(new Error('APPROVAL_CREATE_FAILED: 单据编号 QLD-1 已存在，不能重复建审批单'),
        { code: 'APPROVAL_CREATE_FAILED' }),
    );
    const res = await request(makeApp())
      .post('/api/v1/quotations/QT-1/lines/QL-1/request-approval').send({});
    expect(res.status).toBe(409);
    // 同一格的反面：不含关键词的故障仍答 500（别让关键词档把故障也吞成 4xx）
    approvalMock.requestLineApproval.mockRejectedValue(new Error('APPROVAL_CREATE_FAILED: prisma timeout'));
    const res2 = await request(makeApp())
      .post('/api/v1/quotations/QT-1/lines/QL-1/request-approval').send({});
    expect(res2.status).toBe(500);
  });

  it('活路径（条目级）：真错误对象上抛 ⇒ HTTP 409，且文案仍是那句可操作的话', async () => {
    const e = await realNoReviewerError();
    approvalMock.requestLineApproval.mockRejectedValue(e);
    const res = await request(makeApp())
      .post('/api/v1/quotations/QT-1/lines/QL-1/request-approval').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('解析不到任何审批人');
    // 响应体 code 属对外字符串，本批没跟着档位改（改它另立账）⇒ 这里钉住现状，别让它悄悄漂
    expect(res.body.error.code).toBe('APPROVAL_CREATE_FAILED');
  });

  it('活路径（总价级）：同一颗错误 ⇒ HTTP 409（两站同缺陷，必须各自被钉）', async () => {
    const e = await realNoReviewerError();
    approvalMock.requestTotalApproval.mockRejectedValue(e);
    const res = await request(makeApp()).post('/api/v1/quotations/QT-1/request-total-approval').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('解析不到任何审批人');
  });

  it('反面对照：数据库故障不得被改判成用户错（这一格把"兜底必须写 500"钉住）', async () => {
    approvalMock.requestLineApproval.mockRejectedValue(
      new Error("Can't reach database server at localhost:5432"),
    );
    const res = await request(makeApp())
      .post('/api/v1/quotations/QT-1/lines/QL-1/request-approval').send({});
    expect(res.status).toBe(500);
  });

  it('未改动的出口仍不变：NOT_FOUND ⇒ 404（走的是 catch 里更早那条分支，不经过真尺）', async () => {
    const nf = Object.assign(new Error('报价单不存在'), { code: 'NOT_FOUND' });
    approvalMock.requestTotalApproval.mockRejectedValue(nf);
    const res = await request(makeApp()).post('/api/v1/quotations/QT-1/request-total-approval').send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('旧写法不得复现：本文件不得再有"审批站写死 500"那一行（收敛数由上面两格活路径逐站钉）', () => {
    // ★ 只钉**旧写法不得回来**，不钉"新写法出现了几次"：后者是实现字面，
    //   B123 落地时这两站会换成 safeRouteError 形状 ⇒ 钉新写法会因为一次正当重构而假红（复核 IMPORTANT-3）。
    //   "两站都收了"这件事由上面两条活路径用例（条目级 / 总价级各一条）逐站钉住，不需要第三把尺。
    const src = readFileSync(path.resolve(__dirname, '../quotationRoute.ts'), 'utf-8');
    const hardcoded = src.split('\n').filter((l) =>
      /res\.status\(500\)\.json\(\{ error: \{ code: 'APPROVAL_CREATE_FAILED'/.test(l));
    expect(hardcoded, `这两行回来了 ⇒ 档位又变成写死：\n${hardcoded.join('\n')}`).toEqual([]);
  });
});
