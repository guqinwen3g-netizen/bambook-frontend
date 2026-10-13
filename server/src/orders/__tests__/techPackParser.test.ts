/**
 * REQ2-18 Tech Pack 解析器回归测试（设计文档 §5 验收锚点，纯函数零 DB）
 *
 * 覆盖（DR-059-①）：
 *   ① 六类字段全命中（真实成衣 Tech Pack 文本样本）+ 逐字段置信度
 *   ② 尺码表 S/M/L→qty 求和=totalQty；成分多组聚合
 *   ③ 日期多格式归一（ISO/美式/英文月名）
 *   ④ 图片型 PDF fail-fast（<50 字符 → NO_TEXT_LAYER）
 *   ⑤ 部分字段缺失 → absent；QTY 合计 fallback（无表格时 low 置信）
 */
import { describe, expect, it } from 'vitest';
import { parseTechPackText, MIN_TEXT_LEN } from '../techPackParser';

const FULL_TECHPACK = `
TECH PACK — Womens Knit Dress
Style No: WD-2026-118
Season: SS26
Colorways: Black, Navy / Ivory
Fabric Composition: 65% Cotton 35% Polyester
SIZE   S    M    L    XL
QTY    120  240  360  180
Delivery Date: 20 Aug 2026
Care label instructions attached. Trim: nylon zip.
`;

const TAB_SEPARATED = [
  'MENS HOODIE',
  'Style#: TP-9001',
  'COLOR: Navy',
  'Shell: 80% Cotton 20% Polyester',
  'SIZE\tS\tM\tL',
  '100\t200\t300',
  'Ship date 2026/9/15',
  'Contrast panel 100% Polyester for decoration only.',
].join('\n');

describe('parseTechPackText 全字段（DR-059-①）', () => {
  it('六类字段全命中 + 置信度', () => {
    const r = parseTechPackText(FULL_TECHPACK);
    expect(r.ok).toBe(true);
    const s = r.snapshot!;
    expect(s.styleNo).toBe('WD-2026-118');
    expect(s.confidence.styleNo).toBe('high');
    expect(s.season).toBe('SS26');
    expect(s.fabricComposition).toEqual(expect.arrayContaining([
      { pct: 65, fiber: 'Cotton' },
      { pct: 35, fiber: 'Polyester' },
    ]));
    expect(s.confidence.fabricComposition).toBe('high');
    expect(s.colors).toEqual(expect.arrayContaining(['Black', 'Navy', 'Ivory']));
    expect(s.sizeBreakdown).toEqual({ S: 120, M: 240, L: 360, XL: 180 });
    expect(s.totalQty).toBe(900); // Σ 尺码表
    expect(s.deliveryDate).toBe('2026-08-20');
    expect(s.confidence.deliveryDate).toBe('high');
  });

  it('Tab 分隔尺码表 + 美式/斜杠日期 + QTY 数字行', () => {
    const r = parseTechPackText(TAB_SEPARATED);
    expect(r.ok).toBe(true);
    const s = r.snapshot!;
    expect(s.styleNo).toBe('TP-9001');
    expect(s.sizeBreakdown).toEqual({ S: 100, M: 200, L: 300 });
    expect(s.totalQty).toBe(600);
    expect(s.deliveryDate).toBe('2026-09-15');
    expect(s.colors).toContain('Navy');
  });

  it('日期多格式归一：ISO / 美式 / 英文月名前置', () => {
    const mk = (delivery: string) => parseTechPackText(`Tech pack sample style no ABC-1 details here with enough text to pass threshold.\nDelivery: ${delivery}\nFabric: 100% Cotton\n`);
    expect(mk('2026-08-20').snapshot!.deliveryDate).toBe('2026-08-20');
    expect(mk('08/20/2026').snapshot!.deliveryDate).toBe('2026-08-20');
    expect(mk('Aug 20, 2026').snapshot!.deliveryDate).toBe('2026-08-20');
    expect(mk('20 Aug 2026').snapshot!.deliveryDate).toBe('2026-08-20');
  });
});

describe('边界与缺失（DR-059-① fail-fast）', () => {
  it('图片型 PDF（文本层过短）→ NO_TEXT_LAYER 不静默', () => {
    const r = parseTechPackText('  scanned image pdf  ');
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('NO_TEXT_LAYER');
    expect(r.error!.message).toContain('OCR');
  });

  it('空文本同样 fail-fast（阈值 MIN_TEXT_LEN）', () => {
    expect(parseTechPackText('').ok).toBe(false);
    expect('x'.repeat(MIN_TEXT_LEN - 1).length).toBeLessThan(MIN_TEXT_LEN);
  });

  it('无表格时 QTY 合计 fallback（low 置信）；无 QTY → absent', () => {
    const r = parseTechPackText('General spec sheet with style reference ST-77 and fabric notes that make the text long enough for parsing threshold. Total QTY: 1500 pcs.');
    expect(r.ok).toBe(true);
    const s = r.snapshot!;
    expect(s.totalQty).toBe(1500);
    expect(s.confidence.totalQty).toBe('low');
    expect(s.sizeBreakdown).toBeUndefined();
    expect(s.confidence.sizeBreakdown).toBe('absent');
  });

  it('无任何规格字段（纯描述文本）→ 各字段 absent 但不报错', () => {
    const r = parseTechPackText('This is a long descriptive paragraph about general terms and conditions which contains no spec fields at all for testing absent confidence marks.');
    expect(r.ok).toBe(true);
    const s = r.snapshot!;
    expect(s.confidence.styleNo).toBe('absent');
    expect(s.confidence.sizeBreakdown).toBe('absent');
    expect(s.totalQty).toBeUndefined();
  });

  it('成分倒序（FIBER N%）与中文纤维识别', () => {
    const r = parseTechPackText('面料说明：Cotton 98% 氨纶 2%（弹力针织）。款式号 STYLE NO: CN-552 为长袖 T 恤，尺码与数量见下表。\nSIZE  M  L\nQTY   50  60\n');
    expect(r.ok).toBe(true);
    const comp = r.snapshot!.fabricComposition!;
    expect(comp).toEqual(expect.arrayContaining([{ pct: 98, fiber: 'Cotton' }, { pct: 2, fiber: 'Spandex' }]));
  });
});
