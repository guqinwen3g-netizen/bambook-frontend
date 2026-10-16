import React from 'react';
import { FlaskConical, Plus, ShoppingCart, Trash2, FileText } from 'lucide-react';
import { Banner, Button, CardHeader, DataTable, Dialog, EmptyState, Field, KeyValue, Mono, Pill, Select, TextInput, type Column } from '../../../../../components/mist';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { PRODUCT_SPEC_FIELDS, type MarketProduct, type MarketQuotation, type MarketState } from '../../../../../server/src/shared/mistMarket';

export const PRODUCT_CATEGORY_LABEL: Record<MarketProduct['category'], string> = { fabric: '面料', garment: '成衣', trimming: '辅料' };

/** 列表与卡片用的关键规格摘要；只拼接已登记的值，不推断。 */
export function productSpecSummary(p: MarketProduct): string {
  const parts = PRODUCT_SPEC_FIELDS[p.category].map(f => { const v = p.specs?.[f.key]; return v ? (f.unit ? `${v} ${f.unit}` : v) : ''; }).filter(Boolean).slice(0, 3);
  return parts.join(' · ') || p.specification || '规格未登记';
}
/** 参考价按产品自身币种与计价单位展示，从不跨行合计。 */
export function productPriceText(p: MarketProduct): string { return p.refPrice ? `${p.currency} ${p.refPrice} / ${p.unit}` : `参考价未登记 · ${p.unit}`; }

type Reference = { key: string; kind: '报价' | '订单'; code: string; date: string; status: string; basis: string; open: () => void };
const QUOTE_STATUS: Record<MarketQuotation['status'], string> = { Draft: '草稿', Sent: '已线下交付', Accepted: '客户已接受', Rejected: '客户未接受', Expired: '已过期' };

export function productReferences(product: MarketProduct, market: MarketState, orders: Array<{ id: string; code: string; createdAt: string; state: string }>, orderLines: Array<{ orderId: string; style: string }>, go: (view: string, id?: string) => void): Reference[] {
  const refs: Reference[] = [];
  const quoted = market.quotations.filter(q => q.lines.some(l => l.productId === product.id));
  for (const q of quoted) refs.push({ key: 'q-' + q.id, kind: '报价', code: q.code, date: q.updatedAt.slice(0, 10), status: QUOTE_STATUS[q.status], basis: '报价行引用本档案', open: () => go('quotations', q.id) });
  const seen = new Set<string>();
  for (const q of quoted) { const o = q.convertedOrderId ? orders.find(x => x.id === q.convertedOrderId) : undefined; if (o && !seen.has(o.id)) { seen.add(o.id); refs.push({ key: 'o-' + o.id, kind: '订单', code: o.code, date: o.createdAt.slice(0, 10), status: o.state, basis: '由引用报价转单', open: () => go('orders', o.id) }); } }
  const sku = product.sku.trim().toLowerCase();
  for (const o of orders) if (!seen.has(o.id) && sku && orderLines.some(l => l.orderId === o.id && l.style.trim().toLowerCase() === sku)) { seen.add(o.id); refs.push({ key: 'o-' + o.id, kind: '订单', code: o.code, date: o.createdAt.slice(0, 10), status: o.state, basis: '按款号匹配，请核对', open: () => go('orders', o.id) }); }
  return refs.sort((a, b) => b.date.localeCompare(a.date));
}

/** 列表缩略图：只使用已上传的图片附件，没有图片时显示类别字样。 */
export function ProductThumb({ product }: { product: MarketProduct }) {
  const w = useMistWorkspace();
  const file = w.state?.files.find(f => product.fileIds.includes(f.id) && f.mimeType.startsWith('image/'));
  return <span className="mist-product-thumb" data-category={product.category}>{file ? <img src={w.fileUrl(file)} alt="" /> : PRODUCT_CATEGORY_LABEL[product.category].slice(0, 1)}</span>;
}

function productSaveInput(row: MarketProduct) { const { id, createdAt, updatedAt, status, ...input } = row; return input; }

