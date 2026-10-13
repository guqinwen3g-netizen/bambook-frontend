/** T11 状态规范：受控组件示例，不创建业务记录或权限申请。 */
import React from 'react';
import { CloudOff, FolderOpen, Lock, RefreshCw, SearchX, TriangleAlert } from 'lucide-react';
import { Banner, Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, MistPage, PageHeader, SearchField, Skeleton, TextLink, useToast } from '../../../../components/mist';
import { useNav } from '../nav';

const EXAMPLE_ROWS = [{ id: '1', a: 'SO-G-2026-018', b: '140,800' }, { id: '2', a: 'SO-G-2026-017', b: '41,850' }];
const COLUMNS = [{ key: 'a', header: '示例订单', width: '2fr', render: (row: typeof EXAMPLE_ROWS[number]) => row.a }, { key: 'b', header: '示例金额', width: '1fr', align: 'right' as const, render: (row: typeof EXAMPLE_ROWS[number]) => row.b }];
export function StatesPage() {
  const toast = useToast(), { go } = useNav();
  const [loading, setLoading] = React.useState(true), [phase, setPhase] = React.useState<'error' | 'loading' | 'ready'>('error');
  const [query, setQuery] = React.useState('无匹配示例'), [permissionInfo, setPermissionInfo] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const retry = () => {
    window.clearTimeout(timer.current); setLoading(true); setPhase('loading');
    timer.current = window.setTimeout(() => { setLoading(false); setPhase('ready'); }, 500);
  };
  const filtered = EXAMPLE_ROWS.filter(row => row.a.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <MistPage>
      <PageHeader eyebrow="交付 · 规范" title="空 / 加载 / 错误" description="受控组件状态示例；不创建业务记录，也不发送权限申请。" />
      <section className="mist-grid">
        <Card className="mist-col-6"><CardHeader title={loading ? '加载中 · 表格' : '加载完成 · 表格'} sub="点击下方重试，查看从骨架到示例结果的变化" />
          <DataTable loading={loading} rows={EXAMPLE_ROWS} rowKey={row => row.id} columns={COLUMNS} /></Card>
        <Card className="mist-col-6"><CardHeader title="加载中 · 卡片" sub="Skeleton：按真实内容的形状排布" />
          <div className="mist-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="mist-row"><Skeleton width={48} height={56} radius={12} /><div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}><Skeleton width="60%" height={14} /><Skeleton width="40%" /></div></div>
            <Skeleton height={10} /><Skeleton width="80%" height={10} /><Skeleton width="50%" height={10} />
          </div></Card>
        <Card className="mist-col-4"><EmptyState icon={FolderOpen} title="还没有开发案" description="点击进入真实的新建开发案页面。" action={<Button variant="primary" size="sm" onClick={() => go('development/new')}>新建开发案</Button>} /></Card>
        <Card className="mist-col-4"><CardBody><SearchField value={query} onChange={setQuery} placeholder="筛选示例订单" /></CardBody>
          {filtered.length ? <DataTable rows={filtered} rowKey={row => row.id} columns={COLUMNS} /> : <EmptyState icon={SearchX} title="没有符合条件的结果" description="清除筛选后显示两条示例结果" action={<TextLink onClick={() => setQuery('')}>清除筛选</TextLink>} />}</Card>
        <Card className="mist-col-4"><EmptyState icon={Lock} title="没有查看权限" description="权限状态示例。这里不会更改账号权限。" action={<Button size="sm" onClick={() => setPermissionInfo(true)}>申请权限</Button>} /></Card>
        <div className="mist-col-12 mist-col">
          <Banner tone={phase === 'ready' ? 'ok' : phase === 'loading' ? 'accent' : 'bad'} icon={phase === 'ready' ? undefined : TriangleAlert}
            title={phase === 'ready' ? '示例数据已载入' : phase === 'loading' ? '正在重试示例' : '数据加载失败示例'}
            actions={<Button size="sm" icon={RefreshCw} disabled={phase === 'loading'} onClick={retry}>{phase === 'ready' ? '再次演示加载' : '重试'}</Button>}>重试会切换上方表格的受控加载状态，不访问或写入业务接口。</Banner>
          <Banner tone="warn" icon={CloudOff} title="离线状态示例">实际保存失败后，需要恢复连接、核对原请求结果，再决定是否重试。这里不承诺自动同步。</Banner>
          <Banner tone="ok" title="成功状态示例">成功提示优先用 Toast（2.6 秒自动消失），只有需要停留的结果才用 Banner。</Banner>
        </div>
        <Card className="mist-col-12"><CardHeader title="Toast" sub="点击展示提示样式，不执行保存" />
          <div className="mist-card-body" style={{ display: 'flex', gap: 10 }}><Button onClick={() => toast('成功提示示例')}>成功提示</Button><Button variant="danger" onClick={() => toast('失败提示示例', 'bad')}>失败提示</Button></div></Card>
      </section>
      <Dialog open={permissionInfo} onClose={() => setPermissionInfo(false)} title="权限申请说明" description="这是无权限组件示例，未向管理员发送任何申请。" footer={<Button onClick={() => setPermissionInfo(false)}>知道了</Button>}>
        实际业务中请通过公司约定的授权流程联系账号管理员。
      </Dialog>
    </MistPage>
  );
}
