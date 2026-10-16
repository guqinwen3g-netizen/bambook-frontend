// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getAllByRole,getByRole,queryByRole} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {FulfillmentShipment,FulfillmentDocument} from '../../../../../server/src/shared/mistFulfillment';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
const session=vi.hoisted(()=>({id:'biz',denied:new Set<string>()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:session.id,displayName:'经办人'},sessionKey:'s',hasPermission:(p:string)=>!session.denied.has(p),canAccessView:()=>true})}));
import {ShipmentsPage,shipmentStage} from './ShipmentsPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();
function render(id?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'shipments',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><ShipmentsPage/></Nav.Provider></ToastProvider></MistRoot>));}
async function click(node:HTMLElement){await act(async()=>node.click());}
function typeInto(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
const shipment=(id:string,patch:Partial<FulfillmentShipment>={}):FulfillmentShipment=>({id,code:id.toUpperCase(),customerId:'c',customer:'Cedar',domain:'garment',consignee:'Cedar DC',mode:'sea',portOfLoading:'上海',portOfDischarge:'Felixstowe',incoterm:'FOB',plannedDate:'2099-01-01',booking:'',lines:[{orderId:'o',lineId:'l',productionId:'p',quantity:10,factoryConfirmedAt:'2026-10-09'}],note:'',fileIds:[],state:'preparing',requestedBy:'经办人',requesterId:'biz',createdAt:'2026-10-08T08:00:00Z',...patch});
const doc=(id:string,shipmentId:string,type:FulfillmentDocument['type'],status:FulfillmentDocument['status']='issued'):FulfillmentDocument=>({id,shipmentId,orderId:type==='CI'?'o':'',type,number:type+'-'+id,version:1,title:type,dueDate:'',content:'',fileIds:[],status,createdAt:'2026-10-10T08:00:00Z',actor:'后勤'});
const pack=(shipmentId:string,quantity:number)=>({id:shipmentId+quantity,shipmentId,lineId:'l',productionId:'p',carton:'1',quantity,netWeight:9,grossWeight:10,volume:0.1,note:''});
const customs=(shipmentId:string,status:'draft'|'submitted'|'cleared')=>({id:'cus-'+shipmentId,shipmentId,code:'CUS-'+shipmentId,status,declarationNo:'D1',broker:'报关行',hsCode:'6202',origin:'CN',tradeMode:'一般贸易',declaredAt:'2026-10-13',clearedAt:'',evidence:'',fileIds:[],note:''});
beforeEach(()=>{session.id='biz';session.denied=new Set();const s=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T10:00:00Z',actorName:'经办人'},'empty');
  s.orders.push({id:'o',code:'SO-1',type:'garment',customerId:'c',customer:'Cedar',currency:'USD'} as any);s.orderLines.push({id:'l',orderId:'o',name:'大衣',style:'COAT-1',img:'coat',qty:10,unit:'件',price:10,made:10,qc:10});
  store.state=s;store.run.mockReset();store.run.mockResolvedValue({result:{}});go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('derives the logistics stage only from recorded packing, booking, documents, dispatch and departure',()=>{
  const f=store.state!.fulfillment;
  f.shipments.push(shipment('a'),shipment('b',{booking:'BK'}),shipment('c',{state:'ready'}),shipment('d',{state:'ready',documentsSentAt:'2026-10-12T08:00:00Z'}),shipment('e',{state:'departed',departedAt:'2026-10-13T08:00:00Z'}),shipment('f',{state:'cancelled'}),shipment('g'));
  f.packing.push(pack('g',4));
  expect(f.shipments.map(s=>shipmentStage(store.state!,s))).toEqual(['intake','logistics','business','departure','departed','cancelled','logistics']);
  render();
  const pipeline=getByRole(host,'button',{name:/进行中与已出运/});expect(pipeline.textContent).toContain('6');
  expect(getByRole(host,'button',{name:/已取消/}).textContent).toContain('1');
  const rows=getAllByRole(getByRole(host,'table',{name:'出运列表'}),'row').slice(1);
  expect(rows[0].textContent).toContain('G');expect(rows[0].textContent).toContain('装箱与计划不符');
  expect(getByRole(host,'table',{name:'出运列表'}).textContent).not.toContain('已取消');
});

it('keeps fabric and garment shipments apart and filters to my own requests',async()=>{
  store.state!.fulfillment.shipments.push(shipment('mine'),shipment('other',{requesterId:'someone',requestedBy:'别人'}),shipment('fab',{domain:'fabric',code:'FAB-1'}));
  render();
  expect(getByRole(host,'button',{name:/成衣业务 · 2/})).toBeTruthy();
  const table=()=>getByRole(host,'table',{name:'出运列表'});
  expect(table().textContent).not.toContain('FAB-1');
  await click(getByRole(host,'button',{name:/筛选/}));await click(getByRole(document.body,'menuitemradio',{name:'我发起的'}));
  expect(table().textContent).toContain('MINE');expect(table().textContent).not.toContain('OTHER');
  await click(getByRole(host,'button',{name:/面料业务 · 1/}));
  expect(table().textContent).toContain('FAB-1');
});

it('shows why documents cannot be marked ready and hides request edits once logistics has packed',()=>{
  const f=store.state!.fulfillment;f.shipments.push(shipment('s',{booking:'BK-1'}));f.packing.push(pack('s',10));f.documents.push(doc('pl','s','PL'),doc('ci','s','CI','draft'));
  render('s');
  const detail=host.querySelector('[data-shipment-detail="s"]') as HTMLElement;
  expect(detail.textContent).toContain('后勤处理中');
  expect((getByRole(detail,'button',{name:'完成单证准备'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('完成单证准备：请按原订单分别签发 CI');
  expect((getByRole(detail,'button',{name:'分配装箱'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('分配装箱：已有有效 CI 或装箱单');
  expect(queryByRole(detail,'button',{name:'编辑出运请求'})).toBeNull();
  expect(detail.textContent).toContain('退回业务确认差异：服务端尚未提供差异退回');
  expect(getByRole(detail,'table',{name:'S 来源范围'}).textContent).toContain('10 / 10 件');
});

it('gates departure on customer dispatch and export clearance, then records ATD in a dialog over the list',async()=>{
  const f=store.state!.fulfillment;f.shipments.push(shipment('s',{state:'ready',booking:'BK',documentsSentAt:'2026-10-12T08:00:00Z'}));f.customs.push(customs('s','submitted'));
  render('s');
  let detail=host.querySelector('[data-shipment-detail="s"]') as HTMLElement;
  expect((getByRole(detail,'button',{name:'登记实际离港'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('登记实际离港：出口清关尚未完成');
  f.customs[0].status='cleared';store.state={...store.state!};render('s');
  detail=host.querySelector('[data-shipment-detail="s"]') as HTMLElement;
  await click(getByRole(detail,'button',{name:'登记实际离港'}));
  const dialog=getByRole(document.body,'dialog');expect(getByRole(host,'table',{name:'出运列表'})).toBeTruthy();
  typeInto(getByRole(dialog,'textbox',{name:'实际离港 / 起飞依据'}) as HTMLTextAreaElement,'船公司离港通知');
  await click(getByRole(dialog,'button',{name:'登记离港'}));
  expect(store.run).toHaveBeenCalledWith(expect.objectContaining({type:'fulfillment.shipments.depart',payload:expect.objectContaining({id:'s',evidence:'船公司离港通知'})}));
});

it('lets a business-only user record the customer dispatch without logistics actions',async()=>{
  session.denied.add('shipments:write');
  store.state!.fulfillment.shipments.push(shipment('s',{state:'ready',booking:'BK'}));
  render('s');
  const detail=host.querySelector('[data-shipment-detail="s"]') as HTMLElement;
  expect(detail.textContent).toContain('资料已回业务');
  expect(queryByRole(detail,'button',{name:'分配装箱'})).toBeNull();
  expect(queryByRole(detail,'button',{name:'登记实际离港'})).toBeNull();
  await click(getByRole(detail,'button',{name:'登记已向客户发送CI/PL'}));
  await click(getByRole(getByRole(document.body,'dialog'),'button',{name:'登记发送'}));
  expect(store.run).toHaveBeenCalledWith(expect.objectContaining({type:'fulfillment.shipments.sent',payload:expect.objectContaining({id:'s'})}));
});

it('BB-ORD-6 warns before saving a shipment above the over-ship cap and offers an over-ship request; short shipments are only a hint',async()=>{
  const s=store.state!;s.orderLines[0].qty=1000;(s.orders[0] as any).governance={status:'approved',contract:{overPercent:3,shortPercent:3,incoterm:'FOB'}};
  s.productions.push({id:'p',code:'PR-1',orderId:'o',lineId:'l',order:'SO-1',name:'大衣',factory:'工厂',qty:1050,due:'2026-11-01',pct:100,img:'coat',col:'done'});
  s.fulfillment.shippingTerms.push({orderId:'o',consignee:'Cedar DC',partialAllowed:true,mode:'sea',confirmedAt:'2026-10-12',evidence:'合同'} as any);
  s.fulfillment.shipments.push(shipment('a',{lines:[{orderId:'o',lineId:'l',productionId:'p',quantity:1000,factoryConfirmedAt:'2026-10-09'}]}));
  render();await click(getByRole(host,'button',{name:'新建出运'}));
  const select=getByRole(host,'combobox',{name:'来源条目 1'}) as HTMLSelectElement;
  act(()=>{select.value='production:p';select.dispatchEvent(new Event('change',{bubbles:true}));});
  const qty=host.querySelector('input[type="number"]') as HTMLInputElement;typeInto(qty,'50');
  const over=host.querySelector('[data-over-ship="l"]')!;expect(host.textContent).toContain('超出允许溢装，须经理审批');expect(over.textContent).toContain('累计出运 1050');expect(over.textContent).toContain('溢装上限 1030');expect(over.textContent).toContain('超出 20');
  expect(host.querySelector('.mist-banner p p, .mist-banner p div')).toBeNull();
  const request=getByRole(host,'button',{name:'发起超量出运申请'}) as HTMLButtonElement;expect(request.disabled).toBe(true);
  typeInto(getByRole(host,'textbox',{name:'超量原因 COAT-1'}) as HTMLTextAreaElement,'客户要求多发补损');
  await click(request);
  expect(store.run).toHaveBeenCalledWith({type:'order.governance.requestOverShip',payload:{orderId:'o',lineId:'l',quantity:1050,reason:'客户要求多发补损'}});
  expect(host.textContent).toContain('已发起超量出运申请');
  await click(getByRole(host,'button',{name:'下一步'}));expect(host.textContent).toContain('请先发起超量出运申请并等待批准');
  s.fulfillment.shipments[0].lines[0].quantity=900;typeInto(qty,'20');
  expect(host.querySelector('[data-over-ship]')).toBeNull();expect(host.querySelector('[data-short-ship="l"]')!.textContent).toContain('低于短装下限 970');expect(host.textContent).toContain('本条目预计短装');
});
