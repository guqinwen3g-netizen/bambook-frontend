// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {webcrypto} from 'node:crypto';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {getByRole,getByLabelText,queryByText} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../components/mist';

const bridge=vi.hoisted(()=>({session:{sessionKey:'session-a',status:'authenticated',user:{id:'actor-a'}},workspaceId:'workspace-a',status:'pending',version:0,listeners:new Set<()=>void>(),refresh:vi.fn()}));
vi.mock('./auth',()=>({useMistSession:()=>bridge.session}));
vi.mock('./workspace',async()=>{const React=await import('react');return{useMistWorkspace:()=>{React.useSyncExternalStore(listener=>{bridge.listeners.add(listener);return()=>{bridge.listeners.delete(listener);};},()=>bridge.version);return{workspace:{id:bridge.workspaceId},state:{orderStatus:bridge.status},refresh:bridge.refresh};}};});
vi.mock('../../../../services/apiService',()=>({apiService:{getAuthHeaders:()=>({'Content-Type':'application/json','X-Test-Actor':bridge.session.user.id})}}));
import {useMistWorkspace} from './workspace';
import {MistReviewButton} from './reviews';

let host:HTMLDivElement,root:Root,serverStatus:'pending'|'approved'|'rejected',postCount:number;
let intercept:((url:string,init:RequestInit)=>Promise<any>|undefined)|undefined;
const key='bambook.mist.review-pending:actor-a';
const intent={workspaceId:'workspace-a',reviewId:'order:round-one',requestId:'original-request',expectedRevision:1,decision:'approved',note:'核对合同'};
const response=(data:any,status=200)=>({ok:status<400,status,json:async()=>data});
function row(){return{id:'order:round-one',kind:'order',entityId:'order-one',title:'SO-ONE 主单审批',requesterId:'actor-a',reviewerIds:['actor-a'],status:serverStatus,submittedAt:'2026-10-13',requiredPermission:'orders:write',target:{view:'orders/detail',id:'order-one'},details:[{label:'金额',value:'48 USD'}],workspaceId:'workspace-a',workspaceName:'当前工作区',revision:1,canDecide:serverStatus==='pending'};}
function publish(){bridge.version++;bridge.listeners.forEach(listener=>listener());}
function Probe(){const workspace=useMistWorkspace();return <p data-testid="business-state">{workspace.workspace?.id}:{(workspace.state as any).orderStatus}</p>;}
async function render(){await act(async()=>root.render(<MistRoot><ToastProvider><Probe/><MistReviewButton/></ToastProvider></MistRoot>));}
async function click(name:string){await act(async()=>getByRole(document.body,'button',{name}).click());}
async function prepareDecision(){await click('审批事项');await click('核对与决定');const input=getByLabelText(document.body,'审批意见') as HTMLTextAreaElement;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'核对合同通过');input.dispatchEvent(new Event('input',{bubbles:true}));});}
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>{resolve=yes;});return{promise,resolve};}
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();bridge.listeners.clear();bridge.session={sessionKey:'session-a',status:'authenticated',user:{id:'actor-a'}};bridge.workspaceId='workspace-a';bridge.status='pending';bridge.version=0;serverStatus='pending';postCount=0;intercept=undefined;
 bridge.refresh=vi.fn(async()=>{bridge.status=serverStatus;publish();});
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit={})=>{
  const intercepted=intercept?.(String(url),init);if(intercepted)return intercepted;
  if(String(url)==='/api/mist/reviews')return response({reviews:bridge.session.user.id==='actor-a'?[row()]:[]});
  if(String(url).includes('/receipts/'))return response({receipt:{requestId:intent.requestId,revision:2,result:{reviewId:intent.reviewId}}});
  if(init.method==='POST'){postCount++;const body=JSON.parse(String(init.body));serverStatus=body.decision;return response({receipt:{requestId:body.requestId,revision:2,result:{reviewId:intent.reviewId}}});}
  throw new Error('Unexpected request: '+url);
 }));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

it('refreshes the current workspace after self-approval so the existing business page is no longer pending',async()=>{
 await render();await prepareDecision();await click('保存决定');
 expect(bridge.refresh).toHaveBeenCalledTimes(1);expect(host.querySelector('[data-testid="business-state"]')?.textContent).toBe('workspace-a:approved');
 expect(localStorage.getItem(key)).toBeNull();expect(postCount).toBe(1);
});
it('does not refresh or replace the current workspace when deciding a different workspace',async()=>{
 bridge.workspaceId='workspace-b';await render();await prepareDecision();await click('保存决定');
 expect(bridge.refresh).not.toHaveBeenCalled();expect(host.querySelector('[data-testid="business-state"]')?.textContent).toBe('workspace-b:pending');expect(postCount).toBe(1);
});
it('refreshes the current workspace when recovering a saved approval receipt without posting another decision',async()=>{
 localStorage.setItem(key,JSON.stringify(intent));serverStatus='approved';await render();await click('审批事项');await click('核对原请求');
 expect(bridge.refresh).toHaveBeenCalledTimes(1);expect(bridge.status).toBe('approved');expect(postCount).toBe(0);expect(localStorage.getItem(key)).toBeNull();
});
it('does not refresh the workspace selected after the decision started',async()=>{
 const gate=deferred();let requestId='';intercept=(url,init)=>{if(init.method==='POST'){postCount++;requestId=JSON.parse(String(init.body)).requestId;return gate.promise;}return undefined;};
 await render();await prepareDecision();await click('保存决定');
 bridge.workspaceId='workspace-b';await act(async()=>publish());
 await act(async()=>gate.resolve(response({receipt:{requestId,revision:2,result:{reviewId:intent.reviewId}}})));
 expect(bridge.refresh).not.toHaveBeenCalled();expect(bridge.workspaceId).toBe('workspace-b');
});
it('does not apply a former identity approval response to the new identity workspace',async()=>{
 const gate=deferred();let requestId='';intercept=(url,init)=>{if(init.method==='POST'){postCount++;requestId=JSON.parse(String(init.body)).requestId;return gate.promise;}return undefined;};
 await render();await prepareDecision();await click('保存决定');
 bridge.session={sessionKey:'session-b',status:'authenticated',user:{id:'actor-b'}};bridge.workspaceId='workspace-b';await render();
 await act(async()=>gate.resolve(response({receipt:{requestId,revision:2,result:{reviewId:intent.reviewId}}})));
 expect(bridge.refresh).not.toHaveBeenCalled();expect(bridge.workspaceId).toBe('workspace-b');expect(localStorage.getItem(key)).not.toBeNull();expect(localStorage.getItem('bambook.mist.review-pending:actor-b')).toBeNull();
});
it('retains request recovery protection when a response has a mismatched receipt',async()=>{
 intercept=(_url,init)=>init.method==='POST'?Promise.resolve(response({receipt:{requestId:'wrong-request'}})):undefined;
 await render();await prepareDecision();await click('保存决定');expect(bridge.refresh).not.toHaveBeenCalled();expect(localStorage.getItem(key)).not.toBeNull();
 expect(document.body.textContent).toContain('审批回执与原请求不符');
});
it('reports a workspace refresh failure without claiming the saved approval must be posted again',async()=>{
 bridge.refresh=vi.fn(async()=>{throw new Error('当前工作区读取暂不可用');});await render();await prepareDecision();await click('保存决定');
 expect(localStorage.getItem(key)).toBeNull();expect(document.body.textContent).toContain('审批已保存');expect(document.body.textContent).toContain('当前工作区读取暂不可用');expect(queryByText(document.body,'有审批结果待核对')).toBeNull();
});
