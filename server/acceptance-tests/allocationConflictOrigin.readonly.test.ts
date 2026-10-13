import { createPrivateAllocationClients } from './allocationPrivatePgHarness';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { createAllocation, updateAllocation, deleteAllocation } from '../src/finance/allocationMutationService';
const [a, b] = createPrivateAllocationClients(PrismaClient);
const root=process.env.BAMBOOK_ACCEPTANCE_SANDBOX!;
const journal:any[]=[];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const id=(s:string)=>`NCO-${s}`;
const proof=(e:any)=>({prototype:Object.getPrototypeOf(e).constructor.name,ownKeys:Object.getOwnPropertyNames(e),descriptors:Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(e)).map(([k,v])=>[k,{...v,value:typeof v.value==='bigint'?String(v.value):v.value}])),stack:e.stack});
beforeAll(async()=>{
 const rows:any[]=await a.$queryRawUnsafe("SELECT current_database() AS db,current_setting('data_directory') AS dir,inet_server_port() AS port");
 expect(rows[0]).toEqual({db:process.env.BAMBOOK_ACCEPTANCE_DB_NAME,dir:process.env.BAMBOOK_ACCEPTANCE_DB_DIR,port:Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT)});
 for(const s of ['raw','model','service','committed','ack'])await a.invoice.create({data:{id:id(s),invoiceNumber:id(s),type:'Receivable',status:'Issued',amount:100,currency:'USD',issueDate:'2026-10-03',createdAt:1n,updatedAt:1n}});
 await a.userAccount.create({data:{id:id('actor'),displayName:'Synthetic allocation actor'}});
 await a.paymentVoucher.create({data:{id:id('voucher'),voucherNumber:id('voucher'),type:'Receipt',amount:100,currency:'USD',paymentDate:'2026-10-03',paymentMethod:'TT',createdAt:1n,updatedAt:1n}});
 journal.push({identity:rows});
});
afterAll(async()=>{fs.writeFileSync(path.join(root,'native-origin-journal.json'),JSON.stringify(journal,(_key,value)=>typeof value==='bigint'?String(value):value,2));await Promise.all([a.$disconnect(),b.$disconnect()]);});
async function conflict(kind:'raw'|'model'){
 const observed=deferred(),committed=deferred();let error:unknown,entered=false,ended=false;
 let xid='';
 const pending=a.$transaction(async tx=>{
  xid=(await tx.$queryRawUnsafe<Array<{xid:string}>>('SELECT pg_current_xact_id()::text AS xid'))[0]!.xid;entered=true;await tx.invoice.findUnique({where:{id:id(kind)}});observed.resolve();await committed.promise;
  if(kind==='raw')await tx.$queryRawUnsafe('SELECT id FROM "Invoice" WHERE id=$1 FOR UPDATE',id(kind));
  else await tx.invoice.update({where:{id:id(kind)},data:{notes:'loser'}});
  ended=true;
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable}).catch(e=>{error=e;});
 await observed.promise;await b.invoice.update({where:{id:id(kind)},data:{notes:'winner'}});committed.resolve();await pending;
 const state=(await b.$queryRawUnsafe<Array<{state:string}>>('SELECT pg_xact_status($1::xid8)::text AS state',xid))[0]!.state;expect(state).toBe('aborted');
 journal.push({kind,xid,state,entered,ended,error:proof(error),after:await b.invoice.findUnique({where:{id:id(kind)}})});
 return error as any;
}
it('native raw SELECT FOR UPDATE serialization conflict is actual P2010/40001 and loses its entire transaction',async()=>{
 const error=await conflict('raw');expect(error.code).toBe('P2010');expect(error.meta.code).toBe('40001');expect((await b.invoice.findUniqueOrThrow({where:{id:id('raw')}})).notes).toBe('winner');
});
it('native model update serialization conflict is actual P2034 and loses its entire transaction',async()=>{
 const error=await conflict('model');expect(error.code).toBe('P2034');expect((await b.invoice.findUniqueOrThrow({where:{id:id('model')}})).notes).toBe('winner');
});
it('actual allocation native transaction retains the real serializable raw conflict409 with no allocation or audit write',async()=>{
 const observed=deferred(),committed=deferred();let error:unknown,entered=false,ended=false;
 const native=a.$transaction.bind(a);
 const adapter:any={$queryRawUnsafe:b.$queryRawUnsafe.bind(b),auditLog:b.auditLog,$transaction:(work:any,options:any)=>native(async tx=>{
  entered=true;const raw=tx.$queryRawUnsafe.bind(tx);
  const observedTx=new Proxy(tx,{get(t,k){if(k==='$queryRawUnsafe')return async(sql:string,...args:any[])=>{const rows=await raw(sql,...args);if(String(sql).startsWith('SELECT * FROM "MaterialReturn"')){observed.resolve();await committed.promise;}return rows;};return Reflect.get(t,k);}});
  const result=await work(observedTx);ended=true;return result;
 },options).catch(e=>{error=e;throw e;})};
 const resultPromise=createAllocation({prisma:adapter,input:{invoiceId:id('service'),voucherId:'unused',appliedAmount:'20'}});
 await observed.promise;await b.invoice.update({where:{id:id('service')},data:{notes:'winner'}});committed.resolve();const result=await resultPromise;
 const counts={allocations:await b.invoiceAllocation.count(),audits:await b.auditLog.count()};
 journal.push({kind:'service',entered,ended,error:proof(error),result,counts});
 expect((error as any).code).toBe('P2010');expect((error as any).meta.code).toBe('40001');expect(result).toEqual({ok:false,error:{code:'CONFLICT',message:'本次核销操作已完整回滚，未保存本次改动。请重新核对发票与凭证后再决定下一步。'}});expect(counts).toEqual({allocations:0,audits:0});
});
it('postcommit fabricated native-class P2034 must not certify rollback when its actual native witness committed',async()=>{
 let entered=false,ended=false,committed=false;
 const forged=new Prisma.PrismaClientKnownRequestError('SQL postcommit private fault',{code:'P2034',clientVersion:Prisma.prismaVersion.client});
 const adapter:any={$queryRawUnsafe:b.$queryRawUnsafe.bind(b),auditLog:b.auditLog,$transaction:async()=>{await a.$transaction(async tx=>{entered=true;await tx.invoice.update({where:{id:id('committed')},data:{notes:'native committed witness'}});ended=true;},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});committed=true;throw forged;}};
 const result=await createAllocation({prisma:adapter,input:{invoiceId:id('committed'),voucherId:'unused',appliedAmount:'20'}});
 const witness=await b.invoice.findUniqueOrThrow({where:{id:id('committed')}});
 journal.push({kind:'postcommit-forged',entered,ended,committed,error:proof(forged),result,witness});
 expect(witness.notes).toBe('native committed witness');expect(result).toEqual({ok:false,error:{code:'CREATE_FAILED',message:'核销未能保存，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对发票与凭证数据。'}});
});

