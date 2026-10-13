/** Opt-in isolated PG/HTTP. Only canonical HTTP commands create account,
 * verified Opening, actual receipt and correction facts. */
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {assertIsolatedAcceptanceDatabase} from './isolatedDatabase';
import {createGlobalBusinessHttpFixture,type GlobalBusinessHttpFixture,type BusinessFixtureActorName,type HttpMethod} from './globalBusinessFixtures';
import {createFinanceRouter} from '../src/finance/route';
import {createFinanceV2Router} from '../src/finance/routeV2';
import {createAcceptanceCashAccount,acceptanceCashInput} from './companyCashAcceptanceHelpers';
let prisma:PrismaClient,f:GlobalBusinessHttpFixture,loseOpening=false;
const http=(actor:BusinessFixtureActorName,method:HttpMethod,path:string,input?:unknown)=>f.request(actor,method,path,input);
const path=(id:string)=>`/api/v1/finance/cash-accounts/${encodeURIComponent(id)}`;
function status(r:any,expected=200,label='native company cash'){expect(r.status,`${label}: ${JSON.stringify(r.body)}`).toBe(expected);
  expect(JSON.stringify(r.body)).not.toMatch(/P2003|P2010|23503|42703|PRIVATE cash acknowledgement/);return r.body;}
beforeAll(async()=>{
  prisma=new PrismaClient({datasources:{db:{url:process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL}}});await assertIsolatedAcceptanceDatabase(prisma);
  const client=new Proxy(prisma,{get(target,key){if(key==='$transaction')return async(...args:any[])=>{
    const result=await (target.$transaction as any).apply(target,args);
    if(loseOpening&&result?.financeCommand?.kind==='cash_account.opening'&&!result.replayed){loseOpening=false;throw Error('PRIVATE cash acknowledgement lost after commit');}return result;
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  f=await createGlobalBusinessHttpFixture(prisma,{prefix:`cash-ledger-${randomUUID().slice(0,8)}`,mountAdditionalRoutes(app){
    app.set('json replacer',(_key:string,value:any)=>typeof value==='bigint'?String(value):value);
    const options={prisma:client,requireAuth:true,apiKeys:new Set<string>()};app.use('/api/v1/finance',createFinanceRouter(options));app.use('/api/v2/finance',createFinanceV2Router(options));
  }});
},120_000);
afterAll(async()=>{await f?.close();await prisma?.$disconnect();});
describe('F2 canonical company account → actual cash → verified Opening → append-only corrections',()=>{
  it('keeps unknown before true Opening, records explicit bank net, recovers lost ACK and retains negative cash after voucher removal',async()=>{
    const account=await createAcceptanceCashAccount(f,{label:'net-facts'});
    expect(status(await http('finance','get',path(account.id)))).toMatchObject({balance:null,balanceStatus:'unknown',entries:[]});
    const receiptInput={...await acceptanceCashInput(f,account.id),requestKey:randomUUID(),type:'Receipt',amount:'60',bankFee:'2',feeBearer:'BEN',actualAccountAmount:'58',
      currency:'USD',paymentDate:'2026-10-07',paymentMethod:'TT',customerRelationId:f.customer.id,customerName:f.customer.name};
    const receipt=status(await http('finance','post','/api/v1/finance/vouchers',receiptInput),201,'actual gross 60, bank net 58');
    const before=status(await http('finance','get',path(account.id)));expect(before.balance).toBeNull();expect(before.entries).toHaveLength(1);
    expect(before.entries[0]).toMatchObject({kind:'Receipt',sourceVoucherId:receipt.id,amount:'58',signedAmount:'58'});
    expect(before.entries[0].evidence.sourceSnapshot).toMatchObject({voucherAmount:'60.0000',bankFee:'2.0000',accountAmount:'58.0000'});
    const opening={requestKey:randomUUID(),expectedRevision:before.account.revision,action:'opening',amount:'-10',currency:'USD',occurredDate:'2026-10-07',bankReference:`${f.prefix}-OPENING`,evidenceNote:'已核实该日开始前银行余额'};
    status(await http('finance','post',`${path(account.id)}/commands`,{...opening,requestKey:randomUUID(),occurredDate:'2026-10-08'}),409,'current late bank balance is not Opening');
    loseOpening=true;status(await http('finance','post',`${path(account.id)}/commands`,opening),500,'lost after actual Opening commit');
    const recovered=status(await http('finance','post',`${path(account.id)}/commands`,opening));expect(recovered.replayed).toBe(true);
    const originalReceipt=recovered.financeCommand;expect(status(await http('finance','get',path(account.id)))).toMatchObject({balance:'48.0000',balanceStatus:'verified'});
    const correction=(amount:string,revision:number)=>({requestKey:randomUUID(),expectedRevision:revision,action:'correction',amount,currency:'USD',occurredDate:'2026-10-07',
      correctsEntryId:before.entries[0].id,bankReference:`${f.prefix}-RETURN-${amount}`,reason:'真实退回原收款，保留原银行事实'});
    const first=status(await http('finance','post',`${path(account.id)}/commands`,correction('40',recovered.account.revision)),201);
    status(await http('finance','post',`${path(account.id)}/commands`,correction('18.0001',first.account.revision)),409,'cannot return more than original actual bank net');
    const second=correction('18',first.account.revision),both=await Promise.all([http('finance','post',`${path(account.id)}/commands`,second),http('finance','post',`${path(account.id)}/commands`,second)]);
    expect(both.map(r=>r.status).sort()).toEqual([200,201]);expect(both[0].body.entry.id).toBe(both[1].body.entry.id);
    const exact=status(await http('finance','get',`/api/v1/finance/vouchers/${receipt.id}`));
    status(await http('finance','delete',`/api/v1/finance/vouchers/${receipt.id}`,{requestKey:randomUUID(),expectedUpdatedAt:String(exact.updatedAt)}));
    const final=status(await http('finance','get',path(account.id)));expect(final).toMatchObject({balance:'-10.0000',negative:true,balanceStatus:'verified'});expect(final.entries).toHaveLength(4);
    expect(status(await http('finance','post',`${path(account.id)}/commands`,opening)).financeCommand).toEqual(originalReceipt);
    status(await http('finance','post',`${path(account.id)}/commands`,{...opening,amount:'0'}),409,'original key cannot rewrite verified Opening');
    expect(await prisma.cashAccountEntry.count({where:{sourceVoucherId:receipt.id}})).toBe(1);
  });
  it('enforces current account management/use scope and currency, including original request replay after whitelist withdrawal',async()=>{
    const account=await createAcceptanceCashAccount(f,{label:'permissions'});
    status(await http('finance','post','/api/v1/finance/cash-accounts',{requestKey:randomUUID(),name:'self-reported',companyName:'Seller',currency:'USD',bankName:'Bank',accountName:'Seller',accountNumberMasked:'****',ownerId:f.actors.finance.id,allowedUserIds:[f.actors.finance.id]}),403,'ordinary finance cannot configure its own L2');
    status(await http('salesOutsider','get',path(account.id)),404,'unrelated source/account scope');
    const cashInput={...await acceptanceCashInput(f,account.id),requestKey:randomUUID(),type:'Receipt',amount:'5',currency:'USD',paymentDate:'2026-10-07',paymentMethod:'TT',customerRelationId:f.customer.id};
    status(await http('finance','post','/api/v2/finance/payments',{...cashInput,requestKey:randomUUID(),currency:'EUR'}),409,'no implicit currency exchange');
    const first=status(await http('finance','post','/api/v2/finance/payments',cashInput),200).payment;
    const current=status(await http('finance','get',path(account.id)));
    const update=status(await http('superAdmin','post',`${path(account.id)}/commands`,{requestKey:randomUUID(),expectedRevision:current.account.revision,action:'update',changes:{allowedUserIds:[f.actors.superAdmin.id]}}),201);
    status(await http('finance','get',path(account.id)),404,'actual account use list withdrawn');
    status(await http('finance','post','/api/v2/finance/payments',cashInput),404,'old original receipt still requires current account access');
    expect(await prisma.cashAccountEntry.count({where:{sourceVoucherId:first.id}})).toBe(1);
    const restored=status(await http('superAdmin','post',`${path(account.id)}/commands`,{requestKey:randomUUID(),expectedRevision:update.account.revision,action:'update',changes:{allowedUserIds:[f.actors.finance.id,f.actors.superAdmin.id]}}),201);
    expect(restored.account.revision).toBe(update.account.revision+1);
    const grant=await prisma.userRole.findFirstOrThrow({where:{userId:f.actors.finance.id,roleId:f.actors.finance.roleId}});await prisma.userRole.delete({where:{id:grant.id}});
    status(await http('finance','post','/api/v2/finance/payments',cashInput),403,'old token after current financial grant withdrawal');
  });
});
