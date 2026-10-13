---
title: 服装厂 PMC 计划物控管理（物料需求计划/齐套率/跟催/安全库存）
category: suppliers
tags: [PMC, 计划物控, 物料需求计划, 齐套率, 跟催, 安全库存, 缺料停线, 服装厂管理]
sourceType: curated
status: stable
---

# 服装厂 PMC 计划物控管理（物料需求计划/齐套率/跟催/安全库存）

PMC（Production & Material Control）是服装厂的"中枢神经"：订单再多，**齐套不了的面辅料就是停线**；产能再足，**排产冲突就是延误**。中国服装厂 80% 的交期事故根源不在缝制而在物控。产能排程（机台/人力侧）见 `suppliers/production-capacity-scheduling.md`、ERP 系统侧见 `suppliers/garment-erp-digitalization.md`——本文聚焦**PMC 的流程机制与关键指标**。

## 一、PMC 职能架构

| 职能 | 职责 | 关键输出 |
|:---|:---|:---|
| 主计划（PC） | 订单交期评审→主生产计划（MPS）→产能负荷平衡 | 主计划表/交期承诺 |
| 物控（MC） | BOM 展开→物料需求计划（MRP）→请购/跟催/齐套管控 | 物料需求表/齐套看板 |
| 跟单协同 | 客户变更传递、样品进度、验货预约 | 变更通知/验货计划 |

- **订单评审是源头**：接单前 PMC 必须参与交期评审（面料采购周期 15-30 天+生产周期——**拍脑袋承诺交期=事故起点**——评审框架见 `suppliers/order-review-acceptance.md`）；
- **交期倒排公式**：验货日 = ETD - 5 天；裁床开工 = 验货日 - 生产周期；**面料到厂 = 裁床开工 - 3 天（验布/松布/预缩）**；辅料（拉链/纽扣/商标）到厂 = 裁床开工 - 7 天——倒排表是 PMC 第一工具。

## 二、物料需求计划与齐套管控

- **BOM 展开**：按订单量×单耗×（1+损耗率）生成需求——**损耗率数据库**是精度核心（面料裁损 3-8%/印花损耗 2-3%/辅料损耗 1-3%——按品类工艺沉淀历史数据）；
- **齐套率（kitting rate）**：**不齐套不开工**是铁律——齐套看板（面料/里料/拉链/纽扣/商标/线/包装材料逐项绿灯）；开工前 48 小时齐套确认会（缺一项=调整排产而非带病上线）；
- **缺料分级响应**：关键物料（面料——缺则全线停）vs 工序物料（纽扣——可后道工序补救）——**按工序需求时间排序跟催**（先保裁床开工）；
- **跟催机制**：供应商交期看板（红黄绿灯）+**提前 7 天预警**（到期前跟进而非逾期追讨）——外协印花绣花纳入跟催（`suppliers/print-embroidery-mill-management.md`）；驻厂跟催（大单关键面料派员驻面料厂）。

## 三、库存与安全存量

- **面辅料仓管控**：先进先出（FIFO——面料批次管理防缸差混用——`suppliers/material-warehouse-management.md`）；**账实一致率 ≥98%**（循环盘点 A 类物料周盘/B 类月盘）；
- **安全库存**：常规辅料（衬布/线/胶袋）按 2-4 周用量设安全存量；**专用物料零库存**（客户指定拉链按单采购——呆滞即报废）；
- **呆滞料处理**：超 6 个月呆滞面辅料定期清理（折价转尾货/改样衣——`suppliers/garment-stock-lot-disposal.md`）；**呆带指标**：呆滞库存/总库存 <5%；
- **退补料管理**：次品退片补料流程（印花回片损耗——外协损耗责任划分）——**补料时效**影响后道 2-3 倍放大。

## 四、变更与异常处理

- **ECN 变更管理**：客户改单（数量/颜色/交期）——**变更影响评估表**（已采购物料/已裁床次/产能重排）→书面确认责任与费用（改单成本转嫁条款——`trade-process/trade-contract-terms.md`）；
- **异常升级机制**：面料迟延 3 天→黄色预警（调整排产）；7 天→红色（业务通知客户协商）；**空运/快递补救成本预算**（交期违约金 vs 空运差价的两害权衡）；
- **跨单物料挪用**：同面料多订单时挪用规则（**先到期订单优先+书面审批**——挪用失控=双单皆误）；
- **数据基础**：齐套及时率、准交率、缺料停线工时、库存周转天数——PMC 月度经营会核心报表（KPI 体系见 `suppliers/factory-kpi-performance.md`）。

## 五、数字化与组织

- **工具进阶**：Excel 倒排表（小微）→ERP MRP 模块（中型——`suppliers/garment-erp-digitalization.md`）→APS 高级排产（大型）；**款色码矩阵**是服装 MRP 区别于通用 ERP 的核心；
- **组织陷阱**：PMC 与业务/采购/车间的权责界面——**PMC 有权停线**（不齐套不上线）但必须数据服人；PMC 与采购分设（物控下单请购、采购执行——互相制衡防舞弊）；
- **人员能力**：优秀 PMC=懂工艺（知道每工序耗料）+懂数据+强势沟通——行业稀缺岗位，培养路径从跟单/仓管轮岗（人才梯队见 `suppliers/worker-training-skill-matrix.md`）。

## 六、交叉参考

- 产能排程：`suppliers/production-capacity-scheduling.md`；ERP：`suppliers/garment-erp-digitalization.md`
- 面辅料仓：`suppliers/material-warehouse-management.md`；来料检验：`suppliers/incoming-material-inspection.md`
- 订单评审：`suppliers/order-review-acceptance.md`；KPI：`suppliers/factory-kpi-performance.md`
- 印绣外协：`suppliers/print-embroidery-mill-management.md`；跟单管理：`trade-process/order-management-and-merchandising.md`
