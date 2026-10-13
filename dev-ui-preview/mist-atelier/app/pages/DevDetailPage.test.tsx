// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevDetailPage, confirmationFormError, developmentStepStates, localConfirmationTime } from './DevDetailPage';
import { applyMistCommand, createMistState, type MistDev, type MistVersion } from '../../../../server/src/shared/mistWorkspace';
import { Nav } from '../nav';

const bridge=vi.hoisted(()=>({current:null as any}));
vi.mock('../runtime/workspace',()=>({useMistWorkspace:()=>bridge.current}));

describe('version confirmation form',()=>{
  const values={confirmer:'Emma Clarke',organization:'Cedar & Crown',confirmedAt:'2026-10-13T15:10',basis:'电话确认记录',originalText:'Approved'};
  it('requires a real confirmer, occurrence time and basis instead of seed confirmation text',()=>{
    expect(confirmationFormError(values)).toBeNull();
    expect(confirmationFormError({...values,confirmer:''})).toContain('实际确认人');
    expect(confirmationFormError({...values,confirmedAt:''})).toContain('确认时间');
    expect(confirmationFormError({...values,basis:''})).toContain('确认依据');
  });
  it('formats a supplied clock as a datetime-local value rather than a fixed demo date',()=>{
    const date=new Date(2027,2,17,9,5);expect(localConfirmationTime(date)).toBe('2027-03-17T09:05');
  });
});

