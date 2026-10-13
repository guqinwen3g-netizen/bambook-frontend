---
title: 订单交付KPI与交期管理（Order Delivery KPI & OTD Management）
category: trade-process
tags: [交付KPI, OTD, 准时交付率, 交期管理, 订单绩效]
sourceType: curated
status: stable
---

# 订单交付KPI与交期管理（Order Delivery KPI & OTD Management）

**OTD（On-Time Delivery 准时交付率）是外贸的生命线指标**：品牌商把供应商 OTD 纳入考核（连续低于阈值=降级/淘汰）。

## 一、核心 KPI 体系

| KPI | 计算 | 目标 |
|:---|:---|:---|
| 准时交付率（OTD） | 准时交付订单数 ÷ 总订单数 | 95%+ |
| 平均延误天数 | 延误订单的延误天数均值 | <3 天 |
| 订单确认周期 | 接单→确认交期的时长 | 越短越好 |
| 样品一次通过率 | 首样确认 ÷ 总送样 | 70%+ |
| 验货一次通过率 | 首次验货通过 ÷ 总验货 | 90%+ |
| 客诉率 | 客诉订单 ÷ 总订单 | <2% |
| 完美订单率 | 准时+足量+无质量问题 | 综合指标 |

## 二、交期构成与压缩

### 交期拆解（以 75 天订单为例）
```
面料采购 20 天 → 辅料 15 天（并行）→ 裁剪缝制 20 天 → 后整包装 5 天 → 验货 3 天 → 物流 7 天 = 55-70 天
```

### 压缩路径
| 环节 | 压缩方法 |
|:---|:---|
| 面料 | 现货面料/常备坯布（见 `fabric/fabric-inventory-stock-strategy.md`） |
| 辅料 | 标准辅料常备库存 |
| 生产 | 精益单件流（见 `suppliers/garment-factory-lean-production.md`） |
| 物流 | 快船/空运（成本换时间） |
| 流程 | 并行工程（面料辅料同步——不等串联） |

## 三、交期延误的归因分析

### 延误原因帕累托（80/20）
| 原因 | 占比 | 对策 |
|:---|:---|:---|
| 面料晚到 | 30-40% | 面料交期前置+双备份（见 `suppliers/fabric-accessories-supplier-management.md`） |
| 品质返工 | 20% | 首件确认+过程检验（见 `suppliers/supplier-quality-management.md`） |
| 排产冲突 | 15% | 产能排产管理（见 `suppliers/production-capacity-scheduling.md`） |
| 客户改单 | 10% | 改单收费+交期重议（见 `trade-process/merchandising-troubleshooting.md`） |
| 物流延误 | 10% | 船期 buffer+多方案 |
| 其他 | 5-15% | — |

## 四、交期承诺与缓冲

- **承诺交期 = 正常周期 + buffer**（常规 5-7 天缓冲——不把话说满）;
- **分级承诺**：常规单标准交期 / 加急单（加急费）/ 快反单（快反专线）；
- **交期沟通**：报价即明确交期（含前提——"based on fabric in stock"）；

## 五、延误预警与升级

### 三级预警（见 `suppliers/production-capacity-scheduling.md`）
- **黄灯**（预计延 1-3 天）：内部协调——加班/增援；
- **橙灯**（预计延 3-7 天）：客户预警+方案（分批/空运补）；
- **红灯**（预计延 7 天+）：高层介入+客户协商（折扣/取消条款风险）。

### 延误沟通原则
- **早报优于晚报**（客户能调整销售计划——晚报是信任杀手）；
- **带方案报**（不只说延误——给补救选项：分批出货/空运赶首波）；
- **邮件模板**：见 `trade-process/business-email-english-templates.md` 延误致歉。

## 六、客户考核与改善

- **品牌供应商考核**：OTD 进入 scorecard（如 Walmart/耐克供应商评分——连续低于 90% 降级）；
- **改善闭环**：延误案例复盘（归因→对策→跟踪——精益 PDCA）；
- **数据基础**：订单交期数据记录（Excel/ERP——没数据没法改善）。

## 七、相关文档

- 产能排产：见 `suppliers/production-capacity-scheduling.md`
- 跟单异常：见 `trade-process/merchandising-troubleshooting.md`
- 精益生产：见 `suppliers/garment-factory-lean-production.md`
- 售后翻单（交期影响翻单）：见 `trade-process/after-sales-repeat-orders.md`
