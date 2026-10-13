/** Actual fulfillment records in the persisted Mist workspace. No fixture import. */
import {developmentDomain} from './mistDevelopmentDomain';
import { MistCommandError, lineAmount, mistMoneyMinor, assertMistOrderApproved, assertMistOrderDeposit, isActiveMistInvoice } from './mistWorkspace';
import type { MistState, MistContext, MistCommandResult, MistQc, MistTarget, MistProduction } from './mistWorkspace';
import type { MistReviewTask } from './mistReview';
import {applyClaimInventoryCommand,claimInventoryPermission,type ClaimInventoryCommand,type ClaimInventoryWarehouse,type ClaimReturnReceipt,type ClaimReceivedRecord} from './mistClaimInventory';
export type FulfillmentSource = {
    kind: 'version';
    devId: string;
    versionId: string;
} | {
    kind: 'orderLine';
    orderId: string;
    lineId: string;
    productionId?: string;
} | {
    kind: 'manual';
    description: string;
};
export type FulfillmentPosition = { location: string; available: number };
export type FulfillmentSampleRole = 'pp' | 'pioneer' | 'shipping';
export type FulfillmentSizeQuantity = { size: string; quantity: number };
export type FulfillmentProductionFact = {
    productionId: string;
    sizes: FulfillmentSizeQuantity[];
    revision: number;
    release?: { at: string; actor: string; note: string };
    completion?: { id: string; quantity: number; sizeQuantities: FulfillmentSizeQuantity[]; date: string; at: string; actor: string; evidence: string; fileIds: string[] };
    customerAcceptance?: { at: string; actor: string; note: string; completionId: string };
};
export type FulfillmentSample = {
    id: string;
    code: string;
    name: string;
    category: string;
    form: string;
    unit: string;
    quantity: number;
    available: number;
    location: string;
    positions?: FulfillmentPosition[];
    size: string;
    color: string;
    source: FulfillmentSource;
    sourceSampleCode?: string;
    role?: FulfillmentSampleRole;
    shipmentId?: string;
    qualityRevision?: number;
    fileIds: string[];
    note: string;
    createdAt: string;
};
export type SampleMovement = {
    id: string;
    sampleId: string;
    kind: 'receive' | 'lend' | 'return' | 'send' | 'move';
    quantity: number;
    person: string;
    location: string;
    note: string;
    at: string;
    actor: string;
    loanId?: string;
    expectedReturn?: string;
    sourceLocation?: string;
};
export type FulfillmentQcTask = {
    id: string;
    code: string;
    source: Exclude<FulfillmentSource, {
        kind: 'manual';
    }>;
    domain: 'garment' | 'fabric';
    kind: 'sample' | 'production';
    sampleId?: string;
    factory: string;
    location: string;
    contact: string;
    due: string;
    requestedBy: string;
    assignee: string;
    assigneeId?: string;
    state: 'pending' | 'working' | 'reported' | 'blocked' | 'awaiting_business';
    reportIds: string[];
    createdAt: string;
    businessConfirmation?: {
        result: 'approved' | 'rejected';
        note: string;
        actor: string;
        at: string;
    };
    businessContinued?: { reportId: string; actor: string; at: string; note: string };
};
export type FulfillmentQcReport = {
    id: string;
    taskId: string;
    result: MistQc['result'];
    report: string;
    opinion: string;
    measurements: NonNullable<MistQc['measurements']>;
    fileIds: string[];
    reviewer: string;
    reviewedAt: string;
    previousReportId?: string;
    scopeRevision?: number;
    sizeChecks?: Array<{ size: string; inspected: number; result: 'pass' | 'reject'; evidence: string }>;
};
export type FulfillmentPurchase = {
    id: string;
    code: string;
    orderId: string;
    lineId: string;
    kind: 'material' | 'finished' | 'processing';
    domain: 'garment' | 'fabric';
    supplierId: string;
    supplier: string;
    description: string;
    quantity: number;
    unit: string;
    price: number;
    currency: string;
    due: string;
    terms: string;
    destination: string;
    note: string;
    fileIds: string[];
    state: 'draft' | 'pending' | 'approved' | 'rejected';
    requesterId: string;
    createdBy: string;
    createdAt: string;
    submittedAt?: string;
    reviewerIds: string[];
    configVersions: Record<string, number>;
    decision?: {
        actorId: string;
        actor: string;
        at: string;
        decision: 'approved' | 'rejected';
        note: string;
    };
    received: number;
    revisionHistory?: FulfillmentPurchaseRevision[];
    offlineSend?: { at: string; actor: string; evidence: string; fileIds: string[]; revision: number };
    supplierConfirmation?: { at: string; actor: string; evidence: string; confirmedDue: string; fileIds: string[]; revision: number };
};
export type FulfillmentPurchaseRevision = {
    revision: number;
    submittedAt: string;
    requesterId: string;
    reviewerIds: string[];
    configVersions: Record<string, number>;
    snapshot: Pick<FulfillmentPurchase, 'orderId' | 'lineId' | 'kind' | 'supplierId' | 'supplier' | 'description' | 'quantity' | 'unit' | 'price' | 'currency' | 'due' | 'terms' | 'destination' | 'note' | 'fileIds'>;
    decision?: FulfillmentPurchase['decision'];
};
export type FulfillmentReceipt = {
    id: string;
    purchaseId: string;
    quantity: number;
    rejected: number;
    destination: 'warehouse' | 'supplier';
    location: string;
    date: string;
    evidence: string;
    fileIds: string[];
    actor: string;
    createdAt: string;
};
export type FulfillmentStock = {
    id: string;
    purchaseId?: string;
    receiptId?: string;
    sourceKind?: 'purchase' | 'claimReturn';
    claimId?: string;
    dispositionId?: string;
    goodsId?: string;
    invoiceId?: string;
    returnReceiptId?: string;
    receivedEventId?: string;
    orderId: string;
    lineId: string;
    name: string;
    unit: string;
    quantity: number;
    available: number;
    onHand?: number;
    locked?: number;
    warehouseId?: string;
    batchNumber?: string;
    ownership?: 'Owned' | 'Transferred';
    ownerCustomerId?: string;
    ownershipDate?: string;
    ownershipEvidence?: string;
    location: string;
    positions?: FulfillmentPosition[];
    owner: string;
    createdAt: string;
};
export type FulfillmentStockMovement = {
    id: string;
    stockId: string;
    kind: 'receive' | 'issue' | 'return' | 'move' | 'lock' | 'unlock' | 'scrap';
    quantity: number;
    location: string;
    person: string;
    note: string;
    at: string;
    actor: string;
    issueId?: string;
    sourceLocation?: string;
    unit?: string;
    warehouseId?: string;
    goodsId?: string;
    receivedEventId?: string;
    onHandBefore?: number;
    onHandAfter?: number;
    lockedBefore?: number;
    lockedAfter?: number;
};
export type ShipmentLine = {
    lineId: string;
    orderId: string;
    productionId?: string;
    quantity: number;
    factoryConfirmedAt: string;
};
export type FulfillmentShipment = {
    id: string;
    code: string;
    customerId: string;
    customer: string;
    domain: 'garment' | 'fabric';
    consignee: string;
    mode: 'sea' | 'air';
    portOfLoading: string;
    portOfDischarge: string;
    incoterm: string;
    plannedDate: string;
    booking: string;
    lines: ShipmentLine[];
    note: string;
    fileIds: string[];
    state: 'preparing' | 'ready' | 'departed' | 'cancelled';
    requestedBy: string;
    requesterId: string;
    createdAt: string;
    documentsSentAt?: string;
    documentDispatches?: Array<{ id: string; at: string; actor: string; documentIds: string[] }>;
    departedAt?: string;
    departureEvidence?: string;
    cancelReason?: string;
};
export type FulfillmentPacking = {
    id: string;
    shipmentId: string;
    lineId: string;
    productionId?: string;
    carton: string;
    quantity: number;
    netWeight: number;
    grossWeight: number;
    volume: number;
    note: string;
};
export type FulfillmentCustoms = {
    id: string;
    shipmentId: string;
    code: string;
    status: 'draft' | 'submitted' | 'cleared';
    declarationNo: string;
    broker: string;
    hsCode: string;
    origin: string;
    tradeMode: string;
    declaredAt: string;
    clearedAt: string;
    evidence: string;
    fileIds: string[];
    note: string;
};
export type FulfillmentDocument = {
    id: string;
    shipmentId: string;
    orderId: string;
    type: 'CI' | 'PL' | 'BL' | 'CO' | 'OTHER';
    number: string;
    version: number;
    title: string;
    dueDate: string;
    content: string;
    fileIds: string[];
    status: 'draft' | 'issued' | 'void';
    createdAt: string;
    issuedAt?: string;
    actor: string;
    invoiceId?: string;
    externalIssue?: { issuer: string; at: string; evidence: string; recordedBy: string };
};
export type FulfillmentShippingTerms = {
    orderId: string;
    consignee: string;
    partialAllowed: boolean;
    mode: 'sea' | 'air';
    confirmedAt: string;
    evidence: string;
};
export type FulfillmentState = {
    warehouses: ClaimInventoryWarehouse[];
    returnReceipts: ClaimReturnReceipt[];
    receivedRecords: ClaimReceivedRecord[];
    productionFacts: FulfillmentProductionFact[];
    shippingTerms: FulfillmentShippingTerms[];
    samples: FulfillmentSample[];
    sampleMovements: SampleMovement[];
    qcTasks: FulfillmentQcTask[];
    qcReports: FulfillmentQcReport[];
    purchases: FulfillmentPurchase[];
    receipts: FulfillmentReceipt[];
    stock: FulfillmentStock[];
    stockMovements: FulfillmentStockMovement[];
    shipments: FulfillmentShipment[];
    packing: FulfillmentPacking[];
    customs: FulfillmentCustoms[];
    documents: FulfillmentDocument[];
};
type PurchaseInput = Pick<FulfillmentPurchase, 'orderId' | 'lineId' | 'kind' | 'supplierId' | 'supplier' | 'description' | 'quantity' | 'unit' | 'price' | 'currency' | 'due' | 'terms' | 'destination' | 'note' | 'fileIds'>;
type SampleInput = Pick<FulfillmentSample, 'name' | 'category' | 'form' | 'unit' | 'quantity' | 'location' | 'size' | 'color' | 'source' | 'fileIds' | 'note' | 'role' | 'shipmentId'>;
type ShipmentInput = Pick<FulfillmentShipment, 'consignee' | 'mode' | 'portOfLoading' | 'portOfDischarge' | 'incoterm' | 'plannedDate' | 'booking' | 'lines' | 'note' | 'fileIds'>;
export type FulfillmentCommand = {
    type: 'fulfillment.samples.create';
    payload: SampleInput;
} | {
    type: 'fulfillment.samples.sync';
    payload: Record<string, never>;
} | {
    type: 'fulfillment.samples.edit';
    payload: {
        id: string;
        location: string;
        note: string;
        fileIds: string[];
        name?: string;
        form?: string;
        size?: string;
        color?: string;
    };
} | {
    type: 'fulfillment.samples.move';
    payload: {
        id: string;
        kind: 'lend' | 'return' | 'send' | 'move';
        quantity: number;
        person: string;
        location: string;
        note: string;
        loanId?: string;
        expectedReturn?: string;
        sourceLocation?: string;
    };
} | {
    type: 'fulfillment.qc.request';
    payload: {
        source: Exclude<FulfillmentSource, {
            kind: 'manual';
        }>;
        domain: 'garment' | 'fabric';
        kind: 'sample' | 'production';
        factory: string;
        location: string;
        contact: string;
        due: string;
        sampleId?: string;
    };
} | {
    type: 'fulfillment.qc.claim';
    payload: {
        id: string;
        domain: 'garment' | 'fabric';
    };
} | {
    type: 'fulfillment.qc.report';
    payload: {
        id: string;
        domain: 'garment' | 'fabric';
        result: MistQc['result'];
        report: string;
        opinion: string;
        measurements: NonNullable<MistQc['measurements']>;
        fileIds: string[];
        reviewedAt: string;
        sizeChecks?: NonNullable<FulfillmentQcReport['sizeChecks']>;
    };
} | {
    type: 'fulfillment.qc.confirm';
    payload: {
        id: string;
        result: 'approved' | 'rejected';
        note: string;
    };
} | {
    type: 'fulfillment.qc.continue';
    payload: {
        id: string;
        note: string;
    };
} | {
    type: 'fulfillment.procurement.save';
    payload: PurchaseInput & {
        id?: string;
    };
} | {
    type: 'fulfillment.procurement.submit';
    payload: {
        id: string;
    };
} | {
    type: 'fulfillment.procurement.decide';
    payload: {
        id: string;
        decision: 'approved' | 'rejected';
        note: string;
    };
} | {
    type: 'fulfillment.procurement.receive';
    payload: {
        id: string;
        quantity: number;
        rejected: number;
        destination: 'warehouse' | 'supplier';
        location: string;
        date: string;
        evidence: string;
        fileIds: string[];
    };
} | {
    type: 'fulfillment.procurement.send';
    payload: { id: string; at: string; evidence: string; fileIds: string[] };
} | {
    type: 'fulfillment.procurement.confirm';
    payload: { id: string; at: string; evidence: string; confirmedDue: string; fileIds: string[] };
} | {
    type: 'fulfillment.production.plan';
    payload: { productionId: string; sizes: FulfillmentSizeQuantity[] };
} | {
    type: 'fulfillment.production.release';
    payload: { productionId: string; note: string };
} | {
    type: 'fulfillment.production.complete';
    payload: { productionId: string; quantity: number; sizeQuantities: FulfillmentSizeQuantity[]; date: string; evidence: string; fileIds: string[] };
} | {
    type: 'fulfillment.production.acceptCompletion';
    payload: { productionId: string; note: string };
} | {
    type: 'fulfillment.inventory.move';
    payload: {
        id: string;
        kind: 'issue' | 'return' | 'move';
        quantity: number;
        location: string;
        person: string;
        note: string;
        issueId?: string;
        sourceLocation?: string;
    };
} | {
    type: 'fulfillment.shipments.sourceTerms';
    payload: FulfillmentShippingTerms;
} | {
    type: 'fulfillment.shipments.save';
    payload: ShipmentInput & {
        id?: string;
    };
} | {
    type: 'fulfillment.shipments.pack';
    payload: {
        id: string;
        lines: Array<Omit<FulfillmentPacking, 'id' | 'shipmentId'>>;
    };
} | {
    type: 'fulfillment.shipments.updateTransport';
    payload: { id: string; booking: string; plannedDate: string; note: string };
} | {
    type: 'fulfillment.shipments.ready';
    payload: {
        id: string;
    };
} | {
    type: 'fulfillment.shipments.sent';
    payload: {
        id: string;
        at: string;
    };
} | {
    type: 'fulfillment.shipments.depart';
    payload: {
        id: string;
        at: string;
        evidence: string;
        fileIds: string[];
    };
} | {
    type: 'fulfillment.shipments.cancel';
    payload: {
        id: string;
        reason: string;
    };
} | {
    type: 'fulfillment.customs.save';
    payload: {
        id?: string;
        shipmentId: string;
        declarationNo: string;
        broker: string;
        hsCode: string;
        origin: string;
        tradeMode: string;
        declaredAt: string;
        clearedAt: string;
        evidence: string;
        fileIds: string[];
        note: string;
        status: FulfillmentCustoms['status'];
    };
} | {
    type: 'fulfillment.documents.save';
    payload: {
        id?: string;
        shipmentId: string;
        orderId: string;
        type: FulfillmentDocument['type'];
        number: string;
        title: string;
        dueDate: string;
        content: string;
        fileIds: string[];
    };
} | {
    type: 'fulfillment.documents.issue';
    payload: {
        id: string;
    };
} | {
    type: 'fulfillment.documents.archiveExternal';
    payload: { id: string; issuer: string; at: string; evidence: string };
} | {
    type: 'fulfillment.documents.void';
    payload: {
        id: string;
        reason: string;
    };
} | ClaimInventoryCommand;
export function createFulfillmentState(_context: MistContext, _rootState: unknown): FulfillmentState { return { warehouses:[],returnReceipts:[],receivedRecords:[],productionFacts: [], shippingTerms: [], samples: [], sampleMovements: [], qcTasks: [], qcReports: [], purchases: [], receipts: [], stock: [], stockMovements: [], shipments: [], packing: [], customs: [], documents: [] }; }
export function fulfillmentCommandPermission(command: FulfillmentCommand): string | null {
    if(command.type.startsWith('fulfillment.claimInventory.'))return claimInventoryPermission(command as ClaimInventoryCommand);
    if (command.type.startsWith('fulfillment.samples.'))
        return 'products:write';
    if (command.type === 'fulfillment.qc.claim' || command.type === 'fulfillment.qc.report')
        return `qc:${command.payload.domain}_chain:write`;
    if (command.type === 'fulfillment.qc.request')
        return command.payload.source.kind === 'version' ? 'products:write' : 'orders:write';
    if (command.type.startsWith('fulfillment.qc.'))
        return 'orders:write';
    if (command.type === 'fulfillment.procurement.decide')
        return 'procurement:approve';
    if (command.type.startsWith('fulfillment.procurement.'))
        return 'procurement:write';
    if (command.type === 'fulfillment.production.acceptCompletion' || command.type === 'fulfillment.production.release')
        return 'orders:write';
    if (command.type.startsWith('fulfillment.production.'))
        return 'production:write';
    if (command.type.startsWith('fulfillment.inventory.'))
        return 'inventory:write';
    if (command.type === 'fulfillment.shipments.sourceTerms' || command.type === 'fulfillment.shipments.save' || command.type === 'fulfillment.shipments.sent' || command.type === 'fulfillment.shipments.cancel')
        return 'orders:write';
    if (command.type.startsWith('fulfillment.shipments.'))
        return 'shipments:write';
    if (command.type.startsWith('fulfillment.customs.') || command.type.startsWith('fulfillment.documents.'))
        return 'customs:write';
    throw new MistCommandError('VALIDATION', '未知履约操作');
}
const fail = (message: string, code = 'VALIDATION'): never => { throw new MistCommandError(code, message); };
const text = (v: unknown, label: string, required = true, max = 8000): string => typeof v === 'string' && v.length <= max && (!required || v.trim()) ? v.trim() : fail(`${label}未填写或格式无效`);
const qty = (v: unknown, label = '数量', zero = false): number => typeof v === 'number' && Number.isFinite(v) && v >= (zero ? 0 : 0.0001) && v <= 1e9 && Math.abs(v * 10000 - Math.round(v * 10000)) < 0.00001 ? v : fail(`${label}须为${zero ? '非负' : '正'}数，最多四位小数`);
const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + Math.round(b * 10000), 0)) / 10000;
const get = <T extends {
    id: string;
}>(rows: T[], id: string, label: string): T => rows.find(row => row.id === id) || fail(`${label}不存在`, 'NOT_FOUND');
const day = (v: unknown, label = '日期', required = true): string => { const s = text(v, label, required, 40); if (!s && !required)
    return s; return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s ? s : fail(`${label}无效`); };
