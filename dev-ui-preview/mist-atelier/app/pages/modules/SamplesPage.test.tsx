// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getAllByRole,getByRole} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {FulfillmentSample} from '../../../../../server/src/shared/mistFulfillment';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
const write=vi.hoisted(()=>({allowed:true}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:'sales',displayName:'业务员'},sessionKey:'s',hasPermission:()=>write.allowed,canAccessView:()=>true})}));
import {SamplesPage} from './SamplesPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();
function render(id?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'samples',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><SamplesPage/></Nav.Provider></ToastProvider></MistRoot>));}
const version={kind:'version' as const,devId:'dev',versionId:'ver'};
function fabric(id:string,form:string,unit:string,quantity:number,available:number):FulfillmentSample{return {id,code:id.toUpperCase(),name:'亚麻平纹',category:'面料',form,unit,quantity,available,location:'A-01',size:'',color:'',source:version,fileIds:[],note:'',createdAt:'2026-10-10T08:00:00Z'};}
beforeEach(()=>{write.allowed=true;store.state=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T10:00:00Z',actorName:'业务员'},'empty');store.run.mockReset();go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('groups fabric forms of one archive into a single row and never sums different units',()=>{
  store.state!.fulfillment.samples.push(fabric('smp-m','米样','米',12.5,12.5),fabric('smp-c','色卡','份',3,3));
  render();
  const table=getByRole(host,'table',{name:'样品台账'});
  expect(getAllByRole(table,'row').filter(row=>row.textContent?.includes('亚麻平纹'))).toHaveLength(1);
  expect(table.textContent).toContain('米样 · 12.5 米 可用');expect(table.textContent).toContain('色卡 · 3 份 可用');
  expect(table.textContent).not.toContain('15.5');
  expect(host.querySelectorAll('[data-sample-form]')).toHaveLength(2);
});

it('flags overdue loans and explains why return is unavailable',()=>{
  const sample=fabric('smp-m','米样','米',10,8);store.state!.fulfillment.samples.push(sample);
  store.state!.fulfillment.sampleMovements.push({id:'loan',sampleId:'smp-m',kind:'lend',quantity:2,person:'李工',location:'工厂',note:'',at:'2026-10-01T08:00:00Z',actor:'业务员',expectedReturn:'2026-10-05'});
  render('smp-m');
  expect(host.textContent).toContain('1 笔借出已超过预计归还日');expect(host.textContent).toContain('逾期未还');
  expect((getByRole(host,'button',{name:'归还'}) as HTMLButtonElement).disabled).toBe(false);
  store.state!.fulfillment.sampleMovements=[];render('smp-m');
  expect((getByRole(host,'button',{name:'归还'}) as HTMLButtonElement).disabled).toBe(true);
  expect(host.textContent).toContain('归还：没有未归还的借出');
});

it('keeps the ledger readable without write permission and states the reason on actions',()=>{
  write.allowed=false;store.state!.fulfillment.samples.push(fabric('smp-m','米样','米',10,10));render('smp-m');
  expect(host.textContent).toContain('只读查看');
  expect((getByRole(host,'button',{name:'借出'}) as HTMLButtonElement).disabled).toBe(true);
  expect(host.textContent).toContain('借出：没有样品写权限');
  expect(host.textContent).not.toContain('新建样品');
});

it('opens a quick movement dialog over the ledger instead of replacing the page',async()=>{
  store.state!.fulfillment.samples.push({...fabric('smp-g','开发样','件',1,1),category:'成衣',size:'M',color:'藏青'});render('smp-g');
  await act(async()=>getByRole(host,'button',{name:'寄出'}).click());
  expect(getByRole(document.body,'dialog',{name:/登记永久寄出/})).toBeTruthy();
  expect(getByRole(host,'table',{name:'样品台账'})).toBeTruthy();
});
