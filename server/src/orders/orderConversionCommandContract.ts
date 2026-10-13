import { buildConfirmedDevelopmentSpec } from '../development/confirmedDevelopmentSpec';
import { isValidSnapshot } from '../moq/moqResolutionService';
import { MOQ_FALLBACK_CONSTANTS } from '../moq/moqConfigService';
import { buildSpecSnapshot } from '../development/developmentSpecSnapshot';
import { createHash } from 'node:crypto';
import { businessError } from '../shared/errorCodes';
import { normalizeOrderQuantityUnit, parseOrderQuantity, summarizeOrderQuantity, type OrderQuantityUnit } from '../shared/orderQuantitySummary';
export const ORDER_CONVERSION_PROTOCOL='order_conversion_command_v1' as const;
export type {ConversionOperation,ConversionUnit,ConversionJson,ConversionSource,ConversionResultSelection,DevelopmentCreateParameters,DevelopmentLinkParameters,QuotationCreateParameters,ConversionInput,ConversionContextSelection,ConversionRowSnapshot,ConversionSourceAnchors,ConversionOrderSnapshot,ConversionLineSnapshot,ConversionOriginal,ConversionAck,ConversionRecovery,ConversionOutcome,ConversionContext,ConversionReply} from './orderConversionCommandTypes';
import type {ConversionOperation,ConversionUnit,ConversionJson,ConversionSource,ConversionResultSelection,DevelopmentCreateParameters,DevelopmentLinkParameters,QuotationCreateParameters,ConversionInput,ConversionContextSelection,ConversionRowSnapshot,ConversionSourceAnchors,ConversionOrderSnapshot,ConversionLineSnapshot,ConversionOriginal,ConversionAck,ConversionRecovery,ConversionOutcome,ConversionContext,ConversionReply} from './orderConversionCommandTypes';
import { isValidLocalDateKey } from '../shared/localDate';


