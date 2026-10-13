/** Validate every visible row: never silently discard an incomplete purchase line. */
export function validatePurchaseDraftLines(lines: Array<{description:string; quantity:string; unit:string; unitPrice:string}>): string | null {
  if (!lines.length) return '至少需要一行采购明细';
  for (const [index, line] of lines.entries()) {
    const prefix = `第 ${index + 1} 行：`;
    if (!line.description.trim()) return prefix + '请填写品名描述，或删除不需要的明细行';
    if (!line.unit.trim()) return prefix + '请选择单位';
    if (!line.quantity.trim() || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) return prefix + '数量必须为大于零的有效数字';
    if (!line.unitPrice.trim() || !Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0) return prefix + '请填写非负单价；免费项目需明确填写 0';
  }
  return null;
}
