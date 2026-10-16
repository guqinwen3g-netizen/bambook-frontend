/** Formal order approval and proposed commercial changes, independent of the Mist view layer. */
import {MistCommandError,lineAmount,mistMoneyMinor,type MistContext,type MistState,type MistOrder,type MistOrderLine,type MistCommandResult} from './mistWorkspace';
import type {MistReviewTask} from './mistReview';
import {assertOrderLineSource,normalizeOrderLineSource} from './mistOrderSource';
import {breakdownSummary,lineQuantityFromBreakdown,type OrderLineBreakdown} from './mistOrderBreakdown';

export type OrderGovernanceInput={
 kind:'external'|'internal';poNumber:string;confirmationFileIds:string[];internalPurpose:string;receiver:string;
 paymentMethod:'TT'|'LC'|'OA'|'OTHER';depositPercent:number|null;paymentNote:string;incoterm:string;deliveryPlace:string;
};
export type OrderGovernanceLine=Pick<MistOrderLine,'id'|'name'|'style'|'img'|'qty'|'unit'|'price'> & {sourceProductId?:string;sourceDevId?:string;sourceVersionId?:string;breakdown?:OrderLineBreakdown};
export type OrderGovernanceSnapshot={orderId:string;code:string;type:MistOrder['type'];customerId:string;customer:string;season:string;currency:string;due:string;contract:OrderGovernanceInput;lines:OrderGovernanceLine[]};
export type OrderGovernanceRound={id:string;kind:'initial'|'change';status:'pending'|'approved'|'rejected';requesterId:string;reviewerIds:string[];submittedAt:string;snapshot:OrderGovernanceSnapshot;reason:string;decidedBy?:string;decidedName?:string;decidedAt?:string;note?:string};
export type OrderGovernanceProposal={contract:OrderGovernanceInput;orderPatch:{season:string;currency:string;due:string};lines:OrderGovernanceLine[];reason:string;status:'draft'|'pending'|'rejected'};
export type OrderGovernanceFields={contract:OrderGovernanceInput;status:'draft'|'pending'|'approved'|'rejected';rounds:OrderGovernanceRound[];effectiveVersion:number;approvedAt?:string;approvedBy?:string;approvedSnapshot?:OrderGovernanceSnapshot;changeDraft?:OrderGovernanceProposal};
export type OrderGovernanceCommand=
 |{type:'order.governance.saveDraft';payload:{orderId:string;input:OrderGovernanceInput;orderPatch?:Partial<Pick<MistOrder,'season'|'currency'|'due'|'owner'>>;lines?:OrderGovernanceLine[];reason?:string}}
 |{type:'order.governance.submit';payload:{orderId:string}}
 |{type:'order.governance.decide';payload:{id:string;decision:'approved'|'rejected';note:string}}
 |{type:'order.governance.discardChange';payload:{orderId:string}};
