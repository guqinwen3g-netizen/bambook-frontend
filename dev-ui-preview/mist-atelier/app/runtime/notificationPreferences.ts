import type {MistState,MistTarget} from '../../../../server/src/shared/mistWorkspace';

type CanRead=(view:string)=>boolean;
export function visibleMistNotifications(state:MistState|null|undefined,canRead:CanRead){
  return (state?.notifications??[]).filter(item=>{
    if(!canRead(item.target.view.split('/')[0]))return false;
    const category=item.category??'general',prefs=state!.settings.notifications;
    return category==='qc'?prefs.qc:category==='shipping'?prefs.shipping:category==='suggestion'?prefs.suggestions:true;
  });
}
export type MistDigestItem={id:string;label:string;detail:string;target:MistTarget};
/** A read-only, on-demand digest of current records. No email or scheduled side effects. */
export function mistDailyDigest(state:MistState|null|undefined,today:string,canRead:CanRead):MistDigestItem[]{
  if(!state||!state.settings.notifications.digest)return [];
  const items:MistDigestItem[]=[];
  for(const task of state.tasks.filter(t=>!t.done&&t.due<=today&&canRead(t.target.view.split('/')[0])))items.push({id:'task:'+task.id,label:task.title,detail:!task.due?'未定期限':task.due===today?'今天到期':'已过期 · '+task.due,target:task.target});
  if(canRead('qc-workbench'))for(const task of state.fulfillment.qcTasks.filter(t=>['pending','working'].includes(t.state)))items.push({id:'qc:'+task.id,label:'待处理 QC · '+task.code,detail:'当前尚未完成检验',target:{view:'qc-workbench',id:task.id}});
  if(canRead('shipments'))for(const shipment of state.fulfillment.shipments.filter(s=>s.plannedDate===today&&!['departed','cancelled'].includes(s.state)))items.push({id:'shipment:'+shipment.id,label:'今日计划出运 · '+shipment.code,detail:'以实际出运登记为准',target:{view:'shipments',id:shipment.id}});
  if(canRead('invoices')){
    const groups=new Map<string,{amount:number;count:number}>();
    for(const invoice of state.invoices.filter(i=>i.open>0)){const group=groups.get(invoice.currency)??{amount:0,count:0};group.amount+=Math.round(invoice.open*100);group.count++;groups.set(invoice.currency,group);}
    for(const [currency,group] of groups)items.push({id:'receivable:'+currency,label:'应收待核销 · '+currency,detail:`${(group.amount/100).toFixed(2)} ${currency} · ${group.count} 张发票`,target:{view:'invoices'}});
  }
  return items;
}
