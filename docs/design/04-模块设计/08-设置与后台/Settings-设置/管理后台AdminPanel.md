# 管理后台 AdminPanel 设计

> 模块代号：`Settings / AdminPanel`
> 父模块：[Settings 账户与系统配置](./账户与系统配置.md)
> 关联代码：`components/AdminPanel.tsx`、`components/WorkflowPanel.tsx`、`server/src/admin/route.ts`、`server/src/auth/middleware.ts`（requireRole）、`server/src/auth/moduleGuard.ts`（createModuleAuthGuard）、`server/src/audit/entityQuery.ts`（buildAuditLogQuery）
> 文档版本：v1.0 · 最后更新：2026-08-15

---

## §1 实现状态

| 维度 | 状态 | 说明 |
| --- | --- | --- |
| 7 Tab 架构 | ✅ 已落地 | `TABS` 数组：users / roles / knowledge-acl / tool-perms / approvals / workflow / audit-logs。 |
| 用户管理 | ✅ 已落地 | users Tab：用户列表（status 过滤）+ 创建/编辑/停用/删除用户 + 角色分配 + 部门关联。 |
| 角色与权限 | ✅ 已落地 | roles Tab：8 角色（viewer/merchandiser/sales/finance/manager/agent_operator/admin/owner）+ 25 权限项 + 行级权限矩阵。 |
| 知识库权限 | ✅ 已落地 | knowledge-acl Tab：`KnowledgeAcl` 行级 ACL 配置（scope = company/department/team/private × access = read/write/admin/none）。 |
| 工具权限 | ✅ 已落地 | tool-perms Tab：`AgentToolPermission` 配置（access = execute/read/admin/none × riskMode = direct/approval/disabled）。 |
| 学习与审批 | ✅ 已落地 | approvals Tab：学习审批 + 操作审批。 |
| 工作流审批 | ✅ 已落地 | workflow Tab：`WorkflowPanel` 组件，工作流审批流配置与处理。 |
| 系统日志 | ✅ 已落地 | audit-logs Tab：`AuditLog` 查询（通过 `buildAuditLogQuery`），含 actor/action/targetType/operationType/fieldPath/transactionId 多维过滤。 |
| 路由层 | ✅ 已落地 | `server/src/admin/route.ts`：用户 CRUD + 角色 + 审计日志 + 邮件通知。 |
| 鉴权 | ✅ 已落地 | `createModuleAuthGuard` + `requireRole('owner', 'admin')`：admin 路由仅 owner/admin 可访问；API-Key 单独访问 → 401。 |
| 用户 ID 生成 | ✅ 已落地 | `generateUserAccountId(prisma, email, displayName)`：`user_{slug}_{random6}` 格式，6 次重试防碰撞。 |
| 软删除 | ✅ 已落地 | 用户删除支持「停用」与「抹除个人数据」两种模式（metadata.deletionMode）。 |
| 邮件通知 | ✅ 已落地 | 审批通过时 `buildApprovalApprovedEmail` + `EmailService` 发送通知邮件。 |
| 会话缓存 | ✅ 已落地 | `ADMIN_PANEL_SESSION_CACHE_KEY = 'bambook_admin_panel_session_cache_v1'`：Tab 切换缓存。 |
| BDS v2.1 主题 | ✅ 已落地 | 使用 `BAMBOOK_OS` token + flat 设计 + 大圆角。 |

---

## §2 业务定位与目标

### 2.1 业务定位

AdminPanel 是 Bambook 的「**企业管理中枢**」——承载用户/角色/权限/审批/审计五大管理维度，是企业级 RBAC（Role-Based Access Control）与可观测性的统一入口。

### 2.2 核心目标

1. **RBAC 权限闭环**：角色 → 权限 → 行级 ACL → 工具权限四层权限模型
2. **审批可追溯**：学习审批 + 工作流审批 + 邮件通知
3. **审计可查**：所有写操作同事务写 AuditLog，支持多维查询
4. **仅 owner/admin 可访问**：admin 路由强制 `requireRole('owner', 'admin')`
5. **API-Key 拒绝**：即使配置 API-Key，admin 路由也仅接受 JWT

