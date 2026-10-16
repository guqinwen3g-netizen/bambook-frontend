# 交接 · 2026-10-16 接手指引（云端 Agent）

> 给下一位接手的云端 Agent。先读本节，再按需看下方 2026-10-15 的速查（第 1–9 节，部分状态已过时，以本节和 GitHub 为准）。常设入口仍是 [README](../README.md) 与 [AGENTS.md](../AGENTS.md)。开始前**必须**重新核对 GitHub 实际分支 / PR / Actions 和开发服务器 `readlink -f /srv/bambook-dev/current`。

### A. 交接时的状态（2026-10-16 05:40Z）

| 位置 | 版本 | 说明 |
|---|---|---|
| GitHub `main` | `2ea11fd`（#53 合入） | 无开放 PR，无未合入功能分支 |
| 开发服务器 | `cd19b0a`（#52）已验证；`2ea11fd` 的 verify / 自动交付在跑 | 接手第一件事：经运维通道确认已切到 `2ea11fd` |
| 正式环境 | 未触碰 | — |

本轮合入：#49（文档）、#50（人事岗位 / 在职变动 / 订单毛利 / 管理员重置后强制改密）、#51（退出所有设备、老板调整角色权限）、#52（两步验证 TOTP + 恢复码、管理员重置两步验证、老板账号防线、账号列表不回显 metadata.mfa）、#53（本人改密退出其他设备并为当前设备换发令牌；调岗随岗位换部门并退出原小组；文档）。#50–#52 已在开发服务器用测试账号接口实测（含两步验证完整开启→登录→恢复码→关闭，测试账号已复原）；界面未用真实账号人工走查。

### B. 用户规则（覆盖下方第 2 节的旧写法）

- 中文、简洁、只讲实际进展；**不干等**：CI / 部署期间做别的，按确切 SHA 抽查。
- 范围已确认的批次：最新 head 的 CI 全绿后**直接** merge commit 合入（AGENTS.md），无需再问。只在公司特有业务规则、超范围、关键权限变更、数据迁移、正式环境、真实资金时停下来问。
- 用户已授权：通用专业知识（如毛利口径）与软件设计（安全、权限 UI 等）由 Agent 自行决定；只有公司特有业务规范需确认。
- 汇报时分开写：已推送 / 已合入 / 已部署开发服务器 / 人工验收（未做就写未做）/ 正式环境。
- README 只写“当前工作”；验证证据写在 PR；LIVE-PROGRESS 只记未合入停点。凭据不进仓库、日志、PR、聊天。

### C. 操作要点

- 推送：GitHub MCP `create_branch`（自 main）→ `push_files` → `create_pull_request` → CI 绿 → `merge_pull_request`（merge）。
- CI：PR 状态 `ci/mist-verify`（作业 changes / verify / report）。CI 只跑前端测试和服务端 `src/mist` + 共享 mist 测试；其他服务端测试（auth、admin、hr 等）**只能本地跑**，改这些代码要自己跑。
- 本地已知既有失败（与近期改动无关，已在未改动代码上复现）：`server/src/admin/route.test.ts` 5、`auth/__tests__/currentOrderLineWriteAccess` 42、`operationalReadBoundaries` 6、`danglingScopeConsumption` 4（引用已删文件）、`roleLabels` 3（qc:write 种子漂移）、`hr/route.test.ts` 2。值得单独开一个 PR 清理。
- 部署：main 的 Mist verification 成功后自动 “Bambook development delivery”，约 15 分钟，只部署 main 最新提交——**交付运行中再合入会使其失效**，连续合入时只有最后一个会部署。
- 运维通道：向 `ops-channel` 推 `ops/request.sh`（内容必须变化，可在首行加时间注释），约 30–60 秒后读 `ops/results/<请求提交SHA>.md`。测试账号文件 `/srv/bambook-dev/shared/test-accounts.txt`（制表符分隔：第 3 行管理员、第 6 行业务员、第 9 行物流；脚本里 `sudo awk` 取值，不要打印）。两步验证实测可在服务器上用 `node -e` 计算 TOTP。
- `JWT_SECRET` 同时派生两步验证密钥的加密钥匙：**更换它会让所有已绑定的验证器失效**，需管理员逐个“重置两步验证”。

### D. 下一步候选（按价值排序，开工前与用户的优先级对一下）

