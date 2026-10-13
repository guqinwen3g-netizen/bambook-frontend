import { describe, expect, it, vi } from 'vitest';
import { createQuotationApprovalService, ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE } from '../quotationApproval';
import { buildQuotationApprovalSnapshot } from '../quotationApprovalSnapshot';

function makeApprovalService(opts: {
  lines?: any[];
  approvals?: any[];
  quotation?: any;
}) {
  const lines = opts.lines ?? [
    { id: 'L1', lineNumber: 1, description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550, fabricCode: 'FAB-A' },
    { id: 'L2', lineNumber: 2, description: 'Fabric B', quantity: 50, unit: 'M', unitPrice: 12, amount: 600, fabricCode: 'FAB-B' },
  ];
  const approvals = opts.approvals ?? [];
  const quotation = opts.quotation ?? {
    id: 'QT_1', quotationNumber: 'QT-001', totalAmount: 1150, deletedAt: null, version:1, currency:'USD', issueDate:'2026-10-01',
    notes: null,
  };
  // Real storage has mandatory currency/version; original business amounts stay unchanged.
  const current = { version:1, currency:'USD', issueDate:'2026-10-01', ...quotation,
    notes: Object.prototype.hasOwnProperty.call(quotation, 'notes') ? quotation.notes : null, lines };
  const rows = approvals.map((row:any,index:number) => {
    const actionType = row.actionType ?? (row.targetType === 'QuotationLine' ? ACTION_LINE_APPROVE : ACTION_TOTAL_APPROVE);
    return { id:'ar_existing_'+index, reviewerId:'R1', decidedAt:new Date('2026-10-02T00:00:00.000Z'), ...row, actionType,
      payload:row.payload ?? {quotationId:current.id,...buildQuotationApprovalSnapshot(current,actionType,row.targetId)} };
  });
  const createBusinessApproval = vi.fn().mockResolvedValue({ id: 'ar_new', status: 'pending' });
  const prisma = {
    quotationLine: { findFirst: vi.fn().mockResolvedValue({ ...lines[0], quotation: current }) },
    quotation: { findFirst: vi.fn().mockResolvedValue(current), findUnique:vi.fn().mockResolvedValue(current) },
    $queryRaw:vi.fn().mockResolvedValue([{id:current.id}]),
    approvalRequest: { findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
      rows.find((a: any) => a.targetType === where.targetType && a.targetId === where.targetId && (!where.actionType || a.actionType === where.actionType) && (!where.status || a.status === where.status)) ?? null),
      findMany:vi.fn().mockImplementation(async({where}:any)=>rows.filter((row:any)=>!where.status || row.status===where.status)),
      updateMany:vi.fn().mockResolvedValue({count:1}) },
    auditLog:{create:vi.fn(),findMany:vi.fn().mockImplementation(async()=>rows.map(row=>({actorId:row.reviewerId,action:row.status==='approved'?'approve_business_request':'reject_business_request',detail:{source:'api:approvals',decisionActorAuthority:{userId:row.reviewerId,roles:[],roleIds:[],authorizationLoaded:true},approvalDecisionFact:{schemaVersion:1,status:row.status,actionType:row.actionType,targetType:row.targetType,targetId:row.targetId,contentFingerprint:row.payload.contentFingerprint,decisionActorId:row.reviewerId,decidedAt:row.decidedAt.toISOString()}}})))},
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  } as any;
  prisma.$queryRawUnsafe = vi.fn().mockResolvedValue([{ id: current.id }]);
  prisma.$transaction=vi.fn(async(fn:any)=>fn(prisma));
  const service = createQuotationApprovalService({
    prisma,
    approvalCreateService: { createBusinessApproval } as any,
  });
  return { service, prisma, createBusinessApproval };
}

