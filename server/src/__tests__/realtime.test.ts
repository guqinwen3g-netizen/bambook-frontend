import { describe, expect, it, vi } from 'vitest';
import {
    addRealtimeClient,
    publishDataChange,
    publishNotificationEvent,
    type NotificationEvent,
} from '../realtime';

/**
 * SSE 实时推送的投递口径（2026-09-15 收口）。
 *
 * 修复前：publishNotificationEvent **全员广播**，事件里的 recipientIds 从未被使用；
 * 而 REST 侧 /v1/notifications 严格按 actor.userId 隔离 ⇒ 任何在线用户都能收到
 * 发给别人的通知（标题/正文/订单号/链接）。
 * 本文件把「只推给收件人」这条边界钉死。
 */

function makeClient() {
    const chunks: string[] = [];
    const res = { write: vi.fn((s: string) => { chunks.push(s); return true; }) } as any;
    return { res, chunks, text: () => chunks.join('') };
}

const notif = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
    type: 'approval_request',
    title: '付款申请待审批',
    body: 'PO-2026-0001 的付款申请等待你审批',
    level: 'warning',
    link: '/finance/payments/1',
    eventId: 'evt_1',
    eventType: 'approval_request',
    recipientIds: ['u_alice'],
    ...over,
});

describe('realtime · 通知按人投递（非全员广播）', () => {
    it('只推给 recipientIds 命中的连接；非收件人一条都收不到', () => {
        const alice = makeClient();
        const bob = makeClient();
        const offA = addRealtimeClient(alice.res, 'u_alice');
        const offB = addRealtimeClient(bob.res, 'u_bob');

        publishNotificationEvent(notif({ recipientIds: ['u_alice'] }));

        expect(alice.text()).toContain('event: notification');
        expect(alice.text()).toContain('付款申请待审批');
        expect(bob.text()).not.toContain('event: notification');
        expect(bob.text()).not.toContain('付款申请待审批');

        offA();
        offB();
    });

    it('多收件人：命中者各收一条，未命中者不收', () => {
        const a = makeClient();
        const b = makeClient();
        const c = makeClient();
        const offs = [
            addRealtimeClient(a.res, 'u_a'),
            addRealtimeClient(b.res, 'u_b'),
            addRealtimeClient(c.res, 'u_c'),
        ];

        publishNotificationEvent(notif({ recipientIds: ['u_a', 'u_c'] }));

        const count = (x: ReturnType<typeof makeClient>) =>
            x.chunks.filter((s) => s.startsWith('event: notification')).length;
        expect(count(a)).toBe(1);
        expect(count(b)).toBe(0);
        expect(count(c)).toBe(1);
        offs.forEach((off) => off());
    });

    it('无 userId 的连接（纯 API-Key）收不到通知，与 REST 侧要求 userId 一致', () => {
        const anon = makeClient();
        const off = addRealtimeClient(anon.res, null);
        publishNotificationEvent(notif({ recipientIds: ['u_alice'] }));
        expect(anon.text()).not.toContain('event: notification');
        off();
    });

    it('recipientIds 为空 → 丢弃并告警（fail-closed，绝不退化成广播）', () => {
        const a = makeClient();
        const b = makeClient();
        const offs = [addRealtimeClient(a.res, 'u_a'), addRealtimeClient(b.res, 'u_b')];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        publishNotificationEvent(notif({ recipientIds: [] }));

        expect(a.text()).not.toContain('event: notification');
        expect(b.text()).not.toContain('event: notification');
        offs.forEach((off) => off());
        warn.mockRestore();
    });

    it('断开连接后不再收到事件', () => {
        const c = makeClient();
        const off = addRealtimeClient(c.res, 'u_a');
        off();
        publishNotificationEvent(notif({ recipientIds: ['u_a'] }));
        expect(c.text()).not.toContain('event: notification');
    });
});

describe('realtime · 数据变更仍是广播（设计意图）', () => {
    it('data-change 全体在线连接都收到（只含 entity/action/ids）', () => {
        const a = makeClient();
        const b = makeClient();
        const offs = [addRealtimeClient(a.res, 'u_a'), addRealtimeClient(b.res, null)];

        publishDataChange({ entity: 'orders', action: 'update', ids: ['ORD__1'] });

        expect(a.text()).toContain('event: data-change');
        expect(b.text()).toContain('event: data-change');
        expect(a.text()).toContain('ORD__1');
        offs.forEach((off) => off());
    });

    it('ready 事件在建立连接时立即下发', () => {
        const c = makeClient();
        const off = addRealtimeClient(c.res, 'u_a');
        expect(c.text()).toContain('event: ready');
        off();
    });
});
