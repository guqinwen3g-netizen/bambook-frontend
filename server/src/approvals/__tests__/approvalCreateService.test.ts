import { describe, expect, it, vi } from 'vitest';
import { createApprovalCreateService, APPROVAL_CREATE_FAILED } from '../approvalCreateService';
import { NO_REVIEWER_RESOLVED } from '../approvalRoutingService';

/**
 * approvalCreateService 契约测试（全 mock prisma + mock routingService）：
 *   - 三个 createOnce 字段（reviewerId / reviewerResolverRoute / departmentSnapshotId）来自路由解析
 *   - DR7-A2：clientSuppliedReviewerId 被忽略 + flag=true + 越权注入审计
 *   - NO_REVIEWER_RESOLVED 原样上抛（fail-closed）
 *   - 其他创建失败包装 APPROVAL_CREATE_FAILED
 *   - BASE-39-A2：departmentSnapshotId 快照值来源路由解析（=requester.primaryDeptId）
 */

function makeDeps(opts: {
  resolution?: { reviewerId: string; route: string; departmentSnapshotId: string };
  routingError?: any;
  createError?: any;
  /** DR-007 单人单次防重：已有 pending 单时 createBusinessApproval 幂等返回该单 */
  existingPending?: { id: string; status: string; payload?: Record<string, unknown> } | null;
} = {}) {
  const resolution = opts.resolution ?? {
    reviewerId: 'u_li',
    route: 'DEPT_HEAD',
    departmentSnapshotId: 'dept_garment',
  };
  const routingService = {
    resolveClaimLeader: opts.routingError ? vi.fn().mockRejectedValue(opts.routingError) : vi.fn().mockResolvedValue(resolution),
    resolveReviewerByDepartment: opts.routingError
      ? vi.fn().mockRejectedValue(opts.routingError)
      : vi.fn().mockResolvedValue(resolution),
  };
  const approvalCreate = opts.createError
    ? vi.fn().mockRejectedValue(opts.createError)
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  // DR-007 单人单次防重：无 pending 单（默认 null → 走创建路径）
  const approvalFindFirst = vi.fn().mockResolvedValue(opts.existingPending ?? null);
  const auditCreate = vi.fn().mockResolvedValue({ id: 'AL-1' });
  const prisma: any = {
    approvalRequest: { create: approvalCreate, findFirst: approvalFindFirst },
    auditLog: { create: auditCreate },
  };
  return { prisma, routingService, approvalCreate, approvalFindFirst, auditCreate };
}

const baseInput = {
  requesterId: 'u_sun',
  actionType: 'order:moq-exemption',
  targetType: 'Order',
  targetId: 'SO_1',
  payload: { moqGap: '37.5%' },
};

describe('approvalCreateService: createOnce 字段写入', () => {
  it('reviewerId / reviewerResolverRoute / departmentSnapshotId 三字段来自路由解析结果', async () => {
    const { prisma, approvalCreate, routingService } = makeDeps();
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });
    const created = await svc.createBusinessApproval(baseInput);

    expect(routingService.resolveReviewerByDepartment).toHaveBeenCalledWith('u_sun');
    const data = approvalCreate.mock.calls[0][0].data;
    expect(data.reviewerId).toBe('u_li');
    expect(data.reviewerResolverRoute).toBe('DEPT_HEAD');
    expect(data.departmentSnapshotId).toBe('dept_garment');
    expect(data.status).toBe('pending');
    expect(data.requesterId).toBe('u_sun');
    expect(data.clientReviewerIdSupplied).toBe(false);
    expect(created.reviewerId).toBe('u_li');
  });

  it('未传 clientSuppliedReviewerId → 不写越权审计', async () => {
    const { prisma, auditCreate, routingService } = makeDeps();
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });
    await svc.createBusinessApproval(baseInput);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe('approvalCreateService: DR7-A2 前端越权传入守卫', () => {
  it('clientSuppliedReviewerId 被忽略：reviewerId 仍为解析值，flag=true，写审计', async () => {
    const { prisma, approvalCreate, auditCreate, routingService } = makeDeps();
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });
    await svc.createBusinessApproval({ ...baseInput, clientSuppliedReviewerId: 'u_sun' });

    const data = approvalCreate.mock.calls[0][0].data;
    // 绝不使用传入值（传入的是自己=想自批）
    expect(data.reviewerId).toBe('u_li');
    expect(data.clientReviewerIdSupplied).toBe(true);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const audit = auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe('APPROVAL_CLIENT_REVIEWERID_IGNORED_ATTEMPT');
    expect(audit.detail.suppliedReviewerId).toBe('u_sun');
    expect(audit.detail.resolvedReviewerId).toBe('u_li');
    expect(audit.fieldPath).toBe('reviewerId');
    expect(audit.afterValue).toBe('u_li');
  });
});