const fail=(message:string):never=>{throw businessError('INVALID_INPUT',message);};
function shape(value:any,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k)))fail('请保留完整转单命令，不得加入隐含字段。');}
function id(value:any){if(typeof value!=='string'||!value||value!==value.trim()||value.length>200||/[\u0000-\u001f]/.test(value))fail('转单来源标识不完整。');return value as string;}
function optional(value:any){return value===null?null:id(value);}
function fingerprint(value:any){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('转单来源版本未核实。');return value as string;}
function date(value:any){if(!isValidLocalDateKey(value))fail('交期须为有效日期。');return value as string;}
export function conversionDecimal(value:unknown,allowZero=false){if(typeof value!=='string')fail('数量须为准确十进制字符串。');try{return parseOrderQuantity(value,{allowZero});}catch{return fail('数量须为模型可准确表示的十进制字符串。');}}
function selection(raw:any):ConversionResultSelection{shape(raw,['type','id']);if(!['Asset','SealSample','Sample','primary_asset'].includes(raw.type))fail('请选择实际确认成果或主档案。');return{type:raw.type,id:id(raw.id)};}
export function conversionCanonical(value:unknown):string{if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);if(typeof value==='number'){if(!Number.isFinite(value))fail('回执不能包含非有限数值。');return JSON.stringify(value);}if(Array.isArray(value))return '['+value.map(conversionCanonical).join(',')+']';if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+conversionCanonical(v)).join(',')+'}';return fail('转单协议包含不可验证的数据。');}
export function conversionDigest(value:unknown){return createHash('sha256').update(conversionCanonical(value)).digest('hex');}
export function parseConversionInput(raw:unknown):ConversionInput{const r=raw as any;conversionCanonical(r);shape(r,['conversionVersion','requestKey','source','operation','parameters']);if(r.conversionVersion!==1||typeof r.requestKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(r.requestKey))fail('请保留原转单请求标识。');shape(r.source,['type','id','expected']);shape(r.source.expected,['updatedAt','quotationVersion','contentFingerprint']);if(!['development','quotation'].includes(r.source.type)||typeof r.source.expected.updatedAt!=='string'||!/^\d+$/.test(r.source.expected.updatedAt))fail('转单来源版本不完整。');if(r.source.type==='quotation'?(!Number.isSafeInteger(r.source.expected.quotationVersion)||r.source.expected.quotationVersion<1):r.source.expected.quotationVersion!==null)fail('报价版本或开发版本不完整。');const source:ConversionSource={type:r.source.type,id:id(r.source.id),expected:{updatedAt:r.source.expected.updatedAt,quotationVersion:r.source.expected.quotationVersion,contentFingerprint:fingerprint(r.source.expected.contentFingerprint)}};const base={conversionVersion:1 as const,requestKey:r.requestKey,source};const p=r.parameters;
 if(r.operation==='development_create'&&source.type==='development'){shape(p,['quantity','unit','dueDate','quoteAmount','selectedSource','millRelationId','orderPo']);const unit=normalizeOrderQuantityUnit(p.unit);if(!unit)fail('数量单位须明确。');return{...base,operation:r.operation,parameters:{quantity:conversionDecimal(p.quantity),unit:unit!,dueDate:date(p.dueDate),quoteAmount:p.quoteAmount===null?null:conversionDecimal(p.quoteAmount,true),selectedSource:selection(p.selectedSource),millRelationId:id(p.millRelationId),orderPo:optional(p.orderPo)}};}
 if(r.operation==='development_link'&&source.type==='development'){shape(p,['orderId','expectedTarget','selectedSource','millRelationId']);shape(p.expectedTarget,['updatedAt','contentFingerprint']);if(typeof p.expectedTarget.updatedAt!=='string'||!/^\d+$/.test(p.expectedTarget.updatedAt))fail('关联目标版本须明确。');return{...base,operation:r.operation,parameters:{orderId:id(p.orderId),expectedTarget:{updatedAt:p.expectedTarget.updatedAt,contentFingerprint:fingerprint(p.expectedTarget.contentFingerprint)},selectedSource:selection(p.selectedSource),millRelationId:id(p.millRelationId)}};}
 if(r.operation==='quotation_create'&&source.type==='quotation'){shape(p,['poNumber','millRelationId','type','dueDate','paymentInstrument']);if(p.type!==null&&!['Fabric','Garment','Other'].includes(p.type))fail('订单业务类型不明确。');return{...base,operation:r.operation,parameters:{poNumber:optional(p.poNumber),millRelationId:optional(p.millRelationId),type:p.type,dueDate:p.dueDate===null?null:date(p.dueDate),paymentInstrument:optional(p.paymentInstrument)}};}return fail('转单操作与来源不一致。');}
export function conversionCommandHash(actorId:string,input:ConversionInput){return conversionDigest({protocol:ORDER_CONVERSION_PROTOCOL,actorId:id(actorId),input:parseConversionInput(input)});}
export function conversionReceiptAuditId(actorId:string,requestKey:string){if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(requestKey))fail('请求标识不完整。');return 'OCMD_'+conversionDigest({protocol:ORDER_CONVERSION_PROTOCOL,actorId:id(actorId),requestKey});}
export function conversionReceiptFingerprint(ack:Omit<ConversionAck,'receiptFingerprint'>){return conversionDigest({protocol:ORDER_CONVERSION_PROTOCOL,ack});}
export function summarizeConversionQuantities(lines:{quantity:string;unit:ConversionUnit}[]){
 if(!lines.length)fail('报价必须有真实业务行。');
 const summary=summarizeOrderQuantity({activeOrderLines:lines});
 if(summary.state==='unresolved'||summary.state==='legacy_unit_unrecorded')throw businessError('INVALID_INPUT','报价行单位尚未核定，不能创建订单。');
 return summary;
}
/** Mirrors the existing selected live profile projection; no approval is inferred. */
export function conversionSpecSnapshot(anchors:ConversionSourceAnchors):ConversionJson {
 const evidence=anchors.selectedResultEvidence as any;
 if(evidence?.confirmedSpecification){
  const accepted=evidence.confirmedSpecification;
  if(!anchors.asset||!anchors.selectedResult||!anchors.factory||accepted.sourceId!==anchors.selectedResult.id||accepted.caseId!==anchors.source.id||accepted.factoryRelationId!==anchors.factory.id)throw businessError('CONFLICT','确认规格与实际来源、工厂不一致。');
  const rebuilt=buildConfirmedDevelopmentSpec({sourceType:accepted.sourceType,sourceId:accepted.sourceId,caseId:accepted.caseId,factoryRelationId:accepted.factoryRelationId,asset:anchors.asset.record as any,origins:accepted.origins,sampleOriginProof:evidence.sampleOriginProof??null});
  if(conversionCanonical(rebuilt.confirmedSpecification)!==conversionCanonical(accepted)||conversionCanonical(rebuilt.specSnapshot)!==conversionCanonical(evidence.confirmedSpecSnapshot))throw businessError('CONFLICT','确认规格原始证据未通过核验。');
  return rebuilt.specSnapshot as ConversionJson;
 }
 if(!anchors.asset||!anchors.profile)throw businessError('CONFLICT','准确产品规格来源不完整。');
 const asset=anchors.asset.record,profile=anchors.profile.record,base:any=buildSpecSnapshot({...asset,[anchors.profile.family+'Profile']:profile});
 if(anchors.selectedResultEvidence!==null)base.sampleOriginProof=anchors.selectedResultEvidence;
 return base;
}
/** Validate a persisted original acknowledgement before returning it. Current
 * mutable Order state is intentionally not substituted into this proof. */
