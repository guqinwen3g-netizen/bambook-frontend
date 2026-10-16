import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type DevelopmentValues,type MistContext,type MistCommand} from './mistWorkspace';

function fixture(){
  let n=0;const ctx:MistContext={id:()=>`in-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'测试业务员'};let state=createMistState(ctx,'empty');
  state.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
  state.market.suppliers.push({id:'f',code:'F',name:'实际测试面料厂',type:'面料工厂',capabilities:'织造染整',status:'active',country:'',address:'',capacity:0,capacityUnit:'米',leadDays:0,blockReason:'',contacts:[],fileIds:[],note:'',createdAt:ctx.now,updatedAt:ctx.now});
  state.platform.employees.push({id:'emp-1',name:'林面料',department:'面料部',position:'面料开发',contact:'',startDate:'2026-01-01',note:'',active:true,history:[]});
  const fabric:DevelopmentValues={domain:'fabric',initiator:'internal',requester:'林面料',requesterId:'emp-1',name:'内部斜纹开发',customer:'',style:'',season:'AW',category:'斜纹',kind:'new',fabric:'',color:'蓝灰',target:'',sizeBase:'',goal:'储备面料',factories:['实际测试面料厂'],due:'2026-10-30',collaborators:[],sampleQuantity:2,sampleForm:'米样',sampleUnit:'米'};
  const garment:DevelopmentValues={initiator:'customer',requestType:'replicate',name:'客户来样复刻',customer:'c',style:'ST-1',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'按来样复刻',factories:['A厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1};
  const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result;};
  return{ctx,fabric,garment,run,get state(){return state;}};
}

const qc=(result:'pass'|'conditional'|'reject',opinion='意见',fabric=false)=>({result,reviewer:'QC 甲',reviewedAt:'2026-10-16T09:00:00Z',report:'QC-'+result,opinion,...(fabric?{fabricMeasurements:[]}:{measurements:[]})});
const confirm=(devId:string,versionId:string)=>({type:'development.confirm' as const,payload:{devId,versionId,result:'approved' as const,confirmer:'客户',organization:'',confirmedAt:'2026-10-16T09:00:00Z',basis:'邮件',originalText:'OK'}});
function garmentCase(){
  const f=fixture(),ids=f.run({type:'development.submit',payload:{values:f.garment,fileIds:[]}}),devId=ids.devId!,versionId=ids.versionId!;
  f.run({type:'development.recordSample',payload:{devId,versionId,sample:'S-1',quantity:1,returnedAt:f.ctx.now}});
  return{f,devId,versionId};
}

describe('BB-DEV-7 QC gate and failed-QC handling',()=>{
  it('rejects confirmation without QC and with a failed QC; pass and conditional allow it',()=>{
    const {f,devId,versionId}=garmentCase();
    expect(()=>f.run(confirm(devId,versionId))).toThrow(/尚未完成 QC/);
    f.run({type:'development.recordQc',payload:{devId,versionId,qc:qc('reject','肩线偏移')}});
    expect(()=>f.run(confirm(devId,versionId))).toThrow(/QC 不通过/);
    expect(()=>f.run({type:'development.move',payload:{devId,stage:3}})).toThrow(/QC 通过或有保留通过/);
    const other=garmentCase();other.f.run({type:'development.recordQc',payload:{devId:other.devId,versionId:other.versionId,qc:qc('conditional','领口需关注')}});
    other.f.run(confirm(other.devId,other.versionId));
    expect(other.f.state.versions.find(v=>v.id===other.versionId)!.confirmations).toHaveLength(1);
    other.f.run({type:'development.archive',payload:{devId:other.devId,versionId:other.versionId}});
    expect(other.f.state.versions.find(v=>v.id===other.versionId)!.archivedAt).toBeTruthy();
  });
  it('garment rework keeps every QC and a second passing QC can continue to confirmation',()=>{
    const {f,devId,versionId}=garmentCase();
    f.run({type:'development.recordQc',payload:{devId,versionId,qc:qc('reject','袖长超差')}});
    expect(()=>f.run({type:'development.recordQc',payload:{devId,versionId,qc:qc('pass')}})).toThrow(/整改复检/);
    f.run({type:'development.qc.decide',payload:{devId,versionId,decision:'rework',note:'工厂改袖长'}});
    let v=f.state.versions.find(x=>x.id===versionId)!;
    expect(v.qc).toBeNull();expect(v.qcHistory).toHaveLength(1);expect(v.qcHistory![0]).toMatchObject({result:'reject',opinion:'袖长超差',decision:{kind:'rework',note:'工厂改袖长'}});
    expect(f.state.devs.find(d=>d.id===devId)!.state).toBe('整改中 · 待复检');
    f.run({type:'development.recordQc',payload:{devId,versionId,qc:qc('pass','复检通过')}});
    v=f.state.versions.find(x=>x.id===versionId)!;expect(v.qc).toMatchObject({result:'pass',opinion:'复检通过'});expect(v.qcHistory).toHaveLength(1);
    f.run(confirm(devId,versionId));
    expect(f.state.versions.find(x=>x.id===versionId)!.confirmations.at(-1)).toMatchObject({result:'approved'});
  });
  it('fabric has no rework option; resample opens a new round and marks the source version',()=>{
    const f=fixture(),ids=f.run({type:'development.submit',payload:{values:f.fabric,fileIds:[]}}),devId=ids.devId!,versionId=ids.versionId!;
    f.run({type:'development.recordSample',payload:{devId,versionId,sample:'F-1',quantity:2,form:'米样',unit:'米',location:'A',color:'蓝灰',returnedAt:f.ctx.now}});
    f.run({type:'development.recordQc',payload:{devId,versionId,domain:'fabric',qc:qc('reject','克重偏低',true)}});
    expect(()=>f.run({type:'development.qc.decide',payload:{devId,versionId,decision:'rework',note:''}})).toThrow(/面料开发没有整改复检/);
    const round=f.run({type:'development.round.create',payload:{devId,factories:['实际测试面料厂'],requirements:'QC 意见：克重偏低，请加密',referenceVersionIds:[versionId],targetDate:'2026-11-05',resampleFromVersionId:versionId}});
    const source=f.state.versions.find(x=>x.id===versionId)!;
    expect(source.qcDecision).toMatchObject({kind:'resample',roundId:round.roundId});
    expect(f.state.versions.find(x=>x.id===round.versionId)!.label).toBe('R2-A');
    expect(()=>f.run({type:'development.round.create',payload:{devId,factories:['实际测试面料厂'],requirements:'再来',targetDate:'2026-11-05',resampleFromVersionId:versionId}})).toThrow(/尚未处理/);
  });
  it('abandon marks only that version as not adopted and blocks further QC or confirmation',()=>{
    const f=fixture();f.garment.factories=['A厂','B厂'];
    const ids=f.run({type:'development.submit',payload:{values:f.garment,fileIds:[]}}),devId=ids.devId!;
    const [a,b]=f.state.versions.filter(v=>v.devId===devId);
    for(const v of [a,b])f.run({type:'development.recordSample',payload:{devId,versionId:v.id,sample:'S-'+v.id,quantity:1,returnedAt:f.ctx.now}});
    f.run({type:'development.recordQc',payload:{devId,versionId:a.id,qc:qc('reject','做工差')}});
    f.run({type:'development.qc.decide',payload:{devId,versionId:a.id,decision:'abandon',note:'工厂能力不足'}});
    expect(f.state.versions.find(v=>v.id===a.id)!.qcDecision).toMatchObject({kind:'abandon',note:'工厂能力不足'});
    expect(()=>f.run({type:'development.qc.decide',payload:{devId,versionId:a.id,decision:'rework',note:''}})).toThrow(/已选择处理方式/);
    expect(()=>f.run(confirm(devId,a.id))).toThrow();
    f.run({type:'development.recordQc',payload:{devId,versionId:b.id,qc:qc('pass')}});f.run(confirm(devId,b.id));
    expect(f.state.versions.find(v=>v.id===b.id)!.confirmations).toHaveLength(1);expect(f.state.versions.find(v=>v.id===b.id)!.qcDecision).toBeUndefined();
  });
  it('only a failed, unhandled QC accepts a decision',()=>{
    const {f,devId,versionId}=garmentCase();f.run({type:'development.recordQc',payload:{devId,versionId,qc:qc('pass')}});
    expect(()=>f.run({type:'development.qc.decide',payload:{devId,versionId,decision:'abandon',note:''}})).toThrow(/只有最新 QC 不通过/);
  });
});

describe('acceptance review #64: abandon reason is enforced on the server',()=>{
  it('rejects abandon without a reason (blank or spaces) and writes nothing',()=>{
    const {f,devId,versionId}=garmentCase();
    f.run({type:'development.recordQc',payload:{devId,versionId,qc:qc('reject','做工差')}});
    const before=JSON.stringify(f.state);
    for(const note of ['','   ',undefined as unknown as string])expect(()=>f.run({type:'development.qc.decide',payload:{devId,versionId,decision:'abandon',note}})).toThrow(/放弃本版须填写原因/);
    expect(JSON.stringify(f.state)).toBe(before);
    expect(f.state.versions.find(v=>v.id===versionId)!.qcDecision).toBeUndefined();
  });
});
