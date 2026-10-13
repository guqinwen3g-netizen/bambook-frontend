# SidePanelContainer 组件规格 · 玻璃表面侧边面板容器

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `SidePanelContainer` |
| 定位 | BDS 玻璃表面容器的 React 封装——所有详情/订单/关联/审计面板的底层容器,统一玻璃材质(materialRole)+ 聚光(spotlight)+ 边缘渐隐(edgeFadeItem)+ 双主题自适应。P3-2 收编后 DARK/LIGHT 双写坍缩为单写自适应 |
| 文件路径 | `components/ui/SidePanelContainer.tsx`(111 行) |
| 消费方 | OrderClusterBlock / OrderLinesTable / RelatedEntitiesPanel / AuditHistorySection / ProductionPipeline / DetailPanel(间接 via CompiledSurfacePanel)/ RelationsManager / OrderManager / DevelopmentManager / FinanceManager / ShipmentManager 等 15+ 组件 |
| 范式 | 通用容器型——`React.forwardRef` + 多态 `as` 标签 + 可选 SpotlightCard 聚光;无业务状态,纯材质与布局封装 |
| 优先级 | P0(BDS 玻璃表面地基,全项目面板容器统一真源) |
| 实现状态 | ✅ 已落地(forwardRef + 5 种 as 标签 + SpotlightCard 可选聚光 + materialRole/surfaceRole/shadowRole 三角色 + materialTone panel/nested 双层级 + edgeFadeItem 边缘渐隐标记);✅ P3-2 单写自适应(BAMBOOK_OS.material.glassColor 双主题同配方);⚠️ shadowRole/shadowMode 当前强制为 'none'(flat 设计无阴影,保留参数为未来设计演进) |
| PRD 关联 | PRD §5.2(BDS 玻璃表面规范)/ §5.3(flat 设计四大特征:无阴影/无 rim/大圆角/半透明膜) |
| 代码关联 | [SidePanelContainer.tsx](../../components/ui/SidePanelContainer.tsx) / [SpotlightCard.tsx](../../components/ui/SpotlightCard.tsx) / [bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts) `BAMBOOK_OS.material / BAMBOOK_OS.spotlight` / [osMaterial.ts](../../components/ui/osMaterial.ts) `OS_MATERIAL / OS_SHADOW` / [styles/bds/components.css](../../styles/bds/components.css) `.bds-card / .bds-surface` |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 内部结构)

```ts
type SidePanelElement = 'div' | 'section' | 'aside' | 'nav';

type SidePanelContainerProps = React.HTMLAttributes<HTMLElement> & {
  as?: SidePanelElement;
  isDarkMode: boolean;
  contentClassName?: string;
  /** Layout classes. Flat mode merges them into the material node to avoid caster/panel size deltas. */
  wrapperClassName?: string;
  spotlight?: boolean;
  spotlightSizing?: SpotlightSizingMode;
  spotlightColor?: string;
  spotlightSize?: number;
  edgeFadeItem?: boolean;
  materialRole?: OSMaterialRole;
  surfaceRole?: OSMaterialRole;
  shadowRole?: OSShadowRole;
  shadowMode?: OSShadowMode;
  materialTone?: 'panel' | 'nested';
};

const SidePanelContainer = React.forwardRef<HTMLElement, SidePanelContainerProps>(({
  as: Tag = 'div',
  isDarkMode,
  className = '',
  wrapperClassName = '',
  contentClassName = 'relative z-10',
  spotlight = false,
  materialRole = 'framePanel',
  materialTone = 'panel',
  children,
  ...props
}, ref) => {
  // 解析角色(flat 设计强制 shadowRole/shadowMode = 'none')
  const resolvedSurfaceRole = surfaceRole ?? materialRole;
  const resolvedShadowRole: OSShadowRole = shadowRole === 'none' ? shadowRole : 'none';
  const resolvedShadowMode: OSShadowMode = shadowMode === 'none' ? shadowMode : 'none';
  const resolvedSpotlightSizing = spotlightSizing ?? (resolvedSurfaceRole === 'framePanel' ? 'frame' : 'auto');

  // 单写自适应材质类(BAMBOOK_OS.material.glassColor 双主题同配方)
  const materialToneClass = materialTone === 'nested'
    ? BAMBOOK_OS.material.nestedSurface
    : SIDE_PANEL_CLASS;
  const panelExtraClass = `${wrapperClassName} ${className}`.trim().replace(/\s+/g, ' ');
  const panelClassName = `${SIDE_PANEL_BASE_CLASS} ${materialToneClass} ${SIDE_PANEL_OUTER_CLASS} ${OS_MATERIAL[resolvedSurfaceRole]} ${panelExtraClass}`;

  const content = <div className={contentClassName}>{children}</div>;

  const shadowProps = {
    'data-os-surface-role': resolvedSurfaceRole,
    'data-os-shadow-role': OS_SHADOW[resolvedShadowRole],
    'data-os-shadow-mode': resolvedShadowMode,
  };
  const maskProp = edgeFadeItem ? { 'data-glass-edge-mask': true } : {};

  return spotlight
    ? <SpotlightCard as={Tag} ref={ref} className={panelClassName} ...>{content}</SpotlightCard>
    : <Tag ref={ref} className={panelClassName} {...shadowProps} {...maskProp} {...props}>{content}</Tag>;
});

SidePanelContainer.displayName = 'SidePanelContainer';
```

