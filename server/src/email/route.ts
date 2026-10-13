/**
 * Email Module Route — 邮件接收 + 附件存储 + Agent 可查询 (Phase 4a)
 *
 * 路由分两大类：
 *   1. DB-backed 端点（/api/v1/email/...）— 查询已同步到 DB 的邮件
 *   2. IMAP-proxy 端点（/api/email/...）— 向 IMAP 实时代理（前端兼容保留）
 *
 * Phase 4a 新增：
 *   - GET  /api/v1/email          — DB 查询邮件列表（分页/过滤/搜索）
 *   - GET  /api/v1/email/:id      — DB 查询单封邮件详情（含附件）
 *   - POST /api/v1/email/sync     — 触发 IMAP→DB 同步
 *   - GET  /api/v1/email/attachments/:id/download — 下载附件
 *   - PATCH /api/v1/email/:id     — 更新邮件状态（read/starred/important/labels）
 *
 * Phase C2 新增（邮件→客户/订单自动归档）：
 *   - POST /api/v1/email/backfill-links   — 批量回填缺失链接（owner/admin/manager）
 *   - POST /api/v1/email/:id/auto-link    — 单封重算补缺链接
 */

import { Router, Request, Response, NextFunction } from 'express';
import { safeRouteError } from '../shared/routeError';
import { requireRole, extractActorFromRequest } from '../auth/middleware';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import type { AgentRole } from '../agent/types';
import { PrismaClient } from '@prisma/client';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import { sendOutboxEmail } from './outboxSend';
import { syncEmailsFromImap, resolveEmailAttachmentPath } from './emailSyncService';
import { ensurePrivateDir } from '../lib/privateFiles';
import { putImapSession, getImapSession } from './imapSessionStore';
import { autoLinkEmailById, backfillEmailLinks } from './emailLinkService';
import { applyEmailClassification, backfillEmailClassification } from './emailClassificationService';
import { autoFollowUpForClassifiedEmail, createFollowUpFromEmail } from './emailFollowUpService';
import { createOutboxEmail, createReplyOutboxEmail } from './emailOutboxMutationService';
import { actorIdFromRequest, writeRouteAuditLog } from '../audit/routeAudit';
import { asyncHandler } from '../lib/asyncHandler';
import { logger } from '../lib/logger';
import crypto from 'crypto';
import fs from 'fs';

// 安全收口：附件落盘/回读统一走私有根 private-files/email-attachments（不经 /api/uploads 静态服务）
ensurePrivateDir('email-attachments');

// ─── Shared IMAP Helpers ──────────────────────────────────────────

function makeImapConfig(email: string, password: string, host?: string, port = 993) {
  return {
    imap: {
      user: email,
      password,
      host: host || 'imap.qiye.aliyun.com',
      port,
      tls: true,
      authTimeout: 15000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };
}

function findBoxByAttr(boxList: any, attr: string): string | null {
  for (const key in boxList) {
    const mailbox = boxList[key];
    if (mailbox.attribs && mailbox.attribs.some((a: string) => a.toUpperCase() === attr.toUpperCase())) return key;
    if (mailbox.children) {
      const child = findBoxByAttr(mailbox.children, attr);
      if (child) return key + mailbox.delimiter + child;
    }
  }
  return null;
}

const BOX_ATTR_MAP: Record<string, string> = {
  Sent: '\\SENT',
  Trash: '\\TRASH',
  Drafts: '\\DRAFTS',
  Spams: '\\JUNK',
  Junk: '\\JUNK',
  // L6：归档 — 支持 LIST-EXTENDED \Archive 属性的服务器按属性解析，否则回退字面量 'Archive'
  Archive: '\\ARCHIVE',
};

async function resolvePhysicalBox(connection: any, box: string): Promise<string> {
  let targetBox = box;
  try {
    if (Object.keys(BOX_ATTR_MAP).some((k) => box.startsWith(k))) {
      const boxes = await connection.getBoxes();
      const flag = Object.keys(BOX_ATTR_MAP).find((k) => box.startsWith(k));
      if (flag) {
        const real = findBoxByAttr(boxes, BOX_ATTR_MAP[flag]);
        if (real) targetBox = real;
      }
    }
  } catch (_) {}
  return targetBox;
}

function generateId(prefix: string): string {
  const short = crypto.randomBytes(6).toString('base64url').toUpperCase();
  return `${prefix}__${short}`;
}

// ─── Route Factory ──────────────────────────────────────────────

const EMAIL_OUTBOX_STATUS_MAP: Record<string, number> = { INVALID_INPUT: 400, MISSING_RECIPIENT: 400, MISSING_SUBJECT: 400, MISSING_BODY: 400, MISSING_FROM: 400, ORIGINAL_EMAIL_NOT_FOUND: 404, CREATE_FAILED: 500, SYNC_REF_FAILED: 500, AUDIT_FAILED: 500 };

const EMAIL_SYNC_STATUS_MAP: Record<string, number> = { MISSING_CREDENTIALS: 400, IMAP_CONNECT_FAILED: 502, SYNC_FAILED: 500, DB_WRITE_FAILED: 500, SYNC_REF_FAILED: 500, AUDIT_FAILED: 500, UNKNOWN_ERROR: 500 };

function mailboxOwnerId(req: Request): string | null {
  const id = actorIdFromRequest(req);
  return id && id !== 'api' ? id : null;
}

function isDevelopmentMailSimulatorEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const url = new URL(process.env.DATABASE_URL || '');
    return url.hostname === 'localhost' && url.pathname.replace(/^\//, '').split('/')[0] === 'panda_hub_dev';
  } catch { return false; }
}

export interface EmailRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createEmailRouter(options: EmailRouterOptions) {
  const { prisma, requireAuth, apiKeys } = options;
  const router = Router();

  // Shared auth guard: JWT or API-key
  const guard = createModuleAuthGuard({ requireAuth, apiKeys });
  router.use(guard);

