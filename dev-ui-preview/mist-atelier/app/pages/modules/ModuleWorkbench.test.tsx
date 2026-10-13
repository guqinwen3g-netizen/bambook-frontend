// @vitest-environment jsdom
import React,{act} from 'react';
import {readFileSync} from 'node:fs';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {getByRole,queryByRole,getByText,queryByText} from '@testing-library/dom';
import {Card,MistRoot,ToastProvider,type Column} from '../../../../../components/mist';
import {ModuleWorkbench,type ModuleEditorSpec} from './ModuleWorkbench';

const bridge=vi.hoisted(()=>({workspace:null as any,route:{view:'test-ledger'} as any,go:vi.fn()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>bridge.workspace}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({status:'authenticated',sessionKey:'test-session',user:{id:'test-user'},hasPermission:()=>true,canAccessView:()=>true})}));
vi.mock('../../nav',()=>({useNav:()=>({route:bridge.route,go:bridge.go})}));

type Row={id:string;name:string;detail:string};
const rows:Row[]=[{id:'row-a',name:'记录甲',detail:'仅属于甲的业务依据'},{id:'row-b',name:'记录乙',detail:'仅属于乙的业务依据'}];
const columns:Column<Row>[]=[{key:'name',header:'业务记录',render:row=>row.name}];
let host:HTMLDivElement,root:Root|undefined;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;bridge.route={view:'test-ledger'};bridge.go.mockReset();bridge.workspace={loading:false,saving:false,pending:null,pendingCreate:null,error:'',refresh:vi.fn(),run:vi.fn()};});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});

function editor(submit:ModuleEditorSpec['submit']=vi.fn(async(_values:any)=>({id:'saved'})),name='初始业务'):ModuleEditorSpec{return{
  title:'创建业务记录',submit,submitLabel:'确认创建',
  fields:[
    {key:'name',label:'业务名称',required:true},
    {key:'quantity',label:'业务数量',type:'number',required:true,min:0.1,step:0.1},
    {key:'category',label:'所属分组',type:'select',required:true,options:[{value:'blue',label:'蓝组'},{value:'green',label:'绿组'}]},
    {key:'due',label:'业务日期',type:'date',required:true},
    {key:'note',label:'补充说明',type:'textarea'},
    {key:'active',label:'当前有效',type:'checkbox'},
    {key:'source',label:'来源依据',required:true},
  ],initialValues:{name,quantity:'2.5',category:'blue',due:'2026-10-13',note:'原始说明',active:true,source:'原始凭据'},
};}
function tree(spec?:ModuleEditorSpec,edit?:(row:Row)=>ModuleEditorSpec|undefined,exportRows?:(filtered:Row[])=>void,preview=false){return <React.StrictMode><MistRoot theme="light"><ToastProvider><ModuleWorkbench title="业务台账" rows={rows} columns={columns} create={spec} edit={edit} exportRows={exportRows} preview={preview} detail={row=><p data-testid="exact-detail">{row.detail}</p>} rowActions={[{label:'执行当前记录',run:row=>bridge.workspace.run(row.id)}]}/></ToastProvider></MistRoot></React.StrictMode>; }
async function mount(spec?:ModuleEditorSpec,edit?:(row:Row)=>ModuleEditorSpec|undefined,exportRows?:(filtered:Row[])=>void,preview=false){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(tree(spec,edit,exportRows,preview)));}
function recordDetailPage(){return getByRole(document.body,'heading',{name:'业务台账详情'}).closest<HTMLElement>('.mist-page')!;}
async function click(name:string){await act(async()=>getByRole(document.body,'button',{name}).click());}
async function fill(name:string,value:string,role:'textbox'|'spinbutton'|'combobox'='textbox'){const input=getByRole(document.body,role,{name}) as HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;await act(async()=>{const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));});return input;}
async function confirmStep(){await click('新建');await click('下一步');await click('下一步');expect(getByRole(document.body,'button',{name:'确认创建'})).toBeTruthy();}

