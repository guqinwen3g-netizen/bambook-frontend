import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createEmailRouter } from '../route';

/**
 * P0-2 审计收口（2026-09-03）：email 域写端点必须 emails:write scope 门（原 requireWrite 纯 JWT，
 * 任何已登录身份皆可写）；读取/下载类端点按语义用 emails:read。
 * 矩阵真源（server/src/_shared/rolePermissionMatrix.ts）：
 *   - SALES/SALES_MANAGER：emails:read + emails:write（业务员发邮件是 S1 主链日常）
 *   - FINANCE/ADMIN/LOGISTICS：仅 emails:read（业务邮件只读）
 *   - QC(viewer)：无 email scope（emails 域不授权 QC）
 * requirePermission 已内建「写 scope 需 JWT」：裸 API-Key 无法伪造写身份。
 */

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, SECRET); // emails:read + emails:write
const financeToken = jwt.sign({ userId: 'u_fin', roles: ['finance'] }, SECRET); // 仅 emails:read
const viewerToken = jwt.sign({ userId: 'u_viewer', roles: ['viewer'] }, SECRET); // 无 email scope

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.cookie) {
      const cookies: Record<string, string> = {};
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
      req.cookies = cookies;
    }
    next();
  });
  app.use('/api/v1/email', createEmailRouter({ prisma, requireAuth: true, apiKeys: new Set(['ak']) }));
  return app;
}

const auth = (t: string) => ({ Cookie: `bambook_token=${t}` });

describe('P0-2 · email 域写端点 emails:write scope 门', () => {
  it('finance（仅 emails:read）PATCH /:id → 403 INSUFFICIENT_SCOPE', async () => {
    const prisma = { email: { update: vi.fn() } };
    const res = await request(makeApp(prisma))
      .patch('/api/v1/email/EML__1')
      .set(auth(financeToken))
      .send({ isRead: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.message).toMatch(/emails:write/);
    expect(prisma.email.update).not.toHaveBeenCalled();
  });

  it('sales（emails:write）PATCH /:id → 通过门（200）', async () => {
    const prisma = {
      email: {
        update: vi.fn().mockResolvedValue({ id: 'EML__1', status: 'read', isRead: true, updatedAt: 1 }),
      },
    };
    const res = await request(makeApp(prisma))
      .patch('/api/v1/email/EML__1')
      .set(auth(salesToken))
      .send({ isRead: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('finance POST /send（写）→ 403；sales POST /send → 通过门（缺参 400 而非 403）', async () => {
    const app = makeApp({});
    const forbidden = await request(app)
      .post('/api/v1/email/send')
      .set(auth(financeToken))
      .send({ email: 'a@b.com' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.message).toMatch(/emails:write/);

    // sales 通过 emails:write 门后进入 handler → 缺参 400（证明非权限拦截）
    const passed = await request(app)
      .post('/api/v1/email/send')
      .set(auth(salesToken))
      .send({});
    expect(passed.status).toBe(400);
  });

  it('finance POST /mark_read（写）→ 403', async () => {
    const res = await request(makeApp({}))
      .post('/api/v1/email/mark_read')
      .set(auth(financeToken))
      .send({ uid: 1 });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/emails:write/);
  });

  it('finance POST /move（写）→ 403', async () => {
    const res = await request(makeApp({}))
      .post('/api/v1/email/move')
      .set(auth(financeToken))
      .send({ uid: 1, toBox: 'Archive' });
    expect(res.status).toBe(403);
  });
});

describe('P0-2 · email 域读取/下载端点 emails:read scope 门', () => {
  it('finance（emails:read）GET / 列表 → 200', async () => {
    const prisma = {
      email: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    };
    const res = await request(makeApp(prisma))
      .get('/api/v1/email')
      .set(auth(financeToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, items: [], total: 0 });
  });

  it('viewer（无 emails:read）GET / 列表 → 403', async () => {
    const res = await request(makeApp({}))
      .get('/api/v1/email')
      .set(auth(viewerToken));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/emails:read/);
  });

  it('sales POST /fetch（读取）→ 通过 emails:read 门（缺参 400 而非 403）', async () => {
    const res = await request(makeApp({}))
      .post('/api/v1/email/fetch')
      .set(auth(salesToken))
      .send({});
    expect(res.status).toBe(400); // 门通过 → handler 缺 credentials 400
    expect(res.body.error).toBe('Missing credentials');
  });

  it('viewer POST /attachment（下载）→ 403（无 emails:read）', async () => {
    const res = await request(makeApp({}))
      .post('/api/v1/email/attachment')
      .set(auth(viewerToken))
      .send({ uid: 1, filename: 'x.pdf' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/emails:read/);
  });

  it('finance POST /detail（读取）→ 通过 emails:read 门（缺参 400 而非 403）', async () => {
    const res = await request(makeApp({}))
      .post('/api/v1/email/detail')
      .set(auth(financeToken))
      .send({});
    expect(res.status).toBe(400); // 门通过 → handler 缺参 400
  });
});
