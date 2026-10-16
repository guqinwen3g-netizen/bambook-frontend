/** BB-QUO-2：报价条目结构化规格与 MOQ 提示。缺失值留空并显示“未填写”，不猜；低于 MOQ 只提示，不触发审批。 */
import type { FabricDevelopmentRequirements } from './mistDevelopmentDomain';

export type QuoteSpecFamily = 'fabric' | 'garment';
export type QuoteLineSpecs = { composition?: string; weight?: string; width?: string; sizeRange?: string; mainFabric?: string; moqQty?: string; moqUnit?: string };
export const QUOTE_SPEC_FIELDS: Record<QuoteSpecFamily, Array<{ key: 'composition' | 'weight' | 'width' | 'sizeRange' | 'mainFabric'; label: string; unit?: string }>> = {
  fabric: [{ key: 'composition', label: '成分' }, { key: 'weight', label: '克重', unit: 'g/m²' }, { key: 'width', label: '门幅', unit: 'cm' }],
  garment: [{ key: 'sizeRange', label: '尺码段' }, { key: 'mainFabric', label: '主面料' }],
};
export const QUOTE_MOQ_LABEL: Record<QuoteSpecFamily, string> = { fabric: '每色 MOQ', garment: 'MOQ' };
export const QUOTE_SPEC_MISSING = '未填写';
const NUMBER = /^\d{1,4}(\.\d{1,2})?$/, QTY = /^\d{1,9}(\.\d{1,4})?$/;

/** 服务端规范化：只保留本板块字段；克重 / 门幅须为数字；MOQ 数量为正数且单位须是本板块计价单位。 */
export function normalizeQuoteSpecs(family: QuoteSpecFamily, value: unknown, units: readonly string[], lineName: string, fail: (message: string) => never): QuoteLineSpecs {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail(`条目「${lineName}」规格格式无效`);
  const raw = value as Record<string, unknown>, out: QuoteLineSpecs = {};
  const text = (key: keyof QuoteLineSpecs, label: string) => { const v = raw[key]; if (v === undefined || v === null || v === '') return; if (typeof v !== 'string' || v.length > 200) fail(`条目「${lineName}」${label}格式无效`); if (v.trim()) out[key] = v.trim(); };
  for (const f of QUOTE_SPEC_FIELDS[family]) text(f.key, f.label);
  if (out.weight && !NUMBER.test(out.weight)) fail(`条目「${lineName}」克重须为数字（g/m²）`);
  if (out.width && !NUMBER.test(out.width)) fail(`条目「${lineName}」门幅须为数字（cm）`);
  const moq = QUOTE_MOQ_LABEL[family];
  text('moqQty', moq + ' 数量'); text('moqUnit', moq + ' 单位');
  if (out.moqQty) {
    if (!QTY.test(out.moqQty) || !/[1-9]/.test(out.moqQty)) fail(`条目「${lineName}」${moq}须为大于 0 的数字（最多四位小数）`);
    if (!out.moqUnit) fail(`条目「${lineName}」${moq}须选择单位（${units.join(' / ')}）`);
  }
  if (out.moqUnit) {
    if (!out.moqQty) fail(`条目「${lineName}」填写了${moq} 单位，请同时填写数量`);
    if (!units.includes(out.moqUnit)) fail(`条目「${lineName}」${moq} 单位只能是 ${units.join(' / ')}，不能用“${out.moqUnit}”`);
  }
  return out;
}

const known = (x: string | undefined) => x && x !== '待工厂分析' ? x.trim() : '';
/** 从产品档案或准确开发版本带入已有值；没有就留空。MOQ 来源中不存在，始终留空由人工填写。 */
export function quoteSpecDefaults(family: QuoteSpecFamily | undefined, source: {
  product?: { composition?: string; specs?: Record<string, string> };
  version?: { size?: string; fabric?: string; fabricRequirements?: FabricDevelopmentRequirements };
  devFabricRequirements?: FabricDevelopmentRequirements;
}): QuoteLineSpecs {
  if (!family) return {};
  const out: QuoteLineSpecs = {}, set = (key: keyof QuoteLineSpecs, v: string | undefined) => { const t = (v || '').trim(); if (t) out[key] = t; };
  if (source.product) {
    const s = source.product.specs || {};
    if (family === 'fabric') { set('composition', source.product.composition); set('weight', NUMBER.test(s.weight || '') ? s.weight : ''); set('width', NUMBER.test(s.width || '') ? s.width : ''); }
    else { set('sizeRange', s.sizeRange); set('mainFabric', s.mainFabric); }
    return out;
  }
  if (source.version) {
    if (family === 'fabric') {
      const fr = source.version.fabricRequirements || source.devFabricRequirements;
      if (fr) {
        set('composition', known(fr.composition).split('\n').map(x => x.trim()).filter(Boolean).join(' / '));
        set('weight', (!fr.weightUnit || fr.weightUnit === 'g/m²') && NUMBER.test(fr.weightValue) ? fr.weightValue : '');
        set('width', (!fr.widthUnit || fr.widthUnit === 'cm') && NUMBER.test(fr.widthValue) ? fr.widthValue : '');
      }
    } else { set('sizeRange', source.version.size); set('mainFabric', source.version.fabric); }
  }
  return out;
}

/** 规格只读展示：缺失字段显示“未填写”。 */
export function quoteSpecItems(family: QuoteSpecFamily | undefined, specs: QuoteLineSpecs | undefined): Array<{ label: string; value: string; missing: boolean }> {
  if (!family) return [];
  const s = specs || {};
  const items = QUOTE_SPEC_FIELDS[family].map(f => { const v = s[f.key]; return { label: f.label, value: v ? v + (f.unit ? ' ' + f.unit : '') : QUOTE_SPEC_MISSING, missing: !v }; });
  items.push({ label: QUOTE_MOQ_LABEL[family], value: s.moqQty ? `${s.moqQty} ${s.moqUnit || ''}`.trim() : QUOTE_SPEC_MISSING, missing: !s.moqQty });
  return items;
}
export function quoteSpecSummary(family: QuoteSpecFamily | undefined, specs: QuoteLineSpecs | undefined) { return quoteSpecItems(family, specs).map(i => `${i.label} ${i.value}`).join(' / '); }

function scaled(v: string): bigint | null { const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec((v || '').trim()); return m ? BigInt(m[1]) * BigInt(10000) + BigInt((m[2] || '').padEnd(4, '0') || '0') : null; }
export type QuoteMoqStatus = { state: 'none' | 'met' | 'below' | 'unitMismatch'; text: string };
/** MOQ 比较只在 MOQ 单位与计价单位相同时进行；不换算单位。 */
export function quoteMoqStatus(family: QuoteSpecFamily | undefined, line: { qty: string; unit: string; specs?: QuoteLineSpecs }): QuoteMoqStatus {
  const s = line.specs, label = family ? QUOTE_MOQ_LABEL[family] : 'MOQ';
  if (!family || !s?.moqQty || !s.moqUnit) return { state: 'none', text: '' };
  if (s.moqUnit !== line.unit) return { state: 'unitMismatch', text: `${label} 单位（${s.moqUnit}）与计价单位（${line.unit || '未选'}）不同，不换算，未比较` };
  const q = scaled(line.qty), moq = scaled(s.moqQty);
  if (q === null || moq === null) return { state: 'none', text: '' };
  return q < moq ? { state: 'below', text: `低于 MOQ：报价 ${line.qty} ${line.unit}，${label} ${s.moqQty} ${s.moqUnit}；仅提示，不触发审批` } : { state: 'met', text: '' };
}
