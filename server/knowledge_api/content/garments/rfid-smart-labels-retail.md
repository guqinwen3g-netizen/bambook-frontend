---
title: RFID 与智慧零售标签（服装零售数字化：EPC 编码/快速盘点/防伪溯源）
category: garments
tags: [RFID, EPC, 电子标签, 智慧零售, 快速盘点, 防伪溯源, 优衣库, 迪卡侬, 吊牌标签]
sourceType: curated
status: stable
---

# RFID 与智慧零售标签（服装零售数字化：EPC 编码/快速盘点/防伪溯源）

RFID（射频识别）吊牌是服装零售数字化的基础设施：迪卡侬/优衣库/Zara 全品应用——**整箱盘点 5 秒完成**（条码逐件扫描需数小时）。对服装厂的影响：越来越多品牌订单要求**出厂贴附 RFID 吊牌/织标**——懂 RFID 的工厂接单竞争力提升。包装环节基础见 `garments/garment-packaging.md`。

## 一、技术体系（服装场景）

- **频段**：服装零售用 **UHF（860-960MHz，EPC Gen2 标准）**——读取距离 1-10 米、可群读（同时读数百标签）；HF/NFC（13.56MHz）用于单品防伪+消费者手机互动（NFC 碰一碰查真伪/溯源）；
- **标签形态**：吊牌内嵌（最常见）、织标内嵌（耐水洗——工服/酒店布草租赁管理）、不干胶贴纸（箱标/盒标）、缝制洗标（医护纺织品追踪，见 `garments/hotel-linen-b2b.md` 布草租赁场景）；
- **EPC 编码**：全球唯一码（SGTIN-96——公司前缀+品类+序列号）——品牌向 GS1 申请号段，工厂按品牌下发的编码数据写标/绑定 SKU；
- **成本**：inlay（芯片+天线）$0.04-0.08 + 吊牌印刷封装——单件综合成本 $0.1 上下，品牌已将此计入辅料标准。

## 二、品牌要求与工厂落地

| 品牌/渠道 | RFID 要求 | 工厂动作 |
|:---|:---|:---|
| 迪卡侬 | 全品强制（全球门店自助收银依赖） | 指定供应商标签+按 PO 写码 |
| 优衣库 | 全品强制 | 同上 |
| Inditex（Zara） | 门店防盗+补货 | 可循环硬标签（门店回收） |
| 沃尔玛 | 部分品类强制（供应商合规手册） | EPC 数据对接其 Retail Link |
| 亚马逊 FBA | 透明计划（Transparency——防伪码） | 逐件贴码+数据回传 |

- **工厂流程改造**：写码（编码数据导入打印写标一体机）→ 贴标（与吊牌工序合并）→ **校验**（读写器抽检——读不出/错码=整批返工）→ 箱标关联（件-箱-托数据层级）；
- **数据管理**：EPC 码与 SKU/颜色/尺码绑定表是**出货数据的一部分**——错绑=门店收货拒付；建议并入 ERP 管理（见 `suppliers/garment-erp-digitalization.md`）；
- **常见坑**：金属衣架/锡箔包装屏蔽读取（设计读码路径）、液体密集场景衰减、标签折叠损伤天线。

## 三、延伸应用（增值叙事）

- **防伪溯源**：NFC 芯片吊牌（球鞋/潮牌/奢侈品防假——StockX 鉴定逻辑；茶叶/酒类同源方案）——写入门户网站+区块链存证（营销概念重，实质是数据库）；
- **智能试衣间**：RFID 识别带入试衣间的商品→推荐搭配（品牌旗舰店体验升级）；
- **布草/工服租赁管理**：耐水洗织标（200 次工业洗涤）——**丢损率管理+洗涤次数追踪**（酒店布草租赁、医护纺织品、消防服维保记录——见 `garments/workwear-uniform-production.md`）；
- **供应链可视化**：工厂出库→海外仓→门店全链路读取节点（见 `trade-process/overseas-warehouse-operations.md`）；
- **DPP 数字产品护照**：欧盟 ESPR 法规下纺织品 DPP 载体可能就是 RFID/NFC/二维码之一——提前理解数据绑定逻辑（见 `trade-compliance/eu-espr-dpp.md`）。

## 四、贸易要点

- **订单评审**：新客户要求 RFID 时确认——标签谁采购（品牌指定供应商 vs 工厂自采）、编码数据格式与下发时点、写码校验责任、不良标签补货流程；
- **设备投入**：RFID 打印写标机（斑马/佐藤——2-5 万元/台）+ 通道式读码校验机——月百万件级工厂标配；
- **报价计入**：标签成本+写码工时（单件 +0.05-0.15 元）明确列入成本表（见 `garments/garment-costing-pricing.md`）；
- **数据安全**：EPC 数据属品牌资产——工厂留存与使用边界（防窜货监控逻辑——品牌用 RFID 追踪渠道串货，工厂不得外泄编码数据）。

## 五、交叉参考

- 包装流程：`garments/garment-packaging.md`；ERP：`suppliers/garment-erp-digitalization.md`
- DPP 法规：`trade-compliance/eu-espr-dpp.md`；大卖场渠道：`customers-market/big-box-retail-channel.md`
- 酒店布草：`garments/hotel-linen-b2b.md`；工服：`garments/workwear-uniform-production.md`
- 海外仓：`trade-process/overseas-warehouse-operations.md`
- 成本核算：`garments/garment-costing-pricing.md`
