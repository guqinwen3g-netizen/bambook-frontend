/** Authorized trimming field plan, ledger §19.9.1. Optional technical fields
 * never infer composition, dimensions, colors or supplier process settings. */
export const TRIMMING_CATEGORIES = [
  { value: 'lining', label: '里布 / 袋布' }, { value: 'interlining', label: '衬布 / 定型' }, { value: 'thread', label: '缝线' },
  { value: 'buttons', label: '纽扣 / 按扣' }, { value: 'zippers', label: '拉链' }, { value: 'tapes_cords', label: '带绳' },
  { value: 'hook_loop_bonding', label: '粘扣 / 粘合' }, { value: 'hardware', label: '五金 / 绳扣' },
  { value: 'padding', label: '垫肩 / 填充' }, { value: 'labels_decoration', label: '标识 / 装饰' },
  { value: 'tags_packaging', label: '吊牌 / 包装' }, { value: 'other', label: '其他' },
] as const;
export type TrimmingCategory = typeof TRIMMING_CATEGORIES[number]['value'];
export type TrimmingParameterDefinition = { key: string; label: string };
const parameter = (key: string, label: string): TrimmingParameterDefinition => ({ key, label });
export const TRIMMING_PARAMETER_FIELDS: Record<TrimmingCategory, readonly TrimmingParameterDefinition[]> = {
  lining: [parameter('composition', '成分'), parameter('weight', '克重及原单位'), parameter('width', '幅宽及原单位'), parameter('construction', '组织'), parameter('color', '颜色'), parameter('finish', '整理')],
  interlining: [parameter('material', '材质'), parameter('weight', '克重及原单位'), parameter('width', '幅宽及原单位'), parameter('bondingMethod', '粘合方式'), parameter('supplierTemperature', '供应方温度说明'), parameter('supplierPressure', '供应方压力说明'), parameter('supplierDuration', '供应方时间说明'), parameter('supplierInstructions', '供应方使用说明')],
  thread: [parameter('material', '材质'), parameter('countNotation', '规格标注体系'), parameter('countValue', '纱线规格'), parameter('plies', '股数'), parameter('colorCode', '色号'), parameter('packageLength', '包装长度及单位')],
  buttons: [parameter('material', '材质'), parameter('dimensions', '尺寸及单位'), parameter('holesOrFixing', '孔数 / 安装方式'), parameter('surfaceFinish', '表面处理'), parameter('completeComponents', '整套组件')],
  zippers: [parameter('teethType', '链牙类型'), parameter('teethSpecification', '链牙规格'), parameter('length', '长度及单位'), parameter('opening', '开合方式'), parameter('slider', '拉头'), parameter('puller', '拉片'), parameter('tapeColor', '布带颜色'), parameter('componentColors', '各组件颜色')],
  tapes_cords: [parameter('material', '材质'), parameter('widthOrDiameter', '宽度 / 直径及单位'), parameter('thickness', '厚度及单位'), parameter('color', '颜色'), parameter('elasticityRequirements', '适用弹性要求')],
  hook_loop_bonding: [parameter('type', '类型'), parameter('width', '宽度及单位'), parameter('pairedComponents', '配对组成'), parameter('color', '颜色'), parameter('supplierUseConditions', '供应方使用条件')],
  hardware: [parameter('material', '材质'), parameter('dimensions', '尺寸及单位'), parameter('installationPosition', '安装位置'), parameter('surfaceFinish', '表面处理'), parameter('color', '颜色'), parameter('components', '组件')],
  padding: [parameter('material', '材质'), parameter('shape', '形状'), parameter('lengthWidthThickness', '长 / 宽 / 厚及单位'), parameter('leftRightPairing', '左右配对'), parameter('applicableSizes', '适用尺寸')],
  labels_decoration: [parameter('material', '材质'), parameter('dimensions', '尺寸及单位'), parameter('artworkVersion', '图稿版本'), parameter('textOrGraphic', '文字 / 图案'), parameter('color', '颜色'), parameter('fixingMethod', '固定方式')],
  tags_packaging: [parameter('material', '材质'), parameter('dimensions', '尺寸及单位'), parameter('printArtwork', '印刷图稿'), parameter('packagingSpecification', '包装规格'), parameter('packagingRole', '包装用途')],
  other: [parameter('customName', '临时 / 自定义名称'), parameter('usageDescription', '用途描述'), parameter('dimensions', '尺寸及单位'), parameter('supplierInformation', '供应信息')],
};
export type TrimmingCategoryParameters = Record<string, string>;
export type TrimmingFileReference = { name: string; url: string };
export interface TrimmingExtendedFields {
  supplierArticleNo?: string | null; manufacturerRelationId?: string | null;
  images?: string[] | null; attachments?: TrimmingFileReference[] | null;
  quoteDate?: string | null; quoteConditions?: string | null; priceUnit?: string | null; moqUnit?: string | null;
  categoryParameters?: TrimmingCategoryParameters | null;
}
export function trimmingParameterFields(category: string): readonly TrimmingParameterDefinition[] {
  return TRIMMING_PARAMETER_FIELDS[category as TrimmingCategory] ?? [];
}
export function validateTrimmingCategoryParameters(category: string, value: unknown): { ok: true; value: TrimmingCategoryParameters } | { ok: false; message: string } {
  if (value == null) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: '辅料分类参数须为字段对象' };
  const allowed = new Set(trimmingParameterFields(category).map(field => field.key));
  const result: TrimmingCategoryParameters = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) return { ok: false, message: '辅料分类参数与所选类别不一致' };
    if (typeof item !== 'string' || item.length > 4000) return { ok: false, message: '辅料分类参数须为不超过 4000 字的文字' };
    if (item.trim()) result[key] = item.trim();
  }
  return { ok: true, value: result };
}
