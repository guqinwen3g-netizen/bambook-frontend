import {describe,it,expect} from 'vitest';
import {createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createMarketState,applyMarketCommand,marketCommandPermission,quotationNeedsApproval,quotationMarginFloorBreaches,type MarketState,type MarketCommand} from './mistMarket';
import {applicableMarginFloor,lineBelowMarginFloor,quoteLineMarginPercent} from './mistQuotationMarginFloor';
const setup=()=>{let n=0;const ctx:MistContext={id:()=>`mf-${++n}`,now:'2026-10-13T08:00:00.000Z',actorName:'总领导',actorId:'boss',authority:{supplier:{},businessReviewerId:'leader'}};const s=createMistState(ctx,'empty') as MistState&{market:MarketState};s.market=createMarketState(ctx,s);s.customers.push({id:'c',name:'客户',code:'C',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:'2026-01-01'} as never);return {ctx,s};};
const run=(s:MistState,c:MarketCommand,ctx:MistContext)=>applyMarketCommand(s,c,ctx);
const garment={sku:'G1',name:'衬衫',category:'garment' as const,season:'AW26',supplierId:'',supplierCode:'',composition:'',specification:'',color:'',unit:'件',cost:'88.00',currency:'USD',sourceDevId:'',sourceVersionId:''};
const quote=(productId:string)=>({customerId:'c',currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB',paymentTerms:'T/T',lines:[{productId,sourceDevId:'',sourceVersionId:'',name:'衬衫',style:'G1',specification:'',qty:'100',unit:'件',price:'100.00',cost:'88.00'}]});
const setFloor=(s:MistState,ctx:MistContext,min:string,effectiveFrom='2026-10-13')=>run(s,{type:'market.marginFloor.set',payload:{family:'garment',minMarginPercent:min,effectiveFrom,reason:'季度定价会'}},ctx);
describe('BB-QUO-3 最低毛利率底价线',()=>{
 it('garment floor 15% with a 12% line requires approval; after changing to 10% the old quote keeps 15% and a new quote uses 10%',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:garment}},ctx).id!;
  setFloor(s,ctx,'15');
  const oldId=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},ctx).id!;const old=()=>s.market.quotations.find(q=>q.id===oldId)!;
  expect(quoteLineMarginPercent('100.00','88.00')).toBe('12.00');
  expect(old().lines[0].marginFloor).toMatchObject({family:'garment',version:1,minMarginPercent:'15'});
  expect(quotationNeedsApproval(old())).toBe(true);
  expect(()=>run(s,{type:'market.quotation.status',payload:{id:oldId,status:'Sent',evidence:'直接发'}},ctx)).toThrow(/审批/);
  setFloor(s,ctx,'10');
  expect(old().lines[0].marginFloor?.minMarginPercent).toBe('15');expect(quotationNeedsApproval(old())).toBe(true);
  const newId=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},ctx).id!;const fresh=s.market.quotations.find(q=>q.id===newId)!;
  expect(fresh.lines[0].marginFloor).toMatchObject({version:2,minMarginPercent:'10'});expect(quotationNeedsApproval(fresh)).toBe(false);
  run(s,{type:'market.quotation.status',payload:{id:newId,status:'Sent',evidence:'邮件'}},ctx);
  expect(s.market.marginFloors!.map(f=>[f.version,f.minMarginPercent])).toEqual([[1,'15'],[2,'10']]);
  expect(s.events.some(e=>e.entityType==='pricing'&&e.text.includes('V2：10%'))).toBe(true);
 });
 it('editing a saved quote after the floor changes keeps its frozen 15% instead of loosening to the new 10%',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:garment}},ctx).id!;
  setFloor(s,ctx,'15');
  const id=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},ctx).id!;const q=()=>s.market.quotations.find(x=>x.id===id)!;
  setFloor(s,ctx,'10');
  run(s,{type:'market.quotation.save',payload:{id,input:{...quote(p),note:'退回后修改重提'}}},ctx);
  expect(q().lines[0].marginFloor).toMatchObject({version:1,minMarginPercent:'15'});expect(quotationNeedsApproval(q())).toBe(true);
  expect(()=>run(s,{type:'market.quotation.status',payload:{id,status:'Sent',evidence:'直接发'}},ctx)).toThrow(/审批/);
  const fresh=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},ctx).id!;
  expect(s.market.quotations.find(x=>x.id===fresh)!.lines[0].marginFloor).toMatchObject({version:2,minMarginPercent:'10'});
 });
 it('approval details show the applicable floor and version, every line margin, and which line triggered',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:garment}},ctx).id!;setFloor(s,ctx,'15');
  const id=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},{...ctx,actorId:'sales'}).id!;
  run(s,{type:'market.quotation.submit',payload:{id}},{...ctx,actorId:'sales'});const d=s.market.quotations.find(q=>q.id===id)!.approval!.details;
  expect(d.find(x=>x.label==='适用最低毛利率')?.value).toBe('成衣最低毛利率 15%（V1，2026-10-13 起生效）');
  expect(d.find(x=>x.label==='条目毛利率 · 衬衫 / G1')?.value).toBe('12.00%；底价线 15%（V1）');
  expect(d.find(x=>x.label==='低于最低毛利率')?.value).toMatch(/衬衫 \/ G1：毛利率 12.00% 低于成衣最低毛利率 15%/);
  expect(quotationMarginFloorBreaches(s.market.quotations.find(q=>q.id===id)!)).toHaveLength(1);
 });
 it('only management (pricing:admin) may set floors; values and dates are validated; no floor means legacy behaviour',()=>{
  const {ctx,s}=setup();expect(marketCommandPermission({type:'market.marginFloor.set',payload:{family:'garment',minMarginPercent:'15',effectiveFrom:'2026-10-13',reason:'x'}})).toBe('pricing:admin');
  expect(()=>setFloor(s,ctx,'100')).toThrow(/0–99.99/);expect(()=>setFloor(s,ctx,'12.345')).toThrow(/两位小数/);
  expect(()=>setFloor(s,ctx,'15','2026-10-12')).toThrow(/不能早于今天/);
  expect(()=>run(s,{type:'market.marginFloor.set',payload:{family:'garment',minMarginPercent:'15',effectiveFrom:'2026-10-13',reason:''}},ctx)).toThrow(/调整原因/);
  const p=run(s,{type:'market.product.save',payload:{input:garment}},ctx).id!;const id=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},ctx).id!;
  const q=s.market.quotations.find(x=>x.id===id)!;expect(q.lines[0].marginFloor).toBeUndefined();expect(quotationNeedsApproval(q)).toBe(false);
 });
 it('picks the latest effective version by date and compares margins exactly',()=>{
  const floors=[{id:'a',family:'garment' as const,version:1,minMarginPercent:'15',effectiveFrom:'2026-10-01',reason:'',createdAt:'',createdBy:'',createdById:''},{id:'b',family:'garment' as const,version:2,minMarginPercent:'10',effectiveFrom:'2026-11-01',reason:'',createdAt:'',createdBy:'',createdById:''}];
  expect(applicableMarginFloor(floors,'garment','2026-10-20')?.id).toBe('a');expect(applicableMarginFloor(floors,'garment','2026-11-01')?.id).toBe('b');expect(applicableMarginFloor(floors,'fabric','2026-11-01')).toBeUndefined();
  const f={id:'a',family:'garment' as const,version:1,minMarginPercent:'15',effectiveFrom:'2026-10-01'};
  expect(lineBelowMarginFloor({price:'100.00',cost:'85.00',marginFloor:f})).toBe(false);expect(lineBelowMarginFloor({price:'100.00',cost:'85.01',marginFloor:f})).toBe(true);
  expect(quoteLineMarginPercent('3.00','2.00')).toBe('33.33');expect(quoteLineMarginPercent('1.00','1.20')).toBe('-20.00');expect(quoteLineMarginPercent('1.00','')).toBeNull();
 });
});
