// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getAllByRole,getByRole,queryByRole} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {FulfillmentPurchase} from '../../../../../server/src/shared/mistFulfillment';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
const session=vi.hoisted(()=>({id:'buyer',denied:new Set<string>()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:session.id,displayName:'经办人'},sessionKey:'s',hasPermission:(p:string)=>!session.denied.has(p),canAccessView:()=>true})}));
import {ProcurementPage} from './ProcurementPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();
function render(id?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'procurement',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><ProcurementPage/></Nav.Provider></ToastProvider></MistRoot>));}
async function click(node:HTMLElement){await act(async()=>node.click());}
function typeInto(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
function purchase(id:string,patch:Partial<FulfillmentPurchase>={}):FulfillmentPurchase{return {id,code:id.toUpperCase(),orderId:'o',lineId:'l',kind:'material',domain:'garment',supplierId:'s',supplier:'青禾辅料',description:'主唛与洗标',quantity:100,unit:'个',price:0.3,currency:'CNY',due:'2026-10-30',terms:'月结30天',destination:'江南成衣',note:'',fileIds:[],state:'draft',requesterId:'buyer',createdBy:'经办人',createdAt:'2026-10-01T08:00:00Z',reviewerIds:['boss'],configVersions:{},received:0,...patch};}
const approved=(patch:Partial<FulfillmentPurchase>={})=>({state:'approved' as const,submittedAt:'2026-10-02T08:00:00Z',decision:{actorId:'boss',actor:'审批人',at:'2026-10-03T08:00:00Z',decision:'approved' as const,note:'同意'},...patch});
beforeEach(()=>{session.id='buyer';session.denied=new Set();store.state=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T10:00:00Z',actorName:'经办人'},'empty');store.state.orders.push({id:'o',code:'SO-1',type:'garment',customerId:'c',currency:'USD'} as any);store.state.orderLines.push({id:'l',orderId:'o',name:'风衣',style:'TR-1',img:'coat',qty:100,unit:'件',price:10,made:0,qc:0});store.run.mockReset();store.run.mockResolvedValue({result:{}});go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('keeps purchase orders and outsourced processing as separate entries inside each business group',async()=>{
  store.state!.fulfillment.purchases.push(purchase('po-1'),purchase('wo-1',{kind:'processing',description:'水洗加工'}),purchase('fb-1',{domain:'fabric',description:'面料染色'}));
  render();
  expect(getByRole(host,'tab',{name:/^采购订单/}).getAttribute('aria-selected')).toBe('true');
  expect(getByRole(host,'tab',{name:/^采购订单/}).textContent).toContain('1');
  const table=getByRole(host,'table',{name:'采购订单列表'});
  expect(table.textContent).toContain('PO-1');expect(table.textContent).not.toContain('WO-1');expect(table.textContent).not.toContain('FB-1');
  await click(getByRole(host,'tab',{name:/^委外加工单/}));
  expect(getByRole(host,'table',{name:'委外加工单列表'}).textContent).toContain('WO-1');
  expect(getByRole(host,'button',{name:'新建委外加工单'})).toBeTruthy();
  await click(getByRole(host,'button',{name:/^面料业务/}));
  expect(getByRole(host,'table',{name:'采购订单列表'}).textContent).toContain('FB-1');
});

it('derives stages only from recorded facts and puts exceptions first',()=>{
  store.state!.fulfillment.purchases.push(
    purchase('a-draft'),purchase('b-pending',{state:'pending',submittedAt:'2026-10-02T08:00:00Z'}),
    purchase('c-unsent',approved({due:'2026-11-20'})),
    purchase('d-late',approved({due:'2026-10-01',offlineSend:{at:'2026-10-04T08:00:00Z',actor:'经办人',evidence:'邮件',fileIds:[],revision:1}})),
    purchase('e-over',approved({received:120,offlineSend:{at:'2026-10-04T08:00:00Z',actor:'经办人',evidence:'邮件',fileIds:[],revision:1},supplierConfirmation:{at:'2026-10-05T08:00:00Z',actor:'经办人',evidence:'回签',confirmedDue:'2026-10-30',fileIds:[],revision:1}})),
  );
  render();
  const pipeline=(label:string)=>getAllByRole(host,'button').find(button=>button.textContent?.startsWith(label))!;
  expect(pipeline('需求草稿').textContent).toBe('需求草稿1');
  expect(pipeline('待审批').textContent).toBe('待审批1');
  expect(pipeline('待供应商确认').textContent).toBe('待供应商确认2');
  expect(pipeline('已完成').textContent).toBe('已完成1');
  const rows=getAllByRole(getByRole(host,'table',{name:'采购订单列表'}),'row').slice(1).map(row=>row.textContent?.match(/[A-E]-[A-Z]+/)?.[0]);
  expect(rows.slice(0,2).sort()).toEqual(['D-LATE','E-OVER']);
  expect(getByRole(host,'row',{name:/E-OVER/}).textContent).toContain('超收 20 个');
});

it('explains why delivery cannot be recorded before the supplier confirms and opens confirmation over the list',async()=>{
  store.state!.fulfillment.purchases.push(purchase('sent',approved({offlineSend:{at:'2026-10-04T08:00:00Z',actor:'经办人',evidence:'邮件',fileIds:[],revision:1}})));
  render('sent');
  const detail=host.querySelector('[data-purchase-detail="sent"]') as HTMLElement;
  expect(detail.textContent).toContain('合同已发出 · 待供应商确认');
  expect((getByRole(detail,'button',{name:'登记本次交付'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('登记本次交付：请先登记合同线下发出和供应商确认');
  expect(queryByRole(detail,'button',{name:'登记合同线下发出'})).toBeNull();
  await click(getByRole(detail,'button',{name:'登记供应商确认'}));
  const dialog=getByRole(document.body,'dialog');
  expect(getByRole(host,'table',{name:'采购订单列表'})).toBeTruthy();
  typeInto(getByRole(dialog,'textbox',{name:'供应商确认依据'}) as HTMLTextAreaElement,'盖章回签件');
  await click(getByRole(dialog,'button',{name:'登记确认'}));
  expect(store.run).toHaveBeenCalledWith(expect.objectContaining({type:'fulfillment.procurement.confirm',payload:expect.objectContaining({id:'sent',confirmedDue:'2026-10-30',evidence:'盖章回签件'})}));
});

it('shows approval reasons, returned notes and processing-only track steps',()=>{
  store.state!.fulfillment.purchases.push(purchase('wait',{state:'pending',submittedAt:'2026-10-02T08:00:00Z',kind:'processing'}),purchase('back',{state:'rejected',decision:{actorId:'boss',actor:'审批人',at:'2026-10-03T08:00:00Z',decision:'rejected',note:'单价高于报价'}}));
  render('wait');
  let detail=host.querySelector('[data-purchase-detail="wait"]') as HTMLElement;
  expect((getByRole(detail,'button',{name:'批准承诺'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('你不在本单提交时的审批名单中');
  expect(detail.textContent).toContain('原料交接');
  render('back');
  detail=host.querySelector('[data-purchase-detail="back"]') as HTMLElement;
  expect(detail.textContent).toContain('审批人：单价高于报价');
  expect((getByRole(detail,'button',{name:'提交审批'}) as HTMLButtonElement).disabled).toBe(true);
  expect((getByRole(detail,'button',{name:'编辑草稿'}) as HTMLButtonElement).disabled).toBe(false);
  expect(detail.textContent).not.toContain('原料交接');
});

it('keeps the ledger readable without write permission',()=>{
  session.denied=new Set(['procurement:write']);
  store.state!.fulfillment.purchases.push(purchase('ro'));
  render('ro');
  expect(host.textContent).toContain('只读查看');
  expect(queryByRole(host,'button',{name:'新建采购订单'})).toBeNull();
  expect((getByRole(host,'button',{name:'提交审批'}) as HTMLButtonElement).disabled).toBe(true);
  expect(host.textContent).toContain('提交审批：需要采购写权限');
});
