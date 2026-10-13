# Bambook OS 页面一致性全量台账（W-PG · 30 页）

## 新版 BDS 迁移（2026-10-09 起）

本节记录新版迁移；下方2026-08旧台账保留历史用途，其机械通过项不代表新版视觉通过。有效风格以用户最新要求、总账 §1.1.2 及 `.qoder/skills/bambook-ui/SKILL.md` 的新版基线为准。目前明确认可改造完成的是登录界面，它提供视觉方向线索；业务页面仍须按真实任务逐页构图和复评。

**2026-10-12 空间构图纠正：**用户再次明确不认可满铺界面。当前业务候选须按总账 §1.1.2 重新判断阅读重心、主次分区、合理阅读宽度与安静区域；列表、详情、表单分别推导，保留必要字段和操作。`bambook-ui` 入口及 R4/R5 已撤销“高密度”“固定2～3列”“左满铺＋右目录”的默认处方，焦点卡片与可辨认输入表面按任务选择，不将卡片限定为三个历史角色或把全系统强制套为单一线式字段。此次为设计依据修正，未据此销号页面、声明视觉通过或扩展用户已认可范围。

### 路线与首批范围

2026-10-10 标题栏几何统一：共享 `.bds-pagehead` 使用80px固定边框盒（48px控件轨道，上下各16px），全部槽位垂直居中；撤销列表/对象工作区单独减小底边距的例外。49处直接PageHeader调用同步消费；不调整正文PageShell边距。CSS级居中/高度回归与导航、供应商创建回归共14项通过，前端构建通过；尚无本轮实际渲染截图，视觉待验。

1. 共享设计语法：文字角色、空间对齐、内容边界、冷雾材质、动作层级与连续焦点转换。
2. 首批订单链：面料/成衣列表 → 录入 → 详情与编辑，保留业务及已认可滚动手感。
3. 后续按完整链迁移：开发与样品 → 客户与供应商 → 采购/QC/仓储/出运 → 财务/平台 → 客户端。每批检查相邻模块入口，不以替换几个颜色视为完成。
4. 新配方经真实页验证再扩展；最后一个消费者迁走后才删旧资产，不做全仓正则替换。

| 范围 | 当前接入 | 交互/视觉证据 | 用户审美认可 |
| --- | --- | --- | --- |
| 共享搜索/排序/筛选 | `WorkspaceControls`、`CustomSelect appearance="line"`，订单两类列表 | 浅色桌面、1091×818、零结果；搜索清空/排序键盘/筛选收起已走查 | 待评审 |
| 页头极简查询（供应商＋面料／成衣订单） | `HeaderQueryControls`＋`PageHeader.query`；订单主单／条目中槽保留，1050px以下查询优先，按真实可见宽度布局；其余消费者未迁移 | 旧图标文字／浮层候选被否决；新纯图标内联展开，1512深浅色、1366桌面、反向收回／焦点／查询保留／减少动态实测，后续功能修正：拼音／首字母接入服务端分页，内部失焦竞态修复，明确关闭清空查询；最新前端14项／后端36项通过，真实bc与beichen均5家、关闭恢复36家，名单1／35／36家；证据`evidence/header-query-2026-10-10/inline-*.png` | 页头与窄窗口设计于2026-10-10获用户认可 |
| 列表底栏工具／阅读内距 | 订单导出通过ListFooter.countAction降至统计旁；订单及供应商去掉外层20px底距，供应商首末列16px内距 | 1512×982浅／深色实渲；底栏到工作区底部982、48px内部高度；5文件26项通过；证据`evidence/ledger-footer-2026-10-10/`；未实际下载XLSX或全量构建 | 当前修订待用户反馈 |
| 共享字段 | `workspace-controls.css` 的 `.bds-field-surface`；订单录入/详情编辑 | 面料/成衣录入及面料详情编辑实屏；成衣设置两列起点一致 | 待评审 |
| 标题栏主次动作 | `PageHeaderActionGroup` 最多两个圆润动作，第三工具在左侧无容器；订单列表/录入/详情 | Liquid及手绘融合已撤；主按钮使用全局雾蓝白字、内部渐变与泛光，次按钮浅雾面 | 用户已认可主按钮样式并授权全局推广 |
| 全局主动作 | `primary-actions.css`；内部端与客户端共用；原 `bds-btn-primary` 全部消费，人事/平台及独立客户确认、溯源、计价、AI运行、客户对账提交同步接入 | 保留原处理函数/权限/禁用/加载；纯CSS材质响应，轮廓及位置固定，无Y轴位移；用户要求不额外浏览器验证/截图/构建 | 样式方向已认可；本轮实际页面由用户验收 |
| 新版综合场景Showcase（隔离候选） | `dev-ui-preview/showcase.html`；八个连续业务场景；订单列表已复用真实分组行/框架/预警/底栏，其余简化场景及订单详情摘要尚未等价复刻，不作为本体验收依据；候选控件统一由`ShowcasePrimitives.tsx`/`showcase.css`管理 | 已实现本地演示处理；无业务库写入；按用户当前要求未运行构建/测试/浏览器或截图。功能已实现，交互待验，视觉待验 | 待用户整体评审；新次级控件未接入产品 |
| 订单主单／条目详情分层 | 主单行直接打开主单；独立折角展开；条目独立详情；主单概览按真实条目单位汇总，产品章承接完整条目；来源返回复用PageHistory | 构图：沿用左侧连续阶段卡＋右导轨及已认可滚轴；不添加页面工具层；读取完整V2主档，不用列表匹配子集；8文件98项回归通过，主单／条目来源返回及面料／成衣浅深色实测；证据见evidence/order-detail-scope-2026-10-10 | 用户授权本轮调整；实际渲染自检完成，新增视觉待用户反馈 |
| 面料订单目录＋详情 | `components/order/OrderDetailDirectory.tsx`、`OrderManager`与`workspaces.css`；预览入口兼容保留 | 用户确认双栏，正常面料入口已接入；45项定向回归通过；具体排版继续优化，本次视觉由用户复验 |
| 订单内容布局/滚动 | 延用现有阶段卡/导轨和滚动物理；2026-10-10详情动态退出补白移到独立尾部，消除cqh尺寸反馈 | 真实六卡条目原35/234px循环，修复后140帧稳定；正反滚动、三尺寸、深浅主题、返回再进入通过；5文件60项通过；证据evidence/order-detail-stability-2026-10-10 | 既有手感认可仍有效；缺陷修复不等于整条业务链验收 |
| 先锋样完整登记与回看（2026-10-11） | `OrderSampleRegistrationSheet inline` 接订单卡；登记本轮验证、实样描述、差异及已存档附件名称/引用；`OrderSampleEventHistory` 对可写和只读范围复用完整记录 | 前端5文件98项、后端7文件179项定向回归通过；后端类型检查通过。真实组件隔离渲染：1156×1004浅/深色登记、空态、保存回摘要、重开完整记录、申请QC；520×944下443px受控容器单列且无内部溢出，另有历史PP回看实例。证据 `evidence/pioneer-registration-2026-10-11/`；服务为fixture，未写真实库，不代表全应用窄屏验收 | 功能与局部交互已验证；视觉待用户评审，产品完整订单上下文待验 |
| 客户门户登录品牌共享（2026-10-11） | 仅 `customer-portal/src/pages/Login.tsx` 接入公司当前 Icon、字标、`BambookStartup` 和 `AuthBrandStage`；宣传语／说明保留客户端原文；共享逐字文案修正英文单词换行，React 类型统一到门户18版 | 客户门户build通过；1440×960／390×844浅深色欢迎／表单实渲，点击／键盘／焦点／返回不重播／密码显隐／模拟401已验；同配方公司登录隔离实例对照。证据 `evidence/customer-portal-2026-10-11/`；主题fixture认证禁用，未提交真实账号、未验自动主题边界和系统减少动态 | 最新范围及品牌／文案区分由用户明确；当前实渲候选待用户评审；业务页未迁移 |
| 其余模块的完整页面布局与字段 | 仅主动作通过本批共享层同步，页面整体尚未迁移 | 未验 | 未评审 |

本轮先锋样边界：登记内容写入同一`registered`事件、审计及原请求哈希，不冒充QC结论、客户通过或仓库入库；旧v1登记及历史样品允许缺少新增信息，回看明确区分未记录。原请求重试/停止、精确条目/工厂/批次修订保持。服务层内存事务回归覆盖登记→QC→寄送→客户调整反馈→新轮，旧轮事实及附件保留；面料未新增先QC通过才准寄的硬门禁。附件当前仅记录已存档引用，未新增二进制上传/下载或核验引用实体存在与权限。登记与读取协议需前后端一同更新，无数据库字段迁移。全前端`tsc --noEmit`未通过（11项错误在本轮未改动的文件，日志`/tmp/bambook-pioneer-typecheck.log`），不宣称全量构建/全站验收通过。工厂合同、正式排产与QC指派仍未补齐。

本批工作记录：先清除订单384px搜索特例，使用46%/560px共享宽度；工具40px对齐，正文14px/300。搜索与排序开放呈现；筛选显隐连续推移表体，不卸载条件状态；关闭区域inert。订单录入局部细线覆盖收编为共享字段类，详情编辑同用。菜单保持14px/40px、门户定位及键盘语义。页面级动作不附加箭头/下划线。空态和底栏依旧计数真实业务对象，未发起创建、审批或修改订单数据。

### 首批证据与边界