describe('ModuleWorkbench real Mist T9 workflow',()=>{
  it('closes a successfully saved long form under React StrictMode',async()=>{const submit=vi.fn(async(_values:any)=>({id:'saved'}));await mount(editor(submit));await confirmStep();await click('确认创建');expect(submit).toHaveBeenCalledTimes(1);expect(submit).toHaveBeenCalledWith({name:'初始业务',quantity:2.5,category:'blue',due:'2026-10-13',note:'原始说明',active:true,source:'原始凭据'});expect(queryByRole(document.body,'heading',{name:'创建业务记录'})).toBeNull();expect(getByRole(document.body,'heading',{name:'业务台账'})).toBeTruthy();expect(getByText(document.body,'已保存',{exact:true})).toBeTruthy();});
  it('retains all changed values after a rejected save and permits a corrected retry',async()=>{const submit=vi.fn().mockRejectedValueOnce(new Error('服务端拒绝：版本冲突')).mockResolvedValueOnce({id:'saved'});await mount(editor(submit));await click('新建');await fill('业务名称','待保存的实际业务');await fill('业务数量','3.7','spinbutton');await fill('所属分组','green','combobox');await fill('补充说明','保留这段输入');await click('下一步');await fill('来源依据','更新后的原始凭据');await click('下一步');await click('确认创建');expect(getByText(document.body,'服务端拒绝：版本冲突')).toBeTruthy();expect(queryByText(document.body,'已保存',{exact:true})).toBeNull();await click('上一步');expect((getByRole(document.body,'textbox',{name:'来源依据'}) as HTMLInputElement).value).toBe('更新后的原始凭据');await click('上一步');expect((getByRole(document.body,'textbox',{name:'业务名称'}) as HTMLInputElement).value).toBe('待保存的实际业务');expect((getByRole(document.body,'spinbutton',{name:'业务数量'}) as HTMLInputElement).value).toBe('3.7');expect((getByRole(document.body,'textbox',{name:'补充说明'}) as HTMLTextAreaElement).value).toBe('保留这段输入');await click('下一步');await click('下一步');await click('确认创建');expect(submit).toHaveBeenCalledTimes(2);expect(queryByRole(document.body,'heading',{name:'创建业务记录'})).toBeNull();});
  it('blocks Next on required fields in each section without calling submit',async()=>{const spec=editor(undefined,'');spec.initialValues.source='';await mount(spec);await click('新建');await click('下一步');expect(getByText(document.body,'请填写业务名称')).toBeTruthy();expect(queryByRole(document.body,'textbox',{name:'来源依据'})).toBeNull();expect(spec.submit).not.toHaveBeenCalled();await fill('业务名称','补全的名称');await click('下一步');await click('下一步');expect(getByText(document.body,'请填写来源依据')).toBeTruthy();expect(queryByRole(document.body,'button',{name:'确认创建'})).toBeNull();expect(spec.submit).not.toHaveBeenCalled();});
  it('shows a human-readable confirmation summary for text, number, select and checkbox',async()=>{await mount(editor());await confirmStep();const summary=document.body;for(const value of ['初始业务','2.5','蓝组','2026-10-13','原始说明','是','原始凭据'])expect(getByText(summary,value,{exact:true})).toBeTruthy();expect(queryByRole(summary,'textbox',{name:'业务名称'})).toBeNull();expect(queryByText(summary,'blue',{exact:true})).toBeNull();});
  it('sends one submission when the confirm button is clicked twice before React flushes',async()=>{let finish!:(value:any)=>void;const submit=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));await mount(editor(submit));await confirmStep();const button=getByRole(document.body,'button',{name:'确认创建'}) as HTMLButtonElement;await act(async()=>{button.click();button.click();});expect(submit).toHaveBeenCalledTimes(1);expect(button.disabled).toBe(true);await act(async()=>button.click());expect(submit).toHaveBeenCalledTimes(1);await act(async()=>finish({id:'saved'}));expect(queryByRole(document.body,'heading',{name:'创建业务记录'})).toBeNull();});
});

