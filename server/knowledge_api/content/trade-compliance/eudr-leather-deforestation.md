---
title: EUDR 欧盟毁林法规与皮革出口合规（EU Deforestation Regulation）
category: trade-compliance
tags: [EUDR, 毁林法规, 皮革出口, 地理定位, 尽职调查, DDS, 欧盟合规]
sourceType: curated
status: stable
---

# EUDR 欧盟毁林法规与皮革出口合规（EU Deforestation Regulation）

EUDR（EU Deforestation Regulation）将**皮革纳入"无毁林"供应链管制**：牛皮/皮革制品输欧须提供牧场**地理定位坐标**与尽职调查声明（DDS）。这是继 UFLPA 之后又一条"追溯即门槛"的法规（追溯逻辑见 `trade-compliance/supply-chain-traceability-mapping.md`）。

## 一、法规范围

- **七大商品**：牛、可可、咖啡、棕榈油、橡胶、大豆、木材及其衍生品；
- **纺织相关**：**皮革（HS 4101-4115）及皮革制品（皮衣/皮具/鞋）**在列——棉花/化纤不在列；
- **核心标准**：产品须产自 **2020-12-31 后未发生毁林**的地块 + 生产符合当地法律；
- **实施时间**：原定 2024-12-30，两度推迟后——大中型企业 2026-12-30、小微企业 2027-06-30（**以欧委会最新公告为准**，简化方案仍在调整）。

## 二、核心义务（经营者/贸易商）

1. **地理定位**：原料产地块坐标（牧场 polygon 经纬度——>4 公顷须多边形坐标）；
2. **尽职调查声明（DDS）**：通过欧盟信息系统提交，取得**参考编号（reference number）**随货流转；
3. **风险评估与缓解**：国别风险分级（欧盟发布低风险/标准/高风险国家清单——低风险国简化尽调）；
4. **记录保存**：DDS 与供应链数据保存 5 年。

## 三、对皮革供应链的传导

```
牧场（坐标）→ 屠宰场 → 制革厂 → 皮革制品厂 → 出口商 → 欧盟进口商（提交 DDS）
```

- **数据链传递**：中国皮衣出口商需从**皮革供应商处获取上游追溯数据**（牧场坐标/批次流转记录）；
- **中国皮革进口现实**：原料皮大量来自巴西（毁林高风险区——亚马逊周边牧场）/美国/澳洲——巴西牛皮是 EUDR 风险焦点；
- **欧盟进口商责任**：首道放入欧盟市场的经营者承担主责——**客户会把数据要求写入采购合同**（不提供=丢单）。

## 四、实操应对

1. **摸底**：排查输欧产品是否含真皮（皮衣/皮手套/皮革饰边/皮标都算——牛仔裤皮牌也触发）；
2. **供应商数据要求**：向皮革厂索要批次追溯文件（屠宰场来源证明/现有追溯体系数据）；
3. **借力现有体系**：LWG（Leather Working Group）认证厂多有追溯基础；ICE C（意大利）/巴西制革厂已有 EUDR 准备方案；
4. **合同条款**：将 EUDR 数据提供义务写入采购合同（见 `suppliers/supplier-contract-risk.md`）；
5. **替代评估**：PU/合成革不受 EUDR 管制（见 `fabric/leather-synthetic-leather.md`——部分订单可引导客户转环保素皮）。

## 五、违规后果

- 罚款（最高欧盟营业额 4%）/货物没收/市场禁入；
- 海关抽查：凭 DDS 参考号核验（无号=扣货）。

## 六、与其他法规的协同

| 法规 | 对象 | 差异 |
|:---|:---|:---|
| EUDR | 皮革（毁林） | 地理坐标+DDS |
| UFLPA | 棉（强迫劳动） | 美国/涉疆证据链（见 `trade-compliance/uflpa-forced-labor.md`） |
| ESPR/DPP | 全纺织品（数字产品护照） | 2027+ 分阶段（见 `trade-compliance/eu-espr-dpp.md`） |
| CSDDD/国家供应链法 | 人权环境尽调 | 框架性义务（见 `trade-compliance/eu-national-supply-chain-laws.md`） |

- **共性**：都是"数据即准入"——建议统一建**供应链追溯数据底座**（一物一码/批次台账），一次建设多法规复用。

## 七、相关文档

- 皮革服装生产：见 `garments/leather-fur-garment-production.md`
- 皮革材料：见 `fabric/leather-synthetic-leather.md`
- 供应链追溯：见 `trade-compliance/supply-chain-traceability-mapping.md`
- 欧盟市场：见 `customers-market/eu-market.md`
- ESPR/DPP：见 `trade-compliance/eu-espr-dpp.md`