- 最新主动作推广：全局共享 `primary-actions.css`，默认48px／14px／300，紧凑行40px，背景与白字直接读侧栏同源token；内部泛光与渐变响应聚焦/按下，轮廓与坐标不动。Liquid依赖和适配已删除。用户认可现样式、明确要求自行验证，本批未额外运行浏览器、截图、build或自动测试；未提交业务数据。
- 已撤销方案仅保留追溯：方角、实时牵引、固定中心融合、手绘连续弧面和官方Liquid Gooey均被否决。`/tmp/bambook-membrane-list-48.png`、`/tmp/bambook-membrane-detail-48.png`、`/tmp/bambook-liquid-stable-detail.png`、`/tmp/bambook-liquid-actions-final.png`、`/tmp/bambook-liquid-actions-edit.png`均不是当前样式验收证据。
- 走查顺带发现既有溯源接口返回Prisma字段错误：`CustomsDeclaration`查询选择不存在的`customsType`，面板可打开但数据读取失败。该后端问题不在本次按钮改造中修改，不宣称溯源业务通过。
- 浅色1511×1012：`/tmp/bambook-bds-list-after.png`（面料列表）、`/tmp/bambook-bds-order-empty.png`（搜索零结果）、`/tmp/bambook-bds-order-edit.png`（面料详情编辑）、`/tmp/bambook-bds-garment-entry.png`（成衣录入）。窄桌面1091×818：`/tmp/bambook-bds-garment-desktop-small.png`。
- 实际读数：搜索/排序/筛选同为40px高，排序160px；菜单14px/40px、键盘活动项7% accent。成衣订单用途/履约模式触发器在同一y坐标；40px布局高度随既有3D整体变换产生约40.8px屏幕投影，未改滚动或缩放算法。
- 搜索零结果保留0张主单/0条匹配产品与1/1页禁用分页；清空恢复记录；排序ArrowDown/Enter与Escape关闭保留；编辑未改值返回，不触发写入。
- 应用外壳既有1080px最小宽度在更窄窗口会横向裁切，本批仅确认最小桌面范围，不宣称手机响应式已完成。深色、真实创建/保存/审批、服务器失败及全部权限组合未验；未运行build或自动测试。
- 本批已接入可评审实例，不代表订单全业务UI或全站完成。后续先处理订单剩余任务内控件与弹层，再迁移下一条业务链；旧资产保留到最后一个消费者迁离。

> **2026-10-07 职责纠偏：** 本文件的旧走查、旧权限和历史案例保留为当时证据；其中采购/仓储专岗、后勤独占库存或采购写权限的称呼已被最新分工取代，不用于后续设计与权限判定。 当前规则见[角色与实际分工](../design/global/2026-10-06/05-roles-and-responsibilities.md)及[对话决策总账](../design/global/2026-10-06/08-2026-10-06-对话设计决策总账.md)。


> **依据**：`page-skeleton-spec.md`（总控审定）六区强制规格 + 纪律文档 §10.2 表头格式。
> **效力**：30 页逐页销号（CD-007/CD-008/CD-009）的全量驱动台账；「验收状态」列由总控签字置 ✅。
> **建立**：2026-08-17 S-FE · 待总控审定。

---

## §0 口径说明（审定重点）

1. **30 行组成（待总控校准确认）**：32 注册模块 − **发票管理**（别名入口，与财务管理同渲染文件 `FinanceManager.tsx` 三 tab 条件渲染，指标并入财务管理行）− **AI 助手**（对话式界面，六区规格不适用）。**设置**（nav.primary=false，经账号菜单进入）、**生产执行 MES**（可选模块，评审报告 30 页口径明示含 MesManager）、**管理后台**（adminOnly）均保留在台账。
2. **指标口径**：与 `check:tokens` M1-M5 完全同源——作用域 `components/` + `src/`，豁免集同脚本（test/mascot/Globe/邮件模板/发票模板除外）。**逐行列值为页面入口文件实测**；页面子树（如 `finance/`、`email/`、`tools/` 子组件与共享组件）存量随逐页主刀以页面为单位清零，不单列行。
3. **筛选区列**：「组合 bar」= 入口文件实测 `bds-filterbar`；「⚠️ 待走查」= 无 `bds-filterbar` 但有表单控件存量（疑自造筛选 UI，主刀时按 spec §2.1 决策树复核选型）；「—」= 无筛选控件。
4. **操作区列**：✅ = 机械断言无违例（无 bds-btn-sm / bds-btn-dark / 批E 手写主按钮余量命中）；❌ = 已登记违例。
5. **弹窗列**：`alert×N` = 原生 `alert()/confirm()` 计数（W4 BdsDialog/bdsToast 收敛对象，随逐页主刀迁移）；`bds-modal` 使用情况主刀时人工复核。
6. **dark: 残留**：30 入口文件实测均为 0（批 G 已收口；全局基线 7 = App.tsx 5 + NotificationCenter 误匹配 2）。
7. **raw 色残留**：入口文件实测均为 0（EmailManager 2 处属邮件模板豁免域）；全局基线 19 = 发票模板 8（豁免）+ App.tsx 5（W5）+ pwa 3（冻结）+ GarmentOrders 3（W5）。
8. **冻结/豁免不入台账**：App.tsx、GarmentOrders（W5 S-ARCH）、移动端冻结区、3D 地球 WebGL、macOS 三色灯、品牌 SVG、邮件/发票模板、PandaLab/DesignTuner 开发工具。

---

## §1 台账正文（30 行，按导航分组排序；★ = P2 首批四页）

