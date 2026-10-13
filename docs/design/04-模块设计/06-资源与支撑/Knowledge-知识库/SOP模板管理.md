# SOP 模板管理设计

> 模块代号：`Knowledge / SOP Template`
> 父模块：[Knowledge 知识库 — 模块概述](./模块概述.md)
> 关联代码：`server/src/knowledge/sopTemplateService.ts`、`server/src/knowledge/knowledgeRoute.ts`、`components/KnowledgeBase.tsx`（sop tab）、`server/prisma/schema.prisma`（1671–1686 行）
> 文档版本：v1.0 · 最后更新：2026-08-15

---

## §1 实现状态

| 维度 | 状态 | 说明 |
| --- | --- | --- |
| 数据模型 | ✅ 已落地 | `SopTemplate`：title/category/summary/content/steps(Json?)/version/status/softDelete。schema.prisma 1671–1686 行。 |
| CRUD 服务 | ✅ 已落地 | `sopTemplateService.ts`：`listSopTemplates` / `createSopTemplate` / `updateSopTemplate` / `deleteSopTemplate` 全量实现 + 校验 + 审计 + 软删除。 |
| 实例化服务 | ✅ 已落地 | `instantiateSopTemplate`：模板 → `KnowledgeDocument`（sourceType='sop'，metadata 带模板 id + version），复用 `ingestKnowledgeDocument` 管线。 |
| 渲染函数 | ✅ 已落地 | `renderSopTemplateText`：把 title + summary + steps + content 拼接为单一 markdown 正文，实例化与种子共用。 |
| 预置种子 | ✅ 已落地 | `ensureSopTemplateSeed`：表为空时写入 4 份纺织外贸核心 SOP（大货跟单/验货/出运/出口报关），幂等。 |
| 路由层 | ✅ 已落地 | `/api/v1/knowledge/sop-templates` 5 个端点：GET list / POST create / PATCH update / DELETE / POST instantiate。 |
| 前端组件 | ✅ 已落地 | `KnowledgeBase.tsx` 的 `sop` Tab：模板列表 + 详情查看 + 新建/编辑 Modal + 实例化按钮 + 删除确认。首次进入时加载（失败显式提示）。 |
| 版本管理 | ✅ 已落地 | 内容/步骤变化才 `version + 1`；纯元数据（分类/摘要/状态）修改不动版本。 |
| 状态管理 | ✅ 已落地 | `active` / `archived` 双态；archived 不可实例化（返回 409）。 |
| 审计 | ✅ 已落地 | `writeRouteAuditLog` 同事务写入，operation 分别为 `sop_template_create/update/delete/instantiate`。 |
| 测试 | ✅ 已落地 | `server/src/knowledge/__tests__/sopTemplateService.test.ts` 覆盖 CRUD + 实例化幂等 + archived 拒绝 + 版本自增逻辑。 |

---

## §2 业务定位与目标

### 2.1 业务定位

SOP（Standard Operating Procedure，标准作业程序）模板是 Bambook 知识库中的「**可复用流程骨架**」。与一次性入库的知识文档不同，SOP 模板强调：

- **结构化**：title + summary + content + steps（步骤化拆解）
- **可版本化**：每次内容变更 +1，便于追溯
- **可实例化**：一份模板可被多次实例化为知识文档，进入 RAG 检索池
- **可归档**：归档后不可再实例化，但历史实例化记录保留

### 2.2 核心目标

1. **模板与实例分离**：模板是「蓝图」，实例化后生成 `KnowledgeDocument` 进入检索池，互不干扰。
2. **纺织外贸领域专精**：预置 4 份种子 SOP（大货跟单/验货/出运/出口报关），开箱即用。
3. **版本可追溯**：实例化时记录 `metadata.sopTemplateVersion`，可反查当时模板版本。
4. **幂等防重**：实例化复用 `ingestKnowledgeDocument` 的 checksum 幂等机制，同内容不重复入库。
5. **审计闭环**：CRUD + 实例化四类操作均同事务写 AuditLog。

---

## §3 核心概念与术语

