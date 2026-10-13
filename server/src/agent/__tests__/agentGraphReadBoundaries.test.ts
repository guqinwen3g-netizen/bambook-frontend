import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentityService } from '../identity';
import { executeAgentTool, runAgentToolCalls } from '../toolRuntime';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';

// Actual policy/runtime/domain resolvers; only storage is replaced. Independent
// contracts: quotationRoute's quotations:read; CRM V2's crm:read + L2 followed
// or shared customer; procurement receipt parent PO visibility; production read
// + parent order visibility. Inventory/MES minimal scopes come from the actual
// VIEW_TO_MAIN_SCOPES matrix, not their legacy authenticate-only HTTP routes;
// those human routes still need the same row/cost fix. Graph output is always
// identifiers only. These are not PG/JWT/company-policy/UAT evidence.
const USER = 'graph-business-reader';
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === 'AND') return value.every((part: any) => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('has' in value) return row[key]?.includes(value.has);
    }
    return row[key] === value;
  });
}
function storage() {
  const state: Record<string, any[]> = {
    userAccount: [{ id: USER, status: 'active', deletedAt: null }],
    productAsset: [{ id: 'product-public', sku: 'SKU-PUBLIC', deletedAt: null }],
    quotation: [{ id: 'quote-source', quotationNumber: 'QT-PUBLIC', deletedAt: null, unitPrice: 12345, notes: 'private-note' }],
    opportunity: [{ id: 'opp-source', relationId: 'customer-own', deletedAt: null, title: 'private-title', amount: 12345 }],
    relation: [{ id: 'customer-own', deletedAt: null, sensitivity: 'normal', ownerId: USER, salesRepIds: [], departmentId: null }],
    order: [{ id: 'order-own', ownerId: USER, customerRelationId: null, deletedAt: null }],
    purchaseOrder: [{ id: 'po-own', poNumber: 'PO-PUBLIC', orderId: 'order-own', deletedAt: null, totalAmount: 12345 }],
    materialReceipt: [{ id: 'receipt-source', receiptNumber: 'MR-PUBLIC', purchaseOrderId: 'po-own', qualityNotes: 'private-note' }],
    productionStage: [{ id: 'stage-source', orderId: 'order-own', stageKey: 'materials_confirmed', note: 'private-note' }],
    inventoryItem: [{ id: 'inventory-source', materialCode: 'MAT-PUBLIC', orderId: 'order-own', deletedAt: null, description: 'private-title', unitCost: 12345, quantity: 50 }],
    stockMovement: [{ id: 'movement-source', movementNumber: 'SM-PUBLIC', itemId: 'inventory-source', referenceType: 'Order', referenceId: 'order-own', unitCost: 12345, notes: 'private-note' }],
    warehouse: [{ id: 'warehouse-source', code: 'WH-PUBLIC', deletedAt: null, address: 'private-note', manager: 'private-person' }],
    outsourcingOrder: [{ id: 'outsourcing-source', orderNumber: 'OSO-PUBLIC', orderId: 'order-own', deletedAt: null, unitPrice: 12345, totalAmount: 12345, notes: 'private-note' }],
    shipment: [{ id: 'shipment-own', shipmentNumber: 'SHIP-PUBLIC', orderId: null, deletedAt: null }],
    shipmentOrderAllocation: [{ shipmentId: 'shipment-own', orderId: 'order-own' }],
    entityLink: [], teamMember: [], teamDataGrant: [],
  };
  const prisma: any = {
    userRole: { findMany: vi.fn().mockResolvedValue([]) },
    agentTool: { upsert: vi.fn().mockResolvedValue({}) },
    agentToolRun: { create: vi.fn(async ({ data }: any) => data) },
    auditLog: { create: vi.fn() }, approvalRequest: { create: vi.fn() },
    entityReference: { findMany: vi.fn() }, $transaction: vi.fn(),
  };
  for (const model of Object.keys(state)) {
    const select = (row: any, fields: any) => !row || !fields ? row : Object.fromEntries(Object.keys(fields).filter(key => fields[key] === true).map(key => [key, row[key]]));
    prisma[model] = {
      findFirst: vi.fn(async ({ where, select: fields }: any) => select(state[model].find(row => matches(row, where)) ?? null, fields)),
      findUnique: vi.fn(async ({ where, select: fields }: any) => select(state[model].find(row => matches(row, where)) ?? null, fields)),
      findMany: vi.fn(async ({ where, take, select: fields }: any = {}) => state[model].filter(row => matches(row, where)).slice(0, take).map(row => select(row, fields))),
      create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(),
    };
  }
  return { prisma, state };
}
const actor = (permissions: string[]) => createIdentityService().resolveActorContext({ userId: USER, roles: ['viewer'], permissions, authorizationLoaded: true });
const sourceCases = [
  { type: 'quotation', id: 'quote-source', scope: 'quotations:read', model: 'quotation', label: 'QT-PUBLIC' },
  { type: 'opportunity', id: 'opp-source', scope: 'crm:read', model: 'opportunity', label: 'opp-source' },
  { type: 'materialReceipt', id: 'receipt-source', scope: 'procurement:read', model: 'materialReceipt', label: 'MR-PUBLIC' },
  { type: 'productionStage', id: 'stage-source', scope: 'production:read', model: 'productionStage', label: 'materials_confirmed' },
  { type: 'inventoryItem', id: 'inventory-source', scope: 'orders:read', model: 'inventoryItem', label: 'MAT-PUBLIC' },
  { type: 'stockMovement', id: 'movement-source', scope: 'orders:read', model: 'stockMovement', label: 'SM-PUBLIC' },
  { type: 'warehouse', id: 'warehouse-source', scope: 'orders:read', model: 'warehouse', label: 'WH-PUBLIC' },
  { type: 'outsourcingOrder', id: 'outsourcing-source', scope: 'production:read', model: 'outsourcingOrder', label: 'OSO-PUBLIC' },
];
function addLink(state: Record<string, any[]>, fromType: string, fromId: string, toType = 'product', toId = 'product-public', linkKind = 'aboutProduct') {
  state.entityLink.push({ fromType, fromId, toType, toId, linkKind, status: 'active', deletedAt: null, updatedAt: BigInt(1), source: 'private-note', metadata: { amount: 12345 } });
}
function noBusinessWrites(prisma: any) {
  expect(prisma.$transaction).not.toHaveBeenCalled(); expect(prisma.approvalRequest.create).not.toHaveBeenCalled(); expect(prisma.entityReference.findMany).not.toHaveBeenCalled();
  for (const model of ['quotation', 'opportunity', 'relation', 'order', 'purchaseOrder', 'materialReceipt', 'productionStage', 'inventoryItem', 'stockMovement', 'warehouse', 'outsourcingOrder', 'shipment', 'shipmentOrderAllocation', 'productAsset', 'entityLink']) for (const method of ['create', 'update', 'updateMany', 'upsert']) expect(prisma[model][method]).not.toHaveBeenCalled();
  for (const [call] of prisma.auditLog.create.mock.calls) expect(call.data).toMatchObject({ targetType: 'AgentTool', action: expect.stringMatching(/^agent_tool_/) });
  expect(fetch).not.toHaveBeenCalled();
}
beforeEach(() => {
  __clearTeamShareCacheForTests(); vi.stubEnv('BAMBOOK_AGENT_DATA_API_BASE', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('External action prohibited in graph read probe'); }));
});
afterEach(() => { __clearTeamShareCacheForTests(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Agent graph business types (real runtime, storage substitutes)', () => {
  it.each(sourceCases)('legal $type source reads actual graph without business writes', async source => {
    const { prisma, state } = storage(); addLink(state, source.type, source.id);
    const result = await executeAgentTool({ prisma, actor: await actor([source.scope, 'products:read']), toolId: 'links.query', toolInput: { type: source.type, id: source.id } });
    expect(result).toEqual({ ok: true, total: 1, links: [{ direction: 'out', linkKind: 'aboutProduct', otherType: 'product', otherId: 'product-public', label: 'SKU-PUBLIC', updatedAt: 1 }] });
    expect(JSON.stringify(result)).not.toMatch(/private-note|private-title|12345/); noBusinessWrites(prisma);
  });
  it.each(sourceCases)('$type missing actual source scope denies before domain/graph read despite forged input actor', async source => {
    const { prisma } = storage();
    await expect(executeAgentTool({ prisma, actor: await actor(['products:read']), toolId: 'links.query', toolInput: { type: source.type, id: source.id, actor: { userId: USER, roles: ['owner'] } } })).rejects.toThrow(`INSUFFICIENT_SCOPE: ${source.scope}`);
    expect(prisma[source.model].findFirst).not.toHaveBeenCalled(); expect(prisma[source.model].findUnique).not.toHaveBeenCalled(); expect(prisma.entityLink.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it.each(sourceCases)('authorized $type neighbor uses canonical identifiers and missing neighbor scope filters it', async source => {
    const { prisma, state } = storage(); addLink(state, 'product', 'product-public', source.type, source.id);
    const legal = await executeAgentTool({ prisma, actor: await actor(['products:read', source.scope]), toolId: 'links.expand_neighbors', toolInput: { type: 'product', id: 'product-public' } });
    expect(legal).toMatchObject({ ok: true, total: 1, neighbors: { aboutProduct: [{ type: source.type, id: source.id, label: source.label }] } });
    const denied = await executeAgentTool({ prisma, actor: await actor(['products:read']), toolId: 'links.expand_neighbors', toolInput: { type: 'product', id: 'product-public' } });
    expect(denied).toEqual({ ok: true, type: 'product', id: 'product-public', total: 0, neighbors: {} });
    expect(JSON.stringify(legal)).not.toMatch(/private-note|private-title|12345/); noBusinessWrites(prisma);
  });
  it('CRM read plus normal-library relation read cannot expose an unrelated customer opportunity', async () => {
    const { prisma, state } = storage(); state.relation[0].ownerId = 'unrelated-owner'; addLink(state, 'opportunity', 'opp-source');
    const result = await executeAgentTool({ prisma, actor: await actor(['crm:read', 'relations:read', 'products:read']), toolId: 'links.query', toolInput: { type: 'opportunity', id: 'opp-source' } });
    expect(result).toEqual({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' }); expect(prisma.entityLink.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('actual active team grant restores customer L2 opportunity read without granting L1 relations scope', async () => {
    const { prisma, state } = storage(); state.relation[0].ownerId = 'unrelated-owner';
    state.teamMember.push({ userId: USER, teamId: 'team-live', leftAt: null }); state.teamDataGrant.push({ teamId: 'team-live', entityType: 'relation', entityId: 'customer-own', revokedAt: null, team: { deletedAt: null } });
    // Adapter mirrors the actual relational filter without treating team input as authority.
    prisma.teamDataGrant.findMany.mockImplementation(async ({ where }: any) => state.teamDataGrant.filter(row => where.teamId.in.includes(row.teamId) && row.revokedAt === null && row.team.deletedAt === null).map(row => ({ entityId: row.entityId })));
    addLink(state, 'opportunity', 'opp-source');
    const result = await executeAgentTool({ prisma, actor: await actor(['crm:read', 'products:read']), toolId: 'links.query', toolInput: { type: 'opportunity', id: 'opp-source' } });
    expect(result).toMatchObject({ ok: true, total: 1 }); expect(prisma.teamDataGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ revokedAt: null, team: { deletedAt: null } }) })); noBusinessWrites(prisma);
  });
  it.each(sourceCases.filter(source => ['materialReceipt', 'productionStage', 'inventoryItem', 'stockMovement', 'outsourcingOrder'].includes(source.type)))('$type parent order outside actual visibility rejects before graph read', async source => {
    const { prisma, state } = storage(); state.order[0].ownerId = 'unrelated-owner'; addLink(state, source.type, source.id);
    const result = await executeAgentTool({ prisma, actor: await actor([source.scope, 'products:read']), toolId: 'links.query', toolInput: { type: source.type, id: source.id } });
    expect(result).toEqual({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' }); expect(prisma.entityLink.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it.each(['missing-customer', 'deleted-po', 'deleted-order'])('dangling/deleted parent %s never authorizes a source', async mode => {
    const { prisma, state } = storage(); const source = mode === 'missing-customer' ? sourceCases[1] : mode === 'deleted-po' ? sourceCases[2] : sourceCases[3];
    if (mode === 'missing-customer') state.relation.length = 0;
    if (mode === 'deleted-po') state.purchaseOrder[0].deletedAt = BigInt(1);
    if (mode === 'deleted-order') state.order[0].deletedAt = BigInt(1);
    const result = await executeAgentTool({ prisma, actor: await actor([source.scope]), toolId: 'links.query', toolInput: { type: source.type, id: source.id } });
    expect(result).toEqual({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' }); expect(prisma.entityLink.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('loop forwards real source scope and preserves legal material-receipt reads', async () => {
    const { prisma, state } = storage(); addLink(state, 'materialReceipt', 'receipt-source');
    await runAgentToolCalls({ prisma, actor: await actor(['procurement:read', 'products:read']), calls: [{ toolId: 'links.query', input: { type: 'materialReceipt', id: 'receipt-source' }, reason: 'receipt graph visibility' }] });
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'success', output: expect.objectContaining({ ok: true, total: 1 }) }) }); noBusinessWrites(prisma);
  });
  it('production stage read selects only canonical fields and never initializes missing stages', async () => {
    const { prisma } = storage(); await executeAgentTool({ prisma, actor: await actor(['production:read']), toolId: 'links.query', toolInput: { type: 'productionStage', id: 'stage-source' } });
    expect(prisma.productionStage.findUnique).toHaveBeenCalledWith({ where: { id: 'stage-source' }, select: { id: true, orderId: true, stageKey: true } }); expect(prisma.productionStage.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it.each([{ type: 'inventoryItem', id: 'inventory-source', scope: 'orders:read' }, { type: 'outsourcingOrder', id: 'outsourcing-source', scope: 'production:read' }])('unassigned $type remains module-readable without inventing private ownership', async source => {
    const { prisma, state } = storage(); state[source.type][0].orderId = null; state.order.length = 0; addLink(state, source.type, source.id);
    const result = await executeAgentTool({ prisma, actor: await actor([source.scope, 'products:read']), toolId: 'links.query', toolInput: { type: source.type, id: source.id } });
    expect(result).toMatchObject({ ok: true, total: 1 }); noBusinessWrites(prisma);
  });
  it.each([{ scope: 'inventory:read', type: 'inventoryItem', id: 'inventory-source', required: 'orders:read' }, { scope: 'inventory:read', type: 'warehouse', id: 'warehouse-source', required: 'orders:read' }])('$scope cannot substitute for actual View.Inventory $required source gate', async source => {
    const { prisma } = storage();
    await expect(executeAgentTool({ prisma, actor: await actor([source.scope]), toolId: 'links.query', toolInput: { type: source.type, id: source.id } })).rejects.toThrow(`INSUFFICIENT_SCOPE: ${source.required}`); noBusinessWrites(prisma);
  });
  it('inventory/MES canonical selects do not fetch costs, descriptions, quantities, people or addresses', async () => {
    const { prisma } = storage();
    for (const source of sourceCases.filter(item => ['inventoryItem', 'stockMovement', 'warehouse', 'outsourcingOrder'].includes(item.type))) {
      await executeAgentTool({ prisma, actor: await actor([source.scope]), toolId: 'links.query', toolInput: { type: source.type, id: source.id } });
      for (const [args] of [...prisma[source.model].findFirst.mock.calls, ...prisma[source.model].findUnique.mock.calls]) for (const forbidden of ['unitCost', 'unitPrice', 'totalAmount', 'description', 'quantity', 'address', 'manager']) expect(Object.keys(args.select)).not.toContain(forbidden);
    }
    expect(prisma.inventoryItem.findFirst).toHaveBeenCalledWith({ where: { id: 'inventory-source', deletedAt: null }, select: { id: true, materialCode: true, orderId: true } });
    expect(prisma.outsourcingOrder.findFirst).toHaveBeenCalledWith({ where: { id: 'outsourcing-source', deletedAt: null }, select: { id: true, orderNumber: true, orderId: true } }); noBusinessWrites(prisma);
  });
  it.each([
    { referenceType: 'PurchaseOrder', referenceId: 'po-own', scope: 'procurement:read' },
    { referenceType: 'MaterialReceipt', referenceId: 'receipt-source', scope: 'procurement:read' },
    { referenceType: 'Order', referenceId: 'order-own', scope: 'orders:read' },
    { referenceType: 'Shipment', referenceId: 'shipment-own', scope: 'shipments:read' },
    { referenceType: 'ProductionStage', referenceId: 'stage-source', scope: 'production:read' },
  ])('known movement reference $referenceType needs both actual item and document row/scope', async reference => {
    const { prisma, state } = storage(); Object.assign(state.stockMovement[0], reference); addLink(state, 'stockMovement', 'movement-source');
    const legal = await executeAgentTool({ prisma, actor: await actor(['orders:read', 'products:read', reference.scope]), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(legal).toMatchObject({ ok: true, total: 1 });
    state.stockMovement[0].referenceId = 'nonexistent-document';
    const denied = await executeAgentTool({ prisma, actor: await actor(['orders:read', 'products:read', reference.scope]), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(denied).toEqual({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' }); noBusinessWrites(prisma);
  });
  it('movement Shipment reference follows actual allocation rows and blocks after its allocation leaves the visible orders', async () => {
    const { prisma, state } = storage(); Object.assign(state.stockMovement[0], { referenceType: 'Shipment', referenceId: 'shipment-own' }); addLink(state, 'stockMovement', 'movement-source');
    const legal = await executeAgentTool({ prisma, actor: await actor(['orders:read', 'shipments:read', 'products:read']), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(legal).toMatchObject({ ok: true, total: 1 }); expect(prisma.shipmentOrderAllocation.findMany).toHaveBeenCalledWith({ where: { shipmentId: 'shipment-own' }, select: { orderId: true } });
    state.shipmentOrderAllocation[0].orderId = 'order-unrelated';
    const denied = await executeAgentTool({ prisma, actor: await actor(['orders:read', 'shipments:read', 'products:read']), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(denied).toEqual({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' }); noBusinessWrites(prisma);
  });
  it('movement Transfer reference permits an actual second movement with visible item and unanchored Manual reference', async () => {
    const { prisma, state } = storage(); Object.assign(state.stockMovement[0], { referenceType: 'Transfer', referenceId: 'movement-next' }); state.stockMovement.push({ id: 'movement-next', movementNumber: 'SM-NEXT', itemId: 'inventory-source', referenceType: 'Manual', referenceId: null }); addLink(state, 'stockMovement', 'movement-source', 'stockMovement', 'movement-next', 'referencesDocument');
    const result = await executeAgentTool({ prisma, actor: await actor(['orders:read']), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(result).toEqual({ ok: true, total: 1, links: [{ direction: 'out', linkKind: 'referencesDocument', otherType: 'stockMovement', otherId: 'movement-next', label: 'SM-NEXT', updatedAt: 1 }] }); noBusinessWrites(prisma);
  });
  it('known movement document permission cannot be replaced by item/orders permission', async () => {
    const { prisma, state } = storage(); Object.assign(state.stockMovement[0], { referenceType: 'PurchaseOrder', referenceId: 'po-own' });
    const result = await executeAgentTool({ prisma, actor: await actor(['orders:read']), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(result).toEqual({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' }); expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('known document visibility cannot compensate for an inaccessible actual inventory item', async () => {
    const { prisma, state } = storage(); state.order.push({ id: 'order-other', ownerId: 'unrelated-owner', customerRelationId: null, deletedAt: null }); state.inventoryItem[0].orderId = 'order-other';
    const result = await executeAgentTool({ prisma, actor: await actor(['orders:read']), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(result).toEqual({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' }); expect(prisma.entityLink.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('unknown polymorphic reference ID stays hidden even when graph forges a known type for it', async () => {
    const { prisma, state } = storage(); Object.assign(state.stockMovement[0], { referenceType: 'UnknownFutureDocument', referenceId: 'product-public' });
    addLink(state, 'stockMovement', 'movement-source', 'product', 'product-public', 'referencesDocument');
    addLink(state, 'stockMovement', 'movement-source', 'inventoryItem', 'inventory-source', 'movesItem');
    const result = await executeAgentTool({ prisma, actor: await actor(['orders:read', 'products:read']), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(result).toEqual({ ok: true, total: 1, links: [{ direction: 'out', linkKind: 'movesItem', otherType: 'inventoryItem', otherId: 'inventory-source', label: 'MAT-PUBLIC', updatedAt: 1 }] }); expect(prisma.productAsset.findFirst).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it.each(['missing-item', 'missing-known-reference', 'self-transfer', 'transfer-cycle'])('movement %s cannot become a metadata authorization shortcut or recursive hang', async mode => {
    const { prisma, state } = storage();
    if (mode === 'missing-item') state.inventoryItem.length = 0;
    if (mode === 'missing-known-reference') state.stockMovement[0].referenceId = null;
    if (mode === 'self-transfer') Object.assign(state.stockMovement[0], { referenceType: 'Transfer', referenceId: 'movement-source' });
    if (mode === 'transfer-cycle') { Object.assign(state.stockMovement[0], { referenceType: 'Transfer', referenceId: 'movement-next' }); state.stockMovement.push({ id: 'movement-next', movementNumber: 'SM-NEXT', itemId: 'inventory-source', referenceType: 'Transfer', referenceId: 'movement-source' }); }
    const result = await executeAgentTool({ prisma, actor: await actor(['orders:read']), toolId: 'links.query', toolInput: { type: 'stockMovement', id: 'movement-source' } });
    expect(result).toEqual({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' }); expect(prisma.entityLink.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('unknown actual type is denied without becoming a wildcard capability', async () => {
    const { prisma, state } = storage(); addLink(state, 'product', 'product-public', 'newGraphBusinessType', 'unregistered-private-id');
    const result = await executeAgentTool({ prisma, actor: await actor(['products:read']), toolId: 'links.query', toolInput: { type: 'product', id: 'product-public' } });
    expect(result).toEqual({ ok: true, total: 0, links: [] }); noBusinessWrites(prisma);
  });
});
