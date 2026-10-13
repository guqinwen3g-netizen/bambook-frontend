/** T8 生产看板：沿用原 Mist 卡片和布局，拖动保存到共享工作空间。 */
import React from 'react';
import { AlertTriangle, CalendarRange, Factory } from 'lucide-react';
import { Banner, Button, Card, CardHeader, DataTable, Drawer, Dropdown, EmptyState, Field, FormGrid, Kanban, KeyValue, Meter, MistPage, Mono, ObjectCell, PageHeader, Pill, SearchField, Segmented, TextArea, TextInput, Thumb, Toolbar, useToast } from '../../../../components/mist';
import type { MistProduction } from '../../../../server/src/shared/mistWorkspace';
import { IMG, PROD_COLUMNS, fmt } from '../data';
import { useNav } from '../nav';
import { useMistWorkspace } from '../runtime/workspace';
import { useMistSession } from '../runtime/auth';
import { ModuleEditorPage, ModuleEditorDialog, type ModuleEditorSpec } from './modules/ModuleWorkbench';
import type { FulfillmentSizeQuantity } from '../../../../server/src/shared/mistFulfillment';
import { mistDate } from './OrderListPage';

export function parseProductionSizes(value:string):FulfillmentSizeQuantity[] { if(!value.trim())return []; return value.split(/\n+/).map(line=>{ const match=line.trim().match(/^(.+?)[:：]\s*(\d+(?:\.\d{1,4})?)$/);if(!match)throw new Error('尺码数量请逐行填写，例如 M:10');return {size:match[1].trim(),quantity:Number(match[2])}; }); }
export type ProductionRange = 'week' | 'month' | 'all';
export function productionWindow(range: ProductionRange, now = new Date(), items: Pick<MistProduction,'startDate'|'due'>[] = []): {start:Date;end:Date} {
  if (range === 'all') {
    const dates = items.flatMap(item => [item.startDate ? mistDate(item.startDate) : null, mistDate(item.due)]).filter((date):date is Date=>!!date);
    if (dates.length) {
      const start = new Date(dates.reduce((earliest,date)=>Math.min(earliest,date.getTime()),Infinity)); start.setHours(0,0,0,0);
      const end = new Date(dates.reduce((latest,date)=>Math.max(latest,date.getTime()),-Infinity)); end.setHours(0,0,0,0); end.setDate(end.getDate()+1);
      return {start,end};
    }
    return productionWindow('month',now);
  }
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (range === 'month') start.setDate(1); else start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  if (range === 'month') end.setMonth(end.getMonth() + 1); else end.setDate(end.getDate() + 7);
  return { start, end };
}
export function ProductionPage() {
  const { go, route } = useNav(), toast = useToast(), session = useMistSession();
  const [operation,setOperation]=React.useState<ModuleEditorSpec|null>(null);
  const { state, loading, error, run, refresh } = useMistWorkspace();
  const [q, setQ] = React.useState(''), [orderId, setOrderId] = React.useState('all');
  const [range, setRange] = React.useState<ProductionRange>('week'), [gantt, setGantt] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(route.productionId ?? null);
  const [draft, setDraft] = React.useState({ pct: 0, risk: '', note: '', startDate: '', due: '' });
  const [busy, setBusy] = React.useState(false), [failure, setFailure] = React.useState('');
  const items = state?.productions ?? [], selected = items.find(item => item.id === selectedId);
  const fact=state?.fulfillment.productionFacts?.find(item=>item.productionId===selectedId);
  const canPlan=session.hasPermission('production:write'), canRelease=session.hasPermission('orders:write');
  const sizesText=(sizes:FulfillmentSizeQuantity[])=>sizes.map(size=>`${size.size}:${size.quantity}`).join('\n');
  const openPlan=()=>selected&&setOperation({title:'登记生产分支尺码',fields:[{key:'sizes',label:'实际生产尺码与计划数量（每行 尺码:数量）',type:'textarea',required:true}],initialValues:{sizes:sizesText(fact?.sizes||[])},submit:values=>run({type:'fulfillment.production.plan',payload:{productionId:selected.id,sizes:parseProductionSizes(String(values.sizes||''))}})});
  const openRelease=()=>selected&&setOperation({title:'业务确认开产放行',fields:[{key:'note',label:'合同、产前样与开产核对依据',type:'textarea',required:true}],initialValues:{note:''},submit:values=>run({type:'fulfillment.production.release',payload:{productionId:selected.id,note:String(values.note||'')}})});
  const openComplete=()=>selected&&setOperation({title:'登记最终实际完工',fields:[{key:'quantity',label:'最终实际完工数量',type:'number',required:true,min:0,step:'0.0001'},{key:'sizes',label:'各实际尺码数量（每行 尺码:数量）',type:'textarea',required:state?.orders.find(order=>order.id===selected.orderId)?.type==='garment'},{key:'date',label:'实际完工日',type:'date',required:true},{key:'evidence',label:'最终点数及完工依据',type:'textarea',required:true}],initialValues:{quantity:'',sizes:'',date:new Date().toISOString().slice(0,10),evidence:''},submit:values=>run({type:'fulfillment.production.complete',payload:{productionId:selected.id,quantity:Number(values.quantity),sizeQuantities:parseProductionSizes(String(values.sizes||'')),date:String(values.date||''),evidence:String(values.evidence||''),fileIds:[]}})});
  const openAccept=()=>selected&&setOperation({title:'登记客户接受数量差异',fields:[{key:'note',label:'客户明确接受最终数量的依据',type:'textarea',required:true}],initialValues:{note:''},submit:values=>run({type:'fulfillment.production.acceptCompletion',payload:{productionId:selected.id,note:String(values.note||'')}})});
  React.useEffect(() => { setSelectedId(route.productionId ?? null); if(route.productionId){setRange('all');setOrderId('all');setQ('');} }, [route.productionId]);
  React.useEffect(() => { if (selected) setDraft({ pct: selected.pct, risk: selected.risk ?? '', note: '', startDate: selected.startDate ?? '', due: selected.due }); setFailure(''); }, [selected?.id]);
  const matching = items.filter(item => !(orderId !== 'all' && item.orderId !== orderId || q && !`${item.name} ${item.code} ${item.factory} ${item.order}`.toLowerCase().includes(q.toLowerCase())));
  const window = productionWindow(range,new Date(),matching);
  const shown = matching.filter(item => {
    if(range==='all')return true;
    const due = mistDate(item.due), start = item.startDate ? mistDate(item.startDate) : null;
    if (!due) return true;
    if (start) return start.getTime() < window.end.getTime() && due.getTime() >= window.start.getTime();
    return due.getTime() >= window.start.getTime() && due.getTime() < window.end.getTime();
  });
  const risks = shown.filter(item => item.risk);
  const move = async (id: string, col: string) => {
    if (busy || !PROD_COLUMNS.some(column => column.id === col)) return;
    const item = items.find(item => item.id === id); if (!item || item.col === col) return;
    setBusy(true); setFailure('');
    try { await run({ type: 'production.move', payload: { id, col: col as MistProduction['col'] } }); toast(`${item.code} 已移至${PROD_COLUMNS.find(column => column.id === col)?.title}`); }
    catch (problem) { setFailure(problem instanceof Error ? problem.message : '工序未保存，请重试'); } finally { setBusy(false); }
  };
  const position = (date: string) => Math.max(0, Math.min(100, ((mistDate(date)?.getTime() ?? window.start.getTime()) - window.start.getTime()) / (window.end.getTime() - window.start.getTime()) * 100));
  if(operation)return operation.fields.length>3?<ModuleEditorPage spec={operation} onClose={()=>setOperation(null)}/>:<ModuleEditorDialog spec={operation} onClose={()=>setOperation(null)}/>;
  return <MistPage width="wide">
    <PageHeader eyebrow="订单履约 · 生产" title="生产进度" description="先核对合同与样品并明确开产放行，按实际进度追加记录；最终完工数量与生产QC分别保存。"
      actions={<><Segmented<ProductionRange> ariaLabel="范围" value={range} onChange={setRange} options={[{ value: 'week', label: '本周' }, { value: 'month', label: '本月' },{ value:'all',label:'全部' }]} /><Button icon={CalendarRange} onClick={() => setGantt(value => !value)}>{gantt ? '看板' : '甘特图'}</Button></>} />
    {(failure || error) && <Banner tone="bad" title="生产记录未保存" actions={error ? <Button onClick={() => void refresh()}>重试</Button> : undefined}>{failure || error}</Banner>}
    {risks.length > 0 && <div className="mist-section"><Banner tone="warn" icon={AlertTriangle} title={`${risks.length} 个生产单有交期风险`} actions={<Button size="sm" onClick={() => { setSelectedId(risks[0].id); }}>查看生产单</Button>}>{risks.map(item => `${item.code}：${item.risk}`).join('；')}</Banner></div>}
    <Toolbar><SearchField value={q} onChange={setQ} placeholder="款式、生产单或工厂" /><Dropdown label="订单" value={orderId} onChange={setOrderId} options={[{ value: 'all', label: '全部' }, ...(state?.orders ?? []).map(order => ({ value: order.id, label: order.code }))]} /></Toolbar>
    {!shown.length && !loading ? <Card><EmptyState title={q || orderId !== 'all' ? '没有匹配的生产单' : range==='all'?'暂无生产单':`本${range === 'week' ? '周' : '月'}没有计划中的生产单`} action={range!=='all'||q||orderId!=='all'?<Button onClick={() => { setQ(''); setOrderId('all'); setRange('all'); }}>查看全部生产单</Button>:undefined} /></Card> : gantt ? <Card><CardHeader title="生产计划" sub={`${window.start.toLocaleDateString('zh-CN')} — ${new Date(window.end.getTime() - 1).toLocaleDateString('zh-CN')}`} /><DataTable density={state?.settings.density} ariaLabel="生产甘特图" rows={shown} loading={loading} rowKey={item => item.id} onRowClick={item => setSelectedId(item.id)} columns={[
      { key: 'object', header: '生产单', width: 'minmax(180px,1fr)', render: item => <ObjectCell name={item.name} meta={<Mono>{item.code}</Mono>} /> },
      { key: 'factory', header: '工厂', width: '120px', render: item => item.factory },
      { key: 'schedule', header: '计划时间', width: 'minmax(220px,2fr)', render: item => <><svg width="100%" height="28" viewBox="0 0 100 12" role="img" aria-label={item.startDate ? `${item.startDate} 至 ${item.due}` : `交期 ${item.due}，未记录开始日`}>
        {item.startDate ? <line x1={position(item.startDate)} y1="6" x2={position(item.due)} y2="6" stroke="var(--mist-accent)" strokeWidth="3" strokeLinecap="round" /> : <circle cx={position(item.due)} cy="6" r="2" fill="var(--mist-accent)" />}</svg><span className="mist-cell-sub">{item.startDate ? `${item.startDate} → ` : '交期 '}{item.due}</span></> },
      { key: 'progress', header: '进度', width: '100px', render: item => `${item.pct}%` },
    ]} /></Card> : <Kanban columns={PROD_COLUMNS.map(column => ({ ...column, items: shown.filter(item => item.col === column.id) }))} itemKey={item => item.id}
      onMove={busy ? undefined : (id, col) => { void move(id, col); }} onOpen={item => setSelectedId(item.id)} renderCard={item => <>
        <div className="mist-row"><Thumb src={IMG[item.img]} size="sm" /><div style={{ minWidth: 0 }}><b>{item.name}</b><div className="mist-obj-meta"><Mono>{item.code}</Mono> · {item.order}</div></div></div>
        <Meter segments={[{ value: item.pct, tone: item.pct === 100 ? 'ok' : 'accent' }]} caption={`${item.pct}% · ${fmt(item.qty)} 件`} />
        <div className="mist-kb-card-foot"><Factory className="mist-icon" data-size="xs" />{item.factory}<span className="mist-spacer" />{item.risk ? <Pill tone="warn">{item.risk}</Pill> : <span>{item.due}</span>}</div>
      </>} />}
    <Drawer open={!!selected} onClose={() => { if (!busy) setSelectedId(null); }} title={selected?.name ?? '生产单'} sub={selected?.code} size="lg"
      footer={<><Button disabled={busy} onClick={() => selected && go('orders/detail', selected.orderId, { orderLineId: selected.lineId, productionId: selected.id })}>打开关联订单</Button><Button variant="primary" loading={busy} onClick={async () => {
        if (!selected || busy) return; setBusy(true); setFailure('');
        try { await run({ type: 'production.update', payload: { id: selected.id, pct: draft.pct, risk: draft.risk, note: draft.note, startDate: draft.startDate || undefined, due: draft.due } }); setSelectedId(null); toast('生产记录已保存'); }
        catch (problem) { setFailure(problem instanceof Error ? problem.message : '生产记录保存失败'); } finally { setBusy(false); }
      }}>保存进度</Button></>}>
      <div className="mist-col" data-module-detail>{failure && <Banner tone="bad" title="保存失败">{failure}</Banner>}
      <KeyValue items={[{label:'开产状态',value:fact?.release?`已放行 · ${fact.release.actor} · ${fact.release.note}`:'待业务放行'},{label:'计划尺码',value:fact?.sizes.length?sizesText(fact.sizes):'未登记'},{label:'最终完工',value:fact?.completion?`${fact.completion.quantity} · ${fact.completion.evidence}`:'未登记最终数量'},{label:'客户接受差异',value:fact?.customerAcceptance?.note||'未登记 / 不适用'}]}/>
      <div className="mist-row">{canPlan&&!fact?.release&&<Button onClick={openPlan}>登记生产尺码</Button>}{canRelease&&!fact?.release&&<Button onClick={openRelease}>核对并放行开产</Button>}{canPlan&&fact?.release&&!fact?.completion&&<Button onClick={openComplete}>登记最终完工数量</Button>}{canRelease&&fact?.completion&&selected&&fact.completion.quantity!==selected.qty&&!fact.customerAcceptance&&<Button onClick={openAccept}>客户接受数量差异</Button>}<Button onClick={()=>selected&&go('samples',undefined,{productionId:selected.id})}>准备本分支样品</Button><Button onClick={()=>selected&&go('qc-workbench',undefined,{productionId:selected.id,orderLineId:selected.lineId,section:'production'})}>本分支生产QC</Button></div><FormGrid><Field label="生产进度（%）"><TextInput type="number" min={0} max={100} value={draft.pct} onChange={event => setDraft(value => ({ ...value, pct: Number(event.target.value) }))} /></Field><Field label="计划开始日"><TextInput type="date" value={draft.startDate} onChange={event => setDraft(value => ({ ...value, startDate: event.target.value }))} /></Field><Field label="计划交期"><TextInput type="date" value={mistDate(draft.due)?.toISOString().slice(0, 10) ?? draft.due} onChange={event => setDraft(value => ({ ...value, due: event.target.value }))} /></Field><Field label="风险"><TextInput value={draft.risk} onChange={event => setDraft(value => ({ ...value, risk: event.target.value }))} /></Field><Field label="跟进记录" full><TextArea value={draft.note} onChange={event => setDraft(value => ({ ...value, note: event.target.value }))} /></Field></FormGrid>
      </div>
    </Drawer>
  </MistPage>;
}
