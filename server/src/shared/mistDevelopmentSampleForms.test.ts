import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,mistCommandPermission,type DevelopmentValues,type MistContext,type MistCommand} from './mistWorkspace';
import {emptyFabricRequirements} from './mistDevelopmentDomain';
import {developmentVersionSamples} from './mistDevelopmentSamples';

/** BB-DEV-6 面料版本多形态实物 / BB-DEV-8 版本详情寄样。 */
function fixture(){
 let n=0;const ctx:MistContext={id:()=>`sf-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'测试业务员'};let state=createMistState(ctx,'empty');
 state.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
 state.market.suppliers.push({id:'f',code:'F',name:'测试面料厂',type:'面料工厂',capabilities:'织造',status:'active',country:'',address:'',capacity:0,capacityUnit:'米',leadDays:0,blockReason:'',contacts:[],fileIds:[],note:'',createdAt:ctx.now,updatedAt:ctx.now});
 const values:DevelopmentValues={domain:'fabric',name:'测试斜纹',customer:'c',style:'',season:'AW',category:'斜纹',kind:'new',fabric:'目标',color:'蓝灰',target:'2.50',targetCurrency:'EUR',targetUnit:'米',sizeBase:'',goal:'手感',factories:['测试面料厂'],due:'2026-11-01',collaborators:[],sampleQuantity:3,sampleForm:'色样',sampleUnit:'份',fabricRequirements:{...emptyFabricRequirements(),composition:'羊毛:100'}} as DevelopmentValues;
 const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result as any;};
 const ids=run({type:'development.submit',payload:{values,fileIds:[]}}) as {devId:string;versionId:string};
 const at={devId:ids.devId,versionId:ids.versionId};
 const record=(quantity:number,form:string,unit:string)=>run({type:'development.recordSample',payload:{...at,sample:'R1-A-实物',quantity,form,unit,location:'架A',returnedAt:ctx.now}});
 const qc=()=>run({type:'development.recordQc',payload:{...at,domain:'fabric',qc:{result:'pass',reviewer:'QC',reviewedAt:ctx.now,report:'QC-1',opinion:'通过'}}});
 const confirm=(sampleIds?:string[])=>run({type:'development.confirm',payload:{...at,result:'approved',confirmer:'客户',organization:'测试客户',confirmedAt:ctx.now,basis:'邮件',originalText:'OK',...(sampleIds?{sampleIds}:{})}});
 const version=()=>state.versions.find(v=>v.id===at.versionId)!;
 const samples=()=>developmentVersionSamples(state,version());
 const unchanged=(fn:()=>unknown,pattern:RegExp)=>{const before=JSON.stringify(state);expect(fn).toThrow(pattern);expect(JSON.stringify(state)).toBe(before);};
 return{ctx,run,at,record,qc,confirm,version,samples,unchanged,get state(){return state;}};
}
describe('BB-DEV-6 fabric version physical forms',()=>{
 it('R1-A: colour sample 3 pcs confirmed, then 2 m metre sample appended → same archive shows two balance rows',()=>{
  const f=fixture();f.record(3,'色样','份');f.qc();f.confirm();
  expect(f.version().confirmations[0].samples).toBeUndefined();
  const r=f.run({type:'development.version.addSampleForm',payload:{...f.at,form:'米样',quantity:2,unit:'米',location:'架B'}});
  const rows=f.samples();
  expect(rows.map(s=>[s.form,s.unit,s.quantity,s.available,s.location])).toEqual([['色样','份',3,3,'架A'],['米样','米',2,2,'架B']]);
  expect(rows.every(s=>s.source.kind==='version'&&s.source.versionId===f.at.versionId&&s.sourceSampleCode==='R1-A-实物')).toBe(true);
  expect(r.id).toBe(rows[1].id);
  expect(f.state.fulfillment.sampleMovements.filter(m=>m.kind==='receive').map(m=>m.sampleId)).toEqual(rows.map(s=>s.id));
  // 原有 QC 与确认不被改写；后续全局同步不重复入库。
  expect(f.version().qc?.report).toBe('QC-1');expect(f.version().confirmations).toHaveLength(1);
  f.run({type:'fulfillment.samples.sync',payload:{}});expect(f.samples()).toHaveLength(2);
 });
 it('requires confirmations to name the exact forms once a version has several, and snapshots them',()=>{
  const f=fixture();f.record(3,'色样','份');f.run({type:'development.version.addSampleForm',payload:{...f.at,form:'米样',quantity:2,unit:'米'}});f.qc();
  f.unchanged(()=>f.confirm(),/形态/);
  f.unchanged(()=>f.confirm(['not-a-sample']),/本版的准确实物/);
  const [colour,metre]=f.samples();f.confirm([metre.id,metre.id]);
  expect(f.version().confirmations[0].samples).toEqual([{sampleId:metre.id,code:metre.code,form:'米样',unit:'米'}]);
  expect(f.state.events[0].text).toContain('米样 '+metre.code);expect(colour.form).toBe('色样');
 });
 it.each([
  [{form:'色样',quantity:1.5,unit:'份'},/整数份/],[{form:'米样',quantity:2,unit:'份'},/米样按米/],[{form:'',quantity:2,unit:'份'},/形态/],[{form:'米样',quantity:0,unit:'米'},/数量/],
 ])('rejects invalid appended forms without writing: %j',(input,pattern)=>{const f=fixture();f.record(3,'色样','份');f.unchanged(()=>f.run({type:'development.version.addSampleForm',payload:{...f.at,...input}}),pattern);});
 it('blocks appending before return and on cancelled developments',()=>{
  const f=fixture();f.unchanged(()=>f.run({type:'development.version.addSampleForm',payload:{...f.at,form:'米样',quantity:1,unit:'米'}}),/先登记本版返样/);
  f.record(3,'色样','份');f.run({type:'development.close',payload:{devId:f.at.devId,kind:'cancelled',reason:'客户取消'}});
  f.unchanged(()=>f.run({type:'development.version.addSampleForm',payload:{...f.at,form:'米样',quantity:1,unit:'米'}}),/已取消/);
 });
 it('uses the development write permission',()=>{
  expect(mistCommandPermission({type:'development.version.addSampleForm',payload:{} as any})).toBe('products:write');
  expect(mistCommandPermission({type:'development.sample.dispatch',payload:{} as any})).toBe('products:write');
  expect(mistCommandPermission({type:'development.sample.dispatchFee',payload:{} as any})).toBe('products:write');
 });
});
describe('BB-DEV-8 dispatch from version detail',()=>{
 it('metre sample 5 m, send 2 m → 3 m available with a send movement linked back to this development',()=>{
  const f=fixture();f.record(5,'米样','米');const [metre]=f.samples();
  const r=f.run({type:'development.sample.dispatch',payload:{...f.at,sampleId:metre.id,quantity:2,recipient:'测试客户 Anna',trackingNo:'SF123',fee:null}});
  const after=f.samples()[0], move=f.state.fulfillment.sampleMovements.find(m=>m.kind==='send')!;
  expect(after.available).toBe(3);expect(after.quantity).toBe(5);
  expect(move).toMatchObject({sampleId:metre.id,quantity:2,person:'测试客户 Anna',trackingNo:'SF123',development:{devId:f.at.devId,versionId:f.at.versionId,dispatchId:r.id}});
  expect(f.version().dispatches).toEqual([expect.objectContaining({id:r.id,sampleId:metre.id,sampleCode:metre.code,form:'米样',unit:'米',quantity:2,recipient:'测试客户 Anna',trackingNo:'SF123',fee:null,movementId:move.id})]);
  // 无需仓库二次确认：没有待处理任务，余额即时扣减。
  expect(f.state.tasks.filter(t=>t.title.includes('寄'))).toHaveLength(0);
 });
 it('lets the fee be added later once, without changing quantities',()=>{
  const f=fixture();f.record(5,'米样','米');const [metre]=f.samples();
  const {id}=f.run({type:'development.sample.dispatch',payload:{...f.at,sampleId:metre.id,quantity:1.5,recipient:'客户'}});
  f.unchanged(()=>f.run({type:'development.sample.dispatchFee',payload:{...f.at,dispatchId:id,fee:{amount:12.345,currency:'CNY'}}}),/两位小数/);
  f.run({type:'development.sample.dispatchFee',payload:{...f.at,dispatchId:id,fee:{amount:28.5,currency:'cny'}}});
  expect(f.version().dispatches![0]).toMatchObject({fee:{amount:28.5,currency:'CNY'},quantity:1.5,feeRecordedBy:'测试业务员'});
  expect(f.samples()[0].available).toBe(3.5);
  f.unchanged(()=>f.run({type:'development.sample.dispatchFee',payload:{...f.at,dispatchId:id,fee:{amount:30,currency:'CNY'}}}),/不能覆盖/);
 });
 it('rejects over-available, fractional pieces, missing recipient, other versions\' samples, and bad fee without writing',()=>{
  const f=fixture();f.record(3,'色样','份');const [colour]=f.samples();
  const send=(patch:object)=>()=>f.run({type:'development.sample.dispatch',payload:{...f.at,sampleId:colour.id,quantity:1,recipient:'客户',...patch}});
  f.unchanged(send({quantity:4}),/超过可用余额/);
  f.unchanged(send({quantity:1.5}),/整数/);
  f.unchanged(send({quantity:0}),/正数/);
  f.unchanged(send({recipient:' '}),/收件方/);
  f.unchanged(send({fee:{amount:-1,currency:'CNY'}}),/金额/);
  f.unchanged(send({fee:{amount:1,currency:'人民币'}}),/币种/);
  f.state.fulfillment.samples.push({...colour,id:'foreign',code:'SMP-X',source:{kind:'manual',label:'其他'} as any});
  f.unchanged(send({sampleId:'foreign'}),/本版的准确实物/);
  f.run({type:'development.sample.dispatch',payload:{...f.at,sampleId:colour.id,quantity:3,recipient:'客户'}});
  expect(f.samples()[0].available).toBe(0);
  f.unchanged(send({}),/已无可用余额/);
 });
});
