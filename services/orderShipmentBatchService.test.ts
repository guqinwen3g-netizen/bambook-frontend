import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orderShipmentBatchService } from './orderShipmentBatchService';

vi.mock('./authService', () => ({
  getAuthState: () => ({ isAuthenticated: true, user: { id: 'batch-route-fixture-user', roles: ['manager'], roleIds: [],
    permissions: ['orders:read', 'shipments:read', 'shipments:write'] } }),
  hasPermission: (scope: string) => ['orders:read', 'shipments:read', 'shipments:write'].includes(scope),
}));
// Independently verified source-read seam; original route assertions inspect
// the ensuing business POST, including the unchanged explicit legacy payload.
function withPhysicalContext(fetchMock: (...args: any[]) => any) {
  return async (url: string, init?: RequestInit) => {
    if (String(url).includes('/physical-context')) {
      const parsed = new URL(String(url)), id = parsed.pathname.split('/').at(-2)!;
      return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'legacy', batchId: id, orderId: 'O-1',
        shipmentId: parsed.searchParams.get('shipmentId'), expectedBatchUpdatedAt: '1',
        expectedShipmentUpdatedAt: '1', expectedPhysicalAllocationFingerprint: 'a'.repeat(64) }) };
    }
    return fetchMock(url, init);
  };
}

const ENDPOINT = 'https://test.example.com';
const panelSource = readFileSync(new URL('../components/orders/OrderShipmentBatchPanel.tsx', import.meta.url), 'utf8');
const orderManagerSource = readFileSync(new URL('../components/OrderManager.tsx', import.meta.url), 'utf8');

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => { values.clear(); }),
  };
}

function okFetch(payload: any) {
  return vi.fn(async (..._args: any[]) => ({
    ok: true,
    json: async () => payload,
  }));
}

const BATCH = {
  id: 'OSB__TEST1',
  orderId: 'O-1',
  batchNo: 1,
  plannedRatio: 60,
  amount: 60000,
  currency: 'USD',
  status: 'planned',
  settleStatus: 'unsettled',
  isFinalBatch: false,
  settleProgress: 0,
  outstandingAmount: 60000,
  finalPaymentOverdue: false,
};

const OVERVIEW = {
  ok: true,
  order: { id: 'O-1', poNumber: 'PO-1', customer: 'Peerless', currency: 'USD' },
  orderAmount: 100000,
  batches: [BATCH],
  summary: {
    totalBatches: 1,
    shippedBatches: 0,
    allShipped: false,
    totalPlannedAmount: 60000,
    totalInvoiced: 0,
    totalPaid: 0,
  },
};

describe('orderShipmentBatchService（P0-1 contract）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('listByOrder GET /order-batches?orderId=…（批次全景 + 汇总）', async () => {
    const fetchMock = okFetch(OVERVIEW);
    vi.stubGlobal('fetch', withPhysicalContext(fetchMock));

    const r = await orderShipmentBatchService.listByOrder('O-1', ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/shipping/order-batches?orderId=O-1');
    expect(init?.method).toBeUndefined(); // GET（fetch 缺省）
    expect(r.summary.totalBatches).toBe(1);
    expect(r.orderAmount).toBe(100000);
    expect(r.batches[0].id).toBe('OSB__TEST1');
  });

  it('listOverdueFinal GET /order-batches/overdue-final（尾款到期未结清单）', async () => {
    const fetchMock = okFetch({ ok: true, batches: [{ ...BATCH, isFinalBatch: true, finalPaymentOverdue: true }] });
    vi.stubGlobal('fetch', withPhysicalContext(fetchMock));

    const r = await orderShipmentBatchService.listOverdueFinal(50, ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/shipping/order-batches/overdue-final?limit=50');
    expect(r).toHaveLength(1);
    expect(r[0].finalPaymentOverdue).toBe(true);
  });

  it('createBatch POST /order-batches（占比登记；响应取 batch）', async () => {
    const fetchMock = okFetch({ ok: true, batch: BATCH });
    vi.stubGlobal('fetch', withPhysicalContext(fetchMock));

    const r = await orderShipmentBatchService.createBatch({
      orderId: 'O-1',
      plannedRatio: 60,
      plannedQty: 12000,
      unit: 'Meter',
      isFinalBatch: false,
      finalPaymentDueDays: 30,
      notes: '头批 60%',
    }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/shipping/order-batches');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      orderId: 'O-1',
      plannedRatio: 60,
      plannedQty: 12000,
      unit: 'Meter',
      isFinalBatch: false,
      finalPaymentDueDays: 30,
      notes: '头批 60%',
    });
    expect(r.id).toBe('OSB__TEST1');
  });

  it('cancelBatch PUT status=cancelled（仅 planned→cancelled 语义）', async () => {
    const fetchMock = okFetch({ ok: true, batch: { ...BATCH, status: 'cancelled' } });
    vi.stubGlobal('fetch', withPhysicalContext(fetchMock));

    const r = await orderShipmentBatchService.cancelBatch('OSB__TEST1', ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/shipping/order-batches/OSB__TEST1');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'cancelled' });
    expect(r.status).toBe('cancelled');
  });

  it('markShipped POST mark-shipped（排船回填 + skipGate 豁免）', async () => {
    const fetchMock = okFetch({ ok: true, batch: { ...BATCH, status: 'shipped', shipmentId: 'SHP-1' } });
    vi.stubGlobal('fetch', withPhysicalContext(fetchMock));

    const r = await orderShipmentBatchService.markShipped('OSB__TEST1', { shipmentId: 'SHP-1', skipGate: true }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/shipping/order-batches/OSB__TEST1/mark-shipped');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ shipmentId: 'SHP-1', skipGate: true });
    expect(r.status).toBe('shipped');
  });

  it('recalc POST recalc（结算进度重算）', async () => {
    const fetchMock = okFetch({ ok: true, batch: { ...BATCH, paidAmount: 30000, settleStatus: 'partially_settled' } });
    vi.stubGlobal('fetch', withPhysicalContext(fetchMock));

    const r = await orderShipmentBatchService.recalc('OSB__TEST1', ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/shipping/order-batches/OSB__TEST1/recalc');
    expect(init?.method).toBe('POST');
    expect(r.settleStatus).toBe('partially_settled');
  });

  it('失败响应透传（FINAL_PAYMENT_GATE_BLOCKED → 409 + code）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'FINAL_PAYMENT_GATE_BLOCKED', message: '末批发运门禁：订单累计已收 30000.00 USD，须 ≥ 40000.00 USD' } }),
    }));
    vi.stubGlobal('fetch', withPhysicalContext(fetchMock));

    await expect(orderShipmentBatchService.markShipped('OSB__F', { shipmentId: 'SHP-1' }, ENDPOINT))
      .rejects.toMatchObject({ status: 409, code: 'FINAL_PAYMENT_GATE_BLOCKED' });
  });
});

