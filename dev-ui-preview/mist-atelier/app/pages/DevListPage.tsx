/** T2: original list/preview and board compositions, using the shared Mist workspace. */
import React from 'react';
import {developmentDomain,developmentInitiator,developmentInitiatorLabel} from '../../../../server/src/shared/mistDevelopmentDomain';
import { apiService } from '../../../../services/apiService';
import { ArrowRight, ChevronRight, Columns3, Download, Layers, List, Plus, SearchX } from 'lucide-react';
import { Avatar, Banner, Button, Card, DataTable, Dialog, Dropdown, EmptyState, Facts, Field, FormGrid, Icon, Kanban, MistPage, Mono, ObjectCell, ObjectStage, PageHeader, Pagination, Pill, Pipeline, SearchField, Segmented, StageProgress, Tabs, TextArea, Select, TextInput, TextLink, Thumb, Toolbar, UploadZone, useToast, type Column } from '../../../../components/mist';
import type { MistDev, MistFabric } from '../../../../server/src/shared/mistWorkspace';
import { IMG, STAGES, STAGE_COLORS } from '../data';
import { useMistWorkspace } from '../runtime/workspace';
import { useOptionalMistSession } from '../runtime/auth';
import { defaultMemberId, memberSelectOptions, workspaceMembers } from '../runtime/members';
import { useNav } from '../nav';
import { useCompactLayout } from './modules/pageKit';
import { DEVELOPMENT_LIST_TABS, SOURCING_CREATE_ID, developmentCreateTarget, developmentListTab, developmentListTarget, type DevelopmentListTab } from '../developmentEntry';

type CsvDev = Pick<MistDev,'id'|'name'|'style'|'customer'|'owner'|'due'|'stage'|'state'|'ver'|'factory'> & {code?:string};
export function developmentCsv(rows:CsvDev[]):string {
  const cell=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;
  return '\uFEFF'+[['开发编号','开发对象','客户款号','客户','负责人','目标日期','当前阶段','当前状态','版本','工厂'],...rows.map(row=>[row.code||row.id,row.name,row.style,row.customer,row.owner,row.due,STAGES[row.stage]??'',row.state,row.ver,row.factory])].map(row=>row.map(cell).join(',')).join('\r\n');
}
function downloadDevelopmentCsv(rows:CsvDev[],label='开发案'){const url=URL.createObjectURL(new Blob([developmentCsv(rows)],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`Bambook-${label}案.csv`;document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);}
const shortDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)?value.slice(5).replace('-','/'):value||'未定';
export function developmentDueDays(value:string,now=new Date()):number|null {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!match)return null;
  const [year,month,day]=match.slice(1).map(Number),date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return Math.round((date.getTime()-Date.UTC(now.getFullYear(),now.getMonth(),now.getDate()))/86_400_000);
}
export function developmentDueText(value:string,now=new Date()) {const days=developmentDueDays(value,now);return days===null?'日期待确认':days===0?'今天':days>0?`${days} 天后`:`${-days} 天前`;}
const late=(value:string)=>{const days=developmentDueDays(value);return days!==null&&days<0;};
/** 三个页签的数量与各自未筛选列表一致：开发案按保存的业务线计数（草稿单独以「草稿 N」显示），寻样按寻样任务计数。 */
export function developmentTabCounts(devs:ReadonlyArray<Pick<MistDev,'values'>>,drafts:ReadonlyArray<{values:MistDev['values']}>,fabrics:ReadonlyArray<unknown>):Record<DevelopmentListTab,number>&{drafts:Record<'garment'|'fabric',number>} {
  const count=(rows:ReadonlyArray<{values:MistDev['values']}>,domain:'garment'|'fabric')=>rows.filter(row=>developmentDomain(row.values)===domain).length;
  return {garment:count(devs,'garment'),fabric:count(devs,'fabric'),sourcing:fabrics.length,drafts:{garment:count(drafts,'garment'),fabric:count(drafts,'fabric')}};
}

