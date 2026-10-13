/**
 * B274 · 取号吞错守卫（评审 I-19 的余下两处）
 *
 * 迁移前（v3.236 现量）：`exceptionService.nextExceptionNumber` 与
 * `orderChangeRequestService.nextRequestNumber` 都是
 *   `prisma.<表>.count({ where: { 号: { startsWith: 前缀 } } }).catch(() => 0)` 然后 `count + 1`
 * ⇒ 查询一失败就**凭空造出一个"今天第 1 号"**，而真实库里第 1 号已经在 ⇒ 后面那次 create 撞 `@unique`。
 *   同族的付款申请（PAYR）在 2026-09-19 已经收口到发号真源，它那份守卫的注释把这条形状写成事实：
 *   「`count+1` 先读后写，真库并发必然同号（P2002）」（`paymentRequests/__tests__/nextRequestNumberGuard.test.ts`）。
 *
 * ★ 这一条守的是**形状**（两处都还活着的那一层）。另一半 —— 「取号与审批单收进同一笔事务」——
 *   在 2026-09-28 落地：两处都改成 `sequenceService.nextNumber(tx, …)`，异常域另有行为证人
 *   （`numberingInTransactionB274.test.ts`，假库 + 顶层 Proxy 硬前置）；改单申请那一站**只有**下面这组
 *   源码级断言 ⇒ 台账 §9 **B274** 记「半闭」，不记「已闭」。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 截出目标函数（**签名 + 函数体**，大括号配对）——全文 contains 会被同文件其它代码蒙混。
 *  带上签名是必要的：本文件有一条判据问的就是"参数里有没有 tx"。 */
function fnBody(src: string, fnName: string): string {
  const cleaned = stripComments(src);
  const re = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
  const m = re.exec(cleaned);
  if (!m) throw new Error(`找不到函数 ${fnName}（签名变了？守卫要跟着改，不许直接删这条用例）`);
  const open = cleaned.indexOf('{', m.index + m[0].length);
  let depth = 0;
  for (let j = open; j < cleaned.length; j += 1) {
    if (cleaned[j] === '{') depth += 1;
    else if (cleaned[j] === '}') {
      depth -= 1;
      if (depth === 0) return cleaned.slice(m.index, j + 1);
    }
  }
  throw new Error(`${fnName} 函数体没闭合`);
}

const SITES: Array<{ file: string; fn: string; type: string; label: string }> = [
  {
    file: '../../exceptions/exceptionService.ts',
    fn: 'nextExceptionNumber',
    type: 'exceptionRequest',
    label: '异常处置单号 EXC-YYYYMMDD-NNN',
  },
  {
    file: '../../orderChanges/orderChangeRequestService.ts',
    fn: 'nextRequestNumber',
    type: 'orderChangeRequest',
    label: '改单申请号 OCR-YYYYMMDD-NNN',
  },
];

describe('B274：取号不许把查询失败吞成 0，也不许退回"数一遍再 +1"（评审 I-19 两处）', () => {
  for (const s of SITES) {
    const body = () => fnBody(readFileSync(fileURLToPath(new URL(s.file, import.meta.url)), 'utf8'), s.fn);

    it(`${s.fn}（${s.label}）函数体里没有吞错形状`, () => {
      const b = body();
      expect(b, `${s.fn} 又出现了 .catch(...)：取号失败必须让调用方看见，不许换成 0`).not.toMatch(/\.catch\s*\(/);
      expect(b, `${s.fn} 又出现了 ?? 0 / || 0 兜底`).not.toMatch(/(\?\?|\|\|)\s*0/);
    });

    it(`${s.fn} 已收进发号真源：用 tx 调 nextNumber('${s.type}')，函数体里不再数行数`, () => {
      const b = body();
      expect(b, `${s.fn} 又退回"count(前缀)+1"的先读后写 ⇒ 并发必然撞号`).not.toMatch(/count\s*\(/);
      expect(b, `${s.fn} 的参数里没有 tx ⇒ 取号又回到事务外（回滚不退号、并发撞号都会回来）`)
        .toMatch(new RegExp(`function\\s+${s.fn}\\(\\s*tx\\s*:`, ''));
      expect(b, `${s.fn} 没走发号真源（sequenceService）`).toMatch(
        new RegExp(`nextNumber\\(\\s*tx\\s*,\\s*'${s.type}'`),
      );
    });
  }
});
