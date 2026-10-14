import { MIST_FINANCE_SCOPES } from './mistFinancePermissions';
import {developmentDomain,emptyFabricRequirements,fabricRequirementError,validFabricSample,type DevelopmentDomain,type FabricDevelopmentRequirements} from './mistDevelopmentDomain';
import { relationHoldReason } from './mistRelationHold';
import {createFulfillmentState,applyFulfillmentCommand,fulfillmentCommandPermission,getFulfillmentReviews,assertProductionTransition,type FulfillmentState,type FulfillmentCommand} from './mistFulfillment';
import {createMarketState,applyMarketCommand,marketCommandPermission,getMarketReviews,type MarketState,type MarketCommand} from './mistMarket';
import {createCrmState,applyCrmCommand,crmCommandPermission,type CrmState,type CrmCommand} from './mistCrm';
import {seedDemoModules,DEMO_SEED_VERSION} from './mistDemoSeed';
import {createEmailState,applyEmailCommand,emailCommandPermission,seedEmailExamples,type EmailState,type EmailCommand} from './mistEmail';
import {createPlatformState,applyPlatformCommand,platformCommandPermission,getPlatformReviews,platformCreditAppliedMinor,getRequiredBusinessNumberPlan as platformBusinessNumberPlan,type PlatformState,type PlatformCommand} from './mistPlatform';
import type {MistCreditDocumentIssue} from './mistCreditDocuments';
import type {MistReviewTask} from './mistReview';
import {createOrderGovernance,applyOrderGovernanceCommand,orderGovernancePermission,getOrderGovernanceReviews,assertOrderApproved,type OrderGovernanceFields,type OrderGovernanceCommand,type OrderGovernanceInput} from './mistOrderGovernance';
import {createOrderFundingState,applyOrderFundingCommand,orderFundingCommandPermission,assertOrderDepositCovered,assertOrderFundingIntegrity,type OrderFundingState,type OrderFundingCommand} from './mistOrderFunding';
import {createPayablesState,applyPayablesCommand,payablesCommandPermission,type PayablesState,type PayablesCommand} from './mistPayables';

/** Mist's typed business workspace. Shared by its API and the approved frontend. */
export type MistTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'ai';
export type MistImage = 'coat' | 'blazer' | 'suit' | 'clay';
export type MistBusinessNumberPrefix = 'CLM' | 'RT' | 'PV';
export type MistContext = {
  id: () => string; now: string; actorName: string; actorId?: string;
  /** 服务端从实时读投影生成，不能由命令 payload 扩大；不重构共享通知的数据模型。 */
  visibleNotificationIds?: string[];
  consumeBusinessNumber?: (prefix: MistBusinessNumberPrefix) => string;
  creditDocumentIssue?: MistCreditDocumentIssue;
  authority?: { supplier: Record<string,{version:number;userIds:string[]}>; claimReviewerId?:string; businessReviewerId?:string; orderReviewerIds?:{garment:string[];fabric:string[]} };
};
export type DevelopmentValues = {
  domain?:DevelopmentDomain; sampleForm?:string; sampleUnit?:string; targetCurrency?:string; targetUnit?:string; fabricRequirements?:FabricDevelopmentRequirements;
  name: string; customer: string; style: string; season: string; category: string;
  kind: 'new' | 'rev' | 'copy'; fabric: string; color: string; target: string;
  sizeBase: string; goal: string; factories: string[]; due: string;
  collaborators: string[]; sampleQuantity: number; sourceDevId?: string; sourceVersionId?: string;
};
export type MistFile = { id: string; name: string; mimeType: string; size: number; storageKey: string; createdAt: string; uploadedBy?: string; url?: string };
export type MistDraft = { id: string; values: DevelopmentValues; fileIds: string[]; updatedAt: string };
export type MistConfirmation = { id: string; result: 'approved' | 'needs_adjustment' | 'rejected'; confirmer: string; organization: string; confirmedAt: string; basis: string; originalText: string; recordedAt: string; recordedBy: string };
export type MistQc = {
  result: 'pass' | 'conditional' | 'reject'; reviewer: string; reviewedAt: string; report: string; opinion: string;
  fabricMeasurements?:Array<{property:string;actual:number;unit:string}>;
  measurements?: Array<{ point: string; standard: number; actual: number; tolerance: number }>;
  appearanceDefects?: number;
};
export type MistVersion = {
  id: string; devId: string; label: string; factory: string; sample: string; sampleQuantity: number;
  sampleForm?:string; sampleUnit?:string; sampleLocation?:string; sampleColor?:string; fabricRequirements?:FabricDevelopmentRequirements;
  size: string; fabric: string; img: MistImage; fileIds: string[]; returnedAt: string | null;
  qc: MistQc | null; confirmations: MistConfirmation[]; archivedAt: string | null; note: string;
  confirmationDraft?: Omit<MistConfirmation, 'id' | 'recordedAt' | 'recordedBy'>;
};
export type MistDev = {
  id: string; code: string; name: string; style: string; owner: string; due: string; dueRel: string;
  stage: number; state: string; tone: MistTone; ver: string; fac: number; img: MistImage;
  factory: string; sample: string; fabric: string; goal: string; customer: string; customerId: string;
  currentVersionId: string | null; versionIds: string[]; values: DevelopmentValues; fileIds: string[];
  createdAt: string; updatedAt: string;
};
export type MistFabric = { id: string; code: string; name: string; owner: string; due: string; state: string; tone: MistTone; sub: string; request: string; answer: string; confirmed: boolean; fileIds: string[] };
export type MistOrderLine = { id: string; orderId: string; name: string; style: string; img: MistImage; qty: number; unit: string; price: number; made: number; qc: number };
export type MistChecklistItem = { id: string; label: string; done: boolean; note: string; actor?: string; at?: string };
export type MistOrder = {
  governance?:OrderGovernanceFields;
  id: string; code: string; type: 'garment' | 'fabric'; customerId: string; customer: string;
  season: string; lines: number; qty: number; amount: number; currency: string; due: string;
  progress: number; state: string; tone: MistTone; owner: string; img: MistImage;
  checklist: MistChecklistItem[]; handoffAt: string | null; createdAt: string; updatedAt: string;
};
export type MistProduction = { sourcePurchaseId?:string; id: string; code: string; orderId: string; lineId: string; order: string; name: string; factory: string; qty: number; due: string; pct: number; img: MistImage; col: 'cut' | 'sew' | 'finish' | 'qc' | 'done'; risk?: string; startDate?: string };
export type MistPayment = { id: string; code: string; date: string; payee: string; amount: number; currency: string; ref: string };
export type MistReceipt = { id: string; code: string; date: string; payer: string; amount: number; remaining: number; currency: string; ref: string; state: 'unmatched' | 'suggested' | 'matched'; suggest?: string; confidence?: number };
export type MistInvoice = { id: string; code: string; orderId: string; order: string; customer: string; due: string; amount: number; open: number; currency: string; voidedAt?: string; voidReason?: string; voidedBy?: string; voidedById?: string; voidSourceDocumentId?: string };
/** Void preserves the original face value while removing the invoice from current receivables. */
export function isActiveMistInvoice(invoice: Pick<MistInvoice, 'voidedAt'>): boolean { return !invoice.voidedAt; }
export type MistAllocation = { id: string; receiptId: string; invoiceId: string; amount: number; currency: string; createdAt: string; actor: string; payerBasis?:string };
export type MistCustomer = { id: string; name: string; code: string; country: string; city: string; industry: string; owner: string; grade: string; currency: string; terms: string; incoterm: string; categories: string; creditLimit: number; since: string };
export type MistContact = { id: string; customerId: string; name: string; role: string; email: string; phone: string; tone: MistTone };
export type MistEvent = { id: string; entityType: string; entityId: string; actor: string; at: string; text: string; fileIds: string[] };
export type MistTarget = { view: string; id?: string; versionId?: string; customerId?: string; orderLineId?: string; productionId?: string };
export type MistTask = { id: string; title: string; due: string; done: boolean; kind: string; target: MistTarget };
export type MistNotification = { id: string; title: string; detail: string; at: string; readAt: string | null; target: MistTarget; category?:'qc'|'shipping'|'suggestion'|'general' };
export type MistCalendarEvent = { id: string; title: string; date: string; time: string; note: string; target?: MistTarget };
export type MistCompanyProfile={legalName:string;englishName:string;address:string;englishAddress:string;phone:string;email:string;taxId:string;customsCode:string;bankName:string;bankAccount:string;swift:string;defaultCurrency:string};
export type MistSettings = { companyProfile?:MistCompanyProfile; theme: 'light' | 'dark' | 'system'; density: 'compact' | 'default' | 'comfy'; reducedMotion: boolean; notifications: { qc: boolean; shipping: boolean; suggestions: boolean; digest: boolean }; workspaceName: string; profileName: string; profileEmail: string; locale: string; /** 仅演示工作区：示例数据版本；客户端不可设置。 */ demoSeed?: { version: number; seededAt: string } };
export type MistState = {
  orderFunding?:OrderFundingState;
  payables?:PayablesState;
  workspaceArchive?: {at:string;actorId:string};
  schemaVersion: 1; devs: MistDev[]; versions: MistVersion[]; drafts: MistDraft[]; fabrics: MistFabric[];
  orders: MistOrder[]; orderLines: MistOrderLine[]; productions: MistProduction[];
  receipts: MistReceipt[]; invoices: MistInvoice[]; allocations: MistAllocation[]; payments: MistPayment[];
  customers: MistCustomer[]; contacts: MistContact[]; files: MistFile[];
  events: MistEvent[]; tasks: MistTask[]; notifications: MistNotification[]; calendar: MistCalendarEvent[];
  settings: MistSettings; fulfillment:FulfillmentState; market:MarketState; platform:PlatformState; email:EmailState; crm:CrmState; reviewerIds?:string[];
  /** 所有者明确授权进入本空间的账号（只管进入，不授予业务权限）与授权历史。 */
  memberIds?:string[]; members?:MistWorkspaceMember[]; memberLog?:MistWorkspaceMemberLog[];
};
export type MistOrderInput = { type: 'garment' | 'fabric'; customerId: string; season: string; currency: string; due: string; owner: string; governance?:OrderGovernanceInput; lines: Array<Omit<MistOrderLine, 'id' | 'orderId' | 'made' | 'qc'>> };
export type MistCommand = FulfillmentCommand | MarketCommand | PlatformCommand | EmailCommand | CrmCommand | OrderGovernanceCommand | OrderFundingCommand | PayablesCommand
  | { type: 'development.saveDraft'; payload: { draftId?: string; values: DevelopmentValues; fileIds: string[] } }
  | { type: 'development.submit'; payload: { draftId?: string; values: DevelopmentValues; fileIds: string[] } }
  | { type: 'development.update'; payload: { devId: string; patch: Partial<DevelopmentValues> } }
  | { type: 'development.move'; payload: { devId: string; stage: number } }
  | { type: 'development.recordSample'; payload: { devId: string; versionId: string; sample: string; quantity: number; returnedAt: string; form?:string; unit?:string; location?:string; color?:string } }
  | { type: 'development.recordQc'; payload: { devId: string; versionId: string; qc: MistQc; domain?:DevelopmentDomain } }
  | { type: 'development.confirm'; payload: { devId: string; versionId: string; result: MistConfirmation['result']; confirmer: string; organization: string; confirmedAt: string; basis: string; originalText: string } }
  | { type: 'development.saveConfirmationDraft'; payload: { devId: string; versionId: string; draft: Omit<MistConfirmation, 'id' | 'recordedAt' | 'recordedBy'> } }
  | { type: 'development.revise'; payload: { devId: string; versionId: string; note: string } }
  | { type: 'development.archive'; payload: { devId: string; versionId: string } }
  | { type: 'fabric.create'; payload: { name: string; request: string; owner: string; due: string } }
  | { type: 'fabric.answer'; payload: { id: string; answer: string; fileIds: string[] } }
  | { type: 'fabric.confirm'; payload: { id: string; approved: boolean; note: string } }
  | { type: 'order.create'; payload: MistOrderInput }
  | { type: 'order.update'; payload: { orderId: string; due?: string; season?: string; owner?: string } }
  | { type: 'order.checklist'; payload: { orderId: string; itemId: string; done: boolean } }
  | { type: 'order.handoff'; payload: { orderId: string; note?: string } }
  | { type: 'production.move'; payload: { id: string; col: MistProduction['col']; note?: string } }
  | { type: 'production.update'; payload: { id: string; pct: number; risk?: string; note?: string; startDate?: string; due?: string } }
  | { type: 'finance.importReceipts'; payload: { receipts: Array<{ date: string; payer: string; amount: number; currency: string; ref: string }> } }
  | { type: 'finance.reconcile'; payload: { receiptId: string; invoiceId: string; amount?: number; payerBasis?:string } }
  | { type: 'finance.acceptSuggestions'; payload: { receiptIds: string[] } }
  | { type: 'finance.payment.save'; payload: { date: string; payee: string; amount: number; currency: string; ref: string } }
  | { type: 'customer.update'; payload: { id: string; patch: Partial<Omit<MistCustomer, 'id'>> } }
  | { type: 'contact.save'; payload: { id?: string; customerId: string; name: string; role: string; email: string; phone: string } }
  | { type: 'contact.delete'; payload: { id: string } }
  | { type: 'settings.update'; payload: Partial<MistSettings> }
  | { type: 'notification.read'; payload: { id: string } }
  | { type: 'notification.readAll'; payload: Record<string, never> }
  | { type: 'task.complete'; payload: { id: string; done: boolean } }
  | { type: 'calendar.save'; payload: { id?: string; title: string; date: string; time: string; note: string; target?: MistTarget } }
  | { type: 'files.add'; payload: { file: MistFile } };

