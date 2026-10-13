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

import cp, { type ChildProcess } from 'node:child_process';
const origin = 'http://127.0.0.1:' + process.env.BAMBOOK_ACCEPTANCE_UI_API_PORT;
function appFor(_client: any) { return origin; }
let realBrowser: any;
let actualApi: ChildProcess | undefined;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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

beforeAll(async () => {
  const sandbox = process.env.BAMBOOK_ACCEPTANCE_SANDBOX!;
  const logfile = fs.openSync(path.join(sandbox, 'actual-index.log'), 'w');
  actualApi = cp.spawn(process.execPath, [path.resolve('dist/index.js')], {
    cwd: process.cwd(), env: { ...process.env, BAMBOOK_REQUIRE_AUTH: 'true', BAMBOOK_DEV_PANEL: 'false',
      PORT: process.env.BAMBOOK_ACCEPTANCE_UI_API_PORT!, BUILD_SHA: 'joint-pl-and-dashboard-source' },
    stdio: ['ignore', logfile, logfile],
  });
  fs.closeSync(logfile);
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(300) });
      if (r.ok) { const b: any = await r.json(); expect(b.database).toBe('ok'); expect(b.authRequired).toBe(true); healthy = true; break; }
    } catch {} await wait(50);
  }
  expect(healthy).toBe(true);
});
afterAll(async () => {
  if (actualApi) { actualApi.kill('SIGTERM');
    for (let i = 0; i < 40 && actualApi.exitCode === null && actualApi.signalCode === null; i++) await wait(50);
    // Playwright handles the first TERM while closing its real browser. Once it
    // removes that handler, repeat TERM only for this still-owned API child.
    if (actualApi.exitCode === null && actualApi.signalCode === null) actualApi.kill('SIGTERM');
    for (let i = 0; i < 40 && actualApi.exitCode === null && actualApi.signalCode === null; i++) await wait(50);
    journal({ label: 'ROOT-FULL-INDEX-STOP', pid: actualApi.pid, exitCode: actualApi.exitCode, signalCode: actualApi.signalCode });
    expect(actualApi.exitCode !== null || actualApi.signalCode !== null).toBe(true);
  }
});
describe('PL normal operation through actual full server and authentication', () => {
  it('registers one N1, opens existing draft, appends exact source N2 and downloads both immutable real PDFs', async () => {
    const f = await fixture('full-index-normal');
    expect((await request(origin).get(`${base}/${f.documentId}`)).status).toBe(401);
    const initial = await ledger(f); expect(initial.versions).toHaveLength(1);
    const repeat = await f.send('post', `${base}/generate-from-shipment`, { shipmentId: f.shipmentId, types: ['PackingList'] });
    expect(repeat.status).toBe(201); expect(repeat.body.created).toHaveLength(0); expect(repeat.body.skipped[0]).toMatchObject({ id: f.documentId, reason: 'EXISTS' });
    expect(await ledger(f)).toEqual(initial);
    const first = await f.send('post', `${base}/${f.documentId}/generate-file`, { version: 1 });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstPDF = await download(f, 1); expect(firstPDF.status).toBe(200); expect(await pdfText(firstPDF.body)).toContain('A-7');
    await db().shipmentCarton.update({ where: { id: f.cartons[0] }, data: { cartonNo: 'SOURCE-N2-42' } });
    const current = await source(f); const key = randomUUID(); const next = await append(f, current, key);
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const recovered = await f.send('get', `${base}/${f.documentId}/packing-list-commands/${key}`);
    expect(recovered.status).toBe(200); expect(recovered.body.receipt.version).toBe(2);
    const second = await f.send('post', `${base}/${f.documentId}/generate-file`, { version: 2 });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondPDF = await download(f, 2); expect(secondPDF.status).toBe(200);
    const secondText = await pdfText(secondPDF.body);
    journal({ label: 'ROOT-FULL-INDEX-PDF', text: secondText });
    expect(secondText.replace(/\s/g, '')).toContain('SOURCE-N2-42');
    expect((await download(f, 1)).body.equals(firstPDF.body)).toBe(true);
    const final = await ledger(f); expect(final.versions).toHaveLength(2); expect(final.versions[0]).toEqual(initial.versions[0]);
    expect(final.doc.status).toBe('Draft'); expect(await fileAudits(f)).toHaveLength(2);
    expect(await db().stockMovement.count()).toBe(0); expect(await db().invoice.count()).toBe(0);
    journal({label:'ROOT-FULL-INDEX',documentId:f.documentId,registeredVersions:2,archiveCount:2,recoveryStatus:recovered.status,firstPdfSame:true,originalVersionSame:true});
  });
});
