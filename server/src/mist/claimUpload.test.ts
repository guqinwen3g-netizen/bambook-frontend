import express from 'express';
import request from 'supertest';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MistRepository,type MistContract} from './repository';
import {MistPrivateFiles} from './files';
import {createMistRouter} from './route';
import {MemoryMistDatabase,testActor,testAuthority,testContract} from './__tests__/support';

// These fixtures isolate upload authority from business workflows; all records
// and bytes live in this test's private in-memory workspace and temp directory.
const contract:MistContract={...testContract,createMistState:(context,seed)=>({...testContract.createMistState(context,seed),platform:{claims:[
 {id:'claim-active',state:'Registered',fileIds:[],dispositions:[{snapshot:'frozen approval',reviewFileIds:['original-proof']}]},
 {id:'claim-second',state:'Processing',fileIds:[],dispositions:[]},
 {id:'claim-closed',state:'Closed',fileIds:[],dispositions:[]},
 {id:'claim-cancelled',state:'Cancelled',fileIds:[],dispositions:[]},
]}} as any)};
let directory:string,db:MemoryMistDatabase,auth:ReturnType<typeof testAuthority>,repo:MistRepository,app:express.Express,workspaceId:string;
const file={name:'return-proof.pdf',mimeType:'application/pdf',bytes:Buffer.from('%PDF-1.4\nlocal claim evidence\n%%EOF')};
const input=(requestId:string,claimId?:string,expectedRevision=0)=>({requestId,expectedRevision,...(claimId===undefined?{}:{claimId})});
beforeEach(async()=>{
 directory=await mkdtemp(path.join(tmpdir(),'mist-claim-upload-'));db=new MemoryMistDatabase();auth=testAuthority();
 repo=new MistRepository(db,contract,new MistPrivateFiles(directory),auth.authorize);
 workspaceId=(await repo.create(testActor(),{name:'Claim upload authority',seed:'empty'})).id;
 app=express();app.use(express.json());app.use('/api/mist',createMistRouter({repository:repo,authenticate:(req,res,next)=>{const id=req.headers['x-test-user'];if(typeof id!=='string'){res.status(401).end();return;}(req as any).actor=testActor(id);next();}}));
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});

it('uploads and replays private target evidence with only current aftersales authority without changing case facts',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:write'];const original=structuredClone(db.workspaces.get(workspaceId).state.platform.claims);
 const saved=await repo.upload(testActor(),workspaceId,input('target-proof','claim-active'),file);
 expect(saved.workspace.revision).toBe(1);expect(saved.receipt.result.claimId).toBe('claim-active');expect(saved.workspace.state.platform.claims).toEqual(original);
 const stored=saved.workspace.state.files[0];expect((await repo.download(testActor(),workspaceId,stored.id)).bytes).toEqual(file.bytes);expect(stored.storageKey).toBe(workspaceId+'/'+stored.id);
 const replay=await repo.upload(testActor(),workspaceId,input('target-proof','claim-active'),file);expect(replay.replayed).toBe(true);expect(replay.receipt).toEqual(saved.receipt);expect(await readdir(path.join(directory,workspaceId))).toHaveLength(1);
});

it.each([{permissions:['products:write']},{permissions:[]}])('refuses target evidence when current scopes are %j',async({permissions})=>{
 auth.users.get('owner')!.permissions=permissions;const before=await repo.get(testActor(),workspaceId),count=db.receipts.size;
 await expect(repo.upload(testActor(),workspaceId,input('denied-target','claim-active'),file)).rejects.toMatchObject({status:403});
 expect(await repo.get(testActor(),workspaceId)).toEqual(before);expect(db.receipts.size).toBe(count);expect(await readdir(directory)).toEqual([]);
});

it('keeps general uploads behind products permission and cannot use claim authority for forged files.add commands',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:write'];
 await expect(repo.upload(testActor(),workspaceId,input('general-denied'),file)).rejects.toMatchObject({status:403});
 await expect(repo.execute(testActor(),workspaceId,{...input('forged-file'),command:{type:'files.add',payload:{file:{name:'forged.pdf'}}}} as any)).rejects.toMatchObject({code:'INVALID_COMMAND'});
 auth.users.get('owner')!.permissions=['products:write'];const uploaded=await repo.upload(testActor(),workspaceId,input('general-allowed'),file);expect(uploaded.receipt.result.claimId).toBeUndefined();expect(uploaded.workspace.revision).toBe(1);
});

it.each(['claim-missing','claim-closed','claim-cancelled'])('rejects unknown or terminal target %s without a file or receipt',async claimId=>{
 auth.users.get('owner')!.permissions=['aftersales:write'];const before=await repo.get(testActor(),workspaceId),count=db.receipts.size;
 await expect(repo.upload(testActor(),workspaceId,input('inactive-target',claimId),file)).rejects.toMatchObject({code:claimId==='claim-missing'?'CLAIM_NOT_FOUND':'CLAIM_CLOSED'});
 expect(await repo.get(testActor(),workspaceId)).toEqual(before);expect(db.receipts.size).toBe(count);expect(await readdir(directory)).toEqual([]);
});

it.each(['',' claim-active','claim-active ',null,0,[],{},'../claim-active','claim\nactive','x'.repeat(121)])('rejects malformed explicit claim target %j rather than falling back to general upload',async claimId=>{
 await expect(repo.upload(testActor(),workspaceId,{requestId:'invalid-target',expectedRevision:0,claimId} as any,file)).rejects.toMatchObject({code:'INVALID_INPUT',status:400});
 expect((await repo.get(testActor(),workspaceId)).revision).toBe(0);expect(await readdir(directory)).toEqual([]);
});

