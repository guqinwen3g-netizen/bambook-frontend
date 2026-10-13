---
title: 企业知识库七域分类体系
category: company
tags: [taxonomy, 分类体系, 知识库]
status: stable
---

# 企业知识库分类体系（authority）

本文件是企业知识库的**分类权威源**。所有入库文档的 `metadata.category` 必须落在下述七域之一；`metadata.domain` 用于二级细分。检索与 Agent 消费方依赖该分类做过滤/加权。

## 七域总览

| category | 中文 | English | 说明 |
|:---|:---|:---|:---|
| `fabric` | 面料 | Fabric | 原料、织法、克重、幅宽、染色、印花、后整理、质检、面料供应商 |
| `garments` | 成衣 | Garments | 品类、工艺、版型、尺码、辅料、缝制、成衣工厂 |
| `trade-process` | 外贸流程 | Foreign Trade Process | 询盘、报价、样品、订单、跟单、验货、报关、物流、单证、收汇 |
| `trade-compliance` | 贸易与合规 | Trade & Compliance | Incoterms、付款方式、关税、原产地规则、检测标准、环保合规 |
| `customers-market` | 客户与市场 | Customers & Market | 主要市场、客户画像、采购习惯、市场准入 |
| `suppliers` | 供应商 | Suppliers | 面料/辅料/成衣供应商、评估、准入、协作 |
| `company` | 公司 | Company | 公司介绍、优势、产能、内部政策、流程规范 |

## 文档 Frontmatter 约定

每个内容源文件须以 YAML frontmatter 开头：

```yaml
---
title: 文档标题          # 必填
category: fabric         # 必填，七域之一
tags: [面料, 涤纶, ...]   # 建议，检索标签
sourceType: curated      # curated=人工梳理 / wechat=公众号抓取 / import=导入
status: stable           # draft / stable / deprecated
---
```

正文用 Markdown，中文为主、关键英文术语保留原词并首次出现时标注（如"克重(gram per square meter, GSM)"）。

## 入库元数据映射

灌库时 `metadata` 至少携带：

```json
{
  "category": "fabric",
  "domain": "fibers",
  "tags": ["涤纶", "polyester"],
  "sourceType": "curated",
  "title": "..."
}
```

## 检索与权限

- 七域文档默认 `scope=company`，内部全员可见。
- 涉及客户/供应商可加 `metadata.access` 限制，未来通过 KnowledgeAcl 或 RAG 端 scope 过滤。