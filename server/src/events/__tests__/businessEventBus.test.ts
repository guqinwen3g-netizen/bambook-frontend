/**
 * BusinessEventBus 单元测试
 *
 * 覆盖：
 *   1. publish + subscribe（特定事件 + 通配符）
 *   2. 持久化到 AgentJob（正常 / 重复 P2002 / 非 P2002 错误）
 *   3. registerLinkage 幂等性（相同 idempotencyKey 不重复执行）
 *   4. 事件发布失败永不阻断业务主流程
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { businessEventBus, publishBusinessEvent, generateEventId, BusinessEvent } from '../businessEventBus';

describe('BusinessEventBus', () => {
  beforeEach(() => {
    businessEventBus.reset();
  });

  // ── publish + subscribe ──
  describe('publish + subscribe', () => {
    it('subscriber receives event after publish', async () => {
      const received: BusinessEvent[] = [];
      businessEventBus.subscribe('OrderConfirmed', (event) => {
        received.push(event as BusinessEvent);
      });

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        orderId: 'ord_1',
        payload: { poNumber: 'PO-001', customerName: 'ACME' },
        actorId: 'test',
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('OrderConfirmed');
      expect(received[0].orderId).toBe('ord_1');
      expect(received[0].payload).toEqual({ poNumber: 'PO-001', customerName: 'ACME' });
    });

    it('wildcard subscriber receives all event types', async () => {
      const received: BusinessEvent[] = [];
      businessEventBus.subscribe('*', (event) => {
        received.push(event as BusinessEvent);
      });

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await publishBusinessEvent({
        type: 'InvoiceIssued',
        sourceEntityType: 'Invoice',
        sourceEntityId: 'inv_1',
        payload: {},
        actorId: 'test',
      });

      expect(received).toHaveLength(2);
      expect(received[0].type).toBe('OrderConfirmed');
      expect(received[1].type).toBe('InvoiceIssued');
    });

    it('unsubscribe stops receiving events', async () => {
      const received: BusinessEvent[] = [];
      const unsubscribe = businessEventBus.subscribe('OrderConfirmed', (event) => {
        received.push(event as BusinessEvent);
      });
      unsubscribe();

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: {},
        actorId: 'test',
      });

      expect(received).toHaveLength(0);
    });

    it('subscriber handler failure does not affect other subscribers', async () => {
      const secondReceived: BusinessEvent[] = [];
      businessEventBus.subscribe('OrderConfirmed', () => {
        throw new Error('subscriber crash');
      });
      businessEventBus.subscribe('OrderConfirmed', (event) => {
        secondReceived.push(event as BusinessEvent);
      });

      // publish should not throw even if a subscriber crashes
      await expect(publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: {},
        actorId: 'test',
      })).resolves.toBeUndefined();

      expect(secondReceived).toHaveLength(1);
    });
  });

  // ── 持久化（AgentJob）──
  describe('persistence (AgentJob)', () => {
    it('persists event to AgentJob when prisma is set', async () => {
      const createMock = vi.fn().mockResolvedValue({});
      businessEventBus.setPrisma({ agentJob: { create: createMock } } as any);

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: { poNumber: 'PO-001' },
        actorId: 'test',
        transactionId: 'audit_1',
      });

      expect(createMock).toHaveBeenCalledTimes(1);
      const callData = createMock.mock.calls[0][0].data;
      expect(callData.jobType).toBe('bev:OrderConfirmed');
      expect(callData.status).toBe('queued');
      expect(callData.priority).toBe(5);
      expect(callData.payload.type).toBe('OrderConfirmed');
      expect(callData.payload.transactionId).toBe('audit_1');
    });

    it('does not persist when prisma is not set', async () => {
      // No setPrisma call — should still emit but skip persistence
      const received: BusinessEvent[] = [];
      businessEventBus.subscribe('OrderConfirmed', (e) => received.push(e as BusinessEvent));

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: {},
        actorId: 'test',
      });

      expect(received).toHaveLength(1);
    });

    it('duplicate event (P2002) is silently ignored', async () => {
      const createMock = vi.fn().mockRejectedValue({ code: 'P2002', message: 'Unique constraint failed' });
      businessEventBus.setPrisma({ agentJob: { create: createMock } } as any);

      await expect(publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: {},
        actorId: 'test',
      })).resolves.toBeUndefined();
    });

    it('non-duplicate persistence error does not throw (best-effort)', async () => {
      const createMock = vi.fn().mockRejectedValue(new Error('DB connection lost'));
      businessEventBus.setPrisma({ agentJob: { create: createMock } } as any);

      // Event publish failure must not fail business
      await expect(publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: {},
        actorId: 'test',
      })).resolves.toBeUndefined();
    });

    it('event is still emitted to subscribers even if persistence fails', async () => {
      const createMock = vi.fn().mockRejectedValue(new Error('DB down'));
      businessEventBus.setPrisma({ agentJob: { create: createMock } } as any);

      const received: BusinessEvent[] = [];
      businessEventBus.subscribe('OrderConfirmed', (e) => received.push(e as BusinessEvent));

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: {},
        actorId: 'test',
      });

      expect(received).toHaveLength(1);
    });
  });

  // ── registerLinkage（幂等性）──
  describe('registerLinkage (idempotency)', () => {
    it('linkage handler executes once per unique idempotencyKey', async () => {
      const executeMock = vi.fn().mockResolvedValue({ ok: true });
      businessEventBus.setPrisma({} as any);

      businessEventBus.registerLinkage({
        id: 'L1_test',
        eventType: 'OrderConfirmed',
        idempotencyKey: (e) => `auto:L1:${e.orderId}`,
        execute: executeMock,
      });

      const baseEvent = {
        type: 'OrderConfirmed' as const,
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      };

      // First publish — should execute
      await publishBusinessEvent(baseEvent);
      await new Promise(r => setTimeout(r, 50));

      // Second publish with same orderId — deduplicated
      await publishBusinessEvent({ ...baseEvent });
      await new Promise(r => setTimeout(r, 50));

      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it('different orderId triggers separate execution', async () => {
      const executeMock = vi.fn().mockResolvedValue({ ok: true });
      businessEventBus.setPrisma({} as any);

      businessEventBus.registerLinkage({
        id: 'L2_test',
        eventType: 'OrderConfirmed',
        idempotencyKey: (e) => `auto:L2:${e.orderId}`,
        execute: executeMock,
      });

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_2',
        orderId: 'ord_2',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(executeMock).toHaveBeenCalledTimes(2);
    });

    it('failed linkage allows retry (key removed from processed set)', async () => {
      const executeMock = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: 'downstream failed' })
        .mockResolvedValueOnce({ ok: true });
      businessEventBus.setPrisma({} as any);

      businessEventBus.registerLinkage({
        id: 'L3_retry',
        eventType: 'ShipmentCompleted',
        idempotencyKey: (e) => `auto:L3:${e.sourceEntityId}`,
        execute: executeMock,
      });

      // First attempt — fails
      await publishBusinessEvent({
        type: 'ShipmentCompleted',
        sourceEntityType: 'Shipment',
        sourceEntityId: 'shp_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      // Retry — should execute again (key was removed on failure)
      await publishBusinessEvent({
        type: 'ShipmentCompleted',
        sourceEntityType: 'Shipment',
        sourceEntityId: 'shp_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(executeMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── 事件 ID 生成 ──
  describe('generateEventId', () => {
    it('produces unique IDs with correct format', () => {
      const id1 = generateEventId('OrderConfirmed');
      const id2 = generateEventId('OrderConfirmed');

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^bev_OrderConfirmed_\d+_[a-z0-9]+$/);
    });

    it('sanitizes type with special characters', () => {
      // 'Order:Confirmed!' → 冒号和感叹号都替换为 '_'，连续特殊字符会产生连续下划线
      const id = generateEventId('Order:Confirmed!');
      expect(id).toMatch(/^bev_Order_Confirmed_+\d+_/);
    });
  });

  // ── stats ──
  describe('stats', () => {
    it('returns correct counts', async () => {
      businessEventBus.setPrisma({} as any);
      const executeMock = vi.fn().mockResolvedValue({ ok: true });
      businessEventBus.registerLinkage({
        id: 'L_stats',
        eventType: 'OrderConfirmed',
        idempotencyKey: (e) => `auto:S:${e.orderId}`,
        execute: executeMock,
      });

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      const s = businessEventBus.stats();
      expect(s.linkageHandlers).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('awaited recovery contract', () => {
  const event: BusinessEvent = { id: 'retry-event', type: 'OrderConfirmed', sourceEntityType: 'Order', sourceEntityId: 'order-1', payload: {}, actorId: 'test', occurredAt: Date.now() };
  beforeEach(() => { businessEventBus.reset(); businessEventBus.setPrisma({} as any); });
  it('reports async failure, retries only the failed linkage in this process', async () => {
    const success = vi.fn().mockResolvedValue({ ok: true });
    const flaky = vi.fn().mockResolvedValueOnce({ ok: false, error: 'db unavailable' }).mockResolvedValue({ ok: true });
    for (const [id, execute] of [['success', success], ['flaky', flaky]] as const) {
      businessEventBus.registerLinkage({ id, eventType: 'OrderConfirmed', idempotencyKey: () => 'same-business-key', execute });
    }
    expect(await businessEventBus.dispatch(event)).toEqual({ ok: false, errors: ['linkage flaky: db unavailable'] });
    expect((await businessEventBus.dispatch(event)).ok).toBe(true);
    expect(success).toHaveBeenCalledTimes(1);
    expect(flaky).toHaveBeenCalledTimes(2);
  });
  it('a concurrent duplicate waits for the actual consumer result rather than claiming success early', async () => {
    let release!: (value: { ok: boolean; error: string }) => void;
    const execute = vi.fn(() => new Promise<{ ok: boolean; error: string }>(resolve => { release = resolve; }));
    businessEventBus.registerLinkage({ id: 'slow', eventType: 'OrderConfirmed', idempotencyKey: e => e.id, execute });
    const first = businessEventBus.dispatch(event);
    const second = businessEventBus.dispatch(event);
    release({ ok: false, error: 'temporary failure' });
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
