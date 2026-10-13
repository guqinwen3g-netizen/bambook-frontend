/**
 * sampleRoomService.ts — REQ2-16 样品间管理（DR-057 v2）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品间管理.md
 *
 * DR-057 v2 升级（库存管理联动）：
 *   ① SampleCardItem 增加库存字段（quantity/availableQty/minStock/maxStock/unit）
 *   ② 软关联 warehouseId/devCaseId/orderId（与 DevelopmentCase.linkedOrderId 一致风格）
 *   ③ 借出支持 loanQuantity（一次借多张），availableQty 校验 + 部分借出
 *   ④ 低库存预警 listLowStock
 *   ⑤ 列表 join devCase.code / order.poNumber 摘要（双向联动展示）
 *
 * DR-057 原决策保留：
 *   ① 实体样卡与逻辑色卡分轨（SampleCardItem 实物 ≠ ColorCard 逻辑色；colorCardCode 可选关联）
 *   ② 借出与看样统一 Loan 流水（append-only：归还只补 returnedAt/conditionNote）
 *   ③ 二维码载荷 = 样卡编号（SC-YYYYMMDD-NNN 当日递增；前端 qrcode 打印，扫码按 code 直达）
 *
 * 状态机：in_stock → borrowed（availableQty=0）→ in_stock（归还后 availableQty>0）；retired 终态。
 * 逾期 = dueAt < now 且未归还（列表派生标记，不落状态字段）。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { authorizeSampleCustody, authorizeSampleCustodyBatch, recheckSampleCustodyBatchAuthorization,
  lockSampleCustodyGraph, assertSampleCustodyGuardStable, SampleCustodyAuthorizationError,
  type SampleCustodyAuthorization, type SampleCustodyGuard, type SampleCustodyLockRef } from './sampleCustodyAuthorization';
import { logger } from '../lib/logger';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { parseActualSampleBatchQuantity, sanitizeDefectCauses, serializeBatch, updateSampleBatch } from '../development/fabricDevelopmentService';
import { lockPhysicalSampleSources, PhysicalSampleSourceError } from './samplePhysicalSourceService';
import { resolvePhysicalSampleBusinessContexts } from './samplePhysicalBusinessContext';
import { sampleOriginFingerprint, snapshotSampleOrigin } from './sampleOriginService';
import { readBatchReceiptSnapshot, batchReceiptRecordedAt, normalizeReceiptColorRating, RECEIPT_CARD_TYPES, type BatchCardReceiptSnapshot, type ReceiptCardType } from './sampleBatchReceipt';

import { loadOrderSamplePhysicalReceipt } from './orderSamplePhysicalReceiptService';
import { OrderSampleContractError } from './orderSampleSourceContract';
import { OrderSampleRecordError } from './orderSampleRecordReader';
import { normalizeLibraryMetadata, normalizeLibraryFilters, LIBRARY_FILTER_KEYS, SAMPLE_PURPOSES, SAMPLE_KINDS, SAMPLE_SOURCES, type SampleLibraryMetadata, type LibraryFacets, type LibrarySort } from '../shared/sampleLibraryMetadata';
import { groupFabricArchiveRows } from './sampleFabricArchive';
import { SampleMeterError, isMeterCard, moveMeterStock, returnMeterStock, meterLoanView } from './sampleMeterStock';
import { todayLocalKey } from '../shared/localDate';
import { businessNowMs } from '../shared/businessClock';



export interface BatchCardReceiptInput {
  receiptVersion: 2;
  physicalCardCount: number;
  cardType: ReceiptCardType;
  expectedSourceRound: number;
  expectedCaseId: string;
  expectedFactoryId: string;
  expectedBatchUpdatedAt: string;
  actualQuantity?: string | null;
  actualUnit?: string | null;
  colorRating?: number | null;
  result?: { dyeLotNo?: string; sideDiff?: number | null; endDiff?: number | null; defectCauses?: string[]; notes?: string };
  warehouseId?: string; location?: string; locationDetail?: unknown;
}

// Existing manual-form units plus the schema default and batch-registration
// legacy units. Unknown units are rejected, never truncated into another value.
const CARD_UNITS = ['PC', 'YD', 'M', 'KG', 'SET', 'BOOK', 'ROLL', '张', '米', '份'];
const LOAN_TYPES = ['borrow', 'viewing']; // 寄出必须经 shipItem 扣减实物账，不是借看登记。
const MAX_ITEM_PHOTOS = 8;
function publicPhotoMetadata(itemId: string, value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((photo: any) => photo && typeof photo.id === 'string' && typeof photo.signature === 'string')
    .map((photo: any) => ({ id: photo.id, mimeType: photo.mimeType, size: photo.size,
      uploadedAt: photo.uploadedAt, signature: photo.signature,
      url: `/api/v1/samples/room/items/${encodeURIComponent(itemId)}/photos/${encodeURIComponent(photo.id)}?sig=${encodeURIComponent(photo.signature)}` }));
}
function normalizeLocationDetail(value: unknown): {zone:string|null;shelf:string|null;level:string|null;bin:string|null}|null|undefined {
  if(value===undefined)return undefined;
  if(value===null)return null;
  const fields=['zone','shelf','level','bin'] as const;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key as any)))return undefined;
  const result:any={};
  for(const field of fields){const part=(value as any)[field];if(part!==undefined&&part!==null&&typeof part!=='string')return undefined;
    const text=typeof part==='string'?part.trim():'';if(text.length>80)return undefined;result[field]=text||null;}
  return result;
}
function isLowStock(item: any): boolean {
  if (item.minStock == null) return false;
  if (!Number.isInteger(item.minStock) || !Number.isInteger(item.availableQty)) throw Error('实物库存阈值数据不完整');
  return item.availableQty <= item.minStock;
}


export type SampleRoomResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): SampleRoomResult<never> =>
  ({ ok: false, error: { code, message, status } });

function generateId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function createSampleRoomService(prisma: PrismaClient) {
  const db = prisma as any;

  const actualActor = (actor: TokenPayload | null | undefined): TokenPayload => {
    if (!actor || typeof actor !== 'object' || typeof actor.userId !== 'string' || !actor.userId.trim())
      throw new SampleCustodyAuthorizationError('UNAUTHORIZED',401,'请使用当前登录账号操作实物台账。');
    return actor;
  };
  const authorityFailure = (error: unknown) => error instanceof SampleMeterError ? fail(error.code,error.message,error.status) : error instanceof SampleCustodyAuthorizationError || error instanceof PhysicalSampleSourceError ? fail(error.code,error.message,error.status) : null;
  const normalized = (v:any):any => typeof v==='bigint'?String(v):v instanceof Date?v.toISOString():Array.isArray(v)?v.map(normalized):
    v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalized(v[k])])):v;
  const fingerprint = (v:unknown) => createHash('sha256').update(JSON.stringify(normalized(v))).digest('hex');
  // These actor-scoped receipt columns predate counted stock commands. Reuse
  // the same key space for every loan/ship operation so one original request
  // cannot silently become another operation after a lost response.
  async function countedStockCommand(tx:any, item:any, actorId:string, operation:'borrow'|'viewing'|'ship', input:any, quantity:number) {
    const requestKey=input.requestKey;
    if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.trim()!==requestKey||requestKey.length>200)
      throw new SampleMeterError('VALIDATION_FAILED','实物登记须保留同一次请求编号。');
    const name=String(operation==='ship'?input.recipientName??'':input.borrowerName??'').trim();
    if(!name||name.length>100)throw new SampleMeterError('VALIDATION_FAILED','请填写不超过100字的借用人、看样人或收件人。');
    const dueAt=operation==='viewing'||input.dueAt==null?null:Number(input.dueAt);
    if(dueAt!==null&&!Number.isSafeInteger(dueAt))throw new SampleMeterError('VALIDATION_FAILED','预计归还时间无效。');
    const relationId=operation==='borrow'?null:input.relationId??null;
    const borrowerUserId=operation==='borrow'?input.borrowerUserId??null:null;
    const commandHash=fingerprint({stockVersion:1,operation,itemId:item.id,quantity,unit:item.unit??null,name,dueAt,relationId,borrowerUserId});
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`sample-meter:${actorId}:${requestKey}`}))::text`);
    const [prior]=await tx.sampleCardLoan.findMany({where:{operatorId:actorId,meterRequestKey:requestKey}});
    if(prior&&(prior.meterCommandHash!==commandHash||prior.itemId!==item.id||prior.loanType!==operation))
      throw new SampleMeterError('REQUEST_CONFLICT','同一请求已有不同内容，不能再次登记或扣减。',409);
    return {requestKey,commandHash,name,dueAt,relationId,borrowerUserId,prior,id:'SCLC__'+fingerprint({actorId,requestKey})};
  }
  async function roomWriteAuthority(tx:any, actor:TokenPayload) {
    actualActor(actor);
    const user=await tx.userAccount.findFirst({where:{id:actor.userId,status:'active',deletedAt:null}});
    if(!user)throw new SampleCustodyAuthorizationError('UNAUTHORIZED',401,'当前账号不可用。');
    const service=createPermissionService({prisma:tx}),context=await service.getUserPermissionContext(actor.userId);
    if(!context)throw new SampleCustodyAuthorizationError('AUTHORIZATION_UNAVAILABLE',503,'当前授权未能核对。');
    const fresh:TokenPayload={...actor,roles:context.legacyRoleCodes,roleIds:context.roleIds,permissions:context.scopes,departmentIds:context.departmentIds,authorizationLoaded:true};
    if(actor.permissionCeiling!==undefined&&(!Array.isArray(actor.permissionCeiling)||actor.permissionCeiling.some(s=>typeof s!=='string'||!s.trim()||s.trim()!==s)))
      throw new SampleCustodyAuthorizationError('FORBIDDEN',403,'当前凭据权限上限不可用。');
    if(!hasScope({...fresh,roles:[]},'products:read')||!hasScope({...fresh,roles:[]},'sample:room:write'))
      throw new SampleCustodyAuthorizationError('FORBIDDEN',403,'当前账号无实物操作权限。');
    const scope=await service.getDataScopeResolver(fresh,'relations');
    const sets=(value:any)=>({...value,...Object.fromEntries(Object.entries(value).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,[...v as any[]].sort()]))});
    return {actor:fresh,storedAll:resolveWriteKind(scope.rule)==='all',hash:fingerprint({user:{id:user.id,status:user.status,deletedAt:user.deletedAt??null},context:sets(context),scope:sets(scope),ceiling:actor.permissionCeiling===undefined?null:[...actor.permissionCeiling].sort()})};
  }
  async function incomingRelation(tx:any,id:string|undefined,actor:TokenPayload) {
    if(id===undefined||id==='')return null;
    if(typeof id!=='string'||!id.trim()||id.trim()!==id)throw new SampleCustodyAuthorizationError('INVALID_INPUT',400,'客户编号须明确。');
    const authority=await roomWriteAuthority(tx,actor);
    const relation=await tx.relation.findFirst({where:{id,deletedAt:null},select:{id:true,createdAt:true,deletedAt:true,ownerId:true,salesRepIds:true,departmentId:true}});
    if(!relation){
      if(authority.storedAll)throw new PhysicalSampleSourceError('VALIDATION_FAILED','关联客户不存在或已删除。');
      throw new SampleCustodyAuthorizationError('NOT_FOUND',404,'客户不存在或不可见。');
    }
    const access=await createTeamShareService(tx).resolveRelationAccess(authority.actor,id,{fresh:true});
    if(!['owner','team-followup'].includes(access))throw new SampleCustodyAuthorizationError('NOT_FOUND',404,'客户不存在或不可跟进。');
    return {id,hash:fingerprint({authority:authority.hash,access,relation:{...relation,salesRepIds:Array.isArray(relation.salesRepIds)?[...relation.salesRepIds].sort():relation.salesRepIds??null}})};
  }
  async function lockCustodyUnion(tx:any, authorization:SampleCustodyAuthorization,target:Awaited<ReturnType<typeof incomingRelation>>) {
    if(!target)return lockSampleCustodyGraph(tx,authorization);
    // Only server-authorized current refs. Incoming customer must be locked
    // before Batch/Order/Sample/Card, never chased after the Card row.
    const tables={case:'DevelopmentCase',relation:'Relation',batch:'SampleBatch',order:'Order',asset:'ProductAsset',warehouse:'Warehouse',sample:'Sample',card:'SampleCardItem'};
    const order=Object.keys(tables),refs=new Map<string,SampleCustodyLockRef>();
    for(const ref of [...authorization.lockRefs,{kind:'relation' as const,id:target.id}])refs.set(`${ref.kind}:${ref.id}`,ref);
    for(const ref of [...refs.values()].sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind)||a.id.localeCompare(b.id)))
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${tables[ref.kind]}"`)} WHERE "id" = ${ref.id} FOR UPDATE`);
  }
  async function authorizedCard(tx:any,id:string,actor:TokenPayload,targetId?:string) {
    const before=await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id},mode:'write'});
    const target=await incomingRelation(tx,targetId,actor);await lockCustodyUnion(tx,before,target);
    const after=await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id},mode:'write'});
    assertSampleCustodyGuardStable(before.guard,after.guard);
    const currentTarget=await incomingRelation(tx,targetId,actor);
    if(target?.hash!==currentTarget?.hash)throw new SampleCustodyAuthorizationError('SOURCE_CHANGED',409,'目标客户归属或授权已变化，不会追锁新父。');
    return tx.sampleCardItem.findFirst({where:{id,deletedAt:null}});
  }
  async function creationAuthority(tx:any,input:any,actor:TokenPayload) {
    const authority=await roomWriteAuthority(tx,actor),guards:SampleCustodyGuard[]=[];
    for(const [field,kind] of [['sampleId','sample'],['devCaseId','case'],['orderId','order']] as const) {
      if(input[field]!==undefined&&input[field]!==null&&input[field]!==''){
        try{guards.push((await authorizeSampleCustody({db:tx,actor,subject:{kind,id:input[field]},mode:'write'})).guard);}
        catch(error){if(authority.storedAll&&error instanceof SampleCustodyAuthorizationError&&error.code==='NOT_FOUND')throw new PhysicalSampleSourceError('VALIDATION_FAILED',`关联${{sample:'样品',case:'开发案',order:'订单'}[kind]}不存在或已删除。`);throw error;}
      }
    }
    const customer=await incomingRelation(tx,input.customerRelationId,actor);
    // A genuinely standalone manual card is assigned to this fresh authenticated creator.
    return {hash:authority.hash,guards,customer};
  }
  async function finalRead(actor:TokenPayload,guards:SampleCustodyGuard[]) {
    // Total is based on the same qualified range, not just visible page rows.
    if(!guards.length)await recheckSampleCustodyBatchAuthorization({currentPrisma:prisma,actor,guards:[]});
    for(let i=0;i<guards.length;i+=10000)await recheckSampleCustodyBatchAuthorization({currentPrisma:prisma,actor,guards:guards.slice(i,i+10000)});
  }
  async function scanCustody(tx:any,actor:TokenPayload,where:any,orderBy:any,options:{limit:number;offset:number;scope?:unknown;lane?:unknown;lowStock?:boolean;allowCatalog?:boolean;directorySearch?:string}) {
    await authorizeSampleCustodyBatch({db:tx,actor,subjects:[]});
    const selected:any[]=[],guards:SampleCustodyGuard[]=[];let total=0,cursor:string|undefined;
    while(true) {
      const candidates=await tx.sampleCardItem.findMany({where,orderBy,take:200,...(cursor?{cursor:{id:cursor},skip:1}:{})});
      if(!candidates.length)break;
      const permissions=await authorizeSampleCustodyBatch({db:tx,actor,subjects:candidates.map((row:any)=>({kind:'card',id:row.id})),allowUnownedCatalog:options.allowCatalog===true});
      const authorized=candidates.map((card:any,index:number)=>({card,permission:permissions[index]})).filter((row:any)=>row.permission.ok);
      const contexts=await resolvePhysicalSampleBusinessContexts(tx,authorized.map((row:any)=>row.card));
      for(let index=0;index<authorized.length;index++) {
        const {card,permission}=authorized[index],authorization=permission.authorization;
        const context=authorization.visibility==='catalog'?{status:'unresolved',businessLine:null,reasons:['OWNERSHIP_NOT_RECORDED']}:contexts[index];
        if(authorization.visibility==='catalog'&&options.allowCatalog!==true)continue;
        // Catalog search may use only the same identity fields returned to this actor.
        // Hidden names cannot affect a catalog result or its total.
        if(authorization.visibility==='catalog'&&options.directorySearch&&![card.code,card.location].some(value=>typeof value==='string'&&value.includes(options.directorySearch!)))continue;
        if(options.lowStock&&!isLowStock(card))continue;
        if(options.scope!==undefined&&(options.scope==='review'?context.status==='resolved':context.status!=='resolved'||context.businessLine!==options.scope))continue;
        if(options.lane!==undefined) {
          const lane=options.lane;
          const matchesLane=lane==='review'?context.status!=='resolved'
            :lane==='fabric'?card.cardType==='fabric'||card.cardType==='colorcard'
              :lane==='garment'?card.cardType==='garment':lane==='trim'?card.cardType==='trim':!['fabric','colorcard','garment','trim'].includes(card.cardType);
          if(!matchesLane)continue;
        }
        guards.push(authorization.guard);
        if(total>=options.offset&&selected.length<options.limit)selected.push({card,context,visibility:authorization.visibility});
        total++;
      }
      cursor=candidates[candidates.length-1].id;if(candidates.length<200)break;
    }
    return {selected,total,guards};
  }
  /** Same original-card/create-audit proof as the exact-link producer. Native
   * approvals, current round and mutable loan/stock quantities are not proof. */
  async function directoryReceiptStatuses(tx:any,selected:any[]) {
    const cards=selected.filter(row=>row.visibility==='full').map(row=>row.card);
    const audits=cards.length?await tx.auditLog.findMany({where:{action:'sample_card_create',targetType:'SampleCardItem',targetId:{in:cards.map(card=>card.id)}}}):[];
    const byId=new Map<string,any[]>();for(const audit of audits){const list=byId.get(audit.targetId)??[];list.push(audit);byId.set(audit.targetId,list);}
    const statuses = new Map<string,string>();
    for (const card of cards) {
      if (card.receiptSnapshot?.version === 3 && card.receiptSnapshot?.kind === 'order-native') {
        try {
          const source = card.sampleId ? await tx.orderSampleSource.findUnique({where:{sampleId:card.sampleId},select:{id:true}}) : null;
          const ack = source && source.id === card.receiptSnapshot?.source?.sourceId ? await loadOrderSamplePhysicalReceipt(tx,source.id) : null;
          statuses.set(card.id,ack?.cardId === card.id ? 'verified' : 'legacyUnverified');
        } catch (error) {
          if (error instanceof OrderSampleRecordError || error instanceof OrderSampleContractError || error instanceof DevelopmentDomainError && ['CONFLICT','INVALID_INPUT'].includes(error.code)) statuses.set(card.id,'legacyUnverified');
          else throw error;
        }
        continue;
      }
      const receipt=readBatchReceiptSnapshot(card.receiptSnapshot),matches=byId.get(card.id)??[],audit=matches[0],after=audit?.detail?.after;
      const verified=receipt&&card.batchId===receipt.batchId&&card.devCaseId===receipt.developmentCaseId&&card.cardType===receipt.cardType
        &&card.unit===receipt.physicalUnit&&String(card.createdAt)===batchReceiptRecordedAt(receipt)&&matches.length===1
        &&audit.actorId===receipt.receivedBy&&audit.operationType==='create'&&['sample-room:batch-received','development:sample-return'].includes(audit.detail?.source)
        &&after?.code===card.code&&typeof after.name==='string'&&after.cardType===receipt.cardType&&after.unit===receipt.physicalUnit
        &&after.devCaseId===receipt.developmentCaseId&&after.batchId===receipt.batchId&&after.quantity===receipt.initialPhysicalCardCount
        &&after.availableQty===receipt.initialPhysicalCardCount&&Object.prototype.hasOwnProperty.call(after,'receiptSnapshot')&&fingerprint(after.receiptSnapshot)===fingerprint(card.receiptSnapshot);
      const manual=card.receiptSnapshot==null||card.receiptSnapshot?.kind==='manual'&&Object.keys(card.receiptSnapshot).length===1;
      statuses.set(card.id,verified?'verified':!card.batchId&&manual?'manual':'legacyUnverified');
    }
    return statuses;
  }

  // Custody writers serialize on the card, including partial borrowing and shipping.
  // Keep the same real row-lock contract as batch-to-card registration.
  async function lockCard(tx: any, id: string) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleCardItem" WHERE "id" = ${id} FOR UPDATE`);
    return tx.sampleCardItem.findFirst({ where: { id, deletedAt: null } });
  }

  async function activeBorrowQuantity(tx: any, itemId: string): Promise<number> {
    const loans = await tx.sampleCardLoan.findMany({ where: { itemId, loanType: 'borrow', returnedAt: null } });
    return loans.reduce((sum: number, loan: any) => {
      if (loan.loanLength != null) throw new Error('Meter loan cannot be counted as a physical piece');
      const quantity = Number(loan.loanQuantity);
      if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Invalid active sample-card loan quantity');
      const returned = countedReturnedQuantity(loan);
      return sum + quantity - returned;
    }, 0);
  }

  function countedReturnEvents(loan: any): any[] {
    const history = loan.lengthReturnHistory ?? [];
    if (!Array.isArray(history)) throw new Error('Invalid sample-card return history');
    const events = history.filter((event: any) => event && Object.prototype.hasOwnProperty.call(event, 'quantity'));
    if (events.length !== history.length && history.some((event: any) => event && Object.prototype.hasOwnProperty.call(event, 'length')))
      throw new Error('Meter return history is attached to a counted sample');
    return events;
  }

  function countedReturnedQuantity(loan: any): number {
    const sum = countedReturnEvents(loan).reduce((total: number, event: any) => {
      if (!Number.isSafeInteger(event.quantity) || event.quantity < 1) throw new Error('Invalid counted sample return quantity');
      return total + event.quantity;
    }, 0);
    const original = Number(loan.loanQuantity);
    if (!Number.isSafeInteger(original) || original < 1 || sum > original) throw new Error('Counted sample return history exceeds original loan');
    return sum;
  }

  /** 样卡编号：SC-YYYYMMDD-NNN（当日递增，二维码载荷） */
  async function nextItemCode(client: any): Promise<string> {
    const prefix = `SC-${todayLocalKey().replace(/-/g, '')}`;
    await client.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('sample-room-received-code'))::text`);
    const count = await client.sampleCardItem.count({ where: { code: { startsWith: prefix } } });
    for (let number=count+1, attempt=0; attempt<1024; attempt++,number++) {
      const code=`${prefix}-${String(number).padStart(3,'0')}`;
      if (!await client.sampleCardItem.findFirst({where:{code},select:{id:true}})) return code;
    }
    throw new PhysicalSampleSourceError('CONFLICT','实物编号分配超出预算，请核对既有编号。');
  }

  /** 单条借还行的派生视图（逾期/活跃） */
  function serializeLoan(loan: any) { return serializeLoanAt(loan, businessNowMs()); }

  function serializeLoanAt(loan: any, nowTs: number) {
    const active = loan.returnedAt == null;
    const isCounted = loan.loanLength == null && loan.loanType === 'borrow';
    const returnedQuantity = isCounted ? countedReturnedQuantity(loan) : null;
    return {
      ...meterLoanView(loan),
      active,
      overdue: active && loan.dueAt != null && Number(loan.dueAt) < nowTs,
      ...(isCounted ? { returnedQuantity: returnedQuantity ?? 0, outstandingQuantity: Number(loan.loanQuantity) - (returnedQuantity ?? 0),
        countReturnHistory: countedReturnEvents(loan) } : {}),
    };
  }

  function deriveLibraryMetadata(c:any,sample:any,asset:any):SampleLibraryMetadata {
          if(c.libraryMetadata!=null)return normalizeLibraryMetadata(c.libraryMetadata,c.cardType)!;
          const lane=c.cardType==='colorcard'?'fabric':c.cardType;
          const receipt=readBatchReceiptSnapshot(c.receiptSnapshot),fp=asset?.fabricProfile?.deletedAt==null?asset?.fabricProfile:null,gp=asset?.garmentProfile?.deletedAt==null?asset?.garmentProfile:null;
          const native=receipt?.sampleType??(c.receiptSnapshot?.version===3&&c.receiptSnapshot?.kind==='order-native'?c.receiptSnapshot.source?.family:null)??sample?.type;
          const kindMap:Record<string,string>={'lab-dip':'dev_lab_dip','handloom':'dev_handloom','yardage':'dev_yardage','garment-round':'dev_other','ship':'production_ship','head':'production_head','pioneer':'production_pioneer','pp':'production_pp','proto':'dev_proto','fit':'dev_fit','size-set':'dev_size_set','fabric_ss':'production_ship','fabric_rc':'production_head','fabric_eps':'production_pioneer','garment_pp':'production_pp','garment_top':'production_top','garment_ship':'production_ship'};
          let kind=SAMPLE_KINDS.find(kind=>kind.value===kindMap[native]&&(kind.lanes as readonly string[]).includes(lane as string));
          kind??=SAMPLE_KINDS.find(kind=>kind.value==='other')!;
          const profileWeight=typeof fp?.weightValueGsm==='number'&&fp.weightValueGsm>0&&fp.weightValueGsm<=3000?fp.weightValueGsm:null;
          return normalizeLibraryMetadata({version:1,purpose:kind.purpose,sampleKind:kind.value,sourceType:'internal',category:gp?.garmentCategory??asset?.classificationLinks?.find((link:any)=>link.deletedAt==null&&link.classification?.deletedAt==null&&['category','type','fabric_type','fabricType'].includes(link.classification?.dimension))?.classification?.name??null,colorName:fp?.colorDescription??null,colorCode:c.colorCardCode??fp?.millColorCode??null,weightGsm:profileWeight,construction:fp?.construction??null,gender:gp?.gender??null,styleCategory:gp?.garmentCategory??null,season:asset?.season??null,collection:gp?.collection??null,composition:asset?.compositionLines?.filter((r:any)=>r.deletedAt==null).map((r:any)=>`${r.term?.chineseName??r.term?.englishName??r.term?.abbreviation??r.termId??''} ${String(r.percentage)}%`).join(' / ')||null,tags:[]},c.cardType)!;
  }
  function serializeItem(item: any, activeLoan?: any, links?: { devCase?: any; order?: any; warehouse?: any; productAsset?: any; sample?: any }, activeLoans?: any[], nowTs = businessNowMs()) {
    const loan = activeLoan ? serializeLoanAt(activeLoan, nowTs) : undefined;
    const loans = activeLoans ?? (activeLoan ? [activeLoan] : []);
    return {
      ...Object.fromEntries(Object.entries(item).filter(([key])=>!['registrationKey','registrationFingerprint'].includes(key))),
      physicalLengthQty: item.physicalLengthQty?.toString() ?? null,
      availableLengthQty: item.availableLengthQty?.toString() ?? null,
      locationDetail: normalizeLocationDetail(item.locationDetail) ?? null,
      libraryMetadata: item.libraryMetadata ?? null, customerRelationId:item.customerRelationId??null, custodianUserId:item.custodianUserId??null,
      photos: publicPhotoMetadata(item.id, item.photos),
      receiptStatus: item.batchId ? (readBatchReceiptSnapshot(item.receiptSnapshot) ? 'verified' : 'legacyUnverified') : 'manual',
      activeLoan: loan ?? null,
      // 全部未归还借出（部分借出场景一笔都不可丢，逐笔可独立归还）
      activeLoans: loans.map((row: any) => serializeLoanAt(row, nowTs)),
      overdue: loans.some((l: any) => l.dueAt != null && Number(l.dueAt) < nowTs && l.returnedAt == null),
      devCaseCode: links?.devCase?.code ?? null,
      devCaseName: links?.devCase?.name ?? null,
      orderPoNumber: links?.order?.poNumber ?? null,
      orderCustomer: links?.order?.customer ?? null,
      warehouseCode: links?.warehouse?.code ?? null,
      warehouseName: links?.warehouse?.name ?? null,
      productAssetSku: links?.productAsset?.sku ?? null,
      productAssetName: links?.productAsset?.name ?? null,
      productAssetCategory: links?.productAsset?.mainCategory ?? null,
      sampleCode: links?.sample?.code ?? null,
      sampleType: links?.sample?.type ?? null,
    };
  }

  // ── 登记 ──
  async function createItem(input: {
    name?: string; cardType?: string; colorCardCode?: string; location?: string; locationDetail?: unknown; notes?: string;
    quantity?: number; physicalLengthQty?: string | number; minStock?: number | null; maxStock?: number | null; unit?: string;
    warehouseId?: string; devCaseId?: string; batchId?: string; orderId?: string; productAssetId?: string;
    sampleId?: string; libraryMetadata?: unknown; customerRelationId?: string; clientRequestId?: string;
  }, actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    try {
      const actorId = actualActor(actor).userId;
      const name = String(input.name ?? '').trim();
      if (!name) return fail('VALIDATION_FAILED', 'name 必填（样卡名称）');
      if (input.batchId != null && (typeof input.batchId !== 'string' || input.batchId.trim())) {
        return fail('VALIDATION_FAILED', '批次实物须通过开发批次的受控收样登记，不能由普通登记设置 batchId');
      }
      const cardType = input.cardType === undefined ? 'fabric' : typeof input.cardType === 'string' ? input.cardType.trim() : '';
      if (!cardType || cardType.length > 80) return fail('VALIDATION_FAILED', '实物分类须为 1 至 80 字文本。');
      let libraryMetadata:SampleLibraryMetadata|null;
      try {libraryMetadata=normalizeLibraryMetadata(input.libraryMetadata,cardType);} catch(e:any){return fail('VALIDATION_FAILED',e.message);}
      if(input.clientRequestId!==undefined && (typeof input.clientRequestId!=='string'||!input.clientRequestId.trim()||input.clientRequestId.length>200))return fail('VALIDATION_FAILED','登记请求编号须为不超过 200 字的明确文本。');
      const registrationKey=input.clientRequestId?fingerprint({actorId,request:input.clientRequestId}):null;
      if (input.location !== undefined && (typeof input.location !== 'string' || input.location.length > 200)) return fail('VALIDATION_FAILED', '存放位置须为不超过 200 字的文本。');
      const locationDetail=normalizeLocationDetail(input.locationDetail);
      if(input.locationDetail!==undefined&&locationDetail===undefined)return fail('VALIDATION_FAILED','locationDetail 只能包含 zone、shelf、level、bin 四个不超过 80 字符的文本位置。');

      // 可选逻辑色卡关联（DR-057-①）：不存在不阻断（快照式弱关联）
      const colorCardCode = input.colorCardCode ? String(input.colorCardCode).trim() : null;

      // 库存参数校验
      const quantity = input.quantity === undefined ? 1 : input.quantity;
      const minStock = input.minStock == null ? null : input.minStock;
      const maxStock = input.maxStock == null ? null : input.maxStock;
      const validStock = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 2147483647;
      if (!validStock(quantity)) return fail('VALIDATION_FAILED', 'quantity 须为 0 至 2147483647 的整数');
      if (cardType === 'garment' && quantity !== 1) return fail('VALIDATION_FAILED', '成衣样按单件建档；每次只登记 1 件，每件分别生成独立编号。');
      if ((minStock !== null && !validStock(minStock)) || (maxStock !== null && !validStock(maxStock))) return fail('VALIDATION_FAILED', '库存上下限须为 0 至 2147483647 的整数');
      if (minStock != null && maxStock != null && minStock > maxStock) {
        return fail('VALIDATION_FAILED', 'minStock 不能大于 maxStock');
      }
      const unit = input.unit === undefined ? '张' : input.unit;
      if (typeof unit !== 'string' || !CARD_UNITS.includes(unit)) return fail('VALIDATION_FAILED', `unit 必须是: ${CARD_UNITS.join(', ')}`);

      const isMeterStock = unit === '米' || unit === 'M';
      const isYardage = cardType === 'fabric' && ['dev_yardage', 'sales_stock_yardage'].includes(libraryMetadata?.sampleKind ?? '');
      let physicalLengthQty: string | null = null;
      if (isMeterStock || isYardage || input.physicalLengthQty !== undefined) {
        if (!['fabric', 'colorcard'].includes(cardType) || !isMeterStock) return fail('VALIDATION_FAILED', '米样长度只用于按米登记的面料样品。');
        const raw = String(input.physicalLengthQty ?? '').trim();
        if (!/^\d{1,14}(?:\.\d{1,4})?$/.test(raw) || !new Prisma.Decimal(raw).gt(0)) return fail('VALIDATION_FAILED', '米样长度须大于零，最多四位小数。');
        if (quantity !== 1) return fail('VALIDATION_FAILED', '米样按实物段登记实际长度，不能以整数件数代替米数。');
        physicalLengthQty = new Prisma.Decimal(raw).toString();
      }

      // Inherit real sample ownership; a material descriptor is not the
      // Sample's business subject and never contributes a business-line vote.
      return await db.$transaction(async (tx: any) => {
        const before = await creationAuthority(tx,input,actor!);
        const registrationFingerprint=fingerprint({...input,libraryMetadata,clientRequestId:undefined});
        if(registrationKey){
          await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${registrationKey}))::text`);
          const prior=await tx.sampleCardItem.findUnique({where:{registrationKey}});
          if(prior){
            await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id:prior.id},mode:'write'});
            if(prior.deletedAt!=null||prior.registrationFingerprint!==registrationFingerprint)return fail('REGISTRATION_CONFLICT','同一登记请求已有不同内容，请核对原登记。',409);
            return {ok:true as const,data:{item:serializeItem(prior),created:false}};
          }
        }
        const sources = await lockPhysicalSampleSources(tx, input,{extraRelationIds:before.customer?[before.customer.id]:[]});
        const after = await creationAuthority(tx,input,actor!);
        if (fingerprint(before) !== fingerprint(after)) throw new SampleCustodyAuthorizationError('SOURCE_CHANGED',409,'实物登记的归属或授权已变化。');
        const { warehouseId, devCaseId, orderId, productAssetId, sampleId } = sources;
        // Successful original registrations returned above; only new linked facts obey this gate.
        if (devCaseId) await assertDevelopmentOperationalWrite(tx, devCaseId, 'sample');
        // The actual Sample lock and fresh custody authorization precede this
        // mandatory native lookup. Missing storage must abort, never downgrade.
        if (sampleId && await tx.orderSampleSource.findUnique({where:{sampleId},select:{id:true}}))
          throw new PhysicalSampleSourceError('CONFLICT','原生订单样品须通过准确收样登记，不能手工建立实物库存。');

        const ts = Date.now();
        const item = await tx.sampleCardItem.create({
          data: {
            id: generateId('SCI'),
            code: await nextItemCode(tx),
            name,
            cardType,
            colorCardCode,
            location: input.location ? String(input.location).trim() : null,
            ...(locationDetail===undefined?{}:{locationDetail}),
            notes: input.notes ? String(input.notes).slice(0, 500) : null,
            status: 'in_stock',
            photos: [],
            quantity,
            availableQty: quantity,
            ...(physicalLengthQty === null ? {} : { physicalLengthQty, availableLengthQty: physicalLengthQty }),
            minStock,
            maxStock,
            unit,
            warehouseId,
            devCaseId,
            batchId: null,
            orderId,
            productAssetId,
            sampleId,
            libraryMetadata, receiptSnapshot:{kind:'manual'},deletedAt:null, customerRelationId:before.customer?.id??null,
            custodianUserId:!sampleId&&!devCaseId&&!orderId&&!before.customer?actorId:null,
            registrationKey,registrationFingerprint:registrationKey?registrationFingerprint:null,
            createdAt: ts,
            updatedAt: ts,
          },
        });
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'sample-room',
          operation: 'sample_card_create', targetType: 'SampleCardItem', targetId: item.id,
          after: { code: item.code, name, cardType, quantity, physicalLengthQty: physicalLengthQty?.toString() ?? null, location: item.location, warehouseId, locationDetail:locationDetail??null, devCaseId, batchId: null, orderId, productAssetId, sampleId, physicalSource: sources.physicalSource }, operationType: 'create',
        });
        return { ok: true, data: { item:serializeItem(item),created:true } };
      });
    } catch (e: any) {
      const authorization = authorityFailure(e); if (authorization) return authorization;
      if (e instanceof PhysicalSampleSourceError) return fail(e.code, e.message, e.status);
      if (e instanceof DevelopmentDomainError) return fail(e.code, e.message, e.statusCode);
      logger.error('[sample-room] createItem failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '样卡登记失败', 500);
    }
  }

  /** Update descriptive library fields only; ownership and immutable receipt stay guarded. */
  async function updateLibrary(id:string,input:Record<string,unknown>,actor?:TokenPayload):Promise<SampleRoomResult<any>> {
    try {
      actualActor(actor);
      const allowed=['name','notes','libraryMetadata','location','locationDetail','warehouseId','productAssetId'];
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))return fail('VALIDATION_FAILED','只能修改样品描述、分类和存放位置。');
      for(const key of ['name','notes','location','warehouseId'])if(input[key]!==undefined&&input[key]!==null&&(typeof input[key]!=='string'||(input[key] as string).length>(key==='notes'?2000:200)))return fail('VALIDATION_FAILED','样品描述或位置文本不合法。');
      if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()))return fail('VALIDATION_FAILED','样品名称必填。');
      const locationDetail=normalizeLocationDetail(input.locationDetail);
      if(input.locationDetail!==undefined&&locationDetail===undefined)return fail('VALIDATION_FAILED','详细库位不合法。');
      return await db.$transaction(async(tx:any)=>{
        const authorization=await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id},mode:'write'});
        const current=await tx.sampleCardItem.findFirst({where:{id,deletedAt:null}});
        if(!current)return fail('NOT_FOUND','样品实物不存在或不可见。',404);
        if (input.productAssetId !== undefined && (current.batchId != null || current.devCaseId != null)
          && input.productAssetId !== current.productAssetId) return fail('CONFLICT','开发样只能通过正式 QC 通过后的受控转档操作关联产品档案。',409);
        const assetId = input.productAssetId === undefined ? current.productAssetId : input.productAssetId;
        if (input.productAssetId !== undefined && (typeof assetId !== 'string' || !assetId.trim())) return fail('VALIDATION_FAILED','请选择已有数字档案');
        if (current.productAssetId && assetId !== current.productAssetId) return fail('CONFLICT','已有产品档案关联不能在资料编辑中替换',409);
        if (assetId) {
          const asset = await tx.productAsset.findUnique({where:{id:assetId}});
          if (!asset || asset.deletedAt != null) return fail('VALIDATION_FAILED','数字档案不存在或已删除');
          const lane = current.cardType === 'colorcard' ? 'fabric' : current.cardType;
          if (asset.mainCategory !== ({fabric:'Fabric',garment:'Garment',trim:'Trimming'} as any)[lane] && lane !== 'other') return fail('VALIDATION_FAILED','数字档案与实物分类不匹配');
        }
        const warehouseId=input.warehouseId===undefined?current.warehouseId:(input.warehouseId as string|null)?.trim()||null;
        // Lock the incoming warehouse together with existing parent graph, before the Card.
        const refs=[...authorization.lockRefs];
        if(assetId&&!refs.some(ref=>ref.kind==='asset'&&ref.id===assetId))refs.push({kind:'asset',id:assetId});
        if(warehouseId&&!refs.some(ref=>ref.kind==='warehouse'&&ref.id===warehouseId)){
          const warehouse=await tx.warehouse.findUnique({where:{id:warehouseId}});
          if(!warehouse||warehouse.deletedAt!=null||warehouse.isActive!==true)return fail('VALIDATION_FAILED','仓库不存在或已停用。');
          const index=refs.findIndex(ref=>ref.kind==='sample'||ref.kind==='card');
          refs.splice(index<0?refs.length:index,0,{kind:'warehouse',id:warehouseId});
        }
        // Build a server-owned frozen union; never accept caller lock refs.
        const lockOrder=['case','relation','batch','order','asset','warehouse','sample','card'];
        refs.sort((a,b)=>lockOrder.indexOf(a.kind)-lockOrder.indexOf(b.kind)||a.id.localeCompare(b.id));
        await lockSampleCustodyGraph(tx,{...authorization,lockRefs:refs,guard:{...authorization.guard,lockRefsHash:fingerprint(refs)}});
        const after=await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id},mode:'write'});
        assertSampleCustodyGuardStable(authorization.guard,after.guard);
        if(warehouseId){const wh=await tx.warehouse.findUnique({where:{id:warehouseId}});if(!wh||wh.deletedAt!=null||wh.isActive!==true)return fail('VALIDATION_FAILED','仓库不存在或已停用。');}
        if(assetId){const asset=await tx.productAsset.findUnique({where:{id:assetId}});if(!asset||asset.deletedAt!=null)return fail('VALIDATION_FAILED','数字档案不存在或已删除');}
        const data:any={updatedAt:Date.now()};
        if(input.productAssetId!==undefined)data.productAssetId=assetId;
        for(const key of ['name','notes','location'])if(input[key]!==undefined)data[key]=typeof input[key]==='string'?(input[key] as string).trim()||null:null;
        if(input.warehouseId!==undefined)data.warehouseId=warehouseId;
        if(input.locationDetail!==undefined)data.locationDetail=locationDetail;
        else if(input.location!==undefined)data.locationDetail=null;
        if(input.libraryMetadata!==undefined){try{data.libraryMetadata=normalizeLibraryMetadata(input.libraryMetadata,current.cardType);}catch(e:any){return fail('VALIDATION_FAILED',e.message);}}
        const priorPosition={location:current.location??null,locationDetail:current.locationDetail??null,warehouseId:current.warehouseId??null};
        const updated=await tx.sampleCardItem.update({where:{id},data});
        await writeRouteAuditLog({prisma:tx,actorId:actor!.userId,source:'sample-room',operation:'sample_card_library_update',targetType:'SampleCardItem',targetId:id,before:priorPosition,after:data,operationType:'update'});
        return {ok:true as const,data:{item:serializeItem(updated)}};
      });
    }catch(e:any){const authorization=authorityFailure(e);if(authorization)return authorization;logger.error('[sample-room] updateLibrary failed',{error:e?.message});return fail('INTERNAL_ERROR','样品资料更新失败',500);}
  }

  /** Append server-created private-photo references; bytes are committed by the route before this DB transaction,
   * and the route removes them if this guarded metadata append or audit fails. */
  async function appendItemPhotos(id: string, photos: any[], actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    try {
      actualActor(actor);
      if (!Array.isArray(photos) || photos.length < 1 || photos.length > MAX_ITEM_PHOTOS
        || photos.some(photo => !photo || typeof photo.id !== 'string' || !/^[0-9a-f-]{36}$/.test(photo.id)
          || photo.storageKey !== `sample-photos/${photo.id}.${photo.mimeType==='image/jpeg'?'jpg':photo.mimeType==='image/png'?'png':photo.mimeType==='image/webp'?'webp':'invalid'}`
          || typeof photo.signature !== 'string' || !/^[a-f0-9]{64}$/.test(photo.signature) || !['image/jpeg','image/png','image/webp'].includes(photo.mimeType)
          || !Number.isSafeInteger(photo.size) || photo.size < 1 || !/^[a-f0-9]{64}$/.test(photo.sha256)
          || typeof photo.uploadedAt !== 'string' || !Number.isFinite(Date.parse(photo.uploadedAt)) || photo.uploadedBy !== actor?.userId))
        return fail('INVALID_INPUT', '样品照片元数据无效。');
      return await db.$transaction(async (tx:any) => {
        const item = await authorizedCard(tx,id,actor!);
        if (!item) return fail('NOT_FOUND', '样品实物不存在或不可见。',404);
        const existing = Array.isArray(item.photos) ? item.photos : [];
        if (existing.length + photos.length > MAX_ITEM_PHOTOS) return fail('PHOTO_LIMIT_REACHED', `每件实物最多登记 ${MAX_ITEM_PHOTOS} 张照片。`,409);
        if (photos.some(photo => existing.some((row:any)=>row?.id===photo.id))) return fail('PHOTO_CONFLICT','照片编号已存在，请重新上传。',409);
        const updated = await tx.sampleCardItem.update({where:{id},data:{photos:[...existing,...photos],updatedAt:Date.now()}});
        await writeRouteAuditLog({prisma:tx,actorId:actor!.userId,source:'sample-room',operation:'sample_card_photo_upload',targetType:'SampleCardItem',targetId:id,
          after:{code:item.code,photoIds:photos.map(photo=>photo.id),count:existing.length+photos.length},operationType:'link',fieldPath:'photos'});
        return {ok:true,data:{item:serializeItem(updated)}};
      });
    } catch (e:any) {
      const authorization=authorityFailure(e);if(authorization)return authorization;
      logger.error('[sample-room] appendItemPhotos failed',{error:e?.message});return fail('INTERNAL_ERROR','样品照片登记失败',500);
    }
  }

  /** Each private-photo read re-runs full physical custody authorization and returns one exact stored reference. */
  async function getItemPhoto(id:string,photoId:string,actor?:TokenPayload):Promise<SampleRoomResult<any>> {
    try {
      actualActor(actor);
      const snapshot=await db.$transaction(async(tx:any)=>{
        const permission=await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id}});
        const item=await tx.sampleCardItem.findFirst({where:{id,deletedAt:null}});
        if(!item)throw new SampleCustodyAuthorizationError('NOT_FOUND',404,'样品实物不存在或不可见。');
        const photo=(Array.isArray(item.photos)?item.photos:[]).find((row:any)=>row?.id===photoId);
        if(!photo)throw new SampleCustodyAuthorizationError('NOT_FOUND',404,'样品照片不存在或不可见。');
        return {guard:permission.guard,result:{ok:true as const,data:{itemId:id,photo}}};
      },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:5000,timeout:30000});
      await finalRead(actor!,[snapshot.guard]);return snapshot.result;
    } catch(e:any) {const authorization=authorityFailure(e);if(authorization)return authorization;logger.error('[sample-room] getItemPhoto failed',{error:e?.message});return fail('INTERNAL_ERROR','样品照片读取失败',500);}
  }

  // DR-054 receipt is independent of design/QC approval. The later DR-D6
  // decision keeps Decimal sample length separate from Int physical card count.
  async function registerReceivedBatchCards(batchId: string, input: BatchCardReceiptInput, actorId?: string): Promise<SampleRoomResult<any>> {
    try {
      const reject = (code: string, message: string): never => { throw new DevelopmentDomainError(code, message); };
      const quantity = input?.physicalCardCount;
      if (input?.receiptVersion !== 2) return fail('VALIDATION_FAILED', '请使用准确轮次收样功能，旧收样请求不能产生新的登记');
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0 || quantity > 2147483647) {
        return fail('VALIDATION_FAILED', 'physicalCardCount 必填，须为 0 至 2147483647 的整数');
      }
      if (!RECEIPT_CARD_TYPES.includes(input.cardType)) return fail('VALIDATION_FAILED', '请明确选择实际物件类型，不能按业务线推算材质');
      if (!Number.isSafeInteger(input.expectedSourceRound) || input.expectedSourceRound < 1
        || typeof input.expectedCaseId !== 'string' || !input.expectedCaseId.trim()
        || typeof input.expectedFactoryId !== 'string' || !input.expectedFactoryId.trim()) return fail('VALIDATION_FAILED', '请明确本批次的来源轮次、开发案与出品工厂');
      if (typeof input.expectedBatchUpdatedAt !== 'string' || !/^\d+$/.test(input.expectedBatchUpdatedAt)) return fail('VALIDATION_FAILED', 'expectedBatchUpdatedAt 必填，须为批次版本时间字符串');
      if (!actorId) return fail('UNAUTHORIZED', '收样登记须有真实操作账号', 401);
      if (input.actualQuantity !== undefined && input.actualQuantity !== null && typeof input.actualQuantity !== 'string') return fail('VALIDATION_FAILED', 'actualQuantity 须为十进制字符串或 null');
      let actual: Prisma.Decimal | null | undefined;
      try { actual = input.actualQuantity === undefined ? undefined : parseActualSampleBatchQuantity(input.actualQuantity); }
      catch (error) {
        if (error instanceof DevelopmentDomainError && error.code === 'INVALID_INPUT') return fail('VALIDATION_FAILED', error.message);
        throw error;
      }
      if (input.actualUnit !== undefined && input.actualUnit !== null && typeof input.actualUnit !== 'string') return fail('VALIDATION_FAILED', 'actualUnit 须为实际单位字符串或 null');
      const suppliedUnit = input.actualUnit === undefined ? undefined : input.actualUnit?.trim() || null;
      let submittedColorRating: number | null | undefined;
      try { submittedColorRating = input.colorRating === undefined ? undefined : normalizeReceiptColorRating(input.colorRating); }
      catch (error) { return fail('VALIDATION_FAILED', (error as Error).message); }

      const detail = normalizeLocationDetail(input.locationDetail);
      if (input.locationDetail !== undefined && detail === undefined) return fail('VALIDATION_FAILED','详细库位不合法');
      if (input.warehouseId !== undefined && (typeof input.warehouseId !== 'string' || !input.warehouseId.trim())) return fail('VALIDATION_FAILED','请选择有效仓库');
      if (input.location !== undefined && (typeof input.location !== 'string' || input.location.length > 200)) return fail('VALIDATION_FAILED','库位信息不合法');
      return await db.$transaction(async (tx: any) => {
        const initial = await tx.sampleBatch.findFirst({ where: { id: batchId, deletedAt: null } });
        if (!initial) reject('NOT_FOUND', '样品批次不存在或已删除');
        const initialIdentity = JSON.stringify([initial.developmentCaseId, initial.supplierRelationId, initial.round, initial.sampleType]);
        const initialCase = await tx.developmentCase.findFirst({ where: { id: initial.developmentCaseId, deletedAt: null } });
        const initialFingerprint = sampleOriginFingerprint(snapshotSampleOrigin(initial, initialCase));
        // Same case -> batch -> physical row order as the development mutation
        // contract. Never skip the lock because a test double lacks a method.
        await assertDevelopmentOperationalWrite(tx, initial.developmentCaseId, 'sample');
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id" = ${batchId} AND "deletedAt" IS NULL FOR UPDATE`);
        const batch = await tx.sampleBatch.findFirst({ where: { id: batchId, deletedAt: null } });
        if (!batch || JSON.stringify([batch.developmentCaseId, batch.supplierRelationId, batch.round, batch.sampleType]) !== initialIdentity
          || batch.developmentCaseId !== input.expectedCaseId || batch.supplierRelationId !== input.expectedFactoryId) reject('DEVELOPMENT_SOURCE_CHANGED', '来源批次归属或工厂已变化，请刷新后重试');
        if (batch.round !== input.expectedSourceRound) reject('BATCH_RECEIPT_STALE', '来源轮次已变化，请刷新后登记本轮实物');
        const isGarmentBatch = batch.sampleType === 'garment-round';
        if (isGarmentBatch && input.cardType !== 'garment') reject('VALIDATION_FAILED', '成衣轮次的返样实物分类必须为成衣。');
        if (isGarmentBatch && quantity < 1) reject('VALIDATION_FAILED', '成衣样必须至少登记一件实物；每件将单独生成档案和编号。');
        const devCase = await tx.developmentCase.findFirst({ where: { id: batch.developmentCaseId, deletedAt: null } });
        const currentSource = snapshotSampleOrigin(batch, devCase);
        const currentFingerprint = sampleOriginFingerprint(currentSource);
        const isNewWorkflow = batch.sampleVersionId != null || batch.returnedAt != null;
        if (isNewWorkflow && input.result !== undefined) reject('DEVELOPMENT_SOURCE_CHANGED', '返样成果已单独登记并送 QC，入库时不能再次改写成果');
        // A receipt records only the value explicitly observed at intake. Do not
        // backfill it from mutable workflow/QC metadata on the development batch.
        const observedRating = submittedColorRating ?? null;
        if (isNewWorkflow && submittedColorRating !== undefined && submittedColorRating !== (batch.colorRating ?? null))
          reject('DEVELOPMENT_SOURCE_CHANGED', 'QC 前已冻结色差结果，入库时不能再修改');
        const resultSnapshot = {
          dyeLotNo: batch.dyeLotNo ?? null,
          sideDiff: batch.sideDiff ?? null,
          endDiff: batch.endDiff ?? null,
          defectCauses: [...(batch.defectCauses ?? [])],
          notes: batch.notes ?? null,
        };
        if (currentFingerprint !== initialFingerprint) reject('DEVELOPMENT_SOURCE_CHANGED', '来源规格已变化，请重新核对收样依据');
        const requestedLength = (actual === undefined ? batch.actualQuantity : actual)?.toString() ?? null;
        const requestedUnit = suppliedUnit === undefined ? batch.actualUnit ?? null : suppliedUnit;
        // Include archived rows: deleting a legacy row cannot turn an unverified
        // original receipt into a newly verified receipt behind the audit trail.
        const existing = await tx.sampleCardItem.findMany({ where: { batchId }, orderBy: { id: 'asc' } });
        const matches: Array<{ current: any; fact: BatchCardReceiptSnapshot }> = [];
        for (const row of existing) {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleCardItem" WHERE "id" = ${row.id} FOR UPDATE`);
          const current = await tx.sampleCardItem.findFirst({ where: { id: row.id } });
          const fact = readBatchReceiptSnapshot(current?.receiptSnapshot);
          if (!fact) reject('BATCH_CARDS_LEGACY_UNVERIFIED', '旧样卡登记缺少准确轮次或来源证明，请在样品间核实；不会用当前来源升级或重复建卡');
          if (fact!.sourceRound === batch.round) matches.push({ current, fact: fact! });
        }
        if (matches.length > 1 && !isGarmentBatch) reject('BATCH_RECEIPT_CONFLICT', '本轮已有多个收样记录，请核对原实物，不任取或重复建卡');
        if (matches.length > 0) {
          if (matches.some(({ current }) => current.deletedAt != null || current.status === 'retired'))
            reject('BATCH_CARDS_ARCHIVED', '该轮实物已有归档登记，请查看原记录，不重复建卡');
          const factsMatch = matches.every(({ current, fact }) => {
            const originalCountMatches = isGarmentBatch
              ? fact.initialPhysicalCardCount === 1 && fact.physicalItemCount === quantity
              : fact.initialPhysicalCardCount === quantity;
            return fact.batchId === batch.id && fact.batchCode === batch.batchCode
              && fact.developmentCaseId === batch.developmentCaseId && fact.sampleType === batch.sampleType
              && fact.factoryId === batch.supplierRelationId && fact.sourceFingerprint === currentFingerprint && fact.cardType === input.cardType
              // The source return transaction stores its declared business unit
              // (件/份/米); PC is reserved for the legacy warehouse-intake path.
              && originalCountMatches && fact.physicalUnit === (current.unit ?? 'PC')
              && (input.colorRating === undefined || fact.colorRating === observedRating)
              && (input.result === undefined || fact.resultSnapshot == null || JSON.stringify(fact.resultSnapshot) === JSON.stringify(resultSnapshot))
              && fact.actualQuantity === requestedLength && fact.actualUnit === requestedUnit
              && fact.actualQuantity === (batch.actualQuantity?.toString() ?? null) && fact.actualUnit === (batch.actualUnit ?? null);
          });
          if (isGarmentBatch) {
            const indices = matches.map(({ current, fact }) => fact.physicalItemIndex);
            const indicesAreComplete = matches.length === quantity && indices.every(index => Number.isSafeInteger(index) && index! >= 1 && index! <= quantity)
              && new Set(indices).size === quantity && matches.every(({ fact }) => fact.physicalItemCount === quantity);
            if (!indicesAreComplete) reject('BATCH_RECEIPT_CONFLICT', '已有成衣实物记录不是完整的逐件档案；请核实原记录，不自动拆分或重复建卡。');
          }
          if (!factsMatch) reject('BATCH_RECEIPT_CONFLICT', '该批次已有不同的收样事实，请在样品间核实调整，不覆盖原登记');
          const items = matches.map(({ current }) => current);
          return { ok: true as const, data: { item: items[0], items, batch: serializeBatch({ ...batch, resultsRecorded: true }), created: false, receiptStatus: 'verified', note: '收样事实相同，未重复登记或修改库存' } };
        }
        // New development workflow already creates physical items with return
        // results. This endpoint can verify that source record, never duplicate it.
        if (isNewWorkflow) reject('DEVELOPMENT_SOURCE_CHANGED', '开发返样登记已同步创建样品台账实物，请刷新并使用该实物记录；不能再次登记入库');
        // Check intake state only when creating a new physical card. Replays
        // above stay idempotent even after downstream send changes batch.status.
        if (isNewWorkflow) reject('DEVELOPMENT_SOURCE_CHANGED', '该开发批次没有返样成果同步创建的实物记录，不能从样品管理重复建卡');
        if (batch.updatedAt.toString() !== input.expectedBatchUpdatedAt) reject('BATCH_RECEIPT_STALE', '批次已变化，请刷新实际来源后重新登记');
        // Older unlinked records retain their existing intake compatibility.
        // New sample versions record outcomes before QC and never mutate them here.
        let updated = batch;
        if (!isNewWorkflow) {
          const update = await updateSampleBatch({ prisma, tx, batchId, actorId, input: {
            ...(actual !== undefined ? { actualQuantity: requestedLength } : {}),
            ...(suppliedUnit !== undefined ? { actualUnit: requestedUnit ?? '' } : {}),
            ...(input.colorRating !== undefined ? { colorRating: observedRating } : {}),
            ...(input.result !== undefined ? { dyeLotNo: resultSnapshot.dyeLotNo ?? '', sideDiff: resultSnapshot.sideDiff ?? undefined,
              endDiff: resultSnapshot.endDiff ?? undefined, defectCauses: resultSnapshot.defectCauses, notes: resultSnapshot.notes ?? '' } : {}),
          } });
          if (!update.ok) {
            if (update.error.status >= 500) throw new Error('Native sample batch update failed');
            reject(update.error.code === 'INVALID_INPUT' ? 'VALIDATION_FAILED' : update.error.code, update.error.message);
          }
          updated = await tx.sampleBatch.findFirst({ where: { id: batchId, deletedAt: null } });
        }
        if (!updated || updated.developmentCaseId !== batch.developmentCaseId) reject('DEVELOPMENT_SOURCE_CHANGED', '收样保存时来源发生变化');
        const occurredAt = BigInt(businessNowMs()), ts = BigInt(Date.now());
        const frozenSource = snapshotSampleOrigin(updated, devCase);
        if (frozenSource.batch.sampleVersionId !== currentSource.batch.sampleVersionId || frozenSource.batch.factoryId !== currentSource.batch.factoryId
          || frozenSource.batch.sourceRound !== currentSource.batch.sourceRound) reject('DEVELOPMENT_SOURCE_CHANGED', '收样保存时来源内容发生变化');
        const receiptSnapshot: BatchCardReceiptSnapshot = {
          version: 2, nativeFamily: updated.sampleType === 'garment-round' ? 'garment-round' : 'fabric-batch',
          batchId: updated.id, batchCode: updated.batchCode, developmentCaseId: updated.developmentCaseId, factoryId: updated.supplierRelationId,
          sourceRound: updated.round, sampleType: updated.sampleType, sourceSnapshot: frozenSource, sourceFingerprint: sampleOriginFingerprint(frozenSource), cardType: input.cardType,
          actualQuantity: updated.actualQuantity?.toString() ?? null, actualUnit: updated.actualUnit ?? null,
          colorRating: observedRating,
          resultSnapshot,
          batchUpdatedAt: updated.updatedAt.toString(), initialPhysicalCardCount: isGarmentBatch ? 1 : quantity, physicalUnit: 'PC', receivedAt: occurredAt.toString(), recordedAt: ts.toString(), receivedBy: actorId,
        };
        if (input.warehouseId) {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Warehouse" WHERE "id" = ${input.warehouseId} FOR UPDATE`);
          const wh = await tx.warehouse.findUnique({where:{id:input.warehouseId}});
          if (!wh || wh.deletedAt != null || !wh.isActive) reject('VALIDATION_FAILED','仓库不存在或已停用');
        }
        const cardType = input.cardType;
        const versionAssets = batch.sampleVersionId ? await tx.productAsset.findMany({ where: { sourceDevelopmentCaseId: batch.developmentCaseId, sourceSampleVersionId: batch.sampleVersionId, deletedAt: null }, select: { id: true, sourceSampleBatchId: true } }) : [];
        const batchAssets = await tx.productAsset.findMany({ where: { sourceDevelopmentCaseId: batch.developmentCaseId, sourceSampleBatchId: batch.id, deletedAt: null }, select: { id: true } });
        const exactAsset = batchAssets.length === 1 ? batchAssets[0] : versionAssets.length === 1 ? versionAssets[0] : null;
        const name = [devCase.code, devCase.name, batch.versionLabel, batch.batchCode, batch.sampleType].filter(Boolean).join(' · ');
        // Serialize the existing count-based SC code allocation for this bounded
        // entry so two different received batches do not both allocate its code.

        const items: any[] = [];
        const itemCount = isGarmentBatch ? quantity : 1;
        for (let index = 0; index < itemCount; index++) {
          const itemQuantity = isGarmentBatch ? 1 : quantity;
          const itemName = isGarmentBatch ? `${name} · 第 ${index + 1} 件` : name;
          const itemReceiptSnapshot: BatchCardReceiptSnapshot = isGarmentBatch
            ? { ...receiptSnapshot, physicalItemIndex: index + 1, physicalItemCount: itemCount }
            : receiptSnapshot;
          const item = await tx.sampleCardItem.create({ data: {
            id: generateId('SCI'), code: await nextItemCode(tx), name: itemName, cardType, quantity: itemQuantity, availableQty: itemQuantity, unit: 'PC',
            photos: Array.isArray(updated.photos) ? updated.photos.map((photo: any) => typeof photo === 'string' ? photo : photo?.url).filter((photo: unknown): photo is string => typeof photo === 'string' && photo.trim().length > 0) : [],
            status: 'in_stock', warehouseId:input.warehouseId || null, location:input.location?.trim() || null, locationDetail:detail ?? undefined, productAssetId:exactAsset?.id ?? (!batch.sampleVersionId ? devCase.productAssetId || null : null), devCaseId: batch.developmentCaseId, batchId, sampleId: null, receiptSnapshot: itemReceiptSnapshot, createdAt: ts, updatedAt: ts,
            notes: `按批次 ${batch.batchCode} 实际收样登记；长度与实物数量分别记录`,
          } });
          items.push(item);
          await writeRouteAuditLog({ prisma: tx, actorId, source: 'sample-room:batch-received', operation: 'sample_card_create', targetType: 'SampleCardItem', targetId: item.id,
            after: { code: item.code, name: itemName, cardType, quantity: itemQuantity, availableQty: itemQuantity, unit: 'PC', devCaseId: batch.developmentCaseId, batchId, receiptSnapshot: itemReceiptSnapshot }, operationType: 'create' });
        }
        return { ok: true as const, data: { item: items[0] ?? null, items, batch: serializeBatch({ ...updated, resultsRecorded: true }), created: true, receiptStatus: 'verified' } };
      });
    } catch (e: any) {
      if (e instanceof DevelopmentDomainError) return fail(e.code, e.message, e.statusCode);
      logger.error('[sample-room] registerReceivedBatchCards failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '收样登记失败；本次批次实际值、样卡与审计均未保存，请重试', 500);
    }
  }

  // ── 列表（状态/类型/搜索/编号直达/关联过滤/低库存；附活跃借出摘要+关联单据摘要+逾期派生） ──
  // DR-052 样品库：sampleIds 批量过滤（样品管理页列表实物摘要聚合一次拉回，避免 N+1）
  async function listItems(filter: {
    status?: unknown; cardType?: unknown; search?: unknown; code?: unknown;
    warehouseId?: unknown; devCaseId?: unknown; orderId?: unknown; productAssetId?: unknown; sampleId?: unknown; sampleIds?: unknown;
    lowStock?: unknown; scope?: unknown; limit?: unknown; offset?: unknown;
  } = {}, actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    const scope = filter.scope;
    if (scope !== undefined && !['fabric', 'garment', 'review'].includes(scope as string)) return fail('INVALID_INPUT', '样品间业务工作区须为 fabric、garment 或 review');
    const pageNumber = (v: unknown, fallback: number): number | null => {
      if (v === undefined) return fallback;
      if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+$/.test(v))) return null;
      const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    const limit = pageNumber(filter.limit, 50), offset = pageNumber(filter.offset, 0);
    if (limit === null || limit > 200 || offset === null) return fail('INVALID_INPUT', 'limit 须为 0–200 的整数，offset 须为非负安全整数');
    const filters: any = {};
    for (const key of ['status', 'cardType', 'search', 'code', 'warehouseId', 'devCaseId', 'orderId', 'productAssetId', 'sampleId'] as const) {
      const value = filter[key];
      if (value !== undefined && (typeof value !== 'string' || value.trim() !== value)) return fail('INVALID_INPUT', `${key} 须为字符串且不能带首尾空白`);
      filters[key] = value || null;
    }
    if (filters.status && !['in_stock', 'borrowed', 'shipped', 'retired'].includes(filters.status)) return fail('INVALID_INPUT', '非法实物状态');
      if (filters.cardType && filters.cardType.length > 80) return fail('INVALID_INPUT', '物料类型筛选须为不超过 80 字的文本');
    let sampleIds: string[] = [];
    if (filter.sampleIds !== undefined) {
      const values = typeof filter.sampleIds === 'string' ? filter.sampleIds.split(',') : filter.sampleIds;
      if (!Array.isArray(values) || values.length > 2000 || values.some(v => typeof v !== 'string' || !v.trim())) return fail('INVALID_INPUT', 'sampleIds 须为有效样品编号列表');
      sampleIds = [...new Set(values.map(v => v.trim()))].sort();
    }
    filters.sampleIds = sampleIds;
    if (filter.lowStock !== undefined && ![true, false, 'true', 'false'].includes(filter.lowStock as any)) return fail('INVALID_INPUT', 'lowStock 须为 true 或 false');
    filters.lowStock = filter.lowStock === true || filter.lowStock === 'true';
    try {
      actualActor(actor);
      const snapshot = await db.$transaction(async (tx: any) => {
        const snapshotAt = Date.now(), nowTs = businessNowMs(), where: any = { deletedAt: null };
        for (const key of ['status', 'cardType', 'code', 'warehouseId', 'devCaseId', 'orderId', 'productAssetId', 'sampleId']) if (filters[key]) where[key] = filters[key];
        if (filter.sampleIds !== undefined) where.sampleId = { in: filters.sampleId ? sampleIds.filter(id => id === filters.sampleId) : sampleIds };
        if (filters.search) where.OR = [{ name: { contains: filters.search } }, { code: { contains: filters.search } }, { location: { contains: filters.search } }];
        const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
        const scanned = await scanCustody(tx,actor!,where,orderBy,{limit,offset,scope,lowStock:filters.lowStock});
        const selectedIds = scanned.selected.map((row:any)=>row.card.id), total = scanned.total, contexts = scanned.selected.map((row:any)=>row.context);
        const raw = selectedIds.length ? await tx.sampleCardItem.findMany({where:{id:{in:selectedIds},deletedAt:null}}) : [];
        const byId = new Map<string,any>(raw.map((row:any)=>[row.id,row]));
        if(selectedIds.some((id:string)=>!byId.has(id)))throw Error('样品间快照原记录未能读回');
        const items=selectedIds.map((id:string)=>byId.get(id));
        const receiptStatuses=await directoryReceiptStatuses(tx,items.map(card=>({card,visibility:'full'})));
        const activeLoans = items.length ? await tx.sampleCardLoan.findMany({ where: { itemId: { in: items.map(i => i.id) }, loanType: 'borrow', returnedAt: null }, orderBy: { loanedAt: 'desc' } }) : [];
        const activeByItem = new Map<string, any>(), activeListByItem = new Map<string, any[]>();
        for (const loan of activeLoans) { if (!activeByItem.has(loan.itemId)) activeByItem.set(loan.itemId, loan); if (!activeListByItem.has(loan.itemId)) activeListByItem.set(loan.itemId, []); activeListByItem.get(loan.itemId)!.push(loan); }
        const ids = (key: string) => [...new Set(items.map(i => i[key]).filter(Boolean))];
        const [warehouses, devCases, orders, productAssets, samples] = await Promise.all([
          ids('warehouseId').length ? tx.warehouse.findMany({ where: { id: { in: ids('warehouseId') } }, select: { id: true, code: true, name: true } }) : [],
          ids('devCaseId').length ? tx.developmentCase.findMany({ where: { id: { in: ids('devCaseId') } }, select: { id: true, code: true, name: true } }) : [],
          ids('orderId').length ? tx.order.findMany({ where: { id: { in: ids('orderId') } }, select: { id: true, poNumber: true, customer: true } }) : [],
          ids('productAssetId').length ? tx.productAsset.findMany({ where: { id: { in: ids('productAssetId') } }, select: { id: true, sku: true, name: true, mainCategory: true } }) : [],
          ids('sampleId').length ? tx.sample.findMany({ where: { id: { in: ids('sampleId') }, deletedAt: null }, select: { id: true, code: true, type: true } }) : []]);
        const map = (rows: any[]) => new Map(rows.map(row => [row.id, row]));
        const wh = map(warehouses), dc = map(devCases), od = map(orders), pa = map(productAssets), sm = map(samples);
        return { guards: scanned.guards, result: { ok: true as const, data: { items: items.map((item, index) => ({ ...serializeItem(item, activeByItem.get(item.id), { devCase: dc.get(item.devCaseId) ?? null, order: od.get(item.orderId) ?? null, warehouse: wh.get(item.warehouseId) ?? null, productAsset: pa.get(item.productAssetId) ?? null, sample: sm.get(item.sampleId) ?? null }, activeListByItem.get(item.id) ?? [], nowTs), receiptStatus:receiptStatuses.get(item.id), businessContext: contexts[index] })), total,
          listVersion: 2, ...(scope === undefined ? {} : { scope }), filters, pagination: { limit, offset }, snapshotAt: String(snapshotAt) } } };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 30000 });
      await finalRead(actor!,snapshot.guards);return snapshot.result;
    } catch (e: any) {
      const authorization = authorityFailure(e); if (authorization) return authorization;
      logger.error('[sample-room] listItems failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '样卡列表查询失败', 500);
    }
  }

  // ── 详情（含借还历史正序） ──
  async function getItem(id: string, actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    try {
      actualActor(actor);
      const snapshot = await db.$transaction(async (tx:any) => {
        const permission = await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id}});
      const item = await tx.sampleCardItem.findFirst({ where: { id, deletedAt: null } });
      if (!item) throw new SampleCustodyAuthorizationError('NOT_FOUND',404,'样卡不存在或不可见。');
      const loans = await tx.sampleCardLoan.findMany({ where: { itemId: id }, orderBy: { loanedAt: 'asc' } });
      const activeBorrowLoans = loans.filter((l: any) => l.loanType === 'borrow' && l.returnedAt == null);
      const activeLoan = activeBorrowLoans.slice(-1)[0];

      // 关联单据摘要
      const links: any = {};
      if (item.devCaseId) links.devCase = await tx.developmentCase.findUnique({ where: { id: item.devCaseId }, select: { id: true, code: true, name: true } });
      if (item.orderId) links.order = await tx.order.findUnique({ where: { id: item.orderId }, select: { id: true, poNumber: true, customer: true } });
      if (item.warehouseId) links.warehouse = await tx.warehouse.findUnique({ where: { id: item.warehouseId }, select: { id: true, code: true, name: true } });
      if (item.productAssetId) links.productAsset = await tx.productAsset.findUnique({ where: { id: item.productAssetId }, include:{fabricProfile:true,garmentProfile:true,compositionLines:{include:{term:true}},classificationLinks:{include:{classification:true}}} });
      if (item.sampleId) links.sample = await tx.sample.findFirst({ where: { id: item.sampleId, deletedAt: null }, select: { id: true, code: true, type: true } });

      const receiptStatuses=await directoryReceiptStatuses(tx,[{card:item,visibility:'full'}]);
      const libraryMetadata=deriveLibraryMetadata(item,links.sample,links.productAsset);
      const customerId=item.customerRelationId || (item.devCaseId ? (await tx.developmentCase.findUnique({where:{id:item.devCaseId},select:{customerRelationId:true}}))?.customerRelationId : null) || null;
      const customer=customerId ? await tx.relation.findUnique({where:{id:customerId},select:{name:true}}):null;
      return { guard:permission.guard, result:{ ok: true as const, data: { item: {...serializeItem(item, activeLoan, links, activeBorrowLoans),libraryMetadata,customerRelationId:customerId,customerName:customer?.name??null,receiptStatus:receiptStatuses.get(item.id)}, loans: loans.map(serializeLoan) } } };
      },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:5000,timeout:30000});
      await finalRead(actor!,[snapshot.guard]);return snapshot.result;
    } catch (e: any) {
      const authorization = authorityFailure(e); if (authorization) return authorization;
      logger.error('[sample-room] getItem failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '样卡详情查询失败', 500);
    }
  }

  // ── 退役（终态；在借不可退役） ──
  async function retireItem(id: string, note?: string, actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    try {
      const actorId = actualActor(actor).userId;
      return await db.$transaction(async (tx: any) => {
        const item = await authorizedCard(tx, id, actor!);
        if (!item) return fail('NOT_FOUND', `样卡 ${id} 不存在`, 404);
        if (item.status === 'borrowed' || (isMeterCard(item) ? (await tx.sampleCardLoan.findMany({where:{itemId:id,loanType:'borrow',returnedAt:null}})).length > 0 : await activeBorrowQuantity(tx, id) > 0)) return fail('ITEM_NOT_BORROWABLE', '样卡在借中，须先归还再退役', 409);
        if (item.status === 'retired') return fail('ITEM_RETIRED', '样卡已退役（终态）', 409);
        const ts = Date.now();
        const updated = await tx.sampleCardItem.update({
          where: { id },
          data: { status: 'retired', notes: note ? String(note).slice(0, 500) : item.notes, updatedAt: ts },
        });
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'sample-room',
          operation: 'sample_card_retire', targetType: 'SampleCardItem', targetId: id,
          after: { code: item.code, note }, operationType: 'update', fieldPath: 'status',
        });
        return { ok: true, data: { item: updated } };
      });
    } catch (e: any) {
      const authorization = authorityFailure(e); if (authorization) return authorization;
      logger.error('[sample-room] retireItem failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '样卡退役失败', 500);
    }
  }

  // ── 借出 / 看样登记（DR-057-② 统一流水；v2 支持 loanQuantity） ──
  async function createLoan(
    itemId: string,
    input: { loanType?: string; loanQuantity?: unknown; loanLength?: string; requestKey?: string; borrowerName?: string; borrowerUserId?: string; relationId?: string; dueAt?: number },
    actor?: TokenPayload,
  ): Promise<SampleRoomResult<any>> {
    try {
      const actorId = actualActor(actor).userId;
      // Only omission keeps the legacy default. An explicit malformed physical
      // count must never be coerced or rounded into a different custody fact.
      const loanQuantity = input.loanQuantity === undefined ? 1 : input.loanQuantity;
      if (typeof loanQuantity !== 'number' || !Number.isSafeInteger(loanQuantity) || loanQuantity < 1 || loanQuantity > 2147483647) {
        return fail('VALIDATION_FAILED', '借出/看样数量须为安全范围内的正整数');
      }
      return await db.$transaction(async (tx: any) => {
        const loanType = String(input.loanType ?? 'borrow');
        if (!LOAN_TYPES.includes(loanType)) return fail('VALIDATION_FAILED', `loanType 必须是: ${LOAN_TYPES.join(', ')}`);
        const item = await authorizedCard(tx, itemId, actor!, loanType === 'viewing' ? input.relationId : undefined);
        if (!item) return fail('NOT_FOUND', `样卡 ${itemId} 不存在`, 404);
        if (loanType === 'borrow' && isMeterCard(item)) return {ok:true as const,data:await moveMeterStock(tx,item,actorId,'borrow',input)};
        if (input.loanLength !== undefined) return fail('VALIDATION_FAILED','按件样品不能提交米数。');
        const command = await countedStockCommand(tx,item,actorId,loanType as 'borrow'|'viewing',input,loanQuantity);
        if(command.prior)return {ok:true as const,data:{loan:serializeLoan(command.prior),item,replayed:true}};
        const borrowerName = command.name;

        if (item.status === 'retired') return fail('ITEM_RETIRED', '样卡已退役，不可借出/看样', 409);
        if (item.status === 'shipped') return fail('ITEM_SHIPPED', '样卡已寄出归档，不可借出/看样', 409);
        if (loanType === 'borrow' && item.sealedStatus === 'sealed') return fail('SEALED_SAMPLE_BORROW_FORBIDDEN', '该实物是封样留存件，禁止普通借出；请使用未封样库存。', 409);

        // Preserve the exact validated count for borrowing and viewing alike.
        if (loanQuantity > Number(item.quantity)) {
          return fail('VALIDATION_FAILED', `借出数量 ${loanQuantity} 超过总库存 ${item.quantity}`);
        }

        // 借出占用状态机；看样即看即还（不占借出状态，仍落流水挂客户）
        if (loanType === 'borrow') {
          const outstanding = await activeBorrowQuantity(tx,itemId);
          if(!Number.isSafeInteger(item.quantity)||!Number.isSafeInteger(item.availableQty)||item.availableQty<0
            ||item.quantity!==item.availableQty+outstanding)
            return fail('STOCK_INCONSISTENT','总库存、可用数量与未还借用数量不一致，请先核实原实物流水。',409);
          // v2：availableQty 校验 + 部分借出
          if (Number(item.availableQty) < loanQuantity) {
            return fail('INSUFFICIENT_QTY', `可用数量不足（剩余 ${item.availableQty}，申请 ${loanQuantity}）`, 409);
          }
          const dueAt = command.dueAt;
          const ts = Date.now();
          const loan = await tx.sampleCardLoan.create({
            data: {
              id: command.id,
              meterRequestKey: command.requestKey,
              meterCommandHash: command.commandHash,
              itemId,
              loanType,
              loanQuantity,
              borrowerName,
              borrowerUserId: command.borrowerUserId,
              relationId: null,
              relationName: null,
              loanedAt: ts,
              dueAt,
              operatorId: actorId,
              createdAt: ts,
            },
          });
          // v2：扣减 availableQty；若 availableQty = 0 则 status = borrowed
          const newAvailable = Number(item.availableQty) - loanQuantity;
          const updated = await tx.sampleCardItem.update({
            where: { id: itemId },
            data: {
              availableQty: newAvailable,
              status: newAvailable === 0 ? 'borrowed' : item.status,
              updatedAt: ts,
            },
          });
          await writeRouteAuditLog({
            prisma: tx, actorId, source: 'sample-room',
            operation: 'sample_card_loan', targetType: 'SampleCardItem', targetId: itemId,
            after: { code: item.code, loanId: loan.id, borrowerName, dueAt, loanQuantity, availableAfter: newAvailable }, operationType: 'link',
          });
          return { ok: true, data: { loan: serializeLoan(loan), item: updated, replayed:false } };
        }

        // viewing：relationId 关联客户（快照 relationName），即看即还
        const relationId = input.relationId ? String(input.relationId) : null;
        let relationName: string | null = null;
        if (relationId) {
          const rel = await tx.relation.findFirst({ where: { id: relationId, deletedAt: null }, select: { name: true } });
          if (!rel) return fail('VALIDATION_FAILED', `客户 ${relationId} 不存在`);
          relationName = rel.name;
        }
        const ts = Date.now();
        const loan = await tx.sampleCardLoan.create({
          data: {
            id: command.id,
            meterRequestKey: command.requestKey,
            meterCommandHash: command.commandHash,
            itemId,
            loanType,
            loanQuantity,
            borrowerName,
            borrowerUserId: null,
            relationId,
            relationName,
            loanedAt: ts,
            dueAt: null,
            returnedAt: ts, // 看样即看即还：登记即归还态，历史可查
            operatorId: actorId,
            createdAt: ts,
          },
        });
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'sample-room',
          operation: 'sample_card_viewing', targetType: 'SampleCardItem', targetId: itemId,
          after: { code: item.code, loanId: loan.id, relationId, relationName, viewer: borrowerName, loanQuantity }, operationType: 'link',
        });
        return { ok: true, data: { loan: serializeLoan(loan), item, replayed:false } };
      });
    } catch (e: any) {
      const authorization = authorityFailure(e); if (authorization) return authorization;
      logger.error('[sample-room] createLoan failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '借出/看样登记失败', 500);
    }
  }

  // ── 归还（append-only：只补 returnedAt/conditionNote；v2 增加 availableQty） ──
  async function returnLoan(loanId: string, conditionNote?: string | {returnLength?: string; requestKey?: string; conditionNote?: string; returnQuantity?: unknown}, actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    try {
      const actorId = actualActor(actor).userId;
      await roomWriteAuthority(db,actor!);
      const original = await db.sampleCardLoan.findUnique({ where: { id: loanId } });
      if (!original) return fail('NOT_FOUND', `借出记录 ${loanId} 不存在`, 404);
      return await db.$transaction(async (tx: any) => {
        const item = await authorizedCard(tx, original.itemId, actor!);
        if (!item) return fail('NOT_FOUND', `样卡 ${original.itemId} 不存在`, 404);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleCardLoan" WHERE "id" = ${loanId} FOR UPDATE`);
        const loan = await tx.sampleCardLoan.findUnique({ where: { id: loanId } });
        if (!loan || loan.itemId !== original.itemId) return fail('NOT_FOUND', `借出记录 ${loanId} 不存在`, 404);
        if (isMeterCard(item) || loan.loanLength != null) return {ok:true as const,data:await returnMeterStock(tx,item,loan,actorId,typeof conditionNote === 'object' ? conditionNote : {conditionNote})};
        if (loan.loanType !== 'borrow') return fail('VALIDATION_FAILED', '看样记录即看即还，无需归还操作');
        const history = countedReturnEvents(loan), returnedSoFar = countedReturnedQuantity(loan);
        const originalQuantity = Number(loan.loanQuantity), outstandingForLoan = originalQuantity - returnedSoFar;
        const partialInput = typeof conditionNote === 'object' && conditionNote !== null;
        const returnInput: any = partialInput ? conditionNote : null;
        if (!partialInput && loan.returnedAt != null) return fail('LOAN_ALREADY_ACTIVE', '该借出已归还（重复归还）', 409);
        if (item.status === 'retired') return fail('ITEM_RETIRED', '样卡已退役，不可归还登记', 409);
        if (item.status === 'shipped') return fail('ITEM_SHIPPED', '样卡已寄出归档，不可归还登记', 409);
        if (partialInput && returnInput.returnLength !== undefined) return fail('VALIDATION_FAILED','按件归还不能提交米数。');
        if (partialInput && returnInput.returnQuantity === undefined) return fail('VALIDATION_FAILED','按份归还请填写本次归还数量。');
        const returnQuantity = partialInput ? returnInput.returnQuantity : outstandingForLoan;
        if (typeof returnQuantity !== 'number' || !Number.isSafeInteger(returnQuantity) || returnQuantity < 1 || returnQuantity > 2147483647)
          return fail('VALIDATION_FAILED','按份归还数量须为明确的正整数。');
        const note = typeof conditionNote === 'string' ? conditionNote : returnInput?.conditionNote;
        const requestKey = partialInput ? returnInput.requestKey : null;
        if (partialInput && (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 200))
          return fail('VALIDATION_FAILED','分次归还请保留同一次请求编号。');
        const commandHash = fingerprint({loanId,returnQuantity,conditionNote:typeof note==='string'?note.trim().slice(0,500):null});
        if (partialInput) {
          const prior = history.find((event: any) => event.requestKey === requestKey && event.operatorId === actorId);
          if (prior) {
            if (prior.commandHash !== commandHash) return fail('REQUEST_CONFLICT','同一归还请求已有不同内容。',409);
            return {ok:true as const,data:{loan:serializeLoan(loan),item,replayed:true}};
          }
        }
        if (loan.returnedAt != null) return fail('LOAN_ALREADY_ACTIVE', '该借出已归还（重复归还）', 409);
        if (!Number.isSafeInteger(originalQuantity) || originalQuantity < 1 || !Number.isSafeInteger(outstandingForLoan) || outstandingForLoan < 1)
          return fail('VALIDATION_FAILED','原借出数量与归还流水不一致，须先核实实物库存',409);
        if (returnQuantity > outstandingForLoan) return fail('EXCESS_RETURN','本次归还超过原借出剩余数量。',409);
        const outstandingAllLoans = await activeBorrowQuantity(tx,item.id);
        const currentAvailable = Number(item.availableQty), totalQuantity = Number(item.quantity);
        if (!Number.isSafeInteger(currentAvailable) || !Number.isSafeInteger(totalQuantity) || currentAvailable < 0
          || totalQuantity !== currentAvailable + outstandingAllLoans || currentAvailable + returnQuantity > totalQuantity)
          return fail('VALIDATION_FAILED','归还数量与实物账不一致，须先核实实物库存',409);
        const newAvailable = currentAvailable + returnQuantity, nextReturned = returnedSoFar + returnQuantity, ts = Date.now();
        const event = { requestKey: typeof requestKey === 'string' ? requestKey : `${loanId}:return:${generateId('RET')}`,
          commandHash, quantity: returnQuantity, operatorId: actorId, returnedAt: String(ts), conditionNote: typeof note==='string'?note.trim().slice(0,500)||null:null };
        const updated = await tx.sampleCardLoan.update({
          where: { id: loanId },
          data: { returnedAt: nextReturned === originalQuantity ? ts : null, conditionNote: event.conditionNote,
            lengthReturnHistory: [...history,event] },
        });
        // v2：归还后恢复 availableQty；若 availableQty > 0 则 status = in_stock
        const newStatus = newAvailable > 0 ? 'in_stock' : item.status;
        const updatedItem = await tx.sampleCardItem.update({
          where: { id: loan.itemId },
          data: { availableQty: newAvailable, status: newStatus, updatedAt: ts },
        });
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'sample-room',
          operation: 'sample_card_return', targetType: 'SampleCardItem', targetId: loan.itemId,
          after: { loanId, overdue: loan.dueAt != null && Number(loan.dueAt) < businessNowMs(), ...event, returnedQuantity: nextReturned,
            outstandingQuantity: originalQuantity-nextReturned, availableAfter: newAvailable }, operationType: 'update', fieldPath: 'lengthReturnHistory',
        });
        return { ok: true, data: { loan: serializeLoan(updated), item: updatedItem, replayed:false } };
      });
    } catch (e: any) {
      const authorization = authorityFailure(e); if (authorization) return authorization;
      logger.error('[sample-room] returnLoan failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '归还登记失败', 500);
    }
  }

  // ── 低库存预警（v2 新增：availableQty <= minStock） ──
  async function listLowStock(limit = 100, actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500) return fail('INVALID_INPUT', 'limit 须为 0–500 的整数');
    try {
      actualActor(actor);
      const snapshot=await db.$transaction(async(tx:any)=>{
        const scanned=await scanCustody(tx,actor!,{deletedAt:null,status:{not:'retired'},minStock:{not:null}},[{availableQty:'asc'},{id:'desc'}],{limit,offset:0,lowStock:true});
        return {guards:scanned.guards,result:{ok:true as const,data:{items:scanned.selected.map(({card}:any)=>({...card,shortage:card.minStock-card.availableQty,severity:card.availableQty===0?'critical':'warning'})),total:scanned.total}}};
      },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:5000,timeout:30000});
      await finalRead(actor!,snapshot.guards);return snapshot.result;
    }catch(e:any){const authorization=authorityFailure(e);if(authorization)return authorization;logger.error('[sample-room] listLowStock failed',{error:e?.message});return fail('INTERNAL_ERROR','低库存预警查询失败',500);}
  }

  /** Explicit safe directory. It never emits legacy serializeItem, raw receipt,
   * parent identities, names for catalog entries, notes, or borrowing details. */
  async function listCustodyDirectory(filter:{lane?:unknown;search?:unknown;cardType?:unknown;limit?:unknown;offset?:unknown;filter?:unknown;sort?:unknown}={},actor?:TokenPayload):Promise<SampleRoomResult<any>> {
    try {
      actualActor(actor);
      if(Object.keys(filter).some(key=>!['lane','search','cardType','limit','offset','filter','sort'].includes(key)))return fail('INVALID_INPUT','实物目录筛选参数不合法。');
      const lane=filter.lane;
      if(!['fabric','garment','trim','other'].includes(lane as string))return fail('INVALID_INPUT','请明确选择实物分类。');
      const numeric=(v:unknown,fallback:number)=>v===undefined?fallback:typeof v==='number'||typeof v==='string'&&/^\d+$/.test(v)?Number(v):NaN;
      const limit=numeric(filter.limit,50),offset=numeric(filter.offset,0);
      if(!Number.isSafeInteger(limit)||limit<0||limit>100||!Number.isSafeInteger(offset)||offset<0)return fail('INVALID_INPUT','目录 limit 须为0至100，offset 须为非负安全整数。');
      if(filter.search!==undefined&&typeof filter.search!=='string'||filter.cardType!==undefined&&(typeof filter.cardType!=='string'||filter.cardType.length>80))return fail('INVALID_INPUT','编号搜索与物料类型须为不超过 80 字的文本。');
      const search=(filter.search as string|undefined)?.trim()||'',cardType=filter.cardType||'';
      let criteria;
      try{criteria=normalizeLibraryFilters(typeof filter.filter==='string'?JSON.parse(filter.filter):filter.filter);}catch(e:any){return fail('INVALID_INPUT',e.message||'样品筛选条件不合法。');}
      const sort=(filter.sort??'newest') as LibrarySort;
      if(!['newest','oldest','name','code','available_desc','available_asc'].includes(sort))return fail('INVALID_INPUT','样品排序不合法。');
      if(lane==='fabric'&&(sort==='available_desc'||sort==='available_asc'))return fail('INVALID_INPUT','面料档案包含不同计量单位，不能按一个库存总量混合排序。');
      const snapshot=await db.$transaction(async(tx:any)=>{
        const where:any={deletedAt:null};
        // Read all authorized candidates before facets, criteria and paging. Never derive facets from a page.
        const nowTs=Date.now(),scanned=await scanCustody(tx,actor!,where,[{createdAt:'desc'},{id:'desc'}],{lane,limit:Number.MAX_SAFE_INTEGER,offset:0,allowCatalog:true,directorySearch:search});
        const full=scanned.selected.filter(row=>row.visibility==='full');
        const unique=(values:any[])=>[...new Set(values.filter(value=>typeof value==='string'&&value))];
        const sampleIds=unique(full.map(row=>row.card.sampleId)),caseIds=unique(full.map(row=>row.card.devCaseId)),orderIds=unique(full.map(row=>row.card.orderId)),batchIds=unique(full.map(row=>row.card.batchId));
        const [samples,cases,orders,batches]=await Promise.all([
          sampleIds.length?tx.sample.findMany({where:{id:{in:sampleIds},deletedAt:null}}):[],
          caseIds.length?tx.developmentCase.findMany({where:{id:{in:caseIds},deletedAt:null}}):[],
          orderIds.length?tx.order.findMany({where:{id:{in:orderIds},deletedAt:null}}):[],
          batchIds.length&&tx.sampleBatch?.findMany?tx.sampleBatch.findMany({where:{id:{in:batchIds},deletedAt:null},select:{id:true,batchCode:true,sampleType:true,sampleVersionId:true,versionLabel:true}}):[]]);
        const map=(rows:any[])=>new Map<string,any>(rows.map(row=>[row.id,row]));
        const sm=map(samples),dc=map(cases),od=map(orders),bt=map(batches);
        const versionIds=unique(batches.map((batch:any)=>batch.sampleVersionId));
        const versions=versionIds.length&&tx.developmentSampleVersion?.findMany?await tx.developmentSampleVersion.findMany({where:{id:{in:versionIds},deletedAt:null},select:{id:true,versionLabel:true,developmentCaseId:true}}):[];
        const ver=map(versions);
        const assetIds=unique([...full.map(row=>row.card.productAssetId),...samples.map((sample:any)=>sample.productAssetId)]);
        const assets=assetIds.length?await tx.productAsset.findMany({where:{id:{in:assetIds},deletedAt:null},include:{fabricProfile:true,garmentProfile:true,compositionLines:{include:{term:true}},classificationLinks:{include:{classification:true}}}}):[];
        const pa=map(assets);
        const customerId=(c:any)=>c.customerRelationId??sm.get(c.sampleId)?.customerRelationId??dc.get(c.devCaseId)?.customerRelationId??od.get(c.orderId)?.customerRelationId??null;
        const customerIds=unique(full.map(row=>customerId(row.card))),warehouseIds=unique(full.map(row=>row.card.warehouseId));
        const [customers,warehouses]=await Promise.all([customerIds.length?tx.relation.findMany({where:{id:{in:customerIds},deletedAt:null},select:{id:true,name:true}}):[],warehouseIds.length?tx.warehouse.findMany({where:{id:{in:warehouseIds},deletedAt:null},select:{id:true,name:true}}):[]]);
        const cm=map(customers),wh=map(warehouses);
        const derive=(c:any)=>deriveLibraryMetadata(c,sm.get(c.sampleId),pa.get(c.productAssetId??sm.get(c.sampleId)?.productAssetId));
        const rows=scanned.selected.map((row:any)=>{
          if(row.visibility==='catalog')return row;
          const card=row.card,batch=bt.get(card.batchId),sample=sm.get(card.sampleId),productAsset=pa.get(card.productAssetId??sample?.productAssetId);
          const version=ver.get(batch?.sampleVersionId);
          return {...row,metadata:derive(card),customerId:customerId(card),batch,sample,productAsset,version,devCase:dc.get(card.devCaseId),order:od.get(card.orderId)};
        });
        const rowsById=new Map<string,any>(rows.filter((row:any)=>row.visibility==='full').map((row:any)=>[row.card.id,row]));
        const rawValues=(row:any,key:string):string[]=>{
          if(row.visibility==='catalog')return [];
          const c=row.card,m=row.metadata;
          const value=key==='customerRelationId'?row.customerId:key==='warehouseId'?c.warehouseId:key==='status'?c.status:key==='sealedStatus'?c.sealedStatus??'unsealed':m[key];
          return Array.isArray(value)?value:typeof value==='string'&&value?[value]:[];
        };
        const hasCriteria=Object.keys(criteria).length>0;
        const matchesRaw=(row:any)=>{
          if(row.visibility==='catalog')return !hasCriteria;
          if(cardType&&row.card.cardType!==cardType)return false;
          for(const key of LIBRARY_FILTER_KEYS){const selected=criteria[key];if(selected?.length&&!rawValues(row,key).some(value=>selected.includes(value)))return false;}
          const weight=row.metadata.weightGsm;
          if(criteria.weightMin!==undefined&&(weight===null||weight<criteria.weightMin))return false;
          if(criteria.weightMax!==undefined&&(weight===null||weight>criteria.weightMax))return false;
          return true;
        };
        const archives=lane==='fabric'?groupFabricArchiveRows(rows):null;
        const directoryRows=archives?archives.map(archive=>{
          const memberRows=archive.members.map(member=>rowsById.get(member.id)).filter(Boolean);
          const representative=memberRows[0]??rows.find((row:any)=>row.visibility==='catalog'&&row.card.code===archive.code);
          return {...representative,archive,archiveMemberRows:memberRows,id:archive.id};
        }):rows;
        const displaySearch=(row:any)=>{
          if(!search)return true;
          if(row.visibility==='catalog')return true; // Catalog rows were filtered only on public code/location inside scanCustody.
          const sourceRows=row.archive?row.archiveMemberRows:[row];
          const archiveFields=row.archive?[row.archive.name,row.archive.code,row.archive.sourceLabel,...row.archive.forms.map((form:any)=>form.kind)]:[];
          return [...archiveFields,...sourceRows.flatMap((item:any)=>[
            item.card.code,item.card.name,item.card.location,item.metadata?.category,item.metadata?.colorName,item.metadata?.colorCode,
            item.productAsset?.sku,item.productAsset?.name,item.batch?.batchCode,item.batch?.versionLabel,item.version?.versionLabel,
            item.devCase?.code,item.devCase?.name,item.sample?.code,item.sample?.name,item.order?.poNumber,item.order?.customer,
          ])].some(value=>typeof value==='string'&&value.toLocaleLowerCase('zh-CN').includes(search.toLocaleLowerCase('zh-CN')));
        };
        const rawMembers=(row:any)=>row.archive?row.archiveMemberRows:row.visibility==='catalog'?[]:[row];
        const values=(row:any,key:string):string[]=>Array.from(new Set<string>(rawMembers(row).flatMap((member:any)=>rawValues(member,key))));
        const facets:LibraryFacets={};
        for(const key of LIBRARY_FILTER_KEYS){const counts=new Map<string,number>();for(const row of directoryRows)for(const value of new Set(values(row,key)))counts.set(value,(counts.get(value)??0)+1);
          facets[key]=[...counts].map(([value,count])=>({value,count,label:key==='customerRelationId'?cm.get(value)?.name??value:key==='warehouseId'?wh.get(value)?.name??value:[...SAMPLE_PURPOSES,...SAMPLE_KINDS,...SAMPLE_SOURCES].find(option=>option.value===value)?.label??value})).sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'));}
        const matches=(row:any)=>{
          if(!displaySearch(row))return false;
          if(row.visibility==='catalog')return matchesRaw(row);
          if(row.archive)return row.archiveMemberRows.some((member:any)=>matchesRaw(member));
          return matchesRaw(row);
        };
        const filtered=directoryRows.filter(matches);
        filtered.sort((a:any,b:any)=>{let comparison=0;
          const aCard=a.card,bCard=b.card;
          if(sort==='newest'||sort==='oldest'){const aCreated=Number(a.archive?.createdAt??aCard.createdAt??0),bCreated=Number(b.archive?.createdAt??bCard.createdAt??0);comparison=(Number.isFinite(aCreated)?aCreated:0)<(Number.isFinite(bCreated)?bCreated:0)?-1:(Number.isFinite(aCreated)?aCreated:0)>(Number.isFinite(bCreated)?bCreated:0)?1:0;if(sort==='newest')comparison=-comparison;}
          else if(sort==='name')comparison=(a.archive?.name??aCard.name??'').localeCompare(b.archive?.name??bCard.name??'','zh-CN');
          else if(sort==='code')comparison=(a.archive?.code??aCard.code).localeCompare(b.archive?.code??bCard.code);
          else comparison=(aCard.availableQty-bCard.availableQty)*(sort==='available_desc'?-1:1);
          return comparison||(a.archive?.id??aCard.id).localeCompare(b.archive?.id??bCard.id);});
        const page=filtered.slice(offset,offset+limit);
        const physicalPageRows=page.flatMap((row:any)=>row.archive?row.archiveMemberRows:row.visibility==='full'?[row]:[]);
        const receiptStatuses=await directoryReceiptStatuses(tx,physicalPageRows);
        const serialize=(row:any)=>{
          const {card,context,visibility,metadata,customerId}=row;
          if(!Number.isSafeInteger(card.quantity)||card.quantity<0||!Number.isSafeInteger(card.availableQty)||card.availableQty<0||card.availableQty>card.quantity)throw Error('实物目录库存事实不完整');
          const safe={id:card.id,code:card.code,cardType:card.cardType,location:card.location??null,quantity:card.quantity,availableQty:card.availableQty,unit:card.unit??null};
          const businessContext={status:context.status,businessLine:context.businessLine??null,reasons:context.reasons};
          return visibility==='catalog'?{visibility,card:safe,businessContext}:{visibility,card:{...safe,name:card.name,status:card.status,physicalLengthQty:card.physicalLengthQty?.toString()??null,availableLengthQty:card.availableLengthQty?.toString()??null,locationDetail:normalizeLocationDetail(card.locationDetail)??null,photos:publicPhotoMetadata(card.id,card.photos),libraryMetadata:metadata,customerRelationId:customerId,customerName:cm.get(customerId)?.name??null,warehouseId:card.warehouseId??null,warehouseName:wh.get(card.warehouseId)?.name??null,sealedStatus:card.sealedStatus??'unsealed'},businessContext,receiptStatus:receiptStatuses.get(card.id)};
        };
        const items=page.map((row:any)=>{
          const serialized=serialize(row);
          if(!row.archive||row.visibility==='catalog')return serialized;
          return {...serialized,archive:{
            id:row.archive.id,identityKind:row.archive.identityKind,name:row.archive.name,code:row.archive.code,
            productAssetId:row.archive.productAssetId,developmentSampleVersionId:row.archive.developmentSampleVersionId,
            sourceLabel:row.archive.sourceLabel,forms:row.archive.forms,
            members:row.archive.members.map((member:any)=>({...member,receiptStatus:receiptStatuses.get(member.id)??'manual'})),
          }};
        });
        return {guards:scanned.guards,result:{ok:true as const,data:{directoryVersion:lane==='fabric'?4:3,lane,filters:{search,cardType},criteria,sort,facets,pagination:{limit,offset},snapshotAt:String(nowTs),total:filtered.length,items}}};
      },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:5000,timeout:30000});
      await finalRead(actor!,snapshot.guards);return snapshot.result;
    }catch(e:any){const authorization=authorityFailure(e);if(authorization)return authorization;logger.error('[sample-room] listCustodyDirectory failed',{error:e?.message});return fail('INTERNAL_ERROR','实物目录读取失败',500);}
  }

  // ── 借还流水列表（在借/逾期/历史/看样） ──
  async function listLoans(filter:{active?:boolean;overdue?:boolean;loanType?:string;itemId?:string;limit?:number}={},actor?:TokenPayload):Promise<SampleRoomResult<any>> {
    try {
      actualActor(actor);
      const limit=filter.limit===undefined?50:filter.limit;
      if(!Number.isSafeInteger(limit)||limit<0||limit>200)return fail('INVALID_INPUT','借还流水limit须为0至200。');
      const snapshot=await db.$transaction(async(tx:any)=>{
        await authorizeSampleCustodyBatch({db:tx,actor,subjects:[]});
        const where:any={};if(filter.active===true)where.returnedAt=null;if(filter.active===false)where.returnedAt={not:null};
        if(filter.loanType)where.loanType=filter.loanType;if(filter.itemId)where.itemId=filter.itemId;
        const loans:any[]=[],guards:SampleCustodyGuard[]=[],seen=new Set<string>(),nowTs=businessNowMs();let total=0,cursor:string|undefined;
        while(true){
          const rows=await tx.sampleCardLoan.findMany({where,orderBy:[{loanedAt:'desc'},{id:'desc'}],take:200,...(cursor?{cursor:{id:cursor},skip:1}:{})});
          if(!rows.length)break;
          const itemIds=[...new Set<string>(rows.map((row:any)=>row.itemId))];
          const permissions=await authorizeSampleCustodyBatch({db:tx,actor,subjects:itemIds.map(id=>({kind:'card',id})),historical:true});
          const allowed=new Map(permissions.filter((r:any)=>r.ok).map((r:any)=>[r.subject.id,r.authorization.guard]));
          for(const row of rows){if(!allowed.has(row.itemId))continue;const serialized=serializeLoanAt(row,nowTs);if(filter.overdue===true&&!serialized.overdue)continue;
            if(!seen.has(row.itemId)){seen.add(row.itemId);guards.push(allowed.get(row.itemId)!);}total++;if(loans.length<limit)loans.push(serialized);}
          cursor=rows[rows.length-1].id;if(rows.length<200)break;
        }
        const ids=[...new Set(loans.map(row=>row.itemId))],items=ids.length?await tx.sampleCardItem.findMany({where:{id:{in:ids}},select:{id:true,code:true,name:true}}):[];
        const byId=new Map(items.map((row:any)=>[row.id,row]));
        return {guards,result:{ok:true as const,data:{loans:loans.map(row=>({...row,item:byId.get(row.itemId)??null})),total}}};
      },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:5000,timeout:30000});
      await finalRead(actor!,snapshot.guards);return snapshot.result;
    }catch(e:any){const authorization=authorityFailure(e);if(authorization)return authorization;logger.error('[sample-room] listLoans failed',{error:e?.message});return fail('INTERNAL_ERROR','借还流水查询失败',500);}
  }

  // ── DR-054 阶段 C：寄出出样（ship）——寄出=扣减数量+终态归档，不可归还 ──
  // 与 borrow（可还）/viewing（即看即还）区分：寄往客户/外部后实物不在公司，终态。
  async function shipItem(itemId: string, input: { shipQuantity?: number; shipLength?: string; requestKey?: string; recipientName?: string; relationId?: string; dueAt?: number }, actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    try {
      const actorId = actualActor(actor).userId;
      return await db.$transaction(async (tx: any) => {
        const item = await authorizedCard(tx, itemId, actor!, input.relationId);
        if (!item) return fail('NOT_FOUND', `样卡 ${itemId} 不存在`, 404);
        if (isMeterCard(item)) return {ok:true as const,data:await moveMeterStock(tx,item,actorId,'ship',input)};
        if (input.shipLength !== undefined) return fail('VALIDATION_FAILED','按件样品不能提交米数。');
        const shipQuantity = input.shipQuantity;
        if (typeof shipQuantity !== 'number' || !Number.isSafeInteger(shipQuantity) || shipQuantity < 1 || shipQuantity > 2147483647)
          return fail('VALIDATION_FAILED', '件数样品寄出数量须为 1 至 2147483647 的明确整数。', 400);
        const command = await countedStockCommand(tx,item,actorId,'ship',input,shipQuantity);
        if(command.prior)return {ok:true as const,data:{loan:serializeLoan(command.prior),item,archived:item.status==='shipped',replayed:true}};
        if (item.status === 'retired') return fail('ITEM_RETIRED', '样卡已退役，不可寄出', 409);
        if (item.status === 'shipped') return fail('ITEM_SHIPPED', '样卡已全部寄出归档，不可再寄', 409);
        if (item.sealedStatus === 'sealed') return fail('SEALED_SAMPLE_SHIP_FORBIDDEN', '该实物是封样留存件，禁止永久寄出；请登记未封样的可寄实物。', 409);
        if (Number(item.availableQty) < shipQuantity) {
          return fail('INSUFFICIENT_QTY', `可用数量不足（剩余 ${item.availableQty}，寄出 ${shipQuantity}）`, 409);
        }
        const recipientName = command.name;
        const inLoanQty = await activeBorrowQuantity(tx, itemId);
        if (Number(item.quantity) !== Number(item.availableQty) + inLoanQty) {
          // Keep unexplained legacy discrepancies fail-closed; the MVP has no
          // inventory-count adjustment workflow.
          return fail('VALIDATION_FAILED', '实物总量与可用量、未还借用量不一致，系统不提供盘点修正；请线下核对后再登记', 409);
        }
        const ts = Date.now();
        const loan = await tx.sampleCardLoan.create({
          data: {
            id: command.id,
            meterRequestKey: command.requestKey,
            meterCommandHash: command.commandHash,
            itemId,
            loanType: 'ship',
            loanQuantity: shipQuantity,
            borrowerName: recipientName,
            borrowerUserId: null,
            relationId: input.relationId ? String(input.relationId) : null,
            relationName: null,
            loanedAt: ts,
            dueAt: command.dueAt,
            returnedAt: ts, // ship 终态：登记即归档（实物不在公司，不可归还）
            operatorId: actorId,
            createdAt: ts,
          },
        });
        const newQuantity = Number(item.quantity) - shipQuantity;
        const newAvailable = Number(item.availableQty) - shipQuantity;
        const archived = newQuantity === 0 && inLoanQty === 0;
        const updated = await tx.sampleCardItem.update({
          where: { id: itemId },
          data: {
            quantity: newQuantity,
            availableQty: newAvailable,
            status: archived ? 'shipped' : (newAvailable === 0 ? 'borrowed' : item.status),
            updatedAt: ts,
          },
        });
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'sample-room',
          operation: 'sample_card_ship', targetType: 'SampleCardItem', targetId: itemId,
          after: { code: item.code, loanId: loan.id, recipientName, shipQuantity, quantityAfter: newQuantity, availableAfter: newAvailable, archived }, operationType: 'link',
        });
        return { ok: true, data: { loan: serializeLoan(loan), item: updated, archived, replayed:false } };
      });
    } catch (e: any) {
      const authorization = authorityFailure(e); if (authorization) return authorization;
      logger.error('[sample-room] shipItem failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '寄出登记失败', 500);
    }
  }

  // ── DR-054 阶段 C：封样 = 实物级 tag（从确认批次选一实物基准，记录标准批次 reference） ──
  async function sealCard(id: string, input: { standardBatchNo?: string; notes?: string }, actor?: TokenPayload): Promise<SampleRoomResult<any>> {
    try {
      const actorId = actualActor(actor).userId;
      await authorizeSampleCustody({db,actor,subject:{kind:'card',id},mode:'write'});
      const original = await db.sampleCardItem.findFirst({ where: { id, deletedAt: null } });
      if (!original) return fail('NOT_FOUND', `样卡 ${id} 不存在`, 404);
      const terminalFailure = (item: any) => item.status === 'retired' ? fail('ITEM_RETIRED', '样卡已退役，不可封样', 409)
        : item.status === 'shipped' ? fail('ITEM_SHIPPED', '样卡已寄出归档，不可封样', 409)
        : item.sealedStatus === 'sealed' ? fail('ALREADY_SEALED', '该样卡已封样（不可重复封样）', 409) : null;
      const originalFailure = terminalFailure(original);
      if (originalFailure) return originalFailure;
      const references = (item: any) => JSON.stringify([item.warehouseId ?? null, item.devCaseId ?? null,
        item.orderId ?? null, item.productAssetId ?? null, item.sampleId ?? null, item.batchId ?? null]);
      const originalReferences = references(original);
      return await db.$transaction(async (tx: any) => {
        // Receipt and other source writers hold parents before the physical row.
        // Initial reads only discover those parents; they do not authorize a tag.
        const before = await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id},mode:'write'});
        const sources = await lockPhysicalSampleSources(tx, original, { allowBatch: true });
        const allowedParents = new Set([
          ...[['case',sources.devCaseId],['batch',sources.batchId],['order',sources.orderId],['asset',sources.productAssetId],['asset',sources.sampleProductAssetId],['warehouse',sources.warehouseId],['sample',sources.sampleId]].filter(([,value])=>value).map(([kind,value])=>`${kind}:${value}`),
          ...sources.relationIds.map(relationId=>`relation:${relationId}`)]);
        if(before.lockRefs.some(ref=>ref.kind!=='card'&&!allowedParents.has(`${ref.kind}:${ref.id}`)))throw new SampleCustodyAuthorizationError('SOURCE_CHANGED',409,'封样父图不完整，不会在实物锁后追锁新父。');
        const item = await lockCard(tx,id);
        const after = await authorizeSampleCustody({db:tx,actor,subject:{kind:'card',id},mode:'write'});
        assertSampleCustodyGuardStable(before.guard,after.guard);
        if (!item) return fail('NOT_FOUND', `样卡 ${id} 不存在`, 404);
        if (references(item) !== originalReferences) throw new PhysicalSampleSourceError('SOURCE_CHANGED', '实物的来源关联已变化，请刷新后重新封样');
        const currentFailure = terminalFailure(item);
        if (currentFailure) return currentFailure;
        const ts = Date.now();
        const standardBatchNo = (input.standardBatchNo ? String(input.standardBatchNo).trim() || null : null) ?? sources.batch?.batchCode ?? null;
        // This is a lot/row tag, not proof of one reserved physical piece. V1
        // receipts lack exact original round identity, so never promote the
        // current batch round into verified historical receipt evidence.
        const physicalSeal = {
          kind: 'lot-tag', itemId: item.id, itemCode: item.code,
          quantityAtSeal: item.quantity, availableAtSeal: item.availableQty, unitAtSeal: item.unit ?? null,
          physicalSource: sources.physicalSource, standardBatchReference: standardBatchNo,
          sourceVerification: sources.batchId ? 'legacyUnverified' : 'manual',
          observedBatch: sources.batch ? { id: sources.batch.id, caseId: sources.batch.developmentCaseId,
            batchCode: sources.batch.batchCode, currentRound: sources.batch.round ?? null,
            updatedAt: String(sources.batch.updatedAt) } : null,
          physicalSourceRound: null, reservationCreated: false, approvalChanged: false,
        };
        const updated = await tx.sampleCardItem.update({
          where: { id },
          data: { sealedStatus: 'sealed', sealedAt: ts, sealedBy: actorId, standardBatchNo,
            notes: input.notes ? String(input.notes).slice(0, 500) : item.notes, updatedAt: ts },
        });
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'sample-room',
          operation: 'sample_card_seal', targetType: 'SampleCardItem', targetId: id,
          after: { code: item.code, sealedStatus: 'sealed', standardBatchNo, physicalSeal }, operationType: 'update', fieldPath: 'sealedStatus',
        });
        return { ok: true, data: { item: updated, physicalSeal } };
      });
    } catch (e: any) {
      const authorization = authorityFailure(e); if (authorization) return authorization;
      if (e instanceof PhysicalSampleSourceError) return fail(e.code, e.message, e.status);
      logger.error('[sample-room] sealCard failed', { error: e?.message });
      return fail('INTERNAL_ERROR', '封样登记失败', 500);
    }
  }

  return { createItem, updateLibrary, appendItemPhotos, getItemPhoto, registerReceivedBatchCards, listItems, getItem, retireItem, createLoan, returnLoan, shipItem, sealCard, listLoans, listLowStock, listCustodyDirectory };
}
