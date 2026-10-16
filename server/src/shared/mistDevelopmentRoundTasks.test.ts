import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type DevelopmentValues,type MistContext,type MistCommand} from './mistWorkspace';
import {factoryTaskSync} from './mistDevelopmentRounds';

function fixture(){
  let n=0;const ctx:MistContext={id:()=>`rt-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'测试业务员'};let state=createMistState(ctx,'empty');
  state.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
  const values:DevelopmentValues={name:'逐厂任务大衣',customer:'c',style:'ST-3',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'首轮版型',factories:['A厂','B厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1};
  const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result as Record<string,any>;};
  const devId=run({type:'development.submit',payload:{values,fileIds:[]}}).devId as string;
  const version=(label:string)=>state.versions.find(v=>v.devId===devId&&v.label===label)!;
  return{ctx,run,devId,version,get state(){return state;}};
}
const r2=(f:ReturnType<typeof fixture>,extra:Record<string,unknown>={})=>f.run({type:'development.round.create',payload:{devId:f.devId,factories:['A厂','B厂','C厂'],requirements:'收腰 2cm',referenceVersionIds:[f.version('R1-A').id],targetDate:'2026-11-10',factoryTasks:[
  {factory:'A厂',extraRequirements:'A 厂另改领型',sampleForm:'样衣',sampleQuantity:2,sampleUnit:'件',dueDate:'2026-11-05'},
  {factory:'C厂',extraRequirements:'',sampleForm:'半成品',sampleQuantity:1,sampleUnit:'套',dueDate:'2026-11-12'}],...extra}});

describe('BB-DEV-3 开新一轮：逐厂任务与共同要求同步',()=>{
  it('copies the common requirements into each factory task with its own differences, sample and due date',()=>{
    const f=fixture();r2(f);
    expect(f.version('R2-A').task).toMatchObject({commonRequirements:'收腰 2cm',extraRequirements:'A 厂另改领型',sampleForm:'样衣',sampleQuantity:2,sampleUnit:'件',dueDate:'2026-11-05'});
    expect(f.version('R2-A').sampleQuantity).toBe(2);expect(f.version('R2-A').note).toBe('收腰 2cm\n本厂差异：A 厂另改领型');
    // 未单独填写的 B 厂按开发案计划样品与本轮目标日期
    expect(f.version('R2-B').task).toMatchObject({commonRequirements:'收腰 2cm',extraRequirements:'',sampleForm:'样衣',sampleQuantity:1,sampleUnit:'件',dueDate:'2026-11-10'});
    expect(f.version('R2-C').task).toMatchObject({sampleForm:'半成品',sampleUnit:'套',dueDate:'2026-11-12'});
  });
  it('rejects tasks for factories outside the round, duplicated tasks and invalid samples without writing',()=>{
    const f=fixture(),before=JSON.stringify(f.state);
    const bad=(factoryTasks:unknown[],pattern:RegExp)=>{expect(()=>f.run({type:'development.round.create',payload:{devId:f.devId,factories:['A厂'],requirements:'x',targetDate:'2026-11-10',factoryTasks:factoryTasks as never}})).toThrow(pattern);expect(JSON.stringify(f.state)).toBe(before);};
    bad([{factory:'Z厂'}],/只能填写本轮参与工厂：Z厂/);
    bad([{factory:'A厂'},{factory:'A厂'}],/同一工厂只能有一份/);
    bad([{factory:'A厂',sampleQuantity:0}],/A厂：样品数量须为正整数/);
    bad([{factory:'A厂',sampleQuantity:1.5}],/正整数/);
    bad([{factory:'A厂',sampleForm:' '}],/A厂：请填写样品形态/);
    bad([{factory:'A厂',dueDate:'11/05'}],/A厂：请填写要求日期/);
  });
  it('changing the common requirements does not overwrite factory tasks; each shows 与共同要求不一致 until synced one by one',()=>{
    const f=fixture(),roundId=r2(f).roundId as string;
    const tasksBefore=JSON.stringify(['R2-A','R2-B','R2-C'].map(l=>f.version(l).task));
    f.run({type:'development.round.updateRequirements',payload:{devId:f.devId,roundId,requirements:'收腰 3cm，下摆加长'}});
    expect(f.state.rounds!.find(r=>r.id===roundId)!.requirements).toBe('收腰 3cm，下摆加长');
    expect(JSON.stringify(['R2-A','R2-B','R2-C'].map(l=>f.version(l).task))).toBe(tasksBefore);
    expect(['R2-A','R2-B','R2-C'].map(l=>factoryTaskSync(f.state,f.version(l))!.inSync)).toEqual([false,false,false]);
    expect(f.state.events.some(e=>/修改第 2 轮共同要求；待逐厂同步：R2-A、R2-B、R2-C/.test(e.text||''))).toBe(true);
    f.run({type:'development.version.syncRequirements',payload:{devId:f.devId,versionId:f.version('R2-A').id}});
    expect(f.version('R2-A').task).toMatchObject({commonRequirements:'收腰 3cm，下摆加长',extraRequirements:'A 厂另改领型',sampleQuantity:2,dueDate:'2026-11-05'});
    expect(f.version('R2-A').note).toBe('收腰 3cm，下摆加长\n本厂差异：A 厂另改领型');
    expect(['R2-A','R2-B','R2-C'].map(l=>factoryTaskSync(f.state,f.version(l))!.inSync)).toEqual([true,false,false]);
    expect(f.version('R2-B').task!.commonRequirements).toBe('收腰 2cm');
    expect(()=>f.run({type:'development.version.syncRequirements',payload:{devId:f.devId,versionId:f.version('R2-A').id}})).toThrow(/已与共同要求一致/);
  });
  it('blocks syncing after the sample returned, unchanged or blank requirements, and changes on a closed case',()=>{
    const f=fixture(),roundId=r2(f).roundId as string;
    expect(()=>f.run({type:'development.round.updateRequirements',payload:{devId:f.devId,roundId,requirements:'收腰 2cm'}})).toThrow(/没有变化/);
    expect(()=>f.run({type:'development.round.updateRequirements',payload:{devId:f.devId,roundId,requirements:'  '}})).toThrow(/共同要求/);
    f.run({type:'development.recordSample',payload:{devId:f.devId,versionId:f.version('R2-B').id,sample:'S-B',quantity:1,returnedAt:f.ctx.now}});
    f.run({type:'development.round.updateRequirements',payload:{devId:f.devId,roundId,requirements:'收腰 3cm'}});
    expect(()=>f.run({type:'development.version.syncRequirements',payload:{devId:f.devId,versionId:f.version('R2-B').id}})).toThrow(/R2-B 已返样，改要求请开新一轮/);
    f.run({type:'development.close',payload:{devId:f.devId,kind:'cancelled',reason:'客户撤单'}});
    expect(()=>f.run({type:'development.version.syncRequirements',payload:{devId:f.devId,versionId:f.version('R2-A').id}})).toThrow(/已取消/);
    expect(()=>f.run({type:'development.round.updateRequirements',payload:{devId:f.devId,roundId,requirements:'收腰 4cm'}})).toThrow(/已取消，不能再改共同要求/);
  });
  it('keeps rounds created before BB-DEV-3 (no task) comparable by their note and syncable',()=>{
    const f=fixture(),r1=f.version('R1-A'),roundId=r1.roundId!;delete r1.task;
    expect(factoryTaskSync(f.state,r1)!.inSync).toBe(true);
    f.run({type:'development.round.updateRequirements',payload:{devId:f.devId,roundId,requirements:'首轮版型（修订）'}});
    expect(factoryTaskSync(f.state,f.version('R1-A'))!.inSync).toBe(false);
    f.run({type:'development.version.syncRequirements',payload:{devId:f.devId,versionId:f.version('R1-A').id}});
    expect(f.version('R1-A').task).toMatchObject({commonRequirements:'首轮版型（修订）',sampleQuantity:1,dueDate:'2026-10-30'});
  });
});
