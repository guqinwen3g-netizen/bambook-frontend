/**
 * REQ2-16 样品间管理回归测试（设计文档 §6 验收锚点 + v2 库存联动）
 *
 * 覆盖（DR-057 三决策 + v2 升级）：
 *   ① 实体/逻辑分轨：colorCardCode 弱关联；② 借还统一流水 append-only + 状态机；
 *   ③ 编号 SC-YYYYMMDD-NNN 当日递增
 *   ④ 借出占用/看样即看即还/逾期派生/退役终态/重复借还 409
 *   v2：⑤ 库存字段（quantity/availableQty/minStock/maxStock/warehouseId/devCaseId/orderId）
 *       ⑥ 借出数量 loanQuantity + 部分借出 + INSUFFICIENT_QTY 校验
 *       ⑦ 低库存预警 listLowStock
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createSampleRoomService } from '../sampleRoomService';
import { createSampleRouter } from '../sampleRoute';
import * as nativeReceipt from '../orderSamplePhysicalReceiptService';
import { OrderSampleRecordError } from '../orderSampleRecordReader';
import { snapshotSampleOrigin, sampleOriginFingerprint } from '../sampleOriginService';
const roomActor = (userId = 'ROOM-ACTOR'): any => ({ userId, roles: ['viewer'], permissions: [], departmentIds: [], permissionCeiling: ['products:read','sample:room:write'] });

function makePrisma(seed: { items?: any[]; loans?: any[]; relations?: any[]; warehouses?: any[]; devCases?: any[]; orders?: any[]; productAssets?: any[]; samples?: any[]; batches?: any[]; sampleVersions?: any[]; users?: any[]; memberships?: any[]; grants?: any[] } = {}) {
  const state = {
    items: (seed.items ?? []).map(row => ({sampleId:null,devCaseId:null,orderId:null,batchId:null,productAssetId:null,warehouseId:null,receiptSnapshot:null,unit:'张',createdAt:BigInt(0),...row})),
    // Native schema defaults loanQuantity to one, including old seeded fixtures.
    loans: (seed.loans ?? []).map(loan => ({ loanQuantity: 1, ...loan })),
    relations: [...(seed.relations ?? [])],
    warehouses: (seed.warehouses ?? []).map(warehouse => ({ isActive: true, ...warehouse })),
    devCases: [...(seed.devCases ?? [])],
    orders: [...(seed.orders ?? [])],
    productAssets: [...(seed.productAssets ?? [])],
    samples: [...(seed.samples ?? [])],
    batches: [...(seed.batches ?? [])],
    sampleVersions: [...(seed.sampleVersions ?? [])],
    auditLogs: [] as any[],
    users: seed.users ?? ['ROOM-ACTOR','u1','u2','u3','operator','s4c-room-operator'].map(id=>({id,status:'active',deletedAt:null,primaryDeptId:null,
      roles:[{departmentId:null,role:{id:'role-admin',permissions:['products:read','sample:room:write'].map(scope=>({permission:{scope}}))}}]})),
    overrides: [] as any[], memberships: seed.memberships ?? [], grants: seed.grants ?? [],
  };
  const matchWhere = (row: any, where: any) => {
    if (!where) return true;
    for (const k of Object.keys(where)) {
      const v = where[k];
      if (k === 'OR') {
        if (!v.some((cond: any) => matchWhere(row, cond))) return false;
        continue;
      }
      if(k==='AND'){if(!v.every((cond:any)=>matchWhere(row,cond)))return false;continue;}
      if(k==='team'){if(!matchWhere(row.team,v))return false;continue;}
      if (v === null) {
        // IS NULL check
        if (row[k] != null) return false;
      } else if (typeof v === 'object') {
        // object form: { in, not, contains, startsWith, ... }
        if ('in' in v) {
          if (!v.in.includes(row[k])) return false;
        } else if ('not' in v) {
          if (row[k] === v.not) return false;
        } else if ('contains' in v) {
          if (!String(row[k] ?? '').includes(v.contains)) return false;
        } else if ('startsWith' in v) {
          if (!String(row[k] ?? '').startsWith(v.startsWith)) return false;
        } else if ('gt' in v) {
          if (!(row[k] > v.gt)) return false;
        }
      } else {
        // primitive equality (string/number/boolean)
        if (row[k] !== v) return false;
      }
    }
    return true;
  };
  const prisma: any = {
    orderSampleSource: {findUnique:vi.fn(async()=>null)},
    sampleCardItem: {
      count: async ({ where }: any) => state.items.filter((i: any) => matchWhere(i, where)).length,
      findFirst: async ({ where }: any) => state.items.find((i: any) => matchWhere(i, where)) ?? null,
      findUnique: async ({ where }: any) => state.items.find((i:any)=>matchWhere(i,where)) ?? null,
      findMany: async ({ where, select, take, skip, orderBy, cursor }: any) => {
        let rows = state.items.filter((i: any) => matchWhere(i, where));
        if(Array.isArray(orderBy))rows=[...rows].sort((a,b)=>{for(const part of orderBy){const [key,direction]=Object.entries(part)[0];const comparison=a[key]<b[key]?-1:a[key]>b[key]?1:0;if(comparison)return direction==='desc'?-comparison:comparison;}return 0;});
        if (orderBy?.createdAt === 'desc') rows = [...rows].sort((a: any, b: any) => Number(b.createdAt) - Number(a.createdAt));
        if (orderBy?.availableQty === 'asc') rows = [...rows].sort((a: any, b: any) => Number(a.availableQty) - Number(b.availableQty));
        const start=(cursor?rows.findIndex(row=>row.id===cursor.id):0)+(skip??0);
        rows = rows.slice(start, take===undefined?undefined:start+take);
        return rows.map((r: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r));
      },
      create: async ({ data }: any) => { state.items.push(data); return data; },
      update: async ({ where, data }: any) => {
        const it = state.items.find((x: any) => x.id === where.id);
        Object.assign(it, data);
        return it;
      },
    },
    sampleCardLoan: {
      findUnique: async ({ where }: any) => state.loans.find((l: any) => l.id === where.id) ?? null,
      findMany: async ({ where, orderBy, take, cursor, skip }: any) => {
        let rows = state.loans.filter((l: any) => matchWhere(l, where));
        if(Array.isArray(orderBy))rows=[...rows].sort((a,b)=>{for(const part of orderBy){const [key,direction]=Object.entries(part)[0];const comparison=a[key]<b[key]?-1:a[key]>b[key]?1:0;if(comparison)return direction==='desc'?-comparison:comparison;}return 0;});
        if (orderBy?.loanedAt === 'desc') rows = [...rows].sort((a: any, b: any) => b.loanedAt - a.loanedAt);
        if (orderBy?.loanedAt === 'asc') rows = [...rows].sort((a: any, b: any) => a.loanedAt - b.loanedAt);
        // Prisma has no implicit take=50; custody sums must include every loan.
        const start=(cursor?rows.findIndex(row=>row.id===cursor.id):0)+(skip??0);return rows.slice(start,take===undefined?undefined:start+take);
      },
      create: async ({ data }: any) => { state.loans.push(data); return data; },
      update: async ({ where, data }: any) => {
        const l = state.loans.find((x: any) => x.id === where.id);
        Object.assign(l, data);
        return l;
      },
    },
    relation: {
      findFirst: async ({ where }: any) => state.relations.find((r: any) => r.id === where.id && (where.deletedAt === null ? r.deletedAt == null : true)) ?? null,
      findUnique: async ({where}:any)=>state.relations.find(r=>matchWhere(r,where))??null,
      findMany: async ({where}:any={})=>state.relations.filter(r=>matchWhere(r,where)),
    },
    warehouse: {
      findUnique: async ({ where }: any) => state.warehouses.find((w: any) => w.id === where.id) ?? null,
      findMany: async ({ where, select }: any) => {
        const rows = state.warehouses.filter((w: any) => matchWhere(w, where));
        return rows.map((r: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r));
      },
    },
    developmentLifecycleEvent: { findFirst: async () => null },
    developmentCase: {
      findUnique: async ({ where }: any) => state.devCases.find((d: any) => d.id === where.id) ?? null,
      findMany: async ({ where, select }: any) => {
        const rows = state.devCases.filter((d: any) => matchWhere(d, where));
        return rows.map((r: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r));
      },
    },
    order: {
      findUnique: async ({ where }: any) => state.orders.find((o: any) => o.id === where.id) ?? null,
      findMany: async ({ where, select }: any) => {
        const rows = state.orders.filter((o: any) => matchWhere(o, where));
        return rows.map((r: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r));
      },
    },
    productAsset: {
      findUnique: async ({ where, select }: any) => {
        const r = state.productAssets.find((p: any) => p.id === where.id) ?? null;
        return r && select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r;
      },
      findMany: async ({ where, select }: any) => {
        const rows = state.productAssets.filter((p: any) => matchWhere(p, where));
        return rows.map((r: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r));
      },
    },
    sample: {
      findUnique:async({where}:any)=>state.samples.find(s=>matchWhere(s,where))??null,
      findFirst: async ({ where, select }: any) => {
        const r = state.samples.find((s: any) => s.id === where.id && (where.deletedAt === null ? s.deletedAt == null : true)) ?? null;
        return r && select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r;
      },
      findMany: async ({ where, select }: any) => {
        const rows = state.samples.filter((s: any) => matchWhere(s, where));
        return rows.map((r: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r));
      },
    },
    sampleBatch: { findUnique: async ({ where }: any) => state.batches.find(batch => batch.id === where.id) ?? null,
      findMany:async({where}:any={})=>state.batches.filter(batch=>matchWhere(batch,where)) },
    developmentSampleVersion: { findMany: async ({ where }: any = {}) => state.sampleVersions.filter(version => matchWhere(version,where)) },
    auditLog: { create: async ({ data }: any) => { state.auditLogs.push(data); return { id: data.id }; },
      findMany:async({where}:any={})=>state.auditLogs.filter(row=>matchWhere(row,where)) },
  };
  for(const [delegate,key] of Object.entries({userAccount:'users',userPermissionOverrides:'overrides',teamMember:'memberships',teamDataGrant:'grants'})) {
    prisma[delegate]={findFirst:vi.fn(async({where}:any={})=>structuredClone((state as any)[key].find((row:any)=>matchWhere(row,where))??null)),
      findUnique:vi.fn(async({where}:any={})=>structuredClone((state as any)[key].find((row:any)=>matchWhere(row,where))??null)),
      findMany:vi.fn(async({where}:any={})=>structuredClone((state as any)[key].filter((row:any)=>matchWhere(row,where))))};
  }
  // A strict synthetic lock seam, not evidence of PostgreSQL locking/concurrency.
  prisma.$queryRaw = vi.fn(async (query: any) => {
    const sql = query.sql ?? query.text;
    if (sql.startsWith("SELECT pg_advisory_xact_lock(hashtext(")) return [{pg_advisory_xact_lock:''}];
    const rows = sql.includes('FROM "SampleCardItem"') ? state.items
      : sql.includes('FROM "SampleCardLoan"') ? state.loans
      : sql.includes('FROM "DevelopmentCase"') ? state.devCases
      : sql.includes('FROM "Order"') ? state.orders
      : sql.includes('FROM "ProductAsset"') ? state.productAssets
      : sql.includes('FROM "Warehouse"') ? state.warehouses
      : sql.includes('FROM "Sample"') ? state.samples
      : sql.includes('FROM "SampleBatch"') ? state.batches : null;
    const lockRows=sql.includes('FROM "Relation"')?state.relations:rows;
    if (!lockRows || !sql.includes('FOR UPDATE')) throw new Error('Unexpected synthetic lock query');
    return lockRows.filter(row => row.id === query.values[0]).map(row => ({ id: row.id }));
  });
  // Models atomic rollback of delegates only; no native DB is started by this suite.
  prisma.$transaction = vi.fn(async (callback: (tx: any) => Promise<any>) => {
    const before = structuredClone(state);
    const tx={...prisma};delete tx.$transaction;
    try { return await callback(tx); }
    catch (error) {
      for (const key of Object.keys(state) as (keyof typeof state)[]) state[key].splice(0, state[key].length, ...before[key]);
      throw error;
    }
  });
  return { prisma, state };
}

beforeEach(() => { vi.clearAllMocks(); });

function custodyFixture() {
  return makePrisma({
    users:[{id:'ROOM-ACTOR',status:'active',deletedAt:null,primaryDeptId:null,roles:[{departmentId:null,role:{id:'custom-room-employee',permissions:['products:read','sample:room:write'].map(scope=>({permission:{scope}}))}}]}],
    relations:[{id:'OWN',ownerId:'ROOM-ACTOR',salesRepIds:[],departmentId:null,deletedAt:null,name:'Own customer'},
      {id:'FOREIGN',ownerId:'OTHER',salesRepIds:[],departmentId:null,deletedAt:null,name:'Foreign customer'}],
    orders:[{id:'OWN-ORDER',customerRelationId:'OWN',sourceCaseId:null,type:'Garment',businessLine:'garment',deletedAt:null}],
    items:[{id:'CUSTODY-CARD',code:'SC-CUSTODY',name:'Private physical',notes:'PRIVATE-NOTES',cardType:'fabric',status:'in_stock',quantity:3,availableQty:3,
      orderId:'OWN-ORDER',location:'A-1',unit:'PC',createdAt:BigInt(10),deletedAt:null}],
  });
}
describe('custody authority integration through real kernel and permission implementations', () => {
  it.each(['list','detail','loans','lowStock'])('anonymous old %s full reader refuses before sensitive reads', async method => {
    const {prisma}=custodyFixture(),svc=createSampleRoomService(prisma);
    const result=method==='list'?await svc.listItems({}):method==='detail'?await svc.getItem('CUSTODY-CARD'):
      method==='loans'?await svc.listLoans({}):await svc.listLowStock();
    expect(result).toMatchObject({ok:false,error:{code:'UNAUTHORIZED',status:401}});
  });
  it.each(['borrow','retire','ship'])('string actor cannot authorize existing Card %s write', async method => {
    const {prisma,state}=custodyFixture(),before=structuredClone(state),svc=createSampleRoomService(prisma);
    const r=method==='borrow'?await svc.createLoan('CUSTODY-CARD',{ requestKey: 'room-fixture-loan-01',borrowerName:'Staff'},'ROOM-ACTOR' as any):
      method==='retire'?await svc.retireItem('CUSTODY-CARD','Exit','ROOM-ACTOR' as any):await svc.shipItem('CUSTODY-CARD',{ requestKey: 'room-fixture-ship-02',recipientName:'Recipient'},'ROOM-ACTOR' as any);
    expect(r).toMatchObject({ok:false,error:{code:'UNAUTHORIZED',status:401}});expect(state).toEqual(before);
  });
  it('foreign Card parent hides old full detail and refuses a stock write with no audit', async () => {
    const {prisma,state}=custodyFixture();state.orders[0].customerRelationId='FOREIGN';const svc=createSampleRoomService(prisma),before=structuredClone(state);
    expect(await (svc.getItem as any)('CUSTODY-CARD',roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});
    expect(await svc.createLoan('CUSTODY-CARD',{ requestKey: 'room-fixture-loan-03',borrowerName:'Staff'},roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});expect(state).toEqual(before);
  });
  it('full list authorizes before count and pagination instead of dropping unauthorized first page entries', async () => {
    const {prisma,state}=custodyFixture();state.orders.push({...state.orders[0],id:'FOREIGN-ORDER',customerRelationId:'FOREIGN'});
    state.items.push(...Array.from({length:210},(_,i)=>({...state.items[0],id:`FOREIGN-${i}`,orderId:'FOREIGN-ORDER',createdAt:BigInt(100+i)})));
    const r:any=await (createSampleRoomService(prisma).listItems as any)({limit:1},roomActor());
    expect(r).toMatchObject({ok:true,data:{total:1,items:[{id:'CUSTODY-CARD'}]}});
  });
  it('catalog-only orphan cannot be read by old full detail; explicit directory is seven fields and no private metadata', async () => {
    const {prisma,state}=custodyFixture();Object.assign(state.items[0],{orderId:null,receiptSnapshot:null});const svc:any=createSampleRoomService(prisma);
    expect(await svc.getItem('CUSTODY-CARD',roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});
    expect(typeof svc.listCustodyDirectory).toBe('function');const r=await svc.listCustodyDirectory({lane:'fabric',limit:1,offset:0,search:'',cardType:''},roomActor());
    expect(r).toMatchObject({ok:true,data:{directoryVersion:4,total:1,items:[{visibility:'catalog',businessContext:{status:'unresolved',businessLine:null,reasons:['OWNERSHIP_NOT_RECORDED']}}]}});
    expect(Object.keys(r.data.items[0].card).sort()).toEqual(['id','code','cardType','location','quantity','availableQty','unit'].sort());
    expect(JSON.stringify(r)).not.toContain('Private physical');expect(JSON.stringify(r)).not.toContain('PRIVATE-NOTES');
  });
  it('native/malformed orphan provenance cannot downgrade into safe directory', async () => {
    const {prisma,state}=custodyFixture();Object.assign(state.items[0],{orderId:null,receiptSnapshot:{version:1,batchId:'HISTORICAL'}});
    const svc:any=createSampleRoomService(prisma);expect(typeof svc.listCustodyDirectory).toBe('function');
    expect(await svc.listCustodyDirectory({lane:'fabric'},roomActor())).toMatchObject({ok:true,data:{total:0,items:[]}});
  });
  it('current read grant revoked after RR read refuses whole old list, not an empty or stale success', async () => {
    const {prisma,state}=custodyFixture();const original=prisma.$transaction.getMockImplementation();
    prisma.$transaction.mockImplementationOnce(async(callback:any)=>{const result=await original(callback);state.users[0].roles[0].role.permissions=[];return result;});
    expect(await (createSampleRoomService(prisma).listItems as any)({},roomActor())).toMatchObject({ok:false,error:{code:'FORBIDDEN',status:403}});
  });
  it('stored team read plus Room capability still cannot borrow; followup share can borrow with original stock math', async () => {
    const {prisma,state}=custodyFixture();state.relations[0].ownerId='OTHER';state.memberships.push({userId:'ROOM-ACTOR',teamId:'TEAM',leftAt:null,team:{deletedAt:null}});
    state.grants.push({teamId:'TEAM',entityType:'relation',entityId:'OWN',permission:'read',revokedAt:null,team:{deletedAt:null}});
    const svc=createSampleRoomService(prisma);expect(await svc.createLoan('CUSTODY-CARD',{ requestKey: 'room-fixture-loan-04',borrowerName:'Staff'},roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});
    state.grants[0].permission='read+followup';expect(await svc.createLoan('CUSTODY-CARD',{ requestKey: 'room-fixture-loan-05',borrowerName:'Staff'},roomActor())).toMatchObject({ok:true,data:{item:{quantity:3,availableQty:2}}});
  });
  it('incoming viewing customer is authorized before locks and cannot expose/link a foreign target', async () => {
    const {prisma,state}=custodyFixture(),before=structuredClone(state);
    expect(await createSampleRoomService(prisma).createLoan('CUSTODY-CARD',{ requestKey: 'room-fixture-loan-06',loanType:'viewing',borrowerName:'Visitor',relationId:'FOREIGN'},roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});expect(state).toEqual(before);
  });
  it('manual standalone creation assigns actor custodian; genuine foreign source cannot be used to create a new Card', async () => {
    const {prisma,state}=custodyFixture(),before=structuredClone(state),svc=createSampleRoomService(prisma);
    expect(await svc.createItem({name:'No owner'},roomActor())).toMatchObject({ok:true,data:{item:{custodianUserId:'ROOM-ACTOR'}}});
    const afterManual=structuredClone(state);
    state.orders[0].customerRelationId='FOREIGN';
    expect(await svc.createItem({name:'Foreign owner',orderId:'OWN-ORDER'},roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});
    expect(state.items).toEqual(afterManual.items);expect(state.auditLogs).toEqual(afterManual.auditLogs);
  });
  it('incoming own customer joins the frozen canonical graph before Card lock, then revoked target ownership refuses zero business writes', async () => {
    const {prisma,state}=custodyFixture();state.relations.push({id:'TARGET',ownerId:'ROOM-ACTOR',salesRepIds:[],departmentId:null,deletedAt:null,name:'Target'});
    state.devCases.push({id:'CASE',type:'garment',customerRelationId:'OWN',supplierRelationId:'FOREIGN',deletedAt:null});state.orders[0].sourceCaseId='CASE';
    const native=prisma.$queryRaw.getMockImplementation();prisma.$queryRaw.mockImplementation(async(q:any)=>{const result=await native(q);if(q.sql.includes('FROM "Relation"')&&q.values[0]==='TARGET')state.relations.find(r=>r.id==='TARGET')!.ownerId='OTHER';return result;});
    expect(await createSampleRoomService(prisma).createLoan('CUSTODY-CARD',{ requestKey: 'room-fixture-loan-07',loanType:'viewing',borrowerName:'Visitor',relationId:'TARGET'},roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});
    expect(state.loans).toEqual([]);expect(state.auditLogs).toEqual([]);expect(state.items[0].availableQty).toBe(3);
    const locks=prisma.$queryRaw.mock.calls.map(([q]:any)=>[q.sql.match(/FROM "([^"]+)"/)[1],q.values[0]]);
    expect(locks[0]).toEqual(['DevelopmentCase','CASE']);expect(locks.filter((row:any[])=>row[0]==='Relation').map((row:any[])=>row[1])).toEqual(['FOREIGN','OWN','TARGET']);expect(locks.at(-1)).toEqual(['SampleCardItem','CUSTODY-CARD']);
  });
  it('an already-borrowed Card can return after its source advances round/approval/closure without inventing new source evidence', async () => {
    const {prisma,state}=custodyFixture();state.devCases.push({id:'CASE',type:'garment',status:'active',customerRelationId:'OWN',supplierRelationId:'FOREIGN',deletedAt:null});
    state.orders[0].sourceCaseId='CASE';state.batches.push({id:'BATCH',developmentCaseId:'CASE',supplierRelationId:'FOREIGN',round:1,sampleType:'garment-round',updatedAt:BigInt(1),deletedAt:null});
    Object.assign(state.items[0],{devCaseId:'CASE',batchId:'BATCH'});const svc=createSampleRoomService(prisma),borrowed:any=await svc.createLoan('CUSTODY-CARD',{ requestKey: 'room-fixture-loan-08',borrowerName:'Staff'},roomActor());expect(borrowed.ok).toBe(true);
    Object.assign(state.batches[0],{round:2,updatedAt:BigInt(100),status:'approved'});Object.assign(state.devCases[0],{status:'closed',paused:true});
    expect(await svc.returnLoan(borrowed.data.loan.id,undefined,roomActor())).toMatchObject({ok:true,data:{item:{quantity:3,availableQty:3,status:'in_stock'}}});expect(state.auditLogs).toHaveLength(2);
  });
  it('directory search finds authorized names and locations without using hidden catalog names', async () => {
    const {prisma,state}=custodyFixture(),svc=createSampleRoomService(prisma);
    state.items[0].location='Shelf-A12';
    state.items.push({...state.items[0],id:'CATALOG-SEARCH',code:'SC-ORPHAN',name:'secret-catalog-name',location:'Shelf-B15',orderId:null,sampleId:null,devCaseId:null,batchId:null,receiptSnapshot:null});
    expect(await svc.listCustodyDirectory({lane:'fabric',search:'Private physical'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{visibility:'full',card:{id:'CUSTODY-CARD'}}]}});
    expect(await svc.listCustodyDirectory({lane:'fabric',search:'Shelf-A12'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{visibility:'full',card:{id:'CUSTODY-CARD'}}]}});
    expect(await svc.listCustodyDirectory({lane:'fabric',search:'secret-catalog-name'},roomActor())).toMatchObject({ok:true,data:{total:0,items:[]}});
    expect(await svc.listCustodyDirectory({lane:'fabric',search:'Shelf-B15'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{visibility:'catalog',card:{id:'CATALOG-SEARCH'}}]}});
  });
  it('four physical lanes include catalog identities safely and keep color cards in fabric', async () => {
    const {prisma,state}=custodyFixture(),svc:any=createSampleRoomService(prisma);
    // The baseline fabric card belongs to a garment order. Material classification must not rewrite that owner.
    expect(await svc.listCustodyDirectory({lane:'fabric',limit:0},roomActor())).toMatchObject({ok:true,data:{total:1,items:[],pagination:{limit:0,offset:0}}});
    expect(await svc.listCustodyDirectory({lane:'garment'},roomActor())).toMatchObject({ok:true,data:{total:0,items:[]}});
    expect(await svc.listCustodyDirectory({lane:'fabric',search:'Private'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{visibility:'full',card:{id:'CUSTODY-CARD'}}]}});
    expect(await svc.listCustodyDirectory({lane:'fabric',search:'SC-CUSTODY'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{visibility:'full',card:{id:'CUSTODY-CARD'},businessContext:{status:'resolved',businessLine:'garment'}}]}});
    const orphan=(id:string,code:string,type:string)=>({...state.items[0],id,code,cardType:type,orderId:null,sampleId:null,devCaseId:null,batchId:null,receiptSnapshot:null,
      photos:[{id:'private-photo'}],locationDetail:{zone:'private'}});
    state.items.push(orphan('ORPHAN-FABRIC','SC-ORPHAN-FABRIC','fabric'));
    state.items.push(orphan('GARMENT-CARD','SC-GARMENT','garment'));
    state.items.push(orphan('COLORCARD-CARD','SC-COLORCARD','colorcard'));
    state.items.push({...state.items[0],id:'FULL-COLORCARD-CARD',code:'SC-FULL-COLORCARD',cardType:'colorcard',createdAt:BigInt(14)});
    state.items.push(orphan('TRIM-CARD','SC-TRIM','trim'));
    state.items.push(orphan('OTHER-CARD','SC-OTHER','other'));
    const fabric:any=await svc.listCustodyDirectory({lane:'fabric'},roomActor());
    expect(fabric.data.total).toBe(4);
    expect(fabric.data.items.map((row:any)=>[row.visibility,row.card.id,row.card.cardType])).toEqual(expect.arrayContaining([
      ['full','CUSTODY-CARD','fabric'],['full','FULL-COLORCARD-CARD','colorcard'],['catalog','ORPHAN-FABRIC','fabric'],['catalog','COLORCARD-CARD','colorcard'],
    ]));
    expect(await svc.listCustodyDirectory({lane:'garment'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{visibility:'catalog',card:{id:'GARMENT-CARD',cardType:'garment'}}]}});
    expect(await svc.listCustodyDirectory({lane:'trim'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{visibility:'catalog',card:{id:'TRIM-CARD',cardType:'trim'}}]}});
    expect(await svc.listCustodyDirectory({lane:'other'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{visibility:'catalog',card:{id:'OTHER-CARD',cardType:'other'}}]}});
    for(const lane of ['fabric','garment','trim','other']) {
      const result:any=await svc.listCustodyDirectory({lane},roomActor());
      for(const row of result.data.items.filter((entry:any)=>entry.visibility==='catalog')) {
        expect(Object.keys(row.card).sort()).toEqual(['id','code','cardType','location','quantity','availableQty','unit'].sort());
        expect(row.card).not.toHaveProperty('photos');expect(row.card).not.toHaveProperty('locationDetail');
        expect(await svc.getItem(row.card.id,roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});
      }
    }
    expect(await svc.listCustodyDirectory({lane:'review'},roomActor())).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  });
  it('fabric directory groups product samples together and unproductized samples by exact development version without creating stock copies', async () => {
    const {prisma,state}=custodyFixture();
    state.devCases.push({id:'FAB-CASE',code:'DEV-FAB-1',name:'棉斜纹开发',type:'fabric',customerRelationId:'OWN',supplierRelationId:null,deletedAt:null});
    state.productAssets.push({id:'FABRIC-PRODUCT',sku:'FAB-001',name:'斜纹布',mainCategory:'Fabric',deletedAt:null});
    Object.assign(state.items[0],{productAssetId:'FABRIC-PRODUCT',cardType:'colorcard',unit:'份',quantity:3,availableQty:2,
      libraryMetadata:{version:1,purpose:'development',sampleKind:'dev_lab_dip',sourceType:'internal'}});
    state.items.push({...state.items[0],id:'FABRIC-COLOR-2',code:'SC-FAB-C2',quantity:2,availableQty:2,createdAt:BigInt(11)});
    state.items.push({...state.items[0],id:'FABRIC-YARDAGE',code:'SC-FAB-Y1',cardType:'fabric',unit:'米',quantity:1,availableQty:1,physicalLengthQty:'8.5000',availableLengthQty:'6.2500',createdAt:BigInt(12),
      libraryMetadata:{version:1,purpose:'development',sampleKind:'dev_yardage',sourceType:'internal'}});
    const batchBase={developmentCaseId:'FAB-CASE',supplierRelationId:null,deletedAt:null};
    state.batches.push(
      {...batchBase,id:'VER-BATCH-COLOR',batchCode:'B-C',sampleType:'lab-dip',round:2,sampleVersionId:'FAB-VER-R2-A1',versionLabel:'R2-A.1',createdAt:BigInt(13)},
      {...batchBase,id:'VER-BATCH-HANDLOOM',batchCode:'B-H',sampleType:'handloom',round:2,sampleVersionId:'FAB-VER-R2-A1',versionLabel:'R2-A.1',createdAt:BigInt(14)},
    );
    state.sampleVersions.push({id:'FAB-VER-R2-A1',versionLabel:'R2-A.1',developmentCaseId:'FAB-CASE',deletedAt:null});
    state.items.push(
      {...state.items[0],id:'DEV-VERSION-COLOR',code:'SC-DEV-C',productAssetId:null,orderId:null,devCaseId:'FAB-CASE',batchId:'VER-BATCH-COLOR',cardType:'colorcard',unit:'份',quantity:2,availableQty:1,createdAt:BigInt(15)},
      {...state.items[0],id:'DEV-VERSION-HANDLOOM',code:'SC-DEV-H',productAssetId:null,orderId:null,devCaseId:'FAB-CASE',batchId:'VER-BATCH-HANDLOOM',cardType:'fabric',unit:'份',quantity:1,availableQty:1,createdAt:BigInt(16),
        libraryMetadata:{version:1,purpose:'development',sampleKind:'dev_handloom',sourceType:'internal'}},
    );
    const before=structuredClone(state.items),result:any=await createSampleRoomService(prisma).listCustodyDirectory({lane:'fabric'},roomActor());
    expect(result).toMatchObject({ok:true,data:{directoryVersion:4,total:2}});
    const product=result.data.items.find((row:any)=>row.archive?.productAssetId==='FABRIC-PRODUCT');
    expect(product.archive).toMatchObject({name:'斜纹布',code:'FAB-001',members:expect.arrayContaining([
      expect.objectContaining({id:'CUSTODY-CARD'}),expect.objectContaining({id:'FABRIC-COLOR-2'}),expect.objectContaining({id:'FABRIC-YARDAGE',total:'8.5',available:'6.25'}),
    ])});
    expect(product.archive.forms).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'色样',unit:'份',total:'5',available:'4'}),expect.objectContaining({kind:'米样',unit:'米',total:'8.5',available:'6.25'}),
    ]));
    const development=result.data.items.find((row:any)=>row.archive?.developmentSampleVersionId==='FAB-VER-R2-A1');
    expect(development.archive).toMatchObject({identityKind:'development-version',name:'棉斜纹开发',code:'R2-A.1',members:expect.arrayContaining([
      expect.objectContaining({id:'DEV-VERSION-COLOR'}),expect.objectContaining({id:'DEV-VERSION-HANDLOOM'}),
    ])});
    expect(development.archive.forms).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'色样',unit:'份',total:'2',available:'1'}),expect.objectContaining({kind:'手织样',unit:'份',total:'1',available:'1'}),
    ]));
    expect(state.items).toEqual(before); // Projection groups existing card rows only; it does not add or merge stock.
  });
  it('private photo metadata appears only on full custody detail and directory projections', async () => {
    const {prisma,state}=custodyFixture(),svc:any=createSampleRoomService(prisma);
    const photo={id:'11111111-1111-4111-8111-111111111111',storageKey:'sample-photos/11111111-1111-4111-8111-111111111111.png',mimeType:'image/png',size:24,sha256:'a'.repeat(64),signature:'b'.repeat(64),uploadedAt:'2026-10-06T00:00:00.000Z',uploadedBy:'ROOM-ACTOR'};
    const append=await svc.appendItemPhotos('CUSTODY-CARD',[photo],roomActor());expect(append.ok).toBe(true);
    const detail=await svc.getItem('CUSTODY-CARD',roomActor());
    expect(detail).toMatchObject({ok:true,data:{item:{photos:[{id:photo.id,mimeType:'image/png',size:24,uploadedAt:photo.uploadedAt,signature:photo.signature,url:`/api/v1/samples/room/items/CUSTODY-CARD/photos/${photo.id}?sig=${photo.signature}`}]}}});
    const directory=await svc.listCustodyDirectory({lane:'fabric'},roomActor());
    expect(directory).toMatchObject({ok:true,data:{directoryVersion:4,items:[{visibility:'full',card:{photos:[{id:photo.id}]},archive:{members:[{id:'CUSTODY-CARD'}]}}]}});
    expect(Object.keys((directory as any).data.items[0].card.photos[0]).sort()).toEqual(['id','mimeType','size','uploadedAt','signature','url'].sort());
    state.items[0].orderId=null;
    const catalog=await svc.listCustodyDirectory({lane:'fabric'},roomActor());
    expect((catalog as any).data.items[0].visibility).toBe('catalog');
    expect((catalog as any).data.items[0].card).not.toHaveProperty('photos');
    expect(await svc.getItemPhoto('CUSTODY-CARD',photo.id,roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND',status:404}});
  });
  it('private photo upload is atomic, signed, stored outside public uploads, and reauthorizes every read', async () => {
    const {prisma,state}=custodyFixture(),privateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'bambook-private-sample-test-'));
    try {
      const secret=process.env.JWT_SECRET;
      expect(secret&&secret.length>=32).toBe(true);
      const tokenFor=(userId:string)=>jwt.sign({userId,roles:['viewer'],permissions:['products:read','sample:room:write'],departmentIds:[]},secret!);
      const app=express();app.use(express.json());app.use('/api/v1/samples',createSampleRouter({prisma,requireAuth:true,apiKeys:new Set(),privateFilesDir:privateRoot}));
      const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
      const uploaded=await request(app).post('/api/v1/samples/room/items/CUSTODY-CARD/photos').set('Authorization',`Bearer ${tokenFor('ROOM-ACTOR')}`)
        .attach('photos',png,{filename:'swatch.png',contentType:'image/png'});
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.item.photos).toHaveLength(1);
      const photo=uploaded.body.item.photos[0];
      expect(Object.keys(photo).sort()).toEqual(['id','mimeType','size','uploadedAt','signature','url'].sort());
      expect(photo).toMatchObject({mimeType:'image/png',size:png.length,url:`/api/v1/samples/room/items/CUSTODY-CARD/photos/${photo.id}?sig=${photo.signature}`});
      const stored=path.join(privateRoot,'sample-photos',`${photo.id}.png`);
      expect(fs.readFileSync(stored).equals(png)).toBe(true);
      expect(state.auditLogs.some(row=>row.action==='sample_card_photo_upload')).toBe(true);
      const read=await request(app).get(photo.url).set('Authorization',`Bearer ${tokenFor('ROOM-ACTOR')}`);
      expect(read.status).toBe(200);expect(read.body.equals(png)).toBe(true);
      state.users.push({id:'u2',status:'active',deletedAt:null,primaryDeptId:null,roles:[{departmentId:null,role:{id:'catalog-viewer',permissions:['products:read'].map(scope=>({permission:{scope}}))}}]});
      const denied=await request(app).get(photo.url).set('Authorization',`Bearer ${tokenFor('u2')}`);
      expect(denied.status).toBe(404);
    } finally {fs.rmSync(privateRoot,{recursive:true,force:true});}
  });
  it('catalog-only directory never queries audit or borrowing details; parent SQL failure remains an error, not empty success', async () => {
    const {prisma,state}=custodyFixture();state.items[0].orderId=null;const audit=vi.spyOn(prisma.auditLog,'findMany'),loans=vi.spyOn(prisma.sampleCardLoan,'findMany');
    expect(await (createSampleRoomService(prisma) as any).listCustodyDirectory({lane:'fabric'},roomActor())).toMatchObject({ok:true,data:{total:1}});expect(audit).not.toHaveBeenCalled();expect(loans).not.toHaveBeenCalled();
    state.items[0].orderId='OWN-ORDER';vi.spyOn(prisma.order,'findMany').mockRejectedValueOnce(Error('synthetic parent SQL failed'));
    expect(await (createSampleRoomService(prisma) as any).listItems({},roomActor())).toMatchObject({ok:false,error:{code:'INTERNAL_ERROR',status:500}});
  });
  it.each(['legacy', 'separate_clocks'])('directory/list/detail agree: only unique original create audit verifies V2 %s; schema alone, duplicate and altered audit stay unverified', async mode => {
    const {prisma,state}=custodyFixture();const batch:any={id:'BATCH',batchCode:'B-1',developmentCaseId:'CASE',supplierRelationId:'FOREIGN',round:1,sampleType:'garment-round',updatedAt:BigInt(11),
      versionLabel:'R1-A-1',parentBatchId:'PARENT',minorVersion:1,minorChangeNote:'袖窿微调',deletedAt:null};
    const development:any={id:'CASE',code:'D-1',type:'garment',customerRelationId:'OWN',supplierRelationId:'FOREIGN',deletedAt:null};state.batches.push(batch);state.devCases.push(development);state.orders[0].sourceCaseId='CASE';
    const source=snapshotSampleOrigin(batch,development),receipt:any={version:2,nativeFamily:'garment-round',batchId:'BATCH',batchCode:'B-1',developmentCaseId:'CASE',factoryId:'FOREIGN',sourceRound:1,sampleType:'garment-round',
      sourceSnapshot:source,sourceFingerprint:sampleOriginFingerprint(source),cardType:'fabric',actualQuantity:'0.75',actualUnit:'M',colorRating:null,batchUpdatedAt:'11',initialPhysicalCardCount:3,physicalUnit:'PC',receivedAt:mode==='legacy'?'10':'1791418680000',...(mode==='legacy'?{}:{recordedAt:'10'}),receivedBy:'ROOM-ACTOR'};
    expect(source.batch).toMatchObject({versionLabel:'R1-A-1',parentBatchId:'PARENT',minorVersion:1,minorChangeNote:'袖窿微调'});
    Object.assign(state.items[0],{batchId:'BATCH',devCaseId:'CASE',receiptSnapshot:receipt,quantity:2,availableQty:1});
    const svc:any=createSampleRoomService(prisma),read=()=>svc.listCustodyDirectory({lane:'fabric'},roomActor());
    const statuses=async()=>[(await read()).data.items[0].receiptStatus,(await svc.listItems({},roomActor())).data.items[0].receiptStatus,(await svc.getItem('CUSTODY-CARD',roomActor())).data.item.receiptStatus];
    expect(await statuses()).toEqual(['legacyUnverified','legacyUnverified','legacyUnverified']);
    const original:any={id:'CREATE-AUDIT',actorId:'ROOM-ACTOR',action:'sample_card_create',targetType:'SampleCardItem',targetId:'CUSTODY-CARD',operationType:'create',detail:{source:'sample-room:batch-received',after:{code:'SC-CUSTODY',name:'Original name',cardType:'fabric',unit:'PC',devCaseId:'CASE',batchId:'BATCH',quantity:3,availableQty:3,receiptSnapshot:receipt}}};
    state.auditLogs.push(original);state.batches[0].round=2;expect(await statuses()).toEqual(['verified','verified','verified']);
    if(mode==='separate_clocks'){
      receipt.recordedAt='9';expect(await statuses()).toEqual(['legacyUnverified','legacyUnverified','legacyUnverified']);receipt.recordedAt='10';
    }
    state.auditLogs.push({...original,id:'DUPLICATE'});expect(await statuses()).toEqual(['legacyUnverified','legacyUnverified','legacyUnverified']);state.auditLogs.pop();
    state.auditLogs[0].actorId='OTHER';expect(await statuses()).toEqual(['legacyUnverified','legacyUnverified','legacyUnverified']);
    state.auditLogs[0].actorId='ROOM-ACTOR';delete state.auditLogs[0].detail.after.receiptSnapshot;expect(await statuses()).toEqual(['legacyUnverified','legacyUnverified','legacyUnverified']);
  });
});

describe('S4C strict physical loan quantity boundary', () => {
  const invalidQuantities: unknown[] = [null, true, false, '2', '', [2], [], { value: 2 }, NaN, Infinity, -Infinity, 2.5, 0, -1, Number.MAX_SAFE_INTEGER + 1];
  for (const loanType of ['borrow', 'viewing']) {
    it.each(invalidQuantities)(`${loanType}: explicit invalid quantity %j writes no loan, item or audit`, async quantity => {
      const { prisma, state } = makePrisma({
        items: [{ id: 'S4C-CARD', code: 'SC-S4C', name: 'Unapproved physical reference', cardType: 'fabric', status: 'in_stock', quantity: 5, availableQty: 5, deletedAt: null }],
        relations: [{ id: 'S4C-CUSTOMER', name: 'Quantity fixture customer', deletedAt: null }],
      });
      const before = structuredClone(state);
      const loanWrite = vi.spyOn(prisma.sampleCardLoan, 'create');
      const itemWrite = vi.spyOn(prisma.sampleCardItem, 'update');
      const auditWrite = vi.spyOn(prisma.auditLog, 'create');
      const result = await createSampleRoomService(prisma).createLoan('S4C-CARD', { requestKey: 'room-fixture-loan-09',
        loanType, borrowerName: 'Quantity fixture operator', relationId: 'S4C-CUSTOMER', loanQuantity: quantity as any,
      }, roomActor('s4c-room-operator'));
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
      expect(state).toEqual(before);
      expect(loanWrite).not.toHaveBeenCalled();
      expect(itemWrite).not.toHaveBeenCalled();
      expect(auditWrite).not.toHaveBeenCalled();
    });
  }

  it.each([undefined, 3])('positive borrow quantity %s and the original return preserve the same physical card', async quantity => {
    const { prisma, state } = makePrisma({ items: [{ id: 'S4C-CARD', code: 'SC-S4C', name: 'Independent custody', cardType: 'fabric', sampleId: null,
      status: 'in_stock', quantity: 5, availableQty: 5, unit: 'PC', receiptSnapshot: { fixture: 'immutable receipt' }, deletedAt: null }] });
    const service = createSampleRoomService(prisma);
    const expectedQuantity = quantity === undefined ? 1 : quantity;
    const result = await service.createLoan('S4C-CARD', { requestKey: 'room-fixture-loan-10', borrowerName: 'Quantity fixture operator', ...(quantity === undefined ? {} : { loanQuantity: quantity }) }, roomActor('s4c-room-operator'));
    expect(result.ok).toBe(true);
    const loan = (result as any).data.loan;
    expect(loan).toMatchObject({ itemId: 'S4C-CARD', loanQuantity: expectedQuantity });
    expect(state.items[0]).toMatchObject({ id: 'S4C-CARD', quantity: 5, availableQty: 5 - expectedQuantity, sampleId: null, unit: 'PC', receiptSnapshot: { fixture: 'immutable receipt' } });
    expect((await service.returnLoan(loan.id, 'Intact', roomActor('s4c-room-operator'))).ok).toBe(true);
    expect(state.items[0]).toMatchObject({ id: 'S4C-CARD', quantity: 5, availableQty: 5, status: 'in_stock', sampleId: null, unit: 'PC', receiptSnapshot: { fixture: 'immutable receipt' } });
    expect(state.items).toHaveLength(1);
    expect(state.loans).toHaveLength(1);
    const afterReturn = structuredClone(state);
    expect(await service.returnLoan(loan.id, 'Duplicate', roomActor('s4c-room-operator'))).toMatchObject({ ok: false, error: { status: 409 } });
    expect(state).toEqual(afterReturn);
  });

  it.each([undefined, 3])('positive viewing quantity %s is recorded immediately returned without stock changes', async quantity => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'S4C-CARD', code: 'SC-S4C', name: 'Independent custody', status: 'in_stock', quantity: 5, availableQty: 5, deletedAt: null }],
      relations: [{ id: 'S4C-CUSTOMER', name: 'Quantity fixture customer', deletedAt: null }],
    });
    const beforeItem = structuredClone(state.items);
    const result = await createSampleRoomService(prisma).createLoan('S4C-CARD', { requestKey: 'room-fixture-loan-11', loanType: 'viewing', borrowerName: 'Quantity fixture visitor',
      relationId: 'S4C-CUSTOMER', ...(quantity === undefined ? {} : { loanQuantity: quantity }) }, roomActor('s4c-room-operator'));
    expect(result.ok).toBe(true);
    expect(state.loans[0]).toMatchObject({ itemId: 'S4C-CARD', loanQuantity: quantity === undefined ? 1 : quantity, relationId: 'S4C-CUSTOMER' });
    expect(state.loans[0].returnedAt).toBeGreaterThan(0);
    expect(state.items).toEqual(beforeItem);
    expect(state.auditLogs).toHaveLength(1);
  });
});

describe('S2B 实物来源登记与原子封样', () => {
  it('普通登记拒绝非空 batchId，不能绕过受控收样建立伪批次实物', async () => {
    const { prisma, state } = makePrisma();
    const before = structuredClone(state);
    const result = await createSampleRoomService(prisma).createItem({ name: '未经收样路径', batchId: 'SB-FORGED', quantity: 2 }, roomActor());
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect((result as any).error.message).toContain('收样');
    expect(state).toEqual(before);
  });
  it('成衣样品的面料参考卡继承真实 case/order，目录材料资产不会变成样品商品来源', async () => {
    const { prisma, state } = makePrisma({
      devCases: [{ id: 'DC-G', type: 'garment', deletedAt: null }],
      orders: [{ id: 'OD-G', sourceCaseId: 'DC-G', businessLine: 'garment', deletedAt: null }],
      productAssets: [{ id: 'PA-G', mainCategory: 'Garment', deletedAt: null }, { id: 'PA-F', mainCategory: 'Fabric', deletedAt: null }],
      samples: [{ id: 'SMP-G', code: 'SMP-G', type: 'pp', status: 'approved', sourceCaseId: 'DC-G', sourceOrderId: 'OD-G', productAssetId: 'PA-G', deletedAt: null }],
    });
    const sampleBefore = structuredClone(state.samples);
    expect(await createSampleRoomService(prisma).createItem({ name: '成衣业务面料参考', cardType: 'fabric', sampleId: 'SMP-G', productAssetId: 'PA-F', quantity: 2 }, roomActor())).toMatchObject({ ok: true, data: { item: { cardType: 'fabric', devCaseId: 'DC-G', orderId: 'OD-G', productAssetId: 'PA-F', sampleId: 'SMP-G' } } });
    expect(state.samples).toEqual(sampleBefore);
    expect(state.auditLogs[0].detail.after.physicalSource).toMatchObject({ sampleId: 'SMP-G', devCaseId: 'DC-G', orderId: 'OD-G', descriptorProductAssetId: 'PA-F', sampleProductAssetId: 'PA-G' });
  });
  it.each([
    { source: { sampleId: 'S-A', devCaseId: 'D-B' }, reason: '样品开发案矛盾' },
    { source: { sampleId: 'S-A', orderId: 'O-B' }, reason: '样品订单矛盾' },
    { source: { devCaseId: 'D-B', orderId: 'O-A' }, reason: '订单真实来源案矛盾' },
  ])('$reason 即使同业务线也拒绝且零写入', async ({ source }) => {
    const { prisma, state } = makePrisma({
      devCases: [{ id: 'D-A', type: 'fabric', deletedAt: null }, { id: 'D-B', type: 'fabric', deletedAt: null }],
      orders: [{ id: 'O-A', sourceCaseId: 'D-A', deletedAt: null }, { id: 'O-B', sourceCaseId: 'D-A', deletedAt: null }],
      samples: [{ id: 'S-A', sourceCaseId: 'D-A', sourceOrderId: 'O-A', deletedAt: null }],
    });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).createItem({ name: '冲突的实物来源', ...source }, roomActor())).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(state).toEqual(before);
  });
  it.each(['sample', 'case', 'order', 'descriptor', 'sample-product', 'warehouse-deleted', 'warehouse-inactive'])('新关联 %s 已删除/停用时拒绝且零写入', async sourceKind => {
    const { prisma, state } = makePrisma({
      devCases: [{ id: 'D', type: 'garment', deletedAt: sourceKind === 'case' ? 123 : null }],
      orders: [{ id: 'O', sourceCaseId: 'D', deletedAt: sourceKind === 'order' ? 123 : null }],
      productAssets: [{ id: 'MATERIAL', mainCategory: 'Fabric', deletedAt: sourceKind === 'descriptor' ? 123 : null }, { id: 'SUBJECT', mainCategory: 'Garment', deletedAt: sourceKind === 'sample-product' ? 123 : null }],
      samples: [{ id: 'S', sourceCaseId: 'D', sourceOrderId: 'O', productAssetId: 'SUBJECT', deletedAt: sourceKind === 'sample' ? 123 : null }],
      warehouses: [{ id: 'W', isActive: sourceKind !== 'warehouse-inactive', deletedAt: sourceKind === 'warehouse-deleted' ? 123 : null }],
    });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).createItem({ name: '实物来源', sampleId: 'S', productAssetId: 'MATERIAL', warehouseId: 'W' }, roomActor())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(state).toEqual(before);
  });
  it('第二个同案订单不必等于开发案最近快照；订单真实来源案可向实物继承', async () => {
    const { prisma, state } = makePrisma({
      devCases: [{ id: 'D', type: 'garment', linkedOrderId: 'O-FIRST', productAssetId: 'PA-FIRST', deletedAt: null }],
      orders: [{ id: 'O-SECOND', sourceCaseId: 'D', deletedAt: null }],
    });
    expect(await createSampleRoomService(prisma).createItem({ name: '同案第二订单实物', orderId: 'O-SECOND', cardType: 'fabric' }, roomActor())).toMatchObject({ ok: true, data: { item: { devCaseId: 'D', orderId: 'O-SECOND', productAssetId: null, cardType: 'fabric' } } });
    expect(state.devCases[0]).toMatchObject({ linkedOrderId: 'O-FIRST', productAssetId: 'PA-FIRST' });
  });
  it('无来源的未知草稿可登记实物，弱色卡与材料类型不会生成业务批准', async () => {
    const { prisma, state } = makePrisma({ samples: [{ id: 'S-DRAFT', type: 'dev', status: 'draft', sourceCaseId: null, sourceOrderId: null, productAssetId: null, deletedAt: null }] });
    const original = structuredClone(state.samples);
    expect(await createSampleRoomService(prisma).createItem({ name: '手工参考', sampleId: 'S-DRAFT', cardType: 'other', colorCardCode: 'unknown-weak-color' }, roomActor())).toMatchObject({ ok: true, data: { item: { sampleId: 'S-DRAFT', devCaseId: null, orderId: null, cardType: 'other', colorCardCode: 'unknown-weak-color' } } });
    expect(state.samples).toEqual(original);
  });
  it('锁定样品期间来源订单变化必须拒绝，不写入旧来源或追认新来源', async () => {
    const { prisma, state } = makePrisma({
      devCases: [{ id: 'D', deletedAt: null }], orders: [{ id: 'O-OLD', sourceCaseId: 'D', deletedAt: null }, { id: 'O-NEW', sourceCaseId: 'D', deletedAt: null }],
      samples: [{ id: 'S', sourceCaseId: 'D', sourceOrderId: 'O-OLD', productAssetId: null, deletedAt: null }],
    });
    const lock = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (query: any) => {
      if (query.sql.includes('FROM "Sample"')) state.samples[0].sourceOrderId = 'O-NEW';
      return lock(query);
    });
    expect(await createSampleRoomService(prisma).createItem({ name: '来源并发变化', sampleId: 'S' }, roomActor())).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED', status: 409 } });
    expect(state.items).toHaveLength(0);
    expect(state.auditLogs).toHaveLength(0);
  });
  it('封样强制审计失败必须回滚 lot-tag，不留下半成功封样或改动借还量', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-SEAL-ATOMIC', code: 'SC-SEAL-ATOMIC', status: 'in_stock', sealedStatus: 'unsealed', quantity: 3, availableQty: 2, deletedAt: null }],
      loans: [{ id: 'SCL-SEAL-ACTIVE', itemId: 'SCI-SEAL-ATOMIC', loanType: 'borrow', loanQuantity: 1, returnedAt: null }],
    });
    const before = structuredClone(state);
    prisma.auditLog.create = vi.fn(async () => { throw new Error('synthetic seal audit refusal'); });
    expect(await createSampleRoomService(prisma).sealCard('SCI-SEAL-ATOMIC', { standardBatchNo: '手工参考批号' }, roomActor())).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(state).toEqual(before);
  });

  it('批次组封样留存 lot-tag 证据但未知历史轮次仍未核实，不能改变审批或库存借还', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'CARD-LOT', code: 'SC-LOT', devCaseId: 'D-LOT', batchId: 'B-LOT', sampleId: 'S-LOT', status: 'borrowed', sealedStatus: 'unsealed', quantity: 3, availableQty: 2, unit: 'PC', deletedAt: null }],
      devCases: [{ id: 'D-LOT', type: 'garment', status: 'draft', deletedAt: null }],
      batches: [{ id: 'B-LOT', developmentCaseId: 'D-LOT', batchCode: 'B-LOT-CODE', round: 4, updatedAt: 4000, status: 'draft', deletedAt: null }],
      samples: [{ id: 'S-LOT', sourceCaseId: 'D-LOT', sourceOrderId: null, productAssetId: null, status: 'pending', deletedAt: null }],
      loans: [{ id: 'LOAN-LOT', itemId: 'CARD-LOT', loanType: 'borrow', loanQuantity: 1, returnedAt: null }],
    });
    const before = structuredClone(state);
    const result = await createSampleRoomService(prisma).sealCard('CARD-LOT', {}, roomActor('operator'));
    expect(result).toMatchObject({ ok: true, data: { item: { sealedStatus: 'sealed', standardBatchNo: 'B-LOT-CODE', quantity: 3, availableQty: 2, status: 'borrowed' }, physicalSeal: {
      kind: 'lot-tag', quantityAtSeal: 3, availableAtSeal: 2, unitAtSeal: 'PC', sourceVerification: 'legacyUnverified', physicalSourceRound: null,
      observedBatch: { id: 'B-LOT', caseId: 'D-LOT', currentRound: 4, updatedAt: '4000' }, reservationCreated: false, approvalChanged: false,
    } } });
    expect(state.loans).toEqual(before.loans);
    expect(state.samples).toEqual(before.samples);
    expect(state.devCases).toEqual(before.devCases);
    expect(state.batches).toEqual(before.batches);
    expect(state.auditLogs[0].detail.after.physicalSeal).toEqual((result as any).data.physicalSeal);
  });
  it('封样留存实物拒绝普通借出与永久寄出，且不写借还流水、库存或审计', async () => {
    const { prisma, state } = makePrisma({ items: [{ id: 'CARD-BORROWABLE', code: 'SC-BORROWABLE', status: 'in_stock', sealedStatus: 'unsealed', quantity: 2, availableQty: 2, deletedAt: null }] });
    const svc = createSampleRoomService(prisma);
    expect(await svc.sealCard('CARD-BORROWABLE', { standardBatchNo: 'MANUAL-REFERENCE' }, roomActor())).toMatchObject({ ok: true, data: { physicalSeal: { sourceVerification: 'manual', physicalSourceRound: null, reservationCreated: false } } });
    const before=structuredClone(state);
    expect(await svc.createLoan('CARD-BORROWABLE', { requestKey: 'room-fixture-loan-12', loanType: 'borrow', borrowerName: '业务员', loanQuantity: 1 }, roomActor())).toMatchObject({ ok:false,error:{code:'SEALED_SAMPLE_BORROW_FORBIDDEN',status:409} });
    expect(await svc.shipItem('CARD-BORROWABLE',{ requestKey: 'room-fixture-ship-13',shipQuantity:1,recipientName:'客户'},roomActor())).toMatchObject({ok:false,error:{code:'SEALED_SAMPLE_SHIP_FORBIDDEN',status:409}});
    expect(state).toEqual(before);
  });
  it.each(['missing-batch', 'deleted-batch', 'deleted-case'])('封样来源 %s 无效时拒绝，不能凭旧批号直接写入标签', async invalid => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'CARD-BAD-SOURCE', code: 'SC-BAD-SOURCE', batchId: 'B', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }],
      devCases: [{ id: 'D', deletedAt: invalid === 'deleted-case' ? 123 : null }],
      batches: invalid === 'missing-batch' ? [] : [{ id: 'B', developmentCaseId: 'D', batchCode: 'B-CODE', round: 1, updatedAt: 1, deletedAt: invalid === 'deleted-batch' ? 123 : null }],
    });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).sealCard('CARD-BAD-SOURCE', { standardBatchNo: 'OLD-LABEL' }, roomActor())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(state).toEqual(before);
  });
  it('封样批次读取故障不能吞掉后改为无来源成功，标签与审计均不写入', async () => {
    const { prisma, state } = makePrisma({ items: [{ id: 'CARD-READ-FAIL', batchId: 'B', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }] });
    const before = structuredClone(state);
    prisma.sampleBatch.findUnique = vi.fn(async () => { throw new Error('synthetic storage unavailable'); });
    expect(await createSampleRoomService(prisma).sealCard('CARD-READ-FAIL', {}, roomActor())).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(state).toEqual(before);
  });
  it('封样卡片与批次归属开发案矛盾时拒绝，不以同业务线掩盖来源冲突', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'CARD-CONFLICT', devCaseId: 'D-A', batchId: 'B', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }],
      devCases: [{ id: 'D-A', type: 'fabric', deletedAt: null }, { id: 'D-B', type: 'fabric', deletedAt: null }],
      batches: [{ id: 'B', developmentCaseId: 'D-B', batchCode: 'B-CODE', round: 1, updatedAt: 1, deletedAt: null }],
    });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).sealCard('CARD-CONFLICT', {}, roomActor())).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(state).toEqual(before);
  });
  it('父源锁定期间批次版本变化拒绝封样，不把新轮次追认为旧实物来源', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'CARD-ROUND', batchId: 'B', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }],
      devCases: [{ id: 'D', deletedAt: null }], batches: [{ id: 'B', developmentCaseId: 'D', batchCode: 'B-CODE', round: 1, updatedAt: 1, deletedAt: null }],
    });
    const lock = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (query: any) => {
      if (query.sql.includes('FROM "SampleBatch"')) Object.assign(state.batches[0], { round: 2, updatedAt: 2 });
      return lock(query);
    });
    const update = vi.spyOn(prisma.sampleCardItem, 'update');
    expect(await createSampleRoomService(prisma).sealCard('CARD-ROUND', {}, roomActor())).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED', status: 409 } });
    expect(update).not.toHaveBeenCalled();
    expect(state.auditLogs).toHaveLength(0);
  });
  it('最终卡片锁时来源关联变化拒绝，不锁定后追逐另一个父源并写标签', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'CARD-RELINK', devCaseId: 'D-OLD', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }],
      devCases: [{ id: 'D-OLD', deletedAt: null }, { id: 'D-NEW', deletedAt: null }],
    });
    const lock = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (query: any) => {
      if (query.sql.includes('FROM "SampleCardItem"')) state.items[0].devCaseId = 'D-NEW';
      return lock(query);
    });
    const update = vi.spyOn(prisma.sampleCardItem, 'update');
    expect(await createSampleRoomService(prisma).sealCard('CARD-RELINK', {}, roomActor())).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED', status: 409 } });
    expect(update).not.toHaveBeenCalled();
    expect(state.auditLogs).toHaveLength(0);
    expect(prisma.$queryRaw.mock.calls.some(([query]: any[]) => query.values[0] === 'D-NEW')).toBe(false);
  });
  it.each([
    { state: 'retired', code: 'ITEM_RETIRED', status: 409 },
    { state: 'shipped', code: 'ITEM_SHIPPED', status: 409 },
    { state: 'deleted', code: 'NOT_FOUND', status: 404 },
  ])('最终卡片锁后 $state 状态优先，封样标签与审计零写入', async terminal => {
    const { prisma, state } = makePrisma({ items: [{ id: 'CARD-TERMINAL', code: 'SC-TERMINAL', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }] });
    const lock = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (query: any) => {
      if (query.sql.includes('FROM "SampleCardItem"')) Object.assign(state.items[0], terminal.state === 'deleted' ? { deletedAt: 123 } : { status: terminal.state });
      return lock(query);
    });
    const update = vi.spyOn(prisma.sampleCardItem, 'update');
    expect(await createSampleRoomService(prisma).sealCard('CARD-TERMINAL', {}, roomActor())).toMatchObject({ ok: false, error: { code: terminal.code, status: terminal.status } });
    expect(update).not.toHaveBeenCalled();
    expect(state.auditLogs).toHaveLength(0);
  });
  it('顺序重复封样只保存第一次标签及一次审计，不把新参考批号覆盖原件', async () => {
    const { prisma, state } = makePrisma({ items: [{ id: 'CARD-DUPLICATE', code: 'SC-DUPLICATE', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }] });
    const svc = createSampleRoomService(prisma);
    expect(await svc.sealCard('CARD-DUPLICATE', { standardBatchNo: 'FIRST' }, roomActor())).toMatchObject({ ok: true });
    expect(await svc.sealCard('CARD-DUPLICATE', { standardBatchNo: 'SECOND' }, roomActor())).toMatchObject({ ok: false, error: { code: 'ALREADY_SEALED', status: 409 } });
    expect(state.items[0].standardBatchNo).toBe('FIRST');
    expect(state.auditLogs).toHaveLength(1);
  });

});

describe('S2B R1 真实业务来源一致性与父源锁顺序', () => {
  it.each(['create', 'seal'])('真实 Sample 的面料案与成衣商品来源明确冲突时 %s 拒绝且零写入', async action => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'CARD-CONFLICT-BUSINESS', sampleId: 'S', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }],
      samples: [{ id: 'S', sourceCaseId: 'D', productAssetId: 'SUBJECT', deletedAt: null }],
      devCases: [{ id: 'D', type: 'fabric', deletedAt: null }], productAssets: [{ id: 'SUBJECT', mainCategory: 'Garment', deletedAt: null }],
    });
    const before = structuredClone(state), svc = createSampleRoomService(prisma);
    const result = action === 'create' ? await svc.createItem({ name: '来源冲突', sampleId: 'S' }, roomActor()) : await svc.sealCard('CARD-CONFLICT-BUSINESS', {}, roomActor());
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(state).toEqual(before);
  });
  it('同一实际开发案的订单业务线矛盾不能作为手工实物归属，且零写入', async () => {
    const { prisma, state } = makePrisma({ devCases: [{ id: 'D', type: 'garment', deletedAt: null }], orders: [{ id: 'O', sourceCaseId: 'D', type: 'Fabric', businessLine: 'fabric', deletedAt: null }] });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).createItem({ name: '订单案异线', devCaseId: 'D', orderId: 'O' }, roomActor())).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(state).toEqual(before);
  });
  it('独立真实订单自身 type/businessLine 冲突时拒绝，不能从名称猜类别', async () => {
    const { prisma, state } = makePrisma({ orders: [{ id: 'O', sourceCaseId: null, type: 'Fabric', businessLine: 'garment', deletedAt: null }] });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).createItem({ name: '手工实物', orderId: 'O', cardType: 'fabric' }, roomActor())).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(state).toEqual(before);
  });
  it('真实 Sample 商品档案分类与 active profile 冲突时拒绝且零写入', async () => {
    const { prisma, state } = makePrisma({ samples: [{ id: 'S', sourceCaseId: null, sourceOrderId: null, productAssetId: 'SUBJECT', deletedAt: null }], productAssets: [{ id: 'SUBJECT', mainCategory: 'Garment', fabricProfile: { id: 'FP', deletedAt: null }, deletedAt: null }] });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).createItem({ name: '真实商品冲突', sampleId: 'S' }, roomActor())).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(state).toEqual(before);
  });
  it('Sample 未填案时显式关联异线案仍与其真实商品来源冲突，不能新增错误归属', async () => {
    const { prisma, state } = makePrisma({ samples: [{ id: 'S', sourceCaseId: null, sourceOrderId: null, productAssetId: 'SUBJECT', deletedAt: null }], devCases: [{ id: 'D', type: 'fabric', deletedAt: null }], productAssets: [{ id: 'SUBJECT', mainCategory: 'Garment', deletedAt: null }] });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).createItem({ name: '补充父源冲突', sampleId: 'S', devCaseId: 'D' }, roomActor())).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(state).toEqual(before);
  });
  it('Card 材料描述的档案类别或 profile 不参与业务 Sample 归属投票', async () => {
    const { prisma, state } = makePrisma({
      samples: [{ id: 'S', sourceCaseId: 'D', sourceOrderId: null, productAssetId: 'SUBJECT', deletedAt: null }], devCases: [{ id: 'D', type: 'garment', deletedAt: null }],
      productAssets: [{ id: 'SUBJECT', mainCategory: 'Garment', deletedAt: null }, { id: 'MATERIAL', mainCategory: 'Fabric', garmentProfile: { id: 'GP', deletedAt: null }, deletedAt: null }],
    });
    const sampleBefore = structuredClone(state.samples);
    expect(await createSampleRoomService(prisma).createItem({ name: '成衣参考面料', cardType: 'fabric', sampleId: 'S', productAssetId: 'MATERIAL' }, roomActor())).toMatchObject({ ok: true, data: { item: { devCaseId: 'D', sampleId: 'S', productAssetId: 'MATERIAL', cardType: 'fabric' } } });
    expect(state.samples).toEqual(sampleBefore);
  });
  it('真实但未知类别的 legacy Sample 来源仍允许 custody，不制造批准或猜业务线', async () => {
    const { prisma, state } = makePrisma({
      samples: [{ id: 'S', sourceCaseId: 'D', sourceOrderId: 'O', productAssetId: 'SUBJECT', status: 'draft', deletedAt: null }], devCases: [{ id: 'D', type: 'other', deletedAt: null }],
      orders: [{ id: 'O', sourceCaseId: 'D', businessLine: null, type: null, deletedAt: null }], productAssets: [{ id: 'SUBJECT', mainCategory: 'Other', deletedAt: null }],
    });
    const sampleBefore = structuredClone(state.samples);
    expect(await createSampleRoomService(prisma).createItem({ name: '历史未知实物', sampleId: 'S', cardType: 'garment' }, roomActor())).toMatchObject({ ok: true, data: { item: { sampleId: 'S', devCaseId: 'D', orderId: 'O' } } });
    expect(state.samples).toEqual(sampleBefore);
  });
  it('封样完整父源必须 Case→Batch→Order→Asset→Warehouse→Sample→Card 锁定', async () => {
    const { prisma } = makePrisma({
      items: [{ id: 'CARD', sampleId: 'S', devCaseId: 'D', orderId: 'O', productAssetId: 'MATERIAL', batchId: 'B', warehouseId: 'W', status: 'in_stock', sealedStatus: 'unsealed', quantity: 1, availableQty: 1, deletedAt: null }],
      samples: [{ id: 'S', sourceCaseId: 'D', sourceOrderId: 'O', productAssetId: 'SUBJECT', deletedAt: null }], devCases: [{ id: 'D', type: 'garment', deletedAt: null }], orders: [{ id: 'O', sourceCaseId: 'D', businessLine: 'garment', type: 'Garment', deletedAt: null }],
      batches: [{ id: 'B', developmentCaseId: 'D', batchCode: 'BC', round: 1, updatedAt: 1, deletedAt: null }], warehouses: [{ id: 'W', isActive: true, deletedAt: null }],
      productAssets: [{ id: 'MATERIAL', mainCategory: 'Fabric', deletedAt: null }, { id: 'SUBJECT', mainCategory: 'Garment', deletedAt: null }],
    });
    expect(await createSampleRoomService(prisma).sealCard('CARD', {}, roomActor())).toMatchObject({ ok: true });
    const queries = prisma.$queryRaw.mock.calls.map(([query]: any[]) => query);
    expect(queries.map((query: any) => query.sql.match(/FROM "([^"]+)"/)[1])).toEqual(['DevelopmentCase', 'SampleBatch', 'Order', 'ProductAsset', 'ProductAsset', 'Warehouse', 'Sample', 'SampleCardItem']);
    expect(queries.map((query: any) => query.values[0])).toEqual(['D', 'B', 'O', 'MATERIAL', 'SUBJECT', 'W', 'S', 'CARD']);
  });
  it('同ID开发案锁定期间已知类别变为未知也拒绝，不能默默改变来源分类', async () => {
    const { prisma, state } = makePrisma({ samples: [{ id: 'S', sourceCaseId: 'D', deletedAt: null }], devCases: [{ id: 'D', type: 'garment', deletedAt: null }] });
    const lock = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (query: any) => { if (query.sql.includes('FROM "DevelopmentCase"')) state.devCases[0].type = 'other'; return lock(query); });
    expect(await createSampleRoomService(prisma).createItem({ name: '类别变源', sampleId: 'S' }, roomActor())).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED', status: 409 } });
    expect(state.items).toHaveLength(0); expect(state.auditLogs).toHaveLength(0);
  });
  it('真实Sample商品同ID档案锁定期间类别变化必须拒绝，不从descriptor类别替补', async () => {
    const { prisma, state } = makePrisma({ samples: [{ id: 'S', productAssetId: 'SUBJECT', deletedAt: null }], productAssets: [{ id: 'SUBJECT', mainCategory: 'Garment', deletedAt: null }] });
    const lock = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (query: any) => { if (query.sql.includes('FROM "ProductAsset"')) state.productAssets[0].mainCategory = 'Other'; return lock(query); });
    expect(await createSampleRoomService(prisma).createItem({ name: '商品类别变源', sampleId: 'S' }, roomActor())).toMatchObject({ ok: false, error: { code: 'SOURCE_CHANGED', status: 409 } });
    expect(state.items).toHaveLength(0); expect(state.auditLogs).toHaveLength(0);
  });
  it('真实分类读取故障不能吞成 unresolved custody 成功，零实物/审计写入', async () => {
    const { prisma, state } = makePrisma({ samples: [{ id: 'S', sourceCaseId: 'D', deletedAt: null }], devCases: [{ id: 'D', type: 'garment', deletedAt: null }] });
    const before = structuredClone(state);
    prisma.developmentCase.findMany = vi.fn(async () => { throw new Error('synthetic classifier read unavailable'); });
    expect(await createSampleRoomService(prisma).createItem({ name: '来源读取失败', sampleId: 'S' }, roomActor())).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(state).toEqual(before);
  });
});

describe('实物保管账安全 · 连续操作', () => {
  it('寄出必须走独立接口，通用借看接口拒绝 ship 且不写流水、库存或审计', async () => {
    const { prisma, state } = makePrisma({ items: [{ id: 'SCI-SAFE', code: 'SC-SAFE', name: '实物样品', cardType: 'fabric', status: 'in_stock', quantity: 2, availableQty: 2, deletedAt: null }] });
    const before = structuredClone(state);
    const result = await createSampleRoomService(prisma).createLoan('SCI-SAFE', { requestKey: 'room-fixture-loan-14', loanType: 'ship', loanQuantity: 1, borrowerName: '收件人' }, roomActor('operator'));
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(state).toEqual(before);
  });
  it.each(['borrow', 'viewing'])('历史 shipped 残留 quantity 2 也明确拒绝 %s，流水、库存、审计零写入', async loanType => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-SHIPPED-LOAN', code: 'SC-SHIPPED-LOAN', status: 'shipped', quantity: 2, availableQty: 0, deletedAt: null }],
      loans: [{ id: 'SCL-SHIPPED-LOAN', itemId: 'SCI-SHIPPED-LOAN', loanType: 'ship', loanQuantity: 2, returnedAt: 123 }],
    });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).createLoan('SCI-SHIPPED-LOAN', { requestKey: 'room-fixture-loan-15', loanType, loanQuantity: 1, borrowerName: '来访人' }, roomActor())).toMatchObject({ ok: false, error: { code: 'ITEM_SHIPPED', status: 409 } });
    expect(state).toEqual(before);
  });
  it('quantity 2 → 寄出 1 → 实物盘点 1，寄出同时扣总量与可用量而不产生在借', async () => {
    const { prisma, state } = makePrisma({ items: [{ id: 'SCI-SHIP', code: 'SC-SHIP', status: 'in_stock', quantity: 2, availableQty: 2, deletedAt: null }] });
    const service = createSampleRoomService(prisma);
    const shipped = await service.shipItem('SCI-SHIP', { requestKey: 'room-fixture-ship-16', shipQuantity: 1, recipientName: '收件人' }, roomActor('operator'));
    expect(shipped).toMatchObject({ ok: true, data: { item: { quantity: 1, availableQty: 1, status: 'in_stock' }, archived: false } });
    expect(state.loans).toHaveLength(1);
    expect(state.loans[0]).toMatchObject({ loanType: 'ship', loanQuantity: 1 });
    expect(state.loans[0].returnedAt).not.toBeNull();
    expect(state.items[0]).toMatchObject({ quantity: 1, availableQty: 1, status: 'in_stock' });
    expect(service).not.toHaveProperty('adjustQuantity');
  });
  it('quantity 3 → 借出 1 仍 in_stock，部分在借也拒绝退役并且不写入', async () => {
    const { prisma, state } = makePrisma({ items: [{ id: 'SCI-PARTIAL', code: 'SC-PARTIAL', status: 'in_stock', quantity: 3, availableQty: 3, deletedAt: null }] });
    const service = createSampleRoomService(prisma);
    expect(await service.createLoan('SCI-PARTIAL', { requestKey: 'room-fixture-loan-17', loanType: 'borrow', loanQuantity: 1, borrowerName: '借用人' }, roomActor())).toMatchObject({ ok: true, data: { item: { status: 'in_stock', availableQty: 2 } } });
    const before = structuredClone(state);
    expect(await service.retireItem('SCI-PARTIAL', '报废', roomActor())).toMatchObject({ ok: false, error: { code: 'ITEM_NOT_BORROWABLE', status: 409 } });
    expect(state).toEqual(before);
  });
  it.each([
    { status: 'retired', deletedAt: null, code: 'ITEM_RETIRED', http: 409 },
    { status: 'shipped', deletedAt: null, code: 'ITEM_SHIPPED', http: 409 },
    { status: 'in_stock', deletedAt: 123, code: 'NOT_FOUND', http: 404 },
  ])('归还拒绝终态/归档 $status / deletedAt=$deletedAt，流水、库存和审计零写入', async ({ status, deletedAt, code, http }) => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-TERMINAL', code: 'SC-TERMINAL', status, quantity: 1, availableQty: 0, deletedAt }],
      loans: [{ id: 'SCL-TERMINAL', itemId: 'SCI-TERMINAL', loanType: 'borrow', loanQuantity: 1, returnedAt: null }],
    });
    const before = structuredClone(state);
    expect(await createSampleRoomService(prisma).returnLoan('SCL-TERMINAL', '已收回', roomActor())).toMatchObject({ ok: false, error: { code, status: http } });
    expect(state).toEqual(before);
  });
  it('MVP 不提供样品库存盘点调整服务', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-LEGACY', code: 'SC-LEGACY', status: 'in_stock', quantity: 2, availableQty: 1, deletedAt: null }],
      loans: [{ id: 'SCL-LEGACY', itemId: 'SCI-LEGACY', loanType: 'ship', loanQuantity: 1, returnedAt: 123 }],
    });
    const before = structuredClone(state);
    const service = createSampleRoomService(prisma);
    expect(service).not.toHaveProperty('adjustQuantity');
    expect(state).toEqual(before);
  });
  it('借用的强制审计失败时，不能留下成功的借用流水和库存扣减', async () => {
    const { prisma, state } = makePrisma({ items: [{ id: 'SCI-AUDIT', code: 'SC-AUDIT', status: 'in_stock', quantity: 2, availableQty: 2, deletedAt: null }] });
    const before = structuredClone(state);
    prisma.auditLog.create = vi.fn(async () => { throw new Error('synthetic audit refusal'); });
    expect(await createSampleRoomService(prisma).createLoan('SCI-AUDIT', { requestKey: 'room-fixture-loan-18', loanType: 'borrow', loanQuantity: 1, borrowerName: '借用人' }, roomActor())).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(state).toEqual(before);
  });
  it('quantity 3 → 借出 1 → 寄出可用 2，仍持有借出件不能归档；归还后仍可操作', async () => {
    const { prisma, state } = makePrisma({ items: [{ id: 'SCI-MIXED', code: 'SC-MIXED', status: 'in_stock', quantity: 3, availableQty: 3, deletedAt: null }] });
    const service = createSampleRoomService(prisma);
    const borrowed = await service.createLoan('SCI-MIXED', { requestKey: 'room-fixture-loan-19', loanType: 'borrow', loanQuantity: 1, borrowerName: '借用人' }, roomActor());
    expect(borrowed).toMatchObject({ ok: true, data: { item: { quantity: 3, availableQty: 2, status: 'in_stock' } } });
    expect(await service.shipItem('SCI-MIXED', { requestKey: 'room-fixture-ship-20', shipQuantity: 2, recipientName: '客户' }, roomActor())).toMatchObject({ ok: true, data: { item: { quantity: 1, availableQty: 0, status: 'borrowed' }, archived: false } });
    expect(await service.returnLoan((borrowed as any).data.loan.id, undefined, roomActor())).toMatchObject({ ok: true, data: { item: { quantity: 1, availableQty: 1, status: 'in_stock' } } });
    expect(state.loans.filter(loan => loan.loanType === 'borrow' && loan.returnedAt == null)).toHaveLength(0);
    expect(await service.shipItem('SCI-MIXED', { requestKey: 'room-fixture-ship-21', shipQuantity: 1, recipientName: '客户' }, roomActor())).toMatchObject({ ok: true, data: { item: { quantity: 0, availableQty: 0, status: 'shipped' }, archived: true } });
    const beforeDuplicate = structuredClone(state);
    expect(await service.returnLoan((borrowed as any).data.loan.id, undefined, roomActor())).toMatchObject({ ok: false, error: { code: 'LOAN_ALREADY_ACTIVE', status: 409 } });
    expect(state).toEqual(beforeDuplicate);
  });
  it.each(['viewing', 'ship', 'return', 'retire'])('保管账 %s 强制审计失败不留下库存/流水变化（synthetic transaction seam）', async operation => {
    const returning = operation === 'return';
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-ATOMIC', code: 'SC-ATOMIC', status: returning ? 'borrowed' : 'in_stock', quantity: 2, availableQty: returning ? 0 : 2, deletedAt: null }],
      loans: returning ? [{ id: 'SCL-ATOMIC', itemId: 'SCI-ATOMIC', loanType: 'borrow', loanQuantity: 2, returnedAt: null }] : [],
    });
    const before = structuredClone(state);
    prisma.auditLog.create = vi.fn(async () => { throw new Error('synthetic audit refusal'); });
    const service = createSampleRoomService(prisma);
    const result = operation === 'viewing' ? await service.createLoan('SCI-ATOMIC', { requestKey: 'room-fixture-loan-22', loanType: 'viewing', borrowerName: '看样人' }, roomActor())
      : operation === 'ship' ? await service.shipItem('SCI-ATOMIC', { requestKey: 'room-fixture-ship-23', shipQuantity: 1, recipientName: '客户' }, roomActor())
      : operation === 'return' ? await service.returnLoan('SCL-ATOMIC', undefined, roomActor())
      : await service.retireItem('SCI-ATOMIC', undefined, roomActor());
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(state).toEqual(before);
  });
});

describe('样卡登记与编号（DR-057-③）', () => {
  it('成衣手工登记一次只允许登记一件，不能生成聚合数量行', async () => {
    const { prisma, state } = makePrisma();
    const result = await createSampleRoomService(prisma).createItem({ name: '同款第二件', cardType: 'garment', quantity: 2 }, roomActor('u1'));
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('每次只登记 1 件') } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.items).toEqual([]);
    expect(state.auditLogs).toEqual([]);
  });
  it('creates stock and mandatory audit through the same transaction client', async () => {
    const { prisma } = makePrisma();
    const txCreate = vi.fn(async ({ data }: any) => data);
    const txAudit = vi.fn(async ({ data }: any) => ({ id: data.id }));
    const tx = { ...prisma, sampleCardItem: { ...prisma.sampleCardItem, count: vi.fn(async () => 0), create: txCreate }, auditLog: { create: txAudit } };delete tx.$transaction;
    prisma.$transaction.mockImplementation(async (callback: (client: any) => Promise<any>) => callback(tx));
    const result = await createSampleRoomService(prisma).createItem({ name: 'transaction-only creation', quantity: 0 }, roomActor('u1'));
    expect(result.ok).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(txAudit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorId: 'u1', action: 'sample_card_create', targetId: (result as any).data.item.id }) }));
  });
  it('does not report creation success when the transaction audit rejects', async () => {
    const { prisma } = makePrisma();
    const audit = vi.fn(async () => { throw new Error('synthetic delegate failure, not PG rollback evidence'); });
    prisma.$transaction.mockImplementation(async (callback: (client: any) => Promise<any>) => {
      const tx={...prisma,sampleCardItem: { ...prisma.sampleCardItem, count: async () => 0, create: async ({ data }: any) => data }, auditLog: { create: audit }};delete tx.$transaction;return callback(tx);
    });
    const result = await createSampleRoomService(prisma).createItem({ name: 'audit refusal' }, roomActor('u1'));
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(audit).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1, 2147483647])('explicit valid quantity %s is preserved exactly instead of clamped/floored', async quantity => {
    const { prisma, state } = makePrisma();
    const result = await createSampleRoomService(prisma).createItem({ name: 'explicit inventory', quantity, minStock: 0, maxStock: quantity, unit: 'PC' }, roomActor('u1'));
    expect(result.ok).toBe(true);
    expect((result as any).data.item).toMatchObject({ quantity, availableQty: quantity, minStock: 0, maxStock: quantity, unit: 'PC' });
    expect(state.items).toHaveLength(1);
  });
  it('only genuinely omitted quantity defaults to one; omitted/null optional bounds stay unknown', async () => {
    const { prisma } = makePrisma();
    const result = await createSampleRoomService(prisma).createItem({ name: 'omitted inventory', minStock: null, maxStock: null }, roomActor('u1'));
    expect(result.ok).toBe(true);
    expect((result as any).data.item).toMatchObject({ quantity: 1, availableQty: 1, minStock: null, maxStock: null, unit: '张' });
  });
  it.each([-1, NaN, Infinity, '', '1', null, 1.5, 2147483648])('invalid explicit quantity %s rejects before any item or audit write', async quantity => {
    const { prisma, state } = makePrisma();
    const result = await createSampleRoomService(prisma).createItem({ name: 'invalid inventory', quantity } as any, roomActor('u1'));
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(state.items).toEqual([]);
    expect(state.auditLogs).toEqual([]);
  });
  it.each(['minStock', 'maxStock'] as const)('invalid %s values never become zero or a truncated integer', async field => {
    for (const value of [-1, NaN, Infinity, '', '1', 0.5, 2147483648]) {
      const { prisma, state } = makePrisma();
      const result = await createSampleRoomService(prisma).createItem({ name: 'invalid bound', [field]: value } as any, roomActor('u1'));
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(state.items).toEqual([]);
      expect(state.auditLogs).toEqual([]);
    }
  });
  it.each(['', 'PC-unknown', 'this-unit-is-longer-than-sixteen-characters', null])('unrecognized explicit unit %s rejects without truncation or fallback', async unit => {
    const { prisma, state } = makePrisma();
    const result = await createSampleRoomService(prisma).createItem({ name: 'invalid unit', unit } as any, roomActor('u1'));
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(state.items).toEqual([]);
    expect(state.auditLogs).toEqual([]);
  });
  it.each(['PC', 'YD', 'M', 'KG', 'SET', '张', '米'])('existing unit %s remains supported exactly', async unit => {
    const { prisma } = makePrisma();
    const result = await createSampleRoomService(prisma).createItem({ name: 'valid unit', quantity: 1, unit, ...(['M','米'].includes(unit) ? {physicalLengthQty:'1.25'} : {}) }, roomActor('u1'));
    expect(result.ok).toBe(true);
    expect((result as any).data.item.unit).toBe(unit);
  });
  it('编号当日递增 SC-YYYYMMDD-NNN；保留自定义 cardType', async () => {
    const { prisma, state } = makePrisma();
    const svc = createSampleRoomService(prisma);
    const a = await svc.createItem({ name: '苎麻衬衫面料卡', cardType: 'fabric', location: 'A-01' }, roomActor('u1'));
    const b = await svc.createItem({ name: 'Classic Blue 色卡', cardType: 'colorcard', colorCardCode: '19-4052 TCX' }, roomActor('u1'));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect((a as any).data.item.code).toMatch(/^SC-\d{8}-001$/);
    expect((b as any).data.item.code).toMatch(/^SC-\d{8}-002$/);
    expect((b as any).data.item.colorCardCode).toBe('19-4052 TCX'); // 逻辑色卡弱关联
    expect(state.auditLogs.map((x: any) => x.action)).toContain('sample_card_create');

    const custom = await svc.createItem({ name: 'X', cardType: 'weird' }, roomActor());
    expect(custom).toMatchObject({ ok: true, data: { item: { cardType: 'weird' } } });
    const noName = await svc.createItem({}, roomActor());
    expect((noName as any).error.code).toBe('VALIDATION_FAILED');
  });

  it('v2：登记带 quantity/minStock/warehouseId/devCaseId/orderId', async () => {
    const { prisma, state } = makePrisma({
      warehouses: [{ id: 'WH-1', code: 'WH-001', name: '样品间主仓' }],
      devCases: [{ id: 'DC-1', code: 'DEV-20260825-001', name: '夏季衬衫开发' }],
      orders: [{ id: 'OD-1', poNumber: 'PO-2025-001', customer: 'Peerless' }],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.createItem({
      name: '夏季色卡', cardType: 'colorcard',
      quantity: 10, minStock: 3, maxStock: 20, unit: '张',
      warehouseId: 'WH-1', devCaseId: 'DC-1', orderId: 'OD-1',
    }, roomActor('u1'));
    expect(r.ok).toBe(true);
    const item = (r as any).data.item;
    expect(item.quantity).toBe(10);
    expect(item.availableQty).toBe(10);
    expect(item.minStock).toBe(3);
    expect(item.maxStock).toBe(20);
    expect(item.warehouseId).toBe('WH-1');
    expect(item.devCaseId).toBe('DC-1');
    expect(item.orderId).toBe('OD-1');

    // 关联不存在校验
    const bad = await svc.createItem({ name: 'X', warehouseId: 'WH-X' }, roomActor());
    expect((bad as any).error.code).toBe('VALIDATION_FAILED');
  });

  it('v2：minStock > maxStock 校验失败', async () => {
    const { prisma } = makePrisma();
    const svc = createSampleRoomService(prisma);
    const r = await svc.createItem({ name: 'X', minStock: 10, maxStock: 5 }, roomActor());
    expect((r as any).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('借出/归还状态机（DR-057-②）', () => {
  it('借出 → borrowed；在借再借 409；归还 → in_stock（append-only 补记）', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-1', code: 'SC-20260820-001', name: '样卡一', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);
    const dueAt = Date.now() + 3 * 24 * 3600 * 1000;
    const loan = await svc.createLoan('SCI-1', { requestKey: 'room-fixture-loan-24', loanType: 'borrow', borrowerName: '小张', dueAt }, roomActor('u2'));
    expect(loan.ok).toBe(true);
    expect(state.items[0].status).toBe('borrowed');
    expect(state.items[0].availableQty).toBe(0); // v2：扣减

    const again = await svc.createLoan('SCI-1', { requestKey: 'room-fixture-loan-25', loanType: 'borrow', borrowerName: '小李' }, roomActor());
    expect((again as any).error.code).toBe('INSUFFICIENT_QTY'); // v2：可用不足

    const ret = await svc.returnLoan((loan as any).data.loan.id, '边角轻微磨损', roomActor('u2'));
    expect(ret.ok).toBe(true);
    expect(state.items[0].status).toBe('in_stock');
    expect(state.items[0].availableQty).toBe(1); // v2：归还后恢复
    const loanRow = state.loans[0];
    expect(loanRow.returnedAt).toBeGreaterThan(0);
    expect(loanRow.conditionNote).toBe('边角轻微磨损');
    expect(loanRow.borrowerName).toBe('小张'); // append-only：历史行内容不被改写
    expect(loanRow.loanQuantity).toBe(1); // v2：默认 1

    const retAgain = await svc.returnLoan((loan as any).data.loan.id, undefined, roomActor());
    expect((retAgain as any).error.code).toBe('LOAN_ALREADY_ACTIVE'); // 重复归还 409
  });

  it('逾期派生标记（dueAt < now 且未归还）；归还后消除', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-1', code: 'SC-20260820-001', name: '样卡一', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);
    const overdueDue = Date.now() - 24 * 3600 * 1000;
    const loan = await svc.createLoan('SCI-1', { requestKey: 'room-fixture-loan-26', loanType: 'borrow', borrowerName: '老王', dueAt: overdueDue }, roomActor());
    expect((loan as any).data.loan.overdue).toBe(true);

    const list = await svc.listItems({}, roomActor());
    expect((list as any).data.items[0].overdue).toBe(true);

    const overdueLoans = await svc.listLoans({ overdue: true }, roomActor());
    expect((overdueLoans as any).data.loans).toHaveLength(1);

    await svc.returnLoan((loan as any).data.loan.id, undefined, roomActor());
    const after = await svc.listLoans({ overdue: true }, roomActor());
    expect((after as any).data.loans).toHaveLength(0);
  });
});

describe('v2：多数量借出 + 部分借出', () => {
  it('10 张库存，先借 4 → 仍 in_stock（剩 6），再借 6 → borrowed（剩 0）', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-M', code: 'SC-20260825-001', name: '多量样卡', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 10, deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);

    const l1 = await svc.createLoan('SCI-M', { requestKey: 'room-fixture-loan-27', loanType: 'borrow', borrowerName: '小李', loanQuantity: 4 }, roomActor());
    expect(l1.ok).toBe(true);
    expect(state.items[0].availableQty).toBe(6);
    expect(state.items[0].status).toBe('in_stock'); // 部分借出，仍可借

    const l2 = await svc.createLoan('SCI-M', { requestKey: 'room-fixture-loan-28', loanType: 'borrow', borrowerName: '小王', loanQuantity: 6 }, roomActor());
    expect(l2.ok).toBe(true);
    expect(state.items[0].availableQty).toBe(0);
    expect(state.items[0].status).toBe('borrowed');

    // 归还第一笔 4 张
    await svc.returnLoan((l1 as any).data.loan.id, undefined, roomActor());
    expect(state.items[0].availableQty).toBe(4);
    expect(state.items[0].status).toBe('in_stock'); // 又可借
  });

  it('借出超过总库存 → VALIDATION_FAILED；超过可用 → INSUFFICIENT_QTY', async () => {
    const { prisma } = makePrisma({
      items: [{ id: 'SCI-X', code: 'SC-20260825-002', name: 'X', cardType: 'fabric', status: 'in_stock', quantity: 5, availableQty: 5, deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);
    // Establish the missing three pieces with the real producer so the shortage
    // probe measures available stock, rather than an inconsistent seeded scalar.
    expect(await svc.createLoan('SCI-X', { requestKey: 'room-stock-shortage-origin', loanType: 'borrow', borrowerName: 'Existing borrower', loanQuantity: 3 }, roomActor())).toMatchObject({ ok: true, data: { item: { availableQty: 2 } } });

    const over = await svc.createLoan('SCI-X', { requestKey: 'room-fixture-loan-29', loanType: 'borrow', borrowerName: 'A', loanQuantity: 10 }, roomActor());
    expect((over as any).error.code).toBe('VALIDATION_FAILED'); // 超过总库存

    const ins = await svc.createLoan('SCI-X', { requestKey: 'room-fixture-loan-30', loanType: 'borrow', borrowerName: 'B', loanQuantity: 5 }, roomActor());
    expect((ins as any).error.code).toBe('INSUFFICIENT_QTY'); // 超过可用（2<5）
  });

  it('P1 修复：部分借出多笔并行 → listItems/getItem 返回全部活跃借出 activeLoans，逐笔可独立归还', async () => {
    const { prisma } = makePrisma({
      items: [{ id: 'SCI-M', code: 'SC-20260903-001', name: '多笔并行样卡', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 2, deletedAt: null }],
      loans: [
        { id: 'SCL-1', itemId: 'SCI-M', loanType: 'borrow', loanQuantity: 4, borrowerName: '小李', loanedAt: 1000, returnedAt: null },
        { id: 'SCL-2', itemId: 'SCI-M', loanType: 'borrow', loanQuantity: 4, borrowerName: '小王', loanedAt: 2000, returnedAt: null },
        { id: 'SCL-3', itemId: 'SCI-M', loanType: 'borrow', loanQuantity: 2, borrowerName: '小张', loanedAt: 500, returnedAt: 900 }, // 已还，不算活跃
      ],
    });
    const svc = createSampleRoomService(prisma);

    // 列表：activeLoan 保留最新一笔（向后兼容），activeLoans 为全部未归还
    const list = await svc.listItems({}, roomActor());
    const item = (list as any).data.items[0];
    expect(item.activeLoan.id).toBe('SCL-2');
    expect(item.activeLoans).toHaveLength(2);
    expect(item.activeLoans.map((l: any) => l.id).sort()).toEqual(['SCL-1', 'SCL-2']);

    // 详情：同样返回全部活跃借出
    const d = await svc.getItem('SCI-M', roomActor());
    expect((d as any).data.item.activeLoans).toHaveLength(2);

    // 逐笔独立归还：还第一笔（SCL-1）后第二笔仍在借
    const ret = await svc.returnLoan('SCL-1', '完好归还', roomActor('u1'));
    expect(ret.ok).toBe(true);
    const after = await svc.listItems({}, roomActor());
    const afterItem = (after as any).data.items[0];
    expect(afterItem.activeLoans.map((l: any) => l.id)).toEqual(['SCL-2']);
    expect(afterItem.activeLoan.id).toBe('SCL-2');
    expect(afterItem.availableQty).toBe(6); // 2 + 4 归还
  });
});

describe('v2：低库存预警 listLowStock', () => {
  it('availableQty <= minStock 返回预警 + shortage/severity', async () => {
    const { prisma } = makePrisma({
      items: [
        { id: 'SCI-1', code: 'SC-1', name: 'A', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 0, minStock: 3, deletedAt: null },
        { id: 'SCI-2', code: 'SC-2', name: 'B', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 2, minStock: 3, deletedAt: null },
        { id: 'SCI-3', code: 'SC-3', name: 'C', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 5, minStock: 3, deletedAt: null }, // 不预警
        { id: 'SCI-4', code: 'SC-4', name: 'D', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 10, deletedAt: null }, // 无 minStock
        { id: 'SCI-5', code: 'SC-5', name: 'E', cardType: 'fabric', status: 'retired', quantity: 10, availableQty: 0, minStock: 3, deletedAt: null }, // 退役排除
      ],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.listLowStock(100, roomActor());
    expect(r.ok).toBe(true);
    const items = (r as any).data.items;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('SCI-1'); // availableQty=0 优先
    expect(items[0].severity).toBe('critical');
    expect(items[0].shortage).toBe(3);
    expect(items[1].id).toBe('SCI-2');
    expect(items[1].severity).toBe('warning');
  });
});

describe('看样登记（DR-057-② viewing 即看即还）', () => {
  it('看样挂客户快照，不占借出状态；客户不存在 400', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-1', code: 'SC-20260820-001', name: '样卡一', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, deletedAt: null }],
      relations: [{ id: 'REL-1', name: 'Peerless Clothing', deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);
    const v = await svc.createLoan('SCI-1', { requestKey: 'room-fixture-loan-31', loanType: 'viewing', borrowerName: 'Alice', relationId: 'REL-1' }, roomActor('u3'));
    expect(v.ok).toBe(true);
    const loan = (v as any).data.loan;
    expect(loan.relationName).toBe('Peerless Clothing');
    expect(loan.returnedAt).toBeGreaterThan(0); // 即看即还
    expect(state.items[0].status).toBe('in_stock'); // 不占借出状态
    expect(state.auditLogs.map((x: any) => x.action)).toContain('sample_card_viewing');

    const bad = await svc.createLoan('SCI-1', { requestKey: 'room-fixture-loan-32', loanType: 'viewing', borrowerName: 'X', relationId: 'REL-X' }, roomActor());
    expect((bad as any).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('退役与边界（DR-057-② 终态）', () => {
  it('在借退役 409；归还后退役成功；退役后不可借/不可再退役', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-1', code: 'SC-20260820-001', name: '样卡一', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);
    const loan = await svc.createLoan('SCI-1', { requestKey: 'room-fixture-loan-33', loanType: 'borrow', borrowerName: '小张' }, roomActor());
    const r1 = await svc.retireItem('SCI-1', '样卡褪色报废', roomActor());
    expect((r1 as any).error.code).toBe('ITEM_NOT_BORROWABLE');

    await svc.returnLoan((loan as any).data.loan.id, undefined, roomActor());
    const r2 = await svc.retireItem('SCI-1', '样卡褪色报废', roomActor());
    expect(r2.ok).toBe(true);
    expect(state.items[0].status).toBe('retired');

    const borrow = await svc.createLoan('SCI-1', { requestKey: 'room-fixture-loan-34', loanType: 'borrow', borrowerName: '小李' }, roomActor());
    expect((borrow as any).error.code).toBe('ITEM_RETIRED');
    const view = await svc.createLoan('SCI-1', { requestKey: 'room-fixture-loan-35', loanType: 'viewing', borrowerName: '访客' }, roomActor());
    expect((view as any).error.code).toBe('ITEM_RETIRED');
    const r3 = await svc.retireItem('SCI-1', undefined, roomActor());
    expect((r3 as any).error.code).toBe('ITEM_RETIRED');
  });

  it('详情含借还历史正序；按 code 直达；404 边界', async () => {
    const { prisma, state } = makePrisma({
      items: [{ id: 'SCI-1', code: 'SC-20260820-001', name: '样卡一', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, deletedAt: null }],
      loans: [
        { id: 'SCL-1', itemId: 'SCI-1', loanType: 'borrow', loanQuantity: 1, borrowerName: 'A', loanedAt: 1000, returnedAt: 2000 },
        { id: 'SCL-2', itemId: 'SCI-1', loanType: 'viewing', loanQuantity: 1, borrowerName: 'B', loanedAt: 3000, returnedAt: 3000 },
      ],
    });
    const svc = createSampleRoomService(prisma);
    const d = await svc.getItem('SCI-1', roomActor());
    expect((d as any).data.loans.map((l: any) => l.id)).toEqual(['SCL-1', 'SCL-2']);

    const byCode = await svc.listItems({ code: 'SC-20260820-001' }, roomActor());
    expect((byCode as any).data.items).toHaveLength(1);

    const nf = await svc.getItem('NOPE', roomActor());
    expect((nf as any).error.code).toBe('NOT_FOUND');
    const nfLoan = await svc.returnLoan('NOPE', undefined, roomActor());
    expect((nfLoan as any).error.code).toBe('NOT_FOUND');
  });
});

describe('v2：列表关联单据摘要 join', () => {
  it('listItems 返回 devCaseCode/orderPoNumber/warehouseCode 摘要', async () => {
    const { prisma } = makePrisma({
      items: [{
        id: 'SCI-L', code: 'SC-20260825-099', name: '联动样卡', cardType: 'fabric', status: 'in_stock',
        quantity: 5, availableQty: 5, warehouseId: 'WH-1', devCaseId: 'DC-1', orderId: 'OD-1', deletedAt: null,
      }],
      warehouses: [{ id: 'WH-1', code: 'WH-SAMPLE', name: '样品仓' }],
      devCases: [{ id: 'DC-1', code: 'DEV-2026-001', name: '开发单A' }],
      orders: [{ id: 'OD-1', poNumber: 'PO-2025-099', customer: 'Acme' }],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.listItems({}, roomActor());
    expect(r.ok).toBe(true);
    const item = (r as any).data.items[0];
    expect(item.devCaseCode).toBe('DEV-2026-001');
    expect(item.devCaseName).toBe('开发单A');
    expect(item.orderPoNumber).toBe('PO-2025-099');
    expect(item.orderCustomer).toBe('Acme');
    expect(item.warehouseCode).toBe('WH-SAMPLE');
    expect(item.warehouseName).toBe('样品仓');
  });

  it('listItems 按 devCaseId/orderId/warehouseId 过滤 + lowStock 过滤', async () => {
    const { prisma } = makePrisma({
      items: [
        { id: 'SCI-1', code: 'SC-1', name: 'A', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 1, minStock: 3, devCaseId: 'DC-1', deletedAt: null },
        { id: 'SCI-2', code: 'SC-2', name: 'B', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 8, minStock: 3, devCaseId: 'DC-1', deletedAt: null },
        { id: 'SCI-3', code: 'SC-3', name: 'C', cardType: 'fabric', status: 'in_stock', quantity: 10, availableQty: 5, minStock: 3, devCaseId: 'DC-2', deletedAt: null },
      ],
    });
    const svc = createSampleRoomService(prisma);

    // 按 devCaseId 过滤
    const byDev = await svc.listItems({ devCaseId: 'DC-1' }, roomActor());
    expect((byDev as any).data.items).toHaveLength(2);

    // lowStock 过滤（DC-1 下：SCI-1 1<=3 预警；SCI-2 8>3 不预警）
    const low = await svc.listItems({ devCaseId: 'DC-1', lowStock: true }, roomActor());
    expect((low as any).data.items).toHaveLength(1);
    expect((low as any).data.items[0].id).toBe('SCI-1');
  });
});

describe('v2：数字档案 productAssetId 联动', () => {
  it('createItem 带 productAssetId：写入 + 审计日志记录', async () => {
    const { prisma, state } = makePrisma({
      productAssets: [{ id: 'PA-1', sku: 'FAB-COTTON-TWILL', name: '棉弹力斜纹', mainCategory: 'fabric' }],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.createItem({
      name: '棉弹力斜纹样卡', cardType: 'fabric',
      productAssetId: 'PA-1',
    }, roomActor('u1'));
    expect(r.ok).toBe(true);
    const item = (r as any).data.item;
    expect(item.productAssetId).toBe('PA-1');
    expect(state.items[0].productAssetId).toBe('PA-1');
    // 审计日志 detail.after 包含 productAssetId
    const auditDetail = state.auditLogs[0].detail;
    expect(auditDetail.after.productAssetId).toBe('PA-1');
  });

  it('createItem productAssetId 不存在 → VALIDATION_FAILED', async () => {
    const { prisma } = makePrisma();
    const svc = createSampleRoomService(prisma);
    const r = await svc.createItem({ name: '孤儿样卡', productAssetId: 'PA-GHOST' }, roomActor());
    expect((r as any).error.code).toBe('VALIDATION_FAILED');
    expect((r as any).error.message).toContain('数字档案');
  });

  it('listItems 返回 productAssetSku/productAssetName/productAssetCategory 摘要 join', async () => {
    const { prisma } = makePrisma({
      items: [{
        id: 'SCI-PA', code: 'SC-20260825-PA1', name: '档案联动样卡', cardType: 'fabric', status: 'in_stock',
        quantity: 5, availableQty: 5, productAssetId: 'PA-1', deletedAt: null,
      }],
      productAssets: [{ id: 'PA-1', sku: 'FAB-COTTON-TWILL', name: '棉弹力斜纹', mainCategory: 'fabric' }],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.listItems({}, roomActor());
    expect(r.ok).toBe(true);
    const item = (r as any).data.items[0];
    expect(item.productAssetSku).toBe('FAB-COTTON-TWILL');
    expect(item.productAssetName).toBe('棉弹力斜纹');
    expect(item.productAssetCategory).toBe('fabric');
  });

  it('listItems 按 productAssetId 过滤', async () => {
    const { prisma } = makePrisma({
      items: [
        { id: 'SCI-1', code: 'SC-1', name: 'A', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, productAssetId: 'PA-1', deletedAt: null },
        { id: 'SCI-2', code: 'SC-2', name: 'B', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, productAssetId: 'PA-2', deletedAt: null },
        { id: 'SCI-3', code: 'SC-3', name: 'C', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, productAssetId: 'PA-1', deletedAt: null },
      ],
      productAssets: [
        { id: 'PA-1', sku: 'SKU-1', name: '档案1', mainCategory: 'fabric' },
        { id: 'PA-2', sku: 'SKU-2', name: '档案2', mainCategory: 'fabric' },
      ],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.listItems({ productAssetId: 'PA-1' }, roomActor());
    expect(r.ok).toBe(true);
    expect((r as any).data.items).toHaveLength(2);
    expect((r as any).data.items.map((i: any) => i.id).sort()).toEqual(['SCI-1', 'SCI-3']);
    // 摘要 join 也正常返回
    expect((r as any).data.items[0].productAssetSku).toBe('SKU-1');
  });

  it('getItem 返回 productAsset 摘要', async () => {
    const { prisma } = makePrisma({
      items: [{
        id: 'SCI-D', code: 'SC-20260825-DET', name: '详情样卡', cardType: 'fabric', status: 'in_stock',
        quantity: 1, availableQty: 1, productAssetId: 'PA-1', deletedAt: null,
      }],
      productAssets: [{ id: 'PA-1', sku: 'SKU-D', name: '档案详情', mainCategory: 'fabric' }],
    });
    const svc = createSampleRoomService(prisma);
    const d = await svc.getItem('SCI-D', roomActor());
    expect(d.ok).toBe(true);
    const item = (d as any).data.item;
    expect(item.productAssetSku).toBe('SKU-D');
    expect(item.productAssetName).toBe('档案详情');
    expect(item.productAssetCategory).toBe('fabric');
  });

  it('无 productAssetId 的样卡，摘要字段为 null', async () => {
    const { prisma } = makePrisma({
      items: [{
        id: 'SCI-NULL', code: 'SC-20260825-NUL', name: '无档案样卡', cardType: 'colorcard', status: 'in_stock',
        quantity: 1, availableQty: 1, deletedAt: null,
      }],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.listItems({}, roomActor());
    expect(r.ok).toBe(true);
    const item = (r as any).data.items[0];
    expect(item.productAssetSku).toBeNull();
    expect(item.productAssetName).toBeNull();
    expect(item.productAssetCategory).toBeNull();
  });
});

describe('DR-052 §10#3 样品库存迁入对齐（样卡 ↔ 统一样品对象 Sample）', () => {
  it('createItem 带 sampleId：写入 + 审计日志记录', async () => {
    const { prisma, state } = makePrisma({
      samples: [{ id: 'SMP-1', code: 'SMP-20260907-001', type: 'pp', deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.createItem({
      name: '产前样 PP1 实物卡', cardType: 'garment',
      sampleId: 'SMP-1',
    }, roomActor('u1'));
    expect(r.ok).toBe(true);
    const item = (r as any).data.item;
    expect(item.sampleId).toBe('SMP-1');
    expect(state.items[0].sampleId).toBe('SMP-1');
    // 审计日志 detail.after 包含 sampleId
    const auditDetail = state.auditLogs[0].detail;
    expect(auditDetail.after.sampleId).toBe('SMP-1');
  });

  it('createItem sampleId 不存在（或已删除）→ VALIDATION_FAILED', async () => {
    const { prisma } = makePrisma();
    const svc = createSampleRoomService(prisma);
    const r = await svc.createItem({ name: '孤儿样卡', sampleId: 'SMP-GHOST' }, roomActor());
    expect((r as any).error.code).toBe('VALIDATION_FAILED');
    expect((r as any).error.message).toContain('样品');
  });

  it('listItems 返回 sampleCode/sampleType 摘要 join + 按 sampleId 过滤', async () => {
    const { prisma } = makePrisma({
      items: [
        { id: 'SCI-1', code: 'SC-1', name: 'A', cardType: 'garment', status: 'in_stock', quantity: 1, availableQty: 1, sampleId: 'SMP-1', deletedAt: null },
        { id: 'SCI-2', code: 'SC-2', name: 'B', cardType: 'garment', status: 'in_stock', quantity: 1, availableQty: 1, sampleId: 'SMP-2', deletedAt: null },
        { id: 'SCI-3', code: 'SC-3', name: 'C', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, deletedAt: null },
      ],
      samples: [
        { id: 'SMP-1', code: 'SMP-20260907-001', type: 'pp', deletedAt: null },
        { id: 'SMP-2', code: 'SMP-20260907-002', type: 'seal', deletedAt: null },
      ],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.listItems({ sampleId: 'SMP-1' }, roomActor());
    expect(r.ok).toBe(true);
    expect((r as any).data.items).toHaveLength(1);
    const item = (r as any).data.items[0];
    expect(item.sampleCode).toBe('SMP-20260907-001');
    expect(item.sampleType).toBe('pp');
  });

  it('listItems 支持 sampleIds 批量过滤（样品库列表实物摘要一次拉回，避免 N+1）', async () => {
    const { prisma } = makePrisma({
      items: [
        { id: 'SCI-1', code: 'SC-1', name: 'A', cardType: 'garment', status: 'in_stock', quantity: 3, availableQty: 3, sampleId: 'SMP-1', deletedAt: null },
        { id: 'SCI-2', code: 'SC-2', name: 'B', cardType: 'garment', status: 'in_stock', quantity: 1, availableQty: 1, sampleId: 'SMP-2', deletedAt: null },
        { id: 'SCI-3', code: 'SC-3', name: 'C', cardType: 'fabric', status: 'in_stock', quantity: 1, availableQty: 1, deletedAt: null },
        { id: 'SCI-4', code: 'SC-4', name: 'D', cardType: 'garment', status: 'in_stock', quantity: 2, availableQty: 2, sampleId: 'SMP-1', deletedAt: null },
      ],
      samples: [
        { id: 'SMP-1', code: 'SMP-20260907-001', type: 'pp', deletedAt: null },
        { id: 'SMP-2', code: 'SMP-20260907-002', type: 'seal', deletedAt: null },
      ],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.listItems({ sampleIds: ['SMP-1', 'SMP-2'] }, roomActor());
    expect(r.ok).toBe(true);
    const items = (r as any).data.items;
    expect(items).toHaveLength(3);
    expect(items.map((i: any) => i.sampleId).sort()).toEqual(['SMP-1', 'SMP-1', 'SMP-2']);
    // 摘要 join 仍生效
    expect(items.every((i: any) => i.sampleCode)).toBe(true);
    // 单 sampleId 过滤与批量过滤并存互不干扰
    const single = await svc.listItems({ sampleId: 'SMP-1' }, roomActor());
    expect((single as any).data.items).toHaveLength(2);
    // 显式空目标集不能放宽为全库；未传 sampleIds 仍为普通列表
    const empty = await svc.listItems({ sampleIds: [] }, roomActor());
    expect((empty as any).data.items).toHaveLength(0);
  });

  it('getItem 返回样品摘要；无 sampleId 的样卡摘要为 null', async () => {
    const { prisma } = makePrisma({
      items: [{
        id: 'SCI-D', code: 'SC-20260907-DET', name: '详情样卡', cardType: 'garment', status: 'in_stock',
        quantity: 1, availableQty: 1, sampleId: 'SMP-1', deletedAt: null,
      }],
      samples: [{ id: 'SMP-1', code: 'SMP-20260907-001', type: 'pp', deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);
    const d = await svc.getItem('SCI-D', roomActor());
    expect(d.ok).toBe(true);
    const item = (d as any).data.item;
    expect(item.sampleCode).toBe('SMP-20260907-001');
    expect(item.sampleType).toBe('pp');

    const { prisma: prisma2 } = makePrisma({
      items: [{
        id: 'SCI-N', code: 'SC-20260907-NUL', name: '无样品样卡', cardType: 'fabric', status: 'in_stock',
        quantity: 1, availableQty: 1, deletedAt: null,
      }],
    });
    const svc2 = createSampleRoomService(prisma2);
    const r = await svc2.listItems({}, roomActor());
    const noSample = (r as any).data.items[0];
    expect(noSample.sampleCode).toBeNull();
    expect(noSample.sampleType).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// DR-054 阶段 C：寄出出样（ship）+ 封样实物级
// ────────────────────────────────────────────────────────────────────
describe('DR-054 寄出出样（ship）', () => {
  it.each([undefined, null, '', 0, -1, 1.5, '1', '1.5', NaN, Infinity])('rejects invalid counted shipment quantity %j without any write', async quantity => {
    const { prisma, state } = makePrisma({ items: [{ id: 'SCI-INVALID-SHIP', code: 'SC-INVALID-SHIP', name: '数量校验', custodianUserId: 'u1',
      status: 'in_stock', quantity: 3, availableQty: 3, unit: 'PC', sealedStatus: 'unsealed', deletedAt: null }] });
    const before = structuredClone(state), loanWrite = vi.spyOn(prisma.sampleCardLoan, 'create'), itemWrite = vi.spyOn(prisma.sampleCardItem, 'update');
    const result = await createSampleRoomService(prisma).shipItem('SCI-INVALID-SHIP', { requestKey: 'room-fixture-ship-36', ...(quantity === undefined ? {} : { shipQuantity: quantity as any }), recipientName: '客户' }, roomActor('u1'));
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(state).toEqual(before); expect(loanWrite).not.toHaveBeenCalled(); expect(itemWrite).not.toHaveBeenCalled();
  });

  it('寄出扣减 availableQty；全部寄出 → shipped 终态归档，留 ship 流水', async () => {
    const { prisma } = makePrisma({ items: [{ id: 'SCI-1', code: 'SC-1', name: '样卡A', status: 'in_stock', quantity: 2, availableQty: 2, sealedStatus: 'unsealed', deletedAt: null }] });
    const svc = createSampleRoomService(prisma);
    const r = await svc.shipItem('SCI-1', { requestKey: 'room-fixture-ship-37', shipQuantity: 2, recipientName: 'Client X' }, roomActor('u1'));
    expect(r.ok).toBe(true);
    expect((r as any).data.archived).toBe(true);
    expect((r as any).data.item.status).toBe('shipped');
    expect((r as any).data.item.availableQty).toBe(0);
    const loan = (r as any).data.loan;
    expect(loan.loanType).toBe('ship');
    expect(loan.returnedAt).toBeTruthy();
  });

  it('部分寄出 → 仍 in_stock；寄出超过可用 → INSUFFICIENT_QTY 409；已归档不可再寄', async () => {
    const { prisma } = makePrisma({ items: [{ id: 'SCI-1', code: 'SC-1', name: '样卡A', status: 'in_stock', quantity: 3, availableQty: 3, sealedStatus: 'unsealed', deletedAt: null }] });
    const svc = createSampleRoomService(prisma);
    const r1 = await svc.shipItem('SCI-1', { requestKey: 'room-fixture-ship-38', shipQuantity: 1, recipientName: 'A' }, roomActor('u1'));
    expect(r1.ok).toBe(true);
    expect((r1 as any).data.archived).toBe(false);
    expect((r1 as any).data.item.status).toBe('in_stock');
    const r2 = await svc.shipItem('SCI-1', { requestKey: 'room-fixture-ship-39', shipQuantity: 5, recipientName: 'B' }, roomActor('u1'));
    expect(r2.ok).toBe(false);
    expect((r2 as any).error.code).toBe('INSUFFICIENT_QTY');
    const r3 = await svc.shipItem('SCI-1', { requestKey: 'room-fixture-ship-40', shipQuantity: 2, recipientName: 'C' }, roomActor('u1'));
    expect(r3.ok).toBe(true);
    expect((r3 as any).data.archived).toBe(true);
    const r4 = await svc.shipItem('SCI-1', { requestKey: 'room-fixture-ship-41', shipQuantity: 1, recipientName: 'D' }, roomActor('u1'));
    expect(r4.ok).toBe(false);
    expect((r4 as any).error.code).toBe('ITEM_SHIPPED');
  });

  it('recipientName 必填（非退役卡）；退役样卡不可寄出', async () => {
    const { prisma } = makePrisma({ items: [{ id: 'SCI-1', code: 'SC-1', name: '样卡A', status: 'in_stock', quantity: 1, availableQty: 1, sealedStatus: 'unsealed', deletedAt: null }] });
    const svc = createSampleRoomService(prisma);
    const r1 = await svc.shipItem('SCI-1', { requestKey: 'room-fixture-ship-42', shipQuantity: 1, recipientName: '' }, roomActor('u1'));
    expect(r1.ok).toBe(false);
    expect((r1 as any).error.code).toBe('VALIDATION_FAILED');
    const { prisma: prisma2 } = makePrisma({ items: [{ id: 'SCI-2', code: 'SC-2', name: '样卡B', status: 'retired', quantity: 1, availableQty: 1, sealedStatus: 'unsealed', deletedAt: null }] });
    const svc2 = createSampleRoomService(prisma2);
    const r2 = await svc2.shipItem('SCI-2', { requestKey: 'room-fixture-ship-43', shipQuantity: 1, recipientName: 'X' }, roomActor('u1'));
    expect(r2.ok).toBe(false);
    expect((r2 as any).error.code).toBe('ITEM_RETIRED');
  });
});

describe('DR-054 封样 = 实物级 tag（标准批次 reference）', () => {
  it('封样记录 standardBatchNo + sealed 状态；换 batch no 不新建样卡（reference 属性）', async () => {
    const { prisma } = makePrisma({ items: [{ id: 'SCI-1', code: 'SC-1', name: '样卡A', status: 'in_stock', quantity: 1, availableQty: 1, sealedStatus: 'unsealed', deletedAt: null }] });
    const svc = createSampleRoomService(prisma);
    const r = await svc.sealCard('SCI-1', { standardBatchNo: 'BATCH-001' }, roomActor('u1'));
    expect(r.ok).toBe(true);
    expect((r as any).data.item.sealedStatus).toBe('sealed');
    expect((r as any).data.item.standardBatchNo).toBe('BATCH-001');
  });

  it('2c 联动：实物卡挂打样批次(batchId)时，封样标准批次号自动取该批次 batchCode（到手填空时）', async () => {
    const { prisma } = makePrisma({
      items: [{ id: 'SCI-1', code: 'SC-1', name: '样卡A', status: 'in_stock', quantity: 1, availableQty: 1, sealedStatus: 'unsealed', batchId: 'SB-9', deletedAt: null }],
      // The real batch model has a live parent and version, unlike the old
      // batchCode-only test double. Product validation is not weakened for it.
      devCases: [{ id: 'DC-9', type: 'fabric', deletedAt: null }],
      batches: [{ id: 'SB-9', batchCode: 'SB-9-001', developmentCaseId: 'DC-9', round: 1, updatedAt: 1, deletedAt: null }],
    });
    const svc = createSampleRoomService(prisma);
    const r = await svc.sealCard('SCI-1', {}, roomActor('u1'));
    expect(r.ok).toBe(true);
    expect((r as any).data.item.standardBatchNo).toBe('SB-9-001');
  });

  it('已封样不可重复封样（409）；寄出归档不可封样（409）', async () => {
    const { prisma } = makePrisma({ items: [{ id: 'SCI-1', code: 'SC-1', name: '样卡A', status: 'in_stock', quantity: 1, availableQty: 1, sealedStatus: 'sealed', sealedAt: 1, sealedBy: 'u1', standardBatchNo: 'B1', deletedAt: null }] });
    const svc = createSampleRoomService(prisma);
    const r1 = await svc.sealCard('SCI-1', { standardBatchNo: 'B2' }, roomActor('u1'));
    expect(r1.ok).toBe(false);
    expect((r1 as any).error.code).toBe('ALREADY_SEALED');
    const { prisma: prisma2 } = makePrisma({ items: [{ id: 'SCI-2', code: 'SC-2', name: '样卡B', status: 'shipped', quantity: 0, availableQty: 0, sealedStatus: 'unsealed', deletedAt: null }] });
    const svc2 = createSampleRoomService(prisma2);
    const r2 = await svc2.sealCard('SCI-2', { standardBatchNo: 'B3' }, roomActor('u1'));
    expect(r2.ok).toBe(false);
    expect((r2 as any).error.code).toBe('ITEM_SHIPPED');
  });
});


describe('V3 native physical receipts integrate with authorized custody', () => {
  const sample={id:'NATIVE-SAMPLE',type:'pp',sourceCaseId:null,sourceOrderId:null,productAssetId:null,deletedAt:null};
  it('manual native inventory is refused after actual sample lock with no card or audit write',async()=>{
    const {prisma,state}=makePrisma({samples:[sample]});
    prisma.orderSampleSource.findUnique.mockImplementation(async()=>{expect(prisma.$queryRaw.mock.calls.some(([q]:any[])=>q.sql.includes('FROM "Sample"')&&q.values[0]===sample.id)).toBe(true);return{id:'NATIVE-SOURCE'};});
    expect(await createSampleRoomService(prisma).createItem({name:'Bypass',sampleId:sample.id},roomActor())).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});
    expect(state.items).toHaveLength(0);expect(state.auditLogs).toHaveLength(0);
  });
  it.each(['missing','sql'])('native lookup %s never downgrades into manual inventory',async mode=>{
    const {prisma,state}=makePrisma({samples:[sample]});
    if(mode==='missing')delete prisma.orderSampleSource;else prisma.orderSampleSource.findUnique.mockRejectedValue(new Error('storage unavailable'));
    expect(await createSampleRoomService(prisma).createItem({name:'Bypass',sampleId:sample.id},roomActor())).toMatchObject({ok:false,error:{code:'INTERNAL_ERROR',status:500}});expect(state.items).toHaveLength(0);expect(state.auditLogs).toHaveLength(0);
  });
  it('SC allocation uses shared lock and skips occupied non-contiguous code',async()=>{
    const prefix=`SC-${new Date().toISOString().slice(0,10).replace(/-/g,'')}`;
    const {prisma}=makePrisma({items:[{id:'occupied',code:prefix+'-002',quantity:1,availableQty:1,status:'in_stock',deletedAt:null}]});
    const result=await createSampleRoomService(prisma).createItem({name:'Manual'},roomActor());expect(result).toMatchObject({ok:true,data:{item:{code:prefix+'-003'}}});expect(prisma.$queryRaw.mock.calls.some(([q]:any[])=>q.sql.includes("hashtext('sample-room-received-code')"))).toBe(true);
  });
  it.each(['valid','proof','sql','mismatch'])('visible native receipt %s is verified only by actual receipt reader',async mode=>{
    const card={id:'V3-CARD',code:'SC-V3',sampleId:sample.id,cardType:'garment',status:'in_stock',quantity:1,availableQty:1,deletedAt:null,receiptSnapshot:{version:3,kind:'order-native',source:{sourceId:'NATIVE-SOURCE',family:'garment_pp'}}};
    const {prisma}=makePrisma({samples:[sample],items:[card]});prisma.orderSampleSource.findUnique.mockResolvedValue({id:mode==='mismatch'?'OTHER':'NATIVE-SOURCE'});
    const loader=vi.spyOn(nativeReceipt,'loadOrderSamplePhysicalReceipt');if(mode==='proof')loader.mockRejectedValue(new OrderSampleRecordError('invalid proof'));else if(mode==='sql')loader.mockRejectedValue(new Error('storage fault'));else loader.mockResolvedValue({cardId:card.id} as any);
    try{const result=await createSampleRoomService(prisma).getItem(card.id,roomActor());if(mode==='sql')expect(result).toMatchObject({ok:false,error:{code:'INTERNAL_ERROR',status:500}});else expect(result).toMatchObject({ok:true,data:{item:{receiptStatus:mode==='valid'?'verified':'legacyUnverified'}}});if(mode==='mismatch')expect(loader).not.toHaveBeenCalled();}finally{loader.mockRestore();}
  });
});


describe('sample library manual registration and private facets',()=>{
 const metadata=(extras:any={})=>({version:1,purpose:'reference',sampleKind:'reference',sourceType:'purchased',category:'梭织',colorFamily:'蓝色',weightGsm:180,tags:['春夏'],...extras});
 it('scoped creator registers own internal physical card, stable retry never doubles count, different payload conflicts',async()=>{
  const {prisma,state}=custodyFixture();const svc=createSampleRoomService(prisma);
  const input={name:'采购参考布',cardType:'fabric',quantity:2,unit:'PC',libraryMetadata:metadata(),clientRequestId:'same-request'};
  const first:any=await svc.createItem(input,roomActor());expect(first).toMatchObject({ok:true,data:{created:true,item:{custodianUserId:'ROOM-ACTOR',quantity:2}}});
  const retry=await svc.createItem(input,roomActor());expect(retry).toMatchObject({ok:true,data:{created:false,item:{id:first.data.item.id}}});
  expect(state.items.filter(row=>row.name==='采购参考布')).toHaveLength(1);
  expect(await svc.createItem({...input,name:'Different'},roomActor())).toMatchObject({ok:false,error:{code:'REGISTRATION_CONFLICT'}});
  expect(await svc.getItem(first.data.item.id,roomActor())).toMatchObject({ok:true});
  state.users.push({...state.users[0],id:'OTHER-STAFF'});
  expect(await svc.getItem(first.data.item.id,roomActor('OTHER-STAFF'))).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 });
 it('manual customer is authorized and source-linked card never acquires custodian bypass',async()=>{
  const {prisma,state}=custodyFixture();const svc=createSampleRoomService(prisma);
  expect(await svc.createItem({name:'Foreign',customerRelationId:'FOREIGN'},roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
  const r:any=await svc.createItem({name:'Own',customerRelationId:'OWN'},roomActor());
  expect(r).toMatchObject({ok:true,data:{item:{customerRelationId:'OWN',custodianUserId:null}}});
  const sourced:any=await svc.createItem({name:'Sourced',orderId:'OWN-ORDER'},roomActor());expect(sourced).toMatchObject({ok:true,data:{item:{custodianUserId:null}}});
  state.orders[0].customerRelationId='FOREIGN';expect(await svc.getItem(sourced.data.item.id,roomActor())).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 });
 it('metadata update accepts descriptive properties, rejects stock/source writes and preserves receipt',async()=>{
  const {prisma,state}=custodyFixture();const svc=createSampleRoomService(prisma),original=structuredClone(state.items[0]);
  expect(await svc.updateLibrary('CUSTODY-CARD',{quantity:20},roomActor())).toMatchObject({ok:false,error:{code:'VALIDATION_FAILED'}});
  expect(await svc.updateLibrary('CUSTODY-CARD',{name:'New',libraryMetadata:metadata(),locationDetail:{shelf:'A',level:'2'}},roomActor())).toMatchObject({ok:true,data:{item:{name:'New',libraryMetadata:{sampleKind:'reference'}}}});
  expect(state.items[0].quantity).toBe(original.quantity);expect(state.items[0].receiptSnapshot).toEqual(original.receiptSnapshot);expect(state.items[0].orderId).toBe(original.orderId);
 });
 it('preserves and filters custom physical categories and sample forms',async()=>{
  const {prisma}=custodyFixture(),svc=createSampleRoomService(prisma);
  const result:any=await svc.createItem({name:'定制挂钩样',cardType:'custom-fabric-hook',quantity:2,unit:'份',libraryMetadata:metadata({purpose:'other',sampleKind:'custom-hook-card',category:'特殊针织'})},roomActor());
  expect(result).toMatchObject({ok:true,data:{item:{cardType:'custom-fabric-hook',libraryMetadata:{purpose:'other',sampleKind:'custom-hook-card',category:'特殊针织'}}}});
  expect(await svc.listItems({cardType:'custom-fabric-hook'},roomActor())).toMatchObject({ok:true,data:{items:[{cardType:'custom-fabric-hook'}]}});
  expect(await svc.listCustodyDirectory({lane:'other',cardType:'custom-fabric-hook'},roomActor())).toMatchObject({ok:true,data:{total:1,items:[{card:{cardType:'custom-fabric-hook'}}]}});
 });
 it('generic library editing cannot productize a development version outside the formal QC conversion gate',async()=>{
  const {prisma,state}=custodyFixture();
  state.devCases.push({id:'DEV-CARD',type:'fabric',customerRelationId:'OWN',supplierRelationId:'FOREIGN',deletedAt:null});
  state.batches.push({id:'DEV-BATCH',developmentCaseId:'DEV-CARD',supplierRelationId:'FOREIGN',round:1,sampleType:'lab-dip',sampleVersionId:'VERSION-1',deletedAt:null});
  state.productAssets.push({id:'FABRIC-ASSET',mainCategory:'Fabric',deletedAt:null});
  Object.assign(state.items[0],{devCaseId:'DEV-CARD',batchId:'DEV-BATCH',orderId:null});
  const before=structuredClone(state),result=await createSampleRoomService(prisma).updateLibrary('CUSTODY-CARD',{productAssetId:'FABRIC-ASSET'},roomActor());
  expect(result).toMatchObject({ok:false,error:{code:'CONFLICT',status:409}});
  expect(state.items[0].productAssetId).toBeNull();expect(state.auditLogs).toEqual(before.auditLogs);
 });
 it('facets include complete full authorized lane, exclude catalog secrets, and apply multi dimensions before pagination',async()=>{
  const {prisma,state}=custodyFixture();const base=state.items[0];base.libraryMetadata=metadata();
  state.items.push({...base,id:'SECOND',code:'SC-SECOND',name:'Second',libraryMetadata:metadata({colorFamily:'红色',weightGsm:250}),createdAt:BigInt(20)}, {...base,id:'THIRD',code:'SC-THIRD',name:'Third',libraryMetadata:metadata({colorFamily:'蓝色',weightGsm:200}),createdAt:BigInt(30)}, {...base,id:'CATALOG',code:'SC-CATALOG',name:'Secret',sampleId:null,devCaseId:null,orderId:null,batchId:null,customerRelationId:null,custodianUserId:null,receiptSnapshot:null,libraryMetadata:metadata({category:'SECRET-CATEGORY'})});
  const r:any=await createSampleRoomService(prisma).listCustodyDirectory({lane:'fabric',filter:JSON.stringify({colorFamily:['蓝色','红色'],weightMin:190}),sort:'oldest',limit:1,offset:1},roomActor());
  expect(r).toMatchObject({ok:true,data:{total:2,items:[{card:{id:'THIRD'}}],criteria:{weightMin:190}}});
  expect(r.data.facets.colorFamily.map((row:any)=>[row.value,row.count]).sort()).toEqual([['红色',1],['蓝色',2]].sort());
  expect(JSON.stringify(r.data.facets)).not.toContain('SECRET-CATEGORY');expect(r.data.facets.customerRelationId).toHaveLength(1);
 });
});


describe('manual sample free location and decimal meter receipt', () => {
  const yardageMetadata = {version:1,purpose:'sales',sampleKind:'sales_stock_yardage',sourceType:'internal',tags:[]};
  it('creates fractional meters, reads exact length by form under the shared product, and retries without double stock', async () => {
    const {prisma,state}=makePrisma({productAssets:[{id:'PA-METERS',name:'棉布',sku:'FAB-M',mainCategory:'Fabric',deletedAt:null}]});
    const svc=createSampleRoomService(prisma);
    const input={name:'半米留样',cardType:'fabric',quantity:1,unit:'米',physicalLengthQty:'0.1250',location:'办公室挂杆旁',productAssetId:'PA-METERS',libraryMetadata:yardageMetadata,clientRequestId:'decimal-manual'};
    const result:any=await svc.createItem(input,roomActor('u1'));
    expect(result).toMatchObject({ok:true,data:{item:{physicalLengthQty:'0.125',availableLengthQty:'0.125',quantity:1,location:'办公室挂杆旁'}}});
    expect(await svc.createItem(input,roomActor('u1'))).toMatchObject({ok:true,data:{created:false}});
    expect(state.items).toHaveLength(1);
    const cards:any=await svc.createItem({name:'同款样卡',cardType:'fabric',quantity:3,unit:'份',productAssetId:'PA-METERS',libraryMetadata:{...yardageMetadata,sampleKind:'sales_card'}},roomActor('u1'));
    expect(cards.ok).toBe(true);
    const read:any=await svc.listCustodyDirectory({lane:'fabric'},roomActor('u1'));
    expect(read.ok).toBe(true);
    expect(read.data.items).toHaveLength(1);
    expect(read.data.items[0].archive.forms).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'库存米样',unit:'米',total:'0.125',available:'0.125'}),
      expect.objectContaining({kind:'样卡',unit:'份',total:'3',available:'3'}),
    ]));
    expect((await svc.getItem(result.data.item.id,roomActor('u1')) as any).data.item.physicalLengthQty).toBe('0.125');
  });
  it.each(['', '0', '-1', '0.00001', 'NaN', '1e2', '100000000000000'])('rejects invalid meter length %s without writing stock',async length=>{
    const {prisma,state}=makePrisma();
    expect(await createSampleRoomService(prisma).createItem({name:'米样',cardType:'fabric',quantity:1,unit:'米',physicalLengthQty:length,libraryMetadata:yardageMetadata},roomActor('u1'))).toMatchObject({ok:false,error:{code:'VALIDATION_FAILED'}});
    expect(state.items).toHaveLength(0);
  });
  it('rejects counted yardage without an actual length or lengths on garment stock',async()=>{
    const {prisma}=makePrisma(),svc=createSampleRoomService(prisma);
    expect(await svc.createItem({name:'米样',cardType:'fabric',quantity:4,unit:'PC',libraryMetadata:yardageMetadata},roomActor('u1'))).toMatchObject({ok:false,error:{code:'VALIDATION_FAILED'}});
    expect(await svc.createItem({name:'衣服',cardType:'garment',quantity:1,unit:'PC',physicalLengthQty:'1.25'},roomActor('u1'))).toMatchObject({ok:false,error:{code:'VALIDATION_FAILED'}});
  });
  it('retains old structured addresses until free-text editing, records both positions, and rejects stock editing',async()=>{
    const {prisma,state}=custodyFixture(),svc=createSampleRoomService(prisma);
    state.items[0].location=null;state.items[0].locationDetail={zone:'旧样品间',shelf:'A',level:'2',bin:null};
    expect((await svc.getItem('CUSTODY-CARD',roomActor()) as any).data.item.locationDetail).toMatchObject({shelf:'A'});
    expect(await svc.updateLibrary('CUSTODY-CARD',{location:'北墙挂杆旁'},roomActor())).toMatchObject({ok:true,data:{item:{location:'北墙挂杆旁',locationDetail:null}}});
    expect(state.auditLogs.at(-1)).toMatchObject({detail:{before:{location:null,locationDetail:{shelf:'A'}},after:{location:'北墙挂杆旁',locationDetail:null}}});
    expect(await svc.updateLibrary('CUSTODY-CARD',{physicalLengthQty:'99'},roomActor())).toMatchObject({ok:false,error:{code:'VALIDATION_FAILED'}});
  });
});

describe('counted fabric portion returns',()=>{
 function setup(){const {prisma,state}=makePrisma({items:[{id:'COUNTED',code:'SC-COUNTED',name:'色样',custodianUserId:'u1',unit:'份',status:'borrowed',quantity:3,availableQty:0,deletedAt:null}],
  loans:[{id:'LOAN-COUNTED',itemId:'COUNTED',loanType:'borrow',loanQuantity:3,loanedAt:10,returnedAt:null,operatorId:'u1'}]});return {prisma,state,svc:createSampleRoomService(prisma)};}
 it('returns one loan in portions, appends each event, replays safely, and rejects cumulative over-return',async()=>{
  const {svc,state}=setup(),part={returnQuantity:1,requestKey:'return-count-1',conditionNote:'完好'};
  expect(await svc.returnLoan('LOAN-COUNTED',part,roomActor('u1'))).toMatchObject({ok:true,data:{loan:{returnedAt:null,returnedQuantity:1,outstandingQuantity:2},item:{quantity:3,availableQty:1,status:'in_stock'}}});
  expect(await svc.returnLoan('LOAN-COUNTED',part,roomActor('u1'))).toMatchObject({ok:true,data:{replayed:true,item:{availableQty:1}}});
  expect(await svc.returnLoan('LOAN-COUNTED',{returnQuantity:1,requestKey:'return-count-2'},roomActor('u1'))).toMatchObject({ok:true,data:{loan:{returnedQuantity:2,outstandingQuantity:1},item:{availableQty:2}}});
  expect(await svc.returnLoan('LOAN-COUNTED',{returnQuantity:2,requestKey:'return-count-over'},roomActor('u1'))).toMatchObject({ok:false,error:{code:'EXCESS_RETURN',status:409}});
  expect(state.loans[0].lengthReturnHistory).toHaveLength(2);expect(state.loans[0].lengthReturnHistory).toEqual(expect.arrayContaining([expect.objectContaining({quantity:1,operatorId:'u1'})]));
 });
});

describe('Decimal meter custody commands',()=>{
 function setup(){const {prisma,state}=makePrisma({items:[{id:'METER',code:'SC-M',name:'米样',custodianUserId:'u1',unit:'米',status:'in_stock',quantity:1,availableQty:1,physicalLengthQty:'2.5',availableLengthQty:'2.5',deletedAt:null}]});return {prisma,state,svc:createSampleRoomService(prisma)};}
 const borrow={loanType:'borrow',loanLength:'1.25',borrowerName:'同事',dueAt:2000000000000,requestKey:'borrow-one'};
 it('debits exact meters once, rejects reused keys with changed content and holds card/request locks',async()=>{
  const {svc,state,prisma}=setup();const first:any=await svc.createLoan('METER',borrow,roomActor('u1'));expect(first).toMatchObject({ok:true,data:{loan:{loanQuantity:0,loanLength:'1.25'},item:{availableLengthQty:'1.25'}}});
  expect(await svc.createLoan('METER',borrow,roomActor('u1'))).toMatchObject({ok:true,data:{replayed:true}});expect(state.loans).toHaveLength(1);
  expect(await svc.createLoan('METER',{...borrow,loanLength:'1'},roomActor('u1'))).toMatchObject({ok:false,error:{code:'REQUEST_CONFLICT'}});
  const locks=prisma.$queryRaw.mock.calls.map(([q]:any)=>q.sql);expect(locks.some((s:string)=>s.includes('SampleCardItem')&&s.includes('FOR UPDATE'))).toBe(true);expect(locks.some((s:string)=>s.includes('pg_advisory_xact_lock'))).toBe(true);
 });
 it('returns portions from original loan with append-only history and replay after final return',async()=>{
  const {svc,state}=setup();const first:any=await svc.createLoan('METER',borrow,roomActor('u1')),id=first.data.loan.id;
  const part={returnLength:'0.1',requestKey:'return-first',conditionNote:'完好'};
  expect(await svc.returnLoan(id,part,roomActor('u1'))).toMatchObject({ok:true,data:{loan:{returnedLengthQty:'0.1',returnedAt:null},item:{availableLengthQty:'1.35'}}});
  expect(await svc.returnLoan(id,part,roomActor('u1'))).toMatchObject({ok:true,data:{replayed:true}});expect(state.loans[0].lengthReturnHistory).toHaveLength(1);
  expect(await svc.returnLoan(id,{...part,returnLength:'0.2'},roomActor('u1'))).toMatchObject({ok:false,error:{code:'REQUEST_CONFLICT'}});
  const rest={returnLength:'1.15',requestKey:'return-rest'};expect(await svc.returnLoan(id,rest,roomActor('u1'))).toMatchObject({ok:true,data:{loan:{returnedLengthQty:'1.25',returnedAt:expect.any(Number)},item:{availableLengthQty:'2.5'}}});
  expect(await svc.returnLoan(id,rest,roomActor('u1'))).toMatchObject({ok:true,data:{replayed:true}});expect(state.loans[0].lengthReturnHistory).toHaveLength(2);expect(state.loans[0].lengthReturnHistory[0]).toMatchObject({operatorId:'u1',length:'0.1',returnedAt:expect.any(String)});
 });
 it('ships fractions without touching outstanding loan meters and replays after terminal archive',async()=>{
  const {svc,state}=setup();await svc.createLoan('METER',borrow,roomActor('u1'));const ship={shipLength:'0.25',recipientName:'客户',requestKey:'ship-one'};
  expect(await svc.shipItem('METER',ship,roomActor('u1'))).toMatchObject({ok:true,data:{item:{physicalLengthQty:'2.25',availableLengthQty:'1'}}});
  expect(await svc.shipItem('METER',ship,roomActor('u1'))).toMatchObject({ok:true,data:{replayed:true}});expect(state.loans).toHaveLength(2);
  expect(await svc.shipItem('METER',{...ship,shipLength:'1.01',requestKey:'over'},roomActor('u1'))).toMatchObject({ok:false,error:{code:'INSUFFICIENT_LENGTH'}});
  const other=setup(),all={shipLength:'2.5',recipientName:'客户',requestKey:'all'};expect(await other.svc.shipItem('METER',all,roomActor('u1'))).toMatchObject({ok:true,data:{archived:true,item:{status:'shipped'}}});expect(await other.svc.shipItem('METER',all,roomActor('u1'))).toMatchObject({ok:true,data:{replayed:true}});expect(other.state.loans).toHaveLength(1);
 });
 it('rejects integer paths, excess precision, over-return and unauthorized writes; active meter loans block retirement',async()=>{
  const {svc,state}=setup();for(const bad of [{...borrow,loanQuantity:1},{...borrow,requestKey:undefined},{...borrow,loanLength:'0.00001'}])expect(await svc.createLoan('METER',bad,roomActor('u1'))).toMatchObject({ok:false});
  expect(await svc.createLoan('METER',borrow,{...roomActor('u2'),permissionCeiling:[]})).toMatchObject({ok:false});const r:any=await svc.createLoan('METER',borrow,roomActor('u1'));
  expect(await svc.returnLoan(r.data.loan.id,'旧整件归还',roomActor('u1'))).toMatchObject({ok:false});expect(await svc.returnLoan(r.data.loan.id,{returnLength:'1.2501',requestKey:'over'},roomActor('u1'))).toMatchObject({ok:false,error:{code:'EXCESS_RETURN'}});
  expect(await svc.retireItem('METER','',roomActor('u1'))).toMatchObject({ok:false,error:{code:'ITEM_NOT_BORROWABLE'}});expect(state.items[0].availableLengthQty).toBe('1.25');
 });
 it('serial transaction fixture prevents competing borrow and ship from overdrawing (not native PG concurrency)',async()=>{
  const {svc,state,prisma}=setup(),native=prisma.$transaction.getMockImplementation();let queue=Promise.resolve();prisma.$transaction.mockImplementation((fn:any)=>{const result=queue.then(()=>native(fn));queue=result.then(()=>{},()=>{});return result;});
  const results=await Promise.all([svc.createLoan('METER',{...borrow,loanLength:'2'},roomActor('u1')),svc.shipItem('METER',{shipLength:'1',recipientName:'客户',requestKey:'compete'},roomActor('u1'))]);expect(results.filter(r=>r.ok)).toHaveLength(1);expect(state.items[0].availableLengthQty).toBe('0.5');expect(state.loans).toHaveLength(1);
 });
 it('serial fixture collapses concurrent duplicate borrow and rejects competing excess partial returns',async()=>{
  const {svc,state,prisma}=setup(),native=prisma.$transaction.getMockImplementation();let queue=Promise.resolve();prisma.$transaction.mockImplementation((fn:any)=>{const result=queue.then(()=>native(fn));queue=result.then(()=>{},()=>{});return result;});
  const borrowed:any[]=await Promise.all([svc.createLoan('METER',borrow,roomActor('u1')),svc.createLoan('METER',borrow,roomActor('u1'))]);expect(borrowed.every(r=>r.ok)).toBe(true);expect(borrowed[1].data.replayed).toBe(true);expect(state.loans).toHaveLength(1);
  const returned=await Promise.all(['first','second'].map(requestKey=>svc.returnLoan(state.loans[0].id,{returnLength:'0.75',requestKey},roomActor('u1'))));expect(returned.filter(r=>r.ok)).toHaveLength(1);expect(state.items[0].availableLengthQty).toBe('2');expect(state.loans[0].lengthReturnHistory).toHaveLength(1);
 });
 it('HTTP preserves Decimal strings and request keys through borrowing, partial return and shipping',async()=>{
  const {prisma,state}=setup(),app=express();app.use(express.json());app.use('/api/v1/samples',createSampleRouter({prisma,requireAuth:true,apiKeys:new Set()}));
  const token=jwt.sign({userId:'u1',roles:['viewer'],permissions:['products:read','sample:room:write'],departmentIds:[]},process.env.JWT_SECRET!);const auth=`Bearer ${token}`;
  const loan=await request(app).post('/api/v1/samples/room/items/METER/loans').set('Authorization',auth).send(borrow);expect(loan.status).toBe(201);expect(state.loans[0].loanLength).toBe('1.25');
  const returned=await request(app).post(`/api/v1/samples/room/loans/${state.loans[0].id}/return`).set('Authorization',auth).send({returnLength:'0.1250',requestKey:'http-return'});expect(returned.status).toBe(200);expect(state.items[0].availableLengthQty).toBe('1.375');
  const ship=await request(app).post('/api/v1/samples/room/items/METER/ship').set('Authorization',auth).send({shipLength:'0.0001',requestKey:'http-ship',recipientName:'客户'});expect(ship.status).toBe(201);expect(state.items[0].availableLengthQty).toBe('1.3749');
 });
 it('rolls back stock and request receipt when audit persistence fails, allowing safe retry',async()=>{
  const {svc,state,prisma}=setup(),native=prisma.auditLog.create;prisma.auditLog.create=async()=>{throw new Error('audit down');};expect(await svc.createLoan('METER',borrow,roomActor('u1'))).toMatchObject({ok:false});expect(state.items[0].availableLengthQty).toBe('2.5');expect(state.loans).toHaveLength(0);prisma.auditLog.create=native;expect(await svc.createLoan('METER',borrow,roomActor('u1'))).toMatchObject({ok:true});expect(state.loans).toHaveLength(1);
 });
});


describe('new development incoming physical registrations respect lifecycle', () => {
  it.each(['closed', 'paused'])('blocks new registration after %s but returns the exact original without stock/audit duplication', async lifecycleState => {
    const {prisma,state} = makePrisma({devCases:[{id:'INCOMING-D',type:'garment',ownerId:'ROOM-ACTOR',deletedAt:null}]});
    let lifecycle: any = null;
    prisma.developmentLifecycleEvent.findFirst = async () => lifecycle;
    const service = createSampleRoomService(prisma);
    const input = {name:'真实客户来样',cardType:'garment',quantity:1,unit:'PC',devCaseId:'INCOMING-D',clientRequestId:'incoming-original'};
    const original: any = await service.createItem(input,roomActor());
    expect(original).toMatchObject({ok:true,data:{created:true}});
    lifecycle = {state:lifecycleState,revision:1};
    const snapshot = structuredClone(state);
    expect(await service.createItem(input,roomActor())).toMatchObject({ok:true,data:{created:false,item:{id:original.data.item.id}}});
    expect(state).toEqual(snapshot);
    expect(await service.createItem({...input,clientRequestId:'incoming-new'},roomActor())).toMatchObject({ok:false,error:{code:lifecycleState==='closed'?'DEVELOPMENT_CLOSED':'DEVELOPMENT_PAUSED'}});
    expect(state).toEqual(snapshot);
    expect(await service.createItem({...input,name:'变更原来样'},roomActor())).toMatchObject({ok:false,error:{code:'REGISTRATION_CONFLICT'}});
  });
});
