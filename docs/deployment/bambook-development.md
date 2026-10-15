# Bambook 开发环境（腾讯云）设计与交付

适用：腾讯云轻量服务器 KOOGO（上海，124.222.56.61，Ubuntu 26.04），公网入口 `https://bambook-dev.sylway.cloud`。这不是正式环境：不使用旧 Mac mini 与 `jiangsupanda.com`，不连接正式数据库、正式 PDML，不涉及真实资金。

## 当前状态（2026-10-15）

- 已上线：两个后端服务、同域前端、Cloudflare Tunnel、专用开发库（结构 + 基础数据 + 模拟岗位账号）、平台 AI（ChatGPT 订阅，经海外出口）。
- 公网已验证：7 个岗位测试账号登录；非管理员访问 `/api/admin/*` 与平台 AI 配置为 403、匿名 401；主 API（客户 / 产品 / 订单）与 Mist（工作区 / 平台 AI）可用；Mist 助手经平台 ChatGPT 真实回答。
- 未做：Cloudflare Access（用户决定暂不启用，目前任何人可见登录页，需账号密码才能进入）；正式数据迁移（不做）。
- 已知未解：连接 ChatGPT 后第一次助手调用曾返回“模型服务暂时不可用”，之后无法复现；该路径未记录底层错误，再出现时先补日志。

## 架构

```
浏览器 ──HTTPS── Cloudflare（sylway.cloud）── Tunnel bambook-dev ── 服务器 cloudflared
                                                                    │
                                              nginx 127.0.0.1:8080 ─┤ /            → current/web（Mist Atelier 静态前端）
                                                                    │ /api/mist/   → 127.0.0.1:8082 bambook-dev-mist.service
                                                                    │ /api/*       → 127.0.0.1:8081 bambook-dev.service
                                              PostgreSQL 18 localhost panda_hub_dev
                                              sing-box 127.0.0.1:7890（仅 OpenAI 域名走海外节点）
```

- 前端是 Mist Atelier（根 `vite build`，`BAMBOOK_WEB_SUBDOMAIN=1`、`VITE_API_BASE_URL=/api`），同时依赖两套后端：`/api/mist/*`（工作区、评审、平台 AI 模型 / ChatGPT 订阅）和主 API（`/api/auth`、`/api/v1/*`、`/api/products`、`/api/knowledge` 等）。
- `bambook-dev.service`：完整主 API `server/src/index.ts`（与正式同一入口），`PORT=8081`、`BAMBOOK_HOST=127.0.0.1`。
- `bambook-dev-mist.service`：Mist 工作区 API `server/src/mist/standalone.ts`，`MIST_PORT=8082`、`MIST_HOST=127.0.0.1`、`MIST_LOCAL_WORKSPACE=0`。非本地模式下 `/api/mist/session` 在鉴权前直接 404——前端据此判断“服务器账号模式”并显示登录页（返回 401 会被误判为本地工作区故障）。
- 两个服务共用同一库与 `JWT_SECRET`，登录态互通；均以 `bambook-deploy` 运行，`ProtectSystem=strict`，仅 `/srv/bambook-dev/shared` 可写，内存上限 1.5G / 768M。
- 对外只有 22 端口（SSH）；80/443 不开放，所有 Web 流量经 Tunnel。

## 目录与配置

| 路径 | 内容 |
| --- | --- |
| `/srv/bambook-dev/releases/<40位提交>` | 各版本（自带 `node_modules`），保留 4 个 |
| `/srv/bambook-dev/current` | 指向当前版本 |
| `/srv/bambook-dev/shared/` | 跨版本数据：`logs` `storage` `data` `output`（发布时链接进版本）、`uploads` `private-files` `mist-files` `ai-subscriptions`（ChatGPT 凭据）、`test-accounts.txt`（root 0600） |
| `/etc/bambook-dev/backend.env` | root:bambook-deploy 0640；数据库、密钥、端口、目录、开关；bootstrap 只补缺失项 |
| `/etc/bambook-dev/proxy/nodes.txt` | root 0600；海外节点（不入库） |
| `/etc/cloudflared/config.yml` + `<隧道ID>.json` | 隧道 `bambook-dev` → `http://127.0.0.1:8080`，systemd `cloudflared` |
| `/etc/nginx/sites-available/bambook-dev`、`/etc/nginx/snippets/bambook-dev-proxy.conf` | 分流与代理参数（较大的响应头缓冲：管理员登录 Cookie 约 7KB，默认缓冲会 502） |
| `/var/backups/bambook-dev` | 每日 `pg_dump`，保留 7 天 |

