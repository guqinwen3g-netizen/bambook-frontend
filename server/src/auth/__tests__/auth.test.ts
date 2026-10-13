import { describe, expect, it, afterEach } from 'vitest';
import { createAuthService } from '../service';

const JWT_SECRET = 'test-secret-key-at-least-32-chars';

describe('Auth service', () => {
  it('hashes and verifies passwords with bcrypt', async () => {
    const auth = createAuthService({ jwtSecret: JWT_SECRET });
    const hash = await auth.hashPassword('my-secure-password');
    expect(hash).not.toBe('my-secure-password');
    await expect(auth.verifyPassword('my-secure-password', hash)).resolves.toBe(true);
    await expect(auth.verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('signs a JWT and verifies it back to an ActorContext', async () => {
    const auth = createAuthService({ jwtSecret: JWT_SECRET });
    const token = auth.signToken({
      userId: 'u1',
      displayName: 'Kevin',
      roles: ['owner'],
      permissions: ['ai:chat', 'orders:read'],
      departmentIds: ['company'],
    });
    expect(typeof token).toBe('string');

    const payload = auth.verifyToken(token);
    expect(payload).toMatchObject({
      userId: 'u1',
      displayName: 'Kevin',
      roles: ['owner'],
      permissions: ['ai:chat', 'orders:read'],
      departmentIds: ['company'],
    });
  });

  it('rejects an invalid or expired token', () => {
    const auth = createAuthService({ jwtSecret: JWT_SECRET });
    expect(() => auth.verifyToken('garbage-token')).toThrow();
  });

  it('refreshes a valid token and returns a new one', () => {
    const auth = createAuthService({ jwtSecret: JWT_SECRET });
    const original = auth.signToken({
      userId: 'u1',
      displayName: 'Finance',
      roles: ['finance'],
      permissions: ['finance:read'],
      departmentIds: ['finance'],
    });
    const refreshed = auth.refreshToken(original);
    const payload = auth.verifyToken(refreshed);
    expect(payload.userId).toBe('u1');
    expect(payload.roles).toEqual(['finance']);
    expect(payload.permissions).toEqual(['finance:read']);
    expect(payload.departmentIds).toEqual(['finance']);
  });
});

// ══════════════════════════════════════════════════════════════════
// JWT_SECRET 生产环境启动断言（fail-closed：未配置即抛错阻断启动）
// ══════════════════════════════════════════════════════════════════
describe('JWT_SECRET 生产启动断言', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it('NODE_ENV=production 且未配置 JWT_SECRET（含 options）→ 构造即抛错', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    expect(() => createAuthService()).toThrow(/JWT_SECRET is not configured/);
  });

  it('NODE_ENV=production 且已通过环境变量配置 JWT_SECRET → 正常构造', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'prod-secret-at-least-32-chars-long';
    expect(() => createAuthService()).not.toThrow();
  });

  it('NODE_ENV=production 且通过 options.jwtSecret 显式注入 → 正常构造', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    expect(() => createAuthService({ jwtSecret: 'injected-secret-at-least-32-chars' })).not.toThrow();
  });

  it('非生产环境未配置 JWT_SECRET → 回退开发默认值，不抛错', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    expect(() => createAuthService()).not.toThrow();
  });
});
