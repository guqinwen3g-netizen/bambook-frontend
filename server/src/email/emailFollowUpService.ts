// ════════════════════════════════════════════════════════════════════
// Email Follow-up Service — C8 邮件深化：邮件 → 跟进任务自动化
// ════════════════════════════════════════════════════════════════════
// 用途：把一封已归档客户（relationId）的邮件一键/自动转为 CRM 跟进任务
// （FollowUpRecord，type='Email'），进入既有跟进逾期看门狗巡检闭环。
//
// 触发路径：
//   1. 手动：POST /api/v1/email/:id/create-followup（可覆写日期/主题/内容）
//   2. 自动：分类命中 complaint/urgent 且有客户链接时由分类端点联动调用
//
// 不变量：
//   - 幂等：notes 内含来源标记 `[email:<emailId>]`，同邮件重复调用返回已建记录（reused）
//   - 无客户链接（relationId 为空）拒绝自动创建——跟进必须挂在客户档案上
//   - 内容默认取 AI 摘要 → 主题兜底；下次跟进日取 AI 最早 deadline → 入参覆写优先
//   - 创建写审计；复用不写
// ════════════════════════════════════════════════════════════════════

import type { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import type { EmailExtractedPayload } from './aiExtract';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { businessNowMs } from '../shared/businessClock';
import { localDateKey } from '../shared/localDate';



export const EMAIL_FOLLOWUP_MARKER_PREFIX = '[email:';

export function emailFollowUpMarker(emailId: string): string {
  return `${EMAIL_FOLLOWUP_MARKER_PREFIX}${emailId}]`;
}

function localDateString(offsetDays = 0): string {
  return localDateKey(new Date(businessNowMs() + offsetDays * 24 * 60 * 60 * 1000));
}

/** 从 AI 抽取结果取最早的有效 deadline（YYYY-MM-DD），无则 null */
export function earliestDeadline(payload: EmailExtractedPayload | null | undefined): string | null {
  if (!payload?.deadlines?.length) return null;
  const valid = payload.deadlines
    .map(d => d.date)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return valid[0] ?? null;
}

export interface CreateFollowUpFromEmailResult {
  ok: boolean;
  reused?: boolean;
  followUpId?: string;
  nextFollowUpAt?: string | null;
  error?: 'NOT_FOUND' | 'NO_RELATION';
}

/**
 * 从邮件创建跟进任务（幂等）。
 * overrides 优先于 AI 推导；auto=true 表示分类联动自动触发（审计 source 区分）。
 */
export async function createFollowUpFromEmail(
  prisma: PrismaClient,
  emailId: string,
  opts: {
    actorId: string;
    source: string;
    overrides?: { content?: string; nextFollowUpAt?: string; nextFollowUpTopic?: string };
  },
): Promise<CreateFollowUpFromEmailResult> {
  const db = prisma as any;
  const email = await db.email.findUnique({ where: { id: emailId } });
  if (!email || email.deletedAt) return { ok: false, error: 'NOT_FOUND' };
  if (!email.relationId) return { ok: false, error: 'NO_RELATION' };

  // 幂等：同邮件已建过跟进 → 直接复用
  const marker = emailFollowUpMarker(emailId);
  const existing = await db.followUpRecord.findFirst({
    where: { deletedAt: null, notes: { contains: marker } },
  });
  if (existing) {
    return { ok: true, reused: true, followUpId: existing.id, nextFollowUpAt: existing.nextFollowUpAt ?? null };
  }

  const extracted = (email.aiExtractedJson ?? null) as EmailExtractedPayload | null;
  const content = opts.overrides?.content
    || extracted?.summary
    || email.aiSummary
    || `邮件：${email.subject}`;
  const nextFollowUpAt = opts.overrides?.nextFollowUpAt
    ?? earliestDeadline(extracted)
    ?? localDateString(1); // 默认明天，确保进入逾期巡检视野
  const nextFollowUpTopic = opts.overrides?.nextFollowUpTopic
    || extracted?.actionItems?.[0]
    || `回复邮件：${String(email.subject || '').slice(0, 80)}`;

  const now = BigInt(Date.now());
  const followUp = await db.followUpRecord.create({
    data: {
      id: `FU_${crypto.randomBytes(6).toString('base64url').toUpperCase()}`,
      relationId: email.relationId,
      type: 'Email',
      content: String(content).slice(0, 500),
      followUpAt: localDateString(0),
      nextFollowUpAt,
      nextFollowUpTopic: String(nextFollowUpTopic).slice(0, 200),
      orderId: email.orderId ?? null,
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
    operation: 'email_create_followup',
    targetType: 'FollowUpRecord',
    targetId: followUp.id,
    after: { emailId, relationId: email.relationId, nextFollowUpAt },
  });

  return { ok: true, reused: false, followUpId: followUp.id, nextFollowUpAt };
}

/**
 * 分类联动：邮件命中 complaint/urgent 且有客户链接时自动建跟进（幂等）。
 * 返回是否新建。分类服务不直接依赖本函数，由路由层编排（单向依赖）。
 */
export async function autoFollowUpForClassifiedEmail(
  prisma: PrismaClient,
  emailId: string,
  labels: string[],
  opts: { actorId: string; source: string },
): Promise<{ created: boolean; followUpId?: string }> {
  if (!labels.includes('complaint') && !labels.includes('urgent')) return { created: false };
  const result = await createFollowUpFromEmail(prisma, emailId, { actorId: opts.actorId, source: opts.source });
  if (!result.ok) return { created: false };
  return { created: !result.reused, followUpId: result.followUpId };
}
