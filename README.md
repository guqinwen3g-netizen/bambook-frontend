# Bambook 开发工作区

应用源码、开发验证与维护记录，当前仍在持续开发和验收。

- [协作与接续规则](AGENTS.md)
- [文档导航](docs/README.md)
- [工作停点与进度记录](docs/mist-atelier/LIVE-PROGRESS.md)

<details>
<summary>项目范围、当前工作与接力记录</summary>

## 项目是什么

Bambook 是公司内部业务系统，覆盖开发与寻样、报价、订单、采购、生产、质检、出运及财务。当前建设范围是公司端；客户和供应商独立平台另行规划。Mist Atelier 是唯一运行前端，Web 与 Electron 共用，仓库同时包含后端、数据结构和测试。

## 做到哪里

主线已包含当前 Mist 页面与业务接线、报价核算 / 历史对照 / AI 审阅、风险管理、售后索赔公司端调整、供应商票据 / 预付 / 结算 / 付款、跨岗位协作、审批与放行、我的工作待办与通知中心，以及工作助手 P0 骨架和开发服务器部署流程。智能邮箱已纳入范围并完成前端首轮，真实收发尚未接通。各模块仍有业务接线、真实集成和验收缺口，不能把“已合入”理解为全站完成或正式部署。

## 当前工作

