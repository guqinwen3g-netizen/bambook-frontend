/** Physical library taxonomy; descriptive metadata never implies business approval or receipt verification. */
export const SAMPLE_PURPOSES = [
  { value: 'development', label: '开发样' }, { value: 'production', label: '生产样' },
  { value: 'sales', label: '销售与展示样' }, { value: 'reference', label: '参考样' }, { value: 'other', label: '其他' },
] as const;
export const SAMPLE_KINDS = [
  { value: 'dev_lab_dip', label: '色样', purpose: 'development', lanes: ['fabric'] },
  { value: 'dev_handloom', label: '手织样', purpose: 'development', lanes: ['fabric'] },
  { value: 'dev_yardage', label: '米样', purpose: 'development', lanes: ['fabric'] },
  { value: 'dev_proto', label: '开发初样', purpose: 'development', lanes: ['garment'] },
  { value: 'dev_fit', label: '试身样', purpose: 'development', lanes: ['garment'] },
  { value: 'dev_photo', label: '拍摄样', purpose: 'development', lanes: ['garment'] },
  { value: 'dev_size_set', label: '尺码套样', purpose: 'development', lanes: ['garment'] },
  { value: 'dev_other', label: '其他开发样', purpose: 'development', lanes: ['fabric','garment','trim','other'] },
  { value: 'production_pioneer', label: '先锋样', purpose: 'production', lanes: ['fabric'] },
  { value: 'production_ship', label: '船样', purpose: 'production', lanes: ['fabric','garment'] },
  { value: 'production_head', label: '匹头样', purpose: 'production', lanes: ['fabric'] },
  { value: 'production_pp', label: '产前样', purpose: 'production', lanes: ['garment'] },
  { value: 'production_top', label: '大货样', purpose: 'production', lanes: ['garment'] },
  { value: 'production_other', label: '其他生产样', purpose: 'production', lanes: ['fabric','garment','trim','other'] },
  { value: 'sales_hanger', label: '挂钩样', purpose: 'sales', lanes: ['fabric'] },
  { value: 'sales_card', label: '样卡', purpose: 'sales', lanes: ['fabric','trim','other'] },
  { value: 'sales_stock_yardage', label: '库存米样', purpose: 'sales', lanes: ['fabric'] },
  { value: 'sales_book', label: '样册 / 样本', purpose: 'sales', lanes: ['fabric','garment','trim','other'] },
  { value: 'sales_collection', label: 'Collection 系列样', purpose: 'sales', lanes: ['fabric','garment','trim','other'] },
  { value: 'sales_garment', label: '销售展示衣', purpose: 'sales', lanes: ['garment'] },
  { value: 'sales_other', label: '其他销售样', purpose: 'sales', lanes: ['fabric','garment','trim','other'] },
  { value: 'reference', label: '参考样', purpose: 'reference', lanes: ['fabric','garment','trim','other'] },
  { value: 'other', label: '其他样品', purpose: 'other', lanes: ['fabric','garment','trim','other'] },
] as const;
export const SAMPLE_SOURCES = [
  { value: 'internal', label: '内部制作 / 留样' }, { value: 'customer_sample', label: '客户来样' },
  { value: 'supplier_recommend', label: '供应商 / 他人推荐' }, { value: 'purchased', label: '采购参考样' }, { value: 'other', label: '其他来源' },
] as const;
export type LibraryLane = 'fabric' | 'garment' | 'trim' | 'other';
export type SamplePurpose = typeof SAMPLE_PURPOSES[number]['value'];
export type SampleKind = typeof SAMPLE_KINDS[number]['value'];
export type SampleSource = typeof SAMPLE_SOURCES[number]['value'];
export interface SampleLibraryMetadata {
  version: 1; purpose: SamplePurpose; sampleKind: string; sourceType: SampleSource;
  category: string | null; colorFamily: string | null; colorName: string | null; colorCode: string | null;
  weightGsm: number | null; composition: string | null; construction: string | null;
  gender: string | null; styleCategory: string | null; size: string | null; season: string | null;
  collection: string | null; sourceName: string | null; tags: string[];
}
export const LIBRARY_TEXT_FIELDS = ['category','colorFamily','colorName','colorCode','composition','construction','gender','styleCategory','size','season','collection','sourceName'] as const;
export function libraryLane(cardType: string): LibraryLane {
  if (cardType === 'colorcard') return 'fabric';
  return ['fabric', 'garment', 'trim', 'other'].includes(cardType) ? cardType as LibraryLane : 'other';
}
export function sampleKindsFor(lane: LibraryLane, purpose?: string) { return SAMPLE_KINDS.filter(kind => (kind.lanes as readonly string[]).includes(lane) && (!purpose || kind.purpose === purpose)); }
export function normalizeLibraryMetadata(input: unknown, cardType: string): SampleLibraryMetadata | null {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw Error('样品分类信息不合法');
  const row = input as Record<string, unknown>;
  const allowed = ['version','purpose','sampleKind','sourceType','weightGsm','tags',...LIBRARY_TEXT_FIELDS];
  if (Object.keys(row).some(key => !allowed.includes(key)) || row.version !== 1) throw Error('样品分类版本不合法');
  const purpose = SAMPLE_PURPOSES.find(value => value.value === row.purpose);
  const source = SAMPLE_SOURCES.find(value => value.value === row.sourceType);
  const sampleKind = typeof row.sampleKind === 'string' ? row.sampleKind.trim() : '';
  if (!purpose || !source || !sampleKind || sampleKind.length > 80) throw Error('样品用途、种类与来源不合法；自定义种类须为 1 至 80 字');
  const kind = SAMPLE_KINDS.find(kind => kind.value === sampleKind);
  if (kind && (kind.purpose !== purpose.value || !(kind.lanes as readonly string[]).includes(libraryLane(cardType)))) throw Error('样品用途、种类与实物分类不匹配');
  const text: Record<string, string | null> = {};
  for (const key of LIBRARY_TEXT_FIELDS) { const value = row[key]; if (value != null && (typeof value !== 'string' || value.length > 200)) throw Error('样品属性请填写不超过 200 字的文本'); text[key] = typeof value === 'string' ? value.trim() || null : null; }
  if (row.weightGsm != null && (typeof row.weightGsm !== 'number' || !Number.isFinite(row.weightGsm) || row.weightGsm <= 0 || row.weightGsm > 3000)) throw Error('克重须为大于 0、不超过 3000 的数值');
  const tags = row.tags ?? []; if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 60)) throw Error('标签最多 20 个，每个不超过 60 字');
  return { version: 1, purpose: purpose.value, sampleKind, sourceType: source.value, ...text, weightGsm: row.weightGsm as number ?? null, tags: [...new Set(tags.map(tag => tag.trim()))] } as SampleLibraryMetadata;
}
export const LIBRARY_FILTER_KEYS = ['purpose','sampleKind','sourceType','category','colorFamily','gender','styleCategory','customerRelationId','warehouseId','status','sealedStatus','composition','construction','season','collection','tags'] as const;
export type LibraryFacetKey = typeof LIBRARY_FILTER_KEYS[number];
export type SampleLibraryFilters = Partial<Record<LibraryFacetKey, string[]>> & { weightMin?: number; weightMax?: number };
export type LibrarySort = 'newest' | 'oldest' | 'name' | 'code' | 'available_desc' | 'available_asc';
export type LibraryFacets = Partial<Record<LibraryFacetKey, Array<{ value: string; label: string; count: number }>>>;
export function normalizeLibraryFilters(input: unknown): SampleLibraryFilters {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw Error('样品筛选条件不合法');
  const output: SampleLibraryFilters = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'weightMin' || key === 'weightMax') { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 3000) throw Error('克重筛选不合法'); output[key] = value; continue; }
    if (!(LIBRARY_FILTER_KEYS as readonly string[]).includes(key) || !Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) throw Error('样品筛选条件不合法');
    if (value.length) output[key as LibraryFacetKey] = [...new Set(value)].sort();
  }
  if (output.weightMin !== undefined && output.weightMax !== undefined && output.weightMin > output.weightMax) throw Error('克重下限不能大于上限');
  return output;
}
