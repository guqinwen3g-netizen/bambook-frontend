import { businessError } from '../shared/errorCodes';
/** Whole-version commercial confirmation is mandatory before issuance.
 * Line approvals remain supporting facts and never imply a whole-version decision.
 * ApprovalRequest retains routing, signed-source binding and decision audit authority.
 */

import type { PrismaClient } from '@prisma/client';
import type { ApprovalCreateService } from '../approvals/approvalCreateService';
import { assertCurrentApprovalSignDocumentSnapshot, buildApprovalSignDocumentSnapshot,
  getApprovalSignDocumentSnapshot, lockQuotationSignDocumentSources } from '../approvals/approvalSignDocumentSnapshotService';

import { ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE, buildQuotationApprovalSnapshot,
  lockQuotationSource, quotationApprovalSourceState, readQuotationApprovalState, quotationApprovalError,
  } from './quotationApprovalSnapshot';
export { ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE } from './quotationApprovalSnapshot';
const TARGET_LINE = 'QuotationLine';
const TARGET_QUOTATION = 'Quotation';

export interface QuotationApprovalServiceOptions {
  prisma: PrismaClient;
  approvalCreateService: ApprovalCreateService;
}

export interface LineApprovalStatus {
  lineId: string;
  lineNumber: number;
  status: string; // unrequested | pending | approved | rejected
}

