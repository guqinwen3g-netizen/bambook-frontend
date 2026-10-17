// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {getByRole,getByText,getAllByRole} from '@testing-library/dom';
import {MistRoot} from '../../../../../components/mist';
import {createMistState} from '../../../../../server/src/shared/mistWorkspace';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({value:null as any,canWrite:true,csv:vi.fn()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store.value}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({hasPermission:()=>store.canWrite})}));
vi.mock('./ModuleWorkbench',()=>({downloadModuleCsv:store.csv,ModuleEditorDialog:({spec}:any)=>spec?<div role="dialog" aria-label={spec.title}><button type="button" onClick={()=>void spec.submit({reason:'金额与合同不符'})}>{spec.submitLabel}</button></div>:null}));
import {InvoicePage,invoiceAge,invoiceLedgerRows,invoiceSource,invoiceFinancialFacts} from './InvoicePage';
let host:HTMLElement,root:Root,route:any;const go=vi.fn();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
function render(){act(()=>root.render(<MistRoot><Nav.Provider value={{route,go,theme:'light',toggleTheme:vi.fn(),openAI:vi.fn(),openPalette:vi.fn()}}><InvoicePage/></Nav.Provider></MistRoot>));}
async function click(name:string){await act(async()=>getAllByRole(document.body,'button',{name,exact:true})[0].click());}
function select(label:string,value:string){const e=getByRole(host,'combobox',{name:label}) as HTMLSelectElement;act(()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(e,value);e.dispatchEvent(new Event('change',{bubbles:true}));});}
beforeEach(()=>{const state=createMistState({id:()=>'',now:'2026-10-14T00:00:00Z',actorName:'测试'},'empty');state.orders=[{id:'o',code:'ORDER',customerId:'customer',customer:'客户',currency:'USD'}] as any;state.invoices=[{id:'a',code:'CI-A',orderId:'o',order:'ORDER',customer:'客户',due:'2000-01-01',amount:100,open:70,currency:'USD'},{id:'b',code:'CI-B',orderId:'o',order:'ORDER',customer:'客户',due:'2099-01-01',amount:50,open:50,currency:'EUR'},{id:'void',code:'CI-VOID',orderId:'o',order:'ORDER',customer:'客户',due:'2000-01-01',amount:900,open:0,currency:'USD',voidedAt:'2026-10-01',voidReason:'更正原件'}];state.platform.invoiceDrafts=[{id:'draft',orderId:'o',due:'2026-12-01',amount:2000,note:'旧草稿原说明',state:'Draft',createdAt:'2026-10-01'}];state.receipts=[{id:'r',code:'BANK-R',date:'2026-10-01',payer:'客户',amount:20,remaining:0,currency:'USD',ref:'银行参考',state:'matched'}];state.allocations=[{id:'allocation',receiptId:'r',invoiceId:'a',amount:20,currency:'USD',createdAt:'2026-10-01',actor:'实际财务'}];state.platform.creditApplications=[{id:'apply',creditId:'credit',invoiceId:'a',amount:10,at:'2026-10-01',actor:'实际财务'}];state.platform.claims=[{id:'claim',code:'CLM-A',orderId:'o',invoiceId:'a',problem:'实际客诉',fileIds:[],state:'Processing',createdAt:'2026-10-01',dispositions:[]}];state.platform.credits=[{id:'credit',code:'CN-A',claimId:'claim',dispositionId:'decision',customerId:'customer',currency:'USD',amount:10,createdAt:'2026-10-01'}];state.fulfillment.documents=[{id:'doc',shipmentId:'ship',orderId:'o',invoiceId:'a',type:'CI',number:'CI-A',status:'issued',issuedAt:'2026-10-01',content:'原件正文',fileIds:['file']}] as any;state.fulfillment.shipments=[{id:'ship',code:'SHIP-A'}] as any;state.files=[{id:'file',name:'CI-original.pdf',mimeType:'application/pdf',size:100,storageKey:'test',createdAt:'2026-10-01'}];store.value={state,workspace:{id:'space-a'},loading:false,saving:false,error:'',refresh:vi.fn(),run:vi.fn(),downloadFile:vi.fn().mockResolvedValue(undefined)};store.canWrite=true;store.csv.mockReset();go.mockReset();route={view:'invoices'};host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();});
it.each([['2026-10-14','not-due',0],['2026-10-13','1-30',1],['2026-09-14','1-30',30],['2026-09-13','31-60',31],['2026-08-15','31-60',60],['2026-08-14','61-90',61],['2026-07-16','61-90',90],['2026-07-15','90+',91],['2026-02-30','unknown',null],['','unknown',null]])('computes a validated original-calendar aging band for %s',(due,group,days)=>{expect(invoiceAge(due as string,'2026-10-14')).toEqual({group,days});});
it('keeps void face values and old drafts while excluding both from current receivables',()=>{const rows=invoiceLedgerRows(store.value.state);expect(rows.find(r=>r.id==='void')).toMatchObject({amount:900,open:0,state:'void'});expect(rows.find(r=>r.id==='draft')).toMatchObject({amount:2000,open:0,draft:true,state:'draft'});render();expect(getByText(host,'未结票据').parentElement?.parentElement?.textContent).toContain('2');expect(host.textContent).toContain('70.00 USD');expect(host.textContent).toContain('50.00 EUR');expect(host.textContent).not.toContain('2,070.00 USD');expect(getAllByRole(host,'button').some(b=>b.textContent==='签发商业发票')).toBe(false);expect(store.value.run).not.toHaveBeenCalled();});
it('separates bank allocation, credit offset and remaining balance instead of calling all reductions cash',()=>{const row=invoiceLedgerRows(store.value.state)[0];expect(invoiceFinancialFacts(store.value.state,row)).toMatchObject({cash:20,credit:10,unexplained:0});route.id='a';render();expect(host.textContent).toContain('实际到账核销');expect(host.textContent).toContain('20.00 USD');expect(host.textContent).toContain('10.00 USD');});
it('filters original currencies and exports only the displayed rows',async()=>{render();select('票据币种','EUR');expect(getByRole(host,'table',{name:'应收票据台账'}).textContent).toContain('CI-B');expect(getByRole(host,'table',{name:'应收票据台账'}).textContent).not.toContain('CI-A');await click('导出当前台账 CSV');expect(store.csv).toHaveBeenCalledWith('应收票据当前台账.csv',expect.any(Array),[expect.arrayContaining(['CI-B','EUR',50])]);});
it('retains draft history read-only even with invoice write permission',()=>{route.id='draft';render();expect(host.textContent).toContain('历史独立草稿只读');expect(host.textContent).toContain('旧草稿原说明');expect(host.textContent).not.toContain('新建发票草稿');expect(getAllByRole(host,'button').some(b=>b.textContent==='签发商业发票')).toBe(false);expect((getByRole(host,'button',{name:'收款与核销'}) as HTMLButtonElement).disabled).toBe(true);expect(store.value.run).not.toHaveBeenCalled();});
it('links only exact source documents, shipment, receipt and credit application',async()=>{route.id='a';render();await click('来源 CI / 作废回程');expect(go).toHaveBeenLastCalledWith('document-center','doc');await click('来源出运');expect(go).toHaveBeenLastCalledWith('shipments','ship');await click('查看到账流水');expect(go).toHaveBeenLastCalledWith('payment-vouchers','r',{section:'records'});await click('查看贷项来源案件');expect(go).toHaveBeenLastCalledWith('claims','claim',{section:'credit:credit'});expect(store.value.run).not.toHaveBeenCalled();});
it('does not guess a source document from a matching number or ambiguous associations',()=>{const row=invoiceLedgerRows(store.value.state)[0];store.value.state.fulfillment.documents[0].invoiceId='another';expect(invoiceSource(store.value.state,row).document).toBeUndefined();store.value.state.fulfillment.documents[0].invoiceId='a';store.value.state.fulfillment.documents.push({...store.value.state.fulfillment.documents[0],id:'second'});route.id='a';render();expect(host.textContent).toContain('存在多个 CI 关联');expect((getByRole(host,'button',{name:'来源 CI / 作废回程'}) as HTMLButtonElement).disabled).toBe(true);});
it('shows a failed attachment download and permits retry without any financial write',async()=>{store.value.downloadFile.mockRejectedValueOnce(new Error('原件服务拒绝读取'));route.id='a';render();await click('CI-original.pdf');expect(host.textContent).toContain('原件服务拒绝读取');await click('CI-original.pdf');expect(store.value.downloadFile).toHaveBeenCalledTimes(2);expect(host.textContent).not.toContain('原件服务拒绝读取');expect(store.value.run).not.toHaveBeenCalled();});
it('does not show an old attachment error in a new workspace',async()=>{let reject!:(e:Error)=>void;store.value.downloadFile.mockReturnValue(new Promise((_,fail)=>reject=fail));route.id='a';render();await click('CI-original.pdf');store.value={...store.value,workspace:{id:'space-b'}};render();await act(async()=>reject(new Error('旧空间原件失败')));expect(host.textContent).not.toContain('旧空间原件失败');});
it('shows an explicit unavailable supplier ledger without manufacturing payable invoices',async()=>{render();await act(async()=>getByRole(host,'tab',{name:'供应商应付'}).click());expect(host.textContent).toContain('供应商应付票据尚未接入');expect((getByRole(host,'button',{name:'登记供应商原票'}) as HTMLButtonElement).disabled).toBe(true);expect(host.textContent).not.toContain('CI-A');expect(store.value.run).not.toHaveBeenCalled();});
it('does not auto-open another invoice when an exact deep link is missing',()=>{route.id='missing';render();expect(host.textContent).toContain('未找到指定票据');expect(host.textContent).not.toContain('原件正文');expect(store.value.run).not.toHaveBeenCalled();});
it('keeps voided invoices read-only with original reason and without new reconciliation',()=>{route.id='void';render();expect(host.textContent).toContain('更正原件');expect(host.textContent).toContain('900.00 USD');expect((getByRole(host,'button',{name:'收款与核销'}) as HTMLButtonElement).disabled).toBe(true);});
it('shows unexplained historical balance differences without inventing a bank receipt',()=>{store.value.state.invoices[0].open=60;route.id='a';render();expect(host.textContent).toContain('票款明细待核对');expect(host.textContent).toContain('10.00 USD 差异');expect(store.value.state.receipts).toHaveLength(1);expect(store.value.run).not.toHaveBeenCalled();});
it('exposes read-only finance results without source creation even to a business account',()=>{store.canWrite=false;render();expect(host.textContent).toContain('财务结果只读');expect(host.textContent).not.toContain('新建发票草稿');expect(store.value.run).not.toHaveBeenCalled();});

