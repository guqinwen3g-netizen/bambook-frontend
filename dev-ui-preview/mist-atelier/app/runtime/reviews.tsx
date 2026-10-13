import React from 'react';
import { ClipboardCheck } from 'lucide-react';
import { apiService } from '../../../../services/apiService';
import type { MistReviewTask } from '../../../../server/src/shared/mistReview';
import { Banner, Button, Card, CardHeader, Dialog, Drawer, EmptyState, IconButton, KeyValue, Pill, Tabs, TextArea, useToast } from '../../../../components/mist';
import { useMistSession } from './auth';
import { useMistWorkspace } from './workspace';
type Review = MistReviewTask & {workspaceId:string;workspaceName:string;revision:number;canDecide:boolean;files?:Array<{id:string;name:string;size:number}>};
type ReviewIntent={workspaceId:string;reviewId:string;requestId:string;expectedRevision:number;decision:'approved'|'rejected';note:string};
async function call(path:string,body?:unknown){
  const response=await fetch('/api/mist/reviews'+path,{method:body?'POST':'GET',headers:apiService.getAuthHeaders(),credentials:'include',...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json().catch(()=>null);if(!response.ok)throw Object.assign(new Error(data?.error?.message||'审批记录读取失败'),{status:response.status});return data;
}
export function MistReviewButton(){
  const session=useMistSession(),workspace=useMistWorkspace(),toast=useToast(),identity=session.sessionKey;
  const ref=React.useRef(identity);ref.current=identity;
  const currentWorkspace=React.useRef(workspace);currentWorkspace.current=workspace;
  const [open,setOpen]=React.useState(false),[rows,setRows]=React.useState<Review[]>([]),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[tab,setTab]=React.useState<'pending'|'history'>('pending');
  const [selected,setSelected]=React.useState<Review|null>(null),[decision,setDecision]=React.useState<'approved'|'rejected'>('approved'),[note,setNote]=React.useState(''),[intent,setIntent]=React.useState<ReviewIntent|null>(null);
  const locked=React.useRef(false),requestCounter=React.useRef(0),key='bambook.mist.review-pending:'+session.user?.id;
  const refresh=React.useCallback(async()=>{if(session.status!=='authenticated')return;const sequence=++requestCounter.current;try{const data=await call('');if(identity===ref.current&&sequence===requestCounter.current){setRows(Array.isArray(data.reviews)?data.reviews:[]);setError('');}}catch(e){if(identity===ref.current&&sequence===requestCounter.current)setError(e instanceof Error?e.message:'无法读取审批');}},[identity,session.status]);
  React.useEffect(()=>{ref.current=identity;setRows([]);setSelected(null);setIntent(null);setOpen(false);locked.current=false;setBusy(false);requestCounter.current++;if(session.status!=='authenticated')return;try{const value=localStorage.getItem(key);if(value){const saved=JSON.parse(value);if(saved?.workspaceId&&saved?.requestId&&saved?.reviewId&&['approved','rejected'].includes(saved.decision))setIntent(saved);}}catch{setError('本机审批恢复记录无法读取');}void refresh();const timer=window.setInterval(()=>void refresh(),30000);return()=>{window.clearInterval(timer);if(ref.current===identity)ref.current='';};},[identity,session.status,key,refresh]);
  const persist=(next:ReviewIntent|null)=>{if(next)localStorage.setItem(key,JSON.stringify(next));else localStorage.removeItem(key);setIntent(next);};
  const refreshCurrentWorkspace=async(workspaceId:string)=>{
    if(identity!==ref.current||currentWorkspace.current.workspace?.id!==workspaceId)return;
    try{await currentWorkspace.current.refresh();}
    catch(e){if(identity===ref.current&&currentWorkspace.current.workspace?.id===workspaceId)setError('审批已保存，但当前工作区刷新失败：'+(e instanceof Error?e.message:'请重新读取工作区'));}
  };
  const execute=async(next:ReviewIntent)=>{
    if(locked.current||identity!==ref.current)return;locked.current=true;setBusy(true);setError('');
    try{persist(next);const result=await call('/'+encodeURIComponent(next.workspaceId)+'/'+encodeURIComponent(next.reviewId),{requestId:next.requestId,expectedRevision:next.expectedRevision,decision:next.decision,note:next.note});if(result.receipt?.requestId!==next.requestId)throw new Error('审批回执与原请求不符');if(identity===ref.current){persist(null);setSelected(null);setNote('');toast('审批决定已保存');await refresh();await refreshCurrentWorkspace(next.workspaceId);}}
    catch(e:any){if(identity===ref.current){if(e.status>=400&&e.status<500)persist(null);setError((e instanceof Error?e.message:'操作未完成')+(e.status?'':'；请核对原审批请求'));}}
    finally{if(identity===ref.current){locked.current=false;setBusy(false);}}
  };
  const recover=async()=>{if(!intent||locked.current)return;setBusy(true);try{const data=await call('/'+encodeURIComponent(intent.workspaceId)+'/receipts/'+encodeURIComponent(intent.requestId));if(data.receipt?.requestId!==intent.requestId)throw new Error('审批回执不一致');if(identity===ref.current){persist(null);setSelected(null);await refresh();await refreshCurrentWorkspace(intent.workspaceId);toast('原审批结果已核对');}}catch(e:any){if(identity!==ref.current)return;if(e.status===404){setBusy(false);await execute(intent);}else setError(e instanceof Error?e.message:'核对失败');}finally{if(identity===ref.current)setBusy(false);}};
  const download=async(row:Review,file:{id:string;name:string})=>{try{const response=await fetch('/api/mist/reviews/'+encodeURIComponent(row.workspaceId)+'/'+encodeURIComponent(row.id)+'/files/'+encodeURIComponent(file.id),{headers:apiService.getAuthHeaders(),credentials:'include'});if(!response.ok)throw new Error('审批附件读取失败');const bytes=await response.blob();if(identity!==ref.current)return;const url=URL.createObjectURL(bytes),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){if(identity===ref.current)setError(e instanceof Error?e.message:'附件读取失败');}};
  const filtered=rows.filter(r=>tab==='pending'?r.status==='pending':r.status!=='pending');
  return <><IconButton icon={ClipboardCheck} label="审批事项" dot={!!intent||rows.some(r=>r.canDecide)} onClick={()=>{setOpen(true);void refresh();}}/>
    <Drawer open={open} onClose={()=>{if(!busy)setOpen(false);}} title="审批事项" sub="按授权查看提交快照，决定后返回原业务" footer={<Button disabled={busy} onClick={()=>void refresh()}>刷新记录</Button>}>
      {error&&<Banner tone="bad" title={error}/>}{intent&&<Banner tone="warn" title="有审批结果待核对" actions={<Button loading={busy} onClick={()=>void recover()}>核对原请求</Button>}/>}
      <Tabs<'pending'|'history'> value={tab} onChange={setTab} options={[{value:'pending',label:'待处理',count:rows.filter(r=>r.status==='pending').length},{value:'history',label:'处理记录'}]}/>
      {filtered.length?filtered.map(row=><Card key={row.workspaceId+row.id}><CardHeader title={row.title} sub={row.workspaceName} tools={<Pill tone={row.status==='approved'?'ok':row.status==='rejected'?'bad':'warn'}>{row.status==='approved'?'已批准':row.status==='rejected'?'已退回':'待审批'}</Pill>}/><div className="mist-card-body"><KeyValue items={row.details}/>{row.files?.map(file=><p key={file.id}><Button onClick={()=>void download(row,file)}>{file.name}</Button></p>)}<Button disabled={!row.canDecide||busy||!!intent} onClick={()=>{setSelected(row);setNote('');}}>核对与决定</Button></div></Card>):<EmptyState title={tab==='pending'?'没有待处理审批':'暂无处理记录'} description="审批按当前账号与实际授权显示。"/>}
    </Drawer>
    <Dialog open={!!selected} onClose={()=>{if(!busy)setSelected(null);}} title={selected?.title||'审批决定'} description="此决定将保存到提交的业务版本" footer={<><Button disabled={busy} onClick={()=>setSelected(null)}>取消</Button><Button variant={decision==='approved'?'primary':'danger'} loading={busy} disabled={!note.trim()||!!intent} onClick={()=>{if(selected)void execute({workspaceId:selected.workspaceId,reviewId:selected.id,requestId:crypto.randomUUID(),expectedRevision:selected.revision,decision,note:note.trim()});}}>保存决定</Button></>}>
      {selected&&<KeyValue items={selected.details}/>}<Tabs<'approved'|'rejected'> value={decision} onChange={setDecision} options={[{value:'approved',label:'批准'},{value:'rejected',label:'退回'}]}/><TextArea aria-label="审批意见" placeholder="填写本次决定的依据或退回意见" value={note} disabled={busy} onChange={e=>setNote(e.target.value)}/>
    </Dialog>
  </>;
}
