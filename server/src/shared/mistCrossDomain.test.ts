import {describe,expect,it} from 'vitest';
import {applyMistCommand,createMistState,type MistCommand,type MistContext} from './mistWorkspace';
import { isPendingFinanceMistInvoice, isRecognizedMistInvoice, mistCommandPermission } from './mistWorkspace';
import { FULFILLMENT_CUSTOMS_CLEAR_SCOPE } from './mistFulfillment';
import { DEFAULT_ROLE_PERMISSION_MATRIX, SYSTEM_ROLE_IDS, hasPermission } from '../_shared/rolePermissionMatrix';
import { DEFAULT_ROLE_PERMISSION_MATRIX as FRONTEND_MATRIX } from '../../../lib/rolePermissionMatrix';
import { departmentAuthorization } from '../auth/departmentAuthorization';

/** Exercise the root dispatcher, including shared recalculation and transaction-clone semantics. */
function fixture() {
 let next=0;const businessNumbers:Record<string,number>={};
 const context:MistContext={id:()=>`cross-${++next}`,now:'2026-10-13T08:00:00Z',actorName:'业务员',actorId:'sales',consumeBusinessNumber:prefix=>prefix+'-2026-'+String(businessNumbers[prefix]=(businessNumbers[prefix]||0)+1).padStart(5,'0'),authority:{supplier:{'supplierCommitment.approvers.processing.garment':{version:1,userIds:['leader']}},orderReviewerIds:{garment:['leader'],fabric:['leader']},claimReviewerId:'leader',businessReviewerId:'leader'}};
 let state=createMistState(context,'empty');
 state.customers.push({id:'customer',name:'现有客户',code:'C1',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
 state.market.suppliers.push({id:'supplier',code:'S1',name:'实际工厂',type:'工厂',country:'CN',address:'现场',capabilities:'加工',capacity:10,capacityUnit:'件',leadDays:5,status:'active',blockReason:'',contacts:[],fileIds:[],note:'',createdAt:context.now,updatedAt:context.now});
 // Uploaded metadata fixture only; it represents the written contract without external I/O.
 state.files.push({id:'uploaded',name:'signed.pdf',mimeType:'application/pdf',size:4,storageKey:'workspace/uploaded',createdAt:context.now});
 const run=(command:MistCommand,actor=context)=>{const next=applyMistCommand(state,command,actor);state=next.state;return next.result;};
 const orderId=run({type:'order.create',payload:{type:'garment',customerId:'customer',season:'AW26',currency:'USD',due:'2026-12-01',owner:'业务员',governance:{kind:'external',poNumber:'CROSS-PO',confirmationFileIds:['uploaded'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'30%定金，余款按合同',incoterm:'FOB',deliveryPlace:'上海'},lines:[{name:'衬衫',style:'S1',img:'coat',qty:10,unit:'件',price:10}]}}).orderId!;
 const lineId=state.orderLines[0].id;
 run({type:'order.governance.submit',payload:{orderId}});run({type:'order.governance.decide',payload:{id:orderId,decision:'approved',note:'已核对客户书面合同'}},{...context,actorId:'leader'});
 run({type:'finance.importReceipts',payload:{receipts:[{date:'2026-10-13',payer:'现有客户',amount:30,currency:'USD',ref:'CROSS-DEPOSIT'}]}});run({type:'funding.assign',payload:{receiptId:state.receipts[0].id,customerId:'customer',orderId,amount:30,note:'本订单合同定金'}});
 const purchaseId=run({type:'fulfillment.procurement.save',payload:{orderId,lineId,kind:'processing',supplierId:'supplier',supplier:'实际工厂',description:'衬衫加工',quantity:10,unit:'件',price:2,currency:'USD',due:'2026-11-30',terms:'加工合同付款条件',destination:'实际工厂',note:'',fileIds:['uploaded']}}).id!;
 run({type:'fulfillment.procurement.submit',payload:{id:purchaseId}});run({type:'fulfillment.procurement.decide',payload:{id:purchaseId,decision:'approved',note:'核对采购承诺'}},{...context,actorId:'leader'});
 run({type:'fulfillment.procurement.send',payload:{id:purchaseId,at:context.now,evidence:'实际线下合同发出记录',fileIds:['uploaded']}});run({type:'fulfillment.procurement.confirm',payload:{id:purchaseId,at:context.now,confirmedDue:'2026-11-30',evidence:'工厂确认原合同',fileIds:['uploaded']}});
 const productionId=state.productions[0].id,source={kind:'orderLine' as const,orderId,lineId,productionId};
 run({type:'fulfillment.production.plan',payload:{productionId,sizes:[{size:'M',quantity:10}]}});
 const pp=run({type:'fulfillment.samples.create',payload:{name:'实际产前样',category:'成衣',form:'实物',quantity:1,unit:'件',size:'M',color:'蓝',location:'现场',source,role:'pp',fileIds:[],note:'产前工艺核对'}}).id!;
 const ppTask=run({type:'fulfillment.qc.request',payload:{source,sampleId:pp,domain:'garment',kind:'sample',factory:'实际工厂',location:'现场',contact:'',due:'2026-10-13'}}).id!;
 const inspector={...context,actorId:'qc-user',actorName:'质检员'};run({type:'fulfillment.qc.claim',payload:{id:ppTask,domain:'garment'}},inspector);run({type:'fulfillment.qc.report',payload:{id:ppTask,domain:'garment',result:'pass',report:'PP-QC',opinion:'产前样工艺通过',measurements:[],fileIds:[],reviewedAt:context.now}},inspector);run({type:'fulfillment.qc.confirm',payload:{id:ppTask,result:'approved',note:'客户认可实际产前样'}});run({type:'fulfillment.qc.continue',payload:{id:ppTask,note:'业务核对后明确继续'}});
 run({type:'fulfillment.production.release',payload:{productionId,note:'合同定金与产前样门禁齐备'}});run({type:'fulfillment.procurement.receive',payload:{id:purchaseId,quantity:10,rejected:0,destination:'supplier',location:'现场',date:'2026-10-13',evidence:'实际回交十件',fileIds:[]}});run({type:'fulfillment.production.complete',payload:{productionId,quantity:10,sizeQuantities:[{size:'M',quantity:10}],date:'2026-10-13',evidence:'最终独立点数十件',fileIds:[]}});
 for(const item of state.orders[0].checklist.filter(c=>['拟发范围确认','收货与贸易条款确认','收款条件核对'].includes(c.label)))run({type:'order.checklist',payload:{orderId,itemId:item.id,done:true}});
 run({type:'order.handoff',payload:{orderId}});run({type:'fulfillment.shipments.sourceTerms',payload:{orderId,consignee:'合同收货方',partialAllowed:false,mode:'sea',confirmedAt:'2026-10-13',evidence:'已签合同'}});
 const shipmentId=run({type:'fulfillment.shipments.save',payload:{consignee:'合同收货方',mode:'sea',portOfLoading:'上海',portOfDischarge:'伦敦',incoterm:'FOB',plannedDate:'2026-10-20',booking:'',lines:[{orderId,lineId,productionId,quantity:10,factoryConfirmedAt:'2026-10-13'}],note:'',fileIds:[]}}).id!;
 const document=(type:'CI'|'PL')=>run({type:'fulfillment.documents.save',payload:{shipmentId,orderId:type==='CI'?orderId:'',type,number:`${type}-${next}`,title:type,dueDate:type==='CI'?'2026-12-01':'',content:'已核对的单据',fileIds:['uploaded']}}).id!;
 const pack=()=>run({type:'fulfillment.shipments.pack',payload:{id:shipmentId,lines:[{lineId,productionId,carton:'1',quantity:10,netWeight:10,grossWeight:11,volume:1,note:''}]}});
 return {context,run,document,pack,orderId,lineId,shipmentId,productionId,ppTask,get state(){return state;}};
}

describe('Mist cross-domain financial and shipment invariants',()=>{
 it('counts platform invoices before a shipment CI and rejects duplicate financial exposure atomically',()=>{
  const f=fixture();
  const draft=f.run({type:'platform.invoice.save',payload:{orderId:f.orderId,due:'2026-12-01',amount:100,note:'独立发票入口'}}).id!;
  f.run({type:'platform.invoice.issue',payload:{id:draft}});
  const ci=f.document('CI');
  expect(()=>f.run({type:'fulfillment.documents.issue',payload:{id:ci}})).toThrow(/尚未开票额度/);
  expect(f.state.orders[0].amount).toBe(100);
  expect(f.state.invoices.map(i=>i.amount)).toEqual([100]);
  expect(f.state.platform.invoiceDrafts[0].state).toBe('Issued');
  expect(f.state.fulfillment.documents.find(d=>d.id===ci)).toMatchObject({status:'draft'});
  expect(f.state.fulfillment.documents.find(d=>d.id===ci)?.invoiceId).toBeUndefined();
 });

 it('rejects ready and actual departure when only an adopted order sample QC exists',()=>{
  const f=fixture();
  // This fixture has an adopted and continued physical PP sample, but deliberately no production QC.
  expect(f.state.fulfillment.qcTasks.find(t=>t.id===f.ppTask)?.businessConfirmation?.result).toBe('approved');
  f.pack();
  for(const type of ['CI','PL'] as const)f.run({type:'fulfillment.documents.issue',payload:{id:f.document(type)}});
  expect(f.state.productions).toHaveLength(1);
  // Legacy shipments could omit their branch even while a production existed.
  delete f.state.fulfillment.shipments[0].lines[0].productionId;
  expect(f.state.fulfillment.qcTasks.map(t=>t.kind)).toEqual(['sample']);
  expect(()=>f.run({type:'fulfillment.shipments.ready',payload:{id:f.shipmentId}})).toThrow(/准确生产分支/);
  f.state.fulfillment.shipments[0].lines[0].productionId=f.productionId;
  expect(()=>f.run({type:'fulfillment.shipments.ready',payload:{id:f.shipmentId}})).toThrow(/生产QC/);
  expect(f.state.fulfillment.shipments[0].state).toBe('preparing');
  // A pre-fix stored snapshot might already be ready. Departure must independently recheck QC.
  f.state.fulfillment.shipments[0].state='ready';
  f.run({type:'fulfillment.shipments.sent',payload:{id:f.shipmentId,at:f.context.now}});
  f.run({type:'fulfillment.customs.save',payload:{shipmentId:f.shipmentId,status:'cleared',declarationNo:'DECL1',broker:'报关行',hsCode:'6201',origin:'CN',tradeMode:'FOB',declaredAt:'2026-10-13',clearedAt:'2026-10-13',evidence:'放行回执',fileIds:['uploaded'],note:''}},{...f.context,can:scope=>scope==='customs:clear'});
  expect(()=>f.run({type:'fulfillment.shipments.depart',payload:{id:f.shipmentId,at:f.context.now,evidence:'离港回执',fileIds:['uploaded']}})).toThrow(/实际生产分支|生产QC/);
  expect(f.state.fulfillment.shipments[0].state).toBe('ready');
  expect(f.state.fulfillment.shipments[0].departedAt).toBeUndefined();
 });

 it('preserves a CI backing an approved credit, including later refund and duplicate-refund guards',()=>{
  const f=fixture(),ci=f.document('CI');
  f.run({type:'fulfillment.documents.issue',payload:{id:ci}});
  const invoiceId=f.state.fulfillment.documents.find(d=>d.id===ci)!.invoiceId!;
  f.run({type:'finance.receivable.confirm',payload:{invoiceId}});
  const claim=f.run({type:'platform.claim.create',payload:{orderId:f.orderId,invoiceId,problem:'客户确认的瑕疵',fileIds:['uploaded']}}).id!;
  const disposition=f.run({type:'platform.claim.disposition',payload:{claimId:claim,kind:'Allowance',amount:20,quantity:0,unit:'',returnDisposition:'',basis:'双方确认折让',fileIds:['uploaded']}}).id!;
  f.run({type:'platform.claim.submit',payload:{id:disposition}});
  f.run({type:'platform.claim.decide',payload:{id:disposition,decision:'approved',note:'总领导核对通过'}},{...f.context,actorId:'leader',actorName:'总领导'});
  f.run({type:'platform.claim.execute',payload:{id:disposition}});
  expect(f.state.invoices.find(i=>i.id===invoiceId)).toMatchObject({amount:100,open:100});
  expect(()=>f.run({type:'fulfillment.documents.void',payload:{id:ci,reason:'重新制作'}})).toThrow(/索赔或贷项/);
  expect(f.state.fulfillment.documents.find(d=>d.id===ci)?.status).toBe('issued');
  expect(f.state.invoices.find(i=>i.id===invoiceId)).toMatchObject({amount:100,open:100});
  const creditId=f.state.platform.credits[0].id;
  f.run({type:'platform.credit.refund',payload:{creditId,amount:20,date:'2026-10-13',reference:'银行付款回单'}});
  expect(f.state.payments[0].amount).toBe(20);
  expect(f.state.platform.creditApplications).toHaveLength(1);
  expect(f.state.invoices.find(i=>i.id===invoiceId)?.amount).toBe(100);
  expect(()=>f.run({type:'platform.credit.refund',payload:{creditId,amount:0.01,date:'2026-10-13',reference:'重复付款'}})).toThrow(/超过/);
  expect(f.state.payments).toHaveLength(1);
 });
});


// ── 工单「跨岗位闭环权限修复」：清关完成门禁与 CI 应收财务确认 ──
// 用真实角色矩阵模拟服务端 hasScope：业务员只拿到 SALES 的授权，后勤拿到 LOGISTICS 的授权。
const roleCan = (roleId: string) => (scope: string) => hasPermission(roleId, scope as any);
function gate() {
  const f = fixture();
  const sales: MistContext = { ...f.context, can: roleCan(SYSTEM_ROLE_IDS.SALES) };
  const logistics: MistContext = { ...f.context, actorName: '单证', actorId: 'logistics', can: roleCan(SYSTEM_ROLE_IDS.LOGISTICS) };
  const finance: MistContext = { ...f.context, actorName: '财务', actorId: 'finance', can: roleCan(SYSTEM_ROLE_IDS.FINANCE) };
  const run = (command: MistCommand, actor = sales) => f.run(command, actor);
  return { get state() { return f.state; }, run, sales, logistics, finance, shipmentId: f.shipmentId, document: f.document };
}
const customs = (shipmentId: string, status: 'draft' | 'submitted' | 'cleared', id?: string) => ({ type: 'fulfillment.customs.save', payload: { ...(id ? { id } : {}), shipmentId, status, declarationNo: 'DECL-1', broker: '报关行', hsCode: '6205', origin: 'CN', tradeMode: 'FOB', declaredAt: status === 'draft' ? '' : '2026-10-13', clearedAt: status === 'cleared' ? '2026-10-13' : '', evidence: status === 'cleared' ? '海关放行回执' : '', fileIds: [], note: '' } } as MistCommand);

describe('A · 清关完成只能由后勤/单证登记', () => {
  it('新权限 customs:clear 只授予后勤与管理，业务员/业务主管没有；前后端矩阵一致', () => {
    for (const matrix of [DEFAULT_ROLE_PERMISSION_MATRIX, FRONTEND_MATRIX as any]) {
      expect(matrix[SYSTEM_ROLE_IDS.LOGISTICS]['customs:clear']).toBe(true);
      expect(matrix[SYSTEM_ROLE_IDS.ADMIN]['customs:clear']).toBe(true);
      expect(matrix[SYSTEM_ROLE_IDS.SALES]['customs:clear']).not.toBe(true);
      expect(matrix[SYSTEM_ROLE_IDS.SALES_MANAGER]['customs:clear']).not.toBe(true);
    }
    expect(hasPermission(SYSTEM_ROLE_IDS.SUPER_ADMIN, 'customs:clear')).toBe(true);
  });
  it('部门门禁：customs:clear 必须是后勤部门，业务部门即使被授权也被过滤', () => {
    const user = (businessAttributes: string[]) => ({ primaryDepartment: { name: '部门', parentId: 'company', status: 'active', metadata: { businessAttributes } } });
    expect(departmentAuthorization(user(['garment_business']), ['role-sales'], ['customs:clear']).permissions).toEqual([]);
    expect(departmentAuthorization(user(['logistics']), ['role-logistics'], ['customs:clear']).permissions).toEqual(['customs:clear']);
    expect(departmentAuthorization({}, ['role-super-admin'], ['customs:clear']).permissions).toEqual(['customs:clear']);
  });
  it('命令权限映射：草稿/已申报仍是 customs:write，已清关要求 customs:clear', () => {
    expect(mistCommandPermission(customs('s', 'draft'))).toBe('customs:write');
    expect(mistCommandPermission(customs('s', 'submitted'))).toBe('customs:write');
    expect(mistCommandPermission(customs('s', 'cleared'))).toBe(FULFILLMENT_CUSTOMS_CLEAR_SCOPE);
  });
  it('业务员可保存草稿和已申报；直接或从已申报改为已清关都被服务端拒绝且不改状态', () => {
    const f = gate();
    const id = String(f.run(customs(f.shipmentId, 'draft')).id);
    expect(f.state.fulfillment.customs[0].status).toBe('draft');
    f.run(customs(f.shipmentId, 'submitted', id));
    expect(f.state.fulfillment.customs[0].status).toBe('submitted');
    const before = structuredClone(f.state);
    expect(() => f.run(customs(f.shipmentId, 'cleared', id))).toThrow('清关完成须由后勤/单证登记');
    expect(f.state).toEqual(before);
    // 缺少权限判定上下文时按拒绝处理（fail closed）。
    expect(() => f.run(customs(f.shipmentId, 'cleared', id), { ...f.sales, can: undefined })).toThrow('清关完成须由后勤/单证登记');
    expect(f.state.fulfillment.customs[0].status).toBe('submitted');
    const fresh = gate();
    expect(() => fresh.run(customs(fresh.shipmentId, 'cleared'))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(fresh.state.fulfillment.customs).toHaveLength(0);
  });
  it('后勤可把已申报登记为已清关，已清关记录不可再被覆盖', () => {
    const f = gate();
    const id = String(f.run(customs(f.shipmentId, 'submitted')).id);
    f.run(customs(f.shipmentId, 'cleared', id), f.logistics);
    expect(f.state.fulfillment.customs[0]).toMatchObject({ status: 'cleared', clearedAt: '2026-10-13', evidence: '海关放行回执' });
    expect(() => f.run(customs(f.shipmentId, 'submitted', id))).toThrow('已清关记录不可覆盖');
  });
});

describe('B · CI 生成的应收须财务确认后才入账', () => {
  const issue = (f: ReturnType<typeof gate>) => {
    const documentId = f.document('CI');
    const invoiceId = String(f.run({ type: 'fulfillment.documents.issue', payload: { id: documentId } } as MistCommand).invoiceId);
    return { documentId, invoiceId };
  };
  const receipt = (f: ReturnType<typeof gate>, ref: string) => { f.run({ type: 'finance.importReceipts', payload: { receipts: [{ date: '2026-10-13', payer: '现有客户', amount: 10, currency: 'USD', ref }] } }, f.finance); return f.state.receipts.find(r => r.ref === ref)!.id; };

  it('命令权限：确认/驳回需要财务应收写权限，业务员与后勤没有', () => {
    expect(mistCommandPermission({ type: 'finance.receivable.confirm', payload: { invoiceId: 'x' } })).toBe('invoices:write');
    expect(mistCommandPermission({ type: 'finance.receivable.reject', payload: { invoiceId: 'x', reason: 'r' } })).toBe('invoices:write');
    expect(hasPermission(SYSTEM_ROLE_IDS.FINANCE, 'invoices:write')).toBe(true);
    expect(hasPermission(SYSTEM_ROLE_IDS.SALES, 'invoices:write')).toBe(false);
    expect(hasPermission(SYSTEM_ROLE_IDS.LOGISTICS, 'invoices:write')).toBe(false);
  });
  it('CI 签发后应收为待财务确认：不计余额、不计报表口径、不能核销', () => {
    const f = gate(); const { invoiceId } = issue(f);
    const invoice = f.state.invoices.find(i => i.id === invoiceId)!;
    expect(invoice).toMatchObject({ financeStatus: 'pending', amount: 100, open: 0 });
    expect(isPendingFinanceMistInvoice(invoice)).toBe(true);
    expect(isRecognizedMistInvoice(invoice)).toBe(false);
    expect(f.state.invoices.filter(isRecognizedMistInvoice).reduce((total, i) => total + i.amount, 0)).toBe(0);
    const receiptId = receipt(f, 'PENDING-RECEIPT');
    const before = structuredClone(f.state);
    expect(() => f.run({ type: 'finance.reconcile', payload: { receiptId, invoiceId, amount: 10 } }, f.finance)).toThrow('应收待财务确认');
    expect(f.state).toEqual(before);
  });
  it('财务确认后记录确认人/时间并计入应收，之后可以核销', () => {
    const f = gate(); const { invoiceId } = issue(f);
    f.run({ type: 'finance.receivable.confirm', payload: { invoiceId } }, f.finance);
    const invoice = f.state.invoices.find(i => i.id === invoiceId)!;
    expect(invoice).toMatchObject({ financeStatus: 'confirmed', financeConfirmedBy: '财务', financeConfirmedById: 'finance', financeConfirmedAt: f.sales.now, open: 100 });
    expect(isRecognizedMistInvoice(invoice)).toBe(true);
    expect(() => f.run({ type: 'finance.receivable.confirm', payload: { invoiceId } }, f.finance)).toThrow();
    const receiptId = receipt(f, 'CONFIRMED-RECEIPT');
    f.run({ type: 'finance.reconcile', payload: { receiptId, invoiceId, amount: 10 } }, f.finance);
    expect(f.state.invoices.find(i => i.id === invoiceId)!.open).toBe(90);
  });
  it('财务驳回须填原因：应收不计入、CI 退回草稿可更正后重新签发', () => {
    const f = gate(); const { documentId, invoiceId } = issue(f);
    expect(() => f.run({ type: 'finance.receivable.reject', payload: { invoiceId, reason: '  ' } }, f.finance)).toThrow();
    expect(f.state.invoices.find(i => i.id === invoiceId)!.financeStatus).toBe('pending');
    f.run({ type: 'finance.receivable.reject', payload: { invoiceId, reason: '金额与合同不符' } }, f.finance);
    const rejected = f.state.invoices.find(i => i.id === invoiceId)!;
    expect(rejected).toMatchObject({ financeStatus: 'rejected', financeRejectReason: '金额与合同不符', financeRejectedById: 'finance', open: 0 });
    expect(isRecognizedMistInvoice(rejected)).toBe(false);
    const document = f.state.fulfillment.documents.find(d => d.id === documentId)!;
    expect(document.status).toBe('draft');
    expect(document.invoiceId).toBeUndefined();
    expect(document.financeRejection).toMatchObject({ reason: '金额与合同不符', invoiceId });
    expect(() => f.run({ type: 'finance.receivable.confirm', payload: { invoiceId } }, f.finance)).toThrow();
    const reissued = String(f.run({ type: 'fulfillment.documents.issue', payload: { id: documentId } } as MistCommand).invoiceId);
    expect(reissued).not.toBe(invoiceId);
    expect(f.state.invoices.find(i => i.id === reissued)).toMatchObject({ financeStatus: 'pending', open: 0 });
  });
});
