import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { serializeValue } from '../serializeValue';

/**
 * P1-003 回归：Decimal 序列化全局缺陷（[object Object] / {s,e,d} 内部结构外泄）。
 * 根因：constructor?.name === 'Decimal' 判断在运行时不可靠（多份 decimal.js 副本 /
 * 构造函数名差异），未命中时 Decimal 被当普通 object 逐属性展开。
 * 修复：instanceof Prisma.Decimal 优先 + s/e/d 鸭子兜底（共享工具，12 个 route 统一引用）。
 */

describe('P1-003 serializeValue（共享序列化工具）', () => {
  it('Prisma.Decimal 实例 → number（instanceof 主判定）', () => {
    expect(serializeValue(new Prisma.Decimal('500000.5'))).toBe(500000.5);
    expect(serializeValue(new Prisma.Decimal('7.12'))).toBe(7.12);
  });

  it('跨副本 decimal-like 对象（s/e/d 结构，instanceof 失效场景）→ number（鸭子兜底）', () => {
    // 模拟另一份 decimal.js 副本的实例：结构与 decimal.js 内部表示一致，
    // 但 prototype 链不同（instanceof Prisma.Decimal 为 false）——
    // 这正是 constructor.name 判断与 instanceof 双双失效时鸭子判断仍命中的场景。
    const foreignDecimal = Object.assign(Object.create(null), {
      s: 1,
      e: 5,
      d: [500000],
      toString() { return '500000'; },
    });
    expect((foreignDecimal as any) instanceof Prisma.Decimal).toBe(false);
    expect(serializeValue(foreignDecimal as any)).toBe(500000);
  });

  it('旧缺陷复现锚点：monthlyCapacity {s,e,d} 不再外泄，输出 number', () => {
    const row = {
      id: 'F1',
      monthlyCapacity: new Prisma.Decimal('500000'),
      totalAmount: new Prisma.Decimal('123.4567'),
    };
    const out = serializeValue(row) as any;
    expect(out.monthlyCapacity).toBe(500000);
    expect(out.totalAmount).toBe(123.4567);
    expect(typeof out.monthlyCapacity).toBe('number');
    expect(JSON.stringify(out)).not.toContain('"s"');
  });

  it('bigint → number（含嵌套）', () => {
    expect(serializeValue(BigInt(123))).toBe(123);
    expect(serializeValue({ createdAt: BigInt(1787000000000) })).toEqual({ createdAt: 1787000000000 });
  });

  it('Date 透传（不展开为空对象，交给 JSON.stringify 原生 ISO 序列化）', () => {
    const d = new Date('2026-08-20T00:00:00.000Z');
    expect(serializeValue(d)).toBe(d);
    expect(JSON.stringify(serializeValue({ at: d }))).toBe('{"at":"2026-08-20T00:00:00.000Z"}');
  });

  it('数组与深层嵌套递归序列化', () => {
    const input = {
      items: [
        { id: 'A', amount: new Prisma.Decimal('1.5'), nested: { deep: new Prisma.Decimal('2.5') } },
        { id: 'B', amount: new Prisma.Decimal('3.5') },
      ],
      total: new Prisma.Decimal('7.5'),
    };
    expect(serializeValue(input)).toEqual({
      items: [
        { id: 'A', amount: 1.5, nested: { deep: 2.5 } },
        { id: 'B', amount: 3.5 },
      ],
      total: 7.5,
    });
  });

  it('null / undefined / 原始值直通', () => {
    expect(serializeValue(null)).toBe(null);
    expect(serializeValue(undefined)).toBe(undefined);
    expect(serializeValue('text')).toBe('text');
    expect(serializeValue(42)).toBe(42);
    expect(serializeValue(false)).toBe(false);
  });

  it('普通对象不误伤（无 s/e/d 特征的字段原样保留）', () => {
    const row = { id: 'X1', meta: { source: 'route', ok: true }, tags: ['a', 'b'] };
    expect(serializeValue(row)).toEqual(row);
  });
});
