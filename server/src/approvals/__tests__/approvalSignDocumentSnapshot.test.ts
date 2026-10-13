import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApprovalSignDocumentSnapshot, assertCurrentApprovalSignDocumentSnapshot,
  getApprovalSignDocumentSnapshot } from '../approvalSignDocumentSnapshotService';

function quotation() {
  return { id: 'q-1', quotationNumber: 'QT-2026-001', version: 7, status: 'Draft', currency: 'USD',
    totalAmount: new Prisma.Decimal('1250.1234'), issueDate: '2026-10-05', validUntil: '2026-10-31',
    deliveryTerms: 'FOB Shanghai', paymentTerms: '30% deposit, balance before shipment', salesperson: 'Mia',
    inquiryRef: 'INQ-2026-09', notes: '价格有效至本月底', customerName: 'Example Buyer', customerCode: 'BUY-01',
    customerRelationId: 'customer-1', deletedAt: null,
    lines: [{ id: 'ql-1', lineNumber: 1, fabricCode: 'FAB-1', description: 'Cotton twill', quantity: new Prisma.Decimal('10.125'),
      unit: 'M', unitPrice: new Prisma.Decimal('123.4682'), amount: new Prisma.Decimal('1250.1234'), notes: 'Navy', imageUrl: null }] };
}

function prismaFor(source: any, config: any = null) {
  return { quotation: { findUnique: vi.fn(async () => source) },
    systemConfig: { findUnique: vi.fn(async () => config) } } as any;
}

function stableJson(value: any): any {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, stableJson(value[key])]));
  return value;
}

