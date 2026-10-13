import {it,expect,vi} from 'vitest';
import {addDevelopmentCostEvidence,revokeDevelopmentCostEvidence,readDevelopmentCostEvidence} from '../developmentCostEvidenceService';
vi.mock('../developmentExpenseSnapshot',()=>({readDevelopmentExpenseSnapshot:vi.fn(async()=>({records:[{id:'cost'}]}))}));
function setup(){
 let row:any=null;const put=vi.fn(async()=>({storageKey:'private-key',originalName:'bill.pdf',mimeType:'application/pdf',byteSize:8,sha256:'digest'}));
 const files={put,read:vi.fn(async()=>Buffer.from('file')),removeUnreferenced:vi.fn(async()=>{})};
 const tx:any={$queryRaw:vi.fn(async()=>[{id:'case'}]),billingItemCostCoverage:{findFirst:vi.fn(async()=>null)},auditLog:{create:vi.fn(async()=>({id:'audit'}))},costEvidence:{findUnique:vi.fn(async()=>row),findFirst:vi.fn(async()=>row),create:vi.fn(async({data}:any)=>(row=data)),update:vi.fn(async({data}:any)=>(row={...row,...data}))}};
 const prisma:any={$transaction:vi.fn(async(fn:any)=>{const before=row;try{return await fn(tx);}catch(e){row=before;throw e;}}),costEvidence:{findUnique:vi.fn(async()=>row)}};
 return {ctx:{prisma,files,actorId:'business',authorize:vi.fn(async()=>{})},tx,files};
}
const input={bytes:Buffer.from('%PDF-1.7'),originalName:'bill.pdf',requestKey:'request',note:'快递账单'};
it('相同请求恢复原凭据，不重复写文件；同key改内容拒绝',async()=>{
 const f=setup();const first=await addDevelopmentCostEvidence(f.ctx,'case','cost',input);
 expect(await addDevelopmentCostEvidence(f.ctx,'case','cost',input)).toEqual(first);expect(f.files.put).toHaveBeenCalledTimes(1);expect(first).not.toHaveProperty('storageKey');
 await expect(addDevelopmentCostEvidence(f.ctx,'case','cost',{...input,note:'不同内容'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
});
it('未授权、跨案费用和已确认收费都不能写文件',async()=>{
 const f=setup();f.ctx.authorize.mockRejectedValueOnce(Error('denied'));
 await expect(addDevelopmentCostEvidence(f.ctx,'case','cost',input)).rejects.toThrow('denied');
 await expect(addDevelopmentCostEvidence(f.ctx,'case','other',input)).rejects.toMatchObject({code:'COST_NOT_IN_CASE'});
 f.tx.billingItemCostCoverage.findFirst.mockResolvedValue({id:'confirmed'});
 await expect(addDevelopmentCostEvidence(f.ctx,'case','cost',input)).rejects.toMatchObject({code:'COST_EVIDENCE_LOCKED'});expect(f.files.put).not.toHaveBeenCalled();
});
it('审计失败整体回滚后清理无引用文件',async()=>{
 const f=setup();f.tx.auditLog.create.mockRejectedValue(Error('audit unavailable'));
 await expect(addDevelopmentCostEvidence(f.ctx,'case','cost',input)).rejects.toThrow('audit unavailable');
 expect(f.files.removeUnreferenced).toHaveBeenCalledWith('private-key');
});
it('提交结果不明或查证失败保留文件，不能误删已提交凭据',async()=>{
 const f=setup();f.ctx.prisma.$transaction.mockImplementation(async(fn:any)=>{await fn(f.tx);throw Error('lost reply');});
 await expect(addDevelopmentCostEvidence(f.ctx,'case','cost',input)).rejects.toThrow('lost reply');expect(f.files.removeUnreferenced).not.toHaveBeenCalled();
 const g=setup();g.tx.auditLog.create.mockRejectedValue(Error('fail'));g.ctx.prisma.costEvidence.findUnique.mockRejectedValue(Error('db unavailable'));
 await expect(addDevelopmentCostEvidence(g.ctx,'case','cost',input)).rejects.toThrow('fail');expect(g.files.removeUnreferenced).not.toHaveBeenCalled();
});
it('撤销保留原文件和历史，重试不重复审计，读取不暴露私有路径',async()=>{
 const f=setup();const row=await addDevelopmentCostEvidence(f.ctx,'case','cost',input);
 const revoked=await revokeDevelopmentCostEvidence(f.ctx,'case','cost',row.id,'账单有误');
 expect(revoked.revokedBy).toBe('business');expect(await revokeDevelopmentCostEvidence(f.ctx,'case','cost',row.id,'账单有误')).toEqual(revoked);
 expect(f.tx.auditLog.create).toHaveBeenCalledTimes(2);expect(f.files.removeUnreferenced).not.toHaveBeenCalled();
 const read=await readDevelopmentCostEvidence(f.ctx,'case','cost',row.id);expect(read.evidence).not.toHaveProperty('storageKey');expect(read.bytes.toString()).toBe('file');
});
