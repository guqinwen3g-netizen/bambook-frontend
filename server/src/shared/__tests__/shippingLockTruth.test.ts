/**
 * shippingLockTruth.test.ts — 「已发运」判据真源守卫（2026-09-18 · 收口点错位专项）
 *
 * 为什么要有这个文件：
 *   同一条业务规则（货已离厂 / 订单已出运）在本仓**散落 5 处各写一份同样的集合**：
 *     shipping/allocationService · shipping/shipmentStockService · finance/reconciliationService
 *     · customer/orderScheduleService · orderChanges/orderChangeRequestService
 *   改一处忘一处 = 本仓最高产的一类 bug（收口点错位）。现已全部收口到
 *   `shared/shippingLock.ts`，这里用**源码扫描**钉住「不许再内联一份」。
 *
 * 两层守卫：
 *   ① 行为：真源三个判定函数的分支（含 Booked/Loading 不算已发运这条易错点）
 *   ② 结构：全 server/src 扫描，禁止再出现内联的「运单已发运 4 值集合」与「订单已出运 2 值集合」
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SHIPPED_SHIPMENT_STATUSES,
  SHIPPED_ORDER_STATUSES,
  ACTIVE_SHIPMENT_EXCLUDED_STATUSES,
  isShipmentShipped,
  isShipmentActive,
  isOrderShipped,
} from '../shippingLock';

describe('shippingLock 真源行为', () => {
  it('运单：Shipped 及之后 = 已发运；Booked/Loading 只订舱装柜，不算', () => {
    expect(['Shipped', 'Arrived', 'Cleared', 'Delivered'].every(isShipmentShipped)).toBe(true);
    expect(['Draft', 'Booked', 'Loading', 'Cancelled'].some(isShipmentShipped)).toBe(false);
    expect(isShipmentShipped(null)).toBe(false);
  });

  it('运单在途：Draft（没启动）与 Cancelled（已终止）都不算在途', () => {
    expect(isShipmentActive('Booked')).toBe(true);
    expect(['Draft', 'Cancelled'].some(isShipmentActive)).toBe(false);
  });

  it('订单：Shipping / Delivered = 已出运', () => {
    expect(['Shipping', 'Delivered'].every(isOrderShipped)).toBe(true);
    expect(['Pending', 'Confirmed', 'Production'].some(isOrderShipped)).toBe(false);
  });

  /**
   * 判据修正（第一版写错了）：我原写「两个口径互不相交」，实测 **Delivered 是两侧共有的**
   * （运单 Delivered = 货已交付；订单 Delivered = 订单终态）。交集本身就是合法的，
   * 真正的风险是**拿错集合去判**，所以改成：除 Delivered 外必须互不相交。
   */
  it('两个口径只共有 Delivered，其余互不相交（拿错集合会立刻不一致）', () => {
    for (const s of SHIPPED_SHIPMENT_STATUSES) {
      if (s === 'Delivered') continue;
      expect(isOrderShipped(s), `运单状态 ${s} 不该被订单侧判为已出运`).toBe(false);
    }
    for (const s of SHIPPED_ORDER_STATUSES) {
      if (s === 'Delivered') continue;
      expect(isShipmentShipped(s), `订单状态 ${s} 不该被运单侧判为已发运`).toBe(false);
    }
  });

  it('排除集只含 Cancelled/Draft（新增状态时要回来确认）', () => {
    expect([...ACTIVE_SHIPMENT_EXCLUDED_STATUSES].sort()).toEqual(['Cancelled', 'Draft']);
  });
});

describe('★ 结构守卫：不许再内联一份「已发运」集合', () => {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSyncSafe(dir)) {
      const full = path.join(dir, e);
      if (isDir(full)) walk(full);
      else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(srcRoot);

  it('扫描有效：确实扫到了大量源文件', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  /**
   * 判据说明（第一版判据写错了）：初版写「集合里同时出现 Shipped 与 Delivered」，
   * 实测误伤两处**语义完全不同**的集合：
   *   · dashboardService 的 TERMINAL_STATUSES（订单终态：Delivered/Shipped/Cancelled/Closed）
   *   · toolRuntime 的订单合法状态全集（含 Shipping/Delivered）
   * 它们都不是「已发运」判据 ⇒ 改成**内容完全等于真源**才算重复（复制粘贴才会完全一致）。
   */
  const inlineDuplicatesOf = (truth: readonly string[]): string[] => {
    const want = [...truth].sort().join(',');
    const out: string[] = [];
    for (const f of files) {
      if (f.endsWith('shared/shippingLock.ts') || f.endsWith('statusTransition.ts')) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/new Set(?:<[^>]*>)?\(\[([^\]]*)\]\)/g)) {
        const members = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort().join(',');
        if (members && members === want) out.push(`${path.relative(srcRoot, f)}: ${m[0]}`);
      }
    }
    return out;
  };

  it('★ 不得再内联一份运单「已发运」集合（内容与真源完全一致即红）', () => {
    expect(inlineDuplicatesOf(SHIPPED_SHIPMENT_STATUSES)).toEqual([]);
  });
  it('★ 不得再内联一份订单「已出运」集合（内容与真源完全一致即红）', () => {
    expect(inlineDuplicatesOf(SHIPPED_ORDER_STATUSES)).toEqual([]);
  });
  it('★ 五个原内联点都必须改为引用真源（少一个都红）', () => {
    const consumers = [
      'shipping/allocationService.ts',
      'shipping/shipmentStockService.ts',
      'finance/reconciliationService.ts',
      'customer/orderScheduleService.ts',
      'orderChanges/orderChangeRequestService.ts',
    ];
    for (const rel of consumers) {
      const src = readFileSync(path.join(srcRoot, rel), 'utf8');
      expect(src, `${rel} 未引用 shared/shippingLock`).toMatch(/from '\.\.\/shared\/shippingLock'/);
    }
  });
});

// ── 极小的 fs 帮助（避免引入额外依赖） ──
import { readdirSync, statSync } from 'node:fs';
function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
