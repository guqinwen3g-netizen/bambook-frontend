# Deploy SOP — Bambook 后端部署

> ⚠️ **本文件仅作"路标"。真正的部署 runbook 是
> [`server/docs/ops-panel-runbook.md`](../server/docs/ops-panel-runbook.md)。**
>
> 本项目已经有完整的 OPS Panel 体系（独立子项目 `server/ops-panel/`、独立子域
> `https://ops.jiangsupanda.com/ops`、白名单 `ops-*.sh` 脚本、3 个 LaunchAgent
> 包含每分钟 GitHub 轮询自动部署 + 5 分钟公网探针），**所有部署/重启/健康检查
> 都应通过 OPS Panel 触发**，不应再回退到 SSH 手动 rsync + launchctl。

---

## 默认部署路径（首选）

1. 把代码 push 到 GitHub `main`
2. 打开 <https://ops.jiangsupanda.com/ops>
3. 输入 `BAMBOOK_OPS_ADMIN_TOKEN`（保存在 Mac mini 的 `~/bambook-main-api/.env.local`）
4. 点击 **「拉取 GitHub 并部署主数据 API」**（`ops-deploy-main-api.sh`）
5. 等待面板上的实时日志结束 → 状态条变绿
6. 公网探针 LaunchAgent（`com.bambook.public-probe`）会在 5 分钟内自动写入
   `/tmp/bambook-public-probe.log`，无需手跑

> 想免点击：自动更新 Agent `com.bambook.ops-panel-auto` 会**每分钟**轮询
> GitHub `main` 并触发 panel 自部署，开发者只要 push 即可。

---

## 何时需要 SSH 手动操作（fallback only）

仅在以下情况：

- OPS Panel 服务本身挂了（`launchctl list | grep com.bambook.ops-panel` 异常）
- Cloudflare Tunnel 完全断开（连 ops 子域都打不开）
- 需要执行尚未加入白名单的临时操作

具体步骤参见 `server/docs/ops-panel-runbook.md` 的「One-Time Install / Recovery」节。

---

## 开发机本地辅助：Manifest 工具集对账

`server/scripts/post-deploy-verify.ts` 是**开发机本地工具**，用于在 push 之前
本地验证 Agent manifest seed 与远程实际暴露的工具集是否一致：

```bash
cd server
BAMBOOK_API_KEY=xxx npx tsx scripts/post-deploy-verify.ts
```

它会打印：

- 远程 `/api/agent/mcp/manifest` 工具数 vs 本地 `MANIFEST_SEEDS` 工具数
- 双向 diff：`missing on remote (n): [...]` + `extra on remote (n): [...]`

> ⚠️ 这是**辅助校验**，不是部署后必跑步骤。部署后真正必看的是 OPS Panel 的
> 健康检查面板和公网探针日志。

后续计划：把 manifest diff 的能力作为一个 `ops-manifest-diff.sh` 脚本加入
OPS Panel 白名单，让它和其他 ops 操作一样可以一键触发，并入库到操作日志。

---

## 历史教训（供后续 agent / 开发者参考）

- **2026-06-15**：因为没有先调研 `server/ops-panel/` 已有能力，在远程部署任务里
  直接走了 SSH + rsync + launchctl 的原始路径，绕过了已经为非 IT 操作员设计好
  的 ops-panel 一键部署。这是 agent 的判断失误，不是 OPS 能力不足。**今后所有
  涉及"远程 / 部署 / 重启 / 健康检查"的任务，第一个动作都应是打开 ops-panel
  看现成按钮，找不到再考虑别的。**
