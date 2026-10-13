import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertApprovalReviewSourceRead, canReadApprovalReviewAttachments } from '../approvalReviewSourceAccess';
import { PRIVATE_FILES_DIR } from '../../lib/privateFiles';

const mocks = vi.hoisted(() => ({ current: vi.fn(), developmentRead: vi.fn(), orderAccess: vi.fn(), orderWhere: vi.fn() }));
vi.mock('../../auth/permissionService', () => ({
  createPermissionService: () => ({ getUserPermissionContext: mocks.current }),
  hasScope: (actor: any, scope: string) => actor?.permissions?.includes(scope) === true,
}));
vi.mock('../../development/developmentExpenseAccess', () => ({ assertDevelopmentExpenseAccess: mocks.developmentRead }));
vi.mock('../../orders/orderQueryReadAccess', () => ({ andOrderScope: (where: any, scope: any) => mocks.orderWhere(where, scope),
  loadOrderQueryReadAccess: (...args: any[]) => mocks.orderAccess(...args) }));
vi.mock('../../orders/orderService', () => ({ buildOrderListScopeWhere: vi.fn() }));
vi.mock('../../quotations/quotationService', () => ({ buildQuotationListScopeWhere: vi.fn() }));
vi.mock('../../paymentRequests/paymentRequestScope', () => ({ buildPaymentRequestScope: vi.fn(), canSeePaymentRequest: vi.fn() }));
vi.mock('../../claims/claimVisibility', () => ({ createClaimVisibility: vi.fn() }));
vi.mock('../../internalTrade/internalTransferService', () => ({ decodeInternalTransferPayload: vi.fn() }));
vi.mock('../../finance/invoiceAttachmentService', () => ({ readInvoiceAttachment: vi.fn() }));

const actor: any = { userId: 'leader-1', roles: ['manager'], permissions: ['products:read', 'emails:read'],
  permissionCeiling: ['products:read', 'emails:read'] };
const current: any = { legacyRoleCodes: ['manager'], roleIds: ['role-manager'], scopes: ['products:read', 'emails:read', 'orders:read'], departmentIds: [] };

beforeEach(() => { vi.clearAllMocks(); mocks.current.mockResolvedValue(current); mocks.developmentRead.mockResolvedValue({ id: 'case-1' });
  mocks.orderAccess.mockResolvedValue({ orderWhere: { deletedAt: null } }); mocks.orderWhere.mockImplementation((where: any, scope: any) => ({ AND: [where, scope] })); });

describe('approval review source read authorization', () => {
  it('rechecks current permissions and delegates development customer scope to the native read gate', async () => {
    const tx = {};
    await assertApprovalReviewSourceRead(tx, { id: 'approval-1', actionType: 'development:fee', targetType: 'BillingItem',
      payload: { caseId: 'case-1' } }, actor);
    expect(mocks.current).toHaveBeenCalledWith('leader-1');
    expect(mocks.developmentRead).toHaveBeenCalledWith(tx, expect.objectContaining({ userId: 'leader-1',
      roles: ['manager'], permissions: ['products:read', 'emails:read', 'orders:read'], authorizationLoaded: true }), 'case-1', 'read');
  });

  it('rechecks every order in the signed confirmation or composite contract under current order scope', async () => {
    const tx: any = { order: { findFirst: vi.fn(async () => ({ id: 'readable' })) } };
    await assertApprovalReviewSourceRead(tx, { id: 'approval-1', actionType: 'order:confirmation_sign',
      targetType: 'OrderConfirmation', targetId: 'order-1', payload: { orderId: 'order-1' } }, actor);
    expect(tx.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [
      { id: 'order-1', deletedAt: null }, { deletedAt: null },
    ] } }));
    tx.order.findFirst.mockClear();
    await assertApprovalReviewSourceRead(tx, { id: 'approval-2', actionType: 'contract:sign', targetType: 'Contract',
      targetId: 'composite:CONTRACT:order-1,order-2', payload: { sourceIds: ['order-2', 'order-1'] } }, actor);
    expect(tx.order.findFirst).toHaveBeenCalledTimes(2);
  });

  it('fails closed for unknown approval domains instead of returning source data', async () => {
    await expect(assertApprovalReviewSourceRead({}, { id: 'approval-1', actionType: 'new:unknown', targetType: 'Unknown',
      payload: {} }, actor)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('uses the native attachment id and filePath, and requires an existing file inside its private root', async () => {
    const id = 'file-1', fileName = `approval-review-${randomUUID()}.pdf`;
    const directory = path.join(PRIVATE_FILES_DIR, 'email-attachments');
    const fullPath = path.join(directory, fileName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(fullPath, 'synthetic private attachment');
    const tx: any = { emailAttachment: { findUnique: vi.fn(async () => ({ id, filePath: `email-attachments/${fileName}` })) } };
    const approval = { payload: { attachments: [{ href: `/api/v1/email/attachments/${id}/download` }] } };
    try {
      await expect(canReadApprovalReviewAttachments(tx, approval, actor)).resolves.toBe(true);
      expect(tx.emailAttachment.findUnique).toHaveBeenCalledWith({ where: { id }, select: { id: true, filePath: true } });
      tx.emailAttachment.findUnique.mockResolvedValue(null);
      await expect(canReadApprovalReviewAttachments(tx, approval, actor)).resolves.toBe(false);
      tx.emailAttachment.findUnique.mockResolvedValue({ id, filePath: `email-attachments/../${fileName}` });
      await expect(canReadApprovalReviewAttachments(tx, approval, actor)).resolves.toBe(false);
      await expect(canReadApprovalReviewAttachments(tx, { payload: { attachments: ['/private/raw.pdf'] } }, actor)).resolves.toBe(false);
      await expect(canReadApprovalReviewAttachments(tx, { payload: { attachments: [
        { href: `/api/v1/email/attachments/${id}/download` }, '/private/other.pdf',
      ] } }, actor)).resolves.toBe(false);
    } finally {
      fs.rmSync(fullPath, { force: true });
    }
  });
});