export function assertConversionAck(ack:ConversionAck,actorId:string,input:ConversionInput):void {
 const normalized=parseConversionInput(input),original=ack.original;
 if(ack.conversionVersion!==1||ack.actorId!==actorId||ack.requestKey!==normalized.requestKey||ack.operation!==normalized.operation||ack.sourceType!==normalized.source.type||ack.sourceId!==normalized.source.id||ack.outcome!==(normalized.operation==='development_link'?'linked':'converted')||ack.receiptAuditId!==conversionReceiptAuditId(actorId,normalized.requestKey)||ack.commandHash!==conversionCommandHash(actorId,normalized)||conversionCanonical(original.input)!==conversionCanonical(normalized))throw businessError('CONFLICT','原转单回执与本次请求不一致，请保留原请求核查。');
 const row=(r:ConversionRowSnapshot)=>{if(!r||!r.record||r.id!==r.record.id)throw businessError('CONFLICT','原转单回执的业务记录标识不完整。');conversionCanonical(r);};
 for(const r of [original.sourceBefore,original.sourceAfter,original.sourceAnchors.source,original.orderAfter,...original.lines,...original.productionStages,...original.businessAudits])row(r);
 if(original.orderBefore)row(original.orderBefore);
 const anchors=original.sourceAnchors;
 for(const r of [anchors.selectedResult,anchors.asset,anchors.profile,anchors.factory,anchors.customer,anchors.moq.approvedExemption,anchors.moq.config,...anchors.quotationLines])if(r)row(r);
 if(conversionDigest(anchors)!==normalized.source.expected.contentFingerprint||conversionCanonical(anchors.source)!==conversionCanonical(original.sourceBefore)||String(original.sourceBefore.record.updatedAt)!==normalized.source.expected.updatedAt)throw businessError('CONFLICT','原转单回执与打开时的完整来源版本不一致。');
 assertConversionMoqBasis(anchors,original.completedAt);
 const sourceCustomer=original.sourceBefore.record.customerRelationId??null;if((anchors.customer?.id??null)!==sourceCustomer)throw businessError('CONFLICT','原转单回执的实际客户归属不一致。');
 if(normalized.source.type==='quotation'&&(original.sourceBefore.record.version!==normalized.source.expected.quotationVersion||original.sourceAfter.record.convertedOrderId!==ack.orderId))throw businessError('CONFLICT','原报价转单版本或转换指针不一致。');
 if(normalized.source.type==='development'){
  const p=normalized.parameters as DevelopmentCreateParameters|DevelopmentLinkParameters;
  if(original.sourceAfter.record.linkedOrderId!==ack.orderId||anchors.selectedResult?.id!==p.selectedSource.id||anchors.factory?.id!==p.millRelationId||!anchors.asset||!anchors.profile||anchors.profile.record.productAssetId!==anchors.asset.id)throw businessError('CONFLICT','原开发转单缺少准确成果、档案或工厂关联。');
  const selected=anchors.selectedResult.record,kind=p.selectedSource.type;
  if((kind==='Asset'||kind==='primary_asset')&&anchors.asset.id!==p.selectedSource.id||kind==='primary_asset'&&original.sourceBefore.record.productAssetId!==p.selectedSource.id||kind==='SealSample'&&(selected.developmentCaseId!==ack.sourceId||selected.convertedProductAssetId!==anchors.asset.id||selected.supplierRelationId!==p.millRelationId)||kind==='Sample'&&(selected.sourceCaseId!==ack.sourceId||selected.productAssetId!==anchors.asset.id||selected.supplierRelationId!==p.millRelationId))throw businessError('CONFLICT','原确认成果与开发案、档案或工厂不一致。');
  const expectedFamily=original.sourceBefore.record.type==='fabric'?'fabric':['garment','pp'].includes(String(original.sourceBefore.record.type))?'garment':null;if(!expectedFamily||anchors.profile.family!==expectedFamily||String(anchors.asset.record.mainCategory).toLowerCase()!==expectedFamily||anchors.asset.record.deletedAt!==null||anchors.profile.record.deletedAt!==null)throw businessError('CONFLICT','原档案业务类型或有效规格不一致。');
  const factory=anchors.profile.family==='garment'?anchors.profile.record.factoryRelationId:anchors.profile.record.millOrganizationId;if(factory!==null&&factory!==undefined&&factory!==p.millRelationId)throw businessError('CONFLICT','原档案规格与所选工厂不一致。');
 }
 const completed=Date.parse(original.completedAt);if(!Number.isFinite(completed)||new Date(completed).toISOString()!==original.completedAt)throw businessError('CONFLICT','原转单完成时间不完整。');
 const expectedAction=normalized.source.type==='development'?'convert_dev_case':'convert_quotation_to_order',expectedTarget=normalized.source.type==='development'?'DevelopmentCase':'Quotation';
 const transitions=original.businessAudits.filter(a=>a.record.actorId===actorId&&a.record.action===expectedAction&&a.record.targetType===expectedTarget&&a.record.targetId===ack.sourceId);
 if(transitions.length!==1)throw businessError('CONFLICT','原转单缺少本执行者的准确来源变更审计。');
 if(original.businessAudits.some(a=>a.record.actorId!==actorId||!['convert_dev_case','convert_quotation_to_order','create_order_from_quotation'].includes(String(a.record.action))||![ack.sourceId,ack.orderId].includes(String(a.record.targetId))))throw businessError('CONFLICT','原转单回执包含不属于本次操作的审计。');
 if(normalized.operation==='quotation_create'&&original.businessAudits.filter(a=>a.record.action==='create_order_from_quotation'&&a.record.targetType==='Order'&&a.record.targetId===ack.orderId&&(a.record.detail as any)?.after?.quotationId===ack.sourceId).length!==1)throw businessError('CONFLICT','原报价回执缺少准确订单创建审计。');
 const transition=transitions[0].record,after=(transition.detail as any)?.after,created=Date.parse(String(transition.createdAt));if(!after||after.orderId!==ack.orderId||!Number.isFinite(created)||created>completed)throw businessError('CONFLICT','原转单审计与实际订单或完成时间不一致。');

 if(original.sourceBefore.id!==ack.sourceId||original.sourceAfter.id!==ack.sourceId||original.sourceAnchors.source.id!==ack.sourceId||original.orderAfter.id!==ack.orderId||original.lines.some(l=>l.record.orderId!==ack.orderId)||original.productionStages.some(s=>s.record.orderId!==ack.orderId)||!original.businessAudits.length)throw businessError('CONFLICT','原转单回执缺少完整来源和订单归属证据。');
 if(normalized.operation==='development_link'&&(original.orderBefore?.id!==normalized.parameters.orderId||ack.orderId!==normalized.parameters.orderId||String(original.orderBefore.record.updatedAt)!==normalized.parameters.expectedTarget.updatedAt||conversionDigest({order:original.orderBefore,...original.targetBefore})!==normalized.parameters.expectedTarget.contentFingerprint))throw businessError('CONFLICT','原关联回执与实际目标订单不一致。');
 if(normalized.operation!=='development_link'){
  const keys=['order_placed','materials_confirmed','production_planned','in_production','materials_arrived','pre_cut_checked','pp_sample_approved','manufacturing','final_review','qc_shipped'];
  if(new Set(original.productionStages.map(stage=>stage.record.createdAt)).size!==1)throw businessError('CONFLICT','原订单阶段初始化时间不一致。');
  if(original.productionStages.some((stage:any)=>{const r=stage.record;return r.id!==`PST__${ack.orderId}__${r.stageKey}`||r.status!==(r.stageSeq===1?'done':'pending')||typeof r.createdAt!=='string'||!/^\d+$/.test(r.createdAt)||r.updatedAt!==r.createdAt||(r.stageSeq===1?(typeof r.doneAt!=='string'||!/^\d+$/.test(r.doneAt)||Number(r.doneAt)>completed||r.doneAt!==r.createdAt):r.doneAt!==null);}))throw businessError('CONFLICT','原订单初建生产阶段事实不正确。');
  if(original.orderBefore!==null||!original.lines.length||original.productionStages.length!==10||keys.some((key,i)=>original.productionStages.filter(s=>s.record.stageKey===key&&s.record.stageSeq===i+1).length!==1))throw businessError('CONFLICT','原转单回执缺少实际完整生产阶段。');
 }
 for(const rows of [original.lines,original.productionStages,original.businessAudits])if(new Set(rows.map(r=>r.id)).size!==rows.length)throw businessError('CONFLICT','原转单回执包含重复业务记录。');
 if(normalized.operation==='development_link'){
  if(!original.targetBefore||conversionCanonical(original.orderBefore)!==conversionCanonical(original.orderAfter)||conversionCanonical(original.targetBefore.lines)!==conversionCanonical(original.lines)||conversionCanonical(original.targetBefore.productionStages)!==conversionCanonical(original.productionStages))throw businessError('CONFLICT','关联已有订单不能改写原订单、业务行或生产阶段。');
 }else if(original.targetBefore!==null)throw businessError('CONFLICT','新建转单不能冒用历史目标快照。');
 const order=original.orderAfter.record;if(normalized.operation!=='development_link'&&conversionCanonical(order.moqSnapshot)!==conversionCanonical(anchors.moq.snapshot))throw businessError('CONFLICT','新订单 MOQ 不能替换实际冻结的原依据。');
 for(const field of ['quantity','customerRelationId','millRelationId','dueDate','quoteAmount','poNumber','sourceCaseId','status'])if(!Object.prototype.hasOwnProperty.call(order,field))throw businessError('CONFLICT','原订单回执缺少完整业务字段。');
 if(order.quantity!==null&&typeof order.quantity!=='string'||order.unit!=null&&typeof order.unit!=='string'||typeof order.quoteAmount!=='string'||order.customerRelationId!==(anchors.customer?.id??null))throw businessError('CONFLICT','原订单数量金额或客户归属不完整。');
 if(normalized.operation==='development_create'){
  const p=normalized.parameters,line=original.lines[0]?.record;
  if(!line||line.materialCode!==anchors.asset?.record.sku||conversionCanonical(line.specSnapshot)!==conversionCanonical(conversionSpecSnapshot(anchors)))throw businessError('CONFLICT','原订单行产品编码或规格未准确继承所选档案。');
  const primary=p.selectedSource.type==='primary_asset';if(primary?['confirmedSourceType','confirmedSourceId','confirmedAt','confirmedBy'].some(k=>line[k]!==null):(line.confirmedSourceType!==p.selectedSource.type||line.confirmedSourceId!==p.selectedSource.id||line.confirmedBy!==actorId||typeof line.confirmedAt!=='string'||!/^\d+$/.test(line.confirmedAt)))throw businessError('CONFLICT','原订单行确认依据与真实所选成果不一致。');
  if(original.lines.length!==1||order.sourceCaseId!==ack.sourceId||order.millRelationId!==p.millRelationId||order.dueDate!==p.dueDate||order.status!=='Pending'||conversionDecimal(order.quantity)!==p.quantity||order.unit!=null&&order.unit!==p.unit||conversionDecimal(order.quoteAmount,true)!==(p.quoteAmount??'0')||p.orderPo!==null&&order.poNumber!==p.orderPo||conversionDecimal(original.lines[0].record.quantity)!==p.quantity||normalizeOrderQuantityUnit(original.lines[0].record.unit)!==p.unit)throw businessError('CONFLICT','原开发转单数量、单位、工厂或商业参数未兑现。');
 }
 if(normalized.operation==='quotation_create'){
  const p=normalized.parameters,source=original.sourceBefore.record,quotationLines=[...anchors.quotationLines].sort((a,b)=>Number(a.record.lineNumber)-Number(b.record.lineNumber)),orderLines=[...original.lines].sort((a,b)=>a.record.lineNumber-b.record.lineNumber);
  if(order.poNumber!==(p.poNumber??source.quotationNumber)||(order.dueDate!==(p.dueDate??'') && !(p.dueDate===null && order.dueDate===(source.validUntil??'')))||order.sourceCaseId!==(source.developmentCaseId??null)||order.millRelationId!==p.millRelationId||order.quoteAmount!==conversionDecimal(source.totalAmount,true)||order.status!=='Pending'||order.paymentInstrument!==(p.paymentInstrument??source.paymentInstrument??null)||p.type!==null&&order.type!==p.type||conversionCanonical(order.moqSnapshot)!==conversionCanonical(anchors.moq.snapshot)||isValidSnapshot(source.moqSnapshot as any)&&conversionCanonical(anchors.moq.snapshot)!==conversionCanonical(source.moqSnapshot)||quotationLines.length!==orderLines.length||!quotationLines.length)throw businessError('CONFLICT','原报价商业参数或来源归属未完整传递。');
  const quantities=quotationLines.map((q,i)=>{const l=orderLines[i].record,unit=normalizeOrderQuantityUnit(q.record.unit);if(!unit||conversionDecimal(q.record.quantity)!==conversionDecimal(l.quantity)||normalizeOrderQuantityUnit(l.unit)!==unit||l.lineNumber!==i+1||l.materialCode!==q.record.fabricCode||l.description!==q.record.description||l.unitPrice!==q.record.unitPrice||l.netValue!==q.record.amount)throw businessError('CONFLICT','原报价行数量、单位或价格未准确传递。');return{quantity:conversionDecimal(q.record.quantity),unit};});
  const summary=summarizeConversionQuantities(quantities),legacyHeaderUnit=!Object.prototype.hasOwnProperty.call(order,'unit')&&summary.state==='single_unit'&&summary.quantity!==null&&!summary.quantity.includes('.');
  if(summary.quantity!==(order.quantity??null)||!legacyHeaderUnit&&summary.unit!==(order.unit??null))throw businessError('CONFLICT','原订单数量分组与准确报价行不一致。');
 }
 const {receiptFingerprint,...body}=ack;if(receiptFingerprint!==conversionReceiptFingerprint(body))throw businessError('CONFLICT','原转单回执指纹无法核实。');
}

