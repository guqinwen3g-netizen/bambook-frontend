# 开发环境角色、团队与客户演练包

> 仅适用 `panda_hub_dev`。账号、品牌和团队均为模拟资料；执行 `cd server && npm run seed:dev-roles`。脚本幂等，不清库。

## 公司画像与模拟业务口径

- 主营高端正式男/女装及相关面料，重点成衣品类是大衣、Blazer、Suit；男装约70%、女装约30%。
- 羊毛为主，涵盖精纺、半精纺、粗纺；另有TR和麻棉面料。
- 客户市场覆盖欧洲（英国、西班牙、波兰等）、美国、墨西哥；国内销售占比较小。演练客户均为虚构资料。
- 出口海外品牌通常以USD签销售合同并由海外品牌以USD付款。
- 面料出口可能由海外品牌Bill-to并签USD合同，但Ship-to为国内服装厂，最后由服装厂以CNY付款。合同币种、Bill-to、Ship-to、实际付款方、到账币种必须分别表达。
- 国内内销通常以CNY签销售合同并以CNY结算。
- 当前只建账号、组织、客户和团队共享关系，不创建合同、应收或到账交易。币种场景待逐个模块确认后再加业务流水。

## 账号角色

唯一最终Boss沿用现有 `owner@bambook.local`（超级管理员），不另造一个模拟Boss。开发面板中其他账号共17个：

| 数量 | 角色 | 模拟账号 | 职责 |
|---:|---|---|---|
| 1 | 面料销售主管 | `sales.fabric.manager@bambook.local` | 统筹面料一组、二组 |
| 1 | 成衣销售主管 | `sales.garment.manager@bambook.local` | 统筹成衣一组、二组、三组 |
| 10 | 业务员/组长 | 见下方团队表 | 每组两名业务员，其中一人兼任组长；组长仍是业务员角色，不额外增加角色类型 |
| 1 | 财务 | `finance@bambook.local` | 财务单据、收付款和核销；区分合同币种、付款方和到账币种 |
| 1 | 面料QC | `qc.fabric@bambook.local` | 面料检验、疵点和质量结论 |
| 2 | 成衣QC | `qc.garment1@bambook.local`、`qc.garment2@bambook.local` | 成衣检验、疵点和质量结论 |
| 1 | 后勤单证 | `logistics@bambook.local` | 出运、物流、报关及单证 |

内部模拟账号使用开发登录面板的一键进入。客户门户是独立身份，5个虚构品牌账号的本地开发密码默认为 `PandaDev@2026`，可由 `DEVSIM_CUSTOMER_PORTAL_PASSWORD` 覆盖。

## 五个业务组

| 业务类型/组别 | 组长（兼业务员） | 组员 | 主管 | 关联模拟客户 | QC覆盖 |
|---|---|---|---|---|---|
| 面料一组 | 林嘉 `sales.fabric1.lead@bambook.local` | 陈希 `sales.fabric1.member@bambook.local` | 面料主管 | Westbridge 英伦正装（英国） | 面料QC |
| 面料二组 | 周宁 `sales.fabric2.lead@bambook.local` | 许安 `sales.fabric2.member@bambook.local` | 面料主管 | Meridian Wool House（西班牙） | 面料QC |
| 成衣一组 | 顾言 `sales.garment1.lead@bambook.local` | 沈禾 `sales.garment1.member@bambook.local` | 成衣主管 | Cedar & Crown Tailoring（美国） | 两名成衣QC |
| 成衣二组 | 唐悦 `sales.garment2.lead@bambook.local` | 叶青 `sales.garment2.member@bambook.local` | 成衣主管 | Vistula Atelier（波兰） | 两名成衣QC |
| 成衣三组 | 江予 `sales.garment3.lead@bambook.local` | 白露 `sales.garment3.member@bambook.local` | 成衣主管 | Casa del Traje（墨西哥） | 两名成衣QC |

每个主管加入所辖各组以便团队业务协作；每个组长是本组 `Team.leaderId`，同时保留普通业务员RBAC角色。对应QC加入负责的业务团队。团队客户通过 `TeamDataGrant(read+followup)` 共享，组外普通业务员不应自动取得另一组客户业务子树权限。

## 演练顺序

1. 以五个组长分别创建面料或服装开发案：面料案突出羊毛精纺/半精纺/粗纺，成衣案围绕大衣、Blazer、Suit；整体男装约70%、女装约30%，辅料放在服装开发详情内。
2. 同组第二位业务员验证可见团队客户业务并协作跟进；组外人员验证客户业务子树隔离；主管验证仅覆盖所属业务线的团队。
3. 面料QC处理面料组质检；两名成衣QC处理三个成衣组质检；不以业务员或后勤代录质检结论。
4. 后勤处理出运和单证；财务处理交易与核销，保留合同销售币种与实际到账币种差异；大老板用于最终审批、全局治理和审计。
5. 后续补业务交易时依次演练：海外USD合同/海外USD付款；海外品牌USD合同、国内工厂Ship-to并以CNY付款；国内销售CNY合同/CNY结算。当前没有预置交易流水。

## 当前数据边界

脚本创建17个内部模拟账号（老板沿用既有账号）、5个客户门户身份、5个业务团队、5个虚构品牌客户及团队共享授权。此前冗余的“模拟领导”账号会停用，最终Boss只有既有老板账号。脚本不创建开发案、样品、报价、订单、出运或财务流水。
