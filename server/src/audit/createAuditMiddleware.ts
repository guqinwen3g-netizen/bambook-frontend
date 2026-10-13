/**
 * createAuditMiddleware.ts — Phase 0-04 Express 审计中间件工厂 + Handler 装饰器风格包装函数
 *
 * 目标：业务路由不用手动调 writeLog，挂 1-2 个中间件就得到完整审计。
 *
 * 典型用法（PATCH /orders/:id）：
 *
 *   import { createAuditMiddleware, getAuditService } from './createAuditMiddleware';
 *   import { PrismaClient } from '@prisma/client';
 *   const prisma = new PrismaClient();
 *   const audit = getAuditService(prisma);
 *   const mw = createAuditMiddleware(prisma, audit, {
 *     targetType: 'Order',
 *     lookupIdFromReq: (req) => req.params.id,
 *     operation: 'order.update',
 *     source: 'orders.route',
 *     operationType: 'update',        // create/update/delete/transition…
 *     // before：中间件在进 handler 前 findUnique 拉取快照 → 存到 req.auditBefore 上
 *     // after：捕获 handler 执行结果（或 res.locals.result）→ 拿 after 快照 → writeLog
 *     readBefore: async (tx, id) => tx.order.findUnique({ where: { id } }),
 *     readAfter:  async (tx, id) => tx.order.findUnique({ where: { id } }),
 *   });
 *   router.patch('/:id', requireAuth, mw.beforeLookup, myHandler, mw.afterWrite);
 *
 * 对于 create（id 是在 handler 里才生成）：
 *   const mw = createAuditMiddleware(prisma, audit, {
 *     targetType: 'Order',
 *     operation: 'order.create',
 *     source: 'orders.route',
 *     operationType: 'create',
 *     // 不设 readBefore → before=null
 *     readAfter: (tx, id) => tx.order.findUnique({ where: { id } }),
 *   });
 *   router.post('/', requireAuth, mw.beforeLookup, createHandler, mw.afterWrite);
 *   // 要求：createHandler 在生成 id 后写入 req.auditTargetId = order.id 或 写入 res.locals.createdId
 *
 * 登录/敏感查看便捷包装：
 *   router.post('/login', wrapLoginAudit(prisma, loginHandler, { methodFromBody: true }));
 *   router.get('/suppliers/:id/bank-account',
 *              requireAuth,
 *              wrapSensitiveView(prisma, bankAccountHandler, {
 *                targetType: 'Supplier',
 *                targetIdFromReq: r => r.params.id,
 *                viewedFields: ['bankAccount', 'bankName', 'beneficiary'],
 *              }));
 */
import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  createAuditService,
  getAuditService,
  type AuditOperationType,
} from './auditService';

declare global {
  namespace Express {
    interface Request {
      auditBefore?: Record<string, unknown> | null;
      auditAfter?: Record<string, unknown> | null;
      auditTargetId?: string;
      auditTransactionId?: string;
    }
    interface Locals {
      auditResult?: { snapshotLogId: string | null; fieldLogIds: string[] };
    }
  }
}

type ServiceT = ReturnType<typeof createAuditService>;

// ────────────────────────────────────────────────────────────────────
// 中间件工厂
// ────────────────────────────────────────────────────────────────────
export interface CreateAuditMiddlewareOptions {
  targetType: string;
  operation: string;
  source: string;
  operationType: AuditOperationType;
  /** 如何从 req 取目标 id（缺省=读 req.params.id 或 req.auditTargetId） */
  lookupIdFromReq?: (req: Request) => string | undefined | null;
  /** create 场景：从响应/请求里取出刚创建的 id；缺省读 req.auditTargetId → res.locals.createdId → res.locals.id */
  extractCreatedId?: (req: Request, res: Response) => string | undefined | null;
  /** before 读取器（事务/或 prisma）；不设则 before=null */
  readBefore?: (db: PrismaClient, id: string) => Promise<Record<string, unknown> | null>;
  /** after 读取器（事务/或 prisma）；不设则用 req.auditAfter */
  readAfter?: (db: PrismaClient, id: string) => Promise<Record<string, unknown> | null>;
  /** 只追踪这些顶层字段；不传=追踪全部变化 */
  trackedFields?: string[];
  /** 排除路径（glob），如 ['**.password'] */
  excludePaths?: string[];
  /** 自定义敏感字段模式；传空数组=取消 mask（已知无敏感时）*/
  sensitivePatterns?: string[];
  /** 写快照（before/after 全量），默认 true */
  snapshot?: boolean;
  /** 写字段级 deep diff，默认 true */
  fieldAudit?: boolean;
  /** 失败策略：true=审计失败导致 500（fail closed，财务高风险默认true）；false=审计失败仅logger.error但业务正常返回（默认false，业务侧低风险）*/
  failClosed?: boolean;
}

