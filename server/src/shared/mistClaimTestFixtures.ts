/** Explicit upstream issued/departed baseline for tests that isolate the Claims domain. */
import {lineAmount,type MistState,type MistContext} from './mistWorkspace';
import {platformBusinessDate} from './mistPlatform';
export function testClaimNumberConsumer(now:string):NonNullable<MistContext['consumeBusinessNumber']>{
 const counters={CLM:0,RT:0,PV:0};return prefix=>prefix+'-'+platformBusinessDate(now).slice(0,4)+'-'+String(++counters[prefix]).padStart(4,'0');
}
export function seedIssuedClaimSource(state:MistState,invoiceId:string){
 const invoice=state.invoices.find(row=>row.id===invoiceId),order=state.orders.find(row=>row.id===invoice?.orderId);if(!invoice||!order||order.governance?.status!=='approved'||!order.governance.approvedSnapshot)throw new Error('Fixture requires a genuinely approved order and issued invoice');
 const snapshot=order.governance.approvedSnapshot,lines=snapshot.lines;if(lines.reduce((sum,line)=>sum+lineAmount(line.qty,line.price),0)!==invoice.amount)throw new Error('Fixture invoice must equal its exact upstream branches');
 const issuedAt=order.governance.approvedAt!,shipmentId='source-shipment-'+invoice.id,documentId='source-document-'+invoice.id;
 const branches=lines.map(line=>{const id='source-production-'+invoice.id+'-'+line.id;state.productions.push({id,code:'PRODUCTION-'+line.style,orderId:order.id,lineId:line.id,order:order.code,name:line.name,factory:'真实来源工厂',qty:line.qty,due:order.due,pct:100,img:line.img,col:'done'});return{orderId:order.id,lineId:line.id,productionId:id,quantity:line.qty,factoryConfirmedAt:issuedAt};});
 state.fulfillment.shipments.push({id:shipmentId,code:'SHIPPED-'+invoice.code,customerId:order.customerId,customer:order.customer,domain:order.type,consignee:'合同收货人',mode:'sea',portOfLoading:'上海',portOfDischarge:'合同港口',incoterm:'FOB',plannedDate:order.due,booking:'实际出运基线',lines:branches,note:'已出运上游事实，非本测试待执行计划',fileIds:[],state:'departed',requestedBy:order.owner,requesterId:'source-business',createdAt:issuedAt,departedAt:issuedAt});
 state.fulfillment.documents.push({id:documentId,shipmentId,orderId:order.id,type:'CI',number:invoice.code,version:1,title:'来源正式CI',dueDate:invoice.due,content:'已核对的正式商业发票基线',fileIds:[],status:'issued',invoiceId:invoice.id,createdAt:issuedAt,issuedAt,actor:'实际单证人'});
 return{shipmentId,documentId,branches};
}
