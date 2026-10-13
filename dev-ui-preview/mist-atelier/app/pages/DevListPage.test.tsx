// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevListPage, developmentCsv, developmentDueDays, developmentDueText } from './DevListPage';
import type { Dev } from '../data';
import type { MistDev } from '../../../../server/src/shared/mistWorkspace';
import { Nav } from '../nav';

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
const dev=(index:number):MistDev=>({id:`real-${index}`,code:`DEV-${index}`,name:`实际开发 ${index}`,style:`STYLE-${index}`,owner:index%2?'甲':'乙',customer:index%2?'客户 A':'客户 B',customerId:index%2?'a':'b',due:'2026-10-30',dueRel:'待交付',stage:1,state:'工厂制作中',tone:'neutral',ver:'R1-A-1',fac:1,img:'coat',factory:'实际工厂',sample:'未返样',fabric:'羊毛',goal:'实际需求',currentVersionId:`version-${index}`,versionIds:[`version-${index}`],values:{} as any,fileIds:[],createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z'});
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();bridge.current={state:{devs:[dev(1),dev(2)],drafts:[],fabrics:[],customers:[{name:'客户 A'},{name:'客户 B'}],settings:{workspaceName:'测试工作空间'},files:[]},loading:false,error:'',run:vi.fn(async()=>({requestId:'c-1',revision:1,result:{}})),uploadFile:vi.fn(),downloadFile:vi.fn()};});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
async function mount(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(<Nav.Provider value={{route:{view:'development'},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><DevListPage/></Nav.Provider>));}
async function tab(label:string){await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button=>button.textContent?.startsWith(label))!.click());}
async function select(label:string,value:string){await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent?.startsWith(label)&&button.hasAttribute('aria-haspopup'))!.click());await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button=>button.textContent===value)!.click());}

describe('persisted workspace development list',()=>{
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
    bridge.current.state.fabrics=[{id:'f1',code:'SR-1',name:'甲的面料',owner:'甲',due:'2026-10-30',state:'寻样中',tone:'neutral',sub:'',request:'需求1',answer:''},{id:'f2',code:'SR-2',name:'乙的面料',owner:'乙',due:'2026-10-30',state:'寻样中',tone:'neutral',sub:'',request:'需求2',answer:''}];
    await mount();await tab('面料寻样');expect(host.querySelector('[aria-label="看板视图"]')).toBeNull();expect([...host.querySelectorAll('button')].some(button=>button.textContent?.startsWith('客户'))).toBe(false);
    await select('负责人','甲');expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.textContent).toContain('甲的面料');expect(host.textContent).not.toContain('乙的面料');
  });
  it('applies the draft customer filter and does not expose owner/view controls without draft data',async()=>{
    bridge.current.state.drafts=[{id:'d1',values:{name:'甲草稿',style:'A',customer:'客户 A'},updatedAt:'2026-10-13T00:00:00Z'},{id:'d2',values:{name:'乙草稿',style:'B',customer:'客户 B'},updatedAt:'2026-10-13T00:00:00Z'}];
    await mount();await tab('草稿');expect(host.querySelector('[aria-label="看板视图"]')).toBeNull();expect([...host.querySelectorAll('button')].some(button=>button.textContent?.startsWith('负责人'))).toBe(false);
    await select('客户','客户 B');expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.textContent).toContain('乙草稿');expect(host.textContent).not.toContain('甲草稿');
  });
});


describe('separate fabric and garment development entry',()=>{
 it('selects the business line before entering the existing five-step layout',async()=>{await mount();await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='新建开发案')!.click());expect(go).not.toHaveBeenCalled();await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('面料开发')&&b.textContent?.includes('目标规格'))!.click());expect(go).toHaveBeenCalledWith('development/new',undefined,{section:'fabric'});});
 it('filters by saved domain rather than arbitrary classification strings',async()=>{bridge.current.state.devs.push({...dev(3),name:'真实面料开发',img:'clay',values:{domain:'fabric',category:'原始斜纹'}});await mount();expect(host.querySelectorAll('.mist-tr')).toHaveLength(2);await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='面料开发')!.click());expect(host.querySelectorAll('.mist-tr')).toHaveLength(1);expect(host.textContent).toContain('真实面料开发');expect(host.textContent).not.toContain('实际开发 1');});
});
