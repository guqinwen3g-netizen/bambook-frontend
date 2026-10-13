/**
 * 可观测性 · 请求耗时 / 慢查询日志（Phase 1 · 任务 1.2）
 *
 * 两个能力：
 *   1. createRequestTimingMiddleware — Express 中间件，res.finish 时记录耗时：
 *        - 5xx           → error
 *        - 超过慢阈值     → warn（SSE 流式响应除外，长连接天然耗时）
 *        - 其余           → debug（避免日志噪声）
 *      日志只记录 req.path（不含 query），避免泄漏 apiKey 等敏感参数。
 *   2. attachPrismaSlowQueryLogger — 订阅 Prisma query 事件，超过阈值 warn。
 *      需要 PrismaClient 以 log: [{ emit: 'event', level: 'query' }] 实例化。
 *
 * 阈值可通过环境变量覆盖：
 *   BAMBOOK_SLOW_REQUEST_MS（默认 1000）
 *   BAMBOOK_SLOW_QUERY_MS（默认 300）
 */
import { NextFunction, Request, Response } from 'express';
import { logger } from './logger';

const DEFAULT_SLOW_REQUEST_MS = 1000;
const DEFAULT_SLOW_QUERY_MS = 300;

export interface RequestTimingOptions {
    slowRequestMs?: number;
    /** 组件名，写入日志 component 字段 */
    component?: string;
}

export function resolveSlowRequestMs(value?: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const fromEnv = Number(process.env.BAMBOOK_SLOW_REQUEST_MS);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SLOW_REQUEST_MS;
}

export function resolveSlowQueryMs(value?: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const fromEnv = Number(process.env.BAMBOOK_SLOW_QUERY_MS);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SLOW_QUERY_MS;
}

function isSseResponse(res: Response): boolean {
    const contentType = res.getHeader('content-type');
    return typeof contentType === 'string' && contentType.includes('text/event-stream');
}

export function createRequestTimingMiddleware(options: RequestTimingOptions = {}) {
    const slowRequestMs = resolveSlowRequestMs(options.slowRequestMs);
    const component = options.component || 'HTTP';

    return (req: Request, res: Response, next: NextFunction) => {
        const startedAt = process.hrtime.bigint();
        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const meta = {
                component,
                method: req.method,
                path: req.path, // 不含 query，避免泄漏 apiKey
                status: res.statusCode,
                durationMs: Math.round(durationMs * 10) / 10,
            };
            if (res.statusCode >= 500) {
                logger.error(`[http] ${req.method} ${req.path} ${res.statusCode} ${meta.durationMs}ms`, meta);
            } else if (!isSseResponse(res) && durationMs >= slowRequestMs) {
                logger.warn(`[http] slow request ${req.method} ${req.path} ${res.statusCode} ${meta.durationMs}ms`, meta);
            } else {
                logger.debug(`[http] ${req.method} ${req.path} ${res.statusCode} ${meta.durationMs}ms`, meta);
            }
        });
        next();
    };
}

/** PrismaClient 上 $on 的最小结构（便于测试注入 mock） */
export interface PrismaQueryEventSource {
    $on(event: 'query', callback: (event: { duration: number; query: string; params?: string }) => void): void;
}

export function attachPrismaSlowQueryLogger(
    prisma: PrismaQueryEventSource,
    options: { slowQueryMs?: number } = {},
): void {
    const slowQueryMs = resolveSlowQueryMs(options.slowQueryMs);
    prisma.$on('query', (event) => {
        if (event.duration < slowQueryMs) return;
        logger.warn(`[prisma] slow query ${event.duration}ms`, {
            component: 'PRISMA',
            durationMs: event.duration,
            query: String(event.query || '').slice(0, 500),
            params: String(event.params || '').slice(0, 200),
        });
    });
}