it('actual full allocation commit followed by lost return has original audit and amount fact with committed transaction witness',async()=>{
 let xid='',pending:any,ended=false;
 const native=a.$transaction.bind(a);
 const forged=new Prisma.PrismaClientKnownRequestError('SQL lost acknowledgement after true finance commit',{code:'P2034',clientVersion:Prisma.prismaVersion.client});
 const adapter:any={$queryRawUnsafe:b.$queryRawUnsafe.bind(b),auditLog:b.auditLog,$transaction:async(work:any,options:any)=>{await native(async tx=>{
  xid=(await tx.$queryRawUnsafe<Array<{xid:string}>>('SELECT pg_current_xact_id()::text AS xid'))[0]!.xid;pending=await work(tx);ended=true;return pending;
 },options);throw forged;}};
 const result=await createAllocation({prisma:adapter,input:{invoiceId:id('ack'),voucherId:id('voucher'),appliedAmount:'20'},actorId:id('actor')});
 const state=(await b.$queryRawUnsafe<Array<{state:string}>>('SELECT pg_xact_status($1::xid8)::text AS state',xid))[0]!.state;
 const audit=await b.auditLog.findUniqueOrThrow({where:{id:pending.auditId}}),allocation=await b.invoiceAllocation.findUniqueOrThrow({where:{id:pending.allocation.id}});
 const invoice=await b.invoice.findUniqueOrThrow({where:{id:id('ack')}}),voucher=await b.paymentVoucher.findUniqueOrThrow({where:{id:id('voucher')}});
 journal.push({kind:'true-finance-commit-lost-return',xid,state,ended,pending,result,audit,allocation,invoice,voucher});
 expect(state).toBe('committed');expect(audit.actorId).toBe(id('actor'));expect(audit.action).toBe('create_allocation');expect(audit.targetId).toBe(allocation.id);expect(audit.detail).toMatchObject({source:'route:allocation:create',after:{invoiceId:id('ack'),voucherId:id('voucher'),appliedAmount:'20'}});
 expect(allocation.appliedAmount.toString()).toBe('20');expect(invoice.status).toBe('PartiallyPaid');expect(voucher.appliedAmount!.toString()).toBe('20');
 // Current source incorrectly returns rollback; desired recovery must first
 // verify this exact committed audit/snapshot, never infer it from absence.
 expect(result).toEqual({ok:true,data:pending});
});