let root:Root|undefined,host:HTMLDivElement;const go=vi.fn();
const record: MistDev={id:'dev-a',code:'DEV-A',name:'工作空间实际开发',style:'STYLE-A',owner:'业务员',customer:'客户',customerId:'customer-a',due:'2026-10-30',dueRel:'待交付',stage:4,state:'已确认',tone:'ok',ver:'R1-A-1',fac:2,img:'coat',factory:'工厂 A',sample:'SP-A',fabric:'羊毛',goal:'真实开发要求',currentVersionId:'va',versionIds:['va','vb'],values:{name:'实际开发',style:'STYLE-A',sizeBase:'M',factories:['工厂 A','工厂 B']} as any,fileIds:[],createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z'};
const version=(id:string,label:string,reviewer:string):MistVersion=>({id,devId:'dev-a',label,factory:`工厂 ${id}`,sample:`SP-${id}`,sampleQuantity:2,size:'M',fabric:'羊毛',img:'coat',fileIds:[],returnedAt:'2026-10-12T00:00:00Z',qc:{result:'pass',reviewer,reviewedAt:'2026-10-12T01:00:00Z',report:`QC-${id}`,opinion:`${id}的意见`},confirmations:[],archivedAt:null,note:''});
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();bridge.current={state:{devs:[record],versions:[version('va','R1-A-1','评审 A'),version('vb','R2-B-1','评审 B')],files:[],events:[],orders:[],settings:{profileName:'业务员'}},loading:false,error:'',run:vi.fn(async()=>({requestId:'confirmed',revision:2,result:{devId:'dev-a'}})),uploadFile:vi.fn(),downloadFile:vi.fn()};});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
async function mount(versionId='va',customerId?:string){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(<Nav.Provider value={{route:{view:'development/detail',id:'dev-a',versionId,customerId},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><DevDetailPage/></Nav.Provider>));}
async function click(text:string){const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()===text);expect(button,text).toBeTruthy();await act(async()=>button!.click());}
async function fill(label:string,value:string){const field=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')===label);const input=field?.querySelector('input,textarea') as HTMLInputElement|HTMLTextAreaElement;expect(input,label).toBeTruthy();await act(async()=>{const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});}

describe('exact persisted version detail',()=>{
  it('uses each selected version’s report and sends a real ID, not its display label',async()=>{
    await mount();expect(host.textContent).toContain('评审 A');await click('R2-B-1');expect(host.textContent).toContain('评审 B');expect(host.textContent).not.toContain('评审 A');
    expect(go).toHaveBeenCalledWith('development/detail','dev-a',{versionId:'vb'});
    await fill('实际确认人','实际客户联系人');await fill('所属组织','客户组织');await fill('确认时间','2026-10-13T15:10');await fill('确认依据','会议纪要 37');await fill('需求方原文','Approved');
    await click('保存确认');await click('确认提交');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'development.confirm',payload:{devId:'dev-a',versionId:'vb',result:'approved',confirmer:'实际客户联系人',organization:'客户组织',confirmedAt:new Date('2026-10-13T15:10').toISOString(),basis:'会议纪要 37',originalText:'Approved'}});
    expect(host.querySelector('.mist-measure')).not.toBeNull();
    expect(host.querySelector('.mist-measure')?.textContent).toContain('暂无测量记录');
  });
  it('restores and saves a version-specific confirmation draft',async()=>{
    bridge.current.state.versions[1].confirmationDraft={result:'needs_adjustment',confirmer:'客户 B',organization:'组织 B',confirmedAt:'2026-10-13T00:00:00Z',basis:'本版依据',originalText:'Please revise'};
    await mount('vb');const field=[...host.querySelectorAll('label')].find(item=>item.textContent?.startsWith('实际确认人'))!;expect(field.querySelector('input')?.value).toBe('客户 B');await click('存为草稿');
    expect(bridge.current.run.mock.calls[0][0]).toMatchObject({type:'development.saveConfirmationDraft',payload:{devId:'dev-a',versionId:'vb',draft:{result:'needs_adjustment',confirmer:'客户 B',basis:'本版依据'}}});
  });
  it('does not turn all previous steps done solely because the case summary says archived',()=>{
    const fresh={...version('vb','R2-B-1','评审 B'),returnedAt:null,qc:null};expect(developmentStepStates(record,fresh)).toEqual(['done','now','todo','todo','todo']);
  });
  it('keeps the exact confirmation inputs after the server rejects the command',async()=>{
    bridge.current.run.mockRejectedValueOnce(new Error('服务器拒绝该确认'));await mount();await fill('实际确认人','待确认人');await fill('确认依据','真实依据');await click('保存确认');await click('确认提交');
    expect(document.body.textContent).toContain('服务器拒绝该确认');const field=[...host.querySelectorAll('label')].find(item=>item.textContent?.startsWith('实际确认人'))!;expect(field.querySelector('input')?.value).toBe('待确认人');
  });

  it('restores the original measurement columns and counts only saved measurements for the selected version',async()=>{
    bridge.current.state.versions[0].qc.measurements=[{point:'胸围',standard:112,actual:112.4,tolerance:1},{point:'衣长',standard:104,actual:102,tolerance:1}];
    bridge.current.state.versions[0].qc.appearanceDefects=2;
    await mount();
    const table=host.querySelector('.mist-measure')!;
    expect(table.textContent).toContain('部位');expect(table.textContent).toContain('标准');expect(table.textContent).toContain('实测');expect(table.textContent).toContain('偏差');
    expect(table.textContent).toContain('胸围');expect(table.textContent).toContain('112.4');expect(table.textContent).toContain('-2.0');
    const stats=host.querySelector('#mist-dev-qc .mist-summary-nums')!;
    expect(stats.textContent).toContain('测量点2');expect(stats.textContent).toContain('公差内1');expect(stats.textContent).toContain('需关注1');expect(stats.textContent).toContain('外观缺陷2');
    await click('R2-B-1');expect(host.querySelector('.mist-measure')?.textContent).not.toContain('胸围');expect(host.querySelector('.mist-measure')?.textContent).toContain('暂无测量记录');
    expect(host.querySelector('#mist-dev-qc .mist-summary-nums')?.textContent).not.toContain('24');
  });

  it('saves measured facts on the exact version while leaving the independent QC result unchanged',async()=>{
    const context={id:()=> 'qc-event',now:'2026-10-13T08:00:00Z',actorName:'实际评审'};
    bridge.current.state={...createMistState(context,'empty'),...bridge.current.state};
    bridge.current.run.mockImplementation(async(command:any)=>{const result=applyMistCommand(bridge.current.state,command,context);bridge.current.state=result.state;return{requestId:'qc-request',revision:2,result:result.result};});
    await mount('vb');await click('更新报告');await click('添加测量点');
    await fill('部位 1','胸围');await fill('标准 1（cm）','112');await fill('实测 1（cm）','120');await fill('公差 1（±cm）','1');await fill('外观缺陷数量','3');await click('保存报告');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'development.recordQc',payload:{devId:'dev-a',versionId:'vb',qc:expect.objectContaining({result:'pass',measurements:[{point:'胸围',standard:112,actual:120,tolerance:1}],appearanceDefects:3})}});
    expect(bridge.current.state.versions.find((item:any)=>item.id==='vb').qc.result).toBe('pass');
    expect(bridge.current.state.versions.find((item:any)=>item.id==='va').qc.measurements).toBeUndefined();
    expect(host.querySelector('.mist-measure')?.textContent).toContain('+8.0');
    await click('更新报告');
    const field=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')==='实测 1（cm）');expect(field?.querySelector('input')?.value).toBe('120');
  });

  it('retains edited measurements after a rejected save and blocks incomplete rows',async()=>{
    bridge.current.run.mockRejectedValueOnce(new Error('测量保存失败'));
    await mount();await click('更新报告');await click('添加测量点');await click('保存报告');
    expect(bridge.current.run).not.toHaveBeenCalled();expect(document.body.textContent).toContain('第 1 个测量点');
    await fill('部位 1','袖长');await fill('标准 1（cm）','63.5');await fill('实测 1（cm）','64.1');await fill('公差 1（±cm）','1');await click('保存报告');
    expect(document.body.textContent).toContain('测量保存失败');
    const field=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')==='实测 1（cm）');expect(field?.querySelector('input')?.value).toBe('64.1');
  });

  it('reloads saved measurements on reopening and clears unsaved rows when changing versions',async()=>{
    bridge.current.state.versions[0].qc.measurements=[{point:'肩宽',standard:46,actual:46.2,tolerance:1}];
    await mount();await click('更新报告');await fill('实测 1（cm）','48');await click('取消');
    expect(bridge.current.state.versions[0].qc.measurements[0].actual).toBe(46.2);
    await click('R2-B-1');await click('更新报告');expect(document.body.textContent).not.toContain('实测 1（cm）');await click('取消');
    await click('R1-A-1');await click('更新报告');
    const field=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')==='实测 1（cm）');expect(field?.querySelector('input')?.value).toBe('46.2');
  });

  it('does not attach a recovered A-version upload to B after changing versions',async()=>{
    bridge.current.uploadFile.mockImplementation(async()=>{bridge.current.pending={kind:'upload',requestId:'upload-a'};throw Error('上传结果待核对');});
    bridge.current.recover=vi.fn(async()=>{bridge.current.pending=null;return{requestId:'upload-a',revision:3,result:{fileId:'file-for-a'}};});
    await mount();await click('更新报告');
    const input=document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,'files',{value:[new File(['report'],'a-report.pdf',{type:'application/pdf'})],configurable:true});
    await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
    await click('取消');await click('R2-B-1');await click('更新报告');await click('核对原操作结果');
    const field=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')==='报告编号或附件');expect(field?.querySelector('input')?.value).toBe('QC-vb');
    expect(document.body.textContent).toContain('未自动关联当前版本');
  });
});

