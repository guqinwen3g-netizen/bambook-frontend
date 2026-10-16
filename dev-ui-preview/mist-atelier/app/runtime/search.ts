import type {MistState} from '../../../../server/src/shared/mistWorkspace';
export type MistSearchRecord={view:string;id:string;group:string;label:string;hint:string;keywords:string};
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
