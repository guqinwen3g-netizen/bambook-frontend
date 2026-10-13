/**
 * inventoryOwnershipRouteScope.test.ts — GET /summary-by-ownership 的 inventory:read 门
 *
 * 背景（2026-09-16）：报表引擎把 `inventoryItems` 数据集注册进来时，因为该数据集含
 * `unitCost`（金额），读 scope 已收窄到 `inventory:read`——否则持 `reports:write`
 * 而无 `inventory:read` 的角色（典型：财务）可经报表读到库存成本。
 *
 * 但同一份金额在 `GET /v1/inventory/summary-by-ownership` 上**原本只挂认证门**，
 * 于是形成旁路：报表侧被 403 的主体，直接打这个端点就能拿到按货权的成本汇总。
 * 本测试锁定这两条路径**同口径**。
 *
 * 钉住的不变量：
 *   1. 无 inventory:read（持 reports:write）→ 403，且**不读库**（门在 handler 之前）
 *   2. 持 inventory:read → 200
 *   3. 未登录 → 401（不是 403：先有身份才谈 scope）
 *   4. 同口径自检：`ownedOnly` 只含 Owned（与 D7-② 服务层测试同一口径）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const auditCalls: any[] = [];
vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn(async (p: any) => { auditCalls.push(p); return {}; }),
}));

import { createInventoryRouter } from '../inventoryRoute';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
/** 财务语义：能进报表设计器（reports:write），但**无** inventory:read */
const financeToken = jwt.sign(
  { userId: 'u_fin', roles: [], permissions: ['reports:read', 'reports:write', 'orders:read'] },
  JWT_SECRET,
);
/** Positive control also holds the actual module scope and sensitive cost grant.
 * The original 200 / quantity / cost assertions are retained. */
const logisticsToken = jwt.sign(
  { userId: 'u_log', roles: [], permissions: ['orders:read', 'inventory:read', 'inventory:write', 'sensitive:cost'] },
  JWT_SECRET,
);

const ITEMS = [
  { id: 'INV1', ownership: 'Owned', quantity: 100, unit: 'M', unitCost: 10, currency: 'CNY', deletedAt: null, warehouseId: 'WH1' },
  { id: 'INV2', ownership: 'Transferred', quantity: 50, unit: 'M', unitCost: 10, currency: 'CNY', deletedAt: null, warehouseId: 'WH1' },
  { id: 'INV3', ownership: 'Owned', quantity: 5, unit: 'PCS', unitCost: null, currency: 'CNY', deletedAt: null, warehouseId: 'WH1' },
];

function makeApp() {
  const findMany = vi.fn(async ({ where }: any) =>
    ITEMS.filter(i => i.deletedAt == null && (!where?.warehouseId || i.warehouseId === where.warehouseId)),
  );
  const prisma: any = {
    inventoryTransfer: {findMany:async()=>[]},
    inventoryItem: { findMany },
    userAccount: { findUnique: vi.fn(async ({where}:any) => ({id:where.id,status:'active',primaryDeptId:null,roles:[{departmentId:null,role:{id:'logistics',name:'logistics',permissions:['orders:read','inventory:read','inventory:write','sensitive:cost'].map(scope=>({permission:{scope}}))}}]})) },
    userPermissionOverrides: {findMany:vi.fn(async()=>[])},
    // Unassigned stock remains readable. No linked orders or customer grants
    // are invented to bypass the real business-visibility resolver.
    order: { findMany: vi.fn(async () => []) },
    relation: { findMany: vi.fn(async () => []) },
    teamMember: { findMany: vi.fn(async () => []) },
    teamDataGrant: { findMany: vi.fn(async () => []) },
    auditLog: { create: async () => ({}) },
  };
  const app = express();
  app.use(express.json());
  app.use('/v1/inventory', createInventoryRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { app, findMany };
}

beforeEach(() => { auditCalls.length = 0; __clearTeamShareCacheForTests(); });

describe('GET /v1/inventory/summary-by-ownership — inventory:read 门', () => {
  it('无 inventory:read（持 reports:write 的财务）→ 403，且不读库', async () => {
    const { app, findMany } = makeApp();
    const res = await request(app)
      .get('/v1/inventory/summary-by-ownership')
      .set({ Authorization: `Bearer ${financeToken}` });
    expect(res.status).toBe(403);
    // permissionGuard 的失败信封是扁平的 { error, message }（不是 { error: { code } }）
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.message).toContain('inventory:read');
    // 门在 handler 之前：被拦时不应有任何一次库存查询（防「先算再判」泄露）
    expect(findMany).not.toHaveBeenCalled();
  });

  /**
   * ★ C6（2026-09-18）语义升级后的断言：`ourStock` = 我方存货（可用 + 在途 + 寄售）。
   *
   * 本用例的数据只有 Owned / Transferred 两档 ⇒ 数值与升级前一致（itemCount=2），
   * 但**字段语义已变**：`ownedOnly` 现在是 `ourStock` 的**别名**（deprecated），
   * 不再是「只含 Owned」。故断言改按原意：**我方存货合计 = 计入档合并**，
   * 并加一条「别名指向同一对象」的断言，防止有人把别名改回「只含 Owned」（那会让
   * 在途/寄售的我方货被静默少算）。
   */
  it('持 inventory:read → 200，且我方存货 = 计入存货的各档合并（ourStock）', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/v1/inventory/summary-by-ownership')
      .set({ Authorization: `Bearer ${logisticsToken}` });
    expect(res.status).toBe(200);
    expect(res.body.byOwnership.map((g: any) => g.ownership)).toEqual(['Owned', 'Transferred']);

    expect(res.body.ourStock.ownership).toBe('OurStock');
    // 我方存货：2 项（本例只有 Owned 档），跨单位不相加 → M / PCS 各一行
    expect(res.body.ourStock.itemCount).toBe(2);
    expect(res.body.ourStock.quantityByUnit).toEqual([
      { unit: 'M', quantity: 100 },
      { unit: 'PCS', quantity: 5 },
    ]);
    // 无 unitCost 的 PCS 项不计入金额 → 只有 100×10=1000
    expect(res.body.ourStock.valueByCurrency).toEqual([{ currency: 'CNY', value: 1000 }]);
    // 别名：同一对象（不是「只含 Owned」的旧口径）
    expect(res.body.ownedOnly).toEqual(res.body.ourStock);
    // 分档明细：本例只有 Owned 计入
    expect(res.body.ourStockBreakdown.map((g: any) => g.ownership)).toEqual(['Owned']);
  });

  it('未登录 → 401（先有身份，再谈 scope）', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/v1/inventory/summary-by-ownership');
    expect(res.status).toBe(401);
  });

  it('warehouseId 过滤透传到服务层（门不吞参数）', async () => {
    const { app, findMany } = makeApp();
    const res = await request(app)
      .get('/v1/inventory/summary-by-ownership?warehouseId=WH1')
      .set({ Authorization: `Bearer ${logisticsToken}` });
    expect(res.status).toBe(200);
    expect(res.body.warehouseId).toBe('WH1');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect((findMany.mock.calls[0] as any)[0].where.warehouseId).toBe('WH1');
  });
});
