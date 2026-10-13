# OPSPanel 与 MacMini 部署拓扑 (OPS Panel & Mac Mini Deployment Topology)

## §1 元信息

| 项 | 值 |
|---|---|
| **文档定位** | 08-集成与边界域的"部署运维拓扑"——定义 Bambook 的生产部署架构（Mac Mini 数据中心 + OPS Panel 运维面）、push-based 部署流程（开发机打包 → 上传 OPS Panel → Mac Mini 本地解压）、OPS Panel 操作动作清单与服务状态监控 |
| **核心受众** | 系统管理员（总领导，含运维/后端/开发工程师宽泛职能：部署 + 监控、服务配置、发布流程）、超级管理员（老板，绝密级可见：部署拓扑理解） |
| **范式** | 拓扑规格文档（架构图 + 部署流程 + 操作清单 + 服务矩阵），含已落地操作 |
| **优先级** | P0（生产部署的唯一真源，所有发布必须遵循 push-based 流程） |
| **实现状态** | ✅ 已全量落地——Mac Mini 数据中心稳定运行（Express + Prisma + PostgreSQL + Agent Runtime + LLM 网关 + TTS + OPS Panel）；OPS Panel（ops.jiangsupanda.com:8088）提供 8 项操作动作（routine/deploy/danger 三组）+ 服务状态监控 + 远程开发任务 + 分块上传部署；push-based 部署链路（deploy:web / deploy:server / deploy:all）已打通，Token 从 macOS Keychain 自动读取；Cloudflare Tunnel 公网入口 + 分块上传（>300KB 自动切分 192KB 块）已就位 |
| **关联 PRD 章节** | §10 约束与风险（Mac Mini 不从 GitHub 拉代码）、project_rules.md Mac Mini 部署段 |
| **关联代码** | [ops-panel/src/index.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/ops-panel/src/index.ts) OPS Panel 真源 / [ops-upload-webapp.sh](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/scripts/ops-upload-webapp.sh) webapp 部署脚本 / [ops-upload-package.sh](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/scripts/ops-upload-package.sh) server 部署脚本 / [project_rules.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/.trae/rules/project_rules.md) 部署规则 |

---

## §2 部署拓扑总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                         开发机（macOS）                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │ Electron +  │  │  npm run    │  │ macOS       │                  │
│  │ React 源码  │  │  deploy:web │  │ Keychain    │                  │
│  │             │  │  (打包构建) │  │ (Ops Token) │                  │
│  └─────────────┘  └──────┬──────┘  └──────┬──────┘                  │
│                          │                │                          │
│                          ▼                │                          │
│                  ┌──────────────┐         │                          │
│                  │ tar.gz 包    │         │                          │
│                  │ (dist/ 或    │         │                          │
│                  │  server/)    │         │                          │
│                  └──────┬───────┘         │                          │
│                         │                 │                          │
└─────────────────────────┼─────────────────┼──────────────────────────┘
                          │ HTTPS 上传       │ Token 读取
                          ▼                 │
┌──────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Tunnel（公网入口）                       │
│         ops.jiangsupanda.com → Mac Mini :8088 (OPS Panel)             │
│         jiangsupanda.com/bambook/api → Mac Mini :8081 (主 API)        │
│         jiangsupanda.com/bambook/api/app → webapp 静态 serve          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Mac Mini 数据中心                               │
│  ┌──────────────────────────────────────────────────────────┐        │
│  │  OPS Panel (:8088)                                       │        │
│  │  • 接收 tar.gz → 解压部署                                │        │
│  │  • 8 项操作动作（routine/deploy/danger）                 │        │
│  │  • 服务状态监控 + 远程开发任务                           │        │
│  │  • ADMIN_TOKEN 守卫（生产必填）                          │        │
│  └──────────┬───────────────────────────────────┬───────────┘        │
│             │                                    │                    │
│             ▼                                    ▼                    │
│  ┌──────────────────┐        ┌──────────────────────────────┐        │
│  │ 主 API (:8081)    │        │ 知识库 API (:8091)            │        │
│  │ Express + Prisma  │        │ KB / RAG                     │        │
│  │ + Agent Runtime   │        └──────────────────────────────┘        │
│  │ + LLM 网关        │                                                │
│  └────────┬─────────┘        ┌──────────────────────────────┐        │
│           │                  │ Melo TTS (:8765)              │        │
│           ▼                  └──────────────────────────────┘        │
│  ┌──────────────────┐                                                │
│  │ PostgreSQL       │        ┌──────────────────────────────┐        │
│  │ (业务真源)        │        │ webapp/ (静态资源)            │        │
│  └──────────────────┘        │ ~/bambook-main-api/webapp/   │        │
│                               └──────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## §3 push-based 部署铁律

