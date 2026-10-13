import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { syncEmailReferences } from './sync';
import { writeRouteAuditLog } from '../audit/routeAudit';

export type EmailOutboxErrorCode =
  | 'INVALID_INPUT'
  | 'MISSING_RECIPIENT'
  | 'MISSING_SUBJECT'
  | 'MISSING_BODY'
  | 'MISSING_FROM'
  | 'ORIGINAL_EMAIL_NOT_FOUND'
  | 'CREATE_FAILED'
  | 'SYNC_REF_FAILED'
  | 'AUDIT_FAILED';

export interface EmailOutboxError { code: EmailOutboxErrorCode; message: string; }

export interface EmailComposeInput {
  fromAddress: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  threadId?: string;
  relationId?: string;
  relationName?: string;
  orderId?: string;
  orderPo?: string;
  invoiceId?: string;
  invoiceNumber?: string;
}

export interface EmailReplyInput extends EmailComposeInput {
  originalEmailId: string;
}

export interface EmailMutationResult {
  ok: boolean;
  error?: EmailOutboxError;
  data?: { emailId: string; auditId: string; mailbox: string; direction: string };
}

export function buildEmailOutboxError(code: EmailOutboxErrorCode, message: string): EmailOutboxError {
  return { code, message };
}

function validateComposeInput(input: EmailComposeInput): { ok: boolean; error?: EmailOutboxError } {
  if (!input) return { ok: false, error: buildEmailOutboxError('INVALID_INPUT', 'input is required') };
  if (!input.fromAddress) return { ok: false, error: buildEmailOutboxError('MISSING_FROM', 'fromAddress is required') };
  if (!Array.isArray(input.to) || input.to.length === 0) return { ok: false, error: buildEmailOutboxError('MISSING_RECIPIENT', 'to must be a non-empty array') };
  if (!input.subject || !String(input.subject).trim()) return { ok: false, error: buildEmailOutboxError('MISSING_SUBJECT', 'subject is required') };
  if ((!input.bodyText || !String(input.bodyText).trim()) && (!input.bodyHtml || !String(input.bodyHtml).trim())) {
    return { ok: false, error: buildEmailOutboxError('MISSING_BODY', 'bodyText or bodyHtml is required') };
  }
  return { ok: true };
}

function generateEmailId(): string {
  const short = crypto.randomBytes(6).toString('base64url').toUpperCase();
  return `EML__${short}`;
}

function nowBigInt(): bigint {
  return BigInt(Date.now());
}

export interface CreateOutboxEmailParams {
  prisma: PrismaClient;
  input: EmailComposeInput;
  actorId?: string;
  ip?: string | null;
}

export async function createOutboxEmail(params: CreateOutboxEmailParams): Promise<EmailMutationResult> {
  const { prisma, input, actorId, ip } = params;
  const validation = validateComposeInput(input);
  if (!validation.ok) return { ok: false, error: validation.error };

  const now = nowBigInt();
  const emailId = generateEmailId();

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const email = await tx.email.create({
        data: {
          id: emailId,
          messageId: null,
          direction: 'outbound',
          status: 'read',
          fromAddress: input.fromAddress,
          fromName: input.fromName || null,
          toAddresses: JSON.stringify(input.to),
          ccAddresses: input.cc ? JSON.stringify(input.cc) : null,
          bccAddresses: input.bcc ? JSON.stringify(input.bcc) : null,
          subject: input.subject,
          bodyText: input.bodyText || null,
          bodyHtml: input.bodyHtml || null,
          mailbox: 'Outbox',
          mailboxOwnerUserId: actorId || null,
          threadId: input.threadId || null,
          sentAt: null,
          relationId: input.relationId || null,
          relationName: input.relationName || null,
          orderId: input.orderId || null,
          orderPo: input.orderPo || null,
          invoiceId: input.invoiceId || null,
          invoiceNumber: input.invoiceNumber || null,
          hasAttachments: false,
          attachmentCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      });

      try {
        await syncEmailReferences(prisma, email, { source: 'route:email:compose', tx });
      } catch (syncErr: any) {
        throw Object.assign(new Error('syncEmailReferences failed'), { code: 'SYNC_REF_FAILED', inner: syncErr });
      }

      let auditId = '';
      try {
        auditId = await writeRouteAuditLog({
          prisma: tx, actorId: actorId || 'api', source: 'route:email:compose',
          operation: 'create_outbox_email', targetType: 'Email', targetId: email.id,
          after: { id: email.id, direction: 'outbound', mailbox: 'Outbox', to: input.to, subject: input.subject },
          ip: ip || null,
        });
      } catch (auditErr: any) {
        throw Object.assign(new Error('audit failed'), { code: 'AUDIT_FAILED', inner: auditErr });
      }

      return { emailId: email.id, auditId };
    });

    return { ok: true, data: { emailId: result.emailId, auditId: result.auditId, mailbox: 'Outbox', direction: 'outbound' } };
  } catch (e: any) {
    if (e?.code === 'SYNC_REF_FAILED') return { ok: false, error: buildEmailOutboxError('SYNC_REF_FAILED', String(e?.inner?.message ?? e?.message)) };
    if (e?.code === 'AUDIT_FAILED') return { ok: false, error: buildEmailOutboxError('AUDIT_FAILED', String(e?.inner?.message ?? e?.message)) };
    return { ok: false, error: buildEmailOutboxError('CREATE_FAILED', String(e?.message ?? e)) };
  }
}

