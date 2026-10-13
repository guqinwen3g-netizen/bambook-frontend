import { describe, expect, it, vi, beforeEach } from 'vitest';
import { registerTool, registerCommitTool, dispatchFromRegistry, getRegisteredToolIds, getRegisteredToolCount } from '../toolDispatchRegistry';
import { PrismaClient } from '@prisma/client';

const mockPrisma = {
  approvalRequest: {
    findUnique: vi.fn(),
  },
  agentCommitReceipt: {
    create: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
} as unknown as PrismaClient;

const receipts = (mockPrisma as any).agentCommitReceipt;

describe('toolDispatchRegistry: simple tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('register + dispatch roundtrip', async () => {
    registerTool('test.simple.add', async (_prisma, input) => {
      return { ok: true, sum: (input.a as number) + (input.b as number) };
    });

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.simple.add',
      input: { a: 3, b: 4 },
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(true);
      expect(result.result.sum).toBe(7);
    }
  });

  it('unregistered tool → hit=false', async () => {
    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'nonexistent.tool',
      input: {},
    });
    expect(result.hit).toBe(false);
  });
});

describe('toolDispatchRegistry: commit tools (approval boilerplate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('missing approvalId → APPROVAL_ID_MISSING', async () => {
    registerCommitTool('test.commit.noapproval', async () => ({ ok: true }));

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.commit.noapproval',
      input: {},
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    }
  });

  it('approval not found → APPROVAL_NOT_FOUND', async () => {
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue(null);
    registerCommitTool('test.commit.notfound', async () => ({ ok: true }));

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.commit.notfound',
      input: {},
      approvalId: 'appr_missing',
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).errorFeedback.code).toBe('APPROVAL_NOT_FOUND');
    }
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue({
      id: 'appr_1',
      status: 'pending',
      payload: {},
    });
    registerCommitTool('test.commit.pending', async () => ({ ok: true }));

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.commit.pending',
      input: {},
      approvalId: 'appr_1',
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).errorFeedback.code).toBe('APPROVAL_PENDING');
    }
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue({
      id: 'appr_2',
      status: 'modified',
      payload: {},
    });
    registerCommitTool('test.commit.modified', async () => ({ ok: true }));

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.commit.modified',
      input: {},
      approvalId: 'appr_2',
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    }
  });

  it('approval approved → commit function called with correct context', async () => {
    const mockPayload = { input: { poNumber: 'PO-001' }, draft: { totalAmount: 1000 } };
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue({
      id: 'appr_ok',
      status: 'approved', actionType: 'tool:test.commit.success',
      payload: mockPayload,
    });

    let capturedCtx: any = null;
    registerCommitTool('test.commit.success', async (ctx) => {
      capturedCtx = ctx;
      return { ok: true, committed: true, orderId: 'O-123' };
    });

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.commit.success',
      input: { poNumber: 'PO-001' },
      approvalId: 'appr_ok',
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(true);
      expect((result.result as any).committed).toBe(true);
      expect((result.result as any).orderId).toBe('O-123');
    }

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.approvalId).toBe('appr_ok');
    expect(capturedCtx.approvalPayload).toEqual(mockPayload);
    expect(capturedCtx.prisma).toBe(mockPrisma);
  });

  it('approval actionType 与 toolId 不匹配 → CROSS_APPROVAL_BINDING fail-closed，commitFn 不执行', async () => {
    // 安全场景：A 工具的审批单被 B 工具的 commit 消费（跨审批绑定攻击）
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue({
      id: 'appr_cross',
      status: 'approved',
      actionType: 'tool:test.commit.attacker',
      payload: {},
    });
    const commitFn = vi.fn(async () => ({ ok: true }));
    registerCommitTool('test.commit.victim', commitFn);

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.commit.victim',
      input: {},
      approvalId: 'appr_cross',
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).committed).toBe(false);
      expect((result.result as any).errorFeedback.code).toBe('CROSS_APPROVAL_BINDING');
      expect((result.result as any).errorFeedback.retryable).toBe(false);
    }
    expect(commitFn).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// Phase 2 · 任务 2.1：commit 幂等去重（AgentCommitReceipt 统一收口）
