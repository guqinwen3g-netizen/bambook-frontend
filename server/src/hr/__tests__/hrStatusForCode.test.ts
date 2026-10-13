/**
 * G6.5 真源收口钉子：HR 的 code→status 只允许有一处实现。
 * 期望值**手抄自本文件的表格**（T1：期望值不得抄自现值实现），
 * 因此当真源被改错时这条会红 —— 反过来若又长出第二份内联字面量，由结构断言拦下。
 *
 * 期望值出处：docs/交付目标与验收标准-2026-09-20.md · G6.5 + T1「判据外部化」，
 * 逐码按 HTTP 语义独立核定（RFC 9110：400 请求不合法 / 401 未认证 / 403 无权限 /
 * 404 目标不存在 / 409 状态冲突 / 500 服务器意外故障；四档口径同 brief §Step 2 注释）。
 * **不是**从代码里抄回来的。
 *
 * ★ Task 4b 复审折入：
 *   F2「未归因的码答什么」—— 恢复收口前的 500（`hrStatusForBareCode`），见下面 B 组；
 *   F4 结构判据从「两档 4xx 相邻」放宽到「任何 `CODE: [45]xx` 字面量」（单条表也算副本），
 *      且同时扫 `hrService.ts`（第二份表若长在真源隔壁，以前完全没人看）；
 *   F5 新增「委托上重新挂数字兜底」判据（`hrStatusForCode(code) || 500` 这种半收敛形状）；
 *   F6 逐码钉子从 7 码手写表扩到**普查码集全量**，期望档位由「自述规则」算出，
 *      这样新增长出来的抛出码不可能没人钉。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hrStatusForBareCode, hrStatusForCode } from '../hrService';
import { stripComments } from '../../shared/__tests__/utils/sourceScan';

// 期望值出处：逐码核定 —— 语义决定状态，不读实现。
const EXPECTED: Record<string, number> = {
  UNAUTHORIZED: 401,     // 未登录 / 令牌失效 ⇒ 未认证（RFC 9110 §15.5.2）
  FORBIDDEN: 403,        // 已认证但角色不足 ⇒ 无权限（RFC 9110 §15.5.3）
  TEAM_NOT_FOUND: 404,   // 目标不存在（*_NOT_FOUND 档）
  TEAM_DISSOLVED: 409,   // 对已解散的组再次解散 ⇒ 状态冲突（幂等保护）
  VALIDATION_FAILED: 400, // 入参校验失败 ⇒ 请求不合法（RFC 9110 §15.5.1）
  INVALID_TRANSITION: 409, // 状态机非法迁移 ⇒ 与当前状态冲突
  // ★ 500 只允许这样**显式登记**一张码（服务器内部异常，RFC 9110 §15.6.1），
  // 不许是「没映射到就当 500」的意外兜底 —— 对照下面 T2 那条。
  INTERNAL_ERROR: 500,
};

/** 判据（同源复用，勿各写一份）：整文件任何「`CODE: 4xx|5xx`」字面量对 = 第二张码表 */
const LITERAL_TABLE_RE = /[A-Z][A-Z0-9_]{3,}:\s*[45]\d\d/;
/** 判据（F5）：真源调用被挂上数字兜底 = 兜底口径从真源长回调用方（半收敛的一种） */
const REATTACHED_FALLBACK_RE = /hrStatusFor\w*\s*\([^)]*\)\s*(?:\|\||\?\?)\s*\d/;

function readSrcStripComments(rel: string): string {
  return stripComments(fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8'));
}

/** F6：HR 域**实际外发**的码集由抛出点普查得出（不手抄，手抄的那份会变成第二个真源） */
function hrCodesActuallyThrown(): string[] {
  const out = new Set<string>();
  const dir = path.resolve(__dirname, '..');
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
        for (const m of readSrcStripComments(path.relative(dir, abs)).matchAll(/new HrError\(\s*'([A-Z_0-9]+)'/g)) {
          out.add(m[1]);
        }
      }
    }
  };
  walk(dir);
  return [...out].sort();
}

/**
 * F6：期望档位由**自述规则**算出（本文件 §T2 与真源文档注释同一条口径，来源是 HTTP 语义，
 * 不是 `hrStatusForCode` 的返回值）：抛出点已经是业务错误 ⇒
 * `VALIDATION_FAILED` → 400、`*_NOT_FOUND` → 404、其余业务冲突 → 409。
 */
function expectedTierForHrCode(code: string): number {
  if (code === 'VALIDATION_FAILED') return 400;
  if (code.endsWith('_NOT_FOUND')) return 404;
  return 409;
}

