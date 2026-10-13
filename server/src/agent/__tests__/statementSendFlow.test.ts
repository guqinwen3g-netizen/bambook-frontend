import { describe, expect, it, vi } from 'vitest';
import {
  buildStatementSendDraft,
  validateStatementSendDraftSemantics,
  verifyStatementSendDraftHash,
  commitStatementSend,
  buildStatementSendError,
  statementHasActivity,
  renderStatementBody,
  type StatementSendFlowErrorCode,
} from '../statementSendFlow';
import type { CustomerStatement } from '../../finance/reportService';

const SNAPSHOT: CustomerStatement = {
  customerRelationId: 'R1',
  customerName: 'Peerless',
  from: '2026-08-01',
  to: '2026-08-31',
  sections: [
    {
      currency: 'USD',
      openingBalance: 1000,
      closingBalance: 1500,
      transactions: [
        { date: '2026-08-05', kind: 'invoice', number: 'INV-1', debit: 800, credit: 0, balance: 1800 },
        { date: '2026-08-12', kind: 'receipt', number: 'PAY-1', debit: 0, credit: 300, balance: 1500 },
      ],
    },
  ],
};

const VALID_INPUT = {
  customerRelationId: 'R1',
  customerName: 'Peerless',
  from: '2026-08-01',
  to: '2026-08-31',
  email: { to: ['finance@peerless.com'], subject: 'Statement of Account 2026-08' },
  statementSnapshot: SNAPSHOT,
};

describe('task statement-send-flow: statementHasActivity / renderStatementBody（纯函数口径）', () => {
  it('sections 为空 → 无往来', () => {
    expect(statementHasActivity({ ...SNAPSHOT, sections: [] })).toBe(false);
  });
  it('全部 section 无交易且期初为 0 → 无往来', () => {
    expect(statementHasActivity({ ...SNAPSHOT, sections: [{ currency: 'USD', openingBalance: 0, closingBalance: 0, transactions: [] }] })).toBe(false);
  });
  it('仅有期初余额（往来自以前期间）→ 有往来', () => {
    expect(statementHasActivity({ ...SNAPSHOT, sections: [{ currency: 'USD', openingBalance: 500, closingBalance: 500, transactions: [] }] })).toBe(true);
  });
  it('渲染正文含客户/期间/期初/逐笔/期末', () => {
    const body = renderStatementBody({ customerName: 'Peerless', from: '2026-08-01', to: '2026-08-31', snapshot: SNAPSHOT });
    expect(body).toContain('Peerless');
    expect(body).toContain('2026-08-01 ~ 2026-08-31');
    expect(body).toContain('期初余额 1,000.00');
    expect(body).toContain('INV-1');
    expect(body).toContain('PAY-1');
    expect(body).toContain('期末余额 1,500.00');
  });
  it('无 from/to → 期间显示 期初~至今', () => {
    const body = renderStatementBody({ customerName: null, from: null, to: null, snapshot: SNAPSHOT });
    expect(body).toContain('期初 ~ 至今');
  });
});

describe('task statement-send-flow: buildStatementSendDraft（审批即所得：快照入 draft）', () => {
  it('生成含 customerRelationId + email + 完整快照的 ProcessDraft', () => {
    const draft = buildStatementSendDraft(VALID_INPUT);
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('statement.send');
    const after = draft.subOperations[0].after as any;
    expect(after.customerRelationId).toBe('R1');
    expect(after.email.to).toEqual(['finance@peerless.com']);
    expect(after.email.subject).toBe('Statement of Account 2026-08');
    expect(after.statementSnapshot.sections[0].transactions).toHaveLength(2);
    expect(draft.impactScope).toEqual(['finance', 'emails']);
    expect(draft.irreversible).toBe(false);
    expect(draft.idempotencyKey.startsWith('statement.send:R1:2026-08-01:2026-08-31:')).toBe(true);
  });
});

describe('task statement-send-flow: hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildStatementSendDraft(VALID_INPUT);
    expect(verifyStatementSendDraftHash(draft).ok).toBe(true);
  });
  it('篡改快照期末余额 → hash 不匹配', () => {
    const draft = buildStatementSendDraft(VALID_INPUT);
    const tamperedSnapshot = { ...SNAPSHOT, sections: [{ ...SNAPSHOT.sections[0], closingBalance: 9999 }] };
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, statementSnapshot: tamperedSnapshot } }] };
    expect(verifyStatementSendDraftHash(tampered).ok).toBe(false);
  });
});

