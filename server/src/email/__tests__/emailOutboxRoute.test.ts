import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockCreateOutboxEmail = vi.fn();
const mockCreateReplyOutboxEmail = vi.fn();
vi.mock('../emailOutboxMutationService', () => ({
  createOutboxEmail: (...args: any[]) => mockCreateOutboxEmail(...args),
  createReplyOutboxEmail: (...args: any[]) => mockCreateReplyOutboxEmail(...args),
}));

import { createEmailRouter } from '../route';
import { globalErrorHandler } from '../../lib/asyncHandler';
import jwt from 'jsonwebtoken';

// P0-2 收口：/outbox 与 /replies 已挂 requirePermission('emails:write') scope 门——
// requireAuth=false 契约测试需注入 owner JWT（SuperAdmin 全放行）保持「测 service 契约、不测门禁」语义。
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!req.headers.authorization && !req.headers.cookie) {
      req.headers.authorization = `Bearer ${ownerToken}`;
    }
    next();
  });
  app.use('/api/v1/email', createEmailRouter({ prisma: { email: { findFirst: vi.fn(async () => ({ id: 'EML__orig' })) } } as any, requireAuth: false, apiKeys: new Set() }));
  // 与组合根同款 4 参错误中间件（asyncHandler reject → 统一映射响应）
  app.use(globalErrorHandler);
  return app;
}

const validBody = { fromAddress: 'me@b.com', to: ['r@t.com'], subject: 'Hi', bodyText: 'Body' };

describe('POST /api/v1/email/outbox route → service contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('compose success → 201 with emailId/mailbox/direction/auditId', async () => {
    mockCreateOutboxEmail.mockResolvedValue({ ok: true, data: { emailId: 'EML__1', auditId: 'alog_1', mailbox: 'Outbox', direction: 'outbound' } });
    const res = await request(makeApp()).post('/api/v1/email/outbox').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.emailId).toBe('EML__1');
    expect(res.body.mailbox).toBe('Outbox');
    expect(res.body.direction).toBe('outbound');
  });

  it('invalid input → 400 MISSING_FROM', async () => {
    mockCreateOutboxEmail.mockResolvedValue({ ok: false, error: { code: 'MISSING_FROM', message: 'fromAddress required' } });
    const res = await request(makeApp()).post('/api/v1/email/outbox').send({ to: ['r@t.com'], subject: 'Hi' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_FROM');
  });

  it('CREATE_FAILED → 500', async () => {
    mockCreateOutboxEmail.mockResolvedValue({ ok: false, error: { code: 'CREATE_FAILED', message: 'db error' } });
    const res = await request(makeApp()).post('/api/v1/email/outbox').send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
  });

  it('SYNC_REF_FAILED → 500', async () => {
    mockCreateOutboxEmail.mockResolvedValue({ ok: false, error: { code: 'SYNC_REF_FAILED', message: 'sync fail' } });
    const res = await request(makeApp()).post('/api/v1/email/outbox').send(validBody);
    expect(res.status).toBe(500);
  });

  it('AUDIT_FAILED → 500', async () => {
    mockCreateOutboxEmail.mockResolvedValue({ ok: false, error: { code: 'AUDIT_FAILED', message: 'audit fail' } });
    const res = await request(makeApp()).post('/api/v1/email/outbox').send(validBody);
    expect(res.status).toBe(500);
  });

  it('route only calls service once', async () => {
    mockCreateOutboxEmail.mockResolvedValue({ ok: true, data: { emailId: 'EML__1', auditId: 'a', mailbox: 'Outbox', direction: 'outbound' } });
    await request(makeApp()).post('/api/v1/email/outbox').send(validBody);
    expect(mockCreateOutboxEmail).toHaveBeenCalledTimes(1);
  });

  it('password not persisted in response', async () => {
    mockCreateOutboxEmail.mockResolvedValue({ ok: true, data: { emailId: 'EML__1', auditId: 'a', mailbox: 'Outbox', direction: 'outbound' } });
    const res = await request(makeApp()).post('/api/v1/email/outbox').send({ ...validBody, password: 'supersecret' });
    expect(JSON.stringify(res.body)).not.toContain('supersecret');
  });

  it('崩溃链修复：service reject → 500 INTERNAL_ERROR，不当 unhandledRejection 打崩进程', async () => {
    mockCreateOutboxEmail.mockRejectedValue(new Error('unexpected outbox crash'));
    const res = await request(makeApp()).post('/api/v1/email/outbox').send(validBody);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
  });
});

describe('POST /api/v1/email/replies route → service contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reply success → 201', async () => {
    mockCreateReplyOutboxEmail.mockResolvedValue({ ok: true, data: { emailId: 'EML__2', auditId: 'alog_2', mailbox: 'Outbox', direction: 'outbound' } });
    const res = await request(makeApp()).post('/api/v1/email/replies').send({ ...validBody, originalEmailId: 'EML__orig' });
    expect(res.status).toBe(201);
    expect(res.body.emailId).toBe('EML__2');
  });

  it('ORIGINAL_EMAIL_NOT_FOUND → 404', async () => {
    mockCreateReplyOutboxEmail.mockResolvedValue({ ok: false, error: { code: 'ORIGINAL_EMAIL_NOT_FOUND', message: 'not found' } });
    const res = await request(makeApp()).post('/api/v1/email/replies').send({ ...validBody, originalEmailId: 'EML__missing' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORIGINAL_EMAIL_NOT_FOUND');
  });

  it('崩溃链修复：service reject → 500 INTERNAL_ERROR，不当 unhandledRejection 打崩进程', async () => {
    mockCreateReplyOutboxEmail.mockRejectedValue(new Error('unexpected reply crash'));
    const res = await request(makeApp()).post('/api/v1/email/replies').send({ ...validBody, originalEmailId: 'EML__orig' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
  });
});