const originalUploadDir = process.env.BAMBOOK_UPLOAD_DIR;
const originalPublicBaseUrl = process.env.BAMBOOK_PUBLIC_BASE_URL;
const tempRoots: string[] = [];
function uploadRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-sign-image-'));
  tempRoots.push(root);
  process.env.BAMBOOK_UPLOAD_DIR = root;
  process.env.BAMBOOK_PUBLIC_BASE_URL = 'https://bambook.local';
  return root;
}
afterEach(() => {
  process.env.BAMBOOK_UPLOAD_DIR = originalUploadDir;
  process.env.BAMBOOK_PUBLIC_BASE_URL = originalPublicBaseUrl;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('quotation approval sign-document snapshot', () => {
  it('freezes native quote fields, exact decimals, rendered clauses, salesperson, inquiry reference and exporter provenance', async () => {
    const quote = quotation();
    const prisma = prismaFor(quote);
    const snapshot = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'Quotation', quotationId: quote.id });
    const approval = { id: 'a-1', actionType: 'quotation:total_approve', targetType: 'Quotation', targetId: quote.id,
      payload: { quotationId: quote.id, documentSnapshot: snapshot } };
    expect(getApprovalSignDocumentSnapshot(approval as any)).toEqual(snapshot);
    expect(snapshot).toMatchObject({ kind: 'Quotation', sourceRef: 'q-1', sourceIds: ['q-1'],
      exporterProfileSource: { version: 0, isDefault: true },
      data: { qt: { quotationNumber: 'QT-2026-001', salesperson: 'Mia', inquiryRef: 'INQ-2026-09',
        totalAmount: 1250.1234 }, lines: [{ unitPrice: 123.4682, amount: 1250.1234 }] },
      exactSource: { quotation: { version: 7, totalAmount: '1250.1234', salesperson: 'Mia', inquiryRef: 'INQ-2026-09',
        lines: [{ quantity: '10.125', unitPrice: '123.4682', amount: '1250.1234' }] } },
      clauses: { version: expect.any(String), entries: expect.arrayContaining([
        { no: 1, title: 'Delivery 交货', body: 'FOB Shanghai' },
        { no: 2, title: 'Payment 付款', body: '30% deposit, balance before shipment' },
      ]) } });
  });

  it('makes the prior signature stale after a printed quote field or exact amount changes', async () => {
    const quote = quotation();
    const prisma = prismaFor(quote);
    const snapshot = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'Quotation', quotationId: quote.id });
    const approval = { id: 'a-1', actionType: 'quotation:total_approve', targetType: 'Quotation', targetId: quote.id,
      payload: { quotationId: quote.id, documentSnapshot: snapshot } };
    quote.lines[0].unitPrice = new Prisma.Decimal('123.4683');
    quote.lines[0].amount = new Prisma.Decimal('1250.1244');
    quote.totalAmount = new Prisma.Decimal('1250.1244');
    await expect(assertCurrentApprovalSignDocumentSnapshot(prisma, approval as any))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', statusCode: 409 });
  });

  it('invalidates after seller profile version changes and refuses authoritative config read failures', async () => {
    const quote = quotation();
    const row = { id: 'global::company.exporterProfile', version: 4, updatedAt: new Date('2026-10-01T00:00:00Z'), encrypted: false,
      value: { nameEn: 'Frozen Seller', addressEn: 'Frozen Street' } };
    const prisma = prismaFor(quote, row);
    const snapshot = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'Quotation', quotationId: quote.id });
    const approval = { id: 'a-1', actionType: 'quotation:total_approve', targetType: 'Quotation', targetId: quote.id,
      payload: { quotationId: quote.id, documentSnapshot: snapshot } };
    expect(snapshot.exporterProfileSource.version).toBe(4);
    prisma.systemConfig.findUnique.mockResolvedValue({ ...row, version: 5, updatedAt: new Date('2026-10-02T00:00:00Z') });
    await expect(assertCurrentApprovalSignDocumentSnapshot(prisma, approval as any))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', statusCode: 409 });
    prisma.systemConfig.findUnique.mockRejectedValue(new Error('database unavailable'));
    await expect(buildApprovalSignDocumentSnapshot(prisma, { kind: 'Quotation', quotationId: quote.id }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', statusCode: 409 });
  });

  it('invalidates a correctly hashed prior signature after the native quotation template version changes', async () => {
    const quote = quotation();
    const snapshot = await buildApprovalSignDocumentSnapshot(prismaFor(quote), { kind: 'Quotation', quotationId: quote.id });
    const priorTemplate = { ...snapshot, templateVersion: 'quotation-template-v0',
      clauses: { ...snapshot.clauses!, version: 'quotation-template-v0' } };
    const { contentFingerprint: _oldFingerprint, ...priorContent } = priorTemplate;
    const oldSignatureSnapshot = { ...priorTemplate, contentFingerprint: createHash('sha256')
      .update(JSON.stringify(stableJson(priorContent))).digest('hex') };
    const oldApproval = { id: 'a-old', actionType: 'quotation:total_approve', targetType: 'Quotation', targetId: quote.id,
      payload: { quotationId: quote.id, documentSnapshot: oldSignatureSnapshot } };

    // This is an internally consistent old-version signature envelope, not a
    // broken hash fixture. A template bump must still make it unusable.
    expect(oldSignatureSnapshot.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(getApprovalSignDocumentSnapshot(oldApproval as any)).toBeNull();
  });

  it('freezes quotation-upload bytes and invalidates the same URL when its private file changes', async () => {
    const root = uploadRoot();
    fs.mkdirSync(path.join(root, 'quotations'), { recursive: true });
    const file = path.join(root, 'quotations', 'sample.jpg');
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]));
    const quote = quotation();
    quote.lines[0].imageUrl = '/api/v1/quotations/line-image/sample.jpg';
    const prisma = prismaFor(quote);
    const snapshot = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'Quotation', quotationId: quote.id });
    expect(snapshot.data.lines[0].imageUrl).toBe(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]).toString('base64')}`);
    const approval = { id: 'a-image', actionType: 'quotation:total_approve', targetType: 'Quotation', targetId: quote.id,
      payload: { quotationId: quote.id, documentSnapshot: snapshot } };

    // Same upload route and URL, different stored bytes: the newly assembled
    // signature document has a different content fingerprint.
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0x03, 0x04]));
    const changedBytes = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'Quotation', quotationId: quote.id });
    expect(changedBytes.sourceFingerprint).toBe(snapshot.sourceFingerprint);
    expect(changedBytes.contentFingerprint).not.toBe(snapshot.contentFingerprint);
    await expect(assertCurrentApprovalSignDocumentSnapshot(prisma, approval as any))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', statusCode: 409 });
  });

  it('freezes product-asset upload images from their real nested private storage path', async () => {
    const root = uploadRoot();
    const productDir = path.join(root, 'products', 'PA__WOOL-1');
    fs.mkdirSync(productDir, { recursive: true });
    const webp = Buffer.from('RIFF1234WEBPcontent');
    fs.writeFileSync(path.join(productDir, 'main.webp'), webp);
    const quote = quotation();
    quote.lines[0].imageUrl = '/api/uploads/products/PA__WOOL-1/main.webp';
    const snapshot = await buildApprovalSignDocumentSnapshot(prismaFor(quote), { kind: 'Quotation', quotationId: quote.id });
    expect(snapshot.data.lines[0].imageUrl).toBe(`data:image/webp;base64,${webp.toString('base64')}`);
  });

  it('blocks missing files, traversal paths, and external image URLs from formal signed snapshots', async () => {
    const root = uploadRoot();
    fs.mkdirSync(path.join(root, 'products', 'PA-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'products', 'secret.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x01]));
    const missing = quotation();
    missing.lines[0].imageUrl = '/api/v1/quotations/line-image/missing.jpg';
    await expect(buildApprovalSignDocumentSnapshot(prismaFor(missing), { kind: 'Quotation', quotationId: missing.id }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', message: expect.stringContaining('重新上传') });

    const traversal = quotation();
    traversal.lines[0].imageUrl = '/api/uploads/products/PA-1/%2e%2e%2fsecret.jpg';
    await expect(buildApprovalSignDocumentSnapshot(prismaFor(traversal), { kind: 'Quotation', quotationId: traversal.id }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' });

    const external = quotation();
    external.lines[0].imageUrl = 'https://images.example.test/fabric.jpg';
    await expect(buildApprovalSignDocumentSnapshot(prismaFor(external), { kind: 'Quotation', quotationId: external.id }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', message: expect.stringContaining('外链无法冻结') });
  });

  it('rejects unsupported image bytes and files larger than the existing 10 MiB upload limit', async () => {
    const root = uploadRoot();
    fs.mkdirSync(path.join(root, 'quotations'), { recursive: true });
    const file = path.join(root, 'quotations', 'bad.jpg');
    fs.writeFileSync(file, Buffer.from('<svg onload=alert(1)>'));
    const badMime = quotation();
    badMime.lines[0].imageUrl = '/api/uploads/quotations/bad.jpg';
    await expect(buildApprovalSignDocumentSnapshot(prismaFor(badMime), { kind: 'Quotation', quotationId: badMime.id }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' });

    fs.writeFileSync(file, Buffer.alloc(10 * 1024 * 1024 + 1, 0xff));
    const tooLarge = quotation();
    tooLarge.lines[0].imageUrl = '/api/uploads/quotations/bad.jpg';
    await expect(buildApprovalSignDocumentSnapshot(prismaFor(tooLarge), { kind: 'Quotation', quotationId: tooLarge.id }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' });
  });

  it('does not treat an old total approval without its native document snapshot as a signature', () => {
    const old = { id: 'old', actionType: 'quotation:total_approve', targetType: 'Quotation', targetId: 'q-1',
      payload: { quotationId: 'q-1' } };
    expect(getApprovalSignDocumentSnapshot(old as any)).toBeNull();
  });
});
