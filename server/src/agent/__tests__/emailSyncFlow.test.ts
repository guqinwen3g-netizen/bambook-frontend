import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  buildEmailSyncDraft,
  validateEmailSyncDraftSemantics,
  verifyEmailSyncDraftHash,
  commitEmailSync,
  buildEmailSyncError,
} from '../emailSyncFlow';

vi.mock('../../email/emailSyncService', () => ({
  syncEmailsFromImap: vi.fn(),
}));
import { syncEmailsFromImap } from '../../email/emailSyncService';

describe('task email-sync-flow: buildEmailSyncDraft', () => {
  it('produces 6-field ProcessDraft with pd: hash idempotencyKey', () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'user@bambook.com' });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].action).toBe('sync_imap_emails');
    expect(draft.impactScope).toEqual(['emails']);
    expect(draft.irreversible).toBe(false);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.beforeAfterDiff).toHaveLength(1);
    expect(draft.idempotencyKey).toContain(':pd:');
    expect(draft.idempotencyKey).toContain('email.sync:user@bambook.com');
  });
});

describe('task email-sync-flow: hash verification (anti-tamper)', () => {
  it('valid draft passes hash check', () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'a@b.com' });
    expect(verifyEmailSyncDraftHash(draft).ok).toBe(true);
  });

  it('tampered after.credentialsUser → hash mismatch', () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'a@b.com' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, credentialsUser: 'evil@b.com' } }] };
    expect(verifyEmailSyncDraftHash(tampered).ok).toBe(false);
  });

  it('tampered idempotencyKey → hash mismatch', () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'a@b.com' });
    const tampered = { ...draft, idempotencyKey: 'email.sync:a@b.com:pd:bogus' };
    expect(verifyEmailSyncDraftHash(tampered).ok).toBe(false);
  });
});

describe('task email-sync-flow: commitEmailSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('success → committed, syncEmailsFromImap called once', async () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'a@b.com' });
    vi.mocked(syncEmailsFromImap).mockResolvedValue({ ok: true, data: { synced: 5, skipped: 2, errors: 0, accountMasked: 'a***@b.com', auditIds: ['alog_1'] } });
    const result: any = await commitEmailSync({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, credentialsPassword: 'pass123' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feedback.synced).toBe(5);
      expect(result.feedback.accountMasked).toBe('a***@b.com');
    }
    expect(syncEmailsFromImap).toHaveBeenCalledTimes(1);
  });

  it('missing processDraft → fail closed', async () => {
    const result: any = await commitEmailSync({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {}, credentialsPassword: 'pass' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.feedback.error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('hash mismatch → fail closed, syncEmailsFromImap NOT called', async () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'a@b.com' });
    const tampered = { ...draft, idempotencyKey: 'email.sync:a@b.com:pd:bogus' };
    const result: any = await commitEmailSync({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered }, credentialsPassword: 'pass' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(syncEmailsFromImap).not.toHaveBeenCalled();
  });

  it('missing credentials (empty password) → fail closed, syncEmailsFromImap NOT called', async () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'a@b.com' });
    const result: any = await commitEmailSync({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, credentialsPassword: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.feedback.error.code).toBe('MISSING_CREDENTIALS');
    expect(syncEmailsFromImap).not.toHaveBeenCalled();
  });

  it('service failure (IMAP_CONNECT_FAILED) → mapped error, no pseudo-success', async () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'a@b.com' });
    vi.mocked(syncEmailsFromImap).mockResolvedValue({ ok: false, error: { code: 'IMAP_CONNECT_FAILED', message: 'conn refused' } });
    const result: any = await commitEmailSync({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, credentialsPassword: 'pass' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.feedback.error.code).toBe('IMAP_CONNECT_FAILED');
  });

  it('no password in error message', async () => {
    const draft = buildEmailSyncDraft({ credentialsUser: 'a@b.com' });
    vi.mocked(syncEmailsFromImap).mockResolvedValue({ ok: false, error: { code: 'IMAP_CONNECT_FAILED', message: 'sanitized' } });
    const result: any = await commitEmailSync({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, credentialsPassword: 'supersecret' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('supersecret');
  });
});

describe('task email-sync-flow: buildEmailSyncError', () => {
  it('produces stable error', () => {
    const e = buildEmailSyncError('COMMIT_FAILED', 'test');
    expect(e.code).toBe('COMMIT_FAILED');
    expect(e.message).toBe('test');
  });
});
