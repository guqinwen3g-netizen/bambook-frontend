/**
 * 审计流水摘要（同一份真源被两个出口消费：订单详情的「订单变更历史」浮层 + 管理面板「系统日志」表）
 *
 * ★ v3.237 补 35：这一族文字原先只住在 `components/AuditHistorySection.tsx` 内部，而库里
 *   `fieldPath` 非空的 57 行分布在 8 个 targetType 上、只有订单那一类有浮层出口
 *   ⇒ 其余 53 行的"原值 → 新值"在任何屏面上都读不到（管理面板那行 `targetType:targetId` 只有动作码）。
 *   把摘要逻辑提出来共享，而不是在 AdminPanel 里再抄一份（本仓头号病是多套并行真源）。
 *
 * ★ 行为钉法：本文件断言的是**搬家前那份实现的行为**，包括两处"看着像缺陷但不是本批改的"
 *   地方（`order:confirm` 这类冒号族不翻译、`fieldPath` 直接打列名）——那两格已另立 §9 B286 等口径，
 *   提取重构不许顺手改掉它（改了就等于把"搬家"和"改行为"混进同一批，读的人分不清哪一格为什么红）。
 */

import { describe, it, expect } from 'vitest';
import { auditRowSummary } from '../lib/auditSummary';

describe('审计流水摘要：字段级优先、动作码兜底', () => {
  it('有 fieldPath ⇒ 打「列名: 原值 → 新值」', () => {
    expect(auditRowSummary({ fieldPath: 'unitPrice', beforeValue: 12, afterValue: 13 }))
      .toBe('unitPrice: 12 → 13');
  });

  it('原值/新值取不到（null）⇒ 交「—」，不伪造空串', () => {
    expect(auditRowSummary({ fieldPath: 'specialInstructions', beforeValue: null, afterValue: '备注 A' }))
      .toBe('specialInstructions: — → 备注 A');
  });

  it('值是**对象**⇒ JSON 化并截到 60 字符加省略号（★ 现状：字符串本身不截，只截对象）', () => {
    const s = auditRowSummary({ fieldPath: 'metadata', beforeValue: { a: 'x'.repeat(80) }, afterValue: null });
    expect(s.startsWith('metadata: {"a":"xxxxxxxxxx')).toBe(true);
    expect(s).toContain('…');
    expect(s.length).toBeLessThan(120);
    // 反面对照：同样的长度但以**字符串**交进来 ⇒ 原样输出（钉住"只截对象"这条现状行为，别以为两出口都会截断）
    const asString = auditRowSummary({ fieldPath: 'metadata', beforeValue: 'x'.repeat(80), afterValue: null });
    expect(asString).not.toContain('…');
    expect(asString.length).toBeGreaterThan(80);
  });

  it('无 fieldPath ⇒ 回退动作摘要：下划线族翻中文前缀（现状行为）', () => {
    expect(auditRowSummary({ action: 'create_order' })).toBe('创建 · order');
    expect(auditRowSummary({ action: 'update_order' })).toBe('更新 · order');
    expect(auditRowSummary({ action: 'delete_invoice' })).toBe('删除 · invoice');
    expect(auditRowSummary({ action: 'cancel_order' })).toBe('作废 · order');
  });

  it('★ 冒号族动作码**现状不翻译**（§9 B286 待拍，本批不顺手改）', () => {
    expect(auditRowSummary({ action: 'order:confirm' })).toBe('order:confirm');
  });

  it('★ 列名直接上屏（同上：B286 那一格归使用方拍，这里只钉住"搬家没改行为"）', () => {
    expect(auditRowSummary({ fieldPath: 'departmentId', beforeValue: null, afterValue: 'dept-sales' }))
      .toBe('departmentId: — → dept-sales');
  });

  it('两列全空（只有 action 的旧行形状）⇒ 不抛错、不输出 undefined', () => {
    const s = auditRowSummary({ action: 'transition' });
    expect(s).toBe('transition');
    expect(s).not.toContain('undefined');
  });
});
