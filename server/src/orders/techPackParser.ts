/**
 * techPackParser.ts — REQ2-18 Tech Pack 结构化解析（DR-059-①）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Orders-订单管理/TechPack解析.md
 *
 * 纯函数规则引擎（不碰 DB，与 import 域 detectCustomer 同范式）：
 *   六类字段 + 逐字段置信度（high=模式直接命中 / low=推断 / absent=未检出）
 *   - styleNo（STYLE NO/款号 附近编码）
 *   - season（SS25/FW26 等季型）
 *   - fabricComposition（`N% FIBER` 多组聚合，含中文纤维名）
 *   - colors（COLOR(S)(WAY) 后词 + 常见色词扫描）
 *   - sizeBreakdown（SIZE 表头行 + S/M/L/XL 或数字尺码 → qty 映射；totalQty=Σ）
 *   - deliveryDate（DELIVERY/SHIP 附近日期，多格式归一 YYYY-MM-DD）
 *
 * 图片型 PDF fail-fast：文本层过短（<MIN_TEXT_LEN）→ NO_TEXT_LAYER（扫描件需 OCR，不静默空结果）。
 */

export type FieldConfidence = 'high' | 'low' | 'absent';

export interface TechPackSnapshot {
  styleNo?: string | null;
  season?: string | null;
  fabricComposition?: Array<{ pct: number; fiber: string }> | null;
  colors?: string[] | null;
  sizeBreakdown?: Record<string, number> | null;
  totalQty?: number | null;
  deliveryDate?: string | null; // YYYY-MM-DD
  confidence: Record<string, FieldConfidence>;
  pages?: number;
  textLength: number;
  uploadedAt?: number;
}

export interface TechPackParseResult {
  ok: boolean;
  error?: { code: string; message: string };
  snapshot?: TechPackSnapshot;
}

/** 图片型 PDF（扫描件）判定阈值：文本层有效字符数 */
export const MIN_TEXT_LEN = 50;

const FIBER_WORDS: Record<string, string> = {
  cotton: 'Cotton', polyester: 'Polyester', nylon: 'Nylon', spandex: 'Spandex',
  elastane: 'Elastane', viscose: 'Viscose', rayon: 'Rayon', wool: 'Wool',
  linen: 'Linen', acrylic: 'Acrylic', modal: 'Modal', tencel: 'Tencel',
  lyocell: 'Lyocell', silk: 'Silk', 棉: 'Cotton', 涤纶: 'Polyester', 锦纶: 'Nylon',
  氨纶: 'Spandex', 粘胶: 'Viscose', 腈纶: 'Acrylic', 羊毛: 'Wool', 亚麻: 'Linen',
};

const COLOR_WORDS = [
  'Black', 'White', 'Navy', 'Blue', 'Red', 'Green', 'Yellow', 'Grey', 'Gray',
  'Beige', 'Khaki', 'Pink', 'Purple', 'Orange', 'Brown', 'Cream', 'Ivory',
  'Camel', 'Burgundy', 'Olive', 'Teal', 'Charcoal', '黑色', '白色', '藏青', '红色', '绿色', '灰色', '米色', '军绿',
];

const SIZE_TOKENS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL'];
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

