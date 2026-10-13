# BOM 版本管理 (BOM Version Management)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | BOM 版本管理 — Draft→Confirmed→Archived 状态机 + 版本追溯链（parentBomId）+ 版本 diff + 成本对比 |
| **入口** | BOM 列表页展开详情 → 版本号展示 / BOM 确认后修订生成新版本 |
| **核心角色** | 业务员（含成本核算、开发主管工作，宽泛容器）、财务（宽泛容器不细分） |
| **范式** | 范式 E — 版本管理 (Version Control)：状态机 + 追溯链 + diff 对比 |
| **优先级** | P1 |
| **实现状态** | ⚠️ 部分落地（3 态状态机 Draft/Confirmed/Archived ✅ + version/parentBomId 字段 ✅ + 确认/归档事务 + 审计 ✅；版本 diff UI / 成本对比视图 / 修订自动生成新版本为待补缺口） |
| **关联 PRD 章节** | §5.6（BOM 编号 + 版本）、§9（业务规则） |
| **关联代码** | [bomService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/bom/bomService.ts) `confirmBOM` / `archiveBOM` / `TRANSITIONS` / [BomManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/BomManager.tsx) L517 版本号展示 / `schema.prisma` BOM.version / BOM.parentBomId |

---

## §2 版本管理总览

### 2.1 版本与状态的关系

```
版本 1 (v1)
  Draft ──confirm──▶ Confirmed ──archive──▶ Archived (终态)
                         │
                         └──revise──▶ 版本 2 (v2) Draft
                                          │
                                          └──confirm──▶ Confirmed ──archive──▶ Archived
                                                                │
                                                                └──revise──▶ 版本 3 (v3) Draft ...
```

- **版本号**（version）：从 1 开始，每次修订 +1
- **状态**（status）：每个版本独立走 Draft → Confirmed → Archived 3 态
- **追溯链**（parentBomId）：新版本指向上一版本 BOM ID，形成链表

### 2.2 当前实现 vs 待补

| 能力 | 实现状态 | 代码真源 |
|------|---------|---------|
| 3 态状态机（Draft/Confirmed/Archived） | ✅ | `bomService.ts` `TRANSITIONS` |
| version 字段（从 1 开始） | ✅ | `schema.prisma` L3933 |
| parentBomId 字段（追溯链） | ✅ | `schema.prisma` L3934 |
| 确认（Draft → Confirmed） | ✅ | `bomService.ts` `confirmBOM` |
| 归档（Draft/Confirmed → Archived） | ✅ | `bomService.ts` `archiveBOM` |
| 确认后修订生成新版本 | ⚠️ 字段就绪，自动生成逻辑待补 | — |
| 版本 diff UI | ❌ 待补 | — |
| 成本对比视图 | ❌ 待补 | — |
| 版本历史列表 | ❌ 待补 | — |

---

## §3 状态机详解

### 3.1 3 态定义

| 状态 | 中文名 | badge 语义色 | 说明 |
|------|--------|-------------|------|
| Draft | 草稿 | neutral | 可编辑/删除/重新计算；初始状态 |
| Confirmed | 已确认 | success | 不可编辑；可归档；发布 BOMConfirmed 事件 |
| Archived | 已归档 | info | 终态；不可变更；历史留档 |

### 3.2 合法转换矩阵

代码真源：`bomService.ts` L87-L91

```typescript
const TRANSITIONS: Record<string, BOMStatus[]> = {
  Draft: ['Confirmed', 'Archived'],
  Confirmed: ['Archived'],
  Archived: [], // 终态
};
```

| 当前态 | 可推进到 | 操作函数 |
|--------|---------|---------|
| Draft | Confirmed | `confirmBOM()` |
| Draft | Archived | `archiveBOM()` |
| Confirmed | Archived | `archiveBOM()` |
| Archived | （无） | — |

### 3.3 状态转换校验

