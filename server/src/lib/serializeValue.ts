/**
 * 共享 API 序列化工具 — Prisma 查询结果 → JSON 响应统一入口
 *
 * 设计真源：DR-045 同批 P1-003 修复（验收缺陷台账）。
 * 背景：各 route 曾复制 `constructor?.name === 'Decimal'` 判断的本地 serializeValue，
 * 该判断在运行时不可靠（多份 decimal.js 副本 / 构造函数名差异），Decimal 未命中
 * 时被当普通 object 逐属性展开，前端渲染 {"s":1,"e":5,"d":[...]}（[object Object]）。
 *
 * 修复口径（与 finance/route.ts serializeFinanceValue 范式对齐）：
 *   1. `value instanceof Prisma.Decimal` 优先 —— 类身份判断，不受函数名影响
 *   2. 鸭子兜底（s/e/d 数字结构）—— 跨 decimal.js 副本实例（双方各自 require 了
 *      不同副本时 instanceof 会失效），按 decimal.js 内部结构特征识别
 *   3. bigint → number；Date 透传（JSON.stringify 原生 ISO 序列化）
 */
import { Prisma } from '@prisma/client';

/** decimal.js 实例内部结构：{ s: sign(±1), e: exponent(number), d: digits(number[]) } */
function isDecimalLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { s?: unknown; e?: unknown; d?: unknown };
  return (
    (v.s === 1 || v.s === -1) &&
    typeof v.e === 'number' &&
    Array.isArray(v.d) &&
    v.d.every((digit) => typeof digit === 'number')
  );
}

export function serializeValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map(serializeValue) as T;
  if (typeof value === 'object') {
    if (value instanceof Date) return value;
    if (value instanceof Prisma.Decimal) return Number((value as unknown as Prisma.Decimal).toString()) as T;
    if (isDecimalLike(value)) return Number((value as { toString(): string }).toString()) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serializeValue(v);
    return out as T;
  }
  return value;
}
