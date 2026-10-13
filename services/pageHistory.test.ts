import { describe, it, expect } from 'vitest';
import { PageHistory } from './pageHistory';
describe('page history', () => {
 it('starts a fresh journey for sidebar browsing but retains subsequent business returns', async()=>{
  const h=new PageHistory(); h.initialize('view',()=> 'orders');h.setTitle('订单管理');
  h.set('view','detail',true);h.setTitle('订单条目');
  h.navigateRoot(()=>h.set('view','finance',true));h.setTitle('财务管理');
  await Promise.resolve();
  expect(h.canBack).toBe(false);expect(h.back()).toBe(false);
  h.set('view','invoice',true);h.flush();
  expect(h.previousTitle).toBe('财务管理');
  h.back();expect(h.values.get('view')).toBe('finance');expect(h.canBack).toBe(false);
 });
 it('returns across modules to the exact line and restores its list context', () => {
  const h=new PageHistory();
  h.initialize('view',()=> 'orders'); h.initialize('line',()=> '0010'); h.initialize('search',()=> 'navy');
  h.set('view','finance',true); h.flush(); h.set('tab','receipts',true); h.flush();
  h.back(); expect(h.values.get('view')).toBe('finance');
  h.back(); expect(h.values.get('view')).toBe('orders');expect(h.values.get('line')).toBe('0010');expect(h.values.get('search')).toBe('navy');
 });
 it('batches one click selecting an order and line into one history entry',()=>{
  const h=new PageHistory(); h.initialize('view',()=> 'list');
  h.set('view','detail',true);h.set('order','123',true);h.set('line','0010',true);h.flush();
  h.back();expect(h.values.get('view')).toBe('list'); expect(h.canBack).toBe(false);
 });
 it('does not turn a refresh or filter update into another page',()=>{
  const h=new PageHistory();h.initialize('order',()=>({id:'123',status:'old'}));
  h.set('order',{id:'123',status:'new'},true);h.set('search','blue',false);h.flush();expect(h.canBack).toBe(false);
 });
 it('has no external destination and is isolated from another session',()=>{
  const a=new PageHistory();a.set('view','orders',true);a.flush();
  const b=new PageHistory();expect(b.back()).toBe(false);expect(b.values.size).toBe(0);
 });
});

describe('session restoration', () => {
 const storage = () => { const values = new Map<string,string>(); return { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => { values.set(key,value); } }; };
 it('starts a new login at home with no stale detail, dialog or return history, then preserves subsequent refreshes', () => {
  const disk=storage(), persistence={storage:disk,key:'actor-A'};
  const old=new PageHistory(persistence);
  old.initialize('App.currentView',()=> 'orders');old.set('App.selectedOrder',{id:'old-order'},true);
  old.setRefresh('dialog',true);old.persist();
  const login=new PageHistory({...persistence,restore:false});
  expect(login.initialize('App.currentView',()=> 'work')).toBe('work');
  expect(login.values.has('App.selectedOrder')).toBe(false);
  expect(login.refreshValues.has('dialog')).toBe(false);expect(login.canBack).toBe(false);
  login.set('App.currentView','orders',true);login.set('App.selectedOrder',{id:'new-order'},true);
  login.setRefresh('dialog',true);login.setRefresh('scroll',420);login.persist();
  const reload=new PageHistory(persistence);
  expect(reload.values.get('App.selectedOrder')).toEqual({id:'new-order'});
  expect(reload.refreshValues.get('dialog')).toBe(true);expect(reload.refreshValues.get('scroll')).toBe(420);
 });
 it('restores exact page, child selection, dialog and draft, including pending origin', () => {
  const disk=storage(), persistence={storage:disk,key:'actor-A'};
  const before=new PageHistory(persistence);
  before.initialize('App.currentView',()=> 'orders');before.setTitle('面料订单');
  before.set('App.selectedOrder',{id:'order-15'},true);
  before.set('OrderManager.selectedLineItem',{id:'line-10'},true);
  before.setRefresh('CustomerPoEvidencePanel.order-15.open',true);
  before.setRefresh('form',{quantity:'200'});
  before.set('App.workbenchFocus',{sequence:99},false);
  before.persist();
  const after=new PageHistory(persistence);
  expect(after.values.get('App.selectedOrder')).toEqual({id:'order-15'});
  expect(after.values.get('OrderManager.selectedLineItem')).toEqual({id:'line-10'});
  expect(after.refreshValues.get('CustomerPoEvidencePanel.order-15.open')).toBe(true);
  expect(after.refreshValues.get('form')).toEqual({quantity:'200'});
  expect(after.values.has('App.workbenchFocus')).toBe(false);
  expect(after.previousTitle).toBe('面料订单');after.back();
  expect(after.values.get('App.currentView')).toBe('orders');
  expect(after.refreshValues.get('form')).toEqual({quantity:'200'});
 });
 it('isolates users, tolerates corrupt or denied storage, and caps history', () => {
  const disk=storage(), a=new PageHistory({storage:disk,key:'a'});
  for(let i=0;i<40;i++){a.set('page',i,true);a.flush();}a.persist();
  const b=new PageHistory({storage:disk,key:'b'});expect(b.values.size).toBe(0);
  const restored=new PageHistory({storage:disk,key:'a'});let count=0;while(restored.back())count++;expect(count).toBe(30);
  disk.setItem('bad','{bad json');expect(new PageHistory({storage:disk,key:'bad'}).values.size).toBe(0);
  const denied={getItem:()=>{throw Error('denied')},setItem:()=>{throw Error('denied')}};
  const noDisk=new PageHistory({storage:denied,key:'denied'});expect(()=>{noDisk.set('page','detail',true);noDisk.persist();}).not.toThrow();
 });
});

it('backTo skips sibling selections while retaining the earlier business origin', () => {
 const history = new PageHistory();
 history.initialize('view', () => 'orders');
 history.setTitle('订单详情');
 history.set('view','suppliers',true); history.flush();
 history.initialize('supplier', () => null); history.setTitle('供应商管理');
 history.set('supplier','first',true); history.flush();
 history.set('supplier','second',true); history.flush();
 expect(history.backTo(values => values.has('supplier') && values.get('supplier') === null)).toBe(true);
 expect(history.values.get('supplier')).toBeNull();
 expect(history.values.get('view')).toBe('suppliers');
 expect(history.back()).toBe(true);
 expect(history.values.get('view')).toBe('orders');
});
