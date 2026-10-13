---
title: 服装厂品质管理体系（Garment Factory QC System）
category: suppliers
tags: [品质管理, IQC, IPQC, FQC, QC体系, 品控组织]
sourceType: curated
status: stable
---

# 服装厂品质管理体系（Garment Factory QC System）

服装品质不是"验"出来而是"做"出来的：IQC 堵源头、IPQC 控过程、FQC 保出货——三层检验加过程预防构成完整闭环。

## 一、QC 组织架构

| 环节 | 职能 | 关键动作 |
|:---|:---|:---|
| IQC（来料检验） | 面料/辅料入库关 | 四分制验布（见 `fabric/fabric-inspection-4point.md`）/辅料抽检（见 `suppliers/incoming-material-inspection.md`） |
| IPQC（制程检验） | 流水线巡检 | 首件确认/中查/工序质量巡检 |
| FQC（最终检验） | 成品检验 | 尾期全检或 AQL 抽检（见 `trade-process/pre-shipment-inspection-sop.md`） |
| QA（品质保证） | 体系与标准 | 品质手册/客户标准转化/验货对接 |

## 二、关键控制点

### 1. 产前控制（预防第一）
- **产前会（pre-production meeting）**：技术/生产/品质三方会签（工艺单+样衣+客户标准三对照）;
- **首件鉴定（first article）**：每款每色首件全尺寸+工艺核对（封样挂线——大货对照基准）;
- **面料风险预警**：缸差/缩水率数据前置（排版与洗后尺寸预案）。

### 2. 制程控制
- **中查（in-line inspection）**：半成品抽查（车缝不良在成衣前拦截——返工成本最低时点）;
- **巡检频率**：IPQC 每 2 小时/每工位（记录上墙——问题工序即时标记）;
- **断针管理**：缝纫针断裂碎片全数找回（金属探测——出口日本/婴童强制，见 `suppliers/sewing-thread-needles.md`）;
- **不良日清**：当日不良当日返修（积压=隐匿——数据日会通报）。

### 3. 成品控制
- **尾查比例**：内销全检/外贸 AQL 抽检（客户指定）;
- **验针机**：100% 过针检（日本订单/童装强制——记录留存）;
- **包装检验**：混码/错标/装箱差异（出运前最后防线——见 `garments/garment-packaging.md`）。

## 三、品质数据体系

- **不良率指标**：缝制不良率（行业 3-8%——标杆<2%）/返修率/一次通过率（FTT——目标 95%+）;
- **缺陷分类**：致命（断针/金属异物）/严重（尺寸超差/破洞）/轻微（线头/污渍——见 `garments/garment-defects-inspection.md`）;
- **帕累托分析**：TOP3 缺陷周会攻关（80% 问题来自 20% 工序）;
- **追溯**：工单+裁床单绑定（面料缸号→成衣批次——客诉倒查）。

## 四、客诉与验货管理

- **验货对接**：客户/第三方验货流程（见 `trade-process/pre-shipment-inspection-sop.md`——验货不通过的翻箱重验成本自担）;
- **客诉闭环**：8D 报告（问题描述→围堵→根因→纠正→预防——品牌客户标配）;
- **索赔数据分析**：索赔金额/批次归因（见 `trade-process/claims-handling.md`——品质成本计入报价）。

## 五、品质成本（COQ）

- **预防成本**：培训/产前会/设备维护;
- **鉴定成本**：检验人工/测试费;
- **内部失败**：返工/报废/降等;
- **外部失败**：索赔/空运补货/客户流失（隐性最大——一次严重客诉可能失去客户）;
- **经验值**：品质总成本占产值 5-15%（预防投入 1 元省失败成本 10 元）。

## 六、体系建设路径

- **起步**：首件确认+尾查制度（最低成本两大杠杆）;
- **进阶**：IPQC 巡检+数据日报（不良可视化）;
- **成熟**：ISO 9001 认证/客户体系审核（验厂品质模块——见 `suppliers/factory-audit-guide.md`）;
- **文化**："不接收/不制造/不流出"三不原则（自检+互检——品质是全员责任）。

## 七、相关文档

- 面料检验：见 `fabric/fabric-inspection-4point.md`
- 服装疵点：见 `garments/garment-defects-inspection.md`
- 出货验货：见 `trade-process/pre-shipment-inspection-sop.md`
- 验厂审核：见 `suppliers/factory-audit-guide.md`