> **2026-08-19 批次 3 校准**：①渲染文件列——4 页 compiled 双路径已收敛删除，全部指向 moduleRegistry entry 实际渲染源；②表单控件列——批次 3a 后 M4 守卫全局 date=0、select 真实非合规=0（bds-select/CapsuleDateInput 全合规），历史 select×N/date×N 计数全部转 ✅；③弹窗列——批次 3b 全站 ~211 处 alert/confirm 迁移 bdsToast/bdsConfirm（M6 守卫锁定=0），历史 alert×N 全部转 ✅；④M1（EmailManager PageHeader）/M3（FinanceManager filterbar 撑高）均已修复。验收状态列仍全 ⬜，待 3d 逐页深浅双主题截图走查 + 产品负责人签字。
> **2026-08-31 W4 补注**：本表「下拉」列为 2026-08-18 批次快照（select.bds-select 口径），2026-08-31 W4 后以 CustomSelect 收编为准——原生 select 已全站退役（M4 守卫零容忍）。
| 页面 | 渲染文件 | 标题区 | 筛选区 | 操作区 | 表单控件 | 内容区 | dark:残留 | raw色残留 | 弹窗 | 问题记录 | 验收状态 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 全景看板 | components/Dashboard.tsx | ⚠️ 无 PageHeader（定制全景头部，豁免与否待总控校准） | — | ✅ | ✅ | ⚠️ 待走查 | 0 | 0 | 0 | 2026-08-19 校准：compiledDashboardTemplates 双路径已删除，渲染源=Dashboard.tsx；装饰性 accent 填充已收编（W4 · d808a3b，手写主按钮基线 22→17）；Dashboard.tsx 本体 5 处手写主按钮余量现为**真实渲染路径**（原"非渲染路径遗留"口径作废），待 3d 走查判定 | ⬜ |
| 经营驾驶舱 | components/CockpitManager.tsx | ✅ | 组合 bar×1 | ✅ | ✅（date×2→CapsuleDateInput，2026-08-18 P2-W4） | ⚠️ 待走查 | 0 | 0 | 0 | — | ⬜ |
| 报表中心 | components/ReportCenter.tsx | ✅ | ⚠️ 待走查 | ⚠️ 手写主按钮×4（批E 余量） | ✅（select×8 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（alert×1→bdsConfirm，批次 3b） | — | ⬜ |
| 关系智库 ★ | components/RelationsManager.tsx | ✅ | ✅ 已主刀（P2 · e5c77a5） | ✅ | ✅ | ⚠️ 待走查 | 0 | 0 | 0 | 2026-08-19 校准：compiledRelationsTemplates 双路径已删除，渲染源=RelationsManager.tsx。**点名④ 已修复**：搜索 icon 内置 leading icon（spec §2.3）；toolbar h-10 刻度对齐；font-light。排序 compact 触发器 34px 刻度专项已销（240ea81） | ⬜ |
| 客户关系管理 | components/CrmManager.tsx | ✅ | 组合 bar×1 | ✅ | ✅（select×10 已 bds-select + date 已 CapsuleDateInput） | ⚠️ 待走查 | 0 | 0 | ✅（alert×15→bdsToast/bdsConfirm，批次 3b） | — | ⬜ |
| 供应商管理 | components/SuppliersManager.tsx | ✅ | ⚠️ 待走查 | ✅ | ✅（select×7 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（alert×19→bdsToast/bdsConfirm，批次 3b） | — | ⬜ |
| 智能邮箱 | components/EmailManager.tsx | ✅（PageHeader 已补，M1 清零） | ⚠️ 待走查 | ✅ | ✅ | ⚠️ 待走查 | 0 | 2（豁免域） | ✅（confirm×2→bdsConfirm，批次 3b） | 颜色 token 属邮件模板豁免域，骨架不豁免；子组件 email/SignatureManager.tsx PageHeader 已补（M1 基线 3→0） | ⬜ |
| 季节性与趋势 | components/SeasonsManager.tsx | ✅ | 组合 bar×1 | ✅ | ✅（select×12 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（alert×23→bdsToast/bdsConfirm，批次 3b） | — | ⬜ |
| 营销推广 | components/MarketingManager.tsx | ✅ | ⚠️ 待走查 | ✅ | ✅（select×3 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（alert×9→bdsToast/bdsConfirm，批次 3b） | — | ⬜ |
| 数字档案 | components/ProductsManager.tsx | ✅ | — | ⚠️ 手写主按钮×2（批E 余量） | ✅ | ⚠️ 待走查 | 0 | 0 | ✅（alert×2→bdsToast.warning，批次 3b） | 2026-08-19 校准：compiledProductsTemplates 双路径已删除，渲染源=ProductsManager.tsx | ⬜ |
| 开发管理 | components/DevelopmentManager.tsx | ✅ | 组合 bar×1（基准范式页） | ✅ | ✅（select×6 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（alert×7→bdsToast/bdsConfirm，批次 3b） | **filterbar 选型基准实现之一**（spec 附录 A） | ⬜ |
| 报价管理 ★ | components/QuotationManager.tsx | ✅ | ✅ 已主刀（P2 · 088cd10） | ✅ | ✅（select×3 + date×2 已 BDS 化） | ⚠️ 待走查 | 0 | 0 | 0 | **点名③ 已修复**：状态 segment 并入搜索行单条 filterbar（spec §2.1 决策树第二支）；报价日期/有效期至迁 CapsuleDateInput | ⬜ |
| 订单管理 ★ | components/OrderManager.tsx | ✅ | ✅ 已主刀（P2 · cd54d96） | ✅（M5 清零 4→0） | ✅（select 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（alert×10→bdsToast/bdsConfirm，批次 3b） | **点名②⑤ 已修复**：类型 tab 并入 filterbar 单行；视图 toggle 冷墨洗。bar 三区同槽已修（ac39d30）。alert×10 已随批次 3b 收敛 | ⬜ |
| 生产跟单 | components/ProductionBoard.tsx | ✅ | — | ✅ | ✅ | ⚠️ 待走查 | 0 | 0 | 0 | — | ⬜ |
| 采购管理 | components/ProcurementManager.tsx | ✅ | 组合 bar×1 | ✅ | ✅（select×4 已 bds-select） | ⚠️ 待走查 | 0 | 0 | 0 | — | ⬜ |
| 库存管理 | components/InventoryManager.tsx | ✅ | 组合 bar×1 | ✅ | ✅（select×8 已 bds-select） | ⚠️ 待走查 | 0 | 0 | 0 | — | ⬜ |
| BOM 成本核算 | components/BomManager.tsx | ✅ | 组合 bar×1 | ✅ | ✅（select×4 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（confirm×1→bdsConfirm，批次 3b） | — | ⬜ |
| QC 工作台 | components/QcWorkbenchManager.tsx | ✅ | 组合 bar×1 | ✅ | ✅（select×11 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（alert×31→bdsToast/bdsConfirm，批次 3b） | 原生 alert 存量全站最高页，批次 3b 已清零 | ⬜ |
| 货运管理 | components/ShipmentManager.tsx | ✅ | 组合 bar×1（基准范式页） | ✅ | ✅（select×2 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（confirm×1→bdsConfirm，批次 3b） | **filterbar 选型基准实现之一**（spec 附录 A） | ⬜ |
| 外贸与报关 | components/CustomsManager.tsx | ✅ | 组合 bar×1 | ✅ | ✅（select×6 已 bds-select） | ⚠️ 待走查 | 0 | 0 | 0 | — | ⬜ |
| 单据中心 ★ | components/DocumentCenter.tsx | ✅ | ✅ 已主刀（P2 · 19ed21a） | ✅ | ✅（select×4 + date×2 全 BDS 化） | ⚠️ 待走查 | 0 | 0 | ✅（alert×3→BdsDialog，P2 主刀） | **点名① 已修复**：操作区按钮统一 bds-btn 40px；filterbar 基准范式；子组件 tools/DocumentTemplateManager.tsx 已补 PageHeader + 类型筛选 bds-toggle | ⬜ |
| 财务管理（含发票管理 tab） | components/FinanceManager.tsx | ✅ | ✅（M3 filterbar 撑高已修，2026-08-18 W1 组2） | ✅ | ✅（select×11 已 bds-select + date×8 已 CapsuleDateInput） | ⚠️ 待走查 | 0 | 0 | ✅（alert×17→bdsToast/bdsConfirm，批次 3b） | M3 三处违例（主文件:1935 + FinanceCreditPanel:367 + FinancePaymentRequestsPanel:422）已清零；「已落库但刷新失败」warning 口径见批次 3b commit | ⬜ |
| 定价与利润 | components/PricingManager.tsx | ✅ | ⚠️ 待走查 | ✅ | ✅（select×5 已 bds-select，变量类名已内联字面量，批次 3a） | ⚠️ 待走查 | 0 | 0 | ✅（alert×27→bdsToast/bdsConfirm，批次 3b） | — | ⬜ |
| 风险管理与合规 | components/RisksManager.tsx | ✅ | ⚠️ 待走查 | ✅ | ✅（select×7 已 bds-select） | ⚠️ 待走查 | 0 | 0 | ✅（alert×20→bdsToast/bdsConfirm，批次 3b） | — | ⬜ |
| 数据中心 | components/DataCenter.tsx | ✅ | ⚠️ 待走查 | ✅ | ✅（select×1 已 bds-select） | ⚠️ 待走查 | 0 | 0 | 0 | — | ⬜ |
| 人事管理 | components/HRManager.tsx | ✅ | ⚠️ 待走查 | ✅ | ✅（select×7 已 bds-select + date×3→CapsuleDateInput，批次 3a） | ⚠️ 待走查 | 0 | 0 | ✅（confirm×3→bdsConfirm danger，批次 3b） | — | ⬜ |
| 业务工具 | components/BusinessTools.tsx | ✅ | — | ✅ | ✅ | ⚠️ 待走查 | 0 | 0 | 0 | MES 入口页（工具集形态） | ⬜ |
| 生产执行 MES | components/MesManager.tsx | ✅ | ⚠️ 待走查 | ✅ | ✅（select×12 已 bds-select + date×5→CapsuleDateInput，批次 3a） | ⚠️ 待走查 | 0 | 0 | 0 | 可选模块（nav.primary=false，经业务工具页进入）；评审报告 30 页口径明示含 MesManager 六 tab | ⬜ |
| 管理后台 | components/AdminPanel.tsx | ✅ | ⚠️ 待走查 | ✅ | ✅（select×19 全 bds-select，批次 3a 收敛 13 处存量） | ⚠️ 待走查 | 0 | 0 | ✅（alert/confirm×7→bdsToast/bdsConfirm，批次 3b；密码重置改驻留弹窗保全临时密码复制） | adminOnly；原生 select 存量全站最高页，批次 3a 已清零 | ⬜ |
| 设置 | components/Settings.tsx | ✅ | — | ✅ | ✅ | ⚠️ 待走查 | 0 | 0 | ✅（alert×1→bdsToast.danger，批次 3b） | 2026-08-19 校准：compiledSettingsTemplates 双路径已删除，渲染源=Settings.tsx；nav.primary=false（经账号菜单进入）；含账号设置/系统设置子视图 | ⬜ |

---

## §2 首批点名问题详录（6 条，含文件行号证据与修复方向）

| # | 页面 | 问题 | 文件证据 | 修复方向 |
|---|---|---|---|---|
| ① | 单据中心 | 操作区 small buttons 尺寸不统一 | `DocumentCenter.tsx`：`:306` `h-7 px-3 rounded-control text-[11px]`（actionBtnCls 模板）、`:319`/`:325` `h-8 px-3.5 rounded-full`、`:365` `h-9 px-3 rounded-control`、`:684`/`:803` `h-8 px-4 rounded-full`（弹窗按钮）、`:905` `h-7 px-3 rounded-control` —— h-7/h-8/h-9 三档高度 + rounded-full/rounded-control 两种圆角混用 | 全部改为 `bds-btn` 默认 40px（表内行操作白名单除外，spec §3.1） |
| ② | 订单管理 | filterbar 双行撑高页面上边距 | `OrderManager.tsx:941-986`：PageHeader center 槽塞入 filterbar + 视图 toggle，下方再叠独立类型 tab 胶囊行（全部/面料/成衣/其他/Capsule），双行结构抬高整个标题区 | 重构为单行结构：类型 tab 上移并入 filterbar（或移除独立行），消除双行（spec §1 center 槽禁令 + §2.2 单行/禁撑高） |
| ③ | 报价管理 | 纯单搜索误用组合嵌套 bar | `QuotationManager.tsx:809-817`：filterbar 内仅一个搜索输入 + 一个刷新按钮，无任何筛选下拉共行；状态过滤为下方独立 `bds-segment` 行（`:820-826`） | 拆为简单搜索框 `.bds-search + .bds-input`（spec §2.1 决策树：单输入无筛选时禁套组合 bar） |
| ④ | 关系智库 | 功能 bar 整体设计不合格 | `compiledRelationsTemplates.tsx:767-781`：搜索 icon 置于绝对定位独立 `span`（`left-0 top-0 h-9 w-9`）外挂输入框左缘，非 leading-icon 内置；input 手写 `h-9 w-full rounded-control border pl-10 ... font-normal`——h-9 非 34/40 刻度、`font-normal` 违字重 ≤300 纪律、未走 bds-search/bds-input 范式 | 搜索 icon 内置输入框（leading icon）；整体对齐开发管理/货运管理/财务管理 filterbar 基准范式（spec §2.3 + 附录 A） |
| ⑤ | 订单管理 | toggle active 态实心黑圆按钮 | `OrderManager.tsx:972`/`:981`/`:996`/`:1005`：视图切换 toggle active 态用 `bds-btn-dark`（`--invert-bg` 实心黑填充），浅色雾面环境中突兀（M5 基线 4 全部在此） | 替换为冷墨洗 tint/inset 态（spec §3.2：图标型 → `.bds-toggle` active = `--accent-tint` + `--accent-text`；分段胶囊 → `.bds-segment .seg` active = `--bg-raised` 浮面） |
| ⑥ | 全局 | `<select>` / `type="date"` 原生渲染未 BDS 化 | 粗口径 321（全仓 `<select` 213 + `type="date"` 108）；**入库精确口径 281**（components/src 作用域 · 豁免集生效 · 剔除已 bds-select 化 33 处；粗口径把 BDS 化组件计入总数、收敛后总数不变，无法感知进展，故不采用）。入口文件分布 TOP5：AdminPanel 13 / SeasonsManager 12 / FinanceManager 11+8 / CrmManager 10+7 / InventoryManager 8+1 | 逐页接入 `bds-select` / `CapsuleDateInput`（spec §4）；每页主刀时该页子树存量清零，M4 基线只减不增 |

