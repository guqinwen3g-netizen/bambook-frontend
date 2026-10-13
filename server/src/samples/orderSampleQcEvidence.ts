import { orderSampleDigest, type OrderSampleSource } from './orderSampleSourceContract';
import { type OrderSampleQcReport, type OrderSampleQcAudit } from './orderSampleEventReducer';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
export type OrderSampleQcInput = {
  requestedEventId:string; result:'pass'|'conditional'|'fail'|'direct_reject'; opinion:string; inspectionDate:string; inspectorOrg:string;
  totalUnits:number; passedUnits:number; sampleSize:number; criticalDefects:number; majorDefects:number; minorDefects:number; defectSummary:string; reportFile:string|null;
};
const conflict=(message:string):never=>{throw new DevelopmentDomainError('CONFLICT',message);};
export function orderSampleQcScope(source:OrderSampleSource,requestedEventId:string) {
  return {schemaVersion:1,sourceId:source.sourceId,sampleId:source.sampleId,family:source.family,round:source.round,owner:source.owner,
    contentFingerprint:source.contentFingerprint,coverageFingerprint:source.coverageFingerprint,coverage:source.coverage,requestedEventId};
}
const reportFields=['id','orderId','inspectionType','scopeType','scopeKey','productionBatchId','productionBatchRevision','scopeSnapshot','scopeFingerprint','revision','supersedesId','contentFingerprint','requestKey','commandHash',
  'totalUnits','passedUnits','inspectionDate','inspectorOrg','sampleSize','criticalDefects','majorDefects','minorDefects','defectSummary','result','reportFile','inspectedBy','approvedByBusiness','businessApprover','approvedAt','notes','signatures','createdAt','updatedAt'] as const;
export function orderSampleQcStoredReport(row:any) {
  if (!row) conflict('真实检验报告缺失。');
  return Object.fromEntries(reportFields.map(field=>{
    if (!(field in row)) conflict(`检验报告原事实缺失：${field}`);
    return [field,typeof row[field]==='bigint'?String(row[field]):row[field]];
  }));
}
export function orderSampleQcReportContentHash(row:any) {
  const record=orderSampleQcStoredReport(row); const {contentFingerprint,...body}=record; return orderSampleDigest(body);
}
export function buildOrderSampleQcReport(source:OrderSampleSource,input:OrderSampleQcInput,identity:{reportId:string;eventId:string;actorId:string;requestKey:string;commandHash:string;sequence:number;recordedAt:string}) {
  const scopeSnapshot=orderSampleQcScope(source,input.requestedEventId);
  const directReject=input.result==='direct_reject';
  const data:any={id:identity.reportId,orderId:source.owner.orderId,inspectionType:'order_sample_native',scopeType:'order_sample_source',scopeKey:source.sourceId,productionBatchId:null,productionBatchRevision:null,
    scopeSnapshot,scopeFingerprint:orderSampleDigest(scopeSnapshot),revision:identity.sequence,supersedesId:null,contentFingerprint:'',requestKey:identity.requestKey,commandHash:identity.commandHash,
    totalUnits:input.totalUnits,passedUnits:input.passedUnits,inspectionDate:input.inspectionDate,inspectorOrg:input.inspectorOrg,sampleSize:input.sampleSize,criticalDefects:input.criticalDefects,majorDefects:input.majorDefects,minorDefects:input.minorDefects,
    defectSummary:input.defectSummary,result:directReject?'fail':input.result,reportFile:input.reportFile,inspectedBy:identity.actorId,approvedByBusiness:false,businessApprover:null,approvedAt:null,notes:input.opinion,
    signatures:{orderSampleNative:{sourceId:source.sourceId,requestedEventId:input.requestedEventId,eventId:identity.eventId,directReject}},createdAt:BigInt(identity.recordedAt),updatedAt:BigInt(identity.recordedAt)};
  data.contentFingerprint=orderSampleQcReportContentHash(data);
  const report:OrderSampleQcReport={id:identity.reportId,revision:identity.sequence,requestedEventId:input.requestedEventId,sourceId:source.sourceId,sampleId:source.sampleId,round:source.round,
    contentFingerprint:source.contentFingerprint,coverageFingerprint:source.coverageFingerprint,result:directReject?'direct_reject':input.result==='pass'?'passed':'failed',opinion:input.opinion};
  return {data,report};
}
/** Actual rows and actual audit identities are required. Self-consistent event
 * JSON is never proof. Conditional is preserved in the InspectionReport and
 * produces a failed shipping gate; no business approval is manufactured. */
