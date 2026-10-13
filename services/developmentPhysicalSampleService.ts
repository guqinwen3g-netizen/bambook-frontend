import { apiService } from './apiService';
import { getAuthState, subscribe, hasPermission } from './authService';
import { dashboardReadIdentity } from './dashboardTaskService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
export type IncomingDevelopmentSampleInput = {
  requestKey:string;name:string;cardType:string;quantity:number;unit:string;physicalLengthQty?:string;
  receivedDate:string;form:string;sourceType:'internal'|'customer_sample'|'supplier_recommend'|'purchased'|'other';sourceName:string;
  warehouseId?:string;location?:string;notes?:string;
};
export type DevelopmentFactoryShipmentInput = {
  requestKey:string;sampleVersionId:string;expectedVersionUpdatedAt:string;itemId:string;quantity:string;unit:string;sentDate:string;
  recipientName:string;recipientAddress:string;recipientContact?:string;courier:string;trackingNumber:string;
  shippingFee:string;shippingCurrency:string;notes?:string;
};
export type DevelopmentPhysicalReceipt = {
  inputSnapshot?:Record<string,unknown>;
  itemId:string;itemCode:string;caseId:string;auditId:string;replayed:boolean;
  command:{kind:'incoming'|'factory';actorId:string;requestKey:string;fingerprint:string};
  incoming?:{receivedDate:string;form:string;sourceType:string;sourceName:string};
  physical?:{name:string;cardType:string;quantity:number;unit:string;physicalLengthQty:string|null};photoUploadItemId?:string;
  task?:{sampleVersionId:string;versionLabel:string;factoryId:string;factoryName:string;roundId:string;factoryRequirements:string|null;referenceAttachments:string[];updatedAt:string};
  shipping?:Omit<DevelopmentFactoryShipmentInput,'requestKey'|'expectedVersionUpdatedAt'|'sampleVersionId'|'itemId'>;
  shippingCost?:{status:'registered'|'free';amount:string;currency:string;incurredAt:string;sourceFingerprint:string;costRecordId?:string;recordNo?:string};
  stockBefore?:{quantity:number|string;available:number|string};
  stock?:{itemId:string;loanId:string;quantity:number|string;unit?:string;quantityAfter:number|string;availableAfter:number|string;archived:boolean;eventId:string};
};
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
const normalized=(v:any)=>Object.fromEntries(Object.entries(v).map(([k,x])=>[k,typeof x==='string'?(x.trim()||undefined):x]));
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value));
const text = (v:unknown):v is string => typeof v==='string' && !!v.trim();
const decimal = (v:unknown):string|null => { const raw=String(v??'').trim(); if(!/^\d+(?:\.\d{1,4})?$/.test(raw))return null; const [w,f='']=raw.split('.'); return `${w.replace(/^0+(?=\d)/,'')}.${f.padEnd(4,'0')}`; };
function proof(item:any,caseId:string):boolean { return !!item && item.caseId===caseId && text(item.itemId)&&text(item.itemCode)&&text(item.auditId)&&typeof item.replayed==='boolean'&&text(item.command?.actorId)&&text(item.command?.requestKey)&&['incoming','factory'].includes(item.command.kind)&&/^[a-f0-9]{64}$/.test(item.command.fingerprint); }
async function verifyShippingCostSource(item:DevelopmentPhysicalReceipt,caseId:string,check:()=>void){
 if(item.command.kind!=='factory'||item.shippingCost===undefined)return;
 const snapshot={caseId,actorId:item.command.actorId,requestKey:item.command.requestKey,commandFingerprint:item.command.fingerprint,itemId:item.itemId,itemCode:item.itemCode,task:item.task,physical:item.physical,stock:item.stock,shipping:item.shipping};
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(snapshot)))))).map(v=>v.toString(16).padStart(2,'0')).join('');check();
 if(item.shippingCost?.sourceFingerprint!==digest)throw new Error('寄厂费用来源与原实物和物流不一致，请保留原请求编号核对');
}
async function guarded<T>(write:boolean,run:(check:()=>void,actorId:string,base:string)=>Promise<T>,endpoint?:string):Promise<T>{
 const auth=getAuthState();if(!auth.isAuthenticated||auth.isLoading||!auth.user?.id||!hasPermission(write?'products:write':'products:read')||write&&!hasPermission('sample:room:write'))throw new Error('当前账号没有开发实物权限');
 const actorId=auth.user.id,identity=dashboardReadIdentity(),base=endpoint||apiService.getStoredConfig().cloudEndpoint;
 let invalidated=false;const observe=()=>{try{if(dashboardReadIdentity()!==identity)invalidated=true;}catch{invalidated=true;}};
 const stop=subscribe(observe),events=['storage','focus',EMAIL_CONTEXT_EVENT];
 const check=()=>{observe();if(invalidated)throw new Error('账号、权限或后台已变化，请保留原请求编号核对原回执');};
 if(typeof window!=='undefined')events.forEach(e=>window.addEventListener(e,observe));
 try{check();return await run(check,actorId,base);}finally{stop();if(typeof window!=='undefined')events.forEach(e=>window.removeEventListener(e,observe));}
}
async function request(caseId:string,path:string,input?:{requestKey:string},endpoint?:string):Promise<DevelopmentPhysicalReceipt>{
 const frozen=input===undefined?undefined:clone(input),body=frozen===undefined?undefined:JSON.stringify(frozen);
 return guarded(frozen!==undefined,async(check,actorId,base)=>{
 const response=await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/${path}`,base),{method:frozen===undefined?'GET':'POST',headers:{...apiService.getAuthHeaders(),'Content-Type':'application/json'},...(body===undefined?{}:{body})});check();
 const data=await response.json().catch(()=>null);check();
 if(!response.ok)throw new Error(data?.error?.message||'开发实物请求未确认，请保留原请求编号核对');
 const item=data?.item,kind=path==='incoming-samples'?'incoming':path==='factory-sample-shipments'?'factory':path.split('/')[1],key=frozen?.requestKey.trim()??decodeURIComponent(path.split('/')[2]||'');
 if(frozen && JSON.stringify(canonical(item?.inputSnapshot))!==JSON.stringify(canonical(normalized(frozen))))throw new Error('实物回执缺少原命令完整依据，请保留原请求编号核对');
 if(!proof(item,caseId)||item.command.actorId!==actorId||item.command.kind!==kind||item.command.requestKey!==key)throw new Error('开发实物回执与原来源不一致，请核对原请求');
 await verifyShippingCostSource(item,caseId,check);
 return item;
 },endpoint);
}
/** Validate an exact POST or recovered GET against the same frozen command. */
export function verifyDevelopmentPhysicalReceipt(caseId:string,kind:'incoming'|'factory',actorId:string,input:IncomingDevelopmentSampleInput|DevelopmentFactoryShipmentInput,item:DevelopmentPhysicalReceipt):DevelopmentPhysicalReceipt {
  if(!proof(item,caseId)||item.command.actorId!==actorId||item.command.kind!==kind||item.command.requestKey!==input.requestKey.trim()||JSON.stringify(canonical(item.inputSnapshot))!==JSON.stringify(canonical(normalized(input))))throw new Error('实物回执与原命令不一致，请保留原请求编号核对');
  if(kind==='incoming') { const original=input as IncomingDevelopmentSampleInput;
    if(!item.incoming||['receivedDate','form','sourceType','sourceName'].some(key=>String((item.incoming as any)[key])!==String((original as any)[key]).trim())||item.photoUploadItemId!==item.itemId||item.physical?.name!==original.name.trim()||item.physical.cardType!==original.cardType.trim()||item.physical.quantity!==original.quantity||item.physical.unit!==original.unit.trim()||(original.physicalLengthQty ? decimal(item.physical.physicalLengthQty)!==decimal(original.physicalLengthQty):item.physical.physicalLengthQty!==null))throw new Error('来样回执未对应原实际来样内容，请核对原请求');
  } else { const original=input as DevelopmentFactoryShipmentInput;
    if(item.itemId!==original.itemId||item.task?.sampleVersionId!==original.sampleVersionId||item.stock?.itemId!==original.itemId||!item.shipping||['quantity','unit','sentDate','recipientName','recipientAddress','courier','trackingNumber','shippingFee','shippingCurrency'].some(key=>String((item.shipping as any)[key])!==String((original as any)[key]).trim()))throw new Error('寄厂回执未对应原实物或工厂任务，请核对原请求');
    const stock=item.stock!;
    const exact=(v:unknown)=>{const d=decimal(v);return d===null?null:BigInt(d.replace('.',''));};
    const before=exact(item.stockBefore?.quantity),available=exact(item.stockBefore?.available),sent=exact(original.quantity),after=exact(stock.quantityAfter),remaining=exact(stock.availableAfter);
    if(before===null||available===null||sent===null||after===null||remaining===null||before-sent!==after||available-sent!==remaining||(item.physical?.physicalLengthQty!=null?stock.unit!=='米':stock.unit!==undefined||!Number.isSafeInteger(stock.quantity)||!Number.isSafeInteger(stock.quantityAfter)||!Number.isSafeInteger(stock.availableAfter)))throw new Error('寄厂原库存与扣库回执不一致，请保留原请求编号核对');
    if(item.task?.updatedAt!==original.expectedVersionUpdatedAt.trim()||!text(item.task.factoryId)||!text(item.task.factoryName)||!text(item.task.roundId)||!text(item.task.versionLabel)||!text(stock.loanId)||stock.eventId!==`development-factory:${caseId}:${item.command.actorId}:${original.requestKey.trim()}`||decimal(stock.quantity)!==decimal(original.quantity)||decimal(stock.quantityAfter)===null||decimal(stock.availableAfter)===null||Number(stock.availableAfter)>Number(stock.quantityAfter)||typeof stock.archived!=='boolean'||stock.archived&&Number(stock.quantityAfter)!==0||item.physical?.unit!==original.unit.trim()||['recipientContact','notes'].some(key=>((item.shipping as any)[key]??'')!==((original as any)[key]?.trim()??'')))throw new Error('寄厂库存回执或原任务戳不一致，请保留原请求编号核对');
    // Older immutable receipts have no cost linkage. A present linkage must prove the original fee.
    if(item.shippingCost!==undefined){const cost=item.shippingCost,fee=exact(original.shippingFee);
      if(!cost||fee===null||decimal(cost.amount)!==decimal(original.shippingFee)||cost.currency!==original.shippingCurrency.trim()||cost.incurredAt!==original.sentDate.trim()||!/^[a-f0-9]{64}$/.test(cost.sourceFingerprint)||
        (fee===0n?cost.status!=='free'||cost.costRecordId!==undefined||cost.recordNo!==undefined:cost.status!=='registered'||!text(cost.costRecordId)||!text(cost.recordNo)))throw new Error('寄厂费用回执与原物流费用不一致，请保留原请求编号核对');
    }
  }
  return item;
}
export type DevelopmentPhysicalResolution = {status:'succeeded';receipt:DevelopmentPhysicalReceipt}|{status:'cancelled';caseId:string;kind:'incoming'|'factory';actorId:string;requestKey:string;inputFingerprint:string;auditId:string;replayed:boolean};
async function validateResolution(data:any,caseId:string,kind:'incoming'|'factory',actorId:string,frozen:IncomingDevelopmentSampleInput|DevelopmentFactoryShipmentInput,check:()=>void):Promise<DevelopmentPhysicalResolution>{
    const result=data?.item;
    if(result?.status==='succeeded'){verifyDevelopmentPhysicalReceipt(caseId,kind,actorId,frozen,result.receipt);await verifyShippingCostSource(result.receipt,caseId,check);return result;}
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(frozen)))))).map(v=>v.toString(16).padStart(2,'0')).join('');check();
    if(result?.status!=='cancelled'||result.caseId!==caseId||result.kind!==kind||result.actorId!==actorId||result.requestKey!==frozen.requestKey||result.inputFingerprint!==digest||!text(result.auditId)||typeof result.replayed!=='boolean')throw new Error('取消回执与原冻结命令不一致，请保留原请求编号核对');
    return result;
}
async function resolveCommand(caseId:string,kind:'incoming'|'factory',input:IncomingDevelopmentSampleInput|DevelopmentFactoryShipmentInput,endpoint?:string):Promise<DevelopmentPhysicalResolution>{
  const frozen=clone(input);
  return guarded(true,async(check,actorId,base)=>{
    const response=await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/physical-sample-commands/${kind}/${encodeURIComponent(frozen.requestKey)}/resolve`,base),{method:'POST',headers:{...apiService.getAuthHeaders(),'Content-Type':'application/json'},body:JSON.stringify({input:frozen})});check();
    const data=await response.json().catch(()=>null);check();if(!response.ok)throw new Error(data?.error?.message||'原实物请求终态尚未确认，请保留原请求编号');
    return validateResolution(data,caseId,kind,actorId,frozen,check);
  },endpoint);
}
async function readResolution(caseId:string,kind:'incoming'|'factory',input:IncomingDevelopmentSampleInput|DevelopmentFactoryShipmentInput,endpoint?:string):Promise<DevelopmentPhysicalResolution>{
  const frozen=clone(input);return guarded(false,async(check,actorId,base)=>{const response=await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/physical-sample-commands/${kind}/${encodeURIComponent(frozen.requestKey)}/resolution`,base),{headers:apiService.getAuthHeaders()});check();const data=await response.json().catch(()=>null);check();if(!response.ok)throw new Error(data?.error?.message||'原请求终态尚未确认，请保留原请求编号');return validateResolution(data,caseId,kind,actorId,frozen,check);},endpoint);
}
export const developmentPhysicalSampleService={
  resolveCommand,readResolution,
  listHistory:async(caseId:string,options:{kind?:'incoming'|'factory';limit?:number;offset?:number}={},endpoint?:string):Promise<{items:DevelopmentPhysicalReceipt[];total:number;limit:number;offset:number}>=>{
    const expected=clone(options),limit=expected.limit??30,offset=expected.offset??0;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||expected.kind&&!['incoming','factory'].includes(expected.kind))throw new Error('实物历史分页来源未确认');
    const query=new URLSearchParams();for(const [key,value] of Object.entries(expected))if(value!==undefined)query.set(key,String(value));
    return guarded(false,async(check,_actorId,base)=>{
      const response=await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/physical-sample-commands?${query}`,base),{headers:apiService.getAuthHeaders()});check();
      const data=await response.json().catch(()=>null);check();if(!response.ok)throw new Error(data?.error?.message||'开发实物历史未能读取');
      const page=data?.item;
      if(!page||!Array.isArray(page.items)||!Number.isSafeInteger(page.total)||page.total<0||page.limit!==limit||page.offset!==offset||page.items.length>Math.min(limit,Math.max(0,page.total-offset))||page.items.some((item:any)=>!proof(item,caseId)||expected.kind&&item.command.kind!==expected.kind)||new Set(page.items.map((i:any)=>i.auditId)).size!==page.items.length)throw new Error('实物历史来源或分页未确认');
      await Promise.all(page.items.map((item:DevelopmentPhysicalReceipt)=>verifyShippingCostSource(item,caseId,check)));check();
      return page;
    },endpoint);
  },
  registerIncoming:async(caseId:string,input:IncomingDevelopmentSampleInput,endpoint?:string)=>{
    input=clone(input);
    const item=await request(caseId,'incoming-samples',input,endpoint);
    return verifyDevelopmentPhysicalReceipt(caseId,'incoming',item.command.actorId,input,item);
  },
  shipToFactory:async(caseId:string,input:DevelopmentFactoryShipmentInput,endpoint?:string)=>{
    input=clone(input);
    const item=await request(caseId,'factory-sample-shipments',input,endpoint);
    return verifyDevelopmentPhysicalReceipt(caseId,'factory',item.command.actorId,input,item);
  },
  readReceipt:(caseId:string,kind:'incoming'|'factory',requestKey:string,endpoint?:string)=>request(caseId,`physical-sample-commands/${kind}/${encodeURIComponent(requestKey)}`,undefined,endpoint),
};