---

## §3 机器断言基线快照（2026-08-17 建立，check:tokens §13）

| 断言 | 基线 | 现存违例分布 | 清零路径 |
|---|---|---|---|
| M1 PageHeader 缺失 | 3 | EmailManager（台账页）/ email/SignatureManager（智能邮箱子组件）/ tools/DocumentTemplateManager（单据中心子组件） | 随对应页主刀清零 |
| M2 bds-btn-sm | 0 | — | 维持（白名单注释豁免） |
| M3 filterbar 高度违例 | 3 | 财务管理页子树（FinanceManager:1935 / FinanceCreditPanel:367 / FinancePaymentRequestsPanel:422） | 财务管理页主刀清零 |
| M4 原生控件 | 281 | 30 页入口文件 + 页面子树 + 共享组件 | 逐页清零，只减不增 |
| M5 bds-btn-dark | 4 | OrderManager:972/981/996/1005 | P2 OrderManager 主刀清零 |
| 既有 dark: 基线 | 7 | App.tsx 5（W5）/ NotificationCenter 2（误匹配） | W5 收口 |
| 既有 raw 语义色基线 | 19 | 发票模板 8（豁免）/ App.tsx 5（W5）/ pwa 3（冻结）/ GarmentOrders 3（W5） | W5 收口 |

---

## §4 P2 推进规程（CD-009 校准点）

1. **顺序**：DocumentCenter → OrderManager → QuotationManager → Relations。
2. **每页一次全维主刀**：骨架对齐 + dark: 清零 + raw 色清零 + 按钮尺寸统一 + filterbar 选型 + 原生控件替换 + 弹窗检查（页面子树整体，含子组件）。
3. **每页一个 commit**，前缀 `wave(fe): W-PG-P2-页面名`；改前/改后深浅双主题截图；三绿（tsc + check:tokens + npm test）。
4. **四页销号后暂停**：截图汇总报总控 → 产品负责人校准 → 校准通过后放量其余 26 页（按本台账逐行推进）。

---

## §5 P2 四页主刀收口记录（2026-08-17 · 待总控签字 / 产品负责人校准）

| 页 | commit | 点名修复 | 通用项结果 | 三绿 |
|---|---|---|---|---|
| 单据中心 | `19ed21a` | ① 按钮三档混用 → bds-btn 40px 统一 | bds-filterbar 落地；select×4+date×2 清零；alert×3+删除确认 → BdsDialog；tools/DocumentTemplateManager 补 PageHeader（M1 3→2）+ 类型筛选 bds-toggle | tsc ✓ / tokens ✓ / test ✓ |
| 订单管理 | `cd54d96` | ② 双行 → 单行（类型 tab 并入 filterbar）；⑤ bds-btn-dark×4 → bds-toggle 冷墨洗（M5 4→0） | 状态 select 前置修正（M4 273→272）；alert×10 遗留 W4 | tsc ✓ / tokens ✓ / test ✓ |
| 报价管理 | `088cd10` | ③ 评估后 segment 并入搜索行（搜索+segment 共行 = 组合 bar 合法形态，spec §2.1 第二支） | date×2→CapsuleDateInput；select×3 前置修正（M4 272→267） | tsc ✓ / tokens ✓ / test ✓ |
| 关系智库 | `e5c77a5` | ④ icon 内置 leading icon + toolbar h-9→h-10 刻度 + font-normal→font-light | date×1→CapsuleDateInput（M4 267→266）；accent 按钮 text-white→--on-accent（实测校准 33→28）；CustomSelect compact 触发器 h-9 遗留 W4 共享组件专项 | tsc ✓ / tokens ✓ / test ✓ |

**改前/改后证据**：改前状态以 §2 详录文件行号 + 各页父 commit（`git show <commit>^`）为准；改后深浅双主题截图按 spec §9.2 由产品负责人验收 pass 亲截（关键 4 页口径）。
**验收状态**：四行验收列留空（⬜），待总控逐页签字销号；签字通过前暂停放量其余 26 页。

---

## §6 W4 组件级专项收口记录（2026-08-17 · P2 校准等待期执行）

> 范围纪律：仅组件层 + compiledDashboardTemplates，未触碰四页主刀文件以外的页面文件；alert→BdsDialog 页面迁移不做（并入后续逐页主刀）。

| 专项 | commit | 内容 | 基线变化 | 三绿 |
|---|---|---|---|---|
| 订单管理 bar 三区同槽（P2 追加） | `ac39d30` | bar 包裹层 px-4 pt-2 → px-7 pt-2 pb-4（与 PageHeader/表格共享 28px 内容栅格 + 16px 呼吸间距）；ProductionAlerts 预警横幅全宽出血同族修复（包 shrink-0 px-7） | 不变 | tsc ✓ / tokens ✓ / test ✓ |
| 共享 CustomSelect 刻度 | `240ea81` | compact 触发器 h-9(36px 旧刻度) → h-[var(--h-input-sm)]=34px（BDS 规格刻度）；34px = 双消费上下文安全交集（Relations 40px 工具条内符合 filterbar 官方范式；Products 36px 共享 recipe 工具条内 2px 差、inline 透明视觉连续）；RelationsManager.test 断言同步 | 不变 | tsc ✓ / tokens ✓ / test ✓ |
| Dashboard 手写主按钮余量 | `d808a3b` | compiledDashboardTemplates 5 处装饰性 accent 填充（下划杠×2/进度条 fill×2/指示圆点×1）bg-[var(--os-vnext-brand-blue)] → bg-[var(--accent)] 主题自适应 | 手写主按钮 22→17 | tsc ✓ / tokens ✓ / test ✓ |

**双主题截图验证**：OrderManager bar 与表格左右边界对齐 + 间距清晰（浅/深）；关系智库 + 数字档案工具条 inline 触发器垂直对齐自然（浅/深）；全景看板 accent 元素双主题协调可见。
**遗留登记**：CustomSelect default size（form 场景 h-9）随逐页主刀表单区处理；Dashboard.tsx 非渲染路径 5 处装饰填充（W5/逐页主刀）；四页 alert 迁移并入逐页主刀流程。

---

## §7 W-C 权限销号（2026-08-27 · 批三-D）

**2026-08-27 复核轮：族 A/B/C 修复后复核（commit `81110f3`/`915e2ba`）**

> **依据真源**：视图门 `lib/modulePermissions.ts`——`81110f3` 起 permission 视图 required 一律派生自 `VIEW_TO_MAIN_SCOPES[view].read`（lib/rolePermissionMatrix.ts:250-290；派生逻辑 modulePermissions.ts:27-42，仅 Dashboard/Settings/AccountSettings public-authenticated :20-22 与 UiLab dev-only :24 四个 policy 覆盖，手写族 scope 机制性废除）；消费点 `services/authService.ts:346` canAccessView，Sidebar 导航过滤同链。服务端门 `server/src/<域>/` route 文件；角色授权 `lib/rolePermissionMatrix.ts` 七角色默认矩阵（:728-736；服务端镜像 `server/src/_shared/rolePermissionMatrix.ts:256` VIEW_TO_MAIN_SCOPES 同步）。
> **判定口径**：✅ 销号 = 视图门存在 + 服务端读面至少认证门 + 写面有角色/scope 级授权门（requireRole / requirePermission），且无视图门⊋服务端门的确定性死胡同；页内权限逻辑「无」不阻塞销号，但须注明「服务端 403 兜底，v1.0 接受」。⬜ 未销号 = 写面仅 JWT/认证强度门（矩阵 write scope 已定义未接线），或存在确定性角色死胡同（过视图门的角色在页面核心读/写面必 403）。定价与利润页对 QC/LOGISTICS 锁出（矩阵未授 pricing:read，视图层拦截）属文档预期收紧，不构成死胡同，不影响销号。
> **环境前提**：生产鉴权开关 `BAMBOOK_REQUIRE_AUTH=true` 或 `NODE_ENV=production`（server/src/index.ts:172），Mac Mini 生产态门禁生效。
> **核实方式**：30 页逐页读 modulePermissions + VIEW_TO_MAIN_SCOPES + 矩阵默认授权 + 对应域 route 文件，行号即证据（复核轮全部重核，不沿用批三-D 旧行号）。
> **走查证据**：`components/permissionViewMatrix.test.ts`（242 例）/ `server/src/__tests__/permissionDenyPath.test.ts`（23 例）/ `server/src/__tests__/permissionAgentToolMatrix.test.ts`（21 例）全绿。
> **行号简写**：rPM = `lib/rolePermissionMatrix.ts`；route 路径均省略 `server/src/` 前缀。

### §7.1 30 行权限台账（按 §1 同序）

