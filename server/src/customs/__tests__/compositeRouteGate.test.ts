/**
 * 组合单据端点 scope 写门测试（customsRoute.ts）
 *
 * 背景：批次 H3 起 assembleCompositeDocument 对 MERGED_PL/CONTRACT 默认幂等登记
 *   TradeDocument 台账（写库，compositeDocumentService.ts registerCompositeTradeDocument），
 *   但 /trade-documents/composite/preview.html 与 /trade-documents/composite/generate.pdf
 *   两端点漏挂写门——已对齐同文件其他写端点口径（requireWrite + requireCustomsWrite）。
 *   纯读预览（GET /trade-documents/:id/preview.html）与 render-by-shipment（不登记）保持原口径。
 *
 * 覆盖：
 *   1. 无 customs:write scope 角色（viewer）→ 403 INSUFFICIENT_SCOPE（两端点，不触达装配）
 *   2. API key 单轨 → 401（写 scope 必须 JWT 用户会话）
 *   3. 持 scope 角色（logistics）→ 200（preview HTML / generate PDF；装配/渲染/PDF 均 mocked，
 *      装配与台账登记语义由 compositeDocument.test.ts 覆盖）
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const logisticsToken = jwt.sign({ userId: 'u-logi', roles: ['logistics'] }, SECRET);
const viewerToken = jwt.sign({ userId: 'u-view', roles: ['viewer'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

// ── Mock 声明（vi.hoisted：vi.mock 工厂提升后在 import 阶段即可安全引用）──
const { assembleMock, renderServerMock, pdfMock } = vi.hoisted(() => ({
  assembleMock: vi.fn(),
  renderServerMock: vi.fn(),
  pdfMock: vi.fn(),
}));

// Mock 组合装配（门禁测试不触数据层；台账登记路径由 compositeDocument.test.ts 覆盖）
vi.mock('../compositeDocumentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compositeDocumentService')>();
  return {
    ...actual,
    assembleCompositeDocument: (...args: any[]) => assembleMock(...args),
  };
});

// Mock 服务端渲染 + PDF 生成（不起浏览器；isCompositeDocKind/isShipmentDocKind 保持真实实现）
// 注：mock 路径相对本测试文件解析（__tests__ 下一级），须用 ../../ 对齐 tradeDocumentLifecycle.test.ts 口径
vi.mock('../../templates/docTemplates/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../templates/docTemplates/registry')>();
  return {
    ...actual,
    renderServerDocument: (...args: any[]) => renderServerMock(...args),
  };
});
vi.mock('../../templates/pdf', () => ({
  renderHtmlToPdf: (...args: any[]) => pdfMock(...args),
}));

import { createCustomsRouter } from '../customsRoute';

function makeApp() {
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
  // 门禁在数据层之前；200 路径的装配/渲染均已 mock，prisma 不触达
  const prisma: any = {};
  app.use('/api/v1/customs', createCustomsRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const MERGED_PL_BODY = { kind: 'MERGED_PL', sourceIds: ['SHP_A', 'SHP_B'] };

describe('组合单据端点 scope 写门（composite preview.html / generate.pdf）', () => {
  beforeEach(() => {
    assembleMock.mockReset().mockResolvedValue({ kind: 'MERGED_PL', data: { totals: { amount: 1, currency: 'USD' } } });
    renderServerMock.mockReset().mockResolvedValue('<html><body>merged pl</body></html>');
    pdfMock.mockReset().mockResolvedValue({ pdf: Buffer.from('%PDF-FAKE'), sha: 'fake', bytes: 9, generatedAt: '', format: 'A4' });
  });

  it('无 customs:write scope（viewer）→ 403 INSUFFICIENT_SCOPE（两端点均拒，不触达装配）', async () => {
    const app = makeApp();

    const preview = await request(app)
      .post('/api/v1/customs/trade-documents/composite/preview.html')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send(MERGED_PL_BODY);
    expect(preview.status).toBe(403);
    expect(preview.body.message).toContain('INSUFFICIENT_SCOPE');

    const pdf = await request(app)
      .post('/api/v1/customs/trade-documents/composite/generate.pdf')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send(MERGED_PL_BODY);
    expect(pdf.status).toBe(403);
    expect(pdf.body.message).toContain('INSUFFICIENT_SCOPE');

    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('API key 单轨 → 401（写 scope 必须 JWT 用户会话）', async () => {
    const app = makeApp();

    const preview = await request(app)
      .post('/api/v1/customs/trade-documents/composite/preview.html')
      .set('x-bambook-api-key', validApiKey)
      .send(MERGED_PL_BODY);
    expect(preview.status).toBe(401);

    const pdf = await request(app)
      .post('/api/v1/customs/trade-documents/composite/generate.pdf')
      .set('x-bambook-api-key', validApiKey)
      .send(MERGED_PL_BODY);
    expect(pdf.status).toBe(401);

    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('持 customs:write（logistics）→ preview.html 200 返回 A4 HTML 画布', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/customs/trade-documents/composite/preview.html')
      .set('Authorization', `Bearer ${logisticsToken}`)
      .send(MERGED_PL_BODY);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('merged pl');
    expect(assembleMock).toHaveBeenCalledTimes(1);
    // actorId 透传：JWT 登录人 u-logi 传入装配（台账审计落真实操作人而非 system）
    expect(assembleMock.mock.calls[0][2]).toEqual({ actorId: 'u-logi' });
    expect(renderServerMock).toHaveBeenCalledTimes(1);
  });

  it('持 customs:write（logistics）→ generate.pdf 200 返回 PDF 流式下载', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/customs/trade-documents/composite/generate.pdf')
      .set('Authorization', `Bearer ${logisticsToken}`)
      .send(MERGED_PL_BODY);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('Consolidated-Packing-List');
    expect(assembleMock).toHaveBeenCalledTimes(1);
    expect(assembleMock.mock.calls[0][2]).toEqual({ actorId: 'u-logi' });
    expect(pdfMock).toHaveBeenCalledTimes(1);
  });
});
