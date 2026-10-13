# Bambook 知识库 API（RAG）

FastAPI 服务：向量入库、检索、（可选）DeepSeek 对话。可部署在 **Mac mini** 上，经 **Cloudflare Tunnel** 对外提供 HTTPS。

## 生产环境（当前约定）

| 项 | 值 |
|:---|:---|
| 公网根路径 | `https://jiangsupanda.com/bambook/kb` |
| 健康检查 | `GET https://jiangsupanda.com/bambook/kb/health` → `{"status":"ok"}` |
| 本机（Mac mini） | `http://127.0.0.1:8091`；路由前缀由 `URL_MOUNT_PATH` 决定，默认 **`/bambook/kb`**，即本机为 `http://127.0.0.1:8091/bambook/kb/...` |
| 认证 | 请求头 `Authorization: Bearer <API_KEY>`（密钥只在服务器 `.env` 中，**勿提交仓库**） |
| Cloudflare 隧道 | Zero Trust 中名称 **Bambook**；Cloudflare 路由 `/bambook/*` → `http://127.0.0.1:8091`，知识库应用挂载在 `URL_MOUNT_PATH=/bambook/kb`；主数据 API 另见 `/bambook/api` 路由（→ 8081，优先级高于 `/bambook`） |
| 代码在 Mac mini 上路径 | `~/bambook-knowledge-api`（与仓库本目录对应，可 `rsync` 部署） |
| 系统用户 | `panda1`；隧道用 LaunchAgent `com.cloudflare.bambook.api`（见 `scripts/`） |

## Mac mini 地址与路径（部署机一览）

以下为方便运维的**固定信息**与**可能变化的信息**；**局域网 IP 由 DHCP 分配会变**，以 mini 本机实时查询为准。

| 项 | 值 |
|:---|:---|
| **Bonjour 主机名**（同网段可试） | `PANDAdeMac-mini.local` |
| **局域网 IPv4（示例）** | 部署时曾为 **`192.168.110.19`** / 子网示例 **`192.168.110.0/24`**；**当前 IP 请在 Mac mini 上执行** `ipconfig getifaddr en0` **或** `系统设置 → 网络 → 详情 → TCP/IP` 查看 |
| **SSH 用户** | `panda1` |
| **SSH（局域网）** | `ssh panda1@<当前局域网IP>` 或 `ssh panda1@PANDAdeMac-mini.local`（mDNS 不稳定时优先用 IP） |
| **代码目录** | `/Users/panda1/bambook-knowledge-api`（即 `~/bambook-knowledge-api`） |
| **环境变量** | `~/bambook-knowledge-api/.env`（**勿提交、勿贴聊天**） |
| **知识库 API（本机）** | `http://127.0.0.1:8091/bambook/kb`（健康检查：`.../bambook/kb/health`） |
| **隧道 token 文件** | `~/.cloudflared/bambook.tunnel.token` |
| **cloudflared 日志** | `/tmp/cloudflared-bambook.log` |
| **API 日志（若用 nohup）** | `/tmp/bambook-api.log`（以实际启动方式为准） |
| **公网（客户端用）** | `https://jiangsupanda.com/bambook/kb` — 与局域网 IP **无关** |

## SSH 登录 Mac mini（开发与运维）

用于：**改代码后 rsync、重启 uvicorn / cloudflared、查日志**；与 **公网 HTTPS** 无关（外网走域名 + Cloudflare）。

### 前提（Mac mini 上）

1. **远程登录已开启**：系统设置 → **通用** → **共享** → **远程登录** → 打开（允许用户 **panda1**）。
2. **局域网**：开发机与 Mac mini 同一 Wi‑Fi / 网段（办公室场景）。
3. **认证**：推荐 **SSH 公钥**（`~/.ssh/authorized_keys`）；密码登录亦可但不建议自动化。

### 连接命令（示例）

部署机用户名为 **`panda1`**；IP 以路由器 DHCP 为准（会变），建议在 mini 上查一次：

```bash
# 在 Mac mini 终端执行，看主网卡 IPv4（示例曾是 192.168.110.19）
ipconfig getifaddr en0
```

在你自己的 Mac（开发机）上：

```bash
ssh panda1@<Mac_mini_局域网IP>
```

首次连接会提示接受 host key，输入 **yes**。

### 配置本机 SSH 别名（可选）

在你开发机的 `~/.ssh/config` 里可增加：

```sshconfig
Host bammini
  HostName <Mac_mini_局域网IP>
  User panda1
  IdentityFile ~/.ssh/id_ed25519
```

之后：

```bash
ssh bammini
```

### 公钥免密（开发机 → mini）

若尚未配置，在**开发机**执行（会询问 mini 上 `panda1` 的密码一次）：

```bash
ssh-copy-id panda1@<Mac_mini_局域网IP>
```

此后同一开发机可免密登录。

### 常用运维命令（登录 mini 后）

