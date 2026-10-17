/** BB-ORD-4：开工后的订单数量变更——影响清单与下限。
 * 下限：每条目新数量 ≥ max(已完工登记数, 已排非取消出运数)；成衣有分色分码且完工按尺码登记时，每个尺码各色合计 ≥ 该尺码已完工数。
 * 现有完工/出运事实只记录到"条目 / 尺码"，没有按颜色记录，所以颜色维度无法单独设下限（如实说明，不臆造）。
 * 低于生产分配总量只提示"需同步调整生产分配"，不阻止；不自动改采购或生产数据。 */
import {MistCommandError,mistOrderOwnerIds,type MistContext,type MistOrder,type MistState} from './mistWorkspace';
import {breakdownSizeTotals,type OrderLineBreakdown} from './mistOrderBreakdown';

type ChangeLine={id:string;name:string;style:string;qty:number;unit:string;breakdown?:OrderLineBreakdown};
export type OrderChangeImpactLine={
 lineId:string;label:string;unit:string;before:number|null;after:number|null;removed:boolean;added:boolean;
 completed:number;shipped:number;allocated:number;floor:number;sizeCompleted:Array<{size:string;quantity:number}>;
 warning:string;
 purchases:Array<{id:string;code:string;state:string;quantity:number;unit:string;supplier:string}>;
 productions:Array<{id:string;code:string;factory:string;qty:number;col:string;completed:number}>;
 shipments:Array<{id:string;code:string;state:string;quantity:number}>;
};
export type OrderChangeImpact={lines:OrderChangeImpactLine[];invoices:Array<{id:string;code:string;amount:number;open:number;currency:string;voided:boolean}>;receipts:number;hasFacts:boolean};

const r4=(v:number)=>Math.round(v*10000)/10000;
const sum=(values:number[])=>r4(values.reduce((s,v)=>s+(Number.isFinite(v)?v:0),0));
function fail(message:string,code='VALIDATION'):never{throw new MistCommandError(code,message,422);}

/** 条目当前的履约事实（与订单是否在变更无关）。 */
export function orderLineFacts(root:MistState,lineId:string){
 const f=root.fulfillment,jobs=root.productions.filter(job=>job.lineId===lineId);
 const facts=jobs.map(job=>({job,completion:(f?.productionFacts||[]).find(fact=>fact.productionId===job.id)?.completion}));
 const completed=sum(facts.map(x=>x.completion?.quantity||0));
 const sizeMap=new Map<string,number>();for(const x of facts)for(const s of x.completion?.sizeQuantities||[])sizeMap.set(s.size,r4((sizeMap.get(s.size)||0)+s.quantity));
 const shipments=(f?.shipments||[]).filter(s=>s.state!=='cancelled'&&s.lines.some(l=>l.lineId===lineId)).map(s=>({id:s.id,code:s.code,state:s.state,quantity:sum(s.lines.filter(l=>l.lineId===lineId).map(l=>l.quantity))}));
 const shipped=sum(shipments.map(s=>s.quantity));
 const purchases=(f?.purchases||[]).filter(p=>p.lineId===lineId&&p.state!=='cancelled').map(p=>({id:p.id,code:p.code,state:p.state,quantity:p.quantity,unit:p.unit,supplier:p.supplier}));
 const productions=facts.map(x=>({id:x.job.id,code:x.job.code,factory:x.job.factory,qty:x.job.qty,col:x.job.col,completed:x.completion?.quantity||0}));
 return {completed,shipped,allocated:sum(jobs.map(job=>job.qty)),floor:Math.max(completed,shipped),sizeCompleted:[...sizeMap].map(([size,quantity])=>({size,quantity})).filter(s=>s.quantity>0),purchases,productions,shipments};
}

export function orderChangeImpact(root:MistState,order:Pick<MistOrder,'id'>,proposed:ChangeLine[]):OrderChangeImpact{
 const current=root.orderLines.filter(l=>l.orderId===order.id),ids=new Set([...current.map(l=>l.id),...proposed.map(l=>l.id)]);
 const lines=[...ids].map(id=>{const before=current.find(l=>l.id===id),after=proposed.find(l=>l.id===id),facts=orderLineFacts(root,id),ref=after||before!;
  const afterQty=after?after.qty:null,warning=afterQty!==null&&facts.allocated>0&&afterQty<facts.allocated?`新数量低于生产分配总量 ${r4(facts.allocated)} ${ref.unit}，需同步调整生产分配`:'';
  return {lineId:id,label:`${ref.style} · ${ref.name}`,unit:ref.unit,before:before?before.qty:null,after:afterQty,removed:!after,added:!before,...facts,warning};});
 const invoices=root.invoices.filter(i=>i.orderId===order.id).map(i=>({id:i.id,code:i.code,amount:i.amount,open:i.open,currency:i.currency,voided:!!i.voidedAt}));
 const live=new Set(invoices.filter(i=>!i.voided).map(i=>i.id)),receipts=root.allocations.filter(a=>live.has(a.invoiceId)).length;
 return {lines,invoices,receipts,hasFacts:lines.some(l=>l.purchases.length||l.productions.length||l.shipments.length)||invoices.length>0};
}

