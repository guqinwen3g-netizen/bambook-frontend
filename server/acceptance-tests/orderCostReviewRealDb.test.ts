/**
 * Opt-in actual OrderCostReview HTTP/current DB grants/PG/audit/private bytes.
 * Synthetic commercial invoices and completed shipment facts bound the cost
 * review layer; this is not invoice issuance, shipping UAT or document-content
 * approval by a real finance user. Actual receipt/PSD services supply their own
 * evidence, and no Review/ReviewEvidence or approved flag is seeded.
 * No seed, index, scheduler, shared DB or cleanup-by-delete.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createInventoryService } from '../src/inventory/inventoryService';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createOrderCostReviewRouter } from '../src/pricing/orderCostReviewRoute';
import { authorizeOrderCostReview, createOrderCostReviewFiles, readCurrentOrderCostReview } from '../src/pricing/orderCostReviewService';
import { COST_CATEGORIES } from '../src/pricing/orderCostReviewSource';
import { createCostRecordRouter } from '../src/finance/billingItemRoute';
import { createProcurementService } from '../src/procurement/procurementService';
import { createPurchaseServiceDeliveryService } from '../src/procurement/purchaseServiceDeliveryService';
import { registerL8AutoStockIn } from '../src/events/linkages/L8AutoStockIn';
import { businessEventBus } from '../src/events/businessEventBus';
import { createProfitSheetService } from '../src/pricing/profitSheetService';

const prefix = `acceptance-cost-review-${randomUUID()}`;
const auth = createAuthService();
const grants = ['pricing:read', 'sensitive:cost', 'invoices:read', 'invoices:write', 'invoices:reconcile'];
const rootPath = '/api/v1/pricing/order-cost-reviews';
let prisma: PrismaClient | undefined, fileRoot: string;
let files: ReturnType<typeof createOrderCostReviewFiles>;
let sequence = 0;
const db = (): any => { if (!prisma) throw Error('isolated cost-review fixture not initialized'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
async function actor(label: string, scopes = grants, ceiling?: string[], owner = false) {
  const id = `${prefix}-${++sequence}-${label}`, roleId = `${id}-configured-role`;
  await db().userAccount.create({ data: { id, displayName: 'Synthetic cost-review operator', status: 'active' } });
  await db().role.create({ data: { id: roleId, name: 'Synthetic explicit financial scopes', isSystem: false } });
  await db().userRole.create({ data: { id: `${id}-role`, userId: id, roleId } });
  for (const scope of scopes) {
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-${scope}`, scope } });
    await db().rolePermission.create({ data: { id: `${id}-${scope}`, roleId, permissionId: permission.id } });
  }
  if (owner) {
    await db().role.upsert({ where: { id: 'role-super-admin' }, update: {}, create: { id: 'role-super-admin', name: 'Synthetic canonical owner', isSystem: true } });
    await db().userRole.create({ data: { id: `${id}-owner`, userId: id, roleId: 'role-super-admin' } });
  }
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(current).not.toBeNull();
  for (const scope of scopes) expect(current!.scopes).toContain(scope);
  const token = auth.signToken({ userId: id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds, permissions: current!.scopes, departmentIds: current!.departmentIds, authorizationLoaded: true, ...(ceiling ? { permissionCeiling: ceiling } : {}) });
  return { id, roleId, token };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function app(database = db(), notify = vi.fn()) {
  const result = express(); result.use(express.json());
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use(rootPath, createOrderCostReviewRouter({ prisma: database, requireAuth: true, apiKeys: new Set(), files, onDataChange: notify }));
  result.use('/api/v1/cost-records', createCostRecordRouter({ prisma: database, requireAuth: true, apiKeys: new Set(), onDataChange: notify }));
  return result;
}
async function sources(who: Actor, orderId: string) {
  const response = await request(app()).get(`${rootPath}/${orderId}`).set('Authorization', `Bearer ${who.token}`);
  expect(response.status, diagnostic(response.body)).toBe(200); return response.body;
}
async function fixture(label: string, who: Actor, material = false) {
  const id = `${prefix}-order-${++sequence}-${label}`, now = BigInt(Date.now());
  const lineId = `${id}-line`, poId = `${id}-purchase`, purchaseLineId = `${id}-purchase-line`, arId = `${id}-ar`, apId = `${id}-ap`;
  const quantity = material ? '600' : '100', unit = material ? 'M' : 'PC', supplierId = `${id}-supplier`;
  await db().relation.create({ data: { id: supplierId, name: 'Synthetic cost supplier', category: 'Supplier', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: now } });
  await db().order.create({ data: { id, customer: 'Synthetic external customer', product: 'Synthetic delivered goods', type: 'Fabric', quantity: 100, status: 'Completed', dueDate: '2026-10-01', quoteAmount: 2000, deliveryTerms: 'FOB', ownerId: who.id, updatedAt: now } });
  await db().orderLine.create({ data: { id: lineId, orderId: id, lineNumber: 1, quantity: 100, unit: 'PC', unitPrice: 20, materialCode: `${id}-goods` } });
  await db().purchaseOrder.create({ data: { id: poId, poNumber: poId, orderId: id, supplierRelationId: supplierId, status: 'Confirmed', currency: 'CNY', totalAmount: material ? 6000 : 9999, orderDate: '2026-10-01', createdAt: now, updatedAt: now, lines: { create: { id: purchaseLineId, orderLineId: lineId, kind: material ? 'Material' : 'FinishedGoods', lineNumber: 1, materialCode: `${id}-source`, description: 'Synthetic procurement', quantity, unit, unitPrice: material ? 10 : 99.99, amount: material ? 6000 : 9999, createdAt: now } } } });
  // Actual domain receipt creates accepted quantity, immutable receipt audit and outbox.
  const warehouse = await createInventoryService(db()).createWarehouse({code:`${id}-warehouse`,name:'Synthetic physical receipt warehouse',type:'Main'},who.id);
  const receipt = await createProcurementService(db()).createMaterialReceipt(poId, { receiptNumber: `${id}-receipt`, receivedDate: '2026-10-01', warehouseId: warehouse.id, totalReceived: Number(quantity), totalAccepted: Number(quantity), totalRejected: 0, lineReceipts: [{ lineId: purchaseLineId, accepted: Number(quantity), rejected: 0 }] }, who.id, { expectedOrderId: id });
  await db().invoice.create({ data: { id: arId, invoiceNumber: arId, type: 'Receivable', status: 'Issued', orderId: id, amount: 2000, currency: 'CNY', issueDate: '2026-10-01', createdAt: now, updatedAt: now } });
  await db().invoice.create({ data: { id: apId, invoiceNumber: apId, type: 'Payable', status: 'Issued', orderId: id, customerRelationId: supplierId, sourceType: 'PurchaseOrder', sourceId: poId, amount: material ? 6000 : 1200, currency: 'CNY', issueDate: '2026-10-01', createdAt: now, updatedAt: now } });
  const shipmentId = `${id}-shipment`;
  await db().shipment.create({ data: { id: shipmentId, shipmentNumber: shipmentId, type: 'Export', status: 'Shipped', shippingMethod: 'Sea', orderId: id, createdAt: now, updatedAt: now } });
  await db().shipmentOrderAllocation.create({ data: { id: `${id}-allocation`, shipmentId, orderId: id, orderLineId: lineId, plannedQty: 100, actualQty: 100, unit: 'PC', status: 'Fulfilled', createdAt: now, updatedAt: now } });
  const uploaded = await request(app()).post(`${rootPath}/${id}/evidence`).set('Authorization', `Bearer ${who.token}`).field('requestId', `${id}-proof`).field('note', 'Synthetic whole-order financial bill/coverage proof; content still requires human review').attach('file', Buffer.from('%PDF-1.4\nSynthetic isolated reconciliation\n%%EOF'), 'reconciliation.pdf');
  expect(uploaded.status, diagnostic(uploaded.body)).toBe(201); const evidenceId = uploaded.body.evidence.id as string;
  const state = await sources(who, id);
  const input = { sourceFingerprint: state.sourceFingerprint, bills: [{ invoiceId: apId, purchaseOrderId: poId, purchaseLineIds: [purchaseLineId], serviceDeliveryIds: [], treatment: material ? 'stock_valuation' : 'cost', evidenceIds: [evidenceId] }], supply: [] as any[], expenses: [] as any[], coverage: Object.fromEntries(COST_CATEGORIES.map(category => [category, { status: category === 'procurement' ? 'verified' : 'not_applicable', note: 'Synthetic documented final financial reconciliation', evidenceIds: [evidenceId] }])), expectedRevision: 0, requestId: `${id}-confirm`, note: 'Synthetic actual finance confirmation' };
  return { id, lineId, poId, purchaseLineId, arId, apId, supplierId, receiptId: receipt.id, shipmentId, evidenceId, input, who };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const confirm = (x: Fixture, input = x.input, who = x.who, database = db(), notify = vi.fn()) => request(app(database, notify)).post(`${rootPath}/${x.id}/confirm`).set('Authorization', `Bearer ${who.token}`).send(input);
const retire = (x: Fixture, input = x.input, who = x.who, database = db()) => request(app(database)).post(`${rootPath}/${x.id}/requests/retire`).set('Authorization', `Bearer ${who.token}`).send(input);
const preview = (x: Fixture) => { const { expectedRevision: _rev, requestId: _key, note: _note, ...input } = x.input; return request(app()).post(`${rootPath}/${x.id}/preview`).set('Authorization', `Bearer ${x.who.token}`).send(input); };
async function state(x: Fixture) {
  return { reviews: await db().orderCostReview.findMany({ where: { orderId: x.id }, orderBy: { revision: 'asc' } }), audits: await db().auditLog.findMany({ where: { action: 'order_cost_review_confirm', actorId: x.who.id }, orderBy: { id: 'asc' } }) };
}

describe.sequential('OrderCostReview actual HTTP/PG immutable final facts', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true);
    expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe(port); expect(url.pathname).toBe(`/${name}`); expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(Boolean(directory)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`;
    expect(identity, 'strict actual database identity BEFORE any fixture or file write').toEqual([{ name, directory, port: Number(port) }]);
    fileRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-files-`)); files = createOrderCostReviewFiles(fileRoot);
  });
  afterAll(async () => { await prisma?.$disconnect(); if (fileRoot) await fs.rm(fileRoot, { recursive: true, force: true }); });

  it('OCR01 audited explicit legacy bill binding+original bytes establishes1200 cost while PO commitment is9999', async () => {
    const who = await actor('direct'); const x = await fixture('direct', who); const notify = vi.fn();
    await db().invoice.update({ where: { id: x.apId }, data: { sourceType: null, sourceId: null } });
    x.input.sourceFingerprint = (await sources(who, x.id)).sourceFingerprint;
    expect((await preview(x)).body).toMatchObject({ status: 'complete', actualCostCny: 1200, actualRevenueCny: 2000 });
    const response = await confirm(x, x.input, who, db(), notify); expect(response.status, diagnostic(response.body)).toBe(201);
    expect(response.body.item).toMatchObject({ orderId: x.id, revision: 1, confirmedBy: who.id, actualCostCny: 1200, actualRevenueCny: 2000 });
    const stored = await db().orderCostReview.findUniqueOrThrow({ where: { id: response.body.item.id } });
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: stored.auditId } });
    expect(audit).toMatchObject({ actorId: who.id, action: 'order_cost_review_confirm', targetId: stored.id });
    expect(audit.detail.after).toMatchObject({ id: stored.id, orderId: x.id, revision: 1, actorId: who.id, sourceFingerprint: x.input.sourceFingerprint, requestFingerprint: stored.requestFingerprint, actualCostCny: '1200' });
    expect(audit.detail.after.billBindings).toEqual(x.input.bills);
    expect(await readCurrentOrderCostReview(db(), x.id, files)).toMatchObject({ status: 'complete', actualCostCny: 1200, actualBreakdown: { procurement: 1200 } });
    const sheet = await createProfitSheetService(db(), { reviewEvidenceFiles: files }).generateOrderProfitSheet(x.id, who.id);
    expect(Number(sheet.purchaseCost)).toBe(9999); expect(sheet.details.costEvidence).toMatchObject({ status: 'complete', actualCostCny: 1200, actualProfitCny: 800 }); expect(sheet.grossProfit).toBe(800); expect(sheet.grossMargin).toBe(40);
    expect(notify).toHaveBeenCalledTimes(1);
    const download = await request(app()).get(`${rootPath}/${x.id}/evidence/${x.evidenceId}/download`).set('Authorization', `Bearer ${who.token}`); expect(download.status).toBe(200); expect(download.headers['cache-control']).toBe('private, no-store');
  });
  it('OCR02 actual material receipt/L8 plus300+180 PSD and formal source bills cost5000+960, not payments', async () => {
    const who = await actor('supply'), x = await fixture('supply', who, true), now = BigInt(Date.now());
    const warehouseId = (await db().materialReceipt.findUniqueOrThrow({where:{id:x.receiptId}})).warehouseId!;
    let execute: ((database: any, event: any) => Promise<any>) | undefined;
    const register = vi.spyOn(businessEventBus, 'registerLinkage').mockImplementation(handler => { execute = handler.execute; });
    registerL8AutoStockIn(); register.mockRestore(); expect(execute).toBeTypeOf('function');
    const stocked = await execute!(db(), { id: `${x.id}-l8`, type: 'MaterialReceived', sourceEntityId: x.poId, actorId: who.id, payload: { purchaseOrderId: x.poId, receiptId: x.receiptId, warehouseId, stockInLines: [{ lineId: x.purchaseLineId, materialCode: `${x.id}-source`, description: 'Synthetic actual material', quantity: 600, unit: 'M', unitPrice: 10 }] } });
    expect(stocked, diagnostic(stocked)).toMatchObject({ ok: true });
    const movement = await db().stockMovement.findFirstOrThrow({ where: { referenceId: x.receiptId, type: 'Inbound' } }); expect(movement.quantity.toString()).toBe('600');
    const servicePO = `${x.id}-service-po`, serviceLine = `${x.id}-service-line`;
    await db().purchaseOrder.create({ data: { id: servicePO, poNumber: servicePO, orderId: x.id, supplierRelationId: x.supplierId, status: 'Confirmed', currency: 'CNY', totalAmount: 960, orderDate: '2026-10-01', createdAt: now, updatedAt: now, lines: { create: { id: serviceLine, orderLineId: x.lineId, kind: 'ProcessingService', lineNumber: 1, description: 'Synthetic processing', quantity: 480, unit: 'M', unitPrice: 2, amount: 960, createdAt: now } } } });
    const services = createPurchaseServiceDeliveryService(db());
    for (const qty of [300, 180]) {
      const created = await services.create(servicePO, { requestKey: `${servicePO}-${qty}`, purchaseLineId: serviceLine, deliveryNumber: `${servicePO}-${qty}`, deliveredAt: '2026-10-01', acceptedQuantity: qty, rejectedQuantity: 0, evidenceReference: x.evidenceId }, who.id, [x.id]);
      const bill = await services.createPayableDraft(created.delivery.id, who.id, [x.id]);
      // Synthetic formal bill is a source fixture; only actual Review HTTP makes the cost-confirmation fact.
      await db().invoice.update({ where: { id: bill.invoice.id }, data: { status: 'Issued' } });
      x.input.bills.push({ invoiceId: bill.invoice.id, purchaseOrderId: servicePO, purchaseLineIds: [serviceLine], serviceDeliveryIds: [created.delivery.id], treatment: 'cost', evidenceIds: [x.evidenceId] });
    }
    for (const paid of [500, 460]) await db().paymentVoucher.create({ data: { id: `${x.id}-paid-${paid}`, voucherNumber: `${x.id}-paid-${paid}`, type: 'Disbursement', orderId: x.id, amount: paid, bankFee: 0, currency: 'CNY', paymentDate: '2026-10-01', paymentMethod: 'TT', createdAt: now, updatedAt: now } });
    x.input.supply.push({ movementId: movement.id, valuationInvoiceId: x.apId, orderLineId: x.lineId, inputQuantity: '600', usedQuantity: '500', lossQuantity: '0', unusedQuantity: '100', unit: 'M', evidenceIds: [x.evidenceId] }); x.input.coverage.companySupply.status = 'verified';
    x.input.sourceFingerprint = (await sources(who, x.id)).sourceFingerprint;
    const response = await confirm(x); expect(response.status, diagnostic(response.body)).toBe(201); expect(response.body.item.actualCostCny).toBe(5960);
    expect(await readCurrentOrderCostReview(db(), x.id, files)).toMatchObject({ status: 'complete', actualBreakdown: { procurement: 960, companySupply: 5000 }, actualCostCny: 5960 });
  });
  it('OCR03 partial final range, Draft bill, unrecorded final fees are pending and confirm writes nothing', async () => {
    const who = await actor('pending'), x = await fixture('pending', who);
    await db().shipmentOrderAllocation.update({ where: { id: `${x.id}-allocation` }, data: { actualQty: 50, status: 'PartiallyShipped' } }); await db().invoice.update({ where: { id: x.apId }, data: { status: 'Draft' } }); x.input.coverage.otherExpenses.status = 'pending';
    x.input.sourceFingerprint = (await sources(who, x.id)).sourceFingerprint;
    const candidate = await preview(x); expect(candidate.status, diagnostic(candidate.body)).toBe(200); expect(candidate.body).toMatchObject({ status: 'pending', actualCostCny: null }); expect(candidate.body.pendingReasons).toEqual(expect.arrayContaining(['FINAL_ORDER_SCOPE_UNVERIFIED', 'SUPPLIER_BILL_NOT_FORMAL', 'COVERAGE_PENDING:otherExpenses']));
    const before = await state(x), result = await confirm(x); expect(result.status, diagnostic(result.body)).toBe(409); expect(result.body.error.code).toBe('COST_REVIEW_INCOMPLETE'); expect(await state(x)).toEqual(before);
  });
  it('OCR04 actual current double permissions, order visibility and limited owner cannot be replaced by Sales pricingwrite', async () => {
    const who = await actor('authorized'), x = await fixture('authorized', who), sales = await actor('sales', ['pricing:read', 'pricing:write', 'sensitive:cost']), single = await actor('single', grants.filter(scope => scope !== 'invoices:reconcile'));
    const owner = await actor('capped-owner', grants, grants.filter(scope => scope !== 'invoices:reconcile'), true), foreign = await actor('foreign-finance');
    for (const rejected of [sales, single, owner]) { const result = await confirm(x, x.input, rejected); expect(result.status, diagnostic(result.body)).toBe(403); }
    const hidden = await request(app()).get(`${rootPath}/${x.id}`).set('Authorization', `Bearer ${foreign.token}`); expect(hidden.status, diagnostic(hidden.body)).toBe(404);
    expect(await db().orderCostReview.count({ where: { orderId: x.id } })).toBe(0);
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'invoices:reconcile' } }); await db().rolePermission.delete({ where: { roleId_permissionId: { roleId: who.roleId, permissionId: permission.id } } });
    const stale = await confirm(x); expect(stale.status, diagnostic(stale.body)).toBe(403); expect(await db().orderCostReview.count({ where: { orderId: x.id } })).toBe(0);
  });
  it('OCR05 actual Order/OrderLine expense HTTP requires valid current source and dual finance grant; list hides cost without readscope', async () => {
    const who = await actor('expense'), x = await fixture('expense', who);
    // Diagnose the real source-access boundary before HTTP intentionally hides
    // infrastructure errors. This is not an authorization substitute.
    const { assertDevelopmentBillingSourceAccess } = await import('../src/development/developmentBillingRouteAccess');
    await assertDevelopmentBillingSourceAccess(db(), { ...auth.verifyToken(who.token)! }, 'OrderLine', x.lineId, 'write');
    const input = { sourceType: 'OrderLine', sourceId: x.lineId, costType: 'shipping', amount: '50', currency: 'CNY', bearerType: 'internal', notes: 'Synthetic actual logistics expense' };
    const created = await request(app()).post('/api/v1/cost-records').set('Authorization', `Bearer ${who.token}`).send(input); expect(created.status, diagnostic(created.body)).toBe(201);
    expect(created.body.costRecord.createdAt).toEqual(expect.any(Number));
    expect(await db().costRecord.count({ where: { sourceType: 'OrderLine', sourceId: x.lineId } })).toBe(1);
    expect(await db().costRecord.findUniqueOrThrow({ where: { id: created.body.costRecord.id } })).toMatchObject({ sourceType: 'OrderLine', sourceId: x.lineId });
    const unknown = await request(app()).post('/api/v1/cost-records').set('Authorization', `Bearer ${who.token}`).send({ ...input, sourceId: `${x.lineId}-missing` }); expect(unknown.status, diagnostic(unknown.body)).toBe(404);
    const noReconcile = await actor('no-reconcile', grants.filter(scope => scope !== 'invoices:reconcile'));
    const denied = await request(app()).post('/api/v1/cost-records').set('Authorization', `Bearer ${noReconcile.token}`).send(input); expect(denied.status, diagnostic(denied.body)).toBe(403);
    const cappedRead = await actor('capped-read', grants, ['invoices:read'], true);
    const list = await request(app()).get('/api/v1/cost-records').set('Authorization', `Bearer ${cappedRead.token}`); expect(list.status, diagnostic(list.body)).toBe(200); expect(diagnostic(list.body)).not.toContain(created.body.costRecord.id);
    x.input.expenses.push({ costRecordId: created.body.costRecord.id, category: 'logistics', treatment: 'cost', note: 'Actual invoice/voucher support reviewed in uploaded original', evidenceIds: [x.evidenceId] }); x.input.coverage.logistics.status = 'verified'; x.input.sourceFingerprint = (await sources(who, x.id)).sourceFingerprint;
    const reviewed = await confirm(x); expect(reviewed.status, diagnostic(reviewed.body)).toBe(201); expect(reviewed.body.item.actualCostCny).toBe(1250);
  });
  it('OCR06 stable retry is one fact, altered payload is409, simultaneous confirmations cannot create two versions', async () => {
    const who = await actor('retry'), x = await fixture('retry', who);
    expect((await confirm(x)).status).toBe(201); const replay = await confirm(x); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    const tampered = await confirm(x, { ...x.input, note: 'different immutable request' }); expect(tampered.status, diagnostic(tampered.body)).toBe(409); expect(tampered.body.error.code).toBe('REQUEST_CONFLICT'); expect((await state(x)).reviews).toHaveLength(1);
    const concurrent = await fixture('concurrent', who); const results = await Promise.all([confirm(concurrent), confirm(concurrent, { ...concurrent.input, requestId: `${concurrent.id}-second` })]);
    console.log(diagnostic({ probe: 'actual-cost-review-concurrency', results: results.map(row => ({ status: row.status, body: row.body })) }));
    expect(results.map(row => row.status).sort()).toEqual([201, 409]); expect((await state(concurrent)).reviews).toHaveLength(1); expect((await state(concurrent)).audits.filter((row: any) => row.targetId === results.find(row => row.status === 201)!.body.item.id)).toHaveLength(1);
  });
  it('OCR07 real audit SQL FK P2003 failure rolls back Review and event; no mocked throw substitutes SQL', async () => {
    const who = await actor('audit-fault'), x = await fixture('audit-fault', who), before = await state(x), notify = vi.fn(); let injected = 0, sqlFailure: any;
    const broken = new Proxy(db(), { get(target, prop) {
      if (prop === '$transaction') return (work: (tx: any) => Promise<any>, options: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(client, name) {
        if (name === 'auditLog') return new Proxy(client.auditLog, { get(audit, action) {
          if (action === 'create') return async (args: any) => {
            if (args.data.action !== 'order_cost_review_confirm') return audit.create(args);
            injected++; try { return await audit.create({ ...args, data: { ...args.data, actorId: `${prefix}-missing-actor` } }); } catch (error: any) { sqlFailure = { code: error.code, meta: error.meta }; throw error; }
          }; return Reflect.get(audit, action);
        } }); return Reflect.get(client, name);
      } })), options); return Reflect.get(target, prop);
    } });
    const response = await confirm(x, x.input, who, broken, notify); console.log(diagnostic({ probe: 'cost-review-mandatory-audit-real-sql', injected, sqlFailure, http: response.status, before, after: await state(x) }));
    expect(injected).toBe(1); expect(sqlFailure?.code).toBe('P2003'); expect(response.status).toBe(500); expect(await state(x)).toEqual(before); expect(notify).not.toHaveBeenCalled();
  });
  it('OCR08 changed sources preserve history but invalidate actuals; changed private bytes failclosed and original restored is usable', async () => {
    const who = await actor('stale'), x = await fixture('stale', who); expect((await confirm(x)).status).toBe(201);
    const stored = await db().orderCostReview.findFirstOrThrow({ where: { orderId: x.id } });
    await db().invoice.update({ where: { id: x.apId }, data: { amount: 1300 } });
    expect(await readCurrentOrderCostReview(db(), x.id, files)).toMatchObject({ status: 'stale', pendingReasons: ['ORDER_COST_REVIEW_SOURCE_CHANGED'] }); expect(await db().orderCostReview.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(stored);
    const refreshed = await sources(who, x.id); x.input.sourceFingerprint = refreshed.sourceFingerprint; x.input.expectedRevision = 1; x.input.requestId = `${x.id}-reconfirm`;
    const renewed = await confirm(x); expect(renewed.status, diagnostic(renewed.body)).toBe(201); expect(renewed.body.item).toMatchObject({ revision: 2, supersedesId: stored.id, actualCostCny: 1300 });
    const attachment = await db().orderCostReviewEvidence.findUniqueOrThrow({ where: { id: x.evidenceId } }); const file = path.join(fileRoot, attachment.storageKey), original = await fs.readFile(file);
    try { await fs.writeFile(file, Buffer.from('%PDF-1.4\nchanged')); await expect(readCurrentOrderCostReview(db(), x.id, files)).rejects.toMatchObject({ code: 'EVIDENCE_INTEGRITY_FAILED' }); }
    finally { await fs.writeFile(file, original); }
    expect(await readCurrentOrderCostReview(db(), x.id, files)).toMatchObject({ status: 'complete', actualCostCny: 1300 });
  });
  it('OCR09 legacy mapping without proof, wrong supplier/order/currency, repeated bill and preexisting source conflicts refuse without writes', async () => {
    const who = await actor('binding-negatives'), x = await fixture('binding-negatives', who);
    await db().invoice.update({ where: { id: x.apId }, data: { sourceType: null, sourceId: null } });
    x.input.sourceFingerprint = (await sources(who, x.id)).sourceFingerprint;
    const missingProof = { ...x.input, bills: [{ ...x.input.bills[0], evidenceIds: [] }] };
    const absent = await confirm(x, missingProof); expect(absent.status, diagnostic(absent.body)).toBe(409); expect(absent.body.error.code).toBe('COST_REVIEW_INCOMPLETE');
    const repeat = await confirm(x, { ...x.input, bills: [x.input.bills[0], x.input.bills[0]] }); expect(repeat.status, diagnostic(repeat.body)).toBe(409); expect(repeat.body.error.code).toBe('DUPLICATE_COST_SOURCE');
    for (const patch of [{ customerRelationId: `${x.supplierId}-foreign` }, { currency: 'USD' }, { sourceType: 'PurchaseOrder', sourceId: `${x.poId}-foreign` }, { sourceType: 'PurchaseOrder', sourceId: null }]) {
      await db().invoice.update({ where: { id: x.apId }, data: { customerRelationId: x.supplierId, currency: 'CNY', sourceType: null, sourceId: null, ...patch } });
      x.input.sourceFingerprint = (await sources(who, x.id)).sourceFingerprint;
      const refused = await confirm(x); expect(refused.status, diagnostic(refused.body)).toBe(409); expect(refused.body.error.code).toBe('INVALID_COST_SOURCE');
    }
    const foreign = await fixture('foreign-source', who);
    x.input.bills[0].invoiceId = foreign.apId;
    const crossOrder = await confirm(x); expect(crossOrder.status, diagnostic(crossOrder.body)).toBe(409); expect(crossOrder.body.error.code).toBe('INVALID_COST_SOURCE');
    expect(await db().orderCostReview.count({ where: { orderId: x.id } })).toBe(0);
    const deleted = await actor('soft-deleted');
    await db().userAccount.update({ where: { id: deleted.id }, data: { deletedAt: BigInt(Date.now()) } });
    await expect(authorizeOrderCostReview(db(), { userId: deleted.id, roles: [], roleIds: [deleted.roleId], permissions: grants, departmentIds: [], authorizationLoaded: true }, 'write', x.id)).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('OCR10 a rejected original request can be permanently ended and replaced only after its immutable receipt', async () => {
    const who = await actor('retire-stale'), x = await fixture('retire-stale', who);
    await db().invoice.update({ where: { id: x.apId }, data: { amount: 1300 } });
    const rejected = await confirm(x); expect(rejected.status).toBe(409); expect(rejected.body.error.code).toBe('SOURCE_CHANGED');
    const ended = await retire(x); expect(ended.status, diagnostic(ended.body)).toBe(201);
    expect(ended.body).toMatchObject({ kind: 'Retired', orderId: x.id, actorId: who.id, requestId: x.input.requestId, status: 'Retired', replayed: false });
    expect(ended.body.command).toEqual(x.input);
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: ended.body.auditId } });
    expect(audit).toMatchObject({ actorId: who.id, action: 'order_cost_review_request_retire', targetType: 'OrderCostReviewRequest', targetId: ended.body.requestKey });
    expect(audit.detail.after.command).toEqual(x.input);
    const replay = await retire(x); expect(replay.status).toBe(200); expect(replay.body).toEqual({ ...ended.body, replayed: true });
    const late = await confirm(x); expect(late.status).toBe(409); expect(late.body.error.code).toBe('COST_REVIEW_REQUEST_RETIRED');
    const altered = await retire(x, { ...x.input, note: 'Different original command' }); expect(altered.status).toBe(409); expect(altered.body.error.code).toBe('REQUEST_CONFLICT');
    expect((await state(x)).reviews).toHaveLength(0);
    const renewed = await confirm(x, { ...x.input, sourceFingerprint: (await sources(who, x.id)).sourceFingerprint, requestId: `${x.id}-renewed-confirm` });
    expect(renewed.status, diagnostic(renewed.body)).toBe(201); expect(renewed.body.item.actualCostCny).toBe(1300);
  });
  it('OCR11 ending an already committed request returns its original receipt and preserves all confirmation facts', async () => {
    const who = await actor('retire-confirmed'), x = await fixture('retire-confirmed', who);
    const confirmed = await confirm(x); expect(confirmed.status).toBe(201); const before = await state(x);
    const result = await retire(x); expect(result.status, diagnostic(result.body)).toBe(200);
    expect(result.body).toMatchObject({ kind: 'Confirmed', requestId: x.input.requestId, replayed: true }); expect(result.body.item).toEqual(confirmed.body.item);
    expect(await state(x)).toEqual(before);
    expect(await db().auditLog.count({ where: { action: 'order_cost_review_request_retire', actorId: who.id } })).toBe(0);
    const altered = await retire(x, { ...x.input, note: 'Not the original confirmation' }); expect(altered.status).toBe(409); expect(altered.body.error.code).toBe('REQUEST_CONFLICT');
    expect(await state(x)).toEqual(before);
  });
  it('OCR12 simultaneous confirm and end cannot both persist; retry resolves the one durable result', async () => {
    const who = await actor('retire-race'), x = await fixture('retire-race', who);
    const results = await Promise.all([confirm(x), retire(x)]);
    expect(results.filter(row => row.status === 201)).toHaveLength(1);
    expect(results.every(row => [200, 201, 409].includes(row.status))).toBe(true);
    const reviews = (await state(x)).reviews;
    const ended = await db().auditLog.findMany({ where: { action: 'order_cost_review_request_retire', actorId: who.id } });
    expect(reviews.length + ended.length).toBe(1);
    const replay = await retire(x); expect(replay.status, diagnostic(replay.body)).toBe(200);
    expect(replay.body.kind).toBe(reviews.length ? 'Confirmed' : 'Retired');
    const late = await confirm(x); expect(late.status).toBe(reviews.length ? 200 : 409);
    expect((await state(x)).reviews).toHaveLength(reviews.length);
  });
  it('OCR13 retirement mandatory audit hits actual SQL FK refusal and rolls back; the original command can still confirm', async () => {
    const who = await actor('retire-audit-fault'), x = await fixture('retire-audit-fault', who), before = await state(x);
    let injected = 0, sqlCode: string | undefined;
    const broken = new Proxy(db(), { get(target, prop) {
      if (prop !== '$transaction') return Reflect.get(target, prop);
      return (work: (tx: any) => Promise<any>, options: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(client, name) {
        if (name !== 'auditLog') return Reflect.get(client, name);
        return new Proxy(client.auditLog, { get(audit, action) {
          if (action !== 'create') return Reflect.get(audit, action);
          return async (args: any) => {
            if (args.data.action !== 'order_cost_review_request_retire') return audit.create(args);
            injected++;
            try { return await audit.create({ ...args, data: { ...args.data, actorId: `${prefix}-missing-retire-actor` } }); }
            catch (error: any) { sqlCode = error.code; throw error; }
          };
        } });
      } })), options);
    } });
    const rejected = await retire(x, x.input, who, broken);
    expect(injected).toBe(1); expect(sqlCode).toBe('P2003'); expect(rejected.status).toBe(500);
    expect(await state(x)).toEqual(before);
    expect(await db().auditLog.count({ where: { actorId: who.id, action: 'order_cost_review_request_retire' } })).toBe(0);
    const committed = await confirm(x); expect(committed.status, diagnostic(committed.body)).toBe(201);
  });
  it('OCR14 altered retirement audit never proves an ended command; revoked grants cannot retire or recover', async () => {
    const who = await actor('retire-integrity'), x = await fixture('retire-integrity', who);
    const ended = await retire(x); expect(ended.status, diagnostic(ended.body)).toBe(201);
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: ended.body.auditId } });
    const altered = { ...audit.detail, after: { ...(audit.detail as any).after, requestFingerprint: '0'.repeat(64) } };
    await db().auditLog.update({ where: { id: audit.id }, data: { detail: altered } });
    const refused = await retire(x); expect(refused.status).toBe(409); expect(refused.body.error.code).toBe('COST_REVIEW_FACT_INVALID');
    expect(await db().orderCostReview.count({ where: { orderId: x.id } })).toBe(0);
    await db().auditLog.update({ where: { id: audit.id }, data: { detail: audit.detail } });
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'invoices:reconcile' } });
    await db().rolePermission.delete({ where: { roleId_permissionId: { roleId: who.roleId, permissionId: permission.id } } });
    const stale = await retire(x); expect(stale.status).toBe(403);
    expect(await db().auditLog.count({ where: { actorId: who.id, action: 'order_cost_review_request_retire' } })).toBe(1);
  });
});
