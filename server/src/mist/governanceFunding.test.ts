import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MistRepository} from './repository';
import {MistPrivateFiles} from './files';
import {MemoryMistDatabase,testActor,testAuthority} from './__tests__/support';
import * as contract from '../shared/mistWorkspace';
import {orderFundingCoveredAmount} from '../shared/mistOrderFunding';
import type {OrderGovernanceInput} from '../shared/mistOrderGovernance';

vi.mock('./context',()=>({mistApprovalAuthority:async()=>({supplier:{},orderReviewerIds:{garment:['reviewer'],fabric:['reviewer']}})}));
vi.mock('../auth/tokenHelpers',()=>({loadUserWithRoles:async(_db:unknown,id:string)=>({id,status:'active',deletedAt:null}),buildLoadedAuthTokenPayload:async(_db:unknown,user:{id:string})=>({userId:user.id,permissions:['orders:write'],roles:[],departmentIds:[]})}));

let db:MemoryMistDatabase,repo:MistRepository,dir:string;
beforeEach(async()=>{
 dir=await mkdtemp(path.join(tmpdir(),'mist-governance-funding-'));db=new MemoryMistDatabase();
 const auth=testAuthority();auth.users.get('owner')!.permissions.push('orders:write','relations:write');auth.users.set('reviewer',{active:true,permissions:['orders:write']});
 repo=new MistRepository(db,contract,new MistPrivateFiles(dir),auth.authorize,()=>new Date('2026-10-13T08:00:00Z'));
});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});

describe('real order governance and funding repository transaction',()=>{
 it.each(['amount','currency'] as const)('rolls back a %s amendment at the cross-account decision boundary and permits it after reattribution',async mode=>{
  const workspace=await repo.create(testActor(),{name:'Order governance funding',seed:'empty'});let revision=workspace.revision,sequence=0;
  const run=async(command:contract.MistCommand)=>{const saved=await repo.execute(testActor(),workspace.id,{requestId:'command-'+(++sequence),expectedRevision:revision,command});revision=saved.workspace.revision;return saved;};
  const customer=await run({type:'market.customer.create',payload:{input:{name:'客户',country:'CN',city:'上海',industry:'服装',owner:'owner',grade:'A',currency:'USD',terms:'TT',incoterm:'FOB',categories:'成衣',creditLimit:0,since:'2026-10-13'}}});
  const customerId=customer.receipt.result.customerId as string;
  const upload=await repo.upload(testActor(),workspace.id,{requestId:'actual-po-file',expectedRevision:revision},{bytes:Buffer.from('Customer written purchase order'),name:'po.txt',mimeType:'text/plain'});revision=upload.workspace.revision;
  const terms:OrderGovernanceInput={kind:'external',poNumber:'PO-001',confirmationFileIds:[upload.workspace.state.files[0].id],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'T/T 30% deposit',incoterm:'FOB',deliveryPlace:'上海'};
  const created=await run({type:'order.create',payload:{type:'garment',customerId,season:'AW26',currency:'USD',due:'2026-12-01',owner:'owner',governance:terms,lines:[{name:'外套',style:'A',img:'coat',qty:10,unit:'件',price:10}]}});
  const orderId=created.receipt.result.orderId as string;
  const decide=async(requestId:string)=>{
   const review=(await repo.listReviews(testActor('reviewer'))).find((row:{entityId:string;status:string})=>row.entityId===orderId&&row.status==='pending')!;
   const result=await repo.decideReview(testActor('reviewer'),workspace.id,review.id,{requestId,expectedRevision:revision,decision:'approved',note:'核对冻结合同'});revision=result.receipt.revision;return result;
  };
  await run({type:'order.governance.submit',payload:{orderId}});await decide('approve-original');
  const receipt=await run({type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-13',payer:'客户',amount:80,currency:'USD',ref:'BANK-UNIQUE'}]}});
  const receiptId=receipt.workspace.state.receipts[0].id;
  const assignment=await run({type:'funding.assign',payload:{receiptId,customerId,orderId,amount:80,note:'客户确认原合同归属'}});
  const line=assignment.workspace.state.orderLines[0];
  await run({type:'order.governance.saveDraft',payload:{orderId,input:terms,reason:'修订PO已核对',...(mode==='amount'?{lines:[{id:line.id,name:line.name,style:line.style,img:line.img,qty:line.qty,unit:line.unit,price:5}]}:{orderPatch:{currency:'EUR'}})}});
  await run({type:'order.governance.submit',payload:{orderId}});
  const before=await repo.get(testActor(),workspace.id),receiptsBefore=db.receipts.size;
  await expect(decide('refuse-invalid-change')).rejects.toMatchObject({code:mode==='amount'?'PRECONDITION':'VALIDATION'});
  expect(await repo.get(testActor(),workspace.id)).toEqual(before);expect(db.receipts.size).toBe(receiptsBefore);
  expect(db.receipts.has(workspace.id+':refuse-invalid-change')).toBe(false);
  expect(before.state.orders[0].governance?.changeDraft?.status).toBe('pending');
  await run({type:'funding.release',payload:{id:assignment.receipt.result.id as string,note:'客户确认解除原订单归属'}});
  await run({type:'funding.assign',payload:{receiptId,customerId,orderId:null,amount:80,note:'转为客户USD余额'}});
  const approved=await decide('approve-released-change');
  const after=await repo.get(testActor(),workspace.id);
  expect(after.state.orders[0]).toMatchObject(mode==='amount'?{amount:50,currency:'USD'}:{amount:100,currency:'EUR'});
  expect(after.state.orders[0].governance?.changeDraft).toBeUndefined();expect(after.state.orders[0].governance?.effectiveVersion).toBe(2);
  expect(orderFundingCoveredAmount(after.state,orderId)).toBe(0);expect(after.state.receipts[0].remaining).toBe(80);expect(after.state.allocations).toEqual([]);
  expect((await repo.decideReview(testActor('reviewer'),workspace.id,approved.receipt.result.reviewId as string,{requestId:'approve-released-change',expectedRevision:before.revision+2,decision:'approved',note:'核对冻结合同'})).replayed).toBe(true);
 });
});
