# 账号 分工 数据范围与权限目录

修订日期：2026年10月7日。目标分工见全局方案；默认权限表按“业务员实际经办采购与库存”纠偏。代码默认矩阵已同步；本轮没有修改数据库中持久化的既有角色授权，因此实际运行账号是否已同步，仍须另行只读核对。身份快照来自localhost/panda_hub_dev的只读事务，不代表生产员工目录或每个动作的完整有效权限。此处不包含密码、令牌或密钥。

## 一 七类内置角色与实际职责

| 角色ID | 角色名 | 说明 |
| --- | --- | --- |
| role-sales | 业务员 | 宽泛能力容器；执行仍按职责、数据范围、对象状态及任务资格 |
| role-sales-manager | 销售主管 | 宽泛能力容器；执行仍按职责、数据范围、对象状态及任务资格 |
| role-finance | 财务 | 宽泛能力容器；执行仍按职责、数据范围、对象状态及任务资格 |
| role-admin | 领导 | 宽泛能力容器；执行仍按职责、数据范围、对象状态及任务资格 |
| role-qc | QC | 宽泛能力容器；执行仍按职责、数据范围、对象状态及任务资格 |
| role-logistics | 后勤 | 宽泛能力容器；执行仍按职责、数据范围、对象状态及任务资格 |
| role-super-admin | 老板 | 宽泛能力容器；执行仍按职责、数据范围、对象状态及任务资格 |

面料/成衣业务组归属和实际订单经手关系用于确定业务范围，不产生新的角色码。系统不设采购员、仓管员、仓库管理员、样品保管人等独立岗位/资格；采购、加工与库存模块的常规操作由对应业务组业务员承担。领导role-admin与平台权限管理员仍须区分；老板技术权限不能代替专业结论或审批路由。

## 二 本地开发库完整身份与角色目录

环境：`localhost/panda_hub_dev`。快照：`2026-10-06T07:19:02.221Z`。数据库事务只读。内部账号20条（18条active、2条disabled），门户身份5条，团队5个，角色定义18个，权限定义129项，个人增量授权0条。账号均未软删；启用状态不等于已验证登录和操作。

| 账号ID | 显示名 | 邮箱 | 状态 | 数据库角色 |
| --- | --- | --- | --- | --- |
| devsim-apparel-a | 顾言（成衣一组组长） | sales.garment1.lead@bambook.local | active | role-sales |
| devsim-apparel-b | 沈禾（成衣一组） | sales.garment1.member@bambook.local | active | role-sales |
| devsim-fabric2-a | 周宁（面料二组组长） | sales.fabric2.lead@bambook.local | active | role-sales |
| devsim-fabric2-b | 许安（面料二组） | sales.fabric2.member@bambook.local | active | role-sales |
| devsim-finance | 模拟财务 | finance@bambook.local | active | role-finance |
| devsim-garment-manager | 模拟成衣销售主管 | sales.garment.manager@bambook.local | active | role-sales-manager |
| devsim-garment-qc-a | 模拟成衣质检一 | qc.garment1@bambook.local | active | role-qc |
| devsim-garment-qc-b | 模拟成衣质检二 | qc.garment2@bambook.local | active | role-qc |
| devsim-garment2-a | 唐悦（成衣二组组长） | sales.garment2.lead@bambook.local | active | role-sales |
| devsim-garment2-b | 叶青（成衣二组） | sales.garment2.member@bambook.local | active | role-sales |
| devsim-garment3-a | 江予（成衣三组组长） | sales.garment3.lead@bambook.local | active | role-sales |
| devsim-garment3-b | 白露（成衣三组） | sales.garment3.member@bambook.local | active | role-sales |
| devsim-leader | （停用）旧模拟领导 | leader@bambook.local | disabled | role-admin |
| devsim-logistics | 模拟后勤单证 | logistics@bambook.local | active | role-logistics |
| devsim-outdoor-a | 林嘉（面料一组组长） | sales.fabric1.lead@bambook.local | active | role-sales |
| devsim-outdoor-b | 陈希（面料一组） | sales.fabric1.member@bambook.local | active | role-sales |
| devsim-qc | 模拟面料质检 | qc.fabric@bambook.local | active | role-qc |
| devsim-sales-manager | 模拟面料销售主管 | sales.fabric.manager@bambook.local | active | role-sales-manager |
| system | 系统服务 | 无邮箱 | disabled | 无角色 |
| usr_empty_owner_muvbldml | 公司管理员 | owner@bambook.local | active | role-super-admin |

