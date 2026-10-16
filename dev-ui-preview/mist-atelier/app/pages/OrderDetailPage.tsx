/** T5 单据详情：沿用原 Mist 结构，全部内容属于当前订单。 */
import React from 'react';
import { BadgeCheck, Factory, FileText, Handshake, Package, Pencil, Send, Ship, Wallet } from 'lucide-react';
import { BackLink, Banner, Button, Card, CardHeader, Checklist, DataTable, Dialog, Donut, Drawer, EmptyState, Field, FlowSteps, FormGrid, KeyValue, Meter, MistPage, Mono, ObjectCell, PageHeader, Pill, Select, SummaryBar, TextArea, TextInput, Thumb, UploadZone, useToast } from '../../../../components/mist';
import type { MistOrder, MistOrderLine } from '../../../../server/src/shared/mistWorkspace';
import { IMG, fmt } from '../data';
import { useNav } from '../nav';
import { useMistWorkspace } from '../runtime/workspace';
import { downloadMistCsv, mistDate } from './OrderListPage';
import { formatOrderQuantity, orderAmounts, sumOrderMoney } from './orderAmounts';
import {createOrderGovernance,type OrderGovernanceInput,type OrderGovernanceFields,type OrderGovernanceLine} from '../../../../server/src/shared/mistOrderGovernance';
import { OrderLineFulfillment } from './OrderLineFulfillment';
import { OrderLineSourceValue } from './orderLineSource';
import { OrderBreakdownEditor } from './OrderBreakdownEditor';
import { OrderChangeImpactList } from './OrderChangeImpactList';
import { OrderTerminationBanner, OrderTerminationButton, orderLocked } from './OrderTermination';
import { orderLineFacts } from '../../../../server/src/shared/mistOrderChangeImpact';
import { toleranceText } from '../../../../server/src/shared/mistOrderClosure';
import { breakdownDiff, breakdownShort, breakdownTotal, normalizeOrderBreakdown, type OrderLineBreakdown } from '../../../../server/src/shared/mistOrderBreakdown';
import {orderFundingCoveredAmount} from '../../../../server/src/shared/mistOrderFunding';

function OrderContractDialog({order,open,onClose}:{order:MistOrder&{governance?:OrderGovernanceFields};open:boolean;onClose:()=>void}){
 const w=useMistWorkspace(),toast=useToast();const [contract,setContract]=React.useState<OrderGovernanceInput>(()=>createOrderGovernance({id:()=>'',now:'',actorName:''}).contract),[reason,setReason]=React.useState(''),[failure,setFailure]=React.useState(''),[busy,setBusy]=React.useState(false);
 const active=React.useRef(true),lock=React.useRef(false);React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 React.useEffect(()=>{if(open){setContract(structuredClone(order.governance?.changeDraft?.contract||order.governance?.contract||createOrderGovernance({id:()=>'',now:'',actorName:''}).contract));setReason(order.governance?.changeDraft?.reason||'');setFailure('');}},[open,order.id]);
 const disabled=busy||w.saving||!!w.pending||order.governance?.status==='pending'||order.governance?.changeDraft?.status==='pending';
 const save=async()=>{if(lock.current||disabled)return;lock.current=true;setBusy(true);setFailure('');try{await w.run({type:'order.governance.saveDraft',payload:{orderId:order.id,input:contract,...(order.governance?.changeDraft?{lines:order.governance.changeDraft.lines,orderPatch:order.governance.changeDraft.orderPatch}:{}),...(order.governance?.status==='approved'?{reason}: {})}});if(active.current){toast(order.governance?.status==='approved'?'变更草稿已保存，原批准内容继续生效':'合同资料已保存');onClose();}}catch(e){if(active.current)setFailure(e instanceof Error?e.message:'合同资料未保存');}finally{lock.current=false;if(active.current)setBusy(false);}};
 const upload=async(files:File[])=>{if(lock.current||disabled)return;lock.current=true;setBusy(true);setFailure('');try{for(const file of files){const stored=await w.uploadFile(file);if(active.current)setContract(c=>({...c,confirmationFileIds:[...new Set([...c.confirmationFileIds,stored.id])]}));}}catch(e){if(active.current)setFailure(e instanceof Error?e.message:'原件上传未完成');}finally{lock.current=false;if(active.current)setBusy(false);}};
 return <Dialog open={open} onClose={()=>{if(!busy)onClose();}} title={order.governance?.status==='approved'?'拟议合同变更':'合同与审批资料'} width={820} footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={disabled} onClick={()=>void save()}>{order.governance?.status==='approved'?'保存变更草稿':'保存合同资料'}</Button></>}>
  {failure&&<Banner tone="bad" title="资料未保存">{failure}</Banner>}<FormGrid>
   <Field label="订单用途"><Select value={contract.kind} onChange={e=>setContract(c=>({...c,kind:e.target.value as OrderGovernanceInput['kind']}))} options={[{value:'external',label:'外部客户订单'},{value:'internal',label:'内部用途订单'}]}/></Field>
   {contract.kind==='external'?<Field label="PO / 合同号"><TextInput value={contract.poNumber} onChange={e=>setContract(c=>({...c,poNumber:e.target.value}))}/></Field>:<><Field label="内部用途"><TextInput value={contract.internalPurpose} onChange={e=>setContract(c=>({...c,internalPurpose:e.target.value}))}/></Field><Field label="接收团队 / 负责人"><TextInput value={contract.receiver} onChange={e=>setContract(c=>({...c,receiver:e.target.value}))}/></Field></>}
   <Field label="付款方式"><Select value={contract.paymentMethod} onChange={e=>setContract(c=>({...c,paymentMethod:e.target.value as OrderGovernanceInput['paymentMethod']}))} options={['TT','LC','OA','OTHER']}/></Field><Field label="定金比例（%）" hint="空值为尚未配置，不能当作已收足"><TextInput aria-label="定金比例（%）" type="number" min="0" max="100" value={contract.depositPercent??''} onChange={e=>setContract(c=>({...c,depositPercent:e.target.value===''?null:Number(e.target.value)}))}/></Field>
   <Field label="贸易术语"><TextInput value={contract.incoterm} onChange={e=>setContract(c=>({...c,incoterm:e.target.value}))}/></Field><Field label="指定地点 / 港口"><TextInput value={contract.deliveryPlace} onChange={e=>setContract(c=>({...c,deliveryPlace:e.target.value}))}/></Field><Field label="溢装上限 %" hint="0–10；未填按「未约定，按足量」"><TextInput aria-label="溢装上限 %" type="number" min="0" max="10" step="0.1" value={contract.overPercent??''} onChange={e=>setContract(c=>({...c,overPercent:e.target.value===''?null:Number(e.target.value)}))}/></Field><Field label="短装下限 %" hint="0–10，可与溢装不同"><TextInput aria-label="短装下限 %" type="number" min="0" max="10" step="0.1" value={contract.shortPercent??''} onChange={e=>setContract(c=>({...c,shortPercent:e.target.value===''?null:Number(e.target.value)}))}/></Field><Field label="付款条款原文" full><TextArea value={contract.paymentNote} onChange={e=>setContract(c=>({...c,paymentNote:e.target.value}))}/></Field>
   {order.governance?.status==='approved'&&<Field label="变更原因" required full><TextArea value={reason} onChange={e=>setReason(e.target.value)}/></Field>}
  </FormGrid><div className="mist-section"><UploadZone title="上传客户 PO / 书面确认依据" onFiles={files=>void upload(files)}/>{contract.confirmationFileIds.map(id=>{const file=w.state?.files.find(f=>f.id===id);return <div className="mist-row" key={id}><span>{file?.name||'附件不可用'}</span><span className="mist-spacer"/>{file&&<Button variant="quiet" onClick={()=>void w.downloadFile(file).catch(e=>setFailure(e.message))}>下载</Button>}<Button variant="quiet" disabled={disabled} onClick={()=>setContract(c=>({...c,confirmationFileIds:c.confirmationFileIds.filter(f=>f!==id)}))}>移除</Button></div>;})}</div>
 </Dialog>;
}

