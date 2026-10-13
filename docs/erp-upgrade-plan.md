# Bambook ERP OS 改造升级规划

> 基于：样衣管理规定 + 大货订单十条规定 × 现有 OS 模块差距分析
> 聚焦：ERP OS 本体能力（不含 Agent 改造）
> 日期：2026-07-06

---

## 〇、现状盘点

### OS 已有模块（12 个侧边栏入口）

| 模块 | 数据层 | 后端 API | 前端页面 | 评价 |
|------|--------|---------|---------|------|
| 全景看板 Dashboard | ✅ 聚合查询 | ✅ | ✅ 含 3D 地球 | 缺生产维度数据 |
| 关系智库 Relations | ✅ Relation 表 | ✅ CRUD | ✅ | 成熟 |
| 数字档案 Products | ✅ ProductAsset + 面料/成衣/辅料 Profile | ✅ | ✅ | 成熟 |
| 智能邮箱 Emails | ✅ Email + Attachment | ✅ IMAP | ✅ | 成熟 |
| 生产管理 Orders | ✅ Order + OrderLine + StatusTransition | ✅ | ✅ 面料+成衣 | **状态太粗，无生产管线** |
| 财务管理 Finance | ✅ Invoice + PaymentVoucher + 核销 | ✅ | ✅ | 成熟 |
| 货运管理 Shipments | ✅ Shipment + 状态机 | ✅ | ✅ | 成熟 |
| 开发管理 Development | ✅ DevelopmentCase | ✅ | ✅ | **缺 5A 分档** |
| 数据中心 KnowledgeBase | ✅ KnowledgeDocument + RAG | ✅ | ✅ | 成熟 |
| 业务工具 BusinessTools | — | ✅ | ✅ | 辅助 |
| 管理后台 AdminPanel | ✅ UserAccount + RBAC | ✅ | ✅ | **缺生产角色** |
| 设置 Settings | ✅ | ✅ | ✅ | 成熟 |

### 核心诊断

**OS 能处理「订单→发货→收款」这条交易链，但处理不了「下单→面辅料→排产→裁剪→产前样→生产→验货→发货」这条生产链。**

业务规定揭示的 10 阶段大货流程，当前 OS 只能靠人工在 Order 状态（Pending→Confirmed→Production→Shipping）之间手动跳转，没有阶段跟踪、没有门禁、没有预警、没有量化校验。这不是 Agent 的问题，是 OS 本身缺少生产管理能力。

---

## 一、改造原则

1. **生产管理是新的 OS 一等模块**——不是 Order 的附属功能，和财务/货运平级
2. **门禁是 OS 级基础设施**——写进 service 层状态机，不是前端可选项，不依赖 Agent
3. **主状态不动**——现有 6 状态枚举保留，生产阶段是子状态层，自动推进主状态
4. **角色体系扩展**——OS 需要表达"生产部"和"工厂"两个新角色
5. **所有功能有手动路径**——不依赖 Agent，用户可直接在 UI 完成全部操作

---

## 二、OS 架构改造总览

