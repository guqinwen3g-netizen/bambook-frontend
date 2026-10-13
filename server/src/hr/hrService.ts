/**
 * C3 HR 深化 — 员工全生命周期 / 考勤请假 / 薪资 / 绩效 / 培训 统一服务层
 *
 * 设计要点：
 *   1. EmployeeProfile 与 UserAccount 1:1，UserAccount 保持认证纯净，HR 业务字段全部落 Profile
 *   2. 生命周期事件（EmploymentEvent）是唯一状态变更入口：所有 employmentStatus / 岗位变动
 *      必须经 recordEmploymentEvent 写入历史流水，禁止直接改 Profile 状态字段
 *   3. 考勤每人每日一条（userId+date 唯一），upsert 语义；状态自动推导（迟到/早退）
 *   4. 请假状态机与退税审核同口径：Pending → Approved / Rejected / Cancelled
 *   5. 薪资结构变更留痕：新结构生效时旧结构 effectiveTo 自动封闭，当前生效恒为 effectiveTo=null
 *   6. 工资单批次状态机：Draft → Confirmed → Paid；仅 Draft 可生成/修改明细
 *   7. 绩效评定状态机：Draft → Submitted → Confirmed（自评→提交→主管终评）
 *   8. 事件发布：状态跃迁后 publishBusinessEvent（事务外、永不阻塞业务），
 *      EmployeeStatusChanged / LeaveRequestDecided 供通知引擎订阅
 */

import { PrismaClient } from '@prisma/client';
import { publishBusinessEvent } from '../events/businessEventBus';
import { invalidateAccountStatusCache } from '../auth/accountStatusGuard';
import { logger } from '../lib/logger';
// ★ 口径 C1：服务端工作日源（副本，真源 = utils/chinaHolidays.ts，同步守卫在 __tests__/chinaHolidaysSync）
import { countWorkdaysInclusive, listWorkdaysInclusive } from '../_shared/chinaHolidays';

// ────────────────────────────────────────────────────────────────
// 常量与类型
// ────────────────────────────────────────────────────────────────

export const EMPLOYMENT_STATUSES = ['Probation', 'Regular', 'Suspended', 'Resigned', 'Terminated'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const EMPLOYMENT_EVENT_TYPES = [
  'Onboard', 'Regularize', 'Transfer', 'Promote', 'Suspend', 'Resume', 'Resign', 'Terminate',
] as const;
export type EmploymentEventType = (typeof EMPLOYMENT_EVENT_TYPES)[number];

export const ATTENDANCE_STATUSES = [
  'Normal', 'Late', 'EarlyLeave', 'LateAndEarly', 'Absent', 'Leave', 'Holiday', 'Overtime',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const LEAVE_TYPES = ['Annual', 'Sick', 'Personal', 'CompTime', 'Maternity', 'Other'] as const;
export const LEAVE_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled'] as const;

export const CONTRACT_TYPES = ['FixedTerm', 'OpenEnded', 'PartTime', 'Intern'] as const;

export const REVIEW_GRADES = ['A', 'B', 'C', 'D'] as const;

/// C3d KPI 指标项 — 存入 PerformanceReview.kpi Json 字段
/// 设计真源：schema.prisma L1507「kpi Json 保持指标弹性」
/// 每项可关联 HR 项目（projectId 可选），实现剧本要求「KPI 表单 + 项目关联」
export interface KpiItem {
  id: string;
  name: string;
  target: string;
  weight: number;
  unit?: string;
  projectId?: string;
}

/**
 * 校验 KPI 指标列表 — 系统性根因校验（非特例补丁）：
 *  - 必须是数组（null/undefined 视为未设置，允许通过）
 *  - 每项 name 非空、weight 数值 0-100
 *  - sum(weight) <= 100（权重总和不超过满分）
 *  - projectId 可选，非空字符串才视为有效关联
 * 校验失败抛 HrError('VALIDATION_FAILED')
 */
function validateKpiItems(kpi: unknown): KpiItem[] | null {
  if (kpi === null || kpi === undefined) return null;
  if (!Array.isArray(kpi)) {
    throw new HrError('VALIDATION_FAILED', 'kpi 必须是数组');
  }
  let totalWeight = 0;
  const items: KpiItem[] = [];
  for (let i = 0; i < kpi.length; i++) {
    const item = kpi[i] as any;
    if (!item || typeof item !== 'object') {
      throw new HrError('VALIDATION_FAILED', `kpi[${i}] 必须是对象`);
    }
    const name = (item.name ?? '').toString().trim();
    if (!name) {
      throw new HrError('VALIDATION_FAILED', `kpi[${i}].name 必填`);
    }
    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      throw new HrError('VALIDATION_FAILED', `kpi[${i}].weight 须在 0-100`);
    }
    totalWeight += weight;
    const target = (item.target ?? '').toString();
    const id = (item.id ?? '').toString() || `kpi_${i}_${Date.now().toString(36)}`;
    const unit = item.unit != null ? (item.unit as string).toString() : undefined;
    const projectId = item.projectId != null && (item.projectId as string).toString().trim()
      ? (item.projectId as string).toString().trim()
      : undefined;
    items.push({ id, name, target, weight, unit, projectId });
  }
  if (totalWeight > 100) {
    throw new HrError('VALIDATION_FAILED', `KPI 权重总和 ${totalWeight} 超过 100`);
  }
  return items;
}

/** 标准工作时间（考勤自动推导口径） */
export const WORK_START = '09:30';
export const WORK_END = '17:30';

/** 生命周期事件 → 目标状态映射（Transfer/Promote 不改状态） */
const EVENT_TARGET_STATUS: Partial<Record<EmploymentEventType, EmploymentStatus>> = {
  Onboard: 'Probation',
  Regularize: 'Regular',
  Suspend: 'Suspended',
  Resume: 'Regular',
  Resign: 'Resigned',
  Terminate: 'Terminated',
};

/** 事件允许的前置状态（undefined = 不限） */
const EVENT_ALLOWED_FROM: Partial<Record<EmploymentEventType, EmploymentStatus[]>> = {
  Regularize: ['Probation'],
  Transfer: ['Probation', 'Regular'],
  Promote: ['Probation', 'Regular'],
  Suspend: ['Probation', 'Regular'],
  Resume: ['Suspended'],
  Resign: ['Probation', 'Regular', 'Suspended'],
  Terminate: ['Probation', 'Regular', 'Suspended'],
};

/**
 * ★ `Onboard` 的**拒绝**前置状态白名单（2026-09-17）。
 *
 * 只列「**明确不该重复入职**」的**在职**态。放行它们会让
 * `EVENT_TARGET_STATUS.Onboard = 'Probation'` 把 `Regular` **打回试用**（误点即降级）。
 *
 * ⚠️ `Resigned` / `Terminated` **故意不在其中** —— 那属于「**返聘**」，
 * 正确行为（同事务重新启用账号 / 直接拒绝 / 走独立「返聘」动作）**需业务口径**，
 * 见 `docs/业务口径决策单-2026-09-17.md` **C2**。**本白名单不替该口径做决定。**
 */
const ONBOARD_BLOCKED_FROM: EmploymentStatus[] = ['Probation', 'Regular', 'Suspended'];

/**
 * ★ **返聘**（C2，业务方 2026-09-17 口径）：可从这两个**终态**经 `Onboard` 复职。
 *
 * 业务方答复：「**允许返聘**，且 `Onboard` 时**同事务自动重新启用账号**」。
 * ⇒ 从这两个态 `Onboard` 时，除了把 `employmentStatus` 置回 `Probation`，
 *   还必须把 `UserAccount.status` 从 `disabled` **恢复为 active**
 *   —— 否则会出现「**档案复活了、却登不进系统**」的状态不一致。
 *
 * 与 K2（进入终态自动停账号）**语义对称**，见 `recordEmploymentEvent` 内的两个块。
 * 见 `docs/业务口径决策单-2026-09-17.md` **C2**。
 */
const REHIRE_FROM: EmploymentStatus[] = ['Resigned', 'Terminated'];

/**
 * HR `code → HTTP 档位` 的**唯一一条规则**（G6.5「每个口径一处实现」）。全仓再没有第二张码表。
 *
 * ★ 本函数**只答档位**：认得出的码给档位，认不出的码给 `undefined`。
 * 「认不出时答什么」不是一条档位，而是**调用方的兜底口径** —— 所以它被放进下面两个全函数包装里，
 * 各自一处、各自写明依据（Task 4b 复审 F2：把兜底混进档位表，等于让一个端点的兜底改写成另一个端点的档位）。
 *
 * 档位判据外部化（T1，docs/交付目标与验收标准-2026-09-20.md · G6.5 + HTTP 语义，RFC 9110）：
 * `UNAUTHORIZED` → 401（§15.5.2 未认证）、`FORBIDDEN` → 403（§15.5.3 无权限）、
 * `VALIDATION_FAILED` → 400（§15.5.1 请求不合法）、`TEAM_DISSOLVED` → 409（§15.5.12 状态冲突：
 * 对已解散的组再解散）、`INTERNAL_ERROR` → 500（§15.6.1 服务器意外故障 —— **唯一显式登记的 5xx 码**，
 * 500 只许这样点名登记，不许当落空兜底）、`*_NOT_FOUND` → 404（§15.5.5 目标不存在）。
 *
 * 为什么按 code 推、而不是给类写死一个数：`src/hr` 非测试文件里「码以字面量同行给出」的抛出点分三档，
 * 写死任何一个都会把另外两档答错（一条规则只实现一次，G6.5）。
 * ★ 数字已于 **2026-09-20 07:19 重新实测并更正**（旧稿写「81 个…44/16/21」差一，成因是本注释自身
 * 举的 `new HrError('CODE'` 例子被计入 ⇒ 数多了 1；正则数注释里的例子是这条判据的老坑）：
 *   口径 = `src/hr` 全部非测试 `.ts`、**剥注释后**、正则 `new HrError\(\s*'CODE'`
 *   ⇒ **80 处抛出点 / 15 个不同码**，档位 **400 档 43（全是 VALIDATION_FAILED）· 404 档 16 · 409 档 21**。
 *   机器核对以 `hrStatusForCode.test.ts` 的码集普查为准 —— 本行只是导读，不是判据。
 *
 * ★ Task 4b 收口（下面三个函数即唯一真源）：`hr/route.ts` 原先有三份副本 —— `hrErrorStatus` 函数体
 * 与两处 `statusMap` 内联表（删除组 / 解散组端点，处理 `dissolveTeam` 外发的**裸码** `result.error.code`）。
 * 收敛前逐码取差集（证据：`__tests__/hrStatusForCode.test.ts` 的 RED 记录），发现真源缺
 * `UNAUTHORIZED`/`FORBIDDEN`/`INTERNAL_ERROR` 三码（缺了会把 401/403/500 静默答成 409），
 * 已按 HTTP 语义补进上面，**不是**照抄被删副本的值：三码均非 HR 域抛出码
 * （`src/hr` 全部 `new HrError('…')` 的码集实测不含它们，见 domainErrorShapes 的码集普查），
 * 所以补码对既有 `HrError` 默认状态是**零改动**，只让路由副本可以删。
 *
 * 机器核对（守卫自测，G6.3）：`hr/__tests__/hrStatusForCode.test.ts` 结构钉「route.ts 不得再长
 * 内联码表、不得把数字兜底重新挂在委托上、必须引用本文件、且 500 兜底全仓只出现一处」；
 * `shared/__tests__/domainErrorShapes.test.ts` 的「跨文件真源核对」
 * 组认「import 真源 + 函数只剩 instanceof 甄别 + 委托」为终态，别名式/半收敛式/漂移式都有对照拦下。
 */
function hrStatusTierForCode(code: string): number | undefined {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'VALIDATION_FAILED') return 400;
  if (code === 'TEAM_DISSOLVED') return 409;
  if (code === 'INTERNAL_ERROR') return 500;
  if (code.endsWith('_NOT_FOUND')) return 404;
  return undefined; // 认不出 ⇒ 不替调用方决定兜底（兜底口径见下面两个包装）
}

