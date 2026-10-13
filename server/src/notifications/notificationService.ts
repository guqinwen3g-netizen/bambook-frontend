/**
 * Phase 0 Sprint 1 — 通知服务（NotificationService）
 *
 * 设计目标：
 *   1. 接收 BusinessEvent，渲染通知内容，落库 Notification 表
 *   2. 多通道投递：站内（SSE 实时推送）+ 邮件（可选，未来 Push）
 *   3. 用户偏好：根据 NotificationPreference 决定通道（Sprint 1 默认 in_app）
 *   4. 接收人解析：单租户场景，所有 active 用户都收到（Phase 1+ 加细粒度路由）
 *
 * 不变量：
 *   - 通知失败永不阻断业务（持久化失败仅日志）
 *   - SSE 推送失败只影响实时性，不重试（落库已成功，用户刷新可见）
 *   - 邮件通道默认关闭，需 NotificationPreference 配置开启
 */

import { PrismaClient, Notification } from '@prisma/client';
import { BusinessEvent, BusinessEventType } from '../events/businessEventBus';
import { renderNotification, NotificationContent, NotificationLevel } from './notificationTemplateEngine';
import { publishNotificationEvent } from '../realtime';
import { logger } from '../lib/logger';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export type NotificationListParams = {
  userId: string;
  unreadOnly?: boolean;
  type?: string;
  level?: string;
  limit?: number;
  offset?: number;
};

export type NotificationStats = {
  total: number;
  unread: number;
  critical: number;
  byType: Record<string, number>;
};

// ────────────────────────────────────────────────────────────────
// D2 主动提醒引擎：类型目录 + 用户偏好（静音）
// ────────────────────────────────────────────────────────────────

/**
 * 已知通知类型的中文标签注册表。
 * 键与 scheduler/tasks/* 及 notificationTemplateEngine 实际使用的 type 字符串逐一核对；
 * 目录兜底为原始 type 字符串（未知类型自描述，不阻断）。
 */
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  // §10.3-11 跨账号协作通知（2026-09-12 接入）
  payment_request_submitted: '付款申请待审批',
  payment_request_decided: '付款申请已决议',
  payment_request_voucher_issued: '付款凭证已生成',
  approval_decided: '审批决议',
  pp_release_granted: '放行已批准',
  // §10.3-2 回款认领（业务员认领收款后通知财务复核）
  receipt_claimed: '回款认领待复核',

  // 调度器预警（scheduler/tasks/*）
  receivable_overdue: '应收逾期',
  inventory_alert: '库存预警',
  production_deadline: '生产超期',
  shipment_delay: '出运延误',
  tax_refund_stall: '退税滞留',
  tax_refund_deadline: '退税截止',
  lc_maturity: '信用证到期',
  lc_expiry: '信用证有效期',
  lc_shipment_deadline: '信用证装运截止',
  lc_presentation_deadline: '信用证交单截止',
  crm_follow_up_overdue: '跟进逾期',
  quotation_no_reply: '报价未回复',
  pp_sample_unconfirmed: '厂前样未确认',
  inspection_fail: '验货不合格',
  email_inquiry: '新询价邮件',
  hr_lifecycle: '人事生命周期',
  sample_deadline: '样品节点',
  factory_certification_expiring: '工厂认证到期',
  stuck_order: '订单卡滞',
  stuck_shipment: '发货卡滞',
  stuck_voucher: '凭证卡滞',
  daily_briefing: '每日简报',
  weekly_briefing: '每周简报',
  // 业务事件（notificationTemplateEngine）
  order_created: '订单创建',
  order_confirmed: '订单确认',
  quotation_issued: '报价发出',
  quotation_accepted: '报价接受',
  purchase_order_sent: '采购单发出',
  purchase_order_confirmed: '采购单确认',
  material_received: '物料入库',
  order_status_changed: '订单状态变更',
  production_stage_advanced: '生产阶段推进',
  production_completed: '生产完成',
  shipment_created: '发货单创建',
  shipment_completed: '发货完成',
  shipment_status_changed: '发货状态变更',
  invoice_issued: '发票开具',
  invoice_cancelled: '发票作废',
  payment_voucher_created: '收付凭证创建',
  payment_received: '收款到账',
  allocation_reconciled: '核销完成',
  development_converted: '开发案转化',
  relation_onboarded: '客户建档',
  stock_low_alarm: '库存低位',
  stock_overstock_alarm: '库存超储',
  bom_confirmed: 'BOM 确认',
  bom_cost_calculated: 'BOM 成本核算',
  credit_limit_exceeded: '信用额度超限',
  agent_message: '智能体消息',
};

