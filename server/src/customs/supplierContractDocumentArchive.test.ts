import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { supplierFingerprint, supplierJson } from '../procurement/supplierContractPolicy';

const adapters = vi.hoisted(() => ({ read: vi.fn(), begin: vi.fn(), replay: vi.fn(), persist: vi.fn(), render: vi.fn(), pdf: vi.fn() }));
vi.mock('../procurement/supplierContractDocument', () => ({ readSupplierContractDocumentInTx: adapters.read }));
vi.mock('../procurement/supplierContractCommandReceipt', () => ({
  beginSupplierCommand: adapters.begin, replaySupplierCommand: adapters.replay, persistSupplierCommand: adapters.persist,
  supplierResponse: (item: unknown, command: any, receiptId: string, contractId: string, extra: any) => ({ ok: true, item,
    commandAck: { schemaVersion: 1, requestKey: command.requestKey, operation: command.operation, contractKind: command.kind, contractId, receiptId, ...extra } }),
}));
vi.mock('../templates/docTemplates/registry', () => ({ renderServerDocument: adapters.render }));
vi.mock('../templates/pdf', () => ({ renderHtmlToPdf: adapters.pdf }));

import { registerSupplierContractTradeDocument, readSupplierContractTradeDocumentInTx, readSupplierContractArchive } from './supplierContractDocumentArchive';

const actor = { userId: 'sales-a', roles: ['sales'], permissions: ['procurement:read', 'procurement:write'] } as any;
const snapshot = { currency: 'USD', totalAmount: '600.1250', supplierRelationId: 'supplier-a', lines: [{ orderLineId: 'line-a', quantity: '300.0625' }] };
const source = { contractId: 'purchase-a', contractKind: 'purchase' as const, number: 'PO-1', revisionId: 'revision-a', revision: 1,
  contentFingerprint: supplierFingerprint(snapshot), approvedAt: '1791345600000', historical: false, snapshot: supplierJson(snapshot), sourceRef: 'supplier:purchase:purchase-a:revision-a' };

