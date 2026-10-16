import {describe,it,expect} from 'vitest';
import {createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createMarketState,applyMarketCommand,legalQuoteUnit,quoteLineFamily,quoteUnitOptions,type MarketState,type MarketCommand,type MarketQuotation} from './mistMarket';
import {developmentDomain} from './mistDevelopmentDomain';

const setup=()=>{let n=0;const ctx:MistContext={id:()=>`u-${++n}`,now:'2026-10-16T08:00:00.000Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},businessReviewerId:'leader'}};const s=createMistState(ctx) as MistState&{market:MarketState};s.market=createMarketState(ctx,s);s.market.quotations=[];s.customers.push({id:'c',name:'客户',code:'C',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:'2026-01-01'});return {ctx,s};};
const run=(s:MistState,c:MarketCommand,ctx:MistContext)=>applyMarketCommand(s,c,ctx);
const header={customerId:'c',currency:'USD',season:'AW26',validUntil:'2026-11-30',deliveryTerms:'FOB 上海',paymentTerms:'T/T 30%'};
const product=(s:MistState&{market:MarketState},ctx:MistContext,category:'fabric'|'garment'|'trimming',unit:string)=>run(s,{type:'market.product.save',payload:{input:{sku:'SKU-'+category+unit,name:category,category,season:'',supplierId:'',supplierCode:'',composition:'',specification:'',color:'',unit,cost:'1.00',currency:'USD',sourceDevId:'',sourceVersionId:'',fileIds:[],note:''}}},ctx).id!;
const line=(source:{productId?:string;sourceDevId?:string;sourceVersionId?:string},unit:string)=>({productId:'',sourceDevId:'',sourceVersionId:'',...source,name:'条目',style:'S-1',specification:'',qty:'500',unit,price:'3.20',cost:''});
const save=(s:MistState&{market:MarketState},ctx:MistContext,lines:ReturnType<typeof line>[])=>run(s,{type:'market.quotation.save',payload:{input:{...header,lines,fileIds:[],note:''}}},ctx);

describe('BB-QUO-1 quotation pricing units',()=>{
 it('only accepts 米 / 码 / 公斤 for fabric and 件 / 套 for garment product lines',()=>{
  const {ctx,s}=setup(),fabric=product(s,ctx,'fabric','米'),garment=product(s,ctx,'garment','件');
  expect(()=>save(s,ctx,[line({productId:fabric},'件')])).toThrow(/面料条目「条目」计价单位只能是 米 \/ 码 \/ 公斤/);
  expect(()=>save(s,ctx,[line({productId:garment},'米')])).toThrow(/成衣条目「条目」计价单位只能是 件 \/ 套/);
  expect(()=>save(s,ctx,[line({productId:fabric},'')])).toThrow(/单位/);
  for(const unit of ['米','码','公斤'])expect(save(s,ctx,[line({productId:fabric},unit)]).id).toBeTruthy();
  for(const unit of ['件','套'])expect(save(s,ctx,[line({productId:garment},unit)]).id).toBeTruthy();
 });
 it('checks development version lines by the development business domain',()=>{
  const {ctx,s}=setup(),fd=s.devs.find(d=>developmentDomain(d.values)==='fabric')!,gd=s.devs.find(d=>developmentDomain(d.values)==='garment')!;
  const fv=s.versions.find(v=>v.devId===fd.id)!,gv=s.versions.find(v=>v.devId===gd.id)!;
  expect(()=>save(s,ctx,[line({sourceDevId:fd.id,sourceVersionId:fv.id},'件')])).toThrow(/面料条目.*米 \/ 码 \/ 公斤.*不自动换算/);
  expect(()=>save(s,ctx,[line({sourceDevId:gd.id,sourceVersionId:gv.id},'公斤')])).toThrow(/成衣条目/);
  const id=save(s,ctx,[line({sourceDevId:fd.id,sourceVersionId:fv.id},'公斤'),line({sourceDevId:gd.id,sourceVersionId:gv.id},'套')]).id;
  expect(s.market.quotations.find(q=>q.id===id)!.lines.map(l=>l.unit)).toEqual(['公斤','套']);
 });
 it('does not restrict categories outside the two workspaces',()=>{
  const {ctx,s}=setup(),trim=product(s,ctx,'trimming','粒');
  expect(save(s,ctx,[line({productId:trim},'粒')]).id).toBeTruthy();
 });
 it('derives the family and legal units for the editor and leaves illegal source units empty',()=>{
  const {ctx,s}=setup(),fabric=product(s,ctx,'fabric','件'),fd=s.devs.find(d=>developmentDomain(d.values)==='fabric')!;
  expect(quoteLineFamily(s,s.market,{productId:fabric})).toBe('fabric');
  expect(quoteLineFamily(s,s.market,{sourceDevId:fd.id})).toBe('fabric');
  expect(quoteUnitOptions('fabric')).toEqual(['米','码','公斤']);expect(quoteUnitOptions('garment')).toEqual(['件','套']);expect(quoteUnitOptions(undefined)).toBeUndefined();
  expect(legalQuoteUnit('fabric','件')).toBe('');expect(legalQuoteUnit('fabric','码')).toBe('码');expect(legalQuoteUnit('garment','件')).toBe('件');expect(legalQuoteUnit(undefined,'粒')).toBe('粒');
 });
 it('keeps historical quotations with old units readable and untouched',()=>{
  const {ctx,s}=setup(),fabric=product(s,ctx,'fabric','米');
  const legacy:MarketQuotation={...s.market.quotations[0],id:'legacy',code:'QT-2025-0001',customerId:'c',currency:'USD',season:'',validUntil:'2025-12-01',deliveryTerms:'FOB',paymentTerms:'T/T',status:'Sent',lines:[{id:'ll',productId:fabric,sourceDevId:'',sourceVersionId:'',name:'旧面料',style:'OLD',specification:'',qty:'100',unit:'件',price:'2.00',cost:'1.00',amount:'200.00'}],total:'200.00',deliveryEvidence:'已发送',responseEvidence:'',approval:null,approvalHistory:[],requiresApproval:false,convertedOrderId:null,createdAt:'2025-11-01T00:00:00.000Z',updatedAt:'2025-11-01T00:00:00.000Z',fileIds:[],note:''} as MarketQuotation;
  s.market.quotations.push(legacy);const before=JSON.stringify(legacy);
  save(s,ctx,[line({productId:fabric},'米')]);
  run(s,{type:'market.quotation.status',payload:{id:'legacy',status:'Accepted',evidence:'客户邮件接受'}},ctx);
  const after=s.market.quotations.find(q=>q.id==='legacy')!;
  expect(after.lines).toEqual(JSON.parse(before).lines);expect(after.status).toBe('Accepted');
 });
});
