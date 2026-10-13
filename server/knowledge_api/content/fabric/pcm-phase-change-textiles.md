---
title: PCM 相变调温纺织品（Phase Change Materials: 微胶囊/Outlast/焓值测试/水洗耐久）
category: fabric
tags: [相变材料, PCM, 调温面料, Outlast, 微胶囊, 焓值, 智能调温, 功能性面料]
sourceType: curated
status: stable
---

# PCM 相变调温纺织品（Phase Change Materials: 微胶囊/Outlast/焓值测试/水洗耐久）

PCM（Phase Change Materials）相变调温是"**储热缓冲**"逻辑的智能纺织品：微胶囊包裹的石蜡/脂肪酸在体温区间（28-32°C）熔融吸热、结晶放热，平抑温度波动。与接触凉感（Q-max 导热，见 `fabric/functional-fabrics.md`）是**完全不同的技术路线**——凉感是一过性触感，PCM 是持续性热缓冲。NASA 背书（Outlast 源于宇航服）+家纺与户外放量使其成为功能面料溢价最高的赛道之一。本文件梳理技术路线、测试标准与供应链命门。

## 一、技术路线对比

| 路线 | 工艺 | 优点 | 短板 |
|:---|:---|:---|:---|
| 微胶囊纺丝（纤维内置） | PCM 微胶囊混入纺丝液（粘胶/腈纶载体） | 耐水洗最好（50 次+） | 焓值受载体稀释（焓值 8-15 J/g） |
| 微胶囊涂层/印花 | 涂层胶+微胶囊刮涂面料反面 | 焓值高（30-60 J/g）、适用现有面料 | 水洗衰减快（10-20 次后衰减 30%+） |
| 微胶囊浸轧整理 | 后整理浸轧 | 工艺最简 | 手感变硬、耐久最差 |
| 相变薄膜/夹芯 | PCM 封装薄膜绗缝夹入 | 焓值最高（100+ J/g） | 只适家纺被枕，不透湿 |

- **焓值（J/g）是核心卖点指标**：熔融焓越高调温能力越强——但**宣称焓值必须注明测试标准**（DSC 差示扫描量热，ASTM D7024），虚标焓值是行业通病；
- **相变温度区间选型**：贴身层 28-32°C（皮肤舒适区）、睡袋填充 25-28°C、极端环境装备可定制——**温度区间错配=功能失效**（如 35°C 相变材料做内衣永远处于液态，无缓冲作用）。

## 二、品牌授权与供应格局

- **Outlast（德/美）**：行业开创者，授权模式=买其纤维/面料+缴纳吊牌费——**吊牌授权是营销资产**（消费者认知度最高的 PCM 品牌）；
- **37.5 Technology（美）**：椰子壳活性炭微粒——严格说是**湿度管理**（蒸发降温）而非 PCM，市场常与 PCM 混谈，接单时须与客户确认技术路线；
- **国产微胶囊**：国内微胶囊供应商（如北京/山东系）已突破包封技术，价差 30-50%——**但焓值稳定性与批次一致性仍是国产痛点**；
- **供应链命门=微胶囊供应商绑定**：面料厂的 PCM 功能完全取决于微胶囊来料——**合同须锁定微胶囊品牌/型号/焓值规格**，防止供应商中途换料降本。

## 三、测试与宣称合规

- **DSC 测试**：ASTM D7024/GB/T 35578——出熔融峰温度+焓值曲线，**报告须含升降温双曲线**（结晶过冷度大的材料升温凉、降温不放热，功能打折）；
- **水洗耐久是最大客诉点**：涂层型 PCM 水洗 10 次焓值衰减可达 30-50%——**合同标注"水洗 X 次后焓值保留 ≥Y%"** 并随批抽检（测试机构选择见 `trade-compliance/testing-lab-selection.md`）；
- **宣称合规**：FTC/欧盟对"temperature regulating"宣称要求实证——吊牌须有测试报告支撑（宣称合规逻辑同 `trade-compliance/green-claims-antigreenwashing.md`）；
- **阻燃冲突**：石蜡类 PCM 可燃——与阻燃要求并存的产品（如军警/航空）需用阻燃型 PCM 或复合阻燃整理（见 `fabric/flame-retardant-fabrics-deep-dive.md`）。

## 四、应用与接单要点

- **家纺主战场**：调温被/床垫保护垫（见 `garments/mattress-protectors-encasements.md`）/枕——欧美"sleep tech"概念溢价 30-50%；
- **户外与军警**：睡袋/手套/鞋垫——与风扇服（`garments/cooling-workwear-fan-jackets.md`）、加热背心（`garments/heated-vests-electric.md`）构成温度管理产品族；
- **报价结构**：PCM 处理费按米/按克重计价——**微胶囊成本占面料增值部分 60%+**，报价须附微胶囊规格书；
- **最小起订量**：涂层型 MOQ 低（1000 米可排产），纺丝型 MOQ 高（纤维厂起订 5 吨+）——小单客户引导选涂层路线并告知耐久差异。

## 五、相关文档

- 功能面料测试：见 `fabric/functional-fabrics.md`
- 功能纱线：见 `fabric/functional-yarns.md`
- 阻燃面料：见 `fabric/flame-retardant-fabrics-deep-dive.md`
- 床垫保护垫：见 `garments/mattress-protectors-encasements.md`
- 反漂绿宣称：见 `trade-compliance/green-claims-anti-greenwashing.md`