1. 确认 `2ea11fd` 已部署并冒烟（`/api/hr/personnel`、包内文案“部门随新岗位确定”）。
2. 清理上面列出的本地既有失败测试，或把 auth / admin / hr 测试纳入 CI。
3. 自定义角色新建 / 删除：先把约 68 处 `requireRole()` 旧角色判断迁到 `requirePermission(scope)`，否则自定义角色过不了这些检查；属关键权限变更，方案先给用户看。
4. 订单毛利：退税、费用、外币折算——用哪种汇率（合同 / 结汇）及退税口径是公司规则，需用户确认。
5. 智能邮箱应用接 IMAP/SMTP（README 第 4 项）；对外收发仍卡在 DNS / 25 端口。
6. 工作助手：桌面窗口与 host 重启重连未验（README 第 6 项）。
7. 用真实账号人工走查平台模块界面（管理后台、人事、报表中心、设置·安全）。

---

# 附：2026-10-15 收尾速查（部分已过时）

## 1. 一句话现状

主线包含公司端 Mist 全部菜单页的前端首轮与大部分业务接线（报价核算 / 历史对照 / AI 审阅、风险、售后索赔、应付 / 预付 / 结算 / 付款、跨岗位协作、审批与放行、我的工作待办、通知中心）、工作助手 P0 骨架，以及开发服务器部署流程与共享运维通道。**未正式部署**，正式环境未动；开发服务器运行的仍是旧版本（见第 4 节）。

## 2. 用户长期规则（务必遵守）

- 中文沟通，简洁讲实际进展；不要绕远路、不要干等、不要“掺水”。
- 只用 **merge commit** 合入，不 squash、不强推、不改写历史。
- （已过时，见 B 节）合入规则以 AGENTS.md 为准。
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

## 4. 版本一致性核对（2026-10-15 更新）

| 位置 | 版本 | 状态 |
|---|---|---|
| GitHub `main` | `aede4e4`（#35 合入；本文档同步 PR 合入后再前进一个提交） | `ci/mist-verify` 成功 |
| 开发服务器 `/srv/bambook-dev/current` | 随 main 自动部署，以运维通道 `readlink -f` 为准 | 已验证 `349db8d`、`6a72104` 自动部署成功，服务 active、健康 200 |
| 正式环境 | 不在范围，未触碰 | — |

**自动部署**（PR #33）：main 推送触发的 `Mist verification` 成功后，`Bambook development delivery` 经 `workflow_run` 部署该次 `head_sha`；要求该提交 `verify` check 成功，且只部署 main 最新提交（落后的运行直接失败，不回滚）。PR 上的验证不部署。服务器端 `npm ci` + `prisma generate` + `tsc` 约 15 分钟；交付作业超时已由 20 分钟提到 45 分钟（PR #36，首次自动部署 run 21 因此被 GitHub 取消但服务器已激活）。内外层超时已统一（发布脚本 2100 秒 < ssh 2280 秒 < 作业 50 分钟），超时会结束子进程并按标记回切，见 [开发环境部署](deployment/bambook-development.md)。

**每次合入后核对**：经运维通道核对 `readlink -f /srv/bambook-dev/current` 指向新 main SHA、两个服务 active、健康接口 200。

## 5. 开放 PR 与分支

### 开放 PR

- **#25 草稿** `feat/work-assistant-p1`（head `2c947ee`，基线旧 main `9955ee0`）：工作助手 P1 只读委托 + `bambook_query/get/expand`。本地 verify 全过；**待**：rebase/合并最新 main、GitHub CI、用户本人在桌面端用真实模型验收（含越权与 host 重启后重连）。验收前不合入。
- **#2** `feat/mist-fabric-development`（head `5d254d8`，base `feat/mist-dual-domain-foundation`，2026-10-13）：面料开发入口、返样与独立 QC。GitHub compare `main...5d254d8` 确认其两个提交 `d8961b4`、`5d254d8` **均已在 main 历史中**，可关闭；待用户同意后再关闭，未经同意不要关闭或删分支。

### 常驻分支

- `main`：唯一主线。
- `ops-channel`：开发服务器运维通道，**永不合入 main**，用法见 [开发服务器访问](ops/dev-server-access.md)。

### 已合入、可由用户决定删除的分支（head 与 PR 合入时一致）

`ci/bambook-dev-deployment`、`docs/dev-server-access`、`docs/realtime-collaboration`、`docs/relay-handoff-simplification`、`docs/work-assistant-plan`、`feat/mist-ap-closeout`、`feat/mist-ap-payments`、`feat/mist-approvals`、`feat/mist-claims-coordination`、`feat/mist-claims-internal-only`、`feat/mist-dual-domain-foundation`（#2 的 base，删前先处理 #2）、`feat/mist-fabric-commercial-units`、`feat/mist-prepayments`、`feat/mist-quote-history-compare`、`feat/mist-quote-history-evidence`、`feat/mist-quote-line-fee-allocation`、`feat/mist-risks-workbench`、`feat/mist-settlements`、`feat/mist-supplier-payables-2`、`feat/mist-work-queue`、`feat/mist-workspace-members`、`feat/quote-cost-ai-advisor-v2`、`feat/work-assistant-p0`、`fix/dev-delivery-report`、`fix/mist-ap-payments-qa`、`codex/mist-main-integration-2026-10-14`（无 PR，提交已在 main 历史）。

