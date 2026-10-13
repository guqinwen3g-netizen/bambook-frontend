/** Synthetic source rows/accounts/configuration, actual workflow HTTP + isolated
 * PostgreSQL. No WorkflowInstance decision/source snapshot/request audit is hand
 * created; legacy and damaged-history controls are explicit post-formation
 * corruptions. Generic approval is not native Order/Invoice/5A approval. These
 * probes do not prove rendered UI, real company authority, or automatic native
 * bridges. No shared DB/client/schema generation is used by this file. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createPermissionService, hasScope } from '../src/auth/permissionService';
import { createWorkflowRouter } from '../src/workflow/workflowRoute';
import { WorkflowEngine } from '../src/workflow/workflowEngine';
import { registerWorkflowEventTriggers, WORKFLOW_TRIGGER_GAPS } from '../src/workflow/workflowEventTriggers';
import { businessEventBus } from '../src/events/businessEventBus';
import { createCostRecord, createBillingItem, confirmBillingItem, invoiceBillingItem } from '../src/finance/billingItemService';
import { invoiceSample } from '../src/samples/sampleManageService';
import { workflowHash } from '../src/workflow/workflowAccess';
import { loadWorkflowInvoiceSource, lockWorkflowInvoiceSource } from '../src/workflow/workflowInvoiceSource';
import { normalizeWorkflowOriginal, workflowRequestAuditId } from '../src/workflow/workflowRequestRecovery';
import { createProcurementService } from '../src/procurement/procurementService';
import { createPurchaseServiceDeliveryService } from '../src/procurement/purchaseServiceDeliveryService';
import { createPricingService } from '../src/pricing/pricingService';
import { createCommissionPayable, getOrderCommission } from '../src/pricing/commissionPayableService';
import { createInvoice, updateInvoice } from '../src/finance/invoiceMutationService';
import { createMaterialReturnService } from '../src/procurement/materialReturnService';
import { createQuotationService } from '../src/quotations/quotationService';
import { createProformaInvoiceService } from '../src/finance/proformaInvoiceService';
import { createTeamShareService } from '../src/teams/teamShareService';
import { createShipment } from '../src/shipping/shipmentMutationService';
import { createAllocationService } from '../src/shipping/allocationService';
import { createOrderShipmentBatchService } from '../src/shipping/orderShipmentBatchService';
import { createPaymentVoucher } from '../src/finance/paymentVoucherMutationService';
import { applyAllocation } from '../src/finance/allocationService';

const prefix = 'acceptance-workflow-' + randomUUID();
let prisma: PrismaClient | undefined, serial = 0;
const db = () => { if (!prisma) throw Error('Isolated workflow PG not initialized'); return prisma; };
const diagnostic = (value: any) => JSON.stringify(value, (_key, row) => typeof row === 'bigint' ? row.toString() : row);
const scopes = ['orders:read','orders:write','invoices:read','invoices:write','products:read','products:write','qc:garment_chain:write'];
function application(database = db()) { const app = express(); app.use(express.json()); app.use('/api/v1/workflow', createWorkflowRouter(database)); return app; }
async function identity(id: string, roleId: string, explicitScopes: string[] = scopes) {
  await db().userAccount.create({ data: { id, displayName: 'Synthetic workflow ' + id, status: 'active' } });
  await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: 'Synthetic ' + roleId, isSystem: true } });
  const grantRole = id + '-capabilities'; await db().role.create({ data: { id: grantRole, name: 'Synthetic explicit workflow permissions', isSystem: false } });
  for (const role of [roleId, grantRole]) await db().userRole.create({ data: { id: id + '-' + role, userId: id, roleId: role } });
  for (const scope of explicitScopes) {
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-permission-' + scope, scope } });
    await db().rolePermission.create({ data: { id: id + '-' + scope, roleId: grantRole, permissionId: permission.id } });
  }
  const context = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(context).not.toBeNull();
  const actor: TokenPayload = { userId: id, roles: context!.legacyRoleCodes, roleIds: context!.roleIds, permissions: context!.scopes, departmentIds: context!.departmentIds, authorizationLoaded: true };
  return { id, grantRole, actor, token: createAuthService().signToken(actor) };
}
async function fixture(label: string, userStep = false, entityType = 'Order') {
  const id = prefix + '-' + ++serial + '-' + label;
  const initiator = await identity(id + '-initiator', 'role-finance'), reviewer = await identity(id + '-reviewer', entityType === 'DevelopmentCase' ? 'role-qc' : entityType === 'Invoice' ? 'role-finance' : 'role-sales-manager');
  // The actual reviewer has the same scoped parent customer, rather than being
  // waved through from a JWT role name. No canonical role's grants are changed.
  const relation = await db().relation.create({ data: { id: id + '-customer', name: 'Synthetic workflow customer', category: 'Customer', type: 'Organization', isOrganization: true,
    tags: [], contactInfo: '', lastInteraction: BigInt(Date.now()), ownerId: initiator.id, salesRepIds: [reviewer.id] } });
  const order = await db().order.create({ data: { id: id + '-order', customer: relation.name, customerRelationId: relation.id, product: 'Synthetic workflow fabric', type: 'Fabric',
    quantity: 10, quoteAmount: '123.4567', currency: 'USD', status: 'Pending', dueDate: '2026-11-01', ownerId: initiator.id } });
  let entityId = order.id;
  if (entityType === 'DevelopmentCase') entityId = (await db().developmentCase.create({ data: { id: id + '-case', code: id + '-case', name: 'Synthetic 5A draft', type: 'garment', stage: 'developing',
    customerRelationId: relation.id, sampleCategory: '5a', reviewStatus: 'pending', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } })).id;
  if (entityType === 'Invoice') entityId = (await db().invoice.create({ data: { id: id + '-invoice', invoiceNumber: id + '-invoice', type: 'Receivable', status: 'Draft', amount: '123.4567', currency: 'USD',
    issueDate: '2026-10-01', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()), orderId: order.id, customerRelationId: relation.id, customerName: relation.name, ownerId: initiator.id } })).id;
  const definition = await db().workflowDefinition.create({ data: { id: id + '-definition', name: 'Synthetic independently specified two-step review', entityType,
    steps: [{ name: 'Specified first reviewer', approverRole: entityType === 'DevelopmentCase' ? 'role-qc' : entityType === 'Invoice' ? 'role-finance' : 'role-sales-manager', ...(userStep ? { approverUserId: reviewer.id } : {}) },
      { name: 'Specified second reviewer', approverUserId: reviewer.id }] } });
  return { id, initiator, reviewer, relation, order, entityType, entityId, definition, app: application(), instance: null as any };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function post(f: Fixture, path: string, body: any, token = f.initiator.token, app = f.app) { return request(app).post('/api/v1/workflow/' + path).set('Authorization', 'Bearer ' + token).send(body); }
async function create(f: Fixture, extra: any = {}, token = f.initiator.token, app = f.app) {
  const response = await post(f, 'instances', { definitionId: f.definition.id, entityType: f.entityType, entityId: f.entityId, title: 'Synthetic review ' + f.id,
    clientRequestId: f.id + '-create', ...extra }, token, app);
  if (response.status === 201) f.instance = response.body.instance;
  return response;
}
function command(f: Fixture, label: string, overrides: any = {}) { return { clientRequestId: f.id + '-' + label, expectedStepId: f.instance.currentStepId,
  expectedStepIndex: f.instance.currentStepIndex, sourceFingerprint: f.instance.sourceFingerprint, note: 'Synthetic decision note', ...overrides }; }
async function decide(f: Fixture, body = command(f, 'approve'), action = 'approve', token = f.reviewer.token, app = f.app) {
  const response = await post(f, 'instances/' + f.instance.id + '/' + action, body, token, app);
  if (response.status === 200) f.instance = response.body.instance;
  return response;
}
async function state(f: Fixture) { return { instances: await db().workflowInstance.findMany({ where: { entityId: f.entityId }, include: { steps: { orderBy: { stepIndex: 'asc' } } } }),
  audits: await db().auditLog.findMany({ where: { targetType: 'WorkflowInstance', targetId: f.instance?.id || '-absent-' }, orderBy: { id: 'asc' } }), order: await db().order.findUnique({ where: { id: f.order.id } }) }; }
async function denied(f: Fixture, invoke: () => Promise<any>, status: number, code: string) { const before = await state(f), response = await invoke(); expect(response.status, diagnostic(response.body)).toBe(status);
  expect(response.body.error).toBe(code); expect(await state(f)).toEqual(before); return response; }
function auditFault(action: string) {
  const observed: { injections: number; code?: string; staged?: any; attempted?: any } = { injections: 0 };
  const database = new Proxy(db(), { get(target, property) {
    if (property === '$transaction') return (callback: any, opts: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
      if (field === 'auditLog') return new Proxy(client.auditLog, { get(delegate, method) {
        if (method === 'create') return async (args: any) => {
          if (args.data.action !== action) return delegate.create(args);
          // PostgreSQL row order changes after an UPDATE. The staged positive
          // control must address the first actual step, not a heap-order row.
          observed.injections++; observed.attempted = args.data; observed.staged = await client.workflowInstance.findUnique({ where: { id: args.data.targetId }, include: { steps: { orderBy: [{ stepIndex: 'asc' }, { id: 'asc' }] } } });
          try { return await delegate.create({ ...args, data: { ...args.data, actorId: prefix + '-missing-actor' } }); }
          catch (error: any) { observed.code = error.code; throw error; }
        };
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
    } })), opts);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } }); return { database, observed };
}
/** Draft source fixtures only; all cost/billing confirmations/invoices below
 * are formed through native services, then workflow facts through actual HTTP. */
