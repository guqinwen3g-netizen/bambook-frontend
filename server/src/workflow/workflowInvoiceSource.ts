/** Read actual Invoice header and line source chains. No Invoice.devCase field,
 * name/notes inference, native state transition or extra pricing grant. */
import { Prisma } from '@prisma/client';
import { proformaSourceOrderId } from '../finance/proformaSourceOrder';
import { VALID_INVOICE_STATUS } from '../statusTransition';
import { findAllocationCustomerViolation } from '../finance/allocationCustomerGuard';
import { assertDevelopmentBillingCoverageCurrentInTx } from '../development/developmentBillingCoverageService';
import { summarizeOrderCommission, commissionPayableAnchorQuery, commissionPayableAnchorSequence } from '../pricing/commissionPayableService';

type Model = 'Order' | 'DevelopmentCase' | 'Relation' | 'BillingItem' | 'CostRecord' | 'Sample' | 'SampleBatch' | 'SealSample' | 'OrderLine' | 'Shipment'
  | 'DevelopmentExpenseReview' | 'DevelopmentLifecycleEvent' | 'BillingItemCostCoverage'
  | 'PurchaseServiceDelivery' | 'PurchaseOrder' | 'PurchaseLine' | 'PricingCalculation' | 'CommissionRule' | 'Invoice' | 'CommissionPayable'
  | 'MaterialReceipt' | 'MaterialReturn' | 'AuditLog' | 'Quotation' | 'QuotationLine'
  | 'OrderShipmentBatch' | 'ShipmentOrderAllocation' | 'InvoiceOrderAllocation' | 'InvoiceAllocation' | 'CreditNoteAllocation';
export type WorkflowInvoiceSourceGraph = { records: Array<{ model: Model; id: string; row: any }>;
  orderParents: any[]; developmentParents: any[]; bindings: Array<{ model: Model; id: string }> };
export type WorkflowInvoiceParents = {
  order(id: string): Promise<any>;
  development(id: string): Promise<any>;
  customer(id: string): Promise<any>;
  reject(code: 'CONFLICT' | 'NOT_FOUND', message: string, status: number): never;
};
const MODELS: Record<Model, string> = { Order: 'order', DevelopmentCase: 'developmentCase', BillingItem: 'billingItem', CostRecord: 'costRecord',
  Sample: 'sample', SampleBatch: 'sampleBatch', SealSample: 'sealSample', OrderLine: 'orderLine', Shipment: 'shipment', Relation: 'relation',
  DevelopmentExpenseReview: 'developmentExpenseReview', DevelopmentLifecycleEvent: 'developmentLifecycleEvent', BillingItemCostCoverage: 'billingItemCostCoverage',
  PurchaseServiceDelivery: 'purchaseServiceDelivery', PurchaseOrder: 'purchaseOrder', PurchaseLine: 'purchaseLine', PricingCalculation: 'pricingCalculation', CommissionRule: 'commissionRule', Invoice: 'invoice', CommissionPayable: '',
  MaterialReceipt: 'materialReceipt', MaterialReturn: 'materialReturn', AuditLog: 'auditLog', Quotation: 'quotation', QuotationLine: 'quotationLine',
  OrderShipmentBatch: 'orderShipmentBatch', ShipmentOrderAllocation: 'shipmentOrderAllocation', InvoiceOrderAllocation: 'invoiceOrderAllocation', InvoiceAllocation: 'invoiceAllocation', CreditNoteAllocation: 'creditNoteAllocation' };
// Native commission summarization deliberately reads all order pricing rows,
// including soft-deleted ones. Capture the same facts rather than silently
// defining a different liability policy for the generic workflow.
const WITHOUT_SOFT_DELETE = new Set<Model>(['OrderLine', 'DevelopmentExpenseReview', 'DevelopmentLifecycleEvent', 'BillingItemCostCoverage', 'PurchaseServiceDelivery', 'PurchaseLine', 'PricingCalculation', 'MaterialReceipt', 'AuditLog', 'QuotationLine', 'ShipmentOrderAllocation', 'InvoiceAllocation', 'CreditNoteAllocation']);
const INTERNAL_MODELS = new Set<Model>(['Relation', 'DevelopmentExpenseReview', 'DevelopmentLifecycleEvent', 'BillingItemCostCoverage', 'PurchaseOrder', 'PurchaseLine', 'PricingCalculation', 'CommissionRule', 'Invoice', 'MaterialReceipt', 'MaterialReturn', 'AuditLog', 'Quotation', 'QuotationLine', 'OrderShipmentBatch', 'ShipmentOrderAllocation', 'InvoiceOrderAllocation', 'InvoiceAllocation', 'CreditNoteAllocation']);
// Parent roots precede child source records and finally the Invoice in caller.
// Deterministic locks plus serializable conflict handling avoid committing from
// a changed source graph, including concurrent line additions/parent changes.
const ORDER: Model[] = ['Order', 'DevelopmentCase', 'Relation', 'SampleBatch', 'Sample', 'SealSample', 'OrderLine', 'Shipment', 'BillingItem', 'CostRecord',
  'DevelopmentLifecycleEvent', 'DevelopmentExpenseReview', 'BillingItemCostCoverage', 'MaterialReceipt', 'MaterialReturn', 'AuditLog',
  'PurchaseServiceDelivery', 'PurchaseOrder', 'PurchaseLine', 'PricingCalculation', 'CommissionRule', 'Quotation', 'QuotationLine', 'OrderShipmentBatch', 'ShipmentOrderAllocation', 'Invoice', 'InvoiceOrderAllocation', 'InvoiceAllocation', 'CreditNoteAllocation', 'CommissionPayable'];
