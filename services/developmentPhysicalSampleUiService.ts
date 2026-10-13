import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';
import { dashboardReadIdentity } from './dashboardTaskService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
import { beginBusinessRequest, readBusinessRequest, clearAcknowledgedBusinessRequest } from './businessRequestRecovery';
import { developmentService } from './developmentService';
import { sampleRoomService, type SampleCardItemView } from './sampleRoomService';
import { developmentPhysicalSampleService, verifyDevelopmentPhysicalReceipt, type DevelopmentPhysicalReceipt, type IncomingDevelopmentSampleInput, type DevelopmentFactoryShipmentInput } from './developmentPhysicalSampleService';
import type { Warehouse } from '../types';

export type PhysicalKind = 'incoming' | 'factory';
export type PhysicalDraft = Omit<IncomingDevelopmentSampleInput,'requestKey'> | Omit<DevelopmentFactoryShipmentInput,'requestKey'>;
export type PhysicalDisplay = {physicalName?:string;itemCode?:string;factoryName?:string;versionLabel?:string;quantityUnit?:string};
export type PhysicalPending = { requestId:string; payload:{caseId:string;kind:PhysicalKind;actorId:string;authorityFingerprint:string;authorityEpoch:string;body:PhysicalDraft;display?:PhysicalDisplay} };
export type FactorySampleChoice = { id:string;updatedAt:string;round:number;versionLabel:string;factoryId:string;factoryName:string;requirements:string|null;references:string[] };
const freeze = <T>(value:T):T => {
  const copy=JSON.parse(JSON.stringify(value));
  const visit=(v:any)=>{if(v&&typeof v==='object'){Object.values(v).forEach(visit);Object.freeze(v);}};visit(copy);return copy;
};
const present=(v:unknown):v is string=>typeof v==='string'&&!!v.trim();
const fingerprint=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join('');
const blobSha=async(blob:Blob)=>{const bytes=typeof blob.arrayBuffer==='function'?await blob.arrayBuffer():await new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('无法读取照片原始字节'));reader.onload=()=>reader.result instanceof ArrayBuffer?resolve(reader.result):reject(new Error('照片原始字节未确认'));reader.readAsArrayBuffer(blob);});return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');};
const events=['storage','focus',EMAIL_CONTEXT_EVENT];
// This observer outlives individual dialogs. A fresh module load rotates the epoch:
// earlier authority changes cannot be disproved after a reload, so old intents remain GET-only.
const epochKey='bambook:development-physical:authority-epoch:v1';
let authorityIdentity:string|undefined,epochStorageFailed=false;
function rotateEpoch(){try{const value=crypto.randomUUID();localStorage.setItem(epochKey,value);if(localStorage.getItem(epochKey)!==value)throw Error();epochStorageFailed=false;}catch{epochStorageFailed=true;}}
function observeAuthority(){try{const next=dashboardReadIdentity();if(next!==authorityIdentity){authorityIdentity=next;rotateEpoch();}}catch{authorityIdentity=undefined;epochStorageFailed=true;}}
if(typeof window!=='undefined'){observeAuthority();subscribe(observeAuthority);events.forEach(event=>window.addEventListener(event,observeAuthority));}
function authorityEpoch(){observeAuthority();if(epochStorageFailed||!localStorage.getItem(epochKey))rotateEpoch();const epoch=localStorage.getItem(epochKey);if(epochStorageFailed||!epoch)throw new Error('无法保存身份变化，请恢复浏览器存储后核对原请求');return epoch;}
async function exclusive<T>(key:string,run:()=>Promise<T>):Promise<T>{
  if(!navigator.locks?.request)throw new Error('当前浏览器无法保护原请求，请使用支持跨窗口锁的浏览器');
  return navigator.locks.request(`bambook:development-physical:${key}`,run);
}

