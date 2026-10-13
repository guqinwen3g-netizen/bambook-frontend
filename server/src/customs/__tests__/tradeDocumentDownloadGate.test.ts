/**
 * 贸易单据归档文件下载端点 scope 门测试（customsRoute.ts）
 *
 * 背景（安全修复）：uploads/trade-documents 子树（商业发票/箱单/提单等 PDF 归档，
 *   customs/procurement/quotation/orders/qc 五域共用 generateTradeDocumentFile 通道）
 *   此前经 /api/uploads 静态服务无鉴权直读——index.ts 已将该子树 fail-closed 404，
 *   下载统一收敛到 GET /trade-documents/:id/download（customs:read 门，isInsideDir 防穿越）。
 *
 * 覆盖：
 *   1. 无 customs:read scope 角色（viewer）→ 403 INSUFFICIENT_SCOPE（不触达文件层）
 *   2. 未登录 → 401
 *   3. 持 scope 角色（logistics）→ 200 PDF（临时 uploads 根 + 归档文件直读）
 *   4. 目录穿越 filePath → 404 归档路径非法（不读子树外文件）
 *   5. 单据不存在 / 无归档 → 404
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const logisticsToken = jwt.sign({ userId: 'u-logi', roles: ['logistics'] }, SECRET);
const viewerToken = jwt.sign({ userId: 'u-view', roles: ['viewer'] }, SECRET);
const apiKeys = new Set<string>();

import { createCustomsRouter } from '../customsRoute';

// 临时 uploads 根（端点内按请求读 BAMBOOK_UPLOAD_DIR）
let tmpUploadRoot: string;
const ARCHIVE_REL = 'trade-documents/TD__1-CI-001-v1.pdf';

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
  app.use('/api/v1/customs', createCustomsRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

function makeDocPrisma(doc: any) {
  const prisma = { tradeDocument: { findFirst: vi.fn().mockResolvedValue(doc) },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: async (work: any) => work(prisma) };
  return prisma;
}

describe('贸易单据归档下载端点 scope 门（GET /trade-documents/:id/download）', () => {
  beforeEach(() => {
    tmpUploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-uploads-'));
    process.env.BAMBOOK_UPLOAD_DIR = tmpUploadRoot;
    fs.mkdirSync(path.join(tmpUploadRoot, 'trade-documents'), { recursive: true });
    fs.writeFileSync(path.join(tmpUploadRoot, ARCHIVE_REL), '%PDF-FAKE-ARCHIVE');
  });

  afterEach(() => {
    delete process.env.BAMBOOK_UPLOAD_DIR;
    fs.rmSync(tmpUploadRoot, { recursive: true, force: true });
  });

  it('未登录 → 401', async () => {
    const app = makeApp(makeDocPrisma(null));
    const res = await request(app).get('/api/v1/customs/trade-documents/TD__1/download');
    expect(res.status).toBe(401);
  });

  it('无 customs:read scope（viewer）→ 403 INSUFFICIENT_SCOPE（不触达数据层）', async () => {
    const prisma = makeDocPrisma(null);
    const app = makeApp(prisma);
    const res = await request(app)
      .get('/api/v1/customs/trade-documents/TD__1/download')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('INSUFFICIENT_SCOPE');
    expect(prisma.tradeDocument.findFirst).not.toHaveBeenCalled();
  });

  it('持 scope 角色（logistics）+ 归档存在 → 200 PDF 附件', async () => {
    const doc = { id: 'TD__1', documentNumber: 'CI-001', filePath: ARCHIVE_REL, fileName: 'CI-001-v1.pdf', deletedAt: null };
    const app = makeApp(makeDocPrisma(doc));
    const res = await request(app)
      .get('/api/v1/customs/trade-documents/TD__1/download')
      .set('Authorization', `Bearer ${logisticsToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('CI-001-v1.pdf'));
    expect(Buffer.from(res.body).toString()).toContain('%PDF-FAKE-ARCHIVE');
  });

  it('目录穿越 filePath（逃出 trade-documents 子树）→ 404 归档路径非法', async () => {
    // 子树外文件真实存在（临时根下 sibling.txt），端点必须拒绝读取
    fs.writeFileSync(path.join(tmpUploadRoot, 'sibling-secret.txt'), 'SECRET');
    const doc = { id: 'TD__EVIL', documentNumber: 'CI-EVIL', filePath: '../sibling-secret.txt', fileName: 'evil.pdf', deletedAt: null };
    const app = makeApp(makeDocPrisma(doc));
    const res = await request(app)
      .get('/api/v1/customs/trade-documents/TD__EVIL/download')
      .set('Authorization', `Bearer ${logisticsToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('归档路径非法');
  });

  it('单据不存在 / 尚未生成归档 → 404', async () => {
    const app = makeApp(makeDocPrisma(null));
    const nf = await request(app)
      .get('/api/v1/customs/trade-documents/NOPE/download')
      .set('Authorization', `Bearer ${logisticsToken}`);
    expect(nf.status).toBe(404);

    const app2 = makeApp(makeDocPrisma({ id: 'TD__2', documentNumber: 'PL-002', filePath: null, fileName: null, deletedAt: null }));
    const noFile = await request(app2)
      .get('/api/v1/customs/trade-documents/TD__2/download')
      .set('Authorization', `Bearer ${logisticsToken}`);
    expect(noFile.status).toBe(404);
  });
});
