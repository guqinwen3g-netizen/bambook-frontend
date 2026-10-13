import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
const grants = vi.hoisted(() => ({ active: true, kind: 'all', scopes: ['invoices:read', 'invoices:write', 'invoices:reconcile', 'vouchers:read', 'vouchers:write', 'vat:read', 'vat:write'] }));
vi.mock('../../auth/tokenHelpers', () => ({ loadUserWithRoles: async (_db: any, id: string) => grants.active ? { id, deletedAt: null, status: 'active' } : null,
  buildLoadedAuthTokenPayload: async (_db: any, user: any) => ({ userId: user.id, roles: [], roleIds: [], permissions: [...grants.scopes], authorizationLoaded: true }) }));
vi.mock('../../auth/permissionService', () => ({ createPermissionService: () => ({ getDataScopeResolver: async () => ({ rule: { kind: grants.kind }, allowedUserIds: ['actor'] }) }),
  hasScope: (actor: any, scope: string) => actor.permissions.includes(scope) && (!actor.permissionCeiling || actor.permissionCeiling.includes(scope)) }));
vi.mock('../../teams/teamShareService', () => ({ createTeamShareService: () => ({ getActiveGrantedRelationIds: async () => [] }) }));
vi.mock('../../orders/orderService', () => ({ buildOrderListScopeWhere: async () => ({}) }));
vi.mock('../../entities/sync', () => ({ syncPaymentVoucherReferences: vi.fn(), syncVatInvoiceReferences: vi.fn(), deactivateEntityLinks: vi.fn() }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => 'business-audit') }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: vi.fn(async () => undefined) }));
vi.mock('../../shared/businessNumberService', () => ({ nextBusinessNumber: vi.fn(async () => 'RV-0001') }));
vi.mock('../../credit/creditService', () => ({ notifyCustomerCreditRecalc: vi.fn() }));
vi.mock('../shipmentBatchSettlementHook', () => ({ notifyShipmentBatchSettlementRecalc: vi.fn() }));
vi.mock('../supplierClaimSettlementGuard', () => ({ lockSupplierClaimInvoice: vi.fn() }));
vi.mock('../supplierClaimInvoiceRelease', () => ({ releaseSupplierClaimInvoiceInTx: vi.fn() }));
import { createPaymentVoucher, updatePaymentVoucher } from '../paymentVoucherMutationService';
import { deleteVoucher, deleteInvoice } from '../voidDeleteService';
import { createVatInvoice, updateVatInvoice, deleteVatInvoice } from '../vatInvoiceService';
import { readFinanceBalanceProjection } from '../financeBalanceProjection';
import { withFinanceReadProjection } from '../financeReadProjection';
import { getAgingReport, getCustomerStatement, getSupplierStatement } from '../reportService';
import { createFinanceServiceV2 } from '../financeServiceV2';
import { beginFinanceCommand } from '../financeCommandReceipt';
import { createPaymentRequestService } from '../../paymentRequests/paymentRequestService';
import {commandCompanyCashAccount,createCompanyCashAccount,getCompanyCashAccount} from '../companyCashAccountService';