---

## §3 核心概念与术语

| 术语 | 定义 |
| --- | --- |
| `AVAILABLE_ROLES` | 8 角色枚举：viewer/merchandiser/sales/finance/manager/agent_operator/admin/owner |
| `ROLE_LABELS` | 角色中文标签映射 |
| `PERMISSION_LABELS` | 25 权限项中文标签映射（users:read/write/delete, orders:read/write/delete, ...） |
| `ACCESS_LABELS` | 4 级访问：read/write/execute/admin/none |
| `RISK_MODE_LABELS` | 3 种风险模式：direct/approval/disabled |
| `KNOWLEDGE_SCOPES` | 知识库 4 scope：company/department/team/private |
| `ACCESS_LEVELS` | 4 访问级：read/write/admin/none |
| `TOOL_ACCESS_LEVELS` | 工具 4 访问级：execute/read/admin/none |
| `RISK_MODES` | 3 风险模式：direct/approval/disabled |
| `ADMIN_PANEL_SESSION_CACHE_KEY` | 会话缓存 localStorage key |
| `generateUserAccountId` | 用户 ID 生成函数：`user_{slug}_{random6}` |

---

## §4 Tab 架构

### 4.1 TABS 数组

```typescript
const TABS: { id: TabId; label: string; icon: typeof Users }[] = [
  { id: 'users',          label: '用户管理',    icon: Users },
  { id: 'roles',          label: '角色与权限',  icon: Shield },
  { id: 'knowledge-acl',  label: '知识库权限',  icon: BookOpen },
  { id: 'tool-perms',     label: '工具权限',    icon: Wrench },
  { id: 'approvals',      label: '学习与审批',  icon: CheckSquare },
  { id: 'workflow',       label: '工作流审批',  icon: Workflow },
  { id: 'audit-logs',     label: '系统日志',    icon: ScrollText },
];
```

### 4.2 Tab 详情

| Tab | 数据源 | 关键功能 |
| --- | --- | --- |
| users | `/api/v1/admin/users` | 用户列表（status 过滤）+ 创建/编辑/停用/删除 + 角色分配 + 部门关联 |
| roles | `/api/v1/admin/roles` + `permissions` | 8 角色 × 25 权限矩阵 + 行级权限配置 |
| knowledge-acl | `/api/v1/admin/knowledge-acl` | `KnowledgeAcl` 行级 ACL（scope × access） |
| tool-perms | `/api/v1/admin/tool-perms` | `AgentToolPermission`（access × riskMode） |
| approvals | `/api/v1/admin/approvals` | 学习审批 + 操作审批列表 + 批准/驳回 |
| workflow | `WorkflowPanel` | 工作流审批流配置与处理 |
| audit-logs | `/api/v1/admin/audit-logs` | AuditLog 多维查询（actor/action/target/operationType/fieldPath） |

### 4.3 已裁决新增 Tab（2026-08-18，待实施）

> 来源：《账户与系统配置》§1A 配置分层模型裁决——平台配置一律迁 AdminPanel（本页导航 `adminOnly: true` 守卫在位），Settings 仅保留个人偏好与本机连接。

| 新 Tab | label | 内容 | 数据源 | 权限 |
| --- | --- | --- | --- | --- |
| `company-profile` | 公司档案 | exporterProfile 全字段表单（公司抬头+银行信息，自 Settings company Tab 迁入）+ SystemConfigHistory 变更历史展示 | `GET/PUT /api/v1/config/company.exporterProfile`（**新建 systemConfigRoute**，真源 `SystemConfig global::company.exporterProfile`） | GET 全登录可读（单据生成链路依赖）；PUT 仅 `SUPER_ADMIN`/`ADMIN` |
| `platform-rules` | 平台规则 | ① MOQ 阈值（`CompiledMoqThresholdsPanel` 提级重写为普通组件，清 FR-004 遗留）② 自动化联动（`AutomationRulesSection` 自 Settings 整迁）③ 对外 API 策略与密钥管理（自 Settings api Tab 策略部分迁入）④ 未来承接：A1 审批超时策略表（《审批与human-in-the-loop》§16.2）、平台脱敏规则 | MoqThresholdConfig / automationConfig / SystemConfig | 读：admin；写：`SUPER_ADMIN`/`ADMIN`（MOQ 沿用 `settings:moq:write` scope） |

