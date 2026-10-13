import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { exactJsonValue } from '../lib/exactJsonValue';
import { orderSampleDigest } from './orderSampleSourceContract';
import { orderSampleCommandFailure as fail, orderSampleCommandId } from './orderSampleCommandContract';
import { authorizeSampleCustody, assertSampleCustodyGuardStable, recheckSampleCustodyAuthorization, SampleCustodyAuthorizationError, type SampleCustodyAuthorization, type SampleCustodyLockRef } from './sampleCustodyAuthorization';
import { SAMPLE_CARD_MOVE_PROTOCOL as PROTOCOL, SAMPLE_CARD_MOVE_OPERATION as OP, parseSampleCardMoveInput, sampleCardMoveCommand, sampleCardMoveReceiptId, type SampleCardMoveInput, type SampleCardMoveAck, type SampleCardMoveRecovery } from './sampleCardMoveContract';
const SOURCE='sample-room:card-move',MOVED='sample_card_move',CANCELLED='sample_card_move_cancel';
const conflict=(s:string):never=>fail('CONFLICT',s);
const equal=(a:any,b:any)=>orderSampleDigest(a)===orderSampleDigest(b);
const validWarehouse=(row:any)=>row&&row.deletedAt==null&&row.isActive===true&&['Main','Auxiliary','Temporary'].includes(row.type);
const identity=(actor:TokenPayload)=>{if(!actor?.userId)fail('UNAUTHORIZED','请使用真实当前登录账号。');return orderSampleCommandId(actor.userId);};
const fingerprint=(auth:SampleCustodyAuthorization)=>orderSampleDigest(auth.guard);
const preserved=(card:any)=>exactJsonValue(Object.fromEntries(Object.entries(card).filter(([k])=>!['warehouseId','location','updatedAt'].includes(k))));
const position=(card:any)=>({warehouseId:card.warehouseId??null,location:card.location??null,updatedAt:String(card.updatedAt)});
const lockedTables={case:'DevelopmentCase',relation:'Relation',batch:'SampleBatch',order:'Order',asset:'ProductAsset',warehouse:'Warehouse',sample:'Sample',card:'SampleCardItem'};
const kinds=Object.keys(lockedTables) as SampleCustodyLockRef['kind'][];
async function lockUnion(tx:any,auth:SampleCustodyAuthorization,targetId:string){
  const refs=new Map<string,SampleCustodyLockRef>();for(const r of [...auth.lockRefs,{kind:'warehouse' as const,id:targetId}])refs.set(`${r.kind}:${r.id}`,r);
  for(const ref of [...refs.values()].sort((a,b)=>kinds.indexOf(a.kind)-kinds.indexOf(b.kind)||a.id.localeCompare(b.id)))
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${lockedTables[ref.kind]}"`)} WHERE "id"=${ref.id} FOR UPDATE`);
}
async function requestLock(tx:any,id:string){await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))::text`);}
async function access(db:any,actor:TokenPayload,cardId:string,mode:'read'|'write'){
  const auth=await authorizeSampleCustody({db,actor,subject:{kind:'card',id:cardId},mode});
  if(auth.visibility!=='full')fail('NOT_FOUND','实物不存在或不可见。');
  const card=await db.sampleCardItem.findUnique({where:{id:cardId}});if(!card||card.deletedAt!=null)fail('NOT_FOUND','实物不存在或不可见。');return {auth,card};
}
async function stockGate(db:any,card:any):Promise<string|null>{
  if(card.status!=='in_stock'||!Number.isSafeInteger(card.quantity)||card.quantity<1||card.availableQty!==card.quantity)return '仅可整组移动全部在库的实物。';
  const active=await db.sampleCardLoan.findMany({where:{itemId:card.id,loanType:'borrow',returnedAt:null},select:{id:true},take:1});
  return active.length?'尚有未归还借出，请完整归还后移位。':null;
}
export function createSampleCardMoveService({prisma,clock=Date.now}:{prisma:any;clock?:()=>number}){
  async function outcome(tx:any,actor:TokenPayload,cardId:string,input:SampleCardMoveInput):Promise<SampleCardMoveRecovery>{
    await access(tx,actor,cardId,'read');const cmd=sampleCardMoveCommand(identity(actor),cardId,input),hash=orderSampleDigest(cmd),id=sampleCardMoveReceiptId(actor.userId,input.requestKey);
    const base={moveVersion:1 as const,actorId:actor.userId,cardId,requestKey:input.requestKey,commandHash:hash,requestInput:input};
    const row=await tx.auditLog.findUnique({where:{id}});if(!row)return{...base,outcome:'not_confirmed',auditId:null};
    const d=row.detail;if(row.id!==id||row.actorId!==actor.userId||row.targetType!=='SampleCardItem'||row.targetId!==cardId||row.transactionId!==id||!(row.createdAt instanceof Date)||d?.protocol!==PROTOCOL||d.source!==SOURCE||!equal(d.command,cmd)||d.commandHash!==hash)conflict('移位请求标识已用于其他完整命令或原审计不完整。');
    if(row.action===CANCELLED){if(row.operationType!=='cancel'||d.outcome!=='cancelled')conflict('原取消凭据不完整。');return{...base,outcome:'cancelled',auditId:id};}
    const ack=d.ack as SampleCardMoveAck;
    if(row.action!==MOVED||row.operationType!=='update'||row.fieldPath!=='warehouseId,location'||!ack||d.ackHash!==orderSampleDigest(ack)||ack.moveVersion!==1||ack.outcome!=='moved'||ack.actorId!==actor.userId||ack.cardId!==cardId||ack.requestKey!==input.requestKey||ack.auditId!==id||ack.commandHash!==hash||!equal(ack.requestInput,input)||ack.createdAt!==String(row.createdAt.getTime())||!equal(d.before,ack.before)||!equal(d.after,ack.after)||ack.before.updatedAt!==input.expectedUpdatedAt||ack.after.warehouseId!==input.targetWarehouseId||ack.after.location!==input.targetLocation||! /^(0|[1-9]\d*)$/.test(ack.after.updatedAt)||BigInt(ack.after.updatedAt)<=BigInt(ack.before.updatedAt)||typeof ack.preservedCardHash!=='string'||! /^[a-f0-9]{64}$/.test(ack.preservedCardHash))conflict('原移位事实或完整回执被改变。');
    // Later stock/position changes do not rewrite this original move receipt.
    return{...base,outcome:'moved',auditId:id,ack};
  }
  async function context(actor:TokenPayload,rawCardId:unknown){
    identity(actor);const cardId=orderSampleCommandId(rawCardId);
    const result=await prisma.$transaction(async(tx:any)=>{
      const read=await access(tx,actor,cardId,'read');let write:Awaited<ReturnType<typeof access>>|null=null,reason:string|null=null;
      try{write=await access(tx,actor,cardId,'write');}catch(e:any){if(e instanceof SampleCustodyAuthorizationError && e.code==='FORBIDDEN'&&e.status===403)reason='当前账号没有整组移位权限。';else throw e;}
      reason??=await stockGate(tx,read.card);
      const warehouses=await tx.warehouse.findMany({where:{deletedAt:null,isActive:true,type:{in:['Main','Auxiliary','Temporary']}},select:{id:true,code:true,name:true,type:true},orderBy:[{sortOrder:'asc'},{id:'asc'}],take:257});if(warehouses.length>256)conflict('仓库候选超出读取预算，请整理仓库配置。');if(!warehouses.length)reason??='尚未配置有效实际仓库。';
      return{guard:read.auth.guard,data:{moveVersion:1 as const,cardId,code:read.card.code,position:position(read.card),preservedCardHash:orderSampleDigest(preserved(read.card)),expectedUpdatedAt:String(read.card.updatedAt),expectedCustodyFingerprint:fingerprint(write?.auth??read.auth),warehouses,capabilities:{canMove:!!write&&!reason,reason}}};
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
    await recheckSampleCustodyAuthorization({currentPrisma:prisma,actor,guard:result.guard});return result.data;
  }
  async function recover(actor:TokenPayload,rawCardId:unknown,raw:unknown){identity(actor);const cardId=orderSampleCommandId(rawCardId),input=parseSampleCardMoveInput(raw);const result=await prisma.$transaction(async(tx:any)=>{await requestLock(tx,sampleCardMoveReceiptId(actor.userId,input.requestKey));return outcome(tx,actor,cardId,input);},{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});await access(prisma,actor,cardId,'read');return result;}
  async function cancel(actor:TokenPayload,rawCardId:unknown,raw:unknown){identity(actor);const cardId=orderSampleCommandId(rawCardId),input=parseSampleCardMoveInput(raw);const result=await prisma.$transaction(async(tx:any)=>{const id=sampleCardMoveReceiptId(actor.userId,input.requestKey);await requestLock(tx,id);const existing=await outcome(tx,actor,cardId,input);if(existing.outcome!=='not_confirmed')return existing;const ms=clock();if(!Number.isSafeInteger(ms)||ms<0)throw Error('MOVE_CLOCK_INVALID');const command=sampleCardMoveCommand(actor.userId,cardId,input);await tx.auditLog.create({data:{id,actorId:actor.userId,action:CANCELLED,targetType:'SampleCardItem',targetId:cardId,transactionId:id,operationType:'cancel',createdAt:new Date(ms),detail:{protocol:PROTOCOL,source:SOURCE,command,commandHash:existing.commandHash,outcome:'cancelled'}}});return outcome(tx,actor,cardId,input);},{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,timeout:20000});await access(prisma,actor,cardId,'read');return result;}
  async function move(actor:TokenPayload,rawCardId:unknown,raw:unknown):Promise<SampleCardMoveAck>{
    identity(actor);const cardId=orderSampleCommandId(rawCardId),input=parseSampleCardMoveInput(raw);
    const ack=await prisma.$transaction(async(tx:any)=>{
      const id=sampleCardMoveReceiptId(actor.userId,input.requestKey);await requestLock(tx,id);const original=await outcome(tx,actor,cardId,input);
      if(original.outcome==='moved')return original.ack!;if(original.outcome==='cancelled')conflict('原移位请求已明确取消，不能迟到执行。');
      const before=await access(tx,actor,cardId,'write');const target=await tx.warehouse.findUnique({where:{id:input.targetWarehouseId}});if(!validWarehouse(target))fail('INVALID_INPUT','请选择有效实际仓库，虚拟、停用或已删除仓库不能存放实物。');
      await lockUnion(tx,before.auth,input.targetWarehouseId);const after=await access(tx,actor,cardId,'write');assertSampleCustodyGuardStable(before.auth.guard,after.auth.guard);
      const currentTarget=await tx.warehouse.findUnique({where:{id:input.targetWarehouseId}});if(!validWarehouse(currentTarget)||!equal(exactJsonValue(target),exactJsonValue(currentTarget)))conflict('锁定期间目标仓库已变化，请刷新。');
      const card=after.card;if(String(card.updatedAt)!==input.expectedUpdatedAt||fingerprint(after.auth)!==input.expectedCustodyFingerprint)conflict('实物版本或归属已变化，请核对原请求后刷新。');
      // All custody loan writers lock Card first. No active borrow may move,
      // including stale in_stock projections after only partial borrowing.
      const loans=await tx.sampleCardLoan.findMany({where:{itemId:cardId,loanType:'borrow',returnedAt:null},orderBy:{id:'asc'},select:{id:true}});for(const loan of loans)await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleCardLoan" WHERE "id"=${loan.id} FOR UPDATE`);
      const gate=await stockGate(tx,card);if(gate)conflict(gate);if(card.warehouseId===input.targetWarehouseId&&(card.location??null)===input.targetLocation)conflict('实物已经在此仓库与架位，无需重复移位。');
      const ms=clock();if(!Number.isSafeInteger(ms)||ms<0)throw Error('MOVE_CLOCK_INVALID');const old=BigInt(card.updatedAt),updatedAt=BigInt(ms)>old?BigInt(ms):old+BigInt(1);if(updatedAt>BigInt('9223372036854775807'))conflict('实物版本已超出可写范围。');
      const cmd=sampleCardMoveCommand(actor.userId,cardId,input),ack:SampleCardMoveAck={moveVersion:1,outcome:'moved',actorId:actor.userId,cardId,requestKey:input.requestKey,commandHash:orderSampleDigest(cmd),requestInput:input,auditId:id,createdAt:String(ms),before:position(card),after:{warehouseId:input.targetWarehouseId,location:input.targetLocation,updatedAt:String(updatedAt)},preservedCardHash:orderSampleDigest(preserved(card))};
      const changed=await tx.sampleCardItem.updateMany({where:{id:cardId,deletedAt:null,updatedAt:card.updatedAt,status:'in_stock',quantity:card.quantity,availableQty:card.quantity},data:{warehouseId:input.targetWarehouseId,location:input.targetLocation,updatedAt}});if(changed.count!==1)conflict('实物库存或位置版本已变化。');
      await tx.auditLog.create({data:{id,actorId:actor.userId,action:MOVED,targetType:'SampleCardItem',targetId:cardId,transactionId:id,operationType:'update',fieldPath:'warehouseId,location',createdAt:new Date(ms),detail:{protocol:PROTOCOL,source:SOURCE,command:cmd,commandHash:ack.commandHash,before:ack.before,after:ack.after,ack,ackHash:orderSampleDigest(ack)}}});
      await access(tx,actor,cardId,'write');return ack;
    },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,timeout:20000});await access(prisma,actor,cardId,'read');return ack;
  }
  return{context,move,recover,cancel};
}
