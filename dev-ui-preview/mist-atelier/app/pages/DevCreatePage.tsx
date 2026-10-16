/** T9: the original five-step Mist composition, backed by the shared workspace. */
import React from 'react';
import {DEVELOPMENT_REQUEST_TYPES,developmentCharged,developmentInitiator,developmentInitiatorLabel,developmentDomain,emptyFabricRequirements,fabricRequirementError,validFabricSample,type DevelopmentDomain,type FabricDevelopmentRequirements} from '../../../../server/src/shared/mistDevelopmentDomain';
import { ArrowLeft, ArrowRight, Building2, CalendarDays, Download, Factory, Palette, Ruler, Sparkles, Tag, Trash2, Users } from 'lucide-react';
import { BackLink, Banner, Button, Card, Checkbox, ChoiceCards, Dialog, Field, FormGrid, FormSection, KeyValue, MistPage, PageHeader, Select, TextArea, TextInput, TextLink, UploadZone, VerticalSteps, useToast } from '../../../../components/mist';
import type { DevelopmentValues, MistFile, MistState } from '../../../../server/src/shared/mistWorkspace';
import { useMistWorkspace } from '../runtime/workspace';
import { useNav } from '../nav';

const STEPS = [{id:'basic',label:'基本信息'},{id:'style',label:'款式与面料'},{id:'plan',label:'工厂与计划'},{id:'files',label:'附件'},{id:'review',label:'确认提交'}];
type DevelopmentFormValues = Omit<DevelopmentValues,'collaborators'|'sampleQuantity'> & {collaborators:string;sampleQuantity:string};
const emptyForm = (customer='',domain:DevelopmentDomain='garment'):DevelopmentFormValues => ({...(domain==='fabric'?{domain,sampleForm:'米样',sampleUnit:'米',targetCurrency:'',targetUnit:'',fabricRequirements:emptyFabricRequirements()}:{}),initiator:'customer',name:'',customer,style:'',season:'AW27',category:domain==='fabric'?'':'大衣',fabric:'',color:'',target:'',factories:[],due:'',kind:'new',goal:'',sizeBase:domain==='fabric'?'':'M（常规）',collaborators:'',sampleQuantity:'2'});
const fromValues = (values:DevelopmentValues):DevelopmentFormValues => ({...values,factories:[...values.factories],collaborators:values.collaborators.join('、'),sampleQuantity:String(values.sampleQuantity)});
const toValues = (values:DevelopmentFormValues):DevelopmentValues => ({...values,collaborators:values.collaborators.split(/[、,，\n]/).map(value=>value.trim()).filter(Boolean),sampleQuantity:Number(values.sampleQuantity)});

export function developmentFormErrors(values: DevelopmentFormValues, step: string) {
  const errors:Record<string,string>={};
  if(step==='basic'){
    if(!values.name.trim())errors.name='请填写开发对象名称';
    if(developmentInitiator(values)==='customer'){
      if(!values.customer.trim())errors.customer='请选择客户';
      if(values.initiator&&!values.requestType)errors.requestType='请选择客户要求类型';
      if(values.requestType==='other'&&!values.requestNote?.trim())errors.requestNote='请说明具体要求';
    }else if(!values.requester?.trim())errors.requester='请填写内部需求方';
    if(developmentDomain(values)==='garment'&&!values.style.trim())errors.style='请填写客户款号';
    if(values.kind!=='new'&&!values.sourceDevId)errors.sourceDevId='请选择参考开发案';
  }
  if(step==='style'){
    if(developmentDomain(values)==='garment'&&!values.fabric.trim())errors.fabric='请填写面料，或注明待寻样';
    if(values.target&&(!/^\d+(\.\d+)?$/.test(values.target)||Number(values.target)<=0))errors.target='请输入大于 0 的目标单价';
  }
  if(step==='style'&&developmentDomain(values)==='fabric'){const problem=fabricRequirementError({...emptyFabricRequirements(),...values.fabricRequirements});if(problem)errors.fabricRequirements=problem;if(values.target&&(!values.targetCurrency?.trim()||!values.targetUnit?.trim()))errors.target='目标价须同时填写币种与计价单位';}
  if(step==='plan'){
    if(!values.factories.length)errors.factories='请至少选择一家打样工厂';
    const date=new Date(`${values.due}T12:00:00`);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(values.due)||Number.isNaN(date.getTime())||date.getFullYear()!==Number(values.due.slice(0,4))||date.getMonth()+1!==Number(values.due.slice(5,7))||date.getDate()!==Number(values.due.slice(8)))errors.due='请选择有效的目标日期';
    if(developmentDomain(values)==='fabric'){if(!validFabricSample(Number(values.sampleQuantity),values.sampleForm||'',values.sampleUnit||''))errors.sampleQuantity='米样按米记录，其他剪片类按整数份；形态与单位须完整';}else if(!/^[1-9]\d*$/.test(values.sampleQuantity))errors.sampleQuantity='首样数量须为正整数';
  }
  return errors;
}
export function firstInvalidDevelopmentStep(values:DevelopmentFormValues){return STEPS.find(step=>Object.keys(developmentFormErrors(values,step.id)).length>0)?.id??null;}