`backend.env` 关键项：`DATABASE_URL`（localhost）、随机 `JWT_SECRET` / `SYSTEM_CONFIG_ENCRYPTION_KEY` / `BAMBOOK_COOKIE_SECRET`、`NODE_ENV=production`（强制鉴权，Mist 禁用本地全权限身份）、`BAMBOOK_CODEX_SUBSCRIPTION=1`、`PDML_SYNC_DISABLED=true`、`AUTH_REQUIRE_EMAIL_VERIFY=0`、各目录、`MIST_CORS_ORIGINS`、`TZ`，以及代理启用后追加的 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` / `NODE_USE_ENV_PROXY=1`。

## 服务器初始化（root，一次性，可重复执行）

`scripts/deploy/bootstrap-dev-server.sh`：交换空间（已有则跳过）、Node（与 `.nvmrc` 主版本一致）、nginx、PostgreSQL、库与角色（随机密码只写入 `backend.env`）、两个 systemd 单元、sudoers（`bambook-deploy` 只能 restart / stop 这两个服务）、nginx 站点、备份 cron、代理命令与空节点文件。不打印密钥，已有配置与数据保留。

接收程序 `/usr/local/libexec/bambook-dev-receiver.py` 是 root 所有的副本，仓库改动不会自动生效；改动后由管理员替换（0755）。cloudflared（pkg.cloudflare.com apt 源）与 sing-box（见下文）单独安装。

## 交付与激活

正常路径：PR 合入 main → GitHub Actions `Bambook development delivery` 手动运行。`check` 只测通道；`deploy` 要求同一提交 `verify` 已通过，在 CI 构建前端，打包 `.nvmrc`、`server`、`scripts/deploy/bambook-dev-release.sh`、`web/`（确定性：固定排序与时间戳），经受限 SSH 发送。普通 push 不部署。私钥只在仓库 secret `BAMBOOK_DEV_SSH_KEY`，主机公钥在 `BAMBOOK_DEV_KNOWN_HOSTS`。

受限 SSH 强制经过接收程序，只接受 `check`、`receive <提交>`、`activate <提交>`；拒绝越界路径、链接、设备文件、重复路径、超限包，`scripts/` 下只允许发布脚本本身（其他运维脚本放 `server/scripts/` 才会随包交付）。

发布脚本 `bambook-dev-release.sh`：核对 Node 主版本 → 依赖（`server/package-lock.json` 与 Node 版本都与当前版本相同时，从当前版本整份复制 `node_modules`，否则 `npm ci`；复制失败也退回 `npm ci`）→ `prisma generate` → 全量 `tsc --noEmit`（约 1.9GB 内存）→ 链接 shared 目录 → 读入 `backend.env` 并校验（回环监听、PDML 关闭、密钥齐全）→ 切换 `current` → 重启两个服务 → 两个健康检查都通过才算激活，否则回切旧版本。不自动迁移或重置数据库。日志里每步带 `[release +N s]` 耗时。

时间预算（由内到外，改动时一起改）：发布脚本 ≤ 2100 秒（接收程序 `ACTIVATE_TIMEOUT`）< 交付作业里 ssh 的 `timeout 2280` < 交付作业 `timeout-minutes: 50`。超时后接收程序结束整个进程组（含 npm / prisma / tsc 子进程）；发布脚本在切换 `current` 前写 `/srv/bambook-dev/.activation.json`，若在切换后、健康检查完成前被中断，接收程序据此切回旧版本并重启服务，下次激活前也会先处理遗留标记。回切的只是应用版本，数据库不随之回滚（发布本身不改库结构）。

### 备用：管理员手工交付

GitHub Actions 不可用、或分支未合入时使用（本次上线即用此方式）。在服务器组装与 CI 相同范围的包，再走同一接收程序：

```sh
revision=<已推送的完整 40 位提交>
# 组装目录只含 .nvmrc、server（无 node_modules / logs / storage / data）、scripts/deploy/bambook-dev-release.sh、web/
tar -c --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner .nvmrc server scripts web | gzip -n > /tmp/release.tgz
sudo -u bambook-deploy env SSH_ORIGINAL_COMMAND="receive $revision" /usr/bin/python3 /usr/local/libexec/bambook-dev-receiver.py < /tmp/release.tgz
sudo -u bambook-deploy env SSH_ORIGINAL_COMMAND="activate $revision" /usr/bin/python3 /usr/local/libexec/bambook-dev-receiver.py
```

激活约 4–5 分钟（依赖安装 + 类型检查）。

## 数据库与测试账号

首次部署后以 root 执行 `sudo bash /srv/bambook-dev/current/server/scripts/init-dev-database.sh`（仅接受本机 `panda_hub_dev`，幂等）：

1. 空库按 `schema.prisma` 建表（`db push`），并把全部迁移标记为已应用作为基线——迁移历史无法从空库重放（早期迁移依赖库外已有表）。之后 schema 变更照常 `migrate deploy`。正式库禁止 `db push` 的原则不变。
2. `seed:base` → 补建 `owner@bambook.local`（`SEED_OWNER_ALLOW_NONEMPTY=1`，因 `seed:base` 已建演示账号）→ `seed:dev-roles`（17 个模拟员工、5 个业务组、5 个模拟客户，不造订单 / 报价 / 财务数据）。
3. 给 owner 与面料主管、面料一组组长 / 组员、财务、面料 QC、物流设置随机密码，只写入 root 0600 `/srv/bambook-dev/shared/test-accounts.txt`。重复执行会重新生成这些密码。

另有用户指定的简单管理员 `admin@bambook.local`（超级管理员，密码由用户指定，不入库），为手工创建，重建开发库后需重建。登录框为邮箱类型，须输入完整邮箱。

## 平台 AI 与 OpenAI 出口

大陆出口 IP 被 OpenAI 按地区拒绝（`unsupported_country_region_territory`；代码会误报为“账号未启用设备码”）。开发机用 sing-box 分流：

- 安装：apt 源 `deb.sagernet.org`，公钥指纹 `2C317FBD5D886B4E89BAE8DA6D9152172A2B2F0C`（服务器直连 `sing-box.app` 取公钥会超时，需从别处取得放入 `/etc/apt/keyrings/sagernet.asc`）。
- 节点：Shadowrocket 分享 URL（ss / vmess / vless / trojan / hysteria2 / tuic）、Shadowrocket 节点 JSON（Socks5 / HTTP / Shadowsocks / Trojan）、订阅链接或内容、sing-box JSON，写入 `/etc/bambook-dev/proxy/nodes.txt`，执行 `sudo bambook-dev-proxy apply`；`sudo bambook-dev-proxy test` 查看出口地区与 OpenAI 登录接口状态（403 = 仍被拒）。节点须在 OpenAI 支持地区（香港不行）。当前为美国节点。
- 只有 OpenAI 相关域名走节点，其余直连；`apply` 成功后才给后端加代理变量并重启，节点不可用时不会切断后端。
- 连接 ChatGPT：管理员在平台 AI 模型页发起设备码登录（`POST /api/mist/ai/platform-model/chatgpt/login`），在 `https://auth.openai.com/codex/device` 输入代码。凭据存 `shared/ai-subscriptions`。

