import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { createAuthService } from '../../auth/service';
import { createCustomsRouter } from '../customsRoute';
import { createCustomsService } from '../customsService';
import { archiveExternalTradeDocumentFile, readExternalTradeDocumentArchive } from '../externalTradeDocumentArchiveService';
import { EXTERNAL_TRADE_DOCUMENT_MAX_BYTES } from '../externalTradeDocumentArchiveService';
import { generateTradeDocumentFile, generateTradeDocumentsFromShipment, renderTradeDocumentServerHtml } from '../tradeDocumentLifecycleService';
import { assertShipmentExportDeclarationProof } from '../../shipping/shipmentExportDeclaration';
import { storage, actor } from './ciCentralHttpStorage';

const auth = createAuthService();
const readOnlyToken = auth.signToken({ ...actor, permissions: ['customs:read'], permissionCeiling: ['customs:read'], departmentIds: [] });
const originalUploadRoot = process.env.BAMBOOK_UPLOAD_DIR;
let uploadRoot = '';

function externalDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'TD_EXTERNAL', documentNumber: 'BL-2026-0001', domain: 'customs', type: 'BillOfLading', status: 'Draft',
    shipmentId: null, declarationId: null, orderId: null, relationId: null, sourceRef: null,
    sourceInvoiceId: null, filePath: null, fileName: null, createdAt: BigInt(1), updatedAt: BigInt(1), deletedAt: null,
    ...overrides,
  };
}

function finalRouteHandler(router: any, method: 'get' | 'post', routePath: string) {
  const layer = router.stack.find((candidate: any) => candidate.route?.path === routePath && candidate.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);
  return layer.route.stack.at(-1).handle;
}

async function invokeRoute(router: any, method: 'get' | 'post', routePath: string, input: { params?: any; query?: any; body?: any } = {}) {
  const res: any = { statusCode: 200, headers: {}, body: undefined, sent: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    send(body: unknown) { this.sent = body; return this; },
  };
  const req: any = { params: input.params ?? {}, query: input.query ?? {}, body: input.body ?? {}, actor, authSource: 'user-session', headers: {} };
  await finalRouteHandler(router, method, routePath)(req, res, () => {});
  return res;
}

