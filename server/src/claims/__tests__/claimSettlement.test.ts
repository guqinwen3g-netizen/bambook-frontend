/**
 * claimCaseService + claimSettlement 单测
 *
 * 口径：`docs/业务口径决策单-2026-09-17.md` **A1 · A1-附 ①②③ · A5 · A7**
 *
 * 承重项：
 *   · A1-附 ③ —— 动货的处置**必须记去向**（不记清 ⇒ 货在账上凭空消失）
 *   · 一期范围 —— Replace/Repair **显式拒绝**（不是静默接受）
 *   · A7 —— **未审批不可执行**
 *   · 收口点 —— Allowance 只开退款单；ReturnRefund **两张单都开**
 *   · A5 —— 有已执行处置的案件**不可撤销**
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  addDisposition,
  cancelClaimCase,
  createClaimCase,
  validateDispositionInput,
  approveDisposition,
} from '../claimCaseService';
import { executeDisposition } from '../claimSettlement';
import { assertClaimDecisionAuthority, buildClaimApprovalPayload, CLAIM_APPROVAL_ACTION, CLAIM_APPROVAL_TARGET } from '../claimApprovalFact';

/** 内存 mock：claimCase / claimDisposition / creditNote / returnReceipt / materialReturn / businessSequence */
function makePrisma() {
  const T: Record<string, any[]> = {
    claimCase: [], claimDisposition: [], creditNote: [], returnReceipt: [], materialReturn: [],
    claimCreditNoteLine: [], creditNoteDocumentVersion: [], creditNoteSettlementEvent: [], creditNoteAllocation: [],
    creditNoteRefundReturn: [], // No actual bank-return fact in these original offset/version fixtures.
    creditNoteRefund: [], // Existing execution/replay fixtures have no cash reservation.
    // ★ A-3 二期：补发复用 Shipment · 返修独立工单
    shipment: [], repairWorkOrder: [], approvalRequest: [], auditLog: [], returnReceiptLine: [],
    warehouse: [{ id: 'WH_1', isActive: true, deletedAt: null }],
    workStation: [{ id: 'WS_1', isActive: true, deletedAt: null }],
    shipmentLine: [], shipmentCarton: [], shipmentCartonItem: [], fabricCustomerCode: [], productAsset: [],
    // Persisted source facts now verified at case creation, independent of names.
    relation: [{ id: 'R1', name: 'ACME', category: 'Customer', deletedAt: null }],
    order: [{ id: 'SO_1', customerRelationId: 'R1', deletedAt: null }],
    invoice: [{ id: 'INV_1', orderId: 'SO_1', customerRelationId: 'R1', type: 'Receivable', deletedAt: null }],
    invoiceOrderAllocation: [],
    // New shipment source/packing reads must observe explicit empty persisted tables.
    shipmentOrderAllocation: [], shipmentProductionAllocation: [], productionBatch: [],
    orderLine: [], releaseScope: [],
  };
  const seqs: Record<string, number> = {};
  /** 极简 where 求值：null 与 undefined 视作相等（否则 `deletedAt: null` 会把行全滤掉） */
  const eq = (a: any, b: any) => (a ?? null) === (b ?? null);
  const matches = (row: any, where: any) => !where || Object.entries(where).every(([k, v]: any) => {
    if (k === 'OR') return v.some((part: any) => matches(row, part));
    if (k === 'detail' && v?.path) return eq(v.path.reduce((current: any, key: string) => current?.[key], row.detail), v.equals);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && 'notIn' in v) return !v.notIn.includes(row[k]);
    if (v && typeof v === 'object' && 'not' in v) return !eq(row[k], v.not);
    return eq(row[k], v);
  });
  const table = (name: string) => ({
    findFirst: vi.fn(async ({ where }: any) => T[name].find(r => matches(r, where)) ?? null),
    findUnique: vi.fn(async ({ where }: any) => T[name].find(r => matches(r, where)) ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => T[name].filter(r => matches(r, where))),
    count: vi.fn(async ({ where }: any = {}) => T[name].filter(r => matches(r, where)).length),
    deleteMany: vi.fn(async ({ where }: any) => { const n = T[name].filter(r => matches(r, where)).length; T[name] = T[name].filter(r => !matches(r, where)); return { count: n }; }),
    create: vi.fn(async ({ data }: any) => { T[name].push(data); return data; }),
    update: vi.fn(async ({ where, data }: any) => {
      const i = T[name].findIndex(r => r.id === where.id);
      // 支持 { increment }
      const merged: any = { ...T[name][i] };
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as any)) {
          merged[k] = new Prisma.Decimal(merged[k] ?? 0).plus((v as any).increment);
        } else merged[k] = v;
      }
      T[name][i] = merged;
      return merged;
    }),
  });
  const dispositionTable = table('claimDisposition');
  const prisma: any = {
    claimCase: table('claimCase'),
    claimDisposition: { ...dispositionTable, updateMany: vi.fn(async ({ where, data }: any) => {
      const rows = T.claimDisposition.filter(r => matches(r, where));
      for (const row of rows) await dispositionTable.update({ where: { id: row.id }, data });
      return { count: rows.length };
    }) },
    creditNote: table('creditNote'),
    claimCreditNoteLine: table('claimCreditNoteLine'), creditNoteDocumentVersion: table('creditNoteDocumentVersion'),
    creditNoteSettlementEvent: table('creditNoteSettlementEvent'), creditNoteAllocation: table('creditNoteAllocation'),
    creditNoteRefund: table('creditNoteRefund'),
    creditNoteRefundReturn: table('creditNoteRefundReturn'),
    returnReceipt: table('returnReceipt'),
    returnReceiptLine: table('returnReceiptLine'),
    warehouse: table('warehouse'),
    workStation: table('workStation'),
    materialReturn: table('materialReturn'),
    shipment: table('shipment'),
    shipmentLine: table('shipmentLine'), shipmentCarton: table('shipmentCarton'), shipmentCartonItem: table('shipmentCartonItem'),
    fabricCustomerCode: table('fabricCustomerCode'), productAsset: table('productAsset'),
    repairWorkOrder: table('repairWorkOrder'),
    approvalRequest: table('approvalRequest'),
    auditLog: table('auditLog'),
    relation: table('relation'), order: table('order'), invoice: table('invoice'), invoiceOrderAllocation: table('invoiceOrderAllocation'),
    businessSequence: {
      upsert: vi.fn(async ({ where }: any) => { seqs[where.id] = (seqs[where.id] ?? 0) + 1; return { id: where.id, seq: seqs[where.id] }; }),
      update: vi.fn(async ({ where, data }: any) => { seqs[where.id] = (seqs[where.id] ?? 0) + (data.seq?.increment ?? 0); return { id: where.id, seq: seqs[where.id] }; }),
      findUnique: vi.fn(async ({ where }: any) => (seqs[where.id] != null ? { id: where.id, seq: seqs[where.id] } : null)),
    },
    shipmentOrderAllocation: table('shipmentOrderAllocation'), shipmentProductionAllocation: table('shipmentProductionAllocation'),
    productionBatch: table('productionBatch'), orderLine: table('orderLine'), releaseScope: table('releaseScope'),
    $queryRaw: vi.fn(async (query: any) => {
      const sql = query.strings.join(' ');
      if (!/FROM "Shipment"/.test(sql) || !/FOR UPDATE/.test(sql)) throw new Error('Unexpected tagged source lock in claim fixture');
      return T.shipment.filter(row => row.id === query.values[0]).map(row => ({ id: row.id }));
    }),
    $queryRawUnsafe: vi.fn(async () => []),
    // Storage rollback model only: no real PostgreSQL locking/concurrency proof.
    $transaction: vi.fn(async (fn: any) => {
      const before = Object.fromEntries(Object.entries(T).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
      const sequences = { ...seqs };
      try { return await fn(prisma); } catch (error) {
        for (const name of Object.keys(T)) T[name] = before[name];
        for (const name of Object.keys(seqs)) delete seqs[name];
        Object.assign(seqs, sequences);
        throw error;
      }
    }),
    _t: T,
  };
  return prisma;
}