铁律：两个新 Tab 的所有写操作走服务端 API + 审计，**禁止**写 localStorage 作为真源；AdminPanel 既有的 `adminOnly` 导航守卫与渲染权限（`users:read`）对本两 Tab 同样生效，细分写权限在各 API 路由层 enforce。

---

## §5 角色与权限

### 5.1 8 角色枚举

```typescript
const AVAILABLE_ROLES = [
  'viewer',         // 查看员
  'merchandiser',   // 跟单
  'sales',          // 销售
  'finance',        // 财务
  'manager',        // 经理
  'agent_operator', // 智能体操作员
  'admin',          // 管理员
  'owner',          // 所有者
] as const;
```

### 5.2 25 权限项

| 权限 | 标签 | 说明 |
| --- | --- | --- |
| `*` | 全部权限 | 超级权限 |
| `users:read` | 查看用户 | - |
| `users:write` | 创建/编辑用户 | - |
| `users:delete` | 停用/抹除用户 | - |
| `roles:read` | 查看角色权限 | - |
| `roles:write` | 编辑角色权限 | - |
| `orders:read` | 查看订单 | - |
| `orders:write` | 创建/编辑订单 | - |
| `orders:delete` | 删除订单 | - |
| `products:read` | 查看产品档案 | - |
| `products:write` | 创建/编辑产品档案 | - |
| `relations:read` | 查看关系智库 | - |
| `relations:write` | 创建/编辑关系智库 | - |
| `knowledge:read` | 查看数据中心 | - |
| `knowledge:write` | 编辑数据中心 | - |
| `knowledge:admin` | 管理数据中心权限 | - |
| `tools:execute` | 使用智能工具 | - |
| `tools:admin` | 管理工具权限 | - |
| `finance:read` | 查看财务 | - |
| `finance:write` | 编辑财务 | - |
| `ai:chat` | 使用 AI 对话 | - |
| `ai:agent` | 使用 AI Agent | - |
| `emails:read` | 查看邮件 | - |
| `emails:write` | 发送邮件 | - |
| `settings:read` | 查看系统设置 | - |
| `settings:write` | 修改系统设置 | - |
| `audit:read` | 查看审计日志 | - |
| `approvals:read` | 查看审批 | - |
| `approvals:write` | 审批决策 | - |

### 5.3 4 级访问

| access | 含义 |
| --- | --- |
| `read` | 只读 |
| `write` | 可编辑 |
| `execute` | 可执行（工具专用） |
| `admin` | 管理（含 ACL） |
| `none` | 无权限（显式拒绝） |

### 5.4 3 风险模式

| riskMode | 含义 |
| --- | --- |
| `direct` | 直接执行 |
| `approval` | 需审批 |
| `disabled` | 已禁用 |

---

## §6 API 端点

### 6.1 用户管理

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/admin/users?status=` | 列出用户（支持 status 过滤） |
| POST | `/api/v1/admin/users` | 创建用户（含角色 + 部门） |
| PATCH | `/api/v1/admin/users/:id` | 更新用户 |
| DELETE | `/api/v1/admin/users/:id` | 删除用户（停用/抹除） |

### 6.2 审计日志

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/admin/audit-logs` | 查询审计日志（多维过滤） |

### 6.3 审批

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/admin/approvals` | 列出待审批 |
| POST | `/api/v1/admin/approvals/:id/approve` | 批准 |
| POST | `/api/v1/admin/approvals/:id/reject` | 驳回 |

---

## §7 路由层架构

### 7.1 createAdminRouter

```typescript
type AdminRouterOptions = {
  prisma: PrismaClient;
  email?: EmailService;
  requireAuth?: boolean;     // 默认 true
  apiKeys?: Set<string>;      // 默认空集——admin 不接受 API-Key
};

