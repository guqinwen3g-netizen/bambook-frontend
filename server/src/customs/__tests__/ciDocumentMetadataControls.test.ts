/** Actual original metadata TX/kernel, native source/authority and HTTP; storage
 * is deterministic and substituted. No PG lock/concurrency/producer approval. */
import { describe, expect, it } from 'vitest';
import express from 'express'; import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createCustomsRouter } from '../customsRoute';
import { createCustomsService } from '../customsService';
import { readCiInvoiceSource, registerCanonicalCi } from '../ciInvoiceSource';
import { documentSourceJson } from '../../shipping/shipmentDocumentSource';
import { storage, actor, scopes } from './ciMetadataStorage';
const auth = createAuthService();
const snapshot = (value: unknown) => JSON.stringify(documentSourceJson(value));
async function fixture() {
  const s = storage(), app = express(), changes: any[] = []; app.use(express.json());
  app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use('/api/v1/customs', createCustomsRouter({ prisma: s.db, requireAuth: true, apiKeys: new Set(['synthetic-key']), onDataChange: event => changes.push(event) }));
  const token = (ceiling?: string[]) => auth.signToken({ ...actor, ...(ceiling ? { permissionCeiling: ceiling } : {}) });
  const source = await readCiInvoiceSource(s.db, { trustedActor: actor, sourceInvoiceId: 'INV', shipmentId: 'S', mode: 'register' });
  const doc = (await registerCanonicalCi(s.db, { trustedActor: actor, sourceInvoiceId: 'INV', shipmentId: 'S', mode: 'register', expectedSourceFingerprint: source.fingerprint })).document;
  const post = (status: string, ceiling?: string[], extra = {}) => request(app).post('/api/v1/customs/trade-documents/' + doc.id + '/transition').set('Authorization', 'Bearer ' + token(ceiling)).send({ toStatus: status, ...extra });
  const remove = () => request(app).delete('/api/v1/customs/trade-documents/' + doc.id).set('Authorization', 'Bearer ' + token());
  const state = () => s.tables.tradeDocument.find(row => row.id === doc.id);
  const sales = () => { s.tables.userAccount[0].roles = [{ roleId: 'role-sales', role: { permissions: [] } }]; };
  const shared = () => { sales(); s.tables.relation[0].ownerId = 'other'; s.tables.teamMember.push({ id: 'TM', teamId: 'T', userId: 'u', leftAt: null, team: { deletedAt: null } }); s.tables.teamDataGrant.push({ id: 'SHARE', teamId: 'T', entityType: 'relation', entityId: 'R', revokedAt: null, team: { deletedAt: null } }); };
  let transactions = 0; const transaction = s.db.$transaction; s.db.$transaction = (...args: any[]) => { transactions++; return transaction(...args); };
  s.calls.length = 0; s.lockCalls.length = 0;
  return { ...s, app, doc, source, post, remove, state, sales, shared, changes, token, transactions: () => transactions };
}
describe('CI-only metadata retains canonical proof and current native authority', () => {
  it('Draft native delete cannot destroy permanent canonical CI or prevent original replay', async () => {
    const f = await fixture(), r = await f.remove(); expect(r.status).toBe(409); expect(f.state().deletedAt ?? null).toBeNull();
    const replay = await registerCanonicalCi(f.db, { trustedActor: actor, sourceInvoiceId: 'INV', shipmentId: 'S', mode: 'register', expectedSourceFingerprint: f.source.fingerprint });
    expect(replay.document.id).toBe(f.doc.id); expect(replay.created).toBe(false); expect(f.tables.tradeDocument).toHaveLength(1); expect(f.tables.documentVersion).toHaveLength(1); expect(f.tables.auditLog).toHaveLength(2); expect(f.changes).toEqual([]);
  });
  it('Cancelled native CI stays immutable and cannot be soft-deleted', async () => {
    const f = await fixture(); expect((await f.post('Cancelled')).status).toBe(200); const r = await f.remove();
    expect(r.status).toBe(409); expect(f.state().status).toBe('Cancelled'); expect(f.state().deletedAt ?? null).toBeNull(); expect(f.tables.auditLog).toHaveLength(3);
  });
  it.each(['delete', 'transition'])('native source link removal cannot downgrade proof for %s', async action => {
    const f = await fixture(); f.state().sourceInvoiceId = null; f.state().sourceRef = null;
    const r = action === 'delete' ? await f.remove() : await f.post('Issued'); expect(r.status).toBe(409); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2);
  });
  it.each(['delete', 'transition'])('corrupt original native audit fails closed for %s', async action => {
    const f = await fixture(); f.tables.auditLog = f.tables.auditLog.filter(row => row.action !== 'TRADE_DOCUMENT_CREATE');
    const r = action === 'delete' ? await f.remove() : await f.post('Issued'); expect(r.status).toBe(409); expect(f.state().deletedAt ?? null).toBeNull(); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(1);
  });
  it('current finance object scope prevents customs writer transitioning another owner Invoice', async () => {
    const f = await fixture(); f.sales(); f.tables.invoice[0].ownerId = 'other';
    const r = await f.post('Issued'); expect(r.status).toBe(404); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2);
  });
  it('all native parent Order L2 prevents a customs writer bypassing shared-source scope', async () => {
    const f = await fixture(); f.sales(); f.tables.relation[0].ownerId = 'other';
    const r = await f.post('Issued'); expect(r.status).toBe(404); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2);
  });
  it('later actual Invoice allocation adds another current parent L2 that cannot be bypassed', async () => {
    const f = await fixture(); f.sales(); f.tables.order.push({ ...f.tables.order[0], id: 'O2', customerRelationId: 'R2', ownerId: 'other' });
    f.tables.invoiceOrderAllocation.push({ ...f.tables.invoiceOrderAllocation[0], id: 'OTHER_IOA', orderId: 'O2' });
    const r = await f.post('Issued'); expect(r.status).toBe(404); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2);
  });
  it.each(['Draft', 'Cancelled', 'UNKNOWN'])('current original Invoice %s cannot issue formal CI metadata', async status => {
    const f = await fixture(); f.tables.invoice[0].status = status; const r = await f.post('Issued');
    expect(r.status).toBe(409); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2);
  });
  it.each(['Issued', 'PartiallyPaid', 'Paid'])('original actual final Invoice %s can use unchanged legal metadata kernel', async status => {
    const f = await fixture(); f.tables.invoice[0].status = status; const before = snapshot(f.tables.invoice);
    const r = await f.post('Issued'); expect(r.status).toBe(200); expect(f.state().status).toBe('Issued'); expect(f.tables.auditLog).toHaveLength(3); expect(f.tables.documentVersion).toHaveLength(1); expect(snapshot(f.tables.invoice)).toBe(before);
    expect(f.tables.auditLog[2]).toMatchObject({ action: 'TRADE_DOCUMENT_TRANSITION', targetId: f.doc.id, detail: { from: 'Draft', to: 'Issued' } });
    expect(f.lockCalls).toEqual(['Invoice', 'TradeDocument']); expect(f.transactions()).toBe(1);
  });
  it('original Invoice cancellation permits only original legal archive Cancel and never cancels finance', async () => {
    const f = await fixture(); f.tables.invoice[0].status = 'Cancelled'; expect((await f.post('Cancelled')).status).toBe(200);
    expect(f.state().status).toBe('Cancelled'); expect(f.tables.invoice[0].status).toBe('Cancelled'); expect(f.tables.documentVersion).toHaveLength(1); expect(f.tables.auditLog).toHaveLength(3);
    const g = await fixture(); expect((await g.post('Cancelled')).status).toBe(200); expect(g.tables.invoice[0].status).toBe('Issued');
  });
  it('original Accepted terminal state cannot be invented into Cancelled by source cancellation', async () => {
    const f = await fixture(); f.state().status = 'Accepted'; f.tables.invoice[0].status = 'Cancelled'; const r = await f.post('Cancelled');
    expect(r.status).toBe(400); expect(f.state().status).toBe('Accepted'); expect(f.tables.auditLog).toHaveLength(2);
  });
  it.each(['invoices:read', 'customs:write'])('last original transition audit INSERT then actual %s withdrawal rolls entire TX back', async scope => {
    const f = await fixture(); f.setHook((model, op, row) => { if (model === 'auditLog' && op === 'create' && row.action === 'TRADE_DOCUMENT_TRANSITION') f.revoke(scope); });
    const r = await f.post('Issued'); expect(r.status).toBe(403); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2); expect(f.tables.documentVersion).toHaveLength(1); expect(f.changes).toEqual([]);
  });
  it('actual TeamDataGrant revoked after last native audit INSERT rolls transition and audit back', async () => {
    const f = await fixture(); f.shared(); f.setHook((model, op, row) => { if (model === 'auditLog' && op === 'create' && row.action === 'TRADE_DOCUMENT_TRANSITION') f.tables.teamDataGrant[0].revokedAt = BigInt(1); });
    const r = await f.post('Issued'); expect(r.status).toBe(404); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2); expect(f.changes).toEqual([]);
  });
  it('real account disabled after last audit INSERT rolls metadata and audit back', async () => {
    const f = await fixture(); f.setHook((model, op, row) => { if (model === 'auditLog' && op === 'create' && row.action === 'TRADE_DOCUMENT_TRANSITION') f.tables.userAccount[0].status = 'disabled'; });
    const r = await f.post('Issued'); expect([401,403]).toContain(r.status); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2); expect(f.changes).toEqual([]);
  });
  it('original Invoice cancellation after last transition audit rolls new formal metadata back', async () => {
    const f = await fixture(); f.setHook((model, op, row) => { if (model === 'auditLog' && op === 'create' && row.action === 'TRADE_DOCUMENT_TRANSITION') f.tables.invoice[0].status = 'Cancelled'; });
    const r = await f.post('Issued'); expect(r.status).toBe(409); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2); expect(f.tables.invoice[0].status).toBe('Cancelled'); expect(f.changes).toEqual([]);
  });
  it('mandatory original transition audit fault is system failure and leaves no changed status', async () => {
    const f = await fixture(); f.setHook((model, op, row) => { if (model === 'auditLog' && op === 'create' && row.action === 'TRADE_DOCUMENT_TRANSITION') throw Error('SYNTHETIC_MANDATORY_AUDIT_FAILURE'); });
    const r = await f.post('Issued'); expect(r.status).toBe(500); expect(r.text).not.toContain('SYNTHETIC'); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(2);
  });
  it('signed initiating write/read ceilings and body owner never increase authority', async () => {
    const f = await fixture();
    for (const scope of ['customs:write', 'invoices:read']) { const r = await f.post('Issued', scopes.filter(value => value !== scope), { actor: { userId: 'owner' } }); expect(r.status).toBe(403); }
    const r = await request(f.app).post('/api/v1/customs/trade-documents/' + f.doc.id + '/transition').set('x-bambook-api-key', 'synthetic-key').send({ toStatus: 'Issued' }); expect([401,403]).toContain(r.status); expect(f.state().status).toBe('Draft');
  });
  it('history metadata is separate from new file/source eligibility and does not rewrite snapshots', async () => {
    const f = await fixture(), versions = snapshot(f.tables.documentVersion); f.tables.shipment[0].status = 'Cancelled'; f.tables.shipmentLine[0].quantity = f.tables.orderLine[0].quantity;
    const r = await f.post('Cancelled'); expect(r.status).toBe(200); expect(snapshot(f.tables.documentVersion)).toBe(versions); expect(f.tables.invoice[0].status).toBe('Issued');
  });
  it('genuine linked legacy history keeps legal transitions but permanent Invoice link cannot be deleted', async () => {
    const f = await fixture(); f.tables.auditLog = []; f.tables.documentVersion[0].content = { ...f.state() };
    const r = await f.post('Issued'); expect(r.status).toBe(200); expect(f.state().status).toBe('Issued');
    expect((await f.post('Cancelled')).status).toBe(200); expect((await f.remove()).status).toBe(409); expect(f.state().deletedAt ?? null).toBeNull();
  });
  it('genuine unlinked legacy Draft keeps original delete policy without impersonating Invoice', async () => {
    const f = await fixture(); f.state().sourceInvoiceId = null; f.state().sourceRef = null; f.tables.auditLog = []; f.tables.documentVersion[0].content = { ...f.state() };
    const r = await f.remove(); expect(r.status).toBe(200); expect(f.state().deletedAt).not.toBeNull(); expect(f.tables.invoice[0].status).toBe('Issued');
  });
  it('unlinked legacy cannot issue new formal metadata without an original Invoice', async () => {
    const f = await fixture(); f.state().sourceInvoiceId = null; f.state().sourceRef = null; f.tables.auditLog = []; f.tables.documentVersion[0].content = { ...f.state() };
    const r = await f.post('Issued'); expect(r.status).toBe(409); expect(f.state().status).toBe('Draft'); expect(f.tables.auditLog).toHaveLength(0);
  });
  it('ordinary PL retains original transition/delete rules without requiring Invoice scope', async () => {
    const f = await fixture(), service = createCustomsService(f.db), pl = await service.createTradeDocument({ type: 'PackingList', documentNumber: 'PL-OLD', orderId: 'O' }, 'u'); f.revoke('invoices:read');
    const issue = await request(f.app).post('/api/v1/customs/trade-documents/' + pl.id + '/transition').set('Authorization', 'Bearer ' + f.token()).send({ toStatus: 'Issued' }); expect(issue.status).toBe(200);
    const denied = await request(f.app).delete('/api/v1/customs/trade-documents/' + pl.id).set('Authorization', 'Bearer ' + f.token()); expect(denied.status).toBe(409);
    expect((await service.transitionTradeDocumentStatus(pl.id, 'Cancelled', 'u')).status).toBe('Cancelled'); expect((await service.deleteTradeDocument(pl.id, 'u')).deleted).toBe(true);
  });
});
