import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createProcurementDemandService, createDemandsFromBOM, demandDecimal } from '../procurementDemandService';
import { validatePurchaseLines, createProcurementService } from '../procurementService';
vi.mock('../procurementService', async original => ({ ...await original<any>(), createProcurementService: vi.fn() }));
// Domain regression fixture: fresh authorization itself is covered separately
// with real service execution in supplierDemandLifecycle.test.ts.
vi.mock('../supplierContractAccess', () => ({ freshSupplierActor: vi.fn(async (_tx, actor) => actor),
  authorizeSupplierSources: vi.fn(async (_tx, actor, ids) => ({ actor, sources: ids.map(id => ({ orderId:'O1',orderLineId:id })) })) }));
vi.mock('../../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({})) }));

function fixture() {
  const d: any = { id: 'D1', sourceKey: 'manual1', orderId: 'O1', orderLineId: null, description: '布料', unit: 'M', status: 'NeedsConfirmation', requiredQuantity: null, assigneeId: null, revision: 1, createdAt: 1n, updatedAt: 1n };
  const allocations: any[] = [];
  const pos: any[] = [];
  const tx: any = {
    procurementDemand: {
      findUnique: vi.fn(async () => d), findMany: vi.fn(async () => [d]), count: vi.fn(async () => 1),
      update: vi.fn(async ({data}) => { const {revision, ...rest} = data; Object.assign(d, rest); if(revision) d.revision++; return d; }),
      upsert: vi.fn(async ({create}) => create),
    },
    purchaseDemandAllocation: {
      findMany: vi.fn(async () => allocations), count: vi.fn(async () => allocations.filter(a => a.status === 'Active').length),
      findUnique: vi.fn(async ({where}) => allocations.find(a => a.requestKey === where.requestKey)),
      aggregate: vi.fn(async () => ({ _sum: { quantity: allocations.filter(a => a.status === 'Active').reduce((s,a)=>s.plus(a.quantity),new Prisma.Decimal(0)) } })),
      create: vi.fn(async ({data}) => { const a = {...data,status:'Active'}; allocations.push(a); return a; }),
    },
    purchaseOrder: { findMany: vi.fn(async () => pos), findUnique: vi.fn(async ({where}) => pos.find(p=>p.id===where.id)) },
    orderLine: { findMany:vi.fn(async()=>[{id:'OL1',orderId:'O1'}]), findUnique: vi.fn(async ({where}) => where.id === 'OL1' ? {id:'OL1',orderId:'O1'} : {id:where.id, orderId:'O2'}) },
    order: { findMany:vi.fn(async()=>[{id:'O1'}]), findUnique: vi.fn(async () => ({id:'O1',deletedAt:null})) },
    factoryProfile: { findUnique: vi.fn(async () => ({deletedAt:null, blacklistedAt:null})) },
    relation: { findUnique: vi.fn(async ({where}) => ({id:where.id,name:where.id,deletedAt:null})) },
    userAccount: { findUnique: vi.fn(async()=>({displayName:'采购测试员'})) },
    auditLog: { create: vi.fn(async () => ({})) },
    bOM: { findUnique: vi.fn() },
    $queryRaw:vi.fn(async()=>[{id:'locked'}]),
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async fn => fn(tx)) };
  const createPO = vi.fn(async input => { const po={id:`PO${pos.length+1}`,poNumber:`PO-${pos.length+1}`,supplierName:input.supplierName,lines:[{id:`PL${pos.length+1}`}]};pos.push(po);return po; });
  vi.mocked(createProcurementService).mockReturnValue({createPurchaseOrder:createPO} as any);
  const raw=createProcurementDemandService(prisma), actor=(userId:string)=>({userId,roles:['sales'] as const,permissions:['procurement:read','procurement:write'],departmentIds:[]});
  const trustedActor=(userId:string)=>({...actor(userId),roles:['sales'] as ('sales')[]});
  const service={...raw,
    list:(visible:string[]|null,actorId:string,opts={})=>raw.list(visible,actorId,opts,trustedActor(actorId)),
    create:(input:any,actorId:string,visible:string[]|null)=>raw.create(input,actorId,visible,trustedActor(actorId)),
    claim:(id:string,revision:unknown,actorId:string,visible:string[]|null)=>raw.claim(id,revision,actorId,visible,trustedActor(actorId)),
    confirm:(id:string,input:any,actorId:string,visible:string[]|null)=>raw.confirm(id,input,actorId,visible,trustedActor(actorId)),
    release:(id:string,input:any,actorId:string,visible:string[]|null)=>raw.release(id,input,actorId,visible,trustedActor(actorId)),
  };
  return {d,allocations,pos,tx,prisma,service,createPO};
}
const allocation = (revision: number, requestKey: string, quantity: string, supplier='S1') => ({revision,requestKey,quantity,unitPrice:'3.5',currency:'CNY',supplierRelationId:supplier});
async function ready(f: ReturnType<typeof fixture>) { await f.service.claim('D1',1,'buyer',null); await f.service.confirm('D1',{revision:2,orderLineId:'OL1',requiredQuantity:'157.5'},'buyer',null); }

