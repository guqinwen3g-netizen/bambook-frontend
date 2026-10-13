/**
 * auth.ts — 客户门户鉴权中间件
 *
 * 与内部 auth/middleware.ts 平行但独立：客户 token 从 Bearer 或 cookie
 * （bambook_customer_token）读取，校验 kind==='customer'，并回查 CustomerUser
 * 表确认账号仍 active 且未软删（30s TTL 不做——客户量大频次低，直查更简单可靠）。
 * 鉴权通过后注入 req.customer：{ customerUserId, relationId, displayName, relationName }。
 */
import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { createCustomerAuthService } from './authService';

export interface RequestCustomer {
  customerUserId: string;
  relationId: string;
  displayName: string;
  relationName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customer?: RequestCustomer;
    }
  }
}

const customerAuth = createCustomerAuthService();

/** 从请求解析客户 token 载荷（Bearer 优先，其次 cookie）。 */
export function extractCustomerToken(req: Request) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const token = bearer || (req as any).cookies?.bambook_customer_token;
  if (!token) return null;
  return customerAuth.verifyToken(token);
}

/**
 * 客户登录门：仅接受 kind==='customer' 且账号 active 未软删。
 * 失败 → 401；成功 → req.customer。
 */
export function createRequireCustomer(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const payload = extractCustomerToken(req);
      if (!payload) {
        return void res.status(401).json({ error: 'UNAUTHORIZED', message: 'Customer login required.' });
      }
      const user = await prisma.customerUser.findFirst({
        where: { id: payload.customerUserId, deletedAt: null, status: 'active' },
      });
      if (!user) {
        return void res.status(401).json({ error: 'UNAUTHORIZED', message: 'This customer account is disabled.' });
      }
      req.customer = {
        customerUserId: user.id,
        relationId: user.relationId,
        displayName: user.displayName,
        relationName: user.relationName || '',
      };
      return next();
    } catch {
      return void res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid customer session.' });
    }
  };
}

export { customerAuth };