export class MistCommandError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); this.name = 'MistCommandError'; }
}

/** Existing unverified records remain readable, but cannot authorize new fulfillment. */
export function assertMistOrderApproved(state:MistState,orderId:string):MistOrder {
  return assertOrderApproved(state,orderId);
}
export function assertMistOrderDeposit(state:MistState,orderId:string):void {
  assertMistOrderApproved(state,orderId);assertOrderDepositCovered(state,orderId);
}

export type MistCommandResult = { id?: string; draftId?: string; devId?: string; versionId?: string; orderId?: string; contactId?: string; fileId?: string; applied?: number; [key: string]: unknown };
export type MistWorkspaceMember={userId:string;name:string;addedBy:string;addedByName:string;addedAt:string};
export type MistWorkspaceMemberLog={id:string;action:'add'|'remove';userId:string;name:string;actorId:string;actorName:string;at:string};
/** 服务端按当前账号现有读权限裁剪数据后附带的说明：hidden 为当前账号无权查看、已被隐藏的数据范围。 */
export type MistWorkspaceAccess={role:'owner'|'member';canManageMembers:boolean;hidden:Array<{key:string;label:string;permissions:string[]}>};
export type MistWorkspaceEnvelope = { id: string; ownerId: string; name: string; revision: number; state: MistState; access?: MistWorkspaceAccess };
export type MistRunReceipt = { requestId: string; revision: number; result: MistCommandResult };

import * as Seed from './mistSeed';

