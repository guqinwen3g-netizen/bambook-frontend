// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getByRole, getByText, getByLabelText, within } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { applyMistCommand, createMistState, type MistState } from '../../../../server/src/shared/mistWorkspace';
import type {OrderFundingAssignment} from '../../../../server/src/shared/mistOrderFunding';
import { Nav } from '../nav';
const store = vi.hoisted(() => ({ state: null as MistState | null, loading: false, error: '', run: vi.fn(), refresh: vi.fn() }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => store }));
import { OrderDetailPage } from './OrderDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root, orderId: string;
let sequence = 0;const go=vi.fn();
const context = { id: () => `detail-${++sequence}`, now: '2026-10-13T02:00:00.000Z', actorName: '业务员甲', actorId: 'sales' };
function render() {
  act(() => root.render(<MistRoot><ToastProvider><Nav.Provider value={{ route: { view: 'orders/detail', id: orderId }, go, openAI: vi.fn(), theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn() }}><OrderDetailPage /></Nav.Provider></ToastProvider></MistRoot>));
}
beforeEach(() => {
  sequence = 0;go.mockClear();store.run.mockReset();
  const empty = createMistState(context, 'empty');
  empty.customers.push({ id: 'customer-a', code: 'C-A', name: '客户甲', country: '', city: '', industry: '', owner: '业务员甲', grade: 'A', currency: 'USD', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '2026-01-01' });
  const result = applyMistCommand(empty, { type: 'order.create', payload: { type: 'garment', customerId: 'customer-a', season: 'AW28', currency: 'USD', due: '2026-10-30', ownerId:'sales', lines: [{ name: '精确金额条目', style: 'ROUND-01', img: 'coat', qty: 1.005, unit: '件', price: 1 }] } }, context);
  store.state = result.state; orderId = result.result.orderId!;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('uses canonical line amounts for the table, summary, receipt balance and drawer', async () => {
  store.state!.orders[0].amount = 1; // A stale summary must not override the exact current lines.
  render();
  const summary = getByText(host, '订单金额').parentElement!;
  expect(summary.textContent).toContain('1.01');
  expect(getByText(host, '合同待收').textContent).toContain('1.01');
  const row = getByRole(host, 'row', { name: /精确金额条目/ });
  expect(within(row).getByText('1.01')).toBeTruthy();
  await act(async () => row.click());
  const drawer = getByRole(document.body, 'dialog', { name: '精确金额条目' });
  expect(getByText(drawer, '小计', { selector: 'dt' }).nextElementSibling?.textContent).toBe('1.01 USD');
});

it.each([1.001, Number.NaN, Number.POSITIVE_INFINITY, -1])('shows invalid stored money as unavailable instead of throwing (%s)', price => {
  store.state!.orderLines[0].price = price;
  expect(render).not.toThrow();
  expect(host.textContent).toContain('订单金额无法核对');
  expect(getByText(host, '订单金额').parentElement!.textContent).toContain('—');
  expect(getByRole(host, 'row', { name: /精确金额条目/ }).textContent).toContain('—');
});

it('uses integer cents for received totals and the remaining balance', () => {
  store.state!.invoices.push({ id: 'invoice-a', code: 'INV-A', orderId, order: 'SO-A', customer: '客户甲', due: '2026-10-30', amount: 1.01, open: 0.71, currency: 'USD' });
  store.state!.receipts.push(...[0.1,0.2].map((amount,index)=>({id:`receipt-${index}`,code:`BR-${index}`,date:'2026-10-13',payer:'客户甲',amount,currency:'USD',ref:`REF-${index}`,remaining:0,state:'matched' as const})));
  store.state!.allocations.push(...[0.1, 0.2].map((amount, index) => ({ id: `allocation-${index}`, invoiceId: 'invoice-a', receiptId: `receipt-${index}`, amount, currency: 'USD', createdAt: context.now, actor: context.actorName })));
  render();
  expect(getByText(host, '已确认到账').textContent).toContain('0.30');
  expect(getByText(host, '合同待收').textContent).toContain('0.71');
});

it('does not render a misleading percentage when a received amount is invalid', () => {
  store.state!.invoices.push({ id: 'invoice-a', code: 'INV-A', orderId, order: 'SO-A', customer: '客户甲', due: '2026-10-30', amount: 1.01, open: 1.01, currency: 'USD' });
  store.state!.receipts.push({id:'receipt-a',code:'BR-A',date:'2026-10-13',payer:'客户甲',amount:2,currency:'USD',ref:'REF-A',remaining:2,state:'unmatched'});
  store.state!.allocations.push({ id: 'allocation-a', invoiceId: 'invoice-a', receiptId: 'receipt-a', amount: 1.001, currency: 'USD', createdAt: context.now, actor: context.actorName });
  expect(render).not.toThrow();
  expect(host.textContent).toContain('收款金额无法核对');
  expect(host.querySelector('.mist-donut')).toBeNull();
});
it('retains the current order editor when an older order save completes',async()=>{render();await act(async()=>getByRole(host,'button',{name:'编辑'}).click());let finish!:(value:unknown)=>void;store.run.mockReturnValue(new Promise(resolve=>finish=resolve));await act(async()=>getByRole(document.body,'button',{name:'保存'}).click());store.state!.orders.push({...store.state!.orders[0],id:'other',code:'OTHER',season:'NEW-SEASON'});orderId='other';render();await act(async()=>getByRole(host,'button',{name:'编辑'}).click());await act(async()=>finish({result:{orderId:'old'}}));expect(getByRole(document.body,'dialog',{name:'编辑订单'})).toBeTruthy();expect((getByLabelText(document.body,'季节') as HTMLInputElement).value).toBe('NEW-SEASON');});
it('labels the order quantity document as a draft and links the real shipment separately',async()=>{store.state!.fulfillment.shipments.push({id:'ship',code:'SHIP-ACTUAL',lines:[{orderId,lineId:store.state!.orderLines[0].id,quantity:1}],state:'preparing'} as any);render();await act(async()=>getByRole(host,'button',{name:'装箱单草稿'}).click());expect(document.body.textContent).toContain('正式装箱与原件以具体出运为准');await act(async()=>getByRole(document.body,'button',{name:'打开正式出运 SHIP-ACTUAL'}).click());expect(go).toHaveBeenCalledWith('shipments','ship');});

it('lets the business attach contract evidence and submit the entire draft for approval',async()=>{
  const ctx={...context,actorId:'sales',authority:{supplier:{},orderReviewerIds:{garment:['leader'],fabric:[]}}};
  (store as any).uploadFile=vi.fn(async(file:File)=>{const saved={id:'po-evidence',name:file.name,mimeType:file.type,size:file.size,storageKey:'workspace/po-evidence',createdAt:context.now};store.state!.files.push(saved);return saved;});
  store.run.mockImplementation(async(command:any)=>{const next=applyMistCommand(store.state!,command,ctx);store.state=next.state;render();return{requestId:'governance',revision:1,result:next.result};});render();
  expect(host.textContent).toContain('批准前不能采购或履约');await act(async()=>getByRole(host,'button',{name:'合同与审批资料'}).click());
  const set=(label:string,value:string)=>{const node=getByLabelText(document.body,label) as HTMLInputElement|HTMLTextAreaElement;act(()=>{Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});};
  set('PO / 合同号','CUSTOMER-PO');set('付款条款原文','T/T 按合同');set('贸易术语','FOB');set('指定地点 / 港口','上海');
  await act(async()=>{const file=document.body.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(file,'files',{value:[new File(['purchase order'],'po.pdf',{type:'application/pdf'})],configurable:true});file.dispatchEvent(new Event('change',{bubbles:true}));});
  await act(async()=>getByRole(document.body,'button',{name:'保存合同资料'}).click());await act(async()=>getByRole(host,'button',{name:'提交主单审批'}).click());
  expect(store.state!.orders[0].governance?.status).toBe('pending');expect(store.state!.orders[0].governance?.rounds[0].snapshot.lines).toHaveLength(1);expect(store.state!.orders[0].governance?.rounds[0].snapshot.contract.confirmationFileIds).toEqual(['po-evidence']);expect(queryByRoleSafe('交接后勤')).toBeNull();
});
function queryByRoleSafe(name:string){return [...host.querySelectorAll('button')].find(button=>button.textContent===name)||null;}

it.each(['draft','approved'] as const)('opens an exact line procurement draft from a %s order without executing fulfillment',async status=>{
  store.state!.orders[0].governance!.status=status;
  store.state!.orderLines.push({...store.state!.orderLines[0],id:'unselected-line',name:'另一条目',style:'OTHER'});
  render();await act(async()=>getByRole(host,'row',{name:/精确金额条目/}).click());
  const drawer=getByRole(document.body,'dialog',{name:'精确金额条目'});
  expect((drawer.textContent||'').includes('主单批准前不能提交采购承诺')).toBe(status==='draft');
  await act(async()=>getByRole(drawer,'button',{name:'准备采购草稿'}).click());
  expect(go).toHaveBeenLastCalledWith('procurement',undefined,{orderLineId:store.state!.orderLines[0].id,section:'order:'+orderId,customerId:'customer-a'});
  expect(store.run).not.toHaveBeenCalled();
});

it('opens the exact existing procurement promise and excludes purchases from other lines',async()=>{
  store.state!.fulfillment.purchases.push({id:'purchase-selected',code:'PO-SELECTED',orderId,lineId:store.state!.orderLines[0].id,state:'approved'} as any,{id:'purchase-other',code:'PO-OTHER',orderId,lineId:'other-line',state:'approved'} as any);
  render();await act(async()=>getByRole(host,'row',{name:/精确金额条目/}).click());
  const drawer=getByRole(document.body,'dialog',{name:'精确金额条目'});
  expect(drawer.textContent).not.toContain('PO-OTHER');
  await act(async()=>getByRole(drawer,'button',{name:'查看采购承诺 PO-SELECTED'}).click());
  expect(go).toHaveBeenLastCalledWith('procurement','purchase-selected',{orderLineId:store.state!.orderLines[0].id,section:'order:'+orderId,customerId:'customer-a'});
  expect(store.run).not.toHaveBeenCalled();
});

it('returns the receipt action to this exact order funding context without automatic reconciliation',async()=>{
  render();await act(async()=>getByRole(host,'button',{name:'查看收款核销'}).click());
  expect(go).toHaveBeenCalledWith('payment-vouchers',undefined,{section:'funding:'+orderId,customerId:'customer-a'});
  expect(store.run).not.toHaveBeenCalled();
});

function orderAdvance(){
  const state=store.state!;state.orderLines[0].qty=10;state.orderLines[0].price=12;state.orders[0].amount=120;
  state.receipts.push({id:'deposit-receipt',code:'BR-DEPOSIT',date:'2026-10-13',payer:'客户甲',amount:36,currency:'USD',ref:'BANK-DEPOSIT',remaining:36,state:'unmatched'});
  const assignment:OrderFundingAssignment={id:'deposit-assignment',receiptId:'deposit-receipt',customerId:'customer-a',orderId,amount:36,currency:'USD',note:'客户确认本单定金',state:'active',createdAt:context.now,updatedAt:context.now,actor:context.actorName,history:[]};
  state.orderFunding!.assignments.push(assignment);return assignment;
}

it('shows an attributed advance as confirmed order cash before any invoice or reconciliation exists',()=>{
  orderAdvance();render();
  expect(getByText(host,'已确认到账').textContent).toContain('36.00');expect(getByText(host,'合同待收').textContent).toContain('84.00');
  expect(host.textContent).toContain('已到账 36.00 USD');expect(getByText(host,'已核销 0.00 USD')).toBeTruthy();
  expect(store.state!.invoices).toEqual([]);expect(store.state!.allocations).toEqual([]);
});

it('counts an advance and its later invoice allocation once instead of showing 72 as received',()=>{
  orderAdvance();store.state!.invoices.push({id:'ci-current',code:'CI',orderId,order:'SO',customer:'客户甲',due:'2026-10-30',amount:120,open:84,currency:'USD'});
  store.state!.allocations.push({id:'allocation-deposit',receiptId:'deposit-receipt',invoiceId:'ci-current',amount:36,currency:'USD',createdAt:context.now,actor:context.actorName});
  render();expect(getByText(host,'已确认到账').textContent).toContain('36.00');expect(getByText(host,'已确认到账').textContent).not.toContain('72.00');
  expect(getByText(host,'合同待收').textContent).toContain('84.00');expect(getByText(host,'已核销 36.00 USD')).toBeTruthy();
});

it('keeps another order and foreign-currency receipts, assignments and allocations out of this order cash',()=>{
  const assignment=orderAdvance();const state=store.state!;
  state.orders.push({...state.orders[0],id:'other-order',code:'OTHER'});
  state.receipts.push({id:'other-receipt',code:'BR-OTHER',date:'2026-10-13',payer:'客户甲',amount:20,currency:'USD',ref:'OTHER',remaining:20,state:'unmatched'},{id:'eur-receipt',code:'BR-EUR',date:'2026-10-13',payer:'客户甲',amount:50,currency:'EUR',ref:'EUR',remaining:50,state:'unmatched'});
  state.orderFunding!.assignments.push({...assignment,id:'other-assignment',orderId:'other-order',receiptId:'other-receipt',amount:20},{...assignment,id:'eur-assignment',receiptId:'eur-receipt',currency:'EUR',amount:50});
  state.invoices.push({id:'ci-other',code:'CI-OTHER',orderId:'other-order',order:'OTHER',customer:'客户甲',due:'2026-10-30',amount:120,open:100,currency:'USD'},{id:'ci-eur',code:'CI-EUR',orderId,order:'SO',customer:'客户甲',due:'2026-10-30',amount:120,open:70,currency:'EUR'});
  state.allocations.push({id:'allocation-other',receiptId:'other-receipt',invoiceId:'ci-other',amount:20,currency:'USD',createdAt:context.now,actor:context.actorName},{id:'allocation-eur',receiptId:'eur-receipt',invoiceId:'ci-eur',amount:50,currency:'EUR',createdAt:context.now,actor:context.actorName});
  render();expect(getByText(host,'已确认到账').textContent).toContain('36.00');expect(getByText(host,'合同待收').textContent).toContain('84.00');expect(getByText(host,'已核销 0.00 USD')).toBeTruthy();
});

it('opens shipment preparation from the exact handed-off order without changing handoff history',async()=>{
  const order=store.state!.orders[0];order.handoffAt=context.now;render();
  await act(async()=>getByRole(host,'button',{name:'出运准备'}).click());
  expect(go).toHaveBeenCalledWith('shipments',undefined,{section:'order:'+orderId,customerId:'customer-a'});
  expect(order.handoffAt).toBe(context.now);expect(store.run).not.toHaveBeenCalled();
});

function lineEditorFixture(status:'draft'|'pending'|'rejected'|'approved',quantity=10,price=11){
  const actor={...context,actorId:'sales',authority:{supplier:{},orderReviewerIds:{garment:['leader'],fabric:['leader']}}};
  let state=store.state!;state.files.push({id:'line-po',name:'line-po.pdf',mimeType:'application/pdf',size:4,storageKey:'fixture/line-po',createdAt:context.now});
  state=applyMistCommand(state,{type:'order.governance.saveDraft',payload:{orderId,input:{kind:'external',poNumber:'PRICE-CORRECTION',confirmationFileIds:['line-po'],internalPurpose:'',receiver:'',paymentMethod:'OA',depositPercent:null,paymentNote:'OA，发票日起30天',incoterm:'FOB',deliveryPlace:'上海'},lines:[{id:state.orderLines[0].id,name:'精确金额条目',style:'ROUND-01',img:'coat',qty:quantity,unit:'件',price}]}},actor).state;
  if(status!=='draft')state=applyMistCommand(state,{type:'order.governance.submit',payload:{orderId}},actor).state;
  if(status==='approved'||status==='rejected')state=applyMistCommand(state,{type:'order.governance.decide',payload:{id:orderId,decision:status,note:status==='rejected'?'单价应为12 USD，请修正':'核对原合同'}},{...actor,actorId:'leader'}).state;
  store.state=state;store.run.mockImplementation(async(command:Parameters<typeof applyMistCommand>[1])=>{const result=applyMistCommand(store.state!,command,actor);store.state=result.state;render();return{requestId:'line-editor',revision:1,result:result.result};});
  return actor;
}
async function openLineEditor(name='精确金额条目'){
  await act(async()=>getByRole(host,'row',{name:new RegExp(name)}).click());
  await act(async()=>getByRole(document.body,'button',{name:'编辑条目'}).click());
}
async function lineInput(label:string,value:string){
  const control=getByLabelText(document.body,label) as HTMLInputElement|HTMLTextAreaElement;
  await act(async()=>{Object.getOwnPropertyDescriptor(control.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(control,value);control.dispatchEvent(new Event('input',{bubbles:true}));});
}

it('corrects a rejected order from 10 at 11 to 10 at 12 and preserves the rejected snapshot through resubmission',async()=>{
  const actor=lineEditorFixture('rejected'),lineId=store.state!.orderLines[0].id;render();await openLineEditor();
  await lineInput('销售单价','12');await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  expect(store.state!.orderLines[0]).toMatchObject({id:lineId,qty:10,price:12});expect(store.state!.orders[0].amount).toBe(120);
  expect(store.state!.orders[0].governance?.status).toBe('draft');expect(store.state!.orders[0].governance?.rounds[0].snapshot.lines[0].price).toBe(11);
  await act(async()=>getByRole(host,'button',{name:'提交主单审批'}).click());
  const approved=applyMistCommand(store.state!,{type:'order.governance.decide',payload:{id:orderId,decision:'approved',note:'已修正12 USD单价'}},{...actor,actorId:'leader'}).state;
  expect(approved.orders[0].amount).toBe(120);expect(approved.orders[0].governance?.rounds.map(round=>round.status)).toEqual(['rejected','approved']);
  expect(approved.orders[0].governance?.rounds.map(round=>round.snapshot.lines[0].price)).toEqual([11,12]);
});

it('sends all exact lines and the existing contract when editing a draft quantity',async()=>{
  lineEditorFixture('draft');const state=store.state!,contract=structuredClone(state.orders[0].governance!.contract),first=structuredClone(state.orderLines[0]);
  state.orderLines.push({id:'second-line',orderId,name:'第二条目',style:'SECOND',img:'blazer',qty:2,unit:'件',price:7,made:0,qc:0});render();await openLineEditor('第二条目');
  await lineInput('订单数量','3');await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  expect(store.state!.orderLines.find(line=>line.id===first.id)).toEqual(first);expect(store.state!.orderLines.find(line=>line.id==='second-line')).toMatchObject({qty:3,price:7,unit:'件'});
  expect(store.state!.orders[0].governance?.contract).toEqual(contract);expect(store.state!.orders[0].amount).toBe(131);
  const command=store.run.mock.calls[0][0];expect(command.type).toBe('order.governance.saveDraft');expect(command.payload.lines).toHaveLength(2);
});

it('locks the line editor while main approval is pending',async()=>{
  lineEditorFixture('pending');render();await act(async()=>getByRole(host,'row',{name:/精确金额条目/}).click());
  expect((getByRole(document.body,'button',{name:'编辑条目'}) as HTMLButtonElement).disabled).toBe(true);expect(store.run).not.toHaveBeenCalled();
});

it('keeps approved prices effective until the proposed line change is approved',async()=>{
  lineEditorFixture('approved');const before=structuredClone(store.state!.orders[0].governance!.approvedSnapshot);render();await openLineEditor();
  await lineInput('销售单价','12');await lineInput('变更原因','客户修订PO明确单价12 USD');await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  expect(store.state!.orders[0].amount).toBe(110);expect(store.state!.orderLines[0].price).toBe(11);expect(store.state!.orders[0].governance?.approvedSnapshot).toEqual(before);
  expect(store.state!.orders[0].governance?.changeDraft?.lines[0].price).toBe(12);expect(store.state!.orders[0].governance?.changeDraft?.reason).toContain('客户修订PO');
});

it('retains edited input when an existing fulfillment fact prevents an approved commercial change',async()=>{
  // BB-ORD-4：开工后允许改价改量，但新数量不得低于已完工；被服务端拒绝时保留输入
  lineEditorFixture('approved');store.state!.productions.push({id:'production-existing',code:'P',orderId,lineId:store.state!.orderLines[0].id,order:store.state!.orders[0].code,name:'现有生产',factory:'实际工厂',qty:10,due:'2026-10-30',pct:0,img:'coat',col:'cut'});
  store.state!.fulfillment.productionFacts.push({productionId:'production-existing',sizes:[],revision:1,completion:{id:'c',quantity:6,sizeQuantities:[],date:'2026-10-20',at:context.now,actor:'厂长',evidence:'完工单',fileIds:[]}});
  render();await openLineEditor();await lineInput('订单数量','3');await lineInput('销售单价','12');await lineInput('变更原因','客户修订PO');await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  expect(getByRole(document.body,'dialog',{name:'编辑订单条目'})).toBeTruthy();expect((getByLabelText(document.body,'销售单价') as HTMLInputElement).value).toBe('12');expect((getByLabelText(document.body,'订单数量') as HTMLInputElement).value).toBe('3');
  expect(document.body.textContent).toContain('低于下限 6 件');expect(store.state!.orderLines[0].price).toBe(11);expect(store.state!.orders[0].governance?.changeDraft).toBeUndefined();
});

it.each(['contract-first','header-first'] as const)('merges price, amended contract and header due into one pending proposal in %s order',async sequence=>{
  const actor=lineEditorFixture('approved',4,12);
  (store as any).uploadFile=vi.fn(async(file:File)=>{const saved={id:'amended-po',name:file.name,mimeType:file.type,size:file.size,storageKey:'fixture/amended-po',createdAt:context.now};store.state!.files.push(saved);return saved;});
  render();await openLineEditor();await lineInput('销售单价','15');await lineInput('变更原因','修订PO单价15 USD并顺延交期');await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  const amendContract=async()=>{
    await act(async()=>getByRole(host,'button',{name:'合同与审批资料'}).click());
    await lineInput('PO / 合同号','AMENDED-PO-15');await lineInput('付款条款原文','OA，修订PO约定发票日起30天');
    await act(async()=>{const input=getByRole(document.body,'dialog',{name:'拟议合同变更'}).querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(input,'files',{value:[new File(['amended price and due'],'amended-po.pdf',{type:'application/pdf'})],configurable:true});input.dispatchEvent(new Event('change',{bubbles:true}));});
    await act(async()=>getByRole(document.body,'button',{name:'保存变更草稿'}).click());
  };
  const amendHeader=async()=>{
    await act(async()=>getByRole(host,'button',{name:/^编辑$/}).click());await lineInput('交期','2026-11-03');
    await lineInput('实质变更原因','修订PO单价15 USD并顺延交期');await act(async()=>getByRole(document.body,'button',{name:/^保存$/}).click());
  };
  if(sequence==='contract-first'){await amendContract();await amendHeader();}else{await amendHeader();await amendContract();}
  const proposal=store.state!.orders[0].governance!.changeDraft!;
  expect(proposal.lines[0]).toMatchObject({qty:4,price:15});expect(proposal.orderPatch.due).toBe('2026-11-03');
  expect(proposal.contract).toMatchObject({poNumber:'AMENDED-PO-15',paymentMethod:'OA',paymentNote:'OA，修订PO约定发票日起30天'});expect(proposal.contract.confirmationFileIds).toEqual(['line-po','amended-po']);
  expect(store.state!.orders[0]).toMatchObject({amount:48,due:'2026-10-30'});expect(store.state!.orders[0].governance?.approvedSnapshot?.lines[0].price).toBe(12);
  await act(async()=>getByRole(host,'button',{name:'提交变更审批'}).click());
  const approved=applyMistCommand(store.state!,{type:'order.governance.decide',payload:{id:orderId,decision:'approved',note:'核对完整修订PO与交期'}},{...actor,actorId:'leader'}).state;
  expect(approved.orders[0]).toMatchObject({amount:60,due:'2026-11-03'});expect(approved.orders[0].governance?.rounds.map(round=>round.snapshot.lines[0].price)).toEqual([12,15]);
  expect(approved.orders[0].governance?.contract.confirmationFileIds).toEqual(['line-po','amended-po']);
});

it('saves a proposed due date restored to the live date without losing the amended contract or lines',async()=>{
  const actor=lineEditorFixture('approved',4,12),state=store.state!,order=state.orders[0],line=state.orderLines[0];
  state.files.push({id:'restore-po',name:'restore-po.pdf',mimeType:'application/pdf',size:4,storageKey:'fixture/restore-po',createdAt:context.now});
  store.state=applyMistCommand(state,{type:'order.governance.saveDraft',payload:{orderId,input:{...order.governance!.contract,poNumber:'RESTORED-DUE-PO',confirmationFileIds:['restore-po']},lines:[{id:line.id,name:line.name,style:line.style,img:line.img,qty:4,unit:'件',price:15}],orderPatch:{due:'2026-11-03'},reason:'修订单价与交期'}},actor).state;
  render();await act(async()=>getByRole(host,'button',{name:/^编辑$/}).click());
  expect((getByLabelText(document.body,'交期') as HTMLInputElement).value).toBe('2026-11-03');
  await lineInput('交期','2026-10-30');await lineInput('实质变更原因','保留修订单价与合同，交期恢复原约定');await act(async()=>getByRole(document.body,'button',{name:/^保存$/}).click());
  const proposal=store.state!.orders[0].governance!.changeDraft!;
  expect(proposal.orderPatch.due).toBe('2026-10-30');expect(store.run.mock.calls.at(-1)?.[0].type).toBe('order.governance.saveDraft');
  expect(proposal.lines[0]).toMatchObject({qty:4,price:15});expect(proposal.contract).toMatchObject({poNumber:'RESTORED-DUE-PO',confirmationFileIds:['restore-po']});
  expect(store.state!.orders[0]).toMatchObject({amount:48,due:'2026-10-30'});expect(store.state!.orders[0].governance?.approvedSnapshot?.lines[0].price).toBe(12);
  await act(async()=>getByRole(host,'button',{name:'提交变更审批'}).click());
  const approved=applyMistCommand(store.state!,{type:'order.governance.decide',payload:{id:orderId,decision:'approved',note:'核对修订合同并保持原交期'}},{...actor,actorId:'leader'}).state;
  expect(approved.orders[0]).toMatchObject({amount:60,due:'2026-10-30'});expect(approved.orders[0].governance?.rounds.map(round=>round.snapshot.lines[0].price)).toEqual([12,15]);
  expect(approved.orders[0].governance?.contract.confirmationFileIds).toEqual(['restore-po']);
});

it('keeps the owner-only shortcut for an approved order with no proposed change',async()=>{
  const actor=lineEditorFixture('approved',4,12);const members=[{id:'sales',name:'业务员甲',active:true,groups:[]},{id:'sales-b',name:'业务员乙',active:true,groups:[]}];
  store.state!.members=[{userId:'sales-b',name:'业务员乙',addedBy:'sales',addedByName:'业务员甲',addedAt:context.now}];(store as any).workspace={id:'w',ownerId:'sales'};
  store.run.mockImplementation(async(command:Parameters<typeof applyMistCommand>[1])=>{const result=applyMistCommand(store.state!,command,{...actor,members});store.state=result.state;render();return{requestId:'owner',revision:1,result:result.result};});
  render();await act(async()=>getByRole(host,'button',{name:/^编辑$/}).click());
  const owner=getByLabelText(document.body,'负责人') as HTMLSelectElement;expect([...owner.options].map(o=>o.textContent)).toEqual(['业务员甲','业务员乙']);
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(owner,'sales-b');owner.dispatchEvent(new Event('change',{bubbles:true}));});
  await act(async()=>getByRole(document.body,'button',{name:/^保存$/}).click());
  expect(store.run.mock.calls.at(-1)?.[0]).toEqual({type:'order.update',payload:{orderId,ownerId:'sales-b'}});
  expect(store.state!.orders[0]).toMatchObject({owner:'业务员乙',ownerId:'sales-b'});expect(store.state!.events[0].text).toContain('负责人：业务员甲→业务员乙');delete (store as any).workspace;expect(store.state!.orders[0].governance?.changeDraft).toBeUndefined();
});

it('shows proposed order purpose, internal purpose and receiver changes even when the old PO remains recorded',()=>{
  const actor=lineEditorFixture('approved',4,12),state=store.state!,order=state.orders[0];
  store.state=applyMistCommand(state,{type:'order.governance.saveDraft',payload:{orderId,input:{...order.governance!.contract,kind:'internal',internalPurpose:'展厅试穿',receiver:'样品团队 / 负责人乙'},reason:'改为内部展厅试穿'}},actor).state;
  render();const table=getByRole(host,'table',{name:'订单变更前后差异'});
  expect(within(table).getByRole('row',{name:/订单用途/}).textContent).toContain('外部客户订单');expect(within(table).getByRole('row',{name:/订单用途/}).textContent).toContain('内部用途订单');
  expect(within(table).getByRole('row',{name:/^内部用途 /}).textContent).toContain('展厅试穿');expect(within(table).getByRole('row',{name:/接收团队 \/ 负责人/}).textContent).toContain('样品团队 / 负责人乙');
  expect(host.textContent).not.toContain('没有改变当前生效条款');expect(table.textContent).not.toContain('PO / 合同号');
  expect(store.state!.orders[0].customerId).toBe('customer-a');expect(store.state!.orders[0].governance?.approvedSnapshot?.contract.kind).toBe('external');
});

it.each(['internalPurpose','receiver'] as const)('shows an internal order %s-only proposal with its original and proposed values',key=>{
  const actor=lineEditorFixture('draft',4,12),state=store.state!,contract={...state.orders[0].governance!.contract,kind:'internal' as const,internalPurpose:'原试穿用途',receiver:'原接收团队'};
  let next=applyMistCommand(state,{type:'order.governance.saveDraft',payload:{orderId,input:contract}},actor).state;
  next=applyMistCommand(next,{type:'order.governance.submit',payload:{orderId}},actor).state;
  next=applyMistCommand(next,{type:'order.governance.decide',payload:{id:orderId,decision:'approved',note:'核对内部用途和接收团队'}},{...actor,actorId:'leader'}).state;
  const proposed=key==='internalPurpose'?'新试穿用途':'新接收团队';store.state=applyMistCommand(next,{type:'order.governance.saveDraft',payload:{orderId,input:{...contract,[key]:proposed},reason:'修订内部交接资料'}},actor).state;
  render();const table=getByRole(host,'table',{name:'订单变更前后差异'}),row=within(table).getByRole('row',{name:key==='internalPurpose'?/内部用途/:/接收团队 \/ 负责人/});
  expect(row.textContent).toContain(key==='internalPurpose'?'原试穿用途':'原接收团队');expect(row.textContent).toContain(proposed);expect(table.textContent).not.toContain('订单用途');
  expect(table.querySelector('button,input,select,textarea')).toBeNull();
});

it('keeps all amendment entry points locked while a proposal is pending',async()=>{
  lineEditorFixture('approved',4,12);render();await openLineEditor();await lineInput('销售单价','15');await lineInput('变更原因','客户修订单价');await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  await act(async()=>getByRole(host,'button',{name:'提交变更审批'}).click());store.run.mockClear();
  const buttons=[getByRole(host,'button',{name:/^编辑$/}),getByRole(host,'button',{name:'合同与审批资料'}),getByRole(document.body,'button',{name:'编辑条目'})] as HTMLButtonElement[];
  expect(buttons.every(button=>button.disabled)).toBe(true);await act(async()=>buttons.forEach(button=>button.click()));
  expect(store.run).not.toHaveBeenCalled();expect(store.state!.orders[0].amount).toBe(48);expect(store.state!.orders[0].governance?.changeDraft?.lines[0].price).toBe(15);
});

it('shows actual price, total, contract, attachment and due differences before and during pending approval',async()=>{
  const actor=lineEditorFixture('approved',4,12),state=store.state!,order=state.orders[0],line=state.orderLines[0];
  state.files.push({id:'compare-po',name:'PO-v2.pdf',mimeType:'application/pdf',size:4,storageKey:'fixture/compare-po',createdAt:context.now});
  store.state=applyMistCommand(state,{type:'order.governance.saveDraft',payload:{orderId,input:{...order.governance!.contract,poNumber:'PO-V2',confirmationFileIds:['compare-po'],paymentNote:'OA，修订合同发票日起30天'},lines:[{id:line.id,name:line.name,style:line.style,img:line.img,qty:4,unit:'件',price:15}],orderPatch:{due:'2026-11-25'},reason:'修订价格与合同交期'}},actor).state;
  render();const table=getByRole(host,'table',{name:'订单变更前后差异'});
  const price=within(table).getByRole('row',{name:/ROUND-01 · 单价/});expect(price.textContent).toContain('12.00 USD');expect(price.textContent).toContain('15.00 USD');
  const total=within(table).getByRole('row',{name:/订单总额/});expect(total.textContent).toContain('48.00 USD');expect(total.textContent).toContain('60.00 USD');
  expect(within(table).getByRole('row',{name:/PO \/ 合同号/}).textContent).toContain('PO-V2');expect(within(table).getByRole('row',{name:/合同附件/}).textContent).toContain('line-po.pdf');expect(within(table).getByRole('row',{name:/合同附件/}).textContent).toContain('PO-v2.pdf');
  expect(within(table).getByRole('row',{name:/合同付款条款/}).textContent).toContain('OA，修订合同');expect(within(table).getByRole('row',{name:/交期/}).textContent).toContain('2026-11-25');
  expect(table.textContent).not.toContain('ROUND-01 · 数量');expect(table.textContent).not.toContain('贸易术语');expect(table.querySelector('button,input,select,textarea')).toBeNull();
  await act(async()=>getByRole(host,'button',{name:'提交变更审批'}).click());
  expect(getByRole(host,'table',{name:'订单变更前后差异'}).textContent).toContain('15.00 USD');expect((getByRole(host,'button',{name:/^编辑$/}) as HTMLButtonElement).disabled).toBe(true);
  expect(store.state!.orders[0].amount).toBe(48);expect(store.state!.orders[0].governance?.approvedSnapshot?.lines[0].price).toBe(12);
});

it('shows a quantity-only difference without labelling unchanged unit price or contract as changed',()=>{
  const actor=lineEditorFixture('approved',4,12),state=store.state!,order=state.orders[0],line=state.orderLines[0];
  store.state=applyMistCommand(state,{type:'order.governance.saveDraft',payload:{orderId,input:order.governance!.contract,lines:[{id:line.id,name:line.name,style:line.style,img:line.img,qty:5,unit:'件',price:12}],reason:'客户增加一件'}},actor).state;
  render();const table=getByRole(host,'table',{name:'订单变更前后差异'}),quantity=within(table).getByRole('row',{name:/ROUND-01 · 数量/});
  expect(quantity.textContent).toContain('4 件');expect(quantity.textContent).toContain('5 件');expect(table.textContent).not.toContain('ROUND-01 · 单价');expect(table.textContent).not.toContain('PO / 合同号');expect(table.textContent).not.toContain('交期');
});

it('BB-ORD-3 edits a colour × size breakdown, applies it to a draft, and lists approved changes cell by cell',async()=>{
  const actor=lineEditorFixture('draft');render();await openLineEditor();
  await act(async()=>getByRole(document.body,'button',{name:'按颜色 × 尺码填写数量'}).click());
  await lineInput('颜色 1','藏青');await lineInput('藏青 · S 数量','4');await lineInput('藏青 · M 数量','6');
  expect((getByLabelText(document.body,'订单数量') as HTMLInputElement).disabled).toBe(true);
  expect((getByLabelText(document.body,'订单数量') as HTMLInputElement).value).toBe('10');
  await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  const saved=store.state!.orderLines[0] as unknown as {qty:number;breakdown:{sizes:string[];rows:Array<{color:string;quantities:number[]}>}};
  expect(saved.qty).toBe(10);expect(saved.breakdown).toEqual({kind:'garment',sizes:['S','M','L','XL'],rows:[{color:'藏青',quantities:[4,6,0,0]}]});
  expect(host.textContent).toContain('1 色 × 4 码');
  store.state=applyMistCommand(store.state!,{type:'order.governance.submit',payload:{orderId}},actor).state;
  store.state=applyMistCommand(store.state!,{type:'order.governance.decide',payload:{id:orderId,decision:'approved',note:'核对'}},{...actor,actorId:'leader'}).state;
  render();await openLineEditor();
  await lineInput('藏青 · M 数量','8');await lineInput('变更原因','客户追加 M 码');
  await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  expect(store.state!.orderLines[0].qty).toBe(10);
  expect(store.state!.orders[0].governance?.changeDraft?.lines[0].qty).toBe(12);
  const diff=getByRole(host,'table',{name:'订单变更前后差异'});
  const row=getByRole(diff,'row',{name:/ROUND-01 · 藏青 · M/});
  expect(row.textContent).toContain('6');expect(row.textContent).toContain('8');
});

it('BB-ORD-4 lets a started order change quantity, shows the floor and an impact list with links to production and shipment',async()=>{
  lineEditorFixture('approved',10,11);const state=store.state!,lineId=state.orderLines[0].id;
  state.productions.push({id:'job',code:'PR-1',orderId,lineId,order:state.orders[0].code,name:'精确金额条目',factory:'一厂',qty:10,due:'2026-11-20',pct:60,img:'coat',col:'sew'});
  state.fulfillment.productionFacts.push({productionId:'job',sizes:[],revision:1,completion:{id:'c1',quantity:6,sizeQuantities:[],date:'2026-11-01',at:context.now,actor:'厂长',evidence:'完工单',fileIds:[]}});
  state.fulfillment.shipments.push({id:'sh',code:'SH-1',customerId:'customer-a',customer:'客户甲',domain:'garment',consignee:'客户甲',mode:'sea',portOfLoading:'上海',portOfDischarge:'汉堡',incoterm:'FOB',plannedDate:'2026-11-25',booking:'',lines:[{lineId,orderId,productionId:'job',quantity:5,factoryConfirmedAt:context.now}],note:'',fileIds:[],state:'preparing',requestedBy:'单证',requesterId:'docs',createdAt:context.now} as never);
  render();await openLineEditor();
  expect(document.body.querySelector('[data-line-floor]')!.textContent).toContain('不得低于 6 件（已完工 6 · 已排出运 5）');
  await lineInput('订单数量','5');await lineInput('变更原因','客户减量');
  await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  expect(document.body.textContent).toContain('低于下限 6 件');
  await lineInput('订单数量','8');
  await act(async()=>getByRole(document.body,'button',{name:'保存条目'}).click());
  expect(store.state!.orders[0].governance?.changeDraft?.lines[0].qty).toBe(8);expect(store.state!.orderLines[0].qty).toBe(10);
  const impact=getByRole(host,'region',{name:'影响清单'});
  expect(impact.textContent).toContain('10 → 8 件');expect(impact.textContent).toContain('需同步调整生产分配');
  await act(async()=>within(impact).getByRole('button',{name:/生产 PR-1/}).click());
  expect(go).toHaveBeenLastCalledWith('production-board',undefined,{productionId:'job',orderLineId:lineId});
  await act(async()=>within(impact).getByRole('button',{name:/出运 SH-1/}).click());
  expect(go).toHaveBeenLastCalledWith('shipments','sh');
});

it.each([[980,'确认结案','closed','已结案（实际 980 / 订单 1000，客户接受实际数量）'],[950,'提交结案审批','pending','结案待审批（实际 950 / 订单 1000，客户接受实际数量）']] as const)('BB-ORD-5 closes a ±3%% line with %i departed (%s) via the line fulfillment panel',async(departed,submitLabel,status,label)=>{
  lineEditorFixture('approved',1000,11);const state=store.state!,lineId=state.orderLines[0].id,g=state.orders[0].governance!;
  for(const contract of [g.contract,g.approvedSnapshot!.contract])Object.assign(contract,{overPercent:3,shortPercent:3});
  state.fulfillment.shipments.push({id:'sh',code:'SH-1',customerId:'customer-a',customer:'客户甲',domain:'garment',consignee:'客户甲',mode:'sea',portOfLoading:'上海',portOfDischarge:'汉堡',incoterm:'FOB',plannedDate:'2026-11-25',booking:'',lines:[{lineId,orderId,quantity:departed,factoryConfirmedAt:context.now}],note:'',fileIds:[],state:'departed',requestedBy:'单证',requesterId:'docs',createdAt:context.now} as never);
  render();await act(async()=>getByRole(host,'row',{name:/精确金额条目/}).click());
  expect(document.body.querySelector('[data-line-tolerance]')!.textContent).toBe('溢装 +3% / 短装 −3%');
  expect(document.body.querySelector('[data-line-range]')!.textContent).toMatch(/970.*1,?030/);
  expect(document.body.querySelector('[data-line-verdict]')!.getAttribute('data-line-verdict')).toBe(departed===980?'within':'short');
  await act(async()=>getByRole(document.body,'button',{name:'按实际完工结案'}).click());
  await act(async()=>getByRole(document.body,'button',{name:submitLabel}).click());
  expect(document.body.textContent).toContain('请写明结案原因');
  await lineInput('结案原因','客户接受实际数量');
  await act(async()=>getByRole(document.body,'button',{name:submitLabel}).click());
  expect((store.state!.orderLines[0] as unknown as {closure:{status:string}}).closure.status).toBe(status);
  expect(document.body.querySelector('[data-line-closure]')!.textContent).toBe(label);
  expect((getByRole(document.body,'button',{name:'按实际完工结案'}) as HTMLButtonElement).disabled).toBe(true);
});

it('BB-ORD-6 shows the approved over-ship allowance and its approval record under 分批与尾数',async()=>{
  lineEditorFixture('approved',1000,11);const state=store.state!,g=state.orders[0].governance!;
  for(const contract of [g.contract,g.approvedSnapshot!.contract])Object.assign(contract,{overPercent:3,shortPercent:3});
  (state.orderLines[0] as unknown as {overShips:unknown[]}).overShips=[{id:'os1',status:'approved',quantity:1050,ordered:1000,max:1030,excess:20,reason:'客户要求多发补损',requesterId:'sales',requesterName:'业务员',requestedAt:context.now,reviewerIds:['leader'],decidedBy:'leader',decidedName:'经理',decidedAt:context.now,note:'同意'}];
  render();await act(async()=>getByRole(host,'row',{name:/精确金额条目/}).click());
  expect(document.body.querySelector('[data-line-overship-approved]')!.textContent).toMatch(/累计可出 1,?050 件（超出溢装上限 20）/);
  const record=getByRole(document.body,'list',{name:'超量出运审批记录'});
  expect(record.textContent).toContain('已批准：累计可出 1050（溢装上限 1030，超出 20），客户要求多发补损；审批意见：同意');expect(record.textContent).toContain('业务员 → 经理');
});
