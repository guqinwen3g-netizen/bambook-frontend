import { buildQuotationApprovalSnapshot, ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE } from '../quotationApprovalSnapshot';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createQuotationService, CreateQuotationInput } from '../quotationService';
import type { QuotationConversionContext } from '../quotationConversionAuthority';
import { businessEventBus } from '../../events/businessEventBus';

/**
 * task ERP-P2-quotation-service-foundation:
 * 覆盖 quotationService 的 CRUD + 状态转换 + 审计 + 事件发布 + fail-closed 契约。
 *
 * 设计：
 *   - 用 $transaction: (fn) => fn(tx) 透明穿透模式，验证 audit reject → 事务回滚
 *   - 所有 mutation 都在事务内写 auditLog，audit reject 必须回滚业务操作
 *   - sendQuotation / acceptQuotation 必须在事务提交后 publish 业务事件（fire-and-forget，永不阻断业务）
 *   - 状态转换严格校验：非法转换抛错（fail-closed）
 */

// ── Mock 信用域（安全修复：convertToOrder 信用门禁）──
// 默认不阻断（blocked:false）；阻断/例外放行用例在 convertToOrder describe 内按需覆写。
const creditMocks = vi.hoisted(() => ({
  checkCreditAvailable: vi.fn(),
  resolveCreditException: vi.fn(),
  consumeCreditException: vi.fn(),
}));
vi.mock('../../credit/creditService', () => ({
  createCreditService: vi.fn(() => ({ checkCreditAvailable: creditMocks.checkCreditAvailable })),
}));
vi.mock('../../credit/creditExceptionGate', () => ({
  createCreditExceptionService: vi.fn(() => ({})),
  resolveCreditException: creditMocks.resolveCreditException,
  consumeCreditException: creditMocks.consumeCreditException,
}));

// ── Mock businessEventBus.publish（fire-and-forget，但需验证调用契约） ──
const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

const conversionScopes = ['quotations:read', 'quotations:write', 'relations:read'];
function verifiedConversion(actorId = 'u_test'): QuotationConversionContext {
  return {mode:'verified_actor',actor:{userId:actorId,roles:['sales'],permissions:[...conversionScopes],permissionCeiling:[...conversionScopes]}};
}
function currentSalesUser(id:string) {
  return {id,status:'active',deletedAt:null,primaryDeptId:null,roles:[{departmentId:null,role:{id:'role-sales',permissions:conversionScopes.map(scope=>({permission:{scope}}))}}]};
}
// ── 工厂：构造 mock prisma + tx ──
// Synthetic storage supplies actual schema-required fields; original amounts/statuses are kept.
function persistedQuotation(row:any) {
  if (!row) return null;
  return {ownerId:'u_test',version:1,currency:'USD',totalAmount:0,issueDate:'2026-10-01',notes:null,...row,
    lines:(row.lines??[]).map((line:any,index:number)=>({id:'fixture-line-'+(index+1),lineNumber:index+1,amount:line.quantity!=null&&line.unitPrice!=null?line.quantity*line.unitPrice:undefined,...line}))};
}
function makePrisma(opts: {
  existing?: any;
  auditFail?: boolean;
  createFail?: boolean;
  updateFail?: boolean;
  quotationFindUniqueImpl?: any;
} = {}) {
  const existing = persistedQuotation(opts.existing);

  const quotationCreate = opts.createFail
    ? vi.fn().mockRejectedValue(new Error('DB_BOOM'))
    : vi.fn().mockImplementation(async ({ data }: any) => {
        const { createdAt, updatedAt, lines, ...rest } = data;
        return {
          ...rest,
          version: rest.version ?? 1,
          createdAt,
          updatedAt,
          lines: lines?.create?.map((l: any, i: number) => ({
            ...l,
            lineNumber: i + 1,
            amount: Math.round(l.quantity * l.unitPrice * 10000) / 10000,
          })) ?? [],
        };
      });

  const quotationUpdate = opts.updateFail
    ? vi.fn().mockRejectedValue(new Error('UPDATE_BOOM'))
    : vi.fn().mockImplementation(async ({ where, data, include }: any) => {
        const { updatedAt, deletedAt, ...rest } = data;
        return {
          ...existing,
          ...rest,
          id: where.id,
          updatedAt,
          lines: existing?.lines ?? [],
        };
      });

  const quotationFindUnique = opts.quotationFindUniqueImpl
    ? opts.quotationFindUniqueImpl
    : vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.id === existing?.id || where.quotationNumber === existing?.quotationNumber) return existing;
        return null;
      });

  const quotationLineDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const quotationLineCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const storedAudits = new Map<string,any>();
  const storedEvents = new Map<string,any>();
  const auditCreate = opts.auditFail
    ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT'))
    : vi.fn().mockImplementation(async ({data}:any) => {const row={id:data.id??'AL-'+(storedAudits.size+1),...data};storedAudits.set(row.id,row);return row;});

  const tx: any = {
    $queryRaw:vi.fn().mockResolvedValue([]),
    quotation: { create: quotationCreate, findUnique:quotationFindUnique, update: quotationUpdate },
    quotationLine: { deleteMany: quotationLineDeleteMany, createMany: quotationLineCreateMany },
    // REQ2-19：Draft 改价自动版本快照（tx 内 append QuotationVersion）
    quotationVersion: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: auditCreate, findUnique:vi.fn(async({where}:any)=>storedAudits.get(where.id)??null) },
    agentJob:{create:vi.fn(async({data}:any)=>{if(storedEvents.has(data.id))throw Object.assign(new Error('duplicate'),{code:'P2002'});storedEvents.set(data.id,{...data});return {...data};}),findUnique:vi.fn(async({where}:any)=>storedEvents.get(where.id)??null)},
    // DR-007：价格审批单不在 tx 内直写（tx 无 approvalRequest；误写会 TypeError 暴露）
    // EntityLink 图谱（D1.1a）：sync/deactivate 走 tx 内 upsert/findMany/update
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const prisma: any = {
    quotation: {
      findUnique: quotationFindUnique,
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: quotationUpdate, // expireQuotation 不用事务，直接调 prisma.quotation.update
    },
    // 双轨偏差：requester 解析（默认命中 owner）+ 发送门禁查询审批状态
    // DR-007 审批单创建通道（approvalCreateService）：事务外 outer prisma 直写，reviewerId 由路由解析
    userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    approvalRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
      // 报价审批层级门禁依赖（2026-09）：默认无 pending，既有发送用例不受影响
      findMany: vi.fn().mockResolvedValue([]),
    },
    // DR-007 路由解析依赖（默认：requester 无部门 → FALLBACK_ADMIN 兜底命中 usr_admin）
    department: { findUnique: vi.fn().mockResolvedValue(null) },
    userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'usr_admin' }]) },
    // §9.2 价格规则 ①②④ 评估依赖（默认空 → 无命中，保持历史用例断言不变）
    relation: { findUnique: vi.fn().mockResolvedValue(null) },
    customerTier: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { count: vi.fn().mockResolvedValue(0) },
    fabricPriceHistory: { findMany: vi.fn().mockResolvedValue([]) },
    productAsset: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  // Finite actual ordinary-role records; source customer follows its stored owner.
  const authorizedIds = new Set(['u_test','u_manual','u_l9','actual-converter',existing?.ownerId].filter(Boolean));
  const requesterFindFirst=prisma.userAccount.findFirst;
  prisma.userAccount.findFirst=vi.fn(async(args:any)=>existing&&args.where?.status==='active'?(authorizedIds.has(args.where.id)?currentSalesUser(args.where.id):null):requesterFindFirst(args));
  prisma.userAccount.findUnique=vi.fn(async({where}:any)=>authorizedIds.has(where.id)?currentSalesUser(where.id):null);
  tx.userAccount={findFirst:vi.fn(async({where}:any)=>authorizedIds.has(where.id)?currentSalesUser(where.id):null),findUnique:prisma.userAccount.findUnique};
  prisma.userPermissionOverrides={findMany:vi.fn().mockResolvedValue([])};
  tx.userPermissionOverrides=prisma.userPermissionOverrides;
  prisma.relation.findFirst=vi.fn(async({where}:any)=>where.id===existing?.customerRelationId?{id:where.id,deletedAt:null,ownerId:existing.ownerId,salesRepIds:['u_manual','u_l9','actual-converter']}:null);
  tx.relation=prisma.relation;
  tx.approvalRequest=prisma.approvalRequest;
  tx.auditLog.findMany=vi.fn().mockResolvedValue([]);
  return { prisma, tx, quotationCreate, quotationUpdate, quotationFindUnique, quotationLineDeleteMany, quotationLineCreateMany, auditCreate };
}

const baseInput: CreateQuotationInput = {
  quotationNumber: 'QT-20260806-001',
  currency: 'USD',
  issueDate: '2026-08-06',
  customerName: 'ACME Corp',
  // §9.2-② 新客首单规则：绑定 Relation 且默认 mock 返回 stage=null（非新客 stage）→ 不命中，保持历史断言口径
  customerRelationId: 'rel_acme',
  lines: [
    { description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5 },
    { description: 'Fabric B', quantity: 50, unit: 'M', unitPrice: 12 },
  ],
};

// MOQ 门禁适配：合法 writeOnce 快照（阈值 50，现有用例数量 100/50/10 中 ≥50 的行合规；
// 数量 <50 的行仍不合规 → 用于门禁阻断/豁免审批路径验证）
const VALID_MOQ_SNAPSHOT = {
  fabricDefaultMoq: 50,
  garmentDefaultMoq: 50,
  capsuleMoq: 10,
  snapshotAt: '2026-08-01T00:00:00.000Z',
  configId: 'MOQCFG__test',
  source: 'moq_config',
};