| 页面 | 渲染文件 | 视图门禁（改后现状） | 页内权限逻辑 | 服务端门禁（域+机制+行号） | 销号判定 |
|---|---|---|---|---|---|
| 全景看板 | components/Dashboard.tsx | public-authenticated（modulePermissions.ts:20） | 无（服务端 403 兜底，v1.0 接受） | 聚合页无专属写面；行情代理 /api/market/cotton·wool 公开只读转发（index.ts:1205/:1239，无业务数据）；业务数据经各域只读 API 随各域门 | ✅ |
| 经营驾驶舱 | components/CockpitManager.tsx | permission cockpit:read（rPM:252 派生；批三-D 为 finance:read 族 scope） | 无（服务端 403 兜底，v1.0 接受） | dashboard 域：moduleAuthGuard（dashboard/route.ts:26）+ requirePermission('cockpit:read')（:29）；QC/LOGISTICS 已补授 cockpit:read（rPM:641/:678，`81110f3`；敏感成本/利润无 sensitive scope 仍遮罩） | ✅ 族A 闭环 |
| 报表中心 | components/ReportCenter.tsx | permission reports:read（rPM:254 派生；批三-D 为 finance:read） | 无（服务端 403 兜底，v1.0 接受） | reporting 域：moduleAuthGuard（reporting/route.ts:87）+ 读面 requirePermission('reports:read')（:91 定义，:100/:105/:118/:239/:262/:276）+ 写面 requireJwtForWrite＋requirePermission('reports:write')（:89/:92 定义，:132/:147/:163/:178/:188/:198/:214/:227，`915e2ba`，legacy requireRole HIGH_RISK 退役）；reports:write 持 SALES/SM/FINANCE/ADMIN（rPM:374/:470/:550），QC/LOGISTICS 写 403 属授权收窄 | ✅ 族B 闭环 |
| 关系智库 ★ | components/RelationsManager.tsx | permission relations:read（rPM:255 派生） | 无（服务端 403 兜底，v1.0 接受） | relations V2 scope 全（relations/routeV2.ts:45 守卫，:58 read/:111 write/:279 delete；前端 apiService.ts:2089 起走 /v2/relations）；V1 写面 legacy requireRole（relations/route.ts:27 守卫/:91） | ✅ |
| 客户关系管理 | components/CrmManager.tsx | permission crm:read（rPM:256 派生；批三-D 为 relations:read；QC 未持 crm:read 视图层锁出） | 无（服务端 403 兜底，v1.0 接受） | crm V2 scope 全（crm/crmRouteV2.ts:41 守卫，:97 read/:106 write；前端 apiService.ts:2029 起走 /v2/crm） | ✅ |
| 供应商管理 | components/SuppliersManager.tsx | permission suppliers:read（rPM:257 派生；批三-D 为 relations:read） | 无（服务端 403 兜底，v1.0 接受） | suppliers V2 scope 全（suppliers/factoryRouteV2.ts:22 守卫，:38 read/:58 write）；V1 认证门+黑名单 requireRole（suppliers/factoryRoute.ts:66/:279） | ✅ |
| 智能邮箱 | components/EmailManager.tsx | permission emails:read（rPM:260 派生；QC 未持锁出） | 无（服务端 403 兜底，v1.0 接受） | email 域：moduleAuthGuard（email/route.ts:122）+ 日常写面 requirePermission('emails:write')（:232 同步/:401 outbox 发送，`915e2ba` 族C 收编，legacy requireRole 写组退役；前端 emailOutboxService.ts:3 即调 :401）；backfill-links/classify-backfill 保留 legacy HIGH_RISK（:252/:314）；emails:write 持 SALES/SM（rPM:388） | ✅ 族C 闭环 |
| 季节性与趋势 | components/SeasonsManager.tsx | permission seasons:read（rPM:258 派生；批三-D 为 relations:read） | 无（服务端 403 兜底，v1.0 接受） | seasons V2 scope 全（seasons/seasonRouteV2.ts:22 守卫，:38 read/:50 write） | ✅ |
| 营销推广 | components/MarketingManager.tsx | permission marketing:read（rPM:259 派生；批三-D 为 products:read；LOGISTICS 已补 marketing:read rPM:687 `81110f3`，QC 未持锁出） | 无（服务端 403 兜底，v1.0 接受） | marketing 域 scope 全（marketing/marketingRouteV2.ts:33 守卫，:49 read/:62 write） | ✅ 族A 闭环 |
| 数字档案 | components/ProductsManager.tsx | permission products:read（rPM:261 派生） | 无（服务端 403 兜底，v1.0 接受） | products 域 scope 全（products/route.ts:215 守卫，:222 read/:400 write） | ✅ |
| 开发管理 | components/DevelopmentManager.tsx | permission products:read（rPM:279 派生，VIEW_TO_MAIN_SCOPES[Development]；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | development 域：moduleAuthGuard（development/route.ts:88）+ 读面 requirePermission('products:read')（:96 定义，:100/:154/:370）+ 写面 requireJwtForWrite＋requirePermission('products:write')（:94-95 定义，:179/:208/:238/:270/:386/:396；convert/delete 同挂 :323/:421 随族C 并修，`915e2ba`）；products:write 持 SALES/SM（rPM:396） | ✅ 族B 闭环 |
| 报价管理 ★ | components/QuotationManager.tsx | permission quotations:read（rPM:264 派生；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | quotations 域：moduleAuthGuard（quotations/quotationRoute.ts:58）+ 读面保留 API-Key 兼容认证门（:92/:136/:151/:166/:392）+ 写面 requireJwtForWrite＋requirePermission('quotations:write')（:59-60 定义，:83/:182/:209/:249/:271/:289/:305/:327/:344/:361/:377/:403，`915e2ba`）；quotations:write 持 SALES/SM（rPM:393） | ✅ 族B 闭环 |
| 订单管理 ★ | components/OrderManager.tsx | permission orders:read（rPM:263 派生） | 无（服务端 403 兜底，v1.0 接受） | orders V2 scope 全（orders/routeV2.ts:52 守卫，:62 read/:174 write/:206 状态/:230 delete；前端 apiService.ts:759 起走 /v2/orders）；V1 写面 legacy requireRole（orders/route.ts:48 守卫/:188/:402，apiService.ts:769 仍引用 V1 status-transition，列入工件一 deny-path 走查） | ✅ |
| 生产跟单 | components/ProductionBoard.tsx | permission production:read（rPM:266 派生；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | production V2 scope 全（production/routeV2.ts:25 守卫，:40 read/:57 write）+ V1 批次链同挂 scope（production/route.ts:36 守卫，:38 read/:39 write 定义，`915e2ba`）；production:read 六角色全持（rPM:399/:492/:601/:653/:693）无死胡同 | ✅ |
| 采购管理 | components/ProcurementManager.tsx | permission procurement:read（rPM:265 派生；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | procurement 域：inline authenticate 闭包退役，统一 createModuleAuthGuard（procurement/procurementRoute.ts:55）+ 读面认证门（:60/:120/:169/:307/:362/:377）+ 写面 requireJwtForWrite＋requirePermission('procurement:write')（:56-57 定义，:139/:181/:196/:210/:228/:243/:257/:275/:319/:327/:335/:346/:354/:393，`915e2ba`）；【历史走查结论，已被2026-10-07职责纠偏取代】当时记为 procurement:write 仅 LOGISTICS 持；不得用于当前授权判断，业务员/业务主管具采购与库存默认操作能力 | ✅ 族B 闭环 |
| 库存管理 | components/InventoryManager.tsx | permission orders:read（rPM:280 派生，VIEW_TO_MAIN_SCOPES[Inventory]=orders:read 与批三-D 一致） | 无（服务端 403 兜底，v1.0 接受） | inventory 域：inline authenticate 闭包退役，统一 createModuleAuthGuard（inventory/inventoryRoute.ts:62）+ 读面认证门（:70/:129/:179/:239/:294）+ 写面 requireJwtForWrite＋requirePermission('inventory:write')（:63-64 定义，:81/:98/:112/:190/:208/:222/:258，`915e2ba`）；inventory:write 仅 LOGISTICS 持（rPM:707，GAP-R5） | ✅ 族B 闭环 |
| BOM 成本核算 | components/BomManager.tsx | permission bom:read（rPM:262 派生；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | bom 域：inline authenticate 闭包退役，统一 createModuleAuthGuard（bom/bomRoute.ts:54）+ 写面 requireJwtForWrite＋requirePermission('bom:write')（:55-56 定义，`915e2ba`）；bom:write 持 SALES/SM/QC（rPM:398/:665） | ✅ 族B 闭环 |
| QC 工作台 | components/QcWorkbenchManager.tsx | permission qc:read（rPM:269 派生；批三-D 为 orders:read；LOGISTICS 已补 qc:read rPM:695 `81110f3`） | 无（服务端 403 兜底，v1.0 接受） | qc 域 scope 全（qc/qcRoute.ts:89 守卫，:347 read/:422 write） | ✅ 族A 闭环 |
| 货运管理 | components/ShipmentManager.tsx | permission shipments:read（rPM:267 派生；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | shipping 域：moduleAuthGuard（shipping/route.ts:156）+ 日常写面十一端点 requirePermission('shipments:write')（:212/:235/:251/:267/:419/:433/:457/:487/:528/:594/:620，`915e2ba` 族C 收编；前端 shipmentService.ts:3 即走 /api/v1/shipping）；DELETE 运单/分配保留 legacy HIGH_RISK（:558/:639）；shipments:write 持 SALES/SM/LOGISTICS（rPM:402/:698） | ✅ 族C 闭环 |
| 外贸与报关 | components/CustomsManager.tsx | permission customs:read（rPM:268 派生；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | customs V2 scope 全（customs/customsRouteV2.ts:22 守卫，:39 read/:59 write）；V1 认证门（customs/customsRoute.ts:127）；customs:write 仅 LOGISTICS 持（rPM:700）属授权收窄 | ✅ |
| 单据中心 ★ | components/DocumentCenter.tsx | permission customs:read（rPM:281 派生，VIEW_TO_MAIN_SCOPES[DocumentCenter]；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | 单证走 customs 域：customs:read/write scope（customs/customsRouteV2.ts:143/:163）+ 模板域 moduleAuthGuard（customs/documentTemplateRoute.ts:38） | ✅ |
| 财务管理（含发票管理 tab） | components/FinanceManager.tsx | permission invoices:read / vouchers:read（rPM:271/:272 派生，双 View 同渲染文件；批三-D 为 finance:read；QC 仅持 finance:read 不持单据族 scope 视图层锁出，属预期收紧——finance/route.ts:179 注释同口径） | 有：finance/FinanceCreditPanel.tsx:104-105 credit:freeze:write/credit:thaw:write；finance/FinancePaymentRequestsPanel.tsx:83 finance:payment_request:create | finance V1：moduleAuthGuard（finance/route.ts:173）+ GET 读面按资源挂 scope（`915e2ba`：vouchers:read :181 定义→:245/:273/:510；invoices:read :182→:367/:966/:988/:1003；vat:read :183→:594/:635；remit:read :184→:424/:438/:460/:526/:579；finance:read :185→:767/:785/:835/:854/:877/:899/:921/:935/:950；GET / 保 API-Key 兼容认证门 :193）+ 写面 legacy requireRole HIGH_RISK（:176 定义，:221/:284/:758/:801 等，FINANCE→legacy finance 在组内 permissionService.ts:55）；V2 scope（finance/routeV2.ts:81 守卫，:112-136 CRUD 工厂，:144 finance:read；前端 invoiceService.ts:3 走 /api/v1/finance）；vat/remit 子面 SALES/SM/LOGISTICS 403 属功能级收窄 | ✅ |
| 定价与利润 | components/PricingManager.tsx | permission pricing:read（rPM:273 派生；批三-D 为 finance:read；QC/LOGISTICS 未持 pricing:read 视图层锁出，属文档预期收紧） | 无（服务端 403 兜底，v1.0 接受） | pricing 域 scope 全（pricing/pricingRoute.ts:72 守卫，:92 read/:101 write） | ✅ 族A 闭环（锁出=预期，非死胡同） |
| 风险管理与合规 | components/RisksManager.tsx | permission risk:read（rPM:275 派生；批三-D 为 finance:read；QC/LOGISTICS 未持 risk:read 视图层锁出） | 无（服务端 403 兜底，v1.0 接受） | risk 域：moduleAuthGuard（risk/riskRoute.ts:66）+ 读面 requirePermission('risk:read')（:69 定义，:90/:98/:127/:140/:159/:194/:232/:282）+ 写面 requireJwtForWrite＋requirePermission('risk:write')（:67/:70 定义，:113/:149/:170/:180/:207/:247/:257/:268/:291）+ credit-risk-scan risk:write∨risk:admin（:72/:218，`915e2ba`）；risk:write 持 SM/FINANCE（rPM:443/:517） | ✅ 族B 闭环 |
| 数据中心 | components/DataCenter.tsx | permission knowledge:read（rPM:277 派生） | 无（服务端 403 兜底，v1.0 接受） | knowledge 域 scope（knowledge/knowledgeRoute.ts:48 守卫，:52 read/:60 write）+ 知识文档 scope（ai/knowledgeDocumentsRoute.ts:49 守卫，:66/:78）+ 迁移 data:import scope（migration/dataMigrationRoute.ts:40 守卫，:65/:76） | ✅（注记：data:import 默认矩阵仅 SALES/ADMIN/LOGISTICS 持（rPM:420/:585/:720，SUPER 全放行），FINANCE/QC/SM 过视图门后迁移功能 403，功能级兜底已登记） |
| 人事管理 | components/HRManager.tsx | permission hr:read（rPM:287 派生；批三-D 为 users:read） | 无（服务端 403 兜底，v1.0 接受） | hr 域：moduleAuthGuard（hr/route.ts:35）+ scope 门（`915e2ba` 后追加：GET→hr:read（FINANCE/ADMIN 持 rPM:524/:616）、写→hr:write（ADMIN 持）、GET /teams/mine 全登录放开（hr/route.ts:41-47，小组共享文档 §6 口径））；legacy requireRole('owner','admin') 全局守卫已退役 | ✅ 复核轮死胡同闭环 |
| 业务工具 | components/BusinessTools.tsx | permission tools:execute（rPM:278 派生） | 无（服务端 403 兜底，v1.0 接受） | tools 域 fabricCalculator moduleAuthGuard（tools/fabricCalculatorRoute.ts:20）；发票/箱单/合同生成器为本地渲染无服务端写面 | ✅ |
| 生产执行 MES | components/MesManager.tsx | permission production:read（rPM:282 派生；批三-D 为 orders:read） | 无（服务端 403 兜底，v1.0 接受） | mes 域：读面 authenticate 认证闭包（mes/mesRoute.ts:114，API-Key 兼容族契约保留）+ 写面 authenticate＋scopeGate production:write（:127/:140-141 定义，26 端点 :196/:212/:225/:300/:316/:329/:341/:357/:410/:426/:458/:474/:487/:539/:555/:571/:616/:632/:645/:657/:673/:714/:729/:737/:745/:753，`915e2ba`）；production:write 持 SALES/SM/QC（rPM:400/:663） | ✅ 族B 闭环 |
| 管理后台 | components/AdminPanel.tsx | permission users:read（rPM:286 派生） | 有：admin/CompanyProfileSection.tsx:35 admin:write（**该 scope 仍未登记 lib/rolePermissionMatrix.ts**，全仓 grep 零命中，仅 SUPER_ADMIN 代码级放行/owner legacy 通过，登记待办保留）；admin/MoqThresholdsPanel.tsx:63 settings:moq:write | admin 域：moduleAuthGuard（admin/route.ts:74）+ 整路由 requireRole('owner','admin')（:79） | ✅ |
| 设置 | components/Settings.tsx | public-authenticated（Settings/AccountSettings modulePermissions.ts:21-22）；SystemSettings permission settings:system:read（rPM:285 派生，`81110f3` 隐式放开特案关闭，仅 ADMIN 持 rPM:532） | 有：Settings.tsx:527 hasPermission('ai:chat') → :545-546 ai/voice tab 显隐 | config 域：写端点 requireRole('owner','admin')（config/systemConfigRoute.ts:133/:201，随 requireAuthEnabled 生效）；账号自助（改密/资料）走 auth 域本人会话 | ✅ |