```
┌─────────────────────────── Bambook ERP OS ───────────────────────────┐
│                                                                       │
│  侧边栏导航                                                            │
│  ├── 全景看板 ────────── +生产维度数据卡片                              │
│  ├── 关系智库 ────────── 不动                                          │
│  ├── 数字档案 ────────── 不动                                          │
│  ├── 智能邮箱 ────────── 不动                                          │
│  ├── 生产管理 ────────── ★ 改造核心（Order + Production Pipeline）     │
│  │   ├── 面料订单 ────── 不动                                          │
│  │   ├── 成衣订单 ────── 不动                                          │
│  │   └── 生产管线 ────── ★ 新增 Tab（10 阶段跟踪 + 门禁 + 看板）        │
│  ├── 开发管理 ────────── ★ 增强（5A/普通分档 + 审批分支）                │
│  ├── 财务管理 ────────── 不动                                          │
│  ├── 货运管理 ────────── 不动                                          │
│  ├── 数据中心 ────────── 不动                                          │
│  └── 管理后台 ────────── ★ 增强（+production_manager/factory 角色）     │
│                                                                       │
│  OS 基础设施层                                                          │
│  ├── RBAC ─────────────── +2 角色                                     │
│  ├── 状态机引擎 ────────── ★ 新增（通用阶段转换 + 门禁校验）              │
│  ├── 通知/预警 ─────────── ★ 新增（OS 级通知中心，非 Agent 功能）        │
│  └── 审计日志 ──────────── 复用 AuditLog                               │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 三、分阶段执行

### Phase 1：生产管线数据层 + 角色扩展（P0）

**做什么**：新建生产管线的底层数据结构，扩展角色体系

#### 1.1 新增 Prisma Model

**`ProductionStage`** — 订单的 10 阶段生产跟踪

```prisma
model ProductionStage {
  id            String    @id @default(cuid())
  orderId       String
  order         Order     @relation(fields: [orderId], references: [id])
  stage         String    // PRODUCTION_STAGES 枚举值
  status        String    @default("pending") // pending | active | completed | blocked
  assignedTo    String?   // 负责人 userId
  assignedRole  String    // production_manager | merchandiser | factory
  startedAt     DateTime?
  completedAt   DateTime?
  plannedDate   DateTime? // 计划完成时间
  data          Json?     // 阶段特定数据（检查项/评审结果/验货数据）
  note          String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@unique([orderId, stage])
  @@index([orderId])
  @@index([status])
}
```

10 个生产阶段（对齐业务规定）：

```
① order_placed        — 业务下单（业务部）
② materials_confirmed  — 面辅料确认（业务部）
③ production_planned   — 生产计划（生产部，下单后 7 天内）
④ in_production        — 货期管理（生产部）
⑤ materials_arrived    — 面辅料到厂（业务部+生产部）
⑥ pre_cut_checked      — 裁剪前检查（生产部，四项门禁）
⑦ pp_sample_approved   — 产前样确认（生产部+业务部，双签）
⑧ manufacturing        — 生产过程（工厂→裁剪/缝制/整烫/检验/入库）
⑨ final_review         — 成品确认（≥10 件/款评审）
⑩ qc_shipped           — 验货发货（合格率≥90% + 不合格≤3% + 业务部批准）
```

**`PreCutChecklist`** — 裁剪前四项检查门禁

```prisma
model PreCutChecklist {
  id                    String    @id @default(cuid())
  orderId               String    @unique
  order                 Order     @relation(fields: [orderId], references: [id])
  gradingConfirmed      Boolean   @default(false) // 推码确认
  consumptionConfirmed  Boolean   @default(false) // 耗料确认
  patternConfirmed      Boolean   @default(false) // 样板确认
  preProductionMeeting  Boolean   @default(false) // 产前会议
  meetingNote           String?
  confirmedBy           String?
  confirmedAt           DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
}
```

**`InspectionReport`** — 验货报告

```prisma
model InspectionReport {
  id                  String    @id @default(cuid())
  orderId             String    @unique
  order               Order     @relation(fields: [orderId], references: [id])
  totalUnits          Int       @default(0)
  passedUnits         Int       @default(0)
  defectRate          Float     @default(0) // 自动算 = (total-passed)/total
  passRate            Float     @default(0) // 自动算 = passed/total
  reportFile          String?
  inspectedBy         String?
  approvedByBusiness  Boolean   @default(false)
  businessApprover    String?
  approvedAt          DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}
