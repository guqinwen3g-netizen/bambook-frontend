import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { approvalEventBus } from '../../agent/events';
import { SYSTEM_ROLE_IDS } from '../../_shared/rolePermissionMatrix';
import { approvalReviewContentVersion, createApprovalDecisionService } from '../approvalDecisionService';
import { approvalReviewPreviewDigest } from '../approvalReviewDetailService';
import { buildQuotationApprovalSnapshot, buildQuotationSnapshot, canonicalQuotationJson, ACTION_LINE_APPROVE } from '../../quotations/quotationApprovalSnapshot';
import { publishNotificationEvent } from '../../realtime';
import { buildApprovalSignDocumentSnapshot } from '../approvalSignDocumentSnapshotService';
import { ACTION_TOTAL_APPROVE } from '../../quotations/quotationApprovalSnapshot';

vi.mock('../../auth/permissionService',async(importOriginal)=>({...await importOriginal<any>(),createPermissionService:()=>({getUserPermissionContext:async()=>({scopes:['quotations:write']})})}));
vi.mock('../approvalSignDocumentSnapshotService',async(importOriginal)=>({...await importOriginal<any>(),lockAndAssertCurrentApprovalSignDocumentSnapshot:async()=>({contentFingerprint:'frozen'})}));
vi.mock('../approvalReviewDetailService',async(importOriginal)=>({...await importOriginal<any>(),assertApprovalReviewReadyForDecision:async()=>{}}));
vi.mock('../../realtime', () => ({ publishNotificationEvent: vi.fn(), publishDataChange: vi.fn() }));

/** Transaction-model unit probes only; real PG rollback/concurrency belongs to acceptance tests. */
const decisionQuotation = { id: 'q1', quotationNumber: 'QT-1', status: 'Draft', deletedAt: null, version: 1,
  currency: 'USD', totalAmount: '100', notes: null, customerRelationId: null, customerName: 'Buyer', customerCode: null,
  developmentCaseId: null, orderId: null, orderLineId: null, issueDate: '2026-10-01', validUntil: null,
  deliveryTerms: null, paymentTerms: null, paymentInstrument: null, baseCurrency: 'USD', exchangeRate: null,
  trackAMedianUsd: '1', trackAUnit: 'M', trackBFinalUsd: '1.2', priceDeviationPercent: 20,
  priceDeviationLevel: 'warn', priceApprovalId: 'a1', lines: [{ id: 'line-1', lineNumber: 1, description: 'Cloth',
    quantity: '10', unit: 'M', unitPrice: '10', amount: '100', fabricCode: 'FAB-1', notes: null, imageUrl: null, moqOverride: null }] };
const decisionQuotationSnapshot = buildQuotationSnapshot(decisionQuotation);
const decisionQuotationFingerprint = createHash('sha256').update(canonicalQuotationJson({ actionType: 'quotation:price-deviation',
  targetType: 'Quotation', targetId: 'q1', quotationSnapshot: decisionQuotationSnapshot })).digest('hex');
