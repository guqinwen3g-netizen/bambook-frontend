import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 安全收口（2026-09-01）——邮件附件存储与下载契约：
 *   1. defaultEmailAttachmentSaver 落盘私有根 private-files/email-attachments（BAMBOOK_PRIVATE_FILES_DIR 可覆写），
 *      返回相对私有根的路径（email-attachments/...）；
 *   2. resolveEmailAttachmentPath 双基解析：新记录 → 私有根；旧记录（uploads/ 前缀）→ server 根；
 *   3. GET /attachments/:id/download 挂 emails:read 权限门：
 *      无认证/裸 API-Key → 401（scope 判定需 actor）；无 emails:read 的 JWT → 403；
 *      持权限 JWT → 通过门，并从私有根回读文件内容。
 */

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const viewerToken = jwt.sign({ userId: 'u2', roles: ['viewer'] }, SECRET);
const salesToken = jwt.sign({ userId: 'u3', roles: ['sales'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

// 权限门测试走静态导入（不依赖私有根取值）
import { createEmailRouter } from '../route';

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
  app.use('/api/v1/email', createEmailRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

describe('邮件附件下载权限门：GET /api/v1/email/attachments/:id/download', () => {
  it('无认证 → 401', async () => {
    const res = await request(makeApp({})).get('/api/v1/email/attachments/EMLATT__X/download');
    expect(res.status).toBe(401);
  });

  it('裸 API-Key → 401（emails:read scope 判定需 actor 身份，与 W-C 契约一致）', async () => {
    const res = await request(makeApp({}))
      .get('/api/v1/email/attachments/EMLATT__X/download')
      .set('X-Bambook-API-Key', validApiKey);
    expect(res.status).toBe(401);
  });

  it('无 emails:read 的 JWT（viewer）→ 403 FORBIDDEN', async () => {
    const res = await request(makeApp({}))
      .get('/api/v1/email/attachments/EMLATT__X/download')
      .set('Cookie', `bambook_token=${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('owner JWT → 通过权限门（附件不存在 → 404，证明非权限拦截）', async () => {
    const prisma = { emailAttachment: { findUnique: vi.fn(async () => null) } };
    const res = await request(makeApp(prisma))
      .get('/api/v1/email/attachments/EMLATT__X/download')
      .set('Cookie', `bambook_token=${ownerToken}`);
    expect(res.status).toBe(404);
    expect(prisma.emailAttachment.findUnique).toHaveBeenCalledOnce();
  });

  it('sales JWT（矩阵含 emails:read）→ 通过权限门', async () => {
    const prisma = { emailAttachment: { findUnique: vi.fn(async () => null) } };
    const res = await request(makeApp(prisma))
      .get('/api/v1/email/attachments/EMLATT__X/download')
      .set('Cookie', `bambook_token=${salesToken}`);
    expect(res.status).toBe(404);
  });
});

describe('邮件附件私有根存储契约（defaultEmailAttachmentSaver / resolveEmailAttachmentPath）', () => {
  it('落盘 BAMBOOK_PRIVATE_FILES_DIR/email-attachments 并返回相对私有根路径', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-private-store-'));
    process.env.BAMBOOK_PRIVATE_FILES_DIR = tmp;
    try {
      vi.resetModules();
      const { defaultEmailAttachmentSaver } = await import('../emailSyncService');
      const rel = defaultEmailAttachmentSaver('EML__T1', {
        filename: '报价单.pdf',
        content: Buffer.from('%PDF-1.4 private-store'),
      });
      expect(rel).toBeTruthy();
      expect(rel!.startsWith(path.join('email-attachments', 'EML__T1'))).toBe(true);
      // 文件名清洗 + 私有根落盘
      expect(rel).not.toContain('..');
      expect(fs.existsSync(path.join(tmp, rel!))).toBe(true);
      expect(fs.readFileSync(path.join(tmp, rel!), 'utf-8')).toContain('private-store');
    } finally {
      delete process.env.BAMBOOK_PRIVATE_FILES_DIR;
      vi.resetModules();
    }
  });

  it('resolveEmailAttachmentPath：新记录 → 私有根基；旧记录 uploads/ 前缀 → server 根基', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-private-resolve-'));
    process.env.BAMBOOK_PRIVATE_FILES_DIR = tmp;
    try {
      vi.resetModules();
      const { resolveEmailAttachmentPath } = await import('../emailSyncService');
      expect(resolveEmailAttachmentPath('email-attachments/EML__T1_ab12_cd.pdf'))
        .toBe(path.join(tmp, 'email-attachments/EML__T1_ab12_cd.pdf'));
      const legacy = resolveEmailAttachmentPath('uploads/email-attachments/EML__T1_ab12_cd.pdf');
      expect(legacy.startsWith(tmp)).toBe(false); // 旧记录不解析进私有根
      expect(legacy).toContain(path.join('uploads', 'email-attachments'));
    } finally {
      delete process.env.BAMBOOK_PRIVATE_FILES_DIR;
      vi.resetModules();
    }
  });

  it('端到端：持权限 JWT 经下载路由从私有根读到文件内容（不暴露静态 URL）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-private-e2e-'));
    process.env.BAMBOOK_PRIVATE_FILES_DIR = tmp;
    try {
      vi.resetModules();
      const { createEmailRouter: createRouterFresh } = await import('../route');
      const rel = 'email-attachments/EML__T2_beef_report.pdf';
      fs.mkdirSync(path.join(tmp, 'email-attachments'), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), '%PDF-1.4 gated-download');

      const prisma = {
        emailAttachment: {
          findUnique: vi.fn(async () => ({
            id: 'EMLATT__E2E', filePath: rel, filename: 'report.pdf', contentType: 'application/pdf',
          })),
        },
      };
      const app = express();
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
      app.use('/api/v1/email', createRouterFresh({ prisma, requireAuth: true, apiKeys }));

      const ok = await request(app)
        .get('/api/v1/email/attachments/EMLATT__E2E/download')
        .set('Cookie', `bambook_token=${ownerToken}`);
      expect(ok.status).toBe(200);
      expect(ok.body.toString()).toContain('gated-download');

      // 无 emails:read 的 JWT 同一文件 → 403（文件存在与否不影响门禁判定）
      const forbidden = await request(app)
        .get('/api/v1/email/attachments/EMLATT__E2E/download')
        .set('Cookie', `bambook_token=${viewerToken}`);
      expect(forbidden.status).toBe(403);
    } finally {
      delete process.env.BAMBOOK_PRIVATE_FILES_DIR;
      vi.resetModules();
    }
  });
});
