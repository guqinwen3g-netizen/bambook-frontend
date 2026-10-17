// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getByRole,queryByRole,within} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {FulfillmentQcTask} from '../../../../../server/src/shared/mistFulfillment';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
const session=vi.hoisted(()=>({id:'qc-a',denied:new Set<string>()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth', () => { const useMistSession = ()=>({user:{id:session.id,displayName:'QC甲'},sessionKey:'s',hasPermission:(p:string)=>!session.denied.has(p),canAccessView:()=>true}); return { useMistSession, useOptionalMistSession: useMistSession }; });
import {QcWorkbenchPage} from './QcWorkbenchPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();
function render(id?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'qc-workbench',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><QcWorkbenchPage/></Nav.Provider></ToastProvider></MistRoot>));}
async function click(node:HTMLElement){await act(async()=>node.click());}
function choose(select:HTMLSelectElement,value:string){act(()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}
function typeInto(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
function task(id:string,patch:Partial<FulfillmentQcTask>={}):FulfillmentQcTask{return {id,code:id.toUpperCase(),source:{kind:'orderLine',orderId:'o',lineId:'l'},domain:'garment',kind:'sample',factory:'华美制衣',location:'一号车间',contact:'',due:'2026-10-20',requestedBy:'业务员',assignee:'',state:'pending',reportIds:[],createdAt:'2026-10-10T08:00:00Z',...patch};}
beforeEach(()=>{session.id='qc-a';session.denied=new Set();store.state=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T10:00:00Z',actorName:'QC甲'},'empty');store.run.mockReset();store.run.mockResolvedValue({result:{}});go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('shows separate fabric and garment entry cards with their own pending, open-branch and NOK numbers',async()=>{
  store.state!.fulfillment.qcTasks.push(
    task('g-s1'),task('g-s2',{state:'working',assignee:'QC甲',assigneeId:'qc-a'}),
    task('g-p1',{kind:'production',source:{kind:'orderLine',orderId:'o',lineId:'l',productionId:'p1'},state:'blocked'}),
    task('g-p2',{kind:'production',source:{kind:'orderLine',orderId:'o',lineId:'l',productionId:'p2'},state:'reported'}),
    task('f-s1',{domain:'fabric',state:'awaiting_business'}),
  );
  render();
  const garment=getByRole(host,'tab',{name:/成衣QC/}),fabric=getByRole(host,'tab',{name:/面料QC/});
  expect(garment.getAttribute('aria-selected')).toBe('true');
  expect(garment.textContent).toMatch(/待处理样品2/);expect(garment.textContent).toMatch(/未结生产检验1/);expect(garment.textContent).toMatch(/NOK 待恢复1/);
  expect(fabric.textContent).toMatch(/待处理样品0/);expect(fabric.textContent).toMatch(/NOK 待恢复1/);
  expect(host.textContent).toContain('G-S1');expect(host.textContent).not.toContain('F-S1');
  await click(fabric);
  expect(getByRole(host,'tab',{name:/面料QC/}).getAttribute('aria-selected')).toBe('true');
  expect(host.textContent).toContain('F-S1');expect(host.textContent).not.toContain('G-S1');
});

it('groups tasks by factory and inspection site with open count, earliest date and collapse',async()=>{
  store.state!.fulfillment.qcTasks.push(task('a1',{due:'2026-10-18',contact:'王主管'}),task('a2',{due:'2026-10-15'}),task('a3',{state:'reported'}),task('b1',{factory:'远东面料',location:'仓库'}));
  render();
  const groups=host.querySelectorAll('[data-qc-group]');
  expect(groups).toHaveLength(2);
  const first=groups[0] as HTMLElement;
  expect(first.textContent).toContain('华美制衣 · 一号车间');expect(first.textContent).toContain('2 条待办');expect(first.textContent).toContain('最早 10/15');expect(first.textContent).toContain('联系人 王主管');
  expect(within(first).getAllByRole('button',{name:/^\d{2}\/\d{2}|未排期/}).map(row=>row.textContent?.match(/A\d/)?.[0])).toEqual(['A2','A1','A3']);
  await click(within(first).getByRole('button',{name:/收起 华美制衣/}));
  expect(first.textContent).not.toContain('A1');
  expect(within(first).getByRole('button',{name:/展开 华美制衣/}).getAttribute('aria-expanded')).toBe('false');
});

it('keeps QC actions visible with concrete reasons when another QC owns the task',()=>{
  store.state!.fulfillment.qcTasks.push(task('owned',{state:'working',assignee:'QC乙',assigneeId:'qc-b'}));
  render('owned');
  const detail=host.querySelector('[data-qc-detail="owned"]') as HTMLElement;
  expect((getByRole(detail,'button',{name:'认领任务'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('认领任务：已由 QC乙 认领');
  expect((getByRole(detail,'button',{name:'提交 / 追加复验报告'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('仅当前QC（QC乙）可提交');
  expect((getByRole(detail,'button',{name:'转交'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('尚未接入服务端');
  expect(detail.textContent).toContain('QC乙 检查中');
});

it('validates garment size checks and confirms the consequence before appending a report',async()=>{
  store.state!.productions.push({id:'p1',code:'PB-1',orderId:'o',lineId:'l',order:'SO1',name:'衬衫',factory:'华美制衣',qty:20,due:'2026-11-01',pct:50,img:'coat',col:'qc'} as any);
  store.state!.fulfillment.productionFacts.push({productionId:'p1',sizes:[{size:'M',quantity:10},{size:'L',quantity:10}],revision:1} as any);
  store.state!.fulfillment.qcTasks.push(task('prod',{kind:'production',source:{kind:'orderLine',orderId:'o',lineId:'l',productionId:'p1'},state:'working',assignee:'QC甲',assigneeId:'qc-a'}));
  render('prod');
  await click(getByRole(host,'button',{name:'提交 / 追加复验报告'}));
  choose(getByRole(host,'combobox',{name:'本次结论'}) as HTMLSelectElement,'pass');
  typeInto(getByRole(host,'textbox',{name:'报告编号'}) as HTMLInputElement,'R-9');
  typeInto(getByRole(host,'textbox',{name:'专业意见与影响范围'}) as HTMLTextAreaElement,'M码袖长偏长');
  await click(getByRole(host,'button',{name:'提交报告'}));
  expect(host.textContent).toContain('请至少记录一个本次实际检查尺码');
  choose(getByRole(host,'combobox',{name:'尺码 M · 本次结论'}) as HTMLSelectElement,'reject');
  typeInto(getByRole(host,'spinbutton',{name:'尺码 M · 实际检查件数'}) as HTMLInputElement,'3');
  typeInto(getByRole(host,'textbox',{name:'尺码 M · 检查依据'}) as HTMLInputElement,'袖长实测');
  await click(getByRole(host,'button',{name:'提交报告'}));
  expect(host.textContent).toContain('存在尺码不通过时，总结论必须选择不通过');
  choose(getByRole(host,'combobox',{name:'本次结论'}) as HTMLSelectElement,'reject');
  await click(getByRole(host,'button',{name:'提交报告'}));
  const dialog=getByRole(document.body,'dialog');
  expect(dialog.textContent).toContain('生产分支将标记“QC 不通过”风险并阻断');
  expect(store.run).not.toHaveBeenCalled();
  await click(getByRole(dialog,'button',{name:'确认提交'}));
  expect(store.run).toHaveBeenCalledWith(expect.objectContaining({type:'fulfillment.qc.report',payload:expect.objectContaining({id:'prod',result:'reject',report:'R-9',sizeChecks:[{size:'M',inspected:3,result:'reject',evidence:'袖长实测'}]})}));
});

it('opens business resume over the workbench and explains it to QC-only accounts',async()=>{
  store.state!.fulfillment.qcTasks.push(task('resume',{kind:'production',source:{kind:'orderLine',orderId:'o',lineId:'l',productionId:'p1'},state:'awaiting_business',assignee:'QC甲',assigneeId:'qc-a'}));
  render('resume');
  await click(getByRole(host,'button',{name:'确认继续生产'}));
  const dialog=getByRole(document.body,'dialog');
  expect(host.querySelector('[data-qc-groups]')).not.toBeNull();
  typeInto(getByRole(dialog,'textbox',{name:'业务处理与恢复依据'}) as HTMLTextAreaElement,'整改已复核');
  await click(getByRole(dialog,'button',{name:'确认继续生产'}));
  expect(store.run).toHaveBeenCalledWith({type:'fulfillment.qc.continue',payload:{id:'resume',note:'整改已复核'}});
  session.denied=new Set(['orders:write','products:write']);
  render('resume');
  expect((getByRole(host,'button',{name:'确认继续生产'}) as HTMLButtonElement).disabled).toBe(true);
  expect(host.textContent).toContain('确认继续生产：由业务员确认恢复');
  expect((getByRole(host,'button',{name:'从来源发起QC'}) as HTMLButtonElement).disabled).toBe(true);
  expect(queryByRole(document.body,'dialog')).toBeNull();
});