function fixture(options: { row?: Record<string, any>; auditFail?: boolean; loseCas?: boolean; notificationFail?: boolean; quotation?: Record<string, any> } = {}) {
  let row: any = { id: 'a1', requesterId: 'requester', reviewerId: 'reviewer', status: 'pending',
    actionType: 'quotation:price-deviation', targetType: 'Quotation', targetId: 'q1', risk: 'high',
    payload: { policyKey: 'price_approval', quotationId: 'q1', quotationNumber: 'QT-1',
      quotationSnapshot: decisionQuotationSnapshot, contentFingerprint: decisionQuotationFingerprint,
      trackAMedianUsd: 1, trackAUnit: 'M', trackBFinalUsd: 1.2, deviationPercent: 20,
      source: 'quotation-dual-track', hitConditions: ['dual_track_deviation'], level: 'warn',
      requestedAt: '2026-10-01T00:00:00.000Z', ruleFindings: [{ rule: 'dual_track_deviation' }] }, decidedAt: null, decisionNote: null,
    bossFinalBypassBy: null, ...options.row };
  const audits: any[] = [];
  const notifications: any[] = [];
  const trace: string[] = [];
  const read = async () => { trace.push('read'); return { ...row }; };
  const prisma: any = {
    approvalRequest: {
      findUnique: vi.fn(read), findUniqueOrThrow: vi.fn(read),
      updateMany: vi.fn(async ({ where, data }: any) => {
        trace.push('write');
        if (options.loseCas) return { count: 0 };
        for (const key of ['id', 'status', 'requesterId', 'reviewerId', 'actionType', 'targetType', 'targetId']) {
          if (where[key] !== row[key]) return { count: 0 };
        }
        if (JSON.stringify(where.payload.equals) !== JSON.stringify(row.payload)) return { count: 0 };
        row = { ...row, ...data }; return { count: 1 };
      }),
    },
    userRole: { findMany: vi.fn(async () => [{ roleId: SYSTEM_ROLE_IDS.SALES_MANAGER }]) },
    quotation: { findUnique: vi.fn(async () => options.quotation ?? decisionQuotation) },
    userAccount: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id })) },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        trace.push('audit');
        if (options.auditFail) throw Object.assign(new Error('SQL fault sentinel'), { code: 'P2003' });
        const audit = { ...data, createdAt: new Date() }; audits.push(audit); return audit;
      }),
      findMany: vi.fn(async () => [...audits]),
      findFirst: vi.fn(async ({ where }: any) => audits.find(audit => audit.action === where.action && audit.targetId === where.targetId
        && audit.detail.decisionAuditId === where.detail.equals) ?? null),
    },
    notification: {
      createMany: vi.fn(async ({ data }: any) => {
        trace.push('receipt');
        if (options.notificationFail) throw Object.assign(new Error('notification storage fault'), { code: 'P2003' });
        let count = 0;
        for (const item of data) if (!notifications.some(existing => existing.id === item.id)) { notifications.push(item); count++; }
        return { count };
      }),
    },
    $queryRaw: vi.fn(async () => { trace.push('lock'); return [{ id: 'a1' }]; }),
    $queryRawUnsafe: vi.fn(async () => { trace.push('source-lock'); return [{ id: 'q1' }]; }),
    systemConfig: { findUnique: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (callback: any) => {
      const before = row; const auditCount = audits.length; const notificationCount = notifications.length;
      try { const result = await callback(prisma); trace.push('commit'); return result; }
      catch (error) { row = before; audits.splice(auditCount); notifications.splice(notificationCount); trace.push('rollback'); throw error; }
    }),
  };
  return { prisma, audits, notifications, trace, getRow: () => row };
}
const baseReview = { id: 'a1', requesterId: 'requester', reviewerId: 'reviewer', actionType: 'quotation:price-deviation',
  targetType: 'Quotation', targetId: 'q1', payload: { policyKey: 'price_approval', quotationId: 'q1', quotationNumber: 'QT-1',
    quotationSnapshot: decisionQuotationSnapshot, contentFingerprint: decisionQuotationFingerprint,
    trackAMedianUsd: 1, trackAUnit: 'M', trackBFinalUsd: 1.2, deviationPercent: 20, source: 'quotation-dual-track',
    hitConditions: ['dual_track_deviation'], level: 'warn', requestedAt: '2026-10-01T00:00:00.000Z', ruleFindings: [{ rule: 'dual_track_deviation' }] } };
const review = (override: Record<string, unknown> = {}) => {
  const approval = { ...baseReview, ...override } as any;
  return { reviewContentVersion: approvalReviewContentVersion(approval), reviewPreviewDigest: approvalReviewPreviewDigest(approval), confirmedReviewedContent: true };
};
const input = { id: 'a1', actor: { userId: 'reviewer', roles: ['manager'] }, decision: 'approved' as const,
  source: 'api:approvals' as const, ...review() };