近期收口：费用与计费闭环（[PR #114](https://github.com/guqinwen3g-netizen/bambook-main/pull/114)）、风险分级处理权限（[PR #115](https://github.com/guqinwen3g-netizen/bambook-main/pull/115)）、CI 纯文档路径分类修复（[PR #119](https://github.com/guqinwen3g-netizen/bambook-main/pull/119)）已合入；报表汇率与含退税毛利的数据契约调查（[PR #117](https://github.com/guqinwen3g-netizen/bambook-main/pull/117)）已合入，只是调查文档，报表功能尚未完成。开发轮次时间线与多版本对比在 [PR #118](https://github.com/guqinwen3g-netizen/bambook-main/pull/118)，仍由总协调收口。此前一批：开发轮次 / 版本 / 通知单 / 面料多形态与寄样（[PR #112](https://github.com/guqinwen3g-netizen/bambook-main/pull/112)）、订单来源 / 规格数量 / 出运与取消（[PR #108](https://github.com/guqinwen3g-netizen/bambook-main/pull/108)）、并发保存（[PR #111](https://github.com/guqinwen3g-netizen/bambook-main/pull/111)）。准确合入、部署、验证范围和后续事项以各 PR 与 Notion 原总控为准；正式环境未发布，也不代表全公司业务验收完成。

> **新 Agent 接手入口**：先读当前版本的 [长期工作与验证规则](AGENTS.md)，再读所认领任务的范围和验收条件。流程规则统一在 AGENTS.md 维护；[交接文档](docs/HANDOFF.md) 保留历史上下文，旧状态、测试覆盖和候选事项须按当前 GitHub 与代码核对。

**现行开工方式（用户 2026-10-16 确认）**：完整任务包全部做完、本地自测通过后，一次性提交一个 PR 并交接，实施 Agent 随即结束本批工作，不主动查询、不检查、不等待或轮询 CI 结果；系统自动跑 CI，后续独立复核、失败处理和合入由总协调接手。总协调按用户已确认的 Agent 可用性和最新真实回执派发完整任务包，实时执行位见 Notion 原总控。旧任务单、交接或模板中让实施 Agent 等待 CI、验收或合入的冲突要求不再执行。详细分工与合入门槛见 [AGENTS.md](AGENTS.md)。

以下为已有工作的状态记录；开始或接续任务时须核对最新分支 / PR：

1. 审批与放行页面 `approvals` + 付款申请审批：已合入（[PR #27](https://github.com/guqinwen3g-netizen/bambook-main/pull/27)）。生产与出运放行、受控例外尚无服务端规则，页面明示未接入。
2. 我的工作待办来源补齐 + 通知中心 `notifications`：已合入（[PR #29](https://github.com/guqinwen3g-netizen/bambook-main/pull/29)）。主管按团队视角未做（缺团队组织数据）。
3. 财务剩余缺口：已合入。(a) 核销冲回 / 付款冲回（[PR #32](https://github.com/guqinwen3g-netizen/bambook-main/pull/32)）；(b) 银行账户 / 期初 / 逐笔归属（[PR #34](https://github.com/guqinwen3g-netizen/bambook-main/pull/34)）；(c) 锁汇 / 结汇记录（[PR #35](https://github.com/guqinwen3g-netizen/bambook-main/pull/35)）。未做：汇兑损益 / 敞口报表、附件、导入时直接指定账户、账户停用。
4. 智能邮箱真实收发：开发服务器已自建 `sylway.cloud` 邮箱（Postfix + Dovecot，只在本机回环监听，4 个测试邮箱，密码只在服务器 root 文件），站内互发已实测，安装脚本与说明已入库（[PR #40](https://github.com/guqinwen3g-netizen/bambook-main/pull/40)）；对外收发待 Cloudflare DNS、腾讯云 25 端口解封 / 反向解析 / 安全组。应用接入内部 IMAP/SMTP 已安排真实接线，真实收发尚未验收接通；外网 DNS / 25 端口只限制对外收发，不妨碍应用接内部服务器，外部真实收发仍不可用。
5. 平台类模块：已合入。(a) 管理后台账号 / 角色 / 注册审批 / 审计日志 + 人事组织架构（[PR #45](https://github.com/guqinwen3g-netizen/bambook-main/pull/45)）；(b) 统一搜索结果页（[PR #46](https://github.com/guqinwen3g-netizen/bambook-main/pull/46)）；(c) 报表中心客户销售额 / 应收账龄 / 订单进度与逾期 + 业务全景 + 数据中心（[PR #47](https://github.com/guqinwen3g-netizen/bambook-main/pull/47)）；(d) 设置 · 安全修改登录密码 + 业务工具换算（[PR #48](https://github.com/guqinwen3g-netizen/bambook-main/pull/48)）；(e) 人事岗位维护、在职变动记录（转正 / 调岗 / 晋升 / 停职 / 复职 / 离职 / 返聘）、报表中心「订单毛利」（合同口径：已审批订单收入 − 已审批采购，外币采购不折算只标注）、管理员重置密码后强制改密（[PR #50](https://github.com/guqinwen3g-netizen/bambook-main/pull/50)）；(f) 退出所有设备、老板可在角色页调整权限（[PR #51](https://github.com/guqinwen3g-netizen/bambook-main/pull/51)）；(g) 两步验证（验证器动态码 + 恢复码，管理员可重置）与老板账号防线（非老板不能改 / 重置 / 停用老板账号）（[PR #52](https://github.com/guqinwen3g-netizen/bambook-main/pull/52)）；(h) 本人改密后其他设备自动退出、当前设备换发新令牌；调岗到其他部门的岗位时部门随岗位调整并退出原小组（[PR #53](https://github.com/guqinwen3g-netizen/bambook-main/pull/53)）。(a)–(f) 已部署开发服务器并接口冒烟（含退出所有设备真实账号实测：旧令牌 401、重新登录正常）；(g) 已部署并实测两步验证完整流程；(h) 随 `2ea11fd` 交付。界面未用真实账号人工走查。未做：毛利不含退税 / 费用、不做汇率折算；自定义角色新建 / 删除；外部邮箱（搁置）。
6. 工作助手：P1 只读委托已合入（[PR #25](https://github.com/guqinwen3g-netizen/bambook-main/pull/25)，用户账号真实模型只读验收通过；桌面窗口与 host 重启重连未验）。不可读类型如实说明、不提出没有的起草能力已修（[PR #42](https://github.com/guqinwen3g-netizen/bambook-main/pull/42)，真实模型复测通过）。P2–P4 未开始。

开发服务器（腾讯云 bambook-dev）：部署流程 [PR #26](https://github.com/guqinwen3g-netizen/bambook-main/pull/26) / [#30](https://github.com/guqinwen3g-netizen/bambook-main/pull/30) 已合入，`check` 已通过。自 [PR #33](https://github.com/guqinwen3g-netizen/bambook-main/pull/33) 起，main 每次推送的 `Mist verification` 成功后自动部署该提交（服务器端实测约 2.5 分钟：`npm ci` 77s、`tsc` 54s；lockfile 未变时复用上一版依赖，[PR #43](https://github.com/guqinwen3g-netizen/bambook-main/pull/43)；超时预算与中断回切见 [开发环境部署](docs/deployment/bambook-development.md)；仍可在 Actions 手动 check / deploy）；当前服务器版本以运维通道 `readlink -f /srv/bambook-dev/current` 为准。所有 agent 经仓库运维通道访问，见 [开发服务器访问](docs/ops/dev-server-access.md)。正式环境（Mac mini、`jiangsupanda.com`）不在范围。

AI 分为“工作助手”（桌面端本机、个人凭据，方案见 `docs/mist-atelier/work-assistant-plan.md`，P0 骨架已合入 `electron/assistant/`，P1 见 PR #25）与“平台 AI”（统一平台连接）两层。报价成本 AI 审阅已合入（PR #22）：AI 只审阅本行授权依据、价格由公式重算、人工采纳只改策略草稿。平台 AI 可由管理员连接 ChatGPT 订阅作测试平台模型（GPT-6-Luna），生产期改用企业 API。

当前停点与历史见 [进度记录](docs/mist-atelier/LIVE-PROGRESS.md)。开始或接续任务时核对 GitHub 实际分支 / PR，不能只凭这份摘要判断最新状态。

## 接下来往哪里走

继续完善公司端现有业务、补齐真实集成与验收缺口。具体下一批按用户确定的优先级推进，不把客户 / 供应商独立平台默认为本轮范围。

下一轮按总协调明确的完整任务包开发、本地自测、一次 PR 并交接；CI、独立复核和合入由总协调收口。中途可推送任务分支保存进度，未完成成果注明停点与下一步。工作方式见 [AGENTS.md](AGENTS.md)，详细业务与技术资料按需从 [文档导航](docs/README.md) 查找。

</details>

<details>
<summary>本地开发与验证说明</summary>

## 本地开发

推荐 Node.js 22 LTS。

```sh
nvm use # 或使用 Node.js 22
npm ci
npm ci --prefix server
(cd server && npm exec -- prisma generate)
npm run dev:mist
```

主应用 `http://127.0.0.1:3001/`；本地文件工作空间API在8082，无需旧PostgreSQL账号，首次使用会创建本机空间与会话密钥。不要把本机运行数据或密钥提交到GitHub。

查看最新示例：侧栏左上角工作空间 → 输入新名称 → **创建演示工作空间**。示例数据版本在账号面板单独显示；已有空间不会被代码更新改写，也不需要删除 `server/private/mist-local/`。本地日志、附件、数据库和会话密钥都不进入 Git。正式记录使用空白工作空间。

参考源码预览：`npm run mist:ref` → `http://127.0.0.1:3131/`，与主应用共用Mist源码。

## 阅读顺序

先看本页与 `AGENTS.md`，接续任务时查看进度停点和相关 PR。以下详细资料按任务需要读取，不要求每次全部展开。

- `docs/mist-atelier/README.md`：视觉、组件与开发入口。
- `docs/mist-atelier/05-migration-playbook.md`：当前实施、已验证分支与未验证范围。
- `docs/design/global/2026-10-06/08-2026-10-06-对话设计决策总账.md`：有效业务裁决；历史视觉说明以Mist最新裁决覆盖。
- `docs/README.md`：有效工程/业务文档导航。

本地模式用于联调及评审；不代表真实银行、物流、外部供应商集成、PostgreSQL并发和全部业务分支已验收。当前AI及部分专业能力仍有明确边界，详见推进手册。

完整生产API源码也在`server/`，需按`server/.env.example`自行配置；本快照不含任何真实环境密钥、旧数据转储、个人Agent记忆、node_modules或构建产物。

## 初始快照验证（历史基线）

在隔离发布目录验证：Mist前端36文件549项、Mist后端27文件357项通过；主构建通过；Mist规则检查84文件0错误/0警告；独立本地API health返回`mode=local, storage=local-file`。`npm test`用于当前Mist前端，`npm run test:mist:server`用于当前Mist后端。安装依赖验证使用本机既有依赖，未声称所有平台的全新npm ci已实测。视觉/真实业务验收及其范围见推进手册和最新Mist证据，不以构建或单元测试代替视觉认可。

## 当前 Mist 的可复现检查

```sh
npm run verify:mist
```

包含当前 Mist UI/服务类型检查、前后端测试、构建及 Mist 规范检查。`.github/workflows/mist.yml` 对以 `main` 为目标的 PR、`main` 推送及手动执行提供同一检查：Node 版本读取 `.nvmrc`，使用前后端各自锁文件执行 `npm ci`，生成 Prisma client 后运行 `verify:mist`。工作流只读仓库，不迁移数据库、不调用生产服务、不部署。GitHub 上的实际结果以 Actions 为准，存在配置不代表远端已经通过。类型检查只覆盖当前 Mist 入口和服务依赖图，不代表历史目录或整个生产 API 无类型问题。

本轮在 Linux / Node.js 22 完成前后端全新 `npm ci`；Node.js 24 安装服务端时遇到现有 `better-sqlite3` 原生构建兼容问题，暂不声明支持。现有依赖审计告警尚未消除，不能据此宣称生产发布就绪。最新功能与视觉验收边界见推进手册。

</details>