describe('OrderShipmentBatchPanel P0-1（UI 契约）', () => {
  it('汇总进度条：出运批次进度 + 收款结算进度（bds-progress 族）', () => {
    expect(panelSource).toContain('出运批次进度 SHIPMENT');
    expect(panelSource).toContain('收款结算进度 SETTLEMENT');
    expect(panelSource).toContain('bds-progress');
    expect(panelSource).toContain('已开票');
    expect(panelSource).toContain('已收款');
  });

  it('双正交状态机徽章：出运 planned/shipped/cancelled × 结算 unsettled/partially_settled/settled', () => {
    expect(panelSource).toContain("STATUS_LABELS: Record<string, string> = { planned: '待发运', shipped: '已发运', cancelled: '已取消' }");
    expect(panelSource).toContain('unsettled: \'未结算\'');
    expect(panelSource).toContain('partially_settled: \'部分结算\'');
    expect(panelSource).toContain('settled: \'已结清\'');
    expect(panelSource).toContain('statusBadgeClass(b.status)');
    expect(panelSource).toContain('settleBadgeClass(b.settleStatus)');
  });

  it('批次登记：占比/数量/金额三选一 + 默认非末批、末批主动选择+ 尾款账期', () => {
    expect(panelSource).toContain('登记批次');
    expect(panelSource).toContain('至少填一项');
    expect(panelSource).toContain('末批（尾款锚点）');
    expect(panelSource).toContain('setFormIsFinal(false)');
    expect(panelSource).toContain('onClick={() => setFormIsFinal(true)}');
    expect(panelSource).toContain('isFinalBatch: formIsFinal');
    expect(panelSource).not.toContain('setFormIsFinal(!hasFinal)');
    expect(panelSource).toContain('尾款账期（天，可选）');
    expect(panelSource).toContain('orderShipmentBatchService.createBatch');
  });

  it('发运确认：排船下拉取本订单运单 + 末批门禁 409 就地展示豁免入口（bdsConfirm 留痕）', () => {
    expect(panelSource).toContain('发运确认');
    expect(panelSource).toContain('shipmentService.listShipments');
    expect(panelSource).toContain("e?.code === 'FINAL_PAYMENT_GATE_BLOCKED'");
    expect(panelSource).toContain('豁免门禁并确认发运（留痕审计）');
    expect(panelSource).toContain("skipGate: true");
    expect(panelSource).toContain('orderShipmentBatchService.markShipped');
  });

  it('批次取消（仅 planned，confirm 二次确认）+ 结算重算入口', () => {
    expect(panelSource).toContain('取消批次');
    expect(panelSource).toContain('仅计划中的批次可取消');
    expect(panelSource).toContain('orderShipmentBatchService.cancelBatch');
    expect(panelSource).toContain('orderShipmentBatchService.recalc');
    expect(panelSource).toContain('结算进度重算');
  });

  it('尾款逾期警示（danger 徽章 + 尾款到期日/未收金额）', () => {
    expect(panelSource).toContain('finalPaymentOverdue === true');
    expect(panelSource).toContain('尾款逾期');
    expect(panelSource).toContain('尾款到期');
    expect(panelSource).toContain('outstandingAmount');
  });
});

describe('OrderManager 挂载 P0-1（源码契约）', () => {
  it('出运批次区挂载于订单详情（全订单类型，TestRequestPanel 之后）', () => {
    expect(orderManagerSource).toContain("import { OrderShipmentBatchPanel } from './orders/OrderShipmentBatchPanel'");
    expect(orderManagerSource).toContain('id="order-detail-batches"');
    expect(orderManagerSource).toContain('key={`osb-${selectedOrder.id}`}');
    expect(orderManagerSource).toContain('P0-1 分批出运与尾款结算');
  });
});