export function createAdminRouter(options: AdminRouterOptions) {
  const router = Router();
  const auth = createAuthService();
  const email = options.email || createEmailService();

  const requireAuth = options.requireAuth ?? true;
  const apiKeys = options.apiKeys ?? new Set<string>();

  // 统一认证守卫
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));

  // 所有 admin 路由要求 owner/admin 角色
  if (requireAuth) {
    router.use(requireRole('owner', 'admin'));
  }

  // ... 路由定义
}
```

### 7.2 鉴权双层

1. **createModuleAuthGuard**：JWT 优先，API-Key 次之
2. **requireRole('owner', 'admin')**：角色检查（JWT 中的 actor 必须是 owner/admin）
3. API-Key 即使通过 moduleGuard，也因无 actor 在 `requireRole` 处被挡 → 401

### 7.3 用户 ID 生成

```typescript
async function generateUserAccountId(prisma, email, displayName): Promise<string> {
  const source = (email?.split('@')[0] || displayName || 'user').toLowerCase();
  const slug = source.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'user';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 7);
    const id = `user_${slug}_${suffix}`;
    const existing = await prisma.userAccount.findUnique({ where: { id } });
    if (!existing) return id;
  }
  return `user_${slug}_${Date.now().toString(36)}`;
}
```

- 格式：`user_{slug}_{random6}`
- slug：email 前缀或 displayName，小写 + 非字母数字替换为 `-`
- 重试：6 次防碰撞
- 兜底：`user_{slug}_{timestamp_base36}`

### 7.4 软删除模式

```typescript
// users 列表过滤已抹除用户
const users = usersRaw.filter(u => {
  const metadata = (u.metadata || {}) as any;
  return !metadata.erased && metadata.deletionMode !== 'erase-personal-data';
});
```

- **停用**（status='disabled'）：保留在列表，标记停用
- **抹除个人数据**（deletionMode='erase-personal-data'）：从列表过滤，数据保留但不可见

---

## §8 前端组件

### 8.1 AdminPanel.tsx 主组件

```typescript
const AdminPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>('users');
  const [tabCache, setTabCache] = useState<AdminTabCache>({});

  // 会话缓存：Tab 切换时缓存当前 Tab 数据
  useEffect(() => {
    localStorage.setItem(ADMIN_PANEL_SESSION_CACHE_KEY, JSON.stringify({ activeTab, tabCache }));
  }, [activeTab, tabCache]);

  return (
    <SidePanelContainer>
      <PageHeader title="管理后台" subtitle="Admin Panel" />
      {/* Tab 导航 */}
      <div>
        {TABS.map(tab => (
          <button onClick={() => setActiveTab(tab.id)}>{tab.label}</button>
        ))}
      </div>
      {/* Tab 内容 */}
      <ScrollEdgeFades>
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'roles' && <RolesTab />}
        ...
      </ScrollEdgeFades>
    </SidePanelContainer>
  );
};
```

### 8.2 会话缓存

```typescript
const ADMIN_PANEL_SESSION_CACHE_KEY = 'bambook_admin_panel_session_cache_v1';

