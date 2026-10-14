import {developmentDomain} from './mistDevelopmentDomain';
/** Market-side business records owned by the current Mist workspace. No fixture records are created. */
import { MistCommandError, type MistState, type MistContext, type MistCommandResult, type MistCustomer, mistMoneyMinor } from './mistWorkspace';
import type { MistReviewTask } from './mistReview';

type RecordBase = { id:string; createdAt:string; updatedAt:string; fileIds:string[]; note:string };
export type MarketProduct = RecordBase & { sku:string; name:string; category:'garment'|'fabric'|'trimming'; status:'active'|'archived'; season:string; supplierId:string; supplierCode:string; composition:string; specification:string; color:string; unit:string; cost:string; currency:string; sourceDevId:string; sourceVersionId:string; specs?:Record<string,string>; customerCodes?:Array<{customerId:string;code:string}>; refPrice?:string };
/** 数字档案按板块的结构化规格；面料不预设“件”，单位以实际计价单位为准。 */
export const PRODUCT_SPEC_FIELDS:Record<MarketProduct['category'],Array<{key:string;label:string;unit?:string}>>={
 fabric:[{key:'weight',label:'克重',unit:'g/m²'},{key:'width',label:'门幅',unit:'cm'},{key:'weave',label:'组织'},{key:'yarn',label:'纱支 / 原料'},{key:'finish',label:'后整理'}],
 garment:[{key:'style',label:'款号'},{key:'garmentCategory',label:'品类'},{key:'sizeRange',label:'尺码段'},{key:'mainFabric',label:'主面料'}],
 trimming:[{key:'trimType',label:'辅料类型'},{key:'size',label:'规格尺寸'},{key:'moq',label:'起订量'}],
};
function productSpecs(category:MarketProduct['category'],value:unknown):Record<string,string>{if(value!==undefined&&(typeof value!=='object'||value===null||Array.isArray(value)))fail('规格格式无效');const out:Record<string,string>={};for(const f of PRODUCT_SPEC_FIELDS[category]){const v=(value as Record<string,unknown>|undefined)?.[f.key];if(v===undefined||v==='')continue;if(typeof v!=='string'||v.length>200)fail(f.label+'格式无效');if(v.trim())out[f.key]=v.trim();}if((category==='fabric')&&out.weight&&!/^\d{1,4}(\.\d{1,2})?$/.test(out.weight))fail('克重须为数字（g/m²）');if(category==='fabric'&&out.width&&!/^\d{1,4}(\.\d{1,2})?$/.test(out.width))fail('门幅须为数字（cm）');return out;}
export type MarketSupplier = RecordBase & { code:string; name:string; type:string; country:string; address:string; capabilities:string; capacity:number; capacityUnit:string; leadDays:number; status:'active'|'blocked'; blockReason:string; contacts:Array<{id:string;name:string;role:string;email:string;phone:string;primary:boolean}> };
export type MarketRelation = RecordBase & { name:string; category:'Customer'|'Supplier'|'Agent'|'Partner'|'Government'|'Internal'|'Other'; customerId:string; supplierId:string; country:string; address:string; aliases:string[]; status:'active'|'archived'; contacts:Array<{id:string;name:string;role:string;email:string;phone:string;primary:boolean}> };
export type MarketSeason = RecordBase & { code:string; name:string; startDate:string; endDate:string; status:'Planning'|'Active'|'Closed'; milestones:Array<{label:string;date:string}>; review?:{at:string;orderCount:number;developmentCount:number;productCount:number;amounts:Array<{currency:string;amount:string}>} };
export type MarketTrend = RecordBase & { name:string; type:'fabric'|'color'|'craft'|'composition'; seasonId:string; source:string; productIds:string[] };
export type MarketShow = RecordBase & { name:string; location:string; seasonId:string; startDate:string; endDate:string; booth:string; attendees:string; cost:string; currency:string; status:'Planned'|'Ongoing'|'Completed'|'Cancelled' };
export type MarketCampaign = RecordBase & { code:string; name:string; type:string; seasonId:string; showId:string; startDate:string; endDate:string; target:string; budget:string; actualCost:string; currency:string; status:'Draft'|'Active'|'Paused'|'Completed'|'Cancelled'; owner:string; productIds:string[] };
export type MarketLead = RecordBase & { name:string; company:string; email:string; phone:string; demand:string; source:'campaign'|'show'; parentId:string; customerId:string; status:'New'|'Contacted'|'Qualified'|'Following'|'Converted'|'Lost'; followUpDate:string; estimatedValue:string; actualValue:string; currency:string; convertedAt:string|null };
export type MarketQuoteLine = { id:string; productId:string; sourceDevId:string; sourceVersionId:string; name:string; style:string; specification:string; qty:string; unit:string; price:string; cost:string; amount:string; costBasis?:'product'|'unverified' };
export type MarketQuoteApproval = { id:string; requesterId:string; reviewerId:string; status:'pending'|'approved'|'rejected'; submittedAt:string; decidedAt?:string; note?:string; details:Array<{label:string;value:string}>; fileIds:string[] };
export type MarketQuotation = RecordBase & { code:string; customerId:string; currency:string; season:string; validUntil:string; deliveryTerms:string; paymentTerms:string; status:'Draft'|'Sent'|'Accepted'|'Rejected'|'Expired'; lines:MarketQuoteLine[]; total:string; deliveryEvidence:string; responseEvidence:string; approval:MarketQuoteApproval|null; approvalHistory?:MarketQuoteApproval[]; requiresApproval?:boolean; convertedOrderId:string|null };
export type MarketLookbook = RecordBase & { name:string; customerId:string; productIds:string[]; status:'Draft'|'Prepared'|'Archived'; preparedAt:string|null; snapshots:Array<{id:string;sku:string;name:string;specification:string}> };
export type MarketState = { products:MarketProduct[]; suppliers:MarketSupplier[]; relations:MarketRelation[]; seasons:MarketSeason[]; trends:MarketTrend[]; shows:MarketShow[]; campaigns:MarketCampaign[]; leads:MarketLead[]; quotations:MarketQuotation[]; lookbooks:MarketLookbook[] };
type Input<T extends RecordBase> = Omit<T,keyof RecordBase|'status'> & {fileIds?:string[];note?:string};
export type MarketCommand =
 | {type:'market.customer.update';payload:{id:string;patch:Partial<Omit<MistCustomer,'id'|'code'>>}}
 | {type:'market.contact.delete';payload:{kind:'customer'|'supplier'|'relation';parentId:string;id:string}}
 | {type:'market.customer.create';payload:{input:Omit<MistCustomer,'id'|'code'>&{code?:string}}}
 | {type:'market.attachment.set';payload:{kind:'product'|'supplier'|'relation'|'season'|'trend'|'show'|'campaign'|'lead'|'showLead'|'quotation'|'lookbook';id:string;fileIds:string[]}}
 | {type:'market.showLead.save';payload:Extract<MarketCommand,{type:'market.lead.save'}>['payload']}
 | {type:'market.showLead.transition';payload:Extract<MarketCommand,{type:'market.lead.transition'}>['payload']}
 | {type:'market.product.save';payload:{id?:string;input:Input<MarketProduct>}}
 | {type:'market.product.fromVersion';payload:{devId:string;versionId:string;sku:string;supplierId?:string;supplierCode?:string}}
 | {type:'market.product.status';payload:{id:string;status:MarketProduct['status']}}
 | {type:'market.supplier.save';payload:{id?:string;input:Omit<Input<MarketSupplier>,'contacts'|'blockReason'>}}
 | {type:'market.supplier.status';payload:{id:string;status:MarketSupplier['status'];reason:string}}
 | {type:'market.relation.save';payload:{id?:string;input:Omit<Input<MarketRelation>,'contacts'>}}
 | {type:'market.relation.status';payload:{id:string;status:MarketRelation['status']}}
 | {type:'market.contact.save';payload:{kind:'customer'|'supplier'|'relation';parentId:string;id?:string;name:string;role:string;email:string;phone:string;primary:boolean}}
 | {type:'market.season.save';payload:{id?:string;input:Input<MarketSeason>&{status:MarketSeason['status']}}}
 | {type:'market.season.review';payload:{id:string}}
 | {type:'market.trend.save';payload:{id?:string;input:Input<MarketTrend>}}
 | {type:'market.show.save';payload:{id?:string;input:Input<MarketShow>&{status:MarketShow['status']}}}
 | {type:'market.campaign.save';payload:{id?:string;input:Omit<Input<MarketCampaign>,'code'>}}
 | {type:'market.campaign.status';payload:{id:string;status:MarketCampaign['status']}}
 | {type:'market.lead.save';payload:{id?:string;input:Omit<Input<MarketLead>,'convertedAt'>}}
 | {type:'market.lead.transition';payload:{id:string;status:MarketLead['status'];customerId?:string;actualValue?:string;note:string}}
 | {type:'market.quotation.save';payload:{id?:string;input:Omit<Input<MarketQuotation>,'code'|'total'|'deliveryEvidence'|'responseEvidence'|'approval'|'convertedOrderId'|'lines'>&{lines:Array<Omit<MarketQuoteLine,'id'|'amount'>>}}}
 | {type:'market.quotation.submit';payload:{id:string}}
 | {type:'market.quotation.decide';payload:{id:string;decision:'approved'|'rejected';note:string}}
 | {type:'market.quotation.status';payload:{id:string;status:MarketQuotation['status'];evidence:string}}
 | {type:'market.quotation.convert';payload:{id:string;type:'garment'|'fabric';due:string;owner:string}}
 | {type:'market.lookbook.save';payload:{id?:string;input:Omit<Input<MarketLookbook>,'preparedAt'|'snapshots'>}}
 | {type:'market.lookbook.status';payload:{id:string;status:MarketLookbook['status']}};

