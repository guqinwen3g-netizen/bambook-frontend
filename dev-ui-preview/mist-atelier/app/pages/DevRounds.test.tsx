// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevDetailPage } from './DevDetailPage';
import { newRoundError, previewRoundLabels } from './DevRounds';
import { applyMistCommand, createMistState, type MistCommand, type MistContext, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { Nav } from '../nav';
import { developmentNoticeContent, developmentNoticeFingerprint } from '../../../../server/src/shared/mistDevelopmentNotice';

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
const versionCard=(round:number,label:string)=>document.querySelector(`[data-round="${round}"] [data-version="${label}"]`)?.textContent||'';
const taskText=(label:string)=>document.querySelector(`[data-task="${label}"]`)?.textContent||'';
async function fillIn(group:string,label:string,value:string){const field=[...document.querySelectorAll(`[aria-label="${group}"] label`)].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')===label);const input=field?.querySelector('input,textarea') as HTMLInputElement;expect(input,group+label).toBeTruthy();await act(async()=>{const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}

describe('BB-DEV-2 round card and new-round dialog',()=>{
  it('opens R2 with only C and new D, previews R2-C / R2-D and keeps R1 unchanged',async()=>{
    expect(versionCard(1,'R1-A')).toContain('A厂');expect(versionCard(1,'R1-C')).toContain('C厂');
    const r1=roundText(1);
    await click('开新一轮');
    expect(document.body.textContent).toContain('开启第 2 轮');
    expect(document.querySelector('[aria-label="开新一轮步骤"] [aria-current="step"]')?.textContent).toContain('参考版本');
    await check('参考版本','R1-C');await click('下一步：参与工厂');
    expect(button('请至少选择一家参与工厂')?.disabled).toBe(true);
    await check('参与工厂','C厂');await check('参与工厂','D厂');
    expect(document.querySelector('[aria-label="参与工厂"]')?.textContent).toContain('D厂 · 首次参与');
    await click('下一步：共同要求');
    expect(button('请填写本轮共同要求')?.disabled).toBe(true);
    await fill('本轮共同要求','收腰 2cm');await fill('本轮目标日期','2026-11-10');
    await click('下一步：逐厂要求');
    expect(document.body.textContent).toContain('共同要求：收腰 2cm');
    await fillIn('D厂 逐厂要求','差异要求','D 厂另改领型');await fillIn('D厂 逐厂要求','数量','2');await fillIn('D厂 逐厂要求','要求日期','2026-11-05');
    await fillIn('C厂 逐厂要求','数量','0');
    expect(button('C厂：样品数量须为正整数')?.disabled).toBe(true);
    await fillIn('C厂 逐厂要求','数量','1');
    await click('上一步');expect(document.body.textContent).toContain('本轮共同要求');await click('下一步：逐厂要求');
    expect(document.body.textContent).toContain('D 厂另改领型');
    await click('建立 R2-C、R2-D');
    expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.round.create',payload:expect.objectContaining({devId,factories:['C厂','D厂'],requirements:'收腰 2cm',targetDate:'2026-11-10',factoryTasks:[
      {factory:'C厂',extraRequirements:'',sampleForm:'样衣',sampleQuantity:1,sampleUnit:'件',dueDate:'2026-11-10'},
      {factory:'D厂',extraRequirements:'D 厂另改领型',sampleForm:'样衣',sampleQuantity:2,sampleUnit:'件',dueDate:'2026-11-05'}]})}));
    expect(taskText('R2-D')).toContain('样衣 2 件 · 要求 2026-11-05');expect(taskText('R2-D')).toContain('差异：D 厂另改领型');
    expect(versionCard(2,'R2-C')).toContain('C厂');expect(versionCard(2,'R2-D')).toContain('D厂');expect(roundText(2)).toContain('参考 R1-C');expect(roundText(2)).toContain('收腰 2cm');
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