/** Exact action is part of the approval identity; unrelated approvals cannot grant quotation permission. */
async function findApproval(db: any, actionType: string, targetType: string, targetId: string) {
  return db.approvalRequest.findFirst({ where: { actionType, targetType, targetId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
}

/** Freeze the actual quotation context; legacy omissions remain unknown. */
function quotationContext(quotation: any) {
  return {
    quotationNumber: quotation?.quotationNumber ?? null,
    customerName: quotation?.customerName ?? null,
    customerRelationId: quotation?.customerRelationId ?? null,
    currency: quotation?.currency ?? null,
    version: quotation?.version ?? null,
    developmentCaseId: quotation?.developmentCaseId ?? null,
  };
}

export function createQuotationApprovalService(opts: QuotationApprovalServiceOptions) {
  const { prisma, approvalCreateService } = opts;

  async function createCurrentRequest(tx: any, quotation: any, actorId: string, actionType: string,
    targetType: string, targetId: string, risk: string, details: Record<string, unknown>) {
    const frozen = buildQuotationApprovalSnapshot(quotation, actionType, targetId);
    let documentSnapshot: any = null;
    if (actionType === ACTION_TOTAL_APPROVE && targetType === TARGET_QUOTATION && targetId === quotation.id) {
      await lockQuotationSignDocumentSources(tx, quotation.id);
      documentSnapshot = await buildApprovalSignDocumentSnapshot(tx, { kind: 'Quotation', quotationId: quotation.id });
    }
    const old = await tx.approvalRequest.findFirst({ where: {
      requesterId: actorId, actionType, targetType, targetId, status: 'pending',
    }, orderBy: [{ createdAt:'desc' }, { id:'desc' }] });
    let oldDocumentCurrent = actionType !== ACTION_TOTAL_APPROVE;
    if (old && actionType === ACTION_TOTAL_APPROVE) {
      try {
        const current = await assertCurrentApprovalSignDocumentSnapshot(tx, old);
        oldDocumentCurrent = current.contentFingerprint === documentSnapshot?.contentFingerprint;
      } catch { oldDocumentCurrent = false; }
    }
    if (old && quotationApprovalSourceState(old, quotation) === 'current' && oldDocumentCurrent) return old;
    if (old) {
      // Only this actual requester's stale pending projection is cancelled. Payload,
      // assignment and original timestamps stay intact; no invented decision fact.
      const cancelled = await tx.approvalRequest.updateMany({ where: { id:old.id, status:'pending',
        requesterId:actorId, actionType, targetType, targetId, payload:{equals:old.payload} }, data:{status:'cancelled'} });
      if (cancelled.count !== 1) throw quotationApprovalError('SOURCE_CHANGED');
      await tx.auditLog.create({ data:{id:`alog_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,
        actorId, action:'quotation_approval_superseded',targetType:'ApprovalRequest',targetId:old.id,
        detail:{source:'quotationApproval',quotationId:quotation.id,oldFingerprint:(old.payload as any)?.contentFingerprint ?? null,
          newFingerprint:frozen.contentFingerprint,previousStatus:'pending',status:'cancelled',version:quotation.version},
        operationType:'transition',fieldPath:'status',beforeValue:'pending',afterValue:'cancelled'} });
    }
    const created = await approvalCreateService.createBusinessApproval({client:tx,requesterId:actorId,actionType,targetType,targetId,risk,
      payload:{quotationId:quotation.id,...quotationContext(quotation),...details,...frozen,
        ...(documentSnapshot ? { documentSnapshot } : {})}});
    await tx.auditLog.create({data:{id:`alog_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,
      actorId,action:'request_quotation_approval',targetType:'ApprovalRequest',targetId:created.id,
      detail:{source:'quotationApproval',quotationId:quotation.id,actionType,targetType,targetId,
        contentFingerprint:frozen.contentFingerprint,quotationSnapshot:frozen.quotationSnapshot},operationType:'create'}});
    return created;
  }
  async function lineStates(db: any, quotation: any): Promise<LineApprovalStatus[]> {
    return Promise.all(quotation.lines.map(async (line:any) => {
      const approval = await findApproval(db,ACTION_LINE_APPROVE,TARGET_LINE,line.id);
      return {lineId:line.id,lineNumber:line.lineNumber,status:await readQuotationApprovalState(db,approval,quotation)};
    }));
  }
  async function requestLineApproval(params: {quotationId:string;lineId:string;actorId:string}) {
    return prisma.$transaction(async tx => {
      const quotation = await lockQuotationSource(tx,params.quotationId);
      const line = await tx.quotationLine.findFirst({where:{id:params.lineId,quotationId:params.quotationId}});
      const actual = quotation.lines.find((candidate:any)=>candidate.id===params.lineId);
      if (!line || !actual) throw businessError('NOT_FOUND', '报价条目不存在或不属于该报价单');
      const approval = await createCurrentRequest(tx,quotation,params.actorId,ACTION_LINE_APPROVE,TARGET_LINE,line.id,'medium',{
        lineNumber:actual.lineNumber,fabricCode:actual.fabricCode ?? null,description:actual.description,
        quantity:Number(actual.quantity),unit:actual.unit,unitPrice:Number(actual.unitPrice),amount:Number(actual.amount),
      });
      return {approval,line};
    });
  }
  async function requestTotalApproval(params: {quotationId:string;actorId:string}) {
    return prisma.$transaction(async tx => {
      const quotation = await lockQuotationSource(tx,params.quotationId);
      const lineStatuses = await lineStates(tx,quotation);
      const unapproved = lineStatuses.filter(row=>row.status!=='approved');
      const existingTotal = await findApproval(tx,ACTION_TOTAL_APPROVE,TARGET_QUOTATION,quotation.id);
      const totalState = await readQuotationApprovalState(tx,existingTotal,quotation);
      let approvedDocumentStillCurrent = true;
      if (existingTotal?.status === 'approved') {
        approvedDocumentStillCurrent = false;
        try {
          await lockQuotationSignDocumentSources(tx, quotation.id);
          const frozen = getApprovalSignDocumentSnapshot(existingTotal);
          const current = await buildApprovalSignDocumentSnapshot(tx, { kind: 'Quotation', quotationId: quotation.id });
          approvedDocumentStillCurrent = !!frozen && current.contentFingerprint === frozen.contentFingerprint;
        } catch { approvedDocumentStillCurrent = false; }
      }
      const requiresFreshSignedReview = existingTotal?.status === 'approved' && !approvedDocumentStillCurrent;
      if (totalState === 'approved' && approvedDocumentStillCurrent && existingTotal)
        return {totalApproval:existingTotal,autoApproved:false,lineStatuses,totalStatus:'approved'};
      const approval = await createCurrentRequest(tx,quotation,params.actorId,ACTION_TOTAL_APPROVE,TARGET_QUOTATION,quotation.id,
        'high',{
          totalAmount:Number(quotation.totalAmount),remainingLines:unapproved.map(row=>({lineId:row.lineId,lineNumber:row.lineNumber})),
          hint:requiresFreshSignedReview?'原签署依据缺失或已变化，请重新核对完整报价文件':
            '请确认本版完整报价条件及成本依据；条目审批不能替代整单确认',
        });
      return {totalApproval:approval,autoApproved:false,lineStatuses,totalStatus:approval.status};
    });
  }
  async function getApprovalStatus(params:{quotationId:string}) {
    return prisma.$transaction(async tx => {
      const quotation = await tx.quotation.findFirst({where:{id:params.quotationId,deletedAt:null},
        include:{lines:{orderBy:{lineNumber:'asc'}}}});
      if (!quotation) throw businessError('NOT_FOUND', '报价单不存在');
      const lineStatuses = await lineStates(tx,quotation);
      const total = await findApproval(tx,ACTION_TOTAL_APPROVE,TARGET_QUOTATION,quotation.id);
      const totalState = await readQuotationApprovalState(tx,total,quotation);
      const autoApproved = false; // Line decisions never replace confirmation of the complete version.
      return {quotationId:quotation.id,lineStatuses,
        totalApproval:total?{...total,status:totalState,historicalStatus:total.status}:null,
        autoApproved,totalStatus:total?totalState:autoApproved?'auto-approved':'not-submitted'};
    },{isolationLevel:'RepeatableRead'});
  }
  return { requestLineApproval, requestTotalApproval, getApprovalStatus };
}
export type QuotationApprovalService = ReturnType<typeof createQuotationApprovalService>;
