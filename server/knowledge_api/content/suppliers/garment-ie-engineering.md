---
title: 服装 IE 工程专题（Garment Industrial Engineering）
category: suppliers
tags: [IE工程, SAM, 标准工时, GSD, 产线平衡, 效率, 工业工程]
sourceType: curated
status: stable
---

# 服装 IE 工程专题（Garment Industrial Engineering）

IE（工业工程）是服装厂"**从经验管理到数据管理**"的核心：标准工时（SAM）是报价、排产、计件工资、效率考核的共同语言。

## 一、标准工时（SAM/SMV）

- **定义**：Standard Allowed Minutes——合格工人在标准状态下完成工序所需时间（含宽放）；
- **测定方法**：
  - **秒表测时**：现场实测+评比系数+宽放（传统——成本低但主观）;
  - **GSD（General Sewing Data）**：缝制行业专用 PTS 预定动作时间系统——动作代码（取料/对齐/缝纫/放下）拆解累加（客观一致——品牌验厂认可）;
- **宽放率**：个人宽放+疲劳宽放+机器宽放（一般 15-25%）；
- **参考值**：基础 T 恤 SAM 约 8-12 分钟/ Polo 衫 15-20/ 衬衫 25-35/ 牛仔裤 25-30/ 西装外套 100+。

## 二、SAM 的四大用途

| 用途 | 应用 |
|:---|:---|
| 报价 | 工费 = SAM × 分钟工价（报价一致性——见 `garments/garment-costing-pricing.md`） |
| 排产 | 日产目标 = 工位数 × 日工时 / SAM（产能承诺依据） |
| 计件工资 | 工价 = SAM × 单价（同工同酬公平基础） |
| 效率考核 | 效率 = 产出件数 × SAM / 实际投入工时 × 100% |

## 三、产线平衡（line balancing）

- **平衡率** = 各工序总工时 /（工位数 × 瓶颈工序工时）× 100%——目标 85%+；
- **瓶颈工序**：决定整线节拍的最慢工序（改善第一优先级）；
- **平衡手法**：
  - 工序拆分/合并（ECRS：取消 Eliminate/合并 Combine/重排 Rearrange/简化 Simplify）;
  - 瓶颈增援（多能工调配）;
  - 设备改良（模板机/自动机替代手工——见 `suppliers/garment-machinery-equipment.md`）;
- **排车图（layout）**：流水线设备布局（U 型/直线型——见 `suppliers/garment-factory-lean-production.md` 单件流）。

## 四、效率指标

- **行业水平**：中国服装厂平均 45-65%、标杆工厂 75%+、新厂/新款上线初期仅 30-40%；
- **学习曲线**：新款上线效率爬坡——第 1 天约 40%、第 3 天 60%、第 7 天 80%+（大单效益来源）;
- **效率损失分析**：等待（断料/等设备）/返工（品质问题）/换款（SMED 改善）——IE 日会数据驱动。

## 五、IE 工程师职能

- **工序分解表（operation breakdown）**：整件拆解为工序序列（含 SAM/设备/台面）——生产前技术文件核心；
- **产前准备**：与版房/技术科联动（工艺可行性反馈——见 `suppliers/pattern-sample-room-management.md`）；
- **现场改善**：动作经济原则（双手作业/减少弯腰转身）/线外准备（烫台/捆扎前置）；
- **数据系统**：GSD 软件/吊挂系统数据/RFID 计件（数字化基础）。

## 六、IE 与外贸订单的关联

- **验厂加分**：品牌验厂关注 IE 能力（数据化管理=交付可靠性——见 `suppliers/factory-audit-guide.md`）;
- **报价谈判**：客户 IE 核价（品牌有 GSD 数据库——供应商 SAM 虚高会被压价）;
- **交期承诺**：SAM×数量/效率=排产天数（交期倒排依据——见 `trade-process/order-delivery-kpi.md`）;
- **小单快反**：SAM 快速测定能力=快速报价能力（快反核心竞争力）。

## 七、导入路径

- **起步**：秒表测时建立基础 SAM 库（品类工序标准化）；
- **进阶**：GSD 系统（投入约数万-数十万——品牌订单工厂值回票价）；
- **成熟**：IE 部门独立（与生产/技术并列——向精益生产演进）。

## 八、相关文档

- 精益生产：见 `suppliers/garment-factory-lean-production.md`
- 产能排产：见 `suppliers/production-capacity-scheduling.md`
- 服装报价：见 `garments/garment-costing-pricing.md`
- 机械设备：见 `suppliers/garment-machinery-equipment.md`
