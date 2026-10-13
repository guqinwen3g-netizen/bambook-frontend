/**
 * 共享 JWT mock helper for route tests.
 *
 * 背景：W2 auth guard 统一后，写操作路由用 requireRole(...) 或 requireJwtForWrite(...)
 * 强制 JWT。测试用 requireAuth: false 只 bypass createModuleAuthGuard，
 * 不 bypass requireRole（requireRole 不感知 requireAuth 配置）。
 *
 * 用法：
 *   import { authHeader } from '../../__tests__/authTestHelper';
 *   const res = await request(app).patch('/api/v1/finance/I1')
 *     .set(authHeader())
 *     .send({ status: 'PartiallyPaid' });
 *
 * secret 与 auth/service.ts 默认值对齐。
 */
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';

export const ownerToken = jwt.sign(
  { userId: 'u_owner', roles: ['owner'] },
  JWT_SECRET,
);

export const adminToken = jwt.sign(
  { userId: 'u_admin', roles: ['admin'] },
  JWT_SECRET,
);

export const managerToken = jwt.sign(
  { userId: 'u_manager', roles: ['manager'] },
  JWT_SECRET,
);

export const financeToken = jwt.sign(
  { userId: 'u_finance', roles: ['owner', 'finance'] },
  JWT_SECRET,
);

/**
 * 返回 Bearer auth header 对象，用于 supertest .set()。
 * 默认 owner 角色（所有 HIGH_RISK_ROLES 都包含）。
 */
export function authHeader(token: string = ownerToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