### §7.2 销号统计与未销号归因

**✅ 30 / 30**（设计维度 0/30 与本权限维度互不替代，各自销号；批三-D 基线 ✅16/⬜14，复核轮 ✅29/⬜1 → HR 闭环后全量销号）。

复核轮结论：批三-D 三族 14 页全部闭环——

- **族 A · 视图门⊋服务端门死胡同（4 页）→ 全部 ✅（`81110f3`）**：modulePermissions 根修为从 VIEW_TO_MAIN_SCOPES 派生 required（modulePermissions.ts:27-42），族 scope 手写从机制上废除；矩阵向 QC/LOGISTICS 补授 cockpit:read（rPM:641/:678）、LOGISTICS 补 marketing:read/qc:read（rPM:687/:695）。经营驾驶舱/营销推广/QC 工作台视图门与服务端域 scope 归一；定价与利润 QC/LOGISTICS 未获 pricing:read → 视图层锁出（文档预期收紧，非死胡同）。
- **族 B · 服务端写面无授权门（8 页）→ 全部 ✅（`915e2ba`）**：quotations→quotations:write、development→products:write、risk→risk:write、reporting→reports:write、procurement→procurement:write、inventory→inventory:write、bom→bom:write、production+mes→production:write 全接线；procurement/inventory/bom 三域 inline authenticate 闭包退役换 createModuleAuthGuard，mes 保留 authenticate+scopeGate 组合（读面 API-Key 兼容族契约）；读面同域 read scope 或 API-Key 兼容认证门。
- **族 C · 矩阵授权角色被 legacy 写门拒绝（2 页）→ 全部 ✅（`915e2ba`）**：email 日常写端点（sync/outbox send）→ emails:write；shipping 十一写端点 → shipments:write（DELETE 运单/分配等毁灭性端点保留 legacy HIGH_RISK）；development convert/delete 随批并修 → products:write。SALES/LOGISTICS 矩阵授权与 route 层门禁归一。

未销号清零（复核轮最后一页闭环）：

- **人事管理 ✅ — 派生视图门 × legacy 域交叉死胡同已闭环**：视图门 hr:read 授 FINANCE/ADMIN，服务端原整路由 legacy requireRole('owner','admin') 致 FINANCE 全端点 403（复核轮新证）；已按矩阵真源改 scope 门——GET→hr:read、写→hr:write（ADMIN，§6.6 人事管理归总领导）、GET /teams/mine 全登录放开（小组共享文档 §6 口径），legacy 全局守卫退役（hr/route.ts:41-47）。

### §7.3 横切发现（复核轮更新；供工件一七角色走查直接消费）

