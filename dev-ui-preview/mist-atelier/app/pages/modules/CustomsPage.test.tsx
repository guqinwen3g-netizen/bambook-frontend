// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getByRole,queryByRole} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {FulfillmentShipment,FulfillmentDocument,FulfillmentCustoms} from '../../../../../server/src/shared/mistFulfillment';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
const session=vi.hoisted(()=>({denied:new Set<string>()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:'ops',displayName:'后勤'},sessionKey:'s',hasPermission:(p:string)=>!session.denied.has(p),canAccessView:()=>true})}));
import {CustomsPage,customsFlags,rebateEvidence} from './CustomsPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();
function render(id?:string,section?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'customs',id,section},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><CustomsPage/></Nav.Provider></ToastProvider></MistRoot>));}
async function click(node:HTMLElement){await act(async()=>node.click());}
function typeInto(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
const shipment=(id:string,patch:Partial<FulfillmentShipment>={}):FulfillmentShipment=>({id,code:id.toUpperCase(),customerId:'c',customer:'Cedar',domain:'garment',consignee:'Cedar DC',mode:'sea',portOfLoading:'上海',portOfDischarge:'Felixstowe',incoterm:'FOB',plannedDate:'2099-01-01',booking:'',lines:[{orderId:'o',lineId:'l',productionId:'p',quantity:10,factoryConfirmedAt:'2026-10-09'}],note:'',fileIds:[],state:'preparing',requestedBy:'业务',requesterId:'biz',createdAt:'2026-10-08T08:00:00Z',...patch});
const pack=(shipmentId:string,quantity:number)=>({id:shipmentId+quantity,shipmentId,lineId:'l',productionId:'p',carton:'1',quantity,netWeight:9,grossWeight:10,volume:0.1,note:''});
const customs=(shipmentId:string,status:FulfillmentCustoms['status'],patch:Partial<FulfillmentCustoms>={}):FulfillmentCustoms=>({id:'cus-'+shipmentId,shipmentId,code:'CUS-'+shipmentId.toUpperCase(),status,declarationNo:status==='draft'?'':'D-'+shipmentId,broker:'上港报关',hsCode:'6202.13',origin:'CN',tradeMode:'一般贸易',declaredAt:status==='draft'?'':'2026-10-12',clearedAt:status==='cleared'?'2026-10-13':'',evidence:'',fileIds:[],note:'',...patch});
const ci=(shipmentId:string,invoiceId?:string):FulfillmentDocument=>({id:'ci-'+shipmentId,shipmentId,orderId:'o',type:'CI',number:'CI-'+shipmentId,version:1,title:'CI',dueDate:'2026-11-01',content:'',fileIds:[],status:'issued',createdAt:'2026-10-10T08:00:00Z',actor:'后勤',...(invoiceId?{invoiceId}:{})} as FulfillmentDocument);
beforeEach(()=>{session.denied=new Set();const s=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T10:00:00Z',actorName:'后勤'},'empty');
  s.orders.push({id:'o',code:'SO-1',type:'garment',customerId:'c',customer:'Cedar',currency:'USD',due:'2026-11-08'} as any);s.orderLines.push({id:'l',orderId:'o',name:'大衣',style:'COAT-1',img:'coat',qty:10,unit:'件',price:10,made:10,qc:10} as any);
  store.state=s;store.run.mockReset();store.run.mockResolvedValue({result:{}});go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('derives customs reminders and rebate evidence only from recorded shipment, packing and receivable facts',()=>{
  const st=store.state!,f=st.fulfillment;
  f.shipments.push(shipment('a',{state:'ready',documentsSentAt:'2026-10-12T08:00:00Z'}),shipment('b'),shipment('c'),shipment('d',{state:'cancelled'}),shipment('e',{state:'departed'}));
  f.packing.push(pack('a',10),pack('c',4));
  const a=customs('a','submitted'),b=customs('b','draft'),c=customs('c','draft'),d=customs('d','submitted'),e=customs('e','cleared');
  expect(customsFlags(st,a).map(x=>x.key)).toEqual(['awaiting']);
  expect(customsFlags(st,b).map(x=>x.key)).toEqual(['unpacked']);
  expect(customsFlags(st,c).map(x=>x.key)).toEqual(['packing']);
  expect(customsFlags(st,d).map(x=>x.key)).toEqual(['cancelled']);
  expect(customsFlags(st,e)).toEqual([]);
  expect(rebateEvidence(st,e)).toMatchObject({released:true,collected:false,ready:1});
  f.documents.push(ci('e','inv-e'));st.invoices.push({id:'inv-e',code:'CI-e',orderId:'o',order:'SO-1',customer:'Cedar',due:'2026-11-01',amount:100,open:40,currency:'USD'});
  expect(rebateEvidence(st,e)).toMatchObject({collected:false,open:[{currency:'USD',amount:40}],ready:1});
  st.invoices[0].open=0;
  expect(rebateEvidence(st,e)).toMatchObject({collected:true,ready:2});
  st.invoices[0].voidedAt='2026-10-13T00:00:00Z';
  expect(rebateEvidence(st,e).collected).toBe(false);
});

it('lists shipments still awaiting a customs record and creates the draft from that row',async()=>{
  const f=store.state!.fulfillment;f.shipments.push(shipment('s1'),shipment('s2'),shipment('s3',{state:'departed'}));f.customs.push(customs('s2','draft'));
  render();
  const pending=getByRole(host,'table',{name:'待建报关的出运'});
  expect(pending.textContent).toContain('S1');expect(pending.textContent).not.toContain('S2');expect(pending.textContent).not.toContain('S3');
  expect(getByRole(host,'table',{name:'报关列表'}).textContent).toContain('CUS-S2');
  await click(getByRole(pending,'button',{name:'为 S1 建立报关记录'}));
  const dialog=getByRole(document.body,'dialog');expect(getByRole(host,'table',{name:'报关列表'})).toBeTruthy();
  await click(getByRole(dialog,'button',{name:'建立记录'}));
  expect(store.run).toHaveBeenCalledWith({type:'fulfillment.customs.save',payload:expect.objectContaining({shipmentId:'s1',status:'draft',declarationNo:'',fileIds:[]})});
});

it('registers the declaration and then the release in dialogs, and stops edits once released',async()=>{
  const f=store.state!.fulfillment;f.shipments.push(shipment('s'));f.packing.push(pack('s',10));f.customs.push(customs('s','draft'));
  render('cus-s');
  let detail=host.querySelector('[data-customs-detail="cus-s"]') as HTMLElement;
  expect(detail.textContent).toContain('资料准备中');
  await click(getByRole(detail,'button',{name:'登记已申报'}));
  let dialog=getByRole(document.body,'dialog');
  typeInto(getByRole(dialog,'textbox',{name:'报关单号'}) as HTMLInputElement,'223320260001');
  await click(getByRole(dialog,'button',{name:'登记已申报'}));
  expect(store.run).toHaveBeenLastCalledWith({type:'fulfillment.customs.save',payload:expect.objectContaining({id:'cus-s',shipmentId:'s',status:'submitted',declarationNo:'223320260001',broker:'上港报关',hsCode:'6202.13'})});
  Object.assign(f.customs[0],{status:'submitted',declarationNo:'223320260001',declaredAt:'2026-10-12'});store.state={...store.state!};render('cus-s');
  detail=host.querySelector('[data-customs-detail="cus-s"]') as HTMLElement;
  expect(queryByRole(detail,'button',{name:'编辑报关资料'})).toBeNull();
  await click(getByRole(detail,'button',{name:'登记海关放行'}));
  dialog=getByRole(document.body,'dialog');
  typeInto(getByRole(dialog,'textbox',{name:'放行依据'}) as HTMLTextAreaElement,'海关放行通知');
  await click(getByRole(dialog,'button',{name:'登记放行'}));
  expect(store.run).toHaveBeenLastCalledWith({type:'fulfillment.customs.save',payload:expect.objectContaining({id:'cus-s',status:'cleared',declarationNo:'223320260001',declaredAt:'2026-10-12',evidence:'海关放行通知'})});
  Object.assign(f.customs[0],{status:'cleared',clearedAt:'2026-10-13',evidence:'海关放行通知'});store.state={...store.state!};render('cus-s');
  detail=host.querySelector('[data-customs-detail="cus-s"]') as HTMLElement;
  expect(queryByRole(detail,'button',{name:'登记海关放行'})).toBeNull();
  expect(detail.textContent).toContain('已放行记录不可覆盖');
  expect(detail.textContent).toContain('增值税专用发票');
});

it('explains why a departed shipment\'s record is locked and keeps users without customs permission read-only',()=>{
  const f=store.state!.fulfillment;f.shipments.push(shipment('s',{state:'departed'}),shipment('t'));f.customs.push(customs('s','submitted'));
  render('cus-s');
  const detail=host.querySelector('[data-customs-detail="cus-s"]') as HTMLElement;
  expect((getByRole(detail,'button',{name:'登记海关放行'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('出运已离港或已取消，报关记录不能再修改');
  session.denied.add('customs:write');render('cus-s');
  expect(host.textContent).toContain('只读查看');
  expect(queryByRole(host,'button',{name:'建立报关记录'})).toBeNull();
  expect(queryByRole(host,'button',{name:'为 T 建立报关记录'})).toBeNull();
  expect(queryByRole(host.querySelector('[data-customs-detail="cus-s"]') as HTMLElement,'button',{name:'登记海关放行'})).toBeNull();
});

it('lists LC-paid orders and rebate evidence without inventing LC terms or refund amounts',async()=>{
  const st=store.state!,f=st.fulfillment;
  (st.orders[0] as any).governance={status:'approved',rounds:[],effectiveVersion:1,contract:{kind:'external',poNumber:'PO',confirmationFileIds:[],internalPurpose:'',receiver:'',paymentMethod:'LC',depositPercent:null,paymentNote:'L/C at sight',incoterm:'FOB',deliveryPlace:'上海'}};
  f.shipments.push(shipment('s',{state:'departed'}));f.customs.push(customs('s','cleared'));f.documents.push(ci('s','inv'));
  st.invoices.push({id:'inv',code:'CI-s',orderId:'o',order:'SO-1',customer:'Cedar',due:'2026-11-01',amount:100,open:0,currency:'USD'});
  render();
  await click(getByRole(host,'tab',{name:/信用证/}));
  expect(host.textContent).toContain('信用证台账尚未接入');
  const lc=getByRole(host,'table',{name:'信用证付款订单'});
  expect(lc.textContent).toContain('SO-1');expect(lc.textContent).toContain('L/C at sight');expect(lc.textContent).toContain('S');
  await click(getByRole(host,'tab',{name:/退税/}));
  const rebate=getByRole(host,'table',{name:'退税资料核对'});
  expect(rebate.textContent).toContain('已全部收汇');expect(rebate.textContent).toContain('尚未接入');expect(rebate.textContent).toContain('2 / 3');
  expect(host.textContent).toContain('参考退税额与到账勾稽尚未接入');
});