/**
 * 包装 A —— **业务 `HrError`** 侧的全函数：真源认不出的码走「其余业务冲突」档 409。
 *
 * 依据：抛出点的**类型**已经把它归因成业务错误，剩下的分歧只是「没细分哪一种冲突」，
 * 409 Conflict（RFC 9110 §15.5.12）是该档的准确语义；且这一侧要求全函数 ——
 * `HrError.statusCode` 的默认值取自本函数，返回 undefined 会直接产出 `res.status(undefined)`。
 * 收口前 `hrErrorStatus` 的 `return 409` 兜底是同一条 ⇒ 该侧行为逐码不变。
 */
export function hrStatusForCode(code: string): number {
  return hrStatusTierForCode(code) ?? 409;
}

/**
 * 包装 B —— 路由拿到的是**裸码**（跨模块返回值、不是 `HrError` 实例）时用：认不出 ⇒ **500**。
 *
 * 为什么与包装 A 不同：裸码没有被归因给任何业务错误类，替它宣布「状态冲突（409）」是在断言
 * 一个系统并不掌握的业务事实；500（RFC 9110 §15.6.1 服务器意外故障）才是「我答不上来」的口径。
 *
 * ★ 本包装**恢复收口前的行为，不是改行为**：那两个端点原先写的是 `statusMap[code] || 500`，
 * 未登记的码本来就答 500；Task 4b 第一次收敛把这条腿并进了真源的 409 兜底（复审 F2 认定为
 * 未申报的行为变化），现在原样搬回来。全仓「认不出 ⇒ 500」这一条**只出现这一处**
 * （`hr/__tests__/hrStatusForCode.test.ts` 的计数钉 + route.ts 的「委托上不得再挂兜底」结构守卫）。
 * 已登记的码两包装同值：`UNAUTHORIZED` 401 / `FORBIDDEN` 403 / `TEAM_NOT_FOUND` 404 /
 * `TEAM_DISSOLVED` 409 / `INTERNAL_ERROR` 500 ⇒ 两端点响应逐码不变（F1 已补执行覆盖）。
 */
export function hrStatusForBareCode(code: string): number {
  return hrStatusTierForCode(code) ?? 500;
}

/**
 * HR 域业务错误（S0-A Task 4 核定：补齐透传契约）
 *
 * `safeRouteError` / `resolveError` 认「`code:string` + `statusCode:number`」为业务错误并透传文案。
 * 本类此前只有 `code` ⇒ 「KPI 权重总和 120 超过 100」这类**给业务员看的话**在接了真源的路径上
 * 会被吞成通用 500（Task 4b 之前 `hr/route.ts` 靠自己的副本活着，所以这个坑一直没爆；
 * 现在副本已删，类默认值与路由映射同出自 `hrStatusForCode`，爆不了也不该再爆）。
 * 参数顺序保持 `(code, message, statusCode?)` —— `code` 在前是既有抛出点的实签
 * （`src/hr` 非测试文件剥注释后实测 **80** 处 `new HrError(`，取样 2026-09-20 07:19；
 *  旧稿写 82 是把本注释自己举的两个例子也数进去了 —— 数注释里的字面量必须先剥注释），
 * 调换会让「码 / 文案」对调（brief 的示例体不可照抄）。
 * 第三参**带默认值且默认按 code 推** ⇒ 既有 `new HrError('VALIDATION_FAILED', '文案')` 一行都不用改，
 * 个别需要偏离码语义默认值的抛出点仍可显式覆写（当前无调用点这么做）。
 *
 * `code` 与 `statusCode` 都是 `readonly`：与另外四个业务类（`CrmValidationError` /
 * `SealValidationError` / `StageGateError` / `GateBlockedError`）一致，也防「抛出后被人就地改码」
 * 把外发契约改成运行时状态（评审 M-3）。
 */
