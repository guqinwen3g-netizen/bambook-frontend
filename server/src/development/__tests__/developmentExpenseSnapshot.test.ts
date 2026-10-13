import { describe, it, expect, vi } from 'vitest';
import { readDevelopmentExpenseSnapshot } from '../developmentExpenseSnapshot';
function setup(rows: any[]) {
 const db:any={developmentCase:{findFirst:vi.fn().mockResolvedValue({id:'D',stage:'approved'})},sampleBatch:{findMany:vi.fn().mockResolvedValue([{id:'B'}])},sample:{findMany:vi.fn().mockResolvedValue([{id:'S',type:'dev'}])},sealSample:{findMany:vi.fn().mockResolvedValue([{id:'SE'}])},costRecord:{findMany:vi.fn().mockResolvedValue(rows)}};return db;
}
const row=(id:string,amount:any='0.1',currency='CNY')=>({id,sourceType:'DevelopmentCase',sourceId:'D',amount,currency,costType:'shipping',incurredAt:'2026-09-30',updatedAt:1n});
describe('开发整案费用快照',()=>{
 it('订单生产样及费用不混入开发案，也不因生产样更新使开发核齐失效',async()=>{
  const db=setup([row('a')]); const before=await readDevelopmentExpenseSnapshot(db,'D');
  db.sample.findMany.mockResolvedValue([{id:'S',type:'dev'},{id:'PP',type:'pp',sourceOrderId:'O',updatedAt:9n}]);
  db.costRecord.findMany.mockResolvedValue([row('a'),{...row('production','80'),sourceType:'Sample',sourceId:'PP'}]);
  const after=await readDevelopmentExpenseSnapshot(db,'D');
  expect(after.fingerprint).toBe(before.fingerprint);expect(after.unresolvedProductionExpenses).toEqual([]);
  expect(after.records).toHaveLength(1);
 });
 it('无订单归属的生产样历史费用显式待核实，不静默算入或丢弃',async()=>{
  const db=setup([{...row('unresolved','80'),sourceType:'Sample',sourceId:'PP'}]);
  db.sample.findMany.mockResolvedValue([{id:'PP',type:'pp',sourceOrderId:null}]);
  const result=await readDevelopmentExpenseSnapshot(db,'D');
  expect(result.records).toEqual([]);expect(result.unresolvedProductionExpenses[0]).toMatchObject({id:'unresolved',amount:'80'});
 });
 it('超过300条也全量汇总，不裸加币种，明确0合法',async()=>{const db=setup([...Array.from({length:350},(_,i)=>row(String(i))),row('usd','2','USD'),row('zero','0')]);const result=await readDevelopmentExpenseSnapshot(db,'D');expect(result.records).toHaveLength(352);expect(result.totals).toEqual([{currency:'CNY',amount:'35.0000'},{currency:'USD',amount:'2.0000'}]);const q=db.costRecord.findMany.mock.calls[0][0];expect(q.take).toBeUndefined();expect(q.where.OR).toContainEqual({sourceType:'Sample',sourceId:'S'});});
 it('软删除样品后仍保留已发生费用范围',async()=>{
  const db=setup([{...row('historic','15'),sourceType:'Sample',sourceId:'S'}]);
  db.sample.findMany.mockImplementation(async({where}:any)=>where.deletedAt===null?[]:[{id:'S',type:'dev'}]);
  const result=await readDevelopmentExpenseSnapshot(db,'D');
  expect(result.totals).toEqual([{currency:'CNY',amount:'15.0000'}]);
  for(const model of [db.sampleBatch,db.sample,db.sealSample]) expect(model.findMany.mock.calls[0][0].where).not.toHaveProperty('deletedAt');
 });
 it('来源读取失败不退化为空案',async()=>{const db=setup([]);db.sample.findMany.mockRejectedValue(new Error('database unavailable'));await expect(readDevelopmentExpenseSnapshot(db,'D')).rejects.toThrow('database unavailable');expect(db.costRecord.findMany).not.toHaveBeenCalled();});
 it('重排不改指纹，成本或依据变化会失效',async()=>{const a=row('a'),b=row('b');const first=await readDevelopmentExpenseSnapshot(setup([a,b]),'D');expect((await readDevelopmentExpenseSnapshot(setup([b,a]),'D')).fingerprint).toBe(first.fingerprint);expect((await readDevelopmentExpenseSnapshot(setup([{...a,amount:2},b]),'D')).fingerprint).not.toBe(first.fingerprint);expect((await readDevelopmentExpenseSnapshot(setup([{...a,notes:'改依据'},b]),'D')).fingerprint).not.toBe(first.fingerprint);});
 it.each([null,undefined,'',-1,'NaN','0.00001'])('无效或未知金额 %s 不能参与最终汇总',async amount=>{await expect(readDevelopmentExpenseSnapshot(setup([{...row('a'),amount}]),'D')).rejects.toThrow();});
 it('历史其他币种显式报出，不丢费用',async()=>{const result=await readDevelopmentExpenseSnapshot(setup([row('a',4,'EUR')]),'D');expect(result.unsupportedCurrencies).toEqual(['EUR']);expect(result.totals).toEqual([{currency:'EUR',amount:'4.0000'}]);});
 it('重复和错误来源不能混入',async()=>{await expect(readDevelopmentExpenseSnapshot(setup([row('a'),row('a')]),'D')).rejects.toThrow();await expect(readDevelopmentExpenseSnapshot(setup([{...row('a'),sourceId:'OTHER'}]),'D')).rejects.toThrow();});
});