const STAGES = ['需求与计划', '工厂与实物', 'QC 评审', '需求方确认', '成果留档'];
const COLS = ['cut', 'sew', 'finish', 'qc', 'done'];
const text = (value: unknown, label: string, required = true, max = 8000): string => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new MistCommandError('VALIDATION', label + '未填写或格式无效');
  return value.trim();
};
const positive = (value: unknown, label: string, allowZero = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (allowZero ? 0 : Number.MIN_VALUE) || value > 1e12) throw new MistCommandError('VALIDATION', label + '必须为有效正数');
  return value;
};
export function mistMoneyMinor(value: number | string): number {
  const source = String(value);
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(source)) throw new MistCommandError('VALIDATION', '金额须为最多两位小数的非负数');
  const [whole, fraction = ''] = source.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new MistCommandError('VALIDATION', '金额超出支持范围');
  return cents;
}
const major = (value: number) => value / 100;
const moneySum = (values: number[]) => {
  const total=values.reduce((sum,value)=>sum+BigInt(mistMoneyMinor(value)),BigInt(0));
  if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new MistCommandError('VALIDATION','总金额超出支持范围');
  return major(Number(total));
};
export const lineAmount = (qty: number, price: number) => {
  const q = String(qty);
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(q)) throw new MistCommandError('VALIDATION', '数量最多支持四位小数');
  const [whole, fraction = ''] = q.split('.');
  const units = BigInt(whole) * BigInt(10000) + BigInt(fraction.padEnd(4, '0'));
  const cents = (units * BigInt(mistMoneyMinor(price)) + BigInt(5000)) / BigInt(10000);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new MistCommandError('VALIDATION', '条目金额超出支持范围');
  return Number(cents) / 100;
};
const date = (value: unknown, label = '日期'): string => {
  const source = text(value, label, true, 40);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source) || !Number.isFinite(Date.parse(source + 'T00:00:00Z')) || new Date(source + 'T00:00:00Z').toISOString().slice(0, 10) !== source) throw new MistCommandError('VALIDATION', label + '格式无效');
  return source;
};
const instant = (value: unknown, context: MistContext): string => {
  const source = text(value, '确认时间', true, 60), at = Date.parse(source);
  if (!Number.isFinite(at) || at > Date.parse(context.now) + 1000) throw new MistCommandError('VALIDATION', '确认时间须为已发生的实际时间');
  return new Date(at).toISOString();
};
const find = <T extends {id: string}>(items: T[], id: string, name: string): T => {
  const item = items.find(row => row.id === id);
  if (!item) throw new MistCommandError('NOT_FOUND', name + '不存在', 404);
  return item;
};
const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length > 100) throw new MistCommandError('VALIDATION', label + '格式无效');
  return [...new Set(value.map(item => text(item, label, true, 240)))];
};
const iso = (value: string, context: MistContext) => /^\d\d\/\d\d$/.test(value) ? context.now.slice(0,4) + '-' + value.replace('/', '-') : value;
function emptyValues(): DevelopmentValues {
  return {name:'',customer:'',style:'',season:'',category:'',kind:'new',fabric:'',color:'',target:'',sizeBase:'',goal:'',factories:[],due:'',collaborators:[],sampleQuantity:1};
}
function values(input: DevelopmentValues, complete: boolean): DevelopmentValues {
  const v = {...emptyValues(), ...input};
  for (const key of ['name','customer','style','season','category','fabric','color','target','sizeBase','goal','due'] as const) v[key] = text(v[key], key, complete && (['name','customer'].includes(key)||(key==='style'&&developmentDomain(v)==='garment')));
  if (!['new','rev','copy'].includes(v.kind)) throw new MistCommandError('VALIDATION','开发类型无效');
  v.factories = strings(v.factories, '工厂'); v.collaborators = strings(v.collaborators, '协作人');
  if (v.due) v.due = date(v.due, '目标日期');
  v.sampleQuantity = positive(Number(v.sampleQuantity), '首样数量');
  if(v.domain!==undefined&&!['garment','fabric'].includes(v.domain))throw new MistCommandError('VALIDATION','开发业务域无效');
  if(developmentDomain(v)==='fabric'){
    for(const key of ['sampleForm','sampleUnit','targetCurrency','targetUnit'] as const)v[key]=text(v[key]||'',key,false,120);
    if(complete&&!validFabricSample(v.sampleQuantity,v.sampleForm||'',v.sampleUnit||''))throw new MistCommandError('VALIDATION','面料计划样品须记录实际形态与单位：米样按米，其他剪片类按整数份');
    if(v.fabricRequirements){if(typeof v.fabricRequirements!=='object'||Array.isArray(v.fabricRequirements))throw new MistCommandError('VALIDATION','面料目标规格格式无效');v.fabricRequirements={...emptyFabricRequirements(),...v.fabricRequirements};for(const key of Object.keys(v.fabricRequirements) as Array<keyof FabricDevelopmentRequirements>)v.fabricRequirements[key]=text(v.fabricRequirements[key],key,false);const problem=fabricRequirementError(v.fabricRequirements);if(complete&&problem)throw new MistCommandError('VALIDATION',problem);}
    if(complete&&v.target&&(!v.targetCurrency||!v.targetUnit))throw new MistCommandError('VALIDATION','面料目标价须同时填写币种与计价单位');
    v.sizeBase='';
  }
  if (v.target) mistMoneyMinor(v.target);
  return v;
}
function files(state: MistState, ids: string[]) {
  const unique = strings(ids, '附件');
  unique.forEach(id => find(state.files, id, '附件'));
  return unique;
}
function event(state: MistState, context: MistContext, entityType: string, entityId: string, message: string, target?: MistTarget, category:NonNullable<MistNotification['category']>='general') {
  state.events.unshift({id:context.id(),entityType,entityId,actor:context.actorName,at:context.now,text:message,fileIds:[]});
  if (target) state.notifications.unshift({id:context.id(),title:message,detail:context.actorName,at:context.now,readAt:null,target,category});
}
function versionOf(state: MistState, devId: string, versionId: string): [MistDev, MistVersion] {
  const dev = find(state.devs,devId,'开发案'), version = find(state.versions,versionId,'版本');
  if (version.devId !== dev.id || !dev.versionIds.includes(version.id)) throw new MistCommandError('VALIDATION','版本不属于当前开发案');
  return [dev,version];
}
function addVersions(state: MistState, dev: MistDev, context: MistContext, round = 1) {
  dev.values.factories.forEach((factory,index) => {
    const id=context.id(), label='R'+round+'-'+String.fromCharCode(65+index)+'-1';
    state.versions.push({...((developmentDomain(dev.values)==='fabric'&&dev.values.fabricRequirements)?{fabricRequirements:JSON.parse(JSON.stringify(dev.values.fabricRequirements))}:{}),id,devId:dev.id,label,factory,sample:'',sampleQuantity:dev.values.sampleQuantity,size:dev.values.sizeBase,fabric:dev.values.fabric,img:dev.img,fileIds:[...dev.fileIds],returnedAt:null,qc:null,confirmations:[],archivedAt:null,note:dev.values.goal});
    dev.versionIds.push(id);
    if (!dev.currentVersionId) dev.currentVersionId=id;
  });
}
function updateDev(state: MistState, dev: MistDev, context: MistContext) {
  const version=state.versions.find(row=>row.id===dev.currentVersionId);
  dev.fac=dev.values.factories.length; dev.factory=version?.factory || dev.values.factories[0] || '待定';
  dev.ver=version?.label || '—'; dev.sample=version?.sample || '—'; dev.updatedAt=context.now;
  const latest=version?.confirmations.at(-1);
  if(version?.archivedAt){dev.stage=4;dev.state='成果已留档';dev.tone='ok';}
  else if(latest?.result==='approved'){dev.stage=4;dev.state='已认可 · 待留档';dev.tone='ok';}
  else if(latest?.result==='rejected'){dev.stage=3;dev.state='不采用';dev.tone='bad';}
  else if(latest?.result==='needs_adjustment'){dev.stage=3;dev.state='待改版';dev.tone='warn';}
  else if(version?.qc?.result==='reject'){dev.stage=2;dev.state='QC 不通过';dev.tone='bad';}
  else if(version?.qc){dev.stage=3;dev.state=version.qc.result==='conditional'?'有保留通过 · 待确认':'待需求方确认';dev.tone='accent';}
  else if(version?.returnedAt){dev.stage=2;dev.state='QC 待评审';dev.tone='warn';}
  else if(version){dev.stage=1;dev.state=developmentDomain(dev.values)==='fabric'?'待工厂试样':'工厂制作中';dev.tone='neutral';}
  else {dev.stage=0;dev.state='开发计划';dev.tone='neutral';}
}
function recalculate(state: MistState) {
  for(const invoice of state.invoices) invoice.open=isActiveMistInvoice(invoice)?major(Math.max(0,mistMoneyMinor(invoice.amount)-state.allocations.filter(a=>a.invoiceId===invoice.id).reduce((s,a)=>s+mistMoneyMinor(a.amount),0)-platformCreditAppliedMinor(state,invoice.id))):0;
  for(const receipt of state.receipts){
    receipt.remaining=major(Math.max(0,mistMoneyMinor(receipt.amount)-state.allocations.filter(a=>a.receiptId===receipt.id).reduce((s,a)=>s+mistMoneyMinor(a.amount),0)));
    if(receipt.remaining===0) receipt.state='matched';
  }
  for(const order of state.orders){
    const rows=state.orderLines.filter(line=>line.orderId===order.id);
    order.lines=rows.length; order.qty=rows.reduce((s,row)=>s+row.qty,0);
    order.amount=moneySum(rows.map(row=>lineAmount(row.qty,row.price)));
    const jobs=state.productions.filter(job=>job.orderId===order.id), quantity=jobs.reduce((s,p)=>s+p.qty,0);
    if(quantity) order.progress=Math.round(jobs.reduce((s,p)=>s+p.qty*p.pct,0)/quantity);
    const shipments=(state.fulfillment?.shipments||[]).filter(s=>s.lines.some(line=>line.orderId===order.id)&&s.state!=='cancelled');
    const departed=shipments.filter(s=>s.state==='departed');
    if(order.governance&&order.governance.status!=='approved'){
      order.state=order.governance.status==='pending'?'待主单审批':order.governance.status==='rejected'?'主单已退回':'订单草稿';order.tone=order.governance.status==='pending'?'warn':order.governance.status==='rejected'?'bad':'neutral';
    }else if(departed.length){
      const complete=rows.every(line=>departed.reduce((sum,s)=>sum+s.lines.filter(item=>item.lineId===line.id).reduce((n,item)=>n+Math.round(item.quantity*10000),0),0)>=Math.round(line.qty*10000));
      const unpaid=state.invoices.some(invoice=>invoice.orderId===order.id&&invoice.open>0);
      order.state=complete?(unpaid?'待收尾款':'已出运'):'部分出运';order.tone=complete?(unpaid?'warn':'ok'):'accent';
    }else if(shipments.length){order.state='出运准备中';order.tone='accent';}
    else if(jobs.some(job=>job.sourcePurchaseId)){
      order.state=jobs.every(job=>job.col==='done')?'待出运':jobs.some(job=>job.col==='qc')?'待终期 QC':'生产中';order.tone='accent';
    }else if((state.fulfillment?.purchases||[]).some(p=>p.orderId===order.id&&p.state==='approved')){order.state='备料中';order.tone='neutral';}
  }
}
export function createMistState(context: MistContext, seed: 'demo'|'empty' = 'demo', onDemoSeedFailures?: (failures: Array<{step:string;message:string}>) => void): MistState {
  const state={schemaVersion:1,devs:[],versions:[],drafts:[],fabrics:[],orders:[],orderLines:[],productions:[],receipts:[],invoices:[],allocations:[],payments:[],customers:[],contacts:[],files:[],events:[],tasks:[],notifications:[],calendar:[],settings:{theme:'system',density:'default',reducedMotion:false,notifications:{qc:true,shipping:true,suggestions:true,digest:false},workspaceName:'成衣一组',profileName:context.actorName,profileEmail:'',locale:'zh-CN'}} as unknown as MistState;
  normalizeMistState(state,context);
  if(seed==='empty') return state;
  const customers=[...new Set(Seed.ORDERS.map(row=>row.customer))];
  state.customers=customers.map((name,index)=>({id:'customer-'+index,name,code:'CUS-'+String(index+1).padStart(4,'0'),country:index===0?'英国':'',city:index===0?'伦敦':'',industry:'服装零售',owner:index===1?'沈禾':'顾言',grade:index===0?'A · 战略客户':'B · 合作客户',currency:'USD',terms:'T/T 30/70',incoterm:'FOB 上海',categories:'大衣 · 西装 · Blazer',creditLimit:index===0?200000:100000,since:'2023-04-01'}));
  for(const source of Seed.DEVS){
    const v:DevelopmentValues={...emptyValues(),name:source.name,customer:source.customer,style:source.style,season:'AW27',category:source.name.includes('Blazer')?'Blazer':source.name.includes('西装')?'西装':'大衣',fabric:source.fabric,sizeBase:'M',goal:source.goal,due:iso(source.due,context),factories:source.fac? [source.factory,...(source.fac>1?[source.factory==='江南成衣'?'远山服装':'江南成衣']:[])]:[],sampleQuantity:2};
    const dev:MistDev={...source,id:source.id,code:source.id,img:source.img as MistImage,tone:source.tone as MistTone,customerId:state.customers.find(c=>c.name===source.customer)!.id,values:v,versionIds:[],currentVersionId:null,fileIds:[],createdAt:context.now,updatedAt:context.now,due:v.due};
    state.devs.push(dev); addVersions(state,dev,context,Number(source.ver.match(/^R(\d+)/)?.[1]||1));
    if(dev.currentVersionId){
      const version=state.versions.find(row=>row.id===dev.currentVersionId)!;
      version.label=source.ver; version.sample=source.sample==='—'?'':source.sample;
      if(version.sample) version.returnedAt=iso('10/10',context)+'T08:00:00Z';
      if(source.stage===3) version.qc={result:'pass',reviewer:'许言',reviewedAt:iso('10/11',context)+'T09:02:00Z',report:'QC-G-2026-0086',opinion:'外观与尺寸已由 QC 专业评审通过。',...(source.id==='DEV-G-2026-031'?{measurements:[{point:'胸围',standard:112,actual:112.4,tolerance:1},{point:'衣长',standard:104,actual:103.6,tolerance:1},{point:'袖长',standard:63.5,actual:64.1,tolerance:1},{point:'肩宽',standard:46,actual:46.2,tolerance:1}],appearanceDefects:0}:{measurements:[]})};
      else if(source.id==='DEV-G-2026-021') version.qc={result:'reject',reviewer:'许言',reviewedAt:iso('10/11',context)+'T09:02:00Z',report:'QC-G-2026-0084',opinion:'袖长需修正，等待新样复验。'};
    }
  }
  state.fabrics=Seed.FABRICS.map(row=>({...row,code:row.id,tone:row.tone as MistTone,due:iso(row.due,context),request:row.name,answer:row.state==='已结案'?'已按要求找到并确认面料。':'',confirmed:row.state==='已结案',fileIds:[]}));
  state.orders=Seed.ORDERS.map(row=>({...row,code:row.id,type:'garment',img:row.img as MistImage,tone:row.tone as MistTone,customerId:state.customers.find(c=>c.name===row.customer)!.id,due:iso(row.due,context),handoffAt:null,createdAt:context.now,updatedAt:context.now,checklist:['拟发范围确认','收货与贸易条款确认','收款条件核对','装箱单草稿','唛头确认','尾期 QC 预约','报关资料','订舱'].map((label,index)=>({id:row.id+'-check-'+index,label,done:index===3||index===4,note:index===6?'待补齐':'',...(index===3||index===4?{actor:'顾言',at:context.now}:{})}))}));
  for(const order of state.orders){
    const base=order.code==='SO-G-2026-018'?Seed.ORDER_LINES:null;
    const jobs=Seed.PRODS.filter(p=>p.order===order.code);
    for(let index=0;index<order.lines;index++){
      const original=base?.[index], job=jobs[index], fallback=Seed.DEVS[index%Seed.DEVS.length];
      const qty=original?.qty ?? (job?.qty ?? Math.floor(order.qty/order.lines)+(index===order.lines-1?order.qty%order.lines:0));
      state.orderLines.push({id:order.id+'-line-'+index,orderId:order.id,name:original?.name||job?.name||fallback.name,style:original?.style||fallback.style,img:(original?.img||job?.img||fallback.img) as MistImage,qty,unit:'件',price:original?.price??major(Math.round(mistMoneyMinor(order.amount)/order.qty)),made:original?.made??job?.pct??order.progress,qc:original?.qc??0});
    }
  }
  state.productions=Seed.PRODS.map(source=>{const order=state.orders.find(o=>o.code===source.order)!, line=state.orderLines.find(l=>l.orderId===order.id&&l.name===source.name)||state.orderLines.find(l=>l.orderId===order.id)!;return {...source,code:source.id,orderId:order.id,lineId:line.id,col:source.col as MistProduction['col'],img:source.img as MistImage,due:iso(source.due,context)};});
  state.receipts=Seed.RECEIPTS.map(row=>({...row,code:row.id,state:row.state as MistReceipt['state'],date:iso(row.date,context),remaining:row.amount}));
  state.invoices=Seed.INVOICES.map(row=>({...row,code:row.id,orderId:state.orders.find(o=>o.code===row.order)!.id,due:iso(row.due,context)}));
  for(const receipt of state.receipts) if(receipt.state==='matched'&&receipt.suggest){
    const invoice=state.invoices.find(row=>row.code===receipt.suggest);
    if(invoice) state.allocations.push({id:context.id(),receiptId:receipt.id,invoiceId:invoice.id,amount:receipt.amount,currency:receipt.currency,createdAt:context.now,actor:'财务'});
  }
  // Seed prior paid amounts as explicit allocations, never as an inconsistent open balance.
  for(const source of Seed.INVOICES) if(source.open<source.amount&&!state.allocations.some(a=>a.invoiceId===source.id)){
    const amount=major(mistMoneyMinor(source.amount)-mistMoneyMinor(source.open)), receiptId=context.id();
    state.receipts.push({id:receiptId,code:'BR-历史-'+source.id,date:iso('10/01',context),payer:source.customer,amount,remaining:0,currency:source.currency,ref:source.id,state:'matched',suggest:source.id});
    state.allocations.push({id:context.id(),receiptId,invoiceId:source.id,amount,currency:source.currency,createdAt:context.now,actor:'财务'});
  }
  state.contacts=Seed.CONTACTS.map((row,index)=>({...row,id:'contact-'+index,customerId:state.customers[0].id,phone:'',tone:row.tone as MistTone}));
  state.tasks=state.devs.slice(0,4).map(dev=>({id:context.id(),title:dev.name,due:dev.due,done:false,kind:'development',target:{view:'development/detail',id:dev.id,versionId:dev.currentVersionId||undefined}}));
  state.calendar=[{id:context.id(),title:'秋冬首样评审',date:iso('10/12',context),time:'14:00',note:'顾言、沈禾、QC 许言 · 30 分钟',target:{view:'development/detail',id:state.devs[0].id}}];
  state.notifications=[{id:context.id(),category:'qc',title:'首样评审报告已回传',detail:'查看当前版本的专业评审结果。',at:context.now,readAt:null,target:{view:'development/detail',id:state.devs[0].id,versionId:state.devs[0].currentVersionId||undefined}}];
  seedEmailExamples(state,context);
  recalculate(state);
  // 各模块示例数据：经真实业务命令生成，失败步骤被跳过（测试要求零失败）。
  const demo=seedDemoModules(state,context),seeded=demo.state;onDemoSeedFailures?.(demo.failures);
  seeded.settings.demoSeed={version:DEMO_SEED_VERSION,seededAt:context.now};
  recalculate(seeded);
  return seeded;
}

