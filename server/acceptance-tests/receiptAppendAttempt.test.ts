import { afterAll, beforeAll, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { appendReceiptAllocation } from '../src/finance/allocationMutationService';
import { claimReceipt } from '../src/finance/receiptClaimService';
import { createFinanceRouter } from '../src/finance/route';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { SYSTEM_ROLE_IDS } from '../src/_shared/rolePermissionMatrix';
import { logger } from '../src/lib/logger';

// Explicit private authorization is checked before either Prisma constructor.
function privateClients<T>(Client: new (o: any) => T, env = process.env): readonly [T,T] {
  const fail = () => { throw new Error('Explicit private receipt PG authorization required'); };
  const { DATABASE_URL: url, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_DIR: directory,
    BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_PORT: port, BAMBOOK_RECEIPT_DB_MARKER: marker } = env;
  try {
    if (env.DB_ENV !== 'acceptance-private' || env.NODE_ENV !== 'test' || env.BAMBOOK_NO_SCHEDULER !== '1'
      || env.BAMBOOK_ACCEPTANCE_NO_DATABASE !== '0' || !url || !sandbox || !directory || !name || !port || !marker
      || !/^bambook_acceptance_[a-f0-9]+$/.test(name) || !/^\d+$/.test(port) || Number(port)<1024 || Number(port)>65535) fail();
    const parsed = new URL(url!); const actualRoot = fs.realpathSync(sandbox!); const actualDirectory = fs.realpathSync(directory!);
    if (parsed.protocol!=='postgresql:' || parsed.hostname!=='127.0.0.1' || parsed.port!==port || parsed.username!=='acceptance'
      || parsed.password!=='' || parsed.pathname!==`/${name}` || parsed.search!=='?schema=public'
      || !actualRoot.startsWith('/private/tmp/bambook-append-receipt-fix-')
      || actualDirectory!==path.join(actualRoot, 'postgres')
      || marker!==path.join(actualRoot,'PRIVATE-PG-MARKER.json')) fail();
    const proof = JSON.parse(fs.readFileSync(marker!, 'utf8'));
    if (proof.authorized!==true || proof.root!==actualRoot || proof.directory!==actualDirectory || proof.name!==name || String(proof.port)!==port) fail();
    const guard=path.join(actualRoot,'workspace/scripts/acceptance-network-guard.cjs');
    if (!env.NODE_OPTIONS?.split(/\s+/).includes('--require='+guard)) fail();
    fs.realpathSync(guard);
    return [new Client({datasources:{db:{url:parsed.href}}}),new Client({datasources:{db:{url:parsed.href}}})];
  } catch { return fail(); }
}
const [a,b] = privateClients(PrismaClient);
const root=process.env.BAMBOOK_ACCEPTANCE_SANDBOX!;
const journal:any[]=[]; const actor='RAPP-actor'; let seq=0;
const safeMessage='核销未能保存，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对发票与凭证数据。';
const rollbackMessage='本次核销操作已完整回滚，未保存本次改动。请重新核对发票与凭证后再决定下一步。';
const receiptId=(actorId:string,key:string)=>'finance_claim_'+crypto.createHash('sha256').update(JSON.stringify([actorId,key])).digest('hex');
const safe=(result:any)=>{expect(result).toEqual({ok:false,error:{code:'CREATE_FAILED',message:safeMessage}});expect(JSON.stringify(result)).not.toMatch(/SECRET|SQL|P2002|P2034|P2010|未提交|并发/);};
beforeAll(async()=>{
  const rows:any[]=await a.$queryRawUnsafe("SELECT current_database() AS db,current_setting('data_directory') AS dir,inet_server_port() AS port");
  expect(rows).toEqual([{db:process.env.BAMBOOK_ACCEPTANCE_DB_NAME,dir:process.env.BAMBOOK_ACCEPTANCE_DB_DIR,port:Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT)}]);journal.push({identity:rows});
  await a.userAccount.create({data:{id:actor,displayName:'Private receipt finance',status:'active'}});
  await a.userAccount.create({data:{id:actor+'-other',displayName:'Private second actor',status:'active'}});
  await a.role.create({data:{id:SYSTEM_ROLE_IDS.FINANCE,name:'Finance'}});
  await a.permission.create({data:{id:'RAPP-permission',scope:'invoices:reconcile'}});
  await a.rolePermission.create({data:{id:'RAPP-rp',roleId:SYSTEM_ROLE_IDS.FINANCE,permissionId:'RAPP-permission'}});
  await a.userRole.create({data:{id:'RAPP-ur',userId:actor,roleId:SYSTEM_ROLE_IDS.FINANCE}});
});
afterAll(async()=>{fs.writeFileSync(path.join(root,'receipt-journal.json'),JSON.stringify(journal,(_k,v)=>typeof v==='bigint'?v.toString():v,2));await Promise.all([a.$disconnect(),b.$disconnect()]);});
async function fixture(suffix='case',amount=100){
 const id=`RAPP-${++seq}-${suffix}`;
 await a.invoice.create({data:{id:id+'-i',invoiceNumber:id+'-i',type:'Receivable',status:'Issued',amount,currency:'USD',issueDate:'2026-10-03',createdAt:BigInt(1),updatedAt:BigInt(1)}});
 await a.paymentVoucher.create({data:{id:id+'-v',voucherNumber:id+'-v',type:'Receipt',amount,currency:'USD',paymentDate:'2026-10-03',paymentMethod:'TT',createdAt:BigInt(1),updatedAt:BigInt(1)}});
 return {invoiceId:id+'-i',voucherId:id+'-v',actorId:actor,requestId:id,amount:20,validate:async(_tx:any)=>{},prisma:a};
}
async function facts(p:any){return {allocation:await b.invoiceAllocation.findUnique({where:{invoiceId_voucherId:{invoiceId:p.invoiceId,voucherId:p.voucherId}}}),invoice:await b.invoice.findUnique({where:{id:p.invoiceId}}),voucher:await b.paymentVoucher.findUnique({where:{id:p.voucherId}}),audits:await b.auditLog.findMany({where:{OR:[{id:receiptId(p.actorId,p.requestId)},{detail:{path:['after','invoiceId'],equals:p.invoiceId}}]}})};}
function adapter(tx:any,extra:any={}) {return new Proxy(a,{get(target,key){if(key==='$transaction')return tx;if(key in extra)return extra[key];return Reflect.get(target,key);}});}
const authentic=(error:any)=>({code:error.code,message:error.message,meta:error.meta});