/** 保存变更草稿、提交审批、审批通过时都调用：期间可能又完工或出运，所以每次都用最新事实重核。 */
export function assertOrderChangeAllowed(root:MistState,order:Pick<MistOrder,'id'|'currency'>,proposed:ChangeLine[],nextCurrency:string){
 const impact=orderChangeImpact(root,order,proposed);
 if(nextCurrency!==order.currency){const open=impact.invoices.filter(i=>!i.voided);if(open.length||impact.receipts)fail(`已有发票${open.length?`（${open.map(i=>i.code).join('、')}）`:''}${impact.receipts?'或收款核销':''}，不能变更币种；如需更换币种请先作废发票并撤销核销`,'PRECONDITION');}
 for(const line of impact.lines){
  if(line.removed){const facts=[line.purchases.length&&'采购 '+line.purchases.map(p=>p.code).join('、'),line.productions.length&&'生产 '+line.productions.map(p=>p.code).join('、'),line.shipments.length&&'出运 '+line.shipments.map(s=>s.code).join('、')].filter(Boolean);if(facts.length)fail(`条目「${line.label}」已有${facts.join('；')}，不能删除，只能减量`,'PRECONDITION');continue;}
  const next=proposed.find(l=>l.id===line.lineId),prior=root.orderLines.find(l=>l.id===line.lineId&&l.orderId===order.id) as (ChangeLine&{orderId:string})|undefined;
  // 数量与分色分码都没动的条目不重核下限（避免历史溢装让交期等无关修改也被卡住）
  if(prior&&next&&prior.qty===next.qty&&JSON.stringify(prior.breakdown||null)===JSON.stringify(next.breakdown||null))continue;
  if(line.after!==null&&line.after<line.floor)fail(`条目「${line.label}」新数量 ${line.after} ${line.unit} 低于下限 ${line.floor} ${line.unit}（已完工 ${line.completed}、已排出运 ${line.shipped}）`);
  if(next?.breakdown?.kind==='garment'&&line.sizeCompleted.length){const totals=breakdownSizeTotals(next.breakdown);for(const done of line.sizeCompleted){const planned=totals.find(t=>t.size.toLowerCase()===done.size.toLowerCase())?.quantity??0;if(planned<done.quantity)fail(`条目「${line.label}」${done.size} 码各色合计 ${planned} 低于已完工 ${done.quantity}`);}}
 }
 return impact;
}

/** 变更审批通过后：对受影响的采购单、生产分支各生成一条核对待办（不改采购或生产数据）。 */
export function createOrderChangeTasks(root:MistState,context:MistContext,order:Pick<MistOrder,'id'|'code'|'due'>,before:ChangeLine[],after:ChangeLine[]){
 const changed=after.filter(line=>{const prior=before.find(l=>l.id===line.id);return prior&&(prior.qty!==line.qty||JSON.stringify(prior.breakdown||null)!==JSON.stringify(line.breakdown||null));});
 let created=0;
 for(const line of changed){const facts=orderLineFacts(root,line.id),prior=before.find(l=>l.id===line.id)!,what=`${prior.qty} → ${line.qty} ${line.unit}`;
  for(const p of facts.purchases){const kind=`order-change-review:${order.id}:purchase:${p.id}`;root.tasks=root.tasks.filter(t=>!(t.kind===kind&&!t.done));root.tasks.unshift({id:context.id(),title:`订单 ${order.code} 数量已变更，请核对采购 ${p.code}（${line.style} ${what}）`,due:order.due,done:false,kind,target:{view:'procurement',id:p.id,orderLineId:line.id},assigneeIds:mistOrderOwnerIds(root,order.id)});created++;}
  for(const job of facts.productions){const kind=`order-change-review:${order.id}:production:${job.id}`;root.tasks=root.tasks.filter(t=>!(t.kind===kind&&!t.done));root.tasks.unshift({id:context.id(),title:`订单 ${order.code} 数量已变更，请核对生产 ${job.code}（${line.style} ${what}）`,due:order.due,done:false,kind,target:{view:'production-board',productionId:job.id,orderLineId:line.id},assigneeIds:mistOrderOwnerIds(root,order.id)});created++;}
 }
 return created;
}

const STATE:Record<string,string>={draft:'草稿',pending:'待审批',approved:'已批准',rejected:'已退回',cancelled:'已取消',preparing:'准备中',ready:'待出运',departed:'已离港',cut:'开裁',sew:'车缝',finish:'后整',qc:'检验',done:'完成'};
export const impactStateLabel=(state:string)=>STATE[state]||state;
/** 审批页用的文字版影响清单（审批详情只支持文字）。 */
export function orderChangeImpactDetails(impact:OrderChangeImpact):Array<{label:string;value:string}>{
 const rows=impact.lines.filter(l=>l.purchases.length||l.productions.length||l.shipments.length).map(l=>({label:'影响清单 · '+l.label,value:[
  l.purchases.length&&'采购 '+l.purchases.map(p=>`${p.code}（${impactStateLabel(p.state)}，${p.quantity} ${p.unit}）`).join('、'),
  l.productions.length&&'生产 '+l.productions.map(p=>`${p.code}（${p.factory}，${impactStateLabel(p.col)}，分配 ${p.qty}，已完工 ${p.completed}）`).join('、'),
  l.shipments.length&&'出运 '+l.shipments.map(s=>`${s.code}（${impactStateLabel(s.state)}，${s.quantity} ${l.unit}）`).join('、'),
  `下限 ${l.floor} ${l.unit}`,l.warning].filter(Boolean).join('；')}));
 if(impact.invoices.length)rows.push({label:'影响清单 · 发票',value:impact.invoices.map(i=>`${i.code}（${i.voided?'已作废':'有效'}，${i.amount} ${i.currency}，未收 ${i.open}）`).join('、')});
 return rows;
}