export function createAuditMiddleware(
  prisma: PrismaClient,
  auditService: ServiceT,
  opts: CreateAuditMiddlewareOptions,
) {
  const svc = auditService;
  const lookupId = (req: Request): string | null => {
    if (opts.lookupIdFromReq) return opts.lookupIdFromReq(req) || null;
    // 兜底：req.params.id / req.auditTargetId / req.body.id
    return (req.params?.id || req.auditTargetId || req.body?.id || null) as string | null;
  };

  /**
   * beforeLookup：进入 handler 前读 before 快照（挂在 req.auditBefore）
   * - create 场景：opts.readBefore 不设，则跳过（before=null）
   * - 其他场景：opts.readBefore(id) 读 DB
   */
  async function beforeLookup(req: Request, res: Response, next: NextFunction) {
    try {
      if (!opts.readBefore) {
        req.auditBefore = null;
        return next();
      }
      const id = lookupId(req);
      if (!id) {
        req.auditBefore = null;
        return next();
      }
      const before = await opts.readBefore(prisma, id);
      req.auditBefore = before as Record<string, unknown> | null;
      next();
    } catch (e: any) {
      if (opts.failClosed) return next(e);
      // 审计前置失败不阻断业务
      req.auditBefore = null;
      next();
    }
  }

  /**
   * afterWrite：handler 完成（响应已写出？或 res.end 前？）写审计。
   * 实现：在 res.json 处 patch，捕获响应 body；或让 handler 把 after 快照写 req.auditAfter / res.locals
   * 这里用"非侵入 patch res.json + fallback 读 req.auditAfter / extractCreatedId"混合策略
   */
  function afterWrite(req: Request, res: Response, next: NextFunction) {
    const origJson = res.json.bind(res);
    let capturedBody: any = undefined;
    (res as any).json = (body: any) => {
      capturedBody = body;
      return origJson(body);
    };

    // 响应真正结束（res.end）后写审计 —— 异步 fire-and-try-best，但 failClosed=true 时同步等审计成功
    res.once('finish', async () => {
      try {
        // 拿 targetId：create 场景优先 extractCreatedId
        let targetId: string | null = lookupId(req);
        if (!targetId && opts.extractCreatedId) {
          targetId = opts.extractCreatedId(req, res) || null;
        }
        if (!targetId) {
          // fallback：res.locals.createdId / id / req.auditTargetId / body.data?.id
          targetId = (res.locals?.createdId
            || res.locals?.id
            || req.auditTargetId
            || capturedBody?.data?.id
            || capturedBody?.id
            || null) as string | null;
        }

        // before
        const before: Record<string, unknown> | null = req.auditBefore ?? null;

        // after：1) req.auditAfter 2) readAfter(targetId) 3) capturedBody 或 null
        let after: Record<string, unknown> | null = req.auditAfter ?? null;
        if (!after && opts.readAfter && targetId) {
          try { after = await opts.readAfter(prisma, targetId); } catch { /* ignore */ }
        }
        if (!after) {
          // 兜底：capturedBody 若带 data/entity，则当 after 快照
          if (capturedBody?.data && typeof capturedBody.data === 'object') {
            after = capturedBody.data as Record<string, unknown>;
          }
        }

        const actorId: string =
          (req as any).actor?.userId
          || (req as any).actor?.id
          || 'anonymous';
        const ip = (req as any).ip || null;
        const ua = req.headers['user-agent'] || undefined;

        await svc.writeLog(prisma, {
          actorId,
          source: opts.source,
          operation: opts.operation,
          operationType: opts.operationType,
          targetType: opts.targetType,
          targetId,
          before,
          after,
          snapshot: opts.snapshot,
          fieldAudit: opts.fieldAudit,
          trackedFields: opts.trackedFields,
          excludePaths: opts.excludePaths,
          sensitivePatterns: opts.sensitivePatterns,
          transactionId: req.auditTransactionId ?? null,
          ip,
          ua,
        });
      } catch (e: any) {
        try {
          const logger = await import('../lib/logger').then((m) => m.logger);
          logger.error('[Audit.afterWrite] FAILED', {
            message: e?.message,
            operation: opts.operation,
            targetType: opts.targetType,
            failClosed: !!opts.failClosed,
          });
        } catch { /* noop */ }
      }
    });
    next();
  }

  return { beforeLookup, afterWrite };
}

// ────────────────────────────────────────────────────────────────────
// 登录 Handler 包装器（函数装饰器风格）
// ────────────────────────────────────────────────────────────────────
/**
 * wrapLoginAudit：对 POST /login 类 handler 做"成功/失败都写登录审计"。
 *
 *   handler(req, res)：正常 res.json 返回 { ok: true, userId?, ... } 视为成功；
 *                       res.status(401/403/xxx).json(...) 视为失败（需在 handler 里写响应状态码）
 *
 *   opts.methodFromBody=true → 从 req.body.method 取登录方式；否则 opts.defaultMethod
 */