it('RAPP01 private env/URL/marker must reject before any Prisma constructor or connection',()=>{
 for(const overrides of [{DB_ENV:undefined},{DATABASE_URL:undefined},{DATABASE_URL:'postgresql://acceptance@remote.invalid:5432/company?schema=public'},{BAMBOOK_RECEIPT_DB_MARKER:undefined},{BAMBOOK_NO_SCHEDULER:'0'},{BAMBOOK_ACCEPTANCE_DB_PORT:'5432'}]){
  let constructed=0; class Spy {constructor(_o:any){constructed++;}}
  expect(()=>privateClients(Spy,{...process.env,...overrides})).toThrow('Explicit private receipt PG authorization required');expect(constructed).toBe(0);
 }
});
it('RAPP02 actual 60 plus 40 delta reaches Paid and exact same receipt replays after settlement without another delta or audit',async()=>{
 const p=await fixture('sum');p.amount=60;const one=await appendReceiptAllocation(p);expect(one.ok).toBe(true);
 const two=await appendReceiptAllocation({...p,requestId:p.requestId+'-2',amount:40});expect(two.ok).toBe(true);expect(two.data!.allocation.appliedAmount).toBe('100');
 const prior=await facts(p);const replay=await appendReceiptAllocation({...p,requestId:p.requestId+'-2',amount:40});const after=await facts(p);
 expect(replay).toEqual({ok:true,data:{...two.data,replayed:true}});expect(after).toEqual(prior);expect(after.invoice!.status).toBe('Paid');expect(after.voucher!.status).toBe('reconciled');expect(after.allocation!.appliedAmount.toString()).toBe('100');
 expect(after.audits.filter(x=>x.action==='append_receipt_allocation')).toHaveLength(2);journal.push({kind:'sum-replay',one,two,replay,after});
});
it('RAPP03 genuine same actor request with different delta is original CONFLICT and zero further writes',async()=>{
 const p=await fixture('key');expect((await appendReceiptAllocation(p)).ok).toBe(true);const prior=await facts(p);
 const r=await appendReceiptAllocation({...p,amount:21});expect(r.error?.code).toBe('CONFLICT');expect(r.error?.message).toBe('此请求编号已用于不同核销内容，请先核对原请求结果');expect(await facts(p)).toEqual(prior);
});
it('RAPP04 actual claim factory keeps currency rejection tuple and no allocation/audits',async()=>{
 const p=await fixture('currency');await a.invoice.update({where:{id:p.invoiceId},data:{currency:'EUR'}});
 const r=await claimReceipt(a,{...p,visibleOrderIds:null});expect(r).toEqual({ok:false,error:{code:'CURRENCY_MISMATCH',message:'币种不一致（收款 USD / 发票 EUR），不做自动换算'}});expect((await facts(p)).allocation).toBeNull();expect((await facts(p)).audits).toHaveLength(0);
});
it.each(['P2002','P2034'])('RAPP05 public %s without a transaction invocation cannot certify rollback or concurrent retry',async code=>{
 const p=await fixture('fake-'+code);const r=await appendReceiptAllocation({...p,prisma:adapter(async()=>{throw {code,message:'SECRET SQL fake'};})});safe(r);expect((await facts(p)).allocation).toBeNull();
});
it.each(['claim','getter','proxy','cycle','bigint'])('RAPP06 unknown %s must be fixed safe500 without inspecting public error properties',async kind=>{
 const p=await fixture('unknown-'+kind);let reads=0;let e:any;
 if(kind==='claim')e={claimCode:'CURRENCY_MISMATCH',code:'CURRENCY_MISMATCH',statusCode:400,message:'SECRET SQL spoof'};
 if(kind==='getter')e=Object.defineProperties({},Object.fromEntries(['code','claimCode','message'].map(k=>[k,{get(){reads++;throw Error('SECRET getter');}}])));
 if(kind==='proxy')e=new Proxy({}, {get(){reads++;throw Error('SECRET proxy');}});
 if(kind==='cycle'){e={code:'P2034',message:'SECRET'};e.self=e;}
 if(kind==='bigint')e={code:'P2002',message:'SECRET',quantity:BigInt(1)};
 const r=await appendReceiptAllocation({...p,prisma:adapter(async()=>{throw e;})});safe(r);expect(reads).toBe(0);expect((await facts(p)).allocation).toBeNull();
});
it.each(['raw','model','nonconcurrent'])('RAPP07 actual append %s abort uses its own native xid and only accurately reports complete rollback',async kind=>{
 const p=await fixture('abort-'+kind);let error:any,xid='';const native=a.$transaction.bind(a);
 const tx=adapter((work:any,options:any)=>native(async t=>{
   xid=(await t.$queryRawUnsafe<Array<{xid:string}>>('SELECT pg_current_xact_id()::text AS xid'))[0]!.xid;
   return work(t);
 },options).catch(e=>{error=e;throw e;}));
 p.validate=async t=>{await t.invoice.findUnique({where:{id:p.invoiceId}});
  if(kind==='nonconcurrent')await t.$queryRawUnsafe('SELECT id FROM "PrivateReceiptMissingRelation"');
  else {await b.invoice.update({where:{id:p.invoiceId},data:{notes:'independent winner'}});
   if(kind==='raw')await t.$queryRawUnsafe('SELECT id FROM "Invoice" WHERE id=$1 FOR UPDATE',p.invoiceId);
   else await t.invoice.update({where:{id:p.invoiceId},data:{notes:'loser'}});}
 };
 const r=await appendReceiptAllocation({...p,prisma:tx});const state=(await b.$queryRawUnsafe<Array<{state:string}>>('SELECT pg_xact_status($1::xid8)::text AS state',xid))[0]!.state;
 expect(state).toBe('aborted');expect(error.code).toBe(kind==='model'?'P2034':'P2010');if(kind==='raw')expect(error.meta.code).toBe('40001');
 expect(r).toEqual({ok:false,error:{code:'CONFLICT',message:rollbackMessage}});expect((await facts(p)).allocation).toBeNull();expect((await facts(p)).audits).toHaveLength(0);journal.push({kind:'native-abort-'+kind,xid,state,error:authentic(error),r});
});
it.each(['core','receipt'])('RAPP08 actual mandatory %s audit failure is safe500 and rolls back original money/status/link writes',async kind=>{
 const p=await fixture('audit-'+kind);const native=a.$transaction.bind(a);let error:any,xid='';
 const r=await appendReceiptAllocation({...p,prisma:adapter((work:any,options:any)=>native(async t=>{
  xid=(await t.$queryRawUnsafe<Array<{xid:string}>>('SELECT pg_current_xact_id()::text AS xid'))[0]!.xid;
  const observed=new Proxy(t,{get(target,key){if(key!=='auditLog')return Reflect.get(target,key);return new Proxy(t.auditLog,{get(d,m){if(m!=='create')return Reflect.get(d,m);return (args:any)=>t.auditLog.create({data:{...args.data,...(args.data.action===(kind==='core'?'append_receipt_allocation':'finance.receipt.claim.request')?{actorId:'RAPP-absent-fk'}:{})}});}});}});
  return work(observed);
 },options).catch(e=>{error=e;throw e;}))});
 const f=await facts(p);safe(r);expect(error.code).toBe('P2003');expect(f.allocation).toBeNull();expect(f.invoice!.status).toBe('Issued');expect(f.voucher!.appliedAmount?.toString()??'0').toBe('0');expect(f.audits).toHaveLength(0);expect(await b.entityLink.count({where:{fromId:p.voucherId}})).toBe(0);journal.push({kind:'audit-failure-'+kind,xid,error:authentic(error),r,f});
});
it.each(['plain','same-constructor','mutated-return'])('RAPP09 actual committed append losing %s return restores only immutable original result plus exact two audits',async kind=>{
 const p=await fixture('commit-'+kind);const native=a.$transaction.bind(a);let original:any,pending:any,xid='';
 const tx=adapter(async(work:any,options:any)=>{await native(async t=>{xid=(await t.$queryRawUnsafe<Array<{xid:string}>>('SELECT pg_current_xact_id()::text AS xid'))[0]!.xid;pending=await work(t);original=JSON.parse(JSON.stringify(pending));return pending;},options);
  if(kind==='mutated-return')pending.allocation.appliedDate='2099-12-31';
  if(kind==='same-constructor')throw new Prisma.PrismaClientKnownRequestError('SECRET SQL known constructor after commit',{code:'P2034',clientVersion:Prisma.prismaVersion.client});
  throw Error('SECRET SQL lost committed return');});
 const r=await appendReceiptAllocation({...p,prisma:tx});expect(r).toEqual({ok:true,data:original});const f=await facts(p);expect(f.allocation!.appliedAmount.toString()).toBe('20');expect(f.invoice!.status).toBe('PartiallyPaid');expect(f.voucher!.appliedAmount!.toString()).toBe('20');expect(f.audits).toHaveLength(2);journal.push({kind:'commit-'+kind,xid,original,r,f});
});
it.each(['bad-receipt','bad-core','missing-core','state-fault','wrong-xid','missing-xid','audit-read-fault'])('RAPP10 committed loss with %s remains unknown500 without claiming no commit or reappending',async kind=>{
 const p=await fixture('bad-proof-'+kind);const native=a.$transaction.bind(a);let original:any;
 const extra:any={auditLog:{findUnique:async(args:any)=>{const row=await b.auditLog.findUnique(args);if(kind==='audit-read-fault')throw {code:'CONFLICT',message:'SECRET proof fake'};return row;}},$queryRawUnsafe:async(sql:string,...args:any[])=>{const rows:any[]=await b.$queryRawUnsafe(sql,...args);if(kind==='state-fault')throw Error('SECRET state lookup');return kind==='wrong-xid'?rows.map(row=>({...row,xid:'1'})):rows;}};
 const tx=adapter(async(work:any,options:any)=>{await native(async t=>{const observed=new Proxy(t,{get(target,k){if(k==='$queryRawUnsafe'&&kind==='missing-xid')return async(sql:string,...args:any[])=>{const rows=await t.$queryRawUnsafe(sql,...args);return sql==='SELECT pg_current_xact_id()::text AS xid'?[]:rows;};return Reflect.get(target,k);}});original=await work(observed);return original;},options);
  if(kind==='missing-core')await b.auditLog.delete({where:{id:original.auditId}});
  if(kind==='bad-core'){const row=await b.auditLog.findUniqueOrThrow({where:{id:original.auditId}});await b.auditLog.update({where:{id:row.id},data:{detail:{...(row.detail as any),after:{...(row.detail as any).after,appliedAmount:'999'}}}});}
  if(kind==='bad-receipt'){const row=await b.auditLog.findUniqueOrThrow({where:{id:receiptId(p.actorId,p.requestId)}});await b.auditLog.update({where:{id:row.id},data:{detail:{...(row.detail as any),delta:'999'}}});}
  throw {code:'P2034',message:'SECRET lost return'};
 },extra);
 const r=await appendReceiptAllocation({...p,prisma:tx});safe(r);const f=await facts(p);expect(f.allocation!.appliedAmount.toString()).toBe('20');expect(await b.invoiceAllocation.count({where:{invoiceId:p.invoiceId}})).toBe(1);journal.push({kind,original,r,f});
});
it('RAPP11 independent replay requires original core audit rather than a receipt fingerprint alone',async()=>{
 const p=await fixture('replay');const created=await appendReceiptAllocation(p);expect(created.ok).toBe(true);await b.auditLog.delete({where:{id:created.data!.auditId}});const prior=await facts(p);
 const r=await appendReceiptAllocation(p);safe(r);expect(await facts(p)).toEqual(prior);
});
it('RAPP12 same actor/key concurrent requests have one actual append and replay only the exact committed winner',async()=>{
 const p=await fixture('race');const [one,two]=await Promise.all([appendReceiptAllocation(p),appendReceiptAllocation({...p,prisma:b})]);expect(one.ok).toBe(true);expect(two.ok).toBe(true);expect([one.data!.replayed,two.data!.replayed].sort()).toEqual([false,true]);const f=await facts(p);expect(f.allocation!.appliedAmount.toString()).toBe('20');expect(f.audits).toHaveLength(2);journal.push({kind:'race',one,two,f});
});
it('RAPP13 postcommit notification and real logger failure cannot replace committed claim ACK or read unknown message',async()=>{
 const p=await fixture('notify');let reads=0;const e=new Proxy({}, {get(){reads++;throw Error('SECRET notification getter');}});const old=logger.warn;
 const observed=new Proxy(a,{get(target,k){if(k==='userRole')return {findMany:async()=>{throw e;}};return Reflect.get(target,k);}});
 (logger as any).warn=()=>{throw Error('SECRET logger crash');};try {const r=await claimReceipt(observed,{...p,visibleOrderIds:null});expect(r.ok).toBe(true);expect(reads).toBe(0);expect((await facts(p)).allocation!.appliedAmount.toString()).toBe('20');}finally{(logger as any).warn=old;}
});
function appFor(db:any=a,onDataChange?:any){const app=express();app.use(express.json());app.use(createAccountStatusGuard(db));app.use('/api',createAuthorizationSnapshotGuard({prisma:db,apiKeys:new Set()}));app.use('/api/v1/finance',createFinanceRouter({prisma:db,requireAuth:true,apiKeys:new Set(),onDataChange}));return app;}
const token=(extras:any={})=>jwt.sign({userId:actor,roles:['owner'],...extras},process.env.JWT_SECRET!);
it('RAPP14 actual HTTP preserves actual currency refusal but a storage spoof reaches fixed safe500',async()=>{
 const p=await fixture('http');await a.invoice.update({where:{id:p.invoiceId},data:{currency:'EUR'}});const body={invoiceId:p.invoiceId,voucherId:p.voucherId,amount:p.amount,requestId:p.requestId};
 const positive=await request(appFor()).post('/api/v1/finance/receipt-claims/claim').set('Authorization','Bearer '+token()).send(body);expect(positive.status).toBe(400);expect(positive.body.error.code).toBe('CURRENCY_MISMATCH');
 await a.invoice.update({where:{id:p.invoiceId},data:{currency:'USD'}});
 const negative=await request(appFor(a,()=>{throw {code:'CONFLICT',statusCode:409,message:'SECRET SQL HTTP spoof'};})).post('/api/v1/finance/receipt-claims/claim').set('Authorization','Bearer '+token()).send(body);expect(negative.status).toBe(500);expect(negative.body).toEqual({error:{code:'CLAIM_FAILED',message:'核销结果暂不可确认，请使用原请求重试并核对余额。'}});expect(JSON.stringify(negative.body)).not.toMatch(/SECRET|SQL/);expect((await facts(p)).allocation!.appliedAmount.toString()).toBe('20');journal.push({kind:'http',positive:positive.body,negative:negative.body});
});
it('RAPP15 actual HTTP current stored role revocation and signed empty ceiling deny stale owner JWT with zero writes',async()=>{
 const p=await fixture('auth');const body={invoiceId:p.invoiceId,voucherId:p.voucherId,amount:p.amount,requestId:p.requestId};const app=appFor();const prior=await facts(p);
 const ceiling=await request(app).post('/api/v1/finance/receipt-claims/claim').set('Authorization','Bearer '+token({permissionCeiling:[]})).send(body);expect(ceiling.status).toBe(403);
 await b.userRole.delete({where:{id:'RAPP-ur'}});try{const revoked=await request(app).post('/api/v1/finance/receipt-claims/claim').set('Authorization','Bearer '+token()).send(body);expect(revoked.status).toBe(403);expect(await facts(p)).toEqual(prior);}finally{await b.userRole.create({data:{id:'RAPP-ur',userId:actor,roleId:SYSTEM_ROLE_IDS.FINANCE}});}
});

