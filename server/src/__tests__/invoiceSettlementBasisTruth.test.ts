/**
 * invoiceSettlementBasisTruth.test.ts — ★ 结构守卫：发票「结清基准额」判据必须走唯一真源
 *
 * 为什么要有（2026-09-18 复核 CLM S2 / S6，两条都成立且同源）：
 *   面额 |amount| 这条判据原本**内联在 3 处**（结清判定 / 核销校验 / 改金额守卫），
 *   三处都拿负数当票面 ⇒ 负额票（供应商索赔贷项 Payable）写不进、判不出、改不了。
 *   本仓踩过「同一判据散落 N 处」的亏（实测 7 处），所以这里钉住三件事：
 *     ① 判定点唯一（「把票判成 Paid」只能有 recalcInvoiceStatus 一处）
 *     ② 三个消费点必须 import 真源（不能各写一份）
 *     ③ 旧内联写法不得复活（正则禁止 `amount.gt(0)` 之类）
 *
 * ⚠️ 扫描源码**先剥注释**再断言（否则注释里的示例写法会误伤）。
 * ⚠️ 必须带**阳性对照**（断言扫描确实读到了目标文件），否则判据可能是空集、恒绿。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function read(file: string): string {
  return stripComments(fs.readFileSync(path.join(SRC, file), 'utf8'));
}

/** 递归收集 .ts 源文件（跳过 __tests__ 与 .test./.spec.） */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, acc);
    else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** 需要走真源的三个消费点（改真源前先读真源文件末尾的「消费点登记」） */
const CONSUMERS = [
  'finance/allocationService.ts',
  'finance/invoiceMutationService.ts',
];

describe('★ 结清基准额真源：消费点登记守卫', () => {
  it('阳性对照：三个消费点文件都真实存在且读到内容', () => {
    for (const f of CONSUMERS) {
      const code = read(f);
      expect(code.length, `${f} 应非空`).toBeGreaterThan(500);
    }
  });

  it('消费点必须 import 真源（不许各写一份面额逻辑）', () => {
    for (const f of CONSUMERS) {
      expect(read(f), `${f} 必须 import shared/invoiceSettlementBasis`).toMatch(
        /from\s+'\.\.\/shared\/invoiceSettlementBasis'/,
      );
    }
  });

  it('旧内联写法不得复活（这三处是 S2/S6 的病根）', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['finance/allocationService.ts', /invoiceAmount\.gt\(0\)/],
      ['finance/allocationService.ts', /appliedAmountDecimal\.gt\(invoiceAmount\)/],
      ['finance/allocationService.ts', /remainingInvoice\s*=\s*invoiceAmount\.minus/],
      ['finance/invoiceMutationService.ts', /nextAmount\.lt\(applied\)/],
    ];
    for (const [f, re] of forbidden) {
      expect(read(f), `${f} 不应再出现 ${re}`).not.toMatch(re);
    }
  });

  it('★ 判定点唯一：「把票判成 Paid」只有 allocationService.recalcInvoiceStatus 一处', () => {
    const hits: string[] = [];
    for (const file of collectSources(SRC)) {
      if (stripComments(fs.readFileSync(file, 'utf8')).includes("return 'Paid'")) {
        hits.push(path.relative(SRC, file));
      }
    }
    // 阳性对照：必须真的扫到了目标文件（否则判据是空集、恒绿）
    expect(hits, '扫描器应至少命中一个文件').toContain('finance/allocationService.ts');
    // 实测（2026-09-18）：判定点确实只剩这一处（creditNoteService 走的是 recalcInvoiceStatus
    // 的返回值 / advanceCreditNoteStatus，不是自己判票结清）。
    expect(hits.sort()).toEqual(['finance/allocationService.ts']);
  });
});
