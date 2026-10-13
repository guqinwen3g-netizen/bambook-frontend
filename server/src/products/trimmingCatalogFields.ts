import {validateTrimmingCategoryParameters} from '../_shared/trimmingFields';
const fail=(message:string):never=>{throw Object.assign(new Error(message),{code:'VALIDATION_FAILED',statusCode:400});};
const link=(v:unknown)=>typeof v==='string'&&v.length<=20000000&&(/^(https?:\/\/|\/api\/|data:image\/)/.test(v));
/** Nullable additive fields preserve legacy profiles and their free-text categories. */
export function normalizeTrimmingCatalogFields(input:any,existing:any={}) {
 const out:Record<string,any>={};
 for(const key of ['manufacturerRelationId','supplierArticleNo','quoteConditions','priceUnit','moqUnit']) if(input[key]!==undefined) {
  if(input[key]!==null&&(typeof input[key]!=='string'||input[key].length>4000))fail('辅料供应与报价字段格式无效。');
  out[key]=input[key]===null?null:input[key].trim()||null;
 }
 if(input.quoteDate!==undefined){const date=input.quoteDate;if(date!==null&&date!==''&&(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))fail('报价日期须为有效日期。');out.quoteDate=date||null;}
 if(input.images!==undefined){if(input.images!==null&&(!Array.isArray(input.images)||input.images.length>30||input.images.some((v:unknown)=>!link(v))))fail('辅料图片须为有效上传文件引用。');out.images=input.images;}
 if(input.attachments!==undefined){if(input.attachments!==null&&(!Array.isArray(input.attachments)||input.attachments.length>100||input.attachments.some((v:any)=>!v||typeof v.name!=='string'||!v.name.trim()||v.name.length>400||!link(v.url))))fail('辅料附件须有文件名称和有效引用。');out.attachments=input.attachments;}
 const category=input.trimmingCategory??existing.trimmingCategory??'';
 if(input.categoryParameters!==undefined||(input.trimmingCategory!==undefined&&existing.categoryParameters)){
  const checked=validateTrimmingCategoryParameters(category,input.categoryParameters===undefined?existing.categoryParameters:input.categoryParameters);
  if(!checked.ok)fail(checked.message);else out.categoryParameters=input.categoryParameters===null?null:checked.value;
 }
 return out;
}
export async function assertTrimmingRelationReferences(db:any,profile:any){
 for(const key of ['manufacturerRelationId','supplierRelationId'])if(profile[key]){
  const relation=await db.relation.findFirst({where:{id:profile[key],deletedAt:null}});
  if(!relation)fail(key==='manufacturerRelationId'?'生产厂家档案不存在或已删除。':'供应商档案不存在或已删除。');
 }
}
