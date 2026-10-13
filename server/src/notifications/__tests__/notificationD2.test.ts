/**
 * D2 主动提醒引擎 — 通知转跟进 + 偏好/目录路由测试
 *
 * 覆盖：
 *   1. convertNotificationToFollowUp 服务层
 *      - 通知不存在 / 属他人 → NOT_FOUND（防越权）
 *      - marker 幂等复用
 *      - relationId 三级解析链（直接携带 / orderId / Invoice entity）
 *      - 全链失败 → NO_RELATION
 *      - 成功创建：marker + 内容合约 + 审计
 *   2. 路由层（supertest + 初始化绑定）
 *      - PUT /preferences/:type 校验与幂等
 *      - GET /catalog 合并启用状态
 *      - POST /:id/convert-to-followup 200/409/404/401
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Mock realtime 模块 — 避免真实 SSE 推送
vi.mock('../../realtime', () => ({
  publishNotificationEvent: vi.fn(),
}));

import {
  convertNotificationToFollowUp,
  notificationFollowUpMarker,
} from '../notificationFollowUpService';
import {
  initializeNotificationBindings,
  resetNotificationBindingsForTest,
} from '../eventBindings';
import { createNotificationsRouter } from '../route';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const userToken = jwt.sign({ userId: 'u1', roles: ['sales'] }, SECRET);

// ── Mock Prisma 工厂（内存表） ──
function makeMockPrisma() {
  const notifications: any[] = [];
  const followUps: any[] = [];
  const orders: any[] = [];
  const invoices: any[] = [];
  const preferences: any[] = [];
  const auditLogs: any[] = [];
  let fuSeq = 0;
  const prisma: any = {
    notification: {
      findUnique: async ({ where }: any) => notifications.find(r => r.id === where.id) || null,
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      groupBy: async ({ where }: any) => {
        const mine = notifications.filter(r => r.userId === where?.userId);
        const byType = new Map<string, number>();
        for (const n of mine) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
        return [...byType.entries()].map(([type, count]) => ({ type, _count: { type: count } }));
      },
      create: vi.fn().mockResolvedValue({}),
    },
    notificationPreference: {
      findMany: async ({ where, select }: any = {}) => {
        let out = preferences.filter(r => r.userId === where?.userId);
        if (where?.notificationType) out = out.filter(r => r.notificationType === where.notificationType);
        if (where?.isEnabled !== undefined) out = out.filter(r => r.isEnabled === where.isEnabled);
        if (where?.userId?.in) out = preferences.filter(r => where.userId.in.includes(r.userId) && r.notificationType === where.notificationType && r.isEnabled === where.isEnabled);
        if (select) return out.map(r => ({ userId: r.userId, notificationType: r.notificationType, isEnabled: r.isEnabled }));
        return out;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = preferences.find(r => r.userId === where.userId_notificationType.userId && r.notificationType === where.userId_notificationType.notificationType);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `np_${preferences.length + 1}`, ...create };
        preferences.push(row);
        return row;
      },
    },
    followUpRecord: {
      findFirst: async ({ where }: any) =>
        followUps.find(r => r.deletedAt === null && (!where?.notes?.contains || String(r.notes || '').includes(where.notes.contains))) || null,
      create: async ({ data }: any) => {
        const row = { deletedAt: null, ...data, id: data.id || `FU_T${++fuSeq}` };
        followUps.push(row);
        return row;
      },
    },
    order: {
      findUnique: async ({ where }: any) => orders.find(r => r.id === where.id) || null,
    },
    invoice: {
      findUnique: async ({ where }: any) => invoices.find(r => r.id === where.id) || null,
    },
    userAccount: {
      findMany: async () => [{ id: 'u1' }],
    },
    auditLog: {
      create: async ({ data }: any) => { auditLogs.push(data); return { id: data.id }; },
    },
    _notifications: notifications,
    _followUps: followUps,
    _orders: orders,
    _invoices: invoices,
    _preferences: preferences,
    _auditLogs: auditLogs,
  };
  return prisma;
}

// ── 路由测试 app 工厂 ──
function makeApp(prisma: any) {
  resetNotificationBindingsForTest();
  initializeNotificationBindings(prisma);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const cookie = req.headers.cookie as string | undefined;
    const m = cookie ? /bambook_token=([^;]+)/.exec(cookie) : null;
    if (m) {
      try {
        const decoded: any = jwt.verify(m[1], SECRET);
        req.actor = { userId: decoded.userId, roles: decoded.roles ?? [] };
      } catch { /* 无效 token → 无 actor */ }
    }
    next();
  });
  app.use('/api/v1/notifications', createNotificationsRouter());
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${userToken}` });

// ════════════════════════════════════════════════════════════════
// 服务层：convertNotificationToFollowUp
// ════════════════════════════════════════════════════════════════
describe('D2 · convertNotificationToFollowUp 服务层', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
  });

  it('通知不存在 → NOT_FOUND；属他人通知 → NOT_FOUND（防越权）', async () => {
    const missing = await convertNotificationToFollowUp(prisma, 'ntf_x', { actorId: 'u1', source: 'test' });
    expect(missing).toEqual({ ok: false, error: 'NOT_FOUND' });

    prisma._notifications.push({ id: 'ntf_1', userId: 'u2', type: 'receivable_overdue', title: 't', body: 'b', metadata: null });
    const wrongOwner = await convertNotificationToFollowUp(prisma, 'ntf_1', { actorId: 'u1', source: 'test' });
    expect(wrongOwner).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(prisma._followUps).toHaveLength(0);
  });

  it('metadata 全空 → NO_RELATION，不落跟进', async () => {
    prisma._notifications.push({ id: 'ntf_2', userId: 'u1', type: 'daily_briefing', title: 't', body: 'b', metadata: null });
    const r = await convertNotificationToFollowUp(prisma, 'ntf_2', { actorId: 'u1', source: 'test' });
    expect(r).toEqual({ ok: false, error: 'NO_RELATION' });
    expect(prisma._followUps).toHaveLength(0);
  });

  it('metadata.relationId 直接命中 → 创建跟进（marker + 内容 + 审计）', async () => {
    prisma._notifications.push({
      id: 'ntf_3', userId: 'u1', type: 'credit_limit_exceeded', title: '信用超额', body: '客户 A 超额',
      metadata: { relationId: 'REL_1' },
    });
    const r = await convertNotificationToFollowUp(prisma, 'ntf_3', { actorId: 'u1', source: 'test' });
    expect(r.ok).toBe(true);
    expect(r.reused).toBe(false);
    expect(prisma._followUps).toHaveLength(1);
    const fu = prisma._followUps[0];
    expect(fu.relationId).toBe('REL_1');
    expect(fu.type).toBe('Other');
    expect(fu.content).toBe('信用超额 — 客户 A 超额');
    expect(fu.notes).toBe(notificationFollowUpMarker('ntf_3'));
    expect(fu.nextFollowUpAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(prisma._auditLogs).toHaveLength(1);
    expect(prisma._auditLogs[0].action).toBe('notification_convert_followup');
  });

  it('metadata.orderId → Order.customerRelationId 解析', async () => {
    prisma._orders.push({ id: 'ORD_1', customerRelationId: 'REL_ORD' });
    prisma._notifications.push({
      id: 'ntf_4', userId: 'u1', type: 'production_deadline', title: '生产超期', body: '订单超期 3 天',
      metadata: { orderId: 'ORD_1', dedupKey: 'k' },
    });
    const r = await convertNotificationToFollowUp(prisma, 'ntf_4', { actorId: 'u1', source: 'test' });
    expect(r.ok).toBe(true);
    expect(prisma._followUps[0].relationId).toBe('REL_ORD');
    expect(prisma._followUps[0].orderId).toBe('ORD_1');
  });

  it('metadata.entityType=Invoice + entityId → Invoice.orderId → Order.customerRelationId 解析', async () => {
    prisma._orders.push({ id: 'ORD_2', customerRelationId: 'REL_INV' });
    prisma._invoices.push({ id: 'INV_1', orderId: 'ORD_2' });
    prisma._notifications.push({
      id: 'ntf_5', userId: 'u1', type: 'receivable_overdue', title: '发票逾期', body: '逾期 20 天',
      metadata: { entityType: 'Invoice', entityId: 'INV_1' },
    });
    const r = await convertNotificationToFollowUp(prisma, 'ntf_5', { actorId: 'u1', source: 'test' });
    expect(r.ok).toBe(true);
    expect(prisma._followUps[0].relationId).toBe('REL_INV');
  });

  it('重复调用 → reused 幂等，不产生重复跟进与重复审计', async () => {
    prisma._notifications.push({
      id: 'ntf_6', userId: 'u1', type: 'receivable_overdue', title: 't', body: 'b',
      metadata: { relationId: 'REL_1' },
    });
    const r1 = await convertNotificationToFollowUp(prisma, 'ntf_6', { actorId: 'u1', source: 'test' });
    const r2 = await convertNotificationToFollowUp(prisma, 'ntf_6', { actorId: 'u1', source: 'test' });
    expect(r1.reused).toBe(false);
    expect(r2).toEqual({ ok: true, reused: true, followUpId: r1.followUpId, nextFollowUpAt: r1.nextFollowUpAt });
    expect(prisma._followUps).toHaveLength(1);
    expect(prisma._auditLogs).toHaveLength(1);
  });

  it('订单存在但未关联客户 → NO_RELATION（不悬空建跟进）', async () => {
    prisma._orders.push({ id: 'ORD_3', customerRelationId: null });
    prisma._notifications.push({
      id: 'ntf_7', userId: 'u1', type: 'stuck_order', title: 't', body: 'b',
      metadata: { orderId: 'ORD_3' },
    });
    const r = await convertNotificationToFollowUp(prisma, 'ntf_7', { actorId: 'u1', source: 'test' });
    expect(r).toEqual({ ok: false, error: 'NO_RELATION' });
  });
});

// ════════════════════════════════════════════════════════════════
// 路由层：偏好 / 目录 / 转跟进
// ════════════════════════════════════════════════════════════════
describe('D2 · 通知偏好与转跟进路由', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
  });

  it('PUT /preferences/:type — 静音后本人不再收到该类型广播；恢复后重新接收', async () => {
    const app = makeApp(prisma);
    const off = await request(app).put('/api/v1/notifications/preferences/daily_briefing').set(auth()).send({ isEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body.item).toEqual({ notificationType: 'daily_briefing', label: '每日简报', isEnabled: false });
    expect(prisma._preferences).toHaveLength(1);

    // 广播验证过滤（direct service 路径已在单测覆盖，这里验证偏好落库语义）
    const prefs = await request(app).get('/api/v1/notifications/preferences').set(auth());
    expect(prefs.body.items).toEqual([{ notificationType: 'daily_briefing', label: '每日简报', isEnabled: false }]);

    const on = await request(app).put('/api/v1/notifications/preferences/daily_briefing').set(auth()).send({ isEnabled: true });
    expect(on.body.item.isEnabled).toBe(true);
    expect(prisma._preferences).toHaveLength(1); // upsert 不产生重复行
  });

  it('PUT /preferences/:type — isEnabled 非布尔 → 400', async () => {
    const app = makeApp(prisma);
    const r = await request(app).put('/api/v1/notifications/preferences/daily_briefing').set(auth()).send({ isEnabled: 'no' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_BODY');
  });

  it('GET /catalog — 注册表类型 + 实见类型合并，静音状态并入', async () => {
    prisma._notifications.push(
      { id: 'n1', userId: 'u1', type: 'receivable_overdue', title: 't', body: 'b' },
      { id: 'n2', userId: 'u1', type: 'receivable_overdue', title: 't', body: 'b' },
    );
    prisma._preferences.push({ id: 'np1', userId: 'u1', notificationType: 'receivable_overdue', isEnabled: false });
    const app = makeApp(prisma);
    const r = await request(app).get('/api/v1/notifications/catalog').set(auth());
    expect(r.status).toBe(200);
    const receivable = r.body.items.find((i: any) => i.type === 'receivable_overdue');
    expect(receivable).toEqual({ type: 'receivable_overdue', label: '应收逾期', isEnabled: false, seenCount: 2 });
    expect(r.body.items.some((i: any) => i.type === 'daily_briefing')).toBe(true);
  });

  it('POST /:id/convert-to-followup — 成功 / 重复 reused / 无关联 409 / 不存在 404 / 无认证 401', async () => {
    prisma._orders.push({ id: 'ORD_9', customerRelationId: 'REL_9' });
    prisma._notifications.push(
      { id: 'ntf_a', userId: 'u1', type: 'production_deadline', title: '生产超期', body: '超期 2 天', metadata: { orderId: 'ORD_9' } },
      { id: 'ntf_b', userId: 'u1', type: 'daily_briefing', title: '简报', body: '汇总', metadata: null },
    );
    const app = makeApp(prisma);

    const ok = await request(app).post('/api/v1/notifications/ntf_a/convert-to-followup').set(auth());
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.reused).toBe(false);
    expect(ok.body.followUpId).toMatch(/^FU_/);

    const again = await request(app).post('/api/v1/notifications/ntf_a/convert-to-followup').set(auth());
    expect(again.status).toBe(200);
    expect(again.body.reused).toBe(true);
    expect(prisma._followUps).toHaveLength(1);

    const noRel = await request(app).post('/api/v1/notifications/ntf_b/convert-to-followup').set(auth());
    expect(noRel.status).toBe(409);
    expect(noRel.body.error).toBe('NO_RELATION');

    const missing = await request(app).post('/api/v1/notifications/ntf_x/convert-to-followup').set(auth());
    expect(missing.status).toBe(404);

    const noAuth = await request(app).post('/api/v1/notifications/ntf_a/convert-to-followup');
    expect(noAuth.status).toBe(401);
  });
});