| 术语 | 定义 |
| --- | --- |
| `SopTemplate` | SOP 模板聚合根，含 title/category/summary/content/steps/version/status |
| `SopStep` | 结构化步骤：`{ title, detail? }`，最多 100 步 |
| `version` | 版本号，内容/步骤变更 +1，元数据修改不动 |
| `status` | `active`（可实例化）/ `archived`（不可实例化，返回 409） |
| `instantiate` | 把模板渲染为 markdown 正文，调用 `ingestKnowledgeDocument` 入库为 `KnowledgeDocument`（sourceType='sop'） |
| `renderSopTemplateText` | 单一渲染函数：summary + steps（编号列表）+ content 拼接 |
| `ensureSopTemplateSeed` | 幂等种子：表为空时写入 4 份预置 SOP |
| `category` | 模板分类（自由文本，建议复用 `KB_CATEGORIES` 6 分类） |

---

## §4 数据模型

### 4.1 SopTemplate 表结构

```prisma
model SopTemplate {
  id        String  @id
  title     String
  category  String
  summary   String?
  content   String
  steps     Json?       // SopStep[] = [{ title, detail? }]
  version   Int     @default(1)
  status    String  @default("active")  // active | archived
  createdAt BigInt
  updatedAt BigInt
  deletedAt BigInt?

  @@index([category])
  @@index([status])
}
```

### 4.2 字段约束

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `title` | String | 非空，≤200 字 | 模板标题 |
| `category` | String | 非空 | 分类（建议 Product/Policy/Customer/Production/Company/Supplier） |
| `summary` | String? | 可空 | 一句话摘要 |
| `content` | String | 非空，≤200KB | markdown 正文 |
| `steps` | Json? | `SopStep[]`，≤100 项 | 结构化步骤，每项 `{ title, detail? }` |
| `version` | Int | 默认 1，内容变更 +1 | 版本号 |
| `status` | String | `active` / `archived` | 状态 |
| `createdAt` | BigInt | epoch ms | 创建时间 |
| `updatedAt` | BigInt | epoch ms | 更新时间 |
| `deletedAt` | BigInt? | epoch ms，null=未删 | 软删除标记 |

### 4.3 实例化结果（KnowledgeDocument）

实例化生成的 `KnowledgeDocument`：
- `title` = `SOP：${tpl.title}`
- `sourceType` = `'sop'`
- `metadata` = `{ category, sopTemplateId, sopTemplateVersion }`
- `checksum` = SHA-256(rendered text)
- `chunks` = 按段落分块

---

## §5 API 端点

### 5.1 路由清单

| 方法 | 路径 | 用途 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/v1/knowledge/sop-templates` | 列出模板 | `knowledge:read` |
| POST | `/api/v1/knowledge/sop-templates` | 创建模板 | `knowledge:write` |
| PATCH | `/api/v1/knowledge/sop-templates/:id` | 更新模板 | `knowledge:write` |
| DELETE | `/api/v1/knowledge/sop-templates/:id` | 软删除模板 | `knowledge:write` |
| POST | `/api/v1/knowledge/sop-templates/:id/instantiate` | 实例化为知识文档 | `knowledge:write` |

### 5.2 查询参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `category` | string | 按分类过滤 |
| `status` | string | `active`（默认）/ `archived` / `all` |

### 5.3 错误码

| code | HTTP | 说明 |
| --- | --- | --- |
| `INVALID_INPUT` | 400 | title/category/content 缺失或超长；steps 格式错误 |
| `NOT_FOUND` | 404 | 模板 id 不存在或已软删除 |
| `ARCHIVED` | 409 | 实例化时模板已归档 |
| `AUDIT_FAILED` | 500 | 审计日志写入失败 |
| `CREATE_FAILED` | 500 | 数据库写入失败 |
| `INSTANTIATE_FAILED` | 500 | 摄取管线失败（非 checksum 重复） |

---

## §6 服务层架构

### 6.1 文件结构

```
server/src/knowledge/
├── sopTemplateService.ts          # 核心服务
│   ├── listSopTemplates()         # 列表查询
│   ├── createSopTemplate()        # 创建
│   ├── updateSopTemplate()         # 更新（含版本判断）
│   ├── deleteSopTemplate()        # 软删除
│   ├── renderSopTemplateText()    # 渲染为 markdown
│   ├── instantiateSopTemplate()    # 实例化
│   └── ensureSopTemplateSeed()    # 幂等种子
├── knowledgeRoute.ts              # 路由层
└── __tests__/
    └── sopTemplateService.test.ts # 测试