```

#### 1.2 Order 表扩展字段

```prisma
// 在 Order model 中新增（不动现有字段）：
productionPlanDeadline DateTime?  // 下单时间 +7天，OS 自动设置
delayNoticeDeadline   DateTime?  // dueDate -15天，OS 自动设置
```

#### 1.3 DevelopmentCase 扩展（样衣分档）

```prisma
// 在 DevelopmentCase model 中新增：
sampleTier      String?  @default("normal") // normal | 5a
reviewRequired  Boolean  @default(false)    // 5A 样衣 = true
reviewStatus    String?  // pending | passed | failed | na
reviewDate      DateTime?
reviewerId      String?
```

#### 1.4 角色扩展

在 `defaults.ts` 和 `types.ts` 中新增：

| 角色 | 权限 | 说明 |
|------|------|------|
| `production_manager` | `orders:read`, `production:manage`, `production:approve` | 生产部，独立审批节点 |
| `factory` | `orders:read`(限分配), `production:self_report` | 外部工厂，只能上报进度和自检 |

AdminPanel 的角色权限矩阵同步扩展。

---

### Phase 2：状态机引擎 + 门禁（P0）

**做什么**：让 10 阶段有状态机驱动，业务规定的硬门禁编码到 OS 层

#### 2.1 生产阶段转换服务

新建 `server/src/production/stageService.ts`：

```typescript
export const PRODUCTION_STAGES = [
  'order_placed', 'materials_confirmed', 'production_planned',
  'in_production', 'materials_arrived', 'pre_cut_checked',
  'pp_sample_approved', 'manufacturing', 'final_review', 'qc_shipped'
] as const;

// 阶段必须顺序推进，不可跳过
// 每个阶段有前置条件（门禁），不满足则转换失败

