---
title: 服装厂现金流管理（Garment Factory Cash Flow Management）
category: suppliers
tags: [现金流, 应收账款, 账期管理, 旺季资金, 资金管理, 财务风控]
sourceType: curated
status: stable
---

# 服装厂现金流管理（Garment Factory Cash Flow Management）

服装厂的死法大多是**有利润、没现金**：面料要现金、工资要月结、客户账期 60-90 天——**资金三角（应收+库存-应付）失控=资金链断裂**。现金流管理是厂长的一号工程。

## 一、资金三角结构

```
现金流出：面料款（发货前付清）→ 工资（月结）→ 加工费/杂费
现金流入：客户货款（出货后 30-90 天）
缺口期 = 生产周期 + 账期 ≈ 90-150 天
```

- **旺季放大**：8-10 月出货高峰前 2 个月是资金最紧时点（面辅料集中采购+赶工工资——见 `trade-process/annual-sourcing-calendar.md`）；
- **经验值**：月产值 500 万工厂，旺季资金峰值需求 ≈ 月产值 × 2.5-3 倍。

## 二、应收账款管理

| 措施 | 要点 |
|:---|:---|
| 定金纪律 | 新客户 30% 定金（见 `suppliers/order-review-acceptance.md`）——免定金单=自担全链资金 |
| 账期分层 | A 类客户（优质）OA 60 天可接受；C 类客户款到发货 |
| 账龄周报 | 30/60/90 天账龄表（超期即停货催收——见 `trade-process/customer-credit-investigation.md`） |
| 保理/信保 | 大客户应收保理变现（见 `trade-process/trade-finance-tools.md`）；信用保险覆盖坏账（见 `trade-process/export-credit-insurance.md`） |
| 汇率锁定 | 美元应收远期结汇（回款日匹配——见 `trade-process/foreign-exchange-settlement.md`） |

## 三、应付与库存优化

- **面料账期**：与面料商谈月结 30 天（用订单稳定性换——见 `suppliers/supplier-relationship-negotiation.md`）；现货面料现金价低 2-3%（权衡）；
- **库存压缩**：库存=凝固的现金（面料备库上限+成衣零库存发货——见 `fabric/fabric-inventory-stock-strategy.md`）；
- **裁床利用率**：每提升 1% 利用率=释放面料现金（见 `suppliers/cutting-room-management.md`）；
- **尾货快变现**：库存决策 3 个月内（见 `suppliers/garment-stock-lot-disposal.md`）。

## 四、融资工具箱

| 工具 | 成本 | 适用 |
|:---|:---|:---|
| 银行流贷 | 年化 3-5%（抵押/担保） | 基础盘（房产抵押常见） |
| 出口保理/押汇 | 年化 4-7% | 外贸应收变现 |
| 订单融资 | 年化 6-10% | 大客户订单（凭 PO 融资） |
| 供应链票据 | 贴现 3-6% | 核心企业确权票据 |
| 政府贴息 | 出口信用贷/中小微专项 | 关注地方政策窗口 |

- **红线**：民间借贷/网贷过桥（年化 15%+——吞噬全部毛利，见 `trade-process/trade-finance-tools.md` 工具选择）。

## 五、现金预测与预警

1. **13 周滚动现金流预测**：逐周流入/流出表（每周更新——制造业标准工具）；
2. **预警线**：现金余额 < 下月刚性支出（工资+房租+税费）× 1.5 → 启动压缩（催收/延付/融资）；
3. **大单沙盘**：接大单前做资金沙盘（订单评审纳入资金维度——见 `suppliers/order-review-acceptance.md`）；
4. **老板备付**：旺季前预留应急额度（授信不用>缺钱求贷）。

## 六、常见死法与对策

| 死法 | 对策 |
|:---|:---|
| 大客户拖款拖死 | 集中度控制+信保+逾期停货勇气 |
| 盲目扩产压死 | 扩产资金用长期资金（不用流贷买设备——期限错配） |
| 库存捂死 | 快变现纪律（尾货 3 个月出清） |
| 担保连累死 | 不对外担保（互保圈爆雷是集群工厂团灭主因） |
| 旺季原料挤死 | 面料锁价分批付款（见 `fabric/fabric-inventory-stock-strategy.md`） |

## 七、相关文档

- 贸易融资工具：见 `trade-process/trade-finance-tools.md`
- 订单评审：见 `suppliers/order-review-acceptance.md`
- 成本分析：见 `suppliers/supplier-cost-analysis.md`
- 工厂 KPI：见 `suppliers/factory-kpi-performance.md`
- 贸易公司运营：见 `trade-process/trading-company-operations.md`
