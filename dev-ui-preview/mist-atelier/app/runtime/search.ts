import type {MistState} from '../../../../server/src/shared/mistWorkspace';
import type {RouteTarget} from '../nav';
export type MistSearchRecord={view:string;id:string;group:string;label:string;hint:string;keywords:string;target?:RouteTarget};
/** Search follows the current workspace only; the caller applies effective view permission. */
export function moduleSearchRecords(s:MistState):MistSearchRecord[]{
 const records:MistSearchRecord[]=[];
 const add=(view:string,group:string,rows:ReadonlyArray<any>,label:(r:any)=>string,hint:(r:any)=>string)=>rows.forEach(r=>records.push({view,id:r.id,group,label:label(r),hint:hint(r),keywords:[r.code,r.name,r.title,r.customer,r.supplier,r.description].filter(Boolean).join(' ')}));
 add('products','数字档案',s.market?.products||[],r=>r.name,r=>r.sku);
 add('suppliers','供应商',s.market?.suppliers||[],r=>r.name,r=>r.code);
 add('relations','关系档案',s.market?.relations||[],r=>r.name,r=>r.category);
 add('quotations','报价',s.market?.quotations||[],r=>r.code,r=>r.status);
 add('marketing','营销活动',s.market?.campaigns||[],r=>r.name,r=>r.code);
 add('seasons','季节',s.market?.seasons||[],r=>r.name,r=>r.code);
 add('samples','样品',s.fulfillment?.samples||[],r=>r.name,r=>r.code);
 add('qc-workbench','QC任务',s.fulfillment?.qcTasks||[],r=>r.code,r=>r.factory);
 add('procurement','采购',s.fulfillment?.purchases||[],r=>r.code,r=>r.supplier);
 add('shipments','出运',s.fulfillment?.shipments||[],r=>r.code,r=>r.customer);
 add('document-center','单据',s.fulfillment?.documents||[],r=>r.title,r=>r.number);
 add('invoices','发票',s.invoices,r=>r.code,r=>r.customer);
 add('bom','BOM',s.platform?.boms||[],r=>r.name||r.code,r=>r.code||'');
 add('risks','风险',s.platform?.risks||[],r=>r.title,r=>r.state);
 add('claims','索赔',s.platform?.claims||[],r=>r.title||r.code,r=>r.code||'');
 return records;
}
/** 命令面板与搜索结果页共用的记录源：开发案、草稿、订单、客户 + 各模块记录，按当前账号可进入的页面过滤。 */
export function workspaceSearchRecords(s:MistState,canAccessView:(view:string)=>boolean):MistSearchRecord[]{
 const can={dev:canAccessView('development'),orders:canAccessView('orders'),crm:canAccessView('crm')};
 return [
  ...(can.dev?s.devs:[]).map(d=>({view:'development/detail',id:d.id,group:'开发案',label:d.name,hint:d.code,keywords:[d.style,d.customer].filter(Boolean).join(' '),target:{versionId:d.currentVersionId||undefined}})),
  ...(can.dev?s.drafts:[]).map(d=>({view:'development/new',id:d.id,group:'草稿',label:d.values.name||'未命名开发案',hint:'',keywords:[d.values.style,d.values.customer].filter(Boolean).join(' ')})),
  ...(can.orders?s.orders:[]).map(o=>({view:'orders/detail',id:o.id,group:'订单',label:o.code,hint:o.customer,keywords:[o.season,o.owner].filter(Boolean).join(' ')})),
  ...(can.crm?s.customers:[]).map(c=>({view:'crm',id:c.id,group:'客户',label:c.name,hint:c.code,keywords:[c.country,c.city,c.owner].filter(Boolean).join(' '),target:{customerId:c.id}})),
  ...moduleSearchRecords(s).filter(r=>canAccessView(r.view)),
 ];
}
export type MistSearchHit=MistSearchRecord&{score:number};
/** 空格分词，全部命中才算结果；名称完全一致 > 名称开头 > 名称包含 > 编号/摘要 > 其他关键词。 */
export function rankSearchRecords(records:ReadonlyArray<MistSearchRecord>,query:string):MistSearchHit[]{
 const q=query.trim().toLowerCase(),tokens=q.split(/\s+/).filter(Boolean);
 if(!tokens.length)return [];
 return records.flatMap(r=>{
  const label=(r.label||'').toLowerCase(),hint=(r.hint||'').toLowerCase(),all=`${label} ${hint} ${(r.keywords||'').toLowerCase()} ${r.group.toLowerCase()}`;
  if(!tokens.every(t=>all.includes(t)))return [];
  const score=label===q?100:label.startsWith(q)?80:label.includes(q)?60:hint.includes(q)?40:tokens.every(t=>label.includes(t))?50:20;
  return [{...r,score}];
 }).sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label,'zh-CN'));
}
