/** BB-ORD-5：溢短装比例与条目"按实际结案"。
 * 比例是合同商业条款（溢装上限 % / 短装下限 %，0–10），批准后修改走变更审批；未填按 0，显示"未约定，按足量"。
 * 结案数量 = 已离港数量；须无未离港的有效出运；在允许范围内业务员直接结案，超出范围生成审批（审批人=订单审批人配置，申请人不能自批）。
 * 财务应收不在此自动变更。 */
import {MistCommandError,type MistOrder,type MistOrderLine,type MistState} from './mistWorkspace';

export type OrderTolerance={overPercent?:number|null;shortPercent?:number|null};
export type OrderLineClosure={id:string;status:'pending'|'closed'|'rejected';quantity:number;ordered:number;min:number;max:number;reason:string;requesterId:string;requesterName:string;requestedAt:string;reviewerIds:string[];decidedBy?:string;decidedName?:string;decidedAt?:string;note?:string};
/** BB-ORD-6：超量出运申请。quantity 为批准后该条目累计可出（含已排出运）的上限。 */
export type OverShipRequest={id:string;status:'pending'|'approved'|'rejected';quantity:number;ordered:number;max:number;excess:number;reason:string;requesterId:string;requesterName:string;requestedAt:string;reviewerIds:string[];decidedBy?:string;decidedName?:string;decidedAt?:string;note?:string};
export type ClosableLine=MistOrderLine&{closure?:OrderLineClosure;overShips?:OverShipRequest[]};
export const TOLERANCE_NONE='未约定，按足量';
export const CLOSE_SETTLEMENT_HINT='请到发票/收款核对结算金额';

const r4=(v:number)=>Math.round(v*10000)/10000;
const sum=(values:number[])=>r4(values.reduce((s,v)=>s+v,0));
function fail(message:string,code='VALIDATION'):never{throw new MistCommandError(code,message,code==='FORBIDDEN'?403:422);}

export function normalizeTolerancePercent(value:unknown,label:string):number|null{
 if(value===undefined||value===null||value==='')return null;const v=Number(value);
 if(!Number.isFinite(v)||v<0||v>10)fail(label+'须为 0 至 10 之间的百分数');return r4(v);
}
export function toleranceOf(contract:OrderTolerance|undefined|null){const over=contract?.overPercent??null,short=contract?.shortPercent??null;return{over:over??0,short:short??0,agreed:over!==null||short!==null};}
export function toleranceText(contract:OrderTolerance|undefined|null){const t=toleranceOf(contract);return t.agreed?`溢装 +${t.over}% / 短装 −${t.short}%`:TOLERANCE_NONE;}
export function toleranceRange(qty:number,contract:OrderTolerance|undefined|null){const t=toleranceOf(contract);return{min:r4(qty*(1-t.short/100)),max:r4(qty*(1+t.over/100))};}

