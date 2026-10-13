/**
 * globalErrorHandler 契约钉子（S0-A Task 3）
 * 它是唯一出口：业务错误必须透传（含 409 的门禁明细），未预期错误必须换通用文案。
 * 用假 res 直接调中间件，不起 HTTP —— 与本仓「判定逻辑零 import 成文件」的路子一致。
 *
 * 日志断言用 mock：既钉住「级别 + 带 stack」这两条硬约束（判序的机器证据），
 * 也避免本文件的用例往 stdout 里刷真 warn/error 行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorRequestHandler } from 'express';
import { GENERIC_ROUTE_ERROR_MESSAGE } from '../../shared/errorCodes';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger', () => ({ logger: loggerMock }));

// vi.mock 会被提升到所有 import 之前，故下面静态 import 的中间件拿到的已是 mock logger
import { globalErrorHandler } from '../asyncHandler';

beforeEach(() => {
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

function fakeRes() {
  const calls: Array<{ status: number; body: unknown }> = [];
  const res: any = {
    headersSent: false,
    status(code: number) {
      this._code = code;
      return this;
    },
    json(body: unknown) {
      calls.push({ status: this._code, body });
      return this;
    },
  };
  return { res, calls };
}

/** 返回 next 的 spy，方便断言「本分支不该把错误交回 Express」 */
const run = (err: unknown, res: any) => {
  const next = vi.fn();
  (globalErrorHandler as ErrorRequestHandler)(err, { method: 'GET', originalUrl: '/x' } as any, res, next);
  return next;
};

