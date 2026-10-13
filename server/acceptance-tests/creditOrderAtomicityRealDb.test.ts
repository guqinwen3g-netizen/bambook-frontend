/**
 * Opt-in credit/Order atomicity acceptance. Never connect to a shared database.
 * Independent rules: 信用控制规则.md §13 (exact object/action exception, original
 * credit state unchanged); 审批与human-in-the-loop.md §15.3 B2/B5 + §15.4
 * (consumption/audit in the business transaction, deadline/quota remain gates).
 *
 * Actual PG + service + current personal-grant-loaded identity + row locks,
 * CAS, FK constraints, rollback, projections and durable events. Proxies only
 * coordinate competing requests or inject a REAL SQL audit FK violation.
 * Approved rows are synthetic committed facts, not proof of lawful company
 * approval policy. No index/scheduler/model/MCP/network action is started.
 * This is not HTTP/global fresh-auth, DR041 Churned recovery, MOQ policy/UAT,
 * numbering rollback, or downstream event-consumer completion evidence.
 * Existing numbering and optional MOQ fallback audits precede the business tx.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { transitionOrderStatus } from '../src/orders/orderLifecycleService';
import { createOrderServiceV2 } from '../src/orders/orderServiceV2';
import { businessEventBus, type BusinessEvent } from '../src/events/businessEventBus';
import { commitOrderConfirm } from '../src/agent/commitTransaction';
import { buildOrderConfirmProcessDraft } from '../src/agent/toolRegistry';
import { createQuotationService } from '../src/quotations/quotationService';

const prefix = `acceptance-credit-order-${randomUUID()}`;
const consumerId = `${prefix}-consumer`, reviewerId = `${prefix}-committed-reviewer`;
let prisma: PrismaClient | undefined, actor: TokenPayload;
let sequence = 0;
const observed: BusinessEvent[] = [], ownOrderIds = new Set<string>();
let unsubscribe: (() => void) | undefined;
function db() { if (!prisma) throw Error('Independent credit/Order client not initialized'); return prisma; }

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
  await db().userAccount.createMany({ data: [{ id: consumerId, displayName: 'Synthetic credit action actor', status: 'active' },
    { id: reviewerId, displayName: 'Synthetic committed-fact reviewer', status: 'active' }] });
  // Synthetic current personal grants, loaded by the real production builder.
  // No forged owner/admin role or assumed default role matrix is used.
  await db().userPermissionOverrides.createMany({ data: ['orders:read', 'orders:write', 'relations:read'].map(scope => ({
    id: `${prefix}-grant-${scope}`, userId: consumerId, scope, grantedBy: reviewerId,
    reason: 'Synthetic isolated actor grant; not company grant-policy proof', isActive: true,
  })) });
  const user = await loadUserWithRoles(db(), consumerId); expect(user?.status).toBe('active');
  actor = await buildLoadedAuthTokenPayload(db(), user);
  expect(actor).toMatchObject({ userId: consumerId, roles: [], authorizationLoaded: true });
  expect(actor.permissions).toEqual(['orders:read', 'orders:write', 'relations:read']);
  unsubscribe = businessEventBus.subscribe('*', event => { if (ownOrderIds.has(event.sourceEntityId)) observed.push(event); });
});
afterAll(async () => { unsubscribe?.(); await prisma?.$disconnect(); });

async function fixture(label: string, kind: 'create' | 'confirm', frozen = true) {
  const id = `${prefix}-${++sequence}-${label}`, relationId = `${id}-relation`, orderId = `${id}-order`,
    exceptionId = `${id}-exception`, approvalId = `${id}-approval`, creditId = `${id}-credit`;
  const scope = { targetType: kind === 'create' ? 'Relation' : 'Order', targetId: kind === 'create' ? relationId : orderId,
    action: kind === 'create' ? 'order:create' : 'order:confirm', responsibleOwnerId: consumerId,
    validUntil: new Date(Date.now() + 120_000).toISOString(), maxUses: 1, usedCount: 0, consumptions: [] };
  await db().$transaction(async tx => {
    await tx.relation.create({ data: { id: relationId, name: id, category: 'Customer', type: 'Company', isOrganization: true,
      tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: consumerId, salesRepIds: [] } });
    await tx.creditLimit.create({ data: { id: creditId, relationId, totalLimit: 1_000_000, usedAmount: 0, currency: 'USD',
      validFrom: '2020-01-01', status: frozen ? 'Frozen' : 'Active', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
    if (kind === 'confirm') await tx.order.create({ data: { id: orderId, code: `${id}-code`, customer: id, product: 'Synthetic fabric',
      type: 'Fabric', businessLine: 'fabric', quantity: 10_000, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 1000,
      currency: 'USD', customerRelationId: relationId, ownerId: consumerId, paymentInstrument: 'T/T',
      // Existing snapshot format; chosen adequate quantities isolate credit.
      // These numbers do not certify a company MOQ policy or exemption.
      moqSnapshot: { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20,
        snapshotAt: new Date().toISOString(), configId: null, source: 'fallback_constant' }, updatedAt: BigInt(Date.now()) } });
    await tx.approvalRequest.create({ data: { id: approvalId, requesterId: consumerId, reviewerId, status: 'approved',
      actionType: 'order:dr013-exception', targetType: 'Dr013ExceptionRequest', targetId: exceptionId,
      risk: 'high', payload: { syntheticCommittedFactFixture: true }, decidedAt: new Date() } });
    await tx.dr013ExceptionRequest.create({ data: { id: exceptionId, exceptionNumber: exceptionId, exceptionCategory: 'credit_exemption',
      bypassedApprovalIds: [], exceptionReason: 'Synthetic committed credit fact for isolated transaction verification only.',
      riskMitigationPlan: 'No company approval or recovery policy is asserted', requesterId: consumerId, reviewerId,
      approvalRequestId: approvalId, status: 'ReviewerApproved', attachments: { files: ['synthetic-credit-evidence'], scope } } });
  });
  if (kind === 'confirm') ownOrderIds.add(orderId);
  return { id, kind, relationId, orderId, exceptionId, approvalId, creditId,
    input: { customer: id, product: 'Synthetic fabric', type: 'Fabric', businessLine: 'fabric', quantity: 10_000,
      dueDate: '2099-01-01', quoteAmount: 1000, customerRelationId: relationId, currency: 'USD', paymentInstrument: 'T/T' } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const code = (result: any) => result.ok ? 'OK' : result.error?.code;
async function snapshot(item: Fixture) {
  const orders = await db().order.findMany({ where: { customerRelationId: item.relationId }, orderBy: { id: 'asc' } });
  const ids = [item.orderId, ...orders.map(order => order.id)];
  return { orders, exception: await db().dr013ExceptionRequest.findUniqueOrThrow({ where: { id: item.exceptionId } }),
    approval: await db().approvalRequest.findUniqueOrThrow({ where: { id: item.approvalId } }),
    credit: await db().creditLimit.findUniqueOrThrow({ where: { id: item.creditId } }),
    transitions: await db().orderStatusTransition.findMany({ where: { orderId: { in: ids } }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { fromType: 'order', fromId: { in: ids } }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { ownerType: 'order', ownerId: { in: ids } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { OR: [{ targetType: { in: ['Order', 'orders'] }, targetId: { in: ids } },
      { targetType: 'Dr013ExceptionRequest', targetId: item.exceptionId }] }, orderBy: { id: 'asc' } }),
    events: await db().agentJob.findMany({ where: { payload: { path: ['sourceEntityId'], equals: item.orderId } }, orderBy: { id: 'asc' } }) };
}
function twoPartyBarrier() {
  let arrived = 0, timer: ReturnType<typeof setTimeout> | undefined, release!: () => void, fail!: (reason: Error) => void;
  const both = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  return async () => {
    arrived += 1;
    if (arrived === 1) timer = setTimeout(() => fail(Error('Both actual PG requests must reach the coordinated boundary')), 10_000);
    if (arrived === 2) { clearTimeout(timer); release(); }
    await both;
  };
}
type Probe = { beforeTransaction?: () => Promise<void>; activeBarrier?: () => Promise<void>; orderReadBarrier?: () => Promise<void>;
  failConsumptionAudit?: boolean; auditFaultReached?: boolean; createdId?: string; transactionCount?: number };
function intercepted(item: Fixture, probe: Probe): PrismaClient {
  const client = db(); let beforeRan = false;
  return new Proxy(client, { get(target, property) {
    if (property === 'dr013ExceptionRequest' && probe.activeBarrier) return new Proxy(target.dr013ExceptionRequest, { get(model, method) {
      if (method === 'findMany') return async (...args: any[]) => {
        const rows = await (model.findMany as any)(...args);
        if (rows.some((row: any) => row.id === item.exceptionId && row.status === 'ReviewerApproved')) await probe.activeBarrier!();
        return rows;
      };
      const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
    } });
    if (property === '$transaction') return async (work: any, options?: any) => {
      if (typeof work !== 'function') return (target.$transaction as any)(work, options);
      if (!beforeRan && probe.beforeTransaction) { beforeRan = true; await probe.beforeTransaction(); }
      probe.transactionCount = (probe.transactionCount ?? 0) + 1;
      return target.$transaction(async tx => work(new Proxy(tx, { get(transaction, key) {
        if (key === 'order') return new Proxy(transaction.order, { get(model, method) {
          if (method === 'findUnique' && probe.orderReadBarrier) return async (...args: any[]) => {
            const row = await (model.findUnique as any)(...args);
            if (row?.id === item.orderId && row.status === 'Pending') await probe.orderReadBarrier!();
            return row;
          };
          if (method === 'create') return async (...args: any[]) => { const row = await (model.create as any)(...args); probe.createdId = row.id; return row; };
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        if (key === 'auditLog' && probe.failConsumptionAudit) return new Proxy(transaction.auditLog, { get(model, method) {
          if (method === 'create') return async (args: any) => {
            if (args.data.action !== 'dr013_exception_consumed') return model.create(args);
            probe.auditFaultReached = true;
            // The real PG FK rejects this actor; no fake rejected Promise/error.
            return model.create({ ...args, data: { ...args.data, actorId: `${prefix}-nonexistent-audit-actor` } });
          };
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = Reflect.get(transaction, key); return typeof value === 'function' ? value.bind(transaction) : value;
      } })), { ...options, timeout: 20_000 });
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function act(item: Fixture, client = db()) {
  return item.kind === 'create' ? createOrderServiceV2(client).createOrder(actor, item.input)
    : transitionOrderStatus({ prisma: client, orderId: item.orderId, toStatus: 'Confirmed', actorId: actor.userId, operator: 'untrusted-operator-label' });
}
async function mutateScope(item: Fixture, patch: Record<string, unknown>, status?: string) {
  const row = await db().dr013ExceptionRequest.findUniqueOrThrow({ where: { id: item.exceptionId } });
  const attachments: any = row.attachments;
  await db().dr013ExceptionRequest.update({ where: { id: item.exceptionId }, data: {
    ...(status ? { status } : {}), attachments: { ...attachments, scope: { ...attachments.scope, ...patch } } } });
}

async function agentFixture(label: string) {
  const item = await fixture(label, 'confirm'), poNumber = `${item.id}-po`, agentApprovalId = `${item.id}-agent-approval`;
  await db().order.update({ where: { id: item.orderId }, data: { poNumber } });
  await db().orderLine.create({ data: { id: `${item.id}-line`, orderId: item.orderId, lineNumber: 1,
    description: 'Actual synthetic order line', quantity: 10_000, unit: 'M', unitPrice: '0.1', netValue: 1000 } });
  const draft = buildOrderConfirmProcessDraft({ poNumber, previousStatus: 'Pending', newStatus: 'Confirmed', snapshot: {
    orderId: item.orderId, poNumber, status: 'Pending', amount: 1000, currency: 'USD',
    customerRelationId: item.relationId, customerName: item.id, lineCount: 1,
  } });
  const payload = { processDraft: draft, toolId: 'order.confirm' };
  await db().approvalRequest.create({ data: { id: agentApprovalId, requesterId: consumerId, reviewerId, status: 'approved',
    actionType: 'tool:order.confirm', targetType: 'Order', targetId: item.orderId, risk: 'high', payload: JSON.parse(JSON.stringify(payload)), decidedAt: new Date() } });
  return { ...item, agentApprovalId, payload, draft };
}
type AgentFixture = Awaited<ReturnType<typeof agentFixture>>;
async function agentState(item: AgentFixture) {
  const invoices = await db().invoice.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }), ids = invoices.map(row => row.id);
  return { business: await snapshot(item), invoices,
    receipts: await db().agentCommitReceipt.findMany({ where: { approvalId: item.agentApprovalId }, orderBy: { id: 'asc' } }),
    invoiceLinks: await db().entityLink.findMany({ where: { fromType: 'invoice', fromId: { in: ids } }, orderBy: { id: 'asc' } }),
    invoiceReferences: await db().entityReference.findMany({ where: { ownerType: 'invoice', ownerId: { in: ids } }, orderBy: { id: 'asc' } }),
    approval: await db().approvalRequest.findUniqueOrThrow({ where: { id: item.agentApprovalId } }) };
}
function actAgent(item: AgentFixture, client = db()) {
  return commitOrderConfirm({ prisma: client, approvalId: item.agentApprovalId, approvalPayload: item.payload, actorId: consumerId });
}
async function quotationFixture(label: string) {
  const item = await fixture(label, 'create'), quotationId = `${item.id}-quote`, pricingId = `${item.id}-pricing`, now = BigInt(Date.now());
  await db().quotation.create({ data: { id: quotationId, quotationNumber: quotationId, status: 'Accepted', currency: 'USD',
    totalAmount: 1000, issueDate: '2026-10-01', validUntil: '2099-01-01', customerRelationId: item.relationId,
    customerName: item.id, ownerId: consumerId, paymentInstrument: 'T/T', moqSnapshot: {
      fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20, configId: null,
      source: 'fallback_constant', snapshotAt: new Date().toISOString(),
    }, createdAt: now, updatedAt: now, lines: { create: [{ id: `${quotationId}-line`, lineNumber: 1,
      description: 'Synthetic accepted fabric', quantity: 10_000, unit: 'M', unitPrice: '0.1', amount: 1000, createdAt: now }] } } });
  await db().pricingCalculation.create({ data: { id: pricingId, quotationId, status: 'Confirmed', purchaseCostCny: 1,
    refundRate: 0, exchangeRate: 7, profitMargin: '0.1', commissionRate: 0, netUsdCost: '0.1429',
    profitAmount: '0.0143', commissionAmount: 0, finalUnitPrice: '0.1572', createdAt: now, updatedAt: now } });
  return { ...item, quotationId, pricingId };
}
type QuotationFixture = Awaited<ReturnType<typeof quotationFixture>>;
async function quotationState(item: QuotationFixture) {
  const business = await snapshot(item), ids = business.orders.map(row => row.id);
  return { business,
    quotation: await db().quotation.findUniqueOrThrow({ where: { id: item.quotationId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } }),
    pricing: await db().pricingCalculation.findUniqueOrThrow({ where: { id: item.pricingId } }),
    orderLines: await db().orderLine.findMany({ where: { orderId: { in: ids } }, orderBy: { id: 'asc' } }),
    stages: await db().productionStage.findMany({ where: { orderId: { in: ids } }, orderBy: { id: 'asc' } }),
    quotationAudits: await db().auditLog.findMany({ where: { targetType: 'Quotation', targetId: item.quotationId }, orderBy: { id: 'asc' } }),
    quotationLinks: await db().entityLink.findMany({ where: { fromType: 'quotation', fromId: item.quotationId }, orderBy: { id: 'asc' } }),
    quotationReferences: await db().entityReference.findMany({ where: { ownerType: 'quotation', ownerId: item.quotationId }, orderBy: { id: 'asc' } }) };
}
function actQuotation(item: QuotationFixture, client = db()) {
  return createQuotationService(client).convertToOrder(item.quotationId, consumerId, { type: 'Fabric' });
}

describe.sequential('credit/Order real PG business transaction', () => {
  it('Order/order:confirm commits status/projections/actor/audit/quota/durable events together', async () => {
    const item = await fixture('confirm-success', 'confirm'), before = await snapshot(item);
    const result = await act(item); expect(code(result), JSON.stringify({ code: code(result), actor: actor.userId })).toBe('OK');
    const after = await snapshot(item);
    expect(after.orders).toHaveLength(1); expect(after.orders[0].status).toBe('Confirmed');
    expect(after.transitions).toHaveLength(1); expect(after.transitions[0]).toMatchObject({ fromStatus: 'Pending', toStatus: 'Confirmed', operator: consumerId });
    expect(after.links).toEqual([expect.objectContaining({ fromId: item.orderId, toId: item.relationId, linkKind: 'orderedBy', status: 'active' })]);
    expect(after.references).toEqual([expect.objectContaining({ ownerId: item.orderId, targetId: item.relationId, fieldKey: 'customer' })]);
    expect(after.exception).toMatchObject({ status: 'Consumed', attachments: { files: ['synthetic-credit-evidence'], scope: {
      targetType: 'Order', targetId: item.orderId, action: 'order:confirm', usedCount: 1, consumptions: [expect.objectContaining({ consumedBy: consumerId })] } } });
    expect(after.audits.map(audit => audit.action).sort()).toEqual(['dr013_exception_consumed', 'transition_order_status']);
    for (const audit of after.audits) expect(audit.actorId).toBe(consumerId);
    expect(after.events.map(event => event.jobType).sort()).toEqual(['bev:OrderConfirmed', 'bev:OrderStatusChanged']);
    for (const event of after.events) expect(event.payload).toMatchObject({ actorId: consumerId, sourceEntityId: item.orderId });
    expect(observed.filter(event => event.sourceEntityId === item.orderId).map(event => event.type).sort()).toEqual(['OrderConfirmed', 'OrderStatusChanged']);
    expect(after.approval).toEqual(before.approval); expect(after.credit).toEqual(before.credit); expect(after.credit.status).toBe('Frozen');
  });
  it('Relation/order:create commits exactly one new order and consumes that precise customer action', async () => {
    const item = await fixture('create-success', 'create'), before = await snapshot(item); const probe: Probe = {};
    const result = await act(item, intercepted(item, probe)); expect(code(result)).toBe('OK'); const after = await snapshot(item);
    expect(probe.transactionCount).toBe(1); expect(after.orders).toHaveLength(1); expect(after.orders[0]).toMatchObject({ id: probe.createdId,
      status: 'Pending', ownerId: consumerId, customerRelationId: item.relationId, paymentInstrument: 'T/T' });
    expect(after.exception).toMatchObject({ status: 'Consumed', attachments: { scope: { targetType: 'Relation', targetId: item.relationId,
      action: 'order:create', usedCount: 1, consumptions: [expect.objectContaining({ consumedBy: consumerId, note: expect.stringContaining(probe.createdId!) })] } } });
    expect(after.audits).toEqual([expect.objectContaining({ actorId: consumerId, action: 'dr013_exception_consumed', targetId: item.exceptionId })]);
    expect(after.approval).toEqual(before.approval); expect(after.credit).toEqual(before.credit); expect(after.credit.status).toBe('Frozen');
  });
  it.each(['create', 'confirm'] as const)('%s audit FK failure rolls order, quota, mandatory audit and projections back', async kind => {
    const item = await fixture(`${kind}-audit-fk`, kind), before = await snapshot(item); const probe: Probe = { failConsumptionAudit: true };
    const result = await act(item, intercepted(item, probe)); expect(code(result)).toBe('EXCEPTION_CONSUME_FAILED');
    expect(probe.auditFaultReached).toBe(true); expect(probe.transactionCount).toBe(1);
    if (kind === 'create') { expect(probe.createdId).toBeTruthy(); expect(await db().order.findUnique({ where: { id: probe.createdId! } })).toBeNull(); }
    expect(await snapshot(item)).toEqual(before); expect(observed.filter(event => event.sourceEntityId === item.orderId)).toEqual([]);
    expect(code(await act(item))).toBe('OK'); expect((await snapshot(item)).exception.status).toBe('Consumed');
  });
  it('two new orders competing after the same approved preflight cannot spend one Relation quota twice', async () => {
    const item = await fixture('create-concurrent', 'create'), before = await snapshot(item); const barrier = twoPartyBarrier();
    const left: Probe = { activeBarrier: barrier }, right: Probe = { activeBarrier: barrier };
    const results = await Promise.all([act(item, intercepted(item, left)), act(item, intercepted(item, right))]);
    expect(results.map(code).sort()).toEqual(['EXCEPTION_ALREADY_CONSUMED', 'OK']);
    expect(left.createdId).toBeTruthy(); expect(right.createdId).toBeTruthy(); expect(left.createdId).not.toBe(right.createdId);
    const after = await snapshot(item); expect(after.orders).toHaveLength(1); expect(after.exception.status).toBe('Consumed');
    expect((after.exception.attachments as any).scope).toMatchObject({ usedCount: 1, consumptions: [expect.objectContaining({ consumedBy: consumerId })] });
    expect(after.audits).toEqual([expect.objectContaining({ action: 'dr013_exception_consumed', actorId: consumerId })]);
    expect(after.approval).toEqual(before.approval); expect(after.credit).toEqual(before.credit);
  });
  it('two confirmations with actual Pending row reads commit only one transition/quota/event set', async () => {
    const item = await fixture('confirm-concurrent', 'confirm'), before = await snapshot(item); const barrier = twoPartyBarrier();
    const results = await Promise.all([act(item, intercepted(item, { orderReadBarrier: barrier })), act(item, intercepted(item, { orderReadBarrier: barrier }))]);
    expect(results.map(code).sort()).toEqual(['EXCEPTION_ALREADY_CONSUMED', 'OK']);
    const after = await snapshot(item); expect(after.orders[0].status).toBe('Confirmed'); expect(after.transitions).toHaveLength(1);
    expect(after.events).toHaveLength(2); expect(after.links).toHaveLength(1); expect(after.references).toHaveLength(1);
    expect((after.exception.attachments as any).scope.usedCount).toBe(1);
    expect(after.audits.filter(audit => audit.action === 'dr013_exception_consumed')).toHaveLength(1);
    expect(after.audits.filter(audit => audit.action === 'transition_order_status')).toHaveLength(1);
    expect(after.approval).toEqual(before.approval); expect(after.credit).toEqual(before.credit);
  });
  it.each(['create', 'confirm'] as const)('%s rechecks an actual post-preflight target/action change before committing business state', async kind => {
    const item = await fixture(`${kind}-scope-change`, kind);
    const probe: Probe = { beforeTransaction: () => mutateScope(item, kind === 'create' ? { targetType: 'Order', targetId: item.orderId } : { action: 'order:create' }) };
    expect(code(await act(item, intercepted(item, probe)))).toBe('EXCEPTION_NOT_FOR_THIS_ENTITY'); const after = await snapshot(item);
    expect(after.orders.map(order => order.status)).toEqual(kind === 'create' ? [] : ['Pending']);
    expect(after.exception.status).toBe('ReviewerApproved'); expect((after.exception.attachments as any).scope.usedCount).toBe(0);
    expect(after.audits).toEqual([]); expect(after.transitions).toEqual([]); expect(after.links).toEqual([]); expect(after.references).toEqual([]); expect(after.events).toEqual([]);
    expect(after.approval.status).toBe('approved'); expect(after.credit.status).toBe('Frozen');
  });
  it.each(['create', 'confirm'] as const)('normal %s does not consume an available credit exception it never used', async kind => {
    const item = await fixture(`${kind}-normal`, kind, false), before = await snapshot(item);
    expect(code(await act(item))).toBe('OK'); const after = await snapshot(item);
    expect(after.exception).toEqual(before.exception); expect(after.approval).toEqual(before.approval); expect(after.credit).toEqual(before.credit);
    expect(after.audits.filter(audit => audit.action === 'dr013_exception_consumed')).toEqual([]);
    expect(after.orders).toHaveLength(1); expect(after.orders[0].status).toBe(kind === 'create' ? 'Pending' : 'Confirmed');
  });
  it('Agent confirmation commits receipt/invoice/graph/actor/audit and the exact Order quota together', async () => {
    const item = await agentFixture('agent-success'), before = await agentState(item);
    const result = await actAgent(item); expect(result, JSON.stringify({ ok: result.ok, error: result.error })).toMatchObject({ ok: true, committed: true });
    const after = await agentState(item); expect(after.business.orders[0].status).toBe('Confirmed');
    expect(after.invoices).toHaveLength(1); expect(after.invoices[0]).toMatchObject({ id: result.invoiceId, status: 'Issued', orderId: item.orderId });
    expect(after.receipts).toEqual([expect.objectContaining({ status: 'committed', idempotencyKey: item.draft.idempotencyKey })]);
    expect(after.invoiceLinks.map(row => row.linkKind).sort()).toEqual(['aboutOrder', 'billTo']); expect(after.invoiceReferences).toHaveLength(2);
    expect(after.business.audits.map(row => row.action).sort()).toEqual(['dr013_exception_consumed', 'order_confirm_committed']);
    expect(after.business.audits.every(row => row.actorId === consumerId)).toBe(true);
    expect((after.business.exception.attachments as any).scope).toMatchObject({ targetType: 'Order', targetId: item.orderId, action: 'order:confirm', usedCount: 1 });
    expect(after.business.approval).toEqual(before.business.approval); expect(after.approval).toEqual(before.approval); expect(after.business.credit).toEqual(before.business.credit);
  });
  it('Agent consumption audit SQL failure rolls invoice/receipt/status/graph back; same draft retry can commit', async () => {
    const item = await agentFixture('agent-audit-fk'), before = await agentState(item); const probe: Probe = { failConsumptionAudit: true };
    const result = await actAgent(item, intercepted(item, probe)); expect(result).toMatchObject({ ok: false, committed: false,
      errorFeedback: { gateCode: 'EXCEPTION_CONSUME_FAILED', retryable: true } }); expect(probe.auditFaultReached).toBe(true);
    expect(await agentState(item)).toEqual(before); expect((await actAgent(item)).ok).toBe(true); expect((await agentState(item)).invoices).toHaveLength(1);
  });
  it('concurrent replay of one approved Agent draft commits one invoice/receipt and one consumption', async () => {
    const item = await agentFixture('agent-concurrent'), barrier = twoPartyBarrier();
    const results = await Promise.all([actAgent(item, intercepted(item, { activeBarrier: barrier })), actAgent(item, intercepted(item, { activeBarrier: barrier }))]);
    expect(results.filter(result => result.ok).length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.ok) expect(result.idempotencyKey).toBe(item.draft.idempotencyKey);
      else { expect(result.error).toMatch(/^COMMIT_CONFLICT:/); expect(result.errorFeedback?.retryable).toBe(true); }
    }
    const after = await agentState(item); expect(after.invoices).toHaveLength(1); expect(after.receipts).toHaveLength(1);
    expect(after.business.transitions).toHaveLength(1); expect((after.business.exception.attachments as any).scope.usedCount).toBe(1);
    expect(after.business.audits.filter(row => row.action === 'dr013_exception_consumed')).toHaveLength(1);
  });
  it('quotation conversion consumes Relation/order:create with quotation/pricing/order/graph in one transaction', async () => {
    const item = await quotationFixture('quotation-success'), before = await quotationState(item), result = await actQuotation(item);
    const after = await quotationState(item); expect(after.quotation.convertedOrderId).toBe(result.orderId);
    expect(after.business.orders).toHaveLength(1); expect(after.orderLines).toHaveLength(1); expect(after.pricing.orderId).toBe(result.orderId);
    expect(after.quotationLinks).toEqual(expect.arrayContaining([expect.objectContaining({ linkKind: 'convertedToOrder', toId: result.orderId })]));
    expect(after.quotationAudits).toEqual([expect.objectContaining({ actorId: consumerId, action: 'convert_quotation_to_order' })]);
    expect(after.business.audits.map(row => row.action).sort()).toEqual(['create_order_from_quotation', 'dr013_exception_consumed']);
    expect((after.business.exception.attachments as any).scope).toMatchObject({ targetType: 'Relation', targetId: item.relationId, action: 'order:create', usedCount: 1 });
    expect(after.business.approval).toEqual(before.business.approval); expect(after.business.credit).toEqual(before.business.credit);
  });
  it('quotation consumption audit FK failure rolls claim/pricing/order/lines/graph back and starts no production stages', async () => {
    const item = await quotationFixture('quotation-audit-fk'), before = await quotationState(item); const probe: Probe = { failConsumptionAudit: true };
    await expect(actQuotation(item, intercepted(item, probe))).rejects.toMatchObject({ code: 'EXCEPTION_CONSUME_FAILED', statusCode: 500 });
    expect(probe.auditFaultReached).toBe(true); expect(probe.createdId).toBeTruthy(); expect(await quotationState(item)).toEqual(before);
    expect(await db().productionStage.count({ where: { orderId: probe.createdId } })).toBe(0);
    expect(await db().order.findUnique({ where: { id: probe.createdId! } })).toBeNull();
    expect((await actQuotation(item)).orderId).toBeTruthy(); expect((await quotationState(item)).business.exception.status).toBe('Consumed');
  });
  it('manual create and quotation conversion share one Relation quota without two committed business actions', async () => {
    const item = await quotationFixture('quotation-versus-manual'), barrier = twoPartyBarrier();
    const results = await Promise.all([act(item, intercepted(item, { activeBarrier: barrier })),
      actQuotation(item, intercepted(item, { activeBarrier: barrier })).then(value => ({ ok: true, data: value }),
        error => ({ ok: false, error: { code: error.code } }))]);
    expect(results.map(code).sort()).toEqual(['EXCEPTION_ALREADY_CONSUMED', 'OK']);
    const after = await quotationState(item); expect(after.business.orders).toHaveLength(1); expect((after.business.exception.attachments as any).scope.usedCount).toBe(1);
    expect(after.business.audits.filter(row => row.action === 'dr013_exception_consumed')).toHaveLength(1);
    if (results[1].ok) { expect(after.quotation.convertedOrderId).toBe(after.business.orders[0].id); expect(after.pricing.orderId).toBe(after.business.orders[0].id); }
    else { expect(after.quotation.convertedOrderId).toBeNull(); expect(after.pricing.orderId).toBeNull(); expect(after.quotationAudits).toEqual([]); expect(after.quotationLinks).toEqual([]); }
  });
});
