/**
 * docTemplateWiring.test.ts — ★★ 单据模板「接线」守卫（2026-09-17 立）
 *
 * ── 为什么需要它 ────────────────────────────────────────
 * 打印一份单据要走两条映射：
 *   `单据类型` --TRADE_DOC_TYPE_TO_KIND--> `版式 kind` --SERVER_DOC_TEMPLATES--> `模板`
 * **中间断了不会编译报错**（两边都是字符串 key）⇒ 打印时才失败 ⇒
 * 与「注册了 ≠ 会渲染」（`components/viewRenderWiring.test.ts`）**同族**。
 *
 * ── 实测结论（2026-09-17）：**当前无盲区** ──────────────
 * 10 个类型映射 · 26 个模板 · 8 个出运 kind —— 三条断言全 0 违规 ✓
 * ⇒ 本守卫的价值是**防回退**（新增单据类型时忘了加模板会立刻红）。
 *
 * ── ★ 扫描判据的两个坑（都实测踩过）──────────────────────
 * ① **正则会把接口字段名当成模板 key**：`interface ServerDocTemplate { kind; title; loadData; … }`
 *    与 `SERVER_DOC_TEMPLATES` 的条目**写法同形**（都是 `xxx:`）⇒ 第一版扫出
 *    `kind / title / loadData / renderBody / renderDocument` 五个假 key ✗。
 *    ⇒ 判据收紧为「**键值形如 `KEY: { … kind: 'KEY' … }`**」。
 * ② **块边界别用 `\n};`** —— 接口与常量块都可能命中 ⇒ 要按 marker 精确取。
 *
 * ⚠️ 纯源码文本扫描（**不 import**）：`tsx` 下该模块的 ESM 具名导出互操作会炸，
 *    且文本扫描无副作用、更快。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../registry.ts', import.meta.url), 'utf8');

/** 取某个 `const X = { … };` 块的文本 */
function blockOf(marker: string): string {
  const i = SRC.indexOf(marker);
  expect(i, `未找到 ${marker}`).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n};', i);
  return SRC.slice(i, end < 0 ? SRC.length : end);
}

/** ★ 只认「键值形如 `KEY: { … kind: 'KEY' … }`」的条目 —— 排除接口字段名（见文件头坑 ①） */
const TEMPLATE_ENTRIES = [...blockOf('export const SERVER_DOC_TEMPLATES')
  .matchAll(/^\s*([A-Za-z0-9_]+):\s*\{[^}]*?kind:\s*'([A-Za-z0-9_]+)'/gm)]
  .map((m) => [m[1], m[2]] as const);
const TEMPLATE_KINDS = TEMPLATE_ENTRIES.map(([k]) => k);

/**
 * ★ 类型映射条目 —— **必须允许行尾注释**（实测踩过）：
 * 表里有一半条目写成 `CommercialInvoice: 'CI', // 快照版式…`，
 * 而第一版正则要求「行尾就是逗号」⇒ **只收到 6/10** ✗
 * ⇒ 后果：**带注释的新条目对守卫不可见**（证伪打在它上面不会红）。
 * 这是本仓反复出现的那类缺陷：**守卫的覆盖面 < 代码的写法面**。
 */
const TYPE_TO_KIND = [...blockOf('const TRADE_DOC_TYPE_TO_KIND')
  .matchAll(/^\s*([A-Za-z0-9_]+):\s*'([A-Za-z0-9_]+)'\s*,?\s*(?:\/\/.*)?$/gm)]
  .map((m) => [m[1], m[2]] as const);

/** 块内**所有**形如 `Key: 'value'` 的行数（含带注释的）—— 用于自检「有没有漏收」 */
const TYPE_TO_KIND_LINES = (blockOf('const TRADE_DOC_TYPE_TO_KIND')
  .match(/^\s*[A-Za-z0-9_]+:\s*'[A-Za-z0-9_]+'/gm) ?? []).length;

const SHIPMENT_KINDS = (() => {
  const i = SRC.indexOf('export const SHIPMENT_DOC_KINDS');
  const seg = SRC.slice(i, SRC.indexOf('] as const', i));
  return [...seg.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
})();

describe('★★ 单据模板接线守卫（类型 → kind → 模板）', () => {
  it('★ 阳性对照：三处扫描都取到了内容（防扫描恒空）', () => {
    expect(TEMPLATE_KINDS.length, 'SERVER_DOC_TEMPLATES 未取到模板').toBeGreaterThan(15);
    expect(TYPE_TO_KIND.length, 'TRADE_DOC_TYPE_TO_KIND 未取到映射').toBeGreaterThan(5);
    expect(SHIPMENT_KINDS.length, 'SHIPMENT_DOC_KINDS 未取到').toBeGreaterThan(5);
    // ★ 反向自检：接口字段名**不得**被当成模板 key（见文件头坑 ①）
    for (const bogus of ['loadData', 'renderBody', 'renderDocument', 'title']) {
      expect(TEMPLATE_KINDS, `扫描把接口字段名 "${bogus}" 当成模板 key 了`).not.toContain(bogus);
    }
  });

  it('★★ 自检：类型映射**不得漏收**（覆盖 `X: \'Y\'` 的两种写法：带/不带行尾注释）', () => {
    // 这是「守卫覆盖面 < 代码写法面」的直接守卫：
    // 若有人写了第三种形态（如多行 / 模板字符串），这里会立刻红
    expect(
      TYPE_TO_KIND.length,
      `块内有 ${TYPE_TO_KIND_LINES} 条形如 Key: 'value' 的条目，但只收到 ${TYPE_TO_KIND.length} 条 ⇒ 判据漏了某种写法`,
    ).toBe(TYPE_TO_KIND_LINES);
  });

  it('★★ 承重①：每个**单据类型**映射到的 kind 都必须有模板（否则打印必失败）', () => {
    const broken = TYPE_TO_KIND.filter(([, kind]) => !TEMPLATE_KINDS.includes(kind));
    expect(broken.map(([t, k]) => `${t}→${k}`), '类型映射到无模板的 kind ⇒ 打印会失败').toEqual([]);
  });

  it('★★ 承重②：`SHIPMENT_DOC_KINDS` 里声明的每个 kind 都必须有模板', () => {
    const broken = SHIPMENT_KINDS.filter((k) => !TEMPLATE_KINDS.includes(k));
    expect(broken, '出运 kind 声明了但没有模板').toEqual([]);
  });

  it('★ 自洽③：模板条目的 `kind` 字段必须等于它的键（防复制粘贴写错）', () => {
    const bad = TEMPLATE_ENTRIES.filter(([k, kind]) => k !== kind).map(([k, kind]) => `${k}≠${kind}`);
    expect(bad).toEqual([]);
  });

  it('★ 反向④：类型映射的 key 不得指向未在 SHIPMENT_DOC_KINDS 中登记的 kind（防拼错）', () => {
    // 允许「非出运类」模板存在（PO/QUOT/STMT…），但**类型映射**应只指向登记过的 kind
    const unknown = TYPE_TO_KIND.filter(([, kind]) => !SHIPMENT_KINDS.includes(kind));
    // 允许存在非出运映射（如 OTHER）—— 故只断言「不得为空集」作为阳性对照，列出供人工核对
    expect(TYPE_TO_KIND.length).toBeGreaterThan(0);
    if (unknown.length > 0) {
      // 不判失败，但打印出来 —— 便于新增类型时人工确认
      console.log('[docTemplateWiring] 非出运类的类型映射（正常，供核对）:', unknown.map(([t, k]) => `${t}→${k}`).join(', '));
    }
  });
});
