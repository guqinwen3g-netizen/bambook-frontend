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
  it('shows a not-yet-returned factory sample using its planned unit',async()=>{
    bridge.current.state.versions[0]={...bridge.current.state.versions[0],sample:'',sampleQuantity:1,returnedAt:null,qc:null,task:{commonRequirements:'测试',extraRequirements:'',sampleForm:'半成品',sampleQuantity:1,sampleUnit:'套',dueDate:'2026-11-20',syncedAt:'2026-10-16T00:00:00Z',syncedBy:'业务员'}};
    await mount();expect(host.textContent).toContain('未登记 · 1 套');
  });
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


describe('development tab return',()=>{
 const back=async()=>{const link=[...document.body.querySelectorAll<HTMLElement>('button,a')].find(item=>item.textContent?.trim()==='开发与寻样');expect(link).toBeTruthy();await act(async()=>link!.click());};
 it('returns a garment development to the 成衣开发 tab',async()=>{await mount();await back();expect(go).toHaveBeenLastCalledWith('development',undefined,{section:'garment'});});
 it('returns a fabric development to the 面料开发 tab',async()=>{bridge.current.state.devs=[{...bridge.current.state.devs[0],values:{...bridge.current.state.devs[0].values,domain:'fabric'}}];await mount();await back();expect(go).toHaveBeenLastCalledWith('development',undefined,{section:'fabric'});});
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

describe('BB-DEV-7 QC gate on the detail page',()=>{
  const fail=(state:any,id:string,opinion='袖长超差 1.5cm')=>{const v=state.versions.find((row:any)=>row.id===id);v.qc={...v.qc,result:'reject',opinion};};
  const button=(text:string)=>[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()===text) as HTMLButtonElement|undefined;
  it('blocks confirmation on a failed QC and offers rework, resample and abandon for garments',async()=>{
    fail(bridge.current.state,'va');await mount();
    expect(host.textContent).toContain('QC 不通过 · 不能记录确认');expect(host.textContent).toContain('袖长超差 1.5cm');
    expect(button('保存确认')!.disabled).toBe(true);expect(button('整改复检')).toBeTruthy();expect(button('重新打样')).toBeTruthy();expect(button('放弃本版')).toBeTruthy();
    expect(button('更新报告')!.disabled).toBe(true);
    await click('整改复检');await fill('整改要求','袖长改短');await click('确认整改复检');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'development.qc.decide',payload:{devId:'dev-a',versionId:'va',decision:'rework',note:'袖长改短'}});
  });
  it('requires an abandon reason and keeps other versions confirmable',async()=>{
    fail(bridge.current.state,'va');await mount();await click('放弃本版');
    expect(button('确认放弃本版')!.disabled).toBe(true);await fill('放弃原因','工厂能力不足');await click('确认放弃本版');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'development.qc.decide',payload:{devId:'dev-a',versionId:'va',decision:'abandon',note:'工厂能力不足'}});
    await act(async()=>root!.unmount());root=undefined;host.remove();
    const v=bridge.current.state.versions.find((row:any)=>row.id==='va');v.qcDecision={kind:'abandon',note:'工厂能力不足',decidedAt:'2026-10-16T00:00:00Z',decidedBy:'业务员'};
    await mount();expect(host.textContent).toContain('本版已放弃 · 不采用');expect(host.textContent).toContain('不采用');
    await click('R2-B-1');expect(host.textContent).not.toContain('本版已放弃');expect(button('整改复检')).toBeUndefined();
  });
  it('fabric failures have no rework; resample pre-fills the QC opinion into a new round',async()=>{
    fail(bridge.current.state,'va','克重偏低 20g');bridge.current.state.devs[0].values={...bridge.current.state.devs[0].values,domain:'fabric',sampleForm:'米样',sampleUnit:'米'};bridge.current.state.rounds=[];bridge.current.state.market={suppliers:[]};
    await mount();expect(button('整改复检')).toBeUndefined();await click('重新打样');
    const textarea=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')==='本轮共同要求')!.querySelector('textarea')!;
    expect(textarea.value).toContain('克重偏低 20g');expect(document.body.textContent).toContain('重新打样 · 来源 R1-A-1 QC 不通过');
    await click('下一步：逐厂要求');
    const submit=[...document.querySelectorAll('button')].find(item=>item.textContent?.startsWith('建立 '))!;await act(async()=>submit.click());
    expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.round.create',payload:expect.objectContaining({devId:'dev-a',factories:['工厂 va'],referenceVersionIds:['va'],resampleFromVersionId:'va',factoryTasks:[expect.objectContaining({factory:'工厂 va',sampleForm:'米样',sampleUnit:'米'})]})}));
  });
  it('shows 需关注 with the QC opinion for a conditional pass and still allows confirmation',async()=>{
    const v=bridge.current.state.versions.find((row:any)=>row.id==='va');v.qc={...v.qc,result:'conditional',opinion:'领口略紧，量产前确认'};
    await mount();expect(host.textContent).toContain('需关注 · QC 有保留通过');expect(host.textContent).toContain('领口略紧，量产前确认');
    await fill('实际确认人','客户');await fill('确认时间','2026-10-13T15:10');await fill('确认依据','邮件');expect(button('保存确认')!.disabled).toBe(false);
  });
  it('shows every earlier QC after a rework and offers a re-inspection',async()=>{
    const v=bridge.current.state.versions.find((row:any)=>row.id==='va');v.qcHistory=[{...v.qc,result:'reject',opinion:'第一次不通过',decision:{kind:'rework',note:'改袖长',decidedAt:'2026-10-14T00:00:00Z',decidedBy:'业务员'}}];v.qc=null;
    await mount();expect(host.textContent).toContain('历次 QC');expect(host.textContent).toContain('第一次不通过');expect(host.textContent).toContain('整改复检 · 改袖长');expect(button('提交复检')!.disabled).toBe(false);expect(button('保存确认')!.disabled).toBe(true);
  });
});