function editableLineSnapshot(line:MistOrderLine):OrderGovernanceLine{
 const source=line as MistOrderLine&Partial<OrderGovernanceLine>;
 return{id:line.id,name:line.name,style:line.style,img:line.img,qty:line.qty,unit:line.unit,price:line.price,...(source.sourceProductId?{sourceProductId:source.sourceProductId}:{}),...(source.sourceDevId?{sourceDevId:source.sourceDevId}:{}),...(source.sourceVersionId?{sourceVersionId:source.sourceVersionId}:{}),...(source.breakdown?{breakdown:structuredClone(source.breakdown)}:{})};
}
function OrderLineDialog({order,line,lines,onClose}:{order:MistOrder;line:MistOrderLine|null;lines:MistOrderLine[];onClose:()=>void}){
 const workspace=useMistWorkspace(),toast=useToast();
 const [values,setValues]=React.useState({quantity:'',price:'',reason:''}),[breakdown,setBreakdown]=React.useState<OrderLineBreakdown|undefined>(),[failure,setFailure]=React.useState(''),[busy,setBusy]=React.useState(false);
 const live=React.useRef(true),lock=React.useRef(false),generation=React.useRef(0);
 React.useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;};},[]);
 React.useEffect(()=>{generation.current++;const current=order.governance?.changeDraft?.lines.find(item=>item.id===line?.id)||line;setValues({quantity:current?String(current.qty):'',price:current?String(current.price):'',reason:order.governance?.changeDraft?.reason||''});setBreakdown((current as Partial<OrderGovernanceLine>|null)?.breakdown?structuredClone((current as Partial<OrderGovernanceLine>).breakdown):undefined);setFailure('');setBusy(false);lock.current=false;},[order.id,line?.id]);
 const approved=order.governance?.status==='approved';
 const facts=line&&workspace.state?orderLineFacts(workspace.state,line.id):null,floor=approved&&facts&&facts.floor>0?facts:null;
 const disabled=busy||workspace.saving||!!workspace.pending||!!workspace.pendingCreate||order.governance?.status==='pending'||order.governance?.changeDraft?.status==='pending';
 const save=async()=>{
  if(!line||disabled||lock.current)return;
  if(breakdown){try{normalizeOrderBreakdown(order.type,breakdown);}catch(error){setFailure(error instanceof Error?error.message:'分色分码填写有误');return;}}
  const quantity=breakdown?breakdownTotal(breakdown):Number(values.quantity),price=Number(values.price);
  if((!breakdown&&!values.quantity.trim())||!Number.isFinite(quantity)||quantity<=0||!values.price.trim()||!Number.isFinite(price)||price<0){setFailure('请填写大于零的订单数量及有效销售单价');return;}
  const proposal=order.governance?.changeDraft,baseLines=proposal?.lines||lines.map(editableLineSnapshot);
  if(!baseLines.some(item=>item.id===line.id)){setFailure('当前条目已不可用，请返回订单重新核对');return;}
  const ticket=generation.current;lock.current=true;setBusy(true);setFailure('');
  try{
   await workspace.run({type:'order.governance.saveDraft',payload:{orderId:order.id,input:proposal?.contract||order.governance?.contract||createOrderGovernance({id:()=>'',now:'',actorName:''}).contract,lines:baseLines.map(item=>{if(item.id!==line.id)return item;const {breakdown:_old,...rest}=item;return {...rest,qty:quantity,price,...(breakdown?{breakdown}:{})};}),...(proposal?{orderPatch:proposal.orderPatch}:{}),...(approved?{reason:values.reason}:{})}});
   if(live.current&&ticket===generation.current){toast(approved?'条目变更草稿已保存，原批准内容继续生效':'订单条目已保存');onClose();}
  }catch(error){if(live.current&&ticket===generation.current)setFailure(error instanceof Error?error.message:'条目未保存，请重试');}
  finally{if(live.current&&ticket===generation.current){lock.current=false;setBusy(false);}}
 };
 return <Dialog open={!!line} onClose={()=>{if(!busy)onClose();}} title="编辑订单条目" description={line?`${order.code} · ${line.style} · ${line.name}`:undefined} footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled} loading={busy} onClick={()=>void save()}>保存条目</Button></>}>
  {failure&&<Banner tone="bad" title="条目未保存">{failure}</Banner>}
  {approved&&<p className="mist-note">保存为待审批变更；原批准数量与单价继续生效。</p>}
  <FormGrid><Field label="订单数量" required hint={<>{breakdown?'由分色分码合计':line?.unit}{floor&&<span data-line-floor> · 不得低于 {formatOrderQuantity(floor.floor)} {line?.unit}（已完工 {formatOrderQuantity(floor.completed)} · 已排出运 {formatOrderQuantity(floor.shipped)}）</span>}</>}><TextInput aria-label="订单数量" type="number" min="0" step="any" value={breakdown?String(breakdownTotal(breakdown)):values.quantity} disabled={disabled||!!breakdown} onChange={event=>setValues(current=>({...current,quantity:event.target.value}))}/></Field><Field label="销售单价" required hint={order.currency}><TextInput aria-label="销售单价" type="number" min="0" step="0.01" value={values.price} disabled={disabled} onChange={event=>setValues(current=>({...current,price:event.target.value}))}/></Field><div className="mist-field" role="group" aria-label="分色分码" style={{gridColumn:'1 / -1'}}><span className="mist-field-label">分色分码</span><OrderBreakdownEditor type={order.type} unit={line?.unit||''} value={breakdown} disabled={disabled} onChange={setBreakdown}/></div>{approved&&<Field label="变更原因" required full><TextArea aria-label="变更原因" value={values.reason} disabled={disabled} onChange={event=>setValues(current=>({...current,reason:event.target.value}))}/></Field>}</FormGrid>
 </Dialog>;
}

