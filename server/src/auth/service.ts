import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AgentRole } from '../agent/types';
import { jwtSecretProblems, hasFatalSecretProblem, reportSecretProblemsOnce } from './secretPolicy';

type AuthServiceOptions = {
  jwtSecret?: string;
  jwtExpiresIn?: string;
};

export type TokenPayload = {
  businessAttributes?: string[];
  globalBusinessScope?: boolean;
  grantedPermissions?: string[];
  userId: string;
  displayName?: string;
  roles: AgentRole[];
  /** 新 RBAC 系统角色 ID 列表（role-sales 等），可选，旧 token 不包含 */
  roleIds?: string[];
  permissions: string[];
  /** Current DB role/grant loading succeeded; an empty permissions array is authoritative. */
  authorizationLoaded?: true;
  /** Server-owned API-key session ceiling; never loaded from a tool input. */
  permissionCeiling?: string[];
  departmentIds: string[];
};

export function createAuthService(options: AuthServiceOptions = {}) {
  const isProduction = process.env.NODE_ENV === 'production';
  const configuredSecret = options.jwtSecret || process.env.JWT_SECRET;

  // 生产环境启动断言（安全 fail-closed）：
  // 1) 必须显式配置，禁止回退到开发默认值；
  // 2) 且不得是公开仓库/模板里的已知值——照抄 server/.env.example 而不改，
  //    等于把签名密钥公之于众，任何人都能伪造任意 userId / roles 的 token。
  // 详见 auth/secretPolicy.ts。
  const secretProblems = jwtSecretProblems(configuredSecret);
  if (isProduction && hasFatalSecretProblem(secretProblems)) {
    throw new Error(
      `[SECURITY] ${secretProblems
        .filter((p) => p.level === 'fatal')
        .map((p) => p.message)
        .join('；')}。生产启动已中止。`,
    );
  }
  reportSecretProblemsOnce(secretProblems);

  const jwtSecret = configuredSecret || 'change-me-in-production-at-least-32-chars';
  const jwtExpiresIn = options.jwtExpiresIn || '7d';

  async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  function signToken(payload: TokenPayload): string {
    return jwt.sign(payload as object, jwtSecret, { expiresIn: jwtExpiresIn as any });
  }

  function verifyToken(token: string): TokenPayload {
    const decoded = jwt.verify(token, jwtSecret) as TokenPayload;
    return decoded;
  }

  function refreshToken(token: string): string {
    // Legacy cryptographic primitive only. Public session refresh must reload
    // the current account/authorization before signToken; see auth/route.ts.
    const decoded = jwt.verify(token, jwtSecret, { ignoreExpiration: false }) as TokenPayload;
    const { exp, iat, ...payload } = decoded as TokenPayload & { exp?: number; iat?: number };
    return signToken(payload);
  }

  return { hashPassword, verifyPassword, signToken, verifyToken, refreshToken };
}