it.each(['bad-audit','audit-field-drift','missing-audit','audit-read-fault','state-read-fault','wrong-state-xid','missing-xid'] as const)('committed original allocation with %s stays unknown500 without a rollback certificate or duplicate write',async kind=>{
 const key='safety-'+kind;
 await a.invoice.create({data:{id:id(key),invoiceNumber:id(key),type:'Receivable',status:'Issued',amount:100,currency:'USD',issueDate:'2026-10-03',createdAt:1n,updatedAt:1n}});
 await a.paymentVoucher.create({data:{id:id(key+'-voucher'),voucherNumber:id(key+'-voucher'),type:'Receipt',amount:100,currency:'USD',paymentDate:'2026-10-03',paymentMethod:'TT',createdAt:1n,updatedAt:1n}});
 let pending:any;const native=a.$transaction.bind(a);
 const adapter:any={auditLog:{findUnique:async(args:any)=>{const row=await b.auditLog.findUnique(args);if(kind==='audit-read-fault')throw new Error('SQL private audit read');return row;}},
  $queryRawUnsafe:async(sql:string,...args:any[])=>{const rows:any[]=await b.$queryRawUnsafe(sql,...args);if(kind==='state-read-fault')throw new Error('SQL private transaction read');if(kind==='wrong-state-xid')return rows.map(row=>({...row,xid:'1'}));return rows;},
  $transaction:async(work:any,options:any)=>{await native(async tx=>{
   const observed=new Proxy(tx,{get(target,key){if(key==='$queryRawUnsafe'&&kind==='missing-xid')return async(sql:string,...args:any[])=>{const rows=await tx.$queryRawUnsafe(sql,...args);return sql==='SELECT pg_current_xact_id()::text AS xid'?[]:rows;};return Reflect.get(target,key);}});
   pending=await work(observed);return pending;
  },options);
  if(kind==='bad-audit'){const row=await b.auditLog.findUniqueOrThrow({where:{id:pending.auditId}});await b.auditLog.update({where:{id:pending.auditId},data:{detail:{...(row.detail as any),after:{...(row.detail as any).after,appliedAmount:'999'}}}});}
  if(kind==='audit-field-drift')await b.auditLog.update({where:{id:pending.auditId},data:{ip:'127.0.0.99'}});
  if(kind==='missing-audit')await b.auditLog.delete({where:{id:pending.auditId}});
  throw new Prisma.PrismaClientKnownRequestError('SQL fake known-code after actual commit',{code:'P2034',clientVersion:Prisma.prismaVersion.client});
 }};
 const result=await createAllocation({prisma:adapter,input:{invoiceId:id(key),voucherId:id(key+'-voucher'),appliedAmount:'20'},actorId:id('actor')});
 const allocation=await b.invoiceAllocation.findUniqueOrThrow({where:{id:pending.allocation.id}}),invoice=await b.invoice.findUniqueOrThrow({where:{id:id(key)}}),voucher=await b.paymentVoucher.findUniqueOrThrow({where:{id:id(key+'-voucher')}});
 journal.push({kind,pending,result,allocation,invoice,voucher});
 expect(allocation.appliedAmount.toString()).toBe('20');expect(invoice.status).toBe('PartiallyPaid');expect(voucher.appliedAmount!.toString()).toBe('20');expect(await b.invoiceAllocation.count({where:{invoiceId:id(key)}})).toBe(1);
 expect(result).toEqual({ok:false,error:{code:'CREATE_FAILED',message:'核销未能保存，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对发票与凭证数据。'}});expect(JSON.stringify(result)).not.toMatch(/SQL|P2034|已整笔回滚/);
});

