/**
 * productionEntryGate.test.ts — A10（拍板件 §2.3 硬条件 1 与 7）
 *
 * 病根（拍板件原文）：门禁**只挂在「进入 Confirmed」**（`transitionOrderStatus` 里那一条）
 *   ⇒ `Confirmed → Production → Shipping → Completed` 全程不跑门禁。
 *   Kevin 2026-09-25 21:0x 拍板：**让前进也严一点** ——
 *   `Confirmed → Production` 补一项「客户冻结」，**只加这一项**：
 *     · 不许套用 `evaluateOrderConfirmGates`（它是**确认专属**，含信用额度/MOQ/L/C，
 *       套到投产会引入确认语义 —— 拍板件明令不许）；
 *     · 信用证**不重复查**（发运侧已有独立 L/C 门禁，重复查就是两套口径）；
 *     · 发运/完工两档**仍然不跑门禁** = 已知且接受的现状，别顺手补。
 *
 * 「客户冻结」的唯一真源 = `CreditLimit.status ∈ {Frozen, Revoked}`
 *   （`creditService.getCreditStatus().creditFrozen` 就是这条判据；本门禁**调用它**，
 *    不在这里另写一份 status 集合 —— 同一个概念好几处各写各的 = 本仓头号病）。
 *
 * ★ 本组用例在改前必须红：`evaluateProductionEntryGate` 尚不存在，
 *   且 `transitionOrderStatus` 对 `toStatus:'Production'` **不做任何检查**。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../events/businessEventBus', async (importOriginal) => ({
  ...await importOriginal<any>(),
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

import { evaluateProductionEntryGate, transitionOrderStatus } from '../orderLifecycleService';

const ORDER = { id: 'O1', deletedAt: null, customerRelationId: 'R1' };

const ACTIVE_LIMIT = {
  id: 'CL1', status: 'Active', totalLimit: 100000, usedAmount: 0,
  currency: 'USD', deletedAt: null, createdAt: new Date(),
};

function makePrisma(opts: {
  order?: any;
  creditLimit?: any;
  creditThrows?: boolean;
  txCalls?: { n: number };
  /** 事务内读到的订单（默认 Pending ⇒ 任何推进都撞 INVALID_TRANSITION） */
  txOrder?: any;
}) {
  return {
    order: { findUnique: async () => (opts.order === undefined ? ORDER : opts.order) },
    invoice: { findMany: async () => [] },
    creditLimit: {
      findFirst: async () => {
        if (opts.creditThrows) throw new Error('credit db down');
        return opts.creditLimit === undefined ? ACTIVE_LIMIT : opts.creditLimit;
      },
    },
    $transaction: async (fn: any) => {
      if (opts.txCalls) opts.txCalls.n += 1;
      // 事务内第一笔读：默认给一个「Pending 订单」⇒ 若门禁没拦住，会走到
      // INVALID_TRANSITION（Pending → Production 不在矩阵里），据此可判「放行后确实继续走原流程」
      return fn({ order: { findUnique: async () => (opts.txOrder ?? { id: 'O1', status: 'Pending', deletedAt: null }) } });
    },
  } as any;
}

describe('订单主单状态写入不得旁路条目履约门禁', () => {
  it.each(['Production', 'Shipping'] as const)('旧主单状态接口拒绝推进到 %s，且不开始事务', async (toStatus) => {
    const txCalls = { n: 0 };
    const r = await transitionOrderStatus({ prisma: makePrisma({ txCalls }), orderId: 'O1', toStatus });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ORDER_LINE_WORKFLOW_REQUIRED');
    expect(txCalls.n).toBe(0);
  });
});
