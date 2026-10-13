# 设计系统实验室 UiLab 设计

> 模块代号：`Settings / UiLab (Design System Lab)`
> 父模块：[Settings 账户与系统配置](./账户与系统配置.md)
> 关联代码：`components/ui/osCompiler/compiledProductModuleSettingsTemplates.tsx`、`App.tsx`（appScale + productModuleSettings）、`lib/modulePermissions.ts`（View.UiLab dev-only）、`types.ts`（View.UiLab）、`components/moduleRegistry.ts`（ModuleRuntimeSurface: 'ui-lab' / 'ui-lab-2'）
> 文档版本：v1.0 · 最后更新：2026-08-15

---

## §1 实现状态

| 维度 | 状态 | 说明 |
| --- | --- | --- |
| View 枚举 | ✅ 已落地 | `View.UiLab = 'ui-lab'`（types.ts 31 行），独立视图标识。 |
| 权限策略 | ✅ 已落地 | `policy: 'dev-only'`（modulePermissions.ts 40 行），仅开发环境可访问。 |
| 视图重定向 | ✅ 已落地 | `App.tsx` 374 行：`if (saved === View.UiLab) return View.Dashboard`，生产环境强制跳转 Dashboard。 |
| 全局缩放 | ✅ 已落地 | `appScale` 状态 + `computeResponsiveUiLabScale` 响应式计算 + `--ui-lab-app-scale` CSS 变量。 |
| 产品模块设置 | ✅ 已落地 | `compiledProductModuleSettingsTemplates.tsx`：5 区段（overview/field-management/classification-system/dictionary-terms/list-display）。 |
| 持久化 | ✅ 已落地 | `UI_LAB_PRODUCT_MODULE_SETTINGS_KEY = 'bambook_ui_lab_product_module_settings'`（localStorage）。 |
| 字段定义 | ✅ 已落地 | `PRODUCT_MODULE_FIELD_DEFINITIONS`：12 个字段（sku/name/season/articleNo/...）分 5 组（基础信息/面料信息/规格参数/价格库存/认证风险）。 |
| 表格列定义 | ✅ 已落地 | `PRODUCT_MODULE_TABLE_COLUMN_DEFINITIONS`：9 列（sku/name/articleNo/...）。 |
| 排序选项 | ✅ 已落地 | `PRODUCT_MODULE_SORT_OPTIONS`：6 种排序（updatedAt:desc / sku:asc / ...）。 |
| 状态选项 | ✅ 已落地 | `PRODUCT_MODULE_STATUS_OPTIONS`：3 态（Development/Active/Archived）。 |
| 运行时表面 | ✅ 已落地 | `ModuleRuntimeSurface` 含 `'ui-lab'` + `'ui-lab-2'` 两种（moduleRegistry.ts 74-75 行）。 |
| 组件编译 | ✅ 已落地 | `CompiledSplitWorkspace` / `CompiledFormSectionPanel` 等 compiled 原语承载。 |
| BDS v2.1 主题 | ✅ 已落地 | 使用 `BAMBOOK_OS` token + flat 设计。 |

---

## §2 业务定位与目标

### 2.1 业务定位

UiLab 是 Bambook 的「**设计系统与产品模块配置实验室**」——承载两类能力：

1. **全局视觉缩放**：通过 `appScale` 控制全局 UI 缩放比例，适配不同屏幕尺寸与可访问性需求
2. **产品模块配置**：定义产品档案模块的字段/分类/字典/列表显示等配置，是 `ProductsManager` 的「配置面板」

### 2.2 dev-only 策略

- `View.UiLab` 权限为 `dev-only`，生产环境强制重定向到 Dashboard
- 配置能力通过 `Settings` 的 appearance Tab（缩放）和 `compiledProductModuleSettingsTemplates`（产品模块）暴露给最终用户
- 独立 `UiLab` 视图仅用于开发期调试

### 2.3 核心目标

