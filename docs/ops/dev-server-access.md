# 开发服务器访问（所有 agent 通用）

适用范围：腾讯云开发服务器 `bambook-dev`（`124.222.56.61`，`https://bambook-dev.sylway.cloud`，库 `panda_hub_dev`）。**不适用**于 Mac mini 与 `jiangsupanda.com` 正式环境，也不涉及真实资金——这些仍须用户单独授权。

## 原则

- 钥匙只存在 GitHub 仓库 Actions secrets 中，agent 不持有、不读取、不转发私钥；不需要用户为每个新 agent 重新授权或登录。
- 任何 agent 只要能向本仓库推送（GitHub 连接的 contents 写权限），就能通过下面的运维通道在开发服务器上执行命令。
- 不在仓库、日志、PR 或聊天中写入密码、私钥、令牌。通道会对输出做基础脱敏，但请不要主动打印密钥文件。

## 仓库 secrets（一次性配置，已由用户完成）

| Secret | 用途 | 服务器账号 |
| --- | --- | --- |
| `BAMBOOK_DEV_OPS_SSH_KEY` | 运维通道，通用 bash（可 `sudo`） | `bambook-ops` |
| `BAMBOOK_DEV_SSH_KEY` | 部署流程 `Bambook development delivery`（受限：只接受 check / receive / activate） | `bambook-deploy` |
| `BAMBOOK_DEV_KNOWN_HOSTS` | 固定服务器主机公钥，防中间人 | — |

公钥指纹（用于核对 / 撤销，非机密）：

- ops：`SHA256:uMB1iBUjfnch7WsiC56QncJFo1QuHcc3lItr64UFR10`（`/home/bambook-ops/.ssh/authorized_keys`）
- deploy：`SHA256:vbUfOu1LeOY4INq8vtZ1A2Ac9sEfgAiC0EgfWDXprdg`（`/home/bambook-deploy/.ssh/authorized_keys`，forced command `/usr/local/libexec/bambook-dev-receiver.py`）

## 运维通道用法

工作流：`.github/workflows/bambook-dev-ops.yml`（在 `ops-channel` 分支上生效）。

1. 在 `ops-channel` 分支上更新 `ops/request.sh`，内容是要在服务器上以 `bambook-ops` 执行的 bash 脚本（需要 root 时用 `sudo`）。用 GitHub MCP `push_files` / `create_or_update_file` 提交即可，记下返回的提交 SHA。
2. 等约 30–90 秒（排队串行执行，单次最长 15 分钟）。
3. 读取 `ops-channel` 分支上的 `ops/results/<提交SHA>.md`（或 `ops/last-result.md`），里面有退出码、耗时、Actions 运行链接和脱敏后的输出。文件不存在说明还在运行。
4. 只接受仓库所有者账号推送触发；分支上不放其他代码，不要合入 main。

常用片段：

```bash
sudo systemctl status bambook-dev bambook-dev-mist --no-pager | head -30
sudo journalctl -u bambook-dev-mist -n 200 --no-pager   # Mist 工作空间 API
sudo journalctl -u bambook-dev -n 200 --no-pager        # 主 API
ls -la /srv/bambook-dev/current /srv/bambook-dev/releases
curl -fsS http://127.0.0.1:8081/api/health   # 本机端口：8080 nginx、8081/8082 node，以实际为准
sudo -u postgres psql panda_hub_dev -c 'select count(*) from ...'
sudo cat /srv/bambook-dev/shared/test-accounts.txt   # 7 个测试账号（仅开发环境）
```

服务：`bambook-dev`（主 API）、`bambook-dev-mist`（Mist 工作空间 API）；前面是 nginx。以 `systemctl list-units 'bambook*'` 与 `ss -ltnp` 为准。

## 部署

见 `Bambook development delivery` 工作流（PR #26）：在 Actions 手动运行，`check` 只测通道，`deploy` 要求该提交 `verify` 已通过。

## 撤销 / 轮换

在运维通道执行：删除对应 `authorized_keys` 行（或 `sudo userdel -r bambook-ops`、`sudo rm /etc/sudoers.d/90-bambook-ops`），再在 GitHub 仓库 Settings → Secrets and variables → Actions 中更新或删除对应 secret。用户的腾讯云控制台始终可以独立登录和重置，不依赖这些钥匙。
