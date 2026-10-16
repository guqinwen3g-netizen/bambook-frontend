/**
 * BB-DEV-11：开发详情的轮次时间线状态与多版本对比。
 * 只读派生：状态全部来自准确版本已记录的返样、QC、QC 处理与需求方确认，不推断流程；
 * 对比只接受同一开发案的版本，缺失信息如实标出，不用开发案目标或其他版本补位。
 */
import type { MistConfirmation, MistDev, MistQc, MistState, MistVersion } from './mistWorkspace';
import { developmentDomain } from './mistDevelopmentDomain';
import { developmentRoundViews, minorParent } from './mistDevelopmentRounds';

export type TimelineTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad';
export type VersionTimelineStatus = {
  key: 'awaiting_return' | 'qc_pending' | 'rework_pending' | 'qc_reject' | 'resampled' | 'abandoned' | 'awaiting_confirmation' | 'approved' | 'needs_adjustment' | 'rejected';
  label: string; tone: TimelineTone; flags: Array<{ label: string; tone: TimelineTone }>;
};

export const QC_RESULT_LABEL: Record<MistQc['result'], string> = { pass: '通过', conditional: '有保留通过', reject: '不通过' };
export const CONFIRMATION_RESULT_LABEL: Record<MistConfirmation['result'], string> = { approved: '认可', needs_adjustment: '需修改', rejected: '不采用' };

/** 版本卡片状态：主状态 + 附加标记（有保留通过始终标“需关注”，并保留小版本 / 留档事实）。 */
export function versionTimelineStatus(version: MistVersion): VersionTimelineStatus {
  const flags: VersionTimelineStatus['flags'] = [];
  if (version.qc?.result === 'conditional') flags.push({ label: '需关注', tone: 'warn' });
  if (version.minor) flags.push({ label: '小版本', tone: 'neutral' });
  if (version.archivedAt) flags.push({ label: '已留档', tone: 'ok' });
  const latest = version.confirmations.at(-1);
  const status = (key: VersionTimelineStatus['key'], label: string, tone: TimelineTone): VersionTimelineStatus => ({ key, label, tone, flags });
  if (version.qcDecision?.kind === 'abandon') return status('abandoned', '不采用', 'bad');
  if (latest?.result === 'approved') return status('approved', '认可', 'ok');
  if (latest?.result === 'rejected') return status('rejected', '不采用', 'bad');
  if (latest?.result === 'needs_adjustment') return status('needs_adjustment', '需修改', 'warn');
  if (version.qcDecision?.kind === 'resample') return status('resampled', '已重新打样', 'neutral');
  if (version.qc?.result === 'reject') return status('qc_reject', 'QC 不通过', 'bad');
  if (!version.returnedAt) return status('awaiting_return', '待返样', 'neutral');
  if (!version.qc) return version.qcHistory?.length ? status('rework_pending', '整改待复检', 'warn') : status('qc_pending', 'QC 中', 'accent');
  return status('awaiting_confirmation', '待确认', 'accent');
}

/** 版本所在轮次与工厂（时间线与对比共用的来源说明）。 */
export function versionSource(state: MistState, dev: MistDev, version: MistVersion): { round: number; roundLabel: string; factory: string; label: string; parentLabel?: string } {
  const view = developmentRoundViews(state, dev).find(item => item.versions.some(row => row.id === version.id));
  const round = view?.number ?? 0;
  return { round, roundLabel: round ? `第 ${round} 轮` : '未编号轮次', factory: version.factory || '待安排工厂', label: version.label, ...(version.minor ? { parentLabel: minorParent(state, version)?.label } : {}) };
}

export type ComparisonGroup = '来源' | '实物' | 'QC' | '客户意见' | '关键规格';
export type ComparisonRow = { key: string; group: ComparisonGroup; label: string; values: string[] };
export type DevelopmentComparison = { versions: MistVersion[]; rows: ComparisonRow[]; rejected: string[] };

export const COMPARISON_MISSING = '未记录';
const time = (value: string | null | undefined) => value ? value.slice(0, 16).replace('T', ' ') : '';
const unitValue = (value: string | undefined, unit: string | undefined) => value?.trim() ? `${value.trim()} ${unit || ''}`.trim() : '';

