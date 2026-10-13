import { describe, expect, it, vi } from 'vitest';
import { legacySourceStorage, storageRowLocks } from './shippingLegacyStorageFixture';
import {
  buildOrderShipDraft,
  validateOrderShipDraftSemantics,
  verifyOrderShipDraftHash,
  commitOrderShip,
  buildOrderShipError,
  type OrderShipErrorCode,
} from '../orderShipFlow';

// ============================================================================
// ERP-P1-order-ship-agent-flow-contract: 纯函数 + 集成测试
// ============================================================================

describe('task order-ship: buildOrderShipDraft（draft payload）', () => {
  it('生成含 6 字段的 ProcessDraft', () => {
    const draft = buildOrderShipDraft({
      orderId: 'O1',
      shipment: { shipmentNumber: 'SHIP-001', type: 'Ocean', shippingMethod: 'FCL', status: 'Booked' },
    });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('shipping.create_shipment');
    expect(draft.impactScope).toEqual(['shipping', 'orders']);
    expect(draft.irreversible).toBe(true);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.idempotencyKey).toContain('order.ship:O1');
    expect((draft.subOperations[0].after as any).orderId).toBe("O1");
  });

  it('shipment status 缺省 → Booked', () => {
    const draft = buildOrderShipDraft({
      orderId: 'O1',
      shipment: { shipmentNumber: 'SHIP-001', shippingMethod: 'FCL' },
    });
    expect((draft.subOperations[0].after as any).shipmentStatus).toBe("Booked");
  });
});

describe('task order-ship: hash 防篡改', () => {
  it('原始 draft hash 校验通过', () => {
    const draft = buildOrderShipDraft({
      orderId: 'O1',
      shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' },
    });
    expect(verifyOrderShipDraftHash(draft).ok).toBe(true);
  });

  it('篡改 shipmentNumber → hash 不匹配', () => {
    const draft = buildOrderShipDraft({
      orderId: 'O1',
      shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' },
    });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, shipmentNumber: 'HACKED' } }] };
    expect(verifyOrderShipDraftHash(tampered).ok).toBe(false);
  });
});

describe('task order-ship: validateOrderShipDraftSemantics（fail closed）', () => {
  it('空 subOperations → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [], idempotencyKey: 'test' } as any;
    const r = validateOrderShipDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });

  it('缺 orderId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { shipmentNumber: 'S1' } }], idempotencyKey: 'test' } as any;
    const r = validateOrderShipDraftSemantics(draft);
    expect(r.ok).toBe(false);
  });

  it('非法 shipment status → INVALID_SHIPMENT_STATUS', () => {
    const draft = { subOperations: [{ after: { orderId: 'O1', shipmentNumber: 'S1', shippingMethod: 'FCL', shipmentStatus: 'Flying' } }], idempotencyKey: 'test' } as any;
    const r = validateOrderShipDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_SHIPMENT_STATUS');
  });

  it('合法 draft → ok', () => {
    const draft = buildOrderShipDraft({
      orderId: 'O1',
      shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' },
    });
    expect(validateOrderShipDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task order-ship: buildOrderShipError（稳定 error code + userAction）', () => {
  it('13 个 code 均有 userAction', () => {
    const codes: OrderShipErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'ORDER_NOT_FOUND', 'ORDER_TERMINAL', 'INVALID_CURRENT_ORDER_STATUS', 'INVALID_SHIPMENT_STATUS', 'COMMIT_TRANSACTION_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) {
      const e = buildOrderShipError(code, 'test');
      expect(e.code).toBe(code);
      expect(e.userAction.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// commit 集成测试（mock prisma tx）
// ============================================================================

function makeShipTx(opts: {
  order?: any;
  shipmentCreateFail?: boolean;
  syncFail?: boolean;
  linkFail?: boolean;
} = {}) {
  const order = opts.order === undefined ? { id: 'O1', status: 'Confirmed', deletedAt: null } : opts.order;
  const shipmentCreate = opts.shipmentCreateFail
    ? vi.fn().mockRejectedValue(new Error('CREATE_FAIL'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, orderId: data.orderId }));
  const entityRefUpsert = opts.syncFail
    ? vi.fn().mockRejectedValue(new Error('SYNC_FAIL'))
    : vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const orderUpdate = vi.fn().mockResolvedValue({});
  const orderStatusTransitionCreate = vi.fn().mockResolvedValue({});
  const auditLogCreate = vi.fn().mockResolvedValue({});

  const source = legacySourceStorage();
  const tx = {
    ...source.models,
    shipment: { create: shipmentCreate },
    shipmentEvent: { create: vi.fn().mockResolvedValue({}) },
    order: { findUnique: vi.fn().mockResolvedValue(order), update: orderUpdate },
    orderStatusTransition: { create: orderStatusTransitionCreate },
    auditLog: { create: auditLogCreate },
    entityReference: { upsert: entityRefUpsert },
    entityLink: { upsert: entityLinkUpsert },
  };
  Object.assign(tx, { $queryRaw: storageRowLocks({ Order: () => order ? [order] : [],
    OrderLine: () => source.rows.orderLines, ReleaseScope: () => source.rows.releaseScopes }, source.rows.locks) });
  return { tx, shipmentCreate, entityRefUpsert, orderUpdate, orderStatusTransitionCreate, auditLogCreate };
}

describe('task order-ship: commitOrderShip（复用 linkOrderStatusFromShipment + sync）', () => {
  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitOrderShip({ prisma, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = buildOrderShipDraft({ orderId: 'O1', shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' } });
    const tampered = { ...draft, idempotencyKey: 'order.ship:O1:pd:bogus' };
    const prisma = { $transaction: vi.fn() } as any;
    const r = await commitOrderShip({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
  });

  it('成功 commit → committed feedback（复用 linkOrderStatusFromShipment，Order Confirmed→Shipping）', async () => {
    const draft = buildOrderShipDraft({ orderId: 'O1', shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' } });
    const { tx, orderStatusTransitionCreate, orderUpdate, auditLogCreate } = makeShipTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitOrderShip({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.shipmentStatus).toBe('Booked');
      // linkOrderStatusFromShipment: Booked → Order Shipping（写 transition + update）
      expect(orderStatusTransitionCreate).toHaveBeenCalledTimes(1);
      expect(orderUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'Shipping' }) }));
      // audit 事务内
      expect(auditLogCreate).toHaveBeenCalledTimes(1);
    }
  });

  it('shipment Delivered (非法初始状态) → INVALID_SHIPMENT_STATUS（createShipment 拒绝创建终态运单）', async () => {
    const draft = buildOrderShipDraft({ orderId: 'O1', shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Delivered' } });
    const { tx } = makeShipTx();
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitOrderShip({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_SHIPMENT_STATUS');
  });

  it('order 终态 → ORDER_TERMINAL', async () => {
    const draft = buildOrderShipDraft({ orderId: 'O1', shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' } });
    const { tx } = makeShipTx({ order: { id: 'O1', status: 'Delivered', deletedAt: null } });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitOrderShip({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('ORDER_TERMINAL');
  });

  it('sync reject → COMMIT_TRANSACTION_FAILED（不伪成功）', async () => {
    const draft = buildOrderShipDraft({ orderId: 'O1', shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' } });
    const { tx } = makeShipTx({ syncFail: true });
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const r = await commitOrderShip({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });
});
