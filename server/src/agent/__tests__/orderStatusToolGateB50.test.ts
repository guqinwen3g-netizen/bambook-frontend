/**
 * B50-1（agent 面旁路）· `orders.update_status` / `orders.batch_status` 必须经唯一确认门禁引擎。
 *
 * 缺陷形状（HEAD `b9a07ad4` 现状）：这两个工具自己 `orderStatusTransition.create` + `prisma.order.update({status})`，
 * 于是同一个动作的四样控制**一条都没有** —— 确认门禁（信用/MOQ/L/C）、状态转换矩阵、AuditLog、事务原子性。
 * 唯一实现早已存在于 `orders/orderLifecycleService.transitionOrderStatus`（V1/V2 路由 + `orderLifecycleFlow` 都走它，
 * 其注释原文："进入 Confirmed 的所有路径…统一经本服务，门禁只在此处实现一次"）。
 *
 * ★ 本文件的核心可证伪点：断言"被门禁挡下时**一次写入都没有**"。
 *   把旁路抄回去（直接在工具里 update status），用例 1/4/5 必红 —— 不是靠读源码，是靠行为。
 *
 * ⚠️ 未覆盖（S1–S3）：
 *   · 只测"工具是否把判定交回引擎"，**不**重测引擎内的门禁逻辑（那是 orderConfirmGates / lcGate 的用例）；
 *   · `order.confirm`（`agent/commitTransaction.ts:285/:305`）与 `invoice.issue`
 *     （`agent/invoiceIssueFlow.ts:229`）**本批未接** —— 它们在 `$transaction` 内直写，接回引擎需要先把
 *     门禁判定抽成"可在已开启事务里调用"的函数（与 §9 B50-1 的后半同批），见本批文档 §七。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

vi.mock('../../orders/orderLifecycleService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // 只替身 transitionOrderStatus：其余导出（类型/常量）保持原样，免得替身把 import 链打断
  return { ...actual, transitionOrderStatus: vi.fn() };
});

import { executeTool } from '../toolRuntime';
import { transitionOrderStatus } from '../../orders/orderLifecycleService';

const tx = vi.mocked(transitionOrderStatus);

function makePrisma() {
  return {
    order: { update: vi.fn(), findUnique: vi.fn() },
    orderStatusTransition: { create: vi.fn() },
  } as any;
}

const OK_DATA = { order: {}, transitionId: 'ST-1', auditId: 'AU-1', fromStatus: 'Pending', toStatus: 'Confirmed', note: null, operator: 'agent', lineId: null, createdAt: 1 };

describe('B50-1 · orders.update_status 交回唯一引擎', () => {
  beforeEach(() => vi.clearAllMocks());

  it('★ 门禁挡下时：一次写入都不许发生，且把拒绝码原样带出去', async () => {
    const prisma = makePrisma();
    tx.mockResolvedValue({ ok: false, error: { code: 'LC_GATE_BLOCKED', message: '信用证未登记' } } as any);
    const r: any = await executeTool(prisma, { toolId: 'orders.update_status', input: { orderId: 'O1', toStatus: 'Confirmed' } } as any);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('LC_GATE_BLOCKED');
    expect(r.message).toBe('信用证未登记');
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.orderStatusTransition.create).not.toHaveBeenCalled();
  });

  it('★ MOQ 命中时 approvalRequestId 必须透出（否则调用方只看到"被拒"，不知道下一步是去审批）', async () => {
    const prisma = makePrisma();
    tx.mockResolvedValue({ ok: false, error: { code: 'MOQ_VIOLATION', message: '低于 MOQ', approvalRequestId: 'AP-9' } } as any);
    const r: any = await executeTool(prisma, { toolId: 'orders.update_status', input: { orderId: 'O1', toStatus: 'Confirmed' } } as any);
    expect(r.reason).toBe('MOQ_VIOLATION');
    expect(r.approvalRequestId).toBe('AP-9');
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('★ 判定不在工具里重做：prisma 句柄与参数原样交给引擎（operator=agent）', async () => {
    const prisma = makePrisma();
    tx.mockResolvedValue({ ok: true, data: OK_DATA } as any);
    await executeTool(prisma, { toolId: 'orders.update_status', input: { orderId: 'O1', toStatus: 'Confirmed', note: '客户已付定金' } } as any);
    expect(tx).toHaveBeenCalledTimes(1);
    const arg = (tx.mock.calls[0] as any[])[0];
    expect(arg.prisma).toBe(prisma);
    expect(arg.orderId).toBe('O1');
    expect(arg.toStatus).toBe('Confirmed');
    expect(arg.operator).toBe('agent');
  });

  it('★ 成功时返回形状保持（fromStatus/toStatus 取自引擎结果，不再自己读一遍旧状态）', async () => {
    const prisma = makePrisma();
    tx.mockResolvedValue({ ok: true, data: OK_DATA } as any);
    const r: any = await executeTool(prisma, { toolId: 'orders.update_status', input: { orderId: 'O1', toStatus: 'Confirmed' } } as any);
    expect(r).toMatchObject({ ok: true, orderId: 'O1', fromStatus: 'Pending', toStatus: 'Confirmed' });
    // 引擎之前那次"为了拿 fromStatus 的预读"也一并省掉 ⇒ 少一次读写不一致的窗口
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('★ 机发动作的 actorId 必须是真实存在的账号 id（复核 BLOCKER：AuditLog.actorId 是外键）', async () => {
    const prisma = makePrisma();
    tx.mockResolvedValue({ ok: true, data: OK_DATA } as any);
    await executeTool(prisma, { toolId: 'orders.update_status', input: { orderId: 'O1', toStatus: 'Confirmed' } } as any);
    const arg = (tx.mock.calls[0] as any[])[0];
    // 'agent' 是**自造字面量**：UserAccount 里没有这枚 id ⇒ 引擎在事务内写审计/发起豁免审批会 P2003 回滚，
    // 整个"接回门禁"就变成"agent 再也改不动状态"。'system' 是既有种子账号（"系统服务"）。
    expect(arg.actorId, '不许把自造哨兵当 actorId 传给带外键的审计写入').toBe('system');
    expect(arg.operator, 'operator 是自由文本列（无外键），"谁发起的"这层语义放这里').toBe('agent');
  });

  it('★ 引擎返回未知码（典型：Prisma P2003/P2025）时不许原样变成对外 reason', async () => {
    const prisma = makePrisma();
    for (const [code, expectReason] of [['P2003', 'TRANSITION_FAILED'], ['P2025', 'TRANSITION_FAILED'], ['INVALID_TRANSITION', 'INVALID_TRANSITION']] as const) {
      tx.mockResolvedValue({ ok: false, error: { code, message: 'Foreign key violation ...' } } as any);
      const r: any = await executeTool(prisma, { toolId: 'orders.update_status', input: { orderId: 'O1', toStatus: 'Confirmed' } } as any);
      expect(r.reason, `${code} 的对外处理不对`).toBe(expectReason);
    }
  });

  it('★ 工具对外 reason 词表保持不变（MCP 客户端按 reason 分支；只映射，不重做判定）', async () => {
    const prisma = makePrisma();
    const cases: Array<[string, string]> = [
      ['NO_CHANGE', 'ALREADY_IN_STATUS'],
      ['ORDER_ALREADY_DELETED', 'ORDER_NOT_FOUND'],
      ['ORDER_NOT_FOUND', 'ORDER_NOT_FOUND'],
      ['CREDIT_FROZEN_60_DAYS', 'CREDIT_FROZEN_60_DAYS'],
      ['CREDIT_CHECK_FAILED', 'CREDIT_CHECK_FAILED'],
    ];
    for (const [code, expected] of cases) {
      tx.mockResolvedValue({ ok: false, error: { code, message: 'm' } } as any);
      const r: any = await executeTool(prisma, { toolId: 'orders.update_status', input: { orderId: 'O1', toStatus: 'Confirmed' } } as any);
      expect(r.reason, `${code} 的对外词表被改动`).toBe(expected);
    }
    // 入参级守卫（引擎之前就该拒）—— 用"调用次数不变"而不是"从未被调用"：上面那个循环已经调过 5 次，
    // 写 `not.toHaveBeenCalled()` 会把这条变成恒假（我第一版就踩了：断言错、代码对）
    const callsBefore = tx.mock.calls.length;
    const bad: any = await executeTool(prisma, { toolId: 'orders.update_status', input: { orderId: 'O1', toStatus: 'Cancelled' } } as any);
    expect(bad.reason).toBe('INVALID_STATUS: Cancelled');
    expect(tx.mock.calls.length, '非法状态应当在进引擎之前就被拒').toBe(callsBefore);
  });
});

describe('B50-1 · orders.batch_status 交回唯一引擎，且不许把"全挡"报成"全成"', () => {
  beforeEach(() => vi.clearAllMocks());

  it('★ 混合结果：成功的进 updated、被挡的进 failed，整体 ok=false；被挡那条零写入', async () => {
    const prisma = makePrisma();
    tx.mockImplementation(async ({ orderId }: any) =>
      orderId === 'OK1'
        ? { ok: true, data: { ...OK_DATA, fromStatus: 'Pending', toStatus: 'Confirmed' } }
        : { ok: false, error: { code: 'OVERDUE_60_DAYS', message: '逾期 60 天以上' } } as any,
    );
    const r: any = await executeTool(prisma, { toolId: 'orders.batch_status', input: { orderIds: ['OK1', 'NO1'], toStatus: 'Confirmed' } } as any);
    expect(r.ok).toBe(false);
    expect(r.updated).toEqual([{ orderId: 'OK1', fromStatus: 'Pending', toStatus: 'Confirmed' }]);
    expect(r.failed).toEqual([{ orderId: 'NO1', reason: 'OVERDUE_60_DAYS', message: '逾期 60 天以上' }]);
    expect(r.skipped).toEqual([]);
    // 两条都走引擎 ⇒ 工具自身一次直写都没有
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.orderStatusTransition.create).not.toHaveBeenCalled();
  });

  it('★ "本来就在目标状态"记 skipped、不算失败（复核 MINOR：无事可做不许报成批量失败）', async () => {
    const prisma = makePrisma();
    tx.mockResolvedValue({ ok: false, error: { code: 'NO_CHANGE', message: '状态未变化' } } as any);
    const r: any = await executeTool(prisma, { toolId: 'orders.batch_status', input: { orderIds: ['A', 'B'], toStatus: 'Confirmed' } } as any);
    expect(r.ok).toBe(true);
    expect(r.updated).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([{ orderId: 'A', reason: 'ALREADY_IN_STATUS' }, { orderId: 'B', reason: 'ALREADY_IN_STATUS' }]);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('★ 全被挡时不许返回 ok:true（HEAD 现状：ok 恒 true + 静默 continue ⇒ agent 会照实汇报"已确认 N 单"）', async () => {
    const prisma = makePrisma();
    tx.mockResolvedValue({ ok: false, error: { code: 'CREDIT_REVOKED', message: '信用已注销' } } as any);
    const r: any = await executeTool(prisma, { toolId: 'orders.batch_status', input: { orderIds: ['A', 'B', 'C'], toStatus: 'Confirmed' } } as any);
    expect(r.ok).toBe(false);
    expect(r.updated).toEqual([]);
    expect(r.failed).toHaveLength(3);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('入参级守卫保持在引擎之前（词表不变）', async () => {
    const prisma = makePrisma();
    const empty: any = await executeTool(prisma, { toolId: 'orders.batch_status', input: { orderIds: [], toStatus: 'Confirmed' } } as any);
    expect(empty).toEqual({ ok: false, reason: 'ORDER_IDS_REQUIRED' });
    const bad: any = await executeTool(prisma, { toolId: 'orders.batch_status', input: { orderIds: ['A'], toStatus: 'Pending' } } as any);
    expect(bad.reason).toBe('INVALID_STATUS: Pending');
    expect(tx).not.toHaveBeenCalled();
  });
});

describe('B50-1 · 反"再抄一套"的结构钉', () => {
  const SRC = readFileSync(path.resolve(__dirname, '../toolRuntime.ts'), 'utf-8');
  const body = (name: string) => {
    const start = SRC.indexOf(`async function ${name}(`);
    expect(start, `找不到函数 ${name}（改名了就要同步本钉）`).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    return rest.slice(0, next === -1 ? undefined : next);
  };

  for (const fn of ['updateOrderStatus', 'batchUpdateOrderStatus']) {
    it(`${fn} 体内不得再出现直写/自建流转行/自读旧状态（必须只经引擎）`, () => {
      const b = body(fn);
      expect(b).not.toMatch(/\.order\.update\(/);
      expect(b).not.toMatch(/orderStatusTransition\.create\(/);
      expect(b).not.toMatch(/\.order\.findUnique\(/);
      expect(b).toMatch(/transitionOrderStatus\(/);
    });
  }

  it('★ 非空自检：本钉若扫不到引擎调用（切片失效）必须红，而不是恒真', () => {
    expect(body('updateOrderStatus')).toContain('transitionOrderStatus');
    expect(body('batchUpdateOrderStatus')).toContain('transitionOrderStatus');
  });
});
