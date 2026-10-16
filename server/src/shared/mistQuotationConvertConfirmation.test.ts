import {describe,it,expect} from 'vitest';
import {createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createMarketState,applyMarketCommand,quotationConversionBlockers,type MarketState,type MarketCommand} from './mistMarket';
import {developmentDomain} from './mistDevelopmentDomain';
const setup=()=>{let n=0;const ctx:MistContext={id:()=>`q4-${++n}`,now:'2026-10-13T08:00:00.000Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},businessReviewerId:'leader'}};const s=createMistState(ctx) as MistState&{market:MarketState};s.market=createMarketState(ctx,s);return {ctx,s};};
const run=(s:MistState,c:MarketCommand,ctx:MistContext)=>applyMarketCommand(s,c,ctx);
/** 用开发版本（非产品档案）作为来源条目，走到客户已接受。 */
const acceptedVersionQuote=(s:MistState&{market:MarketState},ctx:MistContext,versionId:string)=>{
  const v=s.versions.find(x=>x.id===versionId)!,dev=s.devs.find(d=>d.id===v.devId)!,fabric=developmentDomain(dev.values)==='fabric';
  const customerId=s.customers.find(c=>!c.archivedAt)?.id||s.customers[0].id;
  const input={customerId,currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB',paymentTerms:'T/T',lines:[{productId:'',sourceDevId:dev.id,sourceVersionId:v.id,name:dev.name,style:dev.style,specification:'规格',qty:'10',unit:fabric?'米':'件',price:'2.00',cost:'1.00'}]};
  const id=run(s,{type:'market.quotation.save',payload:{input}},ctx).id!;
  run(s,{type:'market.quotation.submit',payload:{id}},ctx);
  if(s.market.quotations.find(q=>q.id===id)!.approval?.status==='pending')run(s,{type:'market.quotation.decide',payload:{id,decision:'approved',note:'已核对'}},{...ctx,actorId:'leader'});
  run(s,{type:'market.quotation.status',payload:{id,status:'Sent',evidence:'已交付'}},ctx);run(s,{type:'market.quotation.status',payload:{id,status:'Accepted',evidence:'已接受'}},ctx);
  return {id,type:(fabric?'fabric':'garment') as 'fabric'|'garment',v,dev};
};
const convert=(s:MistState,ctx:MistContext,id:string,type:'fabric'|'garment')=>run(s,{type:'market.quotation.convert',payload:{id,type,due:'2026-12-01',owner:'业务员'}},ctx);
describe('BB-QUO-4 转订单须开发版本已获需求方认可',()=>{
 it('rejects a quotation whose development version has no confirmation, naming the line and version, then converts after approval',()=>{
  const {ctx,s}=setup(),v=s.versions.find(x=>!x.archivedAt)!;v.confirmations=[];const {id,type,dev}=acceptedVersionQuote(s,ctx,v.id);
  expect(quotationConversionBlockers(s,s.market.quotations.find(q=>q.id===id)!)).toMatchObject([{versionLabel:v.label,reason:'尚无需求方确认'}]);
  expect(()=>convert(s,ctx,id,type)).toThrow(new RegExp(`${dev.name}.*${v.label}.*尚未获得需求方认可`));
  expect(s.market.quotations.find(q=>q.id===id)!.convertedOrderId).toBeNull();
  v.confirmations.push({id:'cf',result:'approved',confirmer:'客户',organization:'',confirmedAt:ctx.now,basis:'邮件',originalText:'',recordedAt:ctx.now,recordedBy:'业务员'});
  expect(quotationConversionBlockers(s,s.market.quotations.find(q=>q.id===id)!)).toEqual([]);
  expect(convert(s,ctx,id,type).orderId).toBeTruthy();
 });
 it('uses the latest confirmation: approval followed by an adjustment request blocks conversion',()=>{
  const {ctx,s}=setup(),v=s.versions.find(x=>!x.archivedAt)!;const base={organization:'',confirmedAt:ctx.now,basis:'邮件',originalText:'',recordedAt:ctx.now,recordedBy:'业务员',confirmer:'客户'};
  v.confirmations=[{...base,id:'a',result:'approved'},{...base,id:'b',result:'needs_adjustment'}];const {id,type}=acceptedVersionQuote(s,ctx,v.id);
  expect(()=>convert(s,ctx,id,type)).toThrow(/需求方要求调整/);
 });
 it('does not restrict product archive lines',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:{sku:'P-Q4',name:'面料',category:'fabric',season:'AW26',supplierId:'',supplierCode:'',composition:'棉',specification:'150cm',color:'蓝',unit:'米',cost:'1.00',currency:'USD',sourceDevId:'',sourceVersionId:''}}},ctx).id!;
  const customerId=s.customers[0].id;const id=run(s,{type:'market.quotation.save',payload:{input:{customerId,currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB',paymentTerms:'T/T',lines:[{productId:p,sourceDevId:'',sourceVersionId:'',name:'面料',style:'P-Q4',specification:'150cm',qty:'3',unit:'米',price:'2.00',cost:'1.00'}]}}},ctx).id!;
  run(s,{type:'market.quotation.submit',payload:{id}},ctx);if(s.market.quotations.find(q=>q.id===id)!.approval?.status==='pending')run(s,{type:'market.quotation.decide',payload:{id,decision:'approved',note:'ok'}},{...ctx,actorId:'leader'});
  run(s,{type:'market.quotation.status',payload:{id,status:'Sent',evidence:'交付'}},ctx);run(s,{type:'market.quotation.status',payload:{id,status:'Accepted',evidence:'接受'}},ctx);
  expect(convert(s,ctx,id,'fabric').orderId).toBeTruthy();
 });
});
