/** BB-ORD-3：条目规格明细编辑。成衣：颜色 × 尺码数量表；面料：颜色/色号、门幅、克重、成分 + 按颜色数量。
 * 合计仅作展示，提交后由服务端重新计算并校验。 */
import React from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Field, FormGrid, IconButton, TextInput } from '../../../../components/mist';
import { breakdownTotal, type FabricBreakdown, type GarmentBreakdown, type OrderLineBreakdown } from '../../../../server/src/shared/mistOrderBreakdown';
import { formatOrderQuantity } from './orderAmounts';

export function blankBreakdown(type: 'garment' | 'fabric'): OrderLineBreakdown {
  return type === 'garment' ? { kind: 'garment', sizes: ['S', 'M', 'L', 'XL'], rows: [{ color: '', quantities: [0, 0, 0, 0] }] } : { kind: 'fabric', composition: '', width: null, weight: null, rows: [{ color: '', quantity: 0 }] };
}
const num = (value: string) => value.trim() === '' ? 0 : Number(value);
const cellStyle: React.CSSProperties = { minWidth: 64 };

type Props = { type: 'garment' | 'fabric'; value?: OrderLineBreakdown; seed?: OrderLineBreakdown; unit: string; disabled?: boolean; label?: string; onChange: (value: OrderLineBreakdown | undefined) => void };
export function OrderBreakdownEditor({ type, value, seed, unit, disabled, label = '', onChange }: Props) {
  const prefix = label ? `${label} ` : '';
  if (!value) return <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }} data-breakdown-empty>
    <span className="mist-note">未分色分码：数量按整条填写。</span><span className="mist-spacer" />
    <Button size="sm" icon={Plus} disabled={disabled} onClick={() => onChange(structuredClone(seed || blankBreakdown(type)))}>{type === 'garment' ? '按颜色 × 尺码填写数量' : '填写面料规格与分色数量'}</Button>
  </div>;
  const total = breakdownTotal(value);
  const footer = <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><b className="mist-num" data-breakdown-total>合计 {formatOrderQuantity(total)} {unit}</b><span className="mist-note">条目数量 = 各格之和，以服务端核算为准</span><span className="mist-spacer" /><Button size="sm" variant="quiet" disabled={disabled} onClick={() => onChange(undefined)}>清除分色分码</Button></div>;
  if (value.kind === 'garment') {
    const set = (next: GarmentBreakdown) => onChange(next);
    return <div className="mist-col" style={{ gap: 8 }} data-breakdown="garment">
      <div style={{ overflowX: 'auto' }}><table className="mist-breakdown" aria-label={`${prefix}颜色 × 尺码数量`} style={{ borderCollapse: 'separate', borderSpacing: 6 }}>
        <thead><tr><th scope="col">颜色</th>{value.sizes.map((size, index) => <th key={index} scope="col" style={cellStyle}><div className="mist-row" style={{ gap: 2 }}><TextInput aria-label={`${prefix}尺码 ${index + 1}`} value={size} disabled={disabled} onChange={event => set({ ...value, sizes: value.sizes.map((item, i) => i === index ? event.target.value : item) })} />{value.sizes.length > 1 && <IconButton size="sm" icon={X} label={`${prefix}删除尺码 ${size || index + 1}`} disabled={disabled} onClick={() => set({ sizes: value.sizes.filter((_, i) => i !== index), kind: 'garment', rows: value.rows.map(row => ({ ...row, quantities: row.quantities.filter((_, i) => i !== index) })) })} />}</div></th>)}<th scope="col">小计</th><th /></tr></thead>
        <tbody>{value.rows.map((row, rowIndex) => <tr key={rowIndex}>
          <th scope="row"><TextInput aria-label={`${prefix}颜色 ${rowIndex + 1}`} value={row.color} placeholder="颜色" disabled={disabled} onChange={event => set({ ...value, rows: value.rows.map((item, i) => i === rowIndex ? { ...item, color: event.target.value } : item) })} /></th>
          {row.quantities.map((quantity, index) => <td key={index} style={cellStyle}><TextInput aria-label={`${prefix}${row.color || '颜色 ' + (rowIndex + 1)} · ${value.sizes[index] || '尺码 ' + (index + 1)} 数量`} type="number" min="0" step="1" value={quantity} disabled={disabled} onChange={event => set({ ...value, rows: value.rows.map((item, i) => i === rowIndex ? { ...item, quantities: item.quantities.map((q, j) => j === index ? num(event.target.value) : q) } : item) })} /></td>)}
          <td className="mist-num">{formatOrderQuantity(row.quantities.reduce((sum, q) => sum + (Number.isFinite(q) ? q : 0), 0))}</td>
          <td>{value.rows.length > 1 && <IconButton size="sm" icon={X} label={`${prefix}删除颜色 ${row.color || rowIndex + 1}`} disabled={disabled} onClick={() => set({ ...value, rows: value.rows.filter((_, i) => i !== rowIndex) })} />}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="mist-row" style={{ gap: 8 }}><Button size="sm" icon={Plus} disabled={disabled} onClick={() => set({ ...value, rows: [...value.rows, { color: '', quantities: value.sizes.map(() => 0) }] })}>添加颜色</Button><Button size="sm" icon={Plus} disabled={disabled} onClick={() => set({ ...value, sizes: [...value.sizes, ''], rows: value.rows.map(row => ({ ...row, quantities: [...row.quantities, 0] })) })}>添加尺码</Button></div>
      {footer}
    </div>;
  }
  const set = (next: FabricBreakdown) => onChange(next);
  const measure = (text: string) => text.trim() === '' ? null : Number(text);
  return <div className="mist-col" style={{ gap: 8 }} data-breakdown="fabric">
    <FormGrid>
      <Field label="门幅（cm）"><TextInput aria-label={`${prefix}门幅（cm）`} type="number" min="0" step="any" value={value.width ?? ''} disabled={disabled} onChange={event => set({ ...value, width: measure(event.target.value) })} /></Field>
      <Field label="克重（g/m²）"><TextInput aria-label={`${prefix}克重（g/m²）`} type="number" min="0" step="any" value={value.weight ?? ''} disabled={disabled} onChange={event => set({ ...value, weight: measure(event.target.value) })} /></Field>
      <Field label="成分" full><TextInput aria-label={`${prefix}成分`} value={value.composition} disabled={disabled} onChange={event => set({ ...value, composition: event.target.value })} /></Field>
    </FormGrid>
    <div className="mist-col" style={{ gap: 6 }} role="group" aria-label={`${prefix}分色数量`}>
      {value.rows.map((row, rowIndex) => <div key={rowIndex} className="mist-row" style={{ gap: 6 }}>
        <TextInput aria-label={`${prefix}颜色 / 色号 ${rowIndex + 1}`} value={row.color} placeholder="颜色 / 色号" disabled={disabled} onChange={event => set({ ...value, rows: value.rows.map((item, i) => i === rowIndex ? { ...item, color: event.target.value } : item) })} />
        <TextInput aria-label={`${prefix}${row.color || '颜色 ' + (rowIndex + 1)} 数量`} type="number" min="0" step="any" value={row.quantity} suffix={unit} disabled={disabled} onChange={event => set({ ...value, rows: value.rows.map((item, i) => i === rowIndex ? { ...item, quantity: num(event.target.value) } : item) })} />
        {value.rows.length > 1 && <IconButton size="sm" icon={X} label={`${prefix}删除颜色 ${row.color || rowIndex + 1}`} disabled={disabled} onClick={() => set({ ...value, rows: value.rows.filter((_, i) => i !== rowIndex) })} />}
      </div>)}
    </div>
    <div className="mist-row"><Button size="sm" icon={Plus} disabled={disabled} onClick={() => set({ ...value, rows: [...value.rows, { color: '', quantity: 0 }] })}>添加颜色</Button></div>
    {footer}
  </div>;
}
