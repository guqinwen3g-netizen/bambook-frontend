import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { writeRouteAuditLog } from '../audit/routeAudit';
export class SampleMeterError extends Error { constructor(public code:string,message:string,public status=400){super(message);} }
export const isMeterCard=(card:any)=>card?.unit==='米'||card?.unit==='M'||card?.physicalLengthQty!=null;
function decimal(value:unknown,zero=false):Prisma.Decimal {
 const raw=String(value??'').trim();
 if(!/^\d{1,14}(?:\.\d{1,4})?$/.test(raw))throw new SampleMeterError('VALIDATION_FAILED','米数须为明确的十进制数，最多四位小数。');
 const result=new Prisma.Decimal(raw);if(zero?result.lt(0):result.lte(0))throw new SampleMeterError('VALIDATION_FAILED','米数须大于零。');return result;
}
function key(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>200)throw new SampleMeterError('VALIDATION_FAILED','米样操作须保留同一次请求编号。');return value;}
function digest(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function history(loan:any){const value=loan.lengthReturnHistory??[];if(!Array.isArray(value))throw new SampleMeterError('STOCK_INCONSISTENT','归还历史须先核对。',409);return value;}
export function meterLoanView(loan:any){return {...loan,loanLength:loan.loanLength?.toString()??null,returnedLengthQty:loan.returnedLengthQty?.toString()??null,lengthReturnHistory:loan.lengthReturnHistory??null};}
async function balance(tx:any,card:any){
 const total=decimal(card.physicalLengthQty,true),available=decimal(card.availableLengthQty,true);
 const loans=await tx.sampleCardLoan.findMany({where:{itemId:card.id,loanType:'borrow',returnedAt:null}});
 let outstanding=new Prisma.Decimal(0);
 for(const loan of loans){if(loan.loanLength==null)throw new SampleMeterError('STOCK_INCONSISTENT','米样存在整数借用流水，请先核对原记录。',409);
  const original=decimal(loan.loanLength),returned=decimal(loan.returnedLengthQty??'0',true);if(returned.gt(original))throw new SampleMeterError('STOCK_INCONSISTENT','已还米数超过原借出米数。',409);
  outstanding=outstanding.plus(original.minus(returned));}
 if(!total.eq(available.plus(outstanding)))throw new SampleMeterError('STOCK_INCONSISTENT','总米数、可用米数与未还米数不一致，不提供盘点修正。',409);
 return {total,available,outstanding};
}
/** Caller holds the authorized sample-card row and its parent graph locks. */
export async function moveMeterStock(tx:any,card:any,actorId:string,operation:'borrow'|'ship',input:any){
 if(input.loanQuantity!==undefined||input.shipQuantity!==undefined)throw new SampleMeterError('VALIDATION_FAILED','米样按米操作，不能提交整数件数。');
 const length=decimal(operation==='borrow'?input.loanLength:input.shipLength),requestKey=key(input.requestKey);
 const name=String(operation==='borrow'?input.borrowerName??'':input.recipientName??'').trim();if(!name||name.length>100)throw new SampleMeterError('VALIDATION_FAILED','请填写不超过100字的借用人或收件人。');
 const dueAt=input.dueAt==null?null:Number(input.dueAt);if(dueAt!==null&&!Number.isSafeInteger(dueAt))throw new SampleMeterError('VALIDATION_FAILED','预计归还时间无效。');
 if(operation==='borrow'&&dueAt===null)throw new SampleMeterError('VALIDATION_FAILED','借出请填写预计归还日期。');
 const commandHash=digest({operation,itemId:card.id,length:length.toString(),name,dueAt,relationId:operation==='ship'?input.relationId??null:null,borrowerUserId:input.borrowerUserId??null});
 await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`sample-meter:${actorId}:${requestKey}`}))::text`);
 const [prior]=await tx.sampleCardLoan.findMany({where:{operatorId:actorId,meterRequestKey:requestKey}});
 if(prior){if(prior.meterCommandHash!==commandHash)throw new SampleMeterError('REQUEST_CONFLICT','同一请求已有不同内容，不能重复扣减。',409);return {loan:meterLoanView(prior),item:card,replayed:true};}
 if(['retired','shipped'].includes(card.status)||card.sealedStatus==='sealed')throw new SampleMeterError('ITEM_UNAVAILABLE','该实物已退役、寄完或封样，不能借出/寄出。',409);
 const {total,available,outstanding}=await balance(tx,card);if(length.gt(available))throw new SampleMeterError('INSUFFICIENT_LENGTH',`可用长度不足（剩余 ${available.toString()} 米）`,409);
 const now=Date.now(),nextAvailable=available.minus(length),nextTotal=operation==='ship'?total.minus(length):total;
 const loan=await tx.sampleCardLoan.create({data:{id:'SCLM__'+digest({actorId,requestKey}),itemId:card.id,loanType:operation,loanQuantity:0,loanLength:length.toString(),returnedLengthQty:operation==='borrow'?'0':null,lengthReturnHistory:operation==='borrow'?[]:undefined,
  meterRequestKey:requestKey,meterCommandHash:commandHash,borrowerName:name,borrowerUserId:input.borrowerUserId??null,relationId:operation==='ship'?input.relationId??null:null,relationName:null,loanedAt:now,dueAt,returnedAt:operation==='ship'?now:null,operatorId:actorId,createdAt:now}});
 const archived=operation==='ship'&&nextTotal.eq(0)&&outstanding.eq(0);
 const item=await tx.sampleCardItem.update({where:{id:card.id},data:{physicalLengthQty:nextTotal.toString(),availableLengthQty:nextAvailable.toString(),quantity:nextTotal.eq(0)?0:card.quantity,availableQty:nextAvailable.eq(0)?0:card.quantity,status:archived?'shipped':nextAvailable.eq(0)?'borrowed':'in_stock',updatedAt:now}});
 await writeRouteAuditLog({prisma:tx,actorId,source:'sample-room',operation:`sample_meter_${operation}`,targetType:'SampleCardItem',targetId:card.id,after:{requestKey,loanId:loan.id,length:length.toString(),total:nextTotal.toString(),available:nextAvailable.toString()},operationType:'link'});
 return {loan:meterLoanView(loan),item,archived,replayed:false};
}
/** Caller also holds the original loan row; returns append facts to that loan. */
export async function returnMeterStock(tx:any,card:any,loan:any,actorId:string,input:any){
 if(input.returnQuantity!==undefined)throw new SampleMeterError('VALIDATION_FAILED','米样归还按米操作。');
 const length=decimal(input.returnLength),requestKey=key(input.requestKey),note=String(input.conditionNote??'').trim().slice(0,500);
 const commandHash=digest({loanId:loan.id,length:length.toString(),note});const records=history(loan);
 const prior=records.find((record:any)=>record.requestKey===requestKey&&record.operatorId===actorId);
 if(prior){if(prior.commandHash!==commandHash)throw new SampleMeterError('REQUEST_CONFLICT','同一归还请求已有不同内容。',409);return {loan:meterLoanView(loan),item:card,replayed:true};}
 if(loan.loanType!=='borrow'||loan.returnedAt!=null)throw new SampleMeterError('LOAN_ALREADY_RETURNED','原米样借出已归还或不是可归还记录。',409);
 if(['retired','shipped'].includes(card.status))throw new SampleMeterError('ITEM_UNAVAILABLE','实物已退役或寄完，不能归还。',409);
 const original=decimal(loan.loanLength),returned=decimal(loan.returnedLengthQty??'0',true),nextReturned=returned.plus(length);
 if(nextReturned.gt(original))throw new SampleMeterError('EXCESS_RETURN','本次归还超过原借出剩余米数。',409);
 const {total,available}=await balance(tx,card),nextAvailable=available.plus(length);if(nextAvailable.gt(total))throw new SampleMeterError('STOCK_INCONSISTENT','归还后可用长度超过实物总量。',409);
 const now=Date.now(),event={requestKey,commandHash,length:length.toString(),operatorId:actorId,returnedAt:String(now),conditionNote:note||null};
 const updated=await tx.sampleCardLoan.update({where:{id:loan.id},data:{returnedLengthQty:nextReturned.toString(),lengthReturnHistory:[...records,event],returnedAt:nextReturned.eq(original)?now:null,conditionNote:note||null}});
 const item=await tx.sampleCardItem.update({where:{id:card.id},data:{availableLengthQty:nextAvailable.toString(),availableQty:nextAvailable.gt(0)?card.quantity:0,status:nextAvailable.gt(0)?'in_stock':card.status,updatedAt:now}});
 await writeRouteAuditLog({prisma:tx,actorId,source:'sample-room',operation:'sample_meter_return',targetType:'SampleCardItem',targetId:card.id,after:{loanId:loan.id,...event,available:nextAvailable.toString()},operationType:'update'});
 return {loan:meterLoanView(updated),item,replayed:false};
}
