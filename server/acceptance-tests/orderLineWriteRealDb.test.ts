/**
 * Opt-in OrderLine transaction/write acceptance, never a shared database.
 * Independent rules: docs/design/01-产品总览/6. 角色与权限矩阵.md
 * (Orders write/delete, current grants, credential cap); existing leadership
 * restriction is retained, not interpreted as company approval authority.
 * docs/design/03-业务规则/小组与业务数据共享.md §5.1/5.3:
 * customer follow-up/share is the Orders L2 anchor; order owner cannot replace
 * an unrelated existing customer. Mandatory audit + source fact must commit
 * together; a stale version command cannot overwrite a newer committed fact.
 *
 * Real JWT/middleware, permission loaders, service, PG row locks/Serializable,
 * CAS, FK failures and rollback. Proxies only coordinate real DB changes or
 * inject a real SQL/FK failure; no authorization/row query is stubbed. Legacy
 * canonical role IDs are real identities supported by the loader, with no
 * assumed default grants. Approved Agent rows are synthetic committed facts,
 * NOT proof of company approval policy, or the full HTTP/runtime/resume chain.
 * No index, seed, scheduler, model, MCP or external action is started. Does not
 * prove all direct OrderLine writers, GET L2, source-product visibility, or
 * downstream manufacturing/event-consumer completion.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createOrderLine, updateOrderLine, deleteOrderLine } from '../src/orders/orderLineMutationService';
import { executeTool } from '../src/agent/toolRuntime';
import { buildOrderLineUpdateDraft } from '../src/agent/orderLineUpdateFlow';
import type { ActorContext } from '../src/agent/types';

const prefix = `acceptance-order-line-${randomUUID()}`;
const auth = createAuthService(), reviewerId = `${prefix}-reviewer`;
let prisma: PrismaClient | undefined, counter = 0;
function db() { if (!prisma) throw Error('Independent OrderLine client not initialized'); return prisma; }

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox is required');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'independent PG identity before ANY fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: reviewerId, displayName: 'Synthetic committed-fact reviewer', status: 'active' } });
  // Use supported canonical legacy IDs, never infer authority from a role name.
  // No shared role is edited/deleted and no implicit role permission is assumed.
  for (const roleId of ['manager', 'sales', 'owner']) {
    await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: `Synthetic canonical ${roleId}`, isSystem: true } });
    expect(await db().rolePermission.count({ where: { roleId } }), 'isolated fixture must not inherit undeclared role grants').toBe(0);
  }
});
afterAll(async () => { await prisma?.$disconnect(); });

type Action = 'create' | 'update' | 'delete' | 'version';
const actions: Action[] = ['create', 'update', 'delete', 'version'];
const exactScope = (action: Action) => action === 'delete' ? 'orders:delete' : 'orders:write';
async function fixture(label: string, options: { role?: string; shared?: boolean; unrelated?: boolean } = {}) {
  const id = `${prefix}-${++counter}-${label}`, userId = `${id}-user`, relationId = `${id}-customer`, orderId = `${id}-order`,
    lineId = `${id}-line`, assetId = `${id}-asset`, teamId = `${id}-team`, shareId = `${id}-share`;
  const roleId = options.role ?? 'manager';
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic current OrderLine actor', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId } });
    await tx.userPermissionOverrides.createMany({ data: ['orders:read', 'orders:write', 'orders:delete'].map(scope => ({
      id: `${id}-grant-${scope}`, userId, scope, grantedBy: reviewerId, isActive: true,
      reason: 'Synthetic current grants; not company grant-policy proof',
    })) });
    await tx.relation.create({ data: { id: relationId, name: `${id}-customer`, category: 'Customer', type: 'Company',
      isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()),
      ownerId: options.shared || options.unrelated ? reviewerId : userId, salesRepIds: [] } });
    await tx.order.create({ data: { id: orderId, poNumber: `${id}-po`, customer: `${id}-customer`, product: 'Synthetic fabric',
      type: 'fabric', quantity: 10, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 10,
      customerRelationId: relationId, ownerId: userId, importedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
    await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', quantity: '2.7500',
      description: 'Synthetic original line', unit: 'M', fieldSources: { quantity: 'manual' } } });
    await tx.productAsset.create({ data: { id: assetId, sku: `${id}-sku`, name: 'Synthetic direct-reorder source',
      mainCategory: 'fabric', subCategoryId: 'synthetic-metadata-only', season: 'synthetic', status: 'active',
      cost: '3.25', updatedAt: BigInt(Date.now()) } });
    if (options.shared) {
      await tx.team.create({ data: { id: teamId, name: 'Synthetic active L2 team', status: 'active' } });
      await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId } });
      await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: relationId,
        permission: 'read+followup', grantedBy: reviewerId } });
    }
  });
  const user = await loadUserWithRoles(db(), userId); expect(user?.status).toBe('active');
  const actor = await buildLoadedAuthTokenPayload(db(), user);
  expect(actor.roles).toContain(roleId); expect(actor.authorizationLoaded).toBe(true);
  expect(actor.permissions).toEqual(['orders:delete', 'orders:read', 'orders:write']);
  return { id, userId, relationId, orderId, lineId, assetId, teamId, shareId, actor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Change = { entity: string; action: string; ids?: string[] };
function application(client: PrismaClient, requireAuth = true) {
  const app = express(), changes: Change[] = [];
  app.use(express.json()); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use('/order-lines', createOrderLinesRouter({ prisma: client, requireAuth, apiKeys: new Set(['synthetic-key']), onDataChange: event => changes.push(event) }));
  return { app, changes };
}
function send(app: ReturnType<typeof application>, item: Fixture, action: Action, actor: TokenPayload = item.actor) {
  const bearer = auth.signToken(actor), base = `/order-lines/${item.lineId}`;
  if (action === 'create') return request(app.app).post('/order-lines').set('Authorization', `Bearer ${bearer}`)
    .send({ poNumber: `${item.id}-po`, quantity: 3, materialCode: item.assetId, description: 'Synthetic new line', unit: 'M' });
  if (action === 'update') return request(app.app).put(base).set('Authorization', `Bearer ${bearer}`)
    .send({ quantity: 4, materialCode: item.assetId });
  if (action === 'delete') return request(app.app).delete(base).set('Authorization', `Bearer ${bearer}`);
  return request(app.app).patch(`${base}/version`).set('Authorization', `Bearer ${bearer}`)
    .send({ confirmedSourceType: 'Asset', confirmedSourceId: item.assetId });
}
async function snapshot(item: Fixture) {
  const lines = await db().orderLine.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } });
  const ids = [...new Set([item.lineId, `${item.orderId}__0020`, ...lines.map(line => line.id)])];
  return { order: await db().order.findUniqueOrThrow({ where: { id: item.orderId } }), lines,
    source: await db().productAsset.findUniqueOrThrow({ where: { id: item.assetId } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'OrderLine', targetId: { in: ids } }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { ownerType: 'orderLine', ownerId: { in: ids } }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { fromType: 'orderLine', fromId: { in: ids } }, orderBy: { id: 'asc' } }),
  };
}
async function unchanged(item: Fixture, before: Awaited<ReturnType<typeof snapshot>>, app: ReturnType<typeof application>) {
  expect(await snapshot(item), 'no business row, source fact, reference or success audit may change').toEqual(before);
  expect(app.changes, 'notification only after business commit').toEqual([]);
}
const responseCode = (response: any) => response.body.error?.code ?? response.body.error;
const serviceCode = (result: any) => result.ok ? 'OK' : result.error?.code;
type Probe = { beforeTransaction?: () => Promise<void>; afterPreflightLine?: () => Promise<void>; preflightBarrier?: () => Promise<void>;
  auditSqlFault?: boolean; auditReached?: boolean; grantSqlFault?: boolean; scopeSqlFault?: boolean; sqlFaultReached?: boolean };
/** Delegate queries still go to PG. Faults are SQL inside the actual business
 * transaction; barriers never return a made-up row/count or throw a fake code. */
