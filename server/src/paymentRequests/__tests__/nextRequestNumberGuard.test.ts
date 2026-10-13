/**
 * 付款申请号取号 —— 守卫（2026-09-17 立，**2026-09-19 随修复改写**）
 *
 * ── 本文件守的是什么（三条口径，与实现机制解耦）─────────────
 *   1. **日期段 = 本地业务日**（不是 UTC 日）⇒ 本地 00:00–08:00 不得记成昨天
 *   2. **不得吞错**：查询失败必须 fail loud，不产出注定撞唯一键的号
 *   3. **格式 = `PAYR-YYYYMMDD-NNN`**（schema 注释既定），**不得换成**
 *      `nextBusinessNumber` 的 `{PREFIX}-{YYYY}-{NNNN}` 年序格式
 *
 * ── ⚠️ 2026-09-19 改写说明（重要，勿删）────────────────────
 * 原版把三条钉在 `nextRequestNumber` 的**函数体文本**上（要求出现 `todayLocalKey()` /
 * `padStart(3, '0')` / `PAYR-`）。当时取号是 `count+1` **就地拼号**，这样钉是合理的。
 *
 * 但 `count+1` 先读后写，真库并发必然同号（P2002）；且审批单在事务外先建会留孤儿单。
 * 修复后取号**收口到发号真源** `sequenceService.nextNumber(tx, 'paymentRequest')`
 * —— 就地拼号的代码**不再存在**，于是原断言自然失效（不是回归，是**断言面搬家**）。
 *
 * 改写原则：**意图不变、断言搬到新真源上，且更强** ——
 *   · 日期段：改为**行为断言** `periodKeyForDate('day', d)`（真源导出），
 *     不再依赖「某个函数体里出现了哪个标识符」；
 *   · 格式：改为断言**发号真源的类型配置**（`SEQUENCE_TYPE_CONFIGS.paymentRequest`）+
 *     `paymentRequestService` **不得**再自己拼号/换年序；
 *   · 吞错：保留源码断言（新实现里该风险已由「不再自己查表」消除，但守卫仍钉住不许回来）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SEQUENCE_TYPE_CONFIGS, periodKeyForDate } from '../../sequence/sequenceService';

const SRC = readFileSync(new URL('../paymentRequestService.ts', import.meta.url), 'utf8');
const SEQ_SRC = readFileSync(new URL('../../sequence/sequenceService.ts', import.meta.url), 'utf8');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 截出目标函数体（大括号配对；注释里也提到了旧写法，故必须先剥注释）。
 * ⚠️ 断言**精确到函数体** —— 全文 `toContain` 会被同文件其它代码蒙混。
 */
function fnBody(src: string, fnName: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index + m[0].length);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  return src.slice(m.index);
}

const CODE = stripComments(SRC);
const NEXT_NUMBER_FN = fnBody(CODE, 'nextRequestNumber');
const SEQ_CODE = stripComments(SEQ_SRC);
const PERIOD_KEY_FN = fnBody(SEQ_CODE, 'periodKeyForDate');

describe('★ 付款申请号取号守卫', () => {
  it('能定位到目标函数体（防止守卫空过）', () => {
    expect(NEXT_NUMBER_FN, '未定位到 nextRequestNumber 函数体').not.toBe('');
    expect(PERIOD_KEY_FN, '未定位到 periodKeyForDate 函数体').not.toBe('');
  });

  // ── 口径 1：日期段 = 本地业务日（行为断言，不依赖实现写法）──────────
  it('★ 日期段口径 = 本地业务日，不是 UTC 日', () => {
    // 本地时间构造「凌晨」时刻：在 GMT+8 下，本地日与 UTC 日**不同日**
    const early = new Date(2026, 8, 19, 7, 0, 0); // 本地 2026-09-19 07:00
    const localYmd = `${early.getFullYear()}-${String(early.getMonth() + 1).padStart(2, '0')}-${String(early.getDate()).padStart(2, '0')}`;
    expect(periodKeyForDate('day', early)).toBe(localYmd);
    // 同刻的 UTC 日（若时区偏移非 0，二者不同 —— 这正是旧 bug 的成因）
    if (early.getTimezoneOffset() !== 0) {
      expect(early.toISOString().slice(0, 10)).not.toBe(localYmd);
    }
  });

  it('★ 发号真源的日期段实现不得走 UTC（periodKeyForDate 里不许出现 toISOString）', () => {
    expect(PERIOD_KEY_FN).not.toMatch(/toISOString/);
  });

  // ── 口径 2：不得吞错 ─────────────────────────────────────────
  it('★ 不得吞错（`.catch(() => 0)`）：查询失败必须 fail loud，不产出注定撞唯一键的号', () => {
    expect(NEXT_NUMBER_FN).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*0\s*\)/);
  });

  // ── 口径 3：格式 = PAYR-YYYYMMDD-NNN ─────────────────────────
  it('★ 取号必须走发号真源（不得自己 count+1、不得换成年序 nextBusinessNumber）', () => {
    expect(NEXT_NUMBER_FN).toContain('nextNumber(');
    expect(NEXT_NUMBER_FN).toContain("'paymentRequest'");
    // 不得自己查表算号（先读后写 = 并发同号的根因）
    expect(NEXT_NUMBER_FN).not.toMatch(/\.count\(/);
    // 不得换成 {PREFIX}-{YYYY}-{NNNN} 年序格式
    expect(NEXT_NUMBER_FN).not.toContain('nextBusinessNumber');
  });

  it('★ 格式口径：发号真源配置产出 PAYR-YYYYMMDD-NNN（3 位补零、日期段连写）', () => {
    const cfg = SEQUENCE_TYPE_CONFIGS.paymentRequest;
    expect(cfg.prefix).toBe('PAYR');
    expect(cfg.period).toBe('day');
    expect(cfg.defaultPadding).toBe(3);
    // schema 注释：`requestNumber String @unique // 业务申请号：PAYR-YYYYMMDD-001`
    expect(cfg.defaultFormatTemplate).toBe('{prefix}-{year}{month}{day}-{seq:03}');
  });

  // ── 守卫自检（证明上面的正则有区分度，不是恒真）────────────────
  it('守卫自检：能咬住旧写法（count+1 就地拼号 + UTC 日 + 吞错）', () => {
    const OLD = `async function nextRequestNumber() {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = \`PAYR-\${day}-\`;
    const count = await prisma.paymentRequest.count({ where: {} }).catch(() => 0);
    return \`\${prefix}\${String(count + 1).padStart(3, '0')}\`;
  }`;
    expect(OLD).toMatch(/\.count\(/); // 旧写法：自己查表算号 ⇒ 会被「必须走真源」咬住
    expect(OLD).toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*0\s*\)/);
    expect(OLD).not.toContain('nextNumber(');
    expect(OLD).not.toContain("'paymentRequest'");
  });

  it('守卫自检：剥注释后，解释旧写法的注释不再顶红', () => {
    const withComment = [
      '// 旧写法 new Date().toISOString().slice(0, 10) 已修',
      '/* 旧代码还有 .catch(() => 0) */',
      'const x = await sequenceService.nextNumber(tx, \'paymentRequest\');',
    ].join('\n');
    const code = stripComments(withComment);
    expect(code).not.toMatch(/toISOString\(\)\.slice\(0,\s*10\)/);
    expect(code).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*0\s*\)/);
    expect(code).toContain("'paymentRequest'");
  });
});