/** 数字档案详情：规格、客户编码表、来源链、引用记录与后续动作。放在同一张详情卡内。 */
export function ProductProfile({ product }: { product: MarketProduct }) {
  const w = useMistWorkspace(), session = useMistSession(), { go } = useNav();
  const market = (w.state as (typeof w.state & { market?: MarketState }) | null)?.market;
  const canWrite = session.hasPermission('products:write') && product.status === 'active';
  const [editing, setEditing] = React.useState(false);
  const specFields = PRODUCT_SPEC_FIELDS[product.category];
  const dev = w.state?.devs.find(d => d.id === product.sourceDevId), version = w.state?.versions.find(v => v.id === product.sourceVersionId);
  const refs = market && w.state ? productReferences(product, market, w.state.orders, w.state.orderLines, go) : [];
  const canDevelop = session.hasPermission('development:write'), canOrder = session.hasPermission('orders:write'), canQuote = session.hasPermission('quotations:write');
  const archived = product.status === 'archived';
  const refColumns: Column<Reference>[] = [
    { key: 'kind', header: '类型', width: '64px', render: r => <Pill tone={r.kind === '订单' ? 'accent' : 'neutral'}>{r.kind}</Pill> },
    { key: 'code', header: '单号', width: 'minmax(120px,1fr)', render: r => <Mono>{r.code}</Mono> },
    { key: 'status', header: '状态', width: '96px', render: r => r.status },
    { key: 'basis', header: '依据', width: 'minmax(120px,1fr)', render: r => <span className="mist-product-basis">{r.basis}</span> },
    { key: 'date', header: '日期', width: '96px', render: r => r.date },
  ];
  return <div className="mist-col mist-product-profile">
    <section className="mist-product-section" aria-label="规格参数">
      <CardHeader title={`${PRODUCT_CATEGORY_LABEL[product.category]}规格`} />
      <KeyValue items={[...specFields.map(f => ({ label: f.label, value: product.specs?.[f.key] ? `${product.specs[f.key]}${f.unit ? ' ' + f.unit : ''}` : '未登记' })), { label: '计价单位 / 参考价', value: productPriceText(product) }]} />
      {product.category === 'fabric' && product.unit === '件' && <Banner tone="warn" title="面料计价单位为“件”">请核对是否应按米、码或公斤计价。</Banner>}
    </section>
    <section className="mist-product-section" aria-label="客户编码表">
      <CardHeader title="客户编码表" tools={canWrite ? <Button size="sm" onClick={() => setEditing(true)}>编辑</Button> : undefined} />
      {product.customerCodes?.length ? <KeyValue items={product.customerCodes.map(c => ({ label: w.state?.customers.find(x => x.id === c.customerId)?.name || '客户已不存在', value: c.code, mono: true }))} /> : <EmptyState compact title="未登记客户编码" description="客户使用自有编码下单时，在这里登记对照。" />}
    </section>
    <section className="mist-product-section" aria-label="来源链">
      <CardHeader title="来源链" />
      {product.sourceVersionId ? <ol className="mist-product-chain">
        <li><span>开发案</span><strong>{dev ? <Mono>{dev.code}</Mono> : '开发案已不存在'}</strong>{dev && <small>{dev.name}</small>}</li>
        <li><span>准确版本</span><strong>{version ? version.label : '版本已不存在'}</strong>{version && <small>{version.factory}</small>}</li>
        <li><span>QC 结论</span><strong>{version?.qc ? ({ pass: '通过', conditional: '有保留通过 · 需关注', reject: '不通过' } as const)[version.qc.result] : '无记录'}</strong>{version?.qc && <small>{version.qc.reviewer} · {version.qc.report}</small>}{version?.qc?.result === 'conditional' && <small>QC 意见：{version.qc.opinion || '见 QC 报告'}</small>}</li>
        <li><span>数字档案</span><strong><Mono>{product.sku}</Mono></strong><small>{product.createdAt.slice(0, 10)} 建档</small></li>
      </ol> : <EmptyState compact title="手工建档" description="此档案未关联开发版本，规格以档案登记为准。" />}
    </section>
    <section className="mist-product-section" aria-label="引用记录">
      <CardHeader title="引用记录" sub={refs.length ? `${refs.length} 条` : undefined} />
      {refs.length ? <DataTable ariaLabel="产品引用记录" rows={refs} rowKey={r => r.key} columns={refColumns} onRowClick={r => r.open()} density="compact" /> : <EmptyState compact title="暂无报价或订单引用" />}
    </section>
    <div className="mist-row mist-product-actions">
      <Button icon={FlaskConical} disabled={archived || !canDevelop || product.category === 'trimming'} title={product.category === 'trimming' ? '辅料开发尚未接入' : !canDevelop ? '需要开发编辑权限' : archived ? '归档产品须先恢复' : '新建同类开发案；规格请在开发表单中核对填写'} onClick={() => go('development/new', undefined, { section: product.category === 'fabric' ? 'fabric' : 'garment', ...(product.customerCodes?.[0] ? { customerId: product.customerCodes[0].customerId } : {}) })}>再次开发</Button>
      <Button icon={ShoppingCart} disabled={archived || !canOrder || product.category === 'trimming'} title={product.category === 'trimming' ? '辅料订单尚未接入' : !canOrder ? '需要订单编辑权限' : archived ? '归档产品须先恢复' : '以本档案为来源创建订单'} onClick={() => go('orders/new', 'product:' + product.id, { section: product.category, ...(product.customerCodes?.[0] ? { customerId: product.customerCodes[0].customerId } : {}) })}>复购下单</Button>
      <Button icon={FileText} disabled={archived || !canQuote} title={!canQuote ? '需要报价编辑权限' : archived ? '归档产品须先恢复' : '新建报价并带入本档案'} onClick={() => go('quotations', undefined, { section: 'product:' + product.id })}>加入报价</Button>
    </div>
    {editing && <CustomerCodeDialog product={product} onClose={() => setEditing(false)} />}
  </div>;
}

