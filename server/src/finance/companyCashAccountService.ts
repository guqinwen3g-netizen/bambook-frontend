/** Company cash is an immutable bank ledger, separate from invoice allocation. */
import {Prisma} from '@prisma/client';
import type {TokenPayload} from '../auth/service';
import {hasScope} from '../auth/permissionService';
import {createFinanceSourceAccess} from './financeSourceAccess';
import {ciHash,ciJson} from '../development/developmentCiSource';
import {businessError} from '../shared/errorCodes';
import {writeRouteAuditLog} from '../audit/routeAudit';
import {randomUUID} from 'node:crypto';
import { isValidLocalDateKey } from '../shared/localDate';


type Actor=TokenPayload|null|undefined;
export type CashAccountCreateInput={requestKey:string;name:string;companyName:string;companyRelationId?:string;currency:string;
  bankName:string;accountName:string;accountNumberMasked:string;branch?:string;ownerId?:string;teamId?:string;departmentId?:string;allowedUserIds:string[]};
export type CashAccountCommandInput={requestKey:string;expectedRevision:number;action:'update'|'opening'|'correction';
  changes?:Partial<Omit<CashAccountCreateInput,'requestKey'|'currency'>> & {status?:'Active'|'Archived'};
  amount?:string;currency?:string;occurredDate?:string;bankReference?:string;evidenceNote?:string;reason?:string;correctsEntryId?:string};
export type CashVoucherInput={companyAccountId?:string;expectedAccountRevision?:number;actualAccountAmount?:string|number;
  bankReference?:string;evidenceNote?:string};
const text=(value:unknown,label:string)=>{if(typeof value!=='string'||!value.trim())throw businessError('INVALID_INPUT',`请填写${label}。`);return value.trim();};
export function cashDate(value:unknown){if(!isValidLocalDateKey(value))throw businessError('INVALID_INPUT','请填写真实有效的资金发生日期。');return value;}
export function cashAmount(value:unknown,opening=false){if(!['string','number'].includes(typeof value)||!(opening?/^-?\d+(?:\.\d{1,4})?$/:/^\d+(?:\.\d{1,4})?$/).test(String(value)))
  throw businessError('INVALID_INPUT','资金金额须为最多四位小数的明确十进制数。');
  const amount=new Prisma.Decimal(String(value));if(!amount.isFinite()||amount.abs().gte('100000000000000')||!opening&&amount.lte(0))throw businessError('INVALID_INPUT','资金金额超出合法范围。');return amount;}
function proof(input:{bankReference?:string;evidenceNote?:string}){const bankReference=input.bankReference?.trim()||null,evidenceNote=input.evidenceNote?.trim()||null;
  if(!bankReference&&!evidenceNote)throw businessError('INVALID_INPUT','登记真实资金必须有银行流水号或核实证据。');return {bankReference,evidenceNote};}
async function context(tx:any,prior:Actor,write=false,management=false){const access=await createFinanceSourceAccess(tx,prior,[write?'vouchers:write':'vouchers:read']);
  if(management&&!hasScope(access.actor,'users:admin'))throw businessError('FORBIDDEN','账户创建、归属与使用名单须由当前财务配置管理能力维护。');return access;}
function within(access:Awaited<ReturnType<typeof context>>,row:any){return !!row&&access.ownerAllowed(row.ownerId)&&(!row.teamId||access.teamAllowed(row.teamId));}
function usable(access:Awaited<ReturnType<typeof context>>,row:any){return within(access,row)&&Array.isArray(row.allowedUserIds)&&row.allowedUserIds.includes(access.actor.userId);}
function exactVoucherEntry(account:any,voucher:any,entry:any){
  if(!entry||!voucher||voucher.companyAccountId!==account.id||voucher.cashEntryId!==entry.id||entry.sourceVoucherId!==voucher.id
    ||entry.accountId!==account.id||entry.currency!==account.currency||voucher.currency!==account.currency||entry.occurredDate!==voucher.paymentDate)return false;
  const snapshot=entry.evidence?.sourceSnapshot;
  return (voucher.type==='Receipt'?['Receipt','CorrectionIn']:voucher.type==='Disbursement'?['Payment','CorrectionOut']:[]).includes(entry.kind)
    &&snapshot?.voucherId===voucher.id&&snapshot?.voucherAmount===new Prisma.Decimal(voucher.amount).toFixed(4)
    &&snapshot?.bankFee===new Prisma.Decimal(voucher.bankFee??0).toFixed(4)&&snapshot?.accountAmount===new Prisma.Decimal(entry.amount).toFixed(4)
    &&snapshot?.paymentMethod===voucher.paymentMethod&&snapshot?.paymentDate===voucher.paymentDate&&snapshot?.currency===voucher.currency;
}
async function lockAccount(tx:any,id:string){await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CompanyCashAccount" WHERE "id"=${id} FOR UPDATE`);
  return tx.companyCashAccount.findUnique({where:{id}});}
