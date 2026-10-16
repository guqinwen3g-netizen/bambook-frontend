import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type DevelopmentValues,type MistContext,type MistCommand} from './mistWorkspace';
import {minorVersionBlocker,minorVersions} from './mistDevelopmentRounds';
import {quotationConversionBlockers} from './mistMarket';
import {developmentNoticeBlocker} from './mistDevelopmentNotice';

function fixture(){
  let n=0;const ctx:MistContext={id:()=>`mv-${++n}`,now:'2026-10-16T09:00:00Z',actorName:'测试业务员'};let state=createMistState(ctx,'empty');
  state.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
  const values:DevelopmentValues={name:'小版本大衣',customer:'c',style:'ST-5',season:'AW',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'首轮版型',factories:['A厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1};
  const run=(command:MistCommand)=>{const r=applyMistCommand(state,command,ctx);state=r.state;return r.result as Record<string,any>;};
  const devId=run({type:'development.submit',payload:{values,fileIds:[]}}).devId as string;
  const version=(label:string)=>state.versions.find(v=>v.devId===devId&&v.label===label)!;
  const ready=(label:string)=>{const id=version(label).id;
    run({type:'development.recordSample',payload:{devId,versionId:id,sample:'S-'+label,quantity:1,returnedAt:'2026-10-15T08:00:00Z'}});
    run({type:'development.recordQc',payload:{devId,versionId:id,qc:{result:'pass',reviewer:'许言',reviewedAt:'2026-10-15T09:00:00Z',report:'QC-1',opinion:'通过',measurements:[]}}});return id;};
  const confirm=(id:string,result:'approved'|'needs_adjustment'='approved')=>run({type:'development.confirm',payload:{devId,versionId:id,result,confirmer:'客户 Anna',organization:'测试客户',confirmedAt:'2026-10-16T08:00:00Z',basis:'邮件',originalText:'OK'}});
  const minor=(id:string,change:string)=>run({type:'development.version.recordMinor',payload:{devId,versionId:id,change}});
  return{ctx,run,devId,version,ready,confirm,minor,get state(){return state;},get dev(){return state.devs.find(d=>d.id===devId)!;}};
}

describe('BB-DEV-5 服装小版本',()=>{
  it('records a small adjustment as R1-A.1, R1-A.2 reusing the major sample and QC, without a new physical sample',()=>{
    const f=fixture(),a=f.ready('R1-A');const samples=f.state.fulfillment.samples.length;
    const first=f.minor(a,'领口改小 0.5cm').versionId as string,second=f.minor(a,'袖口加襻').versionId as string;
    const v1=f.state.versions.find(v=>v.id===first)!,v2=f.state.versions.find(v=>v.id===second)!,major=f.version('R1-A');
    expect([v1.label,v2.label]).toEqual(['R1-A.1','R1-A.2']);
    expect(v1).toMatchObject({sample:major.sample,returnedAt:major.returnedAt,qc:major.qc,confirmations:[],note:'领口改小 0.5cm',minor:{parentVersionId:a,seq:1,change:'领口改小 0.5cm',recordedBy:'测试业务员'}});
    expect(f.dev.versionIds.map(id=>f.state.versions.find(v=>v.id===id)!.label)).toEqual(['R1-A','R1-A.1','R1-A.2']);
    expect(f.dev.currentVersionId).toBe(second);
    expect(f.state.fulfillment.samples.length).toBe(samples); // 不登记新实物
    expect(minorVersions(f.state,major).map(v=>v.label)).toEqual(['R1-A.1','R1-A.2']);
    expect(()=>f.run({type:'development.recordSample',payload:{devId:f.devId,versionId:first,sample:'S-NEW',quantity:1,returnedAt:'2026-10-15T08:00:00Z'}})).toThrow(/沿用大版本实物/);
    expect(()=>f.run({type:'development.recordQc',payload:{devId:f.devId,versionId:first,qc:{result:'pass',reviewer:'许言',reviewedAt:'2026-10-15T09:00:00Z',report:'QC-2',opinion:'',measurements:[]}}})).toThrow(/沿用大版本 QC 结论/);
    expect(()=>f.run({type:'development.recordQc',payload:{devId:f.devId,versionId:a,qc:{result:'reject',reviewer:'许言',reviewedAt:'2026-10-15T09:00:00Z',report:'QC-2',opinion:'',measurements:[]}}})).toThrow(/已有小版本 R1-A.1、R1-A.2/);
    expect(()=>f.minor(first,'再改')).toThrow(/请在大版本 R1-A 上记录小调整/);
    expect(developmentNoticeBlocker(f.state,f.dev,v1)).toMatch(/不单独发试样通知单/);
  });
  it('customer confirmation is recorded per minor version and not inherited: R1-A approved, R1-A.1 unconfirmed cannot convert to order',()=>{
    const f=fixture(),a=f.ready('R1-A');f.confirm(a);
    const m=f.minor(a,'下摆加长 1cm').versionId as string;
    expect(f.state.versions.find(v=>v.id===m)!.confirmations).toEqual([]);
    expect(f.dev.state).not.toBe('已认可 · 待留档');
    const line=(id:string)=>({lines:[{id:'l',productId:'',sourceDevId:f.devId,sourceVersionId:id,name:'大衣',style:'ST-5'}]} as never);
    expect(quotationConversionBlockers(f.state,line(m))).toEqual([expect.objectContaining({versionLabel:'R1-A.1',reason:'尚无需求方确认'})]);
    expect(quotationConversionBlockers(f.state,line(a))).toEqual([]);
    f.confirm(m);
    expect(quotationConversionBlockers(f.state,line(m))).toEqual([]);
    expect(f.state.versions.find(v=>v.id===a)!.confirmations).toHaveLength(1); // 大版本确认未被改写
  });
  it('converts the exact minor version to a product archive without falling back to the major',()=>{
    const f=fixture(),a=f.ready('R1-A'),m=f.minor(a,'换扣子').versionId as string;
    const r=f.run({type:'market.product.fromVersion',payload:{devId:f.devId,versionId:m,sku:'SKU-MINOR'}});
    const product=f.state.market.products.find(p=>p.id===r.id)!;
    expect(product.sourceVersionId).toBe(m);expect(product.note).toContain('R1-A.1');
    f.run({type:'development.archive',payload:{devId:f.devId,versionId:m}});
    expect(f.state.versions.find(v=>v.id===m)!.archivedAt).toBeTruthy();expect(f.state.versions.find(v=>v.id===a)!.archivedAt).toBeNull();
  });
  it('blocks small adjustments before return/QC, on fabric developments, and without writing',()=>{
    const f=fixture(),a=f.version('R1-A').id,before=JSON.stringify(f.state);
    expect(()=>f.minor(a,'x')).toThrow(/先登记返样实物/);expect(JSON.stringify(f.state)).toBe(before);
    f.ready('R1-A');expect(()=>f.minor(a,' ')).toThrow(/调整内容/);
    const fabric=fixture();fabric.ready('R1-A');(fabric.dev.values as DevelopmentValues&{domain?:string}).domain='fabric'; // 面料开发：返样与 QC 齐备也没有小版本入口
    expect(minorVersionBlocker(fabric.state,fabric.dev,fabric.version('R1-A'))).toMatch(/面料开发没有小版本/);
    expect(()=>fabric.minor(fabric.version('R1-A').id,'x')).toThrow(/面料开发没有小版本/);
  });
});
