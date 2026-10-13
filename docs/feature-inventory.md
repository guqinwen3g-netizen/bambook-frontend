# Feature Inventory — 系统功能全比例图（枚举式总账真源）

> 性质：本清单是"最高标准完善化 goal（8 维）"的**唯一复扫与销号载体**。
> 方法：**枚举式总账 + 三对齐差分核对 + 代码级操作路径走查**（不改代码，不做 browser/computer 实机；
> 判断唯一来源 = 读前后端代码逐行判定）。
> 核销：每个枚举节点过「前端调用 = 后端端点 = 模型字段」三对齐 + 成功/失败/边界/权限代码路径，
> 任何断头/孤儿/漂移/待对齐记入本账，对完（涉及口径随时找用户）才落地、才销号。
> 来源：App.tsx 挂载清单（2026-09-11，HEAD=d31ae98）。

## 0. 核对「一行真源」模板（每节点用）
```
Manager: <名>
  页面/tab: <…>
  入口/按钮: <onClick/回调… file:line>
    → apiService.xxx / fetch <file:line>
      → 端点 <method path> server/src/<route.ts>:line
        → service <…>:line → prisma 模型 <字段>
  三对齐: 前端传/读字段 vs 后端模型字段 —— [一致] / [漂移:…]
  代码路径: 成功段 / 失败/空态 / 边界 / 权限门禁 —— [全通] / [缺口:…]
  状态: [待扫] [待对齐] [已对齐✓] [孤岛⚠] [断头✗]
```

## 1. 全 Manager 枚举（App.tsx 挂载 + App 传入 props）
> 孤岛标记：App 侧未传 onNavigate / 顶层快照里的业务上下文。

| # | Manager | App 传入 props | 孤岛? | 主要域 |
|---|---|---|---|---|
| 1 | RelationsManager | relations/onUpdate/isDarkMode/sidebarCollapsed/cloudEndpoint/**onNavigate** | — | 客户/供应商/关系 |
| 2 | ProductsManager | isDarkMode/onNavigate/… (create=1 深链) | — | 产品档案 |
| 3 | OrderManager | isDarkMode/onNavigate/orders/… | — | 订单 |
| 4 | DevelopmentManager | isDarkMode/cases/setCases/**onNavigate**/onOpenOrder/onCreateRelation | — | 开发 |
| 5 | SampleManager | isDarkMode/**onNavigate**/onOpenOrder | — | 样品库 |
| 6 | FinanceManager | isDarkMode/onNavigate/initialTab/… | — | 财务 |
| 7 | CalendarManager | orders/shipments/devCases/invoices/**onNavigate** | — | 日历 |
| 8 | ShipmentManager | isDarkMode/shipments/setShipments/**onNavigate** | — | 出运 |
| 9 | QuotationManager | isDarkMode/**onNavigate**/onOpenOrder | — | 报价 |
| 10 | ProcurementManager | isDarkMode/**onNavigate** | — | 采购 |
| 11 | InventoryManager | isDarkMode/**onNavigate**/onOpenOrder | — | 库存 |
| 12 | BomManager | isDarkMode/**onNavigate** | — | BOM |
| 13 | CrmManager | isDarkMode/**onNavigate** | — | CRM |
| 14 | SuppliersManager | isDarkMode/**onNavigate** | — | 供应商 |
| 15 | SeasonsManager | isDarkMode（**无 onNavigate**） | ⚠️孤岛 | 季节/展会（线索 Converted 无转商机/订单动作） |
| 16 | RisksManager | isDarkMode（**无 onNavigate**） | ⚠️孤岛 | 风险（业务方：可能有联动，登记未排） |
| 17 | QcWorkbenchManager | isDarkMode（**无 onNavigate**） | ⚠️孤岛 | QC（G2-6：验货不回流/不接上下文） |
| 18 | PricingManager | isDarkMode/initialTab（**无 onNavigate**） | ⚠️孤岛 | 定价 |
| 19 | MarketingManager | isDarkMode（无 onNavigate） | ⚠️孤岛 | 营销 |
| 20 | MesManager | isDarkMode（**无 onNavigate**） | ⚠️孤岛 | MES/生产（G2-6） |
| 21 | CustomsManager | isDarkMode/initialTab/**onNavigate**/onOpenDocumentCenter | — | 报关 |
| 22 | EmailManager | emails/orders/knowledge/…/isDarkMode | — | 邮箱 |
| 23 | HRManager | isDarkMode | ⚠️(按定位可独立) | 人力 |
| 24 | CockpitManager | isDarkMode | ⚠️(按定位可独立) | 驾驶舱 |