describe('procurement explicit demand lifecycle', () => {
  it('claims and explicitly confirms a total without directly creating a supplier promise', async () => {
    const f=fixture();await ready(f);
    expect(f.d).toMatchObject({status:'Ready',revision:3,orderLineId:'OL1'});expect(f.d.requiredQuantity.toString()).toBe('157.5');
    await expect(f.service.allocate('D1',allocation(3,'r1','100'),'buyer',null)).rejects.toMatchObject({code:'NATIVE_SUPPLIER_CONTRACT_REQUIRED',status:409});
    expect(f.pos).toHaveLength(0);expect(f.createPO).not.toHaveBeenCalled();
    expect(f.prisma.$transaction.mock.calls.every(c=>c[1]?.isolationLevel==='Serializable')).toBe(true);
  });
  it('blocks unresolved quantities, wrong owner, cross-order source and stale version', async () => {
    const f=fixture();
    await expect(f.service.allocate('D1',allocation(1,'r1','1'),'buyer',null)).rejects.toMatchObject({code:'NATIVE_SUPPLIER_CONTRACT_REQUIRED'});
    await f.service.claim('D1',1,'buyer',null);
    await expect(f.service.confirm('D1',{revision:2,orderLineId:'other',requiredQuantity:100},'buyer',null)).rejects.toMatchObject({code:'INVALID_SOURCE'});
    await expect(f.service.allocate('D1',allocation(2,'r1','1'),'buyer',null)).rejects.toMatchObject({code:'NATIVE_SUPPLIER_CONTRACT_REQUIRED'});
    await expect(f.service.claim('D1',2,'otherBuyer',null)).rejects.toMatchObject({code:'ALREADY_CLAIMED'});
    await expect(f.service.confirm('D1',{revision:1,orderLineId:'OL1',requiredQuantity:100},'buyer',null)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(f.createPO).not.toHaveBeenCalled();
  });
  it('retains an existing exact plan and blocks reconfirming its already allocated total', async () => {
    const f=fixture();await ready(f);f.allocations.push({id:'EXISTING',demandId:'D1',purchaseOrderId:'PO1',purchaseLineId:'PL1',quantity:new Prisma.Decimal('100'),status:'Active'});
    await expect(f.service.confirm('D1',{revision:3,orderLineId:'OL1',requiredQuantity:200},'buyer',null)).rejects.toMatchObject({code:'ALREADY_ALLOCATED'});
    expect(f.allocations[0].quantity.toString()).toBe('100');expect(f.createPO).not.toHaveBeenCalled();
  });
  it('does not leak hidden demand or allow hidden-order writes', async () => {
    const f=fixture();await expect(f.service.claim('D1',1,'buyer',['O2'])).rejects.toMatchObject({status:404});
    await expect(f.service.list(['O2'],'buyer',{orderId:'O1'})).rejects.toMatchObject({status:404});
  });
  it('L7 preserves per-output requirement but never creates PO or assumes total/output line', async () => {
    const f=fixture();f.tx.bOM.findUnique.mockResolvedValue({id:'B1',version:2,status:'Confirmed',orderId:'O1',lines:[{id:'BL1',description:'Fabric',unit:'M',effectiveQty:new Prisma.Decimal('1.575')}]});
    await createDemandsFromBOM(f.prisma,'B1');
    expect(f.tx.procurementDemand.upsert.mock.calls[0][0]).toMatchObject({where:{sourceKey:'bom:B1:2:BL1'},create:{status:'NeedsConfirmation',quantityBasis:'PerOutput'}});
    const created=f.tx.procurementDemand.upsert.mock.calls[0][0].create;
    expect(created.requiredQuantity).toBeUndefined();expect(created.orderLineId).toBeUndefined();expect(f.createPO).not.toHaveBeenCalled();
  });
  it('blocks revision confirmation when any ancestor version already has purchases', async () => {
    const f=fixture(); f.d.bomId='B3'; f.d.bomVersion=3;
    f.tx.bOM.findUnique.mockImplementation(async ({where}) => where.id==='B3' ? {id:'B3',version:3,status:'Confirmed',parentBomId:'B2'} : {id:'B2',version:2,status:'Archived',parentBomId:'B1'});
    f.tx.purchaseDemandAllocation.count.mockImplementation(async ({where}) => where.demand?.bomId==='B1' ? 1 : 0);
    await f.service.claim('D1',1,'buyer',null);
    await expect(f.service.confirm('D1',{revision:2,orderLineId:'OL1',requiredQuantity:100},'buyer',null)).rejects.toMatchObject({code:'PRIOR_VERSION_ALLOCATED'});
    expect(f.createPO).not.toHaveBeenCalled();
  });
  it('create retry retains one demand and rejects changed payload for the same request key', async () => {
    const f=fixture(); let created:any=null;
    f.tx.procurementDemand.findUnique.mockImplementation(async()=>created);
    f.tx.procurementDemand.create=vi.fn(async ({data})=>{created={...data,revision:1};return created;});
    const input={requestKey:'c1',orderId:'O1',orderLineId:'OL1',description:'Cotton',unit:'M'};
    await f.service.create(input,'buyer',null);await f.service.create(input,'buyer',null);
    expect(f.tx.procurementDemand.create).toHaveBeenCalledTimes(1);
    await expect(f.service.create({...input,description:'Other'},'buyer',null)).rejects.toMatchObject({code:'REQUEST_KEY_REUSED'});
  });
  it('lists with explicit pagination and tells the UI when more work remains', async () => {
    const f=fixture();f.tx.procurementDemand.count.mockResolvedValue(80);
    const result=await f.service.list(null,'buyer',{offset:50,limit:20});
    expect(result).toMatchObject({total:80,hasMore:true,offset:50,limit:20});
    expect(f.tx.procurementDemand.findMany).toHaveBeenCalledWith(expect.objectContaining({skip:50,take:20}));
  });
  it('new BOM supersedes unallocated old requirements without replacing purchased facts', async()=>{
    const f=fixture();f.tx.bOM.findUnique.mockResolvedValue({id:'B2',parentBomId:'B1',status:'Confirmed',version:2,lines:[]});
    await createDemandsFromBOM(f.prisma,'B2');
    expect(f.tx.procurementDemand.findMany).toHaveBeenCalledWith({where:{bomId:'B1',allocations:{none:{status:'Active'}}}});
    expect(f.tx.procurementDemand.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'Superseded'})}));
  });
  it('blocks unknown legacy BOM purchases instead of silently allocating the total again', async()=>{
    const f=fixture();f.d.bomId='B1';f.d.bomVersion=1;
    f.tx.bOM.findUnique.mockResolvedValue({id:'B1',version:1,status:'Confirmed'});
    f.pos.push({id:'legacyPO'});
    await f.service.claim('D1',1,'buyer',null);
    await expect(f.service.confirm('D1',{revision:2,orderLineId:'OL1',requiredQuantity:100},'buyer',null)).rejects.toMatchObject({code:'LEGACY_PURCHASE_REVIEW'});
  });
  it('returns only task ownership, retaining ready demand, allocated quantities and PO', async()=>{
    const f=fixture();await ready(f);f.d.revision=4;f.allocations.push({id:'EXISTING',purchaseOrderId:'PO1',purchaseLineId:'PL1',quantity:new Prisma.Decimal('100'),status:'Active'});f.pos.push({id:'PO1',poNumber:'PO-1'});
    const before=f.allocations.map(a=>({...a}));const beforePO=f.pos.map(p=>({...p}));
    const result=await f.service.release('D1',{revision:4,reason:'  误领，交回队列  '},'buyer',null);
    expect(result.demand).toMatchObject({assigneeId:null,revision:5,status:'Ready',requiredQuantity:'157.5',allocatedQuantity:'100',remainingQuantity:'57.5'});
    expect(f.allocations).toEqual(before);expect(f.pos).toEqual(beforePO);
    expect(f.tx.auditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({action:'release_procurement_demand',detail:{beforeAssigneeId:'buyer',afterAssigneeId:null,reason:'误领，交回队列'}})}));
    const claimed=await f.service.claim('D1',5,'buyer2',null);expect(claimed.demand.assigneeId).toBe('buyer2');
  });
  it('allows returning NeedsConfirmation without requiring quantity confirmation',async()=>{
    const f=fixture();await f.service.claim('D1',1,'buyer',null);
    const result=await f.service.release('D1',{revision:2,reason:'误领'},'buyer',null);
    expect(result.demand).toMatchObject({assigneeId:null,status:'NeedsConfirmation',requiredQuantity:null,revision:3});
  });
  it('rejects release by another person, invisible source, stale revision, unsupported status and missing reason',async()=>{
    const f=fixture();await f.service.claim('D1',1,'buyer',null);
    const release=(input:any, actor='buyer', visible:string[]|null=null)=>f.service.release('D1',input,actor,visible);
    await expect(release({revision:2,reason:'误领'},'buyer2')).rejects.toMatchObject({status:403});
    await expect(release({revision:2,reason:'误领'},'buyer',['O2'])).rejects.toMatchObject({status:404});
    await expect(release({revision:1,reason:'误领'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    await expect(release({revision:2,reason:' '})).rejects.toMatchObject({code:'INVALID_REASON'});
    await expect(release({revision:2,reason:'x'.repeat(1001)})).rejects.toMatchObject({code:'INVALID_REASON'});
    f.d.status='Superseded';await expect(release({revision:2,reason:'误领'})).rejects.toMatchObject({code:'INVALID_STATE'});
    expect(f.d.assigneeId).toBe('buyer');expect(f.d.revision).toBe(2);
  });
  it.each([0,-1,NaN,Infinity,'','1.12345'])('rejects invalid total %s', value => { expect(()=>demandDecimal(value,'数量')).toThrow(); });
  it('permits zero price draft but rejects blank or negative/NaN purchase lines', () => {
    const good={description:'布料',quantity:2,unit:'M',unitPrice:0};expect(()=>validatePurchaseLines([good])).not.toThrow();
    for(const bad of [[],[{...good,quantity:-1}],[{...good,quantity:NaN}],[{...good,description:''}],[{...good,unitPrice:-1}]]) expect(()=>validatePurchaseLines(bad)).toThrow();
  });
});
it('加工需求不会再生成混合 ProcessingService 采购单',async()=>{const f=fixture();f.d.kind='ProcessingService';await ready(f);await expect(f.service.allocate('D1',allocation(3,'service','10'),'buyer',null)).rejects.toMatchObject({code:'NATIVE_SUPPLIER_CONTRACT_REQUIRED',status:409});expect(f.createPO).not.toHaveBeenCalled();});
