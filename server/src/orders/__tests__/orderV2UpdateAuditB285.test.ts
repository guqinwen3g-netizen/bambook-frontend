/**
 * B285（v3.237 补 29 立案）：**通过 v2 接口改单，审计里查不到这件事**。
 *
 * 撞出来的过程不是设计审查，是回填演示数据：13 张单的 `departmentId` 经
 * `PUT /api/v2/orders/:id` 实际改掉了（回读 13 张有值），但审计一条都没写。
 * 现读的不对称（不是推测）：
 *   · v1 `route.ts` 的 `PUT /:id` 在事务里调 `writeRouteAuditLog({ operation: 'update_order', … })`（:587）
 *   · v2 `routeV2.ts` 的 `PUT /:id`（:264）只 `svc.updateOrder(...)` 就返回，全文件仅 techpack 那一处写审计
 * ⇒ 同一个"改单留痕"在两个 API 版本上不等价 ⇒ 判为**漏挂**（Order 本就在 §11 第 6 条承诺的映射表 11 类里，
 *   不需要新口径），修在 v2 的更新路径上。
 *
 * ★ 断言的是**真行为**：真 Prisma + 真库里的真 `AuditLog` 行（不 mock 审计写入器 ——
 *   断"某个 mock 被调用过"只能证明代码调了它，证明不了库里长出可查的留痕）。
 *   权限解析是外部边界，按同目录既有件的做法 mock 成 `rule:'all'`。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../auth/permissionService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../auth/permissionService')>(),
  createPermissionService: vi.fn(() => ({
    getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] }),
  })),
}));
vi.mock('../../sequence/sequenceService', () => ({
  createSequenceService: vi.fn(() => ({ nextNumber: vi.fn().mockResolvedValue('SO-202609-285') })),
}));
vi.mock('../../dictionaries/dataDictionaryService', () => ({
  getDataDictionaryService: vi.fn(() => ({ getEntries: vi.fn().mockResolvedValue([]) })),
}));

import { createOrdersV2Router } from '../routeV2';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const token = jwt.sign({ userId: 'u285', roles: ['owner'] }, JWT_SECRET);

const ORDER_ID = 'T285-V2-AUDIT';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/orders', createOrdersV2Router({ prisma, requireAuth: false, apiKeys: new Set<string>() }));
  return app;
}

async function wipe() {
  await prisma.orderLine.deleteMany({ where: { orderId: ORDER_ID } });
  await prisma.auditLog.deleteMany({ where: { targetId: ORDER_ID } });
  await prisma.order.deleteMany({ where: { id: ORDER_ID } });
}

async function seedOrder() {
  // 列形状照抄同目录那件已跑通的种子（不塞未验证的 source/currency）
  await prisma.order.create({
    data: {
      id: ORDER_ID,
      poNumber: ORDER_ID,
      customer: 'B285 取证客户',
      product: 'B285 取证品',
      type: 'Fabric',
      quantity: 10,
      status: 'Draft',
      dueDate: '2026-12-31',
      quoteAmount: 100,
      totalNet: 100,
      contractAmount: 100,
      salesPrice: 10,
    },
  });
}

beforeAll(async () => {
  await wipe();
  // AuditLog.actorId 有 FK ⇒ 测试身份必须真存在
  await prisma.userAccount.upsert({
    where: { id: 'u285' }, update: {},
    create: { id: 'u285', displayName: 'B285 取证身份', email: 'u285@test.local' },
  });
  await seedOrder();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe('B285：v2 PUT 改单必须留审计（与 v1 对齐）', () => {
  it('PUT /api/v2/orders/:id 改一个字段 ⇒ 库里长出一条 Order 级留痕', async () => {
    const before = await prisma.auditLog.count({ where: { targetType: 'Order', targetId: ORDER_ID } });
    const res = await request(makeApp())
      .put(`/api/v2/orders/${ORDER_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ departmentId: 'dept-sales' });

    // 先确认这一刀真的落库了——否则"没有留痕"可能只是"什么都没改"
    expect(res.status).toBe(200);
    const row = await prisma.order.findUnique({ where: { id: ORDER_ID }, select: { departmentId: true } });
    expect(row?.departmentId).toBe('dept-sales');

    const after = await prisma.auditLog.findMany({
      where: { targetType: 'Order', targetId: ORDER_ID },
      orderBy: { createdAt: 'desc' },
    });
    expect(after.length, `改了列但审计没长行（留痕数 ${before} → ${after.length}）⇒ B285 的洞`).toBeGreaterThan(before);
    expect(after.length).toBeGreaterThan(0);
  });

  it('留痕里能点名"改了哪一列"（before/after 不是空壳）', async () => {
    const latest = await prisma.auditLog.findFirst({
      where: { targetType: 'Order', targetId: ORDER_ID },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest, '上一条用例已保证有行；这里再守内容').not.toBeNull();
    const blob = JSON.stringify([latest!.fieldPath, latest!.beforeValue, latest!.afterValue, latest!.detail]);
    expect(blob, '留痕里查不到被改的列名 ⇒ 只有"有人动过"没有"动了什么"').toContain('departmentId');
  });
});