beforeEach(() => {
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-external-doc-'));
  process.env.BAMBOOK_UPLOAD_DIR = uploadRoot;
});
afterEach(() => {
  if (originalUploadRoot === undefined) delete process.env.BAMBOOK_UPLOAD_DIR;
  else process.env.BAMBOOK_UPLOAD_DIR = originalUploadRoot;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

describe('external trade document archive-only workflow', () => {
  it('keeps immutable file versions and reads the selected exact original', async () => {
    const f = storage();
    f.tables.tradeDocument.push(externalDocument());
    const firstBytes = Buffer.from('%PDF-1.7\nthird-party draft bl\n%%EOF');
    const secondBytes = Buffer.from('%PDF-1.7\nthird-party final bl\n%%EOF');
    const first = await archiveExternalTradeDocumentFile(f.db as any, { documentId: 'TD_EXTERNAL', actorId: actor.userId,
      file: { buffer: firstBytes, size: firstBytes.length, originalName: 'draft-bl.pdf' }, uploadRoot });
    const second = await archiveExternalTradeDocumentFile(f.db as any, { documentId: 'TD_EXTERNAL', actorId: actor.userId,
      file: { buffer: secondBytes, size: secondBytes.length, originalName: 'final-bl.pdf' }, uploadRoot });
    expect(first).toMatchObject({ version: 1, fileName: 'draft-bl.pdf', mimeType: 'application/pdf', byteSize: firstBytes.length });
    expect(second).toMatchObject({ version: 2, fileName: 'final-bl.pdf', mimeType: 'application/pdf', byteSize: secondBytes.length });

    const v1 = await readExternalTradeDocumentArchive(f.db as any, { documentId: 'TD_EXTERNAL', version: 1, uploadRoot });
    const current = await readExternalTradeDocumentArchive(f.db as any, { documentId: 'TD_EXTERNAL', uploadRoot });
    expect(v1.bytes).toEqual(firstBytes);
    expect(v1.archive).toMatchObject({ version: 1, sha256: first.sha256 });
    expect(current.bytes).toEqual(secondBytes);
    expect(current.archive.version).toBe(2);
    expect(fs.readdirSync(path.join(uploadRoot, 'trade-documents', 'external', 'TD_EXTERNAL'))).toHaveLength(2);
    expect(f.tables.documentVersion).toHaveLength(2);
  });

  it('uses latest archived external originals for a ZIP batch while the single-download path can select an exact version', async () => {
    const f = storage();
    f.tables.tradeDocument.push(externalDocument());
    const firstBytes = Buffer.from('%PDF-1.7\nfirst\n%%EOF');
    const latestBytes = Buffer.from('%PDF-1.7\nlatest\n%%EOF');
    await archiveExternalTradeDocumentFile(f.db as any, { documentId: 'TD_EXTERNAL', actorId: actor.userId,
      file: { buffer: firstBytes, size: firstBytes.length, originalName: 'draft.pdf' }, uploadRoot });
    await archiveExternalTradeDocumentFile(f.db as any, { documentId: 'TD_EXTERNAL', actorId: actor.userId,
      file: { buffer: latestBytes, size: latestBytes.length, originalName: 'final.pdf' }, uploadRoot });
    const router = createCustomsRouter({ prisma: f.db as any, requireAuth: false, apiKeys: new Set() });
    const batch = await invokeRoute(router, 'post', '/trade-documents/batch-download', { body: { ids: ['TD_EXTERNAL'] } });
    expect(batch.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(batch.sent as Buffer);
    expect(Object.keys(zip.files)).toContain('final.pdf');
    expect(await zip.file('final.pdf')!.async('nodebuffer')).toEqual(latestBytes);
    const exact = await readExternalTradeDocumentArchive(f.db as any, { documentId: 'TD_EXTERNAL', version: 1, uploadRoot });
    expect(exact.bytes).toEqual(firstBytes);
  });

  it('accepts only external customs document types and validates extension, signature, size and nonempty bytes', async () => {
    const f = storage();
    f.tables.tradeDocument.push(externalDocument({ type: 'Contract' }));
    const bytes = Buffer.from('%PDF-1.7\nvalid\n%%EOF');
    await expect(archiveExternalTradeDocumentFile(f.db as any, { documentId: 'TD_EXTERNAL', actorId: actor.userId,
      file: { buffer: bytes, size: bytes.length, originalName: 'external.pdf' }, uploadRoot })).rejects.toThrow('不能使用外部文件归档');
    f.tables.tradeDocument[0] = externalDocument();
    const forged = Buffer.from('<html>not a pdf</html>');
    await expect(archiveExternalTradeDocumentFile(f.db as any, { documentId: 'TD_EXTERNAL', actorId: actor.userId,
      file: { buffer: forged, size: forged.length, originalName: 'forged.pdf' }, uploadRoot })).rejects.toThrow('扩展名与文件内容不匹配');
    await expect(archiveExternalTradeDocumentFile(f.db as any, { documentId: 'TD_EXTERNAL', actorId: actor.userId,
      file: { buffer: Buffer.alloc(0), size: 0, originalName: 'empty.pdf' }, uploadRoot })).rejects.toThrow('非空');
    const oversized = Buffer.alloc(EXTERNAL_TRADE_DOCUMENT_MAX_BYTES + 1, 0x41);
    await expect(archiveExternalTradeDocumentFile(f.db as any, { documentId: 'TD_EXTERNAL', actorId: actor.userId,
      file: { buffer: oversized, size: oversized.length, originalName: 'large.pdf' }, uploadRoot })).rejects.toThrow('不能超过 20 MiB');
    expect(f.tables.documentVersion).toHaveLength(0);
  });

  it('requires a JWT session and customs:write before the external upload handler can run', () => {
    const router = createCustomsRouter({ prisma: storage().db as any, requireAuth: true, apiKeys: new Set() });
    const layer = router.stack.find((candidate: any) => candidate.route?.path === '/trade-documents/:id/external-archive' && candidate.route?.methods?.post);
    expect(layer).toBeTruthy();
    const [requireWrite, requireCustomsWrite] = layer.route.stack.map((item: any) => item.handle);
    const req: any = { headers: { authorization: `Bearer ${readOnlyToken}` }, query: {}, body: {}, params: {}, actor: undefined, authSource: 'user-session' };
    const res: any = { statusCode: 200, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    let continued = false;
    requireWrite(req, res, () => { continued = true; });
    expect(continued).toBe(true);
    expect(req.actor.userId).toBe(actor.userId);
    continued = false;
    requireCustomsWrite(req, res, () => { continued = true; });
    expect(continued).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('links an external document to the exact existing LetterOfCredit and derives the linked parties', async () => {
    const f = storage();
    f.tables.letterOfCredit.push({ id: 'LC-EXACT', lcNumber: 'LC-2026-1', orderId: 'O', relationId: 'R', deletedAt: null });
    const service = createCustomsService(f.db as any);
    const created = await service.createTradeDocument({ type: 'BillOfLading', sourceRef: 'LC-EXACT' }, actor.userId);
    expect(created).toMatchObject({ sourceRef: 'LC-EXACT', orderId: 'O', relationId: 'R' });
    await expect(service.createTradeDocument({ type: 'BillOfLading', sourceRef: 'MISSING-LC' }, actor.userId)).rejects.toThrow('信用证不存在');
    await expect(service.createTradeDocument({ type: 'BillOfLading', sourceRef: 'LC-EXACT', relationId: 'OTHER' }, actor.userId)).rejects.toThrow('客户必须与所关联信用证');
    expect(f.tables.tradeDocument).toHaveLength(1);
  });

  it('blocks template generation and preview for external customs documents', async () => {
    const types = ['CertificateOfOrigin', 'BillOfLading', 'AirWaybill', 'InsuranceCert', 'InspectionCert', 'PhytosanitaryCert', 'ExportDeclarationProof', 'Other'];
    for (const type of types) {
      const doc = externalDocument({ type });
      const prisma: any = { tradeDocument: { findFirst: async () => doc } };
      await expect(generateTradeDocumentFile(prisma, { id: doc.id, html: '<h1>fake template</h1>', actorId: actor.userId })).rejects.toThrow('不可由系统模板生成');
      await expect(renderTradeDocumentServerHtml(prisma, doc as any)).rejects.toThrow('不从订单数据预览或生成模板');
      await expect(generateTradeDocumentsFromShipment(prisma, { shipmentId: 'S-1', types: [type] as any, actorId: actor.userId })).rejects.toThrow('只生成我方商业发票和装箱单');
    }
  });

  it('requires the current export shipment to have its own verified external filing proof before departure', async () => {
    const f = storage();
    const doc = externalDocument({ type: 'ExportDeclarationProof', shipmentId: 'SH-EXPORT' });
    f.tables.tradeDocument.push(doc);
    const bytes = Buffer.from('%PDF-1.7\nexternal export filing\n%%EOF');
    await archiveExternalTradeDocumentFile(f.db as any, { documentId: doc.id, actorId: actor.userId,
      file: { buffer: bytes, size: bytes.length, originalName: 'export-proof.pdf' }, uploadRoot });

    await expect(assertShipmentExportDeclarationProof(f.db as any, { id: 'SH-EXPORT', type: 'Export' }))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await expect(assertShipmentExportDeclarationProof(f.db as any, { id: 'SH-EXPORT', type: 'Export',
      exportDeclarationCompletedAt: '2026-10-07T02:00:00.000Z', exportDeclarationEvidenceDocumentId: doc.id })).resolves.toBeUndefined();
    await expect(assertShipmentExportDeclarationProof(f.db as any, { id: 'SH-OTHER', type: 'Export',
      exportDeclarationCompletedAt: '2026-10-07T02:00:00.000Z', exportDeclarationEvidenceDocumentId: doc.id }))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await expect(assertShipmentExportDeclarationProof(f.db as any, { id: 'SH-IMPORT', type: 'Import' })).resolves.toBeUndefined();
  });

  it('route handlers refuse every order/shipment template generation entrypoint for third-party documents', async () => {
    const f = storage();
    const doc = externalDocument();
    f.tables.tradeDocument.push(doc);
    const router = createCustomsRouter({ prisma: f.db as any, requireAuth: false, apiKeys: new Set() });

    const shipmentRegistration = await invokeRoute(router, 'post', '/trade-documents/generate-from-shipment', {
      body: { shipmentId: 'S-1', types: ['BillOfLading'] },
    });
    expect(shipmentRegistration.statusCode).toBe(400);
    expect(shipmentRegistration.body.error).toContain('只生成我方商业发票和装箱单');

    const fileGeneration = await invokeRoute(router, 'post', '/trade-documents/:id/generate-file', {
      params: { id: doc.id }, body: { html: '<h1>order snapshot</h1>' },
    });
    expect(fileGeneration.statusCode).toBe(409);
    expect(fileGeneration.body.error).toContain('不可由系统模板生成');

    const preview = await invokeRoute(router, 'get', '/trade-documents/:id/preview.html', { params: { id: doc.id } });
    expect(preview.statusCode).toBe(409);
    expect(preview.body.error).toContain('不从订单数据预览');

    for (const kind of ['CO', 'BL', 'AWB', 'INS', 'BC', 'FORMA']) {
      const shipmentRender = await invokeRoute(router, 'post', '/trade-documents/render-by-shipment', {
        body: { shipmentId: 'S-1', kind },
      });
      expect(shipmentRender.statusCode).toBe(400);
      expect(shipmentRender.body.error).toContain('当前 MVP 只生成商业发票和装箱单');
    }

    for (const routePath of ['/trade-documents/composite/preview.html', '/trade-documents/composite/generate.pdf']) {
      const composite = await invokeRoute(router, 'post', routePath, { body: { kind: 'BillOfLading', sourceIds: ['O-1', 'O-2'] } });
      expect(composite.statusCode).toBe(400);
      expect(composite.body.error).toContain('非法组合文档类型');
    }
  });

  it('verifies archived bytes against immutable version SHA before returning them', async () => {
    const f = storage();
    const doc = externalDocument();
    f.tables.tradeDocument.push(doc);
    const bytes = Buffer.from('%PDF-1.7\nuntampered\n%%EOF');
    const archive = await archiveExternalTradeDocumentFile(f.db as any, { documentId: doc.id, actorId: actor.userId,
      file: { buffer: bytes, size: bytes.length, originalName: 'co.pdf' }, uploadRoot });
    const read = await readExternalTradeDocumentArchive(f.db as any, { documentId: doc.id, version: archive.version, uploadRoot });
    expect(read.bytes).toEqual(bytes);
    const savedPath = path.join(uploadRoot, f.tables.documentVersion.find(row => (row.content as any)?.externalArchive)?.content.externalArchive.filePath);
    fs.writeFileSync(savedPath, '%PDF-1.7\nforged\n%%EOF');
    await expect(readExternalTradeDocumentArchive(f.db as any, { documentId: doc.id, version: archive.version, uploadRoot })).rejects.toThrow('不一致');
  });

  it('rejects a symlinked external target directory before writing outside the protected archive root', async () => {
    const f = storage();
    const doc = externalDocument();
    f.tables.tradeDocument.push(doc);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-external-outside-'));
    try {
      const target = path.join(uploadRoot, 'trade-documents', 'external', doc.id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(outside, target, 'dir');
      const bytes = Buffer.from('%PDF-1.7\nblocked\n%%EOF');
      await expect(archiveExternalTradeDocumentFile(f.db as any, { documentId: doc.id, actorId: actor.userId,
        file: { buffer: bytes, size: bytes.length, originalName: 'outside.pdf' }, uploadRoot })).rejects.toThrow('不属于受保护的单据目录');
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(f.tables.documentVersion).toHaveLength(0);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
