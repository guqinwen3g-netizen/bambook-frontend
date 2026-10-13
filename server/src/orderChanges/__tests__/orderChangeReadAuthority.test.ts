import { describe, expect, it, vi } from 'vitest';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { createOrderChangeRequestService } from '../orderChangeRequestService';
import { assertApprovalReviewSourceRead } from '../../approvals/approvalReviewSourceAccess';
import { registerNewDomainQueryTools } from '../../agent/newDomainQueryTools';
import { getToolHandler, type ToolExecutionContext } from '../../agent/toolDispatchRegistry';
import { createApprovalRouter } from '../../approvals/approvalRoute';
import { createOrderChangeRouter } from '../orderChangeRoute';
import type { Request, Response } from 'express';

// Storage-only substitute. Actual current account/grant/L2 helpers run; no
// authorization helper, clock, approval, or domain service is replaced.
function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]: any) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    const actual = row[key] ?? null;
    if (value === null || typeof value !== 'object') return actual === value;
    if ('in' in value) return value.in.includes(actual);
    if ('has' in value) return Array.isArray(actual) && actual.includes(value.has);
    if ('gt' in value) return actual > value.gt;
    if ('not' in value) return !matches({ value: actual }, { value: value.not });
    if ('startsWith' in value) return typeof actual === 'string' && actual.startsWith(value.startsWith);
    return matches(actual, value);
  });
}

async function readApprovalRoute(fixture: ReturnType<typeof store>, path: '/' | '/:id' | '/:id/detail', approvalId = 'A1') {
  const router = createApprovalRouter({ prisma: fixture.db, requireAuth: true });
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.stack.some(handler => handler.method === 'get'))?.route;
  if (!route) throw Error('APPROVAL_READ_ROUTE_NOT_FOUND');
  let status = 200, body: any;
  const signedActor: TokenPayload = { ...actor(), roles: ['manager'] };
  const req = { actor: signedActor, params: { id: approvalId }, query: {},
    headers: { authorization: `Bearer ${createAuthService().signToken(signedActor)}` } };
  const res = { status(code: number) { status = code; return res; }, json(value: unknown) { body = value; return res; } };
  await route.stack[0].handle(req as unknown as Request, res as unknown as Response, () => {});
  return { status, body };
}
function project(row: any, select?: any) {
  return select ? Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, row[key]])) : { ...row };
}
const actor = (ceiling?: string[]): TokenPayload => ({ userId: 'sales-1', roles: ['sales'], departmentIds: [],
  permissions: ['orders:read'], authorizationLoaded: true,
  ...(ceiling === undefined ? {} : { permissionCeiling: ceiling }) });

