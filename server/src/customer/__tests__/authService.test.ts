/**
 * customer authService 纯单元测试（无需 DB）
 *   - 签发 → 校验 round-trip
 *   - 客户 token 与内部 token 不互认（kind 隔离）
 *   - 篡改/过期 token 拒绝
 */
import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { createCustomerAuthService, CustomerTokenPayload } from '../authService';

const SECRET = 'change-me-in-production-at-least-32-chars';

function svc(over: { secret?: string; expiresIn?: string } = {}) {
  return createCustomerAuthService({ jwtSecret: over.secret || SECRET, jwtExpiresIn: over.expiresIn });
}

describe('customer authService', () => {
  it('签发客户 token 可回验，且携带 kind/relationId', () => {
    const auth = svc();
    const payload: CustomerTokenPayload = { kind: 'customer', customerUserId: 'cu1', relationId: 'clientA', displayName: 'A Co' };
    const token = auth.signToken(payload);
    const decoded = auth.verifyToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe('customer');
    expect(decoded?.relationId).toBe('clientA');
  });

  it('内部角色 token（无 kind=customer）校验返回 null', () => {
    const internal = jwt.sign({ userId: 'u_owner', roles: ['owner'] }, SECRET);
    expect(svc().verifyToken(internal)).toBeNull();
  });

  it('错误密钥签发的 token 校验返回 null', () => {
    const forged = jwt.sign({ kind: 'customer', customerUserId: 'cu1', relationId: 'clientA' }, 'wrong-secret');
    expect(svc().verifyToken(forged)).toBeNull();
  });

  it('过期 token 校验返回 null', () => {
    const auth = svc({ expiresIn: '1ms' });
    const token = auth.signToken({ kind: 'customer', customerUserId: 'cu1', relationId: 'clientA' });
    const expired = new Promise<string>((resolve) => {
      setTimeout(() => resolve(auth.verifyToken(token) ? 'alive' : 'gone'), 20);
    });
    return expect(expired).resolves.toBe('gone');
  });

  it('bcrypt 口令哈希 + 校验正确', async () => {
    const auth = svc();
    const hash = await auth.hashPassword('s3cret');
    expect(await auth.verifyPassword('s3cret', hash)).toBe(true);
    expect(await auth.verifyPassword('wrong', hash)).toBe(false);
  });
});