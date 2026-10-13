---
title: 版型、放码与尺码表（Pattern, Grading & Size Chart）
category: garments
tags: [版型, 纸样, 放码, 尺码表, 跳码, 公差, pattern, grading, spec]
sourceType: curated
status: stable
---

# 版型、放码与尺码表（Pattern, Grading & Size Chart）

版型（pattern/fit）是成衣订单的技术核心。尺寸偏差是验货不合格与客诉的第一大原因——所有尺寸争议最终都回到尺码表（size chart/spec sheet）的约定。

## 一、纸样与版型基础

- **头样（first pattern）**：按客户 spec 或样衣（counter sample）打版。
- **版师用语**：前片/后片（front/back panel）、袖片（sleeve）、领片（collar）、贴边（facing）、缝份（seam allowance，常见 1cm/3/8"）。
- **版型风格**：合体（slim/fitted）、常规（regular）、宽松（relaxed/oversized）——同尺码不同版型的成衣尺寸差异可达 4-8cm。
- 外贸惯例：以客户提供的 **spec sheet + 样衣**双基准，不以国内尺码经验套版。

## 二、放码（Grading）

- **跳码规则（grade rule）**：相邻码差值，按部位分别定义。
- 常见跳码参考（女装上衣，英寸）：

| 部位 | 跳码量 |
|:---|:---|
| 胸围（chest） | 2"（约 5cm） |
| 腰围（waist） | 2" |
| 肩宽（shoulder） | 0.5" |
| 衣长（length） | 0.5-1" |
| 袖长（sleeve） | 0.25-0.5" |
| 领围（neck） | 0.25-0.375" |

- **客户跳码表优先**：欧美品牌多有自有 grade rule（如 plus size 段跳码加大），必须按客户表执行。
- 放码方式：点放码（point grading，主流）/ 网状放码；CAD 系统（Gerber/Lectra/富怡/ET）。

## 三、尺码表（Size Chart / Spec Sheet）

### 两种体系
| 体系 | 内容 | 用途 |
|:---|:---|:---|
| Body measurement | 人体净尺寸 | 品牌定义尺码用 |
| **Garment measurement** | **成衣实测尺寸** | **生产与验货基准（外贸通用）** |

### 测量点（POM, Points of Measure）
- 上衣：胸围 1" below armhole、腰围、下摆（hem/sweep）、肩宽、衣长（HPS high point shoulder / CB center back）、袖长、袖口。
- 裤装：腰围（waist relaxed/extended）、臀围、前/后浪（rise）、裤长（inseam/outseam）、脚口。
- **测量方法必须统一**：铺平（flat）测量、拉力状态（罗纹腰头注明 relaxed/extended），方法不同结果差 1-3cm。

### 公差（Tolerance）
- 常规 ±1.5-2cm（±0.5-0.75"）；日本订单 ±1cm。
- 针织面料比梭织公差宽（弹性与卷边因素）。
- 公差写入 spec sheet，验货以此判定。

## 四、尺码体系对照

| 市场 | 女装 | 男装 | 特征 |
|:---|:---|:---|:---|
| US | 0-16 / XS-XXL | 28-42 / S-XXL | 偏宽松，见 `customers-market/us-market.md` |
| EU | 34-48 | 44-60 | 法/德/意尺码有差异 |
| UK | 6-20 | - | 比 US 小半码 |
| JP | 7-15 / S-LL | S-3L | 偏小 1-2 码，公差严 |
| 亚洲通用 | S-XXL | S-XXL | 需客户确认基准 |

> 无官方全球换算标准——**一律以客户 size chart 为准**，禁止用网络换算表生产。

## 五、生产流程中的尺寸管控

1. **产前会（PPM）**：核对 spec sheet 每个 POM 的测量方法与公差。
2. **跳码样（size set sample）**：全尺码各做 1-2 件确认放码准确性，客户批准后才开大货裁床。
3. **裁片抽检**：裁床后抽裁片量关键部位，预防排料/拉布误差。
4. **中期/尾期量尺寸**：DUPRO 与 PSI 按 spec 抽量（每码每色至少 2-5 件）。
5. **留样**：每色每码留船样（shipment sample）1 件，客诉比对基准。

## 六、常见纠纷与预防

| 纠纷 | 根因 | 预防 |
|:---|:---|:---|
| 成衣尺寸整体偏小 | 用身体尺寸当完成尺寸 | spec 明确标注 garment measurement |
| 腰头尺寸争议 | 未注明平量/拉伸量 | 注明 relaxed & extended 双值 |
| 针织衣长缩水偏短 | 洗后缩率未计入 | 洗后尺寸纳入 spec（after wash spec） |
| 左右不对称 | 裁剪/缝制偏差 | 对称性写入检验标准 |

## 七、相关文档

- 成本核算（单耗）：见 `garments/garment-costing-pricing.md`
- 缝制工艺：见 `garments/sewing-and-workmanship.md`
- 疵点检验：见 `garments/garment-defects-inspection.md`
- 各市场尺码偏好：见 `customers-market/` 目录
