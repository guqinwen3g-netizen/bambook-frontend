# D2 · 报关成交方式 ↔ Incoterms 一致性校验 —— 定向现状核准（2026-09-16）

> 矩阵原文：`H13 报关成交方式应与 Incoterms 一致，现状无校验`。
> 本文只做核准 + 设计建议，**未动代码**。

## 一、核准结论：不只是"无校验"，而是**制单时静默取其一**

### 1. 两侧字段名都不同（结构上就注定对不上）

| 侧 | 字段 | 模型 | 真库值 |
|---|---|---|---|
| 订单（业务真源） | **`Order.deliveryTerms`** | `schema.prisma` Order 模型 | `FOB` |
| 报关单（申报数据） | **`CustomsDeclaration.tradeTerms`** | `schema.prisma:5669` | `FOB` |

`Incoterms` 另有字典（`DataDictionary code='incoterms'`，`schema.prisma:6139` 注明
`FOB / CIF / EXW / FCA / CPT / CIP / DAP / DPU / DDP`），但**订单/报关单都没有引用字典做约束**，
都是自由文本 `String?`。

### 2. 全仓**零比较** —— 但有两处**静默取其一**

`deliveryTerms` 的非测试消费点共 6 处（已逐条核对），**没有任何一处比较过两者是否一致**。
其中**两处会静默取其一**，后果比"不校验"严重：

| 位置 | 现状代码 | 后果 |
|---|---|---|
| `server/src/shipping/documentSetService.ts:361` | `const incoTerms = first(str(order?.deliveryTerms), str(customsDecl?.tradeTerms))` | **取订单的，没有才取报关的** |
| `server/src/templates/docTemplates/customsDocs.ts:104` | `data.order?.deliveryTerms \|\| data.customs?.tradeTerms \|\| 'FOB SHANGHAI'` | 同上 |

**这意味着**：若订单写 `CIF`、报关单写 `FOB`，**系统会静默用 CIF 去出全套单据**，
而报关单上明明印着 FOB —— **两套单据互相矛盾，且没有任何地方会提示**。

⚠️ 这与本仓在**对账域**已经确立的原则**相反**：`reconciliationService.ts:8-10` 明确写了
「币种双源……两者不一致时记 `currency_mismatch` 差异，**不静默取其一**」。
**报关成交方式这里恰恰就是"静默取其一"。**

### 3. 真库现状（演练数据）

48 张报关单 `tradeTerms` **全是 `FOB`**；订单 `deliveryTerms` 也是 `FOB` → **当前数据一致**，
所以问题还没暴露。**但这只是演练数据的规整，不是机制上的保障。**

## 二、矩阵 D2 拍板（已定，勿再改）

> **本轮只升 FOB + CIF 为枚举**（CFR 随 CIF），其余归 `Other` 只存不驱动；
> **四项行为全部驱动**：运输责任划分 / 单据套要求 / **报关一致性校验** / 费用归集口径。

即：**一致性校验是 D2 拍板的四项之一**，本批只做这一项（其余三项分别落在 H12 运输责任、
单据套、以及 T2 ❓1 的费用口径切换）。

## 三、设计建议（待你点头后实施）

### ① 新增只读核对（与 T7-2/T7-3 并列，进「核对工作台」）

新建 `server/src/customs/incotermConsistency.ts`（纯只读，风格对齐 T7-2 的三单一致）：

```
GET /api/v2/customs/declarations/:id/incoterm-consistency
```

返回：订单 `deliveryTerms` vs 报关 `tradeTerms` 的比对结论 + 差异项
（`severity` 恒 `'warning'` —— 沿用 T7 系列"只预警不阻断"的统一口径）。

**归一化匹配**（吸取 T7-4 的教训）：两侧都做 `trim().toUpperCase()`；
且按 D2 拍板把 **`CFR` 归到 `CIF` 类**、其余非 FOB/CIF 归 `Other` 后再比 ——
即「FOB vs FOB」「CIF/CFR vs CIF/CFR」算一致，「FOB vs CIF」才是真差异。

### ② 修掉两处「静默取其一」

`documentSetService.ts:361` 与 `customsDocs.ts:104` 改为：
- 两者**一致** → 用该值（行为不变）；
- 两者**不一致** → **不静默**：用订单值出单据，但在返回结构里带上
  `incotermMismatch: { orderTerms, declarationTerms }`，让调用方/UI 能显示提示
  （对齐对账域"不静默取其一"原则）。

### ③ 写入时提醒（可选，建议做）

报关单创建/更新时（`customsService.createCustomsDeclaration` / update）比对订单
`deliveryTerms`：不一致则**在响应里带 warning**（不阻断 —— 与 T7 口径一致；
且**允许多次报关的分批场景下成交方式可能合理不同**，阻断会卡死业务）。

## 四、❓ 待你确认

1. **口径**：一致的定义按 §三① 的「FOB / CIF(含CFR) / Other 三档比」对吗？
   还是要求**逐字相等**（`CFR` 与 `CIF` 也算不一致）？
2. **强度**：只预警（推荐，沿用 T7 口径）还是写入时阻断？
3. **静默取其一的修法**：按 §三② 改为"用订单值 + 标记差异"对吗？
   还是应该反过来（**报关单是申报数据，以它为准**）？—— 这条我需要你的业务判断：
   **出单据时以订单条款为准，还是以报关单条款为准？**
4. 要不要顺带把 `deliveryTerms` / `tradeTerms` 的**取值收敛到 `incoterms` 字典**
   （现在两侧都是自由文本，字典存在但没约束）？这属于数据治理，可单开一批。