describe('quotationApproval: 条目级审批', () => {
  it('requestLineApproval → createBusinessApproval(actionType=line_approve, targetType=QuotationLine, targetId=lineId)', async () => {
    const { service, createBusinessApproval } = makeApprovalService({});
    const result = await service.requestLineApproval({ quotationId: 'QT_1', lineId: 'L1', actorId: 'U1' });
    expect(result.line.id).toBe('L1');
    expect(createBusinessApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterId: 'U1',
        actionType: ACTION_LINE_APPROVE,
        targetType: 'QuotationLine',
        targetId: 'L1',
        payload: expect.objectContaining({ description: 'Fabric A', unitPrice: 5.5 }),
      }),
    );
  });

  it('条目不存在 → NOT_FOUND', async () => {
    const { service, prisma } = makeApprovalService({});
    prisma.quotationLine.findFirst.mockResolvedValue(null);
    await expect(service.requestLineApproval({ quotationId: 'QT_1', lineId: 'GHOST', actorId: 'U1' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('line and total requests freeze actual source context, retaining unknown legacy fields', async () => {
    const quotation = { id:'QT_1', quotationNumber:'QT-NATIVE', customerName:'Actual customer',
      customerRelationId:'REL-A', currency:'USD', version:3, developmentCaseId:'DEV-A', totalAmount:1150, deletedAt:null };
    const {service,createBusinessApproval} = makeApprovalService({quotation});
    await service.requestLineApproval({quotationId:'QT_1',lineId:'L1',actorId:'U1'});
    await service.requestTotalApproval({quotationId:'QT_1',actorId:'U1'});
    for(const call of createBusinessApproval.mock.calls) expect(call[0].payload).toMatchObject({
      quotationNumber:'QT-NATIVE',customerName:'Actual customer',customerRelationId:'REL-A',currency:'USD',version:3,developmentCaseId:'DEV-A',
    });
    quotation.currency='EUR'; quotation.version=4; quotation.customerName='Later customer';
    expect(createBusinessApproval.mock.calls[0][0].payload).toMatchObject({currency:'USD',version:3,customerName:'Actual customer'});
    const legacy=makeApprovalService({});
    await legacy.service.requestLineApproval({quotationId:'QT_1',lineId:'L1',actorId:'U1'});
    expect(legacy.createBusinessApproval.mock.calls[0][0].payload).toMatchObject({
      quotationNumber:'QT-001',customerName:null,customerRelationId:null,currency:'USD',version:1,developmentCaseId:null,
    });
  });
});

describe('quotationApproval: 总价合并规则', () => {
  it('所有条目已批仍必须创建整版确认', async () => {
    const { service, createBusinessApproval } = makeApprovalService({
      approvals: [
        { targetType: 'QuotationLine', targetId: 'L1', status: 'approved' },
        { targetType: 'QuotationLine', targetId: 'L2', status: 'approved' },
      ],
    });
    const result = await service.requestTotalApproval({ quotationId: 'QT_1', actorId: 'U1' });
    expect(result.autoApproved).toBe(false);
    expect(result.totalApproval).toMatchObject({status:'pending'});
    expect(result.totalStatus).toBe('pending');
    expect(createBusinessApproval).toHaveBeenCalled();
  });

  it('有一条未批 → 创建总审批单，remainingLines 含该条，hint=仅剩此条未批', async () => {
    const { service, createBusinessApproval } = makeApprovalService({
      approvals: [
        { targetType: 'QuotationLine', targetId: 'L1', status: 'approved' },
        { targetType: 'QuotationLine', targetId: 'L2', status: 'pending' },
      ],
    });
    const result = await service.requestTotalApproval({ quotationId: 'QT_1', actorId: 'U1' });
    expect(result.autoApproved).toBe(false);
    expect(createBusinessApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_TOTAL_APPROVE,
        targetType: 'Quotation',
        targetId: 'QT_1',
        payload: expect.objectContaining({
          remainingLines: [{ lineId: 'L2', lineNumber: 2 }],
          hint: '请确认本版完整报价条件及成本依据；条目审批不能替代整单确认',
        }),
      }),
    );
    expect(createBusinessApproval.mock.calls[0][0].payload.documentSnapshot).toMatchObject({
      kind: 'Quotation', sourceRef: 'QT_1', sourceIds: ['QT_1'], templateVersion: expect.any(String),
      exactSource: { quotation: { salesperson: null, inquiryRef: null, totalAmount: '1150' } },
    });
  });

  it('多于一条未批 → hint=N 条未批，其余已批', async () => {
    const { service, createBusinessApproval } = makeApprovalService({
      approvals: [
        { targetType: 'QuotationLine', targetId: 'L1', status: 'pending' },
        { targetType: 'QuotationLine', targetId: 'L2', status: 'rejected' },
      ],
    });
    const result = await service.requestTotalApproval({ quotationId: 'QT_1', actorId: 'U1' });
    expect(result.autoApproved).toBe(false);
    const payload = createBusinessApproval.mock.calls[0][0].payload;
    expect(payload.hint).toBe('请确认本版完整报价条件及成本依据；条目审批不能替代整单确认');
    expect(payload.remainingLines).toHaveLength(2);
    expect(result.totalStatus).toBe('pending');
  });
});

describe('quotationApproval: getApprovalStatus', () => {
  it('条目全批不代表整版确认完成', async () => {
    const { service } = makeApprovalService({
      approvals: [
        { targetType: 'QuotationLine', targetId: 'L1', status: 'approved' },
        { targetType: 'QuotationLine', targetId: 'L2', status: 'approved' },
      ],
    });
    const result = await service.getApprovalStatus({ quotationId: 'QT_1' });
    expect(result.autoApproved).toBe(false);
    expect(result.totalStatus).toBe('not-submitted');
    expect(result.lineStatuses.every((s: any) => s.status === 'approved')).toBe(true);
  });

  it('存在未批 → totalStatus=not-submitted（未建总审批单时）', async () => {
    const { service } = makeApprovalService({
      approvals: [
        { targetType: 'QuotationLine', targetId: 'L1', status: 'approved' },
        // L2 未建条目审批单 → 无审批请求（unrequested）
      ],
    });
    const result = await service.getApprovalStatus({ quotationId: 'QT_1' });
    expect(result.totalStatus).toBe('not-submitted');
    expect(result.lineStatuses[1]).toEqual({ lineId: 'L2', lineNumber: 2, status: 'unrequested' });
  });
});
