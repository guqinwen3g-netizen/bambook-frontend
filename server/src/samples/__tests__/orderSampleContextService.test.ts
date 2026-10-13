import {describe,it,expect,vi,beforeEach} from 'vitest';
import {Prisma} from '@prisma/client';
const m=vi.hoisted(()=>({actor:vi.fn(),scope:vi.fn(),grant:vi.fn(),parents:vi.fn(),batch:vi.fn()}));
vi.mock('../sampleRegistrationContextService',()=>({currentRegistrationActor:m.actor}));
vi.mock('../../orders/orderLineWriteAccess',()=>({freshOrderLineScope:m.scope}));
vi.mock('../../auth/permissionService',()=>({hasScope:m.grant}));
vi.mock('../orderSampleParentResolver',()=>({resolveOrderSampleParents:m.parents,OrderSampleParentError:class extends Error{}}));
vi.mock('../../production/productionBatchFacts',()=>({productionBatchLineFingerprint:()=> 'a'.repeat(64),resolveCurrentProductionBatchFacts:m.batch,ProductionBatchFactsError:class extends Error{}}));
import {getOrderSampleContext,previewOrderSampleParents} from '../orderSampleContextService';
const actor:any={userId:'ACTOR',roles:[],permissions:[]};
function fixture(){
 const order={id:'ORDER',type:'fabric',businessLine:'fabric'};
 const db:any={order:{findFirst:vi.fn(async()=>order)},orderLine:{findMany:vi.fn(async()=>[])},productionBatch:{findMany:vi.fn(async()=>[])},relation:{findFirst:vi.fn(async()=>null)}};
 db.$transaction=vi.fn(async(fn:any)=>fn(db));return db;
}
beforeEach(()=>{vi.clearAllMocks();m.actor.mockResolvedValue(actor);m.scope.mockResolvedValue({ownerId:'ACTOR'});m.grant.mockReturnValue(true);m.parents.mockResolvedValue({parentFingerprint:'p',owner:{},specSnapshot:{},coverage:[],lines:[],batches:[],lockRefs:{secret:true}});});
describe('order sample read context',()=>{
 it('fresh authorized scoped order is rechecked outside RR; context grants no writes',async()=>{
  const db=fixture(),r=await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'fabric_ss'});
  expect(r.ok).toBe(true);expect(m.actor).toHaveBeenCalledTimes(2);expect(db.order.findFirst.mock.calls[0][0].where.AND).toEqual([{ownerId:'ACTOR'}]);
  expect(db.$transaction.mock.calls[0][1]).toEqual({isolationLevel:'RepeatableRead'});expect(r).not.toHaveProperty('data.writeAllowed');
 });
 it('revoked outside snapshot visibility refuses candidate data',async()=>{
  const db=fixture();db.order.findFirst.mockResolvedValueOnce({id:'ORDER',type:'fabric'}).mockResolvedValueOnce(null);
  expect((await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'fabric_ss'})).ok).toBe(false);
 });
 it.each(['line','batch'])('rejects overbudget %s candidates rather than truncating',async(kind)=>{
  const db=fixture();db[kind==='line'?'orderLine':'productionBatch'].findMany.mockResolvedValue(Array.from({length:129},(_,i)=>({id:String(i)})));
  expect((await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'fabric_ss'})).ok).toBe(false);
 });
 it('actual decimal strings retain precision and missing unit is blocked without default',async()=>{
  const db=fixture();db.orderLine.findMany.mockResolvedValue([{id:'L',quantity:new Prisma.Decimal('12.125'),unit:'M',confirmedSourceType:'Asset',confirmedSourceId:'A',specSnapshot:{}},{id:'BAD',quantity:new Prisma.Decimal('1'),unit:null}]);
  const r=await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'fabric_ss'});
  if(!r.ok)throw Error('context failed');expect(r.data.lines[0].quantity).toBe('12.125');expect(r.data.lines[1].unit).toBeNull();expect(r.data.lines[1].selectable).toBe(false);
 });
 it('inactive batch with missing factory cannot become selectable',async()=>{
  const db=fixture();db.productionBatch.findMany.mockResolvedValue([{id:'B',orderLineId:'L',factoryRelationId:null,state:'cancelled',revision:1,rangeStart:new Prisma.Decimal(0),quantity:new Prisma.Decimal(1),unit:'M'}]);
  const r=await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'fabric_ss'});if(!r.ok)throw Error('context failed');expect(r.data.batches[0].blockedReasons).toContain('BATCH_INACTIVE');expect(r.data.batches[0].blockedReasons).toContain('FACTORY_MISSING');expect(m.parents).not.toHaveBeenCalled();
 });
 it('storage failure does not produce empty successful context',async()=>{
  const db=fixture();db.productionBatch.findMany.mockRejectedValue(Error('SQL unavailable'));expect((await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'fabric_ss'})).ok).toBe(false);
 });
 it('preview exposes normalized facts but no parent graph or lock identity',async()=>{
  const db=fixture();const r=await previewOrderSampleParents({prisma:db,actor,request:{orderId:'ORDER',family:'fabric_ss',factoryRelationId:'FACTORY',coverage:[]}});
  expect(r.ok).toBe(true);expect(r).not.toHaveProperty('data.lockRefs');expect(m.actor).toHaveBeenCalledTimes(2);
 });
 it('wrong business family is rejected before reading candidate delegates',async()=>{
  const db=fixture();expect((await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'garment_pp'})).ok).toBe(false);expect(db.orderLine.findMany).not.toHaveBeenCalled();
 });
});

describe('read authorization and PP boundaries',()=>{
 it('orders read grant refusal precedes candidate data',async()=>{
  const db=fixture();m.grant.mockReturnValue(false);expect((await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'fabric_ss'})).ok).toBe(false);expect(db.orderLine.findMany).not.toHaveBeenCalled();
 });
 it('PP line cannot become selectable without actual factory identity',async()=>{
  const db=fixture();db.order.findFirst.mockResolvedValue({id:'ORDER',type:'garment'});db.orderLine.findMany.mockResolvedValue([{id:'L',quantity:new Prisma.Decimal(2),unit:'PC',confirmedSourceType:'Sample',confirmedSourceId:'S',specSnapshot:{}}]);db.sample={findUnique:vi.fn(async()=>({supplierRelationId:null}))};
  const r=await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'garment_pp'});if(!r.ok)throw Error('context failed');expect(r.data.lines[0].selectable).toBe(false);expect(r.data.lines[0].blockedReasons).toContain('FACTORY_MISSING');
 });
 it('PP line preview uses real frozen line token and explicit factory, without creating a batch',async()=>{
  const db=fixture();db.order.findFirst.mockResolvedValue({id:'ORDER',type:'garment',millRelationId:'F'});db.orderLine.findMany.mockResolvedValue([{id:'L',quantity:new Prisma.Decimal(2),unit:'PC',confirmedSourceType:'Sample',confirmedSourceId:'S',specSnapshot:{}}]);
  const r=await getOrderSampleContext({prisma:db,actor,orderId:'ORDER',family:'garment_pp'});if(!r.ok)throw Error('context failed');expect(r.data.lines[0].selectable).toBe(true);expect(m.parents.mock.calls[0][1].coverage[0]).toMatchObject({productionBatchId:null,quantity:'2',rangeStart:'0',unit:'PC'});
 });
});