1. **全局缩放可响应**：根据屏幕尺寸自动计算 `appScale`，也可手动调整
2. **产品模块可配置**：字段必填/表格列可见/默认排序/状态选项/字典术语等均可配置
3. **配置持久化**：通过 localStorage 持久化，跨会话保留
4. **编译原语复用**：使用 `CompiledSplitWorkspace` 等 compiled 原语，与主应用视觉一致
5. **dev-only 隔离**：生产环境不暴露独立 UiLab 入口

---

## §3 核心概念与术语

| 术语 | 定义 |
| --- | --- |
| `View.UiLab` | 独立视图标识，dev-only，生产环境重定向到 Dashboard |
| `appScale` | 全局缩放比例（如 0.85/1.0/1.15），写入 `--ui-lab-app-scale` CSS 变量 |
| `computeResponsiveUiLabScale` | 响应式缩放计算函数（根据屏幕尺寸） |
| `UiLabProductModuleSettings` | 产品模块设置对象（requiredFieldIds/visibleTableColumnIds/...） |
| `UI_LAB_PRODUCT_MODULE_SETTINGS_KEY` | localStorage 持久化 key |
| `ModuleRuntimeSurface` | 模块运行时表面枚举，含 `'ui-lab'` / `'ui-lab-2'` |
| `CompiledSplitWorkspace` | 编译原语：分栏工作区 |
| `CompiledFormSectionPanel` | 编译原语：表单区段面板 |
| `PRODUCT_MODULE_FIELD_DEFINITIONS` | 产品字段定义清单（12 字段 × 5 组） |
| `PRODUCT_MODULE_TABLE_COLUMN_DEFINITIONS` | 产品表格列定义清单（9 列） |
| `PRODUCT_MODULE_SORT_OPTIONS` | 产品排序选项清单（6 种） |
| `PRODUCT_MODULE_STATUS_OPTIONS` | 产品状态选项清单（3 态） |

---

## §4 全局缩放

### 4.1 appScale 状态

```typescript
// App.tsx
const [appScale, setAppScale] = useState(() =>
  isDev ? 1.0 : computeResponsiveUiLabScale(...)
);

// 写入 CSS 变量
['--ui-lab-app-scale' as any]: appScale.toFixed(4),
```

### 4.2 应用范围

- **侧边栏宽度**：`(isCollapsed ? 64 : 232) * appScale` px
- **侧边栏偏移**：`sidebarOffset={(isCollapsed ? 64 : 232) * appScale}`
- **全局缩放**：`--ui-lab-app-scale` 变量驱动 CSS transform/字号/间距

### 4.3 响应式计算

```typescript
import { computeResponsiveUiLabScale } from './components/ui/osCompiler/...';

setAppScale(computeResponsiveUiLabScale(
  // 屏幕尺寸参数
));
```

- 开发模式：固定 1.0
- 生产模式：根据屏幕尺寸自动计算（小屏缩小，大屏放大）

### 4.4 影响范围

| CSS 变量 | 用途 |
| --- | --- |
| `--ui-lab-app-scale` | 全局缩放根变量 |
| `--app-sidebar-visual-w` | 侧边栏视觉宽度（`{232 * appScale}px`） |

---

## §5 产品模块设置

### 5.1 UiLabProductModuleSettings 结构

```typescript
export type UiLabProductModuleSettings = {
  requiredFieldIds: string[];           // 必填字段 ID 清单
  visibleTableColumnIds: string[];      // 表格可见列 ID 清单
  defaultListDisplayMode: 'grid' | 'table';  // 默认列表显示模式
  defaultSortValue: string;             // 默认排序值（如 'updatedAt:desc'）
  statusOptions: Array<ProductAsset['status']>;  // 状态选项
  compositionTerms: ProductModuleCompositionTerm[];  // 成分字典术语
  requireSkuUnique: boolean;            // SKU 是否要求唯一
  protectManualFields: boolean;          // 保护手动录入字段
  pdmlAutoMap: boolean;                  // PDML 自动映射
  updatedAt: number;                    // 最后更新时间
};
```

### 5.2 默认值

