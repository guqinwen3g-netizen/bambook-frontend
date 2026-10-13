// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getByRole} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState} from '../../../../../server/src/shared/mistWorkspace';
import {Nav} from '../../nav';
import {LocalMesPage} from './LocalMesPage';
const state=vi.hoisted(()=>({workspace:null as any}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>state.workspace}));
let host:HTMLElement,root:Root;const go=vi.fn();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
beforeEach(()=>{const workspace=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T00:00:00Z',actorName:'业务'},'empty');state.workspace={state:workspace,loading:false,saving:false,pending:null,error:'',refresh:vi.fn()};go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
function render(id?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'mes',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><LocalMesPage/></Nav.Provider></ToastProvider></MistRoot>));}
it('shows empty local history from workspace without calling legacy services',()=>{render();expect(host.textContent).toContain('还没有历史加工记录');expect(host.textContent).not.toContain('读取失败');});
it('reads true processing receipts and returns to exact order and production sources',async()=>{state.workspace.state.fulfillment.purchases.push({id:'p',code:'PO-1',orderId:'o',lineId:'l',kind:'processing',supplier:'加工厂',description:'加工内容',quantity:10,received:12,unit:'件',due:'2026-10-13',state:'approved',destination:'实际地点',terms:'真实条款'});state.workspace.state.fulfillment.receipts.push({id:'r',purchaseId:'p',date:'2026-10-13',quantity:12,rejected:1,location:'实际地点',evidence:'实际交付凭据'});state.workspace.state.productions.push({id:'prod',sourcePurchaseId:'p'});render();expect(host.textContent).toContain('数量差异待处理');render('p');expect(host.querySelector('[data-mes-detail="p"]')).not.toBeNull();expect(host.textContent).toContain('12 / 10 件');expect(getByRole(document.body,'table',{name:'加工实际交付'}).textContent).toContain('实收 12 · 拒收 1 件');await act(async()=>getByRole(document.body,'button',{name:'返回来源条目'}).click());expect(go).toHaveBeenCalledWith('orders/detail','o',{orderLineId:'l',productionId:'prod'});await act(async()=>getByRole(document.body,'button',{name:'打开加工合同'}).click());expect(go).toHaveBeenCalledWith('procurement','p');});