export function createMarketState(_context:MistContext,_rootState:Partial<MistState>):MarketState { return {products:[],suppliers:[],relations:[],seasons:[],trends:[],shows:[],campaigns:[],leads:[],quotations:[],lookbooks:[]}; }
export function marketCommandPermission(command:MarketCommand):string|null {
 if(command.type.startsWith('market.customer.')||command.type==='market.contact.delete')return 'relations:write';
 if(command.type==='market.attachment.set'){const scopes:Record<string,string>={product:'products',supplier:'suppliers',relation:'relations',season:'seasons',trend:'seasons',show:'seasons',campaign:'marketing',lead:'marketing',showLead:'seasons',quotation:'quotations',lookbook:'marketing'};const scope=scopes[command.payload.kind];if(!scope)throw new MistCommandError('VALIDATION','附件对象类型无效');return scope+':write';}
 if(command.type==='market.quotation.decide')return 'approvals:write';
 if(command.type==='market.quotation.convert')return 'orders:write';
 if(command.type.startsWith('market.quotation.'))return 'quotations:write';
 if(command.type.startsWith('market.supplier.'))return 'suppliers:write';
 if(command.type.startsWith('market.relation.')||command.type==='market.contact.save')return 'relations:write';
 if(command.type.startsWith('market.showLead.'))return 'seasons:write';
 if(command.type.startsWith('market.season.')||command.type.startsWith('market.trend.')||command.type.startsWith('market.show.'))return 'seasons:write';
 if(command.type.startsWith('market.campaign.')||command.type.startsWith('market.lead.')||command.type.startsWith('market.lookbook.'))return 'marketing:write';
 if(command.type.startsWith('market.product.'))return 'products:write';
 throw new MistCommandError('VALIDATION','未知市场操作');
}
export function getMarketReviews(rootState:MistState):MistReviewTask[] {
 return ((rootState as MistState&{market?:MarketState}).market?.quotations||[]).flatMap(q=>[...(q.approvalHistory||[]),...(q.approval?[q.approval]:[])].map(approval=>({id:approval.id,kind:'quotation' as const,entityId:q.id,title:q.code+' 报价审批',requesterId:approval.requesterId,reviewerIds:[approval.reviewerId],status:approval.status,submittedAt:approval.submittedAt,requiredPermission:'approvals:write',target:{view:'quotations',id:q.id},details:approval.details,fileIds:approval.fileIds})));
}
export function applyMarketCommand(rootState:MistState,command:MarketCommand,context:MistContext):MistCommandResult { return execute(rootState,command,context); }

