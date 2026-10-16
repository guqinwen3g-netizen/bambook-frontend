import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {createMistState,type MistContext,type MistState} from '../shared/mistWorkspace';
import {createMarketState,applyMarketCommand,type MarketState,type MarketCommand} from '../shared/mistMarket';
import {quotationDocuments,quotationFormalDocumentBlocker} from '../shared/mistQuotationDocument';
import {quotationNeedsApproval} from '../shared/mistMarket';
import {bindQuotationDocument,buildQuotationDocument,nextQuotationDocumentSeq,prepareQuotationDocumentSnapshot} from './quotationPrint';
import {renderQuotationDocumentHtml} from '../templates/quotationDocument';

const company={legalName:'杭州竹语纺织有限公司',englishName:'Hangzhou Bamboo Textile Co., Ltd.',address:'杭州市西湖区 1 号',englishAddress:'No.1 Xihu, Hangzhou',phone:'0571-1',email:'sales@example.com',taxId:'T1',customsCode:'C1',bankName:'B',bankAccount:'A',swift:'S',defaultCurrency:'USD'};
const setup=(profile=true)=>{let n=0;const ctx:MistContext={id:()=>`q6-${++n}`,now:'2026-10-13T08:00:00.000Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},businessReviewerId:'leader'}};const s=createMistState(ctx) as MistState&{market:MarketState};s.market=createMarketState(ctx,s);if(profile)s.settings.companyProfile={...company};return {ctx,s};};
const run=(s:MistState,c:MarketCommand,ctx:MistContext)=>applyMarketCommand(s,c,ctx);
let sku=0;const product=(s:MistState,ctx:MistContext,cost='1.00')=>run(s,{type:'market.product.save',payload:{input:{sku:'P-Q6-'+(++sku),name:'竹纤维平纹布',category:'fabric',season:'AW26',supplierId:'',supplierCode:'',composition:'竹纤维 70% 棉 30%',specification:'150cm',color:'蓝',unit:'米',cost,currency:'USD',sourceDevId:'',sourceVersionId:''}}},ctx).id!;
const line=(productId:string,price:string,cost='1.00')=>({productId,sourceDevId:'',sourceVersionId:'',name:'竹纤维平纹布 Bamboo plain',style:'P-Q6',specification:'150cm',qty:'800',unit:'米',price,cost,specs:{composition:'竹纤维 70% 棉 30%',weight:'120',width:'150',moqQty:'1000',moqUnit:'米'}});
const saveQuote=(s:MistState&{market:MarketState},ctx:MistContext,price:string,extra:Record<string,unknown>={})=>run(s,{type:'market.quotation.save',payload:{input:{customerId:s.customers[0].id,currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB Ningbo',paymentTerms:'30% T/T 预付，70% 见提单副本',note:'颜色以确认色卡为准 / Color per approved lab dip',lines:[line(product(s,ctx),price)],...extra} as never}},ctx).id!;
/** 伪 PDF 渲染器：记录 HTML，返回带哈希的最小 PDF。 */
const renderer=()=>{const html:string[]=[];return {html,renderPdf:async(h:string)=>{html.push(h);const pdf=Buffer.from('%PDF-1.4\n'+createHash('sha256').update(h).digest('hex')+'\n%%EOF');return {pdf,sha:createHash('sha256').update(pdf).digest('hex'),bytes:pdf.length} as never;}};};
/** 模拟仓储层：服务端冻结快照 → 渲染 → 写私有存储 → 绑定到上下文 → 执行命令。 */
const generate=async(s:MistState,ctx:MistContext,id:string,draft:boolean,r=renderer())=>{
  const snapshot=prepareQuotationDocumentSnapshot(s,{id,draft},ctx),prepared=await buildQuotationDocument(snapshot,nextQuotationDocumentSeq(s,id),{renderPdf:r.renderPdf});
  const fileId='file-'+ctx.id(),stored={id:fileId,name:prepared.file.name,mimeType:'application/pdf',size:prepared.bytes,storageKey:'ws/'+fileId,createdAt:ctx.now};
  const artifact=bindQuotationDocument(prepared,stored,{id:ctx.id,workspaceId:'ws',requestId:'req-'+fileId});
  return {result:run(s,{type:'market.quotation.document',payload:{id,draft}},{...ctx,quotationDocument:artifact} as MistContext),html:r.html[0],artifact};
};

describe('BB-QUO-6 正式报价单',()=>{
 it('generates a formal V2 quotation whose content matches V2, and archives every generation as a new record',async()=>{
  const {ctx,s}=setup(),v1=saveQuote(s,ctx,'2.50');
  run(s,{type:'market.quotation.status',payload:{id:v1,status:'Sent',evidence:'邮件'}},ctx);run(s,{type:'market.quotation.status',payload:{id:v1,status:'Rejected',evidence:'嫌贵'}},ctx);
  const v2=saveQuote(s,ctx,'2.30',{previousId:v1}),q=()=>s.market.quotations.find(x=>x.id===v2)!;
  expect(q().revision).toBe(2);expect(quotationFormalDocumentBlocker(q(),quotationNeedsApproval(q()))).toBeNull();
  const first=await generate(s,ctx,v2,false);
  const doc=q().documents![0];
  expect(doc).toMatchObject({quotationId:v2,revision:2,draft:false,generatedBy:'业务员',generatedById:'sales',generatedAt:ctx.now,fileName:q().code.replace(/-V\d+$/,'')+'-V2-01.pdf'});
  expect(doc.snapshot.lines).toEqual([expect.objectContaining({name:'竹纤维平纹布 Bamboo plain',style:'P-Q6',qty:'800',unit:'米',price:'2.30',amount:q().lines[0].amount,moq:'1000 米'})]);
  expect(doc.snapshot).toMatchObject({code:q().code,currency:'USD',deliveryTerms:'FOB Ningbo',paymentTerms:'30% T/T 预付，70% 见提单副本',validUntil:'2026-11-01',total:q().total,note:'颜色以确认色卡为准 / Color per approved lab dip'});
  expect(first.html).toContain(q().code);expect(first.html).toContain('V2');expect(first.html).toContain('2.30');expect(first.html).not.toContain('>2.50<');
  for(const text of ['报价单','QUOTATION','杭州竹语纺织有限公司','FOB Ningbo','30% T/T 预付，70% 见提单副本','颜色以确认色卡为准 / Color per approved lab dip','800 米','1000 米','竹纤维 70% 棉 30%','贸易术语','Trade terms','付款条件','Payment terms','有效期至','Valid until','授权签字及公司盖章'])expect(first.html).toContain(text);
  expect(first.html).not.toContain('class="watermark"');
  expect(doc.snapshot.lines[0].moqBelow).toBe(true);expect(first.html).toContain('class="moq-below"');expect(first.html).toContain('低于 MOQ');
  expect(s.files.find(f=>f.id===doc.fileId)).toMatchObject({name:doc.fileName,mimeType:'application/pdf'});
  expect(s.events[0].text).toMatch(/生成正式报价单 .*V2/);
  await generate(s,ctx,v2,false);
  expect(quotationDocuments(q()).length).toBe(2);expect(q().documents![0]).toEqual(doc);expect(q().documents![1].fileName).toMatch(/-V2-02\.pdf$/);expect(q().documents![1].fileId).not.toBe(doc.fileId);
 });
 it('only allows the draft-watermark version while approval is required but not granted',async()=>{
  const {ctx,s}=setup(),id=saveQuote(s,ctx,'0.80'),q=()=>s.market.quotations.find(x=>x.id===id)!;
  expect(quotationNeedsApproval(q())).toBe(true);
  expect(()=>prepareQuotationDocumentSnapshot(s,{id,draft:false},ctx)).toThrow(/未批准只能生成草稿水印版/);
  const draft=await generate(s,ctx,id,true);
  expect(draft.html).toContain('class="watermark"');expect(draft.html).toContain('草稿 DRAFT');expect(q().documents![0]).toMatchObject({draft:true,fileName:expect.stringMatching(/-V1-01-DRAFT\.pdf$/)});
  run(s,{type:'market.quotation.submit',payload:{id}},ctx);
  expect(()=>prepareQuotationDocumentSnapshot(s,{id,draft:false},ctx)).toThrow(/审批中/);
  run(s,{type:'market.quotation.decide',payload:{id,decision:'approved',note:'同意'}},{...ctx,actorId:'leader'});
  const formal=await generate(s,ctx,id,false);
  expect(formal.html).not.toContain('class="watermark"');expect(q().documents!.map(d=>d.draft)).toEqual([true,false]);
 });
 it('rejects documents not produced by the server for the current version, and save cannot inject or drop records',async()=>{
  const {ctx,s}=setup(),id=saveQuote(s,ctx,'2.50'),q=()=>s.market.quotations.find(x=>x.id===id)!;
  expect(()=>run(s,{type:'market.quotation.document',payload:{id,draft:false}},ctx)).toThrow(/须由服务端/);
  const r=renderer(),snapshot=prepareQuotationDocumentSnapshot(s,{id,draft:false},ctx),prepared=await buildQuotationDocument({...snapshot,lines:snapshot.lines.map(l=>({...l,price:'9.99'}))},1,{renderPdf:r.renderPdf});
  const artifact=bindQuotationDocument(prepared,{id:'f-x',name:prepared.file.name,mimeType:'application/pdf',size:prepared.bytes,storageKey:'ws/f-x',createdAt:ctx.now},{id:ctx.id,workspaceId:'ws',requestId:'r'});
  expect(()=>run(s,{type:'market.quotation.document',payload:{id,draft:false}},{...ctx,quotationDocument:artifact} as MistContext)).toThrow(/须由服务端/);
  expect(q().documents).toBeUndefined();
  await generate(s,ctx,id,true);
  const kept=q().documents!;
  run(s,{type:'market.quotation.save',payload:{id,input:{customerId:s.customers[0].id,currency:'USD',season:'AW26',validUntil:'2026-11-01',deliveryTerms:'FOB',paymentTerms:'T/T',lines:[line(q().lines[0].productId,'2.60')],documents:[]} as never}},ctx);
  expect(q().documents).toEqual(kept);
 });
 it('blocks generation until the company profile header is filled; legacy quotations without records stay readable',()=>{
  const {ctx,s}=setup(false),id=saveQuote(s,ctx,'2.50');
  expect(()=>prepareQuotationDocumentSnapshot(s,{id,draft:true},ctx)).toThrow(/公司资料/);
  expect(quotationDocuments(s.market.quotations[0])).toEqual([]);
  const html=renderQuotationDocumentHtml({...prepareQuotationDocumentSnapshot({...s,settings:{...s.settings,companyProfile:company}} as MistState,{id,draft:true},ctx),note:'<script>x</script>'});
  expect(html).not.toContain('<script>x');
 });
});
