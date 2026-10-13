import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
import type { SampleManageRow, SampleManageType, SampleOriginBinding, SampleOriginContext } from './sampleService';

export type RegistrationLine = 'fabric' | 'garment';
export interface ExactBatchCommand { batchId: string; sourceRound: number; expectedUpdatedAt: string; expectedFactoryId: string; expectedHistoryRevision: number | null; expectedEventId: string | null; expectedContentFingerprint: string; }
export interface ExactSealCommand { sealId: string; expectedUpdatedAt: string; expectedFactoryId: string; components: ExactBatchCommand[]; }
export interface RegistrationBatch { batchId: string; batchCode?: string | null; content?: Record<string, unknown>; selectable: boolean; reasons: string[]; nativeFamily?: 'fabric-batch' | 'garment-round'; caseId?: string; factoryId?: string; factoryName?: string | null; sourceRound?: number; batchUpdatedAt?: string; sampleType?: string; status?: string; actual?: { quantity: string | null; unit: string | null }; planned?: { quantity: string | null; unit: string | null }; command?: ExactBatchCommand; }
export interface RegistrationSeal { sealId: string; sealCode?: string | null; name?: string | null; caseId: string; factoryId: string; selectable: boolean; reasons: string[]; componentBatchIds: string[]; components: Array<RegistrationBatch | null>; command: ExactSealCommand | null; }
export interface RegistrationContext { registrationVersion: 2; mode: 'ordinary-draft-exact-source'; persistentReceipt: true; autoApproval: false; snapshotAt: string; development: { caseId: string; code?: string | null; name?: string | null; type: RegistrationLine; updatedAt: string; contentFingerprint: string }; registrationEligibility: { design: { allowed: boolean; reasons: string[] }; production: { allowed: boolean; reasons: string[] } }; batches: RegistrationBatch[]; seals: RegistrationSeal[]; }
export interface RegistrationCommand { registrationVersion: 2; requestKey: string; type: SampleManageType; sourceCaseId: string; expectedCaseUpdatedAt: string; expectedCaseContentFingerprint: string; subType?: string; notes?: string; origin?: ExactBatchCommand; sealOrigin?: ExactSealCommand; }
export interface PendingSampleRegistration { version: 2; actorId: string; endpoint: string; businessLine: RegistrationLine; command: RegistrationCommand; attempts: number; definitivelyRejected: boolean; }
export interface RegistrationResult { acknowledgement: { registrationVersion: 2; operation: 'register_ordinary_sample'; actorId: string; requestKey: string; sampleId: string; commandHash: string; originalSample: SampleManageRow; sourceBindings: SampleOriginBinding[] }; currentSample: SampleManageRow; sourceContext: SampleOriginContext; replayed: boolean; }
export type RegistrationRecovery = { state: 'not_confirmed'; retryOriginalRequest: true } | (RegistrationResult & { state: 'committed' });
export class SampleRegistrationError extends Error { constructor(message: string, public readonly uncertain = false, public readonly status?: number, public readonly code?: string) { super(message); } }
const record = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: any): v is string => typeof v === 'string' && !!v && v.trim() === v && v.length <= 200;
const hash = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: any) => typeof v === 'string' && /^\d+$/.test(v);
const reasons = (v: any) => Array.isArray(v) && v.every((x: any) => typeof x === 'string');
const unique = (v: string[]) => new Set(v).size === v.length;
const types = ['dev','seal','pp','top','ship','head','pioneer'];
const fail = (message = '准确登记协议不完整，请更新后台并重新核对；本次不会降级登记'): never => { throw new SampleRegistrationError(message); };
const protocol = (v: any) => v?.ok === true && v.registrationVersion === 2 && v.mode === 'ordinary-draft-exact-source' && v.persistentReceipt === true && v.autoApproval === false;
function batchCommand(v: any): v is ExactBatchCommand {
  return record(v) && Object.keys(v).length === 7 && text(v.batchId) && Number.isSafeInteger(v.sourceRound) && v.sourceRound >= 1 && timestamp(v.expectedUpdatedAt) && text(v.expectedFactoryId)
    && Object.hasOwn(v,'expectedHistoryRevision') && (v.expectedHistoryRevision === null || Number.isSafeInteger(v.expectedHistoryRevision) && v.expectedHistoryRevision >= 0)
    && Object.hasOwn(v,'expectedEventId') && (v.expectedEventId === null || text(v.expectedEventId)) && hash(v.expectedContentFingerprint);
}
function sealCommand(v: any): v is ExactSealCommand { return record(v) && Object.keys(v).length === 4 && text(v.sealId) && text(v.expectedFactoryId) && timestamp(v.expectedUpdatedAt) && Array.isArray(v.components) && v.components.length > 0 && v.components.length <= 1000 && v.components.every(batchCommand) && unique(v.components.map((x: ExactBatchCommand) => x.batchId)) && v.components.every((x: ExactBatchCommand) => x.expectedFactoryId === v.expectedFactoryId); }
function quantity(v: any) { return record(v) && (v.quantity === null || typeof v.quantity === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.quantity)) && (v.unit === null || typeof v.unit === 'string'); }
function validBatch(v: any, caseId: string, line: RegistrationLine) {
  if (!record(v) || !text(v.batchId) || typeof v.selectable !== 'boolean' || !reasons(v.reasons)) return false;
  if (!v.selectable) return true;
  return v.caseId === caseId && text(v.factoryId) && batchCommand(v.command) && v.command.batchId === v.batchId && v.command.expectedFactoryId === v.factoryId && v.command.sourceRound === v.sourceRound && v.command.expectedUpdatedAt === v.batchUpdatedAt
    && v.command.expectedContentFingerprint === v.sourceContentFingerprint && v.command.expectedHistoryRevision === v.historyRevision && v.command.expectedEventId === v.eventId
    && (line === 'garment' ? v.nativeFamily === 'garment-round' && v.sampleType === 'garment-round' : v.nativeFamily === 'fabric-batch' && ['lab-dip','handloom','yardage'].includes(v.sampleType))
    && typeof v.status === 'string' && record(v.content) && quantity(v.actual) && quantity(v.planned);
}
export function checkedRegistrationContext(v: any, caseId: string): RegistrationContext {
  if (!protocol(v) || !timestamp(v.snapshotAt) || v.development?.caseId !== caseId || !['fabric','garment'].includes(v.development?.type) || !timestamp(v.development.updatedAt) || !hash(v.development.contentFingerprint)
    || !['design','production'].every(k => typeof v.registrationEligibility?.[k]?.allowed === 'boolean' && reasons(v.registrationEligibility[k].reasons)) || !Array.isArray(v.batches) || !Array.isArray(v.seals)) return fail();
  const line = v.development.type;
  if (!v.batches.every((b: any) => validBatch(b,caseId,line)) || !unique(v.batches.map((b: any)=>b.batchId))) return fail();
  const batchById = new Map(v.batches.map((b: any)=>[b.batchId,b]));
  for(const seal of v.seals) {
    if (!record(seal) || !text(seal.sealId) || seal.caseId !== caseId || typeof seal.selectable !== 'boolean' || !reasons(seal.reasons) || !Array.isArray(seal.componentBatchIds) || !seal.componentBatchIds.every(text) || !unique(seal.componentBatchIds) || !Array.isArray(seal.components)) return fail();
    if (!seal.selectable) { if (seal.command != null) return fail(); continue; }
    if(line !== 'fabric' || !sealCommand(seal.command) || seal.command.sealId !== seal.sealId || seal.command.expectedFactoryId !== seal.factoryId || seal.command.expectedUpdatedAt !== seal.sealUpdatedAt || seal.components.length !== seal.componentBatchIds.length || seal.command.components.length !== seal.componentBatchIds.length) return fail();
    for(const command of seal.command.components) {
      const b: any = batchById.get(command.batchId);
      if(!b?.selectable || !seal.componentBatchIds.includes(command.batchId) || b.factoryId !== seal.factoryId || !seal.components.some((x: any) => x?.batchId === b.batchId && canonical(x) === canonical(b)) || canonical(command) !== canonical(b.command)) return fail();
    }
  }
  if(!unique(v.seals.map((s: any)=>s.sealId))) return fail();
  return v;
}
const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : record(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])) : v;
const canonical = (v: any) => JSON.stringify(sorted(v));
const digest = async (value: unknown): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function registrationCommandHash(actorId: string, command: RegistrationCommand): Promise<string> {
  return digest({registrationVersion:2,operation:'register_ordinary_sample',actorId,requestKey:command.requestKey,input:command});
}
function validCommand(v: any): v is RegistrationCommand {
  return record(v) && Object.keys(v).every(k=>['registrationVersion','requestKey','type','sourceCaseId','expectedCaseUpdatedAt','expectedCaseContentFingerprint','subType','notes','origin','sealOrigin'].includes(k)) && v.registrationVersion === 2 && typeof v.requestKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(v.requestKey) && types.includes(v.type) && text(v.sourceCaseId) && timestamp(v.expectedCaseUpdatedAt) && hash(v.expectedCaseContentFingerprint)
    && ['subType','notes'].every(k=>v[k] === undefined || typeof v[k] === 'string' && v[k].length <= 10000) && (!!v.origin !== !!v.sealOrigin) && (v.origin ? batchCommand(v.origin) : sealCommand(v.sealOrigin));
}
export function registrationNamespace(): {actorId: string; endpoint: string; key: string} {
  const auth = getAuthState(), endpoint = apiService.getStoredConfig().cloudEndpoint || '';
  if (!auth.isAuthenticated || auth.isLoading || !auth.user?.id) throw new SampleRegistrationError('请使用当前公司账号核对样品登记');
  return { actorId: auth.user.id, endpoint, key: `bambook_sample_registration_v2:${encodeURIComponent(endpoint)}:${encodeURIComponent(auth.user.id)}` };
}
export function readPendingSampleRegistration(): PendingSampleRegistration | null {
  const n = registrationNamespace(), raw = sessionStorage.getItem(n.key);
  if (!raw) return null;
  try { const p = JSON.parse(raw); if(p.version !== 2 || p.actorId !== n.actorId || p.endpoint !== n.endpoint || !['fabric','garment'].includes(p.businessLine) || !validCommand(p.command) || !Number.isSafeInteger(p.attempts) || p.attempts < 0 || typeof p.definitivelyRejected !== 'boolean') return fail('原登记恢复线索损坏，请保留原请求并核对，不能另建样品'); return p; }
  catch(e) { if(e instanceof SampleRegistrationError) throw e; return fail('原登记恢复线索未能读取，请核对原请求'); }
}
export function savePendingSampleRegistration(p: PendingSampleRegistration) { const n=registrationNamespace(); if(p.actorId !== n.actorId || p.endpoint !== n.endpoint || !validCommand(p.command)) return fail('原账号或后台已变化，请核对原登记'); sessionStorage.setItem(n.key,JSON.stringify(p)); }
export function clearPendingSampleRegistration(p: PendingSampleRegistration) { const n=registrationNamespace(); if(p.actorId !== n.actorId || p.endpoint !== n.endpoint) return; const found=readPendingSampleRegistration(); if(found?.command.requestKey === p.command.requestKey) sessionStorage.removeItem(n.key); }
export function prepareSampleRegistration(context: RegistrationContext, source: string, fields: {type: SampleManageType; subType?: string; notes?: string}): PendingSampleRegistration {
  if(!hasPermission('products:read') || !hasPermission('products:write')) return fail('当前账号没有准确样品登记权限');
  if(readPendingSampleRegistration()) return fail('原登记结果待核，请先核对回执');
  const eligibility=context.registrationEligibility[['dev','seal'].includes(fields.type)?'design':'production'];
  if(!types.includes(fields.type) || !eligibility.allowed) return fail('当前案或账号不能登记该类样品，请重新读取来源');
  const batch=context.batches.find(b=>'batch:'+b.batchId === source), seal=context.seals.find(s=>'seal:'+s.sealId === source);
  if(!(batch?.selectable && batch.command || seal?.selectable && seal.command)) return fail('请选择准确且可登记的原生来源');
  const n=registrationNamespace();
  const command: RegistrationCommand={registrationVersion:2,requestKey:crypto.randomUUID(),type:fields.type,sourceCaseId:context.development.caseId,expectedCaseUpdatedAt:context.development.updatedAt,expectedCaseContentFingerprint:context.development.contentFingerprint,
    ...(fields.subType?.trim()?{subType:fields.subType.trim()}:{}),...(fields.notes?.trim()?{notes:fields.notes.trim()}:{}),
    ...(batch?{origin:batch.command!}:{sealOrigin:{...seal!.command!,components:[...seal!.command!.components].sort((a,b)=>a.batchId.localeCompare(b.batchId))}})};
  const p: PendingSampleRegistration=JSON.parse(JSON.stringify({version:2,actorId:n.actorId,endpoint:n.endpoint,businessLine:context.development.type,command,attempts:0,definitivelyRejected:false}));
  savePendingSampleRegistration(p); return p;
}
async function checkedAck(v: any, p: PendingSampleRegistration): Promise<RegistrationResult> {
  const ack=v?.acknowledgement, original=ack?.originalSample, commands=p.command.origin?[p.command.origin]:p.command.sealOrigin!.components;
  const identityHash=await digest({registrationVersion:2,operation:'register_ordinary_sample',actorId:p.actorId,requestKey:p.command.requestKey});
  if(!protocol(v) || ack?.registrationVersion !== 2 || ack.operation !== 'register_ordinary_sample' || ack.actorId !== p.actorId || ack.requestKey !== p.command.requestKey || !text(ack.sampleId) || ack.sampleId !== original?.id || !text(original.code) || original.sourceCaseId !== p.command.sourceCaseId || original.type !== p.command.type || original.status !== 'draft' || original.projectionKey != null || original.businessContext?.status !== 'resolved' || original.businessContext.businessLine !== p.businessLine || ack.commandHash !== await registrationCommandHash(p.actorId,p.command) || !hash(ack.originalSampleHash) || !hash(ack.sourceBindingsHash) || !text(ack.receiptAuditId) || !Array.isArray(ack.sourceBindings) || ack.sourceBindings.length !== commands.length || typeof v.replayed !== 'boolean' || v.currentSample?.id !== ack.sampleId || v.currentSample.sourceCaseId !== p.command.sourceCaseId || !record(v.sourceContext) || !reasons(v.sourceContext.reasons)) return fail('原登记回执不匹配，请保留原请求核对；勿重新登记');
  if(ack.originalSampleHash !== await digest(original) || ack.originalSampleHash !== await digest(v.sample) || ack.sourceBindingsHash !== await digest(ack.sourceBindings)) return fail('原登记冻结事实回执不完整，请保留原请求核对');
  if(ack.sampleId !== 'SMP__register_'+identityHash || ack.receiptAuditId !== 'sample-register:'+identityHash
    || !['resolved','unresolved','conflict'].includes(v.currentSample.businessContext?.status) || !reasons(v.currentSample.businessContext?.reasons)
    || !['resolved','unresolved','conflict'].includes(v.sourceContext.status) || typeof v.sourceContext.currentUsable !== 'boolean'
    || !v.replayed && (v.currentSample.businessContext.status !== 'resolved' || v.currentSample.businessContext.businessLine !== p.businessLine)) return fail('当前登记对象与原案业务线不一致，请保留原请求核对');
  const ids=new Set<string>();
  for(const b of ack.sourceBindings) {
    const command=commands.find(c=>c.batchId === b.sampleBatchId), snapshot=b.sourceSnapshot;
    if(!command || !text(b.id) || ids.has(b.id) || b.sampleId !== ack.sampleId || b.sourceRound !== command.sourceRound || (b.sourceSealId ?? null) !== (p.command.sealOrigin?.sealId ?? null) || b.sourceFingerprint !== command.expectedContentFingerprint || b.sourceUpdatedAt !== command.expectedUpdatedAt || (b.sourceHistoryRevision ?? null) !== command.expectedHistoryRevision || (b.sourceEventId ?? null) !== command.expectedEventId || snapshot?.schemaVersion !== 1 || snapshot.batch?.id !== command.batchId || snapshot.batch.caseId !== p.command.sourceCaseId || snapshot.batch.factoryId !== command.expectedFactoryId || snapshot.batch.sourceRound !== command.sourceRound || snapshot.version?.updatedAt !== command.expectedUpdatedAt || snapshot.version.historyRevision !== command.expectedHistoryRevision || snapshot.version.eventId !== command.expectedEventId || !text(b.evidenceAuditId)) return fail('原登记来源回执不匹配，请保留原请求核对');
    ids.add(b.id);
    if(await digest({schemaVersion:snapshot.schemaVersion,batch:snapshot.batch,content:snapshot.content}) !== b.sourceFingerprint) return fail('原登记规格内容与来源证明不同，请核对原请求');
  }
  const proof=ack.auditProof;
  if(!text(proof?.create?.id) || !hash(proof.create.hash) || !Array.isArray(proof.bindings) || !proof.bindings.length || !proof.bindings.every((x:any)=>text(x?.id) && hash(x.hash)) || !unique(proof.bindings.map((x:any)=>x.id)) || !ack.sourceBindings.every((b:any)=>proof.bindings.some((x:any)=>x.id === b.evidenceAuditId))) return fail('原登记审计回执不完整，请保留原请求核对');
  return v;
}
interface Options { current?: () => boolean; signal?: AbortSignal; }
async function request(path: string, options: Options, body?: RegistrationCommand, verify: (value: any) => unknown | Promise<unknown> = value=>value): Promise<any> {
  if(!hasPermission('products:read') || body && !hasPermission('products:write')) throw new SampleRegistrationError('当前账号没有本次样品操作权限',false,403,'FORBIDDEN');
  const n=registrationNamespace(), headers=apiService.getAuthHeaders();
  const identity=()=>JSON.stringify([getAuthState(),apiService.getStoredConfig().cloudEndpoint,apiService.getAuthHeaders()]);
  const bound=identity();let stale=false,posted=false;
  const observe=()=>{if(identity() !== bound || options.current?.() === false || options.signal?.aborted) stale=true;};
  const check=()=>{observe();if(stale)throw new SampleRegistrationError(posted?'账号、权限、后台或来源已变化，请在原账号核对登记结果':'账号、权限、后台或来源已变化，请重新打开来源',posted);};
  const stop=subscribe(observe), events=['storage','focus',EMAIL_CONTEXT_EVENT];events.forEach(e=>window.addEventListener(e,observe));
  try { check();if(body)posted=true;const res=await fetch(apiService.buildApiUrl('/v1/samples'+path,n.endpoint),{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:options.signal});check();const data=await res.json();check();if(!res.ok)throw new SampleRegistrationError(typeof data?.error?.message === 'string'?data.error.message:'准确登记暂不可用，请保留原请求核对',false,res.status,data?.error?.code);const result=await verify(data);check();return result; }
  catch(e){if(e instanceof SampleRegistrationError)throw e;throw new SampleRegistrationError(posted?'登记结果暂时不确定，请核对原回执，勿另建样品':'准确来源暂时无法读取，请重试',posted);}
  finally{stop();events.forEach(e=>window.removeEventListener(e,observe));}
}
export const sampleRegistrationService={
  async context(caseId: string, options: Options = {}): Promise<RegistrationContext> { if(!text(caseId))return fail();return request('/registration/context?'+new URLSearchParams({caseId}),options,undefined,value=>checkedRegistrationContext(value,caseId)); },
  async register(p: PendingSampleRegistration, options: Options = {}): Promise<RegistrationResult> { const n=registrationNamespace();if(n.actorId !== p.actorId || n.endpoint !== p.endpoint || !validCommand(p.command))return fail();return request('/registration/exact',options,p.command,async value=>{try{return await checkedAck(value,p);}catch(e){throw new SampleRegistrationError(e instanceof Error?e.message:'原回执未确认',true);}}); },
  async recover(p: PendingSampleRegistration, options: Options = {}): Promise<RegistrationRecovery> { const n=registrationNamespace();if(n.actorId !== p.actorId || n.endpoint !== p.endpoint)return fail('请回到原账号和后台核对');return request('/registration/requests/'+encodeURIComponent(p.command.requestKey),options,undefined,async result=>{if(protocol(result) && result.state === 'not_confirmed' && result.requestKey === p.command.requestKey && result.retryOriginalRequest === true)return {state:'not_confirmed',retryOriginalRequest:true};if(result?.state !== 'committed')return fail('原登记核对响应不完整，请保留原请求');return {...await checkedAck(result,p),state:'committed'};}); },
};
