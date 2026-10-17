// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevListPage, developmentCsv, developmentDueDays, developmentDueText, developmentTabCounts } from './DevListPage';
import type { Dev } from '../data';
import type { MistDev } from '../../../../server/src/shared/mistWorkspace';
import { Nav, type Route, type RouteTarget } from '../nav';

const bridge=vi.hoisted(()=>({current:null as any}));
vi.mock('../runtime/workspace',()=>({useMistWorkspace:()=>bridge.current}));

describe('development CSV',()=>{
  it('exports exactly the supplied filtered records with real IDs and safe CSV quoting',()=>{
    const row={id:'DEV-7',name:'带"引号,与逗号"',style:'A-7',customer:'真实客户',owner:'负责人',due:'2026-10-30',stage:2,state:'待QC',ver:'R2-A-1',factory:'实际工厂'} as Dev;
    const csv=developmentCsv([row]);
    expect(csv.startsWith('\uFEFF')).toBe(true);expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain('"DEV-7","带""引号,与逗号"""');expect(csv).toContain('"QC 评审"');expect(csv).not.toContain('DEV-G-2026-031');
  });
  it('computes due labels by local calendar days, including near midnight',()=>{
    const now=new Date(2026,9,13,23,59);
    expect(developmentDueDays('2026-10-14',now)).toBe(1);expect(developmentDueText('2026-10-14',now)).toBe('1 天后');
    expect(developmentDueText('2026-10-13',now)).toBe('今天');expect(developmentDueText('2026-10-12',now)).toBe('1 天前');expect(developmentDueDays('2026-02-30',now)).toBeNull();
  });
});

let root:Root|undefined,host:HTMLDivElement;const go=vi.fn();
const dev=(index:number):MistDev=>({id:`real-${index}`,code:`DEV-${index}`,name:`实际开发 ${index}`,style:`STYLE-${index}`,owner:index%2?'甲':'乙',ownerId:index%2?'user-a':'user-b',customer:index%2?'客户 A':'客户 B',customerId:index%2?'a':'b',due:'2026-10-30',dueRel:'待交付',stage:1,state:'工厂制作中',tone:'neutral',ver:'R1-A-1',fac:1,img:'coat',factory:'实际工厂',sample:'未返样',fabric:'羊毛',goal:'实际需求',currentVersionId:`version-${index}`,versionIds:[`version-${index}`],values:{} as any,fileIds:[],createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z'});
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();bridge.current={state:{devs:[dev(1),dev(2)],drafts:[],fabrics:[],customers:[{name:'客户 A'},{name:'客户 B'}],settings:{workspaceName:'测试工作空间'},files:[]},loading:false,error:'',run:vi.fn(async()=>({requestId:'c-1',revision:1,result:{}})),uploadFile:vi.fn(),downloadFile:vi.fn()};});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
/** 与 ReferenceApp 一致：go 写入路由，列表页按路由 section 选择页签。 */
function Harness({initial}:{initial:Route}){const [route,setRoute]=React.useState<Route>(initial);const navigate=(view:string,id?:string,target:RouteTarget={})=>{go(view,id,target);if(view==='development')setRoute({view,id,...target});};return <Nav.Provider value={{route,go:navigate,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><DevListPage/></Nav.Provider>;}
async function mount(initial:Route={view:'development'}){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(<Harness initial={initial}/>));}
const selectedTab=()=>host.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const tabCount=(label:string)=>[...host.querySelectorAll('[role="tab"]')].find(t=>t.textContent?.startsWith(label))?.querySelector('.mist-tab-count')?.textContent;
const pipe=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>('.mist-pipeline > button')].find(b=>b.querySelector('small')?.textContent===label);
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text);
async function type(label:string,value:string){const input=host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
async function tab(label:string){await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button=>button.textContent?.startsWith(label))!.click());}
async function select(label:string,value:string){await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent?.startsWith(label)&&button.hasAttribute('aria-haspopup'))!.click());await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button=>button.textContent===value)!.click());}

