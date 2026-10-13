import { Response } from 'express';
import { logger } from './lib/logger';

export interface DataChangeEvent {
  entity: string;
  action: string;
  ids?: string[];
  timestamp?: number;
}

// Phase 0 Sprint 1: 通知事件（业务事件触发，推送给前端 NotificationCenter）
export interface NotificationEvent {
  type: string;
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
  link?: string;
  eventId: string;
  eventType: string;
  orderId?: string;
  recipientIds: string[];
  /** Minimal navigation metadata; never include payload snapshots or amounts by default. */
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

interface RealtimeClient {
  res: Response;
  /** 建立 SSE 连接的用户；API-Key 连接（无 userId）为 null。 */
  userId: string | null;
}

const clients = new Set<RealtimeClient>();

/**
 * 注册一个 SSE 客户端。
 *
 * `userId` 用于通知类事件的**按人投递**——2026-09-15 前 `publishNotificationEvent`
 * 是**全员广播**，事件里的 `recipientIds` 完全没被使用；而 REST 侧 `/v1/notifications`
 * 又是严格按 `actor.userId` 隔离的。同一份数据两套口径 ⇒ 任何在线用户都能收到
 * 发给别人的通知（含标题/正文/订单号/链接）。
 */
export function addRealtimeClient(res: Response, userId: string | null = null): () => void {
  const client: RealtimeClient = { res, userId };
  clients.add(client);
  res.write(`event: ready\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);

  return () => {
    clients.delete(client);
  };
}

/** 数据变更广播：只含 entity/action/ids（不含业务字段），全员可见是设计意图。 */
export function publishDataChange(event: DataChangeEvent) {
  const payload = JSON.stringify({ ...event, timestamp: event.timestamp ?? Date.now() });
  for (const client of clients) {
    try {
      client.res.write(`event: data-change\ndata: ${payload}\n\n`);
    } catch {
      // 客户端连接已断开，忽略
    }
  }
}

/**
 * Phase 0 Sprint 1: 向所有在线客户端推送通知事件。
 *
 * 前端 NotificationCenter 订阅 'notification' SSE 事件，收到后：
 *   1. 增加未读徽章计数
 *   2. 显示 toast 提醒
 *   3. 用户点击打开抽屉查看详情
 *
 * 注意：SSE 推送失败只影响实时性，不重试（落库已成功，用户刷新可见）。
 *
 * **投递口径（2026-09-15 收口）**：只推给 `recipientIds` 命中的在线用户，
 * 与 REST 侧"通知按人隔离"保持一致。
 *   - 无 userId 的连接（纯 API-Key）收不到通知事件（REST 侧同样要求 userId）；
 *   - `recipientIds` 为空视为调用方漏传，**丢弃并告警**（fail-closed）——
 *     宁可丢一条实时提醒，也不能把发给 A 的通知送到 B 的浏览器。
 */
export function publishNotificationEvent(event: NotificationEvent) {
  const recipients = new Set((event.recipientIds ?? []).filter(Boolean));
  if (recipients.size === 0) {
    logger.warn('[realtime] 通知缺少 recipientIds，已丢弃（避免全员广播泄露）', {
      type: event.type,
      eventId: event.eventId,
    });
    return;
  }
  const payload = JSON.stringify({ ...event, timestamp: event.timestamp ?? Date.now() });
  for (const client of clients) {
    if (!client.userId || !recipients.has(client.userId)) continue;
    try {
      client.res.write(`event: notification\ndata: ${payload}\n\n`);
    } catch {
      // 客户端连接已断开，忽略
    }
  }
}