it('RAPP16 original four-place delta and genuine third-party payment keep amount/status, original source audits and payer metadata',async()=>{
 const p=await fixture('third-party');p.amount=20.1234;
 await a.invoice.update({where:{id:p.invoiceId},data:{customerName:'Contract customer'}});
 await a.paymentVoucher.update({where:{id:p.voucherId},data:{customerName:'Actual payer'}});
 const r=await appendReceiptAllocation(p);expect(r.ok).toBe(true);expect(r.data!.allocation.appliedAmount).toBe('20.1234');expect(r.data!.thirdPartyPayment).toMatchObject({isThirdParty:true,basis:'name',payerName:'Actual payer',invoiceCustomerName:'Contract customer'});
 const f=await facts(p);expect(f.allocation!.appliedAmount.toString()).toBe('20.1234');expect(f.voucher!.appliedAmount!.toString()).toBe('20.1234');
 const third=await b.auditLog.findMany({where:{targetId:r.data!.allocation.id,action:'third_party_payment_detected'}});expect(third).toHaveLength(1);expect(third[0]!.detail).toMatchObject({source:'route:receipt:append',after:{payerName:'Actual payer',invoiceCustomerName:'Contract customer'}});journal.push({kind:'third-party-fourdp',r,f,third});
});
it('RAPP17 same textual key with a different actual actor remains a distinct original delta and receipt identity',async()=>{
 const p=await fixture('actors');const first=await appendReceiptAllocation(p);const second=await appendReceiptAllocation({...p,actorId:actor+'-other'});expect(first.ok).toBe(true);expect(second.ok).toBe(true);expect(second.data!.allocation.appliedAmount).toBe('40');
 const receipts=await b.auditLog.findMany({where:{id:{in:[receiptId(actor,p.requestId),receiptId(actor+'-other',p.requestId)]}}});expect(receipts).toHaveLength(2);expect(receipts.map(x=>x.actorId).sort()).toEqual([actor,actor+'-other']);expect((await facts(p)).allocation!.appliedAmount.toString()).toBe('40');
});
it('RAPP18 actual claim refusal fields mutated by transaction wrapper retain private original code/message rather than fake SQL tuple',async()=>{
 const p=await fixture('mutated-refusal');await a.invoice.update({where:{id:p.invoiceId},data:{currency:'EUR'}});const native=a.$transaction.bind(a);
 const db=adapter((work:any,options:any)=>native(work,options).catch(e=>{e.code='CONFLICT';e.claimCode='CONFLICT';e.message='SECRET SQL mutation';e.statusCode=409;throw e;}));
 const r=await claimReceipt(db,{...p,visibleOrderIds:null});expect(r).toEqual({ok:false,error:{code:'CURRENCY_MISMATCH',message:'币种不一致（收款 USD / 发票 EUR），不做自动换算'}});expect((await facts(p)).allocation).toBeNull();
});
it('RAPP19 proof reader cannot borrow a genuine refusal minted by another actual claim invocation',async()=>{
 const other=await fixture('borrow-origin');await a.invoice.update({where:{id:other.invoiceId},data:{currency:'EUR'}});const native=a.$transaction.bind(a);let borrowed:any;
 const source=adapter((work:any,options:any)=>native(work,options).catch(e=>{borrowed=e;throw e;}));expect((await claimReceipt(source,{...other,visibleOrderIds:null})).error?.code).toBe('CURRENCY_MISMATCH');expect(borrowed).toBeTruthy();
 const p=await fixture('borrow-target');p.validate=async tx=>{await tx.$queryRawUnsafe('SELECT id FROM "PrivateReceiptMissingRelation"');};
 const db=adapter((work:any,options:any)=>native(work,options),{$queryRawUnsafe:async()=>{throw borrowed;}});
 const r=await appendReceiptAllocation({...p,prisma:db});safe(r);expect((await facts(p)).allocation).toBeNull();
});
it.each(['actor','source','target','request','date','status','third-party','snapshot-ip'])('RAPP20 committed receipt/core %s mismatch cannot be used as original ACK evidence',async kind=>{
 const p=await fixture('tuple-'+kind);const native=a.$transaction.bind(a);let original:any;
 const db=adapter(async(work:any,options:any)=>{await native(async tx=>{original=await work(tx);return original;},options);
  const receipt=await b.auditLog.findUniqueOrThrow({where:{id:receiptId(p.actorId,p.requestId)}});const core=await b.auditLog.findUniqueOrThrow({where:{id:original.auditId}});
  if(kind==='actor')await b.auditLog.update({where:{id:core.id},data:{actorId:actor+'-other'}});
  if(kind==='source')await b.auditLog.update({where:{id:core.id},data:{detail:{...(core.detail as any),source:'other:unrelated'}}});
  if(kind==='target')await b.auditLog.update({where:{id:receipt.id},data:{targetId:'wrong-target'}});
  if(kind==='request')await b.auditLog.update({where:{id:receipt.id},data:{detail:{...(receipt.detail as any),requestId:'other-key'}}});
  if(kind==='date'||kind==='status'||kind==='third-party'){
   const detail=receipt.detail as any;const result={...detail.result};
   if(kind==='date')result.allocation={...result.allocation,appliedDate:'2099-12-31'};
   if(kind==='status')result.newInvoiceStatus='Paid';
   if(kind==='third-party')result.thirdPartyPayment={isThirdParty:true,basis:'name',payerRelationId:null,payerName:'unrelated',invoiceCustomerRelationId:null,invoiceCustomerName:'unrelated',message:'unrelated'};
   await b.auditLog.update({where:{id:receipt.id},data:{detail:{...detail,result}}});
  }
  if(kind==='snapshot-ip')await b.auditLog.update({where:{id:receipt.id},data:{ip:'127.0.0.99'}});
  throw Error('SECRET lost commit return');});
 const r=await appendReceiptAllocation({...p,prisma:db});safe(r);expect((await facts(p)).allocation!.appliedAmount.toString()).toBe('20');journal.push({kind:'tuple-'+kind,original,r});
});