const key = '10000000-0000-4000-8000-000000000001';
const actor: any = { userId: 'actor', roles: [], permissionCeiling: [...grants.scopes] };
const invoice = (id: string, extra: any = {}) => ({ id, invoiceNumber: id, type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal('100'),
  currency: 'USD', issueDate: '2026-10-01', dueDate: '2026-10-31', customerRelationId: 'own', customerName: 'Own customer', ownerId: 'finance', deletedAt: null, updatedAt: BigInt(1), ...extra });
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([name, value]: [string, any]) => {
    if (name === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (name === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object' && !(value instanceof Prisma.Decimal)) {
      if (value.path) return value.path.reduce((item: any, part: string) => item?.[part], row[name]) === value.equals;
      if (value.in) return value.in.includes(row[name]);
      if (value.notIn) return !value.notIn.includes(row[name]);
      if (value.not !== undefined) return row[name] !== value.not;
      if (value.gte !== undefined && row[name] < value.gte || value.lte !== undefined && row[name] > value.lte) return false;
      if (value.contains !== undefined) return String(row[name]).includes(value.contains);
      return true;
    }
    return value === null ? row[name] == null : row[name] === value;
  });
}
function fixture() {
  const facts: Record<string, any[]> = { invoice: [], paymentVoucher: [], vatInvoice: [], invoiceAllocation: [], creditNoteAllocation: [], invoiceLine: [], invoiceOrderAllocation: [],
    companyCashAccount:[{id:'ACCOUNT',currency:'USD',revision:1,status:'Active',allowedUserIds:['actor'],ownerId:'actor'}],cashAccountEntry:[],cashAccountCommandReceipt:[],userAccount:[{id:'actor',status:'active'}],team:[],department:[],warehouse:[],purchaseOrder:[],
    auditLog: [], paymentRequest: [], approvalRequest: [], creditNoteRefund: [], creditNoteRefundReturn: [], developmentCase: [], costRecord: [], billingItem: [],
    order: [], orderLine: [], shipment: [], shipmentOrderAllocation: [], relation: [{id: 'own', ownerId: 'actor'}, {id: 'hidden', ownerId: 'else'}],
    fxSettlement: [], outwardRemittance: [], fxRateLock: [], orderProfitSheet: [], orderInternalTransfer: [], customsDeclaration: [], taxRefund: [], customerReconciliationAck: [], exchangeRate: [] };
  const db: any = { $queryRaw: vi.fn(async (query: any) => {
    // Model the Prisma/PostgreSQL driver boundary observed in native R11:
    // advisory locks return void unless the selected result is cast.
    if (query.text.includes('pg_advisory_xact_lock') && !query.text.includes('::text'))
      throw new Error("Failed to deserialize column of type 'void'");
    return [];
  }), $queryRawUnsafe: vi.fn(async () => []), $transaction: vi.fn(async (work: any) => work(db)) };
  for (const [model, rows] of Object.entries(facts)) {
    const first = vi.fn(async ({where}: any) => rows.find(row => matches(row, where)) ?? null);
    db[model] = { findFirst: first, findUnique: first,
      findMany: vi.fn(async (args: any = {}) => { const found = rows.filter(row => matches(row, args.where)); return found.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take); }),
      count: vi.fn(async (args: any = {}) => rows.filter(row => matches(row, args.where)).length),
      create: vi.fn(async ({data}: any) => { rows.push(data); return data; }),
      update: vi.fn(async ({where, data}: any) => { const row = rows.find(row => matches(row, where)); Object.assign(row, data); return row; }),
      updateMany: vi.fn(async ({where, data}: any) => { const found = rows.filter(row => matches(row, where)); found.forEach(row => Object.assign(row, data)); return { count: found.length }; }) };
  }
  return { db, facts };
}
const receipt = (extra: any = {}) => ({ companyAccountId:'ACCOUNT',expectedAccountRevision:1,bankReference:'BANK-REAL',requestKey: key, type: 'Receipt', amount: '100', currency: 'USD', paymentDate: '2026-10-07', paymentMethod: 'TT', customerRelationId: 'own', customerName: 'Own customer', ...extra });
const vat = (extra: any = {}) => ({ requestKey: key, vatNumber: 'VAT-1', direction: 'Input', invoiceType: 'Special', sellerName: 'Supplier', buyerName: 'Our company', issueDate: '2026-10-07',
  netAmount: '100', taxRate: '13', taxAmount: '13', totalAmount: '113', currency: 'USD', invoiceId: 'AP', relationId: 'own', ...extra });
beforeEach(() => { vi.clearAllMocks(); grants.active = true; grants.kind = 'all'; grants.scopes = [...actor.permissionCeiling]; });

