/**
 * Phase 1 · 任务 1.2 — 请求耗时 / 慢查询日志中间件测试
 *
 * 覆盖：
 *   1. 5xx 响应 → logger.error
 *   2. 超过慢阈值 → logger.warn
 *   3. 正常快请求 → logger.debug（不 warn）
 *   4. SSE 流式响应 → 不触发慢请求 warn（长连接天然耗时）
 *   5. 日志不携带 query string（防 apiKey 泄漏）
 *   6. Prisma 慢查询事件 → 超过阈值 warn，未超过静默
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { logger } from '../logger';
import {
  attachPrismaSlowQueryLogger,
  createRequestTimingMiddleware,
  PrismaQueryEventSource,
} from '../requestTiming';

afterEach(() => {
  vi.restoreAllMocks();
});

function mountApp(handler: (req: any, res: any) => void, slowRequestMs = 50) {
  const app = express();
  app.use(createRequestTimingMiddleware({ slowRequestMs }));
  app.all('/test', handler);
  return app;
}

describe('requestTiming · HTTP 请求耗时日志', () => {
  it('5xx 响应 → logger.error，携带 method/path/status/durationMs', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const app = mountApp((_req, res) => res.status(500).json({ error: 'boom' }));
    await request(app).get('/test');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0] as [string, any];
    expect(message).toContain('GET');
    expect(message).toContain('/test');
    expect(message).toContain('500');
    expect(meta).toMatchObject({ method: 'GET', path: '/test', status: 500 });
    expect(typeof meta.durationMs).toBe('number');
  });

  it('超过慢阈值 → logger.warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const app = mountApp((_req, res) => setTimeout(() => res.json({ ok: true }), 80), 20);
    await request(app).get('/test');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('slow request');
  });

  it('正常快请求 → logger.debug，不触发 warn/error', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const app = mountApp((_req, res) => res.json({ ok: true }));
    await request(app).get('/test');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('SSE 流式响应即使耗时也不触发慢请求 warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const app = mountApp((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      setTimeout(() => {
        res.write('data: {}\n\n');
        res.end();
      }, 80);
    }, 20);
    await request(app).get('/test').buffer(false).parse((res, cb) => {
      res.on('data', () => undefined);
      res.on('end', () => cb(null, null));
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('日志不携带 query string（防 apiKey 泄漏）', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const app = mountApp((_req, res) => res.json({ ok: true }));
    await request(app).get('/test?apiKey=secret-value&foo=bar');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = debugSpy.mock.calls[0] as [string, any];
    expect(message).not.toContain('secret-value');
    expect(meta.path).toBe('/test');
    expect(JSON.stringify(meta)).not.toContain('secret-value');
  });
});

describe('requestTiming · Prisma 慢查询日志', () => {
  function makeFakePrisma() {
    const listeners: Array<(e: { duration: number; query: string; params?: string }) => void> = [];
    const source: PrismaQueryEventSource = {
      $on: (_event, cb) => { listeners.push(cb); },
    };
    return { source, emit: (e: { duration: number; query: string }) => listeners.forEach(cb => cb(e)) };
  }

  it('超过阈值 → logger.warn 且截断超长 SQL', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { source, emit } = makeFakePrisma();
    attachPrismaSlowQueryLogger(source, { slowQueryMs: 100 });
    emit({ duration: 250, query: `SELECT ${'x'.repeat(1000)}` });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = warnSpy.mock.calls[0] as [string, any];
    expect(message).toContain('250ms');
    expect(meta.durationMs).toBe(250);
    expect(meta.query.length).toBeLessThanOrEqual(500);
  });

  it('未超过阈值 → 静默', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { source, emit } = makeFakePrisma();
    attachPrismaSlowQueryLogger(source, { slowQueryMs: 100 });
    emit({ duration: 99, query: 'SELECT 1' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
