/** T9 订单创建：保留 Mist 分步表单与吸附操作栏。 */
import React from 'react';
import { ArrowLeft, ArrowRight, Plus, Trash2 } from 'lucide-react';
import { BackLink, Banner, Button, Card, Field, FormGrid, FormSection, IconButton, KeyValue, MistPage, PageHeader, Select, TextArea, TextInput, UploadZone, VerticalSteps, useToast } from '../../../../components/mist';
import type { MistImage, MistOrderInput } from '../../../../server/src/shared/mistWorkspace';
import { useNav } from '../nav';
import { useMistWorkspace } from '../runtime/workspace';
import { fmt } from '../data';
import { formatOrderQuantity, orderAmounts } from './orderAmounts';
import { createOrderGovernance, type OrderGovernanceInput } from '../../../../server/src/shared/mistOrderGovernance';
const STEPS = [{ id: 'basic', label: '基本信息' }, { id: 'items', label: '产品条目' }, { id: 'plan', label: '交期与负责' }, { id: 'amounts', label: '核对金额' }, { id: 'review', label: '确认提交' }];
type LineOrigin = { sourceProductId?: string; sourceDevId?: string; sourceVersionId?: string };
type LineDraft = MistOrderInput['lines'][number] & { key: string; origin?: LineOrigin };
type DraftSource = { kind: 'version' | 'product'; label: string; detail: string; customerId?: string; line: LineDraft };
const blankContract = () => createOrderGovernance({ id: () => '', now: '', actorName: '' }).contract;
const newLine = (type: 'garment' | 'fabric'): LineDraft => ({ key: crypto.randomUUID(), name: '', style: '', img: type === 'garment' ? 'coat' : 'clay', qty: 1, unit: type === 'garment' ? '件' : '米', price: 0 });
export function OrderCreatePage() {
  const { go, route } = useNav(), toast = useToast(), workspace=useMistWorkspace();
  const { state, loading, error, run, saving, pending, recover, uploadFile, downloadFile }=workspace;
  const scope=`${workspace.workspace?.id||''}:${workspace.workspace?.ownerId||''}:${!!state}`,activeScope=React.useRef(scope);activeScope.current=scope;
  const alive=React.useRef(true);React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const locked=React.useRef(false);
  const initialType=route.section==='fabric'?'fabric':'garment';
  const stateRef=React.useRef(state);stateRef.current=state;
  const source=React.useMemo<DraftSource|null>(()=>{
    if(!state)return null;
    const unit=initialType==='garment'?'件':'米';
    if(route.versionId){const version=state.versions.find(row=>row.id===route.versionId),dev=version&&state.devs.find(row=>row.id===version.devId);if(!version||!dev)return null;return{kind:'version',label:`开发版本 ${dev.code} · ${version.label}`,detail:`${dev.name} · ${dev.style} · ${version.factory||'工厂未填'}`,customerId:dev.customerId||undefined,line:{key:'source',name:dev.name,style:dev.style,img:version.img||dev.img,qty:1,unit,price:0,origin:{sourceDevId:dev.id,sourceVersionId:version.id}}};}
    if(route.id?.startsWith('product:')){const market=(state as typeof state&{market?:{products:Array<{id:string;sku:string;name:string;specification:string;unit:string;sourceDevId:string;sourceVersionId:string}>}}).market,product=market?.products.find(row=>row.id===route.id!.slice(8));if(!product)return null;return{kind:'product',label:`数字档案 ${product.sku}`,detail:`${product.name}${product.specification?' · '+product.specification:''}`,line:{key:'source',name:product.name,style:product.sku,img:initialType==='garment'?'coat':'clay',qty:1,unit:product.unit||unit,price:0,origin:{sourceProductId:product.id,...(product.sourceDevId?{sourceDevId:product.sourceDevId}:{}),...(product.sourceVersionId?{sourceVersionId:product.sourceVersionId}:{})}}};}
    return null;
  },[!!state,route.versionId,route.id,initialType]);
  const sourceMissing=!!state&&(!!route.versionId||!!route.id?.startsWith('product:'))&&!source;
  const [step, setStep] = React.useState('basic'), [done, setDone] = React.useState<Record<string, boolean>>({});
  const [form, setForm] = React.useState({ type: initialType as 'garment' | 'fabric', customerId: route.customerId ?? '', season: '', currency: 'USD', due: '', owner: '' });
  const [contract,setContract]=React.useState<OrderGovernanceInput>(()=>createOrderGovernance({id:()=>'',now:'',actorName:''}).contract);
  const [lines, setLines] = React.useState<LineDraft[]>([newLine(initialType)]);
  const [working, setWorking] = React.useState(false), [failure, setFailure] = React.useState('');
  const busy=working||loading||saving||!!pending;
  const index = STEPS.findIndex(item => item.id === step);
  const customer = state?.customers.find(item => item.id === form.customerId);
  const amounts = orderAmounts(lines);
  React.useEffect(()=>{locked.current=false;setWorking(false);setFailure('');setDone({});setStep('basic');setForm({type:initialType,customerId:route.customerId??source?.customerId??'',season:'',currency:'USD',due:'',owner:state?.settings.profileName||''});setLines([source?{...source.line,key:crypto.randomUUID()}:newLine(initialType)]);setContract(createOrderGovernance({id:()=>'',now:'',actorName:''}).contract);},[scope,source?.label]);
  React.useEffect(() => { if (state && !form.owner) setForm(previous => ({ ...previous, owner: state.settings.profileName })); }, [state?.settings.profileName]);
  const validation = (section: string) => {
    if (section === 'basic' && ((contract.kind==='external'&&!customer) || !form.season.trim() || !form.currency)) return '请选择客户，并填写季节与币种。';
    if (section === 'items' && (!lines.length || lines.some(line => !line.name.trim() || !line.style.trim() || !line.unit.trim() || !Number.isFinite(line.qty) || line.qty <= 0 || !Number.isFinite(line.price) || line.price < 0))) return '每个条目须填写品名、款号、正数数量、单位及有效单价。';
    if (section === 'items' && amounts.error) return amounts.error;
    if (section === 'plan' && (!form.due || !form.owner.trim())) return '请填写交期和负责人。';
    return '';
  };
  const totalLabel = amounts.total === null ? '—' : fmt(amounts.total, 2);
  const next = () => { const message = validation(step); if (message) { setFailure(message); return; } setFailure(''); setDone(previous => ({ ...previous, [step]: true })); setStep(STEPS[index + 1].id); };
  const submit = async () => {
    if (busy||locked.current) return;
    const message = ['basic', 'items', 'plan'].map(validation).find(Boolean);
    if (message) { setFailure(message); return; }
    const bound=scope;locked.current=true;setWorking(true); setFailure('');
    try {
      const receipt = await run({ type: 'order.create', payload: { ...form, governance:contract, lines: lines.map(({ key, origin, ...line }) => line) } });
      const id = receipt.result.orderId ?? receipt.result.id;
      if (!id) throw new Error('订单已提交，但回执缺少编号。请返回列表核对，勿重复创建。');
      let linked='';
      if(lines.some(line=>line.origin)){
        try{
          let created=stateRef.current?.orderLines.filter(line=>line.orderId===id)||[];
          for(let attempt=0;attempt<40&&created.length!==lines.length;attempt++){await new Promise(resolve=>setTimeout(resolve,50));created=stateRef.current?.orderLines.filter(line=>line.orderId===id)||[];}
          if(created.length!==lines.length)throw new Error('尚未读到新建条目');
          const order=stateRef.current?.orders.find(row=>row.id===id) as {governance?:{contract:OrderGovernanceInput}}|undefined;
          await run({type:'order.governance.saveDraft',payload:{orderId:id,input:order?.governance?.contract||contract,lines:created.map((line,index)=>({id:line.id,name:line.name,style:line.style,img:line.img,qty:line.qty,unit:line.unit,price:line.price,...(lines[index].origin||{})}))}});
        }catch(problem){linked=problem instanceof Error?problem.message:'来源关联未写入';}
      }
      if(alive.current&&activeScope.current===bound){toast(linked?`订单草稿已创建；来源关联未写入（${linked}），请在条目中核对`:'订单草稿已创建，待主单审批'); go('orders/detail', id,{customerId:form.customerId,section:form.type});}
    } catch (problem) { if(alive.current&&activeScope.current===bound)setFailure(problem instanceof Error ? problem.message : '订单未能创建，请重试'); } finally { if(alive.current&&activeScope.current===bound){locked.current=false;setWorking(false);} }
  };
  const resolve=async()=>{if(working||saving||locked.current)return;const bound=scope;locked.current=true;setWorking(true);try{const receipt=await recover();if(alive.current&&activeScope.current===bound&&receipt){const id=receipt.result.orderId??receipt.result.id;if(id&&pending?.command?.type==='order.create')go('orders/detail',id,{customerId:form.customerId,section:form.type});}}catch(error){if(alive.current&&activeScope.current===bound)setFailure(error instanceof Error?error.message:'原请求核对失败');}finally{if(alive.current&&activeScope.current===bound){locked.current=false;setWorking(false);}}};
  const uploadContract=async(files:File[])=>{if(busy||locked.current)return;const bound=scope;locked.current=true;setWorking(true);setFailure('');try{for(const file of files){const stored=await uploadFile(file);if(alive.current&&activeScope.current===bound)setContract(value=>({...value,confirmationFileIds:[...new Set([...value.confirmationFileIds,stored.id])]}));}}catch(error){if(alive.current&&activeScope.current===bound)setFailure(error instanceof Error?error.message:'合同依据上传未完成');}finally{if(alive.current&&activeScope.current===bound){locked.current=false;setWorking(false);}}};
  const setLine = (key: string, patch: Partial<LineDraft>) => setLines(items => items.map(item => item.key === key ? { ...item, ...patch } : item));
  return <MistPage>
    <BackLink onClick={() => go('orders',undefined,{customerId:form.customerId||undefined,section:form.type})}>订单管理</BackLink><PageHeader eyebrow="订单履约 · 订单" title="新建订单" description="先保存订单草稿，补齐合同依据后提交主单审批。批准前不能采购或履约。" />
    {source&&<Banner tone="accent" title={`来源：${source.label}`} actions={<Button variant="quiet" onClick={()=>go('orders/new',undefined,{customerId:route.customerId,section:form.type})}>改为手工新建</Button>}>{source.detail}。已带入第一个条目的品名、款号与单位；数量、销售单价与交期请按客户 PO 填写，来源会随条目一起保存。</Banner>}
    {sourceMissing&&<Banner tone="warn" title="来源记录不可用">指定的开发版本或数字档案不在当前工作空间，已按手工新建处理。</Banner>}
    {(failure || error) && <Banner tone="bad" title="订单尚未完成">{failure || error}</Banner>}
    {pending&&!saving&&<Banner tone="warn" title="上一次操作结果待核对" actions={<Button disabled={working||saving} onClick={()=>void resolve()}>核对原操作结果</Button>}>保留当前填写内容，先核对原请求。</Banner>}
    <div className="mist-wizard"><VerticalSteps current={step} onSelect={id => { if (done[id] || id === step) { setStep(id); setFailure(''); } }} steps={STEPS.map(item => ({ ...item, done: done[item.id] }))} />
      <Card>
        <fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
        {step === 'basic' && <FormSection title="基本信息"><FormGrid><Field label="订单用途"><Select value={contract.kind} onChange={event=>setContract(value=>({...value,kind:event.target.value as OrderGovernanceInput['kind']}))} options={[{value:'external',label:'外部客户订单'},{value:'internal',label:'内部用途订单'}]}/></Field>
          <Field label="订单类型"><Select value={form.type} onChange={event => { const type = event.target.value as 'garment' | 'fabric'; setForm(value => ({ ...value, type })); setLines(items => items.map(item => !item.name.trim()&&!item.style.trim()&&item.qty===1&&item.price===0?{...item,unit:type==='garment'?'件':'米',img:type==='garment'?'coat':'clay'}:item)); }} options={[{ value: 'garment', label: '成衣订单' }, { value: 'fabric', label: '面料订单' }]} /></Field>
          <Field label="客户" required={contract.kind==='external'}><Select value={form.customerId} placeholder="选择客户" onChange={event => { const selected = state?.customers.find(item => item.id === event.target.value); setForm(value => ({ ...value, customerId: event.target.value, currency: selected?.currency ?? value.currency })); }} options={(state?.customers ?? []).map(item => ({ value: item.id, label: item.name }))} /></Field>
          <Field label="季节 / 批次" required><TextInput value={form.season} onChange={event => setForm(value => ({ ...value, season: event.target.value }))} placeholder="例如 AW27 首批" /></Field>
          <Field label="币种" required><Select value={form.currency} onChange={event => setForm(value => ({ ...value, currency: event.target.value }))} options={[...new Set(['USD', 'EUR', 'CNY', 'GBP', 'HKD',form.currency,customer?.currency].filter((value):value is string=>!!value))]} /></Field>
          {contract.kind==='external'?<Field label="PO / 合同号"><TextInput value={contract.poNumber} onChange={event=>setContract(value=>({...value,poNumber:event.target.value}))}/></Field>:<><Field label="内部用途"><TextInput value={contract.internalPurpose} onChange={event=>setContract(value=>({...value,internalPurpose:event.target.value}))}/></Field><Field label="接收团队 / 负责人"><TextInput value={contract.receiver} onChange={event=>setContract(value=>({...value,receiver:event.target.value}))}/></Field></>}
        </FormGrid></FormSection>}
        {step === 'items' && <FormSection title="产品条目" description="每个条目分别保留品名、数量、单位与单价。">
          {lines.map((line, itemIndex) => <div key={line.key} className="mist-section"><div className="mist-row"><span className="mist-h2">条目 {itemIndex + 1}</span><span className="mist-spacer" /><IconButton icon={Trash2} label={`删除条目 ${itemIndex + 1}`} disabled={lines.length === 1} onClick={() => setLines(items => items.filter(item => item.key !== line.key))} /></div><FormGrid>
            <Field label="品名" required><TextInput value={line.name} onChange={event => setLine(line.key, { name: event.target.value })} /></Field><Field label="款号 / 品号" required><TextInput value={line.style} onChange={event => setLine(line.key, { style: event.target.value })} /></Field>
            <Field label="数量" required><TextInput type="number" min="0.0001" step="0.0001" value={line.qty} onChange={event => setLine(line.key, { qty: Number(event.target.value) })} /></Field><Field label="单位" required><TextInput value={line.unit} onChange={event => setLine(line.key, { unit: event.target.value })} /></Field>
            <Field label={`单价 ${form.currency}`} required><TextInput type="number" min="0" step="0.01" value={line.price} onChange={event => setLine(line.key, { price: Number(event.target.value) })} /></Field><Field label="展示图"><Select value={line.img} onChange={event => setLine(line.key, { img: event.target.value as MistImage })} options={[{ value: 'coat', label: '大衣' }, { value: 'suit', label: '西装' }, { value: 'blazer', label: 'Blazer' }, { value: 'clay', label: '通用' }]} /></Field>
          </FormGrid></div>)}<Button icon={Plus} onClick={() => setLines(items => [...items, newLine(form.type)])}>添加条目</Button>
        </FormSection>}
        {step === 'plan' && <FormSection title="交期、合同与负责"><FormGrid><Field label="交期" required><TextInput type="date" value={form.due} onChange={event => setForm(value => ({ ...value, due: event.target.value }))} /></Field><Field label="负责人" required><TextInput value={form.owner} onChange={event => setForm(value => ({ ...value, owner: event.target.value }))} /></Field>
          <Field label="付款方式"><Select value={contract.paymentMethod} onChange={event=>setContract(value=>({...value,paymentMethod:event.target.value as OrderGovernanceInput['paymentMethod']}))} options={['TT','LC','OA','OTHER'].map(value=>({value,label:{TT:'T/T 电汇',LC:'L/C 信用证',OA:'O/A 账期',OTHER:'其他'}[value]||value}))}/></Field><Field label="定金比例（%）" hint="未填表示尚未配置，不代表定金门禁已通过"><TextInput aria-label="定金比例（%）" type="number" min="0" max="100" value={contract.depositPercent??''} onChange={event=>setContract(value=>({...value,depositPercent:event.target.value===''?null:Number(event.target.value)}))}/></Field>
          <Field label="贸易术语"><TextInput value={contract.incoterm} onChange={event=>setContract(value=>({...value,incoterm:event.target.value}))}/></Field><Field label="指定地点 / 港口"><TextInput value={contract.deliveryPlace} onChange={event=>setContract(value=>({...value,deliveryPlace:event.target.value}))}/></Field><Field label="付款条款原文" full><TextArea value={contract.paymentNote} onChange={event=>setContract(value=>({...value,paymentNote:event.target.value}))}/></Field>
        </FormGrid><div className="mist-section"><UploadZone title="上传客户 PO / 书面确认依据" onFiles={files=>void uploadContract(files)}/>{contract.confirmationFileIds.map(id=>{const file=state?.files.find(f=>f.id===id);return <div className="mist-row" key={id}><span>{file?.name||'已上传依据'}</span><span className="mist-spacer"/>{file&&<Button variant="quiet" onClick={()=>void downloadFile(file)}>下载</Button>}<Button variant="quiet" onClick={()=>setContract(value=>({...value,confirmationFileIds:value.confirmationFileIds.filter(fileId=>fileId!==id)}))}>移除</Button></div>;})}<p className="mist-note">可以先保存草稿；外部订单提交主单审批前必须具备书面确认附件。</p></div></FormSection>}
        {step === 'amounts' && <FormSection title="核对金额"><KeyValue items={[...lines.map((line, lineIndex) => ({ label: `${line.style} · ${line.name}`, value: `${formatOrderQuantity(line.qty)} ${line.unit} × ${fmt(line.price, 2)} = ${amounts.items[lineIndex].amount === null ? '—' : fmt(amounts.items[lineIndex].amount!, 2)} ${form.currency}` })), { label: '订单总金额', value: `${totalLabel} ${form.currency}` }]} /></FormSection>}
        {step === 'review' && <FormSection title="确认提交"><KeyValue items={[{ label: '订单类型', value: form.type === 'garment' ? '成衣订单' : '面料订单' }, { label: '客户', value: customer?.name ?? '未选择' }, { label: '季节 / 批次', value: form.season }, { label: '条目', value: `${lines.length} 个产品条目` }, { label: '总金额', value: `${totalLabel} ${form.currency}` }, { label: '交期', value: form.due }, { label: '负责人', value: form.owner },{label:'订单状态',value:'草稿，等待主单审批'},{label:'合同 / 用途',value:contract.kind==='external'?contract.poNumber||'待补充':contract.internalPurpose},{label:'付款条件',value:contract.paymentMethod+' · '+(contract.paymentNote||'待补充')},{label:'确认附件',value:contract.confirmationFileIds.length+' 份'}]} /></FormSection>}
        <div className="mist-sticky-foot"><span className="mist-note">第 {index + 1} / {STEPS.length} 步</span><span className="mist-spacer" />{index > 0 && <Button variant="quiet" icon={ArrowLeft} disabled={busy} onClick={() => { setStep(STEPS[index - 1].id); setFailure(''); }}>上一步</Button>}{index < STEPS.length - 1 ? <Button variant="primary" iconRight={ArrowRight} disabled={loading} onClick={next}>下一步</Button> : <Button variant="primary" loading={busy} iconRight={ArrowRight} onClick={() => void submit()}>创建订单草稿</Button>}</div>
        </fieldset>
      </Card>
    </div>
  </MistPage>;
}
