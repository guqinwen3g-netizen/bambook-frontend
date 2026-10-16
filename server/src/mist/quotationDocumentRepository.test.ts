import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as contract from '../shared/mistWorkspace';
import {applyMarketCommand,type MarketState,type MarketCommand} from '../shared/mistMarket';
import {MistRepository,type MistCommandRequest} from './repository';
import {MistPrivateFiles} from './files';
import {MemoryMistDatabase,testActor,testAuthority} from './__tests__/support';

// 审批路由依赖真实用户表；本测试只验证报价单生成链路，固定业务审批人。
vi.mock('./context',()=>({mistApprovalAuthority:async()=>({supplier:{},businessReviewerId:'leader'})}));

const now='2026-10-13T08:00:00.000Z';
const company={legalName:'杭州竹语纺织有限公司',englishName:'Hangzhou Bamboo Textile Co., Ltd.',address:'杭州市西湖区 1 号',englishAddress:'No.1 Xihu, Hangzhou',phone:'0571-1',email:'sales@example.com',taxId:'T1',customsCode:'C1',bankName:'B',bankAccount:'A',swift:'S',defaultCurrency:'USD'};
let directory:string,db:MemoryMistDatabase,auth:ReturnType<typeof testAuthority>,files:MistPrivateFiles,repo:MistRepository,workspaceId:string,quoteId:string;
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const renderPdf=vi.fn(async(html:string)=>{const pdf=Buffer.from('%PDF-1.4\n'+digest(Buffer.from(html))+'\n%%EOF');return {pdf,sha:digest(pdf),bytes:pdf.length,generatedAt:now,format:'A4'};});
const state=()=>db.workspaces.get(workspaceId).state as contract.MistState&{market:MarketState};
const quote=()=>state().market.quotations.find(q=>q.id===quoteId)!;
const names=async()=>(await readdir(path.join(directory,workspaceId)).catch(()=>[] as string[]));
const doc=(requestId:string,expectedRevision:number,payload:Record<string,unknown>={id:quoteId,draft:false}):MistCommandRequest=>({requestId,expectedRevision,command:{type:'market.quotation.document',payload} as never});

beforeEach(async()=>{
 directory=await mkdtemp(path.join(tmpdir(),'mist-quote-doc-'));db=new MemoryMistDatabase();auth=testAuthority();auth.users.get('owner')!.permissions=['quotations:read','quotations:write'];files=new MistPrivateFiles(directory);renderPdf.mockClear();
 repo=new MistRepository(db,contract,files,auth.authorize,()=>new Date(now),undefined,renderPdf);workspaceId=(await repo.create(testActor(),{name:'报价单仓储测试空间',seed:'empty'})).id;
 const s=state();s.settings.companyProfile={...company} as never;let n=0;const ctx={id:()=>`seed-${++n}`,now,actorName:'业务员',actorId:'owner',authority:{supplier:{},businessReviewerId:'leader'}} as contract.MistContext;
 if(!s.customers.length)s.customers.push({id:'cust-1',name:'Acme Textiles',active:true} as never);
 const run=(c:MarketCommand)=>applyMarketCommand(s,c,ctx);
 const productId=run({type:'market.product.save',payload:{input:{sku:'P-REPO-1',name:'竹纤维平纹布',category:'fabric',season:'AW26',supplierId:'',supplierCode:'',composition:'竹纤维 70% 棉 30%',specification:'150cm',color:'蓝',unit:'米',cost:'1.00',currency:'USD',sourceDevId:'',sourceVersionId:''}}} as never).id!;
 quoteId=run({type:'market.quotation.save',payload:{input:{customerId:s.customers[0].id,currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB Ningbo',paymentTerms:'T/T',note:'',lines:[{productId,sourceDevId:'',sourceVersionId:'',name:'竹纤维平纹布',style:'P-REPO',specification:'150cm',qty:'800',unit:'米',price:'2.50',cost:'1.00',specs:{}}]}}} as never).id!;
});
afterEach(async()=>{vi.restoreAllMocks();await rm(directory,{recursive:true,force:true});});

it('renders on the server, writes the private PDF and records the document atomically; replay does not render again',async()=>{
 const result=await repo.execute(testActor(),workspaceId,doc('doc-1',0));
 expect(result.workspace.revision).toBe(1);expect(renderPdf).toHaveBeenCalledOnce();expect(renderPdf.mock.calls[0][0]).toContain(quote().code);
 const record=quote().documents![0];expect(record).toMatchObject({quotationId:quoteId,draft:false});
 const file=state().files.find(f=>f.id===record.fileId)!;expect(file).toMatchObject({name:record.fileName,mimeType:'application/pdf'});
 expect((await files.read(workspaceId,file)).subarray(0,8).toString()).toBe('%PDF-1.4');expect(await names()).toHaveLength(1);
 const replay=await repo.execute(testActor(),workspaceId,doc('doc-1',0));expect(replay.replayed).toBe(true);expect(renderPdf).toHaveBeenCalledOnce();
 await repo.execute(testActor(),workspaceId,doc('doc-2',1,{id:quoteId,draft:true}));expect(quote().documents!.map(d=>d.draft)).toEqual([false,true]);expect(await names()).toHaveLength(2);
});

it.each([{html:'<h1>client</h1>'},{snapshot:{total:'1'}},{fileId:'forged'}])('refuses client overrides %j before render or persistence',async forged=>{
 const before=structuredClone(state());await expect(repo.execute(testActor(),workspaceId,doc('forged',0,{id:quoteId,draft:false,...forged}))).rejects.toMatchObject({status:422});
 expect(renderPdf).not.toHaveBeenCalled();expect(state()).toEqual(before);expect(await names()).toHaveLength(0);
});

it('requires quotations:write and leaves state untouched without it',async()=>{
 auth.users.get('owner')!.permissions=['quotations:read'];const before=structuredClone(state());
 await expect(repo.execute(testActor(),workspaceId,doc('no-perm',0))).rejects.toMatchObject({status:403});expect(renderPdf).not.toHaveBeenCalled();expect(state()).toEqual(before);
});

it('blocks generation without company profile and rolls back when rendering or file write fails',async()=>{
 delete (state().settings as any).companyProfile;let before=structuredClone(state());
 await expect(repo.execute(testActor(),workspaceId,doc('no-company',0))).rejects.toMatchObject({status:422});expect(renderPdf).not.toHaveBeenCalled();expect(state()).toEqual(before);
 state().settings.companyProfile={...company} as never;before=structuredClone(state());
 renderPdf.mockRejectedValueOnce(new Error('synthetic renderer failure'));await expect(repo.execute(testActor(),workspaceId,doc('render-fail',0))).rejects.toMatchObject({code:'QUOTATION_PDF_UNAVAILABLE',status:422});expect(state()).toEqual(before);expect(await names()).toHaveLength(0);
 vi.spyOn(files,'write').mockRejectedValueOnce(new Error('private file unavailable'));await expect(repo.execute(testActor(),workspaceId,doc('write-fail',0))).rejects.toThrow('private file unavailable');expect(state()).toEqual(before);expect(quote().documents).toBeUndefined();
});