export interface CreateReplyOutboxEmailParams {
  prisma: PrismaClient;
  input: EmailReplyInput;
  actorId?: string;
  ip?: string | null;
}

export async function createReplyOutboxEmail(params: CreateReplyOutboxEmailParams): Promise<EmailMutationResult> {
  const { prisma, input, actorId, ip } = params;

  if (!input?.originalEmailId) return { ok: false, error: buildEmailOutboxError('INVALID_INPUT', 'originalEmailId is required') };

  const validation = validateComposeInput(input);
  if (!validation.ok) return { ok: false, error: validation.error };

  const now = nowBigInt();
  const emailId = generateEmailId();

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const original = await tx.email.findUnique({ where: { id: input.originalEmailId }, select: { id: true, deletedAt: true, threadId: true, messageId: true, subject: true } }).catch(() => null);
      if (!original || original.deletedAt) {
        throw Object.assign(new Error(`original email ${input.originalEmailId} not found or deleted`), { code: 'ORIGINAL_EMAIL_NOT_FOUND' });
      }
      const threadId = input.threadId || original.threadId || null;

      const email = await tx.email.create({
        data: {
          id: emailId,
          messageId: null,
          direction: 'outbound',
          status: 'read',
          fromAddress: input.fromAddress,
          fromName: input.fromName || null,
          toAddresses: JSON.stringify(input.to),
          ccAddresses: input.cc ? JSON.stringify(input.cc) : null,
          bccAddresses: input.bcc ? JSON.stringify(input.bcc) : null,
          subject: input.subject,
          bodyText: input.bodyText || null,
          bodyHtml: input.bodyHtml || null,
          mailbox: 'Outbox',
          mailboxOwnerUserId: actorId || null,
          threadId: threadId,
          sentAt: null,
          relationId: input.relationId || null,
          relationName: input.relationName || null,
          orderId: input.orderId || null,
          orderPo: input.orderPo || null,
          invoiceId: input.invoiceId || null,
          invoiceNumber: input.invoiceNumber || null,
          hasAttachments: false,
          attachmentCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      });

      try {
        await syncEmailReferences(prisma, email, { source: 'route:email:reply', tx });
      } catch (syncErr: any) {
        throw Object.assign(new Error('syncEmailReferences failed'), { code: 'SYNC_REF_FAILED', inner: syncErr });
      }

      let auditId = '';
      try {
        auditId = await writeRouteAuditLog({
          prisma: tx, actorId: actorId || 'api', source: 'route:email:reply',
          operation: 'create_reply_outbox_email', targetType: 'Email', targetId: email.id,
          after: { id: email.id, direction: 'outbound', mailbox: 'Outbox', to: input.to, subject: input.subject, originalEmailId: input.originalEmailId, threadId },
          ip: ip || null,
        });
      } catch (auditErr: any) {
        throw Object.assign(new Error('audit failed'), { code: 'AUDIT_FAILED', inner: auditErr });
      }

      return { emailId: email.id, auditId };
    });

    return { ok: true, data: { emailId: result.emailId, auditId: result.auditId, mailbox: 'Outbox', direction: 'outbound' } };
  } catch (e: any) {
    if (e?.code === 'ORIGINAL_EMAIL_NOT_FOUND') return { ok: false, error: buildEmailOutboxError('ORIGINAL_EMAIL_NOT_FOUND', String(e?.message ?? e)) };
    if (e?.code === 'SYNC_REF_FAILED') return { ok: false, error: buildEmailOutboxError('SYNC_REF_FAILED', String(e?.inner?.message ?? e?.message)) };
    if (e?.code === 'AUDIT_FAILED') return { ok: false, error: buildEmailOutboxError('AUDIT_FAILED', String(e?.inner?.message ?? e?.message)) };
    return { ok: false, error: buildEmailOutboxError('CREATE_FAILED', String(e?.message ?? e)) };
  }
}
