/**
 * orderAmountTruth.test.ts — 「订单金额唯一真源」的守卫（结构 + 行为）
 *
 * 为什么要有这个测试（2026-09-18）：
 *   系统里曾有 **3 组互相冲突的订单金额口径**，同一张单在概览页与订单详情显示不同值。
 *   Kevin 拍板「以明细行为准」后收成唯一真源 `shared/orderAmount.ts`。
 *   但**收编完还会再漂移** —— 本仓最高产的一类 bug 就是收口点错位，故必须钉住。
 *
 * 四类断言：
 *   ① 行为守卫：真源函数的取值次序与边界（含 Decimal / null / NaN / 负数 / 字符串）
 *   ② 阳性对照：正常值必须取到非 0（否则「机制没跑」也是绿，无法区分）
 *   ③ 结构守卫：**全仓扫描** —— 任何源码都不得再写内联口径字面量
 *      ★ 任务4（2026-09-25）扩容：v1 只查 5 个白名单文件 ⇒ 白名单外的新漂移无人管
 *   ④ 自检函数：findOrderAmountConflict 能抓出主档与明细行打架
 *
 * ⚠️ 源码扫描**必须先剥离注释**再断言 —— 真源文件头与被改文件的注释里必然提到
 *    「不能写 contractAmount ?? quoteAmount」，不剥离就会假红。
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { orderAmountOf, orderAmountOrNull, orderAmountDecimalOrNull, findOrderAmountConflict } from '../shared/orderAmount';

const ROOT = path.resolve(__dirname, '../../..');

/** 模拟 Prisma.Decimal（带 toNumber 的对象） */
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) }) as any;

// ────────────────────────────────────────────────────────────────
// ① 行为守卫：取值次序与边界
// ────────────────────────────────────────────────────────────────
describe('orderAmountOf —— 取值次序（Kevin 拍板：以明细行为准）', () => {
  it('① 有明细行时，明细行绝对优先（即使与 totalNet 冲突）', () => {
    expect(orderAmountOf({
      totalNet: 999, quoteAmount: 888,
      lines: [{ netValue: 100 }, { netValue: 200.5 }],
    })).toBe(300.5);
  });

  it('② 无明细行 → 用 totalNet', () => {
    expect(orderAmountOf({ totalNet: 21150, quoteAmount: 18000, lines: [] })).toBe(21150);
    expect(orderAmountOf({ totalNet: 21150, quoteAmount: 18000, lines: null })).toBe(21150);
  });

  it('③ 无 totalNet → 回退 quoteAmount', () => {
    expect(orderAmountOf({ totalNet: null, quoteAmount: 18000 })).toBe(18000);
  });

  it('④ 全空 → 0（不抛错）', () => {
    expect(orderAmountOf({})).toBe(0);
    expect(orderAmountOf(null)).toBe(0);
    expect(orderAmountOf(undefined)).toBe(0);
  });

  it('⑤ 兼容 Prisma.Decimal', () => {
    expect(orderAmountOf({ totalNet: dec(21150), quoteAmount: dec(18000) })).toBe(21150);
    expect(orderAmountOf({ lines: [{ netValue: dec(100.25) }] })).toBe(100.25);
  });

  it('⑥ 边界：undefined / NaN / 非法字符串 / 负数', () => {
    expect(orderAmountOf({ totalNet: undefined, quoteAmount: undefined })).toBe(0);
    expect(orderAmountOf({ totalNet: NaN, quoteAmount: 100 })).toBe(100); // NaN 不当数，继续回退
    expect(orderAmountOf({ totalNet: 'not-a-number', quoteAmount: 100 })).toBe(100);
    expect(orderAmountOf({ totalNet: -500 })).toBe(-500); // 负数照传（贷项场景），真源不做裁剪
    expect(orderAmountOf({ totalNet: '21150.559' })).toBe(21150.56); // 数字字符串 + 四舍五入到分
  });

  it('⑦ 阳性对照：正常订单必须取到非 0（证明机制真的在跑）', () => {
    const v = orderAmountOf({ totalNet: 21150, quoteAmount: 21150, lines: [{ netValue: 21150 }] });
    expect(v).toBeGreaterThan(0);
    expect(v).toBe(21150);
  });

  it('⑧ 明细行里混有 null 时，只累加有效行（不把 null 当 0 吞掉整行）', () => {
    expect(orderAmountOf({ lines: [{ netValue: 100 }, { netValue: null }, { netValue: 50 }] })).toBe(150);
  });
});

