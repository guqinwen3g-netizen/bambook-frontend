import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordAuthorityFixtureProof } from '../../auth/__tests__/currentAuthorityFixtureProof';
import { createOrdersRouter } from '../route';
import { queryOrders, getOrderContext } from '../query';

// Storage-only substitute: real current account/grant/scope and domain queries run.
// No authorization, source or money helper is mocked. All writes/SQL are forbidden.
const allScopes = ['orders:read', 'products:read', 'quotations:read', 'bom:read',
  'procurement:read', 'production:read', 'shipments:read', 'customs:read',
  'invoices:read', 'vouchers:read'];
const secret = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const actor = (ceiling?: string[]) => ({ userId: 'sales-1', roles: ['sales'] as any,
  permissions: allScopes, authorizationLoaded: true as const,
  ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}) });
function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k,v]: any) => {
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every(x => matches(row,x));
    if (k === 'OR') return v.some((x: any) => matches(row,x));
    if (k === 'NOT') return !matches(row,v);
    const actual = row[k] ?? null;
    if (v === null || typeof v !== 'object') return actual === v;
    if ('in' in v) return v.in.includes(actual);
    if ('contains' in v) return String(actual ?? '').toLowerCase().includes(String(v.contains).toLowerCase());
    if ('has' in v) return Array.isArray(actual) && actual.includes(v.has);
    if ('equals' in v) return actual === v.equals;
    if ('gt' in v) return actual > v.gt;
    if ('gte' in v) return actual >= v.gte;
    if ('lte' in v) return actual <= v.lte;
    return matches(actual,v);
  });
}
function project(row: any, select?: any): any {
  if (!select) return { ...row };
  return Object.fromEntries(Object.entries(select).filter(([,v]) => v).map(([k,v]: any) => [k,
    v === true ? row[k] : Array.isArray(row[k]) ? row[k].map((x: any) => project(x,v.select)) : project(row[k] ?? {},v.select)]));
}
let latestFixture: any;
function store() {
  const s = {
    grants: [...allScopes], active: true, hook: undefined as undefined | ((model: string,args: any) => void),
    rows: {
      order: [{ id:'O1', poNumber:'PO1', deletedAt:null, customerRelationId:'R1', ownerId:'sales-1', sourceCaseId:null, lines:[] },
        { id:'O2', poNumber:'PO2', deletedAt:null, customerRelationId:'R2', ownerId:'other', sourceCaseId:null, lines:[] }],
      relation: [{ id:'R1', deletedAt:null, ownerId:'sales-1', salesRepIds:[] }, { id:'R2', deletedAt:null, ownerId:'other', salesRepIds:[] }],
      teamMember: [], teamDataGrant: [], userPermissionOverrides: [],
      quotation: [], developmentCase: [], sample: [], sealSample: [], sampleBatch: [], bOM: [], purchaseOrder: [],
      productionStage: [], inspectionReport: [], outsourcingOrder: [], shipment: [], shipmentOrderAllocation: [],
      invoice: [], invoiceOrderAllocation: [], paymentVoucher: [], invoiceAllocation: [], customsDeclaration: [], taxRefund: [],
    } as Record<string,any[]>,
    writes: [] as string[], db: {} as any,
  };
  for (const name of Object.keys(s.rows)) {
    const read = async (args: any = {}) => {
      s.hook?.(name,args);
      const rows = s.rows[name].filter(x => matches(x,args.where));
      const offset = args.skip ?? 0, end = args.take === undefined ? undefined : offset + args.take;
      return rows.slice(offset,end).map(x => project(x,args.select));
    };
    s.db[name] = { findMany:vi.fn(read), findFirst:vi.fn(async (a: any) => (await read(a))[0] ?? null),
      count:vi.fn(async (a: any) => (await read(a)).length) };
    for (const method of ['create','update','updateMany','delete','deleteMany','upsert']) {
      s.db[name][method] = vi.fn(() => { s.writes.push(name+'.'+method); throw Error('WRITE_FORBIDDEN'); });
    }
  }
  const currentAccount = () => ({
    id:'sales-1', status:s.active ? 'active':'disabled', deletedAt:null, displayName:'Sales', primaryDeptId:null,
    roles:[{roleId:'role-sales', departmentId:null, role:{id:'role-sales', permissions:s.grants.map(scope => ({permission:{scope}}))}}],
  });
  s.db.userAccount = { findFirst:vi.fn(async ({where}: any) => where.id === 'sales-1' ? currentAccount() : null),
    findUnique:vi.fn(async ({where,select}: any) => { const current=currentAccount(); return matches(current,where) ? project(current,select) : null; }) };
  s.db.$queryRaw = vi.fn(() => { s.writes.push('SQL'); throw Error('SQL_FORBIDDEN'); });
  s.db.$executeRaw = s.db.$queryRaw;
  latestFixture = s;
  return s;
}
afterEach(async context=>recordAuthorityFixtureProof('orderQueryContextAuthority.test.ts',context.task,latestFixture));
function http(s: ReturnType<typeof store>, tokenActor = actor()) {
  const app = express(); app.use(express.json());
  app.use('/api/v1/orders', createOrdersRouter({prisma:s.db,requireAuth:true,apiKeys:new Set()}));
  const token = jwt.sign(tokenActor,secret);
  return { app, auth:`Bearer ${token}` };
}
function development(s: ReturnType<typeof store>) {
  s.rows.developmentCase.push({id:'C1',deletedAt:null,linkedOrderId:null,code:'DEV1',name:'原开发案',type:'garment',stage:'approved',currentRound:1});
  s.rows.sampleBatch.push({id:'B1',deletedAt:null,developmentCaseId:'C1',sampleType:'garment-round',round:1,status:'sent',confirmStatus:'confirmed',confirmedAt:4});
}
function childReads(s: ReturnType<typeof store>) {
  return Object.keys(s.rows).filter(k => !['order','relation','teamMember','teamDataGrant','userPermissionOverrides'].includes(k))
    .reduce((n,k) => n+s.db[k].findMany.mock.calls.length,0);
}
describe('company Orders current authority and original context source contracts', () => {
  it('list and count AND the same current Order L2 without replacing the search OR', async () => {
    const s=store(),h=http(s);
    const list=await request(h.app).post('/api/v1/orders/query').set('Authorization',h.auth).send({query:'PO'});
    const count=await request(h.app).post('/api/v1/orders/query').set('Authorization',h.auth).send({aggregate:'count',query:'PO'});
    expect(list.status).toBe(200); expect(list.body.items.map((x:any)=>x.id)).toEqual(['O1']);
    expect(list.body.total).toBe(1);expect(count.body.count).toBe(1);
    expect(s.db.order.findMany.mock.calls[0][0].where).toEqual(s.db.order.count.mock.calls[0][0].where);
    expect(s.db.order.count.mock.calls[0][0].where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining({OR:expect.arrayContaining([{id:'PO'}])}),
      expect.objectContaining({OR:expect.arrayContaining([{customerRelationId:{in:['R1']}}])}),
    ])); expect(s.writes).toEqual([]);
  });
  it.each(['O2','PO2'])('invisible parent %s is 404 before any child query', async id => {
    const s=store(),h=http(s);const res=await request(h.app).get(`/api/v1/orders/${id}/context`).set('Authorization',h.auth);
    expect(res.status).toBe(404);expect(res.body.error.code).toBe('NOT_FOUND');expect(childReads(s)).toBe(0);
  });
  it('revoked current orders grant is rejected even with an old granted JWT', async () => {
    const s=store(),h=http(s);s.grants=[];
    const res=await request(h.app).post('/api/v1/orders/query').set('Authorization',h.auth).send({});
    expect(res.status).toBe(403);expect(res.body.error.code).toBe('FORBIDDEN');expect(s.db.order.findMany).not.toHaveBeenCalled();
  });
  it('a signed empty ceiling and body actor cannot manufacture read authority', async () => {
    const s=store(),h=http(s,actor([]));
    const res=await request(h.app).post('/api/v1/orders/query').set('Authorization',h.auth).send({actor:{userId:'owner',roles:['owner']},developmentRead:true});
    expect(res.status).toBe(403);expect(s.db.order.findMany).not.toHaveBeenCalled();
    await expect((queryOrders as any)(s.db,{actor:{userId:'owner'},developmentRead:true})).rejects.toMatchObject({code:'UNAUTHORIZED'});
  });
  it('disabled account and unavailable current grants do not become empty successful reads', async () => {
    const s=store(),h=http(s);s.active=false;
    let res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(401);expect(res.body.error.code).toBe('ACCOUNT_DISABLED');expect(childReads(s)).toBe(0);
    s.active=true;s.db.userPermissionOverrides.findMany.mockRejectedValueOnce(Error('stored-grant-fault'));
    res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(503);expect(res.body.error.code).toBe('AUTHORIZATION_UNAVAILABLE');expect(childReads(s)).toBe(0);
  });
  it('domain denial is explicit and makes no finance/source child reads', async () => {
    const s=store(),h=http(s);s.grants=['orders:read'];
    const res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(200);expect(res.body.finance).toEqual({invoices:[],vouchers:[]});
    expect(res.body.restrictedStages).toEqual(expect.arrayContaining(['development','finance.invoices','finance.vouchers','shipment','customs']));
    expect(childReads(s)).toBe(0);expect(s.writes).toEqual([]);
  });
  it('UI14 original Sample provenance works with both header links null and no writes', async () => {
    const s=store(),h=http(s);development(s);
    s.rows.order[0].lines=[{id:'L1',confirmedSourceType:'Sample',confirmedSourceId:'S1'}];
    s.rows.sample=[{id:'S1',deletedAt:null,sourceCaseId:'C1',status:'revision'}];
    const before=JSON.stringify(s.rows);
    const res=await request(h.app).get('/api/v1/orders/PO1/context').set('Authorization',h.auth);
    expect(res.status).toBe(200);expect(res.body.developmentCase.map((x:any)=>x.id)).toEqual(['C1']);
    expect(res.body.developmentCase[0].sampleNodes.map((x:any)=>[x.id,x.status])).toEqual([['B1','approved']]);
    expect(JSON.stringify(s.rows)).toBe(before);expect(s.writes).toEqual([]);
  });
  it.each(['header','legacy','seal'])('the isolated %s source works without either of the other provenance paths', async kind => {
    const s=store();development(s);
    if(kind==='header')s.rows.order[0].sourceCaseId='C1';
    if(kind==='legacy')s.rows.developmentCase[0].linkedOrderId='O1';
    if(kind==='seal'){s.rows.order[0].lines=[{confirmedSourceType:'SealSample',confirmedSourceId:'SS1'}];s.rows.sealSample=[{id:'SS1',deletedAt:null,developmentCaseId:'C1'}];}
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.developmentCase.map((x:any)=>x.id)).toEqual(['C1']);expect(s.writes).toEqual([]);
  });
  it('header, SealSample and legacy sources are deduplicated without a current confirmation gate', async () => {
    const s=store();development(s);s.rows.order[0].sourceCaseId='C1';s.rows.developmentCase[0].linkedOrderId='O1';
    s.rows.order[0].lines=[{confirmedSourceType:'SealSample',confirmedSourceId:'SS1'},{confirmedSourceType:'SealSample',confirmedSourceId:'SS1'}];
    s.rows.sealSample=[{id:'SS1',deletedAt:null,developmentCaseId:'C1',status:'revision'}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.developmentCase.map((x:any)=>x.id)).toEqual(['C1']);expect(s.db.sealSample.findMany).toHaveBeenCalledTimes(1);
    expect(s.db.sealSample.findMany.mock.calls[0][0].where.id.in).toEqual(['SS1']);
  });
  it('Asset and deleted sample sources do not guess or backfill a development case', async () => {
    const s=store();development(s);s.rows.order[0].lines=[{confirmedSourceType:'Asset',confirmedSourceId:'A1'},{confirmedSourceType:'Sample',confirmedSourceId:'S1'}];
    s.rows.sample=[{id:'S1',deletedAt:1,sourceCaseId:'C1'}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.developmentCase).toEqual([]);expect(s.db.sealSample.findMany).not.toHaveBeenCalled();expect(s.writes).toEqual([]);
  });
  it('BOM costs are null without sensitive:cost while sales quotation amount is preserved', async () => {
    const s=store();s.rows.bOM=[{id:'BOM1',deletedAt:null,orderId:'O1',bomNumber:'BOM1',totalCost:700,currency:'USD'}];
    s.rows.quotation=[{id:'Q1',deletedAt:null,convertedOrderId:'O1',totalAmount:900,currency:'USD'}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.bom[0].totalCost).toBeNull();expect(res.quotation[0].totalAmount).toBe(900);
  });
  it('finance object scope excludes another operator invoice even when parent Order is visible', async () => {
    const s=store();s.rows.invoice=[{id:'I1',deletedAt:null,orderId:'O1',ownerId:'other',amount:999999}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.finance.invoices).toEqual([]);expect(s.db.invoiceAllocation.findMany).not.toHaveBeenCalled();
  });
  it('non-first IOA invoice retains exact order share without disclosing hidden customer totals', async () => {
    const s=store();s.rows.invoice=[{id:'I1',invoiceNumber:'INV1',type:'Receivable',deletedAt:null,orderId:'O2',ownerId:'sales-1',amount:300,currency:'USD'}];
    s.rows.invoiceOrderAllocation=[{id:'IOA1',deletedAt:null,invoiceId:'I1',orderId:'O1',allocatedAmount:new Prisma.Decimal('100.0001')},
      {id:'IOA2',deletedAt:null,invoiceId:'I1',orderId:'O2',allocatedAmount:new Prisma.Decimal('199.9999')}];
    s.rows.invoiceAllocation=[{id:'A1',invoiceId:'I1',voucherId:'V_OTHER',appliedAmount:300,appliedDate:'2026-01-01'}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.finance.invoices).toHaveLength(1);expect(res.finance.invoices[0]).toMatchObject({id:'I1',amount:null,orderAllocatedAmount:'100.0001',amountScope:'restricted_shared',sharedSource:true});
    expect(res.finance.invoices[0].allocations[0].appliedAmount).toBeNull();
    expect(JSON.stringify(res)).not.toContain('199.9999');expect(JSON.stringify(res)).not.toContain('V_OTHER');
  });
  it('unknown mixed IOA share stays null rather than whole invoice amount or zero', async () => {
    const s=store();s.rows.invoice=[{id:'I1',deletedAt:null,orderId:'O2',ownerId:'sales-1',amount:300}];
    s.rows.invoiceOrderAllocation=[{id:'IOA1',deletedAt:null,invoiceId:'I1',orderId:'O1',allocatedAmount:null},{id:'IOA2',deletedAt:null,invoiceId:'I1',orderId:'O2',allocatedAmount:300}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.finance.invoices[0].amount).toBeNull();expect(res.finance.invoices[0].orderAllocatedAmount).toBeNull();
  });
  it('non-first SOA shipment is visible but shared customs/refund money is not assigned to this Order', async () => {
    const s=store();s.rows.shipment=[{id:'SH1',deletedAt:null,orderId:'O2',shipmentNumber:'SH1',status:'Shipped'}];
    s.rows.shipmentOrderAllocation=[{id:'SOA1',shipmentId:'SH1',orderId:'O1'},{id:'SOA2',shipmentId:'SH1',orderId:'O2'}];
    s.rows.customsDeclaration=[{id:'D1',deletedAt:null,orderId:null,shipmentId:'SH1',totalValue:333,currency:'USD'}];
    s.rows.taxRefund=[{id:'T1',deletedAt:null,orderId:null,declarationId:'D1',exportAmountFob:333,refundAmount:33}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.shipments).toHaveLength(1);expect(res.shipments[0].sharedSource).toBe(true);
    expect(res.shipments[0].customsDeclarations[0]).toMatchObject({id:'D1',totalValue:null,sharedSource:true});
    expect(res.shipments[0].customsDeclarations[0].taxRefunds[0]).toMatchObject({id:'T1',refundAmount:null,exportAmountFob:null,sharedSource:true});
  });
  it('current grant revocation during aggregation discards the entire old response', async () => {
    const s=store(),h=http(s);s.hook=model=>{if(model==='purchaseOrder')s.grants=[];};
    const res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(403);expect(res.body.error.code).toBe('FORBIDDEN');expect(res.body.order).toBeUndefined();
  });
  it('customer transfer during aggregation is re-read as 404 before response', async () => {
    const s=store(),h=http(s);s.hook=model=>{if(model==='taxRefund')s.rows.order[0].customerRelationId='R2';};
    const res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(404);expect(res.body.order).toBeUndefined();expect(s.writes).toEqual([]);
  });
  it('direct legacy single-order invoice keeps its original whole-ticket amount meaning', async () => {
    const s=store();s.rows.invoice=[{id:'I1',deletedAt:null,orderId:'O1',ownerId:'sales-1',amount:100,currency:'USD'}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.finance.invoices[0]).toMatchObject({amount:100,orderAllocatedAmount:null,amountScope:'invoice_total',sharedSource:false});
  });
  it('a genuinely visible whole shared ticket preserves total and separate exact order share', async () => {
    const s=store();s.rows.relation[1].ownerId='sales-1';
    s.rows.invoice=[{id:'I1',deletedAt:null,orderId:'O2',ownerId:'sales-1',amount:300,currency:'USD'}];
    s.rows.invoiceOrderAllocation=[{invoiceId:'I1',orderId:'O1',deletedAt:null,allocatedAmount:new Prisma.Decimal('100.0001')},
      {invoiceId:'I1',orderId:'O2',deletedAt:null,allocatedAmount:new Prisma.Decimal('199.9999')}];
    const res=await (getOrderContext as any)(s.db,'O1',{actor:actor()});
    expect(res.finance.invoices[0]).toMatchObject({amount:300,orderAllocatedAmount:'100.0001',amountScope:'invoice_total',sharedSource:true});
    expect(JSON.stringify(res)).not.toContain('199.9999');
  });
  it('a domain/sensitive grant revoked during aggregation cannot expose the old readable value', async () => {
    const s=store(),h=http(s);s.grants.push('sensitive:cost');
    s.rows.bOM=[{id:'BOM1',orderId:'O1',deletedAt:null,totalCost:999}];
    s.hook=model=>{if(model==='taxRefund')s.grants=s.grants.filter(x=>x!=='sensitive:cost');};
    const res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(403);expect(res.body.bom).toBeUndefined();
  });
  it('finance object transfer during aggregation discards prior invoice data', async () => {
    const s=store(),h=http(s);s.rows.invoice=[{id:'I1',orderId:'O1',deletedAt:null,ownerId:'sales-1',amount:100}];
    s.hook=model=>{if(model==='taxRefund')s.rows.invoice[0].ownerId='other';};
    const res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(403);expect(res.body.finance).toBeUndefined();
  });
  it('receipt voucher identity is rechecked against current finance scope before returning it', async () => {
    const s=store(),h=http(s);s.rows.invoice=[{id:'I1',orderId:'O1',deletedAt:null,ownerId:'sales-1',amount:100}];
    s.rows.paymentVoucher=[{id:'V1',orderId:null,deletedAt:null,ownerId:'sales-1'}];
    s.rows.invoiceAllocation=[{id:'A1',invoiceId:'I1',voucherId:'V1',appliedAmount:100,appliedDate:'2026-10-03'}];
    s.hook=model=>{if(model==='taxRefund')s.rows.paymentVoucher[0].ownerId='other';};
    const res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(403);expect(JSON.stringify(res.body)).not.toContain('V1');expect(res.body.finance).toBeUndefined();
  });
  it('list row transfer after the initial read cannot survive the response-time parent scope check', async () => {
    const s=store(),h=http(s);const native=s.db.order.findMany.getMockImplementation();let called=0;
    s.db.order.findMany.mockImplementation(async (args:any)=>{const rows=await native(args);if(++called===1)s.rows.order[0].customerRelationId='R2';return rows;});
    const res=await request(h.app).post('/api/v1/orders/query').set('Authorization',h.auth).send({query:'PO'});
    expect(res.status).toBe(403);expect(res.body.items).toBeUndefined();
  });
  it('count is freshly scoped after a customer transfer rather than returning a stale count', async () => {
    const s=store(),h=http(s);const native=s.db.order.count.getMockImplementation();let called=0;
    s.db.order.count.mockImplementation(async (args:any)=>{const count=await native(args);if(++called===1)s.rows.order[0].customerRelationId='R2';return count;});
    const res=await request(h.app).post('/api/v1/orders/query').set('Authorization',h.auth).send({aggregate:'count'});
    expect(res.status).toBe(200);expect(res.body.count).toBe(0);expect(s.db.order.findMany).not.toHaveBeenCalled();
  });
  it('fresh Team scope storage faults cannot return apparent no-record success', async () => {
    const s=store(),h=http(s);s.db.teamMember.findMany.mockRejectedValue(Error('TEAM_STORAGE_FAULT'));
    const res=await request(h.app).get('/api/v1/orders/O1/context').set('Authorization',h.auth);
    expect(res.status).toBe(503);expect(res.body.error.code).toBe('AUTHORIZATION_UNAVAILABLE');expect(childReads(s)).toBe(0);
  });
});