it('preserves incoming customer scope and original-currency filters through list-detail return',async()=>{route={view:'invoices',section:'open',customerId:'customer'};render();select('票据币种','EUR');const row=[...host.querySelectorAll<HTMLElement>('[role="row"][tabindex]')].find(r=>r.textContent?.includes('CI-B'))!;await act(async()=>row.click());expect(go).toHaveBeenLastCalledWith('invoices','b',{section:'open',customerId:'customer'});await click('返回发票台账');expect(go).toHaveBeenLastCalledWith('invoices',undefined,{section:'open',customerId:'customer'});expect((getByRole(host,'combobox',{name:'票据币种'}) as HTMLSelectElement).value).toBe('EUR');expect(getByRole(host,'table',{name:'应收票据台账'}).textContent).not.toContain('CI-A');});

const pendingCi=()=>{store.value.state.invoices.push({id:'p',code:'CI-P',orderId:'o',order:'ORDER',customer:'客户',due:'2000-01-01',amount:300,open:0,currency:'USD',financeStatus:'pending'});};
it('queues a CI receivable as pending finance confirmation outside open balance, aging and reconciliation',async()=>{
  pendingCi();
  expect(invoiceLedgerRows(store.value.state).find(r=>r.id==='p')).toMatchObject({state:'pending',amount:300,open:0});
  render();
  expect(getByText(host,'待财务确认',{selector:'.mist-stat *'}).closest('.mist-stat')?.textContent).toContain('1');
  expect(getByText(host,'未结票据').parentElement?.parentElement?.textContent).not.toContain('300.00');
  await act(async()=>getByRole(getByRole(host,'group'),'button',{name:'待财务确认'}).click());
  const table=getByRole(host,'table',{name:'应收票据台账'});
  expect(table.textContent).toContain('CI-P');expect(table.textContent).not.toContain('CI-A');
  route.id='p';render();
  expect(host.textContent).toContain('不计入应收余额、账龄、报表与催收');
  const collect=getByRole(host,'button',{name:'收款与核销'}) as HTMLButtonElement;
  expect(collect.disabled).toBe(true);
  await click('确认应收');
  expect(store.value.run).toHaveBeenLastCalledWith({type:'finance.receivable.confirm',payload:{invoiceId:'p'}});
  await click('驳回 CI');
  await act(async()=>getByRole(getByRole(document.body,'dialog',{name:'驳回 CI 应收'}),'button',{name:'驳回并退回更正'}).click());
  expect(store.value.run).toHaveBeenLastCalledWith({type:'finance.receivable.reject',payload:{invoiceId:'p',reason:'金额与合同不符'}});
});
it('does not offer confirm or reject to an account without finance invoice write permission',()=>{
  pendingCi();store.canWrite=false;route.id='p';render();
  expect(host.textContent).toContain('确认或驳回由财务处理');
  expect(getAllByRole(host,'button').some(b=>b.textContent==='确认应收'||b.textContent==='驳回 CI')).toBe(false);
  expect(store.value.run).not.toHaveBeenCalled();
});
it('shows the finance confirmation and rejection facts on the receivable',()=>{
  pendingCi();Object.assign(store.value.state.invoices.at(-1),{financeStatus:'rejected',voidedAt:'2026-10-14T00:00:00Z',voidReason:'财务驳回：金额与合同不符',financeRejectedAt:'2026-10-14T00:00:00Z',financeRejectedBy:'财务',financeRejectReason:'金额与合同不符'});
  route.id='p';render();
  expect(host.textContent).toContain('财务驳回');expect(host.textContent).toContain('金额与合同不符');expect(host.textContent).toContain('CI 已退回后勤更正');
  expect((getByRole(host,'button',{name:'收款与核销'}) as HTMLButtonElement).disabled).toBe(true);
});