describe('supplier formal documents use one immutable approved revision', () => {
  let root: string, doc: any, versions: any[], audits: any[], db: any;
  beforeEach(() => {
    vi.clearAllMocks(); root = mkdtempSync(path.join(tmpdir(), 'supplier-document-unit-')); process.env.BAMBOOK_UPLOAD_DIR = root;
    doc = null; versions = []; audits = [];
    db = { $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
      tradeDocument: { findFirst: vi.fn(async ({ where }: any) => doc && (!where.id || where.id === doc.id) && (!where.filePath || where.filePath === doc.filePath) ? doc : null),
        findMany: vi.fn(async () => doc ? [doc] : []), create: vi.fn(async ({ data }: any) => (doc = { ...data, filePath: null, fileName: null, deletedAt: null })),
        update: vi.fn(async ({ data }: any) => (doc = { ...doc, ...data })) },
      documentVersion: { findMany: vi.fn(async () => versions), create: vi.fn(async ({ data }: any) => { versions.push(data); return data; }) },
      auditLog: { findMany: vi.fn(async () => audits), findFirst: vi.fn(async () => audits.find(row => row.action === 'TRADE_DOCUMENT_FILE_GENERATED') ?? null),
        create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }) },
    };
    db.$transaction = vi.fn(async (work: any) => work(db));
    adapters.read.mockResolvedValue(source);
    adapters.begin.mockImplementation(async (_tx, command) => ({ actor, receiptId: 'receipt-a', fingerprint: supplierFingerprint(command.input) }));
    adapters.replay.mockResolvedValue(null);
    adapters.persist.mockImplementation(async (_tx, _command, _hash, result) => result);
    adapters.render.mockResolvedValue('<!doctype html><html><body>approved frozen contract 300.0625</body></html>');
    adapters.pdf.mockResolvedValue({ pdf: Buffer.from('%PDF-1.4\nunit fixture\n'), bytes: 22, sha: 'not-authority' });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env.BAMBOOK_UPLOAD_DIR; });

  it('atomically registers the exact revision, archive proof and original command receipt', async () => {
    const result = await registerSupplierContractTradeDocument(db, { actor, kind: 'purchase', contractId: source.contractId, requestKey: 'original-key' });
    expect(result.commandAck).toMatchObject({ operation: 'generate_document', documentId: doc.id, revisionId: source.revisionId });
    expect(doc).toMatchObject({ domain: 'procurement', type: 'PurchaseOrder', status: 'Issued', sourceRef: source.sourceRef, orderId: null, documentNumber: 'PO-1-R1' });
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toMatchObject({ protocol: 'SupplierContractDocument', sourceFingerprint: source.contentFingerprint, snapshot });
    expect(readFileSync(path.join(root, doc.filePath)).toString()).toContain('%PDF-1.4');
    expect(adapters.persist).toHaveBeenCalledTimes(1);
    expect(await readSupplierContractArchive(db, { documentId: doc.id, actor })).toMatchObject({ proof: { sourceFingerprint: source.contentFingerprint } });
  });

  it('reuses an existing revision without rewriting its original bytes or adding versions', async () => {
    await registerSupplierContractTradeDocument(db, { actor, kind: 'purchase', contractId: source.contractId, requestKey: 'key-a' });
    const originalPath = doc.filePath;
    await registerSupplierContractTradeDocument(db, { actor, kind: 'purchase', contractId: source.contractId, requestKey: 'key-b' });
    expect(doc.filePath).toBe(originalPath); expect(versions).toHaveLength(1); expect(adapters.pdf).toHaveBeenCalledTimes(1);
  });

  it('restores the original successful key after later amendments, after current source authorization', async () => {
    const original = await registerSupplierContractTradeDocument(db, { actor, kind: 'purchase', contractId: source.contractId, requestKey: 'key-a' });
    adapters.replay.mockResolvedValue(original); adapters.read.mockResolvedValue({ ...source, historical: true });
    const recovered = await registerSupplierContractTradeDocument(db, { actor, kind: 'purchase', contractId: source.contractId, requestKey: 'key-a' });
    expect(recovered).toEqual(original); expect(adapters.pdf).toHaveBeenCalledTimes(1);
    expect(adapters.read.mock.calls.at(-1)?.[1]).toMatchObject({ actor, revisionId: source.revisionId, forNewPromise: false });
  });

  it('rejects a source change after rendering before publishing any document or receipt', async () => {
    adapters.read.mockImplementation(async (_tx, input) => adapters.pdf.mock.calls.length && input.forNewPromise
      ? { ...source, contentFingerprint: 'b'.repeat(64) } : source);
    await expect(registerSupplierContractTradeDocument(db, { actor, kind: 'purchase', contractId: source.contractId, requestKey: 'key-a' })).rejects.toMatchObject({ statusCode: 409 });
    expect(db.tradeDocument.create).not.toHaveBeenCalled(); expect(adapters.persist).not.toHaveBeenCalled();
  });

  it('rejects changed snapshot, extra version and copied protected file lineage', async () => {
    await registerSupplierContractTradeDocument(db, { actor, kind: 'purchase', contractId: source.contractId, requestKey: 'key-a' });
    const saved = versions[0].content;
    versions[0].content = { ...saved, snapshot: { ...snapshot, totalAmount: '1' } };
    await expect(readSupplierContractTradeDocumentInTx(db, doc.id, actor)).rejects.toMatchObject({ statusCode: 409 });
    versions[0].content = saved; versions.push({ ...versions[0], id: 'other-version', version: 2 });
    await expect(readSupplierContractTradeDocumentInTx(db, doc.id, actor)).rejects.toMatchObject({ statusCode: 409 });
    versions.pop(); doc = { ...doc, type: 'Other', domain: 'customs' };
    await expect(readSupplierContractArchive(db, { documentId: doc.id, actor })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('verifies archived bytes and repeats authorization before disclosure', async () => {
    await registerSupplierContractTradeDocument(db, { actor, kind: 'purchase', contractId: source.contractId, requestKey: 'key-a' });
    writeFileSync(path.join(root, doc.filePath), 'changed bytes');
    await expect(readSupplierContractArchive(db, { documentId: doc.id, actor })).rejects.toMatchObject({ statusCode: 409 });
  });
});