function CustomerCodeDialog({ product, onClose }: { product: MarketProduct; onClose: () => void }) {
  const w = useMistWorkspace();
  const customers = w.state?.customers || [];
  const [rows, setRows] = React.useState(product.customerCodes?.map(c => ({ ...c })) || []);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const free = customers.filter(c => !rows.some(r => r.customerId === c.id));
  const save = async () => {
    if (rows.some(r => !r.code.trim())) { setError('请填写每个客户的编码，或删除空行'); return; }
    setBusy(true); setError('');
    try { await w.run({ type: 'market.product.save', payload: { id: product.id, input: { ...productSaveInput(product), customerCodes: rows.map(r => ({ customerId: r.customerId, code: r.code.trim() })) } } }); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : '保存未完成'); }
    finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} title="客户编码表" description={`${product.sku} · ${product.name}`} footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</Button></>}>
    <div className="mist-col">
      {rows.map((r, i) => <div key={r.customerId} className="mist-row mist-product-code-row">
        <Field label={i === 0 ? '客户' : ''}><Select aria-label="客户" value={r.customerId} onChange={e => setRows(old => old.map((x, j) => j === i ? { ...x, customerId: e.target.value } : x))} options={customers.filter(c => c.id === r.customerId || !rows.some(x => x.customerId === c.id)).map(c => ({ value: c.id, label: c.name }))} /></Field>
        <Field label={i === 0 ? '客户编码' : ''}><TextInput aria-label="客户编码" value={r.code} maxLength={80} onChange={e => setRows(old => old.map((x, j) => j === i ? { ...x, code: e.target.value } : x))} /></Field>
        <Button icon={Trash2} aria-label="删除客户编码" onClick={() => setRows(old => old.filter((_, j) => j !== i))} />
      </div>)}
      {!rows.length && <EmptyState compact title="尚未登记" />}
      <Button icon={Plus} disabled={!free.length} title={free.length ? undefined : '所有客户均已登记'} onClick={() => setRows(old => [...old, { customerId: free[0].id, code: '' }])}>添加客户编码</Button>
      {error && <Banner tone="bad" title="未保存">{error}</Banner>}
    </div>
  </Dialog>;
}