/** 多格式日期 → YYYY-MM-DD（不支持的不强行归一，返回 null） */
function normalizeDate(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, ' ');
  // 2026-08-20 / 2026/8/20 / 2026.08.20
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // 20 Aug 2026 / Aug 20, 2026 / 20-Aug-2026
  m = s.match(/^(?:(\d{1,2})[\s-]+)?([A-Za-z]{3,9})[\s,-]+(\d{1,2})?,?\s*(\d{4})$/);
  if (m) {
    const monWord = m[2]; // 第一个字母组恒为月份（可选日前缀在前）
    const day = m[1] && /^\d+$/.test(m[1]) ? m[1] : m[3];
    const year = m[4];
    const mm = MONTHS[monWord.toLowerCase().slice(0, 4)] ?? MONTHS[monWord.toLowerCase().slice(0, 3)];
    if (mm && day && year) return `${year}-${mm}-${String(day).padStart(2, '0')}`;
  }
  // 08/20/2026（美式）
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** 成分提取：`65% Cotton 35% Polyester`（英文正序）/ `Cotton 98%`（英文倒序）/ `棉 98%`（中文倒序） */
function parseFabricComposition(text: string): Array<{ pct: number; fiber: string }> | null {
  const out = new Map<string, number>();
  const put = (fiber: string, pct: number) => {
    if (pct >= 1 && pct <= 100) out.set(fiber, Math.max(out.get(fiber) ?? 0, pct));
  };
  let m: RegExpExecArray | null;
  // 英文正序：N% Cotton
  const reEn = /(\d{1,3})\s*%\s*([A-Za-z]+)/g;
  while ((m = reEn.exec(text)) !== null) {
    const word = m[2].toLowerCase();
    const fiber = FIBER_WORDS[word] ?? FIBER_WORDS[word.replace(/(s|es)$/, '')] ?? null;
    if (fiber) put(fiber, Number(m[1]));
  }
  // 英文倒序：Cotton 98%（正序未覆盖的纤维才补）
  const reEnRev = /([A-Za-z]+)\s+(\d{1,3})\s*%/g;
  while ((m = reEnRev.exec(text)) !== null) {
    const word = m[1].toLowerCase();
    const fiber = FIBER_WORDS[word] ?? FIBER_WORDS[word.replace(/(s|es)$/, '')] ?? null;
    if (fiber && !out.has(fiber)) put(fiber, Number(m[2]));
  }
  // 中文倒序：棉 98%（中文习惯语序）
  const reCn = /([\u4e00-\u9fa5]{1,4})\s*(\d{1,3})\s*%/g;
  while ((m = reCn.exec(text)) !== null) {
    const fiber = FIBER_WORDS[m[1]] ?? null;
    if (fiber && !out.has(fiber)) put(fiber, Number(m[2]));
  }
  if (out.size === 0) return null;
  return [...out.entries()].map(([fiber, pct]) => ({ pct, fiber }));
}

/** 颜色提取：COLOR(S)(WAY): 后词 + 全文常见色词扫描（去重，保留出现顺序） */
function parseColors(text: string): string[] | null {
  const found: string[] = [];
  const push = (c: string) => {
    const t = c.trim();
    if (t && t.length >= 2 && !found.some(f => f.toLowerCase() === t.toLowerCase())) found.push(t);
  };
  const reLabel = /colou?r(?:s|ways?)?\s*[:：]\s*([A-Za-z\u4e00-\u9fa5][A-Za-z\u4e00-\u9fa5 ,，/]{1,40})/gi;
  let m: RegExpExecArray | null;
  while ((m = reLabel.exec(text)) !== null) {
    const after = m[1].split(/[,，;；/|]/).map(s => s.trim()).filter(Boolean);
    after.forEach(push);
  }
  for (const w of COLOR_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, 'i');
    if (re.test(text)) push(w);
  }
  return found.length > 0 ? found.slice(0, 12) : null;
}

/** 尺码表提取：SIZE 行（S M L XL 或数字尺码）+ 紧随数字行 → size→qty；totalQty=Σ */
function parseSizeBreakdown(text: string): { sizeBreakdown: Record<string, number>; totalQty: number } | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const tokenRe = /^([2-9]|[1-9]\d)$|^(XS|S|M|L|X{1,5}L|\dXL)$/i;

  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split(/\s{2,}|\t|\s*\|\s*|,/).map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    // 表头行：首格含 SIZE/QTY 关键词且其余格多为尺码 token
    const headerLooksSize = /size|尺码|尺寸/i.test(cells[0])
      || (cells.length >= 2 && cells.slice(0, Math.min(cells.length, 8)).every(c => tokenRe.test(c)));
    if (!headerLooksSize) continue;

    const sizes: string[] = [];
    for (const c of cells.slice(0, 10)) {
      if (tokenRe.test(c) && !/size|尺码|尺寸|qty|数量/i.test(c)) {
        const norm = /^(?:[2-9]|[1-9]\d)$/.test(c) ? c : c.toUpperCase();
        if (!sizes.includes(norm)) sizes.push(norm);
      }
    }
    if (sizes.length < 2) continue;

    // 紧随行：QTY 行或数字行（与 sizes 对齐）
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const qtyCells = lines[j].split(/\s{2,}|\t|\s*\|\s*|,/).map(c => c.trim()).filter(Boolean);
      const numeric = qtyCells.filter(c => /^\d{1,7}$/.test(c));
      // qtyCells 可能为 [ 'QTY', '100', '200', ... ] 或纯数字行
      const qtyLabelIdx = qtyCells.findIndex(c => /qty|quantity|数量/i.test(c));
      const hasQtyLabel = qtyLabelIdx >= 0;
      if (!hasQtyLabel && numeric.length < 2) continue;

      const values = hasQtyLabel
        ? qtyCells.slice(qtyLabelIdx + 1).filter(c => /^\d{1,7}$/.test(c)).map(Number)
        : numeric.map(Number);
      if (values.length === 0) continue;

      const sizeBreakdown: Record<string, number> = {};
      const n = Math.min(sizes.length, values.length);
      for (let k = 0; k < n; k++) sizeBreakdown[sizes[k]] = values[k];
      const totalQty = Object.values(sizeBreakdown).reduce((s, v) => s + v, 0);
      if (totalQty > 0) return { sizeBreakdown, totalQty };
    }
  }
  return null;
}