describe('ModuleWorkbench exact route identity',()=>{
  it('keeps the selected record name visible after its list is replaced by the full page',async()=>{bridge.route={view:'test-ledger',id:'row-b'};await mount();expect(getByText(recordDetailPage(),'记录乙',{exact:true})).toBeTruthy();});
  it('does not report a missing deep-linked record before workspace loading finishes',async()=>{
    bridge.route={view:'test-ledger',id:'not-loaded'};bridge.workspace.loading=true;await mount();
    expect(getByText(recordDetailPage(),'正在读取记录')).toBeTruthy();expect(queryByText(recordDetailPage(),'未找到这条记录')).toBeNull();
    bridge.workspace.loading=false;await act(async()=>root!.render(tree()));
    expect(getByText(recordDetailPage(),'未找到这条记录')).toBeTruthy();
  });
  it('resolves a changed route id in its first render without rendering the previous record',async()=>{
    const rendered:string[]=[];const render=()=> <React.StrictMode><MistRoot theme="light"><ToastProvider><ModuleWorkbench title="业务台账" rows={rows} columns={columns} detail={row=>{rendered.push(row.id);return <p>{row.detail}</p>;}}/></ToastProvider></MistRoot></React.StrictMode>;
    bridge.route={view:'test-ledger',id:'row-a'};host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(render()));
    rendered.length=0;bridge.route={view:'test-ledger',id:'row-b'};await act(async()=>root!.render(render()));
    expect(rendered.length).toBeGreaterThan(0);expect(rendered.every(id=>id==='row-b')).toBe(true);
  });
  it('does not show an Edit button when the selected row has no edit specification',async()=>{bridge.route={view:'test-ledger',id:'row-b'};const readonlyEdit=vi.fn((_row:Row)=>undefined);await mount(undefined,readonlyEdit);const page=recordDetailPage();expect(readonlyEdit).toHaveBeenCalledWith(rows[1]);expect(page.textContent).toContain('仅属于乙的业务依据');expect(queryByRole(page,'button',{name:'编辑'})).toBeNull();});
  it('opens the exact row on a full page, preserving its action identity without duplicate controls',async()=>{bridge.route={view:'test-ledger',id:'row-b',section:'source'};await mount();const page=recordDetailPage();expect(page.textContent).toContain('仅属于乙的业务依据');expect(page.textContent).not.toContain('仅属于甲的业务依据');expect(host.querySelector('[role="row"]')).toBeNull();expect(queryByRole(document.body,'dialog')).toBeNull();expect(document.body.querySelectorAll('[data-testid="exact-detail"]')).toHaveLength(1);await click('执行当前记录');expect(bridge.workspace.run).toHaveBeenCalledWith('row-b');});
  it('shows not-found for an invalid deep link rather than acting on the first row',async()=>{bridge.route={view:'test-ledger',id:'missing-record'};await mount();const page=recordDetailPage();expect(page.textContent).toContain('未找到这条记录');expect(page.textContent).not.toContain('仅属于甲的业务依据');expect(page.textContent).not.toContain('仅属于乙的业务依据');expect(queryByRole(page,'button',{name:'执行当前记录'})).toBeNull();expect(host.querySelector('[role="row"][aria-selected="true"]')).toBeNull();expect(bridge.workspace.run).not.toHaveBeenCalled();});
  it('selects a clicked row and carries existing route context to navigation',async()=>{bridge.route={view:'test-ledger',section:'source',orderLineId:'line-1'};await mount();const row=[...host.querySelectorAll<HTMLElement>('[role="row"][tabindex]')].find(element=>element.textContent?.includes('记录乙'))!;await act(async()=>row.click());expect(bridge.go).toHaveBeenCalledWith('test-ledger','row-b',{section:'source',orderLineId:'line-1'});bridge.route={...bridge.route,id:'row-b'};await act(async()=>root!.render(tree()));expect(recordDetailPage().textContent).toContain('仅属于乙的业务依据');});
});

