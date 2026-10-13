// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevCreatePage, developmentFormErrors, firstInvalidDevelopmentStep, developmentFactoryOptions } from './DevCreatePage';
import { Nav } from '../nav';
import type { DevelopmentValues, MistState } from '../../../../server/src/shared/mistWorkspace';

const bridge=vi.hoisted(()=>({current:null as any}));
vi.mock('../runtime/workspace',()=>({useMistWorkspace:()=>bridge.current}));

const values = () => ({
  name:'新款大衣',customer:'Cedar & Crown',style:'STYLE-17',season:'AW27',category:'大衣',fabric:'羊毛',color:'蓝色',target:'64.50',
  factories:['江南成衣'],due:'2026-10-30',kind:'new' as const,goal:'验证廓形',files:[],sizeBase:'L',collaborators:'顾言、沈禾',sampleQuantity:'3',
});

let root:Root|undefined,host:HTMLDivElement;
const go=vi.fn();
const savedValues=():DevelopmentValues=>{const {files,...rest}=values();return {...rest,collaborators:['顾言','沈禾'],sampleQuantity:3};};
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();
  const state={devs:[],versions:[],drafts:[],files:[],market:{suppliers:[{id:'actual-factory',name:'江南成衣',type:'成衣加工',capabilities:'样衣缝制',status:'active'}]},customers:[{id:'customer-a',name:'Cedar & Crown'}],settings:{profileName:'本人'}} as unknown as MistState;
  bridge.current={state,loading:false,error:'',run:vi.fn(async()=>({requestId:'write-1',revision:1,result:{devId:'new-dev-id',versionId:'new-version-id'}})),uploadFile:vi.fn(),downloadFile:vi.fn(async()=>undefined)};
});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
async function mount(id?:string,customerId?:string,section?:string){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(<Nav.Provider value={{route:{view:'development/new',id,customerId,section},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><DevCreatePage/></Nav.Provider>));}
async function fill(label:string,value:string){const field=[...document.body.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')===label);const element=field?.querySelector('input,select,textarea') as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement;expect(element,`field ${label}`).toBeTruthy();await act(async()=>{const prototype=element.tagName==='SELECT'?HTMLSelectElement.prototype:element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));});}
async function click(text:string){const button=[...document.body.querySelectorAll('button')].find(item=>item.textContent?.trim()===text);expect(button,text).toBeTruthy();await act(async()=>button!.click());}

describe('persisted five-step development creation',()=>{
  it('collects every original field, uploads real files, and navigates by the returned entity IDs',async()=>{
    await mount();await fill('开发对象名称','新款外套');await fill('客户款号','STYLE-NEW');await click('下一步');
    await fill('面料','纯羊毛');await fill('颜色','雾蓝');await fill('目标 FOB 单价','64.50');await fill('尺码基准','L');await fill('开发目标','验证肩线');await click('下一步');
    await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await fill('目标日期','2026-10-30');await fill('协作人','顾言、沈禾');await fill('首样数量','3');await click('下一步');
    const file=new File(['real content'],'tech-pack.pdf',{type:'application/pdf'});const stored={id:'file-1',name:file.name,mimeType:file.type,size:file.size,storageKey:'stored/file-1',createdAt:'2026-10-13T00:00:00Z'};
    bridge.current.uploadFile.mockImplementation(async()=>{bridge.current.state.files.push(stored);return stored;});
    await act(async()=>{const input=host.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(bridge.current.uploadFile).toHaveBeenCalledWith(file);expect(host.textContent).toContain(file.name);await click('下一步');expect(host.textContent).toContain('3 件 / 工厂');await click('创建开发案');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'development.submit',payload:{draftId:undefined,values:expect.objectContaining({name:'新款外套',fabric:'纯羊毛',color:'雾蓝',target:'64.50',sizeBase:'L',collaborators:['顾言','沈禾'],sampleQuantity:3,goal:'验证肩线',factories:['江南成衣']}),fileIds:['file-1']}});
    expect(go).toHaveBeenCalledWith('development/detail','new-dev-id',{versionId:'new-version-id'});
  });
  it('restores a saved server draft and keeps it editable after a failed save',async()=>{
    bridge.current.state.drafts=[{id:'draft-a',values:savedValues(),fileIds:[],updatedAt:'2026-10-13T00:00:00Z'}];bridge.current.run.mockRejectedValueOnce(new Error('server refused save'));
    await mount('draft-a');expect((host.querySelector('input') as HTMLInputElement).value).toBe('新款大衣');await click('存为草稿');
    expect(host.textContent).toContain('server refused save');expect(go).not.toHaveBeenCalled();expect(bridge.current.run.mock.calls[0][0].payload.draftId).toBe('draft-a');expect((host.querySelector('input') as HTMLInputElement).value).toBe('新款大衣');
  });
  it('downloads an uploaded attachment and persists unlinking it from an existing draft',async()=>{
    const file={id:'file-a',name:'draft-spec.pdf',mimeType:'application/pdf',size:20,storageKey:'draft/a',createdAt:'2026-10-13T00:00:00Z'};
    bridge.current.state.files=[file];bridge.current.state.drafts=[{id:'draft-a',values:savedValues(),fileIds:[file.id],updatedAt:'2026-10-13T00:00:00Z'}];
    await mount('draft-a');await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent?.endsWith('附件'))!.click());await click('下载');expect(bridge.current.downloadFile).toHaveBeenCalledWith(file);await click('移除');
    expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.saveDraft',payload:expect.objectContaining({draftId:'draft-a',fileIds:[]})}));expect(host.textContent).not.toContain(file.name);
  });
  it('uses the recovered submit receipt instead of issuing another create command',async()=>{
    bridge.current.pending={kind:'command',command:{type:'development.submit'}};bridge.current.recover=vi.fn(async()=>({requestId:'original',revision:8,result:{devId:'recovered-dev',versionId:'recovered-version'}}));
    await mount();await click('核对原操作结果');expect(bridge.current.run).not.toHaveBeenCalled();expect(go).toHaveBeenCalledWith('development/detail','recovered-dev',{versionId:'recovered-version'});
  });
});

describe('five-step development form validation',()=>{
  it('requires source identity before proceeding and accepts a complete form',()=>{
    expect(firstInvalidDevelopmentStep(values())).toBeNull();
    expect(developmentFormErrors({...values(),name:'',customer:'',style:''},'basic')).toEqual({name:'请填写开发对象名称',customer:'请选择客户',style:'请填写客户款号'});
  });
  it('does not accept an impossible date, missing factory or fractional sample quantity',()=>{
    const errors=developmentFormErrors({...values(),due:'2026-02-31',factories:[],sampleQuantity:'2.5'},'plan');
    expect(Object.keys(errors).sort()).toEqual(['due','factories','sampleQuantity']);
    expect(firstInvalidDevelopmentStep({...values(),due:'2026-02-31'})).toBe('plan');
  });
  it('allows an optional target but rejects negative or malformed money',()=>{
    expect(developmentFormErrors({...values(),target:''},'style')).toEqual({});
    expect(developmentFormErrors({...values(),target:'-1'},'style').target).toBeTruthy();
    expect(developmentFormErrors({...values(),target:'NaN'},'style').target).toBeTruthy();
  });
});

describe('exact customer and actual factory sources',()=>{
 it('keeps the requested second customer ID even when two customers share a display name',async()=>{bridge.current.state.customers.push({id:'customer-b',name:'Cedar & Crown'});await mount(undefined,'customer-b');const select=[...host.querySelectorAll('label')].find(l=>l.querySelector('.mist-field-label')?.textContent==='客户*')?.querySelector('select')!;expect(select.value).toBe('customer-b');await fill('开发对象名称','客户B开发');await fill('客户款号','B-1');await click('存为草稿');expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.saveDraft',payload:expect.objectContaining({values:expect.objectContaining({customer:'customer-b'})})}));});
 it('does not silently fall back to the first customer when the requested ID is missing',async()=>{await mount(undefined,'missing');expect(host.textContent).toContain('指定客户不存在');await fill('开发对象名称','开发');await fill('客户款号','S1');await click('存为草稿');expect(bridge.current.run).not.toHaveBeenCalled();expect(host.textContent).toContain('重新选择准确客户');});
 it('has no static factory options in an empty workspace',async()=>{bridge.current.state.market.suppliers=[];await mount();await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent?.endsWith('工厂与计划'))!.click());expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);expect(host.textContent).not.toContain('江南成衣');expect(host.textContent).not.toContain('远山服装');expect(host.textContent).toContain('尚无可用');});
 it('creates and selects a real supplier inside the form without losing the other fields',async()=>{bridge.current.state.market.suppliers=[];bridge.current.run.mockImplementation(async(command:any)=>{if(command.type==='market.supplier.save'){bridge.current.state.market.suppliers.push({...command.payload.input,id:'created-factory',status:'active'});return {requestId:'factory',revision:1,result:{id:'created-factory'}};}return {requestId:'draft',revision:2,result:{draftId:'draft'}};});await mount(undefined,'customer-a');await fill('开发对象名称','仍保留的开发');await fill('客户款号','KEEP-1');await click('下一步');await fill('面料','原面料');await click('下一步');await click('新增工厂');await fill('供应商编码','FAC-NEW');await fill('供应商名称','用户新建成衣厂');await fill('实际制作能力','外套样衣缝制');await click('保存并选择');expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'market.supplier.save',payload:expect.objectContaining({input:expect.objectContaining({name:'用户新建成衣厂',capabilities:'外套样衣缝制'})})}));const checkbox=host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;expect(checkbox.checked).toBe(true);await click('上一步');expect((host.querySelector('input') as HTMLInputElement).value).toBe('原面料');await click('上一步');expect((host.querySelector('input') as HTMLInputElement).value).toBe('仍保留的开发');});
 it('preserves supplier form and development input when supplier creation fails',async()=>{bridge.current.state.market.suppliers=[];bridge.current.run.mockRejectedValueOnce(new Error('供应商未保存'));await mount();await fill('开发对象名称','保留标题');await fill('客户款号','KEEP');await click('下一步');await fill('面料','羊毛');await click('下一步');await click('新增工厂');await fill('供应商编码','NEW');await fill('供应商名称','待保存工厂');await fill('实际制作能力','成衣加工');await click('保存并选择');expect(document.body.textContent).toContain('供应商未保存');expect((document.body.querySelector('[aria-label="供应商名称"]') as HTMLInputElement).value).toBe('待保存工厂');expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);});
 it('uses active garment suppliers and actual historical names, not unrelated or blocked new suppliers',()=>{const state={market:{suppliers:[{name:'成衣厂',type:'成衣',capabilities:'缝制',status:'active'},{name:'面料厂',type:'面料',capabilities:'织造',status:'active'},{name:'停用厂',type:'加工',capabilities:'缝制',status:'blocked'}]},versions:[{factory:'历史工厂'}],drafts:[{values:{factories:['草稿工厂','停用厂']}}]} as unknown as MistState;const options=developmentFactoryOptions(state);expect(options.map(x=>x.name)).toEqual(['成衣厂','历史工厂','草稿工厂','停用厂']);expect(options.find(x=>x.name==='停用厂')?.unavailable).toBe(true);});
});