### 渲染结构

```
<Tag as="div|section|aside|nav" ref={ref}
  className="{SIDE_PANEL_BASE_CLASS} {materialToneClass} {SIDE_PANEL_OUTER_CLASS} {OS_MATERIAL[surfaceRole]} {panelExtraClass}"
  data-os-surface-role={surfaceRole}
  data-os-shadow-role="none"
  data-os-shadow-mode="none"
  data-glass-edge-mask={edgeFadeItem ? true : undefined}
  {...props}>
  <div className={contentClassName}>
    {children}
  </div>
</Tag>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `as` | `'div' \| 'section' \| 'aside' \| 'nav'` | 否 | `'div'` | 多态标签;`section` 用于语义化区块(订单 cluster),`aside` 用于侧边栏,`nav` 用于导航 |
| `isDarkMode` | `boolean` | 是 | — | 主题标志;P3-2 起仅用于 SpotlightCard 的聚光色默认值选择(双主题同配方,材质类不依赖此 prop) |
| `contentClassName` | `string` | 否 | `'relative z-10'` | 内容包裹层 className;默认 `relative z-10` 确保内容在材质层之上 |
| `wrapperClassName` | `string` | 否 | `''` | Layout classes;flat 模式合并到材质节点,避免 caster/panel 尺寸差异 |
| `spotlight` | `boolean` | 否 | `false` | 是否启用 SpotlightCard 聚光效果;`true` 时渲染 SpotlightCard 包装 |
| `spotlightSizing` | `SpotlightSizingMode` | 否 | `framePanel→'frame'` else `'auto'` | 聚光尺寸模式 |
| `spotlightColor` | `string` | 否 | 主题默认 | 聚光颜色;默认 dark/light 各自的 `BAMBOOK_OS.spotlight.panelDark/LightColor` |
| `spotlightSize` | `number` | 否 | 主题默认 | 聚光尺寸;默认 dark/light 各自的 `BAMBOOK_OS.spotlight.panelDark/LightSize` |
| `edgeFadeItem` | `boolean` | 否 | `false` | 边缘渐隐标记;`true` 时设置 `data-glass-edge-mask` 属性,由 CompiledEdgeFade 识别并应用渐隐遮罩 |
| `materialRole` | `OSMaterialRole` | 否 | `'framePanel'` | 材质角色;决定 OS_MATERIAL 映射的材质类(framePanel / raisedCard / insetSurface 等) |
| `surfaceRole` | `OSMaterialRole` | 否 | `materialRole` | 表面角色;默认与 materialRole 一致,可单独覆盖 |
| `shadowRole` | `OSShadowRole` | 否 | `'none'`(强制) | 阴影角色;flat 设计强制为 `'none'`,传其他值也会被覆盖为 `'none'` |
| `shadowMode` | `OSShadowMode` | 否 | `'none'`(强制) | 阴影模式;同上,flat 设计强制无阴影 |
| `materialTone` | `'panel' \| 'nested'` | 否 | `'panel'` | 材质层级;`'panel'` 用 `SIDE_PANEL_CLASS`(主面板),`'nested'` 用 `BAMBOOK_OS.material.nestedSurface`(嵌套子卡) |
| `children` | `React.ReactNode` | 否 | — | 子内容;被 `<div className={contentClassName}>` 包裹 |
| `...props` | `React.HTMLAttributes<HTMLElement>` | 否 | — | 透传给 Tag 的 HTML 属性(id / onClick / style 等) |

**铁律**:`shadowRole` / `shadowMode` 当前**强制为 `'none'`**——flat 设计无阴影,保留参数仅为未来设计演进。传入其他值会被覆盖。

---

## §4 材质角色(OSMaterialRole)映射

### §4.1 OS_MATERIAL 映射表

| materialRole | OS_MATERIAL 类 | 用途 | 典型消费方 |
|---|---|---|---|
| `framePanel` | 主框架面板材质 | 顶层容器(Sidebar / 主内容区) | App.tsx 布局 |
| `raisedCard` | 凸起卡片材质 | 详情页区块/订单 cluster/关联面板 | OrderClusterBlock / RelatedEntitiesPanel / AuditHistorySection |
| `insetSurface` | 内嵌表面材质 | 嵌套子卡(parties 子组/审计行) | OrderClusterBlock 子组 / DetailPanel InfoSection |
| `floatingCard` | 浮动卡片材质 | toast/tooltip 浮层 | (当前由其他组件承载) |
| `recessedField` | 蚀刻字段材质 | 输入框/下拉 | (由 OrderFieldInput 等承载) |

### §4.2 materialTone 双层级

| materialTone | 材质类 | 用途 |
|---|---|---|
| `'panel'`(默认) | `SIDE_PANEL_CLASS`(=`BAMBOOK_OS.material.glassColor`) | 主面板/凸起卡片——半透明磨砂玻璃主色 |
| `'nested'` | `BAMBOOK_OS.material.nestedSurface` | 嵌套子卡——主面板内的二级分组,材质略深以区分层次 |

---

## §5 单写自适应(P3-2 收编)

### §5.1 双写坍缩为单写

```ts
// P3-2 前:DARK/LIGHT 双写
export const SIDE_PANEL_CLASS_DARK = BAMBOOK_OS.material.glassColorDark;
export const SIDE_PANEL_CLASS_LIGHT = BAMBOOK_OS.material.glassColorLight;

