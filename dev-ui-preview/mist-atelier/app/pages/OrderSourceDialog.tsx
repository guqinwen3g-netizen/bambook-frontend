/** 新建订单入口：手工新建、从报价转单、从开发版本转单、从产品档案复购。都进入同一份订单草稿。 */
import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { Banner, Button, Dialog, EmptyState, Field, FormGrid, Mono, SearchField, TextInput, useToast } from '../../../../components/mist';
import type { MistOrder } from '../../../../server/src/shared/mistWorkspace';
import type { MarketProduct, MarketQuotation, MarketState } from '../../../../server/src/shared/mistMarket';
import { developmentDomain } from '../../../../server/src/shared/mistDevelopmentDomain';
import { useMistWorkspace } from '../runtime/workspace';
import { useNav } from '../nav';

const ROW: React.CSSProperties = { flexDirection: 'row', alignItems: 'center', gap: 12, width: '100%' };
type Kind = 'manual' | 'quotation' | 'version' | 'product';
type Domain = MistOrder['type'];

/** 已接受且尚未转单、且来源与订单类型一致的报价。 */
export function convertibleQuotations(state: { market?: MarketState; devs: Array<{ id: string; values: unknown }> } | null, type: Domain): MarketQuotation[] {
  const market = state?.market; if (!market) return [];
  return market.quotations.filter(quote => quote.status === 'Accepted' && !quote.convertedOrderId && quote.lines.length > 0 && quote.lines.every(line => {
    const product = line.productId ? market.products.find(row => row.id === line.productId) : undefined;
    const dev = line.sourceDevId ? state!.devs.find(row => row.id === line.sourceDevId) : undefined;
    const family = product?.category || (dev ? (developmentDomain(dev.values as never) === 'fabric' ? 'fabric' : 'garment') : undefined);
    return !family || family === type;
  }));
}

