/** Genuine prior composite producer shape: actual legacy assembly, exact old registration snapshot/audits.
 * Current full index reads only. No writer revival, native proof or old-file certification. */
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import cp,{type ChildProcess} from 'node:child_process';
import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import request from 'supertest';
import {PDFParse} from 'pdf-parse';import JSZip from 'jszip';
const sandbox=process.env.BAMBOOK_ACCEPTANCE_SANDBOX!,markerPath=process.env.BAMBOOK_MERGED_PL_DB_MARKER!;
assert(sandbox&&sandbox.startsWith('/private/tmp/bambook-merged-pl-native-'));assert.equal(markerPath,path.join(sandbox,'PRIVATE-PG-MARKER.json'));
const marker=JSON.parse(fs.readFileSync(markerPath,'utf8')),url=new URL(process.env.DATABASE_URL!);
assert.equal(process.env.DB_ENV,'acceptance-private');assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.BAMBOOK_NO_SCHEDULER,'1');
assert(marker.authorized&&marker.root===sandbox&&fs.realpathSync(sandbox)===sandbox);assert.equal(marker.directory,sandbox+'/postgres');assert.equal(fs.realpathSync(marker.directory),marker.directory);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'acceptance');assert.equal(url.password,'');assert.equal(url.port,String(marker.port));assert.equal(url.pathname,'/'+marker.name);assert(/^bambook_acceptance_[a-f0-9]{12}$/.test(marker.name));
assert.equal(process.env.BAMBOOK_ACCEPTANCE_DB_PORT,String(marker.port));assert.equal(process.env.BAMBOOK_ACCEPTANCE_UI_API_PORT,String(marker.apiPort));
const {Prisma,PrismaClient}=require('@prisma/client') as typeof import('@prisma/client');const prisma=new PrismaClient(),db=()=>prisma;
const {createAuthService}=require('../dist/auth/service') as typeof import('../src/auth/service');
const {loadUserWithRoles,buildLoadedAuthTokenPayload}=require('../dist/auth/tokenHelpers') as typeof import('../src/auth/tokenHelpers');
const origin='http://127.0.0.1:'+marker.apiPort,base='/api/v1/customs/trade-documents',prefix='acceptance-merged-'+randomUUID();
let api:ChildProcess|undefined,seq=0;const observations:any[]=[];const control=sandbox+'/merged-controls.json';
const configure=(value:any)=>fs.writeFileSync(control,JSON.stringify(value));const diagnostic=(value:any)=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v);
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const binary=(res:any,done:any)=>{const chunks:Buffer[]=[];res.on('data',(x:Buffer)=>chunks.push(x));res.on('end',()=>done(null,Buffer.concat(chunks)));};
const text=async(bytes:Buffer)=>{const parser=new PDFParse({data:bytes});try{return(await parser.getText()).text.replace(/\s+/g,' ');}finally{await parser.destroy();}};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
beforeAll(async()=>{
 const [identity]=await db().$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');return tx.$queryRawUnsafe<any[]>("SELECT current_database() AS name, inet_server_port() AS port, current_setting('data_directory') AS directory");});expect(identity).toEqual({name:marker.name,port:marker.port,directory:marker.directory});
 const preload=sandbox+'/before-prisma.cjs';
 fs.writeFileSync(preload,`const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict'),Module=require('module');const m=JSON.parse(fs.readFileSync(${JSON.stringify(markerPath)}));const u=new URL(process.env.DATABASE_URL);assert.equal(process.env.DB_ENV,'acceptance-private');assert.equal(process.env.BAMBOOK_NO_SCHEDULER,'1');assert.equal(process.env.BAMBOOK_REQUIRE_AUTH,'true');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,String(m.port));assert.equal(u.pathname,'/'+m.name);assert.equal(process.env.PORT,String(m.apiPort));const identity=cp.execFileSync(m.pg+'/psql',['-h','127.0.0.1','-p',String(m.port),'-U','acceptance','-d',m.name,'-X','-Atq','-c',"BEGIN READ ONLY; SELECT current_database()||'|'||inet_server_port()||'|'||current_setting('data_directory'); COMMIT;"],{encoding:'utf8'}).trim();assert.equal(identity,m.name+'|'+m.port+'|'+m.directory);
 const load=Module._load,seen=new WeakMap(),control=m.root+'/merged-controls.json';let CorePrisma;const read=()=>fs.existsSync(control)?JSON.parse(fs.readFileSync(control)):{};
 function wrap(t){return new Proxy(t,{get(target,k){if(k==='$transaction'&&typeof target.$transaction==='function')return async(fn,opts)=>{const result=await target.$transaction(typeof fn==='function'?tx=>fn(wrap(tx)):fn,opts);const c=read();if(c.lostACK&&result?.receipt?.operation==='save_merged_packing_list_version'&&!result.replayed){c.lostACK=false;fs.writeFileSync(control,JSON.stringify(c));throw new Error('PRIVATE lost committed ACK');}return result;};const value=Reflect.get(target,k,target);if(value&&typeof value==='object'&&['auditLog','shipment','order','orderLine'].includes(k))return new Proxy(value,{get(d,method){const fn=Reflect.get(d,method,d);if(typeof fn!=='function')return fn;return async args=>{const c=read();if(k==='auditLog'&&method==='create'&&args?.data?.action==='MERGED_PACKING_LIST_VERSION'&&c.auditFault)throw new Error('PRIVATE mandatory audit SQL failure');if(k==='shipment'&&method==='findUnique'&&c.sourceFault)throw Object.assign(new Error('PRIVATE SQL SELECT hidden'),{code:'CONFLICT',statusCode:409});const value=await fn.call(d,args);if(k==='orderLine'&&method==='findMany'&&c.legacyParentFault)throw new Error('PRIVATE SQL legacy parent SELECT');if(k==='order'&&method==='findFirst'&&c.lateLegacyOrder&&value?.id===c.lateLegacyOrder){c.lateLegacyOrder=null;fs.writeFileSync(control,JSON.stringify(c));const peer=new CorePrisma();try{await peer.order.update({where:{id:value.id},data:{ownerId:c.lateLegacyOwner}});if(value.customerRelationId)await peer.relation.update({where:{id:value.customerRelationId},data:{ownerId:c.lateLegacyOwner,salesRepIds:[]}});}finally{await peer.$disconnect();}}return value;};}});return typeof value==='function'?value.bind(target):value;}});}
 Module._load=function(id,parent,main){const e=load.apply(this,arguments);if(id!=='@prisma/client'||!e.PrismaClient)return e;if(seen.has(e))return seen.get(e);CorePrisma=e.PrismaClient;class Guarded extends e.PrismaClient{constructor(...args){super(...args);return wrap(this);}}const out={...e,PrismaClient:Guarded};seen.set(e,out);return out;};`);
 configure({});const log=fs.openSync(sandbox+'/actual-index.log','w');api=cp.spawn(process.execPath,[path.resolve('dist/index.js')],{cwd:process.cwd(),env:{...process.env,PORT:String(marker.apiPort),BAMBOOK_REQUIRE_AUTH:'true',BAMBOOK_DEV_PANEL:'false',BUILD_SHA:'private-merged-pl',NODE_OPTIONS:'--require='+preload+' --require='+path.resolve('../scripts/acceptance-network-guard.cjs')},stdio:['ignore',log,log]});fs.closeSync(log);
 let ready=false;for(let i=0;i<100;i++){try{const res=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(300)});if(res.ok){const b:any=await res.json();expect(b.database).toBe('ok');expect(b.authRequired).toBe(true);ready=true;break;}}catch{}await wait(50);}expect(ready).toBe(true);
 await db().role.upsert({where:{id:'role-sales'},create:{id:'role-sales',name:'Synthetic Sales actual scope',isSystem:true},update:{}});
 for(const scope of ['orders:read','orders:write','shipments:read','shipments:write','customs:read','customs:write']){const permission=await db().permission.upsert({where:{scope},create:{id:prefix+'-'+scope,scope},update:{}});await db().rolePermission.upsert({where:{roleId_permissionId:{roleId:'role-sales',permissionId:permission.id}},create:{id:prefix+'-rp-'+scope,roleId:'role-sales',permissionId:permission.id},update:{}});}
});
beforeEach(()=>configure({}));
afterAll(async()=>{configure({});if(api){api.kill('SIGTERM');for(let i=0;i<40&&api.exitCode===null&&api.signalCode===null;i++)await wait(50);if(api.exitCode===null&&api.signalCode===null){observations.push({cleanup:'own private index graceful exit incomplete; forced stop',pid:api.pid});api.kill('SIGKILL');for(let i=0;i<20&&api.exitCode===null&&api.signalCode===null;i++)await wait(50);}expect(api.exitCode!==null||api.signalCode!==null).toBe(true);}await db().$disconnect();fs.writeFileSync(sandbox+'/merged-observations.json',JSON.stringify({observations,indexStopped:!api||api.exitCode!==null||api.signalCode!==null},null,2));});
async function fixture(label:string){
 const id=prefix+'-'+(++seq)+'-'+label,owner=id+'-owner',other=id+'-other',now=BigInt(Date.now());
 for(const uid of [owner,other]){await db().userAccount.create({data:{id:uid,displayName:uid,status:'active'}});await db().userRole.create({data:{id:uid+'-role',userId:uid,roleId:'role-sales'}});}
 await db().relation.create({data:{id:id+'-customer',name:'Explicit same customer',category:'customer',type:'company',isOrganization:true,ownerId:owner,salesRepIds:[],tags:[],contactInfo:'{}',lastInteraction:now}});
 const orderId=id+'-order';await db().order.create({data:{id:orderId,poNumber:id+'-PO',customer:'Explicit same customer',customerRelationId:id+'-customer',businessLine:'fabric',product:'Synthetic actual legacy goods',type:'fabric',quantity:10,status:'Pending',dueDate:'2099-01-01',quoteAmount:0,ownerId:owner,importedAt:now,updatedAt:now}});
 const lines=[id+'-m',id+'-pcs'];for(let i=0;i<2;i++)await db().orderLine.create({data:{id:lines[i],orderId,lineNumber:i+1,itemNo:'SKU-'+i,description:'Explicit source '+i,quantity:i?'3.0001':'1.2345',unit:i?'pcs':'m'}});
 const actor=await buildLoadedAuthTokenPayload(db(),(await loadUserWithRoles(db(),owner))!),token=createAuthService().signToken(actor);
 const send=(method:'get'|'post'|'put'|'patch'|'delete',url:string,body?:any,jwt=token)=>request(origin)[method](url).set('Authorization','Bearer '+jwt).send(body);
 const ships:any[]=[];
 for(let i=0;i<2;i++){
  const made=await send('post','/api/v1/shipping',{type:'Export',shippingMethod:'Sea',status:'Draft',orderId,customerName:'Explicit same customer',consigneeName:'Explicit original recipient',consigneeRelationId:id+'-consignee',portOfLoading:'Source origin',portOfDischarge:'Source destination'});expect(made.status,diagnostic(made.body)).toBe(201);const ship=made.body;ships.push(ship);
  const read=await send('get',`/api/v1/shipping/${ship.id}/packing`);expect(read.status,diagnostic(read.body)).toBe(200);
  const body={requestKey:randomUUID(),expectedShipmentUpdatedAt:read.body.context.updatedAt,expectedPhysicalAllocationFingerprint:read.body.context.allocationFingerprint,
   lines:lines.map((line,j)=>({clientLineKey:'line-'+j,orderLineId:line,productCode:'SKU-'+j,productName:'True packed '+j,colorCode:null,quantity:j?'3.0001':'1.2345',unit:j?'pcs':'m',cartons:null,grossWeight:null,netWeight:null,volume:null,hsCode:null,countryOfOrigin:null})),
   cartons:[{cartonNo:'A-7',description:null,length:null,width:null,height:null,grossWeight:'3.001',netWeight:null,volume:'0.0051',items:[{lineKey:'line-0',quantity:'1.2345'},{lineKey:'line-1',quantity:'3.0001'}]}]};
  const saved=await send('put',`/api/v1/shipping/${ship.id}/packing`,body);expect(saved.status,diagnostic(saved.body)).toBe(200);expect(saved.body.cartons).toHaveLength(1);
 }
 return{id,owner,other,orderId,lines,actor,token,ships,sourceIds:ships.map(s=>s.id).sort(),send};
}

