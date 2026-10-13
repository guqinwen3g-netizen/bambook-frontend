// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getByRole,getByLabelText,queryByRole,queryByLabelText} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {applyMistCommand,createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {PlatformClaimGoodsSource} from '../../../../../server/src/shared/mistPlatform';
import {createClaimReturnReceipt} from '../../../../../server/src/shared/mistClaimInventory';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,workspace:{id:'isolated-ui',revision:0},loading:false,error:'',saving:false,pending:null,run:vi.fn(),downloadFile:vi.fn(),uploadFile:vi.fn()}));
const permissions=vi.hoisted(()=>({inventory:true}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:'business'},sessionKey:'session',hasPermission:(permission:string)=>permission==='inventory:write'?permissions.inventory:true,canAccessView:()=>true})}));
vi.mock('../../../../../services/apiService',()=>({apiService:{}}));
import {InventoryPage} from './FulfillmentPages';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root,sequence:number,route:{view:string;id?:string;section?:string};const go=vi.fn();
const context={id:()=>`ui-return-${++sequence}`,now:'2026-10-13T10:00:00.000Z',actorId:'business',actorName:'实际经手业务员',consumeBusinessNumber:(_prefix:string)=>'RT-2026-00001'};
function render(){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route,go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><InventoryPage/></Nav.Provider></ToastProvider></MistRoot>));}
async function click(element:HTMLElement){await act(async()=>element.click());}
async function enter(label:string,value:string){const element=getByLabelText(document.body,label) as HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;await act(async()=>{if(element instanceof HTMLSelectElement){element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));}else{Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));}});}
async function wizard(values:Record<string,string>){for(let stage=0;stage<5;stage++){for(const [label,value]of Object.entries(values))if(queryByLabelText(document.body,label))await enter(label,value);const next=queryByRole(document.body,'button',{name:'下一步'});if(!next)break;await click(next);}}
beforeEach(()=>{sequence=0;permissions.inventory=true;go.mockReset();store.run.mockReset();store.downloadFile.mockReset();store.state=createMistState(context,'empty');route={view:'inventory',section:'claim:case'};store.state.platform.claims.push({id:'case',code:'CLM-2026-00001',orderId:'order',invoiceId:'invoice',problem:'真实退回',fileIds:[],state:'Processing',createdAt:context.now,dispositions:[]});store.run.mockImplementation(async command=>{const result=applyMistCommand(store.state!,command,context);store.state=result.state;render();return{requestId:'actual-ui',revision:++store.workspace.revision,result:result.result};});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
function physicalFixture(){
 store.state!.customers.push({id:'customer',name:'实际来源客户',code:'C',country:'CN',city:'',industry:'成衣',owner:'实际业务',grade:'A',currency:'USD',terms:'OA',incoterm:'FOB',categories:'成衣',creditLimit:0,since:'2026-10-13'});
 store.state!.orders.push({id:'order',code:'SO-EXACT',type:'garment',customerId:'customer',customer:'实际来源客户',season:'AW26',lines:1,qty:4,amount:60,currency:'USD',due:'2026-12-01',progress:100,state:'履行中',tone:'ok',owner:'实际业务',img:'coat',checklist:[],handoffAt:context.now,createdAt:context.now,updatedAt:context.now});store.state!.orderLines.push({id:'line',orderId:'order',name:'实际退回成衣',style:'RETURN-M',img:'coat',qty:4,unit:'件',price:15,made:4,qc:4});
 const source:PlatformClaimGoodsSource={schemaVersion:1,claimId:'case',dispositionId:'d',invoiceId:'invoice',documentId:'ci',orderId:'order',lineId:'line',shipmentId:'ship',productionId:'production',customerId:'customer',currency:'USD',name:'实际退回成衣',style:'RETURN-M',unit:'件',quantity:2,unitPrice:15,sourceQuantity:4,sourceAmount:60,orderApprovedVersion:1};
 const disposition={id:'d',kind:'ReturnRefund' as const,amount:30,quantity:2,unit:'件',returnDisposition:'Scrap' as const,basis:'真实批准处置',fileIds:[],state:'Executed' as const,reviewDecision:'approved' as const,requesterId:'business',reviewerId:'leader',submittedAt:context.now,goodsSource:source,snapshot:JSON.stringify({kind:'ReturnRefund',amount:30,quantity:2,unit:'件',destination:'Scrap',basis:'真实批准处置',goodsSource:source}),goodsId:'goods',creditNoteId:'cn'};store.state!.platform.claims[0].dispositions.push(disposition);store.state!.platform.claimGoods.push({id:'goods',claimId:'case',dispositionId:'d',orderId:'order',quantity:2,unit:'件',destination:'Scrap',source,state:'AwaitingReturn',events:[]});
 const created=applyMistCommand(store.state!,{type:'fulfillment.claimInventory.warehouse.save',payload:{code:'WH-EXACT',name:'真实退货仓库',address:'实际上海地址',active:true}},context);store.state=created.state;const rt=createClaimReturnReceipt(store.state,'goods',created.result.id!,context);route.id=rt.id;return rt;
}
const receiptValues={'本次实收数量（件）':'1','实际仓内位置':'退货隔离区A','真实退回批号':'RETURN-LOT-1','实际货权':'Owned','货权确认日期':'2026-10-13','货权确认依据':'客户确认退回货权归我方','实际收货日期':'2026-10-13','实际点数与交接依据':'实际点数一件并签收'};

it('registers a real warehouse with the existing Mist wizard and returns to the exact case without creating inventory',async()=>{
 render();expect(host.textContent).toContain('尚无真实仓库');await click(getByRole(host,'button',{name:'登记真实仓库'}));expect(host.querySelector('.mist-wizard')).not.toBeNull();await wizard({'仓库代码':'WH-NEW','仓库名称':'新增真实仓库','实际仓库地址':'实际上海地址'});await click(getByRole(document.body,'button',{name:'确认保存'}));expect(store.state!.fulfillment.warehouses[0]).toMatchObject({code:'WH-NEW',name:'新增真实仓库',active:true});expect(store.state!.fulfillment.stock).toEqual([]);await click(getByRole(host,'button',{name:'返回来源案件'}));expect(go).toHaveBeenCalledWith('claims','case');
});

it('requires explicit real goods selection, retains the fixed RT warehouse, and saves one piece as isolated stock',async()=>{
 const rt=physicalFixture();render();expect((getByRole(host,'button',{name:'登记本批真实收货'}) as HTMLButtonElement).disabled).toBe(true);expect((getByRole(host,'combobox',{name:'准确退回履行条目'}) as HTMLSelectElement).value).toBe('');await enter('准确退回履行条目','goods');await click(getByRole(host,'button',{name:'登记本批真实收货'}));const warehouse=getByRole(host,'combobox',{name:'正式退货单仓库'}) as HTMLSelectElement;expect(warehouse.disabled).toBe(true);expect(warehouse.value).toBe(rt.warehouseId);await wizard(receiptValues);await click(getByRole(document.body,'button',{name:'确认保存'}));expect(store.run).toHaveBeenLastCalledWith(expect.objectContaining({type:'fulfillment.claimInventory.receive',payload:expect.objectContaining({goodsId:'goods',quantity:1,warehouseId:rt.warehouseId,ownership:'Owned',unit:'件'})}));expect(store.state!.platform.claimGoods[0]).toMatchObject({receivedQuantity:1,state:'PartiallyReceived'});expect(host.textContent).toContain('可用 0 / 现存 1 / 隔离 1 件');
});

it('preserves failed real receipt input and retries the original goods without silently substituting another source',async()=>{
 physicalFixture();render();await enter('准确退回履行条目','goods');await click(getByRole(host,'button',{name:'登记本批真实收货'}));await wizard(receiptValues);store.run.mockRejectedValueOnce(new Error('库存版本已变化，数量未保存'));await click(getByRole(document.body,'button',{name:'确认保存'}));expect(host.textContent).toContain('库存版本已变化');expect(host.textContent).toContain('RETURN-LOT-1');expect(store.state!.fulfillment.stock).toEqual([]);await click(getByRole(document.body,'button',{name:'确认保存'}));expect(store.state!.fulfillment.stock).toHaveLength(1);expect(store.state!.fulfillment.stock[0].goodsId).toBe('goods');
});

it('shows original inbound and current physical/isolated balances, scraps the exact received event and opens the exact case and CN',async()=>{
 physicalFixture();const received=applyMistCommand(store.state!,{type:'fulfillment.claimInventory.receive',payload:{goodsId:'goods',quantity:1,unit:'件',warehouseId:store.state!.fulfillment.warehouses[0].id,location:'退货隔离区A',batchNumber:'RETURN-LOT-1',ownership:'Owned',ownershipDate:'2026-10-13',ownershipEvidence:'客户确认',receivedAt:'2026-10-13',basis:'实际点数一件',fileIds:[]}},context);store.state=received.state;route.id=String(received.result.stockId);render();expect(host.textContent).toContain('累计入库');expect(host.textContent).toContain('物理现存');expect(host.textContent).toContain('隔离数量');expect(host.textContent).toContain('隔离锁定');expect(host.textContent).toContain('退回隔离库存');
 await click(getByRole(host,'button',{name:'返回准确案件'}));expect(go).toHaveBeenCalledWith('claims','case');await click(getByRole(host,'button',{name:'查看来源CN'}));expect(go).toHaveBeenCalledWith('claims','case',{section:'credit:cn'});await click(getByRole(host,'button',{name:'登记本批报废'}));await enter('批准报废执行依据','按批准去向实际报废本批');await click(getByRole(document.body,'button',{name:'保存'}));expect(store.run).toHaveBeenLastCalledWith({type:'fulfillment.claimInventory.scrap',payload:{goodsId:'goods',receivedEventId:received.result.receivedEventId,basis:'按批准去向实际报废本批',fileIds:[]}});expect(store.state!.fulfillment.stock[0]).toMatchObject({quantity:1,onHand:0,locked:0,available:0});expect(host.textContent).toContain('报废出库');
});

it.each(['unknown-rt','foreign-stock'])('does not fall back from an invalid exact incoming return identity %s',id=>{
 physicalFixture();store.state!.fulfillment.stock.push({id:'foreign-stock',sourceKind:'claimReturn',claimId:'another-case',name:'不可回落库存',orderId:'other',lineId:'other-line',quantity:1,available:0,onHand:1,locked:1,unit:'件',location:'另一区',owner:'公司',createdAt:context.now});route.id=id;render();expect(host.textContent).toContain('来源案件或退货单不匹配');expect(host.textContent).not.toContain('不可回落库存');expect(queryByRole(host,'combobox',{name:'准确退回履行条目'})).toBeNull();expect(store.run).not.toHaveBeenCalled();
});

it('keeps inventory read-only without inventory authority while preserving source return navigation',()=>{physicalFixture();permissions.inventory=false;render();expect(queryByRole(host,'button',{name:'登记真实仓库'})).toBeNull();expect(queryByRole(host,'button',{name:'登记本批真实收货'})).toBeNull();expect(getByRole(host,'button',{name:'返回来源案件'})).toBeTruthy();expect(store.run).not.toHaveBeenCalled();});

it('opens and edits the real warehouse catalog locally while preserving the exact case return context',async()=>{
 const rt=physicalFixture();render();await click(getByRole(host,'button',{name:'仓库目录'}));await click(getByRole(host,'row',{name:/WH-EXACT/}));expect(host.textContent).toContain('实际上海地址');await click(getByRole(host,'button',{name:'编辑'}));await wizard({'仓库名称':'核实后的真实仓库名称'});await click(getByRole(document.body,'button',{name:'确认保存'}));expect(store.state!.fulfillment.warehouses[0].name).toBe('核实后的真实仓库名称');expect(store.state!.fulfillment.returnReceipts[0].warehouseId).toBe(rt.warehouseId);expect(route.id).toBe(rt.id);expect(go).not.toHaveBeenCalled();await click(getByRole(host,'button',{name:'返回仓库目录'}));await click(getByRole(host,'button',{name:'返回来源案件'}));expect(go).toHaveBeenCalledWith('claims','case');
});

it('filters the actual ledger by a catalog warehouse without changing stock or treating a location as an ID',async()=>{
 physicalFixture();const first=store.state!.fulfillment.warehouses[0].id;store.state=applyMistCommand(store.state!,{type:'fulfillment.claimInventory.warehouse.save',payload:{code:'WH-OTHER',name:'另一真实仓库',address:'另一实址',active:true}},context).state;
 store.state!.fulfillment.stock.push({id:'first-stock',purchaseId:'purchase-a',receiptId:'receipt-a',warehouseId:first,name:'第一仓真实库存',orderId:'order',lineId:'line',unit:'件',quantity:10,available:10,location:'A',owner:'公司',createdAt:context.now},{id:'other-stock',purchaseId:'purchase-b',receiptId:'receipt-b',warehouseId:store.state!.fulfillment.warehouses[1].id,name:'第二仓真实库存',orderId:'order',lineId:'line',unit:'件',quantity:5,available:5,location:'A',owner:'公司',createdAt:context.now});route={view:'inventory'};render();await enter('仓库筛选',first);expect(host.textContent).toContain('第一仓真实库存');expect(host.textContent).not.toContain('第二仓真实库存');expect(store.run).not.toHaveBeenCalled();expect(store.state!.fulfillment.stock).toHaveLength(2);
});
