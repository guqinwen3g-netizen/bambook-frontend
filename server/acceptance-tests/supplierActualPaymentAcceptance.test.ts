import {createAcceptanceCashAccount,acceptanceCashInput} from './companyCashAcceptanceHelpers';
/** Opt-in isolated HTTP: approval is not bank execution. Actual payments and
 * immutable original command receipts come only from native producers. */
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {assertIsolatedAcceptanceDatabase} from './isolatedDatabase';
import {createGlobalBusinessHttpFixture,type GlobalBusinessHttpFixture,type BusinessFixtureActorName,type HttpMethod} from './globalBusinessFixtures';
import {createPaymentRequestRouter} from '../src/paymentRequests/paymentRequestRoute';
import {registerPaymentRequestApprovalHook} from '../src/paymentRequests/paymentRequestApprovalHook';
import {approvalEventBus} from '../src/agent/events';
import {createApprovalRouter} from '../src/approvals/approvalRoute';
import {createFinanceRouter} from '../src/finance/route';
import {createFinanceV2Router} from '../src/finance/routeV2';
let prisma:PrismaClient,f:GlobalBusinessHttpFixture,loseAck=false;
let hookListeners:Function[]=[];
const json=(v:unknown)=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?String(x):x);
const http=(actor:BusinessFixtureActorName,method:HttpMethod,path:string,body?:unknown)=>f.request(actor,method,path,body);
function status(r:any,expected=200,label='actual supplier payment'){expect(r.status,`${label}: ${json(r.body)}`).toBe(expected);
  expect(json(r.body)).not.toMatch(/P2003|P2010|23503|42703|PRIVATE lost actual payment/i);return r.body;}
