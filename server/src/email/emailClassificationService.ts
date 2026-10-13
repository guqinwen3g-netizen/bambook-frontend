// ════════════════════════════════════════════════════════════════════
// Email Classification Service — C8 邮件深化：智能分类（规则 + AI 增强）
// ════════════════════════════════════════════════════════════════════
// 用途：为邮件计算业务标签（labels），两层口径：
//   1. 规则层（确定性、可解释、零成本）：发件人模式 + 主题关键词（中英双语）
//      + 归档链接状态；IMAP 同步路径内联执行，新邮件落库即带标签。
//   2. AI 增强层：复用 aiExtract 的 intent/customerSignal（已抽取则直接读，
//      未抽取可由端点触发抽取后再分类）。
//
// 标签值域（与 AI intent 值域对齐，Gmail-style 小写）：
//   inquiry | quotation | order | shipment_notice | invoice | complaint |
//   follow_up | urgent | risk | customer | bulk
//
// 不变量：
//   - 并集语义：只增不删，绝不覆盖用户手工标签（PATCH labels 是全量写，
//     分类合并发生在服务端，保证并发/重跑安全）。
//   - 幂等：重复分类结果相同，无变化则不写库、不写审计。
//   - 规则层不调用 LLM，可在同步/批量路径免费运行；AI 层仅在端点显式触发。
// ════════════════════════════════════════════════════════════════════

import type { PrismaClient } from '@prisma/client';
import { extractEmailAi, type EmailExtractedPayload, type LlmCompleter } from './aiExtract';
import { writeRouteAuditLog } from '../audit/routeAudit';

// ─── 规则层（纯函数） ────────────────────────────────────────────

/** 群发/机器发件特征：noreply 类地址、营销退订关键词 */
const BULK_SENDER_RE = /^(no-?reply|donotreply|newsletter|marketing|promo|notifications?|mailer-daemon|postmaster)@/i;
const BULK_SUBJECT_RE = /unsubscribe|退订|订阅|newsletter|促销|限时优惠/i;

