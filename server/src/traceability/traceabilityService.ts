/**
 * traceabilityService.ts — 14 实体关联 + 7 一键溯源场景
 *
 * 14 实体：
 *   Relation, Order, OrderLine, Quotation, Invoice, PaymentVoucher,
 *   Shipment, CustomsDeclaration, ProductionStage, SampleNode,
 *   InspectionReport, TradeDocument, TaxRefund, Product
 *
 * 7 一键溯源场景：
 *   1. customerPanorama    — 客户全景：Relation → Orders → Invoices → Payments → AR
 *   2. orderFulfillment    — 订单履约链：Order → Production → Inspection → Shipment → Customs
 *   3. quoteToShip         — 报价到发货链：Quotation → PI → CommercialInvoice → PackingList → B/L
 *   4. supplierPanorama    — 供应商全景：Relation(Supplier) → PurchaseOrders → Invoices → Payments → AP
 *   5. productCostChain    — 产品成本链：Product → BOM → Cost → Quotation → Order
 *   6. taxRefundChain      — 退税链：TaxRefund → CustomsDeclaration → ExportInvoice → PaymentReceipt
 *   7. purchaseToStock     — 采购库存链（W-C A1）：PurchaseOrder → MaterialReceipt → StockMovement → InventoryItem
 *                            （root 兼容采购单 ID 与库存物料 ID 两种入口，双向三击）
 */
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { logger } from '../lib/logger';

import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
// ★ S4 任务3：溯源视图的订单金额合计 ⇒ 走唯一真源（原写法裸用 quoteAmount）
import { orderAmountOf } from '../shared/orderAmount';
export type TraceScenario =
  | 'customerPanorama'
  | 'orderFulfillment'
  | 'quoteToShip'
  | 'supplierPanorama'
  | 'productCostChain'
  | 'taxRefundChain'
  | 'purchaseToStock';

export interface TraceResult {
  scenario: TraceScenario;
  rootId: string;
  rootType: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  summary: Record<string, any>;
}

export interface TraceNode {
  id: string;
  type: string;       // Relation / Order / Invoice / ...
  label: string;      // 显示名
  data: Record<string, any>;
}

export interface TraceEdge {
  from: string;
  to: string;
  relation: string;   // has_order / has_invoice / has_payment / ...
}