describe('★ HR code→status 单一真源（G6.5）', () => {
  it.each(Object.entries(EXPECTED))('%s → %i（按 HTTP 语义，非抄现值）', (code, status) => {
    expect(hrStatusForCode(code)).toBe(status);
  });

  it('★ F6 普查码集全量钉：15 支实际抛出的码逐一等于自述规则（新增码不可能漏钉）', () => {
    const codes = hrCodesActuallyThrown();
    // 先证明普查本身不是空的（空集会让下面 it.each 恒绿）
    expect(codes.length, '码集普查为空 ⇒ 抽取判据失效').toBeGreaterThanOrEqual(10);
    expect(codes).toContain('VALIDATION_FAILED');
    expect(codes).toContain('CAPACITY_FULL'); // 409 档的代表（曾被 7 码表漏掉，F6 的成因）
  });

  it.each(hrCodesActuallyThrown().map((c) => [c, expectedTierForHrCode(c)] as const))(
    '★ F6 普查码 %s → %i（期望值出自本文件的规则，不是出自实现）',
    (code, status) => {
      expect(hrStatusForCode(code), `${code} 的档位被改动 ⇒ 要么改错，要么本文件的规则要重新核定`)
        .toBe(status);
    },
  );

  it('★ T2 负面用例：未登记的码走文档化兜底 409（全函数，绝不 undefined、也不拿 500 当兜底）', () => {
    // 「500-by-accident」= 映射表落空后调用方 || 500 / res.status(undefined)。
    // 真源对**业务 HrError** 是全函数：任何码都给数；未登记的业务码按「其余业务冲突 → 409」文档口径兜底。
    // ★ F2 边界：这条 409 只适用于「已经归因成业务错误」的码；裸码（非 HrError）走下面 B 组的 500。
    const status = hrStatusForCode('A_CODE_SOMEONE_WILL_ADD_TOMORROW');
    expect(status, '真源不得对未知码返回 undefined（否则 res.status(undefined)）').not.toBeUndefined();
    expect(status).toBe(409);
  });
});

/**
 * ★ F2（复审 Important）：两个组端点原写的是 `statusMap[code] || 500` —— **认不出的码答 500**。
 * 第一次收敛把这条腿并进了真源的 409 兜底（未申报的行为变化），本组把它钉回原值：
 * 「非业务 HrError / 真源认不出 ⇒ 500」= **恢复收口前行为**，不是改行为。
 * 500 这条兜底全仓只允许出现在 `hrStatusForBareCode` 一处（见下面的计数钉）。
 */
describe('★ F2 · 裸码（非 HrError）认不出时答 500（恢复收口前的 || 500 口径）', () => {
  it.each([
    ['UNAUTHORIZED', 401],   // 未认证（§15.5.2）——已登记的码两包装同值
    ['FORBIDDEN', 403],      // 无权限（§15.5.3）
    ['TEAM_NOT_FOUND', 404], // 目标不存在（§15.5.5）
    ['TEAM_DISSOLVED', 409], // 状态冲突（§15.5.12）
    ['INTERNAL_ERROR', 500], // 服务端故障（§15.6.1）
  ] as const)('已登记的裸码 %s → %i（与收口前 statusMap 同值）', (code, status) => {
    expect(hrStatusForBareCode(code)).toBe(status);
  });

  it('★ 未登记的裸码 → 500（不是 409：系统不能替一个不认识的码宣布「状态冲突」）', () => {
    expect(hrStatusForBareCode('A_TEAM_CODE_ADDED_NEXT_WEEK')).toBe(500);
    // 与 A 组那条对照即 F2 的全部差异：同一枚认不出的码，
    // 业务 HrError → 409（冲突档），裸码 → 500（未归因）。
    expect(hrStatusForCode('A_TEAM_CODE_ADDED_NEXT_WEEK')).toBe(409);
  });

  it('★ 计数钉：「认不出 ⇒ 500」这一条在 src/hr 只出现一处（兜底不许在调用点各写一份）', () => {
    const dir = path.resolve(__dirname, '..');
    const hits: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = readSrcStripComments(f);
      for (const m of src.matchAll(/\?\?\s*500|\|\|\s*500/g)) hits.push(`${f}:${m.index}`);
    }
    expect(hits, `兜底 500 出现在 ${JSON.stringify(hits)} ⇒ 收口前的那条默认又长出多份`).toHaveLength(1);
    expect(readSrcStripComments('hrService.ts')).toMatch(/hrStatusTierForCode\(code\)\s*\?\?\s*500/);
  });
});

