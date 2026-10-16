/** 统一搜索结果页：与 ⌘K 共用记录源，只搜当前工作空间，且只列当前账号能进入的页面中的记录。 */
import React from 'react';
import { Search } from 'lucide-react';
import { Banner, Button, Card, EmptyState, MistPage, PageHeader, Tabs, TextInput, Toolbar } from '../../../../components/mist';
import { useNav } from '../nav';
import { useMistSession } from '../runtime/auth';
import { useMistWorkspace } from '../runtime/workspace';
import { rankSearchRecords, workspaceSearchRecords, type MistSearchHit } from '../runtime/search';
import type { View } from '../../../../types';

const PREVIEW = 8;
export function SearchPage() {
  const { route, go } = useNav(), session = useMistSession(), workspace = useMistWorkspace();
  const query = route.section ?? '';
  const [draft, setDraft] = React.useState(query), [group, setGroup] = React.useState('all'), [expanded, setExpanded] = React.useState<string | null>(null);
  React.useEffect(() => { setDraft(query); setGroup('all'); setExpanded(null); }, [query]);
  const state = workspace.state;
  const hits = React.useMemo(() => state ? rankSearchRecords(workspaceSearchRecords(state, view => session.canAccessView(view as View)), query) : [], [state, query, session]);
  const groups = [...new Set(hits.map(h => h.group))];
  const shown = group === 'all' ? groups : groups.filter(g => g === group);
  const submit = (e?: React.FormEvent) => { e?.preventDefault(); go('search', undefined, { section: draft.trim() || undefined }); };
  const open = (hit: MistSearchHit) => go(hit.view, hit.id, hit.target);
  return <MistPage>
    <PageHeader title="搜索结果" description={workspace.workspace ? `在「${workspace.workspace.name}」中搜索；只列出你有权进入的页面中的记录。` : '只搜索当前工作空间。'} />
    <form onSubmit={submit}><Toolbar right={<Button type="submit" variant="primary" icon={Search}>搜索</Button>}>
      <TextInput aria-label="搜索关键词" icon={Search} placeholder="名称、编号、客户、供应商… 多个词用空格分开" value={draft} onChange={e => setDraft(e.target.value)} />
    </Toolbar></form>
    {!state ? <Banner tone="neutral" title="还没有打开工作空间">进入一个工作空间后再搜索。</Banner>
      : !query.trim() ? <EmptyState icon={Search} title="输入关键词开始搜索" description="也可以随时按 ⌘K 快速搜索。" />
      : !hits.length ? <EmptyState icon={Search} title={`没有找到「${query}」`} description="换个关键词或编号；看不到的页面中的记录不会出现在这里。" />
      : <>
        <Tabs value={group} onChange={setGroup} options={[{ value: 'all', label: '全部', count: hits.length }, ...groups.map(g => ({ value: g, label: g, count: hits.filter(h => h.group === g).length }))]} />
        {shown.map(g => {
          const rows = hits.filter(h => h.group === g), full = group !== 'all' || expanded === g, visible = full ? rows : rows.slice(0, PREVIEW);
          return <section key={g} className="mist-section"><Card>
            <div className="mist-card-h"><b>{g}</b><span className="mist-note">{rows.length} 条</span></div>
            <div role="list" aria-label={g}>{visible.map(hit => <button key={hit.view + hit.id} type="button" role="listitem" className="mist-palette-it" style={{ width: '100%' }} onClick={() => open(hit)}>
              <span>{hit.label}</span>{hit.hint && <small>{hit.hint}</small>}
            </button>)}</div>
            {!full && rows.length > PREVIEW && <div className="mist-card-body"><Button variant="quiet" size="sm" onClick={() => setExpanded(g)}>显示全部 {rows.length} 条</Button></div>}
          </Card></section>;
        })}
      </>}
  </MistPage>;
}
