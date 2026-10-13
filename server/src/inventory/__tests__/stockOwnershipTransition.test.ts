/**
 * stockOwnershipTransition.test.ts — ★ C4 真源单测：库存归属变更判定（纯函数）
 *
 * 为什么单测这块（零基础障碍清单 C4）：
 *   「A 单货挪 B 单」在本仓此前**没有任何留痕**，归属也无处可挂。四个动作的前置条件**互斥**
 *   （认领 vs 挪货 vs 退回 vs 标记备货），判错一个就会出现「同一个动作两种意图、事后分不清」——
 *   所以判定必须是一个可单测的纯函数，而不是散在路由里的 if。
 */
import { describe, expect, it } from 'vitest';
import {
  validateOwnershipTransition,
  OWNERSHIP_ACTIONS,
  OWNERSHIP_REASON_MIN,
  type OwnershipAction,
} from '../stockOwnershipService';

const base = { currentOrderId: null as string | null, currentStockPrep: false, quantity: 100 };
const V = (over: Partial<Parameters<typeof validateOwnershipTransition>[0]>) =>
  validateOwnershipTransition({ ...base, action: 'mark_stock_prep', ...over });

describe('validateOwnershipTransition（归属变更判定）', () => {
  it('① 未归属 → mark_stock_prep：成为备货', () => {
    expect(V({ action: 'mark_stock_prep' })).toEqual({ ok: true, nextOrderId: null, nextStockPrep: true });
  });

  it('② 未归属 → attribute：归属目标订单（stockPrep 转 false）', () => {
    expect(V({ action: 'attribute', targetOrderId: 'O1' })).toEqual({ ok: true, nextOrderId: 'O1', nextStockPrep: false });
  });

  it('③ 已归属 → reassign：挪到别的订单', () => {
    expect(V({ action: 'reassign', currentOrderId: 'O1', targetOrderId: 'O2' }))
      .toEqual({ ok: true, nextOrderId: 'O2', nextStockPrep: false });
  });

  it('④ 已归属 → release：退回未归属（不是备货）', () => {
    expect(V({ action: 'release', currentOrderId: 'O1' })).toEqual({ ok: true, nextOrderId: null, nextStockPrep: false });
  });

  it('★ ⑤ 已归属不能直接标记备货（必须先 release，两步都留痕）', () => {
    const r = V({ action: 'mark_stock_prep', currentOrderId: 'O1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('ALREADY_ATTRIBUTED');
      expect(r.message).toContain('退回未归属');
    }
  });

  it('★ ⑥ 已归属不能用 attribute（那是「认领」；换单必须走 reassign）', () => {
    const r = V({ action: 'attribute', currentOrderId: 'O1', targetOrderId: 'O2' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('ALREADY_ATTRIBUTED');
      expect(r.message).toContain('reassign');
    }
  });

  it('★ ⑦ 未归属不能用 reassign（未归属的货走 attribute）', () => {
    const r = V({ action: 'reassign', targetOrderId: 'O2' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_ATTRIBUTED');
  });

  it('⑧ 缺目标订单 → TARGET_REQUIRED（attribute / reassign 都要）', () => {
    expect((V({ action: 'attribute' }) as any).code).toBe('TARGET_REQUIRED');
    expect((V({ action: 'attribute', targetOrderId: '  ' }) as any).code).toBe('TARGET_REQUIRED');
    expect((V({ action: 'reassign', currentOrderId: 'O1' }) as any).code).toBe('TARGET_REQUIRED');
  });

  it('⑨ 无变化（同单 / 已是备货 / 未归属退回）→ NO_CHANGE / NOT_ATTRIBUTED', () => {
    expect((V({ action: 'reassign', currentOrderId: 'O1', targetOrderId: 'O1' }) as any).code).toBe('NO_CHANGE');
    expect((V({ action: 'mark_stock_prep', currentStockPrep: true }) as any).code).toBe('NO_CHANGE');
    expect((V({ action: 'release' }) as any).code).toBe('NOT_ATTRIBUTED');
  });

  it('⑩ 0 库存 / 非法数量 → NO_STOCK（归属变更不改变数量，0 库存归属没有意义）', () => {
    expect((V({ action: 'mark_stock_prep', quantity: 0 }) as any).code).toBe('NO_STOCK');
    expect((V({ action: 'mark_stock_prep', quantity: -1 }) as any).code).toBe('NO_STOCK');
    expect((V({ action: 'mark_stock_prep', quantity: Number.NaN }) as any).code).toBe('NO_STOCK');
  });

  it('⑪ 未知动作 → INVALID_ACTION，消息列出允许值', () => {
    const r = V({ action: 'teleport' as OwnershipAction });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INVALID_ACTION');
      for (const a of OWNERSHIP_ACTIONS) expect(r.message).toContain(a);
    }
  });

  it('⑫ 目标订单首尾空白被归一（避免 ` O1 ` 与 `O1` 判成不同单）', () => {
    expect(V({ action: 'attribute', targetOrderId: '  O1  ' })).toEqual({ ok: true, nextOrderId: 'O1', nextStockPrep: false });
  });

  it('⑬ 事由下限常量存在且为正（路由/服务同口径）', () => {
    expect(OWNERSHIP_REASON_MIN).toBeGreaterThan(0);
  });
});