```bash
# 知识库 API 健康检查（本机）
curl -sS http://127.0.0.1:8091/bambook/kb/health

# 隧道日志
tail -f /tmp/cloudflared-bambook.log

# API 进程
pgrep -lf uvicorn
```

从**开发机一条命令**在 mini 上执行（无需交互脚本时）：

```bash
ssh panda1@<Mac_mini_IP> 'curl -sS http://127.0.0.1:8091/bambook/kb/health'
```

### 同步代码（开发机执行）

仓库本目录 → mini 上 `~/bambook-knowledge-api`（路径按你实际调整）：

```bash
rsync -az --delete ./apps/Bambook/server/knowledge_api/ panda1@<Mac_mini_IP>:~/bambook-knowledge-api/
```

同步后通常在 mini 上 **重启 uvicorn**（见 `.env` 与启动方式；勿在聊天泄露密钥）。

### 外网访问

日常 API 调用使用 **`https://jiangsupanda.com/bambook`**，**不需要** SSH；SSH 仅运维。

## 依赖服务（Mac mini）

- **PostgreSQL 17** + **pgvector**，库名 `bambook`
- **Ollama**，模型 `nomic-embed-text`（embedding）
- **uvicorn**：`app.main:app`，`--host 127.0.0.1 --port 8091`（由 `com.bambook.knowledge-api` LaunchAgent 常驻；脚本见 `scripts/run-knowledge-api.sh`）
- **cloudflared**：token 放 `~/.cloudflared/bambook.tunnel.token`；LaunchAgent 使用 `--protocol http2`

## 仓库路径与配置

- 应用代码：`app/main.py`（子应用挂到 `URL_MOUNT_PATH`）、`app/config.py`
- 环境变量示例：`env.example` → 复制为 **`.env`**（仅部署机）
- 隧道与自启：`docs/cloudflare-tunnel-setup.txt`，`scripts/cloudflare-enable.sh` / `cloudflare-disable.sh`
- 隧道自愈：`scripts/cloudflare-enable.sh` 会同时安装 `com.cloudflare.bambook.watchdog`。watchdog 每分钟从 Mac mini 本机检查公网 `https://jiangsupanda.com/bambook/api/health`；若本机 `8081` 正常但公网失败，会自动 `launchctl kickstart -k` 重启 tunnel。日志：`/tmp/cloudflared-bambook-watchdog.log`

## 主要 HTTP 接口（均相对于公网根，即带 `/bambook` 前缀）

- `GET /health`
- `POST /v1/knowledge/ingest`
- `POST /v1/knowledge/search`
- `POST /v1/chat`（需配置 `DEEPSEEK_API_KEY`）
- `POST /v1/chat/debug-context`

## 与 Bambook 主数据 API 共用公网路径

Bambook 网络客户端使用同一个公网前缀 `https://jiangsupanda.com/bambook`：

- 主数据 API：`/bambook/api/*` → Mac mini `http://127.0.0.1:8081`
- 知识库 API：`/bambook/kb/*` → Mac mini `http://127.0.0.1:8091`（应用挂载路径 `URL_MOUNT_PATH=/bambook/kb`）

Cloudflare 中 `/bambook/api` 必须比 `/bambook` 更优先匹配。若 `/bambook/api/health` 返回知识库的 `{"detail":"Not Found"}`，说明主数据路由没有命中 8081。

当前知识库 API 挂载在 `/bambook/kb`，并内置 `/bambook/kb/api/*` fallback proxy 到本机 8081。Cloudflare 应显式配置 `/bambook/api` → 8081（优先级高于 `/bambook`），避免主数据请求落到知识库服务。

## 后续 Agent 接手建议

1. 只读本 `README` + `docs/cloudflare-tunnel-setup.txt` + `env.example`。
2. 修改 API 后向 Mac mini `~/bambook-knowledge-api` **rsync** 并 **重启 uvicorn**（勿在回复中泄露 `.env` / token）。
3. 客户端 Base URL：`https://jiangsupanda.com/bambook`（无尾部斜杠亦可，注意路径拼接）。
4. 若 Cloudflare 上要改为 `api.jiangsupanda.com/bambook`，需在 Zero Trust **另增** Published hostname，无需改代码路径规则时保持 `URL_MOUNT_PATH=/bambook` 即可。

## 风险与边界

- Mac mini 为 **单点**；需电源、网络、备份（数据库 `pg_dump` 等）另见运维策略。
- LaunchAgent 仅在 **用户登录会话**内跑隧道；无人登录桌面时需另行方案（如开机自动登录或 LaunchDaemon）。
- 若出现 **root** 与 **当前用户** 各跑一份 `cloudflared`（Dashboard 显示 2 replicas）：先在 mini 上 `sudo kill <root 的 PID>`；若需免密执行清理脚本，见 **`docs/sudo-nopasswd-cloudflared.txt`**（只对 `/usr/local/sbin/kill-root-cloudflared-dupes.sh` 放行 NOPASSWD）。
