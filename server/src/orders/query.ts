import {orderQuantityDto} from '../shared/orderQuantityWriteGuard';
import { PrismaClient, Prisma } from '@prisma/client';
import { maskBomListItem } from '../bom/sensitiveMask';
import { andOrderScope, loadOrderQueryReadAccess, assertOrderReadAccessUnchanged, type OrderQueryReadContext } from './orderQueryReadAccess';
import { businessError } from '../shared/errorCodes';

export type StructuredOrderQueryInput = Record<string, unknown>;

export async function queryOrders(prisma: PrismaClient, input: StructuredOrderQueryInput = {}, context: OrderQueryReadContext = {}) {
  const access = await loadOrderQueryReadAccess(prisma, context);
  const normalized = normalizeOrderQuery(input);
  const where = andOrderScope(buildOrderQueryWhere(normalized), access.orderWhere);
  const orderBy = orderQueryOrderBy(normalized.sort);

  if (normalized.aggregate === 'count') {
    let count = await prisma.order.count({ where });
    if (access.actor) {
      const current = await loadOrderQueryReadAccess(prisma,context);
      assertOrderReadAccessUnchanged(access,current);
      count = await prisma.order.count({where:andOrderScope(buildOrderQueryWhere(normalized),current.orderWhere)});
      assertOrderReadAccessUnchanged(current,await loadOrderQueryReadAccess(prisma,context));
    }
    return {
      dataSource: 'bambook-data-center',
      entity: 'Order',
      aggregate: 'count',
      count,
      filters: normalized.filters,
      sort: normalized.sort,
    };
  }

  const [orders, initialTotal] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
      orderBy,
      take: normalized.limit,
      skip: normalized.offset,
    }),
    prisma.order.count({ where }),
  ]);

  let total = initialTotal;
  if (access.actor) {
    const current = await loadOrderQueryReadAccess(prisma,context);
    assertOrderReadAccessUnchanged(access,current);
    const visible = orders.length ? await prisma.order.findMany({
      where:andOrderScope({deletedAt:null,id:{in:orders.map(order=>order.id)}},current.orderWhere),select:{id:true},
    }) : [];
    if (visible.length !== orders.length) throw businessError('FORBIDDEN','读取期间订单归属发生变化，请重新查询。');
    total = await prisma.order.count({where:andOrderScope(buildOrderQueryWhere(normalized),current.orderWhere)});
    assertOrderReadAccessUnchanged(current,await loadOrderQueryReadAccess(prisma,context));
  }

  return {
    dataSource: 'bambook-data-center',
    entity: 'Order',
    aggregate: normalized.aggregate,
    query: normalized.query,
    filters: normalized.filters,
    sort: normalized.sort,
    total,
    count: orders.length,
    limit: normalized.limit,
    offset: normalized.offset,
    hasMore: normalized.offset + orders.length < total,
    items: orders.map(order => formatOrder(order)),
  };
}

