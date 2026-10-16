import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type DevelopmentValues,type MistContext,type MistCommand} from './mistWorkspace';
import {developmentRoundViews,factoryLetterAt,parseVersionLabel} from './mistDevelopmentRounds';

function fixture(){
  let n=0;const ctx:MistContext={id:()=>`rd-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'测试业务员'};let state=createMistState(ctx,'empty');
  state.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
  const values:DevelopmentValues={name:'轮次测试大衣',customer:'c',style:'ST-1',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'首轮版型',factories:['A厂','B厂','C厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1};
  const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result;};
  return{ctx,values,run,get state(){return state;}};
}
const labels=(f:ReturnType<typeof fixture>,devId:string)=>f.state.devs.find(d=>d.id===devId)!.versionIds.map(id=>f.state.versions.find(v=>v.id===id)!.label);

describe('BB-DEV-2 development rounds and fixed factory letters',()=>{
  it('A/B/C do R1, then R2 sends only C plus new D: versions R2-C and R2-D, R1 unchanged',()=>{
    const f=fixture(),ids=f.run({type:'development.submit',payload:{values:f.values,fileIds:[]}}),devId=ids.devId!;
    expect(labels(f,devId)).toEqual(['R1-A','R1-B','R1-C']);
    const r1=JSON.parse(JSON.stringify(f.state.versions.filter(v=>v.devId===devId)));
    const c1=r1.find((v:any)=>v.factory==='C厂');
    const r=f.run({type:'development.round.create',payload:{devId,factories:['C厂','D厂'],requirements:'收腰 2cm，换哑光扣',referenceVersionIds:[c1.id],targetDate:'2026-11-10'}});
    expect(labels(f,devId)).toEqual(['R1-A','R1-B','R1-C','R2-C','R2-D']);
    expect(f.state.versions.filter(v=>r1.some((old:any)=>old.id===v.id))).toEqual(r1);
    const round=f.state.rounds!.find(x=>x.id===r.roundId)!;
    expect(round).toMatchObject({number:2,requirements:'收腰 2cm，换哑光扣',referenceVersionIds:[c1.id],factories:['C厂','D厂'],targetDate:'2026-11-10'});
    expect(f.state.devs.find(d=>d.id===devId)!.factoryLetters).toEqual({'A厂':'A','B厂':'B','C厂':'C','D厂':'D'});
    expect(f.state.versions.find(v=>v.label==='R2-D')).toMatchObject({roundId:round.id,factoryLetter:'D',note:'收腰 2cm，换哑光扣',returnedAt:null,qc:null});
    // A rejoining later keeps its first letter.
    f.run({type:'development.round.create',payload:{devId,factories:['A厂'],requirements:'回到 A 方案',targetDate:'2026-11-20'}});
    expect(labels(f,devId).at(-1)).toBe('R3-A');
  });
  it('validates round inputs in the command and writes nothing on failure',()=>{
    const f=fixture(),devId=f.run({type:'development.submit',payload:{values:f.values,fileIds:[]}}).devId!,before=JSON.stringify(f.state);
    for(const payload of [{factories:[],requirements:'x',targetDate:'2026-11-01'},{factories:['A厂'],requirements:' ',targetDate:'2026-11-01'},{factories:['A厂'],requirements:'x',targetDate:'2026-13-01'},{factories:['A厂'],requirements:'x',targetDate:'2026-11-01',referenceVersionIds:['missing']},{factories:['A厂'],requirements:'x',targetDate:'2026-11-01',fileIds:['missing']}])
      expect(()=>f.run({type:'development.round.create',payload:{devId,...payload} as any})).toThrow();
    expect(JSON.stringify(f.state)).toBe(before);
    const other=f.run({type:'development.submit',payload:{values:{...f.values,name:'另一案'},fileIds:[]}});
    const foreign=f.state.versions.find(v=>v.devId===other.devId)!.id;
    expect(()=>f.run({type:'development.round.create',payload:{devId,factories:['A厂'],requirements:'x',targetDate:'2026-11-01',referenceVersionIds:[foreign]}})).toThrow(/本开发案/);
  });
  it('revise opens the next round for the same factory with its fixed letter',()=>{
    const f=fixture(),ids=f.run({type:'development.submit',payload:{values:f.values,fileIds:[]}}),devId=ids.devId!;
    const b=f.state.versions.find(v=>v.label==='R1-B')!;
    const r=f.run({type:'development.revise',payload:{devId,versionId:b.id,note:'袖长 -1cm'}});
    expect(f.state.versions.find(v=>v.id===r.versionId)!.label).toBe('R2-B');
    expect(f.state.rounds!.find(x=>x.id===r.roundId)).toMatchObject({number:2,factories:['B厂'],referenceVersionIds:[b.id],requirements:'袖长 -1cm'});
  });
  it('keeps historical labels as-is and derives their letters and rounds read-only',()=>{
    const f=fixture(),devId=f.run({type:'development.submit',payload:{values:{...f.values,factories:['A厂']},fileIds:[]}}).devId!;
    const legacy=f.state.versions.find(v=>v.devId===devId)!;
    const state=JSON.parse(JSON.stringify(f.state));const v=state.versions.find((x:any)=>x.id===legacy.id);v.label='R2-B-1';delete v.roundId;delete v.factoryLetter;state.rounds=[];delete state.devs[0].factoryLetters;
    const ctx={...f.ctx};const next=applyMistCommand(state,{type:'development.round.create',payload:{devId,factories:['A厂','E厂'],requirements:'第三轮',targetDate:'2026-11-01'}},ctx).state;
    const after=next.devs[0].versionIds.map((id:string)=>next.versions.find((x:any)=>x.id===id)!.label);
    expect(after).toEqual(['R2-B-1','R3-B','R3-A']);
    expect(developmentRoundViews(next,next.devs[0]).map(view=>[view.number,!!view.round,view.versions.map(x=>x.label)])).toEqual([[2,false,['R2-B-1']],[3,true,['R3-B','R3-A']]]);
  });
  it('allocates letters beyond Z and parses both label styles',()=>{
    expect([0,3,25,26,27].map(factoryLetterAt)).toEqual(['A','D','Z','AA','AB']);
    expect(parseVersionLabel('R4-A.1')).toEqual({round:4,letter:'A'});expect(parseVersionLabel('R1-A-1')).toEqual({round:1,letter:'A'});expect(parseVersionLabel('R2-C')).toEqual({round:2,letter:'C'});
  });
});

describe('acceptance review #59: round creation boundaries',()=>{
  const setup=()=>{
    let n=0;const ctx:MistContext={id:()=>`rv-${++n}`,now:'2026-10-16T10:00:00Z',actorName:'测试'};let state=createMistState(ctx,'empty');
    state.customers.push({id:'c',name:'客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
    const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result;};
    const values:DevelopmentValues={initiator:'customer',requestType:'replicate',name:'边界测试',customer:'c',style:'B-1',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'首轮',factories:['A厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1};
    const ids=run({type:'development.submit',payload:{values,fileIds:[]}});
    return{run,devId:ids.devId!,versionId:ids.versionId!,ctx,get state(){return state;}};
  };
  const round=(devId:string,extra:Record<string,unknown>={})=>({type:'development.round.create' as const,payload:{devId,factories:['A厂'],requirements:'第二轮',targetDate:'2026-11-01',...extra}});
  for(const kind of ['cancelled','archived'] as const)it(`rejects a new round, revise and resample on a ${kind} case without writing`,()=>{
    const t=setup();t.run({type:'development.close',payload:{devId:t.devId,kind,reason:'客户撤单'}});
    const before=JSON.stringify(t.state);
    expect(()=>t.run(round(t.devId))).toThrow(kind==='cancelled'?/已取消，不能再开新一轮/:/已归档，不能再开新一轮/);
    expect(()=>t.run({type:'development.revise',payload:{devId:t.devId,versionId:t.versionId,note:'改'}})).toThrow(/不能再开新一轮/);
    expect(JSON.stringify(t.state)).toBe(before);
  });
  it('rejects a new round, including resample, on a closed (non-charged, approved) case',()=>{
    const t=setup(),dev=t.state.devs.find(d=>d.id===t.devId)!;dev.values.charged=false;
    t.run({type:'development.recordSample',payload:{devId:t.devId,versionId:t.versionId,sample:'S',quantity:1,returnedAt:t.ctx.now}});
    t.run({type:'development.recordQc',payload:{devId:t.devId,versionId:t.versionId,qc:{result:'pass',reviewer:'QC',reviewedAt:t.ctx.now,report:'R',opinion:'通过',measurements:[]}}});
    t.run({type:'development.confirm',payload:{devId:t.devId,versionId:t.versionId,result:'approved',confirmer:'客户',organization:'',confirmedAt:t.ctx.now,basis:'邮件',originalText:''}});
    const before=JSON.stringify(t.state);
    expect(()=>t.run(round(t.devId))).toThrow(/已结案，不能再开新一轮/);
    expect(JSON.stringify(t.state)).toBe(before);
  });
  it('rejects duplicate factories within one round instead of silently de-duplicating',()=>{
    const t=setup(),before=JSON.stringify(t.state);
    expect(()=>t.run(round(t.devId,{factories:['A厂','B厂',' A厂 ']}))).toThrow(/同一轮内工厂不能重复：A厂/);
    expect(JSON.stringify(t.state)).toBe(before);
    expect(t.run(round(t.devId,{factories:['A厂','B厂']})).versionIds).toHaveLength(2);
  });
  it('requires a reason to cancel or archive a case',()=>{
    const t=setup();expect(()=>t.run({type:'development.close',payload:{devId:t.devId,kind:'cancelled',reason:'  '}})).toThrow();
    expect(t.state.devs.find(d=>d.id===t.devId)!.closure).toBeUndefined();
  });
});
