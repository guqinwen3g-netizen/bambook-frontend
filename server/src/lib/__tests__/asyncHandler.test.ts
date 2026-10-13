/**
 * Express 4 全局异步错误兜底三件套测试：
 *   1. asyncHandler — handler resolve 正常响应 / reject → next(err) 进错误管道
 *   2. globalErrorHandler — body-parser 4xx 透传 / P2025 404 / 其余 500 不外泄细节 / headersSent 回退
 *   3. registerUnhandledRejectionGuard — 漏网 rejection 记日志不打崩进程，dispose 可卸载
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { asyncHandler, globalErrorHandler, registerUnhandledRejectionGuard } from '../asyncHandler';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeApp(handler: (req: Request, res: Response) => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  app.post('/boom', asyncHandler(handler));
  app.use(globalErrorHandler);
  return app;
}

describe('asyncHandler · async 路由包装', () => {
  it('handler resolve → 正常响应，不进错误管道', async () => {
    const app = makeApp(async (_req, res) => res.json({ ok: true }));
    const res = await request(app).post('/boom').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('handler reject → next(err)（不直接响应，交给 4 参错误中间件）', async () => {
    const app = makeApp(async () => {
      throw new Error('boom-inside-handler');
    });
    const res = await request(app).post('/boom').send({});
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
  });
});

describe('globalErrorHandler · 4 参错误中间件', () => {
  it('Prisma P2025 → 404 NOT_FOUND（与 admin 域 withRouteErrorGuard 同口径）', async () => {
    const app = makeApp(async () => {
      throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
    });
    const res = await request(app).post('/boom').send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  it('非 P2025 异常 → 500 INTERNAL_ERROR，内部明细只进日志不外泄', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const app = makeApp(async () => {
      throw new Error('secret-internal-detail');
    });
    const res = await request(app).post('/boom').send({});
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-detail');
    // 日志携带 method / path / error 明细，便于定位漏网点
    const [, meta] = errorSpy.mock.calls[0] as [string, any];
    expect(meta).toMatchObject({ method: 'POST', path: '/boom', error: 'secret-internal-detail' });
  });

  it('body-parser JSON 解析失败 → 400 BAD_REQUEST（status 4xx + expose 透传）', async () => {
    const app = makeApp(async (_req, res) => res.json({ ok: true }));
    const res = await request(app)
      .post('/boom')
      .set('Content-Type', 'application/json')
      .send('{invalid json');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'BAD_REQUEST' });
  });

  it('headers 已发出 → next(err) 交回 Express 默认管道（不再尝试写响应）', () => {
    const statusSpy = vi.fn();
    const next = vi.fn();
    const res = {
      headersSent: true,
      status: statusSpy,
      json: vi.fn(),
    } as unknown as Response;
    const req = { method: 'GET', originalUrl: '/stream' } as Request;
    const err = new Error('stream-broke-midway');

    (globalErrorHandler as any)(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(statusSpy).not.toHaveBeenCalled();
  });
});

describe('registerUnhandledRejectionGuard · 进程级兜底', () => {
  it('unhandledRejection → logger.error 记录 reason（进程存活），dispose 后卸载', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const onSpy = vi.spyOn(process, 'on');
    const offSpy = vi.spyOn(process, 'off');
    const listenerCountBefore = process.listenerCount('unhandledRejection');

    const dispose = registerUnhandledRejectionGuard();
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(process.listenerCount('unhandledRejection')).toBe(listenerCountBefore + 1);

    const listener = onSpy.mock.calls
      .map(call => call[0] === 'unhandledRejection' ? call[1] : null)
      .find(Boolean) as (reason: unknown) => void;

    // Error reason：message + stack 落日志
    listener(new Error('boom-reason'));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0] as [string, any];
    expect(String(message)).toContain('unhandledRejection');
    expect(meta.reason).toBe('boom-reason');
    expect(typeof meta.stack).toBe('string');

    // 非 Error reason（字符串）：原样记录不炸
    listener('plain-string-reason');
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect((errorSpy.mock.calls[1] as [string, any])[1].reason).toBe('plain-string-reason');

    // dispose 卸载：off 收到同一 listener，监听计数回落（后续 rejection 不再进本兜底）
    dispose();
    expect(offSpy).toHaveBeenCalledWith('unhandledRejection', listener);
    expect(process.listenerCount('unhandledRejection')).toBe(listenerCountBefore);
  });
});
