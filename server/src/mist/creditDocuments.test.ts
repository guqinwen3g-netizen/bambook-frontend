import express from 'express';
import request from 'supertest';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as contract from '../shared/mistWorkspace';
import {MistRepository,type MistCommandRequest} from './repository';
import {MistPrivateFiles} from './files';
import {buildIssueArchive} from './creditPrint';
import {createMistRouter} from './route';
import {MistLocalDatabase} from './local';
import {MemoryMistDatabase,testActor,testAuthority} from './__tests__/support';
import {frozenCreditDocumentFixture,appendFrozenCreditDocumentV2,CREDIT_DOCUMENT_IDS as ids,CREDIT_DOCUMENT_NOW as now} from './__tests__/creditDocumentsFixture';

let directory:string,db:MemoryMistDatabase,auth:ReturnType<typeof testAuthority>,files:MistPrivateFiles,repo:MistRepository,workspaceId:string,app:express.Express;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const pdfBytes=Buffer.concat([Buffer.from('%PDF-1.4\nSynthetic local contract test only\n'),Buffer.from([0,255,128]),Buffer.from('\n%%EOF')]);
const renderPdf=vi.fn(async(_html:string)=>({pdf:pdfBytes,sha:digest(pdfBytes),bytes:pdfBytes.length,generatedAt:now,format:'A4'}));
const builder=vi.fn((snapshot:Parameters<typeof buildIssueArchive>[0],options?:{draft?:boolean})=>buildIssueArchive(snapshot,{...options,renderPdf}));
const issue=(requestId='issue-v1',expectedRevision=0):MistCommandRequest=>({requestId,expectedRevision,command:{type:'platform.credit.issue',payload:{creditId:ids.credit,versionId:ids.source}}});
const state=()=>db.workspaces.get(workspaceId).state as contract.MistState;
const credit=()=>state().platform.credits.find(row=>row.id===ids.credit)!;
const names=()=>readdir(path.join(directory,workspaceId));
const url=(versionId:string,kind:'preview'|'document',creditId=ids.credit)=>`/api/mist/workspaces/${workspaceId}/credits/${creditId}/versions/${versionId}/${kind}.pdf`;
const binary=(response:any,done:(error:Error|null,body?:Buffer)=>void)=>{const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(Buffer.from(chunk)));response.on('end',()=>done(null,Buffer.concat(chunks)));response.on('error',done);};
beforeEach(async()=>{
 directory=await mkdtemp(path.join(tmpdir(),'mist-credit-document-'));db=new MemoryMistDatabase();auth=testAuthority();auth.users.get('owner')!.permissions=['aftersales:read','aftersales:write'];auth.users.get('other')!.permissions=['aftersales:read','aftersales:write'];files=new MistPrivateFiles(directory);renderPdf.mockClear();builder.mockClear();
 repo=new MistRepository(db,contract,files,auth.authorize,()=>new Date(now),builder);workspaceId=(await repo.create(testActor(),{name:'独立CN契约测试空间',seed:'empty'})).id;
 const proof=await files.write(workspaceId,{name:'trusted-approval-proof.pdf',mimeType:'application/pdf',bytes:Buffer.from('%PDF-1.4\nExplicit frozen approval fixture proof\n%%EOF')},now);db.workspaces.get(workspaceId).state=frozenCreditDocumentFixture(proof);
 app=express();app.use(express.json());app.use('/api/mist',createMistRouter({repository:repo,authenticate:(req,res,next)=>{const id=req.headers['x-test-user'];if(typeof id!=='string'){res.status(401).end();return;}(req as any).actor=testActor(id);next();}}));
});
afterEach(async()=>{vi.restoreAllMocks();await rm(directory,{recursive:true,force:true});});

it('atomically archives private bytes, printVersion and receipt; the original request replays without another render',async()=>{
 const original=structuredClone(state()),result=await repo.execute(testActor(),workspaceId,issue()),version=credit().printVersions![0];expect(result.workspace.revision).toBe(1);expect(result.receipt.result).toMatchObject({creditId:ids.credit,versionId:version.id,fileId:version.fileId});expect(credit().printVersions).toHaveLength(1);expect(await names()).toHaveLength(2);expect(db.receipts.size).toBe(2);expect(version).toMatchObject({sourceVersionId:ids.source,sha256:digest(pdfBytes),bytes:pdfBytes.length});expect(await files.read(workspaceId,state().files.find(file=>file.id===version.fileId)!)).toEqual(pdfBytes);expect(original.files).toHaveLength(1);expect(original.platform.credits[0].printVersions).toBeUndefined();
 const replay=await repo.execute(testActor(),workspaceId,issue());expect(replay.replayed).toBe(true);expect(replay.receipt).toEqual(result.receipt);expect(renderPdf).toHaveBeenCalledOnce();expect(builder).toHaveBeenCalledOnce();expect(await names()).toHaveLength(2);
 await expect(repo.execute(testActor(),workspaceId,issue('same-source-new-request',1))).rejects.toMatchObject({code:'CREDIT_ALREADY_ISSUED',status:409});expect(renderPdf).toHaveBeenCalledOnce();expect(credit().printVersions).toHaveLength(1);
});

