// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMistState, applyMistCommand, type MistCommand } from '../../../../server/src/shared/mistWorkspace';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { Nav } from '../nav';
const seam = vi.hoisted(() => ({ value: null as any, session: { sessionKey: 'one', user: { id: 'owner', displayName: '当前员工' }, hasPermission: () => true,canAccessView:(_view:string):boolean=>true } }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => seam.value }));
vi.mock('../runtime/auth', () => ({ useMistSession: () => seam.session }));
import { HomePage } from './HomePage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLElement, count = 0;
const go = vi.fn(), openAI = vi.fn();
const ctx = () => ({ id: () => `record-${++count}`, now: new Date().toISOString(), actorName: '当前员工' });
const element = () => <MistRoot><ToastProvider><Nav.Provider value={{ route: { view: 'cockpit' }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI }}><HomePage /></Nav.Provider></ToastProvider></MistRoot>;
function paint() { root!.render(element()); }
function render() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(paint); }
function button(text: string, scope: ParentNode = host) { const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text); expect(value).toBeDefined(); return value!; }
async function click(target: HTMLElement) { await act(async () => target.click()); }
beforeEach(() => {
  vi.clearAllMocks(); count = 0; seam.session = { sessionKey: 'one', user: { id: 'owner', displayName: '当前员工' }, hasPermission: () => true,canAccessView:(_view:string):boolean=>true };
  const state = createMistState(ctx(), 'demo'), dev = state.devs[0], version = state.versions.find(item => item.id === dev.currentVersionId)!;
  dev.name = '服务器里的开发对象'; version.qc = { result: 'conditional', reviewer: '真实评审人', reviewedAt: '2026-10-13', report: 'QC-REAL', opinion: '保留问题需跟进' };
  const today = new Date(), key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  state.tasks = [{ id: 'task-exact', title: '完成准确版本事项', due: key, done: false, kind: 'development', target: { view: 'development/detail', id: dev.id, versionId: version.id } }];
  state.invoices.push({ ...state.invoices[0], id: 'euro-open', code: 'EUR-OPEN', currency: 'EUR', amount: 77, open: 77 });
  state.calendar = [{ id: 'event-real', title: '实际约定', date: key, time: '14:00', note: '实际参与安排' }];
  seam.value = { state, workspace: { id: 'workspace-one', name: '真实工作区' }, loading: false, saving: false, pending: null, error: '', refresh: vi.fn(), recover: vi.fn(),
    run: vi.fn(async (command: MistCommand) => { seam.value.state = applyMistCommand(seam.value.state, command, ctx()).state; paint(); return { requestId: 'request', revision: 1, result: {} }; }) };
});
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; });
describe('original Mist Home workspace functionality', () => {
  it('retains the T1 composition and reads identity, focus, calendar and currency-separated totals from the workspace', () => {
    render(); expect(host.querySelector('.mist-page-head')?.textContent).toContain('当前员工'); expect(host.querySelectorAll('.mist-stat')).toHaveLength(4);
    expect(host.querySelector('.mist-hero')?.classList.contains('mist-col-8')).toBe(true); expect(host.querySelector('.mist-brief')?.classList.contains('mist-col-4')).toBe(true);
    expect(host.querySelector('.mist-hero')?.textContent).toContain('服务器里的开发对象'); expect(host.textContent).toContain('实际约定');
    expect(host.querySelectorAll('.mist-task')).toHaveLength(1); expect(host.querySelectorAll('.mist-spark')).toHaveLength(0);
    const receivables = host.querySelectorAll('.mist-stat')[3]; expect(receivables.textContent).toContain('USD'); expect(receivables.textContent).toContain('EUR');
  });
  it('opens the exact task version and exposes actual QC data', async () => {
    render(); const task = seam.value.state.tasks[0]; await click(host.querySelector<HTMLElement>('.mist-task')!);
    expect(go).toHaveBeenCalledWith('development/detail', task.target.id, task.target);
    await click(button('QC 报告')); const dialog = host.querySelector('[role="dialog"]'); expect(dialog?.textContent).toContain('真实评审人'); expect(dialog?.textContent).toContain('有保留通过'); expect(dialog?.textContent).toContain('保留问题需跟进');
  });
  it('persists task completion and removes the item only after the command succeeds', async () => {
    render(); await click(button('管理任务')); const dialog = host.querySelector('[role="dialog"]')!;
    await click(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!); await click(button('保存状态', dialog));
    expect(seam.value.run).toHaveBeenCalledWith({ type: 'task.complete', payload: { id: 'task-exact', done: true } }); expect(seam.value.state.tasks[0].done).toBe(true); expect(host.querySelector('.mist-task')).toBeNull();
  });
  it('does not fake completion on failure and clears prior task UI when workspace changes', async () => {
    seam.value.run.mockRejectedValue(new Error('未保存')); render(); await click(button('管理任务')); let dialog = host.querySelector('[role="dialog"]')!;
    await click(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!); await click(button('保存状态', dialog));
    expect(seam.value.state.tasks[0].done).toBe(false); expect(host.querySelector('.mist-task')).toBeTruthy(); expect(host.textContent).toContain('未保存');
    const state = createMistState(ctx(), 'empty'); seam.value = { ...seam.value, state, workspace: { id: 'workspace-two', name: '空工作区' } }; await act(async () => paint());
    expect(host.textContent).not.toContain('完成准确版本事项'); expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(host.textContent).toContain('当前没有待处理事项');
  });
  it('marks the selected real notification read before navigating to its target', async () => {
    render(); const notification = seam.value.state.notifications[0]; const entry = [...host.querySelectorAll<HTMLButtonElement>('.mist-brief button')].find(item => item.textContent?.includes(notification.title))!;
    await click(entry); expect(seam.value.run).toHaveBeenCalledWith({ type: 'notification.read', payload: { id: notification.id } }); expect(go).toHaveBeenCalledWith(notification.target.view, notification.target.id, notification.target);
  });
  it('opens the exact approved claim from both the returned notification and undated business task',async()=>{
    let state=seam.value.state;state.tasks=[];state.notifications=[];state.settings.notifications.qc=false;state.settings.notifications.shipping=false;
    let sequence=0;const original=state.invoices[0],actor={...ctx(),actorId:'sales',authority:{supplier:{},claimReviewerId:'leader'},consumeBusinessNumber:(prefix:string)=>prefix+'-2026-'+String(++sequence).padStart(5,'0')};
    const apply=(command:MistCommand,context=actor)=>{const next=applyMistCommand(state,command,context);state=next.state;return next.result;};
    const claimId=apply({type:'platform.claim.create',payload:{orderId:original.orderId,invoiceId:original.id,problem:'独立审批回程验收',fileIds:[]}}).id!;
    const dispositionId=apply({type:'platform.claim.disposition',payload:{claimId,kind:'Allowance',amount:15,quantity:0,unit:'',returnDisposition:'',basis:'仅折让审批回程验收，尚未执行',fileIds:[]}}).id!;
    apply({type:'platform.claim.submit',payload:{id:dispositionId}});apply({type:'platform.claim.decide',payload:{id:dispositionId,decision:'approved',note:'核对事实通过'}},{...actor,actorId:'leader',actorName:'实际售后负责人'});
    seam.value.state=state;render();const task=state.tasks.find((item:any)=>item.kind==='claim-execution:'+dispositionId);expect(task.due).toBe('');expect(host.textContent).toContain('未定期限');
    await click(host.querySelector<HTMLElement>('.mist-task')!);expect(go).toHaveBeenLastCalledWith('claims',claimId,{view:'claims',id:claimId});
    const notice=state.notifications.find((item:any)=>item.target.id===claimId),entry=[...host.querySelectorAll<HTMLButtonElement>('.mist-brief button')].find(item=>item.textContent?.includes(notice.title))!;
    expect(notice.detail).toContain('实际售后负责人');await click(entry);expect(seam.value.run).toHaveBeenCalledWith({type:'notification.read',payload:{id:notice.id}});expect(go).toHaveBeenLastCalledWith('claims',claimId,{view:'claims',id:claimId});
    expect(seam.value.state.platform.claims.find((item:any)=>item.id===claimId).dispositions[0].state).toBe('approved');expect(seam.value.state.platform.credits).toEqual([]);
  });
  it('does not describe a failed source as zero pending work', () => {
    seam.value = { ...seam.value, state: null, loading: false, error: '工作区读取失败' }; render();
    expect(host.textContent).toContain('工作空间尚未读取成功'); expect(host.textContent).not.toContain('当前有 0 件事'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('工作区读取失败');
  });
});
it('counts actual weekly shipments and opens exactly that filtered set',async()=>{const today=new Date(),day=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;seam.value.state.fulfillment.shipments=[{id:'weekly',code:'SHIP-WEEK',customer:'实际客户',state:'preparing',plannedDate:day},{id:'cancelled',code:'SHIP-CANCEL',customer:'客户',state:'cancelled',plannedDate:day},{id:'later',code:'SHIP-LATER',customer:'客户',state:'preparing',plannedDate:'2099-01-01'}];render();const card=host.querySelectorAll<HTMLElement>('.mist-stat')[2];expect(card.textContent).toContain('1');await click(card);const dialog=host.querySelector('[role=dialog]')!;expect(dialog.textContent).toContain('SHIP-WEEK');expect(dialog.textContent).not.toContain('SHIP-LATER');await click(button('SHIP-WEEK · 实际客户 · '+day,dialog));expect(go).toHaveBeenCalledWith('shipments','weekly',{view:'shipments',id:'weekly'});});
it('deduplicates returned versions already represented by a pending QC task',async()=>{const version=seam.value.state.versions[0];version.qc=null;version.returnedAt=new Date().toISOString();seam.value.state.versions=[version];seam.value.state.fulfillment.qcTasks=[{id:'qc-actual',code:'QC-ACTUAL',state:'pending',kind:'sample',factory:'实际工厂',source:{kind:'version',versionId:version.id,devId:version.devId}}];render();await click(host.querySelectorAll<HTMLElement>('.mist-stat')[1]);const dialog=host.querySelector('[role=dialog]')!;expect(dialog.querySelectorAll('button')).toHaveLength(2);await click(button('QC-ACTUAL · 实际工厂 · 样品评审',dialog));expect(go).toHaveBeenCalledWith('qc-workbench','qc-actual',{view:'qc-workbench',id:'qc-actual'});});
it('does not surface an out-of-range future task as today focus',()=>{seam.value.state.tasks=[{id:'future',title:'远期事项',due:'2099-01-01',done:false,kind:'future',target:{view:'orders/detail',id:'future-order'}}];render();expect(host.querySelector('.mist-hero')?.textContent).not.toContain('远期事项');expect(host.querySelector('.mist-hero')?.textContent).toContain('当前没有待处理事项');});
it('does not navigate on an old notification acknowledgement after switching spaces',async()=>{let done!:(value:unknown)=>void;seam.value.run.mockImplementationOnce(()=>new Promise(resolve=>done=resolve));render();const notification=seam.value.state.notifications[0];const entry=[...host.querySelectorAll<HTMLButtonElement>('.mist-brief button')].find(button=>button.textContent?.includes(notification.title))!;await click(entry);seam.value={...seam.value,state:createMistState(ctx(),'empty'),workspace:{id:'new-space',name:'新空间'}};await act(async()=>paint());await act(async()=>done({result:{}}));expect(go).not.toHaveBeenCalled();});
it('uses the workspace display name and preferred receivable currency without changing session identity',()=>{seam.value.state.settings.profileName='工作显示名';seam.value.state.settings.companyProfile={defaultCurrency:'EUR'};render();expect(host.querySelector('.mist-page-head')?.textContent).toContain('工作显示名');expect(host.querySelectorAll('.mist-stat')[3].querySelector('.mist-stat-v')?.textContent).toContain('77.00EUR');expect(seam.session.user.displayName).toBe('当前员工');});
it('stops proactive brief content while keeping manual assistant access',async()=>{seam.value.state.settings.notifications.suggestions=false;render();expect(host.querySelector('.mist-brief')?.textContent).toContain('主动建议已关闭');await click(host.querySelector<HTMLElement>('.mist-brief-ask')!);expect(openAI).toHaveBeenCalledWith('请根据当前工作区记录，整理下一步行动建议。');});
it('uses shared notification preferences and view access before showing unread facts',()=>{seam.value.state.events=[];seam.value.state.settings.notifications.qc=false;seam.session.canAccessView=(view:string)=>view!=='shipments';seam.value.state.notifications=[{id:'hidden-qc',category:'qc',title:'关闭的QC通知',detail:'不应显示',readAt:null,target:{view:'development/detail',id:'d'}},{id:'hidden-scope',category:'general',title:'无权出运通知',detail:'不应显示',readAt:null,target:{view:'shipments',id:'s'}},{id:'visible',category:'general',title:'可见实际通知',detail:'应显示',readAt:null,target:{view:'orders/detail',id:'o'}}];render();expect(host.querySelector('.mist-brief')?.textContent).toContain('可见实际通知');expect(host.querySelector('.mist-brief')?.textContent).not.toContain('关闭的QC通知');expect(host.querySelector('.mist-brief')?.textContent).not.toContain('无权出运通知');});
it('does not present projected-away receivables as zero money or zero unpaid invoices',async()=>{
  seam.value.state.invoices=[];seam.value.workspace.access={role:'member',hidden:[{key:'receivables'}]};render();
  const card=host.querySelectorAll<HTMLElement>('.mist-stat')[3];
  expect(card.querySelector('.mist-stat-v')?.textContent).toBe('已隐藏');
  expect(card.textContent).toContain('不代表应收为零');expect(card.textContent).not.toContain('0 张未结发票');
  await click(card);expect(host.querySelector('[role=dialog]')).toBeNull();
  expect(host.querySelector('.mist-page-head')?.textContent).toContain('当前可见');
});
it('does not report a partial QC aggregate when development versions are hidden',async()=>{
  seam.value.state.devs=[];seam.value.state.versions=[];seam.value.workspace.access={role:'member',hidden:[{key:'products'}]};render();
  const cards=host.querySelectorAll<HTMLElement>('.mist-stat');
  for(const index of [0,1]){expect(cards[index].querySelector('.mist-stat-v')?.textContent).toBe('已隐藏');await click(cards[index]);expect(host.querySelector('[role=dialog]')).toBeNull();}
  expect(cards[2].querySelector('.mist-stat-v')?.textContent).not.toBe('已隐藏');
  expect(cards[3].querySelector('.mist-stat-v')?.textContent).not.toBe('已隐藏');
});
it('closes an open statistic detail immediately when its source becomes hidden',async()=>{
  render();await click(host.querySelectorAll<HTMLElement>('.mist-stat')[3]);expect(host.querySelector('[role=dialog]')).not.toBeNull();
  seam.value.state.invoices=[];seam.value.workspace.access={role:'member',hidden:[{key:'receivables'}]};await act(async()=>paint());
  expect(host.querySelector('[role=dialog]')).toBeNull();
});
it('keeps a genuinely visible empty ledger distinct from a hidden ledger',()=>{
  seam.value.state=createMistState(ctx(),'empty');seam.value.workspace.access={role:'member',hidden:[]};render();
  const card=host.querySelectorAll<HTMLElement>('.mist-stat')[3];
  expect(card.querySelector('.mist-stat-v')?.textContent).toBe('0.00');expect(card.textContent).toContain('0 张未结发票');expect(card.textContent).not.toContain('已隐藏');
});
it('lists derived work from QC returns and rejected payment requests and opens the exact source',async()=>{
  const state=seam.value.state;state.fulfillment.qcTasks=[{id:'qc-back',code:'QC-BACK',source:{kind:'version',versionId:'v',devId:'d'},domain:'garment',kind:'sample',factory:'回传工厂',location:'',contact:'',due:'',requestedBy:'当前员工',assignee:'',state:'reported',reportIds:['r'],createdAt:'2026-10-01'}];
  state.payables={...(state.payables||{bills:[],payments:[],allocations:[]}),requests:[{id:'pr-back',code:'PR-BACK',purpose:'prepayment',supplierId:'s',supplier:'实际供应商',currency:'CNY',amount:10,planId:'p',lines:[],reason:'',fileIds:[],requesterId:'owner',requester:'当前员工',submittedAt:new Date().toISOString(),reviewerIds:['boss'],snapshot:[],state:'rejected',decision:{actorId:'boss',actor:'财务主管',at:new Date().toISOString(),decision:'rejected',note:'缺合同'},paymentHistory:[]}]};
  render();const rows=[...host.querySelectorAll<HTMLElement>('.mist-task')];expect(rows.map(row=>row.textContent).join('|')).toContain('QC-BACK');expect(rows.map(row=>row.textContent).join('|')).toContain('PR-BACK · 付款申请被退回');
  expect(host.querySelector('.mist-page-head')?.textContent).toContain('件来自审批、QC、出运或财务');
  await click(rows.find(row=>row.textContent?.includes('PR-BACK'))!);expect(go).toHaveBeenLastCalledWith('payment-vouchers','pr-back',{view:'payment-vouchers',id:'pr-back'});
  await click(rows.find(row=>row.textContent?.includes('QC-BACK'))!);expect(go).toHaveBeenLastCalledWith('qc-workbench','qc-back',{view:'qc-workbench',id:'qc-back'});
});