describe('BB-DEV-10 version links and product conversion',()=>{
  const button=(text:string)=>[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()===text) as HTMLButtonElement|undefined;
  it('converts a conditionally passed version without customer confirmation, using the version factory as supplier',async()=>{
    const st=bridge.current.state;st.market={suppliers:[{id:'sup-b',name:'工厂 vb'}],products:[],quotations:[]};const v=st.versions.find((row:any)=>row.id==='vb');v.qc={...v.qc,result:'conditional',opinion:'袖口需关注'};
    await mount('vb');expect(button('转为产品档案')!.disabled).toBe(false);await click('转为产品档案');expect(document.body.textContent).toContain('袖口需关注');
    await fill('公司产品编码','GA-R2B');await click('建立产品档案');
    expect(bridge.current.run).toHaveBeenCalledWith({type:'market.product.fromVersion',payload:{devId:'dev-a',versionId:'vb',sku:'GA-R2B',supplierId:'sup-b'}});
  });
  it('blocks conversion without a passing QC and shows the reason',async()=>{
    const v=bridge.current.state.versions.find((row:any)=>row.id==='va');v.qc={...v.qc,result:'reject'};await mount('va');
    expect(button('转为产品档案')!.disabled).toBe(true);expect(host.textContent).toContain('本版 QC 不通过，不能转为产品档案');
  });
  it('shows the archive number with a link and lists the exact sample, QC task, quotation and order of this version only',async()=>{
    const st=bridge.current.state;
    st.market={suppliers:[],products:[{id:'prod-1',sku:'GA-2711',name:'实际档案',sourceDevId:'dev-a',sourceVersionId:'vb'}],quotations:[{id:'q-1',code:'QT-0001',lines:[{sourceVersionId:'vb'}],convertedOrderId:'o-2'},{id:'q-2',code:'QT-OTHER',lines:[{sourceVersionId:'va'}]}]};
    st.fulfillment={samples:[{id:'s-1',code:'SM-0001',name:'R2-B 实物',source:{kind:'version',devId:'dev-a',versionId:'vb'}},{id:'s-2',code:'SM-OTHER',name:'其他',source:{kind:'version',devId:'dev-a',versionId:'va'}}],qcTasks:[{id:'t-1',code:'QC-T-1',kind:'sample',factory:'工厂 vb',source:{kind:'version',devId:'dev-a',versionId:'vb'}}]};
    st.orders=[{id:'o-1',code:'SO-0001',customerId:'customer-a'},{id:'o-2',code:'SO-0002',customerId:'customer-a'},{id:'o-3',code:'SO-UNRELATED',customerId:'customer-a'}];st.orderLines=[{id:'l-1',orderId:'o-1',sourceVersionId:'vb'}];
    await mount('vb');const text=[...host.childNodes].map(node=>{const copy=node.cloneNode(true) as HTMLElement;copy.querySelectorAll?.('[data-dev-billing]').forEach(item=>item.remove());return copy.textContent;}).join('');// 开发案级费用卡按整案列出实物，不属于本版关联范围。
    for(const code of ['GA-2711','SM-0001','QC-T-1','QT-0001','SO-0001','SO-0002'])expect(text).toContain(code);
    for(const code of ['SM-OTHER','QT-OTHER','SO-UNRELATED'])expect(text).not.toContain(code);
    expect(button('转为产品档案')).toBeUndefined();
    await act(async()=>[...host.querySelectorAll('button')].find(item=>item.textContent?.trim()==='GA-2711')!.click());expect(go).toHaveBeenCalledWith('products','prod-1');
  });
});

