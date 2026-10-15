// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {webcrypto} from 'node:crypto';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {getByRole,getByLabelText,queryByRole,queryByText} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../components/mist';
import {createMistState} from '../../../../server/src/shared/mistWorkspace';
import {Nav,type Route} from '../nav';

const bridge=vi.hoisted(()=>({session:{sessionKey:'session-a',status:'authenticated',user:{id:'actor-a'},canAccessView:(_:string)=>true} as any,workspaceId:'workspace-a',status:'pending',version:0,listeners:new Set<()=>void>(),refresh:vi.fn(),extra:null as any}));
vi.mock('./auth',()=>({useMistSession:()=>bridge.session}));
vi.mock('./workspace',async()=>{const React=await import('react');const {createMistState}=await import('../../../../server/src/shared/mistWorkspace');const base=createMistState({actorName:'测试',actorId:'actor-a',now:'2026-10-13T00:00:00.000Z',id:()=>crypto.randomUUID()},'empty');return{useMistWorkspace:()=>{React.useSyncExternalStore(listener=>{bridge.listeners.add(listener);return()=>{bridge.listeners.delete(listener);};},()=>bridge.version);return{workspace:{id:bridge.workspaceId,name:'当前工作区',revision:1,ownerId:'owner-x'},state:{...base,...(bridge.extra||{}),orderStatus:bridge.status},refresh:bridge.refresh};}};});
vi.mock('../../../../services/apiService',()=>({apiService:{getAuthHeaders:()=>({'Content-Type':'application/json','X-Test-Actor':bridge.session.user.id})}}));
import {useMistWorkspace} from './workspace';
import {MistReviewButton,MistReviewProvider} from './reviews';
import {ApprovalsPage,approvalRows,TRANSFER_UNAVAILABLE} from '../pages/ApprovalsPage';

let host:HTMLDivElement,root:Root,serverStatus:'pending'|'approved'|'rejected',postCount:number,rows:any[]|undefined;
let intercept:((url:string,init:RequestInit)=>Promise<any>|undefined)|undefined;
const key='bambook.mist.review-pending:actor-a';
const intent={workspaceId:'workspace-a',reviewId:'order:round-one',requestId:'original-request',expectedRevision:1,decision:'approved',note:'核对合同'};
const response=(data:any,status=200)=>({ok:status<400,status,json:async()=>data});
function row(patch:any={}){return{id:'order:round-one',kind:'order',entityId:'order-one',title:'SO-ONE 主单审批',requesterId:'actor-b',reviewerIds:['actor-a'],status:serverStatus,submittedAt:'2026-10-13',requiredPermission:'orders:write',target:{view:'orders/detail',id:'order-one'},details:[{label:'金额',value:'48 USD'}],workspaceId:'workspace-a',workspaceName:'当前工作区',revision:1,canDecide:serverStatus==='pending',...patch};}
function publish(){bridge.version++;bridge.listeners.forEach(listener=>listener());}
function Probe(){const workspace=useMistWorkspace();return <p data-testid="business-state">{workspace.workspace?.id}:{(workspace.state as any).orderStatus}</p>;}
let route:Route={view:'approvals'};const go=vi.fn();
function Harness(){const [current,setCurrent]=React.useState<Route>(route);route=current;go.mockImplementation((view:string,id?:string,target={})=>setCurrent({view,id,...target}));
 return <Nav.Provider value={{route:current,go,theme:'light',toggleTheme:vi.fn(),openAI:vi.fn(),openPalette:vi.fn()} as any}><MistReviewProvider><Probe/><MistReviewButton/>{current.view==='approvals'&&<ApprovalsPage/>}</MistReviewProvider></Nav.Provider>;}
