# Pantone 色号库 (Pantone Color Library)

> **REQ2-09** · 痛度 28 · 来源 IND-02 L0 · 批次三 B 级首项
> **甲方场景**：打样单/打色批次目前色号纯手填（如 productColorCode/colorCode 散落各处），无标准色卡参照；业务员拿到客户 Pantone 色号后无法快速对应 RGB 参考与历史打色经验（这个色以前哪些缸打过了、哪些评级过了）。
> **需求池建议**：与 REQ2-01 打色批次同域，建议同期——本模块即挂接 REQ2-01 落地的 SampleColorBatch 体系。

## §1 元信息

| 项 | 值 |
|---|---|
| **模块名** | 色号库 Color Library |
| **定位** | 标准色卡参照库（Pantone TCX seed 起步，开放自定义）——打色批次/打样单选色号即带出 RGB 参考与相近历史打色 |
| **核心实体** | ColorCard（色卡）+ SampleColorBatch.colorCardId 关联 |
| **需求编号** | REQ2-09（批次三 B 级） |
| **验收标准** | 打样单选 Pantone 色号后自动带出 RGB 参考与相近历史打色 |
| **关联代码** | server/src/samples/colorCardService.ts / sampleRoute.ts / schema.prisma ColorCard / SampleColorBatchPanel（登记弹窗色号选择器） |
| **依赖** | REQ2-01 SampleColorBatch 已落地（L3） |

---

## §2 关键设计决策（DR-051）

### DR-051-① 通用色卡建模而非 Pantone 专属表

- ColorCard 用开放 `code` 建模（唯一键）：Pantone TCX（如 `19-4052 TCX`）只是 `source='seed'` 的初始数据；客户自有色卡号可 `source='custom'` 自建——不锁死单一色卡体系（外贸实际：欧美客户给 Pantone TCX，也有品牌给自家色号）
- seed 内置**常用 Pantone TCX 子集**（约 120 色，覆盖常用色系）；数据口径为**公开近似 sRGB 值**，界面与文档显式标注"对色以实物色卡为准"（Pantone 官方精确值属授权数据，近似值是行业通行做法）
- 色卡可维护（增/改/软删）；打色批次冗余快照 `colorCode`——色卡被删/改码后历史记录不失真（与 DunningRecord 快照同哲学）

### DR-051-② 相近色用 Lab ΔE76 而非 RGB 欧氏距离

- RGB 欧氏距离不符合人眼视觉感知（绿色区差异被低估/蓝色区高估）；纺织对色本质是色差感知
- MVP 采用 **RGB→XYZ→Lab 转换 + ΔE76**（欧氏距离 in Lab）：实现简单、无外部依赖、对"相近色推荐"场景精度足够；CIEDE2000 列增强项（若后续 QC 色差评级需要更严感知模型再升级）
- 相近历史打色口径：同色号（exact）∪ ΔE ≤ 15 的色号的历史打色记录（ΔE 10-15 属"明显相近"，纺织人眼可辨但同族）

### DR-051-③ 打色批次挂色号（可选 FK + 快照），登记表单即选择器

- SampleColorBatch 增 `colorCardId?`（可选）+ `colorCode?`（快照）——已有打色数据无色号完全兼容（字段可空）
- 登记弹窗加「色号」搜索选择器（输 code/name 模糊搜）→ 选中即时显示：色块预览 + 色名 + RGB + **相近历史打色面板**（该色号及相近色的历史缸号/评级/疵点原因/客户反馈——"这个色以前 2 号缸 4 级过了"的直接经验参考）
- 打色列表行渲染色号 + 小色块（视觉锚点）

---

## §3 模块边界

| 包含 | 不包含 |
|------|--------|
| 色号库 CRUD + 搜索 + 相近色推荐（Lab ΔE） | CIEDE2000 感知模型（增强） |
| Pantone TCX 常用子集 seed（幂等 upsert） | 全量 2000+ Pantone 色号（授权数据，不内置） |
| 打色批次色号关联 + 相近历史打色查询 | 报价明细行/产品档案色号字段改造（现有手填字段保持，色号库先服务打色域） |
| 登记弹窗色号选择器 + 色块预览 | 色卡图片/实物扫描上传（增强） |