```typescript
export const DEFAULT_PRODUCT_MODULE_SETTINGS: UiLabProductModuleSettings = {
  requiredFieldIds: ['sku', 'name', 'season', 'articleNo', 'millQuality'],
  visibleTableColumnIds: ['sku', 'name', 'articleNo', 'millQuality', 'clientCode', 'factoryPrice', 'stock', 'updatedAt'],
  defaultListDisplayMode: 'grid',
  defaultSortValue: 'updatedAt:desc',
  statusOptions: ['Development', 'Active', 'Archived'],
  compositionTerms: COMPOSITION_TERMS.slice(0, 16).map(...),
  requireSkuUnique: true,
  protectManualFields: false,
  pdmlAutoMap: true,
  updatedAt: PRODUCT_MODULE_SETTINGS_DEMO_NOW,
};
```

### 5.3 5 区段

| SectionId | 名称 | 功能 |
| --- | --- | --- |
| `overview` | 总览 | 当前配置概览 + 重置按钮 |
| `field-management` | 字段管理 | 必填字段勾选 + 字段保护开关 |
| `classification-system` | 分类系统 | 主类目 + 子类目配置 |
| `dictionary-terms` | 字典术语 | 成分字典术语管理（增删改） |
| `list-display` | 列表显示 | 表格列可见性 + 默认排序 + 默认显示模式 |

---

## §6 字段定义

### 6.1 PRODUCT_MODULE_FIELD_DEFINITIONS（12 字段 × 5 组）

| 字段 ID | 标签 | 分组 |
| --- | --- | --- |
| `sku` | SKU | 基础信息 |
| `name` | 名称 | 基础信息 |
| `season` | 季节 | 基础信息 |
| `articleNo` | 工厂品号 | 面料信息 |
| `millQuality` | 工厂品质 | 面料信息 |
| `composition` | 成分 | 面料信息 |
| `weight` | 克重 | 规格参数 |
| `width` | 门幅 | 规格参数 |
| `factoryPrice` | 工厂价 | 价格库存 |
| `customerPrice` | 销售价 | 价格库存 |
| `stockStatus` | 库存状态 | 价格库存 |
| `certification` | 认证 | 认证风险 |

### 6.2 PRODUCT_MODULE_TABLE_COLUMN_DEFINITIONS（9 列）

| 列 ID | 标签 |
| --- | --- |
| `sku` | SKU |
| `name` | 名称 |
| `articleNo` | 品号 |
| `millQuality` | 品质 |
| `clientCode` | 客户编号 |
| `factoryPrice` | 工厂价 |
| `salesPrice` | 销售价 |
| `stock` | 库存 |
| `updatedAt` | 更新 |

### 6.3 PRODUCT_MODULE_SORT_OPTIONS（6 种）

| 排序值 | 标签 |
| --- | --- |
| `updatedAt:desc` | 更新 最新优先 |
| `sku:asc` | SKU A-Z |
| `name:asc` | 名称 A-Z |
| `articleNo:asc` | 品号 A-Z |
| `factoryPrice:desc` | 工厂价 高到低 |
| `stock:desc` | 库存 多到少 |

### 6.4 PRODUCT_MODULE_STATUS_OPTIONS（3 态）

| 值 | 标签 |
| --- | --- |
| `Development` | 开发中 |
| `Active` | 启用 |
| `Archived` | 归档 |

### 6.5 主类目选项

```typescript
const PRODUCT_MODULE_MAIN_CATEGORY_OPTIONS = [
  { id: 'Fabric', label: '面料' },
  { id: 'Garment', label: '成衣' },
  { id: 'Accessories', label: '配饰' },
  { id: 'Trimmings', label: '辅料' },
  { id: 'Merchandise', label: '周边' },
  { id: 'Other', label: '其他' },
];
```

---

## §7 持久化

### 7.1 localStorage

```typescript
export const UI_LAB_PRODUCT_MODULE_SETTINGS_KEY = 'bambook_ui_lab_product_module_settings';
```

- 读取：`readInitialProductModuleSettings`（启动时从 localStorage 读取，无则用 DEFAULT）
- 写入：`setProductModuleSettings` + 同步到 localStorage
- 跨会话保留

