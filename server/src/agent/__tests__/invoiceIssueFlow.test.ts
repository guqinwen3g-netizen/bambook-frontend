import { describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
import {
  buildInvoiceIssueDraft,
  validateInvoiceIssueDraftSemantics,
  verifyInvoiceIssueDraftHash,
  commitInvoiceIssue,
  buildInvoiceIssueError,
  type InvoiceIssueErrorCode,
} from '../invoiceIssueFlow';

describe('task invoice-issue: buildInvoiceIssueDraft', () => {
  it('生成含 6 字段 ProcessDraft，status=Issued', () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-001', amount: 10000, currency: 'CNY' });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('finance.create_invoice');
    expect((draft.subOperations[0].after as any).status).toBe('Issued');
    expect(draft.impactScope).toEqual(['invoices']);
    expect(draft.irreversible).toBe(true);
    expect(draft.idempotencyKey).toContain('invoice.issue:INV-001');
  });

  it('beforeAfterDiff 记录 Draft→Issued 状态转移', () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-001', amount: 1000 });
    expect(draft.beforeAfterDiff[0].before).toBe('Draft');
    expect(draft.beforeAfterDiff[0].after).toBe('Issued');
  });
});

describe('task invoice-issue: hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-1', amount: 500 });
    expect(verifyInvoiceIssueDraftHash(draft).ok).toBe(true);
  });
  it('篡改 amount → hash 不匹配', () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-1', amount: 500 });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, amount: 99999 } }] };
    expect(verifyInvoiceIssueDraftHash(tampered).ok).toBe(false);
  });
});

describe('task invoice-issue: validateInvoiceIssueDraftSemantics（fail closed）', () => {
  it('缺 invoiceNumber → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { amount: 1000, status: 'Issued' } }], idempotencyKey: 't' } as any;
    expect(validateInvoiceIssueDraftSemantics(draft).ok).toBe(false);
  });
  it('amount <= 0 → INVALID_AMOUNT', () => {
    const draft = { subOperations: [{ after: { invoiceNumber: 'INV-1', amount: -50, status: 'Issued' } }], idempotencyKey: 't' } as any;
    const r = validateInvoiceIssueDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_AMOUNT');
  });
  it('非法 status（非 Draft→Issued）→ INVALID_TRANSITION', () => {
    const draft = { subOperations: [{ after: { invoiceNumber: 'INV-1', amount: 100, status: 'Paid' } }], idempotencyKey: 't' } as any;
    const r = validateInvoiceIssueDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_TRANSITION');
  });
  it('合法 draft（Draft→Issued）→ ok', () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-1', amount: 1000 });
    expect(validateInvoiceIssueDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task invoice-issue: 10 error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: InvoiceIssueErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'INVALID_TRANSITION', 'INVALID_AMOUNT', 'COMMIT_TRANSACTION_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) expect(buildInvoiceIssueError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});

// Unit storage seam: real current-authority helper runs against an explicit
// active account/role/grant tree. This does not establish PostgreSQL rollback.
const issueActor: TokenPayload = { userId: 'issue-current-operator', roles: ['finance'], departmentIds: [],
  permissions: ['invoices:write', 'emails:write'], authorizationLoaded: true,
  permissionCeiling: ['invoices:write', 'emails:write'] };
function issueAuthorityStorage() {
  const user = { id: issueActor.userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'role-finance', departmentId: null, role: { id: 'role-finance',
      permissions: issueActor.permissions!.map(scope => ({ permission: { scope } })) } }] };
  return { userAccount: { findUnique: vi.fn(async ({ where }: any) => where.id === user.id ? user : null) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) } };
}

// commit 集成测试
function makeInvoiceTx(opts: { createFail?: boolean; syncFail?: boolean } = {}, approvedDraft?: any) {
  const receipts = new Map<string, any>();
  const receiptStorage = { findUnique: vi.fn(async ({ where }: any) => receipts.get(where.idempotencyKey) ?? null),
    update: vi.fn(async ({ where, data }: any) => { const row = { ...receipts.get(where.idempotencyKey), ...data }; receipts.set(where.idempotencyKey, row); return row; }) };
  const query = vi.fn(async (sql: any) => {
    const statement = sql.strings.join('');
    if (statement.includes('INSERT INTO "AgentCommitReceipt"')) {
      const [id, key, approvalId] = sql.values; if (receipts.has(key)) return [];
      receipts.set(key, { id, idempotencyKey: key, toolId: 'invoice.issue', approvalId, status: 'committing', result: null }); return [{ id }];
    }
    if (statement.includes('FROM "AgentCommitReceipt"')) { const row = receipts.get(sql.values[0]); return row ? [{ id: row.id }] : []; }
    return [{ id: 'AP1' }];
  });
  const invoiceCreate = opts.createFail
    ? vi.fn().mockRejectedValue(new Error('CREATE_FAIL'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id }));
  const entityRefUpsert = opts.syncFail
    ? vi.fn().mockRejectedValue(new Error('SYNC_FAIL'))
    : vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});
  return {
    tx: { ...issueAuthorityStorage(), $queryRaw: query, agentCommitReceipt: receiptStorage,
      approvalRequest: { findUnique: vi.fn(async () => ({ id: 'AP1', requesterId: 'issue-original-requester', status: 'approved', actionType: 'tool:invoice.issue', payload: { processDraft: approvedDraft } })) }, invoice: { create: invoiceCreate }, email: { create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id })) }, auditLog: { create: auditCreate }, entityReference: { upsert: entityRefUpsert }, entityLink: { upsert: vi.fn().mockResolvedValue({}) } },
    invoiceCreate, auditCreate, entityRefUpsert,
  };
}

