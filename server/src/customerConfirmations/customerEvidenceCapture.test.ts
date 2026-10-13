import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const permissions = vi.hoisted(() => ({ scopes: ['emails:read'] as string[] }));
vi.mock('../auth/permissionService', async importOriginal => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createPermissionService: () => ({ getUserPermissionContext: async (userId: string) => ({
      userId, legacyRoleCodes: ['sales'], roleIds: ['role-sales'], scopes: permissions.scopes, departmentIds: [],
    }) }),
  };
});

let tempRoot = '';
let capture: typeof import('./customerEvidenceCapture');

beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-customer-evidence-test-'));
  process.env.BAMBOOK_PRIVATE_FILES_DIR = tempRoot;
  vi.resetModules();
  capture = await import('./customerEvidenceCapture');
});

afterAll(() => {
  delete process.env.BAMBOOK_PRIVATE_FILES_DIR;
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

const prior: any = { userId: 'synthetic-sales' };
const email = {
  id: 'EML__synthetic', messageId: '<synthetic@example.invalid>', direction: 'inbound',
  fromAddress: 'customer@example.invalid', fromName: 'Synthetic Customer', toAddresses: '["sales@example.invalid"]',
  ccAddresses: null, bccAddresses: null, replyToAddress: null, subject: 'Synthetic quote confirmation',
  bodyText: 'Price is 4.00. Please proceed with this version.', bodyHtml: '<p>Price is 4.00. Please proceed with this version.</p>',
  mailbox: 'INBOX', uid: 77, uidValidity: 'uid-validity-1', threadId: 'thread-1',
  sentAt: '2026-10-04T10:00:00.000Z', receivedAt: '2026-10-04T10:01:00.000Z',
  relationId: 'REL_SYNTHETIC', relationName: 'Synthetic Customer', orderId: 'ORD_SYNTHETIC', orderPo: 'PO-SYNTHETIC',
  invoiceId: null, invoiceNumber: null, labels: ['quote'], syncedAt: BigInt(1_800_000_000_000), deletedAt: null,
};

function emailTx(attachmentRows: any[] = [], foundEmail: any = email) {
  return {
    email: { findFirst: vi.fn(async ({ where }: any) => where.id === foundEmail?.id && !foundEmail?.deletedAt ? foundEmail : null) },
    emailAttachment: { findMany: vi.fn(async ({ where }: any) => attachmentRows.filter(row => !where?.id?.in || where.id.in.includes(row.id))) },
  } as any;
}

describe('customer evidence capture', () => {
  it('stores the full email snapshot and validates selected offsets against the authoritative DB body', async () => {
    const prepared = await capture.prepareCustomerConfirmationEvidence({
      tx: emailTx(), actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Please proceed', selectionStart: 15, selectionEnd: 29 },
    });
    expect(prepared.sourceType).toBe('email_selection');
    expect((prepared.sourceSnapshot as any).email).toMatchObject({
      id: email.id, messageId: email.messageId, bodyText: email.bodyText, bodyHtml: email.bodyHtml,
      orderId: email.orderId, relationId: email.relationId, uidValidity: email.uidValidity,
    });
    expect(prepared.selectionSnapshot).toMatchObject({ selectionStart: 15, selectionEnd: 29, selectedText: 'Please proceed' });
    expect(prepared.blobs).toEqual([]);
    expect(fs.existsSync(path.join(tempRoot, 'customer-confirmations'))).toBe(false);

    await expect(capture.prepareCustomerConfirmationEvidence({
      tx: emailTx(), actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'wrong excerpt', selectionStart: 15, selectionEnd: 29 },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps the reusable email source snapshot separate from per-confirmation selected text', async () => {
    const first = await capture.prepareCustomerConfirmationEvidence({ tx: emailTx(), actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Price is 4.00', selectionStart: 0, selectionEnd: 13 } });
    const second = await capture.prepareCustomerConfirmationEvidence({ tx: emailTx(), actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Please proceed', selectionStart: 15, selectionEnd: 29 } });
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(second.sourceSnapshot).toEqual(first.sourceSnapshot);
    expect(second.selectionSnapshot).not.toEqual(first.selectionSnapshot);
  });

  it('keeps email attachment-set versions aligned with their source fingerprint', async () => {
    const bytes = Buffer.from('synthetic attachment for source-version checks');
    const attachmentDirectory = path.join(tempRoot, 'email-attachments');
    fs.mkdirSync(attachmentDirectory, { recursive: true });
    fs.writeFileSync(path.join(attachmentDirectory, 'version.pdf'), bytes);
    const attachmentA = { id: 'EMLATT__a', emailId: email.id, filename: 'quote-v1.pdf', contentType: 'application/pdf',
      fileSize: bytes.length, filePath: 'email-attachments/version.pdf', contentId: null, isInline: false };
    const attachmentB = { ...attachmentA, id: 'EMLATT__b', filename: 'spec-v1.pdf' };
    const tx = emailTx([attachmentA, attachmentB]);
    const firstExcerpt = await capture.prepareCustomerConfirmationEvidence({ tx, actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Price is 4.00', selectionStart: 0, selectionEnd: 13,
        attachmentIds: [attachmentA.id] } });
    const secondExcerpt = await capture.prepareCustomerConfirmationEvidence({ tx, actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Please proceed', selectionStart: 15, selectionEnd: 29,
        attachmentIds: [attachmentA.id] } });
    const otherAttachmentSet = await capture.prepareCustomerConfirmationEvidence({ tx, actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Please proceed', selectionStart: 15, selectionEnd: 29,
        attachmentIds: [attachmentB.id] } });

    expect(secondExcerpt.sourceFingerprint).toBe(firstExcerpt.sourceFingerprint);
    expect(secondExcerpt.sourceSnapshot).toEqual(firstExcerpt.sourceSnapshot);
    expect(secondExcerpt.selectionSnapshot).not.toEqual(firstExcerpt.selectionSnapshot);
    expect(otherAttachmentSet.sourceFingerprint).not.toBe(firstExcerpt.sourceFingerprint);
    expect(otherAttachmentSet.sourceSnapshot).not.toEqual(firstExcerpt.sourceSnapshot);
  });

  it('rejects an email that is not a readable persisted DB object', async () => {
    await expect(capture.prepareCustomerConfirmationEvidence({
      tx: emailTx([], null), actor: prior,
      source: { kind: 'email_selection', emailId: 'external-mailbox-id', selectedText: 'x', selectionStart: 0, selectionEnd: 1 },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects outbound or deleted email as customer-confirmation source', async () => {
    await expect(capture.prepareCustomerConfirmationEvidence({
      tx: emailTx([], { ...email, direction: 'outbound' }), actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Please proceed', selectionStart: 15, selectionEnd: 29 },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(capture.prepareCustomerConfirmationEvidence({
      tx: emailTx([], { ...email, deletedAt: BigInt(1) }), actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Please proceed', selectionStart: 15, selectionEnd: 29 },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rechecks current emails:read authority before preparing the source snapshot', async () => {
    const priorScopes = permissions.scopes;
    permissions.scopes = [];
    try {
      await expect(capture.prepareCustomerConfirmationEvidence({
        tx: emailTx(), actor: prior,
        source: { kind: 'email_selection', emailId: email.id, selectedText: 'Please proceed', selectionStart: 15, selectionEnd: 29 },
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally { permissions.scopes = priorScopes; }
  });

  it('re-reads selected attachment bytes and ignores client-supplied fake version metadata', async () => {
    const bytes = Buffer.from('synthetic attachment content');
    const attachmentDirectory = path.join(tempRoot, 'email-attachments');
    fs.mkdirSync(attachmentDirectory, { recursive: true });
    fs.writeFileSync(path.join(attachmentDirectory, 'source.pdf'), bytes);
    const row = { id: 'EMLATT__synthetic', emailId: email.id, filename: 'quote.pdf', contentType: 'application/pdf',
      fileSize: bytes.length, filePath: 'email-attachments/source.pdf', contentId: null, isInline: false };
    const prepared = await capture.prepareCustomerConfirmationEvidence({
      tx: emailTx([row]), actor: prior,
      source: { kind: 'email_selection', emailId: email.id, selectedText: 'Please proceed', selectionStart: 15, selectionEnd: 29,
        attachmentIds: [row.id], attachmentVersions: [{ id: row.id, sha256: '0'.repeat(64) }] } as any,
    });
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    expect((prepared.selectionSnapshot as any).attachmentVersions).toEqual([{ id: row.id, sha256: sha }]);
    expect(prepared.blobs[0]).toMatchObject({ sha256: sha, byteSize: bytes.length, purpose: 'email_attachment', bytes });
    expect(fs.existsSync(path.join(tempRoot, 'customer-confirmations', sha))).toBe(false);
  });

  it('prepares a screenshot only in memory, reuses the same source across filenames, and rejects invalid originals', async () => {
    const screenshot = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
    const prepared = await capture.prepareCustomerConfirmationEvidence({ tx: {}, actor: prior,
      source: { kind: 'screenshot' }, file: { buffer: screenshot, originalname: '../customer.png', mimetype: 'image/png', size: screenshot.length } });
    const renamed = await capture.prepareCustomerConfirmationEvidence({ tx: {}, actor: prior,
      source: { kind: 'screenshot' }, file: { buffer: screenshot, originalname: 'renamed-proof.png', mimetype: 'image/png', size: screenshot.length } });
    expect(prepared.blobs[0].bytes).toEqual(screenshot);
    expect((prepared.sourceSnapshot as any).originalName).toBeUndefined();
    expect(renamed.sourceFingerprint).toBe(prepared.sourceFingerprint);
    expect(renamed.sourceSnapshot).toEqual(prepared.sourceSnapshot);
    expect((prepared.selectionSnapshot as any).originalName).toBe('customer.png');
    expect((renamed.selectionSnapshot as any).originalName).toBe('renamed-proof.png');
    expect(renamed.blobs[0].sha256).toBe(prepared.blobs[0].sha256);
    expect(fs.existsSync(path.join(tempRoot, 'customer-confirmations'))).toBe(false);
    await expect(capture.prepareCustomerConfirmationEvidence({ tx: {}, actor: prior,
      source: { kind: 'screenshot' }, file: { buffer: Buffer.from('not-an-image'), originalname: 'fake.png', mimetype: 'image/png', size: 12 } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fs.existsSync(path.join(tempRoot, 'customer-confirmations'))).toBe(false);
  });

  it('cleans only bytes first created by a failed transaction while preserving an already referenced shared hash', async () => {
    const bytes = Buffer.from('synthetic screenshot bytes');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const storageKey = `customer-confirmations/${sha256}`;
    const prepared: any = { blobs: [{ bytes, sha256, storageKey, byteSize: bytes.length,
      purpose: 'screenshot', fileName: 'proof.png', mimeType: 'image/png', metadataSnapshot: {} }] };
    const actor = { userId: 'synthetic-sales' };
    const rows = new Map<string, any>();
    const tx: any = { $queryRawUnsafe: vi.fn(async () => []), customerEvidenceFile: {
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.sha256) ?? null),
      create: vi.fn(async ({ data }: any) => { rows.set(data.sha256, data); return data; }),
    } };
    const first = await capture.persistPreparedCustomerEvidenceBlobsInTx(tx, prepared, actor, 100);
    expect(first.newlyCreatedStorageKeys).toEqual([storageKey]);
    expect(fs.existsSync(path.join(tempRoot, 'customer-confirmations', sha256))).toBe(true);
    await capture.removeNewlyCreatedFilesWhileLocked(first.newlyCreatedStorageKeys);
    expect(fs.existsSync(path.join(tempRoot, 'customer-confirmations', sha256))).toBe(false);
    rows.delete(sha256); // model the surrounding DB transaction rolling back

    await capture.persistPreparedCustomerEvidenceBlobsInTx(tx, prepared, actor, 200);
    const shared = await capture.persistPreparedCustomerEvidenceBlobsInTx(tx, prepared, actor, 300);
    expect(shared.newlyCreatedStorageKeys).toEqual([]);
    await capture.removeNewlyCreatedFilesWhileLocked(shared.newlyCreatedStorageKeys);
    expect(fs.existsSync(path.join(tempRoot, 'customer-confirmations', sha256))).toBe(true);
  });
});