> 说明：孤岛不一定错（HR/营销/驾驶舱可按定位独立，业务方已确认部分），但**打断联动的主链孤岛**（QcWorkbench/MES/Pricing/Seasons/Risks/Marketing）需按 G2-6 评估是否该接跨模块上下文——记待对齐，不由本清单单方面判。

## 2. 主线映射（每域待补节点级三对齐）
- 主线一 报价→开发→确认→下单：QuotationManager / DevelopmentManager / SampleManager / ProductsManager / OrderManager
- 主线二 下单→采购→生产→QC→出运：OrderManager / ProcurementManager / BomManager / MesManager / QcWorkbenchManager / ShipmentManager / InventoryManager
- 主线三 报关→开票→收款→利润：CustomsManager / FinanceManager / PricingManager / ShipmentManager / OrderManager
- 横切 联动/契约/安全/UI：全部 Manager + App.tsx + services/

### 2.3 主线三 · 财务域 Invoice 节点种子（复扫模板首件，2026-09-11）
> **已对齐开票口径（业务，2026-09-11）**：全局=板块各司一职、互相跳转连续。
> - **开票**：一律在源页(订单/开发/样品)跳转到 **财务(发票管理)页** 统一开；发票页可选类型→自动连到对应区(大货订单/开发)→选条目开票。不 in 源页直接建票（DR-054 单入口）。
> - **查看**：源页本身可快速打开/直达该条发票详情，不必跳走。
> - 复核点：各源页是否提供"跳转开票 / 直达查看"入口（订单页开票、开发/样品页开票查看、报价审批→转单后开票）。
> FinanceManager tabs: invoices / vouchers / paymentRequests / credit / vatInvoices / cashCalendar / reports / reconciliation / collections
> 枚举发票(invoices)tab 主节点三对齐（apiService → 端点 → Invoice 模型）：
- Invoice 列表 `listInvoices/listInvoicesPage` → `GET /v1/finance?limit/offset/search` → Invoice[]（分页 50、上限 200）[✓]
- Invoice 详情 `getInvoice` → `GET /v1/finance/:id` → Invoice + orderAllocations（发票↔订单多对多）[✓]
- Invoice 导出PDF `renderInvoicePdf` → `GET /v1/finance/:id/render.pdf` [✓]
- Invoice 创建 `createInvoice` → `POST /v1/finance`(requireInvoicesWrite)（InvoiceWriteInput→Invoice）[✓-后端门禁齐]
- Invoice 状态流转/作废 `cancel` → `POST /v1/finance/:id/cancel`；删除 `DELETE /v1/finance/:id`（均 requireInvoicesWrite）[✓]
- 核销 `POST /v1/finance/allocations`(requireInvoicesReconcile)/`PATCH :id`/`DELETE :id` → InvoiceAllocation（回款真源）[✓-门禁齐]
- **场景开票（DR-054 单入口）** `sceneInvoiceRoute`：`POST /create`(invoices:write)、`POST /preview` → 按场景(scene)建票 [✓-财务域内]
- 凭证 voucher / 增值税 vat-invoice / 汇兑 fx / 对外付款 outward-remittance / 催款 dunning 各 tab 端点均有 scope 门禁 [部分✓-待逐节点]
- 回款 progress/collections：读 `POST /v1/finance/allocations` 派生 + OrderContext finance（本批回款进度/手动结清节点）[✓]
- 源页"跳转开票/直达查看"入口复核（订单/开发/样品/报价→财务发票）[待扫]
- Invoice 更新 `updateInvoice` → `PATCH/PUT /v1/finance/:id` [待扫]
- 关联：本批已建报价审批模块 + 回款进度/手动结清 + BOM毛利 → 复核其端点在 finance 域的契约一致性 [待扫]
- 复核：源页(订单/开发/样品)的"跳转开票/直达查看"入口是否齐全（对齐上述开票口径）[待扫]

