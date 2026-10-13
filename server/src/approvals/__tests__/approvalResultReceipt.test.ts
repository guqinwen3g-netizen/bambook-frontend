import { describe, expect, it, vi } from 'vitest';
import { persistApprovalResultReceipt } from '../approvalResultReceipt';

describe('approval result receipt', () => {
  it('uses an immutable deterministic row id and skips duplicates without exposing decision payload', async () => {
    const rows: any[] = [];
    const tx = { notification: { createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
      expect(skipDuplicates).toBe(true);
      let count = 0;
      for (const row of data) if (!rows.some(item => item.id === row.id)) { rows.push(row); count++; }
      return { count };
    }) } } as any;
    const approval = { id: 'ap-1', requesterId: 'requester', actionType: 'finance:payment_request',
      targetType: 'PaymentRequest', targetId: 'pay-1', status: 'rejected',
      payload: { requestNumber: 'PR-2026-001', totalAmount: '9876.50', currency: 'USD' } } as any;

    const first = await persistApprovalResultReceipt(tx, approval, 'audit-decision-1');
    const retry = await persistApprovalResultReceipt(tx, approval, 'audit-decision-1');

    expect(rows).toHaveLength(1);
    expect(first).toMatchObject({ created: true, id: 'ntf_approval_decision_audit-decision-1', userId: 'requester', level: 'warning' });
    expect(retry).toMatchObject({ created: false, id: first!.id });
    expect(rows[0]).toMatchObject({ type: 'approval_decided', title: '付款申请 PR-2026-001 被驳回', metadata: {
      approvalId: 'ap-1', decisionAuditId: 'audit-decision-1', decisionStatus: 'rejected',
    } });
    expect(rows[0].body).toContain('驳回意见与待改内容见审批详情');
    expect(rows[0].body).not.toContain('9876.50');
    expect(rows[0].metadata).not.toHaveProperty('totalAmount');
  });

  it('distinguishes order confirmation receipts by frozen PO and keeps remarks out of the title', async () => {
    const titles: string[] = [];
    const tx = { notification: { createMany: vi.fn(async ({ data }: any) => {
      titles.push(data[0].title);
      return { count: 1 };
    }) } } as any;
    const makeApproval = (id: string, poNumber: string) => ({ id, requesterId: 'requester',
      actionType: 'order:confirmation_sign', targetType: 'OrderConfirmation', targetId: `opaque-${id}`,
      status: 'approved', payload: { documentSnapshot: { data: { poNumber } },
        notes: 'Long private remarks must not become the notification title.' } } as any);

    await persistApprovalResultReceipt(tx, makeApproval('ap-a', 'PO-2026-101'), 'decision-a');
    await persistApprovalResultReceipt(tx, makeApproval('ap-b', 'PO-2026-202'), 'decision-b');

    expect(titles).toEqual([
      '订单确认书签署 PO-2026-101 已通过',
      '订单确认书签署 PO-2026-202 已通过',
    ]);
    expect(titles.join(' ')).not.toContain('Long private remarks');
    expect(titles.join(' ')).not.toContain('opaque-');
  });

  it('prefers the frozen quotation document number over other payload references', async () => {
    let title = '';
    const tx = { notification: { createMany: vi.fn(async ({ data }: any) => {
      title = data[0].title;
      return { count: 1 };
    }) } } as any;

    await persistApprovalResultReceipt(tx, { id: 'quote-approval', requesterId: 'requester',
      actionType: 'quotation:price-deviation', targetType: 'Quotation', targetId: 'opaque-quotation',
      status: 'approved', payload: { documentSnapshot: { data: { quotationNumber: 'QT-FROZEN-7' } },
        quotationSnapshot: { quotationNumber: 'QT-OLDER-2' }, quotationNumber: 'QT-LEGACY-1' } } as any,
    'quote-decision');

    expect(title).toBe('报价偏差审批 QT-FROZEN-7 已通过');
  });

  it('does not make a business result receipt for tool approvals or approvals without an applicant', async () => {
    const createMany = vi.fn();
    const tx = { notification: { createMany } } as any;
    expect(await persistApprovalResultReceipt(tx, { id: 'tool-1', requesterId: 'u', actionType: 'tool:write',
      targetType: 'Tool', targetId: 't', status: 'approved' } as any, 'audit-1')).toBeNull();
    expect(await persistApprovalResultReceipt(tx, { id: 'orphan', requesterId: null, actionType: 'order:create',
      targetType: 'Order', targetId: 'o', status: 'approved' } as any, 'audit-2')).toBeNull();
    expect(createMany).not.toHaveBeenCalled();
  });
});
