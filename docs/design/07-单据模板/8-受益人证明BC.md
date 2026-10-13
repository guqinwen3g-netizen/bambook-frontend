# 受益人证明 BC (Beneficiary's Certificate)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 受益人证明——信用证项下由受益人（出口商）出具的声明单据，证明已履行 L/C 规定的特定条款（如寄送副本单据/符合合同规格） |
| **入口** | 运单页批量生成（附属于订单打包场景）/ `EXPORT_DOC_RENDERERS['BC']` 直接渲染 |
| **核心角色** | 后勤（含单据、信用证交单，原单证员：制单）、出口商（签章，业务方）、开证银行/进口商（审单，外部机构） |
| **范式** | 单据模板型文档（模板变量 + 生成逻辑 + 打印导出，§4-§5 简化） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（`renderBeneficiaryCertificateHtml` 渲染器 + L/C 关联引用 + 标准声明文本（中英双语）+ 运单/合同引用 + 签章；无独立 TradeDocument 类型——通过运单生成或版本快照渲染） |
| **关联 PRD 章节** | §11.2（贸易单据）、§11.3（单据模板） |
| **关联代码** | 渲染器 [exportDocumentTemplates.ts#L766-L831](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L766-L831) `renderBeneficiaryCertificateHtml` / 装配 [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) `extras.letterOfCredit` |

---

## §2 单据定义与用途

### 2.1 业务定位

受益人证明（Beneficiary's Certificate，简称 BC）是信用证项下受益人出具的声明性单据，用途：

| 用途 | 说明 |
|------|------|
| L/C 交单 | 证明已履行 L/C 特定条款（如寄送副本单据） |
| 声明履约 | 声明货物符合合同规格 |
| 单据齐备 | 证明已提交全套副本装运单据 |
| 银行审单 | 开证行凭 BC 确认受益人履约 |

### 2.2 与其他单据的关系

BC 是**声明性单据**（非事实性单据），引用其他单据信息：

| 引用对象 | 引用字段 | 来源 |
|---------|---------|------|
| 信用证 | L/C No. / 开证行 / 开证日期 | `extras.letterOfCredit` |
| 开证申请人 | Applicant | `extras.letterOfCredit.applicant` / `parties.customer` |
| 合同/订单 | S/C or P/O No. | `order.finalContractNumber` / `salesContractNumber` / `poNumber` |
| 运单 | Shipment Number / 船名航次 | `shipment.shipmentNumber` / `vesselOrFlight` / `voyageNumber` |
| 发票 | Invoice No. | `order.invoiceNumber` / `INV-{shipmentNumber}` |

### 2.3 渲染器编号

- **编号**：`BC-{shipmentNumber}`（如 `BC-SHP001`）
- **无 TradeDocument 编号**（无独立类型，不自动取号）

---

## §3 模板变量清单

### 3.1 DocumentTemplate 变量

BC 无独立模板类型，通过 `EXPORT_DOC_RENDERERS['BC']` 直接渲染。

### 3.2 渲染器装配变量

BC 渲染器 `renderBeneficiaryCertificateHtml(data)` 直接消费 DocumentSetData：

| 区块 | DocumentSetData 字段 | 渲染输出 |
|------|---------------------|---------|
| 标题 | — | `BENEFICIARY'S CERTIFICATE` / `受益人证明` |
| 编号 | `shipment.shipmentNumber` | `BC-{shipmentNumber}` |
| 日期 | 今天 | formatDate(new Date()) |
| 发票号 | `order.invoiceNumber` / `INV-{shipmentNumber}` | Invoice No. |
| 致（To） | `extras.letterOfCredit.applicant` / `parties.customer.name` | 开证申请人/客户 |
| L/C 号 | `extras.letterOfCredit.lcNumber` + `issueBank` + `issueDate` | L/C No. + issued by + dated |
| 合同/订单号 | `order.finalContractNumber` / `salesContractNumber` / `poNumber` | S/C or P/O No. |
| 运单号 | `shipment.shipmentNumber` + `vesselOrFlight` + `voyageNumber` | B/L or Shipment |
| 声明文本 | `getExporterProfile().beneficiary` | 标准声明（中英双语） |
| 签章 | `getExporterProfile().nameEn` + 今天日期 | Beneficiary's Authorized Signature |

---

## §4 生成逻辑（简化）

### 4.1 运单生成

BC 无独立 TradeDocument 类型，生成方式：

1. **运单生成其他单据** → `generateTradeDocumentsFromShipment` 创建 CI/PL/CO/BL/INS
2. **版本快照含 documentSet** → 含 `extras.letterOfCredit`
3. **订单打包时渲染 BC** → `packTradeDocumentsByOrder` + `EXPORT_DOC_RENDERERS['BC'].render(ds)`

### 4.2 信用证关联

`extras.letterOfCredit` 由装配服务经 `orderId` 解析（`documentSetService.ts`）：

| 字段 | 来源 | 说明 |
|------|------|------|
| `lcNumber` | LetterOfCredit.lcNumber | 信用证号 |
| `issueBank` | LetterOfCredit.issueBank | 开证行 |
| `issueDate` | LetterOfCredit.issueDate | 开证日期 |
| `applicant` | LetterOfCredit.applicant | 开证申请人 |

**降级**：无关联信用证时 `extras.letterOfCredit = null`，BC 仍可生成（致信对象降级为客户）。

---

## §5 打印导出（简化）

### 5.1 渲染管线

```
TradeDocument.latestVersion.content.documentSet
  → 手动指定 ExportDocKind = 'BC'
  → EXPORT_DOC_RENDERERS['BC'].render(ds) = renderBeneficiaryCertificateHtml(data)
  → printHtmlDocument({ title: 'BC-{shipmentNumber} v1', htmlBody })
```

**注意**：`TYPE_TO_EXPORT_KIND` 无 BC 映射（无对应 TradeDocument 类型），需通过订单打包或独立入口调用。

### 5.2 标准声明文本

BC 声明文本为固定中英双语（`exportDocumentTemplates.ts` L809-L821）：

**英文**：
```
WE, {beneficiary}, HEREBY CERTIFY THAT:
1. ONE FULL SET OF NON-NEGOTIABLE SHIPPING DOCUMENTS (INCLUDING COPY OF BILL OF LADING,
   COMMERCIAL INVOICE AND PACKING LIST) HAS BEEN SENT DIRECTLY TO THE APPLICANT BY COURIER
   IMMEDIATELY AFTER SHIPMENT.
2. ALL DOCUMENTS PRESENTED CONFORM TO THE TERMS AND CONDITIONS OF THE RELATIVE LETTER OF CREDIT
   AND THE GOODS SHIPPED ARE IN STRICT ACCORDANCE WITH THE CONTRACT SPECIFICATIONS.
```

**中文**：
```
我司兹证明：船运后已立即以快递方式向开证申请人直接寄送全套副本装运单据
（含提单副本、商业发票与装箱单），且所提交单据均符合相关信用证条款，
所装货物与合同规格严格相符。
```

---

## §6 装配数据源

BC 装配依赖 `DocumentSetData` 以下区块：

| 区块 | BC 用途 | 缺失降级 |
|------|---------|---------|
| `shipment` | 运单号/船名航次 | 运单号显示 `—` |
| `order` | 合同号/订单号/发票号 | 降级 `poNumber` → `—` |
| `parties.customer` | 致信对象（无 L/C 时） | 降级 `—` |
| `extras.letterOfCredit` | L/C 引用 | 不显示 L/C 行，致信降级为客户 |
| `getExporterProfile().beneficiary` | 声明主体 | 默认常量 |

---

## §7 渲染管线

### 7.1 HTML 结构

```html
<div class="doc-header">
  <h1>BENEFICIARY'S CERTIFICATE</h1>
  <div class="subtitle">受益人证明</div>
  <div class="doc-meta">BC-{shipmentNumber} / Date / Invoice No.</div>
</div>

<div class="doc-section">
  <table>
    <!-- To 致（申请人/客户） -->
    <!-- L/C No.（如有） -->
    <!-- S/C or P/O No. -->
    <!-- B/L or Shipment -->
  </table>
</div>

<div class="doc-section">
  <div class="doc-section-title">Certification 声明</div>
  <div class="doc-notes">
    <!-- 标准中英双语声明文本 -->
  </div>
</div>

<div class="doc-footer">
  <div class="doc-signature">
    <div class="sig-label">For and on behalf of {nameEn} (签章)</div>
    <div class="sig-line">&nbsp;</div>
    <div class="sig-name">Beneficiary's Authorized Signature · {today}</div>
  </div>
</div>
```

### 7.2 声明文本定制

当前声明文本为固定模板（寄送副本单据+符合 L/C 条款）。不同 L/C 可能要求不同声明内容（如产地声明/质量声明/装船通知声明），需通过模板编辑或版本快照编辑自定义。

---

## §8 后端契约

BC 无独立后端端点，复用通用单据端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/customs/trade-documents` | 创建单据（type=Other，手工登记 BC） |
| GET | `/api/v1/customs/trade-documents/pack?orderId=` | 订单打包（含 BC 渲染数据） |
| POST | `/api/v1/customs/trade-documents/:id/versions` | 手动追加版本（BC 声明快照） |

---

## §9 前端交互

| 操作 | 触发 | 说明 |
|------|------|------|
| 预览 | 订单打包对话框 → BC 渲染 | `EXPORT_DOC_RENDERERS['BC'].render(ds)` |
| 打印/PDF | 打包对话框打印按钮 | `printHtmlDocument` 独立窗口 |
| 编辑声明 | 版本快照编辑 content | 手动追加版本修改声明文本 |

**注意**：BC 主要在订单打包（L/C 交单）场景使用，通过 `PackDialog` 逐份渲染打印。

---

## §10 边界与降级

| 场景 | 降级策略 |
|------|---------|
| 无 documentSet 快照 | 降级字段视图 |
| extras.letterOfCredit 为 null | 不显示 L/C 行，致信对象降级为 `parties.customer.name` |
| extras.letterOfCredit.applicant 为 null | 致信对象降级为 `parties.customer.name` |
| parties.customer 缺失 | 致信对象显示 `—` |
| order.finalContractNumber/salesContractNumber/poNumber 均缺失 | 合同号显示 `—` |
| shipment.vesselOrFlight 缺失 | 运单号仅显示 shipmentNumber（无 `per {vessel}`） |
| getExporterProfile().beneficiary | 回退默认常量 |

---

## §11 权限门禁

| 操作 | 权限 |
|------|------|
| 查看 BC 快照 | 读（JWT 或 API-Key） |
| 创建/编辑单据（含 BC 声明） | 写（JWT） |
| 订单打包（含 BC 渲染） | 读（JWT 或 API-Key） |
| 打印/PDF | 前端纯渲染 |

---

## §12 审计留痕

| 操作 | AuditLog action | detail |
|------|----------------|--------|
| 手动追加 BC 版本 | `DOCUMENT_VERSION_CREATE` | `{ version, changeReason }` |
| 订单打包查询 | 无审计（只读查询） | — |

---

## §13 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | BC 独立 TradeDocument 类型与编号（BC 前缀） | P1 | §2.3 |
| 2 | DocumentCenter BC 预览入口（当前仅打包场景） | P1 | §9 |
| 3 | 声明文本模板库（多种 L/C 条款声明） | P2 | §7.2 |
| 4 | BC 模板变量填写表单 | P2 | §3.1 |
| 5 | L/C 申请人自动解析（当前需 LetterOfCredit 关联） | P2 | §4.2 |

---

## §14 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 打印 HTML 内联样式 | 打印窗口独立上下文——**设计 token 豁免** |
| 单据中心 UI | flat 设计（`rounded-card/inset` + CSS 变量） |
| 声明文本 | `.doc-notes` 样式，中英双语段落 |

---

## §15 交叉链接

1. [单据体系总览](./1-单据体系总览.md) §2 — BC 在渲染器注册表中的定位
2. [单据体系总览](./1-单据体系总览.md) §7 — DocumentSetData.extras.letterOfCredit 装配
3. [商业发票 CI](./2-商业发票CI.md) — CI 发票号为 BC 引用
4. [装箱单 PL](./3-装箱单PL.md) — PL 为 BC 寄送副本单据之一
5. [提单 BL](./5-提单BL.md) — BL 运单号为 BC 引用，BL 为 BC 寄送副本之一
6. [保险单 INS](./7-保险单INS.md) — INS 同为 L/C 交单单据
7. [批量导出](./9-批量导出.md) — BC 在订单打包场景批量打印

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| BC 渲染器 | [exportDocumentTemplates.ts#L766-L831](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L766-L831) |
| 装配服务（extras.letterOfCredit） | [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) |
| 订单打包服务 | [tradeDocumentLifecycleService.ts#L276-L308](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/customs/tradeDocumentLifecycleService.ts#L276-L308) `packTradeDocumentsByOrder` |
| EXPORT_DOC_RENDERERS 注册表 | [exportDocumentTemplates.ts#L839-L846](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L839-L846) |
| 单据中心打包对话框 | [DocumentCenter.tsx#L824-L918](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/DocumentCenter.tsx#L824-L918) `PackDialog` |
| LetterOfCredit 模型 | [schema.prisma](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma) |
