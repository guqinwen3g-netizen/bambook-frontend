import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { parseNonNegativeDecimal } from '../shared/moneyInput';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createBillingItemInTx } from '../finance/billingItemService';
import { bindDevelopmentBillingCoverageInTx } from './developmentBillingCoverageService';
import { assertDevelopmentExpenseReviewCurrentInTx } from './developmentClosureService';
import type { TokenPayload } from '../auth/service';
import { authorizeDevelopmentCiCase, ciConflict, ciHash, ciJson } from './developmentCiSource';
import { readDevelopmentUncoveredCostsInTx, SUPPLEMENTAL_BILLING_ACTION, supplementalBillingAuditId } from './developmentCiCostSelection';
import { randomUUID } from 'node:crypto';
import { businessError } from '../shared/errorCodes';
function reject(code:string,message:string,status=409):never{throw Object.assign(new Error(message),{code,status,httpStatus:status,statusCode:status});}
function text(value:unknown,label:string,max=4000){if(typeof value!=='string'||!value.trim()||value.trim().length>max)reject('INVALID_INPUT',`${label}未填写或过长`,400);return value.trim();}
function money(value:unknown,label:string){const parsed=parseNonNegativeDecimal(value,label);if(!parsed.ok)reject('INVALID_AMOUNT',parsed.message,400);const d=new Prisma.Decimal(parsed.value);if(d.decimalPlaces()>4||d.gte('100000000000000')||!new Prisma.Decimal(d.toNumber()).eq(d))reject('INVALID_AMOUNT',`${label}精度超出支持范围`,400);return d;}
export async function createDevelopmentBillingDraft(context:{prisma:any;actorId:string;authorize:(tx:any,caseId:string)=>Promise<unknown>},caseId:string,input:{reviewId?:string;requestKey:string;amount:unknown;waivedAmount:unknown;currency:string;note:string}){
 text(context.actorId,'操作人',200);text(caseId,'开发案',200);
 const reviewId=input.reviewId==null?null:text(input.reviewId,'核齐记录',200),requestKey=text(input.requestKey,'请求标识',200),note=text(input.note,'收费或减免依据');
 const amount=money(input.amount,'拟收金额'),waived=money(input.waivedAmount,'减免金额');
 if(waived.gt(amount))reject('INVALID_AMOUNT','减免不能超过拟收金额',400);
 if(!['CNY','USD'].includes(input.currency))reject('INVALID_CURRENCY','请选择人民币或美元',400);
 const normalized={reviewId,amount:amount.toString(),waivedAmount:waived.toString(),currency:input.currency,note};
 const fingerprint=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
 const transactionId=`development-billing:${createHash('sha256').update(JSON.stringify([caseId,requestKey])).digest('hex')}`;
 return context.prisma.$transaction(async(tx:any)=>{
  await context.authorize(tx,caseId);
  const locked=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  if(!locked.length)reject('NOT_FOUND','开发案不存在',404);
  await context.authorize(tx,caseId);
  const prior=await tx.auditLog.findFirst({where:{transactionId,action:'create_development_billing_draft',targetType:'BillingItem'}});
  if(prior){
   if(prior.detail?.after?.fingerprint!==fingerprint)reject('REQUEST_CONFLICT','原请求标识已用于不同收费内容');
   const billingItem=await tx.billingItem.findFirst({where:{id:prior.targetId,sourceType:'DevelopmentCase',sourceId:caseId,deletedAt:null}});
   if(!billingItem)reject('BILLING_NOT_FOUND','原收费记录不可用，请核实原请求');
   return {billingItem,recovered:true};
  }
  const existing=await tx.billingItem.findFirst({where:{sourceType:'DevelopmentCase',sourceId:caseId,chargeType:'development_fee',deletedAt:null,status:{not:'cancelled'}}});
  if(existing)reject('CASE_ALREADY_BILLED','本案已有收费方案，请从原记录继续处理');
  if(reviewId)await assertDevelopmentExpenseReviewCurrentInTx(tx,caseId,reviewId);
  const development=await tx.developmentCase.findFirst({where:{id:caseId,deletedAt:null}});
  if(!development?.customerRelationId)reject('CUSTOMER_REQUIRED','请先关联本案客户，再建立对客收费');
  const draft=await createBillingItemInTx(tx,{actorId:context.actorId,input:{sourceType:'DevelopmentCase',sourceId:caseId,chargeType:'development_fee',amount:amount.toNumber(),waivedAmount:waived.toNumber(),currency:input.currency,bearerType:'customer',bearerRelationId:development.customerRelationId,notes:note}});
  await tx.billingItem.update({where:{id:draft.id},data:{developmentWorkflowState:'draft'}});
  if(reviewId)await bindDevelopmentBillingCoverageInTx(tx,{...context,authorize:(inner:any,id:string)=>context.authorize(inner,id)},{caseId,billingItemId:draft.id,reviewId});
  await writeRouteAuditLog({prisma:tx,actorId:context.actorId,source:'development:billing',operation:'create_development_billing_draft',targetType:'BillingItem',targetId:draft.id,transactionId,after:{caseId,fingerprint,...normalized}});
  return {billingItem:await tx.billingItem.findUnique({where:{id:draft.id}}),recovered:false};
 });
}

