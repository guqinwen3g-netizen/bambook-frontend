/**
 * B50-1b（G 线第 7 批）· agent 审批提交路径接回唯一确认门禁 —— 行为证据。
 *
 * 与 `commitTransaction.test.ts` 的分工：那个文件把门禁**桩成放行**（它测 draft/hash/receipt 语义），
 * 本文件**不桩门禁**，用 `orders/__tests__/orderConfirmGates.test.ts` 同一套 delegate 口径喂真实现，
 * 判的是"这条路上到底有没有人调用那份判定、调用之后被挡时留下了什么"。
 *
 * 三件事各自都要能单独红：
 *  ① **确认腿**（信用 + MOQ + L/C）：被挡时 `$transaction` 根本没开 ⇒ 零写入、零回执，
 *     而阻断同时**自动发起的豁免审批单必须已经落库**（它落在事务之外，回滚带不走它 ——
 *     这是"事务之前"这个位置存在的唯一理由，也是本批最容易做错成假话的地方）；
 *  ② **开票腿**（L/C，stage=invoice:issue）：在事务内、任何一笔写之前 ⇒ 被挡时票没建、状态没改;
 *  ③ 正向对照：T/T + 合规数量的订单**照常提交**（防判据退化成"agent 面什么都不许干"）。
 *
 * ★ 反"假门禁"提醒（本仓 §9 记过两次同一形状）：门禁要的字段是 `paymentInstrument`，
 *   矩阵里写的 `paymentMethod` 在 Order 表上不存在。读数一旦被改回 `paymentMethod`，
 *   `isLcInstrument(undefined)` 恒 false ⇒ L/C 门禁永不触发且这里全绿 ——
 *   所以第 ② 组的用例是**真查库形状**（给 L/C 行、断言阻断），不是源码正则。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../events/businessEventBus', () => ({
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../approvals/approvalRoutingService', () => ({
  createApprovalRoutingService: vi.fn(() => ({
    resolveApprovers: vi.fn().mockResolvedValue([{ userId: 'boss_1', level: 1 }]),
  })),
}));
// MOQ / 信用例外的"自动发起豁免审批单"统一经 approvalCreateService —— 桩成固定单号，
// 这样"阻断消息里那个 id 是不是真的落过库"是可以逐例断言的（不 mock 会去打真审批路由表）。
const MOCK_APPROVAL_ID = 'APR__MOCK__B50B';
vi.mock('../../approvals/approvalCreateService', () => ({
  createApprovalCreateService: vi.fn(() => ({
    createBusinessApproval: vi.fn().mockResolvedValue({ id: MOCK_APPROVAL_ID }),
  })),
}));
vi.mock('../../dictionaries/dataDictionaryService', () => ({
  getDataDictionaryService: vi.fn(() => ({ getEntries: vi.fn().mockResolvedValue([]) })),
}));
vi.mock('../../config/systemConfigService', () => ({
  getSystemConfigService: vi.fn(() => ({ getString: vi.fn().mockResolvedValue('USD') })),
}));

import { commitOrderConfirm } from '../commitTransaction';
import { buildOrderConfirmProcessDraft, type ProcessDraft } from '../toolRegistry';
import { buildInvoiceIssueDraft, commitInvoiceIssue } from '../invoiceIssueFlow';
import type { TokenPayload } from '../../auth/service';

// Only the five issue consumers use this current-authority/source storage seam.
// Real L/C, grant/ceiling and L2 helpers remain active; this is not a PG proof.
const issueLcActor: TokenPayload = { userId: 'usr_tester', roles: ['finance'], departmentIds: [],
  permissions: ['invoices:write', 'orders:read'], authorizationLoaded: true,
  permissionCeiling: ['invoices:write', 'orders:read'] };
function issueAuthority(p: ReturnType<typeof makePrisma>, approvedPayload: any) {
  const user = { id: issueLcActor.userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'role-finance', departmentId: null, role: { id: 'role-finance',
      permissions: issueLcActor.permissions!.map(scope => ({ permission: { scope } })) } }] };
  Object.assign(p.tx, {
    userAccount: { findUnique: vi.fn(async () => user), findFirst: vi.fn(async () => user) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    orderLine: { findMany: vi.fn(async () => []) }, releaseScope: { findMany: vi.fn(async () => []) },
    sample: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (sql: any) => {
      const statement = sql.strings.join('');
      if (statement.includes('INSERT INTO "AgentCommitReceipt"')) {
        const [id, key, approvalId] = sql.values; if (p.receipts.has(key)) return [];
        p.receipts.set(key, { id, idempotencyKey: key, toolId: 'invoice.issue', approvalId, status: 'committing', result: null }); return [{ id }];
      }
      if (statement.includes('FROM "AgentCommitReceipt"')) { const row = p.receipts.get(sql.values[0]); return row ? [{ id: row.id }] : []; }
      if (statement.includes('FROM "ApprovalRequest"')) return [{ id: 'ar_1' }];
      return [{ id: 'order_real_id' }];
    }),
    approvalRequest: { findUnique: vi.fn(async () => ({ id: 'ar_1', requesterId: 'usr_tester', status: 'approved', actionType: 'tool:invoice.issue', payload: approvedPayload })) },
  });
  p.tx.agentCommitReceipt.findUnique = vi.fn(async ({ where }: any) => p.receipts.get(where.idempotencyKey) ?? null);
  return { prisma: p.prisma, trustedActor: issueLcActor };
}

// ────────────────────────────── fixtures ──────────────────────────────

const GATE_ORDER_BASE = {
  id: 'order_real_id',
  poNumber: 'PO-001',
  status: 'Pending',
  deletedAt: null,
  type: 'Fabric',
  businessLine: 'fabric',
  quantity: 1000,
  capsuleExemption: false,
  moqSnapshot: null,
  customerRelationId: null,
  quoteAmount: 12000,
  // ★ 门禁真正读的字段名（不是矩阵里那个不存在的 paymentMethod）
  paymentInstrument: 'T/T',
};

function snapshot() {
  return {
    orderId: 'order_real_id',
    poNumber: 'PO-001',
    status: 'Pending',
    amount: 12000,
    currency: 'USD',
    customerRelationId: 'rel_cust_1',
    customerName: 'ACME',
    lineCount: 3,
  };
}

function validDraft(): ProcessDraft {
  return buildOrderConfirmProcessDraft({
    poNumber: 'PO-001',
    previousStatus: 'Pending',
    newStatus: 'Confirmed',
    snapshot: snapshot(),
  });
}

function creditLimit(overrides: any = {}) {
  return {
    id: 'CL__1', relationId: 'rel_cust_1', status: 'Active',
    totalLimit: 100000, usedAmount: 0, currency: 'USD', frozenAt: null, ...overrides,
  };
}

/**
 * 一份"能跑真门禁"的 prisma：gateOrder 决定确认腿看到什么，txOrder 决定开票腿看到什么
 * （两者故意可分开 —— 用来证明开票腿那道判定是**独立存在**的，不是确认腿的余温）。
 */