it('RAPP21 callback never entered may recover only the original two-audit committed receipt with exact actor/key after Paid',async()=>{
 const p=await fixture('historical-proof');p.amount=100;const first=await appendReceiptAllocation(p);expect(first.ok).toBe(true);let entered=0,reads=0;
 const e=new Proxy({}, {get(){reads++;throw Error('SECRET unknown error getter');}});
 const db=adapter(async()=>{entered++;throw e;});const prior=await facts(p);const r=await appendReceiptAllocation({...p,prisma:db});expect(r).toEqual({ok:true,data:{...first.data,replayed:true}});expect(entered).toBe(1);expect(reads).toBe(0);expect(await facts(p)).toEqual(prior);expect(prior.invoice!.status).toBe('Paid');journal.push({kind:'historical-not-entered',first,r,prior});
});
it.each(['actor','key','target','core-missing','proof-fault'])('RAPP22 callback never entered %s cannot borrow a historical ACK',async kind=>{
 const p=await fixture('historical-negative-'+kind);const first=await appendReceiptAllocation(p);expect(first.ok).toBe(true);const native=a.$transaction.bind(a);let q={...p};
 if(kind==='actor')q.actorId=actor+'-other';if(kind==='key')q.requestId+='-other';if(kind==='target'){const other=await fixture('foreign-target');q.invoiceId=other.invoiceId;}
 if(kind==='core-missing')await b.auditLog.delete({where:{id:first.data!.auditId}});
 const extra=kind==='proof-fault'?{auditLog:{findUnique:async()=>{throw {claimCode:'CURRENCY_MISMATCH',message:'SECRET proof SQL'};}}}:{};
 const prior=await facts(p);const r=await appendReceiptAllocation({...q,prisma:adapter(async()=>{throw {code:'P2002',message:'SECRET no callback'};},extra)});safe(r);expect(await facts(p)).toEqual(prior);
});
it('RAPP23 actual HTTP retry after a callback-never-entered storage fault returns original committed ACK with zero new money or audits',async()=>{
 const p=await fixture('http-historical');p.amount=100;const body={invoiceId:p.invoiceId,voucherId:p.voucherId,amount:p.amount,requestId:p.requestId};const auth='Bearer '+token();
 const first=await request(appFor()).post('/api/v1/finance/receipt-claims/claim').set('Authorization',auth).send(body);expect(first.status).toBe(201);const prior=await facts(p);
 const db=adapter(async()=>{throw {code:'P2034',message:'SECRET before callback'};});const retry=await request(appFor(db)).post('/api/v1/finance/receipt-claims/claim').set('Authorization',auth).send(body);expect(retry.status).toBe(201);expect(retry.body).toEqual(first.body);expect(await facts(p)).toEqual(prior);journal.push({kind:'http-historical',first:first.body,retry:retry.body,prior});
});

