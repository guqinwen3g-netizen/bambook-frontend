import { Prisma } from '@prisma/client';
import { loadOrderSamplePhysicalReceipt } from './orderSamplePhysicalReceiptService';
import { shipPhysicalSampleInTransaction,PhysicalShipmentError } from './samplePhysicalShipment';
import { buildOrderSampleQcReport,orderSampleQcStoredReport,loadOrderSampleQcEvidence,type OrderSampleQcInput } from './orderSampleQcEvidence';
import { nextBusinessNumber } from '../shared/businessNumberService';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { createTeamShareService } from '../teams/teamShareService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { currentRegistrationActor } from './sampleRegistrationContextService';
import { SampleCustodyAuthorizationError,authorizeSampleCustody,assertSampleCustodyGuardStable,type SampleCustodyAuthorization } from './sampleCustodyAuthorization';
import { assertOrderSampleCommandNotCancelled } from './orderSampleCancellationService';
import { buildOrderSampleSource, orderSampleDigest, OrderSampleContractError, type OrderSampleSource } from './orderSampleSourceContract';
import { resolveOrderSampleParents, OrderSampleParentError, type OrderSampleParentLockRefs } from './orderSampleParentResolver';
import { loadOrderSampleRecord, orderSampleCoverageKey, OrderSampleRecordError } from './orderSampleRecordReader';
import { reduceOrderSampleEvents, type OrderSampleEvent, type OrderSampleEventFact } from './orderSampleEventReducer';
import { orderSampleCommandFailure as fail, orderSampleCommandIdentity, parseOrderSampleRegister, parseOrderSampleAppend } from './orderSampleCommandContract';

/** Trusted server callers supply an authenticated user-session actor. This
 * service has no anonymous/API-key/body-actor path; HTTP callers must establish
 * JWT provenance before invoking it. A stock shipment and its business event commit together. */
