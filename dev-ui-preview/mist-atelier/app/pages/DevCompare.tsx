/** BB-DEV-11：同一开发案多版本并排对比（QC、需求方意见、关键规格），每列标明版本 / 轮次 / 工厂来源；缺失如实显示。 */
import React from 'react';
import { ArrowRight, X } from 'lucide-react';
import { Banner, Button, Card, CardHeader, Mono, TextLink } from '../../../../components/mist';
import type { MistDev, MistState } from '../../../../server/src/shared/mistWorkspace';
import { COMPARISON_MISSING, developmentVersionComparison, versionSource } from '../../../../server/src/shared/mistDevelopmentCompare';

/** 对比选择按开发案分开保存，切换开发案或刷新后不串案。 */
export const compareStorageKey = (devId: string) => `mist.dev.compare.${devId}`;
export function readCompareIds(dev: MistDev): string[] {
  try { const saved = JSON.parse(sessionStorage.getItem(compareStorageKey(dev.id)) || '[]'); return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && dev.versionIds.includes(id)) : []; }
  catch { return []; }
}
export function writeCompareIds(devId: string, ids: string[]) { try { if (ids.length) sessionStorage.setItem(compareStorageKey(devId), JSON.stringify(ids)); else sessionStorage.removeItem(compareStorageKey(devId)); } catch { /* 存储不可用时只保留页面内选择 */ } }

export function DevCompareCard({ state, dev, versionIds, currentId, onOpen, onClose }: { state: MistState; dev: MistDev; versionIds: string[]; currentId?: string; onOpen: (id: string) => void; onClose: () => void }) {
  const comparison = developmentVersionComparison(state, dev, versionIds);
  let group = '';
  return <Card id="mist-dev-compare" clip>
    <CardHeader title="版本对比" sub={`${dev.code} · 仅本开发案版本 · 规格为开发目标，QC 实测以报告为准`} tools={<Button size="sm" variant="quiet" icon={X} onClick={onClose}>收起对比</Button>} />
    {!!comparison.rejected.length && <div className="mist-section"><Banner tone="warn" title="部分版本未加入对比">{comparison.rejected.length} 个所选版本不属于本开发案或已不可见，未显示。</Banner></div>}
    {comparison.versions.length < 2 ? <p className="mist-note" style={{ padding: '10px 22px 18px' }}>至少选择本开发案的 2 个版本才能并排对比。</p>
      : <div className="mist-cmp" style={{ '--mist-cmp-n': comparison.versions.length } as React.CSSProperties}><table aria-label={`${dev.code} 版本对比`}>
        <thead><tr><th scope="col">对比项</th>{comparison.versions.map(version => { const source = versionSource(state, dev, version); return <th key={version.id} scope="col" data-version={version.label} aria-current={version.id === currentId || undefined}>
          <Mono>{version.label}</Mono> · {source.factory}<span className="mist-cmp-src">{source.roundLabel}{version.id === currentId ? ' · 当前查看' : ''}</span>
          <TextLink iconRight={ArrowRight} onClick={() => onOpen(version.id)}>打开详情</TextLink></th>; })}</tr></thead>
        <tbody>{comparison.rows.flatMap(row => {
          const out: React.ReactNode[] = [];
          if (row.group !== group) { group = row.group; out.push(<tr key={`g-${row.group}`} data-group={row.group}><th scope="row" colSpan={comparison.versions.length + 1}>{row.group}</th></tr>); }
          out.push(<tr key={row.key} data-row={row.key}><th scope="row">{row.label}</th>{row.values.map((value, index) => <td key={comparison.versions[index].id} data-missing={value === COMPARISON_MISSING || undefined}>{value}</td>)}</tr>);
          return out;
        })}</tbody>
      </table></div>}
  </Card>;
}