function fail(message:string,code='VALIDATION'):never { throw new MistCommandError(code,message); }
const str=(value:unknown,label:string,required=true,max=8000):string=>{if(typeof value!=='string'||value.length>max||required&&!value.trim())return fail(label+'未填写或格式无效');return value.trim();};
const one=<T extends string>(value:unknown,values:readonly T[],label:string):T=>values.includes(value as T)?value as T:fail(label+'无效');
const find=<T extends {id:string}>(items:T[],id:unknown,label:string):T=>items.find(r=>r.id===id)||fail(label+'不存在','NOT_FOUND');
const arr=(value:unknown,label:string):string[]=>{if(!Array.isArray(value)||value.length>200)return fail(label+'格式无效');return [...new Set(value.map(v=>str(v,label)))];};
const day=(value:unknown,label:string,optional=false)=>{const v=str(value,label,!optional);if(!v&&optional)return '';if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)return fail(label+'格式无效');return v;};
const span=(start:unknown,end:unknown)=>{const startDate=day(start,'开始日期'),endDate=day(end,'结束日期');if(endDate<startDate)fail('结束日期不能早于开始日期');return {startDate,endDate};};
const currency=(v:unknown)=>{const s=str(v,'币种').toUpperCase();return /^[A-Z]{3}$/.test(s)?s:fail('币种必须为三个英文字母');};
const decimal=(v:unknown,label:string,precision=2,positive=false)=>{if(typeof v!=='string'||!new RegExp('^\\d{1,10}(\\.\\d{1,'+precision+'})?$').test(v))return fail(label+'须为最多'+precision+'位小数的非负数字');const [a,b='']=v.split('.');const minor=BigInt(a)*BigInt(10)**BigInt(precision)+BigInt(b.padEnd(precision,'0'));if(positive&&minor<=BigInt(0))return fail(label+'必须大于0');return {minor,text:a.replace(/^0+(?=\d)/,'')+(b?'.'+b:'')};};
const display=(n:bigint,precision=2)=>`${n/BigInt(10)**BigInt(precision)}.${String(n%BigInt(10)**BigInt(precision)).padStart(precision,'0')}`;
export function marketBusinessDate(instant:string|Date){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant));const get=(key:string)=>parts.find(p=>p.type===key)!.value;return get('year')+'-'+get('month')+'-'+get('day');}
export function marketLineAmount(qty:string,price:string):string {return display((decimal(qty,'数量',4,true).minor*decimal(price,'单价').minor+BigInt(5000))/BigInt(10000));}
export function marketSum(amounts:string[]):string {return display(amounts.reduce((sum,a)=>sum+decimal(a,'金额').minor,BigInt(0)));}
const count=(value:unknown,label:string)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e9?value:fail(label+'须为非负数');
function attachmentIds(root:MistState,value:unknown){const ids=arr(value||[],'附件');ids.forEach(id=>find(root.files,id,'附件'));return ids;}
function base(root:MistState,context:MistContext,input:{fileIds?:string[];note?:string},old?:RecordBase):RecordBase{return {id:old?.id||context.id(),createdAt:old?.createdAt||context.now,updatedAt:context.now,fileIds:attachmentIds(root,input.fileIds),note:str(input.note||'','备注',false)};}
function put<T extends RecordBase>(rows:T[],row:T,old?:T){if(old)rows[rows.indexOf(old)]=row;else rows.unshift(row);}
function history(root:MistState,ctx:MistContext,kind:string,id:string,text:string,fileIds:string[]=[]){root.events.unshift({id:ctx.id(),entityType:kind,entityId:id,actor:ctx.actorName,at:ctx.now,text,fileIds});}
function supplierRef(m:MarketState,id:string,active=true){if(!id)return '';const s=find(m.suppliers,id,'供应商');if(active&&s.status==='blocked')fail('供应商已被停用：'+s.blockReason,'PRECONDITION');return s.id;}
function validateSource(root:MistState,devId:string,versionId:string,pass=false){if(!devId&&!versionId)return;const d=find(root.devs,devId,'来源开发案'),v=find(root.versions,versionId,'来源版本');if(v.devId!==d.id||!d.versionIds.includes(v.id))fail('来源版本不属于该开发案');if(pass&&v.qc?.result!=='pass')fail('只有正式 QC 通过的准确版本可以转产品档案','PRECONDITION');}
function productRefs(m:MarketState,ids:unknown){const unique=arr(ids||[],'产品');unique.forEach(id=>{if(find(m.products,id,'产品').status!=='active')fail('已归档产品不可用于新活动');});return unique;}
function sourceLine(root:MistState,m:MarketState,input:Omit<MarketQuoteLine,'id'|'amount'>,ctx:MistContext,quoteCurrency:string):MarketQuoteLine{
 const productId=str(input.productId||'','产品',false);let sourceDevId=str(input.sourceDevId||'','来源开发案',false),sourceVersionId=str(input.sourceVersionId||'','来源版本',false);
 if(!productId&&!sourceVersionId)fail('报价条目须选择产品档案或准确开发版本');
 if(productId){const p=find(m.products,productId,'产品');if(p.status!=='active')fail('归档产品不可新增报价');if(sourceVersionId&&sourceVersionId!==p.sourceVersionId||sourceDevId&&sourceDevId!==p.sourceDevId)fail('产品与来源版本不一致');sourceDevId=p.sourceDevId;sourceVersionId=p.sourceVersionId;}
 validateSource(root,sourceDevId,sourceVersionId);
 const price=decimal(input.price,'单价').text,qty=decimal(input.qty,'数量',4,true).text,product=productId?find(m.products,productId,'产品'):undefined;
 const costBasis=product&&product.currency===quoteCurrency&&decimal(product.cost,'产品成本').minor>BigInt(0)?'product':'unverified';
 const cost=costBasis==='product'?product!.cost:input.cost?decimal(input.cost,'参考成本价').text:'';
 return {id:ctx.id(),productId,sourceDevId,sourceVersionId,name:str(input.name,'品名'),style:str(input.style,'款号'),specification:str(input.specification,'规格',false),qty,unit:str(input.unit,'单位'),price,cost,costBasis,amount:marketLineAmount(qty,price)};
}
export function quotationNeedsApproval(q:MarketQuotation){return q.requiresApproval===true||q.lines.some(l=>l.costBasis==='unverified'||!l.cost||decimal(l.price,'单价').minor<decimal(l.cost,'成本').minor);}
function archiveApproval(q:MarketQuotation){
 if(q.approval&&!q.approvalHistory?.some(a=>a.id===q.approval!.id))q.approvalHistory=[...(q.approvalHistory||[]),{...q.approval,details:q.approval.details.map(d=>({...d})),fileIds:[...q.approval.fileIds]}];
}
function customerRelation(root:MistState,m:MarketState,customerId:string,ctx:MistContext){
 const customer=find(root.customers,customerId,'客户');let relation=m.relations.find(r=>r.customerId===customerId);
 if(!relation){relation={...base(root,ctx,{}),name:customer.name,category:'Customer',customerId,supplierId:'',country:customer.country,address:customer.city,aliases:[],status:'active',contacts:[]};m.relations.push(relation);}
 relation.name=customer.name;relation.country=customer.country;relation.address=customer.city;
 relation.contacts=root.contacts.filter(c=>c.customerId===customerId).map(c=>({id:c.id,name:c.name,role:c.role,email:c.email,phone:c.phone,primary:relation!.contacts.find(old=>old.id===c.id)?.primary||false}));
 return relation;
}
function execute(root:MistState,command:MarketCommand,ctx:MistContext):MistCommandResult {
 marketCommandPermission(command);const m=(root as MistState&{market:MarketState}).market;if(!m)fail('市场工作区未初始化','INVALID_STATE');
 let result:MistCommandResult={};
 if(command.type==='market.showLead.save'){if(command.payload.input.source!=='show')fail('展会线索的来源类型无效');return execute(root,{type:'market.lead.save',payload:command.payload},ctx);}
 if(command.type==='market.showLead.transition'){if(find(m.leads,command.payload.id,'线索').source!=='show')fail('此线索不属于展会');return execute(root,{type:'market.lead.transition',payload:command.payload},ctx);}
 switch(command.type){
  case 'market.customer.update': {
   const {id,patch}=command.payload,customer=find(root.customers,id,'客户'),next={...customer};
   for(const key of ['name','country','city','industry','owner','grade','terms','incoterm','categories'] as const)if(patch[key]!==undefined)next[key]=str(patch[key],key,key==='name'||key==='owner');
   if(patch.currency!==undefined)next.currency=currency(patch.currency);
   if(patch.since!==undefined)next.since=day(patch.since,'合作起始日',true);
   if(patch.creditLimit!==undefined){if(typeof patch.creditLimit!=='number')fail('信用额度格式无效');mistMoneyMinor(patch.creditLimit);next.creditLimit=patch.creditLimit;}
   Object.assign(customer,next);customerRelation(root,m,id,ctx).updatedAt=ctx.now;
   root.devs.filter(d=>d.customerId===id).forEach(d=>{d.customer=next.name;d.values.customer=next.name;});root.orders.filter(o=>o.customerId===id).forEach(o=>o.customer=next.name);
   history(root,ctx,'customer',id,'更新客户档案 '+customer.name);return{id,customerId:id};
  }
  case 'market.contact.delete': {
   const i=command.payload;let parent=i.kind==='customer'?customerRelation(root,m,i.parentId,ctx):i.kind==='supplier'?find(m.suppliers,i.parentId,'供应商'):find(m.relations,i.parentId,'关系档案');
   const removed=find(parent.contacts,i.id,'当前组织联系人');parent.contacts=parent.contacts.filter(c=>c.id!==i.id);parent.updatedAt=ctx.now;
   if(i.kind==='supplier'){const relation=m.relations.find(r=>r.supplierId===parent.id);if(relation)relation.contacts=parent.contacts.map(c=>({...c}));}
   else {const relation=parent as MarketRelation;if(relation.supplierId)find(m.suppliers,relation.supplierId,'供应商').contacts=parent.contacts.map(c=>({...c}));if(relation.customerId)root.contacts=root.contacts.filter(c=>c.id!==i.id||c.customerId!==relation.customerId);}
   const linked=parent as MarketRelation;history(root,ctx,linked.customerId?'customer':'relation',linked.customerId||linked.supplierId||parent.id,'删除联系人 '+removed.name);return{id:parent.id,contactId:i.id};
  }
  case 'market.customer.create': {
   const input=command.payload.input;
   const suppliedCode=str(input.code||'','客户编码',false,120);
   let code=suppliedCode;
   if(!code){let serial=root.customers.length+1;do{code=`CUS-${ctx.now.slice(0,4)}-${String(serial++).padStart(4,'0')}`;}while(root.customers.some(c=>c.code.toLowerCase()===code.toLowerCase()));}
   if(root.customers.some(c=>c.code.toLowerCase()===code.toLowerCase()))fail('客户编码已存在');
   if(typeof input.creditLimit!=='number'||!Number.isFinite(input.creditLimit))fail('信用额度格式无效');
   mistMoneyMinor(input.creditLimit);
   const customer:MistCustomer={id:ctx.id(),code,name:str(input.name,'客户名称'),country:str(input.country,'国家',false),city:str(input.city,'城市',false),industry:str(input.industry,'行业',false),owner:str(input.owner,'客户经理'),grade:str(input.grade,'等级',false),currency:currency(input.currency),terms:str(input.terms,'付款条款',false),incoterm:str(input.incoterm,'贸易术语',false),categories:str(input.categories,'主要品类',false),creditLimit:input.creditLimit,since:day(input.since,'合作起始日',true)};
   const relation:MarketRelation={...base(root,ctx,{}),name:customer.name,category:'Customer',customerId:customer.id,supplierId:'',country:customer.country,address:customer.city,aliases:[],status:'active',contacts:[]};
   root.customers.push(customer);m.relations.push(relation);
   history(root,ctx,'customer',customer.id,'创建客户档案 '+customer.name);
   return {id:customer.id,customerId:customer.id,relationId:relation.id};
  }
  case 'market.attachment.set':{const i=command.payload;const collections={product:m.products,supplier:m.suppliers,relation:m.relations,season:m.seasons,trend:m.trends,show:m.shows,campaign:m.campaigns,lead:m.leads,quotation:m.quotations,lookbook:m.lookbooks,showLead:m.leads};if(i.kind==='showLead'&&find(m.leads,i.id,'展会线索').source!=='show')fail('该附件不属于展会线索');const row=find<RecordBase>(collections[i.kind],i.id,'附件所属对象');if(i.kind==='quotation'){const q=row as MarketQuotation;if(q.status!=='Draft'||q.approval?.status==='pending')fail('审批中或已发送的报价附件已冻结');archiveApproval(q);q.approval=null;}row.fileIds=attachmentIds(root,i.fileIds);row.updatedAt=ctx.now;result={id:row.id};break;}
  case 'market.product.save':{const {id,input}=command.payload,old=id?find(m.products,id,'产品'):undefined;if(old?.status==='archived')fail('归档产品须先恢复再编辑');
   const sku=str(input.sku,'公司产品编码');if(m.products.some(x=>x.id!==id&&x.sku.toLowerCase()===sku.toLowerCase()))fail('公司产品编码已存在');
   const sourceDevId=str(input.sourceDevId||'','来源开发案',false),sourceVersionId=str(input.sourceVersionId||'','来源版本',false);validateSource(root,sourceDevId,sourceVersionId,true);
   if(old&&(old.sourceDevId!==sourceDevId||old.sourceVersionId!==sourceVersionId))fail('产品来源版本不可替换，请另建产品档案');
   if(sourceVersionId&&m.products.some(x=>x.id!==id&&x.sourceVersionId===sourceVersionId))fail('该准确版本已有产品档案');
   const row:MarketProduct={...base(root,ctx,input,old),sku,name:str(input.name,'名称'),category:one(input.category,['garment','fabric','trimming'],'类别'),status:old?.status||'active',season:str(input.season,'季节',false),supplierId:supplierRef(m,input.supplierId||''),supplierCode:str(input.supplierCode,'供应商编码',false),composition:str(input.composition,'成分',false),specification:str(input.specification,'规格',false),color:str(input.color,'颜色',false),unit:str(input.unit,'单位'),cost:decimal(input.cost,'成本').text,currency:currency(input.currency),sourceDevId,sourceVersionId};
   const specs=productSpecs(row.category,input.specs===undefined?(old?.category===row.category?old?.specs:undefined):input.specs);if(Object.keys(specs).length)row.specs=specs;
   if(input.customerCodes!==undefined){if(!Array.isArray(input.customerCodes)||input.customerCodes.length>50)fail('客户编码表格式无效');const seen=new Set<string>();const codes:Array<{customerId:string;code:string}>=[];for(const c of input.customerCodes as unknown[]){const r=c as {customerId?:unknown;code?:unknown};if(!r||typeof r.customerId!=='string'||!root.customers.some(x=>x.id===r.customerId))fail('客户编码引用的客户不存在');if(seen.has(r.customerId as string))fail('同一客户只能登记一个客户编码');seen.add(r.customerId as string);codes.push({customerId:r.customerId as string,code:str(r.code,'客户编码',true,80)});}if(codes.length)row.customerCodes=codes;}else if(old?.customerCodes)row.customerCodes=old.customerCodes.map(c=>({...c}));
   const refPrice=input.refPrice===undefined?(old?.refPrice||''):String(input.refPrice).trim();if(refPrice)row.refPrice=decimal(refPrice,'参考价').text;
   put(m.products,row,old);result={id:row.id};break;}
  case 'market.product.fromVersion':{const {devId,versionId}=command.payload;validateSource(root,devId,versionId,true);const previous=m.products.find(x=>x.sourceVersionId===versionId);if(previous)return {id:previous.id,devId,versionId};const d=find(root.devs,devId,'开发案'),v=find(root.versions,versionId,'版本');
   const isFabric=developmentDomain(d.values)==='fabric',fr=v.fabricRequirements||d.values.fabricRequirements,known=(x:string|undefined)=>x&&x!=='待工厂分析'?x:'';
   const specs:Record<string,string>=isFabric?{weight:fr&&(!fr.weightUnit||fr.weightUnit==='g/m²')&&/^\d{1,4}(\.\d{1,2})?$/.test(fr.weightValue)?fr.weightValue:'',width:fr&&(!fr.widthUnit||fr.widthUnit==='cm')&&/^\d{1,4}(\.\d{1,2})?$/.test(fr.widthValue)?fr.widthValue:'',weave:known(fr?.weave),yarn:known(fr?.yarn),finish:known(fr?.finish)}:{style:d.values.style||'',garmentCategory:d.values.category||'',sizeRange:v.size||'',mainFabric:v.fabric||''};
   const composition=isFabric&&known(fr?.composition)?fr!.composition.split('\n').map(x=>x.trim()).filter(Boolean).join(' / '):v.fabric;
   const saved=execute(root,{type:'market.product.save',payload:{input:{sku:command.payload.sku,name:d.name,category:isFabric?'fabric':'garment',season:d.values.season,supplierId:command.payload.supplierId||'',supplierCode:command.payload.supplierCode||'',composition,specification:v.size,color:d.values.color,specs,refPrice:'',unit:d.values.targetUnit||(isFabric?'米':'件'),cost:'0',currency:d.values.targetCurrency||'USD',sourceDevId:devId,sourceVersionId:versionId,fileIds:v.fileIds,note:`来源 ${d.code} / ${v.label}；成本待核实`}}},ctx);result={...saved,devId,versionId};break;}
  case 'market.product.status':{const row=find(m.products,command.payload.id,'产品');row.status=one(command.payload.status,['active','archived'],'产品状态');row.updatedAt=ctx.now;result={id:row.id};break;}
  case 'market.supplier.save':{const {id,input}=command.payload,old=id?find(m.suppliers,id,'供应商'):undefined,code=str(input.code,'供应商编码');if(m.suppliers.some(x=>x.id!==id&&x.code.toLowerCase()===code.toLowerCase()))fail('供应商编码已存在');
   const row:MarketSupplier={...base(root,ctx,input,old),code,name:str(input.name,'供应商名称'),type:str(input.type,'供应商类型'),country:str(input.country,'国家地区',false),address:str(input.address,'生产地址',false),capabilities:str(input.capabilities,'生产能力'),capacity:count(input.capacity,'月产能'),capacityUnit:str(input.capacityUnit,'产能单位'),leadDays:count(input.leadDays,'交付周期'),status:old?.status||'active',blockReason:old?.blockReason||'',contacts:old?.contacts||[]};put(m.suppliers,row,old);
   const relation=m.relations.find(x=>x.supplierId===row.id);if(relation){relation.name=row.name;relation.country=row.country;relation.address=row.address;relation.updatedAt=ctx.now;}else m.relations.push({...base(root,ctx,{}),name:row.name,category:'Supplier',customerId:'',supplierId:row.id,country:row.country,address:row.address,aliases:[],status:'active',contacts:[]});result={id:row.id};break;}
  case 'market.supplier.status':{const row=find(m.suppliers,command.payload.id,'供应商');row.status=one(command.payload.status,['active','blocked'],'供应商状态');row.blockReason=str(command.payload.reason,'停用原因',row.status==='blocked');row.updatedAt=ctx.now;result={id:row.id};break;}
  case 'market.relation.save':{const {id,input}=command.payload,old=id?find(m.relations,id,'关系档案'):undefined,category=one(input.category,['Customer','Supplier','Agent','Partner','Government','Internal','Other'],'关系类别');const customerId=category==='Customer'?find(root.customers,input.customerId,'现有客户').id:'',supplierId=category==='Supplier'?supplierRef(m,input.supplierId,false):'';if(category==='Supplier'&&!supplierId)fail('供应商关系须引用现有供应商');if(m.relations.some(r=>r.id!==id&&((customerId&&r.customerId===customerId)||(supplierId&&r.supplierId===supplierId))))fail('该组织已有关联关系档案');
   if(old&&(old.customerId||old.supplierId)&&(old.customerId!==customerId||old.supplierId!==supplierId||old.category!==category))fail('已关联组织身份不可改绑，请创建独立关系档案');
   const supplier=supplierId?find(m.suppliers,supplierId,'供应商'):undefined;const row:MarketRelation={...base(root,ctx,input,old),category,customerId,supplierId,name:customerId?find(root.customers,customerId,'客户').name:supplier?.name||str(input.name,'组织名称'),country:supplier?.country||str(input.country,'国家地区',false),address:supplier?.address||str(input.address,'地址',false),aliases:arr(input.aliases||[],'组织别名'),status:old?.status||'active',contacts:old?.contacts||supplier?.contacts||[]};put(m.relations,row,old);result={id:row.id};break;}
  case 'market.relation.status':{const r=find(m.relations,command.payload.id,'关系档案');r.status=one(command.payload.status,['active','archived'],'关系状态');r.updatedAt=ctx.now;result={id:r.id};break;}
  case 'market.contact.save':{const i=command.payload;if(!['customer','supplier','relation'].includes(i.kind))fail('联系人所属类型无效');const parent=i.kind==='customer'?customerRelation(root,m,i.parentId,ctx):i.kind==='supplier'?find(m.suppliers,i.parentId,'供应商'):find(m.relations,i.parentId,'关系档案');if(i.kind==='relation'&&(parent as MarketRelation).customerId)customerRelation(root,m,(parent as MarketRelation).customerId,ctx);const email=str(i.email,'邮箱',false);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('邮箱格式无效');const old=i.id?find(parent.contacts,i.id,'联系人'):undefined;
   const row={id:old?.id||ctx.id(),name:str(i.name,'联系人姓名'),role:str(i.role,'岗位',false),email,phone:str(i.phone,'电话',false),primary:!!i.primary};if(row.primary)parent.contacts.forEach(c=>c.primary=false);if(old)parent.contacts[parent.contacts.indexOf(old)]=row;else parent.contacts.push(row);parent.updatedAt=ctx.now;
   if(i.kind==='supplier'){const related=m.relations.find(r=>r.supplierId===parent.id);if(related)related.contacts=parent.contacts.map(c=>({...c}));}else{const relation=parent as MarketRelation;if(relation.supplierId)find(m.suppliers,relation.supplierId,'供应商').contacts=parent.contacts.map(c=>({...c}));if(relation.customerId){const existing=root.contacts.find(c=>c.id===row.id);const saved={id:row.id,customerId:relation.customerId,name:row.name,role:row.role,email:row.email,phone:row.phone,tone:'neutral' as const};if(existing)Object.assign(existing,saved);else root.contacts.push(saved);}}const linked=parent as MarketRelation;history(root,ctx,linked.customerId?'customer':'relation',linked.customerId||linked.supplierId||parent.id,'保存联系人 '+row.name);result={id:parent.id,contactId:row.id};break;}
  case 'market.season.save':{const {id,input}=command.payload,old=id?find(m.seasons,id,'季节'):undefined,code=str(input.code,'季节编码').toUpperCase();if(!/^(SS|AW)\d{2}$/.test(code))fail('季节编码格式为 SS26 或 AW26');if(old&&old.code!==code)fail('季节编码创建后不可更改');if(m.seasons.some(x=>x.id!==id&&x.code===code))fail('季节编码已存在');if(!Array.isArray(input.milestones))fail('里程碑无效');const dates=span(input.startDate,input.endDate);const milestones=input.milestones.map(x=>({label:str(x.label,'里程碑名称'),date:day(x.date,'里程碑日期')}));if(milestones.some(x=>x.date<dates.startDate||x.date>dates.endDate))fail('里程碑须在季节日期范围内');const row:MarketSeason={...base(root,ctx,input,old),code,name:str(input.name,'季节名称'),...dates,milestones,status:one(input.status,['Planning','Active','Closed'],'季节状态'),review:old?.review};put(m.seasons,row,old);result={id:row.id};break;}
  case 'market.season.review':{const row=find(m.seasons,command.payload.id,'季节'),orders=root.orders.filter(o=>o.season.toUpperCase()===row.code);row.review={at:ctx.now,orderCount:orders.length,developmentCount:root.devs.filter(d=>d.values.season.toUpperCase()===row.code).length,productCount:m.products.filter(d=>d.season.toUpperCase()===row.code).length,amounts:[...new Set(orders.map(o=>o.currency))].map(c=>({currency:c,amount:marketSum(orders.filter(o=>o.currency===c).map(o=>String(o.amount)))}))};row.updatedAt=ctx.now;result={id:row.id};break;}
  case 'market.trend.save':{const {id,input}=command.payload,old=id?find(m.trends,id,'趋势'):undefined;find(m.seasons,input.seasonId,'季节');const productIds=productRefs(m,input.productIds);if(productIds.some(id=>find(m.products,id,'产品').category!=='fabric'))fail('趋势面料仅关联面料档案');const row:MarketTrend={...base(root,ctx,input,old),name:str(input.name,'趋势名称'),type:one(input.type,['fabric','color','craft','composition'],'趋势类型'),seasonId:input.seasonId,source:str(input.source,'来源依据'),productIds};put(m.trends,row,old);result={id:row.id};break;}
  case 'market.show.save':{const {id,input}=command.payload,old=id?find(m.shows,id,'展会'):undefined;if(input.seasonId)find(m.seasons,input.seasonId,'季节');const row:MarketShow={...base(root,ctx,input,old),name:str(input.name,'展会名称'),location:str(input.location,'展会地点'),seasonId:input.seasonId||'',...span(input.startDate,input.endDate),booth:str(input.booth,'展位',false),attendees:str(input.attendees,'参与人',false),cost:decimal(input.cost,'展会费用').text,currency:currency(input.currency),status:one(input.status,['Planned','Ongoing','Completed','Cancelled'],'展会状态')};put(m.shows,row,old);result={id:row.id};break;}
  case 'market.campaign.save':{const {id,input}=command.payload,old=id?find(m.campaigns,id,'活动'):undefined;if(old&&old.status!=='Draft'&&old.status!=='Paused')fail('运行中的活动须暂停后编辑');if(input.seasonId)find(m.seasons,input.seasonId,'季节');if(input.showId)find(m.shows,input.showId,'展会');const row:MarketCampaign={...base(root,ctx,input,old),code:old?.code||`MKT-${ctx.now.slice(0,4)}-${String(m.campaigns.length+1).padStart(4,'0')}`,name:str(input.name,'活动名称'),type:str(input.type,'活动类型'),seasonId:input.seasonId||'',showId:input.showId||'',...span(input.startDate,input.endDate),target:str(input.target,'目标客户群'),budget:decimal(input.budget,'预算').text,actualCost:decimal(input.actualCost,'实际费用').text,currency:currency(input.currency),status:old?.status||'Draft',owner:str(input.owner,'负责人'),productIds:productRefs(m,input.productIds)};put(m.campaigns,row,old);result={id:row.id};break;}
  case 'market.campaign.status':{const row=find(m.campaigns,command.payload.id,'活动'),next=one(command.payload.status,['Draft','Active','Paused','Completed','Cancelled'],'活动状态');const allowed:Record<MarketCampaign['status'],string[]>={Draft:['Active','Cancelled'],Active:['Paused','Completed','Cancelled'],Paused:['Active','Completed','Cancelled'],Completed:[],Cancelled:[]};if(next!==row.status&&!allowed[row.status].includes(next))fail('此活动状态不可直接转换','PRECONDITION');row.status=next;row.updatedAt=ctx.now;result={id:row.id};break;}
  case 'market.lead.save':{const {id,input}=command.payload,old=id?find(m.leads,id,'线索'):undefined;if(old?.status==='Converted')fail('已转化线索须保留原始来源');const source=one(input.source,['campaign','show'],'线索来源');if(old&&(old.source!==source||old.parentId!==input.parentId))fail('已记录线索的来源活动不可改绑');find<{id:string}>(source==='campaign'?m.campaigns:m.shows,input.parentId,'来源活动或展会');if(input.customerId)find(root.customers,input.customerId,'客户');const row:MarketLead={...base(root,ctx,input,old),name:str(input.name,'联系人'),company:str(input.company,'公司'),email:str(input.email,'邮箱',false),phone:str(input.phone,'电话',false),demand:str(input.demand,'需求'),source,parentId:input.parentId,customerId:input.customerId||'',status:old?.status||'New',followUpDate:day(input.followUpDate,'跟进日期',true),estimatedValue:decimal(input.estimatedValue,'预计金额').text,actualValue:old?.actualValue||'0',currency:currency(input.currency),convertedAt:null};if(row.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))fail('邮箱格式无效');put(m.leads,row,old);result={id:row.id};break;}
  case 'market.lead.transition':{const i=command.payload,row=find(m.leads,i.id,'线索'),status=one(i.status,row.source==='show'?['New','Following','Converted','Lost']:['New','Contacted','Qualified','Converted','Lost'],'线索状态');if(row.status==='Converted')fail('已转化线索不可改状态');if(status==='Converted'){row.customerId=find(root.customers,i.customerId||row.customerId,'转化客户').id;row.actualValue=decimal(i.actualValue||'0','转化金额').text;row.convertedAt=ctx.now;}row.note=[row.note,str(i.note,'状态说明')].filter(Boolean).join('\n');row.status=status;row.updatedAt=ctx.now;result={id:row.id,customerId:row.customerId};break;}
  case 'market.quotation.save':{const {id,input}=command.payload,old=id?find(m.quotations,id,'报价'):undefined;if(old&&(old.status!=='Draft'||old.approval?.status==='pending'))fail('已发送或审批中的报价不可改写，请另建报价');find(root.customers,input.customerId,'客户');if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>200)fail('报价至少需要一个条目');const lines=input.lines.map(l=>sourceLine(root,m,l,ctx,currency(input.currency)));if(old)archiveApproval(old);const row:MarketQuotation={...base(root,ctx,input,old),code:old?.code||`QT-${ctx.now.slice(0,4)}-${String(m.quotations.length+1).padStart(4,'0')}`,customerId:input.customerId,currency:currency(input.currency),season:str(input.season,'季节',false),validUntil:day(input.validUntil,'有效期'),deliveryTerms:str(input.deliveryTerms,'贸易术语'),paymentTerms:str(input.paymentTerms,'付款条件'),status:'Draft',lines,total:marketSum(lines.map(l=>l.amount)),deliveryEvidence:'',responseEvidence:'',approval:null,approvalHistory:old?.approvalHistory||[],requiresApproval:old?.requiresApproval||false,convertedOrderId:null};put(m.quotations,row,old);result={id:row.id};break;}
  case 'market.quotation.submit': {
   const q = find(m.quotations, command.payload.id, '报价');
   if (q.status !== 'Draft' || q.approval?.status === 'pending') fail('仅未提交的草稿可申请审批');
   const requesterId = ctx.actorId, reviewerId = ctx.authority?.businessReviewerId;
   if (!requesterId || !reviewerId || reviewerId === requesterId) fail('未能解析独立的业务审批负责人', 'PRECONDITION');
   archiveApproval(q);q.requiresApproval=true;
   const approval: MarketQuoteApproval = {
    id: ctx.id(), requesterId, reviewerId, status: 'pending', submittedAt: ctx.now, fileIds: [...q.fileIds],
    details: [
     {label:'报价',value:q.code}, {label:'客户',value:find(root.customers,q.customerId,'客户').name},
     {label:'金额',value:q.currency+' '+q.total}, {label:'贸易与付款',value:q.deliveryTerms+' / '+q.paymentTerms},
     {label:'有效期',value:q.validUntil},
     ...q.lines.map(l=>({label:l.name+' / '+l.style,value:`${l.qty} ${l.unit} × ${l.price} = ${l.amount}; 成本 ${l.cost||'未填写'}; 来源 ${l.productId||l.sourceDevId+'/'+l.sourceVersionId}`})),
    ],
   };
   q.approval = approval; q.updatedAt = ctx.now;
   result = {id:q.id,reviewId:approval.id}; break;
  }
  case 'market.quotation.decide': {
   const q = find(m.quotations, command.payload.id, '报价'), approval = q.approval;
   if (!approval || approval.status !== 'pending') fail('没有待决定的报价审批');
   if (!ctx.actorId || ctx.actorId !== approval.reviewerId || ctx.actorId === approval.requesterId || ctx.authority?.businessReviewerId !== approval.reviewerId) fail('当前账号不是本次报价的指定审批人','FORBIDDEN');
   approval.status = one(command.payload.decision, ['approved','rejected'], '审批结果');
   approval.note = str(command.payload.note, '审批意见'); approval.decidedAt = ctx.now; q.updatedAt = ctx.now;
   result = {id:q.id}; break;
  }
  case 'market.quotation.status':{const q=find(m.quotations,command.payload.id,'报价'),next=one(command.payload.status,['Draft','Sent','Accepted','Rejected','Expired'],'报价状态');const allowed:Record<MarketQuotation['status'],string[]>={Draft:['Sent'],Sent:['Accepted','Rejected','Expired'],Accepted:[],Rejected:[],Expired:[]};if(!allowed[q.status].includes(next))fail('不允许此报价状态转换','PRECONDITION');const evidence=str(command.payload.evidence,'实际操作凭据');if(next==='Sent'){if(q.approval?.status==='pending'||q.approval?.status==='rejected'||quotationNeedsApproval(q)&&q.approval?.status!=='approved')fail('此报价须先取得业务负责人审批','PRECONDITION');if(q.validUntil<marketBusinessDate(ctx.now))fail('报价已超过有效期');q.deliveryEvidence=evidence;}else{if(next==='Expired'&&q.validUntil>=marketBusinessDate(ctx.now))fail('报价尚未到期');q.responseEvidence=evidence;}q.status=next;q.updatedAt=ctx.now;result={id:q.id};break;}
  case 'market.quotation.convert':{const q=find(m.quotations,command.payload.id,'报价');if(q.status!=='Accepted')fail('仅客户已接受的报价可转订单');if(q.convertedOrderId){find(root.orders,q.convertedOrderId,'已转订单');return {id:q.id,orderId:q.convertedOrderId};}const type=one(command.payload.type,['garment','fabric'],'订单类型');for(const line of q.lines){const product=line.productId?find(m.products,line.productId,'报价产品'):undefined;const family=product?.category||(line.sourceDevId?developmentDomain(find(root.devs,line.sourceDevId,'来源开发案').values)==='fabric'?'fabric':'garment':undefined);if(family&&family!==type)fail('订单类型与报价来源不一致，请按业务类型分别转单');}const due=day(command.payload.due,'订单交期'),owner=str(command.payload.owner,'负责人'),customer=find(root.customers,q.customerId,'客户');const id=ctx.id(),code=`SO-${type==='fabric'?'F':'G'}-${ctx.now.slice(0,4)}-${String(root.orders.length+1).padStart(4,'0')}`;
   // Existing order consumers use numeric money; reject any value that cannot round-trip exactly.
   q.lines.forEach(l=>{if(decimal(String(Number(l.price)),'单价').minor!==decimal(l.price,'单价').minor||decimal(String(Number(l.qty)),'数量',4).minor!==decimal(l.qty,'数量',4).minor)fail('报价数量或金额超出现有订单可精确承接的范围');});
   root.orders.unshift({id,code,type,customerId:customer.id,customer:customer.name,season:q.season,lines:q.lines.length,qty:q.lines.reduce((n,l)=>n+Number(l.qty),0),amount:Number(q.total),currency:q.currency,due,progress:0,state:'待安排',tone:'neutral',owner,img:'coat',checklist:['装箱单草稿','唛头确认','尾期 QC 预约','报关资料','订舱'].map((label,index)=>({id:id+'-check-'+index,label,done:false,note:''})),handoffAt:null,createdAt:ctx.now,updatedAt:ctx.now});
   q.lines.forEach(l=>root.orderLines.push(Object.assign({id:ctx.id(),orderId:id,name:l.name,style:l.style,img:'coat' as const,qty:Number(l.qty),unit:l.unit,price:Number(l.price),made:0,qc:0},{sourceQuotationId:q.id,sourceQuotationLineId:l.id,sourceProductId:l.productId,sourceDevId:l.sourceDevId,sourceVersionId:l.sourceVersionId,quantityExact:l.qty,unitPriceExact:l.price,amountExact:l.amount,specification:l.specification})));q.convertedOrderId=id;q.updatedAt=ctx.now;history(root,ctx,'order',id,'从已接受报价 '+q.code+' 创建订单');result={id:q.id,orderId:id};break;}
  case 'market.lookbook.save':{const {id,input}=command.payload,old=id?find(m.lookbooks,id,'画册'):undefined;if(old&&old.status!=='Draft')fail('已准备或归档画册不可改写');if(input.customerId)find(root.customers,input.customerId,'客户');const row:MarketLookbook={...base(root,ctx,input,old),name:str(input.name,'画册名称'),customerId:input.customerId||'',productIds:productRefs(m,input.productIds),status:'Draft',preparedAt:null,snapshots:[]};put(m.lookbooks,row,old);result={id:row.id};break;}
  case 'market.lookbook.status':{const row=find(m.lookbooks,command.payload.id,'画册'),next=one(command.payload.status,['Draft','Prepared','Archived'],'画册状态');if(row.status==='Archived')fail('归档画册不可修改');if(next===row.status)return{id:row.id};if(next==='Prepared'){if(row.status!=='Draft')fail('请先退回草稿再重新准备画册');if(!row.productIds.length)fail('准备画册至少选择一个产品');productRefs(m,row.productIds);row.snapshots=row.productIds.map(id=>{const p=find(m.products,id,'产品');return {id:p.id,sku:p.sku,name:p.name,specification:p.specification};});row.preparedAt=ctx.now;}if(next==='Draft'){row.preparedAt=null;row.snapshots=[];}row.status=next;row.updatedAt=ctx.now;result={id:row.id};break;}
 }
 if(!result.id)fail('市场操作没有返回业务对象','INVALID_STATE');history(root,ctx,command.type.split('.')[1],String(result.id),command.type);return result;
}