describe('★ G6.5 结构守卫：真源之外不得再有第二份 code→status 规则', () => {
  it('★ F4 加宽版：route.ts / hrService.ts 内不得有内联 statusCode 字面量表（单条也算）', () => {
    // 判据形状与 domainErrorShapes.test.ts 的 LEFTOVER_RULE_RE 同款（[45]\d\d）：
    // 旧写法要求「两个相邻 4xx 对」，因此 `{ TEAM_DISSOLVED: 409 }` 这种单条表、
    // 以及长在 hrService.ts 隔壁的第二份表都能溜过去（复审 F4）。
    for (const rel of ['route.ts', 'hrService.ts']) {
      const src = readSrcStripComments(rel);
      expect(src, `${rel} 里出现了 CODE: 4xx|5xx 字面量对 ⇒ 第二张码表`).not.toMatch(LITERAL_TABLE_RE);
    }
    // 且真源必须真的被接到出口上：B22 收敛后 `hrErrorStatus` 已删（路由不再二次推状态），
    // 规则改由 HrError 构造器的默认值一处消费 ⇒ 这条接线必须钉住，否则真源成了死代码、
    // 路由会拿 `err.statusCode`（undefined）去 `res.status()`。
    expect(readSrcStripComments('hrService.ts')).toMatch(/constructor\([^)]*statusCode\s*=\s*hrStatusForCode\(/);
    // 裸码那两端点（dissolveTeam 的返回值不是 HrError 实例）仍走裸码包装
    expect(readSrcStripComments('route.ts')).toMatch(/hrStatusForBareCode/);
  });

  it('★ 接线形状钉子：裸码包装 2 处调用（两个组端点）、业务码包装 0 处（路由不再自行推状态）', () => {
    // F2 的恢复靠的就是裸码这条接线：把某个组端点改回 `hrStatusForCode(...)`，等于让 409 兜底
    // 重新接管那个端点（未申报的行为变化复发），本条当场红。
    // 业务码那一侧的 0 是 B22 的结果：`route.ts` 只透传 `HrError.statusCode`，不再第二处推码。
    const route = readSrcStripComments('route.ts');
    expect(route.match(/hrStatusForBareCode\(/g)?.length, '裸码包装的调用点数不对（两个组端点各一处）').toBe(2);
    expect(route.match(/hrStatusForCode\(/g)?.length ?? 0, '路由里又长出第二处 code→status 推导').toBe(0);
  });

  it('★ B22：route.ts 的错误出口只许 safeRouteError，原始错误文本不得外发', () => {
    const route = readSrcStripComments('route.ts');
    // 逐处核准后的收敛数（本文件由 `message: err.message` 36 处收敛而来）：只许降不许升
    expect(route.match(/safeRouteError\(err, \{ fallbackCode/g)?.length, 'safeRouteError 调用点数与基线不符').toBe(35);
    expect(route, '路由里又出现把原始错误文本外发的写法').not.toMatch(/message:\s*(err|e)\.message/);
    // 阳性对照（防恒真）：本条删掉前的真实形状必须被抓得住
    expect("res.status(500).json({ ok: false, message: err.message });").toMatch(/message:\s*(err|e)\.message/);
  });

  it('★ F5：委托上不得重新挂数字兜底（route.ts 全文）', () => {
    // 收口后 `hrStatusForCode(err.code) || 500` / `?? 500` 这种形状=把兜底口径从真源
    // 搬回调用方（半收敛的一种，且正是 F2 的诱因）。真源是全函数，`|| 500` 还是死腿。
    expect(readSrcStripComments('route.ts')).not.toMatch(REATTACHED_FALLBACK_RE);
  });

  it('★ 阳性对照 1：上述两条判据必须抓得住真样本（防正则恒不匹配 = 恒真守卫）', () => {
    // F4：两张相邻码对 / **单条**表 / 写在 hrService 隔壁的第二份表
    expect("const m = { UNAUTHORIZED: 401, TEAM_NOT_FOUND: 404 };").toMatch(LITERAL_TABLE_RE);
    expect("const one = { TEAM_DISSOLVED: 409 };").toMatch(LITERAL_TABLE_RE);
    expect("const five = { INTERNAL_ERROR: 500 };").toMatch(LITERAL_TABLE_RE);
    // F5：`||` 与 `??` 两种挂法、以及带包装名的委托
    expect('return hrStatusForCode(err.code) || 500;').toMatch(REATTACHED_FALLBACK_RE);
    expect('return hrStatusForBareCode(result.error.code) ?? 409;').toMatch(REATTACHED_FALLBACK_RE);
    // 反面对照：真身的两个出口都不该被误判
    expect('return hrStatusForCode(err.code);').not.toMatch(REATTACHED_FALLBACK_RE);
    expect('return hrStatusTierForCode(code) ?? 409;').not.toMatch(REATTACHED_FALLBACK_RE);
  });
});
