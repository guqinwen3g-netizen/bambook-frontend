/** Prepare globally allocated legal numbers inside the caller's existing transaction. */
import {nextBusinessNumber,type BusinessPrefix} from '../shared/businessNumberService';
import {MistCommandError} from '../shared/mistWorkspace';
import type {MistBusinessNumberNeed} from '../shared/mistCreditDocuments';
export type PreparedMistBusinessNumber=MistBusinessNumberNeed&{code:string};
export type MistBusinessNumberAllocator=(tx:any,prefix:BusinessPrefix,year:number,options:{occupied:(code:string)=>Promise<boolean>})=>Promise<string>;
const prefixes={newCase:'CLM',newCommonCN:'CLM',newGoods:'RT',refundPV:'PV'} as const;
// Current-schema professional records also occupy the shared DB pool. The
// standalone local facade has no such delegates and never opens a legacy DB.
const professionalOccupancy={CLM:[['claimCase','caseNumber'],['creditNote','creditNoteNumber'],['invoice','invoiceNumber']],RT:[['returnReceipt','receiptNumber'],['materialReturn','returnNumber']],PV:[['paymentVoucher','voucherNumber']]} as const;
const fail=(message:string):never=>{throw new MistCommandError('BUSINESS_NUMBER_UNAVAILABLE',message,422);};
export function createMistBusinessNumberConsumer(items:PreparedMistBusinessNumber[]){
 const queues=new Map<string,string[]>();for(const item of items){if(prefixes[item.kind]!==item.prefix||!new RegExp('^'+item.prefix+'-\\d{4}-\\d{4,}$').test(item.code))fail('正式业务编号计划无效');const queue=queues.get(item.prefix)||[];if([...queues.values()].some(q=>q.includes(item.code)))fail('正式业务编号计划重复');queue.push(item.code);queues.set(item.prefix,queue);}
 return{items:structuredClone(items),consume:(prefix:'CLM'|'RT'|'PV')=>{const value=queues.get(prefix)?.shift();return value||fail('正式'+prefix+'号段未准备或已用尽，不能退回UUID');},assertConsumed:()=>{if([...queues.values()].some(q=>q.length))fail('正式业务编号计划没有完整消费，不能提交');}};
}
/** Scan every retained JSON fact, including supplier/customer RT, archived and soft-deleted rows. */
export function occupiedMistBusinessNumbers(states:unknown[]):Set<string>{
 const occupied=new Set<string>();let count=0;const walk=(value:any,depth:number)=>{if(depth>64||++count>2_000_000)fail('全局编号占用数据无效或过大');if(typeof value==='string'){if(/^(CLM|RT|PV)-\d{4}-\d{4,}$/.test(value))occupied.add(value);return;}if(Array.isArray(value))value.forEach(v=>walk(v,depth+1));else if(value&&typeof value==='object')Object.values(value).forEach(v=>walk(v,depth+1));};states.forEach(s=>walk(s,0));return occupied;
}
export async function prepareMistBusinessNumbers(tx:any,state:unknown,needs:MistBusinessNumberNeed[],now:string,allocator:MistBusinessNumberAllocator=nextBusinessNumber){
 if(!Array.isArray(needs)||needs.length>20||needs.some(n=>!n||prefixes[n.kind]!==n.prefix))return fail('业务编号计划无效');if(!needs.length)return createMistBusinessNumberConsumer([]);
 // Guard even in NODE_ENV=test: the original test fallback must never enter a Mist command.
 if(!tx.businessSequence||typeof tx.businessSequence.upsert!=='function'||typeof tx.businessSequence.update!=='function'||typeof tx.mistWorkspace?.findMany!=='function')return fail('全局BusinessSequence未配置，不能分配正式业务编号');
 const date=new Date(now);if(!Number.isFinite(date.valueOf()))return fail('业务编号时间无效');const year=Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric'}).format(date));const rows=await tx.mistWorkspace.findMany({});const occupied=occupiedMistBusinessNumbers([...rows.map((r:any)=>r.state),state]);const items:PreparedMistBusinessNumber[]=[];
 for(const need of needs){const code=await allocator(tx,need.prefix,year,{occupied:async code=>{if(occupied.has(code))return true;for(const [model,field] of professionalOccupancy[need.prefix]){const delegate=tx[model];if(delegate){if(typeof delegate.findFirst!=='function')fail('专业编号占用接口未配置');if(await delegate.findFirst({where:{[field]:code},select:{id:true}}))return true;}}return false;}});if(!new RegExp('^'+need.prefix+'-'+year+'-\\d{4,}$').test(code)||occupied.has(code))fail('编号分配器返回了非法或重复号码');occupied.add(code);items.push({...need,code});}
 return createMistBusinessNumberConsumer(items);
}
