/**
 * C3 HR 深化 — 前端 API 封装（/api/hr/*）
 *
 * 后端 HR 路由仅接受 owner/admin JWT（不接受 API-Key），
 * 因此此处统一走 Bearer token（与 HRManager 既有 fetchHR/sendHR 口径一致）。
 */
import { getApiBaseUrl } from './apiBase';

// ────────────────────────────────────────────────
// C3a 员工档案 + 生命周期
// ────────────────────────────────────────────────

export type EmploymentStatus = 'Probation' | 'Regular' | 'Suspended' | 'Resigned' | 'Terminated';

export type EmploymentEventType =
  | 'Onboard' | 'Regularize' | 'Transfer' | 'Promote' | 'Suspend' | 'Resume' | 'Resign' | 'Terminate';

export type ContractType = 'FixedTerm' | 'OpenEnded' | 'PartTime' | 'Intern';

export interface EmployeeProfile {
  id: string;
  userId: string;
  employeeNo: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  departmentId: string | null;
  department: string | null;
  positionId: string | null;
  position: string | null;
  hireDate: string;
  regularDate: string | null;
  contractType: string | null;
  contractEnd: string | null;
  employmentStatus: EmploymentStatus;
  phone: string | null;
  emergencyContact: string | null;
  workLocation: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmploymentEvent {
  id: string;
  userId: string;
  type: EmploymentEventType;
  effectiveDate: string;
  fromDeptId: string | null;
  toDeptId: string | null;
  fromPositionId: string | null;
  toPositionId: string | null;
  reason: string | null;
  operatorId: string | null;
  createdAt: string;
}

// ────────────────────────────────────────────────
// C3b 考勤 + 请假
// ────────────────────────────────────────────────

export type AttendanceStatus =
  | 'Normal' | 'Late' | 'EarlyLeave' | 'LateAndEarly' | 'Absent' | 'Leave' | 'Holiday' | 'Overtime';

export interface AttendanceRecord {
  id: string;
  userId: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  status: AttendanceStatus;
  workHours: number | null;
  note: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceSummaryRow {
  userId: string;
  displayName: string | null;
  days: number;
  late: number;
  earlyLeave: number;
  absent: number;
  leave: number;
  overtime: number;
  workHours: number;
}

export type LeaveType = 'Annual' | 'Sick' | 'Personal' | 'CompTime' | 'Maternity' | 'Other';
export type LeaveStatus = 'Pending' | 'Approved' | 'Rejected' | 'Cancelled';

export interface LeaveRequest {
  id: string;
  userId: string;
  type: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  approverId: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  displayName: string | null;
  approverName: string | null;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────
// C3c 薪资
// ────────────────────────────────────────────────

export interface SalaryStructure {
  id: string;
  userId: string;
  baseSalary: number;
  positionAllowance: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PayrollRunStatus = 'Draft' | 'Confirmed' | 'Paid';

export interface PayrollRun {
  id: string;
  period: string;
  status: PayrollRunStatus;
  totalNet: number;
  headcount: number;
  note: string | null;
  confirmedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollItem {
  id: string;
  runId: string;
  userId: string;
  base: number;
  allowance: number;
  overtimePay: number;
  commission: number;
  bonus: number;
  deduction: number;
  net: number;
  note: string | null;
  displayName: string | null;
  employeeNo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollRunDetail extends PayrollRun {
  items: PayrollItem[];
}

// ────────────────────────────────────────────────
// C3d 绩效
// ────────────────────────────────────────────────

export interface PerformanceCycle {
  id: string;
  name: string;
  period: string;
  status: 'Open' | 'Closed';
  startDate: string | null;
  endDate: string | null;
  reviewCount: number;
  confirmedCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ReviewStatus = 'Draft' | 'Submitted' | 'Confirmed';
export type ReviewGrade = 'A' | 'B' | 'C' | 'D';

/// C3d KPI 指标项 — 存入 PerformanceReview.kpi Json 字段（schema 注释「kpi Json 保持指标弹性」）
/// 设计意图：KPI 是周期相关的弹性数据，每项可关联 HR 项目（projectId 可选）
export interface KpiItem {
  /** 客户端生成的稳定 id（React key 用） */
  id: string;
  /** KPI 名称（必填，如「订单转化率」「样品准交率」） */
  name: string;
  /** 目标值描述（如「≥85%」「≤3 单/月」） */
  target: string;
  /** 权重 0-100，所有 KPI 项 sum(weight) <= 100 */
  weight: number;
  /** 单位（如「%」「单」「天」），可选 */
  unit?: string;
  /** 关联 HR 项目 id（可选，绩效绑定项目交付） */
  projectId?: string;
}

export interface PerformanceReview {
  id: string;
  cycleId: string;
  userId: string;
  selfScore: number | null;
  managerScore: number | null;
  finalScore: number | null;
  grade: ReviewGrade | null;
  /** KPI 指标列表（结构化 Json，null/[] 表示未设置） */
  kpi: KpiItem[] | null;
  comment: string | null;
  status: ReviewStatus;
  reviewerId: string | null;
  displayName: string | null;
  reviewerName: string | null;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────
// C3e 培训
// ────────────────────────────────────────────────

export type CourseStatus = 'Planned' | 'Ongoing' | 'Completed' | 'Cancelled';

export interface TrainingCourse {
  id: string;
  title: string;
  type: 'Internal' | 'External';
  instructor: string | null;
  startDate: string | null;
  endDate: string | null;
  capacity: number | null;
  status: CourseStatus;
  description: string | null;
  enrolledCount: number;
  completedCount: number;
  createdAt: string;
  updatedAt: string;
}

export type EnrollmentStatus = 'Enrolled' | 'Completed' | 'Absent' | 'Cancelled';

export interface TrainingEnrollment {
  id: string;
  courseId: string;
  userId: string;
  status: EnrollmentStatus;
  score: number | null;
  certificate: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────
// 常量（与 server/src/hr/hrService.ts 对齐）
// ────────────────────────────────────────────────

export const EMPLOYMENT_STATUS_OPTIONS: Array<{ value: EmploymentStatus; label: string }> = [
  { value: 'Probation', label: '试用期' },
  { value: 'Regular', label: '正式' },
  { value: 'Suspended', label: '停职' },
  { value: 'Resigned', label: '已离职' },
  { value: 'Terminated', label: '已终止' },
];

export const EMPLOYMENT_EVENT_OPTIONS: Array<{ value: EmploymentEventType; label: string }> = [
  { value: 'Onboard', label: '入职' },
  { value: 'Regularize', label: '转正' },
  { value: 'Transfer', label: '调岗' },
  { value: 'Promote', label: '晋升' },
  { value: 'Suspend', label: '停职' },
  { value: 'Resume', label: '复职' },
  { value: 'Resign', label: '离职' },
  { value: 'Terminate', label: '终止合同' },
];

export const CONTRACT_TYPE_OPTIONS: Array<{ value: ContractType; label: string }> = [
  { value: 'FixedTerm', label: '固定期限' },
  { value: 'OpenEnded', label: '无固定期限' },
  { value: 'PartTime', label: '兼职' },
  { value: 'Intern', label: '实习' },
];

export const ATTENDANCE_STATUS_OPTIONS: Array<{ value: AttendanceStatus; label: string }> = [
  { value: 'Normal', label: '正常' },
  { value: 'Late', label: '迟到' },
  { value: 'EarlyLeave', label: '早退' },
  { value: 'LateAndEarly', label: '迟到且早退' },
  { value: 'Absent', label: '缺勤' },
  { value: 'Leave', label: '请假' },
  { value: 'Holiday', label: '节假日' },
  { value: 'Overtime', label: '加班' },
];

export const LEAVE_TYPE_OPTIONS: Array<{ value: LeaveType; label: string }> = [
  { value: 'Annual', label: '年假' },
  { value: 'Sick', label: '病假' },
  { value: 'Personal', label: '事假' },
  { value: 'CompTime', label: '调休' },
  { value: 'Maternity', label: '产假' },
  { value: 'Other', label: '其他' },
];

export const LEAVE_STATUS_OPTIONS: Array<{ value: LeaveStatus; label: string }> = [
  { value: 'Pending', label: '待审批' },
  { value: 'Approved', label: '已批准' },
  { value: 'Rejected', label: '已拒绝' },
  { value: 'Cancelled', label: '已取消' },
];

export const PAYROLL_STATUS_OPTIONS: Array<{ value: PayrollRunStatus; label: string }> = [
  { value: 'Draft', label: '草稿' },
  { value: 'Confirmed', label: '已确认' },
  { value: 'Paid', label: '已发放' },
];

export const REVIEW_STATUS_OPTIONS: Array<{ value: ReviewStatus; label: string }> = [
  { value: 'Draft', label: '草稿' },
  { value: 'Submitted', label: '已提交' },
  { value: 'Confirmed', label: '已确认' },
];

export const REVIEW_GRADE_OPTIONS: Array<{ value: ReviewGrade; label: string }> = [
  { value: 'A', label: 'A（优秀）' },
  { value: 'B', label: 'B（良好）' },
  { value: 'C', label: 'C（合格）' },
  { value: 'D', label: 'D（待改进）' },
];

export const COURSE_STATUS_OPTIONS: Array<{ value: CourseStatus; label: string }> = [
  { value: 'Planned', label: '计划中' },
  { value: 'Ongoing', label: '进行中' },
  { value: 'Completed', label: '已完成' },
  { value: 'Cancelled', label: '已取消' },
];

export const ENROLLMENT_STATUS_OPTIONS: Array<{ value: EnrollmentStatus; label: string }> = [
  { value: 'Enrolled', label: '已报名' },
  { value: 'Completed', label: '已结业' },
  { value: 'Absent', label: '缺席' },
  { value: 'Cancelled', label: '已取消' },
];

// ────────────────────────────────────────────────
// 底层请求（JWT Bearer，与 HRManager 口径一致）
// ────────────────────────────────────────────────

const authToken = () =>
  localStorage.getItem('bambook_auth_token') || sessionStorage.getItem('bambook_auth_token');

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = authToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function fetchHR<T = any>(path: string): Promise<T> {
  const apiBase = getApiBaseUrl().replace(/\/$/, '');
  const res = await fetch(`${apiBase}/hr/${path}`, {
    headers: authHeaders(),
    credentials: authToken() ? 'omit' : 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).message || (data as any).error || `HTTP ${res.status}`);
  return data as T;
}

async function sendHR<T = any>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const apiBase = getApiBaseUrl().replace(/\/$/, '');
  const res = await fetch(`${apiBase}/hr/${path}`, {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    credentials: authToken() ? 'omit' : 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).message || (data as any).error || 'Operation failed');
  return data as T;
}

const qs = (params: Record<string, string | undefined>) => {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) query.set(k, v);
  }
  const s = query.toString();
  return s ? `?${s}` : '';
};

// ────────────────────────────────────────────────
// API 方法
// ────────────────────────────────────────────────

export const hrService = {
  // ── C3a 员工档案 ──
  async listEmployees(params: { status?: string; deptId?: string; q?: string } = {}): Promise<EmployeeProfile[]> {
    const data = await fetchHR(`employees${qs(params)}`);
    return data.employees || [];
  },

  async getEmployee(userId: string): Promise<EmployeeProfile> {
    const data = await fetchHR(`employees/${encodeURIComponent(userId)}`);
    return data.profile;
  },

  async upsertEmployee(input: {
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
  }): Promise<{ profile: EmployeeProfile; created: boolean }> {
    const { userId, ...body } = input;
    return sendHR(`employees/${encodeURIComponent(userId)}`, body, 'PUT');
  },

  async listEmploymentEvents(params: { userId?: string; type?: string; limit?: number } = {}): Promise<EmploymentEvent[]> {
    const data = await fetchHR(`employment-events${qs({
      userId: params.userId,
      type: params.type,
      limit: params.limit ? String(params.limit) : undefined,
    })}`);
    return data.events || [];
  },

  async recordEmploymentEvent(input: {
    userId: string;
    type: EmploymentEventType;
    effectiveDate: string;
    fromDeptId?: string | null;
    toDeptId?: string | null;
    fromPositionId?: string | null;
    toPositionId?: string | null;
    reason?: string | null;
  }): Promise<EmploymentEvent> {
    const data = await sendHR('employment-events', input);
    return data.event;
  },

  // ── C3b 考勤 ──
  async listAttendance(params: { userId?: string; month?: string; date?: string; status?: string } = {}): Promise<AttendanceRecord[]> {
    const data = await fetchHR(`attendance${qs(params)}`);
    return data.records || [];
  },

  async attendanceSummary(month: string): Promise<AttendanceSummaryRow[]> {
    const data = await fetchHR(`attendance/summary${qs({ month })}`);
    return data.summary || [];
  },

  async upsertAttendance(input: {
    userId: string;
    date: string;
    checkIn?: string | null;
    checkOut?: string | null;
    status?: string | null;
    note?: string | null;
  }): Promise<AttendanceRecord> {
    const data = await sendHR('attendance', input);
    return data.record;
  },

  // ── C3b 请假 ──
  async listLeaveRequests(params: { userId?: string; status?: string } = {}): Promise<LeaveRequest[]> {
    const data = await fetchHR(`leave-requests${qs(params)}`);
    return data.requests || [];
  },

  async createLeaveRequest(input: {
    userId: string;
    type: LeaveType;
    startDate: string;
    endDate: string;
    days: number;
    reason?: string | null;
  }): Promise<LeaveRequest> {
    const data = await sendHR('leave-requests', input);
    return data.request;
  },

  async decideLeaveRequest(id: string, decision: 'Approved' | 'Rejected', rejectReason?: string): Promise<LeaveRequest> {
    const data = await sendHR(`leave-requests/${encodeURIComponent(id)}/decide`, { decision, rejectReason });
    return data.request;
  },

  async cancelLeaveRequest(id: string): Promise<LeaveRequest> {
    const data = await sendHR(`leave-requests/${encodeURIComponent(id)}/cancel`, {});
    return data.request;
  },

  // ── C3c 薪资 ──
  async getSalaryHistory(userId: string): Promise<SalaryStructure[]> {
    const data = await fetchHR(`salary-structures/${encodeURIComponent(userId)}`);
    return data.structures || [];
  },

  async setSalaryStructure(input: {
    userId: string;
    baseSalary: number;
    positionAllowance?: number;
    currency?: string;
    effectiveFrom: string;
    note?: string | null;
  }): Promise<SalaryStructure> {
    const data = await sendHR('salary-structures', input);
    return data.structure ?? data;
  },

  async listPayrollRuns(): Promise<PayrollRun[]> {
    const data = await fetchHR('payroll-runs');
    return data.runs || [];
  },

  async getPayrollRun(id: string): Promise<PayrollRunDetail> {
    const data = await fetchHR(`payroll-runs/${encodeURIComponent(id)}`);
    return data.run;
  },

  async createPayrollRun(period: string, note?: string): Promise<PayrollRun> {
    const data = await sendHR('payroll-runs', { period, note });
    return data.run;
  },

  async generatePayrollItems(runId: string): Promise<{ generated: number; totalNet: number; headcount: number }> {
    return sendHR(`payroll-runs/${encodeURIComponent(runId)}/generate`, {});
  },

  async updatePayrollItem(id: string, input: Partial<Pick<PayrollItem, 'overtimePay' | 'commission' | 'bonus' | 'deduction' | 'note'>>): Promise<PayrollItem> {
    const data = await sendHR(`payroll-items/${encodeURIComponent(id)}`, input, 'PATCH');
    return data.item;
  },

  async confirmPayrollRun(runId: string): Promise<PayrollRun> {
    const data = await sendHR(`payroll-runs/${encodeURIComponent(runId)}/confirm`, {});
    return data.run;
  },

  async markPayrollPaid(runId: string): Promise<PayrollRun> {
    const data = await sendHR(`payroll-runs/${encodeURIComponent(runId)}/pay`, {});
    return data.run;
  },

  // ── C3d 绩效 ──
  async listPerformanceCycles(): Promise<PerformanceCycle[]> {
    const data = await fetchHR('performance-cycles');
    return data.cycles || [];
  },

  async createPerformanceCycle(input: { name: string; period: string; startDate?: string; endDate?: string }): Promise<PerformanceCycle> {
    const data = await sendHR('performance-cycles', input);
    return data.cycle;
  },

  async closePerformanceCycle(id: string): Promise<PerformanceCycle> {
    const data = await sendHR(`performance-cycles/${encodeURIComponent(id)}/close`, {});
    return data.cycle;
  },

  async listPerformanceReviews(params: { cycleId?: string; userId?: string; status?: string } = {}): Promise<PerformanceReview[]> {
    const data = await fetchHR(`performance-reviews${qs(params)}`);
    return data.reviews || [];
  },

  async upsertPerformanceReview(input: {
    cycleId: string;
    userId: string;
    selfScore?: number | null;
    kpi?: KpiItem[] | null;
    comment?: string | null;
    reviewerId?: string | null;
  }): Promise<PerformanceReview> {
    const data = await sendHR('performance-reviews', input, 'PUT');
    return data.review;
  },

  async submitPerformanceReview(id: string): Promise<PerformanceReview> {
    const data = await sendHR(`performance-reviews/${encodeURIComponent(id)}/submit`, {});
    return data.review;
  },

  async confirmPerformanceReview(id: string, input: { managerScore: number; finalScore: number; grade: ReviewGrade; comment?: string }): Promise<PerformanceReview> {
    const data = await sendHR(`performance-reviews/${encodeURIComponent(id)}/confirm`, input);
    return data.review;
  },

  // ── C3e 培训 ──
  async listTrainingCourses(params: { status?: string } = {}): Promise<TrainingCourse[]> {
    const data = await fetchHR(`training-courses${qs(params)}`);
    return data.courses || [];
  },

  async createTrainingCourse(input: {
    title: string;
    type?: 'Internal' | 'External';
    instructor?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    capacity?: number | null;
    description?: string | null;
  }): Promise<TrainingCourse> {
    const data = await sendHR('training-courses', input);
    return data.course;
  },

  async updateTrainingCourse(id: string, input: Partial<{
    title: string; type: 'Internal' | 'External'; instructor: string | null;
    startDate: string | null; endDate: string | null; capacity: number | null;
    status: CourseStatus; description: string | null;
  }>): Promise<TrainingCourse> {
    const data = await sendHR(`training-courses/${encodeURIComponent(id)}`, input, 'PATCH');
    return data.course;
  },

  async deleteTrainingCourse(id: string): Promise<void> {
    await sendHR(`training-courses/${encodeURIComponent(id)}`, undefined, 'DELETE');
  },

  async listEnrollments(params: { courseId?: string; userId?: string } = {}): Promise<TrainingEnrollment[]> {
    const data = await fetchHR(`training-enrollments${qs(params)}`);
    return data.enrollments || [];
  },

  async enrollTraining(courseId: string, userId: string): Promise<TrainingEnrollment> {
    const data = await sendHR(`training-courses/${encodeURIComponent(courseId)}/enroll`, { userId });
    return data.enrollment;
  },

  async updateEnrollment(id: string, input: { status?: EnrollmentStatus; score?: number | null; certificate?: string | null }): Promise<TrainingEnrollment> {
    const data = await sendHR(`training-enrollments/${encodeURIComponent(id)}`, input, 'PATCH');
    return data.enrollment;
  },
};