describe('persisted workspace development list',()=>{
  it('filters by initiator and category and clears both filters',async()=>{
    const a=dev(1),b=dev(2);a.values={initiator:'internal',category:'大衣'} as any;b.values={initiator:'customer',category:'衬衫'} as any;bridge.current.state.devs=[a,b];
    await mount();await select('发起方','内部需求');expect(host.textContent).toContain('实际开发 1');expect(host.textContent).not.toContain('实际开发 2');
    await select('发起方','全部');await select('品类','衬衫');expect(host.textContent).toContain('实际开发 2');expect(host.textContent).not.toContain('实际开发 1');
    await select('发起方','内部需求');expect(host.textContent).not.toContain('实际开发 2');
    const clear=[...host.querySelectorAll<HTMLElement>('button,a')].find(button=>button.textContent==='清除筛选');expect(clear).toBeTruthy();await act(async()=>clear!.click());expect(host.textContent).toContain('实际开发 1');expect(host.textContent).toContain('实际开发 2');
  });
  it('previews without navigation, then opens the selected actual ID and version',async()=>{
    await mount();const rows=host.querySelectorAll<HTMLElement>('.mist-tr');await act(async()=>rows[1].click());expect(go).not.toHaveBeenCalled();
    const open=[...host.querySelectorAll('button')].find(button=>button.textContent==='打开开发案')!;await act(async()=>open.click());expect(go).toHaveBeenCalledWith('development/detail','real-2',{versionId:'version-2'});
  });
  it('paginates the shared records and resets the page when search changes',async()=>{
    bridge.current.state.devs=Array.from({length:11},(_,index)=>dev(index+1));await mount();expect(host.querySelectorAll('.mist-tr')).toHaveLength(10);
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click());expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);
    const search=host.querySelector<HTMLInputElement>('input[aria-label="名称、客户款式或编号"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'STYLE-2');search.dispatchEvent(new Event('input',{bubbles:true}));});expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.textContent).toContain('实际开发 2');
  });
  it('keeps a failed server stage move in its original column and surfaces the rejection',async()=>{
    bridge.current.run.mockRejectedValueOnce(new Error('须先登记返样'));await mount();await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="看板视图"]')!.click());
    const card=host.querySelector<HTMLElement>('.mist-kb-card')!;await act(async()=>card.dispatchEvent(new Event('dragstart',{bubbles:true})));await act(async()=>host.querySelectorAll('.mist-kb-col')[2].dispatchEvent(new Event('drop',{bubbles:true})));
    expect(bridge.current.run).toHaveBeenCalledWith({type:'development.move',payload:{devId:'real-1',stage:2}});expect(host.textContent).toContain('须先登记返样');expect(bridge.current.state.devs[0].stage).toBe(1);
  });
  it('does not render stale seed relative dates',async()=>{
    const date=new Date();date.setDate(date.getDate()+1);const due=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    bridge.current.state.devs=[{...dev(1),due,dueRel:'过时的种子日期'}];await mount();expect(host.textContent).toContain('1 天后');expect(host.textContent).not.toContain('过时的种子日期');
  });
  it('applies the fabric owner filter and hides inapplicable customer/view controls',async()=>{
    bridge.current.state.fabrics=[{id:'f1',code:'SR-1',name:'甲的面料',owner:'甲',ownerId:'user-a',due:'2026-10-30',state:'寻样中',tone:'neutral',sub:'',request:'需求1',answer:''},{id:'f2',code:'SR-2',name:'乙的面料',owner:'乙',ownerId:'user-b',due:'2026-10-30',state:'寻样中',tone:'neutral',sub:'',request:'需求2',answer:''}];
    await mount();await tab('面料寻样');expect(host.querySelector('[aria-label="看板视图"]')).toBeNull();expect([...host.querySelectorAll('button')].some(button=>button.textContent?.startsWith('客户'))).toBe(false);
    await select('负责人','甲');expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.textContent).toContain('甲的面料');expect(host.textContent).not.toContain('乙的面料');
  });
  it('applies the draft customer filter and does not expose owner/view controls without draft data',async()=>{
    bridge.current.state.drafts=[{id:'d1',values:{name:'甲草稿',style:'A',customer:'客户 A'},updatedAt:'2026-10-13T00:00:00Z'},{id:'d2',values:{name:'乙草稿',style:'B',customer:'客户 B'},updatedAt:'2026-10-13T00:00:00Z'}];
    await mount();expect([...host.querySelectorAll('[role="tab"]')].some(t=>t.textContent?.startsWith('草稿'))).toBe(false);await act(async()=>pipe('草稿')!.click());expect(host.querySelector('[aria-label="看板视图"]')).toBeNull();expect([...host.querySelectorAll('button')].some(button=>button.textContent?.startsWith('负责人'))).toBe(false);
    await select('客户','客户 B');expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.textContent).toContain('乙草稿');expect(host.textContent).not.toContain('甲草稿');expect(pipe('草稿')!.querySelector('b')!.textContent).toBe('1');
  });
});