function requireUse(access:Awaited<ReturnType<typeof context>>,row:any,active=false){if(!usable(access,row))throw businessError('NOT_FOUND','公司账户不存在或不在当前账户使用范围。');
  if(active&&row.status!=='Active')throw businessError('CONFLICT','该账户已归档，不能登记新的资金事实。');}
function requireRevision(row:any,value:unknown){if(!Number.isSafeInteger(value)||value!==row.revision)throw businessError('CONFLICT','公司账户版本已变化，请重新核对；未知结果请重试原请求。');}
async function validateAssignment(tx:any,access:Awaited<ReturnType<typeof context>>,data:any){
  if(data.ownerId){const owner=await tx.userAccount.findFirst({where:{id:data.ownerId,status:'active',deletedAt:null}});if(!owner||!access.ownerAllowed(owner.id))throw businessError('NOT_FOUND','账户负责人不在当前管理范围。');}
  if(data.teamId){if(!await tx.team.findFirst({where:{id:data.teamId,deletedAt:null}})||!access.teamAllowed(data.teamId))throw businessError('NOT_FOUND','账户小组不存在或不在当前管理范围。');}
  if(data.departmentId&&!await tx.department.findFirst({where:{id:data.departmentId,status:'active'}}))throw businessError('NOT_FOUND','账户目录部门不存在。');
  if(data.companyRelationId&&!await tx.relation.findFirst({where:{id:data.companyRelationId,isOrganization:true,deletedAt:null}}))throw businessError('NOT_FOUND','明确我方主体档案不存在。');
  if(!Array.isArray(data.allowedUserIds)||new Set(data.allowedUserIds).size!==data.allowedUserIds.length||data.allowedUserIds.some((id:any)=>typeof id!=='string'||!id))throw businessError('INVALID_INPUT','请明确账户使用账号名单。');
  for(const id of data.allowedUserIds)if(!await tx.userAccount.findFirst({where:{id,status:'active',deletedAt:null}}))throw businessError('NOT_FOUND','账户名单包含已失效账号。');
}
async function beginCommand(tx:any,access:Awaited<ReturnType<typeof context>>,operation:string,input:any){
  if(typeof input.requestKey!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestKey))throw businessError('INVALID_INPUT','请保留真实资金操作的 UUID 原请求键。');
  const commandHash=ciHash({kind:operation,input}),id=`CASHCMD_${ciHash({actorId:access.actor.userId,operation,requestKey:input.requestKey})}`;
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))::text AS "lock"`);
  const prior=await tx.cashAccountCommandReceipt.findUnique({where:{id}});
  if(prior){if(prior.actorId!==access.actor.userId||prior.operation!==operation||prior.commandHash!==commandHash)throw businessError('CONFLICT','该原请求键已对应另一资金命令。');return {replayed:true,receipt:prior.receipt,commit:async(_value:any)=>{throw businessError('CONFLICT','原命令已完成。');}};}
  return {replayed:false,receipt:null,commit:async(value:any)=>{const resultSnapshot=ciJson(value),accountId=value.account.id;
    const receipt=ciJson({...value,financeCommand:{protocolVersion:1,actorId:access.actor.userId,kind:operation,requestKey:input.requestKey,
      commandHash,auditId:value.auditId,targetId:accountId,resultSnapshot,resultHash:ciHash(resultSnapshot)}});
    await tx.cashAccountCommandReceipt.create({data:{id,actorId:access.actor.userId,operation,requestKey:input.requestKey,commandHash,accountId,receipt,createdAt:BigInt(Date.now())}});return receipt;}};
}
async function bump(tx:any,row:any){const updated=await tx.companyCashAccount.updateMany({where:{id:row.id,revision:row.revision},data:{revision:row.revision+1,updatedAt:BigInt(Date.now())}});
  if(updated.count!==1)throw businessError('CONFLICT','账户在资金登记中变化，请核对原请求结果。');return tx.companyCashAccount.findUnique({where:{id:row.id}});}
async function append(tx:any,access:Awaited<ReturnType<typeof context>>,account:any,input:any){
  const entries=await tx.cashAccountEntry.findMany({where:{accountId:account.id},orderBy:{sequence:'asc'}});
  const opening=entries.find((entry:any)=>entry.kind==='Opening');
  if(input.kind==='Opening'){
    if(opening)throw businessError('CONFLICT','真实期初已登记，不能覆写；差异须追加准确纠正事实。');
    if(entries.some((entry:any)=>entry.occurredDate<input.occurredDate))throw businessError('CONFLICT','期初日期晚于已登记实际流水，不能用当前银行余额重算旧流水。');
  }else if(opening&&input.occurredDate<opening.occurredDate)throw businessError('CONFLICT','该真实流水早于已核实期初，请先核对原期初包含范围。');
  const entry=await tx.cashAccountEntry.create({data:{id:`CASH_${randomUUID()}`,accountId:account.id,sequence:entries.reduce((max:number,row:any)=>Math.max(max,row.sequence),0)+1,
    ...input,currency:account.currency,postedBy:access.actor.userId,postedAt:BigInt(Date.now())}});
  const updated=await bump(tx,account);return {entry,account:updated};
}

/** Both the cash-only command and the native CN bank-return producer share the
 * original account lock and remaining actual-bank capacity. Historical CN
 * returns that reused an existing Receipt count once, never as a second cash. */
export async function assertCashCorrectionCapacity(tx:any,actor:Actor,accountId:string,originalId:string,amount:Prisma.Decimal,occurredDate:string){
  const access=await context(tx,actor,true),account=await lockAccount(tx,accountId);requireUse(access,account,true);
  const original=await tx.cashAccountEntry.findUnique({where:{id:originalId}});
  if(!original||original.accountId!==account.id||original.currency!==account.currency||!['Receipt','Payment'].includes(original.kind)||occurredDate<original.occurredDate)
    throw businessError('CONFLICT','请引用同一账户/币种的准确原始收付，日期不能早于原项。');
  if(original.sourceVoucherId){const voucher=await tx.paymentVoucher.findUnique({where:{id:original.sourceVoucherId}});
    if(!exactVoucherEntry(account,voucher,original)||!await access.voucher({...voucher,deletedAt:null}))throw businessError('NOT_FOUND','原资金来源不可访问。');}
  const corrections=await tx.cashAccountEntry.findMany({where:{correctsEntryId:original.id}});
  let total=corrections.reduce((sum:Prisma.Decimal,row:any)=>sum.plus(row.amount),new Prisma.Decimal(0));
  if(original.kind==='Payment'&&original.sourceVoucherId){
    for(const returned of await tx.creditNoteRefundReturn.findMany({where:{sourcePaymentVoucherId:original.sourceVoucherId}})){
      const receipt=await tx.paymentVoucher.findUnique({where:{id:returned.receiptVoucherId}}),entry=receipt?.cashEntryId&&await tx.cashAccountEntry.findUnique({where:{id:receipt.cashEntryId}});
      if(!exactVoucherEntry(account,receipt,entry)||!new Prisma.Decimal(entry.amount).equals(returned.receivedNet))throw businessError('CONFLICT','原付款的银行返款账户来源尚未核实。');
      if(entry.kind==='Receipt')total=total.plus(returned.receivedNet);
      else if(entry.kind!=='CorrectionIn'||entry.correctsEntryId!==original.id)throw businessError('CONFLICT','原付款的返款纠正来源不一致。');
    }
  }
  if(total.plus(amount).gt(original.amount))throw businessError('CONFLICT','累计实际退回/退款超过原银行金额。');
  await access.finish({deletedVoucherIds:original.sourceVoucherId?[original.sourceVoucherId]:[]});
  return {account,original,kind:original.kind==='Payment'?'CorrectionIn':'CorrectionOut'};
}

/** A visible subset is never passed off as the complete bank ledger. */
async function projection(tx:any,access:Awaited<ReturnType<typeof context>>,account:any){
  const entries=await tx.cashAccountEntry.findMany({where:{accountId:account.id},orderBy:{sequence:'asc'}});let sourcesAvailable=true;
  for(const entry of entries)if(entry.sourceVoucherId){const row=await tx.paymentVoucher.findUnique({where:{id:entry.sourceVoucherId}});
    if(!exactVoucherEntry(account,row,entry)||!await access.voucher({...row,deletedAt:null})){sourcesAvailable=false;break;}}
  const opening=entries.find((entry:any)=>entry.kind==='Opening'),recorded=entries.reduce((sum:Prisma.Decimal,row:any)=>sum.plus(row.signedAmount),new Prisma.Decimal(0));
  // Unassigned bank facts after an Opening may belong to this account. Their
  // absence is not zero; no historical assignment is invented.
  const unassigned=opening?await tx.paymentVoucher.count({where:{companyAccountId:null,paymentDate:{gte:opening.occurredDate}}}):null;
  const reason=!sourcesAvailable?'当前来源范围不能完整核实该账户流水。':!opening?'真实期初尚未核实。':unassigned?'期初当日及以后仍有旧资金未归属，完整余额尚未核实。':null;
  const value=ciJson({account,opening:sourcesAvailable?opening:null,balance:reason?null:recorded.toFixed(4),
    recordedBalance:sourcesAvailable&&opening?recorded.toFixed(4):null,recordedNetMovement:sourcesAvailable?entries.filter((e:any)=>e.kind!=='Opening').reduce((sum:Prisma.Decimal,e:any)=>sum.plus(e.signedAmount),new Prisma.Decimal(0)).toFixed(4):null,
    balanceStatus:reason?'unknown':'verified',balanceReason:reason,negative:reason?null:recorded.lt(0),sourcesAvailable,entries:sourcesAvailable?entries:null});
  return {value,historicalVoucherIds:entries.filter((entry:any)=>!!entry.sourceVoucherId).map((entry:any)=>entry.sourceVoucherId)};
}
export async function listCompanyCashAccounts(params:{prisma:any;actor?:Actor}){
  return params.prisma.$transaction(async(tx:any)=>{
    const access=await context(tx,params.actor),manager=hasScope(access.actor,'users:admin');
    const accounts=await tx.companyCashAccount.findMany({orderBy:{createdAt:'asc'}}),items=[],historicalVoucherIds:string[]=[];
    for(const candidate of accounts){
      if(!within(access,candidate))continue;
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CompanyCashAccount" WHERE "id"=${candidate.id} FOR SHARE`);
      const row=await tx.companyCashAccount.findUnique({where:{id:candidate.id}});
      if(usable(access,row)){const projected=await projection(tx,access,row);items.push(projected.value);historicalVoucherIds.push(...projected.historicalVoucherIds);}else if(manager&&within(access,row))items.push(ciJson({account:row,balance:null,recordedBalance:null,balanceStatus:'unknown',balanceReason:'当前账号不在账户使用名单，不能读取银行流水。',entries:null,sourcesAvailable:false}));
    }
    await access.finish({deletedVoucherIds:historicalVoucherIds});return {items};
  });
}
export async function getCompanyCashAccount(params:{prisma:any;actor?:Actor;accountId:string}){
  return params.prisma.$transaction(async(tx:any)=>{
    const access=await context(tx,params.actor);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CompanyCashAccount" WHERE "id"=${params.accountId} FOR SHARE`);
    const account=await tx.companyCashAccount.findUnique({where:{id:params.accountId}});
    requireUse(access,account);const result=await projection(tx,access,account);await access.finish({deletedVoucherIds:result.historicalVoucherIds});return result.value;
  });
}
export async function createCompanyCashAccount(params:{prisma:any;actor?:Actor;input:CashAccountCreateInput}){
  return params.prisma.$transaction(async(tx:any)=>{const access=await context(tx,params.actor,true,true),input=params.input;
    const command=await beginCommand(tx,access,'cash_account.create',input);
    if(command.replayed){const row=await tx.companyCashAccount.findUnique({where:{id:command.receipt.account.id}});if(!within(access,row))throw businessError('NOT_FOUND','原账户不在当前管理范围。');await access.finish();return {...command.receipt,replayed:true};}
    if(!/^[A-Z]{3}$/.test(input.currency))throw businessError('INVALID_INPUT','账户须有明确固定币种。');
    const data={name:text(input.name,'账户名称'),companyName:text(input.companyName,'我方主体抬头'),companyRelationId:input.companyRelationId?.trim()||null,
      currency:input.currency,bankName:text(input.bankName,'实际开户银行'),accountName:text(input.accountName,'实际户名'),accountNumberMasked:text(input.accountNumberMasked,'账号展示信息'),
      branch:input.branch?.trim()||null,ownerId:input.ownerId?.trim()||null,teamId:input.teamId?.trim()||null,departmentId:input.departmentId?.trim()||null,allowedUserIds:input.allowedUserIds};
    await validateAssignment(tx,access,data);
    if(!within(access,data))throw businessError('NOT_FOUND','账户归属不在当前财务管理范围。');
    const account=await tx.companyCashAccount.create({data:{id:`CACC_${randomUUID()}`,...data,status:'Active',revision:1,createdBy:access.actor.userId,createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});
    const auditId=await writeRouteAuditLog({prisma:tx,actorId:access.actor.userId,source:'service:cash-account',operation:'create_company_cash_account',targetType:'CompanyCashAccount',targetId:account.id,after:ciJson(account),transactionId:input.requestKey});
    await access.finish();return {...await command.commit({account,auditId}),replayed:false};});
}
export async function commandCompanyCashAccount(params:{prisma:any;actor?:Actor;accountId:string;input:CashAccountCommandInput}){
  return params.prisma.$transaction(async(tx:any)=>{const input=params.input,management=input.action==='update',access=await context(tx,params.actor,true,management);
    const kind=`cash_account.${input.action}`,command=await beginCommand(tx,access,kind,{...input,accountId:params.accountId}),account=await lockAccount(tx,params.accountId);
    if(management){if(!within(access,account))throw businessError('NOT_FOUND','账户不在当前管理范围。');}else requireUse(access,account,!command.replayed);
    if(command.replayed){await access.finish();return {...command.receipt,replayed:true};}requireRevision(account,input.expectedRevision);
    let result:any;
    if(input.action==='update'){
      const patch=input.changes||{},allowed=new Set(['name','companyName','companyRelationId','bankName','accountName','accountNumberMasked','branch','ownerId','teamId','departmentId','allowedUserIds','status']);
      if(Object.keys(patch).some(k=>!allowed.has(k)))throw businessError('INVALID_INPUT','账户币种与资金历史不可修改。');
      const proposed={...account,...patch};for(const field of ['name','companyName','bankName','accountName','accountNumberMasked'])proposed[field]=text(proposed[field],'账户资料');
      if(!['Active','Archived'].includes(proposed.status))throw businessError('INVALID_INPUT','账户状态无效。');await validateAssignment(tx,access,proposed);
      if(!within(access,proposed))throw businessError('NOT_FOUND','调整后的账户归属不在当前财务管理范围。');
      const changed=Object.fromEntries([...allowed].filter(k=>k in patch).map(k=>[k,proposed[k]]));
      const updated=await tx.companyCashAccount.updateMany({where:{id:account.id,revision:account.revision},data:{...changed,revision:account.revision+1,updatedAt:BigInt(Date.now())}});
      if(updated.count!==1)throw businessError('CONFLICT','账户配置已变化。');result={account:await tx.companyCashAccount.findUnique({where:{id:account.id}})};
    }else if(input.action==='opening'||input.action==='correction'){
      if(input.currency!==account.currency)throw businessError('CONFLICT','真实资金币种须与固定账户一致，不能隐式换汇。');
      const evidence=proof(input),occurredDate=cashDate(input.occurredDate),amount=cashAmount(input.amount,input.action==='opening');let kind='Opening',correctsEntryId:string|null=null;
      if(input.action==='correction'){
        const checked=await assertCashCorrectionCapacity(tx,access.actor,account.id,input.correctsEntryId||'',amount,occurredDate);
        kind=checked.kind;correctsEntryId=checked.original.id;text(input.reason,'实际纠正原因');
      }
      result=await append(tx,access,account,{kind,amount,signedAmount:kind==='CorrectionOut'?amount.negated():amount,occurredDate,
        sourceVoucherId:null,correctsEntryId,evidence,reason:input.reason?.trim()||null});
    }else throw businessError('INVALID_INPUT','请选择明确的账户动作。');
    const auditId=await writeRouteAuditLog({prisma:tx,actorId:access.actor.userId,source:'service:cash-account',operation:kind,targetType:'CompanyCashAccount',targetId:account.id,
      before:ciJson(account),after:ciJson(result),transactionId:input.requestKey});await access.finish();return {...await command.commit({...result,auditId}),replayed:false};});
}

/** Canonical voucher producer calls this inside the same transaction, after
 * creating the voucher but before exposing it or committing its receipt. */
export async function assertVoucherCashUse(tx:any,actor:Actor,voucher:any){
  if(!voucher.companyAccountId&&!voucher.cashEntryId)return; // historical unassigned facts remain historical
  const access=await context(tx,actor,true);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CompanyCashAccount" WHERE "id"=${voucher.companyAccountId} FOR SHARE`);
  const account=await tx.companyCashAccount.findUnique({where:{id:voucher.companyAccountId}});requireUse(access,account);
  const entry=await tx.cashAccountEntry.findUnique({where:{id:voucher.cashEntryId||''}});
  if(!exactVoucherEntry(account,voucher,entry))
    throw businessError('CONFLICT','原收付款与实际账户来源不完整，请核实原银行事实。');
  await access.finish();
}
export async function postVoucherCashEntry(tx:any,actor:Actor,voucher:any,input:CashVoucherInput,correctionSource?:{entryId:string}){
  const access=await context(tx,actor,true),account=await lockAccount(tx,text(input.companyAccountId,'实际公司账户'));requireUse(access,account,true);requireRevision(account,input.expectedAccountRevision);
  if(voucher.currency!==account.currency)throw businessError('CONFLICT','实际账户币种与收付款不一致，不能隐式换汇。');
  if(voucher.cashEntryId||voucher.companyAccountId||await tx.cashAccountEntry.findUnique({where:{sourceVoucherId:voucher.id}}))throw businessError('CONFLICT','该收付已登记资金来源，不可重复入账。');
  if(!await access.voucher(voucher))throw businessError('NOT_FOUND','资金凭证原来源不可访问。');
  const fee=new Prisma.Decimal(voucher.bankFee??0),amount=input.actualAccountAmount==null?cashAmount(voucher.amount.toString()):cashAmount(input.actualAccountAmount,true);
  if(amount.lt(0))throw businessError('INVALID_INPUT','实际银行净额不能为负数，请选择准确方向。');
  if(fee.gt(0)&&(input.actualAccountAmount==null||!voucher.feeBearer))throw businessError('INVALID_INPUT','有手续费时须明确真实银行净额与费用承担方。');
  if(fee.isZero()&&!amount.equals(voucher.amount))throw businessError('CONFLICT','无手续费收付的银行金额与凭证实际金额不一致。');
  const evidence=proof(input),direction=voucher.type==='Receipt'?'Receipt':voucher.type==='Disbursement'?'Payment':null;
  let kind:string|null=direction,correctsEntryId:string|null=null;
  if(correctionSource){
    const checked=await assertCashCorrectionCapacity(tx,access.actor,account.id,correctionSource.entryId,amount,cashDate(voucher.paymentDate));
    if((direction==='Receipt')!==(checked.kind==='CorrectionIn'))throw businessError('CONFLICT','实际退回/退款方向与原收付不一致。');
    kind=checked.kind;correctsEntryId=checked.original.id;
  }
  if(!kind)throw businessError('CONFLICT','真实银行方向无效。');
  const result=await append(tx,access,account,{kind,amount,signedAmount:kind==='Payment'||kind==='CorrectionOut'?amount.negated():amount,occurredDate:cashDate(voucher.paymentDate),sourceVoucherId:voucher.id,correctsEntryId,
    evidence:{...evidence,sourceSnapshot:{voucherId:voucher.id,voucherAmount:new Prisma.Decimal(voucher.amount).toFixed(4),bankFee:fee.toFixed(4),feeBearer:voucher.feeBearer??null,
      accountAmount:amount.toFixed(4),currency:voucher.currency,paymentMethod:voucher.paymentMethod,paymentDate:voucher.paymentDate}},reason:null});
  const linked=await tx.paymentVoucher.updateMany({where:{id:voucher.id,companyAccountId:null,cashEntryId:null},data:{companyAccountId:account.id,cashEntryId:result.entry.id}});
  if(linked.count!==1)throw businessError('CONFLICT','资金凭证来源在登记中变化。');await access.finish();
  return {voucher:await tx.paymentVoucher.findUnique({where:{id:voucher.id}}),...result};
}