## 3. 进度
- [ ] 此表按 §0 模板逐节点展开（每域一批，成片扫，扫完对接颗粒点后销号）
- [ ] 孤岛主链（QcWorkbench/MES/Pricing/Seasons/Risks/Marketing）待对齐是否接 crossModuleNav
- [ ] 主线三域三对齐（报价审批模块/回款结清/BOM毛利已建，据此复核全链）
- [ ] 消双轨 L-1 已动手（orderContext 开发节点读源切 SampleBatch `d31ae98`）

## 2.4 主线一 · 订单域三对齐全量（复扫第二批，2026-09-12，侦察扫描+人工复核）

> 范围：OrderManager 及子面板 ↔ /api/v1|v2/orders + /v1/order-lines + /v1/order-changes ↔ Order/OrderLine。
> 方法：前端调用枚举 → 后端路由枚举 → 双侧差分（侦察代理全扫 + 关键项人工复核）。

### 已对齐节点 [✓]（30+ 节点抽查，payload/响应字段双侧一致）
列表分页 GET /v2/orders · 详情 GET /v2/orders/:id（含变更生效后刷新 OrderManager:930）·
状态推进 POST /v1/orders/:id/status-transition（payload {toStatus}；operator 空串占位——服务端以认证 actorId 为留痕真源，OrderManager:482）·
时间线 GET /:id/timeline · 确认书 GET /v2/orders/:id/preview.html + POST generate-document ·
台账导出 GET /v2/orders?format=xlsx · 归档 DELETE /v1/orders/:id · 容差 GET /:id/tolerance-status ·
上下文 GET /:id/context（OrderContextSection）· 结清 POST /v2/orders/:id/settle ·
手工建单/改单（importService → /v1/orders/import、POST|PUT /v1/orders）·
★ PDF 导入已于 **2026-09-25 下线**（Kevin 拍板）：`/v1/import/order` 不再挂载 ⇒ 404；
  入口按钮已撤，代码保留（恢复见 `server/src/index.ts` 挂载点注释；防回挂守卫见 `erpCrossModuleSmoke.test.ts`）·
行创建/编辑 POST|PUT /v1/order-lines · TechPack 四端点 · 变更申请 CRUD 六动作（orderChangeService:434-499）·
 shipment 批次面板 → /v1/shipping/order-batches（shipping 域）。字段漂移：未发现（抽查 5 处响应读全对齐）。

### 发现与处置
| # | 标签 | 发现 | 处置 |
|---|---|---|---|
| O-1 | 门禁不对称 | order-changes withdraw 无 scope（对照 apply 有 order:change_request:apply）；但 service 层有「仅申请人本人」对象级校验（orderChangeRequestService:691 requesterId!==actorId→403）+ 仅 Pending | 安全属性成立；scope 对称化待权限矩阵批（§10.4 六角色落地时统一），**本批不动** |
| O-2 | 门禁缺口 | V1 读端点（detail/context/timeline/tolerance-status）仅 auth 无 orders:read（对照 V2 均挂）——横向越权读风险；agent 以服务身份消费 GET /:id | **登记待权限矩阵批**：补 scope 需同步 agent 令牌授权，零敲会破坏 agent 工具 |
| O-3 | 双写分叉 | V2 写端点（POST/PUT/DELETE routeV2.ts:174/193/242）前端零调用，建/改/删全走 V1；删除口径 V1=HIGH_RISK_ROLES vs V2=orders:delete | **登记独立批：orders V1/V2 写通道收敛**（收敛到 V2 或标记废弃，涉及 importService 切换） |
| O-4 | 孤儿端点 | V1 PATCH /batch-status、GET /kanban/summary、POST /tolerance-check、POST /lines、orderLines GET|PATCH version|DELETE；V2 GET /kanban、POST|PUT|DELETE —— 前端/agent 零调用 | **登记清理批**：下线或 @deprecated（walkthrough 依赖核对后执行） |
| O-5 | 静默失败（有意降级） | 时间线刷新 catch 静默（OrderManager:493 注释声明）、变更生效后详情刷新 res.ok 静默 return（:932）——主操作失败路径已有 bdsToast | 低危体验债，**登记不修**（避免噪声 toast） |
| O-6 | 正面项 | 幂等 clientRequestId（变更申请）、审计留痕（status-transition/timeline）、V2 列表 orders:read 门禁 | 质量参照 |

