/**
 * 走查·收款 500 引出的族级守卫：`nextBusinessNumber` 的调用点必须都带「占用追平」
 *
 * 为什么要有这一份（而不是只修凭证那一处）：
 *   取号真源 nextBusinessNumber 的 doc 注释写着"序号 = 该前缀+年份下既有编号最大序号 + 1"，
 *   实现里这个"追平"是**可选参数** opts.occupied —— 调用点不传，序列一旦落后于业务表
 *   （迁移直写单号、序列表重建、演示数据按号造数）就恒发已占用的号 ⇒ P2002 ⇒ 整笔事务回滚
 *   ⇒ 那张单永远建不出来。2026-09-28 在真库上被走查当场踩到的就是凭证（PV）这一处。
 *   先例（已带追平）的注释写得很直白：customsService.ts「真库实测 100% 复现」。
 *
 * 判据是源码级的（"这一族每个调用点都得带牙"），所以它必须能自己证明自己有牙：
 *   ① 分母钉死（现量 21 处），漏扫/命名改动会红而不是静默扫到 0 处；
 *   ② 正反两个合成样本喂同一个判据函数（缺 occupied 的必须被抓、带 occupied 的必须放过）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../..');

/** 从 `(` 起按括号配平取出整条调用（含跨行 opts 对象） */
function extractCall(text: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openParenIndex, i + 1);
    }
    if (i - openParenIndex > 4000) break; // 防御：异常文本不无限扫
  }
  return text.slice(openParenIndex, openParenIndex + 4000);
}

/** 判据：这条调用有没有带 occupied */
function callHasOccupiedGuard(callText: string): boolean {
  return /\boccupied\s*[:(]/.test(callText);
}

interface Site {
  file: string;
  line: number;
  call: string;
}

function collectCallSites(): Site[] {
  const sites: Site[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const text = fs.readFileSync(full, 'utf8');
      const needle = 'nextBusinessNumber(';
      for (let idx = text.indexOf(needle); idx !== -1; idx = text.indexOf(needle, idx + needle.length)) {
        // 跳过定义（`export async function nextBusinessNumber(`）
        const before = text.slice(Math.max(0, idx - 20), idx);
        if (/\bfunction\s+$/.test(before)) { idx += needle.length; continue; }
        // 跳过注释里的举例（doc 注释写着 `nextBusinessNumber(tx, 'QT')`，它不是调用点）
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        if (/^[ \t]*(\/\/|\*|\/\*)/.test(text.slice(lineStart, idx))) continue;
        const openParen = idx + needle.length - 1;
        sites.push({
          file: path.relative(SRC_ROOT, full),
          line: text.slice(0, idx).split('\n').length,
          call: extractCall(text, openParen),
        });
      }
    }
  };
  walk(SRC_ROOT);
  return sites;
}

describe('nextBusinessNumber 调用点族级守卫（占用追平不许漏）', () => {
  const sites = collectCallSites();

  it('分母：全库调用点数与现量一致（扫到 0 处或莫名少几处都要红）', () => {
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((s) => `${s.file}`).sort()).toEqual(
      [
        'bom/bomService.ts',
        'bom/bomService.ts',
        'claims/claimCaseService.ts',
        'claims/claimRepairFulfillmentService.ts', // 修复完成质检单，复用实际占用追平
        'claims/creditNoteService.ts',
        'claims/repairWorkOrderService.ts',
        'claims/replacementService.ts',
        'claims/returnReceiptService.ts',
        'customs/customsService.ts',
        'customs/customsService.ts',
        'customs/customsService.ts',
        'customs/tradeDocumentLifecycleService.ts',
        'development/fabricDevelopmentService.ts', // SampleBatch occupied sequence
        'development/fabricDevelopmentService.ts', // SealSample occupied sequence incl soft-deleted historical codes
        'finance/billingItemService.ts', // BillingItem
        'finance/billingItemService.ts', // CostRecord
        'finance/invoiceMutationService.ts',
        'finance/paymentVoucherMutationService.ts',
        'orders/route.ts',
        'procurement/materialReturnService.ts',
        'procurement/materialReturnService.ts',
        'procurement/procurementService.ts',
        'procurement/procurementService.ts',
        'procurement/purchaseServiceDeliveryService.ts',
        'quotations/quotationService.ts',
        'samples/garmentSampleGateService.ts', // current garment SampleBatch uses the same occupied SB sequence
        'samples/sampleManageService.ts',
        'shipping/shipmentMutationService.ts',
      ].sort(),
    );
  });

  it('★ 每一处都带 occupied（缺的那几处按 文件:行号 点名）', () => {
    const missing = sites.filter((s) => !callHasOccupiedGuard(s.call));
    expect(missing.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it('判据自检：缺牙的必须被抓、带牙的必须放过（证明上一条不是恒真）', () => {
    expect(callHasOccupiedGuard(extractCall(`nextBusinessNumber(tx, 'PV')`, 18))).toBe(false);
    expect(
      callHasOccupiedGuard(
        extractCall(
          `nextBusinessNumber(tx, 'PV', undefined, {\n  occupied: async (num) => true,\n})`,
          18,
        ),
      ),
    ).toBe(true);
  });
});