/** Explicit committed leader decision fixture. This is not a company-account or kernel test. */
function recordApprovedFact(prisma: any, disposition: any) {
  const claimCase = prisma._t.claimCase.find((row: any) => row.id === disposition.claimCaseId);
  const payload = buildClaimApprovalPayload(disposition, claimCase);
  const id = `APR_${disposition.id}`;
  const decidedAt = new Date('2026-10-01T01:00:00Z');
  prisma._t.approvalRequest.push({ id, requesterId: 'u1', reviewerId: 'boss', status: 'approved',
    actionType: CLAIM_APPROVAL_ACTION, targetType: CLAIM_APPROVAL_TARGET, targetId: disposition.id,
    payload, decidedAt, createdAt: new Date('2026-10-01T00:00:00Z') });
  prisma._t.auditLog.push({ id: `AUDIT_${id}`, actorId: 'boss', targetType: 'ApprovalRequest', targetId: id,
    detail: { decisionActorAuthority: { userId: 'boss', roleIds: ['role-admin'], authorizationLoaded: true },
      approvalDecisionFact: { schemaVersion: 1, status: 'approved', actionType: CLAIM_APPROVAL_ACTION,
        targetType: CLAIM_APPROVAL_TARGET, targetId: disposition.id, contentFingerprint: payload.contentFingerprint,
        decisionActorId: 'boss', decidedAt: decidedAt.toISOString() } } });
}

describe('★ 口径 A1：处置输入校验（四种处置 × 动不动钱货）', () => {
  it('Allowance（只动钱）：金额 + 币种必填；**不需要**数量/去向', () => {
    expect(validateDispositionInput({ kind: 'Allowance', amount: 500, currency: 'USD' }).ok).toBe(true);
    expect(validateDispositionInput({ kind: 'Allowance', currency: 'USD' }).error?.code).toBe('VALIDATION_FAILED');
    expect(validateDispositionInput({ kind: 'Allowance', amount: 500 }).error?.code).toBe('VALIDATION_FAILED');
  });

  it('★ 承重 A1-附 ③：ReturnRefund 缺**退货去向** → 拒绝（不记清去向，货会在账上凭空消失）', () => {
    const base = { kind: 'ReturnRefund', amount: 500, currency: 'USD', quantity: 30, unit: 'PCS' };
    const r = validateDispositionInput(base);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('VALIDATION_FAILED');
    expect(r.error!.message).toContain('退货去向');

    expect(validateDispositionInput({ ...base, returnDisposition: 'Scrap' }).ok).toBe(true);
    expect(validateDispositionInput({ ...base, returnDisposition: '乱填' }).ok).toBe(false);
  });

  it('★ A-3 二期：**四种全部支持**（原先「一期只支持两种」的限制已解除）', () => {
    // 折让 / 退货退款
    expect(validateDispositionInput({ kind: 'Allowance', amount: 500, currency: 'USD' }).ok).toBe(true);
    expect(validateDispositionInput({ kind: 'ReturnRefund', amount: 500, currency: 'USD', quantity: 30, unit: 'PCS', returnDisposition: 'Scrap' }).ok).toBe(true);
    // ★ 二期新增：换货补发 / 返修 —— 同样「只动货」，故同样要求 数量 + 单位 + 去向
    expect(validateDispositionInput({ kind: 'Replace', quantity: 30, unit: 'PCS', returnDisposition: 'Replace' }).ok).toBe(true);
    expect(validateDispositionInput({ kind: 'Repair', quantity: 30, unit: 'PCS', returnDisposition: 'Repair' }).ok).toBe(true);
    // 但**动货的三项必填**对它们同样成立（缺去向仍拒）
    expect(validateDispositionInput({ kind: 'Repair', quantity: 30, unit: 'PCS' }).error?.code).toBe('VALIDATION_FAILED');
  });

  it('非法 kind → 拒绝', () => {
    expect(validateDispositionInput({ kind: 'Nope' }).error?.code).toBe('VALIDATION_FAILED');
  });

  it('★ 口径 A6：0 元 / 0 数量 → 拒绝', () => {
    expect(validateDispositionInput({ kind: 'Allowance', amount: 0, currency: 'USD' }).ok).toBe(false);
    expect(validateDispositionInput({ kind: 'ReturnRefund', amount: 1, currency: 'USD', quantity: 0, unit: 'PCS', returnDisposition: 'Scrap' }).ok).toBe(false);
  });
});