1. **视图门族 scope 与矩阵域 scope 系统性错位 → 已根修（`81110f3`）**：modulePermissions 不再手写 scope，30 个 permission 视图 required 全部派生自 VIEW_TO_MAIN_SCOPES[view].read（rPM:250-290），批三-D 统计的「24 视图挂 4 族 scope」双源漂移机制性根除；SystemSettings 隐式放开特案关闭（settings:system:read 仅 ADMIN 持 rPM:532）；permissionViewMatrix.test.ts 242 例锁定清零（原 20 红：19 漂移+1 特案）。
2. **finance:read 七角色全持依旧**（rPM:410 SALES/:499 FINANCE/:607 ADMIN/:659 QC/:712 LOGISTICS，SM 继承，SUPER 全放行），但已不作视图门使用——财务族三页视图门分别派生为 invoices:read/vouchers:read（财务管理）、pricing:read（定价）、risk:read（风险）；QC 仅持 finance:read 不持单据族 scope → 财务管理页视图层锁出（预期收紧，finance/route.ts:179 注释同口径）；finance V1 GET 读面已按资源挂 vouchers/invoices/vat/remit/finance:read（`915e2ba`，route.ts:181-185 定义）。
3. **legacy 角色桥仍是遗留写门的唯一机制**（auth/permissionService.ts:51-59：SUPER_ADMIN→owner、ADMIN→admin、SALES_MANAGER→manager、FINANCE→finance、SALES→sales、QC→viewer、LOGISTICS→logistics；viewer/logistics/sales 均不在任何 HIGH_RISK 写组）。族 C 收编后 legacy requireRole 写组仅留存于：finance V1 写面（route.ts:176 HIGH_RISK 含 finance）、admin 整路由（:79）、config 写端点（:133/:201）、shipping DELETE（:558/:639）、email backfill（:252/:314）、orders/relations/suppliers V1 写面。**hr 全域曾为此桥残留，已随 HR 死胡同闭环改 scope 门（hr/route.ts:41-47）**——「派生视图门 scope 授权集 ⊋ legacy 写组映射集」的同型风险已逐域核完（admin/config 授权集与映射集一致，无死胡同）。
4. **页内权限逻辑全仓 3 页 6 处**（§7.1 已列全：财务 3 处/管理后台 2 处/设置 1 处）；admin:write 仍未登记矩阵真源（全仓 grep 零命中，登记待办保留），settings:moq:write 仅 ADMIN 持（rPM:618）。
5. **认证门形态归一**：写面标准形态 = createModuleAuthGuard（JWT 或 API-Key，auth/moduleGuard.ts）＋ requireJwtForWrite（仅 JWT）＋ requirePermission scope 门；procurement/inventory/bom 私有 authenticate 闭包已退役（`915e2ba`），仅 mes 保留 authenticate+scopeGate 组合（读面 API-Key 兼容族契约，mesRoute.ts:114/:127）；批二-B 七域 71 端点（`6329303`）＋批三-E 族 B/C 十域（`915e2ba`）后，30 页服务端写面角色/scope 门全覆盖（quotations/development/risk/reporting/procurement/inventory/bom/production/mes/email/shipping/finance-GET 族）。

2026-10-10订单同步与窄窗口后续：900px窗口实测查询轨道498px，完整标题／返回保留、动作／视图暂时让位并在关闭后恢复；1080深色轨道678px，1512宽屏362px且保留全部动作。最终4文件14项定向回归通过，证据`evidence/order-header-query-2026-10-10/`。全局桌面画布／表格最小宽度未改，不宣称全应用窄窗口迁移。


### 2026-10-12 最新用户纠正：小型标识、日历与浮层失焦

- “无容器”主要去除不必要的大块面板套壳，不适用于机械删除小型语义标识的底色。pill、badge、chip、日期圆标和状态标签可以且应按辨识需要保留彩色底/轮廓；不得擅自把它们统一变成小点。此条覆盖此前冲突的无容器解释。
- 日历保留原月历＋右详情、彩色事件胶囊、圆形日期和顶部彩色图例的基本形态与密度；只做文字层次、可读性、间距、工具栏细节及必要响应式精修。今天圆标消费现行 `--action-mist` / `--on-action-mist`，选中状态独立保留。源码 `CalendarManager.tsx` 与 `calendar-workspace.css`。
- 用户撤回32%灰黑压暗遮罩方案：通知/审批及本次已讨论的共享浮层采用透明背景＋固定 `blur(4px)` 失焦，无 brightness、saturate 或暖色染色；前景保持实底、细边框、轻阴影。失焦半径不做动画，去重遮罩为透明且无blur，跨iframe协调保留。共享真源 `overlay-tokens.css` / `overlays.css` / `bambook-agent-overlays.css`。
- 本次范围以已讨论的浮层为准；用户表示其他界面以后指出，不主动增加新页面改造。邮箱保留附件、未读、标记、重要状态与文件夹计数等必要标识，未因“无容器”删除这些语义信息。

- 原运行区同步：本会话55个源码/测试/资源文件经逐文件差异核对、目标哈希检查和备份后合入 `/Users/qinwengu/WorkBuddy/Claw/apps/Bambook`，不是整树复制；助手upstream用两段精确锚点迁移，第二次执行无变化。3000与1422现有进程保留，未重启Electron、未清会话或用户数据。
- 实际窗口：已看到智能邮箱中文标题与新布局、日历胶囊、助手浅色首次URL以及原页动态切到深色URL；通知/审批实际前景清晰且背景失焦。原窗口截图归 `evidence/live-sync-2026-10-12/`，先前灰遮罩与去胶囊截图为已被用户撤回的阶段证据，不代表当前最终方案。

- 本次原运行区最终回归：邮箱8文件116项、日历2文件24项、助手/浮层9文件60项全部通过；透明失焦主机/助手浏览器回归通过。最终实屏见live-sync目录的calendar-final-light/dark、notification-defocus-light/dark、approval-defocus-light/dark、agent-light/dark及agent-about-defocus截图。最终恢复浅色并停留日历；未执行真实收发邮件或业务写入。


### 2026-10-12 日历类型切换与开放日详情（覆盖本轮回退中的旧控件保留）

- 用户明确指出顶部 switch 与右详情仍为老版；保留月历密度、彩色事件胶囊、日期圆标与图例，但不再保留旧 segmented 大底板和右侧大卡片套壳。
- `CalendarManager.tsx` / `calendar-workspace.css`：类型选择采用独立小选项与共享 action-mist 选中材质；右详情开放排版，24px 日期统领工作日/计数、事件全文、说明及语义 chip。事件容器默认透明，悬停仅轻底/颜色反馈，不位移。
- `calendarEvents.ts` 新增可选 fullTitle，月格 title 仍沿用原18字符截断，详情读取全文；日期、严重度、数量与业务跳转不变。
- 已按哈希核对同步4个文件到原运行目录。实际 Electron AX 显示 `localhost:3000/`；Vite PID28925 的 cwd 为原目录。同步前HTTP响应含 bds-seg、不含新选择器；同步后响应包含 bds-calendar-type-option、bds-calendar-detail-heading、fullTitle 和透明事件行样式。无需生产build驱动该dev入口。
- 功能：原目录2文件26测试通过，日志 `/tmp/bambook-target-calendar-controls-tests.log`。交互：实际原窗口选择10月16日22节点、出运筛选后空态、恢复全部并切深色；完整标题在AX与画面中确认。
- 视觉证据：`docs/design-system/evidence/calendar-controls-detail-2026-10-12/` 中 before-light、after-light、after-dark、filter-empty-light；原Electron桌面截图2870×2062。未重新验证窄宽度，未直接提取真实窗口computed style；截图和HTTP源码不等于全范围视觉认可。用户在验收过程中开始操作窗口，保留其后续选择，不强行恢复主题/日期。


### 2026-10-12 通知栏精修与共享浮层配色纠正

- 用户最新裁决：共享浮层跟随当前主题色，移除独立灰色与常驻亮边；通知中心可专项精修，不能把其造型强加到“关于”等弹窗。小型 pill / chip / badge 保留。
- `overlay-tokens.css` 的 surface 引用 `--bg-card`，边框为1px透明，阴影引用 `--bds-shadow-md`；继续透明遮罩＋固定4px背景失焦，前景不模糊。此条覆盖旧固定灰色、常驻细亮边的记载。
- `NotificationCenter.tsx` / `notifications.css`：通知与审批采用独立图标选项，选中态消费 action-mist；审批子选项、正文层次与操作图标同步精修。通知/审批/提醒偏好卡片专项使用24px圆角、透明边框和 xs 阴影，不改变其他弹窗形态。
- 最高约束：原3D滚动起伏完全保留。useSectionCardScroll3D.ts、orderStageMotion.ts、orderWheelScroll.ts 在工作树与原目录哈希一致，profiles.css 与修改前快照一致；挂载点、hook调用、transform规则、参数与开合动效片段未改。
- 功能：原运行目录定向10文件75测试通过；工作树通知相关22测试与独立浏览器主题/叠层验证通过。未声明全仓构建或全业务回归。
- 交互：原 Electron 实际验证通知/审批切换、明暗主题、通知列表滚动；没有执行审批或发送消息。
- 视觉：实际截图在 `docs/design-system/evidence/notification-polish-2026-10-12/`（after-light、after-dark、scroll-light、scroll-dark、approval-light、approval-dark）；关于弹窗明暗图在 `overlay-theme-2026-10-12/`。已检查真实渲染，最终审美仍由用户判断。
- 实现及证据同步原运行目录，通过现有Vite HMR生效，未重启服务。具体断言和哈希见 notification-polish 目录 verification.json。

## 2026-10-12 双线全局持续改造覆盖矩阵

**最新评审依据（2026-10-12）：**现有 BDS/业务页面不能自证正确；仅登录认可作为方向线索。最新用户否决铺满整个界面的候选，空间感、可呼吸空间与留白必须作为每页结构评审项；无容器不等于撑满。以极简/未来科技感、大部分无容器/明确焦点允许卡片为方向，小badge/chip/彩标保留。每页记录任务、层级、密度、焦点及结构选择理由；本轮所有业务页仍需实渲审查。详见总账§1.1.2。