/** 条目出运事实：已排（非取消，含已离港）、已离港、未离港有效出运。 */
export function lineShipmentFacts(root:MistState,lineId:string){
 const live=(root.fulfillment?.shipments||[]).filter(s=>s.state!=='cancelled'&&s.lines.some(l=>l.lineId===lineId));
 const qty=(s:typeof live[number])=>sum(s.lines.filter(l=>l.lineId===lineId).map(l=>l.quantity));
 const open=live.filter(s=>s.state!=='departed');
 return{planned:sum(live.map(qty)),departed:sum(live.filter(s=>s.state==='departed').map(qty)),open:open.map(s=>({id:s.id,code:s.code,quantity:qty(s)}))};
}
/** "分批与尾数"展示：允许范围、已排、已离港、剩余待出、是否在范围内（已排未离港也预判）。 */
export function lineToleranceStatus(root:MistState,order:Pick<MistOrder,'id'>&{governance?:{contract?:OrderTolerance}},line:MistOrderLine){
 const contract=order.governance?.contract,range=toleranceRange(line.qty,contract),facts=lineShipmentFacts(root,line.id);
 const verdict=facts.planned>range.max?'over':facts.planned<range.min?'short':'within';
 return{...range,...facts,agreed:toleranceOf(contract).agreed,text:toleranceText(contract),remaining:r4(Math.max(0,line.qty-facts.planned)),verdict:verdict as 'over'|'short'|'within',closure:(line as ClosableLine).closure};
}
export function closureLabel(c:OrderLineClosure|undefined){if(!c)return '';return c.status==='closed'?`已结案（实际 ${c.quantity} / 订单 ${c.ordered}，${c.reason}）`:c.status==='pending'?`结案待审批（实际 ${c.quantity} / 订单 ${c.ordered}，${c.reason}）`:`结案申请已退回（${c.note||c.reason}）`;}
export function isLineClosed(line:MistOrderLine|undefined){return (line as ClosableLine|undefined)?.closure?.status==='closed';}
/** 出运侧调用：已结案或结案待审批的条目不能再建出运。 */
export function assertOrderLineOpen(line:MistOrderLine){const c=(line as ClosableLine).closure;if(c?.status==='closed')fail(`条目「${line.style} · ${line.name}」已结案，不能再建出运`,'PRECONDITION');if(c?.status==='pending')fail(`条目「${line.style} · ${line.name}」结案审批中，不能再建出运`,'PRECONDITION');}
/** 订单履约完成：所有条目已出足（离港 ≥ 订单数量）或已结案。 */
export function orderLinesComplete(root:MistState,lines:MistOrderLine[]){return lines.length>0&&lines.every(line=>isLineClosed(line)||lineShipmentFacts(root,line.id).departed>=line.qty);}

/* ── BB-ORD-6：出运超出溢装上限须经理审批 ── */
export const OVER_SHIP_REQUIRED='超出允许溢装，须经理审批';
export const SHORT_SHIP_HINT='本条目预计短装';
/** 已批准的超量额度（取最大批准数量）；没有则为 0。 */
export function approvedOverShip(line:MistOrderLine|undefined){return Math.max(0,...((line as ClosableLine|undefined)?.overShips||[]).filter(r=>r.status==='approved').map(r=>r.quantity));}
export function pendingOverShip(line:MistOrderLine|undefined){return ((line as ClosableLine|undefined)?.overShips||[]).find(r=>r.status==='pending');}
/** 条目累计可出上限 = max(溢装上限, 已批准超量数量)。 */
export function lineShipLimit(line:MistOrderLine,contract:OrderTolerance|undefined|null){const range=toleranceRange(line.qty,contract);return{...range,approved:approvedOverShip(line),limit:Math.max(range.max,approvedOverShip(line))};}
/** 出运保存预判（前后端共用）：cumulative = 本票 + 其他未取消出运。超出上限 → over；低于短装下限 → short（不拦截，仅提示）。 */
export function shipmentToleranceCheck(line:MistOrderLine,contract:OrderTolerance|undefined|null,cumulative:number){const l=lineShipLimit(line,contract),total=r4(cumulative);return{...l,cumulative:total,excess:r4(Math.max(0,total-l.limit)),verdict:(total>l.limit?'over':total<l.min?'short':'within') as 'over'|'short'|'within'};}
export function assertShipmentWithinTolerance(line:MistOrderLine,contract:OrderTolerance|undefined|null,cumulative:number){const c=shipmentToleranceCheck(line,contract,cumulative);if(c.verdict==='over')fail(`${OVER_SHIP_REQUIRED}：条目「${line.style} · ${line.name}」累计出运 ${c.cumulative}，${c.approved>c.max?`已批准上限 ${c.limit}`:`溢装上限 ${c.max}`}，超出 ${c.excess} ${line.unit}`,'PRECONDITION');return c;}
export function overShipLabel(r:OverShipRequest){const s=r.status==='approved'?'已批准':r.status==='pending'?'待审批':'已退回';return `${s}：累计可出 ${r.quantity}（溢装上限 ${r.max}，超出 ${r.excess}），${r.reason}${r.note?`；审批意见：${r.note}`:''}`;}