export async function loadOrderSampleQcEvidence(db:{inspectionReport:{findUnique(args:any):Promise<any>};auditLog:{findUnique(args:any):Promise<any>}},source:OrderSampleSource,event:any):Promise<{report:OrderSampleQcReport;reportAudit:OrderSampleQcAudit}> {
  if(event.eventType!=='qc_reviewed' || !event.qcReportId || !event.qcReportAuditId || !Number.isSafeInteger(event.qcReportRevision) || event.qcReportRevision<1) conflict('QC事件缺少真实报告身份。');
  const row=await db.inspectionReport.findUnique({where:{id:event.qcReportId}});
  const audit=await db.auditLog.findUnique({where:{id:event.qcReportAuditId}});
  const requestedEventId=event.payload?.requestedEventId;
  if(typeof requestedEventId!=='string'||!requestedEventId||typeof event.requestKey!=='string')conflict('原检验请求或命令身份缺失。');
  const scopeSnapshot=orderSampleQcScope(source,requestedEventId);
  if(!row || row.id!==event.qcReportId || row.orderId!==source.owner.orderId || row.scopeType!=='order_sample_source' || row.inspectionType!=='order_sample_native' || row.scopeKey!==source.sourceId || row.revision!==event.qcReportRevision
    || row.inspectedBy!==event.actorId || row.requestKey!==event.requestKey || orderSampleDigest(row.scopeSnapshot)!==orderSampleDigest(scopeSnapshot) || row.scopeFingerprint!==orderSampleDigest(scopeSnapshot)
    || !['pass','conditional','fail'].includes(row.result) || row.approvedByBusiness!==false || row.businessApprover!==null || row.approvedAt!==null || row.productionBatchId!==null || row.productionBatchRevision!==null
    || row.signatures?.orderSampleNative?.eventId!==event.id || row.signatures?.orderSampleNative?.sourceId!==source.sourceId || row.signatures?.orderSampleNative?.requestedEventId!==requestedEventId) conflict('真实报告不属于此样品、检验请求或原事件。');
  if(!Number.isInteger(row.totalUnits)||row.totalUnits<1||!Number.isInteger(row.passedUnits)||row.passedUnits<0||row.passedUnits>row.totalUnits||!Number.isInteger(row.sampleSize)||row.sampleSize<1||row.sampleSize>row.totalUnits
    || ['criticalDefects','majorDefects','minorDefects'].some(k=>!Number.isInteger(row[k])||row[k]<0)||row.result==='pass'&&row.criticalDefects>0) conflict('真实检验计量或结论不完整。');
  if(typeof row.notes!=='string'||!row.notes.trim()||String(row.createdAt)!==String(event.recordedAt)||String(row.updatedAt)!==String(event.recordedAt))conflict('真实报告意见或创建时间不符。');
  const originalReport=orderSampleQcStoredReport(row);
  if(row.contentFingerprint!==orderSampleQcReportContentHash(row)) conflict('真实报告内容指纹不符。');
  const directReject=row.signatures.orderSampleNative.directReject;
  if(typeof directReject!=='boolean'||directReject&&row.result!=='fail')conflict('直接打回结论与实际报告不符。');
  const report:OrderSampleQcReport={id:row.id,revision:row.revision,requestedEventId,sourceId:source.sourceId,sampleId:source.sampleId,round:source.round,contentFingerprint:source.contentFingerprint,
    coverageFingerprint:source.coverageFingerprint,result:directReject?'direct_reject':row.result==='pass'?'passed':'failed',opinion:row.notes};
  if(!audit || audit.id!==event.qcReportAuditId || audit.actorId!==event.actorId || audit.action!=='order_sample_qc_review' || audit.targetType!=='InspectionReport' || audit.targetId!==row.id || audit.transactionId!==event.id
    || !(audit.createdAt instanceof Date) || String(audit.createdAt.getTime())!==String(event.recordedAt) || audit.detail?.protocol!=='order_sample_native_v1' || audit.detail?.source!=='route:qc:order-sample-review'
    || orderSampleDigest(audit.detail.after)!==orderSampleDigest(report) || orderSampleDigest(audit.detail.originalReport)!==orderSampleDigest(originalReport) || audit.detail.originalReportHash!==orderSampleDigest(originalReport)) conflict('真实检验审计缺失或内容被改动。');
  const reviewCommand=audit.detail.reviewCommand;
  if(!reviewCommand||reviewCommand.protocolVersion!==1||reviewCommand.operation!=='qc_review'||reviewCommand.actorId!==event.actorId||reviewCommand.requestKey!==event.requestKey||row.commandHash!==orderSampleDigest(reviewCommand)
    || reviewCommand.input?.sourceId!==source.sourceId||reviewCommand.input?.eventType!=='qc_reviewed'||reviewCommand.input?.occurredAt!==row.inspectionDate)conflict('真实报告原命令摘要不符。');
  const p=reviewCommand.input.payload;
  if(!p||p.requestedEventId!==requestedEventId||p.opinion!==row.notes||p.result!==(directReject?'direct_reject':row.result)
    || ['inspectionDate','inspectorOrg','totalUnits','passedUnits','sampleSize','criticalDefects','majorDefects','minorDefects','defectSummary','reportFile'].some(k=>p[k]!==row[k]))conflict('报告事实与原实际检验输入不一致。');
  const reportAudit:OrderSampleQcAudit={auditId:audit.id,protocol:'order_sample_native_v1',source:'route:qc:order-sample-review',operation:'order_sample_qc_review',actorId:audit.actorId,targetType:'InspectionReport',targetId:row.id,after:report};
  if(orderSampleDigest(event.payload.report)!==orderSampleDigest(report)||orderSampleDigest(event.payload.reportAudit)!==orderSampleDigest(reportAudit))conflict('事件内嵌QC事实与真实报告及审计不一致。');
  return {report,reportAudit};
}