describe('★ 案件登记与处置追加', () => {
  it('登记案件：取号 CLM + 状态 Registered', async () => {
    const prisma = makePrisma();
    const r = await createClaimCase(prisma, { problemDesc: '色差严重', customerName: 'ACME' }, 'u1');
    expect(r.ok).toBe(true);
    expect(r.data!.claimCase.status).toBe('Registered');
    expect(r.data!.claimCase.caseNumber).toMatch(/^CLM-\d{4}-\d{4}$/);
  });

  it('问题描述必填', async () => {
    const prisma = makePrisma();
    expect((await createClaimCase(prisma, { problemDesc: '  ' }, 'u1')).error?.code).toBe('VALIDATION_FAILED');
  });

  it('加处置后案件进入 Processing；处置初始 Draft', async () => {
    const prisma = makePrisma();
    const c = (await createClaimCase(prisma, { problemDesc: '短装' }, 'u1')).data!.claimCase;
    const r = await addDisposition(prisma, c.id, { kind: 'Allowance', amount: 300, currency: 'USD' }, 'u1');
    expect(r.ok).toBe(true);
    expect(r.data!.disposition.status).toBe('Draft');
    expect(prisma._t.claimCase[0].status).toBe('Processing');
  });

  it('案件不存在 / 已撤销 → 不可加处置', async () => {
    const prisma = makePrisma();
    expect((await addDisposition(prisma, 'nope', { kind: 'Allowance', amount: 1, currency: 'USD' }, 'u1')).error?.code).toBe('NOT_FOUND');
    prisma._t.claimCase.push({ id: 'C1', status: 'Cancelled', deletedAt: null });
    expect((await addDisposition(prisma, 'C1', { kind: 'Allowance', amount: 1, currency: 'USD' }, 'u1')).error?.code).toBe('INVALID_STATE');
  });
});

describe('★★ 收口点 executeDisposition（钱/货两条腿的唯一入口）', () => {
  async function setup(kindInput: any) {
    const prisma = makePrisma();
    const c = (await createClaimCase(prisma, { problemDesc: 'x', customerRelationId: 'R1', customerName: 'ACME' }, 'u1')).data!.claimCase;
    const d = (await addDisposition(prisma, c.id, { materialCode: 'SKU_1', ...kindInput }, 'u1')).data!.disposition;
    return { prisma, c, d };
  }

  it('★ 承重 A7：**未审批不可执行**', async () => {
    const { prisma, d } = await setup({ kind: 'Allowance', amount: 500, currency: 'USD' });
    const r = await executeDisposition(prisma, d.id, 'u1');
    expect(r.error?.code).toBe('INVALID_STATE');
    expect(r.error!.message).toContain('先审批');
  });

  it('★ 承重：Allowance 只开**退款单**（不开退货入库单）', async () => {
    const { prisma, c, d } = await setup({ kind: 'Allowance', amount: 500, currency: 'USD' });
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'boss');
    const r = await executeDisposition(prisma, d.id, 'u1');
    expect(r.ok).toBe(true);
    expect(r.data!.creditNote).toBeTruthy();
    expect(r.data!.returnReceipt).toBeUndefined();
    expect(prisma._t.creditNote).toHaveLength(1);
    expect(prisma._t.returnReceipt).toHaveLength(0);
    // 回填
    expect(prisma._t.claimDisposition[0].creditNoteId).toBe(r.data!.creditNote.id);
    expect(prisma._t.claimDisposition[0].status).toBe('Executed');
    // 案件汇总
    expect(String(prisma._t.claimCase[0].totalCreditAmount)).toBe('500');
    expect(prisma._t.claimCase[0].status).toBe('Handled');
    expect(c.id).toBe(prisma._t.claimCase[0].id);
  });

  it('★★ 承重：ReturnRefund **两张单都开**（钱 + 货）', async () => {
    const { prisma, d } = await setup({
      kind: 'ReturnRefund', amount: 800, currency: 'USD', quantity: 40, unit: 'PCS', returnDisposition: 'Scrap',
    });
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'boss');
    const r = await executeDisposition(prisma, d.id, 'u1', { warehouseId: 'WH_1' });
    expect(r.ok).toBe(true);
    expect(r.data!.creditNote).toBeTruthy();
    expect(r.data!.returnReceipt).toBeTruthy();
    expect(prisma._t.returnReceipt[0].disposition).toBe('Scrap');
    expect(prisma._t.returnReceipt[0].warehouseId).toBe('WH_1');
    expect(String(prisma._t.claimCase[0].totalReturnQty)).toBe('40');
  });

  it('★ 动货处置缺 warehouseId → 拒绝（不能凭空入一个仓）', async () => {
    const { prisma, d } = await setup({
      kind: 'ReturnRefund', amount: 800, currency: 'USD', quantity: 40, unit: 'PCS', returnDisposition: 'Repair',
    });
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'boss');
    expect((await executeDisposition(prisma, d.id, 'u1')).error?.code).toBe('VALIDATION_FAILED');
  });

  it('已执行 / 非 Approved → 不可重复执行', async () => {
    const { prisma, d } = await setup({ kind: 'Allowance', amount: 500, currency: 'USD' });
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'boss');
    await executeDisposition(prisma, d.id, 'u1');
    expect((await executeDisposition(prisma, d.id, 'u1')).error?.code).toBe('INVALID_STATE');
  });
});

