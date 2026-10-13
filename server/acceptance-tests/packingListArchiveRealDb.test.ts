/** PL B actual routers/private PostgreSQL + unmodified real renderHtmlToPdf Chrome engine. */
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../src/auth/service';
import { createCustomsRouter } from '../src/customs/customsRoute';
import { createCustomsV2Router } from '../src/customs/customsRouteV2';
import { randomUUID, createHash } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import fs from 'node:fs';
import { realpathSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../src/auth/tokenHelpers';
import { documentSourceJson, documentSourceFingerprint as hash } from '../src/shipping/shipmentDocumentSource';
import { readPackingListDraftSource, appendPackingListDraftVersion, readPackingListVersion } from '../src/customs/shipmentPackingListCommand';
import { renderPackingListBody } from '../src/templates/docTemplates/packingList';
import { EXPORTER_PROFILE_CONFIG_ID } from '../src/config/systemConfigRoute';

function appFor(client:any) { const app=express();app.use(express.json());app.set('json replacer',(_k:string,v:any)=>typeof v==='bigint'?v.toString():v);const options={prisma:client,requireAuth:true,apiKeys:new Set<string>()};app.use('/api/v1/customs',createCustomsRouter(options));app.use('/api/v2/customs',createCustomsV2Router(options));return app; }
let realBrowser: any;
const launch = chromium.launch.bind(chromium);
vi.spyOn(chromium, 'launch').mockImplementation(async options => { realBrowser = await launch(options); return realBrowser; });
const prefix = 'acceptance-pl-archive-' + randomUUID();
let prisma: PrismaClient;
const peers: PrismaClient[] = [];
const db = () => prisma;
const peer = () => { const p = new PrismaClient(); peers.push(p); return p; };
const journal = (value: any) => appendFileSync(path.join(process.env.BAMBOOK_ATTACHMENT_READONLY_EVIDENCE!, 'pl-native.jsonl'), JSON.stringify(documentSourceJson(value)) + '\n');
beforeAll(async () => {
  const { DATABASE_URL: url, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory,
    BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!url || !sandbox || !name || !directory || !port) throw Error('Private actual PG required');
  const parsed = new URL(url); expect(parsed.hostname).toBe('127.0.0.1'); expect(parsed.pathname).toBe('/' + name); expect(parsed.port).toBe(port);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  prisma = new PrismaClient(); expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  await db().role.create({ data: { id: prefix + '-sales', name: 'Synthetic pricing-neutral sales', isSystem: false } });
  await db().systemConfig.create({ data: { id: EXPORTER_PROFILE_CONFIG_ID, scope: 'global', key: 'company.exporterProfile', group: 'company', label: 'Synthetic explicit exporter',
    valueType: 'json', value: { nameEn: 'Native frozen export company', addressEn: 'Native known address' }, version: 1, updatedAt: BigInt(Date.now()) } });
});
afterAll(async () => { await realBrowser?.close(); vi.restoreAllMocks(); await Promise.all(peers.map(p => p.$disconnect())); await prisma?.$disconnect(); });

async function fixture(label: string) {
  const id = `${prefix}-${label}-${randomUUID()}`, owner = id + '-owner', other = id + '-other', shipmentId = id + '-ship', documentId = id + '-pl', now = BigInt(Date.now());
  for (const userId of [owner, other]) {
    await db().userAccount.create({ data: { id: userId, displayName: userId, status: 'active' } });
    await db().userRole.create({ data: { id: userId + '-role', userId, roleId: prefix + '-sales' } });
  }
  await db().userPermissionOverrides.createMany({ data: ['orders:read', 'customs:read', 'customs:write', 'shipments:read'].map(scope => ({ id: owner + '-' + scope,
    userId: owner, scope, isActive: true, grantedBy: owner, reason: 'Explicit private source-unit permission, not company policy' })) });
  const orders = [id + '-order-a', id + '-order-b'], ol = [id + '-ol-a', id + '-ol-b'], sl = [id + '-sl-a', id + '-sl-b'];
  for (let i = 0; i < 2; i++) {
    await db().order.create({ data: { id: orders[i], poNumber: i ? null : id + '-real-PO', customer: 'Native customer ' + i, product: 'Synthetic goods', type: 'garment',
      quantity: 10, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 0, ownerId: owner, importedAt: now, updatedAt: now } });
    await db().orderLine.create({ data: { id: ol[i], orderId: orders[i], lineNumber: 1, itemNo: i ? 'REAL-B' : 'REAL-A',
      description: 'Synthetic native original row ' + i, quantity: i ? '3.0001' : '1.2345', unit: i ? 'pcs' : 'm' } });
  }
  await db().shipment.create({ data: { id: shipmentId, shipmentNumber: id + '-SHIP', type: 'Export', status: 'Loading', shippingMethod: 'Sea',
    orderId: orders[0], totalPackages: 2, grossWeight: '60', netWeight: '50', volume: '0.5', createdAt: now, updatedAt: now } });
  for (let i = 0; i < 2; i++) await db().shipmentLine.create({ data: { id: sl[i], shipmentId, orderLineId: ol[i], lineNumber: i + 1,
    productName: 'Actual native packed goods ' + i, productCode: 'REAL-' + i, quantity: i ? '3.0001' : '1.2345', unit: i ? 'pcs' : 'm', createdAt: now, updatedAt: now } });
  const cartons = [id + '-box-A', id + '-box-Z'];
  await db().shipmentCarton.create({ data: { id: cartons[0], shipmentId, cartonNo: 'A-7', grossWeight: '3.001', volume: '0.0051', createdAt: now, updatedAt: now,
    items: { create: [{ id: id + '-item-a', shipmentLineId: sl[0], quantity: '1.0001', createdAt: now, updatedAt: now },
      { id: id + '-item-b', shipmentLineId: sl[1], quantity: '3.0001', createdAt: now, updatedAt: now }] } } });
  await db().shipmentCarton.create({ data: { id: cartons[1], shipmentId, cartonNo: 'Z-42', length: '30.02', width: '20', netWeight: '2', createdAt: now, updatedAt: now,
    items: { create: { id: id + '-item-z', shipmentLineId: sl[0], quantity: '0.2344', createdAt: now, updatedAt: now } } } });
  const actor = await buildLoadedAuthTokenPayload(db(), (await loadUserWithRoles(db(), owner))!);
  const app = appFor(db()); const token = createAuthService().signToken(actor);
  const send = (method: 'get'|'post'|'put'|'delete', url: string, body?: any, jwt=token) => request(app)[method](url).set('Authorization','Bearer '+jwt).send(body);
  const generated = await send('post','/api/v1/customs/trade-documents/generate-from-shipment',{shipmentId,types:['PackingList']});
  expect(generated.status).toBe(201); const actualId=generated.body.created[0].id;
  return { id, owner, other, orders, ol, sl, cartons, shipmentId, documentId:actualId, actor, app, token, send };
}

const base='/api/v1/customs/trade-documents';
type F=Awaited<ReturnType<typeof fixture>>;
const source=async(f:F)=>{const x=await f.send('get',`${base}/${f.documentId}/packing-list-source`);expect(x.status).toBe(200);return x.body;};
const append=async(f:F,s:any,key=randomUUID())=>f.send('post',`${base}/${f.documentId}/packing-list-versions`,{requestKey:key,expectedLatestVersion:s.latest.version,expectedContentHash:s.latest.contentHash,expectedSourceFingerprint:s.sourceFingerprint,reason:'Explicit exact-source append'});
const ledger=async(f:F)=>documentSourceJson({doc:await db().tradeDocument.findUnique({where:{id:f.documentId}}),versions:await db().documentVersion.findMany({where:{documentId:f.documentId},orderBy:{version:'asc'}}),audits:await db().auditLog.findMany({where:{OR:[{targetId:f.documentId},{detail:{path:['documentId'],equals:f.documentId}}]},orderBy:{id:'asc'}})});

const fileAudits=async(f:F)=>db().auditLog.findMany({where:{targetId:f.documentId,action:'TRADE_DOCUMENT_FILE_GENERATED'},orderBy:{id:'asc'}});
const pdfText=async(bytes:Buffer)=>{const parser=new PDFParse({data:bytes});try{return (await parser.getText()).text.replace(/\s+/g,' ');}finally{await parser.destroy();}};
const binary=(res:any,done:any)=>{const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>done(null,Buffer.concat(chunks)));};
const download=(f:F,version:number,app=f.app,jwt=f.token)=>request(app).get(`${base}/${f.documentId}/download?version=${version}`).set('Authorization','Bearer '+jwt).buffer(true).parse(binary);
describe('PL B immutable exact-version archives — actual HTTP/private PG/Chrome PDF',()=>{
 it('B01 N1/N2 render frozen sparse mixed-line quantities and unknown measurements; real PDF readback keeps prior bytes and version facts',async()=>{
  const f=await fixture('versions'),before=await ledger(f);
  const one=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1,html:'CALLER FAKE HTML'});expect(one.status).toBe(201);
  const pdf1=await download(f,1);expect(pdf1.status).toBe(200);expect(pdf1.body.subarray(0,5).toString()).toBe('%PDF-');
  const text1=await pdfText(pdf1.body);expect(text1).toContain('PACKING LIST');expect(text1).toContain('A-7');expect(text1).toContain('Z-42');expect(text1).toContain('1.0001 m');expect(text1).toContain('3.0001 pcs');expect(text1).toContain('0.2344 m');expect(text1).toContain('—');expect(text1).not.toContain('CALLER FAKE HTML');expect(text1).not.toContain('C/NO. 1-2');
  await db().shipmentCarton.update({where:{id:f.cartons[0]},data:{cartonNo:'N-9'}});const made=await append(f,await source(f));expect(made.status).toBe(201);
  const two=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2});expect(two.status).toBe(201);expect(two.body.filePath).not.toBe(one.body.filePath);
  const pdf2=await download(f,2);expect(pdf2.status).toBe(200);expect(await pdfText(pdf2.body)).toContain('N-9');expect(await pdfText(pdf2.body)).not.toContain('A-7');
  const old=await download(f,1);expect(old.status).toBe(200);expect(old.body.equals(pdf1.body)).toBe(true);
  const after=await ledger(f);expect(after.versions[0]).toEqual(before.versions[0]);expect(after.doc.status).toBe('Draft');expect(await db().stockMovement.count()).toBe(0);expect(await db().invoice.count()).toBe(0);
  const audits=await fileAudits(f);expect(audits).toHaveLength(2);expect(audits.map(a=>(a.detail as any).packingListArchive.version).sort()).toEqual([1,2]);
  fs.writeFileSync(path.join(process.env.BAMBOOK_ATTACHMENT_READONLY_EVIDENCE!,'actual-pl-n1.pdf'),pdf1.body);fs.writeFileSync(path.join(process.env.BAMBOOK_ATTACHMENT_READONLY_EVIDENCE!,'actual-pl-n2.pdf'),pdf2.body);journal({label:'B01',one:one.body,two:two.body,text1,text2:await pdfText(pdf2.body),audits});
 });
 it('B02 readonly ZIP uses exact selected native versions and entries without re-render or writes',async()=>{
  const f=await fixture('zip');expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1})).status).toBe(201);const changed=await append(f,await source(f));expect(changed.status).toBe(201);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2})).status).toBe(201);
  await db().userPermissionOverrides.deleteMany({where:{userId:f.owner,scope:'customs:write'}});const old=await ledger(f),one=await download(f,1);expect(one.status).toBe(200);
  const zipped=await request(f.app).post(`${base}/batch-download`).set('Authorization','Bearer '+f.token).send({ids:[f.documentId],versions:{[f.documentId]:1}}).buffer(true).parse(binary);expect(zipped.status).toBe(200);
  const zip=await JSZip.loadAsync(zipped.body),entries=Object.keys(zip.files);expect(entries).toEqual([one.headers['content-disposition'].split("''")[1] ? decodeURIComponent(one.headers['content-disposition'].split("''")[1]) : 'impossible']);expect((await zip.file(entries[0])!.async('nodebuffer')).equals(one.body)).toBe(true);expect(await ledger(f)).toEqual(old);
  journal({label:'B02',entries,selectedN:1,noWrite:true});
 });
 it('B03 same-N concurrent/repeated requests reuse one committed audit/file; lost transaction acknowledgement recovers actual committed fact',async()=>{
  const f=await fixture('retry');const pair=await Promise.all([f.send('post',`${base}/${f.documentId}/generate-file`,{version:1}),f.send('post',`${base}/${f.documentId}/generate-file`,{version:1})]);expect(pair.map(x=>x.status)).toEqual([201,201]);expect(pair[0].body.filePath).toBe(pair[1].body.filePath);expect(await fileAudits(f)).toHaveLength(1);
  const before=await ledger(f);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1})).body.filePath).toBe(pair[0].body.filePath);expect(await ledger(f)).toEqual(before);
  const unknown=await fixture('lost-ack');let fired=false;const real=db();const client=new Proxy(real,{get(target,key){if(key==='$transaction')return async(work:any,options:any)=>{const result=await target.$transaction(work,options);if(!fired&&(result as any)?.replayed===false&&(result as any)?.proof?.operation==='archive_packing_list_version'){fired=true;throw new Error('PRIVATE commit reply disconnected');}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const ack=await request(appFor(client)).post(`${base}/${unknown.documentId}/generate-file`).set('Authorization','Bearer '+unknown.token).send({version:1});expect(ack.status).toBe(201);expect(fired).toBe(true);expect(await fileAudits(unknown)).toHaveLength(1);expect((await download(unknown,1)).status).toBe(200);journal({label:'B03',pair:pair.map(x=>x.body),lostAck:ack.body});
 });
 it('B04 mandatory archive audit failure rolls header/file publication back and retains an inaccessible uncertain attempt; fake typed SQL is safe500',async()=>{
  const f=await fixture('audit-fault'),before=await ledger(f),dir=path.join(process.env.BAMBOOK_UPLOAD_DIR!,'trade-documents');const files=new Set(fs.existsSync(dir)?fs.readdirSync(dir):[]);let fired=false;
  const fault=Object.assign(new Error('PRIVATE archive SQL password'),{code:'CONFLICT',statusCode:409});const observed=db().$extends({query:{auditLog:{async create({args,query}){if(args.data.action==='TRADE_DOCUMENT_FILE_GENERATED'){fired=true;throw fault;}return query(args);}}}});
  const x=await request(appFor(observed)).post(`${base}/${f.documentId}/generate-file`).set('Authorization','Bearer '+f.token).send({version:1});expect(x.status).toBe(500);expect(fired).toBe(true);expect(JSON.stringify(x.body)).not.toContain('PRIVATE');expect(x.body.filePath).toBeUndefined();expect(await ledger(f)).toEqual(before);const retained=fs.readdirSync(dir).filter(name=>!files.has(name));expect(retained).toHaveLength(1);expect(retained[0]).toMatch(/^pl-v2-[a-f0-9-]{36}\.pdf$/);expect((await f.send('get',`${base}/${f.documentId}/download?version=1`)).status).toBe(404);journal({label:'B04',body:x.body,noWrite:true});
 });
 it('B05 real late write revocation or source change after audit INSERT rejects and atomically preserves old N/header/audits',async()=>{
  for(const mode of ['grant','source'] as const){const f=await fixture('late-'+mode),before=await ledger(f),second=peer();let fired=false;const observed=db().$extends({query:{auditLog:{async create({args,query}){const row=await query(args);if(!fired&&args.data.action==='TRADE_DOCUMENT_FILE_GENERATED'){fired=true;if(mode==='grant')await second.userPermissionOverrides.deleteMany({where:{userId:f.owner,scope:'customs:write'}});else await second.shipmentCarton.update({where:{id:f.cartons[0]},data:{cartonNo:'LATE-9'}});}return row;}}}});
   const x=await request(appFor(observed)).post(`${base}/${f.documentId}/generate-file`).set('Authorization','Bearer '+f.token).send({version:1});expect(x.status).toBe(mode==='grant'?403:409);expect(fired).toBe(true);expect(x.body.filePath).toBeUndefined();expect(await ledger(f)).toEqual(before);expect(await fileAudits(f)).toEqual([]);journal({label:'B05',mode,body:x.body});}
 });
 it('B06 PDF/hash/path/symlink corruption and borrowed old-version paths or header Other never disclose bytes; old archive reference remains',async()=>{
  const f=await fixture('tamper');const ack=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1});expect(ack.status).toBe(201);const bytes=(await download(f,1)).body as Buffer,target=path.join(process.env.BAMBOOK_UPLOAD_DIR!,ack.body.filePath),audit=(await fileAudits(f))[0],original=audit.detail;
  try{const damaged=Buffer.from(bytes);damaged[damaged.length-10]^=1;fs.writeFileSync(target,damaged);const x=await f.send('get',`${base}/${f.documentId}/download?version=1`);expect(x.status).toBe(409);expect(x.body.filePath).toBeUndefined();}finally{fs.writeFileSync(target,bytes);}
  try{await db().auditLog.update({where:{id:audit.id},data:{detail:{packingListArchive:{...(audit.detail as any).packingListArchive,filePath:'../SECRET.pdf'}}}});expect((await f.send('get',`${base}/${f.documentId}/download?version=1`)).status).toBe(409);}finally{await db().auditLog.update({where:{id:audit.id},data:{detail:original as Prisma.InputJsonValue}});}
  const outside=path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!,'same-bytes-outside.pdf');fs.writeFileSync(outside,bytes);fs.unlinkSync(target);fs.symlinkSync(outside,target);try{expect((await f.send('get',`${base}/${f.documentId}/download?version=1`)).status).toBe(409);}finally{fs.unlinkSync(target);fs.writeFileSync(target,bytes);}
  expect((await append(f,await source(f))).status).toBe(201);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2})).status).toBe(201);const otherId=f.id+'-borrow-old';await db().tradeDocument.create({data:{id:otherId,type:'Other',domain:'customs',documentNumber:otherId,status:'Draft',filePath:ack.body.filePath,fileName:'borrowed.pdf',createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});
  expect((await f.send('get',`${base}/${otherId}/download`)).status).toBe(409);
  for(const alias of ['trade-documents/./'+path.posix.basename(ack.body.filePath),target]){await db().tradeDocument.update({where:{id:otherId},data:{filePath:alias}});const hidden=await f.send('get',`${base}/${otherId}/download`);journal({label:'B06-alias',alias,status:hidden.status,contentType:hidden.headers['content-type']});expect(hidden.status).toBe(409);expect(hidden.body.filePath).toBeUndefined();}
expect((await f.send('post',`${base}/${otherId}/generate-file`,{})).status).toBe(409);await db().tradeDocument.update({where:{id:f.documentId},data:{type:'Other'}});expect((await f.send('get',`${base}/${f.documentId}/download?version=1`)).status).toBe(409);expect(fs.readFileSync(target).equals(bytes)).toBe(true);
 });
 it('B07 current all-parent L2 and signed ceilings deny other actor/body spoof; legitimate readonly download survives lost write',async()=>{
  const f=await fixture('read-auth');expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1})).status).toBe(201);const empty=createAuthService().signToken({...f.actor,permissionCeiling:[]});expect((await f.send('get',`${base}/${f.documentId}/download?version=1`,undefined,empty)).status).toBe(403);
  const readonly=createAuthService().signToken({...f.actor,permissionCeiling:['customs:read','orders:read','shipments:read']});expect((await download(f,1,f.app,readonly)).status).toBe(200);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1,actorId:f.owner,permissionCeiling:['*']},readonly)).status).toBe(403);
  await db().userPermissionOverrides.createMany({data:['customs:read','customs:write','orders:read','shipments:read'].map(scope=>({id:f.other+scope,userId:f.other,scope,isActive:true,grantedBy:f.owner,reason:'Actual private other operator'}))});const other=createAuthService().signToken(await buildLoadedAuthTokenPayload(db(),(await loadUserWithRoles(db(),f.other))!));const foreign=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1,actorId:f.owner},other);expect(foreign.status).toBe(404);expect(foreign.body.filePath).toBeUndefined();
  await db().userPermissionOverrides.deleteMany({where:{userId:f.owner,scope:'customs:write'}});expect((await download(f,1)).status).toBe(200);await db().order.update({where:{id:f.orders[1]},data:{ownerId:f.other}});const denied=await f.send('get',`${base}/${f.documentId}/download?version=1`);expect(denied.status).toBe(404);expect(denied.body.fileName).toBeUndefined();
 });

 it('B08 terminal audit/file read and ZIP await recheck actual current parent/read grant before response bytes',async()=>{
  for(const mode of ['parent','grant'] as const){const f=await fixture('read-late-'+mode);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1})).status).toBe(201);let count=0,fired=false;const second=peer(),observed=db().$extends({query:{auditLog:{async findUnique({args,query}){const row=await query(args);if(row?.action==='TRADE_DOCUMENT_FILE_GENERATED'&&++count===2){fired=true;if(mode==='parent')await second.order.update({where:{id:f.orders[1]},data:{ownerId:f.other}});else await second.userPermissionOverrides.deleteMany({where:{userId:f.owner,scope:'customs:read'}});}return row;}}}});const denied=await request(appFor(observed)).get(`${base}/${f.documentId}/download?version=1`).set('Authorization','Bearer '+f.token);expect(denied.status).toBe(mode==='parent'?404:403);expect(fired).toBe(true);expect(denied.body.fileName).toBeUndefined();expect(denied.headers['content-type']).toContain('application/json');}
  const f=await fixture('zip-late');expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1})).status).toBe(201);const original=JSZip.prototype.generateAsync;let fired=false;const spy=vi.spyOn(JSZip.prototype,'generateAsync').mockImplementation(async function(this:JSZip,...args:any[]){const bytes=await original.apply(this,args as any);if(!fired){fired=true;await db().userPermissionOverrides.deleteMany({where:{userId:f.owner,scope:'customs:read'}});}return bytes;});
  try{const denied=await f.send('post',`${base}/batch-download`,{ids:[f.documentId],versions:{[f.documentId]:1}});expect(denied.status).toBe(403);expect(fired).toBe(true);expect(denied.headers['content-type']).toContain('application/json');}finally{spy.mockRestore();}
 });
 it('B09 Issued or cancelled native history can read and explicitly archive exact frozen N; unproved legacy keeps JSON/preview but never upgrades old files',async()=>{
  const f=await fixture('archive-history');expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1})).status).toBe(201);const pdf=(await download(f,1)).body as Buffer;
  expect((await append(f,await source(f))).status).toBe(201);await db().tradeDocument.update({where:{id:f.documentId},data:{status:'Issued'}});await db().shipment.update({where:{id:f.shipmentId},data:{status:'Cancelled'}});await db().shipmentCarton.update({where:{id:f.cartons[0]},data:{cartonNo:'CURRENT-MUST-NOT-RENDER'}});const before=await ledger(f);
  expect((await download(f,1)).body.equals(pdf)).toBe(true);const archived=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2});expect(archived.status).toBe(201);const text=await pdfText((await download(f,2)).body);expect(text).toContain('A-7');expect(text).not.toContain('CURRENT-MUST-NOT-RENDER');expect((await ledger(f)).versions).toEqual(before.versions);expect((await ledger(f)).doc.status).toBe('Issued');
  const id=f.id+'-legacy',now=BigInt(Date.now()),filePath='trade-documents/'+f.id+'-original-legacy.pdf';await db().tradeDocument.create({data:{id,type:'PackingList',domain:'customs',status:'Issued',documentNumber:id,shipmentId:f.shipmentId,orderId:f.orders[0],createdAt:now,updatedAt:now,filePath,fileName:'legacy.pdf'}});
  const ds={shipment:{id:f.shipmentId,shipmentNumber:'ORIGINAL LEGACY'},source:{schemaVersion:1,orderIds:f.orders},order:{id:f.orders[0],poNumber:null},parties:{customer:{name:'True original legacy customer'}},lines:[{shipmentLineId:f.sl[0],orderLineId:f.ol[0],orderId:f.orders[0],lineNumber:1,description:'LEGACY ORIGINAL',quantity:7,unit:'m'}],totals:{quantity:7,cartons:1},missing:[],extras:{}};
  await db().documentVersion.create({data:{id:id+'-v1',documentId:id,version:1,content:{documentSet:ds},createdAt:now,changedBy:f.owner}});const fullPath=path.join(process.env.BAMBOOK_UPLOAD_DIR!,filePath);fs.writeFileSync(fullPath,'%PDF- original unproved legacy bytes');const original=fs.readFileSync(fullPath);
  const record=await f.send('get',`${base}/${id}/versions/1`);expect(record.status).toBe(200);expect(record.body.provenance).toBe('legacy_unverified');expect(record.body.item.content).toEqual({documentSet:ds});const preview=await f.send('get',`${base}/${id}/preview.html?version=1`);expect(preview.status).toBe(200);expect(preview.text).toContain('LEGACY ORIGINAL');
  for(const [method,url] of [['get',`${base}/${id}/download?version=1`],['post',`${base}/${id}/generate-file`]] as const){const denied=await f.send(method,url,{version:1});expect(denied.status).toBe(409);expect(denied.body.filePath).toBeUndefined();}
  expect(fs.readFileSync(fullPath).equals(original)).toBe(true);expect((await db().tradeDocument.findUniqueOrThrow({where:{id}})).filePath).toBe(filePath);expect(await db().auditLog.count({where:{targetId:id,action:'TRADE_DOCUMENT_FILE_GENERATED'}})).toBe(0);journal({label:'B09',legacyRead:true,legacyBytes:false,historicalNative:archived.body});
 });
 it('B10 committed archive with lost acknowledgement and failed persistence check stays unknown; explicit same-N retry reuses original fact and bytes',async()=>{
  const f=await fixture('uncertain-commit');let fired=false,checked=false;const real=db();const client=new Proxy(real,{get(target,key){if(key==='$transaction')return async(work:any,options:any)=>{const result=await target.$transaction(work,options);if(!fired&&(result as any)?.replayed===false&&(result as any)?.proof?.operation==='archive_packing_list_version'){fired=true;throw new Error('PRIVATE lost committed reply');}return result;};if(key==='auditLog')return new Proxy(target.auditLog,{get(delegate,method){if(method==='findUnique')return async(args:any)=>{if(fired){checked=true;throw new Error('PRIVATE persistence check unavailable');}return delegate.findUnique(args);};const value=Reflect.get(delegate,method);return typeof value==='function'?value.bind(delegate):value;}});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const unknown=await request(appFor(client)).post(`${base}/${f.documentId}/generate-file`).set('Authorization','Bearer '+f.token).send({version:1});expect(unknown.status).toBe(500);expect(fired).toBe(true);expect(checked).toBe(true);expect(unknown.body.filePath).toBeUndefined();expect(JSON.stringify(unknown.body)).not.toContain('PRIVATE');
  const audits=await fileAudits(f);expect(audits).toHaveLength(1);const proof=(audits[0].detail as any).packingListArchive;expect(fs.existsSync(path.join(process.env.BAMBOOK_UPLOAD_DIR!,proof.filePath))).toBe(true);const original=(await download(f,1)).body as Buffer,before=await ledger(f);
  const explicit=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1});expect(explicit.status).toBe(201);expect(explicit.body.replayed).toBe(true);expect(explicit.body.filePath).toBe(proof.filePath);expect((await download(f,1)).body.equals(original)).toBe(true);expect(await ledger(f)).toEqual(before);journal({label:'B10',unknown:unknown.body,explicit:explicit.body,actualCommittedAudit:proof.auditId});
 });

});
