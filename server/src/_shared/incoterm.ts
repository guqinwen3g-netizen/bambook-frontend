/**
 * incoterm.ts — 成交方式（Incoterms）解析的**单一真源**（D2）
 *
 * 为什么需要它：两侧数据写法不同 ——
 *   · 订单 `Order.deliveryTerms`：合同写法，**带装运港/目的港**（`FOB SHANGHAI`、`CIF SURABAYA`，
 *     本仓 `customsDocs.ts` 的默认值也是 `'FOB SHANGHAI'`）；
 *   · 报关单 `CustomsDeclaration.tradeTerms`：海关「成交方式」栏，**只填代码**（`FOB` / `CIF`）。
 * ⇒ 直接逐字比会把所有带港口的订单都误报（测试 fixture 实测暴露）。
 *
 * 本模块被两处消费（避免各写一套）：
 *   - `customs/incotermConsistency.ts`（一致性核对）
 *   - `shipping/documentSetService.ts`（制单时的成交方式双源告警）
 */

/** 归一化：去首尾空白、折叠内部空白、大写（吸取 T7-4「先归一化再比」的教训） */
export function normIncoterm(v: unknown): string {
  return String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/** 已知成交方式代码（含旧版术语，避免落到"原样返回"分支） */
export const KNOWN_INCOTERMS = [
  'FOB', 'CIF', 'CFR', 'CIP', 'CPT', 'FCA', 'EXW', 'DDP', 'DAP', 'DPU',
  'DAT', 'DES', 'DEQ', 'DAF',
  // ★ B225：FAS 是 Incoterms 2020 现行 11 条之一，此前不在表里 ⇒ `FAS YOKOHAMA` 提不出代码，
  //   D2 一致性核对会对"合同 FAS / 报关 FAS YOKOHAMA"这种**本来一致**的写法报不一致（假告警）。
  'FAS',
] as const;

/**
 * 提取成交方式代码：`FOB SHANGHAI` → `FOB`、`CIF SURABAYA` → `CIF`、`fob` → `FOB`。
 * 认不出的写法原样返回（比对仍能发现差异，不静默吞掉）。
 */
export function extractIncotermCode(v: unknown): string {
  const t = normIncoterm(v);
  if (!t) return '';
  for (const k of KNOWN_INCOTERMS) {
    if (t === k || t.startsWith(`${k} `) || t.startsWith(`${k},`) || t.startsWith(`${k}.`)) return k;
  }
  return t;
}

/** 两个成交方式写法是否**指向同一成交方式**（提取代码后比较） */
export function sameIncoterm(a: unknown, b: unknown): boolean {
  const ca = extractIncotermCode(a);
  const cb = extractIncotermCode(b);
  return !!ca && !!cb && ca === cb;
}

// ════════════════════════════════════════════════════════════════════
// 成交方式 → 运保费剥离归类：**全仓唯一的一份**（B225 · 变异矩阵 #31）
// ════════════════════════════════════════════════════════════════════
/**
 * 为什么收在这里而不是留在三个消费方各自写一份：
 * 此前 `customs/taxRefundCalcService`、`finance/receiptFobReconciliationService`、
 * `components/CustomsManager` **各持一套术语 Set**（同一口径三份实现，B249/B255 那一族），
 * 于是 `FAS` 这种"三份都没登记"的现行术语会**静默走进默认分支**。
 *
 * ★ 只登记代码，**不做"提取代码"的归一**（`FOB SHANGHAI` 仍算 unknown，与改动前逐字一致）：
 *   报关单 `CustomsDeclaration.tradeTerms` 是海关「成交方式」栏、按代码填（本库 48 行现读全是裸代码 `FOB`）；
 *   把港口名也认下来会让 `CIF SURABAYA` 从"不剥"翻成"要剥"——那是**退税基数的方向性变化**，
 *   不在本批范围，要做得单独量影响面并过使用方。
 */
export type IncotermStripClass = 'no-strip' | 'freight-only' | 'freight-and-insurance' | 'unstrippable' | 'unknown';

const STRIP_CLASS: Record<string, IncotermStripClass> = {
  // 本身就是离岸/出厂价 → 不剥
  EXW: 'no-strip', FCA: 'no-strip', FOB: 'no-strip',
  // ★ FAS **刻意不登记**（台账 B225 明写"该不该剥离属行业口径（M2），先立账不猜"⇒ **归类等使用方拍**）。
  //   它今天落 `unknown` → 与"未填成交方式"同走保守的"不剥"支，金额方向不变。
  //   本批收口的只是"三份名单各写一套"，**不是**替 B225 把口径定掉。
  //   拍板后要做两件事：在这里登记该档 + 撤 `customs/__tests__/taxRefundFobStrip.test.ts` 里的例外名单与 B225。
  // 含运费 → 剥运费
  CFR: 'freight-only', CPT: 'freight-only',
  // 含运费 + 保费 → 两者都剥
  CIF: 'freight-and-insurance', CIP: 'freight-and-insurance',
  // D 组含运保费 + 关税 + 送货，全剥需要关税数据 → 不猜，标记后不参与
  DDP: 'unstrippable', DAP: 'unstrippable', DPU: 'unstrippable',
};

/** 成交方式代码 → 剥离类别；未登记（含旧术语 DAF/DAT/DES/DEQ 与未填）一律 `unknown` ⇒ 消费方按"不剥"保守处理 */
export function incotermStripClass(term: unknown): IncotermStripClass {
  return STRIP_CLASS[normIncoterm(term)] ?? 'unknown';
}