旧模拟领导devsim-leader与system服务身份已停用，未从目录删除。老板邮箱owner@bambook.local的显示名为“公司管理员”，数据库角色仍为role-super-admin，不据显示名新增一个老板。

| 数据库角色ID | 数据库名称 | 权限数 | 当前账号引用人数 |
| --- | --- | --- | --- |
| admin | Admin | 0 | 0 |
| agent_operator | Agent Operator | 0 | 0 |
| factory | factory | 0 | 0 |
| finance | Finance | 0 | 0 |
| logistics | logistics | 0 | 0 |
| manager | Manager | 0 | 0 |
| merchandiser | Merchandiser | 0 | 0 |
| owner | Owner | 0 | 0 |
| production_manager | production_manager | 0 | 0 |
| role-admin | 领导 | 95 | 1 |
| role-finance | 财务 | 55 | 1 |
| role-logistics | 后勤 | 36 | 1 |
| role-qc | QC | 30 | 3 |
| role-sales | 业务员 | 58 | 10 |
| role-sales-manager | 销售主管 | 77 | 2 |
| role-super-admin | 老板 | 129 | 1 |
| sales | Sales | 0 | 0 |
| viewer | Viewer | 0 | 0 |

7个内置职能角色有当前账号引用；另外11个旧角色无当前账号引用、无RolePermission配置。它们是兼容资产，不因此在目标设计中增加工厂或生产经理员工角色。role-admin当前仅被停用旧领导引用。

### 当前团队成员与共享配置

| 团队ID | 名称 | 状态 | 组长ID | 未离组成员 |
| --- | --- | --- | --- | --- |
| devsim-team-apparel | 模拟业务组 · 成衣一组 | active | devsim-apparel-a | devsim-garment-manager、devsim-apparel-a、devsim-apparel-b、devsim-garment-qc-a、devsim-garment-qc-b |
| devsim-team-fabric2 | 模拟业务组 · 面料二组 | active | devsim-fabric2-a | devsim-sales-manager、devsim-fabric2-a、devsim-fabric2-b、devsim-qc |
| devsim-team-garment2 | 模拟业务组 · 成衣二组 | active | devsim-garment2-a | devsim-garment-manager、devsim-garment2-a、devsim-garment2-b、devsim-garment-qc-a、devsim-garment-qc-b |
| devsim-team-garment3 | 模拟业务组 · 成衣三组 | active | devsim-garment3-a | devsim-garment-manager、devsim-garment3-a、devsim-garment3-b、devsim-garment-qc-a、devsim-garment-qc-b |
| devsim-team-outdoor | 模拟业务组 · 面料一组 | active | devsim-outdoor-a | devsim-sales-manager、devsim-outdoor-a、devsim-outdoor-b、devsim-qc |

| 团队ID | 对象类型 | 对象ID | 授权 | 撤销状态 |
| --- | --- | --- | --- | --- |
| devsim-team-outdoor | relation | DEVSIM-REL-OUTDOOR | read+followup | 未撤销 |
| devsim-team-fabric2 | relation | DEVSIM-REL-FABRIC-2 | read+followup | 未撤销 |
| devsim-team-apparel | relation | DEVSIM-REL-APPAREL | read+followup | 未撤销 |
| devsim-team-garment2 | relation | DEVSIM-REL-GARMENT-2 | read+followup | 未撤销 |
| devsim-team-garment3 | relation | DEVSIM-REL-GARMENT-3 | read+followup | 未撤销 |

### 当前门户身份完整目录

| 身份ID | 邮箱 | 显示名 | 客户作用域ID | 状态 |
| --- | --- | --- | --- | --- |
| DEVSIM-CUSU-APPAREL | buyer.cedar@portal.demo | Morgan Ellis（模拟品牌采购） | DEVSIM-REL-APPAREL | active |
| DEVSIM-CUSU-FABRIC-2 | buyer.meridian@portal.demo | Lucia Navarro（模拟品牌采购） | DEVSIM-REL-FABRIC-2 | active |
| DEVSIM-CUSU-GARMENT-2 | buyer.vistula@portal.demo | Anna Kowalska（模拟品牌采购） | DEVSIM-REL-GARMENT-2 | active |
| DEVSIM-CUSU-GARMENT-3 | buyer.casadeltraje@portal.demo | Sofia Reyes（模拟品牌采购） | DEVSIM-REL-GARMENT-3 | active |
| DEVSIM-CUSU-OUTDOOR | buyer.westbridge@portal.demo | Eleanor Shaw（模拟品牌采购） | DEVSIM-REL-OUTDOOR | active |

