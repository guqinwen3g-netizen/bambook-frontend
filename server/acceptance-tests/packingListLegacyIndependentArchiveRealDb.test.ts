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
const prefix = 'acceptance-pl-legacy-' + randomUUID();
let prisma: PrismaClient;
const peers: PrismaClient[] = [];
const db = () => prisma;
const peer = () => { const p = new PrismaClient(); peers.push(p); return p; };
const journal = (value: any) => appendFileSync(path.join(process.env.BAMBOOK_ATTACHMENT_READONLY_EVIDENCE!, 'pl-legacy-native.jsonl'), JSON.stringify(documentSourceJson(value)) + '\n');
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

const retainedAction = 'PACKING_LIST_LEGACY_HEADER_PRESERVED';
async function legacyFixture(label:string, legacyName?:string) {
 const f=await fixture(label),id=f.id+'-legacy',now=BigInt(Date.now()),filePath='trade-documents/'+(legacyName ?? f.id+'-old-original.pdf'),fileName=legacyName ?? 'original-legacy.pdf';
 const content={documentSet:{shipment:{id:f.shipmentId,shipmentNumber:'ORIGINAL LEGACY'},source:{schemaVersion:1,orderIds:f.orders},order:{id:f.orders[0],poNumber:null},parties:{customer:{name:'True legacy customer'}},lines:[{shipmentLineId:f.sl[0],orderLineId:f.ol[0],orderId:f.orders[0],lineNumber:1,description:'ORIGINAL OLD CONTENT',quantity:7,unit:'m'}],totals:{quantity:7,cartons:1},missing:[],extras:{}}};
 await db().tradeDocument.create({data:{id,type:'PackingList',domain:'customs',status:'Draft',documentNumber:id,shipmentId:f.shipmentId,orderId:f.orders[0],createdAt:now,updatedAt:now,filePath,fileName}});
 await db().documentVersion.create({data:{id:id+'-v1',documentId:id,version:1,content,createdAt:now,changedBy:f.owner}});
 const target=path.join(process.env.BAMBOOK_UPLOAD_DIR!,filePath);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'%PDF- original unproved historical content');
 return {...f,documentId:id,oldFile:target,oldBytes:fs.readFileSync(target),oldVersion:documentSourceJson(await db().documentVersion.findUniqueOrThrow({where:{id:id+'-v1'}})),oldHeader:{filePath,fileName}};
}
async function prepare(f:F) {const ack=await append(f,await source(f));expect(ack.status).toBe(201);return ack.body;}
const retention=async(f:F)=>db().auditLog.findMany({where:{action:retainedAction,targetId:f.documentId}});
describe('Legacy head reference stays untrusted while exact native PL versions archive independently — real HTTP/PG/PDF',()=>{
 it('L01 legacy N1 and its old header/bytes remain unchanged; native N2/N3 archive, repeat and exact readonly ZIP use their own proofs',async()=>{
  const f=await legacyFixture('two-versions'),two=await prepare(f),head=await db().tradeDocument.findUniqueOrThrow({where:{id:f.documentId}});
  const original=(await f.send('get',`${base}/${f.documentId}/versions/1`));expect(original.status).toBe(200);expect(original.body.provenance).toBe('legacy_unverified');
  const first=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2});expect(first.status).toBe(201);expect(first.body.version).toBe(2);
  const pdf2=await download(f,2);expect(pdf2.status).toBe(200);expect(await pdfText(pdf2.body)).toContain('A-7');expect(await pdfText(pdf2.body)).not.toContain('ORIGINAL OLD CONTENT');
  expect(documentSourceJson(await db().tradeDocument.findUniqueOrThrow({where:{id:f.documentId}}))).toEqual(documentSourceJson(head));
  expect(documentSourceJson(await db().documentVersion.findUniqueOrThrow({where:{id:f.oldVersion.id}}))).toEqual(f.oldVersion);expect(fs.readFileSync(f.oldFile)).toEqual(f.oldBytes);
  expect((await f.send('get',`${base}/${f.documentId}/download?version=1`)).status).toBe(409);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:1})).status).toBe(409);
  const a=await retention(f);expect(a).toHaveLength(1);const p=(a[0].detail as any).legacyHeaderReference;
  expect(p).toEqual({operation:'preserve_legacy_packing_list_header',protocol:1,documentId:f.documentId,legacyVersionId:f.oldVersion.id,legacyVersion:1,legacyContentHash:hash(f.oldVersion.content),...f.oldHeader,actorId:f.owner,archiveVersionId:two.version.id,archiveVersion:2,archiveAuditId:(await fileAudits(f))[0].id,appendCommandId:two.receipt.commandId,auditId:a[0].id});
  expect(a[0].transactionId).toBe('PL-ARCHIVE:'+two.version.id);expect(a[0].actorId).toBe(f.owner);
  const before=await ledger(f);const replay=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2});expect(replay.status).toBe(201);expect(replay.body.replayed).toBe(true);expect(replay.body.filePath).toBe(first.body.filePath);expect(await ledger(f)).toEqual(before);
  expect((await prepare(f)).version.version).toBe(3);const header3=await db().tradeDocument.findUniqueOrThrow({where:{id:f.documentId}});const three=await f.send('post',`${base}/${f.documentId}/generate-file`,{version:3});expect(three.status).toBe(201);expect(three.body.filePath).not.toBe(first.body.filePath);expect(await retention(f)).toEqual(a);
  expect(documentSourceJson(await db().tradeDocument.findUniqueOrThrow({where:{id:f.documentId}}))).toEqual(documentSourceJson(header3));expect(fs.readFileSync(f.oldFile)).toEqual(f.oldBytes);expect((await download(f,2)).body).toEqual(pdf2.body);
  await db().userPermissionOverrides.deleteMany({where:{userId:f.owner,scope:'customs:write'}});const zipped=await request(f.app).post(`${base}/batch-download`).set('Authorization','Bearer '+f.token).send({ids:[f.documentId],versions:{[f.documentId]:2}}).buffer(true).parse(binary);expect(zipped.status).toBe(200);const zip=await JSZip.loadAsync(zipped.body);expect(Object.keys(zip.files)).toEqual([first.body.fileName]);expect(await zip.file(first.body.fileName)!.async('nodebuffer')).toEqual(pdf2.body);
  expect((await fileAudits(f)).map(x=>(x.detail as any).packingListArchive.version).sort()).toEqual([2,3]);expect(await db().stockMovement.count()).toBe(0);expect(await db().invoice.count()).toBe(0);journal({case:'L01',legacyHeader:f.oldHeader,first:first.body,three:three.body,retention:p});
 });
 it('L02 native-like namespaces including damaged spellings and original native N1 rebind cannot establish a legacy retention audit',async()=>{
  for(const name of ['pl-v2-corrupt.pdf','PL-v2-broken.pdf','pl-v2-path/../ordinary.pdf']){const f=await legacyFixture('namespace');await db().tradeDocument.update({where:{id:f.documentId},data:{filePath:'trade-documents/'+name}});await prepare(f);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2})).status).toBe(409);expect(await retention(f)).toEqual([]);expect(await fileAudits(f)).toEqual([]);}
  for(const name of ['PL-Version-1.pdf','pl-vendor-original.pdf']){const legacy=await legacyFixture('legitimate-old-name',name);await prepare(legacy);const original=await db().tradeDocument.findUniqueOrThrow({where:{id:legacy.documentId}});expect((await legacy.send('post',`${base}/${legacy.documentId}/generate-file`,{version:2})).status).toBe(201);expect(documentSourceJson(await db().tradeDocument.findUniqueOrThrow({where:{id:legacy.documentId}}))).toEqual(documentSourceJson(original));expect(fs.readFileSync(legacy.oldFile)).toEqual(legacy.oldBytes);}
  const historical=await fixture('unset-history'),newer=await prepare(historical),beforeHistory=await db().tradeDocument.findUniqueOrThrow({where:{id:historical.documentId}});
  expect((await historical.send('post',`${base}/${historical.documentId}/generate-file`,{version:1})).status).toBe(201);expect((await download(historical,1)).status).toBe(200);expect(documentSourceJson(await db().tradeDocument.findUniqueOrThrow({where:{id:historical.documentId}}))).toEqual(documentSourceJson(beforeHistory));
  const unset=await db().auditLog.findMany({where:{targetId:historical.documentId,action:'PACKING_LIST_UNSET_HEADER_PRESERVED'}});expect(unset).toHaveLength(1);const up=(unset[0].detail as any).unsetHeaderReference;expect(up.archiveVersion).toBe(1);expect(up.latestVersionId).toBe(newer.version.id);expect(up.latestVersion).toBe(2);expect(up.headBefore).toEqual({filePath:null,fileName:null});expect(up.headAfter).toEqual(up.headBefore);const facts=await ledger(historical);expect((await historical.send('post',`${base}/${historical.documentId}/generate-file`,{version:1})).body.replayed).toBe(true);expect(await ledger(historical)).toEqual(facts);
  const f=await fixture('native-register');await db().tradeDocument.update({where:{id:f.documentId},data:{filePath:'trade-documents/ordinary-looking.pdf',fileName:'legacy-looking.pdf'}});await prepare(f);const before=await ledger(f);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2})).status).toBe(409);expect(await ledger(f)).toEqual(before);expect(await retention(f)).toEqual([]);
 });
 it('L03 retained head changes, missing/damaged retention, or existing native publication rebind reject without minting replacement proof',async()=>{
  const f=await legacyFixture('retention-tamper');await prepare(f);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2})).status).toBe(201);await prepare(f);const row=(await retention(f))[0],detail=row.detail;
  for(const field of ['filePath','fileName']){const old=f.oldHeader[field as keyof typeof f.oldHeader];await db().tradeDocument.update({where:{id:f.documentId},data:{[field]:'ordinary-replaced.pdf'}});try{expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:3})).status).toBe(409);expect((await f.send('get',`${base}/${f.documentId}/download?version=2`)).status).toBe(409);}finally{await db().tradeDocument.update({where:{id:f.documentId},data:{[field]:old}});}}
  await db().auditLog.update({where:{id:row.id},data:{detail:{legacyHeaderReference:{...(detail as any).legacyHeaderReference,legacyContentHash:'0'.repeat(64)}}}});try{expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:3})).status).toBe(409);}finally{await db().auditLog.update({where:{id:row.id},data:{detail:detail as Prisma.InputJsonValue}});}
  await db().auditLog.delete({where:{id:row.id}});expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:3})).status).toBe(409);
  await db().tradeDocument.update({where:{id:f.documentId},data:{filePath:null,fileName:null}});try{expect((await f.send('get',`${base}/${f.documentId}/download?version=2`)).status).toBe(409);expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:3})).status).toBe(409);}finally{await db().tradeDocument.update({where:{id:f.documentId},data:f.oldHeader});}
  await db().auditLog.create({data:{...row,detail:detail as Prisma.InputJsonValue,beforeValue:row.beforeValue===null?Prisma.DbNull:row.beforeValue as Prisma.InputJsonValue,afterValue:row.afterValue===null?Prisma.DbNull:row.afterValue as Prisma.InputJsonValue}});
  expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:3})).status).toBe(201);expect(fs.readFileSync(f.oldFile)).toEqual(f.oldBytes);
  const native=await fixture('published-rebind');expect((await native.send('post',`${base}/${native.documentId}/generate-file`,{version:1})).status).toBe(201);const originalNative=await db().tradeDocument.findUniqueOrThrow({where:{id:native.documentId}});await db().tradeDocument.update({where:{id:native.documentId},data:{filePath:null,fileName:null}});try{expect((await native.send('get',`${base}/${native.documentId}/download?version=1`)).status).toBe(409);expect((await native.send('post',`${base}/${native.documentId}/generate-file`,{version:1})).status).toBe(409);}finally{await db().tradeDocument.update({where:{id:native.documentId},data:{filePath:originalNative.filePath,fileName:originalNative.fileName}});}await prepare(native);await db().tradeDocument.update({where:{id:native.documentId},data:{filePath:'trade-documents/fake-legacy.pdf'}});const before=await ledger(native);expect((await native.send('post',`${base}/${native.documentId}/generate-file`,{version:2})).status).toBe(409);expect(await ledger(native)).toEqual(before);expect(await retention(native)).toEqual([]);
 });
 it('L04 mandatory reference audit failure is atomic and original unknown late-commit recovery preserves the exact N and old file',async()=>{
  const f=await legacyFixture('retention-fault');await prepare(f);const before=await ledger(f);let fired=false;const observed=db().$extends({query:{auditLog:{async create({args,query}){if(args.data.action===retainedAction){fired=true;throw new Error('PRIVATE preserve failure');}return query(args);}}}});
  const failed=await request(appFor(observed)).post(`${base}/${f.documentId}/generate-file`).set('Authorization','Bearer '+f.token).send({version:2});expect(failed.status).toBe(500);expect(fired).toBe(true);expect(JSON.stringify(failed.body)).not.toContain('PRIVATE');expect(await ledger(f)).toEqual(before);expect(fs.readFileSync(f.oldFile)).toEqual(f.oldBytes);
  const old=await fixture('unset-audit-fault');await prepare(old);const oldFacts=await ledger(old);let unsetFired=false;const unsetFault=db().$extends({query:{auditLog:{async create({args,query}){if(args.data.action==='PACKING_LIST_UNSET_HEADER_PRESERVED'){unsetFired=true;throw new Error('PRIVATE unset failure');}return query(args);}}}});const deniedUnset=await request(appFor(unsetFault)).post(`${base}/${old.documentId}/generate-file`).set('Authorization','Bearer '+old.token).send({version:1});expect(deniedUnset.status).toBe(500);expect(unsetFired).toBe(true);expect(JSON.stringify(deniedUnset.body)).not.toContain('PRIVATE');expect(await ledger(old)).toEqual(oldFacts);
  let lost=false;const client=new Proxy(db(),{get(target,key){if(key==='$transaction')return async(work:any,options:any)=>{const value:any=await target.$transaction(work,options);if(!lost&&value?.proof?.operation==='archive_packing_list_version'&&value?.replayed===false){lost=true;throw new Error('PRIVATE committed reply lost');}return value;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const recovered=await request(appFor(client)).post(`${base}/${f.documentId}/generate-file`).set('Authorization','Bearer '+f.token).send({version:2});expect(recovered.status).toBe(201);expect(lost).toBe(true);expect(recovered.body.replayed).toBe(true);expect(await retention(f)).toHaveLength(1);expect(await fileAudits(f)).toHaveLength(1);expect((await download(f,2)).status).toBe(200);expect(fs.readFileSync(f.oldFile)).toEqual(f.oldBytes);
 });
 it('L05 retained reference never relaxes current grants, signed ceilings, all-parent L2 or late revocation',async()=>{
  const f=await legacyFixture('authority');await prepare(f);const empty=createAuthService().signToken({...f.actor,permissionCeiling:[]});expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2},empty)).status).toBe(403);
  const second=peer();let fired=false;const observed=db().$extends({query:{auditLog:{async create({args,query}){const row=await query(args);if(!fired&&args.data.action==='TRADE_DOCUMENT_FILE_GENERATED'){fired=true;await second.userPermissionOverrides.deleteMany({where:{userId:f.owner,scope:'customs:write'}});}return row;}}}});const before=await ledger(f);const revoked=await request(appFor(observed)).post(`${base}/${f.documentId}/generate-file`).set('Authorization','Bearer '+f.token).send({version:2});expect(revoked.status).toBe(403);expect(fired).toBe(true);expect(await ledger(f)).toEqual(before);
  await db().userPermissionOverrides.create({data:{id:f.owner+'-restored-write',userId:f.owner,scope:'customs:write',isActive:true,grantedBy:f.owner,reason:'restore synthetic fixture grant'}});expect((await f.send('post',`${base}/${f.documentId}/generate-file`,{version:2})).status).toBe(201);await db().order.update({where:{id:f.orders[1]},data:{ownerId:f.other}});const hidden=await f.send('get',`${base}/${f.documentId}/download?version=2`);expect(hidden.status).toBe(404);expect(hidden.body.fileName).toBeUndefined();expect(hidden.headers['content-type']).toContain('application/json');expect(fs.readFileSync(f.oldFile)).toEqual(f.oldBytes);
 });
});