export class HrError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = hrStatusForCode(code)) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ────────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function assertDate(s: unknown, field: string): asserts s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) throw new HrError('VALIDATION_FAILED', `${field} 须为 YYYY-MM-DD`);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 由打卡时间推导考勤状态（显式 status 优先，Absent/Leave/Holiday 等人工标记不被覆盖） */
function deriveAttendanceStatus(checkIn?: string | null, checkOut?: string | null, explicit?: string | null): AttendanceStatus {
  if (explicit && (ATTENDANCE_STATUSES as readonly string[]).includes(explicit)) return explicit as AttendanceStatus;
  const late = !!checkIn && TIME_RE.test(checkIn) && toMinutes(checkIn) > toMinutes(WORK_START);
  const early = !!checkOut && TIME_RE.test(checkOut) && toMinutes(checkOut) < toMinutes(WORK_END);
  if (late && early) return 'LateAndEarly';
  if (late) return 'Late';
  if (early) return 'EarlyLeave';
  return 'Normal';
}

function computeWorkHours(checkIn?: string | null, checkOut?: string | null): number | null {
  if (!checkIn || !checkOut || !TIME_RE.test(checkIn) || !TIME_RE.test(checkOut)) return null;
  const diff = toMinutes(checkOut) - toMinutes(checkIn);
  return diff > 0 ? Math.round((diff / 60) * 100) / 100 : null;
}

// ────────────────────────────────────────────────────────────────
// 服务主体
// ────────────────────────────────────────────────────────────────

