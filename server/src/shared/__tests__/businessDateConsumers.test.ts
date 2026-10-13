import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../../auth/service';

vi.mock('../../devPanel/activeDb', () => ({ getActiveDb: () => 'panda_hub_dev' }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => 'audit-clock') }));
import { FIXED_BUSINESS_TIME_ISO } from '../businessClock';
import { nextBusinessNumber } from '../businessNumberService';
import { renderFormatTemplate } from '../../sequence/sequenceService';
import { actualFinancialDate } from '../../paymentRequests/supplierPaymentExecutionService';
import { cashDate } from '../../finance/companyCashAccountService';
import { orderSampleDate } from '../../samples/orderSampleSourceContract';
import { todayYmd, addDaysYmd } from '../../samples/fabricShipmentSampleService';
import { createSampleRoomService } from '../../samples/sampleRoomService';
import { storage } from '../../samples/__tests__/sampleRoomListFixture';
import { buildOrderSchedule } from '../../customer/orderScheduleService';
import { evaluateLcEligibility } from '../../customs/lcGate';
import { createFollowUpFromEmail } from '../../email/emailFollowUpService';
import { resolveCreditException } from '../../credit/creditExceptionGate';
import type { ExceptionService } from '../../exceptions/exceptionService';

const WALL_TIME = new Date('2034-12-31T18:00:00.000Z');
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('BAMBOOK_DEV_PANEL', '1');
  vi.stubEnv('DATABASE_URL', 'postgresql://clock-test:unused@127.0.0.1:1/panda_hub_dev');
  vi.stubEnv('BAMBOOK_DEV_BUSINESS_TIME', FIXED_BUSINESS_TIME_ISO); vi.stubEnv('TZ', 'UTC');
  vi.useFakeTimers(); vi.setSystemTime(WALL_TIME);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('business consumers retain the development as-of date when process time changes', () => {
  it('uses the business date in new numbers while preserving explicit history and wall-clock sequence metadata', async () => {
    const sequence = { upsert: vi.fn(async () => ({ seq: 0 })), update: vi.fn(async () => ({ seq: 1 })),
      findUnique: vi.fn(async () => null), deleteMany: vi.fn(async () => ({ count: 0 })) };
    expect(await nextBusinessNumber({ businessSequence: sequence }, 'INV')).toBe('INV-2026-0001');
    expect(sequence.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
      year: 2026, updatedAt: BigInt(WALL_TIME.getTime()),
    }) }));
    expect(renderFormatTemplate('{prefix}-{year}{month}{day}-{seq}', { prefix: 'PO', seq: 1 })).toBe('PO-20261008-0001');
    const historical = new Date('2024-02-28T17:00:00.000Z');
    expect(renderFormatTemplate('{year}{month}{day}', { prefix: 'PO', seq: 1, date: historical })).toBe('20240229');
    expect(historical.toISOString()).toBe('2024-02-28T17:00:00.000Z');
  });

  it('keeps actual financial and sample dates explicit instead of replacing historical input with today', () => {
    expect(todayYmd()).toBe('2026-10-08'); expect(addDaysYmd('2024-02-28', 1)).toBe('2024-02-29');
    for (const validate of [actualFinancialDate, cashDate, orderSampleDate]) {
      expect(validate('2024-02-29')).toBe('2024-02-29');
      for (const invalid of ['2026-02-29', '2026-02-30', '2026-10-08T00:18:00Z']) {
        expect(() => validate(invalid)).toThrow();
      }
    }
  });

  it('evaluates a pending order against the business day and completed shipments against their historical actual date', async () => {
    const shipments: Array<{ id: string; status: string; atd?: string; ata?: string }> = [];
    const db = { order: { findFirst: vi.fn(async () => ({ id: 'O-1', dueDate: '2026-10-09' })) },
      shipmentOrderAllocation: { findMany: vi.fn(async () => []) }, shipment: { findMany: vi.fn(async () => shipments) } };
    expect(await buildOrderSchedule(db as unknown as PrismaClient, 'O-1')).toMatchObject({ status: 'pending', deviationDays: -1 });
    shipments.push({ id: 'SH-1', status: 'Delivered', ata: '2026-10-10' });
    expect(await buildOrderSchedule(db as unknown as PrismaClient, 'O-1')).toMatchObject({ status: 'delayed', deviationDays: 1 });
  });

  it('keeps LC valid under the fixed date and enforces Shanghai end-of-day independently of the host timezone', () => {
    const lc = { id: 'LC-1', lcNumber: 'LC-1', status: 'Issued', expiryDate: '2026-10-09', shipmentDeadline: '2026-10-09' };
    expect(evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: 'L/C', lc })).toMatchObject({ eligible: true });
    vi.stubEnv('TZ', 'UTC');
    expect(evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: 'L/C',
      lc: { ...lc, expiryDate: '2026-10-08', shipmentDeadline: '2026-10-08' }, at: new Date('2026-10-08T16:00:00Z') }))
      .toMatchObject({ eligible: false, blockingReasons: ['LC_EXPIRED', 'LC_SHIPMENT_DEADLINE_PASSED'] });
    expect(evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: { ...lc, expiryDate: '2026-02-30' } }))
      .toMatchObject({ eligible: false, blockingReasons: ['LC_EXPIRY_UNREADABLE'] });
  });

  it('opens the credit-exception business window from the fixed instant without extending it to process time', async () => {
    const createRequest = vi.fn(async () => ({ ok: true as const, data: { exception: { id: 'EXC-1', approvalRequestId: 'APR-1' } } }));
    const exceptionService = { hasActiveException: vi.fn(async () => ({ active: false as const })),
      createExceptionRequest: createRequest } as unknown as ExceptionService;
    await expect(resolveCreditException({ exceptionService, actorId: 'U-1', blockReason: '信用冻结',
      scope: { targetType: 'Order', targetId: 'O-1', action: 'order:confirm' } })).resolves.toMatchObject({ passed: false });
    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({
      validUntil: new Date('2026-10-15T00:18:00.000Z'), maxUses: 1, targetId: 'O-1',
    }));
    expect(Date.now()).toBe(WALL_TIME.getTime());
  });

  it('uses the same business instant in room cards and overdue-loan filters but keeps the read snapshot wall time', async () => {
    const card = (id: string) => ({ id, code: id, name: id, devCaseId: 'F', cardType: 'fabric', quantity: 2, availableQty: 1,
      minStock: null, deletedAt: null });
    const loan = (id: string, itemId: string, due: string) => ({ id, itemId, loanType: 'borrow', loanQuantity: 1,
      loanLength: null, lengthReturnHistory: [], returnedAt: null, loanedAt: 1, dueAt: Date.parse(due) });
    const s = storage({ cases: [{ id: 'F', type: 'fabric', deletedAt: null }], items: [card('C-past'), card('C-future')],
      loans: [loan('L-past', 'C-past', '2026-10-07T10:00:00Z'), loan('L-future', 'C-future', '2026-10-09T10:00:00Z')] });
    const actor: TokenPayload = { userId: 'u_owner', roles: [], permissions: [], departmentIds: [], authorizationLoaded: true };
    const service = createSampleRoomService(s.db);
    const items = await service.listItems({ scope: 'fabric' }, actor);
    expect(items.ok).toBe(true); if (!items.ok) throw new Error(items.error.message);
    expect(items.data.snapshotAt).toBe(String(WALL_TIME.getTime()));
    expect(items.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'C-past', overdue: true }), expect.objectContaining({ id: 'C-future', overdue: false }),
    ]));
    const loans = await service.listLoans({ overdue: true }, actor);
    expect(loans.ok).toBe(true); if (!loans.ok) throw new Error(loans.error.message);
    expect(loans.data.total).toBe(1); expect(loans.data.loans.map((row: { id: string }) => row.id)).toEqual(['L-past']);
  });

  it('defaults email follow-up to the business today/tomorrow without rewriting explicit deadlines or audit epochs', async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const db = { email: { findUnique: vi.fn(async () => ({ id: 'E-1', relationId: 'R-1', subject: '确认交期', deletedAt: null })) },
      followUpRecord: { findFirst: vi.fn(async () => null), create } };
    await expect(createFollowUpFromEmail(db as unknown as PrismaClient, 'E-1', { actorId: 'U-1', source: 'test' }))
      .resolves.toMatchObject({ ok: true, nextFollowUpAt: '2026-10-09' });
    expect(create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ followUpAt: '2026-10-08',
      nextFollowUpAt: '2026-10-09', createdAt: BigInt(WALL_TIME.getTime()) }) });
    await expect(createFollowUpFromEmail(db as unknown as PrismaClient, 'E-1', { actorId: 'U-1', source: 'test',
      overrides: { nextFollowUpAt: '2024-02-29' } })).resolves.toMatchObject({ nextFollowUpAt: '2024-02-29' });
  });
});