const instant = (v: unknown, ctx: MistContext, label = '实际时间'): string => { const s = text(v, label), n = Date.parse(s); return Number.isFinite(n) && n <= Date.parse(ctx.now) + 1000 ? new Date(n).toISOString() : fail(`${label}必须是已发生的实际时间`); };
function files(root: MistState, value: unknown): string[] { if (!Array.isArray(value) || value.length > 100)
    fail('附件格式无效'); return [...new Set((value as unknown[]).map(id => get(root.files, text(id, '附件'), '附件').id))]; }
function source(root: MistState, s: FulfillmentSource, manual = true): FulfillmentSource {
    if (!s || typeof s !== 'object')
        fail('请选择准确来源');
    if (s.kind === 'manual' && manual)
        return { kind: 'manual', description: text(s.description, '手工来源') };
    if (s.kind === 'version') {
        const dev = get(root.devs, s.devId, '开发案'), v = get(root.versions, s.versionId, '版本');
        if (v.devId !== dev.id || !dev.versionIds.includes(v.id))
            fail('版本不属于开发案');
        return { kind: 'version', devId: dev.id, versionId: v.id };
    }
    if (s.kind === 'orderLine') {
        const order = get(root.orders, s.orderId, '订单'), line = get(root.orderLines, s.lineId, '订单条目');
        if (line.orderId !== order.id)
            fail('条目不属于订单');
        if (s.productionId) {
            const prod = get(root.productions, s.productionId, '生产分支');
            if (prod.orderId !== order.id || prod.lineId !== line.id)
                fail('生产分支与条目不一致');
        }
        return { kind: 'orderLine', orderId: order.id, lineId: line.id, ...(s.productionId ? { productionId: s.productionId } : {}) };
    }
    return fail('来源类型无效');
}
export function fulfillmentSourceLabel(root: MistState, s: FulfillmentSource): string { if (s.kind === 'manual')
    return s.description; if (s.kind === 'version')
    return `${root.devs.find(d => d.id === s.devId)?.code || s.devId} · ${root.versions.find(v => v.id === s.versionId)?.label || s.versionId}`; return `${root.orders.find(o => o.id === s.orderId)?.code || s.orderId} · ${root.orderLines.find(l => l.id === s.lineId)?.style || s.lineId}`; }
const sourceKey = (s: FulfillmentSource) => s.kind === 'version' ? `v:${s.versionId}` : s.kind === 'orderLine' ? `l:${s.lineId}:${s.productionId || ''}` : `m:${s.description}`;
const target = (s: FulfillmentSource): MistTarget => s.kind === 'version' ? { view: 'development/detail', id: s.devId, versionId: s.versionId } : s.kind === 'orderLine' ? { view: 'orders/detail', id: s.orderId, orderLineId: s.lineId, productionId: s.productionId } : { view: 'samples' };
function audit(root: MistState, ctx: MistContext, entity: string, id: string, message: string, to?: MistTarget) { root.events.unshift({ id: ctx.id(), entityType: entity, entityId: id, actor: ctx.actorName, at: ctx.now, text: message, fileIds: [] }); if (to)
    root.notifications.unshift({ id: ctx.id(), title: message, detail: ctx.actorName, at: ctx.now, readAt: null, target: to, category:entity==='qc'?'qc':['shipment','customs','document'].includes(entity)?'shipping':'general' }); }
