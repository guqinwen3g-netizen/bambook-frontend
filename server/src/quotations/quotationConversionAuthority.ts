import type { Quotation, QuotationLine } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import type { BusinessEvent } from '../events/businessEventBus';
import { currentConversionActor, assertConversionCustomerWrite, conversionAuthorityRead, signedConversionCeiling } from '../development/developmentConversionAuthority';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { buildQuotationSnapshot, canonicalQuotationJson } from './quotationApprovalSnapshot';
import { createHash } from 'node:crypto';
export type QuotationConversionContext={mode:'verified_actor';actor:TokenPayload}|{mode:'accepted_event';event:BusinessEvent};
export const quotationConversionFingerprint=(quotation:any)=>createHash('sha256').update(canonicalQuotationJson({quotation:buildQuotationSnapshot(quotation),ownerId:quotation.ownerId??null,departmentId:quotation.departmentId??null})).digest('hex');
const deny=(message:string):never=>{throw new DevelopmentDomainError('SOURCE_CHANGED',message);};
const equal=(a:unknown,b:unknown)=>canonicalQuotationJson(a)===canonicalQuotationJson(b);
export async function authorizeQuotationConversion(db:any,scalarId:string,context:QuotationConversionContext|null|undefined,id:string){
  if(!context)throw new DevelopmentDomainError('UNAUTHORIZED','报价转单或接受须使用已核验的当前凭据。');
  const quotation=await conversionAuthorityRead(db,strict=>strict.quotation.findUnique({where:{id},include:{lines:{orderBy:{lineNumber:'asc'}}}}));
  if(!quotation||(quotation as any).deletedAt!=null)throw new DevelopmentDomainError('NOT_FOUND','报价来源不存在或不可见。');
  let prior:TokenPayload;
  if(context.mode==='verified_actor')prior=context.actor;
  else{
    const e=context.event;if(!e||e.type!=='QuotationAccepted'||e.sourceEntityType!=='Quotation'||e.sourceEntityId!==id||e.actorId!==scalarId)deny('接受事件身份或来源不一致。');
    const job=await conversionAuthorityRead(db,strict=>strict.agentJob.findUnique({where:{id:e.id}}));
    if(!job||(job as any).jobType!=='bev:QuotationAccepted'||!equal((job as any).payload,e))deny('接受事件未能与真实持久任务核对。');
    const d=(e.payload as any)?.conversionDelegation;
    if(!d||d.schemaVersion!==1||d.actorId!==scalarId||d.eventId!==e.id||d.quotationId!==id||!Array.isArray(d.permissionCeiling)||!d.auditId||d.contentFingerprint!==quotationConversionFingerprint(quotation))deny('LEGACY_UNVERIFIED：旧接受记录缺少原凭据与当前来源证明，请人工转单。');
    const audit=await conversionAuthorityRead(db,strict=>strict.auditLog.findUnique({where:{id:d.auditId}}));
    if(!audit||(audit as any).action!=='accept_quotation'||(audit as any).actorId!==scalarId||(audit as any).targetType!=='Quotation'||(audit as any).targetId!==id||(audit as any).operationType!=='transition'||(audit as any).fieldPath!=='status'||(audit as any).beforeValue!=='Sent'||(audit as any).afterValue!=='Accepted'||new Date((audit as any).createdAt).getTime()!==e.occurredAt||(audit as any).detail?.source!=='api:quotation'||!equal((audit as any).detail?.conversionDelegation,d))deny('接受事件没有对应真实接受审计。');
    prior={userId:scalarId,roles:[],departmentIds:[],permissions:[],permissionCeiling:d.permissionCeiling};
  }
  const actor=await currentConversionActor(db,scalarId,prior,'quotations:write');await assertConversionCustomerWrite(db,actor,(quotation as any).customerRelationId,(quotation as any).ownerId);return{actor,quotation:quotation as Quotation & {lines:QuotationLine[]}};
}
export function newQuotationConversionDelegation(actor:TokenPayload,quotation:any,eventId:string,auditId:string){
  const permissionCeiling=signedConversionCeiling(actor);if(permissionCeiling===null)return null;
  return{schemaVersion:1,actorId:actor.userId,quotationId:quotation.id,eventId,auditId,permissionCeiling,contentFingerprint:quotationConversionFingerprint(quotation)};
}
