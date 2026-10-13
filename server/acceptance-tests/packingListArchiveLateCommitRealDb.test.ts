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
describe('PL archive uncertain commit retains immutable PDF', () => {
  it('a missing audit before delayed real COMMIT cannot authorize deletion; exact N downloads after commit', async () => {
    const f = await fixture('late-real-commit');
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let fired = false;
    let pendingCommit: Promise<unknown> | undefined;
    let candidatePath = '';
    let originalBytes: Buffer | undefined;
    const real = db();
    const client = new Proxy(real, {
      get(target, key) {
        if (key === '$transaction') return (work: any, options: any) => {
          if (typeof work !== 'function') return target.$transaction(work, options);
          let loseReply!: (error: Error) => void;
          const lost = new Promise<never>((_resolve, reject) => { loseReply = reject; });
          const transaction = target.$transaction(async tx => {
            const result = await work(tx);
            if (!fired && result?.replayed === false && result?.proof?.operation === 'archive_packing_list_version') {
              fired = true;
              pendingCommit = transaction;
              candidatePath = path.join(process.env.BAMBOOK_UPLOAD_DIR!, result.proof.filePath);
              originalBytes = fs.readFileSync(candidatePath);
              loseReply(new Error('PRIVATE publication reply lost before real COMMIT'));
              await hold;
            }
            return result;
          }, { ...options, timeout: 20000 });
          return Promise.race([transaction, lost]);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const unknown = await request(appFor(client)).post(`${base}/${f.documentId}/generate-file`)
        .set('Authorization', 'Bearer ' + f.token).send({ version: 1 });
      expect(unknown.status).toBe(500);
      expect(fired).toBe(true);
      expect(unknown.body.filePath).toBeUndefined();
      expect(JSON.stringify(unknown.body)).not.toContain('PRIVATE');
      const beforeCommit = await fileAudits(f);
      expect(beforeCommit).toHaveLength(0);
      journal({ label: 'ROOT-LATE-COMMIT', stage: 'unknown-before-commit', audits: beforeCommit.length,
        candidateExists: fs.existsSync(candidatePath), status: unknown.status });
      release();
      await pendingCommit;
      const audits = await fileAudits(f);
      expect(audits).toHaveLength(1);
      expect(fs.existsSync(candidatePath)).toBe(true);
      const recovered = await download(f, 1);
      expect(recovered.status).toBe(200);
      expect(recovered.body.equals(originalBytes)).toBe(true);
      const beforeRetry = await ledger(f);
      const retry = await f.send('post', `${base}/${f.documentId}/generate-file`, { version: 1 });
      expect(retry.status).toBe(201);
      expect(retry.body.replayed).toBe(true);
      expect((await download(f, 1)).body.equals(originalBytes)).toBe(true);
      expect(await ledger(f)).toEqual(beforeRetry);
      journal({ label: 'ROOT-LATE-COMMIT', stage: 'recovered-original-N', auditId: audits[0].id,
        downloadStatus: recovered.status, replayed: retry.body.replayed, sameBytes: true });
    } finally {
      release();
      await pendingCommit;
    }
  });
});