/** 业务关键词 → 标签（中英双语，命中主题即打标；snippet 兜底在调用方拼入） */
const SUBJECT_RULES: Array<{ label: string; re: RegExp }> = [
  { label: 'complaint', re: /complaint|claim|投诉|索赔|质量问题|quality\s*(issue|problem)|defect/i },
  { label: 'invoice', re: /invoice|发票|付款|payment|催款|对账单|statement|remittance/i },
  { label: 'shipment_notice', re: /ship(ping|ment)?|出运|发货|装运|delivery|提单|b\/l|booking|托书/i },
  { label: 'quotation', re: /quotation|quote|报价|offer\b/i },
  { label: 'inquiry', re: /inquir|询盘|询价|enquiry|request for (price|quotation)/i },
  { label: 'order', re: /\border\b|订单|purchase order|p\.?o\.?\s*#|confirm(ed)? order/i },
];

export interface EmailClassifiable {
  direction: string;
  fromAddress: string;
  subject: string;
  snippet?: string | null;
  relationId?: string | null;
  hasAttachments?: boolean;
  labels?: string[];
  aiExtractedJson?: unknown;
}

/**
 * 规则分类：仅基于确定性信号，输出标签数组（不含已有标签的并集）。
 * 供同步路径内联调用与端点共用。
 */
export function classifyEmailByRules(email: EmailClassifiable): string[] {
  const labels = new Set<string>();
  const text = `${email.subject || ''}\n${email.snippet || ''}`;

  if (BULK_SENDER_RE.test(email.fromAddress || '') || BULK_SUBJECT_RE.test(text)) {
    labels.add('bulk');
  }
  for (const rule of SUBJECT_RULES) {
    if (rule.re.test(text)) labels.add(rule.label);
  }
  // 已归档到客户档案的邮件即客户邮件
  if (email.relationId) labels.add('customer');
  return [...labels];
}

/** AI 增强：从 aiExtractedJson 提取 intent/signal 标签（纯函数，不触发 LLM） */
export function labelsFromExtraction(payload: EmailExtractedPayload | null | undefined): string[] {
  if (!payload) return [];
  const labels = new Set<string>();
  if (payload.intent && payload.intent !== 'other') labels.add(payload.intent);
  if (payload.customerSignal === 'urgent') labels.add('urgent');
  if (payload.customerSignal === 'risk') labels.add('risk');
  return [...labels];
}

/** 合并计算：规则 + AI 抽取 → 应新增的标签（排除已存在的） */
export function computeEmailLabels(email: EmailClassifiable): { add: string[]; all: string[] } {
  const existing = new Set(Array.isArray(email.labels) ? email.labels : []);
  const extracted = (email.aiExtractedJson ?? null) as EmailExtractedPayload | null;
  const candidates = new Set([...classifyEmailByRules(email), ...labelsFromExtraction(extracted)]);
  // complaint 升级 urgent（投诉必须快速响应）
  if (candidates.has('complaint')) candidates.add('urgent');
  const add = [...candidates].filter(l => !existing.has(l));
  return { add, all: [...new Set([...existing, ...candidates])] };
}

// ─── 应用层（写库 + 审计） ───────────────────────────────────────

export interface ClassifyApplyResult {
  emailId: string;
  changed: boolean;
  added: string[];
  labels: string[];
}

/**
 * 对一封邮件应用分类：并集写入 labels（不删用户标签），有变化才写库 + 审计。
 * extracted 缺失时可用 withAi + llm 先抽取（端点层控制，同步路径不传 llm 即为纯规则）。
 */
export async function applyEmailClassification(
  prisma: PrismaClient,
  emailId: string,
  opts: { actorId: string; source: string; withAi?: boolean; llm?: LlmCompleter },
): Promise<ClassifyApplyResult | { error: 'NOT_FOUND' }> {
  const db = prisma as any;
  const email = await db.email.findUnique({ where: { id: emailId } });
  if (!email || email.deletedAt) return { error: 'NOT_FOUND' };

  // AI 增强：显式允许且尚未抽取时先抽取（失败不阻断规则分类）
  if (opts.withAi && !email.aiExtractedJson) {
    try {
      await extractEmailAi({ prisma, emailId, llm: opts.llm });
      const refreshed = await db.email.findUnique({ where: { id: emailId } });
      if (refreshed) Object.assign(email, refreshed);
    } catch { /* AI 抽取失败降级为纯规则分类 */ }
  }

  const { add, all } = computeEmailLabels(email);
  if (add.length === 0) {
    return { emailId, changed: false, added: [], labels: all };
  }

  const now = BigInt(Date.now());
  await db.email.update({ where: { id: emailId }, data: { labels: all, updatedAt: now } });
  await writeRouteAuditLog({
    prisma,
    actorId: opts.actorId,
    source: opts.source,
    operation: 'email_classify',
    targetType: 'Email',
    targetId: emailId,
    after: { added: add, labels: all },
  });
  return { emailId, changed: true, added: add, labels: all };
}

// ─── 批量回填 ────────────────────────────────────────────────────

export interface ClassifyBackfillResult {
  scanned: number;
  classified: number;
  aiExtracted: number;
  followUpEmails: string[]; // 命中 complaint/urgent 且有客户链接的邮件 id（供路由层决定是否自动建跟进）
}

/**
 * 批量分类回填：扫描 labels 为空的邮件，规则分类；withAi=true 时对未抽取邮件先做 AI 抽取。
 * 返回命中投诉/紧急的邮件 id 清单，自动建跟进由路由层统一处理（避免服务间循环依赖）。
 */
export async function backfillEmailClassification(
  prisma: PrismaClient,
  opts: { limit?: number; mailbox?: string; withAi?: boolean; llm?: LlmCompleter; actorId: string },
): Promise<ClassifyBackfillResult> {
  const db = prisma as any;
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  const where: any = { deletedAt: null, labels: { isEmpty: true } };
  if (opts.mailbox) where.mailbox = opts.mailbox;
  const emails = await db.email.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  let classified = 0;
  let aiExtracted = 0;
  const followUpEmails: string[] = [];

  for (const email of emails) {
    if (opts.withAi && !email.aiExtractedJson) {
      try {
        const r = await extractEmailAi({ prisma, emailId: email.id, llm: opts.llm });
        if (r.ok && !r.reused) aiExtracted += 1;
        const refreshed = await db.email.findUnique({ where: { id: email.id } });
        if (refreshed) Object.assign(email, refreshed);
      } catch { /* 降级纯规则 */ }
    }

    const { add, all } = computeEmailLabels(email);
    if (add.length > 0) {
      await db.email.update({ where: { id: email.id }, data: { labels: all, updatedAt: BigInt(Date.now()) } });
      classified += 1;
    }
    const finalLabels = add.length > 0 ? all : (Array.isArray(email.labels) ? email.labels : []);
    if (email.relationId && (finalLabels.includes('complaint') || finalLabels.includes('urgent'))) {
      followUpEmails.push(email.id);
    }
  }

  if (classified > 0 || aiExtracted > 0) {
    await writeRouteAuditLog({
      prisma,
      actorId: opts.actorId,
      source: 'route:email:classify-backfill',
      operation: 'email_classify_backfill',
      targetType: 'Email',
      targetId: `batch:${Date.now()}`,
      after: { scanned: emails.length, classified, aiExtracted },
    });
  }

  return { scanned: emails.length, classified, aiExtracted, followUpEmails };
}
