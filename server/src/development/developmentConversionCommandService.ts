import {factoryRelationIdentitySelect,isUsableFactoryRelation} from '../suppliers/factoryRelationIdentity';
import {loadConfirmedDevelopmentSpec} from './confirmedDevelopmentSpec';
import {logger} from '../lib/logger';
import {Prisma,PrismaClient} from '@prisma/client';
import type{TokenPayload}from'../auth/service';
import{businessError,lookupErrorCode}from'../shared/errorCodes';
import{authorizeDevelopmentConversion,conversionAuthorityRead}from'./developmentConversionAuthority';
import{convertDevCaseToOrder,resolveConfirmedSource}from'./convertService';
import{prepareOrderConversionCommercial}from'../orders/orderConversionCommercial';
import{createOrderConversionCommandLedger,type ConversionLedgerTx,type ConversionVerifiedExecutionContext}from'../orders/orderConversionCommandLedger';
import{createOrderConversionContextPreparation}from'../orders/orderConversionContextPreparation';
import{currentOrderConversionReader,assertOrderConversionCustomerRead,assertOrderConversionTargetRead}from'../orders/orderConversionReadAuthority';
import{isValidSnapshot}from'../moq/moqResolutionService';
import{MOQ_FALLBACK_CONSTANTS}from'../moq/moqConfigService';
import{ORDER_CONVERSION_PROTOCOL,conversionCanonical,conversionContextAuditId,conversionDigest,conversionMoqBasisFingerprint,parseConversionInput,conversionDecimal,type ConversionContext,type ConversionContextSelection,type ConversionInput,type ConversionJson,type ConversionOrderSnapshot,type ConversionRowSnapshot,type ConversionOriginal}from'../orders/orderConversionCommandContract';
export function conversionPlain(value:any):any{
 if(value instanceof Date)return value.toISOString();if(typeof value==='bigint')return value.toString();
 if(value&&typeof value==='object'&&typeof value.toFixed==='function')return value.toString();
 if(Array.isArray(value))return value.map(conversionPlain);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,conversionPlain(v)]));return value;
}
const snapshot=(value:any):ConversionRowSnapshot=>({id:value.id,record:conversionPlain(value)});
const orderSnapshot=(value:any):ConversionOrderSnapshot=>({id:value.id,record:{...conversionPlain(value),quantity:value.quantity==null?null:String(value.quantity),unit:value.unit??null}});
const conflict=(message='原转单准备或来源已变化，请保留原请求并核对。'):never=>{throw businessError('CONFLICT',message);};
function exactNumber(value:string,allowZero=false){const n=Number(value);if(!Number.isFinite(n)||new Prisma.Decimal(value).cmp(new Prisma.Decimal(n))!==0||!allowZero&&n<=0)conflict('当前转单金额或数量不能准确写入，请保留原数值。');return n;}
function ensureCreate(input:ConversionInput){if(input.source.type!=='development'||!['development_create','development_link'].includes(input.operation))throw businessError('INVALID_INPUT','请使用已安装的开发转单命令。');return input;}
function selected(raw:any){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='id,type'||!['primary_asset','Asset','Sample','SealSample'].includes(raw.type)||typeof raw.id!=='string'||!raw.id||raw.id!==raw.id.trim())throw businessError('INVALID_INPUT','请选择真实主档案或已确认成果。');return{type:raw.type,id:raw.id} as const;}
export function parseDevelopmentConversionSelection(raw:any):ConversionContextSelection{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw businessError('INVALID_INPUT','转单准备操作不完整。');
 if(raw.operation==='development_create'&&Object.keys(raw).sort().join(',')==='operation,selectedSource')return{operation:'development_create',selectedSource:selected(raw.selectedSource)};
 if(raw.operation==='development_link'&&Object.keys(raw).sort().join(',')==='operation,orderId,selectedSource'&&typeof raw.orderId==='string'&&raw.orderId.trim()===raw.orderId&&raw.orderId)return{operation:'development_link',orderId:raw.orderId,selectedSource:selected(raw.selectedSource)};
 throw businessError('INVALID_INPUT','转单准备操作不完整。');
}
export function createDevelopmentConversionCommandService(prisma:PrismaClient){
 async function authorizeRead(tx:any,prior:TokenPayload,caseId:string,target:string|null){
  const actor=await currentOrderConversionReader(tx,prior,'development');
  const source=await conversionAuthorityRead(tx,strict=>strict.developmentCase.findFirst({where:{id:caseId,deletedAt:null}})) as any;
  if(!source)throw businessError('NOT_FOUND','开发来源不存在或不可见。');
  await assertOrderConversionCustomerRead(tx,actor,source.customerRelationId??null,source.owner??null);
  if(target)await assertOrderConversionTargetRead(tx,actor,target);
  return{source,actor};
 }
 async function loadContext(tx:ConversionLedgerTx,prior:TokenPayload,source:{type:'development'|'quotation';id:string},selection:ConversionContextSelection){
  if(source.type!=='development'||selection.operation==='quotation_create')throw businessError('INVALID_INPUT','开发转单准备操作不匹配。');
  await tx.$queryRawUnsafe('SELECT "id" FROM "DevelopmentCase" WHERE "id"=$1 AND "deletedAt" IS NULL FOR UPDATE',source.id);
  const {source:caseRow,actor:readActor}=await authorizeRead(tx,prior,source.id,selection.operation==='development_link'?selection.orderId:null);
  if(selection.selectedSource.type==='primary_asset'&&caseRow.productAssetId!==selection.selectedSource.id)conflict('所选主档案与开发案不一致。');
  const resolved=await resolveConfirmedSource({prisma:tx as any,caseId:source.id,confirmedSourceType:selection.selectedSource.type==='primary_asset'?'Asset':selection.selectedSource.type,confirmedSourceId:selection.selectedSource.id});
  if(!resolved.ok)throw businessError('CONFLICT',resolved.error.message);
  const asset=await (tx as any).productAsset.findUnique({where:{id:resolved.data.productAssetId}}),family=String(asset?.mainCategory??'').toLowerCase();
  if(!asset||!['fabric','garment'].includes(family)||(caseRow.type==='fabric'?'fabric':['garment','pp'].includes(caseRow.type)?'garment':null)!==family)conflict('当前档案业务类型不可用。');
  const profile=await(family==='fabric'?(tx as any).fabricProfile:(tx as any).garmentProfile).findUnique({where:{productAssetId:asset.id}});
  if(!profile||profile.deletedAt!=null)conflict('当前档案规格不可用。');
  const factoryId=resolved.data.millRelationId,factory=factoryId?await tx.relation.findFirst({where:{id:factoryId,deletedAt:null},select:factoryRelationIdentitySelect}):null;
  if(factoryId&&!isUsableFactoryRelation(factory))conflict('实际工厂身份已不可用。');
  const customer=caseRow.customerRelationId?await tx.relation.findFirst({where:{id:caseRow.customerRelationId,deletedAt:null},select:{id:true,name:true,ownerId:true,salesRepIds:true,deletedAt:true}}):null;
  const config=await tx.moqThresholdConfig.findFirst({where:{isActive:true},orderBy:{effectiveFrom:'desc'}});
  // SQL failures propagate; only an actual empty active result uses policy fallback.
  const moqSnapshot:any=config?{fabricDefaultMoq:config.fabricDefaultMoq,garmentDefaultMoq:config.garmentDefaultMoq,capsuleMoq:config.capsuleMoq,snapshotAt:new Date().toISOString(),source:'moq_config',configId:config.id}:{...MOQ_FALLBACK_CONSTANTS,snapshotAt:new Date().toISOString(),source:'fallback_constant',configId:null};
  if(!isValidSnapshot(moqSnapshot))conflict('当前 MOQ 配置不能核定。');
  const sourceRow=snapshot(caseRow),configRow=config?snapshot(config):null;
  const confirmed=['Sample','SealSample'].includes(selection.selectedSource.type);const selectedRow=confirmed?await(selection.selectedSource.type==='Sample'?(tx as any).sample:(tx as any).sealSample).findUnique({where:{id:selection.selectedSource.id}}):asset;if(!selectedRow)conflict('所选确认成果不可用。');const confirmedEvidence=confirmed?{sampleOriginProof:resolved.data.specSnapshot.sampleOriginProof??null,confirmedSpecSnapshot:conversionPlain(resolved.data.specSnapshot),confirmedSpecification:resolved.data.specSnapshot.confirmedSpecification}:null;
  const anchors:any={source:sourceRow,selectedResult:snapshot(selectedRow),selectedResultEvidence:confirmedEvidence,asset:snapshot(asset),profile:{family,...snapshot(profile)},factory:factory?snapshot(factory):null,customer:customer?snapshot(customer):null,moq:{snapshot:moqSnapshot,approvedExemption:null,config:configRow,basisFingerprint:conversionMoqBasisFingerprint(caseRow.id,null,configRow)},quotationLines:[]};
  let canExecute=caseRow.stage==='approved'&&!!factory,reason:string|null=canExecute?null:'开发成果或实际工厂尚未核定。';
  try{await authorizeDevelopmentConversion(tx,prior.userId,prior,source.id);}catch(e:any){if(!['FORBIDDEN','NOT_FOUND'].includes(e?.code))throw e;canExecute=false;reason=e?.code==='FORBIDDEN'?'当前账号没有开发转单写权限。':'当前业务来源不在可操作范围。';}
  let before:any={orderBefore:null,targetBefore:null};let defaults:any={quantity:'',unit:family==='garment'?'PC':'M',dueDate:'',quoteAmount:null,selectedSource:selection.selectedSource,millRelationId:factory?.id??'',orderPo:null};
  if(selection.operation==='development_link'){
   await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE',selection.orderId);
   const target=await tx.order.findUniqueOrThrow({where:{id:selection.orderId}});if((target.customerRelationId??null)!==(caseRow.customerRelationId??null)||String(target.type).toLowerCase()!==family)conflict('关联订单与开发客户或业务线不一致。');
   const lines=await tx.orderLine.findMany({where:{orderId:target.id},orderBy:{lineNumber:'asc'}}),stages=await tx.productionStage.findMany({where:{orderId:target.id},orderBy:{stageSeq:'asc'}});
   before={orderBefore:orderSnapshot(target),targetBefore:{lines:lines.map(l=>({id:l.id,record:{...conversionPlain(l),quantity:l.quantity.toString()}})),productionStages:stages.map(snapshot)}};
   defaults={orderId:target.id,expectedTarget:{updatedAt:String(target.updatedAt),contentFingerprint:conversionDigest({order:before.orderBefore,...before.targetBefore})},selectedSource:selection.selectedSource,millRelationId:factory?.id??''};
  }
  const context:ConversionContext={conversionVersion:1,protocolInstalled:true,preparation:{state:'preview',auditId:null},source:{type:'development',id:source.id,expected:{updatedAt:String(caseRow.updatedAt),quotationVersion:null,contentFingerprint:conversionDigest(anchors)}},selection,anchors,defaults,capabilities:{canExecute,canRecover:true,canCancelUnexecuted:true,reason},quantityCapabilities:{protocol:'decimal18_4',writeSchema:'decimal18_4',supportsFractional:true,mixedQuotationUnits:true,supportedUnits:['M','YD','KG','G','PC','SET','ROLL','DOZEN']},priorConversion:{kind:'none',orderId:null}};
  return{context,before};
 }
 const preparation=createOrderConversionContextPreparation(loadContext);
 async function loadPrepared(tx:any,prior:TokenPayload,input:ConversionInput):Promise<ConversionVerifiedExecutionContext>{
  const audit=await tx.auditLog.findUnique({where:{id:conversionContextAuditId(prior.userId,input.source,input.operation==='development_link'?{orderId:input.parameters.orderId,contentFingerprint:input.parameters.expectedTarget.contentFingerprint}:undefined)}});
  const context=audit?.detail?.context;
  if(!audit||audit.actorId!==prior.userId||audit.action!=='prepare_order_conversion_command'||audit.targetType!=='development'||audit.targetId!==input.source.id||audit.detail?.protocol!==ORDER_CONVERSION_PROTOCOL||!context||conversionDigest(context.sourceAnchors)!==input.source.expected.contentFingerprint)conflict();
  const activeConfig=await tx.moqThresholdConfig.findFirst({where:{isActive:true},orderBy:{effectiveFrom:'desc'}});if(conversionCanonical(activeConfig?snapshot(activeConfig):null)!==conversionCanonical(context.sourceAnchors.moq.config))conflict();
  if(input.operation!=='quotation_create'&&['Sample','SealSample'].includes(input.parameters.selectedSource.type)){
   const selected=input.parameters.selectedSource,table=selected.type==='Sample'?'Sample':'SealSample';
   await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id"=$1 FOR UPDATE`,selected.id);
   const evidence=context.sourceAnchors.selectedResultEvidence;for(const origin of [...(evidence?.confirmedSpecification?.origins??[])].sort((a:any,b:any)=>a.snapshot.batch.id.localeCompare(b.snapshot.batch.id)))await tx.$queryRawUnsafe('SELECT "id" FROM "SampleBatch" WHERE "id"=$1 FOR UPDATE',origin.snapshot.batch.id);
   const current=await loadConfirmedDevelopmentSpec(tx,{sourceType:selected.type as 'Sample'|'SealSample',sourceId:selected.id,caseId:input.source.id,productAssetId:context.sourceAnchors.asset.id,factoryRelationId:context.sourceAnchors.factory.id});
   if(conversionCanonical(conversionPlain(current.confirmedSpecification))!==conversionCanonical(evidence.confirmedSpecification)||conversionCanonical(conversionPlain(current.specSnapshot))!==conversionCanonical(evidence.confirmedSpecSnapshot))conflict();
  }
  return context;
 }
 const ledger=createOrderConversionCommandLedger({
  authorizeRead:async(tx,actor,input,target)=>{await authorizeRead(tx,actor,input.source.id,target);},
  authorizeExecute:async(tx,actor,input)=>{ensureCreate(input);await authorizeDevelopmentConversion(tx,actor.userId,actor,input.source.id);},
  loadExecutionContextInTx:loadPrepared,
 });
 return{
  async context(actor:TokenPayload,caseId:string,selection:ConversionContextSelection,prepare:boolean){return prisma.$transaction(tx=>prepare?preparation.prepareInTx(tx,actor,{type:'development',id:caseId},selection):preparation.previewInTx(tx,actor,{type:'development',id:caseId},selection));},
  async recover(actor:TokenPayload,raw:unknown){const input=ensureCreate(parseConversionInput(raw));return prisma.$transaction(tx=>ledger.recoverInTx(tx,actor,input));},
  async cancel(actor:TokenPayload,raw:unknown){const input=ensureCreate(parseConversionInput(raw));return prisma.$transaction(tx=>ledger.cancelInTx(tx,actor,input));},
  async execute(actor:TokenPayload,raw:unknown,onCommitted?:(orderId:string)=>void){
   const input=ensureCreate(parseConversionInput(raw));
   const prior=await prisma.$transaction(tx=>ledger.recoverInTx(tx,actor,input));
   if(prior.outcome!=='not_confirmed')return prior;
   const p=input.parameters as any,isCreate=input.operation==='development_create';
   const qty=isCreate?conversionDecimal(p.quantity):0,amount=isCreate&&p.quoteAmount!==null?exactNumber(p.quoteAmount,true):0;
   const authorized=await prisma.$transaction(async tx=>{const scope=await authorizeDevelopmentConversion(tx,actor.userId,actor,input.source.id);const context=await loadPrepared(tx,actor,input);if(conversionCanonical(snapshot(scope.development))!==conversionCanonical(context.sourceBefore))conflict();return scope;});
   const commercial=isCreate?await prepareOrderConversionCommercial(prisma,actor.userId,authorized.development.customerRelationId??null,amount):null;
   let wrote=false;
   const final=await prisma.$transaction(tx=>ledger.executeInTx(tx,actor,input,async(innerTx,_actor,_input,context):Promise<ConversionOriginal>=>{
    const result=await convertDevCaseToOrder({prisma,caseId:input.source.id,mode:isCreate?'autoCreate':'link',orderId:isCreate?undefined:p.orderId,quantity:qty,quoteAmount:amount,dueDate:p.dueDate,orderPo:p.orderPo??undefined,actorId:actor.userId,trustedActor:actor,clientRequestId:input.requestKey,millRelationId:p.millRelationId,...(p.selectedSource.type!=='primary_asset'?{confirmedSourceType:p.selectedSource.type,confirmedSourceId:p.selectedSource.id}:{}),commandExecution:{tx:innerTx as any,commercialPrepared:commercial as any,moqSnapshot:context.sourceAnchors.moq.snapshot,unit:p.unit??'M'}});
    if(!result.ok||!result.data?.case){const failure=businessError(lookupErrorCode(result.error?.code)?result.error!.code:'INTERNAL_ERROR',result.error?.message??'开发转单未完成。');throw Object.assign(failure,...(result.error?.blockCode?[{blockCode:result.error.blockCode}]:[]),...(result.error?.approvalRequestId?[{approvalRequestId:result.error.approvalRequestId}]:[]));}
    wrote=true;
    const order=await innerTx.order.findUniqueOrThrow({where:{id:isCreate?result.data.order.id:p.orderId}}),lines=await innerTx.orderLine.findMany({where:{orderId:order.id},orderBy:{lineNumber:'asc'}}),stages=await innerTx.productionStage.findMany({where:{orderId:order.id},orderBy:{stageSeq:'asc'}}),sourceAfter=await innerTx.developmentCase.findUniqueOrThrow({where:{id:input.source.id}}),audit=await innerTx.auditLog.findUniqueOrThrow({where:{id:result.data.auditId}});
    return{input,sourceBefore:context.sourceBefore,sourceAnchors:context.sourceAnchors,orderBefore:context.orderBefore,targetBefore:context.targetBefore,sourceAfter:snapshot(sourceAfter),orderAfter:orderSnapshot(order),lines:lines.map(l=>({id:l.id,record:{...conversionPlain(l),quantity:l.quantity.toString()}})),productionStages:stages.map(snapshot),businessAudits:[snapshot(audit)],completedAt:new Date().toISOString()};
   }),{timeout:20000});
   if(wrote&&'orderId'in final){try{onCommitted?.(final.orderId);}catch(error){logger.error('[ConversionCommand] committed notification failed',{orderId:final.orderId,receiptAuditId:final.receiptAuditId});}}return final;
  },
 };
}