describe('ModuleWorkbench Mist quick preview and full detail',()=>{
  it('keeps the exact selected quick preview and opens its full page with every source key',async()=>{
    bridge.route={view:'test-ledger',id:'row-b',section:'shipment-source',customerId:'customer-a',productionId:'production-b',orderLineId:'line-c'};
    await mount(undefined,undefined,undefined,true);
    expect(queryByRole(document.body,'heading',{name:'业务台账详情'})).toBeNull();
    expect(getByText(host,'仅属于乙的业务依据')).toBeTruthy();
    expect(host.querySelector('[role="row"][aria-selected="true"]')?.textContent).toContain('记录乙');
    await click('打开完整详情');
    const target={section:'shipment-source',customerId:'customer-a',productionId:'production-b',orderLineId:'line-c',detail:'full'};
    expect(bridge.go).toHaveBeenLastCalledWith('test-ledger','row-b',target);
    bridge.route={view:'test-ledger',id:'row-b',...target};await act(async()=>root!.render(tree(undefined,undefined,undefined,true)));
    expect(recordDetailPage().textContent).toContain('仅属于乙的业务依据');
    expect(queryByRole(document.body,'button',{name:'打开完整详情'})).toBeNull();
    expect(document.body.querySelectorAll('[data-testid="exact-detail"]')).toHaveLength(1);
    await click('执行当前记录');expect(bridge.workspace.run).toHaveBeenCalledWith('row-b');
    await click('返回业务台账');
    const {detail,...source}=target;expect(bridge.go).toHaveBeenLastCalledWith('test-ledger',undefined,source);
  });
  it('preserves the list query through quick preview, full detail and the return path',async()=>{
    await mount(undefined,undefined,undefined,true);await fill('搜索业务台账','乙');
    bridge.route={view:'test-ledger',id:'row-b'};await act(async()=>root!.render(tree(undefined,undefined,undefined,true)));
    await click('打开完整详情');bridge.route={view:'test-ledger',id:'row-b',detail:'full'};await act(async()=>root!.render(tree(undefined,undefined,undefined,true)));
    await click('返回业务台账');bridge.route={view:'test-ledger'};await act(async()=>root!.render(tree(undefined,undefined,undefined,true)));
    expect((getByRole(host,'textbox',{name:'搜索业务台账'}) as HTMLInputElement).value).toBe('乙');
    expect(queryByRole(document.body,'button',{name:'打开完整详情'})).toBeNull();
  });
  it('renders a long editor exclusively and returns to the same full record after cancel',async()=>{
    bridge.route={view:'test-ledger',id:'row-b',detail:'full'};const edit=()=>editor();await mount(undefined,edit,undefined,true);
    await click('编辑');expect(queryByRole(document.body,'heading',{name:'业务台账详情'})).toBeNull();
    expect(getByRole(document.body,'heading',{name:'创建业务记录'})).toBeTruthy();expect(queryByRole(document.body,'button',{name:'执行当前记录'})).toBeNull();
    await click('返回列表');expect(recordDetailPage().textContent).toContain('仅属于乙的业务依据');
  });
});

describe('ModuleWorkbench detail section spacing',()=>{
  it('uses the parent stack gap once while preserving nested section margins and padding',()=>{
    const stylesheet=document.createElement('style');
    stylesheet.textContent=readFileSync('styles/mist/patterns.css','utf8')+'\n.mist-section { margin-bottom: 18px; }';
    document.head.append(stylesheet);
    host=document.createElement('div');
    host.innerHTML='<section class="mist-section" data-outside></section><div data-module-detail><section class="mist-section" data-direct style="padding:12px"><section class="mist-section" data-nested></section></section></div>';
    document.body.append(host);
    try{
      expect(getComputedStyle(host.querySelector('[data-direct]')!).marginBottom).toBe('0px');
      expect(getComputedStyle(host.querySelector('[data-direct]')!).padding).toBe('12px');
      expect(getComputedStyle(host.querySelector('[data-nested]')!).marginBottom).toBe('18px');
      expect(getComputedStyle(host.querySelector('[data-outside]')!).marginBottom).toBe('18px');
    }finally{stylesheet.remove();}
  });
});