async function draftCase(f: Fixture, suffix = 'source') {
  return db().developmentCase.create({ data: { id: f.id + '-' + suffix + '-case', code: f.id + '-' + suffix + '-case', name: 'Synthetic invoice development source', type: 'garment', stage: 'developing',
    customerRelationId: f.relation.id, sampleCategory: '5a', reviewStatus: 'pending', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
}
async function nativeBillingInvoice(f: Fixture) {
  const source = await draftCase(f);
  const cost = await createCostRecord({ prisma: db(), actorId: f.initiator.id, input: { sourceType: 'DevelopmentCase', sourceId: source.id, costType: 'development', amount: '12.3456', currency: 'USD' } });
  expect(cost.ok, diagnostic(cost)).toBe(true); if (!cost.ok) throw Error('Native cost fixture rejected');
  const billing = await createBillingItem({ prisma: db(), actorId: f.initiator.id, input: { sourceType: 'CostRecord', sourceId: cost.data.costRecord.id,
    chargeType: 'development_fee', amount: 15.125, currency: 'USD', bearerType: 'customer', bearerRelationId: f.relation.id } });
  expect(billing.ok, diagnostic(billing)).toBe(true); if (!billing.ok) throw Error('Native billing fixture rejected');
  const confirmed = await confirmBillingItem({ prisma: db(), id: billing.data.billingItem.id, actorId: f.initiator.id });
  expect(confirmed.ok, diagnostic(confirmed)).toBe(true);
  const invoiced = await invoiceBillingItem({ prisma: db(), id: billing.data.billingItem.id, actorId: f.initiator.id, input: { issueDate: '2026-10-01' } });
  expect(invoiced.ok, diagnostic(invoiced)).toBe(true); if (!invoiced.ok) throw Error('Native invoice fixture rejected');
  f.entityId = invoiced.data.invoice.id;
  return { source, cost: cost.data.costRecord, billing: billing.data.billingItem, invoice: invoiced.data.invoice };
}
async function nativeSampleInvoice(f: Fixture, sourceCaseId?: string, sourceOrderId?: string) {
  const sample = await db().sample.create({ data: { id: f.id + '-sample', code: f.id + '-sample', type: 'dev', status: 'draft', sourceCaseId, sourceOrderId,
    customerRelationId: f.relation.id, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  const invoice = await invoiceSample({ prisma: db(), sampleId: sample.id, actorId: f.initiator.id, input: { amount: 12.9999, currency: 'USD', issueDate: '2026-10-01' } });
  expect(invoice.ok, diagnostic(invoice)).toBe(true); if (!invoice.ok) throw Error('Native sample invoice fixture rejected');
  f.entityId = invoice.data.invoice.id;
  return { sample, invoice: invoice.data.invoice };
}
async function nativeServiceInvoice(f: Fixture) {
  const supplier = await db().relation.create({ data: { id: f.id + '-supplier', name: 'Synthetic processing supplier', category: 'Supplier', type: 'Organization', isOrganization: true,
    tags: [], contactInfo: '', lastInteraction: BigInt(Date.now()), ownerId: f.initiator.id, salesRepIds: [f.reviewer.id] } });
  const orderLine = await db().orderLine.create({ data: { id: f.id + '-processing-order-line', orderId: f.order.id, lineNumber: 1, description: 'Draft real product line', quantity: '10', unit: 'Pcs' } });
  const procurement = createProcurementService(db());
  const draft = await procurement.createPurchaseOrder({ poNumber: f.id + '-native-po', orderId: f.order.id, supplierRelationId: supplier.id, supplierName: supplier.name,
    currency: 'USD', orderDate: '2026-10-01', lines: [{ kind: 'ProcessingService', orderLineId: orderLine.id, description: 'Actual processing work', quantity: 10, unit: 'Pcs', unitPrice: 1.2345 }] }, f.initiator.id);
  expect(draft.status).toBe('Draft'); const sent = await procurement.sendPurchaseOrder(draft.id, f.initiator.id); expect(sent.status).toBe('Sent');
  const confirmed = await procurement.confirmPurchaseOrder(draft.id, f.initiator.id); expect(confirmed.status).toBe('Confirmed');
  const deliveryService = createPurchaseServiceDeliveryService(db());
  const delivered = await deliveryService.create(draft.id, { requestKey: f.id + '-native-delivery', purchaseLineId: confirmed.lines[0].id, deliveryNumber: f.id + '-delivery', deliveredAt: '2026-10-01',
    acceptedQuantity: '4', rejectedQuantity: '0', evidenceReference: 'Synthetic physical delivery fixture, not real company evidence' }, f.initiator.id, [f.order.id]);
  expect(delivered.delivery.acceptedAmount.toString()).toBe('4.938'); const payable = await deliveryService.createPayableDraft(delivered.delivery.id, f.initiator.id, [f.order.id]);
  expect(payable.invoice).toMatchObject({ type: 'Payable', status: 'Draft', sourceType: 'PurchaseServiceDelivery', sourceId: delivered.delivery.id, orderId: f.order.id, customerRelationId: supplier.id });
  f.entityId = payable.invoice.id; return { supplier, orderLine, purchaseOrder: confirmed, purchaseLine: confirmed.lines[0], delivery: delivered.delivery, invoice: payable.invoice };
}
async function nativeCommissionInvoice(f: Fixture) {
  // Only the native commission source's existing Finance initiator receives
  // its run-owned configured pricing capability. Reviewers/common scopes and
  // the invoice-only ceiling remain unchanged.
  const permission = await db().permission.upsert({ where: { scope: 'pricing:write' }, update: {},
    create: { id: prefix + '-permission-pricing:write', scope: 'pricing:write' } });
  await db().rolePermission.upsert({ where: { roleId_permissionId: { roleId: f.initiator.grantRole, permissionId: permission.id } }, update: {},
    create: { id: f.initiator.id + '-pricing:write', roleId: f.initiator.grantRole, permissionId: permission.id } });
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(f.initiator.id);
  if (!current) throw Error('Native commission fixture initiator is not active');
  f.initiator.actor = { userId: current.userId, roles: current.legacyRoleCodes, roleIds: current.roleIds,
    permissions: current.scopes, departmentIds: current.departmentIds, authorizationLoaded: true };
  f.initiator.token = createAuthService().signToken(f.initiator.actor);
  const intermediary = await db().relation.create({ data: { id: f.id + '-intermediary', name: 'Synthetic actual intermediary', category: 'Supplier', type: 'Organization', isOrganization: true,
    tags: [], contactInfo: '', lastInteraction: BigInt(Date.now()), ownerId: f.initiator.id, salesRepIds: [f.reviewer.id] } });
  const rule = await db().commissionRule.create({ data: { id: f.id + '-commission-rule', name: 'Synthetic commission configuration', rate: '5', intermediaryRelationId: intermediary.id,
    intermediaryName: intermediary.name, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  const pricingService = createPricingService(db());
  const draft = await pricingService.createCalculation({ orderId: f.order.id, purchaseCostCny: 7, refundRate: 0, exchangeRate: 7, profitMargin: 10, commissionRuleId: rule.id, quantity: 10, status: 'Draft' }, f.initiator.id);
  expect(draft.status).toBe('Draft'); const pricing = await pricingService.updateCalculation(draft.id, { status: 'Confirmed' }, f.initiator.id); expect(pricing.status).toBe('Confirmed');
  const payable = await createCommissionPayable(db(), { orderId: f.order.id }, f.initiator.id); expect(payable.ok, diagnostic(payable)).toBe(true); if (!payable.ok) throw Error('Native commission Invoice fixture rejected');
  const invoice = payable.data.invoice; expect(invoice).toMatchObject({ type: 'Payable', status: 'Issued', sourceType: 'CommissionPayable', sourceId: f.order.id + '#1', orderId: f.order.id, customerRelationId: intermediary.id });
  expect(invoice.amount.toString()).toBe('0.5'); f.entityId = invoice.id; return { intermediary, rule, pricing, invoice, pricingService };
}
// Actual native services and transaction/audit writes, synthetic inspection
// inputs. This does not verify physical QC evidence or an external supplier's
// real confirmation; it verifies how those recorded facts govern workflow.
async function nativeSupplierClaimInvoice(f: Fixture, independent = false) {
  const supplier = await db().relation.create({ data: { id: f.id + '-supplier', name: 'Synthetic actual claim supplier', category: 'Supplier', type: 'Organization', isOrganization: true,
    tags: [], contactInfo: '', lastInteraction: BigInt(Date.now()), ownerId: f.initiator.id, salesRepIds: [f.reviewer.id] } });
  const procurement = createProcurementService(db());
  const draft = await procurement.createPurchaseOrder({ poNumber: f.id + '-native-claim-po', ...(independent ? {} : { orderId: f.order.id }), supplierRelationId: supplier.id, supplierName: supplier.name,
    currency: 'USD', orderDate: '2026-10-01', lines: [{ kind: 'Material', materialCode: f.id + '-actual-material', description: 'Actual rejected material source', quantity: 10, unit: 'M', unitPrice: 1.2345 }] }, f.initiator.id);
  expect(draft.status).toBe('Draft'); await procurement.sendPurchaseOrder(draft.id, f.initiator.id); const confirmed = await procurement.confirmPurchaseOrder(draft.id, f.initiator.id); expect(confirmed.status).toBe('Confirmed');
  const received = await procurement.createMaterialReceipt(draft.id, { receiptNumber: f.id + '-native-rejected-receipt', receivedDate: '2026-10-01', totalReceived: 10, totalAccepted: 0, totalRejected: 10,
    rejectionReason: 'Synthetic native reject inspection', lineReceipts: [{ lineId: confirmed.lines[0].id, accepted: 0, rejected: 10 }] }, f.initiator.id);
  const receipt = received; expect(receipt.status).toBe('Rejected');
  const returns = createMaterialReturnService(db());
  const created = await returns.createReturn({ receiptId: receipt.id, type: 'claim', quantity: 0, amount: 5.1234, currency: 'USD', reason: 'Synthetic supplier claim fixture, not real authority' }, f.initiator.id);
  expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok) throw Error('Native material claim creation rejected'); const sourceId = created.data.materialReturn.id;
  expect((await returns.markShipped(sourceId, f.initiator.id)).ok).toBe(true); const accepted = await returns.confirmReturn(sourceId, f.initiator.id);
  expect(accepted.ok, diagnostic(accepted)).toBe(true); if (!accepted.ok) throw Error('Native material claim confirmation rejected');
  const source = await db().materialReturn.findUniqueOrThrow({ where: { id: sourceId } }), invoice = await db().invoice.findUniqueOrThrow({ where: { id: accepted.data.claimInvoiceId } });
  expect(source).toMatchObject({ type: 'claim', status: 'confirmed', claimInvoiceId: invoice.id, supplierRelationId: supplier.id });
  expect(invoice).toMatchObject({ type: 'Payable', status: 'Issued', sourceType: null, sourceId: null, orderId: null, customerRelationId: supplier.id }); expect(invoice.amount.toString()).toBe('-5.1234');
  const confirmation = await db().auditLog.findFirstOrThrow({ where: { action: 'confirm_material_return', targetType: 'MaterialReturn', targetId: source.id } });
  const receiptAudit = await db().auditLog.findFirstOrThrow({ where: { action: 'create_material_receipt', targetType: 'PurchaseOrder', targetId: draft.id } });
  expect((receiptAudit.detail as any).after.lineReceipts).toEqual([expect.objectContaining({ lineId: confirmed.lines[0].id, accepted: 0, rejected: 10 })]);
  f.entityId = invoice.id; return { supplier, purchaseOrder: confirmed, purchaseLine: confirmed.lines[0], receipt, receiptAudit, source, invoice, confirmation };
}
/** Real native transitions and persisted audits with synthetic customer inputs;
 * neither acceptQuotation nor these probes prove an external customer's actual
 * acceptance, physical delivery, or a native workflow-to-finance bridge. */
async function nativeProformaInvoice(f: Fixture, formal = false, convertOrder = false) {
  const source = await draftCase(f, 'proforma'), orderLine = await db().orderLine.create({ data: { id: f.id + '-quote-order-line', orderId: f.order.id,
    lineNumber: 1, description: 'Synthetic actual quotation parent line', quantity: '2000', unit: 'M' } });
  const quotationService = createQuotationService(db()), draft = await quotationService.createQuotation({ quotationNumber: f.id + '-native-quote', currency: 'USD', exchangeRate: 7.1234, baseCurrency: 'CNY',
    customerRelationId: f.relation.id, customerName: f.relation.name, developmentCaseId: source.id, orderId: f.order.id, orderLineId: orderLine.id,
    issueDate: '2026-10-01', deliveryTerms: 'FOB', paymentInstrument: 'T/T', paymentTerms: 'Synthetic terms', lines: [
      { description: 'Synthetic first quoted material', quantity: 2000, unit: 'M', unitPrice: 1.2345, notes: 'Actual line snapshot one' },
      { description: 'Synthetic second quoted material', quantity: 1600, unit: 'M', unitPrice: 0.125, notes: 'Actual line snapshot two' } ] }, f.initiator.id);
  expect(draft.status).toBe('Draft'); expect((await quotationService.sendQuotation(draft.id, f.initiator.id)).status).toBe('Sent');
  expect((await quotationService.acceptQuotation(draft.id, f.initiator.id, 'Synthetic recorded acceptance, not external proof')).status).toBe('Accepted');
  if (convertOrder) await quotationService.convertToOrder(draft.id, f.initiator.id, { poNumber: f.id + '-converted-native-order', type: 'Fabric', paymentInstrument: 'T/T' });
  const quote = await db().quotation.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: { orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] } } });
  const proforma = createProformaInvoiceService(db()), generated = await proforma.generateFromQuotation({ quotationId: quote.id, issueDate: '2026-10-01' }, f.initiator.id);
  expect(generated.ok, diagnostic(generated)).toBe(true); if (!generated.ok) throw Error('Native PI generation rejected');
  const generation = await db().auditLog.findFirstOrThrow({ where: { targetType: 'Invoice', targetId: generated.data.id, action: 'generate_proforma_from_quotation' } });
  let invoiceId = generated.data.id, conversion: any = null;
  if (formal) {
    const result = await proforma.convertToReceivable(invoiceId, { issueDate: '2026-10-01' }, f.initiator.id);
    expect(result.ok, diagnostic(result)).toBe(true); if (!result.ok) throw Error('Native PI conversion rejected'); invoiceId = result.data.id;
    conversion = await db().auditLog.findFirstOrThrow({ where: { targetType: 'Invoice', targetId: invoiceId, action: 'convert_proforma_to_receivable' } });
  }
  const pi = await db().invoice.findUniqueOrThrow({ where: { id: generated.data.id } }), invoice = await db().invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  expect(pi).toMatchObject({ type: 'Proforma', status: formal ? 'Cancelled' : 'Draft', sourceType: null, sourceId: null, customerRelationId: f.relation.id,
    orderId: convertOrder ? quote.convertedOrderId : f.order.id });
  expect(pi.amount.toString()).toBe('2669'); expect(invoice.type).toBe(formal ? 'Receivable' : 'Proforma');
  f.entityId = invoice.id; return { source, orderLine, quote, pi, invoice, generation, conversion };
}
/** Native Booked shipment / planned batch / IOA invoice writes, including their
 * actual audits. Physical shipment completion, L3's automatic event bridge and
 * real bank collection are NOT established by these source-graph fixtures. */
async function nativeBatchInvoice(f: Fixture, kind: 'planned' | 'unassigned' | 'legacy-shipment' | 'whole' | 'consolidated' | 'whole-consolidated' = 'planned') {
  const line = await db().orderLine.create({ data: { id: f.id + '-native-batch-line', orderId: f.order.id, lineNumber: 1,
    description: 'Synthetic draft actual batch product line', quantity: '10', unit: 'M', unitPrice: '12.3456', materialCode: f.id + '-material' } });
  let shipment: any = null, allocation: any = null, batch: any = null, otherOrder: any = null, otherLine: any = null, otherAllocation: any = null;
  const shipping = createAllocationService(db()), batches = createOrderShipmentBatchService(db());
  if (!kind.startsWith('whole') && kind !== 'unassigned') {
    const created = await createShipment({ prisma: db(), actorId: f.initiator.id, input: { id: f.id + '-native-booked-shipment', shipmentNumber: f.id + '-native-shipment',
      type: 'Export', status: 'Booked', shippingMethod: 'Sea', orderId: f.order.id } });
    expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok || !created.data) throw Error('Native Booked shipment rejected'); shipment = created.data.shipment;
    if (kind !== 'legacy-shipment') {
      const linked = await shipping.createAllocation(shipment.id, { orderId: f.order.id, orderLineId: line.id, plannedQty: 4, unit: 'M' }, f.initiator.id);
      expect(linked.ok, diagnostic(linked)).toBe(true); if (!linked.ok) throw Error('Native planned SOA rejected'); allocation = linked.data.allocation;
    }
  }
  if (kind === 'consolidated' || kind === 'whole-consolidated') {
    // Draft input source only. No Approved/Shipped/Paid business fact seeded.
    otherOrder = await db().order.create({ data: { id: f.id + '-co-order', customer: f.relation.name, customerRelationId: f.relation.id, product: 'Synthetic co-order material',
      type: 'Fabric', quantity: 10, quoteAmount: '30', currency: 'USD', status: 'Pending', dueDate: '2026-11-01', ownerId: f.initiator.id } });
    otherLine = await db().orderLine.create({ data: { id: f.id + '-co-line', orderId: otherOrder.id, lineNumber: 1, description: 'Synthetic real consolidated line', quantity: '10', unit: 'M' } });
    if (shipment) { const linked = await shipping.createAllocation(shipment.id, { orderId: otherOrder.id, orderLineId: otherLine.id, plannedQty: 2, unit: 'M' }, f.initiator.id);
      expect(linked.ok, diagnostic(linked)).toBe(true); if (!linked.ok) throw Error('Native co-order SOA rejected'); otherAllocation = linked.data.allocation; }
  }
  if (!kind.startsWith('whole')) {
    const created = await batches.createBatch({ orderId: f.order.id, shipmentId: shipment?.id, plannedQty: 4, unit: 'M', amount: 12.9999, currency: 'USD' }, f.initiator.id);
    expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok) throw Error('Native planned financial batch rejected'); batch = await db().orderShipmentBatch.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(batch.status).toBe('planned');
  }
  const orderAllocations = kind.startsWith('whole') ? [{ orderId: f.order.id }, ...(otherOrder ? [{ orderId: otherOrder.id }] : [])] : [{ orderId: f.order.id, batchId: batch.id, allocatedAmount: '12.9999' },
    ...(otherOrder ? [{ orderId: otherOrder.id, allocatedAmount: '2' }] : [])];
  const created = await createInvoice({ prisma: db(), actorId: f.initiator.id, input: { id: f.id + '-native-batch-invoice', invoiceNumber: f.id + '-native-batch-invoice',
    type: 'Receivable', status: 'Draft', amount: otherOrder ? '14.9999' : '12.9999', currency: 'USD', issueDate: '2026-10-01', orderId: f.order.id,
    customerRelationId: f.relation.id, customerName: f.relation.name, orderAllocations } });
  expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok || !created.data) throw Error('Native IOA invoice rejected');
  const invoice = await db().invoice.findUniqueOrThrow({ where: { id: created.data.invoice.id } });
  const attachments = await db().invoiceOrderAllocation.findMany({ where: { invoiceId: invoice.id, deletedAt: null }, orderBy: { id: 'asc' } });
  const invoiceAudit = await db().auditLog.findUniqueOrThrow({ where: { id: created.data.auditId } });
  f.entityId = invoice.id;
  return { line, shipment, allocation, batch, otherOrder, otherLine, otherAllocation, invoice, attachments, invoiceAudit, shipping, batches };
}
function sourcePage(f: Fixture, entityType: string, query: any = {}, token = f.initiator.token, app = f.app) {
  return request(app).get('/api/v1/workflow/sources').query({ entityType, ...query }).set('Authorization', 'Bearer ' + token);
}
function sourceReadFault(delegateName: 'order' | 'userAccount' | 'materialReturn' | 'quotation' | 'orderShipmentBatch' | 'shipmentOrderAllocation', sqlState?: '40001' | '40P01') {
  const observed: { injections: number; code?: string; sqlState?: string } = { injections: 0 };
  const database = new Proxy(db(), { get(target, property) {
    if (property === '$transaction') return (callback: any, options: any) => target.$transaction(client => callback(new Proxy(client, { get(tx, name) {
      if (name === delegateName) return new Proxy((tx as any)[name], { get(delegate, method) {
        if (method === ({ order: 'findFirst', userAccount: 'findUnique', materialReturn: 'findMany', quotation: 'findFirst', orderShipmentBatch: 'findFirst', shipmentOrderAllocation: 'findMany' }[delegateName])) return async () => {
          observed.injections++;
          try {
            if (sqlState) return await tx.$executeRawUnsafe(`DO $$ BEGIN RAISE EXCEPTION 'Synthetic workflow source concurrency control' USING ERRCODE='${sqlState}'; END $$`);
            return await tx.$queryRawUnsafe('SELECT "id" FROM "__acceptance_workflow_missing_source_table__"');
          }
          catch (error: any) { observed.code = error.code; if (sqlState) observed.sqlState = String(error.meta?.code); throw error; }
        };
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(tx, name); return typeof value === 'function' ? value.bind(tx) : value;
    } })), options);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { database, observed };
}
describe.sequential('current workflow authority, immutable source and transactional decisions in isolated PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
      directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1'); expect(url.pathname).toBe('/' + name);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(url.port).toBe(port); expect(Boolean(directory)).toBe(true);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRawUnsafe<Array<{ name: string; directory: string; port: number }>>('SELECT current_database() AS name, current_setting(\'data_directory\') AS directory, inet_server_port() AS port');
    expect(identity, 'verify actual independent cluster BEFORE ANY fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });
  it('WF01 actual two-step decisions retain actor/audit and never confirm native Order', async () => {
    const f = await fixture('two-step'); const creation = await create(f); expect(creation.status, diagnostic(creation.body)).toBe(201);
    expect(f.instance).toMatchObject({ schemaVersion: 1, decisionScope: 'workflow_only', nativeBusinessApplied: false, status: 'running', definitionVersion: 1 });
    expect((await decide(f)).status).toBe(200); expect(f.instance.currentStepIndex).toBe(1);
    expect((await decide(f, command(f, 'second'))).status).toBe(200); expect(f.instance.status).toBe('approved');
    const current = await state(f); expect(current.order!.status).toBe('Pending'); expect(current.instances[0].steps.map(s => s.decidedById)).toEqual([f.reviewer.id, f.reviewer.id]);
    expect(current.audits.filter(row => row.action === 'workflow_approve')).toHaveLength(2);
  });
  it('WF02 validates source existence, whitelist and exact definition entity type', async () => {
    const f = await fixture('type'); await denied(f, () => create(f, { entityType: 'Shipment' }), 400, 'INVALID_INPUT');
    await denied(f, () => create(f, { entityId: f.id + '-missing' }), 404, 'NOT_FOUND');
    const other = await fixture('other-type', false, 'DevelopmentCase'); await denied(f, () => create(f, { definitionId: other.definition.id }), 400, 'INVALID_INPUT');
  });
  it('WF03 missing identity and stable request ID produce no instance', async () => {
    const f = await fixture('mandatory-input'); await denied(f, () => create(f, {}, ''), 401, 'UNAUTHORIZED');
    await denied(f, () => create(f, { clientRequestId: undefined }), 400, 'INVALID_INPUT');
  });
  it('WF04 forbids self approval even with a true matching DB reviewer role', async () => {
    const f = await fixture('self'); await db().userRole.create({ data: { id: f.id + '-self-role', userId: f.initiator.id, roleId: 'role-sales-manager' } });
    expect((await create(f)).status).toBe(201); await denied(f, () => decide(f, command(f, 'self'), 'approve', f.initiator.token), 403, 'FORBIDDEN');
  });
  it('WF05 specified reviewer outranks a matching canonical role', async () => {
    const f = await fixture('specific', true), another = await identity(f.id + '-other-reviewer', 'role-sales-manager');
    await db().relation.update({ where: { id: f.relation.id }, data: { salesRepIds: [f.reviewer.id, another.id] } });
    expect((await create(f)).status).toBe(201); await denied(f, () => decide(f, command(f, 'wrong-user'), 'approve', another.token), 403, 'FORBIDDEN');
    expect((await decide(f)).status).toBe(200);
  });
  it('WF06 current grants and credential ceiling defeat stale JWT/body labels', async () => {
    const f = await fixture('revoked'); expect((await create(f)).status).toBe(201);
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'orders:write' } });
    await db().rolePermission.deleteMany({ where: { roleId: f.reviewer.grantRole, permissionId: permission.id } });
    // Existing canonical role rows may have grants from bootstrap fixtures; remove
    // authority in this unique account, never edit grants on shared roles.
    await db().userRole.deleteMany({ where: { userId: f.reviewer.id, roleId: 'role-sales-manager' } });
    await denied(f, () => decide(f, command(f, 'stale', { roles: ['manager'], permissions: scopes })), 403, 'FORBIDDEN');
    const cap = createAuthService().signToken({ ...f.initiator.actor, permissionCeiling: ['orders:read'] });
    await denied(f, () => create(f, { clientRequestId: f.id + '-cap' }, cap), 403, 'FORBIDDEN');
  });
  it('WF07 changed source and stale current step reject without changing history', async () => {
    const f = await fixture('changed-source'); expect((await create(f)).status).toBe(201);
    await denied(f, () => decide(f, command(f, 'stale-step', { expectedStepIndex: 1 })), 409, 'CONFLICT');
    await db().order.update({ where: { id: f.order.id }, data: { quoteAmount: '123.4568' } });
    await denied(f, () => decide(f), 409, 'CONFLICT');
  });
  it('WF08 exact create/approve/cancel replay returns immutable acknowledgement; changed payload conflicts', async () => {
    const f = await fixture('replay'); expect((await create(f)).status).toBe(201); const creation = f.instance.acknowledgement;
    expect((await create(f)).body.instance.acknowledgement).toEqual(creation);
    const body = command(f, 'decision'); const first = await decide(f, body); const replay = await decide(f, body);
    expect(replay.status).toBe(200); expect(replay.body.instance.acknowledgement).toEqual(first.body.instance.acknowledgement);
    await denied(f, () => decide(f, { ...body, note: 'different' }), 409, 'CONFLICT');
    const cancel = command(f, 'cancel', { reason: 'Stop generic review' }); delete cancel.note;
    const a = await post(f, 'instances/' + f.instance.id + '/cancel', cancel); expect(a.status).toBe(200);
    const b = await post(f, 'instances/' + f.instance.id + '/cancel', cancel); expect(b.body.instance.acknowledgement).toEqual(a.body.instance.acknowledgement);
  });
  it('WF09 concurrent same-key create leaves one source instance and exact request fact', async () => {
    const f = await fixture('concurrent-create'), responses = await Promise.all([create(f), create(f)]);
    expect(responses.map(r => r.status)).toEqual(expect.arrayContaining([201])); expect(responses.every(r => [201,409].includes(r.status))).toBe(true);
    const retry = await create(f); expect(retry.status).toBe(201); expect(await db().workflowInstance.count({ where: { entityId: f.entityId } })).toBe(1);
    expect((await state(f)).audits.filter(row => row.action === 'workflow_create')).toHaveLength(1);
  });
  it('WF10 concurrent approve/reject same step cannot decide twice', async () => {
    const f = await fixture('concurrent-decision'); expect((await create(f)).status).toBe(201);
    const approve = command(f, 'a'), reject = command(f, 'r'); const responses = await Promise.all([decide(f, approve), decide(f, reject, 'reject')]);
    expect(responses.filter(r => r.status === 200)).toHaveLength(1); expect(responses.filter(r => r.status === 409)).toHaveLength(1);
    const current = await state(f); expect(current.instances[0].steps.filter(step => !!step.decision)).toHaveLength(1);
    expect(current.audits.filter(row => ['workflow_approve','workflow_reject'].includes(row.action))).toHaveLength(1);
  });
  it('WF11 real P2003 mandatory creation audit failure rolls back instance and steps', async () => {
    const f = await fixture('create-audit'), fault = auditFault('workflow_create'); await denied(f, () => create(f, {}, f.initiator.token, application(fault.database)), 500, 'INTERNAL_ERROR');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { status: 'running' } });
    expect(await db().workflowInstance.count({ where: { entityId: f.entityId } })).toBe(0);
    expect(await db().auditLog.count({ where: { actorId: f.initiator.id, targetType: 'WorkflowInstance' } })).toBe(0);
  });
  it('WF12 real P2003 mandatory decision audit failure rolls back decided step and index', async () => {
    const f = await fixture('decide-audit'); expect((await create(f)).status).toBe(201); const fault = auditFault('workflow_approve');
    await denied(f, () => decide(f, command(f, 'fault'), 'approve', f.reviewer.token, application(fault.database)), 500, 'INTERNAL_ERROR');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { currentStepIndex: 1 } }); expect(fault.observed.staged.steps[0].decision).toBe('approved');
  });
  it('WF13 legacy/malformed snapshot stays readable but cannot manufacture approval', async () => {
    const f = await fixture('legacy'); expect((await create(f)).status).toBe(201); await db().auditLog.delete({ where: { id: 'WFC_' + f.instance.id } });
    const read = await request(f.app).get('/api/v1/workflow/instances/' + f.instance.id).set('Authorization', 'Bearer ' + f.reviewer.token);
    expect(read.status).toBe(200); expect(read.body.instance.allowedActions.approve).toBe(false); expect(read.body.instance.blockedReason).toContain('重新发起');
    await denied(f, () => decide(f), 409, 'CONFLICT');
  });
  it('WF14 exact history count and pagination exclude foreign source before counting', async () => {
    const f = await fixture('visible'), foreign = await fixture('hidden'); expect((await create(f)).status).toBe(201); expect((await create(foreign)).status).toBe(201);
    const response = await request(f.app).get('/api/v1/workflow/instances').query({ limit: 1, view: 'pending' }).set('Authorization', 'Bearer ' + f.reviewer.token);
    expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.total).toBe(1); expect(response.body.items.map((item: any) => item.id)).toEqual([f.instance.id]);
    const empty = await request(f.app).get('/api/v1/workflow/instances').query({ limit: 1, offset: 1, view: 'pending' }).set('Authorization', 'Bearer ' + f.reviewer.token);
    expect(empty.body.total).toBe(1); expect(empty.body.items).toEqual([]);
    const detail = await request(f.app).get('/api/v1/workflow/instances/' + foreign.instance.id).set('Authorization', 'Bearer ' + f.reviewer.token); expect(detail.status).toBe(404);
    const history = await request(f.app).get('/api/v1/workflow/entity/Order/' + foreign.order.id).set('Authorization', 'Bearer ' + f.reviewer.token); expect(history.status).toBe(404);
  });
  it('WF15 rejection preserves decisions; unassigned visible ordinary user cannot cancel', async () => {
    const f = await fixture('reject-cancel'); expect((await create(f)).status).toBe(201);
    const other = await identity(f.id + '-reader', 'role-finance'); await denied(f, () => post(f, 'instances/' + f.instance.id + '/cancel', command(f, 'other-cancel'), other.token), 403, 'FORBIDDEN');
    expect((await decide(f, command(f, 'reject'), 'reject')).status).toBe(200); expect(f.instance.status).toBe('rejected');
    await denied(f, () => decide(f, command(f, 'later')), 409, 'INVALID_STATE'); expect((await state(f)).instances[0].steps[0].decision).toBe('rejected');
  });
  it('WF16 generic Invoice review never issues the real draft document', async () => {
    const f = await fixture('invoice', true, 'Invoice'); expect((await create(f)).status).toBe(201);
    expect((await decide(f)).status).toBe(200); expect((await decide(f, command(f, 'last'))).status).toBe(200);
    expect(f.instance.status).toBe('approved'); expect(await db().invoice.findUniqueOrThrow({ where: { id: f.entityId } })).toMatchObject({ status: 'Draft', amount: expect.anything() });
  });
  it('WF17 generic 5A decisions never manufacture native garment release', async () => {
    const f = await fixture('5a', true, 'DevelopmentCase'); expect((await create(f)).status).toBe(201);
    expect((await decide(f)).status).toBe(200); expect((await decide(f, command(f, 'last'))).status).toBe(200);
    expect(await db().developmentCase.findUniqueOrThrow({ where: { id: f.entityId } })).toMatchObject({ stage: 'developing', reviewStatus: 'pending', reviewerId: null });
  });
  it('WF20 custom role display name never creates canonical reviewer authority', async () => {
    const f = await fixture('fake-role'), customId = f.id + '-custom';
    const custom = await identity(customId, customId + '-role');
    await db().role.update({ where: { id: customId + '-role' }, data: { name: 'manager' } });
    await db().relation.update({ where: { id: f.relation.id }, data: { salesRepIds: [f.reviewer.id, custom.id] } });
    expect((await create(f)).status).toBe(201); await denied(f, () => decide(f, command(f, 'name-spoof'), 'approve', custom.token), 403, 'FORBIDDEN');
  });
  it('WF18 awaited registration disables broken Shipment→Invoice trigger explicitly', async () => {
    const f = await fixture('bad-trigger', true, 'Invoice'); await db().workflowDefinition.update({ where: { id: f.definition.id }, data: { triggerEvent: 'ShipmentCompleted' } });
    await registerWorkflowEventTriggers(db()); expect(WORKFLOW_TRIGGER_GAPS[0].eventType).toBe('ShipmentCompleted');
    const dispatched = await businessEventBus.dispatch({ id: f.id + '-shipment-event', type: 'ShipmentCompleted', sourceEntityType: 'Shipment', sourceEntityId: f.id + '-shipment', payload: {}, occurredAt: Date.now(), actorId: f.initiator.id });
    expect(dispatched.ok).toBe(true); expect(await db().workflowInstance.count({ where: { definitionId: f.definition.id } })).toBe(0);
  });
  it('WF19 trusted persisted event starts once; unpersisted input remains failed instead of false consumed success', async () => {
    const f = await fixture('event'); await db().workflowDefinition.update({ where: { id: f.definition.id }, data: { triggerEvent: 'OrderCreated' } }); await registerWorkflowEventTriggers(db());
    const event = { id: f.id + '-event', type: 'OrderCreated' as const, sourceEntityType: 'Order', sourceEntityId: f.order.id, payload: {}, occurredAt: Date.now(), actorId: f.initiator.id };
    const absent = await businessEventBus.dispatch(event); expect(absent.ok).toBe(false); expect(await db().workflowInstance.count({ where: { definitionId: f.definition.id } })).toBe(0);
    await db().agentJob.create({ data: { id: event.id, jobType: 'bev:OrderCreated', status: 'queued', payload: event } });
    expect((await businessEventBus.dispatch(event)).ok).toBe(true); expect((await businessEventBus.dispatch(event)).ok).toBe(true);
    expect(await db().workflowInstance.count({ where: { definitionId: f.definition.id } })).toBe(1);
  });
  it('WF21 native cost→billing confirmation→Invoice supplies exact development parent and financial source snapshot', async () => {
    const f = await fixture('native-billing', false, 'Invoice'), source = await nativeBillingInvoice(f);
    const formed = await create(f); expect(formed.status, diagnostic(formed.body)).toBe(201);
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    const snapshot = (audit.detail as any).sourceSnapshot;
    expect(snapshot.row).toMatchObject({ sourceType: 'BillingItem', sourceId: source.billing.id, amount: '15.125', status: 'Draft' });
    expect(snapshot.origins.developmentParents.map((parent: any) => parent.row.id)).toEqual([source.source.id]);
    expect(snapshot.origins.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'CostRecord', id: source.cost.id, row: expect.objectContaining({ amount: '12.3456', currency: 'USD', sourceId: source.source.id }) }),
      expect.objectContaining({ model: 'BillingItem', id: source.billing.id, row: expect.objectContaining({ status: 'invoiced', invoiceId: f.entityId, currency: 'USD' }) }),
    ]));
    expect(snapshot.lines).toHaveLength(1); expect(snapshot.lines[0]).toMatchObject({ sourceType: 'CostRecord', sourceId: source.cost.id, amount: '15.125', currency: 'USD' });
    expect((await decide(f)).status).toBe(200);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: f.entityId } })).toMatchObject({ status: 'Draft', sourceType: 'BillingItem', sourceId: source.billing.id });
  });
  it('WF22 native Sample Invoice checks both actual parents without demanding unrelated pricing scopes', async () => {
    const f = await fixture('native-sample', false, 'Invoice'), sourceCase = await draftCase(f), source = await nativeSampleInvoice(f, sourceCase.id, f.order.id);
    const invoiceOnly = (who: Fixture['initiator']) => createAuthService().signToken({ ...who.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    const response = await create(f, {}, invoiceOnly(f.initiator)); expect(response.status, diagnostic(response.body)).toBe(201);
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } }), snapshot = (audit.detail as any).sourceSnapshot;
    expect(snapshot.origins.orderParents.map((parent: any) => parent.row.id)).toEqual([f.order.id]);
    expect(snapshot.origins.developmentParents.map((parent: any) => parent.row.id)).toEqual([sourceCase.id]);
    expect(snapshot.origins.records).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'Sample', id: source.sample.id, row: expect.objectContaining({ invoiceId: f.entityId }) })]));
    expect((await decide(f, command(f, 'sample'), 'approve', invoiceOnly(f.reviewer))).status).toBe(200);
  });
  it('WF23 owned Invoice cannot bypass a foreign development parent through stale Finance JWT labels', async () => {
    const f = await fixture('foreign-invoice-parent', false, 'Invoice'), foreign = await fixture('foreign-case-source', false, 'DevelopmentCase');
    await nativeSampleInvoice(f, foreign.entityId);
    // Remove this account's canonical Finance role only. Its actual custom
    // Invoice capabilities remain, with ordinary self customer scope. Do not
    // mistake a Finance all-scope fixture with a changed owner for a denial.
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    expect((await db().invoice.findUniqueOrThrow({ where: { id: f.entityId } })).ownerId).toBe(f.initiator.id);
    const context = await createPermissionService({ prisma: db() }).getUserPermissionContext(f.initiator.id);
    expect(context!.roleIds).not.toContain('role-finance'); expect(context!.scopes).toContain('invoices:write');
    await denied(f, () => create(f), 404, 'NOT_FOUND');
    const history = await request(f.app).get('/api/v1/workflow/entity/Invoice/' + f.entityId).set('Authorization', 'Bearer ' + f.initiator.token);
    expect(history.status).toBe(404);
    // Restoring the real source to this account's own customer proves the
    // rejection was parent L2, not a generally unusable custom role/fixture.
    const own = await draftCase(f); const sample = await db().sample.findFirstOrThrow({ where: { invoiceId: f.entityId } });
    await db().sample.update({ where: { id: sample.id }, data: { sourceCaseId: own.id } });
    expect((await create(f)).status).toBe(201);
  });
  it.each(['amount', 'currency', 'status'])('WF24 actual native source %s drift cannot reuse the original Invoice workflow approval', async field => {
    const f = await fixture('source-drift-' + field, false, 'Invoice'), source = await nativeBillingInvoice(f); expect((await create(f)).status).toBe(201);
    const creation = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    if (field === 'amount') await db().costRecord.update({ where: { id: source.cost.id }, data: { amount: '12.3457' } });
    if (field === 'currency') await db().costRecord.update({ where: { id: source.cost.id }, data: { currency: 'EUR' } });
    if (field === 'status') await db().billingItem.update({ where: { id: source.billing.id }, data: { status: 'cancelled' } });
    await denied(f, () => decide(f), 409, 'CONFLICT');
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: creation.id } })).toEqual(creation);
    const detail = await request(f.app).get('/api/v1/workflow/instances/' + f.instance.id).set('Authorization', 'Bearer ' + f.reviewer.token);
    expect(detail.status).toBe(200); expect(detail.body.instance.allowedActions.approve).toBe(false); expect(detail.body.instance.blockedReason).toContain('来源内容已变化');
  });
  it('WF25 broken, cyclic and unknown real Invoice sources refuse before any workflow mutation', async () => {
    const f = await fixture('broken-source', false, 'Invoice'), source = await nativeBillingInvoice(f);
    await db().invoice.update({ where: { id: f.entityId }, data: { sourceType: 'InventedSource' } });
    await denied(f, () => create(f), 409, 'CONFLICT');
    await db().invoice.update({ where: { id: f.entityId }, data: { sourceType: 'BillingItem' } });
    await db().costRecord.update({ where: { id: source.cost.id }, data: { sourceType: 'CostRecord', sourceId: source.cost.id } });
    await denied(f, () => create(f), 409, 'CONFLICT');
    await db().costRecord.update({ where: { id: source.cost.id }, data: { sourceType: 'DevelopmentCase', sourceId: source.source.id, deletedAt: BigInt(Date.now()) } });
    await denied(f, () => create(f), 404, 'NOT_FOUND');
  });
  it.each(['role-finance', 'finance'])('WF26 actual Finance without Order write can decide explicitly configured %s Order step', async approverRole => {
    const f = await fixture('finance-step-' + approverRole), finance = await identity(f.id + '-actual-finance', 'role-finance', ['orders:read', 'invoices:read', 'invoices:write']);
    expect(hasScope(finance.actor, 'orders:write')).toBe(false); expect(hasScope(finance.actor, 'orders:read')).toBe(true); expect(hasScope(finance.actor, 'invoices:write')).toBe(true);
    await db().workflowDefinition.update({ where: { id: f.definition.id }, data: { steps: [{ name: 'Actual configured financial review', approverRole }] } });
    expect((await create(f)).status).toBe(201);
    const view = await request(f.app).get('/api/v1/workflow/instances/' + f.instance.id).set('Authorization', 'Bearer ' + finance.token);
    expect(view.status).toBe(200); expect(view.body.instance.allowedActions).toMatchObject({ approve: true, reject: true });
    const original = command(f, 'finance-approve'), approved = await decide(f, original, 'approve', finance.token);
    expect(approved.status, diagnostic(approved.body)).toBe(200); expect(f.instance.status).toBe('approved');
    const replay = await decide(f, original, 'approve', finance.token); expect(replay.status).toBe(200); expect(replay.body.instance.acknowledgement).toEqual(approved.body.instance.acknowledgement);
    expect((await db().order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('Pending');
    expect((await state(f)).audits.filter(row => row.action === 'workflow_approve')).toHaveLength(1);
  });
  it('WF27 financial capability is not reviewer identity, an ordinary-step substitute or a ceiling bypass', async () => {
    const f = await fixture('financial-denials'), finance = await identity(f.id + '-finance', 'role-finance', ['orders:read', 'invoices:read', 'invoices:write']);
    expect((await create(f)).status).toBe(201);
    await denied(f, () => decide(f, command(f, 'ordinary-by-finance'), 'approve', finance.token), 403, 'FORBIDDEN');
    const exact = await fixture('financial-designated');
    await db().workflowDefinition.update({ where: { id: exact.definition.id }, data: { steps: [{ name: 'Designated finance duty', approverRole: 'role-finance', approverUserId: exact.reviewer.id }] } });
    expect((await create(exact)).status).toBe(201);
    await denied(exact, () => decide(exact, command(exact, 'wrong-finance'), 'approve', finance.token), 403, 'FORBIDDEN');
    const noFinancialCap = createAuthService().signToken({ ...exact.reviewer.actor, permissionCeiling: ['orders:read', 'orders:write'] });
    await denied(exact, () => decide(exact, command(exact, 'no-financial-cap'), 'approve', noFinancialCap), 403, 'FORBIDDEN');
    const specifiedCap = createAuthService().signToken({ ...exact.reviewer.actor, permissionCeiling: ['orders:read', 'invoices:write'] });
    expect((await decide(exact, command(exact, 'specified-duty'), 'approve', specifiedCap)).status).toBe(200);
  });
  it('WF28 definition canStart reflects current module capability and signed ceiling without pretending source L2 is pre-approved', async () => {
    const f = await fixture('definition-start'), finance = await identity(f.id + '-finance', 'role-finance', ['orders:read', 'invoices:read', 'invoices:write']);
    const invoice = await fixture('definition-invoice', false, 'Invoice');
    const list = await request(f.app).get('/api/v1/workflow/definitions').set('Authorization', 'Bearer ' + finance.token);
    expect(list.status).toBe(200); expect(list.body.definitions.find((row: any) => row.id === f.definition.id).canStart).toBe(false);
    expect(list.body.definitions.find((row: any) => row.id === invoice.definition.id).canStart).toBe(true);
    const token = createAuthService().signToken({ ...finance.actor, permissionCeiling: ['orders:read', 'invoices:read'] });
    const capped = await request(f.app).get('/api/v1/workflow/definitions').set('Authorization', 'Bearer ' + token);
    expect(capped.status).toBe(200); expect(capped.body.definitions.every((row: any) => row.canStart === false)).toBe(true);
  });
  it('WFS01 actual Order candidates filter parent L2 before count and pagination', async () => {
    const f = await fixture('source-page-order'), foreign = await fixture('source-page-foreign');
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    const second = await db().order.create({ data: { id: f.id + '-second-order', poNumber: f.id + '-second-po', customer: f.relation.name, customerRelationId: f.relation.id,
      product: 'Synthetic second scoped source', type: 'Fabric', quantity: 5, quoteAmount: '61.7284', currency: 'USD', status: 'Pending', dueDate: '2026-11-01', ownerId: f.initiator.id } });
    const page = await sourcePage(f, 'Order', { limit: 1 });
    expect(page.status, diagnostic(page.body)).toBe(200); expect(page.body).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(page.body.items).toHaveLength(1); expect(Object.keys(page.body.items[0]).sort()).toEqual(['id', 'label', 'type']);
    const next = await sourcePage(f, 'Order', { limit: 1, offset: 1 }); expect(next.body.total).toBe(2);
    expect([...page.body.items, ...next.body.items].map(row => row.id).sort()).toEqual([f.order.id, second.id].sort());
    const after = await sourcePage(f, 'Order', { limit: 1, offset: 2 }); expect(after.body.total).toBe(2); expect(after.body.items).toEqual([]);
    expect(page.body.items.map((row: any) => row.id)).not.toContain(foreign.order.id);
  });
  it('WFS02 current 5A and followup customer scope filter before counting rather than on the browser', async () => {
    const f = await fixture('source-page-5a', false, 'DevelopmentCase'), foreign = await fixture('source-hidden-5a', false, 'DevelopmentCase');
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    const non5a = await draftCase(f, 'non-5a'); await db().developmentCase.update({ where: { id: non5a.id }, data: { sampleCategory: 'ordinary' } });
    const page = await sourcePage(f, 'DevelopmentCase', { limit: 1 });
    expect(page.status, diagnostic(page.body)).toBe(200); expect(page.body.total).toBe(1); expect(page.body.items).toEqual([{ id: f.entityId, type: 'DevelopmentCase', label: f.entityId + ' · Synthetic 5A draft' }]);
    expect(page.body.items.map((row: any) => row.id)).not.toContain(foreign.entityId);
    const after = await sourcePage(f, 'DevelopmentCase', { limit: 1, offset: 1 }); expect(after.body.total).toBe(1); expect(after.body.items).toEqual([]);
  });
  it('WFS03 native Invoice candidates require actual development parent visibility even when the Invoice header is owned', async () => {
    const f = await fixture('source-page-invoice', false, 'Invoice'), foreign = await fixture('source-invoice-foreign', false, 'DevelopmentCase');
    const native = await nativeBillingInvoice(f), seedInvoiceId = f.id + '-invoice'; await nativeSampleInvoice(f, foreign.entityId);
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    const page = await sourcePage(f, 'Invoice', { limit: 200 }); expect(page.status, diagnostic(page.body)).toBe(200); expect(page.body.total).toBe(2);
    expect(page.body.items.map((row: any) => row.id).sort()).toEqual([seedInvoiceId, native.invoice.id].sort());
    expect(page.body.items.every((row: any) => Object.keys(row).sort().join() === 'id,label,type')).toBe(true);
    expect(page.body.items.map((row: any) => row.id)).not.toContain(f.entityId);
  });
  it('WFS04 source reads require both current read/start capabilities and signed ceiling; stale JWT/body labels do not authorize', async () => {
    const f = await fixture('source-caps'), finance = await identity(f.id + '-finance', 'role-finance', ['orders:read', 'invoices:read', 'invoices:write']);
    const noWrite = await sourcePage(f, 'Order', { permissions: 'orders:write' }, finance.token); expect(noWrite.status).toBe(403); expect(noWrite.body.error).toBe('FORBIDDEN');
    const cap = createAuthService().signToken({ ...f.initiator.actor, permissionCeiling: ['orders:read'] });
    const capped = await sourcePage(f, 'Order', {}, cap); expect(capped.status).toBe(403);
    await db().userAccount.update({ where: { id: f.initiator.id }, data: { status: 'disabled' } });
    const inactive = await sourcePage(f, 'Order'); expect(inactive.status).toBe(401); expect(inactive.body.error).toBe('UNAUTHORIZED');
  });
  it.each(['order', 'userAccount'] as const)('WFS05 actual %s SQL read failure is not converted to an empty candidate result', async delegate => {
    const f = await fixture('source-sql-' + delegate), fault = sourceReadFault(delegate), before = await state(f);
    const response = await sourcePage(f, 'Order', {}, f.initiator.token, application(fault.database));
    expect(response.status, diagnostic(response.body)).toBe(503); expect(response.body.error).toBe('DEPENDENCY_CHECK_FAILED'); expect(response.body.items).toBeUndefined();
    expect(fault.observed).toEqual({ injections: 1, code: 'P2010' }); expect(await state(f)).toEqual(before);
  });
  it('WFS06 source entity whitelist and malformed pagination reject without workflow writes', async () => {
    const f = await fixture('source-input');
    await denied(f, () => sourcePage(f, 'Shipment'), 400, 'INVALID_INPUT');
    await denied(f, () => sourcePage(f, 'Order', { limit: 0 }), 400, 'INVALID_INPUT');
    await denied(f, () => sourcePage(f, 'Order', { offset: -1 }), 400, 'INVALID_INPUT');
  });
  it.each(['create', 'approve', 'reject', 'cancel'] as const)('WFR01 %s check does not fence; permanent retirement rejects the late original writer without effects', async action => {
    const f = await fixture('retire-' + action, true); if (action !== 'create') expect((await create(f)).status).toBe(201);
    const body = action === 'create' ? { definitionId: f.definition.id, entityType: f.entityType, entityId: f.entityId, title: 'Original title', clientRequestId: f.id + '-original' }
      : { ...command(f, 'original'), ...(action === 'cancel' ? { reason: 'Original cancellation' } : {}) };
    const token = action === 'approve' || action === 'reject' ? f.reviewer.token : f.initiator.token, actor = action === 'approve' || action === 'reject' ? f.reviewer : f.initiator;
    const originalPayload = { ...body, ...(action !== 'create' ? { instanceId: f.instance.id } : {}) }, input = { action, originalClientRequestId: body.clientRequestId, originalPayload };
    const before = await state(f), checked = await post(f, 'requests/result', input, token);
    expect(checked.status, diagnostic(checked.body)).toBe(200); expect(checked.body.state).toBe('not_applied_at_check'); expect(await state(f)).toEqual(before);
    const request = normalizeWorkflowOriginal(input as any), parent = { entityType: 'Order' as const, entityId: f.entityId, instanceId: action === 'create' ? null : f.instance.id };
    const key = workflowRequestAuditId(actor.id, parent, body.clientRequestId); expect(await db().auditLog.findUnique({ where: { id: key } })).toBeNull();
    const retireInput = { ...input, retirementClientRequestId: f.id + '-retirement', reason: 'Correct original command' }, retired = await post(f, 'requests/retire', retireInput, token);
    expect(retired.status, diagnostic(retired.body)).toBe(200); expect(retired.body).toMatchObject({ state: 'retired', action, actorId: actor.id, originalParameterHash: request.parameterHash, parent });
    expect(retired.body.retirement).toMatchObject({ fenceAuditId: key, originalClientRequestId: body.clientRequestId, retirementClientRequestId: retireInput.retirementClientRequestId, reason: retireInput.reason });
    const stored: any = await db().auditLog.findUnique({ where: { id: key } }); expect(stored.action).toBe('workflow_request_retired');
    expect(stored.detail.decisionActorAuthority).toMatchObject({ userId: actor.id, authorizationLoaded: true }); expect(stored.detail.originalCommand).toEqual(request.command);
    expect(retired.body.retirement.retirementParameterHash).toBe(workflowHash({ action, actorId: actor.id, parent, originalClientRequestId: body.clientRequestId,
      originalParameterHash: request.parameterHash, retirementClientRequestId: retireInput.retirementClientRequestId, reason: retireInput.reason }));
    await denied(f, () => action === 'create' ? post(f, 'instances', body, token) : post(f, 'instances/' + f.instance.id + '/' + action, body, token), 409, 'CONFLICT');
    expect(await db().auditLog.findUnique({ where: { id: key } })).toEqual(stored);
    expect((await post(f, 'requests/retire', retireInput, token)).body).toEqual(retired.body);
    expect((await post(f, 'requests/result', input, token)).body).toEqual(retired.body);
    expect(await state(f)).toEqual(before);
  });
  it.each(['create', 'approve', 'reject', 'cancel'] as const)('WFR02 exact applied %s result returns the original acknowledgement without reversing history', async action => {
    const f = await fixture('applied-result-' + action, true); let response: any, body: any;
    if (action === 'create') { body = { definitionId: f.definition.id, entityType: 'Order', entityId: f.entityId, title: 'Applied original title', clientRequestId: f.id + '-applied' }; response = await post(f, 'instances', body); f.instance = response.body.instance; }
    else { expect((await create(f)).status).toBe(201); body = { ...command(f, 'applied'), ...(action === 'cancel' ? { reason: 'Applied cancellation' } : {}) };
      response = await post(f, 'instances/' + f.instance.id + '/' + action, body, action === 'cancel' ? f.initiator.token : f.reviewer.token); f.instance = response.body.instance; }
    expect(response.status, diagnostic(response.body)).toBe(action === 'create' ? 201 : 200);
    const input = { action, originalClientRequestId: body.clientRequestId, originalPayload: { ...body, ...(action !== 'create' ? { instanceId: f.instance.id } : {}) } };
    const token = action === 'approve' || action === 'reject' ? f.reviewer.token : f.initiator.token;
    await db().order.update({ where: { id: f.order.id }, data: { quoteAmount: '124.9999' } }); const before = await state(f);
    const checked = await post(f, 'requests/result', input, token); expect(checked.status, diagnostic(checked.body)).toBe(200);
    expect(checked.body.state).toBe('applied'); expect(checked.body.acknowledgement).toEqual(response.body.instance.acknowledgement);
    const retired = await post(f, 'requests/retire', { ...input, retirementClientRequestId: f.id + '-no-retire-applied', reason: 'Cannot reverse applied fact' }, token);
    expect(retired.status, diagnostic(retired.body)).toBe(200); expect(retired.body).toEqual(checked.body); expect(await state(f)).toEqual(before);
  });
  it('WFR03 stale source command can be retired under current source L2, then canceled using a new current command', async () => {
    const f = await fixture('stale-retire', true); expect((await create(f)).status).toBe(201); const body = command(f, 'old-approval');
    await db().order.update({ where: { id: f.order.id }, data: { quoteAmount: '200.0001' } }); await denied(f, () => decide(f, body), 409, 'CONFLICT');
    const input = { action: 'approve', originalClientRequestId: body.clientRequestId, originalPayload: { ...body, instanceId: f.instance.id } };
    const retired = await post(f, 'requests/retire', { ...input, retirementClientRequestId: f.id + '-stale-retire', reason: 'Source revised; cancel and reapply' }, f.reviewer.token);
    expect(retired.status, diagnostic(retired.body)).toBe(200); expect(retired.body.state).toBe('retired');
    const current = await request(f.app).get('/api/v1/workflow/instances/' + f.instance.id).set('Authorization', 'Bearer ' + f.initiator.token); expect(current.status).toBe(200);
    f.instance = current.body.instance; const canceled = await post(f, 'instances/' + f.instance.id + '/cancel', { ...command(f, 'new-cancel'), reason: 'Source changed' });
    expect(canceled.status, diagnostic(canceled.body)).toBe(200); expect(canceled.body.instance.status).toBe('cancelled');
    await denied(f, () => decide(f, body), 409, 'CONFLICT');
  });
  it('WFR04 full payload and retirement-ID/reason conflicts never overwrite the original fence', async () => {
    const f = await fixture('retire-conflicts', true); expect((await create(f)).status).toBe(201); const body = command(f, 'original');
    const input = { action: 'approve', originalClientRequestId: body.clientRequestId, originalPayload: { ...body, instanceId: f.instance.id }, retirementClientRequestId: f.id + '-retire', reason: 'Explicit correction' };
    const retired = await post(f, 'requests/retire', input, f.reviewer.token); expect(retired.status, diagnostic(retired.body)).toBe(200);
    for (const changed of [{ ...input, originalPayload: { ...input.originalPayload, note: 'Different original intent' } }, { ...input, action: 'reject' },
      { ...input, retirementClientRequestId: f.id + '-different-retire' }, { ...input, reason: 'Different reason' }]) await denied(f, () => post(f, 'requests/retire', changed, f.reviewer.token), 409, 'CONFLICT');
    const key = retired.body.retirement.fenceAuditId, stored: any = await db().auditLog.findUnique({ where: { id: key } });
    await db().auditLog.update({ where: { id: key }, data: { detail: { ...stored.detail, originalCommand: null } } });
    const bad = await post(f, 'requests/result', input, f.reviewer.token); expect(bad.status, diagnostic(bad.body)).toBe(409); expect(bad.body.state).toBeUndefined();
    await denied(f, () => decide(f, body), 409, 'CONFLICT');
  });
  it('WFR05 actual retirement audit P2003 rolls back fence; the original writer can subsequently apply', async () => {
    const f = await fixture('retire-audit-fault', true); expect((await create(f)).status).toBe(201); const body = command(f, 'original');
    const input = { action: 'approve', originalClientRequestId: body.clientRequestId, originalPayload: { ...body, instanceId: f.instance.id }, retirementClientRequestId: f.id + '-retire', reason: 'Audit must succeed' };
    const fault = auditFault('workflow_request_retired'), before = await state(f), response = await post(f, 'requests/retire', input, f.reviewer.token, application(fault.database));
    expect(response.status, diagnostic(response.body)).toBe(500); expect(response.body.error).toBe('INTERNAL_ERROR'); expect(response.body.state).toBeUndefined();
    expect(fault.observed.injections).toBe(1); expect(fault.observed.code).toBe('P2003'); expect(await state(f)).toEqual(before);
    expect(fault.observed.attempted).toMatchObject({ actorId: f.reviewer.id, action: 'workflow_request_retired', targetType: 'WorkflowRequest', targetId: 'instance:' + f.instance.id,
      detail: { originalClientRequestId: body.clientRequestId, originalCommand: { instanceId: f.instance.id, decision: 'approved', note: body.note }, acknowledgement: { retirementClientRequestId: input.retirementClientRequestId } } });
    const key = workflowRequestAuditId(f.reviewer.id, { entityType: 'Order', entityId: f.entityId, instanceId: f.instance.id }, body.clientRequestId);
    expect(await db().auditLog.findUnique({ where: { id: key } })).toBeNull(); const applied = await decide(f, body); expect(applied.status, diagnostic(applied.body)).toBe(200);
    expect((await db().auditLog.findUnique({ where: { id: key } }))!.action).toBe('workflow_approve');
  });
  it('WFR06 actual concurrent writer and retire leave exactly one applied-or-retired immutable outcome', async () => {
    const f = await fixture('writer-retire-race', true); expect((await create(f)).status).toBe(201); const body = command(f, 'racing-original');
    const input = { action: 'approve', originalClientRequestId: body.clientRequestId, originalPayload: { ...body, instanceId: f.instance.id }, retirementClientRequestId: f.id + '-race-retire', reason: 'Concurrent correction' };
    const responses = await Promise.all([post(f, 'instances/' + f.instance.id + '/approve', body, f.reviewer.token), post(f, 'requests/retire', input, f.reviewer.token)]);
    expect(responses.every(response => [200, 409].includes(response.status)), diagnostic(responses.map(response => response.body))).toBe(true);
    const checked = await post(f, 'requests/result', input, f.reviewer.token); expect(checked.status, diagnostic(checked.body)).toBe(200);
    expect(['applied', 'retired']).toContain(checked.body.state); const rows = await db().auditLog.findMany({ where: { id: checked.body.acknowledgement?.auditId || checked.body.retirement?.fenceAuditId } }); expect(rows).toHaveLength(1);
    const current = await db().workflowInstance.findUnique({ where: { id: f.instance.id }, include: { steps: { orderBy: { stepIndex: 'asc' } } } });
    expect(current!.steps[0].decision).toBe(checked.body.state === 'applied' ? 'approved' : null); expect(current!.currentStepIndex).toBe(checked.body.state === 'applied' ? 1 : 0);
  });
  it('WFR07 current capability/ceiling/parent L2 failure cannot produce a retirement proof', async () => {
    const f = await fixture('retire-current-auth', true), foreign = await fixture('retire-foreign'); expect((await create(f)).status).toBe(201);
    const body = command(f, 'original'), input = { action: 'approve', originalClientRequestId: body.clientRequestId, originalPayload: { ...body, instanceId: f.instance.id }, retirementClientRequestId: f.id + '-retire', reason: 'Real current scope required' };
    const capped = createAuthService().signToken({ ...f.reviewer.actor, permissionCeiling: ['orders:read'] });
    const response = await denied(f, () => post(f, 'requests/retire', input, capped), 403, 'FORBIDDEN'); expect(response.body.state).toBeUndefined();
    await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: foreign.relation.id, ownerId: foreign.initiator.id } });
    await db().userRole.deleteMany({ where: { userId: f.reviewer.id, roleId: 'role-sales-manager' } });
    const foreignResponse = await denied(f, () => post(f, 'requests/retire', input, f.reviewer.token), 404, 'NOT_FOUND'); expect(foreignResponse.body.state).toBeUndefined();
  });
  it('WFR08 a checked absent request can still apply; checking alone never grants permission to discard an in-flight intent', async () => {
    const f = await fixture('checked-then-applied', true); expect((await create(f)).status).toBe(201); const body = command(f, 'original');
    const input = { action: 'approve', originalClientRequestId: body.clientRequestId, originalPayload: { ...body, instanceId: f.instance.id } };
    const checked = await post(f, 'requests/result', input, f.reviewer.token); expect(checked.status).toBe(200); expect(checked.body.state).toBe('not_applied_at_check');
    const applied = await decide(f, body); expect(applied.status, diagnostic(applied.body)).toBe(200);
    const result = await post(f, 'requests/result', input, f.reviewer.token); expect(result.status).toBe(200); expect(result.body.state).toBe('applied'); expect(result.body.acknowledgement).toEqual(applied.body.instance.acknowledgement);
  });
  it('WFR09 damaged actual applied receipt cannot be retired or reported not applied', async () => {
    const f = await fixture('damaged-applied', true); expect((await create(f)).status).toBe(201); const body = command(f, 'original'), applied = await decide(f, body); expect(applied.status).toBe(200);
    const id = applied.body.instance.acknowledgement.auditId, row: any = await db().auditLog.findUnique({ where: { id } });
    await db().auditLog.update({ where: { id }, data: { detail: { ...row.detail, acknowledgementHash: 'damaged' } } });
    const input = { action: 'approve', originalClientRequestId: body.clientRequestId, originalPayload: { ...body, instanceId: f.instance.id }, retirementClientRequestId: f.id + '-retire', reason: 'Do not erase applied decision' };
    for (const path of ['requests/result', 'requests/retire']) { const deniedResult = await denied(f, () => post(f, path, input, f.reviewer.token), 409, 'CONFLICT'); expect(deniedResult.body.state).toBeUndefined(); }
    expect((await db().auditLog.findUniqueOrThrow({ where: { id } })).action).toBe('workflow_approve');
  });
  it('WFN01 native draft PO→send→confirm→actual processing delivery→Payable supplies full Order/line/receipt source without extra pricing permission', async () => {
    const f = await fixture('native-processing', false, 'Invoice'), source = await nativeServiceInvoice(f);
    const invoiceOnly = (user: typeof f.initiator) => createAuthService().signToken({ ...user.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    const created = await create(f, {}, invoiceOnly(f.initiator)); expect(created.status, diagnostic(created.body)).toBe(201);
    const fact: any = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } });
    expect(fact.detail.sourceSnapshot.origins.orderParents.map((row: any) => row.row.id)).toEqual([f.order.id]);
    expect(fact.detail.sourceSnapshot.origins.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'PurchaseServiceDelivery', id: source.delivery.id, row: expect.objectContaining({ acceptedAmount: '4.938', acceptedQuantity: '4', unitPriceSnapshot: '1.2345', currencySnapshot: 'USD' }) }),
      expect.objectContaining({ model: 'PurchaseOrder', id: source.purchaseOrder.id, row: expect.objectContaining({ status: 'PartiallyReceived', orderId: f.order.id, supplierRelationId: source.supplier.id }) }),
      expect.objectContaining({ model: 'PurchaseLine', id: source.purchaseLine.id, row: expect.objectContaining({ orderLineId: source.orderLine.id, receivedQuantity: '4' }) }),
      expect.objectContaining({ model: 'OrderLine', id: source.orderLine.id }) ]));
    expect((await sourcePage(f, 'Invoice', {}, invoiceOnly(f.initiator))).body.items.map((row: any) => row.id)).toContain(source.invoice.id);
    expect((await decide(f, command(f, 'processing-approve'), 'approve', invoiceOnly(f.reviewer))).status).toBe(200);
    expect((await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } })).status).toBe('Draft');
  });
  it.each(['amount', 'currency', 'status'] as const)('WFN02 actual processing source %s damage cannot reuse the immutable workflow fact', async field => {
    const f = await fixture('processing-drift-' + field, true, 'Invoice'), source = await nativeServiceInvoice(f); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } }), body = command(f, 'old-processing');
    if (field === 'status') await db().purchaseOrder.update({ where: { id: source.purchaseOrder.id }, data: { status: 'Cancelled' } });
    else await db().purchaseServiceDelivery.update({ where: { id: source.delivery.id }, data: field === 'amount' ? { acceptedAmount: '5.0001' } : { currencySnapshot: 'EUR' } });
    await denied(f, () => decide(f, body), 409, 'CONFLICT'); expect(await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } })).toEqual(fact);
  });
  it('WFN03 processing Invoice owned by caller still rejects a foreign actual Order and mismatched real product line', async () => {
    const f = await fixture('processing-parents', true, 'Invoice'), foreign = await fixture('processing-foreign'), source = await nativeServiceInvoice(f);
    await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: foreign.relation.id, ownerId: foreign.initiator.id } });
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    await denied(f, () => create(f), 404, 'NOT_FOUND');
    await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: f.relation.id, ownerId: f.initiator.id } });
    const foreignLine = await db().orderLine.create({ data: { id: f.id + '-foreign-product-line', orderId: foreign.order.id, lineNumber: 1, quantity: '4', unit: 'Pcs' } });
    await db().purchaseLine.update({ where: { id: source.purchaseLine.id }, data: { orderLineId: foreignLine.id } });
    await denied(f, () => create(f), 404, 'NOT_FOUND');
    await db().purchaseLine.update({ where: { id: source.purchaseLine.id }, data: { orderLineId: source.orderLine.id } }); expect((await create(f)).status).toBe(201);
  });
  it('WFN04 native pricing Draft→confirmed→Commission Payable binds actual order#sequence and intermediary; generic approval never changes Issued', async () => {
    const f = await fixture('native-commission', false, 'Invoice'), source = await nativeCommissionInvoice(f);
    const invoiceOnly = (user: typeof f.initiator) => createAuthService().signToken({ ...user.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    const created = await create(f, {}, invoiceOnly(f.initiator)); expect(created.status, diagnostic(created.body)).toBe(201);
    const fact: any = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } }), records = fact.detail.sourceSnapshot.origins.records;
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'CommissionPayable', id: f.order.id + '#1', row: expect.objectContaining({ orderId: f.order.id, sequence: 1 }) }),
      expect.objectContaining({ model: 'CommissionRule', id: source.rule.id, row: expect.objectContaining({ rate: '5', intermediaryRelationId: source.intermediary.id }) }),
      expect.objectContaining({ model: 'PricingCalculation', id: source.pricing.id, row: expect.objectContaining({ quantity: '10', commissionAmount: '0.05', status: 'Confirmed' }) }) ]));
    const pricingRow = records.find((row: any) => row.model === 'PricingCalculation').row;
    expect(pricingRow).not.toHaveProperty('purchaseCostCny'); expect(pricingRow).not.toHaveProperty('profitAmount'); expect(pricingRow).not.toHaveProperty('refundRate');
    expect((await sourcePage(f, 'Invoice', {}, invoiceOnly(f.initiator))).body.items.map((row: any) => row.id)).toContain(source.invoice.id);
    expect((await decide(f, command(f, 'commission-approve'), 'approve', invoiceOnly(f.reviewer))).status).toBe(200);
    expect((await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } })).status).toBe('Issued');
  });
  it.each(['quantity', 'status', 'intermediary'] as const)('WFN05 real commission source %s changes cannot reuse the original approval snapshot', async field => {
    const f = await fixture('commission-drift-' + field, true, 'Invoice'), source = await nativeCommissionInvoice(f); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } }), body = command(f, 'old-commission');
    if (field === 'intermediary') { const other = await fixture('commission-other-party'); await db().commissionRule.update({ where: { id: source.rule.id }, data: { intermediaryRelationId: other.relation.id } }); }
    else await source.pricingService.updateCalculation(source.pricing.id, field === 'quantity' ? { quantity: 11 } : { status: 'Draft' }, f.initiator.id);
    await denied(f, () => decide(f, body), 409, 'CONFLICT'); expect(await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } })).toEqual(fact);
  });
  it('WFN06 native incremental commission invoices keep distinct real sequence/history instead of forcing each amount to equal total', async () => {
    const f = await fixture('commission-increment', true, 'Invoice'), first = await nativeCommissionInvoice(f); expect((await create(f)).status).toBe(201); const oldInstance = f.instance, oldBody = command(f, 'old-first');
    const draft = await first.pricingService.createCalculation({ orderId: f.order.id, purchaseCostCny: 7, refundRate: 0, exchangeRate: 7, profitMargin: 10, commissionRuleId: first.rule.id, quantity: 10, status: 'Draft' }, f.initiator.id);
    await first.pricingService.updateCalculation(draft.id, { status: 'Confirmed' }, f.initiator.id);
    const second = await createCommissionPayable(db(), { orderId: f.order.id }, f.initiator.id); expect(second.ok, diagnostic(second)).toBe(true); if (!second.ok) throw Error('Incremental commission fixture rejected');
    expect(second.data.invoice.sourceId).toBe(f.order.id + '#2'); expect(second.data.invoice.amount.toString()).toBe('0.5');
    await denied(f, () => post(f, 'instances/' + oldInstance.id + '/approve', oldBody, f.reviewer.token), 409, 'CONFLICT');
    f.entityId = second.data.invoice.id; const created = await create(f, { clientRequestId: f.id + '-second-create' }); expect(created.status, diagnostic(created.body)).toBe(201);
    const fact: any = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } }), anchors = fact.detail.sourceSnapshot.origins.records.filter((row: any) => row.model === 'Invoice');
    expect(anchors.map((row: any) => row.id).sort()).toEqual([first.invoice.id, second.data.invoice.id].sort());
    expect((await decide(f, command(f, 'second-commission'))).status).toBe(200);
  });
  it('WFN07 commission foreign real Order and malformed sequence/header links reject without guessing identity from notes', async () => {
    const f = await fixture('commission-parent', true, 'Invoice'), foreign = await fixture('commission-foreign'), source = await nativeCommissionInvoice(f);
    await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: foreign.relation.id, ownerId: foreign.initiator.id } }); await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    await denied(f, () => create(f), 404, 'NOT_FOUND'); await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: f.relation.id, ownerId: f.initiator.id } });
    for (const sourceId of [f.order.id + '#0', f.order.id + '#01', f.order.id + '#not-a-sequence', foreign.order.id + '#1']) {
      await db().invoice.update({ where: { id: source.invoice.id }, data: { sourceId } }); await denied(f, () => create(f), 409, 'CONFLICT');
    }
    await db().invoice.update({ where: { id: source.invoice.id }, data: { sourceId: f.order.id + '#1' } }); expect((await create(f)).status).toBe(201);
  });
  it('WFNP01 two actual Order prefixes isolate native commission amounts and sequence, including native cancellation/reopening and workflow sources', async () => {
    const own = await fixture('namespace-order-a', true, 'Invoice'), neighbor = await fixture('namespace-order-a-suffix', true, 'Invoice');
    neighbor.order = await db().order.create({ data: { id: own.order.id + '-suffix', customer: neighbor.relation.name, customerRelationId: neighbor.relation.id,
      product: 'Synthetic neighboring draft Order', type: 'Fabric', quantity: 10, quoteAmount: '123.4567', currency: 'USD', status: 'Pending', dueDate: '2026-11-01', ownerId: neighbor.initiator.id } });
    const suffix = await nativeCommissionInvoice(neighbor); let suffixInvoice = suffix.invoice;
    for (const sequence of [2, 3]) {
      const cancelled = await updateInvoice({ prisma: db(), invoiceId: suffixInvoice.id, actorId: neighbor.initiator.id, input: { status: 'Cancelled' } }); expect(cancelled.ok, diagnostic(cancelled)).toBe(true);
      const reopened = await createCommissionPayable(db(), { orderId: neighbor.order.id }, neighbor.initiator.id); expect(reopened.ok, diagnostic(reopened)).toBe(true); if (!reopened.ok) throw Error('Neighbor native reopening rejected');
      suffixInvoice = reopened.data.invoice; expect(suffixInvoice.sourceId).toBe(neighbor.order.id + '#' + sequence); expect(suffixInvoice.amount.toString()).toBe('0.5');
    }
    const beforeOwn = await getOrderCommission(db(), own.order.id); expect(beforeOwn).toMatchObject({ ok: true, data: { totalCommission: 0, invoicedAmount: 0, uninvoicedAmount: 0, payableInvoices: [] } });
    const nativeOwn = await nativeCommissionInvoice(own); expect(nativeOwn.invoice.sourceId).toBe(own.order.id + '#1');
    const suffixBefore = await db().invoice.findMany({ where: { sourceType: 'CommissionPayable', sourceId: { startsWith: neighbor.order.id + '#' } }, orderBy: { id: 'asc' } });
    await nativeOwn.pricingService.updateCalculation(nativeOwn.pricing.id, { quantity: 20 }, own.initiator.id);
    const increment = await createCommissionPayable(db(), { orderId: own.order.id }, own.initiator.id); expect(increment.ok, diagnostic(increment)).toBe(true); if (!increment.ok) throw Error('Exact namespace native increment rejected');
    expect(increment.data.invoice.sourceId).toBe(own.order.id + '#2'); expect(increment.data.invoice.amount.toString()).toBe('0.5');
    const ownView = await getOrderCommission(db(), own.order.id), neighborView = await getOrderCommission(db(), neighbor.order.id);
    expect(ownView).toMatchObject({ ok: true, data: { totalCommission: 1, invoicedAmount: 1, uninvoicedAmount: 0 } });
    expect(neighborView).toMatchObject({ ok: true, data: { totalCommission: 0.5, invoicedAmount: 0.5, uninvoicedAmount: 0 } });
    if (!ownView.ok || !neighborView.ok) throw Error('Exact namespace read rejected');
    expect(ownView.data.payableInvoices.map(row => row.id).sort()).toEqual([nativeOwn.invoice.id, increment.data.invoice.id].sort()); expect(neighborView.data.payableInvoices.map(row => row.id)).toEqual([suffixInvoice.id]);
    expect(await db().invoice.findMany({ where: { sourceType: 'CommissionPayable', sourceId: { startsWith: neighbor.order.id + '#' } }, orderBy: { id: 'asc' } })).toEqual(suffixBefore);
    own.entityId = increment.data.invoice.id; expect((await create(own)).status).toBe(201); expect((await decide(own, command(own, 'exact-namespace-approve'))).status).toBe(200);
    const source: any = await db().auditLog.findUnique({ where: { id: 'WFC_' + own.instance.id } });
    expect(source.detail.sourceSnapshot.origins.records.filter((row: any) => row.model === 'Invoice').map((row: any) => row.id).sort()).toEqual([nativeOwn.invoice.id, increment.data.invoice.id].sort());
  });
  it.each(['legacy-exact', 'malformed-tail'] as const)('WFNP02 actual existing %s source blocks read/new invoice/workflow without rewriting prior native history', async shape => {
    const f = await fixture('namespace-unverified-' + shape, true, 'Invoice'), native = await nativeCommissionInvoice(f);
    // Post-formation corruption/legacy-shape control, not proof that this was a
    // historical native producer. The real native Invoice and audit came first.
    const sourceId = shape === 'legacy-exact' ? f.order.id : f.order.id + '#1-tail';
    await db().invoice.update({ where: { id: native.invoice.id }, data: { sourceId } });
    const invoices = await db().invoice.findMany({ where: { orderId: f.order.id }, orderBy: { id: 'asc' } }), audits = await db().auditLog.findMany({ where: { targetType: 'Invoice', targetId: native.invoice.id }, orderBy: { id: 'asc' } });
    expect(audits.some(row => row.action === 'create_invoice')).toBe(true);
    expect(await getOrderCommission(db(), f.order.id)).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(await createCommissionPayable(db(), { orderId: f.order.id }, f.initiator.id)).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    await denied(f, () => create(f), 409, 'CONFLICT');
    expect(await db().invoice.findMany({ where: { orderId: f.order.id }, orderBy: { id: 'asc' } })).toEqual(invoices);
    expect(await db().auditLog.findMany({ where: { targetType: 'Invoice', targetId: native.invoice.id }, orderBy: { id: 'asc' } })).toEqual(audits);
    await db().invoice.update({ where: { id: native.invoice.id }, data: { sourceId: f.order.id + '#1' } });
    expect(await getOrderCommission(db(), f.order.id)).toMatchObject({ ok: true, data: { uninvoicedAmount: 0, invoicedAmount: 0.5 } });
    expect((await create(f)).status).toBe(201);
  });
  it.each([false, true])('WFM01 native PO→reject receipt→claim→shipped→confirmed negative Payable resolves actual parents (independent PO=%s)', async independent => {
    const f = await fixture('supplier-claim-' + independent, true, 'Invoice'), source = await nativeSupplierClaimInvoice(f, independent);
    const invoiceOnly = (user: typeof f.initiator) => createAuthService().signToken({ ...user.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    const created = await create(f, {}, invoiceOnly(f.initiator)); expect(created.status, diagnostic(created.body)).toBe(201);
    const fact: any = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } }), origins = fact.detail.sourceSnapshot.origins;
    expect(origins.orderParents.map((row: any) => row.row.id)).toEqual(independent ? [] : [f.order.id]);
    expect(origins.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'MaterialReturn', id: source.source.id, row: expect.objectContaining({ claimInvoiceId: source.invoice.id, amount: '5.1234', status: 'confirmed' }) }),
      expect.objectContaining({ model: 'MaterialReceipt', id: source.receipt.id, row: expect.objectContaining({ status: 'Rejected', totalRejected: '10', purchaseOrderId: source.purchaseOrder.id }) }),
      expect.objectContaining({ model: 'PurchaseOrder', id: source.purchaseOrder.id, row: expect.objectContaining({ supplierRelationId: source.supplier.id, orderId: independent ? null : f.order.id }) }),
      expect.objectContaining({ model: 'AuditLog', id: source.confirmation.id, row: expect.objectContaining({ actorId: f.initiator.id, action: 'confirm_material_return' }) }) ]));
    expect((await sourcePage(f, 'Invoice', {}, invoiceOnly(f.initiator))).body.items.map((row: any) => row.id)).toContain(source.invoice.id);
    expect((await decide(f, command(f, 'negative-payable'), 'approve', invoiceOnly(f.reviewer))).status).toBe(200);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } })).toEqual(source.invoice); expect(await db().materialReturn.findUniqueOrThrow({ where: { id: source.source.id } })).toEqual(source.source);
  });
  it('WFM02 independent PO uses current real Supplier L2 even when header ownership and stale Finance labels suggest access', async () => {
    const f = await fixture('independent-supplier-l2', true, 'Invoice'), foreign = await fixture('foreign-supplier'), source = await nativeSupplierClaimInvoice(f, true);
    // Only synthetic access metadata changes. The business Invoice, real
    // claim/confirmation and native source history remain formed by services.
    await db().invoice.update({ where: { id: source.invoice.id }, data: { ownerId: f.initiator.id } });
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    const invoiceOnly = createAuthService().signToken({ ...f.initiator.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    await db().relation.update({ where: { id: source.supplier.id }, data: { ownerId: foreign.initiator.id, salesRepIds: [] } });
    await denied(f, () => create(f, {}, invoiceOnly), 404, 'NOT_FOUND');
    await db().relation.update({ where: { id: source.supplier.id }, data: { ownerId: f.initiator.id, salesRepIds: [f.reviewer.id] } });
    const created = await create(f, {}, invoiceOnly); expect(created.status, diagnostic(created.body)).toBe(201);
    const fact: any = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } }); expect(fact.detail.sourceSnapshot.origins.orderParents).toEqual([]);
    const context = await createPermissionService({ prisma: db() }).getUserPermissionContext(f.initiator.id); expect(context!.roleIds).not.toContain('role-finance'); expect(context!.scopes).toContain('invoices:write');
  });
  it.each(['amount', 'currency', 'supplier', 'receipt', 'status'] as const)('WFM03 actual MaterialReturn %s damage rejects without replacing approved source history', async field => {
    const f = await fixture('supplier-source-damage-' + field, true, 'Invoice'), source = await nativeSupplierClaimInvoice(f); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } }), body = command(f, 'original-supplier');
    if (field === 'amount') await db().materialReturn.update({ where: { id: source.source.id }, data: { amount: '5.1235' } });
    if (field === 'currency') await db().materialReturn.update({ where: { id: source.source.id }, data: { currency: 'EUR' } });
    if (field === 'supplier') { const foreign = await fixture('damage-supplier'); await db().purchaseOrder.update({ where: { id: source.purchaseOrder.id }, data: { supplierRelationId: foreign.relation.id } }); }
    if (field === 'receipt') { const foreign = await fixture('damage-receipt', true, 'Invoice'), other = await nativeSupplierClaimInvoice(foreign); await db().materialReturn.update({ where: { id: source.source.id }, data: { receiptId: other.receipt.id } }); }
    if (field === 'status') await db().materialReturn.update({ where: { id: source.source.id }, data: { status: 'shipped' } });
    await denied(f, () => decide(f, body), 409, 'CONFLICT'); expect(await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } })).toEqual(fact);
  });
  it.each(['missing', 'damaged', 'duplicate', 'lost-backref'] as const)('WFM04 real confirmation/backref %s cannot be mistaken for manual Invoice absence', async damage => {
    const f = await fixture('supplier-confirmation-' + damage, true, 'Invoice'), source = await nativeSupplierClaimInvoice(f); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } }), body = command(f, 'original-supplier');
    if (damage === 'missing') await db().auditLog.delete({ where: { id: source.confirmation.id } });
    if (damage === 'damaged') await db().auditLog.update({ where: { id: source.confirmation.id }, data: { detail: { ...(source.confirmation.detail as any), before: { status: 'pending' } } } });
    if (damage === 'duplicate') { const other = await fixture('duplicate-supplier-source', true, 'Invoice'), second = await nativeSupplierClaimInvoice(other); await db().materialReturn.update({ where: { id: second.source.id }, data: { claimInvoiceId: source.invoice.id } }); }
    if (damage === 'lost-backref') await db().materialReturn.update({ where: { id: source.source.id }, data: { claimInvoiceId: null } });
    await denied(f, () => decide(f, body), 409, 'CONFLICT'); await denied(f, () => create(f, { clientRequestId: f.id + '-new-source' }), 409, 'CONFLICT');
    expect(await db().auditLog.findUnique({ where: { id: 'WFC_' + f.instance.id } })).toEqual(fact);
  });
  it('WFM05 actual MaterialReturn SQL failure cannot degrade to an unlinked manual Invoice', async () => {
    const f = await fixture('supplier-source-sql', true, 'Invoice'); await nativeSupplierClaimInvoice(f); const fault = sourceReadFault('materialReturn');
    await denied(f, () => create(f, {}, f.initiator.token, application(fault.database)), 503, 'DEPENDENCY_CHECK_FAILED'); expect(fault.observed).toEqual({ injections: 1, code: 'P2010' });
  });
  it('WFM06 actual generic mandatory audit P2003 rolls back workflow while native claim/negative invoice/confirmation stay intact', async () => {
    const f = await fixture('supplier-workflow-audit', true, 'Invoice'), source = await nativeSupplierClaimInvoice(f), fault = auditFault('workflow_create');
    await denied(f, () => create(f, {}, f.initiator.token, application(fault.database)), 500, 'INTERNAL_ERROR');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { status: 'running' } });
    expect(await db().workflowInstance.count({ where: { entityId: source.invoice.id } })).toBe(0);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } })).toEqual(source.invoice); expect(await db().materialReturn.findUniqueOrThrow({ where: { id: source.source.id } })).toEqual(source.source);
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: source.confirmation.id } })).toEqual(source.confirmation);
    expect((await create(f)).status).toBe(201);
  });
  it('WFM07 owned negative Invoice and Supplier never bypass a linked PO foreign Order; missing write ceiling also refuses', async () => {
    const f = await fixture('supplier-linked-order-l2', true, 'Invoice'), foreign = await fixture('linked-order-foreign'), source = await nativeSupplierClaimInvoice(f);
    await db().invoice.update({ where: { id: source.invoice.id }, data: { ownerId: f.initiator.id } }); await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    const invoiceOnly = createAuthService().signToken({ ...f.initiator.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: foreign.relation.id, ownerId: foreign.initiator.id } });
    await denied(f, () => create(f, {}, invoiceOnly), 404, 'NOT_FOUND');
    await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: f.relation.id, ownerId: f.initiator.id } });
    const readOnly = createAuthService().signToken({ ...f.initiator.actor, permissionCeiling: ['invoices:read'] }); await denied(f, () => create(f, {}, readOnly), 403, 'FORBIDDEN');
    const created = await create(f, {}, invoiceOnly); expect(created.status, diagnostic(created.body)).toBe(201);
  });
  it.each([false, true])('WFPI01 native Draft quote→Sent→Accepted→PI resolves exact quote lines and real parents; formal conversion=%s', async formal => {
    const f = await fixture('native-proforma-' + formal, true, 'Invoice'), source = await nativeProformaInvoice(f, formal, formal);
    const invoiceOnly = (user: typeof f.initiator) => createAuthService().signToken({ ...user.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    const created = await create(f, {}, invoiceOnly(f.initiator)); expect(created.status, diagnostic(created.body)).toBe(201);
    const fact: any = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } }), origins = fact.detail.sourceSnapshot.origins;
    expect(origins.orderParents.map((row: any) => row.row.id).sort()).toEqual([f.order.id, ...(formal ? [source.quote.convertedOrderId!] : [])].sort());
    expect(origins.developmentParents.map((row: any) => row.row.id)).toEqual([source.source.id]);
    expect(origins.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'Quotation', id: source.quote.id, row: expect.objectContaining({ status: 'Accepted', totalAmount: '2669', version: 1 }) }),
      ...source.quote.lines.map(line => expect.objectContaining({ model: 'QuotationLine', id: line.id, row: expect.objectContaining({ quotationId: source.quote.id, quantity: line.quantity.toString(), amount: line.amount.toString() }) })),
      expect.objectContaining({ model: 'OrderLine', id: source.orderLine.id }), expect.objectContaining({ model: 'AuditLog', id: source.generation.id }) ]));
    if (formal) expect(origins.records).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'Invoice', id: source.pi.id, row: expect.objectContaining({ type: 'Proforma', status: 'Cancelled' }) }), expect.objectContaining({ model: 'AuditLog', id: source.conversion.id }) ]));
    const candidates = await sourcePage(f, 'Invoice', {}, invoiceOnly(f.initiator)); expect(candidates.status, diagnostic(candidates.body)).toBe(200); expect(candidates.body.items.map((row: any) => row.id)).toContain(source.invoice.id);
    expect((await decide(f, command(f, 'native-pi'), 'approve', invoiceOnly(f.reviewer))).status).toBe(200);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } })).toEqual(source.invoice); expect(await db().invoice.findUniqueOrThrow({ where: { id: source.pi.id } })).toEqual(source.pi);
    expect(await db().quotation.findUniqueOrThrow({ where: { id: source.quote.id }, include: { lines: { orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] } } })).toEqual(source.quote);
  });
  it.each(['total', 'quantity', 'unitPrice', 'amount', 'unit', 'currency', 'version', 'status', 'snapshot'] as const)('WFPI02 current actual quotation or PI snapshot %s drift rejects the old command without rewriting its source fact', async field => {
    const f = await fixture('proforma-drift-' + field, true, 'Invoice'), source = await nativeProformaInvoice(f); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } }), body = command(f, 'original-proforma');
    if (field === 'total') await db().quotation.update({ where: { id: source.quote.id }, data: { totalAmount: '2669.0001' } });
    if (field === 'currency') await db().quotation.update({ where: { id: source.quote.id }, data: { currency: 'EUR' } });
    if (field === 'version') await db().quotation.update({ where: { id: source.quote.id }, data: { version: 2 } });
    if (field === 'status') await db().quotation.update({ where: { id: source.quote.id }, data: { status: 'Sent' } });
    if (['quantity', 'unitPrice', 'amount', 'unit'].includes(field)) await db().quotationLine.update({ where: { id: source.quote.lines[0].id }, data: {
      [field]: ({ quantity: '2000.0001', unitPrice: '1.2346', amount: '2469.0001', unit: 'YD' } as any)[field] } });
    if (field === 'snapshot') { const attachment = source.pi.attachments as any; await db().invoice.update({ where: { id: source.pi.id }, data: { attachments: { ...attachment,
      lines: attachment.lines.map((line: any, index: number) => index === 0 ? { ...line, amount: '2469.0001' } : line) } } }); }
    await denied(f, () => decide(f, body), 409, 'CONFLICT'); expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
    await denied(f, () => create(f, { clientRequestId: f.id + '-new-proforma' }), 409, 'CONFLICT');
    if (field === 'version') {
      // A structurally valid new quote version still cannot silently replace
      // the old running review. Preserve that review through real cancellation.
      const cancel = command(f, 'cancel-old-version', { reason: 'Continue with actual changed source version' }); delete cancel.note;
      expect((await post(f, 'instances/' + f.instance.id + '/cancel', cancel)).status).toBe(200);
      expect((await create(f, { clientRequestId: f.id + '-current-version' })).status).toBe(201);
      expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
    }
  });
  it.each(['missing-generation', 'damaged-generation', 'duplicate-generation', 'missing-conversion', 'damaged-conversion', 'broken-pi-link'] as const)('WFPI03 native formal conversion %s refuses; a copied quote snapshot alone is not an approved source', async damage => {
    const f = await fixture('proforma-history-' + damage, true, 'Invoice'), source = await nativeProformaInvoice(f, true); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    if (damage === 'missing-generation') await db().auditLog.delete({ where: { id: source.generation.id } });
    if (damage === 'damaged-generation') await db().auditLog.update({ where: { id: source.generation.id }, data: { detail: { ...(source.generation.detail as any), before: { quotationId: source.quote.id, quotationNumber: 'Different quote number' } } } });
    if (damage === 'duplicate-generation') { const { createdAt: _createdAt, ...original } = source.generation; await db().auditLog.create({ data: { ...original, id: f.id + '-duplicate-generation', detail: original.detail as any,
      beforeValue: undefined, afterValue: undefined } }); }
    if (damage === 'missing-conversion') await db().auditLog.delete({ where: { id: source.conversion.id } });
    if (damage === 'damaged-conversion') await db().auditLog.update({ where: { id: source.conversion.id }, data: { detail: { ...(source.conversion.detail as any), after: { ...(source.conversion.detail as any).after, amount: '2669.0001' } } } });
    if (damage === 'broken-pi-link') await db().invoice.update({ where: { id: source.invoice.id }, data: { attachments: { ...(source.invoice.attachments as any), proformaInvoiceId: f.entityId } } });
    await denied(f, () => decide(f), 409, 'CONFLICT'); await denied(f, () => create(f, { clientRequestId: f.id + '-new-native-source' }), 409, 'CONFLICT');
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
  });
  it.each(['development', 'order', 'order-line', 'converted-order'] as const)('WFPI04 owned PI/quote and stale Finance role never replace fresh actual %s parent L2', async parent => {
    const f = await fixture('proforma-parent-' + parent, true, 'Invoice'), foreign = await fixture('proforma-foreign-parent'), source = await nativeProformaInvoice(f, false, true);
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    const invoiceOnly = createAuthService().signToken({ ...f.initiator.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    if (parent === 'development') await db().developmentCase.update({ where: { id: source.source.id }, data: { customerRelationId: foreign.relation.id } });
    if (parent === 'order') await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: foreign.relation.id, ownerId: foreign.initiator.id } });
    if (parent === 'converted-order') await db().order.update({ where: { id: source.quote.convertedOrderId! }, data: { customerRelationId: foreign.relation.id, ownerId: foreign.initiator.id } });
    if (parent === 'order-line') { const other = await db().orderLine.create({ data: { id: foreign.id + '-foreign-quote-line', orderId: foreign.order.id, lineNumber: 1, description: 'Foreign actual line', quantity: '2000', unit: 'M' } });
      await db().quotation.update({ where: { id: source.quote.id }, data: { orderLineId: other.id } }); }
    await denied(f, () => create(f, {}, invoiceOnly), 404, 'NOT_FOUND');
    const candidates = await sourcePage(f, 'Invoice', {}, invoiceOnly); expect(candidates.status).toBe(200); expect(candidates.body.items.map((row: any) => row.id)).not.toContain(source.invoice.id);
    if (parent === 'development') await db().developmentCase.update({ where: { id: source.source.id }, data: { customerRelationId: f.relation.id } });
    if (parent === 'order') await db().order.update({ where: { id: f.order.id }, data: { customerRelationId: f.relation.id, ownerId: f.initiator.id } });
    if (parent === 'converted-order') await db().order.update({ where: { id: source.quote.convertedOrderId! }, data: { customerRelationId: f.relation.id, ownerId: f.initiator.id } });
    if (parent === 'order-line') await db().quotation.update({ where: { id: source.quote.id }, data: { orderLineId: source.orderLine.id } });
    expect((await create(f, {}, invoiceOnly)).status).toBe(201);
  });
  it('WFPI05 actual Quotation SQL failure never degrades PI into a manual Invoice', async () => {
    const f = await fixture('proforma-source-sql', true, 'Invoice'); await nativeProformaInvoice(f); const fault = sourceReadFault('quotation');
    await denied(f, () => create(f, {}, f.initiator.token, application(fault.database)), 503, 'DEPENDENCY_CHECK_FAILED'); expect(fault.observed).toEqual({ injections: 1, code: 'P2010' });
  });
  it('WFPI06 actual workflow audit P2003 rolls back while native PI/quote/converted history remain untouched', async () => {
    const f = await fixture('proforma-mandatory-audit', true, 'Invoice'), source = await nativeProformaInvoice(f, true), fault = auditFault('workflow_create');
    await denied(f, () => create(f, {}, f.initiator.token, application(fault.database)), 500, 'INTERNAL_ERROR'); expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { status: 'running' } });
    expect(await db().workflowInstance.count({ where: { entityId: source.invoice.id } })).toBe(0);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } })).toEqual(source.invoice); expect(await db().invoice.findUniqueOrThrow({ where: { id: source.pi.id } })).toEqual(source.pi);
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: source.generation.id } })).toEqual(source.generation); expect(await db().auditLog.findUniqueOrThrow({ where: { id: source.conversion.id } })).toEqual(source.conversion);
    expect((await create(f)).status).toBe(201);
  });
  it('WFPI07 revoked actual team grant rejects PI even when the legacy quotation read cache still contains the customer', async () => {
    const f = await fixture('proforma-fresh-team', true, 'Invoice'), foreign = await fixture('proforma-team-foreign'); await nativeProformaInvoice(f);
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } }); await db().relation.update({ where: { id: f.relation.id }, data: { ownerId: foreign.initiator.id, salesRepIds: [] } });
    const team = await db().team.create({ data: { id: f.id + '-shared-team', name: 'Synthetic current grant team' } });
    await db().teamMember.create({ data: { id: f.id + '-team-member', teamId: team.id, userId: f.initiator.id } });
    const grant = await db().teamDataGrant.create({ data: { id: f.id + '-team-grant', teamId: team.id, entityType: 'relation', entityId: f.relation.id, grantedBy: foreign.initiator.id, permission: 'read+followup' } });
    const share = createTeamShareService(db()); expect(await share.getActiveGrantedRelationIds(f.initiator.id)).toContain(f.relation.id);
    const invoiceOnly = createAuthService().signToken({ ...f.initiator.actor, permissionCeiling: ['invoices:read', 'invoices:write'] }); expect((await create(f, {}, invoiceOnly)).status).toBe(201);
    await db().teamDataGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), revokedBy: foreign.initiator.id, revokeReason: 'Synthetic current revocation control' } });
    expect(await share.getActiveGrantedRelationIds(f.initiator.id)).toContain(f.relation.id); expect(await share.getActiveGrantedRelationIds(f.initiator.id, { fresh: true })).not.toContain(f.relation.id);
    await denied(f, () => create(f, { clientRequestId: f.id + '-after-revocation' }, invoiceOnly), 404, 'NOT_FOUND');
  });
  it('WFPI08 actual PI Draft→Issued→native conversion keeps the recorded before status and quote provenance', async () => {
    const f = await fixture('proforma-issued-conversion', true, 'Invoice'), source = await nativeProformaInvoice(f);
    const issued = await updateInvoice({ prisma: db(), invoiceId: source.pi.id, actorId: f.initiator.id, input: { status: 'Issued' } });
    expect(issued.ok, diagnostic(issued)).toBe(true);
    const converted = await createProformaInvoiceService(db()).convertToReceivable(source.pi.id, { issueDate: '2026-10-01' }, f.initiator.id);
    expect(converted.ok, diagnostic(converted)).toBe(true); if (!converted.ok) throw Error('Actual Issued PI conversion failed'); f.entityId = converted.data.id;
    const audit = await db().auditLog.findFirstOrThrow({ where: { targetType: 'Invoice', targetId: f.entityId, action: 'convert_proforma_to_receivable' } });
    expect((audit.detail as any).before.proformaStatus).toBe('Issued'); expect((await create(f)).status).toBe(201); expect((await decide(f)).status).toBe(200);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: source.pi.id } })).toMatchObject({ status: 'Cancelled', type: 'Proforma' });
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: source.generation.id } })).toEqual(source.generation);
  });
  it.each(['40001', '40P01'] as const)('WFL313 actual PostgreSQL source %s remains a retryable conflict with no workflow writes', async sqlState => {
    const f = await fixture('ioa-source-concurrency-' + sqlState, true, 'Invoice');
    await nativeBatchInvoice(f); const fault = sourceReadFault('orderShipmentBatch', sqlState);
    await denied(f, () => create(f, {}, f.initiator.token, application(fault.database)), 409, 'CONFLICT');
    expect(fault.observed).toEqual({ injections: 1, code: 'P2010', sqlState });
    expect(await db().workflowInstance.count({ where: { entityId: f.entityId } })).toBe(0);
    expect((await create(f)).status).toBe(201);
  });
  it('WFL312 actual native batch source rows can be read and locked using the private generated PostgreSQL client', async () => {
    const f = await fixture('ioa-native-row-contract', true, 'Invoice'), source = await nativeBatchInvoice(f, 'unassigned');
    // Storage/schema contract only. Current actor/L2 and command atomicity are
    // independently exercised through the native workflow HTTP cases below.
    await db().$transaction(async tx => {
      const graph = await loadWorkflowInvoiceSource(tx, source.invoice, [], source.attachments, {
        order: async id => ({ row: await tx.order.findUniqueOrThrow({ where: { id } }), lines: await tx.orderLine.findMany({ where: { orderId: id } }) }),
        customer: id => tx.relation.findUniqueOrThrow({ where: { id } }),
        development: async () => { throw Error('Unexpected development source in native batch storage contract'); },
        reject: (code, message) => { throw Object.assign(Error(message), { code }); },
      });
      expect(graph.records.map(row => row.model)).toContain('OrderShipmentBatch');
      await lockWorkflowInvoiceSource(tx, graph, {
        order: async () => null, customer: async () => null, development: async () => null,
        reject: (code, message) => { throw Object.assign(Error(message), { code }); },
      });
    });
  });
  it.each(['planned', 'unassigned', 'legacy-shipment', 'whole', 'consolidated', 'whole-consolidated'] as const)('WFL301 native %s IOA source resolves real batch/Shipment/SOA/OrderLine without an all-must-Shipped rule', async kind => {
    const f = await fixture('ioa-positive-' + kind, true, 'Invoice'), source = await nativeBatchInvoice(f, kind), created = await create(f);
    expect(created.status, diagnostic(created.body)).toBe(201);
    const fact: any = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } }), origins = fact.detail.sourceSnapshot.origins;
    expect(origins.records).toEqual(expect.arrayContaining(source.attachments.map(attachment => expect.objectContaining({ model: 'InvoiceOrderAllocation', id: attachment.id,
      row: expect.objectContaining({ invoiceId: source.invoice.id, orderId: attachment.orderId, batchId: attachment.batchId }) }))));
    expect(origins.records).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'OrderLine', id: source.line.id, row: expect.objectContaining({ quantity: '10', unit: 'M' }) })]));
    if (source.batch) expect(origins.records).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'OrderShipmentBatch', id: source.batch.id,
      row: expect.objectContaining({ status: 'planned', shipmentId: source.shipment?.id || null, currency: 'USD', amount: '12.9999' }) })]));
    if (source.shipment) expect(origins.records).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'Shipment', id: source.shipment.id, row: expect.objectContaining({ status: 'Booked' }) })]));
    if (source.allocation) expect(origins.records).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'ShipmentOrderAllocation', id: source.allocation.id,
      row: expect.objectContaining({ status: 'Planned', orderLineId: source.line.id, plannedQty: '4', actualQty: null }) })]));
    if (kind.startsWith('whole')) for (const attachment of source.attachments) expect(attachment).toMatchObject({ batchId: null, allocatedAmount: null });
    if (kind === 'whole-consolidated') expect(origins.orderParents.map((parent: any) => parent.row.id).sort()).toEqual([f.order.id, source.otherOrder.id].sort());
    if (kind === 'consolidated') {
      expect(origins.orderParents.map((parent: any) => parent.row.id).sort()).toEqual([f.order.id, source.otherOrder.id].sort());
      expect(origins.records).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'ShipmentOrderAllocation', id: source.otherAllocation.id }), expect.objectContaining({ model: 'OrderLine', id: source.otherLine.id })]));
    }
    expect((await decide(f)).status).toBe(200);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } })).toEqual(source.invoice);
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: source.invoiceAudit.id } })).toEqual(source.invoiceAudit);
  });
  it.each(['batch-amount', 'batch-status', 'batch-currency', 'batch-customer', 'allocated-amount', 'line-quantity', 'line-spec', 'soa-quantity', 'soa-unit'] as const)(
    'WFL302 real current %s change cannot reuse or replace the old running source fact', async field => {
    const f = await fixture('ioa-drift-' + field, true, 'Invoice'), source = await nativeBatchInvoice(f); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } }), original = command(f, 'old-ioa');
    // Native legal edits use their actual services. Other cases below are
    // explicit corruptions AFTER native formation, never a seeded approval.
    if (field === 'batch-amount') { const changed = await source.batches.updateBatch(source.batch.id, { amount: 13.0001 }, f.initiator.id); expect(changed.ok, diagnostic(changed)).toBe(true); }
    if (field === 'batch-status') { const changed = await source.batches.updateBatch(source.batch.id, { status: 'cancelled' }, f.initiator.id); expect(changed.ok, diagnostic(changed)).toBe(true); }
    if (field === 'batch-currency') await db().orderShipmentBatch.update({ where: { id: source.batch.id }, data: { currency: 'EUR' } });
    if (field === 'batch-customer') { const foreign = await fixture('ioa-other-customer'); await db().orderShipmentBatch.update({ where: { id: source.batch.id }, data: { customerRelationId: foreign.relation.id } }); }
    if (field === 'allocated-amount') await db().invoiceOrderAllocation.update({ where: { id: source.attachments[0].id }, data: { allocatedAmount: '13.0001' } });
    if (field === 'line-quantity') await db().orderLine.update({ where: { id: source.line.id }, data: { quantity: '10.0001' } });
    if (field === 'line-spec') await db().orderLine.update({ where: { id: source.line.id }, data: { materialCode: f.id + '-changed-material' } });
    if (field === 'soa-quantity' || field === 'soa-unit') { const changed = await source.shipping.updateAllocation(source.shipment.id, source.allocation.id,
      field === 'soa-quantity' ? { plannedQty: 5 } : { unit: 'YD' }, f.initiator.id); expect(changed.ok, diagnostic(changed)).toBe(true); }
    await denied(f, () => decide(f, original), 409, 'CONFLICT'); await denied(f, () => create(f, { clientRequestId: f.id + '-replace-running' }), 409, 'CONFLICT');
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
    if (['batch-amount', 'allocated-amount', 'line-quantity', 'line-spec', 'soa-quantity', 'soa-unit'].includes(field)) {
      const cancelled = command(f, 'cancel-stale-running', { reason: 'Continue using current native source; retain old review' }); delete cancelled.note;
      expect((await post(f, 'instances/' + f.instance.id + '/cancel', cancelled)).status).toBe(200);
      expect((await create(f, { clientRequestId: f.id + '-current-source' })).status).toBe(201);
      expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
    }
  });
  it.each(['missing-batch', 'deleted-batch', 'deleted-shipment', 'deleted-order', 'missing-line'] as const)(
    'WFL303 native IOA %s cannot degrade into a header-only manual source', async damage => {
    const f = await fixture('ioa-missing-' + damage, true, 'Invoice'), source = await nativeBatchInvoice(f); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    if (damage === 'missing-batch') {
      // batchId is a nullable snapshot reference, not a database FK. Deliberate
      // post-formation corruption must be refused by the real source resolver.
      const corrupted = await db().invoiceOrderAllocation.update({ where: { id: source.attachments[0].id }, data: { batchId: f.id + '-nonexistent-batch' } });
      expect(corrupted.batchId).toBe(f.id + '-nonexistent-batch');
    }
    if (damage === 'deleted-batch') await db().orderShipmentBatch.update({ where: { id: source.batch.id }, data: { deletedAt: BigInt(Date.now()) } });
    if (damage === 'deleted-shipment') await db().shipment.update({ where: { id: source.shipment.id }, data: { deletedAt: BigInt(Date.now()) } });
    if (damage === 'deleted-order') await db().order.update({ where: { id: f.order.id }, data: { deletedAt: BigInt(Date.now()) } });
    if (damage === 'missing-line') await db().shipmentOrderAllocation.update({ where: { id: source.allocation.id }, data: { orderLineId: f.id + '-missing-line' } });
    await denied(f, () => decide(f), 404, 'NOT_FOUND'); expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
  });
  it.each(['cancelled-shipment', 'cancelled-soa', 'cross-order-batch', 'cross-order-line', 'foreign-shipment', 'duplicate-null-soa'] as const)(
    'WFL304 actual %s cannot manufacture a valid invoice/batch/order association', async damage => {
    const f = await fixture('ioa-affinity-' + damage, true, 'Invoice'), source = await nativeBatchInvoice(f), other = await fixture('ioa-affinity-other');
    const otherLine = await db().orderLine.create({ data: { id: other.id + '-foreign-line', orderId: other.order.id, lineNumber: 1, quantity: '10', unit: 'M' } });
    expect((await create(f)).status).toBe(201); const fact = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    if (damage === 'cancelled-shipment') await db().shipment.update({ where: { id: source.shipment.id }, data: { status: 'Cancelled' } });
    if (damage === 'cancelled-soa') { const changed = await source.shipping.updateAllocation(source.shipment.id, source.allocation.id, { status: 'Cancelled' }, f.initiator.id); expect(changed.ok, diagnostic(changed)).toBe(true); }
    if (damage === 'cross-order-batch') await db().orderShipmentBatch.update({ where: { id: source.batch.id }, data: { orderId: other.order.id } });
    if (damage === 'cross-order-line') await db().shipmentOrderAllocation.update({ where: { id: source.allocation.id }, data: { orderLineId: otherLine.id } });
    if (damage === 'foreign-shipment') {
      const created = await createShipment({ prisma: db(), actorId: other.initiator.id, input: { id: other.id + '-shipment', shipmentNumber: other.id + '-shipment', orderId: other.order.id, type: 'Export', status: 'Booked', shippingMethod: 'Sea' } });
      expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok || !created.data) throw Error('Actual foreign Booked shipment rejected');
      const changed = await source.batches.updateBatch(source.batch.id, { shipmentId: created.data.shipment.id }, f.initiator.id); expect(changed.ok, diagnostic(changed)).toBe(true);
    }
    if (damage === 'duplicate-null-soa') {
      // Actual PostgreSQL's nullable unique tuple cannot prevent two null-line
      // rows. Deliberately damage native history to verify graph refusal.
      await db().shipmentOrderAllocation.update({ where: { id: source.allocation.id }, data: { orderLineId: null } });
      const original = await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: source.allocation.id } });
      await db().shipmentOrderAllocation.create({ data: { ...original, id: f.id + '-duplicate-null-soa' } });
    }
    await denied(f, () => decide(f), 409, 'CONFLICT'); await denied(f, () => create(f, { clientRequestId: f.id + '-damaged-source' }), 409, 'CONFLICT');
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
  });
  it('WFL305 native allocation addition/deletion changes source scope and retains its original review history', async () => {
    const f = await fixture('ioa-allocation-edit', true, 'Invoice'), source = await nativeBatchInvoice(f, 'consolidated'); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    const removed = await source.shipping.deleteAllocation(source.shipment.id, source.otherAllocation.id, f.initiator.id); expect(removed.ok, diagnostic(removed)).toBe(true);
    await denied(f, () => decide(f, command(f, 'removed-source')), 409, 'CONFLICT');
    const added = await source.shipping.createAllocation(source.shipment.id, { orderId: source.otherOrder.id, orderLineId: source.otherLine.id, plannedQty: 3, unit: 'M' }, f.initiator.id);
    expect(added.ok, diagnostic(added)).toBe(true); await denied(f, () => decide(f, command(f, 'added-source')), 409, 'CONFLICT');
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
    const cancelled = command(f, 'cancel-edited-source', { reason: 'New real allocation requires a new workflow review' }); delete cancelled.note;
    expect((await post(f, 'instances/' + f.instance.id + '/cancel', cancelled)).status).toBe(200); expect((await create(f, { clientRequestId: f.id + '-new-allocations' })).status).toBe(201);
  });
  it.each(['primary', 'co-order'] as const)('WFL306 owned Invoice and cached finance identity cannot bypass the current %s Order L2', async parent => {
    const f = await fixture('ioa-fresh-' + parent, true, 'Invoice'), source = await nativeBatchInvoice(f, 'consolidated'), other = await fixture('ioa-hidden-parent');
    await db().userRole.deleteMany({ where: { userId: f.initiator.id, roleId: 'role-finance' } });
    const actor = createAuthService().signToken({ ...f.initiator.actor, permissionCeiling: ['invoices:read', 'invoices:write'] });
    const orderId = parent === 'primary' ? f.order.id : source.otherOrder.id;
    await db().order.update({ where: { id: orderId }, data: { customerRelationId: other.relation.id, ownerId: other.initiator.id } });
    await denied(f, () => create(f, {}, actor), 404, 'NOT_FOUND');
    const page = await sourcePage(f, 'Invoice', {}, actor); expect(page.status).toBe(200); expect(page.body.items.map((item: any) => item.id)).not.toContain(source.invoice.id);
    await db().order.update({ where: { id: orderId }, data: { customerRelationId: f.relation.id, ownerId: f.initiator.id } }); expect((await create(f, {}, actor)).status).toBe(201);
  });
  it.each(['orderShipmentBatch', 'shipmentOrderAllocation'] as const)('WFL307 actual %s SQL failure cannot return a false empty/manual source', async delegate => {
    const f = await fixture('ioa-sql-' + delegate, true, 'Invoice'); await nativeBatchInvoice(f); const fault = sourceReadFault(delegate);
    await denied(f, () => create(f, {}, f.initiator.token, application(fault.database)), 503, 'DEPENDENCY_CHECK_FAILED'); expect(fault.observed).toEqual({ injections: 1, code: 'P2010' });
  });
  it('WFL308 mandatory workflow audit P2003 rolls back the review without changing native invoice/batch/shipping facts', async () => {
    const f = await fixture('ioa-mandatory-audit', true, 'Invoice'), source = await nativeBatchInvoice(f), fault = auditFault('workflow_create');
    const current = { invoice: await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } }), batch: await db().orderShipmentBatch.findUniqueOrThrow({ where: { id: source.batch.id } }),
      shipment: await db().shipment.findUniqueOrThrow({ where: { id: source.shipment.id } }), allocation: await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: source.allocation.id } }),
      invoiceAudit: await db().auditLog.findUniqueOrThrow({ where: { id: source.invoiceAudit.id } }) };
    await denied(f, () => create(f, {}, f.initiator.token, application(fault.database)), 500, 'INTERNAL_ERROR'); expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { status: 'running' } });
    expect(await db().invoice.findUniqueOrThrow({ where: { id: source.invoice.id } })).toEqual(current.invoice); expect(await db().orderShipmentBatch.findUniqueOrThrow({ where: { id: source.batch.id } })).toEqual(current.batch);
    expect(await db().shipment.findUniqueOrThrow({ where: { id: source.shipment.id } })).toEqual(current.shipment); expect(await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: source.allocation.id } })).toEqual(current.allocation);
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: source.invoiceAudit.id } })).toEqual(current.invoiceAudit); expect((await create(f)).status).toBe(201);
  });

  it('WFL309 actual native batch settlement-cache recalculation does not invalidate an unchanged invoice/source review', async () => {
    const f = await fixture('ioa-derived-recalculation', true, 'Invoice'), source = await nativeBatchInvoice(f); expect((await create(f)).status).toBe(201);
    const fact: any = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } }), saved = fact.detail.sourceSnapshot.origins.records.find((row: any) => row.model === 'OrderShipmentBatch').row;
    for (const key of ['invoicedAmount', 'paidAmount', 'settleStatus', 'settledAt', 'updatedAt']) expect(saved).not.toHaveProperty(key);
    expect(saved).toMatchObject({ id: source.batch.id, status: 'planned', amount: '12.9999', currency: 'USD', orderId: f.order.id, shipmentId: source.shipment.id });
    const recalculated = await source.batches.recalcSettlement(source.batch.id); expect(recalculated.ok, diagnostic(recalculated)).toBe(true);
    expect(await db().orderShipmentBatch.findUniqueOrThrow({ where: { id: source.batch.id } })).toMatchObject({ status: 'planned', currency: 'USD' });
    expect((await decide(f)).status).toBe(200); expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
  });
  it('WFL310 actual native Receipt and allocation change the invoice financial source despite excluded batch payment caches', async () => {
    const f = await fixture('ioa-current-payment-fact', true, 'Invoice'), source = await nativeBatchInvoice(f);
    const issued = await updateInvoice({ prisma: db(), invoiceId: source.invoice.id, actorId: f.initiator.id, input: { status: 'Issued' } }); expect(issued.ok, diagnostic(issued)).toBe(true);
    expect((await create(f)).status).toBe(201); const fact = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    // Real domain persistence with synthetic recorded payment facts. This is
    // not a bank verification, front-end or finance HTTP authority proof.
    const created = await createPaymentVoucher({ prisma: db(), actorId: f.initiator.id, input: { type: 'Receipt', currency: 'USD', amount: '1.2345', paymentDate: '2026-10-01', paymentMethod: 'TT',
      customerRelationId: f.relation.id, customerName: f.relation.name, attachments: { paymentReference: f.id + '-synthetic-bank-reference' } } });
    expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok || !created.data) throw Error('Native receipt rejected');
    const voucherId = created.data.voucher.id;
    const allocated = await db().$transaction(tx => applyAllocation(db(), tx, { invoiceId: source.invoice.id, voucherId, appliedAmount: '1.2345', appliedDate: '2026-10-01', actorId: f.initiator.id, source: 'acceptance:native-ioa-allocation' }));
    expect(allocated.newInvoiceStatus).toBe('PartiallyPaid'); await denied(f, () => decide(f), 409, 'CONFLICT');
    const cancelled = command(f, 'cancel-after-payment', { reason: 'Recorded payment changed actual source' }); delete cancelled.note;
    expect((await post(f, 'instances/' + f.instance.id + '/cancel', cancelled)).status).toBe(200); expect((await create(f, { clientRequestId: f.id + '-after-payment' })).status).toBe(201);
    const next: any = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    expect(next.detail.sourceSnapshot.origins.records).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'InvoiceAllocation', id: allocated.allocationId,
      row: expect.objectContaining({ invoiceId: source.invoice.id, voucherId, appliedAmount: '1.2345' }) })]));
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact); expect((await decide(f, command(f, 'approve-current-payment'))).status).toBe(200);
  });

  it.each(['customer', 'business-line'] as const)('WFL311 real consolidated Shipment %s change rejects the old and new source without losing the original audit', async field => {
    const f = await fixture('ioa-consolidated-affinity-' + field, true, 'Invoice'), source = await nativeBatchInvoice(f, 'consolidated'); expect((await create(f)).status).toBe(201);
    const fact = await db().auditLog.findUniqueOrThrow({ where: { id: 'WFC_' + f.instance.id } });
    // Post-formation damage of actual persisted parent content. Native SOA
    // creation itself checks same customer/businessLine; no bad final source
    // is hand-seeded for a passing workflow.
    if (field === 'customer') { const other = await fixture('ioa-consolidated-foreign'); await db().order.update({ where: { id: source.otherOrder.id }, data: { customerRelationId: other.relation.id } }); }
    else await db().order.update({ where: { id: source.otherOrder.id }, data: { businessLine: 'garment' } });
    await denied(f, () => decide(f), 409, 'CONFLICT'); await denied(f, () => create(f, { clientRequestId: f.id + '-bad-consolidated-source' }), 409, 'CONFLICT');
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: fact.id } })).toEqual(fact);
  });

});
