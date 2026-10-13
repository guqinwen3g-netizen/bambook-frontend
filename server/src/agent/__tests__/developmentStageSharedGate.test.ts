import {describe,it,expect,vi} from 'vitest';
import {executeTool} from '../toolRuntime';
function fixture(row:any){const update=vi.fn();const tx:any={$queryRaw:vi.fn(async()=>row?[{id:row.id}]:[]),developmentLifecycleEvent:{findFirst:vi.fn(async()=>null)},developmentCase:{findFirst:vi.fn(async()=>row),update},sampleBatch:{findFirst:vi.fn(async()=>null),findMany:vi.fn(async()=>[])},sealSample:{findFirst:vi.fn(async()=>null),findMany:vi.fn(async()=>[])}};const db:any={developmentCase:{update:vi.fn()},$transaction:vi.fn(async fn=>fn(tx))};return {db,tx,update};}
const call=(stage:string)=>({toolId:'development.update_stage',input:{id:'d',stage},reason:'test'});
describe('Agent开发阶段复用公共门禁',()=>{
 it.each([
  ['nonsense',{id:'d',stage:'developing'},'INVALID_STAGE'],
  ['shipping',{id:'d',stage:'developing',type:'garment',sampleCategory:'5a',reviewStatus:'pending'},'REVIEW_REQUIRED'],
  ['approved',{id:'d',stage:'developing',type:'fabric'},'DEVELOPMENT_NOT_READY'],
  ['developing',{id:'d',stage:'approved',type:'garment'},'INVALID_TRANSITION'],
 ])('%s错误返回且无直接写入',async(stage,row,code)=>{const f=fixture(row);const result:any=await executeTool(f.db,call(stage as string));expect(result).toMatchObject({ok:false,reason:code,error:{code}});expect(f.db.developmentCase.update).not.toHaveBeenCalled();expect(f.update).not.toHaveBeenCalled();});
 it('参数缺失保持旧reason',async()=>{const f=fixture(null);expect(await executeTool(f.db,{...call(''),input:{}})).toMatchObject({ok:false,reason:'ID_AND_STAGE_REQUIRED'});});
});
it('成功阶段动作审计可信调用人而非客户端actorId',async()=>{
 const f=fixture({id:'d',stage:'developing',type:'garment',currentRound:1});
 f.update.mockImplementation(async({data}:any)=>({id:'d',...data}));
 f.tx.auditLog={create:vi.fn(async()=>({id:'audit'}))};
 const result=await executeTool(f.db,{...call('shipping'),input:{id:'d',stage:'shipping',actorId:'forged',actorUserId:'forged2'}},{actorId:'authenticated-user'});
 expect(result).toEqual({ok:true,id:'d',stage:'shipping'});
 expect(f.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({actorId:'authenticated-user',action:'update_development_case_stage'})}));
 expect(f.db.developmentCase.update).not.toHaveBeenCalled();
});