it('binds a target to its owner workspace and refuses a valid claim existing only in another workspace',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:write'];auth.users.get('other')!.permissions=['aftersales:write'];
 const other=await repo.create(testActor('other'),{name:'Other owner',seed:'empty'});db.workspaces.get(other.id).state.platform.claims.push({id:'foreign-only',state:'Registered',fileIds:[],dispositions:[]});
 await expect(repo.upload(testActor(),other.id,input('foreign-workspace','claim-active'),file)).rejects.toMatchObject({status:404});
 await expect(repo.upload(testActor(),workspaceId,input('foreign-target','foreign-only'),file)).rejects.toMatchObject({code:'CLAIM_NOT_FOUND',status:404});
 expect((await repo.get(testActor(),workspaceId)).revision).toBe(0);expect((await repo.get(testActor('other'),other.id)).revision).toBe(0);
});

it('keeps revision checks and target-specific idempotency for identical bytes',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:write'];
 await expect(repo.upload(testActor(),workspaceId,input('stale-target','claim-active',1),file)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 const saved=await repo.upload(testActor(),workspaceId,input('bound-target','claim-active'),file);
 await expect(repo.upload(testActor(),workspaceId,input('bound-target','claim-second'),file)).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
 await expect(repo.upload(testActor(),workspaceId,input('bound-target','claim-active'),{...file,bytes:Buffer.from('changed evidence')})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
 db.workspaces.get(workspaceId).state.platform.claims[0].state='Closed';
 expect((await repo.upload(testActor(),workspaceId,input('bound-target','claim-active'),file)).receipt).toEqual(saved.receipt);
 await expect(repo.upload(testActor(),workspaceId,input('new-after-close','claim-active',1),file)).rejects.toMatchObject({code:'CLAIM_CLOSED'});
 expect(await readdir(path.join(directory,workspaceId))).toHaveLength(1);
});

it('uses claim authority when resolving a durable concurrent upload receipt',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:write'];const transact=db.$transaction.bind(db);let afterCommit=true;
 db.$transaction=async run=>{const result=await transact(run);if(afterCommit){afterCommit=false;throw Object.assign(new Error('concurrent outcome'),{code:'P2034'});}return result;};
 const result=await repo.upload(testActor(),workspaceId,input('concurrent-target','claim-active'),file);
 expect(result.replayed).toBe(true);expect(result.receipt.result.claimId).toBe('claim-active');expect(result.workspace.revision).toBe(1);expect(await readdir(path.join(directory,workspaceId))).toHaveLength(1);
});

it('honors the credential ceiling and rolls back when aftersales authority is revoked during file persistence',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:write'];
 await expect(repo.upload({...testActor(),permissionCeiling:['products:write']},workspaceId,input('ceiling-denied','claim-active'),file)).rejects.toMatchObject({status:403});expect(await readdir(directory)).toEqual([]);
 const storage=new MistPrivateFiles(directory),write=storage.write.bind(storage);storage.write=async(...args)=>{const saved=await write(...args);auth.users.get('owner')!.permissions=[];return saved;};
 const guarded=new MistRepository(db,contract,storage,auth.authorize),before=await repo.get(testActor(),workspaceId),count=db.receipts.size;
 await expect(guarded.upload(testActor(),workspaceId,input('revoked-target','claim-active'),file)).rejects.toMatchObject({status:403});
 expect(await repo.get(testActor(),workspaceId)).toEqual(before);expect(db.receipts.size).toBe(count);expect(await readdir(path.join(directory,workspaceId))).toEqual([]);
});

it('accepts target multipart evidence with only aftersales scope and preserves private download/receipt contracts',async()=>{
 auth.users.get('owner')!.permissions=['aftersales:write'];
 const upload=()=>request(app).post('/api/mist/workspaces/'+workspaceId+'/files').set('x-test-user','owner').field('requestId','http-case-proof').field('expectedRevision','0').field('claimId','claim-active').attach('file',file.bytes,{filename:file.name,contentType:file.mimeType});
 const saved=await upload().expect(201);expect(saved.body.receipt.result.claimId).toBe('claim-active');const id=saved.body.receipt.result.id;
 const downloaded=await request(app).get('/api/mist/workspaces/'+workspaceId+'/files/'+id).set('x-test-user','owner').expect(200);expect(downloaded.body).toEqual(file.bytes);expect(downloaded.headers['cache-control']).toBe('private, no-store');
 expect((await upload().expect(201)).body.replayed).toBe(true);const receipt=await request(app).get('/api/mist/workspaces/'+workspaceId+'/receipts/http-case-proof').set('x-test-user','owner').expect(200);expect(receipt.body.receipt).toEqual(saved.body.receipt);
});

it('refuses malformed multipart claimId and injected upload fields',async()=>{
 for(const fields of [{claimId:''},{claimId:'../claim-active'},{claimId:'claim-active',permission:'products:write'}]){
  let uploading=request(app).post('/api/mist/workspaces/'+workspaceId+'/files').set('x-test-user','owner').field('requestId','malformed-http').field('expectedRevision','0');
  for(const [key,value] of Object.entries(fields))uploading=uploading.field(key,value);
  await uploading.attach('file',file.bytes,file.name).expect(400);
 }
 expect((await repo.get(testActor(),workspaceId)).revision).toBe(0);expect(await readdir(directory)).toEqual([]);
});