```

### 6.2 校验规则

```typescript
const MAX_TITLE_LEN = 200;
const MAX_CONTENT_BYTES = 200_000;  // 200KB
const MAX_STEPS = 100;
const VALID_STATUSES = new Set(['active', 'archived']);
```

- `title`：非空，≤200 字
- `category`：非空
- `content`：非空，≤200KB（UTF-8 字节）
- `steps`：数组，每项 `{ title, detail? }`，≤100 项
- `status`：枚举 `active` / `archived`

### 6.3 版本自增逻辑

```typescript
const contentChanged = (input.content !== undefined && input.content.trim() !== existing.content)
                    || steps !== undefined;
// version: contentChanged ? existing.version + 1 : existing.version
```

- **内容/步骤变化** → `version + 1`
- **纯元数据修改**（title/category/summary/status）→ 版本不变

---

## §7 实例化流程

### 7.1 渲染逻辑（renderSopTemplateText）

```
输入: { title, summary?, content, steps? }
  │
  ├─► parts.push(summary.trim())           // 1. 摘要
  ├─► parts.push(steps 编号列表)            // 2. 步骤（1. xxx\n   detail\n2. xxx...）
  ├─► parts.push(content.trim())          // 3. 正文
  │
  └─► return parts.filter(Boolean).join('\n\n')
```

### 7.2 实例化管线（instantiateSopTemplate）

```
1. 读取 SopTemplate (where: { id, deletedAt: null })
   ├─► NOT_FOUND: 返回 404
   └─► status !== 'active': 返回 409 ARCHIVED

2. text = renderSopTemplateText(tpl)

3. ingestKnowledgeDocument({
     title: `SOP：${tpl.title}`,
     text,
     sourceType: 'sop',
     metadata: { category, sopTemplateId, sopTemplateVersion: tpl.version }
   })
   ├─► DUPLICATE_CHECKSUM: 转为 INVALID_INPUT（同内容已入库）
   └─► 其他错误: INSTANTIATE_FAILED

4. 审计: writeRouteAuditLog({
     operation: 'sop_template_instantiate',
     targetType: 'SopTemplate',
     targetId: id,
     after: { documentId, checksum, chunkCount, templateVersion }
   })

5. 返回 { documentId, checksum, chunkCount, templateVersion }
```

### 7.3 幂等保证

- 实例化复用 `ingestKnowledgeDocument` 的 SHA-256 checksum 幂等
- 同内容重复实例化 → 返回原 documentId（不报错，不重复入库）
- 模板版本变化后内容不同 → checksum 不同 → 新建文档

---

## §8 预置种子

### 8.1 种子清单

| # | title | category | steps 数 | 业务覆盖 |
| --- | --- | --- | --- | --- |
| 1 | 大货跟单标准流程 | Production | 6 | 订单确认 → 物料落实 → 产前样 → 中期 → 尾期验货 → 出运衔接 |
| 2 | 验货标准流程 | Production | 5 | 预约 → 资料准备 → 抽样 → 缺陷判定 → 报告签发（AQL 2.5/4.0） |
| 3 | 出运标准流程 | Policy | 5 | 订舱 → 装箱确认 → 单证制作 → 报关申报 → 物流跟踪 |
| 4 | 出口报关标准流程 | Policy | 4 | 资料准备 → 申报 → 查验应对 → 放行归档 |

### 8.2 种子触发

```typescript
export async function ensureSopTemplateSeed(prisma: PrismaClient): Promise<boolean> {
  const count = await prisma.sopTemplate.count();
  if (count > 0) return false;  // 幂等：表非空不写入
  // ... 写入 4 份种子
  return true;
}
```

- **触发时机**：服务启动时（在 `index.ts` 启动序列中调用）
- **幂等性**：表非空时跳过，避免重复写入
- **可重入**：删除全部模板后重启 → 重新写入

---

## §9 前端组件

### 9.1 KnowledgeBase.tsx 的 sop Tab

```typescript
type KbTab = 'official' | 'memory' | 'qa' | 'sop';

