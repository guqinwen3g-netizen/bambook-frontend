import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const viewerToken = jwt.sign({ userId: 'u2', roles: ['viewer'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

const mockSyncEmailsFromImap = vi.fn();
vi.mock('../emailSyncService', () => ({
  syncEmailsFromImap: (...args: any[]) => mockSyncEmailsFromImap(...args),
  buildEmailSyncError: (code: string, message: string) => ({ code, message }),  // 路由测试只关心档位与转达，签名多出的第三参在 JS 侧忽略
  maskAccount: (a: string) => a,
}));

import { createEmailRouter } from '../route';
import { globalErrorHandler } from '../../lib/asyncHandler';

function makeApp(prisma?: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.cookie) {
      const cookies: Record<string,string> = {};
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
      req.cookies = cookies;
    }
    next();
  });
  app.use('/api/v1/email', createEmailRouter({ prisma: prisma || {}, requireAuth: true, apiKeys }));
  // 与组合根同款 4 参错误中间件（asyncHandler reject → 统一映射响应）
  app.use(globalErrorHandler);
  return app;
}

describe('POST /api/v1/email/sync route → service contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('success → 200 {ok:true, synced, skipped, errors, accountMasked}', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: true, data: { synced: 1, skipped: 0, errors: 0, accountMasked: 'us***@bambook.com' } });
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'user@bambook.com', password: 'pass123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.synced).toBe(1);
    expect(res.body.accountMasked).toBe('us***@bambook.com');
    expect(res.body).not.toHaveProperty('password');
  });

  it('missing credentials → 400 MISSING_CREDENTIALS', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: false, error: { code: 'MISSING_CREDENTIALS', message: 'email and password are required' } });
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_CREDENTIALS');
    expect(JSON.stringify(res.body)).not.toContain('supersecret');
  });

  it('IMAP connect fail → 502 IMAP_CONNECT_FAILED', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: false, error: { code: 'IMAP_CONNECT_FAILED', message: 'connect failed' } });
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'a@b.com', password: 'p' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('IMAP_CONNECT_FAILED');
  });

  it('DB write fail → 500 DB_WRITE_FAILED', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: false, error: { code: 'DB_WRITE_FAILED', message: 'write failed' } });
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'a@b.com', password: 'p' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DB_WRITE_FAILED');
  });

  it('SYNC_FAILED → 500', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: false, error: { code: 'SYNC_FAILED', message: 'search failed' } });
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'a@b.com', password: 'p' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('SYNC_FAILED');
  });

  it('credential not in response body', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: false, error: { code: 'IMAP_CONNECT_FAILED', message: 'sanitized' } });
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'a@b.com', password: 'supersecret' });
    expect(JSON.stringify(res.body)).not.toContain('supersecret');
  });

  it('SYNC_REF_FAILED → 500', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: false, error: { code: 'SYNC_REF_FAILED', message: 'sync ref fail' } });
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'a@b.com', password: 'p' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('SYNC_REF_FAILED');
  });

  it('AUDIT_FAILED → 500', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: false, error: { code: 'AUDIT_FAILED', message: 'audit fail' } });
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'a@b.com', password: 'p' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AUDIT_FAILED');
  });

  it('route only calls service (no direct IMAP/DB)', async () => {
    mockSyncEmailsFromImap.mockResolvedValue({ ok: true, data: { synced: 0, skipped: 0, errors: 0, accountMasked: '***' } });
    await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'a@b.com', password: 'p' });
    expect(mockSyncEmailsFromImap).toHaveBeenCalledTimes(1);
    const callArgs = mockSyncEmailsFromImap.mock.calls[0][0];
    expect(callArgs.credentials.user).toBe('a@b.com');
    expect(callArgs.credentials.pass).toBe('p');
  });

  it('崩溃链修复：service reject（未预期异常）→ 500 INTERNAL_ERROR，不当 unhandledRejection 打崩进程', async () => {
    mockSyncEmailsFromImap.mockRejectedValue(new Error('unexpected sync crash'));
    const res = await request(makeApp()).post('/api/v1/email/sync').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'a@b.com', password: 'p' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toContain('unexpected sync crash');
  });
});