### 孤儿验证注记
- GET /v1/orders/:id 与 POST /v1/orders/query：主前端不调，**agent toolRuntime 消费**（server/src/agent/toolRuntime.ts:3782/3795）——非死代码，收敛批须保留。
- customer-portal 零调用 orders 域（其数据走 /api/v2/customer）。

## 2.5 主线一 · 报价域三对齐全量（复扫第三批，2026-09-12）

> 22 前端节点 ↔ 20 后端端点全量差分。门禁无缺失（写=write+quotations:write，读=quotations:read）；审批链核过（条目/总价审批落平台 approvals，自审禁止+归属校验；合并审批=auto-approved/建总单 hint，与前端枚举逐一对应）；三正向关联写入/回读链全通。发现：
- Q-1 [孤儿] GET /by-target 反查端点（G1-3）全仓零 UI 调用——「订单/开发案反查报价」能力未接入，**待办：订单/开发详情挂报价入口**。
- Q-2 [孤儿] POST /:id/expire 零消费方——**待办：补前端动作或下线**。
- Q-3 [字段漂移·当批已修] 正向关联三列 `?? undefined` 吞 null → 关联一旦建立 UI 无法解绑。修复：服务层显式 null（quotationService:638-640）+ 前端清空提交 null + QuotationInput 类型放宽 string|null。

## 2.6 主线一 · 开发域三对齐全量（复扫第四批，2026-09-12）

> DevelopmentManager + 8 面板 ↔ development/samples 域全量差分。**消双轨复核全过**：sample-nodes 端点/面板/服务前端·portal·agent 零残留；确认锚点唯一真源 SampleBatch；convert-to-asset/convert 双源门禁链逐项对齐；SampleManager 七动作状态机逐项对齐。发现：
- D-1 [留底缺口·当批已修] 成衣轮次封存无 retainLocation 通道（与生产五类封样留底不对称）。修复：sealRound/serialize/persistGate 全链透传 + route + client + GarmentRoundsSection 封存改内联表单（留存位置可选）。
- D-2 [门禁·当批已修] POST /:id/convert 与 DELETE /:id 缺 requireWrite 双挂（对照同域其余写端点）。
- D-3 [口径漂移·登记] convertService 支持 confirmedSourceType='Asset'（直接返单）但 outputs 端点与前端仅 SealSample/Sample 两类——直接返单无入口，属能力缺口非断链，**登记待办**。
- 静默失败：0（面板调用统一 extractApiError + toast）。

## 2.7 主线二 · 采购域+BOM 域三对齐全量（复扫第五批，2026-09-12）

> 采购 27 端点 + BOM 9 端点全量差分；状态机与前端按钮集合吻合；写面门禁统一（procurement:write / bom:write）。发现（B-系）：
- B-1 [孤儿] BOM 无编辑入口：PUT /v1/bom/:id + updateBOM 零调用，Draft 修订只能删除重建（丢审计连续性）——**待办：补编辑 UI 或下线**。
- B-2 [字段漂移] PurchaseOrderInput.bomId 后端可写、前端表单从不发送——PO↔BOM 成本闭环断裂，**待办：表单补 BOM 关联或砍契约**（涉业务口径）。
- B-3 [字段漂移] BOM 创建载荷不发 productAssetId/orderId 锚——自建 BOM 的产品反查/关联过滤恒不生效，**待办：创建表单补锚点**（与 B-1 同批）。
- B-4 [静默失败·低] 下拉数据 catch 空、getPO/getBOM 404 与 5xx 同归 null——登记体验债。
- B-5 [门禁] 两域读面（含 xlsx 全量导出）无读 scope——与 O-2 同类，**待权限矩阵批**。
- B-6 [口径] poNumber/bomNumber 后端可自动生成、前端强制必填——统一口径待定。

