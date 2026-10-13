import { Request, Response, NextFunction } from 'express';
import { createAuthService, TokenPayload } from './service';
import { AgentRole } from '../agent/types';

type AuthMiddlewareOptions = {
  jwtSecret?: string;
};

const auth = createAuthService();

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const payload = extractActorFromRequest(req);
  if (!payload) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required.' });
  }
  (req as any).actor = payload;
  next();
}

export function requireRole(...roles: AgentRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const payload = extractActorFromRequest(req);
    if (!payload) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required.' });
    }
    // roles 兜底：即便上游漏了类型校验，也不能让 undefined.some 崩成 500，
    // 一律按「无角色」处理 → 403（与既有语义一致）。
    const hasRole = (payload.roles ?? []).some((role: string) => roles.includes(role as AgentRole));
    if (!hasRole) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Insufficient role.' });
    }
    (req as any).actor = payload;
    next();
  };
}

export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const payload = extractActorFromRequest(req);
  if (payload) {
    (req as any).actor = payload;
  }
  next();
}

export function extractActorFromRequest(req: Request): TokenPayload | null {
  // 取凭证只认一份规则（见本文件末尾的 pickRequestToken）：显式 Bearer 优先于被动 cookie——
  // 并存时若 cookie 抢先，显式指定的身份会被静默忽略（如切换账号后旧 cookie 劫持请求）。
  const token = pickRequestToken(req);
  if (!token) return null;

  let payload: TokenPayload;
  try {
    payload = auth.verifyToken(token);
  } catch {
    return null;
  }

  // ── 内部守卫只认内部用户 token（token 类型校验，fail-closed）─────────────
  // 客户门户 token 与内部 token **共用同一 JWT_SECRET**（见 customer/authService.ts），
  // 而客户侧 payload 只有 kind/customerUserId/relationId，没有 userId/roles/permissions。
  // 若此处只验签不验类型，客户 token 会被当成合法 actor 放行，实测后果：
  //   · requireAuth 型路由      → 200（userId 为 undefined，下游按空身份处理）
  //   · requireRole 型路由      → 500（payload.roles.some 崩在 undefined 上）
  // 客户侧 verifyToken 已校验 kind==='customer'，这里补上对称校验。
  if (!payload || typeof payload.userId !== 'string' || !payload.userId) return null;
  if ((payload as any).kind === 'customer') return null;

  // 同一 JWT 主体若已由可信服务端中间件加载当前授权，后续 requireAuth /
  // requireRole / optionalAuth 不得重新用旧 JWT 快照覆盖它。req.actor 是服务端
  // 注入面；绝不读取 body.actor。不同主体仍由显式 Bearer/cookie 规则决定，
  // marker 也不能替代验签或让 API-Key 主体进入仅 JWT 的旧守卫。
  const hydrated = (req as Request & { actor?: TokenPayload }).actor;
  if (hydrated?.authorizationLoaded === true && hydrated.userId === payload.userId
    && (hydrated as TokenPayload & { kind?: string }).kind !== 'customer') {
    return hydrated;
  }

  return payload;
}

/**
 * 全仓唯一的"这次请求是谁"取凭证规则：显式 Bearer 优先，其次被动 cookie，都没有 ⇒ 空串。
 * 走查·利润表前的一手证人抓到的病灶就在这里之外：auth/route.ts 的 GET /me、PATCH /me、
 * change-password 三处曾写作 cookie 优先（与本函数相反）⇒ 同一个会话里"屏面显示的身份"
 * （来自 /me）与"业务路由判决的身份"（来自本函数）可以判给两个人。
 */
export function pickRequestToken(req: { headers?: { authorization?: string }; cookies?: Record<string, string> }): string {
  const authHeader = req.headers?.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const cookie = typeof req.cookies?.bambook_token === 'string' ? req.cookies.bambook_token : '';
  return bearer || cookie;
}
