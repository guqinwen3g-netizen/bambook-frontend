/** Quantities with different units never form one physical total. */
export function receiptTotalsByUnit(
  lines: Array<{id:string;unit?:string|null}>,
  drafts: Record<string,{accepted:string;rejected:string}>,
) {
  const groups = new Map<string,{unit:string;accepted:number;rejected:number}>();
  for (const line of lines) {
    const unit = line.unit?.trim() || '未注明单位';
    const group = groups.get(unit) || {unit,accepted:0,rejected:0};
    const draft = drafts[line.id];
    for (const key of ['accepted','rejected'] as const) {
      const value = Number(draft?.[key] || 0);
      if (Number.isFinite(value) && value >= 0) group[key] = Math.round((group[key] + value) * 10000) / 10000;
    }
    groups.set(unit, group);
  }
  return [...groups.values()];
}