describe('task invoice-issue: commitInvoiceIssue', () => {
  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });
  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-1', amount: 500 });
    const tampered = { ...draft, idempotencyKey: 'invoice.issue:INV-1:pd:bogus' };
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
  });
  it('成功 commit → committed（status=Issued + sync + audit 同事务）', async () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-1', amount: 1000, customerRelationId: 'R1' });
    const { tx, auditCreate } = makeInvoiceTx({}, draft);
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.invoiceStatus).toBe('Issued');
      expect(auditCreate).toHaveBeenCalledTimes(1);
    }
  });
  it('sync reject → COMMIT_TRANSACTION_FAILED（不伪成功）', async () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-1', amount: 1000, customerRelationId: 'R1' });
    const { tx } = makeInvoiceTx({ syncFail: true }, draft);
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });
  it('create reject → COMMIT_TRANSACTION_FAILED', async () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-1', amount: 1000 });
    const { tx } = makeInvoiceTx({ createFail: true }, draft);
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });
});


describe('task invoice-issue review-fix: Outbox email 事实闭环（invoice + email 同事务）', () => {
  it('draft 含 email → 双 subOperation（invoice + outbox email）', () => {
    const draft = buildInvoiceIssueDraft({
      invoiceNumber: 'INV-1', amount: 1000,
      email: { to: ['c@d.com'], subject: '发票已开', bodyText: 'INV-1' },
    });
    expect(draft.subOperations).toHaveLength(2);
    expect(draft.subOperations[0].toolId).toBe('finance.create_invoice');
    expect(draft.subOperations[1].toolId).toBe('email.reply_and_send');
    expect((draft.subOperations[1].after as any).direction).toBe('outbound');
    expect((draft.subOperations[1].after as any).mailbox).toBe('Outbox');
    expect(draft.impactScope).toEqual(['invoices', 'emails']);
  });

  it('commit 写 Email(direction=outbound, mailbox=Outbox)', async () => {
    const draft = buildInvoiceIssueDraft({
      invoiceNumber: 'INV-1', amount: 1000, customerRelationId: 'R1',
      email: { to: ['c@d.com'], subject: '发票', bodyText: 'INV-1' },
    });
    const { tx } = makeInvoiceTx({}, draft);
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    // email.create 被调用（Outbox 写入）
    expect(tx.email.create).toHaveBeenCalledTimes(1);
    const emailData = tx.email.create.mock.calls[0][0].data;
    expect(emailData.direction).toBe('outbound');
    expect(emailData.mailbox).toBe('Outbox');
  });

  it('commit 不写 sentAt（Outbox 待发，不 SMTP）', async () => {
    const draft = buildInvoiceIssueDraft({
      invoiceNumber: 'INV-1', amount: 1000, customerRelationId: 'R1',
      email: { to: ['c@d.com'], subject: 'S', bodyText: 'B' },
    });
    const { tx } = makeInvoiceTx({}, draft);
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    const emailData = tx.email.create.mock.calls[0][0].data;
    expect(emailData.sentAt).toBeNull();
  });

  it('commit 不写 messageId（Outbox 待发，未 SMTP）', async () => {
    const draft = buildInvoiceIssueDraft({
      invoiceNumber: 'INV-1', amount: 1000, customerRelationId: 'R1',
      email: { to: ['c@d.com'], subject: 'S', bodyText: 'B' },
    });
    const { tx } = makeInvoiceTx({}, draft);
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    const emailData = tx.email.create.mock.calls[0][0].data;
    expect(emailData.messageId).toBeNull();
  });

  it('email.create 失败 → 整体回滚（COMMIT_TRANSACTION_FAILED）', async () => {
    const draft = buildInvoiceIssueDraft({
      invoiceNumber: 'INV-1', amount: 1000,
      email: { to: ['c@d.com'], subject: 'S', bodyText: 'B' },
    });
    const { tx } = makeInvoiceTx({}, draft);
    tx.email.create.mockRejectedValue(new Error('EMAIL_CREATE_FAIL'));
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });

  it('无 email（仅 invoice）→ 仍 committed（email 可选）', async () => {
    const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-1', amount: 1000, customerRelationId: 'R1' });
    const { tx } = makeInvoiceTx({}, draft);
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitInvoiceIssue({ prisma, actorId: issueActor.userId, trustedActor: issueActor, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    // email.create 不被调用
    expect(tx.email.create).not.toHaveBeenCalled();
  });
});