源自 project_rules.md Mac Mini 部署段：

| 铁律 | 说明 |
|------|------|
| **不要用 SSH** | 用 OPS Panel（ops.jiangsupanda.com）更稳定 |
| **push-based 部署** | 开发机打包 tarball → 上传 OPS Panel → Mac Mini 本地解压部署 |
| **Mac Mini 不从 GitHub 拉代码** | 代码经 tarball 推送，不经 git pull |
| **一键部署** | `npm run deploy:web`（Ops Token 从 macOS Keychain 自动读取） |
| **后续可打通 GitHub 自动更新** | com.bambook.ops-panel-auto 每分钟轮询（规划中） |

**部署通道已收敛到 `migrate deploy` 单一真源（2026-08-28 运维冲刺任务 2）**：
- `server/scripts/run-main-data-api.sh` 与 OPS Panel `deployUploadedPackage` 均已删除 `prisma db push --accept-data-loss`，schema 变更只走 `npx prisma migrate deploy`（严格按迁移账本，禁止绕过账本静默丢列）。
- 迁移账本断链（库曾以 db push 领先账本运行）时，先执行 `npx ts-node scripts/fix-migration-ledger.ts --apply` 补账（对已生效未记账迁移逐个 `migrate resolve --applied`），再 `migrate deploy`；所有 `ADD COLUMN` 迁移已幂等化（`IF NOT EXISTS`），重跑安全。
- 六表（FabricProfile/DevelopmentCase/Invoice/PaymentVoucher/Shipment/MaterialReturn）从未被迁移 CREATE 属历史断链，已通过补账 + 幂等化 + 外科迁移（`20260828000000_material_return_stock_item_id`）闭环；全新库按账本 deploy 即可，生产库按补账流程追平。

---

## §4 部署命令矩阵

源自 `package.json` scripts：

| 命令 | 脚本 | 说明 |
|------|------|------|
| `npm run deploy:web` | `scripts/ops-upload-webapp.sh` | 构建前端 dist/ → 打包上传 → Mac Mini 解压到 webapp/（老路径入口） |
| `npm run deploy:web:light` | 同上 + `BAMBOOK_WEB_LIGHT=1` | 轻量模式：跳过 data/wallpapers/字体（~90MB → ~4MB），服务器沿用现有版本 |
| `npm run deploy:web:subdomain` | 同上 + `BAMBOOK_WEB_SUBDOMAIN=1` | 子域名模式：base=/ 根路径直挂，解压到 webapp-root/，入口 `https://bambook.jiangsupanda.com/`（需 Cloudflare Tunnel Public Hostname 指向 localhost:8081） |
| `npm run deploy:web:subdomain:light` | 同上 + 双 flag | 子域名轻量模式（webapp-root 有旧版后可用） |
| `npm run deploy:server` | `scripts/ops-upload-package.sh` | 打包 server/ → 上传 → Mac Mini 解压部署后端 |
| `npm run deploy:all` | server + web 顺序执行 | 全量部署 |

---

## §5 webapp 部署流程详解

源自 `scripts/ops-upload-webapp.sh`：

### 5.1 构建阶段

```bash
# 老路径入口（默认）
BAMBOOK_WEB_DEPLOY=1 VITE_API_BASE_URL=/bambook/api npm run build
# 子域名入口
BAMBOOK_WEB_SUBDOMAIN=1 VITE_API_BASE_URL=/api npm run build
```

| 环境变量 | 作用 |
|---------|------|
| `BAMBOOK_WEB_DEPLOY=1` | 让 vite.config.ts 把 base 切到 `/bambook/api/app/` |
| `BAMBOOK_WEB_SUBDOMAIN=1` | 子域名模式：base=/（根路径直挂，部署到 webapp-root/） |
| `VITE_API_BASE_URL=/bambook/api` 或 `/api` | 写死 API 根路径（同域相对路径），避免网页端误连非数据中心 API |

双入口架构：老 `webapp/`（base=/bambook/api/app/，Express 挂 `/api/app`）与新 `webapp-root/`（base=/，Express 根路径直挂 + SPA fallback）为两份不同 base 的构建产物，双目录并存；OPS Panel `X-Deploy-Target: webapp-root` header 区分部署目标。

