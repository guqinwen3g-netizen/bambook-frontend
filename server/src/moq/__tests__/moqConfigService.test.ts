import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createMoqConfigService,
  MOQ_FALLBACK_CONSTANTS,
  MOQ_INVALID_REASON,
  MOQ_INVALID_VALUE,
  MOQ_SCOPE_DENIED,
  moqActorHasScope,
} from '../moqConfigService';

/**
 * MOQ §15.1 配置可调验收（A1-A5）：
 *   - getActiveConfig：active 行 / 无 active → null / DB 故障 → null（不抛）
 *   - buildSnapshot：active → moq_config 口径；无 active → fallback_constant + configId=null
 *   - updateConfig：scope 门禁（settings:moq:write）/ changeReason ≥5 字 / 正整数校验 / 事务内换版 + 历史留痕
 *   - listHistory：append-only 只读
 */

const ACTIVE_ROW = {
  id: 'MOQCFG__active1',
  fabricDefaultMoq: 800,
  garmentDefaultMoq: 200,
  capsuleMoq: 20,
  isActive: true,
  effectiveFrom: new Date('2026-08-01T00:00:00Z'),
  effectiveTo: null,
  changedBy: 'usr_admin',
  changeReason: '首次初始化种子值',
};

function makePrisma(opts: {
  activeRow?: any;
  findFirstThrows?: boolean;
  transactionThrows?: boolean;
} = {}) {
  const activeRow = opts.activeRow === undefined ? ACTIVE_ROW : opts.activeRow;

  const moqThresholdConfig = {
    findFirst: opts.findFirstThrows
      ? vi.fn().mockRejectedValue(new Error('DB_DOWN'))
      : vi.fn().mockImplementation(async ({ where }: any) => (where?.isActive === true ? activeRow : null)),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...activeRow, ...data, id: where.id })),
    create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
  };
  const moqThresholdConfigHistory = {
    create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
    findMany: vi.fn().mockImplementation(async ({ orderBy, take }: any) => {
      expect(orderBy).toEqual({ changedAt: 'desc' });
      return [{ id: 'H1' }, { id: 'H2' }].slice(0, take ?? 50);
    }),
  };
  const auditLog = { create: vi.fn().mockResolvedValue({ id: 'AL-1' }) };

  const prisma: any = {
    moqThresholdConfig,
    moqThresholdConfigHistory,
    auditLog,
    $transaction: opts.transactionThrows
      ? vi.fn().mockRejectedValue({ code: 'P2002', message: 'Unique constraint failed' })
      : vi.fn().mockImplementation(async (ops: any[]) => Promise.all(ops)),
  };
  return prisma;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('moqActorHasScope — DR-041 权限链', () => {
  it('permissions 直查命中 → true', () => {
    expect(moqActorHasScope({ userId: 'u1', permissions: ['settings:moq:write'] }, 'settings:moq:write')).toBe(true);
  });
  it('owner / role-super-admin → 全通', () => {
    expect(moqActorHasScope({ userId: 'u1', roles: ['owner'] }, 'settings:moq:write')).toBe(true);
    expect(moqActorHasScope({ userId: 'u1', roles: ['role-super-admin'] }, 'settings:moq:write')).toBe(true);
  });
  it('legacy admin 映射 role-admin（矩阵含 settings:moq:write）→ true', () => {
    expect(moqActorHasScope({ userId: 'u1', roles: ['admin'] }, 'settings:moq:write')).toBe(true);
  });
  it('legacy manager 映射 role-sales-manager（矩阵含 moq:line_override 但无配置写）', () => {
    expect(moqActorHasScope({ userId: 'u1', roles: ['manager'] }, 'moq:line_override')).toBe(true);
    expect(moqActorHasScope({ userId: 'u1', roles: ['manager'] }, 'settings:moq:write')).toBe(false);
  });
  it('业务员 sales 持 moq:line_override（DR-007 申请侧）；finance / 未登录 → false', () => {
    // SALES_BASE 含 moq:line_override（业务员为豁免申请发起人，审批链做最终授权）
    expect(moqActorHasScope({ userId: 'u1', roles: ['sales'] }, 'moq:line_override')).toBe(true);
    expect(moqActorHasScope({ userId: 'u1', roles: ['finance'] }, 'moq:line_override')).toBe(false);
    expect(moqActorHasScope({ userId: 'u1', roles: ['finance'] }, 'settings:moq:write')).toBe(false);
    expect(moqActorHasScope(null as any, 'settings:moq:write')).toBe(false);
  });
});