export function getRequiredBusinessNumberPlan(state: MistState, command: MistCommand) { return platformBusinessNumberPlan(state, command); }
export function mistCommandPermission(command: MistCommand): string | null {
  if(command.type.startsWith('order.governance.'))return orderGovernancePermission(command as OrderGovernanceCommand);
  if(command.type.startsWith('funding.'))return orderFundingCommandPermission(command as OrderFundingCommand);
  if(command.type.startsWith('payable.'))return payablesCommandPermission(command as PayablesCommand);
  if(command.type.startsWith('fulfillment.'))return fulfillmentCommandPermission(command as FulfillmentCommand);
  if(command.type.startsWith('market.'))return marketCommandPermission(command as MarketCommand);
  if(command.type.startsWith('platform.'))return platformCommandPermission(command as PlatformCommand);
  if(command.type.startsWith('email.'))return emailCommandPermission(command as EmailCommand);
  if(command.type.startsWith('crm.'))return crmCommandPermission(command as CrmCommand);
  if(command.type==='development.recordQc')return command.payload.domain==='fabric'?'qc:fabric_chain:write':'qc:garment_chain:write';
  if(command.type.startsWith('development.')||command.type.startsWith('fabric.')||command.type==='files.add')return 'products:write';
  if(command.type.startsWith('order.')||command.type.startsWith('production.'))return 'orders:write';
  if(command.type==='finance.importReceipts'||command.type==='finance.payment.save')return MIST_FINANCE_SCOPES.voucher;
  if(command.type==='finance.reconcile'||command.type==='finance.acceptSuggestions')return MIST_FINANCE_SCOPES.reconcile;
  if(command.type.startsWith('finance.'))throw new MistCommandError('VALIDATION','未知财务操作');
  if(command.type.startsWith('customer.')||command.type.startsWith('contact.'))return 'relations:write';
  if(['settings.update','notification.read','notification.readAll','task.complete','calendar.save'].includes(command.type))return null;
  throw new MistCommandError('VALIDATION','未知操作');
}
export function applyMistCommand(original: MistState, command: MistCommand, context: MistContext): {state:MistState;result:MistCommandResult} {
  if(!original||original.schemaVersion!==1)throw new MistCommandError('INVALID_STATE','工作区数据版本无效',500);
  if(!command||typeof command.type!=='string'||!command.payload||typeof command.payload!=='object')throw new MistCommandError('VALIDATION','操作格式无效');
  mistCommandPermission(command);
  const state: MistState=JSON.parse(JSON.stringify(original));
  normalizeMistState(state,context);
  if(command.type.startsWith('order.governance.')){const result=applyOrderGovernanceCommand(state,command as OrderGovernanceCommand,context);recalculate(state);assertOrderFundingIntegrity(state);return {state,result};}
  if(command.type.startsWith('funding.')){const result=applyOrderFundingCommand(state,command as OrderFundingCommand,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('payable.')){const result=applyPayablesCommand(state,command as PayablesCommand,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('fulfillment.')){const result=applyFulfillmentCommand(state,command as FulfillmentCommand,context);normalizeMistState(state,context);recalculate(state);return {state,result};}
  if(command.type==='market.lead.convertToCrm'){const result=convertLeadToCrm(state,command.payload as Extract<MarketCommand,{type:'market.lead.convertToCrm'}>['payload'],context);recalculate(state);return {state,result};}
  if(command.type.startsWith('market.')){const result=applyMarketCommand(state,command as MarketCommand,context);for(const order of state.orders)if(!original.orders.some(old=>old.id===order.id)&&!order.governance){order.governance=createOrderGovernance(context);order.state='订单草稿';order.tone='neutral';order.checklist=['拟发范围确认','收货与贸易条款确认','收款条件核对'].map((label,index)=>({id:order.id+'-check-'+index,label,done:false,note:''}));}normalizeMistState(state,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('platform.')){const result=applyPlatformCommand(state,command as PlatformCommand,context);normalizeMistState(state,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('email.')){const result=applyEmailCommand(state,command as EmailCommand,context);normalizeMistState(state,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('crm.')){const result=applyCrmCommand(state,command as CrmCommand,context);normalizeMistState(state,context);recalculate(state);return {state,result};}
  const p:any=command.payload;
  let result:MistCommandResult={};
  switch(command.type){
    case 'development.saveDraft': {
      const v=values(p.values,false), fileIds=files(state,p.fileIds), id=p.draftId||context.id();
      if(p.draftId)find(state.drafts,p.draftId,'草稿');
      state.drafts=state.drafts.filter(d=>d.id!==id);
      state.drafts.push({id,values:v,fileIds,updatedAt:context.now}); result={id,draftId:id}; break;
    }
    case 'development.submit': {
      const v=values(p.values,true), fileIds=files(state,p.fileIds);
      if(p.draftId)find(state.drafts,p.draftId,'草稿');
      if(v.kind!=='new'&&!v.sourceDevId)throw new MistCommandError('VALIDATION','请选择来源开发案');
      if(v.sourceVersionId){const source=find(state.versions,v.sourceVersionId,'来源版本');if(source.devId!==v.sourceDevId)throw new MistCommandError('VALIDATION','来源版本不属于准确来源开发案');}
      if(v.sourceDevId&&developmentDomain(find(state.devs,v.sourceDevId,'来源开发案').values)!==developmentDomain(v))throw new MistCommandError('VALIDATION','来源开发案业务域不同，请分别创建开发案');
      if(developmentDomain(v)==='fabric'){if(!v.factories.length)throw new MistCommandError('VALIDATION','请至少选择一家实际面料工厂');for(const name of v.factories){const matches=state.market.suppliers.filter(s=>s.name===name);if(matches.length!==1||matches[0].status!=='active'||!/面料|纺织|织造|染整|fabric|textile|weav|dye/i.test(matches[0].type+' '+matches[0].capabilities))throw new MistCommandError('VALIDATION','请选择当前有效且名称唯一的面料工厂');}if(!v.due)throw new MistCommandError('VALIDATION','请填写目标日期');}
      const customer=state.customers.find(c=>c.id===v.customer)||(state.customers.filter(c=>c.name===v.customer).length===1?state.customers.find(c=>c.name===v.customer):undefined);
      if(!customer)throw new MistCommandError('VALIDATION','请选择已有客户');
      const id=context.id(), code='DEV-'+context.now.slice(0,4)+'-'+String(state.devs.length+1).padStart(4,'0');
      const dev:MistDev={id,code,name:v.name,style:v.style,owner:context.actorName,due:v.due,dueRel:'',stage:0,state:'开发计划',tone:'neutral',ver:'—',fac:v.factories.length,img:developmentDomain(v)==='fabric'?'clay':v.category.includes('西装')?'suit':v.category.includes('Blazer')?'blazer':'coat',factory:v.factories[0]||'待定',sample:'—',fabric:v.fabric,goal:v.goal,customer:customer.name,customerId:customer.id,currentVersionId:null,versionIds:[],values:{...v,customer:customer.name},fileIds,createdAt:context.now,updatedAt:context.now};
      state.devs.unshift(dev); addVersions(state,dev,context); updateDev(state,dev,context);
      if(p.draftId)state.drafts=state.drafts.filter(d=>d.id!==p.draftId);
      state.tasks.unshift({id:context.id(),title:'推进 '+dev.name,due:dev.due,done:false,kind:'development',target:{view:'development/detail',id:dev.id}});
      event(state,context,'development',id,'创建开发案 '+code,{view:'development/detail',id}); result={id,devId:id,versionId:dev.currentVersionId||undefined}; break;
    }
    case 'development.update': {
      const dev=find(state.devs,p.devId,'开发案');
      if(p.patch?.domain!==undefined&&p.patch.domain!==developmentDomain(dev.values))throw new MistCommandError('PRECONDITION','已有开发案不能改变业务域，请另建案');
      const v=values({...dev.values,domain:developmentDomain(dev.values),...p.patch},true);
      const customer=state.customers.find(c=>c.id===v.customer)||(state.customers.filter(c=>c.name===v.customer).length===1?state.customers.find(c=>c.name===v.customer):undefined);
      if(!customer)throw new MistCommandError('VALIDATION','请选择已有客户');
      if(developmentDomain(v)!==developmentDomain(dev.values))throw new MistCommandError('PRECONDITION','已有开发案不能改变业务域，请另建案');
      dev.values=v; dev.name=v.name;dev.style=v.style;dev.customer=customer.name;dev.customerId=customer.id;dev.goal=v.goal;dev.fabric=v.fabric;dev.due=v.due;
      if(!dev.versionIds.length)addVersions(state,dev,context);
      updateDev(state,dev,context);event(state,context,'development',dev.id,'更新开发计划');result={devId:dev.id,versionId:dev.currentVersionId||undefined};break;
    }
    case 'development.saveConfirmationDraft': {
      const [dev,version]=versionOf(state,p.devId,p.versionId);
      if(version.archivedAt)throw new MistCommandError('PRECONDITION','本版已留档，请通过新版本继续记录');
      version.confirmationDraft={...p.draft};dev.updatedAt=context.now;result={devId:dev.id,versionId:version.id};break;
    }
    case 'development.confirm': {
      const [dev,version]=versionOf(state,p.devId,p.versionId);
      if(version.archivedAt)throw new MistCommandError('PRECONDITION','本版已留档，请通过新版本继续记录');
      if(!version.returnedAt)throw new MistCommandError('PRECONDITION','请先记录本版实际返样');
      if(!['approved','needs_adjustment','rejected'].includes(p.result))throw new MistCommandError('VALIDATION','确认结论无效');
      version.confirmations.push({id:context.id(),result:p.result,confirmer:text(p.confirmer,'实际确认人',true,120),organization:text(p.organization,'所属组织',false,240),confirmedAt:instant(p.confirmedAt,context),basis:text(p.basis,'确认依据'),originalText:text(p.originalText,'需求方原文',false),recordedAt:context.now,recordedBy:context.actorName});
      delete version.confirmationDraft;updateDev(state,dev,context);
      event(state,context,'development',dev.id,'记录 '+version.label+' 需求方确认',{view:'development/detail',id:dev.id,versionId:version.id});result={devId:dev.id,versionId:version.id};break;
    }
    case 'development.recordSample': {
      const [dev,v]=versionOf(state,p.devId,p.versionId);
      if(v.archivedAt||v.qc||v.confirmations.length)throw new MistCommandError('PRECONDITION','已有QC、确认或留档记录的实物不可替换，请创建新版本');
      if(state.fulfillment.samples.some(s=>s.source.kind==='version'&&s.source.versionId===v.id))throw new MistCommandError('PRECONDITION','已有入库实物不能覆盖，请创建新版本或从样品仓库追加形态');
      if(developmentDomain(dev.values)==='fabric'){if(!validFabricSample(p.quantity,p.form||'',p.unit||''))throw new MistCommandError('VALIDATION','面料返样须明确形态、数量和单位：米样按米，剪片类按整数份');v.sampleForm=text(p.form,'实际形态');v.sampleUnit=text(p.unit,'实际单位');v.sampleLocation=text(p.location||'','实际位置',false);v.sampleColor=text(p.color||dev.values.color,'实际颜色',false);v.size='';}
      else if(!Number.isInteger(p.quantity))throw new MistCommandError('VALIDATION','成衣返样须为正整数件数');
      v.sample=text(p.sample,'样品编号',true,120);v.sampleQuantity=positive(p.quantity,'返样数量');v.returnedAt=instant(p.returnedAt,context);
      updateDev(state,dev,context);applyFulfillmentCommand(state,{type:'fulfillment.samples.sync',payload:{}},context);event(state,context,'development',dev.id,'记录 '+v.label+' 返样');result={devId:dev.id,versionId:v.id};break;
    }
    case 'development.recordQc': {
      const [dev,v]=versionOf(state,p.devId,p.versionId);
      if(v.archivedAt)throw new MistCommandError('PRECONDITION','本版已留档，请通过新版本继续记录');
      if(!v.returnedAt)throw new MistCommandError('PRECONDITION','请先记录实物返样');
      if((p.domain||'garment')!==developmentDomain(dev.values))throw new MistCommandError('VALIDATION','QC专业权限域与准确开发版本不一致');
      if(developmentDomain(dev.values)==='fabric'&&p.qc?.measurements?.length)throw new MistCommandError('VALIDATION','面料开发不套成衣尺寸公差，请填写面料实测');
      const fabricMeasurements=p.qc?.fabricMeasurements||[];if(!Array.isArray(fabricMeasurements)||fabricMeasurements.length>200)throw new MistCommandError('VALIDATION','面料实测最多支持200行');
      const fabricFacts=fabricMeasurements.map((row:any)=>{if(!row||typeof row.actual!=='number'||!Number.isFinite(row.actual)||row.actual<0)throw new MistCommandError('VALIDATION','面料实测须为有限非负数');return{property:text(row.property,'实测项目',true,120),actual:row.actual,unit:text(row.unit,'实测单位',true,120)};});
      if(developmentDomain(dev.values)==='garment'&&fabricFacts.length)throw new MistCommandError('VALIDATION','成衣QC不接收面料实测');
      if(!['pass','conditional','reject'].includes(p.qc?.result))throw new MistCommandError('VALIDATION','QC结论无效');
      const measurements=p.qc.measurements===undefined?[]:p.qc.measurements;
      if(!Array.isArray(measurements)||measurements.length>200)throw new MistCommandError('VALIDATION','测量记录最多支持200行');
      const measured=(value:unknown,label:string)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new MistCommandError('VALIDATION',label+'须为有限非负数');return value;};
      const facts=measurements.map((row:unknown,index:number)=>{
        if(!row||typeof row!=='object')throw new MistCommandError('VALIDATION','测量记录格式无效');
        const item=row as Record<string,unknown>,label='测量点'+(index+1);
        return{point:text(item.point,label+'部位',true,120),standard:measured(item.standard,label+'标准'),actual:measured(item.actual,label+'实测'),tolerance:measured(item.tolerance,label+'公差')};
      });
      if(p.qc.appearanceDefects!==undefined&&(!Number.isSafeInteger(p.qc.appearanceDefects)||p.qc.appearanceDefects<0))throw new MistCommandError('VALIDATION','外观缺陷数量须为非负整数');
      v.qc={result:p.qc.result,reviewer:text(p.qc.reviewer,'评审人',true,120),reviewedAt:instant(p.qc.reviewedAt,context),report:text(p.qc.report,'报告编号',true,120),opinion:text(p.qc.opinion,'专业意见'),measurements:facts,...(developmentDomain(dev.values)==='fabric'?{fabricMeasurements:fabricFacts}:{}),...(p.qc.appearanceDefects===undefined?{}:{appearanceDefects:p.qc.appearanceDefects})};
      updateDev(state,dev,context);event(state,context,'development',dev.id,'记录 '+v.label+' QC评审',{view:'development/detail',id:dev.id,versionId:v.id},'qc');result={devId:dev.id,versionId:v.id};break;
    }
    case 'development.move': {
      const dev=find(state.devs,p.devId,'开发案'), v=state.versions.find(x=>x.id===dev.currentVersionId);
      if(!Number.isInteger(p.stage)||p.stage<0||p.stage>4)throw new MistCommandError('VALIDATION','阶段无效');
      if(p.stage>=1&&!v)throw new MistCommandError('PRECONDITION','请先指定工厂并建立样品版本');
      if(p.stage>=2&&!v?.returnedAt)throw new MistCommandError('PRECONDITION','请先记录实际返样');
      if(p.stage>=3&&!v?.qc)throw new MistCommandError('PRECONDITION','请先完成本版QC评审');
      if(p.stage===4&&v?.confirmations.at(-1)?.result!=='approved')throw new MistCommandError('PRECONDITION','本版尚未获得需求方认可');
      dev.stage=p.stage;dev.updatedAt=context.now;event(state,context,'development',dev.id,'进入 '+STAGES[p.stage]);result={devId:dev.id};break;
    }
    case 'development.revise': {
      const [dev,previous]=versionOf(state,p.devId,p.versionId), note=text(p.note,'改版说明');
      const round=Math.max(...state.versions.filter(v=>v.devId===dev.id).map(v=>Number(v.label.match(/^R(\d+)/)?.[1]||1)))+1;
      const id=context.id(), version:MistVersion={...previous,id,label:'R'+round+'-'+(previous.label.match(/^R\d+-([A-Z]+)-/)?.[1]||'A')+'-1',sample:'',fileIds:[...previous.fileIds],returnedAt:null,qc:null,confirmations:[],archivedAt:null,note};
      if(developmentDomain(dev.values)==='fabric')version.sampleQuantity=dev.values.sampleQuantity;delete version.confirmationDraft;delete version.sampleForm;delete version.sampleUnit;delete version.sampleLocation;delete version.sampleColor;state.versions.push(version);dev.versionIds.push(id);dev.currentVersionId=id;updateDev(state,dev,context);
      event(state,context,'development',dev.id,'创建改版 '+version.label,{view:'development/detail',id:dev.id,versionId:id});result={devId:dev.id,versionId:id};break;
    }
    case 'development.archive': {
      const [dev,v]=versionOf(state,p.devId,p.versionId);
      if(!v.qc||v.qc.result==='reject')throw new MistCommandError('PRECONDITION','准确版本QC通过或有保留通过后才能留档');
      if(!v.archivedAt){v.archivedAt=context.now;event(state,context,'development',dev.id,'留档 '+v.label);}
      updateDev(state,dev,context);result={devId:dev.id,versionId:v.id};break;
    }
    case 'fabric.create': {
      const id=context.id(), code='SR-F-'+context.now.slice(0,4)+'-'+String(state.fabrics.length+1).padStart(4,'0');
      state.fabrics.unshift({id,code,name:text(p.name,'面料'),request:text(p.request,'需求'),owner:text(p.owner,'负责人'),due:date(p.due),state:'寻样中',tone:'warn',sub:'等待候选答复',answer:'',confirmed:false,fileIds:[]});
      event(state,context,'fabric',id,'创建面料寻样 '+code);result={id};break;
    }
    case 'fabric.answer': {
      const f=find(state.fabrics,p.id,'寻样任务');f.answer=text(p.answer,'答复');f.fileIds=files(state,p.fileIds);f.state='待发起人确认';f.tone='accent';f.sub='已提交答复';
      event(state,context,'fabric',f.id,'提交寻样答复');result={id:f.id};break;
    }
    case 'fabric.confirm': {
      const f=find(state.fabrics,p.id,'寻样任务');if(!f.answer)throw new MistCommandError('PRECONDITION','尚无可确认答复');
      f.confirmed=!!p.approved;f.state=p.approved?'已结案':'待补充';f.tone=p.approved?'ok':'warn';f.sub=text(p.note,'确认意见',!p.approved);
      event(state,context,'fabric',f.id,p.approved?'确认寻样答复':'退回补充寻样');result={id:f.id};break;
    }
    case 'order.create': {
      const governance=createOrderGovernance(context,p.governance);
      const c=governance.contract.kind==='internal'?null:find(state.customers,p.customerId,'客户');if(c){const held=relationHoldReason(state,{customerId:c.id});if(held)throw new MistCommandError('PRECONDITION',held);}if(!['garment','fabric'].includes(p.type)||!Array.isArray(p.lines)||!p.lines.length||p.lines.length>200)throw new MistCommandError('VALIDATION','订单类型或条目无效');
      const id=context.id(),code='SO-'+(p.type==='fabric'?'F':'G')+'-'+context.now.slice(0,4)+'-'+String(state.orders.length+1).padStart(4,'0'),currency=text(p.currency,'币种',true,3).toUpperCase();
      if(!/^[A-Z]{3}$/.test(currency))throw new MistCommandError('VALIDATION','币种格式无效');
      const order:MistOrder={id,code,type:p.type,customerId:c?.id||'',customer:c?.name||governance.contract.receiver||'内部接收方待填写',governance,season:text(p.season,'季节'),lines:0,qty:0,amount:0,currency,due:date(p.due),progress:0,state:'订单草稿',tone:'neutral',owner:text(p.owner,'负责人'),img:p.lines[0].img||'coat',checklist:['拟发范围确认','收货与贸易条款确认','收款条件核对'].map((label,index)=>({id:id+'-check-'+index,label,done:false,note:''})),handoffAt:null,createdAt:context.now,updatedAt:context.now};
      state.orders.unshift(order);
      for(const row of p.lines){const qty=positive(row.qty,'数量'),price=positive(row.price,'单价',true);lineAmount(qty,price);state.orderLines.push({id:context.id(),orderId:id,name:text(row.name,'品名'),style:text(row.style,'款号'),img:['coat','blazer','suit','clay'].includes(row.img)?row.img:'coat',qty,unit:text(row.unit,'单位',true,20),price,made:0,qc:0});}
      event(state,context,'order',id,'创建订单 '+code,{view:'orders/detail',id});result={id,orderId:id};break;
    }
    case 'order.update': {
      const o=find(state.orders,p.orderId,'订单');
      if(o.governance?.status==='pending'||o.governance?.changeDraft?.status==='pending')throw new MistCommandError('PRECONDITION','审批中的订单内容已锁定');
      if((p.due!==undefined&&p.due!==o.due||p.season!==undefined&&p.season!==o.season)&&(!o.governance||o.governance.status==='approved'))throw new MistCommandError('PRECONDITION','正式商业条款变更须保存变更草稿并重新审批');
      if(p.due!==undefined)o.due=date(p.due);if(p.season!==undefined)o.season=text(p.season,'季节');if(p.owner!==undefined)o.owner=text(p.owner,'负责人');o.updatedAt=context.now;event(state,context,'order',o.id,'更新订单');result={orderId:o.id};break;
    }
    case 'order.checklist': {
      const o=assertMistOrderApproved(state,p.orderId), item=find(o.checklist,p.itemId,'准备事项');item.done=!!p.done;item.actor=context.actorName;item.at=context.now;o.updatedAt=context.now;result={orderId:o.id};break;
    }
    case 'order.handoff': {
      const o=assertMistOrderApproved(state,p.orderId);const readiness=o.checklist.filter(i=>['拟发范围确认','收货与贸易条款确认','收款条件核对'].includes(i.label));if(readiness.length!==3||!readiness.every(i=>i.done))throw new MistCommandError('PRECONDITION','请先核对拟发范围、收货贸易条款和收款条件');
      if(!o.handoffAt){o.handoffAt=context.now;state.tasks.unshift({id:context.id(),title:'核对 '+o.code+' 出运交接',due:o.due,done:false,kind:'shipping',target:{view:'orders/detail',id:o.id}});event(state,context,'order',o.id,'交接后勤'+(p.note?'：'+text(p.note,'交接说明',false):''),{view:'orders/detail',id:o.id},'shipping');}
      result={orderId:o.id};break;
    }
    case 'production.move': {
      const job=find(state.productions,p.id,'生产单'),from=COLS.indexOf(job.col),to=COLS.indexOf(p.col);
      if(to<0||to>from+1)throw new MistCommandError('PRECONDITION','请按相邻工序推进');
      assertProductionTransition(state,job,p.col,job.pct);
      if(p.col==='done'&&job.pct<100)throw new MistCommandError('PRECONDITION','完成进度达到100%并完成尾期QC后才能待出运');
      job.col=p.col;
      event(state,context,'production',job.id,'更新工序为 '+p.col,{view:'production-board',id:job.id,productionId:job.id});result={id:job.id,orderId:job.orderId};break;
    }
    case 'production.update': {
      const job=find(state.productions,p.id,'生产单'),pct=positive(p.pct,'进度',true);if(pct>100)throw new MistCommandError('VALIDATION','进度不得超过100%');
      assertProductionTransition(state,job,job.col,pct);
      job.pct=pct;if(p.risk!==undefined)job.risk=text(p.risk,'风险说明',false);
      if(p.due!==undefined)job.due=date(p.due);if(p.startDate!==undefined&&p.startDate)job.startDate=date(p.startDate);
      if(job.startDate&&job.startDate>job.due)throw new MistCommandError('VALIDATION','开始日期不得晚于交期');
      event(state,context,'production',job.id,'更新生产进度 '+pct+'%');result={id:job.id,orderId:job.orderId};break;
    }
    case 'finance.importReceipts': {
      if(!Array.isArray(p.receipts)||!p.receipts.length||p.receipts.length>2000)throw new MistCommandError('VALIDATION','流水数量无效');
      let imported=0,skipped=0;
      for(const row of p.receipts){const amount=positive(row.amount,'到账金额');mistMoneyMinor(amount);const value={date:date(row.date),payer:text(row.payer,'付款方'),amount,currency:text(row.currency,'币种',true,3).toUpperCase(),ref:text(row.ref,'附言',false)};if(!/^[A-Z]{3}$/.test(value.currency))throw new MistCommandError('VALIDATION','币种无效');
        if(value.ref&&state.receipts.some(r=>r.date===value.date&&r.payer===value.payer&&r.amount===value.amount&&r.currency===value.currency&&r.ref===value.ref)){skipped++;continue;}
        const id=context.id();state.receipts.push({id,code:'BR-'+context.now.slice(0,10).replace(/-/g,'')+'-'+String(state.receipts.length+1).padStart(3,'0'),...value,remaining:amount,state:'unmatched'});imported++;}
      event(state,context,'finance','receipts','导入 '+imported+' 笔到账流水，跳过 '+skipped+' 笔已存在流水');result={imported,skipped};break;
    }
    case 'finance.reconcile':
    case 'finance.acceptSuggestions': {
      const pairs=command.type==='finance.reconcile'?[{receiptId:p.receiptId,invoiceId:p.invoiceId,amount:p.amount,payerBasis:p.payerBasis}]:strings(p.receiptIds,'到账流水').map(id=>({receiptId:id,invoiceId:state.receipts.find(r=>r.id===id)?.suggest,amount:undefined,payerBasis:undefined}));
      let applied=0;
      for(const pair of pairs){
        const r=find(state.receipts,pair.receiptId,'到账流水'),i=state.invoices.find(v=>v.id===pair.invoiceId||v.code===pair.invoiceId);
        if(command.type==='finance.acceptSuggestions'&&(!i||!isActiveMistInvoice(i)||(r.confidence||0)<80||r.remaining<=0||i.open<=0))continue;
        if(!i)throw new MistCommandError('VALIDATION','请选择发票');
        if(!isActiveMistInvoice(i))throw new MistCommandError('PRECONDITION','已作废发票不能核销');
        if(i.currency!==r.currency)throw new MistCommandError('VALIDATION','到账和发票币种不同');
        const samePayer=r.payer.trim().toLocaleLowerCase()===i.customer.trim().toLocaleLowerCase();
        if(command.type==='finance.acceptSuggestions'&&!samePayer)continue;
        const payerBasis=samePayer?(pair.payerBasis?text(pair.payerBasis,'付款方关系依据',true,2000):''):text(pair.payerBasis,'付款方关系依据',true,2000);
        const amount=pair.amount===undefined?major(Math.min(mistMoneyMinor(r.remaining),mistMoneyMinor(i.open))):positive(pair.amount,'核销金额');
        const cents=mistMoneyMinor(amount);if(cents<=0||cents>mistMoneyMinor(r.remaining)||cents>mistMoneyMinor(i.open))throw new MistCommandError('VALIDATION','核销金额超出可分配余额');
        state.allocations.push({id:context.id(),receiptId:r.id,invoiceId:i.id,amount,currency:r.currency,createdAt:context.now,actor:context.actorName,...(payerBasis?{payerBasis}:{})});applied++;recalculate(state);
        event(state,context,'invoice',i.id,'核销 '+r.code+' → '+i.code,{view:'payment-vouchers',id:i.id});
      }
      assertOrderFundingIntegrity(state);result={applied};break;
    }
    case 'finance.payment.save': {
      const amount=positive(p.amount,'付款金额');mistMoneyMinor(amount);const id=context.id();
      const currency=text(p.currency,'币种',true,3).toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw new MistCommandError('VALIDATION','币种无效');
      state.payments.push({id,code:'PAY-'+context.now.slice(0,4)+'-'+String(state.payments.length+1).padStart(4,'0'),date:date(p.date),payee:text(p.payee,'收款方'),amount,currency,ref:text(p.ref,'备注',false)});
      event(state,context,'payment',id,'登记付款凭证');result={id};break;
    }
    case 'customer.update': {
      const c=find(state.customers,p.id,'客户');
      for(const key of ['name','country','city','industry','owner','grade','currency','terms','incoterm','categories','since'] as const)if(p.patch[key]!==undefined)c[key]=text(p.patch[key],key,key==='name');
      if(p.patch.creditLimit!==undefined){mistMoneyMinor(p.patch.creditLimit);c.creditLimit=p.patch.creditLimit;}
      state.devs.filter(d=>d.customerId===c.id).forEach(d=>{d.customer=c.name;d.values.customer=c.name;});state.orders.filter(o=>o.customerId===c.id).forEach(o=>{o.customer=c.name;});
      event(state,context,'customer',c.id,'更新客户档案');result={id:c.id,customerId:c.id};break;
    }
    case 'contact.save': {
      find(state.customers,p.customerId,'客户');const id=p.id||context.id();if(p.id)find(state.contacts,id,'联系人');
      const email=text(p.email,'邮箱',false,254);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new MistCommandError('VALIDATION','邮箱格式无效');
      const row:MistContact={id,customerId:p.customerId,name:text(p.name,'姓名',true,120),role:text(p.role,'职务',false,240),email,phone:text(p.phone,'电话',false,80),tone:'accent'};
      state.contacts=state.contacts.filter(c=>c.id!==id);state.contacts.push(row);event(state,context,'customer',p.customerId,'保存联系人 '+row.name);result={id,contactId:id};break;
    }
    case 'contact.delete': {const c=find(state.contacts,p.id,'联系人');state.contacts=state.contacts.filter(x=>x.id!==c.id);event(state,context,'customer',c.customerId,'删除联系人 '+c.name);result={id:c.id};break;}
    case 'settings.update': {
      const patch=p;
      if(patch.companyProfile!==undefined){
        const input=patch.companyProfile;if(!input||typeof input!=='object'||Array.isArray(input))throw new MistCommandError('VALIDATION','公司资料格式无效');
        const fields=['legalName','englishName','address','englishAddress','phone','email','taxId','customsCode','bankName','bankAccount','swift','defaultCurrency'] as const;
        if(Object.keys(input).some(k=>!fields.includes(k as any)))throw new MistCommandError('VALIDATION','公司资料含未知字段');
        const value={} as MistCompanyProfile;for(const key of fields)value[key]=text(input[key]??'',key,false,500);
        if(value.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email))throw new MistCommandError('VALIDATION','公司邮箱格式无效');
        if(value.defaultCurrency&&!/^[A-Z]{3}$/.test(value.defaultCurrency))throw new MistCommandError('VALIDATION','币种须使用三位大写代码');
        state.settings.companyProfile=value;
      }
      if(patch.theme!==undefined&&!['light','dark','system'].includes(patch.theme))throw new MistCommandError('VALIDATION','主题无效');
      if(patch.density!==undefined&&!['compact','default','comfy'].includes(patch.density))throw new MistCommandError('VALIDATION','密度无效');
      for(const key of ['workspaceName','profileName','profileEmail','locale'] as const)if(patch[key]!==undefined)state.settings[key]=text(patch[key],key,false,240);
      if(patch.theme!==undefined)state.settings.theme=patch.theme;if(patch.density!==undefined)state.settings.density=patch.density;
      if(patch.reducedMotion!==undefined)state.settings.reducedMotion=!!patch.reducedMotion;
      if(patch.notifications)for(const key of ['qc','shipping','suggestions','digest'] as const)if(patch.notifications[key]!==undefined)state.settings.notifications[key]=!!patch.notifications[key];
      result={};break;
    }
    case 'notification.read': {find(state.notifications,p.id,'通知').readAt=context.now;result={id:p.id};break;}
    case 'notification.readAll': {
      const visible = context.visibleNotificationIds === undefined ? undefined : new Set(context.visibleNotificationIds);
      state.notifications.forEach(n => { if (!visible || visible.has(n.id)) n.readAt = context.now; });
      result={};break;
    }
    case 'task.complete': {find(state.tasks,p.id,'事项').done=!!p.done;result={id:p.id};break;}
    case 'calendar.save': {
      const id=p.id||context.id();if(p.id)find(state.calendar,id,'日程');
      if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.time))throw new MistCommandError('VALIDATION','时间无效');
      state.calendar=state.calendar.filter(e=>e.id!==id);state.calendar.push({id,title:text(p.title,'日程'),date:date(p.date),time:p.time,note:text(p.note,'说明',false),...(p.target?{target:p.target}:{})});result={id};break;
    }
    case 'files.add': {
      const f=p.file;
      text(f.id,'文件ID',true,120);text(f.name,'文件名',true,240);text(f.mimeType,'文件类型',true,160);
      if(!/^[A-Za-z0-9/_-]+$/.test(f.storageKey)||f.storageKey.includes('..')||!Number.isSafeInteger(f.size)||f.size<0||f.size>50*1024*1024)throw new MistCommandError('VALIDATION','文件信息无效');
      if(state.files.some(x=>x.id===f.id))throw new MistCommandError('CONFLICT','文件已存在',409);state.files.push({...f});result={id:f.id,fileId:f.id};break;
    }
    default: throw new MistCommandError('VALIDATION','未知操作');
  }
  recalculate(state);
  return {state,result};
}

/** Read-time additive defaults preserve existing records; the next command persists them. */
export function normalizeMistState(state:MistState,context:MistContext):void {
  const eventLabels:Record<string,string>={
    'market.supplier.save':'保存供应商档案','market.supplier.status':'更新供应商合作状态',
    'market.relation.save':'保存关系档案','market.contact.save':'保存联系人',
    'market.product.save':'保存数字档案','market.product.fromVersion':'从确认版本建立数字档案',
    'market.quotation.feedback.add':'追加报价客户反馈','market.quotation.costing.save':'保存报价条目专业核算','market.quotation.save':'保存报价草稿','market.quotation.submit':'提交报价审批',
    'market.quotation.decide':'记录报价审批决定','market.quotation.send':'记录报价交付',
    'market.quotation.respond':'记录客户报价答复','market.quotation.convert':'报价转为订单',
    'market.season.save':'保存季节规划','market.season.review':'记录季节回顾',
    'market.trend.save':'保存趋势资料','market.show.save':'保存展会资料',
    'market.campaign.save':'保存营销活动','market.lead.save':'保存线索',
    'market.lead.convert':'线索转为客户','market.lookbook.save':'保存画册资料',
    'market.attachment.set':'关联业务附件'
  };
  for(const event of state.events||[])if(eventLabels[event.text])event.text=eventLabels[event.text];
  const defaults={fulfillment:createFulfillmentState(context,state),market:createMarketState(context,state),platform:createPlatformState(context,state),email:createEmailState(context,state),crm:createCrmState(context,state),orderFunding:createOrderFundingState(context,state),payables:createPayablesState(context,state)};
  for(const name of ['fulfillment','market','platform','email','crm','orderFunding','payables'] as const){
    if(!state[name]) (state as any)[name]=defaults[name];
    else for(const [key,value] of Object.entries(defaults[name])) if((state[name] as any)[key]===undefined)(state[name] as any)[key]=structuredClone(value);
  }
  recalculate(state);
}
export function getMistReviewTasks(state:MistState):MistReviewTask[]{return [...getOrderGovernanceReviews(state),...getFulfillmentReviews(state),...getMarketReviews(state),...getPlatformReviews(state)];}
export { renderDemoFile } from './mistDemoFiles';

/** 线索一键转 CRM：选已有客户或按线索公司新建客户（含联系人），可同时建立商机；整个过程在同一次命令内完成，任一步失败都不落库。 */
function convertLeadToCrm(state:MistState,p:Extract<MarketCommand,{type:'market.lead.convertToCrm'}>['payload'],context:MistContext):MistCommandResult{
  const lead=state.market.leads.find(l=>l.id===p?.id);if(!lead)throw new MistCommandError('NOT_FOUND','线索不存在',404);
  if(lead.status==='Converted')throw new MistCommandError('PRECONDITION','线索已转化');if(lead.status==='Lost')throw new MistCommandError('PRECONDITION','已流失的线索请先恢复跟进');
  let customerId=p.customerId||'';
  if(customerId){if(!state.customers.some(c=>c.id===customerId))throw new MistCommandError('NOT_FOUND','客户不存在',404);}
  else{
    const same=state.customers.find(c=>c.name.trim().toLowerCase()===lead.company.trim().toLowerCase());if(same)throw new MistCommandError('CONFLICT',`已有同名客户 ${same.name}（${same.code}），请选择该客户`,409);
    const created=applyMarketCommand(state,{type:'market.customer.create',payload:{input:{name:lead.company,country:'',city:'',industry:'',owner:context.actorName,grade:'',currency:lead.currency||'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:context.now.slice(0,10)}}},context);customerId=String(created.customerId||created.id);
    applyMarketCommand(state,{type:'market.contact.save',payload:{kind:'customer',parentId:customerId,name:lead.name,role:'',email:lead.email,phone:lead.phone,primary:true}},context);
  }
  let opportunityId='';
  if(p.opportunity){const parent=lead.source==='show'?state.market.shows.find(x=>x.id===lead.parentId)?.name:state.market.campaigns.find(x=>x.id===lead.parentId)?.name;
    const r=applyCrmCommand(state,{type:'crm.opportunity.save',payload:{input:{customerId,title:p.opportunity.title,domain:p.opportunity.domain,amount:p.opportunity.amount,currency:p.opportunity.currency,expectedDate:p.opportunity.expectedDate,owner:context.actorName,note:`来源线索：${lead.name} · ${lead.company}（${parent||'来源活动'}）\n${lead.demand}`,devIds:[],quotationIds:[],orderIds:[]}}},context);opportunityId=String(r.id);}
  applyMarketCommand(state,{type:'market.lead.transition',payload:{id:lead.id,status:'Converted',customerId,actualValue:'0',note:opportunityId?'转为 CRM 客户并建立商机':'转为 CRM 客户'}},context);
  const row=state.market.leads.find(l=>l.id===lead.id)!;if(opportunityId)row.opportunityId=opportunityId;
  return {id:lead.id,customerId,opportunityId};
}