export type DevelopmentSupplementalBillingCommand = { requestKey: string; expectedSourceFingerprint: string; costRecordIds: string[];
 amount: unknown; waivedAmount: unknown; currency: string; note: string };
type SupplementContext = { prisma: any; actor: TokenPayload | null | undefined };
function supplementalText(value: unknown, label: string, max = 4000) {
 if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw businessError('INVALID_INPUT', `${label}未填写或过长。`);
 return value.trim();
}
function supplementalMoney(value: unknown, label: string) {
 const parsed = parseNonNegativeDecimal(value, label);
 if (!parsed.ok) throw businessError('INVALID_AMOUNT', parsed.message);
 const amount = new Prisma.Decimal(parsed.value);
 if (amount.decimalPlaces() > 4 || amount.gte('100000000000000') || !new Prisma.Decimal(amount.toNumber()).eq(amount))
  throw businessError('INVALID_AMOUNT', `${label}精度或范围无效。`);
 return amount;
}

export async function previewDevelopmentSupplementalBilling(context: SupplementContext, caseId: string) {
 return context.prisma.$transaction(async (tx: any) => {
  const access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-read');
  const result = await readDevelopmentUncoveredCostsInTx(tx, caseId, access.customer.id);
  await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-read');
  return { ...result, canSupplement: result.issued.length > 0 };
 });
}

