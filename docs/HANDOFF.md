# 交接 · 2026-10-15 收尾

> 给下一位接手的 Agent。本页是一次性收尾快照，写于 main `ea41cbe`（PR #29 合入）之后、本交接 PR 之前。开始工作前**必须**重新核对 GitHub 实际分支 / PR / Actions，以 GitHub 为准；常设入口仍是 [README](../README.md) 与 [AGENTS.md](../AGENTS.md)。

## 1. 一句话现状

主线包含公司端 Mist 全部菜单页的前端首轮与大部分业务接线（报价核算 / 历史对照 / AI 审阅、风险、售后索赔、应付 / 预付 / 结算 / 付款、跨岗位协作、审批与放行、我的工作待办、通知中心）、工作助手 P0 骨架，以及开发服务器部署流程与共享运维通道。**未正式部署**，正式环境未动；开发服务器运行的仍是旧版本（见第 4 节）。

## 2. 用户长期规则（务必遵守）

- 中文沟通，简洁讲实际进展；不要绕远路、不要干等、不要“掺水”。
- 只用 **merge commit** 合入，不 squash、不强推、不改写历史。
- 最新 head 的 CI（`ci/mist-verify` = verify 成功）后，**先问用户是否合入**，用户同意才合。
- mock / 模拟桥不能冒充真实模型或真实集成验收。
- 凭据不写进仓库、日志、PR 或聊天。
- 不动正式环境（Mac mini、`jiangsupanda.com`），不动真实资金；不擅自删除他人分支或关闭他人 PR。
- 每项一个可独立验收的 PR；未完成成果写明分支、停点、下一步。

## 3. 本轮（2026-10-15）合入记录

| PR | 内容 | main 合入提交 |
|---|---|---|
| #26 | 开发服务器部署流程（`bambook-dev-deploy.yml`、`scripts/deploy/*`、receiver） | `44458c9` |
| #27 | 审批与放行页 `approvals` + 付款申请审批 | `fbf1ab6` |
| #28 | 运维通道文档 `docs/ops/dev-server-access.md`、AGENTS“服务器与后端访问” | `e5cafcd` |
| #30 | 修部署流程 report 作业环境变量名 | `f642b3f` |
| #29 | 我的工作待办来源补齐 + 通知中心 `notifications` | `ea41cbe` |

更早已合入：#1、#4–#7、#9–#13、#15–#24（详见各 PR 与 [LIVE-PROGRESS](mist-atelier/LIVE-PROGRESS.md) 历史段落）。

## 4. 版本一致性核对（2026-10-15）

| 位置 | 版本 | 状态 |
|---|---|---|
| GitHub `main` | `ea41cbe`（本交接 PR 合入后会前进一个文档提交） | PR #29 head `f212d27` 的 `ci/mist-verify` 成功 |
| 开发服务器 `/srv/bambook-dev/current` | `releases/544f1c9…`（旧） | 服务 `bambook-dev`、`bambook-dev-mist` active，`127.0.0.1:8081/api/health` 200 |
| 正式环境 | 不在范围，未触碰 | — |

**差异原因（已处理）**：原部署流程只能手动 `workflow_dispatch`。PR #33 起改为自动：main 推送触发的 `Mist verification` 成功后，`Bambook development delivery` 经 `workflow_run` 部署该次运行的 `head_sha`；仍要求该提交 `verify` check 成功，且只部署 main 最新提交（落后的运行直接失败，不回滚）。验证失败或 PR 上的验证不会部署。

**每次合入后核对**：经运维通道核对 `readlink -f /srv/bambook-dev/current` 指向新 main SHA、两个服务 active、健康接口 200。`mode=check` 已于 run 38739662842 验证通道可用。

## 5. 开放 PR 与分支

### 开放 PR