import {createApprovalCreateService} from '../approvalCreateService';
function quoteFixture(family='Fabric',requester='business',head='head') {
 const quotation={...decisionQuotation,quotationType:family,ownerId:requester,tradePlace:'Shanghai',contactName:'Buyer contact',contactPhone:'123',deliveryTerms:'FOB',paymentTerms:'30% deposit',internalCostBasis:{notes:'Frozen cost basis',cost:70},lines:decisionQuotation.lines.map(line=>({...line,productAssetId:'P',productType:family,moq:5,leadTimeDays:30,leadTimeStart:'deposit received',priceTiers:[{minQuantity:10,unitPrice:10}]}))};
 const row={actionType:ACTION_TOTAL_APPROVE,targetType:'Quotation',targetId:'q1',requesterId:requester,reviewerId:head,payload:{quotationId:'q1',...buildQuotationApprovalSnapshot(quotation,ACTION_TOTAL_APPROVE,'q1'),documentSnapshot:{contentFingerprint:'frozen',sourceFingerprint:'source'}}};
 const f=fixture({row,quotation});
 f.prisma.userAccount.findFirst.mockImplementation(async({where}:any)=>({id:where.id,primaryDeptId:'dept',status:'active'}));
 f.prisma.team={findMany:vi.fn(async()=>[{id:'team',leaderId:head,status:'active',deletedAt:null,department:{id:'dept',parentId:'company',status:'active',metadata:{businessAttributes:[family==='Fabric'?'fabric_business':'garment_business']}}}])};
 const command=(actor=head,decision:'approved'|'rejected'='approved',note?:string)=>({...input,actor:{userId:actor,roles:['manager']},decision,decisionNote:note,...review(row)});
 return {...f,row,quotation,command};
}
describe('quotation create and decision business head integration',()=>{
 it.each(['Fabric','Garment'])('routes %s whole confirmation through its live corresponding head and preserves commercial/cost payload',async family=>{
  const f=quoteFixture(family);const created=vi.fn(async({data}:any)=>data);
  f.prisma.approvalRequest.findFirst=vi.fn(async()=>null);f.prisma.approvalRequest.create=created;
  const fallback=vi.fn();const service=createApprovalCreateService({prisma:f.prisma,routingService:{resolveReviewerByDepartment:fallback} as any});
  const approval=await service.createBusinessApproval({requesterId:'business',actionType:ACTION_TOTAL_APPROVE,targetType:'Quotation',targetId:'q1',payload:f.row.payload,clientSuppliedReviewerId:'intruder'});
  expect(approval.reviewerId).toBe('head');expect(fallback).not.toHaveBeenCalled();
  expect((approval.payload as any).quotationSnapshot).toMatchObject({quotationType:family,tradePlace:'Shanghai',deliveryTerms:'FOB',paymentTerms:'30% deposit',internalCostBasis:{cost:70},lines:[{leadTimeDays:30,leadTimeStart:'deposit received',priceTiers:[{minQuantity:10,unitPrice:10}]}]});
 });
 it.each(['Fabric','Garment'])('allows own %s current head total normal confirmation with an auditable fact',async family=>{
  const f=quoteFixture(family,'head');await createApprovalDecisionService(f.prisma).decide(f.command());
  expect(f.getRow().status).toBe('approved');expect(f.audits.some(a=>a.detail.selfConfirmed===true)).toBe(true);
 });
 it.each([{mode:'boss',decision:'approved'},{mode:'normal',decision:'modified'},{mode:'normal',decision:'rejected'}] as const)('does not self confirm outside approved normal: %j',async variant=>{
  const f=quoteFixture('Fabric','head');
  await expect(createApprovalDecisionService(f.prisma).decide({...f.command(),...variant,decisionNote:'Please revise',bossReason:'This reason cannot turn self approval into a broad privileged exception.'})).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});
 });
 it('requires a rejection reason and persists a supplied reason',async()=>{
  const f=quoteFixture();await expect(createApprovalDecisionService(f.prisma).decide(f.command('head','rejected',' '))).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  expect(f.getRow().status).toBe('pending');await createApprovalDecisionService(f.prisma).decide(f.command('head','rejected','Cost basis requires revision'));
  expect(f.getRow().decisionNote).toBe('Cost basis requires revision');
 });
 it('rejects a former head after live organisation changes',async()=>{
  const f=quoteFixture();f.prisma.team.findMany.mockResolvedValue([{leaderId:'new-head',status:'active',deletedAt:null,department:{id:'dept',parentId:'company',status:'active',metadata:{businessAttributes:['fabric_business']}}}]);
  await expect(createApprovalDecisionService(f.prisma).decide(f.command())).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.getRow().status).toBe('pending');
 });
 it('does not allow a head to self confirm a salesperson-owned quote',async()=>{
  const f=quoteFixture('Fabric','head');f.prisma.quotation.findUnique.mockResolvedValue({...f.quotation,ownerId:'salesperson'});
  await expect(createApprovalDecisionService(f.prisma).decide(f.command())).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});
 });
 it('does not extend self approval to another approval action',async()=>{
  const f=fixture({row:{requesterId:'reviewer',actionType:'quotation:price-deviation'}});
  await expect(createApprovalDecisionService(f.prisma).decide({...input,...review({requesterId:'reviewer'})})).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});
 });
});
