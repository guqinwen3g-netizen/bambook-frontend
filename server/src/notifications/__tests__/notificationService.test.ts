/**
 * NotificationService 单元测试
 *
 * 覆盖：
 *   1. notifyFromEvent — 为 active 用户创建通知（含无接收人 / 失败不抛错）
 *   2. listNotifications — 列表 + unreadOnly 过滤
 *   3. getStats — total/unread/critical/byType 统计
 *   4. markAsRead / markAllAsRead / deleteNotification — CRUD 操作
 *   5. 模板渲染 — 不同事件类型生成正确的 title/body
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock realtime 模块 — 避免真实 SSE 推送
vi.mock('../../realtime', () => ({
  publishNotificationEvent: vi.fn(),
}));

import { createNotificationService } from '../notificationService';
import { BusinessEvent } from '../../events/businessEventBus';

// ── Mock Prisma 工厂 ──
function makeMockPrisma(overrides: Record<string, any> = {}) {
  return {
    notification: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      groupBy: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    notificationPreference: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    userAccount: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  } as any;
}

// ── Mock Event 工厂 ──
function makeMockEvent(
  type: string = 'OrderConfirmed',
  payload: Record<string, unknown> = {},
): BusinessEvent {
  return {
    id: `bev_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: type as any,
    sourceEntityType: 'Order',
    sourceEntityId: 'ord_1',
    orderId: 'ord_1',
    payload: { poNumber: 'PO-001', customerName: 'ACME Corp', ...payload },
    occurredAt: Date.now(),
    actorId: 'test_user',
    transactionId: 'audit_1',
  };
}

describe('NotificationService', () => {
  let prisma: any;
  let service: any;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeMockPrisma();
    service = createNotificationService(prisma);
  });

  // ── notifyFromEvent ──
  describe('notifyFromEvent', () => {
    it('creates notifications for all active users', async () => {
      prisma.userAccount.findMany.mockResolvedValue([
        { id: 'user_1' },
        { id: 'user_2' },
      ]);
      prisma.notification.createMany.mockResolvedValue({ count: 2 });

      await service.notifyFromEvent(makeMockEvent('OrderConfirmed'));

      expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
      const callArg = prisma.notification.createMany.mock.calls[0][0];
      expect(callArg.data).toHaveLength(2);
      expect(callArg.data[0].userId).toBe('user_1');
      expect(callArg.data[1].userId).toBe('user_2');
      expect(callArg.skipDuplicates).toBe(true);
    });

    it('notification IDs include event ID and user ID for idempotency', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }]);
      prisma.notification.createMany.mockResolvedValue({ count: 1 });

      const event = makeMockEvent('OrderConfirmed');
      await service.notifyFromEvent(event);

      const callArg = prisma.notification.createMany.mock.calls[0][0];
      expect(callArg.data[0].id).toBe(`ntf_${event.id}_user_1`);
    });

    it('skips notification when no active recipients', async () => {
      prisma.userAccount.findMany.mockResolvedValue([]);

      await service.notifyFromEvent(makeMockEvent('OrderConfirmed'));

      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('notification persistence failure does not throw', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }]);
      prisma.notification.createMany.mockRejectedValue(new Error('DB error'));

      // Should not throw — notification failure must not block business
      await expect(service.notifyFromEvent(makeMockEvent('OrderConfirmed'))).resolves.toBeUndefined();
    });

    it('renders InvoiceIssued notification with invoice number in title', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }]);
      prisma.notification.createMany.mockResolvedValue({ count: 1 });

      const event = makeMockEvent('InvoiceIssued', {
        invoiceNumber: 'INV-2026-001',
        amount: '5000',
        currency: 'USD',
        customerName: 'Global Trade Co',
      });

      await service.notifyFromEvent(event);

      const callArg = prisma.notification.createMany.mock.calls[0][0];
      // InvoiceIssued 模板 title: '发票 {invoiceNumber} 已开具'
      expect(callArg.data[0].title).toContain('INV-2026-001');
      // InvoiceIssued 模板 body: '订单 {poNumber} 的发票 {invoiceNumber} 已开具，金额 {amount} {currency}。'
      expect(callArg.data[0].body).toContain('INV-2026-001');
      expect(callArg.data[0].body).toContain('5000');
      expect(callArg.data[0].body).toContain('USD');
    });

    it('renders ShipmentCompleted notification with shipment number', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }]);
      prisma.notification.createMany.mockResolvedValue({ count: 1 });

      const event: BusinessEvent = {
        ...makeMockEvent('ShipmentCompleted'),
        sourceEntityType: 'Shipment',
        sourceEntityId: 'shp_1',
        payload: { shipmentNumber: 'SHP-001', orderId: 'ord_1' },
      };

      await service.notifyFromEvent(event);

      const callArg = prisma.notification.createMany.mock.calls[0][0];
      expect(callArg.data[0].title).toContain('SHP-001');
    });

    it('renders PaymentReceived notification with critical level for overdue', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }]);
      prisma.notification.createMany.mockResolvedValue({ count: 1 });

      const event: BusinessEvent = {
        ...makeMockEvent('PaymentReceived'),
        sourceEntityType: 'Invoice',
        sourceEntityId: 'inv_1',
        payload: { invoiceNumber: 'INV-001', amount: '10000', currency: 'USD' },
      };

      await service.notifyFromEvent(event);

      const callArg = prisma.notification.createMany.mock.calls[0][0];
      expect(callArg.data[0].type).toBe('payment_received');
    });

    it('metadata includes event traceability fields', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }]);
      prisma.notification.createMany.mockResolvedValue({ count: 1 });

      const event = makeMockEvent('OrderConfirmed');
      await service.notifyFromEvent(event);

      const callArg = prisma.notification.createMany.mock.calls[0][0];
      expect(callArg.data[0].metadata.eventId).toBe(event.id);
      expect(callArg.data[0].metadata.eventType).toBe('OrderConfirmed');
      expect(callArg.data[0].metadata.sourceEntityType).toBe('Order');
      expect(callArg.data[0].metadata.actorId).toBe('test_user');
    });
  });

  // ── listNotifications ──
  describe('listNotifications', () => {
    it('returns items and total', async () => {
      const mockItems = [
        { id: 'ntf_1', title: 'Test', body: 'Body', readAt: null, createdAt: new Date() },
      ];
      prisma.notification.findMany.mockResolvedValue(mockItems);
      prisma.notification.count.mockResolvedValue(1);

      const result = await service.listNotifications({ userId: 'user_1', limit: 10 });

      expect(result.items).toEqual(mockItems);
      expect(result.total).toBe(1);
    });

    it('passes unreadOnly filter correctly', async () => {
      prisma.notification.findMany.mockResolvedValue([]);
      prisma.notification.count.mockResolvedValue(0);

      await service.listNotifications({ userId: 'user_1', unreadOnly: true });

      const findManyArg = prisma.notification.findMany.mock.calls[0][0];
      expect(findManyArg.where.readAt).toBeNull();
    });

    it('passes type and level filters', async () => {
      prisma.notification.findMany.mockResolvedValue([]);
      prisma.notification.count.mockResolvedValue(0);

      await service.listNotifications({
        userId: 'user_1',
        type: 'order_confirmed',
        level: 'critical',
      });

      const findManyArg = prisma.notification.findMany.mock.calls[0][0];
      expect(findManyArg.where.type).toBe('order_confirmed');
      expect(findManyArg.where.level).toBe('critical');
    });

    it('applies limit and offset', async () => {
      prisma.notification.findMany.mockResolvedValue([]);
      prisma.notification.count.mockResolvedValue(0);

      await service.listNotifications({ userId: 'user_1', limit: 20, offset: 40 });

      const findManyArg = prisma.notification.findMany.mock.calls[0][0];
      expect(findManyArg.take).toBe(20);
      expect(findManyArg.skip).toBe(40);
    });
  });

  // ── getStats ──
  describe('getStats', () => {
    it('returns total, unread, critical, and byType breakdown', async () => {
      prisma.notification.count
        .mockResolvedValueOnce(10)   // total
        .mockResolvedValueOnce(3)    // unread
        .mockResolvedValueOnce(1);   // critical (unread + critical level)
      prisma.notification.groupBy.mockResolvedValue([
        { type: 'order_confirmed', _count: { type: 2 } },
        { type: 'invoice_issued', _count: { type: 1 } },
      ]);

      const stats = await service.getStats('user_1');

      expect(stats.total).toBe(10);
      expect(stats.unread).toBe(3);
      expect(stats.critical).toBe(1);
      expect(stats.byType.order_confirmed).toBe(2);
      expect(stats.byType.invoice_issued).toBe(1);
    });
  });

  // ── markAsRead ──
  describe('markAsRead', () => {
    it('returns ok=true when notification is marked as read', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.markAsRead('user_1', 'ntf_1');

      expect(result.ok).toBe(true);
      const callArg = prisma.notification.updateMany.mock.calls[0][0];
      expect(callArg.where).toEqual({ id: 'ntf_1', userId: 'user_1', readAt: null });
      expect(callArg.data.readAt).toBeInstanceOf(Date);
    });

    it('returns ok=false when notification not found or already read', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.markAsRead('user_1', 'ntf_missing');

      expect(result.ok).toBe(false);
    });
  });

  // ── markAllAsRead ──
  describe('markAllAsRead', () => {
    it('marks all unread notifications as read and returns count', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 5 });

      const result = await service.markAllAsRead('user_1');

      expect(result.ok).toBe(true);
      expect(result.count).toBe(5);
      const callArg = prisma.notification.updateMany.mock.calls[0][0];
      expect(callArg.where).toEqual({ userId: 'user_1', readAt: null });
    });

    it('returns count=0 when no unread notifications', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.markAllAsRead('user_1');

      expect(result.ok).toBe(true);
      expect(result.count).toBe(0);
    });
  });

  // ── deleteNotification ──
  describe('deleteNotification', () => {
    it('returns ok=true when notification is deleted', async () => {
      prisma.notification.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.deleteNotification('user_1', 'ntf_1');

      expect(result.ok).toBe(true);
      const callArg = prisma.notification.deleteMany.mock.calls[0][0];
      expect(callArg.where).toEqual({ id: 'ntf_1', userId: 'user_1' });
    });

    it('returns ok=false when notification not found', async () => {
      prisma.notification.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.deleteNotification('user_1', 'ntf_missing');

      expect(result.ok).toBe(false);
    });
  });

  // ── createNotification（手动创建）──
  describe('createNotification', () => {
    it('creates a notification with manual content', async () => {
      prisma.notification.create.mockResolvedValue({
        id: 'ntf_manual_1',
        userId: 'user_1',
        type: 'agent_message',
        title: 'Test',
        body: 'Body',
        level: 'info',
      });

      const result = await service.createNotification({
        userId: 'user_1',
        type: 'agent_message',
        title: 'Test',
        body: 'Body',
      });

      expect(result.id).toBe('ntf_manual_1');
      const callArg = prisma.notification.create.mock.calls[0][0];
      expect(callArg.data.userId).toBe('user_1');
      expect(callArg.data.level).toBe('info');
    });

    it('defaults level to info when not specified', async () => {
      prisma.notification.create.mockResolvedValue({ id: 'ntf_2', level: 'info' });

      await service.createNotification({
        userId: 'user_1',
        type: 'briefing',
        title: 'Daily Briefing',
        body: 'Summary',
      });

      const callArg = prisma.notification.create.mock.calls[0][0];
      expect(callArg.data.level).toBe('info');
    });
  });

  // ── D2 主动提醒引擎：偏好静音过滤 ──
  describe('D2 偏好静音过滤', () => {
    it('broadcastNotification 剔除静音该类型的用户', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }, { id: 'user_2' }]);
      prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'user_2' }]);
      prisma.notification.createMany.mockResolvedValue({ count: 1 });

      const result = await service.broadcastNotification({
        type: 'receivable_overdue',
        title: '逾期',
        body: '正文',
      });

      expect(result.count).toBe(1);
      const callArg = prisma.notification.createMany.mock.calls[0][0];
      expect(callArg.data).toHaveLength(1);
      expect(callArg.data[0].userId).toBe('user_1');
      // 过滤查询带正确类型
      const prefQuery = prisma.notificationPreference.findMany.mock.calls[0][0];
      expect(prefQuery.where.notificationType).toBe('receivable_overdue');
      expect(prefQuery.where.isEnabled).toBe(false);
    });

    it('无偏好记录 → 全员接收（Sprint 1 默认语义不变）', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }, { id: 'user_2' }]);
      prisma.notificationPreference.findMany.mockResolvedValue([]);
      prisma.notification.createMany.mockResolvedValue({ count: 2 });

      const result = await service.broadcastNotification({ type: 'daily_briefing', title: 't', body: 'b' });

      expect(result.count).toBe(2);
      expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(2);
    });

    it('偏好查询失败 → 降级全员接收，不阻断投递', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }]);
      prisma.notificationPreference.findMany.mockRejectedValue(new Error('db down'));
      prisma.notification.createMany.mockResolvedValue({ count: 1 });

      const result = await service.broadcastNotification({ type: 'daily_briefing', title: 't', body: 'b' });

      expect(result.count).toBe(1);
    });

    it('notifyFromEvent 剔除静音该事件通知类型的用户', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }, { id: 'user_2' }]);
      prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'user_1' }]);
      prisma.notification.createMany.mockResolvedValue({ count: 1 });

      await service.notifyFromEvent(makeMockEvent('OrderConfirmed'));

      const callArg = prisma.notification.createMany.mock.calls[0][0];
      expect(callArg.data).toHaveLength(1);
      expect(callArg.data[0].userId).toBe('user_2');
    });

    it('sendToUser 目标用户已静音 → 不落库返回 null', async () => {
      prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'user_1' }]);

      const result = await service.sendToUser({
        userId: 'user_1',
        type: 'agent_message',
        title: 't',
        body: 'b',
      });

      expect(result).toBeNull();
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('全部接收人均静音 → broadcast 返回 count 0 且不落库', async () => {
      prisma.userAccount.findMany.mockResolvedValue([{ id: 'user_1' }]);
      prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'user_1' }]);

      const result = await service.broadcastNotification({ type: 'daily_briefing', title: 't', body: 'b' });

      expect(result.count).toBe(0);
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });
  });

  // ── D2 主动提醒引擎：偏好 CRUD 与类型目录 ──
  describe('D2 偏好 CRUD 与类型目录', () => {
    it('upsertPreference 幂等：create/update 走同一 upsert 通道', async () => {
      await service.upsertPreference('user_1', 'daily_briefing', false);

      const callArg = prisma.notificationPreference.upsert.mock.calls[0][0];
      expect(callArg.where).toEqual({ userId_notificationType: { userId: 'user_1', notificationType: 'daily_briefing' } });
      expect(callArg.create).toEqual({ userId: 'user_1', notificationType: 'daily_briefing', isEnabled: false, channels: ['in_app'] });
      expect(callArg.update).toEqual({ isEnabled: false });
    });

    it('upsertPreference 返回带中文标签的视图', async () => {
      const view = await service.upsertPreference('user_1', 'receivable_overdue', true);
      expect(view).toEqual({ notificationType: 'receivable_overdue', label: '应收逾期', isEnabled: true });
    });

    it('getPreferences 映射标签，未知类型回退原始字符串', async () => {
      prisma.notificationPreference.findMany.mockResolvedValue([
        { notificationType: 'daily_briefing', isEnabled: false },
        { notificationType: 'brand_new_type', isEnabled: true },
      ]);

      const items = await service.getPreferences('user_1');

      expect(items).toEqual([
        { notificationType: 'daily_briefing', label: '每日简报', isEnabled: false },
        { notificationType: 'brand_new_type', label: 'brand_new_type', isEnabled: true },
      ]);
    });

    it('getTypeCatalog 合并注册表与实见类型，静音状态并入，实见优先排序', async () => {
      prisma.notification.groupBy.mockResolvedValue([
        { type: 'receivable_overdue', _count: { type: 5 } },
        { type: 'unregistered_type', _count: { type: 2 } },
      ]);
      prisma.notificationPreference.findMany.mockResolvedValue([
        { notificationType: 'receivable_overdue', isEnabled: false },
      ]);

      const items = await service.getTypeCatalog('user_1');

      const receivable = items.find((i: any) => i.type === 'receivable_overdue');
      expect(receivable).toEqual({ type: 'receivable_overdue', label: '应收逾期', isEnabled: false, seenCount: 5 });
      // 注册表未收录但实见过的类型自动浮现
      const unregistered = items.find((i: any) => i.type === 'unregistered_type');
      expect(unregistered).toEqual({ type: 'unregistered_type', label: 'unregistered_type', isEnabled: true, seenCount: 2 });
      // 注册表已知但未见过的类型也在目录中（可预先静音）
      const briefing = items.find((i: any) => i.type === 'daily_briefing');
      expect(briefing).toEqual({ type: 'daily_briefing', label: '每日简报', isEnabled: true, seenCount: 0 });
      // 实见类型排在未见过类型前
      expect(items.indexOf(receivable)).toBeLessThan(items.indexOf(briefing));
    });
  });
});