export type NotificationTypeCatalogItem = {
  type: string;
  label: string;
  /** 本人是否启用（默认 true；false = 静音，该类型不再为本人落库） */
  isEnabled: boolean;
  /** 本人历史收到过该类型的条数（0 表示目录仅来自注册表） */
  seenCount: number;
};

export type NotificationPreferenceView = {
  notificationType: string;
  label: string;
  isEnabled: boolean;
};

/**
 * 从候选接收人中剔除把该类型静音（isEnabled=false）的用户。
 * 未设偏好 = 默认启用（Sprint 1 语义不变：全员接收）。
 */
export async function filterMutedRecipients(
  prisma: PrismaClient,
  userIds: string[],
  type: string,
): Promise<string[]> {
  if (userIds.length === 0) return userIds;
  try {
    const muted = await prisma.notificationPreference.findMany({
      where: { notificationType: type, isEnabled: false, userId: { in: userIds } },
      select: { userId: true },
    });
    if (muted.length === 0) return userIds;
    const mutedSet = new Set(muted.map((m) => m.userId));
    return userIds.filter((id) => !mutedSet.has(id));
  } catch (e: any) {
    // 偏好查询失败不阻断通知投递（降级为全员接收）
    logger.error('[NotificationService] filterMutedRecipients failed', { error: e?.message, type });
    return userIds;
  }
}

// ────────────────────────────────────────────────────────────────
// 通知服务
// ────────────────────────────────────────────────────────────────