it('凭据新增和撤销使核齐指纹失效，无凭据旧快照保持兼容且不暴露存储路径',async()=>{
 const original=await readDevelopmentExpenseSnapshot(setup([row('a')]),'D');
 const empty=await readDevelopmentExpenseSnapshot(setup([{...row('a'),evidence:[]}]),'D');expect(empty.fingerprint).toBe(original.fingerprint);
 const evidence={id:'e',sha256:'digest',originalName:'bill.pdf',createdAt:2n,revokedAt:null};
 const added=await readDevelopmentExpenseSnapshot(setup([{...row('a'),evidence:[evidence]}]),'D');expect(added.fingerprint).not.toBe(original.fingerprint);
 const revoked=await readDevelopmentExpenseSnapshot(setup([{...row('a'),evidence:[{...evidence,revokedAt:3n,revokeReason:'账单更正'}]}]),'D');expect(revoked.fingerprint).not.toBe(added.fingerprint);
 expect(added.records[0].evidence[0].createdAt).toBe('2');
 const db=setup([row('a')]);await readDevelopmentExpenseSnapshot(db,'D');expect(db.costRecord.findMany.mock.calls[0][0].include.evidence.select).not.toHaveProperty('storageKey');
});

it('寄样费用核齐绑定真实寄送轮次，空绑定保留历史指纹', async () => {
 const legacy = await readDevelopmentExpenseSnapshot(setup([row('shipping')]), 'D');
 const unbound = await readDevelopmentExpenseSnapshot(setup([{...row('shipping'), developmentShippingSource:null}]), 'D');
 expect(unbound.fingerprint).toBe(legacy.fingerprint);
 const source = {schemaVersion:1, batchId:'B', round:1, kind:'fabric-send-event', id:'send-S1', nativeAuditId:'audit-S1', fingerprint:'S1-source'};
 const bound = await readDevelopmentExpenseSnapshot(setup([{...row('shipping'), developmentShippingSource:source}]), 'D');
 expect(bound.records[0].developmentShippingSource).toEqual(source);
 expect(bound.fingerprint).not.toBe(legacy.fingerprint);
 const changed = await readDevelopmentExpenseSnapshot(setup([{...row('shipping'), developmentShippingSource:{...source, round:2, id:'send-S2', nativeAuditId:'audit-S2', fingerprint:'S2-source'}}]), 'D');
 expect(changed.fingerprint).not.toBe(bound.fingerprint);
 expect(changed.totals).toEqual(bound.totals);
});
