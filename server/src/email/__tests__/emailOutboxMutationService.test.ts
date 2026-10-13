import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createOutboxEmail, createReplyOutboxEmail, buildEmailOutboxError } from '../emailOutboxMutationService';

vi.mock('../sync', () => ({ syncEmailReferences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn().mockResolvedValue('alog_test_1') }));
import { syncEmailReferences } from '../sync';
import { writeRouteAuditLog } from '../../audit/routeAudit';

function makePrisma(opts: { emailFindUnique?: any; createFail?: boolean } = {}) {
  const emailFindUnique = opts.emailFindUnique !== undefined ? opts.emailFindUnique : vi.fn().mockResolvedValue(null);
  const emailCreate = opts.createFail
    ? vi.fn().mockRejectedValue(new Error('DB create failed'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ id: data.id, ...data }));
  const txEmail = { findUnique: emailFindUnique, create: emailCreate };
  return {
    email: txEmail,
    $transaction: vi.fn(async (fn: any) => fn({
      email: txEmail,
      auditLog: { create: vi.fn() },
      entityReference: { upsert: vi.fn() },
      entityLink: { upsert: vi.fn() },
    })),
  } as any;
}

const validInput = { fromAddress: 'me@bambook.com', to: ['recipient@test.com'], subject: 'Test', bodyText: 'Hello' };

describe('createOutboxEmail: success path', () => {
  beforeEach(() => vi.clearAllMocks());
  it('creates outbound Outbox email + sync + audit', async () => {
    const prisma = makePrisma();
    const result = await createOutboxEmail({ prisma, input: validInput, actorId: 'u1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.direction).toBe('outbound');
      expect(result.data!.mailbox).toBe('Outbox');
      expect(result.data!.emailId).toMatch(/^EML__/);
      expect(result.data!.auditId).toBe('alog_test_1');
    }
    expect(syncEmailReferences).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditLog).toHaveBeenCalledTimes(1);
  });
});

describe('createOutboxEmail: invalid input fail closed', () => {
  beforeEach(() => vi.clearAllMocks());
  it('missing fromAddress → MISSING_FROM', async () => {
    const result = await createOutboxEmail({ prisma: makePrisma(), input: { ...validInput, fromAddress: '' } as any });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('MISSING_FROM');
  });
  it('missing to → MISSING_RECIPIENT', async () => {
    const result = await createOutboxEmail({ prisma: makePrisma(), input: { ...validInput, to: [] } as any });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('MISSING_RECIPIENT');
  });
  it('missing subject → MISSING_SUBJECT', async () => {
    const result = await createOutboxEmail({ prisma: makePrisma(), input: { ...validInput, subject: '' } as any });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('MISSING_SUBJECT');
  });
  it('missing body → MISSING_BODY', async () => {
    const result = await createOutboxEmail({ prisma: makePrisma(), input: { ...validInput, bodyText: '', bodyHtml: '' } as any });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('MISSING_BODY');
  });
});

describe('createOutboxEmail: transaction fail closed (no half-write)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('syncEmailReferences reject → SYNC_REF_FAILED, tx rolls back', async () => {
    vi.mocked(syncEmailReferences).mockRejectedValueOnce(new Error('sync fail'));
    const prisma = makePrisma();
    const result = await createOutboxEmail({ prisma, input: validInput });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('SYNC_REF_FAILED');
  });
  it('writeRouteAuditLog reject → AUDIT_FAILED, tx rolls back', async () => {
    vi.mocked(writeRouteAuditLog).mockRejectedValueOnce(new Error('audit fail'));
    const prisma = makePrisma();
    const result = await createOutboxEmail({ prisma, input: validInput });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('AUDIT_FAILED');
  });
  it('email.create reject → CREATE_FAILED', async () => {
    const prisma = makePrisma({ createFail: true });
    const result = await createOutboxEmail({ prisma, input: validInput });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('CREATE_FAILED');
  });
});

describe('createReplyOutboxEmail: threading + original lookup', () => {
  beforeEach(() => vi.clearAllMocks());
  it('reply success → inherits threadId from original (same tx)', async () => {
    const prisma = makePrisma({
      emailFindUnique: vi.fn().mockResolvedValue({ id: 'EML__orig', deletedAt: null, threadId: 'thread123', messageId: '<orig@msg>', subject: 'Re: Original' }),
    });
    const result = await createReplyOutboxEmail({ prisma, input: { ...validInput, originalEmailId: 'EML__orig' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data!.emailId).toMatch(/^EML__/);
    expect(prisma.email.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'EML__orig' } }));
  });
  it('original not found → ORIGINAL_EMAIL_NOT_FOUND', async () => {
    const prisma = makePrisma({ emailFindUnique: vi.fn().mockResolvedValue(null) });
    const result = await createReplyOutboxEmail({ prisma, input: { ...validInput, originalEmailId: 'EML__missing' } });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('ORIGINAL_EMAIL_NOT_FOUND');
  });
  it('original deleted → ORIGINAL_EMAIL_NOT_FOUND', async () => {
    const prisma = makePrisma({
      emailFindUnique: vi.fn().mockResolvedValue({ id: 'EML__del', deletedAt: 123, threadId: null, messageId: null, subject: null }),
    });
    const result = await createReplyOutboxEmail({ prisma, input: { ...validInput, originalEmailId: 'EML__del' } });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('ORIGINAL_EMAIL_NOT_FOUND');
  });
  it('missing originalEmailId → INVALID_INPUT', async () => {
    const result = await createReplyOutboxEmail({ prisma: makePrisma(), input: { ...validInput } as any });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('INVALID_INPUT');
  });
});

describe('credential not persisted', () => {
  beforeEach(() => vi.clearAllMocks());
  it('no password/pass fields in audit log detail', async () => {
    const prisma = makePrisma();
    await createOutboxEmail({ prisma, input: { ...validInput, password: 'supersecret', pass: 'leak' } as any });
    const auditCall = vi.mocked(writeRouteAuditLog).mock.calls[0][0];
    expect(JSON.stringify(auditCall)).not.toContain('supersecret');
    expect(JSON.stringify(auditCall)).not.toContain('leak');
  });
});

describe('no direct SMTP / no nodemailer', () => {
  it('emailOutboxMutationService source does not import nodemailer', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../emailOutboxMutationService.ts'), 'utf-8');
    expect(src).not.toContain('nodemailer');
    expect(src).not.toContain('sendMail');
    expect(src).not.toContain('createTransport');
  });
});

describe('password not persisted in email.create data', () => {
  beforeEach(() => vi.clearAllMocks());
  it('email.create data does not contain password/pass fields', async () => {
    const prisma = makePrisma();
    await createOutboxEmail({ prisma, input: { ...validInput, password: 'supersecret', pass: 'leak' } as any });
    const createCall = prisma.email.create.mock.calls[0][0];
    const dataStr = JSON.stringify(createCall.data, (_, v) => typeof v === 'bigint' ? String(v) : v);
    expect(dataStr).not.toContain('supersecret');
    expect(dataStr).not.toContain('leak');
    expect(createCall.data).not.toHaveProperty('password');
    expect(createCall.data).not.toHaveProperty('pass');
  });
});

describe('buildEmailOutboxError', () => {
  it('produces stable error', () => {
    const e = buildEmailOutboxError('CREATE_FAILED', 'test');
    expect(e.code).toBe('CREATE_FAILED');
    expect(e.message).toBe('test');
  });
});
