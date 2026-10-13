import { canonicalOrderSampleDecimal, canonicalOrderSampleJson, canonicalOrderSampleUnit, orderSampleDate, orderSampleDigest, type OrderSampleFamily, type OrderSampleCoverageRequest } from './orderSampleSourceContract';
import type { OrderSampleQcInput } from './orderSampleQcEvidence';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
export const ORDER_SAMPLE_COMMAND_PROTOCOL = 1 as const;
export const orderSampleCommandFailure = (code: string, message: string): never => { throw new DevelopmentDomainError(code, message); };
export function orderSampleCommandId(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 200 || value.trim() !== value || /[\u0000-\u001f]/.test(value)) orderSampleCommandFailure('INVALID_INPUT', '须明确选择真实记录身份。');
  return value as string;
}
export function orderSampleCommandKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) orderSampleCommandFailure('INVALID_INPUT', '请求标识须为8–128个稳定ASCII字符。');
  return value as string;
}
const plain = (value: any, keys: string[]) => {
  canonicalOrderSampleJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) orderSampleCommandFailure('INVALID_INPUT', '订单样品命令字段不完整或未定义。');
};
export const ORDER_SAMPLE_FAMILIES: OrderSampleFamily[] = ['fabric_ss','fabric_rc','fabric_eps','garment_pp','garment_top','garment_ship'];
export type OrderSampleRegistrationDetails = {
  verification: string; physicalSample: string; differences: string;
  attachments: Array<{name: string; reference: string}>;
};
/** Optional for pre-existing v1 requests. Included in the immutable registration
 * event and request hash, never interpreted as QC approval or physical stock. */
export function parseOrderSampleRegistrationDetails(raw: unknown): OrderSampleRegistrationDetails {
  const r = raw as any;
  plain(r, ['verification','physicalSample','differences','attachments']);
  const text = (v: unknown, label: string, max = 10000): string => {
    if (typeof v !== 'string' || !v.trim() || v.trim() !== v || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) orderSampleCommandFailure('INVALID_INPUT', `${label}须完整填写。`);
    return v as string;
  };
  if (!Array.isArray(r.attachments) || r.attachments.length > 20) orderSampleCommandFailure('INVALID_INPUT', '附件最多20项。');
  const attachments = r.attachments.map((a: any) => {
    plain(a, ['name','reference']);
    const reference = text(a.reference, '已存档附件引用', 2048);
    if (/^(?:blob|data|javascript|file):/i.test(reference) || /[\r\n]/.test(reference)) orderSampleCommandFailure('INVALID_INPUT', '附件须使用稳定存档引用。');
    return {name: text(a.name, '附件名称', 200), reference};
  });
  if (new Set(attachments.map((a: {reference: string}) => a.reference)).size !== attachments.length) orderSampleCommandFailure('INVALID_INPUT', '附件引用重复。');
  return {verification: text(r.verification, '本轮验证内容'), physicalSample: text(r.physicalSample, '实样情况'), differences: text(r.differences, '实际差异'), attachments};
}
export type OrderSampleRegisterCommand = {
  protocolVersion: 1; requestKey: string; family: OrderSampleFamily; orderId: string; factoryRelationId: string;
  expectedParentFingerprint: string; coverage: OrderSampleCoverageRequest[];
  sampleFacts: { quantity: string; unit: string; cuttingDate: string }; previousSourceId: string | null;
  registrationDetails?: OrderSampleRegistrationDetails;
};
export type OrderSampleAppendCommand = {
  protocolVersion: 1; requestKey: string; sourceId: string; expectedHead: {eventId: string; sequence: number};
  eventType: 'shipped'|'customer_feedback'|'retained'|'invalidated'|'qc_requested'|'qc_reviewed'; occurredAt: string; payload: any;
};
function compareDecimal(a: string,b: string): number { const scaled = (s: string) => { const [w,f=''] = s.split('.'); return BigInt(w)*BigInt(10000)+BigInt(f.padEnd(4,'0')); }; return scaled(a)<scaled(b) ? -1 : scaled(a)>scaled(b) ? 1 : 0; }
export function parseOrderSampleRegister(raw: unknown): OrderSampleRegisterCommand {
  const r = raw as any;
  plain(r, ['protocolVersion','requestKey','family','orderId','factoryRelationId','expectedParentFingerprint','coverage','sampleFacts','previousSourceId','registrationDetails']);
  if (r.protocolVersion !== 1 || !ORDER_SAMPLE_FAMILIES.includes(r.family) || !/^[a-f0-9]{64}$/.test(r.expectedParentFingerprint)
    || !Array.isArray(r.coverage) || !r.coverage.length || r.coverage.length > 64 || r.previousSourceId === undefined) orderSampleCommandFailure('INVALID_INPUT','原生订单样品须使用完整版本1及实际父记录版本。');
  const coverage = r.coverage.map((c: any) => {
    plain(c, ['orderLineId','expectedLineFingerprint','productionBatchId','expectedBatchRevision','rangeStart','quantity','unit']);
    if (!/^[a-f0-9]{64}$/.test(c.expectedLineFingerprint)) orderSampleCommandFailure('INVALID_INPUT','订单行版本不完整。');
    const batch = c.productionBatchId == null ? null : orderSampleCommandId(c.productionBatchId);
    if (batch ? !Number.isSafeInteger(c.expectedBatchRevision) || c.expectedBatchRevision < 1 : c.expectedBatchRevision != null) orderSampleCommandFailure('INVALID_INPUT','生产批次修订不完整。');
    return { orderLineId: orderSampleCommandId(c.orderLineId), expectedLineFingerprint: c.expectedLineFingerprint,
      productionBatchId: batch, expectedBatchRevision: batch ? c.expectedBatchRevision : null,
      rangeStart: canonicalOrderSampleDecimal(c.rangeStart,true),quantity: canonicalOrderSampleDecimal(c.quantity),unit:canonicalOrderSampleUnit(c.unit) };
  }).sort((a: any,b: any) => (a.orderLineId<b.orderLineId?-1:a.orderLineId>b.orderLineId?1:0) || compareDecimal(a.rangeStart,b.rangeStart) || String(a.productionBatchId).localeCompare(String(b.productionBatchId)));
  plain(r.sampleFacts,['quantity','unit','cuttingDate']);
  return { protocolVersion:1,requestKey:orderSampleCommandKey(r.requestKey),family:r.family,orderId:orderSampleCommandId(r.orderId),factoryRelationId:orderSampleCommandId(r.factoryRelationId),
    expectedParentFingerprint:r.expectedParentFingerprint,coverage,sampleFacts:{quantity:canonicalOrderSampleDecimal(r.sampleFacts.quantity),unit:canonicalOrderSampleUnit(r.sampleFacts.unit),cuttingDate:orderSampleDate(r.sampleFacts.cuttingDate)},
    previousSourceId:r.previousSourceId === null ? null : orderSampleCommandId(r.previousSourceId),
    ...(r.registrationDetails === undefined ? {} : {registrationDetails: parseOrderSampleRegistrationDetails(r.registrationDetails)}) };
}
export function parseOrderSampleAppend(raw: unknown): OrderSampleAppendCommand {
  const r = raw as any; plain(r,['protocolVersion','requestKey','sourceId','expectedHead','eventType','occurredAt','payload']);
  if (r.protocolVersion !== 1 || !['shipped','customer_feedback','retained','invalidated','qc_requested','qc_reviewed'].includes(r.eventType)) orderSampleCommandFailure('INVALID_INPUT','该事件尚未接入原生样品命令，检验不能用内嵌JSON代替。');
  plain(r.expectedHead,['eventId','sequence']);
  if (!Number.isSafeInteger(r.expectedHead.sequence) || r.expectedHead.sequence < 1) orderSampleCommandFailure('INVALID_INPUT','必须保留打开时的完整事件版本。');
  if (r.payload === undefined) orderSampleCommandFailure('INVALID_INPUT','事件事实缺失。');
  return {protocolVersion:1,requestKey:orderSampleCommandKey(r.requestKey),sourceId:orderSampleCommandId(r.sourceId),expectedHead:{eventId:orderSampleCommandId(r.expectedHead.eventId),sequence:r.expectedHead.sequence},
    eventType:r.eventType,occurredAt:orderSampleDate(r.occurredAt),payload:r.eventType==='qc_reviewed' ? parseOrderSampleQcReview(r.payload, r.occurredAt) : canonicalOrderSampleJson(r.payload)};
}
export function orderSampleCommandIdentity(actorId: string, requestKey: string) {
  const hash = orderSampleDigest({protocolVersion:1,actorId,requestKey});
  return {sampleId:`SMP__order_${hash}`,sourceId:`OSRC__${hash}`,eventId:`OSEV__${hash}`,auditId:`OSA__${hash}`,creationAuditId:`OSCA__${hash}`,chainId:`OSCHAIN__${hash}`};
}

