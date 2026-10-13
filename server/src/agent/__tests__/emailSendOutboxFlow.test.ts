import { approvalContext } from './emailOutboxApprovalFixture';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildEmailSendOutboxDraft,
  validateEmailSendOutboxDraftSemantics,
  verifyEmailSendOutboxDraftHash,
  commitEmailSendOutbox,
  buildEmailSendOutboxError,
  type EmailSendOutboxErrorCode,
} from '../emailSendOutboxFlow';

// mock sendOutboxEmail（不直接 nodemailer，验证走共用 service）
vi.mock('../../email/outboxSend', () => ({
  sendOutboxEmail: vi.fn(),
}));
import { sendOutboxEmail } from '../../email/outboxSend';

describe('task email-send-outbox: buildEmailSendOutboxDraft（引用 Outbox emailId）', () => {
  it('生成含 6 字段 ProcessDraft，emailId 编码进 after', () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('email.send');
    expect((draft.subOperations[0].after as any).emailId).toBe('EML__1');
    expect(draft.impactScope).toEqual(['emails']);
    expect(draft.irreversible).toBe(true);
  });

  it('审批冻结服务器原邮件内容，不能从任意工具输入构造邮件体', () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    const after = draft.subOperations[0].after as any;
    expect(after.emailId).toBe('EML__1');
    expect(after.credentialsUser).toBe('a@b.com');
    expect(after.subject).toBeUndefined();
    expect(after.bodyText).toBeUndefined();
    expect(after.contentHash).toBe(approvalContext.contentHash);
    expect(after.content).toEqual(approvalContext.content);
  });
});

describe('task email-send-outbox: hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    expect(verifyEmailSendOutboxDraftHash(draft).ok).toBe(true);
  });
  it('篡改 emailId → hash 不匹配', () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, emailId: 'HACKED' } }] };
    expect(verifyEmailSendOutboxDraftHash(tampered).ok).toBe(false);
  });
});

describe('task email-send-outbox: validateEmailSendOutboxDraftSemantics（fail closed）', () => {
  it('缺 emailId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { credentialsUser: 'a@b.com' } }], idempotencyKey: 't' } as any;
    expect(validateEmailSendOutboxDraftSemantics(draft).ok).toBe(false);
  });
  it('缺 credentialsUser → MISSING_CREDENTIALS', () => {
    const draft = { subOperations: [{ toolId: 'email.send', action: 'send_outbox_email', entityId: 'EML__1', after: { emailId: 'EML__1' } }], idempotencyKey: 't' } as any;
    const r = validateEmailSendOutboxDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('MISSING_CREDENTIALS');
  });
  it('合法 draft → ok', () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    expect(validateEmailSendOutboxDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task email-send-outbox: error code → userAction（含 B67 的 EMAIL_READ_FAILED）', () => {
  it('所有 code 有 userAction', () => {
    const codes: EmailSendOutboxErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'EMAIL_NOT_FOUND', 'EMAIL_NOT_OUTBOUND', 'EMAIL_NOT_OUTBOX', 'EMAIL_ALREADY_SENT', 'MISSING_RECIPIENT', 'MISSING_CREDENTIALS', 'SMTP_SEND_FAILED', 'SMTP_MESSAGE_ID_MISSING', 'DB_UPDATE_FAILED', 'EMAIL_READ_FAILED', 'UNKNOWN_ERROR', 'SEND_LEDGER_UNAVAILABLE', 'SEND_IN_PROGRESS', 'SEND_RESULT_UNCERTAIN', 'SEND_CONTENT_CHANGED', 'SEND_RECEIPT_INVALID', 'SEND_ACTOR_REQUIRED', 'SEND_PERMISSION_DENIED', 'ATTACHMENT_NOT_READY'];
    for (const code of codes) expect(buildEmailSendOutboxError(code, 'test').userAction.length).toBeGreaterThan(0);
  });

  it('★ 表外码（将来 service 新增而这张表漏同步）也不许给 undefined ⇒ 反的是 B67 这一族', () => {
    const e = buildEmailSendOutboxError('A_CODE_NOBODY_MAPPED' as any, 'raw');
    expect(typeof e.userAction).toBe('string');
    expect(e.userAction.length, 'userAction 为 undefined 时，工具反馈会是一句没有建议的失败').toBeGreaterThan(0);
  });
});