function store() {
  const state = { active: true, grants: ['orders:read'], reads: [] as string[], writes: [] as string[],
    hook: undefined as undefined | ((model: string, args: any) => void), rows: {
      order: [
        { id: 'O1', poNumber: 'OWN-PO', status: 'Confirmed', deletedAt: null, customerRelationId: 'R1', ownerId: 'sales-1' },
        { id: 'O2', poNumber: 'HIDDEN-PO', status: 'Confirmed', deletedAt: null, customerRelationId: 'R2', ownerId: 'sales-2' },
      ],
      relation: [
        { id: 'R1', deletedAt: null, ownerId: 'sales-1', salesRepIds: [] },
        { id: 'R2', deletedAt: null, ownerId: 'sales-2', salesRepIds: [] },
      ],
      orderLine: [{ id: 'L1', orderId: 'O1', lineNumber: 1 }, { id: 'L2', orderId: 'O2', lineNumber: 1 }],
      orderChangeRequest: [
        { id: 'C1', orderId: 'O1', requestNumber: 'OWN-CR', status: 'Pending', deletedAt: null,
          requesterId: 'sales-1', approvalRequestId: 'A1', beforeSnapshot: {}, afterDelta: {} },
        { id: 'C2', orderId: 'O2', requestNumber: 'HIDDEN-CR', status: 'Pending', deletedAt: null,
          requesterId: 'sales-2', approvalRequestId: 'A2', beforeSnapshot: {}, afterDelta: {} },
      ],
      approvalRequest: [
        { id: 'A1', targetType: 'OrderChangeRequest', targetId: 'O1', actionType: 'order:change',
          requesterId: 'sales-1', status: 'pending', payload: {} },
        { id: 'A2', targetType: 'OrderChangeRequest', targetId: 'O2', actionType: 'order:change',
          requesterId: 'sales-2', status: 'pending', payload: { private: 'hidden commercial basis' } },
      ],
      teamMember: [], teamDataGrant: [], userPermissionOverrides: [],
    } as Record<string, any[]>, db: {} as any };
  for (const name of Object.keys(state.rows)) {
    const read = async (args: any = {}) => {
      state.reads.push(name); state.hook?.(name, args);
      const rows = state.rows[name].filter(row => matches(row, args.where));
      const offset = args.skip ?? 0, end = args.take === undefined ? undefined : offset + args.take;
      return rows.slice(offset, end).map(row => project(row, args.select));
    };
    state.db[name] = { findMany: vi.fn(read), findFirst: vi.fn(async (args: any) => (await read(args))[0] ?? null),
      findUnique: vi.fn(async (args: any) => (await read(args))[0] ?? null) };
    for (const method of ['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']) {
      state.db[name][method] = vi.fn(() => { state.writes.push(`${name}.${method}`); throw Error('BUSINESS_WRITE_FORBIDDEN'); });
    }
  }
  const currentAccount = async ({ where }: any) => where.id === 'sales-1' ? {
    id: 'sales-1', displayName: 'Sales', status: state.active ? 'active' : 'disabled', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'role-sales', role: { id: 'role-sales', permissions: state.grants.map(scope => ({ permission: { scope } })) } }],
  } : null;
  state.db.userAccount = { findFirst: vi.fn(currentAccount), findUnique: vi.fn(currentAccount) };
  state.db.$transaction = vi.fn(async (run: (tx: any) => Promise<unknown>) => run(state.db));
  const forbiddenSql = vi.fn(() => { state.writes.push('SQL'); throw Error('SQL_FORBIDDEN'); });
  state.db.$queryRaw = forbiddenSql; state.db.$queryRawUnsafe = forbiddenSql; state.db.$executeRaw = forbiddenSql;
  const service = createOrderChangeRequestService({ prisma: state.db, approvalCreateService: {} as any });
  return Object.assign(state, { service });
}