function intercepted(probe: Probe): PrismaClient {
  let prepared = false, observed = false;
  const client = db();
  return new Proxy(client, { get(target, key) {
    if (key === 'orderLine' && (probe.afterPreflightLine || probe.preflightBarrier)) return new Proxy(target.orderLine, { get(model, method) {
      if (method === 'findFirst') return async (...args: any[]) => {
        const row = await (model.findFirst as any)(...args);
        if (!observed && row) { observed = true; await probe.afterPreflightLine?.(); await probe.preflightBarrier?.(); }
        return row;
      };
      const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
    } });
    if (key === '$transaction') return async (work: any, options?: any) => {
      if (typeof work !== 'function') return (target.$transaction as any)(work, options);
      if (!prepared) { prepared = true; await probe.beforeTransaction?.(); }
      return target.$transaction(async tx => work(new Proxy(tx, { get(transaction, delegate) {
        if (delegate === 'auditLog' && probe.auditSqlFault) return new Proxy(transaction.auditLog, { get(model, method) {
          if (method === 'create') return async (args: any) => {
            if (args.data.targetType !== 'OrderLine') return model.create(args);
            probe.auditReached = true;
            return model.create({ ...args, data: { ...args.data, actorId: `${prefix}-nonexistent-audit-actor` } });
          };
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        if ((delegate === 'userPermissionOverrides' && probe.grantSqlFault) || (delegate === 'teamMember' && probe.scopeSqlFault)) {
          const model = Reflect.get(transaction, delegate);
          return new Proxy(model, { get(realModel, method) {
            if (method === 'findMany') return async () => {
              probe.sqlFaultReached = true;
              return transaction.$queryRaw`SELECT "missing_authorization_probe_column" FROM "UserAccount" LIMIT 1`;
            };
            const value = Reflect.get(realModel, method); return typeof value === 'function' ? value.bind(realModel) : value;
          } });
        }
        const value = Reflect.get(transaction, delegate); return typeof value === 'function' ? value.bind(transaction) : value;
      } })), { ...options, timeout: 20_000 });
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function barrier() {
  let arrived = 0, release!: () => void, reject!: (error: Error) => void, timer: ReturnType<typeof setTimeout> | undefined;
  const both = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  return async () => { arrived += 1;
    if (arrived === 1) timer = setTimeout(() => reject(Error('Two actual PG commands must reach the coordinated boundary')), 10_000);
    if (arrived === 2) { clearTimeout(timer); release(); } await both;
  };
}

describe.each(actions)('actual PG OrderLine %s current transaction authority', action => {
  it('current leadership + actual grants + customer scope commits with actual actor audit', async () => {
    const item = await fixture(`${action}-positive`), app = application(db()), before = await snapshot(item);
    // Demonstrates current DB roles/grants, not restoration from signed defaults.
    const response = await send(app, item, action, { ...item.actor, roles: [], permissions: [], authorizationLoaded: undefined });
    expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body.ok).toBe(true);
    const after = await snapshot(item); expect(after.order).toEqual(before.order); expect(after.source).toEqual(before.source);
    expect(after.audits).toHaveLength(1); expect(after.audits[0].actorId).toBe(item.userId); expect(app.changes).toHaveLength(1);
    if (action === 'create') { expect(after.lines).toHaveLength(2); expect(after.lines.find(line => line.itemNo === '0020')?.quantity.toString()).toBe('3');
      expect(after.references).toHaveLength(1); expect(after.links).toHaveLength(1); }
    if (action === 'update') { expect(after.lines[0].quantity.toString()).toBe('4'); expect(after.references).toHaveLength(1); expect(after.links).toHaveLength(1); }
    if (action === 'delete') expect(after.lines).toEqual([]);
    if (action === 'version') expect(after.lines[0]).toMatchObject({ confirmedSourceType: 'Asset', confirmedSourceId: item.assetId, confirmedBy: item.userId });
  });
  it('revoked actual action cannot be restored by the stale signed scope', async () => {
    const item = await fixture(`${action}-revoked`), app = application(db()), before = await snapshot(item);
    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: exactScope(action) } }, data: { isActive: false } });
    const response = await send(app, item, action); expect(response.status).toBe(403); expect(responseCode(response)).toBe('FORBIDDEN');
    await unchanged(item, before, app);
  });
  it('current sales grants cannot replace the original leadership role gate', async () => {
    const item = await fixture(`${action}-role`, { role: 'sales' }), app = application(db()), before = await snapshot(item);
    const response = await send(app, item, action, { ...item.actor, roles: ['owner'] }); expect(response.status).toBe(403);
    await unchanged(item, before, app);
  });
  it('current owner technical privilege cannot exceed a signed read-only cap', async () => {
    const item = await fixture(`${action}-cap`, { role: 'owner' }), app = application(db()), before = await snapshot(item);
    const response = await send(app, item, action, { ...item.actor, permissionCeiling: ['orders:read'] }); expect(response.status).toBe(403);
    await unchanged(item, before, app);
  });
  it('order owner cannot replace the unrelated real customer L2 anchor', async () => {
    const item = await fixture(`${action}-l2`, { unrelated: true }), app = application(db()), before = await snapshot(item);
    const response = await send(app, item, action); expect(response.status).toBe(404); await unchanged(item, before, app);
  });
  it('actual grant revoked after HTTP preflight is rechecked before the business write', async () => {
    const item = await fixture(`${action}-tx-revoke`), before = await snapshot(item);
    const probe: Probe = { beforeTransaction: async () => { await db().userPermissionOverrides.update({
      where: { userId_scope: { userId: item.userId, scope: exactScope(action) } }, data: { isActive: false } }); } };
    const app = application(intercepted(probe)), response = await send(app, item, action);
    expect(response.status, JSON.stringify(response.body)).toBe(403); expect(responseCode(response)).toBe('FORBIDDEN'); await unchanged(item, before, app);
  });
  it('actual shared customer revoked after preflight is not available in the business transaction', async () => {
    const item = await fixture(`${action}-tx-share`, { shared: true }), before = await snapshot(item);
    const probe: Probe = { beforeTransaction: async () => { await db().teamDataGrant.update({ where: { id: item.shareId }, data: { revokedAt: new Date(), revokedBy: reviewerId } }); } };
    const app = application(intercepted(probe)), response = await send(app, item, action);
    expect(response.status, JSON.stringify(response.body)).toBe(404); await unchanged(item, before, app);
  });
  it('real SQL current-grant read failure is 503 with no write/default-grant fallback', async () => {
    const item = await fixture(`${action}-tx-grant-fault`), before = await snapshot(item), probe: Probe = { grantSqlFault: true };
    const app = application(intercepted(probe)), response = await send(app, item, action);
    expect(probe.sqlFaultReached).toBe(true); expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(responseCode(response)).toBe('AUTHORIZATION_UNAVAILABLE'); await unchanged(item, before, app);
  });
  it('real mandatory audit FK failure rolls back rows/references/source selection and emits no change', async () => {
    const item = await fixture(`${action}-audit`), before = await snapshot(item), probe: Probe = { auditSqlFault: true };
    const app = application(intercepted(probe)), response = await send(app, item, action);
    expect(probe.auditReached, JSON.stringify(response.body)).toBe(true); expect(response.status).toBe(500);
    expect(response.body.ok).toBe(false); await unchanged(item, before, app);
  });
});

describe('actual PG OrderLine source version / service authority boundaries', () => {
  it('fresh L2 SQL failure swallowed by compatibility resolver is still 503/no write', async () => {
    const item = await fixture('strict-l2-fault', { shared: true }), before = await snapshot(item), probe: Probe = { scopeSqlFault: true };
    const app = application(intercepted(probe)), response = await send(app, item, 'update');
    expect(probe.sqlFaultReached).toBe(true); expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(responseCode(response)).toBe('AUTHORIZATION_UNAVAILABLE'); await unchanged(item, before, app);
  });
  it.each(['create', 'update', 'delete'] as const)('%s actorId alone cannot authorize direct service execution', async action => {
    const item = await fixture(`${action}-identity`), before = await snapshot(item), app = application(db());
    const result = action === 'create' ? await createOrderLine({ prisma: db(), orderId: item.orderId, quantity: 3, actorId: item.userId })
      : action === 'update' ? await updateOrderLine({ prisma: db(), lineId: item.lineId, patch: { quantity: 4 }, actorId: item.userId })
        : await deleteOrderLine({ prisma: db(), lineId: item.lineId, actorId: item.userId });
    expect(serviceCode(result)).toBe('UNAUTHORIZED'); await unchanged(item, before, app);
  });
  it.each(['id', 'orderId'] as const)('create extra.%s cannot replace protected identity/parent under a valid parent grant', async field => {
    const item = await fixture(`create-protected-${field}`), other = await fixture(`create-protected-${field}-other`, { unrelated: true });
    const before = await snapshot(item), otherBefore = await snapshot(other), app = application(db());
    const result = await createOrderLine({ prisma: db(), trustedActor: item.actor, orderId: item.orderId, quantity: 3,
      extra: { [field]: field === 'id' ? other.lineId : other.orderId } });
    expect(serviceCode(result)).toBe('INVALID_INPUT'); await unchanged(item, before, app); expect(await snapshot(other)).toEqual(otherBefore);
  });
  it.each(['id', 'orderId'] as const)('update patch.%s cannot rebind an existing line under a valid parent grant', async field => {
    const item = await fixture(`update-protected-${field}`), other = await fixture(`update-protected-${field}-other`, { unrelated: true });
    const before = await snapshot(item), otherBefore = await snapshot(other), app = application(db());
    const result = await updateOrderLine({ prisma: db(), trustedActor: item.actor, lineId: item.lineId, patch: { [field]: field === 'id' ? other.lineId : other.orderId } });
    expect(serviceCode(result)).toBe('INVALID_INPUT'); await unchanged(item, before, app); expect(await snapshot(other)).toEqual(otherBefore);
  });
  it('a committed later source fact cannot be overwritten by the older preflight command', async () => {
    const item = await fixture('version-cas'), winnerSource = `${item.id}-winner-source`;
    await db().productAsset.create({ data: { id: winnerSource, sku: `${winnerSource}-sku`, name: 'Independent actual competing source',
      mainCategory: 'fabric', subCategoryId: 'synthetic-metadata-only', season: 'synthetic', status: 'active', cost: '2.5', updatedAt: BigInt(Date.now()) } });
    let winner!: Awaited<ReturnType<typeof snapshot>>;
    const probe: Probe = { afterPreflightLine: async () => {
      const winnerApp = application(db()), response = await send(winnerApp, { ...item, assetId: winnerSource }, 'version');
      expect(response.status, JSON.stringify(response.body)).toBe(200); expect(winnerApp.changes).toHaveLength(1);
      winner = await snapshot(item);
      expect(winner.audits).toHaveLength(1);
    } };
    const app = application(intercepted(probe)), response = await send(app, item, 'version');
    expect(response.status, JSON.stringify(response.body)).toBe(409); expect(responseCode(response)).toBe('CONFLICT');
    await unchanged(item, winner, app); expect(winner.lines[0].confirmedSourceId).toBe(winnerSource);
  });
  it('two source commands reading one prior version commit at most one source and one success audit', async () => {
    const item = await fixture('version-concurrent'), synchronized = barrier();
    const a = application(intercepted({ preflightBarrier: synchronized })), b = application(intercepted({ preflightBarrier: synchronized }));
    const result = await Promise.all([send(a, item, 'version'), send(b, item, 'version')]);
    expect(result.map(response => response.status).sort((x, y) => x - y), JSON.stringify(result.map(response => response.body))).toEqual([200, 409]);
    const after = await snapshot(item); expect(after.lines[0]).toMatchObject({ confirmedSourceId: item.assetId, confirmedBy: item.userId });
    expect(after.audits).toHaveLength(1); expect(a.changes.length + b.changes.length).toBe(1);
  });
  it('concurrent auto-numbered line creations do not commit duplicate identity/item numbers or unaudited rows', async () => {
    const item = await fixture('create-concurrent'), synchronized = barrier();
    const a = application(intercepted({ beforeTransaction: synchronized })), b = application(intercepted({ beforeTransaction: synchronized }));
    const result = await Promise.all([send(a, item, 'create'), send(b, item, 'create')]);
    const statuses = result.map(response => response.status); expect(statuses.every(status => status === 200 || status === 409), JSON.stringify(result.map(response => response.body))).toBe(true);
    const committed = statuses.filter(status => status === 200).length; expect(committed).toBeGreaterThan(0);
    const after = await snapshot(item); expect(after.lines).toHaveLength(1 + committed); expect(after.audits).toHaveLength(committed);
    expect(new Set(after.lines.map(line => line.itemNo)).size).toBe(after.lines.length);
    expect(new Set(after.lines.map(line => line.lineNumber)).size).toBe(after.lines.length); expect(a.changes.length + b.changes.length).toBe(committed);
    // No idempotency or automatic retry guarantee is asserted for line creation.
  });
});

async function approvedAgent(item: Fixture) {
  const approvalId = `${item.id}-agent-approval`, draft = buildOrderLineUpdateDraft({ lineId: item.lineId, patch: { quantity: 9 }, currentSnapshot: { quantity: 2.75 } });
  const payload = { processDraft: draft, toolId: 'order.line_update' };
  await db().approvalRequest.create({ data: { id: approvalId, requesterId: item.userId, reviewerId, status: 'approved',
    actionType: 'tool:order.line_update', targetType: 'OrderLine', targetId: item.lineId, risk: 'high',
    payload: JSON.parse(JSON.stringify(payload)), decidedAt: new Date() } });
  return { approvalId, draft, payload };
}
function context(item: Fixture, patch: Partial<ActorContext> = {}): ActorContext {
  return { userId: item.userId, roles: item.actor.roles, departmentIds: item.actor.departmentIds,
    permissionScopes: item.actor.permissions, permissionsAuthoritative: true,
    memoryScopes: [], knowledgeScopes: [], toolScopes: [], ...patch };
}
function agentCall(approvalId: string, input: Record<string, unknown> = {}) {
  // Runtime's registered dispatcher consumes approvalId; reason is the existing
  // planned-call contract. Do not change shared Agent types just for a probe.
  return { toolId: 'order.line_update', input, approvalId, reason: 'Synthetic approved original OrderLine draft' };
}
describe('actual PG Agent registered order.line_update commit boundary', () => {
  it('approved requester/reviewer or actorId cannot replace the missing trusted execution actor', async () => {
    const item = await fixture('agent-no-context'), approval = await approvedAgent(item), before = await snapshot(item), app = application(db());
    const result = await executeTool(db(), agentCall(approval.approvalId, { actor: item.actor }), { actorId: item.userId });
    expect(result.ok).toBe(false); expect((result as any).errorFeedback?.code).toBe('UNAUTHORIZED'); await unchanged(item, before, app);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: approval.approvalId } })).toMatchObject({ status: 'approved', requesterId: item.userId, reviewerId });
    expect(await db().agentCommitReceipt.count({ where: { approvalId: approval.approvalId } })).toBe(0);
  });
  it('current grant revocation rejects an approved Agent command with a stale trusted snapshot', async () => {
    const item = await fixture('agent-revoked'), approval = await approvedAgent(item), before = await snapshot(item), app = application(db());
    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: 'orders:write' } }, data: { isActive: false } });
    const result = await executeTool(db(), agentCall(approval.approvalId), { actorId: item.userId, actor: context(item) });
    expect(result.ok).toBe(false); expect((result as any).errorFeedback?.code).toBe('FORBIDDEN'); await unchanged(item, before, app);
    expect(await db().agentCommitReceipt.count({ where: { approvalId: approval.approvalId } })).toBe(0);
  });
  it('Agent execution retains its read-only signed cap despite current owner privilege', async () => {
    const item = await fixture('agent-cap', { role: 'owner' }), approval = await approvedAgent(item), before = await snapshot(item), app = application(db());
    const result = await executeTool(db(), agentCall(approval.approvalId), {
      actorId: item.userId, actor: context(item, { permissionCeiling: ['orders:read'] }) });
    expect(result.ok).toBe(false); expect((result as any).errorFeedback?.code).toBe('FORBIDDEN'); await unchanged(item, before, app);
  });
  it('current legitimate trusted actor executes the approved original hash, audits the actor and caches the receipt', async () => {
    const item = await fixture('agent-positive'), approval = await approvedAgent(item), before = await snapshot(item);
    const call = agentCall(approval.approvalId), trusted = { actorId: item.userId, actor: context(item) };
    const result = await executeTool(db(), call, trusted); expect(result.ok, JSON.stringify(result)).toBe(true);
    const after = await snapshot(item); expect(after.lines[0].quantity.toString()).toBe('9'); expect(after.audits).toHaveLength(1);
    expect(after.audits[0].actorId).toBe(item.userId); expect(after.order).toEqual(before.order);
    const replay = await executeTool(db(), call, trusted); expect(replay.ok).toBe(true); expect((replay as any).replayed).toBe(true);
    expect(await snapshot(item)).toEqual(after); expect(await db().agentCommitReceipt.count({ where: { approvalId: approval.approvalId, status: 'committed' } })).toBe(1);
  });
});
