# D2 完成回报 · 报关成交方式 ↔ 订单 Incoterms 一致性校验（2026-09-16）

按 `docs/D2-报关成交方式与Incoterms校验-现状核准-2026-09-16.md` 实施。
口径由业务方授权**按行业专业判断**定（原话：「按照你选择的这种行业经验和专业的为准」）。

## 一、我定的四条口径（请追认）

| # | 问题 | 判断 | 理由 |
|---|---|---|---|
| 1 | **出单据以哪侧为准** | **订单条款为准** | 订单/合同上的 Incoterms 是与客户谈定的**商业合同依据**；报关单的成交方式是**向海关申报**的数据，申报必须与合同一致 ⇒ **不一致说明报关申报有问题，该纠正的是报关单**（申报不实有法律风险），不是反过来改商业单据 |
| 2 | 一致的定义 | **逐字归一化比 + 分组区分严重程度** | `CFR` ≠ `CIF`（保险责任确实不同），不能一概等同；但按矩阵 D2「CFR 随 CIF」给出 FOB / CIF / OTHER 三组，**跨组差异 > 同组细分差异**，提示语分开 |
| 3 | 强度 | **只预警不阻断** | 沿用 T7 系列统一口径；且分批报关时成交方式可能合理不同，阻断会卡死业务 |
| 4 | 是否收敛到 `incoterms` 字典 | **本批不做** | 属数据治理（要迁移 + 存量清洗 + 前端改下拉），与本批正交，列为后续 |

## 二、改了什么（file:line）

| 位置 | 改动 |
|---|---|
| `server/src/_shared/incoterm.ts`（新建） | 成交方式解析的**单一真源**：`normIncoterm` / `KNOWN_INCOTERMS` / `extractIncotermCode`（`FOB SHANGHAI` → `FOB`）/ `sameIncoterm` |
| `server/src/customs/incotermConsistency.ts`（新建） | 只读核对服务 `checkIncotermConsistency`：订单锚（直挂 `orderId` → 经运单回退）；分组；差异 3 类（`incoterm_mismatch` / `incoterm_missing`）；**severity 恒 `'warning'`**（类型即字面量） |
| `server/src/customs/customsRouteV2.ts:470-486` | 新端点 `GET /api/v2/customs/declarations/:id/incoterm-consistency`（`customs:read`；不存在 → 404） |
| `server/src/shipping/documentSetService.ts:360-378` | **修掉静默取其一**：改为按共享模块比对；不一致时**报进既有的 `missing[]` 告警**（单据仍按订单条款出）——对齐对账域「不静默取其一」原则 |
| `server/src/templates/docTemplates/customsDocs.ts:103-108` | 行为不变（本就取订单值），补注释写明口径与告警出处 |
| `server/src/customs/__tests__/incotermConsistency.test.ts`（新建） | **15 例** |
| `server/src/shipping/__tests__/documentSetService.test.ts` | 新增 1 例：订单 `FOB SHANGHAI` / 报关 `CIF` → `missing` 报出告警 |

## 三、⭐ 测试 fixture 暴露了我的一个**真错误**（本批最有价值的修正）

我最初写的比对是"两侧归一化后逐字比"。跑到 `documentSetService` 的既有用例时它红了——
一看 fixture 才发现：

```
订单  Order.deliveryTerms = 'FOB SHANGHAI'   ← 合同写法，带装运港
报关  CustomsDeclaration.tradeTerms = 'FOB'  ← 海关「成交方式」栏，只填代码
```

**这是同一个成交方式**——报关单的成交方式栏本来就不含地点（本仓 `customsDocs.ts` 的默认值
也是 `'FOB SHANGHAI'`）。**我原来的比对会把所有带港口的订单全部误报。**

修正：新增 `extractIncotermCode()`，从订单条款里**提取成交方式代码**再比
（`FOB SHANGHAI` → `FOB`、`CIF SURABAYA` → `CIF`；认不出的写法原样返回，不静默吞掉）。
并加两条钉：① `FOB SHANGHAI` ≡ `FOB` 视为一致；② `CIF SURABAYA` vs `FOB` **仍是跨组不一致**
（提取代码不得掩盖真差异，且原文会出现在提示里）。

**这次是既有测试救了我**——`FOB SHANGHAI` 这个真实写法是 fixture 里本来就有的，
不是我想出来的。

## 四、证伪（改回旧行为必须转红）

| # | 旧行为回退 | 转红用例 |
|---|---|---|
| 1 | 不区分跨组/同组（`crossGroup` 恒 true） | 「同组细分差异（CFR vs CIF）提示是否含保险」1 例 |
| 2 | `expected`/`actual` 互换（改成以报关为准） | 「跨组不一致（订单 CIF / 报关 FOB）」1 例 |
| 3 | `sameIncoterm` 改回逐字比（不做代码提取） | `documentSetService` 既有用例「完整装配」（`FOB SHANGHAI` vs `FOB` 被判不一致）1 例 |

三处均先转红、恢复后复绿；`grep 证伪` 无残留。

## 五、门禁数据

- **服务端 `tsc --noEmit`：0 错**（本批无前端改动）。
- **服务端定向（`src/customs` + `src/shipping` + `src/_shared`）：26 文件 / 377 例**
  —— 跑出一例 `tradeDocumentDownloadGate` 失败，**隔离复跑 5 例全绿** ⇒
  `vitest.config.ts` 2026-08-19 已登记的并发抖动，非本批引入。
- **后端已重启核对**：`50177` → `62948`，`/api/health` 200。
- **真库只读验收** `scripts/acceptance-d2-incoterm-consistency.mjs`：**13 通过 / 0 失败 / 1 需知会**。
  - R1 结构完整 ✓；R2 差异恒 warning ✓；R3 `consistent` ⟺ 零差异 ✓；R5 404 ✓；
  - **R4 归一化未误报**：真库 10/10 判为一致（订单 `FOB` / 报关 `FOB`）
    —— 这条最关键，它证明我新加的代码提取**没有把本该一致的判成不一致**。

## 六、❓ 未决

1. **请追认 §一 的四条口径**（尤其「订单条款为准」——这是业务判断，我是按行业实务推的）。
2. **真库全是 FOB，跨组/同组差异分支未被真实数据覆盖**（只由单测钉住）。
   要真库覆盖需造「订单 CIF + 报关 FOB」的样本，属造数，未擅自做。
3. **写入时提醒**（设计建议 §三③）本批**未做**：即在报关单创建/更新时就提示不一致。
   现在只在「制单时告警 + 只读核对端点」两处暴露。要不要补写入时提示？
4. **`incoterms` 字典收敛**（数据治理）未做，已列为后续。
5. **前端挂载点**：D2 核对端点也没 UI。与 T7-2/3/4 一样，建议统一进「核对工作台」。
