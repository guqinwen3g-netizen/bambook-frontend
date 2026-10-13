import { describe, expect, it, vi } from 'vitest';
import {
  assertGateOrThrow,
  bindExceptionChecker,
  EXCEPTION_CATEGORIES,
  EXCEPTION_ENTRY_HINT,
  GATE_BLOCKED,
  GateBlockedError,
  type ExceptionCheckResult,
} from '../exceptionGate';

/**
 * DR-013 门禁 SDK 纯函数契约测试：
 *   assertGateOrThrow — 正常资格直放 / 生效例外放行 / 无例外抛 GateBlockedError
 *   GateBlockedError  — code/statusCode/blockingReasons/入口提示/失效原因
 *   bindExceptionChecker — 固定 scope 绑定
 *   EXCEPTION_CATEGORIES — 9 类枚举（8 类 + credit_exemption，schema 注释真源）
 */

const activeCheck: ExceptionCheckResult = {
  active: true,
  exception: {
    id: 'EXC__1',
    exceptionNumber: 'EXC-20260816-001',
    exceptionCategory: 'shipment_release',
    subCategory: 'without_ss_confirmed',
    status: 'ReviewerApproved',
    bossFinalBypass: false,
    validUntil: null,
  },
};

describe('assertGateOrThrow（DR-013 门禁消费模式）', () => {
  it('具备正常资格 → passedVia=gate（不触碰例外查询）', async () => {
    const checker = vi.fn(async () => activeCheck);
    const r = await assertGateOrThrow({ eligible: true, gate: 'shipment_release' }, checker);
    expect(r).toEqual({ passedVia: 'gate' });
    expect(checker).not.toHaveBeenCalled();
  });

  it('不具备资格 + 生效例外精确命中 → passedVia=exception + 例外摘要（DR013-B2 徽标数据源）', async () => {
    const r = await assertGateOrThrow(
      { eligible: false, gate: 'shipment_release', blockingReasons: ['SS_NOT_CONFIRMED'] },
      async () => activeCheck,
    );
    expect(r.passedVia).toBe('exception');
    if (r.passedVia === 'exception') {
      expect(r.exception.id).toBe('EXC__1');
      expect(r.exception.exceptionNumber).toBe('EXC-20260816-001');
    }
  });

  it('不具备资格 + 无任何例外 → 抛 GateBlockedError（fail-closed + 申请入口提示，DEV-13-A1）', async () => {
    const promise = assertGateOrThrow(
      { eligible: false, gate: 'shipment_release', blockingReasons: ['SS_NOT_CONFIRMED'] },
      async () => ({ active: false, reason: 'NO_ACTIVE_EXCEPTION' as const }),
    );
    await expect(promise).rejects.toMatchObject({
      code: GATE_BLOCKED,
      statusCode: 409,
      blockingReasons: ['SS_NOT_CONFIRMED'],
      exceptionReason: 'NO_ACTIVE_EXCEPTION',
    });
    await expect(promise).rejects.toThrow(EXCEPTION_ENTRY_HINT);
  });

  it('例外未获批准 → 抛错且 exceptionReason=EXCEPTION_NOT_APPROVED（保持原门禁）', async () => {
    const promise = assertGateOrThrow(
      { eligible: false, gate: 'price_deviation', blockingReasons: ['DEVIATION_OVER_BLOCK'] },
      { active: false, reason: 'EXCEPTION_NOT_APPROVED' },
    );
    await expect(promise).rejects.toMatchObject({ exceptionReason: 'EXCEPTION_NOT_APPROVED' });
  });

  it('例外已过期 → 抛错消息引导重新申请（DR013-B5）', async () => {
    const promise = assertGateOrThrow(
      { eligible: false, gate: 'shipment_release' },
      { active: false, reason: 'EXCEPTION_EXPIRED' },
    );
    await expect(promise).rejects.toThrow('重新申请');
    await expect(promise).rejects.toMatchObject({ exceptionReason: 'EXCEPTION_EXPIRED' });
  });

  it('一次性例外已核销 → 抛错且 exceptionReason=EXCEPTION_ALREADY_CONSUMED（DEV-13-B2）', async () => {
    const promise = assertGateOrThrow(
      { eligible: false },
      { active: false, reason: 'EXCEPTION_ALREADY_CONSUMED' },
    );
    await expect(promise).rejects.toMatchObject({ exceptionReason: 'EXCEPTION_ALREADY_CONSUMED' });
  });

  it('GateBlockedError 是 Error 实例且 name 正确（route 层可安全识别）', async () => {
    try {
      await assertGateOrThrow({ eligible: false }, { active: false });
      expect.unreachable('应当抛 GateBlockedError');
    } catch (e: any) {
      expect(e).toBeInstanceOf(GateBlockedError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('GateBlockedError');
    }
  });
});

describe('bindExceptionChecker（固定 scope 绑定）', () => {
  it('绑定 targetType+action 后按 targetId 查询', async () => {
    const hasActive = vi.fn(async () => activeCheck);
    const check = bindExceptionChecker(hasActive, { targetType: 'Shipment', action: 'shipment:release' });
    const at = new Date('2026-09-01T00:00:00Z');
    const r = await check('SHIP_003', at);
    expect(r.active).toBe(true);
    expect(hasActive).toHaveBeenCalledWith({
      targetType: 'Shipment',
      targetId: 'SHIP_003',
      action: 'shipment:release',
      at,
    });
  });
});

describe('EXCEPTION_CATEGORIES（9 类枚举：8 类 + credit_exemption，schema 注释真源）', () => {
  it('精确等于任务契约 9 类（DE-5 信用例外入口）', () => {
    expect([...EXCEPTION_CATEGORIES]).toEqual([
      'moq_exemption',
      'price_deviation',
      'order_change',
      'shipment_release',
      'qc_fault',
      'payment_term',
      'sample_skip',
      'credit_exemption',
      'other',
    ]);
  });
});