### 7.2 应用到 ProductsManager

```typescript
// App.tsx
const [productModuleSettings, setProductModuleSettings] = useState<UiLabProductModuleSettings>(readInitialProductModuleSettings);

// 传给 ProductsManager
<ProductsManager
  moduleSettings={productModuleSettings}
  onUpdateModuleSettings={setProductModuleSettings}
  ...
/>
```

- `ProductsManager` 消费 `moduleSettings` 渲染字段/列/排序
- `onUpdateModuleSettings` 回调写回 localStorage

---

## §8 前端组件

### 8.1 compiledProductModuleSettingsTemplates.tsx

```typescript
export const UI_LAB_PRODUCT_MODULE_SETTINGS_KEY = 'bambook_ui_lab_product_module_settings';

export type ProductModuleSettingsSectionId =
  | 'overview'
  | 'field-management'
  | 'classification-system'
  | 'dictionary-terms'
  | 'list-display';

// 组件结构
<CompiledSplitWorkspace>
  <CompiledSplitNavPanel>
    {/* 5 个 Section 导航 */}
  </CompiledSplitNavPanel>
  <CompiledSplitMainPanel>
    <CompiledModuleTitleBar />
    <CompiledFormSectionPanel>
      {/* 当前 Section 内容 */}
    </CompiledFormSectionPanel>
  </CompiledSplitMainPanel>
</CompiledSplitWorkspace>
```

### 8.2 区段内容

| Section | 内容 |
| --- | --- |
| overview | 配置摘要 + 最后更新时间 + 重置默认按钮 |
| field-management | 12 字段勾选 + `requireSkuUnique` 开关 + `protectManualFields` 开关 |
| classification-system | 6 主类目 + 子类目配置 |
| dictionary-terms | 成分字典术语 CRUD（abbreviation + chineseName + englishName） |
| list-display | 9 列勾选 + 默认排序下拉 + 默认显示模式（grid/table）切换 |

---

## §9 运行时表面

### 9.1 ModuleRuntimeSurface

```typescript
export type ModuleRuntimeSurface =
  | 'desktop'
  | 'electron'
  | 'mobile'
  | 'ui-lab'      // 第一代 UiLab 表面
  | 'ui-lab-2'    // 第二代 UiLab 表面
  | 'server'
  | 'ops';
```

- `'ui-lab'`：第一代设计系统实验室表面（已废弃）
- `'ui-lab-2'`：第二代表面，对应 `compiledProductModuleSettingsTemplates`
- 模块定义中 `runtime.surfaces` 声明该模块在哪些表面可用

### 9.2 模块定义示例

```typescript
// 某模块的 runtime 配置
runtime: {
  surfaces: ['desktop', 'electron', 'ui-lab-2'],
  rootScope: 'products'
}
```

---

## §10 交互流程

### 10.1 调整全局缩放

```
用户在 Settings → appearance Tab 调整缩放
  └─► setAppScale(newValue)
      └─► CSS 变量更新:
          ├─ --ui-lab-app-scale: {newValue}
          └─ --app-sidebar-visual-w: {232 * newValue}px
              └─► 侧边栏 + 全局 UI 重排
```

### 10.2 配置产品模块字段

```
用户在 compiledProductModuleSettingsTemplates → field-management
  └─► 勾选「sku」必填
      └─► setProductModuleSettings({ ...prev, requiredFieldIds: [...prev, 'sku'] })
          └─► 写入 localStorage
              └─► ProductsManager 下次渲染时 sku 字段标记必填
```

### 10.3 配置表格列

```
用户在 list-display → 取消勾选「stock」列
  └─► setProductModuleSettings({ ...prev, visibleTableColumnIds: prev.filter(id => id !== 'stock') })
      └─► ProductsManager 表格不再显示 stock 列
```

### 10.4 管理字典术语

```
用户在 dictionary-terms → 添加新术语
  └─► setProductModuleSettings({ ...prev, compositionTerms: [...prev, newTerm] })
      └─► ProductsManager 成分字段下拉新增选项
```

