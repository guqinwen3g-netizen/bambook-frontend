import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type DevelopmentValues,type MistContext,type MistCommand} from './mistWorkspace';
import {emptyFabricRequirements} from './mistDevelopmentDomain';
import {developmentVersionComparison,versionSource,versionTimelineStatus} from './mistDevelopmentCompare';

/** 隔离合成数据：成衣案（3 厂 2 轮）与面料案（2 厂 2 轮），覆盖未返样、QC 中、需关注、认可、不采用。 */
function fixture(){
  let n=0;const ctx:MistContext={id:()=>`cmp-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'测试业务员'};let state=createMistState(ctx,'empty');
  state.customers.push({id:'c',name:'合成客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
  state.market.suppliers.push(...['合成面料甲厂','合成面料乙厂'].map(name=>({id:name,code:name,name,type:'面料工厂',capabilities:'织造',status:'active',country:'',address:'',capacity:0,capacityUnit:'米',leadDays:0,blockReason:'',contacts:[],fileIds:[],note:'',createdAt:ctx.now,updatedAt:ctx.now}) as any));
  const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result as Record<string,any>;};
  const garmentId=run({type:'development.submit',payload:{values:{name:'合成大衣',customer:'c',style:'SYN-G',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'首轮',factories:['A厂','B厂','C厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1} as DevelopmentValues,fileIds:[]}}).devId as string;
  const fabricId=run({type:'development.submit',payload:{values:{domain:'fabric',name:'合成斜纹',customer:'c',style:'',season:'AW',category:'斜纹',kind:'new',fabric:'目标',color:'蓝灰',target:'',sizeBase:'',goal:'手感',factories:['合成面料甲厂','合成面料乙厂'],due:'2026-11-01',collaborators:[],sampleQuantity:2,sampleForm:'米样',sampleUnit:'米',fabricRequirements:{...emptyFabricRequirements(),composition:'羊毛:100',weightValue:'280',weightUnit:'g/m²'}} as DevelopmentValues,fileIds:[]}}).devId as string;
  const v=(devId:string,label:string)=>state.versions.find(x=>x.devId===devId&&x.label===label)!;
  const sample=(devId:string,label:string,fabric=false)=>run({type:'development.recordSample',payload:{devId,versionId:v(devId,label).id,sample:'S-'+label,quantity:fabric?1.5:1,returnedAt:'2026-10-15T08:00:00Z',...(fabric?{form:'米样',unit:'米',color:'蓝灰'}:{})}});
  const qc=(devId:string,label:string,result:'pass'|'conditional'|'reject',fabric=false)=>run({type:'development.recordQc',payload:{devId,versionId:v(devId,label).id,...(fabric?{domain:'fabric' as const}:{}),qc:{result,reviewer:'许言',reviewedAt:'2026-10-15T09:00:00Z',report:'QC-'+label,opinion:label+' 意见',measurements:fabric?[]:[{point:'胸围',standard:112,actual:113.5,tolerance:1}],...(fabric?{fabricMeasurements:[{property:'克重',actual:276,unit:'g/m²'}]}:{})}}});
  const confirm=(devId:string,label:string,result:'approved'|'rejected')=>run({type:'development.confirm',payload:{devId,versionId:v(devId,label).id,result,confirmer:'Anna',organization:'合成客户',confirmedAt:'2026-10-16T08:00:00Z',basis:'邮件',originalText:label+(result==='approved'?' 认可':' 不采用')}});
  // 成衣：R1-A 认可，R1-B 有保留通过后客户不采用，R1-C 未返样；R2 A/B：R2-A 已返样待 QC，R2-B 未返样
  sample(garmentId,'R1-A');qc(garmentId,'R1-A','pass');confirm(garmentId,'R1-A','approved');
  sample(garmentId,'R1-B');qc(garmentId,'R1-B','conditional');confirm(garmentId,'R1-B','rejected');
  run({type:'development.round.create',payload:{devId:garmentId,factories:['A厂','B厂'],requirements:'收腰 2cm',referenceVersionIds:[v(garmentId,'R1-A').id],targetDate:'2026-11-10'}});
  sample(garmentId,'R2-A');
  // 面料：R1-A 有保留通过待确认；R1-B QC 不通过后放弃；R2-A 未返样
  sample(fabricId,'R1-A',true);qc(fabricId,'R1-A','conditional',true);
  sample(fabricId,'R1-B',true);qc(fabricId,'R1-B','reject',true);run({type:'development.qc.decide',payload:{devId:fabricId,versionId:v(fabricId,'R1-B').id,decision:'abandon',note:'手感不符'}});
  run({type:'development.round.create',payload:{devId:fabricId,factories:['合成面料甲厂'],requirements:'克重提高',targetDate:'2026-11-12',factoryTasks:[{factory:'合成面料甲厂',extraRequirements:'',sampleForm:'米样',sampleQuantity:2,sampleUnit:'米',dueDate:'2026-11-12'}]}});
  const dev=(id:string)=>state.devs.find(d=>d.id===id)!;
  return{get state(){return state;},garmentId,fabricId,v,dev};
}

describe('BB-DEV-11 时间线状态（只来自已记录事实）',()=>{
  it('maps each exact version to 待返样 / QC 中 / 需关注 / 待确认 / 认可 / 不采用 without inventing steps',()=>{
    const f=fixture(),s=(id:string,l:string)=>{const x=versionTimelineStatus(f.v(id,l));return [x.label,...x.flags.map(y=>y.label)].join('+');};
    expect(s(f.garmentId,'R1-A')).toBe('认可');
    expect(s(f.garmentId,'R1-B')).toBe('不采用+需关注');
    expect(s(f.garmentId,'R1-C')).toBe('待返样');
    expect(s(f.garmentId,'R2-A')).toBe('QC 中');
    expect(s(f.garmentId,'R2-B')).toBe('待返样');
    expect(s(f.fabricId,'R1-A')).toBe('待确认+需关注');
    expect(s(f.fabricId,'R1-B')).toBe('不采用');
    expect(s(f.fabricId,'R2-A')).toBe('待返样');
    expect(versionSource(f.state,f.dev(f.garmentId),f.v(f.garmentId,'R2-B'))).toMatchObject({round:2,roundLabel:'第 2 轮',factory:'B厂',label:'R2-B'});
  });
});

describe('BB-DEV-11 多版本对比',()=>{
  it('lines up QC, customer opinion and key specs per exact version with round / factory source; missing stays 未记录',()=>{
    const f=fixture(),dev=f.dev(f.garmentId),ids=['R1-A','R1-B','R2-B'].map(l=>f.v(f.garmentId,l).id);
    const c=developmentVersionComparison(f.state,dev,ids),row=(key:string)=>c.rows.find(r=>r.key===key)!.values;
    expect(c.versions.map(x=>x.label)).toEqual(['R1-A','R1-B','R2-B']);expect(c.rejected).toEqual([]);
    expect(row('round')).toEqual(['第 1 轮','第 1 轮','第 2 轮']);expect(row('factory')).toEqual(['A厂','B厂','B厂']);
    expect(row('qcResult')).toEqual(['通过','有保留通过','未返样，无 QC']);
    expect(row('qcOpinion')).toEqual(['R1-A 意见','R1-B 意见','未记录']);
    expect(row('qcFacts')[0]).toBe('1 个测量点 · 超出公差 1（胸围）');expect(row('qcFacts')[2]).toBe('未记录');
    expect(row('confirmResult')[0]).toMatch(/^认可 · Anna（合成客户）/);expect(row('confirmResult')[1]).toMatch(/^不采用/);expect(row('confirmResult')[2]).toBe('尚无确认');
    expect(row('confirmText')).toEqual(['R1-A 认可','R1-B 不采用','未记录']);
    expect(row('sample')[2]).toBe('未返样');expect(row('size')).toEqual(['M','M','M']);
    expect(row('task')[2]).toBe('收腰 2cm');
  });
  it('never mixes versions from another development case into the comparison',()=>{
    const f=fixture(),dev=f.dev(f.garmentId),other=f.v(f.fabricId,'R1-A').id;
    const c=developmentVersionComparison(f.state,dev,[f.v(f.garmentId,'R1-A').id,other,'missing-id',f.v(f.garmentId,'R1-A').id]);
    expect(c.versions.map(x=>x.label)).toEqual(['R1-A']);expect(c.rejected).toEqual([other,'missing-id']);
    expect(c.rows.every(r=>r.values.length===1)).toBe(true);expect(c.rows.find(r=>r.key==='qcOpinion')!.values).toEqual(['R1-A 意见']);
  });
  it('fabric comparison labels target specs as 非实测 and shows QC fabric measurements separately',()=>{
    const f=fixture(),dev=f.dev(f.fabricId),c=developmentVersionComparison(f.state,dev,['R1-A','R1-B','R2-A'].map(l=>f.v(f.fabricId,l).id)),row=(key:string)=>c.rows.find(r=>r.key===key)!;
    expect(row('composition').label).toBe('目标成分（非实测）');expect(row('composition').values).toEqual(['羊毛:100','羊毛:100','羊毛:100']);
    expect(row('weight').values[0]).toBe('280 g/m²');
    expect(row('qcFacts').values).toEqual(['克重 276 g/m²','克重 276 g/m²','未记录']);
    expect(row('qcResult').values).toEqual(['有保留通过','不通过','未返样，无 QC']);
    expect(row('status').values).toEqual(['待确认 · 需关注','不采用','待返样']);
    expect(row('form').values).toEqual(['米样 / 蓝灰','米样 / 蓝灰','未记录']);
    expect(c.rows.some(r=>r.key==='size')).toBe(false);
  });
});
