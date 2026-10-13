import {beforeEach,describe,it,expect,vi} from 'vitest';
import {getConsolidatedProfitReport} from '../reportService';
import {readCurrentOrderCostReview,type OrderCostReviewCurrent} from '../../pricing/orderCostReviewService';
vi.mock('../../pricing/orderCostReviewService',async importOriginal=>({...await importOriginal<typeof import('../../pricing/orderCostReviewService')>(),readCurrentOrderCostReview:vi.fn()}));
const pending=(reason='ORDER_COST_REVIEW_MISSING'):OrderCostReviewCurrent=>({status:'pending',pendingReasons:[reason]});
// This is the independent current-fact boundary, not a JSON flag on an old sheet.
const completeReview=(orderId:string):OrderCostReviewCurrent=>({status:'complete',pendingReasons:[],reviewId:`review-${orderId}`,reviewRevision:1,sourceFingerprint:'a'.repeat(64),actualRevenueCny:200,actualCostCny:50,actualBreakdown:{procurement:50,companySupply:0,logistics:0,otherExpenses:0,bankFees:0,allowances:0},scopeSnapshot:{orderId,orderLineIds:[`${orderId}-line`],revenueInvoiceIds:[`${orderId}-invoice`],shipmentAllocationIds:[`${orderId}-shipment`],range:'whole_order_final'},confirmedBy:'synthetic-finance',confirmedAt:'1790812800000'});
beforeEach(()=>{ vi.mocked(readCurrentOrderCostReview).mockReset().mockImplementation(async(database:any,orderId)=>database._currentReviews?.[orderId]??pending()); });
const evidence=(status='complete')=>({version:2,calculatedAt:'2026-09-30',status,committedAmountCny:100,acceptedAmountCny:60,paidPrincipalCny:30,actualCostCny:status==='complete'?50:null,actualProfitCny:status==='complete'?150:null,reviewId:'persisted-review-a',reviewRevision:1,sourceFingerprint:'b'.repeat(64),actualRevenueCny:status==='complete'?200:null,actualBreakdown:status==='complete'?{procurement:50,companySupply:0,logistics:0,otherExpenses:0,bankFees:0,allowances:0}:null,pendingReasons:status==='complete'?[]:['missing_consumption']});
const sheet=(id:string,details?:unknown)=>({orderId:id,salesRevenue:200,purchaseCost:100,freightCost:0,miscCost:0,bankFeeCost:0,allowanceCost:0,grossProfit:100,details});
function db(sheets:any[],ids:string[],currentReviews:Record<string,OrderCostReviewCurrent>={}){return {orderProfitSheet:{findMany:async()=>sheets},order:{findMany:async()=>ids.map(id=>({id,deletedAt:null,businessLine:'garment'}))},orderInternalTransfer:{findMany:async()=>[]},_currentReviews:currentReviews} as any;}
describe('合并利润必须具有完整成本依据',()=>{
 it('pending、旧表与无表订单分别计数，不将未验证成本当零',async()=>{const r=await getConsolidatedProfitReport(db([sheet('a',{costEvidence:evidence()}),sheet('b',{costEvidence:evidence('pending')}),sheet('c')],['a','b','c','d'],{a:completeReview('a'),b:pending('FINAL_FEES_UNVERIFIED')}));expect(r.coverage).toEqual({status:'incomplete',coveredCount:1,pendingCount:1,unknownCount:2,totalCount:4});expect(r.consolidatedCost).toBeNull();expect(r.consolidatedProfit).toBeNull();expect(r.departments.garment.profit).toBeNull();expect(r.costBreakdown.externalPurchaseNetOfInternal).toBeNull();});
 it('完整证据使用真实成本而非采购投影',async()=>{const database=db([sheet('a',{costEvidence:evidence()})],['a'],{a:completeReview('a')});const r=await getConsolidatedProfitReport(database);expect(r.coverage?.status).toBe('complete');expect(r.consolidatedCost).toBe(50);expect(r.consolidatedProfit).toBe(150);expect(readCurrentOrderCostReview).toHaveBeenCalledWith(database,'a',undefined,undefined);});
 it('软删/孤儿利润表不进入全量报表',async()=>{const r=await getConsolidatedProfitReport(db([sheet('orphan',{costEvidence:evidence()})],[]));expect(r.coverage?.totalCount).toBe(0);expect(r.consolidatedRevenue).toBe(0);expect(r.consolidatedProfit).toBeNull();});
 it('伪complete缺必要字段不能认证',async()=>{const r=await getConsolidatedProfitReport(db([sheet('a',{costEvidence:{version:2,status:'complete',actualCostCny:50,actualProfitCny:150}})],['a']));expect(r.coverage?.unknownCount).toBe(1);expect(r.consolidatedProfit).toBeNull();});
 it.each(['freightCost','miscCost','bankFeeCost','allowanceCost'])('完整成本证据仍不能将未知%s当成零费用',async field=>{
  const row:any=sheet('a',{costEvidence:evidence()});row[field]=null;
  const r=await getConsolidatedProfitReport(db([row],['a'],{a:pending(`UNKNOWN_${field}`)}));expect(r.coverage).toMatchObject({status:'incomplete',coveredCount:0,pendingCount:1});expect(r.consolidatedProfit).toBeNull();expect(r.consolidatedCost).toBeNull();
 });
 it('未知销售收入不是零收入报表',async()=>{const row:any=sheet('a',{costEvidence:evidence()});row.salesRevenue=null;await expect(getConsolidatedProfitReport(db([row],['a']))).rejects.toThrow('不能按零合并');});
 it('历史完整JSON无法覆盖当前来源变化或缺少真实核对事实',async()=>{
  for(const current of [pending(),{status:'stale',pendingReasons:['ORDER_COST_REVIEW_SOURCE_CHANGED'],reviewId:'old-a',reviewRevision:1,sourceFingerprint:'c'.repeat(64)} as OrderCostReviewCurrent]){
   const r=await getConsolidatedProfitReport(db([sheet('a',{costEvidence:evidence()})],['a'],{a:current}));
   expect(r.coverage).toEqual({status:'incomplete',coveredCount:0,pendingCount:1,unknownCount:0,totalCount:1});expect(r.consolidatedCost).toBeNull();expect(r.consolidatedProfit).toBeNull();expect(r.costBreakdown.externalPurchaseNetOfInternal).toBeNull();
  }
 });
 it('真实核对读取拒绝不降级为旧complete或零成本',async()=>{
  const failure=Object.assign(new Error('核对事实审计不一致'),{code:'COST_REVIEW_FACT_INVALID'});vi.mocked(readCurrentOrderCostReview).mockRejectedValueOnce(failure);
  await expect(getConsolidatedProfitReport(db([sheet('a',{costEvidence:evidence()})],['a']))).rejects.toBe(failure);
 });
});