export async function loadWorkflowInvoiceSource(db: any, invoice: any, lines: any[], attachments: any[], parents: WorkflowInvoiceParents): Promise<WorkflowInvoiceSourceGraph> {
  const records = new Map<string, { model: Model; id: string; row: any }>(), orders = new Map<string, any>(), developments = new Map<string, any>();
  const visiting = new Set<string>();
  const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value === value.trim();
  function missing(): never { return parents.reject('NOT_FOUND', '发票来源不存在、已删除或无权访问，请核对原单', 404); }
  async function visit(type: unknown, id: unknown, allowManual = false, depth = 0, internal = false): Promise<void> {
    if (depth > 50) parents.reject('CONFLICT', '发票来源链过长或形成循环，请核对原单', 409);
    if (allowManual && type === 'Manual') { if (!identifier(id)) missing(); return; }
    // Scene is a real native composite source, never an entity/table name.
    // Resolve only the four native scene contracts and still traverse every
    // actual CostRecord InvoiceLine below (not an inferred title/description).
    if (type === 'Scene') {
      if (!identifier(id)) missing();
      const split = id.indexOf(':'), scene = id.slice(0, split), sourceId = id.slice(split + 1);
      const root = ({ dev_cost: 'DevelopmentCase', fabric: 'DevelopmentCase', sample: 'Sample', order: 'Order' } as Record<string, Model>)[scene];
      if (split < 1 || !root || !identifier(sourceId)) parents.reject('CONFLICT', '场景发票来源不能准确核对，请核对原单', 409);
      await visit(root, sourceId, false, depth + 1); return;
    }
    if (type === 'CommissionPayable') {
      if (!identifier(id)) missing();
      const split = id.lastIndexOf('#'), orderId = id.slice(0, split), sequence = id.slice(split + 1);
      if (split < 1 || orderId.includes('#') || !/^[1-9]\d*$/.test(sequence) || !Number.isSafeInteger(Number(sequence))
        || invoice.orderId !== orderId || invoice.type !== 'Payable' || invoice.currency !== 'USD' || new Prisma.Decimal(invoice.amount).lte(0)) parents.reject('CONFLICT', '佣金应付缺少准确订单与原生序号来源，请核对原单', 409);
      await visit('Order', orderId, false, depth + 1);
      const key = `CommissionPayable:${id}`; if (records.has(key)) return;
      // Project only facts needed by the native commission liability. Reading
      // a full pricing row here would unnecessarily capture profit/tax/cost.
      const pricing = await db.pricingCalculation.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true, orderId: true, status: true,
        commissionAmount: true, quantity: true, commissionRuleId: true, commissionRate: true, deletedAt: true } });
      const ruleIds = [...new Set<string>(pricing.map((row: any) => row.commissionRuleId).filter((value: any) => identifier(value)))].sort();
      const rules = ruleIds.length ? await db.commissionRule.findMany({ where: { id: { in: ruleIds }, deletedAt: null }, orderBy: { id: 'asc' } }) : [];
      for (const row of pricing) records.set(`PricingCalculation:${row.id}`, { model: 'PricingCalculation', id: row.id, row });
      for (const row of rules) {
        records.set(`CommissionRule:${row.id}`, { model: 'CommissionRule', id: row.id, row });
        if (row.intermediaryRelationId) await visit('Relation', row.intermediaryRelationId, false, depth + 1, true);
      }
      const summary = summarizeOrderCommission({ orderId, rows: pricing, rulesById: new Map(rules.map((row: any) => [row.id, row])) });
      if (!summary.intermediaryRelationId || summary.intermediaryRelationId !== invoice.customerRelationId) parents.reject('CONFLICT', '佣金应付收款主体与真实佣金规则不一致，请核对原单', 409);
      // Native amounts can be incremental (total minus earlier invoices).
      // Preserve all actual invoice anchors, including cancelled history, but
      // do not invent amount==current total for each individual document.
      const anchors = await db.invoice.findMany({ where: { type: 'Payable', sourceType: 'CommissionPayable', ...commissionPayableAnchorQuery(orderId) }, orderBy: { id: 'asc' },
        select: { id: true, type: true, sourceType: true, sourceId: true, orderId: true, customerRelationId: true, amount: true, currency: true, status: true, deletedAt: true, issueDate: true } });
      if (anchors.some((row: any) => commissionPayableAnchorSequence(orderId, row) === null)
        || anchors.filter((row: any) => row.sourceId === id && row.id === invoice.id).length !== 1) parents.reject('CONFLICT', '佣金应付历史序号或订单关联不能准确核对，请核对原单', 409);
      for (const row of anchors) records.set(`Invoice:${row.id}`, { model: 'Invoice', id: row.id, row });
      records.set(key, { model: 'CommissionPayable', id, row: { id, orderId, sequence: Number(sequence), summary } }); return;
    }
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(MODELS, type)) parents.reject('CONFLICT', '发票来源类型尚不能准确核对，不能继续此工作流', 409);
    if (!identifier(id)) missing();
    const model = type as Model, key = `${model}:${id}`;
    if (INTERNAL_MODELS.has(model) && !internal) parents.reject('CONFLICT', '发票来源类型尚不能准确核对，不能继续此工作流', 409);
    if (visiting.has(key)) parents.reject('CONFLICT', '发票来源链存在循环，请核对原单', 409);
    if (records.has(key)) return;
    visiting.add(key);
    const row = await db[MODELS[model]].findFirst({ where: { id, ...(!WITHOUT_SOFT_DELETE.has(model) ? { deletedAt: null } : {}) } });
    if (!row) missing();
    // Native recalcSettlement (orderShipmentBatchService:420–513) only
    // rewrites these derived cache columns. They are not payment authority;
    // current InvoiceAllocation / CreditNoteAllocation facts are read below.
    const snapshotRow = model === 'OrderShipmentBatch' ? Object.fromEntries(Object.entries(row)
      .filter(([field]) => !['invoicedAmount', 'paidAmount', 'settleStatus', 'settledAt', 'updatedAt'].includes(field))) : row;
    records.set(key, { model, id, row: snapshotRow });
    if (model === 'Order') {
      const parent = await parents.order(id); orders.set(id, parent);
      // Every current line already participates in the Order snapshot. Lock
      // those exact rows as well; do not recurse through its bidirectional FK.
      for (const line of parent.lines) records.set(`OrderLine:${line.id}`, { model: 'OrderLine', id: line.id, row: line });
    }
    else if (model === 'DevelopmentCase') developments.set(id, await parents.development(id));
    else if (model === 'Relation') await parents.customer(id);
    else if (model === 'BillingItem' || model === 'CostRecord') {
      await visit(row.sourceType, row.sourceId, false, depth + 1);
      if (model === 'BillingItem' && row.costRecordId) await visit('CostRecord', row.costRecordId, false, depth + 1);
      if (model === 'BillingItem' && row.developmentExpenseReviewId) {
        if (row.sourceType !== 'DevelopmentCase') parents.reject('CONFLICT', '整案收费缺少准确开发案来源', 409);
        await visit('DevelopmentExpenseReview', row.developmentExpenseReviewId, false, depth + 1, true);
        const review = records.get(`DevelopmentExpenseReview:${row.developmentExpenseReviewId}`)!.row;
        if (review.developmentCaseId !== row.sourceId) parents.reject('CONFLICT', '收费核齐记录不属于本案', 409);
        // Coverage rows are themselves immutable historical facts. Include all
        // rounds, but only active covered costs are current billing sources.
        const coverage = await db.billingItemCostCoverage.findMany({ where: { billingItemId: row.id }, orderBy: { id: 'asc' } });
        for (const line of coverage) {
          records.set(`BillingItemCostCoverage:${line.id}`, { model: 'BillingItemCostCoverage', id: line.id, row: line });
          if (line.releasedAt === null) await visit('CostRecord', line.costRecordId, false, depth + 1);
        }
        try { await assertDevelopmentBillingCoverageCurrentInTx(db, row); }
        catch (error: any) {
          if (['INVALID_BILLING_SOURCE', 'REVIEW_REQUIRED', 'REVIEW_STALE', 'COVERAGE_CONFLICT'].includes(error?.code)) parents.reject('CONFLICT', '整案收费核齐或费用覆盖已失效，请核对原单', 409);
          throw error;
        }
      }
    } else if (model === 'PurchaseServiceDelivery') {
      await visit('PurchaseOrder', row.purchaseOrderId, false, depth + 1, true);
      await visit('PurchaseLine', row.purchaseLineId, false, depth + 1, true);
      const po = records.get(`PurchaseOrder:${row.purchaseOrderId}`)!.row, line = records.get(`PurchaseLine:${row.purchaseLineId}`)!.row;
      const accepted = new Prisma.Decimal(row.acceptedQuantity), rejected = new Prisma.Decimal(row.rejectedQuantity), price = new Prisma.Decimal(row.unitPriceSnapshot), amount = new Prisma.Decimal(row.acceptedAmount);
      if (!row.orderId || invoice.orderId !== row.orderId || po.orderId !== row.orderId || line.purchaseOrderId !== po.id || line.kind !== 'ProcessingService'
        || !row.orderLineId || line.orderLineId !== row.orderLineId || !['Confirmed', 'PartiallyReceived', 'Received', 'Closed'].includes(po.status)
        || invoice.type !== 'Payable' || invoice.customerRelationId !== po.supplierRelationId || invoice.currency !== row.currencySnapshot
        || ![accepted, rejected, price, amount].every(value => value.isFinite() && value.decimalPlaces() <= 4) || accepted.lte(0) || rejected.lt(0) || price.lte(0) || amount.lte(0)
        || !new Prisma.Decimal(invoice.amount).eq(amount) || !accepted.mul(price).toDecimalPlaces(4).eq(amount) || !row.unit || !row.evidenceReference) parents.reject('CONFLICT', '加工交付应付与真实采购、验收明细或金额不一致，请核对原单', 409);
      await visit('OrderLine', row.orderLineId, false, depth + 1);
      if (records.get(`OrderLine:${row.orderLineId}`)!.row.orderId !== row.orderId) parents.reject('CONFLICT', '加工交付产品明细不属于原订单', 409);
    } else if (model === 'PurchaseOrder') {
      if (row.orderId) await visit('Order', row.orderId, false, depth + 1);
      if (!row.supplierRelationId) parents.reject('CONFLICT', '加工采购缺少真实供应商，请核对原单', 409);
      await visit('Relation', row.supplierRelationId, false, depth + 1, true);
      // Header completion depends on every actual purchase line. Include all
      // current lines rather than one coincidentally matching amount/label.
      const purchaseLines = await db.purchaseLine.findMany({ where: { purchaseOrderId: row.id }, orderBy: { id: 'asc' } });
      for (const line of purchaseLines) {
        await visit('PurchaseLine', line.id, false, depth + 1, true);
        if (line.kind === 'ProcessingService' && !line.orderLineId || line.orderLineId && records.get(`OrderLine:${line.orderLineId}`)!.row.orderId !== row.orderId) parents.reject('CONFLICT', '采购明细与真实产品订单关联不一致，请核对原单', 409);
      }
    } else if (model === 'PurchaseLine') {
      // Parent is resolved by the delivery/PO path; avoid the real FK's
      // bidirectional cycle. Each processing line still has a real OrderLine.
      if (row.orderLineId) await visit('OrderLine', row.orderLineId, false, depth + 1);
    } else if (model === 'Quotation') {
      if (row.status !== 'Accepted') parents.reject('CONFLICT', '形式发票的原报价尚未接受或状态已变化，请核对原单', 409);
      if (!row.customerRelationId && !row.developmentCaseId && !row.orderId && !row.orderLineId && !row.convertedOrderId) parents.reject('CONFLICT', '原报价缺少可核对的真实客户或业务父项，请核对原单', 409);
      if (row.customerRelationId) await visit('Relation', row.customerRelationId, false, depth + 1, true);
      if (row.developmentCaseId) await visit('DevelopmentCase', row.developmentCaseId, false, depth + 1);
      if (row.orderId) await visit('Order', row.orderId, false, depth + 1);
      if (row.convertedOrderId) await visit('Order', row.convertedOrderId, false, depth + 1);
      if (row.orderLineId) {
        await visit('OrderLine', row.orderLineId, false, depth + 1);
        if (row.orderId && records.get(`OrderLine:${row.orderLineId}`)!.row.orderId !== row.orderId) parents.reject('CONFLICT', '原报价条目不属于关联订单，请核对原单', 409);
      }
      const quoteLines = await db.quotationLine.findMany({ where: { quotationId: row.id }, orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] });
      if (!quoteLines.length || new Set(quoteLines.map((line: any) => line.lineNumber)).size !== quoteLines.length) parents.reject('CONFLICT', '原报价明细缺失或序号不唯一，请核对原单', 409);
      for (const line of quoteLines) records.set(`QuotationLine:${line.id}`, { model: 'QuotationLine', id: line.id, row: line });
    } else if (model === 'Sample') {
      if (row.sourceCaseId) await visit('DevelopmentCase', row.sourceCaseId, false, depth + 1);
      if (row.sourceOrderId) await visit('Order', row.sourceOrderId, false, depth + 1);
      // A standalone sample has an actual customer anchor. A sample without
      // any parent/customer anchor cannot be guessed from its title or invoice.
      if (!row.sourceCaseId && !row.sourceOrderId && !row.customerRelationId) parents.reject('CONFLICT', '样品缺少可核对的业务来源，请核对原单', 409);
      if (row.customerRelationId) await visit('Relation', row.customerRelationId, false, depth + 1, true);
      if (row.invoiceId && row.invoiceId !== invoice.id) parents.reject('CONFLICT', '样品已绑定另一张发票，请核对原单', 409);
    } else if (model === 'SampleBatch' || model === 'SealSample') await visit('DevelopmentCase', row.developmentCaseId, false, depth + 1);
    else if (model === 'OrderLine') await visit('Order', row.orderId, false, depth + 1);
    else if (model === 'Shipment') {
      if (row.status === 'Cancelled') parents.reject('CONFLICT', '发票来源运单已取消，请核对原单', 409);
      if (row.orderId) await visit('Order', row.orderId, false, depth + 1);
      const allocations = await db.shipmentOrderAllocation.findMany({ where: { shipmentId: row.id }, orderBy: { id: 'asc' } });
      const keys = new Set<string>(), granularities = new Map<string, Set<string>>();
      for (const allocation of allocations) {
        // Cancelled allocations are historical source facts too. They cannot
        // supply the current batch's Order binding or bypass fresh parent L2.
        const allocationKey = JSON.stringify([allocation.orderId, allocation.orderLineId]);
        if (keys.has(allocationKey)) parents.reject('CONFLICT', '运单分配重复，不能准确核对发票来源', 409);
        keys.add(allocationKey);
        const kinds = granularities.get(allocation.orderId) || new Set<string>(); kinds.add(allocation.orderLineId == null ? 'order' : 'line'); granularities.set(allocation.orderId, kinds);
        if (kinds.size > 1) parents.reject('CONFLICT', '同运单订单级与行级分配混用，请核对原单', 409);
        if (!['Planned', 'PartiallyShipped', 'Fulfilled', 'ShortShipped', 'Cancelled'].includes(allocation.status)) parents.reject('CONFLICT', '运单分配状态不能准确核对，请核对原单', 409);
        await visit('Order', allocation.orderId, false, depth + 1);
        if (allocation.orderLineId) {
          await visit('OrderLine', allocation.orderLineId, false, depth + 1);
          if (records.get(`OrderLine:${allocation.orderLineId}`)!.row.orderId !== allocation.orderId) parents.reject('CONFLICT', '运单产品行不属于分配订单，请核对原单', 409);
        }
        records.set(`ShipmentOrderAllocation:${allocation.id}`, { model: 'ShipmentOrderAllocation', id: allocation.id, row: allocation });
      }
      // Match native shipping/allocationService.assertConsolidationAllowed:
      // all actual allocated Orders (including cancelled history) must retain
      // the same customer and businessLine. Legacy names are business-only
      // comparisons; each Order has already passed current parent L2 above.
      const allocatedOrders = [...new Set<string>(allocations.map((allocation: any) => allocation.orderId))]
        .map(orderId => records.get(`Order:${orderId}`)!.row);
      if (allocatedOrders.length > 1) {
        const first = allocatedOrders[0];
        if (allocatedOrders.some(order => (order.customerRelationId ?? order.customer) !== (first.customerRelationId ?? first.customer)
          || (order.businessLine ?? 'other') !== (first.businessLine ?? 'other'))) parents.reject('CONFLICT', '运单合票的真实客户或业务线已不一致，请核对原单', 409);
      }
      if (!row.orderId && !allocations.length) parents.reject('CONFLICT', '来源运单缺少真实订单分配，请核对原单', 409);
    } else if (model === 'OrderShipmentBatch') {
      if (!['planned', 'shipped'].includes(row.status)) parents.reject('CONFLICT', '发票来源批次已取消或状态不明，请核对原单', 409);
      await visit('Order', row.orderId, false, depth + 1);
      if (row.customerRelationId) await visit('Relation', row.customerRelationId, false, depth + 1, true);
      // Planned batches and null shipmentId are legal native pre-invoicing.
      // An actual linked Shipment must cover this Order via current SOA, or
      // via its legacy primary Order when it has no allocation rows at all.
      if (row.shipmentId) {
        await visit('Shipment', row.shipmentId, false, depth + 1);
        const shipment = records.get(`Shipment:${row.shipmentId}`)!.row;
        const allocations = [...records.values()].filter(record => record.model === 'ShipmentOrderAllocation' && record.row.shipmentId === shipment.id).map(record => record.row);
        if (allocations.length ? !allocations.some((allocation: any) => allocation.orderId === row.orderId && allocation.status !== 'Cancelled') : shipment.orderId !== row.orderId) {
          parents.reject('CONFLICT', '批次运单不含该订单的真实有效分配，请核对原单', 409);
        }
      }
    }
    else if (model === 'DevelopmentExpenseReview') {
      await visit('DevelopmentCase', row.developmentCaseId, false, depth + 1);
      await visit('DevelopmentLifecycleEvent', row.lifecycleEventId, false, depth + 1, true);
      const lifecycle = records.get(`DevelopmentLifecycleEvent:${row.lifecycleEventId}`)!.row;
      if (lifecycle.developmentCaseId !== row.developmentCaseId) parents.reject('CONFLICT', '费用核齐与结案来源不一致', 409);
      const costs = row.snapshot?.costs?.records;
      if (!Array.isArray(costs) || costs.some((cost: any) => !identifier(cost.id)) || new Set(costs.map((cost: any) => cost.id)).size !== costs.length) parents.reject('CONFLICT', '费用核齐明细不完整', 409);
      for (const cost of costs) await visit('CostRecord', cost.id, false, depth + 1);
    } else if (model === 'DevelopmentLifecycleEvent') await visit('DevelopmentCase', row.developmentCaseId, false, depth + 1);
    if (model === 'BillingItem' && row.invoiceId && row.invoiceId !== invoice.id) parents.reject('CONFLICT', '收费事项已绑定另一张发票，请核对原单', 409);
    visiting.delete(key);
  }
  // Native PI conversion allows every known non-Cancelled Invoice state,
  // including recorded Paid/PartiallyPaid history. It does not enforce a new
  // Draft/Issued-only policy or establish how a payment was recorded.
  const convertibleProformaStatus = (status: any) => (VALID_INVOICE_STATUS as readonly string[]).includes(status) && status !== 'Cancelled';
  const conflict = (): never => parents.reject('CONFLICT', '形式发票、原报价明细或正式转票审计不能准确核对，请核对原单', 409);
  const equalMoney = (a: any, b: any): boolean => {
    if (a == null || b == null) return a == null && b == null;
    try { const left = new Prisma.Decimal(a), right = new Prisma.Decimal(b); return left.isFinite() && right.isFinite() && left.eq(right); }
    catch { return false; }
  };
  function equalSnapshot(left: any, right: any): boolean {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((line: any, index: number) => {
      const other = right[index];
      return line && other && ['lineNumber', 'fabricCode', 'description', 'unit', 'notes'].every(key => line[key] === other[key])
        && ['quantity', 'unitPrice', 'amount'].every(key => line[key] != null && other[key] != null && equalMoney(line[key], other[key]));
    });
  }
  // PI is an actual Invoice row. Its JSON snapshot and mandatory native audit
  // anchor the actual quote; a formal conversion recursively keeps that PI,
  // including its legitimate Cancelled history. Never infer either from notes.
  async function proformaOrigin(document: any, depth = 0, convertedParent = false): Promise<void> {
    if (depth > 50) conflict();
    const generation = await db.auditLog.findMany({ where: { action: 'generate_proforma_from_quotation', targetType: 'Invoice', targetId: document.id }, orderBy: { id: 'asc' } });
    const conversion = await db.auditLog.findMany({ where: { action: 'convert_proforma_to_receivable', targetType: 'Invoice', targetId: document.id }, orderBy: { id: 'asc' } });
    const attachment = document.attachments && typeof document.attachments === 'object' && !Array.isArray(document.attachments) ? document.attachments : {};
    const originalId = attachment.proformaInvoiceId;
    if (originalId != null || conversion.length) {
      if (convertedParent || generation.length || conversion.length !== 1 || !identifier(originalId) || originalId === document.id || document.type !== 'Receivable'
        || document.sourceType != null || document.sourceId != null) conflict();
      const original = await db.invoice.findFirst({ where: { id: originalId, deletedAt: null } });
      if (!original) missing();
      const fact = conversion[0], detail = fact.detail;
      if (original.type !== 'Proforma' || original.status !== 'Cancelled' || !identifier(fact.actorId) || detail?.source !== 'proforma-invoice:convert'
        || detail?.before?.proformaInvoiceId !== original.id || detail?.before?.proformaInvoiceNumber !== original.invoiceNumber || !convertibleProformaStatus(detail?.before?.proformaStatus)
        || detail?.after?.receivableInvoiceId !== document.id || detail?.after?.receivableInvoiceNumber !== document.invoiceNumber || detail?.after?.type !== 'Receivable'
        || detail?.after?.status !== 'Issued' || !equalMoney(detail?.after?.amount, document.amount) || attachment.proformaInvoiceNumber !== original.invoiceNumber
        || !equalMoney(document.amount, original.amount) || document.currency !== original.currency || !equalMoney(document.exchangeRate, original.exchangeRate)
        || document.baseCurrency !== original.baseCurrency || document.orderId !== original.orderId || document.customerRelationId !== original.customerRelationId
        || document.customerName !== original.customerName || attachment.quotationId !== original.attachments?.quotationId
        || attachment.quotationNumber !== original.attachments?.quotationNumber || !equalSnapshot(attachment.lines, original.attachments?.lines)) conflict();
      records.set(`Invoice:${original.id}`, { model: 'Invoice', id: original.id, row: original });
      records.set(`AuditLog:${fact.id}`, { model: 'AuditLog', id: fact.id, row: fact });
      await proformaOrigin(original, depth + 1, true);
      return;
    }
    if (document.type !== 'Proforma' && attachment.quotationId == null && !generation.length) return;
    if (document.type !== 'Proforma' || generation.length !== 1 || !identifier(attachment.quotationId) || document.sourceType != null || document.sourceId != null
      || !(convertedParent ? document.status === 'Cancelled' : convertibleProformaStatus(document.status))) conflict();
    await visit('Quotation', attachment.quotationId, false, depth + 1, true);
    const quote = records.get(`Quotation:${attachment.quotationId}`)!.row;
    const financialOrderId = proformaSourceOrderId(quote,
      quote.orderLineId ? records.get(`OrderLine:${quote.orderLineId}`)?.row.orderId : null);
    const quoteLines = [...records.values()].filter(record => record.model === 'QuotationLine' && record.row.quotationId === quote.id)
      .map(record => record.row).sort((a, b) => a.lineNumber - b.lineNumber || a.id.localeCompare(b.id));
    const fact = generation[0], detail = fact.detail;
    if (!identifier(fact.actorId) || detail?.source !== 'proforma-invoice:generate' || detail?.before?.quotationId !== quote.id || detail?.before?.quotationNumber !== quote.quotationNumber
      || detail?.after?.invoiceId !== document.id || detail?.after?.invoiceNumber !== document.invoiceNumber || detail?.after?.type !== 'Proforma'
      || !equalMoney(detail?.after?.amount, document.amount) || detail?.after?.currency !== document.currency || attachment.quotationNumber !== quote.quotationNumber
      || !equalMoney(document.amount, quote.totalAmount) || document.currency !== quote.currency || !equalMoney(document.exchangeRate, quote.exchangeRate)
      || document.baseCurrency !== (quote.baseCurrency || 'CNY') || document.customerRelationId !== (quote.customerRelationId || null)
      || document.customerName !== (quote.customerName || null) || document.orderId !== financialOrderId || !equalSnapshot(attachment.lines, quoteLines)) conflict();
    records.set(`AuditLog:${fact.id}`, { model: 'AuditLog', id: fact.id, row: fact });
  }
  await proformaOrigin(invoice);
  // Native supplier claim confirmation writes no generic Invoice source. Its
  // exact persisted reverse FK and mandatory confirmation audit are the source,
  // including negative Payable documents. Number/title/notes prove nothing.
  const supplierReturns = await db.materialReturn.findMany({ where: { claimInvoiceId: invoice.id }, orderBy: { id: 'asc' } });
  const confirmations = await db.auditLog.findMany({ where: { action: 'confirm_material_return', targetType: 'MaterialReturn',
    detail: { path: ['after', 'claimInvoiceId'], equals: invoice.id } }, orderBy: { id: 'asc' } });
  if (supplierReturns.length || confirmations.length) {
    if (supplierReturns.length !== 1 || confirmations.length !== 1) parents.reject('CONFLICT', '供应商索赔贷项的退料来源或确认事实不唯一、缺失，请核对原单', 409);
    const source = supplierReturns[0], confirmation = confirmations[0], amount = source.amount == null ? null : new Prisma.Decimal(source.amount);
    if (source.deletedAt !== null || source.type !== 'claim' || !['confirmed', 'settled'].includes(source.status) || source.claimInvoiceId !== invoice.id
      || invoice.sourceType != null || invoice.sourceId != null || invoice.type !== 'Payable' || !new Prisma.Decimal(invoice.amount).lt(0)
      || !amount || !amount.isFinite() || amount.lte(0) || !new Prisma.Decimal(invoice.amount).abs().eq(amount) || invoice.currency !== source.currency
      || !source.supplierRelationId || invoice.customerRelationId !== source.supplierRelationId || confirmation.targetId !== source.id
      || typeof confirmation.actorId !== 'string' || !confirmation.actorId.trim() || confirmation.detail?.source !== 'route:procurement:material-return'
      || confirmation.detail?.before?.status !== 'shipped' || confirmation.detail?.after?.status !== 'confirmed' || confirmation.detail?.after?.claimInvoiceId !== invoice.id) parents.reject('CONFLICT', '供应商索赔贷项与真实退料金额、币种、供应商或确认事实不一致，请核对原单', 409);
    await visit('MaterialReturn', source.id, false, 0, true);
    await visit('MaterialReceipt', source.receiptId, false, 0, true);
    await visit('PurchaseOrder', source.purchaseOrderId, false, 0, true);
    const receipt = records.get(`MaterialReceipt:${source.receiptId}`)!.row, po = records.get(`PurchaseOrder:${source.purchaseOrderId}`)!.row;
    if (receipt.purchaseOrderId !== source.purchaseOrderId || po.supplierRelationId !== source.supplierRelationId
      || (invoice.orderId != null && invoice.orderId !== po.orderId)) parents.reject('CONFLICT', '供应商索赔的原收料、采购单或供应商关联不一致，请核对原单', 409);
    // A cancelled/deleted/changed confirmation must invalidate reuse of the
    // old workflow source. Keep the real immutable record; do not replace it
    // with a new fact or change any native financial/physical status.
    records.set(`AuditLog:${confirmation.id}`, { model: 'AuditLog', id: confirmation.id, row: confirmation });
  }
  // Both null without an actual reverse fact is the native manual/legacy
  // header contract. Erasing both FK and audits cannot be detected from names.
  if (invoice.sourceType != null || invoice.sourceId != null) await visit(invoice.sourceType, invoice.sourceId);
  if (invoice.orderId) await visit('Order', invoice.orderId);
  // IOA is the actual Invoice → OrderShipmentBatch link; Invoice has no
  // batchId field. Null batch/amount retains native whole-Order pre-invoicing.
  const allocatedOrders: any[] = [];
  for (const attachment of attachments) {
    if (attachment.invoiceId !== invoice.id || attachment.deletedAt !== null) parents.reject('CONFLICT', '发票订单附件关联不能准确核对，请核对原单', 409);
    await visit('Order', attachment.orderId);
    const order = records.get(`Order:${attachment.orderId}`)!.row; allocatedOrders.push(order);
    records.set(`InvoiceOrderAllocation:${attachment.id}`, { model: 'InvoiceOrderAllocation', id: attachment.id, row: attachment });
    if (attachment.allocatedAmount != null) {
      const amount = new Prisma.Decimal(attachment.allocatedAmount);
      if (!amount.isFinite() || amount.lte(0)) parents.reject('CONFLICT', '发票订单分配金额不能准确核对，请核对原单', 409);
    }
    if (attachment.batchId != null) {
      if (attachment.allocatedAmount == null) parents.reject('CONFLICT', '批次发票缺少实际分配金额，请核对原单', 409);
      await visit('OrderShipmentBatch', attachment.batchId, false, 0, true);
      const batch = records.get(`OrderShipmentBatch:${attachment.batchId}`)!.row;
      if (batch.orderId !== order.id || batch.currency !== invoice.currency || findAllocationCustomerViolation([order], { ...batch, type: invoice.type })) {
        parents.reject('CONFLICT', '发票、批次与订单的真实归属、客户或币种不一致，请核对原单', 409);
      }
    }
  }
  if (new Set(attachments.map(row => row.orderId)).size !== attachments.length || findAllocationCustomerViolation(allocatedOrders, invoice)) {
    parents.reject('CONFLICT', '发票订单分配重复或客户不一致，请核对原单', 409);
  }
  if (attachments.length) records.set(`Invoice:${invoice.id}`, { model: 'Invoice', id: invoice.id, row: invoice });
  for (const line of lines) await visit(line.sourceType, line.sourceId, true);
  // The workflow reviews this Invoice's current recorded financial source,
  // not the aggregate payment gate for all other invoices of an OSB. Capture
  // both real settlement tables, matching sumAppliedAmount's exact basis;
  // never infer a cash receipt from a CN offset or from the batch cache.
  for (const model of ['InvoiceAllocation', 'CreditNoteAllocation'] as const) {
    const allocations = await db[MODELS[model]].findMany({ where: { invoiceId: invoice.id }, orderBy: { id: 'asc' } });
    // Native settlement writers lock Invoice before their allocation row.
    // Include that root even for a legal invoice without any IOA/batch.
    if (allocations.length && !records.has(`Invoice:${invoice.id}`)) records.set(`Invoice:${invoice.id}`, { model: 'Invoice', id: invoice.id, row: invoice });
    for (const row of allocations) records.set(`${model}:${row.id}`, { model, id: row.id, row });
  }
  const rows = [...records.values()].sort((a, b) => ORDER.indexOf(a.model) - ORDER.indexOf(b.model) || a.id.localeCompare(b.id));
  return { records: rows, orderParents: [...orders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    developmentParents: [...developments.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row), bindings: rows.map(({ model, id }) => ({ model, id })) };
}
export async function lockWorkflowInvoiceSource(db: any, graph: WorkflowInvoiceSourceGraph, parents: WorkflowInvoiceParents) {
  for (const record of graph.records) {
    // CommissionPayable is the native order#sequence anchor, not a table.
    // Its actual Order, pricing, rule and invoice rows are locked below/above.
    if (record.model === 'CommissionPayable') continue;
    // Table identifiers come exclusively from the closed Model union above.
    const active = WITHOUT_SOFT_DELETE.has(record.model) || record.model === 'Invoice' ? Prisma.empty : Prisma.sql`AND "deletedAt" IS NULL`;
    const rows = await db.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw('"' + record.model + '"')} WHERE "id"=${record.id} ${active} FOR UPDATE`);
    if (!rows.length) parents.reject('NOT_FOUND', '发票来源不存在、已删除或无权访问，请核对原单', 404);
  }
}
