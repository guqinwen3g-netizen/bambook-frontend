# DataCenter 数据中心 · 模块设计

## §1 元信息

| 项 | 值 |
|---|---|
| 定位 | 企业知识中枢 + 数字孪生布局编辑器——向量检索企业知识语料（邮件/文档/SOP/历史问答）+ LLM 流式回答 + 公司办公室 2D 数字孪生排布。承担「知识沉淀 → 检索 → 回答 → 归档反哺」闭环 |
| 入口 | 桌面端导航 → 数据中心（`View.DataCenter`），双 tab：数据看板（默认）+ 数字孪生 |
| 角色 | 7 容器角色全量可读 + 提问；归档需 `knowledge:write` scope；数字孪生布局编辑需 `system:config` scope（系统管理员（总领导）、超级管理员（老板）） |
| 范式 | 范式 A — 双 tab 切换：数据看板（问答工作台）+ 数字孪生（SVG 布局编辑器） |
| 优先级 | P1（C7 知识库深化 + 数字孪生布局编辑器） |
| 实现状态 | ✅ 已落地（RAG 智能问答 + 流式回答 + 命中片段展示 + 一键归档回知识库 + 数字孪生 SVG 编辑器含墙/门/工位/货架/服务器 + 拖拽/吸附/撤销/适配视图/云端同步 + localStorage 缓存兜底）；⚠️ 数据字典 / 系统资产子模块未独立收口（当前散落在 AdminPanel / Settings，数据中心本页不直接承载） |
| PRD 关联 | PRD §C7 知识库深化（RAG / SOP / EntityLink） / §D1 全局工作台体验（知识问答入口） / §9.6 角色权限矩阵（knowledge:read / knowledge:write / system:config） |
| 代码关联 | `components/DataCenter.tsx`（1300+ 行前端真源） / `services/apiService.ts`（`listBusinessProfiles` / `saveBusinessProfile` 布局云端同步） / Python `knowledge_api` `/v1/knowledge/search` 向量检索 + `/v1/knowledge/qa/stream` 流式问答 / `types.ts` `KnowledgeItem` / `KnowledgeCitation` / `SopTemplate` / `KnowledgeRelationView` / `EntityLinkView`（第 142–205 行） / `components/ui/PageHeader.tsx` / `components/ui/SidePanelContainer.tsx` |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 页面骨架（ASCII 线框）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ PageHeader: 数据中心 / Data Center / Data Hub       [编辑布局] [保存布局]   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Tab Bar：  ( 数据看板 )  数字孪生                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ ▼ 数据看板 tab（默认）                                                       │
│                                                                              │
│  ✨ 企业知识智能问答                                                          │
│  向量检索企业知识语料（邮件/文档/SOP/历史问答），LLM 流式生成回答并列出      │
│  命中片段；有价值的一键归档回知识库。                                         │
│                                                                              │
│  ┌─ 提问区 ─────────────────────────────────────────────────────────────┐  │
│  │  ┌────────────────────────────────────────────────────────────────┐ │  │
│  │  │ textarea: 向企业知识库提问，如：面料尾期验货的抽样标准是什么？ │ │  │
│  │  └────────────────────────────────────────────────────────────────┘ │  │
│  │  [面料尾期验货的抽样标准] [产前样需哪两方签字] [T/T 30天付款条款]   │  │
│  │  向量检索知识语料 + LLM 流式回答，命中片段在下方列出      [提问]   │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌─ 回答区（流式）─────────────────────────────────────────────────────┐  │
│  │  LLM 流式回答内容...                                                │  │
│  │  ─── 命中片段（KnowledgeCitation[]） ───                            │  │
│  │  ▸ 邮件：xxx · score 0.87   ▸ SOP：xxx · score 0.82                 │  │
│  │  ─── 归档此问答 ───                                                 │  │
│  │  分类 [Company▼]  [归档]                                           │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│ ▼ 数字孪生 tab                                                               │
│  ┌─ SVG 画布 820×620 ──────────────────────────────────────────────────┐  │
│  │  办公室外框 + 房间（会议+厨/仓库/设计间/大办公室A·B/小办公室A·B）   │  │
│  │  + 工位（Amy/Kevin/Sunny/PM/Wendy）+ 货架 + 数据中心服务器          │  │
│  │  工具：select / wall / door / station / server / rack                │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  右侧 SidePanel：选中对象属性（label/person/device/presence/seat）          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## §3 区块逐块说明

### §3.1 数据看板 tab（默认）— RAG 智能问答