export function OrderSourceDialog({ open, onClose, type, customerId, canWrite }: { open: boolean; onClose: () => void; type: Domain; customerId?: string; canWrite: boolean }) {
  const { go } = useNav(), toast = useToast(), w = useMistWorkspace();
  const state = w.state as (typeof w.state & { market?: MarketState }) | null;
  const [kind, setKind] = React.useState<Kind | null>(null), [q, setQ] = React.useState(''), [picked, setPicked] = React.useState(''), [due, setDue] = React.useState(''), [owner, setOwner] = React.useState('');
  const [busy, setBusy] = React.useState(false), [failure, setFailure] = React.useState(''), lock = React.useRef(false), alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => { if (open) { setKind(null); setQ(''); setPicked(''); setDue(''); setOwner(state?.settings.profileName || ''); setFailure(''); } }, [open]);
  const domainLabel = type === 'fabric' ? '面料' : '成衣';
  const quotes = convertibleQuotations(state, type).filter(quote => !customerId || quote.customerId === customerId);
  const versions = (state?.versions || []).filter(version => !version.archivedAt && version.confirmations.some(row => row.result === 'approved')).map(version => ({ version, dev: state!.devs.find(dev => dev.id === version.devId) })).filter(row => row.dev && (developmentDomain(row.dev.values) === 'fabric' ? 'fabric' : 'garment') === type && (!customerId || row.dev.customerId === customerId));
  const products = (state?.market?.products || []).filter((product: MarketProduct) => product.status === 'active' && product.category === type);
  const customerName = (id: string) => state?.customers.find(row => row.id === id)?.name || '客户不可用';
  const match = (text: string) => !q || text.toLowerCase().includes(q.toLowerCase());
  const options: Array<{ kind: Kind; title: string; detail: string; count?: number }> = [
    { kind: 'manual', title: '手工新建', detail: `逐项填写${domainLabel}订单条目` },
    { kind: 'quotation', title: '从报价转单', detail: '客户已接受、尚未转单的报价', count: quotes.length },
    { kind: 'version', title: '从开发版本转单', detail: '已获客户认可的开发版本', count: versions.length },
    { kind: 'product', title: '从产品档案复购', detail: `有效的${domainLabel}数字档案`, count: products.length },
  ];
  const choose = (next: Kind) => { setFailure(''); setPicked(''); setQ(''); if (next === 'manual') { onClose(); go('orders/new', undefined, { customerId, section: type }); } else setKind(next); };
  const convert = async () => {
    if (lock.current || busy) return;
    if (!picked) { setFailure('请选择一份报价'); return; }
    if (!due || !owner.trim()) { setFailure('请填写订单交期和负责人'); return; }
    lock.current = true; setBusy(true); setFailure('');
    try {
      const receipt = await w.run({ type: 'market.quotation.convert', payload: { id: picked, type, due, owner: owner.trim() } } as never);
      const orderId = (receipt.result as { orderId?: string }).orderId;
      if (!orderId) throw new Error('报价已转单，但回执缺少订单编号。请到报价详情核对，勿重复转单。');
      if (alive.current) { toast('已从报价生成订单草稿，待补合同依据后提交主单审批'); onClose(); go('orders/detail', orderId, { customerId, section: type }); }
    } catch (problem) { if (alive.current) setFailure(problem instanceof Error ? problem.message : '报价未能转单，请重试'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const continueDraft = () => {
    if (!picked) { setFailure(kind === 'version' ? '请选择一个开发版本' : '请选择一份数字档案'); return; }
    onClose();
    if (kind === 'version') go('orders/new', undefined, { customerId, section: type, versionId: picked });
    else go('orders/new', 'product:' + picked, { customerId, section: type });
  };
  const row = (id: string, title: React.ReactNode, sub: string, meta: string) => <button key={id} type="button" role="radio" aria-checked={picked === id} className="mist-choice" style={ROW} data-selected={picked === id || undefined} onClick={() => { setPicked(id); setFailure(''); }}>
    <span className="mist-col" style={{ gap: 2, alignItems: 'flex-start', textAlign: 'left' }}><b>{title}</b><small className="mist-muted">{sub}</small></span><span className="mist-spacer" /><small className="mist-muted">{meta}</small></button>;
  const list = kind === 'quotation' ? quotes.filter(quote => match(`${quote.code} ${customerName(quote.customerId)} ${quote.season}`)).map(quote => row(quote.id, <Mono>{quote.code}</Mono>, `${customerName(quote.customerId)} · ${quote.season || '未填季节'} · ${quote.lines.length} 个条目`, `${quote.total} ${quote.currency}`))
    : kind === 'version' ? versions.filter(({ version, dev }) => match(`${dev!.code} ${dev!.name} ${dev!.style} ${version.label}`)).map(({ version, dev }) => row(version.id, <><Mono>{dev!.code}</Mono> · {version.label}</>, `${dev!.name} · ${dev!.style} · ${version.factory || '工厂未填'}`, dev!.customer || '未关联客户'))
    : kind === 'product' ? products.filter(product => match(`${product.sku} ${product.name} ${product.specification}`)).map(product => row(product.id, <Mono>{product.sku}</Mono>, `${product.name} · ${product.specification || '规格未填'}`, product.unit || '单位未填'))
    : [];
  const title = kind ? options.find(option => option.kind === kind)!.title : `新建${domainLabel}订单`;
  const footer = !kind ? <Button onClick={onClose}>取消</Button>
    : <><Button variant="quiet" icon={ArrowLeft} disabled={busy} onClick={() => { setKind(null); setFailure(''); }}>换一种来源</Button><span className="mist-spacer" />
      {kind === 'quotation' ? <Button variant="primary" loading={busy} disabled={!canWrite || busy || !!w.pending} title={canWrite ? undefined : '当前账号没有订单写权限'} onClick={() => void convert()}>转为订单草稿</Button>
        : <Button variant="primary" disabled={!canWrite} onClick={continueDraft}>带入订单草稿</Button>}</>;
  return <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title={title} description={kind ? undefined : '选择订单来源；无论哪种来源，都先生成订单草稿，补齐合同依据后提交主单审批。'} width={720} footer={footer}>
    {!canWrite && <Banner tone="warn" title="只读">当前账号没有订单写权限，可以查看来源但不能建立订单。</Banner>}
    {failure && <Banner tone="bad" title="尚未建立订单">{failure}</Banner>}
    {!kind && <div className="mist-col" role="group" aria-label="订单来源" style={{ gap: 8 }}>{options.map(option => {
      const empty = option.count === 0;
      return <button key={option.kind} type="button" className="mist-choice" style={ROW} disabled={!canWrite || empty} title={empty ? '没有可用的来源记录' : undefined} onClick={() => choose(option.kind)}>
        <span className="mist-col" style={{ gap: 2, alignItems: 'flex-start', textAlign: 'left' }}><b>{option.title}</b><small className="mist-muted">{option.detail}</small></span><span className="mist-spacer" />{option.count !== undefined && <small className="mist-muted">{empty ? '暂无可用' : `${option.count} 项可用`}</small>}</button>;
    })}</div>}
    {kind && <div className="mist-col" style={{ gap: 12 }}>
      <SearchField value={q} onChange={setQ} placeholder={kind === 'quotation' ? '报价号、客户或季节' : kind === 'version' ? '开发案号、款名或版本' : '产品码、品名或规格'} />
      <div className="mist-col" role="radiogroup" aria-label="来源记录" style={{ gap: 6, maxHeight: 320, overflow: 'auto' }}>{list.length ? list : <EmptyState compact title="没有匹配的来源记录" />}</div>
      {kind === 'quotation' ? <FormGrid><Field label="订单交期" required><TextInput aria-label="订单交期" type="date" value={due} onChange={event => setDue(event.target.value)} /></Field><Field label="负责人" required><TextInput aria-label="负责人" value={owner} onChange={event => setOwner(event.target.value)} /></Field></FormGrid>
        : <p className="mist-note">将带入品名、款号 / 品号与单位；数量、销售单价、交期在草稿中填写，来源会随条目一起保存。</p>}
      {kind === 'quotation' && <p className="mist-note">报价的条目、数量、单价与币种原样承接；转单后订单为草稿，仍需上传客户 PO / 书面确认并提交主单审批。</p>}
    </div>}
  </Dialog>;
}
