/**
 * paymentRequestScope.ts — 付款申请「三档数据范围」的 where / 可见性构造（**口径 B3**）。
 *
 * ── 口径（业务方 2026-09-17 15:00 拍板）────────────────────
 * 付款申请**套三档数据范围**：业务员只看自己提的与负责的；部门主管看本部门；
 * 财务与领导看全部。
 * ★ **子问题一并定**：**被指派的审批人 `reviewerId` 恒可见** —— 否则审批根本没法做。
 * 见 `docs/业务口径决策单-2026-09-17.md` **B3**。
 *
 * ── 修前的缺陷（P4-1 #18 实测）───────────────────────────
 * 业务员档可读财务/后勤/其他业务员名下的**全部**付款申请
 * （含供应商名与金额，实测最大一笔 166,864.00）。
 *
 * ── 为什么单独成文件 ─────────────────────────────────────
 * ① 纯函数（只吃 resolver 结果）⇒ 可单测、mock 不受影响；
 * ② 列表与详情**共用同一构造**，避免"列表过滤了、详情没过滤"（改个 id 就能看）的收口点错位；
 * ③ `PaymentRequest` **没有 `departmentId` 字段** ⇒ 不能直接用 `dataScopeWhere` 的
 *    `{ownerId, departmentId}` 拼法，需按 **`applicantId` ∈ 解析后的用户集** 表达。
 */

import type { DataScopeResolverLike } from '../auth/dataScopeWhere';

export interface PaymentRequestScope {
  /** `true` = 不过滤（rule.kind === 'all'：财务/领导/SuperAdmin） */
  unrestricted: boolean;
  /** 允许看见的申请人 userId 集合（恒含本人） */
  allowedUserIds: readonly string[];
  /** 当前 actor（用于 `reviewerId === actorUserId` 豁免） */
  actorUserId: string;
  /** 可直接并入 `where.AND` 的片段（`unrestricted` 时为空对象） */
  where: Record<string, unknown>;
}

/**
 * 由数据范围解析结果构造付款申请的范围。
 *
 * `all` 档 → 不过滤；其余档 → `OR[applicantId ∈ 用户集, reviewerId = 本人]`。
 * ⚠️ 用户集**恒含本人**：`self` 档解析器已返回 `[本人]`，此处再兜一次
 *   （防止解析器返回空集时把自己也挡在外面）。
 */
export function buildPaymentRequestScope(
  resolver: DataScopeResolverLike,
  actorUserId: string,
): PaymentRequestScope {
  if (resolver.rule.kind === 'all') {
    return { unrestricted: true, allowedUserIds: [], actorUserId, where: {} };
  }
  const allowedUserIds = Array.from(
    new Set([...(resolver.allowedUserIds ?? []), actorUserId].filter(Boolean)),
  );
  return {
    unrestricted: false,
    allowedUserIds,
    actorUserId,
    where: {
      OR: [
        { applicantId: { in: allowedUserIds } },
        // ★ 豁免：被指派的审批人恒可见 —— 去掉这条，跨组审批人会看不到自己要批的单
        { reviewerId: actorUserId },
      ],
    },
  };
}

/**
 * ★ **单行可见性判定 —— 列表 where 与详情/预览检查的共用判据**。
 *
 * 为什么必须共用：本判据（含「审批人恒可见」豁免）天然会被写在
 * ① 列表 where 片段 ② 详情端点 ③ 预览端点 三处。**各写一份必然漂移**
 * —— 实测过一次：只改 where 里的豁免，详情端点仍走自己的判断，
 * 于是「列表能看到、详情看不到」（或反之）。收成一处后，任何一侧改动都会同时生效。
 *
 * ⚠️ 与 `where` 的**语义一致性**由 `paymentRequestScope.test.ts` 的对撞用例保证
 * （同一组 (item, scope) 必须得到「where 命中 ⟺ canSee 为真」的同一结论）。
 */
export function canSeePaymentRequest(
  item: { applicantId: string; reviewerId?: string | null },
  scope: PaymentRequestScope,
): boolean {
  if (scope.unrestricted) return true;
  return (
    scope.allowedUserIds.includes(item.applicantId)
    || item.reviewerId === scope.actorUserId
  );
}