#### §3.1.1 看板简介

| 属性 | 说明 |
|---|---|
| 文案 | 「企业知识智能问答」+ 副标「向量检索企业知识语料（邮件/文档/SOP/历史问答），LLM 流式生成回答并列出命中片段；有价值的一键归档回知识库。」 |
| 图标 | `Sparkles` size=18 + textTertiary |

#### §3.1.2 提问区

| 属性 | 说明 |
|---|---|
| textarea | rows=3，placeholder「向企业知识库提问，如：面料尾期验货的抽样标准是什么？」 |
| 快捷提问 | `QA_SUGGESTED_QUESTIONS` 3 条常量：① 面料尾期验货的抽样标准 ② 产前样需哪两方签字确认 ③ T/T 30 天付款条款在合同里怎么表述 |
| 提交按钮 | `qaBusy` 时显示 `Loader2` + 「检索回答中…」；否则 `Send` 图标 + 「提问」 |
| 禁用条件 | `qaBusy \|\| !qaQuestion.trim()` |

#### §3.1.3 回答区（流式）

| 属性 | 说明 |
|---|---|
| 显示条件 | `qaAnswer \|\| qaBusy` |
| 流式回答 | `handleAsk` 调用 `knowledge_api /v1/knowledge/qa/stream` SSE 流式生成；回答边生成边渲染 |
| 命中片段 | `qaCitations: KnowledgeCitation[]`，每条含 `id / title / content / score` |
| 错误态 | `qaError` 显示 danger 红边框 + 错误文案 |

#### §3.1.4 一键归档

| 属性 | 说明 |
|---|---|
| 分类选择 | `QA_ARCHIVE_CATEGORIES` 6 类：Company / Policy / Production / Product / Customer / Supplier（与策略文库 `KnowledgeItem.category` 同一枚举语义） |
| 归档动作 | `handleArchiveQa` 沉淀为知识文档进入检索语料，title=`问答：${q.slice(0,40)}…` |
| 状态 | `qaArchiving` 时禁用按钮；`qaArchived=true` 显示「已归档」标记 |
| 反哺闭环 | 归档后的文档进入下一次向量检索语料，提升后续问答质量 |

### §3.2 数字孪生 tab — 公司办公室 2D 布局编辑器

#### §3.2.1 画布与对象

| 属性 | 说明 |
|---|---|
| 画布 | SVG `820×620`（`CANVAS_W / CANVAS_H`） |
| ViewBox | 可缩放/平移，初始 `{x:0, y:0, width:820, height:620}` |
| 办公室外框 | `OfficeFrame`：x28 y42 w762 h546 thickness5 |
| 房间（初始 7 间） | 会议+厨 / 仓库 / 设计间 / 大办公室A·B / 小办公室A·B |
| 墙段 | `WallSegment[]`（初始空，用户可绘制） |
| 门洞 | `DoorGap[]`（初始 4 个：仓库门 / 会议B门 / 小办公室A·B门） |
| 对象（初始 8 个） | 工位 5（Amy/Kevin/Sunny/PM/Wendy）+ 服务器 1（数据中心）+ 货架 2（面料货架A·B） |
| 工位属性 | `device: 'desktop'\|'laptop'` / `person` / `presence: 'online'\|'away'\|'offline'` / `seat: 'north'\|'east'\|'south'\|'west'` |

#### §3.2.2 工具栏

| 工具 | 用途 |
|---|---|
| `select` | 选中/拖拽对象 |
| `wall` | 绘制墙段（点击起点 → 点击终点） |
| `door` | 在墙上开门洞 |
| `station` | 添加工位 |
| `server` | 添加服务器 |
| `rack` | 添加货架 |

#### §3.2.3 编辑能力

| 能力 | 实现 |
|---|---|
| 拖拽 | `DragState` 联合类型：object / wall-end / room-move / room-corner / frame-move / frame-corner / pan |
| 吸附 | `snapStationToStations` 工位间吸附（threshold 10px + desk join gap 0.6px）；`snapPoint` 网格吸附（grid=10） |
| 撤销 | `undoStack` 最多 40 步（`stack.slice(-39)`）；`undoLayout` 回退一步 |
| 适配视图 | `fitLayoutView` 自动计算 ViewBox 包络所有对象 |
| 编辑开关 | `isEditingLayout` toggle；非编辑态只读浏览，编辑态显示工具栏 + 选中属性面板 |

#### §3.2.4 云端同步