/** The service must additionally load and validate the real persistent Audit.
 * This checker does not treat a self-consistent JSON cancellation as storage proof. */
export function assertConversionRecovery(result:ConversionRecovery,actorId:string,input:ConversionInput):void {
 const normalized=parseConversionInput(input),hash=conversionCommandHash(actorId,normalized);
 if(result.conversionVersion!==1||result.actorId!==actorId||result.requestKey!==normalized.requestKey||result.operation!==normalized.operation||result.sourceType!==normalized.source.type||result.sourceId!==normalized.source.id||result.commandHash!==hash||conversionCanonical(result.requestInput)!==conversionCanonical(normalized))throw businessError('CONFLICT','恢复状态与本执行者的原转单请求不一致。');
 if(result.outcome==='not_confirmed'){
  if(result.receiptAuditId!==null||result.legacyOrderId!==null||result.cancellationProof!==null||result.legacyProof!==null)throw businessError('CONFLICT','未确认状态不能冒用执行或取消证明。');return;
 }
 if(result.outcome==='cancelled'){
  const p=result.cancellationProof;if(!p||result.receiptAuditId!==conversionReceiptAuditId(actorId,normalized.requestKey)||p.auditId!==result.receiptAuditId||p.actorId!==actorId||p.commandHash!==hash||conversionCanonical(p.requestInput)!==conversionCanonical(normalized)||!Number.isFinite(Date.parse(p.cancelledAt))||new Date(p.cancelledAt).toISOString()!==p.cancelledAt||result.legacyOrderId!==null||result.legacyProof!==null)throw businessError('CONFLICT','取消状态缺少原请求的准确持久取消证明。');return;
 }
 if(result.outcome==='legacy_unverified'){
  const p=result.legacyProof;if(!p||result.receiptAuditId!==null||result.cancellationProof!==null||!result.legacyOrderId||p.source.id!==normalized.source.id||p.source.record.id!==p.source.id||p.order.id!==result.legacyOrderId||p.order.record.id!==p.order.id||(normalized.source.type==='quotation'?p.source.record.convertedOrderId!==p.order.id:p.order.record.sourceCaseId!==p.source.id||p.order.record.clientRequestId!==normalized.requestKey||!p.businessAudit||p.businessAudit.record.id!==p.businessAudit.id||p.businessAudit.record.actorId!==actorId||p.businessAudit.record.action!=='convert_dev_case'||p.businessAudit.record.targetType!=='DevelopmentCase'||p.businessAudit.record.targetId!==p.source.id||(p.businessAudit.record.detail as any)?.after?.orderId!==p.order.id))throw businessError('CONFLICT','历史结果缺少准确来源与订单关联，不能恢复为新命令成功。');return;
 }
 throw businessError('CONFLICT','恢复状态无法核实。');
}

