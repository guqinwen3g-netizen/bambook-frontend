/**
 * T3 · 盘点清零（Adjustment quantity=0）服务端测试
 *
 * 缺陷：路由与 Agent Flow 都拒 quantity <= 0，而 Adjustment 的 quantity 语义是
 *       「盘点后实际总数」目标绝对值（服务层 qtyDelta = moveQty - currentQty），
 *       0 = 盘点清零是合法语义却被拦。修复口径：仅 Adjustment 允许 0，其余类型仍须 > 0
 *       （不要整条放开）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateInventoryAdjustStockDraftSemantics } from '../../agent/inventoryFlow';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

describe('inventory.adjust_stock 语义校验：Adjustment 允许 0（盘点清零）', () => {
  const base = { itemId: 'INV_1' };

  it('Adjustment quantity=0 → 通过（清零合法）', () => {
    const r = validateInventoryAdjustStockDraftSemantics({
      subOperations: [{ after: { ...base, type: 'Adjustment', quantity: 0 } }],
    });
    expect(r.ok).toBe(true);
  });

  it('Inbound quantity=0 → 拒绝（非盘点类型必须 > 0）', () => {
    const r = validateInventoryAdjustStockDraftSemantics({
      subOperations: [{ after: { ...base, type: 'Inbound', quantity: 0 } }],
    });
    expect(r.ok).toBe(false);
  });

  it('负数 → 拒绝（任意类型）', () => {
    for (const type of ['Inbound', 'Outbound', 'Adjustment', 'Lock', 'Unlock']) {
      const r = validateInventoryAdjustStockDraftSemantics({
        subOperations: [{ after: { ...base, type, quantity: -1 } }],
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe('inventoryRoute POST /movements：0 的放行只对 Adjustment（契约钉住，防整条放开）', () => {
  const src = stripComments(readFileSync(new URL('../inventoryRoute.ts', import.meta.url), 'utf8'));

  it('区分类型口径在代码里，且旧的整条 <=0 拦截已移除', () => {
    expect(src).toContain("input.quantity === 0 && input.type !== 'Adjustment'");
    expect(src).not.toContain('if (input.quantity <= 0)');
  });
});
