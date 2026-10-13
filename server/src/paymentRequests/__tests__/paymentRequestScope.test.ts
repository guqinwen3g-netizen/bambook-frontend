/**
 * `paymentRequestScope` 单测（口径 B3）—— 含**对撞测试**：`where` 与 `canSeePaymentRequest` 同源
 *
 * ── 为什么要对撞 ─────────────────────────────────────────
 * 本模块的可见性判据天然会被用在两处：① 列表 `where` 片段；② 详情/预览的单行判定。
 * **各写一份必然漂移** —— 实测过一次：只改 `where` 里的「审批人豁免」，详情端点仍走自己的判断，
 * 于是「列表能看到、详情看不到」。本文件用同一组 `(item, scope)` 断言
 * **「where 命中 ⟺ canSee 为真」**，把两处钉在一起。
 *
 * 其中 `whereMatches` 是一个**只支持本模块用到的 where 形状**的极简求值器
 * （`{ OR: [{ applicantId: { in: [] } }, { reviewerId: v }] }`）——
 * 刻意手写、不引 Prisma，避免"用被测对象验证被测对象"。
 */
import { describe, expect, it } from 'vitest';
import { buildPaymentRequestScope, canSeePaymentRequest } from '../paymentRequestScope';

/** 极简 where 求值器（仅支持本模块产生的形状；形状变了要同步改，否则会红） */
function whereMatches(where: any, item: { applicantId: string; reviewerId?: string | null }): boolean {
  if (!where || Object.keys(where).length === 0) return true; // 不过滤
  const ors: any[] = where.OR ?? [];
  return ors.some((cond) => {
    if (cond.applicantId?.in) return cond.applicantId.in.includes(item.applicantId);
    if (cond.reviewerId !== undefined) return item.reviewerId === cond.reviewerId;
    return false;
  });
}

const resolver = (kind: 'self' | 'team' | 'all', ids: string[] = []) =>
  ({ rule: { kind }, allowedUserIds: ids, allowedDepartmentIds: [] }) as any;

describe('★ 口径 B3：三档数据范围构造', () => {
  it('all 档 → unrestricted，where 为空（不过滤）', () => {
    const s = buildPaymentRequestScope(resolver('all'), 'u_me');
    expect(s.unrestricted).toBe(true);
    expect(s.where).toEqual({});
  });

  it('self 档 → 用户集**恒含本人**（即使解析器返回空集，也不能把自己挡在外面）', () => {
    const s = buildPaymentRequestScope(resolver('self', []), 'u_me');
    expect(s.unrestricted).toBe(false);
    expect(s.allowedUserIds).toContain('u_me');
  });

  it('team 档 → 用户集 = 同组 ∪ 本人（去重）', () => {
    const s = buildPaymentRequestScope(resolver('team', ['u_a', 'u_me']), 'u_me');
    expect(s.allowedUserIds.sort()).toEqual(['u_a', 'u_me']);
  });

  it('非 all 档 → where 含**审批人豁免**分支', () => {
    const s = buildPaymentRequestScope(resolver('self'), 'u_me');
    expect(s.where.OR).toContainEqual({ reviewerId: 'u_me' });
  });
});

describe('★★ 对撞：where 命中 ⟺ canSeePaymentRequest 为真（防两处漂移）', () => {
  const cases: Array<{
    name: string;
    kind: 'self' | 'team' | 'all';
    ids: string[];
    actor: string;
    item: { applicantId: string; reviewerId: string | null };
  }> = [
    { name: 'self · 本人申请', kind: 'self', ids: [], actor: 'u_me', item: { applicantId: 'u_me', reviewerId: 'u_boss' } },
    { name: 'self · 他人申请（非审批人）', kind: 'self', ids: [], actor: 'u_me', item: { applicantId: 'u_other', reviewerId: 'u_boss' } },
    { name: '★ self · 他人申请但我是审批人（豁免）', kind: 'self', ids: [], actor: 'u_boss', item: { applicantId: 'u_other', reviewerId: 'u_boss' } },
    { name: 'team · 同组申请', kind: 'team', ids: ['u_me', 'u_mate'], actor: 'u_me', item: { applicantId: 'u_mate', reviewerId: 'u_boss' } },
    { name: 'team · 组外申请', kind: 'team', ids: ['u_me', 'u_mate'], actor: 'u_me', item: { applicantId: 'u_stranger', reviewerId: 'u_boss' } },
    { name: 'all · 任意申请', kind: 'all', ids: [], actor: 'u_fin', item: { applicantId: 'u_anyone', reviewerId: 'u_boss' } },
  ];

  it.each(cases)('$name', ({ kind, ids, actor, item }) => {
    const scope = buildPaymentRequestScope(resolver(kind, ids), actor);
    const byWhere = whereMatches(scope.where, item);
    const byPredicate = canSeePaymentRequest(item, scope);
    // ★ 承重：两条路径必须给出**同一结论**
    expect(byPredicate).toBe(byWhere);
  });

  it('★ 豁免用例确实为 true（防止上面全是 false 而空过）', () => {
    const scope = buildPaymentRequestScope(resolver('self'), 'u_boss');
    const item = { applicantId: 'u_other', reviewerId: 'u_boss' };
    expect(canSeePaymentRequest(item, scope)).toBe(true);
    expect(whereMatches(scope.where, item)).toBe(true);
  });

  it('★ 反向用例确实为 false（防止上面全是 true 而空过）', () => {
    const scope = buildPaymentRequestScope(resolver('self'), 'u_me');
    const item = { applicantId: 'u_other', reviewerId: 'u_boss' };
    expect(canSeePaymentRequest(item, scope)).toBe(false);
    expect(whereMatches(scope.where, item)).toBe(false);
  });
});