describe('BB-DEV-3 修改共同要求后逐厂同步',()=>{
  it('shows 与共同要求不一致，可同步 on every factory task after editing, and updates only the synced one',async()=>{
    const r1=roundText(1);expect(r1).not.toContain('与共同要求不一致');
    await click('修改共同要求');expect(button('共同要求没有变化')?.disabled).toBe(true);
    await fill('本轮共同要求','首轮：收腰 1cm');await click('保存共同要求');
    expect(state.rounds!.find(r=>r.number===1)!.requirements).toBe('首轮：收腰 1cm');
    for(const label of ['R1-A','R1-B','R1-C'])expect(taskText(label)).toContain('与共同要求不一致，可同步');
    expect(state.versions.find(v=>v.label==='R1-A')!.task!.commonRequirements).toBe('首轮');
    await click('同步 R1-A');
    expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.version.syncRequirements',payload:{devId,versionId:state.versions.find(v=>v.label==='R1-A')!.id}}));
    expect(state.versions.find(v=>v.label==='R1-A')!.task!.commonRequirements).toBe('首轮：收腰 1cm');
    expect(taskText('R1-A')).not.toContain('与共同要求不一致');expect(taskText('R1-B')).toContain('与共同要求不一致，可同步');
  });
  it('disables sync with the reason once that factory has returned its sample',async()=>{
    apply({type:'development.round.updateRequirements',payload:{devId,roundId:state.rounds![0].id,requirements:'首轮改'}});
    apply({type:'development.recordSample',payload:{devId,versionId:state.versions.find(v=>v.label==='R1-B')!.id,sample:'S',quantity:1,returnedAt:ctx.now}});
    await act(async()=>{bridge.current={...bridge.current,state};render();});
    expect(button('同步 R1-B')!.disabled).toBe(true);expect(taskText('R1-B')).toContain('R1-B 已返样，改要求请开新一轮');expect(button('同步 R1-A')!.disabled).toBe(false);
  });
});

