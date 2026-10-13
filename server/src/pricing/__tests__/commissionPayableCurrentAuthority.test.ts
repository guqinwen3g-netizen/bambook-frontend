import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
import * as producer from '../../finance/invoiceMutationService';
import { createCommissionPayable, getOrderCommission } from '../commissionPayableService';

const effects = vi.hoisted(() => ({ publish: vi.fn(), settlement: vi.fn() }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: effects.publish }));
vi.mock('../../finance/shipmentBatchSettlementHook', () => ({ notifyShipmentBatchSettlementRecalc: effects.settlement }));

// Actual permission loader, Order L2, commission service and canonical Invoice
// producer. Explicit transactional storage and post-commit effect seams only;
// these controls prove adapter rollback, not native PostgreSQL isolation.
afterEach(() => vi.restoreAllMocks());
const scopes = ['pricing:read', 'pricing:write', 'sensitive:commission'];
const actor: TokenPayload = { userId: 'commission-current-user', roles: ['finance'], roleIds: ['role-finance'],
  departmentIds: [], permissions: scopes, authorizationLoaded: true };
function matches(row: any, where: any): boolean {
  if (!where) return true;
  if (where.AND && !where.AND.every((part: any) => matches(row, part))) return false;
  if (where.OR && !where.OR.some((part: any) => matches(row, part))) return false;
  return Object.entries(where).every(([key, value]: any) => {
    if (key === 'AND' || key === 'OR') return true;
    if (value === null || typeof value !== 'object') return row[key] === value;
    if ('in' in value) return value.in.includes(row[key]);
    if ('not' in value) return row[key] !== value.not;
    if ('startsWith' in value) return typeof row[key] === 'string' && row[key].startsWith(value.startsWith);
    throw new Error('Unexpected storage predicate: ' + key);
  });
}
function fixture() {
  const state = { invoices: [] as any[], audits: [] as any[], sequence: 0, committed: false,
    grantScopes: [...scopes], status: 'active', roleId: 'role-finance', events: [] as string[], locks: [] as string[],
    order: { id: 'commission-order', customerRelationId: null, ownerId: actor.userId, deletedAt: null },
    rows: [{ id: 'commission-price', orderId: 'commission-order', deletedAt: null, status: 'Confirmed',
      commissionAmount: new Prisma.Decimal('1'), quantity: new Prisma.Decimal('100'), commissionRuleId: 'commission-rule' }],
    rules: [{ id: 'commission-rule', rate: new Prisma.Decimal('5'), intermediaryRelationId: 'commission-intermediary',
      intermediaryName: 'Actual intermediary', isActive: true, deletedAt: null }],
    onLock: null as null | ((table: string) => void), onCreate: null as null | (() => void), auditFails: false, commitFails: false };
  const user = () => ({ id: actor.userId, status: state.status, deletedAt: null, primaryDeptId: null,
    roles: [{ departmentId: null, role: { id: state.roleId,
      permissions: state.grantScopes.map(scope => ({ permission: { scope } })) } }] });
  const db: any = {
    userAccount: { findFirst: vi.fn(async () => state.status === 'active' ? user() : null), findUnique: vi.fn(async () => user()) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    relation: { findMany: vi.fn(async () => []) }, teamMember: { findMany: vi.fn(async () => []) },
    teamDataGrant: { findMany: vi.fn(async () => []) },
    order: { findFirst: vi.fn(async ({ where }: any) => matches(state.order, where) ? { ...state.order } : null) },
    pricingCalculation: { findMany: vi.fn(async ({ where }: any) => state.rows.filter(row => matches(row, where)).map(row => ({ ...row }))) },
    commissionRule: { findMany: vi.fn(async ({ where }: any) => state.rules.filter(row => matches(row, where)).map(row => ({ ...row }))) },
    invoice: {
      findFirst: vi.fn(async ({ where }: any) => state.invoices.find(row => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => state.invoices.filter(row => matches(row, where)).map(row => ({ ...row }))),
      findUnique: vi.fn(async ({ where }: any) => state.invoices.find(row => matches(row, where)) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, deletedAt: null };
        state.invoices.push(row); state.events.push('invoice'); state.onCreate?.(); return row; }),
    },
    businessSequence: { upsert: vi.fn(async () => ({ seq: state.sequence })),
      update: vi.fn(async () => { state.events.push('sequence'); return { seq: ++state.sequence }; }) },
    invoiceOrderAllocation: { findMany: vi.fn(async () => []) }, orderShipmentBatch: { findMany: vi.fn(async () => []) },
    entityReference: { upsert: vi.fn(async () => ({})) }, entityLink: { upsert: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async ({ data }: any) => { state.events.push('audit');
      if (state.auditFails) throw new Error('private SQL driver'); state.audits.push(data); return data; }) },
    $queryRaw: vi.fn(async (sql: any) => { const text = sql.strings.join('?');
      const table = /FROM "([^\"]+)"/.exec(text)?.[1];
      if (!table || !text.includes('FOR UPDATE')) throw new Error('Expected actual row lock');
      state.locks.push(table); state.onLock?.(table); return [{ id: state.order.id }]; }),
  };
  db.$transaction = vi.fn(async (work: any) => {
    const before = { invoices: [...state.invoices], audits: [...state.audits], sequence: state.sequence, committed: state.committed };
    try { const result = await work(db); if (state.commitFails) throw new Error('private commit driver');
      state.committed = true; state.events.push('commit'); return result; }
    catch (error) { Object.assign(state, before); state.events.push('rollback'); throw error; }
  });
  effects.publish.mockReset().mockImplementation(async () => { state.events.push(state.committed ? 'publish' : 'dirty-publish'); });
  effects.settlement.mockReset().mockImplementation(async () => { state.events.push(state.committed ? 'settlement' : 'dirty-settlement'); });
  const submit = (supplied: TokenPayload | null | undefined = actor, input: any = { orderId: state.order.id }) =>
    createCommissionPayable(db, input, actor.userId, supplied);
  const noCommittedWrite = () => { expect(state.invoices).toEqual([]); expect(state.audits).toEqual([]);
    expect(state.sequence).toBe(0); expect(state.committed).toBe(false);
    expect(effects.publish).not.toHaveBeenCalled(); expect(effects.settlement).not.toHaveBeenCalled(); };
  return { state, db, submit, noCommittedWrite };
}

