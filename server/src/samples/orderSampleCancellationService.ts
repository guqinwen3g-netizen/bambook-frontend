import {Prisma} from '@prisma/client';
import type {TokenPayload} from '../auth/service';
import {hasScope} from '../auth/permissionService';
import {freshOrderLineScope} from '../orders/orderLineWriteAccess';
import {DevelopmentDomainError} from '../development/developmentOperationalGuard';
import {currentRegistrationActor} from './sampleRegistrationContextService';
import {parseOrderSampleRegister,parseOrderSampleAppend} from './orderSampleCommandContract';
import {orderSampleDigest,OrderSampleContractError} from './orderSampleSourceContract';
import {loadOrderSampleRecord,OrderSampleRecordError} from './orderSampleRecordReader';
const fail=(code:string,message:string):never=>{throw new DevelopmentDomainError(code,message);};
const protocol='order_sample_command_cancel_v1',marker='route:samples:order-native:cancel';
export function parseOrderSampleCancellation(raw:unknown){
  const r=raw as any;
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='command,operation'||!['register','events'].includes(r.operation))fail('INVALID_INPUT','请保留原请求内容，明确取消原登记或事件请求。');
  const operation=r.operation==='register'?'register':'append';
  const input=operation==='register'?parseOrderSampleRegister(r.command):parseOrderSampleAppend(r.command);
  const requestInput={operation,input};
  return {operation,input,requestInput,commandHash:orderSampleDigest(requestInput)};
}
/** Call after the same actor/key advisory lock and fresh authentication. The
 * table is mandatory: missing storage must fail closed, never bypass a cancel. */
