/** Actual observations, per piece. Values retain supplied precision and units. */
export interface DevelopmentQcMeasurement { piece: string; size?: string | null; position: string; value: string; unit: string }
export function normalizeDevelopmentQcMeasurements(value: unknown): DevelopmentQcMeasurement[] {
  if (!Array.isArray(value) || value.length > 1000) throw Error('实测表须为不超过 1000 行的逐件记录');
  const text = (value: unknown, label: string, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw Error(`${label}须明确填写`);
    return value.trim();
  };
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['piece', 'size', 'position', 'value', 'unit'].includes(key))) throw Error('实测行字段须为件标识、尺码、部位、数值及单位');
    const numeric = text(row.value, '实测数值', 100);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric) || !Number.isFinite(Number(numeric))) throw Error('实测数值须为有限数值文本');
    return { piece: text(row.piece, '件标识', 120), size: row.size == null || row.size === '' ? null : text(row.size, '样衣尺码', 80), position: text(row.position, '测量部位', 200), value: numeric, unit: text(row.unit, '原测量单位', 40) };
  });
}
