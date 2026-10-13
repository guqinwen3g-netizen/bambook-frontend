/**
 * B50-1b · 最后一公里：`order.confirm` 经**注册表分发**的那条路（唯一真正可达的那条）
 * 不许把门禁码洗成 UNKNOWN_ERROR。
 *
 * 为什么单独一个文件（不放进 `orderConfirmGateCommitB50b.test.ts`）：那边要**真**跑 `commitOrderConfirm`，
 * 这边必须**桩**掉它，只判"CommitResult → 工具返回"这一层映射。两件事互相排斥，不能共用一套 vi.mock。
 *
 * 复核（R4-T4）抓到的原缺陷：`toolRuntime.ts` 的 `_rct('order.confirm')` 读的是
 * `_r.feedback?.error?.message`，而 `commitOrderConfirm` 返回的是 `CommitResult`
 * （`{ ok, committed, error, errorFeedback }`，**没有 feedback 这一层**）⇒ 恒 undefined ⇒
 * 每次都以 `'commit failed'` 进 `parseErrorCode` ⇒ 一律 `UNKNOWN_ERROR`。
 * 于是"接上了门禁"与"用户看得见门禁"之间还差这一跳，而这一跳正好把刚新增的三样东西
 * （契约码 / `gateCode` / 豁免单号）全丢了。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../commitTransaction', () => ({
  commitOrderConfirm: vi.fn(),
  recoverProcessDraftFromPayload: vi.fn(),
}));

import { commitOrderConfirm } from '../commitTransaction';
import { getToolHandler } from '../toolDispatchRegistry';
// 触发 toolRuntime 模块副作用：里面的 `_rct('order.confirm', …)` 才会注册进分发表
await import('../toolRuntime');

const mockedCommit = commitOrderConfirm as unknown as ReturnType<typeof vi.fn>;

function prismaStub() {
  return {
    approvalRequest: {
      findUnique: vi.fn(async () => ({
        id: 'ar_1', status: 'approved', actionType: 'tool:order.confirm',
        requesterId: 'usr_tester', payload: { processDraft: { idempotencyKey: 'k1' } },
      })),
    },
    agentCommitReceipt: {
      create: vi.fn(async ({ data }: any) => data),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.idempotencyKey, ...data })),
      findUnique: vi.fn(async () => null),
      delete: vi.fn(async () => ({})),
    },
  } as any;
}

async function replay() {
  const handler = getToolHandler('order.confirm');
  expect(handler, '分发表里必须有 order.confirm（注册被搬走的话这里就红）').toBeTruthy();
  return (await handler!(prismaStub(), {}, { approvalId: 'ar_1' } as any)) as any;
}

describe('B50-1b · 审批重放分发层：门禁码不许在最后一公里被销毁', () => {
  it('★ MOQ 阻断 ⇒ 工具层拿到 CONFIRM_GATE_BLOCKED + gateCode + 豁免单号（不是 UNKNOWN_ERROR）', async () => {
    mockedCommit.mockResolvedValueOnce({
      ok: false,
      committed: false,
      poNumber: 'PO-001',
      error: 'CONFIRM_GATE_BLOCKED: 订单数量 100 低于 MOQ 500（缺口 80%，快照口径），须先完成 MOQ 豁免审批（DR-007 单人单次）（豁免审批单 APR__X 已自动发起，审批通过后重试）',
      errorFeedback: {
        code: 'CONFIRM_GATE_BLOCKED',
        message: 'CONFIRM_GATE_BLOCKED: 订单数量 100 低于 MOQ 500…',
        userAction: '订单确认被业务门禁（信用/MOQ/信用证）阻断：请按 message 完成对应的豁免审批或信用证登记后重试。审批通过 ≠ 门禁通过，两道都要过。',
        gateCode: 'MOQ_VIOLATION',
        approvalRequestId: 'APR__X',
        retryable: false,
      },
    });
    const out = await replay();
    expect(out.ok).toBe(false);
    expect(out.errorFeedback.code, '塌成 UNKNOWN_ERROR = 本批接的门禁对用户等于没接').toBe('CONFIRM_GATE_BLOCKED');
    expect(out.errorFeedback.gateCode).toBe('MOQ_VIOLATION');
    expect(out.errorFeedback.approvalRequestId).toBe('APR__X');
    expect(out.errorFeedback.userAction).toContain('门禁');
    expect(out.errorFeedback.retryable).toBe(false);
  });

  it('★ L/C 阻断（开票腿）同样原样透出；retryable 不许被硬编码成 false 之外的值', async () => {
    mockedCommit.mockResolvedValueOnce({
      ok: false,
      committed: false,
      error: 'LC_GATE_BLOCKED: 该订单以信用证结算但未登记可用信用证（LC_NOT_REGISTERED）',
      errorFeedback: { code: 'LC_GATE_BLOCKED', message: 'LC_GATE_BLOCKED: …', userAction: '请先登记 L/C', retryable: true },
    });
    const out = await replay();
    expect(out.errorFeedback.code).toBe('LC_GATE_BLOCKED');
    expect(out.errorFeedback.retryable, 'CommitResult 自己说可重试就得以它为准（原来一律写死 false）').toBe(true);
  });

  it('★ 反向对照：老式失败（没有 errorFeedback，只有 error 串）不塌成空对象，仍给得出可判别码', async () => {
    mockedCommit.mockResolvedValueOnce({ ok: false, committed: false, error: 'COMMIT_CONFLICT: rolled back' });
    const out = await replay();
    expect(out.errorFeedback.code).toBe('COMMIT_FAILED');
    expect(out.errorFeedback.message).toContain('COMMIT_CONFLICT');
    expect(out.errorFeedback.retryable).toBe(false);
  });
});
