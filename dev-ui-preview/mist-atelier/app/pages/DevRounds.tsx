/** BB-DEV-2：开发轮次（共同要求、参考版本、参与工厂、目标日期）与固定工厂字母；BB-DEV-3：分步开新一轮、逐厂任务与共同要求同步。 */
import React from 'react';
import { FileText, Layers, Pencil, Plus, RefreshCw } from 'lucide-react';
import { Banner, Button, Card, CardHeader, Checkbox, Dialog, Field, FormGrid, Mono, Pill, Stepper, TextArea, TextInput, UploadZone } from '../../../../components/mist';
import type { MistDev, MistRound, MistState, MistVersion } from '../../../../server/src/shared/mistWorkspace';
import { caseFactoryLetters, defaultFactoryTask, developmentClosure, developmentRoundBlocker, duplicateRoundFactories, developmentRoundViews, factoryLetterAt, factoryTaskError, factoryTaskSync, factoryTaskSyncBlocker, nextRoundNumber, roundVersionLabel, type FactoryTaskInput } from '../../../../server/src/shared/mistDevelopmentRounds';
import { developmentDomain } from '../../../../server/src/shared/mistDevelopmentDomain';

export type NewRoundInput = { factories: string[]; requirements: string; fileIds: string[]; referenceVersionIds: string[]; targetDate: string; resampleFromVersionId?: string; factoryTasks?: FactoryTaskInput[] };
export const NEW_ROUND_STEPS = ['参考版本', '参与工厂', '共同要求', '逐厂要求'] as const;

/** 版本 QC 标记：有保留通过显示“需关注”，不通过及其处理结果分别标出。 */
export function versionQcFlag(version: Pick<MistVersion, 'qc' | 'qcDecision' | 'qcHistory'>): { tone: 'warn' | 'bad' | 'neutral'; label: string } | null {
  if (version.qcDecision?.kind === 'abandon') return { tone: 'bad', label: '不采用' };
  if (version.qcDecision?.kind === 'resample') return { tone: 'neutral', label: '已重新打样' };
  if (version.qc?.result === 'reject') return { tone: 'bad', label: 'QC 不通过' };
  if (version.qc?.result === 'conditional') return { tone: 'warn', label: '需关注' };
  if (!version.qc && version.qcHistory?.length) return { tone: 'warn', label: '整改待复检' };
  return null;
}
type FactoryOption = { name: string; historical: boolean; unavailable: boolean };

/** 预览：本轮将生成的版本号（已参与工厂沿用原字母，新工厂取下一个未用字母）。 */
export function previewRoundLabels(state: MistState, dev: MistDev, factories: string[]): string[] {
  const letters = caseFactoryLetters(state, dev), used = new Set(Object.values(letters)), round = nextRoundNumber(state, dev);
  return factories.map(factory => {
    if (!letters[factory]) { let index = 0; while (used.has(factoryLetterAt(index))) index++; letters[factory] = factoryLetterAt(index); used.add(letters[factory]); }
    return roundVersionLabel(round, letters[factory]);
  });
}
/** 分步校验：返回第 step 步（0 起）之前及本步的第一个问题；不传 step 时校验全部。 */
export function newRoundError(input: NewRoundInput, dev?: MistDev, step = NEW_ROUND_STEPS.length - 1): string | null {
  if (step >= 1) {
    if (!input.factories.length) return '请至少选择一家参与工厂';
    const duplicated = duplicateRoundFactories(input.factories);
    if (duplicated.length) return `同一轮内工厂不能重复：${duplicated.join('、')}`;
  }
  if (step >= 2) {
    if (!input.requirements.trim()) return '请填写本轮共同要求';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) return '请填写本轮目标日期';
  }
  if (step >= 3 && dev) for (const task of input.factoryTasks || []) { const error = factoryTaskError(dev, task); if (error) return error; }
  return null;
}
/** 本轮各工厂任务：已填写的沿用，未填写的按开发案计划样品与本轮目标日期。 */
export function roundTasks(dev: MistDev, form: Pick<NewRoundInput, 'factories' | 'targetDate'>, edited: Record<string, FactoryTaskInput>): FactoryTaskInput[] {
  return form.factories.map(factory => edited[factory] || defaultFactoryTask(dev, factory, form.targetDate));
}
const taskSummary = (task: NonNullable<MistVersion['task']>) => `${task.sampleForm} ${task.sampleQuantity} ${task.sampleUnit} · 要求 ${task.dueDate}`;

