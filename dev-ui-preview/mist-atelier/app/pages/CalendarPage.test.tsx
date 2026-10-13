// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMistCommand, createMistState, type MistCommand } from '../../../../server/src/shared/mistWorkspace';
import { CalendarPage, calendarFormError, calendarWeek } from './CalendarPage';
import { Nav } from '../nav';

const bridge=vi.hoisted(()=>({current:null as any,sessionKey:'session-a'}));
vi.mock('../runtime/workspace',()=>({useMistWorkspace:()=>bridge.current}));
vi.mock('../runtime/auth',()=>({useMistSession:()=>({sessionKey:bridge.sessionKey})}));
let root:Root|undefined,host:HTMLDivElement;const go=vi.fn();
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const originalTarget={view:'development/detail',id:'dev-a',versionId:'original-version'};
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();bridge.sessionKey='session-a';let sequence=0;
  const context={id:()=>`calendar-${++sequence}`,now:new Date().toISOString(),actorName:'日程创建人'};
  const state=createMistState(context,'empty');state.calendar=[{id:'event-a',title:'已保存的评审',date:today(),time:'14:00',note:'原始说明',target:originalTarget}];
  bridge.current={state,workspace:{id:'workspace-a'},loading:false,saving:false,error:'',pending:null,refresh:vi.fn(async()=>{}),recover:vi.fn(),run:vi.fn(async(command:MistCommand)=>{const result=applyMistCommand(bridge.current.state,command,context);bridge.current.state=result.state;return{requestId:'request-a',revision:1,result:result.result};})};
});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
const view=()=> <Nav.Provider value={{route:{view:'calendar'},go,theme:'light' as const,toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><CalendarPage/></Nav.Provider>;
async function mount(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(view()));}
async function click(text:string){const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()===text||item.getAttribute('aria-label')===text);expect(button,text).toBeTruthy();await act(async()=>button!.click());}
async function fill(label:string,value:string){const field=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')===label);const control=field?.querySelector('input,textarea') as HTMLInputElement|HTMLTextAreaElement;expect(control,label).toBeTruthy();await act(async()=>{const prototype=control.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(control,value);control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));});}

describe('Mist calendar',()=>{
  it('builds a Monday-first week across the year boundary and validates date/time values',()=>{
    expect(calendarWeek('2026-12-31').map(day=>day.key)).toEqual(['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);
    expect(calendarFormError({title:'评审',date:'2026-02-31',time:'14:00'})).toContain('日期');
    expect(calendarFormError({title:'评审',date:'2026-10-12',time:'14:70'})).toContain('时间');
  });
  it('creates a real command and displays the shared server result',async()=>{
    await mount();await click('新建日程');await fill('日程名称','新客户会议');await fill('日期',today());await fill('时间','16:20');await fill('安排说明','带款式资料');await click('保存日程');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'calendar.save',payload:{title:'新客户会议',date:today(),time:'16:20',note:'带款式资料'}});
    expect(host.textContent).toContain('新客户会议');expect(document.querySelector('[data-calendar-editor]')).toBeNull();
  });
  it('edits the original calendar ID and preserves the exact version association',async()=>{
    await mount();await click('已保存的评审');await fill('日程名称','评审调整');await click('保存日程');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'calendar.save',payload:{id:'event-a',title:'评审调整',date:today(),time:'14:00',note:'原始说明',target:originalTarget}});
    expect(bridge.current.state.calendar).toHaveLength(1);expect(host.textContent).toContain('评审调整');
  });
  it('opens the linked business object with every exact target field',async()=>{
    await mount();await click('打开关联业务');expect(go).toHaveBeenCalledWith('development/detail','dev-a',originalTarget);
  });
  it('retains form input after a rejected save rather than closing or claiming success',async()=>{
    bridge.current.run.mockRejectedValueOnce(new Error('服务器拒绝保存'));await mount();await click('已保存的评审');await fill('日程名称','未保存修改');await click('保存日程');
    expect(document.querySelector('[data-calendar-editor]')).not.toBeNull();expect(document.body.textContent).toContain('服务器拒绝保存');expect((document.querySelector('[data-calendar-editor] input') as HTMLInputElement).value).toBe('未保存修改');expect(bridge.current.state.calendar[0].title).toBe('已保存的评审');
  });
  it('shows an empty day after changing the week, without inventing example events',async()=>{
    await mount();await click('下一周');expect(host.textContent).toContain('当天暂无日程');expect(host.textContent).not.toContain('已保存的评审');await click('今天');expect(host.textContent).toContain('已保存的评审');
  });
  it('offers a real reload after a read error',async()=>{
    bridge.current.state=null;bridge.current.error='当前工作空间读取失败';await mount();expect(host.textContent).toContain('当前工作空间读取失败');await click('重试读取');expect(bridge.current.refresh).toHaveBeenCalledTimes(1);
  });
  it('shows Mist loading skeletons without presenting example events',async()=>{
    bridge.current.state=null;bridge.current.loading=true;await mount();expect(host.querySelectorAll('.mist-skel').length).toBeGreaterThan(0);expect(host.textContent).not.toContain('已保存的评审');
    expect([...host.querySelectorAll('button')].find(button=>button.textContent?.trim()==='新建日程')?.disabled).toBe(true);
  });
  it('recovers the original calendar command without issuing a second save',async()=>{
    await mount();await click('已保存的评审');bridge.current.pending={kind:'command',command:{type:'calendar.save'}};bridge.current.recover.mockResolvedValue({requestId:'original',revision:2,result:{id:'event-a'}});await act(async()=>root!.render(view()));
    await click('核对原操作结果');expect(bridge.current.run).not.toHaveBeenCalled();expect(document.querySelector('[data-calendar-editor]')).toBeNull();
  });
  it.each(['workspace','session'])('clears the editor and its original target after a %s change',async kind=>{
    await mount();await click('已保存的评审');await fill('日程名称','旧空间未保存输入');
    if(kind==='workspace')bridge.current.workspace={id:'workspace-b'};else bridge.sessionKey='session-b';
    await act(async()=>root!.render(view()));expect(document.querySelector('[data-calendar-editor]')).toBeNull();await click('新建日程');
    expect((document.querySelector('[data-calendar-editor] input') as HTMLInputElement).value).toBe('');
    expect((document.querySelector('[data-calendar-editor] select') as HTMLSelectElement).value).toBe('');
  });
  it('does not let an old save close or unlock a new workspace save',async()=>{
    let finishOld!:(value:any)=>void,finishNew!:(value:any)=>void;
    bridge.current.run.mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve;})).mockImplementationOnce(()=>new Promise(resolve=>{finishNew=resolve;}));
    await mount();await click('已保存的评审');await fill('日程名称','旧空间保存');await click('保存日程');
    bridge.current.workspace={id:'workspace-b'};await act(async()=>root!.render(view()));await click('新建日程');await fill('日程名称','新空间保存');await click('保存日程');
    await act(async()=>finishOld({requestId:'old',revision:1,result:{id:'old'}}));
    expect(document.querySelector('[data-calendar-editor]')).not.toBeNull();expect((document.querySelector('[data-calendar-editor] input') as HTMLInputElement).value).toBe('新空间保存');expect((document.querySelector('[data-calendar-editor] fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    await act(async()=>finishNew({requestId:'new',revision:1,result:{id:'new'}}));expect(document.querySelector('[data-calendar-editor]')).toBeNull();
  });
});
it('clears the saved business association when the user selects no association',async()=>{await mount();await click('已保存的评审');const select=document.querySelector('[data-calendar-editor] select') as HTMLSelectElement;await act(async()=>{select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));});await click('保存日程');expect(bridge.current.run).toHaveBeenCalledWith({type:'calendar.save',payload:{id:'event-a',title:'已保存的评审',date:today(),time:'14:00',note:'原始说明'}});expect(bridge.current.state.calendar[0]).not.toHaveProperty('target');});