it.each(['company','source','approval','file','amount'] as const)('refuses damaged %s prerequisites before rendering or writing any new document',async kind=>{
 if(kind==='company')delete state().settings.companyProfile;if(kind==='source')credit().sourceVersions=[];if(kind==='approval')state().platform.claims[0].dispositions[0].decisionNote='not the frozen approval';if(kind==='file')state().files=[];if(kind==='amount')credit().currentAmount=16;
 const before=structuredClone(state()),receipts=db.receipts.size;await expect(repo.execute(testActor(),workspaceId,issue())).rejects.toMatchObject({status:422});expect(renderPdf).not.toHaveBeenCalled();expect(state()).toEqual(before);expect(db.receipts.size).toBe(receipts);expect(await names()).toHaveLength(1);
});

it.each([{html:'client HTML'},{amount:999},{signature:'forged signature'},{file:{id:'forged'}}])('refuses client document overrides %j before render or persistence',async forged=>{
 const request=issue();request.command={type:'platform.credit.issue',payload:{creditId:ids.credit,versionId:ids.source,...forged}} as any;const before=structuredClone(state());await expect(repo.execute(testActor(),workspaceId,request)).rejects.toMatchObject({status:422});expect(renderPdf).not.toHaveBeenCalled();expect(state()).toEqual(before);expect(await names()).toHaveLength(1);
});

it('keeps the original state and receipt set when PDF rendering fails',async()=>{
 renderPdf.mockRejectedValueOnce(new Error('synthetic renderer failure'));const before=structuredClone(state()),count=db.receipts.size;await expect(repo.execute(testActor(),workspaceId,issue())).rejects.toThrow('synthetic renderer failure');expect(state()).toEqual(before);expect(db.receipts.size).toBe(count);expect(await names()).toHaveLength(1);
});

it('does not save a print fact when private file persistence fails',async()=>{
 vi.spyOn(files,'write').mockRejectedValueOnce(new Error('private file unavailable'));const before=structuredClone(state()),count=db.receipts.size;await expect(repo.execute(testActor(),workspaceId,issue())).rejects.toThrow('private file unavailable');expect(state()).toEqual(before);expect(db.receipts.size).toBe(count);expect(await names()).toHaveLength(1);
});

it('cleans the rendered blob after a confirmed transactional receipt rollback',async()=>{
 db.failReceipt=true;const before=structuredClone(state()),count=db.receipts.size;await expect(repo.execute(testActor(),workspaceId,issue())).rejects.toThrow('transaction failed');expect(renderPdf).toHaveBeenCalledOnce();expect(state()).toEqual(before);expect(db.receipts.size).toBe(count);expect(await names()).toHaveLength(1);
});

it('retains a possibly committed archive after an unknown result and recovers its exact receipt without rendering again',async()=>{
 const transact=db.$transaction.bind(db);let failAfterCommit=true;db.$transaction=async run=>{const result=await transact(run);if(failAfterCommit){failAfterCommit=false;throw new Error('unknown committed connection result');}return result;};
 await expect(repo.execute(testActor(),workspaceId,issue())).rejects.toThrow('unknown committed connection result');expect(credit().printVersions).toHaveLength(1);expect(await names()).toHaveLength(2);const receipt=await repo.receipt(testActor(),workspaceId,'issue-v1');expect(receipt.result.fileId).toBe(credit().printVersions![0].fileId);expect((await repo.execute(testActor(),workspaceId,issue())).replayed).toBe(true);expect(renderPdf).toHaveBeenCalledOnce();
});

it('retains the private blob if rollback cannot be confirmed because the durable receipt lookup is unavailable',async()=>{
 db.failReceipt=true;vi.spyOn(db,'mistCommandReceipt','get').mockReturnValue({findUnique:async()=>{throw new Error('receipt lookup unavailable');},create:async()=>{throw new Error('not used');}} as any);await expect(repo.execute(testActor(),workspaceId,issue())).rejects.toThrow('transaction failed');expect(credit().printVersions).toBeUndefined();expect(await names()).toHaveLength(2);expect(renderPdf).toHaveBeenCalledOnce();
});

