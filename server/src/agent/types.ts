export type AgentRole =
  | 'owner'
  | 'admin'
  | 'manager'
  | 'merchandiser'
  | 'finance'
  | 'sales'
  | 'logistics'
  | 'production_manager'
  | 'factory'
  | 'viewer'
  | 'agent_operator';

export type ToolRisk = 'low' | 'medium' | 'high';

export type ActorContextInput = {
  userId: string;
  displayName?: string;
  roles?: AgentRole[];
  departmentIds?: string[];
  roleIds?: string[];
  permissions?: string[];
  authorizationLoaded?: true;
};

export type ActorContext = {
  userId: string;
  displayName?: string;
  roles: AgentRole[];
  departmentIds: string[];
  permissionScopes: string[];
  /** True only when identity resolved an explicit trusted authorization snapshot. */
  permissionsAuthoritative?: boolean;
  /** Trusted credential ceiling for an already-running API-key session. */
  permissionCeiling?: string[];
  memoryScopes: string[];
  knowledgeScopes: string[];
  toolScopes: string[];
};

export type KnowledgeHit = {
  title: string;
  category: string;
  content: string;
  source: string;
  scopes?: string[];
};

export type AgentAttachmentContext = {
  name: string;
  mimeType?: string;
  data?: string;
};

export type KnowledgeAccessTarget = {
  scopes?: string[];
};

export type ToolAccessTarget = {
  toolId: string;
  scope: string;
  risk: ToolRisk;
  input?: Record<string, unknown>;
};

export type PolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
};

export type AgentRunRequest = ActorContextInput & {
  sessionId: string;
  runtimeRunId?: string;
  actorUserId?: string;
  requestSource?: 'user-session' | 'api-key' | 'dev';
  message: string;
  history?: Array<{ role: string; content?: string; text?: string }>;
  attachments?: AgentAttachmentContext[];
  attachmentContext?: KnowledgeHit[];
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  emit?: (type: any, payload: Record<string, unknown>) => void;
};

export type AgentRunResult = {
  text: string;
  sources: Array<Record<string, unknown>>;
  thoughtProcess: string;
};