export async function assertOrderSampleCommandNotCancelled(db:any,actorId:string,key:string){
  const row=await db.orderSampleCommandCancellation.findUnique({where:{actorId_requestKey:{actorId,requestKey:key}},select:{id:true}});
  if(row)fail('CONFLICT','原请求已明确取消，请使用新的请求标识开始新操作。');
}
function ledgerFact(row:any){return {id:row.id,protocolVersion:row.protocolVersion,actorId:row.actorId,requestKey:row.requestKey,operation:row.operation,orderId:row.orderId,sourceId:row.sourceId,commandHash:row.commandHash,requestInput:row.requestInput,auditId:row.auditId,createdAt:String(row.createdAt)};}
async function originalCancellation(db:any,row:any){
  const audit=await db.auditLog.findUnique({where:{id:row.auditId}}),fact=ledgerFact(row);
  const expected={protocolVersion:1,outcome:'cancelled',actorId:row.actorId,requestKey:row.requestKey,orderId:row.orderId,commandHash:row.commandHash,requestInput:row.requestInput,cancellationId:row.id,auditId:row.auditId};
  if(row.protocolVersion!==1||row.commandHash!==orderSampleDigest(row.requestInput)||orderSampleDigest(row.receipt)!==row.receiptHash||orderSampleDigest(row.receipt)!==orderSampleDigest(expected)||
    !audit||audit.actorId!==row.actorId||audit.action!=='cancel_order_sample_command'||audit.targetType!=='OrderSampleCommandCancellation'||audit.targetId!==row.id||audit.transactionId!==row.id||!(audit.createdAt instanceof Date)||String(audit.createdAt.getTime())!==fact.createdAt||
    audit.detail?.protocol!==protocol||audit.detail?.source!==marker||orderSampleDigest(audit.detail?.after)!==orderSampleDigest({fact,receipt:expected}))fail('CONFLICT','原取消记录或审计未能完整核对，请联系管理员。');
  return row.receipt;
}
export function createOrderSampleCancellationService({prisma,clock=Date.now}:{prisma:any;clock?:()=>number}){
  async function authority(db:any,prior:TokenPayload|null|undefined){
    if(!prior?.userId)fail('UNAUTHORIZED','请使用当前登录账号核对原请求。');
    const actor=await currentRegistrationActor(db,prior,'read');
    if(!hasScope({...actor,roles:[]},'orders:read'))fail('FORBIDDEN','当前账号没有订单读取权限。');
    return actor;
  }
  async function authorizeOrder(db:any,actor:TokenPayload,orderId:string){
    const scope=await freshOrderLineScope(db,actor);
    if(!await db.order.findFirst({where:{id:orderId,deletedAt:null,AND:[scope]},select:{id:true}}))fail('NOT_FOUND','订单不存在或不在当前可见范围。');
  }
  async function cancel(prior:TokenPayload|null|undefined,raw:unknown){
    const parsed=parseOrderSampleCancellation(raw),key=parsed.input.requestKey;
    if(!prior?.userId)fail('UNAUTHORIZED','请使用当前登录账号核对原请求。');
    const authenticatedActorId=prior!.userId;
    return prisma.$transaction(async(tx:any)=>{
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`order-sample-v1:${authenticatedActorId}:${key}`},0))::text`);
      const actor=await authority(tx,prior);
      let orderId:string,sourceId:string|null=null;
      if(parsed.operation==='register')orderId=(parsed.input as any).orderId;
      else{
        sourceId=(parsed.input as any).sourceId;
        const source=await tx.orderSampleSource.findUnique({where:{id:sourceId},select:{id:true,orderId:true}});
        if(!source)fail('NOT_FOUND','样品来源不存在或不可见。');
        orderId=source.orderId;
      }
      await authorizeOrder(tx,actor,orderId);
      const ledger=await tx.orderSampleCommandCancellation.findUnique({where:{actorId_requestKey:{actorId:actor.userId,requestKey:key}}});
      const events=await tx.orderSampleEvent.findMany({where:{protocolVersion:1,actorId:actor.userId,requestKey:key},take:2});
      if(events.length>1||ledger&&events.length)fail('CONFLICT','原请求状态冲突，请联系管理员核对。');
      if(ledger){
        if(ledger.orderId!==orderId||ledger.commandHash!==parsed.commandHash||orderSampleDigest(ledger.requestInput)!==orderSampleDigest(parsed.requestInput))fail('CONFLICT','请求标识已用于不同内容，不能改写原取消记录。');
        return originalCancellation(tx,ledger);
      }
      if(events.length){
        const event=events[0],header=await tx.orderSampleSource.findUnique({where:{id:event.sourceId},select:{orderId:true}});
        if(!header||header.orderId!==orderId)fail('CONFLICT','请求标识已用于不同业务，请保留原请求内容。');
        const record=await loadOrderSampleRecord(tx,event.sourceId);
        const audit=await tx.auditLog.findUnique({where:{id:event.auditId}});
        if(!audit||audit.detail?.requestHash!==parsed.commandHash||orderSampleDigest(audit.detail?.requestInput)!==orderSampleDigest(parsed.requestInput))fail('CONFLICT','请求标识已用于不同内容，不能取消另一项操作。');
        const ack=record.acknowledgements.find(a=>a.eventId===event.id);
        if(!ack)fail('CONFLICT','原成功回执无法完整核对。');
        return {protocolVersion:1,outcome:'committed',actorId:actor.userId,requestKey:key,orderId,commandHash:parsed.commandHash,requestInput:parsed.requestInput,ack};
      }
      const now=clock();if(!Number.isSafeInteger(now)||now<=0)fail('CONFLICT','服务器事实时间无效。');
      const identity=orderSampleDigest({protocolVersion:1,actorId:actor.userId,requestKey:key}),id=`OSCANCEL__${identity}`,auditId=`OSCANCELA__${identity}`;
      const receipt={protocolVersion:1,outcome:'cancelled',actorId:actor.userId,requestKey:key,orderId,commandHash:parsed.commandHash,requestInput:parsed.requestInput,cancellationId:id,auditId};
      const fact={id,protocolVersion:1,actorId:actor.userId,requestKey:key,operation:parsed.operation,orderId,sourceId,commandHash:parsed.commandHash,requestInput:parsed.requestInput,auditId,createdAt:String(now)};
      await tx.auditLog.create({data:{id:auditId,actorId:actor.userId,action:'cancel_order_sample_command',targetType:'OrderSampleCommandCancellation',targetId:id,transactionId:id,createdAt:new Date(now),detail:{protocol,source:marker,after:{fact,receipt}}}});
      await tx.orderSampleCommandCancellation.create({data:{...fact,createdAt:BigInt(now),receipt,receiptHash:orderSampleDigest(receipt)}});
      await originalCancellation(tx,await tx.orderSampleCommandCancellation.findUnique({where:{id}}));
      return receipt;
    },{isolationLevel:'ReadCommitted',timeout:30000});
  }
  return {cancel:async(actor:TokenPayload|null|undefined,raw:unknown)=>{try{return await cancel(actor,raw);}catch(e){if(e instanceof OrderSampleRecordError)fail('CONFLICT','原成功记录未能完整核对，请联系管理员。');if(e instanceof OrderSampleContractError)fail('INVALID_INPUT',e.message);throw e;}}};
}
