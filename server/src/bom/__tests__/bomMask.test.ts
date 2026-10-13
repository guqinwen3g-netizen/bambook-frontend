/**
 * 权限矩阵全组合审计 P0-4 — BOM 成本敏感遮罩路由测试（2026-09-03）
 *
 * 锁定：GET /api/v1/bom 列表（JSON + xlsx 台账）与 /:id 详情，未持 sensitive:cost 的
 * 角色（sales 等）成本合计/单价/金额/利润一律 null；owner 直通全量。
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createBOMRouter } from '../bomRoute';
import { authHeader } from '../../__tests__/authTestHelper';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
// sales 角色经 LEGACY_TO_ROLE_ID → SALES：持 bom:read 但无 sensitive:cost
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, JWT_SECRET);

const BOM = {
  id: 'BOM__1',
  bomNumber: 'BOM-001',
  description: '测试 BOM',
  status: 'Confirmed',
  version: 1,
  totalMaterialCost: 1312.5,
  totalLaborCost: 500,
  totalOverheadCost: 200,
  totalCost: 2012.5,
  profitAmount: 987.5,
  profitMargin: 32.9,
  currency: 'CNY',
  createdAt: 0,
  updatedAt: 0,
  lines: [
    { id: 'L1', lineNumber: 1, description: '面料', quantity: 1, unitCost: 100, amount: 1312.5, createdAt: 0, updatedAt: 0 },
  ],
  costEstimates: [{ id: 'C1', costType: 'Labor', description: '人工', amount: 500, createdAt: 0, updatedAt: 0 }],
};

function makeApp() {
  const prisma: any = {
    bOM: {
      findMany: async () => [BOM],
      count: async () => 1,
      findUnique: async () => BOM,
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bom', createBOMRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
  return app;
}

describe('BOM 成本敏感遮罩（P0-4）', () => {
  it('owner → 列表成本全量明文', async () => {
    const res = await request(makeApp()).get('/api/v1/bom/').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items[0].totalCost).toBe(2012.5);
    expect(res.body.items[0].totalMaterialCost).toBe(1312.5);
    expect(res.body.items[0].profitAmount).toBe(987.5);
    expect(res.body.items[0].profitMargin).toBe(32.9);
  });

  it('sales（无 sensitive:cost）→ 列表成本合计遮罩 null，非敏感字段保留', async () => {
    const res = await request(makeApp()).get('/api/v1/bom/').set({ Authorization: `Bearer ${salesToken}` });
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.totalCost).toBeNull();
    expect(item.totalMaterialCost).toBeNull();
    expect(item.totalLaborCost).toBeNull();
    expect(item.totalOverheadCost).toBeNull();
    expect(item.profitAmount).toBeNull();
    expect(item.profitMargin).toBeNull();
    expect(item.bomNumber).toBe('BOM-001');
    expect(item.status).toBe('Confirmed');
  });

  it('sales → 详情：成本合计/行单价/行金额/成本估算/利润全遮罩 null', async () => {
    const res = await request(makeApp()).get('/api/v1/bom/BOM__1').set({ Authorization: `Bearer ${salesToken}` });
    expect(res.status).toBe(200);
    const bom = res.body.bom;
    expect(bom.totalCost).toBeNull();
    expect(bom.profitAmount).toBeNull();
    expect(bom.lines[0].unitCost).toBeNull();
    expect(bom.lines[0].amount).toBeNull();
    expect(bom.costEstimates[0].amount).toBeNull();
    expect(bom.description).toBe('测试 BOM');
  });

  it('owner → 详情成本全量明文', async () => {
    const res = await request(makeApp()).get('/api/v1/bom/BOM__1').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.bom.totalCost).toBe(2012.5);
    expect(res.body.bom.lines[0].unitCost).toBe(100);
  });
});


describe('BOM list existing profit fields honor loaded grants and signed ceiling', () => {
  it.each([
    { permissions: ['bom:read', 'sensitive:cost'], permissionCeiling: ['bom:read', 'sensitive:cost'], visible: true },
    { permissions: ['bom:read', 'sensitive:cost'], permissionCeiling: ['bom:read'], visible: false },
    { permissions: ['bom:read'], permissionCeiling: undefined, visible: false },
  ])('current costs visibility=$visible preserves original profit value or null', async ({ permissions, permissionCeiling, visible }) => {
    const token = jwt.sign({ userId: 'u_explicit', roles: ['sales'], permissions, permissionCeiling, authorizationLoaded: true }, JWT_SECRET);
    const response = await request(makeApp()).get('/api/v1/bom/').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.items[0].profitAmount).toBe(visible ? 987.5 : null);
    expect(response.body.items[0].profitMargin).toBe(visible ? 32.9 : null);
    expect(response.body.items[0].bomNumber).toBe('BOM-001');
  });
});
