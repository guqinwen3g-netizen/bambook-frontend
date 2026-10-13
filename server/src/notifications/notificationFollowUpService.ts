import { businessNowMs } from '../shared/businessClock';
// ════════════════════════════════════════════════════════════════════
// Notification Follow-up Service — D2 主动提醒引擎：通知 → 跟进任务闭环
// ════════════════════════════════════════════════════════════════════
// 用途：把一条业务预警通知（应收逾期 / 生产超期 / 出运延误等）一键转为
// CRM 跟进任务（FollowUpRecord，type='Other'），进入既有跟进逾期看门狗
// 巡检闭环——预警不止于「已读」，而是落到可追踪的后续动作。
//
// 不变量（与 C8 emailFollowUpService 同合约）：
//   - 幂等：notes 内含来源标记 `[notification:<notificationId>]`，重复调用
//     返回已建记录（reused）
//   - 跟进必须挂在客户档案上：relationId 解析链全部失败 → 409 NO_RELATION
//   - 通知必须属本人（防越权把他人通知转成自己的跟进）
//   - 创建写审计；复用不写
//
// relationId 解析链（按优先级）：
//   1. metadata.relationId（直接携带）
//   2. metadata.orderId → Order.customerRelationId（生产超期 / 订单卡滞等）
//   3. metadata.entityType='Invoice' + entityId → Invoice.orderId → Order
//      （应收逾期通知只带发票主键）
// ════════════════════════════════════════════════════════════════════

import type { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { writeRouteAuditLog } from '../audit/routeAudit';

export const NOTIFICATION_FOLLOWUP_MARKER_PREFIX = '[notification:';

export function notificationFollowUpMarker(notificationId: string): string {
  return `${NOTIFICATION_FOLLOWUP_MARKER_PREFIX}${notificationId}]`;
}

function localDateString(offsetDays = 0): string {
  const d = new Date(businessNowMs() + offsetDays * 24 * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface ConvertNotificationResult {
  ok: boolean;
  reused?: boolean;
  followUpId?: string;
  nextFollowUpAt?: string | null;
  error?: 'NOT_FOUND' | 'NO_RELATION';
}

/** 从通知 metadata 解析客户 relationId（三级链路，全失败返回 null） */
export async function resolveRelationIdFromMetadata(
  prisma: PrismaClient,
  metadata: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  if (!metadata) return null;
  const direct = metadata.relationId;
  if (typeof direct === 'string' && direct) return direct;

  const orderId = typeof metadata.orderId === 'string' && metadata.orderId
    ? metadata.orderId
    : null;
  if (orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerRelationId: true },
    });
    if (order?.customerRelationId) return order.customerRelationId;
  }

  if (metadata.entityType === 'Invoice' && typeof metadata.entityId === 'string' && metadata.entityId) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: metadata.entityId },
      select: { orderId: true },
    });
    if (invoice?.orderId) {
      const order = await prisma.order.findUnique({
        where: { id: invoice.orderId },
        select: { customerRelationId: true },
      });
      if (order?.customerRelationId) return order.customerRelationId;
    }
  }
  return null;
}

/**
 * 通知转跟进任务（幂等）。
 * 通知必须属 opts.actorId 本人；内容取通知标题+正文；下次跟进日默认明天
 * （确保进入 C1 跟进逾期巡检视野）。
 */
export async function convertNotificationToFollowUp(
  prisma: PrismaClient,
  notificationId: string,
  opts: { actorId: string; source: string },
): Promise<ConvertNotificationResult> {
  const db = prisma as any;
  const notification = await db.notification.findUnique({ where: { id: notificationId } });
  if (!notification || notification.userId !== opts.actorId) {
    return { ok: false, error: 'NOT_FOUND' };
  }

  // 幂等：同通知已建过跟进 → 直接复用
  const marker = notificationFollowUpMarker(notificationId);
  const existing = await db.followUpRecord.findFirst({
    where: { deletedAt: null, notes: { contains: marker } },
  });
  if (existing) {
    return { ok: true, reused: true, followUpId: existing.id, nextFollowUpAt: existing.nextFollowUpAt ?? null };
  }

  const metadata = (notification.metadata ?? null) as Record<string, unknown> | null;
  const relationId = await resolveRelationIdFromMetadata(prisma, metadata);
  if (!relationId) return { ok: false, error: 'NO_RELATION' };

  const content = `${notification.title} — ${notification.body}`;
  const nextFollowUpAt = localDateString(1);
  const orderId = typeof metadata?.orderId === 'string' && metadata.orderId ? metadata.orderId : null;

  const now = BigInt(Date.now());
  const followUp = await db.followUpRecord.create({
    data: {
      id: `FU_${crypto.randomBytes(6).toString('base64url').toUpperCase()}`,
      relationId,
      type: 'Other',
      content: String(content).slice(0, 500),
      followUpAt: localDateString(0),
      nextFollowUpAt,
      nextFollowUpTopic: String(notification.title).slice(0, 200),
      orderId,
      salesRepId: opts.actorId,
      notes: marker,
      createdAt: now,
      updatedAt: now,
    },
  });

  await writeRouteAuditLog({
    prisma,
    actorId: opts.actorId,
    source: opts.source,
    operation: 'notification_convert_followup',
    targetType: 'FollowUpRecord',
    targetId: followUp.id,
    after: { notificationId, relationId, nextFollowUpAt },
  });

  return { ok: true, reused: false, followUpId: followUp.id, nextFollowUpAt };
}