## 2.8 主线二 · 生产域+出运域三对齐全量（复扫第六批，2026-09-12）

> production/shipping/mes/releases 四族全量差分；board/pipeline 响应与类型逐字段对齐（正面项）；出运门禁 shipmentReleaseChecker 接线正确。发现（P-系）：
- P-1 [静默失败·当批已修] 裁前清单/验货写入失败被吞（ProductionPipeline catch ignore）——二者是开裁/qc_shipped 门禁判据，静默丢失=门禁数据缺失。修复：回滚勾选态 + bdsToast。
- P-2 [状态码漂移·当批已修] V1 advance 的 PP_RELEASE_BLOCKED 漏映射落 500（V2 为 422）——已补 422。
- P-3 [孤儿·重磅] **DR-053 放行域后端整族 8 端点零 UI 消费**（创建 scope/发起 request/双签/pause/revoke 全裸 API）——开裁门禁依赖的数据无业务入口，**上线零缺口关键待办**：需在订单/QC 工作台内嵌放行面板（PP 样硬拦截+老板特批口径 §10.3-4 的落地载体）。
- P-4 [孤儿] /v2/production 全族 6 端点零消费且响应形制漂移（无 ok 包裹/board 包裹差异）——**待收敛批**。
- P-5 [孤儿] 运单分配修正断头：PATCH/DELETE/by-order 分配端点无前端方法——错配只能整票删，**待办补分配管理 UI**。
- P-6 [孤儿] MES 写路径半数无 UI（plans/work-stations/piece-rate/outsourcing 的 PUT+领用+汇总端点 apiService 有包装无入口）——**待排期**。
- P-7 [口径漂移] V1 sign 允许 body.signerId 代签任意人（V2 强制 actorId）——**待权限矩阵批统一**。
- P-8 [孤儿·低] shipmentService.listShipments 断头（主列表走 listShipmentsPage）且错误不解析 error.message——清理批。
- P-9 [静默失败·低] 统计/舱位预警 catch 空（注释声明设计口径）——保留。

## 2.9 主线三 · 报关/单证/收款三对齐全量（复扫第七批，2026-09-12）

> CustomsManager/DocumentCenter/FinanceManager 收款侧 ↔ customs/customsV2/finance/reconciliation 四族全量差分；凭证 CRUD/核销重算/结汇/付汇/催款分级/对账四端点契约全通（正面项）。发现（C-系）：
- C-1 [门禁] v1 customs 全部 GET 无 customs:read（v2 镜像有）——v1 已整体标注"逐步废弃"（customsRoute.ts:5），**随 V1 收敛批统一**，不零敲。
- C-2 [门禁·当批已修] POST trade-documents/render-by-shipment（出运制单，装配订单/客户/金额数据）无任何 scope → 补 customs:read。
- C-3 [门禁·当批已修] POST /dunning/letter（客户账龄/逾期明细注入）无 scope → 补 invoices:read。
- C-4/C-5 [孤儿·登记] finance v2 双轨（vat/fx/remittance 零消费且 scope 口径 invoices vs remit 不一致）；v1 tax-refunds 家族死代码；/v2/customs/documents 三端点零消费——**待收敛批**。
- C-6 [字段漂移·当批已修] DocumentCenter 全域镜像 customs 交单状态机——非 customs 域单据"提交/接受/拒绝"按钮必被后端 fail-closed 拒绝。修复：按 doc.domain 分流（SIMPLE_DOC_TRANSITIONS 镜像）。
- C-7 [状态机按钮缺失·当批已修] 补 3 个合法流转入口：报关单 Exception→重新提交申报、信用证 Issued→标记过期、Discrepant→重新交单（此前 UI 死路只能取消）。
- C-8/C-9 [静默失败·低] 催款历史吞错、单证版本懒加载吞错——登记体验债。
**主线三复扫完成——三个主线全量扫毕。**