| 属性 | 说明 |
|---|---|
| Profile | `kind: 'data-twin-layout'` / `id: 'data-twin-layout:main-office'` / `name: '公司数字孪生排布'` |
| 加载 | 首载调 `apiService.listBusinessProfiles` 拉取，`normalizeLayoutSnapshot` 校验后 `applyLayoutSnapshot` |
| 缓存 | `localStorage` key `bambook:data-twin-layout:v2` 兜底，离线可读；JSON 解析失败自动清除 |
| 保存 | `saveLayout` 调 `apiService.saveBusinessProfile`，`saveState` 四态：idle / saving / saved / failed |
| 容错 | 云端同步失败仅 console.warn，不阻断本地编辑 |

### §3.3 数据字典（前瞻设计，未在本页落地）

> **状态**：⚠️ 待落地——当前数据字典散落在 `AdminPanel.tsx` / `Settings.tsx`，数据中心本页未承载。本节为 IA 收口后的扩展设计。

### §3.4 系统资产（前瞻设计，未在本页落地）

> **状态**：⚠️ 待落地——当前系统资产（API key / Webhook / 自动化触发器等）散落在 `Settings.tsx`，数据中心本页未承载。

---

## §4 模式切换

| 模式 | 触发 | 行为 |
|---|---|---|
| 数据看板（默认） | `activeTab='overview'` | RAG 智能问答工作台，textarea + 流式回答 + 命中片段 + 归档 |
| 数字孪生 | `activeTab='twin'` | SVG 布局编辑器，含工具栏 + 画布 + 属性面板 |
| 浏览态 | `activeTab='twin' && !isEditingLayout` | 只读画布，可平移/缩放 ViewBox，不可拖拽对象 |
| 编辑态 | `activeTab='twin' && isEditingLayout` | 工具栏激活 + 对象可拖拽/添加/删除 + 属性面板可编辑 + 显示「保存布局」按钮 |

Tab 切换通过 `switchTab(next)` 实现，切换时清空问答状态（`qaQuestion/qaAnswer/qaCitations/qaError` 重置）避免跨 tab 残留。

---

## §5 状态机（问答流 + 布局保存）

### §5.1 RAG 问答流

```
   idle ──输入问题──► ready ──点提问──► busy (流式回答中)
                                            │
                                            │ SSE 完成
                                            ▼
                                         answered (含 citations)
                                            │
                                            │ 点归档
                                            ▼
                                       archiving ──成功──► archived
                                            │
                                            │ 失败
                                            ▼
                                         error
```

| 状态 | 字段 | 视觉 |
|---|---|---|
| `idle` | `qaQuestion=''` | 仅 textarea + 快捷提问 |
| `ready` | `qaQuestion.trim() !== ''` | 「提问」按钮启用 |
| `busy` | `qaBusy=true` | `Loader2` + 「检索回答中…」+ 流式回答边生成边渲染 |
| `answered` | `qaAnswer !== '' && !qaBusy` | 完整回答 + 命中片段列表 + 归档区 |
| `archiving` | `qaArchiving=true` | 归档按钮禁用 + Loader |
| `archived` | `qaArchived=true` | 「已归档」标记 |
| `error` | `qaError != null` | danger 红边框 + 错误文案 |

### §5.2 布局保存

```
   idle ──点保存──► saving ──成功──► saved (3s 后回 idle)
                       │
                       │ 失败
                       ▼
                    failed (重试回 saving)
```

---

## §6 数据模型

真源：`types.ts` + `DataCenter.tsx`

```ts
// 知识库条目（业务运行时真源）
interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  category: 'Product' | 'Policy' | 'Customer' | 'Production' | 'Company' | 'Supplier';
  updatedAt: number;
  deletedAt?: number;
  sourceUrl?: string;
}

// 向量检索命中片段（Python knowledge_api /v1/knowledge/search 契约）
interface KnowledgeCitation {
  id: string;
  title: string;
  content: string;
  score: number;          // 相似度分数 0-1
}

// SOP 标准作业程序模板
interface SopTemplate {
  id: string;
  title: string;
  category: string;
  summary?: string | null;
  content: string;
  steps: SopStep[];
  version: number;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

// 数字孪生布局快照（云端同步 payload）
interface LayoutSnapshot {
  officeFrame: OfficeFrame;
  rooms: RoomRect[];
  walls: WallSegment[];
  doors: DoorGap[];
  objects: TwinObject[];
  selectedId: string;
}
```

