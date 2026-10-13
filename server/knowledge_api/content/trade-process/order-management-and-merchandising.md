---
title: 订单与跟单（Order Management & Merchandising）
category: trade-process
tags: [订单, 跟单, 生产单, 交期管理, 生产进度, production order, merchandising, tracking]
sourceType: curated
status: stable
---

# 订单与跟单（Order Management & Merchandising）

订单确认后进入跟单（merchandising）环节，跟单员（merchandiser）负责把订单从合同推进到出货。本文件覆盖订单确认、生产单（production order）、跟单节点与交期/进度管理。

## 一、订单确认

订单成立以**采购订单（purchase order, PO）**或**销售合同（sales contract）**为准，双方确认以下内容：

| 要素 | 说明 |
|:---|:---|
| 款号与数量 | style no.、订单数量（qty）与尺码分配（size breakdown） |
| 单价与总价 | unit price、total amount、币种 |
| 价格条款与付款 | Incoterms、T/T/L/C 方式 |
| 交货期 | 预计船期/空运日期 |
| 包装要求 | 纸箱尺寸、拼箱、吊牌、条码 |
| 质量与检测 | 检测标准、验货要求 |

> 订单数量允许的**溢短装**（more or less clause，如 ±5%）需在合同中写明，避免信用证结算不符。

## 二、生产单（Production Order）

生产单是把销售订单转化为工厂可执行指令的桥接文件，通常由跟单员编制，包含：

- **款式与工艺**：款号、工艺单（spec）、尺码表、缝制要求。
- **面料与辅料（trims）**：成分、克重、颜色、主标/洗标/吊牌/拉链纽扣。
- **数量与尺码分配**：按 PO 的尺码比例排产。
- **生产节点**：裁床日期、缝制进度、后整（ironing/packing）日期。
- **质量要求**：色差、尺寸公差、针距、线迹（stitching）标准。

生产单是**产前样批准（PP approval）**之后才正式下达（开裁）。

## 三、跟单节点与进度跟踪

典型的跟单进度（tracking）节点：

| 节点 | 英文 | 说明 |
|:---|:---|:---|
| 面料齐套 | fabric ready | 大货面料到齐、验布通过 |
| 辅料齐套 | trims ready | 主标/洗标/吊牌/配件到位 |
| 裁剪 | cutting | 铺布、排版、开裁 |
| 缝制 | sewing | 车缝、中途验货点 |
| 后整 | finishing | 熨烫、订辅料、包装 |
| 装箱 | packing | 装袋、装箱、钉箱 |
| 验货 | inspection | 中期/终期验货 |
| 出货 | shipment | 装柜、报关、放行 |

建议用**进度跟踪表（production tracker）**按款号/色号/尺码记录各节点完成率，异常（delay）及时预警。

## 四、交期管理

交期（lead time / delivery date）是外贸纠纷高发点，管理要点：

1. **倒排工期**：从装运日（ETD）倒推裁剪/缝制/包装各节点 deadline。
2. **预留缓冲**：面料、辅料到货延误、验货整改、报关都是常见 lag，预留 3–5 天缓冲。
3. **关键路径（critical path）**：识别决定交期的环节（通常为面料与产前样确认），优先保障。
4. **延误沟通**：预判延误时**第一时间书面通知**客户，说明原因与新交期，争取谅解或改期。
5. **交期承诺分级**：FOB 交期（装运港船上交货日）与客户到货 ETA 要区分，避免误读。

## 五、跟单过程中的风险点

1. **数量短缺**：裁片损耗、次品导致短装，需及时补裁或与客户协商溢短装范围。
2. **色差/缸差**：同色不同批次（dye lot）色差超标，需分批齐套大货。
3. **辅料规格不符**：客户指定辅料未到，勿擅自替代，需申请 substitution。
4. **验货不合格**：终期验货不通过需返工（rework），会推延交期。

## 六、跟单要点总结

1. 订单、生产单、节点记录**留痕可追溯**，作为验货与结算依据。
2. 用统一模板（PO / production order / tracker）保证信息一致。
3. 异常（延误、次品、缺量）**早发现早上报**，不隐瞒。
4. 与工厂、质检、货代（forwarder）、客户多方同步，避免信息断层。

## 七、相关文档

- 询盘与报价：见 `trade-process/inquiry-and-quotation.md`
- 样品开发与确认：见 `trade-process/sample-development-and-confirmation.md`
- 验货：见 `trade-process/inspection-and-quality-control.md`