it('uses current aftersales write scope and credential ceiling for issue; read alone only allows read-only draft preview',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:read'];await expect(repo.execute(testActor(),workspaceId,issue())).rejects.toMatchObject({status:403});expect(renderPdf).not.toHaveBeenCalled();const before=structuredClone(state()),receipts=db.receipts.size;const preview=await repo.previewCreditDocument(testActor(),workspaceId,ids.credit,ids.source);expect(preview.name).toBe('CLM-2026-900002-v1-DRAFT.pdf');expect(preview.bytes).toEqual(pdfBytes);expect(renderPdf.mock.calls[0][0]).toContain('DRAFT');expect(state()).toEqual(before);expect(db.receipts.size).toBe(receipts);expect(await names()).toHaveLength(1);
 auth.users.get('owner')!.permissions=['aftersales:read','aftersales:write'];await expect(repo.execute({...testActor(),permissionCeiling:['aftersales:read']},workspaceId,issue())).rejects.toMatchObject({status:403});expect(renderPdf).toHaveBeenCalledOnce();await expect(repo.previewCreditDocument({...testActor(),permissionCeiling:['aftersales:write']},workspaceId,ids.credit,ids.source)).rejects.toMatchObject({status:403});
});

it('rechecks current authority after rendering and rolls back the file and print fact when write permission is revoked',async()=>{
 builder.mockImplementationOnce(async(snapshot,options)=>{const prepared=await buildIssueArchive(snapshot,{...options,renderPdf});auth.users.get('owner')!.permissions=['aftersales:read'];return prepared;});const before=structuredClone(state());await expect(repo.execute(testActor(),workspaceId,issue())).rejects.toMatchObject({status:403});expect(state()).toEqual(before);expect(await names()).toHaveLength(1);
});

it('denies another owner workspace and refuses stale issue revisions without rendering',async()=>{
 await expect(repo.execute(testActor('other'),workspaceId,issue())).rejects.toMatchObject({status:404});await expect(repo.previewCreditDocument(testActor('other'),workspaceId,ids.credit,ids.source)).rejects.toMatchObject({status:404});await expect(repo.execute(testActor(),workspaceId,issue('stale-issue',3))).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(renderPdf).not.toHaveBeenCalled();expect(await names()).toHaveLength(1);
});

it('does not treat write scope as read scope when previewing or downloading a document',async()=>{
 await repo.execute(testActor(),workspaceId,issue());const version=credit().printVersions![0];auth.users.get('owner')!.permissions=['aftersales:write'];await expect(repo.previewCreditDocument(testActor(),workspaceId,ids.credit,ids.source)).rejects.toMatchObject({status:403});await expect(repo.downloadCreditDocument(testActor(),workspaceId,ids.credit,version.id)).rejects.toMatchObject({status:403});expect(renderPdf).toHaveBeenCalledOnce();
});

it('rejects a printVersion belonging to another existing credit even when both credits have real private archives',async()=>{
 await repo.execute(testActor(),workspaceId,issue());const first=credit().printVersions![0],otherCredit=structuredClone(credit()),otherClaim=structuredClone(state().platform.claims[0]);
 otherCredit.id='second-credit';otherCredit.code='CLM-2026-900004';otherCredit.claimId='second-case';otherCredit.dispositionId='second-disposition';otherCredit.printVersions=[];otherCredit.currentVersionId='second-source-v1';
 const source=otherCredit.sourceVersions![0];source.id='second-source-v1';source.claimId='second-case';source.claimCode='CLM-2026-900003';source.lines[0].dispositionId='second-disposition';
 otherClaim.id='second-case';otherClaim.code=source.claimCode;otherClaim.dispositions[0].id='second-disposition';otherClaim.dispositions[0].creditNoteId=otherCredit.id;state().platform.claims.push(otherClaim);state().platform.credits.push(otherCredit);
 await repo.execute(testActor(),workspaceId,{requestId:'second-credit-issue',expectedRevision:1,command:{type:'platform.credit.issue',payload:{creditId:otherCredit.id,versionId:otherCredit.currentVersionId}}});const second=state().platform.credits.find(row=>row.id===otherCredit.id)!.printVersions![0];expect(second.fileId).not.toBe(first.fileId);expect(second.id).not.toBe(first.id);
 await expect(repo.downloadCreditDocument(testActor(),workspaceId,otherCredit.id,first.id)).rejects.toMatchObject({code:'CREDIT_DOCUMENT_NOT_FOUND',status:404});await expect(repo.downloadCreditDocument(testActor(),workspaceId,ids.credit,second.id)).rejects.toMatchObject({code:'CREDIT_DOCUMENT_NOT_FOUND',status:404});expect(renderPdf).toHaveBeenCalledTimes(2);expect(await names()).toHaveLength(3);
});

