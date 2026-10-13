/**
 * authService.ts — 客户门户鉴权服务
 *
 * 与内部 RBAC（UserAccount）完全解耦：客户没有角色/权限，唯一语义是
 * 「kind='customer' 且 relationId 绑定的公司」。token 用同一 JWT_SECRET
 * 签名（与 createAuthService 同源），但 payload 形状独立——内部路由因
 * 缺 roles/permissions 天然拒绝，客户路由因 kind!=='customer' 拒绝内部 token。
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  jwtSecretProblems,
  hasFatalSecretProblem,
  reportSecretProblemsOnce,
} from '../auth/secretPolicy';

export interface CustomerTokenPayload {
  kind: 'customer';
  customerUserId: string;
  relationId: string;
  displayName?: string;
  relationName?: string;
}

type AuthServiceOptions = { jwtSecret?: string; jwtExpiresIn?: string };

export function createCustomerAuthService(options: AuthServiceOptions = {}) {
  // 与 server/src/auth/service.ts 同一口径：生产不仅要求「配了」，
  // 还要求不是公开仓库/模板里的已知值（否则人人可伪造客户身份 token）。
  // 详见 auth/secretPolicy.ts。
  const configuredSecret = options.jwtSecret || process.env.JWT_SECRET;
  const secretProblems = jwtSecretProblems(configuredSecret);
  if (process.env.NODE_ENV === 'production' && hasFatalSecretProblem(secretProblems)) {
    throw new Error(
      `[SECURITY] ${secretProblems
        .filter((p) => p.level === 'fatal')
        .map((p) => p.message)
        .join('；')}。生产启动已中止。`,
    );
  }
  reportSecretProblemsOnce(secretProblems, 'JWT_SECRET(customer)');

  const jwtSecret = configuredSecret || 'change-me-in-production-at-least-32-chars';
  const jwtExpiresIn = options.jwtExpiresIn || '7d';

  async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  function signToken(payload: CustomerTokenPayload): string {
    return jwt.sign(payload as object, jwtSecret, { expiresIn: jwtExpiresIn as any });
  }

  function verifyToken(token: string): CustomerTokenPayload | null {
    try {
      const decoded = jwt.verify(token, jwtSecret) as Partial<CustomerTokenPayload>;
      if (decoded?.kind !== 'customer' || !decoded?.customerUserId || !decoded?.relationId) {
        return null;
      }
      return decoded as CustomerTokenPayload;
    } catch {
      return null;
    }
  }

  return { hashPassword, verifyPassword, signToken, verifyToken };
}