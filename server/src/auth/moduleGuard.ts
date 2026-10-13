import { Request, Response, NextFunction } from 'express';
import { getDefaultAgentApiKeyActors } from './agentPrincipal';
import { extractActorFromRequest } from './middleware';
import type { TokenPayload } from './service';

export interface ModuleAuthGuardOptions {
  requireAuth: boolean;
  apiKeys: Set<string>;
  /**
   * Optional strict principal mapping: when provided, an API key alone is a transport
   * credential, not an identity — it must be bound to an explicit service principal
   * (TokenPayload) or the request is rejected with AGENT_PRINCIPAL_REQUIRED.
   * Use for Agent execution surfaces (e.g. ai module) where least-privilege identity
   * is required. When omitted, any valid API key is accepted (legacy module behavior).
   */
  apiKeyActors?: ReadonlyMap<string, TokenPayload>;
  /**
   * Optional development actor factory: when requireAuth=false, called to build an
   * explicit development principal instead of a bare pass-through. Used by Agent
   * execution surfaces so the identity service never invents owner access implicitly.
   * When omitted and requireAuth=false, the request passes through with any
   * extractable actor attached (legacy behavior).
   */
  devActorFactory?: (req: Request) => TokenPayload;
}

/**
 * Shared module-level auth guard: JWT cookie/Bearer OR API-key header.
 * When requireAuth=false (dev mode), bypasses both checks (or builds a dev actor
 * via devActorFactory when provided).
 * Sets req.actor for downstream audit logging.
 */
export function createModuleAuthGuard(opts: ModuleAuthGuardOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!opts.requireAuth) {
      // Even in dev mode, a real JWT principal always wins over a synthesized dev actor
      // (prevents spoofed body roles from overriding an authenticated session).
      const actor = extractActorFromRequest(req);
      if (actor) {
        (req as any).actor = actor;
        (req as any).authSource = 'user-session';
        return next();
      }
      if (opts.devActorFactory) {
        (req as any).actor = opts.devActorFactory(req);
        (req as any).authSource = 'dev';
        return next();
      }
      // 无 actor 也要打上 dev 标记：否则下游 requirePermission 会因拿不到 actor 返回 401，
      // 出现「dev 模式 guard 放行、scope 守卫却拒绝」的自相矛盾（且写操作走
      // requireJwtForWrite 在 dev 是放行的，读反而更严）。dev 即不鉴权，全链路一致。
      (req as any).authSource = 'dev';
      return next();
    }

    // Priority 1: JWT (cookie or Bearer)
    const actor = extractActorFromRequest(req);
    if (actor) {
      (req as any).actor = actor;
      (req as any).authSource = 'user-session';
      return next();
    }

    // Priority 2: API key (accept both canonical and legacy header names)
    const apiKey = (req.headers['x-bambook-api-key'] || req.headers['x-api-key'] || req.query.apiKey) as string | undefined;
    if (!apiKey) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login (JWT) or X-Bambook-API-Key required.' });
    }
    if (!opts.apiKeys.has(apiKey)) {
      // 与旧模块手写 authenticate 对齐：无效凭证统一 401（未认证），403 留给已认证但越权场景
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid API key.' });
    }

    // §10.4.1：API Key 只是**凭据**，不是身份——AI 与员工一样要有自己的账号。
    // 主体映射取「路由显式入参」优先，缺省回退进程级默认（agentPrincipal），
    // 这样 25+ 个未改造签名的模块路由也能自动获得主体能力。
    // 未装载任何主体（size=0）时保持旧语义：放行但无 actor——下游 scope 门会因无主体
    // 返回 401，与 products/emails 既有口径一致（W-C 起就是这么约定的）。
    // - 路由**显式**传了 apiKeyActors（哪怕是空 Map）→ 严格模式：解析不出主体即 403
    //   （Phase 1 守卫统一：ai / agent 等路由靠这条拒绝「key 即身份」）。
    // - 未显式传 → 回退进程级默认；默认未装载（size=0）时保持旧语义：放行但无 actor，
    //   下游 scope 门会因无主体返回 401，与 products/emails 既有口径一致。
    const strictActors = opts.apiKeyActors;
    const fallbackActors = strictActors ?? getDefaultAgentApiKeyActors();
    const useStrict = Boolean(strictActors) || (fallbackActors?.size ?? 0) > 0;
    if (useStrict) {
      const apiKeyActor = fallbackActors?.get(apiKey);
      if (!apiKeyActor) {
        return res.status(403).json({
          error: 'AGENT_PRINCIPAL_REQUIRED',
          message: 'This API key is not mapped to an Agent service principal.',
        });
      }
      // The composition-root loader may already have refreshed this bound key's
      // current grants. Preserve it only for the same configured subject/source.
      const hydrated = (req as any).actor as TokenPayload | undefined;
      (req as any).actor = (req as any).authSource === 'api-key'
        && hydrated?.authorizationLoaded === true && hydrated.userId === apiKeyActor.userId
        ? hydrated : apiKeyActor;
      (req as any).authSource = 'api-key';
      return next();
    }

    next();
  };
}

/**
 * Write-method-only guard: JWT requireAuth for POST/PATCH/PUT/DELETE.
 * API-key alone is insufficient for write operations.
 * Use as: router.post('/', requireAuthForWrites(opts), handler)
 */
export function requireJwtForWrite(opts: ModuleAuthGuardOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!opts.requireAuth) return next();

    const actor = extractActorFromRequest(req);
    if (actor) {
      (req as any).actor = actor;
      return next();
    }

    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Write operations require JWT login (API key insufficient).' });
  };
}
