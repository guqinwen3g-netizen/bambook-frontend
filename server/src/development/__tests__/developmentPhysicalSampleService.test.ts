import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {Prisma} from '@prisma/client';
const m=vi.hoisted(()=>({source:vi.fn(),custody:vi.fn(),guard:vi.fn(),lock:vi.fn(),stable:vi.fn(),room:vi.fn(),ship:vi.fn(),cost:vi.fn()}));
vi.mock('../developmentConversionAuthority',()=>({authorizeDevelopmentSource:m.source}));
vi.mock('../developmentOperationalGuard',async()=>({...await vi.importActual<any>('../developmentOperationalGuard'),assertDevelopmentOperationalWrite:m.guard}));
vi.mock('../../samples/sampleCustodyAuthorization',()=>({authorizeSampleCustody:m.custody,lockSampleCustodyGraph:m.lock,assertSampleCustodyGuardStable:m.stable}));
vi.mock('../../samples/sampleRoomService',()=>({createSampleRoomService:(adapter:any)=>({createItem:(input:any,actor:any)=>adapter.$transaction((tx:any)=>m.room(input,actor,tx))})}));
vi.mock('../../samples/samplePhysicalShipment',async()=>({...await vi.importActual<any>('../../samples/samplePhysicalShipment'),shipPhysicalSampleInTransaction:m.ship}));
vi.mock('../../finance/billingItemService',()=>({createCostRecordInTx:m.cost}));
import {PhysicalShipmentError} from '../../samples/samplePhysicalShipment';
import {registerDevelopmentIncomingSample,shipDevelopmentSampleToFactory,readDevelopmentPhysicalCommand,listDevelopmentPhysicalCommands,resolveDevelopmentPhysicalCommand,readDevelopmentPhysicalResolution} from '../developmentPhysicalSampleService';
import {DevelopmentDomainError} from '../developmentOperationalGuard';
import {readDevelopmentExpenseSnapshot} from '../developmentExpenseSnapshot';
function fixture(){
 const logs:any[]=[],cards:any[]=[],costs:any[]=[],loans:any[]=[];
 const version={id:'v-a',developmentCaseId:'c',supplierRelationId:'factory-a',versionLabel:'R1-A-1',roundId:'r1',updatedAt:10n,factoryRequirements:'织物分析后按目标制样',referenceAttachments:['file:original']};
 const tx:any={$queryRaw:vi.fn(async(query:any)=>[{id:query.sql.includes('FROM "DevelopmentSampleVersion"')?query.values[0]:'c'}]),auditLog:{findMany:vi.fn(async({where}:any)=>logs.filter(row=>Object.entries(where).every(([key,value])=>row[key]===value))),create:vi.fn(async({data}:any)=>{logs.push(data);return data;})},
  costRecord:{findFirst:vi.fn(async({where}:any)=>costs.find(row=>row.id===where.id&&row.deletedAt==null)??null),findMany:vi.fn(async()=>costs),update:vi.fn(async({where,data}:any)=>Object.assign(costs.find(row=>row.id===where.id),data))},
  sampleCardItem:{findFirst:vi.fn(async({where}:any)=>cards.find(card=>card.id===where.id&&(!where.devCaseId||card.devCaseId===where.devCaseId))??null)},
  developmentSampleVersion:{findFirst:vi.fn(async({where}:any)=>where.id===version.id?version:null)},relation:{findFirst:vi.fn(async()=>({id:'factory-a',name:'Actual factory'}))}};
 const prisma={$transaction:vi.fn(async(run:any)=>{const before=structuredClone({logs,cards,costs,loans});try{return await run(tx);}catch(e){logs.splice(0,logs.length,...before.logs);cards.splice(0,cards.length,...before.cards);costs.splice(0,costs.length,...before.costs);loans.splice(0,loans.length,...before.loans);throw e;}})};
 const ctx={prisma,actorId:'sales',trustedActor:{userId:'sales'} as any};
 m.source.mockResolvedValue({development:{id:'c',customerRelationId:'customer'}});m.custody.mockResolvedValue({guard:{version:1},actor:ctx.trustedActor});m.guard.mockResolvedValue(undefined);
 m.room.mockImplementation(async(input:any,_actor:any,actualTx:any)=>{expect(actualTx).toBe(tx);await m.guard(actualTx,input.devCaseId,'sample');const card={id:`card-${cards.length+1}`,code:`SC-${cards.length+1}`,devCaseId:'c',name:input.name,cardType:input.cardType,unit:input.unit,quantity:input.quantity,availableQty:input.quantity,physicalLengthQty:input.physicalLengthQty,availableLengthQty:input.physicalLengthQty};cards.push(card);return {ok:true,data:{item:card}};});
 m.ship.mockImplementation(async(actualTx:any,_actor:any,input:any,options:any)=>{expect(actualTx).toBe(tx);const loan={itemId:input.itemId,loanId:`loan-${loans.length+1}`,quantity:input.quantity,quantityAfter:'0',availableAfter:'0',archived:true,eventId:options.eventId};loans.push(loan);return loan;});
 m.cost.mockImplementation(async(actualTx:any,{input,actorId}:any)=>{expect(actualTx).toBe(tx);const row={id:`cost-${costs.length+1}`,recordNo:`CR-${costs.length+1}`,deletedAt:null,bearerRelationId:null,...input};costs.push(row);await tx.auditLog.create({data:{id:`billing-${row.id}`,actorId,action:'create_cost_record',targetType:'CostRecord',targetId:row.id,detail:{source:'route:billing',after:{recordNo:row.recordNo,sourceType:row.sourceType,sourceId:row.sourceId,costType:row.costType,amount:new Prisma.Decimal(String(row.amount)).toString(),currency:row.currency}}}});return row;});
 const incoming={requestKey:'incoming-original',name:'真实米样',cardType:'fabric',quantity:1,unit:'M',physicalLengthQty:'2.5000',receivedDate:'2026-10-01',form:'一段米样',sourceType:'customer_sample',sourceName:'Customer actual contact'};
 const shipment={requestKey:'ship-original',sampleVersionId:'v-a',expectedVersionUpdatedAt:'10',itemId:'card-1',quantity:'1.2500',unit:'M',sentDate:'2026-10-01',recipientName:'Factory receiver',recipientAddress:'Actual factory address',courier:'Courier',trackingNumber:'TRACK-1',shippingFee:'18.5000',shippingCurrency:'CNY'};
 return {ctx,tx,logs,cards,costs,loans,version,incoming,shipment};
}
beforeEach(()=>{vi.clearAllMocks();for(const mock of Object.values(m))mock.mockReset();});
describe('development physical commands share original sample stock',()=>{
 it('creates one incoming warehouse entity and immutable actual arrival facts, without creating costs',async()=>{const f=fixture();const first=await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);expect(first).toMatchObject({inputSnapshot:f.incoming,itemId:'card-1',incoming:{receivedDate:'2026-10-01',form:'一段米样',sourceName:f.incoming.sourceName},physical:{name:f.incoming.name,cardType:'fabric',quantity:1,unit:'M',physicalLengthQty:'2.5000'},photoUploadItemId:'card-1',replayed:false});const retry=await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);expect(retry).toMatchObject({...first,replayed:true});expect(f.cards).toHaveLength(1);expect(m.room).toHaveBeenCalledTimes(1);expect(f.logs).toHaveLength(1);expect(m.room.mock.calls[0][0]).toMatchObject({devCaseId:'c',physicalLengthQty:'2.5000',libraryMetadata:{sourceType:'customer_sample'}});});
 it.each(['closed','paused'])('reads original incoming/factory receipts after %s and refuses new commands',async state=>{const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);const first=await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment);m.guard.mockRejectedValue(new DevelopmentDomainError(state==='closed'?'DEVELOPMENT_CLOSED':'DEVELOPMENT_PAUSED','blocked'));
 expect(await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming)).toMatchObject({replayed:true});expect(await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment)).toMatchObject({...first,replayed:true});await expect(shipDevelopmentSampleToFactory(f.ctx,'c',{...f.shipment,requestKey:'new'})).rejects.toMatchObject({code:state==='closed'?'DEVELOPMENT_CLOSED':'DEVELOPMENT_PAUSED'});expect(m.ship).toHaveBeenCalledTimes(1);});
 it('ships the same card to the exact factory task, preserving explicit units/address/fee/currency and requirements',async()=>{const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);const r=await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment);expect(r).toMatchObject({inputSnapshot:f.shipment,itemId:'card-1',physical:{name:f.incoming.name,unit:'M'},stockBefore:{quantity:'2.5000',available:'2.5000'},task:{sampleVersionId:'v-a',factoryId:'factory-a',factoryRequirements:f.version.factoryRequirements},shipping:{recipientAddress:f.shipment.recipientAddress,shippingFee:'18.5000',shippingCurrency:'CNY',quantity:'1.2500'}});expect(m.ship).toHaveBeenCalledWith(f.tx,f.ctx.trustedActor,{itemId:'card-1',quantity:'1.2500',recipientName:f.shipment.recipientName},expect.objectContaining({source:{devCaseId:'c'},expectedGuard:{version:1}}));});
 it('rejects changed original content, stale task CAS, different source/unit and missing actual logistics before stock writes',async()=>{const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);await expect(registerDevelopmentIncomingSample(f.ctx,'c',{...f.incoming,form:'changed'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
 for(const patch of [{expectedVersionUpdatedAt:'9'},{unit:'PC'},{sampleVersionId:'other'},{recipientAddress:''},{shippingCurrency:''}])await expect(shipDevelopmentSampleToFactory(f.ctx,'c',{...f.shipment,...patch})).rejects.toBeTruthy();expect(m.ship).not.toHaveBeenCalled();expect(f.logs).toHaveLength(1);});
 it('rechecks current permissions and original physical source even for successful receipts',async()=>{const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);f.cards[0].devCaseId='other';await expect(registerDevelopmentIncomingSample(f.ctx,'c',f.incoming)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});m.source.mockRejectedValue(new DevelopmentDomainError('FORBIDDEN','scope revoked'));await expect(readDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey)).rejects.toMatchObject({code:'FORBIDDEN'});expect(m.room).toHaveBeenCalledTimes(1);});
 it('rolls incoming creation back if its command receipt cannot be audited',async()=>{const f=fixture();f.tx.auditLog.create.mockRejectedValue(Error('audit unavailable'));await expect(registerDevelopmentIncomingSample(f.ctx,'c',f.incoming)).rejects.toThrow('audit unavailable');expect(f.cards).toHaveLength(0);expect(f.logs).toHaveLength(0);});
 it('rejects forged identity and arbitrary inventory/status/photo writes',async()=>{const f=fixture();await expect(registerDevelopmentIncomingSample({...f.ctx,actorId:'forged'},'c',f.incoming)).rejects.toMatchObject({code:'UNAUTHORIZED'});await expect(registerDevelopmentIncomingSample(f.ctx,'c',{...f.incoming,photos:['fake-url']} as any)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(m.room).not.toHaveBeenCalled();});
});

