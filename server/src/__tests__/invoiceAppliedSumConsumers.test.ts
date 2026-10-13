/**
 * invoiceAppliedSumConsumers.test.ts —— 「已核销合计」消费点登记守卫（结构性，双向）
 *
 * 为什么需要：
 *   2026-09-18 修好了单张票真源 `sumAppliedAmount`（含贷项票抵扣），但**批量汇总处
 *   仍在各自手写 `invoiceAllocation.groupBy`**（9 处）⇒ 同一张票「状态已结清、
 *   列表仍显示欠折让额」。2026-09-19 上线验收收编为 `shared/invoiceAppliedSum`。
 *   本守卫防止**回潮**（有人再手写一套），也钉住**刻意不适用**的两类场景。
 *
 * 双向：① 必须 import 真源 ② 必须保留真源调用（防「整段被删」空过）
 *      ③ 刻意排除的必须保持自己的原语义（防被"顺手改坏"）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

/** 扫 src 下所有**非测试**、引用真源的文件（相对 SRC 的路径，排序稳定）。 */
function importersOfSource(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(abs, rel);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.ts$/.test(name)) {
        if (rel === 'shared/invoiceAppliedSum.ts') continue;   // 真源自己不算消费者
        if (readFileSync(abs, 'utf8').includes('shared/invoiceAppliedSum')) out.push(rel);
      }
    }
  };
  walk(SRC, '');
  return out.sort();
}

/** 必须走真源的消费点（语义 = 「该发票已收/还欠多少」） */
const MUST_USE = [
  'events/linkages/L5AutoAllocate.ts',         // 出运候选核销也须计入真实贷项抵扣
  'finance/route.ts',                        // 发票列表 appliedAmount/openAmount
  'finance/reportService.ts',                // 账龄 + 现金流日历
  'finance/dunningService.ts',               // 催办未结清单
  'finance/dunningStageService.ts',          // 催款分级看板（★ B273 批补登记：它一直在引用，名单里没有 ⇒ 旧守卫对它空转）
  'credit/creditService.ts',                 // 授信净额
  'shipping/orderShipmentBatchService.ts',   // 批次结清（paid）+ 订单已收合计
  'agent/toolRuntime.ts',                    // AI 助手报的未结清额
];

describe('消费点登记：已核销合计必须走 shared/invoiceAppliedSum', () => {
  for (const f of MUST_USE) {
    it(`${f} 引用真源`, () => {
      expect(read(f)).toContain("shared/invoiceAppliedSum");
    });
  }

  /**
   * ★ 登记必须等于全量（B273 批加的）：MUST_USE 此前靠人工维护，实测漏掉一个真消费者
   *   （`finance/dunningStageService.ts` 从 :23 导入并调用，清单里没有它 ⇒ 任何人把那一行
   *   改回手写 groupBy，本守卫一声不响）。⇒ 这条把「名单是否齐全」变成当场判据：
   *   扫 src 下所有非测试引用者，必须逐个出现在 MUST_USE 里。
   */
  it('★ 普查对撞：任何引用真源的生产文件都必须在名单里（防"漏登记"这一型）', () => {
    const found = importersOfSource();
    const unlisted = found.filter(f => !MUST_USE.includes(f));
    expect(unlisted, `这些文件引用了真源却没登记：${unlisted.join(', ')}`).toEqual([]);
    // 反向：名单不许空转（登记的文件必须真的引用）
    const stale = MUST_USE.filter(f => !found.includes(f));
    expect(stale, `名单里这些文件已不引用真源（要么改判、要么删登记）：${stale.join(', ')}`).toEqual([]);
  });

  it('★ 双向：每个消费点确实**调用**了真源（防「import 在但调用被删」）', () => {
    for (const f of MUST_USE) {
      const src = read(f);
      const imported = [...src.matchAll(/import \{([^}]+)\} from '[^']*shared\/invoiceAppliedSum'/g)]
        .flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean));
      expect(imported.length, `${f} 未从真源导入任何符号`).toBeGreaterThan(0);
      const called = imported.some(name => new RegExp(`\\b${name}\\s*\\(`).test(src));
      expect(called, `${f} 导入了真源却未调用`).toBe(true);
    }
  });

  it('★ 回潮守卫：不得在消费点里再手写「按 invoiceId 汇总 appliedAmount」', () => {
    for (const f of MUST_USE) {
      const src = read(f);
      // 允许「按 voucherId」汇总（凭证侧语义不同），禁「by: ['invoiceId']」
      expect(src, `${f} 又出现了按 invoiceId 的 groupBy`).not.toMatch(/by:\s*\[\s*'invoiceId'\s*\]/);
    }
  });

  it('★ route.ts 的**发票侧**必须直接调真源（不得改回 scope 三元手写）', () => {
    const src = read('finance/route.ts');
    expect(src).toMatch(/scope === 'invoice'\)\s*\{\s*appliedMap = await sumAppliedAmountByInvoice/);
  });
});

describe('刻意不适用真源的场景（防被顺手改坏）', () => {
  it('finance/route.ts 的**凭证侧**仍只算 InvoiceAllocation（贷项票没有凭证）', () => {
    const src = read('finance/route.ts');
    expect(src).toMatch(/by:\s*\[\s*'voucherId'\s*\]/);
  });

  it('dashboard.collectOrderReceipts 是**实收（现金流）**语义 ⇒ 必须保留「只认 Receipt 凭证」的过滤', () => {
    const src = read('dashboard/dashboardService.ts');
    expect(src).toContain('receiptIds.has(a.voucherId)');
    // 且不得把它改成真源（否则「实收」把折让也算成收到的钱）
    expect(src).not.toContain('shared/invoiceAppliedSum');
  });

  it('reportService 的凭证侧汇总（代付来源/未核销凭证/汇兑）仍按 voucherId —— 语义不同，不得收编', () => {
    const src = read('finance/reportService.ts');
    expect(src).toMatch(/by:\s*\[\s*'voucherId'\s*\]/);
  });
});
