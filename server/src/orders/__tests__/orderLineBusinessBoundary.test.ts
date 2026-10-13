import { describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
import { createOrderLine, deleteOrderLine, updateOrderLine } from '../orderLineMutationService';
import { authorizeOrderLineWrite } from '../orderLineWriteAccess';
import { stripLineWritable } from '../orderLineWritable';

// The real authority, L2 resolver, mutation service, quantity projection and
// audit writer run against this in-memory adapter. No DB client/listener exists.
vi.mock('../../production/stageService', () => ({ advanceStage: vi.fn(async () => undefined) }));
const prior: TokenPayload = { userId: 'sales-boundary', roles: ['owner'], permissions: ['*'], departmentIds: [] };
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => {
    if (key === 'AND' || key === 'OR') {
      const conditions = Array.isArray(value) ? value : [value];
      return key === 'AND' ? conditions.every(condition => matches(row, condition)) : conditions.some(condition => matches(row, condition));
    }
    if (value == null) return row[key] == null;
    if (typeof value === 'object') {
      if ('in' in value) return (value.in as unknown[]).includes(row[key]);
      if ('has' in value) return (row[key] as unknown[] | undefined)?.includes(value.has) ?? false;
      return row[key] != null && matches(row[key] as Record<string, unknown>, value as Record<string, unknown>);
    }
    return row[key] === value;
  });
}
function storage(status = 'Pending', scopes = ['orders:write', 'orders:delete']) {
  let user = { id: prior.userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'role-sales', role: { id: 'role-sales', permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
  const order = { id: 'O1', poNumber: 'PO1', customer: 'Customer', customerRelationId: 'C1', ownerId: 'another',
    status, type: 'fabric', quantity: 10, unit: 'M', deletedAt: null };
  let followed = true, pendingApproval = false;
  let lines: Array<Record<string, any>> = [{ id: 'O1__0010', orderId: order.id, itemNo: '0010', lineNumber: 1,
    quantity: 10, unit: 'M', materialCode: null, notes: '原备注', status: 'Pending', productionSteps: [] }];
  let audits: Array<Record<string, any>> = [];
  const tx = {
    userAccount: { findFirst: vi.fn(async () => user), findUnique: vi.fn(async () => user) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    teamMember: { findMany: vi.fn(async () => []) }, teamDataGrant: { findMany: vi.fn(async () => []) },
    department: { findMany: vi.fn(async () => []) },
    relation: { findMany: vi.fn(async ({ where }: any) => {
      const customer = { id: 'C1', deletedAt: null, ownerId: followed ? prior.userId : 'another', salesRepIds: [] };
      return matches(customer, where) ? [customer] : [];
    }) },
    $queryRaw: vi.fn(async () => [{ id: order.id }]),
    order: { findFirst: vi.fn(async ({ where }: any) => matches(order, where) ? order : null),
      findUniqueOrThrow: vi.fn(async () => order), update: vi.fn(async ({ data }: any) => Object.assign(order, data)) },
    approvalRequest: { findFirst: vi.fn(async () => pendingApproval ? { id: 'APP1' } : null) },
    orderLine: {
      findUnique: vi.fn(async ({ where }: any) => lines.find(row => row.id === where.id) ?? null),
      findMany: vi.fn(async () => lines),
      create: vi.fn(async ({ data }: any) => { const row = { ...data }; lines.push(row); return row; }),
      update: vi.fn(async ({ where, data }: any) => { const index = lines.findIndex(row => row.id === where.id); return lines[index] = { ...lines[index], ...data }; }),
      delete: vi.fn(async ({ where }: any) => { const row = lines.find(row => row.id === where.id); lines = lines.filter(row => row.id !== where.id); return row; }),
    },
    fabricCustomerCode: { findMany: vi.fn(async () => []) },
    entityReference: { upsert: vi.fn(async () => ({})) }, entityLink: { upsert: vi.fn(async () => ({})), count: vi.fn(async () => 0) },
    auditLog: { create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (work: (db: typeof tx) => Promise<unknown>) => {
    const previousLines = [...lines], previousAudits = [...audits], previousOrder = { ...order };
    try { return await work(tx); } catch (error) { lines = previousLines; audits = previousAudits; Object.assign(order, previousOrder); throw error; }
  }) } as any;
  return { tx, prisma, order, lines: () => lines, audits: () => audits, setFollowed: (value: boolean) => { followed = value; },
    setPendingApproval: (value: boolean) => { pendingApproval = value; },
    setUser: (value: typeof user) => { user = value; }, user: () => user };
}
const create = (db: ReturnType<typeof storage>, actor = prior) => createOrderLine({ prisma: db.prisma, orderId: 'O1',
  itemNo: '0020', quantity: 5, unit: 'M', trustedActor: actor });

describe('order-line commercial boundary', () => {
  it('persists exact line value and derives the draft parent totals from all priced lines', async () => {
    const db = storage(); db.lines()[0].netValue = '100';
    const result = await createOrderLine({ prisma: db.prisma, orderId: 'O1', itemNo: '0020', quantity: '5', unit: 'M', unitPrice: '2.50', trustedActor: prior });
    expect(result).toMatchObject({ ok: true });
    expect(String(db.lines().find(row => row.id === 'O1__0020')!.netValue)).toBe('12.5');
    expect(db.order).toMatchObject({ totalNet: expect.anything(), contractAmount: expect.anything(), quoteAmount: expect.anything() });
    expect(String(db.order.quoteAmount)).toBe('112.5'); expect(String(db.order.totalNet)).toBe('112.5');
  });
  it.each([true, false])('persists explicit split shipment %s and the actual line tolerance through the shared writable fields', async partialShipmentAllowed => {
    const db = storage(), extra = stripLineWritable({ partialShipmentAllowed, tolerancePercent: '5.25', toleranceSource: 'line_override', confirmedBy: 'forged-approver' });
    expect(extra).toEqual({ partialShipmentAllowed, tolerancePercent: '5.25', toleranceSource: 'line_override' });
    const result = await createOrderLine({ prisma: db.prisma, orderId: 'O1', itemNo: '0020', quantity: 5, unit: 'M', trustedActor: prior, extra });
    expect(result).toMatchObject({ ok: true });
    const line = db.lines().find(row => row.id === 'O1__0020')!;
    expect(line.partialShipmentAllowed).toBe(partialShipmentAllowed); expect(String(line.tolerancePercent)).toBe('5.25');
    expect(line.toleranceSource).toBe('line_override'); expect(line.confirmedBy).toBeUndefined();
    expect(db.audits()[0]).toMatchObject({ detail: { after: { partialShipmentAllowed, tolerancePercent: '5.25', toleranceSource: 'line_override' } } });
  });
  it.each([0, 100])('records explicit manual tolerance %s as a line override without assuming a default', async tolerancePercent => {
    const db = storage();
    expect(await createOrderLine({ prisma: db.prisma, orderId: 'O1', itemNo: '0020', quantity: 5, unit: 'M', trustedActor: prior,
      extra: stripLineWritable({ tolerancePercent }) })).toMatchObject({ ok: true });
    expect(db.lines().find(row => row.id === 'O1__0020')).toMatchObject({ toleranceSource: 'line_override' });
    expect(String(db.lines().find(row => row.id === 'O1__0020')!.tolerancePercent)).toBe(String(tolerancePercent));
  });
  it('preserves manual shipment terms through garment fulfillment and required-sample normalization on create and update', async () => {
    const db = storage(); db.order.type = 'garment'; db.order.unit = 'PC'; db.lines()[0].unit = 'PC';
    const extra = stripLineWritable({ partialShipmentAllowed: false, tolerancePercent: '2.50', fulfillmentMode: 'cmt', cmtIncludedItems: [],
      requiredSampleFamilies: ['garment_pp', 'garment_ship'] });
    expect(await createOrderLine({ prisma: db.prisma, orderId: 'O1', itemNo: '0020', quantity: 5, unit: 'PC', trustedActor: prior, extra })).toMatchObject({ ok: true });
    const line = db.lines().find(row => row.id === 'O1__0020')!;
    expect(line).toMatchObject({ partialShipmentAllowed: false, tolerancePercent: '2.5', toleranceSource: 'line_override', fulfillmentMode: 'cmt' });
    expect(await updateOrderLine({ prisma: db.prisma, lineId: line.id, trustedActor: prior,
      patch: stripLineWritable({ partialShipmentAllowed: true, tolerancePercent: '3.25', fulfillmentMode: 'cmt', cmtIncludedItems: [], requiredSampleFamilies: ['garment_ship', 'garment_pp'] }) })).toMatchObject({ ok: true });
    expect(db.lines().find(row => row.id === line.id)).toMatchObject({ partialShipmentAllowed: true, tolerancePercent: '3.25', toleranceSource: 'line_override', requiredSampleFamilies: ['garment_pp', 'garment_ship'] });
  });
  it('stores an explicitly unknown tolerance source without marking the reference percentage as an agreement', async () => {
    const db = storage();
    expect(await createOrderLine({ prisma: db.prisma, orderId: 'O1', itemNo: '0020', quantity: 5, unit: 'M', trustedActor: prior,
      extra: stripLineWritable({ tolerancePercent: '5', toleranceSource: null }) })).toMatchObject({ ok: true });
    expect(db.lines().find(row => row.id === 'O1__0020')).toMatchObject({ tolerancePercent: '5', toleranceSource: null });
  });
  it('keeps omitted split and tolerance terms unknown, and supports explicitly clearing only the manual tolerance source', async () => {
    const db = storage(); expect(await create(db)).toMatchObject({ ok: true });
    const created = db.lines().find(row => row.id === 'O1__0020')!;
    expect(created.partialShipmentAllowed ?? null).toBeNull(); expect(created.toleranceSource ?? null).toBeNull();
    expect(await updateOrderLine({ prisma: db.prisma, lineId: created.id, trustedActor: prior,
      patch: stripLineWritable({ partialShipmentAllowed: false, tolerancePercent: '0', toleranceSource: 'line_override' }) })).toMatchObject({ ok: true });
    expect(db.lines().find(row => row.id === created.id)).toMatchObject({ partialShipmentAllowed: false, toleranceSource: 'line_override' });
    expect(await updateOrderLine({ prisma: db.prisma, lineId: created.id, trustedActor: prior,
      patch: stripLineWritable({ partialShipmentAllowed: null, toleranceSource: null }) })).toMatchObject({ ok: true });
    const cleared = db.lines().find(row => row.id === created.id)!;
    expect(cleared.partialShipmentAllowed).toBeNull(); expect(cleared.toleranceSource).toBeNull(); expect(String(cleared.tolerancePercent)).toBe('0');
    expect(db.audits()[db.audits().length - 1]).toMatchObject({ detail: { before: { partialShipmentAllowed: false, toleranceSource: 'line_override' },
      after: { partialShipmentAllowed: null, toleranceSource: null } } });
  });
  it.each([
    { partialShipmentAllowed: 'true' }, { partialShipmentAllowed: 1 }, { partialShipmentAllowed: [] }, { partialShipmentAllowed: {} },
    { tolerancePercent: 'invalid' }, { tolerancePercent: '' }, { tolerancePercent: null }, { tolerancePercent: [] },
    { tolerancePercent: true }, { tolerancePercent: -1 }, { tolerancePercent: 101 }, { tolerancePercent: '5.255' },
    { toleranceSource: 'line_override' }, { toleranceSource: 'customer_standard' }, { toleranceSource: 'internal_standard' },
    { toleranceSource: 'internal_default' }, { toleranceSource: '' }, { toleranceSource: true },
  ])('rejects invalid or falsely attributed shipment terms on create and update without a write: %j', async input => {
    for (const action of ['create', 'update'] as const) {
      const db = storage(), fields = stripLineWritable(input);
      const result = action === 'create'
        ? await createOrderLine({ prisma: db.prisma, orderId: 'O1', itemNo: '0020', quantity: 5, unit: 'M', trustedActor: prior, extra: fields })
        : await updateOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior, patch: fields });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(db.tx.orderLine.create).not.toHaveBeenCalled(); expect(db.tx.orderLine.update).not.toHaveBeenCalled(); expect(db.audits()).toEqual([]);
    }
  });
  it.each(['pending', 'formal'] as const)('keeps valid split and tolerance terms frozen for %s approval', async state => {
    const db = storage(state === 'formal' ? 'Confirmed' : 'Pending'); db.setPendingApproval(state === 'pending');
    expect(await updateOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior,
      patch: stripLineWritable({ partialShipmentAllowed: true, tolerancePercent: 5, toleranceSource: 'line_override' }) }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(db.tx.orderLine.update).not.toHaveBeenCalled(); expect(db.audits()).toEqual([]);
  });
  it('a sales writer cannot add a product line to a formal order', async () => {
    const db = storage('Confirmed');
    expect(await create(db)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(db.tx.orderLine.create).not.toHaveBeenCalled();
    expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('a sales account with delete scope cannot remove a formal product line', async () => {
    const db = storage('Confirmed');
    expect(await deleteOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(db.tx.orderLine.delete).not.toHaveBeenCalled();
    expect(db.tx.entityLink.count).not.toHaveBeenCalled();
    expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('a formal note edit records the actual previous and saved notes', async () => {
    const db = storage('Confirmed');
    expect(await updateOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior,
      patch: { notes: '客户约定周五回访' } })).toMatchObject({ ok: true });
    expect(db.audits()).toHaveLength(1);
    expect(db.audits()[0]).toMatchObject({ actorId: prior.userId, action: 'update_order_line',
      detail: { before: { notes: '原备注' }, after: { notes: '客户约定周五回访' } } });
  });
  it('a current sales writer can add, edit and delete draft lines with separate grants', async () => {
    const db = storage();
    expect(await create(db)).toMatchObject({ ok: true });
    expect(await updateOrderLine({ prisma: db.prisma, lineId: 'O1__0020', trustedActor: prior,
      patch: { quantity: 7, unitPrice: 2.5, notes: '草稿数量已核对' } })).toMatchObject({ ok: true });
    expect(String(db.lines().find(row => row.id === 'O1__0020')!.netValue)).toBe('17.5');
    expect(String(db.order.quantity)).toBe('17');
    expect(await deleteOrderLine({ prisma: db.prisma, lineId: 'O1__0020', trustedActor: prior })).toMatchObject({ ok: true });
    expect(String(db.order.quantity)).toBe('10'); expect(db.lines()).toHaveLength(1);
    expect(db.audits().map(audit => audit.action)).toEqual(['create_order_line', 'update_order_line', 'delete_order_line']);
  });
  it.each(['create', 'update', 'delete'] as const)('pending main approval freezes %s before any write', async action => {
    const db = storage(); db.setPendingApproval(true);
    const result = action === 'create' ? await create(db) : action === 'delete'
      ? await deleteOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior })
      : await updateOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior, patch: { notes: '不可改' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(db.tx.orderLine.create).not.toHaveBeenCalled(); expect(db.tx.orderLine.update).not.toHaveBeenCalled();
    expect(db.tx.orderLine.delete).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('the shared transactional authorizer also freezes fulfillment callers such as QC resume', async () => {
    const db = storage(); db.setPendingApproval(true);
    await expect(authorizeOrderLineWrite(db.tx, 'O1', prior, 'update')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.tx.$queryRaw).toHaveBeenCalled(); expect(db.tx.orderLine.update).not.toHaveBeenCalled();
  });
  it('a rejected approval restores draft editing without deleting prior audit history', async () => {
    const db = storage(); db.setPendingApproval(true);
    expect(await create(db)).toMatchObject({ ok: false });
    db.setPendingApproval(false);
    expect(await create(db)).toMatchObject({ ok: true });
    expect(db.audits()).toHaveLength(1);
  });
  it('a draft sales writer without delete scope cannot delete even its visible line', async () => {
    const db = storage('Pending', ['orders:write']);
    expect(await deleteOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(db.tx.orderLine.delete).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('a sales writer cannot guess a customer outside the current follow-up scope', async () => {
    const db = storage(); db.setFollowed(false);
    expect(await create(db)).toMatchObject({ ok: false, error: { code: 'ORDER_NOT_FOUND' } });
    expect(db.tx.orderLine.create).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('scope revocation while waiting for the Order lock is rechecked before writing', async () => {
    const db = storage(); let locks = 0;
    db.tx.$queryRaw.mockImplementation(async () => { if (++locks === 2) db.setFollowed(false); return [{ id: 'O1' }]; });
    expect(await create(db)).toMatchObject({ ok: false, error: { code: 'ORDER_NOT_FOUND' } });
    expect(db.tx.orderLine.create).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['grant', 'account'] as const)('current %s revocation while waiting for the Order lock denies fulfillment authorization', async kind => {
    const db = storage();
    db.tx.$queryRaw.mockImplementation(async () => {
      const user = db.user();
      db.setUser(kind === 'account' ? { ...user, status: 'inactive' }
        : { ...user, roles: [{ ...user.roles[0], role: { ...user.roles[0].role, permissions: [] } }] });
      return [{ id: 'O1' }];
    });
    await expect(authorizeOrderLineWrite(db.tx, 'O1', prior, 'update'))
      .rejects.toMatchObject({ code: kind === 'account' ? 'ACCOUNT_DISABLED' : 'FORBIDDEN' });
    expect(db.tx.orderLine.update).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('a failed note audit rolls the saved note back in the storage adapter', async () => {
    const db = storage('Confirmed'); db.tx.auditLog.create.mockRejectedValue(Error('audit unavailable'));
    expect(await updateOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior, patch: { notes: '不可伪成功' } })).toMatchObject({ ok: false });
    expect(db.lines()[0].notes).toBe('原备注'); expect(db.audits()).toEqual([]);
  });
  it.each([{ quantity: 9 }, { unitPrice: 20 }, { sizeBreakdown: { S: 9 } }, { requiredSampleFamilies: [] }, { deliveryDate: '2026-12-01' }])('formal commercial patch %j must use original-order change approval', async patch => {
    const db = storage('Confirmed');
    expect(await updateOrderLine({ prisma: db.prisma, lineId: 'O1__0010', trustedActor: prior, patch })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(db.tx.orderLine.update).not.toHaveBeenCalled(); expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