describe('BB-DEV-6/8 fabric physical forms and dispatch on the version detail',()=>{
 const metre={id:'s-m',code:'SMP-0002',name:'测试',category:'面料',form:'米样',unit:'米',quantity:5,available:5,location:'架B',size:'',color:'',source:{kind:'version',devId:'dev-a',versionId:'va'},fileIds:[],note:'',createdAt:'2026-10-12T00:00:00Z'};
 const colour={...metre,id:'s-c',code:'SMP-0001',form:'色样',unit:'份',quantity:3,available:3,location:'架A'};
 const useFabric=(samples:object[])=>{const st=bridge.current.state;st.devs=[{...record,img:'clay',values:{...record.values,domain:'fabric',category:'斜纹',sizeBase:'',sampleForm:'色样',sampleUnit:'份'}}];st.versions[0]={...st.versions[0],sample:'R1-A-实物',size:''};st.fulfillment={samples,sampleMovements:[],qcTasks:[]};};
 async function choose(label:string,value:string){const field=[...document.querySelectorAll('label')].find(item=>item.querySelector('.mist-field-label')?.textContent?.replace('*','')===label);const select=field?.querySelector('select') as HTMLSelectElement;expect(select,label).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,value);select.dispatchEvent(new Event('change',{bubbles:true}));});}
 it('lists every form with its own balance and appends a metre sample to the same version',async()=>{
  useFabric([colour]);await mount();expect(host.textContent).toContain('本版实物与寄样');expect(host.textContent).toContain('3 / 3 份');
  await click('追加形态');await choose('实物形态','米样');await fill('数量（米）','2');await fill('存放位置','架B');await click('保存形态');
  expect(bridge.current.run).toHaveBeenCalledWith({type:'development.version.addSampleForm',payload:{devId:'dev-a',versionId:'va',form:'米样',quantity:2,unit:'米',location:'架B',color:''}});
 });
 it('dispatches the exact selected sample within its available balance, fee optional',async()=>{
  useFabric([colour,metre]);await mount();expect(host.textContent).toContain('5 / 5 米');
  await click('寄样');await choose('寄出实物','s-m');await fill('寄出数量（米）','6');await fill('收件方','客户 Anna');
  expect(document.body.textContent).toContain('超过可用余额 5 米');expect([...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认寄出')!.disabled).toBe(true);
  await fill('寄出数量（米）','2');await fill('运单号','SF123');await click('确认寄出');
  expect(bridge.current.run).toHaveBeenCalledWith({type:'development.sample.dispatch',payload:{devId:'dev-a',versionId:'va',sampleId:'s-m',quantity:2,recipient:'客户 Anna',trackingNo:'SF123',note:'',fee:null}});
 });
 it('selects the actual source position before dispatching stock stored in multiple places',async()=>{
  useFabric([{...metre,location:'多个位置',positions:[{location:'架A',available:1},{location:'架B',available:4}]}]);await mount();
  await click('寄样');await fill('寄出数量（米）','2');await fill('收件方','客户 Anna');
  const submit=()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认寄出')!;
  expect(submit().disabled).toBe(true);
  await choose('本次出库位置','架A');expect(submit().disabled).toBe(true);expect(document.body.textContent).toContain('所选位置');
  await choose('本次出库位置','架B');expect(submit().disabled).toBe(false);await click('确认寄出');
  expect(bridge.current.run).toHaveBeenCalledWith({type:'development.sample.dispatch',payload:{devId:'dev-a',versionId:'va',sampleId:'s-m',quantity:2,recipient:'客户 Anna',trackingNo:'',note:'',fee:null,sourceLocation:'架B'}});
 });
 it('requires choosing which forms a confirmation covers when the version has several',async()=>{
  useFabric([colour,metre]);await mount();
  await fill('实际确认人','实际客户');await fill('确认依据','邮件');
  const save=()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='保存确认')!;
  expect(save().disabled).toBe(true);
  const box=[...document.querySelectorAll('label.mist-check')].find(item=>item.textContent?.includes('米样 · SMP-0002'))!.querySelector('input')!;
  await act(async()=>box.click());expect(save().disabled).toBe(false);
  await click('保存确认');await click('确认提交');
  expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.confirm',payload:expect.objectContaining({versionId:'va',sampleIds:['s-m']})}));
 });
 it('restores confirmed forms and permits a new confirmation when only its physical scope changes',async()=>{
  useFabric([colour,metre]);
  bridge.current.state.versions[0].confirmations=[{id:'confirmed-colour',result:'approved',confirmer:'客户',organization:'客户公司',confirmedAt:'2026-10-13T08:00:00Z',basis:'确认邮件',originalText:'Approved',recordedAt:'2026-10-13T08:00:00Z',recordedBy:'业务员',samples:[{sampleId:colour.id,code:colour.code,form:colour.form,unit:colour.unit}]}];
  await mount();
  const check=(code:string)=>[...document.querySelectorAll('label.mist-check')].find(item=>item.textContent?.includes(code))!.querySelector('input')!;
  expect(check(colour.code).checked).toBe(true);
  expect([...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='本版已记录')!.disabled).toBe(true);
  await act(async()=>{check(colour.code).click();check(metre.code).click();});
  const save=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='保存确认')!;expect(save.disabled).toBe(false);
  await click('存为草稿');
  expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.saveConfirmationDraft',payload:expect.objectContaining({draft:expect.objectContaining({samples:[{sampleId:metre.id,code:metre.code,form:metre.form,unit:metre.unit}]})})}));
  await click('保存确认');await click('确认提交');
  expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'development.confirm',payload:expect.objectContaining({sampleIds:[metre.id],basis:'确认邮件'})}));
 });
 it('restores the selected forms from a saved confirmation draft',async()=>{
  useFabric([colour,metre]);bridge.current.state.versions[0].confirmationDraft={result:'approved',confirmer:'客户',organization:'客户公司',confirmedAt:'2026-10-13T08:00:00Z',basis:'草稿',originalText:'OK',samples:[{sampleId:metre.id,code:metre.code,form:metre.form,unit:metre.unit}]};
  await mount();const checkbox=[...document.querySelectorAll('label.mist-check')].find(item=>item.textContent?.includes(metre.code))!.querySelector('input')!;expect(checkbox.checked).toBe(true);
 });
 it('lets a missing dispatch fee be added later',async()=>{
  useFabric([{...metre,available:3}]);bridge.current.state.versions[0].dispatches=[{id:'d-1',sampleId:'s-m',sampleCode:'SMP-0002',form:'米样',unit:'米',quantity:2,recipient:'客户 Anna',trackingNo:'SF123',fee:null,note:'',movementId:'m-1',recordedAt:'2026-10-16T00:00:00Z',recordedBy:'业务员'}];
  await mount();expect(host.textContent).toContain('SF123');await click('补登费用');await fill('寄样费','28.50');await click('保存费用');
  expect(bridge.current.run).toHaveBeenCalledWith({type:'development.sample.dispatchFee',payload:{devId:'dev-a',versionId:'va',dispatchId:'d-1',fee:{amount:28.5,currency:'CNY'}}});
 });
});
describe('BB-DEV-9 development fees and billing',()=>{
 const metre={id:'s-m',code:'SMP-0002',name:'测试',category:'面料',form:'米样',unit:'米',quantity:5,available:5,location:'架B',size:'',color:'',source:{kind:'version',devId:'dev-a',versionId:'va'},fileIds:[],note:'',createdAt:'2026-10-12T00:00:00Z'};
 const useCharged=(charged:boolean,billing?:object)=>{const st=bridge.current.state;st.devs=[{...record,values:{...record.values,charged},...(billing?{billing}:{})}];st.fulfillment={samples:[metre],sampleMovements:[],qcTasks:[]};st.invoices=[];};
 const button=(text:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);
 it('records a making fee per physical sample and blocks billing until fees are complete',async()=>{
  useCharged(true);await mount();
  expect(host.textContent).toContain('开发费用');expect(host.textContent).toContain('费用尚未补齐');
  expect(button('发起开票')!.disabled).toBe(true);
  await click('登记制作费');await fill('制作费总额','120');await fill('币种','eur');await click('登记');
  expect(bridge.current.run).toHaveBeenCalledWith({type:'development.fee.recordMaking',payload:{devId:'dev-a',sampleId:'s-m',amount:120,currency:'EUR'}});
 });
 it('sends one billing request once fees are complete and links issued invoices back',async()=>{
  useCharged(true,{makingFees:[{sampleId:'s-m',versionId:'va',sampleCode:'SMP-0002',form:'米样',amount:120,currency:'EUR',recordedAt:'',recordedBy:''}]});await mount();
  expect(host.textContent).toContain('120.00 EUR');
  await click('发起开票');
  expect(bridge.current.run).toHaveBeenCalledWith({type:'development.billing.request',payload:{devId:'dev-a'}});
  await act(async()=>root!.unmount());host.remove();
  useCharged(true,{makingFees:[],request:{id:'rq',requestedAt:'2026-10-16T00:00:00Z',requestedBy:'业务员',billTo:'客户',lines:[],totals:[{currency:'EUR',amount:120}],state:'invoiced',invoiceIds:['di'],invoicedBy:'财务'}});
  bridge.current.state.invoices=[{id:'di',code:'DI-2026-0001',orderId:'',order:'DEV-A',customer:'客户',due:'2026-11-15',amount:120,open:0,currency:'EUR',devId:'dev-a'}];
  await mount();
  expect(host.textContent).toContain('已销账');expect(button('发起开票')).toBeUndefined();
  await click('DI-2026-0001');expect(go).toHaveBeenCalledWith('payment-vouchers','di');
 });
 it('shows no billing entry for non-charged developments',async()=>{
  useCharged(false);await mount();
  expect(host.textContent).toContain('不收费开发');expect(button('发起开票')).toBeUndefined();expect(button('登记制作费')).toBeUndefined();
 });
});