describe('quotationService: createQuotation', () => {
  beforeEach(() => {
    publishSpy.mockClear();
  });

  it('★ 走查缺陷（真实屏面撞到的）：建单必须把 ownerId 写成当前操作者，否则无客户锚的草稿对创建者永久隐身', async () => {
    // 读侧 `buildQuotationListScopeWhere` 有一条"customerRelationId=null ⇒ 回退 ownerId=me 才可见"的规则
    // （quotationService.ts:244）。走查实测：新建草稿（未选客户）201 成功后，"全部/草稿"两个标签都找不到它，
    // 库里 ownerId=null ⇒ 那条规则依赖的字段从来没被写侧兑现过。本用例钉住"建单即落 owner"。
    const { prisma, quotationCreate } = makePrisma();
    const service = createQuotationService(prisma);
    await service.createQuotation(baseInput, 'usr_walk_prober');
    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.ownerId, '建单未写 ownerId ⇒ 无客户的草稿对自己都不可见').toBe('usr_walk_prober');
  });

  it('成功创建 → 事务内 quotation + lines + audit，totalAmount = 行金额合计', async () => {
    const { prisma, tx, quotationCreate, auditCreate } = makePrisma();
    const service = createQuotationService(prisma);

    const result = await service.createQuotation(baseInput, 'u_test');

    expect(tx.quotation.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(quotationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        quotationNumber: 'QT-20260806-001',
        status: 'Draft',
        currency: 'USD',
        totalAmount: 100 * 5.5 + 50 * 12, // 550 + 600 = 1150
      }),
    }));
    // 行明细 lineNumber 自动递增
    const createCall = quotationCreate.mock.calls[0][0];
    expect(createCall.data.lines.create).toHaveLength(2);
    expect(createCall.data.lines.create[0].lineNumber).toBe(1);
    expect(createCall.data.lines.create[1].lineNumber).toBe(2);
    // 行金额自动计算
    expect(createCall.data.lines.create[0].amount).toBe(550);
    expect(createCall.data.lines.create[1].amount).toBe(600);

    // audit 动作标记
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'create_quotation',
        targetType: 'Quotation',
        actorId: 'u_test',
        operationType: 'create',
      }),
    }));

    // createQuotation 不发布业务事件（仅状态转换才发布）
    expect(publishSpy).not.toHaveBeenCalled();

    expect(result.quotationNumber).toBe('QT-20260806-001');
    expect(result.status).toBe('Draft');
  });

  it('audit reject → 事务回滚（fail-closed，不伪成功）', async () => {
    const { prisma, quotationCreate } = makePrisma({ auditFail: true });
    const service = createQuotationService(prisma);

    await expect(service.createQuotation(baseInput, 'u_test')).rejects.toThrow('AUDIT_REJECT');

    // quotation.create 被调用（在 tx 内），但事务整体回滚
    expect(quotationCreate).toHaveBeenCalledTimes(1);
    // 不发布事件
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('sync reject（quotation.create 抛错）→ 事务回滚，不 audit 不 publish', async () => {
    const { prisma, tx, auditCreate } = makePrisma({ createFail: true });
    const service = createQuotationService(prisma);

    await expect(service.createQuotation(baseInput, 'u_test')).rejects.toThrow('DB_BOOM');

    expect(tx.quotation.create).toHaveBeenCalledTimes(1);
    // audit 不应被调用（tx.quotation.create 已抛错，事务中止）
    expect(auditCreate).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('actorId 为空时使用 system 作为 actor', async () => {
    const { prisma, auditCreate } = makePrisma();
    const service = createQuotationService(prisma);

    await service.createQuotation(baseInput, '');

    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'system' }),
    }));
  });
});

describe('quotationService: updateQuotation', () => {
  beforeEach(() => {
    publishSpy.mockClear();
  });

  it('Draft 状态 → 成功更新（含行明细替换）', async () => {
    const existing = { id: 'QT_1', quotationNumber: 'QT-001', status: 'Draft', deletedAt: null, totalAmount: 100, lines: [] };
    const { prisma, tx, quotationLineDeleteMany, quotationLineCreateMany } = makePrisma({ existing });

    const service = createQuotationService(prisma);
    const result = await service.updateQuotation('QT_1', {
      quotationNumber: 'QT-001-UPDATED',
      lines: [{ description: 'New Fabric', quantity: 10, unit: 'YD', unitPrice: 20 }],
    }, 'u_test');

    expect(tx.quotationLine.deleteMany).toHaveBeenCalledWith({ where: { quotationId: 'QT_1' } });
    expect(tx.quotationLine.createMany).toHaveBeenCalledTimes(1);
    expect(tx.quotation.update).toHaveBeenCalledTimes(1);
    expect(result.quotationNumber).toBe('QT-001-UPDATED');
  });

  it('非 Draft 状态 → 抛错（仅 Draft 可编辑）', async () => {
    const existing = { id: 'QT_1', status: 'Sent', deletedAt: null, lines: [] };
    const { prisma, tx } = makePrisma({ existing });

    const service = createQuotationService(prisma);
    await expect(service.updateQuotation('QT_1', { notes: 'new' }, 'u_test')).rejects.toThrow('仅 Draft 状态可编辑');

    expect(tx.quotation.update).not.toHaveBeenCalled();
  });

  it('报价单不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existing: null });
    const service = createQuotationService(prisma);
    await expect(service.updateQuotation('NOT_EXIST', { notes: 'x' }, 'u_test')).rejects.toThrow('不存在');
  });

  it('已软删除 → 抛错', async () => {
    const existing = { id: 'QT_1', status: 'Draft', deletedAt: 12345, lines: [] };
    const { prisma } = makePrimaWithExisting(existing);
    const service = createQuotationService(prisma);
    await expect(service.updateQuotation('QT_1', { notes: 'x' }, 'u_test')).rejects.toThrow('不存在');
  });
});

// B4：建单/改单返回值附带 moqCheck 行级校验结果（前端表单行级提醒契约；
// mock 环境无 MoqThresholdConfig → buildSnapshot 走兜底常量 800/200/20）
describe('quotationService: MOQ 校验结果随建单/改单返回（B4 表单提醒契约）', () => {
  it('createQuotation：含低于 MOQ 的行 → moqCheck.ok=false + 行级 quantity/effectiveMoq/compliant', async () => {
    const { prisma } = makePrisma();
    const service = createQuotationService(prisma);

    const result = await service.createQuotation(baseInput, 'u_test');

    const moqCheck = (result as any).moqCheck;
    expect(moqCheck).toBeTruthy();
    expect(moqCheck.ok).toBe(false); // 100/50 < 兜底 800（YD/M 归 fabric 族）
    expect(moqCheck.blockedLineIndexes).toEqual([0, 1]);
    expect(moqCheck.lines).toHaveLength(2);
    expect(moqCheck.lines[0]).toEqual(expect.objectContaining({
      lineIndex: 0,
      quantity: 100,
      unit: 'YD',
      effectiveMoq: 800,
      compliant: false,
    }));
    expect(moqCheck.lines[1]).toEqual(expect.objectContaining({
      lineIndex: 1,
      quantity: 50,
      unit: 'M',
      effectiveMoq: 800,
      compliant: false,
    }));
    // advisory：不阻断创建，报价单仍落库为 Draft
    expect(result.status).toBe('Draft');
  });

  it('createQuotation：全部行达标 → moqCheck.ok=true、无阻断行', async () => {
    const { prisma } = makePrisma();
    const service = createQuotationService(prisma);

    const result = await service.createQuotation({
      ...baseInput,
      lines: [{ description: 'Fabric A', quantity: 1000, unit: 'YD', unitPrice: 5.5 }],
    }, 'u_test');

    const moqCheck = (result as any).moqCheck;
    expect(moqCheck).toBeTruthy();
    expect(moqCheck.ok).toBe(true);
    expect(moqCheck.blockedLineIndexes).toEqual([]);
    expect(moqCheck.lines[0]).toEqual(expect.objectContaining({ compliant: true, effectiveMoq: 800 }));
  });

  it('updateQuotation：行变更后低于 MOQ → moqCheck.ok=false + 行级结果随返回值带出', async () => {
    const existing = { id: 'QT_1', quotationNumber: 'QT-001', status: 'Draft', deletedAt: null, totalAmount: 100, lines: [] };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.updateQuotation('QT_1', {
      lines: [{ description: 'New Fabric', quantity: 10, unit: 'YD', unitPrice: 20 }],
    }, 'u_test');

    const moqCheck = (result as any).moqCheck;
    expect(moqCheck).toBeTruthy();
    expect(moqCheck.ok).toBe(false);
    expect(moqCheck.blockedLineIndexes).toEqual([0]);
    expect(moqCheck.lines[0]).toEqual(expect.objectContaining({
      lineIndex: 0,
      quantity: 10,
      effectiveMoq: 800,
      compliant: false,
    }));
  });
});

describe('quotationService: deleteQuotation (soft delete)', () => {
  it('Draft 状态 → 软删除（设置 deletedAt）', async () => {
    const existing = { id: 'QT_1', status: 'Draft', deletedAt: null, quotationNumber: 'QT-001' };
    const { prisma, tx } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    await service.deleteQuotation('QT_1', 'u_test');

    expect(tx.quotation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'QT_1' },
      data: expect.objectContaining({ deletedAt: expect.any(Number) }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'delete_quotation' }),
    }));
  });

  it('非 Draft 状态 → 抛错', async () => {
    const existing = { id: 'QT_1', status: 'Sent', deletedAt: null, quotationNumber: 'QT-001' };
    const { prisma, tx } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    await expect(service.deleteQuotation('QT_1', 'u_test')).rejects.toThrow('仅 Draft 状态可删除');
    expect(tx.quotation.update).not.toHaveBeenCalled();
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existing: null });
    const service = createQuotationService(prisma);
    await expect(service.deleteQuotation('NOPE', 'u_test')).rejects.toThrow('不存在');
  });
});