---

## §4 数据模型

```prisma
/// 设计真源：Pantone色号库.md §4（REQ2-09，IND-02）
/// 业务语义：标准色卡参照库（Pantone TCX seed + 客户自定义），打色选色即带 RGB 参考与相近历史。
model ColorCard {
  id        String  @id // 格式：CLR__${shortId}
  code      String  @unique // 色号（"19-4052 TCX" / 客户自定义）
  name      String? // 色名（"Classic Blue"）
  family    String? // 色系（Blue / Red / Yellow / Green / ... 用于筛选）
  r         Int // sRGB 0-255（公开近似值口径）
  g         Int
  b         Int
  source    String  @default("seed") // seed | custom
  deletedAt BigInt?
  createdAt BigInt
  updatedAt BigInt

  @@index([family])
}

// SampleColorBatch 增字段：
  colorCardId String? // 关联色卡（可选 FK）
  colorCode   String? // 冗余快照（色卡变更/删除后历史不失真 DR-051-①）
```

---

## §5 API（挂 /api/v1/samples，与 color-batches 同域）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/colors?search=&family=&limit=` | 色号库列表/搜索（code/name 模糊，未删倒序） |
| GET | `/colors/:code` | 色卡详情 + `nearest`（Lab ΔE 升序 top 8，排除自身） |
| POST | `/colors` | 新增自定义色卡 {code, name?, family?, r, g, b}（写权限） |
| PATCH | `/colors/:id` | 维护（name/family/rgb 可改；code 不可改——被引用稳定性） |
| DELETE | `/colors/:id` | 软删（写权限；历史打色靠 colorCode 快照不失真） |
| GET | `/colors/:code/color-batches?includeNearby=` | 该色号历史打色；includeNearby=true 时并集 ΔE≤15 相近色的打色（含缸号/评级/疵点/客户反馈） |

打色批次登记/更新输入增可选 `colorCardId`（服务端解析落 `colorCode` 快照）。

守卫：读模块守卫；写走 samples 域既有 requireColorBatchWrite 同款角色链（samples:write）。

---

## §6 前端（SampleColorBatchPanel）

- **登记弹窗**加「色号」字段：
  - 搜索下拉：输 code/name → GET /colors?search= 建议列表（色块 + code + name）
  - 选中即时预览：色块 + 色名 + `RGB(r, g, b)` + 相近历史打色计数
  - **相近历史打色面板**：GET /colors/:code/color-batches?includeNearby=true → 历史行（缸号 · 色号 · 评级徽章 · 疵点原因 · 客户反馈状态）——"这个色以前哪些缸过了"经验参考
- **打色列表行**：显示 `colorCode` + 6px 小色块（无色号时显示 —）
- 空态：色号库无匹配时提示"未命中色卡，可直接手填缸号继续登记"（色号可选不强填）

---

## §7 验收标准

| 锚点 | 验证方式 |
|------|---------|
| 打样单选 Pantone 色号后自动带出 RGB 参考与相近历史打色 | API 验收：seed 色号查询 → nearest 返回 ΔE 排序相近色 → 该色号登记打色 → includeNearby 查询命中历史 |
| 相近色推荐感知合理 | Lab ΔE 校验（构造已知色对：正蓝 vs 深蓝 ΔE 小、正蓝 vs 橙 ΔE 大） |

---

## §8 实施记录

- 2026-08-20 落地：ColorCard 模型 + colorCardService（CRUD/搜索/Lab ΔE76 相近色/相近历史打色）+ samples 路由 6 端点 + Pantone TCX 常用子集 seed（120 色，幂等 upsert）+ SampleColorBatch.colorCardId/colorCode 快照 + 登记弹窗色号选择器（搜索建议/色块预览/相近历史打色面板）+ 单测。