it('case history reads immutable incoming and factory receipts with explicit pagination and current card scope',async()=>{
 const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment);
 f.tx.auditLog.count=vi.fn(async()=>f.logs.filter(row=>row.targetType==='DevelopmentCase').length);
 const native=f.tx.auditLog.findMany.getMockImplementation();
 f.tx.auditLog.findMany.mockImplementation(async(query:any)=>query.where.detail?f.logs.filter(row=>row.targetType==='DevelopmentCase').slice(query.skip,query.skip+query.take):native(query));
 const page=await listDevelopmentPhysicalCommands(f.ctx,'c',{limit:1,offset:1});
 expect(page).toMatchObject({total:2,limit:1,offset:1,items:[{task:{sampleVersionId:'v-a'},shipping:{shippingCurrency:'CNY'}}]});
 expect(m.custody).toHaveBeenLastCalledWith(expect.objectContaining({mode:'read'}));
 await expect(listDevelopmentPhysicalCommands(f.ctx,'c',{limit:101})).rejects.toMatchObject({code:'INVALID_INPUT'});
});

it('two authorized actors with the same nonce create and replay their own incoming physical entity',async()=>{
 const f=fixture();const first=await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);
 const secondActor={...f.ctx,actorId:'another-sales',trustedActor:{userId:'another-sales'} as any};
 const second=await registerDevelopmentIncomingSample(secondActor,'c',f.incoming);
 expect(second.itemId).not.toBe(first.itemId);expect(first.command.actorId).toBe('sales');expect(second.command.actorId).toBe('another-sales');
 expect(m.room.mock.calls[0][0].clientRequestId).not.toBe(m.room.mock.calls[1][0].clientRequestId);
 expect(m.room.mock.calls[0][1].userId).toBe('sales');expect(m.room.mock.calls[1][1].userId).toBe('another-sales');
 expect(await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming)).toMatchObject({itemId:first.itemId,replayed:true});
 expect(await registerDevelopmentIncomingSample(secondActor,'c',f.incoming)).toMatchObject({itemId:second.itemId,replayed:true});
 expect(m.room).toHaveBeenCalledTimes(2);expect(f.cards).toHaveLength(2);
});
it('re-reads task CAS after acquiring its exact row lock and never ships stale content',async()=>{
 const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);
 const native=f.tx.$queryRaw.getMockImplementation();
 f.tx.$queryRaw.mockImplementation(async(query:any)=>{if(query.sql.includes('FROM "DevelopmentSampleVersion"')){expect(query.values).toEqual(['v-a','c']);f.version.updatedAt=11n;}return native(query);});
 await expect(shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
 expect(m.ship).not.toHaveBeenCalled();expect(f.logs).toHaveLength(1);
 const lockIndex=f.tx.$queryRaw.mock.calls.findIndex(([query]:any)=>query.sql.includes('FROM "DevelopmentSampleVersion"'));
 expect(lockIndex).toBeGreaterThanOrEqual(0);
 expect(f.tx.developmentSampleVersion.findFirst.mock.invocationCallOrder.at(-1)).toBeGreaterThan(f.tx.$queryRaw.mock.invocationCallOrder[lockIndex]);
});
it.each(['closed','paused'])('exact GET receipts after %s use current read custody without invoking the operational gate',async state=>{
 const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment);
 m.guard.mockRejectedValue(new DevelopmentDomainError(state==='closed'?'DEVELOPMENT_CLOSED':'DEVELOPMENT_PAUSED','blocked'));
 const gateCalls=m.guard.mock.calls.length;
 expect(await readDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey)).toMatchObject({itemId:'card-1',replayed:true});
 expect(await readDevelopmentPhysicalCommand(f.ctx,'c','factory',f.shipment.requestKey)).toMatchObject({task:{sampleVersionId:'v-a'},replayed:true});
 expect(m.guard).toHaveBeenCalledTimes(gateCalls);expect(m.custody).toHaveBeenLastCalledWith(expect.objectContaining({mode:'read'}));
});