// ══════════════════════════════════════════════════════════════
describe('toolDispatchRegistry: commit 幂等去重（Phase 2 · 2.1）', () => {
  const approvedApproval = { id: 'appr_idem', status: 'approved', actionType: 'tool:test.idem.first', payload: {} };

  beforeEach(() => {
    vi.clearAllMocks();
    receipts.create.mockImplementation(async () => ({}));
    receipts.findUnique.mockResolvedValue(null);
    receipts.update.mockResolvedValue({});
    receipts.delete.mockResolvedValue({});
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue(approvedApproval);
  });

  it('首次 commit 成功 → receipt 先占 committing 后置 committed，缓存结果', async () => {
    const commitFn = vi.fn(async () => ({ ok: true, committed: true, entityId: 'E-1' }));
    registerCommitTool('test.idem.first', commitFn);

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.idem.first',
      input: {},
      approvalId: 'appr_idem',
    });

    expect(result.hit && result.result.ok).toBe(true);
    expect(commitFn).toHaveBeenCalledTimes(1);
    // receipt 以统一 key 占位
    expect(receipts.create).toHaveBeenCalledTimes(1);
    expect(receipts.create.mock.calls[0][0].data).toMatchObject({
      idempotencyKey: 'commit:test.idem.first:appr_idem',
      toolId: 'test.idem.first',
      approvalId: 'appr_idem',
      status: 'committing',
    });
    // 成功后落 committed + 缓存结果
    expect(receipts.update).toHaveBeenCalledTimes(1);
    expect(receipts.update.mock.calls[0][0].data.status).toBe('committed');
    expect(receipts.update.mock.calls[0][0].data.result).toMatchObject({ entityId: 'E-1' });
    expect(receipts.delete).not.toHaveBeenCalled();
  });

  it('重放（P2002 + receipt 已 committed）→ 返回缓存结果，commitFn 不再执行', async () => {
    receipts.create.mockRejectedValue({ code: 'P2002' });
    receipts.findUnique.mockResolvedValue({
      status: 'committed',
      result: { ok: true, committed: true, entityId: 'E-1' },
    });
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue({ ...approvedApproval, actionType: 'tool:test.idem.replay' });
    const commitFn = vi.fn(async () => ({ ok: true }));
    registerCommitTool('test.idem.replay', commitFn);

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.idem.replay',
      input: {},
      approvalId: 'appr_idem',
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(true);
      expect((result.result as any).entityId).toBe('E-1');
      expect((result.result as any).replayed).toBe(true);
    }
    expect(commitFn).not.toHaveBeenCalled();
  });

  it('重放（P2002 + receipt 仍 committing，崩溃窗口）→ COMMIT_REPLAY_BLOCKED fail-closed', async () => {
    receipts.create.mockRejectedValue({ code: 'P2002' });
    receipts.findUnique.mockResolvedValue({ status: 'committing', result: null });
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue({ ...approvedApproval, actionType: 'tool:test.idem.inflight' });
    const commitFn = vi.fn(async () => ({ ok: true }));
    registerCommitTool('test.idem.inflight', commitFn);

    const result = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.idem.inflight',
      input: {},
      approvalId: 'appr_idem',
    });

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.result.ok).toBe(false);
      expect((result.result as any).errorFeedback.code).toBe('COMMIT_REPLAY_BLOCKED');
      expect((result.result as any).errorFeedback.retryable).toBe(false);
    }
    expect(commitFn).not.toHaveBeenCalled();
  });

  it('commit 失败（ok:false）→ 删除 receipt 允许重试；重试时 commitFn 再次执行', async () => {
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue({ ...approvedApproval, actionType: 'tool:test.idem.retry' });
    const commitFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'boom' })
      .mockResolvedValueOnce({ ok: true, committed: true });
    registerCommitTool('test.idem.retry', commitFn);

    const first = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.idem.retry',
      input: {},
      approvalId: 'appr_idem',
    });
    expect(first.hit && first.result.ok).toBe(false);
    expect(receipts.delete).toHaveBeenCalledTimes(1);

    const second = await dispatchFromRegistry(mockPrisma, {
      toolId: 'test.idem.retry',
      input: {},
      approvalId: 'appr_idem',
    });
    expect(second.hit && second.result.ok).toBe(true);
    expect(commitFn).toHaveBeenCalledTimes(2);
  });

  it('commitFn 抛异常 → 删除 receipt 并向上抛出（不吞错误）', async () => {
    (mockPrisma.approvalRequest.findUnique as any).mockResolvedValue({ ...approvedApproval, actionType: 'tool:test.idem.throw' });
    const commitFn = vi.fn(async () => { throw new Error('tx exploded'); });
    registerCommitTool('test.idem.throw', commitFn);

    await expect(
      dispatchFromRegistry(mockPrisma, {
        toolId: 'test.idem.throw',
        input: {},
        approvalId: 'appr_idem',
      }),
    ).rejects.toThrow('tx exploded');
    expect(receipts.delete).toHaveBeenCalledTimes(1);
    expect(receipts.update).not.toHaveBeenCalled();
  });
});

describe('toolDispatchRegistry: introspection', () => {
  it('getRegisteredToolIds returns sorted array', () => {
    registerTool('test.zebra', async () => ({ ok: true }));
    registerTool('test.alpha', async () => ({ ok: true }));
    const ids = getRegisteredToolIds();
    const zebraIdx = ids.indexOf('test.zebra');
    const alphaIdx = ids.indexOf('test.alpha');
    expect(alphaIdx).toBeLessThan(zebraIdx); // sorted
  });

  it('getRegisteredToolCount increases after registration', () => {
    const before = getRegisteredToolCount();
    registerTool('test.count_check', async () => ({ ok: true }));
    const after = getRegisteredToolCount();
    expect(after).toBe(before + 1);
  });
});
