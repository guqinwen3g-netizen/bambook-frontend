import { describe, expect, it } from 'vitest';
import {
  ORDER_LIFECYCLE_ERROR_HTTP_STATUS,
  ORDER_LIFECYCLE_EXTENSION_ERRORS,
  type OrderLifecycleErrorCode,
  type OrderLifecycleExtensionErrorCode,
} from '../orderLifecycleService';
import { CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS, type CreditExceptionConsumptionErrorCode } from '../../credit/creditExceptionGate';

/**
 * 结构守卫：**错误码 → HTTP 状态码** 的映射必须完整、且不得回落 500。
 *
 * 背景（本仓已三次踩同一坑）：调用点各自维护硬编码 `statusCodeMap[code] || 500`，
 * 新增业务码忘了补 → 用户看到「服务器错误」而实际只是状态/参数问题。
 *   ① `allocationMutationService.toAllocationError`（handoff-20260917-051500 T5）
 *   ② `invoiceMutationService.toError`（handoff-20260917-074500）
 *   ③ `orders/route.ts` status-transition 漏 DR-010 守卫码
 *      （2026-09-17 真库演练 acceptance-pending-cancel-path.mjs S11 实测：应 409，实为 500）
 *
 * 这里做两件事：
 *   - 把「联合类型里的每个码都要有映射」变成**运行时可断言**的事实
 *     （编译期已由 `Record<...>` 强制，本测试是防有人把它改回 `Record<string, number>`）；
 *   - 断言两个 DR-010 守卫码是 **409**，不是 500 —— 这条就是本次回归的门禁。
 */

const ALL_LIFECYCLE_CODES: (OrderLifecycleErrorCode | OrderLifecycleExtensionErrorCode | CreditExceptionConsumptionErrorCode)[] = [
  'ORDER_NOT_FOUND',
  'ORDER_ALREADY_DELETED',
  'INVALID_STATUS',
  'INVALID_TRANSITION',
  'ORDER_LINE_WORKFLOW_REQUIRED',
  'NO_CHANGE',
  'DELETE_FAILED',
  'TRANSITION_FAILED',
  'MOQ_VIOLATION',
  'CREDIT_FROZEN_60_DAYS',
  'CREDIT_REVOKED',
  'OVERDUE_60_DAYS',
  'CREDIT_CHECK_FAILED',
  // G-4：L/C 门禁两码 —— 阻断 403（与信用门禁同档）；"例外状态查不出来" 500（下一步是排障不是补证）
  'LC_GATE_BLOCKED',
  'LC_EXCEPTION_CHECK_FAILED',
  // B14：依赖校验没结论 ⇒ 拒删。缺这行时上面的运行时守卫抓不到（联合类型靠 Record 强制，
  // 本列表是手抄的第二道），但下面的 503 断言会红。
  'DEPENDENCY_CHECK_FAILED',
  ...Object.values(ORDER_LIFECYCLE_EXTENSION_ERRORS),
  ...Object.keys(CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS) as CreditExceptionConsumptionErrorCode[],
];

describe('ORDER_LIFECYCLE_ERROR_HTTP_STATUS 结构守卫', () => {
  it('每个订单生命周期错误码都有 HTTP 映射（无遗漏 → 不会兜成 500）', () => {
    const missing = ALL_LIFECYCLE_CODES.filter((c) => ORDER_LIFECYCLE_ERROR_HTTP_STATUS[c] === undefined);
    expect(missing, `缺映射的错误码：${missing.join(', ')}`).toEqual([]);
  });

  it('★ DR-010 守卫态 / 已关闭终态 = 409（本次回归门禁：曾兜成 500）', () => {
    expect(ORDER_LIFECYCLE_ERROR_HTTP_STATUS.ORDER_LIFECYCLE_GUARDED).toBe(409);
    expect(ORDER_LIFECYCLE_ERROR_HTTP_STATUS.ORDER_ALREADY_CLOSED).toBe(409);
  });

  it('逐条目履约 required = 409（旧主单级投产/出运写入必须拒绝）', () => {
    expect(ORDER_LIFECYCLE_ERROR_HTTP_STATUS.ORDER_LINE_WORKFLOW_REQUIRED).toBe(409);
  });

  /**
   * ★ B14（refs G3-LA · T2）：依赖校验没结论 ⇒ 503，不是 500、不是 409。
   * 期望依据是 HTTP 语义本身，不是实现现值：
   *   · 503 Service Unavailable —— 服务端**无法完成本次请求所依赖的前置校验**，且可重试；
   *   · 409 已被「查到确实有依赖」占着（HAS_DEPENDENTS），两者对用户的下一步完全不同；
   *   · 500 是 DELETE_FAILED（删除动作真的失败）的档，把「没查清」报成 500 会诱导用户以为已删。
   * 少一行映射就会 `|| 500` 兜底 —— 本仓第 4 次踩同一坑（见该常量注释）。
   */
  it('★ DEPENDENCY_CHECK_FAILED = 503（B14：校验没结论 ≠ 删除失败，不许兜成 500）', () => {
    expect(ORDER_LIFECYCLE_ERROR_HTTP_STATUS.DEPENDENCY_CHECK_FAILED).toBe(503);
  });

  it('所有映射值都是合法 HTTP 状态码（400..599），且不含 200 族', () => {
    const bad = Object.entries(ORDER_LIFECYCLE_ERROR_HTTP_STATUS)
      .filter(([, v]) => !Number.isInteger(v) || v < 400 || v > 599)
      .map(([k, v]) => `${k}=${v}`);
    expect(bad).toEqual([]);
  });

  it('「用户可自行修正」的错（状态/参数/冲突）不得映射成 500', () => {
    // 500 只留给真正的服务端故障：事务失败 / 门禁自身故障
    // 白名单 = 真正的"服务端自己没结论"，用户重试/自改都无用：
    //   LC_EXCEPTION_CHECK_FAILED 与 CREDIT_CHECK_FAILED 同类（门禁要查 DR-013 例外却查不出来 ⇒ 保持阻断），
    //   不是"用户可自行修正"的码 —— 登记进来而不是改成 4xx，免得屏面把服务故障说成用户操作错。
    const serverFaultCodes = new Set(['DELETE_FAILED', 'TRANSITION_FAILED', 'CREDIT_CHECK_FAILED', 'LC_EXCEPTION_CHECK_FAILED', 'EXCEPTION_CONSUME_FAILED']);
    const wrongly500 = Object.entries(ORDER_LIFECYCLE_ERROR_HTTP_STATUS)
      .filter(([k, v]) => v === 500 && !serverFaultCodes.has(k))
      .map(([k]) => k);
    expect(wrongly500, `不该是 500 的码：${wrongly500.join(', ')}`).toEqual([]);
  });
});