export function DevRoundsCard({ state, dev, versionId, busy, onSelect, onCreate, onEditRequirements, onSync }: { state: MistState; dev: MistDev; versionId?: string; busy: boolean; onSelect: (id: string) => void; onCreate: () => void; onEditRequirements?: (round: MistRound) => void; onSync?: (version: MistVersion) => void }) {
  const closure = developmentClosure(state, dev), editBlocker = closure ? `开发案${closure.label}，不能再改共同要求` : null;
  const views = developmentRoundViews(state, dev), letters = caseFactoryLetters(state, dev);
  const label = (id: string) => state.versions.find(version => version.id === id)?.label || '已不可见版本';
  return <Card id="mist-dev-rounds">
    <CardHeader title="开发轮次" sub={Object.keys(letters).length ? `工厂字母固定：${Object.entries(letters).map(([factory, letter]) => `${letter} ${factory}`).join(' · ')}` : '尚无参与工厂'} tools={(blocker => <><Button size="sm" icon={Plus} disabled={busy || !!blocker} title={blocker || undefined} onClick={onCreate}>开新一轮</Button>{blocker && <span className="mist-note">{blocker}</span>}</>)(developmentRoundBlocker(state, dev))} />
    {views.length ? views.map(view => <div key={view.number} className="mist-section" style={{ padding: '10px 22px' }} data-round={view.number}>
      <div className="mist-row"><Pill tone={view.round ? 'accent' : 'neutral'}>{view.number ? `R${view.number}` : '未编号'}</Pill>
        <span className="mist-muted" style={{ fontSize: 12.5 }}>{view.round ? `目标 ${view.round.targetDate}${view.round.referenceVersionIds.length ? ` · 参考 ${view.round.referenceVersionIds.map(label).join('、')}` : ''}${view.round.fileIds.length ? ` · 附件 ${view.round.fileIds.length}` : ''}` : '历史记录 · 按原版本号只读展示'}</span></div>
      {view.round && <p className="mist-sub" style={{ fontSize: 13, margin: '6px 0', whiteSpace: 'pre-wrap' }}>{view.round.requirements}</p>}
      {view.round && onEditRequirements && <div className="mist-row" style={{ margin: '0 0 6px' }}><Button size="sm" variant="quiet" icon={Pencil} disabled={busy || !!editBlocker} title={editBlocker || undefined} onClick={() => onEditRequirements(view.round!)}>修改共同要求</Button>{editBlocker && <span className="mist-note">{editBlocker}</span>}</div>}
      <div className="mist-vers" role="group" aria-label={`第 ${view.number} 轮版本`}>{view.versions.map(version => <button key={version.id} type="button" aria-pressed={versionId === version.id} disabled={busy} onClick={() => onSelect(version.id)}><Mono>{version.label}</Mono> · {version.factory}{(flag => flag && <> <Pill tone={flag.tone}>{flag.label}</Pill></>)(versionQcFlag(version))}</button>)}</div>
      {view.round && <ul className="mist-list" aria-label={`第 ${view.number} 轮工厂任务`} style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>{view.versions.map(version => {
        const sync = factoryTaskSync(state, version), blocker = sync && !sync.inSync ? factoryTaskSyncBlocker(state, dev, version) : null;
        return <li key={version.id} data-task={version.label} className="mist-row" style={{ fontSize: 12.5, padding: '3px 0', flexWrap: 'wrap', gap: 6 }}>
          <Mono>{version.label}</Mono><span className="mist-muted">{version.task ? taskSummary(version.task) : '历史任务'}</span>
          {version.task?.extraRequirements && <span>差异：{version.task.extraRequirements}</span>}
          {sync && !sync.inSync && <><Pill tone="warn">与共同要求不一致，可同步</Pill>
            {onSync && <Button size="sm" icon={RefreshCw} disabled={busy || !!blocker} title={blocker || undefined} onClick={() => onSync(version)}>同步 {version.label}</Button>}
            {blocker && <span className="mist-note">{blocker}</span>}</>}
        </li>;
      })}</ul>}
    </div>) : <p className="mist-note" style={{ padding: '10px 22px 18px' }}>尚未开始打样轮次。</p>}
  </Card>;
}

