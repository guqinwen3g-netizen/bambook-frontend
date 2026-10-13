/**
 * accountStatusGuard.ts — REQ2-13 停用即时失效守卫（DR-056-③）
 *
 * 设计真源：docs/design/04-模块设计/02-客户与开拓/业务员离职一键交接.md §2 DR-056-③
 *
 * 既有缺口（根因）：extractActorFromRequest 仅 jwt.verify 验签，不查 UserAccount.status；
 * token TTL 7 天——账号停用后旧 token 在过期前仍持有全部 API 权限，违反 X-07「离职者立即失去访问」。
 *
 * 修复策略（组合根拦截）：
 *   - 挂载于 index.ts（cookieParser 之后、全部业务路由之前）
 *   - 凡携带可验签 JWT 的请求 → 查账号状态（30s TTL 内存缓存，防每请求打库）
 *   - disabled / 软删 → 401 ACCOUNT_DISABLED + 清 cookie
 *   - 缓存即时失效：invalidateAccountStatusCache(userId)（停用/交接路径同进程调用——单节点部署成立）
 *   - fail-open：DB 查询异常 / 用户不存在 → 放行（行为与修复前一致；验签仍有效，遗留 token 兼容）
 */
import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from './middleware';
import { logger } from '../lib/logger';

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 5_000;

type CacheEntry = { blocked: boolean; checkedAt: number };
const statusCache = new Map<string, CacheEntry>();

/** 停用/软删/交接路径调用：同进程缓存即时失效（跨进程由 30s TTL 兜底） */
export function invalidateAccountStatusCache(userId: string): void {
  if (userId) statusCache.delete(userId);
}

async function isAccountBlocked(prisma: PrismaClient, userId: string): Promise<boolean> {
  const now = Date.now();
  const cached = statusCache.get(userId);
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) return cached.blocked;

  let blocked = false;
  try {
    const user = await prisma.userAccount.findUnique({
      where: { id: userId },
      select: { status: true, deletedAt: true },
    });
    // fail-open：用户不存在（遗留 token / 测试造数）→ 放行，交由下游 scope 校验
    blocked = !!user && (user.status === 'disabled' || user.deletedAt != null);
  } catch (e) {
    logger.warn('[accountStatusGuard] status query failed (fail-open)', { error: (e as Error).message });
    return false;
  }

  if (statusCache.size > CACHE_MAX_ENTRIES) statusCache.clear();
  statusCache.set(userId, { blocked, checkedAt: now });
  return blocked;
}

/**
 * Express 中间件工厂：拦截已停用/软删账号的未过期 JWT。
 * 匿名请求与验签失败请求直接放行（由下游 requireAuth/requirePermission 处理）。
 */
export function createAccountStatusGuard(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = extractActorFromRequest(req);
      if (!actor?.userId) return next();
      if (await isAccountBlocked(prisma, actor.userId)) {
        res.clearCookie('bambook_token');
        return res.status(401).json({ error: 'ACCOUNT_DISABLED', message: '账号已被停用，访问已终止。' });
      }
      return next();
    } catch {
      return next(); // fail-open：守卫自身异常不阻断服务
    }
  };
}
