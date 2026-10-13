import type { WorkflowEntityType } from './workflowAccess';

/**
 * Workflow Engine — 类型定义
 *
 * 工作流引擎支持多步审批、角色审批、指定用户审批。
 * 状态机：running → approved | rejected | cancelled
 * 每步：null(待审批) → approved | rejected | skipped
 */

/** 步骤定义（存在 WorkflowDefinition.steps JSON 中） */
export interface StepDef {
  /** 步骤名称（如"销售经理审批"） */
  name: string;
  /** 审批角色（如 'manager' | 'finance' | 'production_manager'） */
  approverRole?: string;
  /** 指定审批用户 ID（优先于角色） */
  approverUserId?: string;
  /** 步骤描述 */
  description?: string;
}

/** 工作流实例状态 */
export type WorkflowInstanceStatus = 'running' | 'approved' | 'rejected' | 'cancelled';

/** 步骤决策 */
export type WorkflowStepDecision = 'approved' | 'rejected' | 'skipped';

/** 实例查询过滤 */
export interface WorkflowInstanceFilter {
  actor?: import('../auth/service').TokenPayload | null;
  view?: 'visible' | 'mine' | 'pending';
  status?: WorkflowInstanceStatus;
  entityType?: string;
  entityId?: string;
  initiatedById?: string;
  /** 待我审批（基于角色或用户 ID） */
  pendingApproverUserId?: string;
  pendingApproverRole?: string;
  limit?: number;
  offset?: number;
}
/** Candidates are server-scoped business labels, never the company-wide
 * source list or financial/approval contents downloaded for client filtering. */
export interface WorkflowSourceCandidate { id: string; label: string; type: 'Order' | 'Invoice' | 'DevelopmentCase'; }
export interface WorkflowSourceFilter {
  actor?: import('../auth/service').TokenPayload | null;
  entityType: string;
  limit?: number;
  offset?: number;
}

/** 创建实例参数 */
export interface CreateInstanceParams {
  definitionId: string;
  entityType: string;
  entityId: string;
  title?: string;
  initiatedById?: string;
  actor?: import('../auth/service').TokenPayload | null;
  clientRequestId?: string;
}

/** 审批决策参数 */
export interface DecideStepParams {
  instanceId: string;
  decidedById: string;
  decision: 'approved' | 'rejected';
  note?: string;
  actor?: import('../auth/service').TokenPayload | null;
  clientRequestId?: string;
  expectedStepId?: string;
  expectedStepIndex?: number;
  sourceFingerprint?: string;
  confirmedReviewedContent?: boolean;
  rejectionReason?: string;
  requestedChanges?: string;
}

export interface WorkflowReviewBasis {
  entityType: WorkflowEntityType;
  frozen: Record<string, unknown>;
  current: Record<string, unknown>;
}

/** 工作流实例详情（含步骤） */
export interface WorkflowInstanceDetail {
  schemaVersion: 1;
  decisionScope: 'workflow_only';
  nativeBusinessApplied: false;
  definitionVersion: number | null;
  sourceFingerprint: string | null;
  reviewBasis: WorkflowReviewBasis | null;
  currentStepId: string | null;
  allowedActions: { approve: boolean; reject: boolean; cancel: boolean };
  blockedReason: string | null;
  acknowledgement?: WorkflowAcknowledgement;
  id: string;
  definitionId: string;
  definitionName: string;
  entityType: string;
  entityId: string;
  status: WorkflowInstanceStatus;
  currentStepIndex: number;
  title: string | null;
  initiatedById: string | null;
  initiatorName: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  steps: WorkflowStepDetail[];
}

export interface WorkflowStepDetail {
  id: string;
  stepIndex: number;
  stepName: string;
  approverRole: string | null;
  approverUserId: string | null;
  decision: WorkflowStepDecision | null;
  decisionNote: string | null;
  decidedById: string | null;
  deciderName: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** 默认工作流定义（seed 用） */
export interface DefaultWorkflowDefinition {
  id: string;
  name: string;
  description: string;
  entityType: string;
  triggerEvent?: string;
  steps: StepDef[];
}

export interface WorkflowCommandOptions {
  actor?: import('../auth/service').TokenPayload | null;
  clientRequestId?: string;
  expectedStepId?: string;
  expectedStepIndex?: number;
  sourceFingerprint?: string;
}
export interface WorkflowAcknowledgement {
  schemaVersion: 1;
  action: 'create' | 'approve' | 'reject' | 'cancel';
  clientRequestId: string;
  actorId: string;
  parameterHash: string;
  instanceId: string;
  stepId: string | null;
  status: WorkflowInstanceStatus;
  currentStepIndex: number;
  sourceFingerprint: string;
  auditId: string;
}
