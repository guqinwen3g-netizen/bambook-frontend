---
title: 纺织色彩管理体系（Color Management: Pantone, 测色仪与对色流程）
category: fabric
tags: [色彩管理, 潘通, Pantone, 测色仪, 灯箱对色, Lab值, 缸差, 色卡]
sourceType: curated
status: stable
---

# 纺织色彩管理体系（Color Management: Pantone, 测色仪与对色流程）

色差是纺织外贸纠纷第一大类。建立色彩管理体系（标准色卡→测色数据化→光源规范化→缸差控制）可将色差投诉率降 80%。本篇给面料/服装企业的全流程实操框架，与染厂协作（见 `suppliers/dyeing-mill-cooperation-management.md`）配合使用。

## 一、色彩标准载体

| 载体 | 体系 | 用途 | 注意 |
|:---|:---|:---|:---|
| Pantone TCX/TPG | 潘通纺织色卡（TCX 棉布版/TPG 纸版） | 国际订单默认语言——**报色号必须注明版本年份**（2020 版与旧版色号有漂移） |
| Pantone C/U | 印刷色卡 | 印花稿/吊牌/包装 | C（光面）与 U（哑面）同色不同值 |
| 客户原样 | 实物标样 | 最可靠基准（比色卡优先） | 双方各留一份+签字封存 |
| 电子色（QTX） | 测色数据文件 | 染厂直接读取配色 | 需测色仪打通 |
| 国标/色卡本 | CNCS/自建色卡 | 内销与常规色 | 出口订单不单独使用 |

- **铁律**：**口头色名无效**（"藏青"有几十种）——订单必须绑定色号或实物样；色卡每年老化变色，2-3 年更换。

## 二、测色数据化（Lab 值体系）

- **分光测色仪**（Datacolor/X-Rite）：测 L\*a\*b\* 值计算色差 **ΔE**：
  - ΔE ≤0.8：人眼难辨（高端订单要求）；
  - ΔE ≤1.0-1.5：常规可接受；
  - ΔE >2.0：明显色差（拒收区）；
- **合同写法**："按 Pantone 19-4052 TCX，D65 光源下 ΔEcmc(2:1) ≤1.0"——**必须注明色差公式与光源**（ΔE76/94/2000 算法结果不同）；
- **同色异谱（metamerism）**：两色在 D65 下匹配、A 灯下失配——多光源验证是高端品牌必查项；
- **染料配方管理**：染厂电脑测配色系统（CCM）存档配方——翻单重现性的技术基础。

## 三、对色光源与环境

- **标准灯箱**（D65 主光源+TL84 商店光+A 灯+UV）：对色操作 SOP——样品平铺 45°、无环境光干扰、灯箱灯管 2000 小时更换（灯管老化色温漂移）；
- **观察一致性**：对色人员色觉测试（Farnsworth-Munsell 100 色相棋）——色弱人员不得做对色岗；
- **远程对色**：疫情后普及"实物样快递+视频对色"，但**最终批板仍以实物为准**（屏幕色不可作为验收依据）。

## 四、缸差（lot variation）控制

- **成因**：染料批次/水质/温度曲线/浴比波动——同一配方不同缸 ΔE 1-2 属正常（见 `suppliers/dyeing-mill-cooperation-management.md`）；
- **成衣对策**：
  - 同一件衣服**前后片/袖子同缸裁**（裁剪分缸管理，见 `suppliers/cutting-room-management.md`）；
  - 断缸标记：每缸留样贴缸号，裁剪按缸号配套；
  - 大客户接受"分缸出货"（按缸装箱，零售端按缸上架）；
- **翻单色差**：首单留"标准板+大货板"双份；翻单对首单大货板（而非对色卡）——染料厂停产换料是翻单色差主因。

## 五、纠纷处理与证据

- **留样制度**：每批面料留 A4 样两份（双方各一）+成衣留样——保存 2 年（索赔时效，见 `trade-process/claims-handling.md`）；
- **争议仲裁**：双方 ΔE 测量不一致时送第三方（SGS/ITS 测色报告为终局依据）——费用责任事前约定；
- **色差让步规则**：轻微超差（ΔE 1.0-1.5）可谈折价收货；明显色差（>2.0）重染或换货——质量标准事前写入质量协议（见 `fabric/fabric-procurement-quality-agreement.md`）。

## 六、印花与色织的特殊性

- **印花**：多套色对花精度（±0.3mm）+色浆批次——每色留刮样（strike-off）确认（见 `fabric/dyeing-printing-finishing.md`）；
- **色织**：纱染缸差→布面条花——筒子纱分缸配套织造（见 `fabric/yarn-dyed-fabrics.md`）；
- **成衣染色**：成衣染（garment dye）色差容忍度天然大——用"洗水感"风格化表述管理客户预期（见 `suppliers/washing-factory-management.md`）。

## 七、相关文档

- 染厂协作：见 `suppliers/dyeing-mill-cooperation-management.md`
- 染整工艺：见 `fabric/dyeing-printing-finishing.md`
- 四分制检验：见 `fabric/fabric-inspection-4point.md`
- 色织面料：见 `fabric/yarn-dyed-fabrics.md`
- 质量协议：见 `fabric/fabric-procurement-quality-agreement.md`