it('resolve commits a cancellation tombstone before any late original write and replays its exact acknowledgement',async()=>{
 const f=fixture();const input={...f.incoming,name:''};const first=await resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',input.requestKey,input);expect(first).toMatchObject({status:'cancelled',actorId:'sales',caseId:'c',kind:'incoming',requestKey:input.requestKey,replayed:false});expect(f.ctx.prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function),{isolationLevel:'ReadCommitted'});expect(f.logs).toHaveLength(1);expect(m.room).not.toHaveBeenCalled();
 expect(await resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',input.requestKey,input)).toMatchObject({...first,replayed:true});await expect(registerDevelopmentIncomingSample(f.ctx,'c',f.incoming)).rejects.toMatchObject({code:'REQUEST_CONFLICT'});expect(m.room).not.toHaveBeenCalled();await expect(resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',input.requestKey,{...input,name:'changed'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
});
it('resolve returns existing accurate success before cancellation even after closed/paused',async()=>{
 const f=fixture();const result=await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);m.guard.mockRejectedValue(new DevelopmentDomainError('DEVELOPMENT_CLOSED','closed'));expect(await resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey,f.incoming)).toMatchObject({status:'succeeded',receipt:{...result,replayed:true}});expect(f.logs).toHaveLength(1);expect(f.logs.some(row=>row.action==='development_physical_command_cancel')).toBe(false);
});
it('factory cancellation blocks every late same-key physical write without custody stock updates',async()=>{
 const f=fixture();await resolveDevelopmentPhysicalCommand(f.ctx,'c','factory',f.shipment.requestKey,f.shipment);await expect(shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment)).rejects.toMatchObject({code:'REQUEST_CONFLICT'});expect(m.ship).not.toHaveBeenCalled();
});
it('corrupt success and revoked current scope cannot be turned into cancellation',async()=>{
 const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);f.logs[0].detail.after.result.physical.name='tampered';await expect(resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey,f.incoming)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});expect(f.logs).toHaveLength(1);m.source.mockRejectedValue(new DevelopmentDomainError('FORBIDDEN','revoked'));await expect(resolveDevelopmentPhysicalCommand(f.ctx,'c','factory',f.shipment.requestKey,f.shipment)).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.logs).toHaveLength(1);
});
it('failed cancellation audit rolls back without publishing terminal proof',async()=>{
 const f=fixture();f.tx.auditLog.create.mockRejectedValue(Error('audit unavailable'));await expect(resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey,f.incoming)).rejects.toThrow('audit unavailable');expect(f.logs).toHaveLength(0);expect(m.room).not.toHaveBeenCalled();
});

