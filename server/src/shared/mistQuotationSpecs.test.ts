import {describe,it,expect} from 'vitest';
import {createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createMarketState,applyMarketCommand,quotationNeedsApproval,type MarketState,type MarketCommand} from './mistMarket';
import {quoteMoqStatus,quoteSpecDefaults,quoteSpecItems} from './mistQuotationSpecs';
const setup=()=>{let n=0;const ctx:MistContext={id:()=>`s-${++n}`,now:'2026-10-13T08:00:00.000Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},businessReviewerId:'leader'}};const s=createMistState(ctx,'empty') as MistState&{market:MarketState};s.market=createMarketState(ctx,s);s.customers.push({id:'c',name:'客户',code:'C',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:'2026-01-01'} as never);return {ctx,s};};
const run=(s:MistState,c:MarketCommand,ctx:MistContext)=>applyMarketCommand(s,c,ctx);
const fabricProduct={sku:'F1',name:'府绸',category:'fabric' as const,season:'AW26',supplierId:'',supplierCode:'',composition:'100% 棉',specification:'',color:'白',unit:'米',cost:'1.00',currency:'USD',sourceDevId:'',sourceVersionId:'',specs:{weight:'120',width:'150'}};
const quote=(productId:string,line:Record<string,unknown>)=>({customerId:'c',currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB',paymentTerms:'T/T',lines:[{productId,sourceDevId:'',sourceVersionId:'',name:'府绸',style:'F1',specification:'',qty:'500',unit:'米',price:'2.00',cost:'1.00',...line}]});
describe('BB-QUO-2 结构化规格与 MOQ 提示',()=>{
 it('fabric line with per-colour MOQ 1000 米 quoted at 500 米 shows a hint but can be sent directly',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:fabricProduct}},ctx).id!;
  const id=run(s,{type:'market.quotation.save',payload:{input:quote(p,{specs:{composition:'100% 棉',weight:'120',width:'150',moqQty:'1000',moqUnit:'米'}})}},ctx).id!;
  const q=s.market.quotations.find(x=>x.id===id)!;
  expect(q.lines[0].specs).toEqual({composition:'100% 棉',weight:'120',width:'150',moqQty:'1000',moqUnit:'米'});
  expect(quoteMoqStatus('fabric',q.lines[0])).toMatchObject({state:'below'});
  expect(quotationNeedsApproval(q)).toBe(false);
  run(s,{type:'market.quotation.status',payload:{id,status:'Sent',evidence:'邮件发送'}},ctx);
  expect(s.market.quotations.find(x=>x.id===id)!.status).toBe('Sent');
 });
 it('approval details carry the spec summary and the below-MOQ hint',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:fabricProduct}},ctx).id!;
  const id=run(s,{type:'market.quotation.save',payload:{input:quote(p,{price:'0.50',specs:{moqQty:'1000',moqUnit:'米'}})}},ctx).id!;
  run(s,{type:'market.quotation.submit',payload:{id}},ctx);const d=s.market.quotations.find(x=>x.id===id)!.approval!.details;
  expect(d.find(x=>x.label==='低于 MOQ')?.value).toMatch(/报价 500 米.*每色 MOQ 1000 米.*不触发审批/);
  expect(d.find(x=>x.label==='府绸 / F1')?.value).toMatch(/成分 未填写 \/ 克重 未填写/);
 });
 it('validates numbers and MOQ units per family, without conversion',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:fabricProduct}},ctx).id!;
  const save=(specs:Record<string,string>)=>run(s,{type:'market.quotation.save',payload:{input:quote(p,{specs})}},ctx);
  expect(()=>save({weight:'约120'})).toThrow(/克重须为数字/);
  expect(()=>save({moqQty:'1000'})).toThrow(/须选择单位/);
  expect(()=>save({moqQty:'1000',moqUnit:'件'})).toThrow(/每色 MOQ 单位只能是 米 \/ 码 \/ 公斤/);
  expect(()=>save({moqQty:'0',moqUnit:'米'})).toThrow(/大于 0/);
  const id=save({moqQty:'1000',moqUnit:'码'}).id!;
  expect(quoteMoqStatus('fabric',s.market.quotations.find(x=>x.id===id)!.lines[0])).toMatchObject({state:'unitMismatch'});
 });
 it('prefills only known values and shows missing ones as 未填写; legacy lines without specs stay readable',()=>{
  expect(quoteSpecDefaults('fabric',{product:{composition:'100% 棉',specs:{weight:'120'}}})).toEqual({composition:'100% 棉',weight:'120'});
  expect(quoteSpecDefaults('garment',{version:{size:'S-XL',fabric:''}})).toEqual({sizeRange:'S-XL'});
  expect(quoteSpecDefaults('fabric',{version:{fabricRequirements:{composition:'待工厂分析',weightValue:'180',weightUnit:'g/m²',widthValue:'约150',widthUnit:'cm',yarn:'',weave:'',usage:'',handle:'',finish:'',performance:''}}})).toEqual({weight:'180'});
  expect(quoteSpecItems('garment',undefined).map(i=>i.value)).toEqual(['未填写','未填写','未填写']);
  expect(quoteMoqStatus('garment',{qty:'10',unit:'件'})).toEqual({state:'none',text:''});
 });
});
