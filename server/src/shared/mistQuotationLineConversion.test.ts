import {describe,it,expect} from 'vitest';
import {createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createMarketState,applyMarketCommand,type MarketState,type MarketCommand} from './mistMarket';
import {quotationConversionComplete,quotationConversionProgress,quotationConvertedOrders,quotationPendingLines,quoteLineConversionStatus,quoteLineConversionText} from './mistQuotationLineConversion';
const setup=()=>{let n=0;const ctx:MistContext={id:()=>`q5-${++n}`,now:'2026-10-13T08:00:00.000Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},businessReviewerId:'leader'}};const s=createMistState(ctx) as MistState&{market:MarketState};s.market=createMarketState(ctx,s);return {ctx,s};};
const run=(s:MistState,c:MarketCommand,ctx:MistContext)=>applyMarketCommand(s,c,ctx);
/** 3 个面料产品档案条目的报价，走到客户已接受。 */
const accepted=(s:MistState&{market:MarketState},ctx:MistContext,count=3)=>{
  const lines=Array.from({length:count},(_,i)=>{const p=run(s,{type:'market.product.save',payload:{input:{sku:`P-Q5-${i}`,name:`面料${i+1}`,category:'fabric',season:'AW26',supplierId:'',supplierCode:'',composition:'棉',specification:'150cm',color:'蓝',unit:'米',cost:'1.00',currency:'USD',sourceDevId:'',sourceVersionId:''}}},ctx).id!;
    return {productId:p,sourceDevId:'',sourceVersionId:'',name:`面料${i+1}`,style:`P-Q5-${i}`,specification:'150cm',qty:String(10*(i+1)),unit:i===2?'码':'米',price:'2.50',cost:'1.00'};});
  const id=run(s,{type:'market.quotation.save',payload:{input:{customerId:s.customers[0].id,currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB',paymentTerms:'T/T',lines}}},ctx).id!;
  run(s,{type:'market.quotation.submit',payload:{id}},ctx);if(s.market.quotations.find(q=>q.id===id)!.approval?.status==='pending')run(s,{type:'market.quotation.decide',payload:{id,decision:'approved',note:'ok'}},{...ctx,actorId:'leader'});
  run(s,{type:'market.quotation.status',payload:{id,status:'Sent',evidence:'交付'}},ctx);run(s,{type:'market.quotation.status',payload:{id,status:'Accepted',evidence:'接受'}},ctx);
  return {id,q:()=>s.market.quotations.find(q=>q.id===id)!};
};
const convert=(s:MistState,ctx:MistContext,id:string,lineIds?:string[])=>run(s,{type:'market.quotation.convert',payload:{id,type:'fabric',due:'2026-12-01',owner:'业务员',...(lineIds?{lineIds}:{})}},ctx);
describe('BB-QUO-5 报价按条目转订单',()=>{
 it('converts 2 of 3 lines into order A, the 3rd into order B, and rejects converting a converted line again',()=>{
  const {ctx,s}=setup(),{id,q}=accepted(s,ctx);const [l1,l2,l3]=q().lines;
  const a=convert(s,ctx,id,[l1.id,l2.id]).orderId as string;const orderA=s.orders.find(o=>o.id===a)!;
  const linesA=s.orderLines.filter(l=>l.orderId===a);
  expect(linesA.map(l=>[l.name,l.quantityExact,l.unit,l.unitPriceExact,l.sourceQuotationLineId])).toEqual([['面料1','10','米','2.50',l1.id],['面料2','20','米','2.50',l2.id]]);
  expect(orderA).toMatchObject({lines:2,qty:30,amount:75});
  expect(quoteLineConversionStatus(q(),q().lines[0])).toMatchObject({state:'converted',orderId:a,orderCode:orderA.code});
  expect(quoteLineConversionStatus(q(),q().lines[2])).toEqual({state:'pending'});
  expect(quotationConversionComplete(q())).toBe(false);expect(quotationPendingLines(q()).map(l=>l.id)).toEqual([l3.id]);
  const b=convert(s,ctx,id,[l3.id]).orderId as string;expect(b).not.toBe(a);
  expect(s.orderLines.filter(l=>l.orderId===b).map(l=>[l.name,l.quantityExact,l.unit])).toEqual([['面料3','30','码']]);
  expect(quotationConversionComplete(q())).toBe(true);expect(quotationConvertedOrders(q(),s.orders).map(o=>o.id)).toEqual([a,b]);
  expect(q().convertedOrderId).toBe(a);
  const ordersBefore=s.orders.length;
  expect(()=>convert(s,ctx,id,[l1.id])).toThrow(new RegExp(`面料1.*已转入订单 ${orderA.code}.*不能再转`));
  expect(s.orders.length).toBe(ordersBefore);
 });
 it('marks remaining lines as 不再转 with a reason; skipped lines cannot be converted and the quotation becomes 已转单',()=>{
  const {ctx,s}=setup(),{id,q}=accepted(s,ctx);const [l1,l2,l3]=q().lines;
  convert(s,ctx,id,[l1.id]);
  expect(()=>run(s,{type:'market.quotation.skipLines',payload:{id,lineIds:[l2.id],reason:''}},ctx)).toThrow(/不再转原因/);
  expect(()=>run(s,{type:'market.quotation.skipLines',payload:{id,lineIds:[l1.id],reason:'客户取消'}},ctx)).toThrow(/已转入订单/);
  run(s,{type:'market.quotation.skipLines',payload:{id,lineIds:[l2.id,l3.id],reason:'客户取消该色'}},ctx);
  expect(quoteLineConversionText(quoteLineConversionStatus(q(),q().lines[1]))).toBe('不再转：客户取消该色');
  expect(()=>convert(s,ctx,id,[l2.id])).toThrow(/已标记不再转/);
  expect(()=>convert(s,ctx,id)).toThrow(/没有可转的条目/);
  expect(quotationConversionComplete(q())).toBe(true);expect(quotationConversionProgress(q()).text).toBe('已转 1 · 不再转 2 · 未转 0');
  expect(s.events.some(e=>e.entityId===id&&/不再转.*客户取消该色/.test(e.text||''))).toBe(true);
 });
 it('rejects mixed-family selections, empty selections and lines from other quotations',()=>{
  const {ctx,s}=setup(),{id,q}=accepted(s,ctx,1);
  const g=run(s,{type:'market.product.save',payload:{input:{sku:'G-Q5',name:'外套',category:'garment',season:'AW26',supplierId:'',supplierCode:'',composition:'',specification:'',color:'',unit:'件',cost:'5.00',currency:'USD',sourceDevId:'',sourceVersionId:''}}},ctx).id!;
  const mixed=run(s,{type:'market.quotation.save',payload:{input:{customerId:s.customers[0].id,currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB',paymentTerms:'T/T',lines:[{...q().lines[0],id:undefined,amount:undefined} as never,{productId:g,sourceDevId:'',sourceVersionId:'',name:'外套',style:'G-Q5',specification:'',qty:'5',unit:'件',price:'9.00',cost:'5.00'}]}}},ctx).id!;
  run(s,{type:'market.quotation.submit',payload:{id:mixed}},ctx);if(s.market.quotations.find(x=>x.id===mixed)!.approval?.status==='pending')run(s,{type:'market.quotation.decide',payload:{id:mixed,decision:'approved',note:'ok'}},{...ctx,actorId:'leader'});
  run(s,{type:'market.quotation.status',payload:{id:mixed,status:'Sent',evidence:'交付'}},ctx);run(s,{type:'market.quotation.status',payload:{id:mixed,status:'Accepted',evidence:'接受'}},ctx);
  const mq=s.market.quotations.find(x=>x.id===mixed)!;
  expect(()=>convert(s,ctx,mixed,mq.lines.map(l=>l.id))).toThrow(/按业务类型分别转单/);
  expect(()=>convert(s,ctx,mixed,[])).toThrow(/至少选择一个条目/);
  expect(()=>convert(s,ctx,mixed,[q().lines[0].id])).toThrow(/不在此报价中/);
  const f=convert(s,ctx,mixed,[mq.lines[0].id]).orderId;expect(f).toBeTruthy();
  const gOrder=run(s,{type:'market.quotation.convert',payload:{id:mixed,type:'garment',due:'2026-12-01',owner:'业务员',lineIds:[mq.lines[1].id]}},ctx).orderId as string;
  expect(s.orders.find(o=>o.id===gOrder)!.type).toBe('garment');expect(quotationConversionComplete(mq)).toBe(true);
 });
 it('keeps legacy whole-quotation conversions readable as all converted and idempotent for old callers',()=>{
  const {ctx,s}=setup(),{id,q}=accepted(s,ctx,2);
  const legacy=q();legacy.convertedOrderId='old-order';s.orders.unshift({...s.orders[0]??{},id:'old-order',code:'SO-F-2025-0001'} as never);
  const before=JSON.stringify(legacy);
  expect(quotationPendingLines(legacy)).toEqual([]);expect(quotationConversionComplete(legacy)).toBe(true);
  expect(quoteLineConversionStatus(legacy,legacy.lines[1],s.orders)).toEqual({state:'converted',orderId:'old-order',orderCode:'SO-F-2025-0001',legacy:true});
  expect(convert(s,ctx,id)).toEqual({id,orderId:'old-order'});
  expect(()=>convert(s,ctx,id,[legacy.lines[0].id])).toThrow(/已转入订单 SO-F-2025-0001/);
  expect(JSON.stringify(q())).toBe(before);
 });
 it('defaults to all pending lines for callers without lineIds and stays idempotent afterwards',()=>{
  const {ctx,s}=setup(),{id,q}=accepted(s,ctx);
  const first=convert(s,ctx,id);expect(s.orderLines.filter(l=>l.orderId===first.orderId)).toHaveLength(3);
  expect(convert(s,ctx,id)).toEqual(first);expect(quotationConversionComplete(q())).toBe(true);
 });
 it('ignores conversion markers sent through quotation save',()=>{
  const {ctx,s}=setup();accepted(s,ctx,1);const p=s.market.products[0];
  const id=run(s,{type:'market.quotation.save',payload:{input:{customerId:s.customers[0].id,currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB',paymentTerms:'T/T',lines:[{productId:p.id,sourceDevId:'',sourceVersionId:'',name:'x',style:p.sku,specification:'',qty:'1',unit:'米',price:'2.00',cost:'1.00',conversion:{orderId:'fake',orderCode:'F',at:'',by:'',byId:''},skipped:{reason:'x',at:'',by:'',byId:''}} as never]}}},ctx).id!;
  const line=s.market.quotations.find(x=>x.id===id)!.lines[0];expect(line.conversion).toBeUndefined();expect(line.skipped).toBeUndefined();
 });
});