describe('explicit fabric development form',()=>{
 it('creates a fabric plan with original classification, target units and decimal metre sample, not garment sizes',async()=>{
  bridge.current.state.market.suppliers.push({id:'fabric-factory',name:'真实测试面料厂',type:'面料工厂',capabilities:'织造染整',status:'active'});
  await mount(undefined,'customer-a','fabric');await fill('开发对象名称','面料测试斜纹');await fill('面料分类','原始斜纹分类');await click('下一步');
  expect(host.textContent).not.toContain('尺码基准');expect(host.textContent).not.toContain('USD / 件');
  await fill('目标成分','羊毛:60\n涤纶:40');await fill('目标克重','250');await fill('克重原单位','g/m²');await fill('目标幅宽','150');await fill('幅宽原单位','cm');await fill('目标单价','2.50');await fill('目标价币种','EUR');await fill('计价单位','码');await click('下一步');
  expect(host.textContent).not.toContain('江南成衣');await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await fill('首样数量','1.25');await fill('目标日期','2026-11-01');await click('下一步');await click('下一步');
  expect(host.textContent).toContain('1.25 米 / 工厂');expect(host.textContent).toContain('2.50 EUR / 码');await click('创建开发案');
  expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.submit',payload:expect.objectContaining({values:expect.objectContaining({domain:'fabric',category:'原始斜纹分类',style:'',sizeBase:'',sampleForm:'米样',sampleUnit:'米',sampleQuantity:1.25,targetCurrency:'EUR',targetUnit:'码',factories:['真实测试面料厂'],fabricRequirements:expect.objectContaining({weightValue:'250',weightUnit:'g/m²'})})})}));
 });
 it('preserves fabric draft domain and requirements even when re-entering without a route selector',async()=>{
  const fv={...savedValues(),domain:'fabric',category:'原始分类',sampleForm:'色样',sampleUnit:'份',fabricRequirements:{composition:'待工厂分析',weightValue:'',weightUnit:'',widthValue:'',widthUnit:'',yarn:'待工厂分析',weave:'平纹',usage:'',handle:'',finish:'',performance:''}};
  bridge.current.state.drafts=[{id:'fabric-draft',values:fv,fileIds:[]}];await mount('fabric-draft');expect(host.textContent).toContain('面料开发');await click('下一步');expect(host.textContent).toContain('面料目标与规格');expect(host.textContent).not.toContain('尺码基准');
 });
 it('does not allow invalid composition totals or mismatched quantity/unit to submit',()=>{
  const v={...values(),domain:'fabric' as const,sampleForm:'色样',sampleUnit:'份',sampleQuantity:'1.25',fabricRequirements:{composition:'羊毛:50',weightValue:'',weightUnit:'',widthValue:'',widthUnit:'',yarn:'',weave:'',usage:'',handle:'',finish:'',performance:''}};expect(developmentFormErrors(v,'style').fabricRequirements).toContain('100%');expect(developmentFormErrors(v,'plan').sampleQuantity).toContain('整数份');
 });
 it('offers only actual fabric factories and preserves same-domain historical references',()=>{
  const state={market:{suppliers:[{name:'织造厂',type:'面料',capabilities:'织造',status:'active'},{name:'成衣厂',type:'成衣',capabilities:'缝制',status:'active'}]},devs:[{id:'f',values:{domain:'fabric',category:'斜纹'}},{id:'g',values:{category:'大衣'}}],versions:[{devId:'f',factory:'面料历史厂'},{devId:'g',factory:'成衣历史厂'}],drafts:[]} as unknown as MistState;expect(developmentFactoryOptions(state,[],'fabric').map(f=>f.name)).toEqual(['织造厂','面料历史厂']);
 });
});
