import React from 'react';
import { ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import {
  Agenda, Banner, Button, Card, CardBody, CardFooter, CardHeader, EmptyState, Field, FormGrid,
  MistPage, PageHeader, Select, Skeleton, TextArea, TextInput, TextLink, Toolbar, WeekStrip, useToast,
} from '../../../../components/mist';
import type { MistCalendarEvent, MistTarget } from '../../../../server/src/shared/mistWorkspace';
import { useMistWorkspace } from '../runtime/workspace';
import { useMistSession } from '../runtime/auth';
import { useNav } from '../nav';

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const parseDay = (date: string) => new Date(`${date}T12:00:00`);
const shiftDay = (date: string, distance: number) => { const result=parseDay(date); result.setDate(result.getDate()+distance); return dayKey(result); };
export function calendarWeek(date: string) {
  const selected=parseDay(date),offset=(selected.getDay()+6)%7,first=shiftDay(date,-offset);
  return Array.from({length:7},(_,index)=>({key:shiftDay(first,index),weekday:['一','二','三','四','五','六','日'][index],day:parseDay(shiftDay(first,index)).getDate()}));
}
export function calendarFormError(form: {title:string;date:string;time:string}) {
  if(!form.title.trim())return '请填写日程名称';
  const parsed=parseDay(form.date);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(form.date)||Number.isNaN(parsed.getTime())||dayKey(parsed)!==form.date)return '请选择有效日期';
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time))return '请选择有效时间';
  return null;
}