const code = (prefix: string, rows: {
    code: string;
}[], ctx: MistContext) => `${prefix}-${ctx.now.slice(0, 4)}-${String(rows.length + 1).padStart(5, '0')}`;
type PositionedStock = { location: string; available: number; positions?: FulfillmentPosition[] };
/** Old records have one known location; new partial returns keep separate real balances. */
export function fulfillmentPositions(row: PositionedStock): FulfillmentPosition[] {
    return (row.positions ?? [{ location: row.location, available: row.available }]).filter(position => position.available > 0).map(position => ({ ...position }));
}
function mutablePositions(row: PositionedStock) {
    if (!row.positions) row.positions = [{ location: row.location, available: row.available }];
    if (sum(row.positions.map(position => position.available)) !== row.available) fail('位置余额与库存总量不一致，请核对原记录', 'INVALID_STATE');
    return row.positions;
}
function refreshPositionSummary(row: PositionedStock) {
    const positions = row.positions!.filter(position => position.available > 0);
    row.available = sum(positions.map(position => position.available));
    if (positions.length) row.location = positions.length === 1 ? positions[0].location : '多个位置';
}
function sourcePosition(row: PositionedStock, requested?: string) {
    const positions = mutablePositions(row).filter(position => position.available > 0);
    if (requested === undefined && positions.length > 1) fail('请选择本次实际出库位置');
    const position = requested === undefined ? positions[0] : positions.find(position => position.location === requested);
    if (!position) return fail('本次位置没有可用库存');
    return position;
}
function removeAtPosition(row: PositionedStock, quantity: number, requested?: string) {
    const position = sourcePosition(row, requested);
    if (quantity > position.available) fail('所选位置的可用数量不足');
    position.available = sum([position.available, -quantity]); refreshPositionSummary(row);
    return position.location;
}
function addAtPosition(row: PositionedStock, quantity: number, location: string) {
    const positions = mutablePositions(row);
    let position = positions.find(position => position.location === location);
    if (!position) { position = { location, available: 0 }; positions.push(position); }
    position.available = sum([position.available, quantity]); refreshPositionSummary(row);
}
export function sampleLoanRemaining(root: MistState, id: string) {
    const loan = root.fulfillment.sampleMovements.find(movement => movement.id === id && movement.kind === 'lend');
    return loan ? sum([loan.quantity, -sum(root.fulfillment.sampleMovements.filter(movement => movement.kind === 'return' && movement.loanId === id).map(movement => movement.quantity))]) : 0;
}
export function stockIssueRemaining(root: MistState, id: string) {
    const issue = root.fulfillment.stockMovements.find(movement => movement.id === id && movement.kind === 'issue');
    return issue ? sum([issue.quantity, -sum(root.fulfillment.stockMovements.filter(movement => movement.kind === 'return' && movement.issueId === id).map(movement => movement.quantity))]) : 0;
}
function purchaseSnapshot(purchase: FulfillmentPurchase): FulfillmentPurchaseRevision['snapshot'] {
    const { orderId, lineId, kind, supplierId, supplier, description, quantity, unit, price, currency, due, terms, destination, note, fileIds } = purchase;
    return { orderId, lineId, kind, supplierId, supplier, description, quantity, unit, price, currency, due, terms, destination, note, fileIds: [...fileIds] };
}
function addSample(root: MistState, input: SampleInput, ctx: MistContext) {
    const f = root.fulfillment, s = source(root, input.source), category = text(input.category, '类别'), quantity = qty(input.quantity), unit = text(input.unit, '单位');
    if (category === '成衣' && (quantity !== 1 || unit !== '件')) fail('成衣必须逐件建档，数量为1件');
    if (unit !== '米' && !Number.isInteger(quantity)) fail('非米样数量须为整数');
    if (s.kind === 'orderLine') {
        if (!s.productionId) fail('订单样品必须关联准确生产分支');
        const order = get(root.orders, s.orderId, '订单'), expected = order.type === 'garment' ? 'pp' : 'pioneer';
        if (![expected, 'shipping'].includes(input.role || '')) fail('请选择当前订单的产前/先锋样或船样角色');
        if (category !== (order.type === 'garment' ? '成衣' : '面料')) fail('实物类别与订单业务域不一致');
        if (order.type === 'garment' && !text(input.size, '实际样品尺码')) fail('请记录实际样品尺码');
        if (input.role === 'shipping') {
            const shipment = get(f.shipments, input.shipmentId || '', '船样对应出运批次');
            if (shipment.state === 'cancelled' || !shipment.lines.some(line => line.lineId === s.lineId && line.productionId === s.productionId)) fail('船样必须属于准确生产分支的有效出运批次');
        } else if (input.shipmentId) fail('产前/先锋样不绑定出运批次');
    } else if (input.role || input.shipmentId) fail('订单样品角色仅用于准确订单生产分支');
    const id = ctx.id();
    f.samples.push({ id, code: code('SMP', f.samples, ctx), name: text(input.name, '名称'), category, form: text(input.form, '形态'), unit, quantity, available: quantity, location: text(input.location, '位置', false), size: text(input.size, '尺码', false), color: text(input.color, '颜色', false), source: s, ...(s.kind === 'version' ? { sourceSampleCode: get(root.versions, s.versionId, '来源版本').sample } : {}), ...(input.role ? { role: input.role } : {}), ...(input.shipmentId ? { shipmentId: input.shipmentId } : {}), qualityRevision: 1, fileIds: files(root, input.fileIds), note: text(input.note, '备注', false), createdAt: ctx.now });
    f.sampleMovements.push({ id: ctx.id(), sampleId: id, kind: 'receive', quantity, person: ctx.actorName, location: input.location, note: input.note, at: ctx.now, actor: ctx.actorName });
    return id;
}
function sourceDomain(root: MistState, s: FulfillmentSource): 'garment' | 'fabric' { if (s.kind === 'orderLine')
    return get(root.orders, s.orderId, '订单').type; return s.kind === 'version' && developmentDomain(get(root.devs, s.devId, '开发案').values)==='fabric' ? 'fabric' : 'garment'; }
export const fulfillmentSampleRoleLabel = (role?: FulfillmentSampleRole) => ({ pp: '产前样', pioneer: '先锋样', shipping: '船样' }[role || 'pp']);
export function fulfillmentProductionFact(root: MistState, productionId: string) { return root.fulfillment.productionFacts?.find(fact => fact.productionId === productionId); }
function productionFact(root: MistState, productionId: string): FulfillmentProductionFact {
    const existing = fulfillmentProductionFact(root, productionId);
    if (existing) return existing;
    const created = { productionId, sizes: [], revision: 1 };
    (root.fulfillment.productionFacts ||= []).push(created);
    return created;
}
function normalizeSizes(value: unknown, total: number, required: boolean): FulfillmentSizeQuantity[] {
    const list: any[] = Array.isArray(value) ? value : fail('请登记准确生产尺码与数量');
    if (required && !list.length) fail('请登记准确生产尺码与数量');
    const rows = list.map(row => ({ size: text(row?.size, '尺码', true, 80), quantity: qty(row?.quantity, '尺码数量') }));
    if (new Set(rows.map(row => row.size)).size !== rows.length) fail('尺码不得重复');
    if (rows.length && sum(rows.map(row => row.quantity)) !== total) fail('尺码数量合计必须等于对应总数量');
    return rows;
}
function scopeRevision(root: MistState, task: FulfillmentQcTask): number {
    if (task.sampleId) return get(root.fulfillment.samples, task.sampleId, '准确实物样品').qualityRevision || 1;
    return task.source.kind === 'orderLine' && task.source.productionId ? fulfillmentProductionFact(root, task.source.productionId)?.revision || 1 : 1;
}
function requireSampleRole(root: MistState, branch: MistProduction, role: FulfillmentSampleRole, shipmentId?: string) {
    const samples = root.fulfillment.samples.filter(sample => sample.role === role && sample.source.kind === 'orderLine' && sample.source.orderId === branch.orderId && sample.source.lineId === branch.lineId && sample.source.productionId === branch.id && (role !== 'shipping' || sample.shipmentId === shipmentId));
    const approved = samples.filter(sample => root.fulfillment.qcTasks.some(task => {
        const latest = root.fulfillment.qcReports.find(report => report.id === task.reportIds.at(-1));
        return task.sampleId === sample.id && task.kind === 'sample' && task.state === 'reported' && latest && latest.result !== 'reject' && latest.scopeRevision === (sample.qualityRevision || 1) && task.businessConfirmation?.result === 'approved' && task.businessContinued?.reportId === latest.id;
    }));
    if (!approved.length) fail(`${fulfillmentSampleRoleLabel(role)}尚未完成准确实物QC、需求方确认及业务继续`, 'PRECONDITION');
}
function requireProductionQc(root: MistState, branch: MistProduction) {
    const tasks = root.fulfillment.qcTasks.filter(task => task.kind === 'production' && task.source.kind === 'orderLine' && task.source.productionId === branch.id);
    if (!tasks.length) fail('当前生产分支尚无专业生产QC报告', 'PRECONDITION');
    const fact = fulfillmentProductionFact(root, branch.id), sizes = fact?.completion?.sizeQuantities || fact?.sizes || [];
    for (const task of tasks) {
        const latest = root.fulfillment.qcReports.find(report => report.id === task.reportIds.at(-1));
        if (!latest || latest.result === 'reject' || task.state !== 'reported' || latest.scopeRevision !== scopeRevision(root, task)) fail('当前生产分支仍有未解除的质量门禁', 'PRECONDITION');
        if (get(root.orders, branch.orderId, '订单').type === 'garment') {
            if (!sizes.length) fail('生产QC缺少准确尺码依据', 'PRECONDITION');
            const reports = task.reportIds.map(id => get(root.fulfillment.qcReports, id, '报告')).filter(report => report.scopeRevision === scopeRevision(root, task));
            for (const size of sizes) {
                const last = reports.flatMap(report => report.sizeChecks || []).filter(check => check.size === size.size).at(-1);
                if (!last || last.result !== 'pass') fail(`生产QC尚未覆盖尺码 ${size.size}`, 'PRECONDITION');
            }
        }
    }
}
function requireProductionRelease(root: MistState, branch: MistProduction, recordingInspection = false) {
    assertMistOrderApproved(root, branch.orderId);
    assertMistOrderDeposit(root, branch.orderId);
    const fact = fulfillmentProductionFact(root, branch.id);
    if (!fact?.release) fail('当前生产分支尚未由业务明确放行', 'PRECONDITION');
    requireSampleRole(root, branch, get(root.orders, branch.orderId, '订单').type === 'garment' ? 'pp' : 'pioneer');
    if (branch.sourcePurchaseId) {
        const purchase = get(root.fulfillment.purchases, branch.sourcePurchaseId, '来源合同');
        if (purchase.state !== 'approved' || !purchase.offlineSend || !purchase.supplierConfirmation) fail('来源合同尚未批准、线下发出并取得供应商确认', 'PRECONDITION');
    }
    if (!recordingInspection && root.fulfillment.qcTasks.some(task => task.kind === 'production' && task.source.kind === 'orderLine' && task.source.productionId === branch.id && ['blocked', 'awaiting_business'].includes(task.state))) fail('当前生产分支因质量问题暂停，须复验及业务恢复', 'PRECONDITION');
}
/** Shared core commands call this before mutating a production board position/progress. */
export function assertProductionTransition(root: MistState, production: MistProduction, target: MistProduction['col'], pct: number) {
    const cols = ['cut', 'sew', 'finish', 'qc', 'done'];
    if (pct > production.pct || cols.indexOf(target) > cols.indexOf(production.col) || target === 'done') requireProductionRelease(root, production);
    if (target === 'done') { physicalCapacity(root, { orderId: production.orderId, lineId: production.lineId, productionId: production.id, quantity: 0, factoryConfirmedAt: '' }); requireProductionQc(root, production); }
}
function requireEditableShipment(s: FulfillmentShipment) { if (s.state === 'departed' || s.state === 'cancelled')
    fail('已出运或已取消记录不能修改', 'PRECONDITION'); }