describe('BB-DEV-4 试样通知单卡片',()=>{
  const company={legalName:'杭州竹语服饰有限公司',englishName:'',address:'',englishAddress:'',phone:'',email:'',taxId:'',customsCode:'',bankName:'',bankAccount:'',swift:'',defaultCurrency:'USD'};
  const notice=(label:string,seq:number)=>{const v=state.versions.find(x=>x.label===label)!,dev=state.devs[0],content=developmentNoticeContent(state,dev,v);
    const fileId=`notice-${label}-${seq}`;state.files.push({id:fileId,name:`${fileId}.pdf`,mimeType:'application/pdf',size:10,storageKey:fileId,createdAt:ctx.now});
    v.notices=[...(v.notices||[]),{id:fileId,versionId:v.id,seq,noticeNo:`${dev.code}-${label}-N0${seq}`,fileId,fileName:`${fileId}.pdf`,sha256:'x',bytes:10,templateVersion:1,contentFingerprint:developmentNoticeFingerprint(content),snapshotFingerprint:'x',snapshot:{...content,noticeNo:`${dev.code}-${label}-N0${seq}`,seq,templateVersion:1,generatedAt:ctx.now,generatedBy:'业务员',generatedById:'u'},generatedAt:ctx.now,generatedBy:'业务员',generatedById:'u'}];};
  const card=()=>document.querySelector('#mist-dev-notice')!;
  const rerender=async(versionId?:string)=>act(async()=>{bridge.current={...bridge.current,state};render(versionId);});
  it('requires the company profile, then generates the selected factory notice by devId + versionId only',async()=>{
    const a=state.versions.find(v=>v.label==='R1-A')!;await rerender(a.id);
    expect(card().textContent).toContain('服装开发通知单');expect(card().textContent).toContain('R1-A · A厂');
    const generate=[...card().querySelectorAll('button')].find(b=>b.textContent?.trim()==='生成通知单')!;expect(generate.disabled).toBe(true);expect(card().textContent).toContain('公司抬头');
    state.settings.companyProfile={...company};await rerender(a.id);
    await act(async()=>[...card().querySelectorAll('button')].find(b=>b.textContent?.trim()==='生成通知单')!.click());
    expect(bridge.current.run).toHaveBeenCalledWith({type:'development.notice.generate',payload:{devId,versionId:a.id}});
  });
  it('lists the latest notice first with old ones kept, and flags 工厂任务已更新 after a sync until regenerated',async()=>{
    state.settings.companyProfile={...company};const a=state.versions.find(v=>v.label==='R1-A')!;
    notice('R1-A',1);await rerender(a.id);
    expect(card().textContent).not.toContain('工厂任务已更新');expect([...card().querySelectorAll('button')].some(b=>b.textContent?.trim()==='重新生成')).toBe(true);
    apply({type:'development.round.updateRequirements',payload:{devId,roundId:a.roundId!,requirements:'首轮：袖长 -1cm'}});apply({type:'development.version.syncRequirements',payload:{devId,versionId:a.id}});
    await rerender(a.id);expect(card().textContent).toContain('工厂任务已更新，可重新生成');
    notice('R1-A',2);await rerender(a.id);
    const rows=[...card().querySelectorAll('[data-notice]')].map(r=>r.textContent||'');
    expect(rows).toHaveLength(2);expect(rows[0]).toContain('最新');expect(rows[0]).toContain('-R1-A-N02');expect(rows[1]).toContain('旧版');expect(rows[1]).toContain('-R1-A-N01');
    expect(card().textContent).not.toContain('工厂任务已更新');
    // 另一家工厂的版本只显示自己的通知单
    await rerender(state.versions.find(v=>v.label==='R1-B')!.id);expect(card().querySelectorAll('[data-notice]')).toHaveLength(0);expect(card().textContent).toContain('R1-B · B厂');
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

describe('BB-DEV-5 服装小版本',()=>{
  const ready=(label:string)=>{const id=state.versions.find(v=>v.label===label)!.id;
    apply({type:'development.recordSample',payload:{devId,versionId:id,sample:'S-'+label,quantity:1,returnedAt:'2026-10-15T08:00:00Z'}});
    apply({type:'development.recordQc',payload:{devId,versionId:id,qc:{result:'pass',reviewer:'许言',reviewedAt:'2026-10-15T09:00:00Z',report:'QC-1',opinion:'通过',measurements:[]}}});return id;};
  const more=async()=>act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.getAttribute('aria-label')==='更多')!.click());
  it('shows 记录小调整 disabled with the reason until the major version has a sample and QC',async()=>{
    await more();expect(button('记录小调整')!.disabled).toBe(true);expect(document.body.textContent).toContain('大版本须先登记返样实物，才能记录小调整');
  });
  it('records R1-A.1 from the page; the minor reuses the sample/QC, has its own confirmation and no notice card or new sample entry',async()=>{
    const a=ready('R1-A');apply({type:'development.confirm',payload:{devId,versionId:a,result:'approved',confirmer:'Anna',organization:'测试客户',confirmedAt:'2026-10-16T08:00:00Z',basis:'邮件',originalText:'OK'}});
    await act(async()=>{bridge.current={...bridge.current,state};render(a);});
    await more();await click('记录小调整');expect(document.body.textContent).toContain('生成 R1-A.1');
    expect(button('生成小版本')!.disabled).toBe(true);await fill('改了什么','领口改小 0.5cm');await click('生成小版本');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'development.version.recordMinor',payload:{devId,versionId:a,change:'领口改小 0.5cm'}});
    expect(state.devs[0].currentVersionId).toBe(state.versions.find(v=>v.label==='R1-A.1')!.id);
    expect(document.querySelector('[data-minor="R1-A.1"]')!.textContent).toContain('沿用 R1-A 实物与 QC 结论');
    expect(document.querySelector('[data-minor="R1-A.1"]')!.textContent).toContain('不继承 R1-A 的确认');
    expect(button('登记返样')!.disabled).toBe(true);expect(button('更新报告')!.disabled).toBe(true);
    expect(document.querySelector('#mist-dev-notice')).toBeNull();
    expect(document.querySelector('[data-task="R1-A.1"]')).toBeNull();expect(roundText(1)).toContain('R1-A.1');
    // 确认表单针对小版本，未继承 R1-A 的认可
    expect(document.querySelector('#mist-dev-confirmation')!.textContent).toContain('R1-A.1');expect(button('保存确认')).toBeTruthy();
  });
});