/** 主入口：Tech Pack 文本 → 结构化快照（纯函数） */
export function parseTechPackText(text: string): TechPackParseResult {
  const clean = (text ?? '').replace(/\u0000/g, '').trim();
  if (clean.length < MIN_TEXT_LEN) {
    return {
      ok: false,
      error: { code: 'NO_TEXT_LAYER', message: `PDF 无有效文本层（${clean.length} 字符 < ${MIN_TEXT_LEN}）——扫描件需 OCR，当前版本不支持图片型规格书` },
    };
  }

  const confidence: Record<string, FieldConfidence> = {};
  const snapshot: TechPackSnapshot = { confidence, textLength: clean.length };

  // ── styleNo ──
  let m = clean.match(/style\s*(?:no\.?|number|#|name|code)?\s*[:：]?\s*([A-Z0-9][A-Z0-9\-\/_]{2,24})/i);
  if (m) {
    snapshot.styleNo = m[1].toUpperCase();
    confidence.styleNo = 'high';
  } else {
    confidence.styleNo = 'absent';
  }

  // ── season ──
  m = clean.match(/\b(S{1,2}|F{1,2}|A)\s?(\d{2})\b/);
  if (m && /season|季/i.test(clean)) {
    snapshot.season = `${m[1]}${m[2]}`;
    confidence.season = 'low';
  } else if (m) {
    snapshot.season = `${m[1]}${m[2]}`;
    confidence.season = 'low';
  } else {
    confidence.season = 'absent';
  }

  // ── fabricComposition ──
  const comp = parseFabricComposition(clean);
  if (comp) {
    snapshot.fabricComposition = comp;
    confidence.fabricComposition = comp.length >= 1 && comp.reduce((s, c) => s + c.pct, 0) >= 90 ? 'high' : 'low';
  } else {
    confidence.fabricComposition = 'absent';
  }

  // ── colors ──
  const colors = parseColors(clean);
  if (colors) {
    snapshot.colors = colors;
    confidence.colors = /colou?r/i.test(clean) ? 'high' : 'low';
  } else {
    confidence.colors = 'absent';
  }

  // ── sizeBreakdown + totalQty ──
  const sizes = parseSizeBreakdown(clean);
  if (sizes) {
    snapshot.sizeBreakdown = sizes.sizeBreakdown;
    snapshot.totalQty = sizes.totalQty;
    confidence.sizeBreakdown = 'high';
    confidence.totalQty = 'high';
  } else {
    // 无表格时找 QTY/QUANTITY 合计
    m = clean.match(/(?:total\s*)?(?:qty|quantity)\s*[:：]?\s*(\d{2,7})/i);
    if (m) {
      snapshot.totalQty = Number(m[1]);
      confidence.totalQty = 'low';
      confidence.sizeBreakdown = 'absent';
    } else {
      confidence.sizeBreakdown = 'absent';
      confidence.totalQty = 'absent';
    }
  }

  // ── deliveryDate（DELIVERY/SHIP 附近日期，多格式） ──
  const dateContext = clean.match(
    /(?:deliver(?:y)?|shipment|ship\s*date|ex-?factory|交货|交期)[^\n]{0,60}?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i,
  );
  if (dateContext) {
    const norm = normalizeDate(dateContext[1]);
    if (norm) {
      snapshot.deliveryDate = norm;
      confidence.deliveryDate = 'high';
    } else {
      confidence.deliveryDate = 'low';
    }
  } else {
    confidence.deliveryDate = 'absent';
  }

  return { ok: true, snapshot };
}