- **#25 草稿** `feat/work-assistant-p1`（head `2c947ee`，基线旧 main `9955ee0`）：工作助手 P1 只读委托 + `bambook_query/get/expand`。本地 verify 全过；**待**：rebase/合并最新 main、GitHub CI、用户本人在桌面端用真实模型验收（含越权与 host 重启后重连）。验收前不合入。
- **#2** `feat/mist-fabric-development`（head `5d254d8`，base `feat/mist-dual-domain-foundation`，2026-10-13）：面料开发入口、返样与独立 QC。核对发现其代码（如 `components/mist/patterns.tsx` 的 `VerticalSteps` 自动滚动）已随后续集成进入 main，**疑似已被取代**。建议向用户确认后关闭；未经同意不要关闭或删分支。

### 常驻分支

- `main`：唯一主线。
- `ops-channel`：开发服务器运维通道，**永不合入 main**，用法见 [开发服务器访问](ops/dev-server-access.md)。

### 已合入、可由用户决定删除的分支（head 与 PR 合入时一致）

`ci/bambook-dev-deployment`、`docs/dev-server-access`、`docs/realtime-collaboration`、`docs/relay-handoff-simplification`、`docs/work-assistant-plan`、`feat/mist-ap-closeout`、`feat/mist-ap-payments`、`feat/mist-approvals`、`feat/mist-claims-coordination`、`feat/mist-claims-internal-only`、`feat/mist-dual-domain-foundation`（#2 的 base，删前先处理 #2）、`feat/mist-fabric-commercial-units`、`feat/mist-prepayments`、`feat/mist-quote-history-compare`、`feat/mist-quote-history-evidence`、`feat/mist-quote-line-fee-allocation`、`feat/mist-risks-workbench`、`feat/mist-settlements`、`feat/mist-supplier-payables-2`、`feat/mist-work-queue`、`feat/mist-workspace-members`、`feat/quote-cost-ai-advisor-v2`、`feat/work-assistant-p0`、`fix/dev-delivery-report`、`fix/mist-ap-payments-qa`、`codex/mist-main-integration-2026-10-14`（无 PR，提交已在 main 历史）。

已关闭未合入（被取代）：`feat/mist-supplier-payables`（#14 → #15）、`feat/quote-cost-ai-advisor`（#8 → #22）。

## 6. 下一步：用户确认的 6 项顺序

1. ~~审批与放行 + 付款申请审批~~：已合入 #27。缺口：生产与出运放行、受控例外、报价偏差 / 索赔方案等类型尚无服务端规则，页面明示“未接入”；转交未做。
2. ~~我的工作待办 + 通知中心~~：已合入 #29。缺口：主管按团队视角（缺团队组织数据）；“出运资料回业务”以“已出运未寄单”近似。
3. **财务剩余缺口（下一项，尚未开分支）**。建议拆 3 个 PR：
   - (a) 核销冲回 / 付款冲回：新增 `finance.allocation.reverse`、`finance.payment.reverse`，必须写原因、保留原记录与冲回记录（参考应付侧已有的 `PayableReversal`），并受 `server/src/shared/mistOrderFunding.ts` 的 `assertOrderFundingIntegrity`（按 allocations 归属订单到款）约束，冲回后订单到款回算。
   - (b) 银行账户 / 期初余额 / 逐笔流水账户归属；账户余额 = 期初 + 归属流水，不再显示“未接入”。
   - (c) 锁汇 / 结汇记录（原币、汇率、本币、银行、日期），不做汇率估算。
   - 代码锚点：`server/src/shared/mistWorkspace.ts` 约 538–570 行（`importReceipts` / `reconcile` / `acceptSuggestions` / `payment.save`），类型 `MistReceipt` / `MistAllocation` / `MistPayment` 约 69–74 行；需求见 [页面清单 §5.1](mist-atelier/07-frontend-page-inventory.md)。
4. 智能邮箱真实收发（IMAP/SMTP）：需用户提供测试邮箱，凭据只进服务器环境变量。
5. 平台类模块：管理后台、设置、人事、报表、数据中心、业务工具、统一搜索。
6. 工作助手 P2–P4（先完成 #25 的真实验收）。