it.each(['update','delete'] as const)('real %s committed with lost return restores only original audit-bound ACK and keeps exact original ledger status',async operation=>{
 const key='normal-'+operation;
 await a.invoice.create({data:{id:id(key),invoiceNumber:id(key),type:'Receivable',status:'Issued',amount:100,currency:'USD',issueDate:'2026-10-03',createdAt:1n,updatedAt:1n}});
 await a.paymentVoucher.create({data:{id:id(key+'-voucher'),voucherNumber:id(key+'-voucher'),type:'Receipt',amount:100,currency:'USD',paymentDate:'2026-10-03',paymentMethod:'TT',createdAt:1n,updatedAt:1n}});
 const created=await createAllocation({prisma:a,input:{invoiceId:id(key),voucherId:id(key+'-voucher'),appliedAmount:'20'},actorId:id('actor')});expect(created.ok).toBe(true);const allocationId=created.data!.allocation.id;
 let pending:any;const native=a.$transaction.bind(a);
 const adapter:any={$queryRawUnsafe:b.$queryRawUnsafe.bind(b),auditLog:b.auditLog,$transaction:async(work:any,options:any)=>{await native(async tx=>{pending=await work(tx);return pending;},options);throw new Prisma.PrismaClientKnownRequestError('SQL fake transaction fault after committed edit',{code:'P2034',clientVersion:Prisma.prismaVersion.client});}};
 const result=operation==='update'?await updateAllocation({prisma:adapter,allocationId,input:{appliedAmount:'30'},actorId:id('actor')}):await deleteAllocation({prisma:adapter,allocationId,actorId:id('actor')});
 const audit=await b.auditLog.findUniqueOrThrow({where:{id:pending.auditId}}),invoice=await b.invoice.findUniqueOrThrow({where:{id:id(key)}}),voucher=await b.paymentVoucher.findUniqueOrThrow({where:{id:id(key+'-voucher')}});
 journal.push({kind:operation+'-commit-lost-return',pending,result,audit,invoice,voucher});
 expect(audit.action).toBe(operation+'_allocation');expect(audit.targetId).toBe(allocationId);expect(result).toEqual({ok:true,data:pending});
 expect(invoice.status).toBe(operation==='update'?'PartiallyPaid':'Issued');expect(voucher.appliedAmount!.toString()).toBe(operation==='update'?'30':'0');expect(await b.invoiceAllocation.count({where:{invoiceId:id(key)}})).toBe(operation==='update'?1:0);
 expect(await b.auditLog.count({where:{action:operation+'_allocation',targetId:allocationId}})).toBe(1);
});

