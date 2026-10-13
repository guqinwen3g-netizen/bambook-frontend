/**
 * company-sim/hr-org.ts — HR 组织域补数（2026-09-03 上线日审计 P2 修复 6/7）
 *
 * 修复 6：SIM 跟单 3 账号（Grace Liu/Tony Fang/Ivy Zhang）挂 role-sales（业务员：
 *         业务部一线跟单/报价/开发）+ dept-sales——此前 active 但零角色，
 *         登录只见 Dashboard/Settings/Calendar 三页（UAT 会被问）；幂等 upsert 防重放丢失。
 * 修复 7：JobPosition 9 岗位 + EmployeeProfile.positionId 挂接（12 员工）+
 *         TrainingCourse 3 门 + TrainingEnrollment 9 条 + AttendanceRecord 48 条
 *         （2026-08-31~09-03 四个工作日——9 月默认月视图首日非空）。
 *
 * 幂等：全部确定性 ID + upsert/skipDuplicates，重放安全。
 */

import { PrismaClient } from '@prisma/client';
import { USERS, SIM_EXTRA_ACCOUNTS, createManyLogged } from './common';

const ROLE_SALES = 'role-sales';
const DEPT_SALES = 'dept-sales';

/** 9 岗位（departmentId 挂 seed-rbac 部门） */
const POSITIONS: Array<{
  id: string; title: string; departmentId: string; headcount: number; description: string;
}> = [
  { id: 'SIM-POS-001', title: '总经理', departmentId: 'dept-management', headcount: 1, description: '公司整体经营与重大决策' },
  { id: 'SIM-POS-002', title: '分管副总', departmentId: 'dept-management', headcount: 1, description: '业务与供应链分管' },
  { id: 'SIM-POS-003', title: '销售主管', departmentId: 'dept-sales', headcount: 1, description: '业务部小团队负责人' },
  { id: 'SIM-POS-004', title: '业务员', departmentId: 'dept-sales', headcount: 3, description: '客户开发/报价/订单承接' },
  { id: 'SIM-POS-005', title: '跟单员', departmentId: 'dept-sales', headcount: 3, description: '订单生产跟进/面料跟踪/驻场验货' },
  { id: 'SIM-POS-006', title: '财务经理', departmentId: 'dept-finance', headcount: 1, description: '财务部负责人' },
  { id: 'SIM-POS-007', title: '会计', departmentId: 'dept-finance', headcount: 1, description: '核算/开票/回款对账' },
  { id: 'SIM-POS-008', title: 'QC 主管', departmentId: 'dept-qc', headcount: 1, description: '质检管理（驻场）' },
  { id: 'SIM-POS-009', title: '物流主管', departmentId: 'dept-logistics', headcount: 1, description: '出运/单证/报关协调' },
];

/** userId → positionId（与 hr-kb.ts 12 员工一一对应） */
const POSITION_BY_USER: Record<string, string> = {
  [USERS.boss]: 'SIM-POS-001',
  [USERS.gm]: 'SIM-POS-002',
  [USERS.salesManager]: 'SIM-POS-003',
  [USERS.salesA]: 'SIM-POS-004',
  [USERS.salesB]: 'SIM-POS-004',
  [USERS.financeManager]: 'SIM-POS-006',
  [USERS.finance]: 'SIM-POS-007',
  [USERS.qc]: 'SIM-POS-008',
  [USERS.logistics]: 'SIM-POS-009',
  [SIM_EXTRA_ACCOUNTS[0].id]: 'SIM-POS-005',
  [SIM_EXTRA_ACCOUNTS[1].id]: 'SIM-POS-005',
  [SIM_EXTRA_ACCOUNTS[2].id]: 'SIM-POS-005',
};