**问答归档分类**（`QA_ARCHIVE_CATEGORIES`）：与策略文库 `KnowledgeItem.category` 同一枚举语义，归档后进入检索语料。

---

## §7 API 端点清单

| 端点 | 方法 | 用途 | 权限 |
|---|---|---|---|
| `/v1/knowledge/search` | POST | 向量检索知识语料，返回 `KnowledgeCitation[]` | `knowledge:read` |
| `/v1/knowledge/qa/stream` | POST (SSE) | LLM 流式回答 + 命中片段 | `knowledge:read` |
| `/v1/knowledge/items` | POST | 归档问答为知识文档 | `knowledge:write` |
| `/v1/business-profiles` | GET | 拉取数字孪生布局 Profile | `system:config:read` |
| `/v1/business-profiles` | PUT | 保存数字孪生布局 Profile | `system:config:write` |

**离线兜底**：布局 Profile 拉取失败时回退 `localStorage` 缓存（key `bambook:data-twin-layout:v2`），JSON 解析失败自动清除。

---

## §8 权限矩阵

| 角色 | 提问 + 看回答 | 看命中片段 | 归档问答 | 浏览数字孪生 | 编辑数字孪生布局 |
|---|---|---|---|---|---|
| Sales / SalesManager / Finance / FinanceManager / Operations / Warehouse | ✅ | ✅ | ❌ | ✅ | ❌ |
| Admin / SuperAdmin | ✅ | ✅ | ✅ | ✅ | ✅ |
| 任意 `knowledge:write` scope 持有者 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 任意 `system:config:write` scope 持有者 | ✅ | ✅ | ❌ | ✅ | ✅ |

> **铁律**：归档动作沉淀为知识文档进入检索语料，影响全公司后续问答质量，必须 `knowledge:write` scope；数字孪生布局编辑影响公司资产可视化，必须 `system:config:write` scope。

---

## §9 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 空态：无提问 | `qaQuestion='' && !qaAnswer` | 仅 textarea + 快捷提问 chips | placeholder「向企业知识库提问…」 |
| 加载中 | `qaBusy=true` | `Loader2` + 「检索回答中…」+ 流式回答边生成边渲染 | 不显示静态文案 |
| 错误 | `qaError != null` | danger 红边框 + 红字 | `${qaError}`（如「问答服务暂不可用，请稍后重试」） |
| 无权限 | 无 `knowledge:read` scope | 由 App 层路由拦截 | 「您无权访问数据中心」 |
| 已归档 | `qaArchived=true` | 「已归档」标记 + success 绿 | 「问答已沉淀至知识库」 |

---

## §10 移动端设计

| 行为 | 实现 |
|---|---|
| 提问区 | textarea rows=3 + 快捷提问 chips 自适应换行（`flex-wrap`） |
| 回答区 | 单列堆叠，命中片段纵向排列 |
| 数字孪生 | ⚠️ 当前 SVG 画布固定 820×620，移动端未做触摸优化（pinch zoom / pan 需补） |
| 工具栏 | ⚠️ 6 工具按钮在窄屏会挤压，需补横向滚动或抽屉式工具栏 |
| 布局 | `mx-auto flex w-full max-w-3xl flex-col gap-5`，最大宽度 768px 居中 |

---

## §11 业务规则关联

| 规则 | 关联 | 说明 |
|---|---|---|
| 全局交互规范 | `01-产品总览/5. 全局交互规范.md` | Cmd+K 知识域搜索（5 条上限） |
| 知识库深化 | PRD §C7 | RAG 向量检索 + SOP 模板 + EntityLink 实体关联 |
| 角色权限矩阵 | `01-产品总览/6. 角色与权限矩阵.md` | knowledge:read / knowledge:write / system:config scope |
| 业务事件联动 | `03-业务规则/10条事件联动（L1-L10）与事件总线.md` | 知识文档创建/归档触发 L* 联动（预留） |

---

## §12 可访问性

| 快捷键 / 行为 | 状态 |
|---|---|
| textarea `aria-label` | ⚠️ 未补，仅 placeholder |
| 快捷提问 chips 键盘焦点 | ✅ `<button>` 原生可聚焦 |
| 流式回答 `aria-live` | ⚠️ 未补，屏幕阅读器无法实时朗读流式回答 |
| 数字孪生 SVG `role="img"` + `aria-label` | ⚠️ 未补 |
| 工位 presence 色盲友好 | ⚠️ online/away/offline 仅靠颜色区分，需补图标 |

---