## 管理访问

- 腾讯云控制台 OrcaTerm（`ubuntu`，免密 sudo）。
- 临时管理员 SSH 公钥（注释 `notion-agent-bambook-dev-admin`，在 `ubuntu` 的 `authorized_keys`）：供云端 Agent 运维，按用户要求暂时保留；不再需要时删除该行即可。
- `bambook-deploy` 的受限密钥只能交付，不能开 shell。

## 故障判断

- `check` 成功只代表通道可用；`receive` 成功只代表文件收到；`activate` 成功代表本机两个健康检查通过，仍需验证公网、登录与前端。
- 激活失败：已回切旧版本，查 `journalctl -u bambook-dev -u bambook-dev-mist`。常见原因是代码往只读版本目录写文件——把该路径加入发布脚本的 shared 链接。
- 前端显示“工作区连接待核对 / 本地工作身份”：`/api/mist/session` 没有返回 404。
- 管理员登录 502：nginx 响应头缓冲不足。
- 平台 AI 失败：`sudo bambook-dev-proxy test`；`systemctl status sing-box`。
- 域名不可访问：`systemctl status cloudflared`、nginx、两个服务健康，逐层排查。

## 开发邮箱（`sylway.cloud`）

`scripts/deploy/bootstrap-dev-mail.sh`（经运维通道执行，可重复）：Postfix + Dovecot 2.4，虚拟域 `sylway.cloud`，Maildir 在 `/var/mail/vhosts`（`vmail` 5000），账号在 `/etc/dovecot/users`（SHA512-CRYPT），生成的密码只写入 `/srv/bambook-dev/shared/mail-accounts.txt`（root 0600），不打印。

- 端口：SMTP 25 / submission 587（STARTTLS + 账号认证，发件人必须是登录账号本人）/ IMAP 143、993；**只监听 127.0.0.1**。证书暂用自签 snakeoil。
- 测试邮箱：`sales@`、`finance@`、`customer-demo@`（模拟客户）、`factory-demo@`（模拟工厂）。站内互发、冒名拒绝、错误密码拒绝已实测。
- 对外投递：腾讯云默认封出站 25，外部收件人直接退回（`external delivery is not enabled on bambook-dev yet`），不排队。
- 对外开通前置（用户操作 / 授权）：Cloudflare 上 `mail.sylway.cloud` A 记录（仅 DNS，不走代理）+ MX + SPF + DKIM（需加 OpenDKIM）+ DMARC；腾讯云安全组放行入站 25（及按需 587 / 993）；申请解封出站 25 与反向解析（PTR）；Let's Encrypt 证书。完成后再把 `inet_interfaces` / Dovecot `listen` 放开。