function physicalCapacity(root: MistState, line: ShipmentLine): number {
    if (!line.productionId)
        return fail('出运缺少准确生产分支，请重新核对来源', 'PRECONDITION');
    const branch = get(root.productions, line.productionId, '准确生产分支');
    if (branch.orderId !== line.orderId || branch.lineId !== line.lineId)
        fail('生产分支不属于当前出运条目');
    const fact = fulfillmentProductionFact(root, branch.id);
    if (!fact?.completion) return fail('当前生产分支尚未登记独立最终完工数量', 'PRECONDITION');
    if (fact.completion.quantity !== branch.qty && fact.customerAcceptance?.completionId !== fact.completion.id) fail('最终完工数量与计划存在差异，须取得客户明确接受', 'PRECONDITION');
    return fact.completion.quantity;
}
function checkPhysicalReservation(root: MistState, line: ShipmentLine, excludeShipmentId?: string) { const capacity = physicalCapacity(root, line); const reserved = sum(root.fulfillment.shipments.filter(s => s.id !== excludeShipmentId && s.state !== 'cancelled').flatMap(s => s.lines.filter(l => l.lineId === line.lineId && l.productionId === line.productionId).map(l => l.quantity))); if (sum([reserved, line.quantity]) > capacity)
    fail('本次与已有预留超过该来源分支实际交付数量'); }
