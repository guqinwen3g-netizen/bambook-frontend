import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../auth/service';
import { lookupErrorCode } from '../shared/errorCodes';
import { createHRRouter } from './route';

// HR 路由要求 owner/admin 角色（与 admin 路由同模式），用 owner token 通过守卫
function ownerToken() {
  return createAuthService().signToken({
    userId: 'owner-1',
    displayName: 'Owner',
    roles: ['owner'],
    permissions: [],
    departmentIds: [],
  });
}

// K1 测试身份：财务（legacy finance → FINANCE，持 hr:read 但无 sensitive:salary）
function financeToken() {
  return createAuthService().signToken({
    userId: 'fin-1',
    displayName: 'Finance',
    roles: ['finance'],
    permissions: [],
    departmentIds: [],
  });
}

// K1 测试身份：系统管理员（legacy admin → ADMIN，持 hr:read|hr:write 但无 sensitive:salary）
function adminToken() {
  return createAuthService().signToken({
    userId: 'admin-1',
    displayName: 'Admin',
    roles: ['admin'],
    permissions: [],
    departmentIds: [],
  });
}

// K1 测试身份：被显式授权薪酬明细的指定 HR（JWT permissions 携带 sensitive:salary）
function hrSalaryToken() {
  return createAuthService().signToken({
    userId: 'hr-1',
    displayName: 'HR Salary',
    roles: [],
    permissions: ['hr:read', 'hr:write', 'sensitive:salary'],
    departmentIds: [],
  });
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/hr', createHRRouter({ prisma }));
  return app;
}

