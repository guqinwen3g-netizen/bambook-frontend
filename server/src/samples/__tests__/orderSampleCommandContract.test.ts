import { describe,it,expect } from 'vitest';
import { parseOrderSampleRegister,parseOrderSampleAppend,orderSampleCommandIdentity } from '../orderSampleCommandContract';
const fp='a'.repeat(64);
const register=()=>({protocolVersion:1,requestKey:'register-001',family:'fabric_ss',orderId:'o',factoryRelationId:'f',expectedParentFingerprint:fp,previousSourceId:null,
  sampleFacts:{quantity:'0.2500',unit:'meter',cuttingDate:'2026-10-04'},coverage:[{orderLineId:'l',expectedLineFingerprint:fp,productionBatchId:'b',expectedBatchRevision:1,rangeStart:'0',quantity:'100',unit:'M'}]});
describe('native sample command boundary',()=>{
  const details={verification:'颜色与手感\n对照封样',physicalSample:'染整后实样',differences:'色差0.5，手感一致',attachments:[{name:'对照照片',reference:'archive:sample/photo-001'}]};
  it('keeps complete registration details without creating QC authority',()=>{const parsed=parseOrderSampleRegister({...register(),family:'fabric_eps',registrationDetails:details});expect(parsed.registrationDetails).toEqual(details);expect(parseOrderSampleRegister(register())).not.toHaveProperty('registrationDetails');});
  it.each([{...details,verification:''},{...details,differences:' '},{...details,attachments:[{name:'照片',reference:'blob:temporary'}]},{...details,attachments:[{name:'照片',reference:'javascript:alert(1)'}]},{...details,attachments:[...details.attachments,...details.attachments]},{...details,qcResult:'passed'}])('rejects incomplete or unstable registration evidence %#',registrationDetails=>expect(()=>parseOrderSampleRegister({...register(),registrationDetails})).toThrow());
  it('normalizes independent precise sample quantity without borrowing bulk quantity',()=>{const c=parseOrderSampleRegister(register());expect(c.sampleFacts).toEqual({quantity:'0.25',unit:'M',cuttingDate:'2026-10-04'});expect(c.coverage[0].quantity).toBe('100');});
  it.each(['short','a'.repeat(129),'requests 1','\nrequest123','中文request1'])('rejects unstable key %s',key=>expect(()=>parseOrderSampleRegister({...register(),requestKey:key})).toThrow());
  it.each([0.25,'0','1.00001','01','1e2'])('rejects nonexact quantity %s',quantity=>expect(()=>parseOrderSampleRegister({...register(),sampleFacts:{...register().sampleFacts,quantity}})).toThrow());
  it('rejects body actor and client authority',()=>expect(()=>parseOrderSampleRegister({...register(),actorId:'owner'})).toThrow());
  it('rejects orphan or invented batch revision',()=>expect(()=>parseOrderSampleRegister({...register(),coverage:[{...register().coverage[0],productionBatchId:null}]})).toThrow());
  it('requires explicit first or previous round',()=>{const r:any=register();delete r.previousSourceId;expect(()=>parseOrderSampleRegister(r)).toThrow();});
  it('canonically sorts exact decimal starts rather than floating point',()=>{const r=register();r.coverage=[{...r.coverage[0],rangeStart:'1.1'},{...r.coverage[0],rangeStart:'1.02'}];expect(parseOrderSampleRegister(r).coverage.map(c=>c.rangeStart)).toEqual(['1.02','1.1']);});
  it('never accepts embedded QC as authenticated report',()=>expect(()=>parseOrderSampleAppend({protocolVersion:1,requestKey:'review-001',sourceId:'s',expectedHead:{eventId:'e',sequence:1},eventType:'qc_reviewed',occurredAt:'2026-10-04',payload:{report:{result:'passed'}}})).toThrow());
  it('rejects impossible dates',()=>expect(()=>parseOrderSampleRegister({...register(),sampleFacts:{...register().sampleFacts,cuttingDate:'2026-02-30'}})).toThrow());
  it('identity binds actor and key independent of target',()=>{expect(orderSampleCommandIdentity('a','request-1')).not.toEqual(orderSampleCommandIdentity('b','request-1'));expect(orderSampleCommandIdentity('a','request-1')).toEqual(orderSampleCommandIdentity('a','request-1'));});
 it('does not accept passing QC with fatal defects',()=>expect(()=>parseOrderSampleAppend({protocolVersion:1,requestKey:'qc-review-001',sourceId:'s',expectedHead:{eventId:'request',sequence:2},eventType:'qc_reviewed',occurredAt:'2026-10-04',payload:{requestedEventId:'request',result:'pass',opinion:'检验',inspectionDate:'2026-10-04',inspectorOrg:'QC',totalUnits:1,passedUnits:1,sampleSize:1,criticalDefects:1,majorDefects:0,minorDefects:0,defectSummary:'fatal',reportFile:null}})).toThrow());

});