完整角色权限集合保存在global-design-data.json的developmentDatabaseSnapshot.roles；权限定义在permissionDefinitions。没有读取密码哈希、登录IP、令牌、财务交易或客户联系方式。

## 三 演练账号的目标分工

来源：`server/scripts/seed-dev-role-play.ts`及开发角色演练包。17个内部模拟账号另沿用既有老板；5个门户账号独立。这些演练邮箱已与本次本地开发库身份目录对应；目标职责仍需冻结。

| 账号 | 姓名/身份 | 角色 | 职责 | 目标边界 |
| --- | --- | --- | --- | --- |
| owner@bambook.local | 既有老板 | 老板 | 全局授权治理/适用最终审批 | 沿用既有，不造第二老板 |
| sales.fabric.manager@bambook.local | 模拟面料销售主管 | 销售主管 | 面料业务主管 | 所属业务线各组；审批按适用路由 |
| sales.garment.manager@bambook.local | 模拟成衣销售主管 | 销售主管 | 成衣业务主管 | 所属业务线各组；审批按适用路由 |
| sales.fabric1.lead@bambook.local | 林嘉（面料一组组长） | 业务员 | 面料一组组长 | 本人/所在团队及明确授权对象 |
| sales.fabric1.member@bambook.local | 陈希（面料一组） | 业务员 | 面料业务员 | 本人/所在团队及明确授权对象 |
| sales.fabric2.lead@bambook.local | 周宁（面料二组组长） | 业务员 | 面料二组组长 | 本人/所在团队及明确授权对象 |
| sales.fabric2.member@bambook.local | 许安（面料二组） | 业务员 | 面料业务员 | 本人/所在团队及明确授权对象 |
| sales.garment1.lead@bambook.local | 顾言（成衣一组组长） | 业务员 | 成衣一组组长 | 本人/所在团队及明确授权对象 |
| sales.garment1.member@bambook.local | 沈禾（成衣一组） | 业务员 | 成衣业务员 | 本人/所在团队及明确授权对象 |
| sales.garment2.lead@bambook.local | 唐悦（成衣二组组长） | 业务员 | 成衣二组组长 | 本人/所在团队及明确授权对象 |
| sales.garment2.member@bambook.local | 叶青（成衣二组） | 业务员 | 成衣业务员 | 本人/所在团队及明确授权对象 |
| sales.garment3.lead@bambook.local | 江予（成衣三组组长） | 业务员 | 成衣三组组长 | 本人/所在团队及明确授权对象 |
| sales.garment3.member@bambook.local | 白露（成衣三组） | 业务员 | 成衣业务员 | 本人/所在团队及明确授权对象 |
| finance@bambook.local | 模拟财务 | 财务 | 财务专员 | 授权财务业务；业务员申请/建议不写正式核销 |
| qc.fabric@bambook.local | 模拟面料质检 | QC | 面料QC | 对应面料/成衣检验资格与负责任务；不以业务员代录 |
| qc.garment1@bambook.local | 模拟成衣质检一 | QC | 成衣QC | 对应面料/成衣检验资格与负责任务；不以业务员代录 |
| qc.garment2@bambook.local | 模拟成衣质检二 | QC | 成衣QC | 对应面料/成衣检验资格与负责任务；不以业务员代录 |
| logistics@bambook.local | 模拟后勤单证 | 后勤 | 物流与单证专员 | 接收业务出运交接并办理货运/单证；不作为仓储岗位，不写QC结果或财务核销 |

### 五个显式业务组

| 团队 | 组长 | 组员 | 主管 | QC |
| --- | --- | --- | --- | --- |
| 面料一组 | 林嘉 | 陈希 | 面料主管 | 面料QC |
| 面料二组 | 周宁 | 许安 | 面料主管 | 面料QC |
| 成衣一组 | 顾言 | 沈禾 | 成衣主管 | 成衣QC一/二 |
| 成衣二组 | 唐悦 | 叶青 | 成衣主管 | 成衣QC一/二 |
| 成衣三组 | 江予 | 白露 | 成衣主管 | 成衣QC一/二 |