export function NewRoundDialog({ open, state, dev, busy, failure, factoryOptions, initial, onClose, onAddFactory, onSubmit, onUpload }: {
  open: boolean; initial?: Partial<NewRoundInput>; state: MistState; dev: MistDev; busy: boolean; failure: string; factoryOptions: FactoryOption[];
  onClose: () => void; onAddFactory: () => void; onSubmit: (input: NewRoundInput) => void; onUpload: (files: File[]) => Promise<string[]>;
}) {
  const versions = dev.versionIds.map(id => state.versions.find(version => version.id === id)).filter(version => !!version);
  const fabric = developmentDomain(dev.values) === 'fabric';
  const [form, setForm] = React.useState<NewRoundInput>({ factories: [], requirements: '', fileIds: [], referenceVersionIds: [], targetDate: dev.due || '' });
  const [edited, setEdited] = React.useState<Record<string, FactoryTaskInput>>({});
  const [step, setStep] = React.useState(0);
  React.useEffect(() => { if (open) { setForm({ factories: [], requirements: '', fileIds: [], referenceVersionIds: [], targetDate: dev.due || '', ...initial }); setEdited({}); setStep(initial?.resampleFromVersionId ? 2 : 0); } }, [open, dev.id]);
  const source = form.resampleFromVersionId ? state.versions.find(version => version.id === form.resampleFromVersionId) : undefined;
  const toggle = (key: 'factories' | 'referenceVersionIds', value: string, checked: boolean) => setForm(previous => ({ ...previous, [key]: checked ? [...previous[key], value] : previous[key].filter(item => item !== value) }));
  const tasks = roundTasks(dev, form, edited), input: NewRoundInput = { ...form, factoryTasks: tasks };
  const setTask = (task: FactoryTaskInput, patch: Partial<FactoryTaskInput>) => setEdited(previous => ({ ...previous, [task.factory]: { ...task, ...patch } }));
  const blocker = developmentRoundBlocker(state, dev), preview = previewRoundLabels(state, dev, form.factories);
  const stepError = (index: number) => blocker || newRoundError(input, dev, index), error = stepError(step), last = step === NEW_ROUND_STEPS.length - 1;
  const reachable = (index: number) => index <= step || NEW_ROUND_STEPS.slice(0, index).every((_, previous) => !stepError(previous));
  return <Dialog open={open} onClose={() => !busy && onClose()} width={760} icon={Layers} title={`开启第 ${nextRoundNumber(state, dev)} 轮`} description="每家参与工厂在本轮形成一个版本；之前各轮记录保持不变。" footer={<>
    <Button variant="quiet" disabled={busy} onClick={onClose}>取消</Button>
    {step > 0 && <Button disabled={busy} onClick={() => setStep(step - 1)}>上一步</Button>}
    {last ? <Button variant="primary" loading={busy} disabled={!!error} onClick={() => onSubmit(input)}>{error ? error : `建立 ${preview.join('、')}`}</Button>
      : <Button variant="primary" disabled={busy || !!error} onClick={() => setStep(step + 1)}>{error ? error : `下一步：${NEW_ROUND_STEPS[step + 1]}`}</Button>}</>}>
    <Stepper ariaLabel="开新一轮步骤" steps={NEW_ROUND_STEPS.map((label, index) => ({ label, state: index < step ? 'done' : index === step ? 'now' : 'todo', caption: index === 1 && form.factories.length ? `${form.factories.length} 家` : undefined }))} onSelect={index => { if (!busy && reachable(index)) setStep(index); }} />
    {failure && <Banner tone="bad" title="本轮尚未建立">{failure}</Banner>}
    {source && <Banner tone="warn" title={`重新打样 · 来源 ${source.label} QC 不通过`}>QC 意见已带入本轮共同要求，可修改；建立后 {source.label} 标记为已重新打样。</Banner>}
    {step === 0 && <FormGrid>
      <div className="mist-field" data-full="true" role="group" aria-label="参考版本"><span className="mist-field-label">参考版本（可多选）</span>
        {versions.map(version => <Checkbox key={version!.id} checked={form.referenceVersionIds.includes(version!.id)} label={`${version!.label} · ${version!.factory}`} onChange={checked => toggle('referenceVersionIds', version!.id, checked)} />)}
        {!versions.length && <p className="mist-note">本案尚无可参考版本。</p>}</div>
    </FormGrid>}
    {step === 1 && <FormGrid>
      <div className="mist-field" data-full="true" role="group" aria-label="参与工厂"><span className="mist-field-label">参与工厂（可留用、可新增）</span>
        {factoryOptions.map(factory => { const letter = caseFactoryLetters(state, dev)[factory.name]; return <Checkbox key={factory.name} checked={form.factories.includes(factory.name)} disabled={factory.unavailable && !form.factories.includes(factory.name)} label={`${factory.name}${letter ? ` · 字母 ${letter}` : ' · 首次参与'}${factory.unavailable ? ' · 已停用' : ''}`} onChange={checked => toggle('factories', factory.name, checked)} />; })}
        {!factoryOptions.length && <p className="mist-note">尚无实际工厂，请先添加。</p>}<Button onClick={onAddFactory}>新增工厂</Button></div>
      <Field label="将建立的版本"><p className="mist-note">{preview.length ? preview.join('、') : '选择工厂后显示'}</p></Field>
    </FormGrid>}
    {step === 2 && <FormGrid>
      <Field label="本轮共同要求" required full hint="建轮时复制进各工厂任务；之后修改共同要求不会自动覆盖，需逐厂同步"><TextArea value={form.requirements} onChange={event => setForm(previous => ({ ...previous, requirements: event.target.value }))} /></Field>
      <Field label="本轮目标日期" required hint="各工厂要求日期默认取此日期"><TextInput type="date" value={form.targetDate} onChange={event => setForm(previous => ({ ...previous, targetDate: event.target.value }))} /></Field>
      <div className="mist-field" data-full="true" role="group" aria-label="共同要求附件"><span className="mist-field-label">共同要求附件</span>
        {form.fileIds.map(id => <div key={id} className="mist-row"><FileText className="mist-icon" /><span>{state.files.find(file => file.id === id)?.name || id}</span><span className="mist-spacer" /><Button size="sm" variant="quiet" disabled={busy} onClick={() => setForm(previous => ({ ...previous, fileIds: previous.fileIds.filter(item => item !== id) }))}>移除</Button></div>)}
        <UploadZone hint="可附参考图、工艺单等" onFiles={files => { if (!busy) void onUpload(files).then(ids => setForm(previous => ({ ...previous, fileIds: [...new Set([...previous.fileIds, ...ids])] }))); }} /></div>
    </FormGrid>}
    {step === 3 && <>
      <p className="mist-note" style={{ whiteSpace: 'pre-wrap' }}>共同要求：{form.requirements}</p>
      {tasks.map((task, index) => <section key={task.factory} role="group" aria-label={`${task.factory} 逐厂要求`} className="mist-section" style={{ padding: '10px 0' }}>
        <div className="mist-row"><Mono>{preview[index]}</Mono><b>{task.factory}</b></div>
        <FormGrid>
          <Field label="差异要求" full hint="只写本厂与共同要求不同的部分，可留空"><TextArea value={task.extraRequirements} onChange={event => setTask(task, { extraRequirements: event.target.value })} /></Field>
          <Field label="样品形态" required hint={fabric ? '米样按米，剪片类按份' : undefined}><TextInput value={task.sampleForm} onChange={event => setTask(task, { sampleForm: event.target.value })} /></Field>
          <Field label="数量" required><TextInput type="number" min={0} step={fabric ? 0.1 : 1} value={String(task.sampleQuantity)} onChange={event => setTask(task, { sampleQuantity: event.target.value === '' ? 0 : Number(event.target.value) })} /></Field>
          <Field label="单位" required><TextInput value={task.sampleUnit} onChange={event => setTask(task, { sampleUnit: event.target.value })} /></Field>
          <Field label="要求日期" required><TextInput type="date" value={task.dueDate} onChange={event => setTask(task, { dueDate: event.target.value })} /></Field>
        </FormGrid>
      </section>)}
    </>}
  </Dialog>;
}