export function parseOrderSampleQcReview(raw:unknown,occurredAt:string):OrderSampleQcInput {
  const r=raw as any;plain(r,['requestedEventId','result','opinion','inspectionDate','inspectorOrg','totalUnits','passedUnits','sampleSize','criticalDefects','majorDefects','minorDefects','defectSummary','reportFile']);
  const text=(value:any,label:string,allowEmpty=false):string=>{if(typeof value!=='string'||value.length>10000||(!allowEmpty&&!value.trim())||value.trim()!==value||/[\u0000-\u001f]/.test(value))orderSampleCommandFailure('INVALID_INPUT',`${label}须明确填写。`);return value;};
  for(const field of ['totalUnits','passedUnits','sampleSize','criticalDefects','majorDefects','minorDefects']) if(!Number.isSafeInteger(r[field])||r[field]<0||r[field]>2147483647)orderSampleCommandFailure('INVALID_INPUT','检验计量须为有效非负整数。');
  if(r.totalUnits<1||r.sampleSize<1||r.sampleSize>r.totalUnits||r.passedUnits>r.totalUnits||!['pass','conditional','fail','direct_reject'].includes(r.result)||r.result==='pass'&&r.criticalDefects>0)orderSampleCommandFailure('INVALID_INPUT','检验计量、致命疵点与结论不一致。');
  if(orderSampleDate(r.inspectionDate)!==occurredAt)orderSampleCommandFailure('INVALID_INPUT','检验日期与实际事件日期须一致。');
  if(r.reportFile!==null&&typeof r.reportFile!=='string')orderSampleCommandFailure('INVALID_INPUT','报告附件引用须明确或为null。');
  return {requestedEventId:orderSampleCommandId(r.requestedEventId),result:r.result,opinion:text(r.opinion,'检验意见'),inspectionDate:r.inspectionDate,inspectorOrg:text(r.inspectorOrg,'检验机构'),totalUnits:r.totalUnits,passedUnits:r.passedUnits,sampleSize:r.sampleSize,
    criticalDefects:r.criticalDefects,majorDefects:r.majorDefects,minorDefects:r.minorDefects,defectSummary:text(r.defectSummary,'疵点描述',true),reportFile:r.reportFile===null?null:text(r.reportFile,'报告附件')};
}