describe('quotationService: sendQuotation (Draft → Sent)', () => {
  beforeEach(() => {
    publishSpy.mockClear();
  });

  it('Draft → Sent 成功，发布 QuotationIssued 事件', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Draft',
      deletedAt: null,
      customerName: 'ACME',
      customerRelationId: 'REL_1',
      totalAmount: 1150,
      currency: 'USD',
      moqSnapshot: VALID_MOQ_SNAPSHOT, // MOQ 门禁：100/50 ≥ 50 → 合规放行
      lines: [{ id: 'L1', fabricCode: null, description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount:550 }],
    };
    const { prisma, tx } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.sendQuotation('QT_1', 'u_test');

    expect(tx.quotation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Sent' }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'send_quotation',
        beforeValue: 'Draft',
        afterValue: 'Sent',
      }),
    }));

    // 事件在事务后发布
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('QuotationIssued');
    expect(event.sourceEntityType).toBe('Quotation');
    expect(event.sourceEntityId).toBe('QT_1');
    expect(event.payload).toEqual(expect.objectContaining({
      quotationNumber: 'QT-001',
      customerName: 'ACME',
      totalAmount: 1150,
      currency: 'USD',
      lineCount: 1,
    }));

    expect(result.status).toBe('Sent');
  });

  it('Sent 状态 → 非法转换抛错（Sent 不能再 send）', async () => {
    const existing = { id: 'QT_1', status: 'Sent', deletedAt: null, lines: [] };
    const { prisma, tx } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    await expect(service.sendQuotation('QT_1', 'u_test')).rejects.toThrow('非法状态转换');
    expect(tx.quotation.update).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('Accepted 终态 → 非法转换抛错', async () => {
    const existing = { id: 'QT_1', status: 'Accepted', deletedAt: null, lines: [] };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    await expect(service.sendQuotation('QT_1', 'u_test')).rejects.toThrow('非法状态转换');
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existing: null });
    const service = createQuotationService(prisma);
    await expect(service.sendQuotation('NOPE', 'u_test')).rejects.toThrow('不存在');
  });

  it('事件发布失败不阻断业务（fire-and-forget）', async () => {
    const existing = { id: 'QT_1', status: 'Draft', deletedAt: null, lines: [{id:'L1',lineNumber:1,description:'Fabric',quantity:10000,unit:'M',unitPrice:0.01,amount:100}], quotationNumber: 'QT-001', totalAmount: 100, currency: 'USD' };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    // 让 publish 抛错
    publishSpy.mockRejectedValueOnce(new Error('EVENT_PERSIST_FAIL'));

    // 业务操作仍然成功
    const result = await service.sendQuotation('QT_1', 'u_test');
    expect(result.status).toBe('Sent');
  });
});

describe('quotationService: acceptQuotation (Sent → Accepted)', () => {
  beforeEach(() => {
    publishSpy.mockClear();
  });

  it('Sent → Accepted 成功，发布 QuotationAccepted 事件（含行明细 payload）', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Sent',
      deletedAt: null,
      customerName: 'ACME',
      totalAmount: 1150,
      currency: 'USD',
      lines: [
        { id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5 },
      ],
    };
    const { prisma, tx } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.acceptQuotation('QT_1', 'u_test', '客户已确认', verifiedConversion('u_test'));

    expect(tx.quotation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Accepted' }),
    }));

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('QuotationAccepted');
    expect(event.payload).toEqual(expect.objectContaining({
      quotationNumber: 'QT-001',
      lines: expect.arrayContaining([
        expect.objectContaining({ description: 'Fabric A', quantity: '100', unitPrice: '5.5', amount: '550' }),
      ]),
    }));

    const persistedJob=await tx.agentJob.findUnique({where:{id:event.id}});
    expect(persistedJob).toMatchObject({id:event.id,jobType:'bev:QuotationAccepted',status:'queued',payload:event});
    const delegation=(event.payload as any).conversionDelegation;
    expect(delegation).toMatchObject({actorId:'u_test',quotationId:'QT_1',eventId:event.id,permissionCeiling:conversionScopes});
    const audit=await tx.auditLog.findUnique({where:{id:delegation.auditId}});
    expect(audit).toMatchObject({id:delegation.auditId,action:'accept_quotation',actorId:'u_test',targetId:'QT_1',beforeValue:'Sent',afterValue:'Accepted',detail:{conversionDelegation:delegation}});
    expect(audit.createdAt.getTime()).toBe(event.occurredAt);
    expect(tx.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(tx.agentJob.create.mock.invocationCallOrder[0]);
    expect(tx.agentJob.create.mock.invocationCallOrder[0]).toBeLessThan(publishSpy.mock.invocationCallOrder[0]);
    expect(result.status).toBe('Accepted');
  });

  it('Draft 状态 → 非法转换抛错（Draft 不能直接 accept）', async () => {
    const existing = { id: 'QT_1', status: 'Draft', deletedAt: null, lines: [] };
    const { prisma, tx } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    await expect(service.acceptQuotation('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('非法状态转换');
    expect(tx.quotation.update).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('Accepted 终态 → 非法转换抛错', async () => {
    const existing = { id: 'QT_1', status: 'Accepted', deletedAt: null, lines: [] };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    await expect(service.acceptQuotation('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('非法状态转换');
  });
});

describe('quotationService: rejectQuotation (Sent → Rejected)', () => {
  beforeEach(() => {
    publishSpy.mockClear();
  });

  it('Sent → Rejected 成功', async () => {
    const existing = { id: 'QT_1', quotationNumber: 'QT-001', status: 'Sent', deletedAt: null };
    const { prisma, tx } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.rejectQuotation('QT_1', 'u_test', '价格过高');

    expect(tx.quotation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Rejected' }),
    }));
    // reject 不发布业务事件
    expect(publishSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('Rejected');
  });

  it('Draft 状态 → 非法转换抛错', async () => {
    const existing = { id: 'QT_1', status: 'Draft', deletedAt: null };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    await expect(service.rejectQuotation('QT_1', 'u_test')).rejects.toThrow('非法状态转换');
  });
});

describe('quotationService: expireQuotation', () => {
  it('Draft → Expired 成功', async () => {
    const existing = { id: 'QT_1', status: 'Draft', deletedAt: null };
    const { prisma, quotationUpdate } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.expireQuotation('QT_1', 'u_test');

    // expireQuotation 不用事务，直接调 prisma.quotation.update
    expect(quotationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Expired' }),
    }));
    expect(result.status).toBe('Expired');
  });

  it('Sent → Expired 成功', async () => {
    const existing = { id: 'QT_1', status: 'Sent', deletedAt: null };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    const result = await service.expireQuotation('QT_1', 'u_test');
    expect(result.status).toBe('Expired');
  });

  it('Accepted 终态 → 抛错（不可标记过期）', async () => {
    const existing = { id: 'QT_1', status: 'Accepted', deletedAt: null };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    await expect(service.expireQuotation('QT_1', 'u_test')).rejects.toThrow('不可标记过期');
  });

  it('Rejected 终态 → 抛错', async () => {
    const existing = { id: 'QT_1', status: 'Rejected', deletedAt: null };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);
    await expect(service.expireQuotation('QT_1', 'u_test')).rejects.toThrow('不可标记过期');
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existing: null });
    const service = createQuotationService(prisma);
    await expect(service.expireQuotation('NOPE', 'u_test')).rejects.toThrow('不存在');
  });
});

describe('quotationService: listQuotations', () => {
  it('返回列表 + total（默认 deletedAt: null 过滤）', async () => {
    const items = [{ id: 'QT_1' }, { id: 'QT_2' }];
    const { prisma } = makePrimaWithListResult(items, 2);
    const service = createQuotationService(prisma);

    const result = await service.listQuotations({});

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('status 过滤 → where.status 传入', async () => {
    const { prisma, quotationFindManySpy } = makePrimaWithListResult([], 0);
    const service = createQuotationService(prisma);

    await service.listQuotations({ status: 'Sent' });

    expect(quotationFindManySpy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'Sent', deletedAt: null }),
    }));
  });

  it('search 过滤 → where.OR 包含 quotationNumber/customerName/inquiryRef', async () => {
    const { prisma, quotationFindManySpy } = makePrimaWithListResult([], 0);
    const service = createQuotationService(prisma);

    await service.listQuotations({ search: 'ACME' });

    expect(quotationFindManySpy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { quotationNumber: { contains: 'ACME' } },
          { customerName: { contains: 'ACME' } },
          { inquiryRef: { contains: 'ACME' } },
        ]),
      }),
    }));
  });

  it('limit 上限 200', async () => {
    const { prisma, quotationFindManySpy } = makePrimaWithListResult([], 0);
    const service = createQuotationService(prisma);

    await service.listQuotations({ limit: 500 });

    expect(quotationFindManySpy).toHaveBeenCalledWith(expect.objectContaining({
      take: 200,
    }));
  });
});