## 7. 各页面现状速查

逐页需求、角色、状态与缺口以 [07 · 全站前端页面清单](mist-atelier/07-frontend-page-inventory.md) 为准（本次已同步 `approvals` / `notifications` / `cockpit` 行）。概览：

- **订单履约**（开发与寻样、样品、订单、QC、货运、报价、数字档案、生产进度、采购、库存、报关、单据中心、历史加工）：前端一轮完成并接工作空间命令；报价有专业核算、客户反馈、历史对照、AI 审阅。缺口见清单各节“未接入”。
- **财务与成本**：收款核销、应收、应付票据 / 付款申请审批 / 预付 / 结算 / 付款已接；冲回、银行账户、汇兑见第 6 节第 3 项。发票、定价、成本核算、风险、售后索赔为首轮。
- **客户与市场**：CRM、供应商、关系智库、季节、营销首轮完成；询价比价、在手业务交接、画册导出未接入。
- **我的事务**：我的工作（待办来源已补齐）、日历、智能邮箱（仅前端，真实收发未接）、全景看板（只读）。
- **平台**：设置（支持 `section` 直达通知订阅）、管理后台、AI 助手 / 工作助手 P0；报表、数据中心、人事、业务工具为通用页，待第 5 项重做。
- **菜单外**：审批与放行（#27）、通知中心（#29）、统一搜索（命令面板，结果页待第 5 项）。

## 8. 工程速查

- 本地：Node 22；`npm ci && npm ci --prefix server && (cd server && npm exec -- prisma generate) && npm run dev:mist`（前端 3001，本地文件 API 8082）。
- 验证：`npm run verify:mist`（类型、前后端测试、构建、Mist 规范）；CI 为 `.github/workflows/mist.yml`，PR 状态名 `ci/mist-verify`。
- 主要目录：`pages/`（Mist 页面）、`runtime/`（前端派生逻辑，如 `workQueue.ts`）、`components/mist/`（组件与 token）、`server/src/shared/mist*.ts`（工作空间命令与规则）、`electron/assistant/`（工作助手）、`scripts/deploy/`（部署）、`docs/`（[文档导航](README.md)）。
- 工作流：`mist.yml`（verify）、`bambook-dev-deploy.yml`（开发服务器：main 验证通过后自动 deploy；也可手动 check / deploy）、`bambook-dev-ops.yml`（`ops-channel` 推送 `ops/request.sh` 执行，结果写回 `ops/results/<SHA>.md`）。
- 开发服务器：腾讯云 `https://bambook-dev.sylway.cloud`，服务 `bambook-dev`（主 API）、`bambook-dev-mist`（Mist API 8081/8082，nginx 8080），库 `panda_hub_dev`；测试账号在服务器 `/srv/bambook-dev/shared/test-accounts.txt`（不入库）。所需 SSH 钥匙已存为仓库 Actions secrets（`BAMBOOK_DEV_OPS_SSH_KEY`、`BAMBOOK_DEV_SSH_KEY`、`BAMBOOK_DEV_KNOWN_HOSTS`），Agent 不需要也不应持有私钥。
- 工具限制：当前 GitHub token 不能建 issue、不能触发 Actions、不能删分支；需要时请用户在网页操作或授权浏览器登录。

## 9. 已知风险 / 待用户决定

- 开发服务器随 main 自动部署（第 4 节）；部署失败时看 Actions 运行与 `ci/bambook-dev-delivery` 状态。
- #25 等用户真实模型验收；#2 是否关闭。
- 业务员是否获得 `risk:write`（页面清单 §5.5）。
- 已合入分支是否批量删除（第 5 节清单）。
- 依赖审计告警未消除；Node 24 下服务端 `better-sqlite3` 构建不兼容，暂只声明 Node 22。