export function createTraceabilityService(prisma: PrismaClient) {
  const permSvc = createPermissionService({ prisma });
  // v2.2（DR-042 §5.1 L2）：全景/履约链属业务层——跟进客户 ∪ 团队共享锚定
  const teamShareSvc = createTeamShareService(prisma);

  // ── 序列化 ──
  function ser(row: any): any {
    if (!row) return null;
    const out: any = { ...row };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
      if (out[k] && typeof out[k] === 'object' && out[k]._isBigNumber) out[k] = Number(out[k].toString());
    }
    return out;
  }

  // ── scope 校验 ──
  async function buildScopeWhere(actor: TokenPayload | null | undefined, module: string): Promise<Record<string, unknown>> {
    if (!actor) return { ownerId: '__NOBODY__' };
    const resolver = await permSvc.getDataScopeResolver(actor, module);
    if (resolver.rule.kind === 'all') return {};
    // §10.4.1：team 档同样按「解析后的用户集」拼装，不再按 rule.kind 硬分支
    return buildScopeWhereFromResolver(resolver, actor.userId);
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. 客户全景：Relation → Orders → Invoices → Payments → AR 汇总
  // ══════════════════════════════════════════════════════════════════
  async function customerPanorama(actor: TokenPayload | null | undefined, relationId: string): Promise<TraceResult> {
    // v2.2（DR-042 §5.1 L2）：客户全景含跟进/商机等业务子树——跟进人 ∨ 团队共享 ∨ 真全权角色
    if (!(await teamShareSvc.hasBizReadAccess(actor, relationId))) throw new Error('NOT_FOUND');
    const rel = await (prisma as any).relation.findFirst({
      where: { id: relationId, deletedAt: null },
      include: {
        contacts: { where: { deletedAt: null }, take: 5 },
        followUpRecords: { where: { deletedAt: null }, take: 5, orderBy: { createdAt: 'desc' } },
        opportunities: { where: { deletedAt: null }, take: 5, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!rel) throw new Error('NOT_FOUND');

    const [orders, invoices, payments, quotations] = await Promise.all([
      (prisma as any).order.findMany({ where: { customerRelationId: relationId, deletedAt: null }, select: { id: true, code: true, status: true, type: true, product: true, quoteAmount: true, dueDate: true, createdAt: true }, take: 100, orderBy: { createdAt: 'desc' } }),
      (prisma as any).invoice.findMany({ where: { customerRelationId: relationId, deletedAt: null }, select: { id: true, invoiceNumber: true, type: true, status: true, amount: true, currency: true, issueDate: true, dueDate: true }, take: 100, orderBy: { createdAt: 'desc' } }),
      (prisma as any).paymentVoucher.findMany({ where: { customerRelationId: relationId, deletedAt: null }, select: { id: true, voucherNumber: true, type: true, status: true, amount: true, currency: true, paymentDate: true }, take: 100, orderBy: { createdAt: 'desc' } }),
      (prisma as any).quotation.findMany({ where: { customerRelationId: relationId, deletedAt: null }, select: { id: true, quotationNumber: true, status: true, totalAmount: true, currency: true, issueDate: true }, take: 20, orderBy: { createdAt: 'desc' } }),
    ]);

    const arInvoices = invoices.filter((i: any) => i.type === 'Receivable');
    const arTotal = arInvoices.reduce((s: number, i: any) => s + Number(i.amount?.toString?.() || i.amount || 0), 0);
    const receipts = payments.filter((p: any) => p.type === 'Receipt');
    const receiptTotal = receipts.reduce((s: number, p: any) => s + Number(p.amount?.toString?.() || p.amount || 0), 0);
    const orderTotal = orders.reduce((s: number, o: any) => s + orderAmountOf(o), 0);

    const nodes: TraceNode[] = [
      { id: rel.id, type: 'Relation', label: rel.name || rel.code || rel.id, data: ser(rel) },
      ...orders.map((o: any) => ({ id: o.id, type: 'Order', label: o.code || o.product || o.id, data: ser(o) })),
      ...arInvoices.map((i: any) => ({ id: i.id, type: 'Invoice', label: i.invoiceNumber || i.id, data: ser(i) })),
      ...receipts.map((p: any) => ({ id: p.id, type: 'Payment', label: p.voucherNumber || p.id, data: ser(p) })),
      ...quotations.map((q: any) => ({ id: q.id, type: 'Quotation', label: q.quotationNumber || q.id, data: ser(q) })),
    ];
    const edges: TraceEdge[] = [
      ...orders.map((o: any) => ({ from: rel.id, to: o.id, relation: 'has_order' })),
      ...arInvoices.map((i: any) => ({ from: rel.id, to: i.id, relation: 'has_invoice' })),
      ...receipts.map((p: any) => ({ from: rel.id, to: p.id, relation: 'has_payment' })),
      ...quotations.map((q: any) => ({ from: rel.id, to: q.id, relation: 'has_quotation' })),
    ];

    return {
      scenario: 'customerPanorama', rootId: rel.id, rootType: 'Relation', nodes, edges,
      summary: {
        relationName: rel.name, orderCount: orders.length, orderTotal,
        arTotal, receiptTotal, outstanding: Math.max(0, arTotal - receiptTotal),
        quotationCount: quotations.length, contactCount: rel.contacts?.length || 0,
        activeOpportunityCount: rel.opportunities?.filter((o: any) => !['Won', 'Lost'].includes(o.stage))?.length || 0,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. 订单履约链：Order → Production → Inspection → Shipment → Customs
  // ══════════════════════════════════════════════════════════════════
  async function orderFulfillment(actor: TokenPayload | null | undefined, orderId: string): Promise<TraceResult> {
    // v2.2（DR-042 §5.1 L2）：订单履约链锚 = 宿主客户 ∈ followedBy ∪ teamGranted ∪ 真全权
    const orderVisible = await (async () => {
      if (!actor) return false;
      const resolver = await permSvc.getDataScopeResolver(actor, 'orders');
      if (resolver.rule.kind === 'all') return true;
      const visibleIds = await teamShareSvc.resolveVisibleRelationIds(actor);
      const row = await (prisma as any).order.findFirst({
        where: { id: orderId, deletedAt: null },
        select: { ownerId: true, customerRelationId: true },
      });
      if (!row) return false;
      if (row.customerRelationId && visibleIds.includes(row.customerRelationId)) return true;
      if (!row.customerRelationId && row.ownerId === actor.userId) return true; // 无锚遗留订单：创建者可见
      return false;
    })();
    if (!orderVisible) throw new Error('NOT_FOUND');
    const order = await (prisma as any).order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { lines: true },
    });
    if (!order) throw new Error('NOT_FOUND');

    const [stages, inspections, shipments, customs] = await Promise.all([
      (prisma as any).productionStage.findMany({ where: { orderId }, select: { id: true, stageKey: true, status: true, stageSeq: true, startedAt: true, doneAt: true, signedByProduction: true, signedByBusiness: true }, orderBy: { stageSeq: 'asc' } }),
      (prisma as any).inspectionReport.findMany({ where: { orderId }, select: { id: true, result: true, passRate: true, defectRate: true, inspector: true, inspectedAt: true }, take: 20, orderBy: { createdAt: 'desc' } }),
      (prisma as any).shipment.findMany({ where: { orderId }, select: { id: true, shipmentNumber: true, status: true, shipDate: true, eta: true, carrier: true, trackingNo: true }, take: 20, orderBy: { createdAt: 'desc' } }),
      (prisma as any).customsDeclaration.findMany({ where: { orderId }, select: { id: true, declarationNumber: true, status: true, customsType: true, declaredDate: true, releasedDate: true }, take: 20, orderBy: { createdAt: 'desc' } }),
    ]);

    const nodes: TraceNode[] = [
      { id: order.id, type: 'Order', label: order.code || order.product || order.id, data: ser(order) },
      ...stages.map((s: any) => ({ id: s.id, type: 'ProductionStage', label: s.stageKey, data: ser(s) })),
      ...inspections.map((i: any) => ({ id: i.id, type: 'Inspection', label: `Inspection ${i.result || ''}`, data: ser(i) })),
      ...shipments.map((s: any) => ({ id: s.id, type: 'Shipment', label: s.shipmentNumber || s.id, data: ser(s) })),
      ...customs.map((c: any) => ({ id: c.id, type: 'Customs', label: c.declarationNumber || c.id, data: ser(c) })),
    ];
    const edges: TraceEdge[] = [
      ...stages.map((s: any) => ({ from: order.id, to: s.id, relation: 'has_stage' })),
      ...inspections.map((i: any) => ({ from: order.id, to: i.id, relation: 'has_inspection' })),
      ...shipments.map((s: any) => ({ from: order.id, to: s.id, relation: 'has_shipment' })),
      ...customs.map((c: any) => ({ from: order.id, to: c.id, relation: 'has_customs' })),
    ];

    const currentStage = stages.filter((s: any) => s.status === 'in_progress' || s.status === 'pending').sort((a: any, b: any) => a.seq - b.seq)[0];
    const completedStages = stages.filter((s: any) => s.status === 'completed').length;

    return {
      scenario: 'orderFulfillment', rootId: order.id, rootType: 'Order', nodes, edges,
      summary: {
        orderCode: order.code, orderStatus: order.status, orderType: order.type,
        totalStages: stages.length, completedStages, currentStage: currentStage?.stageKey || 'N/A',
        inspectionCount: inspections.length, lastInspectionResult: inspections[0]?.result || 'N/A',
        shipmentCount: shipments.length, shipmentStatus: shipments[0]?.status || 'N/A',
        customsCount: customs.length, customsStatus: customs[0]?.status || 'N/A',
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. 报价到发货链：Quotation → PI → CommercialInvoice → PackingList → B/L
  // ══════════════════════════════════════════════════════════════════
  async function quoteToShip(actor: TokenPayload | null | undefined, quotationId: string): Promise<TraceResult> {
    const scopeWhere = await buildScopeWhere(actor, 'finance');
    const quotation = await (prisma as any).quotation.findFirst({
      where: { id: quotationId, deletedAt: null, ...scopeWhere },
      include: { lines: true },
    });
    if (!quotation) throw new Error('NOT_FOUND');

    // 查关联订单
    const orders = quotation.orderId
      ? await (prisma as any).order.findMany({ where: { id: quotation.orderId, deletedAt: null }, take: 5 })
      : [];

    // 查关联发票
    const invoices = quotation.orderId
      ? await (prisma as any).invoice.findMany({ where: { orderId: quotation.orderId, type: 'Receivable', deletedAt: null }, take: 20, orderBy: { createdAt: 'desc' } })
      : [];

    // 查关联出货
    const shipments = quotation.orderId
      ? await (prisma as any).shipment.findMany({ where: { orderId: quotation.orderId, deletedAt: null }, take: 20, orderBy: { createdAt: 'desc' } })
      : [];

    // 查关联贸易单据
    const tradeDocs = quotation.orderId
      ? await (prisma as any).tradeDocument.findMany({ where: { orderId: quotation.orderId, deletedAt: null }, take: 20, orderBy: { createdAt: 'desc' } })
      : [];

    const nodes: TraceNode[] = [
      { id: quotation.id, type: 'Quotation', label: quotation.quotationNumber || quotation.id, data: ser(quotation) },
      ...orders.map((o: any) => ({ id: o.id, type: 'Order', label: o.code || o.id, data: ser(o) })),
      ...invoices.map((i: any) => ({ id: i.id, type: 'Invoice', label: i.invoiceNumber || i.id, data: ser(i) })),
      ...shipments.map((s: any) => ({ id: s.id, type: 'Shipment', label: s.shipmentNumber || s.id, data: ser(s) })),
      ...tradeDocs.map((d: any) => ({ id: d.id, type: 'TradeDocument', label: d.docType || d.id, data: ser(d) })),
    ];
    const edges: TraceEdge[] = [
      ...orders.map((o: any) => ({ from: quotation.id, to: o.id, relation: 'quote_to_order' })),
      ...invoices.map((i: any) => ({ from: orders[0]?.id || quotation.id, to: i.id, relation: 'has_invoice' })),
      ...shipments.map((s: any) => ({ from: orders[0]?.id || quotation.id, to: s.id, relation: 'has_shipment' })),
      ...tradeDocs.map((d: any) => ({ from: orders[0]?.id || quotation.id, to: d.id, relation: 'has_document' })),
    ];

    return {
      scenario: 'quoteToShip', rootId: quotation.id, rootType: 'Quotation', nodes, edges,
      summary: {
        quotationNumber: quotation.quotationNumber, quotationStatus: quotation.status,
        totalAmount: Number(quotation.totalAmount?.toString?.() || quotation.totalAmount || 0),
        orderCount: orders.length, invoiceCount: invoices.length,
        shipmentCount: shipments.length, documentCount: tradeDocs.length,
        docTypes: [...new Set(tradeDocs.map((d: any) => d.docType))],
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. 供应商全景：Relation(Supplier) → PurchaseOrders → Invoices → Payments → AP
  // ══════════════════════════════════════════════════════════════════
  async function supplierPanorama(actor: TokenPayload | null | undefined, relationId: string): Promise<TraceResult> {
    // v2.2（DR-042 §5.1 L2）：供应商全景含采购/应付等业务子树——跟进人 ∨ 团队共享 ∨ 真全权角色
    if (!(await teamShareSvc.hasBizReadAccess(actor, relationId))) throw new Error('NOT_FOUND');
    const rel = await (prisma as any).relation.findFirst({
      where: { id: relationId, deletedAt: null },
      include: { factoryProfile: true },
    });
    if (!rel) throw new Error('NOT_FOUND');

    const [orders, invoices, payments, evaluations] = await Promise.all([
      (prisma as any).order.findMany({ where: { supplierRelationId: relationId, deletedAt: null }, select: { id: true, code: true, status: true, product: true, quoteAmount: true, dueDate: true }, take: 100, orderBy: { createdAt: 'desc' } }),
      (prisma as any).invoice.findMany({ where: { customerRelationId: relationId, type: 'Payable', deletedAt: null }, select: { id: true, invoiceNumber: true, status: true, amount: true, currency: true, dueDate: true }, take: 100, orderBy: { createdAt: 'desc' } }),
      (prisma as any).paymentVoucher.findMany({ where: { customerRelationId: relationId, type: 'Disbursement', deletedAt: null }, select: { id: true, voucherNumber: true, status: true, amount: true, currency: true, paymentDate: true }, take: 100, orderBy: { createdAt: 'desc' } }),
      rel.factoryProfile ? (prisma as any).factoryEvaluation.findMany({ where: { factoryProfileId: rel.factoryProfile.id }, take: 10, orderBy: { createdAt: 'desc' } }) : [],
    ]);

    const apTotal = invoices.reduce((s: number, i: any) => s + Number(i.amount?.toString?.() || i.amount || 0), 0);
    const paidTotal = payments.reduce((s: number, p: any) => s + Number(p.amount?.toString?.() || p.amount || 0), 0);

    const nodes: TraceNode[] = [
      { id: rel.id, type: 'Relation', label: rel.name || rel.code || rel.id, data: ser(rel) },
      ...orders.map((o: any) => ({ id: o.id, type: 'Order', label: o.code || o.product || o.id, data: ser(o) })),
      ...invoices.map((i: any) => ({ id: i.id, type: 'Invoice', label: i.invoiceNumber || i.id, data: ser(i) })),
      ...payments.map((p: any) => ({ id: p.id, type: 'Payment', label: p.voucherNumber || p.id, data: ser(p) })),
      ...evaluations.map((e: any) => ({ id: e.id, type: 'Evaluation', label: `Eval ${e.kind || ''}`, data: ser(e) })),
    ];
    const edges: TraceEdge[] = [
      ...orders.map((o: any) => ({ from: rel.id, to: o.id, relation: 'has_purchase_order' })),
      ...invoices.map((i: any) => ({ from: rel.id, to: i.id, relation: 'has_payable' })),
      ...payments.map((p: any) => ({ from: rel.id, to: p.id, relation: 'has_disbursement' })),
      ...evaluations.map((e: any) => ({ from: rel.id, to: e.id, relation: 'has_evaluation' })),
    ];

    return {
      scenario: 'supplierPanorama', rootId: rel.id, rootType: 'Relation', nodes, edges,
      summary: {
        supplierName: rel.name, hasFactoryProfile: !!rel.factoryProfile,
        orderCount: orders.length, apTotal, paidTotal, outstanding: Math.max(0, apTotal - paidTotal),
        evaluationCount: evaluations.length,
        avgScore: evaluations.length > 0 ? evaluations.reduce((s: number, e: any) => s + (e.score || 0), 0) / evaluations.length : null,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. 产品成本链：Product → BOM → Cost → Quotation → Order
  // ══════════════════════════════════════════════════════════════════
  async function productCostChain(actor: TokenPayload | null | undefined, productId: string): Promise<TraceResult> {
    const product = await (prisma as any).product.findFirst({ where: { id: productId, deletedAt: null } });
    if (!product) throw new Error('NOT_FOUND');

    const [boms, quotations, orders] = await Promise.all([
      (prisma as any).bom.findMany({ where: { productId, deletedAt: null }, include: { lines: true }, take: 20, orderBy: { createdAt: 'desc' } }),
      (prisma as any).quotation.findMany({ where: { productId, deletedAt: null }, select: { id: true, quotationNumber: true, status: true, totalAmount: true, currency: true, issueDate: true }, take: 20, orderBy: { createdAt: 'desc' } }),
      (prisma as any).order.findMany({ where: { productId, deletedAt: null }, select: { id: true, code: true, status: true, quoteAmount: true, dueDate: true }, take: 20, orderBy: { createdAt: 'desc' } }),
    ]);

    const nodes: TraceNode[] = [
      { id: product.id, type: 'Product', label: product.name || product.sku || product.id, data: ser(product) },
      ...boms.map((b: any) => ({ id: b.id, type: 'BOM', label: `BOM ${b.version || ''}`, data: ser(b) })),
      ...quotations.map((q: any) => ({ id: q.id, type: 'Quotation', label: q.quotationNumber || q.id, data: ser(q) })),
      ...orders.map((o: any) => ({ id: o.id, type: 'Order', label: o.code || o.id, data: ser(o) })),
    ];
    const edges: TraceEdge[] = [
      ...boms.map((b: any) => ({ from: product.id, to: b.id, relation: 'has_bom' })),
      ...quotations.map((q: any) => ({ from: product.id, to: q.id, relation: 'has_quotation' })),
      ...orders.map((o: any) => ({ from: product.id, to: o.id, relation: 'has_order' })),
    ];

    return {
      scenario: 'productCostChain', rootId: product.id, rootType: 'Product', nodes, edges,
      summary: {
        productName: product.name, productSku: product.sku,
        bomCount: boms.length, latestBomCost: boms[0] ? Number(boms[0].totalCost?.toString?.() || boms[0].totalCost || 0) : null,
        quotationCount: quotations.length, orderCount: orders.length,
        totalOrderValue: orders.reduce((s: number, o: any) => s + orderAmountOf(o), 0),
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 6. 退税链：TaxRefund → CustomsDeclaration → ExportInvoice → PaymentReceipt
  // ══════════════════════════════════════════════════════════════════
  async function taxRefundChain(actor: TokenPayload | null | undefined, taxRefundId: string): Promise<TraceResult> {
    const taxRefund = await (prisma as any).taxRefund.findFirst({ where: { id: taxRefundId, deletedAt: null } });
    if (!taxRefund) throw new Error('NOT_FOUND');

    const [customs, invoices, payments] = await Promise.all([
      taxRefund.customsDeclarationId
        ? (prisma as any).customsDeclaration.findMany({ where: { id: taxRefund.customsDeclarationId }, take: 5 })
        : [],
      taxRefund.orderId
        ? (prisma as any).invoice.findMany({ where: { orderId: taxRefund.orderId, type: 'Receivable', deletedAt: null }, select: { id: true, invoiceNumber: true, status: true, amount: true, currency: true }, take: 20, orderBy: { createdAt: 'desc' } })
        : [],
      taxRefund.orderId
        ? (prisma as any).paymentVoucher.findMany({ where: { orderId: taxRefund.orderId, type: 'Receipt', deletedAt: null }, select: { id: true, voucherNumber: true, status: true, amount: true, currency: true, paymentDate: true }, take: 20, orderBy: { createdAt: 'desc' } })
        : [],
    ]);

    const nodes: TraceNode[] = [
      { id: taxRefund.id, type: 'TaxRefund', label: taxRefund.refundNumber || taxRefund.id, data: ser(taxRefund) },
      ...customs.map((c: any) => ({ id: c.id, type: 'Customs', label: c.declarationNumber || c.id, data: ser(c) })),
      ...invoices.map((i: any) => ({ id: i.id, type: 'Invoice', label: i.invoiceNumber || i.id, data: ser(i) })),
      ...payments.map((p: any) => ({ id: p.id, type: 'Payment', label: p.voucherNumber || p.id, data: ser(p) })),
    ];
    const edges: TraceEdge[] = [
      ...customs.map((c: any) => ({ from: taxRefund.id, to: c.id, relation: 'has_customs' })),
      ...invoices.map((i: any) => ({ from: taxRefund.id, to: i.id, relation: 'has_export_invoice' })),
      ...payments.map((p: any) => ({ from: taxRefund.id, to: p.id, relation: 'has_receipt' })),
    ];

    return {
      scenario: 'taxRefundChain', rootId: taxRefund.id, rootType: 'TaxRefund', nodes, edges,
      summary: {
        refundNumber: taxRefund.refundNumber, refundStatus: taxRefund.status,
        refundAmount: Number(taxRefund.refundAmount?.toString?.() || taxRefund.refundAmount || 0),
        customsStatus: customs[0]?.status || 'N/A',
        invoiceCount: invoices.length, receiptCount: payments.length,
        receiptTotal: payments.reduce((s: number, p: any) => s + Number(p.amount?.toString?.() || p.amount || 0), 0),
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 7. 采购库存链（W-C A1 · S2 三击追溯铁律）
  //    PurchaseOrder → MaterialReceipt → StockMovement → InventoryItem
  //    root 兼容两种入口：采购单 ID（正向）/ 库存物料 ID（反向）
  //    Native L8 uses MaterialReceipt; original PurchaseOrder receipt references
  //    remain readable for historical posting facts.
  //    （L8 自动入库契约，见 events/linkages/L8AutoStockIn.ts）
  //    权限：PurchaseOrder/InventoryItem 无 ownerId/departmentId 列（同 productCostChain），
  //    由 route 层 procurement:read 门禁拦截。
  // ══════════════════════════════════════════════════════════════════
  async function purchaseToStock(actor: TokenPayload | null | undefined, rootId: string): Promise<TraceResult> {
    const po = await (prisma as any).purchaseOrder.findFirst({ where: { id: rootId, deletedAt: null } });
    if (po) return purchaseOrderRoot(po);
    const item = await (prisma as any).inventoryItem.findFirst({ where: { id: rootId, deletedAt: null } });
    if (item) return inventoryItemRoot(item);
    throw new Error('NOT_FOUND');
  }

  async function purchaseOrderRoot(po: any): Promise<TraceResult> {
    const receipts = await (prisma as any).materialReceipt.findMany({
      where: { purchaseOrderId: po.id }, take: 50, orderBy: { createdAt: 'desc' },
    });
    const receiptIds = receipts.map((r: any) => r.id);
    const movements = receiptIds.length > 0
      ? await (prisma as any).stockMovement.findMany({
          where: { referenceType: { in: ['MaterialReceipt', 'PurchaseOrder'] }, referenceId: { in: receiptIds } },
          take: 100, orderBy: { createdAt: 'desc' },
        })
      : [];
    const itemIds = [...new Set(movements.map((m: any) => m.itemId as string))];
    const items = itemIds.length > 0
      ? await (prisma as any).inventoryItem.findMany({ where: { id: { in: itemIds }, deletedAt: null }, take: 100 })
      : [];

    const nodes: TraceNode[] = [
      { id: po.id, type: 'PurchaseOrder', label: po.poNumber || po.id, data: ser(po) },
      ...receipts.map((r: any) => ({ id: r.id, type: 'MaterialReceipt', label: r.receiptNumber || r.id, data: ser(r) })),
      ...movements.map((m: any) => ({ id: m.id, type: 'StockMovement', label: m.movementNumber || m.id, data: ser(m) })),
      ...items.map((i: any) => ({ id: i.id, type: 'InventoryItem', label: i.description || i.materialCode || i.id, data: ser(i) })),
    ];
    const edges: TraceEdge[] = [
      ...receipts.map((r: any) => ({ from: po.id, to: r.id, relation: 'has_receipt' })),
      ...movements.map((m: any) => ({ from: m.referenceId, to: m.id, relation: 'has_stock_movement' })),
      ...movements.map((m: any) => ({ from: m.id, to: m.itemId, relation: 'moves_item' })),
    ].filter((e) => e.from && e.to);

    return {
      scenario: 'purchaseToStock', rootId: po.id, rootType: 'PurchaseOrder', nodes, edges,
      summary: {
        poNumber: po.poNumber, poStatus: po.status,
        receiptCount: receipts.length,
        totalAccepted: receipts.reduce((s: number, r: any) => s + Number(r.totalAccepted?.toString?.() || r.totalAccepted || 0), 0),
        movementCount: movements.length, itemCount: items.length,
      },
    };
  }

  async function inventoryItemRoot(item: any): Promise<TraceResult> {
    const movements = await (prisma as any).stockMovement.findMany({
      where: { itemId: item.id }, take: 100, orderBy: { createdAt: 'desc' },
    });
    const receiptIds = [...new Set(
      movements
        .filter((m: any) => ['MaterialReceipt', 'PurchaseOrder'].includes(m.referenceType) && typeof m.referenceId === 'string' && m.referenceId)
        .map((m: any) => m.referenceId as string),
    )];
    const receipts = receiptIds.length > 0
      ? await (prisma as any).materialReceipt.findMany({ where: { id: { in: receiptIds } }, take: 50 })
      : [];
    const poIds = [...new Set(receipts.map((r: any) => r.purchaseOrderId as string))];
    const pos = poIds.length > 0
      ? await (prisma as any).purchaseOrder.findMany({ where: { id: { in: poIds }, deletedAt: null }, take: 20 })
      : [];

    const nodes: TraceNode[] = [
      { id: item.id, type: 'InventoryItem', label: item.description || item.materialCode || item.id, data: ser(item) },
      ...movements.map((m: any) => ({ id: m.id, type: 'StockMovement', label: m.movementNumber || m.id, data: ser(m) })),
      ...receipts.map((r: any) => ({ id: r.id, type: 'MaterialReceipt', label: r.receiptNumber || r.id, data: ser(r) })),
      ...pos.map((p: any) => ({ id: p.id, type: 'PurchaseOrder', label: p.poNumber || p.id, data: ser(p) })),
    ];
    const edges: TraceEdge[] = [
      ...movements.map((m: any) => ({ from: m.id, to: item.id, relation: 'moves_item' })),
      ...movements
        .filter((m: any) => ['MaterialReceipt', 'PurchaseOrder'].includes(m.referenceType) && m.referenceId)
        .map((m: any) => ({ from: m.referenceId as string, to: m.id, relation: 'has_stock_movement' })),
      ...receipts.map((r: any) => ({ from: r.purchaseOrderId, to: r.id, relation: 'has_receipt' })),
    ].filter((e) => e.from && e.to);

    return {
      scenario: 'purchaseToStock', rootId: item.id, rootType: 'InventoryItem', nodes, edges,
      summary: {
        itemDescription: item.description, materialCode: item.materialCode,
        currentQty: Number(item.quantity?.toString?.() || item.quantity || 0),
        movementCount: movements.length, receiptCount: receipts.length, poCount: pos.length,
      },
    };
  }

  // ── 统一分派入口 ──
  async function trace(
    actor: TokenPayload | null | undefined,
    scenario: TraceScenario,
    rootId: string,
  ): Promise<TraceResult> {
    logger.info('[Traceability] trace', { scenario, rootId, actorId: actor?.userId });
    switch (scenario) {
      case 'customerPanorama': return customerPanorama(actor, rootId);
      case 'orderFulfillment': return orderFulfillment(actor, rootId);
      case 'quoteToShip':      return quoteToShip(actor, rootId);
      case 'supplierPanorama': return supplierPanorama(actor, rootId);
      case 'productCostChain': return productCostChain(actor, rootId);
      case 'taxRefundChain':   return taxRefundChain(actor, rootId);
      case 'purchaseToStock':  return purchaseToStock(actor, rootId);
      default: throw new Error(`UNKNOWN_SCENARIO: ${scenario}`);
    }
  }

  return { trace };
}

// ── 单例 ──
let _svc: ReturnType<typeof createTraceabilityService> | null = null;
export function getTraceabilityService(prisma: PrismaClient) {
  if (!_svc) _svc = createTraceabilityService(prisma);
  return _svc;
}
