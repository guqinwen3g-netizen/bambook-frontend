/** Opt-in actual-index/private-PG logistics followup contract. Initial unapproved
 * source/actors/customer/warehouse are explicitly synthetic. Original native
 * sample/seal/source version, PB, stock receipt, QC/business review, S/S,
 * physical allocation and dispatch producers establish the two real tickets.
 * Logistics current stored role/grants only reads; no company credentials/data. */
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
import cp, { type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict'; import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken'; import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../src/auth/service';
// All business modules and Prisma are loaded only after this explicit guard.
const sandbox=process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, markerPath=process.env.BAMBOOK_LOGISTICS_DB_MARKER!;
assert(sandbox && sandbox.startsWith('/private/tmp/bambook-logistics-native-'));
assert.equal(markerPath,path.join(sandbox,'PRIVATE-PG-MARKER.json'));
const marker=JSON.parse(fs.readFileSync(markerPath,'utf8')),url=new URL(process.env.DATABASE_URL!);
assert.equal(process.env.DB_ENV,'acceptance-private');assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.BAMBOOK_NO_SCHEDULER,'1');
assert(marker.authorized && marker.root===sandbox && fs.realpathSync(sandbox)===sandbox);
assert.equal(marker.directory,sandbox+'/postgres');assert.equal(fs.realpathSync(marker.directory),marker.directory);
assert.equal(url.protocol,'postgresql:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'acceptance');assert.equal(url.password,'');
assert.equal(url.port,String(marker.port));assert.equal(url.pathname,'/'+marker.name);assert(/^bambook_acceptance_[a-f0-9]{12}$/.test(marker.name));
assert.equal(process.env.BAMBOOK_ACCEPTANCE_DB_PORT,String(marker.port));assert.equal(process.env.BAMBOOK_ACCEPTANCE_UI_API_PORT,String(marker.apiPort));
const {Prisma,PrismaClient:PrivatePrismaClient}=require('@prisma/client') as typeof import('@prisma/client');
const prisma=new PrivatePrismaClient(),db=()=>prisma,batches=(client:any=db())=>client.productionBatch;
const { createAuthService }=require('../dist/auth/service') as typeof import('../src/auth/service');
const {buildLoadedAuthTokenPayload,loadUserWithRoles}=require('../dist/auth/tokenHelpers') as typeof import('../src/auth/tokenHelpers');
const {createSampleBatch,advanceSampleBatchStage,createSealSample,sealSampleConfirm,convertToFabricAsset}=require('../dist/development/fabricDevelopmentService') as typeof import('../src/development/fabricDevelopmentService');
const {createSample,advanceSampleStage}=require('../dist/samples/sampleManageService') as typeof import('../src/samples/sampleManageService');
const prefix='acceptance-logistics-followup-'+randomUUID(),auth=createAuthService();let sequence=0;
const origin='http://127.0.0.1:'+marker.apiPort,application=()=>({app:origin});
const diagnostic=(v:unknown)=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x);
const controlFile=sandbox+'/logistics-controls.json',journalFile=sandbox+'/logistics-query-journal.jsonl';
const observations:any[]=[];let api:ChildProcess|undefined,items:Awaited<ReturnType<typeof consumerFixture>>[]=[];
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));const configure=(v:any)=>fs.writeFileSync(controlFile,JSON.stringify(v));
const signed=(id='logistics-reader',ceiling?:string[])=>jwt.sign({userId:id,roles:['owner'],roleIds:['role-super-admin'],permissions:['orders:read','shipments:read'],...(ceiling===undefined?{}:{permissionCeiling:ceiling})},process.env.JWT_SECRET!,{expiresIn:'1h'});
const readJournal=()=>fs.existsSync(journalFile)?fs.readFileSync(journalFile,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
async function read(token?:string){const res=await fetch(origin+'/api/v1/dashboard/workbench?group=shipments',{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(5000)});const raw=await res.text(),body=JSON.parse(raw);expect(raw).not.toMatch(/PRIVATE_SQL_LOGISTICS|SELECT secret/);observations.push({status:res.status,body,journal:readJournal()});return {status:res.status,body};}
async function protectedFacts(){const models=['shipment','shipmentLine','shipmentOrderAllocation','shipmentProductionAllocation','productionBatch','productionStockReceipt','inspectionReport','releaseScope','releaseEvent','shipmentEvent','inventoryItem','stockMovement','auditLog','orderShipmentBatch'];const facts:Record<string,unknown>={};for(const model of models)facts[model]=await (db() as any)[model].findMany({orderBy:{id:'asc'}});return diagnostic(facts);}
async function readNoWrites(token?:string){const before=await protectedFacts(),result=await read(token);expect(await protectedFacts()).toBe(before);return result;}
const group=(r:any)=>{expect(r.status).toBe(200);expect(r.body.subject.userId).toMatch(/^(logistics-reader|sales-reader)$/);return r.body.groups[0];};
async function checkOverview(){const g=group(await readNoWrites(signed()));expect(g.status).toBe('ready');for(const x of items)expect(g.items.find((i:any)=>i.source.id===x.ship.id)).toMatchObject({bucket:'follow-up',source:{type:'Shipment',id:x.ship.id,state:'Shipped'},responsibility:{kind:'scope-visible',userId:null},target:{kind:'shipment',shipmentId:x.ship.id,section:'overview'}});return g;}
async function fixture(label: string, shared = false, totalQuantity = '10', initialLegacyHeaderQuantity = 10) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now()), userId = `${id}-user`,
    customerId = `${id}-customer`, supplierId = `${id}-factory`, caseId = `${id}-case`,
    orderId = `${id}-order`, lineId = `${id}-line`, otherUserId = `${id}-other-user`, teamId = `${id}-team`, shareId = `${id}-share`;
  await db().$transaction(async tx => {
    for (const uid of [userId, otherUserId]) await tx.userAccount.create({ data: { id: uid, displayName: 'Synthetic current account', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId: 'manager' } });
    await tx.userPermissionOverrides.createMany({ data: [
      'orders:read', 'orders:write', 'products:read', 'products:write', 'production:read', 'inventory:read', 'inventory:write', 'shipments:read', 'shipments:write',
    ].map(scope => ({ id: `${id}-${scope}`, userId, scope, isActive: true, grantedBy: userId, reason: 'Exact private technical grant, not company approval policy' })) });
    await tx.relation.create({ data: { id: customerId, name: customerId, category: 'Customer', type: 'Company', isOrganization: true,
      ownerId: shared ? otherUserId : userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    await tx.relation.create({ data: { id: supplierId, name: supplierId, category: 'Supplier', type: 'Company', isOrganization: true,
      ownerId: userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    await tx.developmentCase.create({ data: { id: caseId, code: caseId, name: 'Synthetic genuine source', type: 'fabric', stage: 'developing',
      owner: userId, customerRelationId: customerId, customerName: customerId, tags: [], createdAt: now, updatedAt: now } });
    await tx.order.create({ data: { id: orderId, poNumber: orderId, customer: customerId, customerRelationId: customerId,
      product: 'Synthetic fabric', type: 'fabric', quantity: initialLegacyHeaderQuantity, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 10,
      ownerId: userId, millRelationId: supplierId, sourceCaseId: caseId, importedAt: now, updatedAt: now } });
    await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', quantity: totalQuantity, unit: 'm',
      description: 'Synthetic controlled physical range', tolerancePercent: '25', toleranceSource: 'line_override' } });
    await tx.warehouse.create({ data: { id: id + '-warehouse', code: id + '-WH', name: 'Synthetic configured warehouse, no stock seeded', type: 'Main', isActive: true, createdAt: now, updatedAt: now } });
    if (shared) {
      await tx.team.create({ data: { id: teamId, name: 'Synthetic current L2 team', status: 'active' } });
      await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId } });
      await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: customerId,
        permission: 'read+followup', grantedBy: otherUserId } });
    }
  });
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId));
  expect(actor.authorizationLoaded).toBe(true); expect(actor.roles).toContain('manager'); expect(actor.permissions).toContain('orders:write');
  const f = { id, userId, otherUserId, customerId, supplierId, caseId, orderId, lineId, actor, teamId, shareId, sealId: '', assetId: '', warehouseId: id + '-warehouse' };
  // Native independent source, not a newly invented "approved" boolean.
  const made = await createSampleBatch({ prisma: db(), caseId, actorId: userId, input: { sampleType: 'yardage', supplierRelationId: supplierId } });
  expect(made.ok, diagnostic(made)).toBe(true); const sampleBatchId = (made as any).data.batch.id;
  for (const action of ['start', 'send', 'approve'] as const) {
    const current = await db().sampleBatch.findUniqueOrThrow({ where: { id: sampleBatchId } });
    const advanced = await advanceSampleBatchStage({ prisma: db(), batchId: sampleBatchId, actorId: userId, trustedActor: actor, action,
      input: { requestKey: randomUUID(), expectedRound: current.round, expectedRevision: (current.attachments as any)?.fabricHistory?.revision ?? 0,
        feedback: action === 'approve' ? 'Synthetic explicitly recorded customer recognition' : undefined } });
    expect(advanced.ok, diagnostic(advanced)).toBe(true);
  }
  const seal = await createSealSample({ prisma: db(), caseId, actorId: userId, input: { batchIds: [sampleBatchId], name: 'Synthetic native standard' } });
  expect(seal.ok, diagnostic(seal)).toBe(true); f.sealId = (seal as any).data.seal.id;
  const sealed = await sealSampleConfirm({ prisma: db(), sealId: f.sealId, actorId: userId, trustedActor: actor }); expect(sealed.ok, diagnostic(sealed)).toBe(true);
  const diagnosticDb = db();
  const asset = await convertToFabricAsset({ prisma: diagnosticDb, caseId, sourceType: 'seal', sourceId: f.sealId, actorId: userId, trustedActor: actor });
  expect(asset.ok, diagnostic(asset)).toBe(true); f.assetId = (asset as any).data.asset.id;
  const selected = await request(origin).patch(`/api/v1/order-lines/${lineId}/version`).set('Authorization', `Bearer ${auth.signToken(actor)}`)
    .send({ confirmedSourceType: 'SealSample', confirmedSourceId: f.sealId, millRelationId: supplierId });
  expect(selected.status, diagnostic(selected.body)).toBe(200);
  const current = await db().orderLine.findUniqueOrThrow({ where: { id: lineId } });
  expect(current.confirmedSourceId).toBe(f.sealId); expect(current.specSnapshot).not.toBeNull();
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const base = (f: Fixture) => `/api/v1/production-batches/orders/${f.orderId}/lines/${f.lineId}`;
async function listing(f: Fixture, app = application(), actor: TokenPayload = f.actor) {
  const r = await request(app.app).get(base(f)).set('Authorization', `Bearer ${auth.signToken(actor)}`);
  expect(r.status, diagnostic(r.body)).toBe(200); expect(r.body.ok).toBe(true);
  expect(r.body.lineFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(Array.isArray(r.body.batches)).toBe(true); return r;
}
async function command(f: Fixture, quantity = '3.25', label = 'A') {
  return { batchCode: `${f.id}-${label}`, quantity, unit: 'm', expectedLineFingerprint: (await listing(f)).body.lineFingerprint, requestKey: randomUUID() };
}
type CreateCommand = Awaited<ReturnType<typeof command>>;
const create = (f: Fixture, body: any, app = application(), actor: TokenPayload = f.actor) =>
  request(app.app).post(base(f)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
const split = (f: Fixture, parentId: string, body: any, app = application(), actor: TokenPayload = f.actor) =>
  request(app.app).post(`/api/v1/production-batches/${parentId}/split`).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function splitCommand(f: Fixture, parent: any, quantities = ['1.25', '2']) {
  return { expectedRevision: parent.revision, expectedLineFingerprint: (await listing(f)).body.lineFingerprint, requestKey: randomUUID(),
    children: quantities.map((quantity, i) => ({ batchCode: `${f.id}-child-${i}`, quantity })) };
}
async function created(f: Fixture, body: CreateCommand, app = application()) {
  const r = await create(f, body, app); expect(r.status, diagnostic(r.body)).toBe(201); expect(r.body.ok).toBe(true);
  expect(r.body.replayed).toBe(false); const actual = await batches().findUniqueOrThrow({ where: { id: r.body.batch.id } });
  expect(actual.createdBy).toBe(f.userId); expect(actual.requestKey).toBe(body.requestKey);
  expect(actual.parameterHash).toMatch(/^[a-f0-9]{64}$/); expect(actual.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(actual.commandSnapshot).toMatchObject({ ...body, quantity: new Prisma.Decimal(body.quantity).toString() }); return { response: r, batch: actual };
}

const receiptPath = (batchId: string) => `/api/v1/production-batches/${batchId}/stock-receipts`;
async function originalBatch(f: Fixture, qty = '10') { return (await created(f, await command(f, qty))).batch; }
async function receiptCommand(f: Fixture, batch: any, quantity = '3.2501') {
  const current = await request(application().app).get(receiptPath(batch.id)).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(current.status, diagnostic(current.body)).toBe(200);
  expect(current.body.scopeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  return { expectedBatchRevision: batch.revision, expectedScopeFingerprint: current.body.scopeFingerprint,
    warehouseId: f.warehouseId, quantity, unit: 'm', movementDate: '2099-10-02',
    receiptReference: 'Synthetic software receipt observation; no actual manufactured goods',
    ownership: 'Owned', unitCost: null, currency: 'USD', requestKey: randomUUID() };
}
const receive = (f: Fixture, batch: any, body: any, app = application(), actor = f.actor) =>
  request(app.app).post(receiptPath(batch.id)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);

const nativeAction = 'create_physical_shipment_allocation';
async function draft(f: Fixture) {
  const r = await request(application().app).post('/api/v1/shipping').set('Authorization', `Bearer ${auth.signToken(f.actor)}`)
    .send({ type: 'Export', shippingMethod: 'Sea', status: 'Draft', customerRelationId: f.customerId, customerName: f.customerId, notes: 'Synthetic draft only; no factory/shipment/QC fact' });
  expect(r.status, diagnostic(r.body)).toBe(201); expect(r.body.status).toBe('Draft'); return r.body;
}
const postPath = (ship: any) => `/api/v1/shipping/${ship.id}/allocations`;
const post = (f: Fixture, ship: any, body: any, app = application(), actor = f.actor) => request(app.app).post(postPath(ship)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
const patchAllocation = (f: Fixture, ship: any, allocationId: string, body: any, actor = f.actor) => request(application().app)
  .patch(`${postPath(ship)}/${allocationId}`).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function row(f: Fixture, batch: any, plannedQty: string | null, actualQty: string | null = null, stockReceiptId: string | null = null) {
  const current = await request(application().app).get(receiptPath(batch.id)).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(current.status, diagnostic(current.body)).toBe(200);
  return { productionBatchId: batch.id, expectedRevision: batch.revision, expectedScopeFingerprint: current.body.scopeFingerprint, stockReceiptId, plannedQty, actualQty, unit: 'm' };
}
const input = (f: Fixture, rows: any[], plannedQty: string | null, actualQty: string | null = null) => ({ orderId: f.orderId, orderLineId: f.lineId,
  plannedQty, actualQty, unit: 'm', requestKey: randomUUID(), productionBatchAllocations: rows });
async function facts(f: Fixture) { return { allocations: await db().shipmentOrderAllocation.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
  physical: await db().shipmentProductionAllocation.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
  audits: await db().auditLog.findMany({ where: { actorId: f.userId, action: { in: [nativeAction, 'update_physical_shipment_allocation'] } }, orderBy: { id: 'asc' } }) }; }
async function qualifiedFinal(f: Fixture, batch: any, result: 'pass' | 'fail' = 'pass') {
  await db().userPermissionOverrides.createMany({ data: [f.userId, f.otherUserId].flatMap(userId =>
    ['qc:read', 'qc:write', 'orders:read'].map(scope => ({ id: `${f.id}-${userId}-${scope}`, userId,
      scope, isActive: true, grantedBy: f.userId, reason: 'Explicit synthetic QC control capability; not company role-policy UAT' }))), skipDuplicates: true });
  f.actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.userId));
  const inspector = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.otherUserId));
  const app = application();
  const http = (method: 'get' | 'post', url: string, actor = f.actor) => request(app.app)[method](url).set('Authorization', `Bearer ${auth.signToken(actor)}`);
  const scopes = await http('get', `/api/v1/qc/orders/${f.orderId}/inspection-scopes`);
  expect(scopes.status, diagnostic(scopes.body)).toBe(200);
  const scope = scopes.body.scopes.find((row: any) => row.productionBatchId === batch.id);
  expect(scope, 'native current batch coverage').toBeTruthy();
  const assigned = await http('post', '/api/v1/qc/assignments').send({ orderId: f.orderId, inspectionType: 'final', qcUserId: f.otherUserId,
    dueDate: '2099-01-01', scopeType: 'production_batch', productionBatchId: batch.id,
    expectedBatchRevision: batch.revision, expectedScopeFingerprint: scope.scopeFingerprint, requestKey: randomUUID() });
  expect(assigned.status, diagnostic(assigned.body)).toBe(201);
  const started = await http('post', `/api/v1/qc/assignments/${assigned.body.item.id}/start`, inspector);
  expect(started.status, diagnostic(started.body)).toBe(200);
  const completed = await http('post', `/api/v1/qc/assignments/${assigned.body.item.id}/complete`, inspector).send({
    requestKey: randomUUID(), expectedScopeFingerprint: scope.scopeFingerprint, report: { result,
      inspectionDate: '2026-10-02', totalUnits: 10, passedUnits: result === 'pass' ? 10 : 0,
      criticalDefects: result === 'pass' ? 0 : 1, majorDefects: 0, minorDefects: 0, sampleSize: 10, lotSize: 10 } });
  expect(completed.status, diagnostic(completed.body)).toBe(200);
  expect(completed.body.report.approvedByBusiness).toBe(false);
  const report = completed.body.report;
  const decided = await http('post', `/api/v1/qc/reports/${report.id}/business-decision`).send({ decision: 'approved',
    expectedRevision: report.revision, expectedScopeFingerprint: report.scopeFingerprint,
    expectedContentFingerprint: report.contentFingerprint, requestKey: randomUUID(), reason: 'Synthetic recorded business review; no factory instruction or actual shipping' });
  expect(decided.status, diagnostic(decided.body)).toBe(200);
  expect(decided.body.item.approvedByBusiness).toBe(true); return decided.body.item;
}
async function confirmedShipSample(f: Fixture) {
  const made = await createSample({ prisma: db(), actorId: f.userId, input: { type: 'ship', sourceCaseId: f.caseId,
    sourceOrderId: f.orderId, customerRelationId: f.customerId, supplierRelationId: f.supplierId,
    notes: 'Synthetic actual S/S workflow control, no external delivery' } });
  expect(made.ok, diagnostic(made)).toBe(true); const sampleId = (made as any).data.sample.id;
  for (const action of ['start', 'qc', 'submit', 'confirm'] as const) {
    const next = await advanceSampleStage({ prisma: db(), sampleId, actorId: f.userId, action,
      input: { qcStatus: 'passed', sentDate: '2026-10-02', customerStatus: 'approved',
        feedback: 'Synthetic native software confirmation; not actual customer approval' } });
    expect(next.ok, diagnostic(next)).toBe(true);
  }
  const current = await db().sample.findUniqueOrThrow({ where: { id: sampleId } });
  expect(current.customerStatus).toBe('approved'); expect(current.sourceOrderId).toBe(f.orderId); return current;
}
async function physicalCommand(f: Fixture, ship: any, patch: any, app = application()) {
  const current = await request(app.app).get(`/api/v1/shipping/${ship.id}/physical-context`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(current.status, diagnostic(current.body)).toBe(200); expect(current.body.kind).toBe('physical');
  return { ...patch, requestKey: randomUUID(), expectedShipmentUpdatedAt: current.body.updatedAt,
    expectedPhysicalAllocationFingerprint: current.body.allocationFingerprint };
}
const dispatchPatch = { status: 'Shipped', loadType: 'LCL', vesselOrFlight: 'Synthetic controlled vessel', voyageNumber: 'CTRL-001',
  portOfLoading: 'Synthetic origin', portOfDischarge: 'Synthetic destination' };
const patchShip = (f: Fixture, ship: any, body: any, app = application(), actor = f.actor) => request(app.app)
  .patch(`/api/v1/shipping/${ship.id}`).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function consumerFixture(label: string, reportResult: 'pass' | 'fail' = 'pass') {
  const f = await fixture(label), batch = await originalBatch(f);
  const firstCommand = await receiptCommand(f, batch, '3.2501'), first = await receive(f, batch, firstCommand);
  expect(first.status, diagnostic(first.body)).toBe(201);
  const now = BigInt(Date.now()), secondWarehouseId = `${f.id}-WH2`;
  await db().warehouse.create({ data: { id: secondWarehouseId, code: secondWarehouseId, name: 'Configured second synthetic warehouse', type: 'Other', isActive: true, createdAt: now, updatedAt: now } });
  const secondCommand = { ...await receiptCommand(f, batch, '6.7499'), warehouseId: secondWarehouseId }, second = await receive(f, batch, secondCommand);
  expect(second.status, diagnostic(second.body)).toBe(201);
  const ship = await draft(f), rows = [await row(f, batch, '3.2501', '3.2501', first.body.receipt.id),
    await row(f, batch, '6.7499', '6.7499', second.body.receipt.id)];
  const allocated = await post(f, ship, input(f, rows, '10', '10'));
  expect(allocated.status, diagnostic(allocated.body)).toBe(201);
  const packing = await request(application().app).post(`/api/v1/shipping/${ship.id}/lines/pull-from-order`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(packing.status, diagnostic(packing.body)).toBe(200); expect(new Prisma.Decimal(packing.body.lines[0].quantity).toString()).toBe('10');
  const report = await qualifiedFinal(f, batch, reportResult), sample = await confirmedShipSample(f);
  // Preserve the real state machine: this control must use native booking
  // before it reaches dispatch, not weaken Draft -> Shipped to reach the gate.
  const booked = await patchShip(f, ship, await physicalCommand(f, ship, { status: 'Booked' }));
  expect(booked.status, diagnostic(booked.body)).toBe(200); expect(booked.body.status).toBe('Booked');
  return { f, batch, first: first.body.receipt, second: second.body.receipt, ship, allocated: allocated.body, report, sample };
}

beforeAll(async()=>{
 const [identity]=await db().$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');return tx.$queryRawUnsafe<any[]>("SELECT current_database() AS name, inet_server_port() AS port, current_setting('data_directory') AS directory");});expect(identity).toEqual({name:marker.name,port:marker.port,directory:marker.directory});fs.writeFileSync(sandbox+'/logistics-native-identity.json',JSON.stringify(identity));
 const preload=sandbox+'/logistics-before-prisma.cjs';
 fs.writeFileSync(preload,`const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict'),Module=require('module');
 const m=JSON.parse(fs.readFileSync(${JSON.stringify(markerPath)}));const u=new URL(process.env.DATABASE_URL);assert.equal(process.env.DB_ENV,'acceptance-private');assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.BAMBOOK_NO_SCHEDULER,'1');assert.equal(process.env.BAMBOOK_REQUIRE_AUTH,'true');assert.equal(process.env.BAMBOOK_ACCEPTANCE_SANDBOX,m.root);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'acceptance');assert.equal(u.password,'');assert.equal(u.port,String(m.port));assert.equal(u.pathname,'/'+m.name);assert.equal(process.env.PORT,String(m.apiPort));assert.equal(fs.realpathSync(m.directory),m.directory);const identity=cp.execFileSync(m.pg+'/psql',['-h','127.0.0.1','-p',String(m.port),'-U','acceptance','-d',m.name,'-X','-Atq','-c',"BEGIN READ ONLY; SELECT current_database()||'|'||inet_server_port()||'|'||current_setting('data_directory'); COMMIT;"],{encoding:'utf8'}).trim();assert.equal(identity,m.name+'|'+m.port+'|'+m.directory);
 const load=Module._load,seen=new WeakMap(),file=m.root+'/logistics-controls.json',journal=m.root+'/logistics-query-journal.jsonl';
 function wrapped(client){fs.appendFileSync(journal,JSON.stringify({kind:'transactionShape',actualType:typeof client.$transaction})+'\\n');return new Proxy(client,{get(t,k){if(k==='$transaction'&&typeof t.$transaction==='function')return async(work,options)=>typeof work==='function'?t.$transaction(tx=>work(wrapped(tx)),options):t.$transaction(work,options);const value=Reflect.get(t,k,t);if(!['shipment','shipmentOrderAllocation','order','teamMember'].includes(k))return typeof value==='function'?value.bind(t):value;return new Proxy(value,{get(d,method){const fn=Reflect.get(d,method,d);if(method!=='findMany')return typeof fn==='function'?fn.bind(d):fn;return async(query)=>{const c=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};fs.appendFileSync(journal,JSON.stringify({model:k,method,query})+'\\n');if(c.fault===k)throw new Error('PRIVATE_SQL_LOGISTICS SELECT secret');const rows=await fn.call(d,query);if(c.pause&&k==='shipment'&&query.where?.status?.in){c.pause=false;fs.writeFileSync(file,JSON.stringify(c));fs.writeFileSync(m.root+'/logistics-paused','ready');for(let i=0;i<400;i++){if(fs.existsSync(m.root+'/logistics-resume'))break;await new Promise(r=>setTimeout(r,5));}assert(fs.existsSync(m.root+'/logistics-resume'),'private read not resumed');}return rows;};}});}});}
 Module._load=function(id,parent,main){const e=load.apply(this,arguments);if(id!=='@prisma/client'||!e.PrismaClient)return e;if(seen.has(e))return seen.get(e);class Guarded extends e.PrismaClient{constructor(...args){super(...args);return wrapped(this);}}const out={...e,PrismaClient:Guarded};seen.set(e,out);return out;};`);
 configure({});const log=fs.openSync(sandbox+'/actual-index.log','w');api=cp.spawn(process.execPath,[path.resolve('dist/index.js')],{cwd:process.cwd(),env:{...process.env,BAMBOOK_REQUIRE_AUTH:'true',BAMBOOK_DEV_PANEL:'false',PORT:String(marker.apiPort),BUILD_SHA:'5c8632f4ce608daf539cd9ef7a321560a3975317',BAMBOOK_UPLOAD_DIR:sandbox+'/uploads',BAMBOOK_PRIVATE_FILES_DIR:sandbox+'/private-files',BAMBOOK_LOG_DIR:sandbox+'/logs',NODE_OPTIONS:'--require='+preload+' --require='+path.resolve('../scripts/acceptance-network-guard.cjs')},stdio:['ignore',log,log]});fs.closeSync(log);
 let healthy=false;for(let i=0;i<100;i++){try{const r=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(300)});if(r.ok){const b:any=await r.json();expect(b.database).toBe('ok');expect(b.authRequired).toBe(true);healthy=true;break;}}catch{}await wait(50);}expect(healthy).toBe(true);
 await db().role.upsert({where:{id:'manager'},create:{id:'manager',name:'Synthetic current leader',isSystem:true},update:{}});
 for(const [id,role] of [['logistics-reader','role-logistics'],['sales-reader','role-sales']]){await db().role.upsert({where:{id:role},create:{id:role,name:role,isSystem:true},update:{}});await db().userAccount.create({data:{id,displayName:id,status:'active'}});await db().userRole.create({data:{id:'UR-'+id,userId:id,roleId:role}});for(const scope of ['shipments:read','orders:read']){const p=await db().permission.upsert({where:{scope},create:{id:'P-'+scope,scope},update:{}});await db().rolePermission.upsert({where:{roleId_permissionId:{roleId:role,permissionId:p.id}},create:{id:'RP-'+role+'-'+scope,roleId:role,permissionId:p.id},update:{}});}}
 items=[await consumerFixture('first-real-ticket'),await consumerFixture('second-real-ticket')];
});
beforeEach(async()=>{configure({});for(const x of ['logistics-paused','logistics-resume'])if(fs.existsSync(sandbox+'/'+x))fs.unlinkSync(sandbox+'/'+x);for(const role of ['role-logistics','role-sales'])await db().rolePermission.upsert({where:{roleId_permissionId:{roleId:role,permissionId:'P-shipments:read'}},create:{id:'RP-'+role+'-shipments:read',roleId:role,permissionId:'P-shipments:read'},update:{}});fs.writeFileSync(journalFile,'');});
afterAll(async()=>{configure({});fs.writeFileSync(sandbox+'/logistics-resume','release');if(api){api.kill('SIGTERM');for(let i=0;i<30&&api.exitCode===null&&api.signalCode===null;i++)await wait(50);expect(api.exitCode!==null||api.signalCode!==null).toBe(true);}await db().$disconnect();fs.writeFileSync(sandbox+'/logistics-observations.json',JSON.stringify({observations,indexStopped:!api||api.exitCode!==null||api.signalCode!==null},null,2));});

describe('actual index current Logistics post-dispatch followup',()=>{
 it('LWQ01 original Booked packing then two real native dispatches retain exact overview targets without read writes',async()=>{
  const before=group(await readNoWrites(signed()));expect(before.total).toBe(2);expect(before.items.map((i:any)=>i.target.section)).toEqual(['packing','packing']);
  for(const x of items){const sent=await patchShip(x.f,x.ship,await physicalCommand(x.f,x.ship,dispatchPatch));expect(sent.status,diagnostic(sent.body)).toBe(200);expect(sent.body.status).toBe('Shipped');expect(await db().stockMovement.count({where:{referenceType:'Shipment',referenceId:x.ship.id,type:'Outbound'}})).toBe(2);}
  const after=await checkOverview();expect(after.total).toBe(2);expect(after.items.every((i:any)=>i.source.state==='Shipped')).toBe(true);
 });
 it('LWQ02 real Arrived and Cleared keep overview, Delivered and Cancelled end logistics followup; null ATA never claims arrival',async()=>{
  await checkOverview();const x=items[0];expect((await db().shipment.findUniqueOrThrow({where:{id:x.ship.id}})).ata).toBeNull();
  for(const status of ['Arrived','Cleared','Delivered']){const response=await patchShip(x.f,x.ship,await physicalCommand(x.f,x.ship,{status}));expect(response.status,diagnostic(response.body)).toBe(200);const g=group(await readNoWrites(signed()));const item=g.items.find((i:any)=>i.source.id===x.ship.id);if(status==='Delivered')expect(item).toBeUndefined();else{expect(item.source.state).toBe(status);expect(item.target).toEqual({kind:'shipment',shipmentId:x.ship.id,section:'overview'});}}
  const y=items[1];const cancelled=await patchShip(y.f,y.ship,await physicalCommand(y.f,y.ship,{status:'Cancelled'}));expect(cancelled.status,diagnostic(cancelled.body)).toBe(200);expect(group(await readNoWrites(signed())).total).toBe(0);
 });
 it('LWQ03 anonymous cannot read the personal logistics home',async()=>{expect((await readNoWrites()).status).toBe(401);});
 it('LWQ04 actual current stored grant withdrawal beats stale owner JWT and reads no shipment source',async()=>{await db().rolePermission.delete({where:{roleId_permissionId:{roleId:'role-logistics',permissionId:'P-shipments:read'}}});const g=group(await readNoWrites(signed()));expect(g).toMatchObject({status:'forbidden',items:null,total:null});expect(readJournal().filter(x=>x.model==='shipment')).toHaveLength(0);});
 it('LWQ05 signed empty ceiling stays forbidden despite current stored Logistics grant',async()=>{const g=group(await readNoWrites(signed('logistics-reader',[])));expect(g).toMatchObject({status:'forbidden',items:null,total:null});expect(readJournal().filter(x=>x.model==='shipment')).toHaveLength(0);});
 it('LWQ06 original current Sales L2 includes real non-primary SOA, excludes foreign and standalone; current Logistics null scope includes standalone',async()=>{
  for(const [id,ownerId] of [['O-sales','sales-reader'],['O-foreign','foreign-reader']])await db().order.create({data:{id,ownerId,customer:'Synthetic L2',product:'Synthetic',type:'Fabric',quantity:1,status:'Shipping',dueDate:'2099-01-01',quoteAmount:1}});
  for(const [id,orderId] of [['S-primary','O-sales'],['S-merged','O-foreign'],['S-foreign','O-foreign'],['S-standalone',null]])await db().shipment.create({data:{id:id!,shipmentNumber:id!,orderId,status:'Shipped',type:'Export',shippingMethod:'Sea',ata:null,createdAt:BigInt(1),updatedAt:BigInt(1)}});
  await db().shipmentOrderAllocation.create({data:{id:'A-merged',shipmentId:'S-merged',orderId:'O-sales',status:'Fulfilled',createdAt:BigInt(1),updatedAt:BigInt(1)}});
  const limited=group(await readNoWrites(signed('sales-reader')));expect(limited.status).toBe('ready');expect(limited.items.map((i:any)=>i.source.id).sort()).toEqual(['S-merged','S-primary']);for(const item of limited.items)expect(item.target).toEqual({kind:'shipment',shipmentId:item.source.id,section:'overview'});
  const all=group(await readNoWrites(signed()));expect(all.items.map((i:any)=>i.source.id)).toContain('S-standalone');
 });
 it('LWQ07 actual shipment, SOA and team read failures are safe failed sources, never a ready zero',async()=>{for(const fault of ['shipment','shipmentOrderAllocation','teamMember']){configure({fault});const g=group(await readNoWrites(signed('sales-reader')));expect(g).toMatchObject({status:'failed',items:null,total:null});expect(readJournal().some(x=>x.model===fault)).toBe(true);configure({});}});
 it('LWQ08 separate connection withdraws current grant during actual first read; response rejects stale overview and does no business writes',async()=>{
  configure({pause:true});const before=await protectedFacts(),pending=read(signed());for(let i=0;i<200&&!fs.existsSync(sandbox+'/logistics-paused');i++)await wait(5);expect(fs.existsSync(sandbox+'/logistics-paused')).toBe(true);await db().rolePermission.delete({where:{roleId_permissionId:{roleId:'role-logistics',permissionId:'P-shipments:read'}}});fs.writeFileSync(sandbox+'/logistics-resume','ok');const response=await pending;expect(response.status).toBe(503);expect(response.body.groups).toBeUndefined();expect(await protectedFacts()).toBe(before);
 });
 it('LWQ09 separate connection transfers actual visible parent during first read; no old SOA-linked target leaves',async()=>{
  configure({pause:true});const before=await protectedFacts(),pending=read(signed('sales-reader'));for(let i=0;i<200&&!fs.existsSync(sandbox+'/logistics-paused');i++)await wait(5);expect(fs.existsSync(sandbox+'/logistics-paused')).toBe(true);await db().order.update({where:{id:'O-sales'},data:{ownerId:'foreign-reader'}});fs.writeFileSync(sandbox+'/logistics-resume','ok');expect(group(await pending)).toMatchObject({status:'failed',items:null,total:null});expect(await protectedFacts()).toBe(before);
 });
});