## §13 设计系统约束

- **容器**：`BAMBOOK_OS.material.card` + `bg-[var(--recessed-bg)] dark:bg-deep/48`；提问区 `p-6 rounded-control`
- **圆角**：`rounded-control`（提问区）/ `rounded-full`（chips / tab 按钮）/ `rounded-compact`（tab 按钮），禁止硬编码
- **颜色**：`var(--text-primary/tertiary)` / `var(--border-c-default)` / `var(--recessed-bg)` / `var(--recessed-bg-hover)` 全部走 token；归档成功用 success 绿，错误用 danger 红
- **字重**：`font-light` 铁律；overline `text-[10px] tracking-wide`
- **SVG**：数字孪生画布用 `vectorEffect="non-scaling-stroke"` 保持线宽不随缩放变化
- **Tab 切换**：`BAMBOOK_OS.controls.selectedSurface.base` 选中态 + `BAMBOOK_OS.controls.actionControl.base` 容器
- **防回退**：`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-DC1 | 数据字典子模块未在数据中心本页收口（散落 AdminPanel / Settings） | 用户需跨模块查找字典维护入口 | P2 |
| GAP-DC2 | 系统资产子模块（API key / Webhook / 自动化触发器）未在本页收口 | 同上 | P2 |
| GAP-DC3 | 流式回答无 `aria-live` | 屏幕阅读器无法实时朗读 | P2 |
| GAP-DC4 | 数字孪生移动端未做触摸优化（pinch zoom / pan） | 移动端浏览体验差 | P3 |
| GAP-DC5 | 工位 presence 仅靠颜色区分，无图标 | 色盲用户无法区分 online/away/offline | P2 |
| GAP-DC6 | 命中片段无 score 阈值过滤 | 低相关度片段淹没高相关度片段 | P3 |
| GAP-DC7 | 问答历史未持久化（切换 tab 即丢失） | 用户无法回看历史问答 | P2 |

---

## §15 相关文档索引

- [../00-索引.md](../../00-索引.md) — 设计文档真源总索引
- [../../01-产品总览/5. 全局交互规范.md](../../01-产品总览/5.%20全局交互规范.md) — Cmd+K 知识域搜索
- [../../01-产品总览/6. 角色与权限矩阵.md](../../01-产品总览/6.%20角色与权限矩阵.md) — knowledge:read / knowledge:write / system:config scope
- [../../02-数据模型/实体关系总览.md](../../02-数据模型/实体关系总览.md) — KnowledgeItem / SopTemplate 模型
- [../../03-业务规则/10条事件联动（L1-L10）与事件总线.md](../../03-业务规则/10条事件联动（L1-L10）与事件总线.md) — 知识文档创建/归档联动
- [Dashboard-首页.md](./Dashboard-首页.md) — 全景看板
- [Cockpit-经营驾驶舱.md](./Cockpit-经营驾驶舱.md) — 经营预警入口
- [Reports-报表中心.md](./Reports-报表中心.md) — 报表明细与台账

---

## §16 补充说明

1. **RAG 闭环铁律**：问答 → 命中片段 → 一键归档 → 进入检索语料 → 提升后续问答质量。归档分类与策略文库 `KnowledgeItem.category` 同一枚举语义，确保归档文档可被策略文库 CRUD 复用
2. **数字孪生本地+云端双源**：布局 Profile 优先云端拉取，失败回退 `localStorage` 缓存——离线模式下仍可浏览上次布局；保存时云端为主，localStorage 同步更新作为兜底
3. **工位吸附算法**：`snapStationToStations` 检测移动工位与静止工位的 xGap/yGap，在 threshold 10px 内自动吸附为并排/对向布局（desk join gap 0.6px），模拟真实办公桌拼接；吸附后 `snapPoint` 再做 grid=2 微调
4. **撤销栈上限 40 步**：`undoStack` 用 `stack.slice(-39)` 保留最近 40 步快照，避免内存膨胀；每步快照深拷贝 `LayoutSnapshot` 全字段
5. **画布尺寸固定 820×620**：当前未做响应式画布尺寸，移动端需补 pinch zoom / pan（GAP-DC4）；ViewBox 可缩放但画布逻辑坐标固定
6. **数据字典 / 系统资产未收口**：当前散落在 AdminPanel / Settings，IA 收口后应迁移至数据中心本页作为第 3 / 第 4 tab，与知识问答 / 数字孪生形成「知识 + 资产 + 字典 + 孪生」四合一数据中枢