// P3-2 后:单写自适应(BAMBOOK_OS.material.glassColor 双主题同配方)
export const SIDE_PANEL_CLASS = BAMBOOK_OS.material.glassColor;
```

**收编意图**:`BAMBOOK_OS.material.glassColor` 在 dark/light 主题下使用同一配方(通过 CSS 变量自适应),消除双写维护负担。

### §5.2 导出常量清单

```ts
export const SIDE_PANEL_BASE_CLASS = BAMBOOK_OS.material.panelBase;
export const SIDE_PANEL_CLASS = BAMBOOK_OS.material.glassColor;
export const SIDE_PANEL_OUTER_CLASS = 'bambook-outer-panel';
export const SIDE_PANEL_SPOTLIGHT_DARK_COLOR = BAMBOOK_OS.spotlight.panelDarkColor;
export const SIDE_PANEL_SPOTLIGHT_LIGHT_COLOR = BAMBOOK_OS.spotlight.panelLightColor;
export const SIDE_PANEL_SPOTLIGHT_DARK_SIZE = BAMBOOK_OS.spotlight.panelDarkSize;
export const SIDE_PANEL_SPOTLIGHT_LIGHT_SIZE = BAMBOOK_OS.spotlight.panelLightSize;
```

这些常量供其他组件(如 CompiledSurfacePanel)复用同一材质配方,确保全项目玻璃表面一致。

---

## §6 SpotlightCard 聚光效果

### §6.1 聚光启用条件

```ts
return spotlight
  ? <SpotlightCard as={Tag} ref={ref} className={panelClassName}
      spotlightColor={spotlightColor ?? (isDarkMode ? SIDE_PANEL_SPOTLIGHT_DARK_COLOR : SIDE_PANEL_SPOTLIGHT_LIGHT_COLOR)}
      spotlightSize={spotlightSize ?? (isDarkMode ? SIDE_PANEL_SPOTLIGHT_DARK_SIZE : SIDE_PANEL_SPOTLIGHT_LIGHT_SIZE)}
      spotlightSizing={resolvedSpotlightSizing}
      idleSpotlightOpacity={0}
      liquidSpotlight
      liquidSpotlightTone="light"
      {...shadowProps} {...maskProp} {...props}>
      {content}
    </SpotlightCard>
  : <Tag ref={ref} className={panelClassName} {...shadowProps} {...maskProp} {...props}>{content}</Tag>;