describe('★ 口径 A5：撤销案件（能撤销 + 留痕）', () => {
  it('★ 承重：未执行的案件可撤销，且处置一并作废 + 留痕', async () => {
    const prisma = makePrisma();
    const c = (await createClaimCase(prisma, { problemDesc: 'x' }, 'u1')).data!.claimCase;
    await addDisposition(prisma, c.id, { kind: 'Allowance', amount: 100, currency: 'USD' }, 'u1');

    const r = await cancelClaimCase(prisma, c.id, '客户撤诉', 'u1');
    expect(r.ok).toBe(true);
    expect(r.data!.cancelledDispositions).toBe(1);
    expect(prisma._t.claimCase[0].status).toBe('Cancelled');
    expect(prisma._t.claimDisposition[0].status).toBe('Cancelled');
    expect(prisma._t.claimDisposition[0].cancelReason).toBe('客户撤诉');
  });

  it('★ 承重：**有已执行处置的案件不可撤销**（保留已执行处置和原产出）', async () => {
    const prisma = makePrisma();
    const c = (await createClaimCase(prisma, { problemDesc: 'x' }, 'u1')).data!.claimCase;
    const d = (await addDisposition(prisma, c.id, { kind: 'Allowance', amount: 100, currency: 'USD' }, 'u1')).data!.disposition;
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'boss');
    await executeDisposition(prisma, d.id, 'u1');

    const r = await cancelClaimCase(prisma, c.id, '想撤', 'u1');
    expect(r.error?.code).toBe('INVALID_STATE');
    expect(r.error!.message).toContain('不能撤销');
  });

  it('撤销必须填理由', async () => {
    const prisma = makePrisma();
    const c = (await createClaimCase(prisma, { problemDesc: 'x' }, 'u1')).data!.claimCase;
    expect((await cancelClaimCase(prisma, c.id, '  ', 'u1')).error?.code).toBe('VALIDATION_FAILED');
  });
});

/**
 * ★★ A-3 二期（2026-09-17）：换货补发 / 返修
 *
 * 行业依据：
 *   · **换货补发** = 再发一次货 ⇒ **复用 `Shipment`**（物流/报关/单证必须同一套流程）；
 *     `notes` 打来源标记（否则在运单列表里无法区分）；**不走钱**（绝不触碰发票/收款）
 *   · **返修** = 车间动作 ⇒ **独立返修工单**（Odoo `repair.order` / SAP Rework Order 同构），
 *     **复用 `WorkStation` 工位**，**不套生产订单**（无 BOM 展开；成本须单独归集）
 */