### 5.2 壁纸压缩

| 步骤 | 说明 |
|------|------|
| 遍历 `dist/wallpapers/` | 照片类统一 JPG（PNG 无损体积过大，曾致上传包超 Cloudflare 100MB 限制） |
| `sips -Z 1920 -s formatOptions 70` | JPG 压缩到 1920px + 70 质量 |
| PNG → JPG 原地替换 | 体积降一个数量级 |

### 5.3 打包

```bash
tar --exclude='*.map' -czf /tmp/bambook-webapp-upload.tar.gz -C dist .
```

轻量模式额外排除：`./data` `./wallpapers` `*.woff` `*.woff2`（服务器沿用现有版本）。

### 5.4 Token 读取

```bash
OPS_TOKEN="$(security find-generic-password -a bambook-ops -s bambook-ops-token -w 2>/dev/null || true)"
# Keychain 无则弹窗输入（osascript）
```

### 5.5 分块上传

Cloudflare 隧道对 POST body 转发有阈值（实测 >~300KB 易 524/Broken pipe）：

| 阈值 | 策略 |
|------|------|
| ≤300KB | 单次 POST `/api/admin/deploy-webapp` |
| >300KB | 分块上传：`/api/admin/deploy-webapp-chunk` 逐块（192KB/块）+ `deploy-webapp-finalize` 重组 |

### 5.6 服务器端部署

Mac Mini 收到后解压到 `~/bambook-main-api/webapp/`，主 API serve 在 `https://jiangsupanda.com/bambook/api/app/`（复用 `/bambook/api` ingress，主 API 中间件 strip `/bambook` 前缀后，`/api/app/*` 由 webapp 静态中间件 serve）。

---

## §6 OPS Panel 操作动作清单

源自 `ops-panel/src/index.ts` ACTIONS 注册表：

### 6.1 routine（日常操作）

| 动作 | 脚本 | 说明 | 超时 |
|------|------|------|------|
| `healthcheck` | ops-healthcheck.sh | 检查公网、主 API、知识库、Cloudflare 和磁盘状态 | 30s |
| `publicProbe` | ops-public-probe.sh | 检查公网 API、知识库、OPS 和已废弃路径的状态码 | 45s |
| `backupPostgres` | ops-backup-postgres.sh | 立即创建一次数据库备份 | 120s |
| `demoSeedDryRun` | ops-demo-seed-dry-run.sh | 预检查 DEMO 数据脚本，不写入数据库 | 60s |

### 6.2 deploy（部署操作）

| 动作 | 脚本 | 说明 | 超时 | 锁 |
|------|------|------|------|----|
| `deployMainApi` | ops-deploy-main-api.sh | 更新主数据 API、执行迁移并健康检查 | 300s | main-api |
| `deployPanel` | ops-deploy-panel.sh | 更新运维面板自身，不影响业务数据 | 240s | ops-panel |

### 6.3 danger（危险操作）

| 动作 | 脚本 | 说明 | 超时 | 锁 |
|------|------|------|------|----|
| `restartCloudflare` | ops-restart-cloudflare.sh | 公网访问异常时使用，会短暂中断远程入口 | 45s | cloudflare |
| `restartMainApi` | ops-restart-main-api.sh | 订单、档案等业务 API 异常时使用 | 90s | main-api |

### 6.4 操作锁

源自 `DEV_JOB_LOCKS`，防止并发操作冲突：

| 锁键 | 标签 |
|------|------|
| `melo-tts` | Melo TTS |
| `main-api` | 主数据 API |
| `cloudflare` | Cloudflare Tunnel |
| `postgres-backup` | PostgreSQL 备份 |
| `ops-panel` | OPS 面板 |
| `demo-data` | DEMO 数据 |

---

## §7 服务状态监控

OPS Panel 监控以下服务端点（环境变量可覆盖）：

| 服务 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| 主 API | `BAMBOOK_OPS_MAIN_API_URL` | `http://127.0.0.1:8081/api/health` | 业务 API 健康检查 |
| 知识库 API | `BAMBOOK_OPS_KNOWLEDGE_API_URL` | `http://127.0.0.1:8091/bambook/kb/health` | KB / RAG 健康检查 |
| 公网 API | `BAMBOOK_OPS_PUBLIC_API_URL` | `https://jiangsupanda.com/bambook/api/health` | 公网入口探测 |
| AI Runtime 指标 | `BAMBOOK_OPS_AI_RUNTIME_METRICS_URL` | `http://127.0.0.1:8081/api/ai/metrics` | Agent Runtime 指标 |
| Agent 状态 | `BAMBOOK_OPS_AGENT_STATUS_URL` | `http://127.0.0.1:8081/api/agent/status` | Agent 运行状态 |
| Melo TTS | `BAMBOOK_MELO_URL` | `http://127.0.0.1:8765` | TTS 服务 |