/** 3 门培训（2 Completed + 1 Planned） */
const COURSES: Array<{
  id: string; title: string; type: string; instructor: string;
  startDate: string; endDate: string | null; capacity: number; status: string; description: string;
}> = [
  {
    id: 'SIM-TRN-001', title: '面料知识与成分识别', type: 'Internal', instructor: 'Wilson Wu',
    startDate: '2026-08-12', endDate: '2026-08-12', capacity: 20, status: 'Completed',
    description: '常见针织/梭织面料成分、克重与手感辨识，结合本季主推面料实物讲解',
  },
  {
    id: 'SIM-TRN-002', title: '外贸实务与信用证结算', type: 'External', instructor: '上海外贸协会 王讲师',
    startDate: '2026-08-19', endDate: '2026-08-20', capacity: 15, status: 'Completed',
    description: '信用证条款审核、单证不符点处理与跨境结算实务',
  },
  {
    id: 'SIM-TRN-003', title: 'QC 验货标准（AQL 2.5/4.0）', type: 'Internal', instructor: 'Wilson Wu',
    startDate: '2026-09-14', endDate: '2026-09-15', capacity: 12, status: 'Planned',
    description: '终期验货抽样方案与疵点判定，新跟单必修',
  },
];

/** 9 条报名（已完课程带成绩，Planned 课程 Enrolled） */
const ENROLLMENTS: Array<{
  id: string; courseId: string; userId: string; status: string; score: number | null;
}> = [
  { id: 'SIM-TRE-001', courseId: 'SIM-TRN-001', userId: SIM_EXTRA_ACCOUNTS[0].id, status: 'Completed', score: 88 },
  { id: 'SIM-TRE-002', courseId: 'SIM-TRN-001', userId: SIM_EXTRA_ACCOUNTS[1].id, status: 'Completed', score: 92 },
  { id: 'SIM-TRE-003', courseId: 'SIM-TRN-001', userId: SIM_EXTRA_ACCOUNTS[2].id, status: 'Completed', score: 85 },
  { id: 'SIM-TRE-004', courseId: 'SIM-TRN-001', userId: USERS.salesA, status: 'Completed', score: 90 },
  { id: 'SIM-TRE-005', courseId: 'SIM-TRN-002', userId: USERS.salesB, status: 'Completed', score: 86 },
  { id: 'SIM-TRE-006', courseId: 'SIM-TRN-002', userId: USERS.finance, status: 'Completed', score: 94 },
  { id: 'SIM-TRE-007', courseId: 'SIM-TRN-002', userId: USERS.logistics, status: 'Completed', score: 89 },
  { id: 'SIM-TRE-008', courseId: 'SIM-TRN-003', userId: SIM_EXTRA_ACCOUNTS[0].id, status: 'Enrolled', score: null },
  { id: 'SIM-TRE-009', courseId: 'SIM-TRN-003', userId: SIM_EXTRA_ACCOUNTS[2].id, status: 'Enrolled', score: null },
];

/** 考勤 4 个工作日（08-31 周一 ~ 09-03 周四·今天；09-03 未下班 checkOut 留空） */
const ATTENDANCE_DATES = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'];
const ATTENDANCE_TODAY = '2026-09-03';

/** 与 hr-kb.ts 12 员工同序（索引即 empDefs 顺序） */
const ATTENDANCE_USERS: Array<{ userId: string; name: string }> = [
  { userId: USERS.boss, name: 'Jason Shen' },
  { userId: USERS.gm, name: 'Raymond Lin' },
  { userId: USERS.salesManager, name: 'Vivian Chen' },
  { userId: USERS.salesA, name: 'Chloe Su' },
  { userId: USERS.salesB, name: 'Marcus Zhou' },
  { userId: USERS.financeManager, name: 'Melissa Zhao' },
  { userId: USERS.finance, name: 'Charlie Qian' },
  { userId: USERS.qc, name: 'Wilson Wu' },
  { userId: USERS.logistics, name: 'Hank Zheng' },
  { userId: SIM_EXTRA_ACCOUNTS[0].id, name: 'Grace Liu' },
  { userId: SIM_EXTRA_ACCOUNTS[1].id, name: 'Tony Fang' },
  { userId: SIM_EXTRA_ACCOUNTS[2].id, name: 'Ivy Zhang' },
];