describe('BB-DEV-11 round timeline and multi-version comparison',()=>{
  const id=(label:string)=>state.versions.find(v=>v.label===label&&v.devId===devId)!.id;
  const sample=(label:string)=>apply({type:'development.recordSample',payload:{devId,versionId:id(label),sample:'S-'+label,quantity:1,returnedAt:'2026-10-15T08:00:00Z'}});
  const qc=(label:string,result:'pass'|'conditional'|'reject',opinion:string,measurements:any[]=[])=>apply({type:'development.recordQc',payload:{devId,versionId:id(label),qc:{result,reviewer:'许言',reviewedAt:'2026-10-15T09:00:00Z',report:'QC-'+label,opinion,measurements}}});
  const confirmVersion=(label:string,result:'approved'|'rejected',originalText:string)=>apply({type:'development.confirm',payload:{devId,versionId:id(label),result,confirmer:'Anna',organization:'测试客户',confirmedAt:'2026-10-16T08:00:00Z',basis:'邮件 12',originalText}});
  const refresh=async(versionId?:string)=>act(async()=>{bridge.current={...bridge.current,state};render(versionId);});
  const tags=(label:string)=>[...document.querySelectorAll(`[data-version="${label}"] .mist-rtl-tags .mist-pill`)].map(item=>item.textContent);
  const compareBox=(label:string)=>document.querySelector(`#mist-dev-rounds [data-version="${label}"] input[type="checkbox"]`) as HTMLInputElement;
  const cells=(row:string)=>[...document.querySelectorAll(`#mist-dev-compare tr[data-row="${row}"] td`)].map(item=>item.textContent);
  beforeEach(async()=>{
    sessionStorage.clear();
    sample('R1-A');qc('R1-A','pass','合格',[{point:'胸围',standard:112,actual:112.5,tolerance:1}]);confirmVersion('R1-A','approved','面料手感 OK');
    sample('R1-B');qc('R1-B','conditional','袖长偏长 0.8cm，可接受');confirmVersion('R1-B','rejected','颜色偏暗，不采用');
    await refresh();
  });
  it('shows one row per round with factory cards whose status comes only from recorded facts',()=>{
    const row=document.querySelector('[data-round="1"] [role="list"]')!;
    expect([...row.querySelectorAll('[data-version]')].map(item=>item.getAttribute('data-version'))).toEqual(['R1-A','R1-B','R1-C']);
    expect(tags('R1-A')).toEqual(['认可']);
    expect(tags('R1-B')).toEqual(['不采用','需关注']); // 有保留通过仍须可见
    expect(tags('R1-C')).toEqual(['待返样']);
  });
  it('opens the exact version from its card and keeps the round, factory and selection visible',async()=>{
    await act(async()=>(document.querySelector('[data-version="R1-B"] .mist-rtl-open') as HTMLButtonElement).click());
    expect(go).toHaveBeenLastCalledWith('development/detail',devId,{versionId:id('R1-B')});
    expect(document.querySelector('[data-version="R1-B"]')!.getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-version="R1-A"]')!.getAttribute('aria-current')).toBeNull();
    expect(document.querySelector('[data-selection="R1-B"]')!.textContent).toContain('第 1 轮 · B厂 · R1-B');
    expect(document.querySelector('#mist-dev-confirmation')!.textContent).toContain('B厂 · R1-B');
    expect(document.querySelector('#mist-dev-qc')!.textContent).toContain('袖长偏长 0.8cm');
    // 返回（路由带回同一 versionId）时选中项不变；费用卡仍在
    await refresh(id('R1-B'));expect(document.querySelector('[data-version="R1-B"]')!.getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-dev-billing]')).toBeTruthy();
  });
  it('compares checked versions side by side with sources, honest gaps, and opens a version from the table',async()=>{
    await act(async()=>compareBox('R1-A').click());
    expect(button('并排对比')!.disabled).toBe(true);
    await act(async()=>compareBox('R1-B').click());await act(async()=>compareBox('R1-C').click());
    expect(document.querySelector('.mist-rtl-bar')!.textContent).toContain('已选 3 个版本：R1-A、R1-B、R1-C');
    await click('并排对比');
    const heads=[...document.querySelectorAll('#mist-dev-compare thead th[data-version]')].map(item=>item.textContent);
    expect(heads[0]).toContain('R1-A · A厂');expect(heads[0]).toContain('第 1 轮');expect(heads[2]).toContain('R1-C · C厂');
    expect(cells('qcResult')).toEqual(['通过','有保留通过','未返样，无 QC']);
    expect(cells('qcOpinion')[1]).toBe('袖长偏长 0.8cm，可接受');
    expect(cells('confirmResult')[0]).toContain('认可 · Anna');expect(cells('confirmResult')[0]).toContain('2026-10-16 16:00');expect(cells('sample')[0]).toContain('2026-10-15 16:00');expect(cells('qcReview')[0]).toBe('许言 · 2026-10-15 17:00'); // 上海业务时间expect(cells('confirmResult')[1]).toContain('不采用');expect(cells('confirmResult')[2]).toBe('尚无确认');
    expect(cells('confirmText')).toEqual(['面料手感 OK','颜色偏暗，不采用','未记录']);
    expect(document.querySelector('#mist-dev-compare tr[data-row="confirmText"] td:nth-child(4)')!.hasAttribute('data-missing')).toBe(true);
    expect(cells('qcFacts')[0]).toBe('1 个测量点 · 超出公差 0');
    expect(document.querySelector('[data-dev-billing]')).toBeTruthy();
    const open=[...document.querySelectorAll<HTMLButtonElement>('#mist-dev-compare thead th[data-version="R1-B"] button')].find(item=>item.textContent?.includes('打开详情'))!;
    await act(async()=>open.click());
    expect(go).toHaveBeenLastCalledWith('development/detail',devId,{versionId:id('R1-B')});
    expect(document.querySelector('#mist-dev-compare thead th[data-version="R1-B"]')!.textContent).toContain('当前查看');
    await click('收起对比');expect(document.querySelector('#mist-dev-compare')).toBeNull();
    expect(compareBox('R1-A').checked).toBe(true); // 收起不丢选择
    await click('清除');expect(document.querySelector('.mist-rtl-bar')).toBeNull();
  });
  it('never mixes another case’s version into the comparison, even from stale saved selection',async()=>{
    const other=apply({type:'development.submit',payload:{values:{name:'另一案',customer:'c',style:'ST2',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'x',factories:['A厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1},fileIds:[]}}).result.devId!;
    const foreign=state.devs.find(dev=>dev.id===other)!.versionIds[0];
    sessionStorage.setItem(`mist.dev.compare.${devId}`,JSON.stringify([id('R1-A'),foreign,id('R1-B')]));
    await act(async()=>root!.unmount());root=createRoot(host);await refresh();
    expect(document.querySelector('.mist-rtl-bar')!.textContent).toContain('已选 2 个版本：R1-A、R1-B');
    await click('并排对比');
    expect([...document.querySelectorAll('#mist-dev-compare thead th[data-version]')].map(item=>item.getAttribute('data-version'))).toEqual(['R1-A','R1-B']);
    expect(document.querySelector('#mist-dev-compare')!.textContent).not.toContain('另一案');
  });
});