export function developmentFactoryOptions(state:MistState|null,selected:string[]=[],domain:DevelopmentDomain='garment'){
  const suppliers=state?.market?.suppliers||[];
  const relevant=(supplier:{type:string;capabilities:string})=>domain==='fabric'?/面料|纺织|织造|染整|fabric|textile|weav|dye/i.test(supplier.type+' '+supplier.capabilities):/成衣|服装|制衣|缝制|裁剪|加工|garment|apparel|sew|manufactur|process/i.test(supplier.type+' '+supplier.capabilities);
  const active=suppliers.filter(s=>s.status==='active'&&relevant(s)).map(s=>s.name);
  const relevantIds=new Set((state?.devs||[]).filter(d=>developmentDomain(d.values)===domain).map(d=>d.id));const historic=[...(state?.versions||[]).filter(v=>domain==='garment'&&!state?.devs||relevantIds.has(v.devId)).map(v=>v.factory),...(state?.drafts||[]).filter(d=>developmentDomain(d.values)===domain).flatMap(d=>d.values.factories),...selected];
  return [...new Set([...active,...historic].map(name=>name.trim()).filter(Boolean))].map(name=>({name,historical:!active.includes(name),unavailable:suppliers.some(s=>s.name===name&&s.status!=='active')}));
}
export function InlineDevelopmentFactoryDialog({open,onClose,onCreated,domain='garment'}:{open:boolean;onClose:()=>void;onCreated:(name:string,id:string)=>void;domain?:DevelopmentDomain}){
  const {run,saving,pending,recover}=useMistWorkspace();
  const [form,setForm]=React.useState({code:'',name:'',capabilities:''}),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const active=React.useRef(true),lock=React.useRef(false);
  React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  React.useEffect(()=>{if(open){setForm({code:'',name:'',capabilities:''});setError('');}},[open]);
  const save=async()=>{if(lock.current||saving||pending)return;if(!form.code.trim()||!form.name.trim()||!form.capabilities.trim()){setError('请填写供应商编码、名称与实际制作能力');return;}
    lock.current=true;setBusy(true);setError('');try{const receipt=await run({type:'market.supplier.save',payload:{input:{code:form.code.trim(),name:form.name.trim(),type:domain==='fabric'?'面料工厂':'成衣加工',capabilities:form.capabilities.trim(),country:'',address:'',capacity:0,capacityUnit:domain==='fabric'?'米':'件',leadDays:0,note:'从开发计划建立，其他供应商资料待补充'}}});const id=receipt.result.id;if(typeof id!=='string'||!id)throw new Error('保存回执没有供应商编号，请核对原操作');if(active.current){onCreated(form.name.trim(),id);onClose();}}catch(problem){if(active.current)setError(problem instanceof Error?problem.message:'供应商未保存');}finally{lock.current=false;if(active.current)setBusy(false);}
  };
  const recoverFactory=async()=>{if(lock.current||pending?.command?.type!=='market.supplier.save')return;const name=pending.command.payload.input.name;lock.current=true;setBusy(true);setError('');try{const receipt=await recover();const id=receipt?.result.id;if(typeof id!=='string'||!id)throw new Error('尚未取得原工厂保存回执');if(active.current){onCreated(name,id);onClose();}}catch(problem){if(active.current)setError(problem instanceof Error?problem.message:'原保存结果仍待核对');}finally{lock.current=false;if(active.current)setBusy(false);}};
  return <Dialog open={open} onClose={()=>{if(!busy)onClose();}} title={domain==='fabric'?'新增面料工厂':'新增成衣加工供应商'} description="保存后会加入当前工厂选择，已填开发内容继续保留。" footer={<>{pending?.command?.type==='market.supplier.save'&&<Button loading={busy} onClick={()=>void recoverFactory()}>核对工厂保存结果</Button>}<Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={saving||!!pending} onClick={()=>void save()}>保存并选择</Button></>}>
    {error&&<Banner tone="bad" title="供应商未保存">{error}</Banner>}<FormGrid cols={1}>
      <Field label="供应商编码" required><TextInput aria-label="供应商编码" value={form.code} onChange={e=>setForm(v=>({...v,code:e.target.value}))}/></Field>
      <Field label="供应商名称" required><TextInput aria-label="供应商名称" value={form.name} onChange={e=>setForm(v=>({...v,name:e.target.value}))}/></Field>
      <Field label="实际制作能力" required><TextInput aria-label="实际制作能力" placeholder={domain==='fabric'?'例如：织造、染整、面料试样':'例如：大衣缝制、样衣制作'} value={form.capabilities} onChange={e=>setForm(v=>({...v,capabilities:e.target.value}))}/></Field>
    </FormGrid><p className="mist-note">产能、交期及联系资料可随后在供应商档案补充。</p>
  </Dialog>;
}