it.each(['core-source','core-actor','core-target','receipt-delta','receipt-actor','receipt-action'])('RAPP24 a prior persisted %s mismatch is unknown500 before any new delta, not a historical ACK',async kind=>{
 const p=await fixture('prior-'+kind);const first=await appendReceiptAllocation(p);expect(first.ok).toBe(true);
 const row=await b.auditLog.findUniqueOrThrow({where:{id:kind.startsWith('core')?first.data!.auditId:receiptId(p.actorId,p.requestId)}});
 if(kind==='core-source')await b.auditLog.update({where:{id:row.id},data:{detail:{...(row.detail as any),source:'other:unrelated'}}});
 if(kind.endsWith('actor'))await b.auditLog.update({where:{id:row.id},data:{actorId:actor+'-other'}});
 if(kind==='core-target')await b.auditLog.update({where:{id:row.id},data:{targetId:'foreign-target'}});
 if(kind==='receipt-delta')await b.auditLog.update({where:{id:row.id},data:{detail:{...(row.detail as any),delta:'999'}}});
 if(kind==='receipt-action')await b.auditLog.update({where:{id:row.id},data:{action:'other:unrelated'}});
 const prior=await facts(p);const r=await appendReceiptAllocation(p);safe(r);expect(await facts(p)).toEqual(prior);journal.push({kind:'prior-'+kind,r,prior});
});