```

**聚光特征**:
- `liquidSpotlight`:液态聚光(跟随鼠标移动的柔和光斑)
- `liquidSpotlightTone="light"`:亮色调聚光
- `idleSpotlightOpacity={0}`:空闲时聚光透明度为 0(仅鼠标悬停时显现)
- `spotlightSizing`:`framePanel` → `'frame'`(框架级聚光),其他 → `'auto'`(自适应)

### §6.2 聚光色主题适配

| 主题 | spotlightColor 默认 | spotlightSize 默认 |
|---|---|---|
| dark | `BAMBOOK_OS.spotlight.panelDarkColor` | `BAMBOOK_OS.spotlight.panelDarkSize` |
| light | `BAMBOOK_OS.spotlight.panelLightColor` | `BAMBOOK_OS.spotlight.panelLightSize` |

**isDarkMode 的唯一消费点**:P3-2 收编后,`isDarkMode` 仅用于聚光色/尺寸的默认值选择——材质类本身不依赖此 prop。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 说明 |
|---|---|---|---|
| 默认态 | `spotlight=false` | 纯材质面板(无聚光) | 用于不需要鼠标交互反馈的静态区块 |
| 聚光态 | `spotlight=true` | 鼠标悬停时液态聚光跟随 | 用于可交互区块(订单 cluster / 关联面板) |
| 边缘渐隐 | `edgeFadeItem=true` | `data-glass-edge-mask` 属性,由 CompiledEdgeFade 识别 | 滚动容器内的面板顶部/底部渐隐 |
| 嵌套态 | `materialTone='nested'` | `BAMBOOK_OS.material.nestedSurface` 材质 | 主面板内的二级分组子卡 |
| 无权限 | 父组件层控制 | 父组件不渲染 SidePanelContainer | — |

> **无阴影铁律**:flat 设计强制 `shadowRole='none'` / `shadowMode='none'`——所有静态面无 box-shadow,视觉层次靠半透明膜色和发丝分隔线构建,不是阴影。

---

## §8 联动(CompiledEdgeFade / SpotlightCard / OS_MATERIAL)

### §8.1 与 CompiledEdgeFade 的联动

```
SidePanelContainer edgeFadeItem=true
  ↓
设置 data-glass-edge-mask 属性
  ↓
父级 CompiledEdgeFade 识别该属性
  ↓
应用边缘渐隐遮罩(顶部/底部 content fade-out)
```

**典型用法**:滚动容器内的多个 SidePanelContainer 设置 `edgeFadeItem`,CompiledEdgeFade 统一管理渐隐效果。

### §8.2 与 SpotlightCard 的联动

```
SidePanelContainer spotlight=true
  ↓
渲染 SpotlightCard 包装(替代裸 Tag)
  ↓
SpotlightCard 监听鼠标移动
  ↓
liquidSpotlight 跟随鼠标显示柔和光斑
  ↓
idle 时聚光透明度=0(不显眼)
```

### §8.3 与 OS_MATERIAL 的联动

```
materialRole='raisedCard'
  ↓
OS_MATERIAL['raisedCard'] → 材质类
  ↓