type OrderChangeRow={id:string;label:string;before:string;after:string};
function orderChangeRows(governance:OrderGovernanceFields|undefined,files:ReadonlyArray<{id:string;name:string}>):OrderChangeRow[]{
 const before=governance?.approvedSnapshot,after=governance?.changeDraft;if(!before||!after)return[];
 const rows:OrderChangeRow[]=[];
 const add=(id:string,label:string,oldValue:string,newValue:string,changed=oldValue!==newValue)=>{if(changed)rows.push({id,label,before:oldValue||'—',after:newValue||'—'});};
 const price=(value:number,currency:string)=>Number.isFinite(value)?`${fmt(value,2)} ${currency}`:'无法核对';
 for(const id of new Set([...before.lines.map(line=>line.id),...after.lines.map(line=>line.id)])){
  const oldLine=before.lines.find(line=>line.id===id),newLine=after.lines.find(line=>line.id===id),label=(newLine||oldLine)!.style||(newLine||oldLine)!.name;
  if(!oldLine||!newLine){const describe=(line:OrderGovernanceLine|undefined,currency:string)=>line?`${line.name} · ${formatOrderQuantity(line.qty)} ${line.unit} × ${price(line.price,currency)}`:'—';add(id,label,describe(oldLine,before.currency),describe(newLine,after.orderPatch.currency));continue;}
  add(id+'-quantity',label+' · 数量',`${formatOrderQuantity(oldLine.qty)} ${oldLine.unit}`,`${formatOrderQuantity(newLine.qty)} ${newLine.unit}`,oldLine.qty!==newLine.qty||oldLine.unit!==newLine.unit);
  for(const row of breakdownDiff(oldLine.breakdown,newLine.breakdown))add(id+'-cell-'+row.key,label+' · '+row.label,row.before,row.after,true);
  add(id+'-price',label+' · 单价',price(oldLine.price,before.currency),price(newLine.price,after.orderPatch.currency),oldLine.price!==newLine.price||before.currency!==after.orderPatch.currency);
 }
 const oldTotal=orderAmounts(before.lines),newTotal=orderAmounts(after.lines);
 add('total','订单总额',oldTotal.total===null?'无法核对':price(oldTotal.total,before.currency),newTotal.total===null?'无法核对':price(newTotal.total,after.orderPatch.currency));
 const purpose=(kind:OrderGovernanceInput['kind'])=>kind==='internal'?'内部用途订单':'外部客户订单';
 add('kind','订单用途',purpose(before.contract.kind),purpose(after.contract.kind));
 add('internal-purpose','内部用途',before.contract.internalPurpose,after.contract.internalPurpose);
 add('receiver','接收团队 / 负责人',before.contract.receiver,after.contract.receiver);
 add('po','PO / 合同号',before.contract.poNumber,after.contract.poNumber);
 const oldFiles=before.contract.confirmationFileIds,newFiles=after.contract.confirmationFileIds,fileNames=(ids:string[])=>ids.map(id=>files.find(file=>file.id===id)?.name||'附件不可用').join('、');
 add('files','合同附件',fileNames(oldFiles),fileNames(newFiles),[...oldFiles].sort().join('|')!==[...newFiles].sort().join('|'));
 add('payment-method','付款方式',before.contract.paymentMethod,after.contract.paymentMethod);
 add('deposit','定金比例',before.contract.depositPercent===null?'未配置':before.contract.depositPercent+'%',after.contract.depositPercent===null?'未配置':after.contract.depositPercent+'%');
 add('payment-note','合同付款条款',before.contract.paymentNote,after.contract.paymentNote);
 add('incoterm','贸易术语',before.contract.incoterm,after.contract.incoterm);
 add('place','指定地点',before.contract.deliveryPlace,after.contract.deliveryPlace);
 add('tolerance','溢短装',toleranceText(before.contract),toleranceText(after.contract));
 add('due','交期',before.due,after.orderPatch.due);add('season','季节',before.season,after.orderPatch.season);
 return rows;
}