/** 同案多版本对比。只取属于本开发案的版本；其他开发案或不存在的 id 记入 rejected，不参与对比。 */
export function developmentVersionComparison(state: MistState, dev: MistDev, versionIds: string[]): DevelopmentComparison {
  const versions: MistVersion[] = [], rejected: string[] = [];
  for (const id of [...new Set(versionIds)]) {
    const version = state.versions.find(row => row.id === id);
    if (version && version.devId === dev.id && dev.versionIds.includes(id)) versions.push(version); else rejected.push(id);
  }
  const fabric = developmentDomain(dev.values) === 'fabric';
  const file = (id: string) => state.files.find(item => item.id === id)?.name || id;
  const row = (key: string, group: ComparisonGroup, label: string, value: (version: MistVersion) => string): ComparisonRow =>
    ({ key, group, label, values: versions.map(version => value(version) || COMPARISON_MISSING) });
  const source = (version: MistVersion) => versionSource(state, dev, version);
  const latest = (version: MistVersion) => version.confirmations.at(-1);
  // 版本未单独保存目标规格（历史版本）时沿用本开发案目标，并标明来源；不读其他版本。
  const spec = (version: MistVersion) => version.fabricRequirements || dev.values.fabricRequirements;
  const specNote = (version: MistVersion, value: string) => value && !version.fabricRequirements ? `${value}（开发案目标）` : value;
  const rows: ComparisonRow[] = [
    row('round', '来源', '轮次', version => source(version).roundLabel),
    row('factory', '来源', '工厂', version => source(version).factory),
    row('label', '来源', '版本', version => version.label + (version.minor ? `（小版本，沿用 ${source(version).parentLabel || '大版本'} 实物与 QC）` : '')),
    row('status', '来源', '当前状态', version => { const status = versionTimelineStatus(version); return [status.label, ...status.flags.map(flag => flag.label)].join(' · '); }),
    row('sample', '实物', '返样', version => version.returnedAt ? `${version.sample || '未登记编号'} · ${version.sampleQuantity} ${fabric ? version.sampleUnit || '单位未登记' : '件'} · ${time(version.returnedAt)}` : '未返样'),
    row('qcResult', 'QC', 'QC 结论', version => version.qc ? QC_RESULT_LABEL[version.qc.result] : !version.returnedAt ? '未返样，无 QC' : version.qcHistory?.length ? '整改待复检' : 'QC 待评审'),
    row('qcReview', 'QC', '评审人 / 时间', version => version.qc ? `${version.qc.reviewer} · ${time(version.qc.reviewedAt)}` : ''),
    row('qcReport', 'QC', '报告', version => version.qc?.report ? file(version.qc.report) : ''),
    row('qcOpinion', 'QC', 'QC 意见', version => version.qc?.opinion || ''),
    fabric
      ? row('qcFacts', 'QC', '面料实测', version => (version.qc?.fabricMeasurements || []).map(item => `${item.property} ${item.actual} ${item.unit}`).join('；'))
      : row('qcFacts', 'QC', '尺寸测量', version => {
        const rows = version.qc?.measurements || []; if (!rows.length) return '';
        const out = rows.filter(item => Math.abs(item.actual - item.standard) > item.tolerance);
        return `${rows.length} 个测量点 · 超出公差 ${out.length}${out.length ? `（${out.map(item => item.point).join('、')}）` : ''}`;
      }),
    row('qcHistory', 'QC', '历次 QC', version => version.qcHistory?.length ? `${version.qcHistory.length} 次，旧报告保留` : '无'),
    row('confirmResult', '客户意见', '最新确认', version => { const item = latest(version); return item ? `${CONFIRMATION_RESULT_LABEL[item.result]} · ${item.confirmer}${item.organization ? `（${item.organization}）` : ''} · ${time(item.confirmedAt)}` : '尚无确认'; }),
    row('confirmText', '客户意见', '需求方原文', version => latest(version)?.originalText || ''),
    row('confirmBasis', '客户意见', '确认依据', version => latest(version)?.basis || ''),
    row('confirmCount', '客户意见', '确认记录', version => `${version.confirmations.length} 条`),
    ...(fabric ? [
      row('form', '关键规格', '实物形态 / 颜色', version => version.returnedAt ? [version.sampleForm, version.sampleColor].filter(Boolean).join(' / ') : ''),
      row('composition', '关键规格', '目标成分（非实测）', version => specNote(version, spec(version)?.composition || '')),
      row('weight', '关键规格', '目标克重（非实测）', version => specNote(version, unitValue(spec(version)?.weightValue, spec(version)?.weightUnit))),
      row('width', '关键规格', '目标幅宽（非实测）', version => specNote(version, unitValue(spec(version)?.widthValue, spec(version)?.widthUnit))),
      row('yarn', '关键规格', '纱支 / 组织', version => specNote(version, spec(version) ? [spec(version)!.yarn, spec(version)!.weave].map(item => item || COMPARISON_MISSING).join(' / ') : '')),
      row('finish', '关键规格', '后整理', version => specNote(version, spec(version)?.finish || '')),
    ] : [
      row('size', '关键规格', '打样尺码', version => version.size),
      row('fabric', '关键规格', '面料', version => version.fabric),
    ]),
    row('task', '关键规格', '本厂要求', version => version.minor ? `小调整：${version.minor.change}` : version.task ? `${version.task.commonRequirements}${version.task.extraRequirements ? `；本厂差异：${version.task.extraRequirements}` : ''}` : version.note),
  ];
  return { versions, rows, rejected };
}