状态分级：`ok` / `warn` / `error`。

---

## §8 OPS Panel 配置

### 8.1 核心配置

| 配置 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| 端口 | `BAMBOOK_OPS_PORT` | 8088 | OPS Panel 监听端口 |
| 管理员 Token | `BAMBOOK_OPS_ADMIN_TOKEN` | 空（生产必填） | 生产环境不配置则启动抛错 |
| 操作日志 | `BAMBOOK_OPS_ACTION_LOG` | `/tmp/bambook-ops-actions.log` | 操作审计日志路径 |
| 部署包上限 | `BAMBOOK_OPS_DEPLOY_PACKAGE_LIMIT` | 200mb | webapp 含大依赖，90MB+ 为正常 |

### 8.2 独立构建链

| 约束 | 说明 |
|------|------|
| 独立 tsconfig | `server/ops-panel/tsconfig.json`（独立于根 tsconfig） |
| 独立 node_modules | `server/ops-panel/node_modules/` |
| 类型检查 | `cd server/ops-panel && npx tsc --noEmit --skipLibCheck` |

### 8.3 环境变量加载链

```ts
dotenv.config({ path: server/.env.local, override: true });
dotenv.config({ path: server/.env });
dotenv.config({ path: ops-panel/.env.local, override: true });
dotenv.config({ path: ops-panel/.env });
```

---

## §9 Cloudflare Tunnel 公网入口

| 域名 | 路由 | Mac Mini 端口 | 说明 |
|------|------|-------------|------|
| `ops.jiangsupanda.com` | / | :8088 | OPS Panel 运维面 |
| `jiangsupanda.com` | /bambook/api | :8081 | 主 API（业务接口） |
| `jiangsupanda.com` | /bambook/api/app | :8081 → webapp 静态 | 网页端（strip /bambook 前缀） |
| `jiangsupanda.com` | /bambook/kb | :8091 | 知识库 API |

Cloudflare Tunnel 标签：
- `com.cloudflare.bambook.api` — 主 API 隧道
- `com.cloudflare.bambook.watchdog` — 看门狗隧道

---

## §10 远程开发任务（Dev Jobs）

OPS Panel 支持远程开发任务（spawn 子进程执行命令）：

| 配置 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| 最大输出 | `BAMBOOK_OPS_DEV_JOB_MAX_OUTPUT` | 320,000 字符 | 单任务输出上限 |
| 默认超时 | `BAMBOOK_OPS_DEV_JOB_TIMEOUT_MS` | 30 分钟 | 任务默认超时 |
| 最大超时 | `BAMBOOK_OPS_DEV_JOB_MAX_TIMEOUT_MS` | 2 小时 | 任务最大超时 |
| 最大命令长度 | `BAMBOOK_OPS_DEV_JOB_MAX_COMMAND_LENGTH` | 8,000 字符 | 命令长度上限 |
| 最大并发 | `BAMBOOK_OPS_DEV_JOB_MAX_ACTIVE` | 4 | 同时运行任务数 |
| 历史文件 | `BAMBOOK_OPS_DEV_JOB_HISTORY_FILE` | `/tmp/bambook-ops-dev-jobs.jsonl` | 任务历史持久化 |

工作目录选项：
- `server` — 后端 server
- `repo` — 完整 Bambook repo
- `opsPanel` — OPS 面板

---

## §11 部署灰度切换四步法

源自产品定位 §10 约束与风险应对：

```
Step 1: 构建打包（开发机）
  npm run deploy:web  (或 deploy:server / deploy:all)
  → 生成 tar.gz + 自动上传

Step 2: Mac Mini 解压部署
  OPS Panel 接收 → 解压到目标目录 → 静态资源就位

Step 3: 健康检查
  OPS Panel → healthcheck 动作
  → 检查主 API / 知识库 / Cloudflare / 磁盘

Step 4: 异常回退
  restartMainApi / restartCloudflare
  → 或重新部署上一版本 tar.gz
```

---

## §12 安全约束