export function OrderDetailPage() {
  const { go, route } = useNav(), toast = useToast();
  const workspace=useMistWorkspace(),{ state, loading, error, run, refresh, saving, pending, recover } = workspace;
  const scope=`${workspace.workspace?.id||''}:${route.id||''}`,activeScope=React.useRef(scope);activeScope.current=scope;
  const alive=React.useRef(true);React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const operation=React.useRef(false);
  const order = state?.orders.find(item => item.id === route.id);
  const lines = (state?.orderLines ?? []).filter(line => line.orderId === order?.id);
  const governance=(order as (MistOrder&{governance?:OrderGovernanceFields})|undefined)?.governance;
  const changeRows=orderChangeRows(governance,state?.files||[]);
  const approved=governance?.status==='approved';
  const locked=!!order&&orderLocked(order as MistOrder&{governance?:OrderGovernanceFields});
  const approvalPending=governance?.status==='pending'||governance?.changeDraft?.status==='pending'||locked;
  const terminated=governance?.status==='void'||governance?.status==='cancelled';
  const approvalLabel=governance?.status==='void'?'已作废':governance?.status==='cancelled'?'已取消':governance?.cancellation?.status==='pending'?'取消审批中':approved?'已批准':approvalPending?'待审批':governance?.status==='rejected'?'已退回':'草稿待补齐';
  const amounts = orderAmounts(lines);
  const lineAmounts = new Map(lines.map((line, index) => [line.id, amounts.items[index].amount]));
  const amountLabel = (amount: number | null | undefined) => amount == null ? '—' : fmt(amount, 2);
  const [lineId, setLineId] = React.useState<string | null>(route.orderLineId ?? null);
  const [lineEditorId,setLineEditorId]=React.useState<string|null>(null);
  const [documentOpen, setDocumentOpen] = React.useState(false), [editOpen, setEditOpen] = React.useState(false), [handoffOpen, setHandoffOpen] = React.useState(false),[contractOpen,setContractOpen]=React.useState(false),[reviewRoundId,setReviewRoundId]=React.useState<string|null>(null);
  const selectedRound=governance?.rounds.find(round=>round.id===reviewRoundId);
  const [edit, setEdit] = React.useState({ season: '', due: '', owner: '',reason:'' }), [note, setNote] = React.useState('');
  const [working, setWorking] = React.useState(false), [failure, setFailure] = React.useState('');
  const busy=working||loading||saving||!!pending;
  React.useEffect(() => { setLineId(route.orderLineId ?? null); setFailure(''); }, [route.id, route.orderLineId]);
  React.useEffect(()=>{setLineEditorId(null);},[scope,lineId]);
  React.useEffect(()=>{operation.current=false;setWorking(false);setDocumentOpen(false);setEditOpen(false);setHandoffOpen(false);setNote('');setFailure('');},[scope]);
  const selectedLine = lines.find(line => line.id === lineId);
  const productions = (state?.productions ?? []).filter(item => item.orderId === order?.id);
  const invoices = (state?.invoices ?? []).filter(item => item.orderId === order?.id);
  const sameCurrencyReceipts=(state?.receipts??[]).filter(receipt=>receipt.currency===order?.currency),receiptIds=new Set(sameCurrencyReceipts.map(receipt=>receipt.id));
  const sameCurrencyInvoices=invoices.filter(invoice=>invoice.currency===order?.currency);
  const orderAllocations=(state?.allocations??[]).filter(allocation=>allocation.currency===order?.currency&&receiptIds.has(allocation.receiptId)&&sameCurrencyInvoices.some(invoice=>invoice.id===allocation.invoiceId));
  const reconciled=sumOrderMoney(orderAllocations.map(allocation=>allocation.amount));
  const received=(()=>{
    if(!state||!order)return sumOrderMoney([]);
    try{return sumOrderMoney([orderFundingCoveredAmount({...state,receipts:sameCurrencyReceipts,invoices:sameCurrencyInvoices,allocations:orderAllocations,orderFunding:{assignments:(state.orderFunding?.assignments??[]).filter(row=>row.currency===order.currency&&row.customerId===order.customerId)}},order.id)]);}
    catch(problem){return{total:null,cents:null,error:problem instanceof Error?problem.message:'已确认到账金额无效'};}
  })();
  const purchases=(state?.fulfillment.purchases||[]).filter(purchase=>purchase.orderId===order?.id);
  const shipments=(state?.fulfillment.shipments||[]).filter(shipment=>shipment.lines.some(line=>line.orderId===order?.id));
  const productionQc=(productionId:string)=>{const tasks=(state?.fulfillment.qcTasks||[]).filter(task=>task.kind==='production'&&task.source.kind==='orderLine'&&task.source.productionId===productionId);return tasks.length>0&&tasks.every(task=>{const report=state?.fulfillment.qcReports.find(report=>report.id===task.reportIds.at(-1));return task.state==='reported'&&!!report&&report.result!=='reject';});};
  const lineProgress=(line:MistOrderLine)=>{const jobs=productions.filter(job=>job.lineId===line.id),total=jobs.reduce((sum,job)=>sum+job.qty,0);return total?{made:Math.round(jobs.reduce((sum,job)=>sum+job.qty*job.pct,0)/total),qc:Math.round(jobs.reduce((sum,job)=>sum+(productionQc(job.id)?job.qty*100:0),0)/total)}:{made:0,qc:0};};
  const remaining = amounts.cents === null || received.cents === null ? null : Math.max(0, amounts.cents - received.cents) / 100;
  const quantities = [...new Set(lines.map(line => line.unit))].map(unit => ({ unit, quantity: lines.filter(line => line.unit === unit).reduce((sum, line) => sum + line.qty, 0) }));
  const act = async (command: Parameters<typeof run>[0], onSuccess?: () => void) => {
    if (busy||operation.current) return; const bound=scope;operation.current=true;setWorking(true);setFailure('');
    try { await run(command);if(alive.current&&activeScope.current===bound)onSuccess?.(); } catch (problem) { if(alive.current&&activeScope.current===bound)setFailure(problem instanceof Error ? problem.message : '保存失败，请重试'); } finally { if(alive.current&&activeScope.current===bound){operation.current=false;setWorking(false);} }
  };
  const columns = [
    { key: 'n', header: '款式', width: 'minmax(170px,1.6fr)', render: (line: MistOrderLine) => <ObjectCell thumb={<Thumb src={IMG[line.img]} />} name={line.name} meta={<><Mono>{line.style}</Mono> · <span data-line-breakdown={line.id}>{breakdownShort((line as MistOrderLine&{breakdown?:OrderLineBreakdown}).breakdown)}</span></>} /> },
    { key: 'q', header: '数量', width: '80px', align: 'right' as const, hideOnMobile: true, render: (line: MistOrderLine) => <span className="mist-num">{formatOrderQuantity(line.qty)} {line.unit}</span> },
    { key: 'p', header: `单价 ${order?.currency ?? ''}`, width: '76px', align: 'right' as const, hideOnMobile: true, render: (line: MistOrderLine) => <span className="mist-num">{amountLabel(lineAmounts.get(line.id) == null ? null : line.price)}</span> },
    { key: 'g', header: '生产进度', width: 'minmax(110px,1.2fr)', hideOnMobile: true, render: (line: MistOrderLine) => {const progress=lineProgress(line);return <Meter segments={[{ value: progress.qc, tone: 'ok' as const }, { value: Math.max(0, progress.made - progress.qc) }]} caption={`${progress.made}% · 已 QC ${progress.qc}%`} />;} },
    { key: 's', header: '小计', width: '90px', align: 'right' as const, render: (line: MistOrderLine) => <b className="mist-cell-strong mist-num">{amountLabel(lineAmounts.get(line.id))}</b> },
  ];
  if (!order) return <MistPage><BackLink onClick={() => go('orders')}>订单管理</BackLink><Banner tone={error ? 'bad' : 'neutral'} title={loading ? '正在读取订单' : '没有找到此订单'} actions={<Button onClick={() => void refresh()}>重新读取</Button>}>{error || (loading ? '请稍候' : '订单可能已移除，请返回订单列表。')}</Banner></MistPage>;
  return <MistPage>
    <BackLink onClick={() => go('orders', undefined, { customerId: route.customerId,section:order.type })}>订单管理</BackLink>
    <PageHeader eyebrow="订单履约 · 订单" title={order.code} description={`${order.customer} · ${order.season} · ${lines.length} 个条目 · 负责人 ${order.owner}`}
      actions={<><Button icon={Pencil} disabled={busy||approvalPending} onClick={() => { setEdit({ season: governance?.changeDraft?.orderPatch.season??order.season, due: governance?.changeDraft?.orderPatch.due??order.due, owner: order.owner,reason:governance?.changeDraft?.reason||'' }); setEditOpen(true); setFailure(''); }}>编辑</Button><Button icon={FileText} onClick={() => setDocumentOpen(true)}>装箱单草稿</Button><Button disabled={busy||approvalPending} onClick={()=>setContractOpen(true)}>合同与审批资料</Button>{locked?null:!approved||governance?.changeDraft?<Button variant="primary" disabled={busy||approvalPending} onClick={()=>void act({type:'order.governance.submit',payload:{orderId:order.id}},()=>toast('已提交订单主单审批'))}>{approvalPending?'待审批':governance?.changeDraft?'提交变更审批':'提交主单审批'}</Button>:<Button variant="primary" icon={Send} disabled={busy || !!order.handoffAt} onClick={() => { setHandoffOpen(true); setFailure(''); }}>{order.handoffAt ? '已交接后勤' : '交接后勤'}</Button>}{order.handoffAt&&<Button variant="secondary" icon={Ship} onClick={()=>go('shipments',undefined,{section:'order:'+order.id,customerId:order.customerId})}>出运准备</Button>}{state&&<OrderTerminationButton state={state} order={order as MistOrder&{governance?:OrderGovernanceFields}} busy={busy} run={run} go={go}/>}</>} />
    <OrderTerminationBanner order={order as MistOrder&{governance?:OrderGovernanceFields}}/>
    {(error || failure) && <Banner tone="bad" title="操作尚未完成">{failure || error}</Banner>}
    {pending&&!saving&&<Banner tone="warn" title="上一次操作结果待核对" actions={<Button disabled={working||saving} onClick={()=>void recover().catch(problem=>setFailure(problem instanceof Error?problem.message:'原请求核对失败'))}>核对原操作结果</Button>}/>}
    {amounts.error && <Banner tone="bad" title="订单金额无法核对">{amounts.error}，请核对订单条目的数量与单价。</Banner>}
    {(received.error||reconciled.error) && <Banner tone="bad" title="收款金额无法核对">{received.error||reconciled.error}，请核对到账归属与收款核销记录。</Banner>}
    <SummaryBar items={[
      { label: '订单金额', value: amountLabel(amounts.total), unit: order.currency, hint: order.customer },
      { label: '总数量', value: quantities.length === 1 ? formatOrderQuantity(quantities[0].quantity) : quantities.map(item => `${formatOrderQuantity(item.quantity)} ${item.unit}`).join(' · '), unit: quantities.length === 1 ? quantities[0].unit : undefined, hint: `${lines.length} 个条目` },
      { label: '交期', value: order.due, hint: order.handoffAt ? `交接于 ${new Date(order.handoffAt).toLocaleString('zh-CN')}` : '待交接后勤' },
      { label: '整体进度', value: order.progress, unit: '%', hint: order.state, hintTone: order.tone }]} />
    <Card className="mist-section"><CardHeader title="合同与主单审批" tools={<Pill tone={approved?'ok':approvalPending?'warn':'neutral'}>{approvalLabel}</Pill>}/><KeyValue items={[{label:'PO / 内部用途',value:governance?.contract.poNumber||governance?.contract.internalPurpose||'待填写'},{label:'付款方式',value:governance?.contract.paymentMethod||'待填写'},{label:'定金比例',value:governance?.contract.depositPercent==null?'未配置，不代表门禁已通过':governance.contract.depositPercent+'%'},{label:'合同付款条款',value:governance?.contract.paymentNote||'待填写'},{label:'贸易术语 / 地点',value:(governance?.contract.incoterm||'待填写')+' / '+(governance?.contract.deliveryPlace||'待填写')},{label:'溢短装',value:toleranceText(governance?.contract)}]}/>{!approved&&!terminated&&<Banner tone="warn" title="批准前不能采购或履约">先补齐合同依据，再提交整张订单及全部条目的主单审批。</Banner>}{governance?.changeDraft&&<><Banner tone="warn" title="存在尚未生效的变更">{governance.changeDraft.reason}{governance.changeDraft.status!=='pending'&&<Button onClick={()=>void act({type:'order.governance.discardChange',payload:{orderId:order.id}})}>放弃变更草稿</Button>}</Banner>{governance.approvedSnapshot?(changeRows.length?<DataTable ariaLabel="订单变更前后差异" rows={changeRows} rowKey={row=>row.id} columns={[{key:'label',header:'变更项',render:row=>row.label},{key:'before',header:'当前生效',render:row=>row.before},{key:'after',header:'拟议变更',render:row=>row.after}]}/>:<p className="mist-note">没有改变当前生效条款。</p>):<p className="mist-note">原批准快照不可用，暂不能列出变更差异。</p>}{state&&<OrderChangeImpactList state={state} order={order} lines={governance.changeDraft.lines} go={go}/>}</>}{governance?.rounds.map((round,index)=><div className="mist-card-body" key={round.id}><b>第 {index+1} 轮{round.kind==='change'?'变更':'主单'}审批</b><p>{round.status==='pending'?'待审批':round.status==='approved'?'已批准':'已退回'} · {round.decidedName||round.decidedBy||'尚未决定'} · {round.note||round.reason||round.submittedAt}</p><Button variant="quiet" size="sm" onClick={()=>setReviewRoundId(round.id)}>查看提交快照</Button></div>)}</Card>
    <Card as="section" className="mist-section"><CardHeader title="履约进度" tools={<Pill tone={order.tone}>{order.state}</Pill>} /><FlowSteps nodes={[
      { label: '主单审批', caption: approvalLabel, icon: Handshake, state: approved?'done':'now' },
      { label: '采购', caption: purchases.length?`${purchases.length} 张采购 · ${purchases.filter(p=>p.state==='approved').length} 已批`:'按条目计划', icon: Package, state: purchases.length&&purchases.every(p=>p.state==='approved') ? 'done' : purchases.length?'now':'todo' },
      { label: '生产', caption: productions.length ? `${productions.length} 个生产单` : '待安排', icon: Factory, state: productions.length && productions.every(item => item.pct === 100) ? 'done' : productions.length ? 'now' : 'todo' },
      { label: '尾期 QC', caption: lines.length&&lines.every(line => lineProgress(line).qc === 100) ? '已完成' : '待检验', icon: BadgeCheck, state: lines.length && lines.every(line => lineProgress(line).qc === 100) ? 'done' : productions.some(item => item.col === 'qc') ? 'now' : 'todo' },
      { label: '出运', caption: shipments.length?`${shipments.filter(shipment=>shipment.state==='departed').length} / ${shipments.length} 票已出运`:order.handoffAt ? '已交接后勤' : order.due, icon: Ship, state: order.state === '已出运'||order.state==='待收尾款' ? 'done' : shipments.length||order.handoffAt ? 'now' : 'todo' },
      { label: '收款', caption: `已到账 ${amountLabel(received.total)} ${order.currency}`, icon: Wallet, state: amounts.cents !== null && received.cents !== null && received.cents >= amounts.cents && amounts.cents > 0 ? 'done' : received.cents !== null && received.cents > 0 ? 'now' : 'todo' },
    ]} /></Card>
    <section className="mist-grid">
      <Card className="mist-col-8"><CardHeader title="条目" tools={<span className="mist-muted">生产 · 已 QC</span>} /><DataTable density={state?.settings.density} ariaLabel="订单条目" rows={lines} rowKey={line => line.id} onRowClick={line => {setLineId(line.id);go('orders/detail',order.id,{customerId:route.customerId,section:order.type,orderLineId:line.id});}} columns={columns} /></Card>
      <div className="mist-col mist-col-4">
        <Card><CardHeader title="出运准备" tools={<span className="mist-muted">{order.checklist.filter(item => item.done).length} / {order.checklist.length}</span>} /><Checklist items={order.checklist} onToggle={busy||locked ? undefined : index => { const item = order.checklist[index]; void act({ type: 'order.checklist', payload: { orderId: order.id, itemId: item.id, done: !item.done } }); }} /></Card>
        <Card><CardHeader title="收款" />{remaining === null ? <Banner tone="warn" title="待核对订单金额">金额核对完成后显示收款比例。</Banner> : <Donut centerLabel="已收" slices={[{ label: '已确认到账', value: received.total!, display: amountLabel(received.total), color: 'var(--mist-accent)' }, { label: '合同待收', value: remaining, display: amountLabel(remaining), color: 'transparent' }]} caption={<><span className="mist-note">已核销 {amountLabel(reconciled.total)} {order.currency}</span><Button variant="quiet" onClick={() => go('payment-vouchers',undefined,{section:'funding:'+order.id,customerId:order.customerId})}>查看收款核销</Button></>} />}</Card>
      </div>
    </section>
    <Drawer open={!!selectedLine} onClose={() => {setLineId(null);go('orders/detail',order.id,{customerId:route.customerId,section:order.type});}} title={selectedLine?.name ?? '订单条目'} sub={selectedLine?.style} size="lg">
      {selectedLine && <div className="mist-col" data-module-detail>{state&&<OrderLineFulfillment state={state} order={order} line={selectedLine} go={go} onCloseLine={reason=>run({type:'order.governance.closeLine',payload:{orderId:order.id,lineId:selectedLine.id,reason}})}/>}<KeyValue items={[...(state?[{ label: '来源', value: <OrderLineSourceValue state={state} line={selectedLine} go={go}/> }]:[]), { label: '数量', value: `${formatOrderQuantity(selectedLine.qty)} ${selectedLine.unit}` }, { label: '单价', value: `${amountLabel(lineAmounts.get(selectedLine.id) == null ? null : selectedLine.price)} ${order.currency}` }, { label: '小计', value: `${amountLabel(lineAmounts.get(selectedLine.id))} ${order.currency}` }]} />
        <Button icon={Pencil} disabled={busy||approvalPending} onClick={()=>setLineEditorId(selectedLine.id)}>编辑条目</Button>
        <CardHeader title="采购" /><Button block disabled={busy||locked} onClick={()=>go('procurement',undefined,{orderLineId:selectedLine.id,section:'order:'+order.id,customerId:order.customerId})}>准备采购草稿</Button>
        {!approved&&<Banner tone="warn" title="仅可准备采购草稿">主单批准前不能提交采购承诺、发出合同或进入生产。</Banner>}
        {purchases.filter(purchase=>purchase.lineId===selectedLine.id).map(purchase=><Button key={purchase.id} block onClick={()=>go('procurement',purchase.id,{orderLineId:selectedLine.id,section:'order:'+order.id,customerId:order.customerId})}>{['draft','rejected'].includes(purchase.state)?'查看采购草稿':'查看采购承诺'} {purchase.code}</Button>)}
        <CardHeader title="生产单" />{productions.filter(item => item.lineId === selectedLine.id).map(item => <Button key={item.id} block onClick={() => go('production-board', undefined, { productionId: item.id, orderLineId: selectedLine.id })}>{item.code} · {item.factory} · {item.pct}%</Button>)}{shipments.filter(shipment=>shipment.lines.some(line=>line.lineId===selectedLine.id)).map(shipment=><Button key={shipment.id} block onClick={()=>go('shipments',shipment.id)}>出运 {shipment.code}</Button>)}</div>}
    </Drawer>
    <Dialog open={documentOpen} onClose={() => setDocumentOpen(false)} title={`装箱单草稿 · ${order.code}`} description={`${order.customer} · 仅订单计划数量；正式装箱与原件以具体出运为准。`} width={860}
      footer={<Button onClick={() => { downloadMistCsv(`${order.code}-装箱单草稿.csv`, ['订单', '款式', '品名', '数量', '单位'], lines.map(line => [order.code, line.style, line.name, line.qty, line.unit])); toast('已下载装箱单草稿'); }}>下载草稿</Button>}><DataTable density={state?.settings.density} rows={lines} rowKey={line => line.id} columns={columns.filter(column => ['n', 'q'].includes(column.key))} />{shipments.length?shipments.map(shipment=><Button key={shipment.id} block onClick={()=>go('shipments',shipment.id)}>打开正式出运 {shipment.code}</Button>):<EmptyState compact title="尚未关联正式出运"/>}</Dialog>
    <Dialog open={editOpen} onClose={() => { if (!busy) setEditOpen(false); }} title="编辑订单" footer={<><Button onClick={() => setEditOpen(false)} disabled={busy}>取消</Button><Button variant="primary" loading={busy} disabled={busy||approvalPending} onClick={() => void act(approved&&!governance?.changeDraft&&edit.season===order.season&&edit.due===order.due?{type:'order.update',payload:{orderId:order.id,owner:edit.owner}}:{type:'order.governance.saveDraft',payload:{orderId:order.id,input:governance?.changeDraft?.contract||governance?.contract||createOrderGovernance({id:()=>'',now:'',actorName:''}).contract,...(governance?.changeDraft?{lines:governance.changeDraft.lines}:{}),orderPatch:{...governance?.changeDraft?.orderPatch,season:edit.season,due:edit.due,owner:edit.owner},...(approved?{reason:edit.reason}: {})}},()=>{setEditOpen(false);toast(approved?'变更草稿已保存，原批准内容继续生效':'订单资料已保存');})}>保存</Button></>}>
      {failure && <Banner tone="bad" title="保存失败">{failure}</Banner>}<FormGrid><Field label="季节"><TextInput value={edit.season} onChange={event => setEdit(value => ({ ...value, season: event.target.value }))} /></Field><Field label="交期"><TextInput type="date" value={mistDate(edit.due)?.toISOString().slice(0, 10) ?? edit.due} onChange={event => setEdit(value => ({ ...value, due: event.target.value }))} /></Field><Field label="负责人"><TextInput value={edit.owner} onChange={event => setEdit(value => ({ ...value, owner: event.target.value }))} /></Field>{approved&&<Field label="实质变更原因" full><TextArea value={edit.reason} onChange={event=>setEdit(value=>({...value,reason:event.target.value}))}/></Field>}</FormGrid>
    </Dialog>
    <Dialog open={!!selectedRound} onClose={()=>setReviewRoundId(null)} title="主单审批提交快照">{selectedRound&&<><KeyValue items={[{label:'合同',value:selectedRound.snapshot.contract.poNumber||selectedRound.snapshot.contract.internalPurpose},{label:'交期',value:selectedRound.snapshot.due},{label:'付款条件',value:selectedRound.snapshot.contract.paymentMethod+' · '+selectedRound.snapshot.contract.paymentNote},{label:'实际审批人',value:selectedRound.decidedName||selectedRound.decidedBy||'待决定'},...selectedRound.snapshot.lines.map(line=>({label:line.style+' · '+line.name,value:`${line.qty} ${line.unit} × ${line.price} ${selectedRound.snapshot.currency}`}))]}/>{selectedRound.snapshot.contract.confirmationFileIds.map(id=>{const file=state?.files.find(f=>f.id===id);return file?<Button key={id} onClick={()=>void workspace.downloadFile(file).catch(error=>setFailure(error.message))}>{file.name}</Button>:null;})}</>}</Dialog>
    <OrderContractDialog order={order} open={contractOpen} onClose={()=>setContractOpen(false)}/>
    <OrderLineDialog order={order} line={lines.find(line=>line.id===lineEditorId)||null} lines={lines} onClose={()=>setLineEditorId(null)}/>
    <Dialog open={handoffOpen} onClose={() => { if (!busy) setHandoffOpen(false); }} title="交接后勤" description={`${order.code} · ${order.customer}`} footer={<><Button onClick={() => setHandoffOpen(false)} disabled={busy}>取消</Button><Button variant="primary" loading={busy} onClick={() => void act({ type: 'order.handoff', payload: { orderId: order.id, note } }, () => { setHandoffOpen(false); setNote(''); toast('已交接后勤'); })}>确认交接</Button></>}>
      {failure && <Banner tone="bad" title="交接失败">{failure}</Banner>}<Field label="交接说明"><TextArea value={note} onChange={event => setNote(event.target.value)} /></Field>
    </Dialog>
  </MistPage>;
}