describe('F1 actual source, stable commands and exact currency net controls (pure storage mocks)', () => {
  it('records genuine partial payments only after approval, and retries the original payment before stale revision checks', async () => {
    const {db, facts} = fixture();
    const pr = {id:'PR',requestNumber:'PR-1',status:'Approved',payeeType:'Supplier',supplierId:'own',supplierName:'Supplier',
      currency:'USD',totalAmount:new Prisma.Decimal('100'),paymentCategory:'normal',applicantId:'business',
      approvalRequestId:'APPROVAL',paymentVoucherId:null,updatedAt:new Date('2026-10-07T00:00:00.000Z'),deletedAt:null};
    facts.paymentRequest.push(pr);
    facts.approvalRequest.push({id:'APPROVAL',targetId:'PR',targetType:'PaymentRequest',actionType:'finance:payment_request',requesterId:'business',status:'approved'});
    const service = createPaymentRequestService({prisma:db,approvalCreateService:{} as any});
    const input = {requestKey:key,expectedRequestUpdatedAt:pr.updatedAt.toISOString(),amount:'40',currency:'USD',paymentDate:'2026-10-07',
      companyAccountId:'ACCOUNT',expectedAccountRevision:1,paymentMethod:'TT',bankReference:'BANK-ACTUAL-1',evidenceNote:'实际银行扣款回单'};
    const result = await (service as any).recordActualPayment({paymentRequestId:'PR',actor,actorId:actor.userId,input});
    expect(result).toMatchObject({ok:true,data:{paymentRequest:{status:'Approved'},paidAmount:'40.0000',remainingAmount:'60.0000'}});
    expect(facts.paymentVoucher).toHaveLength(1);
    expect(facts.paymentVoucher[0].attachments).toMatchObject({paymentRequestId:'PR',actualPayment:{bankReference:'BANK-ACTUAL-1',recordedBy:'actor'}});
    const replay = await (service as any).recordActualPayment({paymentRequestId:'PR',actor,actorId:actor.userId,input});
    expect(replay).toMatchObject({ok:true,data:{replayed:true,paidAmount:'40.0000',remainingAmount:'60.0000'}});
    expect(replay.data.voucher).toEqual(result.data.voucher); expect(facts.paymentVoucher).toHaveLength(1);
    const nextInput = {...input,requestKey:'10000000-0000-4000-8000-000000000002',expectedRequestUpdatedAt:pr.updatedAt.toISOString(),amount:'60',expectedAccountRevision:2,bankReference:'BANK-ACTUAL-2'};
    const paid = await (service as any).recordActualPayment({paymentRequestId:'PR',actor,actorId:actor.userId,input:nextInput});
    expect(paid).toMatchObject({ok:true,data:{paymentRequest:{status:'Paid'},paidAmount:'100.0000',remainingAmount:'0.0000'}});
    expect(facts.paymentVoucher).toHaveLength(2);
    const lateReplay = await (service as any).recordActualPayment({paymentRequestId:'PR',actor,actorId:actor.userId,input});
    expect(lateReplay).toMatchObject({ok:true,data:{paymentRequest:{status:'Approved'},paidAmount:'40.0000',remainingAmount:'60.0000',replayed:true}});
    expect(facts.paymentVoucher).toHaveLength(2);
  });
  it('an approval decision never creates actual cash and never resets a historical issued payment', async () => {
    const {db,facts}=fixture();
    facts.paymentRequest.push({id:'PR',status:'Pending',approvalRequestId:'A',applicantId:'business',updatedAt:new Date(),deletedAt:null});
    facts.approvalRequest.push({id:'A',status:'approved',reviewerId:'actor',targetType:'PaymentRequest',targetId:'PR',requesterId:'business',actionType:'finance:payment_request'});
    const service=createPaymentRequestService({prisma:db,approvalCreateService:{} as any});
    expect(await service.syncApprovalDecision({paymentRequestId:'PR',actorId:'actor'})).toMatchObject({ok:true,data:{paymentRequest:{status:'Approved'},synced:true}});
    expect(db.paymentVoucher.create).not.toHaveBeenCalled();
    facts.paymentRequest[0].status='VoucherIssued'; facts.paymentRequest[0].paymentVoucherId='historical';
    expect(await service.syncApprovalDecision({paymentRequestId:'PR',actorId:'actor'})).toMatchObject({ok:true,data:{paymentRequest:{status:'VoucherIssued',paymentVoucherId:'historical'},synced:false}});
    expect(db.paymentVoucher.create).not.toHaveBeenCalled();
  });
  it('original-key retry returns the original actual receipt and performs one create', async () => {
    const {db, facts} = fixture(); const first = await createPaymentVoucher({prisma: db, actor, actorId: actor.userId, input: receipt()});
    expect(first.ok).toBe(true); if (!first.ok) return;
    facts.paymentVoucher[0].notes = 'later fact';
    const replay = await createPaymentVoucher({prisma: db, actor, actorId: actor.userId, input: receipt()});
    expect(replay).toMatchObject({ok: true, data: {replayed: true, voucher: {id: first.data.voucher.id}}});
    expect(replay.ok && replay.data.voucher).toEqual(first.data.voucher);
    expect(replay.ok && replay.data.voucher.notes).not.toBe('later fact'); expect(db.paymentVoucher.create).toHaveBeenCalledOnce();
    const changed = await createPaymentVoucher({prisma: db, actor, actorId: actor.userId, input: receipt({amount: '101'})});
    expect(changed).toMatchObject({ok: false, error: {code: 'CONFLICT'}});
  });
  it('current scope revocation blocks even a committed original key', async () => {
    const {db} = fixture(); expect((await createPaymentVoucher({prisma: db, actor, actorId: actor.userId, input: receipt()})).ok).toBe(true);
    grants.scopes = ['vouchers:read'];
    expect(await createPaymentVoucher({prisma: db, actor, actorId: actor.userId, input: receipt()})).toMatchObject({ok: false, error: {code: 'FORBIDDEN'}});
  });
  it('does not synthesize authority from actorId or a body actor', async () => {
    const {db} = fixture(); expect(await createPaymentVoucher({prisma: db, actorId: 'actor', input: receipt({actor})})).toMatchObject({ok: false, error: {code: 'UNAUTHORIZED'}});
    expect(db.paymentVoucher.create).not.toHaveBeenCalled();
  });
  it('requires explicit actual date and cannot manually create reconciled cash', async () => {
    const {db} = fixture();
    for (const input of [receipt({paymentDate: undefined}), receipt({status: 'reconciled', appliedAmount: '100'})])
      expect((await createPaymentVoucher({prisma: db, actor, actorId: actor.userId, input})).ok).toBe(false);
    expect(db.paymentVoucher.create).not.toHaveBeenCalled();
  });
  it('disbursement cannot bypass its genuine approved request', async () => {
    const {db} = fixture(); expect(await createPaymentVoucher({prisma: db, actor, actorId: actor.userId, input: receipt({type: 'Disbursement'})})).toMatchObject({ok: false, error: {code: 'PAYMENT_REQUEST_REQUIRED'}});
  });
  it('stale cash edit and allocation-bearing deletion cannot write', async () => {
    const {db, facts} = fixture(); facts.paymentVoucher.push({id: 'cash', ownerId: 'actor', updatedAt: BigInt(7), type: 'Receipt', status: 'unreconciled', deletedAt: null, amount: new Prisma.Decimal(100), currency: 'USD'});
    expect(await updatePaymentVoucher({prisma: db, actor, actorId: actor.userId, voucherId: 'cash', input: {requestKey: key, expectedUpdatedAt: '6', notes: 'wrong'}})).toMatchObject({ok: false, error: {code: 'CONFLICT'}});
    facts.invoiceAllocation.push({invoiceId: 'invoice', voucherId: 'cash', appliedAmount: '1'});
    expect(await deleteVoucher({prisma: db, actor, actorId: actor.userId, voucherId: 'cash', requestKey: key, expectedUpdatedAt: '7'})).toMatchObject({ok: false, error: {code: 'HAS_ALLOCATIONS'}});
    expect(db.paymentVoucher.update).not.toHaveBeenCalled();
  });
  it.each(['BusinessShipmentCI', 'BusinessDevelopmentCI'])('keeps %s source registration immutable', async sourceType => {
    const {db, facts} = fixture(); facts.invoice.push(invoice('CI', {sourceType}));
    expect(await deleteInvoice({prisma: db, actor, actorId: actor.userId, invoiceId: 'CI'})).toMatchObject({ok: false, error: {code: 'HANDOFF_CONFLICT'}});
    expect(db.invoice.update).not.toHaveBeenCalled();
  });
  it('VAT input cannot borrow our commercial invoice as supplier source', async () => {
    const {db, facts} = fixture(); facts.invoice.push(invoice('AP', {sourceType: 'BusinessDevelopmentCI'}));
    expect(await createVatInvoice({prisma: db, actor, actorId: actor.userId, input: vat()})).toMatchObject({ok: false, error: {code: 'CONFLICT'}});
    expect(db.vatInvoice.create).not.toHaveBeenCalled();
  });
  it('a supplier original supporting an issued AP cannot be overwritten or deleted', async () => {
    const {db, facts} = fixture(); facts.invoice.push(invoice('AP', {type: 'Payable'}));
    facts.vatInvoice.push({...vat(), id: 'VAT', status: 'Received', updatedAt: BigInt(2), deletedAt: null, attachments: [{id: 'original'}]});
    for (const patch of [{sellerName: 'different supplier'}, {attachments: [{id: 'replacement'}]}])
      expect(await updateVatInvoice({prisma: db, actor, actorId: actor.userId, vatInvoiceId: 'VAT', patch: {...patch, requestKey: key, expectedUpdatedAt: '2'}})).toMatchObject({ok: false, error: {code: 'CONFLICT'}});
    expect(await deleteVatInvoice({prisma: db, actor, actorId: actor.userId, vatInvoiceId: 'VAT', requestKey: key, expectedUpdatedAt: '2'})).toMatchObject({ok: false, error: {code: 'CONFLICT'}});
    expect(db.vatInvoice.update).not.toHaveBeenCalled();
  });
  it('keeps currencies separate and subtracts only actual cash plus credit allocations', async () => {
    const {db, facts} = fixture(); facts.invoice.push(invoice('USD'), invoice('EUR', {currency: 'EUR', amount: '50'}), invoice('draft', {status: 'Draft', amount: '999'}));
    facts.paymentVoucher.push({id: 'cash', type: 'Receipt', amount: '60', currency: 'USD', deletedAt: null, ownerId: 'actor'});
    facts.invoiceAllocation.push({invoiceId: 'USD', voucherId: 'cash', appliedAmount: '40'}); facts.creditNoteAllocation.push({invoiceId: 'USD', appliedAmount: '10'});
    const result = await readFinanceBalanceProjection(db, actor);
    expect(result.receivable).toBeNull(); expect(result.byCurrency).toMatchObject([{currency: 'EUR', receivable: {total: '50.0000', outstanding: '50.0000'}}, {currency: 'USD', receivable: {total: '100.0000', paid: '40.0000', creditApplied: '10.0000', outstanding: '50.0000'}, receipts: {unallocated: '20.0000'}}]);
  });
  it('negative payable uses an actual receipt without manufacturing positive debt', async () => {
    const {db, facts} = fixture(); facts.invoice.push(invoice('creditAP', {type: 'Payable', amount: '-30'})); facts.paymentVoucher.push({id:'return',type:'Receipt',amount:'30',currency:'USD',deletedAt:null}); facts.invoiceAllocation.push({invoiceId:'creditAP',voucherId:'return',appliedAmount:'30'});
    expect((await readFinanceBalanceProjection(db, actor)).payable).toMatchObject({total:'-30.0000',paid:'-30.0000',outstanding:'0.0000'});
  });
  it('source filtering occurs before count/page and honors an inaccessible target', async () => {
    grants.kind = 'self'; const {db, facts} = fixture(); facts.invoice.push(invoice('own'), invoice('hidden', {customerRelationId:'hidden'}));
    const result = await withFinanceReadProjection(db, actor, async view => ({count: await view.invoice.count({where:{deletedAt:null}}), page: await view.invoice.findMany({where:{deletedAt:null}, take:1})}));
    expect(result.count).toBe(1); expect(result.page.map((row:any)=>row.id)).toEqual(['own']);
    await expect(getCustomerStatement(db, {actor, customerRelationId:'hidden'})).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('customer statement sees its actual third-party share without the whole payer balance', async () => {
    grants.kind = 'self'; const {db, facts} = fixture(); facts.invoice.push(invoice('own'), invoice('hidden', {customerRelationId:'hidden'}));
    facts.paymentVoucher.push({id:'foreign-cash',voucherNumber:'bank-proof',type:'Receipt',status:'unreconciled',customerRelationId:'hidden',customerName:'Foreign payer',ownerId:'else',amount:'999',currency:'USD',paymentDate:'2026-10-07',deletedAt:null});
    facts.invoiceAllocation.push({invoiceId:'own',voucherId:'foreign-cash',appliedAmount:'10'},{invoiceId:'hidden',voucherId:'foreign-cash',appliedAmount:'500'});
    const result = await getCustomerStatement(db,{actor, customerRelationId:'own'});
    expect(result.sections[0].closingBalance).toBe(90); expect(JSON.stringify(result)).not.toContain('Foreign payer'); expect(JSON.stringify(result)).not.toContain('999');
  });
  it('report missing identity and missing storage never become an empty balance', async () => {
    const {db} = fixture(); await expect(getAgingReport(db,{type:'Receivable'})).rejects.toMatchObject({code:'UNAUTHORIZED'});
    db.invoice.findMany.mockRejectedValue(new Error('storage down')); await expect(getAgingReport(db,{actor,type:'Receivable'})).rejects.toThrow('storage down');
  });
  it('stable receipt binds the complete command, including expected revision', async () => {
    const {db} = fixture(); const command = await beginFinanceCommand(db,actor,'voucher.update',{requestKey:key,expectedUpdatedAt:'1'}); await command.commit({id:'same'});
    expect((await beginFinanceCommand(db,actor,'voucher.update',{requestKey:key,expectedUpdatedAt:'1'})).receipt).toEqual({id:'same'});
    await expect(beginFinanceCommand(db,actor,'voucher.update',{requestKey:key,expectedUpdatedAt:'2'})).rejects.toMatchObject({code:'CONFLICT'});
  });
  it('V2 creates actual cash only through the canonical audited command', async () => {
    const {db} = fixture(); const result = await createFinanceServiceV2(db).create('payment', actor, receipt({ownerId:'spoofed'}));
    expect(result).toMatchObject({ok:true,data:{ownerId:'actor',status:'unreconciled'}});
    expect(db.auditLog.create).toHaveBeenCalledOnce();
    expect(await createFinanceServiceV2(db).create('payment',actor,receipt({requestKey:undefined}))).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    expect(db.paymentVoucher.create).toHaveBeenCalledOnce();
  });
  it('aging nets a genuine negative original without omitting or reversing it', async () => {
    const {db,facts}=fixture(); facts.invoice.push(invoice('debt'),invoice('credit',{amount:'-30'}));
    facts.creditNoteAllocation.push({invoiceId:'debt',creditNoteId:'CN',appliedAmount:'10',appliedDate:'2026-10-07'});
    expect((await getAgingReport(db,{actor,type:'Receivable'})).totals[0].total).toBe(60);
    const statement=await getCustomerStatement(db,{actor,customerRelationId:'own'});
    expect(statement.sections[0].closingBalance).toBe(60);
    expect(statement.sections[0].transactions.find(row=>row.number==='CN')).toMatchObject({kind:'credit',credit:10});
  });
  it('supplier statement consumes actual returned cash against a negative payable', async () => {
    const {db,facts}=fixture(); facts.invoice.push(invoice('AP',{type:'Payable'}),invoice('returnAP',{type:'Payable',amount:'-30'}));
    facts.paymentVoucher.push({id:'return',voucherNumber:'Returned money',type:'Receipt',amount:'30',currency:'USD',customerRelationId:'own',paymentDate:'2026-10-07',deletedAt:null,status:'unreconciled'});
    facts.invoiceAllocation.push({invoiceId:'returnAP',voucherId:'return',appliedAmount:'30'});
    expect((await getSupplierStatement(db,{actor,supplierRelationId:'own'})).sections[0].closingBalance).toBe(100);
  });

});

describe('actual supplier payment boundaries',()=>{
  function approved(){const f=fixture();const request={id:'PR',requestNumber:'PR-1',status:'Approved',payeeType:'Supplier',supplierId:'own',supplierName:'Supplier',currency:'USD',
    totalAmount:new Prisma.Decimal('100'),paymentCategory:'normal',applicantId:'business',approvalRequestId:'APP',paymentVoucherId:null,updatedAt:new Date('2026-10-07T00:00:00.000Z'),deletedAt:null};
    f.facts.paymentRequest.push(request);f.facts.approvalRequest.push({id:'APP',targetId:'PR',targetType:'PaymentRequest',actionType:'finance:payment_request',requesterId:'business',status:'approved'});
    const service=createPaymentRequestService({prisma:f.db,approvalCreateService:{} as any});
    const input={requestKey:key,expectedRequestUpdatedAt:request.updatedAt.toISOString(),amount:'40.0000',currency:'USD',paymentDate:'2026-10-07',companyAccountId:'ACCOUNT',expectedAccountRevision:1,paymentMethod:'TT',bankReference:'ACTUAL-1'};
    return {...f,request,service,input,run:(overrides:any={})=>service.recordActualPayment({paymentRequestId:'PR',actor,actorId:'actor',input:{...input,...overrides}})};
  }
  it.each([{amount:'100.0001'},{currency:'CNY'},{bankReference:''},{paymentDate:'2026-02-31'},{paymentMethod:''},{expectedRequestUpdatedAt:'2026-10-06T00:00:00.000Z'}])('rejects over-capacity/mismatched/unknown actual facts before creating cash %o',async overrides=>{
    const f=approved();expect(await f.run(overrides)).toMatchObject({ok:false});expect(f.facts.paymentVoucher).toHaveLength(0);expect(f.request.status).toBe('Approved');
  });
  it('does not release payment capacity when an actual voucher is hidden or cancelled',async()=>{
    const f=approved();f.facts.paymentVoucher.push({id:'OLD',type:'Disbursement',amount:new Prisma.Decimal('40'),currency:'USD',customerRelationId:'own',
      paymentDate:'2026-10-07',paymentMethod:'TT',voucherNumber:'OLD',deletedAt:BigInt(2),status:'cancelled',attachments:{paymentRequestId:'PR'}});
    expect(await f.run({amount:'60.0001'})).toMatchObject({ok:false,error:{code:'CONFLICT'}});expect(f.facts.paymentVoucher).toHaveLength(1);
  });
  it('rejects forged generic request linkage and revoked current grants',async()=>{
    const f=approved();expect(await createPaymentVoucher({prisma:f.db,actor,actorId:'actor',input:{...receipt(),type:'Disbursement',paymentRequestId:'PR'}}))
      .toMatchObject({ok:false,error:{code:'CONFLICT'}});
    grants.scopes=[];expect(await f.run()).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});expect(f.facts.paymentVoucher).toHaveLength(0);
  });
});