export async function advanceStage(
  prisma: PrismaClient,
  orderId: string,
  targetStage: string,
  actor: { id: string, role: string }
): Promise<Result>
```

#### 2.2 门禁规则（编码为前置条件，不是建议）

| 阶段转换 | 门禁条件 | 违反时 |
|---------|---------|--------|
| → `production_planned` | 下单后 7 天内提交 | 超时则标黄预警 |
| → `materials_arrived` | 验布/验料完成，无异常 | 禁止带病生产 |
| → `pre_cut_checked` | PreCutChecklist 四项全 true | **拒绝转换，返回缺失项** |
| → `pp_sample_approved` | production_manager + merchandiser 双签 | **拒绝转换，返回未签方** |
| → `final_review` | 评审件数 ≥ 10 | 拒绝转换 |
| → `qc_shipped` | passRate ≥ 0.90 AND defectRate ≤ 0.03 AND 业务部批准 | **拒绝转换** |

门禁是 OS service 层的硬校验，REST API 直接调用也必须通过，不是前端可跳过的 UI 逻辑。

#### 2.3 主状态自动推进

| 子阶段完成 | 主状态自动推到 |
|-----------|--------------|
| ① order_placed 创建 | Pending |
| ②③ 完成 | Confirmed |
| ④⑤⑥⑦⑧ 进行中 | Production |
| ⑨⑩ 完成 | Shipping |

主状态推进复用现有 `orderLifecycleService.ts`，保持 OrderStatusTransition 审计链不断裂。

#### 2.4 OS 级通知/预警

新建 `server/src/production/alertService.ts`，集成到现有 SSE 通道：

| 触发条件 | 预警动作 |
|---------|---------|
| 下单后 7 天无 production_planned | 通知业务部 + 生产部 |
| 距 dueDate < 15 天且未到 manufacturing | 通知业务部（升级） |
| 验货 defectRate > 3% | 阻止发货 + 通知生产部 |
| PreCutChecklist 未完成但尝试裁剪 | 拒绝 + 通知生产部 |

预警走 OS 的 `/api/v1/events` SSE 通道，前端 Dashboard 和订单详情页都能收到。不依赖 Agent。

---

### Phase 3：生产管理前端模块（P0）

**做什么**：让用户在 OS 界面直接管理生产管线，不需要 Agent

#### 3.1 订单详情页增强

在现有 OrderManager / GarmentOrders 的订单详情页中新增「生产管线」Tab：

- **10 阶段进度条**：横向时间线，显示每个阶段的 status（pending/active/completed/blocked）+ 颜色编码
- **门禁状态面板**：当前阶段的门禁项清单（绿色=通过 / 红色=未通过 / 灰色=未开始）
- **阶段操作按钮**：根据当前用户角色和阶段，显示可执行的操作
  - 例如：merchandiser 在 ② 面辅料确认阶段看到「确认面辅料」按钮
  - 例如：production_manager 在 ⑥ 裁剪前检查阶段看到四项 checklist 勾选框
  - 例如：双签阶段显示两个签字位，各自亮绿灯

#### 3.2 全景看板增加生产维度

Dashboard 新增数据卡片：
- 待排产订单数（order_placed 阶段，7天倒计时）
- 待裁剪门禁订单数（卡在 ⑥ 的订单）
- 待产前样双签订单数（卡在 ⑦ 的订单）
- 延期预警订单数（距 dueDate < 15 天）
- 验货不合格订单数

这些卡片点击后跳转到对应筛选的订单列表。

#### 3.3 裁剪前检查面板

订单详情页内嵌 PreCutChecklist 组件：
- 四项 checkbox（推码/耗料/样板/产前会），每项有确认人和确认时间
- 全部勾选后才亮起「放行裁剪」按钮
- 放行操作写入 AuditLog

#### 3.4 验货报告录入

订单详情页内嵌 InspectionReport 组件：
- 录入 totalUnits / passedUnits，系统自动算 passRate / defectRate
- passRate < 90% 或 defectRate > 3% 时红色警告，禁止提交
- 业务部批准按钮（只有 merchandiser+ 角色可见）

#### 3.5 样衣 5A/普通分档 UI

Development 管理页面增强：
- 新建样衣时可选「普通」或「5A 重点」
- 5A 样衣自动走评审流（developing → review_pending → review_passed → shipping）
- 普通样衣走原流程（developing → shipping）
- 5A 样衣在列表中有特殊标记

---

### Phase 4：REST API + 路由（P1）

**做什么**：把生产管线暴露为标准 REST API，供前端和外部调用

新建 `server/src/production/route.ts`，挂载到 `/api/v1/production`：

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/v1/production/:orderId/stages` | GET | 获取订单的 10 阶段状态 |
| `/api/v1/production/:orderId/stages/:stage/advance` | POST | 推进指定阶段（含门禁校验） |
| `/api/v1/production/:orderId/pre-cut-checklist` | GET | 获取裁剪前检查清单 |
| `/api/v1/production/:orderId/pre-cut-checklist` | PUT | 更新检查项 |
| `/api/v1/production/:orderId/inspection` | GET | 获取验货报告 |
| `/api/v1/production/:orderId/inspection` | POST | 提交验货报告（含阈值校验） |
| `/api/v1/production/:orderId/inspection/approve` | POST | 业务部批准发货 |
| `/api/v1/production/alerts` | GET | 获取当前预警列表 |
| `/api/v1/production/dashboard` | GET | 看板聚合数据 |

所有写操作走标准 RBAC 校验 + AuditLog 落地，不依赖 Agent。

---

### Phase 5：通知中心（P1）

**做什么**：OS 级通知基础设施，让预警不只是推到 SSE 还能被用户看到

#### 5.1 新增 Prisma Model

```prisma
model Notification {
  id          String    @id @default(cuid())
  userId      String    // 接收人
  type        String    // production_overdue | pre_cut_block | qc_failed | pp_sample_pending | ...
  title       String
  body        String
  severity    String    @default("info") // info | warning | critical
  targetType  String    // order | development | shipment | ...
  targetId    String?
  read        Boolean   @default(false)
  createdAt   DateTime  @default(now())
}
```

#### 5.2 前端通知中心

- 侧边栏顶部或头像菜单旁加一个通知铃铛
- 点击展开通知面板，按 severity 排序
- 点击通知跳转到对应模块/订单
- 通知有已读/未读状态

#### 5.3 通知来源

