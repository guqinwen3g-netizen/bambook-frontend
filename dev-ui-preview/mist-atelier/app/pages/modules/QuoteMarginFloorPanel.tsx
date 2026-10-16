/** BB-QUO-3 定价参数 · 报价底价线：按板块设置最低毛利率（带版本与生效日），仅管理层可改；报价保存时冻结适用版本。 */
import React from 'react';
import { Banner, Button, Card, CardHeader, DataTable, Field, FormGrid, Mono, Select, TextArea, TextInput, useToast, type Column } from '../../../../../components/mist';
import { marketBusinessDate, type MarketState } from '../../../../../server/src/shared/mistMarket';
import { MARGIN_FLOOR_FAMILY_LABEL, applicableMarginFloor, normalizeMarginPercent, type MarginFloorFamily, type QuoteMarginFloor } from '../../../../../server/src/shared/mistQuotationMarginFloor';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';

const FAMILIES: MarginFloorFamily[] = ['garment', 'fabric'];
export function marginFloorDraftProblem(input: { minMarginPercent: string; effectiveFrom: string; reason: string }, today: string) {
  if (normalizeMarginPercent(input.minMarginPercent) === null) return '最低毛利率须为 0–99.99 之间的数字，最多两位小数';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) return '请选择生效日';
  if (input.effectiveFrom < today) return '生效日不能早于今天；参数不追溯已保存报价';
  if (!input.reason.trim()) return '请填写调整原因';
  return '';
}
export function QuoteMarginFloorPanel() {
  const w = useMistWorkspace(), session = useMistSession(), toast = useToast();
  const floors: QuoteMarginFloor[] = ((w.state as (typeof w.state & { market?: MarketState }) | null)?.market?.marginFloors) || [];
  const today = marketBusinessDate(new Date());
  const canAdmin = session.hasPermission('pricing:admin');
  const [input, setInput] = React.useState({ family: 'garment' as MarginFloorFamily, minMarginPercent: '', effectiveFrom: today, reason: '' });
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const problem = marginFloorDraftProblem(input, today);
  const blocked = !canAdmin ? '仅管理层（定价管理权限）可修改最低毛利率' : busy || w.saving || !!w.pending ? '正在保存，请稍候' : problem;
  const save = async () => {
    if (blocked) return; setBusy(true); setError('');
    try { await w.run({ type: 'market.marginFloor.set', payload: { family: input.family, minMarginPercent: input.minMarginPercent.trim(), effectiveFrom: input.effectiveFrom, reason: input.reason.trim() } } as never); toast(`已设置${MARGIN_FLOOR_FAMILY_LABEL[input.family]}最低毛利率，新保存的报价按此判断`); setInput(v => ({ ...v, minMarginPercent: '', reason: '' })); }
    catch (e) { setError(e instanceof Error ? e.message : '未能保存最低毛利率'); }
    finally { setBusy(false); }
  };
  const cols: Column<QuoteMarginFloor>[] = [
    { key: 'family', header: '板块', width: '80px', render: r => MARGIN_FLOOR_FAMILY_LABEL[r.family] },
    { key: 'version', header: '版本', width: '64px', render: r => <Mono>V{r.version}</Mono> },
    { key: 'min', header: '最低毛利率', width: '100px', align: 'right', render: r => <span className="mist-num">{r.minMarginPercent}%</span> },
    { key: 'from', header: '生效日', width: '110px', render: r => r.effectiveFrom },
    { key: 'reason', header: '调整原因', hideOnMobile: true, render: r => r.reason },
    { key: 'by', header: '设置人 / 时间', hideOnMobile: true, render: r => `${r.createdBy || '—'} · ${r.createdAt.slice(0, 16).replace('T', ' ')}` },
  ];
  return <div className="mist-col" data-margin-floors>
    <Banner title="报价底价线">条目毛利率 =（单价 − 成本）/ 单价。低于所在板块的最低毛利率即“须审批”，与“低于成本 / 成本未核实”并存。报价保存时冻结当时适用的版本，之后修改参数不影响已保存报价。</Banner>
    <section className="mist-grid">{FAMILIES.map(f => { const cur = applicableMarginFloor(floors, f, today), next = floors.filter(x => x.family === f && x.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
      return <Card key={f} className="mist-col-6"><CardHeader title={`${MARGIN_FLOOR_FAMILY_LABEL[f]} · 当前适用`} sub={cur ? `V${cur.version}，${cur.effectiveFrom} 起生效` : '尚未设置：不按底价线判断'} /><div className="mist-card-body"><span className="mist-h2 mist-num" data-floor-current={f}>{cur ? cur.minMarginPercent + '%' : '未设置'}</span>{next && <p className="mist-sub">待生效：V{next.version} {next.minMarginPercent}%（{next.effectiveFrom} 起）</p>}</div></Card>; })}</section>
    <Card><CardHeader title="设置最低毛利率" sub="新增一个版本，不改写旧版本；改动留痕。" /><div className="mist-card-body mist-col">
      {!canAdmin && <Banner tone="warn" title="只读">仅管理层（定价管理权限）可修改最低毛利率；你可以查看当前参数与版本记录。</Banner>}
      {error && <Banner tone="bad" title="未能保存">{error}</Banner>}
      <FormGrid>
        <Field label="板块" required><Select aria-label="底价线板块" value={input.family} disabled={!canAdmin} options={FAMILIES.map(f => ({ value: f, label: MARGIN_FLOOR_FAMILY_LABEL[f] }))} onChange={e => setInput({ ...input, family: e.target.value as MarginFloorFamily })} /></Field>
        <Field label="最低毛利率（%）" required hint="0–99.99，最多两位小数"><TextInput aria-label="最低毛利率" inputMode="decimal" value={input.minMarginPercent} disabled={!canAdmin} onChange={e => setInput({ ...input, minMarginPercent: e.target.value })} /></Field>
        <Field label="生效日" required hint="不能早于今天，不追溯"><TextInput aria-label="底价线生效日" type="date" value={input.effectiveFrom} disabled={!canAdmin} onChange={e => setInput({ ...input, effectiveFrom: e.target.value })} /></Field>
        <Field label="调整原因" required full><TextArea aria-label="底价线调整原因" value={input.reason} disabled={!canAdmin} onChange={e => setInput({ ...input, reason: e.target.value })} /></Field>
      </FormGrid>
      <div className="mist-row"><span className="mist-note" data-floor-reason>{blocked || '保存后，新保存的报价按此版本判断'}</span><span className="mist-spacer" /><Button variant="primary" loading={busy} disabled={!!blocked} title={blocked || undefined} onClick={() => void save()}>保存新版本</Button></div>
    </div></Card>
    <Card><CardHeader title="版本记录" sub={`${floors.length} 个版本`} /><DataTable ariaLabel="最低毛利率版本记录" rowKey={r => r.id} rows={[...floors].sort((a, b) => a.family.localeCompare(b.family) || b.version - a.version)} columns={cols} empty="尚未设置最低毛利率" /></Card>
  </div>;
}
