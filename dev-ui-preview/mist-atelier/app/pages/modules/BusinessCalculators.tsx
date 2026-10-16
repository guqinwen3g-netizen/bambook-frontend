/** 业务工具 · 本地换算：装箱体积与面料克重。只做计算，不写入任何业务记录。 */
import React from 'react';
import { Card, CardHeader, Field, FormGrid, SummaryBar, TextInput } from '../../../../../components/mist';

const fmt = (n: number, digits: number) => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
const num = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
/** 1 oz = 28.349523125 g；1 yd² = 0.83612736 m²。 */
export const GSM_PER_OZ_YD2 = 28.349523125 / 0.83612736;
export function cartonVolume(l: number, w: number, h: number, cartons: number, grossKg: number | null) {
  const cbm = l * w * h / 1_000_000;
  return { cartonCbm: cbm, totalCbm: cbm * cartons, totalGross: grossKg === null ? null : grossKg * cartons, airChargeableKg: l * w * h / 6000 * cartons };
}

export function BusinessCalculators() {
  const [box, setBox] = React.useState({ l: '', w: '', h: '', cartons: '1', gross: '' });
  const [gsm, setGsm] = React.useState(''), [oz, setOz] = React.useState('');
  const l = num(box.l), w = num(box.w), h = num(box.h), cartons = num(box.cartons), gross = box.gross.trim() ? num(box.gross) : null;
  const ready = l !== null && w !== null && h !== null && cartons !== null && Number.isInteger(cartons) && (box.gross.trim() === '' || gross !== null);
  const v = ready ? cartonVolume(l!, w!, h!, cartons!, gross) : null;
  const g = num(gsm), o = num(oz);
  const set = (key: keyof typeof box) => (e: React.ChangeEvent<HTMLInputElement>) => setBox({ ...box, [key]: e.target.value });
  return <>
    <Card className="mist-col-6"><CardHeader title="装箱体积" sub="外箱尺寸按厘米；结果仅供订舱和报价参考。" /><div className="mist-card-body">
      <FormGrid cols={3}>
        <Field label="外箱长 cm"><TextInput type="number" min={0} value={box.l} onChange={set('l')} /></Field>
        <Field label="外箱宽 cm"><TextInput type="number" min={0} value={box.w} onChange={set('w')} /></Field>
        <Field label="外箱高 cm"><TextInput type="number" min={0} value={box.h} onChange={set('h')} /></Field>
        <Field label="箱数"><TextInput type="number" min={0} step={1} value={box.cartons} onChange={set('cartons')} /></Field>
        <Field label="单箱毛重 kg" hint="可不填"><TextInput type="number" min={0} value={box.gross} onChange={set('gross')} /></Field>
      </FormGrid>
      <SummaryBar items={v ? [{ label: '单箱体积', value: fmt(v.cartonCbm, 4) + ' m³' }, { label: '总体积', value: fmt(v.totalCbm, 3) + ' m³' }, { label: '总毛重', value: v.totalGross === null ? '—' : fmt(v.totalGross, 2) + ' kg' }, { label: '空运体积重（÷6000）', value: fmt(v.airChargeableKg, 2) + ' kg' }] : [{ label: '结果', value: '填写长宽高与整数箱数' }]} />
    </div></Card>
    <Card className="mist-col-6"><CardHeader title="面料克重换算" sub="g/m² 与 oz/yd² 互换（1 oz/yd² ≈ 33.906 g/m²）。" /><div className="mist-card-body">
      <FormGrid>
        <Field label="克重 g/m²"><TextInput type="number" min={0} value={gsm} onChange={e => { setGsm(e.target.value); const n = num(e.target.value); setOz(n === null ? '' : String(Math.round(n / GSM_PER_OZ_YD2 * 100) / 100)); }} /></Field>
        <Field label="克重 oz/yd²"><TextInput type="number" min={0} value={oz} onChange={e => { setOz(e.target.value); const n = num(e.target.value); setGsm(n === null ? '' : String(Math.round(n * GSM_PER_OZ_YD2 * 10) / 10)); }} /></Field>
      </FormGrid>
      <SummaryBar items={[{ label: '换算结果', value: g !== null && o !== null ? `${fmt(g, 1)} g/m² ≈ ${fmt(o, 2)} oz/yd²` : '输入任一克重' }]} />
    </div></Card>
  </>;
}
