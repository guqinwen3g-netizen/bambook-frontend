// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MistRoot,ToastProvider} from '../../../../components/mist';
import {createMistState,type MistState} from '../../../../server/src/shared/mistWorkspace';
import type {CrmOpportunity} from '../../../../server/src/shared/mistCrm';
import {Nav} from '../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
vi.mock('../runtime/workspace',()=>({useMistWorkspace:()=>store}));
import {CustomerMailPanel,FollowUpPanel,OpportunityPanel,openOpportunityTotals} from './CustomerRelations';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();let n=0;
const ctx={id:()=>'id-'+(++n),now:'2026-10-14T02:00:00Z',actorName:'顾言'} as any;
const wrap=(node:React.ReactNode)=>act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'crm'},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}>{node}</Nav.Provider></ToastProvider></MistRoot>));
const button=(label:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===label) as HTMLButtonElement|undefined;
const opp=(id:string,patch:Partial<CrmOpportunity>):CrmOpportunity=>({id,customerId:store.state!.customers[0].id,title:'商机 '+id,domain:'garment',stage:'intent',amount:'100.50',currency:'USD',expectedDate:'2026-12-01',owner:'顾言',note:'',lossReason:'',devIds:[],quotationIds:[],orderIds:[],history:[{at:'2026-10-01T00:00:00Z',actor:'顾言',from:null,to:'intent',note:'建立商机'}],createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',...patch});
beforeEach(()=>{store.state=createMistState(ctx,'demo');store.state.crm.opportunities=[];store.state.crm.followUps=[];store.run.mockReset();store.run.mockResolvedValue({result:{id:'x'}});go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('totals open opportunities per currency without mixing currencies or closed deals',()=>{
  const s=store.state!;
  expect(openOpportunityTotals([opp('a',{}),opp('b',{amount:'0.50'}),opp('c',{currency:'EUR',amount:'10'}),opp('d',{stage:'lost',amount:'999'})])).toEqual([{currency:'USD',amount:101,count:2},{currency:'EUR',amount:10,count:1}]);
  expect(s.crm.opportunities).toEqual([]);
});

it('blocks marking an opportunity won until a real order is linked',async()=>{
  const s=store.state!;s.crm.opportunities.push(opp('q',{stage:'quoting'}));
  wrap(<OpportunityPanel customer={s.customers[0]} state={s} can />);
  expect(host.textContent).toContain('进行中 · USD');
  await act(async()=>{(host.querySelector('[role="row"][data-key="q"], [data-row-key="q"]') as HTMLElement|null)?.click();});
  if(!button('推进到已下单'))await act(async()=>{[...host.querySelectorAll('*')].find(el=>el.textContent==='商机 q')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  const won=button('推进到已下单')!;
  expect(won.disabled).toBe(true);
  expect(won.title).toContain('关联实际订单');
  expect(button('发起开发')).toBeDefined();
});

it('shows follow-ups read-only without relation write permission and lists customer mail',()=>{
  const s=store.state!;
  wrap(<><FollowUpPanel customer={s.customers[0]} state={s} can={false} /><CustomerMailPanel customer={s.customers[0]} state={s} /></>);
  expect(host.textContent).toContain('还没有跟进记录');
  expect(button('记录跟进')).toBeUndefined();
  expect(host.textContent).toContain('付款通知：本周汇出尾款');
  expect(host.textContent).toContain('待确认');
});