// ────────────────────────────────────────────────────────────────
// ④ 一致性自检
// ────────────────────────────────────────────────────────────────
describe('findOrderAmountConflict —— 主档与明细行打架自检', () => {
  it('一致 → null', () => {
    expect(findOrderAmountConflict({
      totalNet: 100, quoteAmount: 100, contractAmount: 100, lines: [{ netValue: 100 }],
    })).toBeNull();
  });

  it('★ 改价只改 quoteAmount（本次实锤的场景）→ 必须报冲突', () => {
    const r = findOrderAmountConflict({
      totalNet: 21150, quoteAmount: 18000, contractAmount: 21150, lines: [{ netValue: 21150 }],
    });
    expect(r).not.toBeNull();
    expect(r!.conflicts.some((c) => c.includes('quoteAmount'))).toBe(true);
  });

  it('★ 改数量只改主档（本次实锤的场景）→ 明细行金额与主档不一致时报冲突', () => {
    const r = findOrderAmountConflict({
      totalNet: 21150, quoteAmount: 21150, contractAmount: 21150, lines: [{ netValue: 17625 }],
    });
    expect(r).not.toBeNull();
    expect(r!.conflicts.length).toBeGreaterThan(0);
  });

  it('无明细行 → 不误报（信息不足就不下结论）', () => {
    expect(findOrderAmountConflict({ totalNet: 100, quoteAmount: 200, lines: [] })).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────
  // ★ A（第 2 批，2026-09-26）：真源自检补 salesPrice
  //   病根：`salesPrice` 是设计里的「金额联动源」（`contractAmount = salesPrice × quantity`，
  //   见 docs/design/…/订单录入表单.md:127），明细行单价也由它派生
  //   （`lib/orderLineItems.ts:81` `unitPrice: order.salesPrice`）。
  //   但本自检**只看三列**（totalNet/contractAmount/quoteAmount）⇒
  //   「主档 salesPrice=20 而明细行 unitPrice=13.85」这种真实分叉**对守卫完全不可见**。
  //   ⇒ 纳入两条：① salesPrice ↔ 明细行单价 ② salesPrice × quantity ↔ totalNet。
  // ────────────────────────────────────────────────────────────────

  it('★ A：主档 salesPrice 与明细行单价分叉 → 必须报冲突（此前完全不可见）', () => {
    const r = findOrderAmountConflict({
      totalNet: 20775, quoteAmount: 20775, contractAmount: 20775,
      salesPrice: 20, quantity: 1500,
      lines: [{ netValue: 20775, quantity: 1500, unitPrice: 13.85 }],
    });
    expect(r).not.toBeNull();
    expect(r!.conflicts.some((c) => c.includes('salesPrice'))).toBe(true);
  });

  it('★ A：salesPrice × quantity ≠ totalNet → 必须报冲突（三列自洽也可能单价/数量与金额打架）', () => {
    // 三列内部完全一致（20775），但 20 × 1500 = 30000 ⇒ 只有单价×数量这条能抓到
    const r = findOrderAmountConflict({
      totalNet: 20775, quoteAmount: 20775, contractAmount: 20775,
      salesPrice: 20, quantity: 1500,
      lines: [{ netValue: 20775, quantity: 1500, unitPrice: 20 }],
    });
    expect(r).not.toBeNull();
    expect(r!.conflicts.some((c) => c.includes('salesPrice'))).toBe(true);
  });

  it('★ A：只有 salesPrice ↔ 明细行单价这一条能抓到（lineSum 与三列全一致）', () => {
    const r = findOrderAmountConflict({
      totalNet: 30000, quoteAmount: 30000, contractAmount: 30000,
      salesPrice: 20, quantity: 1500,
      lines: [{ netValue: 30000, quantity: 1500, unitPrice: 13.85 }],
    });
    expect(r).not.toBeNull();
    expect(r!.conflicts.some((c) => c.includes('salesPrice') && c.includes('明细行单价'))).toBe(true);
  });

  it('★ A 反面对照：salesPrice 与明细行单价一致 → 不报冲突（防「一律挂冲突」的假可见）', () => {
    expect(findOrderAmountConflict({
      totalNet: 20775, quoteAmount: 20775, contractAmount: 20775,
      salesPrice: 13.85, quantity: 1500,
      lines: [{ netValue: 20775, quantity: 1500, unitPrice: 13.85 }],
    })).toBeNull();
  });

  it('★ A 反面对照：salesPrice 为空（未录）→ 不报冲突（空 ≠ 矛盾，信息不足不下结论）', () => {
    expect(findOrderAmountConflict({
      totalNet: 100, quoteAmount: 100, contractAmount: 100,
      salesPrice: null, quantity: 10,
      lines: [{ netValue: 100, quantity: 10, unitPrice: 10 }],
    })).toBeNull();
  });

  it('★ A 反面对照：多行且单价各不相同 → 主档单价无法归因 ⇒ 不报「单价」冲突', () => {
    // 两行单价 10 / 20（不同），主档 salesPrice=15 是混合均价；
    // 15 × 20 = 300 = totalNet ⇒ 单价×数量这条也不报 ⇒ 整体 null
    expect(findOrderAmountConflict({
      totalNet: 300, quoteAmount: 300, contractAmount: 300,
      salesPrice: 15, quantity: 20,
      lines: [
        { netValue: 100, quantity: 10, unitPrice: 10 },
        { netValue: 200, quantity: 10, unitPrice: 20 },
      ],
    })).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// ③ 结构守卫：订单金额口径不得再散落（★ 全仓扫描）
// ────────────────────────────────────────────────────────────────

/**
 * 「必须 import 真源」的**显式清单**。
 *
 * ⚠️ 这一条**无法全仓自动判定** —— 一个文件「用没用真源」在语法上看不出来，
 *    所以它仍是人工维护的清单。但它**不是**「不得写内联口径」的白名单：
 *    后者见下方 ③ 测试，已改为**全仓扫描**（v1 只查这 5 个文件 ⇒ 白名单外的漂移无人管）。
 */
const CONSUMERS = [
  'server/src/dashboard/dashboardService.ts',
  'server/src/seasons/seasonService.ts',
  'server/src/finance/reconciliationService.ts',
  'server/src/shipping/orderShipmentBatchService.ts',
  'components/Dashboard.tsx',
];

/**
 * ★ 全仓扫描范围（任务4 扩容 · E 批 2026-09-26 加 `customer-portal`）。
 *
 * 排除项及理由：
 *   · **测试文件** —— 阳性对照里**故意**存着旧写法的样本字符串，扫了必假红；
 *   · 构建产物 / 依赖 —— 不是源码。
 *
 * ★ E 批为什么要动这个根：`customer-portal/`（客户门户，**对外**）此前不在扫描面里
 *   ⇒ 门户那两个「Order Value」从头到尾**没有一把尺看过**（判据源 docs/S4验收结论与新增项-2026-09-26.md §F1-c）。
 *   取证：加根后**本条 ③ 的命中数不变（仍为 0）** —— 见 E 步骤0 的只读复量，
 *   所以这一步是"多覆盖"，不是"新增违规"。
 */
const SCAN_ROOTS = ['server/src', 'server/scripts', 'components', 'services', 'lib', 'scripts', 'customer-portal'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js']);
const SCAN_SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', 'out', 'build', '.git']);

/** 递归收集源码文件（目录不存在 ⇒ 跳过，不因范围配置写错而假红） */
function walkSources(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SCAN_SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkSources(full, out);
    else if (SCAN_EXTS.has(path.extname(e.name)) && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 剥离注释：块注释 + 行注释（源码扫描类断言必须先做，否则必假红）。
 *
 * ★★ 关键：**必须保留换行**。第一版把块注释整体替换成 `''` ⇒ 跨行块注释被压掉，
 *    后续所有行**行号整体前移**，报出的 `file:line` 全是错的
 *    （实测：ShippingNoticeGenerator.tsx 真实在 148，报成 145）
 *    —— 同 `s4_scan.mjs` 栽过的坑（故那份清单要求改用 `s4_perm.mjs` 的行号）。
 *    修法：块注释的**非换行字符换成空格**，换行原样保留 ⇒ 行号与原文一一对应。
 *    见下方「阳性对照：剥离注释不得改变行数」。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const AMOUNT_FIELDS = 'contractAmount|totalNet|quoteAmount';

/**
 * 内联口径字面量：把「订单金额」写死成某个字段组合，绕过真源。
 *
 * ★ v2（任务4 修）—— v1 的两个毛病：
 *   ① **只认一个方向**：`contractAmount\s*\?\?\s*quoteAmount` 匹配不到
 *      `quoteAmount ?? contractAmount`（3 行）⇒ 守卫成了逻辑空集（恒绿，永不触发）；
 *   ② **定义了 `/quoteAmount\s*\|\|/` 却从未被应用**（只在阳性对照里露过面）
 *      ⇒ C 组「裸 `quoteAmount` 兜底」无人管。
 *
 * ⚠️ 为什么允许中间隔着 `[^;\n]{0,30}`：真实代码长这样
 *      `num(o.contractAmount) ?? num(o.quoteAmount) ?? 0`
 *    两字段之间夹着 `) ?? num(`。用「不跨分号、不跨行」限界，
 *    既吃下真实写法，又不会跨语句误伤。
 */
const INLINE_PATTERNS: { re: RegExp; why: string; skipSameField?: boolean }[] = [
  {
    re: new RegExp(
      `\\b(${AMOUNT_FIELDS})\\b[^;\\n]{0,30}(?:\\?\\?|\\|\\|)[^;\\n]{0,30}\\b(${AMOUNT_FIELDS})\\b`,
      'g',
    ),
    why: '订单金额回退链（任意顺序 / ?? 或 ||）',
    skipSameField: true, // `quoteAmount ?? quoteAmount` 是字段重复，不是口径回退（procurementService.ts:1441）
  },
  {
    // ★ C 组正则必须**要求 `quoteAmount` 是 `||` 的左操作数**，否则会误抓判空表达式：
    //   `o.quoteAmount == null || …` / `o.quoteAmount != null || …`（procurementRoute.ts:203、
    //   procurementService.ts:1390）—— 那是**存在性判断**，不是口径回退。
    //   允许中间夹成员链 `?.toString?.()`（relationServiceV2 / traceabilityService 的真实写法）。
    re: /\bquoteAmount\b(?:\?\.\w*(?:\(\))?)*\s*\|\|/g,
    why: '裸 quoteAmount 兜底（跳过真源 ② totalNet）',
  },
];

/**
 * C 组（裸 `quoteAmount`）的**误报排除**：
 *   `quoteAmount: withDefaults.quoteAmount || 0`（`orders/orderServiceV2.ts:485`）
 * 是**写入默认值**，与 C 组「取口径」**表达式完全同形**（都是 `x.quoteAmount || 0`），
 * 正则无法从表达式本身区分。唯一可靠判据是**该行是不是对象字面量的键值行** ——
 * 行首（允许缩进）即 `quoteAmount:`。
 */
const IS_QUOTEAMOUNT_KEY_LINE = /^\s*quoteAmount\s*:/;

/** 扫一行，返回命中的口径描述（已做「同字段」与「键值行」排除） */
function inlineHitsInLine(line: string): string[] {
  const hits: string[] = [];
  for (const p of INLINE_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (p.skipSameField && m[1] === m[2]) continue;
      if (p.why.startsWith('裸 quoteAmount') && IS_QUOTEAMOUNT_KEY_LINE.test(line)) continue;
      hits.push(`${p.why} → ${m[0].trim()}`);
    }
  }
  return hits;
}

describe('结构守卫：订单金额口径不得再散落', () => {
  it('① 已知 5 个消费点文件都存在（防止清单本身腐烂）', () => {
    for (const rel of CONSUMERS) {
      expect(fs.existsSync(path.join(ROOT, rel)), `${rel} 应存在`).toBe(true);
    }
  });

  it('② 每个消费点都必须 import 真源', () => {
    for (const rel of CONSUMERS) {
      const src = fs.readFileSync(REL(rel), 'utf8');
      const usesTruth = /from\s+['"][^'"]*shared\/orderAmount['"]/.test(src);
      expect(usesTruth, `${rel} 必须 import shared/orderAmount 的真源`).toBe(true);
    }
  });

  it('★ ③ 全仓不得再写内联口径字面量（剥离注释后断言）', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of SCAN_ROOTS) {
      for (const file of walkSources(path.join(ROOT, root))) {
        scanned += 1;
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        src.split('\n').forEach((line, i) => {
          for (const hit of inlineHitsInLine(line)) {
            offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${hit}`);
          }
        });
      }
    }
    // 阳性对照：真的扫到了源码文件（否则"范围写错"也会绿）
    expect(scanned, '全仓扫描必须真的扫到源码文件').toBeGreaterThan(100);
    expect(
      offenders,
      `以下位置仍在手写订单金额口径，应改用 server/src/shared/orderAmount 的真源：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('★ 阳性对照：守卫本身有效（A / A′ / B / || 变体必须都被抓到）', () => {
    // 用**收编前的真实写法**做样本，而不是理想化的简化写法
    expect(inlineHitsInLine('const salesAmount = num(o.contractAmount) ?? num(o.quoteAmount) ?? 0;').length).toBeGreaterThan(0);
    expect(inlineHitsInLine('const totalAmt = o.quoteAmount ?? o.contractAmount ?? 0;').length).toBeGreaterThan(0); // ★ A′（v1 漏掉的方向）
    expect(inlineHitsInLine('const orderAmount = dec(order.totalNet ?? order.quoteAmount);').length).toBeGreaterThan(0);
    expect(inlineHitsInLine('const revenue = Number(o.contractAmount ?? o.totalNet ?? 0);').length).toBeGreaterThan(0);
    // ★ C 组（v1 定义了却从未应用的那条正则）
    expect(inlineHitsInLine('const totalAmt = active.reduce((s, o) => s + (o.quoteAmount || 0), 0);').length).toBeGreaterThan(0);
    expect(inlineHitsInLine('total_amount: o.quoteAmount || 0,').length).toBeGreaterThan(0);
  });

  it('★ 阴性对照：同字段重复 / 写入默认值 不得误报', () => {
    // 同字段重复（procurementService.ts:1441）—— 是「新值 ?? 旧值」字段合并，不是口径回退
    expect(inlineHitsInLine('const merged = quoteAmount ?? quoteAmount;')).toEqual([]);
    // 写入默认值（orders/orderServiceV2.ts:485）—— 键值行，不是「取口径」
    expect(inlineHitsInLine('        quoteAmount: withDefaults.quoteAmount || 0,')).toEqual([]);
  });

  it('★ 阳性对照：注释剥离确实生效（注释里的口径说明不得误伤）', () => {
    const withComment = '/** 旧口径 contractAmount ?? quoteAmount 已废弃 */\nconst ok = 1;';
    expect(stripComments(withComment)).not.toMatch(/contractAmount\s*\?\?\s*quoteAmount/);
  });

  it('★★ 阳性对照：剥离注释不得改变行数（否则报出的 file:line 会整体漂移）', () => {
    const src = [
      'const a = 1;',
      '/* 跨行块注释',
      '   contractAmount ?? quoteAmount',
      '   还有第三行 */',
      'const b = 2; // 行注释',
      'const c = 3;',
    ].join('\n');
    const out = stripComments(src);
    expect(out.split('\n').length, '行数必须与原文一致').toBe(src.split('\n').length);
    // 且注释内容确实被抹掉（不是只换行不抹内容）
    expect(out).not.toMatch(/contractAmount/);
    // 非注释行内容保持原位
    expect(out.split('\n')[4]).toContain('const b = 2;');
  });
});

// ────────────────────────────────────────────────────────────────
// ⑤ 对外展示口径守卫（E 批 2026-09-26）：钱要上屏 / 落单据，必须走真源
// ────────────────────────────────────────────────────────────────

/**
 * 病形（判据源 `docs/S4验收结论与新增项-2026-09-26.md` §F1）：
 *   订单确认书 PDF 的「TOTAL 合计」渲染 `order.quoteAmount`，而**同一页**的明细行渲染 `l.netValue`
 *   ⇒ 一张 `totalNet ≠ quoteAmount` 的单，客户拿到的单据上「合计」与「明细行加起来」是两个数。
 *   客户门户同形：卡片 "Order Value" 用 `quoteAmount`，同页行表用 `netValue`。
 *
 * ★ 与交接件 §3.1 的**有意分歧**（留给审阅侧推翻，代价已算）：
 *   那里给的「单字段直传」三条并集，实测（E 步骤0 只读复量，同一把尺的口径）在全扫描根命中 **29 行**
 *   —— 靶子 6、**要豁免 23**。那 23 处多数是 `quoteAmount: input.quoteAmount` 一类
 *   **写入 / 多字段透传**（键名 = 字段本意，本身不说谎）。一条八成三靠白名单存活的尺，
 *   白名单就成了新的盲区。⇒ 本批改立**两种真会伤到人的形状**（实测命中 4 + 2、豁免 0）：
 *     **E-1** 钱被格式化函数喂给一个非真源字段（= 真的上屏 / 真的落单据）
 *     **E-2** 键名声称「总额 / 订单金额」，值却是报价额 / 合同额（= 键在说谎）
 *
 * ★ 盲区照实登记（不许读成"已全覆盖"）：`quoteAmount: order.quoteAmount` 这种**键名诚实的 DTO 透传**
 *   本尺**不追** —— 它有害与否取决于下游谁消费，单行不可判。两个已知载体
 *   （`customer/route.ts` 的门户 DTO、`orderConfirmation.ts` 的数据装配）由**行为用例**钉住：
 *   `docTemplates.test.ts` 与 `customerPortal*.test.ts` 里断言「合计 = 明细行合计」，
 *   而不是用白名单把它们放行。
 */

/** 非真源字段：③ 报价额 / contractAmount 合同额 / ② totalNet（页面同时展示明细行时它是"第二个数"） */
const NON_TRUTH_FIELDS = 'quoteAmount|contractAmount|totalNet';
/** 把钱格式化上屏的函数名（服务端模板 + 门户 + 前端共用口径） */
const MONEY_FNS = 'money|fmtMoney|formatMoney|fmtAmount|toMoney';
/** 键名里声称"这是总额 / 订单金额"的写法 */
const TOTALISH_KEYS = 'total|totalAmount|total_amount|orderAmount|order_amount|totalValue|amount|value';
const FIELD_ACCESS = `[A-Za-z_$][\\w$]*\\s*\\??\\.\\s*(?:${NON_TRUTH_FIELDS})\\b`;

const RE_E1 = new RegExp(`\\b(?:${MONEY_FNS})\\s*\\(\\s*${FIELD_ACCESS}`, 'g');
/**
 * ★ E-2 的键**必须允许出现在行首**（对象字面量常一行一键）。
 *   上一版探针要求前面有 `{` 或 `,` ⇒ 把 `server/src/index.ts:1698` 那种行首键整类放走，
 *   量出「命中 0」—— 那是**尺瞎**，不是"没有"（交接件 §3.1 已栽过一次，这里复现过它的修法）。
 */
const RE_E2 = new RegExp(`(?:^|[{,(])\\s*['"]?(?:${TOTALISH_KEYS})['"]?\\s*:\\s*${FIELD_ACCESS}`, 'g');

/**
 * 豁免：**按文件**配置，且必须带「该行原文片段」+「为什么这不违规」。
 *   · 只按文件匹配 ⇒ 别处同名写法照样被抓（不接受"全局豁免某个形状"）；
 *   · 条目若在该文件里**已匹配不到任何行** ⇒ 红（防止代码改了、通行证还留着）。
 */
const DISPLAY_EXEMPTIONS: { file: string; anchor: string; why: string }[] = [];

/** 一行命中几种形状（已剥注释、跳过含 orderAmountOf 的行与类型声明行） */
function displayHitsInLine(line: string): string[] {
  if (line.includes('orderAmountOf')) return [];
  // 类型声明行（`quoteAmount: number | null;`）不是"取口径"
  if (/^\s*[A-Za-z_$][\w$]*\??\s*:\s*(number|string|boolean|Decimal|bigint|unknown|any|Date|null)\b/.test(line)) return [];
  const hits: string[] = [];
  for (const [tag, re] of [['E-1 钱直接格式化非真源字段', RE_E1], ['E-2 键称总额·值为非真源字段', RE_E2]] as const) {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(line)) !== null) hits.push(`${tag} → ${m[0].trim()}`);
  }
  return hits;
}

function isExempted(rel: string, line: string): boolean {
  return DISPLAY_EXEMPTIONS.some((e) => e.file === rel && line.includes(e.anchor));
}

/**
 * 对照样本走**与扫描完全相同的管线**（先剥注释再判）。
 * ★ 直接喂未剥注释的样本来测"注释不该误伤"是没意义的 —— 那样测的是
 *   `displayHitsInLine` 没做它没做的事，会把管线里真正起作用的那一步漏在断言外。
 */
function hitsOf(sample: string): string[] {
  return displayHitsInLine(stripComments(sample));
}

describe('⑤ 对外展示口径守卫（E-1 钱上屏 / E-2 键说谎）', () => {
  it('★ 全仓（含 customer-portal）不得把非真源字段当"订单金额"展示', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of SCAN_ROOTS) {
      for (const file of walkSources(path.join(ROOT, root))) {
        scanned += 1;
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        src.split('\n').forEach((line, i) => {
          const rel = path.relative(ROOT, file);
          for (const hit of displayHitsInLine(line)) {
            if (isExempted(rel, line)) continue;
            offenders.push(`${rel}:${i + 1}  ${hit}`);
          }
        });
      }
    }
    // 分母自检：门户真的在扫描面里（否则"加了根但没扫"照样绿）
    const portalFiles = SCAN_ROOTS.includes('customer-portal')
      ? walkSources(path.join(ROOT, 'customer-portal')).length
      : 0;
    expect(portalFiles, 'customer-portal 必须真的被扫到（加根 ≠ 扫到）').toBeGreaterThan(5);
    expect(scanned, '全仓扫描必须真的扫到源码文件').toBeGreaterThan(100);
    expect(
      offenders,
      `以下位置把非真源字段当订单金额展示/直传，应改用 shared/orderAmount 的 orderAmountOf：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('★ 阳性对照：五种真实形状都必须被咬到', () => {
    const samples = [
      '      <td style="text-align:right">${money(o.quoteAmount, o.currency)}</td>', // E-1（PDF 模板里的真实写法）
      '          {fmtMoney(order.quoteAmount, order.currency)}', // E-1（门户卡片）
      'total_amount: o.quoteAmount,', // E-2：行首键（上一版探针在这里失明）
      '  totalAmount: order.totalNet != null ? Number(order.totalNet) : null,', // E-2 · ② 也算"第二个数"
      'const v = money(o?.quoteAmount, cur);', // E-1 · 可选链
    ];
    const bitCount = samples.filter((s) => hitsOf(s).length > 0).length;
    expect(bitCount, `5 个样本应全被咬到，实际 ${bitCount}`).toBe(5);
    // E-2 单独这一条必须只由 E-2 抓到（证明它不是靠 E-1 蒙对的）
    const keyLie = hitsOf('total_amount: o.quoteAmount,');
    expect(keyLie.some((h) => h.includes('E-2'))).toBe(true);
    expect(keyLie.some((h) => h.includes('E-1'))).toBe(false);
  });

  it('★ 反面对照：走真源 / 键名诚实 / 注释里的旧写法不得假红', () => {
    const ok = [
      'const total = orderAmountOf(order);', // 真源
      '  ${money(total, cur)}', // 格式化的是本地真源变量
      'quoteAmount: input.quoteAmount,', // 写入：键 = 字段本意
      '      quoteAmount: order.quoteAmount != null ? Number(order.quoteAmount) : null,', // 键名诚实的透传（本尺的已知盲区，交给行为用例）
      '  totalNet: order.totalNet,', // 多字段透传，键不说谎
      '  quoteAmount: number | null,', // 类型声明行
      '// money(o.quoteAmount) 是旧写法', // 注释 ⇒ hitsOf 走的是与扫描同一条剥注释管线
    ];
    for (const s of ok) expect(hitsOf(s), `不该误伤：${s}`).toEqual([]);
  });

  it('★★ of/orNull 只能差在 null-vs-0：两条实现的次序必须逐值对撞', () => {
    // 为什么要有这一格：`orderAmountOrNull` 是**重新实现**了 ①②③ 的分支谓词（只把 ③ 兜 0 换成 return null），
    // 而注释说"次序完全一致"是**我写的断言**，没有尺看的时候，将来给 orderAmountOf 加一步 ④ 就会让两者
    // 在同一个输入上给出"一个有数、一个 null"这种静默分叉 ⇒ 这里逐值对撞，把那句话变成判据。
    const vals = [null, undefined, 0, -0, 0.004, NaN, 'abc', '', '21150.559', dec(100), -500];
    const lineSets: any[] = [undefined, [], [{}, { netValue: null }], [{ netValue: 10 }, { netValue: -10 }], [{ netValue: 0 }]];
    let compared = 0;
    for (const totalNet of vals) for (const quoteAmount of vals) for (const lines of lineSets) {
      const row = { totalNet, quoteAmount, lines } as any;
      const a = orderAmountOf(row);
      const b = orderAmountOrNull(row);
      if (b === null) expect(a, 'orNull 说"不知道"时 of 必须给 0：' + JSON.stringify({ totalNet: String(totalNet), quoteAmount: String(quoteAmount) })).toBe(0);
      else expect(b).toBe(a);
      compared += 1;
    }
    expect(compared, '分母自检：矩阵必须真的跑满').toBe(vals.length * vals.length * lineSets.length);
    // 反面对照：矩阵里必须**存在** orNull 给 null 的格子（否则这一格只是在比"两个都是数"）
    const nullCells = [{ totalNet: null, quoteAmount: null, lines: [] }, { totalNet: undefined, quoteAmount: undefined }];
    for (const row of nullCells) expect(orderAmountOrNull(row as any), 'null 档必须真的可达').toBeNull();
  });

  it('★ 通行证本身要有证人：豁免必须逐文件、带原文、失效即红', () => {
    // 越界必被抓：给 A 文件配的豁免，不能放过 B 文件的同类写法
    const rel = 'server/src/templates/docTemplates/orderConfirmation.ts';
    DISPLAY_EXEMPTIONS.forEach((e) => {
      expect(e.file, '豁免必须写明文件').toBeTruthy();
      expect(e.anchor.length, `豁免 ${e.file} 的原文片段太短（会误盖别的行）`).toBeGreaterThan(8);
      expect(e.why.length, '豁免必须写理由').toBeGreaterThan(4);
      const src = stripComments(fs.readFileSync(path.join(ROOT, e.file), 'utf8'));
      const stillThere = src.split('\n').some((line) => line.includes(e.anchor) && displayHitsInLine(line).length > 0);
      expect(stillThere, `豁免条目已匹配不到违规行（代码改了，通行证要删）：${e.file} · ${e.anchor}`).toBe(true);
    });
    // 反面：拿一条真实违规行套到**另一个文件**的豁免上，必须照样被抓
    if (DISPLAY_EXEMPTIONS.length > 0) {
      const e = DISPLAY_EXEMPTIONS[0];
      expect(isExempted(`${e.file}.bak`, e.anchor), '别处同名写法必须照样被抓').toBe(false);
      expect(rel.endsWith('orderConfirmation.ts')).toBe(true);
    }
  });
});

function REL(rel: string): string {
  return path.join(ROOT, rel);
}


describe('financial write amount keeps the canonical precedence with native precision', () => {
  it('native 18,4 line sum wins over conflicting headers without Number rounding', () => {
    const actual = orderAmountDecimalOrNull({ totalNet: '1', quoteAmount: '2',
      lines: [{ netValue: '90071992547409.1234' }, { netValue: '0.8765' }, { netValue: null }] }, Prisma.Decimal);
    expect(actual?.toFixed(4)).toBe('90071992547409.9999');
    expect(orderAmountDecimalOrNull({ totalNet: '90071992547409.1234', quoteAmount: '1' }, Prisma.Decimal)?.toFixed(4)).toBe('90071992547409.1234');
  });
  it('known zero line stays zero; missing and invalid sources stay unknown', () => {
    expect(orderAmountDecimalOrNull({ totalNet: '10', lines: [{ netValue: '0' }] }, Prisma.Decimal)?.toString()).toBe('0');
    expect(orderAmountDecimalOrNull({ totalNet: 'NaN', quoteAmount: '4.0001' }, Prisma.Decimal)?.toString()).toBe('4.0001');
    for (const order of [null, {}, { totalNet: '', quoteAmount: 'Infinity' }, { lines: [{ netValue: null }] }])
      expect(orderAmountDecimalOrNull(order, Prisma.Decimal)).toBeNull();
  });
});