主管加入所辖组，QC加入对应负责组；团队客户通过显式授权共享。具体任务仍须指派经手人，不因同组自动由所有人负责。

### 独立门户身份

| 身份/账号 | 客户关联配置 |
| --- | --- |
| buyer.westbridge@portal.demo | {"id": "DEVSIM-CUSU-OUTDOOR", "displayName": "Eleanor Shaw（模拟品牌采购）", "relationId": "DEVSIM-REL-OUTDOOR", "relationName": "【模拟品牌】Westbridge 英伦正装（英国）"} |
| buyer.meridian@portal.demo | {"id": "DEVSIM-CUSU-FABRIC-2", "displayName": "Lucia Navarro（模拟品牌采购）", "relationId": "DEVSIM-REL-FABRIC-2", "relationName": "【模拟品牌】Meridian Wool House（西班牙）"} |
| buyer.cedar@portal.demo | {"id": "DEVSIM-CUSU-APPAREL", "displayName": "Morgan Ellis（模拟品牌采购）", "relationId": "DEVSIM-REL-APPAREL", "relationName": "【模拟品牌】Cedar & Crown Tailoring（美国）"} |
| buyer.vistula@portal.demo | {"id": "DEVSIM-CUSU-GARMENT-2", "displayName": "Anna Kowalska（模拟品牌采购）", "relationId": "DEVSIM-REL-GARMENT-2", "relationName": "【模拟品牌】Vistula Atelier（波兰）"} |
| buyer.casadeltraje@portal.demo | {"id": "DEVSIM-CUSU-GARMENT-3", "displayName": "Sofia Reyes（模拟品牌采购）", "relationId": "DEVSIM-REL-GARMENT-3", "relationName": "【模拟品牌】Casa del Traje（墨西哥）"} |

门户只读所属客户白名单资料，不暴露成本利润、供应商工厂、内部备注审批和QC疵点。客户反馈若扩展必须回内部负责人，不能自动成为QC或领导批准。

### 历史和服务账号边界

`seed-rbac.ts`还定义历史demo账号、可选bootstrap超管与system哨兵。本次开发库20条内部记录以目录为准；旧seed中未出现的demo配置不计入人数。AI/API key绑定真实员工或明确服务主体，权限、任务和审计不得以密钥本身替代身份。本次本地库个人增量授权0条；生产人员名册与授权不在本次本地快照范围。

## 四 按职责确定操作权限

| 专业动作 | 可以执行 | 其他角色可以做什么 | 明确限制 |
| --- | --- | --- | --- |
| 提交质量结论/签QC报告 | 具备对应QC资格并获对象授权者 | 业务员发起、补背景、看结果、继续业务 | 禁止业务员/后勤仅凭基础角色代录QC通过 |
| 登记客户/需求方意见 | 授权业务经手人；未来客户反馈渠道 | QC只提交专业质量事实 | 客户同意不更改QC失败报告 |
| 开发方向/版本规格维护 | 对应开发业务员 | QC引用当时依据 | 确认后修改需明确版本影响，不静默继承旧批准；技术字段仍按实际账号授权 |
| 样品入库/借寄封裁 | 对应业务员实际操作；来源模块和样品仓库联动 | 同组业务员按对象权限协作 | 不设样品保管或样品仓库岗位；不把入库登记等同QC通过或客户确认 |
| 大货实际收发/调拨 | 对应订单业务组的实际经手业务员 | 后勤处理货运/出运单证并关联业务交接 | 不设仓储执行岗位；按真实库存路径记录，不虚构库存；MVP不做盘点调整 |
| 采购PO/供应商交付跟踪 | 对应面料/成衣业务组的实际经办业务员 | 业务负责人审批；QC/财务专业承接 | 不设采购经手岗位；采购不等于付款执行 |
| BOM/成本输入与核算 | 业务员填报L1；财务核算L2–L4 | 主管按权限审核或查看；技术资料从实际来源引用 | 不预设独立技术/工艺/成本维护岗位；成本/利润字段独立可见权限，规则见07 |
| 业务CI制作与归档 | 开发CI由业务员在开发流程开具；出运CI/PL由后勤单证在出运流程制作 | 财务登记已开CI、供应商票据及应收应付 | 财务不代开业务CI；正式文件版本和作废/重开按来源规则，贷项/坏账另按适用授权 |
| 到账登记/核销冲回 | 财务且具对象与状态资格 | 业务员认领/匹配建议/追款 | 建议或金额相同不能直接写正式账 |
| 付款审批 | 合法适用业务审批人 | 申请人提交依据；财务执行支付 | 财务身份本身不意味着有业务付款审批资格 |
| 实际付款与凭证 | 财务且批准依据适用 | 业务经手人看付款进度 | 批准不等于银行已付款 |
| 运单装箱/订舱/报关 | 后勤单证及具体授权者 | 业务员给交付要求、看进度 | 发运、放行、实际出库分别留事实 |
| 业务审批/特批/签署 | 该业务范围内有审批权限的人 | 多名审批人收到同一待办；任一人处理后其他待办显示结果和实际审批人 | 业务负责人/老板可审批自己负责或提交的订单；不设通用“本人不能审批”限制。技术管理权限本身不授予业务审批权 |
| 人员权限及系统治理 | 被授权平台/组织管理员 | 业务负责人提出交接需求 | 技术管理与业务批准分开 |
| 薪酬及极敏感字段 | 老板及被明确指定授权HR | 员工/主管仅适用范围 | 普通领导或所有HR读权限不自动授薪酬明细 |

