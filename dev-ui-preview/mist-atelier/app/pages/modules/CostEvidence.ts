/** Evidence projections, not accounting recognition or a new profit formula. */
import {isRecognizedMistInvoice,lineAmount,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import {financeCurrencyTotals} from '../FinanceWorkspace';
export type CostEvidenceKind='reference'|'commitment'|'receivable'|'pricing'|'unassigned';
export type CostEvidence={id:string;sourceId:string;orderId:string;kind:CostEvidenceKind;code:string;description:string;currency:string;amount:number;unit:string;state:string;view:string;section?:string;reason:string};
export function costEvidenceRows(state:MistState|null):CostEvidence[]{
 if(!state)return [];
 return [
  ...state.platform.boms.map(r=>({id:'reference:'+r.id,sourceId:r.id,orderId:r.orderId,kind:'reference' as const,code:r.code,description:r.description,currency:r.currency,amount:r.total,unit:'参考单位成本（单位见依据）',state:r.state==='Confirmed'?'已确认参考':r.state==='Archived'?'已归档参考':'参考草稿',view:'bom',section:'reference',reason:'仅单位参考；不乘订单数量，不作为实际耗用。历史协议未冻结成品计价单位及准确订单行。'})),
  ...state.fulfillment.purchases.filter(r=>r.state==='approved').map(r=>({id:'commitment:'+r.id,sourceId:r.id,orderId:r.orderId,kind:'commitment' as const,code:r.code,description:r.description||r.supplier,currency:r.currency,amount:lineAmount(r.quantity,r.price),unit:'合同总额',state:'已批准承诺',view:'procurement',reason:'批准合同不是已发生或已付款成本；耗用、余料、结算及费用归属尚待核对。'})),
  ...state.invoices.filter(isRecognizedMistInvoice).map(r=>({id:'receivable:'+r.id,sourceId:r.id,orderId:r.orderId,kind:'receivable' as const,code:r.code,description:r.customer,currency:r.currency,amount:r.amount,unit:'原币票面',state:r.open>0?'未结应收':'已结应收',view:'invoices',reason:'票面及核销是应收事实，不等同经营收入确认；未将收款当利润。'})),
  ...state.platform.pricing.map(r=>({id:'pricing:'+r.id,sourceId:r.id,orderId:r.orderId,kind:'pricing' as const,code:r.id,description:r.basis,currency:'USD',amount:r.finalUnitPrice,unit:'试算单价（单位见依据）',state:'定价试算',view:'pricing',section:'snapshots',reason:'不是已对客报价或实际利润；不改写订单。'})),
  ...state.payments.map(r=>({id:'unassigned:'+r.id,sourceId:r.id,orderId:'',kind:'unassigned' as const,code:r.code,description:r.payee+' · '+r.ref,currency:r.currency,amount:r.amount,unit:'登记付款金额',state:'待归属核对',view:'payment-vouchers',section:'records',reason:'当前付款协议没有准确订单 / 应付 / 成本归属，不按收款方、附言或同名供应商猜配。'})),
 ];
}
export function costOrderEvidence(state:MistState|null){
 const sources=costEvidenceRows(state);
 return (state?.orders||[]).map(order=>{const evidence=sources.filter(r=>r.orderId===order.id);return {...order,evidence,commitments:financeCurrencyTotals(evidence.filter(r=>r.kind==='commitment').map(r=>({currency:r.currency,amount:r.amount}))),referenceCount:evidence.filter(r=>r.kind==='reference'&&r.state==='已确认参考').length,receivableCount:evidence.filter(r=>r.kind==='receivable').length};});
}
