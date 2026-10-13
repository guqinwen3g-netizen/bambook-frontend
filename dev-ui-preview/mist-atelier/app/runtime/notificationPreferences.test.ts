import {describe,it,expect} from 'vitest';
import {createMistState} from '../../../../server/src/shared/mistWorkspace';
import {mistDailyDigest,visibleMistNotifications} from './notificationPreferences';
const fixture=()=>createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T00:00:00Z',actorName:'测试'},'empty');
describe('workspace notification preferences',()=>{
 it('filters disabled categories and unreadable targets without deleting stored facts',()=>{
  const state=fixture();state.notifications=['qc','shipping','suggestion','general'].map(category=>({id:category,title:category,detail:'',at:'2026-10-13',readAt:null,category:category as any,target:{view:category==='shipping'?'shipments':'development/detail'}}));
  state.settings.notifications.qc=false;state.settings.notifications.suggestions=false;
  expect(visibleMistNotifications(state,()=>true).map(n=>n.id)).toEqual(['shipping','general']);
  expect(visibleMistNotifications(state,v=>v!=='shipments').map(n=>n.id)).toEqual(['general']);
  expect(state.notifications).toHaveLength(4);
 });
 it('generates no digest until enabled and never combines different currencies',()=>{
  const state=fixture();state.invoices=[{id:'usd-a',code:'a',orderId:'o',order:'o',customer:'c',due:'2026-10-13',currency:'USD',amount:0.1,open:0.1},{id:'usd-b',code:'b',orderId:'o',order:'o',customer:'c',due:'2026-10-13',currency:'USD',amount:0.2,open:0.2},{id:'cny',code:'c',orderId:'o',order:'o',customer:'c',due:'2026-10-13',currency:'CNY',amount:10,open:10}];
  expect(mistDailyDigest(state,'2026-10-13',()=>true)).toEqual([]);state.settings.notifications.digest=true;
  expect(mistDailyDigest(state,'2026-10-13',()=>true).map(n=>n.detail)).toEqual(['0.30 USD · 2 张发票','10.00 CNY · 1 张发票']);
  expect(mistDailyDigest(state,'2026-10-13',()=>false)).toEqual([]);
 });
 it('links due tasks to their exact source and excludes future or finished tasks',()=>{
  const state=fixture();state.settings.notifications.digest=true;state.tasks=[{id:'due',title:'准确任务',kind:'qc',due:'2026-10-13',done:false,target:{view:'development/detail',id:'dev',versionId:'version'}},{id:'future',title:'未来',kind:'qc',due:'2026-10-14',done:false,target:{view:'development/detail'}},{id:'done',title:'完成',kind:'qc',due:'2026-10-12',done:true,target:{view:'development/detail'}}];
  expect(mistDailyDigest(state,'2026-10-13',()=>true)).toEqual([{id:'task:due',label:'准确任务',detail:'今天到期',target:{view:'development/detail',id:'dev',versionId:'version'}}]);
 });
 it('keeps claim work without a deadline distinct from due or overdue work',()=>{
  const state=fixture();state.settings.notifications.digest=true;const target={view:'claims',id:'exact-claim'};
  state.tasks=[{id:'undated',title:'生成售后履行单据',kind:'claim-execution:disposition',due:'',done:false,target},{id:'today',title:'已约今天',kind:'business',due:'2026-10-13',done:false,target},{id:'overdue',title:'已约昨日',kind:'business',due:'2026-10-12',done:false,target},{id:'future',title:'未来期限',kind:'business',due:'2026-10-14',done:false,target}];
  expect(mistDailyDigest(state,'2026-10-13',()=>true).map(row=>row.detail)).toEqual(['未定期限','今天到期','已过期 · 2026-10-12']);expect(mistDailyDigest(state,'2026-10-13',view=>view!=='claims')).toEqual([]);
  expect(state.tasks[0].due).toBe('');
 });
 it('shows a readable general claim decision even when QC and shipping reminders are disabled',()=>{
  const state=fixture();state.settings.notifications.qc=false;state.settings.notifications.shipping=false;state.notifications=[{id:'claim-decision',category:'general',title:'售后处置已批准',detail:'实际负责人 · 核对通过',at:'2026-10-13',readAt:null,target:{view:'claims',id:'exact-claim'}}];
  expect(visibleMistNotifications(state,view=>view==='claims')).toHaveLength(1);expect(visibleMistNotifications(state,view=>view!=='claims')).toEqual([]);
 });
});
