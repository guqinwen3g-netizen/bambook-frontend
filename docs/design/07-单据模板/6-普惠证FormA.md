# 普惠证 Form A (GSP Certificate of Origin)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 普惠制原产地证（Generalized System of Preferences Form A）——出口至给惠国享受关税优惠的专用原产地证书，12 栏官方格式 |
| **入口** | 运单页批量生成（附属于 CertificateOfOrigin）/ `EXPORT_DOC_RENDERERS['FORMA']` 直接渲染 |
| **核心角色** | 后勤（含单据、信用证交单，原单证员：制单）、商检局（签证，外部机构）、给惠国海关（审单优惠，外部机构） |
| **范式** | 单据模板型文档（模板变量 + 生成逻辑 + 打印导出，§4-§5 简化） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（`renderFormAHtml` 渲染器 + 12 栏官方格式 + 原产地标准 + 运输路线 + 发票引用 + 双方声明签章；无独立 TradeDocument 类型——通过运单生成或版本快照渲染） |
| **关联 PRD 章节** | §11.2（贸易单据）、§11.3（单据模板） |
| **关联代码** | 渲染器 [exportDocumentTemplates.ts#L541-L641](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L541-L641) `renderFormAHtml` / 装配 [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) `extras.originCriterion` |

---

## §2 单据定义与用途

### 2.1 业务定位

Form A 是普惠制（GSP）项下的原产地证书，出口至给惠国（如欧盟、日本、加拿大等）时享受关税优惠：

| 用途 | 说明 |
|------|------|
| 关税优惠 | 给惠国海关凭 Form A 给予减免关税待遇 |
| 原产地标准 | 第 8 栏标注原产地标准（P / W / F 等） |
| 直运规则 | 通常要求直运（非转口） |

### 2.2 与普通 CO 的区别

| 维度 | 普通原产地证 CO | 普惠制原产地证 Form A |
|------|----------------|----------------------|
| 签发机构 | 商会 / 贸促会 | 商检局 / 海关 |
| 用途 | 一般原产地证明 | 普惠制关税优惠 |
| 格式 | 8 栏自定义格式 | 12 栏官方固定格式 |
| 渲染器 | `renderCertificateOfOriginHtml` | `renderFormAHtml` |
| TradeDocument 类型 | CertificateOfOrigin | 无独立类型（附属于 CO） |
| 原产地标准 | 无第 8 栏 | 第 8 栏 `originCriterion` |

### 2.3 渲染器编号

- **编号**：`FA-{shipmentNumber}`（如 `FA-SHP001`）
- **无 TradeDocument 编号**（无独立类型，不自动取号）

---

## §3 模板变量清单

### 3.1 DocumentTemplate 变量

Form A 无独立模板类型（附属于 CertificateOfOrigin 模板），通过 `EXPORT_DOC_RENDERERS['FORMA']` 直接渲染。

### 3.2 渲染器装配变量

Form A 渲染器 `renderFormAHtml(data)` 直接消费 DocumentSetData，按 12 栏官方格式：

| 栏 | DocumentSetData 字段 | 渲染输出 |
|----|---------------------|---------|
| 标题 | — | `GENERALIZED SYSTEM OF PREFERENCES` / `CERTIFICATE OF ORIGIN` / `FORM A · 普惠制原产地证` |
| 参考号 | `shipment.shipmentNumber` | `FA-{shipmentNumber}` |
| 签发国 | `customs.originCountry`（降级 `CHINA`） | `Issued in THE PEOPLE'S REPUBLIC OF CHINA` |
| 目的国 | `customs.destinationCountry` | `Country of destination` |
| 1.出口商 | `getExporterProfile().nameEn` / `addressEn` | Goods consigned from |
| 参考号 | `shipment.shipmentNumber` | `FA-{shipmentNumber}` |
| 2.收货人 | `parties.consignee.name` / `address` | Goods consigned to |
| 4.官方栏 | — | `For official use`（留空） |
| 3.运输路线 | `shipment.vesselOrFlight` / `voyageNumber` / `atd` / `etd` / `portOfLoading` / `portOfDischarge` / `shippingMethod` | Means of transport and route |
| 5.项号 | 行号（1, 2, 3...） | Item No. |
| 6.唛头 | `shippingMarks(data)`（首行显示） | Marks & Nos. |
| 7.货物 | `lines[].cartons` / `description` | No. & kind of packages; description of goods |
| 8.原产地标准 | `extras.originCriterion`（默认 `P`） | Origin criterion |
| 9.毛重 | `lines[].grossWeight` | Gross weight (KGS) |
| 10.发票号 | `order.invoiceNumber` / `INV-{shipmentNumber}` + `invoiceDate` | No. & date of invoices |
| 11.签证机构证明 | 占位 | Certification |
| 12.出口商声明 | `customs.originCountry`（降级 `CHINA`） | Declaration by the exporter |

---

## §4 生成逻辑（简化）

### 4.1 运单生成

Form A 无独立 TradeDocument 类型，生成方式：

1. **运单生成 CO** → `generateTradeDocumentsFromShipment` 创建 CertificateOfOrigin
2. **版本快照含 documentSet** → 含 `extras.originCriterion`
3. **前端渲染时选择 Form A 渲染器** → `EXPORT_DOC_RENDERERS['FORMA'].render(ds)`

### 4.2 原产地标准

`extras.originCriterion` 默认值 `P`（完全原产），由装配服务 `documentSetService.ts` 设置：

| 标准 | 含义 | 适用场景 |
|------|------|---------|
| `P` | 完全原产（Wholly Produced） | 纺织品出口惯例默认值 |
| `W` | 非完全原产，符合给惠国加工标准 | 来料加工/进口原料加工 |
| `F` | 进口原料占比未超过规定比例 | 比例限制场景 |

当前系统固定为 `P`（完全原产），需用户在单据中心编辑版本快照时手动修改。

---

## §5 打印导出（简化）

### 5.1 渲染管线

```
TradeDocument (CertificateOfOrigin).latestVersion.content.documentSet
  → 手动指定 ExportDocKind = 'FORMA'
  → EXPORT_DOC_RENDERERS['FORMA'].render(ds) = renderFormAHtml(data)
  → printHtmlDocument({ title: 'FA-{shipmentNumber} v1', htmlBody })
```

**注意**：`TYPE_TO_EXPORT_KIND['CertificateOfOrigin'] = 'CO'`（默认用普通 CO 渲染器），Form A 需手动切换渲染器或通过独立入口调用。

### 5.2 运输路线组合

`transport` 变量由多字段组合（`exportDocumentTemplates.ts` L543-L548）：
- `{vesselOrFlight} {voyageNumber}`
- `ON/ABOUT {atd || etd}`
- `FROM {portOfLoading}, CHINA TO {portOfDischarge}`
- `BY {shippingMethod}`（SEA → `BY SEA`）
- 用 `<br>` 换行连接

---

## §6 装配数据源

Form A 装配依赖 `DocumentSetData` 以下区块：

| 区块 | Form A 用途 | 缺失降级 |
|------|------------|---------|
| `shipment` | 运输路线（船名/航次/日期/港口/方式） | 运输路线显示 `—` |
| `order` | 发票号/发票日期 | 降级 `INV-{shipmentNumber}` |
| `customs` | 原产国/目的国 | 原产国降级 `CHINA` |
| `parties.consignee` | 收货人 | 显示 `—` |
| `lines` | 货物行（箱数/品名/毛重） | 空表 |
| `extras.originCriterion` | 第 8 栏原产地标准 | 默认 `P` |

---

## §7 渲染管线

### 7.1 HTML 结构（12 栏官方格式）

```html
<div class="doc-header">
  <h1>GENERALIZED SYSTEM OF PREFERENCES<br>CERTIFICATE OF ORIGIN</h1>
  <div class="subtitle">FORM A · 普惠制原产地证 (Combined declaration and certificate)</div>
  <div class="doc-meta">FA-{shipmentNumber} / 签发国 / 目的国</div>
</div>

<table>
  <!-- 1. Goods consigned from (出口商) + 参考号 -->
  <!-- 2. Goods consigned to (收货人) + 4. For official use -->
  <!-- 3. Means of transport and route -->
</table>

<div class="doc-section">
  <table>
    <thead>
      <tr>
        <th>5. Item No.</th>
        <th>6. Marks & Nos.</th>
        <th>7. No. & kind of packages; description of goods</th>
        <th>8. Origin criterion</th>
        <th>9. Gross weight</th>
        <th>10. No. & date of invoices</th>
      </tr>
    </thead>
    <tbody>{rows}</tbody>
  </table>
</div>

<table>
  <!-- 11. Certification (签证机构证明) -->
  <!-- 12. Declaration by the exporter (出口商声明) -->
</table>
```

### 7.2 货物行特殊渲染

- 第 6 栏唛头：仅首行显示 `shippingMarks(data)`，其余行空
- 第 10 栏发票号：仅首行显示 `invoiceNo + invoiceDate`，其余行空
- 第 8 栏：所有行显示 `extras.originCriterion`（通常 `P`）

---

## §8 后端契约

Form A 无独立后端端点，复用 CertificateOfOrigin 端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/customs/trade-documents` | 创建 CO（type=CertificateOfOrigin） |
| POST | `/api/v1/customs/trade-documents/generate-from-shipment` | 运单生成 CO（types 含 CertificateOfOrigin） |
| GET | `/api/v1/customs/trade-documents/:id/versions` | 版本快照（含 extras.originCriterion） |

---

## §9 前端交互

| 操作 | 触发 | 说明 |
|------|------|------|
| 预览 | 单据中心展开 CO → 预览（切换 Form A 渲染器） | 12 栏格式 HTML |
| 打印/PDF | 预览面板打印按钮 | `printHtmlDocument` 独立窗口 |
| 编辑原产地标准 | 版本快照编辑 `extras.originCriterion` | 修改 P/W/F |

**注意**：当前 DocumentCenter 默认用 CO 渲染器（`TYPE_TO_EXPORT_KIND['CertificateOfOrigin'] = 'CO'`），Form A 需通过独立入口或手动切换渲染器调用。

---

## §10 边界与降级

| 场景 | 降级策略 |
|------|---------|
| 无 documentSet 快照 | 降级字段视图 |
| customs.originCountry 缺失 | 降级 `lines[].originCountry`，再降级 `CHINA` |
| shipment.vesselOrFlight/etd/atd 缺失 | 运输路线省略对应部分 |
| extras.originCriterion 缺失 | 默认 `P` |
| parties.consignee 缺失 | 收货人显示 `—` |
| lines[].grossWeight 缺失 | 显示 `—` |
| 签证机构签章 | 占位 `Place and date, signature and stamp of certifying authority`——需商检局签证 |

---

## §11 权限门禁

| 操作 | 权限 |
|------|------|
| 查看 Form A 快照 | 读（JWT 或 API-Key） |
| 创建/编辑 CO（含 Form A 数据） | 写（JWT） |
| 运单批量生成 CO | 写（JWT） |
| 打印/PDF | 前端纯渲染 |

---

## §12 审计留痕

| 操作 | AuditLog action | detail |
|------|----------------|--------|
| 运单生成 CO（含 Form A 数据） | `TRADE_DOCUMENT_CREATE` | `{ type: 'CertificateOfOrigin', source: 'generate-from-shipment' }` |
| 创建版本 | `DOCUMENT_VERSION_CREATE` | `{ version, changeReason }` |

---

## §13 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | Form A 独立 TradeDocument 类型与编号（FA 前缀） | P1 | §2.3 |
| 2 | DocumentCenter 渲染器切换 UI（CO ↔ FORMA） | P1 | §9 |
| 3 | 原产地标准判定引擎（P/W/F 自动判定） | P2 | §4.2 |
| 4 | 商检局电子签证对接 | P2 | §7.1 |
| 5 | 后向给惠国清单与优惠政策映射 | P3 | §2.1 |

---

## §14 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 打印 HTML 内联样式 | 打印窗口独立上下文——**设计 token 豁免** |
| 12 栏表格 | `.doc-table` 通用样式，纵向对齐 `vertical-align:top` |

---

## §15 交叉链接

1. [单据体系总览](./1-单据体系总览.md) §2 — Form A 在渲染器注册表中的定位
2. [单据体系总览](./1-单据体系总览.md) §7 — DocumentSetData.extras 装配
3. [产地证 CO](./4-产地证CO.md) — Form A 为 CO 的普惠制变体
4. [商业发票 CI](./2-商业发票CI.md) — CI 发票号为 Form A 第 10 栏引用
5. [装箱单 PL](./3-装箱单PL.md) — PL 毛重为 Form A 第 9 栏来源
6. [保险单 INS](./7-保险单INS.md) — 同为给惠国交单配套单据
7. [批量导出](./9-批量导出.md) — Form A 批量打印

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| Form A 渲染器 | [exportDocumentTemplates.ts#L541-L641](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L541-L641) |
| 装配服务（extras.originCriterion） | [documentSetService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/shipping/documentSetService.ts) |
| EXPORT_DOC_RENDERERS 注册表 | [exportDocumentTemplates.ts#L839-L846](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/tools/exportDocs/exportDocumentTemplates.ts#L839-L846) |
| 单据中心 | [DocumentCenter.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/DocumentCenter.tsx) |