describe('approvalCreateService: fail-closed 错误语义', () => {
  it('routing 抛 NO_REVIEWER_RESOLVED → 原样上抛，绝不落库', async () => {
    const err = new Error('no reviewer') as any;
    err.code = NO_REVIEWER_RESOLVED;
    const { prisma, approvalCreate, routingService } = makeDeps({ routingError: err });
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });

    await expect(svc.createBusinessApproval(baseInput)).rejects.toMatchObject({
      code: NO_REVIEWER_RESOLVED,
    });
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('DB 创建失败 → 包装 APPROVAL_CREATE_FAILED', async () => {
    const { prisma, routingService } = makeDeps({ createError: new Error('DB_BOOM') });
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });
    await expect(svc.createBusinessApproval(baseInput)).rejects.toMatchObject({
      code: APPROVAL_CREATE_FAILED,
    });
  });

  it('routing 抛非 NO_REVIEWER_RESOLVED 错误 → 包装 APPROVAL_CREATE_FAILED', async () => {
    const { prisma, routingService } = makeDeps({ routingError: new Error('CONN_LOST') });
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });
    await expect(svc.createBusinessApproval(baseInput)).rejects.toMatchObject({
      code: APPROVAL_CREATE_FAILED,
    });
  });
});

describe('approvalCreateService: BASE-39-A2 快照来源', () => {
  it('departmentSnapshotId 原样写入解析结果（快照创建时固化，后续部门调动不追溯）', async () => {
    const { prisma, approvalCreate, routingService } = makeDeps({
      resolution: { reviewerId: 'u_li', route: 'DEPT_HEAD', departmentSnapshotId: 'dept_garment' },
    });
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });
    await svc.createBusinessApproval(baseInput);
    expect(approvalCreate.mock.calls[0][0].data.departmentSnapshotId).toBe('dept_garment');
  });
});

describe('approvalCreateService: DR-007 单人单次防重', () => {
  it('未决目标相同但完整内容变化 → 显式冲突，不复用旧内容', async () => {
    const { prisma, routingService, approvalCreate } = makeDeps({ existingPending: { id: 'OLD', status: 'pending', payload: { moqGap: '10%' } } });
    await expect(createApprovalCreateService({ prisma, routingService: routingService as any }).createBusinessApproval(baseInput))
      .rejects.toMatchObject({ code: 'APPROVAL_PENDING_CONTENT_CHANGED', statusCode: 409 });
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('事务客户端同时用于组织解析、审批创建和必需审计', async () => {
    const { prisma, routingService, approvalCreate, auditCreate } = makeDeps();
    const tx: any = { approvalRequest: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) }, auditLog: { create: vi.fn(async () => ({})) } };
    await createApprovalCreateService({ prisma, routingService: routingService as any }).createBusinessApproval({ ...baseInput, client: tx, clientSuppliedReviewerId: 'intruder' });
    expect(routingService.resolveReviewerByDepartment).toHaveBeenCalledWith('u_sun', tx);
    expect(tx.approvalRequest.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(approvalCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('索赔专用总领导路由不能落普通部门主管解析', async () => {
    const { prisma, routingService } = makeDeps();
    await createApprovalCreateService({ prisma, routingService: routingService as any }).createBusinessApproval({ ...baseInput,
      actionType: 'aftersales:claim-disposition', targetType: 'ClaimDisposition' });
    expect(routingService.resolveClaimLeader).toHaveBeenCalledWith('u_sun');
    expect(routingService.resolveReviewerByDepartment).not.toHaveBeenCalled();
  });

  it('索赔 action 与 target 单边错配不得创建', async () => {
    const { prisma, routingService, approvalCreate } = makeDeps();
    await expect(createApprovalCreateService({ prisma, routingService: routingService as any }).createBusinessApproval({ ...baseInput,
      targetType: 'ClaimDisposition' })).rejects.toMatchObject({ code: APPROVAL_CREATE_FAILED });
    expect(approvalCreate).not.toHaveBeenCalled();
  });
  it('同 requester+actionType+targetId 已有 pending 单 → 幂等返回既有单，不再 create', async () => {
    const existing = { id: 'ar_existing_1', status: 'pending', reviewerId: 'u_li', payload: baseInput.payload };
    const { prisma, approvalCreate, approvalFindFirst, routingService } = makeDeps({ existingPending: existing });
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });
    const result = await svc.createBusinessApproval(baseInput);
    expect(result).toMatchObject({ id: 'ar_existing_1', status: 'pending' });
    expect(approvalFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requesterId: 'u_sun', actionType: 'order:moq-exemption', targetType: 'Order', targetId: 'SO_1', status: 'pending',
        }),
      }),
    );
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('无 pending 单 → 正常走创建路径', async () => {
    const { approvalCreate, approvalFindFirst, routingService, prisma } = makeDeps();
    const svc = createApprovalCreateService({ prisma, routingService: routingService as any });
    await svc.createBusinessApproval(baseInput);
    expect(approvalFindFirst).toHaveBeenCalled();
    expect(approvalCreate).toHaveBeenCalledTimes(1);
  });
});
