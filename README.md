# Bambook · 项目现状与接力入口

## 项目是什么

Bambook 是公司内部业务系统，覆盖开发与寻样、报价、订单、采购、生产、质检、出运及财务。当前建设范围是公司端；客户和供应商独立平台另行规划。Mist Atelier 是唯一运行前端，Web 与 Electron 共用，仓库同时包含后端、数据结构和测试。

## 做到哪里

主线已包含当前 Mist 页面与业务接线、报价核算与历史对照、风险管理、售后索赔公司端调整，以及供应商票据与应付首轮。智能邮箱已纳入范围并完成前端首轮，真实收发尚未接通。各模块仍有业务接线、真实集成和验收缺口，不能把“已合入”理解为全站完成或正式部署。

## 当前工作

付款收尾批次已通过 [PR #20](https://github.com/guqinwen3g-netizen/bambook-main/pull/20) 合入 main `3740125`（此前应付收尾为 PR #19）。

**付款收尾批次已合入**（[PR #20](https://github.com/guqinwen3g-netizen/bambook-main/pull/20)，main `3740125`）：已确认的结算可不等票申请付款，票到自动抵扣；未收货合同可取消并处理预付；历史付款可补登、旧付款可对应计划；“从货款中扣”的追偿可改为工厂付款。合入后的浏览器验收与票据详情“先付抵扣”显示修复在分支 `fix/mist-ap-payments-qa`。口径见决策总账 8.4.1“付款收尾实现口径”。未部署，也不涉及真实资金。

报价成本 AI 审阅收尾中：原草稿 PR #8 已在最新主线上合并为新分支 `feat/quote-cost-ai-advisor-v2`，补了人工视觉复核与一处窄屏布局修复；AI 只审阅本行授权依据、价格由公式重算、人工采纳只改策略草稿。已可连接个人 ChatGPT 订阅（测试期用本人账号，默认 GPT-6-Luna · max 推理），本地已用真实模型完成小竹对话与报价 AI 审阅验收；正式版按每人自己的订阅或企业 API 配置。

当前停点与历史见 [进度记录](docs/mist-atelier/LIVE-PROGRESS.md)。开始或接续任务时核对 GitHub 实际分支 / PR，不能只凭这份摘要判断最新状态。

## 接下来往哪里走

继续完善公司端现有业务、补齐真实集成与验收缺口；报价 AI 的待验工作在对应 PR 收口。具体下一批按用户确定的优先级推进，不把客户 / 供应商独立平台默认为本轮范围。

一个能独立验收的小批次完成后及时通过 PR 合回主线；未完成成果注明分支、停点与下一步，避免长期积累。工作方式见 [AGENTS.md](AGENTS.md)，详细业务与技术资料按需从 [文档导航](docs/README.md) 查找。

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