// sop Tab state
const [sopTemplates, setSopTemplates] = useState<SopTemplate[]>([]);
const [sopLoading, setSopLoading] = useState(false);
const [sopError, setSopError] = useState<string | null>(null);
const [sopDetail, setSopDetail] = useState<SopTemplate | null>(null);
const [sopEditing, setSopEditing] = useState<SopTemplate | null>(null);
const [sopShowNew, setSopShowNew] = useState(false);
const [sopDeleteId, setSopDeleteId] = useState<string | null>(null);
const [sopInstantiatedMsg, setSopInstantiatedMsg] = useState('');
```

### 9.2 加载策略

- **首次进入 sop tab 时加载**（非组件挂载时）
- 失败显式提示（区别于 official tab 的静默降级，因 SOP 无本地快照可降）

```typescript
useEffect(() => {
  if (activeTab !== 'sop' || sopLoadedRef.current) return;
  sopLoadedRef.current = true;
  setSopLoading(true);
  apiService.listSopTemplates()
    .then(setSopTemplates)
    .catch(e => setSopError(e?.message || 'SOP 模板加载失败'))
    .finally(() => setSopLoading(false));
}, [activeTab]);
```

### 9.3 操作入口

| 操作 | 入口 | 调用 |
| --- | --- | --- |
| 查看详情 | 列表卡片点击 | `setSopDetail(template)` |
| 新建 | 顶部「+ 新建模板」按钮 | `setSopShowNew(true)` → Modal |
| 编辑 | 详情面板「编辑」按钮 | `setSopEditing(template)` → Modal |
| 实例化 | 详情面板「实例化为知识文档」按钮 | `apiService.instantiateSopTemplate(id)` |
| 删除 | 详情面板「删除」按钮 | `setSopDeleteId(id)` → 确认弹窗 |

### 9.4 实例化反馈

```typescript
// 成功
setSopInstantiatedMsg(`✓ 已生成知识文档：${documentId}（${chunkCount} 块）`);
// 失败（archived）
setSopError('模板已归档，无法实例化');
```

---

## §10 交互流程

### 10.1 创建模板

```
用户点击「+ 新建模板」
  └─► Modal: title + category + summary + content + steps[]
      └─► apiService.createSopTemplate(input)
          ├─► 201: setSopTemplates([new, ...]) + 关闭 Modal
          └─► 400: setSopError('title/content 不能为空')
```

### 10.2 编辑模板

```
用户在详情面板点击「编辑」
  └─► Modal 预填现有数据
      └─► apiService.updateSopTemplate(id, input)
          ├─► 200: 更新列表 + 详情 + 关闭 Modal
          │           (若内容变化，version +1)
          └─► 404: setSopError('模板不存在')
```

### 10.3 实例化模板

```
用户在详情面板点击「实例化」
  └─► apiService.instantiateSopTemplate(id)
      ├─► 201: setSopInstantiatedMsg('✓ 已生成知识文档: ' + documentId)
      │        用户可点击「跳转查看」切换到 official tab
      └─► 409: setSopError('模板已归档，无法实例化')
      └─► 400 (DUPLICATE): setSopError('同内容已入库，documentId: ' + existingId)
```

### 10.4 归档模板

```
用户在编辑 Modal 中将 status 改为 'archived'
  └─► apiService.updateSopTemplate(id, { status: 'archived' })
      ├─► 200: 列表中标记为「已归档」徽章
      └─► 实例化按钮置灰 + tooltip「已归档模板不可实例化」
```

---

## §11 状态机

### 11.1 SopTemplate 状态

```
              ┌─────────┐  create (status='active' 默认)
              │ active  │◄────────────────────────
              └────┬─────┘
                   │ PATCH status='archived'
                   ▼
              ┌─────────┐
              │ archived │  (不可实例化 → 409 ARCHIVED)
              └────┬─────┘
                   │ PATCH status='active'（可恢复）
                   ▼
              ┌─────────┐
              │ active  │
              └─────────┘

  任意状态 ──DELETE──► 软删除 (deletedAt != null, 查询过滤)
```

### 11.2 版本演进

```
v1 (create) ──content/steps 变更──► v2 ──content 变更──► v3
                                      │
                                      └─► metadata 修改（title/category/summary/status）
                                          → 版本不变（仍是 v2）