describe('quotationService: getQuotation', () => {
  it('返回含行明细的报价单', async () => {
    const existing = { id: 'QT_1', deletedAt: null, lines: [{ id: 'L1' }] };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.getQuotation('QT_1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('QT_1');
  });

  it('已软删除 → 返回 null', async () => {
    const existing = { id: 'QT_1', deletedAt: 12345 };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.getQuotation('QT_1');
    expect(result).toBeNull();
  });

  it('不存在 → 返回 null', async () => {
    const { prisma } = makePrisma({ existing: null });
    const service = createQuotationService(prisma);

    const result = await service.getQuotation('NOPE');
    expect(result).toBeNull();
  });
});

describe('quotationService: convertToOrder (Accepted → Order)', () => {
  beforeEach(() => {
    publishSpy.mockClear();
    // 信用门禁默认放行（不受限客户）；阻断/例外用例各自覆写
    creditMocks.checkCreditAvailable.mockReset();
    creditMocks.checkCreditAvailable.mockResolvedValue({ ok: true, data: { blocked: false, blockCode: null, blockReason: null } });
    creditMocks.resolveCreditException.mockReset();
    creditMocks.resolveCreditException.mockResolvedValue({ passed: false, hint: '审批中' });
    creditMocks.consumeCreditException.mockReset();
    creditMocks.consumeCreditException.mockResolvedValue(undefined);
  });

  it('转单继承真实报价负责人/开发案，多个部门不猜首项；没有隐式确认来源',async()=>{
    const existing={id:'QT_CTX',quotationNumber:'QT-CTX',status:'Accepted',deletedAt:null,convertedOrderId:null,customerRelationId:'REL-CTX',ownerId:'actual-source-owner',developmentCaseId:'DEV-CTX',currency:'USD',totalAmount:1000,moqSnapshot:VALID_MOQ_SNAPSHOT,lines:[{id:'L-CTX',description:'Garment',quantity:200,unit:'PC',unitPrice:5,amount:1000}]};
    const {prisma,tx}=makePrismaWithConvertSupport({existing});
    tx.userAccount.findFirst.mockImplementation(async({where}:any)=>where.id===existing.ownerId?{...currentSalesUser(where.id),roles:[{departmentId:'A'},{departmentId:'B'}]}:currentSalesUser(where.id));
    await createQuotationService(prisma).convertToOrder(existing.id, 'actual-converter', undefined, verifiedConversion('actual-converter'));
    expect(tx.order.create.mock.calls[0][0].data).toMatchObject({ownerId:'actual-source-owner',departmentId:null,sourceCaseId:'DEV-CTX'});
    expect(tx.developmentCase.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:'DEV-CTX',deletedAt:null}}));
    const line=tx.order.create.mock.calls[0][0].data.lines.create[0];
    for(const key of ['confirmedSourceId','confirmedSourceType','confirmedAt','confirmedBy','specSnapshot'])expect(line[key]).toBeUndefined();
  });

  it('Accepted 报价单 → 成功转为订单（含订单行 + convertedOrderId + 双审计日志）', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME Corp',
      customerCode: 'C001',
      customerRelationId: 'REL_1',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 1150,
      validUntil: '2026-09-30',
      deliveryTerms: 'FOB Shanghai',
      paymentTerms: 'T/T 30%',
      moqSnapshot: VALID_MOQ_SNAPSHOT, // MOQ 转换门禁：100/50 ≥ 50 → 合规放行
      lines: [
        { id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550 },
        { id: 'L2', fabricCode: 'FAB-B', description: 'Fabric B', quantity: 50, unit: 'M', unitPrice: 12, amount: 600 },
      ],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    const result = await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));

    // 信用门禁按报价金额+客户关系校验（安全修复：转单不再旁路建单门禁）
    expect(creditMocks.checkCreditAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ relationId: 'REL_1', amount: 1150 }),
    );

    // 订单创建
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    const orderCreateCall = tx.order.create.mock.calls[0][0];
    expect(orderCreateCall.data.customer).toBe('ACME Corp');
    expect(orderCreateCall.data.poNumber).toBe('QT-001'); // 默认用报价号
    expect(orderCreateCall.data.status).toBe('Pending');
    expect(orderCreateCall.data.source).toBe('quotation-convert');
    expect(orderCreateCall.data.quoteAmount).toBe(1150);
    expect(orderCreateCall.data.salesCurrency).toBe('USD');
    expect(orderCreateCall.data.purchaseCurrency).toBe('CNY');
    // 订单行从报价行映射
    expect(orderCreateCall.data.lines.create).toHaveLength(2);
    expect(orderCreateCall.data.lines.create[0]).toEqual(expect.objectContaining({
      materialCode: 'FAB-A',
      description: 'Fabric A',
      quantity: 100,
      unit: 'YD',
      unitPrice: 5.5,
      netValue: 550,
      status: 'Pending',
    }));

    // 报价单原子认领 convertedOrderId（防 L9/手动并发双建单）
    expect(tx.quotation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'QT_1', convertedOrderId: null }),
      data: expect.objectContaining({ convertedOrderId: expect.stringMatching(/^ORD-QT-/) }),
    }));

    // 双审计日志
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    const auditActions = tx.auditLog.create.mock.calls.map((c: any) => c[0].data.action);
    expect(auditActions).toContain('convert_quotation_to_order');
    expect(auditActions).toContain('create_order_from_quotation');

    expect(result.orderId).toMatch(/^ORD-QT-/);
    expect(result.quotation.convertedOrderId).toBe(result.orderId);

    // 无定价记录的旧报价允许转单；成本关联只更新本报价、未删且尚未挂单的记录。
    // 此处验证事务内调用契约，不将 Mock 的 count=0 当作真实数据库查询证据。
    expect(tx.pricingCalculation.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.pricingCalculation.updateMany).toHaveBeenCalledWith({
      where: { quotationId: 'QT_1', deletedAt: null, orderId: null },
      data: { orderId: result.orderId },
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // A19（§9 B51 / 拍板件 §2.2）：付款方式必须在跨层边界上活下来
  // ════════════════════════════════════════════════════════════════════
  // 病根：convertToOrder 原先拷 `paymentTerms`（自由文本）**不拷 `paymentInstrument`**
  //   ⇒ 订单该列恒 null ⇒ `isLcInstrument(null)=false` ⇒ L/C 门禁对**整条报价转单路径**
  //   判 `via='not-applicable'` 放行 = 100% 免检（fail-open）。
  // ★ 这三条**改前必须红**（第 1、2 条红在 `undefined !== 'L/C'`；第 3 条是防"凭空造值"的反面对照）。

  const baseExistingWithInstrument = (instrument: string | null) => ({
    id: 'QT_1',
    quotationNumber: 'QT-001',
    status: 'Accepted',
    deletedAt: null,
    convertedOrderId: null,
    customerName: 'ACME Corp',
    customerCode: 'C001',
    customerRelationId: 'REL_1',
    currency: 'USD',
    baseCurrency: 'CNY',
    totalAmount: 550,
    validUntil: '2026-09-30',
    deliveryTerms: 'FOB Shanghai',
    paymentTerms: 'T/T 30%',
    paymentInstrument: instrument,
    moqSnapshot: VALID_MOQ_SNAPSHOT,
    lines: [{ id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550 }],
  });

  it('★ A19：报价单录了 L/C ⇒ 订单必须继承 paymentInstrument（否则门禁 100% 免检）', async () => {
    const { prisma, tx } = makePrismaWithConvertSupport({ existing: baseExistingWithInstrument('L/C') });
    const service = createQuotationService(prisma);

    await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));

    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.paymentInstrument).toBe('L/C');
    // 反面对照：老的自由文本列**照旧**要拷（不许因为加了新列就把老的丢了）
    expect(data.paymentTerms).toBe('T/T 30%');
  });

  it('★ A19：overrides.paymentInstrument 覆盖报价单的值（转单界面要能改）', async () => {
    const { prisma, tx } = makePrismaWithConvertSupport({ existing: baseExistingWithInstrument('L/C') });
    const service = createQuotationService(prisma);

    await service.convertToOrder('QT_1', 'u_test', { paymentInstrument: 'T/T' }, verifiedConversion('u_test'));

    expect(tx.order.create.mock.calls[0][0].data.paymentInstrument).toBe('T/T');
  });

  it('★ A19 反面对照：报价单未录（null）⇒ 订单也是 null，**不许凭空造一个值**', async () => {
    const { prisma, tx } = makePrismaWithConvertSupport({ existing: baseExistingWithInstrument(null) });
    const service = createQuotationService(prisma);

    await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));

    // 「未录」= 不知道 ⇒ 必须原样传下去（门禁据此走第三分支 LC_INSTRUMENT_NOT_RECORDED）；
    // 若这里被兜底成 'T/T'，就是把「不知道」伪造成「非信用证」= 拍板件明令禁止的形状。
    expect(tx.order.create.mock.calls[0][0].data.paymentInstrument).toBeNull();
  });

  it('原子认领失败（convertedOrderId 已被并发方占位）→ 抛「已转为订单」且不建单（双建单回归）', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME Corp',
      customerRelationId: 'REL_1',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 550,
      validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [{ id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550 }],
    };
    const { prisma, tx, quotationClaim } = makePrismaWithConvertSupport({ existing });
    // 模拟 L9 联动已先行认领成功（count=0 = 谓词重估后无行可更）
    quotationClaim.mockResolvedValue({ count: 0 });
    const service = createQuotationService(prisma);

    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('已转为订单');
    // 认领失败必须发生在 order.create 之前（否则并发双单）
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  // 保留历史标题供失败逐项追踪；本用例实际是 Mock 顺序重试，真 PG 并发另验。
  it('L9 联动与手动转单竞态：认领只有一方成功 → 仅建一单', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME Corp',
      customerRelationId: 'REL_1',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 550,
      validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [{ id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550 }],
    };
    const { prisma, orderCreate, quotationClaim } = makePrismaWithConvertSupport({ existing });
    // 有状态 Mock 认领仅第一次成功；下面两次调用是顺序执行，不复现 PG 行锁竞争。
    let claimed = false;
    quotationClaim.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    const service = createQuotationService(prisma);

    const first = await service.convertToOrder('QT_1', 'u_manual', { poNumber: 'PO-MANUAL' }, verifiedConversion('u_manual'));
    await expect(service.convertToOrder('QT_1', 'u_l9', undefined, verifiedConversion('u_l9'))).rejects.toThrow('已转为订单');

    expect(orderCreate).toHaveBeenCalledTimes(1);
    expect(orderCreate.mock.calls[0][0].data.poNumber).toBe('PO-MANUAL'); // 认领赢家写入
    expect(first.orderId).toMatch(/^ORD-QT-/);
  });

  it('G1-2：转单时报价行 notes 随订单行带入，notes/moqOverride 缺失兜底 null', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME Corp',
      customerRelationId: 'REL_1',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 1150,
      validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [
        // 注：报价行带 moqOverride 值会在 MOQ 门禁先触发 moq:line_override 授权检查（先于映射），
        // 故这里用纯 notes 值用例 + 无字段行兜底 null，验证映射/兜底逻辑本身。
        { id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550, notes: '偏深蓝' },
        { id: 'L2', fabricCode: 'FAB-B', description: 'Fabric B', quantity: 50, unit: 'M', unitPrice: 12, amount: 600 },
      ],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    const result = await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));

    const createdLines = tx.order.create.mock.calls[0][0].data.lines.create;
    expect(createdLines).toHaveLength(2);
    // 报价行 notes 已带入
    expect(createdLines[0]).toEqual(expect.objectContaining({ notes: '偏深蓝' }));
    // 缺失字段兜底为 null（不因缺少字段而落到 undefined 报错）
    expect(createdLines[1]).toEqual(expect.objectContaining({ notes: null, moqOverride: null }));
    // 既有字段映射不受影响
    expect(createdLines[0]).toEqual(expect.objectContaining({ materialCode: 'FAB-A', netValue: 550, status: 'Pending' }));
    expect(result.orderId).toMatch(/^ORD-QT-/);
  });

  it('报价审批门禁：存在 pending 条目/总价审批 → 阻断转单 QUOTATION_APPROVAL_PENDING', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME Corp',
      customerRelationId: 'REL_1',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 1150,
      validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [
        { id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550 },
        { id: 'L2', fabricCode: 'FAB-B', description: 'Fabric B', quantity: 50, unit: 'M', unitPrice: 12, amount: 600 },
      ],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    (prisma as any).approvalRequest.findMany.mockResolvedValue([
      { id:'ar_total_p',actionType:ACTION_TOTAL_APPROVE,targetType:'Quotation',targetId:'QT_1',status:'pending',
        payload:{quotationId:'QT_1',...buildQuotationApprovalSnapshot(persistedQuotation(existing),ACTION_TOTAL_APPROVE,'QT_1')} },
    ]);
    const service = createQuotationService(prisma);

    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('quotation-approval');
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('转单初始化 10 阶段生产管线（2026-09-03 审计 P2：Pending 期管线不再空）', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME Corp',
      customerRelationId: 'REL_1',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 550,
      validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [{ id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550 }],
    };
    const { prisma, tx, productionStageUpsert } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    const result = await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));

    // 与 V1 手动建单（orders/route.ts）同口径：10 阶段幂等 upsert
    expect(productionStageUpsert).toHaveBeenCalled();
    const upsertCalls = productionStageUpsert.mock.calls.map((c: any) => c[0]);
    expect(upsertCalls).toHaveLength(10);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.productionStage.upsert).toBe(productionStageUpsert);
    expect(prisma.productionStage.upsert).not.toHaveBeenCalled();
    for (const call of upsertCalls) {
      expect(call.where.orderId_stageKey.orderId).toBe(result.orderId);
      expect(call.update).toEqual({}); // 幂等：重复触发无副作用
    }
  });

  it('阶段初始化 SQL 故障拒绝整个转单事务，不返回成功或事务外补写', async () => {
    const existing = {
      id: 'QT_STAGE_FAULT', quotationNumber: 'QT-STAGE-FAULT', status: 'Accepted',
      deletedAt: null, convertedOrderId: null, customerName: 'ACME',
      customerRelationId: 'REL_1', currency: 'USD', baseCurrency: 'CNY',
      totalAmount: 550, validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [{ id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550 }],
    };
    const { prisma, tx, productionStageUpsert, quotationClaim } = makePrismaWithConvertSupport({ existing });
    const failure = Object.assign(new Error('MANDATORY_STAGE_SQL_FAILURE'), { code: 'P2010' });
    productionStageUpsert.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(failure);

    await expect(createQuotationService(prisma).convertToOrder(existing.id, 'u_test', undefined, verifiedConversion('u_test'))).rejects.toBe(failure);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // These writes share the rejected callback; actual DB rollback is verified separately in private PG.
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(quotationClaim).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(productionStageUpsert).toHaveBeenCalledTimes(3);
    expect(prisma.productionStage.upsert).not.toHaveBeenCalled();
  });

  it('支持 overrides（poNumber / millName / type / dueDate）', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 500,
      validUntil: '2026-09-30',
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 }, // MOQ 门禁：10 ≥ 10 → 合规放行
      lines: [{ id: 'L1', fabricCode: null, description: 'x', quantity: 10, unit: 'M', unitPrice: 50, amount: 500 }],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    await service.convertToOrder('QT_1', 'u_test', {
      poNumber: 'PO-CUSTOM-001',
      millName: 'Mill A',
      type: 'Garment',
      dueDate: '2026-10-15',
    }, verifiedConversion('u_test'));

    const orderData = tx.order.create.mock.calls[0][0].data;
    expect(orderData.poNumber).toBe('PO-CUSTOM-001');
    expect(orderData.millName).toBe('Mill A');
    expect(orderData.type).toBe('Garment');
    expect(orderData.dueDate).toBe('2026-10-15');
  });

  it.each(['PC', 'PCS'])('未指定 type 时单一 %s 单位行 → Garment', async (unit) => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-GAR-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 1000,
      validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT, // garment MOQ 50；行数量 100/60 ≥ 50 → 合规放行
      lines: [
        { id: 'L1', fabricCode: 'STY-A', description: 'Shirt A', quantity: 100, unit, unitPrice: 5, amount: 500 },
        { id: 'L2', fabricCode: 'STY-B', description: 'Shirt B', quantity: 60, unit, unitPrice: 5, amount: 300 },
      ],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));
    expect(tx.order.create.mock.calls[0][0].data.type).toBe('Garment');
  });

  it('未指定 type 时按行单位推导：面料族单位（M）→ Fabric', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-FAB-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 500,
      validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [{ id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'M', unitPrice: 5, amount: 500 }],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));
    expect(tx.order.create.mock.calls[0][0].data.type).toBe('Fabric');
  });

  it.each([['PC', 'KG'], ['PC', 'SET']])('MOQ 口径无法跨 %s/%s 单位核对时，转单 fail-closed', async (unitA, unitB) => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-MIX-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      currency: 'USD',
      baseCurrency: 'CNY',
      totalAmount: 1000,
      validUntil: '2026-09-30',
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [
        { id: 'L1', fabricCode: 'STY-A', description: 'Shirt A', quantity: 100, unit: unitA, unitPrice: 5, amount: 500 },
        { id: 'L2', fabricCode: 'FAB-B', description: 'Fabric B', quantity: 100, unit: unitB, unitPrice: 5, amount: 500 },
      ],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow(/MOQ|单位/);
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.quotation.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.productionStage.upsert).not.toHaveBeenCalled();
  });

  it('同一可比维度的 M/YD 报价可逐行转单，不伪造跨单位表头合计', async () => {
    const existing={id:'QT_1',quotationNumber:'QT-MIX-LENGTH',status:'Accepted',deletedAt:null,convertedOrderId:null,customerName:'ACME',currency:'USD',baseCurrency:'CNY',totalAmount:1103.125,validUntil:'2026-09-30',moqSnapshot:VALID_MOQ_SNAPSHOT,lines:[
      {id:'L1',fabricCode:'FAB-A',description:'Fabric A',quantity:'100.125',unit:'M',unitPrice:5,amount:500.625},
      {id:'L2',fabricCode:'FAB-B',description:'Fabric B',quantity:'120.5',unit:'YD',unitPrice:5,amount:602.5},
    ]};
    const {prisma,tx}=makePrismaWithConvertSupport({existing});
    await createQuotationService(prisma).convertToOrder('QT_1','u_test',undefined,verifiedConversion('u_test'));
    const data=tx.order.create.mock.calls[0][0].data;
    expect(data.quantity).toBeNull();expect(data.unit).toBeNull();
    expect(data.lines.create.map((line:any)=>[String(line.quantity),line.unit])).toEqual([['100.125','M'],['120.5','YD']]);
  });

  it('非 Accepted 状态 → 抛错（仅 Accepted 可转）', async () => {
    const existing = { id: 'QT_1', status: 'Sent', deletedAt: null, convertedOrderId: null, lines: [] };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);
    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('仅 Accepted');
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('已转换过 → 抛错（不可重复转换）', async () => {
    const existing = { id: 'QT_1', status: 'Accepted', deletedAt: null, convertedOrderId: 'ORD-QT-EXISTING', lines: [] };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);
    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('已转为订单');
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existing: null });
    const service = createQuotationService(prisma);
    await expect(service.convertToOrder('NOPE', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('不存在');
  });

  // 保留历史标题；本用例只证明事务内错误冒泡，真实 PG 持久化回滚另验。
  it('audit reject → 事务回滚（订单和报价单标记都不生效）', async () => {
    const existing = {
      id: 'QT_1',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      currency: 'USD',
      totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 }, // MOQ 门禁：10 ≥ 10 → 合规放行，让 audit reject 发生在事务内
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing, auditFail: true });
    const service = createQuotationService(prisma);

    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('AUDIT_REJECT');
    // 这里只证明 Mock 事务内建单调用已发生且审计错误不被吞掉；不证明持久化回滚。
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('定价成本关联失败 → 转单失败，不进入审计或事务后生产阶段初始化', async () => {
    const { prisma, tx, productionStageUpsert } = makePrismaWithConvertSupport({
      existing: baseExistingWithInstrument(null),
    });
    tx.pricingCalculation.updateMany.mockRejectedValue(new Error('PRICING_LINK_FAILED'));
    const service = createQuotationService(prisma);

    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toThrow('PRICING_LINK_FAILED');
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(productionStageUpsert).not.toHaveBeenCalled();
    // 建单调用记录不能证明订单被提交或回滚；真实 PG 原子性由独立用例验证。
  });

  // ── 信用门禁（安全修复：报价转单旁路建单门禁的回归锁）──

  it('信用门禁 blocked + 无生效例外 → CREDIT_BLOCKED 抛错，不创建订单', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      customerRelationId: 'REL_1',
      currency: 'USD',
      totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    creditMocks.checkCreditAvailable.mockResolvedValue({
      ok: true,
      data: { blocked: true, blockCode: 'CREDIT_FROZEN_60_DAYS', blockReason: '该客户信用额度已冻结' },
    });
    creditMocks.resolveCreditException.mockResolvedValue({ passed: false, hint: '已自动发起信用例外申请，审批通过后重试' });

    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toMatchObject({code:'CREDIT_FROZEN_60_DAYS'});
    const err = await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test')).catch((e: any) => e);
    expect(err.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(err.statusCode).toBe(409);
    // 例外裁决按 Relation + order:create 口径（与 V2 建单门禁互通）
    expect(creditMocks.resolveCreditException).toHaveBeenCalledWith(expect.objectContaining({
      scope: { targetType: 'Relation', targetId: 'REL_1', action: 'order:create' },
    }));
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(creditMocks.consumeCreditException).not.toHaveBeenCalled();
  });

  it('信用门禁 blocked + 生效例外 → 放行转单并在成功后核销例外', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      customerRelationId: 'REL_1',
      currency: 'USD',
      totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    creditMocks.checkCreditAvailable.mockResolvedValue({
      ok: true,
      data: { blocked: true, blockCode: 'CREDIT_FROZEN_60_DAYS', blockReason: '该客户信用额度已冻结' },
    });
    creditMocks.resolveCreditException.mockResolvedValue({ passed: true, exception: { id: 'EXC_1' } });

    const result = await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));
    expect(result.orderId).toMatch(/^ORD-QT-/);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(creditMocks.consumeCreditException).toHaveBeenCalledWith(expect.objectContaining({
      exceptionId: 'EXC_1',
      tx, actorId: 'u_test', scope: { targetType: 'Relation', targetId: 'REL_1', action: 'order:create' },
    }));
  });

  it('credit consumption rejection escapes the conversion transaction; no committed conversion result is returned', async () => {
    const existing = { id: 'QT_1', quotationNumber: 'QT-001', status: 'Accepted', deletedAt: null, convertedOrderId: null,
      customerName: 'ACME', customerRelationId: 'REL_1', currency: 'USD', totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }] };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    creditMocks.checkCreditAvailable.mockResolvedValue({ ok: true, data: { blocked: true, blockCode: 'CREDIT_FROZEN_60_DAYS', blockReason: 'Frozen' } });
    creditMocks.resolveCreditException.mockResolvedValue({ passed: true, exception: { id: 'EXC_1' } });
    creditMocks.consumeCreditException.mockRejectedValue(Object.assign(new Error('Quota exhausted'), { code: 'EXCEPTION_ALREADY_CONSUMED', statusCode: 409 }));
    await expect(createQuotationService(prisma).convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toMatchObject({ code: 'EXCEPTION_ALREADY_CONSUMED', statusCode: 409 });
    expect(creditMocks.consumeCreditException).toHaveBeenCalledWith(expect.objectContaining({ tx, exceptionId: 'EXC_1', actorId: 'u_test' }));
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    // This transaction adapter proves propagation, not real SQL rollback.
  });

  it('信用门禁校验自身故障 → CREDIT_CHECK_FAILED，不放行', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      customerRelationId: 'REL_1',
      currency: 'USD',
      totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    creditMocks.checkCreditAvailable.mockRejectedValue(new Error('DB_CONN_LOST'));

    await expect(service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'))).rejects.toMatchObject({code:'CREDIT_CHECK_FAILED',statusCode:500});
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('无 customerRelationId 的报价 → 不触发信用门禁（与 V2 建单口径一致）', async () => {
    const existing = {
      id: 'QT_1',
      quotationNumber: 'QT-001',
      status: 'Accepted',
      deletedAt: null,
      convertedOrderId: null,
      customerName: 'ACME',
      customerRelationId: null,
      currency: 'USD',
      totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
    };
    const { prisma, tx } = makePrismaWithConvertSupport({ existing });
    const service = createQuotationService(prisma);

    const result = await service.convertToOrder('QT_1', 'u_test', undefined, verifiedConversion('u_test'));
    expect(result.orderId).toMatch(/^ORD-QT-/);
    expect(creditMocks.checkCreditAvailable).not.toHaveBeenCalled();
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });
});

