# 装箱单 PL (Packing List)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 外贸核心单据——载明装箱明细/箱数/毛净重/体积的装箱清单，海关查验与物流交接依据 |
| **入口** | 单据中心 `DocumentCenter`（PackingList 类型）/ 运单页批量生成 / 模板管理编辑 PL 模板 |
| **核心角色** | 后勤（含单据、信用证交单、仓储，原单证员：制单；原仓库：装箱数据核对）、货代（物流交接，外部角色） |
| **范式** | 单据模板型文档（模板变量 + 生成逻辑 + 打印导出，§4-§5 简化） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（TradeDocument 类型 + PL 前缀自动取号 + `renderPackingListHtml` 渲染器 + 箱数/毛净重/体积明细 + 柜号/封号 + 打印 PDF） |
| **关联 PRD 章节** | §11.2（贸易单据）、§11.3（单据模板）、§5.6（PL 编号规则） |
| **关联代码** | 渲染器 [exportDocumentTemplates.ts#L236-L329](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L236-L329) `renderPackingListHtml` / 生命周期 [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |

---

## §2 单据定义与用途

### 2.1 业务定位

装箱单（Packing List，简称 PL）载明每项货物的装箱细节，用途：

| 用途 | 说明 |
|------|------|
| 报关 | 海关查验货物包装/重量核对 |
| 物流 | 货代/船公司装箱配载依据 |
| 交单 | L/C 交单/托收配套单据 |
| 仓储 | 目的港拆箱入库核对 |

### 2.2 编号规则

- **类型枚举**：`PackingList`
- **编号前缀**：`PL`
- **格式**：`PL-{YYYY}-{NNNN}`（如 `PL-2026-0042`）

### 2.3 状态流转

遵循单据通用 6 态状态机，详见 [单据体系总览](./1-单据体系总览.md) §3。

---

## §3 模板变量清单

### 3.1 DocumentTemplate 变量

| 变量名 | 来源 | 示例 |
|--------|------|------|
| `{{invoiceNo}}` | order.invoiceNumber / `INV-{shipmentNumber}` | `INV-SHP001` |
| `{{invoiceDate}}` | order.invoiceDate / 今天 | `2026-08-15` |
| `{{poNumber}}` | order.poNumber | `PO-2026-001` |
| `{{customsDeclarationNo}}` | shipment.customsDeclarationNumber | `2026-0890-001` |
| `{{shipperName}}` | exporterProfile.nameEn | `JIANGSU PANDA CLOTHING CO.,LTD.` |
| `{{consigneeName}}` | parties.consignee.name | `ABC TRADING CO.` |
| `{{vessel}}` | shipment.vesselOrFlight + voyageNumber | `MSC GULSUN V.42E` |
| `{{containerNo}}` | shipment.containerNumber | `MSCU1234567` |
| `{{sealNo}}` | shipment.sealNumber | `SEAL-001` |
| `{{portOfLoading}}` | shipment.portOfLoading | `SHANGHAI` |
| `{{portOfDischarge}}` | shipment.portOfDischarge | `LOS ANGELES` |

### 3.2 渲染器装配变量

PL 渲染器 `renderPackingListHtml(data)` 直接消费 DocumentSetData：

| 区块 | DocumentSetData 字段 | 渲染输出 |
|------|---------------------|---------|
| 标题 | — | `PACKING LIST` / `装箱单` |
| 编号/日期 | `order.invoiceNumber` / `invoiceDate` / `poNumber` / `shipment.customsDeclarationNumber` | doc-meta 区块 |
| 发货人 | `getExporterProfile().nameEn` / `addressEn` | exporterBlock |
| 收货人 | `parties.consignee.name` / `address` / `contact` | partyBlock |
| 船名航次 | `shipment.vesselOrFlight` / `voyageNumber` | 运输信息表 |
| 柜号/封号 | `shipment.containerNumber` / `sealNumber` | 运输信息表 |
| 起运/目的港 | `shipment.portOfLoading` / `portOfDischarge` | 运输信息表 |
| 唛头 | `order.poNumber` / `portOfDischarge` / `totals.cartons` → shippingMarks() | Marks 表 |
| 装箱明细 | `lines[].description` / `productCode` / `quantity` / `unit` / `cartons` / `grossWeight` / `netWeight` / `volume` | 装箱明细表 |
| 合计 | `totals.quantity` / `cartons` / `grossWeight` / `netWeight` / `volume` | TOTAL 行 |
| 签章 | `getExporterProfile().nameEn` | 签章区块 |

---

## §4 生成逻辑（简化）

### 4.1 运单生成

`generateTradeDocumentsFromShipment` 批量生成时，PL 创建流程：

1. `assembleDocumentSetData(shipmentId)` 装配数据
2. `generateTradeDocumentNumber(tx, 'PackingList')` 取号 `PL-2026-XXXX`
3. `tradeDocument.create`（status=Draft，consignee=parties.consignee.name，portOfLoading/portOfDischarge 填充）
4. `appendTradeDocumentVersion`（v1 快照 `{ documentSet: data }`）

### 4.2 装箱数据源

PL 的装箱明细数据优先来自 `ShipmentLine`（装箱真源），字段映射：

| PL 字段 | DocumentSetLine 字段 | 数据来源 |
|---------|---------------------|---------|
| 品名 | description | ShipmentLine → OrderLine → CustomsLine |
| 产品编码 | productCode | ShipmentLine |
| 数量 | quantity | OrderLine（价格真源） |
| 箱数 | cartons | ShipmentLine（装箱真源） |
| 毛重 | grossWeight | ShipmentLine |
| 净重 | netWeight | ShipmentLine |
| 体积 | volume | ShipmentLine |

---

## §5 打印导出（简化）

### 5.1 渲染管线

```
TradeDocument.latestVersion.content.documentSet
  → TYPE_TO_EXPORT_KIND['PackingList'] = 'PL'
  → EXPORT_DOC_RENDERERS['PL'].render(ds) = renderPackingListHtml(data)
  → printHtmlDocument({ title: 'PL-2026-0042 v1', htmlBody })
```

### 5.2 格式化函数

| 函数 | 职责 |
|------|------|
| `fmtQty(n)` | 数量格式化（整数去小数 / 非整数 2 位） |
| `fmtW(n)` | 重量格式化（2 位小数，单位 KGS） |
| `formatDocNumber(n, 3)` | 体积格式化（3 位小数，单位 CBM） |

---

## §6 装配数据源

PL 装配依赖 `DocumentSetData` 以下区块：

| 区块 | PL 用途 | 缺失降级 |
|------|---------|---------|
| `shipment` | 船名航次/柜号/封号/起运目的港/报关单号 | 显示 `—` |
| `order` | 发票号/日期/PO 号 | 发票号降级 `INV-{shipmentNumber}` |
| `parties.consignee` | 收货人名/地址/联系人 | 显示 `—` |
| `lines` | 装箱明细行 | 空表 |
| `totals` | 合计箱数/毛净重/体积 | 显示 `—` |

---

## §7 渲染管线

### 7.1 HTML 结构

```html
<div class="doc-header">
  <h1>PACKING LIST</h1>
  <div class="subtitle">装箱单</div>
  <div class="doc-meta">编号/日期/PO号/报关单号</div>
</div>

<div class="doc-party-grid">
  <!-- 发货人 Shipper/Exporter Block -->
  <!-- 收货人 Consignee Block -->
</div>

<div class="doc-section">运输信息表（船名航次/柜号封号/港口）</div>
<div class="doc-section">唛头 + 装箱明细表 + TOTAL</div>
<div class="doc-footer">签章区块</div>
```

### 7.2 装箱明细表列

| 列 | 字段 | 对齐 |
|----|------|------|
| Description 品名 | description + productCode | 左对齐 |
| Quantity 数量 | quantity + unit | 右对齐 |
| Cartons 箱数 | cartons | 右对齐 |
| G.W. (KGS) 毛重 | grossWeight | 右对齐 |
| N.W. (KGS) 净重 | netWeight | 右对齐 |
| Meas. (CBM) 体积 | volume | 右对齐 |

---

## §8 后端契约

### 8.1 创建 PL

`POST /api/v1/customs/trade-documents`：
```json
{
  "type": "PackingList",
  "shipmentId": "shp_xxx",
  "documentNumber": null
}
```

### 8.2 运单生成

`POST /api/v1/customs/trade-documents/generate-from-shipment`：
```json
{
  "shipmentId": "shp_xxx",
  "types": ["CommercialInvoice", "PackingList"]
}
```

---

## §9 前端交互

| 操作 | 触发 | 说明 |
|------|------|------|
| 预览 | 单据中心展开 PL → 预览按钮 | 渲染装箱明细 HTML |
| 打印/PDF | 预览面板打印按钮 | `printHtmlDocument` 独立窗口 |
| 编辑 | 仅 Draft 状态 | 改字段后服务端强制版本留痕 |
| 状态流转 | Draft→Issued→Submitted | 同 CI |

---

## §10 边界与降级

| 场景 | 降级策略 |
|------|---------|
| 无 documentSet 快照 | 降级字段视图 |
| shipment.containerNumber/sealNumber 缺失 | 显示 `—` / `—` |
| lines[].cartons 缺失 | 显示 `—` |
| lines[].grossWeight/netWeight/volume 缺失 | 显示 `—` |
| totals.cartons 缺失 | 显示 `—`（不阻断合计行） |
| parties.consignee 缺失 | 收货人显示 `—`（与 CI 用 parties.customer 不同） |

---

## §11 权限门禁

| 操作 | 权限 |
|------|------|
| 查看 PL 列表/详情/版本 | 读（JWT 或 API-Key） |
| 创建/编辑/删除/状态流转 PL | 写（JWT） |
| 运单批量生成 PL | 写（JWT） |
| 打印/PDF | 前端纯渲染 |

---

## §12 审计留痕

| 操作 | AuditLog action | detail |
|------|----------------|--------|
| 运单生成 PL | `TRADE_DOCUMENT_CREATE` | `{ documentNumber, type: 'PackingList', source: 'generate-from-shipment' }` |
| 创建版本 | `DOCUMENT_VERSION_CREATE` | `{ version, changeReason }` |

---

## §13 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | PL 模板变量填写表单 | P2 | §3.1 |
| 2 | 唛头自定义字段（当前为 PO+目的港+箱数推断） | P2 | §7.2 |
| 3 | 尺码搭配表（Size Assortment） | P3 | §7.2 |

---

## §14 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 打印 HTML 内联样式 | 打印窗口独立上下文——**设计 token 豁免** |
| 单据中心 UI | flat 设计（`rounded-card/inset` + CSS 变量） |
| 装箱明细表 | `.doc-table` 通用样式，右对齐数字列 |

---

## §15 交叉链接

1. [单据体系总览](./1-单据体系总览.md) §2 — PL 在 9 类单据中的定位
2. [单据体系总览](./1-单据体系总览.md) §7 — DocumentSetData 装配数据源
3. [商业发票 CI](./2-商业发票CI.md) — CI/PL 同源装配，唛头共用 shippingMarks()
4. [产地证 CO](./4-产地证CO.md) — PL 箱数/重量为 CO 货物行引用
5. [提单 BL](./5-提单BL.md) — PL 装箱数据为 BL 货物明细来源
6. [保险单 INS](./7-保险单INS.md) — PL 货物为 INS 保险标的来源
7. [批量导出](./9-批量导出.md) — PL 批量打印与 Excel 导出

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| PL 渲染器 | [exportDocumentTemplates.ts#L236-L329](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L236-L329) |
| 装配服务 | [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) |
| 生命周期服务 | [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |
| 单据中心 | [DocumentCenter.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/DocumentCenter.tsx) |
| ShipmentLine 模型 | [schema.prisma](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma) |
