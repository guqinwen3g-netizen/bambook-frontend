# 提单 BL (Bill of Lading)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 外贸核心单据——海运提单补料（Shipper's Draft / SI），物权凭证 + 运输合同 + 货物收据三合一 |
| **入口** | 单据中心 `DocumentCenter`（BillOfLading 类型）/ 运单页批量生成 / 模板管理编辑 BL 模板 |
| **核心角色** | 后勤（含单据、信用证交单，原单证员：补料制单）、货代/船公司（签发正本，外部机构）、财务（含物权交接，宽泛容器不细分） |
| **范式** | 单据模板型文档（模板变量 + 生成逻辑 + 打印导出，§4-§5 简化） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（TradeDocument 类型 + BL 前缀自动取号 + `renderBillOfLadingHtml` 渲染器 + 运费条款自动推断 + Shipper/Consignee/Notify 三方 + 柜号/封号 + 打印 PDF；承运人签章为占位） |
| **关联 PRD 章节** | §11.2（贸易单据）、§11.3（单据模板）、§5.6（BL 编号规则） |
| **关联代码** | 渲染器 [exportDocumentTemplates.ts#L430-L535](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L430-L535) `renderBillOfLadingHtml` / 生命周期 [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |

---

## §2 单据定义与用途

### 2.1 业务定位

海运提单（Bill of Lading，简称 BL）是承运人签发的物权凭证，用途：

| 用途 | 说明 |
|------|------|
| 物权凭证 | 正本提单持有人拥有货物所有权 |
| 运输合同 | 承运人与托运人的运输合同证明 |
| 货物收据 | 承运人收到货物的收据 |
| 交单 | L/C 交单核心单据（通常要求全套正本） |

**注意**：系统生成的是 **Shipper's Draft（补料草稿）**，非正式提单——需提交船公司签发正本。

### 2.2 编号规则

- **类型枚举**：`BillOfLading`
- **编号前缀**：`BL`
- **格式**：`BL-{YYYY}-{NNNN}`（如 `BL-2026-0042`）
- **渲染器编号**：`B/L DRAFT-{shipmentNumber}`（标注为补料草稿）

### 2.3 状态流转

遵循单据通用 6 态状态机，详见 [单据体系总览](./1-单据体系总览.md) §3。

---

## §3 模板变量清单

### 3.1 DocumentTemplate 变量

| 变量名 | 来源 | 示例 |
|--------|------|------|
| `{{shipmentNumber}}` | shipment.shipmentNumber | `SHP001` |
| `{{bookingDate}}` | shipment.bookingDate | `2026-08-10` |
| `{{etd}}` | shipment.etd | `2026-08-15` |
| `{{shipperName}}` | exporterProfile.nameEn | `JIANGSU PANDA CLOTHING CO.,LTD.` |
| `{{consigneeName}}` | parties.consignee.name | `ABC TRADING CO.` |
| `{{notifyParty}}` | parties.consignee.name（同收货人） | `ABC TRADING CO.` |
| `{{carrierName}}` | parties.carrier.name | `MSC MEDITERRANEAN SHIPPING` |
| `{{vessel}}` | shipment.vesselOrFlight + voyageNumber | `MSC GULSUN V.42E` |
| `{{portOfLoading}}` | shipment.portOfLoading | `SHANGHAI` |
| `{{portOfDischarge}}` | shipment.portOfDischarge | `LOS ANGELES` |
| `{{containerNo}}` | shipment.containerNumber | `MSCU1234567` |
| `{{sealNo}}` | shipment.sealNumber | `SEAL-001` |
| `{{freightTerms}}` | 贸易条款推断 | `FREIGHT PREPAID` / `FREIGHT COLLECT` |

### 3.2 渲染器装配变量

BL 渲染器 `renderBillOfLadingHtml(data)` 直接消费 DocumentSetData：

| 区块 | DocumentSetData 字段 | 渲染输出 |
|------|---------------------|---------|
| 标题 | — | `BILL OF LADING` / `海运提单补料 (Shipper's Draft / SI)` |
| 编号/日期 | `shipment.shipmentNumber` / `bookingDate` / `etd` | doc-meta 区块 |
| 托运人 | `getExporterProfile().nameEn` / `addressEn` | exporterBlock (Shipper) |
| 收货人 | `parties.consignee.name` / `address` / `contact` | partyBlock (Consignee) |
| 通知方 | `parties.consignee.name` / `address` / `contact` | partyBlock (Notify Party) |
| 承运人 | `parties.carrier.name` | partyBlock (Carrier/Forwarder) |
| 船名航次 | `shipment.vesselOrFlight` / `voyageNumber` | 运输信息表 |
| 运费条款 | `tradeTerms(data)` → 正则推断 | `FREIGHT PREPAID` / `FREIGHT COLLECT` |
| 港口 | `shipment.portOfLoading` / `portOfDischarge` | 运输信息表 |
| 柜号/封号 | `shipment.containerNumber` / `sealNumber` | 运输信息表 |
| 唛头 | `order.poNumber` / `portOfDischarge` / `totals.cartons` → shippingMarks() | Marks 区块 |
| 货物明细 | `lines[].cartons` / `description` / `grossWeight` / `volume` | 货物明细表 |
| 合计 | `totals.cartons` / `shipment.totalPackages` / `totals.grossWeight` / `totals.volume` | TOTAL 行 |
| 备注 | `shipment.notes` + 标准条款 | Remarks 区块 |
| 签章 | `getExporterProfile().nameEn` + 承运人占位 | 双签章 |

---

## §4 生成逻辑（简化）

### 4.1 运单生成

`generateTradeDocumentsFromShipment` 批量生成时，BL 创建流程：

1. `assembleDocumentSetData(shipmentId)` 装配数据
2. `generateTradeDocumentNumber(tx, 'BillOfLading')` 取号 `BL-2026-XXXX`
3. `tradeDocument.create`（status=Draft，consignee=parties.consignee.name，portOfLoading/portOfDischarge 填充）
4. `appendTradeDocumentVersion`（v1 快照 `{ documentSet: data }`）

### 4.2 运费条款推断

`renderBillOfLadingHtml` 内运费条款自动推断（`exportDocumentTemplates.ts` L432-L433）：

| 贸易条款 | 运费条款 | 规则 |
|---------|---------|------|
| FOB / EXW / FCA | `FREIGHT COLLECT`（运费到付） | 买方付运费 |
| CIF / CIP / CFR / CPT / DDP / DAP / DPU | `FREIGHT PREPAID`（运费预付） | 卖方付运费 |
| 缺失 | `FREIGHT COLLECT` | 默认到付 |

推断基于 `tradeTerms(data)` 返回值（order.deliveryTerms → customs.tradeTerms → `FOB SHANGHAI`），正则 `/CIF|CIP|CFR|CPT|DDP|DAP|DPU/`。

---

## §5 打印导出（简化）

### 5.1 渲染管线

```
TradeDocument.latestVersion.content.documentSet
  → TYPE_TO_EXPORT_KIND['BillOfLading'] = 'BL'
  → EXPORT_DOC_RENDERERS['BL'].render(ds) = renderBillOfLadingHtml(data)
  → printHtmlDocument({ title: 'BL-2026-0042 v1', htmlBody })
```

### 5.2 标准条款

BL 备注区固定显示标准条款：
```
SHIPPER'S LOAD, COUNT AND SEAL. SAID TO CONTAIN. 托运人自装、自点、自封。
```
+ `shipment.notes`（运单备注，如有）。

---

## §6 装配数据源

BL 装配依赖 `DocumentSetData` 以下区块：

| 区块 | BL 用途 | 缺失降级 |
|------|---------|---------|
| `shipment` | 船名航次/柜号/封号/港口/预订日期/ETD/备注 | 显示 `—` |
| `order` | 贸易条款（运费推断依据） | 降级 `FOB SHANGHAI` → COLLECT |
| `parties.consignee` | 收货人 + 通知方（BL 两者同源） | 显示 `—` |
| `parties.carrier` | 承运人/货代 | 显示 `—` |
| `lines` | 货物行（箱数/品名/毛重/体积） | 空表 |
| `totals` | 合计箱数/毛重/体积 | 显示 `—` |

---

## §7 渲染管线

### 7.1 HTML 结构

```html
<div class="doc-header">
  <h1>BILL OF LADING</h1>
  <div class="subtitle">海运提单补料 (Shipper's Draft / SI)</div>
  <div class="doc-meta">B/L DRAFT-{shipmentNumber} / Booking Date / ETD</div>
</div>

<div class="doc-party-grid">
  <!-- Shipper 托运人 -->
  <!-- Consignee 收货人 -->
</div>
<div class="doc-party-grid">
  <!-- Notify Party 通知方 -->
  <!-- Carrier/Forwarder 承运人/货代 -->
</div>

<div class="doc-section">运输信息表（船名航次/运费条款/港口/柜号封号）</div>
<div class="doc-section">唛头 + 货物明细表 + TOTAL + 备注</div>
<div class="doc-footer">
  <!-- Shipper 托运人签章 -->
  <!-- Carrier/Agent 承运人/代理签章（占位） -->
</div>
```

### 7.2 货物明细表列

| 列 | 字段 | 说明 |
|----|------|------|
| No. of Packages 件数 | `lines[].cartons` + ` CTNS` | 箱数 |
| Description of Goods 货名 | `lines[].description` | 货物描述 |
| Gross Weight (KGS) | `lines[].grossWeight` | 毛重 |
| Measurement (CBM) | `lines[].volume` | 体积 |

---

## §8 后端契约

### 8.1 创建 BL

`POST /api/v1/customs/trade-documents`：
```json
{
  "type": "BillOfLading",
  "shipmentId": "shp_xxx",
  "documentNumber": null
}
```

### 8.2 运单生成

`POST /api/v1/customs/trade-documents/generate-from-shipment`：
```json
{
  "shipmentId": "shp_xxx",
  "types": ["CommercialInvoice", "PackingList", "BillOfLading"]
}
```

---

## §9 前端交互

| 操作 | 触发 | 说明 |
|------|------|------|
| 预览 | 单据中心展开 BL → 预览按钮 | 渲染提单补料 HTML |
| 打印/PDF | 预览面板打印按钮 | `printHtmlDocument` 独立窗口 |
| 编辑 | 仅 Draft 状态 | 改字段后版本留痕 |
| 状态流转 | Draft→Issued→Submitted | 签发后提交船公司 |

---

## §10 边界与降级

| 场景 | 降级策略 |
|------|---------|
| 无 documentSet 快照 | 降级字段视图 |
| order.deliveryTerms / customs.tradeTerms 缺失 | 降级 `FOB SHANGHAI` → `FREIGHT COLLECT` |
| parties.consignee 缺失 | 收货人 + 通知方均显示 `—`（BL 两者同源） |
| parties.carrier 缺失 | 承运人显示 `—` |
| shipment.containerNumber/sealNumber 缺失 | 显示 `—` / `—` |
| shipment.bookingDate/etd 缺失 | 显示 `—` |
| shipment.notes 缺失 | 仅显示标准条款 |
| 承运人签章 | 占位 `For the Carrier`——需船公司签发正本 |

---

## §11 权限门禁

| 操作 | 权限 |
|------|------|
| 查看 BL 列表/详情/版本 | 读（JWT 或 API-Key） |
| 创建/编辑/删除/状态流转 BL | 写（JWT） |
| 运单批量生成 BL | 写（JWT） |
| 打印/PDF | 前端纯渲染 |

---

## §12 审计留痕

| 操作 | AuditLog action | detail |
|------|----------------|--------|
| 运单生成 BL | `TRADE_DOCUMENT_CREATE` | `{ documentNumber, type: 'BillOfLading', source: 'generate-from-shipment' }` |
| 创建版本 | `DOCUMENT_VERSION_CREATE` | `{ version, changeReason }` |

---

## §13 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | 正本提单签发流程（船公司对接） | P1 | §2.1 |
| 2 | 电放提单（Surrendered B/L）专用模板 | P2 | §7.1 |
| 3 | 多柜号支持（当前仅单柜号字段） | P2 | §3.2 |
| 4 | Notify Party 独立于 Consignee 的字段 | P2 | §3.2 |
| 5 | BL 模板变量填写表单 | P2 | §3.1 |

---

## §14 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 打印 HTML 内联样式 | 打印窗口独立上下文——**设计 token 豁免** |
| 单据中心 UI | flat 设计（`rounded-card/inset` + CSS 变量） |
| 运费条款强调 | `<strong>` 标签加粗（PREPAID/COLLECT） |

---

## §15 交叉链接

1. [单据体系总览](./1-单据体系总览.md) §2 — BL 在 9 类单据中的定位
2. [单据体系总览](./1-单据体系总览.md) §7 — DocumentSetData 装配数据源
3. [商业发票 CI](./2-商业发票CI.md) — CI 贸易条款为 BL 运费推断依据
4. [装箱单 PL](./3-装箱单PL.md) — PL 装箱数据为 BL 货物明细来源
5. [产地证 CO](./4-产地证CO.md) — BL 收货人为 CO Consignee 来源
6. [保险单 INS](./7-保险单INS.md) — BL 运输信息为 INS 投保依据
7. [受益人证明 BC](./8-受益人证明BC.md) — BC 引用 BL 运单号

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| BL 渲染器 | [exportDocumentTemplates.ts#L430-L535](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L430-L535) |
| 装配服务 | [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) |
| 生命周期服务 | [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |
| 单据中心 | [DocumentCenter.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/DocumentCenter.tsx) |
| Shipment 模型 | [schema.prisma](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma) |