合并到 panelClassName: `${SIDE_PANEL_BASE_CLASS} ${materialToneClass} ${SIDE_PANEL_OUTER_CLASS} ${OS_MATERIAL[resolvedSurfaceRole]} ${panelExtraClass}`
  ↓
最终 className 含 4 层:base + tone + outer + role + extra
```

---

## §9 状态机

SidePanelContainer 无内部状态,无状态机。所有行为由 props 驱动:

```
props 输入
  ↓
解析角色(resolvedSurfaceRole / resolvedShadowRole='none' / resolvedSpotlightSizing)
  ↓
构建 panelClassName(base + tone + outer + role + extra)
  ↓
spotlight?
  ├─ true → 渲染 SpotlightCard(聚光跟随鼠标)
  └─ false → 渲染裸 Tag(纯材质)
  ↓
edgeFadeItem? → 设置 data-glass-edge-mask
  ↓
渲染 <div className={contentClassName}>{children}</div>
```

---

## §10 数据模型

```ts
type SidePanelElement = 'div' | 'section' | 'aside' | 'nav';
type OSMaterialRole = 'framePanel' | 'raisedCard' | 'insetSurface' | 'floatingCard' | 'recessedField' | ...;
type OSShadowRole = 'none' | 'sm' | 'md' | 'lg' | ...;  // 当前强制 'none'
type OSShadowMode = 'none' | 'ghost' | 'soft' | ...;    // 当前强制 'none'
type SpotlightSizingMode = 'frame' | 'auto' | 'fixed';

// OS_MATERIAL 映射(真源:osMaterial.ts)
const OS_MATERIAL: Record<OSMaterialRole, string> = { ... };