// 启动时恢复
useEffect(() => {
  const saved = localStorage.getItem(ADMIN_PANEL_SESSION_CACHE_KEY);
  if (saved) {
    const { activeTab: savedTab, tabCache: savedCache } = JSON.parse(saved);
    setActiveTab(savedTab);
    setTabCache(savedCache);
  }
}, []);
```

- Tab 切换时缓存当前 Tab 数据
- 重新进入时恢复上次活跃 Tab

---

## §9 审计日志查询

### 9.1 buildAuditLogQuery

```typescript
// server/src/audit/entityQuery.ts
export function buildAuditLogQuery(params: {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  operationType?: string;
  fieldPath?: string;
  transactionId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}) {
  // 构造 Prisma where 条件
}
```

### 9.2 查询维度

| 维度 | 说明 |
| --- | --- |
| `actorId` | 操作者 |
| `action` | 操作（create/update/delete/transition/link/unlink） |
| `targetType` + `targetId` | 目标实体 |
| `operationType` | 操作类型（create/update/delete/transition/link/unlink） |
| `fieldPath` | 字段路径（如 `status` / `lines[0].quantity`） |
| `transactionId` | 事务 ID（串联同一业务操作） |
| `startDate` / `endDate` | 时间范围 |

### 9.3 字段级审计

```prisma
model AuditLog {
  // Phase 0 Sprint 1: 字段级审计
  operationType String?  // create / update / delete / transition / link / unlink
  fieldPath     String?  // 如 "status" 或 "lines[0].quantity"
  beforeValue   Json?
  afterValue    Json?
  transactionId String?  // 关联 OrderStatusTransition / BusinessEvent id
}
```

---

## §10 交互流程

### 10.1 创建用户

```
admin 在 users Tab 点击「+ 新建用户」
  └─► Modal: displayName + email + password + roles + departmentId
      └─► POST /api/v1/admin/users
          ├─► generateUserAccountId(prisma, email, displayName) → user_xxx_yyy
          ├─► 创建 UserAccount + 关联 Role + 关联 Department
          ├─► writeRouteAuditLog(operation='user_create', actorId, ip)
          └─► email?.sendApprovalApprovedEmail (可选)
              ├─► 201: 返回新用户
              └─► 400: VALIDATION_FAILED
```

### 10.2 配置知识库 ACL

```
admin 在 knowledge-acl Tab
  └─► 选文档 → 选 scope (company/department/team/private)
      └─► 选 role 或 department → 设置 access (read/write/admin/none)
          └─► POST /api/v1/admin/knowledge-acl
              └─► KnowledgeAcl 入库 + 审计
```

### 10.3 审批处理

```
admin 在 approvals Tab 查看待审批列表
  └─► 点击「批准」
      └─► POST /api/v1/admin/approvals/:id/approve
          ├─► 更新 Approval 状态
          ├─► writeRouteAuditLog(operation='approval_approve')
          └─► email.send(buildApprovalApprovedEmail(...))
              └─► 通知申请人
```

### 10.4 查询审计日志

```
admin 在 audit-logs Tab 设置过滤条件
  └─► actorId + action + targetType + dateRange
      └─► GET /api/v1/admin/audit-logs?actorId=&action=&targetType=&startDate=&endDate=
          └─► 返回 AuditLog[] 列表（含 before/after diff）
