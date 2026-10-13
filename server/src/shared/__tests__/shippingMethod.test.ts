/**
 * shippingMethod.test.ts — ★ C2 真源守卫：运输方式枚举（含新增的 Pickup=客户自提）
 *
 * 为什么要有这个测试（零基础障碍清单 C2 · 真库实测）：
 *   `shippingMethod` 一直是**自由文本**（前端 text 框、服务端零校验），真库实测
 *   `Sea` 67 · `Air` 7 · **`Sea Freight` 1** —— 同一含义已出现三种写法：
 *   按方式分组统计会多出第三种「运输方式」，且业务员想填「客户自提」时没有选项可挑。
 *
 * 两档口径必须分开（否则要么脏值顶红、要么校验形同虚设）：
 *   · 写入校验 `coerceShippingMethodForWrite`：严格（认枚举 + 中文/别名归一）
 *   · 展示归一 `normalizeShippingMethod`：宽容（认脏值，不改库）
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SHIPPING_METHODS,
  MVP_SHIPPING_METHODS,
  SHIPPING_METHOD_LABELS,
  coerceMvpShippingMethodForWrite,
  coerceShippingMethodForWrite,
  isValidShippingMethod,
  normalizeShippingMethod,
  shippingMethodLabel,
} from '../shippingMethod';

describe('运输方式真源', () => {
  it('枚举含 Pickup（客户自提）—— C2 的本体', () => {
    expect([...SHIPPING_METHODS]).toContain('Pickup');
    expect(SHIPPING_METHOD_LABELS.Pickup).toBe('客户自提');
  });

  it('★ 标签表必须覆盖全部枚举（不得漏收：计数对撞）', () => {
    expect(Object.keys(SHIPPING_METHOD_LABELS).sort()).toEqual([...SHIPPING_METHODS].sort());
  });

  it('isValidShippingMethod 只认枚举原值', () => {
    expect(isValidShippingMethod('Sea')).toBe(true);
    expect(isValidShippingMethod('Pickup')).toBe(true);
    expect(isValidShippingMethod('Sea Freight')).toBe(false);
    expect(isValidShippingMethod('海运')).toBe(false);
    expect(isValidShippingMethod(null)).toBe(false);
  });

  it('写入：枚举原值直接通过', () => {
    expect(coerceShippingMethodForWrite('Air')).toEqual({ ok: true, value: 'Air' });
  });

  it('写入：中文/别名/脏值 → **归一**而不是拒绝（业务员粘「海运」也该存得下）', () => {
    expect(coerceShippingMethodForWrite('海运')).toEqual({ ok: true, value: 'Sea' });
    expect(coerceShippingMethodForWrite('Sea Freight')).toEqual({ ok: true, value: 'Sea' });
    expect(coerceShippingMethodForWrite(' 客户自提 ')).toEqual({ ok: true, value: 'Pickup' });
    expect(coerceShippingMethodForWrite('EXW')).toEqual({ ok: true, value: 'Pickup' });
  });

  it('写入：空/null → 视为未填（由调用方决定必填）', () => {
    expect(coerceShippingMethodForWrite(null)).toEqual({ ok: true, value: null });
    expect(coerceShippingMethodForWrite('   ')).toEqual({ ok: true, value: null });
  });

  it('写入：认不出来 → 拒绝，且消息里列出允许值 + 自提用法', () => {
    const r = coerceShippingMethodForWrite('Teleport');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('Pickup');
      expect(r.message).toContain('客户自提');
    }
  });

  it('归一：脏值/中文/常见英文别名', () => {
    expect(normalizeShippingMethod('Sea Freight')).toBe('Sea');
    expect(normalizeShippingMethod('ocean')).toBe('Sea');
    expect(normalizeShippingMethod('海运')).toBe('Sea');
    expect(normalizeShippingMethod('DHL')).toBe('Courier');
    expect(normalizeShippingMethod('中欧班列')).toBe('Rail');
    expect(normalizeShippingMethod('自提')).toBe('Pickup');
  });

  it('归一：装载方式（FCL/LCL）也当海运 —— 本仓既有 fixture 就填过 FCL', () => {
    expect(normalizeShippingMethod('FCL')).toBe('Sea');
    expect(normalizeShippingMethod('lcl')).toBe('Sea');
    expect(coerceShippingMethodForWrite('FCL')).toEqual({ ok: true, value: 'Sea' });
  });

  it('归一：认不出来 → null（不硬塞一个错的枚举）', () => {
    expect(normalizeShippingMethod('Teleport')).toBeNull();
    expect(normalizeShippingMethod('')).toBeNull();
  });

  it('展示标签：枚举 → 中文；脏值原样返回（不猜）', () => {
    expect(shippingMethodLabel('Sea')).toBe('海运');
    expect(shippingMethodLabel('Pickup')).toBe('客户自提');
    expect(shippingMethodLabel('Sea Freight')).toBe('海运'); // 归一后取中文
    expect(shippingMethodLabel('Teleport')).toBe('Teleport');
    expect(shippingMethodLabel(null)).toBeNull();
  });
});

describe('当前 MVP 出运方式写入边界', () => {
  it('新业务入口只开放海运和空运', () => {
    expect([...MVP_SHIPPING_METHODS]).toEqual(['Sea', 'Air']);
  });

  it('海运、空运及其常见写法可归一', () => {
    expect(coerceMvpShippingMethodForWrite('Sea')).toEqual({ ok: true, value: 'Sea' });
    expect(coerceMvpShippingMethodForWrite('海运')).toEqual({ ok: true, value: 'Sea' });
    expect(coerceMvpShippingMethodForWrite('Air')).toEqual({ ok: true, value: 'Air' });
    expect(coerceMvpShippingMethodForWrite('空运')).toEqual({ ok: true, value: 'Air' });
  });

  it('陆运、铁路、快递和自提可读历史但不允许经当前 MVP 写入', () => {
    for (const method of ['Land', 'Rail', 'Courier', 'Pickup', '客户自提']) {
      const result = coerceMvpShippingMethodForWrite(method);
      expect(result.ok, method).toBe(false);
      if (!result.ok) expect(result.message).toContain('海运或空运');
    }
  });

  it('仍允许空值通过通用归一层，由调用方处理必填校验', () => {
    expect(coerceMvpShippingMethodForWrite(null)).toEqual({ ok: true, value: null });
  });
});

describe('★ 结构守卫：运输方式判据不得再各自实现', () => {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const read = (rel: string) => readFileSync(path.join(srcRoot, rel), 'utf8');

  it('服务端写入校验已接线（create + patch 同真源）', () => {
    const s = read('shipping/shipmentMutationService.ts');
    expect(s).toMatch(/from '\.\.\/shared\/shippingMethod'/);
    // create 与 patch 各一处
    expect((s.match(/coerceMvpShippingMethodForWrite\(/g) ?? []).length).toBe(2);
  });

  it('台账标签不再内联一份 map（route.ts 必须用真源的 label 函数）', () => {
    const s = read('shipping/route.ts');
    expect(s).toMatch(/shippingMethodLabel/);
    expect(s).not.toMatch(/Courier: '快递'/);
  });

  it('统计分组按归一后的枚举（否则脏值单独立桶）', () => {
    const s = read('shipping/shipmentStatsService.ts');
    expect(s).toMatch(/normalizeShippingMethod\(s\.shippingMethod\)/);
  });
});
