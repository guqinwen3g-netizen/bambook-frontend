import {describe,it,expect} from 'vitest';
import {createMistState,type MistContext,type MistState} from './mistWorkspace';
import {createMarketState,applyMarketCommand,marketCommandPermission,quotationNeedsApproval,quotationMarginFloorBreaches,type MarketState,type MarketCommand} from './mistMarket';
import {developmentDomain} from './mistDevelopmentDomain';
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
 it('a quote saved with no applicable floor keeps “no floor” when management later sets 15% the same day and only the note is edited',()=>{
  // 独立复现的反例：成本 88、售价 100、保存时没有任何底价线。
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:garment}},ctx).id!;
  const id=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},ctx).id!;const q=()=>s.market.quotations.find(x=>x.id===id)!;
  expect(q().lines[0].marginFloor??null).toBeNull();expect(quotationNeedsApproval(q())).toBe(false);
  setFloor(s,ctx,'15');
  expect(q().lines[0].marginFloor??null).toBeNull();expect(quotationNeedsApproval(q())).toBe(false);
  run(s,{type:'market.quotation.save',payload:{id,input:{...quote(p),note:'仅改备注'}}},ctx);
  expect(q().lines[0].marginFloor??null).toBeNull();expect(quotationNeedsApproval(q())).toBe(false);
  run(s,{type:'market.quotation.status',payload:{id,status:'Sent',evidence:'邮件发送'}},ctx);expect(q().status).toBe('Sent');
  // 新报价按当前适用的 15%（V1）判断，须审批。
  const fresh=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},ctx).id!;const f=s.market.quotations.find(x=>x.id===fresh)!;
  expect(f.lines[0].marginFloor).toMatchObject({version:1,minMarginPercent:'15'});expect(quotationNeedsApproval(f)).toBe(true);
  // 已发送旧报价出新版本：新版本按当前适用规则，不继承旧的“无底价线”。
  const v2=run(s,{type:'market.quotation.save',payload:{input:{...quote(p),previousId:id}}},ctx).id!;
  expect(s.market.quotations.find(x=>x.id===v2)!.lines[0].marginFloor).toMatchObject({version:1,minMarginPercent:'15'});
 });
 it('a floor scheduled for a future day is not applied retroactively once it takes effect; new quotes after that day use it',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:garment}},ctx).id!;
  setFloor(s,ctx,'15','2026-10-20');
  const id=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},ctx).id!;const q=()=>s.market.quotations.find(x=>x.id===id)!;
  expect(q().lines[0].marginFloor??null).toBeNull();
  const later={...ctx,now:'2026-10-21T02:00:00.000Z'};
  run(s,{type:'market.quotation.save',payload:{id,input:{...quote(p),note:'到期后编辑'}}},later);
  expect(q().lines[0].marginFloor??null).toBeNull();expect(quotationNeedsApproval(q())).toBe(false);
  const fresh=run(s,{type:'market.quotation.save',payload:{input:quote(p)}},later).id!;
  expect(s.market.quotations.find(x=>x.id===fresh)!.lines[0].marginFloor).toMatchObject({version:1,minMarginPercent:'15',effectiveFrom:'2026-10-20'});
 });
 it('same-family source swaps and added lines keep the quote’s frozen state; a newly added family takes its current floor; forged floors are ignored',()=>{
  const {ctx,s}=setup(),demo=createMistState(ctx);s.devs=demo.devs;s.versions=demo.versions;
  const p=run(s,{type:'market.product.save',payload:{input:garment}},ctx).id!,p2=run(s,{type:'market.product.save',payload:{input:{...garment,sku:'G2',name:'外套'}}},ctx).id!;
  const fab=run(s,{type:'market.product.save',payload:{input:{...garment,sku:'F1',name:'府绸',category:'fabric' as const,unit:'米'}}},ctx).id!;
  const dev=s.devs.find(d=>developmentDomain(d.values)==='garment'&&d.versionIds.length)!,devLine={productId:'',sourceDevId:dev.id,sourceVersionId:dev.versionIds[0],name:'开发款',style:'DV1',specification:'',qty:'10',unit:'件',price:'100.00',cost:'88.00'};
  const fabLine={productId:fab,sourceDevId:'',sourceVersionId:'',name:'府绸',style:'F1',specification:'',qty:'100',unit:'米',price:'100.00',cost:'88.00'};
  const base=quote(p),id=run(s,{type:'market.quotation.save',payload:{input:base}},ctx).id!;const q=()=>s.market.quotations.find(x=>x.id===id)!;
  setFloor(s,ctx,'15');run(s,{type:'market.marginFloor.set',payload:{family:'fabric',minMarginPercent:'20',effectiveFrom:'2026-10-13',reason:'面料定价会'}},ctx);
  // 同板块换产品、换开发来源、加同板块行：仍是保存时的“无底价线”。
  run(s,{type:'market.quotation.save',payload:{id,input:{...base,lines:[{...base.lines[0],productId:p2,name:'外套',style:'G2'}]}}},ctx);
  expect(q().lines.map(l=>l.marginFloor??null)).toEqual([null]);
  run(s,{type:'market.quotation.save',payload:{id,input:{...base,lines:[devLine]}}},ctx);
  expect(q().lines.map(l=>l.marginFloor??null)).toEqual([null]);
  run(s,{type:'market.quotation.save',payload:{id,input:{...base,lines:[base.lines[0],devLine]}}},ctx);
  expect(q().lines.map(l=>l.marginFloor??null)).toEqual([null,null]);
  // 客户端伪造的 marginFloor 不参与判断。
  run(s,{type:'market.quotation.save',payload:{id,input:{...base,lines:[{...base.lines[0],marginFloor:{id:'fake',family:'garment',version:9,minMarginPercent:'1',effectiveFrom:'2026-01-01'}} as never]}}},ctx);
  expect(q().lines[0].marginFloor??null).toBeNull();
  // 旧报价新加入面料板块：面料行取当前面料 20%（V1），成衣行仍无底价线，两板块互不影响。
  run(s,{type:'market.quotation.save',payload:{id,input:{...base,lines:[base.lines[0],fabLine]}}},ctx);
  expect(q().lines[0].marginFloor??null).toBeNull();expect(q().lines[1].marginFloor).toMatchObject({family:'fabric',version:1,minMarginPercent:'20'});
  expect(quotationMarginFloorBreaches(q()).map(b=>b.line.name)).toEqual(['府绸']);expect(quotationNeedsApproval(q())).toBe(true);
  // 面料改为 5% 后再编辑：已加入的面料行沿用冻结的 20%，不放宽。
  run(s,{type:'market.marginFloor.set',payload:{family:'fabric',minMarginPercent:'5',effectiveFrom:'2026-10-13',reason:'下调'}},ctx);
  run(s,{type:'market.quotation.save',payload:{id,input:{...base,note:'再改备注',lines:[base.lines[0],fabLine]}}},ctx);
  expect(q().lines[1].marginFloor).toMatchObject({version:1,minMarginPercent:'20'});expect(q().lines[0].marginFloor??null).toBeNull();
 });
 it('a quote with a frozen 15% keeps V1 for edited and newly added same-family lines after the floor drops to 10%, and a forged deletion cannot remove it',()=>{
  const {ctx,s}=setup();const p=run(s,{type:'market.product.save',payload:{input:garment}},ctx).id!,p2=run(s,{type:'market.product.save',payload:{input:{...garment,sku:'G2',name:'外套'}}},ctx).id!;
  setFloor(s,ctx,'15');const base=quote(p),id=run(s,{type:'market.quotation.save',payload:{input:base}},ctx).id!;const q=()=>s.market.quotations.find(x=>x.id===id)!;
  setFloor(s,ctx,'10');
  run(s,{type:'market.quotation.save',payload:{id,input:{...base,lines:[{...base.lines[0],marginFloor:null} as never,{...base.lines[0],productId:p2,name:'外套',style:'G2'}]}}},ctx);
  expect(q().lines.map(l=>[l.marginFloor?.version,l.marginFloor?.minMarginPercent])).toEqual([[1,'15'],[1,'15']]);expect(quotationNeedsApproval(q())).toBe(true);
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