/** Explicit disjoint cost selection reserves only those true facts. A second CI never rewrites the first. */
export async function createDevelopmentSupplementalBillingDraft(context: SupplementContext, caseId: string, input: DevelopmentSupplementalBillingCommand) {
 if (!input || !Array.isArray(input.costRecordIds) || !input.costRecordIds.length || input.costRecordIds.length > 500
  || input.costRecordIds.some(id => typeof id !== 'string' || !id.trim() || id.trim().length > 200)) ciConflict('请选择本案尚未覆盖的准确费用。');
 const ids = input.costRecordIds.map(id => id.trim()).sort();
 if (new Set(ids).size !== ids.length) ciConflict('费用选择不得重复。');
 const requestKey = supplementalText(input.requestKey, '请求标识', 200), expectedSourceFingerprint = supplementalText(input.expectedSourceFingerprint, '费用范围指纹', 64);
 if (!/^[a-f0-9]{64}$/.test(expectedSourceFingerprint)) ciConflict('请刷新本案尚未覆盖的费用范围。');
 const amount = supplementalMoney(input.amount, '拟收金额'), waived = supplementalMoney(input.waivedAmount, '减免金额'), note = supplementalText(input.note, '补充收费依据');
 if (waived.gte(amount) || !['CNY', 'USD'].includes(input.currency)) ciConflict('补充 CI 须有明确币种与正数对客净额，减免不得覆盖全部拟收。');
 const command = { requestKey, expectedSourceFingerprint, costRecordIds: ids, amount: amount.toFixed(4),
  waivedAmount: waived.toFixed(4), currency: input.currency, note };
 const commandHash = ciHash(command);
 return context.prisma.$transaction(async (tx: any) => {
  let access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
  const cases = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  if (!cases.length) ciConflict('开发案已变化，请刷新。');
  access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
  const auditId = supplementalBillingAuditId(caseId, access.actor.userId, requestKey);
  const prior = await tx.auditLog.findUnique({ where: { id: auditId } });
  if (prior) {
   const receipt = prior.detail?.receipt;
   if (prior.action !== SUPPLEMENTAL_BILLING_ACTION || prior.actorId !== access.actor.userId || prior.targetType !== 'BillingItem'
    || receipt?.caseId !== caseId || receipt.actorId !== access.actor.userId || receipt.requestKey !== requestKey
    || receipt.commandHash !== commandHash || receipt.auditId !== auditId || prior.targetId !== receipt.billingItemId)
    ciConflict('原请求已用于另一补充收费，不能替换原内容。');
   const billingItem = await tx.billingItem.findFirst({ where: { id: receipt.billingItemId, sourceType: 'DevelopmentCase', sourceId: caseId, deletedAt: null } });
   if (!billingItem) ciConflict('原补充收费事实无法核验，请核对原请求。');
   await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
   return { receipt, billingItem: ciJson(billingItem), replayed: true };
  }
  const hinted = await readDevelopmentUncoveredCostsInTx(tx, caseId, access.customer.id);
  if (!hinted.issued.length) ciConflict('本案尚无已签发 CI，请先从原收费方案开具首票。');
  if (hinted.sourceFingerprint !== expectedSourceFingerprint) ciConflict('费用或预留范围已变化，请刷新后重新选择。');
  if (ids.some(id => !hinted.costs.some((row: any) => row.id === id))) ciConflict('所选费用属于其他案或已被收费/原票覆盖，不能重复收费。');
  for (const id of ids) {
   await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${id} AND "deletedAt" IS NULL FOR UPDATE`);
   await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItemCostCoverage" WHERE "costRecordId"=${id} ORDER BY "id" FOR UPDATE`);
  }
  access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
  const current = await readDevelopmentUncoveredCostsInTx(tx, caseId, access.customer.id);
  if (current.sourceFingerprint !== expectedSourceFingerprint || ids.some(id => !current.costs.some((row: any) => row.id === id)))
   ciConflict('费用或预留范围在取得锁时变化，请刷新。');
  const records = current.costs.filter((row: any) => ids.includes(row.id));
  const draft = await createBillingItemInTx(tx, { actorId: access.actor.userId, trustedActor: access.actor,
   input: { sourceType: 'DevelopmentCase', sourceId: caseId, chargeType: 'development_fee', amount: amount.toNumber(), waivedAmount: waived.toNumber(),
    currency: input.currency, bearerType: 'customer', bearerRelationId: access.customer.id, notes: note } });
  const billingItem = await tx.billingItem.update({ where: { id: draft.id }, data: { developmentWorkflowState: 'business_ci_draft' } });
  const now = BigInt(Date.now());
  for (const record of records) await tx.billingItemCostCoverage.create({ data: { id: randomUUID(), billingItemId: draft.id,
   costRecordId: record.id, costAmount: new Prisma.Decimal(record.amount), costCurrency: record.currency,
   submissionVersion: billingItem.developmentWorkflowVersion, createdAt: now } });
  const receipt = { operation: SUPPLEMENTAL_BILLING_ACTION, actorId: access.actor.userId, caseId, billingItemId: draft.id,
   requestKey, commandHash, auditId, expectedSourceFingerprint, costRecordIds: ids };
  await tx.auditLog.create({ data: { id: auditId, action: SUPPLEMENTAL_BILLING_ACTION, actorId: access.actor.userId,
   targetType: 'BillingItem', targetId: draft.id, transactionId: requestKey, detail: ciJson({ receipt, command,
    selection: { caseId, billingItemId: draft.id, costs: records, costFingerprint: ciHash(records), precedingIssued: current.issued } }) } });
  await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
  return { receipt, billingItem: ciJson(billingItem), replayed: false };
 }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: any) => {
  if (error?.code === 'P2034' || error?.meta?.code === '40001') ciConflict('费用范围刚被另一操作更新，本次补充收费未提交，请刷新后核对。');
  throw error;
 });
}
