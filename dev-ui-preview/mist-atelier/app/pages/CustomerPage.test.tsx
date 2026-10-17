// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {getByRole,queryByRole} from '@testing-library/dom';
import {CustomerPage} from './CustomerPage';
import {Nav} from '../nav';
import {createMistState} from '../../../../server/src/shared/mistWorkspace';
const bridge=vi.hoisted(()=>({current:null as any,canCreate:true}));
vi.mock('../runtime/workspace',()=>({useMistWorkspace:()=>bridge.current}));
vi.mock('../runtime/auth', () => { const useMistSession = ()=>({user:{id:'local',displayName:'本地操作员'},hasPermission:()=>bridge.canCreate}); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host:HTMLDivElement,root:Root|undefined;const go=vi.fn(),openAI=vi.fn();
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();openAI.mockReset();bridge.canCreate=true;const state=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T08:00:00Z',actorName:'本地操作员'},'empty');bridge.current={state,workspace:{id:'w',ownerId:'local'},loading:false,saving:false,pending:null,pendingCreate:null,error:'',run:vi.fn(async()=>({requestId:'saved',revision:1,result:{id:'created-customer',customerId:'created-customer'}})),refresh:vi.fn(),downloadFile:vi.fn()};});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
async function mount(id?:string){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(<Nav.Provider value={{route:{view:'crm',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI}}><CustomerPage/></Nav.Provider>));}
async function click(label:string){await act(async()=>getByRole(host,'button',{name:label}).click());}
async function fill(label:string,value:string){const element=host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement|HTMLSelectElement;expect(element,label).toBeTruthy();await act(async()=>{const proto=element.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));});}
async function complete(){await click('新建客户');await fill('客户名称','新客户贸易公司');await fill('国家','中国');await fill('城市','上海');await click('下一步');await fill('付款条款','T/T 30/70');await fill('贸易术语','FOB 上海');await fill('合作起始日','2026-10-13');await click('下一步');await fill('信用额度','1000');await click('下一步');}
const customer=(id:string)=>({id,code:'CUS-'+id,name:'客户-'+id,country:'CN',city:'上海',industry:'服装',owner:'本地操作员',grade:'A',currency:'USD',terms:'T/T',incoterm:'FOB',categories:'成衣',creditLimit:0,since:'2026-10-13'});
describe('Mist customer creation and selection',()=>{
 it('offers first-customer creation from an empty workspace and navigates by the saved customer ID',async()=>{await mount();expect(host.textContent).toContain('还没有客户档案');await complete();await click('创建客户档案');expect(bridge.current.run).toHaveBeenCalledWith({type:'market.customer.create',payload:{input:expect.objectContaining({name:'新客户贸易公司',ownerId:'local',currency:'USD',country:'中国',city:'上海',terms:'T/T 30/70',incoterm:'FOB 上海',since:'2026-10-13',creditLimit:1000})}});expect(go).toHaveBeenCalledWith('crm','created-customer',{customerId:'created-customer'});});
 it('keeps the new customer form and entered values after a failed save',async()=>{bridge.current.run.mockRejectedValueOnce(new Error('本地保存失败'));await mount();await complete();await click('创建客户档案');expect(host.textContent).toContain('本地保存失败');expect(go).not.toHaveBeenCalled();await click('上一步');expect((host.querySelector('[aria-label="信用额度"]') as HTMLInputElement).value).toBe('1000');await click('上一步');expect((host.querySelector('[aria-label="贸易术语"]') as HTMLInputElement).value).toBe('FOB 上海');await click('上一步');expect((host.querySelector('[aria-label="客户名称"]') as HTMLInputElement).value).toBe('新客户贸易公司');});
 it('preserves the T7 detail layout and selects an exact different customer',async()=>{bridge.current.state.customers=[customer('a'),customer('b')];await mount('a');expect(host.querySelector('.mist-detail[data-layout="main-rail"]')).not.toBeNull();expect(host.textContent).toContain('客户-a');await fill('选择客户','b');expect(go).toHaveBeenCalledWith('crm','b',{customerId:'b'});expect(bridge.current.run).not.toHaveBeenCalled();});
 it('does not silently substitute the first customer for a missing requested ID',async()=>{bridge.current.state.customers=[customer('a')];await mount('deleted');expect(host.textContent).toContain('没有找到指定客户');expect(host.querySelector('.mist-detail')).toBeNull();expect(queryByRole(host,'button',{name:'新建客户'})).not.toBeNull();});
 it('hides creation without customer-write permission',async()=>{bridge.canCreate=false;await mount();expect(queryByRole(host,'button',{name:'新建客户'})).toBeNull();expect(bridge.current.run).not.toHaveBeenCalled();});
});