```

---

## §12 权限与访问控制

### 12.1 路由级守卫

- 所有 SOP 端点统一走 `createModuleAuthGuard({ requireAuth, apiKeys })`
- POST/PATCH/DELETE/instantiate 要求 JWT + `knowledge:write` 权限
- GET 要求 JWT + `knowledge:read` 权限
- API-Key 单独访问 → 401

### 12.2 行级 ACL

- SOP 模板**暂未接入** `KnowledgeAcl` 行级权限（与 `KnowledgeDocument` 不同）
- 任何有 `knowledge:write` 权限者即可创建/编辑/归档/实例化任意模板
- 未来扩展：为 `SopTemplate` 增加 `scope` 字段接入 ACL

---

## §13 审计与可观测性

### 13.1 审计日志

| 操作 | operation | targetType | before | after |
| --- | --- | --- | --- | --- |
| 创建 | `sop_template_create` | `SopTemplate` | - | `{ id, title, category, version }` |
| 更新 | `sop_template_update` | `SopTemplate` | `{ title, version }` | `{ title, version, status }` |
| 删除 | `sop_template_delete` | `SopTemplate` | `{ title, version }` | - |
| 实例化 | `sop_template_instantiate` | `SopTemplate` | - | `{ documentId, checksum, chunkCount, templateVersion }` |

### 13.2 不变量

- 审计写入与业务写入**同事务**（`writeRouteAuditLog` 失败 → 业务回滚）
- `actorId` 从 JWT 解析（`actorIdFromRequest(req)`），`ip` 从 `req.ip` 提取
- 实例化审计的 `targetId` 是模板 id，`after.documentId` 是生成的知识文档 id（便于反查）

---

## §14 测试覆盖

| 测试用例 | 覆盖点 |
| --- | --- |
| `createSopTemplate` 基本流程 | title + content + steps 入库 + 审计写入 |
| `createSopTemplate` 校验失败 | title 空 / content 超 200KB / steps > 100 项 / status 非法 |
| `updateSopTemplate` 版本自增 | content 变化 → version +1；纯 metadata → version 不变 |
| `updateSopTemplate` NOT_FOUND | id 不存在或已软删除 |
| `deleteSopTemplate` 软删除 | deletedAt 写入 + 查询过滤 |
| `instantiateSopTemplate` 成功 | 生成 KnowledgeDocument + sourceType='sop' + metadata 正确 |
| `instantiateSopTemplate` ARCHIVED | status='archived' → 409 |
| `instantiateSopTemplate` 幂等 | 同内容重复实例化 → 返回原 documentId |
| `ensureSopTemplateSeed` 幂等 | 表为空写入 4 份；表非空跳过 |

---

## §15 交叉链接

1. [Knowledge 知识库 — 模块概述](./模块概述.md) — 父模块，SOP 是 4 Tab 之一
2. [智能问答 RAG](./智能问答RAG.md) — 实例化后的 KnowledgeDocument 进入 RAG 检索池
3. [知识图谱与关联](./知识图谱与关联.md) — 实例化文档可通过 KnowledgeRelation 关联业务实体
4. [Orders 订单管理 — 模块概述](../../03-订单与生产/Orders-订单管理/模块概述.md) — 「大货跟单 SOP」对应订单状态机
5. [QcWorkbench QC 质检中心 — 模块概述](../../03-订单与生产/QcWorkbench-QC质检中心/模块概述.md) — 「验货标准流程 SOP」对应 AQL 抽样
6. [Shipments 货运与出运 — 模块概述](../../04-出货与单据/Shipments-货运与出运/模块概述.md) — 「出运标准流程 SOP」对应出运节点
7. [Customs 报关与退税 — 模块概述](../../04-出货与单据/Customs-报关与退税/模块概述.md) — 「出口报关标准流程 SOP」对应报关单状态机
8. [AdminPanel 管理后台](../../08-设置与后台/管理后台AdminPanel.md) — `knowledge-acl` Tab 可视化 ACL（未来扩展至 SOP）

---

## §16 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-08-15 | 初始版本：CRUD + 实例化 + 种子 + 版本管理 + 审计 + 测试 |