const {assembleMergedDocumentSet,buildCompositeSourceRef}=require('../dist/customs/compositeDocumentService') as typeof import('../src/customs/compositeDocumentService');
type F=Awaited<ReturnType<typeof fixture>>;
/** Precisely reproduces the formerly reachable registerCompositeTradeDocument initial branch.
 * Uses real assembleMergedDocumentSet result; does not invent carton IDs/native proof.
 * The current sealed writer is never modified or invoked for creation. */
async function oldProducer(f:F,n=1,docId?:string){
 const data=await assembleMergedDocumentSet(db(),f.sourceIds),id=docId??f.id+'-old-MPL',ts=BigInt(Date.now()),versionId=id+'-v'+n;
 const sourceRef=buildCompositeSourceRef('MERGED_PL',f.sourceIds),content={source:'composite',kind:'MERGED_PL',sourceIds:[...f.sourceIds],data};
 await db().$transaction(async tx=>{
  if(n===1)await tx.tradeDocument.create({data:{id,documentNumber:'OLD-PL-'+f.id,domain:'customs',type:'PackingList',status:'Draft',shipmentId:null,declarationId:null,orderId:null,relationId:null,sourceRef,issueDate:'2026-08-22',totalAmount:data.totals.amount,currency:data.totals.currency,createdAt:ts,updatedAt:ts}});
  await tx.documentVersion.create({data:{id:versionId,documentId:id,version:n,content:JSON.parse(JSON.stringify(content)),changedBy:f.owner,changeReason:'组合生成登记',createdAt:ts}});
  await tx.auditLog.create({data:{id:versionId+'-audit',action:'DOCUMENT_VERSION_CREATE',actorId:f.owner,targetType:'TradeDocument',targetId:id,detail:{version:n,changeReason:'组合生成登记',source:'lifecycle'}}});
  if(n===1)await tx.auditLog.create({data:{id:id+'-create-audit',action:'TRADE_DOCUMENT_CREATE',actorId:f.owner,targetType:'TradeDocument',targetId:id,detail:{documentNumber:'OLD-PL-'+f.id,type:'PackingList',source:'composite',kind:'MERGED_PL',sourceRef}}});
 });return{id,content,versionId};
}
const version=(f:F,id:string,n=1,jwt?:string)=>f.send('get',`${base}/${id}/packing-list-versions/${n}`,undefined,jwt);
const facts=async(f:F,id:string)=>diagnostic({doc:await db().tradeDocument.findUnique({where:{id}}),versions:await db().documentVersion.findMany({where:{documentId:id},orderBy:{version:'asc'}}),audits:await db().auditLog.findMany({orderBy:{id:'asc'}}),ships:await db().shipment.findMany({where:{id:{in:f.sourceIds}},orderBy:{id:'asc'}}),lines:await db().shipmentLine.findMany({where:{shipmentId:{in:f.sourceIds}},orderBy:{id:'asc'}}),stock:await db().stockMovement.findMany({orderBy:{id:'asc'}})});
describe('legacy composite MERGED_PL exact old producer readonly compatibility',()=>{
 it('LM01 genuine old producer history JSON and preview preserve selected N/header/file and cannot become native or write',async()=>{
  const f=await fixture('old-normal'),old=await oldProducer(f);const directory=path.join(sandbox,'uploads','trade-documents');fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,f.id+'-old.pdf'),bytes=Buffer.from('%PDF-1.4 OLD UNVERIFIED FILE');fs.writeFileSync(file,bytes);await db().tradeDocument.update({where:{id:old.id},data:{filePath:'trade-documents/'+path.basename(file),fileName:'original.pdf'}});
  const before=await facts(f,old.id),json=await version(f,old.id);expect(json.status,diagnostic(json.body)).toBe(200);expect(json.body).toMatchObject({protocol:1,provenance:'legacy_unverified',envelope:null,receipt:null});expect(json.body.item.content).toEqual(old.content);
  const detail=await f.send('get',`${base}/${old.id}`);expect(detail.status,diagnostic(detail.body)).toBe(200);expect(detail.body.provenance).toBe('legacy_unverified');
  const listed=await f.send('get',`${base}/${old.id}/versions`);expect(listed.status,diagnostic(listed.body)).toBe(200);expect(listed.body.items).toHaveLength(1);expect(listed.body.items[0].content).toEqual(old.content);
  const html=await f.send('get',`${base}/${old.id}/preview.html?version=1`);expect(html.status,diagnostic(html.body)).toBe(200);expect(html.text).toContain('OLD-PL-'+f.id);expect(html.text).toContain('历史汇总');expect(html.text).toContain('未逐票确认');expect(html.text).toContain('非原生箱级来源');
  expect((await f.send('post',`${base}/${old.id}/generate-file`,{version:1})).status).toBe(409);expect((await f.send('get',`${base}/${old.id}/download?version=1`)).status).toBe(409);expect((await f.send('post',`${base}/${old.id}/packing-list-versions`,{requestKey:randomUUID(),expectedLatestVersion:1,expectedContentHash:hash(Buffer.from(JSON.stringify(old.content))),expectedSourceFingerprint:'a'.repeat(64),reason:'Must not upgrade legacy'})).status).toBe(409);expect((await f.send('get',`${base}/${old.id}/packing-list-source`)).status).toBe(409);
  expect(fs.readFileSync(file)).toEqual(bytes);expect(await facts(f,old.id)).toBe(before);observations.push({label:'LM01',id:old.id,sourceIds:f.sourceIds,shape:Object.keys(old.content),provenance:json.body.provenance,fileUnchanged:true});
 });
 it('LM02 current complete secondary-order parents deny even when old snapshot retained only primary head',async()=>{
  const f=await fixture('secondary-parent'),old=await oldProducer(f);const extra=f.id+'-foreign';await db().order.create({data:{id:extra,poNumber:extra,customer:'Private foreign',product:'Other original parent',type:'fabric',quantity:1,status:'Pending',dueDate:'2099-01-01',quoteAmount:0,ownerId:f.other,importedAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});const ol=extra+'-line';await db().orderLine.create({data:{id:ol,orderId:extra,lineNumber:1,itemNo:'FOREIGN',description:'Other parent',quantity:'1',unit:'pcs'}});await db().shipmentOrderAllocation.create({data:{id:extra+'-soa',shipmentId:f.sourceIds[1],orderId:extra,orderLineId:ol,plannedQty:'1',actualQty:null,unit:'pcs',status:'Draft',createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});
  const before=await facts(f,old.id);for(const suffix of [`/packing-list-versions/1`,`/preview.html?version=1`,``]){const r=await f.send('get',base+'/'+old.id+suffix);expect(r.status,diagnostic(r.body)).toBe(404);expect(diagnostic(r.body)).not.toContain('Other original parent');}expect(await facts(f,old.id)).toBe(before);
  await db().order.update({where:{id:extra},data:{ownerId:f.owner}});expect((await version(f,old.id)).status).toBe(200);
 });
 it('LM03 signed empty ceiling and current stored scope withdrawal reject stale JWT while restored current grant reads',async()=>{
  const f=await fixture('grant'),old=await oldProducer(f),limited=createAuthService().signToken({...f.actor,permissionCeiling:[]});expect((await version(f,old.id,1,limited)).status).toBe(403);
  const rp=await db().rolePermission.findFirstOrThrow({where:{roleId:'role-sales',permission:{scope:'shipments:read'}}});await db().rolePermission.delete({where:{id:rp.id}});try{expect((await version(f,old.id)).status).toBe(403);}finally{await db().rolePermission.create({data:rp});}expect((await version(f,old.id)).status).toBe(200);
 });
 it('LM04 exact old N stays frozen after current goods correction and cancellation, not latest or live assembly',async()=>{
  const f=await fixture('old-n'),old=await oldProducer(f);await db().shipmentLine.updateMany({where:{shipmentId:f.sourceIds[0]},data:{productName:'CURRENT NOT OLD N',quantity:'8'}});const second=await oldProducer(f,2,old.id);await db().shipment.update({where:{id:f.sourceIds[0]},data:{status:'Cancelled'}});
  const before=await facts(f,old.id),n1=await version(f,old.id),n2=await version(f,old.id,2);expect(n1.status,diagnostic(n1.body)).toBe(200);expect(n2.status,diagnostic(n2.body)).toBe(200);expect(n1.body.item.content).toEqual(old.content);expect(n2.body.item.content).toEqual(second.content);expect(n1.body.warnings.join(' ')).toContain('已取消');
  const h1=await f.send('get',`${base}/${old.id}/preview.html?version=1`),h2=await f.send('get',`${base}/${old.id}/preview.html?version=2`);expect(h1.status,diagnostic(h1.body)).toBe(200);expect(h2.status,diagnostic(h2.body)).toBe(200);expect(h1.text).not.toContain('CURRENT NOT OLD N');expect(h2.text).toContain('CURRENT NOT OLD N');expect(await facts(f,old.id)).toBe(before);
 });
 it('LM05 contradictory ref/IDs, out-of-ticket line and native namespace cannot be qualified as old producer',async()=>{
  const f=await fixture('damaged'),old=await oldProducer(f),original=await db().documentVersion.findUniqueOrThrow({where:{id:old.versionId}});
  for(const content of [{...old.content,sourceIds:[f.sourceIds[0],'UNKNOWN']},{...old.content,data:{...old.content.data,lines:old.content.data.lines.map((x:any,i:number)=>i?x:{...x,shipmentIndex:3})}},{...old.content,plDraftProtocol:2}]){
   await db().documentVersion.update({where:{id:old.versionId},data:{content:JSON.parse(JSON.stringify(content))}});const before=await facts(f,old.id),r=await version(f,old.id);expect(r.status,diagnostic(r.body)).toBe(409);expect(await facts(f,old.id)).toBe(before);
  }await db().documentVersion.update({where:{id:old.versionId},data:{content:original.content as import('@prisma/client').Prisma.InputJsonValue}});expect((await version(f,old.id)).status).toBe(200);
 });
 it('LM06 actual late parent handoff and real source-read fault fail closed with no history writes or raw SQL',async()=>{
  const f=await fixture('late-parent'),old=await oldProducer(f);configure({lateLegacyOrder:f.orderId,lateLegacyOwner:f.other});const count=await db().auditLog.count(),late=await version(f,old.id);expect(late.status,diagnostic(late.body)).toBe(404);expect(await db().auditLog.count()).toBe(count);await db().order.update({where:{id:f.orderId},data:{ownerId:f.owner}});await db().relation.update({where:{id:f.id+'-customer'},data:{ownerId:f.owner}});
  configure({legacyParentFault:true});const failed=await version(f,old.id);expect(failed.status,diagnostic(failed.body)).toBe(503);expect(diagnostic(failed.body)).not.toContain('PRIVATE SQL');expect(await db().auditLog.count()).toBe(count);configure({});expect((await version(f,old.id)).status).toBe(200);
 });
});