async function render(){await act(async()=>root.render(<MistRoot><ToastProvider><Harness/></ToastProvider></MistRoot>));}
async function click(name:string|RegExp){await act(async()=>getByRole(document.body,'button',{name}).click());}
function tableRows(){return [...host.querySelectorAll<HTMLElement>('[aria-label="审批事项"] [role="row"][tabindex]')];}
async function openRow(text='SO-ONE'){const target=tableRows().find(r=>r.textContent?.includes(text));expect(target).toBeTruthy();await act(async()=>target!.click());}
async function typeNote(value:string){const input=getByLabelText(document.body,'审批意见') as HTMLTextAreaElement;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
async function prepareDecision(){await openRow();await typeNote('核对合同通过');}
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>{resolve=yes;});return{promise,resolve};}
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();bridge.listeners.clear();bridge.session={sessionKey:'session-a',status:'authenticated',user:{id:'actor-a'},canAccessView:()=>true};bridge.workspaceId='workspace-a';bridge.status='pending';bridge.version=0;bridge.extra=null;serverStatus='pending';postCount=0;intercept=undefined;rows=undefined;route={view:'approvals'};go.mockReset();
 bridge.refresh=vi.fn(async()=>{bridge.status=serverStatus;publish();});
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit={})=>{
  const intercepted=intercept?.(String(url),init);if(intercepted)return intercepted;
  if(String(url)==='/api/mist/reviews')return response({reviews:bridge.session.user.id==='actor-a'?(rows??[row()]):[]});
  if(String(url).includes('/receipts/'))return response({receipt:{requestId:intent.requestId,revision:2,result:{reviewId:intent.reviewId}}});
  if(init.method==='POST'){postCount++;const body=JSON.parse(String(init.body));serverStatus=body.decision;return response({receipt:{requestId:body.requestId,revision:2,result:{reviewId:intent.reviewId}}});}
  throw new Error('Unexpected request: '+url);
 }));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

it('refreshes the current workspace after approval so the existing business page is no longer pending',async()=>{
 await render();await prepareDecision();await click('批准');
 expect(bridge.refresh).toHaveBeenCalledTimes(1);expect(host.querySelector('[data-testid="business-state"]')?.textContent).toBe('workspace-a:approved');
 expect(localStorage.getItem(key)).toBeNull();expect(postCount).toBe(1);
});
it('does not refresh or replace the current workspace when deciding a different workspace',async()=>{
 bridge.workspaceId='workspace-b';await render();await prepareDecision();await click('批准');
 expect(bridge.refresh).not.toHaveBeenCalled();expect(host.querySelector('[data-testid="business-state"]')?.textContent).toBe('workspace-b:pending');expect(postCount).toBe(1);
});
it('refreshes the current workspace when recovering a saved approval receipt without posting another decision',async()=>{
 localStorage.setItem(key,JSON.stringify(intent));serverStatus='approved';await render();await click('核对原请求');
 expect(bridge.refresh).toHaveBeenCalledTimes(1);expect(bridge.status).toBe('approved');expect(postCount).toBe(0);expect(localStorage.getItem(key)).toBeNull();
});
it('does not refresh the workspace selected after the decision started',async()=>{
 const gate=deferred();let requestId='';intercept=(url,init)=>{if(init.method==='POST'){postCount++;requestId=JSON.parse(String(init.body)).requestId;return gate.promise;}return undefined;};
 await render();await prepareDecision();await click('批准');
 bridge.workspaceId='workspace-b';await act(async()=>publish());
 await act(async()=>gate.resolve(response({receipt:{requestId,revision:2,result:{reviewId:intent.reviewId}}})));
 expect(bridge.refresh).not.toHaveBeenCalled();expect(bridge.workspaceId).toBe('workspace-b');
});
it('does not apply a former identity approval response to the new identity workspace',async()=>{
 const gate=deferred();let requestId='';intercept=(url,init)=>{if(init.method==='POST'){postCount++;requestId=JSON.parse(String(init.body)).requestId;return gate.promise;}return undefined;};
 await render();await prepareDecision();await click('批准');
 bridge.session={sessionKey:'session-b',status:'authenticated',user:{id:'actor-b'},canAccessView:()=>true};bridge.workspaceId='workspace-b';await render();
 await act(async()=>gate.resolve(response({receipt:{requestId,revision:2,result:{reviewId:intent.reviewId}}})));
 expect(bridge.refresh).not.toHaveBeenCalled();expect(bridge.workspaceId).toBe('workspace-b');expect(localStorage.getItem(key)).not.toBeNull();expect(localStorage.getItem('bambook.mist.review-pending:actor-b')).toBeNull();
});
it('retains request recovery protection when a response has a mismatched receipt',async()=>{
 intercept=(_url,init)=>init.method==='POST'?Promise.resolve(response({receipt:{requestId:'wrong-request'}})):undefined;
 await render();await prepareDecision();await click('批准');expect(bridge.refresh).not.toHaveBeenCalled();expect(localStorage.getItem(key)).not.toBeNull();
 expect(document.body.textContent).toContain('审批回执与原请求不符');expect(document.body.textContent).toContain('有审批结果待核对');
 expect((getByRole(document.body,'button',{name:'批准'}) as HTMLButtonElement).disabled).toBe(true);
});
it('reports a workspace refresh failure without claiming the saved approval must be posted again',async()=>{
 bridge.refresh=vi.fn(async()=>{throw new Error('当前工作区读取暂不可用');});await render();await prepareDecision();await click('批准');
 expect(localStorage.getItem(key)).toBeNull();expect(document.body.textContent).toContain('审批已保存');expect(document.body.textContent).toContain('当前工作区读取暂不可用');expect(queryByText(document.body,'有审批结果待核对')).toBeNull();
});

