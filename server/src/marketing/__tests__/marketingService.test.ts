/**
 * marketingService QA-SEC 批回归测试（mock prisma，无真实 DB）
 *
 * 覆盖：
 *   QA-SEC-1: listCampaigns — scopeWhere.OR 不得被 search 顶层 OR 覆盖，必须 AND 组合；
 *             行为级验证：dept 用户 + search 仍只返回 scope 内数据
 *   QA-SEC-2: updateLead/deleteLead — campaign scope 校验；dept 用户改他组 lead → NOT_FOUND(404)
 *   QA-SEC-3: createCampaign — 编号生成失败必须 throw，禁止 code=null 静默落库
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMarketingService } from '../marketingService';
import type { TokenPayload } from '../../auth/service';

// ── 测试 actor ──
// sales legacy → SALES 角色 → marketing 模块 '*' 规则 { kind:'department', own:true, includeDescendantDepartments:false }
const salesActor: TokenPayload = {
  userId: 'u_sales',
  displayName: 'Sales A',
  roles: ['sales'],
  permissions: [],
  departmentIds: ['D1'],
} as any;

// owner legacy → SUPER_ADMIN → rule kind=all（无行级过滤）
const ownerActor: TokenPayload = {
  userId: 'u_owner',
  displayName: 'Boss',
  roles: ['owner'],
  permissions: [],
  departmentIds: [],
} as any;

// ── 测试本地 mini-matcher：模拟 Prisma where 语义（仅覆盖本测试产出的形态）──
function matchWhere(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(cond as any[]).every((c) => matchWhere(row, c))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as any[]).some((c) => matchWhere(row, c))) return false;
      continue;
    }
    if (key === 'deletedAt') {
      if (cond === null && row.deletedAt != null) return false;
      continue;
    }
    const v = row[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as any;
      if ('in' in c) {
        if (!c.in.includes(v)) return false;
        continue;
      }
      if ('contains' in c) {
        const hay = String(v ?? '');
        const needle = String(c.contains);
        const hit = c.mode === 'insensitive'
          ? hay.toLowerCase().includes(needle.toLowerCase())
          : hay.includes(needle);
        if (!hit) return false;
        continue;
      }
    }
    if (v !== cond) return false;
  }
  return true;
}

function makeService(opts: {
  campaigns?: any[];
  leads?: any[];
  seqFail?: boolean;
} = {}) {
  const campaigns = opts.campaigns ?? [];
  const leads = opts.leads ?? [];

  const marketingCampaign = {
    findMany: vi.fn().mockImplementation(async ({ where }: any = {}) =>
      campaigns.filter((r) => matchWhere(r, where ?? {}))),
    count: vi.fn().mockImplementation(async ({ where }: any = {}) =>
      campaigns.filter((r) => matchWhere(r, where ?? {})).length),
    findFirst: vi.fn().mockImplementation(async ({ where }: any = {}) =>
      campaigns.filter((r) => matchWhere(r, where ?? {}))[0] ?? null),
    create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'C_NEW', ...data })),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...campaigns.find((c) => c.id === where.id), ...data })),
  };
  const marketingLead = {
    findMany: vi.fn().mockImplementation(async ({ where }: any = {}) =>
      leads.filter((r) => matchWhere(r, where ?? {}))),
    count: vi.fn().mockImplementation(async ({ where }: any = {}) =>
      leads.filter((r) => matchWhere(r, where ?? {})).length),
    findFirst: vi.fn().mockImplementation(async ({ where, include }: any = {}) => {
      const row = leads.filter((r) => matchWhere(r, where ?? {}))[0] ?? null;
      if (!row) return null;
      // include.campaign → 挂接所属 campaign（最小字段）
      if (include?.campaign) {
        const camp = campaigns.find((c) => c.id === row.campaignId);
        return { ...row, campaign: camp ? { id: camp.id, ownerId: camp.ownerId, departmentId: camp.departmentId } : null };
      }
      return row;
    }),
    create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'L_NEW', ...data })),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...leads.find((l) => l.id === where.id), ...data })),
  };

  const prisma: any = {
    marketingCampaign,
    marketingLead,
    // 行级权限：dept 规则查同部门 active 用户
    userAccount: {
      findMany: vi.fn().mockResolvedValue([{ id: 'u_colleague' }]),
    },
    department: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // 编号服务（createCampaign）：seqFail 时 upsert 抛错模拟编号失败
    sequenceRegister: {
      upsert: opts.seqFail
        ? vi.fn().mockRejectedValue(new Error('SEQ_DB_DOWN'))
        : vi.fn().mockResolvedValue({}),
      update: opts.seqFail
        ? vi.fn().mockRejectedValue(new Error('SEQ_DB_DOWN'))
        : vi.fn().mockResolvedValue({ currentSeq: 1, formatTemplate: null, padding: 3, prefix: 'MKT' }),
    },
  };

  const svc = createMarketingService(prisma);
  return { svc, prisma, marketingCampaign, marketingLead };
}

// ── QA-SEC-1 ──
describe('QA-SEC-1 listCampaigns：scope OR 与 search OR 必须 AND 组合', () => {
  const fixtures = [
    { id: 'C1', name: 'Spring Expo', code: 'MKT-2026-001', description: null, deletedAt: null, ownerId: 'u_sales', departmentId: 'D1' },
    { id: 'C2', name: 'Spring Gala', code: 'MKT-2026-002', description: null, deletedAt: null, ownerId: 'u_other', departmentId: 'D2' },
    { id: 'C3', name: 'Autumn Fair', code: 'MKT-2026-003', description: null, deletedAt: null, ownerId: 'u_other', departmentId: 'D2' },
  ];

  beforeEach(() => vi.clearAllMocks());

  it('dept 用户 + search → where 结构为 AND[scope, OR search]，顶层无裸 OR（v2.1 本人维）', async () => {
    const { svc, marketingCampaign } = makeService({ campaigns: fixtures });
    await svc.listCampaigns(salesActor, { search: 'spring' });

    const where = marketingCampaign.findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toBeUndefined(); // 顶层裸 OR 禁止（旧 bug：覆盖 scopeWhere.OR）
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);
    // AND[0] = scopeWhere（v2.1 组为主：department 规则收敛为本人维 ownerId=self）
    expect(where.AND[0]).toEqual({ ownerId: 'u_sales' });
    // AND[1] = search OR（name/code/description 三字段）
    expect(where.AND[1].OR).toHaveLength(3);
    expect(where.AND[1].OR[0]).toEqual({ name: { contains: 'spring', mode: 'insensitive' } });
  });

  it('dept 用户 + search → 行为级：越组 campaign 即使命中 search 也不返回', async () => {
    const { svc } = makeService({ campaigns: fixtures });
    const res = await svc.listCampaigns(salesActor, { search: 'spring' });

    // C1（D1/u_sales）命中且在 scope 内；C2（D2/u_other）命中 search 但越权，必须被过滤
    expect(res.items.map((i: any) => i.id)).toEqual(['C1']);
    expect(res.total).toBe(1);
  });

  it('dept 用户无 search → scope 扁平挂载本人维（v2.1：ownerId=self，不出现 AND）', async () => {
    const { svc, marketingCampaign } = makeService({ campaigns: fixtures });
    const res = await svc.listCampaigns(salesActor, {});

    const where = marketingCampaign.findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
    expect(where.OR).toBeUndefined();
    expect(where.ownerId).toBe('u_sales'); // 本人维扁平挂载
    expect(res.items.map((i: any) => i.id)).toEqual(['C1']); // 仅 scope 内
  });

  it('all 用户（owner）+ search → 顶层 OR search，无 scope 约束', async () => {
    const { svc, marketingCampaign } = makeService({ campaigns: fixtures });
    const res = await svc.listCampaigns(ownerActor, { search: 'spring' });

    const where = marketingCampaign.findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
    expect(where.OR).toHaveLength(3);
    expect(res.items.map((i: any) => i.id).sort()).toEqual(['C1', 'C2']);
  });
});

// ── QA-SEC-2 ──
describe('QA-SEC-2 updateLead/deleteLead：campaign scope 校验（dept 规则不再零校验）', () => {
  const campaigns = [
    { id: 'C1', name: 'In-Scope', deletedAt: null, ownerId: 'u_sales', departmentId: 'D1' },
    { id: 'C2', name: 'Out-Scope', deletedAt: null, ownerId: 'u_other', departmentId: 'D2' },
  ];
  const leads = [
    { id: 'L1', campaignId: 'C1', deletedAt: null, status: 'New' },
    { id: 'L2', campaignId: 'C2', deletedAt: null, status: 'New' },
  ];

  beforeEach(() => vi.clearAllMocks());

  it('dept 用户 PATCH 自己 scope 内 lead → 成功', async () => {
    const { svc, marketingLead } = makeService({ campaigns, leads });
    const res = await svc.updateLead(salesActor, 'L1', { notes: 'ok' });
    expect(res.notes).toBe('ok');
    expect(marketingLead.update).toHaveBeenCalledTimes(1);
  });

  it('dept 用户 PATCH 他组 lead → NOT_FOUND（路由映射 404），update 未执行', async () => {
    const { svc, marketingLead } = makeService({ campaigns, leads });
    await expect(svc.updateLead(salesActor, 'L2', { notes: 'hack' })).rejects.toThrow('NOT_FOUND');
    expect(marketingLead.update).not.toHaveBeenCalled();
  });

  it('dept 用户 DELETE 他组 lead → NOT_FOUND（路由映射 404），update 未执行', async () => {
    const { svc, marketingLead } = makeService({ campaigns, leads });
    await expect(svc.deleteLead(salesActor, 'L2')).rejects.toThrow('NOT_FOUND');
    expect(marketingLead.update).not.toHaveBeenCalled();
  });

  it('dept 用户 DELETE 自己 scope 内 lead → 软删成功', async () => {
    const { svc, marketingLead } = makeService({ campaigns, leads });
    await svc.deleteLead(salesActor, 'L1');
    expect(marketingLead.update).toHaveBeenCalledTimes(1);
    expect(marketingLead.update.mock.calls[0][0].data.deletedAt).toBeDefined();
  });

  it('PATCH 不存在 lead → NOT_FOUND', async () => {
    const { svc } = makeService({ campaigns, leads });
    await expect(svc.updateLead(salesActor, 'L_NOPE', { notes: 'x' })).rejects.toThrow('NOT_FOUND');
  });

  it('all 用户（owner）PATCH 他组 lead → 成功（无行级约束）', async () => {
    const { svc, marketingLead } = makeService({ campaigns, leads });
    await svc.updateLead(ownerActor, 'L2', { notes: 'boss edit' });
    expect(marketingLead.update).toHaveBeenCalledTimes(1);
  });
});

// ── QA-SEC-3 ──
describe('QA-SEC-3 createCampaign：编号生成失败必须 throw，禁止 code=null 落库', () => {
  beforeEach(() => vi.clearAllMocks());

  it('编号服务失败 → create 抛错，marketingCampaign.create 未调用（无记录落库）', async () => {
    const { svc, marketingCampaign } = makeService({ seqFail: true });
    await expect(svc.createCampaign(salesActor, { name: 'X' })).rejects.toThrow('SEQ_DB_DOWN');
    expect(marketingCampaign.create).not.toHaveBeenCalled();
  });

  it('编号服务正常 → create 成功且 code 非 null', async () => {
    const { svc, marketingCampaign } = makeService({});
    const item = await svc.createCampaign(salesActor, { name: 'X' });
    expect(marketingCampaign.create).toHaveBeenCalledTimes(1);
    expect(item.code).toBeTruthy();
    expect(item.code).not.toBeNull();
  });

  it('未认证 actor → UNAUTHORIZED', async () => {
    const { svc } = makeService({});
    await expect(svc.createCampaign(null, { name: 'X' })).rejects.toThrow('UNAUTHORIZED');
  });
});
