# 商业发票 CI (Commercial Invoice)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 外贸核心单据——载明货物明细/单价/金额/贸易条款/付款方式的商业发票，报关与交单的基础凭证 |
| **入口** | 单据中心 `DocumentCenter`（CommercialInvoice 类型）/ 运单页批量生成 / 模板管理编辑 CI 模板 |
| **核心角色** | 后勤（含单据、信用证交单，原单证员：制单）、财务（含收款银行信息核对，宽泛容器不细分）、海关（报关审单，外部角色） |
| **范式** | 单据模板型文档（模板变量 + 生成逻辑 + 打印导出，§4-§5 简化） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（TradeDocument 类型 + CI 前缀自动取号 + `renderCommercialInvoiceHtml` 渲染器 + 英文金额大写 + 收款银行区块 + 打印 PDF；模板变量解析已接入） |
| **关联 PRD 章节** | §11.2（贸易单据）、§11.3（单据模板）、§5.6（CI 编号规则） |
| **关联代码** | 渲染器 [exportDocumentTemplates.ts#L120-L230](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L120-L230) `renderCommercialInvoiceHtml` / 生命周期 [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |

---

## §2 单据定义与用途

### 2.1 业务定位

商业发票（Commercial Invoice，简称 CI）是出口商向进口商开具的货物价值凭证，用途：

| 用途 | 说明 |
|------|------|
| 报关 | 海关核定货物价值、关税税基的核心单据 |
| 交单 | L/C 交单/托收的核心单据之一 |
| 收款 | 买方付款的金额依据 |
| 退税 | 出口退税申报的配套单据 |

### 2.2 编号规则

- **类型枚举**：`CommercialInvoice`
- **编号前缀**：`CI`
- **格式**：`CI-{YYYY}-{NNNN}`（如 `CI-2026-0042`）
- **生成**：运单批量生成时自动取号；手工创建留空自动取号

### 2.3 状态流转

遵循单据通用 6 态状态机（Draft→Issued→Submitted→Accepted/Rejected/Cancelled），详见 [单据体系总览](./1-单据体系总览.md) §3。

---

## §3 模板变量清单

### 3.1 DocumentTemplate 变量

CI 模板 `content` 支持 `{{variable}}` 占位符，服务端 `extractTemplateVariables` 自动解析冗余存储。典型变量：

| 变量名 | 来源 | 示例 |
|--------|------|------|
| `{{orderNo}}` | order.poNumber | `PO-2026-001` |
| `{{customerName}}` | parties.customer.name | `ABC TRADING CO.` |
| `{{invoiceNo}}` | order.invoiceNumber / `INV-{shipmentNumber}` | `INV-SHP001` |
| `{{invoiceDate}}` | order.invoiceDate / 今天 | `2026-08-15` |
| `{{contractNo}}` | order.finalContractNumber / salesContractNumber | `SC-2026-001` |
| `{{portOfLoading}}` | shipment.portOfLoading | `SHANGHAI` |
| `{{portOfDischarge}}` | shipment.portOfDischarge | `LOS ANGELES` |
| `{{vessel}}` | shipment.vesselOrFlight + voyageNumber | `MSC GULSUN V.42E` |
| `{{tradeTerms}}` | order.deliveryTerms / customs.tradeTerms | `FOB SHANGHAI` |
| `{{paymentTerms}}` | order.paymentTerms | `T/T 30% DEPOSIT` |

### 3.2 渲染器装配变量（DocumentSetData → HTML）

CI 渲染器 `renderCommercialInvoiceHtml(data)` 直接消费装配数据，无需模板变量替换：

| 区块 | DocumentSetData 字段 | 渲染输出 |
|------|---------------------|---------|
| 标题 | — | `COMMERCIAL INVOICE` / `商业发票` |
| 编号/日期 | `order.invoiceNumber` / `order.invoiceDate` / `order.poNumber` / `order.finalContractNumber` | doc-meta 区块 |
| 卖方 | `getExporterProfile().nameEn` / `addressEn` | exporterBlock |
| 买方 | `parties.customer.name` / `address` / `contact` | partyBlock |
| 运输 | `shipment.portOfLoading` / `portOfDischarge` / `vesselOrFlight` / `voyageNumber` / `atd` / `etd` | 运输信息表 |
| 贸易条款 | `order.deliveryTerms` / `customs.tradeTerms`（降级 `FOB SHANGHAI`） | tradeTerms() |
| 付款方式 | `order.paymentTerms` | 运输信息表 |
| 货物明细 | `lines[].description` / `hsCode` / `quantity` / `unit` / `unitPrice` / `amount` | 货物明细表 |
| 唛头 | `order.poNumber` / `shipment.portOfDischarge` / `totals.cartons` → shippingMarks() | Marks 表 |
| 合计 | `totals.amount` / `totals.currency` | TOTAL 行 |
| 金额大写 | `totals.amount` / `currency` → amountInWords() | Amount in Words |
| 收款银行 | `getExporterProfile().beneficiary` / `bankName` / `bankAddress` / `swiftCode` / `usdAccountNumber` | Beneficiary Bank 区块 |
| 签章 | `getExporterProfile().nameEn` | 签章区块 |

---

## §4 生成逻辑（简化）

### 4.1 运单生成

`generateTradeDocumentsFromShipment` 批量生成时，CI 创建流程：

1. `assembleDocumentSetData(shipmentId)` 装配数据
2. `generateTradeDocumentNumber(tx, 'CommercialInvoice')` 取号 `CI-2026-XXXX`
3. `tradeDocument.create`（status=Draft，consignee=parties.customer.name，totalAmount=totals.amount，currency=totals.currency）
4. `appendTradeDocumentVersion`（v1 快照 `{ documentSet: data }`，changeReason="运单生成"）

### 4.2 手工创建

`POST /api/v1/customs/trade-documents`（type=CommercialInvoice，documentNumber 留空自动取号）。

---

## §5 打印导出（简化）

### 5.1 渲染管线

```
TradeDocument.latestVersion.content.documentSet (DocumentSetData)
  → TYPE_TO_EXPORT_KIND['CommercialInvoice'] = 'CI'
  → EXPORT_DOC_RENDERERS['CI'].render(ds) = renderCommercialInvoiceHtml(data)
  → printHtmlDocument({ title: 'CI-2026-0042 v1', htmlBody })
  → 独立打印窗口 → 浏览器打印 → PDF
```

### 5.2 关键渲染函数

| 函数 | 位置 | 职责 |
|------|------|------|
| `renderCommercialInvoiceHtml(data)` | exportDocumentTemplates.ts L120-L230 | 生成 CI 完整 HTML body |
| `amountInWords(amount, currency)` | exportDocumentTemplates.ts L43-L72 | 英文金额大写（SAY TOTAL ... ONLY） |
| `shippingMarks(data)` | exportDocumentTemplates.ts L75-L81 | 默认唛头（PO 号 + 目的港 + 箱数） |
| `tradeTerms(data)` | exportDocumentTemplates.ts L112-L114 | 贸易条款降级链（order→customs→FOB SHANGHAI） |

### 5.3 英文金额大写

`amountInWords` 支持 USD/EUR/CNY 三种币种名 + billion/million/thousand 三级 + cents 两位小数：
- 输入：`amount=42500.50`, `currency='USD'`
- 输出：`SAY TOTAL US DOLLARS FORTY-TWO THOUSAND FIVE HUNDRED AND CENTS FIFTY ONLY`

---

## §6 装配数据源

CI 装配依赖 `DocumentSetData` 以下区块：

| 区块 | CI 用途 | 缺失降级 |
|------|---------|---------|
| `shipment` | 起运港/目的港/船名航次/ETD | 显示 `—` |
| `order` | PO 号/合同号/发票号/发票日期/贸易条款/付款条款 | 发票号降级 `INV-{shipmentNumber}`，日期降级今天 |
| `parties.customer` | 买方名/地址/联系人 | 显示 `—` |
| `lines` | 货物明细行（品名/HS/数量/单价/金额） | 空表 |
| `totals` | 合计金额/币种 | 不显示金额大写 |

详细装配逻辑见 [单据体系总览](./1-单据体系总览.md) §7。

---

## §7 渲染管线

### 7.1 HTML 结构

```html
<div class="doc-header">
  <div class="doc-title-block">
    <h1>COMMERCIAL INVOICE</h1>
    <div class="subtitle">商业发票</div>
  </div>
  <div class="doc-meta">编号/日期/PO号/合同号</div>
</div>

<div class="doc-party-grid">
  <!-- 卖方 Exporter Block -->
  <!-- 买方 Buyer Block -->
</div>

<div class="doc-section">运输信息表</div>
<div class="doc-section">唛头 + 货物明细表 + TOTAL + 金额大写</div>
<div class="doc-section">收款银行信息</div>
<div class="doc-footer">签章区块</div>
```

### 7.2 样式

复用 `printDocument.ts` 的 `BASE_PRINT_STYLES`（`.doc-header` / `.doc-table` / `.doc-party` / `.doc-footer` 等），打印窗口独立上下文——设计 token 豁免。

---

## §8 后端契约

### 8.1 创建 CI

`POST /api/v1/customs/trade-documents`：
```json
{
  "type": "CommercialInvoice",
  "shipmentId": "shp_xxx",
  "documentNumber": null,  // 留空自动取号 CI-2026-XXXX
  "issueDate": "2026-08-15"
}
```

### 8.2 运单生成

`POST /api/v1/customs/trade-documents/generate-from-shipment`：
```json
{
  "shipmentId": "shp_xxx",
  "types": ["CommercialInvoice", "PackingList", "CertificateOfOrigin"]
}
```
同 `shipmentId + CommercialInvoice` 已存在则 skipped（幂等）。

### 8.3 版本查询

`GET /api/v1/customs/trade-documents/:id/versions` → 按 version desc 返回所有版本快照。

---

## §9 前端交互

### 9.1 单据中心 CI 操作

| 操作 | 触发 | 说明 |
|------|------|------|
| 预览 | 点击单据行展开 → 预览按钮 | 有 documentSet 快照时渲染 HTML 预览 |
| 打印/PDF | 预览面板打印按钮 | `printHtmlDocument` 独立窗口 |
| 编辑 | 展开后编辑按钮 | 仅 Draft 状态可编辑 |
| 状态流转 | 展开后状态按钮 | Draft→Issued→Submitted→Accepted/Rejected |
| 版本时间线 | 展开后版本面板 | 显示所有版本 + changeReason |

### 9.2 模板管理

`DocumentTemplateManager` 中 type=CommercialInvoice 的模板：
- 支持新建/编辑/删除/设默认
- content 编辑器支持 `{{variable}}` 占位符
- 保存时服务端自动解析 variables[]

---

## §10 边界与降级

| 场景 | 降级策略 |
|------|---------|
| 无 documentSet 快照（手工创建） | 降级字段视图，不伪造预览 |
| order.invoiceNumber 缺失 | 降级 `INV-{shipmentNumber}` |
| order.invoiceDate 缺失 | 降级今天日期 |
| order.deliveryTerms / customs.tradeTerms 缺失 | 降级 `FOB SHANGHAI` |
| parties.customer 缺失 | 买方显示 `—` |
| totals.amount 为 null | 不显示金额大写行 |
| lines 为空 | 空货物明细表 |
| getExporterProfile() localStorage 无值 | 回退 EXPORTER_PROFILE 默认常量 |

---

## §11 权限门禁

| 操作 | 权限 |
|------|------|
| 查看 CI 列表/详情/版本 | 读（JWT 或 API-Key） |
| 创建/编辑/删除/状态流转 CI | 写（JWT） |
| 运单批量生成 CI | 写（JWT） |
| 打印/PDF | 前端纯渲染（无后端鉴权） |

---

## §12 审计留痕

| 操作 | AuditLog action | detail |
|------|----------------|--------|
| 运单生成 CI | `TRADE_DOCUMENT_CREATE` | `{ documentNumber, type: 'CommercialInvoice', source: 'generate-from-shipment', shipmentId }` |
| 创建版本 | `DOCUMENT_VERSION_CREATE` | `{ version, changeReason, source: 'lifecycle' }` |
| 状态流转 | `TRADE_DOCUMENT_TRANSITION` | `{ fromStatus, toStatus }` |

---

## §13 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | CI 模板变量填写表单（根据 variables[] 自动生成） | P2 | §3.1 |
| 2 | CI 附件上传（filePath/fileName） | P2 | §5 |
| 3 | 多币种金额大写扩展（GBP/JPY/HKD） | P3 | §5.3 |

---

## §14 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 打印 HTML 内联样式 | 打印窗口独立上下文，无 CSS 变量注入——**设计 token 豁免** |
| 单据中心 UI | flat 设计（`rounded-card/inset/control` + CSS 变量 + 无阴影） |
| 状态徽章 | `statusSemanticClass` 语义变体（Draft=neutral / Issued·Submitted=info / Accepted=success / Rejected=danger） |
| 表单字段 | `bds-input` / `rounded-control` + `bg-[var(--recessed-bg)]` |

---

## §15 交叉链接

1. [单据体系总览](./1-单据体系总览.md) §2 — CI 在 9 类单据中的定位
2. [单据体系总览](./1-单据体系总览.md) §7 — DocumentSetData 装配数据源
3. [装箱单 PL](./3-装箱单PL.md) — CI/PL 同源装配，唛头共用 shippingMarks()
4. [产地证 CO](./4-产地证CO.md) — CI 发票号为 CO 引用
5. [提单 BL](./5-提单BL.md) — CI 金额/货物为 BL 运费条款推断依据
6. [保险单 INS](./7-保险单INS.md) — CI 货值为 INS 投保金额推断依据
7. [批量导出](./9-批量导出.md) — CI 批量打印与 Excel 导出

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| CI 渲染器 | [exportDocumentTemplates.ts#L120-L230](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L120-L230) |
| 英文金额大写 | [exportDocumentTemplates.ts#L43-L72](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L43-L72) |
| 生命周期服务 | [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |
| 装配服务 | [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) |
| 单据中心 | [DocumentCenter.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/DocumentCenter.tsx) |
| 出口方档案 | [exporterProfile.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exporterProfile.ts) |
