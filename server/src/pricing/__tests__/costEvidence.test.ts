import {it,expect} from 'vitest';
import {maskProfitSheet,readCostEvidence} from '../costEvidence';
it('历史、pending及伪complete缺耗用金额都隐藏利润',()=>{
 for(const costEvidence of [undefined,{version:2,status:'pending',actualCostCny:0,actualProfitCny:100},{version:2,status:'complete',actualCostCny:null,actualProfitCny:100}]) {
  expect(maskProfitSheet({details:{costEvidence},grossProfit:100,grossMargin:20})).toMatchObject({grossProfit:null,grossMargin:null});
 }
 expect(readCostEvidence({})).toBeNull();
});
it('complete 必须字段齐全、金额有限且无待确认原因，历史内部利润同样遮蔽',()=>{
 const complete={version:2,status:'complete',calculatedAt:'2026-09-30',pendingReasons:[],committedAmountCny:100,acceptedAmountCny:100,paidPrincipalCny:0,actualCostCny:100,actualProfitCny:20,actualRevenueCny:120,reviewId:'OCR-1',reviewRevision:1,sourceFingerprint:'a'.repeat(64),actualBreakdown:{procurement:100,companySupply:0,logistics:0,otherExpenses:0,bankFees:0,allowances:0}};
 expect(readCostEvidence({costEvidence:complete})?.actualProfitCny).toBe(20);
 for(const patch of [{actualCostCny:NaN},{actualProfitCny:null},{pendingReasons:['MISSING']},{paidPrincipalCny:undefined},{reviewId:undefined},{actualRevenueCny:undefined}]) expect(readCostEvidence({costEvidence:{...complete,...patch}})).toBeNull();
 expect((maskProfitSheet({details:{internalTrade:{departmentProfit:500}},grossProfit:500,grossMargin:50}).details as any).internalTrade.departmentProfit).toBeNull();
});
it('actual money uses exact four-decimal sums and subtraction without widening tolerance',()=>{
 const complete={version:2,status:'complete',calculatedAt:'2026-10-01',pendingReasons:[],committedAmountCny:null,acceptedAmountCny:null,paidPrincipalCny:null,actualCostCny:90.0099,actualProfitCny:10.0001,actualRevenueCny:100.01,reviewId:'OCR-precision',reviewRevision:1,sourceFingerprint:'b'.repeat(64),actualBreakdown:{procurement:90,companySupply:0,logistics:0.0099,otherExpenses:0,bankFees:0,allowances:0}};
 expect(readCostEvidence({costEvidence:complete})?.actualProfitCny).toBe(10.0001);
 expect(maskProfitSheet({details:{costEvidence:complete}})).toMatchObject({grossProfit:10.0001,grossMargin:9.9991});
 expect(readCostEvidence({costEvidence:{...complete,actualProfitCny:10}})).toBeNull();
 expect(readCostEvidence({costEvidence:{...complete,actualBreakdown:{...complete.actualBreakdown,logistics:0.0098}}})).toBeNull();
 const large={...complete,actualCostCny:9000000000.0099,actualRevenueCny:9000000000.01,actualProfitCny:0.0001,actualBreakdown:{...complete.actualBreakdown,procurement:9000000000}};
 expect(readCostEvidence({costEvidence:large})?.actualProfitCny).toBe(0.0001);
});