export async function getOrder(prisma: PrismaClient, input: StructuredOrderQueryInput = {}) {
  const id = cleanText(input.id);
  const poNumber = cleanText(input.poNumber || input.po);
  const where = id
    ? { deletedAt: null, OR: [{ id }, { poNumber: id }] }
    : poNumber
      ? { poNumber, deletedAt: null }
      : null;
  if (!where) return { dataSource: 'bambook-data-center', found: false, reason: 'MISSING_ORDER_IDENTIFIER', input };
  const order = await prisma.order.findFirst({
    where: where as any,
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  return order
    ? { dataSource: 'bambook-data-center', found: true, item: formatOrder(order, true) }
    : { dataSource: 'bambook-data-center', found: false, input };
}

// ---------------------------------------------------------------------------
// 阶段 D / D3：订单全链路聚合（只读，直接查表制）
// 按业务阶段分组返回订单生命周期的全部关联实体摘要：
//   报价 → 开发 → BOM → 采购 → 生产(阶段+验货) → 外协 → 出运(报关+退税) → 财务(发票+核销+凭证)
// 各段只取摘要字段（id/编号/状态/金额/日期），不做全字段展开。
// 双轨制：EntityLink 图谱服务"关联面板"横向发现；本函数服务"全链路视图"纵向生命周期。
// ---------------------------------------------------------------------------

export async function getOrderContext(prisma: PrismaClient, orderIdRaw: unknown, context: OrderQueryReadContext = {}) {
  const access = await loadOrderQueryReadAccess(prisma,context);
  const id = cleanText(orderIdRaw);
  if (!id) return { found: false as const, reason: 'MISSING_ORDER_IDENTIFIER' };
  const order = await prisma.order.findFirst({
    where:andOrderScope({deletedAt:null,OR:[{id},{poNumber:id}]},access.orderWhere),
    select:{id:true,poNumber:true,settledAt:true,settledBy:true,sourceCaseId:true,
      lines:{select:{confirmedSourceType:true,confirmedSourceId:true}}},
  });
  if (!order) return {found:false as const};
  const db = prisma as any;
  const orderId = order.id;
  const active = {deletedAt:null};
  const restrictedStages = [
    ['quotation','quotations:read'],['development','products:read'],['bom','bom:read'],
    ['procurement','procurement:read'],['production','production:read'],['outsourcing','production:read'],
    ['shipment','shipments:read'],['customs','customs:read'],
    ['finance.invoices','invoices:read'],['finance.vouchers','vouchers:read'],
  ].filter(([,scope])=>!access.can(scope as any)).map(([stage])=>stage);

  // Read the immutable confirmed pointers. A later sample revision cannot erase provenance.
  const caseIdsFromSources = new Set<string>();
  if (access.can('products:read')) {
    if (order.sourceCaseId) caseIdsFromSources.add(order.sourceCaseId);
    const sourceIds = (type: string) => [...new Set(order.lines
      .filter(line=>line.confirmedSourceType===type && line.confirmedSourceId)
      .map(line=>line.confirmedSourceId!))];
    const sampleIds=sourceIds('Sample'),sealIds=sourceIds('SealSample');
    const [samples,seals] = await Promise.all([
      sampleIds.length ? db.sample.findMany({where:{...active,id:{in:sampleIds}},select:{sourceCaseId:true}}) : [],
      sealIds.length ? db.sealSample.findMany({where:{...active,id:{in:sealIds}},select:{developmentCaseId:true}}) : [],
    ]);
    for (const sample of samples) if(sample.sourceCaseId)caseIdsFromSources.add(sample.sourceCaseId);
    for (const seal of seals) if(seal.developmentCaseId)caseIdsFromSources.add(seal.developmentCaseId);
  }
  // Allocation tables are actual many-order sources, not the first-header projection.
  const [targetInvoiceLinks,targetShipmentLinks] = await Promise.all([
    access.can('invoices:read') ? db.invoiceOrderAllocation.findMany({where:{...active,orderId},select:{invoiceId:true}}) : [],
    access.can('shipments:read') ? db.shipmentOrderAllocation.findMany({where:{orderId},select:{shipmentId:true}}) : [],
  ]);
  const linkedInvoiceIds=[...new Set(targetInvoiceLinks.map((x:any)=>x.invoiceId))];
  const linkedShipmentIds=[...new Set(targetShipmentLinks.map((x:any)=>x.shipmentId))];
  const [quotations,developmentCases,rawBoms,purchaseOrders,productionStages,inspections,
    outsourcingOrders,shipments,invoices,vouchers] = await Promise.all([
    access.can('quotations:read') ? db.quotation.findMany({
      where:{...active,convertedOrderId:orderId},select:{id:true,quotationNumber:true,status:true,currency:true,totalAmount:true,issueDate:true},orderBy:{createdAt:'desc'},
    }) : [],
    access.can('products:read') ? db.developmentCase.findMany({
      where:{...active,OR:[{linkedOrderId:orderId},{id:{in:[...caseIdsFromSources]}}]},
      select:{id:true,code:true,name:true,type:true,stage:true,currentRound:true},orderBy:{createdAt:'desc'},
    }) : [],
    access.can('bom:read') ? db.bOM.findMany({where:{...active,orderId},select:{id:true,bomNumber:true,status:true,version:true,totalCost:true,currency:true},orderBy:{createdAt:'desc'}}) : [],
    access.can('procurement:read') ? db.purchaseOrder.findMany({where:{...active,orderId},
      select:{id:true,poNumber:true,status:true,supplierName:true,currency:true,totalAmount:true,orderDate:true,expectedDeliveryDate:true,actualDeliveryDate:true},orderBy:{createdAt:'desc'}}) : [],
    access.can('production:read') ? db.productionStage.findMany({where:{orderId},select:{id:true,stageKey:true,stageSeq:true,status:true,startedAt:true,doneAt:true},orderBy:{stageSeq:'asc'}}) : [],
    access.can('production:read') ? db.inspectionReport.findMany({where:{orderId},select:{id:true,inspectionType:true,result:true,inspectionDate:true,aqlLevel:true,criticalDefects:true,majorDefects:true,minorDefects:true},orderBy:{createdAt:'asc'}}) : [],
    access.can('production:read') ? db.outsourcingOrder.findMany({where:{...active,orderId},select:{id:true,orderNumber:true,processType:true,status:true,quantity:true,unit:true,plannedDeliveryDate:true,actualDeliveryDate:true,qualityAcceptedQty:true,qualityRejectedQty:true},orderBy:{createdAt:'desc'}}) : [],
    access.can('shipments:read') ? db.shipment.findMany({where:{...active,OR:[{orderId},{id:{in:linkedShipmentIds}}]},
      select:{id:true,orderId:true,shipmentNumber:true,status:true,shippingMethod:true,etd:true,atd:true,eta:true,ata:true,portOfLoading:true,portOfDischarge:true},orderBy:{createdAt:'desc'}}) : [],
    access.can('invoices:read') ? db.invoice.findMany({where:andOrderScope({...active,OR:[{orderId},{id:{in:linkedInvoiceIds}}]},access.financeWhere),
      select:{id:true,orderId:true,invoiceNumber:true,type:true,status:true,amount:true,currency:true,issueDate:true,dueDate:true,settlementDate:true},orderBy:{createdAt:'desc'}}) : [],
    access.can('vouchers:read') ? db.paymentVoucher.findMany({where:andOrderScope({...active,orderId},access.financeWhere),
      select:{id:true,voucherNumber:true,type:true,status:true,amount:true,currency:true,paymentDate:true,invoiceId:true},orderBy:{createdAt:'desc'}}) : [],
  ]);
  const boms=rawBoms.map((bom:any)=>maskBomListItem(bom,{cost:access.can('sensitive:cost')}));
  const caseIds=developmentCases.map((c:any)=>c.id);
  const shipmentIds=shipments.map((s:any)=>s.id),invoiceIds=invoices.map((i:any)=>i.id);
  const [invoiceSources,shipmentSources] = await Promise.all([
    invoiceIds.length ? db.invoiceOrderAllocation.findMany({where:{...active,invoiceId:{in:invoiceIds}},select:{invoiceId:true,orderId:true,allocatedAmount:true}}) : [],
    shipmentIds.length ? db.shipmentOrderAllocation.findMany({where:{shipmentId:{in:shipmentIds}},select:{shipmentId:true,orderId:true}}) : [],
  ]);
  const invoiceOrders = new Map<string,Set<string>>(), shipmentOrders = new Map<string,Set<string>>();
  const addSource=(map:Map<string,Set<string>>,key:string,source:string|null)=>{
    if(!source)return;const ids=map.get(key)??new Set<string>();ids.add(source);map.set(key,ids);
  };
  for(const invoice of invoices)addSource(invoiceOrders,invoice.id,invoice.orderId);
  for(const link of invoiceSources)addSource(invoiceOrders,link.invoiceId,link.orderId);
  for(const shipment of shipments)addSource(shipmentOrders,shipment.id,shipment.orderId);
  for(const link of shipmentSources)addSource(shipmentOrders,link.shipmentId,link.orderId);
  const allSourceOrderIds=[...new Set([...invoiceOrders.values(),...shipmentOrders.values()].flatMap(ids=>[...ids]))];
  const visibleSources = allSourceOrderIds.length ? await prisma.order.findMany({
    where:andOrderScope({...active,id:{in:allSourceOrderIds}},access.orderWhere),select:{id:true},
  }) : [];
  const visibleSourceIds=new Set(visibleSources.map(row=>row.id));
  const invoiceShared=(invoiceId:string)=>(invoiceOrders.get(invoiceId)?.size??0)>1;
  const invoiceTotalVisible=(invoiceId:string)=>[...(invoiceOrders.get(invoiceId)??[])].every(source=>visibleSourceIds.has(source));
  const shipmentShared=(shipmentId:string)=>(shipmentOrders.get(shipmentId)?.size??0)>1;
  const [sampleBatches,customsDeclarations,rawAllocations] = await Promise.all([
    caseIds.length ? db.sampleBatch.findMany({where:{...active,developmentCaseId:{in:caseIds}},select:{id:true,developmentCaseId:true,sampleType:true,round:true,status:true,confirmStatus:true,confirmedAt:true,sentDate:true,approvedAt:true},orderBy:{createdAt:'asc'}}) : [],
    access.can('customs:read') ? db.customsDeclaration.findMany({where:{...active,OR:[{orderId},{AND:[{shipmentId:{in:shipmentIds}},{OR:[{orderId:null},{orderId}]}]}]},
      select:{id:true,orderId:true,declarationNumber:true,status:true,shipmentId:true,declarationDate:true,totalValue:true,currency:true},orderBy:{createdAt:'desc'}}) : [],
    invoiceIds.length ? db.invoiceAllocation.findMany({where:{invoiceId:{in:invoiceIds}},select:{id:true,invoiceId:true,voucherId:true,appliedAmount:true,appliedDate:true},orderBy:{createdAt:'asc'}}) : [],
  ]);
  const allocationVoucherIds=[...new Set(rawAllocations.map((a:any)=>a.voucherId))];
  const readableVouchers=access.can('vouchers:read') && allocationVoucherIds.length ? await db.paymentVoucher.findMany({
    where:andOrderScope({...active,id:{in:allocationVoucherIds}},access.financeWhere),select:{id:true},
  }) : [];
  const readableVoucherIds=new Set(readableVouchers.map((v:any)=>v.id));
  const allocations=rawAllocations.map((allocation:any)=>({...allocation,
    voucherId:readableVoucherIds.has(allocation.voucherId)?allocation.voucherId:null,
    appliedAmount:invoiceShared(allocation.invoiceId)?null:allocation.appliedAmount,
    ...(invoiceShared(allocation.invoiceId)?{sharedSource:true}:{})}));
  const declarationIds=customsDeclarations.map((d:any)=>d.id);
  const declarationShared=new Set(customsDeclarations.filter((d:any)=>d.shipmentId && shipmentShared(d.shipmentId)).map((d:any)=>d.id));
  const taxRefunds=access.can('customs:read') ? await db.taxRefund.findMany({
    where:{...active,OR:[{orderId},{AND:[{declarationId:{in:declarationIds}},{OR:[{orderId:null},{orderId}]}]}]},
    select:{id:true,orderId:true,refundNumber:true,status:true,declarationId:true,exportAmountFob:true,exportAmountFobCurrency:true,refundAmount:true,refundDate:true},orderBy:{createdAt:'desc'},
  }) : [];
  for(const declaration of customsDeclarations)if(declarationShared.has(declaration.id)){
    declaration.totalValue=null;declaration.sharedSource=true;
  }
  for(const refund of taxRefunds)if(refund.declarationId && declarationShared.has(refund.declarationId)){
    refund.exportAmountFob=null;refund.refundAmount=null;refund.sharedSource=true;
  }
  // Do not expose internal other-order/source IDs used only to decide disclosure.
  for(const declaration of customsDeclarations)delete declaration.orderId;
  for(const refund of taxRefunds)delete refund.orderId;
  for(const invoice of invoices){
    const share=invoiceSources.find((link:any)=>link.invoiceId===invoice.id && link.orderId===orderId);
    invoice.orderAllocatedAmount=share?.allocatedAmount == null ? null : String(share.allocatedAmount);
    invoice.sharedSource=invoiceShared(invoice.id);
    invoice.amountScope=invoiceTotalVisible(invoice.id)?'invoice_total':'restricted_shared';
    if(!invoiceTotalVisible(invoice.id))invoice.amount=null;
    delete invoice.orderId;
  }
  for(const shipment of shipments){shipment.sharedSource=shipmentShared(shipment.id);delete shipment.orderId;}
  // The response is discarded if account/grants, parent ownership or source visibility changed.
  if(access.actor){
    const current=await loadOrderQueryReadAccess(prisma,context);
    const stillVisible=await prisma.order.findFirst({where:andOrderScope({...active,id:orderId},current.orderWhere),select:{id:true}});
    if(!stillVisible)return {found:false as const};
    assertOrderReadAccessUnchanged(access,current);
    const currentSources=allSourceOrderIds.length ? await prisma.order.findMany({where:andOrderScope({...active,id:{in:allSourceOrderIds}},current.orderWhere),select:{id:true}}) : [];
    if(currentSources.map(row=>row.id).sort().join('\0')!==visibleSources.map(row=>row.id).sort().join('\0'))throw businessError('FORBIDDEN','读取期间关联订单范围发生变化，请重新查询。');
    const [currentInvoices,currentVouchers,currentReceiptVouchers]=await Promise.all([
      invoiceIds.length ? db.invoice.findMany({where:andOrderScope({...active,id:{in:invoiceIds}},current.financeWhere),select:{id:true}}) : [],
      vouchers.length ? db.paymentVoucher.findMany({where:andOrderScope({...active,id:{in:vouchers.map((v:any)=>v.id)}},current.financeWhere),select:{id:true}}) : [],
      readableVouchers.length ? db.paymentVoucher.findMany({where:andOrderScope({...active,id:{in:[...readableVoucherIds]}},current.financeWhere),select:{id:true}}) : [],
    ]);
    if(currentInvoices.length!==invoices.length || currentVouchers.length!==vouchers.length || currentReceiptVouchers.length!==readableVouchers.length)throw businessError('FORBIDDEN','读取期间财务记录归属发生变化，请重新查询。');
    assertOrderReadAccessUnchanged(current,await loadOrderQueryReadAccess(prisma,context));
  }

  // 嵌套装配：开发节点 ← SampleBatch（确认锚点），映射为节点形状（level=批次类型，status=确认态》批次态），前端消费兼容
  const nodesByCase = new Map<string, any[]>();
  for (const b of sampleBatches as any[]) {
    const list = nodesByCase.get(b.developmentCaseId) ?? [];
    list.push({
      id: b.id,
      developmentCaseId: b.developmentCaseId,
      level: b.sampleType, // garment-round / lab-dip / handloom / yardage …
      round: b.round,
      status: b.confirmStatus === 'confirmed' ? 'approved' : (b.status ?? 'pending'),
      sentDate: b.sentDate ?? null,
      approvedAt: b.confirmedAt ?? b.approvedAt ?? null,
    });
    nodesByCase.set(b.developmentCaseId, list);
  }
  const refundsByDeclaration = new Map<string, any[]>();
  const orphanRefunds: any[] = [];
  for (const r of taxRefunds as any[]) {
    if (r.declarationId && declarationIds.includes(r.declarationId)) {
      const list = refundsByDeclaration.get(r.declarationId) ?? [];
      list.push(r);
      refundsByDeclaration.set(r.declarationId, list);
    } else {
      orphanRefunds.push(r);
    }
  }
  const declarationsByShipment = new Map<string, any[]>();
  const orphanDeclarations: any[] = [];
  for (const d of customsDeclarations as any[]) {
    const withRefunds = { ...d, taxRefunds: refundsByDeclaration.get(d.id) ?? [] };
    if (d.shipmentId && shipmentIds.includes(d.shipmentId)) {
      const list = declarationsByShipment.get(d.shipmentId) ?? [];
      list.push(withRefunds);
      declarationsByShipment.set(d.shipmentId, list);
    } else {
      orphanDeclarations.push(withRefunds);
    }
  }
  const allocationsByInvoice = new Map<string, any[]>();
  for (const a of allocations as any[]) {
    const list = allocationsByInvoice.get(a.invoiceId) ?? [];
    list.push(a);
    allocationsByInvoice.set(a.invoiceId, list);
  }

  return serializeBigInts({
    found: true as const,
    order: { id: order.id, poNumber: order.poNumber, settledAt: order.settledAt ?? undefined, settledBy: order.settledBy ?? undefined },
    restrictedStages,
    quotation: quotations,
    developmentCase: (developmentCases as any[]).map((c) => ({ ...c, sampleNodes: nodesByCase.get(c.id) ?? [] })),
    bom: boms,
    procurement: purchaseOrders,
    production: { stages: productionStages, inspections },
    outsourcing: outsourcingOrders,
    shipments: (shipments as any[]).map((s) => ({ ...s, customsDeclarations: declarationsByShipment.get(s.id) ?? [] })),
    customsDeclarations: orphanDeclarations,
    taxRefunds: orphanRefunds,
    finance: {
      invoices: (invoices as any[]).map((i) => ({ ...i, allocations: allocationsByInvoice.get(i.id) ?? [] })),
      vouchers,
    },
  });
}


export function describeOrderSchema() {
  return {
    entity: 'Order',
    sourceOfTruth: 'Bambook backend database',
    purpose: '让 Agent 像订单页面一样按订单号、客户、供应商、交期、状态、发票、样品和生产字段做只读查询。',
    tools: {
      query: { id: 'orders.query', useWhen: '需要 count/list/detail 模式、筛选、排序和分页读取订单。' },
      get: { id: 'orders.get', useWhen: '已有订单 id 或 PO，需要读取单条订单与订单行。' },
    },
    fields: [
      'id', 'poNumber', 'customer', 'customerCode', 'status', 'product', 'type',
      'dueDate', 'clientDate', 'productionDate', 'shipmentDate', 'invoiceNumber',
      'deliveryTerms', 'deliveryPlace', 'contractDeliveryDate', 'expectedArrivalDate', 'agreedArrivalDate',
      'supplierInvoiceNumber', 'millName', 'billToName', 'consigneeName',
      'paymentTerms', 'salesCurrency', 'purchaseCurrency', 'sampleSentDate',
      'fabricSampleSentDate', 'productionBatch', 'fabricCode', 'fabricContent',
      'lines.materialCode', 'lines.millQuality', 'lines.description', 'lines.deliveryDate',
    ],
    aggregateModes: ['count', 'list', 'detail'],
    writableNow: false,
  };
}

function normalizeOrderQuery(input: StructuredOrderQueryInput) {
  const filters = input && typeof input.filters === 'object' && input.filters ? input.filters as Record<string, unknown> : {};
  const sort = input && typeof input.sort === 'object' && input.sort ? input.sort as Record<string, unknown> : {};
  return {
    aggregate: cleanText(input.aggregate) === 'count' ? 'count' : cleanText(input.aggregate) === 'detail' ? 'detail' : 'list',
    query: cleanText(input.query),
    filters: {
      statuses: arrayOfText(filters.statuses || filters.status),
      customer: cleanText(filters.customer),
      supplier: cleanText(filters.supplier || filters.millName),
      poNumber: cleanText(filters.poNumber || filters.po),
      dueDateFrom: cleanDate(filters.dueDateFrom),
      dueDateTo: cleanDate(filters.dueDateTo),
      createdAtFrom: cleanDate(filters.createdAtFrom || filters.createdFrom),
      createdAtTo: cleanDate(filters.createdAtTo || filters.createdTo),
      missingFields: arrayOfText(filters.missingFields),
      fieldFilters: normalizeFieldFilters(filters.fieldFilters),
    },
    sort: {
      field: cleanText(sort.field) || 'updatedAt',
      direction: cleanText(sort.direction).toLowerCase() === 'asc' ? 'asc' : 'desc',
    },
    limit: numberInput(input.limit, cleanText(input.aggregate) === 'detail' ? 1 : 20, 1, 200),
    offset: numberInput(input.offset, 0, 0, 1_000_000),
  };
}

function buildOrderQueryWhere(input: ReturnType<typeof normalizeOrderQuery>) {
  const and: any[] = [{ deletedAt: null }];
  const textContains = (value: string) => ({ contains: value, mode: 'insensitive' as const });

  if (input.query) {
    and.push({
      OR: [
        { id: input.query },
        { poNumber: textContains(input.query) },
        { customer: textContains(input.query) },
        { customerCode: textContains(input.query) },
        { product: textContains(input.query) },
        { millName: textContains(input.query) },
        { billToName: textContains(input.query) },
        { consigneeName: textContains(input.query) },
        { invoiceNumber: textContains(input.query) },
        { supplierInvoiceNumber: textContains(input.query) },
        { fabricCode: textContains(input.query) },
        { fabricContent: textContains(input.query) },
        { lines: { some: { materialCode: textContains(input.query) } } },
        { lines: { some: { millQuality: textContains(input.query) } } },
        { lines: { some: { description: textContains(input.query) } } },
      ],
    });
  }
  if (input.filters.poNumber) and.push({ poNumber: textContains(input.filters.poNumber) });
  if (input.filters.customer) {
    and.push({
      OR: [
        { customer: textContains(input.filters.customer) },
        { billToName: textContains(input.filters.customer) },
        { customerCode: textContains(input.filters.customer) },
      ],
    });
  }
  if (input.filters.supplier) {
    and.push({
      OR: [
        { millName: textContains(input.filters.supplier) },
        { millRelationId: textContains(input.filters.supplier) },
        { lines: { some: { millQuality: textContains(input.filters.supplier) } } },
      ],
    });
  }
  if (input.filters.statuses.length) {
    and.push({ OR: input.filters.statuses.map(status => ({ status: textContains(status) })) });
  }
  if (input.filters.dueDateFrom) and.push({ dueDate: { gte: input.filters.dueDateFrom } });
  if (input.filters.dueDateTo) and.push({ dueDate: { lte: input.filters.dueDateTo } });
  if (input.filters.createdAtFrom) {
    const ts = Date.parse(input.filters.createdAtFrom);
    if (Number.isFinite(ts)) and.push({ createdAt: { gte: BigInt(ts) } });
  }
  if (input.filters.createdAtTo) {
    const ts = Date.parse(input.filters.createdAtTo);
    if (Number.isFinite(ts)) and.push({ createdAt: { lte: BigInt(ts) } });
  }
  for (const field of input.filters.missingFields) {
    const mapped = ORDER_QUERY_FIELDS[field] || field;
    if (ORDER_QUERY_FIELDS[field] || SAFE_ORDER_FIELDS.has(mapped)) {
      and.push({ OR: [{ [mapped]: null }, { [mapped]: '' }] });
    }
  }
  for (const filter of input.filters.fieldFilters) {
    const where = orderFieldFilterWhere(filter);
    if (where) and.push(where);
  }
  return and.length === 1 ? and[0] : { AND: and };
}

function orderFieldFilterWhere(filter: { path: string; operator: string; value: unknown }) {
  const mapped = ORDER_QUERY_FIELDS[filter.path] || filter.path;
  if (!SAFE_ORDER_FIELDS.has(mapped)) return null;
  const value = cleanText(filter.value);
  if (!value) return null;
  if (filter.operator === 'equals') return { [mapped]: { equals: value, mode: 'insensitive' as const } };
  if (filter.operator === 'missing') return { OR: [{ [mapped]: null }, { [mapped]: '' }] };
  return { [mapped]: { contains: value, mode: 'insensitive' as const } };
}

function orderQueryOrderBy(sort: { field: string; direction: string }) {
  const direction = sort.direction === 'asc' ? 'asc' : 'desc';
  const field = ORDER_SORT_FIELDS.has(sort.field) ? sort.field : 'updatedAt';
  return { [field]: direction };
}

function formatOrder(order: any, full = false) {
  const base = serializeBigInts({
    id: order.id,
    poNumber: order.poNumber,
    customer: order.customer,
    customerCode: order.customerCode,
    product: order.product,
    type: order.type,
    quantity: orderQuantityDto(order).quantity,
    unit: orderQuantityDto(order).unit,
    quantitySummary: orderQuantityDto(order).quantitySummary,
    status: order.status,
    dueDate: order.dueDate,
    clientDate: order.clientDate,
    productionDate: order.productionDate,
    deliveryTerms: order.deliveryTerms,
    deliveryPlace: order.deliveryPlace,
    contractDeliveryDate: order.contractDeliveryDate,
    expectedArrivalDate: order.expectedArrivalDate,
    agreedArrivalDate: order.agreedArrivalDate,
    shipmentDate: order.shipmentDate,
    invoiceNumber: order.invoiceNumber,
    supplierInvoiceNumber: order.supplierInvoiceNumber,
    millName: order.millName,
    billToName: order.billToName,
    consigneeName: order.consigneeName,
    paymentTerms: order.paymentTerms,
    salesCurrency: order.salesCurrency,
    purchaseCurrency: order.purchaseCurrency,
    updatedAt: order.updatedAt,
    importedAt: order.importedAt,
  });
  if (!full) {
    return {
      ...base,
      lines: Array.isArray(order.lines) ? order.lines.slice(0, 5).map(formatOrderLine) : [],
    };
  }
  return serializeBigInts({ ...order, lines: Array.isArray(order.lines) ? order.lines.map(formatOrderLine) : [] });
}

function formatOrderLine(line: any) {
  return serializeBigInts({
    id: line.id,
    lineNumber: line.lineNumber,
    itemNo: line.itemNo,
    materialCode: line.materialCode,
    millQuality: line.millQuality,
    description: line.description,
    cloth: line.cloth,
    width: line.width,
    weight: line.weight,
    category: line.category,
    deliveryDate: line.deliveryDate,
    exMillDate: line.exMillDate,
    quantity: line.quantity.toString(),
    unit: line.unit,
    unitPrice: line.unitPrice,
    netValue: line.netValue,
    status: line.status,
    productionBatch: line.productionBatch,
    shippingDate: line.shippingDate,
    shippingMethod: line.shippingMethod,
    invoiceNumber: line.invoiceNumber,
    invoiceDate: line.invoiceDate,
    shipmentQuantity: line.shipmentQuantity,
    shipmentAmount: line.shipmentAmount,
    actualPaymentDate: line.actualPaymentDate,
    actualPaymentAmount: line.actualPaymentAmount,
    specialInstructions: line.specialInstructions,
    notes: line.notes,
    via: line.via,
    styleNo: line.styleNo,
    colorName: line.colorName,
    sizeBreakdown: line.sizeBreakdown,
    productionSteps: line.productionSteps,
    bomItems: line.bomItems,
    garmentSampleStages: line.garmentSampleStages,
    fieldSources: line.fieldSources,
  });
}

function normalizeFieldFilters(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter(Boolean)
    .map(item => ({
      path: cleanText(item!.path),
      operator: cleanText(item!.operator) || 'contains',
      value: item!.value,
    }))
    .filter(item => item.path)
    .slice(0, 20);
}

function arrayOfText(value: unknown) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw.map(cleanText).filter(Boolean).slice(0, 20);
}

function cleanText(value: unknown) {
  return String(value ?? '').trim();
}

function cleanDate(value: unknown) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

function numberInput(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

function serializeBigInts<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  if (Prisma.Decimal.isDecimal(value)) return Number(value) as T;
  if (Array.isArray(value)) return value.map(serializeBigInts) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = serializeBigInts(item);
    return out as T;
  }
  return value;
}

const ORDER_QUERY_FIELDS: Record<string, string> = {
  po: 'poNumber',
  customerName: 'customer',
  supplier: 'millName',
  supplierInvoice: 'supplierInvoiceNumber',
  invoice: 'invoiceNumber',
  exmill: 'clientDate',
};

const SAFE_ORDER_FIELDS = new Set([
  'id', 'poNumber', 'customer', 'customerCode', 'product', 'type', 'status',
  'dueDate', 'clientDate', 'productionDate', 'shipmentDate', 'invoiceNumber',
  'supplierInvoiceNumber', 'millName', 'billToName', 'consigneeName',
  'paymentTerms', 'salesCurrency', 'purchaseCurrency', 'fabricCode',
  'fabricContent', 'productionBatch', 'sampleSentDate', 'fabricSampleSentDate',
]);

const ORDER_SORT_FIELDS = new Set(['updatedAt', 'importedAt', 'dueDate', 'clientDate', 'customer', 'status', 'poNumber']);
