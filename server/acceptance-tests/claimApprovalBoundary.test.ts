// Real HTTP router and disposition service, mock storage only. An authenticated
// sales applicant without a valid approval cannot advance a financial disposition.
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../src/auth/service';
import { createClaimRouter } from '../src/claims/claimRoute';
describe('whole-product acceptance: approval evidence at the claims HTTP boundary', () => {
  it('denies sales direct Draft -> Approved and leaves the disposition untouched', async () => {
    const row: any = { id: 'acceptance-disposition', claimCaseId: 'acceptance-case', status: 'Draft', kind: 'Allowance', amount: 100, currency: 'USD', applicantId: 'acceptance-sales', deletedAt: null };
    const update = vi.fn(async ({ data }: any) => Object.assign(row, data));
    const prisma: any = {
      claimDisposition: { findUnique: vi.fn(async () => row), findFirst: vi.fn(async () => row), update },
      auditLog: { create: vi.fn(async () => ({ id: 'acceptance-audit' })) },
      claimCase: {
        findUnique: vi.fn(async () => ({ id: row.claimCaseId, status: 'Handling', deletedAt: null })),
        findFirst: vi.fn(async () => ({ id: row.claimCaseId, status: 'Handling', deletedAt: null,
          reportedBy: 'acceptance-sales', customerRelationId: null, sourceOrderId: null, sourceInvoiceId: null })),
      },
      // Actual current authorization and visible unlinked applicant case;
      // the original financial approval denial is reached, not an absent mock.
      userAccount: { findFirst: vi.fn(async () => ({ id: 'acceptance-sales', status: 'active', deletedAt: null,
        roles: [{ roleId: 'role-sales', role: { permissions: [{ permission: { scope: 'aftersales:read' } }] } }] })) },
      userPermissionOverrides: { findMany: vi.fn(async () => []) },
      teamMember: { findMany: vi.fn(async () => []) },
      teamDataGrant: { findMany: vi.fn(async () => []) },
      relation: { findMany: vi.fn(async () => []) },
      order: { findMany: vi.fn(async () => []) }, invoice: { findMany: vi.fn(async () => []) },
      approvalRequest: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
      $queryRawUnsafe: vi.fn(async () => []),
    };
    prisma.$transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const app = express(); app.use(express.json());
    app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
    app.use('/api/v1', createClaimRouter({ prisma, requireAuth: true }));
    const token = createAuthService().signToken({ userId: 'acceptance-sales', roles: ['sales'], permissions: ['aftersales:read'] });
    const res = await request(app).post('/api/v1/claims/dispositions/acceptance-disposition/approve').set('Authorization', `Bearer ${token}`).send({});
    expect(row.status, JSON.stringify({ httpStatus: res.status, writes: update.mock.calls.length })).toBe('Draft');
    expect(update).not.toHaveBeenCalled();
    expect([403, 409]).toContain(res.status);
  });
});