describe('commission Payable actual current pricing authority and atomic native producer', () => {
  it('delegated pricing-only AP locks actual sources, keeps canonical numbering/audit and sends effects only after outer commit', async () => {
    const f = fixture();
    f.state.invoices.push({ id: 'cancelled-anchor', invoiceNumber: 'INV-OLD', type: 'Payable', sourceType: 'CommissionPayable',
      sourceId: 'commission-order#1', orderId: f.state.order.id, amount: new Prisma.Decimal(100), currency: 'USD', status: 'Cancelled', deletedAt: null, issueDate: '2026-10-01' });
    const r = await f.submit(); expect(r.ok).toBe(true); if (!r.ok) throw Error('Expected delegated AP');
    expect(actor.permissions).not.toContain('invoices:write'); expect(f.state.grantScopes).not.toContain('invoices:write');
    expect(r.data.invoice).toMatchObject({ type: 'Payable', status: 'Issued', amount: new Prisma.Decimal(100),
      currency: 'USD', sourceId: 'commission-order#2', orderId: f.state.order.id, ownerId: actor.userId });
    expect(r.data.invoice.invoiceNumber).toMatch(/^INV-\d{4}-0001$/);
    expect(f.db.$transaction).toHaveBeenCalledTimes(1); expect(f.state.sequence).toBe(1);
    expect(f.state.audits).toHaveLength(1); expect(f.state.audits[0]).toMatchObject({ actorId: actor.userId, action: 'create_invoice' });
    expect(f.state.locks).toEqual(['Order', 'PricingCalculation', 'CommissionRule', 'Invoice']);
    expect(f.state.events).toEqual(['sequence', 'invoice', 'audit', 'commit', 'publish', 'settlement']);
    expect(r.data.commission.uninvoicedAmount).toBe(0);
  });
  it('actorId-only internal producer reloads actual active DB account and current pricing grant', async () => {
    const f = fixture(); const r = await createCommissionPayable(f.db, { orderId: f.state.order.id }, actor.userId);
    expect(r.ok).toBe(true); expect(f.db.userAccount.findUnique).toHaveBeenCalled(); expect(f.state.audits[0].actorId).toBe(actor.userId);
  });
  it.each(['revoked', 'disabled'] as const)('stale signed claims cannot authorize current %s account', async mode => {
    const f = fixture(); if (mode === 'revoked') f.state.grantScopes = []; else f.state.status = 'disabled';
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    expect(f.db.$transaction).not.toHaveBeenCalled(); expect(f.db.invoice.create).not.toHaveBeenCalled(); f.noCommittedWrite();
  });
  it('explicit empty signed ceiling remains binding despite body and legacy owner claims', async () => {
    const f = fixture();
    const r = await f.submit({ ...actor, roles: ['owner'], permissionCeiling: [] }, { orderId: f.state.order.id,
      actor: { ...actor, permissions: ['*'], permissionCeiling: ['*'] }, actorId: 'body-owner' });
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    expect(f.db.$transaction).not.toHaveBeenCalled(); f.noCommittedWrite();
  });
  it('body operator spoof cannot replace missing trusted actor', async () => {
    const f = fixture(); expect(await f.submit(null, { orderId: f.state.order.id, actor, actorId: actor.userId }))
      .toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', status: 401 } }); f.noCommittedWrite();
  });
  it('trusted actor cannot be rebound to a different audit operator', async () => {
    const f = fixture(); expect(await f.submit({ ...actor, userId: 'foreign-actor' }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } }); f.noCommittedWrite();
  });
  it('current Order L2 denies foreign parent even with pricing write', async () => {
    const f = fixture(); f.state.roleId = 'role-sales'; f.state.order.ownerId = 'foreign-user';
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', status: 404 } });
    expect(f.db.$transaction).not.toHaveBeenCalled(); f.noCommittedWrite();
  });
  it('pricing grant revoked while taking parent lock blocks the native producer', async () => {
    const f = fixture(); f.state.onLock = table => { if (table === 'Order') f.state.grantScopes = []; };
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.state.events).toContain('rollback'); f.noCommittedWrite();
  });
  it.each(['pricing', 'rule', 'anchor'] as const)('actual %s source mutation during lock acquisition rejects without a guessed invoice', async mode => {
    const f = fixture();
    if (mode === 'anchor') f.state.invoices.push({ id: 'cancelled-anchor', invoiceNumber: 'INV-OLD', type: 'Payable', sourceType: 'CommissionPayable',
      sourceId: 'commission-order#1', orderId: f.state.order.id, amount: new Prisma.Decimal(100), currency: 'USD', status: 'Cancelled', deletedAt: null, issueDate: '2026-10-01' });
    const before = [...f.state.invoices];
    f.state.onLock = table => {
      if (mode === 'pricing' && table === 'PricingCalculation') f.state.rows[0].quantity = new Prisma.Decimal(101);
      if (mode === 'rule' && table === 'CommissionRule') f.state.rules[0].intermediaryRelationId = 'other-intermediary';
      if (mode === 'anchor' && table === 'Invoice') f.state.invoices[0] = { ...f.state.invoices[0], orderId: 'foreign-order' };
    };
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.state.invoices).toEqual(before); expect(f.state.sequence).toBe(0);
    expect(f.state.audits).toEqual([]); expect(effects.publish).not.toHaveBeenCalled();
  });
  it('audit-boundary current grant revocation rolls back the already attempted invoice and number', async () => {
    const f = fixture(); f.state.onCreate = () => { f.state.grantScopes = []; };
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.db.auditLog.create).not.toHaveBeenCalled(); f.noCommittedWrite();
  });
  it('audit-boundary current Order L2 loss cannot be hidden by prior pricing authorization', async () => {
    const f = fixture(); f.state.onCreate = () => { f.state.roleId = 'role-sales'; f.state.order.ownerId = 'foreign-user'; };
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', status: 404 } });
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.db.auditLog.create).not.toHaveBeenCalled(); f.noCommittedWrite();
  });
  it('mandatory audit failure rolls back number and native Invoice and never leaks private diagnostics', async () => {
    const f = fixture(); f.state.auditFails = true; const r = await f.submit();
    expect(r).toMatchObject({ ok: false, error: { code: 'CREATE_FAILED', status: 500 } }); expect(JSON.stringify(r)).not.toContain('private SQL');
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.db.auditLog.create).toHaveBeenCalledTimes(1); f.noCommittedWrite();
  });
  it('outer commit failure suppresses canonical queued effects and restores all financial writes', async () => {
    const f = fixture(); f.state.commitFails = true;
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'CREATE_FAILED', status: 500 } });
    expect(f.db.auditLog.create).toHaveBeenCalledTimes(1); expect(f.state.events).toContain('rollback'); f.noCommittedWrite();
  });
  it('a canonical failed Result after explicit partial writes still aborts the owning transaction and drops queued effects', async () => {
    const f = fixture();
    vi.spyOn(producer, 'createInvoice').mockImplementationOnce(async params => {
      const tx = params.transaction!.tx as any;
      await tx.businessSequence.update({}); await tx.invoice.create({ data: { ...params.input, id: 'partial-invoice' } });
      await tx.auditLog.create({ data: { actorId: actor.userId, targetType: 'Invoice', targetId: 'partial-invoice', action: 'create_invoice' } });
      params.transaction!.deferAfterCommit(async () => { await effects.publish({ type: 'InvoiceIssued' }); });
      return { ok: false, error: { code: 'LINE_ALREADY_ALLOCATED', message: '已声明的业务拒绝' } };
    });
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'LINE_ALREADY_ALLOCATED', status: 409 } });
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.db.auditLog.create).toHaveBeenCalledTimes(1); f.noCommittedWrite();
  });
  it('soft-deleted pricing snapshots cannot be consumed as a current liability', async () => {
    const f = fixture(); f.state.rows[0].deletedAt = 10 as any;
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'NO_COMMISSION', status: 409 } }); f.noCommittedWrite();
  });
  it('a real four-decimal deficit is not rounded away by a large read-view number', async () => {
    const f = fixture(); f.state.rows[0].commissionAmount = new Prisma.Decimal('90071992547409.0999'); f.state.rows[0].quantity = new Prisma.Decimal(1);
    f.state.invoices.push({ id: 'issued-anchor', invoiceNumber: 'INV-OLD', type: 'Payable', sourceType: 'CommissionPayable',
      sourceId: 'commission-order#1', orderId: f.state.order.id, amount: new Prisma.Decimal('90071992547409.0998'), currency: 'USD', status: 'Issued', deletedAt: null, issueDate: '2026-10-01' });
    const before = await getOrderCommission(f.db, f.state.order.id); expect(before.ok).toBe(true);
    if (!before.ok) throw Error('Expected exact read balance'); expect(before.data.uninvoicedAmount).toBe(0.0001);
    const r = await f.submit(); expect(r.ok).toBe(true); if (!r.ok) throw Error('Expected exact remaining commission');
    expect(r.data.invoice.amount.eq(new Prisma.Decimal('0.0001'))).toBe(true); expect(r.data.invoice.sourceId).toBe('commission-order#2');
    const retry = await f.submit(); expect(retry).toMatchObject({ ok: false, error: { code: 'ALREADY_INVOICED', status: 409 } });
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.state.invoices).toHaveLength(2);
  });
  it('large stored decimal balance remains exact through canonical normalization', async () => {
    const f = fixture(); f.state.rows[0].commissionAmount = new Prisma.Decimal('90071992547409.0999'); f.state.rows[0].quantity = new Prisma.Decimal(1);
    const r = await f.submit(); expect(r.ok).toBe(true); if (!r.ok) throw Error('Expected exact decimal Invoice');
    expect(r.data.invoice.amount.eq(new Prisma.Decimal('90071992547409.0999'))).toBe(true);
  });
});