**用户授权范围：**全软件页面、子页面、重要弹窗/抽屉/表单/空错态逐页专业评审并执行最新 BDS 对齐；保留实际业务、权限和已认可动效。不是全仓换颜色/容器，不把旧台账或测试通过等同于本轮视觉验收。业务裁决与实施矩阵见[总账20.1](../design/global/2026-10-06/08-2026-10-06-对话设计决策总账.md#quotation-20261012)。

**盘点进度：**本表先登记当前注册表的一级入口（含隐藏兼容入口，是否可达仍按 App 核实），尚未完成全部子页面/浮层盘点。文件名粗筛有174个 Panel/Dialog/Drawer/Form/Sheet候选，仅作定位线索，不作页面分母。每模块推进时展开真实条件/角色/子入口，补逐面证据；没有实际渲染者仍待验。

**保护约束：**通知/审批透明遮罩固定4px失焦不压暗；既有通知3D及订单签名滚动不改参数；小胶囊/badge/chip及日历彩色标记保留。以 latest bambook-ui 裁决为准；动作/字段/排版采用共享层，局部内容按业务重组。

| 路由/模块 | 当前实现入口（需与App核实） | 问题/处置决定 | 实施 | 明暗截图/交互证据 |
|---|---|---|---|---|
| 全景看板 / `dashboard` | `components/Dashboard.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 我的工作 / `cockpit` | `components/CockpitManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| AI 助手（开发中） / `assistant` | `components/PlaceholderModule.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 关系智库 / `relations` | `RelationsManager.tsx`、ContactList/DetailPanel显式workspace、relations-workspace.css | 六分类→组织→准确Contact→维护→原业务回程；72rem总体/52rem正文/42rem联系人表单，开放分组48px、40px列距，860/640容器响应。完整字段/原CRM与专业权限；MVP无邮件块、必要标签/启用动作可辨识。历史字段/迁移/权限缺口不关闭 | 原5源码guard备份同步；根/原4组各64/64，Supplier重试通过。旧2组当前38/63，25源码/配方断言失败（before9+新增16），保留；最近tsc23 owned外。真实保存/原迁移与后端scope/primary未全验 | before12/当前31原实渲明暗1435/1920/1100、720短窗及独立592容器已看，真实空态与明示虚构分开；日期/焦点/取消/准确CRM回程及computed动作色通过，业务写入0。视觉仍未认可，见verification与总账§20.1.7 |
| 数字档案 / `products` | `components/ProductsManager.tsx`、`ui/ProductWorkspace.tsx`、`products-workspace.css` | 候选按任务重组：两列自然名单、三类真实关键规格先读、连续维护表单与来源后置；首版铺满/弱标签/短窗越界已实渲否决，模块设置另留 | 功能根/原59/59，根另11探针；字段/权限/图片即时写入与取消保持；原源码guard同步，原6文件一致/74保护未推进；浏览器错误/写入/横溢0，三类准确取消回程 | 最终76普通视口图＋10完整内滚动/56段实测位移见products-workspace证据；真实模拟与明示虚构区分，局部720压力不称全局支持；仍待用户审美认可 |
| 订单管理 / `orders` | `components/OrderManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 生产进度 / `production-board` | `components/ProductionBoard.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 报价管理 / `quotations` | `components/QuotationManager.tsx`、`styles/quotation-workspace.css` | 编辑沿客户→产品明细→条款→来源→内部定价；阅读列表/详情开放分组、身份/金额聚焦、Links按需浮出，原生留痕保留；必要字段展开，56rem/64rem仅为本页判断 | 根当前客户端6组32/32、后端23组406/406、server tsc0；阅读105个原事件表达式保留，新增导航透传。首页Accepted回程和Decimal继承候选已验证；准确客户确认/部分消费/规格交接未闭环，实际数量独立于档位下限已确认 | v4表单31图保留为历史；当前阅读12图含明暗/1920/1100/720页尾与浮层返回，真实写入0；视觉待用户认可，原报价API/UI未替换。见quotation-reading/verification.json及总账§20.1.5 |
| 采购管理 / `procurement` | `components/ProcurementManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 库存与仓储 / `inventory` | `components/InventoryManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| BOM 成本核算 / `bom` | `components/BomManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 客户关系管理 / `crm` | `components/CrmManager.tsx`、`styles/bds/crm-workspace.css`、显式task dialog/TaskForm | 留白候选：完整客户→事项索引→连续商机/完整跟进；身份与通信分组，信用/分层突出主事实；统计从属/关联按需。四表单保留字段与协议，672px任务窗最高80dvh/768px，仅正文滚动；局部配方未认可 | 本轮10源码/test/style guard备份同步原并核哈希；根及原8组各86/86。完整CRM38/39保留旧Supplier1失败，tsc23在owned外。真实空态、四任务键盘/日期portal/短窗滚动、准确联系人与客户级开发回程通过，业务写入0 | 本轮44张：真实before4/空与任务18/回程4；明示虚构正常16及单条历史2，1435浅/1920深/1100浅、独立592容器已看图，无横溢，仍未认可。850全局1080边界保留；见CRM task-verification及总账§20.1.6，旧verification为前批历史 |
| 供应商管理 / `suppliers` | `components/SuppliersManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 季节性与趋势 / `seasons` | `components/SeasonsManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 风险管理与合规 / `risks` | `components/RisksManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| QC 工作台 / `qc-workbench` | `components/QcWorkbenchManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 定价与利润 / `pricing` | `components/PricingManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 营销推广 / `marketing` | `components/MarketingManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 历史加工记录 / `mes` | `components/MesManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 外贸与报关 / `customs` | `components/CustomsManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 单据中心 / `document-center` | `components/DocumentCenter.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 发票管理 / `invoices` | `components/FinanceManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 财务管理 / `payment-vouchers` | `components/FinanceManager.tsx` | 按选工作→核原凭证/来源→确认余额→明确核销推导；任务入口先于次要摘要，列表/详情区域间距与宽屏留白保留。本轮凭证/完整交易对象、状态/来源、核销金额三轴阅读，选择与详情对应；已核销金额为焦点，零余额从属，未知/超配/矛盾明确。窄屏列表→680px连续详情→返回；其余子页/创建表单未覆盖，不作为模板 | 本轮源码/test含选择对应DOM回归同步原3000、四套fresh57/57与原目录选择回归fresh16/16；原finance读取200、发票20条/凭证11条、更多11项/账户回程及窄屏返回实测，无横向溢出、pageerror空、财务写入0。非全系统通过 | fresh原1435明暗、1920宽屏及1100列表/详情实渲`evidence/finance-implementation-2026-10-12/finance-breathing-*-original.png`；五张已同步原项目文档路径，root逐张复评，候选仍未用户认可 |
| 报表中心 / `reports` | `components/ReportCenter.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 日历 / `calendar` | `components/CalendarManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 售后索赔 / `claims` | `components/ClaimManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 货运管理 / `shipments` | `components/ShipmentManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 开发与寻样 / `development` | `components/DevelopmentManager.tsx` | 创建第三版与案内实物候选未认可；详情以对象/准确工厂版/当前任务为主阅读，次级版本/节点及案级资料开放排列；面料/成衣任务退去嵌套底座，保留形态/规格/计划量，完整要求与通知资料明确展开、全文可滚动；窄区完整详情与回列表。商业CI按收费方案→准确商业行→票面核对连续阅读，成本/银行资料次级 | 原详情源码guard备份同步；最新可读性7组72通过，留白初轮63、受影响25/27通过，旧workbenchFocus失败与改前一致；原真实案只读，业务写入0。QC proof原58/编译部署健康。商业CI根前端80、根及安全隔离原源码复验后端175各通过，原编译0；私有PG约束及独立临时PG实际服务5项通过；授权/编号/导出/通知seam不代真实角色UAT。24源码已同步，统一原库/client/API/新UI部署被自动审查拒绝，待明确授权；旧运行版健康，CI基线不前进 | 当前18张readable workspace真实原3000截图与4张before，另physical17；root已看图均未认可。商业CI保留原旧票明暗before，虚构禁写隔离组件15张实渲已核（未连原API/DB）；仍为未认可候选，原应用集成视觉待验；清单/验证与部署状态见同目录`ci-verification.json`。其他实例继续逐页验收 |
| 样品仓库 / `samples` | `components/SampleManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 智能邮箱 / `emails` | `components/EmailManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 数据中心（开发中） / `data-center` | `components/PlaceholderModule.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 设置 / `settings` | `components/Settings.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 业务工具 / `business-tools` | `components/BusinessTools.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 管理后台 / `admin` | `components/AdminPanel.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |
| 人事管理 / `hr` | `components/HRManager.tsx` | 待实际页面专业评审；保留/调整/重组未裁定 | 待推进 | 待验 |

**首批进行中：**开发/寻样与报价页面随业务契约改造；根 AGENTS 及 bambook-ui/R1–R5、共享资产已按任务读取。当前实渲基线 `evidence/development-implementation-2026-10-12/before-current-electron.png`（1435×1031深色）只代表改前当前窗口。首批功能、交互、视觉须独立销号，不能据后端定向测试销全站视觉。

### 开发创建第三版实渲复评（2026-10-12，非认可声明）

1. 入口：选择独立面料/服装/寻样模型。当前捕获面料创建，未提交数据；前两版记录保留且明确否决。
2. 主要工作：`fabric-create-composition-customer-original.png`显示名称与目标组成唯一焦点区，表单不拆成遥远两侧；其余按归属/来源、时间/补充、已知规格顺序阅读。标签和输入保持紧密，空白集中在区域之间及页面边缘。
3. 交互：实际填写目标后Tab进入`development-create-owner`；选择客户需求后出现客户/客户依据，已知规格仍可展开。15项针对测试覆盖未知规格、原值保留与寻样跨模块草稿恢复；测试不替代提交成功/角色全链。
4. 复评：初稿浅色辅助文字偏淡，局部提高标签/输入提示可读性并重新实渲。截图确认页面层级成立于当前候选，但审美仍待认可，不把一个焦点卡或控件高度作为通过标准。
5. 范围：1435×1031明暗、1100×900及滚动规格区已捕获；未声称全WCAG、全部角色/类型或全系统视觉通过。费用、报价、财务等分别构图，不能套用此布局。

本轮开发详情及剩余交接检查点见总账§20.1.5；最新workspace截图清单与原源/截图哈希见`evidence/development-implementation-2026-10-12/workspace-verification.json`，旧候选图不能替代当前版本实渲。
