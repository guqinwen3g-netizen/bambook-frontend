---
title: 订单评审与接单决策（Order Review & Acceptance Decision）
category: suppliers
tags: [订单评审, 接单决策, 利润测算, 风险评估, 产能匹配, 接单标准]
sourceType: curated
status: stable
---

# 订单评审与接单决策（Order Review & Acceptance Decision）

**接单是工厂最大的经营决策**——接错单（做不了/不赚钱/收不到款）比没单更伤。订单评审 = 工艺能力 + 利润测算 + 交期可行性 + 资金风险的四维过滤，评审记录是后续扯皮的唯一依据。

## 一、四维评审框架

| 维度 | 评审要点 | 否决项（红线） |
|:---|:---|:---|
| 工艺能力 | 设备/工艺匹配（无缝/剖缝等特殊工艺）、版房能力、面辅料可得性 | 无关键设备且无可靠外发（见 `suppliers/subcontracting-outsourcing-management.md`） |
| 利润 | 目标毛利率（覆盖变动成本+分摊+风险金） | 毛利 <10% 且无战略价值（新客户首单除外） |
| 交期 | 面辅料周期+生产周期+验货出运倒排 | 倒排不足且客户不让步（硬接=空运赔本） |
| 资金 | 付款方式/客户信用/定金比例 | 新客户无定金+OA 60 天+无信用保险（见 `trade-process/export-credit-insurance.md`） |

## 二、利润测算（接单前算清）

- **成本底数**：面辅料实价（打样确认后核价）+ 工费（IE 工时×工价——见 `suppliers/garment-ie-engineering.md`）+ 包装运输 + 验货/认证摊销 + 出口费用（见 `garments/garment-costing-pricing.md`）；
- **隐性成本计入**：
  - 验货不通过翻箱/重验费（按概率计提 0.5-1%）；
  - chargeback/扣款（大卖场单 2-5%——见 `customers-market/big-box-retail-channel.md`）；
  - 汇率波动（报价到收款周期×波动率——见 `trade-process/foreign-exchange-settlement.md`）；
  - 索赔风险金（按客户历史 claim 率计提——见 `trade-process/claims-handling.md`）；
- **盈亏平衡点**：开机率联动（淡季保本单可接——摊薄固定成本，见 `suppliers/supplier-cost-analysis.md`）。

## 三、交期评审（倒排表）

```
验货出运日 ← 生产周期（IE 标准工时×数量÷有效产能）← 面辅料到厂日 ← 采购周期（面料 20-45 天）
```

- **面辅料周期是第一瓶颈**（占 60% 交期）：面料染色/印花周期确认（见 `suppliers/dyeing-mill-cooperation-management.md`）；
- **产能冲突检查**：现有订单排产叠加（见 `suppliers/production-capacity-scheduling.md`）——超载 20% 以上的月份直接谈判交期；
- **客户确认周期计入**：产前样/船样确认耗时（PPS 轮次——见 `suppliers/pp-sample-pre-production-meeting.md`）。

## 四、风险评审

- **新客户**：信用调查（见 `trade-process/customer-credit-investigation.md`）+ 定金 ≥30% + 首单规模控制；
- **设计侵权风险**：客户提供花型/logo 的授权审查（见 `trade-compliance/ip-brand-authorization.md`）；
- **合规风险**：目的国准入（认证/标签——见 `trade-compliance/market-access.md`）、制裁筛查（见 `trade-compliance/sanctions-screening-compliance.md`）；
- **技术风险**：新面料/新工艺首单（小批量试产验证——不经试产直接大货=赌）；
- **集中度风险**：该客户订单占比（单客户 >30% 预警——产能被绑架）。

## 五、评审流程与留档

1. **发起**：业务填《订单评审表》（工艺/数量/交期/价格/付款）；
2. **会签**：版房（工艺可行性）→ IE/生产（工时产能）→ 采购（面辅料周期价格）→ 财务（利润资金）→ 品控（质量要求可达性）；
3. **决策**：厂长/总经理签批（否决项触发即拒或重谈）；
4. **留档**：评审表+报价单+客户确认邮件归档（合同附件——后续变更/索赔的基准证据，见 `trade-process/trade-contract-terms.md`）。

## 六、拒单与谈判话术

- **拒单不失客户**：给替代方案（调整交期/简化工艺/换面料）——"这个价位做原版会害了你的品质口碑"；
- **让步边界**：价格让步 ≤5%（超过则换方案不换价格）；交期让步靠加班/外发要有成本对冲；
- **复盘**：拒单记录季度复盘（丢单原因分布→能力/报价短板改进）。

## 七、相关文档

- 成本核算：见 `garments/garment-costing-pricing.md`
- 报价流程：见 `trade-process/inquiry-and-quotation.md`
- 产能排产：见 `suppliers/production-capacity-scheduling.md`
- 客户信用：见 `trade-process/customer-credit-investigation.md`
- 产前管理：见 `suppliers/pp-sample-pre-production-meeting.md`
