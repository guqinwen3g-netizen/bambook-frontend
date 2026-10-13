# 保险单 INS (Insurance Policy/Certificate)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 货物运输保险单——载明投保金额/保费/险别/保险标的/赔付地点的保险凭证，CIF/CIP 条款下的必备交单单据 |
| **入口** | 单据中心 `DocumentCenter`（InsuranceCert 类型）/ 运单页批量生成 / 模板管理编辑 INS 模板 |
| **核心角色** | 后勤（含单据、信用证交单，原单证员：制单）、保险公司/代理（签发，外部机构）、财务（含保费核对，宽泛容器不细分） |
| **范式** | 单据模板型文档（模板变量 + 生成逻辑 + 打印导出，§4-§5 简化） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（TradeDocument 类型 + INS 前缀自动取号 + `renderInsurancePolicyHtml` 渲染器 + 投保金额推断（CIF×110%）+ 险别默认 + 信用证引用区块 + 金额大写 + 打印 PDF；保险人字段为占位） |
| **关联 PRD 章节** | §11.2（贸易单据）、§11.3（单据模板）、§5.6（INS 编号规则） |
| **关联代码** | 渲染器 [exportDocumentTemplates.ts#L647-L760](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L647-L760) `renderInsurancePolicyHtml` / 装配 [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) `extras.insurance` |

---

## §2 单据定义与用途

### 2.1 业务定位

货物运输保险单（Insurance Policy/Certificate，简称 INS）证明货物已投保运输险，用途：

| 用途 | 说明 |
|------|------|
| 风险保障 | 运输途中货物损损/丢失的赔偿凭证 |
| 交单 | CIF/CIP 条款下 L/C 交单必备单据 |
| 理赔 | 出险时向保险公司索赔的依据 |
| 信用证要求 | L/C 通常要求保险单覆盖 CIF 金额 110% |

### 2.2 编号规则

- **类型枚举**：`InsuranceCert`
- **编号前缀**：`INS`
- **格式**：`INS-{YYYY}-{NNNN}`（如 `INS-2026-0042`）
- **渲染器编号**：`POLICY-{shipmentNumber}`

### 2.3 状态流转

遵循单据通用 6 态状态机，详见 [单据体系总览](./1-单据体系总览.md) §3。

---

## §3 模板变量清单

### 3.1 DocumentTemplate 变量

| 变量名 | 来源 | 示例 |
|--------|------|------|
| `{{shipmentNumber}}` | shipment.shipmentNumber | `SHP001` |
| `{{invoiceNo}}` | order.invoiceNumber / `INV-{shipmentNumber}` | `INV-SHP001` |
| `{{lcNumber}}` | extras.letterOfCredit.lcNumber | `LC-2026-001` |
| `{{insuredName}}` | exporterProfile.beneficiary | `JIANGSU PANDA CLOTHING CO.,LTD.` |
| `{{insuredAmount}}` | extras.insurance.insuredAmount | `46750.00` |
| `{{currency}}` | extras.insurance.currency | `USD` |
| `{{premium}}` | extras.insurance.premium | `350.00` |
| `{{coverage}}` | extras.insurance.coverage | `CIC 一切险+战争险` |
| `{{insurer}}` | extras.insurance.insurer | `—`（占位） |
| `{{claimsAt}}` | shipment.portOfDischarge / customs.destinationCountry | `LOS ANGELES` |
| `{{vessel}}` | shipment.vesselOrFlight + voyageNumber | `MSC GULSUN V.42E` |
| `{{sailingDate}}` | shipment.atd / shipment.etd | `2026-08-15` |
| `{{portOfLoading}}` | shipment.portOfLoading | `SHANGHAI` |
| `{{portOfDischarge}}` | shipment.portOfDischarge | `LOS ANGELES` |

### 3.2 渲染器装配变量

INS 渲染器 `renderInsurancePolicyHtml(data)` 直接消费 DocumentSetData：

| 区块 | DocumentSetData 字段 | 渲染输出 |
|------|---------------------|---------|
| 标题 | — | `INSURANCE POLICY / CERTIFICATE` / `货物运输保险单` |
| 编号 | `shipment.shipmentNumber` | `POLICY-{shipmentNumber}` |
| 发票号 | `order.invoiceNumber` / `INV-{shipmentNumber}` | Invoice No. |
| 信用证号 | `extras.letterOfCredit.lcNumber` | L/C No.（如有） |
| 被保险人 | `getExporterProfile().beneficiary` / `addressEn` | Insured/Beneficiary |
| 保险人 | `extras.insurance.insurer`（占位 `—`） | Insurer |
| 赔付地点 | `shipment.portOfDischarge` / `customs.destinationCountry` | Claims payable at |
| 保险金额 | `extras.insurance.insuredAmount` / `currency` | Amount Insured |
| 保费 | `extras.insurance.premium` / `premiumCurrency` | Premium（如 null 显示 `PAID 已付`） |
| 运输工具 | `shipment.vesselOrFlight` / `voyageNumber` | Conveyance |
| 开航日 | `shipment.atd` / `etd` | Sailing on/about |
| 起运/目的港 | `shipment.portOfLoading` / `portOfDischarge` | From/To |
| 险别 | `extras.insurance.coverage` | Conditions |
| 唛头 | `order.poNumber` / `portOfDischarge` / `totals.cartons` → shippingMarks() | Marks |
| 保险标的 | `lines[].cartons` / `description` / `quantity` / `unit` | 货物明细表 |
| 金额大写 | `extras.insurance.insuredAmount` / `currency` → amountInWords() | Amount in Words |
| 信用证引用 | `extras.letterOfCredit`（lcNumber/issueBank） | L/C Reference 区块（如有） |
| 签章 | `getExporterProfile().nameEn` + 保险人占位 | 双签章 |

---

## §4 生成逻辑（简化）

### 4.1 运单生成

`generateTradeDocumentsFromShipment` 批量生成时，INS 创建流程：

1. `assembleDocumentSetData(shipmentId)` 装配数据（含 `extras.insurance`）
2. `generateTradeDocumentNumber(tx, 'InsuranceCert')` 取号 `INS-2026-XXXX`
3. `tradeDocument.create`（status=Draft）
4. `appendTradeDocumentVersion`（v1 快照 `{ documentSet: data }`）

### 4.2 投保金额推断

`extras.insurance.insuredAmount` 由装配服务推断（`documentSetService.ts`）：

| 贸易条款 | 投保金额推断 | 规则 |
|---------|------------|------|
| CIF / CIP | 货值 × 110% | 国际惯例，加成 10% |
| 其他（FOB/CFR 等） | `null`（不自动推断） | 非卖方投保条款 |

**保费**：`extras.insurance.premium` 来自 `shipment.insuranceAmount`（成本字段，非保额）。

**险别**：`extras.insurance.coverage` 默认 `CIC 一切险+战争险`（中国人民保险公司条款）。

**保险人**：`extras.insurance.insurer` 为 `null`（schema 无字段），模板显示 `—`——需用户手动补录。

---

## §5 打印导出（简化）

### 5.1 渲染管线

```
TradeDocument.latestVersion.content.documentSet
  → TYPE_TO_EXPORT_KIND['InsuranceCert'] = 'INS'
  → EXPORT_DOC_RENDERERS['INS'].render(ds) = renderInsurancePolicyHtml(data)
  → printHtmlDocument({ title: 'INS-2026-0042 v1', htmlBody })
```

### 5.2 信用证引用区块

当 `extras.letterOfCredit` 非空时，INS 渲染额外的 L/C Reference 区块：
- L/C No. 信用证号
- Issuing Bank 开证行

### 5.3 金额大写

当 `extras.insurance.insuredAmount` 非空时，显示保险金额英文大写（复用 `amountInWords()` 函数）。

---

## §6 装配数据源

INS 装配依赖 `DocumentSetData` 以下区块：

| 区块 | INS 用途 | 缺失降级 |
|------|---------|---------|
| `shipment` | 运输工具/开航日/港口/保费 | 显示 `—`；保费显示 `PAID 已付` |
| `order` | 发票号/贸易条款（投保推断） | 降级 `INV-{shipmentNumber}` |
| `customs` | 目的国（赔付地点） | 降级 `shipment.portOfDischarge` |
| `lines` | 保险标的（货物明细） | 空表 |
| `extras.insurance` | 保额/保费/险别/保险人 | 保额非 CIF 时为 null |
| `extras.letterOfCredit` | 信用证引用 | 不显示 L/C 区块 |

---

## §7 渲染管线

### 7.1 HTML 结构

```html
<div class="doc-header">
  <h1>INSURANCE POLICY / CERTIFICATE</h1>
  <div class="subtitle">货物运输保险单</div>
  <div class="doc-meta">POLICY-{shipmentNumber} / Invoice No. / L/C No.</div>
</div>

<div class="doc-party-grid">
  <!-- Insured/Beneficiary 被保险人 -->
  <!-- Insurer 保险人 + 赔付地点 -->
</div>

<div class="doc-section">保险信息表（保额/保费/运输工具/开航日/港口/险别）</div>
<div class="doc-section">唛头 + 保险标的明细表 + 金额大写</div>

<!-- L/C Reference 区块（如有） -->
<div class="doc-section">L/C Reference（信用证号/开证行）</div>

<div class="doc-footer">
  <!-- Insurer 保险人签章 -->
  <!-- Insured 被保险人签章 -->
</div>
```

### 7.2 保险标的明细表列

| 列 | 字段 | 说明 |
|----|------|------|
| No. of Packages 件数 | `lines[].cartons` + ` CTNS` | 箱数 |
| Description of Goods 货名 | `lines[].description` | 货物描述 |
| Quantity 数量 | `lines[].quantity` + `unit` | 数量+单位 |

---

## §8 后端契约

### 8.1 创建 INS

`POST /api/v1/customs/trade-documents`：
```json
{
  "type": "InsuranceCert",
  "shipmentId": "shp_xxx",
  "documentNumber": null
}
```

### 8.2 运单生成

`POST /api/v1/customs/trade-documents/generate-from-shipment`：
```json
{
  "shipmentId": "shp_xxx",
  "types": ["CommercialInvoice", "InsuranceCert"]
}
```

---

## §9 前端交互

| 操作 | 触发 | 说明 |
|------|------|------|
| 预览 | 单据中心展开 INS → 预览按钮 | 渲染保险单 HTML |
| 打印/PDF | 预览面板打印按钮 | `printHtmlDocument` 独立窗口 |
| 编辑 | 仅 Draft 状态 | 改字段后版本留痕 |
| 状态流转 | Draft→Issued→Submitted | 签发后提交保险公司 |

---

## §10 边界与降级

| 场景 | 降级策略 |
|------|---------|
| 无 documentSet 快照 | 降级字段视图 |
| extras.insurance.insuredAmount 为 null（非 CIF 条款） | 保额显示 `—`，不显示金额大写 |
| extras.insurance.premium 为 null | 保费显示 `PAID 已付` |
| extras.insurance.insurer 为 null | 保险人显示 `—`（需手动补录） |
| extras.letterOfCredit 为 null | 不显示 L/C Reference 区块 |
| shipment.portOfDischarge 缺失 | 赔付地点降级 `customs.destinationCountry`，再降级 `—` |
| lines 为空 | 空保险标的表 |
| 保险人签章 | 占位 `Authorized Signature`——需保险公司签发 |

---

## §11 权限门禁

| 操作 | 权限 |
|------|------|
| 查看 INS 列表/详情/版本 | 读（JWT 或 API-Key） |
| 创建/编辑/删除/状态流转 INS | 写（JWT） |
| 运单批量生成 INS | 写（JWT） |
| 打印/PDF | 前端纯渲染 |

---

## §12 审计留痕

| 操作 | AuditLog action | detail |
|------|----------------|--------|
| 运单生成 INS | `TRADE_DOCUMENT_CREATE` | `{ documentNumber, type: 'InsuranceCert', source: 'generate-from-shipment' }` |
| 创建版本 | `DOCUMENT_VERSION_CREATE` | `{ version, changeReason }` |

---

## §13 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | 保险人字段（schema 无字段，需扩展 Shipment 或新增字段） | P1 | §4.2 |
| 2 | 投保金额手动覆盖（当前仅 CIF 自动推断） | P2 | §4.2 |
| 3 | 险别多选与条款选择（CIC/ICC/A/B/C） | P2 | §4.2 |
| 4 | 保险公司电子签单对接 | P2 | §7.1 |
| 5 | INS 模板变量填写表单 | P2 | §3.1 |

---

## §14 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 打印 HTML 内联样式 | 打印窗口独立上下文——**设计 token 豁免** |
| 单据中心 UI | flat 设计（`rounded-card/inset` + CSS 变量） |
| 保额强调 | `<strong>` 标签加粗 |

---

## §15 交叉链接

1. [单据体系总览](./1-单据体系总览.md) §2 — INS 在 9 类单据中的定位
2. [单据体系总览](./1-单据体系总览.md) §7 — DocumentSetData.extras.insurance 装配
3. [商业发票 CI](./2-商业发票CI.md) — CI 货值为 INS 投保金额推断依据
4. [提单 BL](./5-提单BL.md) — BL 运输信息为 INS 运输工具/开航日来源
5. [装箱单 PL](./3-装箱单PL.md) — PL 货物为 INS 保险标的来源
6. [受益人证明 BC](./8-受益人证明BC.md) — BC 引用 INS 交单
7. [批量导出](./9-批量导出.md) — INS 批量打印与 Excel 导出

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| INS 渲染器 | [exportDocumentTemplates.ts#L647-L760](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L647-L760) |
| 装配服务（extras.insurance） | [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) |
| 生命周期服务 | [tradeDocumentLifecycleService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts) |
| 单据中心 | [DocumentCenter.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/DocumentCenter.tsx) |
| 信用证模型 LetterOfCredit | [schema.prisma](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma) |
