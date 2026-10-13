import type {TokenPayload} from '../auth/service';
import {isValidSnapshot} from '../moq/moqResolutionService';
import {businessError} from '../shared/errorCodes';
import {ORDER_CONVERSION_PROTOCOL,conversionCanonical,conversionContextAuditId,conversionDigest,type ConversionContext,type ConversionContextSelection} from './orderConversionCommandContract';
import type {ConversionLedgerTx,ConversionVerifiedExecutionContext} from './orderConversionCommandLedger';
export type ConversionContextLoader = (tx:ConversionLedgerTx,actor:TokenPayload,source:{type:'development'|'quotation';id:string},selection:ConversionContextSelection)=>Promise<{context:ConversionContext;before:Pick<ConversionVerifiedExecutionContext,'orderBefore'|'targetBefore'>}>;
const conflict=():never=>{throw businessError('CONFLICT','原转单准备事实无法核实，请重新核对来源。');};
function stableBasis(context:ConversionContext,before:Pick<ConversionVerifiedExecutionContext,'orderBefore'|'targetBefore'>){
 const anchors=JSON.parse(conversionCanonical(context.anchors));
 // A valid historical snapshot, including every historical metadata field, is
 // immutable. Only a newly generated snapshot timestamp is nonsemantic here.
 if(!isValidSnapshot(anchors.source.record.moqSnapshot)&&anchors.moq.snapshot&&typeof anchors.moq.snapshot==='object')delete anchors.moq.snapshot.snapshotAt;
 return {sourceType:context.source.type,sourceId:context.source.id,sourceUpdatedAt:context.source.expected.updatedAt,quotationVersion:context.source.expected.quotationVersion,selection:context.selection.operation==='quotation_create'?{operation:'quotation_create'}:context.selection,anchors,before,defaults:context.selection.operation==='quotation_create'?null:context.defaults,quantityCapabilities:context.quantityCapabilities};
}
/** Loader must perform actual current read authority and read source/selection
 * facts from the DB. GET callers use preview; only POST callers use prepare.
 * This module never opens/nests a transaction or hides a storage failure. */
export function createOrderConversionContextPreparation(load:ConversionContextLoader){
 return {
  async previewInTx(tx:ConversionLedgerTx,actor:TokenPayload,source:{type:'development'|'quotation';id:string},selection:ConversionContextSelection):Promise<ConversionContext>{
   const loaded=await load(tx,actor,source,selection);
   return {...loaded.context,preparation:{state:'preview',auditId:null}};
  },
  async prepareInTx(tx:ConversionLedgerTx,actor:TokenPayload,source:{type:'development'|'quotation';id:string},selection:ConversionContextSelection):Promise<ConversionContext>{
   const loaded=await load(tx,actor,source,selection),context=loaded.context;
   if(context.source.type!==source.type||context.source.id!==source.id||conversionCanonical(context.selection)!==conversionCanonical(selection)||context.source.expected.contentFingerprint!==conversionDigest(context.anchors))conflict();
   const stablePreparationKey=conversionDigest({protocol:ORDER_CONVERSION_PROTOCOL,actorId:actor.userId,basis:stableBasis(context,loaded.before)});
   await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text','OCTX_STABLE_'+stablePreparationKey);
   const prior=await tx.auditLog.findFirst({where:{actorId:actor.userId,action:'prepare_order_conversion_command',targetType:source.type,targetId:source.id,detail:{path:['stablePreparationKey'],equals:stablePreparationKey}},orderBy:{createdAt:'asc'}});
   if(prior){
    const detail=prior.detail as any,saved=detail?.frontendContext as ConversionContext;
    if(prior.operationType!=='create'||detail?.protocol!==ORDER_CONVERSION_PROTOCOL||!saved||prior.id!==conversionContextAuditId(actor.userId,saved.source,saved.selection.operation==='development_link'?{orderId:saved.selection.orderId,contentFingerprint:conversionDigest({order:detail.context?.orderBefore,...detail.context?.targetBefore})}:undefined)||saved.preparation.state!=='prepared'||saved.preparation.auditId!==prior.id||saved.source.expected.contentFingerprint!==conversionDigest(saved.anchors)||conversionCanonical(stableBasis(saved,{orderBefore:detail.context?.orderBefore,targetBefore:detail.context?.targetBefore}))!==conversionCanonical(stableBasis(context,loaded.before)))conflict();
    // Current grants/capabilities are recomputed by the actual loader; original
    // source facts and snapshotAt are returned intact from the durable Audit.
    return {...saved,selection:context.selection,defaults:context.defaults,capabilities:context.capabilities};
   }
   const id=conversionContextAuditId(actor.userId,context.source,context.selection.operation==='development_link'?{orderId:context.selection.orderId,contentFingerprint:conversionDigest({order:loaded.before.orderBefore,...loaded.before.targetBefore})}:undefined),prepared:ConversionContext={...context,preparation:{state:'prepared',auditId:id}};
   const verified:ConversionVerifiedExecutionContext={preparationAuditId:id,sourceBefore:prepared.anchors.source,sourceAnchors:prepared.anchors,...loaded.before};
   await tx.auditLog.create({data:{id,actorId:actor.userId,action:'prepare_order_conversion_command',operationType:'create',targetType:source.type,targetId:source.id,detail:JSON.parse(conversionCanonical({protocol:ORDER_CONVERSION_PROTOCOL,stablePreparationKey,context:verified,frontendContext:prepared}))}});
   return prepared;
  },
 };
}