it('requires a written reason before returning and never posts an empty decision',async()=>{
 await render();await openRow();await click('退回');
 expect(postCount).toBe(0);expect(document.body.textContent).toContain('退回必须写明理由');
 await typeNote('单价与合同不符');await click('退回');
 expect(postCount).toBe(1);expect(serverStatus).toBe('rejected');
});
it('keeps transfer visible but disabled with the concrete reason',async()=>{
 await render();await openRow();
 expect((getByRole(document.body,'button',{name:'转交'}) as HTMLButtonElement).disabled).toBe(true);
 expect(document.body.textContent).toContain(TRANSFER_UNAVAILABLE);
});
it('shows the submitted snapshot and blocks opening another workspace business record',async()=>{
 rows=[row({workspaceId:'workspace-z',workspaceName:'另一空间'})];await render();await openRow();
 expect(document.body.textContent).toContain('48 USD');
 expect((getByRole(document.body,'button',{name:'打开原业务'}) as HTMLButtonElement).disabled).toBe(true);
 expect(document.body.textContent).toContain('请先切换到该空间');
});
it('opens the exact business record when the review belongs to the current workspace',async()=>{
 await render();await openRow();await click('打开原业务');
 expect(go).toHaveBeenLastCalledWith('orders/detail','order-one');
});
it('lists my submitted items, including current-workspace requests where I am not a reviewer, as read-only',async()=>{
 bridge.extra={payables:{bills:[],payments:[],allocations:[],plans:[],requests:[{id:'req-1',code:'PR-2026-0001',purpose:'bill',supplierId:'s',supplier:'甲供应商',currency:'CNY',amount:120,lines:[],requesterId:'actor-a',requester:'我',submittedAt:'2026-10-14T02:00:00.000Z',reviewerIds:['boss'],snapshot:[{label:'用途',value:'货款'}],fileIds:[],state:'pending',note:''}]}};
 rows=[];await render();
 await act(async()=>getByRole(host,'tab',{name:/我发起的/}).click());
 await openRow('PR-2026-0001');
 expect(document.body.textContent).toContain('货款');expect(document.body.textContent).toContain('你是发起人，不能审批本人提交的事项');
 expect(queryByRole(document.body,'textbox',{name:'审批意见'})).toBeNull();
 expect((getByRole(document.body,'button',{name:'批准'}) as HTMLButtonElement).disabled).toBe(true);
});
it('separates pending decisions for me from history and other pending items',()=>{
 const base=row();const list=[base,{...base,id:'b',status:'approved',canDecide:false},{...base,id:'c',canDecide:false,requesterId:'actor-c'},{...base,id:'d',canDecide:false,requesterId:'actor-a'}] as any[];
 expect(approvalRows(list,'mine','actor-a').map(r=>r.id)).toEqual(['order:round-one']);
 expect(approvalRows(list,'done','actor-a').map(r=>r.id)).toEqual(['b']);
 expect(approvalRows(list,'others','actor-a').map(r=>r.id)).toEqual(['c']);
 expect(approvalRows(list,'sent','actor-a').map(r=>r.id)).toEqual(['d']);
});
it('routes the top-bar entry to the approvals page and announces how many items wait for me',async()=>{
 route={view:'cockpit'};await render();
 const button=getByRole(document.body,'button',{name:'审批与放行（1 项待我审批）'});
 await act(async()=>button.click());expect(go).toHaveBeenLastCalledWith('approvals');
 expect(tableRows().length).toBe(1);
});
