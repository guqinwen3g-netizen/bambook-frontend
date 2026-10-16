// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevDetailPage } from './DevDetailPage';
import { newRoundError, previewRoundLabels } from './DevRounds';
import { applyMistCommand, createMistState, type MistCommand, type MistContext, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { Nav } from '../nav';

const bridge=vi.hoisted(()=>({current:null as any}));
vi.mock('../runtime/workspace',()=>({useMistWorkspace:()=>bridge.current}));

let root:Root|undefined,host:HTMLDivElement,state:MistState,devId='';const go=vi.fn();
let n=0;const ctx:MistContext={id:()=>`ui-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'业务员'};
const supplier=(name:string)=>({id:name,code:name,name,type:'成衣工厂',capabilities:'缝制',status:'active',country:'',address:'',capacity:0,capacityUnit:'件',leadDays:0,blockReason:'',contacts:[],fileIds:[],note:'',createdAt:ctx.now,updatedAt:ctx.now}) as any;
const apply=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r;};
function render(versionId?:string){return root!.render(<Nav.Provider value={{route:{view:'development/detail',id:devId,versionId},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><DevDetailPage/></Nav.Provider>);}
beforeEach(async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();state=createMistState(ctx,'empty');
  state.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''} as any);
  state.market.suppliers.push(...['A厂','B厂','C厂','D厂'].map(supplier));
  devId=apply({type:'development.submit',payload:{values:{name:'轮次大衣',customer:'c',style:'ST',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'首轮',factories:['A厂','B厂','C厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1},fileIds:[]}}).result.devId!;
  const run=vi.fn(async(command:MistCommand)=>{const r=apply(command);bridge.current={...bridge.current,state};await act(async()=>render(r.result.versionId));return{requestId:'r',revision:2,result:r.result};});
  bridge.current={state,loading:false,error:'',run,uploadFile:vi.fn(async(file:File)=>{const id='file-'+file.name;state={...state,files:[...state.files,{id,name:file.name,mimeType:'text/plain',size:1,storageKey:id,createdAt:ctx.now}]};bridge.current={...bridge.current,state};return state.files.at(-1);}),downloadFile:vi.fn(),fileUrl:()=>''};
  host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>render());
});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
const button=(text:string)=>[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()===text);
async function click(text:string){const target=button(text);expect(target,text).toBeTruthy();await act(async()=>target!.click());}
async function check(group:string,label:string){const box=[...document.querySelectorAll(`[aria-label="${group}"] label.mist-check`)].find(item=>item.textContent?.startsWith(label))?.querySelector('input') as HTMLInputElement;expect(box,label).toBeTruthy();await act(async()=>box.click());}
async function fill(label:string,value:string){const field=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')===label);const input=field?.querySelector('input,textarea') as HTMLInputElement;expect(input,label).toBeTruthy();await act(async()=>{const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
const roundText=(number:number)=>document.querySelector(`[data-round="${number}"]`)?.textContent||'';

describe('BB-DEV-2 round card and new-round dialog',()=>{
  it('opens R2 with only C and new D, previews R2-C / R2-D and keeps R1 unchanged',async()=>{
    expect(roundText(1)).toContain('R1-A · A厂');expect(roundText(1)).toContain('R1-C · C厂');
    const r1=roundText(1);
    await click('开新一轮');
    expect(document.body.textContent).toContain('开启第 2 轮');
    expect(button('请至少选择一家参与工厂')?.disabled).toBe(true);
    await check('参考版本','R1-C');await check('参与工厂','C厂');await check('参与工厂','D厂');
    expect(document.querySelector('[aria-label="参与工厂"]')?.textContent).toContain('D厂 · 首次参与');
    await fill('本轮共同要求','收腰 2cm');await fill('本轮目标日期','2026-11-10');
    await click('建立 R2-C、R2-D');
    expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.round.create',payload:expect.objectContaining({devId,factories:['C厂','D厂'],requirements:'收腰 2cm',targetDate:'2026-11-10'})}));
    expect(roundText(2)).toContain('R2-C · C厂');expect(roundText(2)).toContain('R2-D · D厂');expect(roundText(2)).toContain('参考 R1-C');expect(roundText(2)).toContain('收腰 2cm');
    expect(roundText(1)).toBe(r1);
    expect(document.body.textContent).toContain('D D厂');
  });
  it('previews fixed letters and validates required fields before submit',()=>{
    const dev=state.devs[0];
    expect(previewRoundLabels(state,dev,['C厂','D厂'])).toEqual(['R2-C','R2-D']);
    expect(newRoundError({factories:[],requirements:'x',fileIds:[],referenceVersionIds:[],targetDate:'2026-11-01'})).toContain('工厂');
    expect(newRoundError({factories:['A厂'],requirements:' ',fileIds:[],referenceVersionIds:[],targetDate:'2026-11-01'})).toContain('共同要求');
    expect(newRoundError({factories:['A厂'],requirements:'x',fileIds:[],referenceVersionIds:[],targetDate:''})).toContain('目标日期');
  });
});

describe('acceptance review #59 on the page',()=>{
  it('rejects duplicate factories in the form with a reason',()=>{
    expect(newRoundError({factories:['A厂','A厂'],requirements:'x',fileIds:[],referenceVersionIds:[],targetDate:'2026-11-01'})).toBe('同一轮内工厂不能重复：A厂');
  });
  it('disables 开新一轮 with the reason once the case is cancelled through the page',async()=>{
    expect(button('开新一轮')!.disabled).toBe(false);
    await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.getAttribute('aria-label')==='更多')!.click());
    await click('取消开发案');expect(button('确认取消')!.disabled).toBe(true);await fill('原因','客户撤单');await click('确认取消');
    expect(state.devs[0].closure).toMatchObject({kind:'cancelled',reason:'客户撤单'});
    await act(async()=>{bridge.current={...bridge.current,state};render();});
    const create=[...document.querySelectorAll<HTMLButtonElement>('#mist-dev-rounds button')].find(item=>item.textContent?.trim()==='开新一轮')!;
    expect(create.disabled).toBe(true);expect(document.querySelector('#mist-dev-rounds')!.textContent).toContain('开发案已取消，不能再开新一轮');
  });
});
