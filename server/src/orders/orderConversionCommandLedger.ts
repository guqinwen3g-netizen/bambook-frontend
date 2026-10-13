import type { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import {
  ORDER_CONVERSION_PROTOCOL, assertConversionAck, assertConversionRecovery,
  conversionCanonical, conversionCommandHash, conversionContextAuditId, conversionReceiptAuditId,
  conversionReceiptFingerprint, parseConversionInput,
  type ConversionAck, type ConversionInput, type ConversionOriginal,
  type ConversionOutcome, type ConversionRecovery, type ConversionRowSnapshot, type ConversionSourceAnchors, type ConversionOrderSnapshot, type ConversionLineSnapshot,
} from './orderConversionCommandContract';

/** A caller-owned interactive transaction. No operation starts another one. */
export type ConversionLedgerTx = Pick<Prisma.TransactionClient,
  '$queryRawUnsafe'|'auditLog'|'order'|'orderLine'|'productionStage'|'developmentCase'|'quotation'|'productAsset'|'fabricProfile'|'garmentProfile'|'relation'|'moqThresholdConfig'>;
export type ConversionVerifiedExecutionContext = {preparationAuditId:string;sourceBefore:ConversionRowSnapshot;sourceAnchors:ConversionSourceAnchors;orderBefore:ConversionOrderSnapshot|null;targetBefore:{lines:ConversionLineSnapshot[];productionStages:ConversionRowSnapshot[]}|null};
export type ConversionLedgerPolicy = {
  /** Must refresh current account/grants and intersect the original signed cap.
   * Source and actual target read policies apply even to an existing receipt. */
  authorizeRead(tx: ConversionLedgerTx, actor: TokenPayload, input: ConversionInput, targetOrderId: string|null): Promise<void>;
  /** Only a genuinely new execution requires current write/business authority. */
  authorizeExecute(tx: ConversionLedgerTx, actor: TokenPayload, input: ConversionInput): Promise<void>;
  /** Production loader reads locked actual origin/evidence and stored preparation; never accepts request-body snapshots. */
  loadExecutionContextInTx(tx:ConversionLedgerTx,actor:TokenPayload,input:ConversionInput):Promise<ConversionVerifiedExecutionContext>;
};
export type ConversionLedgerExecutor = (tx: ConversionLedgerTx, actor: TokenPayload, input: ConversionInput, context:ConversionVerifiedExecutionContext) => Promise<ConversionOriginal>;
const conflict = (): never => {throw businessError('CONFLICT','原转单请求或持久回执无法核实，请保留原请求核查。');};
function plain(value:any):any {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && typeof value.toFixed === 'function' && typeof value.toString === 'function') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,plain(item)]));
  return value;
}
function assertActual(snapshot:ConversionRowSnapshot, actual:any) {
  if (!actual || snapshot.id !== actual.id) conflict();
  for (const [field,expected] of Object.entries(snapshot.record)) {
    let observed = plain(actual[field]);
    if (['quantity','quoteAmount','unitPrice','netValue'].includes(field) && typeof expected === 'string' && typeof observed === 'number') observed = String(observed);
    if(observed===undefined)conflict();
    if (conversionCanonical(observed) !== conversionCanonical(expected)) conflict();
  }
}
async function assertBusinessAudits(tx:ConversionLedgerTx, ack:ConversionAck) {
  for (const audit of ack.original.businessAudits) assertActual(audit,await tx.auditLog.findUnique({where:{id:audit.id}}));
}
async function assertExecutionFacts(tx:ConversionLedgerTx, ack:ConversionAck) {
  assertActual(ack.original.orderAfter,await tx.order.findUnique({where:{id:ack.orderId}}));
  const lines = await tx.orderLine.findMany({where:{orderId:ack.orderId}});
  const stages = await tx.productionStage.findMany({where:{orderId:ack.orderId}});
  if(lines.length!==ack.original.lines.length || stages.length!==ack.original.productionStages.length) conflict();
  for(const line of ack.original.lines) assertActual(line,lines.find(row=>row.id===line.id));
  for(const stage of ack.original.productionStages) assertActual(stage,stages.find(row=>row.id===stage.id));
  const source = ack.sourceType==='development'
    ? await tx.developmentCase.findUnique({where:{id:ack.sourceId}})
    : await tx.quotation.findUnique({where:{id:ack.sourceId}});
  assertActual(ack.original.sourceAfter,source);
  await assertBusinessAudits(tx,ack);
}
export function createOrderConversionCommandLedger(policy:ConversionLedgerPolicy) {
  async function lock(tx:ConversionLedgerTx,actor:TokenPayload,raw:ConversionInput) {
    const input=parseConversionInput(raw),id=conversionReceiptAuditId(actor.userId,input.requestKey);
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text',id);
    return {input,id,hash:conversionCommandHash(actor.userId,input),row:await tx.auditLog.findUnique({where:{id}})};
  }
  async function stored(tx:ConversionLedgerTx,actor:TokenPayload,input:ConversionInput,id:string,hash:string,row:any):Promise<ConversionOutcome> {
    const detail=row.detail as any;
    if(row.actorId!==actor.userId || row.action!=='order_conversion_command' || row.targetType!==input.source.type || row.targetId!==input.source.id || !detail || detail.protocol!==ORDER_CONVERSION_PROTOCOL || detail.commandHash!==hash || conversionCanonical(detail.input)!==conversionCanonical(input)) conflict();
    if(row.operationType!=='create'||!detail.result||typeof detail.result!=='object')conflict();
    const result=detail.result as ConversionOutcome;
    await policy.authorizeRead(tx,actor,input,'orderId' in result?result.orderId:null);
    if('original' in result) {
      try{assertConversionAck(result,actor.userId,input);}catch{conflict();}
      if(result.receiptAuditId!==id || result.original.completedAt!==row.createdAt.toISOString()) conflict();
      await assertBusinessAudits(tx,result);
    } else {
      assertConversionRecovery(result,actor.userId,input);
      if(result.outcome!=='cancelled' || result.receiptAuditId!==id || result.cancellationProof?.cancelledAt!==row.createdAt.toISOString()) conflict();
    }
    return JSON.parse(conversionCanonical(result));
  }
  async function absent(tx:ConversionLedgerTx,actor:TokenPayload,input:ConversionInput):Promise<ConversionRecovery> {
    await policy.authorizeRead(tx,actor,input,null);
    const source=input.source.type==='development'
      ? await tx.developmentCase.findUnique({where:{id:input.source.id}})
      : await tx.quotation.findUnique({where:{id:input.source.id}});
    if(!source) conflict();
    const legacyOrder=input.source.type==='development'?await tx.order.findFirst({where:{sourceCaseId:input.source.id,clientRequestId:input.requestKey}}):null;
    const orderId=input.source.type==='development'?legacyOrder?.id:(source as any).convertedOrderId;
    let legacyProof:null|{source:ConversionRowSnapshot;order:ConversionRowSnapshot;businessAudit?:ConversionRowSnapshot|null}=null;
    if(orderId){
      await policy.authorizeRead(tx,actor,input,orderId);
      const order=await tx.order.findUnique({where:{id:orderId}});if(!order)conflict();
      let businessAudit:ConversionRowSnapshot|null=null;
      if(input.source.type==='development'){
        const audits=await tx.auditLog.findMany({where:{action:'convert_dev_case',targetType:'DevelopmentCase',targetId:input.source.id}});
        const actual=audits.find(a=>a.actorId===actor.userId&&(a.detail as any)?.after?.orderId===orderId);
        if(!actual)conflict();businessAudit={id:actual!.id,record:plain(actual)};
      }
      legacyProof={source:{id:source!.id,record:plain(source)},order:{id:order!.id,record:plain(order)},businessAudit};
    }
    const result:ConversionOutcome={conversionVersion:1,outcome:orderId?'legacy_unverified':'not_confirmed',actorId:actor.userId,requestKey:input.requestKey,operation:input.operation,sourceType:input.source.type,sourceId:input.source.id,commandHash:conversionCommandHash(actor.userId,input),receiptAuditId:null,requestInput:input,legacyOrderId:orderId??null,cancellationProof:null,legacyProof};
    assertConversionRecovery(result,actor.userId,input);return result;
  }
  async function persist(tx:ConversionLedgerTx,actor:TokenPayload,input:ConversionInput,id:string,hash:string,result:ConversionOutcome,createdAt:Date) {
    const row=await tx.auditLog.create({data:{id,actorId:actor.userId,action:'order_conversion_command',targetType:input.source.type,targetId:input.source.id,operationType:'create',createdAt,detail:JSON.parse(conversionCanonical({protocol:ORDER_CONVERSION_PROTOCOL,commandHash:hash,input,result}))}});
    return stored(tx,actor,input,id,hash,row);
  }
  return {
    async executeInTx(tx:ConversionLedgerTx,actor:TokenPayload,raw:ConversionInput,executor:ConversionLedgerExecutor):Promise<ConversionOutcome> {
      const {input,id,hash,row}=await lock(tx,actor,raw);
      if(row)return stored(tx,actor,input,id,hash,row);
      const prior=await absent(tx,actor,input);if(prior.outcome==='legacy_unverified')return prior;
      await policy.authorizeExecute(tx,actor,input);
      const context=await policy.loadExecutionContextInTx(tx,actor,input);
      const preparation=await tx.auditLog.findUnique({where:{id:context.preparationAuditId}});
      if(!preparation || preparation.id!==conversionContextAuditId(actor.userId,input.source,input.operation==='development_link'?{orderId:input.parameters.orderId,contentFingerprint:input.parameters.expectedTarget.contentFingerprint}:undefined) || preparation.actorId!==actor.userId || preparation.action!=='prepare_order_conversion_command' || preparation.operationType!=='create' || preparation.targetType!==input.source.type || preparation.targetId!==input.source.id || conversionCanonical((preparation.detail as any)?.context)!==conversionCanonical(context))conflict();
      const sourceTable=input.source.type==='development'?'DevelopmentCase':'Quotation';
      await tx.$queryRawUnsafe('SELECT "id" FROM "'+sourceTable+'" WHERE "id"=$1 FOR UPDATE',input.source.id);
      const source=input.source.type==='development'?await tx.developmentCase.findUnique({where:{id:input.source.id}}):await tx.quotation.findUnique({where:{id:input.source.id}});
      assertActual(context.sourceBefore,source);
      const anchors=context.sourceAnchors;
      if(conversionCanonical(anchors.source)!==conversionCanonical(context.sourceBefore))conflict();
      const anchorRows = [[anchors.asset,tx.productAsset,'ProductAsset'],[anchors.profile,anchors.profile?.family==='fabric'?tx.fabricProfile:tx.garmentProfile,anchors.profile?.family==='fabric'?'FabricProfile':'GarmentProfile'],[anchors.factory,tx.relation,'Relation'],[anchors.customer,tx.relation,'Relation'],[anchors.moq.config,tx.moqThresholdConfig,'MoqThresholdConfig']] as const;
      for(const [snapshot,delegate,table] of [...anchorRows].sort((a,b)=>(a[2]+(a[0]?.id??'')).localeCompare(b[2]+(b[0]?.id??'')))){
        if(snapshot){
          await tx.$queryRawUnsafe('SELECT "id" FROM "'+table+'" WHERE "id"=$1 FOR UPDATE',snapshot.id);
          assertActual(snapshot,await (delegate as any).findUnique({where:{id:snapshot.id}}));
        }
      }
      if(input.operation==='development_link'){
        await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE',input.parameters.orderId);
        if(!context.orderBefore||!context.targetBefore)conflict();
        assertActual(context.orderBefore!,await tx.order.findUnique({where:{id:input.parameters.orderId}}));
        const targetLines=await tx.orderLine.findMany({where:{orderId:input.parameters.orderId}}),targetStages=await tx.productionStage.findMany({where:{orderId:input.parameters.orderId}});
        if(targetLines.length!==context.targetBefore!.lines.length||targetStages.length!==context.targetBefore!.productionStages.length)conflict();
        for(const row of context.targetBefore!.lines)assertActual(row,targetLines.find(r=>r.id===row.id));
        for(const row of context.targetBefore!.productionStages)assertActual(row,targetStages.find(r=>r.id===row.id));
      }else if(context.orderBefore!==null||context.targetBefore!==null)conflict();
      const original=await executor(tx,actor,input,context);
      for(const field of ['sourceBefore','sourceAnchors','orderBefore','targetBefore'] as const)if(conversionCanonical(original[field])!==conversionCanonical(context[field]))conflict();
      const body:Omit<ConversionAck,'receiptFingerprint'>={conversionVersion:1,outcome:input.operation==='development_link'?'linked':'converted',actorId:actor.userId,requestKey:input.requestKey,operation:input.operation,sourceType:input.source.type,sourceId:input.source.id,orderId:original.orderAfter.id,commandHash:hash,receiptAuditId:id,original};
      const result:ConversionAck={...body,receiptFingerprint:conversionReceiptFingerprint(body)};
      try{assertConversionAck(result,actor.userId,input);}catch{conflict();}await assertExecutionFacts(tx,result);
      return persist(tx,actor,input,id,hash,result,new Date(original.completedAt));
    },
    async recoverInTx(tx:ConversionLedgerTx,actor:TokenPayload,raw:ConversionInput):Promise<ConversionOutcome> {
      const {input,id,hash,row}=await lock(tx,actor,raw);return row?stored(tx,actor,input,id,hash,row):absent(tx,actor,input);
    },
    async cancelInTx(tx:ConversionLedgerTx,actor:TokenPayload,raw:ConversionInput):Promise<ConversionOutcome> {
      const {input,id,hash,row}=await lock(tx,actor,raw);if(row)return stored(tx,actor,input,id,hash,row);
      const prior=await absent(tx,actor,input);if(prior.outcome==='legacy_unverified')return prior;
      const createdAt=new Date();
      const result:ConversionRecovery={...prior,outcome:'cancelled',receiptAuditId:id,cancellationProof:{auditId:id,actorId:actor.userId,commandHash:hash,requestInput:input,cancelledAt:createdAt.toISOString()}};
      assertConversionRecovery(result,actor.userId,input);return persist(tx,actor,input,id,hash,result,createdAt);
    },
  };
}
