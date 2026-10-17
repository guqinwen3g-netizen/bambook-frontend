import {describe,it,expect} from 'vitest';
import { withTestFactories } from './__tests__/utils/devFactories';
import {applyMistCommand,createMistState,type DevelopmentValues,type MistContext,type MistCommand} from './mistWorkspace';

function fixture(){
  let n=0;const ctx:MistContext={id:()=>`in-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'测试业务员',actorId:'test-sales'};let state=withTestFactories(createMistState(ctx,'empty'));
  state.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
  state.market.suppliers.push({id:'f',code:'F',name:'实际测试面料厂',type:'面料工厂',capabilities:'织造染整',status:'active',country:'',address:'',capacity:0,capacityUnit:'米',leadDays:0,blockReason:'',contacts:[],fileIds:[],note:'',createdAt:ctx.now,updatedAt:ctx.now});
  state.platform.employees.push({id:'emp-1',name:'林面料',department:'面料部',position:'面料开发',contact:'',startDate:'2026-01-01',note:'',active:true,history:[]});
  const fabric:DevelopmentValues={domain:'fabric',initiator:'internal',requester:'林面料',requesterId:'emp-1',name:'内部斜纹开发',customer:'',style:'',season:'AW',category:'斜纹',kind:'new',fabric:'',color:'蓝灰',target:'',sizeBase:'',goal:'储备面料',factories:['实际测试面料厂'],due:'2026-10-30',collaborators:[],sampleQuantity:2,sampleForm:'米样',sampleUnit:'米'};
  const garment:DevelopmentValues={initiator:'customer',requestType:'replicate',name:'客户来样复刻',customer:'c',style:'ST-1',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'按来样复刻',factories:['A厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1};
  const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result;};
  return{ctx,fabric,garment,run,get state(){return state;}};
}


describe('BB-DEV-10 product archive from an exact version',()=>{
  it('converts R2-B after a conditional QC without customer confirmation and links both ways',()=>{
    const f=fixture();f.garment.factories=['A厂','B厂'];
    const first=f.run({type:'development.submit',payload:{values:f.garment,fileIds:[]}}),devId=first.devId!;
    const r2=f.run({type:'development.round.create',payload:{devId,factories:['A厂','B厂'],requirements:'第二轮：袖长 -1cm',targetDate:'2026-11-01'}});
    const b=f.state.versions.find(v=>r2.versionIds.includes(v.id)&&v.factory==='B厂')!;expect(b.label).toBe('R2-B');
    f.run({type:'development.recordSample',payload:{devId,versionId:b.id,sample:'S-R2B',quantity:1,returnedAt:f.ctx.now}});
    expect(()=>f.run({type:'market.product.fromVersion',payload:{devId,versionId:b.id,sku:'GA-R2B'}})).toThrow(/QC 通过或有保留通过/);
    f.run({type:'development.recordQc',payload:{devId,versionId:b.id,qc:{result:'conditional',reviewer:'QC',reviewedAt:f.ctx.now,report:'QC-R2B',opinion:'袖口需关注',measurements:[]}}});
    expect(b.confirmations).toHaveLength(0);
    const product=f.run({type:'market.product.fromVersion',payload:{devId,versionId:b.id,sku:'GA-R2B'}});
    const saved=f.state.market.products.find(p=>p.id===product.id)!;
    expect(saved).toMatchObject({sku:'GA-R2B',sourceDevId:devId,sourceVersionId:b.id});
    expect(f.state.market.products.filter(p=>p.sourceVersionId===b.id)).toHaveLength(1);
    expect(f.run({type:'market.product.fromVersion',payload:{devId,versionId:b.id,sku:'GA-OTHER'}}).id).toBe(product.id);
  });
  it('does not convert a failed or abandoned version',()=>{
    const f=fixture(),ids=f.run({type:'development.submit',payload:{values:f.garment,fileIds:[]}}),devId=ids.devId!,versionId=ids.versionId!;
    f.run({type:'development.recordSample',payload:{devId,versionId,sample:'S',quantity:1,returnedAt:f.ctx.now}});
    f.run({type:'development.recordQc',payload:{devId,versionId,qc:{result:'reject',reviewer:'QC',reviewedAt:f.ctx.now,report:'QC-X',opinion:'不通过',measurements:[]}}});
    expect(()=>f.run({type:'market.product.fromVersion',payload:{devId,versionId,sku:'X'}})).toThrow(/QC 通过或有保留通过/);
    f.run({type:'development.qc.decide',payload:{devId,versionId,decision:'abandon',note:'放弃'}});
    expect(()=>f.run({type:'market.product.fromVersion',payload:{devId,versionId,sku:'X'}})).toThrow(/QC 通过或有保留通过/);
  });
});
