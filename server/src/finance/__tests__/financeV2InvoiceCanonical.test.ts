/** Pure V2 adapter controls with explicit config/source/storage seams.
 * Selected controls exercise actual canonical Invoice validation. No DB access,
 * company-default role UAT or native transaction atomicity is claimed here.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../../auth/service';
const controls = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), sequence: vi.fn(), currency: vi.fn(), scope: vi.fn(), lockSources: vi.fn() }));
vi.mock('../../auth/permissionService', async original => {
  const actual = await original<typeof import('../../auth/permissionService')>();
  return { ...actual, createPermissionService: vi.fn((options: Parameters<typeof actual.createPermissionService>[0]) => ({
    ...actual.createPermissionService(options), getDataScopeResolver: controls.scope,
  })) };
});
vi.mock('../../sequence/sequenceService', () => ({ createSequenceService: vi.fn(() => ({ nextNumber: controls.sequence })) }));
vi.mock('../../dictionaries/dataDictionaryService', () => ({ getDataDictionaryService: vi.fn(() => ({ getEntries: vi.fn().mockResolvedValue([]) })) }));
vi.mock('../../config/systemConfigService', () => ({ getSystemConfigService: vi.fn(() => ({ getString: controls.currency })) }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../shipping/shipmentFinancialAuthority', async original => ({ ...await original<typeof import('../../shipping/shipmentFinancialAuthority')>(), lockInvoiceFinancialSources: controls.lockSources }));
vi.mock('../invoiceMutationService', async original => ({ ...await original<typeof import('../invoiceMutationService')>(), createInvoice: controls.create, updateInvoice: controls.update }));
import { createFinanceServiceV2 } from '../financeServiceV2';
import { createFinanceV2Router } from '../routeV2';
import { createAuthService } from '../../auth/service';
import { businessError } from '../../shared/errorCodes';
const actor: TokenPayload = { userId: 'synthetic-current-finance', roles: [], permissions: ['orders:read', 'invoices:read', 'invoices:write'],
  authorizationLoaded: true, permissionCeiling: ['orders:read', 'invoices:read', 'invoices:write'], departmentIds: ['synthetic-finance-dept'] };
const invoice = { id: 'INV-source', invoiceNumber: 'INV-2026-0042', status: 'Issued', type: 'Receivable', amount: new Prisma.Decimal('12.0001'),
  currency: 'USD', customerRelationId: 'OWN', ownerId: actor.userId, deletedAt: null, createdAt: 1n, updatedAt: 2n };
function storage() {
  const denied = () => vi.fn().mockRejectedValue(Error('Direct V2 Invoice write is forbidden in this control'));
  return { invoice: { findFirst: vi.fn().mockResolvedValue(invoice), findUnique: vi.fn().mockResolvedValue(invoice), create: denied(), update: denied() },
    relation: {findFirst: vi.fn().mockResolvedValue({id:'OWN',ownerId:actor.userId,salesRepIds:[]})},
    invoiceLine:{findMany:vi.fn().mockResolvedValue([])}, invoiceOrderAllocation:{findMany:vi.fn().mockResolvedValue([])},
    quotation: { create: vi.fn().mockImplementation(async ({ data }: any) => data) },
    paymentVoucher: { create: vi.fn().mockImplementation(async ({ data }: any) => data) },
    // Real current-authority loader, with explicit active account and stored grants.
    userAccount: { findUnique: vi.fn().mockResolvedValue({ id: actor.userId, status: 'active', primaryDeptId: null,
      roles: [{ departmentId: null, role: { id: 'synthetic-finance-grant', permissions: actor.permissions!.map(scope => ({ permission: { scope } })) } }] }) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(), $queryRawUnsafe: vi.fn().mockResolvedValue([]), auditLog: { create: denied() } };
}
const noDirectWrite = (db: ReturnType<typeof storage>) => { expect(db.invoice.create).not.toHaveBeenCalled(); expect(db.invoice.update).not.toHaveBeenCalled(); expect(controls.sequence).not.toHaveBeenCalled(); };
function app(db: ReturnType<typeof storage>, current?: TokenPayload) {
  const result = express(); result.use(express.json());
  // Explicit composition-root identity seam, still subject to real matching JWT.
  if (current) result.use((req, _res, next) => { (req as any).actor = current; next(); });
  result.use('/api/v2/finance', createFinanceV2Router({ prisma: db as any, requireAuth: true, apiKeys: new Set() })); return result;
}
const authorization = () => `Bearer ${createAuthService().signToken(actor)}`;
beforeEach(() => { vi.clearAllMocks(); Object.values(controls).forEach(mock => mock.mockReset()); controls.scope.mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] });
  controls.sequence.mockResolvedValue('TECH-ONLY-0001'); controls.currency.mockResolvedValue('USD'); controls.lockSources.mockResolvedValue(undefined);
  controls.create.mockResolvedValue({ ok: true, data: { invoice, auditId: 'canonical-ack' } }); controls.update.mockResolvedValue({ ok: true, data: { invoice, auditId: 'canonical-ack' } }); });

describe('V2 Invoice canonical adapter', () => {
  it('passes trusted actor/IP and exact amounts and sources unchanged, with no V2 sequence and no mutation of caller input', async () => {
    const db = storage(), input = Object.freeze({ type: 'Receivable', status: 'Draft', amount: '90071992547409.1234', actorId: 'spoofed-body-subject', ownerId: 'spoofed-body-owner',
      orderAllocations: [{ orderId: 'O-source', batchId: 'OSB-source', allocatedAmount: '2.0001' }], invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'C-source', amount: '2.0001' }] });
    expect((await createFinanceServiceV2(db as any).create('invoice', actor, input, { ip: '127.0.0.9' })).ok).toBe(true);
    expect(controls.create).toHaveBeenCalledOnce(); expect(controls.create).toHaveBeenCalledWith({ prisma: db, actor, actorId: actor.userId, ip: '127.0.0.9', input: { ...input, currency: 'USD' } });
    const command = controls.create.mock.calls[0][0]; expect(command.actor).toBe(actor); expect(command.input.amount).toBe('90071992547409.1234'); expect(command.input.orderAllocations).toBe(input.orderAllocations);
    expect(command.input.invoiceNumber).toBeUndefined(); expect(command.input.id).toBeUndefined(); expect(input).not.toHaveProperty('currency'); noDirectWrite(db);
  });
  it('preserves explicit number/currency and the confirmed V2 DTO representation', async () => {
    const db = storage(), input = { type: 'Receivable', amount: '12.0001', invoiceNumber: 'CUSTOM-42', currency: 'EUR' };
    const result = await createFinanceServiceV2(db as any).create('invoice', actor, input);
    expect(controls.create.mock.calls[0][0].input).toEqual(input); expect(controls.currency).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { ...invoice, amount: 12.0001, createdAt: 1, updatedAt: 2 } }); noDirectWrite(db);
  });
  it.each([null, { ...actor, userId: '' }])('body actorId cannot supply missing trusted identity (%j)', async missing => {
    const db = storage(), result = await createFinanceServiceV2(db as any).create('invoice', missing as any, { actorId: actor.userId, actor, amount: '1' });
    expect(result.error?.code).toBe('UNAUTHORIZED'); expect(controls.create).not.toHaveBeenCalled(); noDirectWrite(db);
  });
  it('missing update identity is rejected before scoped lookup or canonical despite a body actorId', async () => {
    const db = storage(), result = await createFinanceServiceV2(db as any).update('invoice', { ...actor, userId: '' }, invoice.id, { actorId: actor.userId });
    expect(result.error?.code).toBe('UNAUTHORIZED'); expect(controls.scope).not.toHaveBeenCalled();
    expect(db.invoice.findFirst).not.toHaveBeenCalled(); expect(controls.update).not.toHaveBeenCalled(); noDirectWrite(db);
  });
  it('returns canonical source conflict and details intact without retrying a direct write', async () => {
    const db = storage(), error = { code: 'CONFLICT', message: 'Original source cancelled', details: { orderId: 'O-source' } }; controls.create.mockResolvedValue({ ok: false, error });
    expect(await createFinanceServiceV2(db as any).create('invoice', actor, { amount: '1', currency: 'USD' })).toEqual({ ok: false, error });
    expect(controls.create).toHaveBeenCalledOnce(); noDirectWrite(db);
  });
  it('checks current financial and customer source access, then delegates update sources, immutable number fields and amount without inventing timestamps', async () => {
    const db = storage(); controls.scope.mockResolvedValue({ rule: { kind: 'self' }, allowedDepartmentIds: [], allowedUserIds: [] });
    const input = Object.freeze({ amount: '8.0001', invoiceNumber: 'CANNOT-CHANGE', id: 'CANNOT-CHANGE', orderAllocations: [{ orderId: 'O-source', batchId: 'OSB-source', allocatedAmount: '8.0001' }] });
    expect((await createFinanceServiceV2(db as any).update('invoice', actor, invoice.id, input, { ip: '127.0.0.8' })).ok).toBe(true);
    expect(db.invoice.findFirst).toHaveBeenCalledWith({ where: { id: invoice.id, deletedAt: null } });
    expect(controls.update).toHaveBeenCalledWith({ prisma: db, invoiceId: invoice.id, input, actor, actorId: actor.userId, ip: '127.0.0.8' });
    expect(input).not.toHaveProperty('updatedAt'); noDirectWrite(db);
  });
  it('invisible invoice blocks canonical and all writes', async () => {
    const db = storage(); db.invoice.findFirst.mockResolvedValue(null as any);
    expect((await createFinanceServiceV2(db as any).update('invoice', actor, 'OTHER', { notes: 'Hidden source' })).error?.code).toBe('NOT_FOUND');
    expect(controls.update).not.toHaveBeenCalled(); noDirectWrite(db);
  });
  it.each(['quotation'] as const)('ordinary %s creation retains the generic path', async docType => {
    const db = storage(); expect((await createFinanceServiceV2(db as any).create(docType, actor, { amount: '3.0001' })).ok).toBe(true);
    expect(controls.sequence).toHaveBeenCalledOnce(); expect(docType === 'quotation' ? db.quotation.create : db.paymentVoucher.create).toHaveBeenCalledOnce();
    expect(controls.create).not.toHaveBeenCalled(); expect(controls.update).not.toHaveBeenCalled();
  });
});

describe('Actual canonical validation with explicit storage seams', () => {
  it('invalid amount is rejected before transaction or number allocation', async () => {
    const real = await vi.importActual<typeof import('../invoiceMutationService')>('../invoiceMutationService'); controls.create.mockImplementation(real.createInvoice);
    const db = storage(), result = await createFinanceServiceV2(db as any).create('invoice', actor, { type: 'Receivable', amount: 'NaN', currency: 'USD' });
    expect(result.error?.code).toBe('INVALID_AMOUNT'); expect(db.$transaction).not.toHaveBeenCalled(); noDirectWrite(db);
  });
  it('actual canonical calls source lock with trusted actor before any invoice, numbering or audit mutation and preserves typed denial', async () => {
    const real = await vi.importActual<typeof import('../invoiceMutationService')>('../invoiceMutationService'); controls.create.mockImplementation(real.createInvoice);
    const db = storage(); db.$transaction.mockImplementation(async work => work(db)); controls.lockSources.mockRejectedValue(businessError('CONFLICT', 'Explicit cancelled-source control'));
    const allocations = [{ orderId: 'O-source', batchId: 'OSB-source', allocatedAmount: '2.0001' }];
    const result = await createFinanceServiceV2(db as any).create('invoice', actor, { type: 'Receivable', amount: '2.0001', currency: 'USD', orderAllocations: allocations });
    expect(controls.lockSources).toHaveBeenCalledWith(db, expect.arrayContaining([expect.objectContaining(allocations[0])]), actor);
    expect(result.error?.code).toBe('CONFLICT'); expect(db.auditLog.create).not.toHaveBeenCalled(); noDirectWrite(db);
  });
  it.each(['Paid', 'PartiallyPaid'])('actual canonical rejects manual derived %s after original Invoice lock', async status => {
    const real = await vi.importActual<typeof import('../invoiceMutationService')>('../invoiceMutationService'); controls.update.mockImplementation(real.updateInvoice);
    const db = storage(); db.$transaction.mockImplementation(async work => work(db));
    const result = await createFinanceServiceV2(db as any).update('invoice', actor, invoice.id, { status });
    expect(result.error?.code).toBe('STATUS_NOT_MANUAL_SETTABLE'); expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', invoice.id);
    expect(db.auditLog.create).not.toHaveBeenCalled(); noDirectWrite(db);
  });
});

describe('Actual V2 Invoice HTTP route', () => {
  it('uses verified current server actor and IP instead of body metadata', async () => {
    const db = storage(), current = { ...actor, permissions: ['orders:read', 'invoices:write'], departmentIds: ['current-dept'] };
    const result = await request(app(db, current)).post('/api/v2/finance/invoices').set('Authorization', authorization()).send({ type: 'Receivable', amount: '12.0001', actorId: 'spoofed-body-subject', actor: { userId: 'spoofed-body-subject' } });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ ok: true, invoice: { id: invoice.id, amount: 12.0001 } });
    const command = controls.create.mock.calls[0][0]; expect(command.actor).toBe(current); expect(command.actorId).toBe(actor.userId); expect(command.ip).toEqual(expect.any(String)); noDirectWrite(db);
  });
  it.each([['INVALID_AMOUNT', 400], ['STATUS_NOT_MANUAL_SETTABLE', 400], ['CONFLICT', 409], ['FORBIDDEN', 403], ['AUTHORIZATION_UNAVAILABLE', 503]] as const)('registered %s maps to HTTP %s with original details', async (code, status) => {
    const db = storage(); controls.update.mockResolvedValue({ ok: false, error: { code, message: 'Canonical refusal', details: { sourceId: 'source-42' } } });
    const result = await request(app(db)).put(`/api/v2/finance/invoices/${invoice.id}`).set('Authorization', authorization()).send({ notes: 'Explicit correction' });
    expect(result.status).toBe(status); expect(result.body).toEqual({ error: code, message: 'Canonical refusal', details: { sourceId: 'source-42' } }); noDirectWrite(db);
  });
  it('signed empty ceiling and body-only actor fail before canonical', async () => {
    const db = storage(), result = app(db), signed = createAuthService().signToken({ ...actor, permissionCeiling: [] });
    expect((await request(result).post('/api/v2/finance/invoices').set('Authorization', `Bearer ${signed}`).send({ amount: '1', actorId: actor.userId })).status).toBe(403);
    expect((await request(result).post('/api/v2/finance/invoices').send({ amount: '1', actorId: actor.userId, actor })).status).toBe(401);
    expect(controls.create).not.toHaveBeenCalled(); noDirectWrite(db);
  });
});