describe('F2 actual company bank ledger (pure storage mocks)',()=>{
  const fact=(extra:any={})=>({requestKey:key,expectedRevision:1,action:'opening' as const,amount:'0',currency:'USD',occurredDate:'2026-10-07',bankReference:'VERIFIED-OPENING',...extra});
  it('shares actual bank-return capacity between the private producer and independent corrections without posting reused receipts twice',async()=>{
    const {db,facts}=fixture();facts.paymentRequest.push({id:'PR',status:'Approved',supplierId:'own',currency:'USD'});
    const paid=await createPaymentVoucher({prisma:db,actor,actorId:'actor',supplierPaymentExecution:{paymentRequestId:'PR'},input:receipt({type:'Disbursement',paymentRequestId:'PR'})});expect(paid.ok).toBe(true);
    const original=facts.cashAccountEntry[0];expect(original.kind).toBe('Payment');
    const returned=await createPaymentVoucher({prisma:db,actor,actorId:'actor',cashCorrectionSource:{entryId:original.id},input:receipt({requestKey:'10000000-0000-4000-8000-000000000002',amount:'60',expectedAccountRevision:2})});expect(returned.ok).toBe(true);
    expect(facts.cashAccountEntry[1]).toMatchObject({kind:'CorrectionIn',correctsEntryId:original.id});
    const reused=await createPaymentVoucher({prisma:db,actor,actorId:'actor',input:receipt({requestKey:'10000000-0000-4000-8000-000000000003',amount:'10',expectedAccountRevision:3})});expect(reused.ok).toBe(true);
    // An immutable CN return may consume this already-posted Receipt once.
    facts.creditNoteRefundReturn.push({sourcePaymentVoucherId:paid.data!.voucher.id,receiptVoucherId:reused.data!.voucher.id,receivedNet:new Prisma.Decimal('10')});
    const correction=fact({requestKey:'10000000-0000-4000-8000-000000000004',expectedRevision:4,action:'correction',correctsEntryId:original.id,amount:'30.0001',reason:'实际银行退回'});
    await expect(commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:correction})).rejects.toMatchObject({code:'CONFLICT'});
    await commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:{...correction,amount:'30'}});
    expect(facts.cashAccountEntry).toHaveLength(4);expect((await getCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT'})).recordedNetMovement).toBe('0.0000');
  });
  it('keeps unknown without Opening, accepts a verified zero, and never infers actual net from a fee rate',async()=>{
    const {db,facts}=fixture();
    expect(await getCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT'})).toMatchObject({balance:null,balanceStatus:'unknown',entries:[]});
    const opening=await commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:fact()});
    expect(opening.entry.amount.toString()).toBe('0');
    const made=await createPaymentVoucher({prisma:db,actorId:'actor',actor,input:receipt({expectedAccountRevision:2,bankFee:'2',feeBearer:'BEN',actualAccountAmount:'98'})});
    expect(made.ok).toBe(true);
    expect(facts.cashAccountEntry[1]).toMatchObject({kind:'Receipt',sourceVoucherId:made.data!.voucher.id});
    expect(facts.cashAccountEntry[1].amount.toString()).toBe('98');
    const view=await getCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT'});expect(view.balance).toBe('98.0000');
    expect(facts.cashAccountEntry[1].evidence.sourceSnapshot).toMatchObject({voucherAmount:'100.0000',bankFee:'2.0000',accountAmount:'98.0000'});
  });
  it('refuses a late current balance as Opening, then keeps the exact original command receipt after a newer revision',async()=>{
    const {db,facts}=fixture();const made=await createPaymentVoucher({prisma:db,actorId:'actor',actor,input:receipt()});expect(made.ok).toBe(true);
    await expect(commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:fact({expectedRevision:2,occurredDate:'2026-10-08'})})).rejects.toMatchObject({code:'CONFLICT'});
    const input=fact({expectedRevision:2,amount:'-10'}),first=await commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input});
    const replay=await commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input});
    expect(replay).toEqual({...first,replayed:true});expect(facts.cashAccountEntry).toHaveLength(2);
    await expect(commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:{...input,amount:'0'}})).rejects.toMatchObject({code:'CONFLICT'});
    expect((await getCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT'})).balance).toBe('90.0000');
  });
  it('keeps cash after soft removal and bounds true corrections by the original bank net',async()=>{
    const {db,facts}=fixture();const made=await createPaymentVoucher({prisma:db,actorId:'actor',actor,input:receipt({bankFee:'2',feeBearer:'BEN',actualAccountAmount:'98'})});expect(made.ok).toBe(true);
    const entry=facts.cashAccountEntry[0];
    await commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:fact({requestKey:'10000000-0000-4000-8000-000000000002',expectedRevision:2})});
    const correction={requestKey:'10000000-0000-4000-8000-000000000003',expectedRevision:3,action:'correction' as const,amount:'98',currency:'USD',occurredDate:'2026-10-07',correctsEntryId:entry.id,bankReference:'REAL-REFUND',reason:'真实退回原收款'};
    await commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:correction});
    const current=facts.paymentVoucher[0];const removed=await deleteVoucher({prisma:db,actorId:'actor',actor,voucherId:current.id,requestKey:'10000000-0000-4000-8000-000000000004',expectedUpdatedAt:String(current.updatedAt)});expect(removed.ok).toBe(true);
    expect(facts.cashAccountEntry).toHaveLength(3);
    expect((await getCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT'})).balance).toBe('0.0000');
    await expect(commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:{...correction,requestKey:'10000000-0000-4000-8000-000000000005',expectedRevision:4,amount:'0.0001'}})).rejects.toMatchObject({code:'CONFLICT'});
    expect(facts.cashAccountEntry).toHaveLength(3);
  });
  it('intersects current financial owner scope and explicit use list, including original receipt replay',async()=>{
    const {db,facts}=fixture();const input=receipt();expect((await createPaymentVoucher({prisma:db,actorId:'actor',actor,input})).ok).toBe(true);
    facts.companyCashAccount[0].allowedUserIds=[];
    await expect(getCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT'})).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(await createPaymentVoucher({prisma:db,actorId:'actor',actor,input})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
    facts.companyCashAccount[0].allowedUserIds=['actor'];facts.companyCashAccount[0].ownerId='someone-else';grants.kind='self';
    await expect(getCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT'})).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('reserves account configuration for current management capability and does not turn an unassigned legacy receipt into zero',async()=>{
    const {db,facts}=fixture();
    const input:any={requestKey:key,name:'Bank',companyName:'Company',currency:'USD',bankName:'Bank',accountName:'Company',accountNumberMasked:'****',ownerId:'actor',allowedUserIds:['actor']};
    await expect(createCompanyCashAccount({prisma:db,actor,input})).rejects.toMatchObject({code:'FORBIDDEN'});
    await commandCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT',input:fact()});
    facts.paymentVoucher.push({id:'LEGACY',companyAccountId:null,paymentDate:'2026-10-07',amount:new Prisma.Decimal(12),currency:'USD',deletedAt:BigInt(1)});
    expect(await getCompanyCashAccount({prisma:db,actor,accountId:'ACCOUNT'})).toMatchObject({balance:null,recordedBalance:'0.0000',balanceStatus:'unknown'});
  });
});