it.each(['kind','requestKey'])('damaged cancellation %s cannot be treated as absent by a late POST',async field=>{
 const f=fixture();await resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey,f.incoming);f.logs[0].detail.after[field]='tampered';await expect(registerDevelopmentIncomingSample(f.ctx,'c',f.incoming)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});expect(m.room).not.toHaveBeenCalled();
});
it('damaged success request identity cannot become an apparent empty command that is cancelled',async()=>{
 const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);f.logs[0].detail.after.requestKey='tampered';await expect(resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey,f.incoming)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});expect(f.logs).toHaveLength(1);
});

it('native stock rejection remains a registered 4xx business error and does not imply cancellation',async()=>{
 const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);m.ship.mockRejectedValue(new PhysicalShipmentError('INSUFFICIENT_QTY','Actual stock insufficient'));await expect(shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment)).rejects.toMatchObject({code:'REQUEST_CONFLICT',statusCode:409,message:'Actual stock insufficient'});expect(f.logs).toHaveLength(1);expect(f.logs[0].action).not.toBe('development_physical_command_cancel');
});

it('read-only terminal lookup can acknowledge an existing cancellation without writing any fact, but 404 remains unresolved',async()=>{
 const f=fixture();await expect(readDevelopmentPhysicalResolution(f.ctx,'c','incoming',f.incoming.requestKey)).rejects.toMatchObject({code:'NOT_FOUND'});expect(f.logs).toHaveLength(0);const cancelled=await resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey,f.incoming);m.guard.mockRejectedValue(new DevelopmentDomainError('DEVELOPMENT_CLOSED','closed'));expect(await readDevelopmentPhysicalResolution(f.ctx,'c','incoming',f.incoming.requestKey)).toMatchObject({...cancelled,replayed:true});expect(f.logs).toHaveLength(1);expect(m.room).not.toHaveBeenCalled();expect(m.source).toHaveBeenLastCalledWith(f.tx,'sales',f.ctx.trustedActor,'c',{write:false});
});
it('conflicting valid success and cancellation terminal facts are rejected without writing a third fact',async()=>{
 const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);const separate=fixture();await resolveDevelopmentPhysicalCommand(separate.ctx,'c','incoming',separate.incoming.requestKey,separate.incoming);f.logs.push(separate.logs[0]);await expect(readDevelopmentPhysicalResolution(f.ctx,'c','incoming',f.incoming.requestKey)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});await expect(resolveDevelopmentPhysicalCommand(f.ctx,'c','incoming',f.incoming.requestKey,f.incoming)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});expect(f.logs).toHaveLength(2);
});