## 五 有效权限及数据范围

有效授权需要综合Role/UserRole/RolePermission、个人覆盖及到期、凭据permissionCeiling、Team/TeamDataGrant、任务对象归属、审批路由、业务状态与KnowledgeAcl/文件权限。多角色能力可聚合，但不能越过对象范围和专业执行资格。

| 身份 | 源码默认数据范围（事实） | 本稿设计边界 |
| --- | --- | --- |
| 业务员 | 默认team；关系/CRM普通档案all、写self；票款team；HRself | 档案公共查询不等于全客户业务可写；团队协作权限见D02 |
| 主管 | 默认team，可加入多组；HRdepartment | 只覆盖所辖组/业务线；审批遵循路由 |
| QC | 默认all且QC域写 | 目标按专业资格、分配任务、负责范围；默认all不能直接继承 |
| 后勤 | 默认all且物流单证写及既有协作权限 | 按负责任务与来源业务对象授权；库存协作权限不表示仓储岗位或仓储主责 |
| 财务 | 默认all且财务域写 | 跨团队财务处理有必要范围；对外和敏感字段仍受限 |
| 领导/老板 | 默认all | 治理和适用业务资格明确区分；不得隐去专业责任 |

## 六 全部129个源码权限定义与默认矩阵

下表逐项保留源码原始描述，原描述含过时阈值、旧财务主管/双签名称等，不作为新业务制度。列中“默认角色”仅是代码fallback；seed额外向业务员/主管/财务/领导配置invoices:suggest_match，本地DB角色集合与seed方向相符；角色集合不是含任务、状态、路由和会话限制的完整动作有效权限。