| 来源 | 触发 |
|------|------|
| 生产阶段超时 | 7天排产/15天延期 |
| 门禁阻止 | 裁剪前检查不全/产前样未签/验货不合格 |
| 审批待处理 | 产前样双签/发货批准 |
| 面辅料异常 | 验布不合格/到厂延期 |

---

## 四、执行优先级

| Phase | 内容 | 优先级 | 依赖 |
|-------|------|--------|------|
| **1** | 数据层（3 新 model + Order/DevCase 字段 + 2 角色） | **P0** | 无 |
| **2** | 状态机 + 门禁 + 预警 service | **P0** | Phase 1 |
| **3** | 前端生产管线 UI（看板/详情/检查/验货/样衣分档） | **P0** | Phase 2 |
| **4** | REST API 路由 | **P1** | Phase 2（和 Phase 3 可并行） |
| **5** | 通知中心 | **P1** | Phase 2 |

**关键路径**：Phase 1 → Phase 2 → Phase 3。Phase 4/5 可并行跟进。

---

## 五、不做什么

1. **不改主状态枚举** — Pending/Confirmed/Production/Shipping/Delivered/Alert 保持不动
2. **不碰 Agent 架构** — Agent 改造是独立的并行线（P0-1 流式/P0-2 ToolRegistry），ERP OS 改造不依赖它
3. **不做 MES** — 不做车间设备级数据采集，只做管理层级的阶段跟踪+门禁
4. **不重写现有模块** — Relation/Products/Finance/Shipment/Email 模块冻结
5. **不做 ERP 核心表重构** — Order/Relation/ProductAsset 主表结构冻结，只加字段不重组

---

## 六、现有设计的保留和复用

| 现有能力 | 复用方式 |
|---------|---------|
| OrderStatusTransition 审计链 | 生产阶段推进时同步写主状态转换审计 |
| OrderStatusVisuals（前端状态映射） | 新增 production stage visuals，和主状态映射并存 |
| ApprovalRequest + AuditLog | 门禁审批走现有审批表，不新建审批机制 |
| RBAC（Role + Permission + UserRole） | 新增 production_manager/factory 角色，复用现有权限框架 |
| SSE /api/v1/events | 预警通知走现有 SSE 通道 |
| moduleRegistry（侧边栏导航） | 生产管线 Tab 在现有 Orders 模块内注册 |
| AdminPanel 角色权限矩阵 | 扩展两行（production_manager/factory） |
| DevelopmentCase 阶段流转 | 扩展 5A 分档逻辑，复用现有 stage 转换服务 |
| Shipment 状态机 | 不动，生产管线的 ⑩ 阶段完成后触发现有发货流程 |

---

## 七、量化和门禁规则汇总（业务规定 → OS 硬编码）

| 规则 | 来源 | OS 编码方式 |
|------|------|-----------|
| 下单后 7 天内出生产计划 | 十条第③条 | Order.productionPlanDeadline = createdAt + 7d，超时触发预警 |
| 延期需提前 15 天通知 | 十条第④条 | Order.delayNoticeDeadline = dueDate - 15d，超时升级 |
| 禁止带病生产 | 十条第⑤条 | materials_arrived 阶段验布异常则 block |
| 裁剪前四项必查 | 十条第⑥条 | PreCutChecklist 四项 AND gate，全 true 才放行 |
| 产前样双签 | 十条第⑦条 | pp_sample_approved 需 production_manager + merchandiser 各签 |
| 每款评审≥10件 | 十条第⑨条 | final_review 阶段 data.reviewQty ≥ 10 |
| 自检合格率≥90% | 十条第⑩条 | InspectionReport.passRate ≥ 0.90 |
| 不合格率≤3% | 十条第⑩条 | InspectionReport.defectRate ≤ 0.03 |
| 5A样衣生产部评审 | 样衣第四条 | DevelopmentCase.sampleTier='5a' → reviewRequired=true |
| 交样日期不可擅自调整 | 样衣第五条 | targetDate 修改需 merchandiser 审批 |
