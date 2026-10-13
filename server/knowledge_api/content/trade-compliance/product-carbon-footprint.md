---
title: 产品碳足迹核算实务（Product Carbon Footprint: 纺织 PCF/ISO 14067/数据获取）
category: trade-compliance
tags: [碳足迹, PCF, ISO 14067, PAS 2050, 生命周期, LCA, 碳排放核算, 碳标签, 范围三]
sourceType: curated
status: stable
---

# 产品碳足迹核算实务（Product Carbon Footprint: 纺织 PCF/ISO 14067/数据获取）

碳足迹从 ESG 报告概念变成**订单级要求**：欧美品牌（Inditex/H&M/迪卡侬）已要求核心供应商提供产品碳足迹（PCF）数据；欧盟 ESPR/DPP 与法国气候法案把碳信息披露推向强制。工厂侧能力=会算、有据、能降。ESG 总框架见 `trade-compliance/esg-csrd-sustainability.md`。

## 一、标准与边界

- **ISO 14067 / PAS 2050 / GHG Protocol Product Standard**：三套主流方法学互通——核心是生命周期（LCA）思维；
- **边界设定**：纺织常用 **Cradle-to-Gate（摇篮到工厂大门）**——原料+纺纱+织造+染整+成衣出厂；Cradle-to-Grave 含运输/使用（洗涤烘干是服装碳足迹大头——占 40-60%）/废弃；
- **单位**：kgCO₂e/件（或 /kg 面料）——数量级参考：一件棉 T 恤 5-10 kgCO₂e（全生命周期）、一件涤纶外套 15-30、牛仔裤 20-35；
- **范围三（Scope 3）逻辑**：品牌的范围三=供应商的范围一+二——**工厂被要求的实质是提供自己的能耗与排放数据**。

## 二、排放源分解（纺织链条）

| 环节 | 占比量级 | 主要排放源 | 数据获取 |
|:---|:---|:---|:---|
| 原料 | 25-40% | 棉花种植（化肥/灌溉）/涤纶石化 | 数据库缺省值（Ecoinvent/WLCN）+产地调整 |
| 纺纱织造 | 15-25% | 电力 | 实测电耗×电网排放因子 |
| **染整** | **30-45%（最大头）** | 蒸汽（煤/气）+电力 | 染厂能耗实测 |
| 成衣缝制 | 3-8% | 电力 | 工厂电耗分摊 |
| 运输 | 2-10% | 海运/空运（空运是海运 50 倍+） | 距离×方式×排放因子 |
| 使用阶段 | 40-60%（全周期口径） | 洗涤/烘干/熨烫 | 按洗护标签假设建模 |

- **排放因子库**：Ecoinvent（商业）、GaBi、中国生命周期数据库（CLCD）、DEFRA（英）/EPA（美）因子——**同一产品用不同库结果差 20-50%**，与客户约定数据库口径。

## 三、工厂落地路径

1. **建立能耗台账**：分车间/分工序电表汽表——**单位能耗（kWh/百米布、t 汽/吨纱）是核算与降碳的双重基础**；
2. **从单产品试点**：选一个大客户单品（如基础款 T 恤）做完整 PCF——第三方核算机构（SGS/TÜV/必维）费用 5-15 万/产品族，或 SaaS 工具自助（碳阻迹/蓝晶等）；
3. **一手数据优先级**：实测数据 > 行业平均 > 缺省值——品牌打分（如 Higg FEM/MSI）奖励实测数据；
4. **降碳杠杆排序**：可再生能源（绿电/光伏屋顶——染整电气化）> 蒸汽系统能效（余热回收，见 `suppliers/dyeing-wastewater-environmental-compliance.md`）> 材料替代（再生涤纶 vs 原生——减排 30-50%，见 `fabric/sustainable-fabrics.md`）> 运输优化（海运替代空运）；
5. **数据交付格式**：品牌多要求填入其指定模板/平台（Higg/Worldly、Inditex 自有系统）——**保存计算底稿**（可审计性——品牌抽查数据真实性）。

## 四、商业影响与红线

- **订单门槛化**：部分品牌 2025-2027 路线图将 PCF 数据纳入供应商评级——早报数据者入优先池；
- **碳标签谨慎**："碳中和产品"宣称需完整抵消链条（CCER/VCS 信用）+第三方核证——**虚标即漂绿**（法国已开罚，见 `trade-compliance/green-claims-anti-greenwashing.md`）；
- **客户间口径差异**：不同品牌要不同系统/因子库——工厂侧维护"主数据+多口径换算"能力；
- **与 DPP 衔接**：欧盟数字产品护照将承载碳数据字段（见 `trade-compliance/eu-espr-dpp.md`）——数据结构化存档是长期投资。

## 五、交叉参考

- ESG 框架：`trade-compliance/esg-csrd-sustainability.md`；DPP：`trade-compliance/eu-espr-dpp.md`
- 反漂绿：`trade-compliance/green-claims-anti-greenwashing.md`
- 再生材料减排：`fabric/sustainable-fabrics.md`；印染节能：`suppliers/dyeing-wastewater-environmental-compliance.md`
- 品牌体系：`customers-market/brand-retailer-supplier-systems.md`
- 工厂数字化（能耗数据）：`suppliers/garment-erp-digitalization.md`