```

---

## §11 权限与访问控制

### 11.1 前端权限

- AdminPanel 入口要求 `users:read` 权限（`View.AdminPanel`）
- 各 Tab 内部操作要求对应权限：
  - users Tab：`users:write` / `users:delete`
  - roles Tab：`roles:read` / `roles:write`
  - knowledge-acl Tab：`knowledge:admin`
  - tool-perms Tab：`tools:admin`
  - approvals Tab：`approvals:write`
  - audit-logs Tab：`audit:read`

### 11.2 后端权限

- `/api/v1/admin/*` 统一 `createModuleAuthGuard` + `requireRole('owner', 'admin')`
- API-Key 单独访问 → 401（即使配置了 apiKeys）
- 所有写操作同事务写 AuditLog

### 11.3 角色层级

| 角色 | AdminPanel 访问 | 说明 |
| --- | --- | --- |
| owner | ✅ 全部 | 所有者，最高权限 |
| admin | ✅ 全部 | 管理员，除 owner 专属操作外全部 |
| manager | ❌ | 经理，无 AdminPanel 入口 |
| finance / sales / merchandiser | ❌ | 业务角色，无入口 |
| agent_operator | ❌ | 智能体操作员，无入口 |
| viewer | ❌ | 查看员，无入口 |

---

## §12 审计与可观测性

### 12.1 审计日志

| 操作 | operation | targetType | 说明 |
| --- | --- | --- | --- |
| 创建用户 | `user_create` | `UserAccount` | displayName/email/roles/departmentId |
| 更新用户 | `user_update` | `UserAccount` | before/after diff |
| 删除用户 | `user_delete` | `UserAccount` | deletionMode (disabled/erase) |
| 角色变更 | `role_change` | `UserAccount` | before/after roles |
| 知识库 ACL | `knowledge_acl_update` | `KnowledgeAcl` | scope/access 变更 |
| 工具权限 | `tool_perm_update` | `AgentToolPermission` | access/riskMode 变更 |
| 审批批准 | `approval_approve` | `Approval` | approvalId + reason |
| 审批驳回 | `approval_reject` | `Approval` | approvalId + reason |

### 12.2 不变量

- 审计与业务**同事务**（失败回滚）
- `actorId` 从 JWT 解析
- `ip` 从 `req.ip` 提取
- 字段级审计：`beforeValue` / `afterValue` 保留 JSON 快照
- `transactionId` 串联同一业务操作的多条审计

---

## §13 测试覆盖

| 测试维度 | 覆盖点 |
| --- | --- |
| 鉴权 | owner/admin 可访问；其他角色 → 403；API-Key → 401 |
| 用户 CRUD | 创建 + 编辑 + 停用 + 抹除 |
| 用户 ID 生成 | 6 次重试防碰撞 + 兜底 timestamp |
| 角色分配 | 8 角色枚举 + 25 权限项 |
| 知识库 ACL | 4 scope × 4 access 矩阵 |
| 工具权限 | 4 access × 3 riskMode 矩阵 |
| 审批流 | 批准 + 驳回 + 邮件通知 |
| 审计查询 | 多维过滤 + 分页 |
| 会话缓存 | Tab 切换 + 恢复 |
| 软删除 | 停用 vs 抹除个人数据 |

---

## §14 已知限制与未来扩展

### 14.1 当前限制

- ❌ 角色定义**不可自定义**（仅 8 预置角色）
- ❌ 权限项**不可自定义**（仅 25 预置权限）
- ❌ 无**角色继承**（如 admin 继承 manager 权限）
- ❌ 无**部门树**管理（仅关联 single department）
- ❌ 审批流**不可自定义**（仅预置审批类型）
- ❌ 审计日志**无导出**功能

### 14.2 未来扩展

- 自定义角色 + 权限组合
- 角色继承机制
- 部门树管理（多级部门）
- 自定义审批流（BPMN 或简化版）
- 审计日志导出（CSV/Excel）
- 审计日志可视化（时间轴 + 操作热力图）

---

## §15 交叉链接

1. [账户与系统配置](./账户与系统配置.md) — 父模块，AdminPanel 是系统设置的一部分
2. [Knowledge 知识库 — 模块概述](../Knowledge-知识库/模块概述.md) — knowledge-acl Tab 管理 KnowledgeAcl
3. [写操作工具集](../../07-AI助手/写操作工具集.md) — tool-perms Tab 管理 AgentToolPermission
4. [审批与 human-in-the-loop](../../07-AI助手/审批与human-in-the-loop.md) — approvals Tab 处理审批
5. [Agent 能力分层 L0-L6](../../07-AI助手/Agent能力分层L0-L6.md) — agent_operator 角色与工具权限
6. [通知-邮件-季节-展会数据模型](../数据模型/通知-邮件-季节-展会.md) — AuditLog 数据模型
7. [业务自动化触发器](./业务自动化触发器.md) — workflow Tab 与自动化规则关联

---

## §16 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-08-15 | 初始版本：7 Tab + 8 角色 + 25 权限 + RBAC + 审计 + 审批 + 邮件通知 |
| v1.1 | 2026-08-18 | §4.3 已裁决新增 Tab（公司档案 + 平台规则）：来源《账户与系统配置》§1A 三层配置模型裁决——平台配置（公司抬头/MOQ/自动化/API 策略/脱敏）一律迁 AdminPanel；明确新建 systemConfigRoute（GET/PUT `company.exporterProfile`）与数据源映射；细读 admin-only 守卫继承 |
