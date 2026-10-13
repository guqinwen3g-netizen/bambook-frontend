/**
 * 设计系统总览（活文档）：原则 / 色彩 / 字体 / 尺寸 / 组件 / 全站映射。
 * 所有色值在运行时从 CSS 变量读取，切换深浅色可直接对照两套值。
 */
import React from 'react';
import { ArrowRight, Check, Layers, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import {
  AIBadge, Avatar, AvatarStack, Banner, Button, Card, CardHeader, Checkbox, Chip, ChoiceCards, DataTable, Field, FormGrid, IconButton, Kbd, Meter, MistPage, Mono,
  PageHeader, Pill, SearchField, Segmented, Select, StageProgress, Switch, Tabs, TextArea, TextInput, Tile, useToast,
} from '../../../../components/mist';
import { MODULE_MAP, TEMPLATES } from '../moduleMap';
import { useNav } from '../nav';

const GROUPS: Array<[string, Array<[string, string]>]> = [
  ['品牌原色', [['--mist-brand-mist-1', '雾蓝 1'], ['--mist-brand-mist-2', '雾蓝 2'], ['--mist-brand-mist-3', '雾蓝 3'], ['--mist-brand-deep-1', '深夜 1'], ['--mist-brand-deep-3', '深夜 3'], ['--mist-brand-cyan', '品牌青'], ['--mist-brand-wisteria', '紫藤原色']]],
  ['表面', [['--mist-canvas', '画布'], ['--mist-card', '卡片'], ['--mist-card-2', '卡片悬停'], ['--mist-sunken', '下沉'], ['--mist-fill', '控件填充'], ['--mist-fill-2', '控件悬停'], ['--mist-frost', '磨砂'], ['--mist-frost-2', '磨砂选中']]],
  ['文字', [['--mist-ink', '主文字'], ['--mist-ink-2', '次要'], ['--mist-ink-3', '辅助'], ['--mist-ink-4', '禁用/轨道']]],
  ['强调', [['--mist-accent', '强调'], ['--mist-accent-hover', '强调悬停'], ['--mist-accent-ink', '强调文字'], ['--mist-accent-tint', '强调浅底'], ['--mist-accent-tint-2', '选中底']]],
  ['语义', [['--mist-ok', '成功'], ['--mist-ok-tint', '成功浅底'], ['--mist-warn', '提醒'], ['--mist-warn-tint', '提醒浅底'], ['--mist-bad', '风险'], ['--mist-bad-tint', '风险浅底'], ['--mist-ai', 'AI'], ['--mist-ai-tint', 'AI 浅底']]],
];
const RULES = [
  ['零描边，零投影', '静态面（卡片、输入框、按钮、选中项）不画边框也不加阴影。唯一的阴影属于浮层：命令面板、抽屉、弹窗、菜单。'],
  ['层级只靠填充深浅', '画布 → 卡片 → 填充 → 填充悬停 → 强调浅底。选中 = 填充加深；聚焦 = 强调色浅底。'],
  ['一屏一个主按钮', 'primary 只给「这一页最该做的事」。其他用 secondary（浅填充）或 quiet（文字）。'],
  ['颜色只表达状态', '绿/黄/红/蓝/竹青只用于小面积：状态标签、圆点、进度、Banner。大面积永远是中性色。'],
  ['竹青与淡玉 = AI', '小竹使用竹青与淡玉：AI 简报、AI 建议、问小竹按钮。AI 不再使用紫色，成功状态仍用独立的绿色。'],
  ['数字要轻、要对齐', '大数字用 light 300；金额/数量用 tabular-nums 右对齐；编号用 JetBrains Mono。'],
];

function Swatch({ v, name }: { v: string; name: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [val, setVal] = React.useState('');
  const { theme } = useNav();
  React.useEffect(() => { if (ref.current) setVal(getComputedStyle(ref.current).getPropertyValue(v).trim()); }, [v, theme]);
  return <div className="mist-swatch" ref={ref}><div style={{ background: `var(${v})` }} /><p><b>{name}</b><Mono>{v}</Mono><br /><span className="mist-muted">{val}</span></p></div>;
}

export function DesignSystemPage() {
  const { go } = useNav();
  const toast = useToast();
  const [tab, setTab] = React.useState('rules');
  const [seg, setSeg] = React.useState('a');
  const [ck, setCk] = React.useState(true);
  const [sw, setSw] = React.useState(true);
  const [ch, setCh] = React.useState<'ok' | 'mod' | 'no'>('ok');
  const [q, setQ] = React.useState('');
  return (
    <MistPage>
      <PageHeader eyebrow="交付 · Mist Atelier v1.0" title="设计系统" description="Bambook 竹衍 · Flat Frost。代码：styles/mist + components/mist；文档：docs/mist-atelier。"
        actions={<Button variant="primary" iconRight={ArrowRight} onClick={() => setTab('map')}>全站模块映射</Button>} />
      <Tabs value={tab} onChange={setTab} options={[{ value: 'rules', label: '原则' }, { value: 'color', label: '色彩' }, { value: 'type', label: '字体' }, { value: 'size', label: '尺寸与圆角' }, { value: 'comp', label: '组件' }, { value: 'map', label: '全站映射', count: MODULE_MAP.length }]} />
      {tab === 'rules' && <section className="mist-grid">{RULES.map(([t, d], i) => <Card key={t} className="mist-col-4"><div className="mist-card-body" style={{ paddingTop: 22 }}><span className="mist-eyebrow">0{i + 1}</span><div className="mist-h2" style={{ margin: '8px 0 6px' }}>{t}</div><p className="mist-sub" style={{ fontSize: 13.5 }}>{d}</p></div></Card>)}
        <Card className="mist-col-12"><CardHeader title="对照：同一个选中项" sub="左：不要（描边 + 阴影）。右：要（填充加深）。" />
          <div className="mist-card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            <div className="mist-demo-box" style={{ background: 'var(--mist-shell)' }}><div style={{ padding: '10px 14px', borderRadius: 12, color: '#fff', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.5), 0 6px 16px rgba(0,0,0,.18)', background: 'rgba(255,255,255,.2)' }}>✕ 开发与寻样</div></div> {/* mist-allow: 反例演示 */}
            <div className="mist-demo-box" style={{ background: 'var(--mist-shell)' }}><div style={{ padding: '10px 14px', borderRadius: 12, color: '#fff', background: 'var(--mist-frost-2)', backdropFilter: 'blur(12px)' }}>✓ 开发与寻样</div></div> {/* mist-allow: 反例演示 */}
          </div></Card></section>}
      {tab === 'color' && GROUPS.map(([g, list]) => <section key={g} className="mist-section"><div className="mist-h3" style={{ margin: '6px 0 12px' }}>{g}</div><div className="mist-spec">{list.map(([v, n]) => <Swatch key={v} v={v} name={n} />)}</div></section>)}
      {tab === 'type' && <Card><div className="mist-card-body" style={{ paddingTop: 22, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {[['--mist-text-5xl 40 / regular', <div className="mist-h1" style={{ fontSize: 40 }}>下午好，顾言</div>], ['--mist-text-4xl 34 / regular · h1', <div className="mist-h1">开发与寻样</div>], ['--mist-text-stat 38 / light · 统计数字', <div className="mist-stat-v">48,260<small>USD</small></div>], ['--mist-text-xl 17 / medium · h2', <div className="mist-h2">接着完成</div>], ['--mist-text-lg 14.5 / medium · 行标题', <div className="mist-obj-name">双面羊毛城市大衣</div>], ['--mist-text-base 14 · 正文', <p className="mist-sub">从需求到留档，每一版都可追溯到工厂、实物与报告。</p>], ['--mist-text-xs 12 · 辅助', <span className="mist-muted" style={{ fontSize: 12 }}>2 个本周到期</span>], ['--mist-font-mono · 编号', <Mono>DEV-G-2026-031 · CC-AW27-COAT-014</Mono>], ['--mist-eyebrow 12 / caps', <span className="mist-eyebrow">订单履约 · 开发</span>]].map(([l, el], i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '260px 1fr', alignItems: 'center', gap: 20 }}><Mono>{l as string}</Mono>{el}</div>)}
      </div></Card>}
      {tab === 'size' && <section className="mist-grid">
        <Card className="mist-col-6"><CardHeader title="圆角（同心：内 = 外 − 内边距）" /><div className="mist-card-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {[['xs', 7], ['sm', 9], ['md', 12], ['lg', 16], ['card', 22], ['hero', 26], ['canvas', 30]].map(([n, v]) => <div key={n} style={{ textAlign: 'center' }}><div style={{ width: 64, height: 64, borderRadius: `var(--mist-r-${n})`, background: 'var(--mist-accent-tint-2)' }} /><Mono>{n} {v}</Mono></div>)}</div></Card>
        <Card className="mist-col-6"><CardHeader title="间距（4 基）" /><div className="mist-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4, 5, 6, 8, 10, 12].map(n => <div key={n} className="mist-row"><Mono>space-{n}</Mono><span style={{ width: `var(--mist-space-${n})`, height: 10, borderRadius: 3, background: 'var(--mist-accent)' }} /><span className="mist-muted" style={{ fontSize: 12 }}>{n * 4}px</span></div>)}
          <p className="mist-muted" style={{ fontSize: 12, marginTop: 6 }}>卡片间距 --mist-gap 18 · 卡片内边距 22 × 20 · 控件高 40 / 32 / 44</p></div></Card></section>}
      {tab === 'comp' && <section className="mist-grid">
        <Card className="mist-col-6"><CardHeader title="Button" sub="primary 一屏一个" /><div className="mist-card-body"><div className="mist-row" style={{ flexWrap: 'wrap' }}>
          <Button variant="primary" icon={Plus}>主要</Button><Button>次要</Button><Button variant="quiet">文字</Button><Button variant="danger" icon={Trash2}>删除</Button><Button variant="ai" icon={Sparkles}>AI</Button><Button variant="primary" loading>保存中</Button><Button size="sm">小</Button><IconButton icon={Search} label="搜索" dot /></div></div></Card>
        <Card className="mist-col-6"><CardHeader title="Pill / Chip / Tile" sub="Pill 只读状态，Chip 可点筛选" /><div className="mist-card-body"><div className="mist-row" style={{ flexWrap: 'wrap' }}>
          <Pill>开发计划</Pill><Pill tone="accent">待确认</Pill><Pill tone="ok">QC 通过</Pill><Pill tone="warn">待评审</Pill><Pill tone="bad">需复验</Pill><Pill tone="ai">AI 建议</Pill><Pill plain>R2-A-2</Pill>
          <Chip label="负责人" value="全部" /><Chip label="仅看我的" pressed /><Tile icon={Layers} /><Tile icon={Check} tone="ok" /><AIBadge icon={Sparkles} /><Kbd>⌘K</Kbd></div></div></Card>
        <Card className="mist-col-6"><CardHeader title="表单" sub="填充底，聚焦变强调浅底，错误变红浅底" /><div className="mist-card-body"><FormGrid>
          <Field label="名称" required><TextInput placeholder="输入…" /></Field><Field label="错误态" error="请填写客户款号"><TextInput defaultValue="" /></Field>
          <Field label="下拉"><Select options={['Cedar & Crown', 'Northwind']} /></Field><Field label="后缀"><TextInput defaultValue="58.00" suffix="USD" /></Field>
          <Field label="多行" full><TextArea rows={2} defaultValue="记录认可意见…" /></Field></FormGrid>
          <div className="mist-row" style={{ marginTop: 14, gap: 24 }}><Checkbox checked={ck} onChange={setCk} label="复选" /><Switch checked={sw} onChange={setSw} label="开关" /></div></div></Card>
        <Card className="mist-col-6"><CardHeader title="选择" /><div className="mist-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Segmented value={seg} onChange={setSeg} options={[{ value: 'a', label: '今天' }, { value: 'b', label: '本周' }, { value: 'c', label: '本月' }]} />
          <SearchField value={q} onChange={setQ} placeholder="搜索" />
          <ChoiceCards<'ok' | 'mod' | 'no'> value={ch} onChange={setCh} options={[{ value: 'ok', title: '认可' }, { value: 'mod', title: '需修改' }, { value: 'no', title: '不采用' }]} /></div></Card>
        <Card className="mist-col-6"><CardHeader title="头像 / 进度" /><div className="mist-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="mist-row"><Avatar name="顾言" /><Avatar name="沈禾" tone="ok" /><Avatar name="QC" tone="ai" /><AvatarStack people={[{ name: '顾' }, { name: '沈', tone: 'ok' }, { name: '许', tone: 'warn' }, { name: '江', tone: 'ai' }, { name: '王' }]} max={3} /></div>
          <StageProgress total={5} current={3} /><Meter segments={[{ value: 18, tone: 'ok' }, { value: 54 }]} caption="72% · 已 QC 18%" /></div></Card>
        <Card className="mist-col-6"><CardHeader title="Banner / Toast" /><div className="mist-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Banner tone="ai" icon={Sparkles} title="小竹建议">AI 建议统一用竹青与淡玉 Banner。</Banner><Button onClick={() => toast('已保存')}>弹出 Toast</Button></div></Card>
      </section>}
      {tab === 'map' && <Card><DataTable ariaLabel="模块映射" rows={MODULE_MAP} rowKey={m => m.id} onRowClick={m => go(m.view)} columns={[
        { key: 'w', header: '批次', width: '70px', sortValue: m => m.wave, render: m => <Pill tone={m.wave === 1 ? 'accent' : 'neutral'} plain>Wave {m.wave}</Pill> },
        { key: 'l', header: '模块', width: 'minmax(140px,1.2fr)', sortValue: m => m.label, render: m => <><b className="mist-cell-strong">{m.label}</b><span className="mist-cell-sub">{m.group}</span></> },
        { key: 't', header: '列表模板', width: '130px', render: m => TEMPLATES[m.template].name },
        { key: 'd', header: '详情模板', width: '120px', hideOnMobile: true, render: m => m.detail ? TEMPLATES[m.detail].name : '—' },
        { key: 'e', header: '源文件', width: 'minmax(180px,1.4fr)', hideOnMobile: true, render: m => <><Mono>{m.entry.replace('components/', '')}</Mono><span className="mist-cell-sub">{m.lines.toLocaleString()} 行</span></> },
        { key: 'n', header: '备注', width: 'minmax(160px,1.6fr)', hideOnMobile: true, render: m => <span className="mist-muted" style={{ fontSize: 12.5 }}>{m.notes ?? ''}</span> },
      ]} /></Card>}
    </MistPage>
  );
}