it('downloads immutable issued V1 bytes after company, balances and the current source version change, without re-rendering',async()=>{
 await repo.execute(testActor(),workspaceId,issue());const issued=structuredClone(credit().printVersions![0]),oldSource=structuredClone(credit().sourceVersions![0]);let later=appendFrozenCreditDocumentV2(state());later.settings.companyProfile!.legalName='后来变更的公司抬头';later.settings.companyProfile!.address='后来变更的地址';later.platform.creditApplications.push({id:'later-credit-application',creditId:ids.credit,invoiceId:ids.invoice,amount:5,at:now,actor:'本地模拟财务'});db.workspaces.get(workspaceId).state=later;
 const document=await repo.downloadCreditDocument(testActor(),workspaceId,ids.credit,issued.id);expect(document.bytes).toEqual(pdfBytes);expect(document.sha256).toBe(issued.sha256);expect(renderPdf).toHaveBeenCalledOnce();expect(builder).toHaveBeenCalledOnce();expect(credit().printVersions![0]).toEqual(issued);expect(credit().sourceVersions![0]).toEqual(oldSource);
 await expect(repo.previewCreditDocument(testActor(),workspaceId,ids.credit,ids.source)).rejects.toMatchObject({status:422});expect(renderPdf).toHaveBeenCalledOnce();
});

it('refuses same-size byte tampering and never renders a replacement from live company data',async()=>{
 await repo.execute(testActor(),workspaceId,issue());const version=credit().printVersions![0],changed=Buffer.from(pdfBytes);changed[12]^=1;await writeFile(path.join(directory,workspaceId,version.fileId),changed);await expect(repo.downloadCreditDocument(testActor(),workspaceId,ids.credit,version.id)).rejects.toMatchObject({code:'CREDIT_DOCUMENT_PRECONDITION',status:422});await request(app).get(url(version.id,'document')).set('x-test-user','owner').expect(422);expect(renderPdf).toHaveBeenCalledOnce();expect(credit().printVersions).toHaveLength(1);
});

it('refuses print/source identity or frozen-source tampering before reading a private file',async()=>{
 await repo.execute(testActor(),workspaceId,issue());const version=credit().printVersions![0],read=vi.spyOn(files,'read');credit().sourceVersions![0].reason='tampered frozen history';await expect(repo.downloadCreditDocument(testActor(),workspaceId,ids.credit,version.id)).rejects.toMatchObject({code:'CREDIT_DOCUMENT_INVALID',status:422});expect(read).not.toHaveBeenCalled();expect(renderPdf).toHaveBeenCalledOnce();
});

it('serves HTTP draft preview without issuing facts and checks MIME, cache, filename and bytes',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:read'];const before=structuredClone(state()),response=await request(app).get(url(ids.source,'preview')).set('x-test-user','owner').buffer(true).parse(binary).expect(200).expect('Content-Type',/application\/pdf/).expect('Cache-Control','private, no-store').expect('X-Content-Type-Options','nosniff');expect(response.body).toEqual(pdfBytes);expect(response.headers['content-disposition']).toBe("attachment; filename*=UTF-8''CLM-2026-900002-v1-DRAFT.pdf");expect(response.headers['x-document-sha256']).toBe(digest(pdfBytes));expect(state()).toEqual(before);expect(credit().printVersions).toBeUndefined();expect(await names()).toHaveLength(1);
});

