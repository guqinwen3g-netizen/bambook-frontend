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

工作流：`.github/workflows/bambook-dev-ops.yml`（在 `ops-channel` 分支上生效；main 上的副本改动后要同步到 `ops-channel` 才起作用）。

1. 在 `ops-channel` 分支上更新 `ops/request.sh`，内容是要在服务器上以 `bambook-ops` 执行的 bash 脚本（需要 root 时用 `sudo`）。用 GitHub MCP `push_files` / `create_or_update_file` 提交即可，记下返回的提交 SHA。
2. 等约 30–90 秒（排队串行执行，单次最长 15 分钟）。不要固定休眠：先做别的，再按 SHA 查结果。
3. 读取 `ops-channel` 分支上的 `ops/results/<提交SHA>.md`，里面有请求 SHA、请求脚本 `request-sha256`、退出码、耗时、Actions 运行链接和脱敏后的输出。以 `results/<SHA>.md` 为准；`last-result.md` 可能已是别的请求。
   - 工作流按触发提交本身读取请求（不读分支最新），读不到或脚本为空直接失败，回执写 `exit: not run`，不会报成功。
   - GitHub 同一并发组只保留最新一个排队运行：连续快速推送时，中间的请求可能被取消、没有结果文件。没有结果且已有更新请求的结果时，重新提交。
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

## 隔离 CI 容量试跑（不注册 runner）

仅在用户授权开发服务器试跑后使用。运维请求首行可写 `# capacity-source-main: <40位 main SHA>`，通道核对它仍是最新 main 后传输受控文件；排除非本轮验证输入的历史文档、Electron 打包图标和旧地图数据，保留全部测试/规格文件、Mist 规则清单及当前构建入口。后端源码从相同 SHA 的既有开发发布目录按逐文件 SHA-256 清单复制到隔离目录，不复制环境文件、依赖或运行数据；发布源不匹配即停止。传输包及断点前缀均校验 SHA-256，不向服务器保存仓库凭据。

容量脚本为 `scripts/ops/dev-ci-capacity.py`。准备独立 `/var/tmp/bambook-ci-capacity-<SHA>` 与私有 evidence 目录，以运维账号启动 supervisor；worker 限 2 CPU、2 GiB 内存、256 MiB swap，前端测试单 worker，空环境和不可用测试数据库地址，禁止访问开发部署目录及 PostgreSQL 数据目录。按当前 verify:mist 顺序执行同等检查覆盖；仅为容量测量，在代码断言失败后继续其余阶段，不重试到通过，任一失败仍判整轮失败。

剩余内存低于 650 MiB、磁盘少于 10 GiB、swap 增长超 256 MiB、服务健康持续异常或达到超时边界即停止。结束清理本次源码、依赖、缓存和构建产物，私有测量证据不入库；按请求 SHA 读取回执。串行运维通道中排队的查询不是实时进度；先核对是否有部署/上传重叠，不把某次文件增长均速当作服务器带宽上限。没有完整实测证据，不永久改写 CI runner 配置。

## 部署

见 `Bambook development delivery` 工作流（PR #26、#33）：

- **自动**：main 推送触发的 `Mist verification` 成功后，经 `workflow_run` 部署该提交；PR 上的验证或验证失败不部署；只部署 main 最新提交，不回滚到旧提交。
- **手动**：Actions → Run workflow（branch `main`），`check` 只测通道，`deploy` 部署当前 main。

两种方式都要求该提交 `verify` 已通过，结果写成提交状态 `ci/bambook-dev-delivery`。部署后经运维通道核对 `readlink -f /srv/bambook-dev/current`、服务 active 与健康接口。

## 撤销 / 轮换

在运维通道执行：删除对应 `authorized_keys` 行（或 `sudo userdel -r bambook-ops`、`sudo rm /etc/sudoers.d/90-bambook-ops`），再在 GitHub 仓库 Settings → Secrets and variables → Actions 中更新或删除对应 secret。用户的腾讯云控制台始终可以独立登录和重置，不依赖这些钥匙。