/** 当前页签来自路由；切换页签时整页筛选状态随 key 重建，品类、负责人、客户、发起方、阶段、搜索词和页码一并重置。 */
export function DevListPage(){
  const {route}=useNav();const tab=developmentListTab(route.section);
  return <DevListTabPage key={tab} tab={tab} />;
}
type StageFilter=number|'draft';
function DevListTabPage({tab}:{tab:DevelopmentListTab}){
  const {go,route}=useNav();const {state,loading,error,run,uploadFile,downloadFile,fileUrl,pending,recover,saving,workspace}=useMistWorkspace();const toast=useToast();const session = useOptionalMistSession();const members=workspaceMembers(workspace,state,session?.user);
  const [q,setQ]=React.useState(''),[stage,setStage]=React.useState<StageFilter>(-1),[owner,setOwner]=React.useState('all'),[customer,setCustomer]=React.useState('all'),[initiator,setInitiator]=React.useState('all'),[category,setCategory]=React.useState('all'),[mode,setMode]=React.useState<'list'|'board'>('list'),[selected,setSelected]=React.useState<string|null>(null),[page,setPage]=React.useState(1),[busy,setBusy]=React.useState(false),[failure,setFailure]=React.useState('');
  const domain=tab==='sourcing'?null:tab,tabConfig=DEVELOPMENT_LIST_TABS.find(item=>item.value===tab)!;
  const [fabricOpen,setFabricOpen]=React.useState(false),[fabricId,setFabricId]=React.useState<string|null>(null),[fabricForm,setFabricForm]=React.useState({name:'',request:'',ownerId:'',ownerName:'',due:'',answer:'',note:'',fileIds:[] as string[]});
  const live=React.useRef(true),busyRef=React.useRef(false);React.useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const devs=state?.devs||[],fabrics=state?.fabrics||[],drafts=state?.drafts||[];
  const tabCounts=developmentTabCounts(devs,drafts,fabrics);
  const domainDevs=devs.filter(dev=>developmentDomain(dev.values)===domain),domainDrafts=drafts.filter(draft=>developmentDomain(draft.values)===domain);
  const categories=[...new Set([...domainDevs.map(dev=>dev.values.category),...domainDrafts.map(draft=>draft.values.category)].filter(Boolean))];
  const needle=q.trim().toLowerCase(),drafting=stage==='draft';
  // 同一套筛选口径：阶段计数、草稿计数与列表都基于同一组负责人 / 客户 / 发起方 / 品类 / 搜索条件。
  const scoped=domainDevs.filter(dev=>(owner==='all'||dev.ownerId===owner)&&(customer==='all'||dev.customer===customer)&&(initiator==='all'||developmentInitiator(dev.values)===initiator)&&(category==='all'||dev.values.category===category)&&(!needle||`${dev.name}${dev.code}${dev.style}`.toLowerCase().includes(needle)));
  const filtered=scoped.filter(dev=>typeof stage!=='number'||stage<0||dev.stage===stage);
  const draftRows=domainDrafts.filter(draft=>(customer==='all'||draft.values.customer===customer)&&(initiator==='all'||developmentInitiator(draft.values)===initiator)&&(category==='all'||draft.values.category===category)&&(!needle||`${draft.values.name}${draft.values.style}${draft.values.customer}`.toLowerCase().includes(needle)));
  const fabricRows=fabrics.filter(fabric=>(owner==='all'||fabric.ownerId===owner)&&(!needle||`${fabric.name}${fabric.code}${fabric.request}${fabric.answer}`.toLowerCase().includes(needle)));
  const pages=Math.max(1,Math.ceil(filtered.length/10)),currentPage=Math.min(page,pages),rows=filtered.slice((currentPage-1)*10,currentPage*10),sel=rows.find(dev=>dev.id===selected)||rows[0];
  React.useEffect(()=>setPage(1),[q,stage,owner,customer,initiator,category]);
  const switchTab=(next:DevelopmentListTab)=>{if(next===tab)return;const target=developmentListTarget(next);go(target.view,target.id,target.target);};
  const create=()=>{const target=developmentCreateTarget(tab);go(target.view,target.id,target.target);};
  const chooseStage=(value:StageFilter)=>{setStage(value);setSelected(null);if(value==='draft'){setOwner('all');setMode('list');}};
  const clearFilters=()=>{setStage(-1);setQ('');setOwner('all');setCustomer('all');setInitiator('all');setCategory('all');};
  const mediaFile=sel?.fileIds.map(id=>state?.files.find(file=>file.id===id)).find(file=>file?.mimeType.startsWith('image/'));
  const mediaUrl=mediaFile?fileUrl(mediaFile):'', [picture,setPicture]=React.useState<string>(),[pictureError,setPictureError]=React.useState(false),[pictureRetry,setPictureRetry]=React.useState(0);
  React.useEffect(()=>{let active=true,objectUrl='';const controller=new AbortController();setPicture(undefined);setPictureError(false);if(mediaUrl)void fetch(mediaUrl,{headers:apiService.getAuthHeaders(),credentials:'include',signal:controller.signal}).then(response=>{if(!response.ok)throw Error('图片读取失败');return response.blob();}).then(blob=>{if(active){objectUrl=URL.createObjectURL(blob);setPicture(objectUrl);}}).catch(()=>{if(active)setPictureError(true);});return()=>{active=false;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};},[mediaUrl,pictureRetry]);
  const open=(dev:MistDev)=>go('development/detail',dev.id,{versionId:dev.currentVersionId||undefined});
  // ≤1180px 不显示预览栏：点按一行直接打开开发案（触屏没有双击）。
  const compact=useCompactLayout();
  const owners=[...new Map((tab==='sourcing'?fabrics:domainDevs).filter(item=>item.ownerId).map(item=>[item.ownerId,item.owner] as const)).entries()];
  const move=async(id:string,column:string)=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setFailure('');try{await run({type:'development.move',payload:{devId:id,stage:Number(column)}});if(live.current)toast(`已更新开发阶段：${STAGES[Number(column)]}`);}catch(cause){if(live.current)setFailure(cause instanceof Error?cause.message:'阶段未变更');}finally{busyRef.current=false;if(live.current)setBusy(false);}};
  const showFabric=(fabric?:MistFabric)=>{setFabricId(fabric?.id||null);setFabricForm({name:fabric?.name||'',request:fabric?.request||'',ownerId:fabric?.ownerId||defaultMemberId(members,session?.user?.id),ownerName:fabric?.owner||'',due:fabric?.due||'',answer:fabric?.answer||'',note:'',fileIds:fabric?.fileIds||[]});setFailure('');setFabricOpen(true);};
  const saveFabric=async(action:'create'|'answer'|'approve'|'return')=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setFailure('');try{
    if(action==='create')await run({type:'fabric.create',payload:{name:fabricForm.name,request:fabricForm.request,ownerId:fabricForm.ownerId,due:fabricForm.due}});
    else if(action==='answer'&&fabricId)await run({type:'fabric.answer',payload:{id:fabricId,answer:fabricForm.answer,fileIds:fabricForm.fileIds}});
    else if(fabricId)await run({type:'fabric.confirm',payload:{id:fabricId,approved:action==='approve',note:fabricForm.note}});
    if(live.current){closeFabric();toast(action==='create'?'寻样任务已创建':action==='answer'?'寻样答复已保存':action==='approve'?'寻样结果已确认':'已提交补充要求');}
  }catch(cause){if(live.current)setFailure(cause instanceof Error?cause.message:'寻样操作失败');}finally{busyRef.current=false;if(live.current)setBusy(false);}};
  const sourcingCreate=tab==='sourcing'&&route.id===SOURCING_CREATE_ID,sourcingOpened=React.useRef(false);
  React.useEffect(()=>{if(sourcingCreate&&state&&!sourcingOpened.current){sourcingOpened.current=true;showFabric();}},[sourcingCreate,state]);
  /** 从「新建面料寻样」进入时，关闭表单回到寻样列表，避免刷新后重复打开。 */
  const closeFabric=()=>{setFabricOpen(false);if(sourcingCreate){const target=developmentListTarget('sourcing');go(target.view,target.id,target.target);}};
  const selectedFabric=fabrics.find(fabric=>fabric.id===fabricId);
  const uploadAnswer=async(files:File[])=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setFailure('');try{for(const file of files){const saved=await uploadFile(file);if(live.current)setFabricForm(form=>({...form,fileIds:[...new Set([...form.fileIds,saved.id])]}));}}catch(cause){if(live.current)setFailure(cause instanceof Error?cause.message:'上传失败');}finally{busyRef.current=false;if(live.current)setBusy(false);}};
  const recoverWrite=async()=>{if(!pending||busyRef.current)return;const original=pending;busyRef.current=true;setBusy(true);try{const receipt=await recover();if(!receipt||!live.current)return;if(original.kind==='upload'){const id=receipt.result.fileId||receipt.result.id;if(id)setFabricForm(form=>({...form,fileIds:[...new Set([...form.fileIds,id])]}));}else closeFabric();setFailure('');toast('原操作结果已核对');}catch(cause){if(live.current)setFailure(String(cause));}finally{busyRef.current=false;if(live.current)setBusy(false);}};
  const recovery=pending?<Button loading={busy||saving} onClick={()=>void recoverWrite()}>核对原操作结果</Button>:null;
  const columns:Column<MistDev>[]=[
    {key:'obj',header:'开发对象',width:'minmax(200px,2.2fr)',render:dev=><ObjectCell thumb={<Thumb {...(developmentDomain(dev.values)==='fabric'?{icon:Layers}:{src:IMG[dev.img]})} />} name={dev.name} meta={<><Mono>{dev.style}</Mono> · {dev.code} · {developmentInitiatorLabel(dev.values)}</>} />,sortValue:dev=>dev.name},
    {key:'owner',header:'负责人',width:'44px',hideOnMobile:true,render:dev=><Avatar name={dev.owner} size="sm" />},
    {key:'stage',header:'阶段',width:'112px',hideOnMobile:true,render:dev=><><StageProgress total={5} current={dev.stage} label={STAGES[dev.stage]} /><span className="mist-cell-sub" style={{marginTop:7}}>{STAGES[dev.stage]} · {dev.ver}</span></>,sortValue:dev=>dev.stage},
    {key:'due',header:'目标日期',width:'76px',hideOnMobile:true,render:dev=><div className={late(dev.due)?'mist-cell-late':undefined}><b className="mist-cell-strong">{shortDate(dev.due)}</b><span className="mist-cell-sub">{developmentDueText(dev.due)}</span></div>,sortValue:dev=>dev.due},
    {key:'state',header:'当前状态',width:'118px',render:dev=><Pill tone={dev.tone}>{dev.state}</Pill>},
    {key:'go',header:'',width:'16px',hideOnMobile:true,render:()=> <span className="mist-go"><Icon icon={ChevronRight} size="sm" /></span>},
  ];
  return <MistPage width={mode==='board'?'wide':undefined}>
    <PageHeader eyebrow="订单履约 · 开发" title="开发与寻样" description="成衣开发、面料开发与面料寻样分开记录；每一版都可追溯到工厂、实物与报告。" actions={<Button variant="primary" icon={Plus} disabled={!state} onClick={create}>{tabConfig.create}</Button>} />
    <Tabs value={tab} onChange={value=>switchTab(value)} options={DEVELOPMENT_LIST_TABS.map(item=>({value:item.value,label:item.label,count:tabCounts[item.value]}))} />
    <Toolbar right={domain&&!drafting?<Segmented ariaLabel="视图" value={mode} onChange={value=>setMode(value as 'list'|'board')} options={[{value:'list',icon:List,ariaLabel:'列表视图'},{value:'board',icon:Columns3,ariaLabel:'看板视图'}]} />:undefined}>
      <SearchField value={q} onChange={setQ} placeholder={tab==='sourcing'?'面料需求、编号或答复':drafting?'草稿名称、客户款号或客户':'名称、客户款式或编号'} />
      {!drafting&&<Dropdown label="负责人" value={owner} onChange={setOwner} options={[{value:'all',label:'全部'},...owners.map(([id,name])=>({value:id,label:owners.filter(([,other])=>other===name).length>1?`${name} · ${id}`:name}))]} />}
      {domain&&<Dropdown label="客户" value={customer} onChange={setCustomer} options={[{value:'all',label:'全部客户'},...(state?.customers.map(item=>({value:item.name,label:item.name}))||[])]} />}
      {domain&&<Dropdown label="发起方" value={initiator} onChange={setInitiator} options={[{value:'all',label:'全部'},{value:'customer',label:'客户要求'},{value:'internal',label:'内部需求'}]} />}
      {domain&&<Dropdown label={domain==='fabric'?'面料分类':'品类'} value={category} onChange={setCategory} options={[{value:'all',label:'全部'},...categories.map(name=>({value:name,label:name}))]} />}
    </Toolbar>
    {(failure||error)&&<div className="mist-section"><Banner tone="bad" title="操作未完成">{failure||error}</Banner></div>}
    {pending&&!saving&&<div className="mist-section"><Banner tone="warn" title="原操作结果尚待核对" actions={recovery}>已保留原请求，请先核对后再继续操作。</Banner></div>}
    {!domain?<Card><DataTable ariaLabel="面料寻样" loading={loading} rows={fabricRows} rowKey={fabric=>fabric.id} onRowClick={fabric=>showFabric(fabric)} columns={[
      {key:'n',header:'面料',width:'minmax(200px,2fr)',render:fabric=><ObjectCell thumb={<Thumb icon={Layers} />} name={fabric.name} meta={<><Mono>{fabric.code}</Mono> · {fabric.sub}</>} />},
      {key:'o',header:'发起人',width:'60px',hideOnMobile:true,render:fabric=><Avatar name={fabric.owner} size="sm" />},
      {key:'d',header:'目标日期',width:'80px',hideOnMobile:true,render:fabric=><b className="mist-cell-strong">{shortDate(fabric.due)}</b>},
      {key:'s',header:'状态',width:'120px',render:fabric=><Pill tone={fabric.tone}>{fabric.state}</Pill>},
    ]} empty={<EmptyState icon={SearchX} title={fabrics.length?'没有符合条件的寻样任务':'暂无面料寻样'} description={fabrics.length?'试试清除筛选或换个关键词':'在现有面料档案和供应商范围内发起寻样。'} />} footer={<span>{fabricRows.length} 个寻样任务 · {state?.settings.workspaceName||''}</span>} /></Card>:mode==='board'?<Kanban columns={STAGES.map((label,index)=>({id:String(index),title:label,color:STAGE_COLORS[index],items:filtered.filter(dev=>dev.stage===index)}))} itemKey={dev=>dev.id} onMove={busy?undefined:(id,column)=>void move(id,column)} onOpen={open} renderCard={dev=><><div className="mist-row"><Thumb {...(developmentDomain(dev.values)==='fabric'?{icon:Layers}:{src:IMG[dev.img]})} size="sm" /><div style={{minWidth:0}}><b>{dev.name}</b><div className="mist-obj-meta"><Mono>{dev.code}</Mono></div></div></div><div className="mist-kb-card-foot"><Pill tone={dev.tone}>{dev.state}</Pill><span className="mist-spacer" /><Avatar name={dev.owner} size="xs" />{shortDate(dev.due)}</div></>} />:<>
      <Pipeline<StageFilter> value={stage} onChange={chooseStage} items={[{value:-1,label:'全部',count:scoped.length,color:'var(--mist-ink-2)'},...STAGES.map((label,index)=>({value:index,label,count:scoped.filter(dev=>dev.stage===index).length,color:STAGE_COLORS[index]})),{value:'draft',label:'草稿',count:draftRows.length,color:'var(--mist-ink-3)'}]} />
      {drafting?<Card><DataTable ariaLabel={tabConfig.label+'草稿'} loading={loading} rows={draftRows} rowKey={draft=>draft.id} onRowClick={draft=>go('development/new',draft.id,{section:developmentDomain(draft.values)})} columns={[
        {key:'name',header:'开发草稿',width:'minmax(200px,2fr)',render:draft=><ObjectCell thumb={<Thumb icon={Layers} />} name={draft.values.name||'未命名草稿'} meta={draft.values.style||(domain==='fabric'?'面料开发草稿':'待补客户款号')} />},
        {key:'customer',header:'客户',render:draft=>draft.values.customer||'待选择'},
        {key:'updated',header:'保存时间',render:draft=>new Date(draft.updatedAt).toLocaleString()},
      ]} empty={<EmptyState title={domainDrafts.length?'没有符合条件的草稿':'暂无'+tabConfig.label+'草稿'} description={domainDrafts.length?'试试清除筛选或换个关键词':'在'+tabConfig.create+'中保存草稿后，可在这里继续填写。'} />} footer={<span>{draftRows.length} 份草稿 · {state?.settings.workspaceName||''}</span>} /></Card>:<>
      <div className="mist-split"><Card><DataTable ariaLabel={tabConfig.label+'案'} loading={loading} columns={columns} rows={rows} rowKey={dev=>dev.id} selectedKey={sel?.id} density="comfy" onRowClick={dev=>compact?open(dev):setSelected(dev.id)} onRowDoubleClick={open} empty={<EmptyState icon={SearchX} title="没有符合条件的开发案" description="试试清除筛选或换个关键词" action={<TextLink onClick={clearFilters}>清除筛选</TextLink>} />} footer={<><span>{filtered.length} 个{tabConfig.label}案 · {state?.settings.workspaceName||''}</span><TextLink icon={Download} disabled={!filtered.length} onClick={()=>downloadDevelopmentCsv(filtered,tabConfig.label)}>导出</TextLink><Pagination page={currentPage} pages={pages} onChange={setPage} /></>} /></Card>
        <Card as="aside" className="mist-preview">{sel?<>{(mediaFile&&!picture)||developmentDomain(sel.values)==='fabric'&&!picture?<div className="mist-stage"><EmptyState icon={Layers} title={!mediaFile?'尚未上传实物图片':pictureError?'图片读取失败':'正在读取图片'} description={mediaFile?.name||'打开开发案查看准确版本与返样记录'} action={pictureError?<TextLink onClick={()=>setPictureRetry(value=>value+1)}>重试</TextLink>:undefined} /></div>:<ObjectStage src={picture||IMG[sel.img]} alt={sel.name} topLeft={<Pill tone={sel.tone}>{sel.state}</Pill>} topRight={sel.ver} />}<div className="mist-preview-b"><div><span className="mist-mono mist-muted" style={{fontSize:12}}>{sel.style}</span><div className="mist-h2" style={{fontSize:19,marginTop:4}}>{sel.name}</div><p className="mist-sub" style={{fontSize:13,marginTop:8}}>{sel.goal}</p></div><Facts items={[{label:'负责人',value:sel.owner},{label:'目标日期',value:shortDate(sel.due)},{label:'工厂',value:sel.factory},{label:'参与工厂',value:`${sel.fac} 家`}]} /><Button variant="primary" block iconRight={ArrowRight} onClick={()=>open(sel)}>打开开发案</Button></div></>:<EmptyState icon={Layers} title="开发案预览" description="从列表选择开发对象" />}</Card>
      </div>
      </>}
    </>}
    <Dialog open={fabricOpen} onClose={()=>{if(!busy)closeFabric();}} title={fabricId?'面料寻样详情':'新建面料寻样'} description={selectedFabric?.code} footer={<>{recovery}<Button variant="quiet" disabled={busy} onClick={closeFabric}>关闭</Button>{fabricId?<>{!selectedFabric?.confirmed&&<><Button variant="quiet" loading={busy} disabled={!fabricForm.answer.trim()} onClick={()=>void saveFabric('answer')}>保存寻样答复</Button><Button variant="quiet" disabled={busy||!fabricForm.note.trim()} onClick={()=>void saveFabric('return')}>补充要求</Button><Button variant="primary" loading={busy} disabled={!selectedFabric?.answer} onClick={()=>void saveFabric('approve')}>确认结果</Button></>}</>:<Button variant="primary" loading={busy} disabled={!fabricForm.name.trim()||!fabricForm.request.trim()||!fabricForm.ownerId} onClick={()=>void saveFabric('create')}>创建寻样任务</Button>}</>}>
      {failure&&<Banner tone="bad" title="寻样操作未完成">{failure}</Banner>}
      <FormGrid>
        <Field label="面料需求" required><TextInput readOnly={!!fabricId} value={fabricForm.name} onChange={event=>setFabricForm(form=>({...form,name:event.target.value}))} /></Field>
        <Field label="负责人" required hint={fabricId?undefined:'按账号选择本空间成员'}>{fabricId?<TextInput readOnly value={fabricForm.ownerName} />:<Select aria-label="负责人" value={fabricForm.ownerId} placeholder="选择负责人" onChange={event=>setFabricForm(form=>({...form,ownerId:event.target.value}))} options={memberSelectOptions(members)} />}</Field>
        <Field label="目标日期"><TextInput readOnly={!!fabricId} type="date" value={fabricForm.due} onChange={event=>setFabricForm(form=>({...form,due:event.target.value}))} /></Field>
        <Field label="具体要求" full required><TextArea readOnly={!!fabricId} value={fabricForm.request} onChange={event=>setFabricForm(form=>({...form,request:event.target.value}))} /></Field>
        {fabricId&&<><Field label="寻样答复" full><TextArea readOnly={selectedFabric?.confirmed} value={fabricForm.answer} onChange={event=>setFabricForm(form=>({...form,answer:event.target.value}))} /></Field><Field label="确认或补充说明" full><TextArea readOnly={selectedFabric?.confirmed} value={fabricForm.note} onChange={event=>setFabricForm(form=>({...form,note:event.target.value}))} /></Field></>}
      </FormGrid>
      {fabricId&&!selectedFabric?.confirmed&&<UploadZone hint="上传候选面料资料" onFiles={files=>void uploadAnswer(files)} />}
      {fabricForm.fileIds.map(id=>{const file=state?.files.find(item=>item.id===id);return file?<div className="mist-row mist-section" key={id}><span>{file.name}</span><TextLink onClick={()=>void downloadFile(file).catch(cause=>setFailure(String(cause)))}>下载</TextLink>{!selectedFabric?.confirmed&&<TextLink onClick={()=>setFabricForm(form=>({...form,fileIds:form.fileIds.filter(item=>item!==id)}))}>移除</TextLink>}</div>:null;})}
    </Dialog>
  </MistPage>;
}
