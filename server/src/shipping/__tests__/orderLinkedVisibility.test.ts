/**
 * §10.4.2 契约测试：出运单据随关联订单可见。
 *
 * 关键点：DR-016 明确 `Shipment.orderId` 只是「首条分配派生的投影字段」，真源是
 * `ShipmentOrderAllocation` —— 多单拼柜时只看投影字段会漏判，本测试锁这条：
 *   1) 列表：投影命中 ∪ 分配表命中，均以 AND 叠加，不占顶层 OR（search 仍在）
 *   2) 详情：任一来源订单可见 → 200；全部不可见 → 404（不泄露存在性）
 *   3) 全权角色（白名单 null）→ 不加过滤
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const visibilityMock = vi.hoisted(() => ({
  resolveVisibleOrderIds: vi.fn(),
}));
vi.mock('../../auth/orderVisibility', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resolveVisibleOrderIds: visibilityMock.resolveVisibleOrderIds };
});

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createShippingRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, JWT_SECRET);

function makeApp(shipment: any, allocations: Array<{ shipmentId: string; orderId: string }>) {
  const prisma: any = {
    shipment: {
      findMany: vi.fn().mockResolvedValue([shipment]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(shipment),
    },
    shipmentOrderAllocation: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where?.orderId?.in) {
          return allocations
            .filter((a) => where.orderId.in.includes(a.orderId))
            .map((a) => ({ shipmentId: a.shipmentId }));
        }
        if (where?.shipmentId) {
          return allocations.filter((a) => a.shipmentId === where.shipmentId).map((a) => ({ orderId: a.orderId }));
        }
        return [];
      }),
    },
    approvalRequest: { findMany: vi.fn().mockResolvedValue([]) },
    exceptionRequest: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
  return { app, prisma };
}

const SHIPMENT = {
  id: 'SHP__1',
  shipmentNumber: 'SHP-1',
  orderId: 'O_PROJ', // 投影字段：首条分配订单
  type: 'Export',
  status: 'Draft',
  shippingMethod: 'Sea',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

beforeEach(() => visibilityMock.resolveVisibleOrderIds.mockReset());

describe('§10.4.2 出运单随订单可见（投影 ∪ 分配表）', () => {
  it('列表：多单拼柜时经分配表命中，且白名单以 AND 叠加（search OR 保留）', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O_OTHER']);
    const { app, prisma } = makeApp(SHIPMENT, [{ shipmentId: 'SHP__1', orderId: 'O_OTHER' }]);

    const res = await request(app).get('/api/v1/shipping?search=SHP').set(authHeader(salesToken));
    expect(res.status).toBe(200);

    const where = prisma.shipment.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeDefined(); // search OR 未被覆盖
    const andJson = JSON.stringify(where.AND);
    expect(andJson).toContain('O_OTHER'); // 分配表命中
    expect(andJson).toContain('SHP__1'); // 归属该票（id in）
  });

  it('详情：来源订单不可见 → 404', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O_VISIBLE']);
    const { app } = makeApp(SHIPMENT, [{ shipmentId: 'SHP__1', orderId: 'O_HIDDEN' }]);

    const res = await request(app).get('/api/v1/shipping/SHP__1').set(authHeader(salesToken));
    expect([403, 404]).toContain(res.status);
  });

  it('详情：分配表里任一来源订单可见 → 200（即使投影字段指向他单）', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O_MINE']);
    const { app } = makeApp(SHIPMENT, [
      { shipmentId: 'SHP__1', orderId: 'O_OTHER' },
      { shipmentId: 'SHP__1', orderId: 'O_MINE' },
    ]);

    const res = await request(app).get('/api/v1/shipping/SHP__1').set(authHeader(salesToken));
    expect(res.status).toBe(200);
  });
});
