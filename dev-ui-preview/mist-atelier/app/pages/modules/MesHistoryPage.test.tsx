// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getAllByRole,getByRole,queryByRole} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {OutsourcingOrder} from '../../../../../types';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
const api=vi.hoisted(()=>({listOutsourcingOrders:vi.fn(),getOutsourcingOrder:vi.fn()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:'u',displayName:'经办人'},sessionKey:'s',hasPermission:()=>true,canAccessView:()=>true})}));
vi.mock('../../../../../services/apiService',()=>({apiService:api}));
import {MesHistoryPage} from './MesHistoryPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();
async function render(id?:string){await act(async()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'mes',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><MesHistoryPage/></Nav.Provider></ToastProvider></MistRoot>));}
async function click(node:HTMLElement){await act(async()=>node.click());}
const row=(id:string,patch:Partial<OutsourcingOrder>={}):OutsourcingOrder=>({id,orderNumber:'WX-'+id,processType:'Sewing',quantity:500,unit:'件',unitPrice:12,currency:'CNY',totalAmount:6000,orderDate:'2025-06-01',status:'Received',createdAt:0,updatedAt:0,...patch});
beforeEach(()=>{store.state=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T10:00:00Z',actorName:'经办人'},'empty');api.listOutsourcingOrders.mockReset();api.getOutsourcingOrder.mockReset();go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('shows history read-only and points new work to production and procurement',async()=>{
  api.listOutsourcingOrders.mockResolvedValue({items:[row('a',{plannedDeliveryDate:'2025-06-20',actualDeliveryDate:'2025-06-25',qualityAcceptedQty:490,qualityRejectedQty:10})],total:1});
  await render();
  expect(api.listOutsourcingOrders).toHaveBeenCalledWith({limit:100,offset:0});
  const table=getByRole(host,'table',{name:'历史加工记录'});
  expect(table.textContent).toContain('WX-a');expect(table.textContent).toContain('缝制');expect(table.textContent).toContain('晚于计划');expect(table.textContent).toContain('合格 490');
  expect(queryByRole(host,'button',{name:/新建/})).toBeNull();
  await click(getByRole(host,'button',{name:'前往生产进度'}));expect(go).toHaveBeenCalledWith('production-board');
});

it('filters by process and status on the server and resets to the first batch',async()=>{
  api.listOutsourcingOrders.mockResolvedValue({items:[row('a')],total:250});
  await render();
  await click(getByRole(host,'button',{name:'下一批'}));
  expect(api.listOutsourcingOrders).toHaveBeenLastCalledWith({limit:100,offset:100});
  await click(getByRole(host,'button',{name:/工艺/}));await click(getByRole(document.body,'menuitemradio',{name:'印花'}));
  expect(api.listOutsourcingOrders).toHaveBeenLastCalledWith({processType:'Printing',limit:100,offset:0});
  await click(getByRole(host,'button',{name:/状态/}));await click(getByRole(document.body,'menuitemradio',{name:'加工中'}));
  expect(api.listOutsourcingOrders).toHaveBeenLastCalledWith({status:'InProduction',processType:'Printing',limit:100,offset:0});
});

it('opens a record with its lines and resolves the source order only when it exists in this workspace',async()=>{
  store.state!.orders.push({id:'o1',code:'SO-OLD',type:'garment'} as any);
  api.listOutsourcingOrders.mockResolvedValue({items:[row('a',{orderId:'o1',supplierId:'sup-123456789'}),row('b',{orderId:'zzz-unknown'})],total:2});
  api.getOutsourcingOrder.mockImplementation(async(id:string)=>({...row(id,{orderId:'o1'}),lines:[{id:'l1',outsourcingOrderId:id,processType:'Sewing',description:'大衣缝制',quantity:500,unit:'件',unitPrice:12,amount:6000,createdAt:0,updatedAt:0}]}));
  await render('a');
  let detail=host.querySelector('[data-mes-detail="a"]') as HTMLElement;
  expect(getByRole(detail,'table',{name:'WX-a 加工明细'}).textContent).toContain('大衣缝制');
  expect(detail.textContent).toContain('尚未映射到供应商管理');
  await click(getByRole(detail,'button',{name:'SO-OLD'}));expect(go).toHaveBeenCalledWith('orders/detail','o1');
  await render('b');
  detail=host.querySelector('[data-mes-detail="b"]') as HTMLElement;
  expect(detail.textContent).toContain('当前工作空间无对应订单');
});

it('reports a failed history read without inventing records',async()=>{
  api.listOutsourcingOrders.mockRejectedValue(new Error('原生服务不可达'));
  await render();
  expect(host.textContent).toContain('原生服务不可达');expect(host.textContent).toContain('未使用演示记录替代');
  api.listOutsourcingOrders.mockResolvedValue({items:[],total:0});
  await click(getAllByRole(host,'button',{name:'重新读取'})[0]);
  expect(api.listOutsourcingOrders).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('没有可见历史加工记录');
});
