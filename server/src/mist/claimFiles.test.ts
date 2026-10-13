import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MistRepository} from './repository';
import {MistPrivateFiles} from './files';
import {MemoryMistDatabase,testActor,testAuthority} from './__tests__/support';
import * as contract from '../shared/mistWorkspace';

vi.mock('./context',()=>({mistApprovalAuthority:async()=>({supplier:{},claimReviewerId:'reviewer',orderReviewerIds:{garment:['reviewer'],fabric:['reviewer']}})}));
vi.mock('../auth/tokenHelpers',()=>({loadUserWithRoles:async(_db:unknown,id:string)=>({id,status:'active',deletedAt:null}),buildLoadedAuthTokenPayload:async(_db:unknown,user:{id:string})=>({userId:user.id,permissions:['orders:write','aftersales:write'],roles:[],departmentIds:[]})}));
let directory:string,db:MemoryMistDatabase,repo:MistRepository,auth:ReturnType<typeof testAuthority>;
beforeEach(async()=>{
 directory=await mkdtemp(path.join(tmpdir(),'mist-claim-files-'));db=new MemoryMistDatabase();auth=testAuthority();
 auth.users.get('owner')!.permissions.push('relations:write','orders:write','invoices:write','aftersales:write');auth.users.set('reviewer',{active:true,permissions:['orders:write','aftersales:write']});
 repo=new MistRepository(db,contract,new MistPrivateFiles(directory),auth.authorize,()=>new Date('2026-10-13T08:00:00Z'));
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});

async function fixture(){
 const workspace=await repo.create(testActor(),{name:'Claim evidence',seed:'empty'});let revision=0,sequence=0;
 const run=async(command:contract.MistCommand)=>{const next=await repo.execute(testActor(),workspace.id,{requestId:'claim-command-'+(++sequence),expectedRevision:revision,command});revision=next.workspace.revision;return next;};
 const upload=async(name:string,body:string,claimId?:string)=>{const next=await repo.upload(testActor(),workspace.id,{requestId:'claim-upload-'+(++sequence),expectedRevision:revision,...(claimId?{claimId}:{})},{name,mimeType:'application/pdf',bytes:Buffer.from('%PDF-1.4\n'+body+'\n%%EOF')});revision=next.workspace.revision;if(claimId)expect(next.receipt.result.claimId).toBe(claimId);return next.workspace.state.files.at(-1)!;};
 const customerId=(await run({type:'market.customer.create',payload:{input:{name:'实际测试客户',country:'CN',city:'',industry:'服装',owner:'owner',grade:'A',currency:'USD',terms:'OA',incoterm:'FOB',categories:'成衣',creditLimit:0,since:'2026-10-13'}}})).receipt.result.customerId as string;
 const po=await upload('PO.pdf','written purchase order');
 const orderId=(await run({type:'order.create',payload:{type:'garment',customerId,season:'AW26',currency:'USD',due:'2026-12-01',owner:'owner',governance:{kind:'external',poNumber:'CLAIM-PO',confirmationFileIds:[po.id],internalPurpose:'',receiver:'',paymentMethod:'OA',depositPercent:null,paymentNote:'发票日起30天',incoterm:'FOB',deliveryPlace:'上海'},lines:[{name:'外套',style:'A',img:'coat',qty:4,unit:'件',price:15}]}})).receipt.result.orderId as string;
 await run({type:'order.governance.submit',payload:{orderId}});
 let review=(await repo.listReviews(testActor('reviewer'))).find((row:{entityId:string})=>row.entityId===orderId)!;
 const approved=await repo.decideReview(testActor('reviewer'),workspace.id,review.id,{requestId:'approve-order',expectedRevision:revision,decision:'approved',note:'核对正式合同'});revision=approved.receipt.revision;
 const draft=(await run({type:'platform.invoice.save',payload:{orderId,due:'2026-12-31',amount:60,note:'正式批准合同CI'}})).receipt.result.id as string;
 const invoiceId=(await run({type:'platform.invoice.issue',payload:{id:draft}})).receipt.result.invoiceId as string;
 const ci=await upload('CI-v2.pdf','original invoice evidence');
 const claimId=(await run({type:'platform.claim.create',payload:{orderId,invoiceId,problem:'客户折让事实附件',fileIds:[ci.id]}})).receipt.result.id as string;
 const dispositionId=(await run({type:'platform.claim.disposition',payload:{claimId,kind:'Allowance',amount:15,quantity:0,unit:'',returnDisposition:'',basis:'客户明确确认独立折让退款',fileIds:[ci.id]}})).receipt.result.id as string;
 return{workspaceId:workspace.id,claimId,dispositionId,ci,run,upload,getRevision:()=>revision,setRevision:(value:number)=>{revision=value;}};
}