| 约束 | 说明 |
|------|------|
| ADMIN_TOKEN 生产必填 | `BAMBOOK_OPS_ADMIN_TOKEN` 未配置且 NODE_ENV=production → 启动抛错 |
| Token 入 Keychain | Ops Token 存 macOS Keychain（`bambook-ops-token`），不入代码库 |
| 操作确认 | danger/deploy 组动作需 `confirm` 二次确认 |
| 操作锁 | 同一锁键的动作串行执行，防并发冲突 |
| 操作审计 | 所有动作写入 `BAMBOOK_OPS_ACTION_LOG` |
| 文件备份 | 远程文件编辑前自动备份到 `/tmp/bambook-ops-file-backups/` |
| 上传限制 | 文件上传 50mb（`DEV_UPLOAD_MAX_BYTES`），部署包 200mb |

---

## §13 待补的设计缺口

| # | 缺口 | 优先级 | 备注 |
|---|------|-------|------|
| 1 | GitHub 自动更新轮询 | P3 | com.bambook.ops-panel-auto 每分钟轮询（规划中，当前 push-based） |
| 2 | 部署回滚一键化 | P2 | 当前回退靠重新部署上一版本，无版本切换 |
| 3 | OPS Panel 操作可视化仪表盘 | P3 | 当前操作列表式，无仪表盘聚合 |
| 4 | 部署蓝绿/金丝雀 | P3 | 当前为直接覆盖部署，无灰度分流 |

---

## §14 实现状态总览

| 子能力 | 状态 | 真源 |
|--------|------|------|
| OPS Panel 服务（:8088） | ✅ | `ops-panel/src/index.ts` |
| ADMIN_TOKEN 守卫 | ✅ | 生产环境必填校验 |
| 8 项操作动作 | ✅ | ACTIONS 注册表（routine/deploy/danger） |
| 服务状态监控 | ✅ | 6 个服务端点探测（ok/warn/error） |
| 操作锁 | ✅ | DEV_JOB_LOCKS（6 个锁键） |
| 远程开发任务 | ✅ | DevJob spawn + 历史持久化 |
| webapp push 部署 | ✅ | `ops-upload-webapp.sh` + 分块上传 |
| server push 部署 | ✅ | `ops-upload-package.sh` |
| Keychain Token 读取 | ✅ | `security find-generic-password` |
| Cloudflare Tunnel 公网入口 | ✅ | ops.jiangsupanda.com + jiangsupanda.com |
| 壁纸压缩 | ✅ | `sips` JPG 压缩 |
| 轻量部署模式 | ✅ | `BAMBOOK_WEB_LIGHT=1` |
| GitHub 自动更新轮询 | ❌ 规划 | com.bambook.ops-panel-auto |
| 部署回滚一键化 | ⚠️ 缺口 | 当前靠重新部署 |

---

## §15 交叉链接

1. [系统边界声明](./系统边界声明.md) — 部署边界总声明（§4.1 架构边界 + §11 约束与风险）
2. [外部集成](./外部集成.md) — Webhook 告警配置 + API-Key 管理（OPS Panel 环境变量）
3. [通知通道闭环](./通知通道闭环.md) — 通知服务部署在 Mac Mini :8081
4. [产品定位与愿景 §10](../01-产品总览/1.%20产品定位与愿景.md) — 约束与风险（push-based OPS Panel 部署 + 灰度切换四步法）
5. [project_rules.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/.trae/rules/project_rules.md) — Mac Mini 部署规则 + Lint/Typecheck 命令（OPS Panel 独立 tsconfig）
6. [ops-panel/src/index.ts 真源](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/ops-panel/src/index.ts) — OPS Panel 实现真源
7. [ops-upload-webapp.sh 真源](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/scripts/ops-upload-webapp.sh) — webapp 部署脚本真源

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| OPS Panel 真源 | [ops-panel/src/index.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/ops-panel/src/index.ts) |
| webapp 部署脚本 | [ops-upload-webapp.sh](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/scripts/ops-upload-webapp.sh) |
| server 部署脚本 | [ops-upload-package.sh](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/scripts/ops-upload-package.sh) |
| 项目规则 | [project_rules.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/.trae/rules/project_rules.md) |
| OPS Panel 测试 | `server/ops-panel/src/ops-panel-status.test.ts` / `remote-develop.test.ts` |
| 中期验收交付文档 | `.trae/documents/mid-project-acceptance-delivery.md`（环境搭建 / 验证命令 / 部署流程 / 交接清单） |
