// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MARKET_PAGES} from './MarketPages';
import {Nav} from '../../nav';
import {createMistState,type MistContext} from '../../../../../server/src/shared/mistWorkspace';
import {createMarketState,applyMarketCommand,type MarketState} from '../../../../../server/src/shared/mistMarket';
const bridge=vi.hoisted(()=>({current:null as any}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>bridge.current}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:'sales'},hasPermission:()=>true,hasRole:()=>false,canAccessView:()=>true})}));
let host:HTMLDivElement,root:Root|undefined;const go=vi.fn();
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;go.mockReset();let next=0;const ctx:MistContext={id:()=>`market-test-${++next}`,actorName:'业务员',now:'2026-10-13T00:00:00.000Z'};const state=createMistState(ctx,'empty');state.market=createMarketState(ctx,state);state.customers=[{id:'c1',name:'现有客户',code:'C1',country:'',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''}];applyMarketCommand(state,{type:'market.product.save',payload:{input:{sku:'P-001',name:'真实羊毛面料',category:'fabric',season:'AW26',supplierId:'',supplierCode:'',composition:'羊毛',specification:'150cm',color:'米色',unit:'米',cost:'0.10',currency:'USD',sourceDevId:'',sourceVersionId:''}}},ctx);bridge.current={state,loading:false,saving:false,error:'',pending:null,pendingCreate:null,run:vi.fn(async()=>({requestId:'req-1',revision:1,result:{id:'saved-quote'}})),uploadFile:vi.fn(),downloadFile:vi.fn(),refresh:vi.fn()};});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;host?.remove();});
async function mount(view:string,id?:string,section?:string,detail?:'full'){host=document.createElement('div');document.body.append(host);root=createRoot(host);const Page=MARKET_PAGES[view];await act(async()=>root!.render(<Nav.Provider value={{route:{view,id,section,detail},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><Page/></Nav.Provider>));}
async function click(label:string){const button=[...document.body.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);expect(button,label).toBeTruthy();await act(async()=>button!.click());}
async function fill(label:string,value:string){const e=host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement;expect(e,label).toBeTruthy();await act(async()=>{const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value')!.set!.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});}
async function completeQuote(){await click('新建报价');await fill('有效期','2026-12-01');await fill('贸易术语','FOB 上海');await fill('付款条件','T/T');await click('下一步');await fill('条目1来源','p:'+bridge.current.state.market.products[0].id);await fill('条目1数量','3');await click('下一步');}
async function reroute(view:string,id?:string,section?:string,detail?:'full'){const Page=MARKET_PAGES[view];await act(async()=>root!.render(<Nav.Provider value={{route:{view,id,section,detail},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><Page/></Nav.Provider>));}
function routeQuote(id:string){const p=bridge.current.state.market.products[0];return {id,code:'QT-'+id,customerId:'c1',currency:'USD',season:'AW26',validUntil:'2026-12-01',deliveryTerms:'FOB',paymentTerms:'T/T',status:'Draft',lines:[{id:'line-'+id,productId:p.id,sourceDevId:'',sourceVersionId:'',name:p.name,style:p.sku,specification:'150cm',qty:'1',unit:'米',price:'1.00',cost:'0.10',amount:'1.00',costBasis:'product'}],total:'1.00',deliveryEvidence:'',responseEvidence:'',approval:null,convertedOrderId:null,fileIds:[],note:'原备注-'+id,createdAt:'',updatedAt:''};}
function sectionFixture(kind:string){
 const market=bridge.current.state.market;
 market.suppliers=[{id:'surface-supplier',code:'SUP-S',name:'分区供应商',type:'成衣',country:'中国',address:'实际地址',capabilities:'打样',capacity:12,capacityUnit:'件',leadDays:7,status:'active',blockReason:'',contacts:[],fileIds:[],note:'实际备注',createdAt:'',updatedAt:''}];
 market.relations=[{id:'surface-relation',name:'分区组织',category:'Partner',country:'中国',address:'实际地址',aliases:[],contacts:[],status:'active',customerId:'',supplierId:'',fileIds:[],note:'实际备注',createdAt:'',updatedAt:''}];
 market.seasons=[{id:'surface-season',code:'AW26',name:'分区季节',startDate:'2026-01-01',endDate:'2026-12-31',status:'Active',milestones:[],review:null,fileIds:[],note:'实际备注',createdAt:'',updatedAt:''}];
 market.trends=[{id:'surface-trend',name:'分区趋势',type:'fabric',seasonId:'surface-season',source:'实际展会',productIds:[],fileIds:[],note:'实际备注',createdAt:'',updatedAt:''}];
 market.shows=[{id:'surface-show',name:'分区展会',location:'上海',seasonId:'surface-season',startDate:'2026-10-01',endDate:'2026-10-02',booth:'A1',attendees:'业务员',cost:'0',currency:'USD',status:'Completed',fileIds:[],note:'实际备注',createdAt:'',updatedAt:''}];
 market.leads=[{id:'surface-lead',name:'分区联系人',company:'已知公司',source:'show',parentId:'surface-show',status:'New',customerId:'',email:'',phone:'',demand:'面料采购',followUpDate:'',estimatedValue:'0',actualValue:'0',currency:'USD',convertedAt:null,fileIds:[],note:'实际备注',createdAt:'',updatedAt:''}];
 market.lookbooks=[{id:'surface-lookbook',name:'分区画册',customerId:'c1',productIds:[],status:'Draft',preparedAt:null,snapshots:[],fileIds:[],note:'实际备注',createdAt:'',updatedAt:''}];
 const target:Record<string,{view:string;id:string;section?:string;cards:number}>={product:{view:'products',id:market.products[0].id,cards:3},supplier:{view:'suppliers',id:'surface-supplier',cards:3},relation:{view:'relations',id:'surface-relation',cards:3},trend:{view:'seasons',id:'surface-trend',section:'trends',cards:2},show:{view:'seasons',id:'surface-show',section:'shows',cards:2},season:{view:'seasons',id:'surface-season',cards:2},lead:{view:'seasons',id:'surface-lead',section:'show-leads:surface-show',cards:3},lookbook:{view:'marketing',id:'surface-lookbook',section:'lookbooks',cards:2}};
 return target[kind];
}
describe('Market explicit detail sections',()=>{
 it.each(['product','supplier','relation','trend','show','season','lead','lookbook'])('keeps %s facts, attachments and history in independent sibling cards',async kind=>{
  const target=sectionFixture(kind);await mount(target.view,target.id,target.section,'full');
  const region=host.querySelector('[data-detail-surface="sections"]')!;expect(region).not.toBeNull();
  expect(region.closest('.mist-card')).toBeNull();expect([...region.children].filter(element=>element.classList.contains('mist-card'))).toHaveLength(target.cards);
  const cards=[...region.querySelectorAll('.mist-card')];
  const attachments=cards.find(card=>card.querySelector('.mist-h2')?.textContent==='附件与凭据');expect(attachments?.parentElement).toBe(region);
  if(target.cards===3){const history=cards.find(card=>card.querySelector('.mist-h2')?.textContent==='操作记录');expect(history?.parentElement).toBe(region);}
  expect(bridge.current.run).not.toHaveBeenCalled();
 });
 it.each(['product','relation','lookbook'])('keeps the %s quick preview facts free of a second card/padding wrapper',async kind=>{
  const target=sectionFixture(kind);await mount(target.view,target.id,target.section);
  const preview=host.querySelector('[data-module-detail]')!;expect(host.querySelector('[data-detail-surface="sections"]')).toBeNull();
  expect([...preview.children].filter(element=>element.classList.contains('mist-card'))).toHaveLength(target.cards-1);
  await reroute(target.view,target.id,target.section,'full');const full=host.querySelector('[data-detail-surface="sections"]')!;
  expect([...full.children].filter(element=>element.classList.contains('mist-card'))).toHaveLength(target.cards);
 });
});
describe('Mist market screens',()=>{
 it('exports exactly the six market entry points',()=>expect(Object.keys(MARKET_PAGES).sort()).toEqual(['marketing','products','quotations','relations','seasons','suppliers']));
 it('builds a quotation from an actual product with exact decimal strings and navigates only using its receipt',async()=>{await mount('quotations');await completeQuote();expect(host.textContent).toContain('0.30');await click('保存报价草稿');expect(bridge.current.run).toHaveBeenCalledTimes(1);expect(bridge.current.run).toHaveBeenCalledWith({type:'market.quotation.save',payload:{id:undefined,input:expect.objectContaining({customerId:'c1',lines:[expect.objectContaining({productId:bridge.current.state.market.products[0].id,name:'真实羊毛面料',qty:'3',price:'0.10'})]})}});expect(go).toHaveBeenCalledWith('quotations','saved-quote');});
 it('preserves the complete quotation on save failure and does not navigate or create an order',async()=>{bridge.current.run.mockRejectedValueOnce(new Error('数据库保存失败'));await mount('quotations');await completeQuote();await click('保存报价草稿');expect(host.textContent).toContain('数据库保存失败');expect(host.textContent).toContain('0.30');expect(go).not.toHaveBeenCalled();await click('上一步');expect((host.querySelector('[aria-label="条目1数量"]') as HTMLInputElement).value).toBe('3');expect(bridge.current.run.mock.calls.every(([c]:any[])=>c.type==='market.quotation.save')).toBe(true);});
 it('opens an archived product exact source version instead of current development version',async()=>{const p=bridge.current.state.market.products[0];p.sourceDevId='dev-original';p.sourceVersionId='version-original';await mount('products',p.id);await click('打开准确开发版本');expect(go).toHaveBeenCalledWith('development/detail','dev-original',{versionId:'version-original'});});
 it('retains uploaded attachment identity after association failure and retries the same file',async()=>{const p=bridge.current.state.market.products[0];const stored={id:'f-upload',name:'规格.pdf',mimeType:'application/pdf',size:4,storageKey:'w/f-upload',createdAt:'2026-10-13'};bridge.current.uploadFile.mockImplementation(async()=>{bridge.current.state.files.push(stored);return stored;});bridge.current.run.mockRejectedValueOnce(new Error('关联保存失败'));await mount('products',p.id);const file=new File(['spec'],'规格.pdf',{type:'application/pdf'});await act(async()=>{const input=host.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new Event('change',{bubbles:true}));});expect(host.textContent).toContain('规格.pdf · 待关联');expect(host.textContent).toContain('关联保存失败');await click('重试关联已上传附件');expect(bridge.current.uploadFile).toHaveBeenCalledTimes(1);expect(bridge.current.run).toHaveBeenLastCalledWith({type:'market.attachment.set',payload:{kind:'product',id:p.id,fileIds:['f-upload']}});});
 it('renders truthful empty marketing state without manufactured leads or success',async()=>{await mount('marketing');expect(host.textContent).toContain('尚无营销活动');expect(bridge.current.run).not.toHaveBeenCalled();expect(bridge.current.state.market.leads).toEqual([]);});
 it('displays real quotation totals and keeps acceptance separate from conversion',async()=>{const s=bridge.current.state;s.market.quotations.push({id:'q1',createdAt:'2026-10-13',updatedAt:'2026-10-13',fileIds:[],note:'',code:'QT-REAL',customerId:'c1',currency:'USD',season:'AW26',validUntil:'2026-12-01',deliveryTerms:'FOB',paymentTerms:'T/T',status:'Accepted',lines:[],total:'0.30',deliveryEvidence:'线下发送',responseEvidence:'实际签回',approval:null,convertedOrderId:null});await mount('quotations','q1');expect(host.textContent).toContain('0.30');expect(host.textContent).toContain('核对并转订单');expect(bridge.current.run).not.toHaveBeenCalled();});
});

describe('market action audit component regressions',()=>{
 it('keeps a trend deep link on the trend tab and exposes its exact product source',async()=>{
  const s=bridge.current.state,p=s.market.products[0];s.market.seasons=[{id:'season',code:'AW26',name:'秋冬',startDate:'2026-01-01',endDate:'2026-12-31',status:'Active',milestones:[],fileIds:[],note:'',createdAt:'',updatedAt:''}];s.market.trends=[{id:'trend',name:'棉织趋势',type:'fabric',seasonId:'season',source:'展会观察',productIds:[p.id],fileIds:[],note:'实际记录',createdAt:'',updatedAt:''}];
  await mount('seasons','trend','trends');expect(host.textContent).toContain('棉织趋势');expect(host.textContent).toContain('展会观察');await click(p.name);expect(go).toHaveBeenCalledWith('products',p.id);
 });
 it('restores nested show leads and returns to the same show',async()=>{
  const s=bridge.current.state;s.market.shows=[{id:'show',name:'实际展会',location:'上海',seasonId:'',startDate:'2026-10-01',endDate:'2026-10-02',booth:'',attendees:'',cost:'0',currency:'USD',status:'Completed',fileIds:[],note:'',createdAt:'',updatedAt:''}];s.market.leads=[{id:'lead',name:'采购李',company:'已知公司',source:'show',parentId:'show',status:'New',customerId:'',email:'',phone:'',demand:'面料采购',followUpDate:'',estimatedValue:'0',actualValue:'0',currency:'USD',convertedAt:null,fileIds:[],note:'',createdAt:'',updatedAt:''}];
  await mount('seasons','lead','show-leads:show');expect(host.textContent).toContain('采购李');expect(host.textContent).toContain('面料采购');await click('返回展会');expect(go).toHaveBeenCalledWith('seasons','show',{section:'shows'});
 });
 it('keeps all lookbook products when only its name changes',async()=>{
  const s=bridge.current.state,p=s.market.products[0],p2={...p,id:'product-2',sku:'P-002',name:'第二款面料'};s.market.products.push(p2);s.market.lookbooks=[{id:'book',name:'原画册',customerId:'c1',productIds:[p.id,p2.id],status:'Draft',preparedAt:null,snapshots:[],fileIds:[],note:'',createdAt:'',updatedAt:''}];
  await mount('marketing','book','lookbooks');await click('编辑');await fill('画册名称','改名画册');await click('下一步');await click('确认保存');expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'market.lookbook.save',payload:expect.objectContaining({id:'book',input:expect.objectContaining({name:'改名画册',productIds:[p.id,p2.id]})})}));
 });
 it('renders rejected approval as a block on delivery until resubmission',async()=>{
  const s=bridge.current.state,p=s.market.products[0];s.market.quotations=[{id:'q',code:'Q-RETURNED',customerId:'c1',currency:'USD',season:'AW26',validUntil:'2026-12-01',deliveryTerms:'FOB',paymentTerms:'T/T',status:'Draft',requiresApproval:true,lines:[{id:'line',productId:p.id,sourceDevId:'',sourceVersionId:'',name:p.name,style:p.sku,specification:'',qty:'1',unit:'米',price:'1',cost:'0.10',amount:'1.00',costBasis:'product'}],total:'1.00',deliveryEvidence:'',responseEvidence:'',approval:{id:'review',requesterId:'sales',reviewerId:'lead',status:'rejected',submittedAt:'2026-10-13',details:[],fileIds:[],note:'请修改'},convertedOrderId:null,fileIds:[],note:'',createdAt:'',updatedAt:''}];
  await mount('quotations','q');const delivery=[...host.querySelectorAll('button')].find(b=>b.textContent==='登记已发送')!;expect(delivery.disabled).toBe(true);expect(host.textContent).toContain('请修改');expect(bridge.current.run).not.toHaveBeenCalled();
 });
});

describe('market filtered export',()=>{
 it('exports the displayed supplier subset rather than the complete collection',async()=>{
  const base={code:'SUP',type:'工厂',country:'CN',address:'',capabilities:'缝制',capacity:1,capacityUnit:'件',leadDays:1,status:'active',blockReason:'',contacts:[],fileIds:[],note:'',createdAt:'',updatedAt:''};bridge.current.state.market.suppliers=[{...base,id:'a',name:'Alpha supplier'},{...base,id:'b',name:'Beta supplier'}];let captured:Blob|undefined;const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=vi.fn(blob=>{captured=blob as Blob;return 'blob:export';});URL.revokeObjectURL=vi.fn();const anchor=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>undefined);
  try{await mount('suppliers');const search=host.querySelector<HTMLInputElement>('input[placeholder="搜索供应商管理"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'Alpha');search.dispatchEvent(new Event('input',{bubbles:true}));});await click('导出');const contents=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsText(captured!);});expect(contents).toContain('Alpha supplier');expect(contents).not.toContain('Beta supplier');}finally{anchor.mockRestore();URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;}
 });
});

describe('market route changes without remounting the module',()=>{
 it('discards the old quotation editor on a new target but preserves input through a workspace refresh',async()=>{
  bridge.current.state.market.quotations=[routeQuote('a'),routeQuote('b')];await mount('quotations','a');await click('编辑草稿');await fill('报价备注','A尚未保存');
  bridge.current.state=structuredClone(bridge.current.state);await reroute('quotations','a');expect((host.querySelector('[aria-label="报价备注"]') as HTMLTextAreaElement).value).toBe('A尚未保存');
  await reroute('quotations','b');expect(host.querySelector('[aria-label="报价备注"]')).toBeNull();expect(host.textContent).toContain('QT-b');expect(bridge.current.run).not.toHaveBeenCalled();
  await click('编辑草稿');expect((host.querySelector('[aria-label="报价备注"]') as HTMLTextAreaElement).value).toBe('原备注-b');await click('下一步');await click('下一步');await click('保存报价草稿');expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({type:'market.quotation.save',payload:expect.objectContaining({id:'b'})}));
 });
 it('does not navigate back to a previous quotation when its in-flight save finishes',async()=>{
  bridge.current.state.market.quotations=[routeQuote('a'),routeQuote('b')];let finish!:(value:unknown)=>void;bridge.current.run.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await mount('quotations','a');await click('编辑草稿');await click('下一步');await click('下一步');await click('保存报价草稿');expect(bridge.current.run).toHaveBeenCalledTimes(1);
  await reroute('quotations','b');await act(async()=>finish({requestId:'a-save',revision:1,result:{id:'a'}}));expect(go).not.toHaveBeenCalled();expect(host.textContent).toContain('QT-b');expect(host.querySelector('[aria-label="报价备注"]')).toBeNull();
 });
 it('updates the seasonal tab from the active route instead of stale component state',async()=>{
  const s=bridge.current.state;s.market.seasons=[{id:'season',code:'AW26',name:'秋冬季节',startDate:'2026-01-01',endDate:'2026-12-31',status:'Active',milestones:[],fileIds:[],note:'',createdAt:'',updatedAt:''}];s.market.trends=[{id:'trend',name:'更新后的趋势',type:'fabric',seasonId:'season',source:'现场依据',productIds:[],fileIds:[],note:'',createdAt:'',updatedAt:''}];
  await mount('seasons');expect(host.textContent).toContain('秋冬季节');const Page=MARKET_PAGES.seasons;await act(async()=>root!.render(<Nav.Provider value={{route:{view:'seasons',section:'trends'},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><Page/></Nav.Provider>));expect(host.textContent).toContain('更新后的趋势');expect(host.textContent).toContain('现场依据');
 });
});

describe('currency defaults respect entered and source values',()=>{
 it('uses the customer currency ahead of the workspace and leaves an edited currency intact',async()=>{
  bridge.current.state.settings.companyProfile={defaultCurrency:'CNY'};bridge.current.state.customers[0].currency='EUR';bridge.current.state.customers.push({...bridge.current.state.customers[0],id:'c2',name:'英国客户',currency:'GBP'});
  await mount('quotations');await click('新建报价');expect((host.querySelector('[aria-label="币种"]') as HTMLInputElement).value).toBe('EUR');await fill('客户','c2');expect((host.querySelector('[aria-label="币种"]') as HTMLInputElement).value).toBe('GBP');await fill('币种','JPY');await fill('客户','c1');expect((host.querySelector('[aria-label="币种"]') as HTMLInputElement).value).toBe('JPY');
 });
 it('does not overwrite an existing quote currency when a different workspace default is configured',async()=>{
  const s=bridge.current.state;s.settings.companyProfile={defaultCurrency:'CNY'};s.customers[0].currency='EUR';s.market.quotations=[{id:'q',code:'Q-USD',customerId:'c1',currency:'USD',season:'AW26',validUntil:'2026-12-01',deliveryTerms:'FOB',paymentTerms:'T/T',status:'Draft',lines:[],total:'0.00',deliveryEvidence:'',responseEvidence:'',approval:null,convertedOrderId:null,fileIds:[],note:'',createdAt:'',updatedAt:''}];await mount('quotations','q');await click('编辑草稿');expect((host.querySelector('[aria-label="币种"]') as HTMLInputElement).value).toBe('USD');
 });
 it('takes a new lead currency from its actual source campaign',async()=>{
  const s=bridge.current.state;s.settings.companyProfile={defaultCurrency:'CNY'};s.market.campaigns=[{id:'campaign',name:'美元活动',currency:'USD',status:'Draft',productIds:[]}];await mount('marketing',undefined,'campaign-leads:campaign');await click('新建');await fill('联系人','采购');await fill('公司','公司');await fill('采购需求','面料');await click('下一步');expect((host.querySelector('[aria-label="币种"]') as HTMLInputElement).value).toBe('USD');
 });
});
