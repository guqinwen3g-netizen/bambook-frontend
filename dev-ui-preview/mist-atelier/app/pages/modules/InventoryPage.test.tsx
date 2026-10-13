// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getAllByRole,getByRole,queryByRole} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {FulfillmentStock,FulfillmentStockMovement} from '../../../../../server/src/shared/mistFulfillment';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
const session=vi.hoisted(()=>({denied:new Set<string>()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:'biz',displayName:'经办人'},sessionKey:'s',hasPermission:(p:string)=>!session.denied.has(p),canAccessView:()=>true})}));
vi.mock('../../../../../services/apiService',()=>({apiService:{}}));
import {InventoryPage} from './InventoryPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();
function render(id?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'inventory',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><InventoryPage/></Nav.Provider></ToastProvider></MistRoot>));}
async function click(node:HTMLElement){await act(async()=>node.click());}
function choose(select:HTMLSelectElement,value:string){act(()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}
function typeInto(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
const stock=(id:string,patch:Partial<FulfillmentStock>={}):FulfillmentStock=>({id,sourceKind:'purchase',purchaseId:'po',receiptId:'rc',orderId:'og',lineId:'lg',name:'主唛',unit:'个',quantity:100,available:100,location:'A-1',owner:'公司货权',warehouseId:'wh',createdAt:'2026-10-10T08:00:00Z',...patch});
const movement=(id:string,stockId:string,kind:FulfillmentStockMovement['kind'],quantity:number,patch:Partial<FulfillmentStockMovement>={}):FulfillmentStockMovement=>({id,stockId,kind,quantity,location:'嘉兴厂',person:'江南成衣',note:'供料',at:'2026-10-11T08:00:00Z',actor:'经办人',...patch});
beforeEach(()=>{session.denied=new Set();const s=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T10:00:00Z',actorName:'经办人'},'empty');
  s.orders.push({id:'og',code:'SO-G',type:'garment',customerId:'c',currency:'USD'} as any,{id:'of',code:'SO-F',type:'fabric',customerId:'c',currency:'USD'} as any);
  s.orderLines.push({id:'lg',orderId:'og',name:'风衣',style:'TR-1',img:'coat',qty:100,unit:'件',price:10,made:0,qc:0},{id:'lf',orderId:'of',name:'府绸',style:'F-1',img:'fabric',qty:500,unit:'米',price:3,made:0,qc:0});
  s.fulfillment.warehouses.push({id:'wh',code:'WH-1',name:'松江仓',address:'上海',active:true});
  store.state=s;store.run.mockReset();store.run.mockResolvedValue({result:{}});go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('summarises each business group per unit without ever adding different units together',async()=>{
  store.state!.fulfillment.stock.push(stock('a',{available:400}),stock('b',{name:'里布',unit:'米',available:860,quantity:860}),stock('c',{name:'主唛补单',available:20}),stock('f',{orderId:'of',lineId:'lf',name:'府绸坯布',unit:'米',available:300,quantity:300}));
  render();
  const tabs=getByRole(host,'tablist',{name:'库存业务板块'}),garment=getByRole(tabs,'tab',{name:/成衣库存/}),fabric=getByRole(tabs,'tab',{name:/面料库存/});
  expect(garment.getAttribute('aria-selected')).toBe('true');
  expect(garment.textContent).toContain('3 个批次');
  expect(garment.textContent).toContain('860米');expect(garment.textContent).toContain('420个');expect(garment.textContent).not.toContain('1280');
  expect(getByRole(host,'table',{name:'库存批次列表'}).textContent).not.toContain('府绸坯布');
  await click(fabric);
  expect(fabric.getAttribute('aria-selected')).toBe('true');
  expect(fabric.textContent).toContain('300米');
  expect(getByRole(host,'table',{name:'库存批次列表'}).textContent).toContain('府绸坯布');
});

it('puts isolated returns first, filters by recorded state and keeps the exact quantity wording',async()=>{
  store.state!.fulfillment.stock.push(stock('ok',{name:'可用批次'}),stock('ret',{sourceKind:'claimReturn',purchaseId:undefined,receiptId:undefined,name:'退回大衣',unit:'件',quantity:2,available:0,onHand:2,locked:2,batchNumber:'RET-1'}),stock('gone',{name:'已出库批次',available:0}));
  store.state!.fulfillment.stockMovements.push(movement('m1','gone','issue',100));
  render();
  const table=getByRole(host,'table',{name:'库存批次列表'}),rows=getAllByRole(table,'row').slice(1);
  expect(rows[0].textContent).toContain('退回大衣');expect(rows[0].textContent).toContain('可用 0 / 现存 2 / 隔离 2 件');expect(rows[0].textContent).toContain('隔离中');
  expect(rows[2].textContent).toContain('已出库批次');expect(rows[2].textContent).toContain('已出库 100 个');
  await click(getByRole(host,'button',{name:/隔离待处置/}));
  expect(getByRole(host,'table',{name:'库存批次列表'}).textContent).not.toContain('可用批次');
  choose(getByRole(host,'combobox',{name:'仓库筛选'}) as HTMLSelectElement,'wh');
  expect(getByRole(host,'table',{name:'库存批次列表'}).textContent).toContain('退回大衣');
});

it('explains blocked movements and records a return against the original issue in a dialog over the ledger',async()=>{
  store.state!.fulfillment.stock.push(stock('gone',{available:0}));
  store.state!.fulfillment.stockMovements.push(movement('m1','gone','issue',100),movement('m2','gone','return',30,{issueId:'m1'}));
  render('gone');
  const detail=host.querySelector('[data-stock-detail="gone"]') as HTMLElement;
  expect(detail.textContent).toContain('已全部出库 · 70 个');
  expect((getByRole(detail,'button',{name:'登记出库'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('登记出库：当前没有可用数量');
  expect(detail.textContent).toContain('预留给订单条目、盘点差异与依据 QC 结论的质量冻结：服务端尚未提供');
  expect(getByRole(detail,'table',{name:'出库去向'}).textContent).toContain('70 个');
  await click(getByRole(detail,'button',{name:'按原出库退回'}));
  const dialog=getByRole(document.body,'dialog');
  expect(getByRole(host,'table',{name:'库存批次列表'})).toBeTruthy();
  choose(getByRole(dialog,'combobox',{name:'原出库'}) as HTMLSelectElement,'m1');
  typeInto(getByRole(dialog,'spinbutton',{name:'数量（个）'}) as HTMLInputElement,'20');
  typeInto(getByRole(dialog,'textbox',{name:'实际交接地点'}) as HTMLInputElement,'A-1');
  typeInto(getByRole(dialog,'textbox',{name:'接收 / 交付方'}) as HTMLInputElement,'仓库');
  typeInto(getByRole(dialog,'textbox',{name:'交接依据'}) as HTMLTextAreaElement,'工厂退回余料实点');
  await click(getByRole(dialog,'button',{name:'登记退回'}));
  expect(store.run).toHaveBeenCalledWith({type:'fulfillment.inventory.move',payload:expect.objectContaining({id:'gone',kind:'return',quantity:20,issueId:'m1',note:'工厂退回余料实点'})});
});

it('keeps isolated return batches out of generic issue and move actions',()=>{
  store.state!.fulfillment.stock.push(stock('ret',{sourceKind:'claimReturn',purchaseId:undefined,receiptId:undefined,name:'退回大衣',unit:'件',quantity:2,available:0,onHand:2,locked:2,batchNumber:'RET-1'}));
  store.state!.fulfillment.receivedRecords.push({id:'rr',returnReceiptId:'rt',goodsId:'g',stockId:'ret',source:{shipmentId:'x'} as any,quantity:2,unit:'件',warehouseId:'wh',batchNumber:'RET-1',location:'R-1',ownership:'Owned',ownershipDate:'2026-10-12',ownershipEvidence:'确认',receivedAt:'2026-10-12',basis:'实点',fileIds:[],at:'2026-10-12T08:00:00Z',actorId:'biz',actor:'经办人',inboundMovementId:'i',holdMovementId:'h'});
  render('ret');
  const detail=host.querySelector('[data-stock-detail="ret"]') as HTMLElement;
  expect(detail.textContent).toContain('退回隔离库存');
  expect(queryByRole(detail,'button',{name:'登记出库'})).toBeNull();
  expect(queryByRole(detail,'button',{name:'登记移位'})).toBeNull();
  expect(detail.textContent).toContain('隔离数量');
});

it('stays readable without inventory authority and says why movements are unavailable',()=>{
  session.denied.add('inventory:write');
  store.state!.fulfillment.stock.push(stock('a'));
  render('a');
  expect(host.textContent).toContain('只读查看');
  expect(queryByRole(host,'button',{name:'登记真实仓库'})).toBeNull();
  const detail=host.querySelector('[data-stock-detail="a"]') as HTMLElement;
  expect((getByRole(detail,'button',{name:'登记出库'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('登记出库：需要库存写权限');
  expect(store.run).not.toHaveBeenCalled();
});