it('RAPP25 outer error replacement cannot borrow another genuine claim refusal instead of this own proven unknown-cause rollback',async()=>{
 const source=await fixture('borrow-outer-origin');await a.invoice.update({where:{id:source.invoiceId},data:{currency:'EUR'}});const native=a.$transaction.bind(a);let borrowed:any;
 const sourceDb=adapter((work:any,options:any)=>native(work,options).catch(error=>{borrowed=error;throw error;}));expect((await claimReceipt(sourceDb,{...source,visibleOrderIds:null})).error?.code).toBe('CURRENCY_MISMATCH');
 const p=await fixture('borrow-outer-target');p.validate=async tx=>{await tx.$queryRawUnsafe('SELECT id FROM "PrivateReceiptMissingRelation"');};
 const db=adapter((work:any,options:any)=>native(work,options).catch(()=>{throw borrowed;}));const r=await appendReceiptAllocation({...p,prisma:db});expect(r).toEqual({ok:false,error:{code:'CONFLICT',message:rollbackMessage}});expect((await facts(p)).allocation).toBeNull();journal.push({kind:'borrow-outer',r});
});
it('RAPP26 actual HTTP current Sales with an explicit reconcile grant cannot use stale owner roles to see an invoice outside current parent L2',async()=>{
 const p=await fixture('http-l2');const sales='RAPP-current-sales';await a.userAccount.create({data:{id:sales,displayName:'Private current Sales',status:'active'}});
 await a.role.create({data:{id:SYSTEM_ROLE_IDS.SALES,name:'Sales'}});await a.userRole.create({data:{id:'RAPP-sales-role',userId:sales,roleId:SYSTEM_ROLE_IDS.SALES}});
 await a.userPermissionOverrides.create({data:{id:'RAPP-sales-reconcile',userId:sales,scope:'invoices:reconcile',grantedBy:actor,reason:'Explicit private boundary control'}});
 const prior=await facts(p);const signed=jwt.sign({userId:sales,roles:['owner']},process.env.JWT_SECRET!);
 const response=await request(appFor()).post('/api/v1/finance/receipt-claims/claim').set('Authorization','Bearer '+signed).send({invoiceId:p.invoiceId,voucherId:p.voucherId,amount:p.amount,requestId:p.requestId,actorId:actor});expect(response.status).toBe(404);expect(response.body.error.code).toBe('INVOICE_NOT_VISIBLE');expect(await facts(p)).toEqual(prior);journal.push({kind:'http-current-L2',response:response.body,prior});
});

it.each(['foreign','proxy'])('RAPP27 actual committed %s successful return is bound to this original immutable ACK and both audits',async kind=>{
 const p=await fixture('successful-return-'+kind);const native=a.$transaction.bind(a);let original:any;let allocationReads=0;
 const db=adapter(async(work:any,options:any)=>{
  const pending=await native(async tx=>{const value=await work(tx);original=JSON.parse(JSON.stringify(value));return value;},options);
  if(kind==='foreign')return {...pending,allocation:{...pending.allocation,id:'FOREIGN-UNKNOWN'}};
  return new Proxy(pending,{get(target,key){if(key==='allocation'){allocationReads++;throw Error('SECRET returned allocation getter');}return Reflect.get(target,key);},ownKeys(){throw Error('SECRET returned ownKeys');}});
 });
 const r=await appendReceiptAllocation({...p,prisma:db});expect(r).toEqual({ok:true,data:original});expect(allocationReads).toBe(0);const f=await facts(p);expect(f.allocation!.id).toBe(original.allocation.id);expect(f.allocation!.appliedAmount.toString()).toBe('20');expect(f.audits).toHaveLength(2);journal.push({kind:'normal-return-'+kind,original,r,f});
});
