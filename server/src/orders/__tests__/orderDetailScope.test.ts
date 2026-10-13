import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createOrdersRouter } from '../route';

/**
 * P1-1 审计补缺（2026-09-03）：orders V1 详情 GET /:id 行级数据范围。
 * 此前详情不带 actor 不查 dataScope（列表已用 buildOrderListScopeWhere），
 * Sales 可凭 id/PO 直读跨部门订单 → 复用同一行级 where：跨部门订单详情 404（与列表口径一致）。
 * 口径与列表完全相同（orderService.buildOrderListScopeWhere）：
 *   sales → 可见 relation（跟进 ∪ 组共享）∪ 无客户锚遗留单回退 ownerId=me。
 */

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, SECRET);

function makeApp(opts: { orders: any[]; visibleRelationIds?: string[] }) {
  const visibleRelationIds = opts.visibleRelationIds ?? ['REL_MINE'];
  const orders = opts.orders;

  const orderFindFirst = vi.fn(async ({ where }: any) => {
    const byId = orders.find((o: any) =>
      (where.OR || []).some((c: any) => c.id === o.id || c.poNumber === o.poNumber),
    ) ?? null;
    if (!byId) return null;
    // 行级 scope（where.AND = buildOrderListScopeWhere 产物）
    if (where.AND && where.AND.OR) {
      const visible = visibleRelationIds;
      const scopeOk = where.AND.OR.some((c: any) => {
        if (c.customerRelationId && c.customerRelationId.in) {
          return c.customerRelationId.in.includes(byId.customerRelationId);
        }
        if (c.AND) {
          return byId.customerRelationId === null && c.AND.ownerId === byId.ownerId;
        }
        return false;
      });
      if (!scopeOk) return null;
    }
    return byId;
  });

  const prisma: any = {
    order: { findFirst: orderFindFirst },
    relation: {
      findMany: vi.fn().mockResolvedValue(
        visibleRelationIds.map((id) => ({ id })),
      ),
    },
    teamMember: { findMany: vi.fn().mockResolvedValue([]) },
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: true, apiKeys: new Set(['ak']) }));
  return { app, orderFindFirst };
}

const baseOrder = {
  id: 'ORD__MINE',
  poNumber: 'PO-MINE',
  status: 'Pending',
  customerRelationId: 'REL_MINE',
  ownerId: null,
  deletedAt: null,
  lines: [],
};

describe('P1-1 · orders 详情 GET /:id 行级数据范围', () => {
  it('sales 读本人可见客户订单详情 → 200', async () => {
    const { app } = makeApp({ orders: [baseOrder] });
    const res = await request(app)
      .get('/api/v1/orders/ORD__MINE')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.order.id).toBe('ORD__MINE');
  });

  it('sales 凭 poNumber 读本人可见订单详情 → 200', async () => {
    const { app } = makeApp({ orders: [baseOrder] });
    const res = await request(app)
      .get('/api/v1/orders/PO-MINE')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(200);
  });

  it('sales 读跨部门订单详情（customerRelationId 不可见）→ 404', async () => {
    const otherOrder = { ...baseOrder, id: 'ORD__OTHER', poNumber: 'PO-OTHER', customerRelationId: 'REL_OTHER' };
    const { app, orderFindFirst } = makeApp({ orders: [baseOrder, otherOrder] });
    const res = await request(app)
      .get('/api/v1/orders/ORD__OTHER')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // 行级 where 确实被带进查询
    expect(orderFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ AND: expect.anything() }) }),
    );
  });

  it('sales 读不存在订单 → 404（无 scopeWhere 也 404）', async () => {
    const { app } = makeApp({ orders: [baseOrder] });
    const res = await request(app)
      .get('/api/v1/orders/NOPE')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(404);
  });
});