| 源码scope | 原始源码描述 | 默认角色（非生效授权） | 本稿处理方向 |
| --- | --- | --- | --- |
| dashboard:read | 全景看板查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| cockpit:read | 经营驾驶舱查看（含财务敏感KPI） | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| reports:read | 报表中心查看与运行 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| reports:write | 报表设计器/保存自定义报表 | SALES、SALES_MANAGER、FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| reports:admin | 报表订阅推送/全员模板管理 | SALES_MANAGER、FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| ai:chat | AI助手对话（含只读查询） | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 绑定真实主体；目标工具权限/人工确认同业务规则；不自动启用当前占位页 |
| ai:write:low | AI助手执行低风险写入（登记跟进/加标签） | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 绑定真实主体；目标工具权限/人工确认同业务规则；不自动启用当前占位页 |
| ai:write:medium | AI助手执行中风险写入（需确认） | SALES、SALES_MANAGER、FINANCE、ADMIN、SUPER_ADMIN | 绑定真实主体；目标工具权限/人工确认同业务规则；不自动启用当前占位页 |
| ai:write:high | AI助手执行高风险写入（需二次验证） | ADMIN、SUPER_ADMIN | 绑定真实主体；目标工具权限/人工确认同业务规则；不自动启用当前占位页 |
| relations:read | 业务伙伴档案查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| relations:write | 业务伙伴档案新增/编辑 | SALES、SALES_MANAGER、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| relations:delete | 业务伙伴档案删除（高危） | SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| relations:admin | 客户等级ABC/信用评级人工调整 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| crm:read | CRM跟进记录查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| crm:write | CRM跟进记录登记/编辑 | SALES、SALES_MANAGER、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| suppliers:read | 供应商档案查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| suppliers:write | 供应商档案新增/编辑 | SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| suppliers:admin | 供应商评级调整/暂停新单/解除 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| seasons:read | 季节/季度看板查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| seasons:write | 季节项目创建/编辑 | SALES、SALES_MANAGER、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| marketing:read | 营销活动与ROI查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| marketing:write | 营销活动创建/编辑 | SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| emails:read | 业务邮件查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| emails:write | 邮件发送/草稿编辑 | SALES、SALES_MANAGER、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| emails:admin | 邮件账户绑定/全局分类规则配置 | SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| orders:read | 订单管理查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| orders:write | 订单创建/编辑（Draft/Confirmed阶段） | SALES、SALES_MANAGER、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| orders:delete | 订单删除 | SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| orders:approve:change_delivery | 订单变更-交期（≤7天由SM，>7天总监）审批 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| orders:approve:change_qty | 订单变更-数量（±10%内SM，超总监）审批 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| orders:approve:change_price | 订单变更-价格 双签（FinMan+SM）审批 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| orders:approve:cancel | 订单取消 三签审批 | ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| quotations:read | 报价单查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| quotations:write | 报价单创建/编辑 | SALES、SALES_MANAGER、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| quotations:approve | 报价单审批（偏差block级） | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| quotations:convert | 报价单转化为订单 | SALES、SALES_MANAGER、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| products:read | 产品数字档案查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| products:write | 产品档案新增/编辑 | SALES、SALES_MANAGER、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| bom:read | BOM成本核算查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| bom:write | BOM创建/编辑（Draft态） | SALES、SALES_MANAGER、QC、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| bom:admin | BOM版本状态变更（Active/Obsolete）+ 新增自定义计算模型 | SALES_MANAGER、ADMIN、QC、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| production:read | 生产跟踪/阶段看板查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 跟单进度、QC事实、放行签署分开；按职责/版本/路由判断 |
| production:write | 生产阶段登记/QC疵点录入 | SALES、SALES_MANAGER、QC、SUPER_ADMIN | 跟单进度、QC事实、放行签署分开；按职责/版本/路由判断 |
| shipments:read | 运单与发货查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| shipments:write | 运单创建/装箱/发货登记 | SALES、SALES_MANAGER、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| shipments:approve | 发货放行审批（大货最终放行） | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| customs:read | 报关单证/外贸单证查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| customs:write | 单证签发/修正案创建 | SALES、SALES_MANAGER、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| customs:admin | 单证模板/公司抬头签章配置 | LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| qc:read | 质检工作台/疵点记录查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 专业QC处理；发起/业务背景应与专业结论权限拆开（旧Sales拥有写权限不沿用） |
| qc:write | QC疵点录入/QC结果登记 | SALES、SALES_MANAGER、QC、SUPER_ADMIN | 专业QC处理；发起/业务背景应与专业结论权限拆开（旧Sales拥有写权限不沿用） |
| aftersales:read | 售后客诉登记查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| aftersales:write | 客诉登记/扣赔处理录入 | SALES、SALES_MANAGER、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| aftersales:approve | 客诉扣赔/折让审批（影响应收金额） | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| procurement:read | 采购订单PO查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| procurement:write | 采购订单PO创建/编辑 | SALES、SALES_MANAGER、LOGISTICS、SUPER_ADMIN | 对应面料/成衣业务组的实际经办业务员；负责人按审批路由处理 |
| inventory:read | 库存查看 | SALES、SALES_MANAGER、ADMIN、LOGISTICS、SUPER_ADMIN | 以对应业务对象范围授权；不要求仓储/样品保管资格 |
| inventory:write | 库存实物动作登记 | SALES、SALES_MANAGER、LOGISTICS、SUPER_ADMIN | 由对应业务组实际经手人操作并记录真实账号；不设置仓储执行岗位 |
| procurement:approve | 采购订单PO审批+首单供应商+1级审批 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| finance:read | 财务看板/账龄/报表查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| invoices:read | 应收应付发票查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| invoices:write | 发票创建/签发（Commercial Invoice） | FINANCE、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| invoices:reconcile | 发票核销（收付款分配到发票） | FINANCE、SUPER_ADMIN | 财务执行；认领/建议不写正式核销或支付事实 |
| invoices:suggest_match | 提出回款匹配建议（不写核销账） | SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| invoices:approve:writeoff | 坏账核销/发票作废审批 | ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| vouchers:read | 收付款凭证查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| vouchers:write | 收付款凭证录入 | FINANCE、SUPER_ADMIN | 财务执行；认领/建议不写正式核销或支付事实 |
| vouchers:approve:pay_lt5 | 付款申请审批（≤5万RMB，财务主管） | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| vouchers:approve:pay_gt5 | 付款申请审批（>5万RMB，总监） | ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| vouchers:approve:pay_new_supplier | 首单付款+1级审批（总经理级） | ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| pricing:read | 定价与利润/退税率表查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| pricing:write | 退税率表维护/定价记录创建 | FINANCE、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| pricing:admin | 默认利润率/客户等级调整%/佣金规则配置 | ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| vat:read | 增值税发票/进项/销项查看 | FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| vat:write | VAT发票登记/勾选认证 | FINANCE、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| tax:read | 出口退税申报查看 | FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| tax:write | 退税申报录入 | FINANCE、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| tax:approve | 退税申报提交审批 | FINANCE、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| remit:read | 付汇水单/外汇业务查看 | FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| remit:write | 付汇水单登记 | FINANCE、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| fx:lock | 汇率锁定（远期结售汇）登记/分配 | FINANCE、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| risk:read | 风险管理-预警/信用/合规/质量 总览查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| risk:write | 预警确认/解决/信用评级录入 | SALES_MANAGER、FINANCE、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| risk:admin | 信用额度调整/合规豁免（高危，总监级） | ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| knowledge:read | 知识库/数据中心看板查看 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 资料ACL与版本引用；导入/搜索/附件同权限 |
| knowledge:write | 知识库文档创建/草稿 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 资料ACL与版本引用；导入/搜索/附件同权限 |
| knowledge:approve | 知识库文档发布审核 | ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| knowledge:admin | 归档/恢复/全库ACL配置 | ADMIN、SUPER_ADMIN | 资料ACL与版本引用；导入/搜索/附件同权限 |
| tools:execute | 业务工具（8个小工具）使用权限 | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| settings:account | 个人账户设置（密码/通知偏好/头像） | SALES、SALES_MANAGER、FINANCE、ADMIN、QC、LOGISTICS、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |
| settings:system:read | 系统设置查看（仅Admin可见内容） | ADMIN、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |
| users:read | 后台管理-用户/角色/部门查看 | ADMIN、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |
| users:write | 后台管理-用户创建/编辑/角色分配 | ADMIN、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |
| users:admin | 用户删除/权限矩阵修改/SuperAdmin角色授予（仅SuperAdmin） | ADMIN、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |
| audit:read | 审计日志查看 | FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| audit:export | 审计日志导出CSV（仅FinanceMan+/Admin+） | ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| dictionary:write | 数据字典（枚举值真源）增删改 | ADMIN、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |
| hr:read | HR人事-员工档案/考勤/薪酬查看 | FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| hr:write | HR人事-员工/入职/调动编辑 | ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| hr:salary:read | 薪酬明细查看（极敏感，仅SuperAdmin + 指定HR） | SUPER_ADMIN | 字段级明确授权；页面读权限不能代替；薪酬独立保密 |
| data:import | Excel批量导入（订单/产品/客户/供应商） | SALES、SALES_MANAGER、ADMIN、LOGISTICS、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| data:export:full | 全量数据导出/迁移（高危，仅SuperAdmin） | SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| sensitive:cost | 敏感-成本/采购价/BOM成本 查看（S:cost） | FINANCE、ADMIN、SUPER_ADMIN | 字段级明确授权；页面读权限不能代替；薪酬独立保密 |
| sensitive:profit | 敏感-毛利/毛利率/利润率 查看（S:profit） | FINANCE、ADMIN、SUPER_ADMIN | 字段级明确授权；页面读权限不能代替；薪酬独立保密 |
| sensitive:commission | 敏感-佣金率/佣金金额 查看（S:commission） | FINANCE、ADMIN、SUPER_ADMIN | 字段级明确授权；页面读权限不能代替；薪酬独立保密 |
| sensitive:salary | 敏感-员工薪酬明细 查看（S:salary） | SUPER_ADMIN | 字段级明确授权；页面读权限不能代替；薪酬独立保密 |
| sensitive:tax_base | 敏感-进项税/退税计税底值 查看（S:tax_base） | FINANCE、ADMIN、SUPER_ADMIN | 字段级明确授权；页面读权限不能代替；薪酬独立保密 |
| settings:moq:write | MOQ 阈值配置写入（设置后台） | ADMIN、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |
| settings:tolerance:write | 内部公差标准写入（设置后台；数量公差 / 幅宽扣款分档表） | ADMIN、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |
| moq:line_override | MOQ 行级覆盖申请（订单行降级/调整） | SALES、SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| moq:capsule_exemption:write | MOQ Capsule 档豁免审批/写入 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| order:change_request:create | 订单变更申请创建（交期/数量/价格） | SALES、SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| order:change_request:apply | 订单变更申请审批通过后的生效执行 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| sample:early_production:write | 早期生产样登记/写入（DR-015） | SALES、SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| sample:shipment:write | 船样登记/写入（S/S） | SALES、SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| sample:color_batch:write | 打色批次登记/客户判定写入（REQ2-01 色差管理） | SALES、SALES_MANAGER、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| sample:room:write | 样品间样卡登记/借出/归还/看样登记（REQ2-16） | SALES、SALES_MANAGER、ADMIN、SUPER_ADMIN | 对应业务员按对象权限操作；不设样品保管/仓储岗位 |
| production:pp_release:production_sign | 产前样放行-生产部签署（DR-053 阶段 2） | ADMIN、QC、SUPER_ADMIN | 跟单进度、QC事实、放行签署分开；按职责/版本/路由判断 |
| production:pp_release:business_sign | 产前样放行-业务部签署（DR-053 阶段 2） | SALES、SALES_MANAGER、ADMIN、SUPER_ADMIN | 跟单进度、QC事实、放行签署分开；按职责/版本/路由判断 |
| production:pp_release:admin | 产前样放行-暂停/撤销/恢复（DR-053 阶段 2） | SALES_MANAGER、ADMIN、SUPER_ADMIN | 跟单进度、QC事实、放行签署分开；按职责/版本/路由判断 |
| exception:dr013:create | DR-013 受控例外申请创建 | SALES、SALES_MANAGER、FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| finance:payment_request:create | 付款申请创建 | SALES、SALES_MANAGER、FINANCE、ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| finance:payment_request:approve | 付款申请审批 | SALES_MANAGER、ADMIN、SUPER_ADMIN | 适用审批路由及版本范围决定审批资格；不按scope旧说明自行发明阈值 |
| credit:freeze:write | 客户信用冻结（高危） | ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| credit:thaw:write | 客户信用解冻（高危） | ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| order:internal_trade:write | 内部交易（内部面料结算价 DR-006）写入 | ADMIN、SUPER_ADMIN | 按模块职责、具体动作、对象范围、状态及敏感字段细化后冻结 |
| qc:fabric_chain:write | QC 面料链（DR-029）业务登记写入 | SALES_MANAGER、ADMIN、QC、SUPER_ADMIN | 专业QC处理；发起/业务背景应与专业结论权限拆开（旧Sales拥有写权限不沿用） |
| qc:garment_chain:write | QC 成衣链业务登记写入 | SALES_MANAGER、ADMIN、QC、SUPER_ADMIN | 专业QC处理；发起/业务背景应与专业结论权限拆开（旧Sales拥有写权限不沿用） |
| settings:automation:write | 自动化规则配置写入（后台管理） | ADMIN、SUPER_ADMIN | 个人/组织/系统配置分别授权；技术管理不等于业务批准 |

## 七 不能遗漏的授权面

模块入口、列表/详情、字段、附件预览下载、导入导出、任务接手、代办、撤回、专业结果、审批签署、AI/API执行各自写权限条件。模块可达不能证明所有能力可用；关联对象可见不能扩大到该对象全部敏感字段。

补充兼容线索：CompanyProfileSection与MarketQuotesSection使用未列入129项目录的admin:write字面条件；不把它自动定义为目标新权限，也不能交coding agent自行解释。permissionService中的xxx:write属于示例，不登记实际权限。动态策略、Agent工具ACL和审批路由不能仅由字面权限扫描替代。
