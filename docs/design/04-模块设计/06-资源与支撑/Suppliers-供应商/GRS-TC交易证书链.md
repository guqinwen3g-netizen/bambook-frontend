# GRS TC 交易证书链 (GRS Transaction Certificate Chain)

> **REQ2-06** · 痛度 33（第二轮需求池批次二 A 级）· 来源 IND-04 缺口（TC 链 L0）
> **甲方场景**：再生涤纶业务（演示库绍兴绿环即 GRS 供应商）出口欧盟必须 TC 链完整：原料 TC→工厂 TC→我方 TC，缺链=无法清关。

## §1 元信息

| 项 | 值 |
|---|---|
| **模块名** | GRS TC 交易证书链 TcCertificate |
| **定位** | GRS 订单合规交易证书链——三段 TC 登记（原料/工厂/我方）→ 链完整性校验 → 吨位勾稽（上游≥下游 + TC vs 订单用量）→ 出货前一键校验 |
| **核心实体** | TcCertificate（TC 交易证书，三段 stage） |
| **需求编号** | REQ2-06（批次二 A 级） |
| **验收标准** | GRS 订单出货门禁前可一键校验 TC 链完整性；认证管理 Tab（L2）内可追溯整链 |
| **关联代码** | server/src/suppliers/tcCertificateService.ts / factoryRoute.ts / `schema.prisma` TcCertificate / TcChainPanel.tsx + SuppliersManager 认证 Tab |
| **依赖** | 认证管理台账既有（FactoryCertification L2，纯扩展）；供应商 Relation 快照范式 |

---

## §2 关键设计决策（DR-048）

### DR-048-① TC 与资质认证分轨：交易证书 ≠ 资质认证

```
FactoryCertification（既有 L2）        TcCertificate（本模块新增）
┌──────────────────────┐              ┌──────────────────────┐
│ 资质认证（BSCI/GRS/    │              │ 交易证书（每票交易一张）│
│ OEKO-TEX…）           │              │ 三段链挂订单 + 交易对手 │
│ 工厂维度·年度有效       │              │ 吨位勾稽·清关证据      │
│ 预警=到期扫描          │              │ 预警=缺链/吨位不足     │
└──────────────────────┘              └──────────────────────┘
```

- 资质认证回答「这家工厂有没有 GRS 资质」；TC 回答「这一票货的再生成分链条是否闭环」——两轨不合并
- TC 挂**订单 + 交易对手 Relation**（快照范式），不挂 FactoryProfile（TC 的出具方可能是贸易商而非工厂）

### DR-048-② 三段链建模：stage 枚举 + 吨位勾稽（不做逐张 parent 拓扑）

- 三段：`material_input` 原料 TC（上游→工厂）/ `factory_output` 工厂 TC（工厂→我方）/ `our_sale` 我方 TC（我方→客户）
- 勾稽按**段位聚合**而非逐张链（Σ material ≥ Σ factory ≥ Σ our_sale，含加工损耗合理性）——GRS 实务中一张原料 TC 可分批对应多张工厂 TC，逐张拓扑对 MVP 过度
- `parentTcId` 可选自关联保留（未来增强逐张追溯），校验不依赖

### DR-048-③ 校验口径（一键校验端点返回结构）

| 检查项 | 规则 | 结果字段 |
|--------|------|---------|
| 链完整性 | 三段各 ≥1 张 | `missingStages[]`（空=完整） |
| 段间吨位 | Σ material ≥ Σ factory ≥ Σ our_sale | `tonnageWarnings[]`（上游<下游即预警） |
| 订单用量 | Σ our_sale.quantityKg vs 订单 unit=KG 行 Σ quantity | TC < 订单用量 → 预警（非 KG 行跳过标注） |
| 有效期 | 各 TC validUntil ≥ 今天 | `expiredTc[]` |

- 校验只读无副作用（纯聚合），出货门禁**消费方**调用（本 MVP 提供端点+UI，不硬接 shipment-eligibility——那是既有三条件门禁，避免越界耦合）

---

## §3 模块边界