describe('moqConfigService.getActiveConfig', () => {
  it('有 active 行 → 返回该行', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma() });
    const row = await svc.getActiveConfig();
    expect(row?.id).toBe(ACTIVE_ROW.id);
    expect(row?.fabricDefaultMoq).toBe(800);
  });

  it('无 active 行 → null（A5：调用方走兜底常量）', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma({ activeRow: null }) });
    expect(await svc.getActiveConfig()).toBeNull();
  });

  it('DB 故障 → null（不抛出，fail-closed 走兜底）', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma({ findFirstThrows: true }) });
    expect(await svc.getActiveConfig()).toBeNull();
  });
});

describe('moqConfigService.buildSnapshot（writeOnce 快照契约）', () => {
  it('有 active 配置 → source=moq_config + configId + 三档值', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma() });
    const snap = await svc.buildSnapshot();
    expect(snap.source).toBe('moq_config');
    expect(snap.configId).toBe(ACTIVE_ROW.id);
    expect(snap.fabricDefaultMoq).toBe(800);
    expect(snap.garmentDefaultMoq).toBe(200);
    expect(snap.capsuleMoq).toBe(20);
    expect(typeof snap.snapshotAt).toBe('string');
  });

  it('无 active 配置 → 兜底常量 800/200/20 + source=fallback_constant + configId=null（A5 last resort）', async () => {
    const prisma = makePrisma({ activeRow: null });
    const svc = createMoqConfigService({ prisma });
    const snap = await svc.buildSnapshot();
    expect(snap.source).toBe('fallback_constant');
    expect(snap.configId).toBeNull();
    expect(snap.fabricDefaultMoq).toBe(MOQ_FALLBACK_CONSTANTS.fabricDefaultMoq);
    expect(snap.garmentDefaultMoq).toBe(MOQ_FALLBACK_CONSTANTS.garmentDefaultMoq);
    expect(snap.capsuleMoq).toBe(MOQ_FALLBACK_CONSTANTS.capsuleMoq);
    // 兜底触发必须 best-effort 审计（可观测性）
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data.action).toBe('MOQ_FALLBACK_CONSTANT_USED');
  });

  it('事务外可选审计失败仍返回兜底，不在普通 PrismaClient 上创建 SAVEPOINT', async () => {
    const prisma = makePrisma({ activeRow: null });
    prisma.$executeRawUnsafe = vi.fn();
    prisma.auditLog.create.mockRejectedValueOnce(Object.assign(new Error('audit FK failed'), { code: 'P2003' }));

    expect((await createMoqConfigService({ prisma }).buildSnapshot()).source).toBe('fallback_constant');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

// This storage substitute checks savepoint ordering and error propagation only.
// Real P2003 recovery and the caller's committed SQL write belong to the opt-in PG probe.
describe('moqConfigService optional SQL inside a caller transaction', () => {
  function makeTx() {
    const tx = makePrisma({ activeRow: null });
    delete tx.$transaction; // Prisma.TransactionClient has raw SQL but no nested $transaction.
    tx.$executeRawUnsafe = vi.fn().mockResolvedValue(0);
    return tx;
  }

  function sql(tx: any): string[] {
    return tx.$executeRawUnsafe.mock.calls.map(([statement]: [string]) => statement);
  }

  it('成功读取和告警审计分别释放自己的保存点', async () => {
    const tx = makeTx();
    expect((await createMoqConfigService({ prisma: tx }).buildSnapshot()).source).toBe('fallback_constant');
    const statements = sql(tx);
    expect(statements).toHaveLength(4);
    for (const offset of [0, 2]) {
      expect(statements[offset]).toMatch(/^SAVEPOINT moq_optional_[a-f0-9]+$/);
      expect(statements[offset + 1]).toBe('RELEASE ' + statements[offset]);
    }
    expect(statements[0]).not.toBe(statements[2]);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('可选审计 SQL 失败先回滚并释放保存点，再返回兜底', async () => {
    const tx = makeTx();
    tx.auditLog.create.mockRejectedValueOnce(Object.assign(new Error('audit FK failed'), { code: 'P2003' }));
    expect((await createMoqConfigService({ prisma: tx }).buildSnapshot()).source).toBe('fallback_constant');
    const statements = sql(tx);
    expect(statements).toHaveLength(5);
    expect(statements[3]).toBe('ROLLBACK TO ' + statements[2]);
    expect(statements[4]).toBe('RELEASE ' + statements[2]);
  });

  it('可选配置读取 SQL 失败也恢复保存点，才允许告警审计继续', async () => {
    const tx = makeTx();
    tx.moqThresholdConfig.findFirst.mockRejectedValueOnce(Object.assign(new Error('config SQL failed'), { code: 'P2021' }));
    expect((await createMoqConfigService({ prisma: tx }).buildSnapshot()).source).toBe('fallback_constant');
    const statements = sql(tx);
    expect(statements).toHaveLength(5);
    expect(statements[1]).toBe('ROLLBACK TO ' + statements[0]);
    expect(statements[2]).toBe('RELEASE ' + statements[0]);
    expect(statements[4]).toBe('RELEASE ' + statements[3]);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('同一事务的并发服务调用顺序隔离，避免释放前保存点删除后保存点', async () => {
    const tx = makeTx();
    let finishRead!: (value: null) => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    tx.moqThresholdConfig.findFirst.mockImplementationOnce(() => {
      readStarted();
      return new Promise<null>(resolve => { finishRead = resolve; });
    });
    const first = createMoqConfigService({ prisma: tx }).getActiveConfig();
    const second = createMoqConfigService({ prisma: tx }).getActiveConfig();
    await started;
    expect(sql(tx)).toHaveLength(1);
    finishRead(null);
    expect(await Promise.all([first, second])).toEqual([null, null]);
    const statements = sql(tx);
    expect(statements).toHaveLength(4);
    expect(statements[1]).toBe('RELEASE ' + statements[0]);
    expect(statements[3]).toBe('RELEASE ' + statements[2]);
  });

  it('创建保存点失败不执行可选 SQL，也不伪装成健康兜底', async () => {
    const tx = makeTx();
    const failure = new Error('savepoint unavailable');
    tx.$executeRawUnsafe.mockRejectedValueOnce(failure);
    await expect(createMoqConfigService({ prisma: tx }).buildSnapshot()).rejects.toBe(failure);
    expect(tx.moqThresholdConfig.findFirst).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('保存点回滚失败必须传播，不能吞掉后继续业务事务', async () => {
    const tx = makeTx();
    const recoveryFailure = new Error('rollback to savepoint failed');
    tx.auditLog.create.mockRejectedValueOnce(Object.assign(new Error('audit FK failed'), { code: 'P2003' }));
    tx.$executeRawUnsafe.mockImplementation(async (statement: string) => {
      if (statement.startsWith('ROLLBACK TO ')) throw recoveryFailure;
      return 0;
    });
    await expect(createMoqConfigService({ prisma: tx }).buildSnapshot()).rejects.toBe(recoveryFailure);
    const statements = sql(tx);
    expect(statements[statements.length - 1]).toMatch(/^ROLLBACK TO SAVEPOINT /);
  });

  it('释放保存点失败必须传播，不返回可提交的快照', async () => {
    const tx = makeTx();
    const releaseFailure = new Error('release savepoint failed');
    tx.$executeRawUnsafe.mockImplementation(async (statement: string) => {
      if (statement.startsWith('RELEASE ')) throw releaseFailure;
      return 0;
    });
    await expect(createMoqConfigService({ prisma: tx }).buildSnapshot()).rejects.toBe(releaseFailure);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('moqConfigService.updateConfig（§15.1 A2/A3 变更治理）', () => {
  const admin = { userId: 'usr_admin', roles: ['admin'] };

  it('未登录 → SCOPE_DENIED', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma() });
    await expect(
      svc.updateConfig(null as any, { fabricDefaultMoq: 1, garmentDefaultMoq: 1, capsuleMoq: 1, changeReason: '合理变更原因' }),
    ).rejects.toMatchObject({ code: MOQ_SCOPE_DENIED });
  });

  it('无 settings:moq:write scope（业务员）→ SCOPE_DENIED', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma() });
    await expect(
      svc.updateConfig({ userId: 'u_sales', roles: ['sales'] }, { fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21, changeReason: '合理变更原因' }),
    ).rejects.toMatchObject({ code: MOQ_SCOPE_DENIED });
  });

  it('changeReason < 5 字 → MOQ_INVALID_REASON（A2 审计强制）', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma() });
    await expect(
      svc.updateConfig(admin, { fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21, changeReason: '太短' }),
    ).rejects.toMatchObject({ code: MOQ_INVALID_REASON });
  });

  it.each([
    ['fabricDefaultMoq', 0],
    ['garmentDefaultMoq', -5],
    ['capsuleMoq', 1.5],
  ])('%s=%d 非正整数 → MOQ_INVALID_VALUE', async (field, value) => {
    const svc = createMoqConfigService({ prisma: makePrisma() });
    const input: any = { fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21, changeReason: '合理变更原因' };
    input[field] = value;
    await expect(svc.updateConfig(admin, input)).rejects.toMatchObject({ code: MOQ_INVALID_VALUE });
  });

  it('正常变更：旧配置失效 + 新配置 isActive=true + append 1 条 history（同事务）', async () => {
    const prisma = makePrisma();
    const svc = createMoqConfigService({ prisma });
    const created = await svc.updateConfig(admin, {
      fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21, changeReason: '旺季产能调整阈值',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // 旧行 isActive=false + effectiveTo
    expect(prisma.moqThresholdConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACTIVE_ROW.id },
        data: expect.objectContaining({ isActive: false }),
      }),
    );
    // 新行 isActive=true + changedBy/changeReason
    expect(prisma.moqThresholdConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21,
          isActive: true, changedBy: 'usr_admin', changeReason: '旺季产能调整阈值',
        }),
      }),
    );
    // history before/after 对比（append-only）
    expect(prisma.moqThresholdConfigHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          beforeFabricDefaultMoq: 800, afterFabricDefaultMoq: 900,
          beforeGarmentDefaultMoq: 200, afterGarmentDefaultMoq: 210,
          beforeCapsuleMoq: 20, afterCapsuleMoq: 21,
          changedBy: 'usr_admin',
        }),
      }),
    );
    expect(created.fabricDefaultMoq).toBe(900);
  });

  it('无存量配置时首次写入：跳过 update，仅 create + history（before 取兜底常量）', async () => {
    const prisma = makePrisma({ activeRow: null });
    const svc = createMoqConfigService({ prisma });
    await svc.updateConfig(admin, { fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21, changeReason: '首次初始化阈值' });
    expect(prisma.moqThresholdConfig.update).not.toHaveBeenCalled();
    expect(prisma.moqThresholdConfigHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ beforeFabricDefaultMoq: 800 }),
      }),
    );
  });

  it('事务失败（并发唯一索引 P2002）→ MOQ_UPDATE_FAILED', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma({ transactionThrows: true }) });
    await expect(
      svc.updateConfig(admin, { fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21, changeReason: '旺季产能调整阈值' }),
    ).rejects.toMatchObject({ code: 'MOQ_UPDATE_FAILED' });
  });

  it('必需的配置变更历史写入失败仍拒绝变更，不能按可选审计吞掉', async () => {
    const prisma = makePrisma();
    prisma.$executeRawUnsafe = vi.fn();
    prisma.moqThresholdConfigHistory.create.mockRejectedValueOnce(Object.assign(new Error('history FK failed'), { code: 'P2003' }));
    await expect(createMoqConfigService({ prisma }).updateConfig(admin, {
      fabricDefaultMoq: 900, garmentDefaultMoq: 210, capsuleMoq: 21, changeReason: '旺季产能调整阈值',
    })).rejects.toMatchObject({ code: 'MOQ_UPDATE_FAILED' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('moqConfigService.listHistory（append-only 只读）', () => {
  it('默认 limit=50，按 changedAt desc', async () => {
    const svc = createMoqConfigService({ prisma: makePrisma() });
    const items = await svc.listHistory();
    expect(items).toHaveLength(2);
  });

  it('limit 截断（上限 200）', async () => {
    const prisma = makePrisma();
    const svc = createMoqConfigService({ prisma });
    await svc.listHistory({ limit: 1 });
    expect(prisma.moqThresholdConfigHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
    await svc.listHistory({ limit: 9999 });
    expect(prisma.moqThresholdConfigHistory.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });
});