describe('HR personnel route filters erased users', () => {
  it('keeps disabled users visible but filters erased users from personnel list', async () => {
    // 三类用户：
    //  - activeUser：正常在职员工
    //  - disabledUser：停用账号（status='disabled'），按设计应保留在列表，标记停用
    //  - erasedUser：抹除个人数据（metadata.erased + deletionMode='erase-personal-data'），
    //    admin 路由会把它 status 改成 'disabled'，HR personnel 必须再过滤 metadata 才不会泄漏
    const activeUser = {
      id: 'user-active',
      displayName: 'Active User',
      email: 'active@example.com',
      status: 'active',
      roles: [],
      primaryDeptId: null,
      primaryDepartment: null,
      metadata: null,
      lastLoginAt: null,
      lastLoginIp: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      deletedAt: null,
    };
    const disabledUser = {
      ...activeUser,
      id: 'user-disabled',
      displayName: 'Disabled User',
      email: 'disabled@example.com',
      status: 'disabled',
      metadata: { disabledBy: 'owner-1', disabledAt: '2026-02-01T00:00:00Z' },
      deletedAt: BigInt(123),
    };
    const erasedUser = {
      ...disabledUser,
      id: 'user-erased',
      displayName: '已抹除用户 erased',
      email: null,
      metadata: {
        erased: true,
        erasedAt: '2026-03-01T00:00:00Z',
        erasedBy: 'owner-1',
        deletionMode: 'erase-personal-data',
      },
    };
    const prisma = {
      userAccount: {
        findMany: vi.fn().mockResolvedValue([activeUser, disabledUser, erasedUser]),
      },
      department: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'dept-sales', name: '业务部', parentId: null, status: 'active' },
        ]),
      },
      jobPosition: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const res = await request(makeApp(prisma))
      .get('/hr/personnel')
      .set('Authorization', `Bearer ${ownerToken()}`);

    expect(res.status).toBe(200);
    expect(prisma.userAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ deletedAt: null }, { status: 'disabled' }] },
    }));
    // 关键断言：erased 用户被过滤，active + disabled 用户保留
    expect(res.body.personnel).toHaveLength(2);
    const ids = res.body.personnel.map((u: any) => u.id);
    expect(ids).toContain('user-active');
    expect(ids).toContain('user-disabled');
    expect(ids).not.toContain('user-erased');
  });

  it('also filters users with deletionMode=erase-personal-data but no erased flag', async () => {
    // 防御性 case：仅 deletionMode=erase-personal-data 但 metadata.erased 未设置
    // 设计真源要求两个条件任一命中即过滤
    const normalUser = {
      id: 'user-normal',
      displayName: 'Normal',
      email: 'normal@example.com',
      status: 'active',
      roles: [],
      primaryDeptId: null,
      primaryDepartment: null,
      metadata: null,
      lastLoginAt: null,
      lastLoginIp: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      deletedAt: null,
    };
    const erasedByModeOnly = {
      ...normalUser,
      id: 'user-mode-only',
      displayName: '已抹除用户 modeonly',
      email: null,
      status: 'disabled',
      metadata: { deletionMode: 'erase-personal-data' },
      deletedAt: BigInt(456),
    };
    const prisma = {
      userAccount: {
        findMany: vi.fn().mockResolvedValue([normalUser, erasedByModeOnly]),
      },
      department: { findMany: vi.fn().mockResolvedValue([]) },
      jobPosition: { findMany: vi.fn().mockResolvedValue([]) },
    };

    const res = await request(makeApp(prisma))
      .get('/hr/personnel')
      .set('Authorization', `Bearer ${ownerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.personnel).toHaveLength(1);
    expect(res.body.personnel[0].id).toBe('user-normal');
  });
});

/**
 * K1 工资保密门禁（批次二）：薪酬明细接口（/salary-structures、/payroll-runs、/payroll-items）
 * 在 hr:read|write 全局门之上叠加 sensitive:salary 敏感 scope。
 * 矩阵真源：仅 SuperAdmin + 被显式授权的指定 HR 持有；FINANCE（hr:read）与
 * ADMIN（hr:read|hr:write）均未授予 → 越权访问必须 403。
 */
describe('K1 · 工资保密门禁（sensitive:salary）', () => {
  function makeSalaryPrisma() {
    return {
      salaryStructure: { findMany: vi.fn().mockResolvedValue([]) },
      payrollRun: { findMany: vi.fn().mockResolvedValue([]) },
    };
  }

  it('财务（hr:read 但无 sensitive:salary）读薪资结构 → 403', async () => {
    const prisma = makeSalaryPrisma();
    const res = await request(makeApp(prisma))
      .get('/hr/salary-structures/user-1')
      .set('Authorization', `Bearer ${financeToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('sensitive:salary');
    expect(prisma.salaryStructure.findMany).not.toHaveBeenCalled();
  });

  it('财务（hr:read 但无 sensitive:salary）读工资单列表 → 403', async () => {
    const prisma = makeSalaryPrisma();
    const res = await request(makeApp(prisma))
      .get('/hr/payroll-runs')
      .set('Authorization', `Bearer ${financeToken()}`);
    expect(res.status).toBe(403);
    expect(prisma.payrollRun.findMany).not.toHaveBeenCalled();
  });

  it('总领导（hr:read|hr:write 但无 sensitive:salary）读工资单 → 403', async () => {
    const prisma = makeSalaryPrisma();
    const res = await request(makeApp(prisma))
      .get('/hr/payroll-runs')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(403);
    expect(prisma.payrollRun.findMany).not.toHaveBeenCalled();
  });

  it('总领导（hr:write 但无 sensitive:salary）写薪资结构 → 403', async () => {
    const prisma = makeSalaryPrisma();
    const res = await request(makeApp(prisma))
      .post('/hr/salary-structures')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ userId: 'user-1', baseSalary: 10000, effectiveFrom: '2026-09-01' });
    expect(res.status).toBe(403);
  });

  it('指定 HR（sensitive:salary 已授权）读薪资结构 → 200', async () => {
    const prisma = makeSalaryPrisma();
    const res = await request(makeApp(prisma))
      .get('/hr/salary-structures/user-1')
      .set('Authorization', `Bearer ${hrSalaryToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.salaryStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('指定 HR（sensitive:salary 已授权）读工资单列表 → 200', async () => {
    const prisma = makeSalaryPrisma();
    const res = await request(makeApp(prisma))
      .get('/hr/payroll-runs')
      .set('Authorization', `Bearer ${hrSalaryToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('SuperAdmin（owner 特判全通）读工资单列表 → 200', async () => {
    const prisma = makeSalaryPrisma();
    const res = await request(makeApp(prisma))
      .get('/hr/payroll-runs')
      .set('Authorization', `Bearer ${ownerToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('非薪酬接口不受敏感门影响：财务读员工列表（hr:read）→ 200', async () => {
    const prisma = {
      employeeProfile: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const res = await request(makeApp(prisma))
      .get('/hr/employees')
      .set('Authorization', `Bearer ${financeToken()}`);
    expect(res.status).toBe(200);
  });
});

/**
 * ★ Task 4b 复审 F1：被收口改接的两条腿必须有**执行**覆盖（原先只有源码正则，改错也照样绿）。
 *
 * 覆盖对象：
 *   ① `route.ts` 的组端点（DELETE /teams/:id、POST /teams/:id/dissolve）—— 两处内联 statusMap 被删后
 *      只剩一次真源调用，5 个可达结果（401/403/404/409/500）逐条真跑；
 *   ② 路由的错误出口（`audited` 与各 try-catch）—— 「抛出物不是业务错误 ⇒ 未归因 ⇒ 500」那条甄别腿
 *      （含**服务抛普通 Error** 的用例）。B22 收敛后这条腿住在 `shared/errorCodes.isBusinessError`
 *      里（route.ts 不再自己判 `instanceof HrError`），但**执行覆盖不变**：丢了甄别，
 *      `err.code` 为 undefined 的抛出物会被答成业务码 undefined / 或直接炸 catch ⇒ 本用例当场红。
 *
 * 期望值全部按 HTTP 语义独立核定（RFC 9110；T1/G6.4：不抄实现返回值）：
 *   401 未认证（没登录）/ 403 已认证但角色不足 / 404 目标不存在 / 409 与资源当前状态冲突 /
 *   500 未归因的服务端故障（含事务炸掉、含抛出的不是业务错误类）。
 */
describe('★ Task 4b F1 · 组端点与「未归因 ⇒ 500」甄别腿的执行覆盖', () => {
  /**
   * dissolveTeam 的假 prisma：只按它读什么就给什么，不预设它答什么码
   * （分支出处 src/teams/teamShareService.ts:412-441，逐条对应下面 5 个用例）。
   */
  function teamPrisma(opts: { team?: any; txError?: Error } = {}) {
    return {
      team: { findUnique: vi.fn().mockResolvedValue(opts.team === undefined ? null : opts.team) },
      $transaction: opts.txError
        ? vi.fn().mockRejectedValue(opts.txError)
        : vi.fn().mockResolvedValue({ revokedGrants: 0 }),
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'alog_1' }) },
    };
  }

  /** 两个被改接的组端点（同一段代码形状，必须各自跑到，不能只测一个） */
  async function callTeamEndpoint(
    method: 'delete' | 'post',
    prisma: any,
    opts: { token?: string; requireAuth?: boolean } = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use('/hr', createHRRouter({ prisma, requireAuth: opts.requireAuth ?? true }));
    const path = method === 'delete' ? '/hr/teams/team-1' : '/hr/teams/team-1/dissolve';
    const call = method === 'delete' ? request(app).delete(path) : request(app).post(path);
    // requireAuth=false 只用来构造「路由没有 actor」这一可达输入（守卫整体关掉，不测守卫自己）
    if (opts.token) call.set('Authorization', `Bearer ${opts.token}`);
    return call.send({});
  }

  /** 5 个可达结果 × 2 个端点（断言在表里，两处各自独立跑） */
  const TEAM_OUTCOMES: Array<[string, number, () => any, { token?: string; requireAuth?: boolean }]> = [
    // 401：没有身份 ⇒「未认证」（RFC 9110 §15.5.2）
    ['未登录（无 actor）', 401, () => teamPrisma(), { requireAuth: false }],
    // 403：已认证、持 hr:write，但不是主管/管理员 ⇒「无权限」（§15.5.3）
    ['已登录但角色不足', 403, () => teamPrisma(), { token: hrSalaryToken() }],
    // 404：组查不到 ⇒「目标不存在」（§15.5.5）
    ['组不存在', 404, () => teamPrisma({ team: null }), { token: ownerToken() }],
    // 409：组已软删 ⇒ 与资源当前状态冲突（§15.5.12，幂等保护 T-05）
    ['组已解散（重复解散）', 409, () => teamPrisma({ team: { id: 'team-1', deletedAt: BigInt(123) } }), { token: ownerToken() }],
    // 500：事务炸了 ⇒ 服务端故障（§15.6.1）。这条同时钉住「真源显式登记的 INTERNAL_ERROR 走 500」
    ['事务异常（INTERNAL_ERROR）', 500,
      () => teamPrisma({ team: { id: 'team-1', deletedAt: null }, txError: new Error('tx blew up') }),
      { token: ownerToken() }],
  ];

  for (const method of ['delete', 'post'] as const) {
    const endpoint = method === 'delete' ? 'DELETE /hr/teams/:id' : 'POST /hr/teams/:id/dissolve';
    for (const [label, expected, mkPrisma, opts] of TEAM_OUTCOMES) {
      it(`${endpoint} · ${label} → ${expected}（期望值按 HTTP 语义核定，非抄现值）`, async () => {
        const res = await callTeamEndpoint(method, mkPrisma(), opts);
        expect(res.status).toBe(expected);
        expect(res.body.ok).toBe(false);
        // 外发码原样透传（响应体也是契约的一部分）
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error).toMatch(/^[A-Z_]+$/);
      });
    }
  }

  // ── ② 「未归因 ⇒ 500」这条腿（audited / 各 try-catch 的落点）──
  const mk = {
    /** decide 用的假 prisma：请假单查不到 / 状态非 Pending */
    leavePrisma: (row: any) => ({
      leaveRequest: { findUnique: vi.fn().mockResolvedValue(row) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'alog_1' }) },
    }),
  };

  async function callHr(
    method: 'get' | 'post' | 'put',
    path: string,
    prisma: any,
    body?: any,
  ) {
    const app = express();
    app.use(express.json());
    app.use('/hr', createHRRouter({ prisma }));
    const r = request(app);
    const call = method === 'get' ? r.get(path) : method === 'put' ? r.put(path) : r.post(path);
    return call.set('Authorization', `Bearer ${ownerToken()}`).send(body ?? {});
  }

  it('★ 服务抛**普通 Error**（非业务形状）→ 500 + 注册表文案，原始错误文本不外发', async () => {
    const prisma = {
      employeeProfile: { findMany: vi.fn().mockRejectedValue(new Error('db connection reset')) },
    };
    const res = await callHr('get', '/hr/employees', prisma);
    // 500：抛出物不是业务错误 ⇒ 未归因的服务端故障（§15.6.1）
    expect(res.status).toBe(500);
    // 未归因 ⇒ 答路由自取的兜底码（不是 err.code=undefined）⇒ 证明甄别腿真的跑了
    expect(res.body.error).toBe('HR_EMPLOYEES_FETCH_FAILED');
    // ★ B22/G6.5 的本体判据：**内部错误原文一个字符都不许出现在响应里**。
    //   收敛前这条断言写作 `toBe('db connection reset')`（把泄露当契约钉住），
    //   收敛后由本条反向钉死，防止有人为了"让测试绿"把原文接回去。
    expect(JSON.stringify(res.body)).not.toContain('db connection reset');
    // 业务员看到的文案：只认注册表那一份（判据=「文案来自真源」，不是「文案等于某串字面量」）
    expect(res.body.message).toBe(lookupErrorCode('HR_EMPLOYEES_FETCH_FAILED')!.message);
    // 独立判据（不抄真源）：给业务员看的话必须是中文、必须给出下一步动作
    expect(res.body.message).toMatch(/[一-龥]/);
    expect(res.body.message.length).toBeGreaterThanOrEqual(8);
    // 且该码确已在真源登记、档位与响应一致（半收敛的形态：调了真源但码没登记 ⇒ 这里红）
    expect(lookupErrorCode('HR_EMPLOYEES_FETCH_FAILED')!.status).toBe(500);
    // ★ 别名式收敛的执行版照妖镜（M2 变异实测）：把甄别腿改坏 ⇒ 本用例的码/文案任一条红或超时。
  }, 4000);

  it('业务 HrError「VALIDATION_FAILED」→ 400（请求不合法，§15.5.1）', async () => {
    const res = await callHr('post', '/hr/leave-requests', mk.leavePrisma(null), {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('业务 HrError「LEAVE_NOT_FOUND」→ 404（目标不存在，`*_NOT_FOUND` 档）', async () => {
    const res = await callHr('post', '/hr/leave-requests/lv_1/decide', mk.leavePrisma(null), { decision: 'Approved' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('LEAVE_NOT_FOUND');
  });

  it('业务 HrError「INVALID_TRANSITION」→ 409（与当前状态冲突，§15.5.12）', async () => {
    const res = await callHr(
      'post', '/hr/leave-requests/lv_1/decide',
      mk.leavePrisma({ id: 'lv_1', status: 'Approved', deletedAt: null }),
      { decision: 'Approved' },
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_TRANSITION');
  });

  it('★ 未登记码的**业务** HrError → 仍是 409（归因成立了才谈档位，不是 500）', async () => {
    // STATUS_VIA_EVENT_ONLY 不在真源登记表里（真源只显式登记 5 支码）。
    // 它由 HrError 抛出 ⇒ 「已经是业务冲突、只是没细分」⇒ 409；
    // 与上一条对照的是：同样「认不出」，非 HrError 才答 500（F2 的边界）。
    const prisma = {
      userAccount: { findUnique: vi.fn().mockResolvedValue({ id: 'u-1' }) },
      employeeProfile: { findUnique: vi.fn().mockResolvedValue({ userId: 'u-1', employmentStatus: 'Regular', deletedAt: null }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'alog_1' }) },
    };
    const res = await callHr('put', '/hr/employees/u-1', prisma, { employmentStatus: 'Resigned' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STATUS_VIA_EVENT_ONLY');
  });
});

/**
 * 卫生项（2026-09-03）：POST /hr/attendance 写入前校验 userId 外键存在。
 * AttendanceRecord 唯一外键列 = userId；不存在 → 400 中文错误且不落库（防孤儿考勤记录）。
 */
describe('HR 考勤写入外键校验（POST /hr/attendance）', () => {
  const prisma = {
    userAccount: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === 'user-exists' ? { id: 'user-exists' } : null,
      ),
    },
    attendanceRecord: { upsert: vi.fn().mockResolvedValue({ id: 'att_1', userId: 'user-exists', date: '2026-09-03' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'alog_1' }) },
  };

  it('userId 不存在 → 400 中文错误，不落库不写审计', async () => {
    const res = await request(makeApp(prisma))
      .post('/hr/attendance')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ userId: 'user-ghost', date: '2026-09-03', status: 'Normal' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain('userId 不存在');
    expect(prisma.attendanceRecord.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('userId 缺失 → 400', async () => {
    const res = await request(makeApp(prisma))
      .post('/hr/attendance')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ date: '2026-09-03' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('userId 必填');
  });

  it('userId 存在 → 通过校验并落库 → 200', async () => {
    const res = await request(makeApp(prisma))
      .post('/hr/attendance')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ userId: 'user-exists', date: '2026-09-03', checkIn: '09:00', checkOut: '18:00' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.attendanceRecord.upsert).toHaveBeenCalled();
  });
});