| 包含 | 不包含 |
|------|--------|
| TC 登记（三段/证书号/吨位/有效期/对手方） | 资质认证 CRUD（FactoryCertification 既有） |
| 订单维度链视图 + 一键校验（缺链/勾稽/过期） | 出运资格硬门禁改造（既有三条件不渗透） |
| 供应商维度 TC 追溯（认证 Tab 内） | TC PDF 附件上传（attachmentPath 预留，后续接 uploads） |
| 软删/修正（吨位与证书号可改，tcNo 唯一） | TC 在线申请/签发（线下实务，系统只登记） |

---

## §4 数据模型

```prisma
/// 设计真源：GRS-TC交易证书链.md §4（REQ2-06，IND-04 TC 链缺口补齐）
/// 业务语义：GRS 订单交易证书三段链（原料→工厂→我方），缺链=无法清关。
/// 与 FactoryCertification（资质认证）分轨（DR-048-①）。
model TcCertificate {
  id  String @id // 格式：TCC__${shortId}
  tcNo String @unique // 证书编号（TC No.，如 TC-2026-08123）

  orderId    String // 挂订单（GRS 订单）
  relationId String? // 交易对手（出具方/接收方，跨模块 snapshot FK → Relation）
  relationName String? // 冗余快照

  // ─── 三段链（DR-048-②） ───
  stage String // material_input(原料TC) | factory_output(工厂TC) | our_sale(我方TC)

  // ─── 吨位与效期 ───
  quantityKg Decimal @db.Decimal(18, 3) // 吨位（公斤，GRS TC 计量单位）
  issuedAt   String? // 签发日 YYYY-MM-DD
  validUntil String? // 有效期至（null = 长期）

  attachmentPath String? // 证书 PDF（预留）
  notes          String?

  // ─── 可选链上游（增强预留，校验不依赖 DR-048-②） ───
  parentTcId String?

  createdAt BigInt
  updatedAt BigInt
  deletedAt BigInt?

  @@index([orderId])
  @@index([relationId])
  @@index([stage])
}
```

---

## §5 API（挂 /api/v1/suppliers，字面路由在 /:id 之前）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tc-certificates` | 登记 TC {orderId, stage, tcNo, quantityKg, relationId?, issuedAt?, validUntil?, notes?} |
| GET | `/tc-certificates?orderId=\|relationId=` | 链视图（按 stage 分组 + 段位吨位聚合） |
| GET | `/tc-certificates/verify?orderId=` | **一键校验**（DR-048-③ 四检查项 → verdict: complete/warning） |
| PATCH | `/tc-certificates/:tcId` | 修正（吨位/效期/备注白名单） |
| DELETE | `/tc-certificates/:tcId` | 软删 |

守卫：suppliers 域既有（createModuleAuthGuard + requireJwtForWrite 写）。

---

## §6 前端

- **TcChainPanel 挂订单详情**（Fabric 类型，与色差/工序链并列）：
  - 三段泳道视图（原料/工厂/我方 TC 卡：证书号+吨位+对手方+效期徽章）
  - 「一键校验」按钮 → verify 结果面板（missingStages 红标 / 吨位预警黄标 / verdict 徽章）
  - 登记 BottomSheet（三段 chips + 吨位 + 证书号 + 对手方下拉）
- **SuppliersManager 认证管理 Tab**：追加「TC 交易证书」区块（按当前工厂 Relation 查询 TC 列表——认证 Tab 内追溯整链，验收锚点②）

---

## §7 验收标准（对应需求池）

| 锚点 | 验证方式 |
|------|---------|
| GRS 订单出货门禁前一键校验链完整性 | GET verify?orderId=：三段齐 → missingStages=[] complete；缺段 → 列出缺段 |
| 认证管理 Tab 内可追溯整链 | GET ?relationId= 供应商维度 TC 列表（认证 Tab 区块） |
| TC 吨位 < 订单用量预警（增强） | verify 的 orderUsage 检查：Σ our_sale < Σ KG 行 quantity → warning |

---

## §8 实施记录

- 2026-08-20 落地（MVP）：TcCertificate 模型 + tcCertificateService（登记/链视图/一键校验四检查项/软删）+ factoryRoute 5 端点 + TcChainPanel 订单详情内嵌 + SuppliersManager 认证 Tab TC 区块 + 单测。
