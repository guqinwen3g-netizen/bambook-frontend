# Bambook Business Capability Matrix v2.0

## 2026-10-01：当前整体验收覆盖登记

本节优先说明本轮覆盖状态。下方v2.0评级、计数、占位和排除为历史快照，不能代表本轮功能通过或当前范围。主方案沿用[测试推进策略 §12](测试推进策略-v2-2026-09-29.md#12-2026-10-01整套软件正式交付验收方案与覆盖登记)，附件为[全局验收矩阵](../artifacts/acceptance-20261001/matrix/matrix.md)。Agent负责方法、分母盘点、测试设计、顺序和质量判断；用户观察过程与结果，仅真实未决公司业务取舍需补事实。

| 维度 | 本轮登记 | 证据界限 |
| --- | --- | --- |
| 当前入口 | 35注册入口、24声明子视图；110组能力 | 每个运行中详情/表单/弹窗及必要动作仍待核对，不是最终功能分母 |
| 模型结构 | 237模型、3860字段、208声明关系字段；476条人工需求关联候选；首批18不变量定位21模型 | 结构对应有效；少量真PG费用/出运片段已执行，完整模型不变量通过0条 |
| 岗位 | 7内置角色；770条能力组×角色候选；首批15条具体权限用例 | 已有授权及审批局部失败证据，完整真实配置、UI/API/Agent及岗位仍待验 |
| 业务衔接 | 24交接、68场景族、43组计划数据、220项正反验证义务；首批12条具体业务用例 | 68族完整分母仍待展开；局部断言不代表跨岗位场景通过 |
| 现有代码线索 | 1155路由声明、895测试源码、3884交互声明、21043 JSX声明 | 新增14个opt-in文件（含环境前置）；静态候选不证明实际渲染、覆盖或通过 |
| 现有整理基线 | 应用源码e126110d；类型检查及前端27失败/10文件为整理时证据 | 后端615文件8242断言：8184通过、55失败、3前置未执行；定向依赖复验6文件189项通过，原19失败保留并挂复验；授权探针5文件36项：17通过19失败；审批探针4文件35项：16通过19失败；十五类独立缺陷未修复，整体验收未通过 |

全部35入口、237模型和110能力组已有组级关联及场景骨架；这只证明登记没有在该粒度漏项。操作分母、实体规则、岗位预期、合法变体、断言及运行证据仍需补齐。没有功能通过率，也不宣称全局没有问题。

旧材料与现口径冲突单列在附件 `scope-conflicts.csv`：整案开发收费及核齐门槛、工厂直发、实际交付CI、适用规则优先、权限实际配置和旧范围。不得按旧“占位/不验收”静默遗漏当前业务，工厂MES主体及全总账税务的既有边界继续有效。

---

> 版本：v2.0
> 日期：2026-08-25（重建，替代 2026-07-20 v1.0 —— v1.0 引用已删的 compiledProductsTemplates、Truth Baseline 数字与 HEAD 均过时）
> 作者：BAMBOOK 项目（基于代码真实态重建；配套权威参考 `docs/CODE_WIKI.md`）
> 口径：**v0.8 交付验收口径**（权威源 `docs/MILESTONE_v0.8.md` + `docs/design/09-路线图与技术债务/2026-08-21-v0.8交付验收剧本.md`）
> 证据约定：每条能力给出「模型 / API / 前端 / Agent / 状态机·门禁 / 评级」六维证据；行号随时可能漂移，以文件路径为准核。

---

## 目录

- [评级标准](#评级标准)
- [Truth Baseline v2.0（2026-08-25）](#truth-baseline-v20)
- [v0.8 交付板块矩阵（19 交付 + 2 占位）](#v08-交付板块矩阵)
- [v0.8 明确不进入验收的板块](#v08-明确不进入验收的板块)
- [三条铁律对应的能力支撑](#三条铁律对应的能力支撑)
- [关键缺口与未决项](#关键缺口与未决项)
- [附注：v1.0 → v2.0 主要修正](#附注)

---

## 评级标准

6 级状态评级（沿用 v1.0，**每条评级必须有文件路径证据**）：

| 级别 | 定义 |
|------|------|
| `planned` | 只有需求/设计文档，无代码 |
| `contracted` | 数据模型 + API 契约（route 存在），无 service 实现 |
| `implemented` | 有 service + 前端组件，无测试 |
| `tested` | 有通过的测试覆盖（含业务回归/门禁测试） |
| `runtime-verified` | 有运行时/E2E 验证证据 |
| `production-used` | 有真实生产使用证据（当前：Mac Mini 已部署 → 整体为生产运行基线，但按证据逐条评定） |

---

## Truth Baseline v2.0

| 维度 | v2.0 实际（2026-08-25） | 证据 |
|------|------------------------|------|
| 前端测试 | **2644 通过 + 6 quarantine，117 文件**（★ 2026-09-25 更正：那是 2026-08 基线快照；当前根域实测 `用例=3942 失败=0 跳过=8`（★ v3.79 复读同一格：口径＝`gate-summary.mjs` 机取，非手抄），其中 `rdlEmailFlatGuard` 的样式隔离已由 6 条解到 **1 条** ⇒ 口径以 `docs/降范围决策登记-2026-09-20.md` 第 47 条为准） | `npm test` 实测（数字为旧快照，见左格更正） |
| 后端测试 | **4467/4467 通过，316 文件** | `cd server && npx vitest run` |
| Prisma 模型 | **197** | schema.prisma `^model` 计数 |
| Agent 工具种子 | **manifest 111 + 新域查询 13 + P0-B 4**（写工具全部 `approval:'always'`） | server/src/agent/mcp/manifest.ts 源码计数 |
| 后端端口 | **8081**（`process.env.PORT \|\| 8081`） | server/src/index.ts:248 |
| 前端样式链 | os-vnext.css → flat-experimental.css → BDS（design-system.css 已退役） | index.css |
| 版本口径 | **v0.8**（V3.0/3.0.0 系过度标注已全面更正） | CODE_WIKI §1 |
| HEAD | `165ff39`（工作区含未提交在途功能：样品间/开发/HR/供应商询价） | git log |

---

## v0.8 交付板块矩阵

> 板块清单与编号严格对齐验收剧本 §3。评级 = 代码证据最高档。

| # | 板块 | 数据模型 | API | 前端 | Agent | 状态机·门禁 | 评级 |
|---|------|---------|-----|------|-------|------------|------|
| 1 | **关系智库** | `Relation/Contact/CreditLimit/FollowUpRecord/Opportunity` | `/api/v1/relations` + `/api/v2/relations`（CRUD/expand/query/360/漏斗/共享） | RelationsManager.tsx | relation.update/delete/onboard、relations.create（always） | 行级权限 requireRelationScope；信用 CAS 并发；敏感字段遮罩 | tested |
| 2 | **CRM** | `Contact/CustomerTier/BrandLine/CommunicationLog` | `/api/v1/crm` + `/api/v2/crm`（contacts/credit-limit/follow-ups/opportunities/tiers） | CrmManager.tsx | 同关系域工具 | 主联系人独占；父组织校验；跟进逾期预警 | tested |
| 3 | **供应商** | `SupplierInquiry/PurchaseOrder/FactoryProfile` | `/api/v1/suppliers` + `/api/v2/suppliers` + 采购询价比价（inquiries/select/close） | SuppliersManager.tsx + SupplierInquiryPanel.tsx | procurement.*（always） | 供应商黑名单（blacklistedAt）禁止新建采购单 | tested |
| 4 | **数字档案** | `ProductAsset/FabricProfile/GarmentProfile/TrimmingProfile`（+分类/成分/客户代码/价格历史/认证/PDML） | `/api/v1/products`（assets CRUD/images/query/expand） | ProductsManager.tsx | products.query/get/expand/describe_schema（never）、product_asset.*（always） | 面料 exclusivity；材料成分 taxon | tested |
| 5 | **开发管理** | `DevelopmentCase/SampleNode` | `/api/v1/development`（case CRUD/阶段/转换）+ `/api/v1/samples` | DevelopmentManager.tsx | development.create/update_stage/convert_to_order（always） | 阶段机 developing→…→approved；convert link/autoCreate；shipping 需 review | tested |
| 6 | **报价管理** | `Quotation/QuotationVersion/QuotationLine` | `/api/v1/quotations` | QuotationManager.tsx | quotation.create/update、quotations.query/get | MOQ writeOnce 快照 + 双轨偏差审批；折扣/低于成本红标门禁 | tested |
| 7 | **订单管理** | `Order/OrderLine/OrderStatusTransition` | `/api/v1/orders` + `/api/v2/orders` + `/api/v1/order-lines` + `/api/v1/order-changes` | OrderManager.tsx | orders.* 查询 + order.line_update/status_transition/delete/confirm/ship（always） | 6 态状态机 + DR-010 守卫；±5% 容差；MOQ/信用冻结门禁 | tested |
| 8 | **生产跟单** | `ProductionStage/PreCutChecklist/OrderProcessNode/FactoryDelayRecord` | `/api/v1/production` + `/api/v2/production`（board 10 阶段泳道） | ProductionBoard.tsx | — | 延迟登记联动交期分下调；工序损耗/完工锁 | tested |
| 9 | **采购管理** | `PurchaseOrder/PurchaseLine/MaterialReceipt/MaterialReturn` | `/api/v1/procurement` + 询价比价 | ProcurementManager.tsx | procurement.create/update_status（always） | PO 状态机；黑名单；退换货状态机 | tested |
| 10 | **库存管理** | `Warehouse/InventoryItem/StockMovement` | `/api/v1/inventory`（warehouses/items/movements/low-stock） | InventoryManager.tsx | inventory.adjust_stock（always） | 六动作校验；锁定可用量；目标仓 | tested |
| 11 | **QC 工作台** | `QCLocation/QCAssignment/InspectionReport/TestRequest/TestReportFile/TestCorrectiveAction` | `/api/v1/qc` | QcWorkbenchManager.tsx | qc.review_garment_sample/review_fabric_sample/sign_report（always） | fail 100% 整改闭环门禁；DR-029 报告独立不可覆盖；双签 | tested |
| 12 | **货运管理** | `Shipment/ShipmentLine/ShipmentOrderAllocation/ShipmentEvent/ShipmentCarton` | `/api/v1/shipping` + order-batches（P0-1） | ShipmentManager.tsx | shipping.create_shipment/update_tracking_status（always）、order.ship | Shipment 8 态；**OrderShipmentBatch 末批唯一+占比≤100%+末批发运收款门禁** | tested |
| 13 | **外贸与报关** | `CustomsDeclaration/CustomsDeclarationLine/HsCode/LetterOfCredit/TaxRefund` | `/api/v1/customs` + `/api/v2/customs` | CustomsManager.tsx | customs.register_lc/update_declaration/query_lc（读 never/写 always） | LC 事件节点；退税自动核算草稿（L10）；单证齐套 | tested |
| 14 | **单据中心** | `TradeDocument/DocumentTemplate/DocumentVersion/RenderedDoc` | `/api/v1/document-templates` + `/api/v1/templates`（render/render-pdf） | DocumentCenter.tsx | template.list/render/render_pdf | 编号前缀 CI/PL/CO/BL/INS/IR/Contract；A4 PDF pdfSha 落库 | tested |
| 15 | **财务管理** | `Invoice/InvoiceOrderAllocation/InvoiceAllocation/PaymentVoucher/PaymentRequest/FxSettlement/OutwardRemittance/VatInvoice/Dunning*` | `/api/v1/finance` + `/api/v2/finance` | FinanceManager.tsx | invoice.issue/cancel/delete、payment_voucher.*、payment.receive_and_reconcile、statement.send、credit.freeze/thaw（全部 always） | Invoice 状态机（核销自动重算）；催款五级；HIGH_RISK_ROLES 全覆盖；CAS | tested |
| 16 | **定价与利润** | `TaxRefundRate/PricingCalculation/OrderProfitSheet/MaterialPriceHistory` | `/api/v1/pricing` | PricingManager.tsx（Track A/B 双轨） | — | Track B 退税公式 `[采购RMB−RMB/1.13×退税率+利润]÷汇率`；利润表幂等 | tested |
| 17 | **BOM 成本核算** | `BOM/BOMLine/CostEstimate` | `/api/v1/bom` | BomManager.tsx | bom.query（never） | 成本汇总（物料+人工+制造费用）；FOB 模型 | tested |
| 18 | **人事管理** | `EmployeeProfile/EmploymentEvent/AttendanceRecord/LeaveRequest/SalaryStructure/PayrollRun/PayrollItem/PerformanceCycle/PerformanceReview/TrainingCourse` | `/api/hr` | HRManager.tsx + PerformanceTab 等 | — | 生命周期唯一入口 recordEmploymentEvent；考勤月度汇总 | tested |
| 19 | **后台管理** | `UserAccount/Role/UserRole/Permission/SystemConfig/DataDictionary/AuditLog` | `/api/admin` + `/api/v1/config` + RBAC 种子 | AdminPanel.tsx | — | RBAC 8 角色 28 权限点；无角色自动 viewer；RequirePermission JWT-only 写 | tested |
| — | **Cockpit（占位暂停）** | 数据模型齐全 | `/api/v1/dashboard` | CockpitManager.tsx | — | **v0.8 验收口径：占位，不进入交付范围**（验收剧本 §3） | implemented |
| — | **报表中心（占位暂停）** | `ReportDefinition/ReportRun` | `/api/v1/reports`（白名单引擎） | ReportCenter.tsx | — | 同上 | tested |

---

## v0.8 明确不进入验收的板块

> 以下板块代码已实现但不在 v0.8 验收范围（验收剧本 §3 注）：**营销推广 / 季节趋势 / 风险管理 / 智能邮箱 / 数据中心 / 业务工具 / 生产执行 MES**。
> 对应证据：marketingRouteV2 / seasons / risk / email / entities / business-tools / mes（均为 tested 级实现，非占位，仅不在本轮验收清单）。

讨论项：**智能邮箱（Emails）** 实现完整（IMAP 同步/分类/AI 抽取/跟进/Outbox 发送）且主链 B 有"邮件关联"需求——若甲方期望验收，可向 195 章评审补充。

---

## 三条铁律对应的能力支撑

| 铁律（验收剧本 §1） | 支撑证据 |
|---|---|
| **S1 主链闭环** | 两条主链 14 环节字段级全接通（CODE_WIKI §6.3 穿透表）；每环节 API + 状态机 + 门禁均为 tested |
| **S2 数据可追溯** | 全写入审计（createAuditMiddleware before/after 快照）+ EntityLink/EntityReference 图谱双写 + OrderStatusTransition/ShipmentEvent 时间线 + RenderedDoc 快照 |
| **S3 角色权限正确** | RBAC 8 角色 28 权限点 + 行级 scope（relations/crm）+ 审批链（DEPT_HEAD→fallback→ADMIN）+ requirePermission JWT-only + HIGH_RISK_ROLES |

---

## 关键缺口与未决项

1. **投产前治理项**（审计报告 192/193/194 轮登记，未消）：原生 `confirm()/alert()` 弹窗 202 处（P1-③）、无请求超时、token 存储、登录 UX、公司抬头硬编码。
2. **L6 icon size 基线准入**（2026-08-25）：工作区在途功能（样品间/开发/HR）引入 6 处非刻度 icon size，基线 65→71 暂收编，待对应会话收编后归零。
3. **BUSINESS_CAPABILITY_MATRIX 自身**：本 v2.0 为重建快照，建议随每轮改动在 CODE_WIKI 增量后同步微调。
4. **Cockpit / 报表中心** 是否在 v0.8 验收中"恢复在验收范围"——需甲方/负责人最终裁决（当前按剧本为占位）。

---

## 附注：v1.0 → v2.0 主要修正

| 项 | v1.0（2026-07-20） | v2.0（2026-08-25） |
|---|---|---|
| 版本口径 | "V3.0/3.0.0" | v0.8（过度标注已更正） |
| compiled 双路径 | 引用 compiledProductsTemplates | **已删除**（2026-08-18），渲染源=Manager |
| 测试数 | 3281 | 前端 2644 / 后端 4467 |
| 模型数 | 未统计 | 197 |
| 工具数 | 83 | manifest 111 + 新域 13 + P0-B 4 |
| 端口 | 未记录 | 8081 |
| Agent 审批 | 未系统记录 | 写工具 100% always + 三层拦截 + what-you-approve-is-what-you-commit |
| 组织 | 主线 A/B/C | **v0.8 验收板块矩阵（19+2）+ 铁律支撑** |