/** pad2 */
const p2 = (n: number): string => String(n).padStart(2, '0');

export async function seedHrOrg(prisma: PrismaClient): Promise<void> {
  console.log('── HR 组织域：跟单角色挂接 + 岗位/培训/考勤补数 ──');

  // 1. 修复 6：SIM 跟单 3 账号 → role-sales（业务员）@ dept-sales（幂等 upsert）
  for (const acc of SIM_EXTRA_ACCOUNTS) {
    await prisma.userRole.upsert({
      where: {
        userId_roleId_departmentId: {
          userId: acc.id, roleId: ROLE_SALES, departmentId: DEPT_SALES,
        },
      },
      update: {},
      create: {
        id: `SIM-UR-${acc.id}`, userId: acc.id, roleId: ROLE_SALES, departmentId: DEPT_SALES,
      },
    });
  }
  console.log(`  UserRole: 3 跟单账号 → role-sales @ ${DEPT_SALES}`);

  // 2. 修复 7a：JobPosition 9 岗位
  await createManyLogged(prisma, 'jobPosition', 'JobPosition 岗位', POSITIONS.map(pos => ({
    id: pos.id, title: pos.title, departmentId: pos.departmentId,
    description: pos.description, headcount: pos.headcount, status: 'active',
  })));

  // 2b. EmployeeProfile.positionId 挂接（幂等 update）
  let linked = 0;
  for (const [userId, positionId] of Object.entries(POSITION_BY_USER)) {
    const r = await prisma.employeeProfile.updateMany({
      where: { userId, positionId: null, deletedAt: null },
      data: { positionId },
    });
    linked += r.count;
  }
  console.log(`  EmployeeProfile.positionId 挂接: ${linked} 人（其余已挂接跳过）`);

  // 3. 修复 7b：培训 3 门 + 报名 9 条
  await createManyLogged(prisma, 'trainingCourse', 'TrainingCourse 培训', COURSES);
  await createManyLogged(prisma, 'trainingEnrollment', 'TrainingEnrollment 培训报名', ENROLLMENTS);

  // 4. 修复 7c：考勤 12 人 × 4 工作日 = 48 条（确定性排布：多数 Normal、少量 Late、1 例 Leave）
  const attRows: Array<{
    id: string; userId: string; date: string; checkIn: string | null; checkOut: string | null;
    status: string; workHours: number | null; note: string | null;
  }> = [];
  ATTENDANCE_USERS.forEach((u, i) => {
    ATTENDANCE_DATES.forEach((date, d) => {
      const id = `SIM-ATT-${String(i + 1).padStart(2, '0')}-${date}`;
      // 剧情位：Chloe Su（i=3）09-01 年假一天
      if (i === 3 && date === '2026-09-01') {
        attRows.push({ id, userId: u.userId, date, checkIn: null, checkOut: null, status: 'Leave', workHours: null, note: '年假' });
        return;
      }
      // 每 6 条出现 1 例迟到（确定性：checkIn 09:1x）
      const late = (i + d) % 6 === 5;
      const checkIn = late ? `09:${p2(10 + i)}` : `08:${p2(30 + i)}`;
      const isToday = date === ATTENDANCE_TODAY;
      const checkOut = isToday ? null : `18:${p2((5 + i) % 60)}`;
      attRows.push({
        id, userId: u.userId, date,
        checkIn, checkOut,
        status: late ? 'Late' : 'Normal',
        workHours: isToday ? null : 8.5,
        note: late ? '早高峰地铁延误' : null,
      });
    });
  });
  await createManyLogged(prisma, 'attendanceRecord', 'AttendanceRecord 考勤', attRows);
}