export function conversionMoqBasisFingerprint(sourceId:string,sourceSnapshot:ConversionJson,config:ConversionRowSnapshot|null):string {
 return conversionDigest(isValidSnapshot(sourceSnapshot as any)?{kind:'source_snapshot',sourceId,snapshot:sourceSnapshot}:config?{kind:'active_config',config}:{kind:'fallback_constant',version:1,thresholds:MOQ_FALLBACK_CONSTANTS});
}
export function assertConversionMoqBasis(anchors:ConversionSourceAnchors,completedAt:string):void {
 const prior=anchors.source.record.moqSnapshot??null,snapshot=anchors.moq.snapshot as any,config=anchors.moq.config;
 if(!isValidSnapshot(snapshot)||anchors.moq.basisFingerprint!==conversionMoqBasisFingerprint(anchors.source.id,prior,config))throw businessError('CONFLICT','原转单 MOQ 依据未能核验。');
 if(isValidSnapshot(prior as any)){
  if(config!==null||conversionCanonical(snapshot)!==conversionCanonical(prior))throw businessError('CONFLICT','有效原 MOQ 快照不能重新配置或替换。');return;
 }
 if(typeof snapshot.snapshotAt!=='string'||!Number.isFinite(Date.parse(snapshot.snapshotAt))||new Date(snapshot.snapshotAt).toISOString()!==snapshot.snapshotAt||Date.parse(snapshot.snapshotAt)>Date.parse(completedAt))throw businessError('CONFLICT','新 MOQ 快照必须是本次实际服务端冻结事实。');
 if(config){if(config.record.id!==config.id||config.record.isActive!==true||snapshot.source!=='moq_config'||snapshot.configId!==config.id||(['fabricDefaultMoq','garmentDefaultMoq','capsuleMoq'] as const).some(key=>snapshot[key]!==config.record[key]))throw businessError('CONFLICT','新 MOQ 快照与实际生效配置不一致。');}
 else if(snapshot.source!=='fallback_constant'||snapshot.configId!==null||(['fabricDefaultMoq','garmentDefaultMoq','capsuleMoq'] as const).some(key=>snapshot[key]!==MOQ_FALLBACK_CONSTANTS[key as keyof typeof MOQ_FALLBACK_CONSTANTS]))throw businessError('CONFLICT','新 MOQ 兜底快照与既有服务端政策不一致。');
}
/** POST context persists this exact actor/source/fingerprint preparation identity.
 * GET is read-only preview; no preparation is execution permission. */
export function conversionContextAuditId(actorId:string,source:ConversionSource,linkTarget?:{orderId:string;contentFingerprint:string}){return 'OCTX_'+conversionDigest({protocol:ORDER_CONVERSION_PROTOCOL,actorId:id(actorId),sourceType:source.type,sourceId:id(source.id),contentFingerprint:fingerprint(source.expected.contentFingerprint),...(linkTarget?{linkTarget:{orderId:id(linkTarget.orderId),contentFingerprint:fingerprint(linkTarget.contentFingerprint)}}:{})});}
