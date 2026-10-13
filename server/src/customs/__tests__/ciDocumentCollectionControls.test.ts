/** Ordinary archive rows deliberately avoid PackingList: PL now has a dedicated exact-source producer and acceptance suite.
 * Actual native route/source/auth helpers over deterministic transactional
 * storage; no PostgreSQL, SQL locks, real producer approval or PDF claim. */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createCustomsRouter } from '../customsRoute';
import { createCustomsV2Router } from '../customsRouteV2';
import { createCustomsService } from '../customsService';
import { readCiInvoiceSource, registerCanonicalCi } from '../ciInvoiceSource';
import { storage, actor, scopes } from './ciCollectionStorage';

const auth = createAuthService();
async function fixture() {
  const s = storage(), app = express(); app.use(express.json());
  app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  const options = { prisma: s.db, requireAuth: true, apiKeys: new Set<string>() };
  app.use('/api/v1/customs', createCustomsRouter(options)); app.use('/api/v2/customs', createCustomsV2Router(options));
  const get = (url: string, ceiling?: string[]) => request(app).get(url).set('Authorization', 'Bearer ' + auth.signToken({ ...actor, ...(ceiling ? { permissionCeiling: ceiling } : {}) }));
  const ci = async (suffix: string, hidden = false) => {
    const invoice = { ...s.tables.invoice[0], id: 'INV_' + suffix, invoiceNumber: 'FIN_' + suffix };
    s.tables.invoice.push(invoice); s.tables.invoiceOrderAllocation.push({ ...s.tables.invoiceOrderAllocation[0], id: 'IOA_' + suffix, invoiceId: invoice.id });
    const source = await readCiInvoiceSource(s.db, { trustedActor: actor, sourceInvoiceId: invoice.id, shipmentId: 'S', mode: 'register' });
    const result = await registerCanonicalCi(s.db, { trustedActor: actor, sourceInvoiceId: invoice.id, shipmentId: 'S', mode: 'register', expectedSourceFingerprint: source.fingerprint });
    if (hidden) invoice.ownerId = 'other';
    return result.document;
  };
  const pl = async (suffix: string) => createCustomsService(s.db).createTradeDocument({ type: 'Other', documentNumber: 'ARCH_' + suffix, orderId: 'O', consignee: 'Buyer', issuedBy: 'Issuer' }, 'u');
  const rows = [await ci('hidden', true), await pl('one'), await ci('one'), await pl('two'), await ci('two'), await pl('three'), await pl('four')];
  rows.forEach((row, i) => { s.tables.tradeDocument.find(doc => doc.id === row.id).createdAt = BigInt(100 - i); });
  // Actual reloaded account chooses original sales/team L2, not fixture JWT roles.
  s.tables.userAccount[0].roles = [{ roleId: 'role-sales', role: { permissions: [] } }];
  s.calls.length = 0; s.queries.length = 0;
  return { ...s, app, get, rows, visibleIds: rows.slice(1).map(row => row.id), ci, pl };
}
describe('complete native CI-visible collection before original pagination', () => {
  it.each(['/api/v1/customs/trade-documents', '/api/v2/customs/documents'])('mixed hidden CI + authorized CI + ordinary archive keeps three complete pages: %s', async url => {
    const f = await fixture();
    for (let page = 0; page < 3; page++) {
      const response = await f.get(url + '?limit=2&offset=' + page * 2);
      expect(response.status).toBe(200); expect(response.body.total).toBe(6);
      expect(response.body.items.map((row: any) => row.id)).toEqual(f.visibleIds.slice(page * 2, page * 2 + 2));
      expect(response.text).not.toContain('FIN_hidden');
    }
  });
  it('type/status/domain/source/search filters remain native before visibility and count', async () => {
    const f = await fixture();
    for (const filter of ['type=CommercialInvoice&status=Draft&domain=customs', 'sourceInvoiceId=INV_one', 'search=ARCH_']) {
      const r = await f.get('/api/v1/customs/trade-documents?' + filter + '&limit=1');
      expect(r.status).toBe(200); expect(r.body.total).toBe(filter.startsWith('type') ? 2 : filter.startsWith('source') ? 1 : 4);
      expect(r.body.items).toHaveLength(1); expect(r.text).not.toContain('FIN_hidden');
    }
  });
  it('all hidden is truly empty; beyond-page and zero-page keep complete visible total', async () => {
    const f = await fixture();
    const empty = await f.get('/api/v1/customs/trade-documents?sourceInvoiceId=INV_hidden');
    expect(empty.status).toBe(200); expect(empty.body).toMatchObject({ items: [], total: 0 });
    for (const query of ['limit=2&offset=99', 'limit=0']) {
      const r = await f.get('/api/v1/customs/trade-documents?' + query);
      expect(r.status).toBe(200); expect(r.body).toMatchObject({ items: [], total: 6 });
    }
  });
  it('permission withdrawn while reading an off-page CI recomputes every page and total', async () => {
    const f = await fixture(); let fired = false;
    f.setHook((model, op, row) => { if (!fired && model === 'invoice' && op === 'findFirst' && row?.id === 'INV_two') { fired = true; f.revoke('invoices:read'); } });
    const r = await f.get('/api/v1/customs/trade-documents?limit=2');
    expect(fired).toBe(true); expect(r.status).toBe(200); expect(r.body.total).toBe(4);
    expect(r.body.items.map((row: any) => row.documentNumber)).toEqual(['ARCH_one', 'ARCH_two']);
  });
  it('late native L2 withdrawal outside selected page removes already-authorized CI', async () => {
    const f = await fixture(); let fired = false;
    f.setHook((model, op, row) => { if (!fired && model === 'invoice' && op === 'findFirst' && row?.id === 'INV_two') { fired = true; f.tables.relation[0].ownerId = 'other'; } });
    const r = await f.get('/api/v1/customs/trade-documents?limit=2');
    expect(fired).toBe(true); expect(r.status).toBe(200); expect(r.body.total).toBe(4);
    expect(r.body.items.map((row: any) => row.documentNumber)).toEqual(['ARCH_one', 'ARCH_two']);
  });
  it('actual TeamDataGrant revoked on an off-page CI removes every linked CI', async () => {
    const f = await fixture(); f.tables.relation[0].ownerId = 'other';
    f.tables.teamMember.push({ id: 'TM', teamId: 'T', userId: 'u', leftAt: null, team: { deletedAt: null } });
    f.tables.teamDataGrant.push({ id: 'SHARE', teamId: 'T', entityType: 'relation', entityId: 'R', revokedAt: null, team: { deletedAt: null } });
    let fired = false;
    f.setHook((model, op, row) => { if (!fired && model === 'invoice' && op === 'findFirst' && row?.id === 'INV_two') { fired = true; f.tables.teamDataGrant[0].revokedAt = BigInt(1); } });
    const r = await f.get('/api/v1/customs/trade-documents?limit=2'); expect(fired).toBe(true);
    expect(r.status).toBe(200); expect(r.body.total).toBe(4); expect(r.body.items.map((row: any) => row.documentNumber)).toEqual(['ARCH_one', 'ARCH_two']);
  });
  it.each(['teamMember', 'invoice', 'auditLog'])('dependency %s fault is unavailable, never empty or skipped', async dependency => {
    const f = await fixture(); f.setHook((model, op) => { if (model === dependency && (op === 'findMany' || op === 'findFirst')) throw Error('SYNTHETIC_DEPENDENCY_FAULT'); });
    const r = await f.get('/api/v1/customs/trade-documents'); expect(r.status).toBe(dependency === 'teamMember' ? 503 : 500); expect(r.body.items).toBeUndefined();
  });
  it('personal grant storage unknown denies whole mixed collection, not empty', async () => {
    const f = await fixture(); f.setHook((model, op) => { if (model === 'userPermissionOverrides' && op === 'findMany') throw Error('SYNTHETIC_GRANT_UNKNOWN'); });
    const r = await f.get('/api/v1/customs/trade-documents'); expect([500,503]).toContain(r.status); expect(r.body.items).toBeUndefined();
  });
  it('damaged native receipt/audit is conflict, never silently invisible', async () => {
    const f = await fixture(); f.tables.auditLog = f.tables.auditLog.filter(row => row.targetId !== f.rows[2].id || row.action !== 'TRADE_DOCUMENT_CREATE');
    const r = await f.get('/api/v1/customs/trade-documents?limit=1'); expect(r.status).toBe(409); expect(r.body.items).toBeUndefined();
  });
  it('signed read ceiling filters linked CI without hiding ordinary archive', async () => {
    const f = await fixture(), r = await f.get('/api/v1/customs/trade-documents', scopes.filter(scope => scope !== 'invoices:read'));
    expect(r.status).toBe(200); expect(r.body.total).toBe(4); expect(r.body.items.every((row: any) => row.type === 'Other')).toBe(true);
  });
  it('last authority read disables real account and denies whole response including ordinary archive', async () => {
    const f = await fixture(); let checks = 0;
    f.setHook((model, op) => { if (model === 'userPermissionOverrides' && op === 'findMany' && ++checks === 15) f.tables.userAccount[0].status = 'disabled'; });
    const r = await f.get('/api/v1/customs/trade-documents'); expect(checks).toBeGreaterThanOrEqual(15); expect([401,403]).toContain(r.status); expect(r.body.items).toBeUndefined();
  });
  it('order pack excludes hidden CI but retains authorized native snapshots and ordinary archive', async () => {
    const f = await fixture(), r = await f.get('/api/v1/customs/trade-documents/pack?orderId=O');
    expect(r.status).toBe(200); expect(r.body.total).toBe(6); expect(r.body.items.map((row: any) => row.id)).toEqual([...f.visibleIds].reverse()); expect(r.text).not.toContain('FIN_hidden');
  });
  it('complete traversal uses bounded native reads beyond first chunk', async () => {
    const f = await fixture();
    for (let i = 0; i < 205; i++) f.tables.tradeDocument.push({ ...f.tables.tradeDocument.find(row => row.id === f.rows[1].id), id: 'PAGED_' + i, documentNumber: 'PAGED_' + i, createdAt: BigInt(-i) });
    const r = await f.get('/api/v1/customs/trade-documents?limit=2&offset=209'); expect(r.status).toBe(200); expect(r.body.total).toBe(211); expect(r.body.items).toHaveLength(2);
    const reads = f.queries.filter(row => row.model === 'tradeDocument' && row.operation === 'findMany'); expect(reads.some(row => row.args.skip >= 200)).toBe(true); expect(reads.every(row => Number.isSafeInteger(row.args.take) && row.args.take <= 200)).toBe(true);
  });
  it('explicit ordinary type keeps original service where/sort/page/count behavior', async () => {
    const f = await fixture(), expected = await createCustomsService(f.db).listTradeDocuments({ type: 'Other', search: 'ARCH_', limit: 2, offset: 1 });
    const r = await f.get('/api/v1/customs/trade-documents?type=Other&search=ARCH_&limit=2&offset=1');
    expect(r.status).toBe(200); expect(r.body.total).toBe(expected.total); expect(r.body.items.map((row: any) => row.id)).toEqual(expected.items.map(row => row.id));
  });
});