it('allows the assigned reviewer to download only frozen case and disposition files across accounts',async()=>{
 const f=await fixture();auth.users.get('owner')!.permissions=['aftersales:write'];const proof=await f.upload('refund-proof.pdf','QA refund proof',f.claimId);
 const before=await repo.get(testActor(),f.workspaceId),receiptCount=db.receipts.size;
 await expect(repo.execute(testActor(),f.workspaceId,{requestId:'missing-file',expectedRevision:f.getRevision(),command:{type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:[proof.id,'foreign-file']}}})).rejects.toThrow(/附件不存在/);
 expect(await repo.get(testActor(),f.workspaceId)).toEqual(before);expect(db.receipts.size).toBe(receiptCount);
 const input={requestId:'append-case-proof',expectedRevision:f.getRevision(),command:{type:'platform.claim.attachFiles' as const,payload:{id:f.claimId,fileIds:[proof.id]}}};
 const attached=await repo.execute(testActor(),f.workspaceId,input);f.setRevision(attached.workspace.revision);expect((await repo.execute(testActor(),f.workspaceId,input)).replayed).toBe(true);
 await f.run({type:'platform.claim.submit',payload:{id:f.dispositionId}});
 const frozen=(await repo.get(testActor(),f.workspaceId)).state.platform.claims[0].dispositions[0];
 expect(frozen.fileIds).toEqual([f.ci.id]);expect(frozen.reviewFileIds).toEqual([f.ci.id,proof.id]);
 const later=await f.upload('after-submit.pdf','not in the submitted approval',f.claimId);await f.run({type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:[later.id]}});
 const review=(await repo.listReviews(testActor('reviewer'))).find((row:{entityId:string})=>row.entityId===f.dispositionId)!;
 expect(review.fileIds).toEqual([f.ci.id,proof.id]);expect(review.files.map((file:{name:string})=>file.name)).toEqual(['CI-v2.pdf','refund-proof.pdf']);
 expect((await repo.reviewFile(testActor('reviewer'),f.workspaceId,review.id,proof.id)).bytes.toString()).toContain('QA refund proof');
 await expect(repo.reviewFile(testActor('reviewer'),f.workspaceId,review.id,later.id)).rejects.toMatchObject({code:'FILE_NOT_FOUND'});
 await expect(repo.reviewFile(testActor('other'),f.workspaceId,review.id,proof.id)).rejects.toMatchObject({status:404});
 await repo.decideReview(testActor('reviewer'),f.workspaceId,review.id,{requestId:'approve-return-refund',expectedRevision:f.getRevision(),decision:'approved',note:'核对冻结退款事实'});
 const decided=(await repo.get(testActor(),f.workspaceId)).state.platform.claims[0].dispositions[0];expect(decided.snapshot).toBe(frozen.snapshot);expect(decided.reviewFileIds).toEqual(frozen.reviewFileIds);expect(decided.basis).toBe(frozen.basis);
});

it('requires current aftersales authority and rejects attachment changes after case cancellation',async()=>{
 const f=await fixture(),proof=await f.upload('refund-proof.pdf','QA refund proof');
 auth.users.get('owner')!.permissions=auth.users.get('owner')!.permissions.filter(scope=>scope!=='aftersales:write');
 await expect(repo.execute(testActor(),f.workspaceId,{requestId:'no-aftersales-scope',expectedRevision:f.getRevision(),command:{type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:[proof.id]}}})).rejects.toMatchObject({status:403});
 auth.users.get('owner')!.permissions.push('aftersales:write');await f.run({type:'platform.claim.cancel',payload:{id:f.claimId,reason:'客户确认撤销'}});
 const before=await repo.get(testActor(),f.workspaceId);await expect(f.run({type:'platform.claim.attachFiles',payload:{id:f.claimId,fileIds:[proof.id]}})).rejects.toThrow(/已结束/);expect(await repo.get(testActor(),f.workspaceId)).toEqual(before);
});