function sourceQuality(root: MistState, line: ShipmentLine) {
    physicalCapacity(root, line);
    const production = root.productions.filter(p => p.lineId === line.lineId && p.id === line.productionId);
    if (!production.length)
        fail('当前条目尚无可核对的实际生产分支及生产QC报告', 'PRECONDITION');
    for (const branch of production) {
        requireProductionRelease(root, branch);
        requireProductionQc(root, branch);
    }
}
function requiredShipmentDocuments(root: MistState, shipment: FulfillmentShipment) {
    const documents = root.fulfillment.documents.filter(document => document.shipmentId === shipment.id && document.status === 'issued');
    if (!documents.some(document => document.type === 'PL')) fail('请先签发本票装箱单');
    for (const orderId of new Set(shipment.lines.map(line => line.orderId))) if (!documents.some(document => document.type === 'CI' && document.orderId === orderId)) fail('请按原订单分别签发CI');
    return documents.filter(document => document.type === 'PL' || document.type === 'CI');
}
export function getFulfillmentReviews(root: MistState): MistReviewTask[] { return (root.fulfillment?.purchases || []).filter(p => p.submittedAt).map(p => ({ id: `procurement:${p.id}`, kind: 'procurement', entityId: p.id, title: `${p.code} · ${p.supplier}`, requesterId: p.requesterId, reviewerIds: p.reviewerIds, status: p.state === 'pending' ? 'pending' : p.state === 'approved' ? 'approved' : 'rejected', submittedAt: p.submittedAt!, requiredPermission: 'procurement:approve', fileIds: [...p.fileIds], target: { view: 'procurement', id: p.id }, details: [{ label: '来源', value: fulfillmentSourceLabel(root, { kind: 'orderLine', orderId: p.orderId, lineId: p.lineId }) }, { label: '采购内容', value: p.description }, { label: '供应商', value: p.supplier }, { label: '数量', value: `${p.quantity} ${p.unit}` }, { label: '金额', value: `${lineAmount(p.quantity, p.price)} ${p.currency}` }, { label: '付款条件', value: p.terms }, { label: '交付地点', value: p.destination }, { label: '交期', value: p.due }] })); }
/** Called only on the aggregate's transaction clone; throws before its snapshot is committed. */
export function applyFulfillmentCommand(root: MistState, command: FulfillmentCommand, ctx: MistContext): MistCommandResult {
    const f = root.fulfillment || (root.fulfillment = createFulfillmentState(ctx, root));
    f.shippingTerms ||= [];
    f.productionFacts ||= [];
    fulfillmentCommandPermission(command);
    if(command.type.startsWith('fulfillment.claimInventory.'))return applyClaimInventoryCommand(root,command as ClaimInventoryCommand,ctx);
    const p: any = command.payload;
    switch (command.type) {
        case 'fulfillment.samples.create': {
            const s = source(root, p.source);
            if (s.kind === 'version') {
                const d = get(root.devs, s.devId, '开发案'), v = get(root.versions, s.versionId, '版本');
                if (developmentDomain(d.values)!=='fabric')
                    fail('成衣开发实物请从准确版本返样同步');
                if (!v.returnedAt)
                    fail('请先登记来源版本返样');
            }
            const id = addSample(root, p, ctx);
            audit(root, ctx, 'sample', id, '登记实体样品');
            return { id };
        }
        case 'fulfillment.samples.sync': {
            let applied = 0;
            for (const v of root.versions) {
                if (!v.returnedAt || !v.sample)
                    continue;
                const d = get(root.devs, v.devId, '开发案'), fabric = developmentDomain(d.values)==='fabric';
                const existing = f.samples.filter(s => s.source.kind === 'version' && s.source.versionId === v.id);
                if (existing.length) {
                    if (!fabric && (sum(existing.map(s => s.quantity)) !== v.sampleQuantity || existing.some(s => s.sourceSampleCode && s.sourceSampleCode !== v.sample)))
                        fail('已同步入库的版本实物不能覆盖，请建立准确新版本');
                    continue;
                }
                if (fabric && (!v.sampleForm || !v.sampleUnit)) continue; // Legacy manual shapes are never guessed.
                if (!fabric && !Number.isInteger(v.sampleQuantity))
                    fail('成衣来源件数无效');
                for (let i = 0; i < (fabric ? 1 : v.sampleQuantity); i++) {
                    addSample(root, { name: d.name, category: fabric ? '面料' : '成衣', form: fabric ? v.sampleForm! : '开发样', unit: fabric ? v.sampleUnit! : '件', quantity: fabric ? v.sampleQuantity : 1, location: fabric ? v.sampleLocation||'' : '', size: v.size, color: fabric ? v.sampleColor||d.values.color : d.values.color, source: { kind: 'version', devId: d.id, versionId: v.id }, fileIds: v.fileIds, note: `来源实物 ${v.sample}` }, ctx);
                    applied++;
                }
            }
            return { applied };
        }
        case 'fulfillment.samples.edit': {
            const s = get(f.samples, p.id, '样品');
            const changedPhysical = ['form', 'size', 'color'].some(key => p[key] !== undefined && p[key] !== (s as any)[key]);
            if (text(p.location, '位置', false) !== s.location) fail('请通过移位操作登记位置变化');
            if (p.name !== undefined) s.name = text(p.name, '样品名称');
            if (p.form !== undefined) s.form = text(p.form, '样品形态');
            if (p.size !== undefined) s.size = text(p.size, '尺码', false);
            if (p.color !== undefined) s.color = text(p.color, '颜色', false);
            s.note = text(p.note, '备注', false);
            s.fileIds = files(root, p.fileIds);
            if (changedPhysical) {
                s.qualityRevision = (s.qualityRevision || 1) + 1;
                for (const task of f.qcTasks.filter(task => task.sampleId === s.id)) { task.state = 'working'; delete task.businessConfirmation; delete task.businessContinued; }
            }
            audit(root, ctx, 'sample', s.id, '更新样品资料');
            return { id: s.id };
        }
        case 'fulfillment.samples.move': {
            const s = get(f.samples, p.id, '样品');
            let quantity = p.kind === 'move' ? 0 : qty(p.quantity);
            if (s.unit !== '米' && !Number.isInteger(quantity)) fail('件或份类样品必须按整数流转');
            let loan: SampleMovement | undefined;
            if (!['lend', 'return', 'send', 'move'].includes(p.kind))
                fail('样品流转类型无效');
            if (p.kind === 'return') {
                loan = get(f.sampleMovements, p.loanId, '原借出');
                if (loan.sampleId !== s.id || loan.kind !== 'lend')
                    fail('归还须引用本件原借出');
                const returned = sum(f.sampleMovements.filter(m => m.kind === 'return' && m.loanId === loan!.id).map(m => m.quantity));
                if (quantity > sum([loan.quantity, -returned]))
                    fail('归还量超过未还量');
            }
            else if (quantity > s.available) fail('可用样品不足');
            const person = text(p.person, '借用人/收件人', p.kind === 'lend' || p.kind === 'send'), location = text(p.location, '位置', false), note = text(p.note, '备注', false), expectedReturn = p.expectedReturn ? day(p.expectedReturn, '预计归还日') : undefined;
            if (expectedReturn && expectedReturn < ctx.now.slice(0, 10))
                fail('预计归还日不能早于借出日');
            let sourceLocation: string | undefined;
            if (p.kind === 'return') addAtPosition(s, quantity, location);
            else {
                const position = sourcePosition(s, p.sourceLocation);
                if (p.kind === 'move') quantity = position.available;
                sourceLocation = removeAtPosition(s, quantity, position.location);
                if (p.kind === 'move') addAtPosition(s, quantity, location);
            }
            const id = ctx.id();
            f.sampleMovements.push({ id, sampleId: s.id, kind: p.kind, quantity, person, location, note, at: ctx.now, actor: ctx.actorName, ...(sourceLocation === undefined ? {} : { sourceLocation }), ...(loan ? { loanId: loan.id } : {}), ...(expectedReturn ? { expectedReturn } : {}) });
            audit(root, ctx, 'sample', s.id, `样品${({ lend: '借出', return: '归还', send: '寄出', move: '移位' } as Record<string, string>)[p.kind]}`);
            return { id };
        }
        case 'fulfillment.qc.request': {
            const sample = p.sampleId ? get(f.samples, p.sampleId, '准确实物样品') : undefined;
            const s = source(root, sample ? sample.source : p.source, false) as FulfillmentQcTask['source'];
            if (sample && sourceKey(s) !== sourceKey(p.source)) fail('QC任务来源与实物样品不一致');
            if (sourceDomain(root, s) !== p.domain)
                fail('QC业务域与来源不一致');
            if (!['sample', 'production'].includes(p.kind))
                fail('QC类别无效');
            if (s.kind === 'version' && (p.kind !== 'sample' || !get(root.versions, s.versionId, '版本').returnedAt))
                fail('请先登记准确版本的实物返样');
            if (s.kind === 'orderLine' && p.kind === 'production' && !s.productionId)
                fail('生产检验必须选择准确生产分支');
            if (s.kind === 'orderLine' && p.kind === 'sample' && (!sample || !sample.role)) fail('订单样品QC必须选择准确实物及样品角色');
            if (p.kind === 'production' && sample) fail('生产QC不能以样品替代');
            if (f.qcTasks.some(t => p.kind === 'sample' && sample ? t.sampleId === sample.id : sourceKey(t.source) === sourceKey(s) && t.kind === p.kind))
                fail('该准确来源已有QC任务，请在原任务追加复验');
            const id = ctx.id();
            f.qcTasks.push({ id, code: code('QC', f.qcTasks, ctx), source: s, ...(sample ? { sampleId: sample.id } : {}), domain: p.domain, kind: p.kind, factory: text(p.factory, '工厂'), location: text(p.location, '检查地点'), contact: text(p.contact, '联系人', false), due: day(p.due, '预期检查日'), requestedBy: ctx.actorName, assignee: '', state: 'pending', reportIds: [], createdAt: ctx.now });
            audit(root, ctx, 'qc', id, '已发起准确来源QC', { view: 'qc-workbench', id });
            return { id };
        }
        case 'fulfillment.qc.claim': {
            const t = get(f.qcTasks, p.id, 'QC任务');
            if (t.domain !== p.domain)
                fail('QC业务域不一致');
            if (!ctx.actorId)
                fail('QC认领需要真实账号');
            if (t.assigneeId && t.assigneeId !== ctx.actorId)
                fail('任务已被其他QC认领', 'CONFLICT');
            t.assignee = ctx.actorName;
            t.assigneeId = ctx.actorId;
            if (t.state === 'pending')
                t.state = 'working';
            audit(root, ctx, 'qc', t.id, 'QC认领任务');
            return { id: t.id };
        }
        case 'fulfillment.qc.report': {
            const t = get(f.qcTasks, p.id, 'QC任务');
            if (t.domain !== p.domain)
                fail('QC业务域不一致');
            if (!ctx.actorId || t.assigneeId !== ctx.actorId)
                fail('请先由当前QC认领任务');
            if (t.kind === 'production' && t.source.kind === 'orderLine') requireProductionRelease(root, get(root.productions, t.source.productionId!, '生产分支'), true);
            if (!['pass', 'conditional', 'reject'].includes(p.result))
                fail('请选择专业结论');
            const reviewedAt = instant(p.reviewedAt, ctx, '实际检查时间'), opinion = text(p.opinion, '专业意见'), report = text(p.report, '报告编号');
            if (!Array.isArray(p.measurements) || p.measurements.length > 200)
                fail('测量点最多200项');
            const measurements = p.measurements.map((m: any) => ({ point: text(m.point, '测量点'), standard: qty(m.standard, '标准值', true), actual: qty(m.actual, '实测值', true), tolerance: qty(m.tolerance, '容差', true) }));
            const fileIds = files(root, p.fileIds);
            if (t.source.kind === 'version') {
                const v = get(root.versions, t.source.versionId, '版本');
                if (v.archivedAt || v.confirmations.length)
                    fail('已有需求方决定或留档的版本不可改写QC，请创建新版本');
                v.qc = { result: p.result, reviewer: ctx.actorName, reviewedAt, report, opinion, measurements };
                const d = get(root.devs, t.source.devId, '开发案');
                if (d.currentVersionId === v.id) {
                    d.stage = p.result === 'reject' ? 2 : 3;
                    d.state = p.result === 'reject' ? 'QC 不通过' : p.result === 'conditional' ? '有保留通过 · 待确认' : '待需求方确认';
                    d.tone = p.result === 'reject' ? 'bad' : 'accent';
                    d.updatedAt = ctx.now;
                }
            }
            const needsResume = t.state === 'blocked' || t.state === 'awaiting_business', previous = t.reportIds.at(-1), id = ctx.id();
            delete t.businessConfirmation;
            delete t.businessContinued;
            let sizeChecks: NonNullable<FulfillmentQcReport['sizeChecks']> = [];
            if (t.kind === 'production' && t.source.kind === 'orderLine') {
                const fact = productionFact(root, t.source.productionId!), sizes = fact.completion?.sizeQuantities || fact.sizes;
                if (t.domain === 'garment' && !sizes.length) fail('生产QC须先有准确生产尺码');
                if (t.domain === 'garment' && (!Array.isArray(p.sizeChecks) || !p.sizeChecks.length)) fail('请记录本次实际检查尺码');
                sizeChecks = (p.sizeChecks || []).map((check: any) => {
                    if (!sizes.some(size => size.size === check.size)) fail('检查尺码不属于当前生产分支');
                    if (!['pass', 'reject'].includes(check.result)) fail('尺码检查结论无效');
                    const inspected = qty(check.inspected, '实际检查件数');
                    if (t.domain === 'garment' && !Number.isSafeInteger(inspected)) fail('成衣实际检查件数须为正整数');
                    if (inspected > sizes.find(size => size.size === check.size)!.quantity) fail('实际检查件数不能超过对应尺码数量');
                    return { size: text(check.size, '检查尺码'), inspected, result: check.result, evidence: text(check.evidence, '尺码检查依据') };
                });
                if (new Set(sizeChecks.map(check => check.size)).size !== sizeChecks.length) fail('本次尺码检查不得重复');
                if (sizeChecks.some(check => check.result === 'reject') && p.result !== 'reject') fail('存在尺码不通过时，总结论必须不通过');
            }
            f.qcReports.push({ id, taskId: t.id, result: p.result, report, opinion, measurements, fileIds, reviewer: ctx.actorName, reviewedAt, scopeRevision: scopeRevision(root, t), sizeChecks, ...(previous ? { previousReportId: previous } : {}) });
            t.reportIds.push(id);
            t.state = p.result === 'reject' ? 'blocked' : t.kind === 'production' && (needsResume || p.result === 'conditional') ? 'awaiting_business' : 'reported';
            if (t.source.kind === 'orderLine' && t.source.productionId) {
                const job = get(root.productions, t.source.productionId, '生产分支');
                if (p.result === 'reject')
                    job.risk = `QC 不通过：${opinion}`;
            }
            audit(root, ctx, 'qc', t.id, `QC报告：${({ pass: '通过', conditional: '有保留通过', reject: '不通过' } as const)[p.result as MistQc['result']]}`, target(t.source));
            return { id, taskId: t.id };
        }
        case 'fulfillment.qc.confirm': {
            const t = get(f.qcTasks, p.id, 'QC任务');
            if (t.kind !== 'sample' || t.source.kind !== 'orderLine' || t.state !== 'reported')
                fail('当前样品尚不能由需求方确认');
            if (!['approved', 'rejected'].includes(p.result))
                fail('确认结果无效');
            const latest = get(f.qcReports, t.reportIds.at(-1) || '', 'QC报告');
            if (latest.result === 'reject' || latest.scopeRevision !== scopeRevision(root, t))
                fail('不通过的QC报告不能确认采用');
            delete t.businessContinued;
            t.businessConfirmation = { result: p.result, note: text(p.note, '需求方确认依据'), actor: ctx.actorName, at: ctx.now };
            audit(root, ctx, 'qc', t.id, '业务记录需求方样品确认', target(t.source));
            return { id: t.id };
        }
        case 'fulfillment.qc.continue': {
            const t = get(f.qcTasks, p.id, 'QC任务');
            if (t.kind === 'sample' ? t.state !== 'reported' || t.businessConfirmation?.result !== 'approved' : t.state !== 'awaiting_business')
                fail('当前任务不在复验后待业务恢复状态');
            const latest = get(f.qcReports, t.reportIds.at(-1) || '', '当前报告');
            if (latest.result === 'reject' || latest.scopeRevision !== scopeRevision(root, t)) fail('当前实物需要有效复验报告');
            const note = text(p.note, '恢复依据');
            t.state = 'reported';
            t.businessContinued = { reportId: latest.id, actor: ctx.actorName, at: ctx.now, note };
            if (t.source.kind === 'orderLine' && t.source.productionId) {
                const job = get(root.productions, t.source.productionId, '生产分支');
                if (job.risk?.startsWith('QC 不通过：'))
                    job.risk = '';
            }
            audit(root, ctx, 'qc', t.id, `业务确认继续：${note}`, target(t.source));
            return { id: t.id };
        }
        case 'fulfillment.production.plan': {
            const branch = get(root.productions, p.productionId, '生产分支'), fact = productionFact(root, branch.id);
            if (fact.release || fact.completion) fail('已放行生产不得改写计划尺码');
            fact.sizes = normalizeSizes(p.sizes, branch.qty, get(root.orders, branch.orderId, '订单').type === 'garment');
            fact.revision++;
            audit(root, ctx, 'production', branch.id, '登记实际生产尺码计划');
            return { id: branch.id };
        }
        case 'fulfillment.production.release': {
            const branch = get(root.productions, p.productionId, '生产分支'), fact = productionFact(root, branch.id);
            if (fact.release) fail('生产分支已放行');
            assertMistOrderApproved(root, branch.orderId); assertMistOrderDeposit(root, branch.orderId);
            const order = get(root.orders, branch.orderId, '订单');
            if (order.type === 'garment' && !fact.sizes.length) fail('请先登记准确生产尺码与数量');
            if (branch.sourcePurchaseId) {
                const purchase = get(f.purchases, branch.sourcePurchaseId, '来源合同');
                if (purchase.state !== 'approved' || !purchase.offlineSend || !purchase.supplierConfirmation) fail('来源合同须批准、线下发出并取得供应商确认');
            }
            requireSampleRole(root, branch, order.type === 'garment' ? 'pp' : 'pioneer');
            fact.release = { at: ctx.now, actor: ctx.actorName, note: text(p.note, '开产放行依据') };
            branch.risk = '';
            audit(root, ctx, 'production', branch.id, '业务确认开产放行', { view: 'production-board', id: branch.id, productionId: branch.id });
            return { id: branch.id };
        }
        case 'fulfillment.production.complete': {
            const branch = get(root.productions, p.productionId, '生产分支'), fact = productionFact(root, branch.id);
            requireProductionRelease(root, branch);
            if (fact.completion) fail('最终完工事实已登记，不得覆盖');
            const quantity = qty(p.quantity, '最终完工数量'), date = day(p.date, '实际完工日');
            if (date > ctx.now.slice(0, 10)) fail('完工日期不得在未来');
            const sizeQuantities = normalizeSizes(p.sizeQuantities, quantity, get(root.orders, branch.orderId, '订单').type === 'garment');
            if (sizeQuantities.some((size: FulfillmentSizeQuantity) => !fact.sizes.some(planned => planned.size === size.size))) fail('完工尺码不属于已确认生产尺码');
            if (branch.sourcePurchaseId) {
                const purchase = get(f.purchases, branch.sourcePurchaseId, '来源合同'), line = get(root.orderLines, branch.lineId, '订单条目');
                if (purchase.unit !== line.unit || quantity > purchase.received) fail('完工量不得超过同单位实际回交数量，系统不自动换算');
            }
            fact.completion = { id: ctx.id(), quantity, sizeQuantities, date, at: ctx.now, actor: ctx.actorName, evidence: text(p.evidence, '最终完工依据'), fileIds: files(root, p.fileIds) };
            fact.revision++;
            for (const task of f.qcTasks) if (task.kind === 'production' && task.source.kind === 'orderLine' && task.source.productionId === branch.id && task.state === 'reported') task.state = 'working';
            branch.pct = 100; branch.col = 'qc';
            audit(root, ctx, 'production', branch.id, `登记最终完工 ${quantity}，待最终生产QC`);
            return { id: branch.id, completionId: fact.completion!.id };
        }
        case 'fulfillment.production.acceptCompletion': {
            const branch = get(root.productions, p.productionId, '生产分支'), fact = productionFact(root, branch.id);
            if (!fact.completion || fact.completion.quantity === branch.qty) fail('当前没有需客户接受的完工数量差异');
            if (fact.customerAcceptance) fail('客户接受事实已登记');
            fact.customerAcceptance = { at: ctx.now, actor: ctx.actorName, note: text(p.note, '客户明确接受数量差异的依据'), completionId: fact.completion!.id };
            audit(root, ctx, 'production', branch.id, '登记客户接受最终数量差异');
            return { id: branch.id };
        }
        case 'fulfillment.procurement.send': {
            const purchase = get(f.purchases, p.id, '采购合同');
            if (purchase.state !== 'approved' || purchase.offlineSend) fail('仅已批准且未发出的合同可登记线下发出');
            assertMistOrderApproved(root, purchase.orderId);
            purchase.offlineSend = { at: instant(p.at, ctx, '实际线下发出时间'), actor: ctx.actorName, evidence: text(p.evidence, '线下发出依据'), fileIds: files(root, p.fileIds), revision: purchase.revisionHistory?.length || 1 };
            audit(root, ctx, 'procurement', purchase.id, '已登记批准合同线下发出');
            return { id: purchase.id };
        }
        case 'fulfillment.procurement.confirm': {
            const purchase = get(f.purchases, p.id, '采购合同');
            if (purchase.state !== 'approved' || !purchase.offlineSend || purchase.supplierConfirmation) fail('请先登记批准合同线下发出，且不得覆盖已有确认');
            const at = instant(p.at, ctx, '供应商确认时间'), confirmedDue = day(p.confirmedDue, '供应商确认交期');
            if (at < purchase.offlineSend!.at) fail('供应商确认不得早于合同发出');
            if (confirmedDue !== purchase.due) fail('供应商反馈交期与批准合同不同，需先处理商业变更，不得覆盖已批交期');
            purchase.supplierConfirmation = { at, confirmedDue, actor: ctx.actorName, evidence: text(p.evidence, '供应商确认依据'), fileIds: files(root, p.fileIds), revision: purchase.offlineSend!.revision };
            audit(root, ctx, 'procurement', purchase.id, '已登记供应商线下确认');
            return { id: purchase.id };
        }
        case 'fulfillment.procurement.save': {
            const s = source(root, { kind: 'orderLine', orderId: p.orderId, lineId: p.lineId }), order = get(root.orders, p.orderId, '订单');
            const existing = p.id ? get(f.purchases, p.id, '采购') : undefined;
            if (existing && !['draft', 'rejected'].includes(existing.state))
                fail('已提交采购须退回后修订');
            if (!['material', 'finished', 'processing'].includes(p.kind))
                fail('采购类型无效');
            const quantity = qty(p.quantity), price = qty(p.price, '单价', true);
            lineAmount(quantity, price);
            const supplierId = text(p.supplierId, '供应商ID'), supplierRecord = get(root.market.suppliers, supplierId, '供应商');
            if (supplierRecord.status !== 'active')
                fail('该供应商已停用');
            const supplier = supplierRecord.name;
            const id = existing?.id || ctx.id();
            const currency = text(p.currency, '币种').toUpperCase();
            if (!/^[A-Z]{3}$/.test(currency)) fail('采购币种须为三位英文字母');
            const record: FulfillmentPurchase = { id, code: existing?.code || code('PO', f.purchases, ctx), orderId: order.id, lineId: s.kind === 'orderLine' ? s.lineId : '', kind: p.kind, domain: order.type, supplierId, supplier, description: text(p.description, '采购内容'), quantity, unit: text(p.unit, '单位'), price, currency, due: day(p.due, '交期'), terms: text(p.terms, '付款条件'), destination: text(p.destination, '交付地点'), note: text(p.note, '备注', false), fileIds: files(root, p.fileIds), state: 'draft', requesterId: ctx.actorId || '', createdBy: existing?.createdBy || ctx.actorName, createdAt: existing?.createdAt || ctx.now, reviewerIds: [], configVersions: {}, received: existing?.received || 0 };
            if (existing) {
                Object.assign(existing, record);
                delete existing.submittedAt;
                delete existing.decision;
            }
            else
                f.purchases.push(record);
            audit(root, ctx, 'procurement', id, '保存采购草稿');
            return { id };
        }
        case 'fulfillment.procurement.submit': {
            const purchase = get(f.purchases, p.id, '采购');
            assertMistOrderApproved(root, purchase.orderId);
            if (purchase.state !== 'draft')
                fail('仅草稿可以提交');
            const actorId = ctx.actorId;
            if (!actorId)
                return fail('审批需要当前真实账号');
            const key = `supplierCommitment.approvers.${purchase.kind === 'processing' ? 'processing' : 'purchase'}.${purchase.domain}`, config = ctx.authority?.supplier?.[key];
            if (!config?.userIds.length)
                return fail('尚未配置当前业务的供应商承诺审批人', 'PRECONDITION');
            purchase.state = 'pending';
            purchase.requesterId = actorId;
            purchase.reviewerIds = [...new Set(config.userIds)];
            purchase.configVersions = { [key]: config.version };
            purchase.submittedAt = ctx.now;
            delete purchase.decision;
            purchase.revisionHistory ||= [];
            purchase.revisionHistory.push({ revision: purchase.revisionHistory.length + 1, submittedAt: ctx.now, requesterId: actorId, reviewerIds: [...purchase.reviewerIds], configVersions: { ...purchase.configVersions }, snapshot: purchaseSnapshot(purchase) });
            audit(root, ctx, 'procurement', purchase.id, '采购承诺已提交审批');
            return { id: purchase.id };
        }
        case 'fulfillment.procurement.decide': {
            const purchase = get(f.purchases, p.id, '采购');
            assertMistOrderApproved(root, purchase.orderId);
            if (purchase.state !== 'pending')
                fail('采购已处理或不在待审批状态', 'CONFLICT');
            if (!['approved', 'rejected'].includes(p.decision))
                fail('审批决定无效');
            const key = Object.keys(purchase.configVersions)[0], config = ctx.authority?.supplier?.[key];
            if (!ctx.actorId || !purchase.reviewerIds.includes(ctx.actorId) || !config?.userIds.includes(ctx.actorId))
                fail('当前账号不在提交时及当前有效供应商审批名单', 'FORBIDDEN');
            const note = text(p.note, '审批意见');
            purchase.state = p.decision;
            purchase.decision = { actorId: ctx.actorId!, actor: ctx.actorName, at: ctx.now, decision: p.decision, note };
            if (!purchase.revisionHistory?.length) purchase.revisionHistory = [{ revision: 1, submittedAt: purchase.submittedAt || ctx.now, requesterId: purchase.requesterId, reviewerIds: [...purchase.reviewerIds], configVersions: { ...purchase.configVersions }, snapshot: purchaseSnapshot(purchase) }];
            purchase.revisionHistory.at(-1)!.decision = { ...purchase.decision };
            if (p.decision === 'approved' && purchase.kind !== 'material' && !root.productions.some(job => job.sourcePurchaseId === purchase.id)) {
                const order = get(root.orders, purchase.orderId, '来源订单'), line = get(root.orderLines, purchase.lineId, '来源条目');
                // Fabric has one full-item factory branch, not garment-style capacity splitting.
                // Raw-material purchases are independent costs and must not count as production branches.
                if (order.type === 'fabric') {
                    if (root.productions.some(job => job.orderId === order.id && job.lineId === line.id)) fail('面料条目仅允许一个工厂履约分支，请返回已有分支继续处理');
                    if (purchase.unit !== line.unit) fail('面料履约单位须与订单条目一致，不能按相同数字自动换算');
                    if (purchase.quantity !== line.qty) fail('面料单工厂分支须覆盖完整订单条目数量；分次交付在原单登记');
                }
                const other = f.purchases.filter(item => item.id !== purchase.id && item.lineId === line.id && item.state === 'approved' && item.kind !== 'material');
                if (other.some(item => item.kind !== purchase.kind)) fail('同一订单条目不得混用加工与成品履约模式');
                if (sum([...other.map(item => item.quantity), purchase.quantity]) > line.qty) fail('批准的生产分配总量超过订单条目数量');
                const productionId = ctx.id();
                root.productions.push({ id: productionId, sourcePurchaseId: purchase.id, code: 'FUL-' + purchase.code, orderId: order.id, lineId: line.id, order: order.code, name: purchase.description, factory: purchase.supplier, qty: purchase.quantity, due: purchase.due, pct: 0, img: line.img, col: purchase.kind === 'processing' ? 'cut' : 'finish', risk: order.type === 'fabric' ? '待合同确认、先锋样与业务开产放行' : '待合同确认、产前样与业务开产放行' });
                productionFact(root, productionId);
            }
            audit(root, ctx, 'procurement', purchase.id, `采购审批${p.decision === 'approved' ? '通过' : '退回'}：${note}`, { view: 'procurement', id: purchase.id });
            return { id: purchase.id };
        }
        case 'fulfillment.procurement.receive': {
            const purchase = get(f.purchases, p.id, '采购');
            if (purchase.state !== 'approved')
                fail('仅已批准采购可登记履约', 'PRECONDITION');
            if (!purchase.offlineSend || !purchase.supplierConfirmation) fail('请先登记批准合同线下发出和供应商确认');
            const production = root.productions.find(job => job.sourcePurchaseId === purchase.id);
            if (production && fulfillmentProductionFact(root, production.id)?.completion) fail('最终完工事实已冻结，请勿继续追加交付');
            if (production && purchase.kind === 'processing') requireProductionRelease(root, production);
            const quantity = qty(p.quantity, '实收数量', true), rejected = qty(p.rejected, '拒收数量', true), location = text(p.location, '实际收货地点'), date = day(p.date, '收货日期'), evidence = text(p.evidence, '交接依据'), fileIds = files(root, p.fileIds);
            if (sum([quantity, rejected]) <= 0) fail('实收与拒收数量至少有一项大于零');
            if (date > ctx.now.slice(0, 10))
                fail('收货日期不得在未来');
            if (!['warehouse', 'supplier'].includes(p.destination))
                fail('收货路径无效');
            if (purchase.kind === 'processing' && p.destination === 'warehouse')
                fail('加工服务交付不能作为物料入库');
            const id = ctx.id();
            f.receipts.push({ id, purchaseId: purchase.id, quantity, rejected, destination: p.destination, location, date, evidence, fileIds, actor: ctx.actorName, createdAt: ctx.now });
            purchase.received = sum([purchase.received, quantity]);
            const branch = root.productions.find(job => job.sourcePurchaseId === purchase.id);
            if (branch && quantity > 0) {
                productionFact(root, branch.id).revision++;
                branch.pct = Math.min(100, Math.round(purchase.received / purchase.quantity * 100));
                branch.col = 'qc';
                branch.risk = `${purchase.kind === 'finished' ? '成品采购' : '加工采购'} · 已交付 ${purchase.received} ${purchase.unit}，待对应生产QC`;
                for (const task of f.qcTasks) if (task.kind === 'production' && task.source.kind === 'orderLine' && task.source.productionId === branch.id && task.state === 'reported') task.state = 'working';
            }
            if (p.destination === 'warehouse' && quantity > 0) {
                const stockId = ctx.id();
                f.stock.push({ id: stockId, purchaseId: purchase.id, receiptId: id, orderId: purchase.orderId, lineId: purchase.lineId, name: purchase.description, unit: purchase.unit, quantity, available: quantity, location, owner: '公司', createdAt: ctx.now });
                f.stockMovements.push({ id: ctx.id(), stockId, kind: 'receive', quantity, location, person: purchase.supplier, note: evidence, at: ctx.now, actor: ctx.actorName });
            }
            audit(root, ctx, 'procurement', purchase.id, `登记真实交付 ${quantity} ${purchase.unit}${purchase.received !== purchase.quantity ? ' · 数量差异待处理' : ''}`, { view: 'orders/detail', id: purchase.orderId, orderLineId: purchase.lineId });
            return { id, purchaseId: purchase.id };
        }
        case 'fulfillment.inventory.move': {
            const stock = get(f.stock, p.id, '库存批次');
            if(stock.sourceKind==='claimReturn')fail('退回隔离库存仅可按案件实际处置，不能通用出库、退回或移位');
            if (!['issue', 'return', 'move'].includes(p.kind))
                fail('库存操作无效');
            let quantity = p.kind === 'move' ? 0 : qty(p.quantity);
            const location = text(p.location, '实际地点'), person = text(p.person, '接收/交付方'), note = text(p.note, '交接依据');
            let issue: FulfillmentStockMovement | undefined;
            if (p.kind === 'return') {
                issue = get(f.stockMovements, p.issueId, '原出库');
                if (issue.stockId !== stock.id || issue.kind !== 'issue')
                    fail('退回须关联原批次出库');
                const returned = sum(f.stockMovements.filter(m => m.issueId === issue!.id).map(m => m.quantity));
                if (quantity > sum([issue.quantity, -returned]))
                    fail('退回超过原出库未还量');
            }
            else if (quantity > stock.available)
                fail('库存可用量不足');
            let sourceLocation: string | undefined;
            if (p.kind === 'return') addAtPosition(stock, quantity, location);
            else {
                const position = sourcePosition(stock, p.sourceLocation);
                if (p.kind === 'move') quantity = position.available;
                sourceLocation = removeAtPosition(stock, quantity, position.location);
                if (p.kind === 'move') addAtPosition(stock, quantity, location);
            }
            const id = ctx.id();
            f.stockMovements.push({ id, stockId: stock.id, kind: p.kind, quantity, location, person, note, at: ctx.now, actor: ctx.actorName, ...(sourceLocation === undefined ? {} : { sourceLocation }), ...(issue ? { issueId: issue.id } : {}) });
            audit(root, ctx, 'inventory', stock.id, '登记实际库存交接');
            return { id };
        }
        case 'fulfillment.shipments.sourceTerms': {
            const order = get(root.orders, p.orderId, '订单');
            if (f.shipments.some(s => s.lines.some(l => l.orderId === order.id) && s.state !== 'cancelled'))
                fail('已有有效出运，合同收货条款不能覆盖');
            if (typeof p.partialAllowed !== 'boolean' || !['sea', 'air'].includes(p.mode))
                fail('请明确分批与运输条款');
            const row: FulfillmentShippingTerms = { orderId: order.id, consignee: text(p.consignee, '合同收货方'), partialAllowed: p.partialAllowed, mode: p.mode, confirmedAt: day(p.confirmedAt, '条款确认日'), evidence: text(p.evidence, '合同/信用证确认依据') };
            if (row.confirmedAt > ctx.now.slice(0, 10))
                fail('条款确认日期不能在未来');
            const old = f.shippingTerms.find(t => t.orderId === order.id);
            if (old)
                Object.assign(old, row);
            else
                f.shippingTerms.push(row);
            audit(root, ctx, 'order', order.id, '登记已核实合同收货与分批条款');
            return { id: order.id };
        }
        case 'fulfillment.shipments.save': {
            if (!Array.isArray(p.lines) || !p.lines.length)
                fail('请选准确订单条目');
            const old = p.id ? get(f.shipments, p.id, '出运') : undefined;
            if (old)
                requireEditableShipment(old);
            const first = get(root.orders, p.lines[0].orderId, '订单'), firstTerms = f.shippingTerms.find(t => t.orderId === first.id);
            if (!firstTerms)
                fail('请先在来源订单登记合同收货方与分批条款');
            if (p.consignee !== firstTerms!.consignee || p.mode !== firstTerms!.mode)
                fail('收货方或运输方式与来源合同不符');
            const lines: ShipmentLine[] = p.lines.map((l: any) => { source(root, { kind: 'orderLine', orderId: l.orderId, lineId: l.lineId, productionId: l.productionId }); const order = assertMistOrderApproved(root, l.orderId), line = get(root.orderLines, l.lineId, '条目'), branches = root.productions.filter(job => job.lineId === line.id); const productionId = l.productionId || (branches.length === 1 ? branches[0].id : undefined); if (!productionId)
                fail('请先建立并选择准确生产分支'); if (order.customerId !== first.customerId || order.type !== first.type)
                fail('不同客户或业务域不能合票'); const terms = f.shippingTerms.find(t => t.orderId === order.id); if (!terms || terms.consignee !== firstTerms!.consignee || terms.mode !== firstTerms!.mode)
                fail('合票条目的合同收货方或运输方式不同'); if (!order.handoffAt)
                fail('订单尚未完成履约交接'); const quantity = qty(l.quantity), reserved = sum(f.shipments.filter(s => s.id !== old?.id && s.state !== 'cancelled').flatMap(s => s.lines.filter(i => i.lineId === line.id).map(i => i.quantity))); if (day(l.factoryConfirmedAt, '工厂可出运确认日') > ctx.now.slice(0, 10))
                fail('工厂确认日期不得在未来'); const allocation: ShipmentLine = { lineId: line.id, orderId: order.id, ...(productionId ? { productionId } : {}), quantity, factoryConfirmedAt: day(l.factoryConfirmedAt, '工厂可出运确认日') }; checkPhysicalReservation(root, allocation, old?.id); return allocation; });
            if (new Set(lines.map(l => `${l.lineId}:${l.productionId || ''}`)).size !== lines.length)
                fail('同一来源不可重复添加');
            for (const lineId of new Set(lines.map(l => l.lineId))) {
                const sourceLine = get(root.orderLines, lineId, '来源条目'), terms = f.shippingTerms.find(t => t.orderId === sourceLine.orderId)!;
                const total = sum(lines.filter(l => l.lineId === lineId).map(l => l.quantity)), reserved = sum(f.shipments.filter(s => s.id !== old?.id && s.state !== 'cancelled').flatMap(s => s.lines.filter(l => l.lineId === lineId).map(l => l.quantity)));
                const branches = root.productions.filter(branch => branch.lineId === lineId);
                if (!terms.partialAllowed) {
                    const finalTotal = sum(branches.map(branch => physicalCapacity(root, { orderId: branch.orderId, lineId, productionId: branch.id, quantity: 0, factoryConfirmedAt: '' })));
                    if (reserved > 0 || total !== finalTotal) fail('来源合同禁止分批，须一票覆盖整条最终已确认数量');
                }
            }
            if (!['sea', 'air'].includes(p.mode))
                fail('运输方式仅支持海运或空运');
            const id = old?.id || ctx.id();
            const row: FulfillmentShipment = { id, code: old?.code || code('SHP', f.shipments, ctx), customerId: first.customerId, customer: first.customer, domain: first.type, consignee: text(p.consignee, '收货方'), mode: p.mode, portOfLoading: text(p.portOfLoading, '起运港'), portOfDischarge: text(p.portOfDischarge, '目的港'), incoterm: text(p.incoterm, '贸易术语'), plannedDate: day(p.plannedDate, '计划出运日', false), booking: text(p.booking, '订舱号', false), lines, note: text(p.note, '备注', false), fileIds: files(root, p.fileIds), state: 'preparing', requestedBy: old?.requestedBy || ctx.actorName, requesterId: old?.requesterId || ctx.actorId || '', createdAt: old?.createdAt || ctx.now };
            if (old) {
                if (f.packing.some(a => a.shipmentId === id) || f.documents.some(d => d.shipmentId === id && d.status === 'issued') || f.customs.some(c => c.shipmentId === id && c.status !== 'draft'))
                    fail('已有装箱/正式单据/申报事实，不能覆盖出运来源');
                Object.assign(old, row);
            }
            else
                f.shipments.push(row);
            audit(root, ctx, 'shipment', id, '保存出运请求', { view: 'shipments', id });
            return { id };
        }
        case 'fulfillment.shipments.pack': {
            const s = get(f.shipments, p.id, '出运');
            requireEditableShipment(s);
            if (f.documents.some(document => document.shipmentId === s.id && document.status === 'issued' && ['CI', 'PL'].includes(document.type))) fail('已有有效CI或装箱单，请先作废原件再修改装箱分配');
            if (f.customs.some(record => record.shipmentId === s.id && record.status !== 'draft')) fail('已有实际申报或清关记录，请先完成外部更正后再处理装箱');
            if (!Array.isArray(p.lines) || !p.lines.length)
                fail('请登记装箱分配');
            const allocation: FulfillmentPacking[] = p.lines.map((l: any) => { const candidates = s.lines.filter(i => i.lineId === l.lineId), line = candidates.find(i => i.productionId === l.productionId) || (l.productionId === undefined && candidates.length === 1 ? candidates[0] : undefined); if (!line)
                fail('请选择本票准确条目与生产分支'); const netWeight = qty(l.netWeight, '净重', true), grossWeight = qty(l.grossWeight, '毛重', true); if (grossWeight < netWeight)
                fail('毛重不能小于净重'); return { id: ctx.id(), shipmentId: s.id, lineId: l.lineId, ...(line!.productionId ? { productionId: line!.productionId } : {}), carton: text(l.carton, '箱号'), quantity: qty(l.quantity), netWeight, grossWeight, volume: qty(l.volume, '体积', true), note: text(l.note, '备注', false) }; });
            for (const line of s.lines)
                if (sum(allocation.filter(a => a.lineId === line.lineId && a.productionId === line.productionId).map(a => a.quantity)) !== line.quantity)
                    fail('逐条目装箱数量必须等于本次计划数量');
            f.packing = f.packing.filter(a => a.shipmentId !== s.id).concat(allocation);
            s.state = 'preparing';
            audit(root, ctx, 'shipment', s.id, '保存数量守恒的装箱分配');
            return { id: s.id };
        }
        case 'fulfillment.shipments.updateTransport': {
            const shipment = get(f.shipments, p.id, '出运');
            requireEditableShipment(shipment);
            const booking = text(p.booking, '订舱号', false), plannedDate = day(p.plannedDate, '计划出运日', false);
            const note = text(p.note, '运输安排说明', !!shipment.booking && shipment.booking !== booking);
            const previous = shipment.booking;
            shipment.booking = booking; shipment.plannedDate = plannedDate; shipment.note = note;
            audit(root, ctx, 'shipment', shipment.id, `更新运输安排：${previous || '未订舱'} → ${booking || '未订舱'}；计划 ${plannedDate || '未定'}${note ? '；' + note : ''}`, { view: 'shipments', id: shipment.id });
            return { id: shipment.id };
        }
        case 'fulfillment.shipments.ready': {
            const s = get(f.shipments, p.id, '出运');
            requireEditableShipment(s);
            for (const line of s.lines) {
                assertMistOrderApproved(root, line.orderId);
                sourceQuality(root, line);
                requireSampleRole(root, get(root.productions, line.productionId!, '准确生产分支'), 'shipping', s.id);
                checkPhysicalReservation(root, line, s.id);
                if (sum(f.packing.filter(a => a.shipmentId === s.id && a.lineId === line.lineId && a.productionId === line.productionId).map(a => a.quantity)) !== line.quantity)
                    fail('装箱数量未匹配计划');
            }
            requiredShipmentDocuments(root, s);
            s.state = 'ready';
            audit(root, ctx, 'shipment', s.id, '单据准备完毕，返回业务发送', { view: 'shipments', id: s.id });
            return { id: s.id };
        }
        case 'fulfillment.shipments.sent': {
            const s = get(f.shipments, p.id, '出运');
            if (s.state !== 'ready')
                fail('请先完成后勤单据准备');
            const documents = requiredShipmentDocuments(root, s);
            s.documentsSentAt = instant(p.at, ctx, '对客发送时间');
            s.documentDispatches ||= [];
            s.documentDispatches.push({ id: ctx.id(), at: s.documentsSentAt, actor: ctx.actorName, documentIds: documents.map(document => document.id) });
            audit(root, ctx, 'shipment', s.id, '业务已登记对客发送CI/PL');
            return { id: s.id };
        }
        case 'fulfillment.shipments.depart': {
            const s = get(f.shipments, p.id, '出运');
            if (s.state !== 'ready' || !s.documentsSentAt)
                fail('需完成单据准备并由业务登记对客发送');
            if (!f.customs.some(c => c.shipmentId === s.id && c.status === 'cleared'))
                fail('出口清关尚未完成');
            s.lines.forEach(l => { assertMistOrderApproved(root, l.orderId); assertMistOrderDeposit(root, l.orderId); sourceQuality(root, l); requireSampleRole(root, get(root.productions, l.productionId!, '准确生产分支'), 'shipping', s.id); checkPhysicalReservation(root, l, s.id); });
            requiredShipmentDocuments(root, s);
            const at = instant(p.at, ctx, '实际离港/起飞时间');
            if (at < s.documentsSentAt!)
                fail('实际出运不得早于单据发送');
            s.departureEvidence = text(p.evidence, '实际离港/起飞依据');
            s.fileIds = [...new Set([...s.fileIds, ...files(root, p.fileIds)])];
            s.departedAt = at;
            s.state = 'departed';
            audit(root, ctx, 'shipment', s.id, '已登记实际出运', { view: 'orders/detail', id: s.lines[0].orderId, orderLineId: s.lines[0].lineId });
            return { id: s.id };
        }
        case 'fulfillment.shipments.cancel': {
            const s = get(f.shipments, p.id, '出运');
            requireEditableShipment(s);
            if (s.requesterId !== ctx.actorId)
                fail('仅原业务发起人可取消');
            if (s.booking || f.documents.some(d => d.shipmentId === s.id && d.status === 'issued') || f.customs.some(c => c.shipmentId === s.id && c.status !== 'draft'))
                fail('已有订舱、有效单据或申报事实，请先完成对应撤销');
            s.cancelReason = text(p.reason, '取消原因');
            s.state = 'cancelled';
            audit(root, ctx, 'shipment', s.id, '取消本次出运请求');
            return { id: s.id };
        }
        case 'fulfillment.customs.save': {
            const s = get(f.shipments, p.shipmentId, '出运');
            requireEditableShipment(s);
            const old = p.id ? get(f.customs, p.id, '报关单') : undefined;
            if (old && old.shipmentId !== s.id)
                fail('报关来源不可更换');
            if (old?.status === 'cleared')
                fail('已清关记录不可覆盖');
            if (!['draft', 'submitted', 'cleared'].includes(p.status))
                fail('报关状态无效');
            const id = old?.id || ctx.id(), fileIds = files(root, p.fileIds);
            const row: FulfillmentCustoms = { id, shipmentId: s.id, code: old?.code || code('CUS', f.customs, ctx), status: p.status, declarationNo: text(p.declarationNo, '报关单号', p.status !== 'draft'), broker: text(p.broker, '报关行', p.status !== 'draft'), hsCode: text(p.hsCode, 'HS编码', p.status !== 'draft'), origin: text(p.origin, '原产地', p.status !== 'draft'), tradeMode: text(p.tradeMode, '成交方式', p.status !== 'draft'), declaredAt: day(p.declaredAt, '申报日', p.status !== 'draft'), clearedAt: day(p.clearedAt, '清关日', p.status === 'cleared'), evidence: text(p.evidence, '外部申报/清关依据', p.status === 'cleared'), fileIds, note: text(p.note, '备注', false) };
            if (row.clearedAt && row.declaredAt && row.clearedAt < row.declaredAt)
                fail('清关不能早于申报');
            if (row.clearedAt > ctx.now.slice(0, 10) || row.declaredAt > ctx.now.slice(0, 10))
                fail('实际申报/清关日期不得在未来');
            if (old)
                Object.assign(old, row);
            else
                f.customs.push(row);
            audit(root, ctx, 'customs', id, `登记外部报关事实：${p.status}`, { view: 'shipments', id: s.id });
            return { id };
        }
        case 'fulfillment.documents.save': {
            const s = get(f.shipments, p.shipmentId, '出运');
            if (!['CI', 'PL', 'BL', 'CO', 'OTHER'].includes(p.type))
                fail('单据类型无效');
            if (['CI', 'PL'].includes(p.type)) requireEditableShipment(s);
            else if (s.state === 'cancelled') fail('已取消出运不可新增外部单据原件');
            if (p.orderId && !s.lines.some(l => l.orderId === p.orderId))
                fail('单据订单不属于出运');
            if (p.type === 'CI' && !p.orderId)
                fail('CI须绑定一份准确订单');
            const old = p.id ? get(f.documents, p.id, '单据') : undefined;
            if (old && (old.shipmentId !== s.id || old.type !== p.type || old.orderId !== p.orderId))
                fail('单据来源/类型不可更换');
            if (old && old.status !== 'draft')
                fail('已签发或作废单据保留历史，请建立新版本');
            const id = old?.id || ctx.id();
            const row: FulfillmentDocument = { id, shipmentId: s.id, orderId: p.orderId || '', type: p.type, number: text(p.number, '单据编号'), version: old?.version || Math.max(0, ...f.documents.filter(d => d.shipmentId === s.id && d.type === p.type && d.orderId === p.orderId).map(d => d.version)) + 1, title: text(p.title, '标题'), dueDate: day(p.dueDate, 'CI合同应收日', p.type === 'CI'), content: text(p.content, '单据正文'), fileIds: files(root, p.fileIds), status: 'draft', createdAt: old?.createdAt || ctx.now, actor: ctx.actorName };
            if (old)
                Object.assign(old, row);
            else
                f.documents.push(row);
            audit(root, ctx, 'document', id, '保存单据版本');
            return { id };
        }
        case 'fulfillment.documents.issue': {
            const d = get(f.documents, p.id, '单据');
            if (!['CI', 'PL'].includes(d.type)) fail('外部机构单据只能归档签发原件，不能由本系统签发');
            if (d.status !== 'draft')
                fail('仅草稿可签发');
            const s = get(f.shipments, d.shipmentId, '出运');
            requireEditableShipment(s);
            if (!d.fileIds.length)
                fail('请上传核对后的正式单据文件');
            if (f.documents.some(o => o.id !== d.id && o.shipmentId === d.shipmentId && o.orderId === d.orderId && o.type === d.type && o.status === 'issued'))
                fail('相同来源已有有效签发版本');
            if (d.type === 'PL' && s.lines.some(l => sum(f.packing.filter(a => a.shipmentId === s.id && a.lineId === l.lineId && a.productionId === l.productionId).map(a => a.quantity)) !== l.quantity))
                fail('装箱分配未匹配计划');
            if (d.type === 'CI') {
                const order = get(root.orders, d.orderId, '订单');
                const amount = sum(s.lines.filter(l => l.orderId === order.id).map(l => lineAmount(l.quantity, get(root.orderLines, l.lineId, '条目').price)));
                const existing = root.invoices.filter(i => i.orderId === order.id && isActiveMistInvoice(i));
                if (existing.some(i => i.currency !== order.currency))
                    fail('来源订单已有不同币种发票，请先核实财务来源');
                const issued = existing.reduce((n, i) => n + BigInt(mistMoneyMinor(i.amount)), BigInt("0"));
                if (issued + BigInt(mistMoneyMinor(amount)) > BigInt(mistMoneyMinor(order.amount)))
                    fail('CI金额超过来源订单尚未开票额度');
                const id = ctx.id();
                root.invoices.push({ id, code: d.number, orderId: order.id, order: order.code, customer: order.customer, due: d.dueDate, amount, open: amount, currency: order.currency });
                d.invoiceId = id;
            }
            d.status = 'issued';
            d.issuedAt = ctx.now;
            audit(root, ctx, 'document', d.id, '签发单据并返回来源', { view: d.type === 'CI' ? 'invoices' : 'shipments', id: d.type === 'CI' ? d.invoiceId : s.id });
            return { id: d.id, invoiceId: d.invoiceId };
        }
        case 'fulfillment.documents.archiveExternal': {
            const d = get(f.documents, p.id, '外部单据');
            if (['CI', 'PL'].includes(d.type) || d.status !== 'draft') fail('仅外部单据草稿可归档原件');
            if (get(f.shipments, d.shipmentId, '出运').state === 'cancelled') fail('已取消出运不可归档新原件');
            if (!d.fileIds.length) fail('请上传外部机构签发的原件');
            d.externalIssue = { issuer: text(p.issuer, '外部签发机构'), at: instant(p.at, ctx, '外部签发时间'), evidence: text(p.evidence, '原件来源依据'), recordedBy: ctx.actorName };
            d.status = 'issued';
            d.issuedAt = d.externalIssue.at;
            audit(root, ctx, 'document', d.id, '已归档外部机构签发原件');
            return { id: d.id };
        }
        case 'fulfillment.documents.void': {
            const d = get(f.documents, p.id, '单据');
            if (d.status !== 'issued')
                fail('仅有效签发单据可作废');
            const s = get(f.shipments, d.shipmentId, '出运');
            requireEditableShipment(s);
            const reason = text(p.reason, '作废原因');
            if (d.invoiceId) {
                const inv = get(root.invoices, d.invoiceId, '应收来源');
                const claimIds = new Set((root.platform?.claims || []).filter(c => c.invoiceId === inv.id && c.state !== 'Cancelled').map(c => c.id));
                const hasCredit = (root.platform?.credits || []).some(c => claimIds.has(c.claimId));
                const hasCreditApplication = (root.platform?.creditApplications || []).some(a => a.invoiceId === inv.id);
                if (inv.open !== inv.amount || root.allocations.some(a => a.invoiceId === inv.id) || claimIds.size || hasCredit || hasCreditApplication)
                    fail('CI已有收款、索赔或贷项事实，请先走财务更正');
                inv.voidedAt = ctx.now;
                inv.voidReason = reason;
                inv.voidedBy = ctx.actorName;
                inv.voidedById = ctx.actorId;
                inv.voidSourceDocumentId = d.id;
                inv.open = 0;
            }
            d.status = 'void';
            s.state = 'preparing';
            delete s.documentsSentAt;
            audit(root, ctx, 'document', d.id, `单据作废：${reason}`);
            return { id: d.id };
        }
        default: return fail('未知履约操作');
    }
}
