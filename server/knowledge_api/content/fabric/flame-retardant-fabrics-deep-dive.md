---
title: 阻燃面料深度解析（Flame-Retardant Fabrics: 本质阻燃/后整理/测试体系）
category: fabric
tags: [阻燃面料, 本质阻燃, 后整理阻燃, 腈氯纶, 芳纶, Proban, 阻燃粘胶, LOI]
sourceType: curated
status: stable
---

# 阻燃面料深度解析（Flame-Retardant Fabrics: 本质阻燃/后整理/测试体系）

阻燃面料是防护纺织的**技术壁垒核心**：本质是"遇火自熄+不熔滴+低热释放"。两大技术路线——**本质阻燃纤维**（永久阻燃）与**后整理阻燃**（成本路线）——价差 3-10 倍，选型错误=订单亏损或安全事故。成衣应用见 `garments/fr-workwear-flame-resistant.md`，本文聚焦面料技术与供应链。

## 一、本质阻燃纤维体系

| 纤维 | LOI 极限氧指数 | 特性 | 价格倍数 |
|:---|:---|:---|:---|
| 间位芳纶（Nomex 模式） | 28-32 | 耐高温 400°C 不熔 | 8-10 倍 |
| 对位芳纶（Kevlar 模式） | 29-30 | 高强+阻燃（防割复合场景） | 10 倍+ |
| 腈氯纶（modacrylic） | 28-30 | 熔融收缩自熄/手感好——**欧美工装混纺主力** | 1.5-2 倍 |
| 阻燃粘胶（FR viscose） | 26-28 | 磷系共混纺丝/吸湿舒适 | 2-3 倍 |
| 阻燃涤纶（FR polyester） | 26-28 | 共聚磷系（窗帘幕布主力） | 1.3-1.8 倍 |
| 预氧丝（Panox） | 55+ | 碳纤维前驱体——极端高温 | 15 倍+ |

- **混纺逻辑**：腈氯纶+棉（55/45——阻燃+舒适平衡）；腈氯纶+粘胶+芳纶+导电纤维（石化多功能工装）；混纺比例决定阻燃等级与手感——**每混纺比变动需重新送检**；
- **国产替代**：烟台泰和（芳纶）/抚顺（腈氯纶）——价格是进口 60-70%，品牌单指定进口纤维需 BOM 锁死。

## 二、后整理阻燃工艺（成本路线）

- **Proban 工艺（棉）**：四羟甲基氯化磷（THPC）+氨熏固化——**耐洗 50 次+**（工艺门槛高：甲醛控制是难点——游离甲醛超标是 Proban 布常见退单）；代表厂：新乡护神/陕西元丰模式；
- **Pyrovatex CP 工艺（棉）**：N-羟甲基磷酰胺浸轧焙烘——手感优于 Proban 但耐洗 30 次级；
- **涤纶后整理**：浸轧磷/溴系——**溴系受 ZDHC/出口限制**（见 `fabric/dyestuffs-auxiliaries-trade.md` 的禁限用），出口单选无卤磷系；
- **涂层阻燃**：帐篷/遮阳布 PU 阻燃涂层（见 `fabric/functional-coating-lamination.md`）；
- **耐洗性红线**：后整理阻燃**必查洗后阻燃保持率**（ISO 6330 洗涤 10/25/50 次后垂直燃烧复测——报价按客户要求洗涤次数选工艺）。

## 三、测试标准矩阵

| 标准 | 方法 | 应用 |
|:---|:---|:---|
| ISO 15025/EN 532 | 垂直燃烧（续燃/阴燃/熔滴） | EN 11612 成衣基础 |
| NFPA 701 | 帷幕/幕布大火焰 | 美国幕布（见 `garments/stage-theatre-drapes.md`） |
| 16 CFR 1610/1615/1616 | 45°法/儿童睡衣 | 美国消费品（见 `trade-compliance/textile-flammability-regulations.md`） |
| FAR 25.853 | 垂直燃烧 12s/60s | 航空（见 `garments/airline-aviation-textiles.md`） |
| FMVSS 302 | 水平燃烧速率 | 汽车内饰 |
| BS 5852/7176 | 阴燃香烟+明火 | 英国家具/商用 |
| LOI（ISO 4589） | 极限氧指数 | 研发筛选指标 |

- **成衣 vs 面料测试**：面料报告≠成衣准入——EN 11612 要求成衣整体送检（接缝/辅料同为阻燃——缝纫线用芳纶线或阻燃涤线，见 `suppliers/sewing-thread-needles.md`）；
- **热防护值**：TPP（热防护性能）/ATPV（电弧——见 `garments/fr-workwear-flame-resistant.md` 的 NFPA 2112/70E 体系）。

## 四、采购与接单要点

- **证书核查**：面料厂提供批次阻燃报告（第三方 SGS/ITS）——**报告批次对应大货批次**（过期/张冠李戴是验厂硬伤）；
- **宣称纪律**：flame resistant（阻燃自熄）≠ fireproof（防火——禁用的绝对化表述）；后整理面料标洗涤次数限制（"FR properties maintained up to 50 washes"）；
- **起订量**：本质阻燃面料 3000 米+（纤维厂排产）；后整理阻燃 1000 米+（整理厂缸量）；
- **环保合规**：无卤化（ZDHC MRSL——溴系阻燃剂 DBDPE/HBCD 限用清单核对，见 `trade-compliance/chemical-environmental-compliance.md`）；Proban 甲醛管控（GB 18401 B 类≤75mg/kg——贴肤工装按 A 类收紧）；
- **产业带**：新乡/咸阳（阻燃棉整理）、烟台（芳纶）、吴江/绍兴（阻燃涤纶幕布）。

## 五、相关文档

- 阻燃工装成衣：见 `garments/fr-workwear-flame-resistant.md`
- 阻燃法规总述：见 `trade-compliance/textile-flammability-regulations.md`
- 功能纱线：见 `fabric/functional-yarns.md`
- PPE 合规：见 `trade-compliance/ppe-protective-clothing-compliance.md`
- 染料助剂禁限用：见 `fabric/dyestuffs-auxiliaries-trade.md`
