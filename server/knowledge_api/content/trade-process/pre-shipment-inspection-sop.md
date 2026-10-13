---
title: 出货前验货SOP（Pre-Shipment Inspection SOP）
category: trade-process
tags: [验货, 出货检验, AQL, 验货流程, 第三方验货, 尾期验货]
sourceType: curated
status: stable
---

# 出货前验货SOP（Pre-Shipment Inspection SOP）

出货前验货（PSI/FRI）是**出货前的最后防线**：大货 100% 完成+至少 80% 包装完成时进行——AQL 抽样判定整批命运。

## 一、验货类型与时机

| 类型 | 时机 | 目的 |
|:---|:---|:---|
| 初检（IPC） | 生产初期（10-30%） | 早期发现问题（面料/工艺） |
| 中期（DUPRO） | 30-60% | 进度+质量过程控制 |
| **尾期/出货前（FRI/PSI）** | 100% 完成+80% 包装 | **出货放行判定** |
| 监装（CLC） | 装柜时 | 数量/唛头/装箱监督 |

## 二、AQL 抽样（判定逻辑）

### 抽样表（ANSI/ASQ Z1.4）
| 批量 | 抽样数（Level II） |
|:---|:---|
| 281-500 | 50 |
| 501-1200 | 80 |
| 1201-3200 | 125 |
| 3201-10000 | 200 |
| 10001-35000 | 315 |

### AQL 判定（常用 2.5 主疵/4.0 次疵）
- **示例**：125 件样本 + AQL 2.5 → 允许主疵 ≤7 件（Ac=7/Re=8——8 件即判拒收）；
- **致命疵点（critical）**：AQL 0（一个致命疵点=整批判定——如断针/绳带违规）；
- 详见 `suppliers/supplier-quality-management.md`。

## 三、验货流程（现场 SOP）

```
1. 核对订单/数量（PO 对照——数量是否 100% 完成）
2. 抽样（随机抽箱——客户指定或随机数表）
3. 开箱取样本（按抽样数）
4. 检验（外观/尺寸/功能/包装——对照确认样+工艺单）
5. 疵点判定（critical/major/minor 分级计数）
6. 结果判定（Pass/Fail——AQL 对照）
7. 报告（验货报告——照片+疵点记录）
```

## 四、检验项目清单

| 类别 | 项目 |
|:---|:---|
| 外观 | 疵点/污渍/色差/缝制质量/线头 |
| 尺寸 | POM 测量（公差——见 `garments/pattern-grading-sizing.md`） |
| 功能 | 拉链/纽扣/松紧（功能性） |
| 辅料 | 商标/吊牌/洗标（内容+位置） |
| 包装 | 折叠/胶袋/唛头/装箱（见 `garments/garment-packaging.md`） |
| 数量 | 装箱数量/配比（短装/混码） |
| 安全 | 检针（童装）/绳带/小部件 |

## 五、验货结果处理

| 结果 | 处理 |
|:---|:---|
| Pass | 放行出货 |
| Fail（可返工） | 返工后**重验**（重验费+交期影响） |
| Fail（严重） | 打折/取消（客户协商——见 `trade-process/claims-handling.md`） |
| 争议 | 复验/第三方仲裁 |

## 六、第三方验货 vs 客户验货

- **第三方（SGS/ITS/BV）**：公证报告（L/C 要求/新客户信任）——见 `trade-compliance/testing-lab-selection.md`；
- **客户 QC**：品牌驻厂 QC（免第三方费——客户自己人）；
- **自查**：贸易公司 QC 预验（第三方前的预检——提高一次通过）。

## 七、常见验货争议

| 争议 | 处理 |
|:---|:---|
| 疵点分级分歧 | 对照确认样+AQL 标准（明确疵点定义——见 `garments/garment-defects-inspection.md`） |
| 色差判定 | 对色灯箱（D65 光源——避免环境光争议） |
| 尺寸公差 | 工艺单公差表（合同约定——见 `fabric/fabric-procurement-quality-agreement.md`） |
| 抽样代表性 | 随机抽样（避免工厂"摆好箱"） |

## 八、验货纪律

- **不走过场**：验货是质量闸门（放水=客诉）；
- **不接受现场贿赂**：验货员廉洁（行业痛点——廉洁是报告可信度基础）；
- **报告留档**：验货报告存档（客诉追溯——见 `trade-process/claims-handling.md`）。

## 九、相关文档

- 质量管理：见 `suppliers/supplier-quality-management.md`
- 成衣疵点：见 `garments/garment-defects-inspection.md`
- 面料四分制：见 `fabric/fabric-inspection-4point.md`
- 包装：见 `garments/garment-packaging.md`
