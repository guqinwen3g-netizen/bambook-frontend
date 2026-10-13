import { describe,it,expect,vi,beforeEach } from 'vitest';
const state=vi.hoisted(()=>({enabled:true,write:true,access:'owner',ceiling:true,parentChanged:false,sequence:0,parentMissing:false,qcAuditFails:false,caps:['products:read','orders:read','sample:shipment:write','sample:early_production:write','products:write']}));
vi.mock('../sampleRegistrationContextService',()=>({currentRegistrationActor:vi.fn(async(_tx:any,actor:any)=>{if(!state.enabled)throw Error('ACCOUNT_DISABLED');return {...actor,roles:[],permissions:state.caps,authorizationLoaded:true};})}));
vi.mock('../../shared/businessNumberService',()=>({nextBusinessNumber:async(tx:any,prefix:string,_year:any,opts:any)=>{state.sequence++;const code=`${prefix}-2026-${String(state.sequence).padStart(4,'0')}`;if(await opts.occupied(code))throw Error('occupied');return code;}}));
vi.mock('../../auth/permissionService',()=>({hasScope:(a:any,s:string)=>state.ceiling&&a.permissions.includes(s),createPermissionService:()=>({getDataScopeResolver:async()=>({rule:{kind:'self'}})})}));
vi.mock('../../_shared/rolePermissionMatrix',()=>({resolveWriteKind:()=> 'self'}));
vi.mock('../../teams/teamShareService',()=>({createTeamShareService:()=>({resolveRelationAccess:async()=>state.access})}));
vi.mock('../../orders/orderLineWriteAccess',()=>({freshOrderLineScope:async()=>({ownerId:'u'})}));
vi.mock('../orderSampleParentResolver',()=>({OrderSampleParentError:class OrderSampleParentError extends Error {},resolveOrderSampleParents:async(_tx:any,r:any)=>{if (state.parentMissing) throw Error('PARENT_DELETED'); if (Object.keys(r).sort().join(',')!=='coverage,factoryRelationId,family,orderId') throw Error('UNDEFINED_PARENT_FIELDS'); const businessLine=r.family.startsWith('fabric')?'fabric':'garment';const spec={color:'blue'};
const line={id:'l',orderId:'o',factoryRelationId:'f',quantity:'100',unit:businessLine==='fabric'?'M':'PC',specSnapshot:spec,sourceFingerprint:'a'.repeat(64),lineFingerprint:'b'.repeat(64)};
return {owner:{orderId:'o',factoryRelationId:'f',businessLine},specSnapshot:spec,coverage:r.coverage,lines:[line],batches:[{id:'b',orderId:'o',orderLineId:'l',factoryRelationId:'f',rangeStart:'0',quantity:'100',unit:line.unit,revision:1,state:'active',specSnapshot:spec,sourceFingerprint:line.sourceFingerprint}],parentFingerprint:state.parentChanged?'d'.repeat(64):'c'.repeat(64),lockRefs:{relationIds:['f'],developmentCaseIds:[],sealSampleIds:[],sealSampleBatchIds:[],sampleBatchIds:[],productAssetIds:[],fabricProfileIds:[],garmentProfileIds:[],sampleIds:[],sampleSourceIds:[],orderIds:['o'],orderLineIds:['l'],productionBatchIds:['b'],auditLogIds:[]}};}}));
import { createOrderSampleCommandService } from '../orderSampleCommandService';
import { loadOrderSampleRecord } from '../orderSampleRecordReader';
const actor:any={userId:'u',roles:[],permissionCeiling:['products:read','orders:read','sample:shipment:write','sample:early_production:write','products:write']};
function input(family='fabric_ss',key='register-001'){const unit=family.startsWith('fabric')?'M':'PC';return {protocolVersion:1,requestKey:key,family,orderId:'o',factoryRelationId:'f',expectedParentFingerprint:'c'.repeat(64),previousSourceId:null,sampleFacts:{quantity:unit==='M'?'0.25':'1',unit,cuttingDate:'2026-10-04'},coverage:[{orderLineId:'l',expectedLineFingerprint:'b'.repeat(64),productionBatchId:'b',expectedBatchRevision:1,rangeStart:'0',quantity:'100',unit}]};}
function memory(){
 const rows:any={samples:[],sources:[],coverage:[],events:[],audits:[],reports:[]},locks:string[]=[];
 const create=(kind:string)=>async({data}:any)=>{if(kind==='audits'&&data.action==='order_sample_qc_review'&&state.qcAuditFails)throw Error('QC_AUDIT_UNAVAILABLE');rows[kind].push(structuredClone(data));return data;};
 const tx:any={inspectionReport:{create:create('reports'),findUnique:async({where}:any)=>rows.reports.find((r:any)=>r.id===where.id)},order:{findFirst:async()=>({id:'o',customerRelationId:'customer',ownerId:'u'})},sample:{create:create('samples'),findFirst:async({where}:any)=>rows.samples.find((r:any)=>r.code===where.code),findUnique:async({where}:any)=>rows.samples.find((r:any)=>r.id===where.id)},sampleSource:{findMany:async()=>[]},
 sampleCardItem:{findMany:async()=>[]},
 orderSampleCommandCancellation:{findUnique:async()=>null},
 orderSampleSource:{create:create('sources'),findUnique:async({where}:any)=>rows.sources.find((r:any)=>r.id===where.id),updateMany:async({where,data}:any)=>{const row=rows.sources.find((r:any)=>r.id===where.id&&r.headSequence===where.headSequence&&r.headEventId===where.headEventId);if(!row)return {count:0};Object.assign(row,data);return {count:1};}},
 orderSampleCoverage:{create:create('coverage'),findMany:async({where}:any)=>rows.coverage.filter((r:any)=>r.sourceId===where.sourceId)},
 orderSampleEvent:{create:create('events'),findMany:async({where}:any)=>rows.events.filter((r:any)=>Object.entries(where).every(([k,v])=>r[k]===v)).sort((a:any,b:any)=>a.sequence-b.sequence)},
 auditLog:{create:create('audits'),findUnique:async({where}:any)=>rows.audits.find((r:any)=>r.id===where.id),findMany:async({where}:any)=>rows.audits.filter((r:any)=>where.id.in.includes(r.id))},
 $queryRaw:async(query:any)=>{locks.push(query.sql);return [{id:'present'}];}};
 const prisma={$transaction:async(work:any)=>{const before=structuredClone(rows);try{return await work(tx);}catch(e){Object.assign(rows,before);throw e;}}};
 return {rows,locks,tx,service:createOrderSampleCommandService({prisma,clock:()=>1791072000000})};
}
beforeEach(()=>{state.enabled=true;state.access='owner';state.ceiling=true;state.parentChanged=false;state.parentMissing=false;state.qcAuditFails=false;state.sequence=0;state.caps=['products:read','orders:read','sample:shipment:write','sample:early_production:write','products:write'];});
describe('native order sample transaction producer',()=>{
 it('permanently cancelled registration refuses all writes before receipt replay',async()=>{
  const m=memory();m.tx.orderSampleCommandCancellation.findUnique=vi.fn(async()=>({id:'cancelled-register'}));
  await expect(m.service.register(actor,input())).rejects.toThrow('原请求已明确取消');
  expect(m.rows.samples).toHaveLength(0);expect(m.rows.events).toHaveLength(0);expect(m.rows.audits).toHaveLength(0);
 });
 it('permanently cancelled event cannot append to a valid existing source',async()=>{
  const m=memory(),a=await m.service.register(actor,input());
  m.tx.orderSampleCommandCancellation.findUnique=vi.fn(async()=>({id:'cancelled-event'}));
  await expect(m.service.append(actor,{protocolVersion:1,requestKey:'cancelled-001',sourceId:a.sourceId,expectedHead:{eventId:a.eventId,sequence:1},eventType:'invalidated',occurredAt:'2026-10-04',payload:{reason:'stop'}})).rejects.toThrow('原请求已明确取消');
  expect(m.rows.events).toHaveLength(1);expect(m.rows.audits).toHaveLength(2);
 });
 it('unavailable cancellation storage cannot be treated as permission to submit',async()=>{
  const m=memory();m.tx.orderSampleCommandCancellation.findUnique=vi.fn(async()=>{throw Error('ledger unavailable');});
  await expect(m.service.register(actor,input())).rejects.toThrow('ledger unavailable');
  expect(m.rows.samples).toHaveLength(0);expect(m.rows.events).toHaveLength(0);
 });
 it.each(['fabric_ss','fabric_rc','fabric_eps','garment_pp','garment_top','garment_ship'])('persists complete %s source and actual audit receipt',async family=>{const m=memory(),ack=await m.service.register(actor,input(family));const r=await loadOrderSampleRecord(m.tx,ack.sourceId);expect(r.source.family).toBe(family);expect(r.events).toHaveLength(1);expect(r.acknowledgements[0]).toEqual(ack);expect(m.rows.samples[0].sourceCaseId).toBeNull();expect(m.rows.sources[0].headEventId).toBe(ack.eventId);expect(m.rows.coverage[0].quantity).toBe('100');expect(m.rows.sources[0].sampleQuantity).toBe(family.startsWith('fabric')?'0.25':'1');});
 it('persists pioneer verification and evidence atomically, replays it and refuses changed details',async()=>{
  const m=memory(),registrationDetails={verification:'核对颜色与手感',physicalSample:'工厂染整实样',differences:'与封样色差0.5',attachments:[{name:'色差照片',reference:'archive:photo-001'}]},command={...input('fabric_eps'),registrationDetails};
  const ack=await m.service.register(actor,command),record=await loadOrderSampleRecord(m.tx,ack.sourceId);
  expect(record.events[0].payload).toMatchObject({registrationDetails});expect(record.source.sampleFacts).toEqual(command.sampleFacts);expect(record.view.qc).toBeNull();expect(m.rows.reports).toHaveLength(0);expect(await m.service.register(actor,command)).toEqual(ack);
  await expect(m.service.register(actor,{...command,registrationDetails:{...registrationDetails,differences:'另一结果'}})).rejects.toThrow();expect(m.rows.events).toHaveLength(1);
 });
 it('returns original stored ACK after clock/status changed and no duplicate rows',async()=>{const m=memory(),ack=await m.service.register(actor,input());m.rows.samples[0].status='sent';expect(await m.service.register(actor,input())).toEqual(ack);expect(m.rows.events).toHaveLength(1);expect(m.rows.audits).toHaveLength(2);expect(state.sequence).toBe(1);});
 it('rejects same key with different normalized quantity',async()=>{const m=memory();await m.service.register(actor,input());await expect(m.service.register(actor,{...input(),sampleFacts:{quantity:'0.5',unit:'M',cuttingDate:'2026-10-04'}})).rejects.toThrow();expect(m.rows.sources).toHaveLength(1);});
 it('normalization aliases retry as identical request',async()=>{const m=memory(),ack=await m.service.register(actor,input());expect(await m.service.register(actor,{...input(),sampleFacts:{quantity:'0.2500',unit:'meter',cuttingDate:'2026-10-04'}})).toEqual(ack);});
 it.each(['team-read','none'])('denies %s writes without persisting anything',async access=>{state.access=access;const m=memory();await expect(m.service.register(actor,input())).rejects.toThrow();expect(m.rows.samples).toHaveLength(0);});
 it('allows actual team followup without a leader role',async()=>{state.access='team-followup';expect((await memory().service.register(actor,input())).eventSequence).toBe(1);});
 it('fabric registration requires family cap but does not require product write',async()=>{state.caps=state.caps.filter(c=>c!=='products:write');await expect(memory().service.register(actor,input())).resolves.toBeTruthy();await expect(memory().service.register(actor,input('garment_pp'))).rejects.toThrow();});
 it('revoked current account prevents replay',async()=>{const m=memory();await m.service.register(actor,input());state.enabled=false;await expect(m.service.register(actor,input())).rejects.toThrow();expect(m.rows.events).toHaveLength(1);});
 it('signed credential ceiling cannot be bypassed by DB permission grant',async()=>{state.ceiling=false;const m=memory();await expect(m.service.register(actor,input())).rejects.toThrow();expect(m.rows.samples).toHaveLength(0);});
 it('stale parent token does not create source or stock',async()=>{state.parentChanged=true;const m=memory();await expect(m.service.register(actor,input())).rejects.toThrow();expect(m.rows.sources).toHaveLength(0);expect(m.locks.some(l=>l.includes('Warehouse'))).toBe(false);});
 it('locks Line before Batch and Sample before Source birth',async()=>{const m=memory();await m.service.register(actor,input());expect(m.locks.findIndex(l=>l.includes('"OrderLine"'))).toBeLessThan(m.locks.findIndex(l=>l.includes('"ProductionBatch"')));expect(m.locks.some(l=>l.includes('"Sample"'))).toBe(true);});
 it('ships and records feedback of exact shipped event then replays original shipping ACK',async()=>{const m=memory(),registered=await m.service.register(actor,input());const shippedInput={protocolVersion:1,requestKey:'shipping-001',sourceId:registered.sourceId,expectedHead:{eventId:registered.eventId,sequence:1},eventType:'shipped',occurredAt:'2026-10-04',payload:{sentDate:'2026-10-04',courier:'DHL',trackingNumber:'tracking1',directShipment:true}};const shipped=await m.service.append(actor,shippedInput);
 const feedback=await m.service.append(actor,{protocolVersion:1,requestKey:'feedback-001',sourceId:registered.sourceId,expectedHead:{eventId:shipped.eventId,sequence:2},eventType:'customer_feedback',occurredAt:'2026-10-04',payload:{shippedEventId:shipped.eventId,result:'approved',channel:'written',confirmationDate:'2026-10-04',evidenceRefs:['proof1']}});
 expect(feedback.eventSequence).toBe(3);expect(await m.service.append(actor,shippedInput)).toEqual(shipped);expect(m.rows.events).toHaveLength(3);});
 it('stale event head refuses append and keeps full chain unchanged',async()=>{const m=memory(),ack=await m.service.register(actor,input());await expect(m.service.append(actor,{protocolVersion:1,requestKey:'invalid-001',sourceId:ack.sourceId,expectedHead:{eventId:'stale',sequence:1},eventType:'invalidated',occurredAt:'2026-10-04',payload:{reason:'obsolete'}})).rejects.toThrow();expect(m.rows.events).toHaveLength(1);});
 it('cannot forge QC before garment shipping',async()=>{const m=memory(),ack=await m.service.register(actor,input('garment_pp'));await expect(m.service.append(actor,{protocolVersion:1,requestKey:'ship-pp-001',sourceId:ack.sourceId,expectedHead:{eventId:ack.eventId,sequence:1},eventType:'shipped',occurredAt:'2026-10-04',payload:{sentDate:'2026-10-04',courier:'DHL',trackingNumber:'t'}})).rejects.toThrow();expect(m.rows.events).toHaveLength(1);});
 it('changed actual audit receipt refuses replay',async()=>{const m=memory();await m.service.register(actor,input());m.rows.audits[1].detail.commandReceipt.acknowledgement.originalEvent.payload.quantity='99';await expect(m.service.register(actor,input())).rejects.toThrow();expect(m.rows.events).toHaveLength(1);});
 it('invalidated source is terminal',async()=>{const m=memory(),a=await m.service.register(actor,input());const b=await m.service.append(actor,{protocolVersion:1,requestKey:'invalidate-001',sourceId:a.sourceId,expectedHead:{eventId:a.eventId,sequence:1},eventType:'invalidated',occurredAt:'2026-10-04',payload:{reason:'wrong cut'}});await expect(m.service.append(actor,{protocolVersion:1,requestKey:'invalidate-002',sourceId:a.sourceId,expectedHead:{eventId:b.eventId,sequence:2},eventType:'invalidated',occurredAt:'2026-10-04',payload:{reason:'again'}})).rejects.toThrow();expect(m.rows.events).toHaveLength(2);});
 it('stale parent can be invalidated without pretending it is current',async()=>{const m=memory(),a=await m.service.register(actor,input());state.parentMissing=true;const b=await m.service.append(actor,{protocolVersion:1,requestKey:'invalid-stale-001',sourceId:a.sourceId,expectedHead:{eventId:a.eventId,sequence:1},eventType:'invalidated',occurredAt:'2026-10-04',payload:{reason:'parent retired'}});expect(b.eventSequence).toBe(2);});
 it('deleted parent prevents shipment even while stored history remains valid',async()=>{const m=memory(),a=await m.service.register(actor,input());state.parentMissing=true;await expect(m.service.append(actor,{protocolVersion:1,requestKey:'ship-stale-001',sourceId:a.sourceId,expectedHead:{eventId:a.eventId,sequence:1},eventType:'shipped',occurredAt:'2026-10-04',payload:{sentDate:'2026-10-04',courier:'DHL',trackingNumber:'t'}})).rejects.toThrow();expect(m.rows.events).toHaveLength(1);});

 it('pioneer registration connects exact QC, shipment, customer revision and next round without losing facts',async()=>{
   const m=memory(),registrationDetails={verification:'颜色与手感',physicalSample:'第一缸实样',differences:'色相偏冷',attachments:[{name:'对照照片',reference:'archive:photo-001'}]};
   const a=await m.service.register(actor,{...input('fabric_eps'),registrationDetails});
   const append=(key:string,head:any,eventType:string,payload:any)=>m.service.append(actor,{protocolVersion:1,requestKey:key,sourceId:a.sourceId,expectedHead:{eventId:head.eventId,sequence:head.eventSequence},eventType,occurredAt:'2026-10-04',payload});
   const requested=await append('pioneer-qc-request',a,'qc_requested',{reason:'对照封样评审'});state.caps.push('qc:write');
   const reviewed=await append('pioneer-qc-review',requested,'qc_reviewed',{requestedEventId:requested.eventId,result:'pass',opinion:'可以寄客确认',inspectionDate:'2026-10-04',inspectorOrg:'内部QC',totalUnits:1,passedUnits:1,sampleSize:1,criticalDefects:0,majorDefects:0,minorDefects:0,defectSummary:'',reportFile:'archive:qc-001'});
   const shipped=await append('pioneer-shipment',reviewed,'shipped',{sentDate:'2026-10-04',courier:'DHL',trackingNumber:'TRACK-001',directShipment:true});
   await append('pioneer-feedback',shipped,'customer_feedback',{shippedEventId:shipped.eventId,result:'adjust_and_resend',channel:'email',confirmationDate:'2026-10-04',evidenceRefs:['archive:customer-001']});
   const next=await m.service.register(actor,{...input('fabric_eps','pioneer-round-002'),previousSourceId:a.sourceId,registrationDetails:{...registrationDetails,differences:'工厂已调整色相'}});
   const old=await loadOrderSampleRecord(m.tx,a.sourceId),current=await loadOrderSampleRecord(m.tx,next.sourceId);
   expect(old.events).toHaveLength(5);expect(old.events[0].payload).toMatchObject({registrationDetails});expect(old.view.latestFeedback?.shippedEventId).toBe(shipped.eventId);expect(current.source.round).toBe(2);expect(current.source.previousSourceId).toBe(a.sourceId);expect(current.events[0].payload).toMatchObject({registrationDetails:{differences:'工厂已调整色相'}});expect(current.view.qc).toBeNull();
   m.rows.events[0].payload.registrationDetails.differences='伪造结果';await expect(loadOrderSampleRecord(m.tx,a.sourceId)).rejects.toThrow();
 });
 it('QC request is persisted as its own audited event',async()=>{const m=memory(),a=await m.service.register(actor,input('garment_pp'));const requested=await m.service.append(actor,{protocolVersion:1,requestKey:'qc-request-001',sourceId:a.sourceId,expectedHead:{eventId:a.eventId,sequence:1},eventType:'qc_requested',occurredAt:'2026-10-04',payload:{reason:'产前检验'}});expect(requested.eventSequence).toBe(2);expect(m.rows.events[1].qcReportId).toBeNull();});

 it.each(['pass','conditional','fail','direct_reject'])('actual QC %s persists complete report/audit and gate',async result=>{
   const m=memory(),a=await m.service.register(actor,input('garment_pp'));
   const req=await m.service.append(actor,{protocolVersion:1,requestKey:'qc-request-001',sourceId:a.sourceId,expectedHead:{eventId:a.eventId,sequence:1},eventType:'qc_requested',occurredAt:'2026-10-04',payload:{reason:'检验'}});
   state.access='team-read';state.caps=['products:read','orders:read','qc:write'];const qcActor={...actor,userId:'qc',permissionCeiling:state.caps};
   const reviewInput={protocolVersion:1,requestKey:'qc-review-001',sourceId:a.sourceId,expectedHead:{eventId:req.eventId,sequence:2},eventType:'qc_reviewed',occurredAt:'2026-10-04',payload:{requestedEventId:req.eventId,result,opinion:'实际检查完成',inspectionDate:'2026-10-04',inspectorOrg:'内部QC',totalUnits:2,passedUnits:result==='pass'?2:1,sampleSize:2,criticalDefects:0,majorDefects:0,minorDefects:0,defectSummary:'',reportFile:null}};
   const reviewed=await m.service.append(qcActor,reviewInput);
   expect(reviewed.eventSequence).toBe(3);expect(m.rows.reports).toHaveLength(1);expect(m.rows.events[2].qcReportId).toBe(m.rows.reports[0].id);
   expect(m.rows.reports[0].result).toBe(result==='direct_reject'?'fail':result);
   expect(await m.service.append(qcActor,reviewInput)).toEqual(reviewed);
   state.caps=['products:read','orders:read','products:write'];state.access='owner';
   const ship={protocolVersion:1,requestKey:'qc-ship-001',sourceId:a.sourceId,expectedHead:{eventId:reviewed.eventId,sequence:3},eventType:'shipped',occurredAt:'2026-10-04',payload:{sentDate:'2026-10-04',courier:'DHL',trackingNumber:'tracking',directShipment:true}};
   if(result==='pass')expect((await m.service.append(actor,ship)).eventSequence).toBe(4);
   else await expect(m.service.append(actor,ship)).rejects.toThrow();
 });
 it('QC reviewer cannot borrow business writer permission',async()=>{
   const m=memory(),a=await m.service.register(actor,input('garment_pp'));const req=await m.service.append(actor,{protocolVersion:1,requestKey:'qc-request-001',sourceId:a.sourceId,expectedHead:{eventId:a.eventId,sequence:1},eventType:'qc_requested',occurredAt:'2026-10-04',payload:{reason:'检验'}});
   await expect(m.service.append(actor,{protocolVersion:1,requestKey:'qc-review-001',sourceId:a.sourceId,expectedHead:{eventId:req.eventId,sequence:2},eventType:'qc_reviewed',occurredAt:'2026-10-04',payload:{requestedEventId:req.eventId,result:'pass',opinion:'检查完成',inspectionDate:'2026-10-04',inspectorOrg:'QC',totalUnits:1,passedUnits:1,sampleSize:1,criticalDefects:0,majorDefects:0,minorDefects:0,defectSummary:'',reportFile:null}})).rejects.toThrow();expect(m.rows.reports).toHaveLength(0);
 });

 it('QC audit storage failure leaves no report or advanced head',async()=>{
   const m=memory(),a=await m.service.register(actor,input('garment_pp'));const req=await m.service.append(actor,{protocolVersion:1,requestKey:'qc-request-001',sourceId:a.sourceId,expectedHead:{eventId:a.eventId,sequence:1},eventType:'qc_requested',occurredAt:'2026-10-04',payload:{reason:'检验'}});
   state.caps=['products:read','orders:read','qc:write'];state.qcAuditFails=true;
   await expect(m.service.append(actor,{protocolVersion:1,requestKey:'qc-review-001',sourceId:a.sourceId,expectedHead:{eventId:req.eventId,sequence:2},eventType:'qc_reviewed',occurredAt:'2026-10-04',payload:{requestedEventId:req.eventId,result:'pass',opinion:'检查完成',inspectionDate:'2026-10-04',inspectorOrg:'QC',totalUnits:1,passedUnits:1,sampleSize:1,criticalDefects:0,majorDefects:0,minorDefects:0,defectSummary:'',reportFile:null}})).rejects.toThrow('QC_AUDIT_UNAVAILABLE');expect(m.rows.reports).toHaveLength(0);expect(m.rows.events).toHaveLength(2);expect(m.rows.sources[0].headEventId).toBe(req.eventId);
 });

});
