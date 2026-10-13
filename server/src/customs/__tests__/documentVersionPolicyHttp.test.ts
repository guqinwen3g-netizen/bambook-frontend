/** Actual Express/auth/source routes with explicit transactional storage.
 * Not PostgreSQL/SQL-lock/browser proof; no business/auth/source helper mock. */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createAuthorizationSnapshotGuard } from '../../auth/authorizationSnapshotGuard';
import { createCustomsRouter } from '../customsRoute';
import { createShippingRouter } from '../../shipping/route';
import { storage, actor, decimal } from './ciCentralHttpStorage';

const auth = createAuthService();
function fixture(ceiling?: string[]) {
  const s = storage(), changes: any[] = [], app = express();
  const token = auth.signToken({ ...actor, ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}) });
  app.use(express.json());
  app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  // This is the actual /api middleware before module routers in index.ts.
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: s.db }));
  app.use('/api/v1/shipping', createShippingRouter({ prisma: s.db, requireAuth: true, apiKeys: new Set() }));
  app.use('/api/v1/customs', createCustomsRouter({ prisma: s.db, requireAuth: true, apiKeys: new Set(), onDataChange: event => changes.push(event) }));
  const get = (url: string) => request(app).get(url).set('Authorization', 'Bearer ' + token);
  const post = (url: string, body: any) => request(app).post(url).set('Authorization', 'Bearer ' + token).send(body);
  const bindings = async () => {
    const response = await get('/api/v1/shipping/S/ci-sources');
    expect(response.status).toBe(200);
    expect(response.body.candidates).toHaveLength(1);
    const candidate = response.body.candidates[0];
    expect(candidate.sourceInvoiceId).toBe('INV');
    return { type: 'CommercialInvoice', shipmentId: 'S', sourceInvoiceId: candidate.sourceInvoiceId,
      expectedSourceFingerprint: candidate.expectedSourceFingerprint,
      expectedShipmentSourceFingerprint: response.body.expectedShipmentSourceFingerprint };
  };
  const businessSnapshot = () => JSON.stringify({ invoice: s.tables.invoice, ioa: s.tables.invoiceOrderAllocation,
    documents: s.tables.tradeDocument, versions: s.tables.documentVersion, audits: s.tables.auditLog },
    (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return { ...s, app, changes, get, post, bindings, businessSnapshot };
}
function other(f: ReturnType<typeof fixture>) {
  f.tables.tradeDocument.push({ id: 'OTHER', documentNumber: 'LEGACY-OTHER', type: 'Other', status: 'Draft', deletedAt: null });
}

describe('generic document versions and formal CI are separate actual HTTP contracts', () => {
  it('legal Other appends v1/v2, exact selected JSON and mandatory actor audit without changing CI templates', async () => {
    const f = fixture(); other(f);
    for (const amount of [100, 120]) {
      const response = await f.post('/api/v1/customs/trade-documents/OTHER/versions', { content: { totalAmount: amount }, changeReason: 'generic JSON' });
      expect(response.status).toBe(201);
      expect(response.body.item.version).toBe(amount === 100 ? 1 : 2);
      expect(response.body.item.changedBy).toBe('u');
    }
    const list = await f.get('/api/v1/customs/trade-documents/OTHER/versions');
    expect(list.status).toBe(200); expect(list.body.items.map((row: any) => row.version)).toEqual([2, 1]);
    const selected = await f.get('/api/v1/customs/trade-documents/OTHER/versions/1');
    expect(selected.status).toBe(200); expect(selected.body.item.content).toEqual({ totalAmount: 100 });
    expect(f.tables.invoice[0].amount.toString()).toBe('200');
    expect(f.tables.auditLog).toHaveLength(2);
    expect(f.tables.auditLog.map(row => [row.action, row.actorId, row.detail.documentId])).toEqual([
      ['DOCUMENT_VERSION_CREATE', 'u', 'OTHER'], ['DOCUMENT_VERSION_CREATE', 'u', 'OTHER'],
    ]);
    expect(f.changes).toHaveLength(2);
  });

  it.each([{}, { content: [1, 2] }])('Other invalid content remains400 and cannot append version/audit: %j', async body => {
    const f = fixture(); other(f); const before = f.businessSnapshot();
    const response = await f.post('/api/v1/customs/trade-documents/OTHER/versions', body);
    expect(response.status).toBe(400); expect(f.businessSnapshot()).toBe(before); expect(f.changes).toEqual([]);
  });

  it('controlled original Invoice registers exact formal CI v1; same replay keeps original history and Invoice identity', async () => {
    const f = fixture(), body = await f.bindings(), beforeInvoice = JSON.stringify(f.tables.invoice, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    const first = await f.post('/api/v1/customs/trade-documents', body);
    expect(first.status).toBe(201); expect(first.body.item.documentNumber).toBe('FIN-001');
    expect(first.body.item.totalAmount).toBe('200'); expect(first.body.item.sourceInvoiceId).toBe('INV');
    const second = await f.post('/api/v1/customs/trade-documents', body);
    expect(second.status).toBe(201); expect(second.body.item.id).toBe(first.body.item.id);
    expect(f.tables.tradeDocument).toHaveLength(1); expect(f.tables.documentVersion).toHaveLength(1);
    expect(f.tables.documentVersion[0].version).toBe(1);
    expect(f.tables.documentVersion[0].content.ciSourceProtocol).toBe(1);
    expect(f.tables.documentVersion[0].content.ciSourceSnapshot.invoice).toMatchObject({ id: 'INV', invoiceNumber: 'FIN-001', amount: '200' });
    expect(f.tables.auditLog.map(row => row.action).sort()).toEqual(['DOCUMENT_VERSION_CREATE', 'TRADE_DOCUMENT_CREATE']);
    expect(JSON.stringify(f.tables.invoice, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBe(beforeInvoice);
  });

  it.each([{}, { content: [1, 2] }, { content: { totalAmount: 1 }, changedBy: 'forged-owner' }])(
    'formal CI rejects arbitrary version before generic content parsing; original facts unchanged: %j', async body => {
      const f = fixture(), created = await f.post('/api/v1/customs/trade-documents', await f.bindings());
      expect(created.status).toBe(201); const before = f.businessSnapshot(), changes = f.changes.length;
      const response = await f.post(`/api/v1/customs/trade-documents/${created.body.item.id}/versions`, body);
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('商业发票版本只由原财务发票产生，不能提交任意内容。');
      expect(f.businessSnapshot()).toBe(before); expect(f.changes).toHaveLength(changes);
    });

  it.each(['cancelled', 'changed-amount'])('original source %s rejects stale registration with no document/version/audit writes', async change => {
    const f = fixture(), body = await f.bindings();
    if (change === 'cancelled') f.tables.invoice[0].status = 'Cancelled';
    else f.tables.invoice[0].amount = decimal('201');
    const before = f.businessSnapshot(), response = await f.post('/api/v1/customs/trade-documents', body);
    expect(response.status).toBe(409); expect(f.businessSnapshot()).toBe(before);
    expect(f.tables.tradeDocument).toHaveLength(0); expect(f.tables.documentVersion).toHaveLength(0);
    expect(f.tables.auditLog).toHaveLength(0); expect(f.changes).toEqual([]);
  });

  it('signed empty ceiling cannot submit Other version using forged body authority', async () => {
    const f = fixture([]); other(f); const before = f.businessSnapshot();
    const response = await f.post('/api/v1/customs/trade-documents/OTHER/versions', { content: { a: 1 }, actor: { roles: ['owner'], permissions: ['customs:write'] } });
    expect(response.status).toBe(403); expect(f.businessSnapshot()).toBe(before);
    expect(f.calls.filter(call => call.startsWith('documentVersion.'))).toEqual([]);
  });
});