describe('three sibling development entries',()=>{
 const fabricDev=(index:number)=>({...dev(index),name:`真实面料开发 ${index}`,img:'clay',values:{domain:'fabric',category:'原始斜纹'} as any});
 const fabric=(id:string,owner:string)=>({id,code:'SR-'+id,name:owner+'的面料',owner,due:'2026-10-30',state:'寻样中',tone:'neutral',sub:'',request:'需求',answer:''});
 const draft=(id:string,name:string,domain?:'fabric',customer='客户 A')=>({id,values:{name,style:'S-'+id,customer,...(domain?{domain}:{})},updatedAt:'2026-10-13T00:00:00Z'});
 beforeEach(()=>{const s=bridge.current.state;s.devs=[dev(1),dev(2),fabricDev(3)];s.fabrics=[fabric('f1','甲'),fabric('f2','乙'),fabric('f3','甲')];s.drafts=[draft('g1','成衣草稿'),draft('x1','面料草稿 1','fabric'),draft('x2','面料草稿 2','fabric','客户 B')];});
 it('shows 成衣开发｜面料开发｜面料寻样 as one level with counts that match each list',async()=>{
  await mount();expect([...host.querySelectorAll('[role="tab"]')].map(t=>t.firstChild?.textContent)).toEqual(['成衣开发','面料开发','面料寻样']);
  expect(host.querySelector('[aria-label="开发业务线"]')).toBeNull();expect(selectedTab()).toBe('成衣开发2');
  expect(tabCount('成衣开发')).toBe('2');expect(tabCount('面料开发')).toBe('1');expect(tabCount('面料寻样')).toBe('3');
  expect(host.querySelectorAll('.mist-tr')).toHaveLength(2);expect(pipe('全部')!.querySelector('b')!.textContent).toBe('2');
  await tab('面料开发');expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.textContent).toContain('真实面料开发 3');expect(pipe('全部')!.querySelector('b')!.textContent).toBe('1');
  await tab('面料寻样');expect(host.querySelectorAll('.mist-tr')).toHaveLength(3);expect(pipe('草稿')).toBeUndefined();expect(host.querySelector('.mist-pipeline')).toBeNull();
  expect(developmentTabCounts(bridge.current.state.devs,bridge.current.state.drafts,bridge.current.state.fabrics)).toEqual({garment:2,fabric:1,sourcing:3,drafts:{garment:1,fabric:2}});
 });
 it('keeps stage and draft counts on the same filters as the list and isolates drafts by business line',async()=>{
  await mount();expect(pipe('草稿')!.querySelector('b')!.textContent).toBe('1');
  await select('客户','客户 A');expect(pipe('全部')!.querySelector('b')!.textContent).toBe(String(host.querySelectorAll('.mist-tr').length));expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);
  await act(async()=>pipe('草稿')!.click());expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.textContent).toContain('成衣草稿');expect(host.textContent).not.toContain('面料草稿');
  await tab('面料开发');expect(pipe('草稿')!.querySelector('b')!.textContent).toBe('2');await act(async()=>pipe('草稿')!.click());expect(host.querySelectorAll('.mist-tr')).toHaveLength(2);expect(host.textContent).not.toContain('成衣草稿');
  await select('客户','客户 B');expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(pipe('草稿')!.querySelector('b')!.textContent).toBe('1');
  await act(async()=>host.querySelector<HTMLElement>('.mist-tr')!.click());expect(go).toHaveBeenLastCalledWith('development/new','x2',{section:'fabric'});
 });
 it('resets category, owner, customer, initiator, stage, search and page when switching tabs',async()=>{
  const a=dev(1),b=dev(2);a.values={initiator:'internal',category:'大衣'} as any;b.values={initiator:'customer',category:'衬衫'} as any;bridge.current.state.devs=[a,b,fabricDev(3),...Array.from({length:10},(_,i)=>dev(i+10))];
  await mount();await type('名称、客户款式或编号','STYLE-1');await select('品类','大衣');await select('发起方','内部需求');await select('客户','客户 A');await select('负责人','甲');await act(async()=>pipe('工厂与实物')!.click());
  expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);
  await tab('面料开发');expect(go).toHaveBeenLastCalledWith('development',undefined,{section:'fabric'});expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.querySelector<HTMLInputElement>('input[aria-label="名称、客户款式或编号"]')!.value).toBe('');
  expect(host.textContent).not.toContain('大衣');expect(pipe('全部')!.getAttribute('aria-pressed')).toBe('true');
  await tab('成衣开发');expect(host.querySelectorAll('.mist-tr')).toHaveLength(10);await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click());expect(host.querySelectorAll('.mist-tr')).toHaveLength(2);
  await tab('面料寻样');await tab('成衣开发');expect(host.querySelectorAll('.mist-tr')).toHaveLength(10);
 });
 it.each([[undefined,'成衣开发'],['garment','成衣开发'],['fabric','面料开发'],['sourcing','面料寻样'],['unknown','成衣开发']])('restores the tab from route section %s',async(section,label)=>{
  await mount({view:'development',section});expect(selectedTab()?.startsWith(label)).toBe(true);
 });
 it.each([['成衣开发','新建成衣开发案','development/new',undefined,{section:'garment'}],['面料开发','新建面料开发案','development/new',undefined,{section:'fabric'}],['面料寻样','新建面料寻样','development','new',{section:'sourcing'}]] as const)('%s keeps one primary action that enters its own create flow',async(label,text,view,id,target)=>{
  await mount();await tab(label);go.mockClear();
  const primary=[...host.querySelectorAll<HTMLButtonElement>('.mist-page-head-acts button')];
  expect(primary.map(b=>b.textContent)).toEqual([text]);expect(button('新建开发案')).toBeUndefined();
  await act(async()=>primary[0].click());expect(go).toHaveBeenCalledWith(view,id,target);expect(document.body.textContent).not.toContain('选择开发业务线');
 });
 it('opens the sourcing form from its create route and returns to the sourcing list when closed',async()=>{
  bridge.current.state.settings.profileName='乙';await mount({view:'development',id:'new',section:'sourcing'});
  expect(selectedTab()?.startsWith('面料寻样')).toBe(true);expect(document.body.textContent).toContain('新建面料寻样');expect(document.body.textContent).toContain('创建寻样任务');
  expect(document.body.textContent).not.toMatch(/转为开发|转开发|去开发/);
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='关闭')!.click());expect(go).toHaveBeenLastCalledWith('development',undefined,{section:'sourcing'});expect(document.body.textContent).not.toContain('创建寻样任务');
 });
});
