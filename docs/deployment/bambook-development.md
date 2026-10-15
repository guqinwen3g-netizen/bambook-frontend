# Bambook 开发环境交付通道

适用：腾讯云 KOOGO 开发服务器，独立账号 `bambook-deploy`，交付目录 `/srv/bambook-dev`。这不是正式生产环境，也不使用旧 Mac mini 的数据库。

## 云端 Agent 怎样交付

1. 在任务分支完成代码并通过现有验证，经 PR 合入主线。
2. 在 Actions 中手动运行 `Bambook development delivery`。第一次选择 `check`，只验证连接，不发送应用。
3. 应用部署准备完成后选择 `deploy`；流程要求准确主线提交已有成功的 `verify` 检查，将该提交的后端与前端发送到独立版本目录，再启动和核对本机健康接口。不会因普通 push 自动部署。

服务器地址和账号在 workflow 中。私钥只存为仓库 Actions secret `BAMBOOK_DEV_SSH_KEY`，受信任主机公钥存为 `BAMBOOK_DEV_KNOWN_HOSTS`。不在聊天、代码或日志中输出私钥。

SSH key 强制经过接收程序，只接受 `check`、`receive <40位提交>`、`activate <40位提交>`，不能当通用终端或 SFTP 使用。接收程序拒绝路径越界、符号链接、设备文件、重复路径和超过限制的压缩包；相同提交重复传送必须字节一致。项目 agent 无需在用户本机。

服务器上运行的是 root 所有的副本 `/usr/local/libexec/bambook-dev-receiver.py`，仓库改动不会自动生效。本仓库版本要求压缩包包含 `.nvmrc`：接收程序更新后，须由管理员把服务器副本替换为合入主线的版本（root 所有、0755），否则 `receive` 会以 `unsupported archive entry` 拒绝新包。

## 服务器初始化（管理员，一次性，可重复执行）

以 root 运行仓库中的 `scripts/deploy/bootstrap-dev-server.sh`（腾讯云 OrcaTerm 或管理员 SSH）。脚本幂等、不打印生成的密钥，已有配置与数据库保留：

- 2G 交换空间；Node 主版本与 `.nvmrc` 一致（NodeSource）；nginx、PostgreSQL。
- 专用库 `panda_hub_dev` 与角色 `bambook_dev`（随机密码只写入 `/etc/bambook-dev/backend.env`，root:bambook-deploy 0640）。环境含 `DATABASE_URL`、随机 `JWT_SECRET` / `SYSTEM_CONFIG_ENCRYPTION_KEY`（平台 AI 等系统配置加密）/ `BAMBOOK_COOKIE_SECRET`、`NODE_ENV=production`（强制鉴权）、`PORT=8081`、`BAMBOOK_HOST=127.0.0.1`（只监听回环）、`BAMBOOK_UPLOAD_DIR` / `BAMBOOK_PRIVATE_FILES_DIR` / `BAMBOOK_AI_SUBSCRIPTION_DIR`（均在 `/srv/bambook-dev/shared`，跨版本保留）、`BAMBOOK_CODEX_SUBSCRIPTION=1`（管理员可连接 ChatGPT 订阅作为平台 AI）、`PDML_SYNC_DISABLED=true`（开发机永不同步正式 PDML）、`AUTH_REQUIRE_EMAIL_VERIFY=0`、`TZ`。重复执行 bootstrap 只补缺失项，不覆盖已有值。
- 固定的 `bambook-dev.service`：`bambook-deploy` 身份，工作目录 `/srv/bambook-dev/current/server`，Node 执行本地 tsx CLI 与完整主 API `src/index.ts`（与正式环境同一入口，含业务、管理后台、平台 AI 路由）；只读系统、仅 `shared/` 可写（`server/logs`、`server/storage`、`server/data` 与版本根的 `output` 在发布时链接到 `shared/`）、内存上限 1.5G。sudo 只允许该账号重启 / 停止此服务。
- nginx 仅监听 `127.0.0.1:8080`：静态前端取当前版本 `web/`，`/api/` 转发 8081。Cloudflare Tunnel 连到这里，不开放 80 / 443。
- 每日 `pg_dump` 备份到 `/var/backups/bambook-dev`，保留 7 天。

服务器上运行的接收程序是 root 所有的副本 `/usr/local/libexec/bambook-dev-receiver.py`，仓库改动不会自动生效。本版本要求压缩包包含 `.nvmrc` 与 `web/index.html`：接收程序更新后，须由管理员把服务器副本替换为合入主线的版本（root 所有、0755），否则 `receive` 会以 `unsupported archive entry` 拒绝新包。

## 交付内容与激活

`deploy` 在 GitHub 构建同域前端（`BAMBOOK_WEB_SUBDOMAIN=1`、`VITE_API_BASE_URL=/api`；不含 Mist 不使用的旧地图数据），与该提交的 `server`、`.nvmrc`、发布脚本一起打成确定性压缩包（固定时间戳与排序，同一提交重复交付字节一致）。