type GovernedOrder=MistOrder&{governance?:OrderGovernanceFields};
function fail(message:string,code='VALIDATION'):never{throw new MistCommandError(code,message,code==='FORBIDDEN'?403:422);}
function text(v:unknown,label:string,required=false,max=4000){if(typeof v!=='string'||v.length>max||required&&!v.trim())return fail(label+'未填写或格式无效');return v.trim();}
function date(v:unknown){const s=text(v,'交期',true);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)return fail('交期格式无效');return s;}
function currency(v:unknown){const s=text(v,'币种',true).toUpperCase();return /^[A-Z]{3}$/.test(s)?s:fail('币种须为三位代码');}
function normalize(input:Partial<OrderGovernanceInput>|undefined):OrderGovernanceInput{
 const i=input||{};if(i.kind!==undefined&&!['external','internal'].includes(i.kind))fail('订单用途无效');if(i.paymentMethod!==undefined&&!['TT','LC','OA','OTHER'].includes(i.paymentMethod))fail('付款方式无效');
 if(i.depositPercent!==undefined&&i.depositPercent!==null&&(typeof i.depositPercent!=='number'||!Number.isFinite(i.depositPercent)||i.depositPercent<0||i.depositPercent>100))fail('定金比例须为0至100之间的百分数');
 if(i.confirmationFileIds!==undefined&&(!Array.isArray(i.confirmationFileIds)||i.confirmationFileIds.length>100))fail('合同附件格式无效');
 return{kind:i.kind||'external',poNumber:text(i.poNumber||'','PO/合同号'),confirmationFileIds:[...new Set((i.confirmationFileIds||[]).map(id=>text(id,'附件ID',true,200)))],internalPurpose:text(i.internalPurpose||'','内部用途'),receiver:text(i.receiver||'','接收团队或负责人'),paymentMethod:i.paymentMethod||'TT',depositPercent:i.depositPercent??null,paymentNote:text(i.paymentNote||'','付款条款'),incoterm:text(i.incoterm||'','贸易术语'),deliveryPlace:text(i.deliveryPlace||'','指定地点')};
}
export function createOrderGovernance(_context:MistContext,input?:Partial<OrderGovernanceInput>):OrderGovernanceFields{return{contract:normalize(input),status:'draft',rounds:[],effectiveVersion:0};}
export function orderGovernancePermission(command:OrderGovernanceCommand){if(!['order.governance.saveDraft','order.governance.submit','order.governance.decide','order.governance.discardChange'].includes(command.type))fail('未知订单治理操作');return 'orders:write';}
function getOrder(root:MistState,id:string):GovernedOrder{return root.orders.find(o=>o.id===id)||fail('订单不存在','NOT_FOUND');}
function governance(order:GovernedOrder):OrderGovernanceFields{return order.governance||fail('订单合同与审批资料尚未初始化','PRECONDITION');}
function idsExist(root:MistState,input:OrderGovernanceInput){input.confirmationFileIds.forEach(id=>{if(!root.files.some(f=>f.id===id))fail('合同确认附件不属于当前工作区');});}
function snapshotLine(line:MistOrderLine):OrderGovernanceLine{const r=line as MistOrderLine&OrderGovernanceLine;return{id:r.id,name:r.name,style:r.style,img:r.img,qty:r.qty,unit:r.unit,price:r.price,...(r.sourceProductId?{sourceProductId:r.sourceProductId}:{}),...(r.sourceDevId?{sourceDevId:r.sourceDevId}:{}),...(r.sourceVersionId?{sourceVersionId:r.sourceVersionId}:{}),...(r.breakdown?{breakdown:structuredClone(r.breakdown)}:{})};}
function validateLines(root:MistState,order:GovernedOrder,lines:OrderGovernanceLine[]){
 if(!Array.isArray(lines)||!lines.length||lines.length>200)fail('至少需要一个订单条目');const seen=new Set<string>();
 return lines.map(input=>{const id=text(input.id,'条目ID',true,200);const {breakdown:_raw,...plain}=input,fromBreakdown=lineQuantityFromBreakdown(order.type,input,`条目「${typeof input.name==='string'?input.name:id}」`),line:OrderGovernanceLine=fromBreakdown.breakdown?{...plain,qty:fromBreakdown.qty!,breakdown:fromBreakdown.breakdown}:plain;if(seen.has(id))fail('条目ID重复');seen.add(id);const existing=root.orderLines.find(l=>l.id===id);if(existing&&existing.orderId!==order.id)fail('条目不属于当前订单');if(!Number.isFinite(line.qty)||line.qty<=0)fail('条目数量须为正数');if(!Number.isFinite(line.price)||line.price<0)fail('条目单价无效');lineAmount(line.qty,line.price);return{...line,id,name:text(line.name,'品名',true),style:text(line.style,'款号',true),unit:text(line.unit,'单位',true,40)};});
}
/** BB-ORD-2：保存草稿时校验新写入或改动过的来源；未改动的历史来源原样保留（历史订单只读兼容）。 */
function checkLineSources(root:MistState,order:GovernedOrder,lines:OrderGovernanceLine[],internal:boolean){
 const key=(v:{sourceDevId?:string;sourceVersionId?:string;sourceProductId?:string})=>JSON.stringify(normalizeOrderLineSource(v));
 return lines.map(line=>{const {sourceDevId,sourceVersionId,sourceProductId,...rest}=line,source=normalizeOrderLineSource({sourceDevId,sourceVersionId,sourceProductId}),existing=root.orderLines.find(l=>l.id===line.id&&l.orderId===order.id) as (MistOrderLine&OrderGovernanceLine)|undefined;
  if(!existing||key(existing)!==key(source))assertOrderLineSource(root,{type:order.type,customerId:order.customerId,internal},source,line.name);
  return {...rest,...source};});
}
function snapshot(root:MistState,order:GovernedOrder,proposal?:OrderGovernanceProposal):OrderGovernanceSnapshot{return{orderId:order.id,code:order.code,type:order.type,customerId:order.customerId,customer:order.customer,season:proposal?.orderPatch.season??order.season,currency:proposal?.orderPatch.currency??order.currency,due:proposal?.orderPatch.due??order.due,contract:structuredClone(proposal?.contract||governance(order).contract),lines:structuredClone(proposal?.lines||root.orderLines.filter(l=>l.orderId===order.id).map(snapshotLine))};}
/** The customer id is contractual identity; its display name remains frozen only for historical presentation. */
function sameCommercialSnapshot(a:OrderGovernanceSnapshot,b:OrderGovernanceSnapshot){return JSON.stringify({...a,customer:undefined})===JSON.stringify({...b,customer:undefined});}
function validateSubmission(root:MistState,s:OrderGovernanceSnapshot){
 idsExist(root,s.contract);if(!s.lines.length)fail('至少需要一个条目');date(s.due);currency(s.currency);
 if(s.contract.kind==='external'){if(!s.customerId||!root.customers.some(c=>c.id===s.customerId))fail('请选择实际客户');if(!s.contract.poNumber)fail('请填写PO或合同号');if(!s.contract.confirmationFileIds.length)fail('外部订单须上传客户书面确认依据');if(!s.contract.incoterm||!s.contract.deliveryPlace)fail('请记录合同贸易术语和指定地点');}
 else if(!s.contract.internalPurpose||!s.contract.receiver)fail('内部订单须记录用途、接收团队和负责人');
 if(!s.contract.paymentNote)fail('请记录实际付款条款');
 if(s.contract.paymentMethod==='LC')fail('信用证条款与原件核验尚未接入，本次不能将其标为已核验','PRECONDITION');
}
function reviewers(context:MistContext,type:MistOrder['type']){const authority=context.authority as (MistContext['authority']&{orderReviewerIds?:Record<'garment'|'fabric',string[]>})|undefined;return [...new Set((authority?.orderReviewerIds?.[type]||[]).filter(id=>typeof id==='string'&&id.trim()))];}
function applySnapshot(root:MistState,order:GovernedOrder,s:OrderGovernanceSnapshot){
 const prior=root.orderLines.filter(l=>l.orderId===order.id);root.orderLines=root.orderLines.filter(l=>l.orderId!==order.id).concat(s.lines.map(l=>{const next={...prior.find(p=>p.id===l.id),...l,orderId:order.id,made:prior.find(p=>p.id===l.id)?.made||0,qc:prior.find(p=>p.id===l.id)?.qc||0} as MistOrderLine&OrderGovernanceLine;if(!l.breakdown)delete next.breakdown;return next;}));
 order.season=s.season;order.currency=s.currency;order.due=s.due;order.lines=s.lines.length;order.qty=s.lines.reduce((sum,l)=>sum+l.qty,0);order.amount=s.lines.reduce((sum,l)=>sum+mistMoneyMinor(lineAmount(l.qty,l.price)),0)/100;
}
function event(root:MistState,c:MistContext,order:GovernedOrder,message:string){root.events.unshift({id:c.id(),entityType:'order',entityId:order.id,actor:c.actorName,at:c.now,text:message,fileIds:[]});}
export function assertOrderApproved(root:MistState,orderId:string){const order=getOrder(root,orderId);if(order.governance?.status!=='approved'||!order.governance.approvedSnapshot)fail('订单主单尚未批准，不能进入采购或履约','PRECONDITION');if(!sameCommercialSnapshot(snapshot(root,order),order.governance.approvedSnapshot))fail('订单生效内容与批准快照不一致，不能进入履约','PRECONDITION');return order;}
export function getOrderGovernanceReviews(root:MistState):MistReviewTask[]{return root.orders.flatMap(source=>{const order=source as GovernedOrder;return(order.governance?.rounds||[]).map(round=>({id:'order:'+round.id,kind:'order' as const,entityId:order.id,title:order.code+(round.kind==='change'?' 订单变更审批':' 订单主单审批'),requesterId:round.requesterId,reviewerIds:round.reviewerIds,status:round.status,submittedAt:round.submittedAt,requiredPermission:'orders:write',target:{view:'orders/detail',id:order.id},fileIds:round.snapshot.contract.confirmationFileIds,details:[{label:'订单用途',value:round.snapshot.contract.kind==='internal'?'内部用途订单':'外部客户订单'},{label:'客户/接收方',value:round.snapshot.contract.kind==='internal'?round.snapshot.contract.receiver:round.snapshot.customer},{label:'合同',value:round.snapshot.contract.kind==='internal'?round.snapshot.contract.internalPurpose:round.snapshot.contract.poNumber},{label:'付款',value:round.snapshot.contract.paymentMethod+' · '+round.snapshot.contract.paymentNote},{label:'交期',value:round.snapshot.due},{label:'贸易条件',value:round.snapshot.contract.incoterm+' '+round.snapshot.contract.deliveryPlace},...(round.reason?[{label:'变更原因',value:round.reason}]:[]),...round.snapshot.lines.map(l=>({label:l.style+' · '+l.name,value:`${l.qty} ${l.unit} × ${l.price} ${round.snapshot.currency}`+(l.breakdown?`；${breakdownSummary(l.breakdown,l.unit)}`:'')}))]}));});}
export function applyOrderGovernanceCommand(root:MistState,command:OrderGovernanceCommand,context:MistContext):MistCommandResult{
 const id=command.type==='order.governance.decide'?command.payload.id:command.payload.orderId,order=getOrder(root,id);if(!order.governance&&command.type==='order.governance.saveDraft')order.governance=createOrderGovernance(context);const g=governance(order);orderGovernancePermission(command);
 if(command.type==='order.governance.saveDraft'){
  if(g.status==='pending'||g.changeDraft?.status==='pending')fail('审批中订单内容已锁定');const p=command.payload,contract=normalize(p.input);idsExist(root,contract);
  const orderPatch={season:p.orderPatch?.season===undefined?order.season:text(p.orderPatch.season,'季节'),currency:p.orderPatch?.currency===undefined?order.currency:currency(p.orderPatch.currency),due:p.orderPatch?.due===undefined?order.due:date(p.orderPatch.due)};
  const lines=checkLineSources(root,order,validateLines(root,order,p.lines||root.orderLines.filter(l=>l.orderId===id).map(snapshotLine)),contract.kind==='internal');
  if(g.status==='approved'){
   const reason=text(p.reason||'','变更原因',true);const changedLines=JSON.stringify(lines)!==JSON.stringify(root.orderLines.filter(l=>l.orderId===id).map(snapshotLine));
   if((changedLines||orderPatch.currency!==order.currency)&&(root.productions.some(x=>x.orderId===id)||root.invoices.some(x=>x.orderId===id)||(root.fulfillment?.shipments||[]).some(s=>s.lines.some(l=>l.orderId===id))))fail('已有履约或票据事实，条目与币种变更须先处理影响范围','PRECONDITION');
   g.changeDraft={contract,orderPatch,lines,reason,status:'draft'};event(root,context,order,'保存订单变更草稿，原批准内容继续生效');
  }else{g.contract=contract;g.status='draft';applySnapshot(root,order,{...snapshot(root,order),...orderPatch,contract,lines});order.state='订单草稿';order.tone='neutral';event(root,context,order,'保存订单合同草稿');}
  if(p.orderPatch?.owner!==undefined)order.owner=text(p.orderPatch.owner,'负责人',true);order.updatedAt=context.now;return{id,orderId:id};
 }
 if(command.type==='order.governance.discardChange'){if(g.changeDraft?.status==='pending')fail('审批中的变更不能直接删除');delete g.changeDraft;event(root,context,order,'放弃尚未生效的变更草稿');return{id,orderId:id};}
 if(command.type==='order.governance.submit'){
  if(g.status==='pending'||g.changeDraft?.status==='pending')fail('订单已有待处理审批');if(g.status==='rejected'||g.changeDraft?.status==='rejected')fail('请先修订退回内容并保存草稿，再重新提交');if(g.status==='approved'&&!g.changeDraft)fail('订单已批准，请先建立变更草稿');
  const proposal=g.status==='approved'?g.changeDraft:undefined,s=snapshot(root,order,proposal);validateSubmission(root,s);
  // BB-ORD-2：主单提交审批时再核一次全部条目来源仍有效（版本未撤销认可 / 未归档，产品档案仍有效）
  if(!proposal)for(const line of s.lines)assertOrderLineSource(root,{type:order.type,customerId:order.customerId,internal:s.contract.kind==='internal'},line,line.name);const eligible=reviewers(context,order.type);if(!context.actorId||!eligible.length)fail('尚未配置当前业务域的有效订单审批负责人','PRECONDITION');
  const round:OrderGovernanceRound={id:context.id(),kind:proposal?'change':'initial',status:'pending',requesterId:context.actorId,reviewerIds:eligible,submittedAt:context.now,snapshot:s,reason:proposal?.reason||''};g.rounds.push(round);if(proposal)proposal.status='pending';else{g.status='pending';order.state='待主单审批';order.tone='warn';}
  root.tasks.unshift({id:context.id(),title:'跟进订单主单审批 '+order.code,due:order.due,done:false,kind:'order-approval',target:{view:'orders/detail',id}});event(root,context,order,proposal?'提交订单变更审批':'提交订单主单审批');order.updatedAt=context.now;return{id,orderId:id,reviewId:'order:'+round.id};
 }
 if(command.type!=='order.governance.decide')fail('未知订单治理操作');
 const round=[...g.rounds].reverse().find(r=>r.status==='pending');if(!round)fail('没有待决定的订单审批');
 if(!context.actorId||!round!.reviewerIds.includes(context.actorId)||!reviewers(context,order.type).includes(context.actorId))fail('当前账号不在本次及当前有效审批名单','FORBIDDEN');
 const p=command.payload;if(!['approved','rejected'].includes(p.decision))fail('审批决定无效');const note=text(p.note,'审批意见',true);
 if(!sameCommercialSnapshot(snapshot(root,order,round!.kind==='change'?g.changeDraft:undefined),round!.snapshot))fail('订单内容与提交快照不一致，请重新提交','CONFLICT');
 if(p.decision==='approved'){validateSubmission(root,round!.snapshot);applySnapshot(root,order,round!.snapshot);g.contract=structuredClone(round!.snapshot.contract);g.status='approved';g.effectiveVersion++;g.approvedAt=context.now;g.approvedBy=context.actorId;g.approvedSnapshot=structuredClone(round!.snapshot);delete g.changeDraft;order.state='已批准待履约';order.tone='ok';}
 else if(round!.kind==='change'){if(g.changeDraft)g.changeDraft.status='rejected';}else{g.status='rejected';order.state='主单已退回';order.tone='bad';}
 round!.status=p.decision;round!.decidedBy=context.actorId;round!.decidedName=context.actorName;round!.decidedAt=context.now;round!.note=note;root.tasks.filter(t=>t.kind==='order-approval'&&t.target.id===id).forEach(t=>t.done=true);event(root,context,order,'订单审批'+(p.decision==='approved'?'通过':'退回')+'：'+note);root.notifications.unshift({id:context.id(),title:order.code+' 主单审批'+(p.decision==='approved'?'通过':'退回'),detail:note,at:context.now,readAt:null,target:{view:'orders/detail',id}});order.updatedAt=context.now;return{id,orderId:id};
}