每次转换前校验：
```typescript
const allowed = TRANSITIONS[existing.status] ?? [];
if (!allowed.includes(targetStatus)) {
  throw new Error(`非法状态转换：${existing.status} → ${targetStatus}`);
}
```

非法转换返回 HTTP 409。

### 3.4 操作限制矩阵

| 操作 | Draft | Confirmed | Archived |
|------|-------|-----------|----------|
| 编辑（updateBOM） | ✅ | ❌ | ❌ |
| 重新计算（recalculateCost） | ✅ | ❌ | ❌ |
| 删除（deleteBOM） | ✅ | ❌ | ❌ |
| 确认（confirmBOM） | ✅ | ❌ | ❌ |
| 归档（archiveBOM） | ✅ | ✅ | ❌ |

---

## §4 版本追溯链

### 4.1 parentBomId 字段

代码真源：`schema.prisma` L3934

```prisma
parentBomId String? // 上一版本 BOM ID（版本追溯）
```

- 创建 BOM 时 `parentBomId = null`（初始版本）
- 修订生成新版本时 `parentBomId = <原 BOM ID>`

### 4.2 追溯链结构

```
v3 (BOM-2026-003, parentBomId=BOM-2026-002)
 ↑
v2 (BOM-2026-002, parentBomId=BOM-2026-001)
 ↑
v1 (BOM-2026-001, parentBomId=null)
```

通过 `parentBomId` 可逆向追溯整个版本历史。

### 4.3 版本号生成规则

- 初始版本：`version = 1`（`schema.prisma` `@default(1)`）
- 修订版本：`version = parentBom.version + 1`（待实现的修订逻辑中生成）

---

## §5 确认流程（Draft → Confirmed）

### 5.1 confirmBOM 事务

代码真源：`bomService.ts` L560-L628

```
confirmBOM(id, actorId)
  ① 查询 BOM（含 lines + costEstimates）
  ② 校验存在 + 未删除
  ③ 校验状态转换合法性（Draft → Confirmed）
  ④ prisma.$transaction:
     - tx.bOM.update({ status: 'Confirmed' })
     - tx.auditLog.create({ action: 'confirm_bom', before: Draft, after: Confirmed })
  ⑤ 事务提交后发布 BOMConfirmed 事件（fire-and-forget）
```

### 5.2 BOMConfirmed 事件

代码真源：`bomService.ts` L601-L624

```typescript
businessEventBus.publish({
  type: 'BOMConfirmed',
  sourceEntityType: 'BOM',
  sourceEntityId: id,
  payload: {
    bomId, bomNumber, description,
    totalCost, totalMaterialCost, totalLaborCost, totalOverheadCost,
    currency, orderId, lineCount,
  },
});
```

**事件消费方**：可触发下游联动（如采购单生成、生产排产参考）。

### 5.3 审计日志

```typescript
{
  action: 'confirm_bom',
  targetType: 'BOM',
  operationType: 'transition',
  fieldPath: 'status',
  beforeValue: 'Draft',
  afterValue: 'Confirmed',
}
```

---

## §6 归档流程（→ Archived）

### 6.1 archiveBOM 事务

代码真源：`bomService.ts` L634-L673

```
archiveBOM(id, actorId)
  ① 查询 BOM
  ② 校验存在 + 未删除
  ③ 校验状态转换合法性（Draft/Confirmed → Archived）
  ④ prisma.$transaction:
     - tx.bOM.update({ status: 'Archived' })
     - tx.auditLog.create({ action: 'archive_bom', before, after: 'Archived' })
```

### 6.2 归档语义

- 归档 = 历史留档，不可变更
- 归档后 BOM 仍在列表可见（通过 status 筛选 Archived）
- 归档 BOM 可作为 L6 联动的模板来源（`status in ['Confirmed', 'Archived']`）

---

## §7 修订生成新版本（待补）

### 7.1 当前状态

