/**
 * REQ2-13 客户档案受控导出测试（DR-056-④，SEC-01 双向验收）
 *
 * 覆盖：
 *   1. 业务员（无 data:export:full）→ 403 INSUFFICIENT_SCOPE（负向：批量导出被拒）
 *   2. SuperAdmin（owner）→ 200 CSV（BOM + 表头 + 数据行 + 过滤生效）+ 审计落库（正向：受控通道留痕）
 *   3. 超上限 → 400 EXPORT_TOO_LARGE
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createRelationsV2Router } from '../routeV2';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u_boss', roles: ['owner'] }, SECRET);
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, SECRET);

const ROWS = [
  { code: 'CUS-0001', name: 'Peerless Clothing', chineseName: '皮尔莱斯', englishName: 'Peerless', category: 'Customer', type: 'Customer', stage: 'Customer', tier: 'A', sensitivity: 'normal', ownerId: 'u1', primaryContactName: 'Alice', email: 'a@peerless.com', phone: '+1', website: 'peerless.com', currency: 'USD' },
  { code: 'SUP-0001', name: '绍兴绿环', chineseName: '绍兴绿环', englishName: null, category: 'Supplier', type: 'Supplier', stage: null, tier: null, sensitivity: 'confidential', ownerId: 'u2', primaryContactName: '老王', email: 'w@lh.com', phone: '+86', website: null, currency: 'CNY' },
];

function makeApp(opts: { total?: number } = {}) {
  const auditLogs: any[] = [];
  const prisma: any = {
    relation: {
      count: vi.fn().mockResolvedValue(opts.total ?? ROWS.length),
      findMany: vi.fn().mockImplementation(async ({ where }: any) =>
        ROWS.filter((r: any) => (where?.category ? r.category === where.category : true))),
    },
    auditLog: { create: vi.fn().mockImplementation(async ({ data }: any) => { auditLogs.push(data); return { id: data.id }; }) },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v2/relations', createRelationsV2Router({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { app, prisma, auditLogs };
}

beforeEach(() => vi.clearAllMocks());

describe('REQ2-13 · GET /api/v2/relations/export.csv（SEC-01 受控导出）', () => {
  it('业务员 token → 403 INSUFFICIENT_SCOPE（批量导出被拒，不触达数据层）', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).get('/api/v2/relations/export.csv').set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(prisma.relation.findMany).not.toHaveBeenCalled();
  });

  it('SuperAdmin → 200 CSV（BOM + 表头 + 数据行 + 过滤生效）+ 审计落库', async () => {
    const { app, auditLogs } = makeApp();
    const res = await request(app).get('/api/v2/relations/export.csv?category=Customer').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('relations-');
    const lines = res.text.split('\n');
    expect(res.text.startsWith('\uFEFF')).toBe(true); // Excel 中文兼容 BOM
    expect(lines[0]).toContain('code,name,chineseName');
    expect(lines.length).toBe(2); // 表头 + 1 行（category=Customer 过滤掉 Supplier）
    expect(res.text).toContain('Peerless Clothing');
    expect(res.text).not.toContain('绍兴绿环');
    // SEC-01 防泄露留痕：每次导出写审计（actor/行数/过滤条件）
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe('relations_export_csv');
    expect(auditLogs[0].actorId).toBe('u_boss');
    expect(auditLogs[0].detail.after).toMatchObject({ rowCount: 1 });
  });

  it('未登录 → 401；超上限 → 400 EXPORT_TOO_LARGE', async () => {
    const noAuth = await request(makeApp().app).get('/api/v2/relations/export.csv');
    expect(noAuth.status).toBe(401);

    const { app } = makeApp({ total: 20_001 });
    const res = await request(app).get('/api/v2/relations/export.csv').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('EXPORT_TOO_LARGE');
  });
});