// ── 辅助工厂（变体） ──
function makePrimaWithExisting(existing: any) {
  return makePrisma({ existing });
}

function makePrimaWithListResult(items: any[], total: number) {
  const quotationFindManySpy = vi.fn().mockResolvedValue(items);
  const quotationCountSpy = vi.fn().mockResolvedValue(total);
  const quotationFindUnique = vi.fn().mockResolvedValue(null);

  const prisma: any = {
    quotation: {
      findUnique: quotationFindUnique,
      findMany: quotationFindManySpy,
      count: quotationCountSpy,
    },
    $transaction: vi.fn(async (fn: any) => fn({})),
  };
  return { prisma, quotationFindManySpy, quotationCountSpy };
}

// ── convertToOrder 需要额外的 order/auditLog mock ──
function makePrismaWithConvertSupport(opts: { existing?: any; auditFail?: boolean } = {}) {
  const base = makePrisma({ existing: opts.existing });
  base.tx.developmentCase = {findFirst:vi.fn().mockImplementation(async ({where}:any)=>({id:where.id,customerRelationId:opts.existing?.customerRelationId??null}))};
  const auditCreate = opts.auditFail
    ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT'))
    : vi.fn().mockResolvedValue({ id: 'AL-1' });
  const orderCreate = vi.fn().mockImplementation(async ({ data }: any) => ({
    id: data.id,
    ...data,
    lines: data.lines?.create ?? [],
  }));
  const quotationUpdate = vi.fn().mockImplementation(async ({ where, data, include }: any) => ({
    ...opts.existing,
    ...data,
    id: where.id,
    lines: persistedQuotation(opts.existing)?.lines ?? [],
  }));

  base.tx.order = { create: orderCreate };
  // convertToOrder 的成本三环依赖；现有 fixture 未建立 PricingCalculation，故匹配 0 条。
  // 只在 tx 暴露接口，避免事务外写入被同一个 Mock 掩盖。
  base.tx.pricingCalculation = { updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
  base.tx.quotation.update = quotationUpdate;
  base.tx.auditLog.create = auditCreate;

  // 原子认领 convertedOrderId（防 L9/手动并发双建单）：默认 count=1（认领成功）；
  // tx.findUnique 读回认领后的 convertedOrderId，保证返回对象互链断言成立
  const quotationClaim = vi.fn().mockResolvedValue({ count: 1 });
  const quotationTxFindUnique = vi.fn().mockImplementation(async ({ where }: any) => ({
    ...persistedQuotation(opts.existing),
    id: where.id,
    ...(quotationClaim.mock.calls.length
      ? { convertedOrderId: (quotationClaim.mock.calls[0][0] as any).data.convertedOrderId }
      : {}),
    lines: persistedQuotation(opts.existing)?.lines ?? [],
  }));
  base.tx.quotation.updateMany = quotationClaim;
  base.tx.quotation.findUnique = quotationTxFindUnique;

  base.prisma.$transaction = vi.fn(async (fn: any) => fn(base.tx));
  // Mandatory stages share the Order/Quotation/Audit interactive transaction.
  const productionStageUpsert = vi.fn().mockResolvedValue({});
  base.tx.productionStage = { upsert: productionStageUpsert };
  base.prisma.productionStage = { upsert: vi.fn().mockRejectedValue(new Error('OUTSIDE_CONVERSION_TX')) };

  return { ...base, orderCreate, quotationUpdate, quotationClaim, productionStageUpsert };
}

// ────────────────────────────────────────────────────────────────
// 双轨偏差审批联动（PRD 8.6）：创建快照 + warn/block 自动审批 + 发送红标门禁
// ────────────────────────────────────────────────────────────────
describe('quotationService: 双轨偏差快照与审批联动（PRD 8.6）', () => {
  beforeEach(() => {
    publishSpy.mockClear();
  });

  const dualTrackBase: CreateQuotationInput = {
    ...baseInput,
    trackAMedianUsd: 1.0,
    trackAUnit: 'M',
    trackBFinalUsd: 1.1, // +10% → ok
  };

  it('ok 偏差（≤15%）→ 快照落库，不生成审批', async () => {
    const { prisma, quotationCreate } = makePrisma();
    const service = createQuotationService(prisma);

    await service.createQuotation(dualTrackBase, 'u_test');

    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.trackAMedianUsd).toBe(1.0);
    expect(data.trackAUnit).toBe('M');
    expect(data.trackBFinalUsd).toBe(1.1);
    expect(data.priceDeviationPercent).toBeCloseTo(10, 4);
    expect(data.priceDeviationLevel).toBe('ok');
    expect(data.priceApprovalId).toBeNull();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('warn 偏差（>15%）→ 快照落库 + 事务外生成 medium 风险审批（DR-007 路由）', async () => {
    const { prisma, quotationCreate } = makePrisma();
    const service = createQuotationService(prisma);

    const created = await service.createQuotation({ ...dualTrackBase, trackBFinalUsd: 1.2 }, 'u_test'); // +20%

    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.priceDeviationPercent).toBeCloseTo(20, 4);
    expect(data.priceDeviationLevel).toBe('warn');
    expect(data.priceApprovalId).toBeNull(); // tx 内不直写审批，先置空后回填

    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
    const approvalData = prisma.approvalRequest.create.mock.calls[0][0].data;
    expect(approvalData.id).toMatch(/^ar_/);
    expect(approvalData.actionType).toBe('quotation:price-deviation');
    expect(approvalData.targetType).toBe('Quotation');
    expect(approvalData.targetId).toBe(data.id);
    expect(approvalData.status).toBe('pending');
    expect(approvalData.risk).toBe('medium');
    expect(approvalData.requesterId).toBe('usr_owner_default');
    // DR-007：reviewerId 非空且经 routingService 解析（默认 mock → FALLBACK_ADMIN）
    expect(approvalData.reviewerId).toBe('usr_admin');
    expect(approvalData.reviewerResolverRoute).toBe('FALLBACK_ADMIN');
    expect(approvalData.departmentSnapshotId).toBe('DEPT_NONE');
    expect(approvalData.payload).toEqual(expect.objectContaining({
      policyKey: 'price_approval',
      hitConditions: ['dual_track_deviation'],
      quotationSnapshot: expect.objectContaining({ schemaVersion: 2, quotationId: data.id, version: 1 }),
      contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      trackAMedianUsd: 1.0,
      trackBFinalUsd: 1.2,
      level: 'warn',
      source: 'quotation-dual-track',
    }));
    // 报价单 ↔ 审批单互链回填（返回对象读最终态）
    expect((created as any).priceApprovalId).toBe(approvalData.id);
    expect(prisma.quotation.update).toHaveBeenCalledWith({
      where: { id: data.id },
      data: { priceApprovalId: approvalData.id },
    });
  });

  it('block 偏差（>30%）→ 快照落库 + high 风险审批', async () => {
    const { prisma, quotationCreate } = makePrisma();
    const service = createQuotationService(prisma);

    await service.createQuotation({ ...dualTrackBase, trackBFinalUsd: 1.35 }, 'u_test'); // +35%

    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.priceDeviationPercent).toBeCloseTo(35, 4);
    expect(data.priceDeviationLevel).toBe('block');
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.approvalRequest.create.mock.calls[0][0].data.risk).toBe('high');
  });

  it('价格审批单 reviewerId 非空且经 DR-007 解析（DEPT_HEAD 路径）', async () => {
    const { prisma, quotationCreate } = makePrisma();
    // requester=usr_owner_default（owner 兜底），部门 dept_sales 主管 usr_mgr → DEPT_HEAD
    prisma.userAccount.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 'usr_mgr' ? { id: 'usr_mgr' } : { id: 'usr_owner_default', primaryDeptId: 'dept_sales' });
    prisma.department.findUnique.mockResolvedValue({ id: 'dept_sales', status: 'active', headId: 'usr_mgr', parentId: null });
    const service = createQuotationService(prisma);

    const created = await service.createQuotation({ ...dualTrackBase, trackBFinalUsd: 1.35 }, 'u_test'); // +35% block

    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
    const approvalData = prisma.approvalRequest.create.mock.calls[0][0].data;
    expect(approvalData.reviewerId).toBe('usr_mgr'); // 非空且经 DR-007 路由解析，非 requester 本人
    expect(approvalData.reviewerResolverRoute).toBe('DEPT_HEAD');
    expect(approvalData.departmentSnapshotId).toBe('dept_sales');
    expect(approvalData.payload.policyKey).toBe('price_approval');
    expect(approvalData.payload.hitConditions).toContain('dual_track_deviation');
    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.priceApprovalId).toBeNull(); // tx 内置空
    expect((created as any).priceApprovalId).toBe(approvalData.id); // 事务外回填
  });

  it('负向偏差绝对值同样分级（-35% → block）', async () => {
    const { prisma, quotationCreate } = makePrisma();
    const service = createQuotationService(prisma);

    await service.createQuotation({ ...dualTrackBase, trackBFinalUsd: 0.65 }, 'u_test'); // -35%

    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.priceDeviationPercent).toBeCloseTo(-35, 4);
    expect(data.priceDeviationLevel).toBe('block');
  });

  it('无双轨输入 → 快照字段为 null，不生成审批（向后兼容）', async () => {
    const { prisma, quotationCreate } = makePrisma();
    const service = createQuotationService(prisma);

    await service.createQuotation(baseInput, 'u_test');

    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.trackAMedianUsd).toBeNull();
    expect(data.trackBFinalUsd).toBeNull();
    expect(data.priceDeviationPercent).toBeNull();
    expect(data.priceDeviationLevel).toBeNull();
    expect(data.priceApprovalId).toBeNull();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('仅单轨输入（缺轨道 B）→ 不计算偏差，不生成审批', async () => {
    const { prisma, quotationCreate } = makePrisma();
    const service = createQuotationService(prisma);

    await service.createQuotation({ ...baseInput, trackAMedianUsd: 1.0, trackAUnit: 'M' }, 'u_test');

    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.trackAMedianUsd).toBe(1.0);
    expect(data.priceDeviationLevel).toBeNull();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('requester 无法解析（无 owner）→ 快照照常落库但不生成审批（不阻断创建）', async () => {
    const { prisma, quotationCreate } = makePrisma();
    prisma.userAccount.findFirst.mockResolvedValue(null); // actor 解析失败 + owner 缺失
    const service = createQuotationService(prisma);

    await service.createQuotation({ ...dualTrackBase, trackBFinalUsd: 1.35 }, 'u_test');

    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.priceDeviationLevel).toBe('block');
    expect(data.priceApprovalId).toBeNull();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

describe('quotationService: G1-3 报价正向关联（开发案/订单/条目）', () => {
  it('createQuotation 透传 developmentCaseId/orderId/orderLineId', async () => {
    const { prisma, quotationCreate } = makePrisma();
    const service = createQuotationService(prisma);
    await service.createQuotation({ ...baseInput, developmentCaseId: 'DC1', orderId: 'ORD1', orderLineId: 'OL1' }, 'u_test');
    const data = quotationCreate.mock.calls[0][0].data;
    expect(data.developmentCaseId).toBe('DC1');
    expect(data.orderId).toBe('ORD1');
    expect(data.orderLineId).toBe('OL1');
  });

  it('listQuotationsByTarget 按 orderId 过滤反查', async () => {
    const findMany = vi.fn().mockImplementation(async ({ where }: any) => (where?.orderId ? [{ id: 'Q1', quotationNumber: 'QT-1', lines: [] }] : []));
    const prisma = { quotation: { findMany }, $transaction: vi.fn() } as any;
    const service = createQuotationService(prisma);
    const res = await service.listQuotationsByTarget({ orderId: 'ORD1' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ orderId: 'ORD1' }) }));
    expect(res.items).toHaveLength(1);
    expect(res.items[0].id).toBe('Q1');
  });

  it('listQuotationsByTarget 无锚点 → 空', async () => {
    const findMany = vi.fn();
    const prisma = { quotation: { findMany }, $transaction: vi.fn() } as any;
    const service = createQuotationService(prisma);
    const res = await service.listQuotationsByTarget({});
    expect(res.items).toHaveLength(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('quotationService: 发送红标门禁（PRD 8.6，block 未审批禁止发送）', () => {
  beforeEach(() => {
    publishSpy.mockClear();
  });

  const blockedQuotation = {
    id: 'QT_1',
    quotationNumber: 'QT-001',
    status: 'Draft',
    deletedAt: null,
    customerName: 'ACME',
    totalAmount: 100,
    currency: 'USD',
    priceDeviationLevel: 'block',
    priceDeviationPercent: 35,
    priceApprovalId: 'ar_1',
    lines: [{ id:'L1', lineNumber:1, description:'Existing shipment fabric', quantity:10000, unit:'M', unitPrice:0.01, amount:100 }],
  };

  it('block + 审批 pending → 抛门禁错误，不更新不发布事件', async () => {
    const { prisma, tx } = makePrisma({ existing: blockedQuotation });
    prisma.approvalRequest.findUnique.mockResolvedValue({ id: 'ar_1', status: 'pending' });
    const service = createQuotationService(prisma);

    await expect(service.sendQuotation('QT_1', 'u_test')).rejects.toThrow('门禁');
    expect(tx.quotation.update).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('DE-6 审批单透传：block 门禁错误对象携带 approvalRequestId（route 回传 body 供前端跳转审批）', async () => {
    const { prisma } = makePrisma({ existing: blockedQuotation });
    prisma.approvalRequest.findUnique.mockResolvedValue({ id: 'ar_1', status: 'pending' });
    const service = createQuotationService(prisma);

    const err = await service.sendQuotation('QT_1', 'u_test').catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('PRICE_DEVIATION_BLOCKED');
    expect(err.approvalRequestId).toBe('ar_1');
  });

  it('block + 审批 rejected → 抛门禁错误', async () => {
    const { prisma, tx } = makePrisma({ existing: blockedQuotation });
    prisma.approvalRequest.findUnique.mockResolvedValue({ id: 'ar_1', status: 'rejected' });
    const service = createQuotationService(prisma);

    await expect(service.sendQuotation('QT_1', 'u_test')).rejects.toThrow('门禁');
    expect(tx.quotation.update).not.toHaveBeenCalled();
  });

  it('block + priceApprovalId 缺失 → fail-closed 抛门禁错误', async () => {
    const { prisma, tx } = makePrisma({ existing: { ...blockedQuotation, priceApprovalId: null } });
    const service = createQuotationService(prisma);

    await expect(service.sendQuotation('QT_1', 'u_test')).rejects.toThrow('门禁');
    expect(tx.quotation.update).not.toHaveBeenCalled();
    expect(prisma.approvalRequest.findUnique).not.toHaveBeenCalled();
  });

  it('block + 审批 approved → 放行发送', async () => {
    const { prisma, tx } = makePrisma({ existing: blockedQuotation });
    prisma.approvalRequest.findUnique.mockResolvedValue({ id: 'ar_1', status: 'approved' });
    const service = createQuotationService(prisma);

    const result = await service.sendQuotation('QT_1', 'u_test');

    expect(tx.quotation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Sent' }),
    }));
    expect(result.status).toBe('Sent');
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('报价审批层级门禁：存在 pending 条目/总价审批 → 阻断发送 QUOTATION_APPROVAL_PENDING', async () => {
    const existing = { ...blockedQuotation, priceDeviationLevel: null, priceDeviationPercent: null, priceApprovalId: null,
      lines:[{id:'L1',lineNumber:1,description:'Synthetic current line',quantity:10000,unit:'M',unitPrice:0.01,amount:100}] };
    const { prisma, tx } = makePrisma({ existing });
    prisma.approvalRequest.findMany.mockResolvedValue([
      { id:'ar_line_p',actionType:ACTION_LINE_APPROVE,targetType:'QuotationLine',targetId:'L1',status:'pending',
        payload:{quotationId:'QT_1',...buildQuotationApprovalSnapshot(persistedQuotation(existing),ACTION_LINE_APPROVE,'L1')} },
    ]);
    const service = createQuotationService(prisma);

    await expect(service.sendQuotation('QT_1', 'u_test')).rejects.toThrow('quotation-approval');
    expect(tx.quotation.update).not.toHaveBeenCalled();
  });

  it('报价审批层级门禁：无 pending（未申请或已全批）→ 正常发送', async () => {
    const existing = { ...blockedQuotation, priceDeviationLevel: null, priceDeviationPercent: null, priceApprovalId: null };
    const { prisma, tx } = makePrisma({ existing });
    prisma.approvalRequest.findMany.mockResolvedValue([]);
    const service = createQuotationService(prisma);

    const result = await service.sendQuotation('QT_1', 'u_test');
    expect(result.status).toBe('Sent');
    expect(tx.quotation.update).toHaveBeenCalledTimes(1);
  });

  it('warn 级别不设门禁 → 正常发送', async () => {
    const existing = { ...blockedQuotation, priceDeviationLevel: 'warn', priceDeviationPercent: 20 };
    const { prisma, tx } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.sendQuotation('QT_1', 'u_test');

    expect(result.status).toBe('Sent');
    expect(prisma.approvalRequest.findUnique).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('无偏差快照（历史报价单）→ 正常发送', async () => {
    const existing = { ...blockedQuotation, priceDeviationLevel: null, priceDeviationPercent: null, priceApprovalId: null };
    const { prisma } = makePrisma({ existing });
    const service = createQuotationService(prisma);

    const result = await service.sendQuotation('QT_1', 'u_test');
    expect(result.status).toBe('Sent');
  });
});


describe('quotationService: conversion authority integration',()=>{
  beforeEach(()=>{creditMocks.checkCreditAvailable.mockReset();creditMocks.checkCreditAvailable.mockResolvedValue({ok:true,data:{blocked:false,blockCode:null,blockReason:null}});creditMocks.resolveCreditException.mockReset();creditMocks.resolveCreditException.mockResolvedValue({passed:false,hint:'审批中'});creditMocks.consumeCreditException.mockReset();creditMocks.consumeCreditException.mockResolvedValue(undefined);});
  const source=()=>({id:'QT_AUTH',quotationNumber:'QT-AUTH',status:'Accepted',deletedAt:null,convertedOrderId:null,ownerId:'u_test',customerRelationId:'REL-AUTH',currency:'USD',totalAmount:1000,moqSnapshot:VALID_MOQ_SNAPSHOT,lines:[{id:'LA',description:'Fabric',quantity:200,unit:'M',unitPrice:5,amount:1000}]});
  it('scalar only is rejected before writing',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    await expect(createQuotationService(prisma).convertToOrder('QT_AUTH','u_test')).rejects.toMatchObject({code:'UNAUTHORIZED'});
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it('signed read ceiling cannot be expanded by current writable DB role',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    const context=verifiedConversion();if(context.mode==='verified_actor'){context.actor.permissions=['quotations:read'];delete context.actor.permissionCeiling;}
    await expect(createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,context)).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it('current inactive actor cannot convert despite signed write scope',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    prisma.userAccount.findFirst.mockResolvedValue({...currentSalesUser('u_test'),status:'inactive'});
    await expect(createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion())).rejects.toMatchObject({code:'UNAUTHORIZED'});
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it('unfollowed customer is rejected rather than fixture-wide authorized',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    prisma.relation.findFirst.mockResolvedValue({id:'REL-AUTH',deletedAt:null,ownerId:'other-user',salesRepIds:[]});
    prisma.teamMember={findMany:vi.fn().mockResolvedValue([])};tx.teamMember=prisma.teamMember;
    await expect(createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion())).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  for(const permission of ['read','read+followup'])it('actual TeamShare '+permission+' respects follow-up write boundary',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    prisma.relation.findFirst.mockResolvedValue({id:'REL-AUTH',deletedAt:null,ownerId:'other-user',salesRepIds:[]});
    prisma.teamMember={findMany:vi.fn().mockResolvedValue([{teamId:'TEAM-A'}])};
    prisma.teamDataGrant={findMany:vi.fn().mockResolvedValue([{entityId:'REL-AUTH'}]),findFirst:vi.fn().mockResolvedValue({permission})};
    tx.teamMember=prisma.teamMember;tx.teamDataGrant=prisma.teamDataGrant;
    const operation=createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion());
    if(permission==='read'){await expect(operation).rejects.toMatchObject({code:'NOT_FOUND'});expect(tx.order.create).not.toHaveBeenCalled();}
    else{await expect(operation).resolves.toMatchObject({quotation:{id:'QT_AUTH'}});expect(tx.order.create).toHaveBeenCalledTimes(1);}
    expect(prisma.teamDataGrant.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({revokedAt:null,teamId:{in:['TEAM-A']}})}));
  });
  it('another customer development source cannot pass quotation conversion',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:{...source(),developmentCaseId:'DEV-WRONG'}});
    tx.developmentCase.findFirst.mockResolvedValue({id:'DEV-WRONG',customerRelationId:'OTHER-CUSTOMER'});
    await expect(createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion())).rejects.toMatchObject({code:'SOURCE_CHANGED'});
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it('commercial rechecks actual customer after the transaction credit lock and preserves original MOQ snapshot',async()=>{
    const existing=source();const {prisma,tx}=makePrismaWithConvertSupport({existing});
    await createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion());
    expect(creditMocks.checkCreditAvailable).toHaveBeenCalledTimes(2);
    for(const [input] of creditMocks.checkCreditAvailable.mock.calls)expect(input).toEqual({relationId:'REL-AUTH',amount:1000});
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(creditMocks.checkCreditAvailable.mock.invocationCallOrder[1]);
    expect(tx.order.create.mock.calls[0][0].data.moqSnapshot).toEqual(VALID_MOQ_SNAPSHOT);
    expect(creditMocks.consumeCreditException).not.toHaveBeenCalled();
  });
  it('credit frozen after preparation refuses transaction creation without an exception',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    creditMocks.checkCreditAvailable.mockResolvedValueOnce({ok:true,data:{blocked:false,blockCode:null,blockReason:null}}).mockResolvedValueOnce({ok:true,data:{blocked:true,blockCode:'CREDIT_FROZEN_60_DAYS',blockReason:'Frozen'}});
    await expect(createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion())).rejects.toMatchObject({code:'CREDIT_FROZEN_60_DAYS'});
    expect(tx.order.create).not.toHaveBeenCalled();expect(creditMocks.consumeCreditException).not.toHaveBeenCalled();
  });
  it('prepared exception is not consumed if current transaction credit is unblocked',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    creditMocks.checkCreditAvailable.mockResolvedValueOnce({ok:true,data:{blocked:true,blockCode:'CREDIT_FROZEN_60_DAYS',blockReason:'Frozen'}}).mockResolvedValueOnce({ok:true,data:{blocked:false,blockCode:null,blockReason:null}});
    creditMocks.resolveCreditException.mockResolvedValue({passed:true,exception:{id:'EX-REAL'}});
    await createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion());
    expect(tx.order.create).toHaveBeenCalledTimes(1);expect(creditMocks.consumeCreditException).not.toHaveBeenCalled();
  });
  it('only returned actual credit approval ID reaches the refusal',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    creditMocks.checkCreditAvailable.mockResolvedValue({ok:true,data:{blocked:true,blockCode:'CREDIT_FROZEN_60_DAYS',blockReason:'Frozen'}});
    creditMocks.resolveCreditException.mockResolvedValue({passed:false,hint:'已发起',approvalRequestId:'APP-REAL'});
    await expect(createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion())).rejects.toMatchObject({code:'CREDIT_FROZEN_60_DAYS',approvalRequestId:'APP-REAL'});
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it('authorization storage failure cannot become an empty permitted set',async()=>{
    const {prisma,tx}=makePrismaWithConvertSupport({existing:source()});
    prisma.userPermissionOverrides.findMany.mockRejectedValue(new Error('SQL unavailable'));
    await expect(createQuotationService(prisma).convertToOrder('QT_AUTH','u_test',undefined,verifiedConversion())).rejects.toMatchObject({code:'AUTHORIZATION_UNAVAILABLE'});
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it('accept outbox persistence failure rejects and does not dispatch',async()=>{
    publishSpy.mockClear();const {prisma,tx}=makePrisma({existing:{...source(),status:'Sent'}});
    tx.agentJob.create.mockRejectedValue(new Error('OUTBOX_REJECT'));
    await expect(createQuotationService(prisma).acceptQuotation('QT_AUTH','u_test',undefined,verifiedConversion())).rejects.toThrow('OUTBOX_REJECT');
    expect(tx.auditLog.create).toHaveBeenCalled();expect(publishSpy).not.toHaveBeenCalled();
    // Transparent transaction mock proves propagation, not PostgreSQL rollback.
  });
});