describe('★★ A-3 二期：换货补发 → 补发出运单 · 返修 → 返修工单', () => {
  async function setup(kindInput: any) {
    const prisma = makePrisma();
    const c = (await createClaimCase(prisma, { problemDesc: 'x', customerName: 'ACME' }, 'u1')).data!.claimCase;
    const d = (await addDisposition(prisma, c.id, { materialCode: 'SKU_1', ...kindInput }, 'u1')).data!.disposition;
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'boss');
    return { prisma, c, d };
  }

  it('★ 换货补发 → 建**补发出运单**（复用 Shipment），且**不走钱**（不开退款单）', async () => {
    const { prisma, d } = await setup({ kind: 'Replace', quantity: 40, unit: 'PCS', returnDisposition: 'Replace' });
    const r = await executeDisposition(prisma, d.id, 'u1', { warehouseId: 'WH_1' });
    expect(r.ok).toBe(true);
    expect(r.data!.replacementShipment).toBeTruthy();
    expect(r.data!.returnReceipt.lines[0]).toMatchObject({ claimDispositionId: d.id, materialCode: 'SKU_1', unit: 'PCS' });
    expect(String(r.data!.returnReceipt.lines[0].expectedQuantity)).toBe('40');
    expect(r.data!.replacementShipment.lines[0]).toMatchObject({ productCode: 'SKU_1', unit: 'PCS', orderLineId: null });
    expect(String(r.data!.replacementShipment.lines[0].quantity)).toBe('40');
    // ★ 不走钱：不得产生退款单
    expect(r.data!.creditNote).toBeUndefined();
    expect(prisma._t.creditNote).toHaveLength(0);
    // ★ 运单必须带**来源标记**（否则与正常运单无法区分）
    expect(String(prisma._t.shipment[0].notes)).toContain('[补发]');
    // ★ 客诉侧建立双向可查链接
    expect(prisma._t.claimDisposition[0].replacementShipmentId).toBe(r.data!.replacementShipment.id);
    expect(prisma._t.claimDisposition[0].status).toBe('Executed');
  });

  it('★ 返修 → 建**返修工单**（独立表 + 复用工位），且不走钱', async () => {
    const { prisma, d } = await setup({ kind: 'Repair', quantity: 20, unit: 'PCS', returnDisposition: 'Repair' });
    const r = await executeDisposition(prisma, d.id, 'u1', { warehouseId: 'WH_1', workStationId: 'WS_1' });
    expect(r.ok).toBe(true);
    expect(r.data!.repairWorkOrder).toBeTruthy();
    expect(r.data!.creditNote).toBeUndefined();
    expect(prisma._t.repairWorkOrder[0].workStationId).toBe('WS_1');
    expect(prisma._t.repairWorkOrder[0].status).toBe('Draft');
    expect(prisma._t.claimDisposition[0].repairWorkOrderId).toBe(r.data!.repairWorkOrder.id);
  });

  it('★ 返修缺工位 → 拒绝（没有工位就无法派活）', async () => {
    const { prisma, d } = await setup({ kind: 'Repair', quantity: 20, unit: 'PCS', returnDisposition: 'Repair' });
    const r = await executeDisposition(prisma, d.id, 'u1', { warehouseId: 'WH_1' });
    expect(r.error?.code).toBe('VALIDATION_FAILED');
    expect(r.error!.message).toContain('工位');
  });

  it('★ 换货补发**不需要**仓库（与退货退款的要求不同）', async () => {
    // Historical title retained for traceability. A1-附② + W3 now require a real return warehouse for all goods.
    const { prisma, d } = await setup({ kind: 'Replace', quantity: 5, unit: 'PCS', returnDisposition: 'Replace' });
    const r = await executeDisposition(prisma, d.id, 'u1'); // 不传 warehouseId
    expect(r.error?.code).toBe('VALIDATION_FAILED');
    expect(r.error?.message).toContain('仓库');
    expect(prisma._t.shipment).toHaveLength(0);
  });
});