describe('development plan factory source and return context',()=>{
 it('keeps customer return context when changing versions and returning',async()=>{await mount('va','customer-a');await click('R2-B-1');expect(go).toHaveBeenCalledWith('development/detail','dev-a',{versionId:'vb',customerId:'customer-a'});await click('返回客户档案');expect(go).toHaveBeenCalledWith('crm','customer-a',{customerId:'customer-a'});});
 it('edits plan factories using actual suppliers and can add one without losing plan input',async()=>{
  bridge.current.state.market={suppliers:[{id:'live',name:'真实新增工厂',type:'成衣加工',capabilities:'缝制',status:'active'}]};bridge.current.state.drafts=[];
  await mount();await act(async()=>document.querySelector<HTMLButtonElement>('button[aria-label="更多"]')!.click());await click('编辑开发计划');await fill('开发目标','保留的计划目标');expect(document.body.textContent).toContain('真实新增工厂');expect(document.body.textContent).not.toContain('江南成衣');
  const candidate=[...document.querySelectorAll('label')].find(label=>label.textContent==='真实新增工厂')?.querySelector<HTMLInputElement>('input');expect(candidate).toBeTruthy();await act(async()=>candidate!.click());await click('保存计划');expect(bridge.current.run).toHaveBeenCalledWith({type:'development.update',payload:{devId:'dev-a',patch:expect.objectContaining({goal:'保留的计划目标',factories:expect.arrayContaining(['真实新增工厂'])})}});
 });
});