it('issues once through HTTP and serves the exact archived printVersion ID rather than a sourceVersion or another credit',async()=>{
 const issued=await request(app).post(`/api/mist/workspaces/${workspaceId}/commands`).set('x-test-user','owner').send(issue()).expect(200),print=credit().printVersions![0];expect(issued.body.receipt.result.versionId).toBe(print.id);const replay=await request(app).post(`/api/mist/workspaces/${workspaceId}/commands`).set('x-test-user','owner').send(issue()).expect(200);expect(replay.body.replayed).toBe(true);
 auth.users.get('owner')!.permissions=['aftersales:read'];const response=await request(app).get(url(print.id,'document')).set('x-test-user','owner').buffer(true).parse(binary).expect(200).expect('Content-Type',/application\/pdf/).expect('Cache-Control','private, no-store').expect('X-Content-Type-Options','nosniff');expect(response.body).toEqual(pdfBytes);expect(response.headers['x-document-sha256']).toBe(print.sha256);expect(response.headers['content-disposition']).toBe("attachment; filename*=UTF-8''CLM-2026-900002-v1.pdf");
 await request(app).get(url(ids.source,'document')).set('x-test-user','owner').expect(404);await request(app).get(url(print.id,'document','different-credit')).set('x-test-user','owner').expect(404);await request(app).get(url(print.id,'document')).set('x-test-user','other').expect(404);expect(renderPdf).toHaveBeenCalledOnce();
});

it('rejects malformed HTTP client HTML/amount overrides without persisting or rendering a document',async()=>{
 await request(app).post(`/api/mist/workspaces/${workspaceId}/commands`).set('x-test-user','owner').send({...issue(),command:{type:'platform.credit.issue',payload:{creditId:ids.credit,versionId:ids.source,html:'<script>client</script>',amount:999}}}).expect(422);expect(renderPdf).not.toHaveBeenCalled();expect(await names()).toHaveLength(1);expect(credit().printVersions).toBeUndefined();
});

it('serves byte-exact preview and issued PDF through the real local transaction clone instead of JSON numeric keys',async()=>{
 const localDb=new MistLocalDatabase(path.join(directory,'isolated-local-store'));await localDb.ready;
 const localFiles=new MistPrivateFiles(path.join(directory,'isolated-local-files')),localRepo=new MistRepository(localDb,contract,localFiles,auth.authorize,()=>new Date(now),builder),workspace=await localRepo.create(testActor(),{name:'独立Local clone字节回归',seed:'empty'});
 const proof=await localFiles.write(workspace.id,{name:'local-frozen-proof.pdf',mimeType:'application/pdf',bytes:Buffer.from('%PDF-1.4\nLocal fixture evidence\n%%EOF')},now);
 await localDb.$transaction(tx=>tx.mistWorkspace.update({where:{id:workspace.id},data:{state:frozenCreditDocumentFixture(proof)}}));
 const localApp=express();localApp.use(express.json());localApp.use('/api/mist',createMistRouter({repository:localRepo,authenticate:(req,_res,next)=>{(req as any).actor=testActor();next();}}));
 const clonedPreview=await localRepo.previewCreditDocument(testActor(),workspace.id,ids.credit,ids.source);expect(clonedPreview.bytes).toBeInstanceOf(Uint8Array);expect(Buffer.isBuffer(clonedPreview.bytes)).toBe(false);expect(Buffer.from(clonedPreview.bytes)).toEqual(pdfBytes);
 const prefix=`/api/mist/workspaces/${workspace.id}/credits/${ids.credit}/versions/`,preview=await request(localApp).get(prefix+ids.source+'/preview.pdf').buffer(true).parse(binary).expect(200).expect('Content-Type',/application\/pdf/);
 expect(preview.body.subarray(0,5).toString()).toBe('%PDF-');expect(preview.body.length).toBe(pdfBytes.length);expect(preview.body).toEqual(pdfBytes);expect(digest(preview.body)).toBe(digest(pdfBytes));expect(preview.headers['x-document-sha256']).toBe(digest(preview.body));
 const issued=await request(localApp).post(`/api/mist/workspaces/${workspace.id}/commands`).send(issue()).expect(200),versionId=issued.body.receipt.result.versionId;
 const clonedIssued=await localRepo.downloadCreditDocument(testActor(),workspace.id,ids.credit,versionId);expect(clonedIssued.bytes).toBeInstanceOf(Uint8Array);expect(Buffer.isBuffer(clonedIssued.bytes)).toBe(false);
 const document=await request(localApp).get(prefix+versionId+'/document.pdf').buffer(true).parse(binary).expect(200).expect('Content-Type',/application\/pdf/).expect('Cache-Control','private, no-store');
 expect(document.body.subarray(0,5).toString()).toBe('%PDF-');expect(document.body.length).toBe(pdfBytes.length);expect(document.body).toEqual(pdfBytes);expect(digest(document.body)).toBe(digest(pdfBytes));expect(document.headers['x-document-sha256']).toBe(digest(document.body));
 const after=await localRepo.get(testActor(),workspace.id);expect(after.state.platform.credits[0].printVersions).toHaveLength(1);expect(after.revision).toBe(1);
});