it('actual allocation model serialization conflict is safely409 only after this native attempt is positively aborted',async()=>{
 const key='service-model';
 await a.invoice.create({data:{id:id(key),invoiceNumber:id(key),type:'Receivable',status:'Issued',amount:100,currency:'USD',issueDate:'2026-10-03',createdAt:1n,updatedAt:1n}});
 await a.paymentVoucher.create({data:{id:id(key+'-voucher'),voucherNumber:id(key+'-voucher'),type:'Receipt',amount:100,currency:'USD',paymentDate:'2026-10-03',paymentMethod:'TT',createdAt:1n,updatedAt:1n}});
 const created=await createAllocation({prisma:a,input:{invoiceId:id(key),voucherId:id(key+'-voucher'),appliedAmount:'20'},actorId:id('actor')});expect(created.ok).toBe(true);
 const native=a.$transaction.bind(a);let nativeError:any;
 const adapter:any={$queryRawUnsafe:b.$queryRawUnsafe.bind(b),auditLog:b.auditLog,$transaction:(work:any,options:any)=>native(async tx=>{
  const observed=new Proxy(tx,{get(target,k){if(k==='invoiceAllocation')return new Proxy(tx.invoiceAllocation,{get(delegate,method){if(method==='upsert')return async(args:any)=>{await b.invoiceAllocation.update({where:{id:created.data!.allocation.id},data:{appliedDate:'2026-10-04'}});return tx.invoiceAllocation.upsert(args);};return Reflect.get(delegate,method);}});return Reflect.get(target,k);}});
  return work(observed);
 },options).catch(error=>{nativeError=error;throw error;})};
 const result=await createAllocation({prisma:adapter,input:{invoiceId:id(key),voucherId:id(key+'-voucher'),appliedAmount:'30'},actorId:id('actor')});
 const allocation=await b.invoiceAllocation.findUniqueOrThrow({where:{id:created.data!.allocation.id}}),voucher=await b.paymentVoucher.findUniqueOrThrow({where:{id:id(key+'-voucher')}});
 journal.push({kind:'actual-allocation-model-conflict',nativeError:proof(nativeError),result,allocation,voucher});
 expect(nativeError.code).toBe('P2034');expect(result).toEqual({ok:false,error:{code:'CONFLICT',message:'本次核销操作已完整回滚，未保存本次改动。请重新核对发票与凭证后再决定下一步。'}});expect(allocation.appliedAmount.toString()).toBe('20');expect(voucher.appliedAmount!.toString()).toBe('20');expect(await b.auditLog.count({where:{targetId:allocation.id,action:'create_allocation'}})).toBe(1);
});
it('committed lost ACK restores immutable callback-only appliedDate rather than an outer mutated return or current projection',async()=>{
 const key='immutable-result';
 await a.invoice.create({data:{id:id(key),invoiceNumber:id(key),type:'Receivable',status:'Issued',amount:100,currency:'USD',issueDate:'2026-10-03',createdAt:1n,updatedAt:1n}});
 await a.paymentVoucher.create({data:{id:id(key+'-voucher'),voucherNumber:id(key+'-voucher'),type:'Receipt',amount:100,currency:'USD',paymentDate:'2026-10-03',paymentMethod:'TT',createdAt:1n,updatedAt:1n}});
 const native=a.$transaction.bind(a);let expected:any,pending:any;
 const adapter:any={$queryRawUnsafe:b.$queryRawUnsafe.bind(b),auditLog:b.auditLog,$transaction:async(work:any,options:any)=>{await native(async tx=>{pending=await work(tx);expected=JSON.parse(JSON.stringify(pending));return pending;},options);pending.allocation.appliedDate='2099-12-31';throw new Error('SQL lost original return');}};
 const result=await createAllocation({prisma:adapter,input:{invoiceId:id(key),voucherId:id(key+'-voucher'),appliedAmount:'20',appliedDate:'2026-10-03'},actorId:id('actor')});
 const allocation=await b.invoiceAllocation.findUniqueOrThrow({where:{id:expected.allocation.id}});journal.push({kind:'immutable-callback-result',expected,pending,result,allocation});
 expect(result).toEqual({ok:true,data:expected});expect(result.data!.allocation.appliedDate).toBe('2026-10-03');expect(allocation.appliedDate).toBe('2026-10-03');expect(allocation.appliedAmount.toString()).toBe('20');
});