describe('W3 共案退货明细与真实补发 SKU（存储替身，不证明真实 PG 锁）', () => {
  async function setup() {
    const prisma = makePrisma();
    const c = (await createClaimCase(prisma, { problemDesc: '两批退货', customerRelationId: 'R1', customerName: 'ACME' }, 'u1')).data!.claimCase;
    async function approved(input: any) {
      const d = (await addDisposition(prisma, c.id, { materialCode: 'SKU_1', unit: 'PCS', quantity: 10, ...input }, 'u1')).data!.disposition;
      recordApprovedFact(prisma, d);
      expect((await approveDisposition(prisma, d.id, 'boss')).ok).toBe(true);
      return d;
    }
    return { prisma, c, approved };
  }

  it('不同处置同案单仓只追加一张退货单，行锚点和已批准数量独立保留', async () => {
    const { prisma, approved } = await setup();
    const a = await approved({ kind: 'ReturnRefund', amount: 100, currency: 'USD', returnDisposition: 'Scrap' });
    const b = await approved({ kind: 'Repair', quantity: 5, returnDisposition: 'Repair' });
    const one = await executeDisposition(prisma, a.id, 'u1', { warehouseId: 'WH_1' });
    const two = await executeDisposition(prisma, b.id, 'u1', { warehouseId: 'WH_1', workStationId: 'WS_1' });
    expect(one.ok).toBe(true); expect(two.ok).toBe(true);
    expect(one.data!.returnReceipt.id).toBe(two.data!.returnReceipt.id);
    expect(prisma._t.returnReceipt).toHaveLength(1);
    expect(two.data!.returnReceipt.disposition).toBe('Mixed');
    expect(two.data!.returnReceipt.lines.map((row: any) => [row.claimDispositionId, String(row.expectedQuantity), row.disposition]))
      .toEqual([[a.id, '10', 'Scrap'], [b.id, '5', 'Repair']]);
    expect(String(prisma._t.claimCase[0].totalReturnQty)).toBe('15');
  });

  it('已收明细追加新批准行保留实收历史，header重算为部分收货而非全部收完', async () => {
    const { prisma, approved } = await setup();
    const a = await approved({ kind: 'Replace', returnDisposition: 'Replace' });
    await executeDisposition(prisma, a.id, 'u1', { warehouseId: 'WH_1' });
    prisma._t.returnReceiptLine[0].receivedQuantity = new Prisma.Decimal(10);
    prisma._t.returnReceiptLine[0].status = 'Received';
    prisma._t.returnReceipt[0].status = 'Received';
    prisma._t.returnReceipt[0].stockMovementId = 'SM_EXISTING';
    const b = await approved({ kind: 'Replace', quantity: 7, returnDisposition: 'Replace' });
    const r = await executeDisposition(prisma, b.id, 'u1', { warehouseId: 'WH_1' });
    expect(r.ok).toBe(true);
    expect(r.data!.returnReceipt.status).toBe('PartiallyReceived');
    expect(r.data!.returnReceipt.stockMovementId).toBe('SM_EXISTING');
    expect(String(prisma._t.returnReceiptLine[0].receivedQuantity)).toBe('10');
    expect(String(prisma._t.returnReceiptLine[1].receivedQuantity)).toBe('0');
  });

  it('仓库冲突完整回滚第二笔钱货，不改原退货仓和已收行', async () => {
    const { prisma, approved } = await setup();
    const a = await approved({ kind: 'Repair', returnDisposition: 'Repair' });
    await executeDisposition(prisma, a.id, 'u1', { warehouseId: 'WH_1', workStationId: 'WS_1' });
    prisma._t.warehouse.push({ id: 'WH_2', isActive: true, deletedAt: null });
    const b = await approved({ kind: 'ReturnRefund', amount: 300, currency: 'USD', returnDisposition: 'Scrap' });
    const r = await executeDisposition(prisma, b.id, 'u1', { warehouseId: 'WH_2' });
    expect(r.error?.code).toBe('INVALID_STATE');
    expect(r.error?.message).toContain('第二个仓库');
    expect(prisma._t.creditNote).toHaveLength(0);
    expect(prisma._t.returnReceiptLine).toHaveLength(1);
    expect(prisma._t.returnReceipt[0].warehouseId).toBe('WH_1');
    expect(prisma._t.claimDisposition.find((row: any) => row.id === b.id).status).toBe('Approved');
  });

  it.each([1, 2])('历史 %i 张无明细退货单拒继续，不能自动补出合法库存事实', async (count) => {
    const { prisma, c, approved } = await setup();
    const d = await approved({ kind: 'ReturnRefund', amount: 300, currency: 'USD', returnDisposition: 'Scrap' });
    for (let i = 0; i < count; i++) prisma._t.returnReceipt.push({ id: `OLD_${i}`, claimCaseId: c.id, warehouseId: 'WH_1', status: 'Draft', deletedAt: null });
    expect((await executeDisposition(prisma, d.id, 'u1', { warehouseId: 'WH_1' })).error?.code).toBe('INVALID_STATE');
    expect(prisma._t.returnReceipt).toHaveLength(count);
    expect(prisma._t.returnReceiptLine).toHaveLength(0);
    expect(prisma._t.creditNote).toHaveLength(0);
  });

  it('补发真实packing失败完整回滚运单、退货明细、处置和汇总', async () => {
    const { prisma, approved } = await setup();
    const d = await approved({ kind: 'Replace', returnDisposition: 'Replace' });
    const fault = new Error('packing-write-failure');
    prisma.shipmentLine.create.mockRejectedValueOnce(fault);
    await expect(executeDisposition(prisma, d.id, 'u1', { warehouseId: 'WH_1' })).rejects.toBe(fault);
    expect(prisma._t.shipment).toHaveLength(0); expect(prisma._t.returnReceipt).toHaveLength(0);
    expect(prisma._t.returnReceiptLine).toHaveLength(0); expect(prisma._t.claimDisposition[0].status).toBe('Approved');
    expect(prisma._t.claimCase[0].totalReturnQty).toBeUndefined();
  });

  it('货物幂等回读必须有真实批准行，篡改补发数量后拒虚假成功', async () => {
    const { prisma, approved } = await setup();
    const d = await approved({ kind: 'Replace', returnDisposition: 'Replace' });
    const opts = { warehouseId: 'WH_1', clientRequestId: 'goods-r1' };
    const one = await executeDisposition(prisma, d.id, 'u1', opts);
    const two = await executeDisposition(prisma, d.id, 'u1', opts);
    expect(one.ok).toBe(true); expect(two.ok).toBe(true);
    expect(two.data!.replacementShipment.id).toBe(one.data!.replacementShipment.id);
    expect(prisma._t.shipmentLine).toHaveLength(1);
    prisma._t.shipmentLine[0].quantity = new Prisma.Decimal(9);
    expect((await executeDisposition(prisma, d.id, 'u1', opts)).error?.code).toBe('INVALID_STATE');
    expect(prisma._t.returnReceiptLine).toHaveLength(1);
  });

  it.each(['material', 'warehouse', 'station'])('真实资源 %s 缺失或停用不提交任何产出', async (resource) => {
    const { prisma, approved } = await setup();
    const d = await approved({ kind: 'Repair', materialCode: resource === 'material' ? null : 'SKU_1', returnDisposition: 'Repair' });
    if (resource === 'warehouse') prisma._t.warehouse[0].isActive = false;
    if (resource === 'station') prisma._t.workStation[0].isActive = false;
    expect((await executeDisposition(prisma, d.id, 'u1', { warehouseId: 'WH_1', workStationId: 'WS_1' })).error?.code).toBe('INVALID_STATE');
    for (const model of ['creditNote', 'returnReceipt', 'returnReceiptLine', 'shipment', 'repairWorkOrder']) expect(prisma._t[model]).toHaveLength(0);
    expect(prisma._t.claimDisposition[0].status).toBe('Approved');
  });
});

