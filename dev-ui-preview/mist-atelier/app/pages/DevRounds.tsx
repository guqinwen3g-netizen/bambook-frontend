/** BB-DEV-2：开发轮次（共同要求、参考版本、参与工厂、目标日期）与固定工厂字母。 */
import React from 'react';
import { FileText, Layers, Plus } from 'lucide-react';
import { Banner, Button, Card, CardHeader, Checkbox, Dialog, Field, FormGrid, Mono, Pill, TextArea, TextInput, UploadZone } from '../../../../components/mist';
import type { MistDev, MistState } from '../../../../server/src/shared/mistWorkspace';
import { caseFactoryLetters, developmentRoundViews, factoryLetterAt, nextRoundNumber, roundVersionLabel } from '../../../../server/src/shared/mistDevelopmentRounds';

export type NewRoundInput = { factories: string[]; requirements: string; fileIds: string[]; referenceVersionIds: string[]; targetDate: string };
type FactoryOption = { name: string; historical: boolean; unavailable: boolean };

/** 预览：本轮将生成的版本号（已参与工厂沿用原字母，新工厂取下一个未用字母）。 */
export function previewRoundLabels(state: MistState, dev: MistDev, factories: string[]): string[] {
  const letters = caseFactoryLetters(state, dev), used = new Set(Object.values(letters)), round = nextRoundNumber(state, dev);
  return factories.map(factory => {
    if (!letters[factory]) { let index = 0; while (used.has(factoryLetterAt(index))) index++; letters[factory] = factoryLetterAt(index); used.add(letters[factory]); }
    return roundVersionLabel(round, letters[factory]);
  });
}
export function newRoundError(input: NewRoundInput): string | null {
  if (!input.factories.length) return '请至少选择一家参与工厂';
  if (!input.requirements.trim()) return '请填写本轮共同要求';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) return '请填写本轮目标日期';
  return null;
}