describe('ModuleWorkbench explicit detail surfaces',()=>{
  async function mountSurface(detailSurface?:'card'|'sections'){
    bridge.route={view:'test-ledger',id:'row-a'};host=document.createElement('div');document.body.append(host);root=createRoot(host);
    await act(async()=>root!.render(<MistRoot theme="light"><ToastProvider><ModuleWorkbench title="业务台账" rows={rows} columns={columns} detailSurface={detailSurface} detail={()=><><Card data-testid="facts-card">业务事实</Card><Card data-testid="history-card">历史记录</Card></>}/></ToastProvider></MistRoot>));
  }
  it('keeps the default single card surface for existing plain details',async()=>{
    await mountSurface();const facts=host.querySelector('[data-testid="facts-card"]')!;
    expect(host.querySelector('[data-detail-surface="sections"]')).toBeNull();expect(facts.parentElement!.closest('.mist-card')).not.toBeNull();
  });
  it('lays out caller-declared cards as siblings on the canvas without an enclosing card',async()=>{
    await mountSurface('sections');const section=host.querySelector('[data-detail-surface="sections"]')!;
    expect(section.classList.contains('mist-col')).toBe(true);expect(section.parentElement!.closest('.mist-card')).toBeNull();
    expect([...section.children].map(element=>element.getAttribute('data-testid'))).toEqual(['facts-card','history-card']);
  });
});


describe('ModuleWorkbench route continuation and filtered actions',()=>{
 it('preserves the query while navigating to a different record and closes back to the list URL',async()=>{
  bridge.route={view:'test-ledger',section:'source'};await mount();
  await fill('搜索业务台账','乙');
  bridge.route={view:'test-ledger',id:'row-b',section:'source'};await act(async()=>root!.render(tree()));
  expect(recordDetailPage().textContent).toContain('仅属于乙的业务依据');
  await click('返回业务台账');expect(bridge.go).toHaveBeenLastCalledWith('test-ledger',undefined,{section:'source'});
  bridge.route={view:'test-ledger',section:'source'};await act(async()=>root!.render(tree()));
  expect((getByRole(host,'textbox',{name:'搜索业务台账'}) as HTMLInputElement).value).toBe('乙');
 });
 it('exports only records matching the current query',async()=>{
  const exportRows=vi.fn();await mount(undefined,undefined,exportRows);await fill('搜索业务台账','乙');await click('导出');
  expect(exportRows).toHaveBeenCalledWith([rows[1]]);
 });
 it('executes a record action only once across synchronous repeated clicks',async()=>{
  let finish!:(value:any)=>void;bridge.workspace.run=vi.fn(()=>new Promise(resolve=>finish=resolve));bridge.route={view:'test-ledger',id:'row-a'};await mount();
  const button=getByRole(document.body,'button',{name:'执行当前记录'});await act(async()=>{button.click();button.click();});expect(bridge.workspace.run).toHaveBeenCalledTimes(1);await act(async()=>finish({}));
 });
});


describe('ModuleWorkbench in-flight source isolation',()=>{
 it.each(['id','section'] as const)('closes an old editor when route %s changes',async field=>{
  bridge.route={view:'test-ledger',id:'row-a',section:'shipment-a'};const edit=()=>editor();await mount(undefined,edit);await click('编辑');
  expect(getByRole(document.body,'heading',{name:'创建业务记录'})).toBeTruthy();
  bridge.route={...bridge.route,[field]:field==='id'?'row-b':'shipment-b'};await act(async()=>root!.render(tree(undefined,edit)));
  expect(queryByRole(document.body,'heading',{name:'创建业务记录'})).toBeNull();
 });
 it('does not attach an old record action failure to a newly selected record',async()=>{
  let reject!:(error:Error)=>void;bridge.workspace.run=vi.fn(()=>new Promise((_resolve,no)=>reject=no));bridge.route={view:'test-ledger',id:'row-a'};await mount();await click('执行当前记录');
  bridge.route={view:'test-ledger',id:'row-b'};await act(async()=>root!.render(tree()));await act(async()=>reject(new Error('甲记录操作失败')));
  expect(queryByText(document.body,'甲记录操作失败')).toBeNull();expect(recordDetailPage().textContent).toContain('仅属于乙的业务依据');
 });
});

