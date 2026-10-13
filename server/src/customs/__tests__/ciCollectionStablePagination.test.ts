/** Native reader argument + actual route/history controls over substituted
 * transaction storage. Tied-reader disorder is an explicit injected boundary;
 * no PG sort/lock/performance proof or approved business facts claimed. */
import { describe, expect, it } from 'vitest';
import express from 'express'; import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createCustomsRouter } from '../customsRoute';
import { createCustomsService } from '../customsService';
import { readCiInvoiceSource, registerCanonicalCi } from '../ciInvoiceSource';
import { storage, actor } from './ciCollectionStorage';
const auth = createAuthService();
async function fixture() {
  const s = storage(), app = express(); app.use(express.json()); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use('/api/v1/customs', createCustomsRouter({ prisma: s.db, requireAuth: true, apiKeys: new Set<string>() }));
  const source = await readCiInvoiceSource(s.db, { trustedActor: actor, sourceInvoiceId: 'INV', shipmentId: 'S', mode: 'register' });
  const native = (await registerCanonicalCi(s.db, { trustedActor: actor, sourceInvoiceId: 'INV', shipmentId: 'S', mode: 'register', expectedSourceFingerprint: source.fingerprint })).document;
  s.tables.invoice.push({ ...s.tables.invoice[0], id: 'HIDDEN', invoiceNumber: 'HIDDEN-FIN' });
  s.tables.invoiceOrderAllocation.push({ ...s.tables.invoiceOrderAllocation[0], id: 'HIDDEN-IOA', invoiceId: 'HIDDEN' });
  const hiddenSource = await readCiInvoiceSource(s.db, { trustedActor: actor, sourceInvoiceId: 'HIDDEN', shipmentId: 'S', mode: 'register' });
  const hidden = (await registerCanonicalCi(s.db, { trustedActor: actor, sourceInvoiceId: 'HIDDEN', shipmentId: 'S', mode: 'register', expectedSourceFingerprint: hiddenSource.fingerprint })).document;
  s.tables.invoice.find(row => row.id === 'HIDDEN').ownerId = 'other';
  const template = await createCustomsService(s.db).createTradeDocument({ type: 'PackingList', documentNumber: 'PL-TEMPLATE', orderId: 'O' }, 'u');
  s.tables.tradeDocument = s.tables.tradeDocument.filter(row => row.id !== template.id);
  for (let i = 400; i >= 0; i--) s.tables.tradeDocument.push({ ...template, id: 'PL_' + String(i).padStart(4, '0'), documentNumber: 'PL_' + i });
  for (const row of s.tables.tradeDocument) row.createdAt = BigInt(77);
  const visibleIds = s.tables.tradeDocument.filter(row => row.id !== hidden.id).map(row => row.id).sort();
  s.tables.userAccount[0].roles = [{ roleId: 'role-sales', role: { permissions: [] } }];
  const get = (url: string) => request(app).get(url).set('Authorization', 'Bearer ' + auth.signToken(actor));
  const lastPageQuery = () => { const queries = s.queries.filter(row => row.model === 'tradeDocument' && row.operation === 'findMany'); return queries[queries.length - 1]?.args; };
  s.queries.length = 0; s.calls.length = 0;
  return { ...s, get, native, hidden, visibleIds, lastPageQuery };
}
function hasStableId(args: any) { return Array.isArray(args?.orderBy) && args.orderBy.some((part: any) => part.id === 'asc'); }
describe('CI-only native pagination retains primary sort and stable id ties', () => {
  it('403 same-createdAt rows traverse native200 boundaries and return three complete visible pages', async () => {
    const f = await fixture(); let first: any;
    // PostgreSQL can choose a different order among ties per LIMIT/OFFSET query.
    // Inject that boundary only when the native query has no stable id suffix.
    f.setHook((model, op, rows) => { if (model !== 'tradeDocument' || op !== 'findMany' || !Array.isArray(rows)) return; const args = f.lastPageQuery(); if (args?.take !== 200 || hasStableId(args)) return; if (!args.skip) first = rows[0]; else if (rows.length && first) rows[0] = { ...first }; });
    const ids: string[] = [];
    for (let page = 0; page < 3; page++) { const r = await f.get('/api/v1/customs/trade-documents?limit=200&offset=' + page * 200); expect(r.status).toBe(200); expect(r.body.total).toBe(402); ids.push(...r.body.items.map((row: any) => row.id)); }
    expect(ids).toEqual(f.visibleIds); expect(new Set(ids).size).toBe(402); expect(ids).not.toContain(f.hidden.id);
    const pages = f.queries.filter(row => row.model === 'tradeDocument' && row.args.take === 200);
    expect(pages.some(row => row.args.skip === 400)).toBe(true); for (const row of pages) expect(row.args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
  it('original order pack keeps ascending primary and receives stable native tie queries', async () => {
    const f = await fixture(), r = await f.get('/api/v1/customs/trade-documents/pack?orderId=O');
    expect(r.status).toBe(200); expect(r.body.total).toBe(402); expect(r.body.items.map((row: any) => row.id)).toEqual(f.visibleIds);
    const pages = f.queries.filter(row => row.model === 'tradeDocument' && row.args.take === 200);
    expect(pages.some(row => row.args.skip === 400)).toBe(true);
    for (const row of pages) { expect(row.args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]); expect(row.args.where).toEqual({ orderId: 'O', deletedAt: null }); }
  });
  it('duplicate native id despite stable query is conflict and cannot become partial or empty', async () => {
    const f = await fixture(); let first: any;
    f.setHook((model, op, rows) => { if (model !== 'tradeDocument' || op !== 'findMany' || !Array.isArray(rows)) return; const args = f.lastPageQuery(); if (args?.take !== 200) return; if (!args.skip) first = rows[0]; else if (rows.length && first) rows[0] = { ...first }; });
    const r = await f.get('/api/v1/customs/trade-documents'); expect(r.status).toBe(409); expect(r.body.items).toBeUndefined(); expect(r.body.total).toBeUndefined();
  });
  it('explicit ordinary list retains original single-primary native query without id suffix', async () => {
    const f = await fixture(), r = await f.get('/api/v1/customs/trade-documents?type=PackingList&limit=2&offset=3');
    expect(r.status).toBe(200); expect(r.body.total).toBe(401); const query = f.queries.find(row => row.model === 'tradeDocument' && row.args.take === 2);
    expect(query?.args.orderBy).toEqual({ createdAt: 'desc' }); expect(query?.args.skip).toBe(3); expect(query?.args.where).toEqual({ deletedAt: null, type: 'PackingList' });
  });
  it('unknown native reader failure remains unavailable, never an empty visible result', async () => {
    const f = await fixture(); f.setHook((model, op) => { if (model === 'tradeDocument' && op === 'findMany' && f.lastPageQuery()?.take === 200) throw Error('SYNTHETIC_NATIVE_READER_UNKNOWN'); });
    const r = await f.get('/api/v1/customs/trade-documents'); expect(r.status).toBe(500); expect(r.body.items).toBeUndefined();
  });
});
