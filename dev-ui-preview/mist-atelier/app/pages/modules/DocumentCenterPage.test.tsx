// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getByRole,queryByRole} from '@testing-library/dom';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import type {FulfillmentShipment,FulfillmentDocument} from '../../../../../server/src/shared/mistFulfillment';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
const session=vi.hoisted(()=>({denied:new Set<string>()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth', () => { const useMistSession = ()=>({user:{id:'ops',displayName:'后勤'},sessionKey:'s',hasPermission:(p:string)=>!session.denied.has(p),canAccessView:()=>true}); return { useMistSession, useOptionalMistSession: useMistSession }; });
import {DocumentCenterPage,issueBlocker} from './DocumentCenterPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();
function render(id?:string,section?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'document-center',id,section},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><DocumentCenterPage/></Nav.Provider></ToastProvider></MistRoot>));}
async function click(node:HTMLElement){await act(async()=>node.click());}
function typeInto(input:HTMLInputElement|HTMLTextAreaElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
const shipment=(id:string,patch:Partial<FulfillmentShipment>={}):FulfillmentShipment=>({id,code:id.toUpperCase(),customerId:'c',customer:'Cedar',domain:'garment',consignee:'Cedar DC',mode:'sea',portOfLoading:'上海',portOfDischarge:'Felixstowe',incoterm:'FOB',plannedDate:'2099-01-01',booking:'',lines:[{orderId:'o',lineId:'l',productionId:'p',quantity:10,factoryConfirmedAt:'2026-10-09'}],note:'',fileIds:[],state:'preparing',requestedBy:'业务',requesterId:'biz',createdAt:'2026-10-08T08:00:00Z',...patch});
const doc=(id:string,type:FulfillmentDocument['type'],patch:Partial<FulfillmentDocument>={}):FulfillmentDocument=>({id,shipmentId:'s',orderId:type==='CI'?'o':'',type,number:type+'-'+id,version:1,title:type+' 标题',dueDate:type==='CI'?'2026-11-01':'',content:'正文',fileIds:['file'],status:'draft',createdAt:'2026-10-10T08:00:00Z',actor:'后勤',...patch});
const pack=(quantity:number)=>({id:'pk'+quantity,shipmentId:'s',lineId:'l',productionId:'p',carton:'1',quantity,netWeight:9,grossWeight:10,volume:0.1,note:''});
beforeEach(()=>{session.denied=new Set();const s=createMistState({id:()=>crypto.randomUUID(),now:'2026-10-13T10:00:00Z',actorName:'后勤'},'empty');
  s.orders.push({id:'o',code:'SO-1',type:'garment',customerId:'c',customer:'Cedar',currency:'USD'} as any);s.orderLines.push({id:'l',orderId:'o',name:'大衣',style:'COAT-1',img:'coat',qty:10,unit:'件',price:10,made:10,qc:10} as any);
  s.fulfillment.shipments.push(shipment('s'));
  store.state=s;store.run.mockReset();store.run.mockResolvedValue({result:{}});go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('explains every issue precondition the backend enforces before a draft can be issued',()=>{
  const st=store.state!,f=st.fulfillment;
  const pl=doc('pl','PL',{fileIds:[]});
  expect(issueBlocker(st,pl)).toBe('请先上传核对后的正式单据文件');
  pl.fileIds=['file'];expect(issueBlocker(st,pl)).toBe('装箱分配与计划数量不一致');
  f.packing.push(pack(10));expect(issueBlocker(st,pl)).toBe('');
  f.documents.push(doc('pl0','PL',{status:'issued'}));expect(issueBlocker(st,pl)).toBe('相同来源已有有效版本，请先作废');
  f.shipments[0].state='departed';expect(issueBlocker(st,doc('ci','CI'))).toBe('出运已离港或已取消');
  expect(issueBlocker(st,doc('bl','BL'))).toBe('');
  expect(issueBlocker(st,doc('bl2','BL',{fileIds:[]}))).toBe('请先上传外部机构签发的原件');
});

it('keeps voided versions out of the current list and lets the user walk the version history',async()=>{
  const f=store.state!.fulfillment;f.documents.push(doc('v1','PL',{status:'void',number:'PL-OLD'}),doc('v2','PL',{version:2,status:'issued',number:'PL-NEW',issuedAt:'2026-10-12T08:00:00Z'}));
  render();
  const table=getByRole(host,'table',{name:'单据列表'});
  expect(table.textContent).toContain('PL-NEW');expect(table.textContent).not.toContain('PL-OLD');expect(table.textContent).toContain('共 2 版');
  await click(getByRole(host,'button',{name:/已作废/}));
  expect(getByRole(host,'table',{name:'单据列表'}).textContent).toContain('PL-OLD');
  render('v2');
  const detail=host.querySelector('[data-document-detail="v2"]') as HTMLElement;
  const versions=getByRole(detail,'table',{name:'PL-NEW 版本'});
  expect(versions.textContent).toContain('V1');expect(versions.textContent).toContain('已作废');
  expect(getByRole(detail,'button',{name:'作废当前版本'})).toBeTruthy();
  expect(getByRole(detail,'button',{name:'建立新版本'})).toBeTruthy();
});

it('issues a CI after confirmation and offers a new version only from the latest one',async()=>{
  const f=store.state!.fulfillment;f.documents.push(doc('ci','CI'));
  render('ci');
  let detail=host.querySelector('[data-document-detail="ci"]') as HTMLElement;
  expect(detail.textContent).toContain('签发后按本票该订单条目数量 × 合同单价生成应收');
  await click(getByRole(detail,'button',{name:'签发'}));
  const dialog=getByRole(document.body,'dialog');expect(getByRole(host,'table',{name:'单据列表'})).toBeTruthy();
  await click(getByRole(dialog,'button',{name:'确认签发'}));
  expect(store.run).toHaveBeenCalledWith({type:'fulfillment.documents.issue',payload:{id:'ci'}});
  Object.assign(f.documents[0],{status:'issued',issuedAt:'2026-10-13T08:00:00Z',invoiceId:'inv'});store.state!.invoices.push({id:'inv',code:'CI-ci',orderId:'o',order:'SO-1',customer:'Cedar',due:'2026-11-01',amount:100,open:60,currency:'USD'});
  store.state={...store.state!};render('ci');
  detail=host.querySelector('[data-document-detail="ci"]') as HTMLElement;
  expect(detail.textContent).toContain('USD 100.00');
  expect((getByRole(detail,'button',{name:'作废当前版本'}) as HTMLButtonElement).disabled).toBe(true);
  expect(detail.textContent).toContain('CI 已有收款，请先走财务更正');
  await click(getByRole(detail,'button',{name:'建立新版本'}));
  const versionDialog=getByRole(document.body,'dialog');
  typeInto(getByRole(versionDialog,'textbox',{name:'实际单据编号'}) as HTMLInputElement,'CI-ci-2');
  await click(getByRole(versionDialog,'button',{name:'保存为草稿'}));
  expect(store.run).toHaveBeenLastCalledWith({type:'fulfillment.documents.save',payload:expect.objectContaining({shipmentId:'s',orderId:'o',type:'CI',number:'CI-ci-2',fileIds:[]})});
  expect(store.run.mock.calls.at(-1)![0].payload.id).toBeUndefined();
});

it('archives an external BL original instead of offering company issue',async()=>{
  store.state!.fulfillment.documents.push(doc('bl','BL',{number:'EXT-BL'}));
  render('bl');
  const detail=host.querySelector('[data-document-detail="bl"]') as HTMLElement;
  expect(queryByRole(detail,'button',{name:'签发'})).toBeNull();
  await click(getByRole(detail,'button',{name:'归档外部签发原件'}));
  const dialog=getByRole(document.body,'dialog',{name:'归档外部机构原件'});
  typeInto(getByRole(dialog,'textbox',{name:'外部签发机构'}) as HTMLInputElement,'COSCO');
  typeInto(getByRole(dialog,'textbox',{name:'原件来源依据'}) as HTMLTextAreaElement,'船公司电放');
  await click(getByRole(dialog,'button',{name:'归档原件'}));
  expect(store.run).toHaveBeenCalledWith({type:'fulfillment.documents.archiveExternal',payload:expect.objectContaining({id:'bl',issuer:'COSCO',evidence:'船公司电放'})});
});

it('keeps users without document permission read-only and shows the letterhead source',async()=>{
  session.denied.add('customs:write');store.state!.fulfillment.documents.push(doc('pl','PL'));
  store.state!.settings.companyProfile={legalName:'竹衍服饰',englishName:'Bambook Apparel',address:'上海',englishAddress:'',phone:'',email:'',taxId:'TAX1',customsCode:'',bankName:'',bankAccount:'',swift:'',defaultCurrency:'USD'};
  render('pl');
  expect(host.textContent).toContain('只读查看');
  expect(queryByRole(host,'button',{name:'新建单据'})).toBeNull();
  expect(queryByRole(host.querySelector('[data-document-detail="pl"]') as HTMLElement,'button',{name:'签发'})).toBeNull();
  await click(getByRole(host,'tab',{name:/抬头与模板/}));
  expect(host.textContent).toContain('竹衍服饰');expect(host.textContent).toContain('印章图样、编号规则预览与打印打包尚未接入');
});
