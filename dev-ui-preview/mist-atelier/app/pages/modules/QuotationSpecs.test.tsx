// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MARKET_PAGES} from './MarketPages';
import {Nav} from '../../nav';
import {createMistState,type MistContext} from '../../../../../server/src/shared/mistWorkspace';
import {createMarketState,applyMarketCommand} from '../../../../../server/src/shared/mistMarket';
import {developmentDomain} from '../../../../../server/src/shared/mistDevelopmentDomain';
const bridge=vi.hoisted(()=>({current:null as any}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>bridge.current}));
vi.mock('../../runtime/auth', () => { const useMistSession = ()=>({user:{id:'sales'},hasPermission:()=>true,hasRole:()=>false,canAccessView:()=>true}); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host:HTMLDivElement,root:Root|undefined;const go=vi.fn();
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();let next=0;const ctx:MistContext={id:()=>`spec-test-${++next}`,actorName:'业务员',now:'2026-10-16T00:00:00.000Z'};const state=createMistState(ctx);state.market=createMarketState(ctx,state);state.market.quotations=[];state.customers=[{id:'c1',name:'现有客户',code:'C1',country:'',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''}];
 applyMarketCommand(state,{type:'market.product.save',payload:{input:{sku:'LEGACY-F',name:'旧单位面料',category:'fabric',season:'',supplierId:'',supplierCode:'',composition:'',specification:'',color:'',unit:'件',cost:'1.00',currency:'USD',sourceDevId:'',sourceVersionId:''}}} as any,ctx);
 bridge.current={state,loading:false,saving:false,error:'',pending:null,pendingCreate:null,run:vi.fn(async()=>({requestId:'req-1',revision:1,result:{id:'saved-quote'}})),uploadFile:vi.fn(),downloadFile:vi.fn(),refresh:vi.fn()};});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
async function mount(){host=document.createElement('div');document.body.append(host);root=createRoot(host);const Page=MARKET_PAGES.quotations;await act(async()=>root!.render(<Nav.Provider value={{route:{view:'quotations'},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><Page/></Nav.Provider>));}
async function click(label:string){const button=[...document.body.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);expect(button,label).toBeTruthy();await act(async()=>button!.click());}
const el=(label:string)=>host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement|HTMLSelectElement;
async function fill(label:string,value:string){const e=el(label);expect(e,label).toBeTruthy();await act(async()=>{const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value')!.set!.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});}
async function toLines(){await mount();await click('新建报价');await fill('有效期','2026-12-01');await fill('贸易术语','FOB 上海');await fill('付款条件','T/T');await click('下一步');}
const options=(label:string)=>[...(el(label) as HTMLSelectElement).options].map(o=>o.value);
const fabricVersion=()=>{const s=bridge.current.state;return s.versions.find((v:any)=>developmentDomain(s.devs.find((d:any)=>d.id===v.devId).values)==='fabric');};
const garmentVersion=()=>{const s=bridge.current.state;return s.versions.find((v:any)=>developmentDomain(s.devs.find((d:any)=>d.id===v.devId).values)==='garment');};

describe('BB-QUO-2 quotation line specs and MOQ',()=>{
 it('prefills composition / weight / width from the product archive, leaves missing values as 未填写 and hints below MOQ',async()=>{
  const s=bridge.current.state;applyMarketCommand(s,{type:'market.product.save',payload:{input:{sku:'SPEC-F',name:'府绸',category:'fabric',season:'',supplierId:'',supplierCode:'',composition:'100% 棉',specification:'',color:'',unit:'米',cost:'1.00',currency:'USD',sourceDevId:'',sourceVersionId:'',specs:{weight:'120'}}}} as any,{id:()=>'spec-p',actorName:'业务员',now:'2026-10-16T00:00:00.000Z'});
  await toLines();await fill('条目1来源','p:spec-p');
  expect(el('条目1成分').value).toBe('100% 棉');expect(el('条目1克重').value).toBe('120');expect(el('条目1门幅').value).toBe('');expect(el('条目1每色 MOQ数量').value).toBe('');
  expect(options('条目1每色 MOQ单位')).toEqual(['','米','码','公斤']);
  await fill('条目1每色 MOQ数量','1000');await fill('条目1每色 MOQ单位','米');await fill('条目1数量','500');
  expect(host.textContent).toContain('低于 MOQ：报价 500 米，每色 MOQ 1000 米；仅提示，不触发审批');
  await click('下一步');expect(host.textContent).toContain('低于 MOQ');await click('保存报价草稿');
  const command=bridge.current.run.mock.calls.at(-1)[0];expect(command.payload.input.lines[0].specs).toMatchObject({composition:'100% 棉',weight:'120',moqQty:'1000',moqUnit:'米'});
 });
 it('garment lines offer 尺码段 / 主面料 and MOQ in 件 / 套',async()=>{
  await toLines();const v=garmentVersion();await fill('条目1来源','v:'+v.id);
  expect(el('条目1尺码段').value).toBe(v.size||'');expect(options('条目1MOQ单位')).toEqual(['','件','套']);expect(el('条目1成分')).toBeNull();
 });
 it('quotation detail shows structured specs with 未填写 and a 低于 MOQ pill; legacy lines without specs still render',async()=>{
  const s=bridge.current.state;applyMarketCommand(s,{type:'market.product.save',payload:{input:{sku:'SPEC-D',name:'府绸',category:'fabric',season:'',supplierId:'',supplierCode:'',composition:'',specification:'',color:'',unit:'米',cost:'1.00',currency:'USD',sourceDevId:'',sourceVersionId:''}}} as any,{id:()=>'spec-d',actorName:'业务员',now:'2026-10-16T00:00:00.000Z'});
  const base={productId:'spec-d',sourceDevId:'',sourceVersionId:'',style:'SPEC-D',specification:'',unit:'米',price:'2.00',cost:'1.00',amount:'1000.00',qty:'500'};
  s.market.quotations.push({id:'qd',code:'QT-SPEC-1',customerId:s.customers[0].id,currency:'USD',season:'',validUntil:'2026-12-31',deliveryTerms:'FOB',paymentTerms:'TT',status:'Draft',lines:[{...base,id:'l1',name:'新条目',specs:{weight:'120',moqQty:'1000',moqUnit:'米'}},{...base,id:'l2',name:'历史条目'}],total:'2000.00',deliveryEvidence:'',responseEvidence:'',approval:null,convertedOrderId:null,fileIds:[],createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);const Page=MARKET_PAGES.quotations;
  await act(async()=>root!.render(<Nav.Provider value={{route:{view:'quotations',id:'qd'},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><Page/></Nav.Provider>));
  const specs=[...host.querySelectorAll('[data-quote-specs]')].map(x=>x.textContent);
  expect(specs[0]).toBe('成分 未填写 · 克重 120 g/m² · 门幅 未填写 · 每色 MOQ 1000 米');expect(specs[1]).toContain('每色 MOQ 未填写');
  expect(host.querySelectorAll('[data-quote-moq="below"]').length).toBe(1);expect(host.textContent).toContain('低于 MOQ');
 });
});