export function DevCreatePage(){
  const {go,route}=useNav();const {state,loading,error,run,uploadFile,downloadFile,pending,recover,saving}=useMistWorkspace();const toast=useToast();
  const [step,setStep]=React.useState('basic'),[done,setDone]=React.useState<Record<string,boolean>>({});
  const [f,setF]=React.useState<DevelopmentFormValues>(()=>emptyForm());const [fileIds,setFileIds]=React.useState<string[]>([]);
  const [draftId,setDraftId]=React.useState<string|undefined>(route.id),[touched,setTouched]=React.useState(false),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState(''),[dirty,setDirty]=React.useState(false),[leave,setLeave]=React.useState(false),[factoryDialog,setFactoryDialog]=React.useState(false);
  const loaded=React.useRef<string|undefined>(undefined);const busyRef=React.useRef(false);const active=React.useRef(true);React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  React.useEffect(()=>{if(!state)return;const key=(route.id||'new')+':'+(route.customerId||'')+':'+(route.section||'');if(loaded.current===key)return;loaded.current=key;const draft=state.drafts.find(item=>item.id===route.id);
    if(route.id&&!draft){setMessage('这份草稿已不存在，请从开发列表重新选择。');return;}
    const draftCustomer=draft?(state.customers.find(c=>c.id===draft.values.customer)||state.customers.filter(c=>c.name===draft.values.customer).length===1&&state.customers.find(c=>c.name===draft.values.customer)):undefined;
    const sourceCustomer=route.customerId?state.customers.find(c=>c.id===route.customerId):state.customers[0];
    setF(draft?{...fromValues(draft.values),customer:draftCustomer?draftCustomer.id:''}:emptyForm(sourceCustomer?.id,route.section==='fabric'?'fabric':'garment'));
    if(route.customerId&&!sourceCustomer)setMessage('指定客户不存在，请在当前工作区重新选择客户。');else if(draft&&!draftCustomer&&developmentInitiator(draft.values)==='customer')setMessage('草稿客户无法唯一匹配，请重新选择准确客户。');setFileIds(draft?.fileIds||[]);setDraftId(draft?.id);setStep('basic');setDone({});setDirty(false);
  },[state,route.id,route.customerId,route.section]);
  const set=<K extends keyof DevelopmentFormValues>(key:K,value:DevelopmentFormValues[K])=>{setF(previous=>({...previous,[key]:value}));setDirty(true);setMessage('');};
  const fabricDomain=developmentDomain(f)==='fabric',domain=developmentDomain(f);
  const requirements={...emptyFabricRequirements(),...f.fabricRequirements};
  const setRequirement=(key:keyof FabricDevelopmentRequirements,value:string)=>set('fabricRequirements',{...requirements,[key]:value});
  const steps=STEPS.map(item=>({...item,label:item.id==='style'&&fabricDomain?'面料目标与规格':item.label}));
  const idx=STEPS.findIndex(item=>item.id===step);const errors=developmentFormErrors(f,step);const err=(key:string)=>touched?errors[key]:undefined;
  const next=()=>{setTouched(true);if(Object.keys(errors).length)return;setDone(previous=>({...previous,[step]:true}));setTouched(false);setStep(STEPS[idx+1].id);};
  const selectedFiles=fileIds.map(id=>state?.files.find(file=>file.id===id)).filter((file):file is MistFile=>!!file);
  const factories=developmentFactoryOptions(state,f.factories,domain);
  const customerName=state?.customers.find(c=>c.id===f.customer)?.name||f.customer;
  const backToSource=()=>route.customerId?go('crm',route.customerId,{customerId:route.customerId}):go('development');
  const save=async(submit:boolean)=>{
    if(!state||busyRef.current)return;if(developmentInitiator(f)==='customer'&&!state.customers.some(c=>c.id===f.customer)){setStep('basic');setTouched(true);setMessage('请重新选择准确客户');return;}if(submit&&factories.some(factory=>factory.unavailable&&f.factories.includes(factory.name))){setStep('plan');setMessage('已停用工厂不能用于本次开发，请选择其他工厂');return;}if(!submit&&Object.keys(developmentFormErrors(f,'basic')).length){setStep('basic');setTouched(true);return;}if(submit){const invalid=firstInvalidDevelopmentStep(f);if(invalid){setStep(invalid);setTouched(true);return;}}
    busyRef.current=true;setBusy(true);setMessage('');try{const receipt=await run({type:submit?'development.submit':'development.saveDraft',payload:{draftId,values:toValues(f),fileIds}});if(!active.current)return;setDirty(false);toast(submit?(fabricDomain?'面料开发案与工厂计划版本已创建':'开发案已创建，工厂任务已保存'):'草稿已保存');if(submit&&receipt.result.devId)go('development/detail',receipt.result.devId,{versionId:receipt.result.versionId,...(route.customerId?{customerId:f.customer}:{})});else go('development',undefined,route.customerId?{customerId:f.customer}:undefined);}
    catch(cause){if(active.current)setMessage(cause instanceof Error?cause.message:'保存失败，请重试');}finally{busyRef.current=false;if(active.current)setBusy(false);}
  };
  const upload=async(files:File[])=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setMessage('');try{for(const file of files){if(file.size>50*1024*1024)throw Error(`${file.name} 超过 50MB`);const stored=await uploadFile(file);if(!active.current)return;setFileIds(previous=>[...new Set([...previous,stored.id])]);setDirty(true);}}catch(cause){if(active.current)setMessage(cause instanceof Error?cause.message:'附件上传失败');}finally{busyRef.current=false;if(active.current)setBusy(false);}};
  const removeFile=async(id:string)=>{if(busyRef.current||pending)return;const next=fileIds.filter(value=>value!==id);if(!draftId){setFileIds(next);setDirty(true);return;}busyRef.current=true;setBusy(true);setMessage('');try{await run({type:'development.saveDraft',payload:{draftId,values:toValues(f),fileIds:next}});if(active.current){setFileIds(next);setDirty(false);toast('已从草稿移除附件');}}catch(cause){if(active.current)setMessage(cause instanceof Error?cause.message:'附件未能移除');}finally{busyRef.current=false;if(active.current)setBusy(false);}};
  const autofill=()=>{const source=state?.devs.find(dev=>dev.id===f.sourceDevId);if(!source)return;setF(previous=>({...previous,style:source.style,category:source.values.category,fabric:source.fabric,color:source.values.color,target:source.values.target,sizeBase:source.values.sizeBase,...(fabricDomain?{fabricRequirements:source.values.fabricRequirements,targetCurrency:source.values.targetCurrency,targetUnit:source.values.targetUnit}:{}),goal:source.goal,sourceVersionId:source.currentVersionId||undefined}));setDirty(true);toast('已从所选开发案带入本次要求');};
  const recoverWrite=async()=>{const original=pending;if(!original||busyRef.current)return;busyRef.current=true;setBusy(true);try{const receipt=await recover();if(!receipt||!active.current)return;if(original.kind==='upload'){const id=receipt.result.fileId||receipt.result.id;if(id)setFileIds(previous=>[...new Set([...previous,id])]);setDirty(true);setMessage('');}else if(original.command?.type==='development.submit'&&receipt.result.devId){setDirty(false);go('development/detail',receipt.result.devId,{versionId:receipt.result.versionId,...(route.customerId?{customerId:f.customer}:{})});}else if(original.command?.type==='development.saveDraft'){setDirty(false);if(route.customerId)go('development',undefined,{customerId:f.customer});else go('development');}}catch(cause){if(active.current)setMessage(String(cause));}finally{busyRef.current=false;if(active.current)setBusy(false);}};
  const recovery=pending?<Button loading={busy||saving} onClick={()=>void recoverWrite()}>核对原操作结果</Button>:null;
  const back=()=>dirty?setLeave(true):backToSource();
  return <MistPage>
    <BackLink onClick={back}>{route.customerId?'返回客户档案':'开发与寻样'}</BackLink>
    <PageHeader eyebrow={`订单履约 · ${fabricDomain?'面料开发':'成衣开发'}`} title={draftId?'继续开发草稿':fabricDomain?'新建面料开发案':'新建开发案'} description="填完基本信息即可保存草稿，其余信息可以稍后补充。" actions={<Button variant="quiet" loading={busy} disabled={!state} onClick={()=>void save(false)}>存为草稿</Button>} />
    {(message||error)&&<div className="mist-section"><Banner tone="bad" title="暂时无法保存">{message||error}</Banner></div>}
    {pending&&!saving&&<div className="mist-section"><Banner tone="warn" title="原操作结果尚待核对" actions={recovery}>请先核对已发出的请求，避免重复创建。</Banner></div>}
    <div className="mist-wizard">
      <VerticalSteps steps={steps.map(item=>({...item,done:done[item.id]}))} current={step} onSelect={id=>{if(busy)return;setStep(id);setTouched(false);}} />
      <Card><fieldset disabled={busy||loading||!state||!!pending} style={{border:0,padding:0,margin:0,minWidth:0}}>
        {step==='basic'&&<>
          <div style={{padding:'22px 24px 0'}}><Banner tone="ai" icon={Sparkles} title="从同业务线开发案带入要求" actions={<Button size="sm" variant="ai" disabled={!f.sourceDevId} onClick={autofill}>一键填入</Button>}>选定参考开发案后，可带入款式、面料与目标价，再按本次需求调整。</Banner></div>
          <FormSection title="基本信息" description="开发对象是什么、为谁开发。"><FormGrid>
            <Field label="开发对象名称" required error={err('name')} full><TextInput icon={Tag} value={f.name} onChange={event=>set('name',event.target.value)} placeholder={fabricDomain?'例如：羊毛混纺斜纹面料':'例如：双面羊毛城市大衣'} /></Field>
            <Field label="发起方" required full><ChoiceCards ariaLabel="发起方" cols={2} value={developmentInitiator(f)} onChange={value=>{setF(previous=>({...previous,initiator:value,charged:value==='customer',...(value==='internal'?{customer:'',requestType:undefined,requestNote:undefined}:{requester:undefined,requesterId:undefined})}));setDirty(true);setMessage('');}} options={[{value:'customer',title:'客户要求',description:'为客户开发，须选择客户'},{value:'internal',title:'内部需求',description:'公司内部发起，无需客户'}]} /></Field>
            {developmentInitiator(f)==='customer'?<>
              <Field label="客户" required error={err('customer')}><Select icon={Building2} value={f.customer} onChange={event=>set('customer',event.target.value)} options={[{value:'',label:'请选择客户'},...(state?.customers.map(customer=>({value:customer.id,label:customer.name}))||[])]} /></Field>
              <Field label="客户要求类型" required error={err('requestType')} full><ChoiceCards ariaLabel="客户要求类型" value={f.requestType||('' as never)} onChange={value=>set('requestType',value)} options={(Object.keys(DEVELOPMENT_REQUEST_TYPES) as Array<keyof typeof DEVELOPMENT_REQUEST_TYPES>).map(value=>({value,title:DEVELOPMENT_REQUEST_TYPES[value].label,description:DEVELOPMENT_REQUEST_TYPES[value].hint}))} /></Field>
              {f.requestType==='other'&&<Field label="要求说明" required error={err('requestNote')} full><TextArea value={f.requestNote||''} onChange={event=>set('requestNote',event.target.value)} placeholder="写明客户的具体要求" /></Field>}
            </>:<Field label="内部需求方" required error={err('requester')} hint="提出需求的员工，也可作为版本确认人"><TextInput icon={Users} list="mist-dev-requesters" value={f.requester||''} onChange={event=>{const name=event.target.value,employee=(state?.platform?.employees||[]).find(item=>item.active&&item.name===name);setF(previous=>({...previous,requester:name,requesterId:employee?.id}));setDirty(true);setMessage('');}} placeholder="员工姓名" /><datalist id="mist-dev-requesters">{(state?.platform?.employees||[]).filter(item=>item.active).map(item=><option key={item.id} value={item.name}>{item.department}</option>)}</datalist></Field>}
            <Field label="是否收费" hint="按发起方默认，可修改"><Checkbox checked={developmentCharged(f)} label={developmentCharged(f)?'收费开发':'不收费'} onChange={checked=>set('charged',checked)} /></Field>
            <Field label={fabricDomain?'客户面料标识':'客户款号'} required={!fabricDomain} error={err('style')}><TextInput value={f.style} onChange={event=>set('style',event.target.value)} placeholder="CC-AW27-…" className="mist-mono" /></Field>
            <Field label="季节"><Select value={f.season} onChange={event=>set('season',event.target.value)} options={['AW27','SS27','AW26']} /></Field>
            <Field label={fabricDomain?'面料分类':'品类'} hint={fabricDomain?'保留实际原类名；未知可留空，不据分类推断规格':undefined}>{fabricDomain?<TextInput value={f.category} onChange={event=>set('category',event.target.value)} placeholder="实际分类名称"/>:<Select value={f.category} onChange={event=>set('category',event.target.value)} options={['大衣','西装','Blazer','套装','针织']} />}</Field>
            <Field label="参考开发案" error={err('sourceDevId')} full><Select value={f.sourceDevId||''} onChange={event=>set('sourceDevId',event.target.value||undefined)} options={[{value:'',label:'不引用已有开发案'},...(state?.devs.filter(dev=>developmentDomain(dev.values)===domain).map(dev=>({value:dev.id,label:`${dev.code} · ${dev.name}`}))||[])]} /></Field>
          </FormGrid></FormSection>
          <FormSection title="开发类型"><ChoiceCards value={f.kind} onChange={value=>set('kind',value)} options={[{value:'new',title:'全新开发',description:'从需求开始'},{value:'rev',title:'基于已有改版',description:'保留来源版本，建立本次要求'},{value:'copy',title:'复制其他客户款',description:'选择有权使用的参考开发案'}]} /></FormSection>
        </>}
        {step==='style'&&!fabricDomain&&<FormSection title="款式与面料" description="写清楚要验证什么，工厂才能一次做对。"><FormGrid>
          <Field label="面料" required error={err('fabric')}><TextInput icon={Palette} value={f.fabric} onChange={event=>set('fabric',event.target.value)} placeholder="成分 / 克重 / 名称" /></Field>
          <Field label="颜色"><TextInput value={f.color} onChange={event=>set('color',event.target.value)} placeholder="例如：浅石色" /></Field>
          <Field label="目标 FOB 单价" hint="仅内部可见" error={err('target')}><TextInput value={f.target} onChange={event=>set('target',event.target.value)} suffix="USD / 件" placeholder="0.00" inputMode="decimal" /></Field>
          <Field label="尺码基准"><Select icon={Ruler} value={f.sizeBase} onChange={event=>set('sizeBase',event.target.value)} options={['M（常规）','S','L']} /></Field>
          <Field label="开发目标" full hint="会显示在详情页与工厂任务单上"><TextArea value={f.goal} onChange={event=>set('goal',event.target.value)} rows={4} placeholder="要验证的版型、手感、工艺重点…" /></Field>
        </FormGrid></FormSection>}
        {step==='style'&&fabricDomain&&<>
          <FormSection title="面料目标与规格" description="这里记录开发目标；工厂分析和 QC 实测另存，不自动代替目标。">
            {err('fabricRequirements')&&<Banner tone="bad" title="规格尚未完整">{err('fabricRequirements')}</Banner>}
            <FormGrid>
              <Field label="面料描述" full><TextInput value={f.fabric} onChange={e=>set('fabric',e.target.value)} placeholder="名称、手感或参考来源；未知可注明待寻样"/></Field>
              <Field label="目标成分" full hint="每行 纤维:比例，合计100%；未知填待工厂分析"><TextArea value={requirements.composition} onChange={e=>setRequirement('composition',e.target.value)} rows={3}/></Field>
              <Field label="目标克重" hint="未知留空；保留原值，不猜换算"><TextInput value={requirements.weightValue} inputMode="decimal" onChange={e=>setRequirement('weightValue',e.target.value)}/></Field>
              <Field label="克重原单位"><TextInput value={requirements.weightUnit} onChange={e=>setRequirement('weightUnit',e.target.value)} placeholder="例如：g/m²"/></Field>
              <Field label="目标幅宽" hint="在开发目标中说明全幅或有效幅宽"><TextInput value={requirements.widthValue} inputMode="decimal" onChange={e=>setRequirement('widthValue',e.target.value)}/></Field>
              <Field label="幅宽原单位"><TextInput value={requirements.widthUnit} onChange={e=>setRequirement('widthUnit',e.target.value)} placeholder="例如：cm"/></Field>
              <Field label="纱支要求" hint="经纬、计数制式、股数；未知填待工厂分析"><TextInput value={requirements.yarn} onChange={e=>setRequirement('yarn',e.target.value)}/></Field>
              <Field label="组织 / 花型"><TextInput value={requirements.weave} onChange={e=>setRequirement('weave',e.target.value)}/></Field>
              <Field label="颜色参考"><TextInput value={f.color} onChange={e=>set('color',e.target.value)}/></Field>
              <Field label="用途"><TextInput value={requirements.usage} onChange={e=>setRequirement('usage',e.target.value)}/></Field>
              <Field label="手感要求"><TextInput value={requirements.handle} onChange={e=>setRequirement('handle',e.target.value)}/></Field>
              <Field label="后整理"><TextInput value={requirements.finish} onChange={e=>setRequirement('finish',e.target.value)}/></Field>
              <Field label="性能要求" full><TextArea value={requirements.performance} onChange={e=>setRequirement('performance',e.target.value)}/></Field>
              <Field label="目标单价" error={err('target')} hint="仅内部参考，不形成报价"><TextInput value={f.target} inputMode="decimal" onChange={e=>set('target',e.target.value)}/></Field>
              <Field label="目标价币种"><TextInput value={f.targetCurrency||''} onChange={e=>set('targetCurrency',e.target.value)} placeholder="实际币种"/></Field>
              <Field label="计价单位"><TextInput value={f.targetUnit||''} onChange={e=>set('targetUnit',e.target.value)} placeholder="例如：米、码或公斤"/></Field>
              <Field label="开发目标" full><TextArea value={f.goal} onChange={e=>set('goal',e.target.value)} rows={3}/></Field>
            </FormGrid>
          </FormSection>
        </>}
        {step==='plan'&&<FormSection title="工厂与计划" description="可以同时下发多家工厂比样。">
          <div style={{display:'flex',flexDirection:'column',gap:12,marginBottom:18}}>{factories.map(factory=><Checkbox key={factory.name} checked={f.factories.includes(factory.name)} disabled={factory.unavailable&&!f.factories.includes(factory.name)} onChange={checked=>set('factories',checked?[...f.factories,factory.name]:f.factories.filter(name=>name!==factory.name))} label={<><b style={{fontWeight:500}}>{factory.name}</b>{factory.unavailable?' · 已停用':factory.historical?' · 历史工厂':''}</>} />)}{!factories.length&&<p className="mist-note">尚无可用的{fabricDomain?'面料工厂':'成衣加工供应商'}，请先在此添加实际工厂。</p>}<Button onClick={()=>setFactoryDialog(true)}>新增工厂</Button></div>
          {err('factories')&&<p className="mist-field-hint" role="alert">{err('factories')}</p>}
          <FormGrid>
            <Field label="目标日期" required error={err('due')}><TextInput icon={CalendarDays} type="date" value={f.due} onChange={event=>set('due',event.target.value)} /></Field>
            <Field label="协作人"><TextInput icon={Users} value={f.collaborators} onChange={event=>set('collaborators',event.target.value)} placeholder="使用顿号或逗号分隔" /></Field>
            {fabricDomain&&<><Field label="计划样品形态" required><TextInput value={f.sampleForm||''} onChange={e=>{set('sampleForm',e.target.value);set('sampleUnit',e.target.value.trim()==='米样'?'米':'份');}} placeholder="米样、色样、手织样、样卡…"/></Field><Field label="计划样品单位"><TextInput readOnly value={f.sampleUnit||''}/></Field></>}
            <Field label="首样数量" required error={err('sampleQuantity')}><TextInput icon={Factory} value={f.sampleQuantity} onChange={event=>set('sampleQuantity',event.target.value)} inputMode={fabricDomain?'decimal':'numeric'} suffix={`${fabricDomain?f.sampleUnit:'件'} / 工厂`} /></Field>
          </FormGrid>
        </FormSection>}
        {step==='files'&&<FormSection title="附件" description={fabricDomain?'面料参考、目标规格与客户资料；附件不冒充实物来样。':'款式图、工艺单、客户参考图。'}>
          <UploadZone hint="支持 PDF、图片、Excel，单个不超过 50MB" onFiles={files=>void upload(files)} />
          {selectedFiles.map(file=><div className="mist-row mist-section" key={file.id}><span>{file.name}</span><span className="mist-spacer" /><TextLink icon={Download} onClick={()=>void downloadFile(file).catch(cause=>setMessage(cause instanceof Error?cause.message:'下载失败'))}>下载</TextLink><TextLink icon={Trash2} onClick={()=>void removeFile(file.id)}>移除</TextLink></div>)}
        </FormSection>}
        {step==='review'&&<FormSection title="确认提交" description={fabricDomain?'提交后保存各工厂计划版本，并进入面料开发列表；不会向外部工厂发送。':'提交后会保存所选工厂任务，并出现在开发与寻样列表。'}><KeyValue items={[{label:'开发对象',value:f.name||'—'},{label:'发起方',value:developmentInitiatorLabel(f)},{label:'费用',value:developmentCharged(f)?'收费':'不收费'},{label:developmentInitiator(f)==='internal'?'款号':'客户 / 款号',value:developmentInitiator(f)==='internal'?(f.style||'—'):`${customerName} · ${f.style||'—'}`},{label:'季节 / 品类',value:`${f.season} · ${f.category}`},{label:'面料 / 颜色',value:`${f.fabric||'—'} · ${f.color||'—'}`},{label:fabricDomain?'目标单价':'目标 FOB 单价',value:f.target?`${f.target} ${fabricDomain?f.targetCurrency:'USD'} / ${fabricDomain?f.targetUnit:'件'}`:'—'},...(fabricDomain?[{label:'目标成分',value:requirements.composition},{label:'克重 / 幅宽原值',value:`${requirements.weightValue||'待分析'} ${requirements.weightUnit} / ${requirements.widthValue||'待分析'} ${requirements.widthUnit}`},{label:'纱支 / 组织',value:`${requirements.yarn} / ${requirements.weave}`},{label:'用途 / 手感',value:`${requirements.usage||'—'} / ${requirements.handle||'—'}`},{label:'后整理 / 性能',value:`${requirements.finish||'—'} / ${requirements.performance||'—'}`},{label:'计划形态',value:f.sampleForm||'—'}]:[{label:'尺码基准',value:f.sizeBase}]),{label:'开发目标',value:f.goal||'—'},{label:'工厂',value:f.factories.join('、')||'—'},{label:'协作人',value:f.collaborators||'—'},{label:'首样数量',value:`${f.sampleQuantity} ${fabricDomain?f.sampleUnit:'件'} / 工厂`},{label:'目标日期',value:f.due||'—'},{label:'附件',value:`${selectedFiles.length} 个`}]} /></FormSection>}
        <div className="mist-sticky-foot"><span className="mist-note">第 {idx+1} / {STEPS.length} 步</span><span className="mist-spacer" />{idx>0&&<Button variant="quiet" icon={ArrowLeft} onClick={()=>{setStep(STEPS[idx-1].id);setTouched(false);}}>上一步</Button>}{idx<STEPS.length-1?<Button variant="primary" iconRight={ArrowRight} onClick={next}>下一步</Button>:<Button variant="primary" loading={busy} iconRight={ArrowRight} onClick={()=>void save(true)}>创建开发案</Button>}</div>
      </fieldset></Card>
    </div>
    <InlineDevelopmentFactoryDialog open={factoryDialog} domain={domain} onClose={()=>setFactoryDialog(false)} onCreated={name=>{set('factories',[...new Set([...f.factories,name])]);}}/>
    <Dialog open={leave} onClose={()=>setLeave(false)} title="离开未保存的开发案？" description="可以先保存草稿，稍后从开发列表继续填写。" footer={<>{recovery}<Button variant="quiet" onClick={()=>setLeave(false)}>继续编辑</Button><Button variant="quiet" onClick={backToSource}>放弃并返回</Button><Button variant="primary" loading={busy} onClick={()=>void save(false)}>保存草稿</Button></>} />
  </MistPage>;
}
