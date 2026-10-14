/** Shared T2/T3 lists and T4 editors. Domain pages own fields, transitions and authority. */
import React from 'react';
import { ArrowLeft, ArrowRight, Download, Edit3, Plus } from 'lucide-react';
import { BackLink, Banner, Button, Card, CardHeader, Checkbox, DataTable, Dialog, EmptyState, Field, FormGrid, FormSection, KeyValue, MistPage, Mono, PageHeader, Pagination, SearchField, Select, TextArea, TextInput, Toolbar, VerticalSteps, useToast, type Column } from '../../../../../components/mist';
import { useMistWorkspace } from '../../runtime/workspace';
import { useNav } from '../../nav';
export type ModuleValue = string | number | boolean;
export type ModuleValues = Record<string, ModuleValue>;
export type ModuleField = {key:string;label:string;type?:'text'|'number'|'date'|'datetime-local'|'select'|'textarea'|'checkbox';options?:Array<{value:string;label:string}>;required?:boolean;hint?:string;readonly?:boolean;min?:number;step?:number|string};
export type ModuleEditorSection = {id:string;label:string;description?:string;fields:string[]};
export type ModuleEditorSpec = {title:string;description?:string;sections?:ModuleEditorSection[];fields:ModuleField[];initialValues:ModuleValues;submit:(values:ModuleValues)=>Promise<unknown>;submitLabel?:string};
/** Domain-owned sections preserve the Mist T9 geometry without arbitrary six-field business boundaries.
 * Any unassigned fields remain visible in fallback sections; a partial declaration can never hide data. */