// OS_SHADOW 映射(真源:osMaterial.ts)
const OS_SHADOW: Record<OSShadowRole, string> = { ... };
```

---

## §11 API 端点清单

SidePanelContainer 是纯 UI 容器,**不调用任何 API**。

---

## §12 权限与可见性

SidePanelContainer 无独立权限态——可见性由父组件控制。所有角色的页面只要父组件渲染了 SidePanelContainer,容器本身对主题透明,无 scope 过滤。

---

## §13 设计系统约束(BDS)

- **材质类**:`SIDE_PANEL_BASE_CLASS`(panelBase)+ `SIDE_PANEL_CLASS`(glassColor)+ `SIDE_PANEL_OUTER_CLASS`('bambook-outer-panel')+ `OS_MATERIAL[role]` 四层合并
- **单写自适应**:`BAMBOOK_OS.material.glassColor` 双主题同配方,P3-2 收编后不再 dark/light 双写
- **无阴影铁律**:`shadowRole` / `shadowMode` 强制 `'none'`——flat 设计无 box-shadow
- **无 rim**:不做 1px 边框作为默认风格;视觉层次靠半透明膜色(blur + saturate)和发丝分隔线
- **大圆角**:由 `panelExtraClass` 中的 `rounded-card / rounded-inset` 等语义类承载,禁止硬编码 `rounded-[Npx]`
- **半透明膜**:`backdrop-filter: blur(24px) saturate(180%)` + `background: rgba(x,x,x,0.4~0.7)`(由 BAMBOOK_OS.material 配方驱动)
- **聚光**:`liquidSpotlight` 液态光斑 + `idleSpotlightOpacity=0`(空闲不显眼)
- **边缘渐隐**:`data-glass-edge-mask` 属性,由 CompiledEdgeFade 识别
- **content z-index**:默认 `contentClassName='relative z-10'`,确保内容在材质层之上
- **forwardRef**:支持 ref 转发,父组件可获取 DOM 节点(用于滚动测量等)
- **多态 as**:支持 `div / section / aside / nav` 四种标签,语义化选择
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码;材质类全部走 BAMBOOK_OS token

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-SP1 | `shadowRole` / `shadowMode` 参数保留但强制 `'none'`,调用方可能误传有效值被静默覆盖 | 调用方困惑(传了 shadow 但不生效) | P3(下一版要么移除参数,要么开放) |
| GAP-SP2 | `as` 仅支持 4 种标签,不支持 `article` / `main` / `header` 等 | 语义化场景受限 | P3 |
| GAP-SP3 | 聚光效果在低端设备可能影响性能(liquidSpotlight 监听鼠标移动) | 低端设备卡顿 | P3(需性能基准测试) |
| GAP-SP4 | 无 `aria-label` / `role` 透传规范 | 可访问性场景需逐调用方手写 | P3 |
| GAP-SP5 | `wrapperClassName` 与 `className` 合并逻辑复杂(trim + replace 多空格) | 调用方可能混淆两者用途 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../01-产品总览/4. 设计系统规范.md](../01-产品总览/4.%20设计系统规范.md) — BDS v2.1 Luna flat 设计四大特征
- [PageHeader.md](./PageHeader.md) — 页面头部(SidePanelContainer 之上的顶栏)
- [DetailPanel.md](./DetailPanel.md) — 详情面板(消费 SidePanelContainer via CompiledSurfacePanel)
- [OrderClusterBlock.md](./OrderClusterBlock.md) — 订单字段簇块(直接消费 SidePanelContainer)
- [RelatedEntitiesPanel.md](./RelatedEntitiesPanel.md) — 关联面板(直接消费 SidePanelContainer)
- [AuditHistorySection.md](./AuditHistorySection.md) — 审计面板(直接消费 SidePanelContainer)
- [BDS组件族7规格.md](./BDS组件族7规格.md) — BDS 原语族(bds-card / bds-surface 规格)
- [TrackAPanel.md](./TrackAPanel.md) / [TrackBPanel.md](./TrackBPanel.md) — 定价面板(消费 SidePanelContainer 材质配方)

---

## §16 补充说明

1. **单写自适应铁律(P3-2 收编)**:`SIDE_PANEL_CLASS` 在 P3-2 前是 DARK/LIGHT 双写(`glassColorDark` / `glassColorLight`),收编后坍缩为单写 `BAMBOOK_OS.material.glassColor`——双主题同配方,由 CSS 变量自适应。`isDarkMode` prop 仅保留用于 SpotlightCard 聚光色默认值选择
2. **无阴影强制铁律**:`shadowRole` / `shadowMode` 当前**强制为 `'none'`**——flat 设计无 box-shadow,视觉层次靠半透明膜色和发丝分隔线构建。保留参数仅为未来设计演进(若 BDS 引入有阴影模式,可开放该参数)
3. **材质四层合并**:`panelClassName = ${SIDE_PANEL_BASE_CLASS} ${materialToneClass} ${SIDE_PANEL_OUTER_CLASS} ${OS_MATERIAL[resolvedSurfaceRole]} ${panelExtraClass}`——base(面板基础)+ tone(主/嵌套)+ outer(外层标记)+ role(材质角色)+ extra(调用方自定义)。四层合并确保全项目玻璃表面一致
4. **materialTone 双层级**:`'panel'`(主面板,`SIDE_PANEL_CLASS`)vs `'nested'`(嵌套子卡,`BAMBOOK_OS.material.nestedSurface`)——主面板内的二级分组用 nested 材质略深,以区分层次。这是 flat 设计无阴影下的层次构建手段
5. **edgeFadeItem 边缘渐隐标记**:`edgeFadeItem=true` 时设置 `data-glass-edge-mask` 属性——该属性本身不产生视觉效果,由父级 CompiledEdgeFade 识别并应用渐隐遮罩。这是「标记 + 解释器」分离模式,SidePanelContainer 仅打标记,渐隐效果由 CompiledEdgeFade 统一管理
6. **forwardRef + 多态 as**:支持 ref 转发(父组件可获取 DOM 节点)+ 4 种标签(div/section/aside/nav)——这是 React 多态容器的标准模式,既保证语义化又支持 ref 透传
7. **全项目容器统一真源**:SidePanelContainer 是全项目玻璃表面容器的统一真源——OrderClusterBlock / OrderLinesTable / RelatedEntitiesPanel / AuditHistorySection / ProductionPipeline 等 15+ 组件均直接消费。禁止任何组件绕过 SidePanelContainer 手写 div 容器(会破坏材质一致性)