export function DevRoundsCard({ state, dev, versionId, busy, onSelect, onCreate }: { state: MistState; dev: MistDev; versionId?: string; busy: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const views = developmentRoundViews(state, dev), letters = caseFactoryLetters(state, dev);
  const label = (id: string) => state.versions.find(version => version.id === id)?.label || '已不可见版本';
  return <Card id="mist-dev-rounds">
    <CardHeader title="开发轮次" sub={Object.keys(letters).length ? `工厂字母固定：${Object.entries(letters).map(([factory, letter]) => `${letter} ${factory}`).join(' · ')}` : '尚无参与工厂'} tools={<Button size="sm" icon={Plus} disabled={busy} onClick={onCreate}>开新一轮</Button>} />
    {views.length ? views.map(view => <div key={view.number} className="mist-section" style={{ padding: '10px 22px' }} data-round={view.number}>
      <div className="mist-row"><Pill tone={view.round ? 'accent' : 'neutral'}>{view.number ? `R${view.number}` : '未编号'}</Pill>
        <span className="mist-muted" style={{ fontSize: 12.5 }}>{view.round ? `目标 ${view.round.targetDate}${view.round.referenceVersionIds.length ? ` · 参考 ${view.round.referenceVersionIds.map(label).join('、')}` : ''}${view.round.fileIds.length ? ` · 附件 ${view.round.fileIds.length}` : ''}` : '历史记录 · 按原版本号只读展示'}</span></div>
      {view.round && <p className="mist-sub" style={{ fontSize: 13, margin: '6px 0' }}>{view.round.requirements}</p>}
      <div className="mist-vers" role="group" aria-label={`第 ${view.number} 轮版本`}>{view.versions.map(version => <button key={version.id} type="button" aria-pressed={versionId === version.id} disabled={busy} onClick={() => onSelect(version.id)}><Mono>{version.label}</Mono> · {version.factory}</button>)}</div>
    </div>) : <p className="mist-note" style={{ padding: '10px 22px 18px' }}>尚未开始打样轮次。</p>}
  </Card>;
}

export function NewRoundDialog({ open, state, dev, busy, failure, factoryOptions, onClose, onAddFactory, onSubmit, onUpload }: {
  open: boolean; state: MistState; dev: MistDev; busy: boolean; failure: string; factoryOptions: FactoryOption[];
  onClose: () => void; onAddFactory: () => void; onSubmit: (input: NewRoundInput) => void; onUpload: (files: File[]) => Promise<string[]>;
}) {
  const versions = dev.versionIds.map(id => state.versions.find(version => version.id === id)).filter(version => !!version);
  const [form, setForm] = React.useState<NewRoundInput>({ factories: [], requirements: '', fileIds: [], referenceVersionIds: [], targetDate: dev.due || '' });
  React.useEffect(() => { if (open) setForm({ factories: [], requirements: '', fileIds: [], referenceVersionIds: [], targetDate: dev.due || '' }); }, [open, dev.id]);
  const toggle = (key: 'factories' | 'referenceVersionIds', value: string, checked: boolean) => setForm(previous => ({ ...previous, [key]: checked ? [...previous[key], value] : previous[key].filter(item => item !== value) }));
  const error = newRoundError(form), preview = previewRoundLabels(state, dev, form.factories);
  return <Dialog open={open} onClose={() => !busy && onClose()} width={720} icon={Layers} title={`开启第 ${nextRoundNumber(state, dev)} 轮`} description="每家参与工厂在本轮形成一个版本；之前各轮记录保持不变。" footer={<>
    <Button variant="quiet" disabled={busy} onClick={onClose}>取消</Button>
    <Button variant="primary" loading={busy} disabled={!!error} onClick={() => onSubmit(form)}>{error ? error : `建立 ${preview.join('、')}`}</Button></>}>
    {failure && <Banner tone="bad" title="本轮尚未建立">{failure}</Banner>}
    <FormGrid>
      <div className="mist-field" data-full="true" role="group" aria-label="参考版本"><span className="mist-field-label">参考版本</span>
        {versions.map(version => <Checkbox key={version!.id} checked={form.referenceVersionIds.includes(version!.id)} label={`${version!.label} · ${version!.factory}`} onChange={checked => toggle('referenceVersionIds', version!.id, checked)} />)}
        {!versions.length && <p className="mist-note">本案尚无可参考版本。</p>}</div>
      <div className="mist-field" data-full="true" role="group" aria-label="参与工厂"><span className="mist-field-label">参与工厂</span>
        {factoryOptions.map(factory => { const letter = caseFactoryLetters(state, dev)[factory.name]; return <Checkbox key={factory.name} checked={form.factories.includes(factory.name)} disabled={factory.unavailable && !form.factories.includes(factory.name)} label={`${factory.name}${letter ? ` · 字母 ${letter}` : ' · 首次参与'}${factory.unavailable ? ' · 已停用' : ''}`} onChange={checked => toggle('factories', factory.name, checked)} />; })}
        {!factoryOptions.length && <p className="mist-note">尚无实际工厂，请先添加。</p>}<Button onClick={onAddFactory}>新增工厂</Button></div>
      <Field label="本轮共同要求" required full hint="发给本轮所有工厂的共同修改要求"><TextArea value={form.requirements} onChange={event => setForm(previous => ({ ...previous, requirements: event.target.value }))} /></Field>
      <Field label="本轮目标日期" required><TextInput type="date" value={form.targetDate} onChange={event => setForm(previous => ({ ...previous, targetDate: event.target.value }))} /></Field>
      <Field label="将建立的版本"><p className="mist-note">{preview.length ? preview.join('、') : '选择工厂后显示'}</p></Field>
      <div className="mist-field" data-full="true" role="group" aria-label="共同要求附件"><span className="mist-field-label">共同要求附件</span>
        {form.fileIds.map(id => <div key={id} className="mist-row"><FileText className="mist-icon" /><span>{state.files.find(file => file.id === id)?.name || id}</span><span className="mist-spacer" /><Button size="sm" variant="quiet" disabled={busy} onClick={() => setForm(previous => ({ ...previous, fileIds: previous.fileIds.filter(item => item !== id) }))}>移除</Button></div>)}
        <UploadZone hint="可附参考图、工艺单等" onFiles={files => { if (!busy) void onUpload(files).then(ids => setForm(previous => ({ ...previous, fileIds: [...new Set([...previous.fileIds, ...ids])] }))); }} /></div>
    </FormGrid>
  </Dialog>;
}