export function moduleEditorSections(spec:ModuleEditorSpec){
  const groups:Array<{id:string;label:string;description?:string;fields:ModuleField[]}>=[],used=new Set<string>();
  for(const section of spec.sections||[]){
    const fields=section.fields.flatMap(key=>{const field=spec.fields.find(item=>item.key===key);if(!field||used.has(key))return[];used.add(key);return[field];});
    if(fields.length)groups.push({...section,fields});
  }
  const remaining=spec.fields.filter(field=>!used.has(field.key));
  for(let i=0;i<remaining.length;i+=6)groups.push({id:'fallback-'+i,label:groups.length===0?'基本信息':groups.length===1?'业务信息':'补充信息',fields:remaining.slice(i,i+6)});
  groups.push({id:'review',label:'确认提交',fields:[]});
  return groups;
}
function selectValue(field:ModuleField,value:ModuleValue|undefined){const current=String(value??'');return field.options?.some(option=>option.value===current)?current:'';}
function selectError(field:ModuleField,value:ModuleValue|undefined){const current=String(value??'');return field.type==='select'&&current!==''&&!field.options?.some(option=>option.value===current)?'请重新选择'+field.label:'';}
export function ModuleEditorDialog({spec,onClose,onSaved}:{spec:ModuleEditorSpec|null;onClose:()=>void;onSaved?:()=>void}){
  const {saving,pending,pendingCreate}=useMistWorkspace(),toast=useToast();
  const [values,setValues]=React.useState<ModuleValues>({}),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const mounted=React.useRef(true),lock=React.useRef(false),generation=React.useRef(0);
  React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  React.useEffect(()=>{generation.current++;setValues(spec?{...spec.initialValues}:{});setError('');setBusy(false);lock.current=false;},[spec]);
  const disabled=busy||saving||!!pending||!!pendingCreate;
  const submit=async()=>{
    if(!spec||disabled||lock.current)return;
    for(const f of spec.fields){if(f.required&&(values[f.key]===undefined||String(values[f.key]).trim()==='')){setError('请填写'+f.label);return;}const invalid=selectError(f,values[f.key]);if(invalid){setError(invalid);return;}}
    const converted={...values};for(const f of spec.fields)if(f.type==='number'){
      if(converted[f.key]===''&&!f.required)continue; const n=Number(converted[f.key]);
      if(!Number.isFinite(n)||(f.min!==undefined&&n<f.min)){setError(f.label+'无效');return;}converted[f.key]=n;
    }
    const run=++generation.current;lock.current=true;setBusy(true);setError('');
    try{await spec.submit(converted);if(mounted.current&&run===generation.current){onSaved?.();onClose();toast('已保存');}}
    catch(problem){if(mounted.current&&run===generation.current)setError(problem instanceof Error?problem.message:'保存未完成，请重试');}
    finally{if(mounted.current&&run===generation.current){lock.current=false;setBusy(false);}}
  };
  const change=(key:string,value:ModuleValue)=>setValues(v=>({...v,[key]:value}));
  return <Dialog open={!!spec} title={spec?.title||'编辑'} onClose={()=>{if(!busy)onClose();}} width={760}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={disabled} onClick={()=>void submit()}>{spec?.submitLabel||'保存'}</Button></>}>
    {spec?.description&&<p className="mist-sub" style={{margin:'0 0 12px'}}>{spec.description}</p>}
    {error&&<Banner tone="bad" title="未能保存">{error}</Banner>}
    {(pending||pendingCreate)&&!saving&&<Banner tone="warn" title="请先核对上次操作的结果">输入会保留；使用页面上的原请求核对入口后继续。</Banner>}
    <FormGrid>{spec?.fields.map(f=><Field key={f.key} label={f.label} required={f.required} hint={f.hint} full={f.type==='textarea'}>
      {f.type==='select'?<Select aria-label={f.label} placeholder={f.options?.some(option=>option.value==='')?undefined:'请选择'} value={selectValue(f,values[f.key])} options={f.options||[]} disabled={disabled||f.readonly} onChange={e=>change(f.key,e.target.value)} />
      :f.type==='textarea'?<TextArea aria-label={f.label} value={String(values[f.key]??'')} disabled={disabled||f.readonly} onChange={e=>change(f.key,e.target.value)} />
      :f.type==='checkbox'?<Checkbox label={f.label} checked={!!values[f.key]} disabled={disabled||f.readonly} onChange={v=>change(f.key,v)} />
      :<TextInput aria-label={f.label} type={f.type||'text'} min={f.min} step={f.step} value={String(values[f.key]??'')} disabled={disabled||f.readonly} onChange={e=>change(f.key,e.target.value)} />}
    </Field>)}</FormGrid>
  </Dialog>;
}
export type ModuleRowAction<T>={label:string;run:(row:T)=>Promise<unknown>|void;disabled?:(row:T)=>boolean};
export type ModuleWorkbenchProps<T extends {id:string}>={title:string;eyebrow?:string;description?:string;rows:T[];columns:Column<NoInfer<T>>[];searchText?:(row:NoInfer<T>)=>string;rowKey?:(row:NoInfer<T>)=>string;exportRows?:(filtered:NoInfer<T>[])=>void;create?:ModuleEditorSpec;edit?:(row:NoInfer<T>)=>ModuleEditorSpec|undefined;detail?:(row:NoInfer<T>)=>React.ReactNode;detailSurface?:'card'|'sections';rowActions?:ModuleRowAction<NoInfer<T>>[];toolbar?:React.ReactNode;preview?:boolean};
export function ModuleWorkbench<T extends {id:string}>({title,eyebrow,description,rows,columns,searchText,rowKey,exportRows,create,edit,detail,detailSurface='card',rowActions=[],toolbar,preview}:ModuleWorkbenchProps<T>){
  const workspace=useMistWorkspace(),toast=useToast(),{route,go}=useNav();
  const [query,setQuery]=React.useState(''),[page,setPage]=React.useState(1),[selected,setSelected]=React.useState<string|null>(route.id||null),[editor,setEditor]=React.useState<ModuleEditorSpec|null>(null),[failure,setFailure]=React.useState(''),[acting,setActing]=React.useState(false);
  const actionLock=React.useRef(false);
  React.useEffect(()=>{setSelected(route.id||null);setFailure('');},[route.id]);
  const routeContext=JSON.stringify(route);
  React.useEffect(()=>{setEditor(null);},[routeContext]);
  const selectionKey=route.id??selected;
  const active=React.useRef(true),currentContext=React.useRef(routeContext),currentSelection=React.useRef(selectionKey);
  currentContext.current=routeContext;currentSelection.current=selectionKey;
  React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const getKey=rowKey||((r:T)=>r.id),size=12;
  const filtered=rows.filter(r=>!query||(searchText?searchText(r):Object.values(r).filter(v=>typeof v==='string'||typeof v==='number').join(' ')).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const pages=Math.max(1,Math.ceil(filtered.length/size)),visiblePage=Math.min(page,pages),current=rows.find(r=>getKey(r)===selectionKey)||null;
  const locked=acting||workspace.saving||!!workspace.pending||!!workspace.pendingCreate;
  const act=async(action:ModuleRowAction<T>,row:T)=>{if(locked||actionLock.current)return;const origin=routeContext,rowId=getKey(row);actionLock.current=true;setActing(true);setFailure('');try{await action.run(row);}catch(problem){if(active.current&&currentContext.current===origin&&currentSelection.current===rowId)setFailure(problem instanceof Error?problem.message:'操作未完成');}finally{actionLock.current=false;if(active.current)setActing(false);}};
  const editSpec=current?edit?.(current):undefined;
  const controls=current&&(editSpec||rowActions.length)?<div className="mist-row mist-module-actions">{editSpec&&<Button icon={Edit3} disabled={locked} onClick={()=>setEditor(editSpec)}>编辑</Button>}{rowActions.map(a=><Button key={a.label} disabled={locked||a.disabled?.(current)} onClick={()=>void act(a,current)}>{a.label}</Button>)}</div>:null;
  const recordDetail=current?detail?.(current):<EmptyState title={workspace.loading?'正在读取记录':selectionKey?'未找到这条记录':'选择一条记录'} description={workspace.loading?'正在读取当前工作空间的业务记录。':selectionKey?'当前工作空间中没有这个对象，请返回列表选择。':'选中后查看详情与可执行操作。'} compact />;
  const body=<div className="mist-col" data-module-detail>{controls}{recordDetail}</div>;
  const fullDetail=!!route.id&&(!preview||route.detail==='full');
  const returnToList=()=>{const {view,id,detail:detailMode,...target}=route;setSelected(null);setFailure('');go(view,undefined,target);};
  const openFullDetail=()=>{if(current){const {view,id,...target}=route;go(view,getKey(current),{...target,detail:'full'});}};
  const publicCode=current?Object.entries(current).find(([key,value])=>['code','number','sku'].includes(key)&&typeof value==='string'&&value.trim())?.[1]:undefined;
  const publicName=current?Object.entries(current).find(([key,value])=>['name','title'].includes(key)&&typeof value==='string'&&value.trim())?.[1]:undefined;
  if(editor&&editor.fields.length>3)return <ModuleEditorPage spec={editor} onClose={()=>setEditor(null)} />;
  if(fullDetail)return <MistPage>
    <BackLink onClick={returnToList}>返回{title}</BackLink>
    <PageHeader eyebrow={publicCode?<Mono>{String(publicCode)}</Mono>:eyebrow} title={title+'详情'} description={publicName?String(publicName):undefined} actions={controls}/>
    {failure&&<div className="mist-section"><Banner tone="bad" title="操作未完成">{failure}</Banner></div>}
    {workspace.error&&<div className="mist-section"><Banner tone="bad" title={workspace.error} actions={<Button onClick={()=>void workspace.refresh()}>重新读取</Button>}/></div>}
    {detailSurface==='sections'&&current?<div className="mist-col" data-module-detail data-detail-surface="sections">{recordDetail}</div>:<Card><div className="mist-card-body mist-col" data-module-detail>{recordDetail}</div></Card>}
    <ModuleEditorDialog spec={editor} onClose={()=>setEditor(null)}/>
  </MistPage>;
  return <MistPage><PageHeader eyebrow={eyebrow} title={title} description={description} actions={<>{exportRows&&<Button icon={Download} onClick={()=>exportRows(filtered)}>导出</Button>}{create&&<Button variant="primary" icon={Plus} disabled={locked} onClick={()=>setEditor(create)}>新建</Button>}</>} />
    {failure&&<Banner tone="bad" title="操作未完成">{failure}</Banner>}
    {workspace.error&&<Banner tone="bad" title={workspace.error} actions={<Button onClick={()=>void workspace.refresh()}>重新读取</Button>} />}
    <Toolbar right={toolbar}><SearchField value={query} onChange={v=>{setQuery(v);setPage(1);}} placeholder={'搜索'+title} /></Toolbar>
    <section className="mist-grid"><Card className={preview?'mist-col-8':'mist-col-12'}><DataTable loading={workspace.loading} rows={filtered.slice((visiblePage-1)*size,visiblePage*size)} columns={columns} rowKey={getKey} selectedKey={selectionKey} onRowClick={r=>{setSelected(getKey(r));const {view,id,detail:detailMode,...target}=route;go(view,getKey(r),target);}} ariaLabel={title} empty={<EmptyState title={query?'没有匹配的记录':'还没有'+title+(title.endsWith('记录')?'':'记录')} description={query?'调整搜索条件后再试。':create?'创建第一条记录后即可在这里查看和继续处理。':'完成相关来源业务后，记录会显示在这里。'} action={!query&&create?<Button onClick={()=>setEditor(create)}>新建</Button>:undefined} />} footer={<div className="mist-row"><span className="mist-note">{filtered.length} 条记录</span><span className="mist-spacer"/><Pagination page={visiblePage} pages={pages} onChange={setPage}/></div>} /></Card>
      {preview&&<Card className="mist-col-4"><CardHeader title="记录详情"/><div className="mist-card-body mist-col">{body}{current&&<Button iconRight={ArrowRight} onClick={openFullDetail}>打开完整详情</Button>}</div></Card>}</section>
    <ModuleEditorDialog spec={editor} onClose={()=>setEditor(null)} />
  </MistPage>;
}
/** Explicit field rows only; no internal identifiers or raw JSON are exported by default. */
export function downloadModuleCsv(filename:string,headers:string[],rows:Array<Array<unknown>>){
  const cell=(input:unknown)=>{let value=input==null?'':String(input);if(/^[=+@\t\r]/.test(value)||(/^-/ .test(value)&&!/^-[\d.]+$/.test(value)))value="'"+value;return '"'+value.replace(/"/g,'""')+'"';};
  const data='\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function ModuleEditorPage({spec,onClose}:{spec:ModuleEditorSpec;onClose:()=>void}){
  const workspace=useMistWorkspace(),toast=useToast();
  const [values,setValues]=React.useState<ModuleValues>({...spec.initialValues}),[step,setStep]=React.useState(0),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const live=React.useRef(true),lock=React.useRef(false);React.useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const groups=moduleEditorSections(spec);
  const current=groups[step],last=step===groups.length-1,blocked=busy||workspace.saving||!!workspace.pending||!!workspace.pendingCreate;
  const validate=(fields:ModuleField[])=>{for(const f of fields){if(f.required&&(values[f.key]===undefined||String(values[f.key]).trim()===''))return '请填写'+f.label;const invalid=selectError(f,values[f.key]);if(invalid)return invalid;if(f.type==='number'&&values[f.key]!==''&&values[f.key]!==undefined&&(!Number.isFinite(Number(values[f.key]))||(f.min!==undefined&&Number(values[f.key])<f.min)))return f.label+'无效';}return '';};
  const save=async()=>{if(blocked||lock.current)return;const problem=validate(spec.fields);if(problem){setError(problem);return;}lock.current=true;setBusy(true);const converted={...values};for(const f of spec.fields)if(f.type==='number'&&values[f.key]!==''&&values[f.key]!==undefined)converted[f.key]=Number(values[f.key]);try{await spec.submit(converted);if(live.current){onClose();toast('已保存');}}catch(e){if(live.current)setError(e instanceof Error?e.message:'保存未完成');}finally{if(live.current){lock.current=false;setBusy(false);}}};
  const set=(key:string,v:ModuleValue)=>{setValues(old=>({...old,[key]:v}));setError('');};
  return <MistPage><BackLink onClick={onClose}>返回列表</BackLink><PageHeader title={spec.title} description={spec.description||"填写业务信息，核对后保存。"}/>{error&&<Banner tone="bad" title="未能保存">{error}</Banner>}<div className="mist-wizard"><VerticalSteps current={String(step)} onSelect={id=>{const target=Number(id);if(target<=step){setStep(target);setError('');}}} steps={groups.map((g,i)=>({id:String(i),label:g.label,done:i<step}))}/><Card>
    <FormSection title={current.label} description={current.description}>{last?<KeyValue items={spec.fields.map(f=>({label:f.label,value:f.type==='checkbox'?(values[f.key]?'是':'否'):f.type==='select'?(f.options?.find(o=>o.value===values[f.key])?.label||String(values[f.key]??'—')):String(values[f.key]??'—')}))}/>:<FormGrid>{current.fields.map(f=><Field key={f.key} label={f.label} required={f.required} hint={f.hint} full={f.type==='textarea'}>{f.type==='select'?<Select aria-label={f.label} placeholder={f.options?.some(option=>option.value==='')?undefined:'请选择'} value={selectValue(f,values[f.key])} options={f.options||[]} disabled={blocked||f.readonly} onChange={e=>set(f.key,e.target.value)}/>:f.type==='textarea'?<TextArea aria-label={f.label} value={String(values[f.key]??'')} disabled={blocked||f.readonly} onChange={e=>set(f.key,e.target.value)}/>:f.type==='checkbox'?<Checkbox label={f.label} checked={!!values[f.key]} disabled={blocked||f.readonly} onChange={v=>set(f.key,v)}/>:<TextInput aria-label={f.label} type={f.type||'text'} min={f.min} step={f.step} value={String(values[f.key]??'')} disabled={blocked||f.readonly} onChange={e=>set(f.key,e.target.value)}/>}</Field>)}</FormGrid>}</FormSection>
    <div className="mist-sticky-foot"><span className="mist-note">第 {step+1} / {groups.length} 步</span><span className="mist-spacer"/>{step>0&&<Button icon={ArrowLeft} disabled={blocked} onClick={()=>{setStep(i=>i-1);setError('');}}>上一步</Button>}{last?<Button variant="primary" loading={busy} disabled={blocked} onClick={()=>void save()}>{spec.submitLabel||'确认保存'}</Button>:<Button variant="primary" iconRight={ArrowRight} disabled={blocked} onClick={()=>{const problem=validate(current.fields);if(problem)setError(problem);else setStep(i=>i+1);}}>下一步</Button>}</div>
  </Card></div></MistPage>;
}
