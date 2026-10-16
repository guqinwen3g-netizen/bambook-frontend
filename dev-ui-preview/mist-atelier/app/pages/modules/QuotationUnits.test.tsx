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
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:'sales'},hasPermission:()=>true,hasRole:()=>false,canAccessView:()=>true})}));
let host:HTMLDivElement,root:Root|undefined;const go=vi.fn();
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();let next=0;const ctx:MistContext={id:()=>`unit-test-${++next}`,actorName:'业务员',now:'2026-10-16T00:00:00.000Z'};const state=createMistState(ctx);state.market=createMarketState(ctx,state);state.market.quotations=[];state.customers=[{id:'c1',name:'现有客户',code:'C1',country:'',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''}];
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

describe('BB-QUO-1 quotation editor units',()=>{
 it('leaves the unit empty for a fabric development version and only offers 米 / 码 / 公斤',async()=>{
  await toLines();expect(el('条目1单位').tagName).toBe('INPUT');expect(el('条目1单位').value).toBe('');
  await fill('条目1来源','v:'+fabricVersion().id);
  expect(el('条目1单位').tagName).toBe('SELECT');expect(el('条目1单位').value).toBe('');expect(options('条目1单位')).toEqual(['','米','码','公斤']);
  expect(host.textContent).toContain('面料按 米 / 码 / 公斤 计价，不换算');
  await fill('条目1款号','F-STYLE-1');await fill('条目1单价','3.20');await click('下一步');
  expect(host.textContent).toContain('第 1 个条目计价单位：请从 米 / 码 / 公斤 中选择');expect(host.textContent).toContain('第 2 / 3 步');
  await fill('条目1单位','码');await click('下一步');await click('保存报价草稿');
  const command=bridge.current.run.mock.calls.at(-1)[0];expect(command.type).toBe('market.quotation.save');expect(command.payload.input.lines[0].unit).toBe('码');
 });
 it('offers only 件 / 套 for garment versions and clears the unit when switching source',async()=>{
  await toLines();await fill('条目1来源','v:'+garmentVersion().id);expect(options('条目1单位')).toEqual(['','件','套']);await fill('条目1单位','套');
  await fill('条目1来源','v:'+fabricVersion().id);expect(el('条目1单位').value).toBe('');expect(options('条目1单位')).toEqual(['','米','码','公斤']);
 });
 it('does not carry an illegal archive unit into a fabric line',async()=>{
  await toLines();const p=bridge.current.state.market.products.find((x:any)=>x.sku==='LEGACY-F');await fill('条目1来源','p:'+p.id);
  expect(el('条目1单位').value).toBe('');await click('下一步');expect(host.textContent).toContain('请从 米 / 码 / 公斤 中选择');
 });
});
