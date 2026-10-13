import {describe,it,expect,vi} from 'vitest';
import {lockPhysicalSampleSources} from '../samplePhysicalSourceService';
function fixture(){
 const state:any={samples:[{id:'S',sourceCaseId:'C',sourceOrderId:'O',customerRelationId:'CUSTOMER',supplierRelationId:'FACTORY',deletedAt:null}],
  cases:[{id:'C',type:'garment',customerRelationId:'CUSTOMER',supplierRelationId:'FACTORY',deletedAt:null}],
  orders:[{id:'O',type:'Garment',businessLine:'garment',sourceCaseId:'C',customerRelationId:'CUSTOMER',millRelationId:'FACTORY',deletedAt:null}],
  relations:['CUSTOMER','FACTORY','TARGET'].map(id=>({id,ownerId:'EMPLOYEE',salesRepIds:[],departmentId:null,deletedAt:null})),assets:[],warehouses:[],batches:[]};
 const delegate=(key:string)=>({findMany:vi.fn(async({where}:any)=>state[key].filter((r:any)=>where.id.in.includes(r.id))),findUnique:vi.fn(async({where}:any)=>state[key].find((r:any)=>r.id===where.id)??null),
  findFirst:vi.fn(async({where}:any)=>state[key].find((r:any)=>r.id===where.id&&(where.deletedAt===undefined||r.deletedAt===null))??null)});
 const locks:any[]=[];const tx:any={sample:delegate('samples'),developmentCase:delegate('cases'),order:delegate('orders'),relation:delegate('relations'),productAsset:delegate('assets'),warehouse:delegate('warehouses'),sampleBatch:delegate('batches'),
  $queryRaw:vi.fn(async(q:any)=>{locks.push({sql:q.sql,values:q.values});return [{id:q.values[0]}];})};
 return{state,tx,locks};
}
describe('physical creation source ownership locks, independent of approvals',()=>{
 it('locks actual customer and factory once before Order/Sample and preserves garment business',async()=>{
  const f=fixture();const r=await lockPhysicalSampleSources(f.tx,{sampleId:'S'});
  expect(f.locks.map(q=>q.sql.match(/FROM "([^"]+)"/)?.[1])).toEqual(['DevelopmentCase','Relation','Relation','Order','Sample']);
  expect(f.locks.filter(q=>q.sql.includes('"Relation"')).map(q=>q.values[0])).toEqual(['CUSTOMER','FACTORY']);
  expect(r.ownerBusinessContext).toMatchObject({businessLine:'garment'});
 });
 it('extra actual target Relation is merged and deduplicated before child locks',async()=>{
  const f=fixture();await lockPhysicalSampleSources(f.tx,{sampleId:'S'},{extraRelationIds:['TARGET','CUSTOMER','TARGET']});
  expect(f.locks.filter(q=>q.sql.includes('"Relation"')).map(q=>q.values[0])).toEqual(['CUSTOMER','FACTORY','TARGET']);
 });
 it('a missing actual customer is refused before any lock',async()=>{
  const f=fixture();f.state.relations=f.state.relations.filter((r:any)=>r.id!=='CUSTOMER');
  await expect(lockPhysicalSampleSources(f.tx,{sampleId:'S'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});expect(f.locks).toHaveLength(0);
 });
 it('a deleted source factory is refused before any lock',async()=>{
  const f=fixture();f.state.relations.find((r:any)=>r.id==='FACTORY').deletedAt=1n;
  await expect(lockPhysicalSampleSources(f.tx,{sampleId:'S'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});expect(f.locks).toHaveLength(0);
 });
 it('ownership changed while locking a child refuses the old graph',async()=>{
  const f=fixture();f.tx.$queryRaw.mockImplementation(async(q:any)=>{f.locks.push({sql:q.sql,values:q.values});if(q.sql.includes('"Sample"'))f.state.relations[0].ownerId='OTHER';return[{id:q.values[0]}];});
  await expect(lockPhysicalSampleSources(f.tx,{sampleId:'S'})).rejects.toMatchObject({code:'SOURCE_CHANGED'});
 });
 it('new customer discovered after Sample lock is not chased',async()=>{
  const f=fixture();f.tx.$queryRaw.mockImplementation(async(q:any)=>{f.locks.push({sql:q.sql,values:q.values});if(q.sql.includes('"Sample"'))f.state.samples[0].customerRelationId='TARGET';return[{id:q.values[0]}];});
  await expect(lockPhysicalSampleSources(f.tx,{sampleId:'S'})).rejects.toMatchObject({code:'SOURCE_CHANGED'});
  expect(f.locks.some(q=>q.values.includes('TARGET'))).toBe(false);
 });
 it('approval and source labels changing do not create receipt or customer approval',async()=>{
  const f=fixture();f.tx.$queryRaw.mockImplementation(async(q:any)=>{if(q.sql.includes('"Sample"')){f.state.samples[0].status='approved';f.state.cases[0].stage='closed';}return[{id:q.values[0]}];});
  const r=await lockPhysicalSampleSources(f.tx,{sampleId:'S'});expect(r.physicalSource).toEqual({version:1,sampleId:'S',devCaseId:'C',orderId:'O',descriptorProductAssetId:null,sampleProductAssetId:null,batchId:null});
 });
 it('source-free manual custody remains neutral, with no invented Relations',async()=>{
  const f=fixture();const r=await lockPhysicalSampleSources(f.tx,{});expect(f.locks).toHaveLength(0);expect(r.ownerBusinessContext.status).toBe('unresolved');
 });
});