当前 `bomService.ts` 未实现 `reviseBOM()` 函数。Confirmed 状态的 BOM 无法直接修订生成新版本。

### 7.2 设计方案

```
reviseBOM(id, actorId)
  ① 查询 Confirmed BOM（含 lines + costEstimates）
  ② 校验 status === 'Confirmed'
  ③ prisma.$transaction:
     - 创建新 BOM（version = parent.version + 1, parentBomId = id, status = 'Draft'）
     - 复制原 BOM 的 lines → 新 BOM 的 lines
     - 复制原 BOM 的 costEstimates → 新 BOM 的 costEstimates
     - 复制 sellingPrice / currency / productAssetId / orderId / quotationId
     - 原 BOM 状态不变（保持 Confirmed）
     - tx.auditLog.create({ action: 'revise_bom', ... })
  ④ 返回新 BOM（Draft 状态，可编辑）
```

### 7.3 版本链更新

```
修订前：
  v1 (Confirmed) ← 当前活跃版本

修订后：
  v1 (Confirmed) ← 仍可查询
  v2 (Draft, parentBomId=v1.id) ← 新活跃版本，可编辑
```

---

## §8 版本 diff（待补）

### 8.1 当前状态

当前无版本 diff UI，无法对比两个版本的差异。

### 8.2 设计方案

**diff 维度**：

| 维度 | 对比内容 |
|------|---------|
| 物料行增删 | 新版本新增/删除的 BOMLine |
| 物料行修改 | quantity / unitCost / wastagePercent / materialType 变更 |
| 成本估算项变更 | CostEstimate 增删改 |
| 成本汇总变化 | totalMaterialCost / totalLaborCost / totalOverheadCost / totalCost 变化 |
| 利润变化 | sellingPrice / profitMargin / profitAmount 变化 |

**diff 展示**：
- 表格形式，左右两列对比
- 增加行：绿色背景
- 删除行：红色背景
- 修改行：黄色背景 + 旧值→新值

### 8.3 diff API 设计（待实现）

```
GET /api/v1/bom/:id/diff?compareTo=:otherId
→ {
  linesAdded: [...],
  linesRemoved: [...],
  linesModified: [...],
  costEstimatesAdded: [...],
  costEstimatesRemoved: [...],
  costSummaryDiff: { totalCost: { from, to }, ... },
}
```

---

## §9 成本对比视图（待补）

### 9.1 当前状态

当前无跨版本成本对比视图。

### 9.2 设计方案

**成本对比卡片**：

| 指标 | v1 | v2 | 变化 | 变化率 |
|------|----|----|------|--------|
| 物料成本 | 120.00 | 125.00 | +5.00 | +4.17% |
| 人工成本 | 30.00 | 30.00 | 0 | 0% |
| 制造费用 | 15.00 | 18.00 | +3.00 | +20.00% |
| 总成本 | 165.00 | 173.00 | +8.00 | +4.85% |
| 销售单价 | 200.00 | 200.00 | 0 | 0% |
| 利润额 | 35.00 | 27.00 | -8.00 | -22.86% |
| 利润率 | 17.50% | 13.50% | -4.00pp | — |

**视觉**：
- 增加项：success-text + TrendingUp
- 减少项：danger-text + TrendingDown
- 持平项：neutral

---

## §10 版本历史列表（待补）

### 10.1 当前状态

当前 BOM 列表页不展示版本历史，仅通过 `v{version}` 标签显示当前版本号。

### 10.2 设计方案

在 BOM 详情展开区增加「版本历史」面板：

```
┌─ 版本历史 ──────────────────────────────────┐
│ v3 (Draft)     ← 当前    2026-08-15 14:30  │
│ v2 (Confirmed)          2026-08-10 09:15   │
│ v1 (Archived)           2026-07-20 16:00   │
│                                              │
│ [查看 diff] [成本对比]                       │
└──────────────────────────────────────────────┘
```

**查询逻辑**：通过 `parentBomId` 链逆向追溯所有历史版本。