beforeAll(async()=>{
  prisma=new PrismaClient({datasources:{db:{url:process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL}}});await assertIsolatedAcceptanceDatabase(prisma);
  const client=new Proxy(prisma,{get(target,key){if(key==='$transaction')return async(...args:any[])=>{
    const result=await (target.$transaction as any).apply(target,args);
    if(loseAck&&result?.financeCommand?.kind==='payment_request.record_payment'){loseAck=false;throw Error('PRIVATE lost actual payment acknowledgement');}
    return result;
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  f=await createGlobalBusinessHttpFixture(prisma,{prefix:`actual-pay-${randomUUID().slice(0,8)}`,mountAdditionalRoutes(app){
    app.set('json replacer',(_k:string,v:any)=>typeof v==='bigint'?String(v):v);
    app.use('/api/v1/payment-requests',createPaymentRequestRouter({prisma:client,requireAuth:true}));
    app.use('/api/v1/approvals',createApprovalRouter({prisma:client,requireAuth:true}));
    const options={prisma:client,requireAuth:true,apiKeys:new Set<string>()};
    app.use('/api/v1/finance',createFinanceRouter(options));app.use('/api/v2/finance',createFinanceV2Router(options));
  }});
  const user=await prisma.userAccount.findUniqueOrThrow({where:{id:f.actors.salesOwner.id},select:{primaryDeptId:true}});
  await prisma.department.update({where:{id:user.primaryDeptId!},data:{headId:f.actors.manager.id}});
  const before=new Set(approvalEventBus.listeners('resolved'));
  registerPaymentRequestApprovalHook({prisma:client});hookListeners=approvalEventBus.listeners('resolved').filter(x=>!before.has(x));
},120_000);
afterAll(async()=>{for(const listener of hookListeners)approvalEventBus.off('resolved',listener as any);await f?.close();await prisma?.$disconnect();});

describe('native approval → actual partial payment → immutable receipt and source readback',()=>{
  it('approves without bank cash, records 40 + 60 once, and retains original facts after retries and voucher removal',async()=>{
    const created=status(await http('salesOwner','post','/api/v1/payment-requests',{supplierId:f.factory.id,supplierName:f.factory.name,
      totalAmount:'100.0000',currency:'USD',paymentCategory:'normal',requestDate:'2026-10-07',expectedPaymentDate:'2026-11-07',
      remark:'真实供应商服务的付款申请；此预计日期不是实付事实'}),201,'submit actual request');
    const requestId=created.paymentRequest.id,path=`/api/v1/payment-requests/${encodeURIComponent(requestId)}`;
    const exact=status(await http('manager','get',`/api/v1/approvals/${encodeURIComponent(created.approvalRequestId)}`)).item;
    expect(exact).toMatchObject({targetId:requestId,targetType:'PaymentRequest',status:'pending',reviewerId:f.actors.manager.id});
    status(await http('manager','post',`/api/v1/approvals/${encodeURIComponent(exact.id)}/decide`,{status:'approved',confirmedReviewedContent:true,
      reviewContentVersion:exact.reviewContentVersion,decisionNote:'已逐项核对实际收款对象、申请金额和来源'}));
    let detail:any;
    for(let i=0;i<30;i++){detail=status(await http('finance','get',path)).item;if(detail.status==='Approved')break;await new Promise(resolve=>setTimeout(resolve,20));}
    expect(detail.status).toBe('Approved');expect(detail.paymentVoucherId).toBeNull();
    expect(detail.actualPayments).toEqual({paidAmount:'0.0000',remainingAmount:'100.0000',vouchers:[]});
    expect(await prisma.paymentVoucher.count({where:{attachments:{path:['paymentRequestId'],equals:requestId}}})).toBe(0);
    const companyAccount=await createAcceptanceCashAccount(f);
    status(await http('finance','post',`/api/v1/finance/cash-accounts/${encodeURIComponent(companyAccount.id)}/commands`,{requestKey:randomUUID(),expectedRevision:companyAccount.revision,
      action:'opening',amount:'0',currency:'USD',occurredDate:'2026-10-07',bankReference:`${f.prefix}-START-OF-DAY`,evidenceNote:'已核实该日开始前银行余额为零'}),201);
    const original={...await acceptanceCashInput(f,companyAccount.id),requestKey:randomUUID(),expectedRequestUpdatedAt:detail.updatedAt,amount:'40.0000',currency:'USD',paymentDate:'2026-10-07',
      paymentMethod:'TT',bankReference:`${f.prefix}-BANK-1`,evidenceNote:'真实银行扣款回单，非审批推导'};
    status(await http('salesOutsider','post',`${path}/record-payment`,original),403,'ordinary unrelated business cannot record actual payment');
    status(await http('finance','post',`${path}/record-payment`,{...original,requestKey:randomUUID(),paymentDate:'2026-02-31'}),400,'reject impossible actual date');
    status(await http('finance','post','/api/v2/finance/payments',{requestKey:randomUUID(),type:'Disbursement',amount:'40',currency:'USD',
      paymentDate:'2026-10-07',paymentMethod:'TT',customerRelationId:f.factory.id,paymentRequestId:requestId,
      attachments:{paymentRequestId:requestId}}),409,'generic payment cannot claim reserved request source');
    loseAck=true;status(await http('finance','post',`${path}/record-payment`,original),500,'unknown committed acknowledgement');
    const first=status(await http('finance','post',`${path}/record-payment`,original)).voucher;
    const replay=status(await http('finance','post',`${path}/record-payment`,original));expect(replay.voucher).toEqual(first);
    expect(replay).toMatchObject({replayed:true,paidAmount:'40.0000',remainingAmount:'60.0000'});
    detail=status(await http('finance','get',path)).item;expect(detail).toMatchObject({status:'Approved',actualPayments:{paidAmount:'40.0000',remainingAmount:'60.0000'}});
    expect(status(await http('finance','get',`/api/v1/finance/cash-accounts/${companyAccount.id}`))).toMatchObject({balance:'-40.0000',negative:true,balanceStatus:'verified'});
    status(await http('finance','post',`${path}/record-payment`,{...original,amount:'41.0000'}),409,'one original key cannot change amount');
    status(await http('finance','post',`${path}/record-payment`,{...original,requestKey:randomUUID()}),409,'new key with stale request revision');
    const exactVoucher=status(await http('finance','get',`/api/v1/finance/vouchers/${first.id}`));
    status(await http('finance','patch',`/api/v1/finance/vouchers/${first.id}`,{requestKey:randomUUID(),expectedUpdatedAt:String(exactVoucher.updatedAt),amount:'1'}),409,'actual source amount is immutable');
    status(await http('finance','delete',`/api/v1/finance/vouchers/${first.id}`,{requestKey:randomUUID(),expectedUpdatedAt:String(exactVoucher.updatedAt)}),200,'soft removal preserves bank fact');
    detail=status(await http('finance','get',path)).item;expect(detail.actualPayments.paidAmount).toBe('40.0000');expect(detail.actualPayments.remainingAmount).toBe('60.0000');
    const tooMuch={...original,requestKey:randomUUID(),expectedRequestUpdatedAt:detail.updatedAt,amount:'60.0001'};
    status(await http('finance','post',`${path}/record-payment`,tooMuch),409,'removed bank fact does not release payment capacity');
    const second={...original,...await acceptanceCashInput(f,companyAccount.id),requestKey:randomUUID(),expectedRequestUpdatedAt:detail.updatedAt,amount:'60.0000',bankReference:`${f.prefix}-BANK-2`};
    const concurrency=await Promise.all([http('finance','post',`${path}/record-payment`,second),http('finance','post',`${path}/record-payment`,second)]);
    expect(concurrency.map(r=>r.status).sort()).toEqual([200,201]);expect(concurrency[0].body.voucher.id).toBe(concurrency[1].body.voucher.id);
    const final=status(await http('salesOwner','get',path)).item;expect(final).toMatchObject({status:'Paid',actualPayments:{paidAmount:'100.0000',remainingAmount:'0.0000'}});
    expect(final.actualPayments.vouchers).toHaveLength(2);expect(final.actualPayments.vouchers.some((v:any)=>v.id===first.id&&v.deletedAt)).toBe(true);
    const late=status(await http('finance','post',`${path}/record-payment`,original));expect(late).toMatchObject({replayed:true,paidAmount:'40.0000',remainingAmount:'60.0000',paymentRequest:{status:'Approved'}});
    expect(late.voucher).toEqual(first);expect(await prisma.paymentVoucher.count({where:{attachments:{path:['paymentRequestId'],equals:requestId}}})).toBe(2);
    const actualApproval=await prisma.approvalRequest.findUniqueOrThrow({where:{id:exact.id}});expect(actualApproval.status).toBe('approved');
    const cash=status(await http('finance','get',`/api/v1/finance/cash-accounts/${companyAccount.id}`));expect(cash).toMatchObject({balance:'-100.0000',negative:true});expect(cash.entries).toHaveLength(3);
    status(await http('finance','post',`/api/v1/finance/cash-accounts/${companyAccount.id}/commands`,{requestKey:randomUUID(),expectedRevision:cash.account.revision,action:'correction',
      amount:'20',currency:'USD',occurredDate:'2026-10-07',correctsEntryId:cash.entries.find((row:any)=>row.sourceVoucherId===first.id).id,bankReference:`${f.prefix}-ACTUAL-RETURN`,reason:'准确原实付的实际银行退回；不改付款审批或申请事实'}),201);
    expect(status(await http('salesOwner','get',path)).item).toMatchObject({status:'Paid',actualPayments:{paidAmount:'100.0000',remainingAmount:'0.0000'}});
    expect(status(await http('finance','get',`/api/v1/finance/cash-accounts/${companyAccount.id}`))).toMatchObject({balance:'-80.0000',negative:true});
    const grant=await prisma.userRole.findFirstOrThrow({where:{userId:f.actors.finance.id,roleId:f.actors.finance.roleId}});await prisma.userRole.delete({where:{id:grant.id}});
    status(await http('finance','post',`${path}/record-payment`,second),403,'withdrawn stored financial role blocks the old credential replay');
  });
});
