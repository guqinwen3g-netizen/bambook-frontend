# Bambook · Mist Atelier 当前完整工程快照

2026-10-13 发布快照。前端唯一入口是 `dev-ui-preview/mist-atelier/app/main.tsx` → `ReferenceApp.tsx`，Web/Electron共用；包含当前后端、服务、schema/迁移、测试、开发脚本及业务设计文档。旧 App/Manager 界面、BDS/Bencho候选、旧前端副本和历史构建归档不作为此版本交付。

## 本地开发

推荐 Node.js 22 LTS。

```sh
nvm use # 或使用 Node.js 22
npm ci
npm ci --prefix server
(cd server && npm exec -- prisma generate)
npm run dev:mist
```

主应用 `http://127.0.0.1:3001/`；本地文件工作空间API在8082，无需旧PostgreSQL账号，首次使用会创建本机空间与会话密钥。不要把本机运行数据或密钥提交到GitHub。

参考源码预览：`npm run mist:ref` → `http://127.0.0.1:3131/`，与主应用共用Mist源码。

## 阅读顺序

- `docs/mist-atelier/README.md`：视觉、组件与开发入口。
- `docs/mist-atelier/05-migration-playbook.md`：当前实施、已验证分支与未验证范围。
- `docs/design/global/2026-10-06/08-2026-10-06-对话设计决策总账.md`：有效业务裁决；历史视觉说明以Mist最新裁决覆盖。
- `docs/README.md`：有效工程/业务文档导航。

本地模式用于联调及评审；不代表真实银行、物流、外部供应商集成、PostgreSQL并发和全部业务分支已验收。当前AI及部分专业能力仍有明确边界，详见推进手册。

完整生产API源码也在`server/`，需按`server/.env.example`自行配置；本快照不含任何真实环境密钥、旧数据转储、个人Agent记忆、node_modules或构建产物。

## 本快照验证

在隔离发布目录验证：Mist前端36文件549项、Mist后端27文件357项通过；主构建通过；Mist规则检查84文件0错误/0警告；独立本地API health返回`mode=local, storage=local-file`。`npm test`用于当前Mist前端，`npm run test:mist:server`用于当前Mist后端。安装依赖验证使用本机既有依赖，未声称所有平台的全新npm ci已实测。视觉/真实业务验收及其范围见推进手册和最新Mist证据，不以构建或单元测试代替视觉认可。

## 当前 Mist 的可复现检查

```sh
npm run verify:mist
```

包含当前 Mist UI/服务类型检查、前后端测试、构建及 Mist 规范检查。配套 `.github/workflows/mist.yml` 已随本轮补丁提供，但因当前连接推送含工作流的批次返回403，暂不随远端功能提交写入；待工作流写权限核对后补交。该配置用于 PR/main 检查，不部署；现阶段不能声明远端 CI 已启用。类型检查只覆盖当前 Mist 入口和服务依赖图，不代表历史目录或整个生产 API 无类型问题。

本轮在 Linux / Node.js 22 完成前后端全新 `npm ci`；Node.js 24 安装服务端时遇到现有 `better-sqlite3` 原生构建兼容问题，暂不声明支持。现有依赖审计告警尚未消除，不能据此宣称生产发布就绪。最新功能与视觉验收边界见推进手册。