/** A dialog session owns only local unresolved intents; every stock and permission fact is read from native services. */
export function createDevelopmentPhysicalUiSession({caseId,caseType,canWrite,canOperate=canWrite,endpoint,onInvalidated}:{caseId:string;caseType:'fabric'|'garment';canWrite:boolean;canOperate?:boolean;endpoint?:string;onInvalidated?:()=>void}) {
  const identity=dashboardReadIdentity(),actorId=getAuthState().user?.id,base=endpoint||apiService.getStoredConfig().cloudEndpoint;
  const effectiveBase=apiService.buildApiUrl('/v1',base);
  let invalidated=false,disposed=false;
  const sessionEpoch=authorityEpoch(),lockPrefix=`${encodeURIComponent(effectiveBase)}:${actorId}:${caseId}`;
  const pendingIds=new Set<string>();
  const fenceKey=(id:string)=>`bambook:development-physical:invalidated:${encodeURIComponent(actorId||'')}:${encodeURIComponent(effectiveBase)}:${id}`;
  const mark=()=>{for(const id of pendingIds){try{localStorage.setItem(fenceKey(id),'1');}catch{/* In-memory invalidation remains unconditional. */}}};
  const observe=()=>{if(disposed||invalidated)return;try{if(dashboardReadIdentity()!==identity||authorityEpoch()!==sessionEpoch){invalidated=true;mark();onInvalidated?.();}}catch{invalidated=true;mark();onInvalidated?.();}};
  const stop=subscribe(observe);if(typeof window!=='undefined')events.forEach(e=>window.addEventListener(e,observe));
  const current=()=>{observe();return !disposed&&!invalidated;};
  const check=(write=false,operational=false)=>{if(operational&&!canOperate)throw new Error('当前开发案暂停或已结束，不能登记新实物或重提原请求');if(!current()||!actorId||!getAuthState().isAuthenticated||getAuthState().isLoading||!hasPermission('products:read')||write&&(!canWrite||!hasPermission('products:write')||!hasPermission('sample:room:write')))throw new Error('账号、权限或开发案已变化，请保留原请求并重新打开核对');};
  const operation=(kind:PhysicalKind)=>`development-physical:${caseId}:${kind}`;
  const pending=async(kind:PhysicalKind):Promise<PhysicalPending|null>=>{
    check();const record=readBusinessRequest<PhysicalPending['payload']>(operation(kind),base);if(!record)return null;
    const p=record.payload;if(p.caseId!==caseId||p.kind!==kind||p.actorId!==actorId||!p.body||Object.prototype.hasOwnProperty.call(p.body,'requestKey')||!/^[a-f0-9]{64}$/.test(p.authorityFingerprint)||!present(p.authorityEpoch))throw new Error('原实物请求来源未确认，请核对原记录');
    pendingIds.add(record.requestId);return freeze(record);
  };
  const acknowledged=async(kind:PhysicalKind,record:PhysicalPending,receipt:DevelopmentPhysicalReceipt)=>{
    check();const input={...record.payload.body,requestKey:record.requestId} as IncomingDevelopmentSampleInput|DevelopmentFactoryShipmentInput;
    verifyDevelopmentPhysicalReceipt(caseId,kind,actorId!,input,receipt);check();const stored=await pending(kind);if(stored?.requestId!==record.requestId||JSON.stringify(stored.payload)!==JSON.stringify(record.payload))throw new Error('原请求恢复记录已变化，请核对原记录');
    clearAcknowledgedBusinessRequest(operation(kind),record.requestId,base);pendingIds.delete(record.requestId);try{localStorage.removeItem(fenceKey(record.requestId));}catch{}
    return receipt;
  };
  const terminal=async(kind:PhysicalKind,record:PhysicalPending,result:Awaited<ReturnType<typeof developmentPhysicalSampleService.resolveCommand>>)=>{check();if(result.status==='succeeded')return {status:'succeeded' as const,receipt:await acknowledged(kind,record,result.receipt)};const stored=await pending(kind);if(stored?.requestId!==record.requestId||JSON.stringify(stored.payload)!==JSON.stringify(record.payload))throw new Error('原恢复记录已变化，请核对原记录');clearAcknowledgedBusinessRequest(operation(kind),record.requestId,base);pendingIds.delete(record.requestId);return result;};
  const post=async(kind:PhysicalKind,record:PhysicalPending)=>{
    check(true,true);const digest=await fingerprint(identity);check(true,true);
    if(digest!==record.payload.authorityFingerprint||record.payload.authorityEpoch!==authorityEpoch()||localStorage.getItem(fenceKey(record.requestId)))throw new Error('原请求期间账号或权限曾变化，请只核对原回执');
    const stored=await pending(kind);if(!stored||stored.requestId!==record.requestId)throw new Error('原请求记录已变化，请核对原请求');
    const input=freeze({...record.payload.body,requestKey:record.requestId});
    const receipt=kind==='incoming'?await developmentPhysicalSampleService.registerIncoming(caseId,input as IncomingDevelopmentSampleInput,base):await developmentPhysicalSampleService.shipToFactory(caseId,input as DevelopmentFactoryShipmentInput,base);
    return acknowledged(kind,record,receipt);
  };
  const exactItem=async(itemId:string)=>{check();const data=await sampleRoomService.getItem(itemId,base);check();if(data.item?.id!==itemId||data.item.devCaseId!==caseId)throw new Error('实物照片来源不属于当前开发案');return data.item;};
  const validatePhoto=(itemId:string,photo:NonNullable<SampleCardItemView['photos']>[number])=>{
    const root=new URL(apiService.buildApiUrl(`/v1/samples/room/items/${encodeURIComponent(itemId)}/photos/${encodeURIComponent(photo.id)}`,base));
    const url=new URL(photo.url,root);if(url.searchParams.get('sig')!==photo.signature||!present(photo.id)||url.origin!==root.origin||url.pathname!==root.pathname||!['image/jpeg','image/png','image/webp'].includes(photo.mimeType)||!Number.isSafeInteger(photo.size)||photo.size<=0||!present(photo.signature))throw new Error('实物照片范围或签名未确认');
  };
  const photosKey=(id:string)=>`bambook:development-physical:photo:${encodeURIComponent(effectiveBase)}:${encodeURIComponent(actorId||'')}:${encodeURIComponent(caseId)}:${encodeURIComponent(id)}`;
  const readPhotos=async(itemId:string)=>{const item=await exactItem(itemId);const photos=item.photos??[];if(!Array.isArray(photos)||new Set(photos.map(p=>p.id)).size!==photos.length)throw new Error('实物照片记录未确认');photos.forEach(p=>validatePhoto(itemId,p));return {item,photos};};
  const confirmPhotoBytes=async(itemId:string,photos:NonNullable<SampleCardItemView['photos']>,marker:string)=>{const before=JSON.parse(marker);if(before.itemId!==itemId||!Array.isArray(before.ids)||!/^([a-f0-9]{64})$/.test(before.sha256))throw new Error('原照片字节依据未确认');const added=photos.filter(p=>!before.ids.includes(p.id));let matched=false;for(const photo of added){check();validatePhoto(itemId,photo);const blob=await sampleRoomService.loadPrivatePhoto(photo.url,base);check();if(blob.size!==photo.size||blob.type!==photo.mimeType)throw new Error('实物照片内容与记录不一致');const hash=await blobSha(blob);check();if(hash===before.sha256)matched=true;}if(!matched)throw new Error('尚未读取到与原文件字节相同的照片，请稍后核对；来样实物已登记');check();if(localStorage.getItem(photosKey(itemId))!==marker)throw new Error('原照片请求已变化');localStorage.removeItem(photosKey(itemId));};
  return {
    current,check,pending,
    dispose(){disposed=true;stop();if(typeof window!=='undefined')events.forEach(e=>window.removeEventListener(e,observe));},
    async submit(kind:PhysicalKind,body:PhysicalDraft,display?:PhysicalDisplay){const accepted=freeze(body),description=display?freeze(display):undefined;return exclusive(`${lockPrefix}:${kind}`,async()=>{check(true,true);if(await pending(kind))throw new Error('原请求结果尚未确认，请先核对原请求');
      const authorityFingerprint=await fingerprint(identity);check(true,true);
      const record=beginBusinessRequest(operation(kind),{caseId,kind,actorId:actorId!,authorityFingerprint,authorityEpoch:sessionEpoch,body:accepted,...(description?{display:description}:{})},base);pendingIds.add(record.requestId);check(true);return post(kind,freeze(record));});},
    async recover(kind:PhysicalKind){return exclusive(`${lockPrefix}:${kind}`,async()=>{const record=await pending(kind);if(!record)throw new Error('没有待核对的原请求');const input=freeze({...record.payload.body,requestKey:record.requestId}) as IncomingDevelopmentSampleInput|DevelopmentFactoryShipmentInput;check();const result=await developmentPhysicalSampleService.readResolution(caseId,kind,input,base);return terminal(kind,record,result);});},
    async retry(kind:PhysicalKind){return exclusive(`${lockPrefix}:${kind}`,async()=>{const record=await pending(kind);if(!record)throw new Error('没有待重提的原请求');return post(kind,record);});},
    async resolve(kind:PhysicalKind){return exclusive(`${lockPrefix}:${kind}`,async()=>{const record=await pending(kind);if(!record)throw new Error('没有待核对的原请求');const input=freeze({...record.payload.body,requestKey:record.requestId}) as IncomingDevelopmentSampleInput|DevelopmentFactoryShipmentInput;check(true);const result=await developmentPhysicalSampleService.resolveCommand(caseId,kind,input,base);return terminal(kind,record,result);});},
    async history(offset=0){check();const result=await developmentPhysicalSampleService.listHistory(caseId,{limit:10,offset},base);check();return result;},
    async items(offset=0,signal?:AbortSignal){check();const page=await sampleRoomService.listItems({devCaseId:caseId,scope:caseType,limit:10,offset},base,{current,signal});check();if(page.items.some(i=>i.devCaseId!==caseId)||page.pagination?.limit!==10||page.pagination.offset!==offset)throw new Error('实物名单来源或分页不一致');return page;},
    async versions(){check();const batches=await developmentService.listSampleBatches(caseId,base);check();const result=new Map<string,FactorySampleChoice>();for(const batch of batches){if(batch.developmentCaseId!==caseId)throw new Error('工厂任务不属于当前开发案');const task=batch.trialTask;if(!task)continue;if(!present(task.id)||!/^\d+$/.test(task.updatedAt)||!present(batch.supplierRelationId)||!present(batch.supplierName)||!present(batch.versionLabel))throw new Error('准确工厂版本、工厂或任务戳尚未完整');const choice={id:task.id,updatedAt:task.updatedAt,round:batch.round,versionLabel:batch.versionLabel,factoryId:batch.supplierRelationId,factoryName:batch.supplierName,requirements:task.factoryRequirements,references:task.referenceAttachments};if(result.has(task.id)&&JSON.stringify(result.get(task.id))!==JSON.stringify(choice))throw new Error('同一工厂任务出现不同版本依据');result.set(task.id,choice);}return [...result.values()];},
    async warehouses():Promise<Warehouse[]>{check();const rows=await apiService.listWarehouses(false,base);check();if(rows.some(w=>!present(w.id)||!present(w.name)))throw new Error('仓库名单未确认');return rows.filter(w=>w.isActive&&!w.deletedAt);},
    readPhotos,
    async loadPhoto(itemId:string,photo:NonNullable<SampleCardItemView['photos']>[number],signal?:AbortSignal){check();validatePhoto(itemId,photo);const blob=await sampleRoomService.loadPrivatePhoto(photo.url,base,signal);check();if(!blob.size||blob.type!==photo.mimeType||blob.size!==photo.size)throw new Error('实物照片内容与记录不一致');return blob;},
    photoUnresolved(itemId:string){check();return localStorage.getItem(photosKey(itemId))!==null;},
    async reconcilePhotos(itemId:string){return exclusive(`${lockPrefix}:photo:${itemId}`,async()=>{const data=await readPhotos(itemId);const raw=localStorage.getItem(photosKey(itemId));if(raw){await confirmPhotoBytes(itemId,data.photos,raw);}check();return data;});},
    async uploadPhoto(receipt:DevelopmentPhysicalReceipt,file:File){return exclusive(`${lockPrefix}:photo:${receipt.itemId}`,async()=>{check(true);const itemId=receipt.photoUploadItemId;if(receipt.caseId!==caseId||receipt.command.kind!=='incoming'||receipt.command.actorId!==actorId||itemId!==receipt.itemId)throw new Error('照片必须关联已确认的同一来样实物');
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||!file.size)throw new Error('请选择 JPEG、PNG 或 WebP 实物照片');
      if(localStorage.getItem(photosKey(itemId)))throw new Error('上次照片结果尚未确认，请先核对照片');const before=await readPhotos(itemId);check(true);
      const sha256=await blobSha(file);check(true);const marker=JSON.stringify({itemId,ids:before.photos.map(p=>p.id),sha256});localStorage.setItem(photosKey(itemId),marker);if(localStorage.getItem(photosKey(itemId))!==marker)throw new Error('无法保存照片请求，请恢复存储后重试');check(true);
      const result=await sampleRoomService.uploadPhoto(itemId,file,base);check(true);
      if(result.item?.id!==itemId||result.item.devCaseId!==caseId||!Array.isArray(result.item.photos))throw new Error('照片回执实物范围不一致，请核对照片');
      result.item.photos.forEach(p=>validatePhoto(itemId,p));await confirmPhotoBytes(itemId,result.item.photos,marker);return {item:result.item,photos:result.item.photos};});
    },
  };
}
export type DevelopmentPhysicalUiSession = ReturnType<typeof createDevelopmentPhysicalUiSession>;