/** 修改本轮共同要求：只改轮次，不覆盖已有工厂任务；保存后各厂显示“与共同要求不一致，可同步”。 */
export function RoundRequirementsDialog({ round, busy, failure, onClose, onSubmit }: { round: MistRound | null; busy: boolean; failure: string; onClose: () => void; onSubmit: (requirements: string) => void }) {
  const [value, setValue] = React.useState('');
  React.useEffect(() => { if (round) setValue(round.requirements); }, [round?.id]);
  const unchanged = !!round && value.trim() === round.requirements, error = !value.trim() ? '请填写本轮共同要求' : unchanged ? '共同要求没有变化' : null;
  return <Dialog open={!!round} onClose={() => !busy && onClose()} icon={Pencil} title={`修改第 ${round?.number || ''} 轮共同要求`} description="不会自动覆盖已有工厂任务；保存后需在各工厂任务上逐厂同步。" footer={<>
    <Button variant="quiet" disabled={busy} onClick={onClose}>取消</Button>
    <Button variant="primary" loading={busy} disabled={!!error} onClick={() => onSubmit(value.trim())}>{error || '保存共同要求'}</Button></>}>
    {failure && <Banner tone="bad" title="尚未保存">{failure}</Banner>}
    <Field label="本轮共同要求" required full><TextArea value={value} onChange={event => setValue(event.target.value)} /></Field>
  </Dialog>;
}
