import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { isValidLocalDateKey } from '../shared/localDate';
import { todayLocalKey } from '../shared/localDate';
import { SAMPLE_SOURCES } from '../shared/sampleLibraryMetadata';
import { createSampleRoomService } from '../samples/sampleRoomService';
import { shipPhysicalSampleInTransaction, PhysicalShipmentError } from '../samples/samplePhysicalShipment';
import { authorizeSampleCustody, lockSampleCustodyGraph, assertSampleCustodyGuardStable } from '../samples/sampleCustodyAuthorization';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from './developmentOperationalGuard';
import { createDevelopmentFactoryShipmentCost, bindDevelopmentFactoryShipmentCost, verifyDevelopmentFactoryShipmentCost } from './developmentFactoryShipmentCost';

export type DevelopmentPhysicalContext = { prisma: any; actorId: string; trustedActor: TokenPayload; ip?: string | null };
export type IncomingDevelopmentSampleInput = {
  requestKey: string; name: string; cardType: string; quantity: number; unit: string; physicalLengthQty?: string;
  receivedDate: string; form: string; sourceType: string; sourceName: string;
  warehouseId?: string; location?: string; notes?: string;
};
export type DevelopmentFactoryShipmentInput = {
  requestKey: string; sampleVersionId: string; expectedVersionUpdatedAt: string;
  itemId: string; quantity: string; unit: string; sentDate: string;
  recipientName: string; recipientAddress: string; recipientContact?: string;
  courier: string; trackingNumber: string; shippingFee: string; shippingCurrency: string; notes?: string;
};
const SOURCE = 'development:physical-sample';
const actions = { incoming: 'development_incoming_sample_register', factory: 'development_reference_sample_ship' } as const;
type Kind = keyof typeof actions;
const reject = (code: string, message: string): never => { throw new DevelopmentDomainError(code, message); };
const safe = (v: unknown): any => JSON.parse(JSON.stringify(v, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().filter(key => v[key] !== undefined).map(key => [key, canonical(v[key])])) : v;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(safe(v)))).digest('hex');
function text(value: unknown, label: string, max = 200, optional = false): string | undefined {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return reject('INVALID_INPUT', `请明确填写${label}`);
  return value.trim();
}
function body(input: any, fields: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) reject('INVALID_INPUT', '实物命令字段无效');
}
function date(value: unknown, label: string) {
  const v = text(value, label, 10)!;
  if (!isValidLocalDateKey(v) || v > todayLocalKey()) reject('INVALID_INPUT', `${label}须为实际日期，不能填写未来日期`);
  return v;
}
async function authority(tx: any, ctx: DevelopmentPhysicalContext, caseId: string, write = true) {
  if (!ctx.trustedActor?.userId || ctx.trustedActor.userId !== ctx.actorId) reject('UNAUTHORIZED', '请使用当前登录账号办理开发实物');
  return authorizeDevelopmentSource(tx, ctx.actorId, ctx.trustedActor, caseId, { write });
}
async function receipt(tx: any, ctx: DevelopmentPhysicalContext, caseId: string, kind: Kind, requestKey: string, fingerprint?: string, write = true) {
  const logs = await tx.auditLog.findMany({ where: { targetType: 'DevelopmentCase', targetId: caseId, actorId: ctx.actorId, action: actions[kind] }, orderBy: { id: 'asc' } });
  for(const row of logs){const fact=row.detail?.after;if(row.detail?.source!==SOURCE||!fact||fact.caseId!==caseId||fact.actorId!==ctx.actorId||fact.kind!==kind||typeof fact.requestKey!=='string'||!fact.requestKey.trim()||fact.requestKey.length>128||fact.result?.command?.requestKey!==fact.requestKey||fact.result?.command?.kind!==fact.kind||fact.result?.command?.actorId!==fact.actorId||fact.resultHash!==hash(fact.result))reject('DEVELOPMENT_SOURCE_CHANGED','原实物回执身份不完整，不能推断不存在');}
  const matches = logs.filter((row: any) => row.detail?.source === SOURCE && row.detail?.after?.requestKey === requestKey);
  if (!matches.length) return null;
  if (matches.length !== 1) reject('DEVELOPMENT_SOURCE_CHANGED', '原实物命令存在多份回执，请核对原记录');
  const row = matches[0], fact = row.detail.after;
  if (fingerprint && fact.fingerprint !== fingerprint) reject('REQUEST_CONFLICT', '原请求已有不同实物内容，请读取原回执');
  if (fact.caseId !== caseId || fact.kind !== kind || fact.actorId !== ctx.actorId || !fact.result?.itemId
    || fact.resultHash !== hash(fact.result)||fact.result.command?.requestKey!==requestKey||fact.result.command?.actorId!==ctx.actorId||fact.result.command?.kind!==kind||fact.result.command?.fingerprint!==fact.fingerprint) reject('DEVELOPMENT_SOURCE_CHANGED', '原实物回执不完整，不能推断成功');
  const custody = await authorizeSampleCustody({ db: tx, actor: ctx.trustedActor, subject: { kind: 'card', id: fact.result.itemId }, mode: write ? 'write' : 'read' });
  const card = await tx.sampleCardItem.findFirst({where:{id:fact.result.itemId,deletedAt:null}});
  if (card?.devCaseId !== caseId) reject('DEVELOPMENT_SOURCE_CHANGED', '原实物已不属于当前开发案');
  if (kind === 'factory') await verifyDevelopmentFactoryShipmentCost(tx, caseId, fact.result, row.id);
  return { ...fact.result, auditId: row.id, replayed: true };
}
const CANCEL_ACTION='development_physical_command_cancel';
export type PhysicalCancelledReceipt={status:'cancelled';caseId:string;kind:Kind;actorId:string;requestKey:string;inputFingerprint:string;auditId:string;replayed:boolean};
async function cancelled(tx:any,ctx:DevelopmentPhysicalContext,caseId:string,kind:Kind,requestKey:string,inputFingerprint?:string):Promise<PhysicalCancelledReceipt|null>{
  const rows=await tx.auditLog.findMany({where:{targetType:'DevelopmentCase',targetId:caseId,actorId:ctx.actorId,action:CANCEL_ACTION},orderBy:{id:'asc'}});
  for(const row of rows){const fact=row.detail?.after,result=fact?.result;if(row.detail?.source!==SOURCE||!fact||fact.caseId!==caseId||fact.actorId!==ctx.actorId||!Object.prototype.hasOwnProperty.call(actions,fact.kind)||typeof fact.requestKey!=='string'||!fact.requestKey.trim()||fact.requestKey.length>128||result?.status!=='cancelled'||result.requestKey!==fact.requestKey||result.kind!==fact.kind||result.actorId!==fact.actorId||result.caseId!==fact.caseId||fact.resultHash!==hash(result))reject('DEVELOPMENT_SOURCE_CHANGED','原取消回执身份不完整，不能推断不存在');}
  const matches=rows.filter((row:any)=>row.detail?.source===SOURCE&&row.detail.after?.kind===kind&&row.detail.after?.requestKey===requestKey);
  if(!matches.length)return null;if(matches.length!==1)reject('DEVELOPMENT_SOURCE_CHANGED','原请求有多个取消事实，不能推断终态');
  const row=matches[0],fact=row.detail.after,result=fact.result;
  if(fact.caseId!==caseId||fact.actorId!==ctx.actorId||!result||result.status!=='cancelled'||result.caseId!==caseId||result.kind!==kind||result.actorId!==ctx.actorId||result.requestKey!==requestKey||result.inputFingerprint!==fact.inputFingerprint||!/^[a-f0-9]{64}$/.test(fact.inputFingerprint)||fact.resultHash!==hash(result))reject('DEVELOPMENT_SOURCE_CHANGED','原取消事实不完整');
  if(inputFingerprint&&fact.inputFingerprint!==inputFingerprint)reject('REQUEST_CONFLICT','取消依据与原冻结命令不一致');
  return {...result,auditId:row.id,replayed:true};
}
async function assertNotCancelled(tx:any,ctx:DevelopmentPhysicalContext,caseId:string,kind:Kind,requestKey:string){
  if(await cancelled(tx,ctx,caseId,kind,requestKey))reject('REQUEST_CONFLICT','原实物请求已取消，不能再次登记或扣库');
}
/** Terminal resolution serializes with the original command. A 404 or business rejection is never cancellation evidence. */
export async function resolveDevelopmentPhysicalCommand(ctx:DevelopmentPhysicalContext,caseId:string,kind:Kind,requestKey:string,input:unknown){
  if(!Object.prototype.hasOwnProperty.call(actions,kind))reject('INVALID_INPUT','实物命令类型无效');
  const key=text(requestKey,'原请求编号',128)!;
  if(!input||typeof input!=='object'||Array.isArray(input)||(input as any).requestKey!==key)reject('INVALID_INPUT','请提供同编号原冻结命令');
  const inputFingerprint=hash(input);
  return ctx.prisma.$transaction(async(tx:any)=>{
    await authority(tx,ctx,caseId);await commandLock(tx,ctx,caseId,kind,key);
    const success=await receipt(tx,ctx,caseId,kind,key,undefined,false);
    if(success){if(await cancelled(tx,ctx,caseId,kind,key))reject('DEVELOPMENT_SOURCE_CHANGED','原命令成功与取消事实冲突');return {status:'succeeded',receipt:success};}
    const prior=await cancelled(tx,ctx,caseId,kind,key,inputFingerprint);if(prior)return prior;
    await authority(tx,ctx,caseId);
    const result={status:'cancelled',caseId,kind,actorId:ctx.actorId,requestKey:key,inputFingerprint};
    const auditId=await writeRouteAuditLog({prisma:tx,actorId:ctx.actorId,source:SOURCE,operation:CANCEL_ACTION,targetType:'DevelopmentCase',targetId:caseId,operationType:'link',ip:ctx.ip,after:{caseId,kind,actorId:ctx.actorId,requestKey:key,inputFingerprint,result,resultHash:hash(result)}});
    return {...result,auditId,replayed:false};
  },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}
async function saveReceipt(tx: any, ctx: DevelopmentPhysicalContext, caseId: string, kind: Kind, requestKey: string, fingerprint: string, result: any) {
  const actual = safe({...result,command:{kind,actorId:ctx.actorId,requestKey,fingerprint}});
  const auditId = await writeRouteAuditLog({ prisma: tx, actorId: ctx.actorId, source: SOURCE, operation: actions[kind],
    targetType: 'DevelopmentCase', targetId: caseId, operationType: kind === 'incoming' ? 'create' : 'link', ip: ctx.ip,
    after: { kind, caseId, actorId: ctx.actorId, requestKey, fingerprint, result: actual, resultHash: hash(actual) } });
  return { ...actual, auditId, replayed: false };
}
async function commandLock(tx: any, ctx: DevelopmentPhysicalContext, caseId: string, kind: Kind, requestKey: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`development-physical:${ctx.actorId}:${caseId}:${kind}:${requestKey}`}))::text`);
}
/** Join the caller's real transaction without opening a second independent commit. */
function roomInTransaction(tx: any) {
  const adapter = new Proxy(Object.create(null), { get(_target, key) {
    if (key === '$transaction') return (run: (db: any) => Promise<unknown>) => run(tx);
    const value = Reflect.get(tx, key, tx); return typeof value === 'function' ? value.bind(tx) : value;
  } });
  return createSampleRoomService(adapter);
}
export async function registerDevelopmentIncomingSample(ctx: DevelopmentPhysicalContext, caseId: string, input: IncomingDevelopmentSampleInput) {
  body(input, ['requestKey','name','cardType','quantity','unit','physicalLengthQty','receivedDate','form','sourceType','sourceName','warehouseId','location','notes']);
  const normalized = { requestKey: text(input.requestKey,'原请求编号',128)!, name: text(input.name,'实物名称')!, cardType: text(input.cardType,'实物分类',80)!,
    quantity: input.quantity, unit: text(input.unit,'数量单位',30)!, physicalLengthQty: text(input.physicalLengthQty,'实际长度',100,true),
    receivedDate: date(input.receivedDate,'实际来样日期'), form: text(input.form,'实物形态',120)!, sourceType: text(input.sourceType,'真实来源类型',80)!,
    sourceName: text(input.sourceName,'真实来样方')!, warehouseId: text(input.warehouseId,'仓库',200,true), location: text(input.location,'存放位置',200,true), notes: text(input.notes,'说明',500,true) };
  if (!SAMPLE_SOURCES.some(source => source.value === normalized.sourceType)) reject('INVALID_INPUT','请选择现有来样来源类型');
  if (!Number.isSafeInteger(normalized.quantity) || normalized.quantity < 1) reject('INVALID_INPUT','请填写正整数实物件数；米样另记实际长度');
  const fingerprint = hash({caseId,actorId:ctx.actorId,input:normalized});
  return ctx.prisma.$transaction(async (tx: any) => {
    await authority(tx,ctx,caseId); await commandLock(tx,ctx,caseId,'incoming',normalized.requestKey);
    await assertNotCancelled(tx,ctx,caseId,'incoming',normalized.requestKey);
    const prior = await receipt(tx,ctx,caseId,'incoming',normalized.requestKey,fingerprint); if (prior) return prior;
    const room = roomInTransaction(tx);
    const created = await room.createItem({ name:normalized.name,cardType:normalized.cardType,quantity:normalized.quantity,unit:normalized.unit,
      physicalLengthQty:normalized.physicalLengthQty,devCaseId:caseId,warehouseId:normalized.warehouseId,location:normalized.location,notes:normalized.notes,
      clientRequestId:`development-incoming:${hash({actorId:ctx.actorId,caseId,requestKey:normalized.requestKey})}`, libraryMetadata:{version:1,purpose:'reference',sampleKind:'reference',sourceType:normalized.sourceType,sourceName:normalized.sourceName} },ctx.trustedActor);
    if (!created.ok) throw new DevelopmentDomainError(created.error.code,created.error.message);
    await authority(tx,ctx,caseId);
    const item = created.data.item;
    return saveReceipt(tx,ctx,caseId,'incoming',normalized.requestKey,fingerprint,{inputSnapshot:normalized, itemId:item.id, itemCode:item.code, caseId,
      incoming:{receivedDate:normalized.receivedDate,form:normalized.form,sourceType:normalized.sourceType,sourceName:normalized.sourceName},
      physical:{name:item.name,cardType:item.cardType,quantity:item.quantity,unit:item.unit,physicalLengthQty:item.physicalLengthQty??null},
      // Photos use the existing signed private-photo upload endpoint for this exact card.
      photoUploadItemId:item.id });
  },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}
export async function shipDevelopmentSampleToFactory(ctx: DevelopmentPhysicalContext, caseId: string, input: DevelopmentFactoryShipmentInput) {
  body(input,['requestKey','sampleVersionId','expectedVersionUpdatedAt','itemId','quantity','unit','sentDate','recipientName','recipientAddress','recipientContact','courier','trackingNumber','shippingFee','shippingCurrency','notes']);
  const normalized = {requestKey:text(input.requestKey,'原请求编号',128)!,sampleVersionId:text(input.sampleVersionId,'准确工厂任务版本')!,expectedVersionUpdatedAt:text(input.expectedVersionUpdatedAt,'任务版本戳',30)!,
    itemId:text(input.itemId,'实际寄出实物')!,quantity:text(input.quantity,'寄出数量',100)!,unit:text(input.unit,'实际数量单位',30)!,sentDate:date(input.sentDate,'实际寄出日期'),
    recipientName:text(input.recipientName,'收件人')!,recipientAddress:text(input.recipientAddress,'收件地址',2000)!,recipientContact:text(input.recipientContact,'收件联系方式',200,true),
    courier:text(input.courier,'快递商')!,trackingNumber:text(input.trackingNumber,'快递单号')!,shippingFee:text(input.shippingFee,'我方邮寄费',100)!,shippingCurrency:text(input.shippingCurrency,'费用币种',3)!,notes:text(input.notes,'寄样说明',2000,true)};
  if (!/^\d+$/.test(normalized.expectedVersionUpdatedAt) || !/^[A-Z]{3}$/.test(normalized.shippingCurrency)
    || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(normalized.shippingFee)) reject('INVALID_INPUT','任务版本戳、明确费用币种或邮寄金额无效');
  const fingerprint=hash({caseId,actorId:ctx.actorId,input:normalized});
  return ctx.prisma.$transaction(async(tx:any)=>{
    await authority(tx,ctx,caseId);await commandLock(tx,ctx,caseId,'factory',normalized.requestKey);
    await assertNotCancelled(tx,ctx,caseId,'factory',normalized.requestKey);
    const prior=await receipt(tx,ctx,caseId,'factory',normalized.requestKey,fingerprint);if(prior)return prior;
    const custody=await authorizeSampleCustody({db:tx,actor:ctx.trustedActor,subject:{kind:'card',id:normalized.itemId},mode:'write'});
    await lockSampleCustodyGraph(tx,custody);
    assertSampleCustodyGuardStable(custody.guard,(await authorizeSampleCustody({db:tx,actor:ctx.trustedActor,subject:{kind:'card',id:normalized.itemId},mode:'write'})).guard);
    await assertDevelopmentOperationalWrite(tx,caseId,'sample');
    const {development}=await authority(tx,ctx,caseId);
    // Current writers also hold the case lock. Lock the exact task explicitly,
    // then re-read its CAS so a version updated while waiting cannot ship.
    const versionRows=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleVersion" WHERE "id"=${normalized.sampleVersionId} AND "developmentCaseId"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    if(!versionRows.some((row:any)=>row.id===normalized.sampleVersionId))reject('NOT_FOUND','准确工厂任务版本不存在');
    const version=await tx.developmentSampleVersion.findFirst({where:{id:normalized.sampleVersionId,developmentCaseId:caseId,deletedAt:null}});
    if(!version||version.id!==normalized.sampleVersionId||version.developmentCaseId!==caseId)reject('NOT_FOUND','准确工厂任务版本不存在');
    if(String(version.updatedAt)!==normalized.expectedVersionUpdatedAt)reject('DEVELOPMENT_SOURCE_CHANGED','工厂任务已变化，请核对后重试');
    const factory=await tx.relation.findFirst({where:{id:version.supplierRelationId,deletedAt:null},select:{id:true,name:true}});
    if(!factory||factory.id!==version.supplierRelationId)reject('DEVELOPMENT_SOURCE_CHANGED','原任务工厂已不存在');
    const card=await tx.sampleCardItem.findFirst({where:{id:normalized.itemId,devCaseId:caseId,deletedAt:null}});
    if(!card||card.unit!==normalized.unit)reject('PHYSICAL_SOURCE_MISMATCH','所选实物不属于当前开发案或数量单位不一致');
    const stock=await shipPhysicalSampleInTransaction(tx,ctx.trustedActor,{itemId:card.id,quantity:normalized.quantity,recipientName:normalized.recipientName},
      {source:{devCaseId:caseId},eventId:`development-factory:${caseId}:${ctx.actorId}:${normalized.requestKey}`,expectedGuard:custody.guard}).catch((error:unknown)=>{if(error instanceof PhysicalShipmentError&&error.status>=400&&error.status<500)throw new DevelopmentDomainError(error.status===400?'INVALID_INPUT':error.status===403?'FORBIDDEN':error.status===404?'NOT_FOUND':'REQUEST_CONFLICT',error.message);throw error;});
    const result={inputSnapshot:normalized,itemId:card.id,itemCode:card.code,caseId,stock,stockBefore:{quantity:card.physicalLengthQty??card.quantity,available:card.physicalLengthQty!=null?card.availableLengthQty:card.availableQty},physical:{name:card.name,cardType:card.cardType,quantity:card.quantity,unit:card.unit,physicalLengthQty:card.physicalLengthQty??null},
      task:{sampleVersionId:version.id,versionLabel:version.versionLabel,factoryId:factory.id,factoryName:factory.name,roundId:version.roundId,
        factoryRequirements:version.factoryRequirements??null,referenceAttachments:version.referenceAttachments??[],updatedAt:String(version.updatedAt)},
      shipping:{...normalized,requestKey:undefined,expectedVersionUpdatedAt:undefined,sampleVersionId:undefined,itemId:undefined},customerRelationId:development.customerRelationId??null};
    const shippingCost=await createDevelopmentFactoryShipmentCost(tx,ctx,caseId,normalized.requestKey,fingerprint,result);
    const saved=await saveReceipt(tx,ctx,caseId,'factory',normalized.requestKey,fingerprint,{...result,shippingCost});
    await bindDevelopmentFactoryShipmentCost(tx,ctx,caseId,saved);
    return saved;
  },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}
export async function readDevelopmentPhysicalCommand(ctx: DevelopmentPhysicalContext,caseId:string,kind:Kind,requestKey:string){
  if(!Object.prototype.hasOwnProperty.call(actions,kind))reject('INVALID_INPUT','实物命令类型无效');
  return ctx.prisma.$transaction(async(tx:any)=>{await authority(tx,ctx,caseId,false);const result=await receipt(tx,ctx,caseId,kind,text(requestKey,'原请求编号',128)!,undefined,false);if(!result)reject('NOT_FOUND','原实物命令尚无成功回执');return result;});
}

/** Read existing success/cancellation without creating a terminal fact; current read scope is still required. */
export async function readDevelopmentPhysicalResolution(ctx:DevelopmentPhysicalContext,caseId:string,kind:Kind,requestKey:string){
  if(!Object.prototype.hasOwnProperty.call(actions,kind))reject('INVALID_INPUT','实物命令类型无效');const key=text(requestKey,'原请求编号',128)!;
  return ctx.prisma.$transaction(async(tx:any)=>{await authority(tx,ctx,caseId,false);await commandLock(tx,ctx,caseId,kind,key);const success=await receipt(tx,ctx,caseId,kind,key,undefined,false),cancel=await cancelled(tx,ctx,caseId,kind,key);if(success&&cancel)reject('DEVELOPMENT_SOURCE_CHANGED','成功与取消事实冲突');if(success)return {status:'succeeded',receipt:success};if(cancel)return cancel;reject('NOT_FOUND','原实物请求终态尚未记录');},{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}

/** Case history is read from the same immutable command receipts, not current stock totals. */
export async function listDevelopmentPhysicalCommands(ctx:DevelopmentPhysicalContext,caseId:string,input:{kind?:Kind;limit?:number;offset?:number}={}){
  if(input.kind!==undefined&&!Object.prototype.hasOwnProperty.call(actions,input.kind))reject('INVALID_INPUT','实物命令类型无效');
  const limit=input.limit??30,offset=input.offset??0;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)reject('INVALID_INPUT','实物历史分页无效');
  return ctx.prisma.$transaction(async(tx:any)=>{
    await authority(tx,ctx,caseId,false);
    const where={targetType:'DevelopmentCase',targetId:caseId,action:input.kind?actions[input.kind]:{in:Object.values(actions)},detail:{path:['source'],equals:SOURCE}};
    const total=await tx.auditLog.count({where});
    const logs=await tx.auditLog.findMany({where,orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit,skip:offset});
    const items=[];
    for(const row of logs){
      const fact=row.detail?.after;
      if(row.detail?.source!==SOURCE||!fact||fact.caseId!==caseId||fact.actorId!==row.actorId||!Object.values(actions).includes(row.action)
        ||actions[fact.kind as Kind]!==row.action||!fact.result?.itemId||fact.resultHash!==hash(fact.result)||fact.result.command?.requestKey!==fact.requestKey||fact.result.command?.actorId!==row.actorId||fact.result.command?.kind!==fact.kind||fact.result.command?.fingerprint!==fact.fingerprint)reject('DEVELOPMENT_SOURCE_CHANGED','实物历史回执不完整，请核对原记录');
      await authorizeSampleCustody({db:tx,actor:ctx.trustedActor,subject:{kind:'card',id:fact.result.itemId},mode:'read'});
      const card=await tx.sampleCardItem.findFirst({where:{id:fact.result.itemId,devCaseId:caseId,deletedAt:null}});
      if(!card)reject('DEVELOPMENT_SOURCE_CHANGED','历史实物已不属于当前开发案');
      if(fact.kind==='factory')await verifyDevelopmentFactoryShipmentCost(tx,caseId,fact.result,row.id);
      items.push({...fact.result,auditId:row.id,replayed:true});
    }
    return {items,total,limit,offset};
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
}
