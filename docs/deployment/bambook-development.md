# Bambook 开发环境交付通道

适用：腾讯云 KOOGO 开发服务器，独立账号 `bambook-deploy`，交付目录 `/srv/bambook-dev`。这不是正式生产环境，也不使用旧 Mac mini 的数据库。

## 云端 Agent 怎样交付

1. 在任务分支完成代码并通过现有验证，经 PR 合入主线。
2. 在 Actions 中手动运行 `Bambook development delivery`。第一次选择 `check`，只验证连接，不发送应用。
3. 应用部署准备完成后选择 `deploy`；流程要求准确主线提交已有成功的 `verify` 检查，将该提交的后端发送到独立版本目录，再启动和核对本机健康接口。不会因普通 push 自动部署。

服务器地址和账号在 workflow 中。私钥只存为仓库 Actions secret `BAMBOOK_DEV_SSH_KEY`，受信任主机公钥存为 `BAMBOOK_DEV_KNOWN_HOSTS`。不在聊天、代码或日志中输出私钥。

SSH key 强制经过接收程序，只接受 `check`、`receive <40位提交>`、`activate <40位提交>`，不能当通用终端或 SFTP 使用。接收程序拒绝路径越界、符号链接、设备文件、重复路径和超过限制的压缩包；相同提交重复传送必须字节一致。项目 agent 无需在用户本机。

## 应用启动前置条件

由应用负责人配置开发数据库及结构、`/etc/bambook-dev/backend.env`、固定的 `bambook-dev.service`。变量至少包括 `DATABASE_URL`、足够强的 `JWT_SECRET`、`MIST_HOST=127.0.0.1`、`MIST_PORT=8082`、`MIST_LOCAL_WORKSPACE=0`。禁止把本地全权限模拟身份暴露到公网。

服务应使用独立的 `bambook-deploy` 身份，工作目录为 `/srv/bambook-dev/current/server`，由 Node 执行本地 tsx CLI 和 `src/mist/standalone.ts`。仅授予此账号重启、停止该开发服务的权限，不授予通用 sudo。

交付脚本安装锁定依赖、生成 Prisma client、检查 Mist 类型、切换版本并验证健康接口；失败时恢复旧版本。它不会自动执行 schema push、重置数据库或迁移真实数据。数据库 schema 的初始化与迁移由应用负责人单独确认并执行。

开发后端域名为 `bambook-dev-api.sylway.cloud`，DNS 已指向服务器。HTTPS / 反向代理、认证、CORS 及最终公网连通需要单独验证；SSH 交付成功不代表 API 已上线。开发前端计划使用 `bambook-dev.jiangsupanda.com`。
