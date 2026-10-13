# Tech Pack 结构化解析 (Tech Pack Parsing)

> **REQ2-18** · 痛度 22 · 来源 IND-09 L0 · 批次四 C 级 · 成本 M-L（成衣线优先，面料线弱）
> **甲方场景**：客户发来成衣 Tech Pack（规格书 PDF：款号/尺码表/颜色/数量/成分/交期）→ 上传解析 → 结构化预览 → 字段回填订单。当前：手工照着 PDF 逐字段录入。
> **验收标准**：IND-09——规格书上传 → 结构化解析 → 字段回填订单。

## §1 元信息

| 项 | 值 |
|---|---|
| **模块名** | Tech Pack 解析 Tech Pack Parsing |
| **定位** | 订单详情内嵌：上传规格书 PDF（文本层）→ 规则解析结构化快照 → 预览确认 → 选择性回填订单字段 |
| **核心实体** | Order.techPack Json（解析快照）+ Order.techPackFileName（附件名）——零新表 |
| **需求编号** | REQ2-18（批次四 C 级） |
| **关联代码** | server/src/orders/techPackParser.ts / routeV2.ts techpack 端点 / OrderManager 订单详情 TechPackPanel（Garment） |
| **依赖** | import 域 extractPdfText（pdf-parse v2）；qc 域 diskStorage 上传范式（孤儿清理/回读） |

## §2 关键设计决策（DR-059）

### DR-059-① 解析 = 规则引擎提取六类字段（复用 PO 导入三段管线，不依赖 OCR）

- 管线：上传 PDF → `extractPdfText`（import 域既有）→ `parseTechPackText(text)` 纯函数规则引擎（正则 + 表格行扫描）
- 六类字段 + 逐字段置信度（high=模式直接命中 / low=推断 / absent=未检出）：
  - styleNo（STYLE NO/款号 附近编码）、season、fabricComposition（`N% FIBER` 多组聚合）、
    colors（COLOR(S)(WAY) 后词 + 常见色词）、sizeBreakdown（SIZE 表头 + S/M/L/XL 或数字尺码行 → size→qty 映射 + totalQty=Σ）、deliveryDate（DELIVERY 附近日期，多格式归一 YYYY-MM-DD）
- **图片型 PDF fail-fast**：文本层 < 50 字符 → 明示"扫描件需 OCR"（OCR 服务选型另议，REQ2-21 同源约束），不静默给空结果
- 解析器纯函数可单测（不碰 DB）——与 detectCustomer 同范式；多客户格式差异靠通用模式 + 置信度呈现，不做 per-customer parser（Tech Pack 无固定格式惯例）

### DR-059-② 回填 = 预览→确认两段式，字段映射显式且不盲写

- POST /:id/techpack/parse（multipart PDF 上传）：文件落盘 uploads/techpacks/{orderId}/ + 返回解析结果（**不落库不回填**）
- POST /:id/techpack（保存）：body 携带 parsed 快照 + `apply` 显式勾选的回填字段集（前端预览界面勾选）：
  - styleNo → Order.product（勾选且现值为空时建议默认勾）；totalQty → quantity；deliveryDate → dueDate；
    fabricComposition → fabricContent；colors（单色）→ productColorCode；sizeBreakdown/colors 全量 → Order.techPack 快照
  - **不盲写**：apply 只含用户勾选字段；已有值覆盖在 UI 明示（"将覆盖现值 X"）
- Order.techPack 覆盖式更新（单快照）+ 每次保存审计留痕（techpack_save 含 before/after）——历史经审计可溯
- 文件回读：GET /:id/techpack/file → res.download（查 Order.techPackFileName 拼路径）

### DR-059-③ 挂订单域内嵌面板（成衣线优先）

- 端点挂 /api/v2/orders/:id/techpack*（orders routeV2 扩展，multer diskStorage 落盘 + 10MB + 仅 PDF）
- UI：OrderManager 订单详情「Tech Pack 规格」区块——**仅 Garment 类型显示**（需求池明示成衣线优先面料线弱；面料/其他类型列增强）
- 前端预览呈现六类字段 + 置信度徽章 + 回填勾选（现值并排对照）

## §3 API 合约（守卫：requireWrite + requirePermission('orders:write')）

| 端点 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `/:id/techpack/parse` | POST | multipart `file`（PDF ≤10MB） | `{ parsed: TechPackSnapshot, fileName, filePath }`（不落库） |
| `/:id/techpack` | POST | `{ parsed, fileName?, apply?: { product?, quantity?, dueDate?, fabricContent?, productColorCode? } }` | `{ order, applied }` |
| `/:id/techpack` | GET | — | `{ techPack, techPackFileName }`（现快照） |
| `/:id/techpack/file` | GET | — | 文件流（download） |

错误码：`VALIDATION_FAILED`(400) / `NOT_FOUND`(404) / `UNSUPPORTED_FILE_TYPE`(400) / `NO_TEXT_LAYER`(422 扫描件)。

TechPackSnapshot：
```ts
{ styleNo?, season?, fabricComposition?: [{pct, fiber}], colors?: string[],
  sizeBreakdown?: Record<size, qty>, totalQty?, deliveryDate?,
  confidence: Record<field, 'high'|'low'|'absent'>, pages, textLength, uploadedAt }
```

## §4 增强项（不阻塞验收）

- OCR 服务接入（图片型 PDF——与 REQ2-21 名片 OCR 同一选型决策）
- OrderLine 级回填（size×color 展开行）；多规格书版本对比
- per-customer Tech Pack 模板学习（registry 模式，格式固化客户积累后）

## §5 验收锚点（scripts/acceptance-req2-18.mjs）

1. 造 Garment 订单 → 上传含六类字段的文本型 PDF（脚本动态生成 PDF 文本层——用最小 PDF 结构或走纯文本粘贴通道？无——用 pdf-lib？无依赖。**改用粘贴文本通道**：parse 端点支持 `{ text }` JSON body（与 multipart 二选一，纯文本规格书同样真实场景——邮件正文粘贴））
2. 解析：六类字段全部命中 + 置信度正确（sizeBreakdown S/M/L qty 求和 = totalQty；成分 65/35 聚合）
3. 保存 + apply 全勾 → 订单字段回填（product/quantity/dueDate/fabricContent）+ techPack 快照落库 + 审计
4. 空文本 → 422 NO_TEXT_LAYER；非 PDF multipart → 400；sales 无 orders:write → 403
5. GET 快照回读一致；重复保存覆盖 + 审计 before/after
