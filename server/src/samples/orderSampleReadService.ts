import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { currentRegistrationActor } from './sampleRegistrationContextService';
import { orderSampleCommandId } from './orderSampleCommandContract';
import { loadOrderSampleRecord, OrderSampleRecordError } from './orderSampleRecordReader';

/** Internal records carry no authorization. Resolve the actual order before
 * loading its audit/receipt graph, and refresh authorization outside RR. */
export function createOrderSampleReadService({prisma}:{prisma:any}) {
  const denied=()=>{throw new DevelopmentDomainError('NOT_FOUND','样品来源不存在或不可见。');};
  async function authorize(db:any, prior:TokenPayload|null|undefined, orderId:string) {
    if(!prior?.userId)throw new DevelopmentDomainError('UNAUTHORIZED','请使用当前登录账号查看订单样品。');
    const actor=await currentRegistrationActor(db,prior,'read');
    if(!hasScope({...actor,roles:[]},'orders:read'))throw new DevelopmentDomainError('FORBIDDEN','当前账号没有订单读取权限。');
    const scope=await freshOrderLineScope(db,actor);
    if(!await db.order.findFirst({where:{id:orderId,deletedAt:null,AND:[scope]},select:{id:true}}))denied();
  }
  async function read(prior:TokenPayload|null|undefined,kind:'source'|'sample',rawId:unknown) {
    const id=orderSampleCommandId(rawId);
    // Reject absent session before any guessed source lookup.
    if(!prior?.userId)throw new DevelopmentDomainError('UNAUTHORIZED','请使用当前登录账号查看订单样品。');
    const result=await prisma.$transaction(async(tx:any)=>{
      const actor=await currentRegistrationActor(tx,prior,'read');
      if(!hasScope({...actor,roles:[]},'orders:read'))throw new DevelopmentDomainError('FORBIDDEN','当前账号没有订单读取权限。');
      const row=await tx.orderSampleSource.findUnique({where:kind==='source'?{id}:{sampleId:id},select:{id:true,orderId:true}});
      if(!row)denied();
      await authorize(tx,prior,row.orderId);
      const record=await loadOrderSampleRecord(tx,row.id);
      // The reader has verified the exact real report and audit first. Read
      // only the employee-facing fields within the same RR snapshot.
      let qcReportSummary:any=null;
      if(record.view.qc){
        qcReportSummary=await tx.inspectionReport.findUnique({where:{id:record.view.qc.id},select:{id:true,revision:true,result:true,inspectionDate:true,inspectorOrg:true,totalUnits:true,passedUnits:true,sampleSize:true,criticalDefects:true,majorDefects:true,minorDefects:true,defectSummary:true,reportFile:true,notes:true}});
        if(!qcReportSummary)throw new OrderSampleRecordError('Verified QC report is missing.');
      }
      return {orderId:row.orderId,record:{...record,qcReportSummary}};
    },{isolationLevel:'RepeatableRead',timeout:30000});
    await authorize(prisma,prior,result.orderId);
    return result.record;
  }
  async function guarded(prior:TokenPayload|null|undefined,kind:'source'|'sample',id:unknown) {
    try{return await read(prior,kind,id);}catch(error){
      if(error instanceof OrderSampleRecordError)throw new DevelopmentDomainError('CONFLICT','样品来源记录未能完整核对，请联系管理员。');
      throw error;
    }
  }
  async function protocol(prior:TokenPayload|null|undefined) {
    if(!prior?.userId)throw new DevelopmentDomainError('UNAUTHORIZED','请使用当前登录账号查看样品协议。');
    async function capabilityAuthority(){
      const actor=await currentRegistrationActor(prisma,prior!,'read');
      if(!hasScope({...actor,roles:[]},'orders:read'))throw new DevelopmentDomainError('FORBIDDEN','当前账号没有订单读取权限。');
    }
    await capabilityAuthority();
    // Exercise all installed native delegates/tables without exposing business
    // records. A new UI against an old schema cannot advertise registration.
    const probeId='__order_sample_protocol_capability_probe__';
    await Promise.all([prisma.orderSampleSource.findMany({where:{id:probeId},select:{id:true},take:1}),
      prisma.orderSampleCoverage.findMany({where:{id:probeId},select:{id:true},take:1}),
      prisma.orderSampleEvent.findMany({where:{id:probeId},select:{id:true},take:1}),prisma.orderSampleCommandCancellation.findMany({where:{id:probeId},select:{id:true},take:1})]);
    await capabilityAuthority();
    return {protocolVersion:1,registration:true,qc:true,cancellation:true,physicalReceipt:true};
  }
  return {protocol,bySource:(actor:TokenPayload|null|undefined,id:unknown)=>guarded(actor,'source',id),bySample:(actor:TokenPayload|null|undefined,id:unknown)=>guarded(actor,'sample',id)};
}