describe('索赔批准事实与事务边界（存储替身；真 PG 并发/回滚由独立探针验证）', () => {
  async function setup(input: any = { kind: 'Allowance', amount: 500, currency: 'USD' }) {
    const prisma = makePrisma();
    const c = (await createClaimCase(prisma, { problemDesc: '色差', customerName: 'ACME', sourceInvoiceId: 'INV_1', sourceOrderId: 'SO_1' }, 'u1')).data!.claimCase;
    const d = (await addDisposition(prisma, c.id, { materialCode: 'SKU_1', ...input }, 'u1')).data!.disposition;
    return { prisma, c, d };
  }

  it('无内核事实不能直接把 Draft 批成 Approved', async () => {
    const { prisma, d } = await setup();
    expect((await approveDisposition(prisma, d.id, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._t.claimDisposition[0].status).toBe('Draft');
    expect(prisma._t.auditLog).toHaveLength(0);
  });

  it('完整快照独立检查金额、数量、单位、物料、币种、去向、来源内容；状态汇总不变更版本', async () => {
    const { c, d } = await setup({ kind: 'ReturnRefund', amount: '500.25', currency: 'USD', quantity: '20.5', unit: 'PCS', materialCode: 'MAT_1', returnDisposition: 'Scrap', notes: '原因' });
    const payload = buildClaimApprovalPayload(d, c);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.content.disposition).toMatchObject({ amount: '500.25', currency: 'USD', quantity: '20.5', unit: 'PCS', materialCode: 'MAT_1', returnDisposition: 'Scrap', notes: '原因' });
    expect(payload.content.claimCase).toMatchObject({ sourceInvoiceId: 'INV_1', sourceOrderId: 'SO_1', problemDesc: '色差', reportedBy: 'u1' });
    expect(buildClaimApprovalPayload({ ...d, status: 'Approved', updatedAt: BigInt(999) }, { ...c, status: 'Handled', totalCreditAmount: 99, updatedAt: BigInt(999) }).contentFingerprint).toBe(payload.contentFingerprint);
    expect(buildClaimApprovalPayload({ ...d, unit: 'M' }, c).contentFingerprint).not.toBe(payload.contentFingerprint);
    expect(buildClaimApprovalPayload(d, { ...c, sourceInvoiceId: 'INV_2' }).contentFingerprint).not.toBe(payload.contentFingerprint);
  });

  it.each(['actionType', 'targetType', 'targetId', 'schemaVersion', 'materialCode', 'unit', 'quantity', 'sourceInvoiceId', 'decisionAudit'])('%s 错配/缺失不能消费批准', async field => {
    const { prisma, d } = await setup({ kind: 'ReturnRefund', amount: 500, currency: 'USD', quantity: 20, unit: 'PCS', materialCode: 'MAT_1', returnDisposition: 'Scrap' });
    recordApprovedFact(prisma, d);
    const approval = prisma._t.approvalRequest[0];
    if (['actionType', 'targetType', 'targetId'].includes(field)) approval[field] = 'wrong';
    else if (field === 'schemaVersion') approval.payload.schemaVersion = 0;
    else if (field === 'sourceInvoiceId') prisma._t.claimCase[0].sourceInvoiceId = 'INV_2';
    else if (field === 'decisionAudit') prisma._t.auditLog = [];
    else prisma._t.claimDisposition[0][field] = field === 'quantity' ? new Prisma.Decimal(21) : 'changed';
    expect((await approveDisposition(prisma, d.id, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._t.claimDisposition[0].status).toBe('Draft');
    expect(prisma._t.creditNote).toHaveLength(0);
  });

  it('旧 Approved 且只有旧六字段 payload 不产生任何钱货单据', async () => {
    const { prisma, d } = await setup();
    recordApprovedFact(prisma, d);
    prisma._t.approvalRequest[0].payload = { claimCaseId: d.claimCaseId, kind: d.kind, amount: '500', currency: 'USD', quantity: null, returnDisposition: null };
    Object.assign(prisma._t.claimDisposition[0], { status: 'Approved', approverId: 'boss', approvedAt: '2026-10-01' });
    expect((await executeDisposition(prisma, d.id, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._t.creditNote).toHaveLength(0);
    expect(prisma._t.claimCase[0].totalCreditAmount).toBeUndefined();
  });

  it('推进者不冒充实际领导；重复 hook 保留同一批准事实', async () => {
    const { prisma, d } = await setup();
    recordApprovedFact(prisma, d);
    const advanced = await approveDisposition(prisma, d.id, 'u1');
    expect(advanced.data!.disposition.approverId).toBe('boss');
    expect(prisma._t.auditLog.find((row: any) => row.action === 'advance-approved')).toMatchObject({ actorId: 'u1', detail: { after: { decisionActorId: 'boss' } } });
    const before = prisma._t.auditLog.length;
    expect((await approveDisposition(prisma, d.id, 'u1')).ok).toBe(true);
    expect(prisma._t.auditLog).toHaveLength(before);
  });

  it('未决更新不能恢复旧已批准内容', async () => {
    const { prisma, d } = await setup();
    recordApprovedFact(prisma, d);
    prisma._t.approvalRequest.push({ ...prisma._t.approvalRequest[0], id: 'PENDING_NEW', status: 'pending', createdAt: new Date('2026-10-02') });
    expect((await approveDisposition(prisma, d.id, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._t.claimDisposition[0].status).toBe('Draft');
  });

  it('决议授权读取当前真实 ADMIN roleId；JWT/自定义 role name/委派主管不足', async () => {
    const { prisma, d } = await setup();
    const approval = { actionType: CLAIM_APPROVAL_ACTION, targetType: CLAIM_APPROVAL_TARGET, targetId: d.id, payload: buildClaimApprovalPayload(d, prisma._t.claimCase[0]) };
    prisma.userAccount = { findFirst: vi.fn(async () => ({ id: 'manager' })) };
    prisma.userRole = { findMany: vi.fn(async () => [{ roleId: 'role-sales-manager' }]) };
    await expect(assertClaimDecisionAuthority(prisma, approval, { userId: 'manager' }, 'normal')).rejects.toMatchObject({ code: 'CLAIM_LEADER_REQUIRED', statusCode: 403 });
    prisma.userRole.findMany.mockResolvedValue([{ roleId: 'role-admin' }]);
    expect(await assertClaimDecisionAuthority(prisma, approval, { userId: 'leader' }, 'normal')).toMatchObject({ userId: 'leader', roleIds: ['role-admin'], authorizationLoaded: true });
  });

  it('缺仓在钱腿写入前拒绝，不遗留 CN', async () => {
    const { prisma, d } = await setup({ kind: 'ReturnRefund', amount: 500, currency: 'USD', quantity: 20, unit: 'PCS', returnDisposition: 'Scrap' });
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'u1');
    expect((await executeDisposition(prisma, d.id, 'u1')).error?.code).toBe('VALIDATION_FAILED');
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
    expect(prisma._t.creditNote).toHaveLength(0);
    expect(prisma._t.claimDisposition[0].status).toBe('Approved');
  });

  it.each([
    [{ kind: 'Allowance', amount: 500, currency: 'USD' }, {}, 'creditNote'],
    [{ kind: 'ReturnRefund', amount: 500, currency: 'USD', quantity: 20, unit: 'PCS', returnDisposition: 'Scrap' }, { warehouseId: 'WH_1' }, 'returnReceipt'],
    [{ kind: 'Replace', quantity: 20, unit: 'PCS', returnDisposition: 'Replace' }, { warehouseId: 'WH_1' }, 'shipment'],
    [{ kind: 'Repair', quantity: 20, unit: 'PCS', returnDisposition: 'Repair' }, { warehouseId: 'WH_1', workStationId: 'WS_1' }, 'repairWorkOrder'],
  ])('四类产出 %j 中途异常向外抛；存储、汇总和状态整体回滚，顺序重试仅一套产出', async (input, options, model) => {
    const { prisma, d } = await setup(input);
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'u1');
    const original = prisma[model as string].create;
    const fault = Object.assign(new Error('injected-output-failure'), { code: 'P2003' });
    prisma[model as string].create = vi.fn(async (args: any) => { await original(args); throw fault; });
    await expect(executeDisposition(prisma, d.id, 'u1', options)).rejects.toBe(fault);
    for (const name of ['creditNote', 'returnReceipt', 'returnReceiptLine', 'shipment', 'shipmentLine', 'repairWorkOrder']) expect(prisma._t[name]).toHaveLength(0);
    expect(prisma._t.claimDisposition[0].status).toBe('Approved');
    expect(prisma._t.claimCase[0].totalCreditAmount).toBeUndefined();
    expect(prisma._t.claimCase[0].totalReturnQty).toBeUndefined();
    prisma[model as string].create = original;
    expect((await executeDisposition(prisma, d.id, 'u1', options)).ok).toBe(true);
    expect(prisma._t[model as string]).toHaveLength(1);
  });

  it('必需执行审计失败回滚已经写入的钱腿与案件汇总', async () => {
    const { prisma, d } = await setup();
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'u1');
    const fault = new Error('audit-failed');
    const originalAudit = prisma.auditLog.create;
    prisma.auditLog.create = vi.fn(async (args: any) => {
      if (args.data.action === 'execute') throw fault;
      return originalAudit(args);
    });
    await expect(executeDisposition(prisma, d.id, 'u1')).rejects.toBe(fault);
    expect(prisma._t.creditNote).toHaveLength(0);
    expect(prisma._t.claimDisposition[0].status).toBe('Approved');
    expect(prisma._t.claimCase[0].totalCreditAmount).toBeUndefined();
    expect(prisma._t.auditLog.filter((row: any) => row.action === 'execute')).toHaveLength(0);
  });

  it('所有钱货产出共用一笔调用者事务，不嵌套创建事务', async () => {
    const { prisma, d } = await setup({ kind: 'ReturnRefund', amount: 500, currency: 'USD', quantity: 20, unit: 'PCS', returnDisposition: 'Scrap' });
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'u1');
    prisma.$transaction.mockClear();
    prisma.$queryRawUnsafe.mockClear();
    expect((await executeDisposition(prisma, d.id, 'u1', { warehouseId: 'WH_1' })).ok).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRawUnsafe.mock.calls.map((call: any[]) => call[0])).toEqual([
      'SELECT id FROM "ClaimCase" WHERE id = $1 FOR UPDATE', 'SELECT id FROM "ClaimDisposition" WHERE id = $1 FOR UPDATE',
      'SELECT id FROM "ApprovalRequest" WHERE "actionType" = $1 AND "targetType" = $2 AND "targetId" = $3 FOR UPDATE',
      'SELECT id FROM "ClaimCase" WHERE id = $1 FOR UPDATE', 'SELECT id FROM "ClaimDisposition" WHERE id = $1 FOR UPDATE',
      'SELECT id FROM "ReturnReceipt" WHERE "claimCaseId" = $1 FOR UPDATE',
    ]);
  });

  it('稳定请求 ID 顺序重试返回原产出；调用者、参数或 ID 变更都拒绝重复产出', async () => {
    const { prisma, d } = await setup();
    recordApprovedFact(prisma, d);
    await approveDisposition(prisma, d.id, 'u1');
    const opts = { clientRequestId: 'request-1', notes: 'same' };
    const first = await executeDisposition(prisma, d.id, 'u1', opts);
    const retry = await executeDisposition(prisma, d.id, 'u1', opts);
    expect(retry.ok).toBe(true);
    expect(retry.data!.creditNote.id).toBe(first.data!.creditNote.id);
    expect((await executeDisposition(prisma, d.id, 'u1', { ...opts, notes: 'different' })).error?.code).toBe('INVALID_STATE');
    expect((await executeDisposition(prisma, d.id, 'other', opts)).error?.code).toBe('INVALID_STATE');
    expect((await executeDisposition(prisma, d.id, 'u1', { ...opts, clientRequestId: 'request-2' })).error?.code).toBe('INVALID_STATE');
    expect((await executeDisposition(prisma, d.id, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._t.creditNote).toHaveLength(1);
    expect(String(prisma._t.claimCase[0].totalCreditAmount)).toBe('500');
    expect(prisma._t.auditLog.filter((row: any) => row.action === 'execute')).toHaveLength(1);
  });
});