export function createOrderSampleCommandService({ prisma, clock = Date.now }: {prisma:any;clock?:()=>number}) {
  const sourceMarker = 'route:samples:order-source:event';
  async function authorize(tx:any, prior:TokenPayload, orderId:string, family:string, write:boolean, qcReview=false) {
    const actor = await currentRegistrationActor(tx,prior,'read');
    const caps = {...actor,roles:[]};
    if (!hasScope(caps,'orders:read')) fail('FORBIDDEN','当前账号没有订单读取权限。');
    const scope = await freshOrderLineScope(tx,actor);
    const order = await tx.order.findFirst({where:{id:orderId,deletedAt:null,AND:[scope]}});
    if (!order) fail('NOT_FOUND','订单不存在或不在当前可见范围。');
    if(qcReview && !hasScope(caps,'qc:write')) fail('FORBIDDEN','当前账号没有样品检验登记权限。');
    if (write && !qcReview) {
      const cap:any = family === 'fabric_eps' ? 'sample:early_production:write' : family.startsWith('fabric_') ? 'sample:shipment:write' : 'products:write';
      if (!hasScope(caps,cap)) fail('FORBIDDEN','当前账号没有该样品业务操作权限。');
      const resolver = await createPermissionService({prisma:tx}).getDataScopeResolver(actor,'orders');
      let allowed = resolveWriteKind(resolver.rule) === 'all';
      if (!allowed && order.customerRelationId) allowed = ['owner','team-followup'].includes(await createTeamShareService(tx).resolveRelationAccess(actor,order.customerRelationId,{fresh:true}));
      if (!allowed && !order.customerRelationId) allowed = order.ownerId === actor.userId;
      if (!allowed) fail('NOT_FOUND','订单不存在或不在当前可操作范围。');
    }
    return {actor,order};
  }
  async function requestLock(tx:any,actor:TokenPayload,key:string) {
    if (!actor?.userId) fail('UNAUTHORIZED','请使用当前登录账号操作。');
    // Bounded, transaction-scoped lock coordinates a single actor/key even when
    // racing commands target different orders. Hash collisions serialize only.
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`order-sample-v1:${actor.userId}:${key}`},0))::text`);
  }
  async function lockParents(tx:any, refs:OrderSampleParentLockRefs, custody?:SampleCustodyAuthorization) {
    const groups:[string,string[]][] = [['DevelopmentCase',refs.developmentCaseIds],['Relation',refs.relationIds],['SealSample',refs.sealSampleIds],['SealSampleBatch',refs.sealSampleBatchIds],['SampleBatch',refs.sampleBatchIds],
      ['ProductAsset',refs.productAssetIds],['FabricProfile',refs.fabricProfileIds],['GarmentProfile',refs.garmentProfileIds],['Sample',refs.sampleIds],['SampleSource',refs.sampleSourceIds],['Order',refs.orderIds],['OrderLine',refs.orderLineIds],['ProductionBatch',refs.productionBatchIds],['AuditLog',refs.auditLogIds]];
    if (custody) {
      const tables:Record<string,string>={case:'DevelopmentCase',relation:'Relation',batch:'SampleBatch',order:'Order',asset:'ProductAsset',warehouse:'Warehouse',sample:'Sample',card:'SampleCardItem'};
      for (const ref of custody.lockRefs) {const table=tables[ref.kind],group=groups.find(g=>g[0]===table);if(group)group[1]=[...group[1],ref.id];else groups.push([table,[ref.id]]);}
      const order=['DevelopmentCase','Relation','SealSample','SealSampleBatch','SampleBatch','Order','ProductAsset','FabricProfile','GarmentProfile','Warehouse','Sample','SampleSource','OrderLine','ProductionBatch','AuditLog','SampleCardItem'];
      groups.sort((a,b)=>order.indexOf(a[0])-order.indexOf(b[0]));
    }
    for (const [table,ids] of groups) for (const id of [...new Set(ids)].sort()) {
      const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id"=${id} FOR UPDATE`);
      if (!rows.length) fail('CONFLICT','真实父记录已变化，请重新打开样品来源。');
    }
  }
  async function replay(tx:any,prior:TokenPayload,key:string,input:any,operation:string) {
    const events = await tx.orderSampleEvent.findMany({where:{protocolVersion:1,actorId:prior.userId,requestKey:key},take:2});
    if (!events.length) return null;
    if (events.length !== 1) fail('CONFLICT','原成功事件身份重复。');
    const event = events[0];
    const record = await loadOrderSampleRecord(tx,event.sourceId);
    await authorize(tx,prior,record.source.owner.orderId,record.source.family,false);
    const audit = await tx.auditLog.findUnique({where:{id:event.auditId}});
    const normalized = {operation,input};
    if (!audit || audit.detail?.requestHash !== orderSampleDigest(normalized) || orderSampleDigest(audit.detail?.requestInput) !== orderSampleDigest(normalized)) fail('CONFLICT','请求标识已用于不同业务内容，请保留原请求。');
    const ack = record.acknowledgements.find(a=>a.eventId===event.id);
    if (!ack) fail('CONFLICT','原成功回执无法恢复。');
    return ack;
  }
  function eventWithAudit(fact:OrderSampleEventFact,auditId:string):OrderSampleEvent {
    return {...fact,audit:{auditId,protocol:'order_sample_native_v1',source:sourceMarker,operation:`order_sample_${fact.eventType}`,actorId:fact.actorId,targetType:'OrderSampleEvent',targetId:fact.id,after:fact}} as OrderSampleEvent;
  }
  async function persistEvent(tx:any,source:OrderSampleSource,fact:OrderSampleEventFact,key:string,auditId:string,operation:'register'|'append',input:any) {
    const commandSnapshot = {protocolVersion:1,actorId:fact.actorId,requestKey:key,operation,input:operation==='register'?{source,event:fact}:{event:fact}};
    const commandHash = orderSampleDigest(commandSnapshot);
    const acknowledgement = {protocolVersion:1,actorId:fact.actorId,requestKey:key,commandHash,sourceId:source.sourceId,sampleId:source.sampleId,eventId:fact.id,eventSequence:fact.sequence,auditId,originalEvent:fact};
    const receipt = {protocolVersion:1,requestKey:key,commandHash,commandSnapshot,ackHash:orderSampleDigest(acknowledgement),acknowledgement};
    const requestInput = {operation,input};
    await tx.auditLog.create({data:{id:auditId,actorId:fact.actorId,action:`order_sample_${fact.eventType}`,targetType:'OrderSampleEvent',targetId:fact.id,transactionId:fact.id,
      createdAt:new Date(Number(fact.recordedAt)),detail:{protocol:'order_sample_native_v1',source:sourceMarker,after:fact,commandReceipt:receipt,requestInput,requestHash:orderSampleDigest(requestInput)}}});
    const {sampleId,payload,recordedAt,...fields} = fact;
    await tx.orderSampleEvent.create({data:{...fields,payload,recordedAt:BigInt(recordedAt),auditId,...receipt,qcReportId:fact.eventType==='qc_reviewed'?fact.payload.report.id:null,qcReportRevision:fact.eventType==='qc_reviewed'?fact.payload.report.revision:null,qcReportAuditId:fact.eventType==='qc_reviewed'?fact.payload.reportAudit.auditId:null}});
    const changed = await tx.orderSampleSource.updateMany({where:{id:source.sourceId,headSequence:fact.sequence-1,headEventId:fact.previousEventId},data:{headSequence:fact.sequence,headEventId:fact.id}});
    if (changed.count !== 1) fail('CONFLICT','样品事件已由其他操作更新，请刷新后核对。');
    return acknowledgement;
  }
  function time() { const now=clock(); if (!Number.isSafeInteger(now)||now<=0) fail('CONFLICT','服务器事实时间无效。'); return String(now); }
  async function appendInTx(tx:any,prior:TokenPayload,raw:unknown) {
    const input=parseOrderSampleAppend(raw);
    await requestLock(tx,prior,input.requestKey);
    await currentRegistrationActor(tx,prior,'read');
    await assertOrderSampleCommandNotCancelled(tx,prior.userId,input.requestKey);
    const original=await replay(tx,prior,input.requestKey,input,'append'); if(original)return original;
    const before=await loadOrderSampleRecord(tx,input.sourceId);
    await authorize(tx,prior,before.source.owner.orderId,before.source.family,true,input.eventType==='qc_reviewed');
    const parentRequest={family:before.source.family,orderId:before.source.owner.orderId,factoryRelationId:before.source.owner.factoryRelationId,coverage:before.source.coverage.map(c=>({orderLineId:c.orderLineId,expectedLineFingerprint:c.lineFingerprint,productionBatchId:c.productionBatchId,expectedBatchRevision:c.productionBatchRevision,rangeStart:c.rangeStart,quantity:c.quantity,unit:c.unit}))};
    const discovered=input.eventType==='invalidated' ? null : await resolveOrderSampleParents(tx,parentRequest);
    const physicalCustody = input.eventType==='shipped' && input.payload?.physicalShipment ? await authorizeSampleCustody({db:tx,actor:prior,subject:{kind:'card',id:input.payload.physicalShipment.itemId},mode:'write'}) : undefined;
    if (discovered) await lockParents(tx,discovered.lockRefs,physicalCustody);
    else await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${before.source.owner.orderId} FOR UPDATE`);
    if (physicalCustody) {const currentCustody=await authorizeSampleCustody({db:tx,actor:prior,subject:{kind:'card',id:input.payload.physicalShipment.itemId},mode:'write'});assertSampleCustodyGuardStable(physicalCustody.guard,currentCustody.guard);}
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderSampleSource" WHERE "id"=${input.sourceId} FOR UPDATE`);
    const current=await loadOrderSampleRecord(tx,input.sourceId);
    await authorize(tx,prior,current.source.owner.orderId,current.source.family,true,input.eventType==='qc_reviewed');
    const parents=discovered ? await resolveOrderSampleParents(tx,parentRequest) : null;
    if (parents) for (const coverage of current.source.coverage) {
      const line = parents.lines.find(line => line.id === coverage.orderLineId);
      if (orderSampleDigest(coverage.materialProof ?? null) !== orderSampleDigest(line?.materialProof ?? null)) fail('CONFLICT','产前样冻结的材料依据已变化；历史仍保留，请重新登记准确轮次。');
    }
    if(parents && discovered && parents.parentFingerprint!==discovered.parentFingerprint || orderSampleDigest(current.source)!==orderSampleDigest(before.source)
      || current.view.head.eventId!==input.expectedHead.eventId || current.view.head.sequence!==input.expectedHead.sequence) fail('CONFLICT','样品来源或事件版本已变化，请刷新。');
    if(current.source.provenance!=='native_new')fail('CONFLICT','历史观察记录不能追加原生业务事件。');
    const ids=orderSampleCommandIdentity(prior.userId,input.requestKey), now=time();
    let payload=input.payload;
    if(input.eventType==='qc_reviewed') {
      if(!current.view.pendingQcRequest || current.view.pendingQcRequest.eventId!==input.payload.requestedEventId) fail('CONFLICT','报告须引用当前完整检验请求。');
      const reviewCommand={protocolVersion:1,operation:'qc_review',actorId:prior.userId,requestKey:input.requestKey,input};
      const reportId=`OSQC__${orderSampleDigest({actorId:prior.userId,requestKey:input.requestKey})}`;
      const qcAuditId=`OSQCA__${orderSampleDigest({actorId:prior.userId,requestKey:input.requestKey})}`;
      const made=buildOrderSampleQcReport(current.source,input.payload as OrderSampleQcInput,{reportId,eventId:ids.eventId,actorId:prior.userId,requestKey:input.requestKey,commandHash:orderSampleDigest(reviewCommand),sequence:current.view.head.sequence+1,recordedAt:now});
      await tx.inspectionReport.create({data:made.data});
      const originalReport=orderSampleQcStoredReport(made.data);
      await tx.auditLog.create({data:{id:qcAuditId,actorId:prior.userId,action:'order_sample_qc_review',targetType:'InspectionReport',targetId:reportId,transactionId:ids.eventId,createdAt:new Date(Number(now)),detail:{protocol:'order_sample_native_v1',source:'route:qc:order-sample-review',after:made.report,originalReport,originalReportHash:orderSampleDigest(originalReport),reviewCommand}}});
      payload={requestedEventId:input.payload.requestedEventId,report:made.report,reportAudit:{auditId:qcAuditId,protocol:'order_sample_native_v1',source:'route:qc:order-sample-review',operation:'order_sample_qc_review',actorId:prior.userId,targetType:'InspectionReport',targetId:reportId,after:made.report}};
    }
    const fact={id:ids.eventId,sourceId:current.source.sourceId,sampleId:current.source.sampleId,sequence:current.view.head.sequence+1,previousEventId:current.view.head.eventId,actorId:prior.userId,recordedAt:now,occurredAt:input.occurredAt,eventType:input.eventType,
      contentFingerprint:current.source.contentFingerprint,coverageFingerprint:current.source.coverageFingerprint,payload} as OrderSampleEventFact;
    reduceOrderSampleEvents(current.source,[...current.events,eventWithAudit(fact,ids.auditId)],{eventId:fact.id,sequence:fact.sequence});
    if(fact.eventType==='qc_reviewed') await loadOrderSampleQcEvidence(tx,current.source,{...fact,requestKey:input.requestKey,qcReportId:fact.payload.report.id,qcReportRevision:fact.payload.report.revision,qcReportAuditId:fact.payload.reportAudit.auditId});
    if (input.eventType === 'shipped') {
      const cards = await tx.sampleCardItem.findMany({where:{sampleId:current.source.sampleId},select:{id:true},take:257});
      if (cards.length > 256) fail('CONFLICT','本轮实物数量超出核对范围，请先整理实物记录。');
      const physical = input.payload.physicalShipment;
      if (!cards.length && !physical && input.payload.directShipment!==true) fail('INVALID_INPUT','尚无本轮入库实物，请明确确认工厂直接寄送，或先登记收样。');
      if (cards.length && !physical) fail('INVALID_INPUT','本轮已有登记实物，请选择实际寄送的样品及件数，寄样会同步扣减仓库。');
      if (physical) {
        const receipt = await loadOrderSamplePhysicalReceipt(tx,current.source.sourceId);
        if (!receipt || receipt.cardId!==physical.itemId) fail('CONFLICT','请使用本轮准确收样的原实物，不能用历史登记或其他来源替代。');
        if (!cards.some((card:any)=>card.id===physical.itemId)) fail('CONFLICT','寄送实物不属于当前轮次，请重新选择。');
        await shipPhysicalSampleInTransaction(tx,prior,physical,{source:{sampleId:current.source.sampleId},expectedGuard:physicalCustody?.guard,eventId:ids.eventId,occurredAt:Number(now),assertSource:(item:any)=>{
          if (item.sampleId!==current.source.sampleId || item.orderId!==current.source.owner.orderId || item.devCaseId!=null || item.batchId!=null || item.receiptSnapshot?.kind!=='order-native' || item.receiptSnapshot?.source?.sourceId!==current.source.sourceId) fail('CONFLICT','本轮实物与准确收样来源不一致，不能寄出其他轮次。');
        }});
      }
    }
    const ack=await persistEvent(tx,current.source,fact,input.requestKey,ids.auditId,'append',input);
    await loadOrderSampleRecord(tx,input.sourceId);
    return ack;
  }
  const api = {
    async register(prior:TokenPayload,raw:unknown) {
      const input = parseOrderSampleRegister(raw);
      return prisma.$transaction(async(tx:any)=>{
        await requestLock(tx,prior,input.requestKey);
        // Refresh current grants before touching an existing durable receipt.
        await currentRegistrationActor(tx,prior,'read');
        await assertOrderSampleCommandNotCancelled(tx,prior.userId,input.requestKey);
        const original = await replay(tx,prior,input.requestKey,input,'register'); if (original) return original;
        await authorize(tx,prior,input.orderId,input.family,true);
        const parentRequest = {family:input.family,orderId:input.orderId,factoryRelationId:input.factoryRelationId,coverage:input.coverage};
        const discovered = await resolveOrderSampleParents(tx,parentRequest);
        await lockParents(tx,discovered.lockRefs);
        await authorize(tx,prior,input.orderId,input.family,true);
        const current = await resolveOrderSampleParents(tx,parentRequest);
        if (current.parentFingerprint !== discovered.parentFingerprint || current.parentFingerprint !== input.expectedParentFingerprint) fail('CONFLICT','订单样品实际父记录版本已变化。');
        const ids = orderSampleCommandIdentity(prior.userId,input.requestKey);
        let chainId=ids.chainId,round=1;
        if (input.previousSourceId) {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderSampleSource" WHERE "id"=${input.previousSourceId} FOR UPDATE`);
          const previous = await loadOrderSampleRecord(tx,input.previousSourceId);
          if (previous.source.owner.orderId !== current.owner.orderId || previous.source.owner.factoryRelationId !== current.owner.factoryRelationId || previous.source.family !== input.family || previous.source.provenance !== 'native_new') fail('CONFLICT','前轮样品与实际订单、工厂或业务族不一致。');
          chainId=previous.source.chainId; round=previous.source.round+1;
        }
        const source = buildOrderSampleSource({domain:'order',sourceId:ids.sourceId,sampleId:ids.sampleId,family:input.family,owner:current.owner,chainId,round,previousSourceId:input.previousSourceId,provenance:'native_new',specSnapshot:current.specSnapshot,
          sampleFacts:input.sampleFacts,coverage:current.coverage,lines:current.lines,batches:current.batches});
        const now=time();
        const fact = {id:ids.eventId,sourceId:source.sourceId,sampleId:source.sampleId,sequence:1,previousEventId:null,actorId:prior.userId,recordedAt:now,occurredAt:source.sampleFacts.cuttingDate,eventType:'registered',contentFingerprint:source.contentFingerprint,coverageFingerprint:source.coverageFingerprint,payload:{...source.sampleFacts,...(input.registrationDetails ? {registrationDetails:input.registrationDetails} : {})}} as OrderSampleEventFact;
        reduceOrderSampleEvents(source,[eventWithAudit(fact,ids.auditId)],{eventId:fact.id,sequence:1});
        const types:Record<string,string>={fabric_ss:'ship',fabric_rc:'head',fabric_eps:'pioneer',garment_pp:'pp',garment_top:'top',garment_ship:'ship'};
        await tx.sample.create({data:{id:source.sampleId,code:await nextBusinessNumber(tx,'SM',undefined,{occupied:async(code)=>!!await tx.sample.findFirst({where:{code},select:{id:true}})}),type:types[source.family],sourceOrderId:source.owner.orderId,sourceCaseId:null,projectionKey:null,supplierRelationId:source.owner.factoryRelationId,
          status:'draft',round:source.round,attachments:{sampleQuantity:source.sampleFacts.quantity,sampleUnit:source.sampleFacts.unit,cuttingDate:source.sampleFacts.cuttingDate},createdAt:BigInt(now),updatedAt:BigInt(now)}});
        // The actual Sample row is locked before Source birth, matching the SQL
        // mutual-domain guard. Appending events never late-locks Sample.
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id"=${source.sampleId} FOR UPDATE`);
        await tx.auditLog.create({data:{id:ids.creationAuditId,actorId:prior.userId,action:'create_order_sample_source',targetType:'OrderSampleSource',targetId:source.sourceId,transactionId:fact.id,createdAt:new Date(Number(now)),
          detail:{protocol:'order_sample_native_v1',source:'route:samples:order-source:create',after:{source,coverage:source.coverage}}}});
        await tx.orderSampleSource.create({data:{id:source.sourceId,sampleId:source.sampleId,orderId:source.owner.orderId,businessLine:source.owner.businessLine,family:source.family,factoryRelationId:source.owner.factoryRelationId,
          chainId:source.chainId,round:source.round,previousSourceId:source.previousSourceId,provenance:source.provenance,specSnapshot:source.specSnapshot,sampleQuantity:source.sampleFacts.quantity,sampleUnit:source.sampleFacts.unit,cuttingDate:source.sampleFacts.cuttingDate,
          contentFingerprint:source.contentFingerprint,coverageFingerprint:source.coverageFingerprint,creationAuditId:ids.creationAuditId,createdBy:prior.userId,createdAt:BigInt(now),headSequence:0,headEventId:null}});
        for (let i=0;i<source.coverage.length;i++) {
          const {orderId,factoryRelationId,...coverage}=source.coverage[i];
          await tx.orderSampleCoverage.create({data:{...coverage,id:`OSCOV__${orderSampleDigest({sourceId:source.sourceId,index:i})}`,sourceId:source.sourceId,scopeKey:orderSampleCoverageKey(source.coverage[i])}});
        }
        const ack=await persistEvent(tx,source,fact,input.requestKey,ids.auditId,'register',input);
        await loadOrderSampleRecord(tx,source.sourceId);
        return ack;
      },{isolationLevel:'ReadCommitted',timeout:30000});
    },
    async append(prior:TokenPayload,raw:unknown) {
      return prisma.$transaction((tx:any)=>appendInTx(tx,prior,raw),{isolationLevel:'ReadCommitted',timeout:30000});
    },
  };
  async function guarded<T>(work:()=>Promise<T>):Promise<T> {
    try { return await work(); } catch(error) {
      if(error instanceof PhysicalShipmentError || error instanceof SampleCustodyAuthorizationError) fail(error.code,error.message);
      if(error instanceof OrderSampleContractError) fail('INVALID_INPUT',error.message);
      if(error instanceof OrderSampleParentError || error instanceof OrderSampleRecordError) fail('CONFLICT',error.message);
      throw error; // unknown storage errors retain identity for native route handling
    }
  }
  return {register:(actor:TokenPayload,raw:unknown)=>guarded(()=>api.register(actor,raw)),append:(actor:TokenPayload,raw:unknown)=>guarded(()=>api.append(actor,raw)),appendInTransaction:(tx:any,actor:TokenPayload,raw:unknown)=>guarded(()=>appendInTx(tx,actor,raw))};
}