describe('order change reads use current full parent authority', () => {
  it('requires a trusted actor before either service reads any business rows', async () => {
    const fixture = store();
    await expect(fixture.service.getChangeRequest('C1')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(fixture.service.listChangeRequests({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(fixture.reads).toEqual([]);
  });
  it('rejects a disabled current account despite an earlier valid signed identity', async () => {
    const fixture = store(); fixture.active = false;
    await expect(fixture.service.getChangeRequest('C1', actor())).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await expect(fixture.service.listChangeRequests({ trustedActor: actor() })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(fixture.reads).toEqual([]);
  });
  it.each([{ ceiling: [] }, { ceiling: ['order:change_request:create'] }])('enforces an explicit credential ceiling $ceiling for list and detail', async ({ ceiling }) => {
    const fixture = store();
    await expect(fixture.service.getChangeRequest('C1', actor(ceiling))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fixture.service.listChangeRequests({ trustedActor: actor(ceiling) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.db.orderChangeRequest.findUnique).not.toHaveBeenCalled();
    expect(fixture.db.orderChangeRequest.findMany).not.toHaveBeenCalled();
  });
  it('ordinary source business can read without a change execution or approval permission', async () => {
    const fixture = store();
    const detail = await fixture.service.getChangeRequest('C1', actor());
    expect(detail.item).toMatchObject({ id: 'C1', order: { id: 'O1' }, approvalRequest: { id: 'A1', actionType: 'order:change' } });
    expect(detail.item.approvalRequest.payload).toBeUndefined();
    await expect(assertApprovalReviewSourceRead(fixture.db, fixture.rows.approvalRequest[0], actor())).resolves.toBeUndefined();
    expect(fixture.writes).toEqual([]);
  });
  it('foreign-group detail is invisible even when the supplied token claims owner authority', async () => {
    const fixture = store();
    const supplied = { ...actor(), roles: ['owner'], permissions: ['*'], authorizationLoaded: true } as TokenPayload;
    const result = await fixture.service.getChangeRequest('C2', supplied);
    expect(result.item).toBeNull();
    expect(fixture.db.approvalRequest.findUnique).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });
  it('list limits count visible complete parents rather than an earlier hidden request', async () => {
    const fixture = store();
    fixture.rows.orderChangeRequest.reverse();
    const result = await fixture.service.listChangeRequests({ trustedActor: actor(), limit: 1 });
    expect(result.items.map(item => item.id)).toEqual(['C1']);
    expect(fixture.writes).toEqual([]);
  });
  it('an owned request cannot reveal a frozen approval containing another group source line', async () => {
    const fixture = store();
    fixture.rows.approvalRequest[0].payload = { orderChangeReviewBasis: { schemaVersion: 1,
      order: { id: 'O1' }, orderLines: [{ id: 'L1', orderId: 'O1' }, { id: 'L2', orderId: 'O2' }] } };
    const detail = await fixture.service.getChangeRequest('C1', actor());
    const list = await fixture.service.listChangeRequests({ trustedActor: actor() });
    expect(detail.item).toBeNull();
    expect(list.items).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });
  it('a line-only source proof resolves its actual hidden parent instead of trusting the selected order', async () => {
    const fixture = store(); fixture.rows.orderChangeRequest[0].afterDelta = { sourceProofs: [{ orderLineId: 'L2' }] };
    expect((await fixture.service.getChangeRequest('C1', actor())).item).toBeNull();
    expect((await fixture.service.listChangeRequests({ trustedActor: actor() })).items).toEqual([]);
  });
  it('frozen references retained in attachments are subject to the same full source gate', async () => {
    const fixture = store(); fixture.rows.orderChangeRequest[0].attachments = { sourceProofs: [{ orderId: 'O2' }] };
    expect((await fixture.service.getChangeRequest('C1', actor())).item).toBeNull();
  });
  it('revocation during source reads rejects the response instead of returning a previously authorized detail', async () => {
    const fixture = store();
    fixture.hook = model => { if (model === 'approvalRequest') fixture.grants = []; };
    await expect(fixture.service.getChangeRequest('C1', actor())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.writes).toEqual([]);
  });
  it('a parent moved out of the current scope during the final successor read cannot be returned', async () => {
    const fixture = store();
    fixture.hook = (model, args) => { if (model === 'orderChangeRequest' && args.where?.revisionOfId === 'C1')
      fixture.rows.order[0].customerRelationId = 'R2'; };
    await expect(fixture.service.getChangeRequest('C1', actor())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.writes).toEqual([]);
  });
  it('an unreadable successor cannot leak its request number through an owned original', async () => {
    const fixture = store(); fixture.rows.orderChangeRequest[1].revisionOfId = 'C1';
    const result = await fixture.service.getChangeRequest('C1', actor());
    expect(result.item?.id).toBe('C1');
    expect(result.item?.revisionSuccessor).toBeNull();
    expect(JSON.stringify(result)).not.toContain('HIDDEN-CR');
  });
  it('the shared approval reader rejects a frozen source outside the current parent range', async () => {
    const fixture = store();
    fixture.rows.approvalRequest[0].payload = { sourceProofs: [{ orderId: 'O2', orderLineId: 'L2' }] };
    await expect(assertApprovalReviewSourceRead(fixture.db, fixture.rows.approvalRequest[0], actor()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.writes).toEqual([]);
  });
  it('the shared approval reader cannot reuse an earlier argument after the frozen payload was replaced', async () => {
    const fixture = store();
    const earlier = { ...fixture.rows.approvalRequest[0], payload: { sourceProofs: [{ orderId: 'O2' }] } };
    await expect(assertApprovalReviewSourceRead(fixture.db, earlier, actor())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.writes).toEqual([]);
  });
  it.each(['order:cancel', 'order:pause'])('keeps legitimate %s history readable through the same parent gate', async actionType => {
    const fixture = store(); fixture.rows.approvalRequest[0].actionType = actionType;
    const result = await fixture.service.getChangeRequest('C1', actor());
    expect(result.item?.approvalRequest?.actionType).toBe(actionType);
  });
  it('Agent registry requires the same trusted context and ignores identity supplied in tool input', async () => {
    const fixture = store(); registerNewDomainQueryTools();
    const handler = getToolHandler('order_changes.query');
    if (!handler) throw Error('ORDER_CHANGES_QUERY_NOT_REGISTERED');
    await expect(handler(fixture.db, { id: 'C1', actorId: 'sales-1', roles: ['owner'] }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const context: ToolExecutionContext = { actor: { userId: 'sales-1', roles: ['sales'],
      permissionScopes: ['orders:read'], permissionsAuthoritative: true,
      departmentIds: [], toolScopes: [], memoryScopes: [], knowledgeScopes: [] } };
    expect(await handler(fixture.db, { id: 'C1' }, undefined, context)).toMatchObject({ ok: true, item: { id: 'C1' } });
    expect(await handler(fixture.db, { id: 'C2' }, undefined, context)).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(await handler(fixture.db, { limit: 1 }, undefined, context)).toMatchObject({ ok: true, items: [{ id: 'C1' }] });
    context.actor!.permissionCeiling = [];
    await expect(handler(fixture.db, { id: 'C1' }, undefined, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.writes).toEqual([]);
  });
  it('storage faults propagate instead of claiming a legitimate empty list', async () => {
    const fixture = store(); fixture.db.order.findFirst.mockRejectedValueOnce(Error('ORDER_STORE_UNAVAILABLE'));
    await expect(fixture.service.listChangeRequests({ trustedActor: actor() })).rejects.toThrow('ORDER_STORE_UNAVAILABLE');
  });
  it.each(['/:id', '/:id/detail'] as const)('approval HTTP handler %s refuses frozen content when any CR source is hidden', async path => {
    const fixture = store(); fixture.rows.approvalRequest[0].payload = { sourceProofs: [{ orderId: 'O2' }],
      beforeSnapshot: { commercialNote: 'HIDDEN-FROZEN-COMMERCIAL-BASIS' } };
    const result = await readApprovalRoute(fixture, path);
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toContain('HIDDEN-FROZEN-COMMERCIAL-BASIS');
  });
  it('approval HTTP list filters an assigned CR whose complete frozen source is hidden', async () => {
    const fixture = store(); fixture.rows.approvalRequest[0].reviewerId = 'sales-1';
    fixture.rows.approvalRequest[0].payload = { sourceProofs: [{ orderId: 'O2' }] };
    const result = await readApprovalRoute(fixture, '/');
    expect(result.status).toBe(200); expect(result.body.items).toEqual([]);
  });
  it.each(['order:cancel', 'order:pause'])('%s cannot bypass full source authorization in any approval read entry', async actionType => {
    const fixture = store(); fixture.rows.approvalRequest[0].actionType = actionType;
    fixture.rows.approvalRequest[0].reviewerId = 'sales-1';
    fixture.rows.approvalRequest[0].payload = { sourceProofs: [{ orderId: 'O2' }], beforeSnapshot: { note: 'HIDDEN-LIFECYCLE-BASIS' } };
    for (const path of ['/:id', '/:id/detail'] as const) {
      const result = await readApprovalRoute(fixture, path);
      expect(result.status).toBe(403); expect(JSON.stringify(result.body)).not.toContain('HIDDEN-LIFECYCLE-BASIS');
    }
    expect((await readApprovalRoute(fixture, '/')).body.items).toEqual([]);
  });
  it('the HTTP detail cannot return its earlier payload when the optional confirmation lookup observes account disablement', async () => {
    const fixture = store(); fixture.rows.orderChangeRequest[0].changeTypes = ['unitPrice'];
    fixture.db.$transaction.mockImplementation(async (run: (tx: any) => Promise<unknown>) => { fixture.active = false; return run(fixture.db); });
    const router = createOrderChangeRouter({ prisma: fixture.db, requireAuth: true });
    const route = router.stack.find(layer => layer.route?.path === '/:id' && layer.route.stack.some(handler => handler.method === 'get'))?.route;
    if (!route) throw Error('ORDER_CHANGE_DETAIL_ROUTE_NOT_FOUND');
    let status = 200, body: any;
    const req = { actor: actor(), params: { id: 'C1' }, headers: { authorization: `Bearer ${createAuthService().signToken(actor())}` } };
    const res = { status(code: number) { status = code; return res; }, json(value: unknown) { body = value; return res; } };
    await route.stack[0].handle(req as unknown as Request, res as unknown as Response, () => {});
    expect(status).toBe(401); expect(body.item).toBeUndefined();
  });
  it.each([0, -1, 1.5, Number.NaN])('rejects invalid list limit %s without reading change requests', async limit => {
    const fixture = store();
    await expect(fixture.service.listChangeRequests({ trustedActor: actor(), limit })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.db.orderChangeRequest.findMany).not.toHaveBeenCalled();
  });
});