describe('globalErrorHandler', () => {
  /**
   * M7：中间件不再覆写文案 —— 500 的通用文案完全由注册表给
   * （INTERNAL_ERROR 不在 ERROR_CODES 表内 ⇒ resolveError 落到 GENERIC_ROUTE_ERROR_MESSAGE）。
   * 本用例就是「删掉冗余三元后响应形状不变」的证据。
   */
  it('未预期异常 → 500 + 通用文案，原始细节不外泄', () => {
    const { res, calls } = fakeRes();
    run(new Error('PrismaClientKnownRequestError: Unknown argument `deletedAts`'), res);
    expect(calls[0].status).toBe(500);
    const body = calls[0].body as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(body.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    expect(JSON.stringify(body)).not.toContain('Prisma');
    expect(JSON.stringify(body)).not.toContain('deletedAts');
  });

  it('★ 业务错误（code+statusCode，4xx）→ 原样透传，含自己的状态码与文案；只记 warn 不外发告警', () => {
    const { res, calls } = fakeRes();
    run(Object.assign(new Error('币种不一致'), { code: 'CURRENCY_MISMATCH', statusCode: 400 }), res);
    expect(calls[0].status).toBe(400);
    expect(calls[0].body).toMatchObject({ error: 'CURRENCY_MISMATCH', message: '币种不一致' });
    // 4xx 业务错误不该进 error 级（webhook 告警面只吃 error 级，「币种不一致」不叫醒人）
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  /**
   * ★ I1：门禁明细的**真实形状**钉子（不再用编造的 payload）。
   *
   * 生产者 = `shipping/shipmentMutationService.ts:166-175`：抛出
   *   { code:'GATE_BLOCKED', statusCode:409,
   *     gateDetails:{ blockingReasons:string[], orders:OrderShipmentGateOutcome[],
   *                   exceptionReason?:ExceptionInactiveReason, exceptionEntryHint:string } }
   * —— orders 是**逐订单判定结果对象数组**，不是「orderId/orderNo/missing」那种编造形状。
   *
   * 消费者 = `services/shipmentService.ts` 的 `extractGateBlock`：
   *   仅当 `e.code === 'GATE_BLOCKED' && e.gateDetails && Array.isArray(e.gateDetails.orders)` 才认这条门禁响应。
   *
   * ⇒ 所以本用例故意**不**只断言「明细带出来了」，而是同时钉住两件事：
   *   ① 明细内容逐字随附在 `details` 键下；② 管道**不产出** `gateDetails` 键。
   *   ②就意味着 `extractGateBlock` 会**拒绝**本管道的输出 —— 用户只看到一句提示、
   *   看不到「哪个订单缺哪条」，门禁面板静默失效。
   *   按 controller 裁定（spec §3.3）：现在**不**给中间件加兼容用的 `gateDetails` 键 ——
   *   没有任何路由会经管道产出它，而 spec 在做成 ①保留原键名 或 ②让 extractGateBlock 也认 details
   *   之前禁止把 shipping 域接进本管道。本用例把这个限制**写清楚**，而不是把它洗成「契约已满足」。
   */
  it('★ GATE_BLOCKED 409：真实 gateDetails 对象随附为 details，且管道不再产出 gateDetails 键（shipping 因此禁止接入管道，见 spec §3.3）', () => {
    const gateDetails = {
      blockingReasons: ['ORD__so1:SS_NOT_CONFIRMED', 'ORD__so1:BULK_QC_NOT_PASSED'],
      orders: [
        {
          orderId: 'ORD__so1',
          chain: 'garment',
          eligible: false,
          blockingReasons: ['SS_NOT_CONFIRMED', 'BULK_QC_NOT_PASSED'],
        },
      ],
      exceptionReason: 'NO_ACTIVE_EXCEPTION',
      exceptionEntryHint: '如需放行请在「受控例外」中申请',
    };
    const { res, calls } = fakeRes();
    run(Object.assign(new Error('出运放行门禁未通过'), {
      code: 'GATE_BLOCKED', statusCode: 409, gateDetails,
    }), res);
    expect(calls[0].status).toBe(409);
    const body = calls[0].body as any;
    expect(body.error).toBe('GATE_BLOCKED');
    // ① 明细逐字随附（resolveError 把 gateDetails 归一到 details 一个键）
    expect(body.details).toEqual(gateDetails);
    expect(Array.isArray(body.details.orders)).toBe(true);
    // ② 键名不保留 —— 这条输出喂给已上线的 extractGateBlock 会被拒（面板读不到明细）
    expect(body).not.toHaveProperty('gateDetails');
    // 4xx 业务错误仍只记 warn（严重度判级见下面业务码 5xx 用例）
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  /**
   * I2：日志级别按**严重度**判，不按码名判。
   * 业务码自带 statusCode:500（risk 试点的 OVERVIEW_FAILED 就是这一类）也是服务端故障：
   * 必须落 error 级 + stack，否则漏告警。
   * 设计边界（有意，不是疏漏）：业务错误按契约透传自己的 message，
   * 所以业务码的 500 **同样不会**被换成内部文本 —— 不外泄内部原文是产出方的责任（Task 4 核定）。
   */
  it('业务码 + statusCode:500 → 按严重度落 logger.error（带 stack），文案仍是自己的业务话术', () => {
    const err = Object.assign(new Error('风险概览加载失败，请稍后重试。'), {
      code: 'OVERVIEW_FAILED', statusCode: 500,
    });
    const { res, calls } = fakeRes();
    run(err, res);
    expect(calls[0].status).toBe(500);
    expect(calls[0].body).toMatchObject({ error: 'OVERVIEW_FAILED', message: '风险概览加载失败，请稍后重试。' });
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = loggerMock.error.mock.calls[0] as [string, any];
    expect(msg).toContain('unhandled route error');
    expect(meta.code).toBe('OVERVIEW_FAILED');
    expect(meta.stack).toBe(err.stack);
    expect(typeof meta.stack).toBe('string');
  });

  /**
   * I3：P2025 的两条硬约束都要钉住 ——
   * ① 文案是注册表那句「目标记录不存在或已被删除。」（不是任何 Prisma 原文）；
   * ② 它必须先经 `resolveError` 走 logger.error **带 stack**，再映射 404。
   * ②就是判序的机器证据：把下面的 P2025 分支提到 resolveError 之前，本用例会红。
   */
  it('Prisma P2025 → 404 + 既有口径文案，且映射前已按未预期错误记 error（含 stack）', () => {
    const err = Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
    const { res, calls } = fakeRes();
    run(err, res);
    expect(calls[0].status).toBe(404);
    const body = calls[0].body as any;
    expect(body.error).toBe('NOT_FOUND');
    expect(body.message).toBe('目标记录不存在或已被删除。');
    expect(JSON.stringify(body)).not.toContain('Record to update not found');
    // 判序证据：P2025 先落 error 级日志（含 stack），随后才映射 404
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = loggerMock.error.mock.calls[0] as [string, any];
    expect(msg).toContain('unhandled route error');
    expect(meta.stack).toBe(err.stack);
    expect(typeof meta.stack).toBe('string');
  });

  /** M5：body-parser 分支的完整契约（状态 / 码 / 原文透传 / 不把错误交回 Express） */
  it('body-parser 类 4xx + expose → 透传状态与原文（既有口径不回退）', () => {
    const { res, calls } = fakeRes();
    const next = run(Object.assign(new Error('entity.parse.failed'), { status: 400, expose: true }), res);
    expect(calls[0].status).toBe(400);
    const body = calls[0].body as any;
    expect(body).toMatchObject({ ok: false, error: 'BAD_REQUEST', message: 'entity.parse.failed' });
    // 本分支自己写响应：绝不同时 next(err)（否则 Express 默认错误页会再写一遍）
    expect(next).not.toHaveBeenCalled();
  });

  /**
   * M5 反向证据：Task 3 新加的排除式 `!(code:string && statusCode:number)` 真的在挡什么 ——
   * 一个「恰好带 status/expose」（如从 http-errors 派生）的**真业务错误**必须走业务透传分支、
   * 保住自己的 code，而不是被兜成 BAD_REQUEST。
   */
  it('带 status+expose 的业务错误 → 走业务分支保住自己的 code，不被吞成 BAD_REQUEST', () => {
    const { res, calls } = fakeRes();
    run(Object.assign(new Error('该币种不能用于本单'), {
      status: 400, expose: true, code: 'CURRENCY_MISMATCH', statusCode: 400,
    }), res);
    const body = calls[0].body as any;
    expect(body.error).toBe('CURRENCY_MISMATCH');
    expect(body.error).not.toBe('BAD_REQUEST');
    expect(body.message).toBe('该币种不能用于本单');
    expect(calls[0].status).toBe(400);
  });

  it('headers 已发出 → 交回 Express，不重复写响应', () => {
    const next = vi.fn();
    const res: any = { headersSent: true, status: vi.fn(), json: vi.fn() };
    (globalErrorHandler as ErrorRequestHandler)(new Error('x'), {} as any, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });
});