export interface NotificationService {
  /** 从业务事件生成通知并落库（订阅 businessEventBus 调用） */
  notifyFromEvent(event: BusinessEvent): Promise<void>;
  /** 直接创建并落库一条通知 */
  createNotification(params: {
    userId: string;
    type: string;
    title: string;
    body: string;
    level?: 'info' | 'warning' | 'critical';
    link?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Notification>;
  /** 广播通知给所有 active 用户（用于调度器 briefing / 卡滞告警） */
  broadcastNotification(params: {
    type: string;
    title: string;
    body: string;
    level?: 'info' | 'warning' | 'critical';
    link?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ count: number }>;
  /** 发送给指定用户（创建 + SSE 实时推送） */
  sendToUser(params: {
    userId: string;
    type: string;
    title: string;
    body: string;
    level?: 'info' | 'warning' | 'critical';
    link?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Notification | null>;
  /** 发送给指定角色的所有用户（按 UserRole 关联查找） */
  broadcastToRole(params: {
    role: string;
    type: string;
    title: string;
    body: string;
    level?: 'info' | 'warning' | 'critical';
    link?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ count: number }>;
  /** 列出用户的通知 */
  listNotifications(params: NotificationListParams): Promise<{ items: Notification[]; total: number }>;
  /** 获取未读统计 */
  getStats(userId: string): Promise<NotificationStats>;
  /** 标记单条已读 */
  markAsRead(userId: string, notificationId: string): Promise<{ ok: boolean }>;
  /** 标记全部已读 */
  markAllAsRead(userId: string): Promise<{ ok: boolean; count: number }>;
  /** 删除通知（仅本人） */
  deleteNotification(userId: string, notificationId: string): Promise<{ ok: boolean }>;
  /** PRD 7.1：忽略通知（必填原因，用于推送准确率优化）；忽略同时视为已读并从默认列表移除 */
  dismissNotification(userId: string, notificationId: string, reason: string): Promise<{ ok: boolean }>;
  /** D2：列出本人通知类型偏好 */
  getPreferences(userId: string): Promise<NotificationPreferenceView[]>;
  /** D2：设置某类型对本人的启用/静音（幂等 upsert） */
  upsertPreference(userId: string, notificationType: string, isEnabled: boolean): Promise<NotificationPreferenceView>;
  /** D2：类型目录 = 注册表已知类型 ∪ 本人实际收到过的类型，合并本人启用状态 */
  getTypeCatalog(userId: string): Promise<NotificationTypeCatalogItem[]>;
}

// ────────────────────────────────────────────────────────────────
// 工厂函数：创建 NotificationService 实例
// ────────────────────────────────────────────────────────────────

export function createNotificationService(prisma: PrismaClient): NotificationService {
  return {
    async notifyFromEvent(event: BusinessEvent): Promise<void> {
      try {
        const content = renderNotification(event);
        // 接收人解析：单租户场景，所有 active 用户都收到
        // Phase 1+ 可改为按事件类型+订单关联人细粒度路由
        const recipients = await filterMutedRecipients(
          prisma,
          await resolveRecipients(prisma, event),
          content.type,
        );
        if (recipients.length === 0) {
          logger.warn('[NotificationService] no recipients for event', {
            eventType: event.type,
            eventId: event.id,
          });
          return;
        }

        // 批量创建通知记录
        const created = await prisma.notification.createMany({
          data: recipients.map((userId) => ({
            id: `ntf_${event.id}_${userId}`,
            userId,
            type: content.type,
            title: content.title,
            body: content.body,
            level: content.level,
            link: content.link ?? null,
            metadata: {
              eventId: event.id,
              eventType: event.type,
              sourceEntityType: event.sourceEntityType,
              sourceEntityId: event.sourceEntityId,
              orderId: event.orderId ?? null,
              actorId: event.actorId,
              occurredAt: event.occurredAt,
            } as any,
          })),
          skipDuplicates: true,  // 幂等：相同 event.id+userId 不重复创建
        });

        if (created.count > 0) {
          // SSE 推送给所有在线客户端
          publishNotificationEvent({
            type: content.type,
            title: content.title,
            body: content.body,
            level: content.level,
            link: content.link,
            eventId: event.id,
            eventType: event.type,
            orderId: event.orderId,
            recipientIds: recipients,
          });
          logger.info('[NotificationService] notifications delivered', {
            eventType: event.type,
            eventId: event.id,
            recipients: recipients.length,
          });
        }
      } catch (e: any) {
        // 通知失败永不阻断业务
        logger.error('[NotificationService] notifyFromEvent failed', {
          error: e?.message,
          eventType: event.type,
          eventId: event.id,
        });
      }
    },

    async createNotification(params): Promise<Notification> {
      const id = `ntf_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return prisma.notification.create({
        data: {
          id,
          userId: params.userId,
          type: params.type,
          title: params.title,
          body: params.body,
          level: params.level ?? 'info',
          link: params.link ?? null,
          metadata: (params.metadata as any) ?? null,
        },
      });
    },

    async broadcastNotification(params): Promise<{ count: number }> {
      const recipients = await filterMutedRecipients(
        prisma,
        await resolveRecipients(prisma, null as any),
        params.type,
      );
      if (recipients.length === 0) {
        logger.warn('[NotificationService] broadcast: no active recipients');
        return { count: 0 };
      }
      const baseId = `ntf_brd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const created = await prisma.notification.createMany({
        data: recipients.map((userId) => ({
          id: `${baseId}_${userId}`,
          userId,
          type: params.type,
          title: params.title,
          body: params.body,
          level: params.level ?? 'info',
          link: params.link ?? null,
          metadata: (params.metadata as any) ?? null,
        })),
        skipDuplicates: true,
      });
      // SSE 推送
      publishNotificationEvent({
        type: params.type,
        title: params.title,
        body: params.body,
        level: params.level ?? 'info',
        link: params.link,
        eventId: baseId,
        eventType: params.type,
        recipientIds: recipients,
      });
      return { count: created.count };
    },

    async sendToUser(params): Promise<Notification | null> {
      try {
        // D2：用户已静音该类型 → 不落库（幂等语义：返回 null 与创建失败同路径，调用方本就不依赖返回值）
        const allowed = await filterMutedRecipients(prisma, [params.userId], params.type);
        if (allowed.length === 0) return null;
        const id = `ntf_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const notification = await prisma.notification.create({
          data: {
            id,
            userId: params.userId,
            type: params.type,
            title: params.title,
            body: params.body,
            level: params.level ?? 'info',
            link: params.link ?? null,
            metadata: (params.metadata as any) ?? null,
          },
        });
        // SSE 推送给该用户
        publishNotificationEvent({
          type: params.type,
          title: params.title,
          body: params.body,
          level: params.level ?? 'info',
          link: params.link,
          eventId: id,
          eventType: params.type,
          recipientIds: [params.userId],
        });
        return notification;
      } catch (e: any) {
        logger.error('[NotificationService] sendToUser failed', { error: e?.message, userId: params.userId });
        return null;
      }
    },

    async broadcastToRole(params): Promise<{ count: number }> {
      try {
        // 查找拥有该角色的所有 active 用户
        const usersWithRole = await prisma.userRole.findMany({
          where: { role: { name: params.role } },
          select: { userId: true },
        });
        const userIds = [...new Set(usersWithRole.map(ur => ur.userId))];
        const allowedIds = await filterMutedRecipients(prisma, userIds, params.type);
        if (allowedIds.length === 0) {
          logger.warn('[NotificationService] broadcastToRole: no users with role', { role: params.role });
          return { count: 0 };
        }
        const baseId = `ntf_role_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const created = await prisma.notification.createMany({
          data: allowedIds.map((userId) => ({
            id: `${baseId}_${userId}`,
            userId,
            type: params.type,
            title: params.title,
            body: params.body,
            level: params.level ?? 'info',
            link: params.link ?? null,
            metadata: (params.metadata as any) ?? null,
          })),
          skipDuplicates: true,
        });
        // SSE 推送
        publishNotificationEvent({
          type: params.type,
          title: params.title,
          body: params.body,
          level: params.level ?? 'info',
          link: params.link,
          eventId: baseId,
          eventType: params.type,
          recipientIds: allowedIds,
        });
        logger.info('[NotificationService] broadcastToRole delivered', { role: params.role, recipients: allowedIds.length });
        return { count: created.count };
      } catch (e: any) {
        logger.error('[NotificationService] broadcastToRole failed', { error: e?.message, role: params.role });
        return { count: 0 };
      }
    },

    async listNotifications(params): Promise<{ items: Notification[]; total: number }> {
      const { userId, unreadOnly, type, level, limit = 50, offset = 0 } = params;
      const where: Record<string, unknown> = { userId, dismissedAt: null }; // 已忽略通知退出默认列表
      if (unreadOnly) where.readAt = null;
      if (type) where.type = type;
      if (level) where.level = level;

      const [items, total] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.notification.count({ where }),
      ]);
      return { items, total };
    },

    async getStats(userId: string): Promise<NotificationStats> {
      const [total, unread, critical, byTypeRaw] = await Promise.all([
        prisma.notification.count({ where: { userId } }),
        prisma.notification.count({ where: { userId, readAt: null } }),
        prisma.notification.count({ where: { userId, readAt: null, level: 'critical' } }),
        prisma.notification.groupBy({
          by: ['type'],
          where: { userId, readAt: null },
          _count: { type: true },
        }),
      ]);
      const byType: Record<string, number> = {};
      for (const row of byTypeRaw) {
        byType[row.type] = row._count.type;
      }
      return { total, unread, critical, byType };
    },

    async markAsRead(userId: string, notificationId: string): Promise<{ ok: boolean }> {
      const result = await prisma.notification.updateMany({
        where: { id: notificationId, userId, readAt: null },
        data: { readAt: new Date() },
      });
      return { ok: result.count > 0 };
    },

    async markAllAsRead(userId: string): Promise<{ ok: boolean; count: number }> {
      const result = await prisma.notification.updateMany({
        where: { userId, readAt: null },
        data: { readAt: new Date() },
      });
      return { ok: true, count: result.count };
    },

    async deleteNotification(userId: string, notificationId: string): Promise<{ ok: boolean }> {
      const result = await prisma.notification.deleteMany({
        where: { id: notificationId, userId },
      });
      return { ok: result.count > 0 };
    },

    async dismissNotification(userId: string, notificationId: string, reason: string): Promise<{ ok: boolean }> {
      const now = new Date();
      const result = await prisma.notification.updateMany({
        where: { id: notificationId, userId, dismissedAt: null },
        data: { dismissedAt: now, dismissReason: reason, readAt: now }, // 忽略即已读，退出未读统计与默认列表
      });
      return { ok: result.count > 0 };
    },

    async getPreferences(userId: string): Promise<NotificationPreferenceView[]> {
      const rows = await prisma.notificationPreference.findMany({
        where: { userId },
        orderBy: { notificationType: 'asc' },
      });
      return rows.map((r) => ({
        notificationType: r.notificationType,
        label: NOTIFICATION_TYPE_LABELS[r.notificationType] ?? r.notificationType,
        isEnabled: r.isEnabled,
      }));
    },

    async upsertPreference(
      userId: string,
      notificationType: string,
      isEnabled: boolean,
    ): Promise<NotificationPreferenceView> {
      await prisma.notificationPreference.upsert({
        where: { userId_notificationType: { userId, notificationType } },
        create: { userId, notificationType, isEnabled, channels: ['in_app'] },
        update: { isEnabled },
      });
      return {
        notificationType,
        label: NOTIFICATION_TYPE_LABELS[notificationType] ?? notificationType,
        isEnabled,
      };
    },

    async getTypeCatalog(userId: string): Promise<NotificationTypeCatalogItem[]> {
      const [seen, prefs] = await Promise.all([
        prisma.notification.groupBy({
          by: ['type'],
          where: { userId },
          _count: { type: true },
        }),
        prisma.notificationPreference.findMany({
          where: { userId },
          select: { notificationType: true, isEnabled: true },
        }),
      ]);
      const seenMap = new Map(seen.map((s) => [s.type, s._count.type]));
      const prefMap = new Map(prefs.map((p) => [p.notificationType, p.isEnabled]));
      // 目录 = 注册表已知类型 ∪ 本人实际见过的类型（注册表未收录的新类型自动浮现）
      const types = new Set([...Object.keys(NOTIFICATION_TYPE_LABELS), ...seenMap.keys()]);
      return [...types]
        .sort((a, b) => {
          // 实际见过的排前面（按条数降序），其余按 type 字典序
          const diff = (seenMap.get(b) ?? 0) - (seenMap.get(a) ?? 0);
          return diff !== 0 ? diff : a.localeCompare(b);
        })
        .map((type) => ({
          type,
          label: NOTIFICATION_TYPE_LABELS[type] ?? type,
          isEnabled: prefMap.get(type) ?? true,
          seenCount: seenMap.get(type) ?? 0,
        }));
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 接收人解析
// ────────────────────────────────────────────────────────────────

/**
 * 解析事件的接收人列表。
 *
 * Sprint 1 策略（单租户 + Electron 桌面 + Mac Mini）：
 *   - 所有 active 状态的 UserAccount 都收到通知
 *   - 这符合小企业 ERP 实际：所有员工都看到业务动态
 *
 * Phase 1+ 增强方向：
 *   - 订单事件 → 订单的 salesPersonRelationId / merchandiserRelationId 对应的 UserAccount
 *   - 发票事件 → finance 角色 + 销售
 *   - 生产事件 → production_manager 角色
 *   - 通过 NotificationPreference 进一步过滤
 */
async function resolveRecipients(prisma: PrismaClient, _event: BusinessEvent): Promise<string[]> {
  try {
    const users = await prisma.userAccount.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    return users.map((u) => u.id);
  } catch (e: any) {
    logger.error('[NotificationService] resolveRecipients failed', { error: e?.message });
    return [];
  }
}

/**
 * R6 通知治理：单据软删后，回收 link 指向该单据的通知（否则点「前往」落空）。
 * 通知无 targetType/targetId 列，link 是唯一稳定锚（如 /shipments?id=SHP_xxx）；
 * 用 OR contains 匹配。调用方 best-effort：失败仅 logger.error，不影响删除主流程。
 */
export async function sweepNotificationsForDeletedEntities(prisma: PrismaClient, entityIds: string[]): Promise<number> {
  const ids = [...new Set(entityIds.filter((id): id is string => !!id?.trim()))];
  if (ids.length === 0) return 0;
  try {
    const result = await prisma.notification.deleteMany({
      where: {
        OR: ids.map((id) => ({ link: { contains: id } })),
      },
    });
    if (result.count > 0) {
      logger.info('[NotificationService] swept notifications for deleted entities', {
        ids, count: result.count,
      });
    }
    return result.count;
  } catch (e: any) {
    logger.error('[NotificationService] sweep failed (non-blocking)', { ids, error: e?.message });
    return 0;
  }
}