describe('task statement-send-flow: validateStatementSendDraftSemantics（fail closed）', () => {
  it('缺 customerRelationId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { email: { to: ['a@b.com'], subject: 'S' }, statementSnapshot: SNAPSHOT } }], idempotencyKey: 't' } as any;
    const r = validateStatementSendDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });
  it('email.to 空数组 → EMAIL_REQUIRED', () => {
    const draft = { subOperations: [{ after: { customerRelationId: 'R1', email: { to: [], subject: 'S' }, statementSnapshot: SNAPSHOT } }], idempotencyKey: 't' } as any;
    const r = validateStatementSendDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('EMAIL_REQUIRED');
  });
  it('缺 email.subject → EMAIL_REQUIRED', () => {
    const draft = { subOperations: [{ after: { customerRelationId: 'R1', email: { to: ['a@b.com'] }, statementSnapshot: SNAPSHOT } }], idempotencyKey: 't' } as any;
    const r = validateStatementSendDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('EMAIL_REQUIRED');
  });
  it('快照无往来 → STATEMENT_EMPTY', () => {
    const empty = { ...SNAPSHOT, sections: [] };
    const draft = { subOperations: [{ after: { customerRelationId: 'R1', email: { to: ['a@b.com'], subject: 'S' }, statementSnapshot: empty } }], idempotencyKey: 't' } as any;
    const r = validateStatementSendDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('STATEMENT_EMPTY');
  });
  it('合法 draft 通过', () => {
    const draft = buildStatementSendDraft(VALID_INPUT);
    expect(validateStatementSendDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task statement-send-flow: error code userAction 覆盖', () => {
  it('所有 code 有 userAction', () => {
    const codes: StatementSendFlowErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'EMAIL_REQUIRED', 'STATEMENT_EMPTY', 'COMMIT_TRANSACTION_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) expect(buildStatementSendError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});

function makeTx(opts: { emailFail?: boolean } = {}) {
  const emailCreate = opts.emailFail
    ? vi.fn().mockRejectedValue(new Error('EMAIL_FAIL'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id }));
  const auditCreate = vi.fn().mockResolvedValue({});
  return { tx: { email: { create: emailCreate }, auditLog: { create: auditCreate } }, emailCreate, auditCreate };
}

describe('task statement-send-flow: commitStatementSend（零重算：仅从 draft 快照渲染）', () => {
  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitStatementSend({ prisma, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = buildStatementSendDraft(VALID_INPUT);
    const tampered = { ...draft, idempotencyKey: 'statement.send:R1:2026-08-01:2026-08-31:pd:bogus' };
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitStatementSend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
  });

  it('成功 commit → 写 outbound/Outbox 邮件（正文=快照渲染）+ audit，不 SMTP', async () => {
    const draft = buildStatementSendDraft(VALID_INPUT);
    const { tx, emailCreate, auditCreate } = makeTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitStatementSend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.customerRelationId).toBe('R1');
      expect(r.feedback.emailId).toMatch(/^EML__/);
      expect(r.feedback.idempotencyKey).toBe(draft.idempotencyKey);
    }
    expect(emailCreate).toHaveBeenCalledTimes(1);
    const emailData = emailCreate.mock.calls[0][0].data;
    expect(emailData.direction).toBe('outbound');
    expect(emailData.mailbox).toBe('Outbox');
    expect(emailData.sentAt).toBeNull();
    expect(emailData.messageId).toBeNull();
    expect(emailData.relationId).toBe('R1');
    expect(emailData.toAddresses).toBe(JSON.stringify(['finance@peerless.com']));
    expect(emailData.subject).toBe('Statement of Account 2026-08');
    expect(emailData.bodyText).toContain('INV-1');
    expect(emailData.bodyText).toContain('期末余额 1,500.00');
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('email.create 失败 → COMMIT_TRANSACTION_FAILED（事务回滚，不伪成功）', async () => {
    const draft = buildStatementSendDraft(VALID_INPUT);
    const { tx } = makeTx({ emailFail: true });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitStatementSend({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });
});