已关闭未合入（被取代）：`feat/mist-supplier-payables`（#14 → #15）、`feat/quote-cost-ai-advisor`（#8 → #22）。

## 6. 下一步：用户确认的 6 项顺序

1. ~~审批与放行 + 付款申请审批~~：已合入 #27。缺口：生产与出运放行、受控例外、报价偏差 / 索赔方案等类型尚无服务端规则，页面明示“未接入”；转交未做。
2. ~~我的工作待办 + 通知中心~~：已合入 #29。缺口：主管按团队视角（缺团队组织数据）；“出运资料回业务”以“已出运未寄单”近似。
3. ~~财务剩余缺口~~：已合入 #32（核销 / 付款冲回）、#34（银行账户 / 期初 / 归属）、#35（锁汇 / 结汇）。缺口：汇兑损益与敞口报表、附件、导入时指定账户、账户停用。原拆分记录：
   - (a) 核销冲回 / 付款冲回：新增 `finance.allocation.reverse`、`finance.payment.reverse`，必须写原因、保留原记录与冲回记录（参考应付侧已有的 `PayableReversal`），并受 `server/src/shared/mistOrderFunding.ts` 的 `assertOrderFundingIntegrity`（按 allocations 归属订单到款）约束，冲回后订单到款回算。
   - (b) 银行账户 / 期初余额 / 逐笔流水账户归属；账户余额 = 期初 + 归属流水，不再显示“未接入”。
   - (c) 锁汇 / 结汇记录（原币、汇率、本币、银行、日期），不做汇率估算。
   - 代码锚点：`server/src/shared/mistWorkspace.ts` 约 538–570 行（`importReceipts` / `reconcile` / `acceptSuggestions` / `payment.save`），类型 `MistReceipt` / `MistAllocation` / `MistPayment` 约 69–74 行；需求见 [页面清单 §5.1](mist-atelier/07-frontend-page-inventory.md)。
4. **下一项** 智能邮箱真实收发（IMAP/SMTP）：需用户提供测试邮箱，凭据只进服务器环境变量。
5. ~~平台类模块~~：已合入 #45–#48，以及 #50（岗位 / 在职变动 / 订单毛利 / 强制改密）、#51（退出所有设备 / 角色权限调整，仅老板）、#52（两步验证 TOTP + 恢复码、管理员重置两步验证、老板账号防线）、#53（改密自动退出其他设备；调岗随岗位换部门并退出原小组）。两步验证密钥用 JWT_SECRET 派生密钥加密存于账号 metadata.mfa——**更换 JWT_SECRET 会使已绑定的验证器失效**，需管理员逐个重置。未做：毛利退税 / 费用 / 汇率、自定义角色增删。
6. 工作助手 P2–P4（先完成 #25 的真实验收）。

## 7. 各页面现状速查

逐页需求、角色、状态与缺口以 [07 · 全站前端页面清单](mist-atelier/07-frontend-page-inventory.md) 为准（本次已同步 `approvals` / `notifications` / `cockpit` 行）。概览：

- **订单履约**（开发与寻样、样品、订单、QC、货运、报价、数字档案、生产进度、采购、库存、报关、单据中心、历史加工）：前端一轮完成并接工作空间命令；报价有专业核算、客户反馈、历史对照、AI 审阅。缺口见清单各节“未接入”。
- **财务与成本**：收款核销、应收、应付票据 / 付款申请审批 / 预付 / 结算 / 付款已接；冲回、银行账户、汇兑见第 6 节第 3 项。发票、定价、成本核算、风险、售后索赔为首轮。
- **客户与市场**：CRM、供应商、关系智库、季节、营销首轮完成；询价比价、在手业务交接、画册导出未接入。
- **我的事务**：我的工作（待办来源已补齐）、日历、智能邮箱（仅前端，真实收发未接）、全景看板（只读）。
- **平台**：设置（`section` 直达；安全页可修改登录密码）、管理后台（`section=accounts|roles|audit|profile|ai`）、人事管理（`section=org|people`，服务器组织架构；本地工作区仅说明）、报表中心（`section=sales|aging|orders`）、业务全景、数据中心、业务工具、AI 助手 / 工作助手 P0。
- **菜单外**：审批与放行（#27）、通知中心（#29）、统一搜索（⌘K + 结果页 `?view=search&section=<关键词>`，#46）。

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