export function createHrService(prisma: PrismaClient) {
  const db = prisma as any;

  // ════════════════════════════════════════════
  // C3a 员工档案
  // ════════════════════════════════════════════

  async function nextEmployeeNo(): Promise<string> {
    // P2002 重试兜底并发
    for (let attempt = 0; attempt < 5; attempt++) {
      const count = await db.employeeProfile.count();
      const candidate = `EMP${String(count + 1 + attempt).padStart(4, '0')}`;
      const clash = await db.employeeProfile.findUnique({ where: { employeeNo: candidate } });
      if (!clash) return candidate;
    }
    // 极端兜底：时间戳后缀
    return `EMP${Date.now().toString(36).toUpperCase()}`;
  }

  async function listProfiles(query: { status?: string; deptId?: string; q?: string } = {}) {
    const where: any = { deletedAt: null };
    if (query.status) where.employmentStatus = query.status;
    if (query.deptId) where.user = { primaryDeptId: query.deptId };
    const profiles = await db.employeeProfile.findMany({
      where,
      include: {
        user: { include: { primaryDepartment: true } },
        position: true,
      },
      orderBy: { employeeNo: 'asc' },
    });
    let rows = profiles.map(profileView);
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter((r: any) =>
        r.displayName?.toLowerCase().includes(q) || r.employeeNo.toLowerCase().includes(q) || r.email?.toLowerCase().includes(q));
    }
    return rows;
  }

  function profileView(p: any) {
    return {
      id: p.id,
      userId: p.userId,
      employeeNo: p.employeeNo,
      displayName: p.user?.displayName ?? null,
      email: p.user?.email ?? null,
      avatarUrl: p.user?.avatarUrl ?? null,
      departmentId: p.user?.primaryDeptId ?? null,
      department: p.user?.primaryDepartment?.name ?? null,
      positionId: p.positionId,
      position: p.position?.title ?? null,
      hireDate: p.hireDate,
      regularDate: p.regularDate,
      contractType: p.contractType,
      contractEnd: p.contractEnd,
      employmentStatus: p.employmentStatus,
      phone: p.phone,
      emergencyContact: p.emergencyContact,
      workLocation: p.workLocation,
      notes: p.notes,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  async function getProfile(userId: string) {
    const p = await db.employeeProfile.findUnique({
      where: { userId },
      include: { user: { include: { primaryDepartment: true } }, position: true },
    });
    if (!p || p.deletedAt) return null;
    return profileView(p);
  }

  async function upsertProfile(input: {
    userId: string;
    positionId?: string | null;
    hireDate?: string;
    regularDate?: string | null;
    contractType?: string | null;
    contractEnd?: string | null;
    employmentStatus?: string;
    phone?: string | null;
    emergencyContact?: string | null;
    workLocation?: string | null;
    notes?: string | null;
  }) {
    if (!input.userId) throw new HrError('VALIDATION_FAILED', 'userId 必填');
    const user = await db.userAccount.findUnique({ where: { id: input.userId } });
    if (!user) throw new HrError('USER_NOT_FOUND', `用户 ${input.userId} 不存在`);
    if (input.hireDate !== undefined) assertDate(input.hireDate, 'hireDate');
    if (input.regularDate) assertDate(input.regularDate, 'regularDate');
    if (input.contractEnd) assertDate(input.contractEnd, 'contractEnd');
    if (input.contractType && !(CONTRACT_TYPES as readonly string[]).includes(input.contractType)) {
      throw new HrError('VALIDATION_FAILED', `非法合同类型：${input.contractType}`);
    }
    // employmentStatus 不由此入口直接变更（须走生命周期事件），仅建档时允许指定初始状态
    const existing = await db.employeeProfile.findUnique({ where: { userId: input.userId } });
    if (existing && input.employmentStatus && input.employmentStatus !== existing.employmentStatus) {
      throw new HrError('STATUS_VIA_EVENT_ONLY', '在职状态变更必须经生命周期事件（recordEmploymentEvent）');
    }
    if (input.employmentStatus && !(EMPLOYMENT_STATUSES as readonly string[]).includes(input.employmentStatus)) {
      throw new HrError('VALIDATION_FAILED', `非法在职状态：${input.employmentStatus}`);
    }

    if (existing) {
      const updated = await db.employeeProfile.update({
        where: { userId: input.userId },
        data: {
          ...(input.positionId !== undefined && { positionId: input.positionId || null }),
          ...(input.hireDate !== undefined && { hireDate: input.hireDate }),
          ...(input.regularDate !== undefined && { regularDate: input.regularDate || null }),
          ...(input.contractType !== undefined && { contractType: input.contractType || null }),
          ...(input.contractEnd !== undefined && { contractEnd: input.contractEnd || null }),
          ...(input.phone !== undefined && { phone: input.phone || null }),
          ...(input.emergencyContact !== undefined && { emergencyContact: input.emergencyContact || null }),
          ...(input.workLocation !== undefined && { workLocation: input.workLocation || null }),
          ...(input.notes !== undefined && { notes: input.notes || null }),
        },
      });
      return { profile: updated, created: false };
    }

    if (!input.hireDate) throw new HrError('VALIDATION_FAILED', '建档必须提供 hireDate');
    const created = await db.employeeProfile.create({
      data: {
        id: genId('emp'),
        userId: input.userId,
        employeeNo: await nextEmployeeNo(),
        positionId: input.positionId || null,
        hireDate: input.hireDate,
        regularDate: input.regularDate || null,
        contractType: input.contractType || null,
        contractEnd: input.contractEnd || null,
        employmentStatus: input.employmentStatus || 'Probation',
        phone: input.phone || null,
        emergencyContact: input.emergencyContact || null,
        workLocation: input.workLocation || null,
        notes: input.notes || null,
      },
    });
    return { profile: created, created: true };
  }

  async function deleteProfile(userId: string) {
    await db.employeeProfile.updateMany({
      where: { userId, deletedAt: null },
      data: { deletedAt: BigInt(Date.now()) },
    });
    return { deleted: true };
  }

  // ════════════════════════════════════════════
  // C3a 生命周期事件（状态变更唯一入口）
  // ════════════════════════════════════════════

  async function recordEmploymentEvent(
    actorId: string,
    input: {
      userId: string;
      type: EmploymentEventType;
      effectiveDate: string;
      fromDeptId?: string | null;
      toDeptId?: string | null;
      fromPositionId?: string | null;
      toPositionId?: string | null;
      reason?: string | null;
    },
  ) {
    if (!(EMPLOYMENT_EVENT_TYPES as readonly string[]).includes(input.type)) {
      throw new HrError('VALIDATION_FAILED', `非法事件类型：${input.type}`);
    }
    assertDate(input.effectiveDate, 'effectiveDate');

    const user = await db.userAccount.findUnique({ where: { id: input.userId } });
    if (!user) throw new HrError('USER_NOT_FOUND', `用户 ${input.userId} 不存在`);

    let profile = await db.employeeProfile.findUnique({ where: { userId: input.userId } });

    // Onboard 允许无档案（自动建档）；其余事件必须有在职档案
    if (input.type === 'Onboard') {
      if (!profile || profile.deletedAt) {
        const { profile: created } = await upsertProfile({ userId: input.userId, hireDate: input.effectiveDate });
        profile = created;
      } else if ((ONBOARD_BLOCKED_FROM as readonly string[]).includes(profile.employmentStatus)) {
        // ★ 在职员工重复「入职」必须拒绝：`EVENT_TARGET_STATUS.Onboard = 'Probation'`，
        //   放行会把 `Regular` **打回试用**（没有任何业务解释能支持「正式员工因一次误点变试用」）。
        //   ⚠️ `Resigned`/`Terminated` **故意不在白名单里**：那是「返聘」，口径未定
        //      （见 `docs/业务口径决策单-2026-09-17.md` C2），**不擅自决定**。
        throw new HrError(
          'INVALID_TRANSITION',
          `员工当前为 ${profile.employmentStatus}（已在职），无需重复入职`,
        );
      }
    } else {
      if (!profile || profile.deletedAt) throw new HrError('PROFILE_NOT_FOUND', `用户 ${input.userId} 无员工档案，请先 Onboard`);
      const allowed = EVENT_ALLOWED_FROM[input.type];
      if (allowed && !allowed.includes(profile.employmentStatus)) {
        throw new HrError('INVALID_TRANSITION', `${input.type} 不允许从 ${profile.employmentStatus} 发起`);
      }
      if (['Resigned', 'Terminated'].includes(profile.employmentStatus)) {
        throw new HrError('INVALID_TRANSITION', `员工已${profile.employmentStatus === 'Resigned' ? '离职' : '终止'}，不可再变更`);
      }
    }

    // ★ **事件前状态必须显式快照**（2026-09-17 修）：
    //   下面的 `employeeProfile.update` 之后，`profile.employmentStatus` 是旧值还是新值，
    //   取决于驱动**是否原地改写对象** —— 真 Prisma 的 `findUnique` 返回新对象（⇒ 仍是旧值），
    //   而本仓内存 mock 的 `update` **原地改写行对象**（⇒ 已变新值）。
    //   依赖它 = 依赖 mock 实现细节 ⇒ 显式快照，两种驱动语义一致。
    //   用途：① 判断是否「从终态复职」（C2 返聘）② 事件 payload 的 `fromStatus`。
    const fromStatus = profile.employmentStatus;

    const event = await db.employmentEvent.create({
      data: {
        id: genId('evt'),
        userId: input.userId,
        type: input.type,
        effectiveDate: input.effectiveDate,
        fromDeptId: input.fromDeptId ?? null,
        toDeptId: input.toDeptId ?? null,
        fromPositionId: input.fromPositionId ?? null,
        toPositionId: input.toPositionId ?? null,
        reason: input.reason ?? null,
        operatorId: actorId,
      },
    });

    // 应用状态/岗位变动
    const targetStatus = EVENT_TARGET_STATUS[input.type];
    const profilePatch: any = {};
    if (targetStatus && profile.employmentStatus !== targetStatus) profilePatch.employmentStatus = targetStatus;
    if (input.type === 'Regularize') profilePatch.regularDate = input.effectiveDate;
    if ((input.type === 'Transfer' || input.type === 'Promote') && input.toPositionId !== undefined && input.toPositionId !== null) {
      profilePatch.positionId = input.toPositionId;
    }
    if (Object.keys(profilePatch).length > 0) {
      await db.employeeProfile.update({ where: { userId: input.userId }, data: profilePatch });
    }
    // 部门异动落 UserAccount.primaryDeptId
    if (input.toDeptId) {
      await db.userAccount.update({ where: { id: input.userId }, data: { primaryDeptId: input.toDeptId } });
    }

    // K2 离职自动停账号（批次二）：进入终态（Resigned/Terminated）即停用系统账号。
    // 复用 handover 既有停用语义（DR-056-③）：status='disabled' + metadata 留痕联链事件，
    // 停用后 invalidateAccountStatusCache 使未过期 JWT 经 accountStatusGuard 立即 401。
    // 幂等：已停用账号不重复写（如先走交接停用再补登记离职）。
    let accountDisabled = false;
    if ((targetStatus === 'Resigned' || targetStatus === 'Terminated') && user.status !== 'disabled') {
      await db.userAccount.update({
        where: { id: input.userId },
        data: {
          status: 'disabled',
          metadata: {
            ...((user.metadata as any) || {}),
            disabledAt: new Date().toISOString(),
            disabledBy: actorId || 'system',
            disabledReason: input.type === 'Resign' ? 'resignation' : 'termination',
            employmentEventId: event.id,
          },
        },
      });
      accountDisabled = true;
    }

    // ★ C2 返聘（业务方 2026-09-17 口径）：从终态（Resigned/Terminated）经 `Onboard` 复职时，
    //   **同事务重新启用系统账号** —— 与上面的 K2 停用**语义对称**。
    //   不做这一步的后果（真库实测过）：档案回到 Probation，但 `UserAccount.status` 仍是
    //   `disabled` ⇒ **「复活」了却登不进系统**（状态不一致）。
    //   幂等：已是 active 的账号不重复写。
    //   ⚠️ 用上面显式快照的 `fromStatus` 判断「是不是从终态复职」——
    //      **不要**用 `profile.employmentStatus`（内存 mock 的 update 会原地改写它）。
    let accountReenabled = false;
    if (input.type === 'Onboard' && (REHIRE_FROM as readonly string[]).includes(fromStatus)
        && user.status !== 'active') {
      await db.userAccount.update({
        where: { id: input.userId },
        data: {
          status: 'active',
          metadata: {
            ...((user.metadata as any) || {}),
            rehiredAt: new Date().toISOString(),
            rehiredBy: actorId || 'system',
            rehiredFromStatus: fromStatus,
            rehireEmploymentEventId: event.id,
          },
        },
      });
      accountReenabled = true;
    }

    // 事件发布（事务外，fire-and-forget）
    publishBusinessEvent({
      type: 'EmployeeStatusChanged',
      sourceEntityType: 'EmployeeProfile',
      sourceEntityId: profile.id,
      payload: {
        userId: input.userId,
        displayName: user.displayName,
        eventType: input.type,
        effectiveDate: input.effectiveDate,
        // ★ 用显式快照（同上）—— 原写法读 `profile.employmentStatus`，在会原地改写的驱动下会报成**改后**值
        fromStatus,
        toStatus: targetStatus ?? fromStatus,
        reason: input.reason ?? null,
      },
      actorId,
    }).catch(e => logger.warn('[HrService] publish EmployeeStatusChanged failed', { error: e?.message }));

    // 账号状态变更落库后即时失效账号状态缓存（同进程；跨进程由守卫 30s TTL 兜底）
    // ★ 返聘启用**同样要失效** —— 否则复职后仍会被 30s 内的旧缓存判为 disabled 而 401。
    if (accountDisabled || accountReenabled) invalidateAccountStatusCache(input.userId);

    return { event, accountDisabled, accountReenabled };
  }

  async function listEmploymentEvents(query: { userId?: string; type?: string; limit?: number } = {}) {
    const where: any = {};
    if (query.userId) where.userId = query.userId;
    if (query.type) where.type = query.type;
    return db.employmentEvent.findMany({
      where,
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(query.limit ?? 200, 500),
    });
  }

  // ════════════════════════════════════════════
  // C3b 考勤
  // ════════════════════════════════════════════

  async function upsertAttendance(input: {
    userId: string;
    date: string;
    checkIn?: string | null;
    checkOut?: string | null;
    status?: string | null;
    note?: string | null;
  }) {
    if (!input.userId) throw new HrError('VALIDATION_FAILED', 'userId 必填');
    assertDate(input.date, 'date');
    if (input.checkIn && !TIME_RE.test(input.checkIn)) throw new HrError('VALIDATION_FAILED', 'checkIn 须为 HH:MM');
    if (input.checkOut && !TIME_RE.test(input.checkOut)) throw new HrError('VALIDATION_FAILED', 'checkOut 须为 HH:MM');

    const status = deriveAttendanceStatus(input.checkIn, input.checkOut, input.status);
    const workHours = computeWorkHours(input.checkIn, input.checkOut);

    const record = await db.attendanceRecord.upsert({
      where: { userId_date: { userId: input.userId, date: input.date } },
      create: {
        id: genId('att'),
        userId: input.userId,
        date: input.date,
        checkIn: input.checkIn ?? null,
        checkOut: input.checkOut ?? null,
        status,
        workHours,
        note: input.note ?? null,
      },
      update: {
        ...(input.checkIn !== undefined && { checkIn: input.checkIn }),
        ...(input.checkOut !== undefined && { checkOut: input.checkOut }),
        status,
        workHours,
        ...(input.note !== undefined && { note: input.note }),
      },
    });
    return { record };
  }

  async function listAttendance(query: { userId?: string; month?: string; date?: string; status?: string } = {}) {
    const where: any = {};
    if (query.userId) where.userId = query.userId;
    if (query.month) {
      if (!/^\d{4}-\d{2}$/.test(query.month)) throw new HrError('VALIDATION_FAILED', 'month 须为 YYYY-MM');
      where.date = { startsWith: query.month };
    }
    if (query.date) where.date = query.date;
    if (query.status) where.status = query.status;
    const rows = await db.attendanceRecord.findMany({ where, orderBy: [{ date: 'desc' }, { userId: 'asc' }] });
    // 补充员工姓名
    const userIds = [...new Set(rows.map((r: any) => r.userId))] as string[];
    const users = await db.userAccount.findMany({ where: { id: { in: userIds } } });
    const nameOf = new Map(users.map((u: any) => [u.id, u.displayName]));
    return rows.map((r: any) => ({ ...r, displayName: nameOf.get(r.userId) ?? null }));
  }

  /** 月度考勤汇总：按人统计各状态天数 + 总工时 */
  async function attendanceSummary(month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HrError('VALIDATION_FAILED', 'month 须为 YYYY-MM');
    const rows = await db.attendanceRecord.findMany({ where: { date: { startsWith: month } } });
    const byUser = new Map<string, any>();
    for (const r of rows) {
      const agg = byUser.get(r.userId) ?? { userId: r.userId, days: 0, late: 0, earlyLeave: 0, absent: 0, leave: 0, overtime: 0, workHours: 0 };
      agg.days += 1;
      if (r.status === 'Late' || r.status === 'LateAndEarly') agg.late += 1;
      if (r.status === 'EarlyLeave' || r.status === 'LateAndEarly') agg.earlyLeave += 1;
      if (r.status === 'Absent') agg.absent += 1;
      if (r.status === 'Leave') agg.leave += 1;
      if (r.status === 'Overtime') agg.overtime += 1;
      agg.workHours += r.workHours ?? 0;
      byUser.set(r.userId, agg);
    }
    const userIds = [...byUser.keys()];
    const users = await db.userAccount.findMany({ where: { id: { in: userIds } } });
    const nameOf = new Map(users.map((u: any) => [u.id, u.displayName]));
    return [...byUser.values()].map(a => ({
      ...a,
      workHours: Math.round(a.workHours * 100) / 100,
      displayName: nameOf.get(a.userId) ?? null,
    }));
  }

  // ════════════════════════════════════════════
  // C3b 请假（Pending → Approved / Rejected / Cancelled）
  // ════════════════════════════════════════════

  async function createLeaveRequest(input: {
    userId: string;
    type: string;
    startDate: string;
    endDate: string;
    days: number;
    reason?: string | null;
  }) {
    if (!input.userId) throw new HrError('VALIDATION_FAILED', 'userId 必填');
    if (!(LEAVE_TYPES as readonly string[]).includes(input.type)) throw new HrError('VALIDATION_FAILED', `非法请假类型：${input.type}`);
    assertDate(input.startDate, 'startDate');
    assertDate(input.endDate, 'endDate');
    if (input.endDate < input.startDate) throw new HrError('VALIDATION_FAILED', 'endDate 不得早于 startDate');
    if (!Number.isFinite(input.days) || input.days <= 0) throw new HrError('VALIDATION_FAILED', 'days 须为正数');

    // ★ 口径 C1（2026-09-17 业务方拍板）：请假天数**按工作日算 + 支持半天**。
    //   修前：`days` 由调用方自填、与区间无关（跨周末照算、0.5 天被当 1 天）。
    //   现在：以区间内**工作日数**（扣周末 + 法定节假日，含调休上班日）为基准，
    //         `days` 只能等于「整段」或「少半天」（用于"最后一天请半天"这类真实场景）。
    //   ⇒ 跨周末/节假日不再虚增天数；半天假有了合法表达。
    //   见 docs/业务口径决策单-2026-09-17.md C1。
    const workdayCount = countWorkdaysInclusive(input.startDate, input.endDate);
    if (workdayCount === 0) {
      throw new HrError('VALIDATION_FAILED', '所选区间内没有工作日（全为周末/法定节假日），无需请假');
    }
    if (!Number.isInteger(input.days * 2)) {
      throw new HrError('VALIDATION_FAILED', `请假天数须为 0.5 的整数倍（当前 ${input.days}）`);
    }
    if (input.days > workdayCount) {
      throw new HrError(
        'VALIDATION_FAILED',
        `请假天数 ${input.days} 超过区间内的工作日数 ${workdayCount}（跨周末与法定节假日不计入）`,
      );
    }
    if (input.days < workdayCount - 0.5) {
      throw new HrError(
        'VALIDATION_FAILED',
        `请假天数 ${input.days} 少于区间内的工作日数 ${workdayCount}（最多只能少半天）`,
      );
    }

    const request = await db.leaveRequest.create({
      data: {
        id: genId('leave'),
        userId: input.userId,
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate,
        days: input.days,
        reason: input.reason ?? null,
        status: 'Pending',
      },
    });
    return { request };
  }

  async function decideLeaveRequest(actorId: string, id: string, decision: 'Approved' | 'Rejected', rejectReason?: string | null) {
    const req = await db.leaveRequest.findUnique({ where: { id } });
    if (!req || req.deletedAt) throw new HrError('LEAVE_NOT_FOUND', `请假单 ${id} 不存在`);
    if (req.status !== 'Pending') throw new HrError('INVALID_TRANSITION', `请假单当前状态 ${req.status}，不可审批`);
    if (decision === 'Rejected' && !rejectReason?.trim()) throw new HrError('VALIDATION_FAILED', '驳回必须填写理由');

    const updated = await db.leaveRequest.update({
      where: { id },
      data: {
        status: decision,
        approverId: actorId,
        approvedAt: new Date(),
        rejectReason: decision === 'Rejected' ? rejectReason!.trim() : null,
      },
    });

    // 审批通过 → 请假期间考勤自动标记 Leave（幂等：upsert 显式 status）
    // ★ 口径 C1（2026-09-17）：只标**工作日** —— 跨周末/法定节假日不再标 Leave
    //   （修前用 `enumerateDates` 标自然日 ⇒ 周末也被标成请假，考勤汇总虚高）。
    //   半天：`days` 比工作日数少 0.5 时，把**最后一个工作日**标注为半天。
    if (decision === 'Approved') {
      const workdays = listWorkdaysInclusive(req.startDate, req.endDate);
      const isHalfDayTail = Number(req.days) === workdays.length - 0.5;
      for (let i = 0; i < workdays.length; i++) {
        const half = isHalfDayTail && i === workdays.length - 1;
        await upsertAttendance({
          userId: req.userId,
          date: workdays[i],
          status: 'Leave',
          note: `请假单 ${req.id}${half ? '（半天）' : ''}`,
        });
      }
    }

    publishBusinessEvent({
      type: 'LeaveRequestDecided',
      sourceEntityType: 'LeaveRequest',
      sourceEntityId: id,
      payload: {
        userId: req.userId,
        leaveType: req.type,
        startDate: req.startDate,
        endDate: req.endDate,
        days: req.days,
        decision,
        rejectReason: decision === 'Rejected' ? rejectReason!.trim() : null,
      },
      actorId,
    }).catch(e => logger.warn('[HrService] publish LeaveRequestDecided failed', { error: e?.message }));

    return { request: updated };
  }

  async function cancelLeaveRequest(id: string) {
    const req = await db.leaveRequest.findUnique({ where: { id } });
    if (!req || req.deletedAt) throw new HrError('LEAVE_NOT_FOUND', `请假单 ${id} 不存在`);
    if (req.status !== 'Pending') throw new HrError('INVALID_TRANSITION', `仅 Pending 状态可撤销（当前 ${req.status}）`);
    const updated = await db.leaveRequest.update({ where: { id }, data: { status: 'Cancelled' } });
    return { request: updated };
  }

  async function listLeaveRequests(query: { userId?: string; status?: string } = {}) {
    const where: any = { deletedAt: null };
    if (query.userId) where.userId = query.userId;
    if (query.status) where.status = query.status;
    const rows = await db.leaveRequest.findMany({ where, orderBy: { createdAt: 'desc' } });
    const userIds = [...new Set(rows.flatMap((r: any) => [r.userId, r.approverId]).filter(Boolean))] as string[];
    const users = await db.userAccount.findMany({ where: { id: { in: userIds } } });
    const nameOf = new Map(users.map((u: any) => [u.id, u.displayName]));
    return rows.map((r: any) => ({
      ...r,
      displayName: nameOf.get(r.userId) ?? null,
      approverName: r.approverId ? nameOf.get(r.approverId) ?? null : null,
    }));
  }

  function enumerateDates(start: string, end: string): string[] {
    const out: string[] = [];
    const cur = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);
    let guard = 0;
    while (cur <= last && guard < 370) {
      out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
      cur.setDate(cur.getDate() + 1);
      guard += 1;
    }
    return out;
  }

  // ════════════════════════════════════════════
  // C3c 薪资结构与工资单
  // ════════════════════════════════════════════

  /** 设定薪资结构：封闭当前生效区间，写入新区间 */
  async function setSalaryStructure(input: {
    userId: string;
    baseSalary: number;
    positionAllowance?: number;
    currency?: string;
    effectiveFrom: string;
    note?: string | null;
  }) {
    if (!input.userId) throw new HrError('VALIDATION_FAILED', 'userId 必填');
    if (!Number.isFinite(input.baseSalary) || input.baseSalary < 0) throw new HrError('VALIDATION_FAILED', 'baseSalary 非法');
    assertDate(input.effectiveFrom, 'effectiveFrom');

    const current = await db.salaryStructure.findFirst({
      where: { userId: input.userId, effectiveTo: null },
    });
    if (current && input.effectiveFrom <= current.effectiveFrom) {
      throw new HrError('VALIDATION_FAILED', `effectiveFrom 必须晚于当前生效起点 ${current.effectiveFrom}`);
    }

    const [, created] = await prisma.$transaction([
      db.salaryStructure.updateMany({
        where: { userId: input.userId, effectiveTo: null },
        data: { effectiveTo: input.effectiveFrom },
      }),
      db.salaryStructure.create({
        data: {
          id: genId('sal'),
          userId: input.userId,
          baseSalary: input.baseSalary,
          positionAllowance: input.positionAllowance ?? 0,
          currency: input.currency ?? 'CNY',
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          note: input.note ?? null,
        },
      }),
    ]);
    return { structure: created, previousClosed: !!current };
  }

  async function getSalaryHistory(userId: string) {
    return db.salaryStructure.findMany({ where: { userId }, orderBy: { effectiveFrom: 'desc' } });
  }

  async function createPayrollRun(period: string, note?: string | null) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new HrError('VALIDATION_FAILED', 'period 须为 YYYY-MM');
    const existing = await db.payrollRun.findUnique({ where: { period } });
    if (existing) throw new HrError('DUPLICATE_PERIOD', `期间 ${period} 工资单已存在（${existing.status}）`);
    const run = await db.payrollRun.create({
      data: { id: genId('payrun'), period, note: note ?? null },
    });
    return { run };
  }

  /** 按当前生效薪资结构生成明细（仅 Draft；已存在明细的人员跳过 → 幂等） */
  async function generatePayrollItems(runId: string) {
    const run = await db.payrollRun.findUnique({ where: { id: runId } });
    if (!run) throw new HrError('RUN_NOT_FOUND', `工资单 ${runId} 不存在`);
    if (run.status !== 'Draft') throw new HrError('INVALID_TRANSITION', `仅 Draft 状态可生成明细（当前 ${run.status}）`);

    const profiles = await db.employeeProfile.findMany({
      where: { deletedAt: null, employmentStatus: { in: ['Probation', 'Regular', 'Suspended'] } },
    });
    let generated = 0;
    for (const p of profiles) {
      const structure = await db.salaryStructure.findFirst({ where: { userId: p.userId, effectiveTo: null } });
      if (!structure) continue; // 无薪资结构者不进入工资单
      const base = structure.baseSalary;
      const allowance = structure.positionAllowance ?? 0;
      const net = Math.round((base + allowance) * 100) / 100;
      try {
        await db.payrollItem.create({
          data: {
            id: genId('payitem'),
            runId,
            userId: p.userId,
            base,
            allowance,
            net,
          },
        });
        generated += 1;
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e; // 已生成 → 跳过（幂等）
      }
    }
    const totals = await recalcRunTotals(runId);
    return { generated, ...totals };
  }

  async function recalcRunTotals(runId: string) {
    const items = await db.payrollItem.findMany({ where: { runId } });
    const totalNet = Math.round(items.reduce((s: number, i: any) => s + (i.net ?? 0), 0) * 100) / 100;
    await db.payrollRun.update({ where: { id: runId }, data: { totalNet, headcount: items.length } });
    return { totalNet, headcount: items.length };
  }

  /** 调整明细（仅 Draft）；net 缺省自动重算 */
  async function updatePayrollItem(itemId: string, patch: {
    overtimePay?: number; commission?: number; bonus?: number; deduction?: number; note?: string | null;
  }) {
    const item = await db.payrollItem.findUnique({ where: { id: itemId }, include: { run: true } });
    if (!item) throw new HrError('ITEM_NOT_FOUND', `明细 ${itemId} 不存在`);
    if (item.run.status !== 'Draft') throw new HrError('INVALID_TRANSITION', `工资单已 ${item.run.status}，明细不可修改`);
    for (const field of ['overtimePay', 'commission', 'bonus', 'deduction'] as const) {
      const value = patch[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new HrError('VALIDATION_FAILED', `${field} 须为有效数值；零金额请明确填写 0`);
      }
    }

    const merged = {
      overtimePay: patch.overtimePay ?? item.overtimePay,
      commission: patch.commission ?? item.commission,
      bonus: patch.bonus ?? item.bonus,
      deduction: patch.deduction ?? item.deduction,
    };
    const net = Math.round((item.base + item.allowance + merged.overtimePay + merged.commission + merged.bonus - merged.deduction) * 100) / 100;
    const updated = await db.payrollItem.update({
      where: { id: itemId },
      data: { ...merged, net, ...(patch.note !== undefined && { note: patch.note }) },
    });
    await recalcRunTotals(item.runId);
    return { item: updated };
  }

  async function confirmPayrollRun(runId: string) {
    const run = await db.payrollRun.findUnique({ where: { id: runId }, include: { items: true } });
    if (!run) throw new HrError('RUN_NOT_FOUND', `工资单 ${runId} 不存在`);
    if (run.status !== 'Draft') throw new HrError('INVALID_TRANSITION', `仅 Draft 可确认（当前 ${run.status}）`);
    if (run.items.length === 0) throw new HrError('VALIDATION_FAILED', '空工资单不可确认，请先生成明细');
    const updated = await db.payrollRun.update({
      where: { id: runId },
      data: { status: 'Confirmed', confirmedAt: new Date() },
    });
    return { run: updated };
  }

  async function markPayrollPaid(runId: string) {
    const run = await db.payrollRun.findUnique({ where: { id: runId } });
    if (!run) throw new HrError('RUN_NOT_FOUND', `工资单 ${runId} 不存在`);
    if (run.status !== 'Confirmed') throw new HrError('INVALID_TRANSITION', `仅 Confirmed 可标记发放（当前 ${run.status}）`);
    const updated = await db.payrollRun.update({
      where: { id: runId },
      data: { status: 'Paid', paidAt: new Date() },
    });
    return { run: updated };
  }

  async function listPayrollRuns() {
    return db.payrollRun.findMany({ orderBy: { period: 'desc' } });
  }

  async function getPayrollRun(runId: string) {
    const run = await db.payrollRun.findUnique({ where: { id: runId }, include: { items: true } });
    if (!run) return null;
    const userIds = [...new Set(run.items.map((i: any) => i.userId))] as string[];
    const [users, profiles] = await Promise.all([
      db.userAccount.findMany({ where: { id: { in: userIds } } }),
      db.employeeProfile.findMany({ where: { userId: { in: userIds } } }),
    ]);
    const nameOf = new Map(users.map((u: any) => [u.id, u.displayName]));
    const empNoOf = new Map(profiles.map((p: any) => [p.userId, p.employeeNo]));
    return {
      ...run,
      items: run.items.map((i: any) => ({
        ...i,
        displayName: nameOf.get(i.userId) ?? null,
        employeeNo: empNoOf.get(i.userId) ?? null,
      })),
    };
  }

  // ════════════════════════════════════════════
  // C3d 绩效
  // ════════════════════════════════════════════

  async function createPerformanceCycle(input: { name: string; period: string; startDate?: string | null; endDate?: string | null }) {
    if (!input.name?.trim()) throw new HrError('VALIDATION_FAILED', 'name 必填');
    if (!input.period?.trim()) throw new HrError('VALIDATION_FAILED', 'period 必填');
    if (input.startDate) assertDate(input.startDate, 'startDate');
    if (input.endDate) assertDate(input.endDate, 'endDate');
    const existing = await db.performanceCycle.findUnique({ where: { period: input.period.trim() } });
    if (existing) throw new HrError('DUPLICATE_PERIOD', `考核期间 ${input.period} 已存在`);
    const cycle = await db.performanceCycle.create({
      data: {
        id: genId('cycle'),
        name: input.name.trim(),
        period: input.period.trim(),
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
      },
    });
    return { cycle };
  }

  async function closePerformanceCycle(cycleId: string) {
    const cycle = await db.performanceCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) throw new HrError('CYCLE_NOT_FOUND', `考核周期 ${cycleId} 不存在`);
    if (cycle.status !== 'Open') throw new HrError('INVALID_TRANSITION', `周期已 ${cycle.status}`);
    const updated = await db.performanceCycle.update({ where: { id: cycleId }, data: { status: 'Closed' } });
    return { cycle: updated };
  }

  async function listPerformanceCycles() {
    const cycles = await db.performanceCycle.findMany({
      orderBy: { period: 'desc' },
      include: { reviews: true },
    });
    return cycles.map((c: any) => ({
      ...c,
      reviewCount: c.reviews.length,
      confirmedCount: c.reviews.filter((r: any) => r.status === 'Confirmed').length,
      reviews: undefined,
    }));
  }

  /** 录入/更新评定（自评阶段）：upsert by (cycleId,userId)，仅 Draft 可改；kpi 数组结构化校验 */
  async function upsertPerformanceReview(input: {
    cycleId: string;
    userId: string;
    selfScore?: number | null;
    kpi?: KpiItem[] | null;
    comment?: string | null;
    reviewerId?: string | null;
  }) {
    const cycle = await db.performanceCycle.findUnique({ where: { id: input.cycleId } });
    if (!cycle) throw new HrError('CYCLE_NOT_FOUND', `考核周期 ${input.cycleId} 不存在`);
    if (cycle.status !== 'Open') throw new HrError('INVALID_TRANSITION', `周期已关闭，不可录入`);
    if (input.selfScore !== undefined && input.selfScore !== null && (input.selfScore < 0 || input.selfScore > 100)) {
      throw new HrError('VALIDATION_FAILED', '评分须在 0-100');
    }
    // KPI 列表结构化校验：name 非空、weight 0-100、sum(weight)<=100、projectId 可选
    const validatedKpi = input.kpi !== undefined ? validateKpiItems(input.kpi) : undefined;

    const existing = await db.performanceReview.findUnique({
      where: { cycleId_userId: { cycleId: input.cycleId, userId: input.userId } },
    });
    if (existing && existing.status !== 'Draft') {
      throw new HrError('INVALID_TRANSITION', `评定已 ${existing.status}，不可修改自评`);
    }
    const data: any = {
      ...(input.selfScore !== undefined && { selfScore: input.selfScore }),
      ...(validatedKpi !== undefined && { kpi: validatedKpi }),
      ...(input.comment !== undefined && { comment: input.comment }),
      ...(input.reviewerId !== undefined && { reviewerId: input.reviewerId }),
    };
    const review = existing
      ? await db.performanceReview.update({ where: { id: existing.id }, data })
      : await db.performanceReview.create({
          data: { id: genId('review'), cycleId: input.cycleId, userId: input.userId, ...data },
        });
    return { review };
  }

  async function submitPerformanceReview(reviewId: string) {
    const review = await db.performanceReview.findUnique({ where: { id: reviewId } });
    if (!review) throw new HrError('REVIEW_NOT_FOUND', `评定 ${reviewId} 不存在`);
    if (review.status !== 'Draft') throw new HrError('INVALID_TRANSITION', `仅 Draft 可提交（当前 ${review.status}）`);
    const updated = await db.performanceReview.update({ where: { id: reviewId }, data: { status: 'Submitted' } });
    return { review: updated };
  }

  /** 主管终评：Submitted → Confirmed，写入 managerScore/finalScore/grade */
  async function confirmPerformanceReview(reviewId: string, input: {
    managerScore: number; finalScore: number; grade: string; comment?: string | null; reviewerId?: string | null;
  }) {
    const review = await db.performanceReview.findUnique({ where: { id: reviewId } });
    if (!review) throw new HrError('REVIEW_NOT_FOUND', `评定 ${reviewId} 不存在`);
    if (review.status !== 'Submitted') throw new HrError('INVALID_TRANSITION', `仅 Submitted 可终评（当前 ${review.status}）`);
    for (const [k, v] of [['managerScore', input.managerScore], ['finalScore', input.finalScore]] as const) {
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new HrError('VALIDATION_FAILED', `${k} 须在 0-100`);
    }
    if (!(REVIEW_GRADES as readonly string[]).includes(input.grade)) throw new HrError('VALIDATION_FAILED', `非法评级：${input.grade}`);
    const updated = await db.performanceReview.update({
      where: { id: reviewId },
      data: {
        status: 'Confirmed',
        managerScore: input.managerScore,
        finalScore: input.finalScore,
        grade: input.grade,
        ...(input.comment !== undefined && { comment: input.comment }),
        ...(input.reviewerId !== undefined && { reviewerId: input.reviewerId }),
      },
    });
    return { review: updated };
  }

  async function listPerformanceReviews(query: { cycleId?: string; userId?: string; status?: string } = {}) {
    const where: any = {};
    if (query.cycleId) where.cycleId = query.cycleId;
    if (query.userId) where.userId = query.userId;
    if (query.status) where.status = query.status;
    const rows = await db.performanceReview.findMany({ where, orderBy: { createdAt: 'desc' } });
    const userIds = [...new Set(rows.flatMap((r: any) => [r.userId, r.reviewerId]).filter(Boolean))] as string[];
    const users = await db.userAccount.findMany({ where: { id: { in: userIds } } });
    const nameOf = new Map(users.map((u: any) => [u.id, u.displayName]));
    return rows.map((r: any) => ({
      ...r,
      displayName: nameOf.get(r.userId) ?? null,
      reviewerName: r.reviewerId ? nameOf.get(r.reviewerId) ?? null : null,
    }));
  }

  // ════════════════════════════════════════════
  // C3e 培训
  // ════════════════════════════════════════════

  async function createTrainingCourse(input: {
    title: string; type?: string; instructor?: string | null;
    startDate?: string | null; endDate?: string | null; capacity?: number | null; description?: string | null;
  }) {
    if (!input.title?.trim()) throw new HrError('VALIDATION_FAILED', 'title 必填');
    if (input.startDate) assertDate(input.startDate, 'startDate');
    if (input.endDate) assertDate(input.endDate, 'endDate');
    if (input.type && !['Internal', 'External'].includes(input.type)) throw new HrError('VALIDATION_FAILED', `非法课程类型：${input.type}`);
    const course = await db.trainingCourse.create({
      data: {
        id: genId('course'),
        title: input.title.trim(),
        type: input.type ?? 'Internal',
        instructor: input.instructor ?? null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        capacity: input.capacity ?? null,
        description: input.description ?? null,
      },
    });
    return { course };
  }

  async function updateTrainingCourse(id: string, patch: {
    title?: string; type?: string; instructor?: string | null; startDate?: string | null;
    endDate?: string | null; capacity?: number | null; status?: string; description?: string | null;
  }) {
    const course = await db.trainingCourse.findUnique({ where: { id } });
    if (!course || course.deletedAt) throw new HrError('COURSE_NOT_FOUND', `课程 ${id} 不存在`);
    if (patch.status && !['Planned', 'Ongoing', 'Completed', 'Cancelled'].includes(patch.status)) {
      throw new HrError('VALIDATION_FAILED', `非法课程状态：${patch.status}`);
    }
    const updated = await db.trainingCourse.update({
      where: { id },
      data: {
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.type !== undefined && { type: patch.type }),
        ...(patch.instructor !== undefined && { instructor: patch.instructor }),
        ...(patch.startDate !== undefined && { startDate: patch.startDate }),
        ...(patch.endDate !== undefined && { endDate: patch.endDate }),
        ...(patch.capacity !== undefined && { capacity: patch.capacity }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.description !== undefined && { description: patch.description }),
      },
    });
    return { course: updated };
  }

  async function deleteTrainingCourse(id: string) {
    await db.trainingCourse.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: BigInt(Date.now()) } });
    return { deleted: true };
  }

  async function listTrainingCourses(query: { status?: string } = {}) {
    const where: any = { deletedAt: null };
    if (query.status) where.status = query.status;
    const courses = await db.trainingCourse.findMany({
      where,
      include: { enrollments: true },
      orderBy: { createdAt: 'desc' },
    });
    return courses.map((c: any) => ({
      ...c,
      enrolledCount: c.enrollments.filter((e: any) => e.status === 'Enrolled' || e.status === 'Completed').length,
      completedCount: c.enrollments.filter((e: any) => e.status === 'Completed').length,
      enrollments: undefined,
    }));
  }

  async function enrollTraining(courseId: string, userId: string) {
    const course = await db.trainingCourse.findUnique({ where: { id: courseId }, include: { enrollments: true } });
    if (!course || course.deletedAt) throw new HrError('COURSE_NOT_FOUND', `课程 ${courseId} 不存在`);
    if (!['Planned', 'Ongoing'].includes(course.status)) throw new HrError('INVALID_TRANSITION', `课程已 ${course.status}，不可报名`);
    // 重复报名优先于容量检查（语义更准确：先告知"已报名"而非"名额已满"）
    if (course.enrollments.some((e: any) => e.userId === userId)) {
      throw new HrError('DUPLICATE_ENROLLMENT', '该员工已报名此课程');
    }
    const active = course.enrollments.filter((e: any) => e.status === 'Enrolled' || e.status === 'Completed');
    if (course.capacity != null && active.length >= course.capacity) {
      throw new HrError('CAPACITY_FULL', `课程名额已满（${course.capacity}）`);
    }
    try {
      const enrollment = await db.trainingEnrollment.create({
        data: { id: genId('enroll'), courseId, userId },
      });
      return { enrollment };
    } catch (e: any) {
      if (e?.code === 'P2002') throw new HrError('DUPLICATE_ENROLLMENT', '该员工已报名此课程');
      throw e;
    }
  }

  async function updateEnrollment(enrollmentId: string, patch: { status?: string; score?: number | null; certificate?: string | null }) {
    const enrollment = await db.trainingEnrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment) throw new HrError('ENROLLMENT_NOT_FOUND', `报名记录 ${enrollmentId} 不存在`);
    if (patch.status && !['Enrolled', 'Completed', 'Absent', 'Cancelled'].includes(patch.status)) {
      throw new HrError('VALIDATION_FAILED', `非法报名状态：${patch.status}`);
    }
    if (patch.score !== undefined && patch.score !== null && (patch.score < 0 || patch.score > 100)) {
      throw new HrError('VALIDATION_FAILED', '成绩须在 0-100');
    }
    const updated = await db.trainingEnrollment.update({
      where: { id: enrollmentId },
      data: {
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.score !== undefined && { score: patch.score }),
        ...(patch.certificate !== undefined && { certificate: patch.certificate }),
      },
    });
    return { enrollment: updated };
  }

  async function listEnrollments(query: { courseId?: string; userId?: string } = {}) {
    const where: any = {};
    if (query.courseId) where.courseId = query.courseId;
    if (query.userId) where.userId = query.userId;
    const rows = await db.trainingEnrollment.findMany({ where, orderBy: { createdAt: 'desc' } });
    const userIds = [...new Set(rows.map((r: any) => r.userId))] as string[];
    const users = await db.userAccount.findMany({ where: { id: { in: userIds } } });
    const nameOf = new Map(users.map((u: any) => [u.id, u.displayName]));
    return rows.map((r: any) => ({ ...r, displayName: nameOf.get(r.userId) ?? null }));
  }

  return {
    // C3a
    listProfiles, getProfile, upsertProfile, deleteProfile,
    recordEmploymentEvent, listEmploymentEvents,
    // C3b
    upsertAttendance, listAttendance, attendanceSummary,
    createLeaveRequest, decideLeaveRequest, cancelLeaveRequest, listLeaveRequests,
    // C3c
    setSalaryStructure, getSalaryHistory,
    createPayrollRun, generatePayrollItems, updatePayrollItem,
    confirmPayrollRun, markPayrollPaid, listPayrollRuns, getPayrollRun,
    // C3d
    createPerformanceCycle, closePerformanceCycle, listPerformanceCycles,
    upsertPerformanceReview, submitPerformanceReview, confirmPerformanceReview, listPerformanceReviews,
    // C3e
    createTrainingCourse, updateTrainingCourse, deleteTrainingCourse, listTrainingCourses,
    enrollTraining, updateEnrollment, listEnrollments,
  };
}

export type HrService = ReturnType<typeof createHrService>;