describe('task email-send-outbox: commitEmailSendOutbox（调 sendOutboxEmail，不绕 DB）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const prisma = {} as any;
    const r = await commitEmailSendOutbox({ actorId: 'u1', requesterId: 'original-requester', trustedActor: { userId: 'u1', roles: ['admin'], permissions: ['emails:write'], departmentIds: [] }, prisma, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    const tampered = { ...draft, idempotencyKey: 'email.send:EML__1:pd:bogus' };
    const prisma = {} as any;
    const r = await commitEmailSendOutbox({ actorId: 'u1', requesterId: 'original-requester', trustedActor: { userId: 'u1', roles: ['admin'], permissions: ['emails:write'], departmentIds: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
  });

  it('成功 commit（sendOutboxEmail ok）→ committed', async () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    (sendOutboxEmail as any).mockResolvedValue({ ok: true, data: { emailId: 'EML__1', messageId: '<msg@x>', sentAt: '2026-06-29 12:00:00', auditId: 'a1' } });
    const prisma = {} as any;
    const r = await commitEmailSendOutbox({ actorId: 'u1', requesterId: 'original-requester', trustedActor: { userId: 'u1', roles: ['admin'], permissions: ['emails:write'], departmentIds: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft }, credentialsPassword: 'p' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.messageId).toBe('<msg@x>');
    }
    // 验证调用 sendOutboxEmail（不绕 DB，不直接 nodemailer）
    expect(sendOutboxEmail).toHaveBeenCalledTimes(1);
  });

  it('sendOutboxEmail 失败（SMTP_SEND_FAILED）→ failed，不伪 committed', async () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    (sendOutboxEmail as any).mockResolvedValue({ ok: false, error: { code: 'SMTP_SEND_FAILED', message: 'conn refused', statusCode: 502 } });
    const prisma = {} as any;
    const r = await commitEmailSendOutbox({ actorId: 'u1', requesterId: 'original-requester', trustedActor: { userId: 'u1', roles: ['admin'], permissions: ['emails:write'], departmentIds: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft }, credentialsPassword: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('SMTP_SEND_FAILED');
  });

  it('sendOutboxEmail 失败（EMAIL_NOT_OUTBOX）→ failed', async () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    (sendOutboxEmail as any).mockResolvedValue({ ok: false, error: { code: 'EMAIL_NOT_OUTBOX', message: 'not outbox', statusCode: 400 } });
    const prisma = {} as any;
    const r = await commitEmailSendOutbox({ actorId: 'u1', requesterId: 'original-requester', trustedActor: { userId: 'u1', roles: ['admin'], permissions: ['emails:write'], departmentIds: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft }, credentialsPassword: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('EMAIL_NOT_OUTBOX');
  });

  it('no direct nodemailer bypass：commit 只调 sendOutboxEmail，不直接 import nodemailer', async () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    (sendOutboxEmail as any).mockResolvedValue({ ok: true, data: { emailId: 'EML__1', messageId: '<m@x>', sentAt: '2026-06-29 12:00:00', auditId: 'a1' } });
    const prisma = {} as any;
    await commitEmailSendOutbox({ actorId: 'u1', trustedActor: { userId: 'u1', roles: ['admin'], permissions: ['emails:write'], departmentIds: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft }, credentialsPassword: 'p' });
    // 唯一副作用入口是 sendOutboxEmail
    expect(sendOutboxEmail).toHaveBeenCalledTimes(1);
  });
});