  // W-C 批三-F（族 C）：S1 日常写端点（sync/outbox send）已从 legacy requireRole 切换到
  // requirePermission('emails:write')——矩阵真源授权 SALES/SALES_MANAGER（业务员发邮件是 S1 主链日常），
  // §6.6 ADMIN 业务域只读属预期收紧，SuperAdmin(owner) 经 hasPermission 特判照常全通。
  // HIGH_RISK_ROLES 仅保留给批量维护面端点（backfill-links / classify-backfill）：
  // 批量回填非日常写且 emails:admin 未授予任何业务角色，挂矩阵会只剩 SuperAdmin 可用（预期外收紧）。
  const HIGH_RISK_ROLES: AgentRole[] = ['owner', 'admin', 'manager'];

  // IMAP GET 端点（/attachment、/image）涉及邮箱凭证查询，必须 JWT 强制（API-Key 不足）
  // P0-2 收口：/attachment 已升级 requirePermission('emails:read')；/image 保持 requireJwt
  //（其凭据来自 /detail 创建的短期 session token，已由 /detail 的 emails:read 门前置把关）
  const requireJwt = (req: Request, res: Response, next: NextFunction) => {
    if (!requireAuth) return next();
    const actor = extractActorFromRequest(req);
    if (actor) {
      (req as any).actor = actor;
      return next();
    }
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'IMAP endpoints require JWT login (API key insufficient).' });
  };


  // ══════════════════════════════════════════════════════════════
  // DB-backed endpoints (/api/v1/email)
  // ══════════════════════════════════════════════════════════════

  /** Local development mail-server ingress. Never connects to or sends through an external provider. */
  router.post('/simulate-inbound', requireRole('owner'), async (req: Request, res: Response) => {
    if (!isDevelopmentMailSimulatorEnabled()) return res.status(404).json({ ok: false, error: 'Not found' });
    const actorId = mailboxOwnerId(req);
    if (!actorId) return res.status(401).json({ ok: false, error: 'Authenticated employee required' });
    const { recipientUserId, fromAddress, fromName, subject, bodyText, relationId } = req.body || {};
    if (![recipientUserId, fromAddress, fromName, subject, bodyText].every((value: unknown) => typeof value === 'string' && value.trim())) {
      return res.status(400).json({ ok: false, error: 'recipientUserId, fromAddress, fromName, subject and bodyText are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress.trim())) return res.status(400).json({ ok: false, error: 'Invalid sender address' });

    try {
      const recipient = await prisma.userAccount.findFirst({
        where: { id: recipientUserId.trim(), status: 'active', deletedAt: null },
        select: { id: true, email: true, displayName: true },
      });
      if (!recipient?.email) return res.status(404).json({ ok: false, error: 'Recipient mailbox not found' });
      const relation = relationId ? await prisma.relation.findFirst({ where: { id: relationId, deletedAt: null }, select: { id: true, name: true } }) : null;
      if (relationId && !relation) return res.status(404).json({ ok: false, error: 'Customer relation not found' });

      const now = BigInt(Date.now());
      const date = new Date(Number(now)).toISOString().replace('T', ' ').slice(0, 19);
      const emailId = generateId('EML');
      const row = await prisma.email.create({ data: {
        id: emailId, messageId: `<${emailId.toLowerCase()}@mail-simulator.bambook.local>`,
        direction: 'inbound', status: 'new', mailboxOwnerUserId: recipient.id,
        fromAddress: fromAddress.trim(), fromName: fromName.trim(), toAddresses: JSON.stringify([recipient.email]),
        ccAddresses: null, bccAddresses: null, replyToAddress: fromAddress.trim(),
        subject: subject.trim(), bodyText: bodyText.trim(), bodyHtml: null,
        snippet: bodyText.trim().replace(/\s+/g, ' ').slice(0, 200), mailbox: 'INBOX', uid: null, uidValidity: null,
        threadId: null, sentAt: date, receivedAt: date, relationId: relation?.id ?? null, relationName: relation?.name ?? null,
        labels: ['inquiry', 'development_simulation'], hasAttachments: false, attachmentCount: 0,
        createdAt: now, updatedAt: now, deletedAt: null, syncedAt: now,
      } });
      await writeRouteAuditLog({ prisma, actorId, source: 'route:email:simulate-inbound', operation: 'simulate_inbound_email', targetType: 'Email', targetId: emailId,
        after: { recipientUserId: recipient.id, to: recipient.email, fromAddress: fromAddress.trim(), subject: subject.trim(), relationId: relation?.id ?? null } });
      res.status(201).json({ ok: true, data: { emailId: row.id, mailbox: row.mailbox, recipientUserId: recipient.id } });
    } catch (e: any) {
      logger.error('[email] development simulator ingress failed', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'EMAIL_SIMULATION_FAILED', fallbackMessage: '模拟来信投递失败；请重试。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  /**
   * GET /api/v1/email — 查询 DB 中的邮件列表
   * Query params: mailbox, direction, status, fromAddress, subject, orderId, relationId, limit, offset
   * emails:read 权限门（安全修复：业务邮件正文/元数据与附件下载同域，未持 scope 的
   * 已登录身份（含裸 API-Key）一律 403——与 /attachments/:id/download 口径一致）
   */
  router.get('/', requirePermission('emails:read'), async (req: Request, res: Response) => {
    try {
      const {
        mailbox,
        direction,
        status,
        fromAddress,
        subject,
        orderId,
        relationId,
        limit = '50',
        offset = '0',
      } = req.query as Record<string, string>;

      const ownerId = mailboxOwnerId(req);
      if (!ownerId) return res.status(401).json({ ok: false, error: 'Employee mailbox identity required' });
      const where: any = { deletedAt: null, mailboxOwnerUserId: ownerId };
      if (mailbox) where.mailbox = mailbox;
      if (direction) where.direction = direction;
      if (status) where.status = status;
      if (fromAddress) where.fromAddress = { contains: fromAddress, mode: 'insensitive' };
      if (subject) where.subject = { contains: subject, mode: 'insensitive' };
      if (orderId) where.orderId = orderId;
      if (relationId) where.relationId = relationId;

      const [items, total] = await Promise.all([
        prisma.email.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: Number(offset),
          take: Number(limit),
          include: {
            attachments: {
              select: { id: true, filename: true, contentType: true, fileSize: true, isInline: true },
            },
          },
        }),
        prisma.email.count({ where }),
      ]);

      res.json({ ok: true, items, total });
    } catch (e: any) {
      logger.error('[email] list error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'EMAIL_LIST_FAILED', fallbackMessage: '邮件列表加载失败；请稍后重试，持续失败请联系管理员查看服务日志。' });
      res.status(safe.status).json({ ok: false, error: safe.message });
    }
  });

  /**
   * PATCH /api/v1/email/:id — 更新邮件状态/标签
   * P0-2 审计收口：写端点统一 emails:write scope 门（原 requireWrite 仅纯 JWT，
   * 任何已登录身份皆可写——矩阵真源：SALES/SALES_MANAGER 持有 emails:write，
   * FINANCE/ADMIN/LOGISTICS 仅 emails:read 只读；requirePermission 已内建 JWT 强制）
   */
  router.patch('/:id', requirePermission('emails:write'), async (req: Request, res: Response) => {
    try {
      const EMAIL_PATCH_FIELDS = ['status', 'isRead', 'isStarred', 'isImportant', 'labels', 'orderId', 'relationId', 'orderPo', 'invoiceId', 'invoiceNumber', 'aiSummary'];
      const ownerId = mailboxOwnerId(req);
      if (!ownerId) return res.status(401).json({ ok: false, error: 'Employee mailbox identity required' });
      const owned = await prisma.email.findFirst({ where: { id: req.params.id, mailboxOwnerUserId: ownerId, deletedAt: null }, select: { id: true } });
      if (!owned) return res.status(404).json({ ok: false, error: 'Email not found' });
      const data: any = {};
      for (const key of EMAIL_PATCH_FIELDS) {
        if (req.body[key] !== undefined) data[key] = req.body[key];
      }
      data.updatedAt = BigInt(Date.now());

      // Map boolean flags to status string for backward compat
      if (req.body.isRead !== undefined) {
        data.status = req.body.isRead ? 'read' : 'new';
      }
      if (req.body.isStarred === true) data.status = 'starred';
      if (req.body.isImportant === true) data.status = 'important';

      const email = await prisma.email.update({
        where: { id: req.params.id },
        data,
      });
      res.json({ ok: true, data: email });
    } catch (e: any) {
      logger.error('[email] patch error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'EMAIL_PATCH_FAILED', fallbackMessage: '邮件标记未保存成功；本次改动未确认，请稍后重试。' });
      res.status(safe.status).json({ ok: false, error: safe.message });
    }
  });

  /**
   * POST /api/v1/email/sync — 触发 IMAP→DB 同步
   * W-C 批三-F：业务员同步本人邮箱是 S1 主链日常 → requirePermission('emails:write')
   * 崩溃链修复：asyncHandler 包装——service 未预期 reject 时 next(err) 进全局
   * 4 参错误中间件，不再成为 unhandledRejection 打崩进程。
   */
  router.post('/sync', requirePermission('emails:write'), asyncHandler(async (req: Request, res: Response) => {
    const { email, password, host, port, box, limit } = req.body || {};
    const result = await syncEmailsFromImap({
      prisma,
      credentials: { user: email || '', pass: password || '', host, port },
      box: box || 'INBOX',
      limit: limit || 100,
      actorId: actorIdFromRequest(req),
    });
    if (!result.ok) {
      return res.status(EMAIL_SYNC_STATUS_MAP[result.error!.code]).json({ ok: false, error: result.error });
    }
    res.json({ ok: true, ...result.data! });
  }));

  /**
   * POST /api/v1/email/backfill-links — C2 批量回填邮件→客户/订单链接
   * 扫描 relationId/orderId 缺失的邮件，按确定性口径（地址匹配 + PO 包含）补链；
   * 手工已设置的链接绝不覆盖。批量写操作，限 owner/admin/manager。
   *
   * [B4 零散收敛 2026-09-15] ⚠️ 前端与 Agent 均零消费（运维批量补数面，非业务链）。
   * 有源码契约测试锁定（__tests__/routeAuthGuardRestoration.test.ts）。保留待业务方确认：
   * 若确认无运维使用场景 → 删并同步移除测试；若保留 → 属运维端点，登记为"有端点无 UI"。
   */
  router.post('/backfill-links', requireRole(...HIGH_RISK_ROLES), async (req: Request, res: Response) => {
    try {
      const limit = Number((req.body || {}).limit) || undefined;
      const result = await backfillEmailLinks(prisma, { limit, actorId: actorIdFromRequest(req) });
      res.json({ ok: true, ...result });
    } catch (e: any) {
      logger.error('[email] backfill-links error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'BACKFILL_FAILED', fallbackMessage: '邮件关联回填未完成，本次未确认任何改动；请稍后重试，持续失败请联系管理员查看服务日志。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  /**
   * POST /api/v1/email/:id/auto-link — C2 单封邮件自动归档（重算并补缺链接）
   * 已同时具有 relationId + orderId 的邮件直接返回 alreadyLinked。
   *
   * [B4 零散收敛 2026-09-15] ⚠️ 前端与 Agent 均零消费（单封补链，前端无入口按钮）。
   * 属批量/单封运维补数面，与 backfill-links 同批处置，保留待业务方确认。
   */
  router.post('/:id/auto-link', requirePermission('emails:write'), async (req: Request, res: Response) => {
    try {
      const ownerId = mailboxOwnerId(req);
      if (!ownerId || !await prisma.email.findFirst({ where: { id: req.params.id, mailboxOwnerUserId: ownerId, deletedAt: null }, select: { id: true } }))
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Email not found' } });
      const result = await autoLinkEmailById(prisma, req.params.id, { actorId: actorIdFromRequest(req) });
      if ('error' in result) {
        return res.status(404).json({ ok: false, error: { code: result.error, message: 'Email not found' } });
      }
      res.json({ ok: true, ...result });
    } catch (e: any) {
      logger.error('[email] auto-link error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'AUTO_LINK_FAILED', fallbackMessage: '邮件自动关联订单未完成；可在邮件详情里手动关联，或稍后重试。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  /**
   * POST /api/v1/email/:id/classify — C8 单封智能分类（规则 + AI 增强）
   * body: { withAi?: boolean = true, autoFollowUp?: boolean = true }
   * 并集打标（不删用户标签）；命中 complaint/urgent 且已关联客户时幂等自动建跟进任务。
   */
  router.post('/:id/classify', requirePermission('emails:write'), async (req: Request, res: Response) => {
    try {
      const actorId = actorIdFromRequest(req);
      const ownerId = mailboxOwnerId(req);
      if (!ownerId || !await prisma.email.findFirst({ where: { id: req.params.id, mailboxOwnerUserId: ownerId, deletedAt: null }, select: { id: true } }))
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Email not found' } });
      const withAi = req.body?.withAi !== false;
      const autoFollowUp = req.body?.autoFollowUp !== false;
      const result = await applyEmailClassification(prisma, req.params.id, {
        actorId, source: 'route:email:classify', withAi,
      });
      if ('error' in result) {
        return res.status(404).json({ ok: false, error: { code: result.error, message: 'Email not found' } });
      }
      let followUp: { created: boolean; followUpId?: string } = { created: false };
      if (autoFollowUp) {
        followUp = await autoFollowUpForClassifiedEmail(prisma, req.params.id, result.labels, {
          actorId, source: 'route:email:classify:auto-followup',
        });
      }
      res.json({ ok: true, ...result, followUp });
    } catch (e: any) {
      logger.error('[email] classify error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'CLASSIFY_FAILED', fallbackMessage: '邮件分类未完成，这封邮件的分类标签保持不变；请稍后重试。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  /**
   * POST /api/v1/email/classify-backfill — C8 批量智能分类回填（owner/admin/manager）
   * body: { limit?: number, mailbox?: string, withAi?: boolean = false, autoFollowUp?: boolean = true }
   * 扫描 labels 为空的邮件打标；withAi=true 时对未抽取邮件先做 AI 抽取（有 LLM 成本，默认关）。
   *
   * [B4 零散收敛 2026-09-15] ⚠️ 前端与 Agent 均零消费（运维批量补数面）。
   * 有 HTTP 契约测试锁定（email/__tests__/emailC8Route.test.ts）。与 backfill-links 同批处置。
   */
  router.post('/classify-backfill', requireRole(...HIGH_RISK_ROLES), async (req: Request, res: Response) => {
    try {
      const actorId = actorIdFromRequest(req);
      const { limit, mailbox, withAi = false, autoFollowUp = true } = req.body || {};
      const result = await backfillEmailClassification(prisma, { limit, mailbox, withAi, actorId });
      let followUpsCreated = 0;
      if (autoFollowUp) {
        for (const emailId of result.followUpEmails) {
          const r = await autoFollowUpForClassifiedEmail(prisma, emailId, ['urgent'], {
            actorId, source: 'route:email:classify-backfill:auto-followup',
          });
          if (r.created) followUpsCreated += 1;
        }
      }
      res.json({ ok: true, ...result, followUpsCreated });
    } catch (e: any) {
      logger.error('[email] classify-backfill error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'CLASSIFY_BACKFILL_FAILED', fallbackMessage: '历史邮件补分类未完成；请稍后重试，持续失败请联系管理员查看服务日志。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  /**
   * POST /api/v1/email/:id/create-followup — C8 邮件一键生成 CRM 跟进任务
   * body: { content?, nextFollowUpAt?, nextFollowUpTopic? }（缺省取 AI 摘要/最早 deadline）
   * 幂等：同邮件重复调用返回已建记录（reused=true）。无客户链接返回 409。
   */
  router.post('/:id/create-followup', requirePermission('emails:write'), async (req: Request, res: Response) => {
    try {
      const { content, nextFollowUpAt, nextFollowUpTopic } = req.body || {};
      const ownerId = mailboxOwnerId(req);
      if (!ownerId || !await prisma.email.findFirst({ where: { id: req.params.id, mailboxOwnerUserId: ownerId, deletedAt: null }, select: { id: true } }))
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Email not found' } });
      const result = await createFollowUpFromEmail(prisma, req.params.id, {
        actorId: actorIdFromRequest(req),
        source: 'route:email:create-followup',
        overrides: { content, nextFollowUpAt, nextFollowUpTopic },
      });
      if (!result.ok) {
        const status = result.error === 'NOT_FOUND' ? 404 : 409;
        const message = result.error === 'NOT_FOUND' ? 'Email not found' : '邮件未关联客户，无法生成跟进任务（请先归档）';
        return res.status(status).json({ ok: false, error: { code: result.error, message } });
      }
      const { ok: _discarded, ...followUpResult } = result;
      res.status(result.reused ? 200 : 201).json({ ok: true, ...followUpResult });
    } catch (e: any) {
      logger.error('[email] create-followup error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'CREATE_FOLLOWUP_FAILED', fallbackMessage: '由这封邮件创建跟进事项未完成，本次未确认任何改动；请稍后重试。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  /**
   * POST /api/v1/email/outbox — 手动 compose 创建 Outbox Email（shared service）
   * 崩溃链修复：asyncHandler 包装（同 /sync，service reject → 全局错误中间件）。
   */
  router.post('/outbox', requirePermission('emails:write'), asyncHandler(async (req: Request, res: Response) => {
    const { fromAddress, fromName, to, cc, bcc, subject, bodyText, bodyHtml, threadId, relationId, relationName, orderId, orderPo, invoiceId, invoiceNumber } = req.body || {};
    const result = await createOutboxEmail({
      prisma,
      input: { fromAddress, fromName, to, cc, bcc, subject, bodyText, bodyHtml, threadId, relationId, relationName, orderId, orderPo, invoiceId, invoiceNumber },
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });
    if (!result.ok) {
      return res.status(EMAIL_OUTBOX_STATUS_MAP[result.error!.code]).json({ ok: false, error: result.error });
    }
    res.status(201).json({ ok: true, emailId: result.data!.emailId, mailbox: result.data!.mailbox, direction: result.data!.direction, auditId: result.data!.auditId });
  }));

  /**
   * POST /api/v1/email/replies — 手动 reply 创建 Outbox Email（shared service，threading from original）
   * 崩溃链修复：asyncHandler 包装（同 /sync，service reject → 全局错误中间件）。
   */
  router.post('/replies', requirePermission('emails:write'), asyncHandler(async (req: Request, res: Response) => {
    const { originalEmailId, fromAddress, fromName, to, cc, bcc, subject, bodyText, bodyHtml, threadId, relationId, relationName, orderId, orderPo, invoiceId, invoiceNumber } = req.body || {};
    const ownerId = mailboxOwnerId(req);
    if (!ownerId || !await prisma.email.findFirst({ where: { id: originalEmailId, mailboxOwnerUserId: ownerId, deletedAt: null }, select: { id: true } }))
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Email not found' } });
    const result = await createReplyOutboxEmail({
      prisma,
      input: { originalEmailId, fromAddress, fromName, to, cc, bcc, subject, bodyText, bodyHtml, threadId, relationId, relationName, orderId, orderPo, invoiceId, invoiceNumber },
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });
    if (!result.ok) {
      return res.status(EMAIL_OUTBOX_STATUS_MAP[result.error!.code]).json({ ok: false, error: result.error });
    }
    res.status(201).json({ ok: true, emailId: result.data!.emailId, mailbox: result.data!.mailbox, direction: result.data!.direction, auditId: result.data!.auditId });
  }));

  /**
   * POST /api/v1/email/outbox/:id/send — Outbox Email 显式 SMTP 发送
   * 只能发送已存在的 Email(direction=outbound, mailbox=Outbox)。
   * SMTP 成功后更新 Sent + sentAt + messageId；失败保持 Outbox。
   * W-C 批三-F：业务员发邮件是 S1 主链日常 → requirePermission('emails:write')
   */
  router.post('/outbox/:id/send', requirePermission('emails:write'), async (req: Request, res: Response) => {
    try {
      const emailId = req.params.id;
      const { email, password, host, port } = req.body || {};
      const ownerId = mailboxOwnerId(req);
      if (!ownerId || !await prisma.email.findFirst({ where: { id: emailId, mailboxOwnerUserId: ownerId, deletedAt: null }, select: { id: true } }))
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Email not found' } });
      const result = await sendOutboxEmail({
        prisma,
        emailId,
        credentials: { user: email, pass: password, host, port },
        actorId: actorIdFromRequest(req),
        actor: extractActorFromRequest(req) || undefined,
      });
      if (!result.ok) {
        return res.status(result.error!.statusCode).json({ ok: false, error: result.error });
      }
      res.json({ ok: true, ...result.data! });
    } catch (e: any) {
      logger.error('[email] outbox send error', { error: e?.message || String(e) });
      // ★ B42 A1（S0-A2 第 10 批）：这一处是**全局兜底**，SMTP/网络原文里可能带邮箱地址与主机名
      //   ⇒ 不许上屏；原文由上面那行 logger.error 带走（D51：先确认有日志，再换文案）。
      const safe = safeRouteError(e, { fallbackCode: 'UNKNOWN_ERROR', fallbackMessage: '邮件发送未能完成；请稍后重试，并在发件箱核对该邮件的发送结果。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message, statusCode: safe.status } });
    }
  });

  /**
   * GET /api/v1/email/attachments/:id/download — 下载附件
   * emails:read 权限门：附件内容与邮件正文同属业务邮件域，未持该 scope 的
   * 已登录身份（含裸 API-Key，scope 判定需 actor）一律拒绝。
   * 存储双基解析见 resolveEmailAttachmentPath（新记录私有根 / 旧记录 uploads/ 前缀兜底）。
   */
  router.get('/attachments/:id/download', requirePermission('emails:read'), async (req: Request, res: Response) => {
    try {
      const ownerId = mailboxOwnerId(req);
      if (!ownerId) return res.status(401).send('Employee mailbox identity required');
      const att = await prisma.emailAttachment.findFirst({ where: { id: req.params.id, email: { mailboxOwnerUserId: ownerId } } });
      if (!att || !att.filePath) return res.status(404).send('Attachment not found');

      const fullPath = resolveEmailAttachmentPath(att.filePath);
      if (!fs.existsSync(fullPath)) return res.status(404).send('File not found on disk');

      const safeFilename = encodeURIComponent(att.filename || 'download');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}`);
      res.setHeader('Content-Type', att.contentType);
      res.sendFile(fullPath);
    } catch (e: any) {
      logger.error('[email] attachment download error', { error: e?.message || String(e) });
      res.status(500).send('Download failed');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // IMAP-proxy endpoints (/api/email) — 兼容旧前端
  // ══════════════════════════════════════════════════════════════

  /**
   * POST /api/email/fetch — IMAP 实时获取邮件列表（兼容旧前端）
   * P0-2 语义收口：拉取列表为只读操作 → emails:read scope 门（FINANCE/ADMIN/LOGISTICS
   * 持 emails:read 可正常读信；写端点才要求 emails:write）
   */
  router.post('/fetch', requirePermission('emails:read'), async (req: Request, res: Response) => {
    const { email, password, host, port = 993, box = 'INBOX', limit = 50, offset = 0 } = req.body;
    let targetBox = box;

    if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

    const config = makeImapConfig(email, password, host, port);

    try {
      const connection = await imaps.connect(config);

      let searchCriteria: any[] = ['ALL'];
      let isVirtual = false;

      if (box === 'IMPORTANT') {
        targetBox = 'INBOX';
        searchCriteria = [['OR', 'KEYWORD', 'Important', ['OR', 'KEYWORD', '$Important', 'KEYWORD', '\\Important']]];
        isVirtual = true;
      } else if (box === 'STARRED') {
        targetBox = 'INBOX';
        searchCriteria = ['FLAGGED'];
        isVirtual = true;
      } else if (box === 'UNREAD') {
        targetBox = 'INBOX';
        searchCriteria = ['UNSEEN'];
        isVirtual = true;
      }

      if (!isVirtual) {
        try {
          if (['Sent Messages', 'Sent', 'Trash', 'Drafts', 'Spams', 'Junk'].includes(box)) {
            targetBox = await resolvePhysicalBox(connection, box);
          }
        } catch (_) {}
      }

      try { await connection.openBox(targetBox); }
      catch (err: any) { throw new Error(`Box not found: ${targetBox}`); }

      const metaMessages = await connection.search(searchCriteria, { bodies: [], struct: false });
      const sortedMeta = metaMessages.sort((a: any, b: any) => {
        const dateA = a.attributes.date ? new Date(a.attributes.date).getTime() : 0;
        const dateB = b.attributes.date ? new Date(b.attributes.date).getTime() : 0;
        return dateB - dateA;
      });

      const total = sortedMeta.length;
      const targetMeta = sortedMeta.slice(Number(offset), Number(offset) + Number(limit));

      if (targetMeta.length === 0) {
        connection.end();
        return res.json({ status: 'success', data: [], total });
      }

      const targetUids = targetMeta.map((m: any) => m.attributes.uid);
      const fullMessages = await connection.search([['UID', ...targetUids]], {
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE)'],
        markSeen: false,
        struct: true,
      });

      const messageMap = new Map();
      for (const msg of fullMessages) messageMap.set(msg.attributes.uid, msg);

      const emails = targetMeta.map((meta: any) => {
        const item = messageMap.get(meta.attributes.uid);
        if (!item) return null;
        const id = item.attributes.uid;
        const headerPart = item.parts.find((p: any) => p.which !== '');
        const headers = (headerPart && headerPart.body) || {};
        const sender = headers.from?.[0] || 'Unknown';
        const subject = headers.subject?.[0] || '(No Subject)';
        const dateStr = headers.date?.[0] || new Date().toISOString();

        return {
          id: `${box}-${id}`, uid: id, box, realBox: targetBox, sender, subject,
          body: '', snippet: '', date: new Date(dateStr),
          isRead: item.attributes.flags?.includes('\\Seen'),
          isStarred: item.attributes.flags?.includes('\\Flagged'),
          isImportant: item.attributes.flags?.includes('\\Important') || item.attributes.flags?.includes('$Important'),
          attachments: [],
        };
      });

      connection.end();
      res.json({
        status: 'success', data: emails.filter(Boolean), total,
      });
    } catch (err: any) {
      logger.error('[email] IMAP_LIST_FAILED', { error: err?.message || String(err) });
      const safe = safeRouteError(err, { fallbackCode: 'IMAP_LIST_FAILED', fallbackMessage: '邮箱连接或列表读取失败；请检查邮箱账号与服务器设置，或稍后重试。' });
      res.status(safe.status).json({ error: safe.message });
    }
  });

  /**
   * POST /api/email/send — 发送邮件
   * P0-2：发送为写操作 → emails:write
   */
  router.post('/send', requirePermission('emails:write'), (_req: Request, res: Response) => {
    return res.status(410).json({ ok: false, error: { code: 'NATIVE_OUTBOX_REQUIRED',
      message: '请先在发件箱登记邮件，再从该邮件发送；独立直接发送入口已关闭，本次未发送。' } });
  });

  /**
   * POST /api/email/mark_read
   * P0-2：标记读写为写操作 → emails:write
   */
  router.post('/mark_read', requirePermission('emails:write'), async (req: Request, res: Response) => {
    const { email, password, host, port = 993, box = 'INBOX', uid, isRead = true } = req.body;
    if (!email || !password || !uid) return res.status(400).json({ error: 'Missing parameters' });

    try {
      const connection = await imaps.connect(makeImapConfig(email, password, host, port));
      const targetBox = await resolvePhysicalBox(connection, box);
      await connection.openBox(targetBox);
      if (isRead) await connection.addFlags(uid, '\\Seen');
      else await connection.delFlags(uid, '\\Seen');
      connection.end();
      res.json({ status: 'success' });
    } catch (e: any) {
      logger.error('[email] IMAP_MARK_READ_FAILED', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'IMAP_MARK_READ_FAILED', fallbackMessage: '标记已读未完成；邮件状态可能仍是未读，请稍后重试。' });
      res.status(safe.status).json({ error: safe.message });
    }
  });

  /**
   * POST /api/email/mark_starred
   * P0-2：标记写操作 → emails:write
   */
  router.post('/mark_starred', requirePermission('emails:write'), async (req: Request, res: Response) => {
    const { email, password, host, port = 993, box = 'INBOX', uid, isStarred = true } = req.body;
    if (!email || !password || !uid) return res.status(400).json({ error: 'Missing parameters' });

    try {
      const connection = await imaps.connect(makeImapConfig(email, password, host, port));
      const targetBox = await resolvePhysicalBox(connection, box);
      await connection.openBox(targetBox);
      if (isStarred) await connection.addFlags(uid, '\\Flagged');
      else await connection.delFlags(uid, '\\Flagged');
      connection.end();
      res.json({ status: 'success' });
    } catch (e: any) {
      logger.error('[email] IMAP_MARK_STARRED_FAILED', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'IMAP_MARK_STARRED_FAILED', fallbackMessage: '标记星标未完成；请稍后重试。' });
      res.status(safe.status).json({ error: safe.message });
    }
  });

  /**
   * POST /api/email/mark_important
   * P0-2：标记写操作 → emails:write
   */
  router.post('/mark_important', requirePermission('emails:write'), async (req: Request, res: Response) => {
    const { email, password, host, port = 993, box = 'INBOX', uid, isImportant = true } = req.body;
    if (!email || !password || !uid) return res.status(400).json({ error: 'Missing parameters' });

    try {
      const connection = await imaps.connect(makeImapConfig(email, password, host, port));
      const targetBox = await resolvePhysicalBox(connection, box);
      await connection.openBox(targetBox);
      if (isImportant) await connection.addFlags(uid, ['\\Important', '$Important']);
      else await connection.delFlags(uid, ['\\Important', '$Important']);
      connection.end();
      res.json({ status: 'success' });
    } catch (e: any) {
      logger.error('[email] IMAP_MARK_IMPORTANT_FAILED', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'IMAP_MARK_IMPORTANT_FAILED', fallbackMessage: '标记重要未完成；请稍后重试。' });
      res.status(safe.status).json({ error: safe.message });
    }
  });

  /**
   * POST /api/email/move
   * P0-2：移动为写操作 → emails:write
   */
  router.post('/move', requirePermission('emails:write'), async (req: Request, res: Response) => {
    const { email, password, host, port = 993, box = 'INBOX', uid, toBox } = req.body;
    if (!email || !password || !uid || !toBox) return res.status(400).json({ error: 'Missing parameters' });

    try {
      const connection = await imaps.connect(makeImapConfig(email, password, host, port));
      let sourceBox = await resolvePhysicalBox(connection, box);
      let destinationBox = await resolvePhysicalBox(connection, toBox);

      await connection.openBox(sourceBox);
      await connection.moveMessage(uid, destinationBox);
      connection.end();
      res.json({ status: 'success' });
    } catch (e: any) {
      logger.error('[email] IMAP_MOVE_FAILED', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'IMAP_MOVE_FAILED', fallbackMessage: '邮件移动未完成；本次未确认任何改动，请稍后重试。' });
      res.status(safe.status).json({ error: safe.message });
    }
  });

  /**
   * POST /api/email/attachment — 下载附件（IMAP 实时代理）
   * L7：凭据从 URL query 移到 POST body（密码不再出现在 URL/访问日志）。
   * P0-2：附件下载为读取类 → emails:read scope 门（原 requireJwt 仅纯 JWT，无 scope 校验）
   */
  router.post('/attachment', requirePermission('emails:read'), async (req: Request, res: Response) => {
    const { email, password, host, port = 993, box = 'INBOX', uid, filename } = req.body || {};
    if (!email || !password || !uid || !filename) return res.status(400).send('Missing parameters');

    try {
      const connection = await imaps.connect(makeImapConfig(email, password, host, Number(port)));
      await connection.openBox(box);
      const messages = await connection.search([['UID', uid]], { bodies: [''], markSeen: false, struct: true });
      if (messages.length === 0) { connection.end(); return res.status(404).send('Message not found'); }

      const all = messages[0].parts.find((part: any) => part.which === '');
      if (!all) { connection.end(); return res.status(404).send('Message body not found'); }
      const parsed = await simpleParser(all.body);
      const attachment = parsed.attachments.find((att: any) => att.filename === filename || att.checksum === filename);

      if (!attachment) { connection.end(); return res.status(404).send('Attachment not found'); }

      const safeFilename = encodeURIComponent(attachment.filename || 'download');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}`);
      res.setHeader('Content-Type', attachment.contentType);
      res.send(attachment.content);
      connection.end();
    } catch (e: any) {
      logger.error('[email] ATTACHMENT_DOWNLOAD_FAILED', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'ATTACHMENT_DOWNLOAD_FAILED', fallbackMessage: '附件下载失败；请确认附件仍在邮箱侧，或稍后重试。' });
      res.status(safe.status).send(safe.message);
    }
  });

  /**
   * GET /api/email/image — 获取邮件内嵌图片
   * L7：URL 不再携带 email/password；/detail 生成代理地址时把凭据放入
   * imapSessionStore（30 分钟 TTL），本端点仅凭 session token 取回凭据。
   */
  router.get('/image', requireJwt, async (req: Request, res: Response) => {
    const { session, box, uid, cid } = req.query as Record<string, string>;
    if (!session || !uid || !cid) return res.status(400).send('Missing parameters');

    const cred = getImapSession(session);
    if (!cred) return res.status(401).send('Image proxy session expired; re-open the email to refresh');

    try {
      const connection = await imaps.connect(makeImapConfig(cred.user, cred.pass, cred.host, Number(cred.port) || 993));
      await connection.openBox(box);
      const messages = await connection.search([['UID', uid]], { bodies: [''], markSeen: false, struct: true });
      if (messages.length === 0) { connection.end(); return res.status(404).send('Not found'); }

      const all = messages[0].parts.find((part: any) => part.which === '');
      if (!all) { connection.end(); return res.status(404).send('Not found'); }
      const parsed = await simpleParser(all.body);
      const image = parsed.attachments.find((att: any) => att.contentId && att.contentId.replace(/[<>]/g, '') === cid);

      if (!image) { connection.end(); return res.status(404).send('Image not found'); }

      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Cache-Control', 'private, max-age=1800');
      res.send(image.content);
      connection.end();
    } catch (_) {
      res.status(500).end();
    }
  });

  /**
   * POST /api/email/detail — 获取单封邮件完整详情
   * P0-2：详情读取为只读操作 → emails:read scope 门（原 requireWrite 纯 JWT 无 scope）
   */
  router.post('/detail', requirePermission('emails:read'), async (req: Request, res: Response) => {
    const { email, password, host, port = 993, box = 'INBOX', uid } = req.body;
    if (!email || !password || !uid) return res.status(400).json({ error: 'Missing parameters' });

    try {
      const connection = await imaps.connect(makeImapConfig(email, password, host, port));
      let targetBox = box;

      try { await connection.openBox(targetBox); }
      catch (_) {
        if (box === 'Sent Messages' || box === 'Sent') targetBox = 'Sent Items';
        await connection.openBox(targetBox);
      }

      const messages = await connection.search([['UID', uid]], {
        bodies: ['HEADER', 'TEXT', ''],
        markSeen: true,
        struct: true,
      });

      if (messages.length === 0) { connection.end(); return res.status(404).json({ error: 'Message not found' }); }

      const item = messages[0];
      const all = item.parts.find((part: any) => part.which === '') || { body: '' };

      let parsed: any;
      try { parsed = await simpleParser(all.body); }
      catch (_) { parsed = { subject: '(Parse Error)', date: new Date(), text: '' }; }

      let htmlBody = parsed.html || parsed.textAsHtml || '';
      const attachmentsMeta: any[] = [];

      if (parsed.attachments) {
        // L7：代理地址不含密码 — 仅当确有 cid 内嵌图时才注册短期 session
        let imageSessionToken: string | null = null;
        const ensureImageSession = () => {
          if (!imageSessionToken) {
            imageSessionToken = putImapSession({ user: email, pass: password, host, port: Number(port) || 993 });
          }
          return imageSessionToken;
        };
        parsed.attachments.forEach((att: any) => {
          const rawCid = att.contentId ? att.contentId.replace(/[<>]/g, '') : null;
          if (rawCid && htmlBody.includes(`cid:${rawCid}`)) {
            const params = new URLSearchParams({ session: ensureImageSession(), box: targetBox, uid: String(uid), cid: rawCid });
            const proxyUrl = `/api/email/image?${params.toString()}`;
            htmlBody = htmlBody.split(`cid:${rawCid}`).join(proxyUrl);
          } else if (att.contentDisposition === 'inline') {
            // Skip inline images
          } else {
            attachmentsMeta.push({
              filename: att.filename || 'Untitled',
              contentType: att.contentType,
              size: att.size,
              id: att.checksum,
            });
          }
        });
      }

      const fullEmail = {
        id: `${box}-${uid}`, uid, box,
        sender: parsed.from?.text || 'Unknown',
        subject: parsed.subject || '(No Subject)',
        body: htmlBody || parsed.text || '',
        date: parsed.date || new Date(),
        isRead: true,
        attachments: attachmentsMeta,
      };

      connection.end();
      res.json({ status: 'success', data: fullEmail });
    } catch (e: any) {
      logger.error('[email] IMAP_DETAIL_FAILED', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'IMAP_DETAIL_FAILED', fallbackMessage: '邮件正文读取失败；请稍后重试，持续失败请联系管理员查看服务日志。' });
      res.status(safe.status).json({ error: safe.message });
    }
  });

  /**
   * GET /api/v1/email/intents — F5 意图可视化：按 mailbox+uids 聚合 AI 意图徽标
   *
   * 前端邮件列表为 IMAP 实时流（不含 DB 字段），本端点提供薄覆盖层：
   * 已同步且已 AI 抽取的邮件返回 intent/customerSignal/summary，未抽取的不出现。
   * C8：已同步邮件（无论是否抽取）额外返回 DB id/labels/relationId/orderId，
   * 供详情 pane 的智能分类/生成跟进按钮与标签 chips 使用。
   * Query: mailbox（必填，物理箱名）, uids（必填，逗号分隔 IMAP UID，上限 200）
   * emails:read 权限门（同 GET / 列表口径：意图/标签/关联均为邮件域数据）
   */
  router.get('/intents', requirePermission('emails:read'), async (req: Request, res: Response) => {
    try {
      const ownerId = mailboxOwnerId(req);
      if (!ownerId) return res.status(401).json({ ok: false, error: 'Employee mailbox identity required' });
      const mailbox = typeof req.query.mailbox === 'string' ? req.query.mailbox : '';
      const rawUids = typeof req.query.uids === 'string' ? req.query.uids : '';
      if (!mailbox || !rawUids) {
        return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'mailbox 与 uids 必填' } });
      }
      const uids = rawUids.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n)).slice(0, 200);
      if (uids.length === 0) return res.json({ ok: true, items: [] });

      const rows = await (prisma as any).email.findMany({
        where: { mailbox, uid: { in: uids }, mailboxOwnerUserId: ownerId, deletedAt: null },
        select: { id: true, uid: true, labels: true, relationId: true, orderId: true, aiExtractedJson: true },
      });
      const items = rows
        .map((r: any) => {
          const payload = r.aiExtractedJson as any;
          return {
            uid: r.uid,
            id: r.id,
            labels: Array.isArray(r.labels) ? r.labels : [],
            relationId: r.relationId ?? null,
            orderId: r.orderId ?? null,
            intent: typeof payload?.intent === 'string' ? payload.intent : null,
            customerSignal: typeof payload?.customerSignal === 'string' ? payload.customerSignal : null,
            summary: typeof payload?.summary === 'string' ? payload.summary : null,
          };
        })
        .filter((it: any) => it.uid !== null && it.uid !== undefined);
      res.json({ ok: true, items });
    } catch (e: any) {
      logger.error('[email] intents error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'INTENTS_FAILED', fallbackMessage: '邮件意图识别未完成，不影响邮件本身；请稍后重试。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  /**
   * GET /api/v1/email/:id — 查询单封邮件详情
   *
   * 注意：此通配路由必须放在所有具名 GET 路由（/attachment、/image 等）之后，
   * 否则动态参数 /:id 会遮蔽具名路由（task A2 安全修复：IMAP 端点 requireJwt 才能生效）。
   * emails:read 权限门（邮件正文全文，与列表/附件同域同口径）
   */
  router.get('/:id', requirePermission('emails:read'), async (req: Request, res: Response) => {
    try {
      const ownerId = mailboxOwnerId(req);
      if (!ownerId) return res.status(401).json({ ok: false, error: 'Employee mailbox identity required' });
      const email = await prisma.email.findFirst({
        where: { id: req.params.id, mailboxOwnerUserId: ownerId, deletedAt: null },
        include: { attachments: true },
      });
      if (!email) return res.status(404).json({ ok: false, error: 'Email not found' });
      res.json({ ok: true, data: email });
    } catch (e: any) {
      logger.error('[email] get error', { error: e?.message || String(e) });
      const safe = safeRouteError(e, { fallbackCode: 'EMAIL_DETAIL_FAILED', fallbackMessage: '邮件详情加载失败；请稍后重试。' });
      res.status(safe.status).json({ ok: false, error: safe.message });
    }
  });

  return router;
}