交付脚本先核对服务器 Node 主版本与 `.nvmrc` 一致，再安装锁定依赖、生成 Prisma client、检查 Mist 类型；这些步骤完成后才读入 `backend.env`，依赖安装脚本看不到数据库密码和签名密钥。随后切换版本并验证健康接口，失败时恢复旧版本。激活成功后只保留当前、上一版及最近版本共 4 个，其余版本目录（各自带依赖）自动删除。它不会自动执行 schema 迁移、重置数据库或迁移真实数据。

## 数据库结构与测试账号（管理员单独确认后执行）

首次部署成功后，以 root 执行 `sudo bash /srv/bambook-dev/current/server/scripts/init-dev-database.sh`。它只接受本机 `panda_hub_dev`：空库时按 `schema.prisma` 建表（`db push`），并把全部迁移标记为已应用作为基线——迁移历史无法从空库重放（早期迁移依赖库外已有表）；随后 `migrate deploy`、`seed:base`、补建 `owner@bambook.local`、`seed:dev-roles`，最后给管理员与各岗位测试账号设置各自随机密码，只写入 root 可读的 0600 `/srv/bambook-dev/shared/test-accounts.txt`，不打印、不入库。脚本幂等，可重复执行（重复执行会重新生成测试密码）。后续 schema 变更照常逐次确认后执行 `migrate deploy`；正式库禁止 `db push` 的原则不变。

## 域名

开发环境前端与接口在**同一个域名** `bambook-dev.sylway.cloud`，由 Cloudflare Tunnel 转到本机 nginx，并以 Cloudflare Access（邮箱验证码）限制访问。Mist 登录依赖 Cookie，前后端分属不同站点时浏览器会拦截跨站 Cookie；`jiangsupanda.com` 属于正式环境，开发环境不使用。`bambook-dev-api.sylway.cloud` 的直连 A 记录不再需要。

## 手动触发（不需要用户本地电脑）

云端 coding agent 或仓库维护者打开 GitHub → Actions → `Bambook development delivery` → Run workflow，选择 `main`：

- `check`：只检查专用 SSH 通道，不上传、不启动应用。输出 `channel: ready` 才表示通道连接成功。
- `deploy`：交付当次选中的主线提交并激活。必须先通过同一提交的 `verify`；应用环境、数据库 schema 和服务单元未配置时会明确失败，不把连接成功当成应用上线。

这是人工决定何时发布、由流程执行上传；普通 push 不会自动发布。不要把私钥放进任务提示词或导出仓库 Secrets。代码必须由仓库版本生成，不上传个人工作区、密钥或运行数据。

## GitHub Actions 不可用时的控制台备用方式

使用已授权的腾讯云 OrcaTerm 管理会话，或另行授权的管理员 SSH 登录；受限的 `bambook-deploy` 密钥不能打开通用 shell/SFTP。

1. 在有仓库权限的构建环境选定已验证的完整 40 位提交号，按 workflow「Send verified release and activate」同样的步骤生成压缩包（`.nvmrc`、`server`、发布脚本与构建后的 `web/`）。包中不包含数据库、附件、`.env`、`node_modules`。
2. 用腾讯云控制台文件上传将包放到管理员可读的临时位置，校验 SHA-256。若文件管理器不支持当前免密会话，需使用已授权的 SSH/SFTP 方式，不临时开放匿名上传接口。
3. 管理员以接收账号调用同一接收程序，而不是直接覆盖运行目录。将下面占位值替换成实际完整提交号和上传包路径：

```sh
revision=REPLACE_WITH_VERIFIED_40_CHARACTER_COMMIT
bundle=/home/ubuntu/REPLACE_WITH_UPLOADED_BUNDLE.tar.gz
sudo -u bambook-deploy env SSH_ORIGINAL_COMMAND="receive $revision" \
  /usr/bin/python3 /usr/local/libexec/bambook-dev-receiver.py < "$bundle"
sudo -u bambook-deploy env SSH_ORIGINAL_COMMAND="activate $revision" \
  /usr/bin/python3 /usr/local/libexec/bambook-dev-receiver.py
```

只有第一步返回接收成功，才执行第二步激活。两条命令都不应打印环境文件或密码。服务启动前置条件与自动流程相同。

## 状态与故障判断

- DNS 存在：只代表域名解析已配置。
- `check` 成功：只代表 GitHub/SSH 交付通道可用。
- `receive` 成功：只代表准确提交的文件收到，尚未启动。
- `activate` 成功：本机健康检查通过，仍需验证外部 HTTPS、认证和前端请求。
- CI 未通过：修复代码或验证环境后重跑，不直接跳过门禁。
- 接收失败：保留原服务，核对包路径、大小、提交号及文件范围。
- 激活失败：脚本在存在旧版本时回切旧版本；不会回滚数据库。迁移必须单独具备恢复方案。
- 域名不可访问：分别排查 Cloudflare 规则、源站证书、反向代理、防火墙与应用健康，不把 DNS 成功误判为服务上线。

目前已验证：Node/npm、PostgreSQL 本机运行、专用账号外部 SSH check、非允许命令拒绝、DNS 记录。尚未验证：应用首次部署、数据库结构、服务单元、HTTPS、公网业务接口。
