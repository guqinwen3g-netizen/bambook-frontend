---
title: 供应商质量管理协同（Supplier Quality Management）
category: suppliers
tags: [供应商质量, 验货, 产前会, 中期检验, 尾期检验, 纠正预防, SQM]
sourceType: curated
status: stable
---

# 供应商质量管理协同（Supplier Quality Management）

贸易公司的质量不是"验"出来的，而是与供应商共建的过程管控体系。核心：**产前预防 > 中期纠偏 > 尾期把关**，把问题消灭在裁剪之前。

## 一、质量管控三阶段

### 1. 产前（Pre-Production）
- **产前会（PPM, Pre-Production Meeting）**：订单上线前必开，参与方：业务、QC、工厂技术/生产/品管。
  - 核对：tech pack、确认样（approved sample）、面辅料卡、尺码表公差、包装指示、验货标准（AQL）。
  - 输出：会议纪要 + 风险清单（如"格仔布对格公差 2mm 内"）。
- **产前样（PP sample）**：大货面辅料+大货工艺的全真样，客户批准后**封样**（sealed sample 一式三份：客户/我司/工厂）。
- **面辅料大货检验**：面料四分制验布（见 `fabric/fabric-inspection-4point.md`）、辅料对色对版，合格才准开裁。

### 2. 中期（During Production, DUPRO）
- **首件鉴定（first piece check）**：流水线第一件成品全尺寸+工艺检验，确认无误才批量流水。
- **DUPRO 检验**：完成 20-50% 时驻厂或巡厂抽检——尺寸、工艺、外观；此时发现问题**改得动**。
- 输出：DUPRO 报告 + 纠正措施（CAP, Corrective Action Plan），限期整改复检。

### 3. 尾期（Final Random Inspection, FRI/PSI）
- 100% 完成、80%+ 装箱后进行，AQL 抽样（见下）。
- 不合格处置：返工后**重验（re-inspection，费用由工厂承担）**；时间不够时与客户协商让步接收（concession）或折扣（discount）——需客户书面确认。

## 二、AQL 抽样标准（ANSI/ASQ Z1.4）

| 批量 | 抽样数（一般检验 II 级） | AQL 2.5 接收数 |
|:---|:---|:---|
| 91-150 | 20 | 1 |
| 151-280 | 32 | 2 |
| 281-500 | 50 | 3 |
| 501-1200 | 80 | 5 |
| 1201-3200 | 125 | 7 |
| 3201-10000 | 200 | 10 |

- 常用 AQL：致命（critical）0 / 主要（major）2.5 / 次要（minor）4.0。
- 致命缺陷（断针、绳带违规、发霉）**一件即整批判定不合格**。

## 三、供应商质量绩效管理

### 评分卡（Scorecard）
| 维度 | 权重 | 数据来源 |
|:---|:---|:---|
| 验货一次通过率 | 30% | FRI 记录 |
| 客诉率/索赔额 | 30% | 客诉台账 |
| 交期达成率 | 20% | 订单系统 |
| 配合度（打样/整改） | 10% | 业务评价 |
| 体系认证状态 | 10% | 证书台账 |

- 季度评级：A（加单优先）/B（正常）/C（限期整改+减单）/D（淘汰）。
- 末位 10% 供应商每年淘汰更新，保持供应商池活力。

### 质量成本分摊
- 验货不合格返工费、重验费、空运补救费、客户折扣损失——**按合同约定向供应商转嫁**（采购合同须含质量违约条款）。
- 质量保证金：新供应商首单预留 5-10% 尾款作质保金。

## 四、供应商能力建设

1. **标准前移**：把客户验货标准/手册翻译培训给工厂 QC（很多工厂看不懂英文标准）。
2. **共享判例库**：历史客诉案例（照片+原因+对策）汇编成册，供应商培训素材。
3. **检测设备帮扶**：推动核心工厂配检针机/验布机/色灯箱（D65）；小厂可共享第三方检测。
4. **联合改进**：高频问题（如色差）与印染厂/工厂三方会诊，从工艺参数根治。

## 五、数字化协同

- 验货报告电子化（拍照+定位+时间戳），供应商实时可见。
- 质量数据看板：按供应商/品类/问题类型统计，月度回顾会议用数据说话。
- 与 `suppliers/supplier-classification-evaluation.md` 的准入评估、`suppliers/supplier-collaboration.md` 的日常协作联动，形成全生命周期管理。

## 六、相关文档

- 供应商分类评估：见 `suppliers/supplier-classification-evaluation.md`
- 供应商协作：见 `suppliers/supplier-collaboration.md`
- 成衣疵点分级：见 `garments/garment-defects-inspection.md`
- 客诉索赔：见 `trade-process/claims-handling.md`
