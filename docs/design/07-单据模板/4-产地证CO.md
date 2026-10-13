# 产地证 CO (Certificate of Origin)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 外贸核心单据——证明货物原产国的原产地证书，进口国关税认定（普惠制/自贸协定优惠）的核心凭证 |
| **入口** | 单据中心 `DocumentCenter`（CertificateOfOrigin 类型）/ 运单页批量生成 / 模板管理编辑 CO 模板 |
| **核心角色** | 后勤（含单据、信用证交单，原单证员：制单）、商检局/贸促会（签证，外部机构）、海关（进口国审单，外部机构） |
| **范式** | 单据模板型文档（模板变量 + 生成逻辑 + 打印导出，§4-§5 简化） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（TradeDocument 类型 + CO 前缀自动取号 + `renderCertificateOfOriginHtml` 渲染器 + 原产地声明 + 运输路线 + HS Code + 打印 PDF；签证机构签章为占位） |
| **关联 PRD 章节** | §11.2（贸易单据）、§11.3（单据模板）、§5.6（CO 编号规则） |
| **关联代码** | 渲染器 [exportDocumentTemplates.ts#L335-L424](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L335-L424) `renderCertificateOfOriginHtml` / 生命周期 [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |

---

## §2 单据定义与用途

### 2.1 业务定位

原产地证（Certificate of Origin，简称 CO）证明货物原产国，用途：

| 用途 | 说明 |
|------|------|
| 关税优惠 | 普惠制（GSP）/ 自贸协定（FTA）关税减免依据 |
| 进口清关 | 进口国海关核定原产地 |
| 配额管理 | 纺织品等配额商品的原产地证明 |
| 反倾销规避 | 证明非反倾销国原产 |

### 2.2 编号规则

- **类型枚举**：`CertificateOfOrigin`
- **编号前缀**：`CO`
- **格式**：`CO-{YYYY}-{NNNN}`（如 `CO-2026-0042`）
- **渲染器编号**：`CO-{shipmentNumber}`（HTML 内显示，与 TradeDocument 编号不同）

### 2.3 状态流转

遵循单据通用 6 态状态机，详见 [单据体系总览](./1-单据体系总览.md) §3。

### 2.4 CO 与 Form A 的关系

| 维度 | CO（普通原产地证） | Form A（普惠制原产地证） |
|------|-------------------|------------------------|
| 类型 | CertificateOfOrigin | 无独立 TradeDocument 类型（附属于 CO） |
| 签发机构 | 商会 / 贸促会 | 商检局 / 海关 |
| 用途 | 一般原产地证明 | 普惠制关税优惠 |
| 渲染器 | `renderCertificateOfOriginHtml` | `renderFormAHtml` |
| 详见 | 本文档 | [普惠证 Form A](./6-普惠证FormA.md) |

---

## §3 模板变量清单

### 3.1 DocumentTemplate 变量

| 变量名 | 来源 | 示例 |
|--------|------|------|
| `{{shipmentNumber}}` | shipment.shipmentNumber | `SHP001` |
| `{{invoiceNo}}` | order.invoiceNumber / `INV-{shipmentNumber}` | `INV-SHP001` |
| `{{exporterName}}` | exporterProfile.nameEn | `JIANGSU PANDA CLOTHING CO.,LTD.` |
| `{{exporterAddress}}` | exporterProfile.addressEn | `ROOM A1028...` |
| `{{consigneeName}}` | parties.consignee.name | `ABC TRADING CO.` |
| `{{consigneeAddress}}` | parties.consignee.address | `123 MAIN ST...` |
| `{{originCountry}}` | customs.originCountry / lines[].originCountry | `CHINA` |
| `{{destinationCountry}}` | customs.destinationCountry | `USA` |
| `{{transportRoute}}` | shipment 组合 | `BY SEA / MSC GULSUN / FROM SHANGHAI TO LOS ANGELES` |
| `{{hsCode}}` | lines[].hsCode | `6109.10` |

### 3.2 渲染器装配变量

CO 渲染器 `renderCertificateOfOriginHtml(data)` 直接消费 DocumentSetData：

| 区块 | DocumentSetData 字段 | 渲染输出 |
|------|---------------------|---------|
| 标题 | — | `CERTIFICATE OF ORIGIN` / `原产地证明书` |
| 编号 | `shipment.shipmentNumber` | `CO-{shipmentNumber}` |
| 日期 | 今天 | formatDate(new Date()) |
| 发票号 | `order.invoiceNumber` / `INV-{shipmentNumber}` | Invoice No. |
| 1.出口商 | `getExporterProfile().nameEn` / `addressEn` | exporterBlock |
| 2.收货人 | `parties.consignee.name` / `address` / `contact` | partyBlock |
| 3.运输路线 | `shipment.shippingMethod` / `vesselOrFlight` / `voyageNumber` / `portOfLoading` / `portOfDischarge` | 运输方式及路线 |
| 4.目的国 | `customs.destinationCountry` | 目的国 |
| 5.唛头 | `order.poNumber` / `portOfDischarge` / `totals.cartons` → shippingMarks() | Marks 区块 |
| 6/7/8.货物行 | `lines[].cartons` / `description` / `hsCode` / `quantity` / `unit` | 货物表 |
| 声明 | `customs.originCountry` / `lines[].originCountry`（降级 `CHINA`） | 原产地声明 |
| 签章 | `getExporterProfile().nameEn` + 签证机构占位 | 双签章 |

---

## §4 生成逻辑（简化）

### 4.1 运单生成

`generateTradeDocumentsFromShipment` 批量生成时，CO 创建流程：

1. `assembleDocumentSetData(shipmentId)` 装配数据
2. `generateTradeDocumentNumber(tx, 'CertificateOfOrigin')` 取号 `CO-2026-XXXX`
3. `tradeDocument.create`（status=Draft，consignee=parties.consignee.name，consignor=customs.consignor）
4. `appendTradeDocumentVersion`（v1 快照 `{ documentSet: data }`）

### 4.2 原产地规则推断

CO 的原产国来源优先级：
1. `customs.originCountry`（报关单原产国，真源）
2. `lines[].originCountry`（报关行级原产国，取第一个非空）
3. 降级 `CHINA`（纺织品出口惯例）

声明文本根据原产国自动切换中英文：
- `CHINA` → 英文 `CHINA` + 中文 `中华人民共和国`
- 其他 → 英文原值 + 中文原值

---

## §5 打印导出（简化）

### 5.1 渲染管线

```
TradeDocument.latestVersion.content.documentSet
  → TYPE_TO_EXPORT_KIND['CertificateOfOrigin'] = 'CO'
  → EXPORT_DOC_RENDERERS['CO'].render(ds) = renderCertificateOfOriginHtml(data)
  → printHtmlDocument({ title: 'CO-2026-0042 v1', htmlBody })
```

### 5.2 运输路线组合

`transport` 变量由多个字段组合（`exportDocumentTemplates.ts` L338-L342）：
- `BY {shippingMethod}`（SEA → `BY SEA`）
- `{vesselOrFlight} {voyageNumber}`
- `FROM {portOfLoading} TO {portOfDischarge}`
- 用 ` / ` 连接，全空则显示 `—`

---

## §6 装配数据源

CO 装配依赖 `DocumentSetData` 以下区块：

| 区块 | CO 用途 | 缺失降级 |
|------|---------|---------|
| `shipment` | 运输方式/船名航次/起运目的港 | 运输路线显示 `—` |
| `order` | 发票号 | 降级 `INV-{shipmentNumber}` |
| `customs` | 原产国/目的国/收发货人 | 原产国降级 `CHINA` |
| `parties.consignee` | 收货人 | 显示 `—` |
| `lines` | 货物行（箱数/品名/HS/数量） | 空表 |
| `totals.cartons` | 唛头箱数 | 唛头显示 `N/M` |

---

## §7 渲染管线

### 7.1 HTML 结构（8 栏格式）

```html
<div class="doc-header">
  <h1>CERTIFICATE OF ORIGIN</h1>
  <div class="subtitle">原产地证明书</div>
  <div class="doc-meta">CO-{shipmentNumber} / 日期 / 发票号</div>
</div>

<div class="doc-party-grid">
  <!-- 1. Exporter 出口商 -->
  <!-- 2. Consignee 收货人 -->
</div>

<div class="doc-section">
  <!-- 3. Means of Transport and Route 运输方式及路线 -->
  <!-- 4. Country/Region of Destination 目的国 -->
</div>

<div class="doc-section">5. Marks & Nos. 唛头</div>
<div class="doc-section">6/7/8. Packages, Description, HS Code, Quantity</div>
<div class="doc-section">Declaration 声明（中英双语）</div>
<div class="doc-footer">
  <!-- 出口商声明签章 -->
  <!-- 签证机构证明签章（占位） -->
</div>
```

### 7.2 货物表列

| 列 | 字段 | 说明 |
|----|------|------|
| No. & Kind of Packages | `lines[].cartons` + ` CTNS` | 箱数 |
| Description of Goods 品名 | `lines[].description` | 货物描述 |
| HS Code | `lines[].hsCode` | 海关编码 |
| Quantity 数量 | `lines[].quantity` + `unit` | 数量+单位 |

---

## §8 后端契约

### 8.1 创建 CO

`POST /api/v1/customs/trade-documents`：
```json
{
  "type": "CertificateOfOrigin",
  "shipmentId": "shp_xxx",
  "documentNumber": null
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

---

## §9 前端交互

| 操作 | 触发 | 说明 |
|------|------|------|
| 预览 | 单据中心展开 CO → 预览按钮 | 渲染 8 栏格式 HTML |
| 打印/PDF | 预览面板打印按钮 | `printHtmlDocument` 独立窗口 |
| 编辑 | 仅 Draft 状态 | 改字段后版本留痕 |
| 状态流转 | Draft→Issued→Submitted | 签发后提交签证机构 |

---

## §10 边界与降级

| 场景 | 降级策略 |
|------|---------|
| 无 documentSet 快照 | 降级字段视图 |
| customs.originCountry 缺失 | 降级 `lines[].originCountry`，再降级 `CHINA` |
| customs.destinationCountry 缺失 | 目的国显示 `—` |
| shipment.shippingMethod 缺失 | 运输方式省略（仅显示船名/港口） |
| lines[].hsCode 缺失 | HS Code 显示 `—` |
| lines[].cartons 缺失 | 箱数显示 `—` |
| 签证机构签章 | 占位 `Issuing Authority (盖章)`——需线下盖章 |

---

## §11 权限门禁

| 操作 | 权限 |
|------|------|
| 查看 CO 列表/详情/版本 | 读（JWT 或 API-Key） |
| 创建/编辑/删除/状态流转 CO | 写（JWT） |
| 运单批量生成 CO | 写（JWT） |
| 打印/PDF | 前端纯渲染 |

---

## §12 审计留痕

| 操作 | AuditLog action | detail |
|------|----------------|--------|
| 运单生成 CO | `TRADE_DOCUMENT_CREATE` | `{ documentNumber, type: 'CertificateOfOrigin', source: 'generate-from-shipment' }` |
| 创建版本 | `DOCUMENT_VERSION_CREATE` | `{ version, changeReason }` |

---

## §13 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | 签证机构电子签章对接（贸促会/商检局） | P2 | §7.1 |
| 2 | 自贸协定原产地证（FTA CO）专用模板 | P2 | §2.4 |
| 3 | 原产地标准判定规则（完全原产/实质性改变） | P3 | §4.2 |
| 4 | CO 模板变量填写表单 | P2 | §3.1 |

---

## §14 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 打印 HTML 内联样式 | 打印窗口独立上下文——**设计 token 豁免** |
| 单据中心 UI | flat 设计（`rounded-card/inset` + CSS 变量） |
| 8 栏表格 | `.doc-table` 通用样式 |

---

## §15 交叉链接

1. [单据体系总览](./1-单据体系总览.md) §2 — CO 在 9 类单据中的定位
2. [单据体系总览](./1-单据体系总览.md) §7 — DocumentSetData 装配数据源
3. [商业发票 CI](./2-商业发票CI.md) — CI 发票号为 CO 引用
4. [装箱单 PL](./3-装箱单PL.md) — PL 箱数/重量为 CO 货物行引用
5. [普惠证 Form A](./6-普惠证FormA.md) — Form A 为 CO 的普惠制变体
6. [提单 BL](./5-提单BL.md) — BL 收货人为 CO Consignee 来源
7. [批量导出](./9-批量导出.md) — CO 批量打印与 Excel 导出

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| CO 渲染器 | [exportDocumentTemplates.ts#L335-L424](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L335-L424) |
| Form A 渲染器 | [exportDocumentTemplates.ts#L541-L641](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L541-L641) |
| 装配服务 | [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) |
| 生命周期服务 | [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |
| 单据中心 | [DocumentCenter.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/DocumentCenter.tsx) |