---

## §11 数据模型

### 11.1 BOM 版本相关字段

代码真源：`schema.prisma` L3933-L3934

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | Int @default(1) | BOM 版本号（修订递增） |
| `parentBomId` | String? | 上一版本 BOM ID（版本追溯链） |

### 11.2 版本链查询（待实现）

```typescript
// 逆向追溯所有历史版本
async function getBOMVersionHistory(prisma, bomId) {
  const history = [];
  let current = await prisma.bOM.findUnique({ where: { id: bomId } });
  while (current) {
    history.push(current);
    if (!current.parentBomId) break;
    current = await prisma.bOM.findUnique({ where: { id: current.parentBomId } });
  }
  return history; // [v3, v2, v1]
}
```

---

## §12 API 端点

### 12.1 已实现

| 方法 | 路径 | 版本管理用途 |
|------|------|-------------|
| POST | `/:id/confirm` | 确认（Draft → Confirmed） |
| POST | `/:id/archive` | 归档（→ Archived） |
| POST | `/:id/recalculate` | 重新计算成本（仅 Draft） |

### 12.2 待实现

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/:id/revise` | 修订生成新版本（Confirmed → 新 Draft） |
| GET | `/:id/versions` | 版本历史列表 |
| GET | `/:id/diff?compareTo=:otherId` | 版本 diff |

---

## §13 权限矩阵

| 角色 | 确认 | 归档 | 修订（待补） | 查看 diff（待补） |
|------|------|------|------------|------------------|
| owner / admin / manager | ✅ | ✅ | ✅ | ✅ |
| sales | ❌ | ❌ | ❌ | ✅ |
| finance | ✅ | ❌ | ✅ | ✅ |
| qc | ❌ | ❌ | ❌ | ✅（只读） |

---

## §14 业务规则关联

| # | 规则 | 接入情况 |
|---|------|---------|
| 1 | 状态转换严格校验（TRANSITIONS 矩阵） | ✅ |
| 2 | 仅 Draft 可编辑/删除/重算 | ✅ |
| 3 | 确认发布 BOMConfirmed 事件 | ✅ fire-and-forget |
| 4 | 确认/归档写审计日志 | ✅ 同事务 |
| 5 | 版本追溯链（parentBomId） | ✅ 字段就绪 |
| 6 | 修订生成新版本 | ❌ 待补 |
| 7 | 版本 diff | ❌ 待补 |
| 8 | 成本对比 | ❌ 待补 |
| 9 | 版本历史列表 | ❌ 待补 |
| 10 | 归档 BOM 可作 L6 联动模板 | ✅ `status in ['Confirmed', 'Archived']` |

---

## §15 交叉链接

| 文档 | 相对路径 |
|------|---------|
| BOM 模块概述 | `./模块概述.md` |
| BOM 编辑器 | `./BOM编辑器.md` |
| 开发模块概述 | `../Development-开发/模块概述.md` |
| 开发转订单流程 | `../Development-开发/开发转订单流程.md` |
| 订单详情页 | `../Orders-订单管理/订单详情页.md` |
| 10 条事件联动（L6 BOM 草稿） | `../../03-业务规则/10条事件联动（L1-L10）与事件总线.md` |
| 全局交互规范 | `../../01-产品总览/5. 全局交互规范.md` |

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| 模块概述 | `./模块概述.md` |
| BOM 编辑器 | `./BOM编辑器.md` |
| 状态机服务真源 | [bomService.ts `TRANSITIONS` / `confirmBOM` / `archiveBOM`](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/bom/bomService.ts#L87-L91) |
| BOM 路由真源 | [bomRoute.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/bom/bomRoute.ts) |
| L6 联动（BOM 草稿自动生成） | [L6CreateBOMDraft.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/events/linkages/L6CreateBOMDraft.ts) |
| BOM 模型 schema | [schema.prisma L3919-L3966](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma#L3919-L3966) |