describe.each(['dialog','page'] as const)('ModuleWorkbench %s select decisions',mode=>{
 function decisionSpec(initial:string|undefined,required=true){
  const submit=vi.fn(async(_values:any)=>({id:'confirmed'}));
  const spec:ModuleEditorSpec={title:'记录需求方样品确认',submitLabel:'保存决定',submit,
   fields:[{key:'result',label:'需求方决定',type:'select',required,options:[{value:'approved',label:'确认采用'},{value:'rejected',label:'退回修改'}]},{key:'note',label:'业务依据'}],
   initialValues:{note:'保留的客户确认依据',...(initial===undefined?{}:{result:initial})}};
  if(mode==='page')spec.fields.push({key:'contact',label:'确认联系人'},{key:'reference',label:'书面依据编号'});
  return spec;
 }
 it.each([undefined,'','removed-option'])('shows a placeholder and requires an explicit valid choice for initial %s',async initial=>{
  const spec=decisionSpec(initial);await mount(spec);await click('新建');
  const select=getByRole(document.body,'combobox',{name:'需求方决定'}) as HTMLSelectElement;
  expect(select.value).toBe('');expect(select.selectedOptions[0].textContent).toBe('请选择');
  await click(mode==='page'?'下一步':'保存决定');
  expect(getByText(document.body,initial==='removed-option'?'请重新选择需求方决定':'请填写需求方决定')).toBeTruthy();
  expect(spec.submit).not.toHaveBeenCalled();
  expect((getByRole(document.body,'textbox',{name:'业务依据'}) as HTMLInputElement).value).toBe('保留的客户确认依据');
  await fill('需求方决定','approved','combobox');if(mode==='page')await click('下一步');await click('保存决定');
  expect(spec.submit).toHaveBeenCalledWith(expect.objectContaining({result:'approved',note:'保留的客户确认依据'}));
 });
 it('preserves an existing valid decision and does not require selecting it again',async()=>{
  const spec=decisionSpec('rejected');await mount(spec);await click('新建');
  const select=getByRole(document.body,'combobox',{name:'需求方决定'}) as HTMLSelectElement;
  expect(select.value).toBe('rejected');expect(select.selectedOptions[0].textContent).toBe('退回修改');
  if(mode==='page')await click('下一步');await click('保存决定');
  expect(spec.submit).toHaveBeenCalledWith(expect.objectContaining({result:'rejected'}));
 });
 it('rejects an unmatched optional value instead of forwarding a stale decision',async()=>{
  const spec=decisionSpec('removed-option',false);await mount(spec);await click('新建');
  await click(mode==='page'?'下一步':'保存决定');expect(getByText(document.body,'请重新选择需求方决定')).toBeTruthy();
  expect(spec.submit).not.toHaveBeenCalled();await fill('需求方决定','', 'combobox');
  if(mode==='page')await click('下一步');await click('保存决定');
  expect(spec.submit).toHaveBeenCalledWith(expect.objectContaining({result:''}));
 });
 it('preserves a labelled optional empty choice and permits clearing a previous selection',async()=>{
  const spec=decisionSpec('approved',false);spec.fields[0].options!.unshift({value:'',label:'暂不关联订单'});
  await mount(spec);await click('新建');
  const select=getByRole(document.body,'combobox',{name:'需求方决定'}) as HTMLSelectElement;
  expect(select.value).toBe('approved');expect([...select.options].filter(option=>option.value==='')).toHaveLength(1);
  expect(queryByRole(select,'option',{name:'请选择'})).toBeNull();
  await fill('需求方决定','','combobox');expect(select.selectedOptions[0].textContent).toBe('暂不关联订单');
  if(mode==='page')await click('下一步');await click('保存决定');
  expect(spec.submit).toHaveBeenCalledWith(expect.objectContaining({result:'',note:'保留的客户确认依据'}));
 });
 it('retains a provided empty label while refusing it for a required field',async()=>{
  const spec=decisionSpec('');spec.fields[0].options!.unshift({value:'',label:'请明确需求方决定'});
  await mount(spec);await click('新建');
  const select=getByRole(document.body,'combobox',{name:'需求方决定'}) as HTMLSelectElement;
  expect(select.selectedOptions[0].textContent).toBe('请明确需求方决定');expect([...select.options].filter(option=>option.value==='')).toHaveLength(1);
  expect(queryByRole(select,'option',{name:'请选择'})).toBeNull();
  await click(mode==='page'?'下一步':'保存决定');expect(getByText(document.body,'请填写需求方决定')).toBeTruthy();
  expect(spec.submit).not.toHaveBeenCalled();
 });
});