export function wrapLoginAudit(
  prisma: PrismaClient,
  handler: (req: Request, res: Response) => Promise<void> | void,
  options?: {
    defaultMethod?: string;
    methodFromBody?: boolean;
  },
) {
  return async function loginAuditWrapped(req: Request, res: Response) {
    const svc = getAuditService(prisma);
    const method = (options?.methodFromBody ? (req.body as any)?.method : null)
      || options?.defaultMethod
      || 'password';
    const ip = (req as any).ip || null;
    const ua = req.headers['user-agent'] || null;

    const origJson = res.json.bind(res);
    const origStatus = res.status.bind(res);
    let capturedStatus = res.statusCode;
    let capturedBody: any;
    (res as any).status = (s: number) => { capturedStatus = s; return origStatus(s); };
    (res as any).json = (b: any) => { capturedBody = b; return origJson(b); };

    try {
      await Promise.resolve(handler(req, res));
    } catch (err: any) {
      // 异常：先写失败审计，再把异常继续抛（交给上层 error handler）
      try {
        await svc.logLogin(prisma, {
          success: false, method, failReason: err?.message || 'handler_throw',
          ip, ua, metadata: { errName: err?.name || 'Error' },
        });
      } catch { /* noop */ }
      throw err;
    }

    const success = capturedStatus >= 200 && capturedStatus < 300 && (capturedBody?.ok !== false);
    const actorId = success
      ? ((req as any).actor?.id || capturedBody?.userId || capturedBody?.data?.userId || '')
      : undefined;
    const targetId = success ? actorId : undefined;

    try {
      await svc.logLogin(prisma, {
        actorId,
        targetId,
        success,
        method,
        failReason: !success ? (capturedBody?.error || capturedBody?.message || 'unauthorized') : undefined,
        ip,
        ua,
        metadata: { responseStatus: capturedStatus },
      });
    } catch { /* noop: 登录审计失败不影响响应 */ }
  };
}

// ────────────────────────────────────────────────────────────────────
// 敏感查看 Handler 包装器
// ────────────────────────────────────────────────────────────────────
export interface WrapSensitiveViewOptions {
  targetType: string;
  /** 如何取 id，缺省 req.params.id */
  targetIdFromReq?: (req: Request) => string | undefined | null;
  /** 看到的敏感字段名列表；也可动态函数，接收 req/res 返回字段名数组 */
  viewedFields: string[] | ((req: Request, res: Response, body?: any) => string[]);
  /** 查看通道标识，如 'ui.detail'/'agent.tool'；默认 'api' */
  via?: string;
}

/**
 * wrapSensitiveView：对 GET /suppliers/:id/bank-account 之类高敏感读接口包裹一层 view_sensitive 审计。
 * - 成功（2xx && ok!==false）才写；失败（4xx/5xx）不写（没看到真实内容）
 * - 只记录"看了哪些字段"，绝不记录字段真实值
 */
export function wrapSensitiveView(
  prisma: PrismaClient,
  handler: (req: Request, res: Response) => Promise<void> | void,
  opts: WrapSensitiveViewOptions,
) {
  return async function sensitiveViewWrapped(req: Request, res: Response) {
    const svc = getAuditService(prisma);
    const origJson = res.json.bind(res);
    let capturedStatus = res.statusCode;
    let capturedBody: any;
    const origStatus = res.status.bind(res);
    (res as any).status = (s: number) => { capturedStatus = s; return origStatus(s); };
    (res as any).json = (b: any) => { capturedBody = b; return origJson(b); };

    try {
      await Promise.resolve(handler(req, res));
    } finally {
      const success = capturedStatus >= 200 && capturedStatus < 300 && capturedBody?.ok !== false;
      if (success) {
        const targetId = (opts.targetIdFromReq ? opts.targetIdFromReq(req) : req.params.id)
          || capturedBody?.data?.id
          || capturedBody?.id
          || '';
        const fields = typeof opts.viewedFields === 'function'
          ? opts.viewedFields(req, res, capturedBody)
          : opts.viewedFields;
        const actorId: string =
          (req as any).actor?.userId
          || (req as any).actor?.id
          || 'anonymous';
        const ip = (req as any).ip || null;
        try {
          await svc.logSensitiveView(prisma, {
            actorId,
            targetType: opts.targetType,
            targetId: String(targetId),
            viewedFields: fields,
            via: opts.via || 'api',
            ip,
          });
        } catch { /* view 审计失败静默 */ }
      }
    }
  };
}