describe('CRM relation and contact command routing',()=>{
 it('preserves a primary contact and keeps the dialog open after a failed synchronized save',async()=>{
  bridge.current.state.customers=[customer('a')];bridge.current.state.contacts=[{id:'contact-a',customerId:'a',name:'采购甲',role:'采购',email:'old@example.com',phone:'123',tone:'neutral'}];bridge.current.state.market.relations=[{id:'relation-a',customerId:'a',supplierId:'',category:'Customer',name:'客户-a',country:'CN',address:'',aliases:[],status:'active',contacts:[{id:'contact-a',name:'采购甲',role:'采购',email:'old@example.com',phone:'123',primary:true}],fileIds:[],note:'',createdAt:'',updatedAt:''}];bridge.current.run.mockRejectedValueOnce(new Error('联系人未同步'));
  await mount('a');const contact=[...document.body.querySelectorAll('button')].find(b=>b.textContent?.includes('采购甲'))!;await act(async()=>contact.click());const dialog=getByRole(document.body,'dialog',{name:'编辑联系人'}),email=dialog.querySelector<HTMLInputElement>('input[type="email"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(email,'new@example.com');email.dispatchEvent(new Event('input',{bubbles:true}));});await act(async()=>getByRole(dialog,'button',{name:'保存',exact:true} as any).click());
  expect(bridge.current.run).toHaveBeenCalledWith({type:'market.contact.save',payload:expect.objectContaining({kind:'customer',parentId:'a',id:'contact-a',email:'new@example.com',primary:true})});expect(dialog.textContent).toContain('联系人未同步');expect(email.value).toBe('new@example.com');
 });
});

describe('truthful customer utility actions',()=>{
 it('disables mail without an address and tells the user it uses the local mail application',async()=>{
  bridge.current.state.customers=[customer('a')];await mount('a');const button=getByRole(host,'button',{name:'写邮件'}) as HTMLButtonElement;expect(button.disabled).toBe(true);expect(button.title).toContain('有效邮箱');
 });
 it('opens insights with the actual current customer facts and counts business events accurately',async()=>{
  bridge.current.state.customers=[customer('a')];bridge.current.state.events=[{id:'event-a',entityType:'customer',entityId:'a',actor:'业务员',at:new Date().toISOString(),text:'更新客户资料',fileIds:[]},{id:'old-event',entityType:'customer',entityId:'a',actor:'业务员',at:'2020-01-01T00:00:00Z',text:'历史动态',fileIds:[]}];await mount('a');await click('展开');expect(openAI).toHaveBeenCalledWith(expect.stringContaining('0 个在途订单，0 个开发案'));
  await act(async()=>getByRole(host,'button',{name:'业务动态统计'}).click());const dialog=getByRole(document.body,'dialog',{name:'业务动态统计'});expect(dialog.textContent).toContain('全部业务动态');expect(dialog.textContent).toContain('最近 30 天业务动态');expect(dialog.textContent).toContain('2');expect(dialog.textContent).toContain('1');
 });
});

describe('customer default currency',()=>{
 it('uses the workspace currency only for a new customer',async()=>{
  bridge.current.state.settings.companyProfile={defaultCurrency:'JPY'};await mount();await click('新建客户');await fill('客户名称','日本客户');await click('下一步');expect((host.querySelector('[aria-label="结算币种"]') as HTMLSelectElement).value).toBe('JPY');
 });
 it('keeps an existing customer currency when workspace currency differs',async()=>{
  bridge.current.state.settings.companyProfile={defaultCurrency:'CNY'};bridge.current.state.customers=[{...customer('a'),currency:'JPY'}];await mount('a');await act(async()=>getByRole(host,'button',{name:'编辑客户资料'}).click());const dialog=getByRole(document.body,'dialog',{name:'编辑客户资料'});expect((dialog.querySelector('select[aria-label="结算币种"]') as HTMLSelectElement|null)?.value).toBe('JPY');
 });
});
