/**
 * Express 4 全局异步错误兜底（共享原语）
 *
 * 根因：Express 4 不会捕获 async handler 的 rejected promise——任何未包装的
 * async 路由一旦 reject，就成为 unhandledRejection（Node 15+ 默认直接打崩进程）。
 * 此前各域各自为政（agent/route.ts 私有 asyncHandler 直接 500、admin/route.ts
 * withRouteErrorGuard 域内兜底），email sync 崩溃链（/sync、/outbox、/replies
 * 三个裸 async 端点）证明需要组合根级兜底三件套：
 *
 *   1. asyncHandler — 包装 async route handler，reject → next(err) 流入 Express 错误管道
 *   2. globalErrorHandler — 4 参错误中间件（组合根在全部路由后挂载一次），统一 400/404/500 契约
 *   3. registerUnhandledRejectionGuard — 进程级兜底（记日志不退出），防漏网 rejection 打崩进程
 *
 * 响应契约与 admin 域 withRouteErrorGuard 对齐：Prisma P2025 → 404 NOT_FOUND；
 * 其余 → 500 INTERNAL_ERROR（明细只进日志，不外泄给客户端）。
 * S0-A Task 3 起：业务错误（自带 code+statusCode）透传，未预期异常走 shared/errorCodes 文案表。
 */
import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import { logger } from './logger';
import { isBusinessError, resolveError } from '../shared/errorCodes';

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * async 路由统一包装：handler reject → next(err)。
 * 不在 wrapper 里直接响应——保持错误流单一管道，由挂在路由链末端的
 * globalErrorHandler 统一记日志并映射响应（测试挂载同款中间件即可复现生产契约）。
 */
export function asyncHandler(handler: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/**
 * Express 4 参错误中间件（组合根在全部路由后挂载一次）：
 *   - headers 已发出（流式响应中途出错）→ next(err) 交回 Express 默认管道断连
 *   - body-parser 类 4xx（JSON 解析失败 entity.parse.failed / 请求体超限等，
 *     特征 err.status 4xx + err.expose=true 可安全外显）→ 透传 status
 *   - 业务错误（自带 code:string + statusCode:number）→ 原样透传码/文案/明细
 *     （明细统一落在 `details` 键；`gateDetails` 原键名不保留 —— 出运域因此**不得**接入本管道，
 *      见 spec §3.3 的迁移前置约束）
 *   - Prisma P2025（记录不存在）→ 404 NOT_FOUND（与 admin 域同口径）
 *   - 其余 → 500 INTERNAL_ERROR + 通用文案（明细进日志，不外泄）
 *
 * 日志级别按严重度：INTERNAL_ERROR **或任何 5xx**（含业务码的 5xx）→ logger.error + stack；
 * 其余业务错误 → logger.warn。判级以**严重度为主判据**（`r.status >= 500`），
 * 并保留 `r.code === 'INTERNAL_ERROR'` 这一支显式兜底：今天两支同结果
 * （INTERNAL_ERROR 不在表里 ⇒ status 恒为 500），留着是让「未预期异常必落 error 级」
 * 不再依赖「表里恰好没登记 INTERNAL_ERROR」这个隐含前提。
 *
 * 判序不可调换：resolveError 在前（未预期错误先拿到全量 stack 日志），P2025 映射在后
 * —— 把 P2025 提到前面会让每一条「记录不存在」跳过 logger.error。
 */
export const globalErrorHandler: ErrorRequestHandler = (err: any, req, res, next) => {
  if (res.headersSent) return next(err);

  // body-parser 类 4xx（JSON 解析失败 / 请求体超限）：err.expose 已表明可安全外显
  // 排除式：真业务错误自带 code+statusCode —— 若它恰好也带了 status/expose（如 http-errors 派生），
  // 不能被这里吞成 BAD_REQUEST，必须走下面的业务透传分支。
  // 判据用 shared/errorCodes 的 `isBusinessError`（Task 4 收口）：本仓「什么算业务错误」
  // 只许有一条规则，这里曾经是抄走的第二份副本 —— 副本会各自漂移（routeError 就是前车之鉴）。
  if (
    typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && err?.expose
    && !isBusinessError(err)
  ) {
    return res.status(err.status).json({ ok: false, error: 'BAD_REQUEST', message: err.message });
  }

  const r = resolveError(err, 'INTERNAL_ERROR');

  // 日志级别以**严重度为主判据**（任何 5xx 都必须落 error 级 + stack，
  // 因为 lib/logger 的 webhook 告警 transport 只吃 error 级 —— 漏判即漏告警），
  // 另加 `INTERNAL_ERROR` 兜底码这一支显式保险（见上面函数注释的判级说明）。
  // 光判 `code === 'INTERNAL_ERROR'` 是不够的：业务码自带 statusCode:500
  // （如 risk 域 OVERVIEW_FAILED / `X_FAILED`）也是服务端故障，会被静默降级成 warn。
  // 有意保留的设计边界：业务错误按契约透传**自己的** message，故业务码的 500
  // 同样不会被换成内部文本 —— 「不外泄内部原文」是产出方的责任（Task 4 核定），
  // 本任务的约束只是这种情形**绝不静默少记一条 error 日志**。
  if (r.code === 'INTERNAL_ERROR' || r.status >= 500) {
    logger.error('[express] unhandled route error', {
      method: req.method,
      path: req.originalUrl,
      error: err?.message || String(err),
      code: err?.code,
      stack: err?.stack,
    });
  } else {
    logger.warn('[express] business error', {
      method: req.method, path: req.originalUrl, code: r.code, message: r.message,
    });
  }

  // Prisma P2025（记录不存在）：resolveError 不认内部码，此处按既有口径显式映射
  if (err?.code === 'P2025') {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: '目标记录不存在或已被删除。' });
  }

  return res.status(r.status).json({
    ok: false,
    error: r.code,
    // 文案真源在 shared/errorCodes：INTERNAL_ERROR 不在 ERROR_CODES 表内，
    // resolveError 已把它解析成 GENERIC_ROUTE_ERROR_MESSAGE，此处不再二次覆写
    // （旧的同名三元是重复真源，唯一实际效果是把有意设好的 INTERNAL_ERROR 文案盖掉）。
    message: r.message,
    ...(r.details === undefined ? {} : { details: r.details }),
  });
};

/**
 * 进程级 unhandledRejection 兜底：只记日志不退出（Node 15+ 默认 throw 崩进程）。
 * 这是最后防线——路由层应优先用 asyncHandler 把 rejection 送进错误管道；
 * 走到这里说明存在未接线的调用点，日志里按 reason 定位补接线。
 * 返回 dispose 函数：测试环境卸载监听，避免跨用例叠加。
 */
export function registerUnhandledRejectionGuard(): () => void {
  const listener = (reason: unknown) => {
    const err = reason instanceof Error ? reason : null;
    logger.error('[process] unhandledRejection (process kept alive)', {
      reason: err?.message || String(reason),
      stack: err?.stack,
    });
  };
  process.on('unhandledRejection', listener);
  return () => process.off('unhandledRejection', listener);
}