describe('fabric exact version detail',()=>{
 const useFabric=()=>{bridge.current.state.devs=[{...record,img:'clay',values:{...record.values,domain:'fabric',category:'斜纹',sizeBase:'',sampleForm:'米样',sampleUnit:'米'}}];bridge.current.state.versions[0]={...bridge.current.state.versions[0],qc:null,returnedAt:null,sample:'',size:''};};
 it('records an actual decimal metre sample and shows no garment size or stock photo',async()=>{
  useFabric();await mount();expect(host.textContent).not.toContain('尺码');expect(host.textContent).toContain('尚未上传本版实物图片');expect(host.querySelector('.mist-thumb img')).toBeNull();await click('登记返样');await fill('实物编号','QA-FABRIC-REAL');await fill('数量 / 长度','1.25');await fill('实际位置','样品架A');await click('保存返样');
  expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.recordSample',payload:expect.objectContaining({devId:'dev-a',versionId:'va',quantity:1.25,form:'米样',unit:'米',location:'样品架A'})}));
 });
 it('records independent fabric measurements using fabric permission and no garment tolerance',async()=>{
  useFabric();bridge.current.state.versions[0].returnedAt='2026-10-13T00:00:00Z';await mount();await click('录入报告');expect(document.body.textContent).not.toContain('尺寸测量');expect(document.body.textContent).not.toContain('公差内');await fill('报告编号或附件','QC-FABRIC-TEST');await click('添加面料实测');await fill('实测项目 1','克重');await fill('实测值 1','260');await fill('原单位 1','g/m²');await click('保存报告');
  expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.recordQc',payload:expect.objectContaining({domain:'fabric',versionId:'va',qc:expect.objectContaining({measurements:[],fabricMeasurements:[{property:'克重',actual:260,unit:'g/m²'}],result:'pass'})})}));
 });
});


it('keeps rejected fabric sample input and feedback inside the still-open dialog',async()=>{
 bridge.current.state.devs=[{...record,values:{...record.values,domain:'fabric',sampleForm:'米样',sampleUnit:'米'}}];bridge.current.state.versions[0]={...bridge.current.state.versions[0],qc:null,returnedAt:null,size:''};bridge.current.run.mockRejectedValueOnce(new Error('来源版本已更新，请核对'));await mount();await click('登记返样');await fill('实物编号','保留实物编号');await fill('数量 / 长度','1.25');await click('保存返样');const modal=document.querySelector('[role="dialog"]')!;expect(modal.textContent).toContain('来源版本已更新，请核对');expect(modal.textContent).toContain('返样尚未保存');expect([...modal.querySelectorAll('input')].some(i=>i.value==='1.25')).toBe(true);
});
