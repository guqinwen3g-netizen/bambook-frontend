/** T7 客户档案：原 Mist 构图，所有 Tab 读取同一客户的关联实体。 */
import React from 'react';
import { BadgeDollarSign, CalendarClock, ClipboardList, Download, Ellipsis, Layers, Mail, Plus, Sparkles, TrendingUp, Wallet } from 'lucide-react';
import { Avatar, Banner, Button, Card, CardHeader, DataTable, Dialog, Drawer, EmptyState, Field, FormGrid, IconButton, IdentityHeader, KeyValue, MistPage, Mono, ObjectCell, PageHeader, Pill, Select, StageProgress, StatCard, StatGrid, Tabs, TextInput, Thumb, Timeline, useToast } from '../../../../components/mist';
import type { MistContact, MistCustomer } from '../../../../server/src/shared/mistWorkspace';
import { IMG, STAGES, fmt } from '../data';
import { useNav } from '../nav';
import { useMistWorkspace } from '../runtime/workspace';
import { useMistSession } from '../runtime/auth';
import { ModuleEditorPage, type ModuleEditorSpec } from './modules/ModuleWorkbench';
import { CustomerMailPanel, FollowUpPanel, OpportunityPanel } from './CustomerRelations';

export function CustomerPage() {
  const { go, route, openAI } = useNav(), toast = useToast(), session = useMistSession();
  const { state, loading, error, run, refresh, downloadFile } = useMistWorkspace();
  const requestedId = route.id ?? route.customerId;
  const customer = requestedId ? state?.customers.find(item => item.id === requestedId) : state?.customers[0];
  const [tab, setTab] = React.useState('overview');
  const [creating, setCreating] = React.useState(false);
  const canCreate = session.hasPermission('relations:write');
  const [contact, setContact] = React.useState<Partial<MistContact> | null>(null);
  const [edit, setEdit] = React.useState<MistCustomer | null>(null);
  const [deleteContact, setDeleteContact] = React.useState(false), [frequency, setFrequency] = React.useState(false);
  const [busy, setBusy] = React.useState(false), [failure, setFailure] = React.useState('');
  React.useEffect(() => { setTab(route.section && ['followups', 'opportunities', 'mail'].includes(route.section) ? route.section : 'overview'); setContact(null); setEdit(null); setFailure(''); }, [customer?.id, route.section]);
  const orders = (state?.orders ?? []).filter(item => item.customerId === customer?.id);
  const devs = (state?.devs ?? []).filter(item => item.customerId === customer?.id);
  const contacts = (state?.contacts ?? []).filter(item => item.customerId === customer?.id);
  const invoices = (state?.invoices ?? []).filter(invoice => orders.some(order => order.id === invoice.orderId));
  const active = orders.filter(order => !['已出运', '已完成', '已取消', '待收尾款'].includes(order.state));
  const events = (state?.events ?? []).filter(event => event.entityId === customer?.id || orders.some(order => order.id === event.entityId) || devs.some(dev => dev.id === event.entityId) || contacts.some(contact => contact.id === event.entityId)).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const fileIds = new Set([...devs.flatMap(dev => dev.fileIds), ...events.flatMap(event => event.fileIds)]);
  const files = (state?.files ?? []).filter(file => fileIds.has(file.id));
  const saveContact = async () => {
    if (!contact || !customer || busy) return;
    if (!contact.name?.trim()) { setFailure('请填写联系人姓名'); return; }
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) { setFailure('请填写有效邮箱'); return; }
    setBusy(true); setFailure('');
    try { await run({ type: 'market.contact.save', payload: { kind:'customer',parentId:customer.id,id: contact.id,primary:state?.market.relations.find(r=>r.customerId===customer.id)?.contacts.find(c=>c.id===contact.id)?.primary||false, name: contact.name, role: contact.role ?? '', email: contact.email ?? '', phone: contact.phone ?? '' } }); setContact(null); toast('联系人已保存'); }
    catch (problem) { setFailure(problem instanceof Error ? problem.message : '联系人保存失败'); } finally { setBusy(false); }
  };
  const createSpec:ModuleEditorSpec={
    title:'新建客户',submitLabel:'创建客户档案',
    initialValues:{name:'',code:'',country:'',city:'',industry:'',owner:state?.settings.profileName||session.user?.displayName||'',grade:'',currency:state?.settings.companyProfile?.defaultCurrency||'USD',terms:'',incoterm:'',categories:'',since:'',creditLimit:0},
    fields:[
      {key:'name',label:'客户名称',required:true},{key:'code',label:'客户编码',hint:'留空时由工作区自动生成唯一编码'},
      {key:'country',label:'国家'},{key:'city',label:'城市'},{key:'industry',label:'行业'},
      {key:'owner',label:'客户经理',required:true},{key:'grade',label:'等级'},
      {key:'currency',label:'结算币种',type:'select',required:true,options:[...new Set(['USD','EUR','CNY','GBP','HKD',state?.settings.companyProfile?.defaultCurrency||'USD'])].map(value=>({value,label:value}))},
      {key:'terms',label:'付款条款'},{key:'incoterm',label:'贸易术语'},{key:'categories',label:'主要品类'},
      {key:'since',label:'合作起始日',type:'date'},{key:'creditLimit',label:'信用额度',type:'number',min:0,step:'0.01'},
    ],
    submit:async values=>{
      const value=(key:string)=>String(values[key]??'');
      const receipt=await run({type:'market.customer.create',payload:{input:{name:value('name'),code:value('code'),country:value('country'),city:value('city'),industry:value('industry'),owner:value('owner'),grade:value('grade'),currency:value('currency'),terms:value('terms'),incoterm:value('incoterm'),categories:value('categories'),since:value('since'),creditLimit:Number(values.creditLimit)}}});
      const id=receipt.result.customerId;
      if(typeof id!=='string'||!id)throw new Error('保存回执没有客户编号，请核对原操作结果');
      setCreating(false);go('crm',id,{customerId:id});
    },
  };
  const customerActions=<><Select aria-label="选择客户" value={customer?.id||''} disabled={loading||creating} onChange={event=>{if(event.target.value)go('crm',event.target.value,{customerId:event.target.value});}} options={[{value:'',label:'选择客户'},...(state?.customers||[]).map(c=>({value:c.id,label:c.name+' · '+c.code}))]}/>{canCreate&&<Button icon={Plus} disabled={loading} onClick={()=>setCreating(true)}>新建客户</Button>}</>;
  if(creating)return <ModuleEditorPage spec={createSpec} onClose={()=>setCreating(false)}/>;
  const emailValid = (email?:string):email is string => !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const customerEmail = contacts.find(item=>emailValid(item.email))?.email;
  const writeMail = (email?: string) => { if (!emailValid(email)) { setFailure('请先为联系人填写有效邮箱'); return; } window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(customer?.name ?? '')}`; };
  if (!customer) return <MistPage><PageHeader title="客户管理" description="选择客户继续业务，或建立新的客户档案。" actions={customerActions}/><EmptyState title={loading ? '正在读取客户' : requestedId ? '没有找到指定客户' : '还没有客户档案'} description={error || (requestedId ? '请选择当前工作区已有客户，或新建客户。' : '创建首个客户后，即可发起开发、报价与订单。')} action={<Button onClick={() => void refresh()}>重新读取</Button>} /></MistPage>;
  const currencyOrders = orders.filter(order => order.currency === customer.currency), currencyInvoices = invoices.filter(invoice => invoice.currency === customer.currency);
  const start = new Date(customer.since).getTime(), years = Number.isFinite(start) ? Math.max(0, (Date.now() - start) / (365.25 * 24 * 3600 * 1000)).toFixed(1) : '—';
  const contactList = <div className="mist-related">{contacts.length ? contacts.map(item => <button key={item.id} type="button" onClick={() => { setContact({ ...item }); setFailure(''); }}><Avatar name={item.name} tone={item.tone} /><span><b>{item.name}</b><small>{item.role} · {item.email || item.phone || '待补充联系方式'}</small></span></button>) : <EmptyState compact title="还没有联系人" action={<Button onClick={() => setContact({ name: '', role: '', email: '', phone: '' })}>添加联系人</Button>} />}</div>;
  return <MistPage>
    <IdentityHeader thumb={<span className="mist-thumb" data-size="lg" style={{ fontSize: 22, fontWeight: 300, color: 'var(--mist-accent-ink)', background: 'var(--mist-accent-tint)' }}>{customer.name.slice(0, 2)}</span>}
      meta={[`${customer.country} · ${customer.city}`, customer.industry, <Mono key="code">{customer.code}</Mono>]} title={customer.name}
      facts={[{ label: '客户经理', value: <><Avatar name={customer.owner} size="xs" />{customer.owner}</> }, { label: '等级', value: <Pill tone="accent">{customer.grade}</Pill> }]}
      actions={<>{customerActions}<Button icon={Mail} disabled={!customerEmail} title={customerEmail?'使用本机邮件应用撰写，Bambook不会发送邮件':'请先添加含有效邮箱的联系人'} onClick={() => writeMail(customerEmail)}>写邮件</Button><Button variant="primary" icon={Plus} onClick={() => go('development/new', undefined, { customerId: customer.id })}>新建开发案</Button><IconButton icon={Ellipsis} label="编辑客户资料" onClick={() => { setEdit({ ...customer }); setFailure(''); }} /></>} />
    {(error || failure) && <Banner tone="bad" title="操作尚未完成">{failure || error}</Banner>}
    <Tabs value={tab} onChange={setTab} options={[{ value: 'overview', label: '概览' }, { value: 'orders', label: '订单', count: orders.length }, { value: 'dev', label: '开发', count: devs.length }, { value: 'followups', label: '跟进', count: (state?.crm?.followUps ?? []).filter(row => row.customerId === customer.id).length }, { value: 'opportunities', label: '商机', count: (state?.crm?.opportunities ?? []).filter(row => row.customerId === customer.id && !['won', 'lost'].includes(row.stage)).length }, { value: 'mail', label: '邮件' }, { value: 'contacts', label: '联系人', count: contacts.length }, { value: 'files', label: '文件', count: files.length }]} />
    <StatGrid>
      <StatCard icon={BadgeDollarSign} label="今年下单" value={fmt(currencyOrders.filter(order => new Date(order.createdAt).getFullYear() === new Date().getFullYear()).reduce((sum, order) => sum + order.amount, 0), 2)} unit={customer.currency} foot={`共 ${orders.length} 个订单`} />
      <StatCard icon={ClipboardList} label="在途订单" value={active.length} unit="单" foot={active.map(order => order.code).join(' · ')} onClick={() => setTab('orders')} />
      <StatCard icon={Wallet} label="应收余额" value={fmt(currencyInvoices.reduce((sum, invoice) => sum + invoice.open, 0), 2)} unit={customer.currency} foot={`${invoices.length} 张发票`} onClick={() => go('payment-vouchers')} />
      <StatCard icon={CalendarClock} label="合作时长" value={years} unit="年" foot={`首单 ${customer.since}`} />
    </StatGrid>
    <div className="mist-detail" data-layout="main-rail">
      <div>
        {tab === 'overview' && <Banner tone="ai" icon={Sparkles} title="小竹洞察" actions={<Button size="sm" variant="ai" onClick={() => openAI(`仅根据以下已读取事实概括客户 ${customer.name}（${customer.code}）：${active.length} 个在途订单，${devs.length} 个开发案，待收 ${fmt(currencyInvoices.reduce((sum, invoice) => sum + invoice.open, 0), 2)} ${customer.currency}。说明缺失信息，不要推断未提供的对客沟通或承诺。`)}>展开</Button>}>{customer.name} 当前有 {active.length} 个在途订单、{devs.length} 个开发案；待收 {fmt(currencyInvoices.reduce((sum, invoice) => sum + invoice.open, 0), 2)} {customer.currency}。</Banner>}
        {(tab === 'overview' || tab === 'orders') && <Card><CardHeader title="订单" tools={<Button variant="quiet" size="sm" onClick={() => go('orders', undefined, { customerId: customer.id })}>全部订单</Button>} />
          <DataTable density={state?.settings.density} ariaLabel="客户订单" rows={orders} rowKey={order => order.id} onRowClick={order => go('orders/detail', order.id, { customerId: customer.id })} empty={<EmptyState compact title="还没有订单" action={<Button onClick={() => go('orders/new', undefined, { customerId: customer.id })}>新建订单</Button>} />} columns={[
            { key: 'id', header: '订单', width: 'minmax(180px,1.6fr)', render: order => <ObjectCell thumb={<Thumb src={IMG[order.img]} size="sm" />} name={<Mono>{order.code}</Mono>} meta={order.season} /> },
            { key: 'a', header: '金额', width: '120px', align: 'right', render: order => <b className="mist-cell-strong mist-num">{fmt(order.amount, 2)} <span className="mist-muted">{order.currency}</span></b> },
            { key: 'd', header: '交期', width: '64px', hideOnMobile: true, render: order => order.due },
            { key: 's', header: '状态', width: '90px', render: order => <Pill tone={order.tone}>{order.state}</Pill> },
          ]} /></Card>}
        {(tab === 'overview' || tab === 'dev') && <Card><CardHeader title="进行中的开发" sub={`${devs.length} 个开发案`} tools={<Button variant="quiet" size="sm" onClick={() => go('development', undefined, { customerId: customer.id })}>开发与寻样</Button>} />
          <DataTable density={state?.settings.density} ariaLabel="客户开发案" rows={devs} rowKey={dev => dev.id} onRowClick={dev => go('development/detail', dev.id, { customerId: customer.id, versionId: dev.currentVersionId ?? undefined })} empty={<EmptyState compact title="还没有开发案" />} columns={[
            { key: 'n', header: '开发对象', width: 'minmax(200px,2fr)', render: dev => <ObjectCell thumb={<Thumb src={IMG[dev.img]} size="sm" />} name={dev.name} meta={<Mono>{dev.code}</Mono>} /> },
            { key: 'st', header: '阶段', width: '120px', hideOnMobile: true, render: dev => <><StageProgress total={5} current={dev.stage} /><span className="mist-cell-sub" style={{ marginTop: 6 }}>{STAGES[dev.stage]}</span></> },
            { key: 's', header: '状态', width: '118px', render: dev => <Pill tone={dev.tone}>{dev.state}</Pill> },
          ]} /></Card>}
        {state?.crm && (tab === 'overview' || tab === 'opportunities') && <OpportunityPanel customer={customer} state={state} can={canCreate} />}
        {state?.crm && tab === 'followups' && <FollowUpPanel customer={customer} state={state} can={canCreate} />}
        {state && tab === 'mail' && <CustomerMailPanel customer={customer} state={state} />}
        {tab === 'contacts' && <Card><CardHeader title="联系人" tools={<IconButton icon={Plus} label="添加联系人" onClick={() => { setContact({ name: '', role: '', email: '', phone: '' }); setFailure(''); }} />} />{contactList}</Card>}
        {tab === 'files' && <Card><CardHeader title="客户关联文件" /><DataTable density={state?.settings.density} rows={files} rowKey={file => file.id} onRowClick={file => { void downloadFile(file).catch(problem => setFailure(problem instanceof Error ? problem.message : '下载失败')); }} empty={<EmptyState compact title="还没有关联文件" description="开发案及沟通记录的附件会汇总到这里。" />} columns={[
          { key: 'name', header: '文件', render: file => file.name }, { key: 'size', header: '大小', render: file => `${Math.ceil(file.size / 1024)} KB` }, { key: 'download', header: '下载', render: () => <Download className="mist-icon" /> },
        ]} /></Card>}
      </div>
      <div className="mist-detail-rail">
        <Card><CardHeader title="档案" /><KeyValue items={[{ label: '结算币种', value: customer.currency }, { label: '付款条款', value: customer.terms }, { label: '贸易术语', value: customer.incoterm }, { label: '主要品类', value: customer.categories }, { label: '信用额度', value: `${fmt(customer.creditLimit, 2)} ${customer.currency}` }]} /></Card>
        {tab !== 'contacts' && <Card><CardHeader title="联系人" tools={<IconButton icon={Plus} label="添加联系人" size="sm" onClick={() => { setContact({ name: '', role: '', email: '', phone: '' }); setFailure(''); }} />} />{contactList}</Card>}
        {state?.crm && tab !== 'followups' && <FollowUpPanel customer={customer} state={state} can={canCreate} compact />}
        <Card><CardHeader title="沟通动态" tools={<IconButton icon={TrendingUp} label="业务动态统计" size="sm" onClick={() => setFrequency(true)} />} /><Timeline events={events.map(event => ({ who: event.actor, when: new Date(event.at).toLocaleString('zh-CN'), text: event.text }))} />{!events.length && <EmptyState compact title="暂无动态" />}</Card>
      </div>
    </div>
    <Drawer open={!!contact} onClose={() => { if (!busy) setContact(null); }} title={contact?.id ? '编辑联系人' : '添加联系人'} footer={<><Button disabled={busy} onClick={() => setContact(null)}>取消</Button>{contact?.id && <Button variant="danger" disabled={busy} onClick={() => setDeleteContact(true)}>删除</Button>}<Button variant="primary" loading={busy} onClick={() => void saveContact()}>保存</Button></>}>
      {failure && <Banner tone="bad" title="联系人未保存">{failure}</Banner>}<FormGrid>{(['name', 'role', 'email', 'phone'] as const).map((key, index) => <Field key={key} label={['姓名', '职责', '邮箱', '电话'][index]} required={key === 'name'}><TextInput type={key === 'email' ? 'email' : 'text'} value={contact?.[key] ?? ''} onChange={event => setContact(value => ({ ...value, [key]: event.target.value }))} /></Field>)}</FormGrid>
      {contact?.email && <Button icon={Mail} disabled={!emailValid(contact.email)} title="使用本机邮件应用撰写，Bambook不会发送邮件" onClick={() => writeMail(contact.email)}>写邮件</Button>}
    </Drawer>
    <Dialog open={deleteContact} onClose={() => { if (!busy) setDeleteContact(false); }} title="删除联系人？" description={contact?.name} footer={<><Button onClick={() => setDeleteContact(false)}>取消</Button><Button variant="danger" loading={busy} onClick={async () => { if (!contact?.id || busy) return; setBusy(true); try { await run({ type: 'market.contact.delete', payload: { kind:'customer',parentId:customer.id,id: contact.id } }); setDeleteContact(false); setContact(null); toast('联系人已删除'); } catch (problem) { setFailure(problem instanceof Error ? problem.message : '删除失败'); } finally { setBusy(false); } }}>删除联系人</Button></>} />
    <Drawer open={!!edit} onClose={() => { if (!busy) setEdit(null); }} title="编辑客户资料" size="lg" footer={<Button variant="primary" loading={busy} onClick={async () => { if (!edit || busy) return; setBusy(true); setFailure(''); const { id, ...patch } = edit; try { await run({ type: 'market.customer.update', payload: { id, patch } }); setEdit(null); toast('客户资料已保存'); } catch (problem) { setFailure(problem instanceof Error ? problem.message : '资料保存失败'); } finally { setBusy(false); } }}>保存资料</Button>}>
      {failure && <Banner tone="bad" title="资料未保存">{failure}</Banner>}<FormGrid>{(['name', 'country', 'city', 'industry', 'owner', 'grade', 'terms', 'incoterm', 'categories', 'since'] as const).map((key, index) => <Field key={key} label={['客户名称', '国家', '城市', '行业', '客户经理', '等级', '付款条款', '贸易术语', '主要品类', '合作起始日'][index]}><TextInput type={key === 'since' ? 'date' : 'text'} value={edit?.[key] ?? ''} onChange={event => setEdit(value => value ? { ...value, [key]: event.target.value } : value)} /></Field>)}<Field label="结算币种"><Select value={edit?.currency ?? 'USD'} onChange={event => setEdit(value => value ? { ...value, currency: event.target.value } : value)} options={[...new Set(['USD', 'EUR', 'CNY', 'GBP', 'HKD',edit?.currency||'USD'])]} /></Field><Field label="信用额度"><TextInput type="number" min={0} value={edit?.creditLimit ?? 0} onChange={event => setEdit(value => value ? { ...value, creditLimit: Number(event.target.value) } : value)} /></Field></FormGrid>
    </Drawer>
    <Dialog open={frequency} onClose={() => setFrequency(false)} title="业务动态统计"><KeyValue items={[{ label: '全部业务动态', value: events.length }, { label: '最近 30 天业务动态', value: events.filter(event => Date.now() - new Date(event.at).getTime() <= 30 * 86400000).length }, { label: '最近业务动态', value: events[0] ? new Date(events[0].at).toLocaleString('zh-CN') : '暂无记录' }]} /></Dialog>
  </MistPage>;
}