function makePrisma(opts: {
  gateOrder?: any | null;
  txOrder?: any | null;
  lcs?: any[];
  /** 传 false ⇒ 不给 dr013ExceptionRequest delegate：L/C 门禁"查不到例外状态"，应出 LC_EXCEPTION_CHECK_FAILED */
  withExceptionLookup?: boolean;
  approvalRequester?: string | null;
} = {}) {
  const gateOrder = 'gateOrder' in opts ? opts.gateOrder : GATE_ORDER_BASE;
  const txOrder = 'txOrder' in opts ? opts.txOrder : GATE_ORDER_BASE;
  const lcs = opts.lcs ?? [];
  const auditRows: any[] = [];
  const invoiceCreates: any[] = [];
  const orderStatusUpdates: any[] = [];
  const transitions: any[] = [];
  const receipts = new Map<string, any>();

  const dr013 = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    create: vi.fn(async ({ data }: any) => data),
    update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
  };
  const tx: any = {
    order: {
      findFirst: vi.fn(async () => (txOrder ? { id: txOrder.id, poNumber: txOrder.poNumber, status: txOrder.status, deletedAt: txOrder.deletedAt } : null)),
      findUnique: vi.fn(async () => txOrder),
      update: vi.fn(async ({ data }: any) => { orderStatusUpdates.push(data); return { ...txOrder, ...data }; }),
    },
    orderStatusTransition: { create: vi.fn(async ({ data }: any) => { transitions.push(data); return data; }) },
    invoice: { create: vi.fn(async ({ data }: any) => { invoiceCreates.push(data); return data; }) },
    auditLog: { create: vi.fn(async ({ data }: any) => { auditRows.push(data); return data; }) },
    entityLink: { upsert: vi.fn(async (a: any) => a) },
    entityReference: { upsert: vi.fn(async (a: any) => a) },
    letterOfCredit: { findMany: vi.fn(async () => lcs) },
    agentCommitReceipt: {
      create: vi.fn(async ({ data }: any) => {
        if (receipts.has(data.idempotencyKey)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        receipts.set(data.idempotencyKey, { ...data });
        return data;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const next = { ...receipts.get(where.idempotencyKey), ...data };
        receipts.set(where.idempotencyKey, next);
        return next;
      }),
    },
  };
  if (opts.withExceptionLookup !== false) tx.dr013ExceptionRequest = dr013;

  const prisma: any = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    order: {
      findFirst: vi.fn(async () => (gateOrder ? { id: gateOrder.id, deletedAt: gateOrder.deletedAt } : null)),
      findUnique: vi.fn(async () => gateOrder),
    },
    creditLimit: { findFirst: vi.fn(async () => opts.approvalRequester === '__frozen__' ? creditLimit({ status: 'Frozen', frozenAt: new Date(), frozenBy: 'system_credit_scan' }) : null), findMany: vi.fn(async () => []) },
    invoice: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    approvalRequest: {
      findUnique: vi.fn(async () => (opts.approvalRequester === null ? null : { id: 'ar_1', requesterId: opts.approvalRequester ?? 'usr_tester', status: 'approved' })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    dr013ExceptionRequest: dr013,
    letterOfCredit: { findMany: vi.fn(async () => lcs) },
    agentCommitReceipt: { findUnique: vi.fn(async ({ where }: any) => receipts.get(where.idempotencyKey) ?? null) },
  };
  return { prisma, tx, auditRows, invoiceCreates, orderStatusUpdates, transitions, receipts, dr013 };
}

/** 让"确认腿放行、开票腿阻断"分开：事务外读 T/T、事务内读 L/C 且库里无证 */
function makePrismaLcOnlyOnInvoiceLeg(opts: { withExceptionLookup?: boolean } = {}) {
  const p = makePrisma({
    gateOrder: { ...GATE_ORDER_BASE, customerRelationId: null },
    txOrder: { ...GATE_ORDER_BASE, paymentInstrument: 'L/C' },
    lcs: [],
    ...opts,
  });
  return p;
}

beforeEach(() => { vi.clearAllMocks(); });

/**
 * 被挡时"什么都没发生"的统一断言。
 * ★ 为什么断 `receipts.size === 0` 而不是只断 `$transaction` 没被调用：
 *   `agentCommitReceipt.create` 是 commit 事务体里的**第一笔写** ⇒ 它没出现就等价于
 *   "门禁跑在事务之前"。而 `$transaction` 本身可能被别的组件借用
 *   （信用例外的自动发起在 exceptionService 内部也开事务），只数它会误判。
 */
function expectNoCommitWrites(p: { orderStatusUpdates: any[]; transitions: any[]; invoiceCreates: any[]; receipts: Map<string, any> }) {
  expect(p.receipts.size, '幂等回执都没落 ⇒ commit 事务根本没开（门禁在写之前）').toBe(0);
  expect(p.orderStatusUpdates, '被挡的确认不许改订单状态').toHaveLength(0);
  expect(p.transitions, '被挡的确认不许落状态流转记录').toHaveLength(0);
  expect(p.invoiceCreates, '被挡的确认不许顺手开票').toHaveLength(0);
}

// ═══════════════════════ ① 确认腿：真门禁 ═══════════════════════
describe('B50-1b ① order.confirm 审批提交：确认门禁（真实现）在写之前生效', () => {
  it('MOQ 不足 ⇒ CONFIRM_GATE_BLOCKED + gateCode=MOQ_VIOLATION + 审批单号透出，且 $transaction 根本没开', async () => {
    const p = makePrisma({ gateOrder: { ...GATE_ORDER_BASE, quantity: 100 } });
    const r = await commitOrderConfirm({
      prisma: p.prisma, approvalId: 'ar_1',
      approvalPayload: { processDraft: validDraft() } as any,
    });

    expect(r.ok).toBe(false);
    expect(r.committed).toBe(false);
    expect(r.errorFeedback?.code, '契约层码必须稳定，不能塌成 COMMIT_TRANSACTION_FAILED').toBe('CONFIRM_GATE_BLOCKED');
    expect(r.errorFeedback?.gateCode, '精确门禁码不许被上层码销毁').toBe('MOQ_VIOLATION');
    expect(r.errorFeedback?.approvalRequestId).toBe(MOCK_APPROVAL_ID);
    expect(r.errorFeedback?.userAction).toContain('门禁');
    // ★ 位置判据：门禁在事务之前 ⇒ 整笔事务根本没开（不是"开了又回滚"）
    expect(p.prisma.$transaction).not.toHaveBeenCalled();
    expectNoCommitWrites(p);
    expect(r.errorFeedback?.retryable).toBe(false);
  });

  it('★ 阻断消息里那句"豁免审批单已自动发起"必须是真的：单号来自真调用，且它不在被回滚的事务里', async () => {
    const { createApprovalCreateService } = await import('../../approvals/approvalCreateService');
    const p = makePrisma({ gateOrder: { ...GATE_ORDER_BASE, quantity: 100 } });
    const r = await commitOrderConfirm({
      prisma: p.prisma, approvalId: 'ar_1', approvalPayload: { processDraft: validDraft() } as any,
    });
    // 服务被组装过（= 自动发起这条路真的走了），且返回的 id 与消息里的 id 是同一个
    expect(createApprovalCreateService).toHaveBeenCalled();
    expect(r.errorFeedback?.message).toContain(MOCK_APPROVAL_ID);
    // 门禁跑在 $transaction 之外 ⇒ 这张单不会因为本次阻断而消失（回执都没落，更没被回滚）
    expectNoCommitWrites(p);
  });

  it('Frozen 客户 ⇒ gateCode 是信用族的原码（CREDIT_FROZEN_60_DAYS），不是笼统的"提交失败"', async () => {
    const p = makePrisma({ gateOrder: { ...GATE_ORDER_BASE, customerRelationId: 'rel_cust_1' } });
    p.prisma.creditLimit.findFirst = vi.fn(async () => creditLimit({ status: 'Frozen', frozenAt: new Date(), frozenBy: 'scan' }));
    const r = await commitOrderConfirm({
      prisma: p.prisma, approvalId: 'ar_1', approvalPayload: { processDraft: validDraft() } as any,
    });
    expect(r.ok).toBe(false);
    expect(r.errorFeedback?.gateCode).toBe('CREDIT_FROZEN_60_DAYS');
    // 不用 $transaction 计数当判据：信用例外的自动发起在 exceptionService 内部也开事务，
    // 数它会把"门禁阻断"误判成"事务开过了"⇒ 改断零写入 + 零回执（见 expectNoCommitWrites 注释）。
    expectNoCommitWrites(p);
  });

  it('L/C 订单无证 ⇒ 确认腿先阻断，消息给出下一步（去登记信用证）', async () => {
    const p = makePrisma({ gateOrder: { ...GATE_ORDER_BASE, paymentInstrument: 'L/C' }, lcs: [] });
    const r = await commitOrderConfirm({
      prisma: p.prisma, approvalId: 'ar_1', approvalPayload: { processDraft: validDraft() } as any,
    });
    expect(r.errorFeedback?.gateCode).toBe('LC_GATE_BLOCKED');
    expect(r.errorFeedback?.message).toContain('LC_NOT_REGISTERED');
    expect(r.errorFeedback?.message).toContain('登记');
    expectNoCommitWrites(p);
  });

  it('★ 正向对照：T/T + 合规数量 ⇒ 照常提交（状态改了、票建了、回执标了 committed）', async () => {
    const p = makePrisma();
    const draft = validDraft();
    const r = await commitOrderConfirm({ prisma: p.prisma, approvalId: 'ar_1', approvalPayload: { processDraft: draft } as any });
    expect(r.ok, JSON.stringify(r.errorFeedback ?? r.error)).toBe(true);
    expect(p.orderStatusUpdates).toHaveLength(1);
    expect(p.transitions).toHaveLength(1);
    expect(p.invoiceCreates).toHaveLength(1);
    expect(p.receipts.get(draft.idempotencyKey)?.status).toBe('committed');
  });

  it('★ 正向对照 2：确认腿放行但订单已被软删 ⇒ 由事务按既有语义出 ORDER_NOT_FOUND（不在这造第二个出口）', async () => {
    const p = makePrisma({ gateOrder: { ...GATE_ORDER_BASE, deletedAt: new Date() }, txOrder: null });
    const r = await commitOrderConfirm({ prisma: p.prisma, approvalId: 'ar_1', approvalPayload: { processDraft: validDraft() } as any });
    expect(r.ok).toBe(false);
    // 锚点行已软删 ⇒ 确认腿跳过（不造第二个"不存在"错误），事务里那步才是出口
    expect(p.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(r.errorFeedback?.code).toBe('ORDER_NOT_FOUND');
  });
});

// ═══════════════════════ ② 开票腿：事务内的第二道 L/C ═══════════════════════
describe('B50-1b ② 开票腿：确认放行后，L/C 条款不满足仍在任何写入之前挡住', () => {
  it('确认腿 T/T 放行、开票腿读到 L/C 无证 ⇒ LC_GATE_BLOCKED，且零写入（状态/流转/票都没落）', async () => {
    const p = makePrismaLcOnlyOnInvoiceLeg();
    const r = await commitOrderConfirm({ prisma: p.prisma, approvalId: 'ar_1', approvalPayload: { processDraft: validDraft() } as any });
    expect(r.ok).toBe(false);
    expect(r.errorFeedback?.code, '业务拒绝不许伪装成数据库错误').toBe('LC_GATE_BLOCKED');
    expect(r.errorFeedback?.userAction).toContain('信用证');
    expect(p.orderStatusUpdates, '开票腿被挡时订单状态不许已经改掉').toHaveLength(0);
    expect(p.transitions).toHaveLength(0);
    expect(p.invoiceCreates, '被挡的那次不许留下一张票').toHaveLength(0);
    for (const [, rec] of p.receipts) expect(rec.status).not.toBe('committed');
  });

  it('★ 例外状态查不出来 ⇒ 单独一码 LC_EXCEPTION_CHECK_FAILED（下一步是排障，不是补证）', async () => {
    const p = makePrismaLcOnlyOnInvoiceLeg({ withExceptionLookup: false });
    const r = await commitOrderConfirm({ prisma: p.prisma, approvalId: 'ar_1', approvalPayload: { processDraft: validDraft() } as any });
    expect(r.errorFeedback?.code).toBe('LC_EXCEPTION_CHECK_FAILED');
    expect(r.errorFeedback?.message).toContain('无法确认');
    expect(p.invoiceCreates).toHaveLength(0);
  });
});

// ═══════════════════════ ③ 审计身份：不许再写库里不存在的哨兵 ═══════════════════════
describe('B50-1b ③ 审计 actorId 必须是 UserAccount 里真存在的行（外键实测：AuditLog_actorId_fkey）', () => {
  it('★ registry 注入审批请求人 ⇒ 审计与门禁都用它（B58：身份的来源只有一个）', async () => {
    const p = makePrisma();
    const r = await commitOrderConfirm({ prisma: p.prisma, approvalId: 'ar_1', approvalPayload: { processDraft: validDraft() } as any, actorId: 'usr_tester' });
    expect(r.ok).toBe(true);
    expect(p.auditRows.length).toBeGreaterThan(0);
    for (const row of p.auditRows) expect(row.actorId).toBe('usr_tester');
  });

  it('★ 不经 registry（params 无 actorId）⇒ 落 seed 的 system，不再落无账号的 unknown/agent', async () => {
    const p = makePrisma({ approvalRequester: null });
    const r = await commitOrderConfirm({ prisma: p.prisma, approvalId: 'ar_missing', approvalPayload: { processDraft: validDraft() } as any });
    expect(r.ok).toBe(true);
    const actors = p.auditRows.map(x => x.actorId);
    expect(actors).toContain('system');
    expect(actors, "'unknown' 在 UserAccount 无行 = 审计写入撞 P2003 = 整笔提交回滚").not.toContain('unknown');
  });
});

// ═══════════════════════ ④ invoice.issue：agent 面第二条开票出口 ═══════════════════════
describe('B50-1b ④ invoice.issue 审批提交：不走 createInvoice 的那条开票路也要过同一道 L/C', () => {
  function issuePayload(orderId: string | null, type = 'Receivable') {
    const draft = buildInvoiceIssueDraft({
      invoiceNumber: 'INV-B50B-1', amount: 1000, currency: 'USD',
      issueDate: '2026-09-21', customerRelationId: 'rel_cust_1', customerName: 'ACME',
      orderId: orderId ?? undefined, type,
    });
    return { processDraft: draft };
  }

  it('L/C 订单无证 ⇒ LC_GATE_BLOCKED（不是 COMMIT_TRANSACTION_FAILED），票没建、审计没落', async () => {
    const p = makePrisma({ txOrder: { ...GATE_ORDER_BASE, paymentInstrument: 'L/C' }, lcs: [] });
    const r = await commitInvoiceIssue({ ...issueAuthority(p, issuePayload('order_real_id')), approvalId: 'ar_1', approvalPayload: issuePayload('order_real_id') as any });
    expect(r.ok).toBe(false);
    expect(r.feedback.status).toBe('failed');
    expect((r.feedback as any).error.code).toBe('LC_GATE_BLOCKED');
    expect((r.feedback as any).error.userAction).toContain('信用证');
    expect(p.invoiceCreates).toHaveLength(0);
    expect(p.auditRows).toHaveLength(0);
  });

  it('★ 正向对照：T/T 订单照常出票（门禁不许把非信用证路径一起锁死）', async () => {
    const p = makePrisma();
    const r = await commitInvoiceIssue({ ...issueAuthority(p, issuePayload('order_real_id')), approvalId: 'ar_1', approvalPayload: issuePayload('order_real_id') as any, actorId: 'usr_tester' });
    expect(r.ok, JSON.stringify((r.feedback as any).error ?? '')).toBe(true);
    expect(p.invoiceCreates).toHaveLength(1);
    expect(p.auditRows.map(x => x.actorId)).toEqual(['usr_tester']);
  });

  it('★ 例外状态查不出来 ⇒ LC_EXCEPTION_CHECK_FAILED，与"确实没证"分开报', async () => {
    const p = makePrisma({ txOrder: { ...GATE_ORDER_BASE, paymentInstrument: 'L/C' }, lcs: [], withExceptionLookup: false });
    const r = await commitInvoiceIssue({ ...issueAuthority(p, issuePayload('order_real_id')), approvalId: 'ar_1', approvalPayload: issuePayload('order_real_id') as any });
    expect((r.feedback as any).error.code).toBe('LC_EXCEPTION_CHECK_FAILED');
    expect(p.invoiceCreates).toHaveLength(0);
  });

  it('无 orderId 锚点的票：不进 L/C 门禁（连信用证表都不该查）⇒ 本批不扩大范围，边界已登记 §9', async () => {
    // ★ 订单行故意给 **L/C**：否则门禁在查信用证之前就因"非信用证"短路返回，
    //   下面那两个 throw-mock 永不触发 ⇒ 这条用例会在"根本没跑到判据"的情况下绿（复核点名的空炮形状）。
    const p = makePrisma({ txOrder: { ...GATE_ORDER_BASE, paymentInstrument: 'L/C' } });
    p.tx.letterOfCredit.findMany = vi.fn(async () => { throw new Error('无锚点票不该查信用证'); });
    p.prisma.letterOfCredit.findMany = vi.fn(async () => { throw new Error('无锚点票不该查信用证'); });
    const r = await commitInvoiceIssue({ ...issueAuthority(p, issuePayload(null)), approvalId: 'ar_1', approvalPayload: issuePayload(null) as any });
    expect(r.ok, JSON.stringify((r.feedback as any).error ?? '')).toBe(true);
    expect(p.invoiceCreates).toHaveLength(1);
    // 且这个"绿"必须是**因为没查信用证**，不是查了但 mock 没生效
    expect(p.tx.letterOfCredit.findMany).not.toHaveBeenCalled();
    expect(p.prisma.letterOfCredit.findMany).not.toHaveBeenCalled();
  });

  it('付供应商的款（type=Payable）不被客户信用证门禁卡', async () => {
    const p = makePrisma({ txOrder: { ...GATE_ORDER_BASE, paymentInstrument: 'L/C' }, lcs: [] });
    const r = await commitInvoiceIssue({ ...issueAuthority(p, issuePayload('order_real_id', 'Payable')), approvalId: 'ar_1', approvalPayload: issuePayload('order_real_id', 'Payable') as any });
    // ★ 断"走得通"而不是断"不是某个码"：后者在接线被整段删掉时照样绿（复核点名的弱例形状）。
    expect(r.ok, JSON.stringify((r.feedback as any).error ?? '')).toBe(true);
    expect(p.invoiceCreates).toHaveLength(1);
    expect(p.tx.letterOfCredit.findMany, '付款凭证不该被查信用证').not.toHaveBeenCalled();
  });
});
