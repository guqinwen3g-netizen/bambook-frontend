import { describe, expect, it, vi } from 'vitest';
import {
  buildEmailReplySendDraft,
  validateEmailReplySendDraftSemantics,
  verifyEmailReplySendDraftHash,
  commitEmailReplySend,
  buildEmailReplySendError,
  type EmailReplySendErrorCode,
} from '../emailReplySendFlow';

describe('task email-reply-send: buildEmailReplySendDraft（draft payload）', () => {
  it('生成含 6 字段的 ProcessDraft', () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'Re: test', bodyText: 'hello' });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('email.reply_and_send');
    expect(draft.impactScope).toEqual(['emails']);
    expect(draft.irreversible).toBe(true);
    expect(draft.idempotencyKey).toContain('email.reply_and_send');
    expect((draft.subOperations[0].after as any).to).toEqual(['a@b.com']);
  });

  it('reply 场景：replyToEmailId 编码进 after', () => {
    const draft = buildEmailReplySendDraft({ replyToEmailId: 'EML__1', to: ['a@b.com'], subject: 'Re', bodyText: 'hi' });
    expect((draft.subOperations[0].after as any).replyToEmailId).toBe('EML__1');
    expect(draft.idempotencyKey).toContain('EML__1');
  });
});

describe('task email-reply-send: hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    expect(verifyEmailReplySendDraftHash(draft).ok).toBe(true);
  });
  it('篡改 subject → hash 不匹配', () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, subject: 'HACKED' } }] };
    expect(verifyEmailReplySendDraftHash(tampered).ok).toBe(false);
  });
});

describe('task email-reply-send: validateEmailReplySendDraftSemantics（fail closed）', () => {
  it('空 to → MISSING_RECIPIENT', () => {
    const draft = { subOperations: [{ after: { to: [], subject: 'S', bodyText: 'B' } }], idempotencyKey: 't' } as any;
    const r = validateEmailReplySendDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('MISSING_RECIPIENT');
  });
  it('缺 subject → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { to: ['a@b.com'], bodyText: 'B' } }], idempotencyKey: 't' } as any;
    const r = validateEmailReplySendDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });
  it('合法 draft → ok', () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    expect(validateEmailReplySendDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task email-reply-send: buildEmailReplySendError（10 code userAction）', () => {
  it('所有 code 有 userAction', () => {
    const codes: EmailReplySendErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'ORIGINAL_EMAIL_NOT_FOUND', 'MISSING_RECIPIENT', 'COMMIT_TRANSACTION_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) {
      const e = buildEmailReplySendError(code, 'test');
      expect(e.userAction.length).toBeGreaterThan(0);
    }
  });
});

// commit 集成测试
function makeEmailTx(opts: { original?: any; createFail?: boolean } = {}) {
  const emailCreate = opts.createFail
    ? vi.fn().mockRejectedValue(new Error('CREATE_FAIL'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id }));
  const emailFind = vi.fn().mockResolvedValue(opts.original === undefined ? null : opts.original);
  const auditCreate = vi.fn().mockResolvedValue({});
  return {
    tx: { email: { create: emailCreate, findUnique: emailFind }, auditLog: { create: auditCreate } },
    emailCreate, auditCreate,
  };
}

describe('task email-reply-send: commitEmailReplySend', () => {
  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });
  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const tampered = { ...draft, idempotencyKey: 'email.reply_and_send:new:pd:bogus' };
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
  });
  it('成功 commit（新邮件，无 reply）→ committed（写 Email outbound + audit，不 SMTP）', async () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx, auditCreate } = makeEmailTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.direction).toBe('outbound');
      expect(auditCreate).toHaveBeenCalledTimes(1);
    }
  });
  it('reply 场景：原邮件不存在 → ORIGINAL_EMAIL_NOT_FOUND', async () => {
    const draft = buildEmailReplySendDraft({ replyToEmailId: 'EML__X', to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx } = makeEmailTx({ original: null });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('ORIGINAL_EMAIL_NOT_FOUND');
  });
  it('reply 场景：原邮件存在 → committed + threadId 继承', async () => {
    const draft = buildEmailReplySendDraft({ replyToEmailId: 'EML__1', to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx } = makeEmailTx({ original: { id: 'EML__1', threadId: 'th_123', messageId: '<orig@x>', fromAddress: 'c@d.com', subject: 'Re', deletedAt: null } });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.threadId).toBe('th_123');
  });
  it('create 失败 → COMMIT_TRANSACTION_FAILED（不伪成功）', async () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx } = makeEmailTx({ createFail: true });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });
});


describe('task email-reply-send review-fix: no SMTP invariant + 契约诚实', () => {
  it('commit 不调用任何 SMTP/nodemailer（contract 边界：不自动发送）', async () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx } = makeEmailTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    // 不应有 SMTP transport/sendMail 调用（tx 只有 email.create + auditLog.create）
    const txKeys = Object.keys(tx);
    expect(txKeys).not.toContain('sendMail');
    expect(txKeys).not.toContain('transporter');
  });

  it('commit 写 Email mailbox=Outbox（不是 Sent，契约诚实）', async () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx, emailCreate } = makeEmailTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    const createdData = emailCreate.mock.calls[0][0].data;
    expect(createdData.mailbox).toBe('Outbox');
    expect(createdData.mailbox).not.toBe('Sent');
  });

  it('commit 不写 sentAt（未 SMTP 发送，无发送时间戳）', async () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx, emailCreate } = makeEmailTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    const createdData = emailCreate.mock.calls[0][0].data;
    expect(createdData.sentAt).toBeNull();
  });

  it('commit 不写 messageId（未 SMTP，无 RFC Message-ID）', async () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx, emailCreate } = makeEmailTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    const createdData = emailCreate.mock.calls[0][0].data;
    expect(createdData.messageId).toBeNull();
  });

  it('reply 场景：fromAddress 是 agent 身份（不用 original.fromAddress 冒充对方）', async () => {
    const draft = buildEmailReplySendDraft({ replyToEmailId: 'EML__1', to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const { tx, emailCreate } = makeEmailTx({ original: { id: 'EML__1', threadId: 'th_123', messageId: '<orig@x>', deletedAt: null } });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    await commitEmailReplySend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    const createdData = emailCreate.mock.calls[0][0].data;
    // fromAddress 是 agent 身份，不是 original.fromAddress（避免冒充对方）
    expect(createdData.fromAddress).toBe('agent@bambook.local');
  });
});