describe('factory postage joins the original physical command',()=>{
 it('records one exact internal case expense and native source binding, then replays without a second expense or stock write',async()=>{
  const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);
  const result=await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment);
  expect(result.shippingCost).toEqual({status:'registered',amount:'18.5000',currency:'CNY',incurredAt:'2026-10-01',costRecordId:'cost-1',recordNo:'CR-1',sourceFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(f.costs[0]).toMatchObject({sourceType:'DevelopmentCase',sourceId:'c',costType:'shipping',amount:'18.5000',currency:'CNY',incurredAt:'2026-10-01',bearerType:'internal',bearerRelationId:null,
   developmentShippingSource:{source:{kind:'factory-physical-command',id:result.auditId,nativeAuditId:result.auditId,caseId:'c',fingerprint:result.shippingCost.sourceFingerprint,sourceSnapshot:{task:{sampleVersionId:'v-a',factoryId:'factory-a'},shipping:{trackingNumber:'TRACK-1',shippingFee:'18.5000',shippingCurrency:'CNY'}}},bindingAuditId:expect.any(String)}});
  expect(m.cost).toHaveBeenCalledWith(f.tx,expect.objectContaining({actorId:'sales',trustedActor:f.ctx.trustedActor,input:expect.objectContaining({bearerType:'internal',incurredAt:f.shipment.sentDate})}));
  expect(await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment)).toMatchObject({...result,replayed:true});
  expect(await readDevelopmentPhysicalResolution(f.ctx,'c','factory',f.shipment.requestKey)).toMatchObject({status:'succeeded',receipt:{...result,replayed:true}});
  expect(f.loans).toHaveLength(1);expect(f.costs).toHaveLength(1);expect(m.cost).toHaveBeenCalledTimes(1);expect(m.ship).toHaveBeenCalledTimes(1);
 });
 it.each(['0','0.0000'])('explicit %s retains the free logistics fact and creates no expense',async shippingFee=>{
  const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);const command={...f.shipment,shippingFee};
  const result=await shipDevelopmentSampleToFactory(f.ctx,'c',command);
  expect(result.shippingCost).toEqual({status:'free',amount:shippingFee,currency:'CNY',incurredAt:f.shipment.sentDate,sourceFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(await shipDevelopmentSampleToFactory(f.ctx,'c',command)).toMatchObject({...result,replayed:true});expect(m.cost).not.toHaveBeenCalled();expect(f.costs).toHaveLength(0);expect(f.loans).toHaveLength(1);
 });
 it.each(['cost','billing audit','physical audit','binding audit','cost source update'])('%s failure rolls stock, cost and command proof back together',async phase=>{
  const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);
  if(phase==='cost')m.cost.mockRejectedValueOnce(Error(phase));
  if(phase==='billing audit')m.cost.mockImplementationOnce(async(_tx:any,{input}:any)=>{f.costs.push({id:'failed-cost',...input});throw Error(phase);});
  if(phase==='physical audit'||phase==='binding audit')f.tx.auditLog.create.mockImplementation(async({data}:any)=>{if(data.action===(phase==='physical audit'?'development_reference_sample_ship':'development_factory_shipping_cost_bind'))throw Error(phase);f.logs.push(data);return data;});
  if(phase==='cost source update')f.tx.costRecord.update.mockRejectedValueOnce(Error(phase));
  await expect(shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment)).rejects.toThrow(phase);
  expect(f.costs).toHaveLength(0);expect(f.loans).toHaveLength(0);expect(f.logs).toHaveLength(1);expect(f.cards[0].availableLengthQty).toBe('2.5000');
  await expect(readDevelopmentPhysicalResolution(f.ctx,'c','factory',f.shipment.requestKey)).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it.each(['amount','currency','incurredAt','bearerType','sourceId','deletedAt','source','binding audit','billing audit','duplicate source'])('a damaged successful %s cannot be cancelled or accepted as unknown absence',async field=>{
  const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);const result=await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment);
  if(field==='source')f.costs[0].developmentShippingSource.source.id='other';
  else if(field==='binding audit')f.logs.find(row=>row.action==='development_factory_shipping_cost_bind').detail.after.currency='USD';
  else if(field==='billing audit')f.logs.splice(f.logs.findIndex(row=>row.action==='create_cost_record'),1);
  else if(field==='duplicate source')f.costs.push({...f.costs[0],id:'duplicate'});
  else f.costs[0][field]=field==='deletedAt'?1n:field==='amount'?'19':'changed';
  const auditCount=f.logs.length;
  await expect(readDevelopmentPhysicalCommand(f.ctx,'c','factory',f.shipment.requestKey)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
  await expect(resolveDevelopmentPhysicalCommand(f.ctx,'c','factory',f.shipment.requestKey,f.shipment)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
  expect(f.logs).toHaveLength(auditCount);expect(f.logs.some(row=>row.action==='development_physical_command_cancel')).toBe(false);expect(m.ship).toHaveBeenCalledTimes(1);expect(result.shippingCost.status).toBe('registered');
 });
 it('an older successful shipment without cost linkage stays readable and performs no repair write',async()=>{
  const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment);
  const row=f.logs.find(row=>row.action==='development_reference_sample_ship');delete row.detail.after.result.shippingCost;
  const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(key=>[key,canonical(v[key])])):v;
  row.detail.after.resultHash=createHash('sha256').update(JSON.stringify(canonical(row.detail.after.result))).digest('hex');
  f.costs.splice(0);for(let index=f.logs.length-1;index>=0;index--)if(f.logs[index].targetType==='CostRecord')f.logs.splice(index,1);m.cost.mockClear();
  expect(await shipDevelopmentSampleToFactory(f.ctx,'c',f.shipment)).not.toHaveProperty('shippingCost');expect(m.cost).not.toHaveBeenCalled();expect(f.costs).toHaveLength(0);expect(f.loans).toHaveLength(1);
 });
 it('same tracking text does not merge separate actual commands; snapshots retain exact totals by currency',async()=>{
  const f=fixture();await registerDevelopmentIncomingSample(f.ctx,'c',f.incoming);
  for(const [shippingCurrency,shippingFee]of [['CNY','18.5000'],['USD','0.1234'],['EUR','9.0000']])await shipDevelopmentSampleToFactory(f.ctx,'c',{...f.shipment,requestKey:`actual-${shippingCurrency}`,shippingCurrency,shippingFee});
  f.tx.developmentCase={findFirst:vi.fn(async()=>({id:'c',stage:'closed',updatedAt:10n}))};f.tx.sampleBatch={findMany:vi.fn(async()=>[])};f.tx.sample={findMany:vi.fn(async()=>[])};f.tx.sealSample={findMany:vi.fn(async()=>[])};
  const snapshot=await readDevelopmentExpenseSnapshot(f.tx,'c');
  expect(snapshot.totals).toEqual([{currency:'CNY',amount:'18.5000'},{currency:'EUR',amount:'9.0000'},{currency:'USD',amount:'0.1234'}]);expect(snapshot.unsupportedCurrencies).toEqual(['EUR']);
  expect(snapshot.records).toHaveLength(3);expect(new Set(snapshot.records.map(row=>row.developmentShippingSource.source.nativeAuditId)).size).toBe(3);expect(f.loans).toHaveLength(3);
 });
});