---

## §11 权限与访问控制

### 11.1 View.UiLab 权限

```typescript
// lib/modulePermissions.ts
[View.UiLab]: { policy: 'dev-only' }
```

- `dev-only`：仅开发环境可访问
- 生产环境：`App.tsx` 强制重定向到 Dashboard

### 11.2 配置能力暴露

| 配置 | 暴露入口 | 权限 |
| --- | --- | --- |
| 全局缩放 | Settings → appearance Tab | `settings:read` + `settings:write` |
| 产品模块设置 | `compiledProductModuleSettingsTemplates`（嵌入 ProductsManager） | `products:write` |
| 字典术语 | 同上 | `products:write` |

### 11.3 dev-only 检测

```typescript
// lib/modulePermissions.ts
export function isDevOnlyView(view: View): boolean {
  return getViewPermissionDefinition(view).policy === 'dev-only';
}

// App.tsx
if (saved === View.UiLab) return View.Dashboard;  // 强制重定向
```

---

## §12 审计与可观测性

### 12.1 配置变更

- 产品模块设置变更**不写 AuditLog**（localStorage 纯前端持久化）
- 全局缩放变更**不写 AuditLog**（纯视觉调整）
- 未来扩展：产品模块设置可升级到 SystemConfig 持久化 + 审计

### 12.2 重置默认

- `overview` Section 提供「重置默认」按钮
- 点击后恢复 `DEFAULT_PRODUCT_MODULE_SETTINGS`
- 重置操作不写日志

---

## §13 测试覆盖

| 测试维度 | 覆盖点 |
| --- | --- |
| View.UiLab 重定向 | 生产环境强制跳转 Dashboard |
| appScale 响应式 | 不同屏幕尺寸计算不同 scale |
| 字段勾选 | requiredFieldIds 增删 |
| 表格列勾选 | visibleTableColumnIds 增删 |
| 排序选择 | defaultSortValue 切换 |
| 显示模式 | grid/table 切换 |
| 持久化 | localStorage 读写 + 跨会话保留 |
| 重置默认 | 恢复 DEFAULT_PRODUCT_MODULE_SETTINGS |
| 字典术语 | compositionTerms CRUD |

---

## §14 已知限制与未来扩展

### 14.1 当前限制

- ❌ `View.UiLab` 独立入口已废弃（dev-only + 重定向）
- ❌ 产品模块设置仅存 localStorage，**不跨设备同步**
- ❌ 字典术语仅成分字典，**无工艺/品名等其他字典**
- ❌ 无**配置版本管理**（无历史回滚）
- ❌ 无**配置导入/导出**

### 14.2 未来扩展

- 产品模块设置升级到 SystemConfig 持久化 + 跨设备同步
- 扩展字典术语类型（工艺/品名/颜色/认证）
- 配置版本管理 + 历史回滚
- 配置导入/导出（JSON）
- 独立 UiLab 视图恢复（开发期调试用）

---

## §15 交叉链接

1. [账户与系统配置](./账户与系统配置.md) — 父模块，appearance Tab 的全局缩放部分
2. [Products 数字档案 — 模块概述](../Knowledge-知识库/../Products-数字档案/模块概述.md) — UiLab 配置 ProductsManager 的字段/列/排序
3. [Products 面料档案](../../06-资源与支撑/Products-数字档案/面料档案.md) — 面料字段配置由 UiLab 管理
4. [BDS 设计系统文档](../../../design-system/rdl-component-authority.md) — BDS 组件权威源
5. [AdminPanel 管理后台](./管理后台AdminPanel.md) — 未来 SystemConfig 持久化的配置可在 OPS Panel 管理
6. [MODULE_REGISTRY_PLAN.md](../../../../MODULE_REGISTRY_PLAN.md) — 模块注册表，含 UiLab 运行时表面定义

---

## §16 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-08-15 | 初始版本：dev-only 视图 + 全局缩放 + 产品模块设置 + 5 区段 + 持久化 |
