import { Prisma, type PrismaClient } from '@prisma/client';
import { createCreditService } from '../credit/creditService';
import { createCreditExceptionService, resolveCreditException, consumeCreditException } from '../credit/creditExceptionGate';
import type { ExceptionService } from '../exceptions/exceptionService';
import type { ActiveExceptionSummary, ExceptionScopeMatch } from '../exceptions/exceptionGate';
import { createMoqConfigService, type MoqSnapshot } from '../moq/moqConfigService';
import { isValidSnapshot, createMoqResolutionService } from '../moq/moqResolutionService';
import { createMoqValidationService } from '../moq/moqValidationService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createApprovalRoutingService, NO_REVIEWER_RESOLVED } from '../approvals/approvalRoutingService';
import { businessError } from '../shared/errorCodes';
import { logger } from '../lib/logger';
import { exactJsonValue } from '../lib/exactJsonValue';
export type ConversionCreditPass = { service:ExceptionService;exception:ActiveExceptionSummary;scope:ExceptionScopeMatch };
export type ConversionCommercialPreparation={customerRelationId:string|null;creditException:ConversionCreditPass|null};
type ConversionCreditStatus={blocked:boolean;blockCode:string|null;blockReason:string|null;[key:string]:unknown};
const check=async(db:any,customerRelationId:string|null,amount:number):Promise<ConversionCreditStatus|null>=>{
 if(!customerRelationId)return null;
 try{const r=await createCreditService({prisma:db}).checkCreditAvailable({relationId:customerRelationId,amount:amount||undefined});if(!r.ok||!r.data||typeof (r.data as any).blocked!=='boolean')throw Error('CREDIT_READ_FAILED');return r.data as ConversionCreditStatus;}
 catch(e){logger.error('[ConversionCommercial] actual credit read failed',{error:e instanceof Error?e.message:String(e)});throw businessError('CREDIT_CHECK_FAILED','当前客户信用未能核验，订单未确认，请稍后重试。');}
};
/** Outside the business transaction only: a blocked action may create the existing
 * controlled exception request, never an Order or a fabricated approval. */
export async function prepareOrderConversionCommercial(db:PrismaClient,actorId:string,customerRelationId:string|null,amount:number):Promise<ConversionCommercialPreparation>{
 const data=await check(db,customerRelationId,amount);let creditException:ConversionCreditPass|null=null;
 if(data?.blocked){let storageFault=false;
  const strictClient=(target:any):any=>new Proxy(target,{get(object,key){const value=Reflect.get(object,key);
   if(key==='$transaction')return async(...args:any[])=>{if(storageFault)throw businessError('CREDIT_CHECK_FAILED','信用例外暂不可核验。');const fn=args[0];const forwarded=typeof fn==='function'?[async(tx:any)=>fn(strictClient(tx)),...args.slice(1)]:args;try{return await Reflect.apply(value,object,forwarded);}catch(e:any){if(typeof e?.statusCode!=='number'&&e?.code!==NO_REVIEWER_RESOLVED)storageFault=true;throw e;}};
   if(!value||typeof value!=='object')return value;return new Proxy(value,{get(delegate,method){const fn=Reflect.get(delegate,method);if(typeof fn!=='function')return fn;return async(...args:any[])=>{if(storageFault)throw businessError('CREDIT_CHECK_FAILED','信用例外暂不可核验。');try{return await Reflect.apply(fn,delegate,args)}catch(e){storageFault=true;logger.error('[ConversionCommercial] actual exception storage failure',{error:e instanceof Error?e.message:String(e)});throw e}};}})}});
  const strict=strictClient(db);
  const service=createCreditExceptionService(strict),scope:ExceptionScopeMatch={targetType:'Relation',targetId:customerRelationId!,action:'order:create'};
  const exemption=await resolveCreditException({exceptionService:service,scope,actorId,blockReason:data.blockReason??'客户信用阻断新订单'});
  if(storageFault)throw businessError('CREDIT_CHECK_FAILED','信用例外状态未能核验，订单未确认，请稍后重试。');
  if(!exemption.passed){const hint=exemption.approvalRequestId?'已发起信用例外审批，请审批通过后重试':exemption.hint.includes('审批中')?'信用例外审批中，请审批通过后重试':'没有有效信用例外，请到审批中心核对或申请';throw Object.assign(businessError(data.blockCode??'CREDIT_BLOCKED',`${data.blockReason??'当前客户信用阻断新订单'}（${hint}）`),{approvalRequestId:exemption.approvalRequestId??null,blockCode:data.blockCode});}
  creditException={service,exception:exemption.exception,scope};
 }
 return{customerRelationId,creditException};
}
/** Called after source locking/current authorization. Snapshot and later quota
 * consumption share the caller's transaction. No current credit means no consume. */
export async function freezeOrderConversionCommercial(tx:any,actorId:string,customerRelationId:string|null,amount:number,prepared:ConversionCommercialPreparation,priorMoqSnapshot?:unknown){
 if(prepared.customerRelationId!==customerRelationId)throw businessError('SOURCE_CHANGED','客户来源已变化，请重新核对后转单。');
 if(customerRelationId)await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CreditLimit" WHERE "relationId"=${customerRelationId} AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE`);
 const credit=await check(tx,customerRelationId,amount),pass=credit?.blocked?prepared.creditException:null;
 if(credit?.blocked&&!pass)throw Object.assign(businessError(credit.blockCode??'CREDIT_BLOCKED','当前客户信用已阻断，订单未确认，请重新核对信用例外。'),{blockCode:credit.blockCode});
 if(pass&&(pass.scope.targetId!==customerRelationId||pass.scope.targetType!=='Relation'||pass.scope.action!=='order:create'))throw businessError('SOURCE_CHANGED','信用例外与实际客户不一致。');
 const snapshot:MoqSnapshot=isValidSnapshot(priorMoqSnapshot as Partial<MoqSnapshot>|null|undefined)?priorMoqSnapshot as MoqSnapshot:await createMoqConfigService({prisma:tx}).buildSnapshot();
 return{moqSnapshot:snapshot,creditEvidence:exactJsonValue(credit),creditException:pass,actorId};
}
export async function consumeOrderConversionCommercial(tx:any,commercial:Awaited<ReturnType<typeof freezeOrderConversionCommercial>>,orderId:string){
 const pass=commercial.creditException;if(pass)await consumeCreditException({exceptionService:pass.service,exceptionId:pass.exception.id,scope:pass.scope,actorId:commercial.actorId,tx,note:`订单 ${orderId} 建单信用例外同事务核销`});
}
/** Pending creation retains the existing advisory MOQ policy; server snapshot
 * is mandatory, the verdict is a hint and never an invented creation approval. */
export async function orderConversionMoqAdvisory(tx:any,actorId:string,customerRelationId:string|null,type:string,quantity:number|string,unit:string,snapshot:MoqSnapshot,productAssetId?:string){
 try{const configService=createMoqConfigService({prisma:tx}),resolutionService=createMoqResolutionService({prisma:tx,configService});return await createMoqValidationService({prisma:tx,configService,resolutionService,approvalCreateService:createApprovalCreateService({prisma:tx,routingService:createApprovalRoutingService({prisma:tx})})}).validateCreate({type,customerRelationId,snapshot,lines:[{quantity,unit,...(productAssetId?{productAssetId}:{})}]},{actor:{userId:actorId}});}
 catch(e){logger.warn('[ConversionCommercial] MOQ advisory temporarily unavailable',{error:e instanceof Error?e.message:String(e)});return null;}
}