export function CalendarPage() {
  const {go,route}=useNav();const {state,workspace,loading,error,run,refresh,pending,recover,saving}=useMistWorkspace();const session=useMistSession();const toast=useToast();
  const scopeKey=`${session.sessionKey}:${workspace?.id||''}`;
  const [selected,setSelected]=React.useState(()=>dayKey(new Date()));
  const [editing,setEditing]=React.useState<string|null|undefined>(undefined);
  const [form,setForm]=React.useState({title:'',date:selected,time:'09:00',note:'',targetKey:''});
  const [originalTarget,setOriginalTarget]=React.useState<MistTarget|undefined>();
  const [busy,setBusy]=React.useState(false),[failure,setFailure]=React.useState('');
  const [formScope,setFormScope]=React.useState(scopeKey);
  const live=React.useRef(true),locked=React.useRef(false),scope=React.useRef(scopeKey),sequence=React.useRef(0);
  if(scope.current!==scopeKey){scope.current=scopeKey;sequence.current++;locked.current=false;}
  const activeEditing=formScope===scopeKey?editing:undefined;
  const visibleFailure=formScope===scopeKey?failure:'';
  React.useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  React.useEffect(()=>{setEditing(undefined);setForm({title:'',date:dayKey(new Date()),time:'09:00',note:'',targetKey:''});setOriginalTarget(undefined);setFailure('');setBusy(false);setFormScope(scopeKey);},[scopeKey]);
  const events=(state?.calendar||[]).filter(event=>event.date===selected).slice().sort((a,b)=>a.time.localeCompare(b.time)||a.title.localeCompare(b.title));
  const week=calendarWeek(selected).map(day=>({...day,dots:(state?.calendar||[]).filter(event=>event.date===day.key).length}));
  React.useEffect(()=>{if(route.section&&!calendarFormError({title:'日期',date:route.section,time:'09:00'}))setSelected(route.section);},[route.section]);
  React.useEffect(()=>{if(activeEditing!==undefined){const editor=document.getElementById('mist-calendar-editor');editor?.scrollIntoView?.({behavior:'smooth',block:'start'});editor?.querySelector<HTMLInputElement>('input')?.focus();}},[activeEditing]);
  const targets: Array<{value:string;label:string;target:MistTarget}>= [
    ...(state?.devs.map(dev=>({value:`development:${dev.id}`,label:`${dev.code} · ${dev.name}`,target:{view:'development/detail',id:dev.id,versionId:dev.currentVersionId||undefined}}))||[]),
    ...(state?.orders.map(order=>({value:`order:${order.id}`,label:`${order.code} · ${order.customer}`,target:{view:'orders/detail',id:order.id}}))||[]),
  ];
  const open = (event?: MistCalendarEvent) => {
    if(locked.current||activeEditing!==undefined||loading||saving||pending||!state)return;
    const targetKey=event?.target ? 'original' : '';
    setFormScope(scopeKey);setEditing(event?.id??null);setForm({title:event?.title||'',date:event?.date||selected,time:event?.time||'09:00',note:event?.note||'',targetKey});setOriginalTarget(event?.target);setFailure('');
  };
  const link = (target:MistTarget) => go(target.view,target.id,target);
  const save = async () => {
    if(locked.current||!state||loading||saving||pending||formScope!==scopeKey)return;const invalid=calendarFormError(form);if(invalid){setFailure(invalid);return;}
    const target=form.targetKey==='original'?originalTarget:targets.find(choice=>choice.value===form.targetKey)?.target;
    if(form.targetKey&&form.targetKey!=='original'&&!target){setFailure('关联业务已不可用，请重新选择或取消关联');return;}
    const ticket=++sequence.current,owns=()=>live.current&&scope.current===scopeKey&&sequence.current===ticket;
    locked.current=true;setBusy(true);setFailure('');
    try {await run({type:'calendar.save',payload:{...(editing?{id:editing}:{}),title:form.title.trim(),date:form.date,time:form.time,note:form.note,...(target?{target}:{})}});if(owns()){setSelected(form.date);setEditing(undefined);toast(editing?'日程已更新':'日程已创建');}}
    catch(cause){if(owns())setFailure(cause instanceof Error?cause.message:'日程保存失败，请重试');}
    finally{if(owns()){locked.current=false;setBusy(false);}}
  };
  const retry = async () => {if(locked.current)return;const bound=scopeKey;setFailure('');try{await refresh();}catch(cause){if(live.current&&scope.current===bound)setFailure(String(cause));}};
  const resolve = async () => {if(locked.current||loading||saving)return;const original=pending,ticket=++sequence.current,owns=()=>live.current&&scope.current===scopeKey&&sequence.current===ticket;locked.current=true;setBusy(true);try{const receipt=await recover();if(receipt&&owns()){if(original?.command?.type==='calendar.save')setEditing(undefined);setFailure('');toast('原操作结果已核对');}}catch(cause){if(owns())setFailure(String(cause));}finally{if(owns()){locked.current=false;setBusy(false);}}};
  const recovery=pending?<Button loading={busy||saving} onClick={()=>void resolve()}>核对原操作结果</Button>:null;
  return <MistPage>
    <PageHeader eyebrow="我的事务 · 日历" title="日历" description="查看本周安排，记录日程并返回关联业务。" actions={<Button variant={activeEditing===undefined?'primary':'quiet'} icon={Plus} disabled={!state||loading||saving||!!pending||busy||activeEditing!==undefined} onClick={()=>open()}>新建日程</Button>} />
    <Toolbar right={<Button icon={RefreshCw} loading={loading} disabled={busy||saving} onClick={()=>void retry()}>刷新</Button>}>
      <Button icon={ChevronLeft} aria-label="上一周" onClick={()=>setSelected(date=>shiftDay(date,-7))}>上一周</Button>
      <Button onClick={()=>setSelected(dayKey(new Date()))}>今天</Button>
      <Button iconRight={ChevronRight} aria-label="下一周" onClick={()=>setSelected(date=>shiftDay(date,7))}>下一周</Button>
    </Toolbar>
    {(visibleFailure||error)&&<div className="mist-section"><Banner tone="bad" title="日程操作未完成" actions={<Button onClick={()=>void retry()}>重试读取</Button>}>{visibleFailure||error}</Banner></div>}
    {pending&&!saving&&<div className="mist-section"><Banner tone="warn" title="原操作结果尚待核对" actions={recovery}>核对原请求后再继续保存。</Banner></div>}
    <Card>
      <CardHeader title={parseDay(selected).toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'})} tools={<span className="mist-muted">{events.length} 项安排</span>} />
      <WeekStrip days={week} value={selected} onChange={setSelected} />
      {loading?<div className="mist-card-body"><Skeleton height={56} /><Skeleton height={56} /></div>:events.length?<Agenda events={events.map(event=>({time:event.time,title:<TextLink disabled={activeEditing!==undefined||saving||!!pending} onClick={()=>open(event)}>{event.title}</TextLink>,meta:<><span>{event.note}</span>{event.target&&<TextLink iconRight={ArrowUpRight} onClick={()=>link(event.target!)}>打开关联业务</TextLink>}</>}))} />:<EmptyState icon={CalendarDays} title="当天暂无日程" description="可以添加会议、跟进或工作安排。" action={<Button disabled={!state||loading||saving||!!pending||activeEditing!==undefined} onClick={()=>open()}>添加日程</Button>} />}
    </Card>
    {activeEditing!==undefined&&<Card as="section" id="mist-calendar-editor" className="mist-section" aria-label={editing?'编辑日程':'新建日程'} data-calendar-editor>
      <CardHeader title={editing?'编辑日程':'新建日程'} sub="日程保存到当前工作空间。" />
      <form onSubmit={event=>{event.preventDefault();void save();}}><CardBody>
      {visibleFailure&&<Banner tone="bad" title="日程未保存">{visibleFailure}</Banner>}
      <fieldset disabled={busy||saving||!!pending} style={{border:0,padding:0,margin:0}}><FormGrid>
        <Field label="日程名称" required full><TextInput value={form.title} onChange={event=>setForm(previous=>({...previous,title:event.target.value}))} /></Field>
        <Field label="日期" required><TextInput type="date" value={form.date} onChange={event=>setForm(previous=>({...previous,date:event.target.value}))} /></Field>
        <Field label="时间" required><TextInput type="time" value={form.time} onChange={event=>setForm(previous=>({...previous,time:event.target.value}))} /></Field>
        <Field label="关联业务" full><Select value={form.targetKey} onChange={event=>setForm(previous=>({...previous,targetKey:event.target.value}))} options={[{value:'',label:'不关联业务'},...(form.targetKey==='original'?[{value:'original',label:'保留原业务关联'}]:[]),...targets.map(({value,label})=>({value,label}))]} /></Field>
        <Field label="安排说明" full><TextArea value={form.note} onChange={event=>setForm(previous=>({...previous,note:event.target.value}))} /></Field>
      </FormGrid></fieldset>
      </CardBody><CardFooter>{recovery}<span className="mist-spacer" /><Button variant="quiet" disabled={busy} onClick={()=>setEditing(undefined)}>取消</Button><Button type="submit" variant="primary" loading={busy} disabled={!state||loading||saving||!!pending}>保存日程</Button></CardFooter></form>
    </Card>}
  </MistPage>;
}
