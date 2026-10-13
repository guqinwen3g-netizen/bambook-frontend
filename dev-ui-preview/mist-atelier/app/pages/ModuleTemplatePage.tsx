/**
 * 未单独做参考页的模块：告诉接手的同学「这个模块用哪个模板、参考哪一页、要注意什么」。
 */
import { ArrowRight, LayoutTemplate } from 'lucide-react';
import { Banner, Button, Card, CardHeader, KeyValue, MistPage, Mono, PageHeader, Pill, Skeleton } from '../../../../components/mist';
import { MODULE_MAP, TEMPLATES } from '../moduleMap';
import { useNav } from '../nav';

export function ModuleTemplatePage() {
  const { route, go } = useNav();
  const m = MODULE_MAP.find(x => x.view === route.view);
  if (!m) return <MistPage><PageHeader title="页面不存在" description={`未找到视图「${route.view}」。`} actions={<Button variant="primary" onClick={() => go('cockpit')}>回到我的工作</Button>} /></MistPage>;
  const t = TEMPLATES[m.template];
  const d = m.detail ? TEMPLATES[m.detail] : undefined;
  return (
    <MistPage>
      <PageHeader eyebrow={`${m.group} · 迁移批次 Wave ${m.wave}`} title={m.label} description={`列表页使用「${t.name}」${d ? `，详情页使用「${d.name}」` : ''}${m.create ? '，新建使用「T9 新建 / 编辑」' : ''}。`}
        actions={t.page && <Button variant="primary" iconRight={ArrowRight} onClick={() => go(t.page!)}>查看 {t.name} 参考页</Button>} />
      <div className="mist-section"><Banner icon={LayoutTemplate} title="这一页在参考应用里没有单独画，因为它和模板结构完全一致">照抄模板页的结构与组件，只替换数据字段。{m.notes ? `注意：${m.notes}` : ''}</Banner></div>
      <section className="mist-grid">
        <Card className="mist-col-5"><CardHeader title="迁移信息" />
          <KeyValue items={[{ label: '源文件', value: <Mono>{m.entry}</Mono> }, { label: '代码规模', value: `${m.lines.toLocaleString()} 行` }, { label: '列表模板', value: t.name }, { label: '详情模板', value: d?.name ?? '—' }, { label: '新建', value: m.create ? 'T9 新建 / 编辑' : '—' }, { label: '批次', value: <Pill tone="accent">Wave {m.wave}</Pill> }]} /></Card>
        <Card className="mist-col-7"><CardHeader title="页面骨架" sub={t.when} />
          <div className="mist-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Skeleton width="40%" height={22} /><Skeleton width="65%" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginTop: 6 }}>{[0, 1, 2, 3].map(i => <Skeleton key={i} height={64} radius={16} />)}</div>
            {[0, 1, 2, 3].map(i => <Skeleton key={i} height={36} radius={10} />)}
          </div></Card>
      </section>
    </MistPage>
  );
}
