/**
 * REQ2-13 业务员离职一键交接回归测试（设计文档 §6 验收锚点）
 *
 * 覆盖（DR-056 四决策）：
 *   ① 移交面：五类归属字段 + 无锚订单兜底；有锚订单/协同档主不动
 *   ② 原子交接：单事务全量改写 + HandoverRecord append-only + 双审计
 *   ③ 停用联动：可选停用 + metadata.handoverId 联链 + 缓存即时失效
 *   ④ 校验：from=to / 接收人非 active / 不存在 404 / 已停用补交接 / 重复交接零计数
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { invalidateMock } = vi.hoisted(() => ({ invalidateMock: vi.fn() }));
vi.mock('../../auth/accountStatusGuard', () => ({
  invalidateAccountStatusCache: invalidateMock,
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createHandoverService } from '../handoverService';

const FROM = { id: 'u_from', displayName: '离职业务员', email: 'from@bambook.local', status: 'active', deletedAt: null, metadata: {} };
const TO = { id: 'u_to', displayName: '接收业务员', email: 'to@bambook.local', status: 'active', deletedAt: null, metadata: {} };
const OTHER = { id: 'u_other', displayName: '第三方销售', status: 'active', deletedAt: null, metadata: {} };

function seedState() {
  return {
    users: [{ ...FROM }, { ...TO }, { ...OTHER }],
    relations: [
      // ① 档主移交：from 拥有 + from 也在协同列
      { id: 'REL-1', name: '客户一', ownerId: 'u_from', salesRepIds: ['u_from', 'u_other'], deletedAt: null },
      // ② 档主移交：to 已在协同列（去重验证）
      { id: 'REL-2', name: '客户二', ownerId: 'u_from', salesRepIds: ['u_from', 'u_to'], deletedAt: null },
      // ③ 协同移交：他人档主 + from 协同
      { id: 'REL-3', name: '客户三', ownerId: 'u_other', salesRepIds: ['u_from', 'u_other'], deletedAt: null },
      // ④ 无关客户（from 无涉）
      { id: 'REL-4', name: '客户四', ownerId: 'u_other', salesRepIds: ['u_other'], deletedAt: null },
    ],
    opportunities: [
      { id: 'OPP-1', salesRepId: 'u_from', salesRepName: '离职业务员' },
      { id: 'OPP-2', salesRepId: 'u_other', salesRepName: '第三方销售' },
    ],
    followUpRecords: [
      { id: 'FU-1', salesRepId: 'u_from', salesRepName: '离职业务员' },
      { id: 'FU-2', salesRepId: 'u_from', salesRepName: '离职业务员' },
    ],
    orders: [
      { id: 'ORD-1', ownerId: 'u_from', customerRelationId: null }, // 无锚 → 兜底移交
      { id: 'ORD-2', ownerId: 'u_from', customerRelationId: 'REL-1' }, // 有锚 → 不动（T-38）
    ],
    departments: [
      { id: 'DEPT-1', name: '销售一部', headId: 'u_from' },
    ],
    handoverRecords: [] as any[],
    auditLogs: [] as any[],
  };
}

function matchRelation(r: any, w: any): boolean {
  if (w?.ownerId !== undefined && r.ownerId !== w.ownerId) return false;
  if (w?.salesRepIds?.has !== undefined && !(r.salesRepIds || []).includes(w.salesRepIds.has)) return false;
  if (w?.NOT?.ownerId !== undefined && r.ownerId === w.NOT.ownerId) return false;
  return true;
}

function makePrisma(state = seedState()) {
  const prisma: any = {
    userAccount: {
      findUnique: async ({ where }: any) => state.users.find((u: any) => u.id === where.id) || null,
      update: async ({ where, data }: any) => {
        const u = state.users.find((x: any) => x.id === where.id);
        if (!u) throw new Error('not found');
        Object.assign(u, data);
        return u;
      },
    },
    relation: {
      count: async ({ where }: any) => state.relations.filter((r: any) => matchRelation(r, where)).length,
      findMany: async ({ where, select }: any) =>
        state.relations
          .filter((r: any) => matchRelation(r, where))
          .map((r: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r)),
      update: async ({ where, data }: any) => {
        const r = state.relations.find((x: any) => x.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data);
        return r;
      },
    },
    opportunity: {
      count: async ({ where }: any) => state.opportunities.filter((o: any) => o.salesRepId === where.salesRepId).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const o of state.opportunities) {
          if (o.salesRepId === where.salesRepId) { Object.assign(o, data); count++; }
        }
        return { count };
      },
    },
    followUpRecord: {
      count: async ({ where }: any) => state.followUpRecords.filter((f: any) => f.salesRepId === where.salesRepId).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const f of state.followUpRecords) {
          if (f.salesRepId === where.salesRepId) { Object.assign(f, data); count++; }
        }
        return { count };
      },
    },
    order: {
      count: async ({ where }: any) =>
        state.orders.filter((o: any) => o.ownerId === where.ownerId && (where.customerRelationId === null ? o.customerRelationId == null : o.customerRelationId === where.customerRelationId)).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const o of state.orders) {
          if (o.ownerId === where.ownerId && o.customerRelationId == null) { Object.assign(o, data); count++; }
        }
        return { count };
      },
    },
    department: {
      findMany: async ({ where, select }: any) =>
        state.departments
          .filter((d: any) => (where?.headId !== undefined ? d.headId === where.headId : true))
          .map((d: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (d as any)[k]])) : d)),
    },
    handoverRecord: {
      create: async ({ data }: any) => { state.handoverRecords.push(data); return data; },
      findMany: async ({ orderBy, take }: any) =>
        [...state.handoverRecords]
          .sort((a: any, b: any) => (orderBy?.createdAt === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt))
          .slice(0, take ?? 20),
    },
    auditLog: {
      create: async ({ data }: any) => { state.auditLogs.push(data); return { id: data.id }; },
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, state };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('preview（DR-056-② 只读预览）', () => {
  it('五类资产计数正确 + fromUser 快照', async () => {
    const { prisma } = makePrisma();
    const r = await createHandoverService(prisma).preview({ fromUserId: 'u_from' });
    expect(r.ok).toBe(true);
    const d = (r as any).data;
    expect(d.counts).toEqual({
      relationsOwned: 2, relationsCoFollowed: 1, opportunities: 1, followUpRecords: 2, unanchoredOrders: 1,
    });
    expect(d.fromUser.id).toBe('u_from');
    expect(d.warnings).toContain('离职者任部门主管（销售一部）：交接不改写组织架构，需人工调整主管');
  });

  it('警示：from=to / 接收人非 active / 接收人不存在 / from 已停用', async () => {
    const { prisma, state } = makePrisma();
    state.users[0].status = 'disabled';
    let r = await createHandoverService(prisma).preview({ fromUserId: 'u_from', toUserId: 'u_from' });
    expect((r as any).data.warnings).toContain('接收人不能是离职者本人');
    expect((r as any).data.warnings).toContain('离职者账号已停用（支持补办资产交接）');

    state.users[1].status = 'disabled';
    r = await createHandoverService(prisma).preview({ fromUserId: 'u_from', toUserId: 'u_to' });
    expect((r as any).data.warnings).toContain('接收人账号非 active 状态，无法接收交接');

    r = await createHandoverService(prisma).preview({ fromUserId: 'u_from', toUserId: 'u_ghost' });
    expect((r as any).data.warnings).toContain('接收人不存在');
  });

  it('离职者不存在 → 404', async () => {
    const { prisma } = makePrisma();
    const r = await createHandoverService(prisma).preview({ fromUserId: 'nope' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('NOT_FOUND');
  });
});

describe('execute（DR-056-①②③ 原子交接）', () => {
  it('happy path：五类移交 + salesRepIds 去重改写 + 停用 + 交接单 + 双审计 + 缓存失效', async () => {
    const { prisma, state } = makePrisma();
    const r = await createHandoverService(prisma).execute(
      { fromUserId: 'u_from', toUserId: 'u_to', note: '离职交接' }, 'u_boss', '127.0.0.1',
    );
    expect(r.ok).toBe(true);
    const d = (r as any).data;
    expect(d.counts).toEqual({
      relationsOwned: 2, relationsCoFollowed: 1, opportunities: 1, followUpRecords: 2, unanchoredOrders: 1,
    });
    expect(d.accountDisabled).toBe(true);
    expect(d.handoverId).toMatch(/^HO__/);

    // ① 档主移交 + 协同列改写（from 剔除、to 补入、去重）
    expect(state.relations.find((x: any) => x.id === 'REL-1')).toMatchObject({ ownerId: 'u_to', salesRepIds: ['u_other', 'u_to'] });
    expect(state.relations.find((x: any) => x.id === 'REL-2')).toMatchObject({ ownerId: 'u_to', salesRepIds: ['u_to'] });
    // ② 协同移交：档主不变
    expect(state.relations.find((x: any) => x.id === 'REL-3')).toMatchObject({ ownerId: 'u_other', salesRepIds: ['u_other', 'u_to'] });
    // 无关客户不动
    expect(state.relations.find((x: any) => x.id === 'REL-4')).toMatchObject({ ownerId: 'u_other', salesRepIds: ['u_other'] });

    // ③④ 商机/跟进移交（含冗余姓名快照）
    expect(state.opportunities.find((o: any) => o.id === 'OPP-1')).toMatchObject({ salesRepId: 'u_to', salesRepName: '接收业务员' });
    expect(state.opportunities.find((o: any) => o.id === 'OPP-2').salesRepId).toBe('u_other');
    expect(state.followUpRecords.every((f: any) => f.salesRepId === 'u_to' && f.salesRepName === '接收业务员')).toBe(true);

    // ⑤ 无锚订单兜底移交；有锚订单不动（T-38）
    expect(state.orders.find((o: any) => o.id === 'ORD-1').ownerId).toBe('u_to');
    expect(state.orders.find((o: any) => o.id === 'ORD-2').ownerId).toBe('u_from');

    // ⑥ 停用 + metadata 联链
    const from = state.users.find((u: any) => u.id === 'u_from');
    expect(from.status).toBe('disabled');
    expect(from.metadata.handoverId).toBe(d.handoverId);
    expect(from.metadata.disabledBy).toBe('u_boss');

    // ⑦ 交接单（append-only）
    const record = state.handoverRecords.find((h: any) => h.id === d.handoverId);
    expect(record).toMatchObject({
      fromUserId: 'u_from', toUserId: 'u_to', operatedBy: 'u_boss',
      fromUserName: '离职业务员', toUserName: '接收业务员', disableAccount: true, note: '离职交接',
    });
    expect(record.detail.relationsOwned).toBe(2);

    // ⑧ 双审计
    const actions = state.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('handover_execute');
    expect(actions).toContain('disable_account');

    // ⑨ 缓存即时失效（DR-056-③）
    expect(invalidateMock).toHaveBeenCalledWith('u_from');
  });

  it('disableAccount=false：不停用、单审计、accountDisabled=false', async () => {
    const { prisma, state } = makePrisma();
    const r = await createHandoverService(prisma).execute(
      { fromUserId: 'u_from', toUserId: 'u_to', disableAccount: false }, 'u_boss',
    );
    expect(r.ok).toBe(true);
    expect((r as any).data.accountDisabled).toBe(false);
    expect(state.users.find((u: any) => u.id === 'u_from').status).toBe('active');
    const actions = state.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('handover_execute');
    expect(actions).not.toContain('disable_account');
  });

  it('校验：from=to SAME_USER / 接收人非 active INACTIVE_SUCCESSOR / 不存在 NOT_FOUND', async () => {
    const { prisma, state } = makePrisma();
    const svc = createHandoverService(prisma);
    let r = await svc.execute({ fromUserId: 'u_from', toUserId: 'u_from' }, 'u_boss');
    expect((r as any).error.code).toBe('SAME_USER');

    state.users.find((u: any) => u.id === 'u_to').status = 'disabled';
    r = await svc.execute({ fromUserId: 'u_from', toUserId: 'u_to' }, 'u_boss');
    expect((r as any).error.code).toBe('INACTIVE_SUCCESSOR');

    r = await svc.execute({ fromUserId: 'u_ghost', toUserId: 'u_to' }, 'u_boss');
    expect((r as any).error.code).toBe('NOT_FOUND');
    r = await svc.execute({ fromUserId: 'u_from', toUserId: 'u_ghost' }, 'u_boss');
    expect((r as any).error.code).toBe('NOT_FOUND');
  });

  it('已停用离职者可补交接（不重复停用审计）；重复交接 → 零计数新单', async () => {
    const { prisma, state } = makePrisma();
    state.users.find((u: any) => u.id === 'u_from').status = 'disabled';
    const r = await createHandoverService(prisma).execute({ fromUserId: 'u_from', toUserId: 'u_to' }, 'u_boss');
    expect(r.ok).toBe(true);
    expect((r as any).data.accountDisabled).toBe(true);
    expect(state.auditLogs.filter((a: any) => a.action === 'disable_account').length).toBe(0);

    // 重复交接：资产已清零 → 零计数新单（append-only 历史不篡改）
    const r2 = await createHandoverService(prisma).execute({ fromUserId: 'u_from', toUserId: 'u_to' }, 'u_boss');
    expect(r2.ok).toBe(true);
    expect((r2 as any).data.counts).toEqual({
      relationsOwned: 0, relationsCoFollowed: 0, opportunities: 0, followUpRecords: 0, unanchoredOrders: 0,
    });
    expect(state.handoverRecords.length).toBe(2);
  });
});

describe('listRecords（交接单历史）', () => {
  it('倒序返回 + limit 收敛（1~100）', async () => {
    const { prisma, state } = makePrisma();
    const now = Date.now();
    state.handoverRecords.push(
      { id: 'HO__A', createdAt: now - 2000 },
      { id: 'HO__B', createdAt: now - 1000 },
    );
    const r = await createHandoverService(prisma).listRecords();
    expect((r as any).data.records.map((x: any) => x.id)).toEqual(['HO__B', 'HO__A']);

    const r2 = await createHandoverService(prisma).listRecords(999);
    expect(r2.ok).toBe(true); // 收敛到 100 不报错
  });
});
